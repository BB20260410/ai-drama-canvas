import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  ensureConfinedDirectory,
  inspectExistingConfinedDirectory,
  moveConfinedFileNoReplaceCas,
  persistConfinedBytesNoReplace,
  persistConfinedBytesNoReplaceBatch,
  readConfinedRegularFileWithIdentity,
  replaceConfinedBytesCas,
  type ConfinedDirectoryIdentity,
  type ConfinedFileIdentity,
} from "./confined-project-storage.js";
import { withProjectLock } from "./locks.js";
import { attachNovelManifest, inspectManagedProjectReadOnly } from "./managed-project.js";
import {
  getNovelDerivedSearchStatus,
  novelSearchManifestDigest,
  queryNovelDerivedSearchCandidates,
  rebuildNovelDerivedSearchIndex,
} from "./novel-derived-search.js";
import { getOperationContext } from "./operation-context.js";
import {
  ensureNovelCreateTargetParent,
  normalizeNovelProjectLocator,
  readNovelProjectFile,
  resolveNovelProjectLocator,
  type NovelRegularFileIdentity,
} from "./novel-path-policy.js";
import {
  MANAGED_PROJECT_WRITER_SCHEMA_VERSION,
  NOVEL_CHAPTER_MANIFEST_RELATIVE_PATH,
  NOVEL_MANIFEST_RELATIVE_PATH,
  NOVEL_OFFSET_ENCODING,
  isNovelSourceMode,
  type CreateNovelChapterInput,
  type CreateNovelVolumeInput,
  type MoveNovelChapterInput,
  type NovelAttachReviewTicketInput,
  type NovelAcquireChapterWriteLeaseInput,
  type NovelChapterManifest,
  type NovelChapterReadResult,
  type NovelChapterRecord,
  type NovelChapterSearchResult,
  type NovelChapterWriteLeaseRuntime,
  type NovelInvalidateWritingStateFromInput,
  type NovelImportWritingSourceSnapshotInput,
  type NovelSourceMode,
  type NovelSearchIndexStatus,
  type NovelReviewChapterStateCandidateInput,
  type NovelReviewStoryBibleCandidateInput,
  type NovelSeedWritingStateInput,
  type NovelStageChapterStateCandidateInput,
  type NovelStageStoryBibleCandidateInput,
  type NovelVolumeRecord,
  type NovelWorkspaceManifest,
  type NovelWorkspaceSnapshot,
  type RenameNovelChapterInput,
  type ReorderNovelChaptersInput,
  type SaveNovelChapterInput,
  type SearchNovelChaptersInput,
} from "./novel-types.js";
export type { NovelWorkspaceSnapshot } from "./novel-types.js";
import {
  acquireNovelChapterWriteLease,
  assertNovelChapterWriteLease,
  attachNovelReviewTicket,
  invalidateNovelWritingStateFrom,
  recoverIncompleteNovelWritingStateOperations,
  reviewNovelChapterStateCandidate,
  reviewNovelStoryBibleCandidate,
  seedNovelWritingState,
  stageNovelChapterStateCandidate,
  stageNovelStoryBibleCandidate,
  validateNovelAiWriteContext,
} from "./novel-writing-state.js";
import { importNovelWritingSourceSnapshot } from "./novel-writing-source-import.js";

const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_CHAPTER_BYTES = 64 * 1024 * 1024;
const MAX_SEARCH_QUERY_CHARACTERS = 200;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_HITS_PER_CHAPTER = 20;
const SEARCH_READ_CONCURRENCY = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const OPERATIONS_LOCATOR = ".aicanvas/novel/operations";
const OPERATION_LAYOUT_LOCATOR = `${OPERATIONS_LOCATOR}/layout.json`;
const OPERATION_PENDING_LOCATOR = `${OPERATIONS_LOCATOR}/pending`;
const OPERATION_COMPLETED_MARKERS_LOCATOR = `${OPERATIONS_LOCATOR}/completed-markers`;
const HISTORY_CHAPTERS_LOCATOR = ".aicanvas/history/story/chapters";
const HISTORY_MANIFESTS_LOCATOR = ".aicanvas/history/story/manifests/sha256";

interface NovelMutationIntent {
  schemaVersion: 1;
  kind: "novel-manuscript-mutation-intent";
  operationId: string;
  requestHash: string;
  command: "save" | "create" | "create_volume" | "rename" | "move" | "reorder";
  projectId: string;
  beforeManifestSha256: string;
  afterManifestSha256: string;
  fileMutation:
    | { kind: "none" }
    | {
      kind: "replace";
      sourceLocator: string;
      beforeSha256: string;
      beforeSize: number;
      afterSha256: string;
      afterSize: number;
      contentObjectName: string;
    }
    | {
      kind: "create";
      targetLocator: string;
      afterSha256: string;
      afterSize: number;
      contentObjectName: string;
    }
    | {
      kind: "move";
      sourceLocator: string;
      targetLocator: string;
      sha256: string;
      size: number;
    };
  createdAt: string;
  fingerprint: string;
}

interface NovelMutationReceipt {
  schemaVersion: 1;
  kind: "novel-manuscript-mutation-receipt";
  operationId: string;
  requestHash: string;
  command: NovelMutationIntent["command"];
  projectId: string;
  manifestRevision: number;
  manifestSha256: string;
  completedAt: string;
  intentFingerprint: string;
  fingerprint: string;
}

interface NovelMutationOperationLayout {
  schemaVersion: 1;
  kind: "novel-manuscript-operation-layout";
  projectId: string;
  strategy: "pending-markers-v1";
  initializedAt: string;
  fingerprint: string;
}

interface NovelMutationOperationMarker {
  schemaVersion: 1;
  kind: "novel-manuscript-operation-marker";
  operationId: string;
  requestHash: string;
  command: NovelMutationIntent["command"];
  projectId: string;
  intentFingerprint: string;
  createdAt: string;
  fingerprint: string;
}

interface NovelWorkspaceInitializationIntent {
  schemaVersion: 1;
  kind: "novel-workspace-initialization-intent";
  requestHash: string;
  projectId: string;
  sourceMode: NovelSourceMode;
  volumeId: string;
  createdAt: string;
  fingerprint: string;
}

export type NovelPreconditionRejectionReason =
  | "revision_conflict"
  | "content_conflict"
  | "external_change"
  | "not_found"
  | "read_only"
  | "invalid_target"
  | "workflow_mode_forbidden";

export class NovelPreconditionRejectedError extends Error {
  readonly result: {
    schemaVersion: 1;
    applied: false;
    entityType: "novel_manuscript";
    reason: NovelPreconditionRejectionReason;
    chapterId?: string;
    volumeId?: string;
    expectedRevision?: number;
    currentRevision?: number;
    expectedSha256?: string;
    currentSha256?: string;
  };

  constructor(
    message: string,
    detail: Omit<NovelPreconditionRejectedError["result"], "schemaVersion" | "applied" | "entityType">,
  ) {
    super(message);
    this.name = "NovelPreconditionRejectedError";
    this.result = {
      schemaVersion: 1,
      applied: false,
      entityType: "novel_manuscript",
      ...detail,
    };
  }
}

export function isNovelPreconditionRejectedError(error: unknown): error is NovelPreconditionRejectedError {
  return error instanceof NovelPreconditionRejectedError;
}

interface InitializedWorkspaceResult {
  workspace: NovelWorkspaceManifest;
  chapters: NovelChapterManifest | null;
}

export interface NovelVolumeNavigationItem extends NovelVolumeRecord {
  chapterCount: number;
  charCount: number;
}

export interface NovelWorkspaceNavigation {
  workspace: NovelWorkspaceManifest;
  manifestRevision: number | null;
  totals: {
    volumeCount: number;
    chapterCount: number;
    charCount: number;
  };
  volumes: {
    total: number;
    offset: number;
    limit: number;
    items: NovelVolumeNavigationItem[];
  };
}

export interface NovelMutationResult {
  chapter?: NovelChapterRecord;
  manifest: NovelChapterManifest;
  replayed: boolean;
  changed: boolean;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function nextManifestTimestamp(manifest: NovelChapterManifest): string {
  const prior = Date.parse(manifest.updatedAt);
  if (!Number.isFinite(prior) || prior >= 8_640_000_000_000_000) {
    throw new Error("无法为小说 manifest 生成下一个确定性时间戳。");
  }
  return new Date(prior + 1).toISOString();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} 不是有效 UTF-8 JSON。`, { cause: error });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (actual.length !== canonicalExpected.length
    || actual.some((entry, index) => entry !== canonicalExpected[index])) {
    throw new Error(`${label} 字段集合无效。`);
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return fingerprint(left) === fingerprint(right);
}

function rejectNovelPrecondition(
  message: string,
  detail: ConstructorParameters<typeof NovelPreconditionRejectedError>[1],
): never {
  throw new NovelPreconditionRejectedError(message, detail);
}

function assertIsoDate(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new Error(`${label} 必须是规范 ISO 时间。`);
  }
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`${label} 必须是 UUID。`);
}

function assertProjectId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 240
    || value !== value.trim() || /[\p{Cc}/\\]/u.test(value)) {
    throw new Error(`${label} 无效。`);
  }
}

function assertSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error(`${label} SHA-256 无效。`);
}

function assertInteger(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label} 必须是有效整数。`);
}

function normalizeTitle(value: string, label = "标题"): string {
  const normalized = typeof value === "string" ? value.normalize("NFC").trim() : "";
  if (!normalized || normalized.length > 200 || /\p{Cc}/u.test(normalized)) {
    throw new Error(`${label} 为空、过长或包含控制字符。`);
  }
  return normalized;
}

function contentBytes(content: string): Buffer {
  if (typeof content !== "string") throw new Error("章节正文必须是字符串。");
  const bytes = Buffer.from(content, "utf8");
  const roundTrip = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (roundTrip !== content) throw new Error("章节正文包含无法 UTF-8 往返的字符。");
  if (bytes.byteLength > MAX_CHAPTER_BYTES) throw new Error("单章正文超过 64MB 上限。");
  return bytes;
}

function validateVolume(value: unknown): NovelVolumeRecord {
  if (!record(value)) throw new Error("卷记录无效。");
  assertExactKeys(value, ["volumeId", "title", "order", "revision"], "卷记录");
  assertUuid(value.volumeId, "volumeId");
  const title = normalizeTitle(String(value.title ?? ""), "卷标题");
  assertInteger(value.order, "volume.order");
  assertInteger(value.revision, "volume.revision", 1);
  return { volumeId: value.volumeId, title, order: value.order, revision: value.revision };
}

