import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { studioSqliteBusyTimeoutMs } from "./studio-sqlite-busy.js";
import {
  VERIFIED_FILE_CACHE_LIMIT,
  deleteDanglingVerifiedFileLookup,
  evictVerifiedFileCacheForProject,
  getVerifiedFile,
  getVerifiedFileLookup,
  rememberVerifiedFile,
  touchVerifiedFile,
  verifiedFileLeaveGeneration,
  verifiedFileCacheBucketCount,
  verifiedFileCacheSize,
} from "./studio-verified-file-cache.js";

const DATABASE_RELATIVE_PATH = ".aicanvas/material-studio.sqlite";
const OBJECTS_RELATIVE_ROOT = ".aicanvas/objects/sha256";
const THUMBNAIL_RELATIVE_ROOT = ".aicanvas/derived/thumb";
const PROXY_RELATIVE_ROOT = ".aicanvas/derived/proxy";
const WAVEFORM_RELATIVE_ROOT = ".aicanvas/derived/waveform";
const THUMBNAIL_RECIPE = "material-studio-thumb:v1:autorotate:inside-512:no-enlarge:webp-q82";
const DERIVATIVE_RECIPES = {
  video_poster: "studio-video-poster:v1:first-frame:max-1280x720:webp-q82",
  video_proxy: "studio-video-proxy:v1:max-1280x720:h264-crf28-aac128k-faststart",
  audio_waveform: "studio-audio-waveform:v1:1200x160:mono:webp-q82",
} as const;
const SCHEMA_VERSION = "1";
const BUSY_TIMEOUT_MS = 5_000;
const MAX_RANGE_HEADER_LENGTH = 256;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export type StudioMediaProtocolTarget = "media" | "thumbnail" | "derivative";
export type StudioMediaProtocolStatus = 200 | 206 | 416;

interface StudioMediaRangeInput {
  /** 原始 HTTP Range 头；仅接受单个 bytes 范围。 */
  rangeHeader?: string | null;
  /** rangeHeader 的短别名。两者同时提供时必须完全相同。 */
  range?: string | null;
}

export interface StudioMediaByShaRequest extends StudioMediaRangeInput {
  mediaSha256: string;
  thumbnailRecipeKey?: never;
  derivativeRecipeKey?: never;
}

export interface StudioThumbnailByRecipeRequest extends StudioMediaRangeInput {
  thumbnailRecipeKey: string;
  mediaSha256?: never;
  derivativeRecipeKey?: never;
}

export interface StudioDerivativeByRecipeRequest extends StudioMediaRangeInput {
  derivativeRecipeKey: string;
  mediaSha256?: never;
  thumbnailRecipeKey?: never;
}

/**
 * 协议领域层只接收内容标识，不接收文件路径。
 * projectRoot 可作为 resolveStudioMediaRequest 的第一个参数，也可放在单参数请求中。
 */
export type StudioMediaProtocolRequest = StudioMediaByShaRequest | StudioThumbnailByRecipeRequest | StudioDerivativeByRecipeRequest;
export type StudioMediaProtocolRequestWithRoot = StudioMediaProtocolRequest & { projectRoot: string };

export type StudioMediaProtocolErrorCode =
  | "INVALID_REQUEST"
  | "PROJECT_NOT_FOUND"
  | "STUDIO_DATABASE_NOT_FOUND"
  | "MEDIA_NOT_FOUND"
  | "DERIVATIVE_NOT_READY"
  | "INTEGRITY_VIOLATION"
  | "RANGE_NOT_SATISFIABLE";

export class StudioMediaProtocolError extends Error {
  readonly code: StudioMediaProtocolErrorCode;
  readonly httpStatus: 400 | 404 | 409 | 416;

