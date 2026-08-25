import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { withAdaptation, type AdaptationModule } from "./adaptation-lazy.js";
import { withProjectLock } from "./locks.js";
import { assertNovelAnalysisChapterBinding, createNovelAnalysisTaskBindingFiles, freezeNovelAnalysisTaskBinding, novelAnalysisTaskPaths } from "./novel-analysis-task-binding.js";
import { appendEvent } from "./sidecar.js";
import { withStory, type StoryModule } from "./story-lazy.js";
import type {
  AdaptationStore,
  NarrativeBeat,
  NovelAnalysisChapterRef,
  NovelAnalysisProviderKind,
  NovelAnalysisReviewItem,
  NovelAnalysisTask,
  NovelFact,
  SourceSpan,
  StoryLibrary,
  StoryChapter,
} from "./types.js";

const loadAdaptationStore = (...args: Parameters<AdaptationModule["loadAdaptationStore"]>) =>
  withAdaptation((adaptation) => adaptation.loadAdaptationStore(...args));
const saveAdaptationStore = (...args: Parameters<AdaptationModule["saveAdaptationStore"]>) =>
  withAdaptation((adaptation) => adaptation.saveAdaptationStore(...args));
const loadStoryLibrarySnapshot = (...args: Parameters<StoryModule["loadStoryLibrarySnapshot"]>) =>
  withStory((story) => story.loadStoryLibrarySnapshot(...args));
const loadStoryAnalysisChapterSnapshot = (...args: Parameters<StoryModule["loadStoryAnalysisChapterSnapshot"]>) =>
  withStory((story) => story.loadStoryAnalysisChapterSnapshot(...args));

export type FactProposal = Omit<NovelFact, "schemaVersion" | "id" | "revision" | "createdAt" | "updatedAt"> & { id?: string };
export type BeatProposal = Omit<NarrativeBeat, "schemaVersion" | "id" | "revision" | "createdAt" | "updatedAt"> & { id?: string };

