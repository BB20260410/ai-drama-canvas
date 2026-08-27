import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  ensureConfinedDirectory,
  inspectExistingConfinedDirectory,
  moveConfinedDirectoryNoReplace,
  persistConfinedBytesNoReplace,
  readConfinedRegularFileWithIdentity,
  replaceConfinedBytesCas,
} from "./confined-project-storage.js";
import { searchProjectContext } from "./memory.js";
import { parseNovelDocxIsolated } from "./novel-docx.js";
import { appendEvent, getSidecarPaths, loadIndex, loadProjectConfig, readJson, writeJsonAtomic, writeTextAtomic } from "./sidecar.js";
import type {
  ProjectIndex,
  StoryChapter,
  StoryChapterContent,
  StoryContextBundle,
  StoryEvent,
  StoryEventGraph,
  StoryEventStatus,
  StoryLibrary,
  StorySource,
  StorySourceKind,
} from "./types.js";
import { withProjectLock } from "./locks.js";

const MAX_SOURCE_BYTES = 50_000_000;
const MAX_TEXT_CHARS = 10_000_000;
const CHAPTER_TARGET_CHARS = 12_000;
const STORY_LIBRARY_V2_KIND = "ai-canvas-story-library" as const;
const STORY_MIGRATION_RECEIPT_KIND = "story-library-v1-to-v2-receipt" as const;
const STORY_MIGRATION_MAX_FILE_BYTES = 100_000_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface StorySourceV2 extends Omit<StorySource, "id" | "originalPath" | "snapshotPath" | "chapterIds"> {
  id: string;
  legacyId: string;
  originalLocator: string;
  snapshotLocator: string;
  chapterIds: string[];
}

interface StoryChapterV2 extends Omit<StoryChapter, "id" | "sourceId" | "path"> {
  id: string;
  legacyId: string;
  sourceId: string;
  locator: string;
}

interface StoryLibraryV2 {
  schemaVersion: 2;
  kind: typeof STORY_LIBRARY_V2_KIND;
  revision: number;
  sources: StorySourceV2[];
  chapters: StoryChapterV2[];
  updatedAt: string;
  migration: {
    receiptLocator: string;
    sourceIndexSha256: string;
    migratedAt: string;
  };
}

export interface StoryV1ToV2MigrationReceipt {
  schemaVersion: 1;
  kind: typeof STORY_MIGRATION_RECEIPT_KIND;
  migrationId: string;
  projectId: string;
  sourceIndexSha256: string;
  targetIndexSha256: string;
  targetIndexLocator: string;
  mirrorLocator: string;
  receiptLocator: string;
  mappings: {
    sources: Array<{ legacyId: string; stableId: string }>;
    chapters: Array<{ legacyId: string; stableId: string; legacySourceId: string; stableSourceId: string }>;
  };
  files: Array<{
    role: "source-original" | "source-snapshot" | "chapter" | "story-index" | "story-events" | "target-index";
    legacyId?: string;
    locator: string;
    sha256: string;
    byteLength: number;
  }>;
  preparedAt: string;
  commit: {
    method: "inode-sha256-cas";
    authoritativeIndexLocator: ".aicanvas/story/index.json";
  };
  fingerprint: string;
}

export interface StoryV1ToV2MigrationResult {
  status: "migrated" | "already_migrated";
  receipt: StoryV1ToV2MigrationReceipt;
  library: StoryLibraryV2;
}

interface LoadedStoryLibrary {
  library: StoryLibrary;
  schemaVersion: 1 | 2;
  legacyChapterIdToStableId: Map<string, string>;
}

interface StableFileRead {
  bytes: Buffer;
  sha256: string;
}

interface FrozenExternalSource extends StableFileRead {
  absolutePath: string;
  canonicalPath: string;
  identity: {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
    nlink: bigint;
  };
}

interface StoryMigrationTestHooks {
  afterExternalSourceFreeze?: (input: { sourceId: string; sourcePath: string }) => void | Promise<void>;
  afterLibraryIndexFreeze?: (input: { indexPath: string; schemaVersion: 1 | 2 }) => void | Promise<void>;
  afterLegacyStoryEvidenceFreeze?: (input: { indexPath: string }) => void | Promise<void>;
  beforePublish?: (input: { stagingRoot: string; finalRoot: string }) => void | Promise<void>;
}

let storyMigrationTestHooks: StoryMigrationTestHooks = {};

/** 仅供 Vitest 确定性复现外部原稿和发布目标竞态；产品环境拒绝安装 hook。 */
export function __setStoryMigrationTestHooksForTests(hooks: StoryMigrationTestHooks): () => void {
  if (process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") {
    throw new Error("story migration test hook 只能在测试环境使用。");
  }
  storyMigrationTestHooks = hooks;
  return () => {
    if (storyMigrationTestHooks === hooks) storyMigrationTestHooks = {};
  };
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (recordValue(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function storyFingerprint(value: unknown): string {
  return sha256(stableJson(value));
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertStoryLocator(locator: string, label: string): string {
  if (!locator || locator.includes("\0") || locator.includes("\\") || path.posix.isAbsolute(locator)
    || /^[A-Za-z]:/u.test(locator)) {
    throw new Error(`${label} 必须是项目内 / 分隔的相对 locator。`);
  }
  const segments = locator.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} 含空段、. 或 ..，已停止读取。`);
  }
  return locator;
}

function storyLocator(projectRoot: string, absolutePath: string): string {
  const relative = path.relative(projectRoot, absolutePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`迁移文件越出项目根：${absolutePath}`);
  }
  return assertStoryLocator(relative.split(path.sep).join("/"), "迁移 locator");
}

async function resolveConfinedStoryLocator(projectRoot: string, locator: string, label: string): Promise<string> {
  const normalized = assertStoryLocator(locator, label);
  const root = await realpath(projectRoot);
  const candidate = path.resolve(root, ...normalized.split("/"));
  if (!isWithin(candidate, root)) throw new Error(`${label} 逃逸项目根。`);
  const directory = await inspectExistingConfinedDirectory(root, path.dirname(candidate));
  const read = await readConfinedRegularFileWithIdentity(directory, path.basename(candidate), STORY_MIGRATION_MAX_FILE_BYTES);
  if (read.nlink !== 1) throw new Error(`${label} 必须是单链接普通文件。`);
  return path.join(directory.directory, read.identity.name);
}

async function readStableProjectFile(
  projectRoot: string,
  filePath: string,
  label: string,
  maximumBytes = STORY_MIGRATION_MAX_FILE_BYTES,
): Promise<StableFileRead & { absolutePath: string; identity: Awaited<ReturnType<typeof readConfinedRegularFileWithIdentity>>["identity"] }> {
  const requestedRoot = path.resolve(projectRoot);
  const root = await realpath(requestedRoot);
  const requestedCandidate = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(requestedRoot, filePath);
  const candidate = isWithin(requestedCandidate, requestedRoot)
    ? path.resolve(root, path.relative(requestedRoot, requestedCandidate))
    : requestedCandidate;
  const metadata = await lstat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} 必须是无符号链接的普通文件。`);
  const canonical = await realpath(candidate);
  if (!isWithin(canonical, root)) throw new Error(`${label} 真实路径越出项目根，迁移已停止。`);
  const directory = await inspectExistingConfinedDirectory(root, path.dirname(candidate));
  const read = await readConfinedRegularFileWithIdentity(directory, path.basename(candidate), maximumBytes);
  if (read.nlink !== 1) throw new Error(`${label} 必须是单链接普通文件。`);
  return {
    bytes: read.bytes,
    sha256: sha256(read.bytes),
    absolutePath: path.join(directory.directory, read.identity.name),
    identity: read.identity,
  };
}

function sameExternalIdentity(
  left: FrozenExternalSource["identity"],
  right: FrozenExternalSource["identity"],
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink;
}

/**
 * legacy originalPath 可以位于项目外，但只能经规范绝对路径、O_NOFOLLOW 和
 * fd/path 双重身份冻结读取。snapshot/chapter 不调用此函数，仍走项目内 confinement。
 */
async function readStableExternalStorySource(
  filePath: string,
  label: string,
  maximumBytes = MAX_SOURCE_BYTES,
): Promise<FrozenExternalSource> {
  if (!path.isAbsolute(filePath) || filePath.includes("\0")) {
    throw new Error(`${label} 必须是规范绝对路径。`);
  }
  const absolutePath = path.resolve(filePath);
  const pathBefore = await lstat(absolutePath, { bigint: true });
  const canonicalBefore = await realpath(absolutePath);
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1n
    || pathBefore.size < 1n || pathBefore.size > BigInt(maximumBytes)
    || canonicalBefore !== absolutePath) {
    throw new Error(`${label} 必须是规范绝对路径上的单链接非空普通文件。`);
  }
  const expectedIdentity: FrozenExternalSource["identity"] = {
    dev: pathBefore.dev,
    ino: pathBefore.ino,
    size: pathBefore.size,
    mtimeNs: pathBefore.mtimeNs,
    ctimeNs: pathBefore.ctimeNs,
    nlink: pathBefore.nlink,
  };
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fdBefore = await handle.stat({ bigint: true });
    const fdBeforeIdentity: FrozenExternalSource["identity"] = {
      dev: fdBefore.dev,
      ino: fdBefore.ino,
      size: fdBefore.size,
      mtimeNs: fdBefore.mtimeNs,
      ctimeNs: fdBefore.ctimeNs,
      nlink: fdBefore.nlink,
    };
    if (!fdBefore.isFile() || !sameExternalIdentity(expectedIdentity, fdBeforeIdentity)) {
      throw new Error(`${label} 路径与 O_NOFOLLOW fd 身份不一致。`);
    }
    const bytes = await handle.readFile();
    const fdAfter = await handle.stat({ bigint: true });
    const fdAfterIdentity: FrozenExternalSource["identity"] = {
      dev: fdAfter.dev,
      ino: fdAfter.ino,
      size: fdAfter.size,
      mtimeNs: fdAfter.mtimeNs,
      ctimeNs: fdAfter.ctimeNs,
      nlink: fdAfter.nlink,
    };
    const pathAfter = await lstat(absolutePath, { bigint: true });
    const pathAfterIdentity: FrozenExternalSource["identity"] = {
      dev: pathAfter.dev,
      ino: pathAfter.ino,
      size: pathAfter.size,
      mtimeNs: pathAfter.mtimeNs,
      ctimeNs: pathAfter.ctimeNs,
      nlink: pathAfter.nlink,
    };
    const canonicalAfter = await realpath(absolutePath);
    if (!fdAfter.isFile() || !pathAfter.isFile() || pathAfter.isSymbolicLink()
      || !sameExternalIdentity(expectedIdentity, fdAfterIdentity)
      || !sameExternalIdentity(expectedIdentity, pathAfterIdentity)
      || canonicalAfter !== canonicalBefore
      || bytes.byteLength !== Number(expectedIdentity.size)) {
      throw new Error(`${label} 在冻结只读复制期间发生替换或修改。`);
    }
    return {
      bytes,
      sha256: sha256(bytes),
      absolutePath,
      canonicalPath: canonicalBefore,
      identity: expectedIdentity,
    };
  } finally {
    await handle.close();
  }
}

function assertSameFrozenExternalSource(
  before: FrozenExternalSource,
  after: FrozenExternalSource,
  label: string,
): void {
  if (before.absolutePath !== after.absolutePath
    || before.canonicalPath !== after.canonicalPath
    || !sameExternalIdentity(before.identity, after.identity)
    || before.sha256 !== after.sha256
    || !before.bytes.equals(after.bytes)) {
    throw new Error(`${label} 在迁移复制期间身份或内容已变化。`);
  }
}

async function persistMigrationFile(projectRoot: string, filePath: string, bytes: Buffer): Promise<StableFileRead> {
  const directory = await ensureConfinedDirectory(projectRoot, path.dirname(filePath));
  const persisted = await persistConfinedBytesNoReplace(directory, path.basename(filePath), bytes, 0o600);
  if (persisted.sha256 !== sha256(bytes) || persisted.size !== bytes.byteLength) {
    throw new Error(`迁移镜像写入回执不一致：${filePath}`);
  }
  return { bytes, sha256: persisted.sha256 };
}

