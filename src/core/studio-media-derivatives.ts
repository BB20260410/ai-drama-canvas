import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, link, lstat, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { studioSqliteBusyTimeoutMs } from "./studio-sqlite-busy.js";
import { loadSharpDefault } from "./sharp-lazy.js";
import { inspectManagedProject } from "./managed-project.js";
import { MEDIA_WEIGHTS, mediaStageTimeout, runMediaProcess } from "./media-runtime.js";
import { getStudioMedia, type StudioMediaKind } from "./material-studio.js";
import { withProjectLock } from "./locks.js";
import {
  resolveStudioMediaRequest,
  StudioMediaProtocolError,
  type StudioMediaResolvedRange,
} from "./studio-media-protocol.js";

const BUSY_TIMEOUT_MS = 5_000;
const DERIVATIVE_LOCK = "studio-media-derivatives";
const DERIVATIVE_LOCK_TIMEOUT_MS = 120_000;
const DERIVATIVE_LOCK_STALE_MS = 6 * 60 * 60_000;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1_024;

export const STUDIO_MEDIA_DERIVATIVE_RECIPES = {
  videoPoster: "studio-video-poster:v1:first-frame:max-1280x720:webp-q82",
  videoProxy: "studio-video-proxy:v1:max-1280x720:h264-crf28-aac128k-faststart",
  audioWaveform: "studio-audio-waveform:v1:1200x160:mono:webp-q82",
} as const;

export type StudioMediaDerivativeKind = "video_poster" | "video_proxy" | "audio_waveform";
export type StudioMediaDerivativeStatus = "ready" | "blocked" | "failed";

export interface StudioMediaDerivativeRecord {
  recipeKey: string;
  mediaSha256: string;
  kind: StudioMediaDerivativeKind;
  status: StudioMediaDerivativeStatus;
  recipe: string;
  outputSha256?: string;
  sizeBytes?: number;
  mimeType?: "image/webp" | "video/mp4";
  relativePath?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MaterializeStudioMediaDerivativesResult {
  schemaVersion: 1;
  mediaSha256: string;
  mediaKind: "video" | "audio";
  status: "ready" | "blocked";
  replayed: boolean;
  derivatives: StudioMediaDerivativeRecord[];
}

export type StudioMediaDerivativeErrorCode =
  | "invalid_request"
  | "media_not_found"
  | "unsupported_media_kind"
  | "source_drift"
  | "derivative_drift"
  | "database_drift"
  | "engine_failed";

export class StudioMediaDerivativeError extends Error {
  readonly code: StudioMediaDerivativeErrorCode;

  constructor(code: StudioMediaDerivativeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StudioMediaDerivativeError";
    this.code = code;
  }
}

interface DerivativeDefinition {
  kind: StudioMediaDerivativeKind;
  mediaKind: "video" | "audio";
  recipe: string;
  directory: "thumb" | "proxy" | "waveform";
  extension: ".webp" | ".mp4";
  mimeType: "image/webp" | "video/mp4";
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

interface InspectedOutput {
  sha256: string;
  sizeBytes: number;
  prefix: Buffer;
}

const DEFINITIONS: Record<StudioMediaDerivativeKind, DerivativeDefinition> = {
  video_poster: {
    kind: "video_poster",
    mediaKind: "video",
    recipe: STUDIO_MEDIA_DERIVATIVE_RECIPES.videoPoster,
    directory: "thumb",
    extension: ".webp",
    mimeType: "image/webp",
  },
  video_proxy: {
    kind: "video_proxy",
    mediaKind: "video",
    recipe: STUDIO_MEDIA_DERIVATIVE_RECIPES.videoProxy,
    directory: "proxy",
    extension: ".mp4",
    mimeType: "video/mp4",
  },
  audio_waveform: {
    kind: "audio_waveform",
    mediaKind: "audio",
    recipe: STUDIO_MEDIA_DERIVATIVE_RECIPES.audioWaveform,
    directory: "waveform",
    extension: ".webp",
    mimeType: "image/webp",
  },
};

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

function normalizeSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new StudioMediaDerivativeError("invalid_request", "mediaSha256 必须是完整的 64 位 SHA-256。");
  }
  return normalized;
}