export interface NovelAnalysisProposalInput {
  taskId: string;
  expectedRevision: number;
  executionId?: string;
  expectedExecutionFence?: number;
  facts: FactProposal[];
  beats: BeatProposal[];
  executionReceipt?: { responseId?: string; responseModel?: string; proposalPath?: string; inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

const sourceSpanSchema = z.object({
  sourceId: z.string().min(1).max(500),
  chapterId: z.string().min(1).max(500),
  chapterRevision: z.number().int().positive(),
  chapterSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().positive(),
  text: z.string().min(1).max(20_000),
}).refine((value) => value.endOffset > value.startOffset, "endOffset 必须大于 startOffset");
const factProposalSchema = z.object({
  id: z.string().min(1).max(500).optional(),
  kind: z.enum(["event", "character", "location", "prop", "rule", "dialogue", "relationship", "time", "weather", "costume", "narration", "psychology", "environment"]),
  epistemicStatus: z.enum(["confirmed", "inferred", "uncertain"]),
  statement: z.string().min(1).max(20_000),
  subject: z.string().max(1_000).optional(),
  predicate: z.string().max(1_000).optional(),
  object: z.string().max(4_000).optional(),
  sourceSpans: z.array(sourceSpanSchema).min(1).max(100),
  tags: z.array(z.string().max(200)).max(100),
});
const beatProposalSchema = z.object({
  id: z.string().min(1).max(500).optional(),
  order: z.number().int().positive(),
  title: z.string().min(1).max(180),
  summary: z.string().min(1).max(20_000),
  narrativePurpose: z.string().min(1).max(2_000),
  visualAction: z.string().min(1).max(8_000),
  emotionalShift: z.string().min(1).max(2_000),
  conflict: z.string().max(4_000).optional(),
  turn: z.string().max(4_000).optional(),
  outcome: z.string().max(4_000).optional(),
  narration: z.string().max(8_000).optional(),
  psychology: z.string().max(8_000).optional(),
  ambience: z.string().max(4_000).optional(),
  mustKeep: z.array(z.string().max(2_000)).max(100),
  estimatedDurationSeconds: z.number().min(0.5).max(120),
  factIds: z.array(z.string().min(1).max(500)).max(200),
  sourceSpans: z.array(sourceSpanSchema).min(1).max(100),
  dialogue: z.string().max(8_000).optional(),
  intensity: z.number().int().min(1).max(5),
});
const proposalSchema = z.object({ facts: z.array(factProposalSchema).max(500), beats: z.array(beatProposalSchema).max(300) })
  .refine((value) => value.facts.length > 0 || value.beats.length > 0, "模型提案不能为空");

export function parseNovelAnalysisProposal(value: unknown): { facts: FactProposal[]; beats: BeatProposal[] } {
  const parsed = proposalSchema.safeParse(value);
  if (!parsed.success) throw new Error(`模型返回结构不符合小说分析契约：${parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "root"} ${issue.message}`).join("；")}`);
  return parsed.data as { facts: FactProposal[]; beats: BeatProposal[] };
}

function now(): string { return new Date().toISOString(); }
function clean(values: string[] | undefined, limit = 500): string[] { return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, limit); }
function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

async function loadLibrary(projectRoot: string): Promise<StoryLibrary> {
  const library = await loadStoryLibrarySnapshot(projectRoot);
  if (!library.chapters.length) throw new Error("没有真实章节索引，请先导入小说。 ");
  return library;
}

function taskContract(task: NovelAnalysisTask) {
  return {
    schemaVersion: 1,
    taskId: task.id,
    provider: { id: task.providerId, kind: task.providerKind },
    sourceLibraryRevision: task.sourceLibraryRevision,
    run: task.runId ? { id: task.runId, batchIndex: task.batchIndex, batchCount: task.batchCount, attempt: task.attempt ?? 1, supersedesTaskId: task.supersedesTaskId, replacementReason: task.replacementReason, plannedCharacterCount: task.plannedCharacterCount, beatOrderBase: task.beatOrderBase } : undefined,
    chapters: task.chapterRefs,
    rules: [
      "逐章读取 chapter.path；存在 startOffset/endOffset 时只分析该绝对字符区间，不得根据聊天记录补写事实。",
      "confirmed 事实必须引用逐字匹配的 sourceSpans；推断必须标记 inferred 或 uncertain。",
      "先输出 facts，再输出 beats；beat.factIds 只能引用本次事实 ID 或现有事实 ID。",
      "sourceSpans 的字符区间始终是章节全文的绝对偏移，不是当前分段内的相对偏移。",
      "不得直接生成最终镜头，不得把模型判断伪装成原文。",
    ],
    output: {
      facts: "FactProposal[]",
      beats: "BeatProposal[]",
      requiredSourceSpanFields: ["sourceId", "chapterId", "chapterRevision", "chapterSha256", "startOffset", "endOffset", "text"],
      submitTool: "submit_novel_analysis_proposal",
    },
  };
}

function taskMarkdown(task: NovelAnalysisTask): string {
  const chapters = task.chapterRefs.map((chapter) => `- ${chapter.chapterId} @ R${chapter.revision}${chapter.startOffset !== undefined ? ` · 字符 ${chapter.startOffset}–${chapter.endOffset}` : ""} · ${chapter.path}`).join("\n");
  const batch = task.runId ? `- 长篇运行：${task.runId}\n- 批次：${task.batchIndex}/${task.batchCount}\n- 尝试：${task.attempt ?? 1}${task.supersedesTaskId ? `（替换 ${task.supersedesTaskId}）` : ""}\n- 计划字符：${task.plannedCharacterCount}\n` : "";
  return `# 小说模型分析任务\n\n- 任务：${task.id}\n- Provider：${task.providerId} (${task.providerKind})\n- 章节修订：${task.sourceLibraryRevision}\n${batch}\n## 章节\n\n${chapters}\n\n## 约束\n\n1. 只从上述真实章节路径和指定字符区间读取内容。\n2. confirmed 事实必须给出章节全文中的绝对字符区间；推断必须标记 inferred 或 uncertain。\n3. 先提交事实，再提交引用这些事实的剧情节拍。\n4. 所有结果先进入人工确认队列，不得直接覆盖事实、节拍或正式分镜。\n5. 使用 MCP 工具 submit_novel_analysis_proposal 提交结构化结果。\n`;
}

export async function createNovelAnalysisTask(projectRoot: string, input: { expectedRevision: number; providerId?: string; providerKind?: NovelAnalysisProviderKind; chapterIds?: string[] }): Promise<{ workspace: AdaptationStore; task: NovelAnalysisTask }> {
  return withProjectLock(projectRoot, "adaptation", async () => {
    const store = await loadAdaptationStore(projectRoot);
    if (store.revision !== input.expectedRevision) throw new Error(`改编工作区修订冲突，当前为 ${store.revision}。`);
    const library = await loadLibrary(projectRoot);
    const selectedIds = new Set(clean(input.chapterIds, 500));
    const chapters = selectedIds.size ? library.chapters.filter((chapter) => selectedIds.has(chapter.id)) : library.chapters;
    if (!chapters.length) throw new Error("没有可创建模型分析任务的章节。 ");
    if (selectedIds.size && selectedIds.size !== chapters.length) throw new Error("部分 chapterIds 不存在，拒绝创建不完整任务。 ");
    const timestamp = now();
    const id = `analysis-${randomUUID()}`;
    const taskPaths = novelAnalysisTaskPaths(projectRoot, id);
    const taskJsonPath = taskPaths.taskJsonPath;
    const taskMarkdownPath = taskPaths.taskMarkdownPath;
    const task: NovelAnalysisTask = {
      schemaVersion: 1,
      id,
      providerId: input.providerId?.trim().slice(0, 120) || "codex",
      providerKind: input.providerKind ?? "codex",
      status: "prepared",
      sourceLibraryRevision: library.revision,
      chapterRefs: chapters.map((chapter) => ({ chapterId: chapter.id, sourceId: chapter.sourceId, revision: chapter.revision, sha256: chapter.sha256, path: chapter.path })),
      taskJsonPath,
      taskMarkdownPath,
      reviewItemIds: [],
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await createNovelAnalysisTaskBindingFiles(projectRoot, task, taskContract(task), taskMarkdown(task));
    store.analysisTasks.unshift(task);
    store.revision += 1;
    store.updatedAt = timestamp;
    await saveAdaptationStore(projectRoot, store);
    await appendEvent(projectRoot, { actor: "codex", type: "adaptation.analysis-task-created", data: { taskId: id, providerId: task.providerId, chapterIds: chapters.map((chapter) => chapter.id), revision: store.revision } });
    return { workspace: store, task };
  });
}

export interface CreateNovelAnalysisRunInput {
  expectedRevision: number;
  providerId: string;
  providerRevision: number;
  maxInputCharacters: number;
  targetCharacters?: number;
  maxChaptersPerBatch?: number;
  sourceId?: string;
  chapterIds?: string[];
}

function normalizedChapterText(serialized: string): string {
  return serialized.endsWith("\n") ? serialized.slice(0, -1) : serialized;
}

function splitBoundary(text: string, start: number, maximumEnd: number): number {
  if (maximumEnd >= text.length) return text.length;
  const minimum = start + Math.max(1, Math.floor((maximumEnd - start) * 0.6));
  const candidates = ["\n\n", "\n", "。", "！", "？", "!", "?", "；", ";"];
  let best = -1;
  let bestLength = 0;
  for (const token of candidates) {
    const found = text.lastIndexOf(token, maximumEnd - 1);
    if (found >= minimum && (found > best || (found === best && token.length > bestLength))) {
      best = found;
      bestLength = token.length;
    }
  }
  return best >= minimum ? best + bestLength : maximumEnd;
}

function chapterSegments(chapter: StoryChapter, serialized: string, targetCharacters: number): NovelAnalysisChapterRef[] {
  const text = normalizedChapterText(serialized);
  if (createHash("sha256").update(text).digest("hex") !== chapter.sha256) throw new Error(`章节快照哈希不匹配，停止规划：${chapter.id}`);
  if (!text.length) throw new Error(`章节内容为空，停止规划：${chapter.id}`);
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < text.length) {
    const end = splitBoundary(text, start, Math.min(text.length, start + targetCharacters));
    if (end <= start) throw new Error(`章节无法安全分段：${chapter.id} @ ${start}`);
    ranges.push({ start, end });
    start = end;
  }
  return ranges.map((range, index) => ({
    chapterId: chapter.id,
    sourceId: chapter.sourceId,
    revision: chapter.revision,
    sha256: chapter.sha256,
    path: chapter.path,
    startOffset: range.start,
    endOffset: range.end,
    characterCount: range.end - range.start,
    segmentIndex: index + 1,
    segmentCount: ranges.length,
  }));
}

export async function createNovelAnalysisRun(projectRoot: string, input: CreateNovelAnalysisRunInput): Promise<{ workspace: AdaptationStore; runId: string; tasks: NovelAnalysisTask[] }> {
  return withProjectLock(projectRoot, "adaptation", async () => {
    const store = await loadAdaptationStore(projectRoot);
    if (store.revision !== input.expectedRevision) throw new Error(`改编工作区修订冲突，当前为 ${store.revision}。`);
    const library = await loadLibrary(projectRoot);
    const targetCharacters = Math.max(1_000, Math.min(Math.trunc(input.targetCharacters ?? Math.min(24_000, input.maxInputCharacters)), Math.trunc(input.maxInputCharacters)));
    const maxChaptersPerBatch = Math.max(1, Math.min(100, Math.trunc(input.maxChaptersPerBatch ?? 8)));
    if (!input.providerId.trim()) throw new Error("长篇分析运行必须绑定 Provider。 ");
    if (!Number.isInteger(input.providerRevision) || input.providerRevision < 1) throw new Error("Provider 修订无效。 ");
    if (!Number.isInteger(input.maxInputCharacters) || input.maxInputCharacters < 1_000) throw new Error("Provider 最大输入字符无效。 ");
    const selectedIds = new Set(clean(input.chapterIds, 5_000));
    let chapters = library.chapters.filter((chapter) => (!input.sourceId || chapter.sourceId === input.sourceId) && (!selectedIds.size || selectedIds.has(chapter.id)));
    if (!chapters.length) throw new Error("没有可规划的真实章节。 ");
    if (selectedIds.size && selectedIds.size !== chapters.length) throw new Error("部分 chapterIds 不存在或不属于指定 sourceId，拒绝创建不完整运行。 ");
    chapters = [...chapters].sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.index - right.index || left.id.localeCompare(right.id));

    const snapshot = await loadStoryAnalysisChapterSnapshot(projectRoot, chapters.map((chapter) => chapter.id));
    if (snapshot.library.revision !== library.revision) throw new Error("章节库在分析规划期间发生变化，请重试。");
    const snapshotById = new Map(snapshot.chapters.map((entry) => [entry.chapter.id, entry]));
    const refs: NovelAnalysisChapterRef[] = [];
    for (const selected of chapters) {
      const current = snapshotById.get(selected.id);
      assertNovelAnalysisChapterBinding({
        chapterId: selected.id,
        sourceId: selected.sourceId,
        revision: selected.revision,
        sha256: selected.sha256,
        path: selected.path,
      }, current?.chapter);
      refs.push(...chapterSegments(current.chapter, current.content, targetCharacters));
    }
    const batches: NovelAnalysisChapterRef[][] = [];
    let current: NovelAnalysisChapterRef[] = [];
    let currentCharacters = 0;
    let currentSource = "";
    for (const ref of refs) {
      const characters = ref.characterCount ?? 0;
      const sourceChanged = Boolean(current.length && currentSource !== ref.sourceId);
      if (current.length && (sourceChanged || current.length >= maxChaptersPerBatch || currentCharacters + characters > targetCharacters)) {
        batches.push(current);
        current = [];
        currentCharacters = 0;
      }
      current.push(ref);
      currentCharacters += characters;
      currentSource = ref.sourceId;
    }
    if (current.length) batches.push(current);
    if (!batches.length) throw new Error("长篇分析规划未产生任何批次。 ");

    const timestamp = now();
    const runId = `analysis-run-${randomUUID()}`;
    const tasks = batches.map((chapterRefs, batchOffset): NovelAnalysisTask => {
      const id = `analysis-${randomUUID()}`;
      const taskPaths = novelAnalysisTaskPaths(projectRoot, id);
      return {
        schemaVersion: 1,
        id,
        providerId: input.providerId.trim().slice(0, 120),
        providerKind: "external",
        status: "prepared",
        sourceLibraryRevision: library.revision,
        chapterRefs,
        runId,
        batchIndex: batchOffset + 1,
        batchCount: batches.length,
        plannedCharacterCount: chapterRefs.reduce((sum, ref) => sum + (ref.characterCount ?? 0), 0),
        beatOrderBase: batchOffset * 1_000,
        providerRevisionSnapshot: input.providerRevision,
        maxInputCharactersSnapshot: input.maxInputCharacters,
        attempt: 1,
        taskJsonPath: taskPaths.taskJsonPath,
        taskMarkdownPath: taskPaths.taskMarkdownPath,
        reviewItemIds: [],
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
    for (const task of tasks) {
      await createNovelAnalysisTaskBindingFiles(projectRoot, task, taskContract(task), taskMarkdown(task));
    }
    try {
      store.analysisTasks.unshift(...tasks);
      store.revision += 1;
      store.updatedAt = timestamp;
      await saveAdaptationStore(projectRoot, store);
      await appendEvent(projectRoot, { actor: "codex", type: "adaptation.analysis-run-created", data: { runId, providerId: input.providerId, providerRevision: input.providerRevision, targetCharacters, maxChaptersPerBatch, sourceIds: [...new Set(chapters.map((chapter) => chapter.sourceId))], taskIds: tasks.map((task) => task.id), batchCount: tasks.length, characterCount: tasks.reduce((sum, task) => sum + (task.plannedCharacterCount ?? 0), 0), revision: store.revision } });
      return { workspace: store, runId, tasks };
    } catch (error) { throw error; }
  });
}

export async function replaceNovelAnalysisRunTaskAttempt(projectRoot: string, input: { expectedRevision: number; runId: string; batchIndex: number; reason: string; confirmNoRemoteResult?: boolean }): Promise<{ workspace: AdaptationStore; replacedTask: NovelAnalysisTask; task: NovelAnalysisTask }> {
  return withProjectLock(projectRoot, "adaptation", async () => {
    const store = await loadAdaptationStore(projectRoot);
    if (store.revision !== input.expectedRevision) throw new Error(`改编工作区修订冲突，当前为 ${store.revision}。`);
    const reason = input.reason.trim().slice(0, 4_000);
    if (reason.length < 3) throw new Error("替换失败批次必须记录至少 3 个字符的原因。 ");
    const candidates = store.analysisTasks.filter((task) => task.runId === input.runId && task.batchIndex === input.batchIndex).sort((left, right) => (right.attempt ?? 1) - (left.attempt ?? 1) || right.createdAt.localeCompare(left.createdAt));
    const previous = candidates[0];
    if (!previous) throw new Error(`找不到长篇运行 ${input.runId} 的批次 ${input.batchIndex}。`);
    if (previous.replacedByTaskId) throw new Error("该批次尝试已经被替换，禁止重复创建后继任务。 ");
    if (!['failed', 'submission_unknown'].includes(previous.status)) throw new Error(`只有失败或回执不明批次才能显式替换；当前为 ${previous.status}。`);
    if (previous.status === "submission_unknown" && !input.confirmNoRemoteResult) throw new Error("回执不明批次可能已经产生远端结果；必须先人工对账并显式确认远端无可回收结果。 ");
    const library = await loadLibrary(projectRoot);
    if (library.revision !== previous.sourceLibraryRevision) throw new Error("章节库修订已变化，不能复用旧批次；请重新规划。 ");
    await freezeNovelAnalysisTaskBinding(projectRoot, previous);
    const sourceSnapshot = await loadStoryAnalysisChapterSnapshot(projectRoot, previous.chapterRefs.map((chapter) => chapter.chapterId));
    if (sourceSnapshot.library.revision !== library.revision) throw new Error("章节库在替换批次期间发生变化，请重试。");
    const currentChapters = new Map(sourceSnapshot.chapters.map((entry) => [entry.chapter.id, entry.chapter]));
    for (const chapter of previous.chapterRefs) assertNovelAnalysisChapterBinding(chapter, currentChapters.get(chapter.chapterId));
    const timestamp = now();
    const id = `analysis-${randomUUID()}`;
    const taskPaths = novelAnalysisTaskPaths(projectRoot, id);
    const task: NovelAnalysisTask = {
      ...previous,
      id,
      status: "prepared",
      taskJsonPath: taskPaths.taskJsonPath,
      taskMarkdownPath: taskPaths.taskMarkdownPath,
      reviewItemIds: [],
      execution: undefined,
      attempt: (previous.attempt ?? 1) + 1,
      supersedesTaskId: previous.id,
      replacedByTaskId: undefined,
      replacementReason: reason,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: undefined,
    };
    try {
      await createNovelAnalysisTaskBindingFiles(projectRoot, task, taskContract(task), taskMarkdown(task));
      const replacedTask: NovelAnalysisTask = { ...previous, replacedByTaskId: task.id, revision: previous.revision + 1, updatedAt: timestamp };
      store.analysisTasks = [task, ...store.analysisTasks.map((candidate) => candidate.id === previous.id ? replacedTask : candidate)];
      store.revision += 1;
      store.updatedAt = timestamp;
      await saveAdaptationStore(projectRoot, store);
      await appendEvent(projectRoot, { actor: "user", type: "adaptation.analysis-run-task-replaced", data: { runId: input.runId, batchIndex: input.batchIndex, previousTaskId: previous.id, taskId: task.id, attempt: task.attempt, previousStatus: previous.status, confirmNoRemoteResult: Boolean(input.confirmNoRemoteResult), reason, revision: store.revision } });
      return { workspace: store, replacedTask, task };
    } catch (error) { throw error; }
  });
}

async function evidenceIssues(
  spans: SourceSpan[],
  task: NovelAnalysisTask,
  library: StoryLibrary,
  content: ReadonlyMap<string, string>,
): Promise<string[]> {
  const issues: string[] = [];
  if (!spans.length) return ["缺少原文来源证据"];
  const allowed = new Set(task.chapterRefs.map((chapter) => chapter.chapterId));
  const chapters = new Map(library.chapters.map((chapter) => [chapter.id, chapter]));
  for (const span of spans) {
    const chapter = chapters.get(span.chapterId);
    if (!allowed.has(span.chapterId)) { issues.push(`章节不在任务范围：${span.chapterId}`); continue; }
    if (!chapter || chapter.sourceId !== span.sourceId || chapter.revision !== span.chapterRevision || chapter.sha256 !== span.chapterSha256) { issues.push(`章节修订或哈希失效：${span.chapterId}`); continue; }
    const ranges = task.chapterRefs.filter((ref) => ref.chapterId === span.chapterId).map((ref) => ({ start: ref.startOffset ?? 0, end: ref.endOffset ?? chapter.charCount }));
    if (!ranges.some((range) => span.startOffset >= range.start && span.endOffset <= range.end)) { issues.push(`字符区间不在任务分段内：${span.chapterId}`); continue; }
    const text = content.get(chapter.id);
    if (text === undefined) { issues.push(`章节权威正文缺失：${span.chapterId}`); continue; }
    if (span.startOffset < 0 || span.endOffset <= span.startOffset || span.endOffset > text.length) issues.push(`字符区间越界：${span.chapterId}`);
    else if (text.slice(span.startOffset, span.endOffset) !== span.text) issues.push(`原文摘录与字符区间不匹配：${span.chapterId}`);
  }
  return clean(issues);
}

export async function submitNovelAnalysisProposal(projectRoot: string, input: NovelAnalysisProposalInput): Promise<{ workspace: AdaptationStore; task: NovelAnalysisTask; reviews: NovelAnalysisReviewItem[] }> {
  return withProjectLock(projectRoot, "adaptation", async () => {
    const store = await loadAdaptationStore(projectRoot);
    if (store.revision !== input.expectedRevision) throw new Error(`改编工作区修订冲突，当前为 ${store.revision}。`);
    const task = store.analysisTasks.find((candidate) => candidate.id === input.taskId);
    if (!task) throw new Error(`找不到模型分析任务：${input.taskId}`);
    const taskBinding = await freezeNovelAnalysisTaskBinding(projectRoot, task);
    const recoveredResponse = task.status === "reconciliation_required"
      && task.execution?.status === "response_recovered"
      && task.execution.reconciliation?.status === "found";
    if (!["prepared", "executing"].includes(task.status) && !recoveredResponse) {
      throw new Error("该模型分析任务已经提交过提案或执行结果不明，不能静默覆盖。 ");
    }
    if (task.execution) {
      if (input.executionId !== task.execution.id
        || input.expectedExecutionFence !== task.execution.fence) {
        throw new Error("模型分析 execution fence 已变化；旧 worker 或旧对账结果不得回写 proposal。 ");
      }
    } else if (input.executionId !== undefined || input.expectedExecutionFence !== undefined) {
      throw new Error("未执行的手工分析任务不得携带 execution fence。 ");
    }
    if (input.facts.length > 500 || input.beats.length > 300 || (!input.facts.length && !input.beats.length)) throw new Error("模型提案数量为空或超过单次上限。 ");
    const snapshot = await loadStoryAnalysisChapterSnapshot(projectRoot, task.chapterRefs.map((chapter) => chapter.chapterId));
    const library = snapshot.library;
    if (library.revision !== task.sourceLibraryRevision) throw new Error("章节在模型分析期间发生变化，必须创建新任务。 ");
    const snapshotById = new Map(snapshot.chapters.map((entry) => [entry.chapter.id, entry]));
    for (const chapter of task.chapterRefs) assertNovelAnalysisChapterBinding(chapter, snapshotById.get(chapter.chapterId)?.chapter);
    const chapterContent = new Map(snapshot.chapters.map((entry) => [entry.chapter.id, normalizedChapterText(entry.content)]));
    if (input.executionReceipt?.proposalPath && path.resolve(input.executionReceipt.proposalPath) !== path.resolve(taskBinding.proposalPath)) {
      throw new Error("模型分析 proposal 路径与任务身份不一致。");
    }
    const timestamp = now();
    const factIds = new Map<string, string>();
    const reviews: NovelAnalysisReviewItem[] = [];
    for (const [index, proposal] of input.facts.entries()) {
      const proposalId = proposal.id?.trim() || `proposed-fact-${index + 1}`;
      const normalizedId = stableId("model-fact", `${task.id}:${proposalId}`);
      factIds.set(proposalId, normalizedId);
      const fact = { ...proposal, id: normalizedId, statement: proposal.statement.trim().slice(0, 20_000), tags: clean(proposal.tags, 100), sourceSpans: proposal.sourceSpans.slice(0, 100) };
      const issues = await evidenceIssues(fact.sourceSpans, task, library, chapterContent);
      reviews.push({ schemaVersion: 1, id: stableId("review", `${task.id}:fact:${proposalId}`), taskId: task.id, kind: "fact", status: "pending", fact, evidenceIssues: issues, revision: 1, createdAt: timestamp, updatedAt: timestamp });
    }
    const knownFactIds = new Set([...store.facts.map((fact) => fact.id), ...factIds.values()]);
    for (const [index, proposal] of input.beats.entries()) {
      const proposalId = proposal.id?.trim() || `proposed-beat-${index + 1}`;
      const beatId = stableId("model-beat", `${task.id}:${proposalId}`);
      const mappedFactIds = proposal.factIds.map((id) => factIds.get(id) ?? id);
      const issues = await evidenceIssues(proposal.sourceSpans, task, library, chapterContent);
      for (const id of mappedFactIds) if (!knownFactIds.has(id)) issues.push(`引用不存在的事实：${id}`);
      const beat = { ...proposal, id: beatId, order: (task.beatOrderBase ?? 0) + Math.max(1, Math.min(999, Math.trunc(proposal.order))), title: proposal.title.trim().slice(0, 180), summary: proposal.summary.trim().slice(0, 20_000), factIds: clean(mappedFactIds, 200), mustKeep: clean(proposal.mustKeep, 100), sourceSpans: proposal.sourceSpans.slice(0, 100) };
      reviews.push({ schemaVersion: 1, id: stableId("review", `${task.id}:beat:${proposalId}`), taskId: task.id, kind: "beat", status: "pending", beat, evidenceIssues: clean(issues), revision: 1, createdAt: timestamp, updatedAt: timestamp });
    }
    const receipt = input.executionReceipt;
    const updatedTask: NovelAnalysisTask = {
      ...task,
      status: "reviewing",
      reviewItemIds: reviews.map((review) => review.id),
      execution: task.execution ? {
        ...task.execution,
        status: "succeeded",
        completedAt: timestamp,
        responseId: receipt?.responseId?.slice(0, 500),
        responseModel: receipt?.responseModel?.slice(0, 500),
        proposalPath: receipt?.proposalPath ? taskBinding.proposalPath : undefined,
        usage: receipt ? { inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, totalTokens: receipt.totalTokens } : undefined,
        error: undefined,
      } : undefined,
      revision: task.revision + 1,
      updatedAt: timestamp,
    };
    store.analysisTasks = store.analysisTasks.map((candidate) => candidate.id === task.id ? updatedTask : candidate);
    store.analysisReviews.unshift(...reviews);
    store.revision += 1;
    store.updatedAt = timestamp;
    await saveAdaptationStore(projectRoot, store);
    await appendEvent(projectRoot, { actor: "codex", type: "adaptation.analysis-proposal-submitted", data: { taskId: task.id, facts: input.facts.length, beats: input.beats.length, evidenceIssueCount: reviews.reduce((sum, review) => sum + review.evidenceIssues.length, 0), revision: store.revision } });
    return { workspace: store, task: updatedTask, reviews };
  });
}

export async function listNovelAnalysisReviews(projectRoot: string, options: { status?: NovelAnalysisReviewItem["status"]; taskId?: string } = {}): Promise<NovelAnalysisReviewItem[]> {
  const store = await loadAdaptationStore(projectRoot);
  return store.analysisReviews.filter((review) => (!options.status || review.status === options.status) && (!options.taskId || review.taskId === options.taskId));
}

function sameSpans(left: SourceSpan[], right: SourceSpan[]): boolean {
  return JSON.stringify(left.map((span) => [span.chapterId, span.chapterRevision, span.chapterSha256, span.startOffset, span.endOffset])) === JSON.stringify(right.map((span) => [span.chapterId, span.chapterRevision, span.chapterSha256, span.startOffset, span.endOffset]));
}

export async function reviewNovelAnalysisItem(projectRoot: string, input: { reviewId: string; decision: "accepted" | "rejected"; expectedRevision: number; reviewExpectedRevision: number; note?: string }): Promise<{ workspace: AdaptationStore; review: NovelAnalysisReviewItem; appliedEntity?: NovelFact | NarrativeBeat }> {
  return withProjectLock(projectRoot, "adaptation", async () => {
    const store = await loadAdaptationStore(projectRoot);
    if (store.revision !== input.expectedRevision) throw new Error(`改编工作区修订冲突，当前为 ${store.revision}。`);
    const review = store.analysisReviews.find((candidate) => candidate.id === input.reviewId);
    if (!review) throw new Error(`找不到模型分析提案：${input.reviewId}`);
    if (review.revision !== input.reviewExpectedRevision) throw new Error(`提案修订冲突，当前为 ${review.revision}。`);
    if (review.status !== "pending") throw new Error("该提案已经作出决定，不能重复处理。 ");
    const task = store.analysisTasks.find((candidate) => candidate.id === review.taskId);
    const library = await loadLibrary(projectRoot);
    if (!task || task.sourceLibraryRevision !== library.revision) throw new Error("提案对应的章节任务已经失效。 ");
    if (input.decision === "accepted" && review.evidenceIssues.length) throw new Error(`提案证据校验未通过：${review.evidenceIssues.join("；")}`);
    if (store.sourceLibraryRevision && store.sourceLibraryRevision !== library.revision) throw new Error("当前事实层使用旧章节修订，必须先重新分析后再接受模型提案。 ");
    const timestamp = now();
    let appliedEntity: NovelFact | NarrativeBeat | undefined;
    if (input.decision === "accepted" && review.kind === "fact" && review.fact) {
      const existing = store.facts.find((fact) => fact.kind === review.fact!.kind && fact.statement === review.fact!.statement && sameSpans(fact.sourceSpans, review.fact!.sourceSpans));
      appliedEntity = existing ?? { ...review.fact, schemaVersion: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp };
      if (!existing) store.facts.push(appliedEntity as NovelFact);
    }
    if (input.decision === "accepted" && review.kind === "beat" && review.beat) {
      const proposalToApplied = new Map(store.analysisReviews.filter((candidate) => candidate.taskId === review.taskId && candidate.kind === "fact" && candidate.fact).map((candidate) => [candidate.fact!.id, candidate.appliedEntityId]));
      const factIds = review.beat.factIds.map((id) => proposalToApplied.get(id) ?? id);
      const missing = factIds.filter((id): id is string => !id || !store.facts.some((fact) => fact.id === id));
      if (missing.length) throw new Error(`必须先接受该节拍引用的事实：${missing.join("、")}`);
      const normalized = { ...review.beat, factIds: factIds as string[] };
      const existing = store.beats.find((beat) => beat.summary === normalized.summary && sameSpans(beat.sourceSpans, normalized.sourceSpans));
      appliedEntity = existing ?? { ...normalized, schemaVersion: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp };
      if (!existing) store.beats.push(appliedEntity as NarrativeBeat);
      store.beats.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    }
    const updatedReview: NovelAnalysisReviewItem = { ...review, status: input.decision, appliedEntityId: appliedEntity?.id, decisionNote: input.note?.trim().slice(0, 4_000), revision: review.revision + 1, updatedAt: timestamp };
    store.analysisReviews = store.analysisReviews.map((candidate) => candidate.id === review.id ? updatedReview : candidate);
    if (!store.sourceLibraryRevision && input.decision === "accepted") store.sourceLibraryRevision = library.revision;
    const pending = store.analysisReviews.filter((candidate) => candidate.taskId === review.taskId && candidate.id !== review.id && candidate.status === "pending");
    store.analysisTasks = store.analysisTasks.map((candidate) => candidate.id === review.taskId && !pending.length ? { ...candidate, status: "completed", revision: candidate.revision + 1, updatedAt: timestamp, completedAt: timestamp } : candidate);
    store.revision += 1;
    store.updatedAt = timestamp;
    await saveAdaptationStore(projectRoot, store);
    await appendEvent(projectRoot, { actor: "user", type: `adaptation.analysis-review-${input.decision}`, data: { reviewId: review.id, taskId: review.taskId, kind: review.kind, appliedEntityId: appliedEntity?.id, note: input.note, revision: store.revision } });
    return { workspace: store, review: updatedReview, appliedEntity };
  });
}

export interface NovelAnalysisBatchDecision {
  reviewId: string;
  decision: "accepted" | "rejected";
  reviewExpectedRevision: number;
  note?: string;
}

export async function reviewNovelAnalysisBatch(projectRoot: string, input: { expectedRevision: number; decisions: NovelAnalysisBatchDecision[] }): Promise<{ workspace: AdaptationStore; reviews: NovelAnalysisReviewItem[]; appliedEntityIds: Record<string, string> }> {
  return withProjectLock(projectRoot, "adaptation", async () => {
    if (!input.decisions.length || input.decisions.length > 200) throw new Error("批量审核必须包含 1–200 个决定。 ");
    const ids = new Set(input.decisions.map((decision) => decision.reviewId));
    if (ids.size !== input.decisions.length) throw new Error("批量审核包含重复 reviewId。 ");
    const store = await loadAdaptationStore(projectRoot);
    if (store.revision !== input.expectedRevision) throw new Error(`改编工作区修订冲突，当前为 ${store.revision}。`);
    const library = await loadLibrary(projectRoot);
    if (store.sourceLibraryRevision && store.sourceLibraryRevision !== library.revision) throw new Error("当前事实层使用旧章节修订，必须先重新分析后再接受模型提案。 ");
    const reviews = new Map(store.analysisReviews.map((review) => [review.id, review]));
    const tasks = new Map(store.analysisTasks.map((task) => [task.id, task]));
    for (const decision of input.decisions) {
      const review = reviews.get(decision.reviewId);
      if (!review) throw new Error(`找不到模型分析提案：${decision.reviewId}`);
      if (review.revision !== decision.reviewExpectedRevision) throw new Error(`提案 ${review.id} 修订冲突，当前为 ${review.revision}。`);
      if (review.status !== "pending") throw new Error(`提案 ${review.id} 已经作出决定，不能重复处理。`);
      const task = tasks.get(review.taskId);
      if (!task || task.sourceLibraryRevision !== library.revision) throw new Error(`提案 ${review.id} 对应的章节任务已经失效。`);
      if (decision.decision === "accepted" && review.evidenceIssues.length) throw new Error(`提案 ${review.id} 证据校验未通过：${review.evidenceIssues.join("；")}`);
    }
    const timestamp = now();
    const appliedEntityIds: Record<string, string> = {};
    const ranked = [...input.decisions].sort((left, right) => {
      const leftReview = reviews.get(left.reviewId)!;
      const rightReview = reviews.get(right.reviewId)!;
      const rank = (decision: NovelAnalysisBatchDecision, review: NovelAnalysisReviewItem) => decision.decision === "accepted" && review.kind === "fact" ? 0 : decision.decision === "rejected" ? 1 : 2;
      return rank(left, leftReview) - rank(right, rightReview);
    });
    for (const decision of ranked) {
      const review = reviews.get(decision.reviewId)!;
      let appliedEntity: NovelFact | NarrativeBeat | undefined;
      if (decision.decision === "accepted" && review.kind === "fact" && review.fact) {
        const existing = store.facts.find((fact) => fact.kind === review.fact!.kind && fact.statement === review.fact!.statement && sameSpans(fact.sourceSpans, review.fact!.sourceSpans));
        appliedEntity = existing ?? { ...review.fact, schemaVersion: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp };
        if (!existing) store.facts.push(appliedEntity as NovelFact);
      }
      if (decision.decision === "accepted" && review.kind === "beat" && review.beat) {
        const proposalToApplied = new Map([...reviews.values()].filter((candidate) => candidate.taskId === review.taskId && candidate.kind === "fact" && candidate.fact).map((candidate) => [candidate.fact!.id, candidate.appliedEntityId]));
        const factIds = review.beat.factIds.map((id) => proposalToApplied.get(id) ?? id);
        const missing = factIds.filter((id): id is string => !id || !store.facts.some((fact) => fact.id === id));
        if (missing.length) throw new Error(`提案 ${review.id} 必须先接受引用的事实：${missing.join("、")}`);
        const normalized = { ...review.beat, factIds: factIds as string[] };
        const existing = store.beats.find((beat) => beat.summary === normalized.summary && sameSpans(beat.sourceSpans, normalized.sourceSpans));
        appliedEntity = existing ?? { ...normalized, schemaVersion: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp };
        if (!existing) store.beats.push(appliedEntity as NarrativeBeat);
      }
      if (appliedEntity) appliedEntityIds[review.id] = appliedEntity.id;
      const updated: NovelAnalysisReviewItem = { ...review, status: decision.decision, appliedEntityId: appliedEntity?.id, decisionNote: decision.note?.trim().slice(0, 4_000), revision: review.revision + 1, updatedAt: timestamp };
      reviews.set(review.id, updated);
      store.analysisReviews = store.analysisReviews.map((candidate) => candidate.id === review.id ? updated : candidate);
    }
    if (input.decisions.some((decision) => decision.decision === "accepted") && !store.sourceLibraryRevision) store.sourceLibraryRevision = library.revision;
    store.beats.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const affectedTaskIds = new Set(input.decisions.map((decision) => reviews.get(decision.reviewId)!.taskId));
    store.analysisTasks = store.analysisTasks.map((task) => affectedTaskIds.has(task.id) && !store.analysisReviews.some((review) => review.taskId === task.id && review.status === "pending") ? { ...task, status: "completed", revision: task.revision + 1, updatedAt: timestamp, completedAt: timestamp } : task);
    store.revision += 1;
    store.updatedAt = timestamp;
    await saveAdaptationStore(projectRoot, store);
    await appendEvent(projectRoot, { actor: "user", type: "adaptation.analysis-review-batch", data: { reviewIds: input.decisions.map((decision) => decision.reviewId), accepted: input.decisions.filter((decision) => decision.decision === "accepted").length, rejected: input.decisions.filter((decision) => decision.decision === "rejected").length, appliedEntityIds, revision: store.revision } });
    return { workspace: store, reviews: input.decisions.map((decision) => reviews.get(decision.reviewId)!), appliedEntityIds };
  });
}