function validateChapter(value: unknown): NovelChapterRecord {
  if (!record(value)) throw new Error("章节记录无效。");
  assertExactKeys(value, [
    "chapterId", "volumeId", "title", "order", "relativePath", "sha256", "byteLength",
    "charCount", "offsetEncoding", "revision", "createdAt", "updatedAt",
    ...(value.sourceReceiptId === undefined ? [] : ["sourceReceiptId"]),
  ], "章节记录");
  assertUuid(value.chapterId, "chapterId");
  assertUuid(value.volumeId, "chapter.volumeId");
  const title = normalizeTitle(String(value.title ?? ""), "章节标题");
  assertInteger(value.order, "chapter.order");
  if (typeof value.relativePath !== "string") throw new Error("章节 locator 无效。");
  const relativePath = normalizeNovelProjectLocator(value.relativePath);
  const expectedPath = `manuscript/volumes/${value.volumeId}/${value.chapterId}.md`;
  if (relativePath !== expectedPath) throw new Error("章节 locator 与 stable ID 不一致。");
  assertSha(value.sha256, "chapter");
  assertInteger(value.byteLength, "chapter.byteLength");
  assertInteger(value.charCount, "chapter.charCount");
  assertInteger(value.revision, "chapter.revision", 1);
  if (value.offsetEncoding !== NOVEL_OFFSET_ENCODING) throw new Error("章节偏移编码声明无效。");
  assertIsoDate(value.createdAt, "chapter.createdAt");
  assertIsoDate(value.updatedAt, "chapter.updatedAt");
  if (value.sourceReceiptId !== undefined && typeof value.sourceReceiptId !== "string") {
    throw new Error("chapter.sourceReceiptId 无效。");
  }
  return {
    chapterId: value.chapterId,
    volumeId: value.volumeId,
    title,
    order: value.order,
    relativePath,
    sha256: value.sha256,
    byteLength: value.byteLength,
    charCount: value.charCount,
    offsetEncoding: NOVEL_OFFSET_ENCODING,
    revision: value.revision,
    ...(value.sourceReceiptId ? { sourceReceiptId: value.sourceReceiptId } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function validateChapterManifest(value: unknown, projectId: string): NovelChapterManifest {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "novel-chapter-manifest"
    || value.projectId !== projectId || !Array.isArray(value.volumes) || !Array.isArray(value.chapters)) {
    throw new Error("小说章节 manifest 结构或项目身份无效。");
  }
  assertExactKeys(value, [
    "schemaVersion", "kind", "projectId", "revision", "volumes", "chapters", "updatedAt",
  ], "小说章节 manifest");
  assertInteger(value.revision, "manifest.revision", 1);
  assertIsoDate(value.updatedAt, "manifest.updatedAt");
  const volumes = value.volumes.map(validateVolume);
  const chapters = value.chapters.map(validateChapter);
  const volumeIds = new Set(volumes.map((entry) => entry.volumeId));
  if (volumeIds.size !== volumes.length || new Set(chapters.map((entry) => entry.chapterId)).size !== chapters.length) {
    throw new Error("卷或章节 stable ID 重复。");
  }
  if (chapters.some((entry) => !volumeIds.has(entry.volumeId))) throw new Error("章节引用不存在的卷。");
  if (new Set(chapters.map((entry) => entry.relativePath)).size !== chapters.length) {
    throw new Error("章节 locator 重复。");
  }
  const volumeOrders = volumes.map((entry) => entry.order).sort((left, right) => left - right);
  if (volumeOrders.some((entry, index) => entry !== index)) throw new Error("卷 order 必须连续且唯一。");
  for (const volume of volumes) {
    const orders = chapters.filter((entry) => entry.volumeId === volume.volumeId)
      .map((entry) => entry.order)
      .sort((left, right) => left - right);
    if (orders.some((entry, index) => entry !== index)) throw new Error("卷内章节 order 必须连续且唯一。");
  }
  return {
    schemaVersion: 1,
    kind: "novel-chapter-manifest",
    projectId,
    revision: value.revision,
    volumes,
    chapters,
    updatedAt: value.updatedAt,
  };
}

function validateWorkspace(value: unknown, projectId: string): NovelWorkspaceManifest {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "novel-workspace-manifest"
    || value.projectId !== projectId || !isNovelSourceMode(value.sourceMode)
    || !Array.isArray(value.sourceReceiptIds)
    || !value.sourceReceiptIds.every((entry) => typeof entry === "string")) {
    throw new Error("小说工作区 manifest 结构或项目身份无效。");
  }
  if (value.sourceMode === "managed_markdown" && value.chapterManifest !== NOVEL_CHAPTER_MANIFEST_RELATIVE_PATH) {
    throw new Error("managed_markdown 必须声明固定章节 manifest。");
  }
  if (value.sourceMode === "external_snapshot" && value.chapterManifest !== undefined) {
    throw new Error("external_snapshot 不得冒充可写正文。");
  }
  assertInteger(value.revision, "workspace.revision", 1);
  assertIsoDate(value.createdAt, "workspace.createdAt");
  assertIsoDate(value.updatedAt, "workspace.updatedAt");
  assertSha(value.fingerprint, "workspace.fingerprint");
  const payload = { ...value };
  delete payload.fingerprint;
  if (fingerprint(payload) !== value.fingerprint) throw new Error("小说工作区 fingerprint 不匹配。");
  return value as unknown as NovelWorkspaceManifest;
}

async function requireNovelShell(projectRoot: string) {
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  if ((shell.workspaceMode !== "novel" && shell.workspaceMode !== "hybrid")
    || shell.manifest.minimumWriterSchemaVersion !== MANAGED_PROJECT_WRITER_SCHEMA_VERSION) {
    throw new Error("小说 Repository 只允许 schema v2 novel/hybrid 工程。");
  }
  return shell;
}

function requireMutationContext(): { requestHash: string; command: string } {
  const context = getOperationContext();
  if (!context || !SHA256_PATTERN.test(context.requestHash)
    || !context.command.startsWith("novel_")) {
    throw new Error("小说正典写入必须由 command bus 的 novel 命令上下文执行。");
  }
  return context;
}

function maybeInterruptNovelMutationForTests(phase: "after-file-mutation" | "after-manifest"): void {
  if (process.env.NODE_ENV === "test"
    && process.env.AI_CANVAS_TEST_NOVEL_MUTATION_INTERRUPT === phase) {
    throw new Error(`test-only novel mutation interruption: ${phase}`);
  }
}

type NovelOperationPersistencePhase = "after-operation-directory" | "after-content" | "after-manifest" | "after-intent";

function maybeInterruptNovelOperationPersistenceForTests(phase: NovelOperationPersistencePhase): void {
  if (process.env.NODE_ENV === "test"
    && process.env.AI_CANVAS_TEST_NOVEL_OPERATION_PERSIST_INTERRUPT === phase) {
    throw new Error(`test-only novel operation persistence interruption: ${phase}`);
  }
}

type NovelInitializationPhase = "after-chapters" | "after-workspace" | "after-attach";

function maybeInterruptNovelInitializationForTests(phase: NovelInitializationPhase): void {
  if (process.env.NODE_ENV === "test"
    && process.env.AI_CANVAS_TEST_NOVEL_INITIALIZE_INTERRUPT === phase) {
    throw new Error(`test-only novel initialization interruption: ${phase}`);
  }
}

async function existingDirectoryForLocator(projectRoot: string, locator: string): Promise<ConfinedDirectoryIdentity> {
  const target = resolveNovelProjectLocator(projectRoot, locator);
  return inspectExistingConfinedDirectory(projectRoot, path.dirname(target.absolutePath));
}

async function readSingleLinkArtifact(
  directory: ConfinedDirectoryIdentity,
  name: string,
  maxBytes: number,
  label: string,
) {
  const read = await readConfinedRegularFileWithIdentity(directory, name, maxBytes);
  if (read.nlink !== 1) throw new Error(`${label} 必须是 nlink=1 的独占普通文件。`);
  return read;
}

async function readSingleLinkArtifactLocator(
  projectRoot: string,
  locator: string,
  maxBytes: number,
  label: string,
) {
  const target = resolveNovelProjectLocator(projectRoot, locator);
  const directory = await inspectExistingConfinedDirectory(projectRoot, path.dirname(target.absolutePath));
  return readSingleLinkArtifact(directory, path.basename(target.absolutePath), maxBytes, label);
}

async function readOptionalSingleLinkArtifactLocator(
  projectRoot: string,
  locator: string,
  maxBytes: number,
  label: string,
) {
  return readSingleLinkArtifactLocator(projectRoot, locator, maxBytes, label).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
}

async function readWorkspaceAndManifest(projectRoot: string): Promise<NovelWorkspaceSnapshot> {
  const shell = await requireNovelShell(projectRoot);
  const workspaceRead = await readNovelProjectFile(projectRoot, NOVEL_MANIFEST_RELATIVE_PATH, { maxBytes: MAX_MANIFEST_BYTES });
  const workspace = validateWorkspace(parseJson(workspaceRead.bytes, "novel workspace manifest"), shell.project.id);
  if (workspace.sourceMode === "external_snapshot") return { workspace, chapters: null };
  const chapterRead = await readNovelProjectFile(projectRoot, NOVEL_CHAPTER_MANIFEST_RELATIVE_PATH, { maxBytes: MAX_MANIFEST_BYTES });
  return {
    workspace,
    chapters: validateChapterManifest(parseJson(chapterRead.bytes, "chapter manifest"), shell.project.id),
  };
}

function workspaceWithFingerprint(
  value: Omit<NovelWorkspaceManifest, "fingerprint">,
): NovelWorkspaceManifest {
  return { ...value, fingerprint: fingerprint(value) };
}

async function readAndValidateImportedChapterClosure(
  projectRoot: string,
  projectId: string,
  expectedChapterManifestSha256: string,
): Promise<NovelChapterManifest> {
  const manifestRead = await readNovelProjectFile(
    projectRoot,
    NOVEL_CHAPTER_MANIFEST_RELATIVE_PATH,
    { maxBytes: MAX_MANIFEST_BYTES },
  );
  if (manifestRead.sha256 !== expectedChapterManifestSha256) {
    throw new Error("已发布 chapter manifest SHA 与导入计划不一致。");
  }
  const chapters = validateChapterManifest(parseJson(manifestRead.bytes, "imported chapter manifest"), projectId);
  for (const chapter of chapters.chapters) {
    const read = await readNovelProjectFile(projectRoot, chapter.relativePath, { maxBytes: MAX_CHAPTER_BYTES });
    const text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    if (read.sha256 !== chapter.sha256 || read.bytes.byteLength !== chapter.byteLength || text.length !== chapter.charCount) {
      throw new Error(`导入章节闭包对账失败：${chapter.chapterId}`);
    }
  }
  return chapters;
}

async function persistLocatorNoReplace(projectRoot: string, locator: string, bytes: Buffer) {
  const target = await ensureNovelCreateTargetParent(projectRoot, locator);
  return persistConfinedBytesNoReplace(target.parent, target.name, bytes);
}

async function persistLocatorNoReplaceOrVerify(
  projectRoot: string,
  locator: string,
  bytes: Buffer,
  label: string,
): Promise<void> {
  const existing = await readSingleLinkArtifactLocator(projectRoot, locator, bytes.byteLength, label)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
  if (existing) {
    if (!existing.bytes.equals(bytes)) throw new Error(`${label} 已存在但与初始化 intent 计划不一致。`);
    return;
  }
  await persistLocatorNoReplace(projectRoot, locator, bytes);
}

async function persistHistory(
  projectRoot: string,
  manifestBytes: Buffer,
  chapter?: { chapterId: string; bytes: Buffer; sha256: string },
): Promise<void> {
  const manifestSha = sha256(manifestBytes);
  const manifestDirectory = await ensureConfinedDirectory(
    projectRoot,
    resolveNovelProjectLocator(projectRoot, HISTORY_MANIFESTS_LOCATOR).absolutePath,
  );
  await persistConfinedBytesNoReplace(manifestDirectory, `${manifestSha}.json`, manifestBytes);
  if (chapter) {
    const chapterDirectory = await ensureConfinedDirectory(
      projectRoot,
      resolveNovelProjectLocator(projectRoot, `${HISTORY_CHAPTERS_LOCATOR}/${chapter.chapterId}/sha256`).absolutePath,
    );
    await persistConfinedBytesNoReplace(chapterDirectory, `${chapter.sha256}.md`, chapter.bytes);
  }
}

function intentPayload(value: Omit<NovelMutationIntent, "fingerprint">): NovelMutationIntent {
  return { ...value, fingerprint: fingerprint(value) };
}

function validateFileMutation(value: unknown): NovelMutationIntent["fileMutation"] {
  if (!record(value) || typeof value.kind !== "string") throw new Error("intent.fileMutation 无效。");
  if (value.kind === "none") {
    assertExactKeys(value, ["kind"], "intent.fileMutation.none");
    return { kind: "none" };
  }
  if (value.kind === "replace") {
    assertExactKeys(value, [
      "kind", "sourceLocator", "beforeSha256", "beforeSize", "afterSha256", "afterSize", "contentObjectName",
    ], "intent.fileMutation.replace");
    if (typeof value.sourceLocator !== "string") throw new Error("replace sourceLocator 无效。");
    const sourceLocator = normalizeNovelProjectLocator(value.sourceLocator);
    assertSha(value.beforeSha256, "replace.before");
    assertSha(value.afterSha256, "replace.after");
    assertInteger(value.beforeSize, "replace.beforeSize");
    assertInteger(value.afterSize, "replace.afterSize");
    if (value.contentObjectName !== "after-content.bin") throw new Error("replace contentObjectName 无效。");
    return {
      kind: "replace",
      sourceLocator,
      beforeSha256: value.beforeSha256,
      beforeSize: value.beforeSize,
      afterSha256: value.afterSha256,
      afterSize: value.afterSize,
      contentObjectName: "after-content.bin",
    };
  }
  if (value.kind === "create") {
    assertExactKeys(value, [
      "kind", "targetLocator", "afterSha256", "afterSize", "contentObjectName",
    ], "intent.fileMutation.create");
    if (typeof value.targetLocator !== "string") throw new Error("create targetLocator 无效。");
    const targetLocator = normalizeNovelProjectLocator(value.targetLocator);
    assertSha(value.afterSha256, "create.after");
    assertInteger(value.afterSize, "create.afterSize");
    if (value.contentObjectName !== "after-content.bin") throw new Error("create contentObjectName 无效。");
    return {
      kind: "create",
      targetLocator,
      afterSha256: value.afterSha256,
      afterSize: value.afterSize,
      contentObjectName: "after-content.bin",
    };
  }
  if (value.kind === "move") {
    assertExactKeys(value, ["kind", "sourceLocator", "targetLocator", "sha256", "size"], "intent.fileMutation.move");
    if (typeof value.sourceLocator !== "string" || typeof value.targetLocator !== "string") {
      throw new Error("move locator 无效。");
    }
    const sourceLocator = normalizeNovelProjectLocator(value.sourceLocator);
    const targetLocator = normalizeNovelProjectLocator(value.targetLocator);
    if (sourceLocator === targetLocator) throw new Error("move source/target locator 不得相同。");
    assertSha(value.sha256, "move");
    assertInteger(value.size, "move.size");
    return { kind: "move", sourceLocator, targetLocator, sha256: value.sha256, size: value.size };
  }
  throw new Error("intent.fileMutation kind 无效。");
}

function validateIntent(value: unknown): NovelMutationIntent {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "novel-manuscript-mutation-intent"
    || typeof value.operationId !== "string" || !SHA256_PATTERN.test(value.requestHash as string)
    || !["save", "create", "create_volume", "rename", "move", "reorder"].includes(String(value.command))
    || typeof value.projectId !== "string" || !record(value.fileMutation)) {
    throw new Error("小说正文 mutation intent 无效。");
  }
  assertExactKeys(value, [
    "schemaVersion", "kind", "operationId", "requestHash", "command", "projectId",
    "beforeManifestSha256", "afterManifestSha256", "fileMutation", "createdAt", "fingerprint",
  ], "小说正文 mutation intent");
  assertUuid(value.operationId, "intent.operationId");
  assertProjectId(value.projectId, "intent.projectId");
  assertSha(value.beforeManifestSha256, "intent.beforeManifest");
  assertSha(value.afterManifestSha256, "intent.afterManifest");
  if (value.beforeManifestSha256 === value.afterManifestSha256) throw new Error("intent before/after manifest 不得相同。");
  assertIsoDate(value.createdAt, "intent.createdAt");
  assertSha(value.fingerprint, "intent.fingerprint");
  const payload = { ...value };
  delete payload.fingerprint;
  if (fingerprint(payload) !== value.fingerprint) throw new Error("mutation intent fingerprint 不匹配。");
  return {
    schemaVersion: 1,
    kind: "novel-manuscript-mutation-intent",
    operationId: value.operationId,
    requestHash: value.requestHash as string,
    command: value.command as NovelMutationIntent["command"],
    projectId: value.projectId,
    beforeManifestSha256: value.beforeManifestSha256,
    afterManifestSha256: value.afterManifestSha256,
    fileMutation: validateFileMutation(value.fileMutation),
    createdAt: value.createdAt,
    fingerprint: value.fingerprint,
  };
}

