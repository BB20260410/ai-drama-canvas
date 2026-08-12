import { createHash } from "node:crypto";
import path from "node:path";
import { inspectManagedProjectReadOnly } from "./managed-project.js";
import {
  NovelRepository,
  orderedNovelChapters,
  type NovelWorkspaceSnapshot,
} from "./novel-manuscript.js";
import { getActiveProjectRegistrationSnapshotReadOnly } from "./sidecar.js";
import {
  probeNovelChapterConsistencyCore,
  type ProbeNovelChapterConsistencyInput,
} from "./novel-consistency-probe.js";
import {
  NOVEL_OFFSET_ENCODING,
  type NovelChapterRecord,
  type NovelActorAttribution,
  type NovelContextPackReceipt,
  type NovelContextPackSelectionTrace,
  type NovelContextPackSelectionTraceEntry,
  type NovelContextPackTraceSection,
  type SearchNovelChaptersInput,
  type NovelWritingWorkflowMode,
} from "./novel-types.js";
import {
  assertNovelWritingStateHistoryReadable,
  deriveNovelWritePreflight,
  getNovelChapterWriteLeaseStatus,
  getNovelWritingStateHistoryStatus,
  getNovelWritingStateProjection,
  loadNovelPublicWritingState,
  loadNovelWritingState,
  NovelWritingStateRejectedError,
  planNovelWritingStateRebuild as planNovelWritingStateRebuildCore,
  projectNovelWritingState,
} from "./novel-writing-state.js";
import {
  loadNovelWritingSourceSnapshotReceipt,
  listNovelWritingSourceSnapshotReceipts,
  verifyNovelWritingSourceClosure,
} from "./novel-writing-source-import.js";

export const NOVEL_AGENT_CONTRACT_VERSION = 1 as const;
export const NOVEL_AGENT_DEFAULT_READ_CHARACTERS = 12_000;
export const NOVEL_AGENT_MAX_READ_CHARACTERS = 200_000;
export const NOVEL_AGENT_DEFAULT_CONTEXT_CHARACTERS = 12_000;
export const NOVEL_AGENT_MAX_CONTEXT_CHARACTERS = 200_000;
export const NOVEL_AGENT_MAX_CONTEXT_CHAPTERS = 50;
export const NOVEL_AGENT_DEFAULT_CONTEXT_CHAPTERS = 3;
export const NOVEL_AGENT_MAX_CONTEXT_SEARCH_HITS = 50;

export const NOVEL_AGENT_CAPABILITIES = {
  schemaVersion: NOVEL_AGENT_CONTRACT_VERSION,
  kind: "novel-agent-capabilities",
  contract: "aicanvas.novel-agent",
  transport: {
    mcp: true,
    jsonCli: true,
    projectSelection: "explicit-project-root-or-active-registration",
  },
  authority: {
    manuscript: "managed-markdown-and-json-manifests",
    derivedDatabaseRequired: false,
    writes: "execute-command-only",
    agentChapterBodyWrites: "empty-create-then-context-pack-preflight-save",
    humanDesktopCompatibility: "explicit-human-ui-actor",
  },
  offsets: {
    encoding: NOVEL_OFFSET_ENCODING,
    interval: "half-open",
  },
  operations: {
    read: [
      "doctor",
      "workspace",
      "list_chapters",
      "read_chapter_range",
      "search",
      "get_search_index_status",
      "get_writing_state",
      "build_context_pack",
      "preflight_chapter_write",
      "plan_novel_state_rebuild",
      "get_state_rebuild_status",
      "probe_chapter_consistency",
      "list_writing_source_receipts",
      "compare_writing_source_receipts",
    ],
    writeCommands: [
      "novel_initialize_manuscript",
      "novel_create_volume",
      "novel_create_chapter",
      "novel_save_chapter",
      "novel_rename_chapter",
      "novel_move_chapter",
      "novel_reorder_chapters",
      "novel_rebuild_search_index",
      "novel_recover_manuscript",
      "novel_recover_writing_state",
      "novel_seed_writing_state",
      "novel_stage_chapter_state_candidate",
      "novel_review_chapter_state_candidate",
      "novel_stage_story_bible_candidate",
      "novel_review_story_bible_candidate",
      "novel_invalidate_writing_state_from",
      "novel_attach_review_ticket",
      "novel_import_writing_source_snapshot",
    ],
    controlTools: ["prepare_novel_chapter_write"],
    controlOperations: [{
      operationId: "prepare_chapter_write",
      recommended: true,
      transports: {
        mcpTool: "prepare_novel_chapter_write",
        jsonCliOperation: "prepare_novel_chapter_write",
        jsonCliLegacyAliases: ["prepare_chapter_write"],
      },
    }],
  },
  limits: {
    chapterPageMax: 500,
    readCharactersDefault: NOVEL_AGENT_DEFAULT_READ_CHARACTERS,
    readCharactersMax: NOVEL_AGENT_MAX_READ_CHARACTERS,
    searchQueryCharacters: { minimum: 2, maximum: 200 },
    searchHitsMax: 200,
    contextCharactersDefault: NOVEL_AGENT_DEFAULT_CONTEXT_CHARACTERS,
    contextCharactersMax: NOVEL_AGENT_MAX_CONTEXT_CHARACTERS,
    contextChapterIdsMax: NOVEL_AGENT_MAX_CONTEXT_CHAPTERS,
  },
  consistency: {
    readIdentity: ["chapterId", "revision", "sha256", "offsetEncoding"],
    saveCas: ["expectedRevision", "expectedSha256"],
    contextFutureBoundary: "cutoffChapterId-inclusive",
    externalChanges: "reported-and-skipped",
    stateHistory: "append-only-event-checkpoint-with-shadow-rebuild-promotion",
    stateRecovery: "intent-before-after-cas-fail-on-third-sha",
  },
} as const;

export interface NovelAgentProjectContext {
  projectRoot: string;
  projectId: string;
  projectName: string;
  workspaceMode: "novel" | "hybrid";
  manifestFingerprint: string;
  selection: "explicit" | "active";
}

export interface ReadNovelChapterRangeInput {
  chapterId: string;
  startOffset?: number;
  maxCharacters?: number;
  taskScope?: NovelTaskReadScopeInput;
}

export interface NovelTaskReadScopeInput {
  targetChapterId: string;
  cutoff: "before" | "through";
}

export interface BuildNovelContextPackInput {
  query?: string;
  chapterIds?: string[];
  cutoffChapterId?: string;
  maxCharacters?: number;
  maxSearchHits?: number;
  taskType?: "continue_chapter" | "revise_chapter" | "review_chapter";
  targetChapterId?: string;
  characterIds?: string[];
  workflowMode?: NovelWritingWorkflowMode;
}

export interface PreflightNovelChapterWriteInput {
  taskType?: "continue_chapter" | "revise_chapter";
  targetChapterId: string;
  contextPackFingerprint: string;
  query?: string;
  chapterIds?: string[];
  characterIds?: string[];
  maxCharacters?: number;
  maxSearchHits?: number;
  workflowMode?: NovelWritingWorkflowMode;
}

export interface PrepareNovelChapterWriteInput {
  taskType?: "continue_chapter" | "revise_chapter";
  targetChapterId: string;
  query?: string;
  chapterIds?: string[];
  characterIds?: string[];
  maxCharacters?: number;
  maxSearchHits?: number;
  workflowMode?: NovelWritingWorkflowMode;
  attribution: NovelActorAttribution;
  ttlSeconds?: number;
}

export interface DoctorNovelAgentInput {
  targetChapterId?: string;
  workflowMode?: NovelWritingWorkflowMode;
}

function collectSourceIds(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectSourceIds(entry, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "sourceIds" && Array.isArray(entry)) {
      for (const sourceId of entry) if (typeof sourceId === "string") output.add(sourceId);
    } else collectSourceIds(entry, output);
  }
  return output;
}

type ContextSelectionReason = "explicit" | "query" | "recent";

interface ContextCandidate {
  chapter: NovelChapterRecord;
  reasons: ContextSelectionReason[];
  firstHit?: { startOffset: number; endOffset: number };
}

function projectChapter(chapter: NovelChapterRecord) {
  return {
    chapterId: chapter.chapterId,
    volumeId: chapter.volumeId,
    title: chapter.title,
    order: chapter.order,
    relativePath: chapter.relativePath,
    sha256: chapter.sha256,
    byteLength: chapter.byteLength,
    charCount: chapter.charCount,
    offsetEncoding: chapter.offsetEncoding,
    revision: chapter.revision,
    sourceReceiptId: chapter.sourceReceiptId,
    createdAt: chapter.createdAt,
    updatedAt: chapter.updatedAt,
  };
}