export function studioMediaDerivativeRecipeKey(kind: StudioMediaDerivativeKind, mediaSha256: string): string {
  const definition = DEFINITIONS[kind];
  if (!definition) throw new StudioMediaDerivativeError("invalid_request", `不支持的派生类型：${String(kind)}`);
  return createHash("sha256").update(`${definition.recipe}\0${normalizeSha256(mediaSha256)}`, "utf8").digest("hex");
}

function definitionsForMediaKind(kind: StudioMediaKind): DerivativeDefinition[] {
  if (kind === "video") return [DEFINITIONS.video_poster, DEFINITIONS.video_proxy];
  if (kind === "audio") return [DEFINITIONS.audio_waveform];
  throw new StudioMediaDerivativeError("unsupported_media_kind", "图片使用既有冻结缩略图，不进入大媒体懒派生管线。");
}

function expectedRelativePath(definition: DerivativeDefinition, recipeKey: string): string {
  return `.aicanvas/derived/${definition.directory}/${recipeKey}${definition.extension}`;
}

function databasePath(projectRoot: string): string {
  return path.join(projectRoot, ".aicanvas", "material-studio.sqlite");
}

function ensureDerivativeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_media_derivatives (
      recipe_key TEXT PRIMARY KEY CHECK(length(recipe_key) = 64),
      media_sha256 TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('video_poster', 'video_proxy', 'audio_waveform')),
      status TEXT NOT NULL CHECK(status IN ('ready', 'blocked', 'failed')),
      recipe TEXT NOT NULL,
      output_sha256 TEXT CHECK(output_sha256 IS NULL OR length(output_sha256) = 64),
      size_bytes INTEGER CHECK(size_bytes IS NULL OR size_bytes >= 0),
      mime_type TEXT,
      relative_path TEXT UNIQUE,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(media_sha256, kind),
      FOREIGN KEY(media_sha256) REFERENCES studio_media(sha256) ON DELETE RESTRICT,
      CHECK(
        (status = 'ready' AND output_sha256 IS NOT NULL AND size_bytes IS NOT NULL AND mime_type IS NOT NULL AND relative_path IS NOT NULL AND error_code IS NULL)
        OR (status IN ('blocked', 'failed') AND output_sha256 IS NULL AND size_bytes IS NULL AND mime_type IS NULL AND relative_path IS NULL AND error_code IS NOT NULL)
      )
    ) STRICT;
    CREATE INDEX IF NOT EXISTS studio_derivative_media_kind_idx ON studio_media_derivatives(media_sha256, kind);
  `);
  const columns = db.prepare("PRAGMA table_info(studio_media_derivatives)").all() as Array<{ name?: unknown }>;
  if (columns.length !== EXPECTED_DERIVATIVE_COLUMNS.length
    || columns.some((column, index) => column.name !== EXPECTED_DERIVATIVE_COLUMNS[index])) {
    throw new StudioMediaDerivativeError("database_drift", "素材派生索引 schema 已漂移，已停止。");
  }
}

function openDerivativeDatabase(projectRoot: string): DatabaseSync {
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(BUSY_TIMEOUT_MS);
  const db = new DatabaseSync(databasePath(projectRoot), { timeout: busyTimeoutMs });
  try {
    db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;`);
    const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
    if (foreignKeys?.foreign_keys !== 1) throw new StudioMediaDerivativeError("database_drift", "素材派生索引未启用 foreign_keys。");
    ensureDerivativeSchema(db);
    return db;
  } catch (error) {
    db.close();
    if (error instanceof StudioMediaDerivativeError) throw error;
    throw new StudioMediaDerivativeError("database_drift", "素材派生索引不可读写。", { cause: error });
  }
}

