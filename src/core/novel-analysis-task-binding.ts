import path from "node:path";
import {
  ensureConfinedDirectory,
  inspectExistingConfinedDirectory,
  persistConfinedBytesNoReplace,
  persistConfinedBytesNoReplaceBatch,
  readConfinedRegularFileWithIdentity,
  type ConfinedDirectoryIdentity,
  type ConfinedPersistedFile,
} from "./confined-project-storage.js";
import { getSidecarPaths } from "./sidecar.js";
import type { NovelAnalysisChapterRef, NovelAnalysisTask, StoryChapter } from "./types.js";

const ANALYSIS_TASK_ID = /^analysis-[A-Za-z0-9-]{8,100}$/u;
const TASK_CONTRACT_MAX_BYTES = 5_000_000;

export class NovelAnalysisTaskBindingError extends Error {
  readonly kind: "task" | "source";

  constructor(kind: "task" | "source", message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NovelAnalysisTaskBindingError";
    this.kind = kind;
  }
}

export interface NovelAnalysisTaskPaths {
  directoryPath: string;
  taskJsonPath: string;
  taskMarkdownPath: string;
  proposalPath: string;
}

export interface FrozenNovelAnalysisTaskBinding extends NovelAnalysisTaskPaths {
  directory: ConfinedDirectoryIdentity;
}

function taskBindingIdentity(task: NovelAnalysisTask): unknown[] {
  return [
    task.id,
    task.providerId,
    task.providerKind,
    task.providerRevisionSnapshot ?? null,
    task.maxInputCharactersSnapshot ?? null,
    task.sourceLibraryRevision,
    path.resolve(task.taskJsonPath),
    path.resolve(task.taskMarkdownPath),
    task.runId ?? null,
    task.batchIndex ?? null,
    task.batchCount ?? null,
    task.revision,
    task.attempt ?? 1,
    task.supersedesTaskId ?? null,
    task.replacedByTaskId ?? null,
    task.replacementReason ?? null,
    task.plannedCharacterCount ?? null,
    task.beatOrderBase ?? null,
    task.chapterRefs.map(chapterRefIdentity),
  ];
}