  constructor(code: StudioMediaProtocolErrorCode, message: string, httpStatus: 400 | 404 | 409 | 416) {
    super(message);
    this.name = "StudioMediaProtocolError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type StudioMediaResponseHeaders = Readonly<Record<string, string>>;

interface StudioMediaResolutionBase {
  target: StudioMediaProtocolTarget;
  key: string;
  mediaSha256: string;
  totalSize: number;
  mimeType: string;
  etag: string;
  headers: StudioMediaResponseHeaders;
}

export interface StudioMediaResolvedRange extends StudioMediaResolutionBase {
  status: 200 | 206;
  /** 已完成 CAS/派生记录校验的绝对路径；只能交给本模块的 open helper。 */
  filePath: string;
  /** 闭区间起点。空文件固定为 0。 */
  start: number;
  /** 闭区间终点。空文件固定为 -1。 */
  end: number;
  /** 本次响应体字节数。 */
  length: number;
}

export interface StudioMediaUnsatisfiedRange extends StudioMediaResolutionBase {
  status: 416;
  length: 0;
}

export type StudioMediaResolution = StudioMediaResolvedRange | StudioMediaUnsatisfiedRange;

interface MediaRow {
  sha256: unknown;
  kind: unknown;
  size_bytes: unknown;
  mime_type: unknown;
  source_basename: unknown;
  object_relpath: unknown;
  derivative_status: unknown;
  thumbnail_recipe_key: unknown;
  thumbnail_relpath: unknown;
  thumbnail_width: unknown;
  thumbnail_height: unknown;
}

interface DerivativeRow {
  recipe_key: unknown;
  media_sha256: unknown;
  kind: unknown;
  status: unknown;
  recipe: unknown;
  output_sha256: unknown;
  size_bytes: unknown;
  mime_type: unknown;
  relative_path: unknown;
  error_code: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface InternalResolution {
  canonicalRoot: string;
  identity: FileIdentity;
}

interface InspectedFile {
  identity: FileIdentity;
  sha256: string;
  prefix: Buffer;
}

type VerificationCacheTarget = "media" | "thumbnail" | "derivative";

interface VerificationCacheEntry {
  bindingKey: string;
  lookupKey: string;
  target: VerificationCacheTarget;
  canonicalRoot: string;
  canonicalPath: string;
  recordIdentity: string;
  expectedSha256: string;
  expectedSize: number;
  inspected: InspectedFile;
}

interface InspectCachedInput {
  target: VerificationCacheTarget;
  canonicalRoot: string;
  filePath: string;
  label: string;
  recordIdentity: string;
  expectedSha256?: string;
  expectedSize?: number;
}

interface NormalizedRequest {
  projectRoot: string;
  target: StudioMediaProtocolTarget;
  key: string;
  rangeHeader: string | undefined;
}

const trustedResolutions = new WeakMap<object, InternalResolution>();
const inFlightFileInspections = new Map<string, Promise<InspectedFile>>();
let lastServedCanonicalRoot: string | null = null;

function dropInFlightFileInspectionsForRoots(roots: readonly string[]): number {
  const needles = [...new Set(roots.filter((root) => typeof root === "string" && root.length > 0).map((root) => JSON.stringify(root)))];
  if (needles.length === 0) return 0;
  let removed = 0;
  for (const key of inFlightFileInspections.keys()) {
    if (needles.some((needle) => key.includes(needle))) {
      inFlightFileInspections.delete(key);
      removed += 1;
    }
  }
  return removed;
}
const verificationCacheMetrics = {
  cacheHits: { media: 0, thumbnail: 0, derivative: 0 },
  cacheMisses: { media: 0, thumbnail: 0, derivative: 0 },
  fullHashVerifications: { media: 0, thumbnail: 0, derivative: 0 },
  evictions: 0,
};

export interface StudioMediaVerificationCacheDiagnostics {
  limit: number;
  size: number;
  buckets: number;
  inFlight: number;
  cacheHits: Readonly<Record<StudioMediaProtocolTarget, number>>;
  cacheMisses: Readonly<Record<StudioMediaProtocolTarget, number>>;
  fullHashVerifications: Readonly<Record<StudioMediaProtocolTarget, number>>;
  evictions: number;
}

/**
 * 只暴露无路径、无素材身份的聚合指标，供性能回归与运行诊断使用。
 */
export function getStudioMediaVerificationCacheDiagnostics(): StudioMediaVerificationCacheDiagnostics {
  return Object.freeze({
    limit: VERIFIED_FILE_CACHE_LIMIT,
    size: verifiedFileCacheSize(),
    buckets: verifiedFileCacheBucketCount(),
    inFlight: inFlightFileInspections.size,
    cacheHits: Object.freeze({ ...verificationCacheMetrics.cacheHits }),
    cacheMisses: Object.freeze({ ...verificationCacheMetrics.cacheMisses }),
    fullHashVerifications: Object.freeze({ ...verificationCacheMetrics.fullHashVerifications }),
    evictions: verificationCacheMetrics.evictions,
  });
}

const EXPECTED_MEDIA_COLUMNS = [
  "sha256",
  "kind",
  "size_bytes",
  "mime_type",
  "source_basename",
  "object_relpath",
  "derivative_status",
  "thumbnail_recipe_key",
  "thumbnail_relpath",
  "thumbnail_width",
  "thumbnail_height",
  "created_at",
] as const;

const EXPECTED_DERIVATIVE_COLUMNS = [
  "recipe_key",
  "media_sha256",
  "kind",
  "status",
  "recipe",
  "output_sha256",
  "size_bytes",
  "mime_type",
  "relative_path",
  "error_code",
  "created_at",
  "updated_at",
] as const;

const MEDIA_TYPES: Record<string, { kind: "image" | "video" | "audio"; mimeType: string }> = {
  ".png": { kind: "image", mimeType: "image/png" },
  ".jpg": { kind: "image", mimeType: "image/jpeg" },
  ".jpeg": { kind: "image", mimeType: "image/jpeg" },
  ".webp": { kind: "image", mimeType: "image/webp" },
  ".avif": { kind: "image", mimeType: "image/avif" },
  ".tif": { kind: "image", mimeType: "image/tiff" },
  ".tiff": { kind: "image", mimeType: "image/tiff" },
  ".gif": { kind: "image", mimeType: "image/gif" },
  ".mp4": { kind: "video", mimeType: "video/mp4" },
  ".mov": { kind: "video", mimeType: "video/quicktime" },
  ".mkv": { kind: "video", mimeType: "video/x-matroska" },
  ".webm": { kind: "video", mimeType: "video/webm" },
  ".m4v": { kind: "video", mimeType: "video/x-m4v" },
  ".mp3": { kind: "audio", mimeType: "audio/mpeg" },
  ".wav": { kind: "audio", mimeType: "audio/wav" },
  ".m4a": { kind: "audio", mimeType: "audio/mp4" },
  ".aac": { kind: "audio", mimeType: "audio/aac" },
  ".flac": { kind: "audio", mimeType: "audio/flac" },
  ".ogg": { kind: "audio", mimeType: "audio/ogg" },
};

function invalidRequest(message: string): StudioMediaProtocolError {
  return new StudioMediaProtocolError("INVALID_REQUEST", message, 400);
}

function integrityViolation(message: string): StudioMediaProtocolError {
  return new StudioMediaProtocolError("INTEGRITY_VIOLATION", message, 409);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function normalizeFullKey(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalidRequest(`${label} 必须是完整的 64 位 SHA-256。`);
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw invalidRequest(`${label} 必须是完整的 64 位 SHA-256。`);
  return normalized;
}

function assertPlainRequest(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRequest("媒体请求必须是对象。");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidRequest("媒体请求对象原型无效。");
}

function normalizeRangeHeader(request: Record<string, unknown>): string | undefined {
  const first = request.rangeHeader;
  const second = request.range;
  for (const [label, value] of [["rangeHeader", first], ["range", second]] as const) {
    if (value !== undefined && value !== null && typeof value !== "string") throw invalidRequest(`${label} 必须是字符串。`);
  }
  if (typeof first === "string" && typeof second === "string" && first !== second) {
    throw invalidRequest("rangeHeader 与 range 不能互相冲突。");
  }
  const selected = typeof first === "string" ? first : typeof second === "string" ? second : undefined;
  if (selected !== undefined && selected.length > MAX_RANGE_HEADER_LENGTH) throw invalidRequest("Range 头过长。");
  return selected;
}

function normalizeRequestArguments(
  projectRootOrRequest: string | StudioMediaProtocolRequestWithRoot,
  maybeRequest?: StudioMediaProtocolRequest,
): NormalizedRequest {
  let projectRoot: unknown;
  let request: unknown;
  let allowedKeys: ReadonlySet<string>;
  if (typeof projectRootOrRequest === "string") {
    projectRoot = projectRootOrRequest;
    request = maybeRequest;
    allowedKeys = new Set(["mediaSha256", "thumbnailRecipeKey", "derivativeRecipeKey", "rangeHeader", "range"]);
  } else {
    request = projectRootOrRequest;
    assertPlainRequest(request);
    projectRoot = request.projectRoot;
    allowedKeys = new Set(["projectRoot", "mediaSha256", "thumbnailRecipeKey", "derivativeRecipeKey", "rangeHeader", "range"]);
  }
  if (typeof projectRoot !== "string" || !projectRoot.trim()) throw invalidRequest("projectRoot 不能为空。");
  assertPlainRequest(request);
  const unexpected = Object.keys(request).find((key) => !allowedKeys.has(key));
  if (unexpected) throw invalidRequest(`媒体请求不接受字段：${unexpected}。`);
  const hasMedia = request.mediaSha256 !== undefined;
  const hasThumbnail = request.thumbnailRecipeKey !== undefined;
  const hasDerivative = request.derivativeRecipeKey !== undefined;
  if (Number(hasMedia) + Number(hasThumbnail) + Number(hasDerivative) !== 1) {
    throw invalidRequest("必须且只能提供 mediaSha256、thumbnailRecipeKey 或 derivativeRecipeKey 之一。");
  }
  const target: StudioMediaProtocolTarget = hasMedia ? "media" : hasThumbnail ? "thumbnail" : "derivative";
  return {
    projectRoot,
    target,
    key: normalizeFullKey(
      hasMedia ? request.mediaSha256 : hasThumbnail ? request.thumbnailRecipeKey : request.derivativeRecipeKey,
      hasMedia ? "mediaSha256" : hasThumbnail ? "thumbnailRecipeKey" : "derivativeRecipeKey",
    ),
    rangeHeader: normalizeRangeHeader(request),
  };
}

function relativePathInside(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw integrityViolation("素材路径不在工程根目录内。");
  }
  return relative;
}

function identity(stats: BigIntStats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function identitiesEqual(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertRegular(stats: BigIntStats, label: string): void {
  if (stats.isSymbolicLink()) throw integrityViolation(`${label} 不能是符号链接。`);
  if (!stats.isFile()) throw integrityViolation(`${label} 必须是普通文件。`);
}

let afterManagedPathFinalLstatHookForTests:
  | ((input: { candidate: string; label: string }) => boolean | void | Promise<boolean | void>)
  | undefined;

/**
 * 仅用于覆盖 final lstat 与 realpath 之间的 TOCTOU 窗口；生产运行不得安装。
 */
export function __setAfterManagedPathFinalLstatHookForTests(
  hook: typeof afterManagedPathFinalLstatHookForTests,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("managed path TOCTOU hook 仅允许测试环境。");
  }
  afterManagedPathFinalLstatHookForTests = hook;
}

async function canonicalProjectRoot(projectRoot: string): Promise<string> {
  const requested = path.resolve(projectRoot);
  let requestedStats: BigIntStats;
  try {
    requestedStats = await lstat(requested, { bigint: true });
  } catch (error) {
    if (isMissing(error)) throw new StudioMediaProtocolError("PROJECT_NOT_FOUND", "工程根目录不存在。", 404);
    throw integrityViolation("无法安全读取工程根目录。");
  }
  if (requestedStats.isSymbolicLink()) throw integrityViolation("projectRoot 不能是符号链接。");
  if (!requestedStats.isDirectory()) throw invalidRequest("projectRoot 必须是目录。");
  try {
    const canonical = await realpath(requested);
    const canonicalStats = await lstat(canonical, { bigint: true });
    if (canonicalStats.isSymbolicLink() || !canonicalStats.isDirectory()) throw integrityViolation("工程根目录解析结果无效。");
    return canonical;
  } catch (error) {
    if (error instanceof StudioMediaProtocolError) throw error;
    throw integrityViolation("无法解析工程根目录真实路径。");
  }
}

async function assertManagedPath(
  canonicalRoot: string,
  candidate: string,
  label: string,
  expectedType: "file" | "directory" = "file",
  identityPolicy: "stable" | "mutable" = "stable",
): Promise<BigIntStats> {
  const relative = relativePathInside(canonicalRoot, candidate);
  const parts = relative.split(path.sep);
  let current = canonicalRoot;
  let finalStats: BigIntStats | undefined;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    let stats: BigIntStats;
    try {
      stats = await lstat(current, { bigint: true });
    } catch (error) {
      if (isMissing(error)) throw integrityViolation(`${label} 缺失。`);
      throw integrityViolation(`无法安全读取${label}。`);
    }
    if (stats.isSymbolicLink()) throw integrityViolation(`${label} 路径包含符号链接。`);
    const isLast = index === parts.length - 1;
    if (!isLast && !stats.isDirectory()) throw integrityViolation(`${label} 的父路径不是目录。`);
    if (isLast) finalStats = stats;
  }
  if (!finalStats) throw integrityViolation(`${label} 路径无效。`);
  if (expectedType === "file") assertRegular(finalStats, label);
  else if (!finalStats.isDirectory()) throw integrityViolation(`${label} 必须是目录。`);
  const hook = afterManagedPathFinalLstatHookForTests;
  if (hook && await hook({ candidate, label })) afterManagedPathFinalLstatHookForTests = undefined;
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if (isMissing(error)) {
      // realpath 的 ENOENT 既可能是 SQLite sidecar 合法消失，也可能是 final
      // lstat 后被替换为悬空 symlink。必须复核候选路径：只有复核也缺失才允许
      // companion 的瞬态分支吞掉；仍存在的 link/目录一律保持完整性失败。
      try {
        const afterMissing = await lstat(candidate, { bigint: true });
        if (afterMissing.isSymbolicLink()) throw integrityViolation(`${label} 不能是符号链接。`);
        if (expectedType === "file") assertRegular(afterMissing, label);
        else if (!afterMissing.isDirectory()) throw integrityViolation(`${label} 必须是目录。`);
      } catch (recheckError) {
        if (recheckError instanceof StudioMediaProtocolError) throw recheckError;
        if (isMissing(recheckError)) throw integrityViolation(`${label} 缺失。`);
        throw integrityViolation(`无法安全复核${label}。`);
      }
      throw integrityViolation(`无法解析${label}真实路径。`);
    }
    throw integrityViolation(`无法解析${label}真实路径。`);
  }
  relativePathInside(canonicalRoot, resolved);
  if (resolved !== candidate) throw integrityViolation(`${label}真实路径与规范路径不一致。`);
  let resolvedStats: BigIntStats;
  try {
    resolvedStats = await lstat(candidate, { bigint: true });
  } catch (error) {
    if (isMissing(error)) throw integrityViolation(`${label} 缺失。`);
    throw integrityViolation(`无法安全复核${label}。`);
  }
  if (expectedType === "file") assertRegular(resolvedStats, label);
  else if (!resolvedStats.isDirectory()) throw integrityViolation(`${label} 必须是目录。`);
  // SQLite 的 WAL/SHM/journal 允许在数据库连接存续期间正常追加或 checkpoint。
  // 这些 optional sidecar 仍必须每次通过规范路径、realpath、非链接和普通文件校验，
  // 但不能把内容/mtime 的自然变化误报为 TOCTOU 替换。主 DB、CAS 与媒体保持 stable。
  if (identityPolicy === "stable" && !identitiesEqual(identity(finalStats), identity(resolvedStats))) {
    throw integrityViolation(`${label} 在安全解析期间发生变化。`);
  }
  return finalStats;
}

async function assertDatabaseFiles(canonicalRoot: string): Promise<string> {
  const databasePath = path.join(canonicalRoot, DATABASE_RELATIVE_PATH);
  try {
    await assertManagedPath(canonicalRoot, databasePath, "素材库数据库");
  } catch (error) {
    if (error instanceof StudioMediaProtocolError && error.code === "INTEGRITY_VIOLATION" && error.message.includes("缺失")) {
      throw new StudioMediaProtocolError("STUDIO_DATABASE_NOT_FOUND", "素材库数据库不存在。", 404);
    }
    throw error;
  }
  for (const suffix of ["-wal", "-shm", "-journal"] as const) {
    const companion = `${databasePath}${suffix}`;
    try {
      await assertManagedPath(canonicalRoot, companion, "素材库伴随文件", "file", "mutable");
    } catch (error) {
      if (isMissing(error)) continue;
      // WAL/SHM 由 SQLite 在最后一个连接关闭时自动移除。并发缩略图读取中，文件可能在
      // 安全 lstat 链的任意一步消失；把“已确认缺失”视作合法瞬态，但仍拒绝符号链接、
      // 非普通文件、越界和其他完整性错误。
      if (error instanceof StudioMediaProtocolError
        && error.code === "INTEGRITY_VIOLATION"
        && error.message === "素材库伴随文件 缺失。") continue;
      throw integrityViolation("无法安全读取素材库伴随文件。");
    }
  }
  return databasePath;
}

function openProtocolDatabase(databasePath: string): DatabaseSync {
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(BUSY_TIMEOUT_MS);
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: busyTimeoutMs });
  try {
    database.exec(`PRAGMA query_only=ON; PRAGMA busy_timeout=${busyTimeoutMs};`);
    const version = database.prepare("SELECT value FROM studio_meta WHERE key = 'schema_version'").get() as { value?: unknown } | undefined;
    if (version?.value !== SCHEMA_VERSION) throw integrityViolation("素材库 schema_version 缺失或不受支持。");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function withProtocolDatabase<T>(databasePath: string, read: (database: DatabaseSync) => T): T {
  let database: DatabaseSync | undefined;
  try {
    database = openProtocolDatabase(databasePath);
    return read(database);
  } catch (error) {
    if (error instanceof StudioMediaProtocolError) throw error;
    throw integrityViolation("素材库不可读或查询失败。");
  } finally {
    database?.close();
  }
}

function assertMediaTableSchema(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(studio_media)").all() as Array<{ name?: unknown }>;
  if (columns.length !== EXPECTED_MEDIA_COLUMNS.length
    || columns.some((column, index) => column.name !== EXPECTED_MEDIA_COLUMNS[index])) {
    throw integrityViolation("素材库 studio_media schema 已漂移。");
  }
}

function assertDerivativeTableSchema(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(studio_media_derivatives)").all() as Array<{ name?: unknown }>;
  if (columns.length !== EXPECTED_DERIVATIVE_COLUMNS.length
    || columns.some((column, index) => column.name !== EXPECTED_DERIVATIVE_COLUMNS[index])) {
    throw integrityViolation("素材派生索引 schema 已漂移。");
  }
}

function queryMediaRow(database: DatabaseSync, target: "media" | "thumbnail", key: string): MediaRow {
  assertMediaTableSchema(database);
  const sql = target === "media"
    ? "SELECT sha256, kind, size_bytes, mime_type, source_basename, object_relpath, derivative_status, thumbnail_recipe_key, thumbnail_relpath, thumbnail_width, thumbnail_height FROM studio_media WHERE sha256 = ? LIMIT 2"
    : "SELECT sha256, kind, size_bytes, mime_type, source_basename, object_relpath, derivative_status, thumbnail_recipe_key, thumbnail_relpath, thumbnail_width, thumbnail_height FROM studio_media WHERE thumbnail_recipe_key = ? LIMIT 2";
  const rows = database.prepare(sql).all(key) as unknown as MediaRow[];
  if (rows.length === 0) throw new StudioMediaProtocolError("MEDIA_NOT_FOUND", "素材标识不存在。", 404);
  if (rows.length !== 1) throw integrityViolation("素材标识对应多条数据库记录。");
  return rows[0]!;
}

function queryDerivativeRow(database: DatabaseSync, recipeKey: string): DerivativeRow {
  assertDerivativeTableSchema(database);
  const rows = database.prepare("SELECT * FROM studio_media_derivatives WHERE recipe_key = ? LIMIT 2").all(recipeKey) as unknown as DerivativeRow[];
  if (rows.length === 0) throw new StudioMediaProtocolError("MEDIA_NOT_FOUND", "派生 recipe key 不存在。", 404);
  if (rows.length !== 1) throw integrityViolation("派生 recipe key 对应多条记录。");
  return rows[0]!;
}

function readMediaRow(databasePath: string, target: "media" | "thumbnail", key: string): MediaRow {
  return withProtocolDatabase(databasePath, (database) => queryMediaRow(database, target, key));
}

function readDerivativeAndSourceRows(databasePath: string, recipeKey: string): {
  derivative: ReturnType<typeof validateDerivativeRow>;
  source: ReturnType<typeof validateMediaRow>;
} {
  return withProtocolDatabase(databasePath, (database) => {
    const derivative = validateDerivativeRow(queryDerivativeRow(database, recipeKey));
    const source = validateMediaRow(queryMediaRow(database, "media", derivative.mediaSha256));
    return { derivative, source };
  });
}

function expectedMimeType(kind: "image" | "video" | "audio", sourceBasename: string): string {
  const known = MEDIA_TYPES[path.extname(sourceBasename).toLowerCase()];
  return known?.kind === kind ? known.mimeType : `${kind}/octet-stream`;
}

function thumbnailRecipeKey(mediaSha256: string): string {
  return createHash("sha256").update(`${THUMBNAIL_RECIPE}\0${mediaSha256}`, "utf8").digest("hex");
}

function derivativeRecipeKey(recipe: string, mediaSha256: string): string {
  return createHash("sha256").update(`${recipe}\0${mediaSha256}`, "utf8").digest("hex");
}

function validateDerivativeRow(row: DerivativeRow): {
  recipeKey: string;
  mediaSha256: string;
  kind: keyof typeof DERIVATIVE_RECIPES;
  outputSha256: string;
  sizeBytes: number;
  mimeType: "image/webp" | "video/mp4";
  relativePath: string;
} {
  if (typeof row.recipe_key !== "string" || !/^[a-f0-9]{64}$/u.test(row.recipe_key)
    || typeof row.media_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.media_sha256)
    || (row.kind !== "video_poster" && row.kind !== "video_proxy" && row.kind !== "audio_waveform")
    || typeof row.recipe !== "string") {
    throw integrityViolation("派生记录的身份或配方无效。");
  }
  const kind = row.kind;
  const recipe = DERIVATIVE_RECIPES[kind];
  const key = derivativeRecipeKey(recipe, row.media_sha256);
  if (row.recipe !== recipe || row.recipe_key !== key
    || typeof row.created_at !== "string" || !row.created_at
    || typeof row.updated_at !== "string" || !row.updated_at) {
    throw integrityViolation("派生记录的 recipe、时间戳或源 SHA 身份已漂移。");
  }
  if (row.status === "blocked" || row.status === "failed") {
    if (row.output_sha256 !== null || row.size_bytes !== null || row.mime_type !== null || row.relative_path !== null
      || typeof row.error_code !== "string" || !row.error_code) {
      throw integrityViolation("非 ready 派生记录夹带了伪造输出。");
    }
    throw new StudioMediaProtocolError("DERIVATIVE_NOT_READY", `派生尚未就绪：${row.status}`, 409);
  }
  if (row.status !== "ready") throw integrityViolation("派生记录 status 无效。");
  const mimeType = kind === "video_proxy" ? "video/mp4" : "image/webp";
  const relativeRoot = kind === "video_poster" ? THUMBNAIL_RELATIVE_ROOT : kind === "video_proxy" ? PROXY_RELATIVE_ROOT : WAVEFORM_RELATIVE_ROOT;
  const extension = kind === "video_proxy" ? ".mp4" : ".webp";
  const relativePath = `${relativeRoot}/${key}${extension}`;
  if (row.recipe !== recipe || row.recipe_key !== key
    || typeof row.output_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.output_sha256)
    || typeof row.size_bytes !== "number" || !Number.isSafeInteger(row.size_bytes) || row.size_bytes <= 0
    || row.mime_type !== mimeType || row.relative_path !== relativePath || row.error_code !== null) {
    throw integrityViolation("ready 派生记录不完整或偏离内容寻址路径。");
  }
  return {
    recipeKey: key,
    mediaSha256: row.media_sha256,
    kind,
    outputSha256: row.output_sha256,
    sizeBytes: row.size_bytes,
    mimeType,
    relativePath,
  };
}