function decodeLegacyStoryText(bytes: Buffer, label: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} 不是有效 UTF-8，迁移已停止。`, { cause: error });
  }
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function parseStoryLibraryV2(value: unknown, filePath: string): StoryLibraryV2 {
  if (!recordValue(value)
    || value.schemaVersion !== 2
    || value.kind !== STORY_LIBRARY_V2_KIND
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || typeof value.updatedAt !== "string"
    || !Array.isArray(value.sources)
    || !Array.isArray(value.chapters)
    || !recordValue(value.migration)
    || typeof value.migration.receiptLocator !== "string"
    || typeof value.migration.sourceIndexSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.migration.sourceIndexSha256)
    || typeof value.migration.migratedAt !== "string") {
    throw new Error(`story v2 索引结构无效，已停止读取：${filePath}`);
  }
  const sources = value.sources as unknown[];
  const chapters = value.chapters as unknown[];
  for (const [index, candidate] of sources.entries()) {
    if (!recordValue(candidate)
      || typeof candidate.id !== "string" || !UUID_PATTERN.test(candidate.id)
      || typeof candidate.legacyId !== "string" || !candidate.legacyId
      || typeof candidate.title !== "string"
      || typeof candidate.originalLocator !== "string"
      || typeof candidate.snapshotLocator !== "string"
      || !["text", "markdown", "docx"].includes(String(candidate.kind))
      || !["utf-8", "gb18030", "docx"].includes(String(candidate.encoding))
      || ((candidate.kind === "docx") !== (candidate.encoding === "docx"))
      || typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.sha256)
      || !Number.isSafeInteger(candidate.size) || Number(candidate.size) < 0
      || !Number.isSafeInteger(candidate.charCount) || Number(candidate.charCount) < 0
      || !Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 1
      || typeof candidate.importedAt !== "string" || typeof candidate.updatedAt !== "string"
      || !Array.isArray(candidate.chapterIds) || !candidate.chapterIds.every((entry) => typeof entry === "string" && UUID_PATTERN.test(entry))) {
      throw new Error(`story v2 source[${index}] 结构无效：${filePath}`);
    }
    assertStoryLocator(candidate.originalLocator, `story v2 source[${index}].originalLocator`);
    assertStoryLocator(candidate.snapshotLocator, `story v2 source[${index}].snapshotLocator`);
  }
  for (const [index, candidate] of chapters.entries()) {
    if (!recordValue(candidate)
      || typeof candidate.id !== "string" || !UUID_PATTERN.test(candidate.id)
      || typeof candidate.legacyId !== "string" || !candidate.legacyId
      || typeof candidate.sourceId !== "string" || !UUID_PATTERN.test(candidate.sourceId)
      || typeof candidate.title !== "string"
      || typeof candidate.locator !== "string"
      || typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.sha256)
      || !Number.isSafeInteger(candidate.index) || Number(candidate.index) < 1
      || !Number.isSafeInteger(candidate.charCount) || Number(candidate.charCount) < 0
      || !Number.isSafeInteger(candidate.startOffset) || Number(candidate.startOffset) < 0
      || !Number.isSafeInteger(candidate.endOffset) || Number(candidate.endOffset) < Number(candidate.startOffset)
      || !Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 1
      || typeof candidate.createdAt !== "string" || typeof candidate.updatedAt !== "string") {
      throw new Error(`story v2 chapter[${index}] 结构无效：${filePath}`);
    }
    assertStoryLocator(candidate.locator, `story v2 chapter[${index}].locator`);
  }
  assertStoryLocator(value.migration.receiptLocator, "story v2 migration.receiptLocator");
  const library = value as unknown as StoryLibraryV2;
  const sourceIds = new Set(library.sources.map((source) => source.id));
  const legacySourceIds = new Set(library.sources.map((source) => source.legacyId));
  const chapterIds = new Set(library.chapters.map((chapter) => chapter.id));
  const legacyChapterIds = new Set(library.chapters.map((chapter) => chapter.legacyId));
  if (sourceIds.size !== library.sources.length || legacySourceIds.size !== library.sources.length
    || chapterIds.size !== library.chapters.length || legacyChapterIds.size !== library.chapters.length) {
    throw new Error(`story v2 索引含重复稳定或 legacy ID：${filePath}`);
  }
  for (const chapter of library.chapters) {
    if (!sourceIds.has(chapter.sourceId)) throw new Error(`story v2 章节引用不存在来源：${chapter.id}`);
  }
  for (const source of library.sources) {
    if (source.chapterIds.some((id) => !chapterIds.has(id))) throw new Error(`story v2 来源引用不存在章节：${source.id}`);
    const expected = library.chapters
      .filter((chapter) => chapter.sourceId === source.id)
      .sort((left, right) => left.index - right.index)
      .map((chapter) => chapter.id);
    if (expected.length !== source.chapterIds.length
      || source.chapterIds.some((chapterId, index) => chapterId !== expected[index])) {
      throw new Error(`story v2 来源章节顺序与章节表不一致：${source.id}`);
    }
  }
  return library;
}

function parseStoryMigrationReceipt(value: unknown, filePath: string): StoryV1ToV2MigrationReceipt {
  if (!recordValue(value)
    || value.schemaVersion !== 1
    || value.kind !== STORY_MIGRATION_RECEIPT_KIND
    || typeof value.migrationId !== "string"
    || typeof value.projectId !== "string" || !value.projectId
    || typeof value.sourceIndexSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sourceIndexSha256)
    || typeof value.targetIndexSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.targetIndexSha256)
    || typeof value.targetIndexLocator !== "string"
    || typeof value.mirrorLocator !== "string"
    || typeof value.receiptLocator !== "string"
    || !recordValue(value.mappings)
    || !Array.isArray(value.mappings.sources)
    || !Array.isArray(value.mappings.chapters)
    || !Array.isArray(value.files)
    || typeof value.preparedAt !== "string"
    || !recordValue(value.commit)
    || value.commit.method !== "inode-sha256-cas"
    || value.commit.authoritativeIndexLocator !== ".aicanvas/story/index.json"
    || typeof value.fingerprint !== "string") {
    throw new Error(`story 迁移回执结构无效：${filePath}`);
  }
  const receipt = value as unknown as StoryV1ToV2MigrationReceipt;
  assertStoryLocator(receipt.targetIndexLocator, "story 迁移 targetIndexLocator");
  assertStoryLocator(receipt.mirrorLocator, "story 迁移 mirrorLocator");
  assertStoryLocator(receipt.receiptLocator, "story 迁移 receiptLocator");
  for (const [index, mapping] of receipt.mappings.sources.entries()) {
    if (!mapping || typeof mapping.legacyId !== "string" || !mapping.legacyId
      || typeof mapping.stableId !== "string" || !UUID_PATTERN.test(mapping.stableId)) {
      throw new Error(`story 迁移来源映射[${index}] 无效：${filePath}`);
    }
  }
  for (const [index, mapping] of receipt.mappings.chapters.entries()) {
    if (!mapping || typeof mapping.legacyId !== "string" || !mapping.legacyId
      || typeof mapping.stableId !== "string" || !UUID_PATTERN.test(mapping.stableId)
      || typeof mapping.legacySourceId !== "string" || !mapping.legacySourceId
      || typeof mapping.stableSourceId !== "string" || !UUID_PATTERN.test(mapping.stableSourceId)) {
      throw new Error(`story 迁移章节映射[${index}] 无效：${filePath}`);
    }
  }
  for (const [index, file] of receipt.files.entries()) {
    if (!file || !["source-original", "source-snapshot", "chapter", "story-index", "story-events", "target-index"].includes(file.role)
      || typeof file.locator !== "string"
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256)
      || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0) {
      throw new Error(`story 迁移文件回执[${index}] 无效：${filePath}`);
    }
    assertStoryLocator(file.locator, `story 迁移文件回执[${index}].locator`);
  }
  const { fingerprint, ...semantic } = receipt;
  if (fingerprint !== storyFingerprint(semantic)) throw new Error(`story 迁移回执 fingerprint 不一致：${filePath}`);
  return receipt;
}

interface MigrationClosureInput {
  projectRoot: string;
  projectId: string;
  library: StoryLibraryV2;
  receipt: StoryV1ToV2MigrationReceipt;
  targetIndexBytes: Buffer;
  physicalMigrationRoot: string;
}

interface ExpectedMigrationFile {
  role: StoryV1ToV2MigrationReceipt["files"][number]["role"];
  legacyId?: string;
}

type StableProjectFileRead = Awaited<ReturnType<typeof readStableProjectFile>>;

class StoryChapterEvidenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoryChapterEvidenceError";
  }
}

function parseClosureJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} JSON 已损坏。`, { cause: error });
  }
}

