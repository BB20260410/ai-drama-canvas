import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { NOVEL_DOCX_LIMITS, parseNovelDocxIsolated } from "./novel-docx.js";
import type { NovelSourceSelectionGrant } from "./novel-source-selection.js";
import type {
  NovelImportPreflight,
  NovelImportSourceKind,
  NovelPreflightFile,
  NovelPreflightUnsupportedEntry,
  NovelTextEncoding,
} from "./novel-types.js";
import { NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM } from "./novel-types.js";

export interface NovelImportPreflightLimits {
  maximumEntries: number;
  maximumSupportedFiles: number;
  maximumSingleFileBytes: number;
  maximumTotalBytes: number;
  maximumDocxMembers: number;
  maximumDocxMemberExpandedBytes: number;
  maximumDocxExpandedBytes: number;
  maximumDocxCompressionRatio: number;
  maximumDocxOutputChars: number;
  docxTimeoutMs: number;
}

export interface NovelImportPreflightOptions {
  limits?: Partial<NovelImportPreflightLimits>;
}

export interface NovelImportPreflightAuthorizationTicket {
  schemaVersion: 1;
  kind: "novel-import-preflight-authorization";
  authorizationId: string;
  expiresAt: string;
}

export interface AuthorizedNovelImportPreflight {
  preflight: NovelImportPreflight;
  authorization: NovelImportPreflightAuthorizationTicket | null;
}

export interface NovelImportChapterSegment {
  kind: "prelude" | "heading" | "paragraph-bucket";
  heading: string | null;
  content: string;
}

export interface NovelPreflightSourceRead {
  text: string;
  sourceBytes: Buffer;
  sha256: string;
}

export const NOVEL_IMPORT_PREFLIGHT_LIMITS: Readonly<NovelImportPreflightLimits> = Object.freeze({
  maximumEntries: 20_000,
  maximumSupportedFiles: 5_000,
  maximumSingleFileBytes: NOVEL_DOCX_LIMITS.maximumFileBytes,
  maximumTotalBytes: 500_000_000,
  maximumDocxMembers: NOVEL_DOCX_LIMITS.maximumMembers,
  maximumDocxMemberExpandedBytes: NOVEL_DOCX_LIMITS.maximumMemberExpandedBytes,
  maximumDocxExpandedBytes: NOVEL_DOCX_LIMITS.maximumExpandedBytes,
  maximumDocxCompressionRatio: NOVEL_DOCX_LIMITS.maximumCompressionRatio,
  maximumDocxOutputChars: NOVEL_DOCX_LIMITS.maximumOutputChars,
  docxTimeoutMs: NOVEL_DOCX_LIMITS.timeoutMs,
});

type SourceEntryType = "directory" | "file" | "symlink" | "special";

interface FrozenIdentity {
  type: SourceEntryType;
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface ScannedSourceNode {
  absolutePath: string;
  relativePath: string;
  included: boolean;
  identity: FrozenIdentity;
  childNames?: string[];
  linkSha256?: string;
  contentSha256?: string;
}

interface ScanContext {
  sourceRoot: string;
  limits: NovelImportPreflightLimits;
  nodes: ScannedSourceNode[];
  includedEntries: number;
  regularFileBytes: number;
}

interface ParsedSupportedSource {
  text: string;
  encoding: NovelTextEncoding;
  warnings: string[];
  chapterCount: number;
  decodedTextSha256: string;
  docx?: NonNullable<NovelPreflightFile["docx"]>;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16_LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16_BE_BOM = Buffer.from([0xfe, 0xff]);
const UTF32_LE_BOM = Buffer.from([0xff, 0xfe, 0x00, 0x00]);
const UTF32_BE_BOM = Buffer.from([0x00, 0x00, 0xfe, 0xff]);
const CHAPTER_TARGET_CHARS = 12_000;
const LIMIT_KEYS = Object.freeze(Object.keys(NOVEL_IMPORT_PREFLIGHT_LIMITS) as Array<keyof NovelImportPreflightLimits>);
const PREFLIGHT_AUTHORIZATION_TTL_MS = 15 * 60 * 1_000;
const PREFLIGHT_AUTHORIZATION_RESERVATION_TTL_MS = 30 * 60 * 1_000;
const PREFLIGHT_AUTHORIZATION_CAPACITY = 128;
const PREFLIGHT_AUTHORIZATION_PATTERN = /^novel-preflight-auth-[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

interface NovelImportPreflightAuthorizationSession {
  authorizationHash: string;
  preflight: NovelImportPreflight;
  bindingFingerprint: string;
  issuedAtMs: number;
  expiresAtMs: number;
  inUse: boolean;
  reservedRequestHash?: string;
  reservationExpiresAtMs?: number;
}

const preflightAuthorizationSessions = new Map<string, NovelImportPreflightAuthorizationSession>();

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  const canonicalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonicalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => bytewiseCompare(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)]));
    }
    return candidate;
  };
  return JSON.stringify(canonicalize(value));
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function immutableJsonClone<T>(value: T): T {
  const cloned = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || Object.isFrozen(candidate)) return;
    for (const child of Object.values(candidate as Record<string, unknown>)) freeze(child);
    Object.freeze(candidate);
  };
  freeze(cloned);
  return cloned;
}

function preflightAuthorizationBinding(preflight: NovelImportPreflight): Record<string, string> {
  return {
    preflightId: preflight.preflightId,
    fingerprint: preflight.fingerprint,
    sourcePath: preflight.sourcePath,
    sourceRoot: preflight.sourceRoot,
    sourceTreeAggregateSha256: preflight.sourceTreeAggregateSha256,
  };
}

function validateFrozenPreflight(preflight: NovelImportPreflight): void {
  const { fingerprint, ...payload } = preflight;
  if (preflight.schemaVersion !== 1 || preflight.kind !== "novel-import-preflight"
    || preflight.chapterSplitAlgorithm !== NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM
    || !/^novel-preflight-[a-f0-9]{24}$/u.test(preflight.preflightId)
    || !/^[a-f0-9]{64}$/u.test(fingerprint)
    || sha256(canonicalJson(payload)) !== fingerprint
    || !path.isAbsolute(preflight.sourcePath) || path.resolve(preflight.sourcePath) !== preflight.sourcePath
    || !path.isAbsolute(preflight.sourceRoot) || path.resolve(preflight.sourceRoot) !== preflight.sourceRoot
    || !/^[a-f0-9]{64}$/u.test(preflight.sourceTreeAggregateSha256)) {
    throw new Error("服务端小说预检授权绑定已损坏。");
  }
}

