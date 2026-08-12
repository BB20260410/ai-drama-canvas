import { createHash, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export const NOVEL_SOURCE_SELECTION_KINDS = ["file", "directory"] as const;
export type NovelSourceSelectionKind = typeof NOVEL_SOURCE_SELECTION_KINDS[number];

export interface NovelSourceSelectionTicket {
  selectionId: string;
  sourceName: string;
  kind: NovelSourceSelectionKind;
}

export interface NovelSourceSelectionGrant extends NovelSourceSelectionTicket {
  /** 仅限 Main/Core 内部消费，绝不能投影给 renderer。 */
  sourcePath: string;
  identity: Readonly<{
    dev: bigint;
    ino: bigint;
    mode: bigint;
    nlink: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  }>;
}

interface NovelSourceSelectionSession extends NovelSourceSelectionGrant {
  selectionHash: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export const NOVEL_SOURCE_SELECTION_TTL_MS = 5 * 60 * 1_000;
export const NOVEL_SOURCE_SELECTION_CAPACITY = 128;
export const NOVEL_SOURCE_SELECTION_ID_PATTERN = /^novel-source-selection-[A-Za-z0-9_-]{43}$/u;

const SUPPORTED_FILE_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".docx"]);
const selectionSessions = new Map<string, NovelSourceSelectionSession>();

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function freezeIdentity(metadata: BigIntStats): NovelSourceSelectionGrant["identity"] {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  });
}

function sameIdentity(
  left: NovelSourceSelectionGrant["identity"],
  right: NovelSourceSelectionGrant["identity"],
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function requireSelectionKind(value: unknown): NovelSourceSelectionKind {
  if (value !== "file" && value !== "directory") {
    throw new Error("小说来源选择类型必须是 file 或 directory。");
  }
  return value;
}

function pruneExpiredSessions(nowMs: number): void {
  for (const [key, session] of selectionSessions) {
    if (session.expiresAtMs <= nowMs) selectionSessions.delete(key);
  }
}

async function inspectSelectedPath(
  sourcePathInput: string,
  selectionKindInput: NovelSourceSelectionKind,
): Promise<Omit<NovelSourceSelectionGrant, "selectionId">> {
  const kind = requireSelectionKind(selectionKindInput);
  if (typeof sourcePathInput !== "string" || !sourcePathInput || sourcePathInput.includes("\0")
    || !path.isAbsolute(sourcePathInput)) {
    throw new Error("原生小说来源选择结果必须是非空绝对路径。");
  }
  const sourcePath = path.resolve(sourcePathInput);
  const metadata = await lstat(sourcePath, { bigint: true });
  if (metadata.isSymbolicLink() || await realpath(sourcePath) !== sourcePath) {
    throw new Error("小说来源选择必须是无符号链接的规范真实路径。");
  }
  if (kind === "file") {
    if (!metadata.isFile() || metadata.nlink !== 1n) {
      throw new Error("小说文件来源必须是单链接普通文件。");
    }
    if (!SUPPORTED_FILE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
      throw new Error("小说文件来源只允许 TXT、MD、MARKDOWN 或 DOCX。");
    }
  } else if (!metadata.isDirectory()) {
    throw new Error("小说目录来源必须是真实目录。");
  }
  return {
    sourcePath,
    sourceName: path.basename(sourcePath) || "所选目录",
    kind,
    identity: freezeIdentity(metadata),
  };
}

/**
 * 仅允许 Main 在原生 dialog 返回后调用。返回给 renderer 的 DTO 不包含绝对路径、
 * inode 或过期时间；服务端仅按 selectionId 哈希保存短期一次性绑定。
 */
export async function issueNovelSourceSelection(
  sourcePath: string,
  selectionKind: NovelSourceSelectionKind,
): Promise<NovelSourceSelectionTicket> {
  const inspected = await inspectSelectedPath(sourcePath, selectionKind);
  const nowMs = Date.now();
  pruneExpiredSessions(nowMs);
  if (selectionSessions.size >= NOVEL_SOURCE_SELECTION_CAPACITY) {
    throw new Error("小说来源选择票据容量已满，请稍后重新选择。");
  }
  const selectionId = `novel-source-selection-${randomBytes(32).toString("base64url")}`;
  const selectionHash = sha256(selectionId);
  selectionSessions.set(selectionHash, {
    ...inspected,
    selectionId,
    selectionHash,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + NOVEL_SOURCE_SELECTION_TTL_MS,
  });
  return Object.freeze({
    selectionId,
    sourceName: inspected.sourceName,
    kind: inspected.kind,
  });
}

/**
 * 一次性消费：命中后在第一次 await 前删除 session，因而并发或重放最多一方成功；
 * 即使后续路径身份复验失败，票据也不会恢复。
 */
export async function consumeNovelSourceSelection(selectionId: string): Promise<NovelSourceSelectionGrant> {
  if (typeof selectionId !== "string" || !NOVEL_SOURCE_SELECTION_ID_PATTERN.test(selectionId)) {
    throw new Error("小说来源 selectionId 无效、过期或已消费。");
  }
  const nowMs = Date.now();
  pruneExpiredSessions(nowMs);
  const selectionHash = sha256(selectionId);
  const session = selectionSessions.get(selectionHash);
  if (!session || session.selectionHash !== selectionHash || session.selectionId !== selectionId
    || session.expiresAtMs <= nowMs) {
    throw new Error("小说来源 selectionId 无效、过期或已消费。");
  }
  // 原子消费点：JS 同一事件循环中先删除，再开始任何文件系统 await。
  selectionSessions.delete(selectionHash);
  const current = await inspectSelectedPath(session.sourcePath, session.kind);
  if (current.sourcePath !== session.sourcePath || current.sourceName !== session.sourceName
    || current.kind !== session.kind || !sameIdentity(current.identity, session.identity)) {
    throw new Error("小说来源自原生选择后身份已变化，selectionId 已作废。");
  }
  return Object.freeze({
    selectionId: session.selectionId,
    sourceName: session.sourceName,
    kind: session.kind,
    sourcePath: session.sourcePath,
    identity: session.identity,
  });
}

/** 仅测试环境可用，避免跨 case 泄漏进程内短期票据。 */
export function resetNovelSourceSelectionsForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("只允许在测试环境清理小说来源选择票据。");
  selectionSessions.clear();
}