function sameSemanticFields(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

/**
 * receipt 中的 SHA/长度只能证明“文件与回执自洽”，不能证明它们仍是
 * v2 library 声明的原稿、快照和章节。这里把镜像 v1 index、mapping、v2 index
 * 与每个物理 artifact 的语义内容再次闭合，防止攻击者改文件后重算
 * receipt fingerprint 就被当成有效迁移。
 */
async function validateMigrationSemanticClosure(input: {
  library: StoryLibraryV2;
  receipt: StoryV1ToV2MigrationReceipt;
  readsByLocator: Map<string, StableProjectFileRead>;
  physicalPathsByLocator: Map<string, string>;
}): Promise<void> {
  const { library, receipt, readsByLocator, physicalPathsByLocator } = input;
  const fileFor = (
    role: StoryV1ToV2MigrationReceipt["files"][number]["role"],
    legacyId?: string,
  ): StoryV1ToV2MigrationReceipt["files"][number] => {
    const file = receipt.files.find((candidate) => candidate.role === role && candidate.legacyId === legacyId);
    if (!file) throw new Error(`story 迁移语义闭包缺少 ${role}:${legacyId ?? ""}。`);
    return file;
  };
  const readFor = (file: StoryV1ToV2MigrationReceipt["files"][number]): StableProjectFileRead => {
    const read = readsByLocator.get(file.locator);
    if (!read) throw new Error(`story 迁移语义闭包缺少已冻结文件：${file.locator}`);
    return read;
  };

  const legacyIndexFile = fileFor("story-index");
  const legacy = parseStoryLibraryV1(
    parseClosureJson(readFor(legacyIndexFile).bytes, "story 迁移镜像 v1 index"),
    legacyIndexFile.locator,
  );
  if (library.revision !== legacy.revision + 1
    || library.updatedAt !== library.migration.migratedAt
    || receipt.preparedAt !== library.migration.migratedAt) {
    throw new Error("story 迁移语义闭包的修订或迁移时间未绑定 v1/v2 index。");
  }

  const sourceMappingByLegacy = new Map(receipt.mappings.sources.map((mapping) => [mapping.legacyId, mapping]));
  const chapterMappingByLegacy = new Map(receipt.mappings.chapters.map((mapping) => [mapping.legacyId, mapping]));
  const legacySourceById = new Map(legacy.sources.map((source) => [source.id, source]));
  const legacyChapterById = new Map(legacy.chapters.map((chapter) => [chapter.id, chapter]));
  const snapshotTexts = new Map<string, string>();

  for (const source of library.sources) {
    const legacySource = legacySourceById.get(source.legacyId);
    const sourceMapping = sourceMappingByLegacy.get(source.legacyId);
    if (!legacySource || sourceMapping?.stableId !== source.id) {
      throw new Error(`story 迁移语义闭包无法反向解析来源：${source.legacyId}`);
    }
    const mappedChapterIds = legacySource.chapterIds.map((legacyChapterId) => chapterMappingByLegacy.get(legacyChapterId)?.stableId);
    if (mappedChapterIds.some((id) => !id)
      || !sameSemanticFields(mappedChapterIds, source.chapterIds)
      || !sameSemanticFields({
        title: legacySource.title,
        kind: legacySource.kind,
        encoding: legacySource.encoding,
        sha256: legacySource.sha256,
        size: legacySource.size,
        charCount: legacySource.charCount,
        revision: legacySource.revision,
        importedAt: legacySource.importedAt,
        updatedAt: legacySource.updatedAt,
      }, {
        title: source.title,
        kind: source.kind,
        encoding: source.encoding,
        sha256: source.sha256,
        size: source.size,
        charCount: source.charCount,
        revision: source.revision,
        importedAt: source.importedAt,
        updatedAt: source.updatedAt,
      })) {
      throw new Error(`story 迁移语义闭包的 v1/v2 来源元数据不一致：${source.legacyId}`);
    }

    const snapshotFile = fileFor("source-snapshot", source.legacyId);
    const snapshotRead = readFor(snapshotFile);
    const snapshotText = decodeLegacyStoryText(snapshotRead.bytes, `story 迁移来源快照 ${source.legacyId}`);
    if (sha256(snapshotText) !== source.sha256 || snapshotText.length !== source.charCount) {
      throw new Error(`story 迁移来源快照未语义绑定 v2 library：${source.legacyId}`);
    }
    snapshotTexts.set(source.id, snapshotText);

    const originalFile = fileFor("source-original", source.legacyId);
    const originalRead = readFor(originalFile);
    if (legacySource.originalPath.startsWith("aicanvas://pasted/")) {
      if (!originalRead.bytes.equals(snapshotRead.bytes)
        || source.size !== Buffer.byteLength(snapshotText, "utf8")) {
        throw new Error(`story 迁移粘贴原稿未绑定来源快照：${source.legacyId}`);
      }
    } else {
      if (originalRead.bytes.byteLength !== source.size) {
        throw new Error(`story 迁移原稿字节数未绑定 v2 library：${source.legacyId}`);
      }
      if (source.kind === "docx") {
        if (source.encoding !== "docx") throw new Error(`story 迁移 DOCX 类型/编码不一致：${source.legacyId}`);
        const physicalPath = physicalPathsByLocator.get(originalFile.locator);
        if (!physicalPath) throw new Error(`story 迁移 DOCX 物理路径缺失：${source.legacyId}`);
        const parsed = await parseNovelDocxIsolated(physicalPath, {
          maximumFileBytes: Math.min(MAX_SOURCE_BYTES, originalRead.bytes.byteLength),
          maximumOutputChars: MAX_TEXT_CHARS,
        });
        if (parsed.sourceSha256 !== originalRead.sha256
          || sha256(normalizeText(parsed.text)) !== source.sha256) {
          throw new Error(`story 迁移 DOCX 原稿未语义绑定 v2 library：${source.legacyId}`);
        }
      } else {
        if (source.encoding === "docx") throw new Error(`story 迁移文本类型/编码不一致：${source.legacyId}`);
        let decoded: string;
        try {
          decoded = source.encoding === "gb18030"
            ? new TextDecoder("gb18030").decode(originalRead.bytes)
            : new TextDecoder("utf-8", { fatal: true }).decode(originalRead.bytes);
        } catch (error) {
          throw new Error(`story 迁移文本原稿解码失败：${source.legacyId}`, { cause: error });
        }
        if (sha256(normalizeText(decoded)) !== source.sha256) {
          throw new Error(`story 迁移文本原稿未语义绑定 v2 library：${source.legacyId}`);
        }
      }
    }
  }

  for (const chapter of library.chapters) {
    try {
      const legacyChapter = legacyChapterById.get(chapter.legacyId);
      const mapping = chapterMappingByLegacy.get(chapter.legacyId);
      const source = library.sources.find((candidate) => candidate.id === chapter.sourceId);
      if (!legacyChapter || !mapping || !source
        || mapping.stableId !== chapter.id
        || mapping.legacySourceId !== legacyChapter.sourceId
        || mapping.stableSourceId !== chapter.sourceId
        || legacyChapter.sourceId !== source.legacyId
        || !sameSemanticFields({
          index: legacyChapter.index,
          title: legacyChapter.title,
          charCount: legacyChapter.charCount,
          sha256: legacyChapter.sha256,
          startOffset: legacyChapter.startOffset,
          endOffset: legacyChapter.endOffset,
          revision: legacyChapter.revision,
          createdAt: legacyChapter.createdAt,
          updatedAt: legacyChapter.updatedAt,
        }, {
          index: chapter.index,
          title: chapter.title,
          charCount: chapter.charCount,
          sha256: chapter.sha256,
          startOffset: chapter.startOffset,
          endOffset: chapter.endOffset,
          revision: chapter.revision,
          createdAt: chapter.createdAt,
          updatedAt: chapter.updatedAt,
        })) {
        throw new Error("story 迁移语义闭包的 v1/v2 章节元数据不一致。");
      }
      const chapterRead = readFor(fileFor("chapter", chapter.legacyId));
      const chapterText = decodeLegacyStoryText(chapterRead.bytes, "story 迁移章节");
      const sourceText = snapshotTexts.get(chapter.sourceId);
      if (sourceText === undefined
        || sha256(chapterText) !== chapter.sha256
        || chapterText.length !== chapter.charCount
        || chapter.endOffset > sourceText.length
        || sourceText.slice(chapter.startOffset, chapter.endOffset).trim() !== chapterText) {
        throw new Error("story 迁移章节未语义绑定来源快照/v2 library。");
      }
    } catch (error) {
      if (error instanceof StoryChapterEvidenceError) throw error;
      throw new StoryChapterEvidenceError("story 迁移章节未语义绑定来源快照。", { cause: error });
    }
  }

  const storyEventsFile = receipt.files.find((file) => file.role === "story-events");
  if (storyEventsFile) {
    validateStoryEventGraphForMigration(
      parseClosureJson(readFor(storyEventsFile).bytes, "story 迁移镜像事件图"),
      new Set(legacy.chapters.map((chapter) => chapter.id)),
      storyEventsFile.locator,
    );
  }
}

async function listStableMigrationFiles(
  projectRoot: string,
  physicalMigrationRoot: string,
): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directoryPath: string, relativeDirectory: string): Promise<void> => {
    const identityBefore = await inspectExistingConfinedDirectory(projectRoot, directoryPath);
    const metadataBefore = await lstat(directoryPath, { bigint: true });
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name || entry.name === "." || entry.name === "..") throw new Error("story 迁移闭包含无效文件名。");
      const childPath = path.join(directoryPath, entry.name);
      const childMetadata = await lstat(childPath, { bigint: true });
      if (childMetadata.isSymbolicLink()) throw new Error("story 迁移闭包物理树包含符号链接。");
      const relative = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
      if (childMetadata.isDirectory()) {
        await walk(childPath, relative);
      } else if (childMetadata.isFile()) {
        files.push(relative);
      } else {
        throw new Error("story 迁移闭包物理树包含特殊文件。");
      }
    }
    const identityAfter = await inspectExistingConfinedDirectory(projectRoot, directoryPath);
    const metadataAfter = await lstat(directoryPath, { bigint: true });
    if (identityBefore.dev !== identityAfter.dev || identityBefore.ino !== identityAfter.ino
      || identityBefore.canonicalDirectory !== identityAfter.canonicalDirectory
      || metadataBefore.dev !== metadataAfter.dev || metadataBefore.ino !== metadataAfter.ino
      || metadataBefore.mtimeNs !== metadataAfter.mtimeNs || metadataBefore.ctimeNs !== metadataAfter.ctimeNs) {
      throw new Error("story 迁移闭包物理目录在枚举期间发生变化。");
    }
  };
  await walk(physicalMigrationRoot, "");
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

/**
 * story v2 的唯一闭包验证入口。逻辑 locator 永远绑定正式 migration namespace；
 * physicalMigrationRoot 仅允许在首次发布前把同一闭包映射到受管 staging 目录。
 */