function validateReceipt(value: unknown): NovelMutationReceipt {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "novel-manuscript-mutation-receipt") {
    throw new Error("小说 mutation completed receipt 无效。");
  }
  assertExactKeys(value, [
    "schemaVersion", "kind", "operationId", "requestHash", "command", "projectId",
    "manifestRevision", "manifestSha256", "completedAt", "intentFingerprint", "fingerprint",
  ], "小说 mutation completed receipt");
  assertUuid(value.operationId, "receipt.operationId");
  if (typeof value.requestHash !== "string") throw new Error("receipt.requestHash 无效。");
  assertSha(value.requestHash, "receipt.requestHash");
  if (!["save", "create", "create_volume", "rename", "move", "reorder"].includes(String(value.command))) {
    throw new Error("receipt.command 无效。");
  }
  assertProjectId(value.projectId, "receipt.projectId");
  assertInteger(value.manifestRevision, "receipt.manifestRevision", 1);
  assertSha(value.manifestSha256, "receipt.manifest");
  assertIsoDate(value.completedAt, "receipt.completedAt");
  assertSha(value.intentFingerprint, "receipt.intentFingerprint");
  assertSha(value.fingerprint, "receipt.fingerprint");
  const payload = { ...value };
  delete payload.fingerprint;
  if (fingerprint(payload) !== value.fingerprint) throw new Error("completed receipt fingerprint 不匹配。");
  return value as unknown as NovelMutationReceipt;
}

function validateOperationLayout(value: unknown, expectedProjectId: string): NovelMutationOperationLayout {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "novel-manuscript-operation-layout"
    || value.projectId !== expectedProjectId || value.strategy !== "pending-markers-v1"
    || typeof value.initializedAt !== "string" || !Number.isFinite(Date.parse(value.initializedAt))
    || typeof value.fingerprint !== "string") {
    throw new Error("小说 operation layout 结构或工程身份无效。");
  }
  assertExactKeys(value, [
    "schemaVersion", "kind", "projectId", "strategy", "initializedAt", "fingerprint",
  ], "小说 operation layout");
  assertSha(value.fingerprint, "operation layout fingerprint");
  const semantic = { ...value };
  delete semantic.fingerprint;
  if (fingerprint(semantic) !== value.fingerprint) throw new Error("小说 operation layout fingerprint 不匹配。");
  return value as unknown as NovelMutationOperationLayout;
}

function validateOperationMarker(value: unknown): NovelMutationOperationMarker {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "novel-manuscript-operation-marker"
    || typeof value.operationId !== "string" || !SHA256_PATTERN.test(String(value.requestHash))
    || !["save", "create", "create_volume", "rename", "move", "reorder"].includes(String(value.command))
    || typeof value.projectId !== "string" || !SHA256_PATTERN.test(String(value.intentFingerprint))
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.fingerprint !== "string") {
    throw new Error("小说 operation marker 结构无效。");
  }
  assertExactKeys(value, [
    "schemaVersion", "kind", "operationId", "requestHash", "command", "projectId",
    "intentFingerprint", "createdAt", "fingerprint",
  ], "小说 operation marker");
  assertSha(value.fingerprint, "operation marker fingerprint");
  const semantic = { ...value };
  delete semantic.fingerprint;
  if (fingerprint(semantic) !== value.fingerprint) throw new Error("小说 operation marker fingerprint 不匹配。");
  return value as unknown as NovelMutationOperationMarker;
}

function operationMarkerForIntent(intent: NovelMutationIntent): NovelMutationOperationMarker {
  const semantic: Omit<NovelMutationOperationMarker, "fingerprint"> = {
    schemaVersion: 1,
    kind: "novel-manuscript-operation-marker",
    operationId: intent.operationId,
    requestHash: intent.requestHash,
    command: intent.command,
    projectId: intent.projectId,
    intentFingerprint: intent.fingerprint,
    createdAt: intent.createdAt,
  };
  return { ...semantic, fingerprint: fingerprint(semantic) };
}

function operationMarkerLocator(bucket: "pending" | "completed-markers", requestHash: string): string {
  const root = bucket === "pending" ? OPERATION_PENDING_LOCATOR : OPERATION_COMPLETED_MARKERS_LOCATOR;
  return `${root}/${requestHash}.json`;
}

function assertOperationMarkerMatchesIntent(
  marker: NovelMutationOperationMarker,
  intent: NovelMutationIntent,
): void {
  if (marker.operationId !== intent.operationId || marker.requestHash !== intent.requestHash
    || marker.command !== intent.command || marker.projectId !== intent.projectId
    || marker.intentFingerprint !== intent.fingerprint || marker.createdAt !== intent.createdAt) {
    throw new Error("小说 operation marker 与 intent 不一致。");
  }
}

async function loadOperationLayout(
  projectRoot: string,
  expectedProjectId: string,
): Promise<NovelMutationOperationLayout | null> {
  const read = await readOptionalSingleLinkArtifactLocator(
    projectRoot,
    OPERATION_LAYOUT_LOCATOR,
    MAX_MANIFEST_BYTES,
    "operation layout",
  );
  return read ? validateOperationLayout(parseJson(read.bytes, "operation layout"), expectedProjectId) : null;
}

async function persistOperationLayout(projectRoot: string, expectedProjectId: string): Promise<void> {
  const semantic: Omit<NovelMutationOperationLayout, "fingerprint"> = {
    schemaVersion: 1,
    kind: "novel-manuscript-operation-layout",
    projectId: expectedProjectId,
    strategy: "pending-markers-v1",
    initializedAt: new Date().toISOString(),
  };
  const layout = { ...semantic, fingerprint: fingerprint(semantic) };
  await persistLocatorNoReplaceOrVerify(
    projectRoot,
    OPERATION_LAYOUT_LOCATOR,
    jsonBytes(layout),
    "operation layout",
  );
}

async function registerOperationPending(projectRoot: string, intent: NovelMutationIntent): Promise<void> {
  if (!await loadOperationLayout(projectRoot, intent.projectId)) {
    throw new Error("小说 operation pending 登记前缺少 layout。");
  }
  const marker = operationMarkerForIntent(intent);
  const markerBytes = jsonBytes(marker);
  const completed = await readOptionalSingleLinkArtifactLocator(
    projectRoot,
    operationMarkerLocator("completed-markers", intent.requestHash),
    markerBytes.byteLength,
    "completed operation marker",
  );
  if (completed) {
    assertOperationMarkerMatchesIntent(validateOperationMarker(parseJson(completed.bytes, "completed operation marker")), intent);
    return;
  }
  await persistLocatorNoReplaceOrVerify(
    projectRoot,
    operationMarkerLocator("pending", intent.requestHash),
    markerBytes,
    "pending operation marker",
  );
}

async function finalizeOperationPending(projectRoot: string, intent: NovelMutationIntent): Promise<boolean> {
  if (!await loadOperationLayout(projectRoot, intent.projectId)) return false;
  const expectedMarker = operationMarkerForIntent(intent);
  const expectedBytes = jsonBytes(expectedMarker);
  const pendingLocator = operationMarkerLocator("pending", intent.requestHash);
  const completedLocator = operationMarkerLocator("completed-markers", intent.requestHash);
  const [pending, completed] = await Promise.all([
    readOptionalSingleLinkArtifactLocator(projectRoot, pendingLocator, expectedBytes.byteLength, "pending operation marker"),
    readOptionalSingleLinkArtifactLocator(projectRoot, completedLocator, expectedBytes.byteLength, "completed operation marker"),
  ]);
  if (completed) {
    assertOperationMarkerMatchesIntent(validateOperationMarker(parseJson(completed.bytes, "completed operation marker")), intent);
    if (pending) throw new Error("小说 operation marker 同时存在 pending/completed 分叉。");
    return false;
  }
  if (!pending) return false;
  const marker = validateOperationMarker(parseJson(pending.bytes, "pending operation marker"));
  assertOperationMarkerMatchesIntent(marker, intent);
  if (!pending.bytes.equals(expectedBytes)) throw new Error("小说 pending operation marker 字节身份不一致。");
  const completedTarget = await ensureNovelCreateTargetParent(projectRoot, completedLocator);
  await moveConfinedFileNoReplaceCas(
    pending.identity,
    sha256(pending.bytes),
    pending.bytes.byteLength,
    completedTarget.parent,
    completedTarget.name,
  );
  return true;
}

function validateInitializationIntent(value: unknown): NovelWorkspaceInitializationIntent {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "novel-workspace-initialization-intent") {
    throw new Error("小说初始化 intent 结构无效。");
  }
  assertExactKeys(value, [
    "schemaVersion", "kind", "requestHash", "projectId", "sourceMode", "volumeId", "createdAt", "fingerprint",
  ], "小说初始化 intent");
  assertSha(value.requestHash, "initialization.requestHash");
  assertProjectId(value.projectId, "initialization.projectId");
  if (!isNovelSourceMode(value.sourceMode)) throw new Error("初始化 sourceMode 无效。");
  assertUuid(value.volumeId, "initialization.volumeId");
  assertIsoDate(value.createdAt, "initialization.createdAt");
  assertSha(value.fingerprint, "initialization.fingerprint");
  const payload = { ...value };
  delete payload.fingerprint;
  if (fingerprint(payload) !== value.fingerprint) throw new Error("小说初始化 intent fingerprint 不匹配。");
  return value as unknown as NovelWorkspaceInitializationIntent;
}

function requireSame(left: unknown, right: unknown, label: string): void {
  if (!sameValue(left, right)) throw new Error(`mutation intent 非法修改 ${label}。`);
}

function chapterById(manifest: NovelChapterManifest, chapterId: string): NovelChapterRecord | undefined {
  return manifest.chapters.find((entry) => entry.chapterId === chapterId);
}