export function assertNovelAnalysisTaskBindingUnchanged(
  expected: NovelAnalysisTask,
  current: NovelAnalysisTask,
): void {
  if (JSON.stringify(taskBindingIdentity(expected)) !== JSON.stringify(taskBindingIdentity(current))) {
    throw new NovelAnalysisTaskBindingError("task", "小说分析任务绑定在执行预检后发生变化。");
  }
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function chapterRefIdentity(value: NovelAnalysisChapterRef): unknown[] {
  return [
    value.chapterId,
    value.sourceId,
    value.revision,
    value.sha256,
    path.resolve(value.path),
    value.startOffset ?? null,
    value.endOffset ?? null,
    value.characterCount ?? null,
    value.segmentIndex ?? null,
    value.segmentCount ?? null,
  ];
}

export function novelAnalysisTaskPaths(projectRoot: string, taskId: string): NovelAnalysisTaskPaths {
  if (!ANALYSIS_TASK_ID.test(taskId) || path.basename(taskId) !== taskId) {
    throw new NovelAnalysisTaskBindingError("task", "小说分析任务身份无效。");
  }
  const directoryPath = path.join(getSidecarPaths(projectRoot).storyAnalysisTasks, taskId);
  return {
    directoryPath,
    taskJsonPath: path.join(directoryPath, "task.json"),
    taskMarkdownPath: path.join(directoryPath, "任务说明.md"),
    proposalPath: path.join(directoryPath, "proposal.json"),
  };
}

function assertPersistedTaskContract(value: unknown, task: NovelAnalysisTask): void {
  if (!record(value)
    || value.schemaVersion !== 1
    || value.taskId !== task.id
    || !record(value.provider)
    || value.provider.id !== task.providerId
    || value.provider.kind !== task.providerKind
    || value.sourceLibraryRevision !== task.sourceLibraryRevision
    || !Array.isArray(value.chapters)
    || value.chapters.length !== task.chapterRefs.length) {
    throw new NovelAnalysisTaskBindingError("task", "小说分析 task.json 与当前任务不一致。");
  }
  const parsedRefs = value.chapters as NovelAnalysisChapterRef[];
  if (JSON.stringify(parsedRefs.map(chapterRefIdentity)) !== JSON.stringify(task.chapterRefs.map(chapterRefIdentity))) {
    throw new NovelAnalysisTaskBindingError("task", "小说分析 task.json 的章节绑定已变化。");
  }
}

export async function freezeNovelAnalysisTaskBinding(
  projectRoot: string,
  task: NovelAnalysisTask,
): Promise<FrozenNovelAnalysisTaskBinding> {
  const paths = novelAnalysisTaskPaths(projectRoot, task.id);
  if (!samePath(task.taskJsonPath, paths.taskJsonPath)
    || !samePath(task.taskMarkdownPath, paths.taskMarkdownPath)) {
    throw new NovelAnalysisTaskBindingError("task", "小说分析任务输出路径与任务身份不一致。");
  }
  try {
    const directory = await inspectExistingConfinedDirectory(projectRoot, paths.directoryPath);
    const taskFile = await readConfinedRegularFileWithIdentity(directory, "task.json", TASK_CONTRACT_MAX_BYTES);
    if (taskFile.nlink !== 1) throw new Error("task.json 必须是单链接普通文件。");
    assertPersistedTaskContract(JSON.parse(taskFile.bytes.toString("utf8")) as unknown, task);
    return { ...paths, directory };
  } catch (error) {
    if (error instanceof NovelAnalysisTaskBindingError) throw error;
    throw new NovelAnalysisTaskBindingError("task", "小说分析任务目录或 task.json 当前不可信。", { cause: error });
  }
}

/**
 * 新任务输出只允许经工程根锚定的 dirfd 目录与 no-replace 文件发布。
 * 任意父级软链、预置同名文件或目录身份漂移均失败关闭。
 */
export async function createNovelAnalysisTaskBindingFiles(
  projectRoot: string,
  task: NovelAnalysisTask,
  contract: unknown,
  markdown: string,
): Promise<FrozenNovelAnalysisTaskBinding> {
  const paths = novelAnalysisTaskPaths(projectRoot, task.id);
  if (!samePath(task.taskJsonPath, paths.taskJsonPath)
    || !samePath(task.taskMarkdownPath, paths.taskMarkdownPath)) {
    throw new NovelAnalysisTaskBindingError("task", "小说分析任务输出路径与任务身份不一致。");
  }
  try {
    const directory = await ensureConfinedDirectory(projectRoot, paths.directoryPath);
    const files = await persistConfinedBytesNoReplaceBatch(directory, [
      { name: "任务说明.md", bytes: Buffer.from(markdown, "utf8") },
      { name: "task.json", bytes: Buffer.from(`${JSON.stringify(contract, null, 2)}\n`, "utf8") },
    ], { commitName: "task.json", mode: 0o600 });
    if (files.some((file) => !file.created)) {
      throw new Error("小说分析任务文件已存在，拒绝采用预置输出。");
    }
    return freezeNovelAnalysisTaskBinding(projectRoot, task);
  } catch (error) {
    if (error instanceof NovelAnalysisTaskBindingError) throw error;
    throw new NovelAnalysisTaskBindingError("task", "小说分析任务输出目录无法安全创建。", { cause: error });
  }
}

export function assertNovelAnalysisChapterBinding(
  taskChapter: NovelAnalysisChapterRef,
  currentChapter: StoryChapter | undefined,
): asserts currentChapter is StoryChapter {
  if (!currentChapter
    || taskChapter.chapterId !== currentChapter.id
    || taskChapter.sourceId !== currentChapter.sourceId
    || taskChapter.revision !== currentChapter.revision
    || taskChapter.sha256 !== currentChapter.sha256
    || !samePath(taskChapter.path, currentChapter.path)) {
    throw new NovelAnalysisTaskBindingError("source", "小说分析任务与当前章节权威不一致。");
  }
}

export async function persistNovelAnalysisProposal(
  binding: FrozenNovelAnalysisTaskBinding,
  proposal: unknown,
): Promise<ConfinedPersistedFile> {
  const bytes = Buffer.from(`${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  return persistConfinedBytesNoReplace(binding.directory, "proposal.json", bytes, 0o600);
}
