import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  assertConfinedRootIdentity,
  ensureConfinedDirectory,
  inspectExistingConfinedDirectory,
  inspectExistingConfinedDirectoryAtExpectedRoot,
  moveConfinedDirectoryNoReplace,
  persistConfinedBytesNoReplace,
  readConfinedRegularFileWithIdentity,
  revalidateConfinedDirectory,
  type ConfinedDirectoryIdentity,
  type ConfinedRootIdentityExpectation,
} from "./confined-project-storage.js";
import {
  createManagedProject,
  inspectManagedProjectReadOnly,
  managedProjectSlug,
  readManagedProjectBootstrapClaim,
  resumeManagedProjectBootstrap,
  type ProjectShell,
} from "./managed-project.js";
import {
  preflightNovelImport,
  readNovelPreflightSourceForCommit,
  splitNovelImportTextByFrozenAlgorithm,
  withNovelImportPreflightAuthorization,
} from "./novel-import.js";
import { NovelRepository } from "./novel-manuscript.js";
import { parseNovelDocxIsolated } from "./novel-docx.js";
import { getOperationContext, type OperationContext } from "./operation-context.js";
import { readNovelProjectFile, resolveNovelProjectLocator } from "./novel-path-policy.js";
import { listRegisteredProjects, registerProjectGuarded } from "./sidecar.js";
import {
  NOVEL_CHAPTER_MANIFEST_RELATIVE_PATH,
  NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM,
  NOVEL_IMPORT_DUPLICATE_RESOLUTIONS,
  NOVEL_OFFSET_ENCODING,
  type NovelChapterManifest,
  type NovelChapterRecord,
  type NovelImportDuplicateResolution,
  type NovelImportReceipt,
  type NovelImportReceiptChapter,
  type NovelImportPreflight,
  type NovelPreflightFile,
} from "./novel-types.js";

const TRANSACTION_NAMESPACE = ".aicanvas-novel-import-transactions";
const IMPORT_STATES = [
  "preflighted",
  "staging_created",
  "source_objects_copied",
  "markdown_materialized",
  "chapters_reconciled",
  "hashes_verified",
  "atomically_published",
  "registered",
] as const;
type ImportStateName = typeof IMPORT_STATES[number];
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

interface NovelImportTransactionIntent {
  schemaVersion: 1;
  kind: "novel-import-transaction-intent";
  receiptId: string;
  requestHash: string;
  projectName: string;
  projectSlug: string;
  preflightId: string;
  preflightFingerprint: string;
  sourceTreeAggregateSha256: string;
  chapterSplitAlgorithm: typeof NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM;
  duplicateResolution: NovelImportDuplicateResolution;
  convertToManagedMarkdown: true;
  sourceProjectsDisjoint: true;
  createdAt: string;
  fingerprint: string;
}

interface NovelImportProjectAllocation {
  schemaVersion: 1;
  kind: "novel-import-project-allocation";
  receiptId: string;
  /** 持久化 locator；绝不在 transaction 中保存本机绝对 projectsRoot。 */
  projectDirectoryName: string;
  /** 仅运行时由 canonical projectsRoot + projectDirectoryName 派生。 */
  projectRoot: string;
  projectId: string;
  intentFingerprint: string;
  fingerprint: string;
}

interface NovelImportStateReceipt {
  schemaVersion: 1;
  kind: "novel-import-state";
  receiptId: string;
  index: number;
  state: ImportStateName;
  previousFingerprint?: string;
  factsFingerprint: string;
  intentFingerprint: string;
  createdAt: string;
  fingerprint: string;
}

export interface CommitNovelExternalImportInput {
  projectsRoot: string;
  projectName: string;
  preflightId: string;
  preflightFingerprint: string;
  sourceTreeAggregateSha256: string;
  preflightAuthorization?: string;
  duplicateResolution: NovelImportDuplicateResolution;
  convertToManagedMarkdown: true;
}

export interface CommitNovelExternalImportResult {
  projectRoot: string;
  receipt: NovelImportReceipt & {
    chapterManifestSha256: string;
    stateChainFingerprint: string;
  };
  replayed: boolean;
}