function validateMediaRow(row: MediaRow): {
  sha256: string;
  kind: "image" | "video" | "audio";
  sizeBytes: number;
  mimeType: string;
  objectRelpath: string;
  thumbnailRecipeKey?: string;
  thumbnailRelpath?: string;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
} {
  if (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.sha256)) throw integrityViolation("素材记录 SHA-256 无效。");
  if (row.kind !== "image" && row.kind !== "video" && row.kind !== "audio") throw integrityViolation("素材记录 kind 无效。");
  if (typeof row.size_bytes !== "number" || !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0) {
    throw integrityViolation("素材记录 size_bytes 无效。");
  }
  if (typeof row.source_basename !== "string" || !row.source_basename || path.basename(row.source_basename) !== row.source_basename) {
    throw integrityViolation("素材记录 source_basename 无效。");
  }
  const mimeType = expectedMimeType(row.kind, row.source_basename);
  if (row.mime_type !== mimeType) throw integrityViolation("素材记录 MIME 与类型/扩展名不一致。");
  if (typeof row.object_relpath !== "string") throw integrityViolation("素材记录 object_relpath 无效。");
  const expectedObjectRelpath = `${OBJECTS_RELATIVE_ROOT}/${row.sha256.slice(0, 2)}/${row.sha256}`;
  if (row.object_relpath !== expectedObjectRelpath) throw integrityViolation("素材记录 object_relpath 偏离规范 CAS 路径。");

  if (row.kind === "image") {
    if (row.derivative_status !== "ready"
      || typeof row.thumbnail_recipe_key !== "string"
      || typeof row.thumbnail_relpath !== "string"
      || typeof row.thumbnail_width !== "number"
      || typeof row.thumbnail_height !== "number"
      || !Number.isSafeInteger(row.thumbnail_width)
      || !Number.isSafeInteger(row.thumbnail_height)
      || row.thumbnail_width < 1
      || row.thumbnail_height < 1
      || row.thumbnail_width > 512
      || row.thumbnail_height > 512) {
      throw integrityViolation("图片冻结缩略图记录不完整或无效。");
    }
    const expectedRecipeKey = thumbnailRecipeKey(row.sha256);
    if (row.thumbnail_recipe_key !== expectedRecipeKey) throw integrityViolation("缩略图 recipe key 与媒体 SHA 不匹配。");
    const expectedThumbnailRelpath = `${THUMBNAIL_RELATIVE_ROOT}/${expectedRecipeKey}.webp`;
    if (row.thumbnail_relpath !== expectedThumbnailRelpath) throw integrityViolation("缩略图路径偏离冻结派生路径。");
    return {
      sha256: row.sha256,
      kind: row.kind,
      sizeBytes: row.size_bytes,
      mimeType,
      objectRelpath: row.object_relpath,
      thumbnailRecipeKey: expectedRecipeKey,
      thumbnailRelpath: expectedThumbnailRelpath,
      thumbnailWidth: row.thumbnail_width,
      thumbnailHeight: row.thumbnail_height,
    };
  }

  if (row.derivative_status !== "pending"
    || row.thumbnail_recipe_key !== null
    || row.thumbnail_relpath !== null
    || row.thumbnail_width !== null
    || row.thumbnail_height !== null) {
    throw integrityViolation("视频/音频派生记录已漂移。");
  }
  return {
    sha256: row.sha256,
    kind: row.kind,
    sizeBytes: row.size_bytes,
    mimeType,
    objectRelpath: row.object_relpath,
  };
}

