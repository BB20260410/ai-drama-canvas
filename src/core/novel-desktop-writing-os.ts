import { createHash, randomUUID } from "node:crypto";
import { executeIdempotentCommand } from "./command-bus.js";
import { withNovelAgent } from "./novel-agent-lazy.js";
import {
  probeNovelChapterConsistencyCore,
  type NovelChapterConsistencyProbe,
} from "./novel-consistency-probe.js";
import {
  NovelRepository,
  orderedNovelChapters,
} from "./novel-manuscript.js";
import type {
  NovelAnyChapterStateCandidate,
  NovelChapterStateDelta,
  NovelChapterStateDecision,
  NovelCharacterDynamicFields,
  NovelContextPackReceipt,
  NovelWritingStateDocument,
  NovelWritingWorkflowMode,
} from "./novel-types.js";
import {
  listNovelPendingChapterStateCandidates,
  loadNovelWritingState,
  NovelWritingStateRejectedError,
  projectNovelWritingState,
} from "./novel-writing-state.js";

const MAX_PENDING_CANDIDATES = 200;
const MAX_DIFF_CELL_CHARACTERS = 4_000;
const MAX_EVIDENCE_CHARACTERS = 1_000;

export interface NovelDesktopWritingDashboardInput {
  selectedChapterId?: string;
  workflowMode?: NovelWritingWorkflowMode;
}

export interface NovelDesktopStateCandidateReviewInput {
  candidateId: string;
  expectedCandidateFingerprint: string;
  expectedWritingStateRevision: number;
  expectedWritingStateFingerprint: string;
  decision: "accepted" | "rejected";
  note?: string;
}