async function validateMigrationClosure(input: MigrationClosureInput): Promise<void> {
  const { projectRoot, projectId, library, receipt, targetIndexBytes } = input;
  if (!/^story-migration-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(receipt.migrationId)) {
    throw new Error("story 迁移闭包 migrationId 无效。");
  }
  if (receipt.projectId !== projectId) throw new Error("story 迁移闭包 projectId 与当前项目不一致。");

  const paths = getSidecarPaths(projectRoot);
  const migrationRoot = path.join(paths.storyMigrations, receipt.migrationId);
  const stagingMigrationRoot = path.join(paths.storyMigrationStaging, receipt.migrationId);
  const physicalMigrationRoot = path.resolve(input.physicalMigrationRoot);
  if (physicalMigrationRoot !== path.resolve(migrationRoot)
    && physicalMigrationRoot !== path.resolve(stagingMigrationRoot)) {
    throw new Error("story 迁移闭包物理根未绑定 migrationId。");
  }
  const migrationNamespace = storyLocator(projectRoot, migrationRoot);
  const expectedMirrorLocator = path.posix.join(migrationNamespace, "mirror");
  const expectedReceiptLocator = path.posix.join(migrationNamespace, "receipt.json");
  const expectedTargetIndexLocator = path.posix.join(migrationNamespace, "target/story-index-v2.json");
  if (receipt.mirrorLocator !== expectedMirrorLocator
    || receipt.receiptLocator !== expectedReceiptLocator
    || receipt.targetIndexLocator !== expectedTargetIndexLocator
    || library.migration.receiptLocator !== expectedReceiptLocator
    || library.migration.sourceIndexSha256 !== receipt.sourceIndexSha256) {
    throw new Error("story 迁移闭包命名空间、receipt 或 source index 绑定不一致。");
  }
  await inspectExistingConfinedDirectory(projectRoot, physicalMigrationRoot);
  const physicalReceiptPath = path.join(physicalMigrationRoot, "receipt.json");
  const physicalReceiptRead = await readStableProjectFile(projectRoot, physicalReceiptPath, "story 迁移闭包 receipt");
  const physicalReceipt = parseStoryMigrationReceipt(
    JSON.parse(physicalReceiptRead.bytes.toString("utf8")) as unknown,
    physicalReceiptPath,
  );
  if (stableJson(physicalReceipt) !== stableJson(receipt)) {
    throw new Error("story 迁移闭包 receipt 与当前物理命名空间不一致。");
  }
  const targetIndexSha256 = sha256(targetIndexBytes);
  if (receipt.targetIndexSha256 !== targetIndexSha256) {
    throw new Error("story 迁移闭包 target index SHA 不一致。");
  }
  let parsedTarget: StoryLibraryV2;
  try {
    parsedTarget = parseStoryLibraryV2(JSON.parse(targetIndexBytes.toString("utf8")) as unknown, receipt.targetIndexLocator);
  } catch (error) {
    throw new Error("story 迁移闭包 target index 无法按 v2 往返解析。", { cause: error });
  }
  if (stableJson(parsedTarget) !== stableJson(library)) {
    throw new Error("story 迁移闭包 target index 与当前 v2 索引不一致。");
  }

  const sourceByStableId = new Map(library.sources.map((source) => [source.id, source]));
  const allLibraryStableIds = new Set([...library.sources.map((source) => source.id), ...library.chapters.map((chapter) => chapter.id)]);
  const allLibraryLegacyIds = new Set([...library.sources.map((source) => source.legacyId), ...library.chapters.map((chapter) => chapter.legacyId)]);
  if (allLibraryStableIds.size !== library.sources.length + library.chapters.length
    || allLibraryLegacyIds.size !== library.sources.length + library.chapters.length) {
    throw new Error("story 迁移闭包 v2 source/chapter ID 未全局唯一。");
  }
  const sourceMappingsByLegacy = new Map<string, StoryV1ToV2MigrationReceipt["mappings"]["sources"][number]>();
  const sourceMappingStableIds = new Set<string>();
  for (const mapping of receipt.mappings.sources) {
    if (sourceMappingsByLegacy.has(mapping.legacyId) || sourceMappingStableIds.has(mapping.stableId)) {
      throw new Error("story 迁移闭包来源 mapping 含重复 legacy/stable ID。");
    }
    sourceMappingsByLegacy.set(mapping.legacyId, mapping);
    sourceMappingStableIds.add(mapping.stableId);
  }
  if (sourceMappingsByLegacy.size !== library.sources.length) {
    throw new Error("story 迁移闭包来源 mapping 数量与 v2 索引不一致。");
  }
  for (const source of library.sources) {
    const mapping = sourceMappingsByLegacy.get(source.legacyId);
    if (!mapping || mapping.stableId !== source.id) {
      throw new Error(`story 迁移闭包来源 mapping 未双向绑定 v2 source：${source.legacyId}`);
    }
  }

  const chapterMappingsByLegacy = new Map<string, StoryV1ToV2MigrationReceipt["mappings"]["chapters"][number]>();
  const chapterMappingStableIds = new Set<string>();
  for (const mapping of receipt.mappings.chapters) {
    if (chapterMappingsByLegacy.has(mapping.legacyId) || chapterMappingStableIds.has(mapping.stableId)) {
      throw new Error("story 迁移闭包章节 mapping 含重复 legacy/stable ID。");
    }
    chapterMappingsByLegacy.set(mapping.legacyId, mapping);
    chapterMappingStableIds.add(mapping.stableId);
  }
  if (chapterMappingsByLegacy.size !== library.chapters.length) {
    throw new Error("story 迁移闭包章节 mapping 数量与 v2 索引不一致。");
  }
  if (new Set([...sourceMappingsByLegacy.keys(), ...chapterMappingsByLegacy.keys()]).size
      !== receipt.mappings.sources.length + receipt.mappings.chapters.length
    || new Set([...sourceMappingStableIds, ...chapterMappingStableIds]).size
      !== receipt.mappings.sources.length + receipt.mappings.chapters.length) {
    throw new Error("story 迁移闭包 mapping 的 legacy/stable ID 未全局唯一。");
  }
  for (const chapter of library.chapters) {
    const source = sourceByStableId.get(chapter.sourceId);
    const mapping = chapterMappingsByLegacy.get(chapter.legacyId);
    if (!source || !mapping
      || mapping.stableId !== chapter.id
      || mapping.legacySourceId !== source.legacyId
      || mapping.stableSourceId !== source.id) {
      throw new Error(`story 迁移闭包章节 mapping 未双向绑定 v2 chapter/source：${chapter.legacyId}`);
    }
  }

  const expectedFiles = new Map<string, ExpectedMigrationFile>();
  const addExpectedFile = (locator: string, expected: ExpectedMigrationFile): void => {
    if (!locator.startsWith(`${migrationNamespace}/`) || expectedFiles.has(locator)) {
      throw new Error(`story 迁移闭包含跨 migration 或重复 locator：${locator}`);
    }
    expectedFiles.set(locator, expected);
  };
  addExpectedFile(path.posix.join(expectedMirrorLocator, "story-index-v1.json"), { role: "story-index" });
  if (receipt.files.some((file) => file.role === "story-events")) {
    addExpectedFile(path.posix.join(expectedMirrorLocator, "story-events-v1.json"), { role: "story-events" });
  }
  addExpectedFile(expectedTargetIndexLocator, { role: "target-index" });
  for (const source of library.sources) {
    addExpectedFile(source.originalLocator, { role: "source-original", legacyId: source.legacyId });
    addExpectedFile(source.snapshotLocator, { role: "source-snapshot", legacyId: source.legacyId });
  }
  for (const chapter of library.chapters) {
    addExpectedFile(chapter.locator, { role: "chapter", legacyId: chapter.legacyId });
  }

  const seenLocators = new Set<string>();
  const seenRoleKeys = new Set<string>();
  const readsByLocator = new Map<string, StableProjectFileRead>();
  const physicalPathsByLocator = new Map<string, string>();
  if (receipt.files.length !== expectedFiles.size) {
    throw new Error("story 迁移闭包文件数量不完整或含多余项。");
  }
  for (const file of receipt.files) {
    const roleKey = `${file.role}:${file.legacyId ?? ""}`;
    if (seenLocators.has(file.locator) || seenRoleKeys.has(roleKey)) {
      throw new Error("story 迁移闭包 files 含重复 locator 或 role/legacyId。");
    }
    seenLocators.add(file.locator);
    seenRoleKeys.add(roleKey);
    const expected = expectedFiles.get(file.locator);
    if (!expected || file.role !== expected.role || file.legacyId !== expected.legacyId) {
      throw new Error(`story 迁移闭包文件角色、legacyId 或 locator 不匹配：${file.locator}`);
    }
    const suffix = file.locator.slice(`${migrationNamespace}/`.length);
    const physicalPath = path.join(physicalMigrationRoot, ...suffix.split("/"));
    let read: StableProjectFileRead;
    try {
      read = await readStableProjectFile(projectRoot, physicalPath, `story 迁移闭包文件 ${file.locator}`);
      if (read.bytes.byteLength !== file.byteLength || read.sha256 !== file.sha256) {
        throw new Error(`story 迁移闭包文件 SHA/长度与回执不一致：${file.locator}`);
      }
    } catch (error) {
      if (file.role === "chapter") {
        throw new StoryChapterEvidenceError("story 迁移闭包文件 SHA/长度不一致：章节证据不可用。", { cause: error });
      }
      throw error;
    }
    readsByLocator.set(file.locator, read);
    physicalPathsByLocator.set(file.locator, read.absolutePath);
    if (file.role === "story-index" && file.sha256 !== receipt.sourceIndexSha256) {
      throw new Error("story 迁移闭包 legacy story index 未绑定 sourceIndexSha256。");
    }
    if (file.role === "target-index"
      && (file.sha256 !== receipt.targetIndexSha256 || !read.bytes.equals(targetIndexBytes))) {
      throw new Error("story 迁移闭包 target index 文件未精确绑定权威 v2 index。");
    }
  }
  if ([...expectedFiles.keys()].some((locator) => !seenLocators.has(locator))) {
    throw new Error("story 迁移闭包遗漏必要文件。");
  }
  await validateMigrationSemanticClosure({ library, receipt, readsByLocator, physicalPathsByLocator });
  const expectedPhysicalFiles = [
    "receipt.json",
    ...[...expectedFiles.keys()].map((locator) => locator.slice(`${migrationNamespace}/`.length)),
  ].sort((left, right) => left.localeCompare(right, "en"));
  const physicalFiles = await listStableMigrationFiles(projectRoot, physicalMigrationRoot);
  if (physicalFiles.length !== expectedPhysicalFiles.length
    || physicalFiles.some((file, index) => file !== expectedPhysicalFiles[index])) {
    throw new Error("story 迁移闭包物理文件集合存在遗漏或多余文件。");
  }
  const physicalReceiptAfter = await readStableProjectFile(projectRoot, physicalReceiptPath, "story 迁移闭包 receipt 复验");
  if (!physicalReceiptAfter.bytes.equals(physicalReceiptRead.bytes)) {
    throw new Error("story 迁移闭包 receipt 在验证期间发生变化。");
  }
}

async function withLock<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
  return withProjectLock(projectRoot, "story", operation);
}

function emptyLibrary(): StoryLibrary {
  return { schemaVersion: 1, revision: 0, sources: [], chapters: [], updatedAt: new Date(0).toISOString() };
}

function emptyGraph(): StoryEventGraph {
  return { schemaVersion: 1, revision: 0, events: [], updatedAt: new Date(0).toISOString() };
}

interface LegacyStoryEvidenceIdentity {
  absolutePath: string;
  dev: number;
  ino: number;
  byteLength: number;
  sha256: string;
}

/**
 * legacy v1 的 snapshot/chapter 仍是索引内路径，不能直接交给 fs.readFile。
 * 每次读取都通过项目根 confinement + O_NOFOLLOW 冻结 fd 身份，并以
 * 索引中的语义 SHA/字数/章节区间验证内容。返回的身份用于第二轮复验，
 * 从而拦截首轮验证后的 inode 替换，包括同 SHA 替换。
 */
async function freezeLegacyStoryEvidence(
  projectRoot: string,
  library: StoryLibrary,
): Promise<Map<string, LegacyStoryEvidenceIdentity>> {
  const evidence = new Map<string, LegacyStoryEvidenceIdentity>();
  const sourceTexts = new Map<string, string>();
  const recordEvidence = (
    key: string,
    read: Awaited<ReturnType<typeof readStableProjectFile>>,
  ): void => {
    if (evidence.has(key)) throw new Error(`story v1 证据键重复：${key}`);
    evidence.set(key, {
      absolutePath: read.absolutePath,
      dev: read.identity.dev,
      ino: read.identity.ino,
      byteLength: read.bytes.byteLength,
      sha256: read.sha256,
    });
  };

  for (const source of library.sources) {
    const read = await readStableProjectFile(projectRoot, source.snapshotPath, `story v1 来源快照 ${source.id}`);
    const text = decodeLegacyStoryText(read.bytes, `story v1 来源快照 ${source.id}`);
    if (sha256(text) !== source.sha256 || text.length !== source.charCount) {
      throw new Error(`story v1 来源快照 SHA/字数与索引不一致：${source.id}`);
    }
    sourceTexts.set(source.id, text);
    recordEvidence(`source:${source.id}`, read);
  }

  for (const chapter of library.chapters) {
    try {
      const read = await readStableProjectFile(projectRoot, chapter.path, `story v1 章节 ${chapter.id}`);
      const text = decodeLegacyStoryText(read.bytes, `story v1 章节 ${chapter.id}`);
      const sourceText = sourceTexts.get(chapter.sourceId);
      if (sourceText === undefined) throw new Error("story v1 章节来源快照缺失。");
      if (sha256(text) !== chapter.sha256 || text.length !== chapter.charCount) {
        throw new Error("story v1 章节 SHA/字数与索引不一致。");
      }
      if (chapter.endOffset > sourceText.length
        || sourceText.slice(chapter.startOffset, chapter.endOffset).trim() !== text) {
        throw new Error("story v1 章节区间与来源快照不一致。");
      }
      recordEvidence(`chapter:${chapter.id}`, read);
    } catch (error) {
      if (error instanceof StoryChapterEvidenceError) throw error;
      throw new StoryChapterEvidenceError("story v1 章节 SHA/字数与索引不一致或证据不可用。", { cause: error });
    }
  }
  return evidence;
}

function assertSameLegacyStoryEvidence(
  before: Map<string, LegacyStoryEvidenceIdentity>,
  after: Map<string, LegacyStoryEvidenceIdentity>,
): void {
  if (before.size !== after.size) throw new Error("story v1 证据集在复验期间发生变化。");
  for (const [key, expected] of before) {
    const actual = after.get(key);
    if (!actual
      || actual.absolutePath !== expected.absolutePath
      || actual.dev !== expected.dev
      || actual.ino !== expected.ino
      || actual.byteLength !== expected.byteLength
      || actual.sha256 !== expected.sha256) {
      if (key.startsWith("chapter:")) {
        throw new StoryChapterEvidenceError("story v1 章节证据在复验期间发生变化。");
      }
      throw new Error(`story v1 证据在复验期间发生 inode 或 SHA 变化：${key}`);
    }
  }
}