function requireSafeIntegerInRange(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} 必须是 ${minimum}–${maximum} 的安全整数。`);
  }
  return value;
}

function ensureUtf16Boundary(content: string, offset: number, label: string): void {
  if (offset <= 0 || offset >= content.length) return;
  const previous = content.charCodeAt(offset - 1);
  const current = content.charCodeAt(offset);
  if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
    throw new Error(`${label} 位于 UTF-16 代理对中间，请改用完整字符边界。`);
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stable(entry)]));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

async function assertNovelProject(root: string, selection: NovelAgentProjectContext["selection"]): Promise<NovelAgentProjectContext> {
  const shell = await inspectManagedProjectReadOnly(root);
  if (shell.manifest.schemaVersion !== 2
    || (shell.workspaceMode !== "novel" && shell.workspaceMode !== "hybrid")) {
    throw new Error("Novel Agent 只接受 schema v2 novel/hybrid 受管工程。");
  }
  return {
    projectRoot: shell.paths.root,
    projectId: shell.project.id,
    projectName: shell.project.name,
    workspaceMode: shell.workspaceMode,
    manifestFingerprint: shell.manifestFingerprint,
    selection,
  };
}

export async function resolveNovelAgentProject(projectRoot?: string): Promise<NovelAgentProjectContext> {
  const requested = projectRoot?.trim();
  if (requested) {
    if (!path.isAbsolute(requested) || requested.includes("\0")) {
      throw new Error("Novel Agent projectRoot 必须是绝对路径。");
    }
    return assertNovelProject(path.resolve(requested), "explicit");
  }

  const { state, registration } = await getActiveProjectRegistrationSnapshotReadOnly();
  if (!state || !registration) {
    throw new Error("桌面软件尚未明确选择并登记活动小说工程；请传 projectRoot 或先在项目中心打开小说工程。");
  }
  const activeRoot = path.resolve(state.primaryRoot);
  if (path.resolve(registration.primaryRoot) !== activeRoot) {
    throw new Error("活动工程指针与项目注册表不一致，拒绝静默选择。");
  }
  const project = await assertNovelProject(activeRoot, "active");
  if (project.projectId !== registration.id) {
    throw new Error("活动小说 manifest 与项目注册表身份不一致。");
  }
  return project;
}

export function getNovelAgentCapabilities() {
  return NOVEL_AGENT_CAPABILITIES;
}

function summarizeWorkspace(project: NovelAgentProjectContext, snapshot: NovelWorkspaceSnapshot) {
  const chapters = orderedNovelChapters(snapshot.chapters);
  const chapterCounts = new Map<string, number>();
  for (const chapter of chapters) {
    chapterCounts.set(chapter.volumeId, (chapterCounts.get(chapter.volumeId) ?? 0) + 1);
  }
  return {
    contract: NOVEL_AGENT_CAPABILITIES,
    project,
    workspace: {
      projectId: snapshot.workspace.projectId,
      sourceMode: snapshot.workspace.sourceMode,
      revision: snapshot.workspace.revision,
      fingerprint: snapshot.workspace.fingerprint,
      sourceReceiptIds: snapshot.workspace.sourceReceiptIds,
      createdAt: snapshot.workspace.createdAt,
      updatedAt: snapshot.workspace.updatedAt,
    },
    manuscript: snapshot.chapters
      ? {
          status: "ready" as const,
          manifestRevision: snapshot.chapters.revision,
          volumeCount: snapshot.chapters.volumes.length,
          chapterCount: chapters.length,
          charCount: chapters.reduce((total, chapter) => total + chapter.charCount, 0),
          byteLength: chapters.reduce((total, chapter) => total + chapter.byteLength, 0),
          updatedAt: snapshot.chapters.updatedAt,
          volumes: [...snapshot.chapters.volumes]
            .sort((left, right) => left.order - right.order || left.volumeId.localeCompare(right.volumeId))
            .map((volume) => ({ ...volume, chapterCount: chapterCounts.get(volume.volumeId) ?? 0 })),
        }
      : {
          status: "external_snapshot" as const,
          manifestRevision: null,
          volumeCount: 0,
          chapterCount: 0,
          charCount: 0,
          byteLength: 0,
          volumes: [],
        },
  };
}

export async function getNovelManuscriptWorkspace(projectRoot?: string) {
  const project = await resolveNovelAgentProject(projectRoot);
  const snapshot = await new NovelRepository(project.projectRoot).snapshot();
  return summarizeWorkspace(project, snapshot);
}

async function resolveNovelTaskReadBoundary(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
  scope: NovelTaskReadScopeInput,
) {
  if (!snapshot.chapters) throw new Error("external_snapshot workspace 没有可读取的受管章节。");
  const state = await loadNovelWritingState(projectRoot, snapshot.workspace.projectId);
  if (!state) throw new Error("任务时态读取需要先初始化 writing-state。");
  const ordered = orderedNovelChapters(snapshot.chapters);
  const targetIndex = ordered.findIndex((chapter) => chapter.chapterId === scope.targetChapterId);
  if (targetIndex < 0) throw new Error(`任务时态读取目标章不存在：${scope.targetChapterId}`);
  const currentThroughIndex = ordered.findIndex((chapter) => chapter.chapterId === state.currentThroughChapterId);
  if (currentThroughIndex < 0) throw new Error("writing-state.currentThroughChapterId 不在当前正文 manifest 中。");
  const requestedIndex = scope.cutoff === "before" ? targetIndex - 1 : targetIndex;
  const effectiveIndex = Math.min(requestedIndex, currentThroughIndex);
  const allowedChapters = effectiveIndex < 0 ? [] : ordered.slice(0, effectiveIndex + 1);
  return {
    allowedChapters,
    allowedIds: new Set(allowedChapters.map((chapter) => chapter.chapterId)),
    summary: {
      targetChapterId: scope.targetChapterId,
      requestedCutoff: scope.cutoff,
      effectiveCutoffChapterId: allowedChapters.at(-1)?.chapterId ?? null,
      currentThroughChapterId: state.currentThroughChapterId,
    },
  };
}

export async function listNovelManuscriptChapters(
  projectRoot: string | undefined,
  options: { offset?: number; limit?: number; taskScope?: NovelTaskReadScopeInput } = {},
) {
  const project = await resolveNovelAgentProject(projectRoot);
  const repository = new NovelRepository(project.projectRoot);
  if (options.taskScope) {
    const snapshot = await repository.snapshot();
    if (!snapshot.chapters) throw new Error("external_snapshot workspace 没有可读取的受管章节。");
    const boundary = await resolveNovelTaskReadBoundary(project.projectRoot, snapshot, options.taskScope);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;
    requireSafeIntegerInRange(offset, "offset", 0, Number.MAX_SAFE_INTEGER);
    requireSafeIntegerInRange(limit, "limit", 1, 500);
    const items = boundary.allowedChapters.slice(offset, offset + limit);
    return {
      contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
      project,
      workspaceRevision: snapshot.workspace.revision,
      manifestRevision: snapshot.chapters.revision,
      total: boundary.allowedChapters.length,
      offset,
      limit,
      nextOffset: offset + items.length < boundary.allowedChapters.length ? offset + items.length : null,
      items: items.map(projectChapter),
      taskBoundary: boundary.summary,
    };
  }
  const page = await repository.listChapters(options);
  return {
    contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
    project,
    workspaceRevision: page.workspaceRevision,
    manifestRevision: page.manifestRevision,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    nextOffset: page.offset + page.items.length < page.total ? page.offset + page.items.length : null,
    items: page.items.map(projectChapter),
  };
}

export async function readNovelManuscriptRange(
  projectRoot: string | undefined,
  input: ReadNovelChapterRangeInput,
) {
  const project = await resolveNovelAgentProject(projectRoot);
  const repository = new NovelRepository(project.projectRoot);
  const boundary = input.taskScope
    ? await resolveNovelTaskReadBoundary(project.projectRoot, await repository.snapshot(), input.taskScope)
    : null;
  if (boundary && !boundary.allowedIds.has(input.chapterId)) {
    throw new Error(`章节 ${input.chapterId} 超出任务时态截止边界，拒绝未来正文读取。`);
  }
  const startOffset = input.startOffset ?? 0;
  const maxCharacters = input.maxCharacters ?? NOVEL_AGENT_DEFAULT_READ_CHARACTERS;
  requireSafeIntegerInRange(startOffset, "startOffset", 0, Number.MAX_SAFE_INTEGER);
  requireSafeIntegerInRange(maxCharacters, "maxCharacters", 1, NOVEL_AGENT_MAX_READ_CHARACTERS);
  const read = await repository.readChapter(input.chapterId);
  if (read.status === "external_change") {
    return {
      contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
      project,
      status: read.status,
      chapter: projectChapter(read.chapter),
      actual: read.actual,
    };
  }
  if (startOffset > read.content.length) {
    throw new Error(`startOffset ${startOffset} 超过章节 UTF-16 长度 ${read.content.length}。`);
  }
  ensureUtf16Boundary(read.content, startOffset, "startOffset");
  let endOffset = Math.min(read.content.length, startOffset + maxCharacters);
  if (endOffset < read.content.length) {
    const previous = read.content.charCodeAt(endOffset - 1);
    const current = read.content.charCodeAt(endOffset);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
      endOffset -= 1;
    }
  }
  return {
    contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
    project,
    status: read.status,
    chapter: projectChapter(read.chapter),
    range: {
      startOffset,
      endOffset,
      totalCharacters: read.content.length,
      offsetEncoding: NOVEL_OFFSET_ENCODING,
      truncatedBefore: startOffset > 0,
      truncatedAfter: endOffset < read.content.length,
    },
    content: read.content.slice(startOffset, endOffset),
    ...(boundary ? { taskBoundary: boundary.summary } : {}),
  };
}

export async function searchNovelManuscript(
  projectRoot: string | undefined,
  input: SearchNovelChaptersInput & { taskScope?: NovelTaskReadScopeInput },
) {
  const project = await resolveNovelAgentProject(projectRoot);
  const repository = new NovelRepository(project.projectRoot);
  const boundary = input.taskScope
    ? await resolveNovelTaskReadBoundary(project.projectRoot, await repository.snapshot(), input.taskScope)
    : null;
  const result = await repository.searchChapters({
    query: input.query,
    limit: input.limit,
    maxHitsPerChapter: input.maxHitsPerChapter,
    ...(boundary ? { allowedChapterIds: [...boundary.allowedIds] } : {}),
  });
  return {
    contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
    project,
    query: result.query,
    manifestRevision: result.manifestRevision,
    engine: result.engine,
    indexedChapters: result.indexedChapters,
    indexState: result.indexState,
    ...(result.indexGenerationId ? { indexGenerationId: result.indexGenerationId } : {}),
    ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
    scannedChapters: result.scannedChapters,
    skippedExternalChanges: result.skippedExternalChanges,
    hits: result.hits.map((hit) => ({
      chapter: projectChapter(hit.chapter),
      startOffset: hit.startOffset,
      endOffset: hit.endOffset,
      offsetEncoding: NOVEL_OFFSET_ENCODING,
      snippet: hit.snippet,
    })),
    ...(boundary ? { taskBoundary: boundary.summary } : {}),
  };
}

export async function getNovelSearchIndexStatus(projectRoot: string | undefined) {
  const project = await resolveNovelAgentProject(projectRoot);
  const repository = new NovelRepository(project.projectRoot);
  return {
    contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
    project,
    status: await repository.getSearchIndexStatus(),
    rebuild: {
      tool: "execute_command" as const,
      request: { command: "novel_rebuild_search_index" as const, payload: {} },
      note: "只有显式 rebuild 会写派生索引；普通搜索和状态读取不会建库或修库。",
    },
  };
}

function contextCandidateMap(
  ordered: NovelChapterRecord[],
  allowedIds: Set<string>,
  input: BuildNovelContextPackInput,
): Map<string, ContextCandidate> {
  const byId = new Map(ordered.map((chapter) => [chapter.chapterId, chapter]));
  const candidates = new Map<string, ContextCandidate>();
  const add = (chapter: NovelChapterRecord, reason: ContextSelectionReason, firstHit?: ContextCandidate["firstHit"]) => {
    const existing = candidates.get(chapter.chapterId);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      existing.firstHit ??= firstHit;
    } else {
      candidates.set(chapter.chapterId, { chapter, reasons: [reason], firstHit });
    }
  };

  const requestedChapterIds = input.chapterIds ?? [];
  if (requestedChapterIds.length > NOVEL_AGENT_MAX_CONTEXT_CHAPTERS) {
    throw new Error(`chapterIds 最多 ${NOVEL_AGENT_MAX_CONTEXT_CHAPTERS} 项。`);
  }
  if (new Set(requestedChapterIds).size !== requestedChapterIds.length) {
    throw new Error("chapterIds 不得重复。");
  }
  for (const chapterId of requestedChapterIds) {
    const chapter = byId.get(chapterId);
    if (!chapter) throw new Error(`上下文指定章节不存在：${chapterId}`);
    if (!allowedIds.has(chapterId)) throw new Error(`章节 ${chapterId} 位于 cutoffChapterId 之后，拒绝未来正文泄漏。`);
    add(chapter, "explicit");
  }
  return candidates;
}

function allocationForCandidate(remaining: number, candidatesRemaining: number): number {
  if (remaining <= 0 || candidatesRemaining <= 0) return 0;
  return Math.max(1, Math.floor(remaining / candidatesRemaining));
}

function chooseContextRange(
  content: string,
  allocation: number,
  candidate: ContextCandidate,
): { startOffset: number; endOffset: number } {
  if (content.length <= allocation) return { startOffset: 0, endOffset: content.length };
  if (candidate.firstHit) {
    const hitCenter = Math.floor((candidate.firstHit.startOffset + candidate.firstHit.endOffset) / 2);
    let startOffset = Math.max(0, hitCenter - Math.floor(allocation / 2));
    let endOffset = Math.min(content.length, startOffset + allocation);
    startOffset = Math.max(0, endOffset - allocation);
    return { startOffset, endOffset };
  }
  if (candidate.reasons.includes("recent")) {
    return { startOffset: content.length - allocation, endOffset: content.length };
  }
  return { startOffset: 0, endOffset: allocation };
}

async function buildLegacyContextPackAttempt(
  project: NovelAgentProjectContext,
  input: BuildNovelContextPackInput,
  maxCharacters: number,
  maxSearchHits: number,
) {
  const repository = new NovelRepository(project.projectRoot);
  const snapshot = await repository.snapshot();
  if (!snapshot.chapters) throw new Error("external_snapshot workspace 没有可读取的受管章节。");
  const ordered = orderedNovelChapters(snapshot.chapters);
  const cutoffIndex = input.cutoffChapterId
    ? ordered.findIndex((chapter) => chapter.chapterId === input.cutoffChapterId)
    : ordered.length - 1;
  if (input.cutoffChapterId && cutoffIndex < 0) {
    throw new Error(`cutoffChapterId 不存在：${input.cutoffChapterId}`);
  }
  const allowed = ordered.slice(0, cutoffIndex + 1);
  const allowedIds = new Set(allowed.map((chapter) => chapter.chapterId));
  const candidates = contextCandidateMap(ordered, allowedIds, input);

  let searchResult: Awaited<ReturnType<NovelRepository["searchChapters"]>> | undefined;
  if (input.query !== undefined) {
    searchResult = await repository.searchChapters({
      query: input.query,
      limit: maxSearchHits,
      maxHitsPerChapter: 5,
      allowedChapterIds: [...allowedIds],
    });
    if (searchResult.manifestRevision !== snapshot.chapters.revision) return null;
    for (const hit of searchResult.hits) {
      if (!allowedIds.has(hit.chapter.chapterId)) continue;
      const existing = candidates.get(hit.chapter.chapterId);
      if (existing) {
        if (!existing.reasons.includes("query")) existing.reasons.push("query");
        existing.firstHit ??= { startOffset: hit.startOffset, endOffset: hit.endOffset };
      } else {
        candidates.set(hit.chapter.chapterId, {
          chapter: hit.chapter,
          reasons: ["query"],
          firstHit: { startOffset: hit.startOffset, endOffset: hit.endOffset },
        });
      }
    }
  }

  if (candidates.size === 0 && input.query === undefined && (input.chapterIds?.length ?? 0) === 0) {
    for (const chapter of allowed.slice(-NOVEL_AGENT_DEFAULT_CONTEXT_CHAPTERS)) {
      candidates.set(chapter.chapterId, { chapter, reasons: ["recent"] });
    }
  }

  const selected = [...candidates.values()];
  const excerpts: Array<{
    chapter: ReturnType<typeof projectChapter>;
    reasons: ContextSelectionReason[];
    range: {
      startOffset: number;
      endOffset: number;
      offsetEncoding: typeof NOVEL_OFFSET_ENCODING;
      truncatedBefore: boolean;
      truncatedAfter: boolean;
    };
    text: string;
  }> = [];
  const skippedExternalChanges: Array<{
    chapter: ReturnType<typeof projectChapter>;
    actual: { sha256: string; byteLength: number; charCount?: number };
  }> = [];
  let usedCharacters = 0;
  for (let index = 0; index < selected.length && usedCharacters < maxCharacters; index += 1) {
    const candidate = selected[index]!;
    const read = await repository.readChapter(candidate.chapter.chapterId);
    if (read.status === "external_change") {
      skippedExternalChanges.push({ chapter: projectChapter(read.chapter), actual: read.actual });
      continue;
    }
    const allocation = allocationForCandidate(maxCharacters - usedCharacters, selected.length - index);
    if (allocation <= 0) break;
    let range = chooseContextRange(read.content, allocation, candidate);
    if (range.startOffset > 0) {
      const previous = read.content.charCodeAt(range.startOffset - 1);
      const current = read.content.charCodeAt(range.startOffset);
      if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
        range = { ...range, startOffset: range.startOffset + 1 };
      }
    }
    if (range.endOffset < read.content.length) {
      const previous = read.content.charCodeAt(range.endOffset - 1);
      const current = read.content.charCodeAt(range.endOffset);
      if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
        range = { ...range, endOffset: range.endOffset - 1 };
      }
    }
    const text = read.content.slice(range.startOffset, range.endOffset);
    usedCharacters += text.length;
    excerpts.push({
      chapter: projectChapter(read.chapter),
      reasons: candidate.reasons,
      range: {
        ...range,
        offsetEncoding: NOVEL_OFFSET_ENCODING,
        truncatedBefore: range.startOffset > 0,
        truncatedAfter: range.endOffset < read.content.length,
      },
      text,
    });
  }

  const latest = await repository.snapshot();
  if (latest.chapters?.revision !== snapshot.chapters.revision) return null;
  const excerptByChapterId = new Map(excerpts.map((entry) => [entry.chapter.chapterId, entry]));
  const externallyChangedChapterIds = new Set(skippedExternalChanges.map((entry) => entry.chapter.chapterId));
  const selectionTraceEntries: NovelContextPackSelectionTraceEntry[] = selected.map((candidate) => {
    const excerpt = excerptByChapterId.get(candidate.chapter.chapterId);
    const disposition = excerpt ? "included" as const : "omitted" as const;
    const externalChange = externallyChangedChapterIds.has(candidate.chapter.chapterId);
    return {
      section: "excerpts",
      itemId: candidate.chapter.chapterId,
      disposition,
      source: "managed_chapter",
      sourceIds: [candidate.chapter.chapterId],
      protection: "compressible",
      characterCost: excerpt?.text.length ?? candidate.chapter.charCount,
      rule: "selected_by_explicit_query_or_recency_then_fit_remaining_budget",
      reason: excerpt
        ? `included:${candidate.reasons.join("+")}${excerpt.range.truncatedBefore || excerpt.range.truncatedAfter ? ":truncated" : ":full"}`
        : externalChange
          ? "omitted:chapter_identity_changed"
          : "omitted:context_budget_exhausted",
    };
  });
  const semantic = {
    contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
    kind: "novel-context-pack" as const,
    project,
    workspaceRevision: snapshot.workspace.revision,
    manifestRevision: snapshot.chapters.revision,
    selection: {
      query: searchResult?.query,
      chapterIds: input.chapterIds ?? [],
      cutoffChapterId: input.cutoffChapterId,
      cutoffInclusive: true,
    },
    budget: {
      maximumCharacters: maxCharacters,
      usedCharacters,
      truncated: excerpts.length < selected.length
        || excerpts.some((entry) => entry.range.truncatedBefore || entry.range.truncatedAfter),
    },
    excerpts,
    skippedExternalChanges,
  };
  return { ...semantic, fingerprint: fingerprint(semantic), selectionTraceEntries };
}

const NON_NARRATIVE_CONTEXT_KEYS = new Set([
  "chapterId",
  "entityId",
  "ruleId",
  "stateId",
  "knowledgeId",
  "relationshipId",
  "timelineId",
  "foreshadowingId",
  "sourceIds",
  "sourceId",
  "throughChapterId",
  "effectiveFromChapterId",
  "effectiveUntilChapterId",
  "startChapterId",
  "endChapterId",
  "disclosureChapterId",
  "setupChapterId",
  "maintenanceChapterIds",
  "payoffChapterId",
]);

function narrativeCharacterCost(value: unknown, key?: string): number {
  if (NON_NARRATIVE_CONTEXT_KEYS.has(key ?? "")) return 0;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((total, entry) => total + narrativeCharacterCost(entry, key), 0);
  if (!value || typeof value !== "object") return 0;
  return Object.entries(value as Record<string, unknown>)
    .reduce((total, [entryKey, entry]) => total + narrativeCharacterCost(entry, entryKey), 0);
}

const TRACE_ID_KEYS: Record<Exclude<NovelContextPackTraceSection, "excerpts">, string> = {
  hardCanon: "ruleId",
  taskBrief: "chapterId",
  entities: "entityId",
  characterProfiles: "entityId",
  characterAppearances: "entityId",
  characterStates: "stateId",
  knowledge: "knowledgeId",
  relationships: "relationshipId",
  timeline: "timelineId",
  foreshadowing: "foreshadowingId",
};

function writingStateTraceEntry(
  section: Exclude<NovelContextPackTraceSection, "excerpts">,
  candidate: unknown,
  disposition: "included" | "omitted",
  protection: "protected" | "compressible",
  rule: string,
  reason: string,
): NovelContextPackSelectionTraceEntry {
  const record = candidate as Record<string, unknown>;
  const itemId = record[TRACE_ID_KEYS[section]];
  if (typeof itemId !== "string" || itemId.length === 0) {
    throw new Error(`Context Pack trace 无法识别 ${section} 条目身份。`);
  }
  const sourceIds = Array.isArray(record.sourceIds)
    ? [...new Set(record.sourceIds.filter((entry): entry is string => typeof entry === "string"))]
      .sort((left, right) => left.localeCompare(right, "en"))
    : [];
  return {
    section,
    itemId,
    disposition,
    source: "writing_state",
    sourceIds,
    protection,
    ...(typeof record.priority === "number" ? { priority: record.priority } : {}),
    characterCost: narrativeCharacterCost(candidate),
    rule,
    reason,
  };
}

function appendIncludedTrace<T>(
  trace: NovelContextPackSelectionTraceEntry[],
  section: Exclude<NovelContextPackTraceSection, "excerpts">,
  candidates: readonly T[],
  protection: "protected" | "compressible",
  rule: string,
  reason: string,
): void {
  for (const candidate of candidates) {
    trace.push(writingStateTraceEntry(section, candidate, "included", protection, rule, reason));
  }
}

function pushBudgeted<T>(
  target: T[],
  candidates: readonly T[],
  budget: { maximum: number; used: number; omitted: Array<{ section: string; count: number }> },
  section: Exclude<NovelContextPackTraceSection, "excerpts">,
  trace: NovelContextPackSelectionTraceEntry[],
): void {
  let omitted = 0;
  for (const candidate of candidates) {
    const cost = narrativeCharacterCost(candidate);
    if (budget.used + cost > budget.maximum) {
      omitted += 1;
      trace.push(writingStateTraceEntry(
        section,
        candidate,
        "omitted",
        "compressible",
        "rehearsal_projection_fits_remaining_budget",
        "omitted:context_budget_exhausted",
      ));
      continue;
    }
    target.push(candidate);
    budget.used += cost;
    trace.push(writingStateTraceEntry(
      section,
      candidate,
      "included",
      "compressible",
      "rehearsal_projection_fits_remaining_budget",
      "included:fits_remaining_budget",
    ));
  }
  if (omitted) budget.omitted.push({ section, count: omitted });
}

async function buildNovelContextPackV2Attempt(
  project: NovelAgentProjectContext,
  input: BuildNovelContextPackInput & { targetChapterId: string },
  maxCharacters: number,
  maxSearchHits: number,
) {
  const repository = new NovelRepository(project.projectRoot);
  const snapshot = await repository.snapshot();
  if (!snapshot.chapters) throw new Error("external_snapshot workspace 没有可读取的受管章节。");
  const ordered = orderedNovelChapters(snapshot.chapters);
  const targetIndex = ordered.findIndex((chapter) => chapter.chapterId === input.targetChapterId);
  if (targetIndex < 0) throw new Error(`targetChapterId 不存在：${input.targetChapterId}`);
  const cutoffChapterId = targetIndex > 0 ? ordered[targetIndex - 1]!.chapterId : null;
  if (input.cutoffChapterId !== undefined && input.cutoffChapterId !== cutoffChapterId) {
    throw new Error("Context Pack 2.0 的 cutoffChapterId 必须精确等于目标章前一章。");
  }
  await assertNovelWritingStateHistoryReadable(project.projectRoot, snapshot.workspace.projectId);
  const state = await loadNovelWritingState(project.projectRoot, snapshot.workspace.projectId);
  if (!state) throw new Error("Context Pack 2.0 需要先执行 novel_seed_writing_state。");
  if (state.rebuild && input.targetChapterId !== state.rebuild.nextChapterId) {
    throw new NovelWritingStateRejectedError("状态重建期间只能为队列下一章生成 Context Pack。", {
      reason: "state_rebuild_out_of_order",
      chapterId: input.targetChapterId,
      nextAction: `改为目标章节 ${state.rebuild.nextChapterId}，并重新生成 Context Pack`,
    });
  }
  const workflowMode = input.workflowMode ?? "formal";
  const taskBriefRecord = state.chapterBriefs
    .filter((entry) => entry.chapterId === input.targetChapterId)
    .sort((left, right) => right.revision - left.revision)[0] ?? null;
  const declaredCharacterIds = taskBriefRecord?.requiredCharacterIds;
  if (workflowMode === "formal" && !taskBriefRecord) {
    throw new Error("正式 Context Pack 缺少目标章 chapter brief，无法证明写作任务与出场角色闭合。");
  }
  if (workflowMode === "formal" && declaredCharacterIds === undefined) {
    throw new Error("正式 Context Pack 的 chapter brief 必须声明 requiredCharacterIds；空数组表示 owner 明确确认本章无角色。");
  }
  const normalizedDeclared = [...(declaredCharacterIds ?? [])].sort((left, right) => left.localeCompare(right, "en"));
  const normalizedRequested = input.characterIds === undefined
    ? normalizedDeclared
    : [...input.characterIds].sort((left, right) => left.localeCompare(right, "en"));
  if (workflowMode === "formal" && input.characterIds !== undefined
    && JSON.stringify(normalizedRequested) !== JSON.stringify(normalizedDeclared)) {
    throw new Error("正式 Context Pack 的 characterIds 必须与 chapter brief.requiredCharacterIds 完全一致，禁止遗漏或额外注入角色。");
  }
  const entityIds = new Set(state.entities.map((entry) => entry.entityId));
  for (const characterId of normalizedRequested) {
    if (!entityIds.has(characterId)) throw new Error(`Context Pack 引用未知角色：${characterId}`);
  }
  const projection = projectNovelWritingState(snapshot, state, {
    targetChapterId: input.targetChapterId,
    cutoff: "before",
    characterIds: normalizedRequested,
  });
  const hardCanon = projection.temporal.hardCanon
    .filter((entry) => entry.visibility === "writer")
    .sort((left, right) => right.priority - left.priority || left.ruleId.localeCompare(right.ruleId, "en"));
  const taskBrief = projection.temporal.chapterBrief;
  const mandatoryCost = narrativeCharacterCost(hardCanon) + narrativeCharacterCost(taskBrief);
  if (mandatoryCost > maxCharacters) {
    throw new Error(`Context Pack 2.0 预算不足：硬正典与写作任务至少需要 ${mandatoryCost} 字符，禁止静默丢失。`);
  }
  const budget = {
    maximum: maxCharacters,
    used: mandatoryCost,
    omitted: [] as Array<{ section: string; count: number }>,
  };
  const sections = {
    hardCanon,
    taskBrief,
    entities: [] as typeof projection.temporal.entities,
    characterProfiles: [] as typeof projection.temporal.characterProfiles,
    characterAppearances: [] as typeof projection.temporal.characterAppearances,
    characterStates: [] as typeof projection.temporal.characterStates,
    knowledge: [] as typeof projection.temporal.knowledge,
    relationships: [] as typeof projection.temporal.relationships,
    timeline: [] as typeof projection.temporal.timeline,
    foreshadowing: [] as typeof projection.temporal.foreshadowing,
  };
  const selectionTraceEntries: NovelContextPackSelectionTraceEntry[] = [];
  appendIncludedTrace(
    selectionTraceEntries,
    "hardCanon",
    hardCanon,
    "protected",
    "writer_visible_hard_canon_sorted_by_priority",
    "included:mandatory_writer_canon",
  );
  appendIncludedTrace(
    selectionTraceEntries,
    "taskBrief",
    taskBrief ? [taskBrief] : [],
    "protected",
    "exact_target_chapter_brief",
    "included:target_chapter_assignment",
  );
  const requestedCharacters = new Set(normalizedRequested);
  if (requestedCharacters.size) {
    for (const characterId of requestedCharacters) {
      const bundle = {
        entities: projection.temporal.entities.filter((entry) => entry.entityId === characterId),
        characterProfiles: projection.temporal.characterProfiles.filter((entry) => entry.entityId === characterId),
        characterAppearances: projection.temporal.characterAppearances.filter((entry) => entry.entityId === characterId),
        characterStates: projection.temporal.characterStates.filter((entry) => entry.entityId === characterId),
        knowledge: projection.temporal.knowledge.filter((entry) => entry.entityId === characterId),
        relationships: projection.temporal.relationships.filter((entry) =>
          entry.fromEntityId === characterId || entry.toEntityId === characterId),
      };
      if (workflowMode === "formal" && bundle.entities.length !== 1) {
        throw new Error(`正式 Context Pack 无法唯一解析目标角色 ${characterId} 的基础卡。`);
      }
      if (workflowMode === "formal" && bundle.characterStates.length !== 1) {
        throw new Error(`正式 Context Pack 缺少目标角色 ${characterId} 在截止章的动态状态。`);
      }
      if (workflowMode === "formal" && bundle.characterProfiles.length !== 1) {
        throw new NovelWritingStateRejectedError(`正式 Context Pack 缺少目标角色 ${characterId} 的结构化声口卡。`, {
          reason: "character_profile_missing",
          chapterId: input.targetChapterId,
          nextAction: `为 ${characterId} 提交 Story Bible character_profile，并由 human owner 接受后重新 prepare`,
        });
      }
      if (workflowMode === "formal" && bundle.characterAppearances.length !== 1) {
        throw new NovelWritingStateRejectedError(`正式 Context Pack 缺少目标角色 ${characterId} 的结构化外形卡。`, {
          reason: "character_appearance_missing",
          chapterId: input.targetChapterId,
          nextAction: `为 ${characterId} 提交 Story Bible character_appearance，并由 human owner 接受后重新 prepare`,
        });
      }
      const cost = narrativeCharacterCost(bundle);
      if (budget.used + cost > budget.maximum) {
        throw new Error(`Context Pack 2.0 预算不足以容纳目标角色 ${characterId} 的基础卡、动态状态与知情边界。`);
      }
      sections.entities.push(...bundle.entities);
      sections.characterProfiles.push(...bundle.characterProfiles);
      sections.characterAppearances.push(...bundle.characterAppearances);
      sections.characterStates.push(...bundle.characterStates);
      sections.knowledge.push(...bundle.knowledge);
      sections.relationships.push(...bundle.relationships);
      budget.used += cost;
      appendIncludedTrace(selectionTraceEntries, "entities", bundle.entities, "protected", "required_character_bundle", `included:required_character:${characterId}`);
      appendIncludedTrace(selectionTraceEntries, "characterProfiles", bundle.characterProfiles, "protected", "required_character_bundle", `included:required_character:${characterId}`);
      appendIncludedTrace(selectionTraceEntries, "characterAppearances", bundle.characterAppearances, "protected", "required_character_bundle", `included:required_character:${characterId}`);
      appendIncludedTrace(selectionTraceEntries, "characterStates", bundle.characterStates, "protected", "required_character_bundle", `included:required_character:${characterId}`);
      appendIncludedTrace(selectionTraceEntries, "knowledge", bundle.knowledge, "protected", "required_character_bundle", `included:required_character:${characterId}`);
      appendIncludedTrace(selectionTraceEntries, "relationships", bundle.relationships, "protected", "required_character_bundle", `included:required_character:${characterId}`);
    }
  } else if (workflowMode === "rehearsal") {
    pushBudgeted(sections.entities, projection.temporal.entities, budget, "entities", selectionTraceEntries);
    pushBudgeted(sections.characterProfiles, projection.temporal.characterProfiles, budget, "characterProfiles", selectionTraceEntries);
    pushBudgeted(sections.characterAppearances, projection.temporal.characterAppearances, budget, "characterAppearances", selectionTraceEntries);
    pushBudgeted(sections.characterStates, projection.temporal.characterStates, budget, "characterStates", selectionTraceEntries);
    pushBudgeted(sections.knowledge, projection.temporal.knowledge, budget, "knowledge", selectionTraceEntries);
    pushBudgeted(sections.relationships, projection.temporal.relationships, budget, "relationships", selectionTraceEntries);
  }
  const criticalMemoryCost = narrativeCharacterCost(projection.temporal.timeline)
    + narrativeCharacterCost(projection.temporal.foreshadowing);
  const minimumCriticalMemoryCharacters = budget.used + criticalMemoryCost;
  if (workflowMode === "formal") {
    if (minimumCriticalMemoryCharacters > budget.maximum) {
      const omittedSections = [
        ...(projection.temporal.timeline.length ? [{ section: "timeline", count: projection.temporal.timeline.length }] : []),
        ...(projection.temporal.foreshadowing.length ? [{ section: "foreshadowing", count: projection.temporal.foreshadowing.length }] : []),
      ];
      const withinRetryLimit = minimumCriticalMemoryCharacters <= NOVEL_AGENT_MAX_CONTEXT_CHARACTERS;
      throw new NovelWritingStateRejectedError("正式 Context Pack 关键记忆预算不足；timeline/foreshadowing 禁止被裁剪后继续写章。", {
        reason: "critical_memory_budget_insufficient",
        chapterId: input.targetChapterId,
        minimumCharacters: minimumCriticalMemoryCharacters,
        maximumAllowedCharacters: NOVEL_AGENT_MAX_CONTEXT_CHARACTERS,
        omittedSections,
        nextAction: withinRetryLimit
          ? `将 maxCharacters 至少提高到 ${minimumCriticalMemoryCharacters} 后重新 prepare`
          : `关键记忆至少需要 ${minimumCriticalMemoryCharacters} 字符，已超过单包上限；须由 owner 先分片或收束时态记录`,
      });
    }
    sections.timeline.push(...projection.temporal.timeline);
    sections.foreshadowing.push(...projection.temporal.foreshadowing);
    budget.used = minimumCriticalMemoryCharacters;
    appendIncludedTrace(selectionTraceEntries, "timeline", projection.temporal.timeline, "protected", "formal_critical_memory_fail_on_omission", "included:critical_timeline_memory");
    appendIncludedTrace(selectionTraceEntries, "foreshadowing", projection.temporal.foreshadowing, "protected", "formal_critical_memory_fail_on_omission", "included:critical_foreshadowing_memory");
  } else {
    pushBudgeted(sections.timeline, projection.temporal.timeline, budget, "timeline", selectionTraceEntries);
    pushBudgeted(sections.foreshadowing, projection.temporal.foreshadowing, budget, "foreshadowing", selectionTraceEntries);
  }

  let legacy: Awaited<ReturnType<typeof buildLegacyContextPackAttempt>> = null;
  const remaining = maxCharacters - budget.used;
  if (cutoffChapterId && remaining > 0) {
    legacy = await buildLegacyContextPackAttempt(project, {
      query: input.query,
      chapterIds: input.chapterIds,
      cutoffChapterId,
      maxCharacters: remaining,
      maxSearchHits,
    }, remaining, maxSearchHits);
    if (!legacy) return null;
    budget.used += legacy.budget.usedCharacters;
    selectionTraceEntries.push(...legacy.selectionTraceEntries);
  }
  const referencedSourceIds = [...collectSourceIds(sections)].sort((left, right) => left.localeCompare(right, "en"));
  let sourceClosure: Awaited<ReturnType<typeof verifyNovelWritingSourceClosure>>;
  try {
    sourceClosure = await verifyNovelWritingSourceClosure(project.projectRoot, state, referencedSourceIds);
  } catch (error) {
    throw new NovelWritingStateRejectedError("正式写作来源对象或回执闭包复验失败。", {
      reason: "writing_source_integrity_mismatch",
      chapterId: input.targetChapterId,
      nextAction: `由 human owner 检查受管 writing source receipt/CAS：${error instanceof Error ? error.message : String(error)}`,
      requiresHumanOwner: true,
    });
  }
  const latest = await repository.snapshot();
  const latestState = await loadNovelWritingState(project.projectRoot, snapshot.workspace.projectId);
  if (latest.chapters?.revision !== snapshot.chapters.revision
    || latestState?.revision !== state.revision
    || latestState.fingerprint !== state.fingerprint) return null;
  const excerpts = legacy?.excerpts ?? [];
  const skippedExternalChanges = legacy?.skippedExternalChanges ?? [];
  const semantic = {
    contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
    contextPackVersion: 2 as const,
    kind: "novel-context-pack" as const,
    project,
    workspaceRevision: snapshot.workspace.revision,
    manifestRevision: snapshot.chapters.revision,
    writingState: {
      revision: state.revision,
      fingerprint: state.fingerprint,
      baselineStatus: state.baselineStatus,
      sourceTreeAggregateSha256: state.sourceTreeAggregateSha256,
    },
    selection: {
      taskType: input.taskType ?? "continue_chapter",
      workflowMode,
      targetChapterId: input.targetChapterId,
      cutoffChapterId,
      cutoffInclusive: true,
      characterIds: normalizedRequested,
      query: input.query,
      chapterIds: input.chapterIds ?? [],
      maxSearchHits,
    },
    sections,
    budget: {
      maximumCharacters: maxCharacters,
      usedCharacters: budget.used,
      reservedCharacters: mandatoryCost,
      criticalMemory: {
        policy: workflowMode === "formal" ? "fail_on_omission" as const : "report_omission" as const,
        sections: ["timeline", "foreshadowing"] as const,
        requiredCharacters: workflowMode === "formal" ? criticalMemoryCost : 0,
      },
      truncated: budget.omitted.length > 0
        || Boolean(legacy?.budget.truncated),
      omitted: budget.omitted,
    },
    excerpts,
    skippedExternalChanges,
    dependencies: {
      sourceClosure: {
        checkedSourceIds: sourceClosure.checkedSourceIds,
        provenance: sourceClosure.legacyInlineSourceIds.length ? "mixed_or_legacy_inline" as const : "receipt_bound" as const,
        legacyInlineSourceIds: sourceClosure.legacyInlineSourceIds,
      },
      sourceObjects: sourceClosure.checkedSourceIds.map((sourceId) => state.sources.find((source) => source.sourceId === sourceId)!)
        .map((source) => ({
        sourceId: source.sourceId,
        sha256: source.sha256,
        objectRelativePath: source.objectRelativePath,
        receiptId: source.receiptId,
        receiptFingerprint: source.receiptFingerprint,
      })),
    },
  };
  const contextPackFingerprint = fingerprint(semantic);
  const taskType = semantic.selection.taskType;
  const partition = (
    partitionId: NovelContextPackSelectionTrace["budget"]["partitions"][number]["partitionId"],
    sectionsForPartition: NovelContextPackTraceSection[],
    protection: "protected" | "compressible",
    policy: NovelContextPackSelectionTrace["budget"]["partitions"][number]["policy"],
  ): NovelContextPackSelectionTrace["budget"]["partitions"][number] => {
    const entries = selectionTraceEntries.filter((entry) => sectionsForPartition.includes(entry.section));
    return {
      partitionId,
      protection,
      policy,
      usedCharacters: entries
        .filter((entry) => entry.disposition === "included")
        .reduce((total, entry) => total + entry.characterCost, 0),
      includedItems: entries.filter((entry) => entry.disposition === "included").length,
      omittedItems: entries.filter((entry) => entry.disposition === "omitted").length,
    };
  };
  const selectionTrace: NovelContextPackSelectionTrace = {
    schemaVersion: 1,
    kind: "novel-context-pack-selection-trace",
    targetChapterId: input.targetChapterId,
    cutoffChapterId,
    taskType,
    workflowMode,
    requiredCharacterIds: normalizedRequested,
    budget: {
      maximumCharacters: maxCharacters,
      usedCharacters: budget.used,
      reservedCharacters: mandatoryCost,
      partitions: [
        partition("hard_requirements", ["hardCanon", "taskBrief"], "protected", "always_include"),
        partition(
          "required_cast",
          ["entities", "characterProfiles", "characterAppearances", "characterStates", "knowledge", "relationships"],
          workflowMode === "formal" ? "protected" : "compressible",
          workflowMode === "formal" ? "fail_on_omission" : "fit_remaining_budget",
        ),
        partition(
          "critical_memory",
          ["timeline", "foreshadowing"],
          workflowMode === "formal" ? "protected" : "compressible",
          workflowMode === "formal" ? "fail_on_omission" : "fit_remaining_budget",
        ),
        partition("recent_chapters", ["excerpts"], "compressible", "fit_remaining_budget"),
      ],
    },
    entries: selectionTraceEntries,
    policies: {
      chapterBrief: "exact_target_chapter",
      hardCanon: "writer_visible_only",
      futureChapters: "excluded_after_cutoff",
      authorOnlyCanon: "excluded_without_receipt_entry",
      absolutePaths: "never_persisted",
      uiRecomputation: "forbidden",
    },
  };
  return {
    ...semantic,
    fingerprint: contextPackFingerprint,
    selectionTrace,
    writePreflightInput: taskType === "review_chapter"
      ? null
      : {
        taskType,
        workflowMode,
        targetChapterId: input.targetChapterId,
        contextPackFingerprint,
        ...(input.query !== undefined ? { query: input.query } : {}),
        chapterIds: input.chapterIds ?? [],
        characterIds: normalizedRequested,
        maxCharacters,
        maxSearchHits,
      },
  };
}

async function buildNovelContextPackV2(
  project: NovelAgentProjectContext,
  input: BuildNovelContextPackInput & { targetChapterId: string },
  maxCharacters: number,
  maxSearchHits: number,
) {
  if (input.characterIds && new Set(input.characterIds).size !== input.characterIds.length) {
    throw new Error("characterIds 不得重复。");
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await buildNovelContextPackV2Attempt(project, input, maxCharacters, maxSearchHits);
    if (result) return result;
  }
  throw new Error("小说正文或写作状态在Context Pack 2.0组装期间持续变化，请稍后重试。");
}

export async function buildNovelContextPack(
  projectRoot: string | undefined,
  input: BuildNovelContextPackInput,
) {
  const project = await resolveNovelAgentProject(projectRoot);
  const maxCharacters = input.maxCharacters ?? NOVEL_AGENT_DEFAULT_CONTEXT_CHARACTERS;
  const maxSearchHits = input.maxSearchHits ?? 20;
  requireSafeIntegerInRange(maxCharacters, "maxCharacters", 256, NOVEL_AGENT_MAX_CONTEXT_CHARACTERS);
  requireSafeIntegerInRange(maxSearchHits, "maxSearchHits", 1, NOVEL_AGENT_MAX_CONTEXT_SEARCH_HITS);
  if (input.query !== undefined && input.query.trim().length === 0) {
    throw new Error("query 为空时请省略该字段。");
  }
  if (input.targetChapterId || input.taskType || input.characterIds) {
    if (!input.targetChapterId) throw new Error("Context Pack 2.0 需要 targetChapterId。");
    return buildNovelContextPackV2(project, { ...input, targetChapterId: input.targetChapterId }, maxCharacters, maxSearchHits);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await buildLegacyContextPackAttempt(project, input, maxCharacters, maxSearchHits);
    if (result) {
      const { selectionTraceEntries: _selectionTraceEntries, ...publicPack } = result;
      return publicPack;
    }
  }
  throw new Error("小说正文在上下文组装期间持续发生变化，请稍后重试。");
}

export async function getNovelWritingState(
  projectRoot: string | undefined,
  input: {
    targetChapterId: string;
    cutoff: "before" | "through";
    characterIds?: string[];
  },
) {
  const project = await resolveNovelAgentProject(projectRoot);
  const snapshot = await new NovelRepository(project.projectRoot).snapshot();
  const projected = await getNovelWritingStateProjection(project.projectRoot, snapshot, input);
  return {
    contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
    project,
    ...projected,
  };
}

export async function listNovelWritingSourceReceipts(projectRoot: string | undefined) {
  const project = await resolveNovelAgentProject(projectRoot);
  const receipts = await listNovelWritingSourceSnapshotReceipts(project.projectRoot, project.projectId);
  return {
    contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
    project,
    receipts: receipts.map((receipt) => ({
      receiptId: receipt.receiptId,
      fingerprint: receipt.fingerprint,
      sourceDisplayName: receipt.sourceDisplayName,
      sourceTreeAggregateSha256: receipt.sourceTreeAggregateSha256,
      objectCount: receipt.objects.length,
      objects: receipt.objects.map((object) => ({
        sourceRelativePath: object.sourceRelativePath,
        kind: object.kind,
        rawSha256: object.rawSha256,
        rawByteLength: object.rawByteLength,
        textSha256: object.textSha256,
        textByteLength: object.textByteLength,
        suggestedSourceId: object.suggestedSourceId,
        transform: object.transform,
      })),
      committedAt: receipt.committedAt,
    })),
  };
}

export async function compareNovelWritingSourceReceipts(
  projectRoot: string | undefined,
  input: { baseReceiptId: string; currentReceiptId: string },
) {
  const project = await resolveNovelAgentProject(projectRoot);
  const [base, current] = await Promise.all([
    loadNovelWritingSourceSnapshotReceipt(project.projectRoot, input.baseReceiptId, project.projectId),
    loadNovelWritingSourceSnapshotReceipt(project.projectRoot, input.currentReceiptId, project.projectId),
  ]);
  if (!base || !current) throw new Error("待比较的 writing source receipt 不存在或不属于当前工程。");
  const baseByPath = new Map(base.objects.map((object) => [object.sourceRelativePath, object]));
  const currentByPath = new Map(current.objects.map((object) => [object.sourceRelativePath, object]));
  const unchanged = [] as Array<{ sourceRelativePath: string; sourceId: string; textSha256: string }>;
  const modified = [] as Array<{
    sourceRelativePath: string;
    baseSourceId: string;
    currentSourceId: string;
    baseTextSha256: string;
    currentTextSha256: string;
  }>;
  const removed = base.objects.filter((object) => !currentByPath.has(object.sourceRelativePath));
  const added = current.objects.filter((object) => !baseByPath.has(object.sourceRelativePath));
  for (const object of base.objects) {
    const next = currentByPath.get(object.sourceRelativePath);
    if (!next) continue;
    if (object.rawSha256 === next.rawSha256 && object.textSha256 === next.textSha256) {
      unchanged.push({
        sourceRelativePath: object.sourceRelativePath,
        sourceId: next.suggestedSourceId,
        textSha256: next.textSha256,
      });
    } else {
      modified.push({
        sourceRelativePath: object.sourceRelativePath,
        baseSourceId: object.suggestedSourceId,
        currentSourceId: next.suggestedSourceId,
        baseTextSha256: object.textSha256,
        currentTextSha256: next.textSha256,
      });
    }
  }
  const renamed = [] as Array<{
    fromSourceRelativePath: string;
    toSourceRelativePath: string;
    baseSourceId: string;
    currentSourceId: string;
    textSha256: string;
    detection: "unique_text_identity";
  }>;
  const pairedRemoved = new Set<string>();
  const pairedAdded = new Set<string>();
  const allTextHashes = [...new Set([...removed, ...added].map((object) => object.textSha256))]
    .sort((left, right) => left.localeCompare(right, "en"));
  for (const textSha256 of allTextHashes) {
    const from = removed.filter((object) => object.textSha256 === textSha256);
    const to = added.filter((object) => object.textSha256 === textSha256);
    if (from.length !== 1 || to.length !== 1) continue;
    pairedRemoved.add(from[0]!.sourceRelativePath);
    pairedAdded.add(to[0]!.sourceRelativePath);
    renamed.push({
      fromSourceRelativePath: from[0]!.sourceRelativePath,
      toSourceRelativePath: to[0]!.sourceRelativePath,
      baseSourceId: from[0]!.suggestedSourceId,
      currentSourceId: to[0]!.suggestedSourceId,
      textSha256,
      detection: "unique_text_identity",
    });
  }
  const deleted = removed.filter((object) => !pairedRemoved.has(object.sourceRelativePath)).map((object) => ({
    sourceRelativePath: object.sourceRelativePath,
    sourceId: object.suggestedSourceId,
    textSha256: object.textSha256,
  }));
  const untracked = added.filter((object) => !pairedAdded.has(object.sourceRelativePath)).map((object) => ({
    sourceRelativePath: object.sourceRelativePath,
    suggestedSourceId: object.suggestedSourceId,
    textSha256: object.textSha256,
  }));
  for (const entries of [unchanged, modified, renamed, deleted, untracked]) {
    entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  }
  const changes = modified.length + renamed.length + deleted.length + untracked.length;
  const semantic = {
    contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
    kind: "novel-writing-source-receipt-diff" as const,
    project,
    baseReceipt: { receiptId: base.receiptId, fingerprint: base.fingerprint },
    currentReceipt: { receiptId: current.receiptId, fingerprint: current.fingerprint },
    status: changes ? "reconciliation_required" as const : "clean" as const,
    summary: {
      unchanged: unchanged.length,
      modified: modified.length,
      renamed: renamed.length,
      deleted: deleted.length,
      untracked: untracked.length,
    },
    diff: { unchanged, modified, renamed, deleted, untracked },
    nextTools: changes ? [{
      tool: "execute_command",
      argsMode: "partial" as const,
      args: { request: { command: "novel_stage_story_bible_candidate" } },
      requiredArgs: ["projectRoot", "requestId", "idempotencyKey", "request.payload"],
      purpose: "只绑定 owner 选中的新 receipt source，并把相应正典修订或 no-semantic-change 说明交给 human owner 裁决；删除项禁止自动移除",
      requiresHumanOwner: true,
    }] : [],
  };
  return { ...semantic, fingerprint: fingerprint(semantic) };
}

export async function planNovelStateRebuild(
  projectRoot: string | undefined,
  input: { targetChapterId: string },
) {
  const project = await resolveNovelAgentProject(projectRoot);
  const snapshot = await new NovelRepository(project.projectRoot).snapshot();
  const plan = await planNovelWritingStateRebuildCore(project.projectRoot, snapshot, input.targetChapterId);
  return {
    contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
    project,
    ...plan,
  };
}

export async function getNovelStateRebuildStatus(projectRoot?: string) {
  const project = await resolveNovelAgentProject(projectRoot);
  const snapshot = await new NovelRepository(project.projectRoot).snapshot();
  return {
    contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
    project,
    ...(await getNovelWritingStateHistoryStatus(
      project.projectRoot,
      snapshot.workspace.projectId,
    )),
  };
}

export async function probeNovelChapterConsistency(
  projectRoot: string | undefined,
  input: ProbeNovelChapterConsistencyInput,
) {
  const project = await resolveNovelAgentProject(projectRoot);
  const snapshot = await new NovelRepository(project.projectRoot).snapshot();
  const probe = await probeNovelChapterConsistencyCore(project.projectRoot, snapshot, input);
  return {
    contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
    project,
    ...probe,
  };
}

export async function doctorNovelAgent(
  projectRoot: string | undefined,
  input: DoctorNovelAgentInput = {},
) {
  const project = await resolveNovelAgentProject(projectRoot);
  const repository = new NovelRepository(project.projectRoot);
  const snapshot = await repository.snapshot();
  if (!snapshot.chapters) throw new Error("doctor_novel_agent 只支持 managed manuscript。");
  const ordered = orderedNovelChapters(snapshot.chapters);
  const workflowMode = input.workflowMode ?? "formal";
  const blockers: Array<{
    code: string;
    message: string;
    nextTools: Array<{
      tool: string;
      argsMode: "partial";
      args: Record<string, unknown>;
      requiredArgs: string[];
      purpose: string;
      requiresHumanOwner?: boolean;
    }>;
  }> = [];
  const addBlocker = (
    code: string,
    message: string,
    nextTools: typeof blockers[number]["nextTools"],
  ): void => {
    if (!blockers.some((entry) => entry.code === code)) blockers.push({ code, message, nextTools });
  };

  let historyStatus: Awaited<ReturnType<typeof getNovelWritingStateHistoryStatus>> | null = null;
  let state = null as Awaited<ReturnType<typeof loadNovelWritingState>>;
  let historyBlocked = false;
  try {
    historyStatus = await getNovelWritingStateHistoryStatus(
      project.projectRoot,
      snapshot.workspace.projectId,
      { verificationMode: "head" },
    );
    if (historyStatus.recoveryRequired) {
      historyBlocked = true;
      addBlocker(
        "state_history_recovery_required",
        "Writing-state 存在已提交但未收敛的 operation；在读取 pack 或获取租约前必须确定性恢复。",
        historyStatus.nextTools,
      );
      state = await loadNovelPublicWritingState(project.projectRoot, snapshot.workspace.projectId);
    } else if (historyStatus.initialized && !historyStatus.healthy) {
      historyBlocked = true;
      addBlocker(
        "state_history_integrity_mismatch",
        `Writing-state history 闭包损坏：${historyStatus.issue ?? "unknown_history_issue"}`,
        historyStatus.nextTools.map((entry) => ({ ...entry, requiresHumanOwner: true })),
      );
      state = await loadNovelPublicWritingState(project.projectRoot, snapshot.workspace.projectId);
    } else {
      state = await loadNovelWritingState(project.projectRoot, snapshot.workspace.projectId);
    }
  } catch (error) {
    historyBlocked = true;
    addBlocker("state_history_integrity_mismatch", `Writing-state history 无法完成只读复验：${error instanceof Error ? error.message : String(error)}`, [{
      tool: "get_novel_state_rebuild_status",
      argsMode: "partial",
      args: { projectRoot: project.projectRoot },
      requiredArgs: [],
      purpose: "由 human owner 检查受管 control/event/checkpoint/shadow/operation 工件；禁止自动覆盖",
      requiresHumanOwner: true,
    }]);
  }

  let targetChapterId = input.targetChapterId ?? null;
  if (!state) {
    targetChapterId ??= ordered[0]?.chapterId ?? null;
    if (!historyBlocked) {
      addBlocker("writing_state_missing", "工程尚未初始化 Writing OS 状态。", [{
        tool: "execute_command",
        argsMode: "partial",
        args: { request: { command: "novel_seed_writing_state" } },
        requiredArgs: ["projectRoot", "requestId", "idempotencyKey", "request.payload"],
        purpose: "由 human owner 导入并裁决正典、角色、动态状态与首个 completion",
        requiresHumanOwner: true,
      }]);
    }
  } else if (!targetChapterId) {
    if (state.rebuild) targetChapterId = state.rebuild.nextChapterId;
    else {
      const currentIndex = ordered.findIndex((chapter) => chapter.chapterId === state.currentThroughChapterId);
      targetChapterId = currentIndex >= 0 ? ordered[currentIndex + 1]?.chapterId ?? null : null;
    }
  }

  const target = targetChapterId ? ordered.find((chapter) => chapter.chapterId === targetChapterId) ?? null : null;
  if (!target) {
    addBlocker("target_chapter_missing", targetChapterId
      ? "指定 targetChapterId 不存在。"
      : "当前状态之后没有待写章节。", [{
      tool: "execute_command",
      argsMode: "partial",
      args: { request: { command: "novel_create_chapter" } },
      requiredArgs: ["projectRoot", "requestId", "idempotencyKey", "request.payload"],
      purpose: "由 human owner/UI 创建明确的下一章后重新 doctor",
      requiresHumanOwner: true,
    }]);
  }

  let requiredCharacterIds: string[] = [];
  let lease: Awaited<ReturnType<typeof getNovelChapterWriteLeaseStatus>> | null = null;
  let sourceClosure: Awaited<ReturnType<typeof verifyNovelWritingSourceClosure>> | null = null;
  if (state && target && !historyBlocked) {
    if (workflowMode === "formal" && state.baselineStatus !== "locked") {
      addBlocker("baseline_not_locked", "正式写章要求 baselineStatus=locked。", [{
        tool: "execute_command",
        argsMode: "partial",
        args: { request: { command: "novel_stage_story_bible_candidate" } },
        requiredArgs: ["projectRoot", "requestId", "idempotencyKey", "request.payload"],
        purpose: "由正典 owner 完成资料裁决后锁定正式基线；否则仅使用 rehearsal",
        requiresHumanOwner: true,
      }]);
    }
    if (state.rebuild && target.chapterId !== state.rebuild.nextChapterId) {
      addBlocker("state_rebuild_out_of_order", `状态重建期间只能处理 ${state.rebuild.nextChapterId}。`, [{
        tool: "doctor_novel_agent",
        argsMode: "partial",
        args: { projectRoot: project.projectRoot, targetChapterId: state.rebuild.nextChapterId, workflowMode },
        requiredArgs: [],
        purpose: "切换到 rebuild queue 的精确下一章",
      }]);
    }
    const projection = projectNovelWritingState(snapshot, state, {
      targetChapterId: target.chapterId,
      cutoff: "before",
    });
    try {
      sourceClosure = await verifyNovelWritingSourceClosure(
        project.projectRoot,
        state,
        [...collectSourceIds(projection.temporal)],
      );
    } catch (error) {
      addBlocker("writing_source_integrity_mismatch", `Writing source receipt/CAS 闭包损坏：${error instanceof Error ? error.message : String(error)}`, [{
        tool: "list_novel_writing_source_receipts",
        argsMode: "partial",
        args: { projectRoot: project.projectRoot },
        requiredArgs: [],
        purpose: "由 human owner 对账 receipt、source binding 与受管 CAS；禁止回读外部目录静默补救",
        requiresHumanOwner: true,
      }]);
    }
    const brief = projection.temporal.chapterBrief;
    if (!brief || brief.requiredCharacterIds === undefined) {
      addBlocker("required_cast_missing", "目标章缺少 chapter brief 或 requiredCharacterIds。", [{
        tool: "execute_command",
        argsMode: "partial",
        args: { request: { command: "novel_stage_story_bible_candidate" } },
        requiredArgs: ["projectRoot", "requestId", "idempotencyKey", "request.payload"],
        purpose: "提交目标章 chapter_brief 并由 human owner 接受",
      }]);
    } else {
      requiredCharacterIds = [...brief.requiredCharacterIds].sort((left, right) => left.localeCompare(right, "en"));
      const entities = new Set(projection.temporal.entities.map((entry) => entry.entityId));
      const profiles = new Set(projection.temporal.characterProfiles.map((entry) => entry.entityId));
      const appearances = new Set(projection.temporal.characterAppearances.map((entry) => entry.entityId));
      const dynamicStates = new Set(projection.temporal.characterStates.map((entry) => entry.entityId));
      const missingEntities = requiredCharacterIds.filter((entityId) => !entities.has(entityId));
      const missingProfiles = requiredCharacterIds.filter((entityId) => !profiles.has(entityId));
      const missingAppearances = requiredCharacterIds.filter((entityId) => !appearances.has(entityId));
      const missingDynamicStates = requiredCharacterIds.filter((entityId) => !dynamicStates.has(entityId));
      if (missingEntities.length) addBlocker("required_cast_entity_missing", `required cast 缺少基础卡：${missingEntities.join("、")}`, [{
        tool: "execute_command", argsMode: "partial", args: { request: { command: "novel_stage_story_bible_candidate" } },
        requiredArgs: ["projectRoot", "requestId", "idempotencyKey", "request.payload"], purpose: "补齐 entity 并由 owner 接受",
      }]);
      if (workflowMode === "formal" && missingProfiles.length) addBlocker("character_profile_missing", `required cast 缺少结构化声口卡：${missingProfiles.join("、")}`, [{
        tool: "execute_command", argsMode: "partial", args: { request: { command: "novel_stage_story_bible_candidate" } },
        requiredArgs: ["projectRoot", "requestId", "idempotencyKey", "request.payload"], purpose: "补齐 character_profile 并由 owner 接受",
      }]);
      if (workflowMode === "formal" && missingAppearances.length) addBlocker("character_appearance_missing", `required cast 缺少结构化外形卡：${missingAppearances.join("、")}`, [{
        tool: "execute_command", argsMode: "partial", args: { request: { command: "novel_stage_story_bible_candidate" } },
        requiredArgs: ["projectRoot", "requestId", "idempotencyKey", "request.payload"], purpose: "补齐 character_appearance 并由 owner 接受",
      }]);
      if (workflowMode === "formal" && missingDynamicStates.length) addBlocker("character_state_missing", `required cast 缺少截止章动态状态：${missingDynamicStates.join("、")}`, [{
        tool: "execute_command", argsMode: "partial", args: { request: { command: "novel_stage_chapter_state_candidate" } },
        requiredArgs: ["projectRoot", "requestId", "idempotencyKey", "request.payload"], purpose: "补齐上一章动态状态并由 owner 接受",
        requiresHumanOwner: true,
      }]);
    }
    if (!projection.completion.readyForTargetChapter) {
      addBlocker("state_commit_required", `上一章 ${projection.completion.requiredChapterId ?? "起始章"} 缺少与当前正文身份一致的状态提交。`, [{
        tool: "execute_command",
        argsMode: "partial",
        args: { request: { command: "novel_stage_chapter_state_candidate", payload: { chapterId: projection.completion.requiredChapterId } } },
        requiredArgs: ["projectRoot", "requestId", "idempotencyKey", "request.payload"],
        purpose: "提交上一章状态候选并由 human owner 接受",
        requiresHumanOwner: true,
      }]);
    }
    lease = await getNovelChapterWriteLeaseStatus(project.projectRoot, snapshot, target.chapterId);
    if (lease.held) {
      addBlocker("chapter_write_lease_conflict", `目标章已有活动写租约 ${lease.leaseId}，有效至 ${lease.expiresAt}。`, [{
        tool: "doctor_novel_agent",
        argsMode: "partial",
        args: { projectRoot: project.projectRoot, targetChapterId: target.chapterId, workflowMode },
        requiredArgs: [],
        purpose: "等待当前租约释放/到期后重新检查；不要并发生成第二份正文",
      }]);
    }
  }

  blockers.sort((left, right) => left.code.localeCompare(right.code, "en"));
  const nextTools = blockers.flatMap((entry) => entry.nextTools);
  if (!blockers.length && target) {
    nextTools.push({
      tool: "prepare_novel_chapter_write",
      argsMode: "partial",
      args: { projectRoot: project.projectRoot, targetChapterId: target.chapterId, workflowMode },
      requiredArgs: ["attribution"],
      purpose: "获取 Context Pack 2.0、preflight 与唯一章级写租约",
    });
  }
  const semantic = {
    contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
    kind: "novel-agent-doctor" as const,
    readyForPrepare: blockers.length === 0 && Boolean(target),
    project,
    workflowMode,
    targetChapter: target ? {
      chapterId: target.chapterId,
      revision: target.revision,
      sha256: target.sha256,
      title: target.title,
    } : null,
    writingState: state ? {
      revision: state.revision,
      fingerprint: state.fingerprint,
      baselineStatus: state.baselineStatus,
      currentThroughChapterId: state.currentThroughChapterId,
      rebuild: state.rebuild ? {
        rebuildId: state.rebuild.rebuildId,
        nextChapterId: state.rebuild.nextChapterId,
        remainingChapters: state.rebuild.pendingChapterIds.length,
      } : null,
    } : null,
    writingStateHistory: historyStatus,
    requiredCharacterIds,
    lease,
    sourceClosure: sourceClosure ? {
      ...sourceClosure,
      provenance: sourceClosure.legacyInlineSourceIds.length ? "mixed_or_legacy_inline" as const : "receipt_bound" as const,
    } : null,
    blockers,
    nextTools,
    roleContract: {
      agent_writer: ["doctor", "prepare", "novel_save_chapter_with_lease", "stage_state_candidate", "probe"],
      agent_reviewer: ["read_scoped_context", "probe", "attach_review_ticket", "never_write_chapter_body"],
      human_owner: ["seed", "accept_or_reject_candidates", "story_bible_changes", "invalidate_and_rebuild"],
    },
    safeWorkflow: [
      "doctor_novel_agent",
      "prepare_novel_chapter_write",
      "execute_command:novel_save_chapter",
      "execute_command:novel_stage_chapter_state_candidate",
      "human_owner:novel_review_chapter_state_candidate",
      "probe_novel_chapter_consistency",
      "doctor_novel_agent:next_chapter",
    ],
  };
  return { ...semantic, fingerprint: fingerprint(semantic) };
}

export async function preflightNovelChapterWrite(
  projectRoot: string | undefined,
  input: PreflightNovelChapterWriteInput,
) {
  const project = await resolveNovelAgentProject(projectRoot);
  const maxCharacters = input.maxCharacters ?? NOVEL_AGENT_DEFAULT_CONTEXT_CHARACTERS;
  const maxSearchHits = input.maxSearchHits ?? 20;
  requireSafeIntegerInRange(maxCharacters, "maxCharacters", 256, NOVEL_AGENT_MAX_CONTEXT_CHARACTERS);
  requireSafeIntegerInRange(maxSearchHits, "maxSearchHits", 1, NOVEL_AGENT_MAX_CONTEXT_SEARCH_HITS);
  const pack = await buildNovelContextPack(project.projectRoot, {
    taskType: input.taskType ?? "continue_chapter",
    targetChapterId: input.targetChapterId,
    query: input.query,
    chapterIds: input.chapterIds,
    characterIds: input.characterIds,
    maxCharacters,
    maxSearchHits,
    workflowMode: input.workflowMode,
  });
  const snapshot = await new NovelRepository(project.projectRoot).snapshot();
  const state = await loadNovelWritingState(project.projectRoot, snapshot.workspace.projectId);
  if (!state) throw new Error("写前preflight需要先执行 novel_seed_writing_state。");
  const current = deriveNovelWritePreflight(snapshot, state, {
    targetChapterId: input.targetChapterId,
    contextPackFingerprint: pack.fingerprint,
    characterIds: input.characterIds,
    workflowMode: input.workflowMode,
  });
  if (pack.fingerprint !== input.contextPackFingerprint) {
    return {
      ...current,
      ready: false as const,
      contextPackFingerprint: input.contextPackFingerprint,
      currentContextPackFingerprint: pack.fingerprint,
      currentWritePreflightInput: "writePreflightInput" in pack ? pack.writePreflightInput : null,
      blockers: [{
        code: "context_preflight_stale" as const,
        chapterId: input.targetChapterId,
        message: "提交的context pack fingerprint已过期或与当前组包参数不一致。",
        nextAction: "使用currentContextPackFingerprint对应的新pack重新preflight",
      }, ...current.blockers],
    };
  }
  return current;
}

export async function prepareNovelChapterWrite(
  projectRoot: string | undefined,
  input: PrepareNovelChapterWriteInput,
) {
  const project = await resolveNovelAgentProject(projectRoot);
  const workflowMode = input.workflowMode ?? "formal";
  const taskType = input.taskType ?? "continue_chapter";
  const maxCharacters = input.maxCharacters ?? NOVEL_AGENT_DEFAULT_CONTEXT_CHARACTERS;
  const maxSearchHits = input.maxSearchHits ?? 20;
  const pack = await buildNovelContextPack(project.projectRoot, {
    taskType,
    targetChapterId: input.targetChapterId,
    query: input.query,
    chapterIds: input.chapterIds,
    characterIds: input.characterIds,
    maxCharacters,
    maxSearchHits,
    workflowMode,
  });
  if (!("writePreflightInput" in pack) || !pack.writePreflightInput) {
    throw new Error("prepare_novel_chapter_write 只接受可写的 Context Pack 2.0 taskType。");
  }
  const preflight = await preflightNovelChapterWrite(project.projectRoot, {
    ...pack.writePreflightInput,
    contextPackFingerprint: pack.fingerprint,
  });
  if (!preflight.ready) {
    return {
      contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
      kind: "novel-chapter-write-preparation" as const,
      ready: false as const,
      project,
      pack,
      preflight,
      lease: null,
      nextTools: preflight.blockers.map((blocker) => ({
        tool: blocker.code === "state_rebuild_out_of_order" ? "get_novel_writing_state" : "execute_command",
        argsMode: "partial" as const,
        args: { projectRoot: project.projectRoot, targetChapterId: blocker.chapterId ?? input.targetChapterId },
        purpose: blocker.nextAction,
      })),
    };
  }
  if (!("selectionTrace" in pack)) {
    throw new Error("prepare_novel_chapter_write 缺少 Context Pack 2.0 selection trace。");
  }
  const receiptNextTools = [{
    tool: "execute_command",
    purpose: "主笔生成正文后使用当前租约、pack 与 preflight 身份执行 novel_save_chapter",
  }];
  const receiptSemantic: Omit<NovelContextPackReceipt, "fingerprint"> = {
    schemaVersion: 1,
    kind: "novel-context-pack-receipt",
    targetChapter: preflight.targetChapter,
    cutoffChapterId: preflight.cutoffChapterId,
    manifestRevision: preflight.manifestRevision,
    writingStateRevision: preflight.writingStateRevision,
    writingStateFingerprint: preflight.writingStateFingerprint,
    contextPackFingerprint: pack.fingerprint,
    preflightId: preflight.preflightId,
    ready: true,
    nextTools: receiptNextTools,
    selectionTrace: pack.selectionTrace,
  };
  const contextPackReceipt: NovelContextPackReceipt = {
    ...receiptSemantic,
    fingerprint: fingerprint(receiptSemantic),
  };
  const repository = new NovelRepository(project.projectRoot);
  const leaseResult = await repository.acquireChapterWriteLease({
    targetChapterId: input.targetChapterId,
    contextPackFingerprint: pack.fingerprint,
    preflightId: preflight.preflightId,
    characterIds: pack.selection.characterIds,
    workflowMode,
    attribution: input.attribution,
    ttlSeconds: input.ttlSeconds ?? 900,
    contextPackReceipt,
  });
  const snapshot = await repository.snapshot();
  const target = snapshot.chapters?.chapters.find((chapter) => chapter.chapterId === input.targetChapterId);
  if (!target) throw new Error("prepare 完成后目标章节身份丢失。");
  const aiWriteContext = {
    preflightId: preflight.preflightId,
    contextPackFingerprint: pack.fingerprint,
    workflowMode,
    leaseId: leaseResult.lease.leaseId,
    leaseFence: leaseResult.lease.fence,
    actorFingerprint: leaseResult.actorFingerprint,
  };
  return {
    contractVersion: NOVEL_AGENT_CONTRACT_VERSION,
    kind: "novel-chapter-write-preparation" as const,
    ready: true as const,
    project,
    pack,
    preflight,
    lease: leaseResult.lease,
    leaseToken: leaseResult.leaseToken,
    attribution: input.attribution,
    aiWriteContext,
    nextTools: [{
      tool: "execute_command",
      argsMode: "partial" as const,
      args: {
        projectRoot: project.projectRoot,
        novelWriteLeaseToken: leaseResult.leaseToken,
        novelActorAttribution: input.attribution,
        request: {
          command: "novel_save_chapter",
          payload: {
            chapterId: target.chapterId,
            expectedRevision: target.revision,
            expectedSha256: target.sha256,
            aiWriteContext,
          },
        },
      },
      requiredArgs: ["requestId", "idempotencyKey", "request.payload.content"],
      purpose: "主笔生成正文后补齐 content 与幂等身份，再原样保存；不得改写 lease/preflight 字段",
    }],
  };
}