function recordFromRow(row: DerivativeRow): StudioMediaDerivativeRecord {
  if (typeof row.recipe_key !== "string" || !/^[a-f0-9]{64}$/u.test(row.recipe_key)
    || typeof row.media_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.media_sha256)
    || (row.kind !== "video_poster" && row.kind !== "video_proxy" && row.kind !== "audio_waveform")
    || (row.status !== "ready" && row.status !== "blocked" && row.status !== "failed")
    || typeof row.recipe !== "string"
    || typeof row.created_at !== "string"
    || typeof row.updated_at !== "string") {
    throw new StudioMediaDerivativeError("database_drift", "素材派生索引包含无效记录。");
  }
  const definition = DEFINITIONS[row.kind];
  const expectedKey = studioMediaDerivativeRecipeKey(row.kind, row.media_sha256);
  if (row.recipe !== definition.recipe || row.recipe_key !== expectedKey) {
    throw new StudioMediaDerivativeError("database_drift", "素材派生 recipe 与源 SHA 不匹配。");
  }
  if (row.status === "ready") {
    const relativePath = expectedRelativePath(definition, expectedKey);
    if (typeof row.output_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.output_sha256)
      || typeof row.size_bytes !== "number" || !Number.isSafeInteger(row.size_bytes) || row.size_bytes <= 0
      || row.mime_type !== definition.mimeType
      || row.relative_path !== relativePath
      || row.error_code !== null) {
      throw new StudioMediaDerivativeError("database_drift", "ready 派生记录不完整或偏离内容寻址路径。");
    }
    return {
      recipeKey: row.recipe_key,
      mediaSha256: row.media_sha256,
      kind: row.kind,
      status: row.status,
      recipe: row.recipe,
      outputSha256: row.output_sha256,
      sizeBytes: row.size_bytes,
      mimeType: definition.mimeType,
      relativePath,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  if (row.output_sha256 !== null || row.size_bytes !== null || row.mime_type !== null || row.relative_path !== null
    || typeof row.error_code !== "string" || !row.error_code) {
    throw new StudioMediaDerivativeError("database_drift", "非 ready 派生记录夹带了伪造输出。");
  }
  return {
    recipeKey: row.recipe_key,
    mediaSha256: row.media_sha256,
    kind: row.kind,
    status: row.status,
    recipe: row.recipe,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowsForMedia(db: DatabaseSync, mediaSha256: string): StudioMediaDerivativeRecord[] {
  return (db.prepare("SELECT * FROM studio_media_derivatives WHERE media_sha256 = ? ORDER BY kind").all(mediaSha256) as unknown as DerivativeRow[])
    .map(recordFromRow);
}

function relativePathInside(projectRoot: string, absolutePath: string): string {
  const relative = path.relative(projectRoot, absolutePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new StudioMediaDerivativeError("derivative_drift", "派生路径越出受管项目。");
  }
  return relative.split(path.sep).join("/");
}

async function inspectedOutput(filePath: string, expectedKind: StudioMediaDerivativeKind): Promise<InspectedOutput> {
  const before = await lstat(filePath, { bigint: true }).catch((error: unknown) => {
    throw new StudioMediaDerivativeError("derivative_drift", "派生文件缺失。", { cause: error });
  });
  if (!before.isFile() || before.isSymbolicLink()) throw new StudioMediaDerivativeError("derivative_drift", "派生目标必须是普通文件。");
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const prefixChunks: Buffer[] = [];
  let prefixBytes = 0;
  for await (const raw of createReadStream(filePath)) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    hash.update(chunk);
    sizeBytes += chunk.length;
    if (prefixBytes < 16) {
      const selected = chunk.subarray(0, 16 - prefixBytes);
      prefixChunks.push(Buffer.from(selected));
      prefixBytes += selected.length;
    }
  }
  const after = await lstat(filePath, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new StudioMediaDerivativeError("derivative_drift", "派生文件在流式校验期间发生漂移。");
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new StudioMediaDerivativeError("derivative_drift", "派生文件大小无效。");
  const prefix = Buffer.concat(prefixChunks);
  const webp = prefix.length >= 12 && prefix.subarray(0, 4).toString("ascii") === "RIFF" && prefix.subarray(8, 12).toString("ascii") === "WEBP";
  const mp4 = prefix.length >= 12 && prefix.subarray(4, 8).toString("ascii") === "ftyp";
  if ((expectedKind === "video_proxy" && !mp4) || (expectedKind !== "video_proxy" && !webp)) {
    throw new StudioMediaDerivativeError("derivative_drift", "派生文件魔数与配方类型不匹配。");
  }
  return { sha256: hash.digest("hex"), sizeBytes, prefix };
}

async function validateReadyRecord(projectRoot: string, record: StudioMediaDerivativeRecord): Promise<void> {
  if (record.status !== "ready" || !record.relativePath || !record.outputSha256 || record.sizeBytes === undefined) {
    throw new StudioMediaDerivativeError("database_drift", "派生记录尚未 ready。");
  }
  const definition = DEFINITIONS[record.kind];
  const absolute = path.resolve(projectRoot, ...record.relativePath.split("/"));
  if (relativePathInside(projectRoot, absolute) !== record.relativePath) {
    throw new StudioMediaDerivativeError("derivative_drift", "派生路径不是规范项目相对路径。");
  }
  const canonical = await realpath(absolute).catch((error: unknown) => {
    throw new StudioMediaDerivativeError("derivative_drift", "派生文件无法解析真实路径。", { cause: error });
  });
  if (canonical !== absolute || relativePathInside(projectRoot, canonical) !== expectedRelativePath(definition, record.recipeKey)) {
    throw new StudioMediaDerivativeError("derivative_drift", "派生文件路径包含符号链接或越界。");
  }
  const inspected = await inspectedOutput(absolute, record.kind);
  if (inspected.sha256 !== record.outputSha256 || inspected.sizeBytes !== record.sizeBytes) {
    throw new StudioMediaDerivativeError("derivative_drift", "派生文件 SHA-256 或字节数与索引不匹配。");
  }
}

async function resolveSourceCas(projectRoot: string, mediaSha256: string): Promise<StudioMediaResolvedRange> {
  try {
    const resolution = await resolveStudioMediaRequest(projectRoot, { mediaSha256 });
    if (resolution.status === 416) {
      throw new StudioMediaDerivativeError("source_drift", "原始 CAS 媒体意外返回不可满足范围。");
    }
    return resolution;
  } catch (error) {
    if (error instanceof StudioMediaDerivativeError) throw error;
    if (error instanceof StudioMediaProtocolError) {
      const sourceFileDrift = error.code === "INTEGRITY_VIOLATION" && error.message.includes("CAS 原始媒体");
      throw new StudioMediaDerivativeError(
        sourceFileDrift ? "source_drift" : "database_drift",
        sourceFileDrift ? "原始 CAS 媒体身份或内容已漂移。" : "原始媒体索引或素材库结构已漂移。",
        { cause: error },
      );
    }
    throw error;
  }
}

async function executableCandidate(filePath: string): Promise<string | undefined> {
  try {
    await access(filePath, fsConstants.X_OK);
    const canonical = await realpath(filePath);
    const stats = await lstat(canonical);
    return stats.isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

async function findMediaExecutable(name: "ffmpeg" | "ffprobe"): Promise<string | undefined> {
  const environmentKey = name === "ffmpeg" ? "AI_CANVAS_FFMPEG" : "AI_CANVAS_FFPROBE";
  if (Object.prototype.hasOwnProperty.call(process.env, environmentKey)) {
    const explicit = process.env[environmentKey]?.trim();
    return explicit ? executableCandidate(path.resolve(explicit)) : undefined;
  }
  const candidates = [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, name)),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ];
  for (const candidate of [...new Set(candidates)]) {
    const executable = await executableCandidate(candidate);
    if (executable) return executable;
  }
  return undefined;
}

function processFailure(stage: string, result: Awaited<ReturnType<typeof runMediaProcess>>): StudioMediaDerivativeError {
  const detail = result.status === "timed_out"
    ? `${stage} 超时，进程树已终止。`
    : result.status === "cancelled"
      ? `${stage} 已取消。`
      : result.output.trim().split("\n").slice(-8).join("\n") || `${stage} 失败。`;
  return new StudioMediaDerivativeError("engine_failed", detail);
}

async function runControlled(
  projectRoot: string,
  executable: string,
  args: string[],
  tool: "ffmpeg" | "ffprobe",
  stage: string,
  signal?: AbortSignal,
) {
  const result = await runMediaProcess(executable, args, {
    projectRoot,
    tool,
    stage,
    weight: tool === "ffprobe" ? MEDIA_WEIGHTS.probe : MEDIA_WEIGHTS.foreground,
    timeoutMs: mediaStageTimeout(tool, tool === "ffprobe" ? 30_000 : 30 * 60_000),
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    signal,
  });
  if (result.status !== "succeeded") throw processFailure(stage, result);
  return result;
}

function parsedProbe(stdout: string, label: string): { streams: Array<Record<string, unknown>>; format?: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(stdout) as { streams?: unknown; format?: unknown };
    if (!Array.isArray(parsed.streams)) throw new Error("streams missing");
    return {
      streams: parsed.streams.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)),
      format: parsed.format && typeof parsed.format === "object" && !Array.isArray(parsed.format) ? parsed.format as Record<string, unknown> : undefined,
    };
  } catch (error) {
    throw new StudioMediaDerivativeError("engine_failed", `${label} FFprobe JSON 无效。`, { cause: error });
  }
}