function validateContentObjectAgainstChapter(
  bytes: Buffer | undefined,
  chapter: NovelChapterRecord,
  label: string,
): void {
  if (!bytes) throw new Error(`${label} 缺少 after-content 工件。`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (sha256(bytes) !== chapter.sha256 || bytes.byteLength !== chapter.byteLength || text.length !== chapter.charCount) {
    throw new Error(`${label} after-content 与章节记录不一致。`);
  }
}

function validateAllowedManifestTransition(
  intent: NovelMutationIntent,
  before: NovelChapterManifest,
  after: NovelChapterManifest,
  afterContent?: Buffer,
): void {
  if (before.projectId !== intent.projectId || after.projectId !== intent.projectId) {
    throw new Error("mutation manifest projectId 与 intent 不一致。");
  }
  if (after.revision !== before.revision + 1) throw new Error("after manifest revision 必须严格等于 before + 1。");
  if (Date.parse(after.updatedAt) < Date.parse(before.updatedAt)) throw new Error("after manifest updatedAt 早于 before。");

  const mutation = intent.fileMutation;
  if (intent.command === "save") {
    if (mutation.kind !== "replace") throw new Error("save intent 必须使用 replace fileMutation。");
    requireSame(after.volumes, before.volumes, "save.volumes");
    if (after.chapters.length !== before.chapters.length) throw new Error("save 不得增删章节。");
    const prior = before.chapters.find((entry) => entry.relativePath === mutation.sourceLocator);
    if (!prior) throw new Error("save replace locator 不属于 before 章节。");
    const next = chapterById(after, prior.chapterId);
    if (!next) throw new Error("save after 缺少目标章节。");
    if (mutation.beforeSha256 !== prior.sha256 || mutation.beforeSize !== prior.byteLength
      || mutation.afterSha256 !== next.sha256 || mutation.afterSize !== next.byteLength) {
      throw new Error("save fileMutation 与 before/after 章节记录不一致。");
    }
    const expectedNext: NovelChapterRecord = {
      ...prior,
      sha256: mutation.afterSha256,
      byteLength: mutation.afterSize,
      charCount: next.charCount,
      revision: prior.revision + 1,
      updatedAt: after.updatedAt,
    };
    requireSame(next, expectedNext, "save.chapter");
    requireSame(after.chapters, before.chapters.map((entry) => entry.chapterId === prior.chapterId ? expectedNext : entry), "save.chapters");
    validateContentObjectAgainstChapter(afterContent, next, "save");
    return;
  }

  if (intent.command === "create") {
    if (mutation.kind !== "create") throw new Error("create intent 必须使用 create fileMutation。");
    requireSame(after.volumes, before.volumes, "create.volumes");
    if (after.chapters.length !== before.chapters.length + 1) throw new Error("create 必须且只能增加一个章节。");
    const beforeIds = new Set(before.chapters.map((entry) => entry.chapterId));
    const added = after.chapters.filter((entry) => !beforeIds.has(entry.chapterId));
    if (added.length !== 1) throw new Error("create 无法唯一识别新增章节。");
    const chapter = added[0]!;
    if (chapter.relativePath !== mutation.targetLocator || chapter.sha256 !== mutation.afterSha256
      || chapter.byteLength !== mutation.afterSize || chapter.revision !== 1
      || chapter.createdAt !== after.updatedAt || chapter.updatedAt !== after.updatedAt) {
      throw new Error("create fileMutation 与新增章节记录不一致。");
    }
    const siblingCount = before.chapters.filter((entry) => entry.volumeId === chapter.volumeId).length;
    if (!after.volumes.some((entry) => entry.volumeId === chapter.volumeId)
      || chapter.order < 0 || chapter.order > siblingCount) {
      throw new Error("create 新章节目标卷或 order 无效。");
    }
    const expectedExisting = before.chapters.map((entry) => entry.volumeId === chapter.volumeId && entry.order >= chapter.order
      ? { ...entry, order: entry.order + 1 }
      : entry);
    requireSame(after.chapters, [...expectedExisting, chapter], "create.chapters");
    validateContentObjectAgainstChapter(afterContent, chapter, "create");
    return;
  }

  if (intent.command === "create_volume") {
    if (mutation.kind !== "none") throw new Error("create_volume intent 必须使用 none fileMutation。");
    requireSame(after.chapters, before.chapters, "create_volume.chapters");
    if (after.volumes.length !== before.volumes.length + 1) throw new Error("create_volume 必须且只能增加一个卷。");
    const beforeIds = new Set(before.volumes.map((entry) => entry.volumeId));
    const added = after.volumes.filter((entry) => !beforeIds.has(entry.volumeId));
    if (added.length !== 1) throw new Error("create_volume 无法唯一识别新增卷。");
    const volume = added[0]!;
    if (volume.revision !== 1 || volume.order < 0 || volume.order > before.volumes.length) {
      throw new Error("create_volume 新卷记录无效。");
    }
    const expected = [
      ...before.volumes.map((entry) => entry.order >= volume.order ? { ...entry, order: entry.order + 1 } : entry),
      volume,
    ];
    requireSame(after.volumes, expected, "create_volume.volumes");
    return;
  }

  if (intent.command === "rename") {
    if (mutation.kind !== "none") throw new Error("rename intent 必须使用 none fileMutation。");
    requireSame(after.volumes, before.volumes, "rename.volumes");
    if (after.chapters.length !== before.chapters.length) throw new Error("rename 不得增删章节。");
    const candidates = before.chapters.filter((entry) => {
      const next = chapterById(after, entry.chapterId);
      return next && next.revision === entry.revision + 1;
    });
    if (candidates.length !== 1) throw new Error("rename 必须且只能提升一个章节 revision。");
    const prior = candidates[0]!;
    const next = chapterById(after, prior.chapterId)!;
    const expectedNext: NovelChapterRecord = {
      ...prior,
      title: next.title,
      revision: prior.revision + 1,
      updatedAt: after.updatedAt,
    };
    requireSame(next, expectedNext, "rename.chapter");
    requireSame(after.chapters, before.chapters.map((entry) => entry.chapterId === prior.chapterId ? expectedNext : entry), "rename.chapters");
    return;
  }

  if (intent.command === "move") {
    if (mutation.kind !== "move" && mutation.kind !== "none") throw new Error("move intent 只能使用 move/none fileMutation。");
    requireSame(after.volumes, before.volumes, "move.volumes");
    if (after.chapters.length !== before.chapters.length) throw new Error("move 不得增删章节。");
    const candidate = mutation.kind === "move"
      ? before.chapters.find((entry) => entry.relativePath === mutation.sourceLocator)
      : before.chapters.find((entry) => chapterById(after, entry.chapterId)?.revision === entry.revision + 1);
    if (!candidate) throw new Error("move 无法唯一识别目标章节。");
    const revisionCandidates = before.chapters.filter((entry) => chapterById(after, entry.chapterId)?.revision === entry.revision + 1);
    if (revisionCandidates.length !== 1 || revisionCandidates[0]!.chapterId !== candidate.chapterId) {
      throw new Error("move 必须且只能提升一个章节 revision。");
    }
    const next = chapterById(after, candidate.chapterId);
    if (!next || next.sha256 !== candidate.sha256 || next.byteLength !== candidate.byteLength
      || next.charCount !== candidate.charCount || next.title !== candidate.title
      || next.createdAt !== candidate.createdAt || next.sourceReceiptId !== candidate.sourceReceiptId
      || next.offsetEncoding !== candidate.offsetEncoding || next.revision !== candidate.revision + 1
      || next.updatedAt !== after.updatedAt) {
      throw new Error("move 目标章节包含不允许的语义差分。");
    }
    const targetSiblings = before.chapters.filter((entry) => entry.volumeId === next.volumeId && entry.chapterId !== candidate.chapterId);
    if (!after.volumes.some((entry) => entry.volumeId === next.volumeId)
      || next.order < 0 || next.order > targetSiblings.length) {
      throw new Error("move 目标卷或 order 无效。");
    }
    const expectedLocator = `manuscript/volumes/${next.volumeId}/${candidate.chapterId}.md`;
    if (next.relativePath !== expectedLocator) throw new Error("move after locator 与 stable ID/目标卷不一致。");
    if (expectedLocator === candidate.relativePath) {
      if (mutation.kind !== "none") throw new Error("同 locator move 必须使用 none fileMutation。");
    } else {
      if (mutation.kind !== "move" || mutation.sourceLocator !== candidate.relativePath
        || mutation.targetLocator !== expectedLocator || mutation.sha256 !== candidate.sha256
        || mutation.size !== candidate.byteLength) {
        throw new Error("move fileMutation 与章节记录不一致。");
      }
    }
    const rebalanced = before.chapters.filter((entry) => entry.chapterId !== candidate.chapterId).map((entry) => ({ ...entry }));
    for (const volume of before.volumes) {
      const siblings = rebalanced.filter((entry) => entry.volumeId === volume.volumeId)
        .sort((left, right) => left.order - right.order || left.chapterId.localeCompare(right.chapterId));
      siblings.forEach((entry, index) => { entry.order = index; });
    }
    for (const entry of rebalanced.filter((item) => item.volumeId === next.volumeId && item.order >= next.order)) entry.order += 1;
    requireSame(after.chapters, [...rebalanced, next], "move.chapters");
    return;
  }

  if (mutation.kind !== "none") throw new Error("reorder intent 必须使用 none fileMutation。");
  requireSame(after.volumes, before.volumes, "reorder.volumes");
  if (after.chapters.length !== before.chapters.length) throw new Error("reorder 不得增删章节。");
  const expected = before.chapters.map((prior) => {
    const next = chapterById(after, prior.chapterId);
    if (!next) throw new Error("reorder after 缺少章节。");
    const projected: NovelChapterRecord = { ...prior, order: next.order, updatedAt: after.updatedAt };
    requireSame(next, projected, "reorder.chapter");
    return projected;
  });
  requireSame(after.chapters, expected, "reorder.chapters");
}

async function operationDirectory(
  projectRoot: string,
  requestHash: string,
  create: boolean,
): Promise<ConfinedDirectoryIdentity> {
  const absolute = resolveNovelProjectLocator(projectRoot, `${OPERATIONS_LOCATOR}/${requestHash}`).absolutePath;
  return create
    ? ensureConfinedDirectory(projectRoot, absolute)
    : inspectExistingConfinedDirectory(projectRoot, absolute);
}

async function operationEntryNames(
  operation: ConfinedDirectoryIdentity,
  label: string,
): Promise<Set<string>> {
  const entries = await readdir(operation.directory, { withFileTypes: true });
  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`${label} 包含非普通文件节点。`);
    }
    names.add(entry.name);
  }
  return names;
}

async function assertPreparedOperationDirectory(
  operation: ConfinedDirectoryIdentity,
  allowedNames: ReadonlySet<string>,
  label: string,
): Promise<Set<string>> {
  const names = await operationEntryNames(operation, label);
  for (const name of names) {
    if (!allowedNames.has(name)) throw new Error(`${label} 包含无法归属的工件 ${name}。`);
    const maximumBytes = name === "after-content.bin" ? MAX_CHAPTER_BYTES : MAX_MANIFEST_BYTES;
    await readSingleLinkArtifact(operation, name, maximumBytes, `${label} ${name}`);
  }
  return names;
}

async function assertCommittedOperationClosure(
  operation: ConfinedDirectoryIdentity,
  expectContent: boolean,
): Promise<void> {
  const required = new Set(["intent.json", "after-manifest.json", ...(expectContent ? ["after-content.bin"] : [])]);
  const names = await operationEntryNames(operation, "committed operation");
  if (names.has("completed.json")) required.add("completed.json");
  if (names.size !== required.size || [...required].some((name) => !names.has(name))) {
    throw new Error("committed operation 工件闭包缺失或包含无法归属节点。");
  }
}

interface ValidatedOperationArtifacts {
  operation: ConfinedDirectoryIdentity;
  beforeManifest: NovelChapterManifest;
  afterManifest: NovelChapterManifest;
  afterManifestBytes: Buffer;
}

async function validateOperationArtifacts(
  projectRoot: string,
  intent: NovelMutationIntent,
): Promise<ValidatedOperationArtifacts> {
  const shell = await requireNovelShell(projectRoot);
  if (intent.projectId !== shell.project.id) throw new Error("operation intent projectId 与当前工程不一致。");
  const operation = await operationDirectory(projectRoot, intent.requestHash, false);
  await assertCommittedOperationClosure(
    operation,
    intent.fileMutation.kind === "replace" || intent.fileMutation.kind === "create",
  );
  const beforeRead = await readSingleLinkArtifactLocator(
    projectRoot,
    `${HISTORY_MANIFESTS_LOCATOR}/${intent.beforeManifestSha256}.json`,
    MAX_MANIFEST_BYTES,
    "operation before history manifest",
  );
  const afterRead = await readSingleLinkArtifact(operation, "after-manifest.json", MAX_MANIFEST_BYTES, "operation after manifest");
  if (sha256(beforeRead.bytes) !== intent.beforeManifestSha256) throw new Error("操作 before history manifest 与 intent 不一致。");
  if (sha256(afterRead.bytes) !== intent.afterManifestSha256) throw new Error("操作 after manifest 与 intent 不一致。");
  const beforeManifest = validateChapterManifest(parseJson(beforeRead.bytes, "operation before chapter manifest"), intent.projectId);
  const afterManifest = validateChapterManifest(parseJson(afterRead.bytes, "operation after chapter manifest"), intent.projectId);
  if (!jsonBytes(beforeManifest).equals(beforeRead.bytes) || !jsonBytes(afterManifest).equals(afterRead.bytes)) {
    throw new Error("operation before/after manifest 必须使用 canonical JSON 编码。");
  }
  let afterContent: Buffer | undefined;
  if (intent.fileMutation.kind === "replace" || intent.fileMutation.kind === "create") {
    const expectedSize = intent.fileMutation.afterSize;
    const contentRead = await readSingleLinkArtifact(
      operation,
      intent.fileMutation.contentObjectName,
      Math.max(expectedSize, 1),
      "operation after content",
    );
    if (contentRead.bytes.byteLength !== expectedSize) throw new Error("operation after-content size 与 intent 不一致。");
    afterContent = contentRead.bytes;
  }
  validateAllowedManifestTransition(intent, beforeManifest, afterManifest, afterContent);
  return { operation, beforeManifest, afterManifest, afterManifestBytes: afterRead.bytes };
}

async function readCompletedReceipt(
  projectRoot: string,
  intent: NovelMutationIntent,
  artifacts: ValidatedOperationArtifacts,
  options: { requireExactCurrent?: boolean } = {},
): Promise<NovelMutationReceipt | null> {
  const completedRead = await readSingleLinkArtifact(
    artifacts.operation,
    "completed.json",
    MAX_MANIFEST_BYTES,
    "operation completed receipt",
  ).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!completedRead) return null;
  const receipt = validateReceipt(parseJson(completedRead.bytes, "novel mutation completed receipt"));
  if (receipt.operationId !== intent.operationId || receipt.requestHash !== intent.requestHash
    || receipt.command !== intent.command || receipt.projectId !== intent.projectId
    || receipt.intentFingerprint !== intent.fingerprint
    || receipt.manifestSha256 !== intent.afterManifestSha256
    || receipt.manifestRevision !== artifacts.afterManifest.revision) {
    throw new Error("completed receipt 未与 intent/after manifest 完整绑定。");
  }
  const currentRead = await readSingleLinkArtifactLocator(
    projectRoot,
    NOVEL_CHAPTER_MANIFEST_RELATIVE_PATH,
    MAX_MANIFEST_BYTES,
    "current chapter manifest",
  );
  const currentManifest = validateChapterManifest(parseJson(currentRead.bytes, "current chapter manifest"), intent.projectId);
  const currentSha = sha256(currentRead.bytes);
  if (options.requireExactCurrent || currentManifest.revision === receipt.manifestRevision) {
    if (currentManifest.revision !== receipt.manifestRevision || currentSha !== receipt.manifestSha256) {
      throw new Error("completed receipt 与当前 project manifest 不吻合。");
    }
  } else if (currentManifest.revision < receipt.manifestRevision) {
    throw new Error("completed receipt 声称的 revision 超前于当前 project manifest。");
  } else {
    const historicalAfter = await readSingleLinkArtifactLocator(
      projectRoot,
      `${HISTORY_MANIFESTS_LOCATOR}/${receipt.manifestSha256}.json`,
      MAX_MANIFEST_BYTES,
      "completed operation descendant history manifest",
    );
    if (sha256(historicalAfter.bytes) !== receipt.manifestSha256
      || validateChapterManifest(parseJson(historicalAfter.bytes, "completed descendant history"), intent.projectId).revision !== receipt.manifestRevision) {
      throw new Error("completed receipt 无法证明当前 manifest 是其后继版本。");
    }
  }
  return receipt;
}

async function persistOperationIntent(
  projectRoot: string,
  intent: NovelMutationIntent,
  afterManifestBytes: Buffer,
  afterContent?: Buffer,
): Promise<void> {
  const directory = await operationDirectory(projectRoot, intent.requestHash, true);
  const expectedPreparedNames = new Set([
    "after-manifest.json",
    ...(afterContent ? ["after-content.bin"] : []),
  ]);
  await assertPreparedOperationDirectory(directory, expectedPreparedNames, "intent-less prepared operation");
  maybeInterruptNovelOperationPersistenceForTests("after-operation-directory");
  const interruptPhase = process.env.NODE_ENV === "test"
    ? process.env.AI_CANVAS_TEST_NOVEL_OPERATION_PERSIST_INTERRUPT as NovelOperationPersistencePhase | undefined
    : undefined;
  const interruptName = interruptPhase === "after-content" ? "after-content.bin"
    : interruptPhase === "after-manifest" ? "after-manifest.json"
      : undefined;
  const artifacts = [
    ...(afterContent ? [{ name: "after-content.bin", bytes: afterContent }] : []),
    { name: "after-manifest.json", bytes: afterManifestBytes },
    { name: "intent.json", bytes: jsonBytes(intent) },
  ];
  try {
    // intent.json 仍是唯一提交点：其他工件先 durable，intent 最后发布。
    await persistConfinedBytesNoReplaceBatch(directory, artifacts, {
      commitName: "intent.json",
      ...(interruptName ? { testInterruptAfterName: interruptName } : {}),
    });
  } catch (error) {
    if (interruptPhase && interruptName && error instanceof Error
      && error.message.includes("test-only persist-batch interruption")) {
      throw new Error(`test-only novel operation persistence interruption: ${interruptPhase}`, { cause: error });
    }
    throw error;
  }
  await assertCommittedOperationClosure(
    directory,
    intent.fileMutation.kind === "replace" || intent.fileMutation.kind === "create",
  );
  await registerOperationPending(projectRoot, intent);
  maybeInterruptNovelOperationPersistenceForTests("after-intent");
}