async function loadLibraryDocument(projectRoot: string): Promise<LoadedStoryLibrary> {
  const filePath = getSidecarPaths(projectRoot).storyIndex;
  let indexRead: Awaited<ReturnType<typeof readStableProjectFile>>;
  try {
    indexRead = await readStableProjectFile(projectRoot, filePath, "story 索引", 20_000_000);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { library: emptyLibrary(), schemaVersion: 1, legacyChapterIdToStableId: new Map() };
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(indexRead.bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`story 索引 JSON 已损坏，停止读取：${filePath}`, { cause: error });
  }
  if (!recordValue(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new Error(`story 索引 schema 无效，已停止读取：${filePath}`);
  }
  await storyMigrationTestHooks.afterLibraryIndexFreeze?.({ indexPath: filePath, schemaVersion: value.schemaVersion });
  if (value.schemaVersion === 1) {
    const legacy = parseStoryLibraryV1(value, filePath);
    const config = await loadProjectConfig(projectRoot);
    if (config.schemaVersion === 2 && (config.workspaceMode === "novel" || config.workspaceMode === "hybrid")) {
      throw new Error("schema v2 novel/hybrid 工作区的 legacy story v1 读取已关闭；请先显式运行 story v1→v2 迁移。");
    }
    const frozenEvidence = await freezeLegacyStoryEvidence(projectRoot, legacy);
    await storyMigrationTestHooks.afterLegacyStoryEvidenceFreeze?.({ indexPath: filePath });
    const confirmedEvidence = await freezeLegacyStoryEvidence(projectRoot, legacy);
    assertSameLegacyStoryEvidence(frozenEvidence, confirmedEvidence);
    const confirmed = await readStableProjectFile(projectRoot, filePath, "story v1 索引复验", 20_000_000);
    if (confirmed.identity.dev !== indexRead.identity.dev || confirmed.identity.ino !== indexRead.identity.ino
      || confirmed.sha256 !== indexRead.sha256 || !confirmed.bytes.equals(indexRead.bytes)) {
      throw new Error("story v1 索引在读取期间发生替换，已停止投影。");
    }
    return { library: legacy, schemaVersion: 1, legacyChapterIdToStableId: new Map() };
  }
  const v2 = parseStoryLibraryV2(value, filePath);
  const receiptPath = await resolveConfinedStoryLocator(projectRoot, v2.migration.receiptLocator, "story v2 migration.receiptLocator");
  const [receiptRead, config] = await Promise.all([
    readStableProjectFile(projectRoot, receiptPath, "story v2 迁移回执"),
    loadProjectConfig(projectRoot),
  ]);
  const receipt = parseStoryMigrationReceipt(JSON.parse(receiptRead.bytes.toString("utf8")) as unknown, receiptPath);
  await validateMigrationClosure({
    projectRoot,
    projectId: config.id,
    library: v2,
    receipt,
    targetIndexBytes: indexRead.bytes,
    physicalMigrationRoot: path.join(getSidecarPaths(projectRoot).storyMigrations, receipt.migrationId),
  });
  const confirmedIndex = await readStableProjectFile(projectRoot, filePath, "story v2 索引闭包复验", 20_000_000);
  if (confirmedIndex.identity.dev !== indexRead.identity.dev || confirmedIndex.identity.ino !== indexRead.identity.ino
    || confirmedIndex.sha256 !== indexRead.sha256 || !confirmedIndex.bytes.equals(indexRead.bytes)) {
    throw new Error("story v2 索引在闭包验证期间发生替换，已停止投影。");
  }
  const sourceLegacyToStable = new Map(v2.sources.map((source) => [source.legacyId, source.id]));
  const legacyChapterIdToStableId = new Map(v2.chapters.map((chapter) => [chapter.legacyId, chapter.id]));
  const projected: StoryLibrary = {
    schemaVersion: 1,
    revision: v2.revision,
    sources: v2.sources.map((source) => ({
      id: source.id,
      title: source.title,
      originalPath: path.resolve(projectRoot, ...source.originalLocator.split("/")),
      snapshotPath: path.resolve(projectRoot, ...source.snapshotLocator.split("/")),
      kind: source.kind,
      encoding: source.encoding,
      sha256: source.sha256,
      size: source.size,
      charCount: source.charCount,
      chapterIds: source.chapterIds,
      revision: source.revision,
      importedAt: source.importedAt,
      updatedAt: source.updatedAt,
    })),
    chapters: v2.chapters.map((chapter) => ({
      id: chapter.id,
      sourceId: chapter.sourceId,
      index: chapter.index,
      title: chapter.title,
      path: path.resolve(projectRoot, ...chapter.locator.split("/")),
      charCount: chapter.charCount,
      sha256: chapter.sha256,
      startOffset: chapter.startOffset,
      endOffset: chapter.endOffset,
      revision: chapter.revision,
      createdAt: chapter.createdAt,
      updatedAt: chapter.updatedAt,
    })),
    updatedAt: v2.updatedAt,
  };
  if (sourceLegacyToStable.size !== projected.sources.length) throw new Error(`story v2 来源映射无效：${filePath}`);
  return { library: projected, schemaVersion: 2, legacyChapterIdToStableId };
}

async function loadLibrary(projectRoot: string): Promise<StoryLibrary> {
  return (await loadLibraryDocument(projectRoot)).library;
}

async function loadGraph(projectRoot: string): Promise<StoryEventGraph> {
  const [graph, loaded] = await Promise.all([
    readJson(getSidecarPaths(projectRoot).storyEvents, emptyGraph()),
    loadLibraryDocument(projectRoot),
  ]);
  if (loaded.schemaVersion === 1) return graph;
  const stableChapterIds = new Set(loaded.library.chapters.map((chapter) => chapter.id));
  return {
    ...graph,
    events: graph.events.map((event) => {
      const chapterIdValue = loaded.legacyChapterIdToStableId.get(event.chapterId) ?? event.chapterId;
      if (!stableChapterIds.has(chapterIdValue)) {
        throw new Error(`story v2 事件引用不存在章节，已停止读取：${event.id}`);
      }
      return { ...event, chapterId: chapterIdValue };
    }),
  };
}

async function assertLegacyStoryMutationAllowed(projectRoot: string): Promise<void> {
  const [config, rawLibrary] = await Promise.all([
    loadProjectConfig(projectRoot),
    readJson<unknown>(getSidecarPaths(projectRoot).storyIndex, null),
  ]);
  if (config.schemaVersion === 2 || (recordValue(rawLibrary) && rawLibrary.schemaVersion === 2)) {
    throw new Error("schema v2 novel/hybrid 工作区禁止 legacy Story 写入；请使用 NovelRepository 正式命令。");
  }
}

async function readValidatedStoryChapterFile(
  projectRoot: string,
  chapter: StoryChapter,
  schemaVersion: 1 | 2,
): Promise<string> {
  const label = schemaVersion === 1 ? "story v1 章节" : "story v2 章节";
  const read = await readStableProjectFile(projectRoot, chapter.path, `${label} ${chapter.id}`);
  const text = decodeLegacyStoryText(read.bytes, `${label} ${chapter.id}`);
  if (sha256(text) !== chapter.sha256 || text.length !== chapter.charCount) {
    throw new Error(`${label} SHA/字数与索引不一致：${chapter.id}`);
  }
  return read.bytes.toString("utf8");
}

async function readProjectedStoryChapter(projectRoot: string, chapter: StoryChapter): Promise<string> {
  const loaded = await loadLibraryDocument(projectRoot);
  const current = loaded.library.chapters.find((candidate) => candidate.id === chapter.id);
  if (!current) throw new Error(`story 章节已变化：${chapter.id}`);
  return readValidatedStoryChapterFile(projectRoot, current, loaded.schemaVersion);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\0/g, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{5,}/g, "\n\n\n").trim();
}

function decodeBuffer(buffer: Buffer): { text: string; encoding: "utf-8" | "gb18030" } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("gb18030").decode(buffer), encoding: "gb18030" };
  }
}

function sourceKind(filePath: string): StorySourceKind {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".docx") return "docx";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (extension === ".txt") return "text";
  throw new Error("原文只支持 .txt、.md、.markdown 和 .docx 文件。");
}

async function extractFile(filePath: string): Promise<{ text: string; kind: StorySourceKind; encoding: StorySource["encoding"]; size: number }> {
  const absolutePath = path.resolve(filePath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new Error("原文路径不是文件。");
  if (fileStat.size === 0) throw new Error("原文文件是零字节。");
  if (fileStat.size > MAX_SOURCE_BYTES) throw new Error("原文文件超过 50MB，请先拆分后导入。");
  const kind = sourceKind(absolutePath);
  if (kind === "docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path: absolutePath });
    return { text: normalizeText(result.value), kind, encoding: "docx", size: fileStat.size };
  }
  const decoded = decodeBuffer(await readFile(absolutePath));
  return { text: normalizeText(decoded.text), kind, encoding: decoded.encoding, size: fileStat.size };
}

interface ChapterDraft { title: string; content: string; startOffset: number; endOffset: number }

function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 140) return false;
  if (/^#{1,6}\s+\S+/.test(trimmed)) return true;
  return /^(?:第\s*[0-9０-９零一二三四五六七八九十百千万两]+\s*[卷部章节回幕集]|(?:chapter|episode|ep)\s*\d+)/i.test(trimmed);
}

function cleanHeading(value: string): string {
  return value.trim().replace(/^#{1,6}\s*/, "").trim() || "未命名章节";
}

export function splitStoryChapters(source: string): ChapterDraft[] {
  const text = normalizeText(source);
  if (!text) return [];
  const headings: Array<{ title: string; start: number; bodyStart: number }> = [];
  const linePattern = /^.*$/gm;
  for (const match of text.matchAll(linePattern)) {
    const line = match[0] ?? "";
    if (!isHeading(line)) continue;
    headings.push({ title: cleanHeading(line), start: match.index ?? 0, bodyStart: (match.index ?? 0) + line.length });
  }
  const drafts: ChapterDraft[] = [];
  if (headings.length) {
    const prelude = text.slice(0, headings[0]!.start).trim();
    if (prelude.length >= 80) drafts.push({ title: "序章", content: prelude, startOffset: 0, endOffset: headings[0]!.start });
    headings.forEach((heading, index) => {
      const end = headings[index + 1]?.start ?? text.length;
      const body = text.slice(heading.bodyStart, end).trim();
      drafts.push({ title: heading.title, content: body, startOffset: heading.bodyStart, endOffset: end });
    });
    return drafts.filter((chapter) => chapter.content || chapter.title);
  }
  const paragraphs = [...text.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/g)];
  let buffer = "";
  let start = 0;
  let part = 1;
  for (const paragraph of paragraphs) {
    const value = paragraph[0]!.trim();
    if (!buffer) start = paragraph.index ?? 0;
    if (buffer && buffer.length + value.length + 2 > CHAPTER_TARGET_CHARS) {
      drafts.push({ title: `第 ${part++} 部分`, content: buffer, startOffset: start, endOffset: paragraph.index ?? start + buffer.length });
      buffer = "";
      start = paragraph.index ?? 0;
    }
    buffer += `${buffer ? "\n\n" : ""}${value}`;
  }
  if (buffer) drafts.push({ title: drafts.length ? `第 ${part} 部分` : "全文", content: buffer, startOffset: start, endOffset: text.length });
  return drafts;
}

function chapterId(sourceId: string, title: string, occurrence: number): string {
  return `chapter-${createHash("sha1").update(`${sourceId}:${title.normalize("NFKC")}:${occurrence}`).digest("hex").slice(0, 16)}`;
}

async function backupIfExists(sourcePath: string, destination: string): Promise<void> {
  if (await access(sourcePath).then(() => true).catch(() => false)) {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(sourcePath, destination);
  }
}

function parseStoryLibraryV1(value: unknown, filePath: string): StoryLibrary {
  if (!recordValue(value)
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !Array.isArray(value.sources)
    || !Array.isArray(value.chapters)
    || typeof value.updatedAt !== "string") {
    throw new Error(`story v1 索引结构无效，迁移已停止：${filePath}`);
  }
  const library = value as unknown as StoryLibrary;
  const sourceIds = new Set<string>();
  const chapterIds = new Set<string>();
  for (const [index, source] of library.sources.entries()) {
    if (!source || typeof source !== "object"
      || typeof source.id !== "string" || !source.id
      || typeof source.title !== "string"
      || typeof source.originalPath !== "string" || !source.originalPath
      || typeof source.snapshotPath !== "string" || !source.snapshotPath
      || !["text", "markdown", "docx"].includes(source.kind)
      || !["utf-8", "gb18030", "docx"].includes(source.encoding)
      || ((source.kind === "docx") !== (source.encoding === "docx"))
      || !/^[a-f0-9]{64}$/u.test(source.sha256)
      || !Number.isSafeInteger(source.size) || source.size < 0
      || !Number.isSafeInteger(source.charCount) || source.charCount < 0
      || !Array.isArray(source.chapterIds) || !source.chapterIds.every((entry) => typeof entry === "string" && entry.length > 0)
      || !Number.isSafeInteger(source.revision) || source.revision < 1
      || typeof source.importedAt !== "string" || typeof source.updatedAt !== "string") {
      throw new Error(`story v1 source[${index}] 结构无效，迁移已停止。`);
    }
    if (sourceIds.has(source.id)) throw new Error(`story v1 来源 ID 重复：${source.id}`);
    sourceIds.add(source.id);
  }
  for (const [index, chapter] of library.chapters.entries()) {
    if (!chapter || typeof chapter !== "object"
      || typeof chapter.id !== "string" || !chapter.id
      || typeof chapter.sourceId !== "string" || !chapter.sourceId
      || typeof chapter.title !== "string"
      || typeof chapter.path !== "string" || !chapter.path
      || !/^[a-f0-9]{64}$/u.test(chapter.sha256)
      || !Number.isSafeInteger(chapter.index) || chapter.index < 1
      || !Number.isSafeInteger(chapter.charCount) || chapter.charCount < 0
      || !Number.isSafeInteger(chapter.startOffset) || chapter.startOffset < 0
      || !Number.isSafeInteger(chapter.endOffset) || chapter.endOffset < chapter.startOffset
      || !Number.isSafeInteger(chapter.revision) || chapter.revision < 1
      || typeof chapter.createdAt !== "string" || typeof chapter.updatedAt !== "string") {
      throw new Error(`story v1 chapter[${index}] 结构无效，迁移已停止。`);
    }
    if (!sourceIds.has(chapter.sourceId)) throw new Error(`story v1 章节来源不存在：${chapter.id}`);
    if (chapterIds.has(chapter.id)) throw new Error(`story v1 章节 ID 重复：${chapter.id}`);
    chapterIds.add(chapter.id);
  }
  for (const source of library.sources) {
    const expected = library.chapters
      .filter((chapter) => chapter.sourceId === source.id)
      .sort((left, right) => left.index - right.index)
      .map((chapter) => chapter.id);
    if (source.chapterIds.length !== expected.length
      || source.chapterIds.some((id, index) => id !== expected[index])) {
      throw new Error(`story v1 来源章节列表与章节表不一致：${source.id}`);
    }
  }
  return library;
}