async function probeSource(
  projectRoot: string,
  ffprobePath: string,
  sourcePath: string,
  mediaKind: "video" | "audio",
  signal?: AbortSignal,
): Promise<void> {
  const result = await runControlled(projectRoot, ffprobePath, [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height:format=duration",
    "-of", "json",
    sourcePath,
  ], "ffprobe", `studio-${mediaKind}-source-probe`, signal);
  const probe = parsedProbe(result.stdout, "源媒体");
  if (!probe.streams.some((stream) => stream.codec_type === mediaKind)) {
    throw new StudioMediaDerivativeError("engine_failed", `源文件不包含 ${mediaKind} 流。`);
  }
}

async function probeProxy(
  projectRoot: string,
  ffprobePath: string,
  proxyPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runControlled(projectRoot, ffprobePath, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height",
    "-of", "json",
    proxyPath,
  ], "ffprobe", "studio-video-proxy-probe", signal);
  const stream = parsedProbe(result.stdout, "720p 代理").streams[0];
  if (!stream || stream.codec_name !== "h264"
    || typeof stream.width !== "number" || typeof stream.height !== "number"
    || stream.width < 2 || stream.height < 2 || stream.width > 1_280 || stream.height > 720
    || stream.width % 2 !== 0 || stream.height % 2 !== 0) {
    throw new StudioMediaDerivativeError("engine_failed", "720p 代理的 H.264/尺寸验收失败。");
  }
}