async function markOperationCompleted(
  projectRoot: string,
  intent: NovelMutationIntent,
  manifest: NovelChapterManifest,
): Promise<void> {
  const directory = await operationDirectory(projectRoot, intent.requestHash, false);
  if (sha256(jsonBytes(manifest)) !== intent.afterManifestSha256) {
    throw new Error("完成回执的 manifest 与 intent.afterManifestSha256 不一致。");
  }
  const receipt: Omit<NovelMutationReceipt, "fingerprint"> = {
    schemaVersion: 1,
    kind: "novel-manuscript-mutation-receipt",
    operationId: intent.operationId,
    requestHash: intent.requestHash,
    command: intent.command,
    projectId: intent.projectId,
    manifestRevision: manifest.revision,
    manifestSha256: intent.afterManifestSha256,
    completedAt: new Date().toISOString(),
    intentFingerprint: intent.fingerprint,
  };
  await persistConfinedBytesNoReplace(directory, "completed.json", jsonBytes({
    ...receipt,
    fingerprint: fingerprint(receipt),
  }));
  await finalizeOperationPending(projectRoot, intent);
}

async function replaceManifestCas(
  projectRoot: string,
  beforeSha: string,
  afterBytes: Buffer,
): Promise<void> {
  const current = await readSingleLinkArtifactLocator(
    projectRoot,
    NOVEL_CHAPTER_MANIFEST_RELATIVE_PATH,
    MAX_MANIFEST_BYTES,
    "current chapter manifest",
  );
  const actualSha = sha256(current.bytes);
  if (actualSha !== beforeSha) throw new Error("章节 manifest CAS 已变化。");
  await replaceConfinedBytesCas(current.identity, actualSha, current.bytes.byteLength, afterBytes);
}