async function inspectManagedFile(
  canonicalRoot: string,
  filePath: string,
  label: string,
  expectedSize?: number,
): Promise<InspectedFile> {
  const pathStats = await assertManagedPath(canonicalRoot, filePath, label);
  if (expectedSize !== undefined && pathStats.size !== BigInt(expectedSize)) throw integrityViolation(`${label}大小与数据库记录不一致。`);
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, flags);
    const before = await handle.stat({ bigint: true });
    assertRegular(before, label);
    if (!identitiesEqual(identity(pathStats), identity(before))) throw integrityViolation(`${label}在打开期间被替换。`);
    const hash = createHash("sha256");
    const prefixChunks: Buffer[] = [];
    let prefixLength = 0;
    const stream = handle.createReadStream({ autoClose: false, start: 0 });
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      hash.update(chunk);
      if (prefixLength < 16) {
        const selected = chunk.subarray(0, 16 - prefixLength);
        prefixChunks.push(Buffer.from(selected));
        prefixLength += selected.length;
      }
    }
    const after = await handle.stat({ bigint: true });
    if (!identitiesEqual(identity(before), identity(after))) throw integrityViolation(`${label}在流式校验期间发生漂移。`);
    const pathAfter = await assertManagedPath(canonicalRoot, filePath, label);
    if (!identitiesEqual(identity(after), identity(pathAfter))) throw integrityViolation(`${label}在校验完成前被替换。`);
    return { identity: identity(after), sha256: hash.digest("hex"), prefix: Buffer.concat(prefixChunks) };
  } catch (error) {
    if (error instanceof StudioMediaProtocolError) throw error;
    throw integrityViolation(`无法安全打开或流式校验${label}。`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function verificationLookupKey(input: InspectCachedInput, canonicalPath: string): string {
  return JSON.stringify([input.target, input.canonicalRoot, input.recordIdentity, canonicalPath]);
}

function verificationBindingKey(lookupKey: string, expectedSha256: string, expectedSize: number): string {
  return JSON.stringify([lookupKey, expectedSha256, expectedSize]);
}

function fileIdentityKey(value: FileIdentity): string {
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
}

export { evictVerifiedFileCacheForProject, VERIFIED_FILE_CACHE_LIMIT };

/**
 * 离开工程时淘汰该工程 verifiedFileCache 桶。
 * 同时打 resolve 与 realpath 两键：媒体协议按 realpath 分桶，Main watcher 记 path.resolve。
 * 目录已不可读时仍淘汰 resolve 键。不得扩大 2048 上限。
 */
export async function evictVerifiedFileCacheAfterLeavingProject(projectRoot: string | null | undefined): Promise<number> {
  if (typeof projectRoot !== "string" || !projectRoot.trim()) return 0;
  const resolved = path.resolve(projectRoot.trim());
  const roots = [resolved];
  try {
    const canonical = await realpath(resolved);
    if (canonical !== resolved) roots.push(canonical);
  } catch {
    // 切走后工程根可能已不存在；resolve 键仍要淘汰。
  }
  dropInFlightFileInspectionsForRoots(roots);
  let removed = 0;
  for (const root of roots) removed += evictVerifiedFileCacheForProject(root);
  if (lastServedCanonicalRoot && roots.includes(lastServedCanonicalRoot)) lastServedCanonicalRoot = null;
  return removed;
}

/**
 * 缓存只跳过整文件 SHA；每次请求仍重新走完整路径链 lstat/realpath，并比较
 * dev/ino/size/mtime/ctime。缓存键同时绑定工程、冻结记录、期望内容与规范路径。
 */
async function inspectManagedFileCached(input: InspectCachedInput): Promise<InspectedFile> {
  const startedAtLeaveGeneration = verifiedFileLeaveGeneration();
  const canonicalPath = path.resolve(input.filePath);
  const pathStats = await assertManagedPath(input.canonicalRoot, canonicalPath, input.label);
  const currentIdentity = identity(pathStats);
  if (input.expectedSize !== undefined && currentIdentity.size !== BigInt(input.expectedSize)) {
    throw integrityViolation(`${input.label}大小与数据库记录不一致。`);
  }
  if (currentIdentity.size > BigInt(Number.MAX_SAFE_INTEGER)) throw integrityViolation(`${input.label}过大，无法安全提供。`);

  const lookupKey = verificationLookupKey(input, canonicalPath);
  const indexedBinding = getVerifiedFileLookup(input.canonicalRoot, lookupKey);
  const previous = indexedBinding ? getVerifiedFile<InspectedFile>(input.canonicalRoot, indexedBinding) : undefined;
  if (indexedBinding && !previous) deleteDanglingVerifiedFileLookup(input.canonicalRoot, lookupKey);

  if (previous && input.expectedSha256 !== undefined && input.expectedSize !== undefined
    && (previous.expectedSha256 !== input.expectedSha256 || previous.expectedSize !== input.expectedSize)) {
    throw integrityViolation(`${input.label}冻结记录的 SHA-256 或字节数发生漂移。`);
  }

  const requestedBinding = input.expectedSha256 !== undefined && input.expectedSize !== undefined
    ? verificationBindingKey(lookupKey, input.expectedSha256, input.expectedSize)
    : indexedBinding;
  const cached = requestedBinding ? getVerifiedFile<InspectedFile>(input.canonicalRoot, requestedBinding) : undefined;
  if (cached && identitiesEqual(cached.inspected.identity, currentIdentity)) {
    verificationCacheMetrics.cacheHits[input.target] += 1;
    touchVerifiedFile(cached);
    return cached.inspected;
  }

  verificationCacheMetrics.cacheMisses[input.target] += 1;
  const sizeToVerify = input.expectedSize ?? previous?.expectedSize;
  const inspectionIdentity = fileIdentityKey(currentIdentity);
  const inFlightKey = JSON.stringify([
    lookupKey,
    input.expectedSha256 ?? previous?.expectedSha256 ?? "",
    sizeToVerify ?? "",
    inspectionIdentity,
  ]);
  let pending = inFlightFileInspections.get(inFlightKey);
  if (!pending) {
    verificationCacheMetrics.fullHashVerifications[input.target] += 1;
    pending = inspectManagedFile(input.canonicalRoot, canonicalPath, input.label, sizeToVerify);
    inFlightFileInspections.set(inFlightKey, pending);
  }
  let inspected: InspectedFile;
  try {
    inspected = await pending;
  } finally {
    if (inFlightFileInspections.get(inFlightKey) === pending) inFlightFileInspections.delete(inFlightKey);
  }

  const expectedSha256 = input.expectedSha256 ?? previous?.expectedSha256 ?? inspected.sha256;
  const expectedSize = input.expectedSize ?? previous?.expectedSize ?? Number(inspected.identity.size);
  if (inspected.sha256 !== expectedSha256 || inspected.identity.size !== BigInt(expectedSize)) {
    throw integrityViolation(`${input.label} SHA-256 或字节数与冻结记录不匹配。`);
  }
  const bindingKey = verificationBindingKey(lookupKey, expectedSha256, expectedSize);
  verificationCacheMetrics.evictions += rememberVerifiedFile({
    bindingKey,
    lookupKey,
    target: input.target,
    canonicalRoot: input.canonicalRoot,
    canonicalPath,
    recordIdentity: input.recordIdentity,
    expectedSha256,
    expectedSize,
    inspected,
  }, startedAtLeaveGeneration);
  return inspected;
}

async function inspectCasObjectCached(
  canonicalRoot: string,
  filePath: string,
  mediaSha256: string,
  expectedSize: number,
): Promise<InspectedFile> {
  return inspectManagedFileCached({
    target: "media",
    canonicalRoot,
    filePath,
    label: "CAS 原始媒体",
    recordIdentity: `media:${mediaSha256}`,
    expectedSha256: mediaSha256,
    expectedSize,
  });
}

function isWebp(prefix: Buffer): boolean {
  return prefix.length >= 12 && prefix.subarray(0, 4).toString("ascii") === "RIFF" && prefix.subarray(8, 12).toString("ascii") === "WEBP";
}

function isMp4(prefix: Buffer): boolean {
  return prefix.length >= 12 && prefix.subarray(4, 8).toString("ascii") === "ftyp";
}

interface ParsedRange {
  status: 200 | 206 | 416;
  start?: number;
  end?: number;
  length: number;
}

function unsatisfied(): ParsedRange {
  return { status: 416, length: 0 };
}

function parseSingleRange(rangeHeader: string | undefined, totalSize: number): ParsedRange {
  if (rangeHeader === undefined) return { status: 200, start: 0, end: totalSize === 0 ? -1 : totalSize - 1, length: totalSize };
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(rangeHeader.trim());
  if (!match || rangeHeader.includes(",")) return unsatisfied();
  const first = match[1]!;
  const second = match[2]!;
  if ((!first && !second) || totalSize === 0) return unsatisfied();
  try {
    const total = BigInt(totalSize);
    if (!first) {
      const suffixLength = BigInt(second);
      if (suffixLength <= 0n) return unsatisfied();
      const start = suffixLength >= total ? 0n : total - suffixLength;
      return { status: 206, start: Number(start), end: totalSize - 1, length: totalSize - Number(start) };
    }
    const requestedStart = BigInt(first);
    if (requestedStart >= total) return unsatisfied();
    const requestedEnd = second ? BigInt(second) : total - 1n;
    if (requestedEnd < requestedStart) return unsatisfied();
    const end = requestedEnd >= total ? total - 1n : requestedEnd;
    return {
      status: 206,
      start: Number(requestedStart),
      end: Number(end),
      length: Number(end - requestedStart + 1n),
    };
  } catch {
    return unsatisfied();
  }
}

function quoteEtag(prefix: "sha256" | "thumbnail-sha256" | "derivative-sha256", hash: string): string {
  return `"${prefix}-${hash}"`;
}

function responseHeaders(
  status: StudioMediaProtocolStatus,
  mimeType: string,
  etag: string,
  totalSize: number,
  start: number | undefined,
  end: number | undefined,
  length: number,
): StudioMediaResponseHeaders {
  const headers: Record<string, string> = {
    "accept-ranges": "bytes",
    "cache-control": IMMUTABLE_CACHE_CONTROL,
    "content-length": String(status === 416 ? 0 : length),
    "content-type": mimeType,
    etag,
    "x-content-type-options": "nosniff",
  };
  if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${totalSize}`;
  if (status === 416) headers["content-range"] = `bytes */${totalSize}`;
  return Object.freeze(headers);
}

function resolvedResponse(input: {
  target: StudioMediaProtocolTarget;
  key: string;
  mediaSha256: string;
  filePath: string;
  totalSize: number;
  mimeType: string;
  etag: string;
  rangeHeader: string | undefined;
  canonicalRoot: string;
  identity: FileIdentity;
}): StudioMediaResolution {
  const parsed = parseSingleRange(input.rangeHeader, input.totalSize);
  const base = {
    target: input.target,
    key: input.key,
    mediaSha256: input.mediaSha256,
    totalSize: input.totalSize,
    mimeType: input.mimeType,
    etag: input.etag,
  } as const;
  let result: StudioMediaResolution;
  if (parsed.status === 416) {
    result = Object.freeze({
      ...base,
      status: 416,
      length: 0,
      headers: responseHeaders(416, input.mimeType, input.etag, input.totalSize, undefined, undefined, 0),
    });
  } else {
    result = Object.freeze({
      ...base,
      status: parsed.status,
      filePath: input.filePath,
      start: parsed.start!,
      end: parsed.end!,
      length: parsed.length,
      headers: responseHeaders(parsed.status, input.mimeType, input.etag, input.totalSize, parsed.start, parsed.end, parsed.length),
    });
  }
  trustedResolutions.set(result, { canonicalRoot: input.canonicalRoot, identity: input.identity });
  return result;
}

export function resolveStudioMediaRequest(
  projectRoot: string,
  request: StudioMediaProtocolRequest,
): Promise<StudioMediaResolution>;
export function resolveStudioMediaRequest(request: StudioMediaProtocolRequestWithRoot): Promise<StudioMediaResolution>;
export async function resolveStudioMediaRequest(
  projectRootOrRequest: string | StudioMediaProtocolRequestWithRoot,
  maybeRequest?: StudioMediaProtocolRequest,
): Promise<StudioMediaResolution> {
  const request = normalizeRequestArguments(projectRootOrRequest, maybeRequest);
  const canonicalRoot = await canonicalProjectRoot(request.projectRoot);
  if (lastServedCanonicalRoot && lastServedCanonicalRoot !== canonicalRoot) {
    await evictVerifiedFileCacheAfterLeavingProject(lastServedCanonicalRoot);
  }
  lastServedCanonicalRoot = canonicalRoot;
  const databasePath = await assertDatabaseFiles(canonicalRoot);
  if (request.target === "derivative") {
    const { derivative, source } = readDerivativeAndSourceRows(databasePath, request.key);
    const expectedMediaKind = derivative.kind === "audio_waveform" ? "audio" : "video";
    if (source.kind !== expectedMediaKind) throw integrityViolation("派生类型与源媒体 kind 不匹配。");
    await assertDatabaseFiles(canonicalRoot);
    // W5-D：serving 只校派生文件 + DB 绑定（recipeKey ↔ mediaSha256 ↔ kind）。
    // 不在每次派生服务前对源 CAS 做全 SHA。源对象全 SHA 仍由 target===media 与写入/恢复路径负责。
    const derivativePath = path.join(canonicalRoot, ...derivative.relativePath.split("/"));
    const inspected = await inspectManagedFileCached({
      target: "derivative",
      canonicalRoot,
      filePath: derivativePath,
      label: "冻结媒体派生",
      recordIdentity: `derivative:${derivative.recipeKey}:${derivative.mediaSha256}:${derivative.kind}`,
      expectedSha256: derivative.outputSha256,
      expectedSize: derivative.sizeBytes,
    });
    if ((derivative.kind === "video_proxy" && !isMp4(inspected.prefix))
      || (derivative.kind !== "video_proxy" && !isWebp(inspected.prefix))) {
      throw integrityViolation("派生文件魔数与配方类型不匹配。");
    }
    return resolvedResponse({
      target: "derivative",
      key: derivative.recipeKey,
      mediaSha256: derivative.mediaSha256,
      filePath: derivativePath,
      totalSize: derivative.sizeBytes,
      mimeType: derivative.mimeType,
      etag: quoteEtag("derivative-sha256", derivative.outputSha256),
      rangeHeader: request.rangeHeader,
      canonicalRoot,
      identity: inspected.identity,
    });
  }
  const rawRow = readMediaRow(databasePath, request.target, request.key);
  await assertDatabaseFiles(canonicalRoot);
  const row = validateMediaRow(rawRow);
  if (request.target === "media" && row.sha256 !== request.key) throw integrityViolation("请求 SHA 与素材记录不一致。");
  if (request.target === "thumbnail" && row.thumbnailRecipeKey !== request.key) throw integrityViolation("请求 recipe key 与冻结派生记录不一致。");

  if (request.target === "media") {
    const objectPath = path.join(canonicalRoot, ...row.objectRelpath.split("/"));
    const inspectedObject = await inspectCasObjectCached(canonicalRoot, objectPath, row.sha256, row.sizeBytes);
    return resolvedResponse({
      target: "media",
      key: row.sha256,
      mediaSha256: row.sha256,
      filePath: objectPath,
      totalSize: row.sizeBytes,
      mimeType: row.mimeType,
      etag: quoteEtag("sha256", row.sha256),
      rangeHeader: request.rangeHeader,
      canonicalRoot,
      identity: inspectedObject.identity,
    });
  }

  if (!row.thumbnailRelpath || !row.thumbnailRecipeKey) throw integrityViolation("缩略图冻结派生记录缺失。");
  const thumbnailPath = path.join(canonicalRoot, ...row.thumbnailRelpath.split("/"));
  const inspectedThumbnail = await inspectManagedFileCached({
    target: "thumbnail",
    canonicalRoot,
    filePath: thumbnailPath,
    label: "冻结缩略图",
    recordIdentity: `thumbnail:${row.thumbnailRecipeKey}:${row.sha256}:${row.thumbnailWidth}x${row.thumbnailHeight}`,
  });
  if (!isWebp(inspectedThumbnail.prefix)) throw integrityViolation("冻结缩略图不是有效的 WebP 文件。");
  return resolvedResponse({
    target: "thumbnail",
    key: row.thumbnailRecipeKey,
    mediaSha256: row.sha256,
    filePath: thumbnailPath,
    totalSize: Number(inspectedThumbnail.identity.size),
    mimeType: "image/webp",
    etag: quoteEtag("thumbnail-sha256", inspectedThumbnail.sha256),
    rangeHeader: request.rangeHeader,
    canonicalRoot,
    identity: inspectedThumbnail.identity,
  });
}

/**
 * 只打开由 resolveStudioMediaRequest 在当前进程产生且未漂移的描述。
 * 传入伪造/复制的 filePath 对象会被拒绝，避免 helper 退化为任意文件读取器。
 */
export async function openStudioMediaStream(resolution: StudioMediaResolution): Promise<Readable> {
  const trusted = trustedResolutions.get(resolution);
  if (!trusted) throw invalidRequest("只能打开 resolveStudioMediaRequest 返回的原始受控描述。");
  if (resolution.status === 416) {
    throw new StudioMediaProtocolError("RANGE_NOT_SATISFIABLE", "416 响应没有媒体流。", 416);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const pathStats = await assertManagedPath(trusted.canonicalRoot, resolution.filePath, "待流式读取媒体");
    if (!identitiesEqual(identity(pathStats), trusted.identity)) throw integrityViolation("媒体在解析后发生漂移，拒绝读取。");
    handle = await open(resolution.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptorStats = await handle.stat({ bigint: true });
    assertRegular(descriptorStats, "待流式读取媒体");
    if (!identitiesEqual(identity(descriptorStats), trusted.identity)) throw integrityViolation("媒体在打开前发生漂移，拒绝读取。");
    const pathAfter = await assertManagedPath(trusted.canonicalRoot, resolution.filePath, "待流式读取媒体");
    if (!identitiesEqual(identity(pathAfter), trusted.identity)) throw integrityViolation("媒体路径在打开期间发生漂移，拒绝读取。");
    if (resolution.length === 0) {
      await handle.close();
      handle = undefined;
      return Readable.from([]);
    }
    const stream = handle.createReadStream({
      autoClose: true,
      start: resolution.start,
      end: resolution.end,
    });
    handle = undefined;
    return stream;
  } catch (error) {
    if (error instanceof StudioMediaProtocolError) throw error;
    throw integrityViolation("无法安全打开媒体流。");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function streamStudioMediaRequest(
  projectRoot: string,
  request: StudioMediaProtocolRequest,
): Promise<{ resolution: StudioMediaResolution; stream: Readable | null }> {
  const resolution = await resolveStudioMediaRequest(projectRoot, request);
  return {
    resolution,
    stream: resolution.status === 416 ? null : await openStudioMediaStream(resolution),
  };
}