async function encodeWebpFromPng(
  pngPath: string,
  webpPath: string,
  expected: { width?: number; height?: number; maxWidth: number; maxHeight: number },
): Promise<void> {
  try {
    await (await loadSharpDefault())(pngPath, {
      failOn: "error",
      limitInputPixels: 1_000_000,
      sequentialRead: true,
    }).webp({ quality: 82, effort: 4, smartSubsample: true }).toFile(webpPath);
    const metadata = await (await loadSharpDefault())(webpPath, { failOn: "error", limitInputPixels: 1_000_000 }).metadata();
    if (metadata.format !== "webp"
      || typeof metadata.width !== "number" || typeof metadata.height !== "number"
      || metadata.width < 1 || metadata.height < 1
      || metadata.width > expected.maxWidth || metadata.height > expected.maxHeight
      || (expected.width !== undefined && metadata.width !== expected.width)
      || (expected.height !== undefined && metadata.height !== expected.height)) {
      throw new Error("WebP 尺寸或格式不符合配方");
    }
  } catch (error) {
    throw new StudioMediaDerivativeError("engine_failed", "WebP 派生编码或验收失败。", { cause: error });
  }
}

function targetPath(projectRoot: string, definition: DerivativeDefinition, recipeKey: string): string {
  return path.join(projectRoot, ...expectedRelativePath(definition, recipeKey).split("/"));
}

async function assertTargetAbsent(target: string): Promise<void> {
  try {
    await lstat(target);
    throw new StudioMediaDerivativeError("derivative_drift", "发现未经索引承诺的派生文件，拒绝覆盖。");
  } catch (error) {
    if (error instanceof StudioMediaDerivativeError) throw error;
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  }
}

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function promoteNoClobber(temporaryPath: string, target: string): Promise<void> {
  await fsyncFile(temporaryPath);
  try {
    await link(temporaryPath, target);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new StudioMediaDerivativeError("derivative_drift", "派生目标在原子提升前已存在，拒绝覆盖。");
    }
    throw error;
  }
  await rm(temporaryPath, { force: true });
}