export interface NovelDesktopCandidateDiffRow {
  field: string;
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

export interface NovelDesktopCandidateEvidence {
  evidenceId: string;
  startOffset: number;
  endOffset: number;
  excerpt: string;
}

export interface NovelDesktopCandidateChange {
  kind: "character_state" | "knowledge" | "relationship" | "timeline" | "foreshadowing";
  recordId: string;
  title: string;
  reason: string;
  rows: NovelDesktopCandidateDiffRow[];
  evidence: NovelDesktopCandidateEvidence[];
}

export interface NovelDesktopPendingStateCandidate {
  candidateId: string;
  fingerprint: string;
  schemaVersion: 1 | 2;
  chapter: {
    chapterId: string;
    title: string;
    revision: number;
    sha256: string;
  };
  baseWritingStateRevision: number;
  summary: string;
  changeKind: "delta" | "no_state_change" | "legacy";
  createdAt: string;
  reviewStatus: "ready" | "applied_recovery" | "legacy" | "stale_state" | "stale_chapter" | "out_of_order";
  reviewStatusMessage: string;
  allowedDecisions: Array<"accepted" | "rejected">;
  audit: {
    checkedCharacterIds: string[];
    checkedCharacterLabels: string[];
    checkedStateKinds: string[];
  };
  noStateChange: null | {
    reason: string;
    evidence: NovelDesktopCandidateEvidence[];
  };
  changes: NovelDesktopCandidateChange[];
}

export interface NovelDesktopWritingDashboard {
  schemaVersion: 1;
  kind: "novel-desktop-writing-dashboard";
  projectId: string;
  projectName: string;
  workflowMode: NovelWritingWorkflowMode;
  writeReadiness: {
    readyForPrepare: boolean;
    targetChapter: null | { chapterId: string; title: string; revision: number; sha256: string };
    requiredCharacterIds: string[];
    baselineStatus: "provisional" | "locked" | "missing";
    currentThroughChapterId: string | null;
    rebuild: null | { rebuildId: string; nextChapterId: string; remainingChapters: number };
    lease: {
      held: boolean;
      fence: number;
      leaseId?: string;
      expiresAt?: string;
      contextPackReceipt?: NovelContextPackReceipt;
    };
    blockers: Array<{ code: string; message: string }>;
    nextActions: Array<{ tool: string; purpose: string; requiresHumanOwner: boolean }>;
  };
  writingState: null | {
    revision: number;
    fingerprint: string;
    baselineStatus: "provisional" | "locked";
    currentThroughChapterId: string;
    updatedAt: string;
  };
  selectedChapter: null | {
    chapterId: string;
    title: string;
    revision: number;
    sha256: string;
    completion: {
      status: "committed" | "missing" | "stale" | "writing_state_missing";
      stateDebt: boolean;
      message: string;
      committedRevision?: number;
      committedSha256?: string;
      candidateId?: string;
      committedAt?: string;
    };
    probe: NovelChapterConsistencyProbe | null;
    probeError: null | { reason: string; message: string; nextAction?: string };
  };
  pendingCandidateCount: number;
  pendingCandidatesTruncated: boolean;
  pendingCandidates: NovelDesktopPendingStateCandidate[];
  limitations: string[];
  fingerprint: string;
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
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function clipped(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…（已截断）`;
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value)) return clipped(value.length ? value.map((entry) => String(entry)).join("、") : "—", MAX_DIFF_CELL_CHARACTERS);
  return clipped(String(value), MAX_DIFF_CELL_CHARACTERS);
}

function diffRows(
  fields: ReadonlyArray<{ key: string; label: string }>,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
): NovelDesktopCandidateDiffRow[] {
  return fields.map(({ key, label }) => {
    const beforeValue = displayValue(before?.[key]);
    const afterValue = displayValue(after[key]);
    return { field: key, label, before: beforeValue, after: afterValue, changed: beforeValue !== afterValue };
  });
}

const CHARACTER_FIELDS: ReadonlyArray<{ key: keyof NovelCharacterDynamicFields; label: string }> = [
  { key: "body", label: "身体" },
  { key: "emotion", label: "情绪" },
  { key: "known", label: "已知" },
  { key: "unknown", label: "未知" },
  { key: "relationships", label: "关系" },
  { key: "goals", label: "目标" },
  { key: "psychology", label: "心理" },
  { key: "unresolved", label: "未决" },
];

const KNOWLEDGE_FIELDS = [
  { key: "entityId", label: "人物" },
  { key: "fact", label: "事实" },
  { key: "status", label: "知情状态" },
  { key: "rawValue", label: "原始口径" },
  { key: "effectiveFromChapterId", label: "起效章" },
  { key: "effectiveUntilChapterId", label: "失效章" },
] as const;

const RELATIONSHIP_FIELDS = [
  { key: "fromEntityId", label: "关系起点" },
  { key: "toEntityId", label: "关系终点" },
  { key: "relation", label: "关系类型" },
  { key: "state", label: "当前状态" },
] as const;

const TIMELINE_FIELDS = [
  { key: "storyTime", label: "故事时间" },
  { key: "summary", label: "事件" },
  { key: "startChapterId", label: "开始章" },
  { key: "endChapterId", label: "结束章" },
  { key: "disclosureChapterId", label: "披露章" },
] as const;

const FORESHADOW_FIELDS = [
  { key: "summary", label: "伏笔" },
  { key: "status", label: "生命周期" },
  { key: "setupChapterId", label: "埋设章" },
  { key: "maintenanceChapterIds", label: "维护章" },
  { key: "payoffChapterId", label: "回收章" },
] as const;

function evidenceFor(
  candidate: NovelAnyChapterStateCandidate,
  evidenceIds: readonly string[],
): NovelDesktopCandidateEvidence[] {
  const wanted = new Set(evidenceIds);
  return (candidate.evidenceSpans ?? [])
    .filter((entry) => wanted.has(entry.evidenceId))
    .map((entry) => ({
      evidenceId: entry.evidenceId,
      startOffset: entry.startOffset,
      endOffset: entry.endOffset,
      excerpt: clipped(entry.evidenceExcerpt, MAX_EVIDENCE_CHARACTERS),
    }));
}

function changeEvidenceFor(
  candidate: NovelAnyChapterStateCandidate,
  kind: NovelDesktopCandidateChange["kind"],
  recordId: string,
): { reason: string; evidence: NovelDesktopCandidateEvidence[] } {
  const match = candidate.changeEvidence?.find((entry) => entry.kind === kind && entry.recordId === recordId);
  return {
    reason: match?.reason ?? (candidate.schemaVersion === 1 ? "旧版候选未携带可复验证据说明" : "—"),
    evidence: evidenceFor(candidate, match?.evidenceSpanIds ?? []),
  };
}

function candidateReviewability(
  candidate: NovelAnyChapterStateCandidate,
  state: NovelWritingStateDocument,
  ordered: ReturnType<typeof orderedNovelChapters>,
): Pick<NovelDesktopPendingStateCandidate, "reviewStatus" | "reviewStatusMessage" | "allowedDecisions"> {
  if (candidate.schemaVersion !== 2) {
    return {
      reviewStatus: "legacy",
      reviewStatusMessage: "旧版候选缺少完整证据与审计范围，必须重新 stage。",
      allowedDecisions: [],
    };
  }
  const chapter = ordered.find((entry) => entry.chapterId === candidate.chapter.chapterId);
  if (!chapter || chapter.revision !== candidate.chapter.chapterRevision || chapter.sha256 !== candidate.chapter.chapterSha256) {
    return {
      reviewStatus: "stale_chapter",
      reviewStatusMessage: "候选绑定的正文 revision/SHA 已变化，请按当前正文重新 stage。",
      allowedDecisions: [],
    };
  }
  if (state.appliedCandidateIds.includes(candidate.candidateId)) {
    return {
      reviewStatus: "applied_recovery",
      reviewStatusMessage: "状态已应用但裁决回执缺失；只允许补记接受回执。",
      allowedDecisions: ["accepted"],
    };
  }
  if (candidate.baseWritingStateRevision !== state.revision
    || candidate.baseWritingStateFingerprint !== state.fingerprint) {
    return {
      reviewStatus: "stale_state",
      reviewStatusMessage: "候选基线已落后于当前 Writing State，请重新 stage。",
      allowedDecisions: [],
    };
  }
  const currentIndex = ordered.findIndex((entry) => entry.chapterId === state.currentThroughChapterId);
  const nextChapterId = state.rebuild?.nextChapterId ?? (currentIndex >= 0 ? ordered[currentIndex + 1]?.chapterId : undefined);
  if (!nextChapterId || candidate.chapter.chapterId !== nextChapterId) {
    return {
      reviewStatus: "out_of_order",
      reviewStatusMessage: `候选不是当前状态游标的下一章${nextChapterId ? `（应为 ${nextChapterId}）` : ""}。`,
      allowedDecisions: [],
    };
  }
  return {
    reviewStatus: "ready",
    reviewStatusMessage: "正文、候选与 Writing State CAS 一致，可由人类裁决。",
    allowedDecisions: ["accepted", "rejected"],
  };
}

function projectCandidate(
  candidate: NovelAnyChapterStateCandidate,
  state: NovelWritingStateDocument,
  snapshot: Awaited<ReturnType<NovelRepository["snapshot"]>>,
): NovelDesktopPendingStateCandidate {
  const ordered = orderedNovelChapters(snapshot.chapters!);
  const chapter = ordered.find((entry) => entry.chapterId === candidate.chapter.chapterId);
  const before = chapter ? projectNovelWritingState(snapshot, state, {
    targetChapterId: chapter.chapterId,
    cutoff: "before",
  }) : null;
  const entityNames = new Map((before?.temporal.entities ?? state.entities)
    .map((entry) => [entry.entityId, entry.name]));
  const changes: NovelDesktopCandidateChange[] = [];

  for (const delta of candidate.delta.characterStates) {
    const prior = before?.temporal.characterStates.find((entry) => entry.entityId === delta.entityId);
    const evidence = changeEvidenceFor(candidate, "character_state", delta.stateId);
    changes.push({
      kind: "character_state",
      recordId: delta.stateId,
      title: `${entityNames.get(delta.entityId) ?? delta.entityId} · 人物动态八项`,
      reason: evidence.reason,
      rows: diffRows(CHARACTER_FIELDS, prior?.fields as unknown as Record<string, unknown> | undefined, delta.fields as unknown as Record<string, unknown>),
      evidence: evidence.evidence,
    });
  }
  const genericChanges = <T extends Record<string, unknown>>(
    kind: NovelDesktopCandidateChange["kind"],
    values: T[],
    priorValues: readonly unknown[] | undefined,
    idKey: keyof T & string,
    title: (value: T) => string,
    fields: ReadonlyArray<{ key: string; label: string }>,
  ): void => {
    for (const value of values) {
      const recordId = String(value[idKey]);
      const prior = (priorValues ?? []).find((entry) => (entry as Record<string, unknown>)[idKey] === recordId) as Record<string, unknown> | undefined;
      const evidence = changeEvidenceFor(candidate, kind, recordId);
      changes.push({ kind, recordId, title: title(value), reason: evidence.reason, rows: diffRows(fields, prior, value), evidence: evidence.evidence });
    }
  };
  genericChanges("knowledge", candidate.delta.knowledge as unknown as Record<string, unknown>[], before?.temporal.knowledge, "knowledgeId", (value) => `${entityNames.get(String(value.entityId)) ?? value.entityId} · 知情边界`, KNOWLEDGE_FIELDS);
  genericChanges("relationship", candidate.delta.relationships as unknown as Record<string, unknown>[], before?.temporal.relationships, "relationshipId", (value) => `${entityNames.get(String(value.fromEntityId)) ?? value.fromEntityId} → ${entityNames.get(String(value.toEntityId)) ?? value.toEntityId}`, RELATIONSHIP_FIELDS);
  genericChanges("timeline", candidate.delta.timeline as unknown as Record<string, unknown>[], before?.temporal.timeline, "timelineId", () => "时间线", TIMELINE_FIELDS);
  genericChanges("foreshadowing", candidate.delta.foreshadowing as unknown as Record<string, unknown>[], before?.temporal.foreshadowing, "foreshadowingId", () => "伏笔生命周期", FORESHADOW_FIELDS);

  const checkedCharacterIds = candidate.schemaVersion === 2 ? candidate.auditScope.checkedCharacterIds : [];
  const checkedStateKinds = candidate.schemaVersion === 2 ? candidate.auditScope.checkedStateKinds : [];
  const noStateChangeEvidence = candidate.noStateChange
    ? evidenceFor(candidate, candidate.noStateChange.evidenceSpanIds)
    : [];
  return {
    candidateId: candidate.candidateId,
    fingerprint: candidate.fingerprint,
    schemaVersion: candidate.schemaVersion,
    chapter: {
      chapterId: candidate.chapter.chapterId,
      title: chapter?.title ?? candidate.chapter.chapterId,
      revision: candidate.chapter.chapterRevision,
      sha256: candidate.chapter.chapterSha256,
    },
    baseWritingStateRevision: candidate.baseWritingStateRevision,
    summary: clipped(candidate.summary, MAX_DIFF_CELL_CHARACTERS),
    changeKind: candidate.schemaVersion === 2 ? candidate.changeKind : "legacy",
    createdAt: candidate.createdAt,
    ...candidateReviewability(candidate, state, ordered),
    audit: {
      checkedCharacterIds,
      checkedCharacterLabels: checkedCharacterIds.map((entityId) => entityNames.get(entityId) ?? entityId),
      checkedStateKinds,
    },
    noStateChange: candidate.noStateChange ? {
      reason: clipped(candidate.noStateChange.reason, MAX_DIFF_CELL_CHARACTERS),
      evidence: noStateChangeEvidence,
    } : null,
    changes,
  };
}

function publicProbeError(error: unknown): { reason: string; message: string; nextAction?: string } {
  if (error instanceof NovelWritingStateRejectedError) {
    return {
      reason: error.result.reason,
      message: error.message,
      ...(error.result.nextAction ? { nextAction: error.result.nextAction } : {}),
    };
  }
  return { reason: "probe_unavailable", message: "一致性探针暂不可用，请刷新工程后重试。" };
}

export async function getNovelDesktopWritingDashboard(
  projectRoot: string,
  input: NovelDesktopWritingDashboardInput = {},
): Promise<NovelDesktopWritingDashboard> {
  const workflowMode = input.workflowMode ?? "formal";
  const repository = new NovelRepository(projectRoot);
  const snapshot = await repository.snapshot();
  if (!snapshot.chapters) throw new Error("Writing OS 桌面仪表盘只支持 managed manuscript。");
  const ordered = orderedNovelChapters(snapshot.chapters);
  const doctor = await withNovelAgent((novelAgent) => novelAgent.doctorNovelAgent(projectRoot, { workflowMode }));
  const state = await loadNovelWritingState(projectRoot, snapshot.workspace.projectId);
  const selected = input.selectedChapterId
    ? ordered.find((entry) => entry.chapterId === input.selectedChapterId) ?? null
    : null;
  let selectedChapter: NovelDesktopWritingDashboard["selectedChapter"] = null;
  if (selected) {
    const exactCompletion = state?.chapterCompletions.find((entry) => entry.chapterId === selected.chapterId
      && entry.chapterRevision === selected.revision
      && entry.chapterSha256 === selected.sha256);
    const previousCompletion = state?.chapterCompletions.find((entry) => entry.chapterId === selected.chapterId);
    const completion = !state
      ? {
        status: "writing_state_missing" as const,
        stateDebt: true,
        message: "Writing OS 尚未初始化，当前正文没有可验证的章末状态提交。",
      }
      : exactCompletion
        ? {
          status: "committed" as const,
          stateDebt: false,
          message: "当前正文 revision/SHA 已有 owner accepted 的章末状态提交。",
          committedRevision: exactCompletion.chapterRevision,
          committedSha256: exactCompletion.chapterSha256,
          ...(exactCompletion.candidateId ? { candidateId: exactCompletion.candidateId } : {}),
          committedAt: exactCompletion.committedAt,
        }
        : previousCompletion
          ? {
            status: "stale" as const,
            stateDebt: true,
            message: "正文已变更，旧章末状态提交与当前 revision/SHA 不再一致。",
            committedRevision: previousCompletion.chapterRevision,
            committedSha256: previousCompletion.chapterSha256,
            ...(previousCompletion.candidateId ? { candidateId: previousCompletion.candidateId } : {}),
            committedAt: previousCompletion.committedAt,
          }
          : {
            status: "missing" as const,
            stateDebt: true,
            message: "当前正文尚欠章末状态候选与人类裁决。",
          };
    let probe: NovelChapterConsistencyProbe | null = null;
    let probeError: NonNullable<NovelDesktopWritingDashboard["selectedChapter"]>["probeError"] = null;
    if (state) {
      try {
        probe = await probeNovelChapterConsistencyCore(projectRoot, snapshot, {
          targetChapterId: selected.chapterId,
          workflowMode,
        });
      } catch (error) {
        probeError = publicProbeError(error);
      }
    }
    selectedChapter = {
      chapterId: selected.chapterId,
      title: selected.title,
      revision: selected.revision,
      sha256: selected.sha256,
      completion,
      probe,
      probeError,
    };
  }

  const pending = state
    ? await listNovelPendingChapterStateCandidates(projectRoot, snapshot.workspace.projectId)
    : [];
  const projectedCandidates = state
    ? pending.slice(0, MAX_PENDING_CANDIDATES).map((candidate) => projectCandidate(candidate, state, snapshot))
    : [];
  const semantic = {
    schemaVersion: 1 as const,
    kind: "novel-desktop-writing-dashboard" as const,
    projectId: snapshot.workspace.projectId,
    projectName: doctor.project.projectName,
    workflowMode,
    writeReadiness: {
      readyForPrepare: doctor.readyForPrepare,
      targetChapter: doctor.targetChapter,
      requiredCharacterIds: doctor.requiredCharacterIds,
      baselineStatus: doctor.writingState?.baselineStatus ?? "missing" as const,
      currentThroughChapterId: doctor.writingState?.currentThroughChapterId ?? null,
      rebuild: doctor.writingState?.rebuild ?? null,
      lease: doctor.lease?.held
        ? {
          held: true,
          fence: doctor.lease.fence,
          leaseId: doctor.lease.leaseId,
          expiresAt: doctor.lease.expiresAt,
          ...(doctor.lease.contextPackReceipt
            ? { contextPackReceipt: doctor.lease.contextPackReceipt }
            : {}),
        }
        : { held: false, fence: doctor.lease?.fence ?? 0 },
      blockers: doctor.blockers.map((entry) => ({ code: entry.code, message: entry.message })),
      nextActions: doctor.nextTools.map((entry) => ({
        tool: entry.tool,
        purpose: entry.purpose,
        requiresHumanOwner: entry.requiresHumanOwner === true,
      })),
    },
    writingState: state ? {
      revision: state.revision,
      fingerprint: state.fingerprint,
      baselineStatus: state.baselineStatus,
      currentThroughChapterId: state.currentThroughChapterId,
      updatedAt: state.updatedAt,
    } : null,
    selectedChapter,
    pendingCandidateCount: pending.length,
    pendingCandidatesTruncated: pending.length > projectedCandidates.length,
    pendingCandidates: projectedCandidates,
    limitations: [
      "仪表盘与探针只证明当前机械规则发现或未发现的问题，不等于文学质量已通过。",
      "状态候选只有经过人类明确接受后才进入时态正典；正文保存成功不等于写章闭环完成。",
      "Diff 是净化后的审阅投影，不暴露 author_only 正典、源对象路径或写租约令牌。",
    ],
  };
  return { ...semantic, fingerprint: fingerprint(semantic) };
}

export async function reviewNovelDesktopStateCandidate(
  projectRoot: string,
  input: NovelDesktopStateCandidateReviewInput,
): Promise<{
  status: "succeeded";
  decision: Pick<NovelChapterStateDecision, "decisionId" | "candidateId" | "decision" | "reviewer" | "note" | "decidedAt" | "fingerprint">;
  writingState: { revision: number; fingerprint: string; currentThroughChapterId: string };
  replayed: boolean;
}> {
  const snapshot = await new NovelRepository(projectRoot).snapshot();
  if (!snapshot.chapters) throw new Error("状态候选裁决只支持 managed manuscript。");
  const state = await loadNovelWritingState(projectRoot, snapshot.workspace.projectId);
  if (!state) throw new Error("Writing OS 尚未初始化，不能裁决状态候选。");
  const pending = await listNovelPendingChapterStateCandidates(projectRoot, snapshot.workspace.projectId);
  const candidate = pending.find((entry) => entry.candidateId === input.candidateId);
  if (!candidate || candidate.fingerprint !== input.expectedCandidateFingerprint) {
    throw new Error("状态候选不存在、已裁决或 fingerprint 已变化，请刷新仪表盘。");
  }
  const reviewability = candidateReviewability(candidate, state, orderedNovelChapters(snapshot.chapters));
  if (!reviewability.allowedDecisions.includes(input.decision)) {
    throw new Error(`当前候选不允许执行 ${input.decision}：${reviewability.reviewStatusMessage}`);
  }
  const reviewer = "desktop-human-owner";
  const requestIdentity = fingerprint({
    projectId: snapshot.workspace.projectId,
    ...input,
    reviewer,
  });
  const record = await executeIdempotentCommand(projectRoot, {
    requestId: `desktop-novel-review-${randomUUID()}`,
    idempotencyKey: `desktop-novel-review-${requestIdentity}`,
    request: {
      command: "novel_review_chapter_state_candidate",
      payload: {
        candidateId: input.candidateId,
        expectedCandidateFingerprint: input.expectedCandidateFingerprint,
        expectedWritingStateRevision: input.expectedWritingStateRevision,
        expectedWritingStateFingerprint: input.expectedWritingStateFingerprint,
        decision: input.decision,
        reviewer,
        ...(input.note === undefined ? {} : { note: input.note }),
      },
    },
  }, { novelWriteActor: "human_ui" });
  if (record.status !== "succeeded") {
    throw new Error(record.error?.message ?? `状态候选裁决未成功：${record.status}`);
  }
  const result = record.result as {
    decision: NovelChapterStateDecision;
    state: NovelWritingStateDocument;
    replayed: boolean;
  };
  return {
    status: "succeeded",
    decision: {
      decisionId: result.decision.decisionId,
      candidateId: result.decision.candidateId,
      decision: result.decision.decision,
      reviewer: result.decision.reviewer,
      ...(result.decision.note === undefined ? {} : { note: result.decision.note }),
      decidedAt: result.decision.decidedAt,
      fingerprint: result.decision.fingerprint,
    },
    writingState: {
      revision: result.state.revision,
      fingerprint: result.state.fingerprint,
      currentThroughChapterId: result.state.currentThroughChapterId,
    },
    replayed: result.replayed,
  };
}