function validateStoryEventGraphForMigration(value: unknown, chapterIds: Set<string>, filePath: string): StoryEventGraph {
  if (!recordValue(value)
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.revision)
    || !Array.isArray(value.events)
    || typeof value.updatedAt !== "string") {
    throw new Error(`story 事件图结构无效，迁移已停止：${filePath}`);
  }
  const graph = value as unknown as StoryEventGraph;
  for (const [index, event] of graph.events.entries()) {
    if (!event || typeof event !== "object" || typeof event.id !== "string"
      || typeof event.chapterId !== "string" || !chapterIds.has(event.chapterId)) {
      throw new Error(`story 事件图 event[${index}] 引用不存在章节，迁移已停止。`);
    }
  }
  return graph;
}

async function loadExistingStoryMigration(
  projectRoot: string,
  projectId: string,
  library: StoryLibraryV2,
  indexRead: StableFileRead,
): Promise<StoryV1ToV2MigrationResult> {
  const receiptPath = await resolveConfinedStoryLocator(projectRoot, library.migration.receiptLocator, "story v2 migration.receiptLocator");
  const receiptRead = await readStableProjectFile(projectRoot, receiptPath, "story v2 迁移回执");
  const receipt = parseStoryMigrationReceipt(JSON.parse(receiptRead.bytes.toString("utf8")) as unknown, receiptPath);
  await validateMigrationClosure({
    projectRoot,
    projectId,
    library,
    receipt,
    targetIndexBytes: indexRead.bytes,
    physicalMigrationRoot: path.join(getSidecarPaths(projectRoot).storyMigrations, receipt.migrationId),
  });
  return { status: "already_migrated", receipt, library };
}

/**
 * 显式把 v2 novel/hybrid 工作区中残留的 legacy story v1 证据迁成只读 v2。
 * 所有引用先冻结、复制和往返验证，最后才以旧 index inode + SHA 作 CAS 切换。
 */