function prunePreflightAuthorizationSessions(nowMs: number): void {
  for (const [key, session] of preflightAuthorizationSessions) {
    if (session.reservationExpiresAtMs !== undefined && session.reservationExpiresAtMs <= nowMs) {
      session.reservedRequestHash = undefined;
      session.reservationExpiresAtMs = undefined;
    }
    const reserved = session.reservedRequestHash !== undefined
      && session.reservationExpiresAtMs !== undefined
      && session.reservationExpiresAtMs > nowMs;
    if (!session.inUse && !reserved && session.expiresAtMs <= nowMs) {
      preflightAuthorizationSessions.delete(key);
    }
  }
}

function issuePreflightAuthorization(preflight: NovelImportPreflight): NovelImportPreflightAuthorizationTicket {
  validateFrozenPreflight(preflight);
  if (!preflight.eligible || preflight.unsupported.some((entry) => entry.fatal)) {
    throw new Error("小说预检未通过 eligible/fatal 门，不签发提交授权。");
  }
  const nowMs = Date.now();
  prunePreflightAuthorizationSessions(nowMs);
  if (preflightAuthorizationSessions.size >= PREFLIGHT_AUTHORIZATION_CAPACITY) {
    const evictable = [...preflightAuthorizationSessions.entries()]
      .filter(([, session]) => !session.inUse
        && (session.reservedRequestHash === undefined
          || session.reservationExpiresAtMs === undefined
          || session.reservationExpiresAtMs <= nowMs))
      .sort((left, right) => left[1].issuedAtMs - right[1].issuedAtMs)[0];
    if (!evictable) throw new Error("小说预检授权容量已满，请稍后重试。");
    preflightAuthorizationSessions.delete(evictable[0]);
  }

  const authorizationId = `novel-preflight-auth-${randomBytes(32).toString("base64url")}`;
  const authorizationHash = sha256(authorizationId);
  const frozenPreflight = immutableJsonClone(preflight);
  const bindingFingerprint = sha256(canonicalJson(preflightAuthorizationBinding(frozenPreflight)));
  const expiresAtMs = nowMs + PREFLIGHT_AUTHORIZATION_TTL_MS;
  preflightAuthorizationSessions.set(authorizationHash, {
    authorizationHash,
    preflight: frozenPreflight,
    bindingFingerprint,
    issuedAtMs: nowMs,
    expiresAtMs,
    inUse: false,
  });
  return {
    schemaVersion: 1,
    kind: "novel-import-preflight-authorization",
    authorizationId,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export async function withNovelImportPreflightAuthorization<T>(
  authorizationId: string,
  work: (preflight: NovelImportPreflight) => Promise<T>,
  reservedRequestHash?: string,
): Promise<T> {
  if (typeof authorizationId !== "string" || !PREFLIGHT_AUTHORIZATION_PATTERN.test(authorizationId)) {
    throw new Error("小说预检授权无效或已失效。");
  }
  const nowMs = Date.now();
  prunePreflightAuthorizationSessions(nowMs);
  const authorizationHash = sha256(authorizationId);
  const session = preflightAuthorizationSessions.get(authorizationHash);
  const hasMatchingReservation = Boolean(session
    && reservedRequestHash && SHA256_PATTERN.test(reservedRequestHash)
    && session.reservedRequestHash === reservedRequestHash
    && session.reservationExpiresAtMs !== undefined
    && session.reservationExpiresAtMs > nowMs);
  if (!session || session.authorizationHash !== authorizationHash
    || (!hasMatchingReservation && session.expiresAtMs <= nowMs)) {
    if (session && !session.inUse) preflightAuthorizationSessions.delete(authorizationHash);
    throw new Error("小说预检授权无效或已失效。");
  }
  if (session.inUse) throw new Error("小说预检授权正在使用，拒绝并发提交。");
  if (reservedRequestHash !== undefined && !hasMatchingReservation) {
    throw new Error("小说预检授权缺少与当前 command requestHash 匹配的写前 reservation。");
  }
  validateFrozenPreflight(session.preflight);
  if (sha256(canonicalJson(preflightAuthorizationBinding(session.preflight))) !== session.bindingFingerprint) {
    preflightAuthorizationSessions.delete(authorizationHash);
    throw new Error("服务端小说预检授权绑定已损坏。");
  }
  session.inUse = true;
  try {
    return await work(immutableJsonClone(session.preflight));
  } finally {
    const current = preflightAuthorizationSessions.get(authorizationHash);
    if (current === session) {
      current.inUse = false;
      prunePreflightAuthorizationSessions(Date.now());
    }
  }
}

/**
 * command bus 在创建 owner/lock/ledger 前原子钉住 capability 与稳定 requestHash。
 * reservation 只存在进程内，不进入命令请求、哈希、账本或事件；它防止预检票据
 * 在登记后、Core claim 前因 TTL/容量淘汰而把零业务写误留成 unknown。
 */
export function reserveNovelImportPreflightAuthorization(
  authorizationId: string,
  requestHash: string,
): NovelImportPreflight {
  if (typeof authorizationId !== "string" || !PREFLIGHT_AUTHORIZATION_PATTERN.test(authorizationId)
    || !SHA256_PATTERN.test(requestHash)) {
    throw new Error("小说预检授权或 reservation requestHash 无效。");
  }
  const nowMs = Date.now();
  prunePreflightAuthorizationSessions(nowMs);
  const authorizationHash = sha256(authorizationId);
  const session = preflightAuthorizationSessions.get(authorizationHash);
  if (!session || session.authorizationHash !== authorizationHash || session.expiresAtMs <= nowMs) {
    throw new Error("小说预检授权无效或已失效。");
  }
  if (session.inUse) throw new Error("小说预检授权正在使用，拒绝并发提交。");
  if (session.reservedRequestHash !== undefined && session.reservedRequestHash !== requestHash
    && session.reservationExpiresAtMs !== undefined && session.reservationExpiresAtMs > nowMs) {
    throw new Error("小说预检授权已绑定另一 command requestHash。");
  }
  validateFrozenPreflight(session.preflight);
  if (sha256(canonicalJson(preflightAuthorizationBinding(session.preflight))) !== session.bindingFingerprint) {
    throw new Error("服务端小说预检授权绑定已损坏。");
  }
  session.reservedRequestHash = requestHash;
  session.reservationExpiresAtMs = nowMs + PREFLIGHT_AUTHORIZATION_RESERVATION_TTL_MS;
  return immutableJsonClone(session.preflight);
}

/**
 * command bus 在创建 owner/lock/ledger 前使用的纯进程内授权检查。
 * 不标记 inUse、不消费 capability、不触碰文件系统。
 */
export function inspectNovelImportPreflightAuthorization(
  authorizationId: string,
): NovelImportPreflight {
  if (typeof authorizationId !== "string" || !PREFLIGHT_AUTHORIZATION_PATTERN.test(authorizationId)) {
    throw new Error("小说预检授权无效或已失效。");
  }
  const authorizationHash = sha256(authorizationId);
  const session = preflightAuthorizationSessions.get(authorizationHash);
  if (!session || session.authorizationHash !== authorizationHash || session.expiresAtMs <= Date.now()) {
    throw new Error("小说预检授权无效或已失效。");
  }
  if (session.inUse) throw new Error("小说预检授权正在使用，拒绝并发提交。");
  validateFrozenPreflight(session.preflight);
  if (sha256(canonicalJson(preflightAuthorizationBinding(session.preflight))) !== session.bindingFingerprint) {
    throw new Error("服务端小说预检授权绑定已损坏。");
  }
  return immutableJsonClone(session.preflight);
}

/**
 * Main 在目标绑定或安全 DTO 投影失败时撤销刚签发、尚未使用的授权。
 * 已进入使用或 command reservation 的授权不允许被旁路撤销。
 */
export function revokeNovelImportPreflightAuthorization(authorizationId: string): boolean {
  if (typeof authorizationId !== "string" || !PREFLIGHT_AUTHORIZATION_PATTERN.test(authorizationId)) return false;
  const authorizationHash = sha256(authorizationId);
  const session = preflightAuthorizationSessions.get(authorizationHash);
  if (!session || session.authorizationHash !== authorizationHash || session.inUse
    || session.reservedRequestHash !== undefined) return false;
  return preflightAuthorizationSessions.delete(authorizationHash);
}

/** 仅测试环境可用，避免跨 case 泄漏进程内短期授权。 */
export function resetNovelImportPreflightAuthorizationsForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("只允许在测试环境清理小说预检授权。");
  preflightAuthorizationSessions.clear();
}

function portableRelative(value: string): string {
  return value.split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} 超出安全整数范围。`);
  }
  return Number(value);
}

function sourceEntryType(metadata: BigIntStats): SourceEntryType {
  if (metadata.isSymbolicLink()) return "symlink";
  if (metadata.isDirectory()) return "directory";
  if (metadata.isFile()) return "file";
  return "special";
}

function freezeIdentity(metadata: BigIntStats): FrozenIdentity {
  return Object.freeze({
    type: sourceEntryType(metadata),
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  });
}

function sameIdentity(metadata: BigIntStats, identity: FrozenIdentity): boolean {
  return sourceEntryType(metadata) === identity.type
    && metadata.dev === identity.dev
    && metadata.ino === identity.ino
    && metadata.mode === identity.mode
    && metadata.nlink === identity.nlink
    && metadata.size === identity.size
    && metadata.mtimeNs === identity.mtimeNs
    && metadata.ctimeNs === identity.ctimeNs;
}

function sameFrozenIdentity(left: FrozenIdentity, right: FrozenIdentity): boolean {
  return left.type === right.type
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function selectedPathMatchesGrant(
  metadata: BigIntStats,
  sourcePath: string,
  selectionKind: NovelImportPreflight["selectionKind"],
  grant: NovelSourceSelectionGrant,
): boolean {
  return sourcePath === grant.sourcePath
    && selectionKind === grant.kind
    && metadata.dev === grant.identity.dev
    && metadata.ino === grant.identity.ino
    && metadata.mode === grant.identity.mode
    && metadata.nlink === grant.identity.nlink
    && metadata.size === grant.identity.size
    && metadata.mtimeNs === grant.identity.mtimeNs
    && metadata.ctimeNs === grant.identity.ctimeNs;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function readBoundedDirectoryNames(directory: string, maximumNames: number): Promise<string[]> {
  if (!Number.isSafeInteger(maximumNames) || maximumNames < 0) throw new Error("目录条目读取上限无效。");
  const names: string[] = [];
  const handle = await opendir(directory);
  try {
    for await (const entry of handle) {
      names.push(entry.name);
      if (names.length > maximumNames) {
        throw new Error(`小说来源目录条目超过剩余 ${maximumNames} 个额度，预检已停止。`);
      }
    }
  } finally {
    await handle.close().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ERR_DIR_CLOSED") throw error;
    });
  }
  return names.sort(bytewiseCompare);
}

function effectiveLimits(overrides: Partial<NovelImportPreflightLimits> | undefined): NovelImportPreflightLimits {
  if (overrides !== undefined && (typeof overrides !== "object" || overrides === null || Array.isArray(overrides))) {
    throw new Error("小说预检 limits 必须是对象。");
  }
  for (const key of Object.keys(overrides ?? {})) {
    if (!LIMIT_KEYS.includes(key as keyof NovelImportPreflightLimits)) {
      throw new Error(`小说预检包含未知限额：${key}`);
    }
  }
  const limits = { ...NOVEL_IMPORT_PREFLIGHT_LIMITS, ...(overrides ?? {}) };
  for (const key of LIMIT_KEYS) {
    const value = limits[key];
    const ceiling = NOVEL_IMPORT_PREFLIGHT_LIMITS[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      throw new Error(`小说预检 ${key} 只能收紧且必须为正安全整数。`);
    }
  }
  return limits;
}

async function assertCanonicalDirectory(directory: string, identity?: FrozenIdentity): Promise<FrozenIdentity> {
  const metadata = await lstat(directory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`小说来源目录必须是无符号链接真实目录：${directory}`);
  }
  if (identity && !sameIdentity(metadata, identity)) {
    throw new Error(`小说来源目录身份已变化：${directory}`);
  }
  if (await realpath(directory) !== directory) {
    throw new Error(`小说来源目录路径包含符号链接或路径别名：${directory}`);
  }
  return identity ?? freezeIdentity(metadata);
}

async function scanSourceNode(
  context: ScanContext,
  absolutePath: string,
  relativePath: string,
  included: boolean,
): Promise<void> {
  const before = await lstat(absolutePath, { bigint: true });
  const identity = freezeIdentity(before);
  if (included) {
    context.includedEntries += 1;
    if (context.includedEntries > context.limits.maximumEntries) {
      throw new Error(`小说来源条目超过 ${context.limits.maximumEntries} 个，预检已停止。`);
    }
  }

  const node: ScannedSourceNode = {
    absolutePath,
    relativePath,
    included,
    identity,
  };
  context.nodes.push(node);

  if (identity.type === "directory") {
    await assertCanonicalDirectory(absolutePath, identity);
    const remainingEntries = context.limits.maximumEntries - context.includedEntries;
    const names = await readBoundedDirectoryNames(absolutePath, remainingEntries);
    node.childNames = names;
    for (const name of names) {
      const childRelative = relativePath === "." ? name : `${relativePath}/${name}`;
      await scanSourceNode(context, path.join(absolutePath, name), childRelative, true);
    }
    const namesAfter = await readBoundedDirectoryNames(absolutePath, names.length);
    const after = await lstat(absolutePath, { bigint: true });
    if (!sameIdentity(after, identity) || !sameNames(names, namesAfter) || await realpath(absolutePath) !== absolutePath) {
      throw new Error(`小说来源目录枚举期间发生变化：${relativePath}`);
    }
    return;
  }

  if (identity.type === "file") {
    const byteLength = safeNumber(identity.size, `小说来源文件 ${relativePath} 的大小`);
    context.regularFileBytes += byteLength;
    if (!Number.isSafeInteger(context.regularFileBytes)
      || context.regularFileBytes > context.limits.maximumTotalBytes) {
      throw new Error(`小说来源普通文件总字节超过 ${context.limits.maximumTotalBytes}，预检已停止。`);
    }
    if (await realpath(absolutePath) !== absolutePath) {
      throw new Error(`小说来源文件真实路径逃逸或包含路径别名：${relativePath}`);
    }
    const after = await lstat(absolutePath, { bigint: true });
    if (!sameIdentity(after, identity)) throw new Error(`小说来源文件枚举期间发生变化：${relativePath}`);
    return;
  }

  if (identity.type === "symlink") {
    const linkValue = await readlink(absolutePath, { encoding: "buffer" });
    node.linkSha256 = sha256(linkValue);
    const after = await lstat(absolutePath, { bigint: true });
    if (!sameIdentity(after, identity)) throw new Error(`小说来源符号链接读取期间发生变化：${relativePath}`);
    return;
  }

  const after = await lstat(absolutePath, { bigint: true });
  if (!sameIdentity(after, identity)) throw new Error(`小说来源特殊节点检查期间发生变化：${relativePath}`);
}

async function assertNodeUnchanged(node: ScannedSourceNode): Promise<void> {
  const metadata = await lstat(node.absolutePath, { bigint: true });
  if (!sameIdentity(metadata, node.identity)) {
    throw new Error(`小说来源条目身份已变化：${node.relativePath}`);
  }
  if (node.identity.type === "directory") {
    await assertCanonicalDirectory(node.absolutePath, node.identity);
    const names = await readBoundedDirectoryNames(node.absolutePath, (node.childNames ?? []).length);
    if (!sameNames(node.childNames ?? [], names)) {
      throw new Error(`小说来源目录内容已变化：${node.relativePath}`);
    }
  } else if (node.identity.type === "file") {
    if (await realpath(node.absolutePath) !== node.absolutePath) {
      throw new Error(`小说来源文件真实路径已变化：${node.relativePath}`);
    }
  } else if (node.identity.type === "symlink") {
    const linkValue = await readlink(node.absolutePath, { encoding: "buffer" });
    if (sha256(linkValue) !== node.linkSha256) {
      throw new Error(`小说来源符号链接目标已变化：${node.relativePath}`);
    }
  }
}

async function readStableRegularFile(node: ScannedSourceNode, maximumBytes: number): Promise<Buffer> {
  if (node.identity.type !== "file") throw new Error(`小说来源条目不是普通文件：${node.relativePath}`);
  if (node.identity.nlink !== 1n) throw new Error(`小说来源普通文件不得是硬链接：${node.relativePath}`);
  const byteLength = safeNumber(node.identity.size, `小说来源文件 ${node.relativePath} 的大小`);
  if (byteLength > maximumBytes) throw new Error(`小说来源文件超过 ${maximumBytes} 字节上限：${node.relativePath}`);
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("当前运行时不支持 O_NOFOLLOW，拒绝预检小说来源。");
  }
  await assertNodeUnchanged(node);
  const handle = await open(node.absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameIdentity(before, node.identity)) throw new Error(`小说来源路径与只读 fd 身份不一致：${node.relativePath}`);
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(node.absolutePath, { bigint: true }),
    ]);
    if (!sameIdentity(after, node.identity)
      || !sameIdentity(pathAfter, node.identity)
      || bytes.byteLength !== byteLength
      || await realpath(node.absolutePath) !== node.absolutePath) {
      throw new Error(`小说来源文件稳定读取期间发生变化：${node.relativePath}`);
    }
    node.contentSha256 = sha256(bytes);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function hashStableRegularFile(node: ScannedSourceNode): Promise<string> {
  if (node.identity.type !== "file") throw new Error(`小说来源条目不是普通文件：${node.relativePath}`);
  if (node.identity.nlink !== 1n) throw new Error(`小说来源普通文件不得是硬链接：${node.relativePath}`);
  const byteLength = safeNumber(node.identity.size, `小说来源文件 ${node.relativePath} 的大小`);
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("当前运行时不支持 O_NOFOLLOW，拒绝预检小说来源。");
  }
  await assertNodeUnchanged(node);
  const handle = await open(node.absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameIdentity(before, node.identity)) throw new Error(`小说来源路径与只读 fd 身份不一致：${node.relativePath}`);
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(byteLength, 1)));
    let offset = 0;
    while (offset < byteLength) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.byteLength, byteLength - offset),
        offset,
      );
      if (bytesRead < 1) throw new Error(`小说来源文件流式哈希期间提前结束：${node.relativePath}`);
      digest.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytes } = await handle.read(trailing, 0, 1, offset);
    const [after, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(node.absolutePath, { bigint: true }),
    ]);
    if (trailingBytes !== 0
      || !sameIdentity(after, node.identity)
      || !sameIdentity(pathAfter, node.identity)
      || await realpath(node.absolutePath) !== node.absolutePath) {
      throw new Error(`小说来源文件流式哈希期间发生变化：${node.relativePath}`);
    }
    node.contentSha256 = digest.digest("hex");
    return node.contentSha256;
  } finally {
    await handle.close();
  }
}

function sourceKind(relativePath: string): NovelImportSourceKind | undefined {
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (extension === ".txt") return "text";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (extension === ".docx") return "docx";
  return undefined;
}

function decodeText(bytes: Buffer): { text: string; encoding: Exclude<NovelTextEncoding, "docx">; warnings: string[] } {
  const warnings: string[] = [];
  if (bytes.subarray(0, UTF32_LE_BOM.byteLength).equals(UTF32_LE_BOM)
    || bytes.subarray(0, UTF32_BE_BOM.byteLength).equals(UTF32_BE_BOM)
    || bytes.subarray(0, UTF16_LE_BOM.byteLength).equals(UTF16_LE_BOM)
    || bytes.subarray(0, UTF16_BE_BOM.byteLength).equals(UTF16_BE_BOM)) {
    throw new Error("文本仅支持 UTF-8 或 GB18030，拒绝 UTF-16/UTF-32 BOM。");
  }
  let text: string;
  let encoding: "utf-8" | "gb18030";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    encoding = "utf-8";
  } catch {
    text = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
    encoding = "gb18030";
  }
  if (bytes.subarray(0, UTF8_BOM.byteLength).equals(UTF8_BOM)) warnings.push("检测到 UTF-8 BOM；预检未修改源字节。");
  if (text.includes("\0")) {
    throw new Error("文本包含 NUL 字符，疑似 UTF-16 或二进制内容；仅接受 UTF-8/GB18030 正文。");
  }
  return { text, encoding, warnings };
}

function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 140) return false;
  if (/^#{1,6}\s+\S+/u.test(trimmed)) return true;
  return /^(?:第\s*[0-9０-９零一二三四五六七八九十百千万两]+\s*[卷部章节回幕集]|(?:chapter|episode|ep)\s*\d+)/iu.test(trimmed);
}

export function splitNovelImportTextByFrozenAlgorithm(source: string): NovelImportChapterSegment[] {
  if (source.includes("\0")) throw new Error("小说导入正文包含 NUL，拒绝拆章。");
  if (!source.trim()) return [];
  const text = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const headings = [...text.matchAll(/^.*$/gmu)]
    .filter((match) => isHeading(match[0] ?? ""))
    .map((match) => ({ index: match.index, line: match[0] ?? "" }));
  const segments: NovelImportChapterSegment[] = [];
  if (headings.length) {
    const prelude = text.slice(0, headings[0]!.index).trim();
    if (prelude.length >= 80) segments.push({ kind: "prelude", heading: null, content: prelude });
    for (let index = 0; index < headings.length; index += 1) {
      const heading = headings[index]!;
      const start = index === 0 && prelude.length < 80 ? 0 : heading.index;
      const end = headings[index + 1]?.index ?? text.length;
      const content = text.slice(start, end).trim();
      if (content) segments.push({ kind: "heading", heading: heading.line, content });
    }
    return segments;
  }
  const paragraphs = [...text.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/gu)].map((match) => match[0]?.trim() ?? "").filter(Boolean);
  let bucket: string[] = [];
  let buffered = 0;
  const flush = () => {
    if (!bucket.length) return;
    segments.push({ kind: "paragraph-bucket", heading: null, content: bucket.join("\n\n") });
    bucket = [];
    buffered = 0;
  };
  for (const paragraph of paragraphs) {
    if (buffered > 0 && buffered + paragraph.length + 2 > CHAPTER_TARGET_CHARS) {
      flush();
    }
    bucket.push(paragraph);
    buffered += paragraph.length + (buffered ? 2 : 0);
  }
  flush();
  return segments;
}

function recognizedChapterCount(source: string): number {
  return splitNovelImportTextByFrozenAlgorithm(source).length;
}

async function parseSupportedSource(
  node: ScannedSourceNode,
  kind: NovelImportSourceKind,
  sourceBytes: Buffer,
  limits: NovelImportPreflightLimits,
): Promise<ParsedSupportedSource> {
  if (kind === "docx") {
    let parseError: unknown;
    let parsed: Awaited<ReturnType<typeof parseNovelDocxIsolated>> | undefined;
    try {
      parsed = await parseNovelDocxIsolated(node.absolutePath, {
        maximumFileBytes: limits.maximumSingleFileBytes,
        maximumMembers: limits.maximumDocxMembers,
        maximumMemberExpandedBytes: limits.maximumDocxMemberExpandedBytes,
        maximumExpandedBytes: limits.maximumDocxExpandedBytes,
        maximumCompressionRatio: limits.maximumDocxCompressionRatio,
        maximumOutputChars: limits.maximumDocxOutputChars,
        timeoutMs: limits.docxTimeoutMs,
      });
    } catch (error) {
      parseError = error;
    }
    await assertNodeUnchanged(node);
    if (parseError) throw parseError;
    if (parsed!.sourceSha256 !== sha256(sourceBytes)) {
      throw new Error("DOCX 隔离解析使用的来源 SHA 与已冻结原始字节不一致。");
    }
    const text = parsed!.text;
    const decodedTextSha256 = sha256(Buffer.from(text, "utf8"));
    if (parsed!.outputSha256 !== decodedTextSha256) {
      throw new Error("DOCX 隔离解析输出 SHA 与提取正文不一致。");
    }
    const chapterCount = recognizedChapterCount(text);
    if (chapterCount < 1) throw new Error("DOCX 没有可识别正文。");
    return {
      text,
      encoding: "docx",
      warnings: [...parsed!.warnings],
      chapterCount,
      decodedTextSha256,
      docx: {
        outputSha256: parsed!.outputSha256,
        memberCount: parsed!.memberCount,
        expandedBytes: parsed!.expandedBytes,
        converter: { ...parsed!.converter },
      },
    };
  }

  const decoded = decodeText(sourceBytes);
  const chapterCount = recognizedChapterCount(decoded.text);
  if (chapterCount < 1) throw new Error("文本没有可识别正文。");
  return {
    text: decoded.text,
    encoding: decoded.encoding,
    warnings: decoded.warnings,
    chapterCount,
    decodedTextSha256: sha256(Buffer.from(decoded.text, "utf8")),
  };
}

function unsupportedEntry(
  node: ScannedSourceNode,
  reason: string,
  fatal: boolean,
): NovelPreflightUnsupportedEntry {
  return {
    relativePath: node.relativePath,
    entryType: node.identity.type,
    reason,
    fatal,
  };
}

function addPathConflictReports(nodes: ScannedSourceNode[], unsupported: NovelPreflightUnsupportedEntry[]): void {
  const byPortableKey = new Map<string, ScannedSourceNode[]>();
  for (const node of nodes.filter((candidate) => candidate.included)) {
    const key = node.relativePath.normalize("NFC").toLowerCase();
    const group = byPortableKey.get(key) ?? [];
    group.push(node);
    byPortableKey.set(key, group);
  }
  for (const group of byPortableKey.values()) {
    if (group.length < 2) continue;
    const names = group.map((node) => node.relativePath).sort(bytewiseCompare).join("、");
    for (const node of group) {
      unsupported.push(unsupportedEntry(node, `相对路径在 Unicode NFC/大小写折叠后冲突：${names}`, true));
    }
  }
}

function enforcePortableLocatorPaths(
  nodes: ScannedSourceNode[],
  files: NovelPreflightFile[],
  unsupported: NovelPreflightUnsupportedEntry[],
): void {
  const invalidPaths = new Set<string>();
  for (const node of nodes.filter((candidate) => candidate.included)) {
    try {
      assertPortableSourceRelativePath(node.relativePath);
    } catch (error) {
      invalidPaths.add(node.relativePath);
      unsupported.push(unsupportedEntry(
        node,
        `相对路径无法表示为安全 locator：${errorMessage(error)}`,
        true,
      ));
    }
  }
  if (!invalidPaths.size) return;
  const validFiles = files.filter((file) => !invalidPaths.has(file.relativePath));
  files.splice(0, files.length, ...validFiles);
}

function aggregateSourceTree(nodes: ScannedSourceNode[]): string {
  const rows = nodes.filter((node) => node.included).map((node) => ({
    relativePath: node.relativePath,
    entryType: node.identity.type,
    byteLength: safeNumber(node.identity.size, `小说来源条目 ${node.relativePath} 的大小`),
    mtimeNs: node.identity.mtimeNs.toString(),
    sha256: node.identity.type === "file" ? (node.contentSha256 ?? null) : node.identity.type === "symlink" ? (node.linkSha256 ?? null) : null,
  })).sort((left, right) => bytewiseCompare(left.relativePath, right.relativePath));
  return sha256(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

async function analyzeRegularFiles(
  nodes: ScannedSourceNode[],
  limits: NovelImportPreflightLimits,
): Promise<{ files: NovelPreflightFile[]; unsupported: NovelPreflightUnsupportedEntry[] }> {
  const files: NovelPreflightFile[] = [];
  const unsupported: NovelPreflightUnsupportedEntry[] = [];
  const regularNodes = nodes.filter((node) => node.included && node.identity.type === "file");
  const supportedNodes = regularNodes.filter((node) => sourceKind(node.relativePath));
  if (supportedNodes.length > limits.maximumSupportedFiles) {
    throw new Error(`小说来源支持格式文件超过 ${limits.maximumSupportedFiles} 个，预检已停止。`);
  }

  for (const node of nodes.filter((candidate) => candidate.included && candidate.identity.type !== "directory")) {
    if (node.identity.type === "symlink") {
      unsupported.push(unsupportedEntry(node, "符号链接不允许作为小说来源，且预检未跟随目标。", true));
      continue;
    }
    if (node.identity.type === "special") {
      unsupported.push(unsupportedEntry(node, "FIFO、socket、device 或其他特殊节点不允许作为小说来源。", true));
      continue;
    }
    if (node.identity.nlink !== 1n) {
      unsupported.push(unsupportedEntry(node, "硬链接不允许作为小说来源。", true));
      continue;
    }
    const byteLength = safeNumber(node.identity.size, `小说来源文件 ${node.relativePath} 的大小`);
    if (byteLength < 1) {
      unsupported.push(unsupportedEntry(node, "零字节文件没有可导入正文。", Boolean(sourceKind(node.relativePath))));
      node.contentSha256 = sha256(Buffer.alloc(0));
      continue;
    }
    if (byteLength > limits.maximumSingleFileBytes) {
      await hashStableRegularFile(node);
      unsupported.push(unsupportedEntry(node, `文件超过 ${limits.maximumSingleFileBytes} 字节单文件上限。`, true));
      continue;
    }

    const kind = sourceKind(node.relativePath);
    const bytes = await readStableRegularFile(node, limits.maximumSingleFileBytes);
    if (!kind) {
      unsupported.push(unsupportedEntry(node, "不支持的普通文件格式；已纳入全树 aggregate，但不会猜测解析。", false));
      continue;
    }

    try {
      const parsed = await parseSupportedSource(node, kind, bytes, limits);
      files.push({
        relativePath: node.relativePath,
        kind,
        byteLength,
        sha256: node.contentSha256!,
        encoding: parsed.encoding,
        charCount: parsed.text.length,
        chapterCount: parsed.chapterCount,
        decodedTextSha256: parsed.decodedTextSha256,
        ...(parsed.docx ? { docx: parsed.docx } : {}),
        warnings: parsed.warnings,
      });
    } catch (error) {
      unsupported.push(unsupportedEntry(node, `支持格式解析失败：${errorMessage(error)}`, true));
    }
  }

  files.sort((left, right) => bytewiseCompare(left.relativePath, right.relativePath));
  unsupported.sort((left, right) => bytewiseCompare(left.relativePath, right.relativePath) || left.reason.localeCompare(right.reason, "zh-CN"));
  return { files, unsupported };
}

function markDuplicateFiles(files: NovelPreflightFile[]): number {
  const firstBySha = new Map<string, string>();
  let duplicates = 0;
  for (const file of files) {
    const first = firstBySha.get(file.sha256);
    if (!first) {
      firstBySha.set(file.sha256, file.relativePath);
      continue;
    }
    file.duplicateOf = first;
    file.warnings.push(duplicateFileWarning(first));
    duplicates += 1;
  }
  return duplicates;
}

function duplicateFileWarning(firstRelativePath: string): string {
  return `内容与 ${firstRelativePath} 完全重复；后续提交必须显式对账。`;
}

async function revalidateSourceTree(nodes: ScannedSourceNode[]): Promise<void> {
  for (const node of nodes) await assertNodeUnchanged(node);
}

/**
 * 对用户选择的单文件或目录执行无副作用预检。函数只做 lstat、realpath、
 * O_NOFOLLOW 读取与隔离 DOCX 解析，不会在源路径创建 sidecar、锁或临时文件。
 */
async function performNovelImportPreflight(
  sourcePathInput: string,
  options: NovelImportPreflightOptions = {},
  expectedSelection?: NovelSourceSelectionGrant,
): Promise<NovelImportPreflight> {
  if (typeof sourcePathInput !== "string" || !sourcePathInput.trim() || sourcePathInput.includes("\0")) {
    throw new Error("小说来源路径无效。");
  }
  if (!path.isAbsolute(sourcePathInput)) throw new Error("小说来源路径必须是绝对路径。");
  const limits = effectiveLimits(options.limits);
  const sourcePath = path.resolve(sourcePathInput);
  const selected = await lstat(sourcePath, { bigint: true });
  const selectedIdentity = freezeIdentity(selected);
  const selectionKind: NovelImportPreflight["selectionKind"] = selected.isDirectory() && !selected.isSymbolicLink()
    ? "directory"
    : "file";
  if (expectedSelection && !selectedPathMatchesGrant(selected, sourcePath, selectionKind, expectedSelection)) {
    throw new Error("小说来源与原生选择票据绑定的稳定身份不一致。");
  }
  const sourceRoot = selectionKind === "directory" ? sourcePath : path.dirname(sourcePath);
  const sourceRootIdentity = await assertCanonicalDirectory(sourceRoot);

  const context: ScanContext = {
    sourceRoot,
    limits,
    nodes: [],
    includedEntries: 0,
    regularFileBytes: 0,
  };
  if (selectionKind === "directory") {
    await scanSourceNode(context, sourcePath, ".", false);
  } else {
    await scanSourceNode(context, sourcePath, portableRelative(path.basename(sourcePath)), true);
  }
  const scannedSelection = context.nodes[0];
  if (!scannedSelection || !sameFrozenIdentity(scannedSelection.identity, selectedIdentity)) {
    throw new Error("小说来源选择项在预检开始时身份已变化。");
  }

  const analyzed = await analyzeRegularFiles(context.nodes, limits);
  enforcePortableLocatorPaths(context.nodes, analyzed.files, analyzed.unsupported);
  addPathConflictReports(context.nodes, analyzed.unsupported);
  analyzed.unsupported.sort((left, right) => bytewiseCompare(left.relativePath, right.relativePath) || left.reason.localeCompare(right.reason, "zh-CN"));
  const duplicateFiles = markDuplicateFiles(analyzed.files);
  await revalidateSourceTree(context.nodes);
  await assertCanonicalDirectory(sourceRoot, sourceRootIdentity);
  if (expectedSelection) {
    const selectedAfter = await lstat(sourcePath, { bigint: true });
    if (!selectedPathMatchesGrant(selectedAfter, sourcePath, selectionKind, expectedSelection)
      || await realpath(sourcePath) !== sourcePath) {
      throw new Error("小说来源在原生选择票据消费与预检完成之间身份已变化。");
    }
  }

  const sourceTreeAggregateSha256 = aggregateSourceTree(context.nodes);
  const fatalEntries = analyzed.unsupported.filter((entry) => entry.fatal);
  const warnings: string[] = [];
  const ignoredFiles = analyzed.unsupported.filter((entry) => entry.entryType === "file" && !entry.fatal).length;
  if (ignoredFiles) warnings.push(`${ignoredFiles} 个不支持的普通文件已纳入全树 aggregate，但不会导入。`);
  if (duplicateFiles) warnings.push(`${duplicateFiles} 个支持格式文件与更早路径内容重复。`);
  if (fatalEntries.length) warnings.push(`${fatalEntries.length} 个 fatal 条目阻止本次预检进入提交阶段。`);
  if (!analyzed.files.length) warnings.push("没有可导入的 TXT、MD、MARKDOWN 或 DOCX 正文。");

  const identityInput = canonicalJson({
    selectionKind,
    sourcePath,
    sourceRoot,
    sourceTreeAggregateSha256,
    chapterSplitAlgorithm: NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM,
    limits,
  });
  const preflightId = `novel-preflight-${sha256(identityInput).slice(0, 24)}`;
  const withoutFingerprint: Omit<NovelImportPreflight, "fingerprint"> = {
    schemaVersion: 1,
    kind: "novel-import-preflight",
    preflightId,
    chapterSplitAlgorithm: NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM,
    selectionKind,
    sourcePath,
    sourceRoot,
    sourceTreeAggregateSha256,
    eligible: analyzed.files.length > 0 && fatalEntries.length === 0,
    limits,
    summary: {
      entries: context.includedEntries,
      supportedFiles: analyzed.files.length,
      unsupportedEntries: analyzed.unsupported.length,
      duplicateFiles,
      byteLength: context.regularFileBytes,
      charCount: analyzed.files.reduce((total, file) => total + file.charCount, 0),
      chapterCount: analyzed.files.reduce((total, file) => total + file.chapterCount, 0),
    },
    files: analyzed.files,
    unsupported: analyzed.unsupported,
    warnings,
  };
  return {
    ...withoutFingerprint,
    fingerprint: sha256(canonicalJson(withoutFingerprint)),
  };
}

export async function preflightNovelImport(
  sourcePathInput: string,
  options: NovelImportPreflightOptions = {},
): Promise<NovelImportPreflight> {
  return performNovelImportPreflight(sourcePathInput, options);
}

/**
 * 桌面主进程应调用此入口：返回可展示的只读预检和只存于当前
 * 服务端进程的 opaque authorization。不合格预检仅返回报告，不签发授权。
 */
export async function createAuthorizedNovelImportPreflight(
  sourcePathInput: string,
  options: NovelImportPreflightOptions = {},
): Promise<AuthorizedNovelImportPreflight> {
  const preflight = await preflightNovelImport(sourcePathInput, options);
  return {
    preflight,
    authorization: preflight.eligible ? issuePreflightAuthorization(preflight) : null,
  };
}

/** Main 的 picker-only 入口：预检首尾都必须绑定一次性 selection grant 的原始身份。 */
export async function createAuthorizedNovelImportPreflightFromSelection(
  selection: NovelSourceSelectionGrant,
  options: NovelImportPreflightOptions = {},
): Promise<AuthorizedNovelImportPreflight> {
  const preflight = await performNovelImportPreflight(selection.sourcePath, options, selection);
  return {
    preflight,
    authorization: preflight.eligible ? issuePreflightAuthorization(preflight) : null,
  };
}

function assertPortableSourceRelativePath(relativePath: string): string[] {
  if (!relativePath || relativePath.includes("\0") || relativePath.includes("\\")
    || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
    || /^[A-Za-z]:/u.test(relativePath)) {
    throw new Error("预检来源 relativePath 必须是使用 / 的相对路径。");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment.trim() || segment === "." || segment === "..")
    || path.posix.normalize(relativePath) !== relativePath) {
    throw new Error("预检来源 relativePath 不得包含空段、. 或 ..。");
  }
  return segments;
}

function samePreflightFile(left: NovelPreflightFile, right: NovelPreflightFile): boolean {
  return left.relativePath === right.relativePath
    && left.kind === right.kind
    && left.byteLength === right.byteLength
    && left.sha256 === right.sha256
    && left.encoding === right.encoding
    && left.charCount === right.charCount
    && left.chapterCount === right.chapterCount
    && left.decodedTextSha256 === right.decodedTextSha256
    && canonicalJson(left.docx) === canonicalJson(right.docx)
    && left.duplicateOf === right.duplicateOf
    && JSON.stringify(left.warnings) === JSON.stringify(right.warnings);
}

/**
 * commit owner 在复制 raw CAS 后使用的只读复验入口。它不信任调用方给出的绝对
 * 路径，也不复用预检时的内存内容；每次从预检 locator 重新冻结并读取源文件，
 * 且必须与预检 byteLength、完整 SHA、编码、字符数和章节数全部一致。
 */
export async function readNovelPreflightSourceForCommit(
  preflight: NovelImportPreflight,
  file: NovelPreflightFile,
): Promise<NovelPreflightSourceRead> {
  if (!preflight || preflight.schemaVersion !== 1 || preflight.kind !== "novel-import-preflight"
    || !path.isAbsolute(preflight.sourcePath) || path.resolve(preflight.sourcePath) !== preflight.sourcePath
    || !path.isAbsolute(preflight.sourceRoot) || path.resolve(preflight.sourceRoot) !== preflight.sourceRoot) {
    throw new Error("小说预检回执的来源路径合同无效。");
  }
  const { fingerprint, ...fingerprintPayload } = preflight;
  if (!/^[a-f0-9]{64}$/u.test(fingerprint) || sha256(canonicalJson(fingerprintPayload)) !== fingerprint) {
    throw new Error("小说预检 fingerprint 与回执内容不一致。");
  }
  if (preflight.eligible !== true || preflight.unsupported.some((entry) => entry.fatal)) {
    throw new Error("小说预检未通过 eligible/fatal 门，禁止进入来源复验。");
  }
  const limits = effectiveLimits(preflight.limits);
  // fingerprint 是完整性摘要而非授权凭据。commit owner 必须先统一重跑并
  // 对账完整预检，再把服务端生成的 preflightId 与 fingerprint 绑定到本批命令上下文；本入口
  // 只逐文件稳定读取，避免 N 个文件触发 N 次全树/DOCX 预检。
  const matchingFiles = preflight.files.filter((candidate) => candidate.relativePath === file.relativePath);
  const recorded = matchingFiles[0];
  if (matchingFiles.length !== 1 || !recorded || !samePreflightFile(recorded, file)) {
    throw new Error("待复验来源文件不属于该预检，或文件元数据已被调用方篡改。");
  }
  if (!/^[a-f0-9]{64}$/u.test(recorded.sha256)
    || !/^[a-f0-9]{64}$/u.test(recorded.decodedTextSha256)
    || !Number.isSafeInteger(recorded.byteLength) || recorded.byteLength < 1
    || !Number.isSafeInteger(recorded.charCount) || recorded.charCount < 1
    || !Number.isSafeInteger(recorded.chapterCount) || recorded.chapterCount < 1) {
    throw new Error("预检来源文件的源 SHA、正文 SHA、字节、字符或章节合同无效。");
  }
  if (recorded.kind === "docx") {
    const docx = recorded.docx;
    if (!docx || docx.outputSha256 !== recorded.decodedTextSha256
      || !Number.isSafeInteger(docx.memberCount) || docx.memberCount < 1 || docx.memberCount > limits.maximumDocxMembers
      || !Number.isSafeInteger(docx.expandedBytes) || docx.expandedBytes < 1 || docx.expandedBytes > limits.maximumDocxExpandedBytes
      || docx.converter?.name !== "mammoth" || docx.converter.contractVersion !== 1
      || typeof docx.converter.version !== "string" || !docx.converter.version.trim() || docx.converter.version.length > 200) {
      throw new Error("预检 DOCX 输出或转换器合同无效。");
    }
  } else if (recorded.docx !== undefined) {
    throw new Error("非 DOCX 预检文件不得携带 DOCX 转换器合同。");
  }
  const segments = assertPortableSourceRelativePath(recorded.relativePath);
  const sourceRootIdentity = await assertCanonicalDirectory(preflight.sourceRoot);
  let absolutePath: string;
  if (preflight.selectionKind === "file") {
    if (path.dirname(preflight.sourcePath) !== preflight.sourceRoot
      || segments.length !== 1 || segments[0] !== path.basename(preflight.sourcePath)) {
      throw new Error("单文件预检的来源根、sourcePath 与 relativePath 不一致。");
    }
    absolutePath = preflight.sourcePath;
  } else if (preflight.selectionKind === "directory") {
    if (preflight.sourcePath !== preflight.sourceRoot) {
      throw new Error("目录预检的 sourcePath 必须等于 sourceRoot。");
    }
    absolutePath = path.resolve(preflight.sourceRoot, ...segments);
    const relative = path.relative(preflight.sourceRoot, absolutePath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("预检来源 relativePath 解析后逃逸 sourceRoot。");
    }
  } else {
    throw new Error("小说预检 selectionKind 无效。");
  }

  if (recorded.byteLength > limits.maximumSingleFileBytes) {
    throw new Error("预检来源文件超过当前回执声明的单文件上限。");
  }
  const context: ScanContext = {
    sourceRoot: preflight.sourceRoot,
    limits,
    nodes: [],
    includedEntries: 0,
    regularFileBytes: 0,
  };
  const currentMetadata = await lstat(absolutePath, { bigint: true });
  if (!currentMetadata.isFile() || currentMetadata.isSymbolicLink() || currentMetadata.nlink !== 1n) {
    throw new Error("预检来源当前已不是单链接普通文件。");
  }
  await scanSourceNode(context, absolutePath, recorded.relativePath, true);
  const node = context.nodes[0];
  if (!node || node.identity.type !== "file" || node.identity.nlink !== 1n) {
    throw new Error("预检来源当前已不是单链接普通文件。");
  }
  const sourceBytes = await readStableRegularFile(node, limits.maximumSingleFileBytes);
  if (sourceBytes.byteLength !== recorded.byteLength || node.contentSha256 !== recorded.sha256) {
    throw new Error("预检来源当前完整字节 SHA 或 byteLength 与预检不一致。");
  }
  const kind = sourceKind(recorded.relativePath);
  if (!kind || kind !== recorded.kind) throw new Error("预检来源扩展名与记录 kind 不一致。");
  const parsed = await parseSupportedSource(node, kind, sourceBytes, limits);
  await assertNodeUnchanged(node);
  await assertCanonicalDirectory(preflight.sourceRoot, sourceRootIdentity);
  if (parsed.encoding !== recorded.encoding
    || parsed.text.length !== recorded.charCount
    || parsed.chapterCount !== recorded.chapterCount
    || parsed.decodedTextSha256 !== recorded.decodedTextSha256
    || canonicalJson(parsed.docx) !== canonicalJson(recorded.docx)
    || JSON.stringify([
      ...parsed.warnings,
      ...(recorded.duplicateOf ? [duplicateFileWarning(recorded.duplicateOf)] : []),
    ]) !== JSON.stringify(recorded.warnings)) {
    throw new Error("预检来源当前解码、正文 SHA、字符数、章节数或 DOCX 转换器合同与预检不一致。");
  }
  return { text: parsed.text, sourceBytes, sha256: node.contentSha256 };
}