function writeStatusRows(
  db: DatabaseSync,
  mediaSha256: string,
  definitions: DerivativeDefinition[],
  status: "blocked" | "failed",
  errorCode: string,
): StudioMediaDerivativeRecord[] {
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const selectByIdentity = db.prepare("SELECT * FROM studio_media_derivatives WHERE recipe_key = ? OR (media_sha256 = ? AND kind = ?)");
    const insert = db.prepare(`
      INSERT INTO studio_media_derivatives(
        recipe_key, media_sha256, kind, status, recipe, output_sha256, size_bytes,
        mime_type, relative_path, error_code, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
      ON CONFLICT(recipe_key) DO UPDATE SET
        status = excluded.status,
        output_sha256 = NULL,
        size_bytes = NULL,
        mime_type = NULL,
        relative_path = NULL,
        error_code = excluded.error_code,
        updated_at = excluded.updated_at
    `);
    for (const definition of definitions) {
      const recipeKey = studioMediaDerivativeRecipeKey(definition.kind, mediaSha256);
      const existing = selectByIdentity.all(recipeKey, mediaSha256, definition.kind) as unknown as DerivativeRow[];
      if (existing.some((row) => {
        const record = recordFromRow(row);
        return record.recipeKey !== recipeKey || record.mediaSha256 !== mediaSha256 || record.kind !== definition.kind || record.recipe !== definition.recipe;
      })) throw new StudioMediaDerivativeError("database_drift", "派生索引唯一身份已冲突。");
      insert.run(recipeKey, mediaSha256, definition.kind, status, definition.recipe, errorCode, now, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return rowsForMedia(db, mediaSha256);
}

function writeReadyRows(
  db: DatabaseSync,
  mediaSha256: string,
  outputs: Array<{ definition: DerivativeDefinition; inspected: InspectedOutput }>,
): StudioMediaDerivativeRecord[] {
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const selectByIdentity = db.prepare("SELECT * FROM studio_media_derivatives WHERE recipe_key = ? OR (media_sha256 = ? AND kind = ?)");
    const insert = db.prepare(`
      INSERT INTO studio_media_derivatives(
        recipe_key, media_sha256, kind, status, recipe, output_sha256, size_bytes,
        mime_type, relative_path, error_code, created_at, updated_at
      ) VALUES(?, ?, ?, 'ready', ?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(recipe_key) DO UPDATE SET
        status = 'ready',
        output_sha256 = excluded.output_sha256,
        size_bytes = excluded.size_bytes,
        mime_type = excluded.mime_type,
        relative_path = excluded.relative_path,
        error_code = NULL,
        updated_at = excluded.updated_at
    `);
    for (const { definition, inspected } of outputs) {
      const recipeKey = studioMediaDerivativeRecipeKey(definition.kind, mediaSha256);
      const existing = selectByIdentity.all(recipeKey, mediaSha256, definition.kind) as unknown as DerivativeRow[];
      if (existing.some((row) => {
        const record = recordFromRow(row);
        return record.recipeKey !== recipeKey || record.mediaSha256 !== mediaSha256 || record.kind !== definition.kind || record.recipe !== definition.recipe;
      })) throw new StudioMediaDerivativeError("database_drift", "派生索引唯一身份已冲突。");
      insert.run(
        recipeKey,
        mediaSha256,
        definition.kind,
        definition.recipe,
        inspected.sha256,
        inspected.sizeBytes,
        definition.mimeType,
        expectedRelativePath(definition, recipeKey),
        now,
        now,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return rowsForMedia(db, mediaSha256);
}

async function generateVideo(
  projectRoot: string,
  sourcePath: string,
  mediaSha256: string,
  ffmpegPath: string,
  ffprobePath: string,
  definitions: DerivativeDefinition[],
  signal?: AbortSignal,
): Promise<Array<{ definition: DerivativeDefinition; temporaryPath: string; targetPath: string; inspected: InspectedOutput }>> {
  await probeSource(projectRoot, ffprobePath, sourcePath, "video", signal);
  const outputs: Array<{ definition: DerivativeDefinition; temporaryPath: string; targetPath: string; inspected: InspectedOutput }> = [];
  const temporaryPaths = new Set<string>();
  try {
    for (const definition of definitions) {
      const recipeKey = studioMediaDerivativeRecipeKey(definition.kind, mediaSha256);
      const target = targetPath(projectRoot, definition, recipeKey);
      await assertTargetAbsent(target);
      const temporary = path.join(path.dirname(target), `.${recipeKey}.${randomUUID()}.tmp${definition.extension}`);
      temporaryPaths.add(temporary);
      if (definition.kind === "video_poster") {
        const frameTemporary = path.join(path.dirname(target), `.${recipeKey}.${randomUUID()}.tmp.png`);
        temporaryPaths.add(frameTemporary);
        await runControlled(projectRoot, ffmpegPath, [
          "-hide_banner", "-loglevel", "error", "-i", sourcePath, "-map", "0:v:0", "-frames:v", "1",
          "-vf", "scale=min(1280\\,iw):min(720\\,ih):force_original_aspect_ratio=decrease",
          "-c:v", "png", "-n", frameTemporary,
        ], "ffmpeg", `studio-${definition.kind}`, signal);
        await encodeWebpFromPng(frameTemporary, temporary, { maxWidth: 1_280, maxHeight: 720 });
        await rm(frameTemporary, { force: true });
        temporaryPaths.delete(frameTemporary);
      } else {
        await runControlled(projectRoot, ffmpegPath, [
          "-hide_banner", "-loglevel", "error", "-i", sourcePath, "-map", "0:v:0", "-map", "0:a?",
          "-vf", "scale=min(1280\\,iw):min(720\\,ih):force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-n", temporary,
        ], "ffmpeg", `studio-${definition.kind}`, signal);
      }
      if (definition.kind === "video_proxy") await probeProxy(projectRoot, ffprobePath, temporary, signal);
      outputs.push({ definition, temporaryPath: temporary, targetPath: target, inspected: await inspectedOutput(temporary, definition.kind) });
    }
    return outputs;
  } catch (error) {
    await Promise.all([...temporaryPaths].map((temporary) => rm(temporary, { force: true })));
    throw error;
  }
}

async function generateAudio(
  projectRoot: string,
  sourcePath: string,
  mediaSha256: string,
  ffmpegPath: string,
  ffprobePath: string,
  definition: DerivativeDefinition,
  signal?: AbortSignal,
): Promise<Array<{ definition: DerivativeDefinition; temporaryPath: string; targetPath: string; inspected: InspectedOutput }>> {
  await probeSource(projectRoot, ffprobePath, sourcePath, "audio", signal);
  const recipeKey = studioMediaDerivativeRecipeKey(definition.kind, mediaSha256);
  const target = targetPath(projectRoot, definition, recipeKey);
  await assertTargetAbsent(target);
  const temporary = path.join(path.dirname(target), `.${recipeKey}.${randomUUID()}.tmp${definition.extension}`);
  const frameTemporary = path.join(path.dirname(target), `.${recipeKey}.${randomUUID()}.tmp.png`);
  try {
    await runControlled(projectRoot, ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-i", sourcePath,
      "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1200x160:colors=0xD7AF55,format=rgb24",
      "-frames:v", "1", "-c:v", "png", "-n", frameTemporary,
    ], "ffmpeg", "studio-audio_waveform", signal);
    await encodeWebpFromPng(frameTemporary, temporary, { width: 1_200, height: 160, maxWidth: 1_200, maxHeight: 160 });
    await rm(frameTemporary, { force: true });
    return [{ definition, temporaryPath: temporary, targetPath: target, inspected: await inspectedOutput(temporary, definition.kind) }];
  } catch (error) {
    await Promise.all([temporary, frameTemporary].map((candidate) => rm(candidate, { force: true })));
    throw error;
  }
}

export async function getStudioMediaDerivatives(projectRoot: string, mediaSha256: string): Promise<StudioMediaDerivativeRecord[]> {
  const root = (await inspectManagedProject(projectRoot)).paths.root;
  const normalized = normalizeSha256(mediaSha256);
  const media = await getStudioMedia(root, normalized);
  if (!media) throw new StudioMediaDerivativeError("media_not_found", `素材媒体不存在：${normalized}`);
  const db = openDerivativeDatabase(root);
  try { return rowsForMedia(db, normalized); }
  finally { db.close(); }
}

export async function materializeStudioMediaDerivatives(
  projectRoot: string,
  input: { mediaSha256: string; signal?: AbortSignal },
): Promise<MaterializeStudioMediaDerivativesResult> {
  const normalized = normalizeSha256(input.mediaSha256);
  const initialShell = await inspectManagedProject(projectRoot);
  return withProjectLock(initialShell.paths.root, DERIVATIVE_LOCK, async () => {
    const shell = await inspectManagedProject(initialShell.paths.root);
    const root = shell.paths.root;
    const media = await getStudioMedia(root, normalized);
    if (!media) throw new StudioMediaDerivativeError("media_not_found", `素材媒体不存在：${normalized}`);
    const definitions = definitionsForMediaKind(media.kind);
    const sourceResolution = await resolveSourceCas(root, normalized);
    if (sourceResolution.filePath !== media.objectPath) {
      throw new StudioMediaDerivativeError("source_drift", "原始 CAS 媒体身份与索引不一致。");
    }
    const db = openDerivativeDatabase(root);
    let createdTargets: string[] = [];
    let pendingTemporaryPaths: string[] = [];
    try {
      const existing = rowsForMedia(db, normalized);
      if (existing.length > 0 && (existing.length !== definitions.length
        || existing.some((record) => !definitions.some((definition) => definition.kind === record.kind)))) {
        throw new StudioMediaDerivativeError("database_drift", "派生索引与源媒体类型或完整配方集合不匹配。");
      }
      const ready = existing.filter((record) => record.status === "ready");
      if (ready.length) {
        if (ready.length !== definitions.length || ready.some((record) => !definitions.some((definition) => definition.kind === record.kind))) {
          throw new StudioMediaDerivativeError("database_drift", "派生索引只有部分 ready，拒绝静默补齐。");
        }
        await Promise.all(ready.map((record) => validateReadyRecord(root, record)));
        await resolveSourceCas(root, normalized);
        return { schemaVersion: 1, mediaSha256: normalized, mediaKind: media.kind as "video" | "audio", status: "ready", replayed: true, derivatives: ready };
      }

      for (const definition of definitions) {
        await assertTargetAbsent(targetPath(root, definition, studioMediaDerivativeRecipeKey(definition.kind, normalized)));
      }

      const [ffmpegPath, ffprobePath] = await Promise.all([findMediaExecutable("ffmpeg"), findMediaExecutable("ffprobe")]);
      if (!ffmpegPath || !ffprobePath) {
        const missing = !ffmpegPath && !ffprobePath ? "ffmpeg_ffprobe_unavailable" : !ffmpegPath ? "ffmpeg_unavailable" : "ffprobe_unavailable";
        const derivatives = writeStatusRows(db, normalized, definitions, "blocked", missing);
        return { schemaVersion: 1, mediaSha256: normalized, mediaKind: media.kind as "video" | "audio", status: "blocked", replayed: existing.length > 0, derivatives };
      }

      const outputs = media.kind === "video"
        ? await generateVideo(root, sourceResolution.filePath, normalized, ffmpegPath, ffprobePath, definitions, input.signal)
        : await generateAudio(root, sourceResolution.filePath, normalized, ffmpegPath, ffprobePath, definitions[0]!, input.signal);
      pendingTemporaryPaths = outputs.map((output) => output.temporaryPath);
      const sourceAfter = await resolveSourceCas(root, normalized);
      if (sourceAfter.filePath !== sourceResolution.filePath || sourceAfter.totalSize !== sourceResolution.totalSize) {
        throw new StudioMediaDerivativeError("source_drift", "原始 CAS 媒体在派生期间发生漂移。");
      }
      for (const output of outputs) {
        await promoteNoClobber(output.temporaryPath, output.targetPath);
        createdTargets.push(output.targetPath);
        const promoted = await inspectedOutput(output.targetPath, output.definition.kind);
        if (promoted.sha256 !== output.inspected.sha256 || promoted.sizeBytes !== output.inspected.sizeBytes) {
          throw new StudioMediaDerivativeError("derivative_drift", "派生文件原子提升后内容漂移。");
        }
      }
      const derivatives = writeReadyRows(db, normalized, outputs.map(({ definition, inspected }) => ({ definition, inspected })));
      createdTargets = [];
      pendingTemporaryPaths = [];
      return { schemaVersion: 1, mediaSha256: normalized, mediaKind: media.kind as "video" | "audio", status: "ready", replayed: false, derivatives };
    } catch (error) {
      await Promise.all([...createdTargets, ...pendingTemporaryPaths].map((target) => rm(target, { force: true })));
      if (error instanceof StudioMediaDerivativeError && ["source_drift", "derivative_drift", "database_drift"].includes(error.code)) throw error;
      try { writeStatusRows(db, normalized, definitions, "failed", "media_engine_failed"); } catch { /* 保留原始失败。 */ }
      if (error instanceof StudioMediaDerivativeError) throw error;
      throw new StudioMediaDerivativeError("engine_failed", "素材派生失败。", { cause: error });
    } finally {
      db.close();
    }
  }, { timeoutMs: DERIVATIVE_LOCK_TIMEOUT_MS, staleMs: DERIVATIVE_LOCK_STALE_MS });
}