async function currentLocatorState(
  projectRoot: string,
  locator: string,
  maxBytes = MAX_CHAPTER_BYTES,
): Promise<{ exists: false } | { exists: true; sha256: string; size: number; identity: ConfinedFileIdentity; bytes: Buffer }> {
  try {
    const read = await readSingleLinkArtifactLocator(projectRoot, locator, maxBytes, "current manuscript content");
    return {
      exists: true,
      sha256: sha256(read.bytes),
      size: read.bytes.byteLength,
      identity: read.identity,
      bytes: read.bytes,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function applyFileMutation(
  projectRoot: string,
  intent: NovelMutationIntent,
  operation: ConfinedDirectoryIdentity,
): Promise<void> {
  const mutation = intent.fileMutation;
  if (mutation.kind === "none") return;
  if (mutation.kind === "replace") {
    const state = await currentLocatorState(projectRoot, mutation.sourceLocator);
    if (state.exists && state.sha256 === mutation.afterSha256 && state.size === mutation.afterSize) return;
    if (!state.exists || state.sha256 !== mutation.beforeSha256 || state.size !== mutation.beforeSize) {
      throw new Error("恢复时正文既不是 before 也不是 after，停止覆盖。");
    }
    const content = await readSingleLinkArtifact(
      operation,
      mutation.contentObjectName,
      Math.max(mutation.afterSize, 1),
      "operation replace content",
    );
    if (sha256(content.bytes) !== mutation.afterSha256 || content.bytes.byteLength !== mutation.afterSize) {
      throw new Error("操作内容对象与 intent 不一致。");
    }
    await replaceConfinedBytesCas(state.identity, state.sha256, state.size, content.bytes);
    return;
  }
  if (mutation.kind === "create") {
    const state = await currentLocatorState(projectRoot, mutation.targetLocator);
    if (state.exists && state.sha256 === mutation.afterSha256 && state.size === mutation.afterSize) return;
    if (state.exists) throw new Error("创建章节目标已被其他内容占用。");
    const content = await readSingleLinkArtifact(
      operation,
      mutation.contentObjectName,
      Math.max(mutation.afterSize, 1),
      "operation create content",
    );
    if (sha256(content.bytes) !== mutation.afterSha256 || content.bytes.byteLength !== mutation.afterSize) {
      throw new Error("创建章节内容对象与 intent 不一致。");
    }
    await persistLocatorNoReplace(projectRoot, mutation.targetLocator, content.bytes);
    return;
  }
  const source = await currentLocatorState(projectRoot, mutation.sourceLocator);
  const target = await currentLocatorState(projectRoot, mutation.targetLocator);
  if (!source.exists && target.exists && target.sha256 === mutation.sha256 && target.size === mutation.size) return;
  if (!source.exists || target.exists || source.sha256 !== mutation.sha256 || source.size !== mutation.size) {
    throw new Error("卷间移动状态既不是 before 也不是 after，停止。");
  }
  const targetProjection = resolveNovelProjectLocator(projectRoot, mutation.targetLocator);
  const targetDirectory = await ensureConfinedDirectory(projectRoot, path.dirname(targetProjection.absolutePath));
  await moveConfinedFileNoReplaceCas(
    source.identity,
    source.sha256,
    source.size,
    targetDirectory,
    path.basename(targetProjection.absolutePath),
  );
}

async function recoverIntent(projectRoot: string, intent: NovelMutationIntent): Promise<boolean> {
  const artifacts = await validateOperationArtifacts(projectRoot, intent);
  if (await readCompletedReceipt(projectRoot, intent, artifacts)) {
    return finalizeOperationPending(projectRoot, intent);
  }
  const currentManifest = await readSingleLinkArtifactLocator(
    projectRoot,
    NOVEL_CHAPTER_MANIFEST_RELATIVE_PATH,
    MAX_MANIFEST_BYTES,
    "current chapter manifest",
  );
  const currentManifestSha = sha256(currentManifest.bytes);
  if (currentManifestSha === intent.beforeManifestSha256) {
    const parsedCurrent = validateChapterManifest(parseJson(currentManifest.bytes, "current before chapter manifest"), intent.projectId);
    requireSame(parsedCurrent, artifacts.beforeManifest, "recovery.current-before");
    await applyFileMutation(projectRoot, intent, artifacts.operation);
    maybeInterruptNovelMutationForTests("after-file-mutation");
    await replaceConfinedBytesCas(
      currentManifest.identity,
      currentManifestSha,
      currentManifest.bytes.byteLength,
      artifacts.afterManifestBytes,
    );
    maybeInterruptNovelMutationForTests("after-manifest");
  } else if (currentManifestSha === intent.afterManifestSha256) {
    const parsedCurrent = validateChapterManifest(parseJson(currentManifest.bytes, "current after chapter manifest"), intent.projectId);
    requireSame(parsedCurrent, artifacts.afterManifest, "recovery.current-after");
    await applyFileMutation(projectRoot, intent, artifacts.operation);
  } else {
    throw new Error("正文操作恢复发现 manifest 已分叉，停止写入。");
  }
  await markOperationCompleted(projectRoot, intent, artifacts.afterManifest);
  return true;
}

const OPERATION_ROOT_FIXED_ENTRIES = new Set(["layout.json", "pending", "completed-markers"]);

async function listLegacyOperationNames(projectRoot: string): Promise<string[]> {
  const operationsRoot = resolveNovelProjectLocator(projectRoot, OPERATIONS_LOCATOR).absolutePath;
  let entries: string[];
  try {
    entries = await readdir(operationsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const operationNames: string[] = [];
  for (const name of entries.sort()) {
    const metadata = await lstat(path.join(operationsRoot, name));
    if (OPERATION_ROOT_FIXED_ENTRIES.has(name)) {
      const valid = name === "layout.json"
        ? metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1
        : metadata.isDirectory() && !metadata.isSymbolicLink();
      if (!valid) throw new Error(`小说 operations 固定节点类型无效：${name}`);
      continue;
    }
    if (!SHA256_PATTERN.test(name)) throw new Error("小说 operations 目录包含无法归属的节点。");
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("小说 operation 节点必须是真实目录。");
    operationNames.push(name);
  }
  return operationNames;
}

async function loadCommittedOperationIntent(
  projectRoot: string,
  requestHash: string,
  expectedProjectId: string,
): Promise<NovelMutationIntent | null> {
    const directory = await operationDirectory(projectRoot, requestHash, false);
    const intentRead = await readSingleLinkArtifact(directory, "intent.json", MAX_MANIFEST_BYTES, "operation intent")
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
    if (!intentRead) {
      // intent.json 尚未提交的准备目录没有业务写权。严格限制工件
      // 名称/类型/nlink 后跳过，由同 requestHash 重试精确续写并最后提交 intent。
      await assertPreparedOperationDirectory(
        directory,
        new Set(["after-content.bin", "after-manifest.json"]),
        "intent-less prepared operation",
      );
      return null;
    }
    const intent = validateIntent(parseJson(intentRead.bytes, "novel mutation intent"));
    if (intent.requestHash !== requestHash || intent.projectId !== expectedProjectId) {
      throw new Error("operation 目录、工程身份与 intent 不一致。");
    }
    return intent;
}

async function recoverLegacyOperations(
  projectRoot: string,
  expectedProjectId: string,
): Promise<number> {
  let recovered = 0;
  for (const requestHash of await listLegacyOperationNames(projectRoot)) {
    const intent = await loadCommittedOperationIntent(projectRoot, requestHash, expectedProjectId);
    if (intent && await recoverIntent(projectRoot, intent)) recovered += 1;
  }
  return recovered;
}

async function listPendingOperationMarkerHashes(projectRoot: string): Promise<string[]> {
  const pendingRoot = resolveNovelProjectLocator(projectRoot, OPERATION_PENDING_LOCATOR).absolutePath;
  let entries: string[];
  try {
    entries = await readdir(pendingRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const hashes: string[] = [];
  for (const name of entries.sort()) {
    const match = /^([a-f0-9]{64})\.json$/u.exec(name);
    if (!match) throw new Error("小说 pending marker 目录包含无法归属的节点。");
    const metadata = await lstat(path.join(pendingRoot, name));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error("小说 pending marker 必须是单链接普通文件。");
    }
    hashes.push(match[1]!);
  }
  return hashes;
}

async function loadValidatedPendingOperation(
  projectRoot: string,
  requestHash: string,
  expectedProjectId: string,
): Promise<NovelMutationIntent> {
  const markerRead = await readOptionalSingleLinkArtifactLocator(
    projectRoot,
    operationMarkerLocator("pending", requestHash),
    MAX_MANIFEST_BYTES,
    "pending operation marker",
  );
  if (!markerRead) throw new Error("小说 pending marker 在扫描期间消失。");
  const marker = validateOperationMarker(parseJson(markerRead.bytes, "pending operation marker"));
  const intent = await loadCommittedOperationIntent(projectRoot, requestHash, expectedProjectId);
  if (!intent) throw new Error("小说 pending marker 缺少已提交 intent。");
  // 先完整验证 intent/after 的业务语义，再核对 marker 绑定。这样篡改仍在
  // 任何恢复写入前失败，同时保留既有精确诊断（非法 locator/after manifest）。
  await validateOperationArtifacts(projectRoot, intent);
  assertOperationMarkerMatchesIntent(marker, intent);
  return intent;
}

async function recoverPendingOperations(
  projectRoot: string,
  expectedProjectId: string,
): Promise<number> {
  let recovered = 0;
  for (const requestHash of await listPendingOperationMarkerHashes(projectRoot)) {
    const intent = await loadValidatedPendingOperation(projectRoot, requestHash, expectedProjectId);
    if (await recoverIntent(projectRoot, intent)) recovered += 1;
  }
  return recovered;
}

async function recoverIncompleteOperationsUnlocked(projectRoot: string): Promise<number> {
  const shell = await requireNovelShell(projectRoot);
  if (await loadOperationLayout(projectRoot, shell.project.id)) {
    return recoverPendingOperations(projectRoot, shell.project.id);
  }
  const recovered = await recoverLegacyOperations(projectRoot, shell.project.id);
  await persistOperationLayout(projectRoot, shell.project.id);
  return recovered;
}

async function executeAfterRecoveringIncompleteOperations<T>(
  projectRoot: string,
  work: () => Promise<T>,
): Promise<T> {
  const recoveredOperations = await recoverIncompleteOperationsUnlocked(projectRoot);
  try {
    return await work();
  } catch (error) {
    if (recoveredOperations > 0 && isNovelPreconditionRejectedError(error)) {
      // 本请求已在前置恢复阶段产生可见写入，后续的 stale/CAS 拒绝
      // 绝不能被 command bus 误记为 committed=false。
      throw new Error(
        `当前命令前已恢复 ${recoveredOperations} 个遗留正文操作；后续前置条件拒绝不能按零写入失败归类。`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function executeMutation(
  projectRoot: string,
  command: NovelMutationIntent["command"],
  before: NovelChapterManifest,
  after: NovelChapterManifest,
  fileMutation: NovelMutationIntent["fileMutation"],
  afterContent?: Buffer,
): Promise<NovelMutationResult> {
  const shell = await requireNovelShell(projectRoot);
  const context = requireMutationContext();
  const beforeBytes = jsonBytes(before);
  const afterBytes = jsonBytes(after);
  const beforeSha = sha256(beforeBytes);
  const afterSha = sha256(afterBytes);
  const intent = intentPayload({
    schemaVersion: 1 as const,
    kind: "novel-manuscript-mutation-intent" as const,
    operationId: deterministicUuid(`${context.requestHash}\0${command}\0operation`),
    requestHash: context.requestHash,
    command,
    projectId: shell.project.id,
    beforeManifestSha256: beforeSha,
    afterManifestSha256: afterSha,
    fileMutation,
    createdAt: after.updatedAt,
  });
  await persistHistory(projectRoot, beforeBytes);
  const existingOperation = await operationDirectory(projectRoot, context.requestHash, false).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existingOperation) {
    const intentRead = await readSingleLinkArtifact(existingOperation, "intent.json", MAX_MANIFEST_BYTES, "operation replay intent")
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
    if (!intentRead) {
      await persistOperationIntent(projectRoot, intent, afterBytes, afterContent);
      await recoverIntent(projectRoot, intent);
      return { manifest: after, replayed: false, changed: true };
    }
    const existingIntent = validateIntent(parseJson(intentRead.bytes, "operation replay intent"));
    if (existingIntent.requestHash !== context.requestHash || existingIntent.command !== command
      || existingIntent.projectId !== shell.project.id || existingIntent.beforeManifestSha256 !== beforeSha
      || existingIntent.afterManifestSha256 !== afterSha) {
      throw new Error("既有 operation intent 与本次 mutation 不一致。");
    }
    const artifacts = await validateOperationArtifacts(projectRoot, existingIntent);
    if (!await readCompletedReceipt(projectRoot, existingIntent, artifacts, { requireExactCurrent: true })) {
      await registerOperationPending(projectRoot, existingIntent);
      await recoverIntent(projectRoot, existingIntent);
      return { manifest: artifacts.afterManifest, replayed: true, changed: true };
    }
    return { manifest: artifacts.afterManifest, replayed: true, changed: true };
  }
  await persistOperationIntent(projectRoot, intent, afterBytes, afterContent);
  await recoverIntent(projectRoot, intent);
  return { manifest: after, replayed: false, changed: true };
}

async function initializeUnlocked(
  projectRoot: string,
  sourceMode: NovelSourceMode,
): Promise<InitializedWorkspaceResult> {
  const shell = await requireNovelShell(projectRoot);
  const context = requireMutationContext();
  const initializationPath = resolveNovelProjectLocator(
    projectRoot,
    `.aicanvas/novel/initializations/${context.requestHash}`,
  ).absolutePath;
  let initializationDirectory = await inspectExistingConfinedDirectory(projectRoot, initializationPath)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
  let initializationIntent: NovelWorkspaceInitializationIntent | null = null;
  if (initializationDirectory) {
    const priorRead = await readSingleLinkArtifact(
      initializationDirectory,
      "intent.json",
      MAX_MANIFEST_BYTES,
      "novel initialization intent",
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (priorRead) {
      initializationIntent = validateInitializationIntent(parseJson(priorRead.bytes, "novel initialization intent"));
      if (initializationIntent.requestHash !== context.requestHash
        || initializationIntent.projectId !== shell.project.id
        || initializationIntent.sourceMode !== sourceMode) {
        throw new Error("小说初始化重放参数不一致。");
      }
      await assertPreparedOperationDirectory(
        initializationDirectory,
        new Set(["intent.json"]),
        "novel initialization directory",
      );
    } else {
      await assertPreparedOperationDirectory(
        initializationDirectory,
        new Set<string>(),
        "intent-less novel initialization directory",
      );
    }
  }
  const existing = await readNovelProjectFile(projectRoot, NOVEL_MANIFEST_RELATIVE_PATH, { maxBytes: MAX_MANIFEST_BYTES })
    .then((result) => result.bytes, (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
  if (existing) {
    if (initializationDirectory && !initializationIntent) {
      throw new Error("小说 workspace 已存在，但同 requestHash 初始化 intent 缺失。");
    }
    const beforeAttach = await readWorkspaceAndManifest(projectRoot);
    if (beforeAttach.workspace.sourceMode !== sourceMode) {
      throw new Error("已存在小说 workspace 与本次 sourceMode 不一致。");
    }
    if (initializationIntent) {
      if (beforeAttach.workspace.createdAt !== initializationIntent.createdAt
        || beforeAttach.workspace.updatedAt !== initializationIntent.createdAt
        || (sourceMode === "managed_markdown"
          && beforeAttach.chapters?.volumes[0]?.volumeId !== initializationIntent.volumeId)) {
        throw new Error("已存在小说 workspace 与初始化 intent 不一致。");
      }
    }
    await attachNovelManifest(projectRoot, { expectedManagedFingerprint: shell.manifestFingerprint });
    maybeInterruptNovelInitializationForTests("after-attach");
    return readWorkspaceAndManifest(projectRoot);
  }

  if (!initializationDirectory) {
    initializationDirectory = await ensureConfinedDirectory(projectRoot, initializationPath);
  }
  if (!initializationIntent) {
    const semantic = {
      schemaVersion: 1 as const,
      kind: "novel-workspace-initialization-intent" as const,
      requestHash: context.requestHash,
      projectId: shell.project.id,
      sourceMode,
      volumeId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    initializationIntent = { ...semantic, fingerprint: fingerprint(semantic) };
    await persistConfinedBytesNoReplace(initializationDirectory, "intent.json", jsonBytes(initializationIntent));
  }
  if (!initializationIntent) throw new Error("小说初始化 intent 未能建立。");
  const volumeId = initializationIntent.volumeId;
  const now = initializationIntent.createdAt;
  let chapters: NovelChapterManifest | null = null;
  if (sourceMode === "managed_markdown") {
    chapters = {
      schemaVersion: 1,
      kind: "novel-chapter-manifest",
      projectId: shell.project.id,
      revision: 1,
      volumes: [{ volumeId, title: "第一卷", order: 0, revision: 1 }],
      chapters: [],
      updatedAt: now,
    };
    await persistLocatorNoReplaceOrVerify(
      projectRoot,
      NOVEL_CHAPTER_MANIFEST_RELATIVE_PATH,
      jsonBytes(chapters),
      "initial chapter manifest",
    );
  }
  maybeInterruptNovelInitializationForTests("after-chapters");
  const workspace = workspaceWithFingerprint({
    schemaVersion: 1,
    kind: "novel-workspace-manifest",
    projectId: shell.project.id,
    sourceMode,
    ...(sourceMode === "managed_markdown" ? { chapterManifest: NOVEL_CHAPTER_MANIFEST_RELATIVE_PATH } : {}),
    sourceReceiptIds: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await persistLocatorNoReplaceOrVerify(
    projectRoot,
    NOVEL_MANIFEST_RELATIVE_PATH,
    jsonBytes(workspace),
    "initial novel workspace manifest",
  );
  maybeInterruptNovelInitializationForTests("after-workspace");
  await attachNovelManifest(projectRoot, { expectedManagedFingerprint: shell.manifestFingerprint });
  maybeInterruptNovelInitializationForTests("after-attach");
  return readWorkspaceAndManifest(projectRoot);
}

export function orderedNovelChapters(manifest: NovelChapterManifest | null): NovelChapterRecord[] {
  if (!manifest) return [];
  const volumeOrder = new Map(manifest.volumes.map((volume) => [volume.volumeId, volume.order]));
  return [...manifest.chapters].sort((left, right) => (
    (volumeOrder.get(left.volumeId) ?? 0) - (volumeOrder.get(right.volumeId) ?? 0)
      || left.order - right.order
      || left.chapterId.localeCompare(right.chapterId)
  ));
}

export class NovelRepository {
  constructor(readonly projectRoot: string) {
    if (!path.isAbsolute(projectRoot)) throw new Error("NovelRepository 需要绝对项目根。");
    this.projectRoot = path.resolve(projectRoot);
  }

  async initialize(sourceMode: NovelSourceMode = "managed_markdown"): Promise<NovelWorkspaceSnapshot> {
    if (!isNovelSourceMode(sourceMode)) throw new Error("小说来源模式无效。");
    return withProjectLock(this.projectRoot, "novel-manuscript", () => initializeUnlocked(this.projectRoot, sourceMode));
  }

  async snapshot(): Promise<NovelWorkspaceSnapshot> {
    return readWorkspaceAndManifest(this.projectRoot);
  }

  /**
   * 外部导入编排器已将整个 manuscript/ no-replace 发布后，由
   * Repository 做全量闭包对账并最后激活 workspace。
   */
  async adoptImportedManuscript(input: {
    receiptId: string;
    expectedChapterManifestSha256: string;
  }): Promise<NovelWorkspaceSnapshot> {
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      const shell = await requireNovelShell(this.projectRoot);
      requireMutationContext();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/u.test(input.receiptId)
        || !SHA256_PATTERN.test(input.expectedChapterManifestSha256)) {
        throw new Error("导入 receiptId 或 chapter manifest SHA 无效。");
      }
      const existingWorkspace = await readNovelProjectFile(this.projectRoot, NOVEL_MANIFEST_RELATIVE_PATH, { maxBytes: MAX_MANIFEST_BYTES })
        .then((read) => read.bytes, (error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
      if (existingWorkspace) {
        const snapshot = await readWorkspaceAndManifest(this.projectRoot);
        if (!snapshot.chapters
          || !snapshot.workspace.sourceReceiptIds.includes(input.receiptId)) {
          throw new Error("已激活小说 workspace 与导入 receipt 不一致。");
        }
        const chapters = await readAndValidateImportedChapterClosure(
          this.projectRoot,
          shell.project.id,
          input.expectedChapterManifestSha256,
        );
        const attached = await attachNovelManifest(this.projectRoot, {
          expectedManagedFingerprint: shell.manifestFingerprint,
        });
        if (attached.manifest.novelManifest !== NOVEL_MANIFEST_RELATIVE_PATH) {
          throw new Error("已激活小说 workspace 的 managed manifest 绑定复验失败。");
        }
        return { workspace: snapshot.workspace, chapters };
      }
      const chapters = await readAndValidateImportedChapterClosure(
        this.projectRoot,
        shell.project.id,
        input.expectedChapterManifestSha256,
      );
      const now = new Date().toISOString();
      const workspace = workspaceWithFingerprint({
        schemaVersion: 1,
        kind: "novel-workspace-manifest",
        projectId: shell.project.id,
        sourceMode: "managed_markdown",
        chapterManifest: NOVEL_CHAPTER_MANIFEST_RELATIVE_PATH,
        sourceReceiptIds: [input.receiptId],
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      await persistLocatorNoReplace(this.projectRoot, NOVEL_MANIFEST_RELATIVE_PATH, jsonBytes(workspace));
      await attachNovelManifest(this.projectRoot, { expectedManagedFingerprint: shell.manifestFingerprint });
      return { workspace, chapters };
    });
  }

  async listChapters(options: {
    offset?: number;
    limit?: number;
    volumeId?: string;
    anchorChapterId?: string;
  } = {}): Promise<{
    workspaceRevision: number;
    manifestRevision: number | null;
    total: number;
    offset: number;
    limit: number;
    items: NovelChapterRecord[];
  }> {
    const snapshot = await this.snapshot();
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("章节分页参数无效。");
    }
    let items = orderedNovelChapters(snapshot.chapters);
    const volumeId = options.volumeId;
    const anchorChapterId = options.anchorChapterId;
    if (volumeId) items = items.filter((chapter) => chapter.volumeId === volumeId);
    let resolvedOffset = offset;
    if (anchorChapterId) {
      const anchorIndex = items.findIndex((chapter) => chapter.chapterId === anchorChapterId);
      if (anchorIndex < 0) throw new Error("章节分页锚点不在当前卷章范围内。");
      resolvedOffset = Math.floor(anchorIndex / limit) * limit;
    }
    return {
      workspaceRevision: snapshot.workspace.revision,
      manifestRevision: snapshot.chapters?.revision ?? null,
      total: items.length,
      offset: resolvedOffset,
      limit,
      items: items.slice(resolvedOffset, resolvedOffset + limit),
    };
  }

  async getNavigation(options: { offset?: number; limit?: number; anchorVolumeId?: string } = {}): Promise<NovelWorkspaceNavigation> {
    const snapshot = await this.snapshot();
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("小说卷导航分页参数无效。");
    }
    const volumes = [...(snapshot.chapters?.volumes ?? [])]
      .sort((left, right) => left.order - right.order || left.volumeId.localeCompare(right.volumeId));
    const counts = new Map<string, { chapterCount: number; charCount: number }>();
    let charCount = 0;
    for (const chapter of snapshot.chapters?.chapters ?? []) {
      const current = counts.get(chapter.volumeId) ?? { chapterCount: 0, charCount: 0 };
      current.chapterCount += 1;
      current.charCount += chapter.charCount;
      counts.set(chapter.volumeId, current);
      charCount += chapter.charCount;
    }
    let resolvedOffset = offset;
    if (options.anchorVolumeId) {
      const anchorIndex = volumes.findIndex((volume) => volume.volumeId === options.anchorVolumeId);
      if (anchorIndex < 0) throw new Error("卷导航锚点不在当前小说中。");
      resolvedOffset = Math.floor(anchorIndex / limit) * limit;
    }
    const items = volumes.slice(resolvedOffset, resolvedOffset + limit).map((volume) => ({
      ...volume,
      ...(counts.get(volume.volumeId) ?? { chapterCount: 0, charCount: 0 }),
    }));
    return {
      workspace: snapshot.workspace,
      manifestRevision: snapshot.chapters?.revision ?? null,
      totals: {
        volumeCount: volumes.length,
        chapterCount: snapshot.chapters?.chapters.length ?? 0,
        charCount,
      },
      volumes: {
        total: volumes.length,
        offset: resolvedOffset,
        limit,
        items,
      },
    };
  }

  private async readChapterRecordWithSource(chapter: NovelChapterRecord): Promise<{
    result: NovelChapterReadResult;
    source?: Awaited<ReturnType<typeof readNovelProjectFile>>;
  }> {
    const read = await readNovelProjectFile(this.projectRoot, chapter.relativePath, { maxBytes: MAX_CHAPTER_BYTES });
    const actualSha = read.sha256;
    if (actualSha !== chapter.sha256 || read.bytes.byteLength !== chapter.byteLength) {
      return {
        result: {
          chapter,
          status: "external_change",
          actual: { sha256: actualSha, byteLength: read.bytes.byteLength },
        },
      };
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    if (content.length !== chapter.charCount) {
      return {
        result: {
          chapter,
          status: "external_change",
          actual: { sha256: actualSha, byteLength: read.bytes.byteLength, charCount: content.length },
        },
      };
    }
    return { result: { chapter, status: "healthy", content }, source: read };
  }

  private async readChapterRecord(chapter: NovelChapterRecord): Promise<NovelChapterReadResult> {
    return (await this.readChapterRecordWithSource(chapter)).result;
  }

  async readChapter(chapterId: string): Promise<NovelChapterReadResult> {
    const snapshot = await this.snapshot();
    const chapter = snapshot.chapters?.chapters.find((entry) => entry.chapterId === chapterId);
    if (!chapter) throw new Error(`小说章节不存在：${chapterId}`);
    return this.readChapterRecord(chapter);
  }

  async getSearchIndexStatus(): Promise<NovelSearchIndexStatus> {
    const snapshot = await this.snapshot();
    if (!snapshot.chapters) throw new Error("外部快照没有可建立索引的受管章节。 ");
    const chapters = orderedNovelChapters(snapshot.chapters);
    return getNovelDerivedSearchStatus(this.projectRoot, {
      projectId: snapshot.workspace.projectId,
      manifestRevision: snapshot.chapters.revision,
      manifestDigest: novelSearchManifestDigest(snapshot.workspace.projectId, snapshot.chapters.revision, chapters),
      chapters,
    });
  }

  async rebuildSearchIndex(): Promise<NovelSearchIndexStatus> {
    requireMutationContext();
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      const snapshot = await this.snapshot();
      if (!snapshot.chapters) throw new Error("外部快照没有可建立索引的受管章节。 ");
      const chapters = orderedNovelChapters(snapshot.chapters);
      const documents: Array<{
        chapter: NovelChapterRecord;
        content: string;
        identity: NovelRegularFileIdentity;
      }> = [];
      for (let offset = 0; offset < chapters.length; offset += SEARCH_READ_CONCURRENCY) {
        const batch = chapters.slice(offset, offset + SEARCH_READ_CONCURRENCY);
        const reads = await Promise.all(batch.map((chapter) => this.readChapterRecordWithSource(chapter)));
        for (const read of reads) {
          if (read.result.status !== "healthy" || !read.source) {
            throw new Error(`章节存在外部变更，拒绝激活不完整派生索引：${read.result.chapter.chapterId}`);
          }
          documents.push({
            chapter: read.result.chapter,
            content: read.result.content,
            identity: read.source.identity,
          });
        }
      }
      const latest = await this.snapshot();
      const expectedDigest = novelSearchManifestDigest(snapshot.workspace.projectId, snapshot.chapters.revision, chapters);
      if (!latest.chapters
        || latest.workspace.projectId !== snapshot.workspace.projectId
        || novelSearchManifestDigest(
          latest.workspace.projectId,
          latest.chapters.revision,
          orderedNovelChapters(latest.chapters),
        ) !== expectedDigest) {
        throw new Error("小说 manifest 在派生索引读取期间已变化，请重试。 ");
      }
      return rebuildNovelDerivedSearchIndex(this.projectRoot, {
        projectId: snapshot.workspace.projectId,
        manifestRevision: snapshot.chapters.revision,
        manifestDigest: expectedDigest,
        chapters,
      }, documents);
    });
  }

  async searchChapters(input: SearchNovelChaptersInput): Promise<NovelChapterSearchResult> {
    const query = input.query.trim();
    const limit = input.limit ?? MAX_SEARCH_RESULTS;
    const maxHitsPerChapter = input.maxHitsPerChapter ?? 5;
    if (query.length < 2 || query.length > MAX_SEARCH_QUERY_CHARACTERS) {
      throw new Error(`小说搜索词必须是 2–${MAX_SEARCH_QUERY_CHARACTERS} 个字符。`);
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
      throw new Error(`小说搜索结果上限必须是 1–${MAX_SEARCH_RESULTS}。`);
    }
    if (!Number.isSafeInteger(maxHitsPerChapter) || maxHitsPerChapter < 1 || maxHitsPerChapter > MAX_SEARCH_HITS_PER_CHAPTER) {
      throw new Error(`小说单章命中上限必须是 1–${MAX_SEARCH_HITS_PER_CHAPTER}。`);
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = await this.snapshot();
      if (!snapshot.chapters) throw new Error("外部快照没有可搜索的受管章节。 ");
      const manifestRevision = snapshot.chapters.revision;
      const ordered = orderedNovelChapters(snapshot.chapters);
      const allowedChapterIds = input.allowedChapterIds === undefined
        ? null
        : new Set(input.allowedChapterIds);
      if (allowedChapterIds && allowedChapterIds.size !== input.allowedChapterIds!.length) {
        throw new Error("allowedChapterIds 不得重复。");
      }
      if (allowedChapterIds) {
        const knownChapterIds = new Set(ordered.map((chapter) => chapter.chapterId));
        for (const chapterId of allowedChapterIds) {
          if (!knownChapterIds.has(chapterId)) throw new Error(`allowedChapterIds 包含未知章节：${chapterId}`);
        }
      }
      const allowedChapters = allowedChapterIds
        ? ordered.filter((chapter) => allowedChapterIds.has(chapter.chapterId))
        : ordered;
      const manifestDigest = novelSearchManifestDigest(snapshot.workspace.projectId, manifestRevision, ordered);
      const indexed = await queryNovelDerivedSearchCandidates(this.projectRoot, {
        projectId: snapshot.workspace.projectId,
        manifestRevision,
        manifestDigest,
        chapters: ordered,
      }, query, allowedChapterIds);
      const candidateIds = indexed.candidateChapterIds === undefined
        ? null
        : new Set(indexed.candidateChapterIds);
      const chapters = candidateIds
        ? allowedChapters.filter((chapter) => candidateIds.has(chapter.chapterId))
        : allowedChapters;
      const hits: NovelChapterSearchResult["hits"] = [];
      let scannedChapters = 0;
      let skippedExternalChanges = 0;

      for (let offset = 0; offset < chapters.length && hits.length < limit; offset += SEARCH_READ_CONCURRENCY) {
        const batch = chapters.slice(offset, offset + SEARCH_READ_CONCURRENCY);
        const reads = await Promise.all(batch.map((chapter) => this.readChapterRecord(chapter)));
        scannedChapters += reads.length;
        for (const read of reads) {
          if (read.status !== "healthy") {
            skippedExternalChanges += 1;
            continue;
          }
          let from = 0;
          for (let hit = 0; hit < maxHitsPerChapter && hits.length < limit; hit += 1) {
            const startOffset = read.content.indexOf(query, from);
            if (startOffset < 0) break;
            const endOffset = startOffset + query.length;
            const snippetStart = Math.max(0, startOffset - 32);
            const snippetEnd = Math.min(read.content.length, endOffset + 48);
            hits.push({
              chapter: read.chapter,
              startOffset,
              endOffset,
              snippet: `${snippetStart ? "…" : ""}${read.content.slice(snippetStart, snippetEnd).replace(/\s+/gu, " ")}${snippetEnd < read.content.length ? "…" : ""}`,
            });
            from = endOffset;
          }
        }
      }

      const latest = await this.snapshot();
      if (latest.chapters?.revision === manifestRevision) {
        const engine = candidateIds ? "fts5_trigram" as const : "linear_scan" as const;
        return {
          query,
          manifestRevision,
          engine,
          indexedChapters: indexed.status.activeGeneration?.indexedChapterCount ?? 0,
          indexState: indexed.status.state,
          ...(indexed.status.activeGeneration ? { indexGenerationId: indexed.status.activeGeneration.generationId } : {}),
          ...(indexed.fallbackReason ? { fallbackReason: indexed.fallbackReason } : {}),
          scannedChapters,
          skippedExternalChanges,
          hits,
        };
      }
    }
    throw new Error("小说正文在搜索期间持续发生变化，请稍后重试。 ");
  }

  async recoverIncompleteOperations(): Promise<number> {
    requireMutationContext();
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      await requireNovelShell(this.projectRoot);
      return recoverIncompleteOperationsUnlocked(this.projectRoot);
    });
  }

  async recoverWritingStateOperations(): Promise<number> {
    requireMutationContext();
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      const snapshot = await readWorkspaceAndManifest(this.projectRoot);
      return recoverIncompleteNovelWritingStateOperations(this.projectRoot, snapshot.workspace.projectId);
    });
  }

  async seedWritingState(input: NovelSeedWritingStateInput) {
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      requireMutationContext();
      const snapshot = await readWorkspaceAndManifest(this.projectRoot);
      return seedNovelWritingState(this.projectRoot, snapshot, input);
    });
  }

  async importWritingSourceSnapshot(input: NovelImportWritingSourceSnapshotInput) {
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      requireMutationContext();
      const snapshot = await readWorkspaceAndManifest(this.projectRoot);
      return importNovelWritingSourceSnapshot(this.projectRoot, snapshot, input);
    });
  }

  async acquireChapterWriteLease(input: NovelAcquireChapterWriteLeaseInput) {
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      const snapshot = await readWorkspaceAndManifest(this.projectRoot);
      return acquireNovelChapterWriteLease(this.projectRoot, snapshot, input);
    });
  }

  async stageChapterStateCandidate(input: NovelStageChapterStateCandidateInput) {
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      requireMutationContext();
      const snapshot = await readWorkspaceAndManifest(this.projectRoot);
      return stageNovelChapterStateCandidate(this.projectRoot, snapshot, input);
    });
  }

  async reviewChapterStateCandidate(input: NovelReviewChapterStateCandidateInput) {
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      requireMutationContext();
      const snapshot = await readWorkspaceAndManifest(this.projectRoot);
      return reviewNovelChapterStateCandidate(this.projectRoot, snapshot, input);
    });
  }

  async stageStoryBibleCandidate(input: NovelStageStoryBibleCandidateInput) {
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      requireMutationContext();
      const snapshot = await readWorkspaceAndManifest(this.projectRoot);
      return stageNovelStoryBibleCandidate(this.projectRoot, snapshot, input);
    });
  }

  async reviewStoryBibleCandidate(input: NovelReviewStoryBibleCandidateInput) {
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      requireMutationContext();
      const snapshot = await readWorkspaceAndManifest(this.projectRoot);
      return reviewNovelStoryBibleCandidate(this.projectRoot, snapshot, input);
    });
  }

  async invalidateWritingStateFrom(input: NovelInvalidateWritingStateFromInput) {
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      requireMutationContext();
      const snapshot = await readWorkspaceAndManifest(this.projectRoot);
      return invalidateNovelWritingStateFrom(this.projectRoot, snapshot, input);
    });
  }

  async attachReviewTicket(input: NovelAttachReviewTicketInput) {
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      requireMutationContext();
      const snapshot = await readWorkspaceAndManifest(this.projectRoot);
      const chapter = snapshot.chapters?.chapters.find((entry) => entry.chapterId === input.chapterId);
      if (!chapter) rejectNovelPrecondition("审稿票目标章节不存在。", { reason: "not_found", chapterId: input.chapterId });
      const read = await this.readChapterRecord(chapter);
      if (read.status === "external_change") {
        rejectNovelPrecondition("审稿票目标正文已被外部修改。", {
          reason: "external_change",
          chapterId: chapter.chapterId,
          expectedRevision: chapter.revision,
          currentRevision: chapter.revision,
          expectedSha256: chapter.sha256,
          currentSha256: read.actual.sha256,
        });
      }
      return attachNovelReviewTicket(this.projectRoot, snapshot, input, read.content);
    });
  }

  async saveChapter(input: SaveNovelChapterInput, execution: {
    requireWriteLease?: boolean;
    writeLease?: NovelChapterWriteLeaseRuntime;
  } = {}): Promise<NovelMutationResult> {
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      requireMutationContext();
      if (input.aiWriteContext?.workflowMode === "rehearsal") {
        rejectNovelPrecondition("rehearsal 只用于上下文与写前检查，禁止同步到权威小说正文。", {
          reason: "workflow_mode_forbidden",
          chapterId: input.chapterId,
        });
      }
      return executeAfterRecoveringIncompleteOperations(this.projectRoot, async () => {
      const snapshot = await readWorkspaceAndManifest(this.projectRoot);
      if (snapshot.workspace.sourceMode !== "managed_markdown" || !snapshot.chapters) {
        rejectNovelPrecondition("external_snapshot 只读；必须显式转换为 managed Markdown 后才能保存。", { reason: "read_only" });
      }
      if (input.aiWriteContext) {
        await validateNovelAiWriteContext(this.projectRoot, snapshot, input.chapterId, input.aiWriteContext);
        if (execution.requireWriteLease || input.aiWriteContext.leaseId || execution.writeLease) {
          await assertNovelChapterWriteLease(
            this.projectRoot,
            snapshot,
            input.chapterId,
            input.aiWriteContext,
            execution.writeLease,
          );
        }
      }
      const chapter = snapshot.chapters.chapters.find((entry) => entry.chapterId === input.chapterId);
      if (!chapter) rejectNovelPrecondition("待保存章节不存在。", { reason: "not_found", chapterId: input.chapterId });
      if (chapter.revision !== input.expectedRevision || chapter.sha256 !== input.expectedSha256) {
        rejectNovelPrecondition("章节 revision/SHA CAS 已过期。", {
          reason: chapter.revision !== input.expectedRevision ? "revision_conflict" : "content_conflict",
          chapterId: chapter.chapterId,
          expectedRevision: input.expectedRevision,
          currentRevision: chapter.revision,
          expectedSha256: input.expectedSha256,
          currentSha256: chapter.sha256,
        });
      }
      const current = await currentLocatorState(this.projectRoot, chapter.relativePath);
      if (!current.exists || current.sha256 !== chapter.sha256 || current.size !== chapter.byteLength) {
        rejectNovelPrecondition("章节磁盘内容已被外部修改，拒绝自动覆盖。", {
          reason: "external_change",
          chapterId: chapter.chapterId,
          expectedRevision: chapter.revision,
          currentRevision: chapter.revision,
          expectedSha256: chapter.sha256,
          ...(current.exists ? { currentSha256: current.sha256 } : {}),
        });
      }
      const nextBytes = contentBytes(input.content);
      const nextSha = sha256(nextBytes);
      if (nextSha === chapter.sha256) {
        return { chapter, manifest: snapshot.chapters, replayed: false, changed: false };
      }
      await persistHistory(this.projectRoot, jsonBytes(snapshot.chapters), {
        chapterId: chapter.chapterId,
        bytes: current.bytes,
        sha256: chapter.sha256,
      });
      const now = nextManifestTimestamp(snapshot.chapters);
      const nextChapter: NovelChapterRecord = {
        ...chapter,
        sha256: nextSha,
        byteLength: nextBytes.byteLength,
        charCount: input.content.length,
        revision: chapter.revision + 1,
        updatedAt: now,
      };
      const nextManifest: NovelChapterManifest = {
        ...snapshot.chapters,
        revision: snapshot.chapters.revision + 1,
        chapters: snapshot.chapters.chapters.map((entry) => entry.chapterId === chapter.chapterId ? nextChapter : entry),
        updatedAt: now,
      };
      const result = await executeMutation(this.projectRoot, "save", snapshot.chapters, nextManifest, {
        kind: "replace",
        sourceLocator: chapter.relativePath,
        beforeSha256: chapter.sha256,
        beforeSize: chapter.byteLength,
        afterSha256: nextSha,
        afterSize: nextBytes.byteLength,
        contentObjectName: "after-content.bin",
      }, nextBytes);
      return { ...result, chapter: nextChapter };
      });
    });
  }

  async createChapter(input: CreateNovelChapterInput): Promise<NovelMutationResult> {
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      const context = requireMutationContext();
      return executeAfterRecoveringIncompleteOperations(this.projectRoot, async () => {
      const snapshot = await readWorkspaceAndManifest(this.projectRoot);
      if (!snapshot.chapters || snapshot.workspace.sourceMode !== "managed_markdown") {
        rejectNovelPrecondition("当前小说来源只读。", { reason: "read_only" });
      }
      if (snapshot.chapters.revision !== input.expectedManifestRevision) {
        rejectNovelPrecondition("chapter manifest revision CAS 已过期。", {
          reason: "revision_conflict",
          expectedRevision: input.expectedManifestRevision,
          currentRevision: snapshot.chapters.revision,
        });
      }
      if (!snapshot.chapters.volumes.some((entry) => entry.volumeId === input.volumeId)) {
        rejectNovelPrecondition("目标卷不存在。", { reason: "not_found", volumeId: input.volumeId });
      }
      const title = normalizeTitle(input.title);
      const chapterId = deterministicUuid(`${context.requestHash}\0create\0chapter`);
      const relativePath = `manuscript/volumes/${input.volumeId}/${chapterId}.md`;
      const bytes = contentBytes(input.content ?? "");
      const now = nextManifestTimestamp(snapshot.chapters);
      const siblings = snapshot.chapters.chapters.filter((entry) => entry.volumeId === input.volumeId);
      const requestedOrder = input.order ?? siblings.length;
      if (!Number.isSafeInteger(requestedOrder) || requestedOrder < 0 || requestedOrder > siblings.length) {
        rejectNovelPrecondition("新章节 order 越界。", { reason: "invalid_target", volumeId: input.volumeId });
      }
      const shifted = snapshot.chapters.chapters.map((entry) => entry.volumeId === input.volumeId && entry.order >= requestedOrder
        ? { ...entry, order: entry.order + 1 }
        : entry);
      const chapter: NovelChapterRecord = {
        chapterId,
        volumeId: input.volumeId,
        title,
        order: requestedOrder,
        relativePath,
        sha256: sha256(bytes),
        byteLength: bytes.byteLength,
        charCount: (input.content ?? "").length,
        offsetEncoding: NOVEL_OFFSET_ENCODING,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const nextManifest: NovelChapterManifest = {
        ...snapshot.chapters,
        revision: snapshot.chapters.revision + 1,
        chapters: [...shifted, chapter],
        updatedAt: now,
      };
      const result = await executeMutation(this.projectRoot, "create", snapshot.chapters, nextManifest, {
        kind: "create",
        targetLocator: relativePath,
        afterSha256: chapter.sha256,
        afterSize: chapter.byteLength,
        contentObjectName: "after-content.bin",
      }, bytes);
      return { ...result, chapter };
      });
    });
  }

  async createVolume(input: CreateNovelVolumeInput): Promise<NovelMutationResult & { volume: NovelVolumeRecord }> {
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      const context = requireMutationContext();
      return executeAfterRecoveringIncompleteOperations(this.projectRoot, async () => {
      const snapshot = await readWorkspaceAndManifest(this.projectRoot);
      if (!snapshot.chapters || snapshot.workspace.sourceMode !== "managed_markdown") {
        rejectNovelPrecondition("当前小说来源只读。", { reason: "read_only" });
      }
      if (snapshot.chapters.revision !== input.expectedManifestRevision) {
        rejectNovelPrecondition("chapter manifest revision CAS 已过期。", {
          reason: "revision_conflict",
          expectedRevision: input.expectedManifestRevision,
          currentRevision: snapshot.chapters.revision,
        });
      }
      const order = input.order ?? snapshot.chapters.volumes.length;
      if (!Number.isSafeInteger(order) || order < 0 || order > snapshot.chapters.volumes.length) {
        rejectNovelPrecondition("新卷 order 越界。", { reason: "invalid_target" });
      }
      const now = nextManifestTimestamp(snapshot.chapters);
      const volume: NovelVolumeRecord = {
        volumeId: deterministicUuid(`${context.requestHash}\0create-volume\0volume`),
        title: normalizeTitle(input.title, "卷标题"),
        order,
        revision: 1,
      };
      const nextManifest: NovelChapterManifest = {
        ...snapshot.chapters,
        revision: snapshot.chapters.revision + 1,
        volumes: [
          ...snapshot.chapters.volumes.map((entry) => entry.order >= order ? { ...entry, order: entry.order + 1 } : entry),
          volume,
        ],
        updatedAt: now,
      };
      const result = await executeMutation(this.projectRoot, "create_volume", snapshot.chapters, nextManifest, { kind: "none" });
      return { ...result, volume };
      });
    });
  }

  async renameChapter(input: RenameNovelChapterInput): Promise<NovelMutationResult> {
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      requireMutationContext();
      return executeAfterRecoveringIncompleteOperations(this.projectRoot, async () => {
      const snapshot = await readWorkspaceAndManifest(this.projectRoot);
      if (!snapshot.chapters || snapshot.workspace.sourceMode !== "managed_markdown") {
        rejectNovelPrecondition("当前小说来源只读。", { reason: "read_only" });
      }
      if (snapshot.chapters.revision !== input.expectedManifestRevision) {
        rejectNovelPrecondition("chapter manifest revision CAS 已过期。", {
          reason: "revision_conflict",
          expectedRevision: input.expectedManifestRevision,
          currentRevision: snapshot.chapters.revision,
        });
      }
      const chapter = snapshot.chapters.chapters.find((entry) => entry.chapterId === input.chapterId);
      if (!chapter) rejectNovelPrecondition("待改名章节不存在。", { reason: "not_found", chapterId: input.chapterId });
      if (chapter.revision !== input.expectedRevision) {
        rejectNovelPrecondition("章节 revision CAS 已过期。", {
          reason: "revision_conflict",
          chapterId: chapter.chapterId,
          expectedRevision: input.expectedRevision,
          currentRevision: chapter.revision,
        });
      }
      const nextChapter = {
        ...chapter,
        title: normalizeTitle(input.title),
        revision: chapter.revision + 1,
        updatedAt: nextManifestTimestamp(snapshot.chapters),
      };
      const nextManifest = {
        ...snapshot.chapters,
        revision: snapshot.chapters.revision + 1,
        chapters: snapshot.chapters.chapters.map((entry) => entry.chapterId === chapter.chapterId ? nextChapter : entry),
        updatedAt: nextChapter.updatedAt,
      };
      const result = await executeMutation(this.projectRoot, "rename", snapshot.chapters, nextManifest, { kind: "none" });
      return { ...result, chapter: nextChapter };
      });
    });
  }

  async moveChapter(input: MoveNovelChapterInput): Promise<NovelMutationResult> {
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      requireMutationContext();
      return executeAfterRecoveringIncompleteOperations(this.projectRoot, async () => {
      const snapshot = await readWorkspaceAndManifest(this.projectRoot);
      if (!snapshot.chapters || snapshot.workspace.sourceMode !== "managed_markdown") {
        rejectNovelPrecondition("当前小说来源只读。", { reason: "read_only" });
      }
      if (snapshot.chapters.revision !== input.expectedManifestRevision) {
        rejectNovelPrecondition("chapter manifest revision CAS 已过期。", {
          reason: "revision_conflict",
          expectedRevision: input.expectedManifestRevision,
          currentRevision: snapshot.chapters.revision,
        });
      }
      const chapter = snapshot.chapters.chapters.find((entry) => entry.chapterId === input.chapterId);
      if (!chapter) rejectNovelPrecondition("待移动章节不存在。", { reason: "not_found", chapterId: input.chapterId });
      if (chapter.revision !== input.expectedRevision || chapter.sha256 !== input.expectedSha256) {
        rejectNovelPrecondition("章节 revision/SHA CAS 已过期。", {
          reason: chapter.revision !== input.expectedRevision ? "revision_conflict" : "content_conflict",
          chapterId: chapter.chapterId,
          expectedRevision: input.expectedRevision,
          currentRevision: chapter.revision,
          expectedSha256: input.expectedSha256,
          currentSha256: chapter.sha256,
        });
      }
      if (!snapshot.chapters.volumes.some((entry) => entry.volumeId === input.volumeId)) {
        rejectNovelPrecondition("目标卷不存在。", { reason: "not_found", volumeId: input.volumeId });
      }
      const targetSiblings = snapshot.chapters.chapters.filter((entry) => entry.volumeId === input.volumeId && entry.chapterId !== chapter.chapterId);
      const targetOrder = input.order ?? targetSiblings.length;
      if (!Number.isSafeInteger(targetOrder) || targetOrder < 0 || targetOrder > targetSiblings.length) {
        rejectNovelPrecondition("目标 order 越界。", { reason: "invalid_target", chapterId: chapter.chapterId, volumeId: input.volumeId });
      }
      const nextLocator = `manuscript/volumes/${input.volumeId}/${chapter.chapterId}.md`;
      const now = nextManifestTimestamp(snapshot.chapters);
      const rebalanced = snapshot.chapters.chapters
        .filter((entry) => entry.chapterId !== chapter.chapterId)
        .map((entry) => ({ ...entry }));
      for (const volume of snapshot.chapters.volumes) {
        const siblings = rebalanced.filter((entry) => entry.volumeId === volume.volumeId)
          .sort((left, right) => left.order - right.order || left.chapterId.localeCompare(right.chapterId));
        siblings.forEach((entry, index) => { entry.order = index; });
      }
      for (const entry of rebalanced.filter((item) => item.volumeId === input.volumeId && item.order >= targetOrder)) entry.order += 1;
      const nextChapter: NovelChapterRecord = {
        ...chapter,
        volumeId: input.volumeId,
        order: targetOrder,
        relativePath: nextLocator,
        revision: chapter.revision + 1,
        updatedAt: now,
      };
      const nextManifest: NovelChapterManifest = {
        ...snapshot.chapters,
        revision: snapshot.chapters.revision + 1,
        chapters: [...rebalanced, nextChapter],
        updatedAt: now,
      };
      const fileMutation: NovelMutationIntent["fileMutation"] = nextLocator === chapter.relativePath
        ? { kind: "none" }
        : {
          kind: "move",
          sourceLocator: chapter.relativePath,
          targetLocator: nextLocator,
          sha256: chapter.sha256,
          size: chapter.byteLength,
        };
      const result = await executeMutation(this.projectRoot, "move", snapshot.chapters, nextManifest, fileMutation);
      return { ...result, chapter: nextChapter };
      });
    });
  }

  async reorderChapters(input: ReorderNovelChaptersInput): Promise<NovelMutationResult> {
    return withProjectLock(this.projectRoot, "novel-manuscript", async () => {
      requireMutationContext();
      return executeAfterRecoveringIncompleteOperations(this.projectRoot, async () => {
      const snapshot = await readWorkspaceAndManifest(this.projectRoot);
      if (!snapshot.chapters || snapshot.workspace.sourceMode !== "managed_markdown") {
        rejectNovelPrecondition("当前小说来源只读。", { reason: "read_only" });
      }
      if (snapshot.chapters.revision !== input.expectedManifestRevision) {
        rejectNovelPrecondition("chapter manifest revision CAS 已过期。", {
          reason: "revision_conflict",
          expectedRevision: input.expectedManifestRevision,
          currentRevision: snapshot.chapters.revision,
        });
      }
      if (input.orderedChapterIds.length !== snapshot.chapters.chapters.length
        || new Set(input.orderedChapterIds).size !== input.orderedChapterIds.length
        || input.orderedChapterIds.some((id) => !snapshot.chapters?.chapters.some((chapter) => chapter.chapterId === id))) {
        rejectNovelPrecondition("重排必须精确覆盖全部章节 stable ID。", { reason: "invalid_target" });
      }
      const now = nextManifestTimestamp(snapshot.chapters);
      const position = new Map(input.orderedChapterIds.map((id, index) => [id, index]));
      const perVolume = new Map<string, NovelChapterRecord[]>();
      for (const chapter of [...snapshot.chapters.chapters].sort((left, right) => (position.get(left.chapterId) ?? 0) - (position.get(right.chapterId) ?? 0))) {
        const bucket = perVolume.get(chapter.volumeId) ?? [];
        bucket.push(chapter);
        perVolume.set(chapter.volumeId, bucket);
      }
      const nextById = new Map<string, NovelChapterRecord>();
      for (const chapters of perVolume.values()) chapters.forEach((chapter, order) => {
        nextById.set(chapter.chapterId, { ...chapter, order, updatedAt: now });
      });
      const nextManifest: NovelChapterManifest = {
        ...snapshot.chapters,
        revision: snapshot.chapters.revision + 1,
        chapters: snapshot.chapters.chapters.map((chapter) => nextById.get(chapter.chapterId) ?? chapter),
        updatedAt: now,
      };
      return executeMutation(this.projectRoot, "reorder", snapshot.chapters, nextManifest, { kind: "none" });
      });
    });
  }
}

export async function getNovelWorkspaceSnapshot(projectRoot: string): Promise<NovelWorkspaceSnapshot> {
  return new NovelRepository(projectRoot).snapshot();
}

export async function getNovelWorkspaceNavigation(
  projectRoot: string,
  options: { offset?: number; limit?: number; anchorVolumeId?: string } = {},
): Promise<NovelWorkspaceNavigation> {
  return new NovelRepository(projectRoot).getNavigation(options);
}

export async function listNovelChapters(
  projectRoot: string,
  options: { offset?: number; limit?: number; volumeId?: string; anchorChapterId?: string } = {},
) {
  return new NovelRepository(projectRoot).listChapters(options);
}

export async function readNovelChapter(projectRoot: string, chapterId: string): Promise<NovelChapterReadResult> {
  return new NovelRepository(projectRoot).readChapter(chapterId);
}

export async function searchNovelChapters(
  projectRoot: string,
  input: SearchNovelChaptersInput,
): Promise<NovelChapterSearchResult> {
  return new NovelRepository(projectRoot).searchChapters(input);
}