export async function migrateStoryLibraryV1ToV2(projectRoot: string): Promise<StoryV1ToV2MigrationResult> {
  return withLock(projectRoot, async () => {
    const root = path.resolve(projectRoot);
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error("story 迁移要求无符号链接的真实项目根。");
    }
    const config = await loadProjectConfig(root);
    if (config.schemaVersion !== 2 || (config.workspaceMode !== "novel" && config.workspaceMode !== "hybrid")) {
      throw new Error("story v1→v2 迁移只允许显式 novel/hybrid schema v2 工作区。");
    }
    const paths = getSidecarPaths(root);
    const indexRead = await readStableProjectFile(root, paths.storyIndex, "story v1 索引", 20_000_000);
    let parsedIndex: unknown;
    try {
      parsedIndex = JSON.parse(indexRead.bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw new Error("story v1 索引 JSON 已损坏，迁移已停止。", { cause: error });
    }
    if (recordValue(parsedIndex) && parsedIndex.schemaVersion === 2) {
      const existing = parseStoryLibraryV2(parsedIndex, paths.storyIndex);
      return loadExistingStoryMigration(root, config.id, existing, indexRead);
    }
    const legacy = parseStoryLibraryV1(parsedIndex, paths.storyIndex);
    const chapterIds = new Set(legacy.chapters.map((chapter) => chapter.id));
    let eventsBytes: Buffer | undefined;
    try {
      eventsBytes = (await readStableProjectFile(root, paths.storyEvents, "story v1 事件图", 20_000_000)).bytes;
      validateStoryEventGraphForMigration(JSON.parse(eventsBytes.toString("utf8")) as unknown, chapterIds, paths.storyEvents);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const migrationId = `story-migration-${randomUUID()}`;
    const stagingRoot = path.join(paths.storyMigrationStaging, migrationId);
    const finalRoot = path.join(paths.storyMigrations, migrationId);
    const finalRootLocator = storyLocator(root, finalRoot);
    const mirrorLocator = path.posix.join(finalRootLocator, "mirror");
    const receiptLocator = path.posix.join(finalRootLocator, "receipt.json");
    const sourceStableIds = new Map(legacy.sources.map((source) => [source.id, randomUUID()]));
    const chapterStableIds = new Map(legacy.chapters.map((chapter) => [chapter.id, randomUUID()]));
    const sourceSnapshots = new Map<string, { bytes: Buffer; semantic: string }>();
    const fileRecords: StoryV1ToV2MigrationReceipt["files"] = [];

    const persistMirror = async (
      role: StoryV1ToV2MigrationReceipt["files"][number]["role"],
      relativePath: string,
      bytes: Buffer,
      legacyId?: string,
    ): Promise<string> => {
      const stagingPath = path.join(stagingRoot, ...relativePath.split("/"));
      const persisted = await persistMigrationFile(root, stagingPath, bytes);
      const locator = assertStoryLocator(path.posix.join(finalRootLocator, relativePath), `迁移 ${role} locator`);
      fileRecords.push({ role, ...(legacyId ? { legacyId } : {}), locator, sha256: persisted.sha256, byteLength: bytes.byteLength });
      return locator;
    };

    try {
      const stagingDirectory = await ensureConfinedDirectory(root, stagingRoot);
      await persistMirror("story-index", "mirror/story-index-v1.json", indexRead.bytes);
      if (eventsBytes) await persistMirror("story-events", "mirror/story-events-v1.json", eventsBytes);

      const sourceLocators = new Map<string, { originalLocator: string; snapshotLocator: string }>();
      for (const source of legacy.sources) {
        const stableId = sourceStableIds.get(source.id)!;
        const snapshotRead = await readStableProjectFile(root, source.snapshotPath, `story v1 来源快照 ${source.id}`);
        const snapshotText = decodeLegacyStoryText(snapshotRead.bytes, `story v1 来源快照 ${source.id}`);
        if (sha256(snapshotText) !== source.sha256 || snapshotText.length !== source.charCount) {
          throw new Error(`story v1 来源快照 SHA/字数与索引不一致：${source.id}`);
        }
        sourceSnapshots.set(source.id, { bytes: snapshotRead.bytes, semantic: snapshotText });

        let originalBytes: Buffer;
        if (source.originalPath.startsWith("aicanvas://pasted/")) {
          originalBytes = snapshotRead.bytes;
          if (source.size !== Buffer.byteLength(snapshotText, "utf8")) {
            throw new Error(`story v1 粘贴来源大小与索引不一致：${source.id}`);
          }
        } else {
          if ((source.kind === "docx") !== (source.encoding === "docx")) {
            throw new Error(`story v1 原始来源类型与编码不一致：${source.id}`);
          }
          const label = `story v1 原始来源 ${source.id}`;
          const originalRead = await readStableExternalStorySource(source.originalPath, label);
          originalBytes = originalRead.bytes;
          if (originalBytes.byteLength !== source.size) throw new Error(`story v1 原始来源大小与索引不一致：${source.id}`);
          await storyMigrationTestHooks.afterExternalSourceFreeze?.({ sourceId: source.id, sourcePath: originalRead.absolutePath });
          if (source.kind === "docx") {
            const extracted = await parseNovelDocxIsolated(originalRead.absolutePath, {
              maximumFileBytes: Math.min(MAX_SOURCE_BYTES, originalBytes.byteLength),
              maximumOutputChars: MAX_TEXT_CHARS,
            });
            if (extracted.sourceSha256 !== originalRead.sha256
              || sha256(normalizeText(extracted.text)) !== source.sha256) {
              throw new Error(`story v1 DOCX 原始来源内容与快照身份不一致：${source.id}`);
            }
          } else {
            const decoded = source.encoding === "gb18030"
              ? new TextDecoder("gb18030").decode(originalBytes)
              : new TextDecoder("utf-8", { fatal: true }).decode(originalBytes);
            if (sha256(normalizeText(decoded)) !== source.sha256) {
              throw new Error(`story v1 原始来源内容与快照身份不一致：${source.id}`);
            }
          }
          const originalAfter = await readStableExternalStorySource(source.originalPath, label);
          assertSameFrozenExternalSource(originalRead, originalAfter, label);
        }
        const extension = source.kind === "docx" ? "docx" : source.kind === "markdown" ? "md" : "txt";
        const originalLocator = await persistMirror("source-original", `mirror/sources/${stableId}/original.${extension}`, originalBytes, source.id);
        const snapshotLocator = await persistMirror("source-snapshot", `mirror/sources/${stableId}/snapshot.txt`, snapshotRead.bytes, source.id);
        sourceLocators.set(source.id, { originalLocator, snapshotLocator });
      }

      const chapterLocators = new Map<string, string>();
      for (const chapter of legacy.chapters) {
        const stableId = chapterStableIds.get(chapter.id)!;
        const chapterRead = await readStableProjectFile(root, chapter.path, `story v1 章节 ${chapter.id}`);
        const chapterText = decodeLegacyStoryText(chapterRead.bytes, `story v1 章节 ${chapter.id}`);
        const snapshot = sourceSnapshots.get(chapter.sourceId);
        if (!snapshot) throw new Error(`story v1 章节来源快照缺失：${chapter.id}`);
        if (sha256(chapterText) !== chapter.sha256 || chapterText.length !== chapter.charCount) {
          throw new Error(`story v1 章节 SHA/字数与索引不一致：${chapter.id}`);
        }
        if (chapter.endOffset > snapshot.semantic.length
          || snapshot.semantic.slice(chapter.startOffset, chapter.endOffset).trim() !== chapterText) {
          throw new Error(`story v1 章节区间与来源快照不一致：${chapter.id}`);
        }
        chapterLocators.set(
          chapter.id,
          await persistMirror("chapter", `mirror/chapters/${stableId}.txt`, chapterRead.bytes, chapter.id),
        );
      }

      const migratedAt = new Date().toISOString();
      const target: StoryLibraryV2 = {
        schemaVersion: 2,
        kind: STORY_LIBRARY_V2_KIND,
        revision: legacy.revision + 1,
        sources: legacy.sources.map((source) => {
          const locators = sourceLocators.get(source.id)!;
          return {
            id: sourceStableIds.get(source.id)!,
            legacyId: source.id,
            title: source.title,
            ...locators,
            kind: source.kind,
            encoding: source.encoding,
            sha256: source.sha256,
            size: source.size,
            charCount: source.charCount,
            chapterIds: source.chapterIds.map((id) => chapterStableIds.get(id)!),
            revision: source.revision,
            importedAt: source.importedAt,
            updatedAt: source.updatedAt,
          };
        }),
        chapters: legacy.chapters.map((chapter) => ({
          id: chapterStableIds.get(chapter.id)!,
          legacyId: chapter.id,
          sourceId: sourceStableIds.get(chapter.sourceId)!,
          index: chapter.index,
          title: chapter.title,
          locator: chapterLocators.get(chapter.id)!,
          charCount: chapter.charCount,
          sha256: chapter.sha256,
          startOffset: chapter.startOffset,
          endOffset: chapter.endOffset,
          revision: chapter.revision,
          createdAt: chapter.createdAt,
          updatedAt: chapter.updatedAt,
        })),
        updatedAt: migratedAt,
        migration: { receiptLocator, sourceIndexSha256: indexRead.sha256, migratedAt },
      };
      const targetBytes = Buffer.from(`${JSON.stringify(target, null, 2)}\n`, "utf8");
      const targetIndexSha256 = sha256(targetBytes);
      const targetIndexLocator = await persistMirror("target-index", "target/story-index-v2.json", targetBytes);
      const receiptSemantic: Omit<StoryV1ToV2MigrationReceipt, "fingerprint"> = {
        schemaVersion: 1,
        kind: STORY_MIGRATION_RECEIPT_KIND,
        migrationId,
        projectId: config.id,
        sourceIndexSha256: indexRead.sha256,
        targetIndexSha256,
        targetIndexLocator,
        mirrorLocator,
        receiptLocator,
        mappings: {
          sources: legacy.sources.map((source) => ({ legacyId: source.id, stableId: sourceStableIds.get(source.id)! })),
          chapters: legacy.chapters.map((chapter) => ({
            legacyId: chapter.id,
            stableId: chapterStableIds.get(chapter.id)!,
            legacySourceId: chapter.sourceId,
            stableSourceId: sourceStableIds.get(chapter.sourceId)!,
          })),
        },
        files: fileRecords,
        preparedAt: migratedAt,
        commit: { method: "inode-sha256-cas", authoritativeIndexLocator: ".aicanvas/story/index.json" },
      };
      const receipt: StoryV1ToV2MigrationReceipt = {
        ...receiptSemantic,
        fingerprint: storyFingerprint(receiptSemantic),
      };
      await persistMigrationFile(root, path.join(stagingRoot, "receipt.json"), Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"));

      const validateStagingClosure = async (): Promise<StoryV1ToV2MigrationReceipt> => {
        const receiptPath = path.join(stagingRoot, "receipt.json");
        const receiptRead = await readStableProjectFile(root, receiptPath, "story v2 staging receipt");
        const parsed = parseStoryMigrationReceipt(JSON.parse(receiptRead.bytes.toString("utf8")) as unknown, receiptPath);
        await validateMigrationClosure({
          projectRoot: root,
          projectId: config.id,
          library: target,
          receipt: parsed,
          targetIndexBytes: targetBytes,
          physicalMigrationRoot: stagingRoot,
        });
        if (parsed.fingerprint !== receipt.fingerprint) throw new Error("story v2 staging receipt 在发布前发生变化。");
        return parsed;
      };
      await validateStagingClosure();

      const migrationsDirectory = await ensureConfinedDirectory(root, paths.storyMigrations);
      await storyMigrationTestHooks.beforePublish?.({ stagingRoot, finalRoot });
      await validateStagingClosure();
      await moveConfinedDirectoryNoReplace(stagingDirectory, migrationsDirectory, path.basename(finalRoot));

      const roundTripReceipt = parseStoryMigrationReceipt(
        JSON.parse((await readStableProjectFile(root, path.join(finalRoot, "receipt.json"), "story v2 staging 往返回执")).bytes.toString("utf8")) as unknown,
        path.join(finalRoot, "receipt.json"),
      );
      if (roundTripReceipt.fingerprint !== receipt.fingerprint) throw new Error("story v2 往返回执与发布前回执不一致。");
      await validateMigrationClosure({
        projectRoot: root,
        projectId: config.id,
        library: target,
        receipt: roundTripReceipt,
        targetIndexBytes: targetBytes,
        physicalMigrationRoot: finalRoot,
      });

      await replaceConfinedBytesCas(indexRead.identity, indexRead.sha256, indexRead.bytes.byteLength, targetBytes, 0o600);
      return { status: "migrated", receipt, library: target };
    } catch (error) {
      // staging 的祖先目录可能已被并发替换；异常路径绝不按字符串递归删除。
      // 保留受管 staging 供后续基于冻结身份的恢复/隔离流程处理。
      throw error;
    }
  });
}

async function importNormalizedText(
  projectRoot: string,
  input: { title: string; text: string; kind: StorySourceKind; encoding: StorySource["encoding"]; size: number; originalPath: string; sourceId: string },
): Promise<{ source: StorySource; chapters: StoryChapter[]; warnings: string[] }> {
  await assertLegacyStoryMutationAllowed(projectRoot);
  if (!input.text.trim()) throw new Error("原文没有可导入文本。");
  if (input.text.length > MAX_TEXT_CHARS) throw new Error("提取后的原文超过 1000 万字，请先拆分后导入。");
  return withLock(projectRoot, async () => {
    const paths = getSidecarPaths(projectRoot);
    await Promise.all([mkdir(paths.storySnapshots, { recursive: true }), mkdir(paths.storyChapters, { recursive: true }), mkdir(paths.storyHistory, { recursive: true })]);
    const library = await loadLibrary(projectRoot);
    const graph = await loadGraph(projectRoot);
    const existingSource = library.sources.find((source) => source.id === input.sourceId);
    const timestamp = new Date().toISOString();
    const backupStamp = timestamp.replace(/[:.]/g, "-");
    if (existingSource) {
      await backupIfExists(paths.storyIndex, path.join(paths.storyHistory, input.sourceId, `${backupStamp}-index.json`));
      await backupIfExists(existingSource.snapshotPath, path.join(paths.storyHistory, input.sourceId, `${backupStamp}-source.txt`));
    }
    const snapshotPath = path.join(paths.storySnapshots, `${input.sourceId}.txt`);
    await writeTextAtomic(snapshotPath, `${input.text}\n`);
    const drafts = splitStoryChapters(input.text);
    if (!drafts.length) throw new Error("原文拆分后没有有效章节。");
    const titleOccurrences = new Map<string, number>();
    const previousChapters = new Map(library.chapters.filter((chapter) => chapter.sourceId === input.sourceId).map((chapter) => [chapter.id, chapter]));
    const chapters: StoryChapter[] = [];
    for (const [index, draft] of drafts.entries()) {
      const occurrence = (titleOccurrences.get(draft.title) ?? 0) + 1;
      titleOccurrences.set(draft.title, occurrence);
      const id = chapterId(input.sourceId, draft.title, occurrence);
      const existing = previousChapters.get(id);
      const chapterPath = path.join(paths.storyChapters, input.sourceId, `${String(index + 1).padStart(4, "0")}-${id}.txt`);
      await writeTextAtomic(chapterPath, `${draft.content}\n`);
      chapters.push({
        id,
        sourceId: input.sourceId,
        index: index + 1,
        title: draft.title,
        path: chapterPath,
        charCount: draft.content.length,
        sha256: sha256(draft.content),
        startOffset: draft.startOffset,
        endOffset: draft.endOffset,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
    }
    const source: StorySource = {
      id: input.sourceId,
      title: input.title.trim().slice(0, 200) || "未命名原文",
      originalPath: input.originalPath,
      snapshotPath,
      kind: input.kind,
      encoding: input.encoding,
      sha256: sha256(input.text),
      size: input.size,
      charCount: input.text.length,
      chapterIds: chapters.map((chapter) => chapter.id),
      revision: (existingSource?.revision ?? 0) + 1,
      importedAt: existingSource?.importedAt ?? timestamp,
      updatedAt: timestamp,
    };
    library.sources = [source, ...library.sources.filter((candidate) => candidate.id !== source.id)];
    library.chapters = [...library.chapters.filter((chapter) => chapter.sourceId !== source.id), ...chapters];
    library.revision += 1;
    library.updatedAt = timestamp;
    await writeJsonAtomic(paths.storyIndex, library);
    const chapterIds = new Set(library.chapters.map((chapter) => chapter.id));
    const orphanEventIds = graph.events.filter((event) => !chapterIds.has(event.chapterId)).map((event) => event.id);
    const warnings = orphanEventIds.length ? [`${orphanEventIds.length} 个历史事件引用已移除章节，仍保留在事件图中等待人工迁移。`] : [];
    await appendEvent(projectRoot, { actor: "user", type: "story.source_imported", data: { sourceId: source.id, originalPath: source.originalPath, chapters: chapters.length, revision: source.revision, warnings } });
    return { source, chapters, warnings };
  });
}

export async function importStoryFile(projectRoot: string, filePath: string, title?: string) {
  await assertLegacyStoryMutationAllowed(projectRoot);
  const absolutePath = path.resolve(filePath);
  const extracted = await extractFile(absolutePath);
  const sourceId = `source-${createHash("sha1").update(absolutePath).digest("hex").slice(0, 16)}`;
  return importNormalizedText(projectRoot, { ...extracted, text: extracted.text, title: title?.trim() || path.basename(absolutePath, path.extname(absolutePath)), originalPath: absolutePath, sourceId });
}

export async function importStoryText(projectRoot: string, input: { title: string; content: string; kind?: "text" | "markdown" }) {
  await assertLegacyStoryMutationAllowed(projectRoot);
  const sourceId = `source-paste-${randomUUID().slice(0, 12)}`;
  const text = normalizeText(input.content);
  return importNormalizedText(projectRoot, { title: input.title, text, kind: input.kind ?? "text", encoding: "utf-8", size: Buffer.byteLength(text), originalPath: `aicanvas://pasted/${sourceId}`, sourceId });
}

export async function listStorySources(projectRoot: string): Promise<StorySource[]> {
  return (await loadLibrary(projectRoot)).sources.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 供 Adaptation 等 Core 消费者复用同一安全读边界，禁止各自 raw cast story index。 */
export async function loadStoryLibrarySnapshot(projectRoot: string): Promise<StoryLibrary> {
  return loadLibrary(projectRoot);
}

export class StoryAnalysisSnapshotError extends Error {
  readonly kind: "library" | "chapter";

  constructor(kind: "library" | "chapter", message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoryAnalysisSnapshotError";
    this.kind = kind;
  }
}

/**
 * 只验证 story index 自身可稳定读取、JSON 可解析且 schema 受支持；不把它
 * 当作章节事实投影。小说 Provider 用它区分“索引损坏”和“索引有效但章节
 * 证据不可读”，随后仍必须走完整的安全 snapshot owner。
 */
export async function assertStoryLibraryIndexEnvelopeReadable(projectRoot: string): Promise<void> {
  const filePath = getSidecarPaths(projectRoot).storyIndex;
  const indexRead = await readStableProjectFile(projectRoot, filePath, "story 索引 envelope", 20_000_000);
  let value: unknown;
  try {
    value = JSON.parse(indexRead.bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("story 索引 JSON 已损坏，停止读取。", { cause: error });
  }
  if (!recordValue(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new Error("story 索引 schema 无效，已停止读取。");
  }
}

/**
 * 在一份已验证 library 上顺序冻结所有章节，避免分析器对索引中的 path
 * 直接 readFile，也避免每章重读整个闭包导致 O(n²)。
 */
export async function loadStoryAnalysisSnapshot(projectRoot: string): Promise<{
  library: StoryLibrary;
  chapters: Array<{ chapter: StoryChapter; content: string }>;
}> {
  const loaded = await loadLibraryDocument(projectRoot);
  const chapters: Array<{ chapter: StoryChapter; content: string }> = [];
  for (const chapter of loaded.library.chapters) {
    chapters.push({
      chapter,
      content: await readValidatedStoryChapterFile(projectRoot, chapter, loaded.schemaVersion),
    });
  }
  return { library: loaded.library, chapters };
}

/**
 * 为模型分析任务冻结指定章节：索引只验证一次，正文始终从
 * StoryLibrary 当前权威路径读取，不接受 adaptation task 自带路径。
 * 返回顺序按 chapterIds 首次出现固定，分段任务可在上层重用同一份内容。
 */
export async function loadStoryAnalysisChapterSnapshot(
  projectRoot: string,
  chapterIds: readonly string[],
): Promise<{
  library: StoryLibrary;
  chapters: Array<{ chapter: StoryChapter; content: string }>;
}> {
  const ids = [...new Set(chapterIds)];
  if (!ids.length || ids.some((id) => typeof id !== "string" || !id)) {
    throw new StoryAnalysisSnapshotError("chapter", "story 分析章节集无效。");
  }
  let loaded: LoadedStoryLibrary;
  try {
    loaded = await loadLibraryDocument(projectRoot);
  } catch (error) {
    if (error instanceof StoryChapterEvidenceError) {
      throw new StoryAnalysisSnapshotError("chapter", "story 分析章节证据当前不可读取。", { cause: error });
    }
    throw new StoryAnalysisSnapshotError("library", "story 分析章节索引或迁移闭包当前不可读取。", { cause: error });
  }
  const byId = new Map(loaded.library.chapters.map((chapter) => [chapter.id, chapter]));
  const chapters: Array<{ chapter: StoryChapter; content: string }> = [];
  for (const id of ids) {
    const chapter = byId.get(id);
    if (!chapter) throw new StoryAnalysisSnapshotError("chapter", "story 分析章节已变化。");
    try {
      chapters.push({
        chapter,
        content: await readValidatedStoryChapterFile(projectRoot, chapter, loaded.schemaVersion),
      });
    } catch (error) {
      throw new StoryAnalysisSnapshotError("chapter", "story 分析章节正文当前不可读取。", { cause: error });
    }
  }
  return { library: loaded.library, chapters };
}

export async function listStoryChapters(projectRoot: string, sourceId?: string): Promise<StoryChapter[]> {
  return (await loadLibrary(projectRoot)).chapters.filter((chapter) => !sourceId || chapter.sourceId === sourceId).sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.index - b.index);
}

export async function readStoryChapter(projectRoot: string, chapterIdValue: string): Promise<StoryChapterContent> {
  const library = await loadLibrary(projectRoot);
  const chapter = library.chapters.find((candidate) => candidate.id === chapterIdValue);
  if (!chapter) throw new Error(`找不到章节：${chapterIdValue}`);
  return { chapter, content: await readProjectedStoryChapter(projectRoot, chapter) };
}

export async function listStoryEvents(projectRoot: string, options: { chapterId?: string; itemId?: string; status?: StoryEventStatus; includeOrphans?: boolean } = {}): Promise<StoryEvent[]> {
  const [graph, library] = await Promise.all([loadGraph(projectRoot), loadLibrary(projectRoot)]);
  const chapterIds = new Set(library.chapters.map((chapter) => chapter.id));
  return graph.events
    .filter((event) => !options.chapterId || event.chapterId === options.chapterId)
    .filter((event) => !options.itemId || event.itemIds.includes(options.itemId))
    .filter((event) => !options.status || event.status === options.status)
    .filter((event) => options.includeOrphans !== false || chapterIds.has(event.chapterId))
    .sort((a, b) => a.chapterId.localeCompare(b.chapterId) || a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}

export async function upsertStoryEvent(
  projectRoot: string,
  input: { id?: string; chapterId: string; order?: number; title: string; description: string; sourceExcerpt?: string; characters?: string[]; locations?: string[]; props?: string[]; tags?: string[]; episode?: number; unit?: number; itemIds?: string[]; dependencyIds?: string[]; status?: StoryEventStatus; expectedRevision?: number },
  actor: "user" | "codex" = "user",
): Promise<StoryEvent> {
  await assertLegacyStoryMutationAllowed(projectRoot);
  return withLock(projectRoot, async () => {
    const [library, graph, projectIndex] = await Promise.all([loadLibrary(projectRoot), loadGraph(projectRoot), loadIndex(projectRoot)]);
    const chapter = library.chapters.find((candidate) => candidate.id === input.chapterId);
    if (!chapter) throw new Error("事件必须关联当前原文章节。");
    const existing = input.id ? graph.events.find((event) => event.id === input.id) : undefined;
    if (input.id && !existing) throw new Error(`找不到故事事件：${input.id}`);
    if (existing && input.expectedRevision === undefined) throw new Error("更新故事事件必须提供 expectedRevision，避免静默覆盖其他窗口的修改。");
    if (existing && existing.revision !== input.expectedRevision) throw new Error("故事事件已被其他窗口更新，请刷新后重试。");
    const dependencyIds = [...new Set(input.dependencyIds ?? existing?.dependencyIds ?? [])];
    if (input.id && dependencyIds.includes(input.id)) throw new Error("事件不能依赖自身。");
    const missingDependencies = dependencyIds.filter((id) => !graph.events.some((event) => event.id === id));
    if (missingDependencies.length) throw new Error(`依赖事件不存在：${missingDependencies.join("、")}`);
    const itemIds = [...new Set(input.itemIds ?? existing?.itemIds ?? [])];
    if (projectIndex) {
      const known = new Set(projectIndex.items.map((item) => item.id));
      const missingItems = itemIds.filter((id) => !known.has(id));
      if (missingItems.length) throw new Error(`关联生产节点不存在：${missingItems.join("、")}`);
      const episode = normalizePositive(input.episode ?? existing?.episode);
      const unit = normalizePositive(input.unit ?? existing?.unit);
      const mismatchedItems = itemIds.filter((id) => {
        const item = projectIndex.items.find((candidate) => candidate.id === id);
        if (!item) return false;
        return (episode !== undefined && item.episode !== episode)
          || (unit !== undefined && item.type === "unit" && item.unit !== unit);
      });
      if (mismatchedItems.length) throw new Error(`事件集数/单元与关联生产节点不一致：${mismatchedItems.join("、")}`);
    }
    const status = input.status ?? existing?.status ?? "draft";
    const tags = cleanList(input.tags ?? existing?.tags);
    const sourceExcerpt = input.sourceExcerpt?.trim().slice(0, 8_000) || undefined;
    if (status === "confirmed") {
      if (!sourceExcerpt && !tags.includes("改编推断")) throw new Error("确认故事事件必须提供可核对的原文句段；改编推断必须显式添加“改编推断”标签。");
      if (sourceExcerpt) {
        const chapterText = await readProjectedStoryChapter(projectRoot, chapter);
        if (!chapterText.includes(sourceExcerpt)) throw new Error("故事事件的原文句段与章节快照不匹配，不能确认。");
      }
    }
    const prospectiveEvents = graph.events.map((event) => event.id === existing?.id ? { ...event, dependencyIds } : event);
    if (!existing) prospectiveEvents.push({ id: input.id ?? "__new__", dependencyIds } as StoryEvent);
    if (hasDependencyCycle(prospectiveEvents)) throw new Error("故事事件依赖形成循环，已拒绝保存。");
    const now = new Date().toISOString();
    const event: StoryEvent = {
      id: existing?.id ?? `story-event-${randomUUID()}`,
      chapterId: input.chapterId,
      order: Math.max(1, input.order ?? existing?.order ?? graph.events.filter((candidate) => candidate.chapterId === input.chapterId).length + 1),
      title: input.title.trim().slice(0, 180) || "未命名故事事件",
      description: input.description.trim().slice(0, 20_000),
      sourceExcerpt,
      characters: cleanList(input.characters ?? existing?.characters),
      locations: cleanList(input.locations ?? existing?.locations),
      props: cleanList(input.props ?? existing?.props),
      tags,
      episode: normalizePositive(input.episode ?? existing?.episode),
      unit: normalizePositive(input.unit ?? existing?.unit),
      itemIds,
      dependencyIds,
      status,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const index = existing ? graph.events.findIndex((candidate) => candidate.id === existing.id) : -1;
    if (index >= 0) graph.events[index] = event;
    else graph.events.push(event);
    graph.revision += 1;
    graph.updatedAt = now;
    await writeJsonAtomic(getSidecarPaths(projectRoot).storyEvents, graph);
    await appendEvent(projectRoot, { actor, type: "story.event_upserted", itemId: event.itemIds[0], data: { eventId: event.id, chapterId: event.chapterId, status: event.status, revision: event.revision } });
    return event;
  });
}

function cleanList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 100);
}

function normalizePositive(value: number | undefined): number | undefined {
  return value && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function hasDependencyCycle(events: Array<Pick<StoryEvent, "id" | "dependencyIds">>): boolean {
  const dependencies = new Map(events.map((event) => [event.id, event.dependencyIds]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependencyId of dependencies.get(id) ?? []) if (dependencies.has(dependencyId) && visit(dependencyId)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...dependencies.keys()].some(visit);
}

export async function connectStoryEvents(projectRoot: string, sourceEventId: string, targetEventId: string, actor: "user" | "codex" = "user"): Promise<StoryEvent> {
  await assertLegacyStoryMutationAllowed(projectRoot);
  if (sourceEventId === targetEventId) throw new Error("事件不能依赖自身。");
  const graph = await loadGraph(projectRoot);
  const target = graph.events.find((event) => event.id === targetEventId);
  if (!target || !graph.events.some((event) => event.id === sourceEventId)) throw new Error("事件连线端点不存在。");
  return upsertStoryEvent(projectRoot, { ...target, dependencyIds: [...new Set([...target.dependencyIds, sourceEventId])], expectedRevision: target.revision }, actor);
}

export async function buildStoryContext(projectRoot: string, itemId: string): Promise<StoryContextBundle> {
  const [index, graph, library] = await Promise.all([loadIndex(projectRoot), loadGraph(projectRoot), loadLibrary(projectRoot)]);
  if (!index) throw new Error("项目尚无真实扫描快照，请先扫描。");
  const item = index.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`找不到生产节点：${itemId}`);
  const direct = graph.events.filter((event) => event.status === "confirmed" && (event.itemIds.includes(itemId) || (event.episode === item.episode && (!event.unit || event.unit === item.unit))));
  const dependencyIds = new Set(direct.flatMap((event) => event.dependencyIds));
  const dependencies = graph.events.filter((event) => event.status === "confirmed" && dependencyIds.has(event.id));
  const events = [...dependencies, ...direct.filter((event) => !dependencyIds.has(event.id))].sort((a, b) => a.chapterId.localeCompare(b.chapterId) || a.order - b.order);
  const chapterMap = new Map(library.chapters.map((chapter) => [chapter.id, chapter]));
  const chapterExcerpts: StoryContextBundle["chapterExcerpts"] = [];
  for (const chapterIdValue of [...new Set(events.map((event) => event.chapterId))]) {
    const chapter = chapterMap.get(chapterIdValue);
    if (!chapter) continue;
    const content = await readProjectedStoryChapter(projectRoot, chapter);
    const anchors = events.filter((event) => event.chapterId === chapter.id).map((event) => event.sourceExcerpt).filter((value): value is string => Boolean(value));
    let chapterExcerpt = content.slice(0, 2_400);
    const anchor = anchors.find((value) => content.includes(value));
    if (anchor) {
      const at = content.indexOf(anchor);
      chapterExcerpt = content.slice(Math.max(0, at - 700), Math.min(content.length, at + anchor.length + 1_300));
    }
    chapterExcerpts.push({ chapter, excerpt: chapterExcerpt.trim() });
  }
  const hardLocks = index.project.hardLocks.filter((lock) => item.hardLockIds.includes(lock.id));
  const projectContext = await searchProjectContext(projectRoot, `${item.title} ${events.map((event) => `${event.title} ${event.characters.join(" ")} ${event.locations.join(" ")}`).join(" ")}`, 12);
  const eventText = events.length ? events.map((event) => `- ${event.id}｜${event.title}\n  ${event.description}\n  角色：${event.characters.join("、") || "未标注"}；场景：${event.locations.join("、") || "未标注"}；道具：${event.props.join("、") || "未标注"}`).join("\n") : "- 无已确认故事事件；不得把草稿候选当成剧情事实。";
  const chapterText = chapterExcerpts.map((entry) => `### ${entry.chapter.title}\n${entry.excerpt}`).join("\n\n") || "无已关联原文章节。";
  const prompt = `# 故事图谱上下文\n\n生产节点：${item.id}｜${item.title}\n状态：${item.status}\n下一动作：${item.nextAction}\n\n## 已确认事件\n${eventText}\n\n## 原文证据\n${chapterText}\n\n## 硬锁\n${hardLocks.map((lock) => `- ${lock.name}：${lock.path}\n  ${lock.note}`).join("\n") || "- 当前节点无显式硬锁"}\n\n## 使用边界\n- 只有 confirmed 事件可作为剧情事实。\n- 原文、明确项目记忆和真实节点发生冲突时停止并要求选择权威。\n- 不得用事件摘要替代节点的完整提示词、硬锁或机械验收。`;
  return { generatedAt: new Date().toISOString(), item, events, chapterExcerpts, hardLocks, projectContext, prompt };
}