interface CanonicalChapterDraft {
  sourceFile: NovelPreflightFile;
  sourceChapterIndex: number;
  title: string;
  content: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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

function deriveNovelImportReceiptId(input: {
  projectsRoot: string;
  projectName: string;
  preflightFingerprint: string;
  duplicateResolution: NovelImportDuplicateResolution;
}): string {
  return `novel-import-${sha256(JSON.stringify(stableValue({
    projectsRoot: input.projectsRoot,
    projectName: input.projectName,
    preflightFingerprint: input.preflightFingerprint,
    chapterSplitAlgorithm: NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM,
    duplicateResolution: input.duplicateResolution,
  }))).slice(0, 32)}`;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`${label} 包含未支持字段：${extra.sort().join("、")}`);
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} JSON 无法验证。`, { cause: error });
  }
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeProjectName(value: string): string {
  const normalized = typeof value === "string" ? value.normalize("NFC").trim() : "";
  if (!normalized || normalized.length > 120 || /\p{Cc}/u.test(normalized)) {
    throw new Error("导入项目名称为空、过长或包含控制字符。");
  }
  return normalized;
}

function sourceDisplayName(sourcePath: string): string {
  const basename = (path.basename(sourcePath) || "source").normalize("NFC");
  const portable = basename.replace(/[\\/]/gu, "＿").replace(/\0/gu, "").trim();
  return portable || "source";
}

function requireImportOperationContext(): OperationContext {
  const context = getOperationContext();
  if (!context || context.command !== "novel_import_external_snapshot" || !SHA256_PATTERN.test(context.requestHash)) {
    throw new Error("小说导入提交必须在 novel command operation context 中执行。");
  }
  return context;
}

/**
 * 导入命令与 Main 预检共用的只读 projectsRoot 门。
 * 本函数只做 lstat/realpath，不会创建锁、sidecar 或目录。
 */
export async function resolveNovelImportProjectsRoot(value: string): Promise<string> {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("projectsRoot 必须是绝对路径。");
  const root = path.resolve(value);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("projectsRoot 必须是无符号链接的规范真实目录。");
  }
  return root;
}

function isSameOrDescendant(candidate: string, ancestor: string): boolean {
  const relative = path.relative(ancestor, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * 拒绝任何 projectsRoot 与来源选择/来源根的祖先、后代或相同关系。
 * 参数必须是已由服务端预检与 realpath 门得到的规范绝对路径。
 */
export function assertNovelImportSourceProjectsDisjoint(
  projectsRoot: string,
  sourcePath: string,
  sourceRoot: string,
): void {
  if (![projectsRoot, sourcePath, sourceRoot].every((value) => typeof value === "string"
    && path.isAbsolute(value) && path.resolve(value) === value)) {
    throw new Error("小说导入路径隔离门只接受规范绝对路径。");
  }
  // directory 选择的 sourceRoot 就是来源边界；单文件的 sourceRoot 只是用于
  // canonical parent 校验，不能把整个父目录误当禁区，否则常见的
  // Documents/book.md → Documents/NovelProjects 会被错误拒绝。
  const sourceLocations = sourcePath === sourceRoot ? [sourceRoot] : [sourcePath];
  const overlaps = sourceLocations.some((sourceLocation) => (
    isSameOrDescendant(projectsRoot, sourceLocation)
      || isSameOrDescendant(sourceLocation, projectsRoot)
  ));
  if (overlaps) {
    throw new Error("projectsRoot 与小说来源路径不得相同、互为祖先或互为后代。");
  }
}

export function assertNovelImportDestinationDoesNotOverlapPreflight(
  projectsRoot: string,
  preflight: Pick<NovelImportPreflight, "sourcePath" | "sourceRoot">,
): void {
  assertNovelImportSourceProjectsDisjoint(projectsRoot, preflight.sourcePath, preflight.sourceRoot);
}

async function readOptional(
  directory: ConfinedDirectoryIdentity,
  name: string,
  maximumBytes = 8 * 1024 * 1024,
): Promise<Buffer | null> {
  return readSingleLinkConfinedFile(directory, name, maximumBytes, `小说导入内部文件 ${name}`)
    .then((read) => read.bytes, (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
}

async function readSingleLinkConfinedFile(
  directory: ConfinedDirectoryIdentity,
  name: string,
  maximumBytes: number,
  label: string,
): Promise<Awaited<ReturnType<typeof readConfinedRegularFileWithIdentity>>> {
  const read = await readConfinedRegularFileWithIdentity(directory, name, maximumBytes);
  if (read.nlink !== 1) throw new Error(`${label} 必须是单链接普通文件。`);
  return read;
}

function validateTransactionIntent(value: unknown): NovelImportTransactionIntent {
  if (record(value)) {
    requireExactKeys(value, [
      "schemaVersion", "kind", "receiptId", "requestHash", "projectName", "projectSlug",
      "preflightId", "preflightFingerprint", "sourceTreeAggregateSha256",
      "chapterSplitAlgorithm", "duplicateResolution", "convertToManagedMarkdown",
      "sourceProjectsDisjoint", "createdAt", "fingerprint",
    ], "小说导入 transaction intent");
  }
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "novel-import-transaction-intent"
    || typeof value.receiptId !== "string" || typeof value.requestHash !== "string"
    || typeof value.projectName !== "string" || typeof value.projectSlug !== "string"
    || typeof value.preflightId !== "string" || typeof value.preflightFingerprint !== "string"
    || typeof value.sourceTreeAggregateSha256 !== "string"
    || value.chapterSplitAlgorithm !== NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM
    || typeof value.duplicateResolution !== "string"
    || !(NOVEL_IMPORT_DUPLICATE_RESOLUTIONS as readonly string[]).includes(value.duplicateResolution)
    || value.convertToManagedMarkdown !== true
    || value.sourceProjectsDisjoint !== true
    || !isCanonicalIsoTimestamp(value.createdAt) || typeof value.fingerprint !== "string") {
    throw new Error("小说导入 transaction intent 结构无效。");
  }
  const payload = { ...value };
  delete payload.fingerprint;
  if (!SHA256_PATTERN.test(value.requestHash) || !SHA256_PATTERN.test(value.preflightFingerprint)
    || !SHA256_PATTERN.test(value.sourceTreeAggregateSha256) || !SHA256_PATTERN.test(value.fingerprint)
    || fingerprint(payload) !== value.fingerprint) {
    throw new Error("小说导入 transaction intent fingerprint 无效。");
  }
  return value as unknown as NovelImportTransactionIntent;
}

function validateProjectAllocation(
  value: unknown,
  projectsRoot: string,
  intent: NovelImportTransactionIntent,
): NovelImportProjectAllocation {
  if (record(value)) {
    requireExactKeys(value, [
      "schemaVersion", "kind", "receiptId", "projectDirectoryName", "projectId",
      "intentFingerprint", "fingerprint",
    ], "小说导入 allocation");
  }
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "novel-import-project-allocation"
    || value.receiptId !== intent.receiptId || typeof value.projectDirectoryName !== "string"
    || !value.projectDirectoryName || value.projectDirectoryName === "." || value.projectDirectoryName === ".."
    || path.basename(value.projectDirectoryName) !== value.projectDirectoryName
    || value.projectDirectoryName.includes("/") || value.projectDirectoryName.includes("\\")
    || typeof value.projectId !== "string" || value.intentFingerprint !== intent.fingerprint
    || typeof value.fingerprint !== "string") {
    throw new Error("小说导入 allocation 结构无效。");
  }
  const payload = { ...value };
  delete payload.fingerprint;
  if (fingerprint(payload) !== value.fingerprint) throw new Error("小说导入 allocation fingerprint 无效。");
  const projectRoot = path.join(projectsRoot, value.projectDirectoryName);
  if (path.dirname(projectRoot) !== projectsRoot) throw new Error("小说导入 allocation locator 越出 projectsRoot。");
  return { ...value, projectRoot } as unknown as NovelImportProjectAllocation;
}

function stateFileName(index: number, state: ImportStateName): string {
  return `${String(index + 1).padStart(4, "0")}-${state}.json`;
}

function buildImportStateReceipt(
  intent: NovelImportTransactionIntent,
  state: ImportStateName,
  previousFingerprint: string | undefined,
  facts: unknown,
): NovelImportStateReceipt {
  const index = IMPORT_STATES.indexOf(state);
  if (index < 0) throw new Error("导入状态名无效。");
  const semantic = {
    schemaVersion: 1 as const,
    kind: "novel-import-state" as const,
    receiptId: intent.receiptId,
    index,
    state,
    ...(previousFingerprint ? { previousFingerprint } : {}),
    factsFingerprint: fingerprint(facts),
    intentFingerprint: intent.fingerprint,
    createdAt: intent.createdAt,
  };
  return { ...semantic, fingerprint: fingerprint(semantic) };
}

async function persistImportState(
  transactionStates: ConfinedDirectoryIdentity,
  projectStates: ConfinedDirectoryIdentity | null,
  intent: NovelImportTransactionIntent,
  state: ImportStateName,
  previousFingerprint: string | undefined,
  facts: unknown,
): Promise<string> {
  const receipt = buildImportStateReceipt(intent, state, previousFingerprint, facts);
  const bytes = jsonBytes(receipt);
  const name = stateFileName(receipt.index, state);
  await persistConfinedBytesNoReplace(transactionStates, name, bytes);
  if (projectStates) await persistConfinedBytesNoReplace(projectStates, name, bytes);
  return receipt.fingerprint;
}

function maybeInterruptNovelImportForTests(
  state: ImportStateName | "transaction_directory_prepared" | "receipt_candidate_persisted",
): void {
  if (process.env.NODE_ENV === "test" && process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT === state) {
    throw new Error(`test-only novel import interruption: ${state}`);
  }
}

export type NovelImportCopyTestEvent = Readonly<{
  state: "source_object_copied";
  sourceRelativePath: string;
  copiedSourceObjects: number;
}>;

let novelImportCopyHookForTests: ((event: NovelImportCopyTestEvent) => void | Promise<void>) | null = null;

export function setNovelImportCopyHookForTests(
  hook: ((event: NovelImportCopyTestEvent) => void | Promise<void>) | null,
): void {
  if (process.env.NODE_ENV !== "test") throw new Error("小说导入复制 hook 只允许在测试环境使用。");
  novelImportCopyHookForTests = hook;
}

async function runNovelImportCopyHookForTests(event: NovelImportCopyTestEvent): Promise<void> {
  if (process.env.NODE_ENV === "test" && novelImportCopyHookForTests) await novelImportCopyHookForTests(event);
}

function titleFromHeading(line: string, fallback: string): string {
  const title = line.replace(/^#{1,6}\s*/u, "").normalize("NFC").trim();
  return title.slice(0, 200) || fallback;
}

function splitCanonicalChapters(file: NovelPreflightFile, sourceText: string): CanonicalChapterDraft[] {
  const fallback = path.posix.basename(file.relativePath, path.posix.extname(file.relativePath)).normalize("NFC").slice(0, 160);
  const segments = splitNovelImportTextByFrozenAlgorithm(sourceText);
  const drafts: CanonicalChapterDraft[] = segments.map((segment, index) => ({
    sourceFile: file,
    sourceChapterIndex: index,
    title: segment.kind === "prelude"
      ? `${fallback}·序`
      : segment.heading
        ? titleFromHeading(segment.heading, `${fallback}·${index + 1}`)
        : index ? `${fallback}·${index + 1}` : fallback,
    content: segment.content,
  }));
  if (drafts.length !== file.chapterCount) {
    throw new Error(`导入拆章数与预检不一致：${file.relativePath}（${drafts.length}/${file.chapterCount}）`);
  }
  return drafts;
}

async function createOrResumeImportProject(
  projectsRoot: string,
  intent: NovelImportTransactionIntent,
  transactionDirectory: ConfinedDirectoryIdentity,
): Promise<ProjectShell> {
  const bootstrapClaim = {
    purpose: "novel-external-import",
    payload: {
      receiptId: intent.receiptId,
      preflightFingerprint: intent.preflightFingerprint,
      sourceTreeAggregateSha256: intent.sourceTreeAggregateSha256,
    },
  };
  const allocationBytes = await readOptional(transactionDirectory, "allocation.json");
  let allocatedRoot: string | undefined;
  let allocatedProjectId: string | undefined;
  if (allocationBytes) {
    const value = validateProjectAllocation(parseJson(allocationBytes, "novel import allocation"), projectsRoot, intent);
    allocatedRoot = value.projectRoot;
    allocatedProjectId = value.projectId;
  } else {
    // createManagedProject 使用随机防碰撞后缀。若崩溃在 root 创建与
    // allocation receipt 之间，只按 bootstrap claim 的 receiptId 找回唯一 orphan。
    const candidates: Array<{ root: string; projectId?: string }> = [];
    for (const entry of await readdir(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === TRANSACTION_NAMESPACE) continue;
      const candidateRoot = path.join(projectsRoot, entry.name);
      const claim = await readManagedProjectBootstrapClaim(candidateRoot).catch(() => null);
      if (claim?.purpose === "novel-external-import"
        && record(claim.payload) && claim.payload.receiptId === intent.receiptId
        && claim.payload.preflightFingerprint === intent.preflightFingerprint) {
        candidates.push({ root: candidateRoot });
      }
    }
    if (candidates.length > 1) throw new Error("小说导入发现多个同 owner orphan，已停止自动恢复。");
    if (candidates.length === 1) {
      const recovered = await resumeManagedProjectBootstrap(candidates[0]!.root, {
        name: intent.projectName,
        workspaceMode: "novel",
        bootstrapClaim,
      });
      allocatedRoot = recovered.paths.root;
      allocatedProjectId = recovered.project.id;
    }
  }
  if (allocatedRoot) {
    const metadata = await lstat(allocatedRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(allocatedRoot) !== allocatedRoot) {
      throw new Error("导入 allocation 项目根身份已变化。");
    }
    const shell = await resumeManagedProjectBootstrap(allocatedRoot, {
      name: intent.projectName,
      workspaceMode: "novel",
      bootstrapClaim,
    });
    if (allocatedProjectId && shell.project.id !== allocatedProjectId) throw new Error("导入 allocation 项目 ID 已变化。");
    if (!allocationBytes) {
      const semantic = {
        schemaVersion: 1 as const,
        kind: "novel-import-project-allocation" as const,
        receiptId: intent.receiptId,
        projectDirectoryName: path.basename(shell.paths.root),
        projectId: shell.project.id,
        intentFingerprint: intent.fingerprint,
      };
      await persistConfinedBytesNoReplace(transactionDirectory, "allocation.json", jsonBytes({
        ...semantic,
        fingerprint: fingerprint(semantic),
      }));
    }
    return shell;
  }
  const shell = await createManagedProject({
    parentRoot: projectsRoot,
    name: intent.projectName,
    slug: intent.projectSlug,
    workspaceMode: "novel",
    bootstrapClaim,
  });
  const semantic = {
    schemaVersion: 1 as const,
    kind: "novel-import-project-allocation" as const,
    receiptId: intent.receiptId,
    projectDirectoryName: path.basename(shell.paths.root),
    projectId: shell.project.id,
    intentFingerprint: intent.fingerprint,
  };
  await persistConfinedBytesNoReplace(transactionDirectory, "allocation.json", jsonBytes({
    ...semantic,
    fingerprint: fingerprint(semantic),
  }));
  return shell;
}

async function verifyExactTree(root: string, expected: Set<string>): Promise<void> {
  const entries = (await readdir(root, { recursive: true })).map((entry) => String(entry).split(path.sep).join("/"));
  const actual = new Set(entries);
  if (actual.size !== expected.size || [...expected].some((entry) => !actual.has(entry))) {
    throw new Error("导入 manuscript 闭包包含缺失或无法归属的节点。");
  }
  for (const relative of entries) {
    const metadata = await lstat(path.join(root, ...relative.split("/")));
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error(`导入 manuscript 包含符号链接或特殊节点：${relative}`);
    }
  }
}

function isSafePortableRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  const segments = value.split("/");
  return path.posix.normalize(value) === value
    && segments.every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}

async function readExistingReceipt(
  projectRoot: string,
  receiptId: string,
): Promise<CommitNovelExternalImportResult["receipt"] | null> {
  const receiptDirectory = await inspectExistingConfinedDirectory(
    projectRoot,
    resolveNovelProjectLocator(projectRoot, `.aicanvas/novel/import-receipts/${receiptId}`).absolutePath,
  ).catch(() => null);
  if (!receiptDirectory) return null;
  const bytes = await readOptional(receiptDirectory, "receipt.json");
  if (!bytes) return null;
  const value = parseJson(bytes, "novel import receipt");
  if (record(value)) {
    requireExactKeys(value, [
      "schemaVersion", "kind", "receiptId", "projectId", "preflightId",
      "preflightFingerprint", "preflightChapterCount", "chapterSplitAlgorithm", "duplicateResolution",
      "skippedDuplicateSourcePaths", "sourceMode", "resultMode", "sourceDisplayName",
      "sourceTreeAggregateSha256", "converter", "sourceObjects", "chapters",
      "chapterManifestSha256", "stateChainFingerprint", "committedAt", "fingerprint",
    ], "小说导入 receipt");
  }
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "novel-import-receipt" || value.receiptId !== receiptId
    || typeof value.projectId !== "string" || typeof value.preflightId !== "string"
    || typeof value.preflightFingerprint !== "string" || !SHA256_PATTERN.test(value.preflightFingerprint)
    || !Number.isSafeInteger(value.preflightChapterCount) || (value.preflightChapterCount as number) < 1
    || value.sourceMode !== "external_snapshot" || value.resultMode !== "managed_markdown"
    || typeof value.sourceDisplayName !== "string" || !value.sourceDisplayName
    || value.sourceDisplayName.includes("\0") || value.sourceDisplayName.includes("/")
    || value.sourceDisplayName.includes("\\") || typeof value.sourceTreeAggregateSha256 !== "string"
    || !SHA256_PATTERN.test(value.sourceTreeAggregateSha256)
    || typeof value.fingerprint !== "string" || typeof value.chapterManifestSha256 !== "string"
    || typeof value.stateChainFingerprint !== "string"
    || value.chapterSplitAlgorithm !== NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM
    || typeof value.duplicateResolution !== "string"
    || !(NOVEL_IMPORT_DUPLICATE_RESOLUTIONS as readonly string[]).includes(value.duplicateResolution)
    || !Array.isArray(value.skippedDuplicateSourcePaths)
    || value.skippedDuplicateSourcePaths.some((entry) => !isSafePortableRelativePath(entry))
    || new Set(value.skippedDuplicateSourcePaths).size !== value.skippedDuplicateSourcePaths.length
    || !record(value.converter) || value.converter.name !== "aicanvas-novel-import" || value.converter.version !== 1
    || value.converter.chapterSplitAlgorithm !== NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM
    || (value.converter.docx !== undefined
      && (!record(value.converter.docx) || value.converter.docx.library !== "mammoth" || value.converter.docx.isolated !== true))
    || !Array.isArray(value.sourceObjects) || !Array.isArray(value.chapters)
    || !isCanonicalIsoTimestamp(value.committedAt)) {
    throw new Error("已存在导入回执结构无效。");
  }
  requireExactKeys(value.converter, [
    "name", "version", "chapterSplitAlgorithm", ...(value.converter.docx === undefined ? [] : ["docx"]),
  ], "小说导入 receipt.converter");
  if (record(value.converter.docx)) {
    requireExactKeys(value.converter.docx, ["library", "isolated"], "小说导入 receipt.converter.docx");
  }
  for (const entry of value.sourceObjects) {
    if (record(entry)) {
      requireExactKeys(entry, [
        "sourceRelativePath", "objectRelativePath", "sha256", "byteLength",
      ], "小说导入 receipt.sourceObject");
    }
    if (!record(entry) || !isSafePortableRelativePath(entry.sourceRelativePath)
      || !isSafePortableRelativePath(entry.objectRelativePath)
      || typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)
      || entry.objectRelativePath !== `.aicanvas/novel/source-objects/sha256/${entry.sha256.slice(0, 2)}/${entry.sha256}`
      || !Number.isSafeInteger(entry.byteLength) || (entry.byteLength as number) < 1) {
      throw new Error("已存在导入回执的 sourceObjects 闭包无效。");
    }
  }
  for (const chapter of value.chapters) {
    if (record(chapter)) {
      requireExactKeys(chapter, [
        "sourceRelativePath", "sourceSha256", "sourceChapterIndex", "chapterId", "volumeId",
        "relativePath", "sha256", "byteLength", "charCount",
      ], "小说导入 receipt.chapter");
    }
    if (!record(chapter) || !isSafePortableRelativePath(chapter.sourceRelativePath)
      || typeof chapter.sourceSha256 !== "string" || !SHA256_PATTERN.test(chapter.sourceSha256)
      || !Number.isSafeInteger(chapter.sourceChapterIndex) || (chapter.sourceChapterIndex as number) < 0
      || typeof chapter.chapterId !== "string" || typeof chapter.volumeId !== "string"
      || !isSafePortableRelativePath(chapter.relativePath)
      || chapter.relativePath !== `manuscript/volumes/${chapter.volumeId}/${chapter.chapterId}.md`
      || typeof chapter.sha256 !== "string" || !SHA256_PATTERN.test(chapter.sha256)
      || !Number.isSafeInteger(chapter.byteLength) || (chapter.byteLength as number) < 1
      || !Number.isSafeInteger(chapter.charCount) || (chapter.charCount as number) < 1) {
      throw new Error("已存在导入回执的 chapters 闭包无效。");
    }
  }
  const objectKeys = value.sourceObjects.map((entry) => `${String((entry as Record<string, unknown>).sourceRelativePath)}\0${String((entry as Record<string, unknown>).sha256)}`);
  const chapterIds = value.chapters.map((entry) => String((entry as Record<string, unknown>).chapterId));
  const chapterPaths = value.chapters.map((entry) => String((entry as Record<string, unknown>).relativePath));
  if (!value.sourceObjects.length || !value.chapters.length
    || new Set(objectKeys).size !== objectKeys.length
    || new Set(chapterIds).size !== chapterIds.length
    || new Set(chapterPaths).size !== chapterPaths.length
    || (value.preflightChapterCount as number) < value.chapters.length
    || (value.duplicateResolution === "include_all"
      && value.preflightChapterCount !== value.chapters.length)
    || (value.duplicateResolution === "include_all" && value.skippedDuplicateSourcePaths.length !== 0)
    || value.chapters.some((chapter) => {
      const row = chapter as Record<string, unknown>;
      return !objectKeys.includes(`${String(row.sourceRelativePath)}\0${String(row.sourceSha256)}`);
    })) {
    throw new Error("已存在导入回执的 sourceObjects/chapters 关联闭包无效。");
  }
  const payload = { ...value };
  delete payload.fingerprint;
  if (fingerprint(payload) !== value.fingerprint) throw new Error("已存在导入回执 fingerprint 无效。");
  return value as unknown as CommitNovelExternalImportResult["receipt"];
}

function registeredStateFacts(
  allocation: Pick<NovelImportProjectAllocation, "projectId" | "projectDirectoryName">,
  chapterManifestSha256: string,
): Record<string, string> {
  return {
    projectId: allocation.projectId,
    projectDirectoryName: allocation.projectDirectoryName,
    chapterManifestSha256,
  };
}

interface ImportClosureValidationResult {
  preRegistrationStateFingerprint: string;
  registeredComplete: boolean;
}

async function validateImportClosure(
  projectsRoot: string,
  transactionDirectory: ConfinedDirectoryIdentity,
  intent: NovelImportTransactionIntent,
  allocation: NovelImportProjectAllocation,
  receipt: CommitNovelExternalImportResult["receipt"],
  requireRegisteredTerminal: boolean,
  requireInitialManuscript: boolean | "if-registered-incomplete",
): Promise<ImportClosureValidationResult> {
  const expectedTransactionDirectory = path.join(
    projectsRoot,
    TRANSACTION_NAMESPACE,
    intent.receiptId,
  );
  if (transactionDirectory.directory !== expectedTransactionDirectory
    || transactionDirectory.canonicalDirectory !== expectedTransactionDirectory) {
    throw new Error("已完成小说导入的 transaction 目录与 intent 不一致。");
  }
  const projectMetadata = await lstat(allocation.projectRoot);
  if (!projectMetadata.isDirectory() || projectMetadata.isSymbolicLink()
    || await realpath(allocation.projectRoot) !== allocation.projectRoot) {
    throw new Error("已完成小说导入的项目根身份已变化。");
  }
  if (path.dirname(allocation.projectRoot) !== projectsRoot
    || receipt.projectId !== allocation.projectId
    || receipt.receiptId !== intent.receiptId
    || receipt.preflightId !== intent.preflightId
    || receipt.preflightFingerprint !== intent.preflightFingerprint
    || receipt.sourceTreeAggregateSha256 !== intent.sourceTreeAggregateSha256
    || receipt.chapterSplitAlgorithm !== intent.chapterSplitAlgorithm
    || receipt.duplicateResolution !== intent.duplicateResolution
    || receipt.committedAt !== intent.createdAt) {
    throw new Error("已完成小说导入的 intent/allocation/receipt 绑定不一致。");
  }
  const managedShell = await inspectManagedProjectReadOnly(allocation.projectRoot);
  if (managedShell.manifest.schemaVersion !== 2 || managedShell.workspaceMode !== "novel"
    || managedShell.project.id !== allocation.projectId || managedShell.paths.root !== allocation.projectRoot) {
    throw new Error("已完成小说导入的受管项目壳与 allocation 不一致。");
  }

  const sourceObjectAggregate = fingerprint(receipt.sourceObjects.map((entry) => ({
    relativePath: entry.sourceRelativePath,
    sha256: entry.sha256,
    byteLength: entry.byteLength,
  })));
  const expectedStateFacts: Record<Exclude<ImportStateName, "registered">, unknown> = {
    preflighted: {
      preflightId: intent.preflightId,
      preflightFingerprint: intent.preflightFingerprint,
      preflightChapterCount: receipt.preflightChapterCount,
      aggregate: intent.sourceTreeAggregateSha256,
      chapterSplitAlgorithm: intent.chapterSplitAlgorithm,
      duplicateResolution: intent.duplicateResolution,
    },
    staging_created: {
      projectId: allocation.projectId,
      projectDirectoryName: allocation.projectDirectoryName,
      workspaceMode: managedShell.workspaceMode,
    },
    source_objects_copied: {
      count: receipt.sourceObjects.length,
      aggregate: sourceObjectAggregate,
    },
    markdown_materialized: {
      chapters: receipt.chapters.length,
      chapterManifestSha256: receipt.chapterManifestSha256,
    },
    chapters_reconciled: {
      preflightChapterCount: receipt.preflightChapterCount,
      selectedChapterCount: receipt.chapters.length,
      skippedDuplicateSourcePaths: receipt.skippedDuplicateSourcePaths,
      duplicateResolution: receipt.duplicateResolution,
      chapterSplitAlgorithm: receipt.chapterSplitAlgorithm,
      outputChapterCount: receipt.chapters.length,
      stableIdsFingerprint: fingerprint(receipt.chapters.map((chapter) => chapter.chapterId)),
    },
    hashes_verified: {
      chapterManifestSha256: receipt.chapterManifestSha256,
      sourceObjectAggregate,
      manuscriptAggregate: fingerprint(receipt.chapters.map((chapter) => ({
        path: chapter.relativePath,
        sha256: chapter.sha256,
      }))),
    },
    atomically_published: {
      chapterManifestSha256: receipt.chapterManifestSha256,
      manuscriptDirectory: "manuscript",
    },
  };

  const receiptBase = resolveNovelProjectLocator(
    allocation.projectRoot,
    `.aicanvas/novel/import-receipts/${intent.receiptId}`,
  ).absolutePath;
  const transactionStateDirectory = await inspectExistingConfinedDirectory(
    projectsRoot,
    path.join(transactionDirectory.directory, "states"),
  );
  const projectStateDirectory = await inspectExistingConfinedDirectory(
    allocation.projectRoot,
    path.join(receiptBase, "states"),
  );
  let previousStateFingerprint: string | undefined;
  const registeredIndex = IMPORT_STATES.indexOf("registered");
  for (let index = 0; index < registeredIndex; index += 1) {
    const stateName = IMPORT_STATES[index]! as Exclude<ImportStateName, "registered">;
    const name = stateFileName(index, stateName);
    const [transactionStateBytes, projectStateBytes] = await Promise.all([
      readSingleLinkConfinedFile(
        transactionStateDirectory,
        name,
        1024 * 1024,
        `已完成小说导入 transaction ${stateName} state`,
      ),
      readSingleLinkConfinedFile(
        projectStateDirectory,
        name,
        1024 * 1024,
        `已完成小说导入 project ${stateName} state`,
      ),
    ]);
    if (!transactionStateBytes.bytes.equals(projectStateBytes.bytes)) {
      throw new Error(`已完成小说导入的 ${stateName} 双镜像 state 不一致。`);
    }
    const state = parseJson(transactionStateBytes.bytes, `completed novel import ${stateName} state`);
    if (record(state)) {
      requireExactKeys(state, [
        "schemaVersion", "kind", "receiptId", "index", "state",
        ...(index === 0 ? [] : ["previousFingerprint"]),
        "factsFingerprint", "intentFingerprint", "createdAt", "fingerprint",
      ], `小说导入 ${stateName} state`);
    }
    if (!record(state) || state.schemaVersion !== 1 || state.kind !== "novel-import-state"
      || state.receiptId !== intent.receiptId || state.index !== index || state.state !== stateName
      || state.intentFingerprint !== intent.fingerprint
      || (index === 0 ? state.previousFingerprint !== undefined : state.previousFingerprint !== previousStateFingerprint)
      || !SHA256_PATTERN.test(String(state.factsFingerprint))
      || !isCanonicalIsoTimestamp(state.createdAt)
      || state.createdAt !== intent.createdAt
      || typeof state.fingerprint !== "string") {
      throw new Error(`已完成小说导入的 ${stateName} state chain 无效。`);
    }
    if (state.factsFingerprint !== fingerprint(expectedStateFacts[stateName])) {
      throw new Error(`已完成小说导入的 ${stateName} state facts 与业务闭包不一致。`);
    }
    const statePayload = { ...state };
    delete statePayload.fingerprint;
    if (fingerprint(statePayload) !== state.fingerprint) {
      throw new Error(`已完成导入的 ${stateName} state fingerprint 无效。`);
    }
    previousStateFingerprint = state.fingerprint;
  }
  const plannedRegisteredState = buildImportStateReceipt(
    intent,
    "registered",
    previousStateFingerprint,
    registeredStateFacts(allocation, receipt.chapterManifestSha256),
  );
  if (receipt.stateChainFingerprint !== plannedRegisteredState.fingerprint) {
    throw new Error("小说导入 receipt 与计划 registered terminal state 不一致。");
  }
  const registeredName = stateFileName(registeredIndex, "registered");
  const [transactionRegisteredBytes, projectRegisteredBytes] = await Promise.all([
    readOptional(transactionStateDirectory, registeredName, 1024 * 1024),
    readOptional(projectStateDirectory, registeredName, 1024 * 1024),
  ]);
  const expectedRegisteredBytes = jsonBytes(plannedRegisteredState);
  for (const [owner, bytes] of [
    ["transaction", transactionRegisteredBytes],
    ["project", projectRegisteredBytes],
  ] as const) {
    if (bytes && !bytes.equals(expectedRegisteredBytes)) {
      throw new Error(`已完成小说导入的 ${owner} registered terminal state 与 receipt 不一致。`);
    }
    if (requireRegisteredTerminal && !bytes) {
      throw new Error(`已完成小说导入缺少 ${owner} registered terminal state。`);
    }
  }
  const registeredComplete = Boolean(transactionRegisteredBytes && projectRegisteredBytes);

  for (const object of receipt.sourceObjects) {
    const absolute = resolveNovelProjectLocator(allocation.projectRoot, object.objectRelativePath).absolutePath;
    const directory = await inspectExistingConfinedDirectory(allocation.projectRoot, path.dirname(absolute));
    const read = await readSingleLinkConfinedFile(
      directory,
      path.basename(absolute),
      object.byteLength,
      `已完成小说导入 source object ${object.objectRelativePath}`,
    );
    if (read.bytes.byteLength !== object.byteLength || sha256(read.bytes) !== object.sha256) {
      throw new Error(`已完成导入的 source object 闭包不一致：${object.objectRelativePath}`);
    }
  }

  const repository = new NovelRepository(allocation.projectRoot);
  const snapshot = await repository.snapshot();
  if (snapshot.workspace.projectId !== allocation.projectId
    || !snapshot.workspace.sourceReceiptIds.includes(intent.receiptId)
    || !snapshot.chapters) {
    throw new Error("已完成导入的 novel workspace 身份或来源回执关联不一致。");
  }
  if (requireInitialManuscript === true
    || (requireInitialManuscript === "if-registered-incomplete" && !registeredComplete)) {
    const manifestAbsolute = resolveNovelProjectLocator(allocation.projectRoot, NOVEL_CHAPTER_MANIFEST_RELATIVE_PATH).absolutePath;
    const manifestDirectory = await inspectExistingConfinedDirectory(allocation.projectRoot, path.dirname(manifestAbsolute));
    const manifestRead = await readSingleLinkConfinedFile(
      manifestDirectory,
      path.basename(manifestAbsolute),
      64 * 1024 * 1024,
      "已完成小说导入初始 chapter manifest",
    );
    if (sha256(manifestRead.bytes) !== receipt.chapterManifestSha256) {
      throw new Error("已完成小说导入的初始 chapter manifest 与 receipt 不一致。");
    }
    if (snapshot.chapters.chapters.length !== receipt.chapters.length) {
      throw new Error("已完成小说导入的初始章节数与 receipt 不一致。");
    }
    const chapterById = new Map(snapshot.chapters.chapters.map((entry) => [entry.chapterId, entry] as const));
    for (const chapter of receipt.chapters) {
      const record = chapterById.get(chapter.chapterId);
      if (!record || record.volumeId !== chapter.volumeId || record.relativePath !== chapter.relativePath
        || record.sha256 !== chapter.sha256 || record.byteLength !== chapter.byteLength
        || record.charCount !== chapter.charCount || record.sourceReceiptId !== intent.receiptId) {
        throw new Error(`已完成小说导入的初始 chapter 记录与 receipt 不一致：${chapter.chapterId}`);
      }
      const read = await readNovelProjectFile(allocation.projectRoot, record.relativePath, {
        maxBytes: record.byteLength,
      });
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
      } catch (error) {
        throw new Error(`已完成小说导入的初始 chapter 不是合法 UTF-8：${chapter.chapterId}`, { cause: error });
      }
      if (read.sha256 !== chapter.sha256 || read.bytes.byteLength !== chapter.byteLength
        || content.length !== chapter.charCount) {
        throw new Error(`已完成小说导入的初始 chapter 内容闭包不一致：${chapter.chapterId}`);
      }
    }
  }

  if (requireRegisteredTerminal) {
    await assertImportProjectRegistrationOwner(allocation);
  }
  if (!previousStateFingerprint) throw new Error("小说导入缺少注册前 state chain fingerprint。");
  return { preRegistrationStateFingerprint: previousStateFingerprint, registeredComplete };
}

async function ensureImportProjectRegistered(shell: ProjectShell): Promise<void> {
  const registrations = await listRegisteredProjects();
  const owners = registrations.filter((entry) => entry.id === shell.project.id
    || path.resolve(entry.primaryRoot) === shell.paths.root);
  if (owners.length === 1 && owners[0]!.id === shell.project.id
    && path.resolve(owners[0]!.primaryRoot) === shell.paths.root) return;
  if (owners.length > 0) throw new Error("小说导入注册表存在项目 ID/根冲突。");
  await registerProjectGuarded(shell.project, (current) => {
    const conflicts = current.filter((entry) => entry.id === shell.project.id
      || path.resolve(entry.primaryRoot) === shell.paths.root);
    if (conflicts.length > 0) throw new Error("小说导入注册表存在项目 ID/根冲突。");
  });
}

async function assertImportProjectRegistrationOwner(
  allocation: NovelImportProjectAllocation,
): Promise<void> {
  const registrations = await listRegisteredProjects();
  const owners = registrations.filter((entry) => entry.id === allocation.projectId
    || path.resolve(entry.primaryRoot) === allocation.projectRoot);
  if (owners.length !== 1 || owners[0]!.id !== allocation.projectId
    || path.resolve(owners[0]!.primaryRoot) !== allocation.projectRoot) {
    throw new Error("已完成小说导入的注册表 owner 闭包不一致。");
  }
}

async function hasCompleteRegisteredStatePair(
  projectsRoot: string,
  transaction: ConfinedDirectoryIdentity,
  intent: NovelImportTransactionIntent,
  allocation: NovelImportProjectAllocation,
  receipt: CommitNovelExternalImportResult["receipt"],
  preRegistrationStateFingerprint: string,
): Promise<boolean> {
  const receiptBase = resolveNovelProjectLocator(
    allocation.projectRoot,
    `.aicanvas/novel/import-receipts/${intent.receiptId}`,
  ).absolutePath;
  const [transactionStates, projectStates] = await Promise.all([
    inspectExistingConfinedDirectory(projectsRoot, path.join(transaction.directory, "states")),
    inspectExistingConfinedDirectory(allocation.projectRoot, path.join(receiptBase, "states")),
  ]);
  const registeredIndex = IMPORT_STATES.indexOf("registered");
  const registeredName = stateFileName(registeredIndex, "registered");
  const expected = jsonBytes(buildImportStateReceipt(
    intent,
    "registered",
    preRegistrationStateFingerprint,
    registeredStateFacts(allocation, receipt.chapterManifestSha256),
  ));
  const [transactionBytes, projectBytes] = await Promise.all([
    readOptional(transactionStates, registeredName, 1024 * 1024),
    readOptional(projectStates, registeredName, 1024 * 1024),
  ]);
  // validateImportClosure(requireRegisteredTerminal=false) 已先保证任何存在的
  // terminal 都必须逐字节匹配；这里仅区分“历史完成”与“仍需恢复”。
  for (const bytes of [transactionBytes, projectBytes]) {
    if (bytes && !bytes.equals(expected)) {
      throw new Error("小说导入 registered terminal 与不可变 receipt 不一致。");
    }
  }
  return Boolean(transactionBytes && projectBytes);
}

async function findCompletedImportReplay(
  projectsRoot: string,
  projectName: string,
  duplicateResolution: NovelImportDuplicateResolution,
  requestHash: string,
  stablePreflightIdentity: Readonly<{
    preflightId: string;
    preflightFingerprint: string;
    sourceTreeAggregateSha256: string;
  }>,
  mode: "repair-terminal" | "prove-complete" = "repair-terminal",
  expectedRoot?: ConfinedRootIdentityExpectation,
): Promise<CommitNovelExternalImportResult | null> {
  const receiptId = deriveNovelImportReceiptId({
    projectsRoot,
    projectName,
    preflightFingerprint: stablePreflightIdentity.preflightFingerprint,
    duplicateResolution,
  });
  const transactionPath = path.join(projectsRoot, TRANSACTION_NAMESPACE, receiptId);
  const transaction = await (expectedRoot
    ? inspectExistingConfinedDirectoryAtExpectedRoot(expectedRoot, transactionPath)
    : inspectExistingConfinedDirectory(projectsRoot, transactionPath)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!transaction) return null;
  const intentBytes = await readOptional(transaction, "intent.json");
  if (!intentBytes) {
    const entries = await readdir(transaction.directory, { withFileTypes: true });
    await revalidateConfinedDirectory(transaction);
    for (const entry of entries) {
      if (!entry.isFile() || !/^\.aicanvas-dirfd-[a-f0-9]{32}\.tmp$/u.test(entry.name)) {
        throw new Error("小说导入 prepared transaction 缺少 intent 且包含无法归属节点。");
      }
      const metadata = await lstat(path.join(transaction.directory, entry.name));
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        throw new Error("小说导入 prepared transaction 临时节点身份无效。");
      }
    }
    return null;
  }
  const intent = validateTransactionIntent(parseJson(intentBytes, "novel import transaction intent"));
  if (intent.receiptId !== receiptId || intent.requestHash !== requestHash || intent.projectName !== projectName
    || intent.duplicateResolution !== duplicateResolution
    || intent.preflightId !== stablePreflightIdentity.preflightId
    || intent.preflightFingerprint !== stablePreflightIdentity.preflightFingerprint
    || intent.sourceTreeAggregateSha256 !== stablePreflightIdentity.sourceTreeAggregateSha256
    || intent.chapterSplitAlgorithm !== NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM) {
    throw new Error("确定性小说导入 transaction 与本次 operation 身份不一致。");
  }
  const allocationBytes = await readOptional(transaction, "allocation.json");
  const allocation = allocationBytes
    ? validateProjectAllocation(parseJson(allocationBytes, "novel import allocation"), projectsRoot, intent)
    : null;
  const receipt = allocation ? await readExistingReceipt(allocation.projectRoot, intent.receiptId) : null;
  const match = { intent, transaction, allocation, receipt };
  if (!match?.receipt || !match.allocation) return null;
  if (mode === "prove-complete") {
    const validation = await validateImportClosure(
      projectsRoot,
      match.transaction,
      match.intent,
      match.allocation,
      match.receipt,
      false,
      false,
    );
    if (!validation.registeredComplete) return null;
    await assertImportProjectRegistrationOwner(match.allocation);
    return { projectRoot: match.allocation.projectRoot, receipt: match.receipt, replayed: true };
  }
  // 先证明不可变 import receipt/state/source CAS。若双 registered terminal 已
  // 完整，说明初始正文在历史提交点已经验过；此后 managed Markdown 的正常
  // 保存、改名、移卷和重排不能反向把导入历史判为漂移。
  const validation = await validateImportClosure(
    projectsRoot,
    match.transaction,
    match.intent,
    match.allocation,
    match.receipt,
    false,
    "if-registered-incomplete",
  );
  const historicalStateFingerprint = validation.preRegistrationStateFingerprint;
  if (validation.registeredComplete) {
    const shell = await inspectManagedProjectReadOnly(match.allocation.projectRoot);
    await ensureImportProjectRegistered(shell);
    await assertImportProjectRegistrationOwner(match.allocation);
    return { projectRoot: match.allocation.projectRoot, receipt: match.receipt, replayed: true };
  }
  // receipt 只能作为恢复候选，不能单凭“文件存在”触发 bootstrap 修补、注册或
  // terminal state 写入。先用 allocation + receipt 对 source objects、manuscript、
  // workspace 与注册前 state chain 做完整只读证明；闭包损坏时必须零写失败关闭。
  const preRegistrationStateFingerprint = historicalStateFingerprint;
  const shell = await createOrResumeImportProject(projectsRoot, match.intent, match.transaction);
  if (shell.project.id !== match.allocation.projectId || shell.paths.root !== match.allocation.projectRoot) {
    throw new Error("小说导入恢复的项目壳与 allocation 不一致。");
  }
  await ensureImportProjectRegistered(shell);
  const transactionStates = await ensureConfinedDirectory(
    projectsRoot,
    path.join(match.transaction.directory, "states"),
    0o700,
    expectedRoot,
  );
  const receiptRoot = await inspectExistingConfinedDirectory(
    shell.paths.root,
    resolveNovelProjectLocator(shell.paths.root, `.aicanvas/novel/import-receipts/${match.intent.receiptId}`).absolutePath,
  );
  const projectStates = await ensureConfinedDirectory(shell.paths.root, path.join(receiptRoot.directory, "states"));
  const terminalFingerprint = await persistImportState(
    transactionStates,
    projectStates,
    match.intent,
    "registered",
    preRegistrationStateFingerprint,
    registeredStateFacts(match.allocation, match.receipt.chapterManifestSha256),
  );
  if (terminalFingerprint !== match.receipt.stateChainFingerprint) {
    throw new Error("小说导入恢复写入的 registered terminal fingerprint 与 receipt 不一致。");
  }
  await validateImportClosure(
    projectsRoot,
    match.transaction,
    match.intent,
    match.allocation,
    match.receipt,
    true,
    true,
  );
  return { projectRoot: match.allocation.projectRoot, receipt: match.receipt, replayed: true };
}

/**
 * 已成功 command ledger 的重放不能把账本文本当成业务事实。本入口只读
 * transaction、项目 receipt、双镜像 state、正文/CAS/workspace 与 registry，
 * 只有完整 registered 闭包成立才返回；不会修补 bootstrap、注册或 terminal。
 */
export async function proveCompletedNovelExternalImport(
  input: Omit<CommitNovelExternalImportInput, "preflightAuthorization">,
  requestHash: string,
): Promise<CommitNovelExternalImportResult | null> {
  if (input?.convertToManagedMarkdown !== true) {
    throw new Error("DOCX/TXT/MD 转为可写 Markdown 必须显式确认 convertToManagedMarkdown=true。");
  }
  if (typeof input?.duplicateResolution !== "string"
    || !(NOVEL_IMPORT_DUPLICATE_RESOLUTIONS as readonly string[]).includes(input.duplicateResolution)) {
    throw new Error("小说导入必须显式选择 include_all 或 skip_later_exact_duplicates 重复处理策略。");
  }
  if (!SHA256_PATTERN.test(requestHash)
    || typeof input?.preflightId !== "string" || !/^novel-preflight-[a-f0-9]{24}$/u.test(input.preflightId)
    || typeof input.preflightFingerprint !== "string" || !SHA256_PATTERN.test(input.preflightFingerprint)
    || typeof input.sourceTreeAggregateSha256 !== "string" || !SHA256_PATTERN.test(input.sourceTreeAggregateSha256)) {
    throw new Error("小说导入完成态证明缺少合法 requestHash 或稳定预检身份。");
  }
  const projectsRoot = await resolveNovelImportProjectsRoot(input.projectsRoot);
  const projectName = normalizeProjectName(input.projectName);
  return findCompletedImportReplay(
    projectsRoot,
    projectName,
    input.duplicateResolution,
    requestHash,
    {
      preflightId: input.preflightId,
      preflightFingerprint: input.preflightFingerprint,
      sourceTreeAggregateSha256: input.sourceTreeAggregateSha256,
    },
    "prove-complete",
  );
}

export async function commitNovelExternalImport(
  input: CommitNovelExternalImportInput,
): Promise<CommitNovelExternalImportResult> {
  if (input?.convertToManagedMarkdown !== true) {
    throw new Error("DOCX/TXT/MD 转为可写 Markdown 必须显式确认 convertToManagedMarkdown=true。");
  }
  if (typeof input?.duplicateResolution !== "string"
    || !(NOVEL_IMPORT_DUPLICATE_RESOLUTIONS as readonly string[]).includes(input.duplicateResolution)) {
    throw new Error("小说导入必须显式选择 include_all 或 skip_later_exact_duplicates 重复处理策略。");
  }
  if (typeof input?.preflightId !== "string" || !/^novel-preflight-[a-f0-9]{24}$/u.test(input.preflightId)
    || typeof input.preflightFingerprint !== "string" || !SHA256_PATTERN.test(input.preflightFingerprint)
    || typeof input.sourceTreeAggregateSha256 !== "string" || !SHA256_PATTERN.test(input.sourceTreeAggregateSha256)) {
    throw new Error("小说导入必须绑定合法的预检 ID、fingerprint 与来源树 aggregate。");
  }
  const operation = requireImportOperationContext();
  const projectsRoot = await resolveNovelImportProjectsRoot(input.projectsRoot);
  const expectedDestination = operation.novelImportDestinationIdentity;
  if (expectedDestination && (expectedDestination.projectsRoot !== projectsRoot
    || expectedDestination.canonicalRoot !== projectsRoot)) {
    throw new Error("小说导入操作上下文的目标身份与 projectsRoot 不一致。");
  }
  const projectName = normalizeProjectName(input.projectName);
  // Fresh desktop replay 用 expected-root dirfd 从原生选中 inode 逐段打开
  // transaction，绝不 mkdir；后续读写沿该 transaction identity 行进。
  // 这既保留合法 save/rename/move 后的历史 replay，也阻止路径 ABA
  // 让未选中 clone 成为首个业务锚点。
  const completedReplay = await findCompletedImportReplay(
    projectsRoot,
    projectName,
    input.duplicateResolution,
    operation.requestHash,
    {
      preflightId: input.preflightId,
      preflightFingerprint: input.preflightFingerprint,
      sourceTreeAggregateSha256: input.sourceTreeAggregateSha256,
    },
    expectedDestination ? "prove-complete" : "repair-terminal",
    expectedDestination,
  );
  if (completedReplay) {
    if (expectedDestination) await assertConfinedRootIdentity(expectedDestination);
    return completedReplay;
  }
  if (typeof input.preflightAuthorization !== "string") {
    throw new Error("未找到可验证的已完成导入，未完成提交必须提供 opaque preflight authorization。");
  }
  return withNovelImportPreflightAuthorization(input.preflightAuthorization, async (authorizedPreflight) => {
    if (authorizedPreflight.preflightId !== input.preflightId
      || authorizedPreflight.fingerprint !== input.preflightFingerprint
      || authorizedPreflight.sourceTreeAggregateSha256 !== input.sourceTreeAggregateSha256) {
      throw new Error("小说导入提交的稳定预检身份与 opaque authorization 不一致。");
    }
    // 路径重叠必须在重新扫描来源、创建 transaction、项目或完成回放
    // 可能发生任何写入之前失败关闭。
    assertNovelImportDestinationDoesNotOverlapPreflight(projectsRoot, authorizedPreflight);
    // 任何项目或 transaction 写入前重做完整只读预检。客户端只能提交
    // opaque authorization，完整 DTO 从进程内绑定取回，不信任 IPC payload。
    const currentPreflight = await preflightNovelImport(authorizedPreflight.sourcePath, { limits: authorizedPreflight.limits });
    if (currentPreflight.fingerprint !== authorizedPreflight.fingerprint
      || currentPreflight.sourceTreeAggregateSha256 !== authorizedPreflight.sourceTreeAggregateSha256
      || currentPreflight.preflightId !== authorizedPreflight.preflightId
      || currentPreflight.sourcePath !== authorizedPreflight.sourcePath
      || currentPreflight.sourceRoot !== authorizedPreflight.sourceRoot
      || currentPreflight.chapterSplitAlgorithm !== NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM) {
      throw new Error("小说来源自预检后已变化，未创建或注册项目。");
    }
    const selectedFiles = input.duplicateResolution === "skip_later_exact_duplicates"
      ? currentPreflight.files.filter((file) => file.duplicateOf === undefined)
      : currentPreflight.files;
    const skippedDuplicateSourcePaths = currentPreflight.files
      .filter((file) => input.duplicateResolution === "skip_later_exact_duplicates" && file.duplicateOf !== undefined)
      .map((file) => file.relativePath);
    const selectedChapterCount = selectedFiles.reduce((total, file) => total + file.chapterCount, 0);

  const receiptId = deriveNovelImportReceiptId({
    projectsRoot,
    projectName,
    preflightFingerprint: currentPreflight.fingerprint,
    duplicateResolution: input.duplicateResolution,
  });
  const projectSlug = managedProjectSlug(`novel-${projectName}-${receiptId.slice(-8)}`);
  const transactionDirectory = await ensureConfinedDirectory(
    projectsRoot,
    path.join(projectsRoot, TRANSACTION_NAMESPACE, receiptId),
    0o700,
    expectedDestination,
  );
  maybeInterruptNovelImportForTests("transaction_directory_prepared");
  const priorIntentBytes = await readOptional(transactionDirectory, "intent.json");
  let intent: NovelImportTransactionIntent;
  if (priorIntentBytes) {
    intent = validateTransactionIntent(parseJson(priorIntentBytes, "novel import transaction intent"));
    if (intent.receiptId !== receiptId
      || intent.requestHash !== operation.requestHash
      || intent.projectName !== projectName
      || intent.projectSlug !== projectSlug
      || intent.preflightId !== currentPreflight.preflightId
      || intent.preflightFingerprint !== currentPreflight.fingerprint
      || intent.sourceTreeAggregateSha256 !== currentPreflight.sourceTreeAggregateSha256
      || intent.chapterSplitAlgorithm !== NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM
      || intent.duplicateResolution !== input.duplicateResolution
      || intent.convertToManagedMarkdown !== true
      || intent.sourceProjectsDisjoint !== true) {
      throw new Error("既有小说导入 transaction 与本次请求不一致。");
    }
  } else {
    const semantic = {
      schemaVersion: 1 as const,
      kind: "novel-import-transaction-intent" as const,
      receiptId,
      requestHash: operation.requestHash,
      projectName,
      projectSlug,
      preflightId: currentPreflight.preflightId,
      preflightFingerprint: currentPreflight.fingerprint,
      sourceTreeAggregateSha256: currentPreflight.sourceTreeAggregateSha256,
      chapterSplitAlgorithm: NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM,
      duplicateResolution: input.duplicateResolution,
      convertToManagedMarkdown: true as const,
      sourceProjectsDisjoint: true as const,
      createdAt: new Date().toISOString(),
    };
    intent = { ...semantic, fingerprint: fingerprint(semantic) };
    await persistConfinedBytesNoReplace(transactionDirectory, "intent.json", jsonBytes(intent));
  }
  const transactionStates = await ensureConfinedDirectory(
    projectsRoot,
    path.join(transactionDirectory.directory, "states"),
    0o700,
    expectedDestination,
  );
  let stateFingerprint = await persistImportState(transactionStates, null, intent, "preflighted", undefined, {
    preflightId: currentPreflight.preflightId,
    preflightFingerprint: currentPreflight.fingerprint,
    preflightChapterCount: currentPreflight.summary.chapterCount,
    aggregate: currentPreflight.sourceTreeAggregateSha256,
    chapterSplitAlgorithm: NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM,
    duplicateResolution: input.duplicateResolution,
  });
  maybeInterruptNovelImportForTests("preflighted");

  const shell = await createOrResumeImportProject(projectsRoot, intent, transactionDirectory);
  const projectRoot = shell.paths.root;
  const allocationBytes = await readOptional(transactionDirectory, "allocation.json");
  if (!allocationBytes) throw new Error("小说导入项目已创建但 allocation 缺失。");
  const allocation = validateProjectAllocation(
    parseJson(allocationBytes, "novel import allocation"),
    projectsRoot,
    intent,
  );
  if (allocation.projectId !== shell.project.id || allocation.projectRoot !== shell.paths.root) {
    throw new Error("小说导入项目壳与 allocation 不一致。");
  }
  const receiptRoot = await ensureConfinedDirectory(
    shell.paths.root,
    resolveNovelProjectLocator(shell.paths.root, `.aicanvas/novel/import-receipts/${receiptId}`).absolutePath,
  );
  const projectStates = await ensureConfinedDirectory(shell.paths.root, path.join(receiptRoot.directory, "states"));
  // 项目创建后把第一状态同字节镜像进项目。
  await persistImportState(transactionStates, projectStates, intent, "preflighted", undefined, {
    preflightId: currentPreflight.preflightId,
    preflightFingerprint: currentPreflight.fingerprint,
    preflightChapterCount: currentPreflight.summary.chapterCount,
    aggregate: currentPreflight.sourceTreeAggregateSha256,
    chapterSplitAlgorithm: NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM,
    duplicateResolution: input.duplicateResolution,
  });
  stateFingerprint = await persistImportState(transactionStates, projectStates, intent, "staging_created", stateFingerprint, {
    projectId: shell.project.id,
    projectDirectoryName: allocation.projectDirectoryName,
    workspaceMode: shell.workspaceMode,
  });
  maybeInterruptNovelImportForTests("staging_created");

  const sourceObjectRoot = await ensureConfinedDirectory(
    shell.paths.root,
    resolveNovelProjectLocator(shell.paths.root, ".aicanvas/novel/source-objects/sha256").absolutePath,
  );
  const sourceObjects: NovelImportReceipt["sourceObjects"] = [];
  const drafts: CanonicalChapterDraft[] = [];
  for (const file of selectedFiles) {
    const stableSource = await readNovelPreflightSourceForCommit(currentPreflight, file);
    if (stableSource.sha256 !== file.sha256 || stableSource.sourceBytes.byteLength !== file.byteLength) {
      throw new Error(`导入前来源字节对账失败：${file.relativePath}`);
    }
    const prefix = await ensureConfinedDirectory(shell.paths.root, path.join(sourceObjectRoot.directory, file.sha256.slice(0, 2)));
    const object = await persistConfinedBytesNoReplace(prefix, file.sha256, stableSource.sourceBytes);
    if (object.sha256 !== file.sha256 || object.size !== file.byteLength) throw new Error("原始字节 CAS 回执不一致。");
    const objectRelativePath = `.aicanvas/novel/source-objects/sha256/${file.sha256.slice(0, 2)}/${file.sha256}`;
    sourceObjects.push({
      sourceRelativePath: file.relativePath,
      objectRelativePath,
      sha256: file.sha256,
      byteLength: file.byteLength,
    });
    await runNovelImportCopyHookForTests({
      state: "source_object_copied",
      sourceRelativePath: file.relativePath,
      copiedSourceObjects: sourceObjects.length,
    });
    let text: string;
    if (file.kind === "docx") {
      const parsed = await parseNovelDocxIsolated(path.join(prefix.directory, file.sha256), {
        maximumFileBytes: currentPreflight.limits.maximumSingleFileBytes,
        maximumMembers: currentPreflight.limits.maximumDocxMembers,
        maximumMemberExpandedBytes: currentPreflight.limits.maximumDocxMemberExpandedBytes,
        maximumExpandedBytes: currentPreflight.limits.maximumDocxExpandedBytes,
        maximumCompressionRatio: currentPreflight.limits.maximumDocxCompressionRatio,
        maximumOutputChars: currentPreflight.limits.maximumDocxOutputChars,
        timeoutMs: currentPreflight.limits.docxTimeoutMs,
      });
      if (parsed.sourceSha256 !== file.sha256 || !file.docx
        || parsed.outputSha256 !== file.decodedTextSha256
        || parsed.outputSha256 !== file.docx.outputSha256
        || parsed.memberCount !== file.docx.memberCount
        || parsed.expandedBytes !== file.docx.expandedBytes
        || JSON.stringify(stableValue(parsed.converter)) !== JSON.stringify(stableValue(file.docx.converter))) {
        throw new Error("DOCX CAS 原始 SHA、输出 SHA 或冻结转换器合同不一致。");
      }
      text = parsed.text;
    } else {
      const frozen = await readSingleLinkConfinedFile(
        prefix,
        file.sha256,
        file.byteLength,
        `小说导入 source object ${file.relativePath}`,
      );
      text = new TextDecoder(file.encoding, { fatal: true }).decode(frozen.bytes);
    }
    if (text.length !== file.charCount || sha256(Buffer.from(text, "utf8")) !== file.decodedTextSha256) {
      throw new Error(`CAS 解码字符数或正文 SHA 与预检不一致：${file.relativePath}`);
    }
    drafts.push(...splitCanonicalChapters(file, text));
  }
  const sourceObjectAggregate = fingerprint(sourceObjects.map((entry) => ({
    relativePath: entry.sourceRelativePath,
    sha256: entry.sha256,
    byteLength: entry.byteLength,
  })));
  stateFingerprint = await persistImportState(transactionStates, projectStates, intent, "source_objects_copied", stateFingerprint, {
    count: sourceObjects.length,
    aggregate: sourceObjectAggregate,
  });
  maybeInterruptNovelImportForTests("source_objects_copied");

  const volumeId = deterministicUuid(`${receiptId}\0volume\0default`);
  const stagingManuscriptPath = resolveNovelProjectLocator(
    shell.paths.root,
    `.aicanvas/novel/staging/${receiptId}/publish/manuscript`,
  ).absolutePath;
  const finalManuscriptPath = path.join(shell.paths.root, "manuscript");
  const finalExists = await lstat(finalManuscriptPath).then(() => true, (error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
  const chapters: NovelChapterRecord[] = [];
  const receiptChapters: NovelImportReceiptChapter[] = [];
  const expectedTree = new Set<string>(["chapters.json", "volumes", `volumes/${volumeId}`]);
  for (let order = 0; order < drafts.length; order += 1) {
    const draft = drafts[order]!;
    const bytes = Buffer.from(draft.content, "utf8");
    const chapterSha = sha256(bytes);
    const chapterId = deterministicUuid(`${receiptId}\0${draft.sourceFile.relativePath}\0${draft.sourceChapterIndex}\0${chapterSha}`);
    const relativePath = `manuscript/volumes/${volumeId}/${chapterId}.md`;
    const record: NovelChapterRecord = {
      chapterId,
      volumeId,
      title: draft.title,
      order,
      relativePath,
      sha256: chapterSha,
      byteLength: bytes.byteLength,
      charCount: draft.content.length,
      offsetEncoding: NOVEL_OFFSET_ENCODING,
      revision: 1,
      sourceReceiptId: receiptId,
      createdAt: intent.createdAt,
      updatedAt: intent.createdAt,
    };
    chapters.push(record);
    receiptChapters.push({
      sourceRelativePath: draft.sourceFile.relativePath,
      sourceSha256: draft.sourceFile.sha256,
      sourceChapterIndex: draft.sourceChapterIndex,
      chapterId,
      volumeId,
      relativePath,
      sha256: chapterSha,
      byteLength: bytes.byteLength,
      charCount: draft.content.length,
    });
    expectedTree.add(`volumes/${volumeId}/${chapterId}.md`);
    if (!finalExists) {
      const directory = await ensureConfinedDirectory(shell.paths.root, path.join(stagingManuscriptPath, "volumes", volumeId));
      await persistConfinedBytesNoReplace(directory, `${chapterId}.md`, bytes);
    }
  }
  const chapterManifest: NovelChapterManifest = {
    schemaVersion: 1,
    kind: "novel-chapter-manifest",
    projectId: shell.project.id,
    revision: 1,
    volumes: [{ volumeId, title: "第一卷", order: 0, revision: 1 }],
    chapters,
    updatedAt: intent.createdAt,
  };
  const chapterManifestBytes = jsonBytes(chapterManifest);
  const chapterManifestSha256 = sha256(chapterManifestBytes);
  if (!finalExists) {
    const staging = await ensureConfinedDirectory(shell.paths.root, stagingManuscriptPath);
    await persistConfinedBytesNoReplace(staging, "chapters.json", chapterManifestBytes);
    await verifyExactTree(stagingManuscriptPath, expectedTree);
  }
  stateFingerprint = await persistImportState(transactionStates, projectStates, intent, "markdown_materialized", stateFingerprint, {
    chapters: chapters.length,
    chapterManifestSha256,
  });
  maybeInterruptNovelImportForTests("markdown_materialized");
  if (chapters.length !== selectedChapterCount
    || receiptChapters.length !== selectedChapterCount
    || new Set(chapters.map((chapter) => chapter.chapterId)).size !== chapters.length) {
    throw new Error("导入章节数或 stable ID 对账失败。");
  }
  stateFingerprint = await persistImportState(transactionStates, projectStates, intent, "chapters_reconciled", stateFingerprint, {
    preflightChapterCount: currentPreflight.summary.chapterCount,
    selectedChapterCount,
    skippedDuplicateSourcePaths,
    duplicateResolution: input.duplicateResolution,
    chapterSplitAlgorithm: NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM,
    outputChapterCount: chapters.length,
    stableIdsFingerprint: fingerprint(chapters.map((chapter) => chapter.chapterId)),
  });
  maybeInterruptNovelImportForTests("chapters_reconciled");
  // 逐文件复验无法锁住同目录的 unsupported/sibling。在原子发布
  // 前再做一次完整树闭包对账；任何变化都保留未注册 staging。
  const finalPreflight = await preflightNovelImport(currentPreflight.sourcePath, { limits: currentPreflight.limits });
  if (finalPreflight.fingerprint !== currentPreflight.fingerprint
    || finalPreflight.sourceTreeAggregateSha256 !== currentPreflight.sourceTreeAggregateSha256
    || finalPreflight.chapterSplitAlgorithm !== NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM) {
    throw new Error("导入来源树在 CAS 复制期间发生变化，拒绝发布和注册。");
  }
  stateFingerprint = await persistImportState(transactionStates, projectStates, intent, "hashes_verified", stateFingerprint, {
    chapterManifestSha256,
    sourceObjectAggregate,
    manuscriptAggregate: fingerprint(chapters.map((chapter) => ({ path: chapter.relativePath, sha256: chapter.sha256 }))),
  });
  maybeInterruptNovelImportForTests("hashes_verified");

  if (!finalExists) {
    const staging = await inspectExistingConfinedDirectory(shell.paths.root, stagingManuscriptPath);
    const projectDirectory = await inspectExistingConfinedDirectory(shell.paths.root, shell.paths.root);
    await moveConfinedDirectoryNoReplace(staging, projectDirectory, "manuscript");
  }
  await verifyExactTree(finalManuscriptPath, expectedTree);
  const finalManifestDirectory = await inspectExistingConfinedDirectory(shell.paths.root, finalManuscriptPath);
  const finalManifest = await readSingleLinkConfinedFile(
    finalManifestDirectory,
    "chapters.json",
    chapterManifestBytes.byteLength,
    "原子发布后的 chapter manifest",
  );
  if (!finalManifest.bytes.equals(chapterManifestBytes)) throw new Error("原子发布后 chapter manifest 与计划不一致。");
  stateFingerprint = await persistImportState(transactionStates, projectStates, intent, "atomically_published", stateFingerprint, {
    chapterManifestSha256,
    manuscriptDirectory: "manuscript",
  });
  maybeInterruptNovelImportForTests("atomically_published");

  const repository = new NovelRepository(shell.paths.root);
  await repository.adoptImportedManuscript({ receiptId, expectedChapterManifestSha256: chapterManifestSha256 });
  const plannedRegisteredState = buildImportStateReceipt(
    intent,
    "registered",
    stateFingerprint,
    registeredStateFacts(allocation, chapterManifestSha256),
  );
  const receiptSemantic = {
    schemaVersion: 1 as const,
    kind: "novel-import-receipt" as const,
    receiptId,
    projectId: shell.project.id,
    preflightId: currentPreflight.preflightId,
    preflightFingerprint: currentPreflight.fingerprint,
    preflightChapterCount: currentPreflight.summary.chapterCount,
    chapterSplitAlgorithm: NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM,
    duplicateResolution: input.duplicateResolution,
    skippedDuplicateSourcePaths,
    sourceMode: "external_snapshot" as const,
    resultMode: "managed_markdown" as const,
    sourceDisplayName: sourceDisplayName(currentPreflight.sourcePath),
    sourceTreeAggregateSha256: currentPreflight.sourceTreeAggregateSha256,
    converter: {
      name: "aicanvas-novel-import" as const,
      version: 1 as const,
      chapterSplitAlgorithm: NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM,
      ...(selectedFiles.some((file) => file.kind === "docx")
        ? { docx: { library: "mammoth" as const, isolated: true as const } }
        : {}),
    },
    sourceObjects,
    chapters: receiptChapters,
    chapterManifestSha256,
    stateChainFingerprint: plannedRegisteredState.fingerprint,
    committedAt: intent.createdAt,
  };
  const receipt = { ...receiptSemantic, fingerprint: fingerprint(receiptSemantic) };
  await persistConfinedBytesNoReplace(receiptRoot, "receipt.json", jsonBytes(receipt));
  const persistedReceipt = await readExistingReceipt(shell.paths.root, receiptId);
  if (!persistedReceipt || persistedReceipt.fingerprint !== receipt.fingerprint) {
    throw new Error("小说导入 registration 前 receipt candidate 往返验证失败。");
  }
  maybeInterruptNovelImportForTests("receipt_candidate_persisted");
  const validatedPreRegistration = await validateImportClosure(
    projectsRoot,
    transactionDirectory,
    intent,
    allocation,
    persistedReceipt,
    false,
    true,
  );
  if (validatedPreRegistration.preRegistrationStateFingerprint !== stateFingerprint) {
    throw new Error("小说导入 registration 前 state chain 往返验证失败。");
  }

  // receipt candidate、source objects、manuscript 与 workspace 全部闭合后，
  // 注册才是最后一个对用户可见的副作用。注册后只补不可变 terminal marker。
  await ensureImportProjectRegistered(shell);
  maybeInterruptNovelImportForTests("registered");
  const terminalFingerprint = await persistImportState(
    transactionStates,
    projectStates,
    intent,
    "registered",
    stateFingerprint,
    registeredStateFacts(allocation, chapterManifestSha256),
  );
  if (terminalFingerprint !== persistedReceipt.stateChainFingerprint) {
    throw new Error("小说导入 registered terminal fingerprint 与 receipt candidate 不一致。");
  }
  await validateImportClosure(
    projectsRoot,
    transactionDirectory,
    intent,
    allocation,
    persistedReceipt,
    true,
    true,
  );
  return { projectRoot: shell.paths.root, receipt: persistedReceipt, replayed: false };
  }, operation.requestHash);
}
