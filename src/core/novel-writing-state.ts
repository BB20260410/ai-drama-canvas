import { createHash, randomBytes } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  ensureConfinedDirectory,
  inspectExistingConfinedDirectory,
  moveConfinedFileNoReplaceCas,
  persistConfinedBytesNoReplace,
  persistConfinedBytesNoReplaceBatch,
  readConfinedRegularFileWithIdentity,
  revalidateConfinedDirectory,
  replaceConfinedBytesCas,
} from "./confined-project-storage.js";
import {
  ensureNovelCreateTargetParent,
  readNovelProjectFile,
  resolveNovelProjectLocator,
} from "./novel-path-policy.js";
import type {
  NovelAiWriteContext,
  NovelAcquireChapterWriteLeaseInput,
  NovelActorAttribution,
  NovelAnyChapterStateCandidate,
  NovelAttachReviewTicketInput,
  NovelChapterRecord,
  NovelChapterSourceIdentity,
  NovelChapterStateCandidate,
  NovelChapterStateCompletion,
  NovelChapterStateDecision,
  NovelCharacterAppearanceProfileRecord,
  NovelCharacterProseProfileRecord,
  NovelContinuityIssueRecord,
  NovelContextPackReceipt,
  NovelForeshadowingRecord,
  NovelKnowledgeRecord,
  NovelChapterWriteLeaseRuntime,
  NovelInvalidateWritingStateFromInput,
  NovelRelationshipRecord,
  NovelReviewChapterStateCandidateInput,
  NovelReviewStoryBibleCandidateInput,
  NovelReviewTicket,
  NovelSeedWritingStateInput,
  NovelStageChapterStateCandidateInput,
  NovelStageStoryBibleCandidateInput,
  NovelStoryBibleCandidate,
  NovelStoryBibleDecision,
  NovelTimelineRecord,
  NovelWritingStateDocument,
  NovelWritingStateCheckpoint,
  NovelWritingStateCommitEvent,
  NovelWritingStateHistoryActiveRebuild,
  NovelWritingStateHistoryControl,
  NovelWritingWorkflowMode,
  NovelWorkspaceSnapshot,
} from "./novel-types.js";
import { resolveNovelWritingSourceBinding } from "./novel-writing-source-import.js";
import { getOperationContext } from "./operation-context.js";

export const NOVEL_WRITING_STATE_RELATIVE_PATH = "story-bible/writing-state.json";
const WRITING_SOURCE_OBJECTS_RELATIVE_PATH = ".aicanvas/novel/writing-source-objects/sha256";
const WRITING_CANDIDATES_RELATIVE_PATH = ".aicanvas/novel/change-sets";
const WRITING_DECISIONS_RELATIVE_PATH = ".aicanvas/novel/change-set-decisions";
const STORY_BIBLE_CANDIDATES_RELATIVE_PATH = ".aicanvas/novel/story-bible-change-sets";
const STORY_BIBLE_DECISIONS_RELATIVE_PATH = ".aicanvas/novel/story-bible-change-set-decisions";
const WRITING_STATE_REBUILDS_RELATIVE_PATH = ".aicanvas/novel/state-rebuilds";
const WRITING_STATE_HISTORY_ROOT = ".aicanvas/novel/state-history";
const WRITING_STATE_HISTORY_CONTROL_RELATIVE_PATH = `${WRITING_STATE_HISTORY_ROOT}/control.json`;
const WRITING_STATE_HISTORY_EVENTS_RELATIVE_PATH = `${WRITING_STATE_HISTORY_ROOT}/events/sha256`;
const WRITING_STATE_HISTORY_CHECKPOINTS_RELATIVE_PATH = `${WRITING_STATE_HISTORY_ROOT}/checkpoints/sha256`;
const WRITING_STATE_HISTORY_SHADOWS_RELATIVE_PATH = `${WRITING_STATE_HISTORY_ROOT}/shadows`;
const WRITING_STATE_HISTORY_OPERATIONS_RELATIVE_PATH = `${WRITING_STATE_HISTORY_ROOT}/operations`;
const WRITING_STATE_HISTORY_OPERATION_LAYOUT_RELATIVE_PATH = `${WRITING_STATE_HISTORY_OPERATIONS_RELATIVE_PATH}/layout.json`;
const WRITING_STATE_HISTORY_OPERATION_PENDING_RELATIVE_PATH = `${WRITING_STATE_HISTORY_OPERATIONS_RELATIVE_PATH}/pending`;
const WRITING_STATE_HISTORY_OPERATION_COMPLETED_MARKERS_RELATIVE_PATH = `${WRITING_STATE_HISTORY_OPERATIONS_RELATIVE_PATH}/completed-markers`;
const CHAPTER_WRITE_LEASES_RELATIVE_PATH = ".aicanvas/novel/chapter-write-leases.json";
const WRITING_REVIEWS_RELATIVE_PATH = ".aicanvas/novel/reviews";
const MAX_WRITING_STATE_BYTES = 64 * 1024 * 1024;
const MAX_WRITING_ARTIFACT_BYTES = 16 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PREFLIGHT_ID_PATTERN = /^novel-write-preflight-[a-f0-9]{24}$/u;
const STATE_CANDIDATE_ID_PATTERN = /^novel-state-candidate-[a-f0-9]{24}$/u;

export type NovelWritingStateRejectionReason =
  | "writing_state_missing"
  | "writing_state_exists"
  | "actor_forbidden"
  | "state_delta_required"
  | "legacy_candidate_requires_restage"
  | "retcon_requires_invalidation"
  | "state_rebuild_history_gap"
  | "state_rebuild_active"
  | "state_rebuild_out_of_order"
  | "state_history_recovery_required"
  | "state_history_integrity_mismatch"
  | "chapter_write_lease_required"
  | "chapter_write_lease_conflict"
  | "chapter_write_lease_stale"
  | "invalid_reference"
  | "baseline_not_locked"
  | "character_profile_missing"
  | "character_appearance_missing"
  | "state_commit_required"
  | "critical_memory_budget_insufficient"
  | "writing_source_integrity_mismatch"
  | "writing_source_unbound"
  | "context_preflight_stale"
  | "hard_canon_conflict"
  | "revision_conflict"
  | "content_conflict"
  | "not_found"
  | "invalid_target";

export class NovelWritingStateRejectedError extends Error {
  readonly result: {
    schemaVersion: 1;
    applied: false;
    entityType: "novel_writing_state";
    reason: NovelWritingStateRejectionReason;
    chapterId?: string;
    candidateId?: string;
    expectedRevision?: number;
    currentRevision?: number;
    expectedSha256?: string;
    currentSha256?: string;
    expectedFingerprint?: string;
    currentFingerprint?: string;
    minimumCharacters?: number;
    maximumAllowedCharacters?: number;
    omittedSections?: Array<{ section: string; count: number }>;
    nextAction?: string;
    requiresHumanOwner?: boolean;
    nextTools?: Array<{
      tool: string;
      argsMode: "exact" | "partial";
      args: Record<string, unknown>;
      requiredArgs?: string[];
      purpose: string;
      requiresHumanOwner?: boolean;
    }>;
  };

  constructor(
    message: string,
    detail: Omit<NovelWritingStateRejectedError["result"], "schemaVersion" | "applied" | "entityType">,
  ) {
    super(message);
    this.name = "NovelWritingStateRejectedError";
    const nextTools = detail.nextTools ?? defaultNovelNextTools(detail.reason, detail);
    this.result = {
      schemaVersion: 1,
      applied: false,
      entityType: "novel_writing_state",
      ...detail,
      ...(detail.reason === "actor_forbidden" ? { requiresHumanOwner: true } : {}),
      ...(nextTools.length ? { nextTools } : {}),
    };
  }
}

function defaultNovelNextTools(
  reason: NovelWritingStateRejectionReason,
  detail: {
    chapterId?: string;
    candidateId?: string;
    nextAction?: string;
    minimumCharacters?: number;
    maximumAllowedCharacters?: number;
  },
): NonNullable<NovelWritingStateRejectedError["result"]["nextTools"]> {
  const purpose = detail.nextAction ?? "重新读取当前状态后按返回身份恢复";
  if (reason === "actor_forbidden") return [];
  if (reason === "critical_memory_budget_insufficient") {
    if (detail.minimumCharacters !== undefined
      && detail.maximumAllowedCharacters !== undefined
      && detail.minimumCharacters <= detail.maximumAllowedCharacters) {
      return [{
        tool: "prepare_novel_chapter_write",
        argsMode: "partial",
        args: {
          ...(detail.chapterId ? { targetChapterId: detail.chapterId } : {}),
          maxCharacters: detail.minimumCharacters,
          workflowMode: "formal",
        },
        requiredArgs: ["projectRoot", "attribution"],
        purpose,
      }];
    }
    return [{
      tool: "get_novel_writing_state",
      argsMode: "partial",
      args: {
        ...(detail.chapterId ? { targetChapterId: detail.chapterId } : {}),
        cutoff: "before",
      },
      requiredArgs: ["projectRoot"],
      purpose,
      requiresHumanOwner: true,
    }];
  }
  if (reason === "state_history_recovery_required") {
    return [{
      tool: "execute_command",
      argsMode: "partial",
      args: { request: { command: "novel_recover_writing_state", payload: {} } },
      requiredArgs: ["projectRoot", "requestId", "idempotencyKey"],
      purpose,
    }];
  }
  if (reason === "state_history_integrity_mismatch") {
    return [{
      tool: "get_novel_state_rebuild_status",
      argsMode: "partial",
      args: {},
      requiredArgs: ["projectRoot"],
      purpose,
      requiresHumanOwner: true,
    }];
  }
  if (["context_preflight_stale", "chapter_write_lease_required", "chapter_write_lease_conflict", "chapter_write_lease_stale", "baseline_not_locked", "state_commit_required", "state_rebuild_out_of_order"].includes(reason)) {
    return [{
      tool: "prepare_novel_chapter_write",
      argsMode: "partial",
      args: detail.chapterId ? { targetChapterId: detail.chapterId } : {},
      requiredArgs: ["projectRoot", "attribution"],
      purpose,
    }];
  }
  if (["state_rebuild_history_gap", "retcon_requires_invalidation", "state_rebuild_active"].includes(reason)) {
    return [{
      tool: "plan_novel_state_rebuild",
      argsMode: "partial",
      args: detail.chapterId ? { targetChapterId: detail.chapterId } : {},
      requiredArgs: ["projectRoot"],
      purpose,
      ...(reason !== "state_rebuild_active" ? { requiresHumanOwner: true } : {}),
    }];
  }
  if (["writing_state_missing", "writing_state_exists"].includes(reason)) {
    return [{
      tool: "execute_command",
      argsMode: "partial",
      args: { request: { command: "novel_seed_writing_state" } },
      requiredArgs: ["projectRoot", "requestId", "idempotencyKey", "request.payload"],
      purpose,
      requiresHumanOwner: true,
    }];
  }
  if (["state_delta_required", "invalid_reference", "legacy_candidate_requires_restage"].includes(reason)) {
    return [{
      tool: "execute_command",
      argsMode: "partial",
      args: { request: { command: "novel_stage_chapter_state_candidate", payload: detail.chapterId ? { chapterId: detail.chapterId } : {} } },
      requiredArgs: ["projectRoot", "requestId", "idempotencyKey", "request.payload"],
      purpose,
    }];
  }
  if (reason === "character_profile_missing" || reason === "character_appearance_missing") {
    return [{
      tool: "execute_command",
      argsMode: "partial",
      args: { request: { command: "novel_stage_story_bible_candidate" } },
      requiredArgs: ["projectRoot", "requestId", "idempotencyKey", "request.payload"],
      purpose,
    }];
  }
  if (reason === "writing_source_integrity_mismatch" || reason === "writing_source_unbound") {
    return [{
      tool: "list_novel_writing_source_receipts",
      argsMode: "partial",
      args: {},
      requiredArgs: ["projectRoot"],
      purpose,
      requiresHumanOwner: true,
    }];
  }
  return [];
}

export function isNovelWritingStateRejectedError(error: unknown): error is NovelWritingStateRejectedError {
  return error instanceof NovelWritingStateRejectedError;
}

function rejectWritingState(
  message: string,
  detail: ConstructorParameters<typeof NovelWritingStateRejectedError>[1],
): never {
  throw new NovelWritingStateRejectedError(message, detail);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code ?? "")
    : undefined;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stable(entry)]));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(stable(value)));
}

function splitsUtf16SurrogatePair(content: string, offset: number): boolean {
  if (offset <= 0 || offset >= content.length) return false;
  const previous = content.charCodeAt(offset - 1);
  const current = content.charCodeAt(offset);
  return previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stateWithFingerprint(
  value: Omit<NovelWritingStateDocument, "fingerprint">,
): NovelWritingStateDocument {
  return { ...value, fingerprint: fingerprint(value) };
}

function artifactWithFingerprint<T extends object>(value: T): T & { fingerprint: string } {
  return { ...value, fingerprint: fingerprint(value) };
}

function nextIsoTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("写作状态时间戳无效。");
  return new Date(milliseconds + 1).toISOString();
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} 不是有效 UTF-8 JSON。`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateStateDocument(value: unknown, expectedProjectId?: string): NovelWritingStateDocument {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "novel-writing-state"
    || typeof value.projectId !== "string"
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || typeof value.fingerprint !== "string" || !SHA256_PATTERN.test(value.fingerprint)
    || !Array.isArray(value.sources)
    || !Array.isArray(value.entities)
    || !Array.isArray(value.hardCanon)
    || !Array.isArray(value.characterStates)
    || !Array.isArray(value.knowledge)
    || !Array.isArray(value.relationships)
    || !Array.isArray(value.timeline)
    || !Array.isArray(value.foreshadowing)
    || !Array.isArray(value.chapterBriefs)
    || !Array.isArray(value.chapterCompletions)
    || !Array.isArray(value.appliedCandidateIds)) {
    throw new Error("writing-state.json 结构无效。");
  }
  if (expectedProjectId && value.projectId !== expectedProjectId) {
    throw new Error("writing-state.json 与小说工程身份不一致。");
  }
  const { fingerprint: storedFingerprint, ...semantic } = value;
  if (fingerprint(semantic) !== storedFingerprint) {
    throw new Error("writing-state.json fingerprint 复验失败。");
  }
  return value as unknown as NovelWritingStateDocument;
}

function validateFingerprintArtifact<T extends { fingerprint: string }>(
  value: unknown,
  kind: string,
): T {
  if (!isRecord(value) || value.kind !== kind || typeof value.fingerprint !== "string"
    || !SHA256_PATTERN.test(value.fingerprint)) {
    throw new Error(`${kind} 结构无效。`);
  }
  const { fingerprint: storedFingerprint, ...semantic } = value;
  if (fingerprint(semantic) !== storedFingerprint) throw new Error(`${kind} fingerprint 复验失败。`);
  return value as unknown as T;
}

async function readOptionalProjectFile(projectRoot: string, locator: string, maxBytes: number): Promise<Buffer | null> {
  try {
    return (await readNovelProjectFile(projectRoot, locator, { maxBytes })).bytes;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function persistImmutableOrVerify(projectRoot: string, locator: string, bytes: Buffer): Promise<boolean> {
  const existing = await readOptionalProjectFile(projectRoot, locator, bytes.byteLength);
  if (existing) {
    if (!existing.equals(bytes)) throw new Error(`不可变写作对象已存在但内容不同：${locator}`);
    return false;
  }
  const target = await ensureNovelCreateTargetParent(projectRoot, locator);
  const persisted = await persistConfinedBytesNoReplace(target.parent, target.name, bytes);
  if (persisted.sha256 !== sha256(bytes) || persisted.size !== bytes.byteLength) {
    throw new Error(`不可变写作对象发布回执无效：${locator}`);
  }
  return persisted.created;
}

async function createStateDocument(projectRoot: string, state: NovelWritingStateDocument): Promise<void> {
  const target = await ensureNovelCreateTargetParent(projectRoot, NOVEL_WRITING_STATE_RELATIVE_PATH);
  const bytes = jsonBytes(state);
  const persisted = await persistConfinedBytesNoReplace(target.parent, target.name, bytes);
  if (persisted.sha256 !== sha256(bytes) || persisted.size !== bytes.byteLength) {
    throw new Error("writing-state.json 创建回执无效。");
  }
}

async function replaceStateDocumentCas(
  projectRoot: string,
  expected: NovelWritingStateDocument,
  next: NovelWritingStateDocument,
): Promise<void> {
  const resolved = resolveNovelProjectLocator(projectRoot, NOVEL_WRITING_STATE_RELATIVE_PATH);
  const directory = await inspectExistingConfinedDirectory(projectRoot, path.dirname(resolved.absolutePath));
  const read = await readConfinedRegularFileWithIdentity(directory, path.basename(resolved.absolutePath), MAX_WRITING_STATE_BYTES);
  const current = validateStateDocument(parseJson(read.bytes, "writing-state.json"), expected.projectId);
  if (current.revision !== expected.revision || current.fingerprint !== expected.fingerprint) {
    rejectWritingState("写作状态 revision/fingerprint CAS 已过期。", {
      reason: "revision_conflict",
      expectedRevision: expected.revision,
      currentRevision: current.revision,
      expectedFingerprint: expected.fingerprint,
      currentFingerprint: current.fingerprint,
      nextAction: "重新读取写作状态后重试",
    });
  }
  const nextBytes = jsonBytes(next);
  await replaceConfinedBytesCas(read.identity, sha256(read.bytes), read.bytes.byteLength, nextBytes);
}

function temporalManifestDigest(snapshot: NovelWorkspaceSnapshot): string {
  return fingerprint(orderedChapters(snapshot).map((chapter, ordinal) => ({
    ordinal,
    chapterId: chapter.chapterId,
    revision: chapter.revision,
    sha256: chapter.sha256,
  })));
}

function historyEventLocator(eventId: string): string {
  return `${WRITING_STATE_HISTORY_EVENTS_RELATIVE_PATH}/${eventId}.json`;
}

function historyCheckpointLocator(checkpointId: string): string {
  return `${WRITING_STATE_HISTORY_CHECKPOINTS_RELATIVE_PATH}/${checkpointId}.json`;
}

function historyShadowStateLocator(rebuildId: string, stateFingerprint: string): string {
  return `${WRITING_STATE_HISTORY_SHADOWS_RELATIVE_PATH}/${rebuildId}/states/${stateFingerprint}.json`;
}

function validateHistoryControl(value: unknown, expectedProjectId: string): NovelWritingStateHistoryControl {
  const control = validateFingerprintArtifact<NovelWritingStateHistoryControl>(
    value,
    "novel-writing-state-history-control",
  );
  if (control.schemaVersion !== 1 || control.projectId !== expectedProjectId
    || !Number.isSafeInteger(control.revision) || control.revision < 1
    || !isRecord(control.publicHead)
    || typeof control.publicHead.lineageId !== "string"
    || typeof control.publicHead.checkpointId !== "string"
    || typeof control.publicHead.stateFingerprint !== "string"
    || !SHA256_PATTERN.test(control.publicHead.stateFingerprint)
    || !Number.isSafeInteger(control.publicHead.stateRevision)
    || control.publicHead.stateRevision < 1
    || typeof control.publicHead.throughChapterId !== "string"
    || typeof control.publicHead.coverageBaseChapterId !== "string"
    || !["complete", "head_only"].includes(control.publicHead.coverageMode)
    || (control.publicHead.headEventId !== null
      && !/^novel-state-event-[a-f0-9]{32}$/u.test(control.publicHead.headEventId))
    || !/^novel-state-checkpoint-[a-f0-9]{32}$/u.test(control.publicHead.checkpointId)
    || typeof control.updatedAt !== "string") {
    throw new Error("writing-state history control 结构或工程身份无效。");
  }
  if (control.activeRebuild) {
    const rebuild = control.activeRebuild;
    if (typeof rebuild.rebuildId !== "string" || !rebuild.rebuildId.startsWith("novel-state-rebuild-")
      || !Number.isSafeInteger(rebuild.generation) || rebuild.generation < 1
      || typeof rebuild.lineageId !== "string"
      || typeof rebuild.planFingerprint !== "string" || !SHA256_PATTERN.test(rebuild.planFingerprint)
      || !Array.isArray(rebuild.pendingChapterIds) || rebuild.pendingChapterIds.length < 1
      || rebuild.pendingChapterIds[0] !== rebuild.nextChapterId
      || new Set(rebuild.pendingChapterIds).size !== rebuild.pendingChapterIds.length
      || typeof rebuild.targetFromChapterId !== "string"
      || typeof rebuild.baseChapterId !== "string"
      || typeof rebuild.previousCurrentThroughChapterId !== "string"
      || (rebuild.shadowHeadEventId !== null
        && !/^novel-state-event-[a-f0-9]{32}$/u.test(rebuild.shadowHeadEventId))
      || !/^novel-state-checkpoint-[a-f0-9]{32}$/u.test(rebuild.shadowCheckpointId)
      || typeof rebuild.shadowStateLocator !== "string"
      || typeof rebuild.shadowStateFingerprint !== "string" || !SHA256_PATTERN.test(rebuild.shadowStateFingerprint)
      || !Number.isSafeInteger(rebuild.shadowStateRevision) || rebuild.shadowStateRevision < 1
      || !Number.isSafeInteger(rebuild.manifestRevision) || rebuild.manifestRevision < 1
      || typeof rebuild.temporalManifestDigest !== "string" || !SHA256_PATTERN.test(rebuild.temporalManifestDigest)
      || typeof rebuild.startedAt !== "string") {
      throw new Error("writing-state active rebuild control 无效。");
    }
  }
  return control;
}

async function loadHistoryControl(
  projectRoot: string,
  expectedProjectId: string,
): Promise<NovelWritingStateHistoryControl | null> {
  const bytes = await readOptionalProjectFile(
    projectRoot,
    WRITING_STATE_HISTORY_CONTROL_RELATIVE_PATH,
    MAX_WRITING_ARTIFACT_BYTES,
  );
  return bytes ? validateHistoryControl(parseJson(bytes, "writing-state history control"), expectedProjectId) : null;
}

function createHistoryCheckpoint(input: {
  projectId: string;
  lineageId: string;
  headEventId: string | null;
  coverageMode: "complete" | "head_only";
  coverageBaseChapterId: string;
  state: NovelWritingStateDocument;
  createdAt: string;
}): NovelWritingStateCheckpoint {
  const checkpointId = `novel-state-checkpoint-${fingerprint({
    projectId: input.projectId,
    lineageId: input.lineageId,
    headEventId: input.headEventId,
    stateFingerprint: input.state.fingerprint,
  }).slice(0, 32)}`;
  return artifactWithFingerprint({
    schemaVersion: 1 as const,
    kind: "novel-writing-state-checkpoint" as const,
    checkpointId,
    projectId: input.projectId,
    lineageId: input.lineageId,
    headEventId: input.headEventId,
    coverageMode: input.coverageMode,
    coverageBaseChapterId: input.coverageBaseChapterId,
    state: input.state,
    createdAt: input.createdAt,
  });
}

async function persistHistoryCheckpoint(projectRoot: string, checkpoint: NovelWritingStateCheckpoint): Promise<void> {
  await persistImmutableOrVerify(projectRoot, historyCheckpointLocator(checkpoint.checkpointId), jsonBytes(checkpoint));
}

async function persistHistoryEvent(projectRoot: string, event: NovelWritingStateCommitEvent): Promise<void> {
  await persistImmutableOrVerify(projectRoot, historyEventLocator(event.eventId), jsonBytes(event));
}

async function loadAndValidateHistoryCheckpoint(
  projectRoot: string,
  checkpointId: string,
  expectedProjectId: string,
): Promise<NovelWritingStateCheckpoint> {
  const bytes = await readOptionalProjectFile(
    projectRoot,
    historyCheckpointLocator(checkpointId),
    MAX_WRITING_STATE_BYTES * 2,
  );
  if (!bytes) throw new Error(`writing-state history checkpoint 缺失：${checkpointId}`);
  const checkpoint = validateFingerprintArtifact<NovelWritingStateCheckpoint>(
    parseJson(bytes, "writing-state history checkpoint"),
    "novel-writing-state-checkpoint",
  );
  if (checkpoint.schemaVersion !== 1 || checkpoint.projectId !== expectedProjectId
    || checkpoint.checkpointId !== checkpointId
    || !/^novel-state-checkpoint-[a-f0-9]{32}$/u.test(checkpoint.checkpointId)
    || typeof checkpoint.lineageId !== "string"
    || (checkpoint.headEventId !== null
      && !/^novel-state-event-[a-f0-9]{32}$/u.test(checkpoint.headEventId))
    || !["complete", "head_only"].includes(checkpoint.coverageMode)
    || typeof checkpoint.coverageBaseChapterId !== "string"
    || typeof checkpoint.createdAt !== "string") {
    throw new Error("writing-state history checkpoint 结构或工程身份无效。");
  }
  checkpoint.state = validateStateDocument(checkpoint.state, expectedProjectId);
  const expectedCheckpointId = `novel-state-checkpoint-${fingerprint({
    projectId: checkpoint.projectId,
    lineageId: checkpoint.lineageId,
    headEventId: checkpoint.headEventId,
    stateFingerprint: checkpoint.state.fingerprint,
  }).slice(0, 32)}`;
  if (checkpoint.checkpointId !== expectedCheckpointId) {
    throw new Error("writing-state history checkpointId 与状态身份不一致。");
  }
  return checkpoint;
}

async function loadAndValidateHistoryEvent(
  projectRoot: string,
  eventId: string,
  expectedProjectId: string,
): Promise<NovelWritingStateCommitEvent> {
  const bytes = await readOptionalProjectFile(
    projectRoot,
    historyEventLocator(eventId),
    MAX_WRITING_ARTIFACT_BYTES,
  );
  if (!bytes) throw new Error(`writing-state history event 缺失：${eventId}`);
  const event = validateFingerprintArtifact<NovelWritingStateCommitEvent>(
    parseJson(bytes, "writing-state history event"),
    "novel-writing-state-commit-event",
  );
  if (event.schemaVersion !== 1 || event.projectId !== expectedProjectId || event.eventId !== eventId
    || typeof event.lineageId !== "string" || typeof event.checkpointId !== "string"
    || !/^novel-state-event-[a-f0-9]{32}$/u.test(event.eventId)
    || !/^novel-state-checkpoint-[a-f0-9]{32}$/u.test(event.checkpointId)
    || (event.parentEventId !== null
      && !/^novel-state-event-[a-f0-9]{32}$/u.test(event.parentEventId))
    || !["chapter_state_commit", "story_bible_commit", "rebuild_started", "rebuild_shadow_commit", "rebuild_promotion"].includes(event.operationKind)
    || !Number.isSafeInteger(event.beforeStateRevision) || event.beforeStateRevision < 1
    || !Number.isSafeInteger(event.afterStateRevision)
    || event.afterStateRevision !== event.beforeStateRevision + 1
    || !SHA256_PATTERN.test(event.beforeStateFingerprint) || !SHA256_PATTERN.test(event.afterStateFingerprint)
    || !/^novel-state-checkpoint-[a-f0-9]{32}$/u.test(event.beforeCheckpointId)
    || !SHA256_PATTERN.test(event.temporalManifestDigest)
    || typeof event.createdAt !== "string") {
    throw new Error("writing-state history event 结构或工程身份无效。");
  }
  const rebuildStarted = event.operationKind === "rebuild_started";
  const storyBible = event.operationKind === "story_bible_commit";
  const chapterOperation = !storyBible && !rebuildStarted;
  const hasCandidateClosure = typeof event.candidateId === "string"
    && typeof event.candidateFingerprint === "string" && SHA256_PATTERN.test(event.candidateFingerprint)
    && typeof event.decisionId === "string"
    && typeof event.decisionFingerprint === "string" && SHA256_PATTERN.test(event.decisionFingerprint);
  if (chapterOperation !== Boolean(event.chapter)
    || rebuildStarted === hasCandidateClosure
    || (rebuildStarted && [event.candidateId, event.candidateFingerprint, event.decisionId, event.decisionFingerprint]
      .some((entry) => entry !== undefined))
    || (storyBible || rebuildStarted) !== (event.contribution === undefined)
    || (chapterOperation && !["changes", "no_change"].includes(event.contribution ?? ""))) {
    throw new Error("writing-state history event 操作类型与章/贡献字段不一致。");
  }
  const expectedEventId = `novel-state-event-${fingerprint({
    projectId: event.projectId,
    lineageId: event.lineageId,
    parentEventId: event.parentEventId,
    beforeCheckpointId: event.beforeCheckpointId,
    operationKind: event.operationKind,
    candidateId: event.candidateId ?? null,
    beforeStateFingerprint: event.beforeStateFingerprint,
    afterStateFingerprint: event.afterStateFingerprint,
  }).slice(0, 32)}`;
  if (event.eventId !== expectedEventId) {
    throw new Error("writing-state history eventId 与过渡身份不一致。");
  }
  return event;
}

async function verifyHistoryEventBeforeClosure(
  projectRoot: string,
  projectId: string,
  event: NovelWritingStateCommitEvent,
): Promise<NovelWritingStateCheckpoint> {
  const before = await loadAndValidateHistoryCheckpoint(
    projectRoot,
    event.beforeCheckpointId,
    projectId,
  );
  if (before.headEventId !== event.parentEventId
    || before.state.revision !== event.beforeStateRevision
    || before.state.fingerprint !== event.beforeStateFingerprint) {
    throw new Error("writing-state history event 的 before checkpoint 不闭合。");
  }
  if (event.operationKind === "rebuild_started") {
    if (before.lineageId === event.lineageId) {
      throw new Error("rebuild_started 必须从旧公开 lineage 分叉到新 lineage。");
    }
  } else if (before.lineageId !== event.lineageId) {
    throw new Error("writing-state history event 跨 lineage 但未声明 rebuild_started。");
  }
  return before;
}

async function verifyHistoryLineageFromHead(input: {
  projectRoot: string;
  projectId: string;
  headEventId: string | null;
  headCheckpointId: string;
  headState: NovelWritingStateDocument;
}): Promise<number> {
  let eventId = input.headEventId;
  let checkpointId = input.headCheckpointId;
  let expectedStateRevision = input.headState.revision;
  let expectedStateFingerprint = input.headState.fingerprint;
  const visited = new Set<string>();
  let verified = 0;
  while (eventId) {
    if (visited.has(eventId) || visited.size >= 100_000) {
      throw new Error("writing-state history event 链出现循环或超过审计上限。");
    }
    visited.add(eventId);
    const event = await loadAndValidateHistoryEvent(input.projectRoot, eventId, input.projectId);
    if (event.checkpointId !== checkpointId
      || event.afterStateRevision !== expectedStateRevision
      || event.afterStateFingerprint !== expectedStateFingerprint) {
      throw new Error("writing-state history lineage 的 after 身份不连续。");
    }
    const before = await verifyHistoryEventBeforeClosure(input.projectRoot, input.projectId, event);
    checkpointId = before.checkpointId;
    expectedStateRevision = before.state.revision;
    expectedStateFingerprint = before.state.fingerprint;
    eventId = event.parentEventId;
    verified += 1;
  }
  const base = await loadAndValidateHistoryCheckpoint(
    input.projectRoot,
    checkpointId,
    input.projectId,
  );
  if (base.headEventId !== null || base.state.revision !== expectedStateRevision
    || base.state.fingerprint !== expectedStateFingerprint) {
    throw new Error("writing-state history lineage 的 base checkpoint 不闭合。");
  }
  return verified;
}

async function verifyHistoryHeadClosure(input: {
  projectRoot: string;
  projectId: string;
  head: NovelWritingStateHistoryControl["publicHead"];
  state: NovelWritingStateDocument;
}): Promise<void> {
  const checkpoint = await loadAndValidateHistoryCheckpoint(
    input.projectRoot,
    input.head.checkpointId,
    input.projectId,
  );
  if (checkpoint.lineageId !== input.head.lineageId || checkpoint.headEventId !== input.head.headEventId
    || checkpoint.coverageMode !== input.head.coverageMode
    || checkpoint.coverageBaseChapterId !== input.head.coverageBaseChapterId
    || checkpoint.state.revision !== input.state.revision
    || checkpoint.state.fingerprint !== input.state.fingerprint) {
    throw new Error("writing-state history public checkpoint 与 control/state 不一致。");
  }
  if (input.head.headEventId) {
    const event = await loadAndValidateHistoryEvent(input.projectRoot, input.head.headEventId, input.projectId);
    if (event.lineageId !== input.head.lineageId || event.checkpointId !== checkpoint.checkpointId
      || event.afterStateRevision !== input.state.revision
      || event.afterStateFingerprint !== input.state.fingerprint) {
      throw new Error("writing-state history public event 与 checkpoint/state 不一致。");
    }
    await verifyHistoryEventBeforeClosure(input.projectRoot, input.projectId, event);
  }
}

async function verifyActiveRebuildClosure(input: {
  projectRoot: string;
  projectId: string;
  rebuild: NovelWritingStateHistoryActiveRebuild;
  state: NovelWritingStateDocument;
}): Promise<void> {
  const checkpoint = await loadAndValidateHistoryCheckpoint(
    input.projectRoot,
    input.rebuild.shadowCheckpointId,
    input.projectId,
  );
  if (checkpoint.lineageId !== input.rebuild.lineageId
    || checkpoint.headEventId !== input.rebuild.shadowHeadEventId
    || checkpoint.state.revision !== input.state.revision
    || checkpoint.state.fingerprint !== input.state.fingerprint) {
    throw new Error("writing-state shadow checkpoint 与 control/state 不一致。");
  }
  if (input.rebuild.shadowHeadEventId) {
    const event = await loadAndValidateHistoryEvent(
      input.projectRoot,
      input.rebuild.shadowHeadEventId,
      input.projectId,
    );
    if (event.lineageId !== input.rebuild.lineageId || event.checkpointId !== checkpoint.checkpointId
      || event.afterStateRevision !== input.state.revision
      || event.afterStateFingerprint !== input.state.fingerprint) {
      throw new Error("writing-state shadow event 与 checkpoint/state 不一致。");
    }
    await verifyHistoryEventBeforeClosure(input.projectRoot, input.projectId, event);
  }
}

function historyControlWithFingerprint(
  value: Omit<NovelWritingStateHistoryControl, "fingerprint"> | NovelWritingStateHistoryControl,
): NovelWritingStateHistoryControl {
  const { fingerprint: _previousFingerprint, ...semantic } = value as NovelWritingStateHistoryControl;
  return artifactWithFingerprint(semantic);
}

async function createLegacyHistoryControl(
  projectRoot: string,
  state: NovelWritingStateDocument,
): Promise<NovelWritingStateHistoryControl> {
  const lineageId = `novel-state-lineage-${fingerprint({
    projectId: state.projectId,
    stateFingerprint: state.fingerprint,
    kind: "legacy-genesis",
  }).slice(0, 32)}`;
  const checkpoint = createHistoryCheckpoint({
    projectId: state.projectId,
    lineageId,
    headEventId: null,
    coverageMode: "head_only",
    coverageBaseChapterId: state.historyBaseChapterId ?? state.currentThroughChapterId,
    state,
    createdAt: state.updatedAt,
  });
  await persistHistoryCheckpoint(projectRoot, checkpoint);
  const control = historyControlWithFingerprint({
    schemaVersion: 1,
    kind: "novel-writing-state-history-control",
    projectId: state.projectId,
    revision: 1,
    publicHead: {
      lineageId,
      headEventId: null,
      checkpointId: checkpoint.checkpointId,
      stateRevision: state.revision,
      stateFingerprint: state.fingerprint,
      throughChapterId: state.currentThroughChapterId,
      coverageMode: "head_only",
      coverageBaseChapterId: state.historyBaseChapterId ?? state.currentThroughChapterId,
    },
    updatedAt: state.updatedAt,
  });
  await persistImmutableOrVerify(projectRoot, WRITING_STATE_HISTORY_CONTROL_RELATIVE_PATH, jsonBytes(control));
  const loaded = await loadHistoryControl(projectRoot, state.projectId);
  if (!loaded) throw new Error("writing-state history control 创建后不可读。");
  return loaded;
}

async function ensureHistoryControlForPublicState(
  projectRoot: string,
  state: NovelWritingStateDocument,
): Promise<NovelWritingStateHistoryControl> {
  const existing = await loadHistoryControl(projectRoot, state.projectId);
  if (!existing) return createLegacyHistoryControl(projectRoot, state);
  if (existing.publicHead.stateRevision !== state.revision
    || existing.publicHead.stateFingerprint !== state.fingerprint
    || existing.publicHead.throughChapterId !== state.currentThroughChapterId) {
    throw new Error("writing-state 公开投影与 history control public head 不一致；需要恢复，禁止自动桥接未知过渡。");
  }
  await verifyHistoryHeadClosure({
    projectRoot,
    projectId: state.projectId,
    head: existing.publicHead,
    state,
  });
  return existing;
}

async function loadHistoryShadowState(
  projectRoot: string,
  rebuild: NovelWritingStateHistoryActiveRebuild,
  expectedProjectId: string,
): Promise<NovelWritingStateDocument> {
  const bytes = await readOptionalProjectFile(projectRoot, rebuild.shadowStateLocator, MAX_WRITING_STATE_BYTES);
  if (!bytes) throw new Error("writing-state shadow state 缺失。");
  const state = validateStateDocument(parseJson(bytes, "writing-state shadow state"), expectedProjectId);
  if (state.revision !== rebuild.shadowStateRevision || state.fingerprint !== rebuild.shadowStateFingerprint
    || !state.rebuild || state.rebuild.rebuildId !== rebuild.rebuildId
    || state.rebuild.nextChapterId !== rebuild.nextChapterId
    || state.rebuild.pendingChapterIds.join("\0") !== rebuild.pendingChapterIds.join("\0")) {
    throw new Error("writing-state shadow state 与 active rebuild control 不一致。");
  }
  return state;
}

interface WritingStateHistoryMutableTarget {
  label: "state" | "control" | "decision";
  locator: string;
  beforeSha256: string | null;
  beforeByteLength: number | null;
  afterObjectName: string;
  afterSha256: string;
  afterByteLength: number;
}

interface WritingStateHistoryOperationIntent {
  schemaVersion: 1;
  kind: "novel-writing-state-operation-intent";
  operationId: string;
  requestHash: string;
  command: string;
  projectId: string;
  targets: WritingStateHistoryMutableTarget[];
  resultObjectName: "result.json";
  resultSha256: string;
  resultByteLength: number;
  createdAt: string;
  fingerprint: string;
}

interface WritingStateHistoryOperationReceipt {
  schemaVersion: 1;
  kind: "novel-writing-state-operation-receipt";
  operationId: string;
  requestHash: string;
  command: string;
  projectId: string;
  resultObjectName: "result.json";
  resultSha256: string;
  resultByteLength: number;
  completedAt: string;
  fingerprint: string;
}

interface WritingStateHistoryOperationLayout {
  schemaVersion: 1;
  kind: "novel-writing-state-operation-layout";
  projectId: string;
  strategy: "pending-markers-v1";
  initializedAt: string;
  fingerprint: string;
}

interface WritingStateHistoryOperationMarker {
  schemaVersion: 1;
  kind: "novel-writing-state-operation-marker";
  operationId: string;
  requestHash: string;
  command: string;
  projectId: string;
  intentFingerprint: string;
  createdAt: string;
  fingerprint: string;
}

const WRITING_STATE_HISTORY_OPERATION_FILE_NAMES = new Set([
  "after-state.json",
  "after-control.json",
  "after-decision.json",
  "result.json",
  "intent.json",
  "completed.json",
]);

const WRITING_STATE_HISTORY_DECISION_LOCATOR_PATTERN = /^\.aicanvas\/novel\/(?:change-set-decisions\/novel-state-candidate-[a-f0-9]{24}|story-bible-change-set-decisions\/novel-bible-candidate-[a-f0-9]{24})\.json$/u;

function historyOperationLocator(requestHash: string, name: string): string {
  return `${WRITING_STATE_HISTORY_OPERATIONS_RELATIVE_PATH}/${requestHash}/${name}`;
}

function historyOperationMarkerLocator(
  bucket: "pending" | "completed-markers",
  requestHash: string,
): string {
  const root = bucket === "pending"
    ? WRITING_STATE_HISTORY_OPERATION_PENDING_RELATIVE_PATH
    : WRITING_STATE_HISTORY_OPERATION_COMPLETED_MARKERS_RELATIVE_PATH;
  return `${root}/${requestHash}.json`;
}

function maybeInterruptWritingStateHistoryForTests(
  phase: "after-intent" | "after-state" | "after-control" | "after-decision",
): void {
  if (process.env.NODE_ENV === "test"
    && process.env.AI_CANVAS_TEST_WRITING_STATE_HISTORY_INTERRUPT === phase) {
    throw new Error(`test-only writing-state history interruption: ${phase}`);
  }
}

function validateHistoryOperationIntent(value: unknown): WritingStateHistoryOperationIntent {
  const intent = validateFingerprintArtifact<WritingStateHistoryOperationIntent>(
    value,
    "novel-writing-state-operation-intent",
  );
  if (intent.schemaVersion !== 1 || !SHA256_PATTERN.test(intent.requestHash)
    || typeof intent.operationId !== "string" || typeof intent.command !== "string"
    || typeof intent.projectId !== "string" || !Array.isArray(intent.targets)
    || intent.targets.length < 1 || intent.targets.length > 3
    || intent.resultObjectName !== "result.json" || !SHA256_PATTERN.test(intent.resultSha256)
    || !Number.isSafeInteger(intent.resultByteLength) || intent.resultByteLength < 1) {
    throw new Error("writing-state operation intent 结构无效。");
  }
  const labels = new Set<string>();
  const locators = new Set<string>();
  for (const target of intent.targets) {
    if (!target || !["state", "control", "decision"].includes(target.label)
      || labels.has(target.label) || typeof target.locator !== "string"
      || locators.has(target.locator)
      || typeof target.afterObjectName !== "string"
      || target.afterObjectName !== `after-${target.label}.json`
      || !SHA256_PATTERN.test(target.afterSha256)
      || !Number.isSafeInteger(target.afterByteLength) || target.afterByteLength < 1
      || (target.beforeSha256 !== null && !SHA256_PATTERN.test(target.beforeSha256))
      || (target.beforeByteLength !== null
        && (!Number.isSafeInteger(target.beforeByteLength) || target.beforeByteLength < 1))
      || (target.beforeSha256 === null) !== (target.beforeByteLength === null)) {
      throw new Error("writing-state operation target 无效。");
    }
    labels.add(target.label);
    locators.add(target.locator);
    if (target.label === "state" && target.locator !== NOVEL_WRITING_STATE_RELATIVE_PATH) {
      throw new Error("writing-state operation state target 越权。");
    }
    if (target.label === "control" && target.locator !== WRITING_STATE_HISTORY_CONTROL_RELATIVE_PATH) {
      throw new Error("writing-state operation control target 越权。");
    }
    if (target.label === "decision" && !WRITING_STATE_HISTORY_DECISION_LOCATOR_PATTERN.test(target.locator)) {
      throw new Error("writing-state operation decision target 越权。");
    }
  }
  const labelSequence = intent.targets.map((target) => target.label).join(",");
  const validSequence = intent.command === "novel_invalidate_writing_state_from"
    ? labelSequence === "control"
    : intent.command === "novel_review_chapter_state_candidate"
      ? labelSequence === "control,decision" || labelSequence === "control,state,decision"
      : intent.command === "novel_review_story_bible_candidate"
        ? labelSequence === "control,state,decision"
        : false;
  if (!validSequence) throw new Error("writing-state operation command/target 顺序无效。");
  const expectedOperationId = `novel-state-operation-${fingerprint({
    requestHash: intent.requestHash,
    command: intent.command,
  }).slice(0, 32)}`;
  if (intent.operationId !== expectedOperationId) {
    throw new Error("writing-state operationId 与 requestHash/command 不一致。");
  }
  return intent;
}

function validateHistoryOperationReceipt(value: unknown): WritingStateHistoryOperationReceipt {
  const receipt = validateFingerprintArtifact<WritingStateHistoryOperationReceipt>(
    value,
    "novel-writing-state-operation-receipt",
  );
  if (receipt.schemaVersion !== 1 || !SHA256_PATTERN.test(receipt.requestHash)
    || typeof receipt.operationId !== "string" || typeof receipt.command !== "string"
    || typeof receipt.projectId !== "string" || receipt.resultObjectName !== "result.json"
    || !SHA256_PATTERN.test(receipt.resultSha256)
    || !Number.isSafeInteger(receipt.resultByteLength) || receipt.resultByteLength < 1) {
    throw new Error("writing-state operation receipt 结构无效。");
  }
  return receipt;
}

function assertHistoryOperationReceiptMatchesIntent(
  receipt: WritingStateHistoryOperationReceipt,
  intent: WritingStateHistoryOperationIntent,
): void {
  if (receipt.operationId !== intent.operationId || receipt.requestHash !== intent.requestHash
    || receipt.projectId !== intent.projectId || receipt.command !== intent.command
    || receipt.resultObjectName !== intent.resultObjectName
    || receipt.resultSha256 !== intent.resultSha256
    || receipt.resultByteLength !== intent.resultByteLength
    || receipt.completedAt !== intent.createdAt) {
    throw new Error("writing-state operation completed receipt 与 intent 不一致。");
  }
}

function validateHistoryOperationLayout(
  value: unknown,
  expectedProjectId: string,
): WritingStateHistoryOperationLayout {
  const layout = validateFingerprintArtifact<WritingStateHistoryOperationLayout>(
    value,
    "novel-writing-state-operation-layout",
  );
  if (layout.schemaVersion !== 1 || layout.projectId !== expectedProjectId
    || layout.strategy !== "pending-markers-v1" || !Number.isFinite(Date.parse(layout.initializedAt))) {
    throw new Error("writing-state operation layout 结构或工程身份无效。");
  }
  return layout;
}

function validateHistoryOperationMarker(value: unknown): WritingStateHistoryOperationMarker {
  const marker = validateFingerprintArtifact<WritingStateHistoryOperationMarker>(
    value,
    "novel-writing-state-operation-marker",
  );
  if (marker.schemaVersion !== 1 || typeof marker.operationId !== "string"
    || !SHA256_PATTERN.test(marker.requestHash) || typeof marker.command !== "string"
    || typeof marker.projectId !== "string" || !SHA256_PATTERN.test(marker.intentFingerprint)
    || !Number.isFinite(Date.parse(marker.createdAt))) {
    throw new Error("writing-state operation marker 结构无效。");
  }
  return marker;
}

function historyOperationMarkerForIntent(
  intent: WritingStateHistoryOperationIntent,
): WritingStateHistoryOperationMarker {
  return artifactWithFingerprint({
    schemaVersion: 1 as const,
    kind: "novel-writing-state-operation-marker" as const,
    operationId: intent.operationId,
    requestHash: intent.requestHash,
    command: intent.command,
    projectId: intent.projectId,
    intentFingerprint: intent.fingerprint,
    createdAt: intent.createdAt,
  });
}

function assertHistoryOperationMarkerMatchesIntent(
  marker: WritingStateHistoryOperationMarker,
  intent: WritingStateHistoryOperationIntent,
): void {
  if (marker.operationId !== intent.operationId || marker.requestHash !== intent.requestHash
    || marker.command !== intent.command || marker.projectId !== intent.projectId
    || marker.intentFingerprint !== intent.fingerprint || marker.createdAt !== intent.createdAt) {
    throw new Error("writing-state operation marker 与 intent 不一致。");
  }
}

async function loadHistoryOperationLayout(
  projectRoot: string,
  expectedProjectId: string,
): Promise<WritingStateHistoryOperationLayout | null> {
  const bytes = await readOptionalProjectFile(
    projectRoot,
    WRITING_STATE_HISTORY_OPERATION_LAYOUT_RELATIVE_PATH,
    MAX_WRITING_ARTIFACT_BYTES,
  );
  return bytes
    ? validateHistoryOperationLayout(parseJson(bytes, "writing-state operation layout"), expectedProjectId)
    : null;
}

async function persistHistoryOperationLayout(projectRoot: string, expectedProjectId: string): Promise<void> {
  const layout = artifactWithFingerprint({
    schemaVersion: 1 as const,
    kind: "novel-writing-state-operation-layout" as const,
    projectId: expectedProjectId,
    strategy: "pending-markers-v1" as const,
    initializedAt: new Date().toISOString(),
  });
  await persistImmutableOrVerify(
    projectRoot,
    WRITING_STATE_HISTORY_OPERATION_LAYOUT_RELATIVE_PATH,
    jsonBytes(layout),
  );
}

async function registerHistoryOperationPending(
  projectRoot: string,
  intent: WritingStateHistoryOperationIntent,
): Promise<void> {
  if (!await loadHistoryOperationLayout(projectRoot, intent.projectId)) {
    throw new Error("writing-state operation pending 登记前缺少 layout。");
  }
  const marker = historyOperationMarkerForIntent(intent);
  const markerBytes = jsonBytes(marker);
  const completedBytes = await readOptionalProjectFile(
    projectRoot,
    historyOperationMarkerLocator("completed-markers", intent.requestHash),
    markerBytes.byteLength,
  );
  if (completedBytes) {
    const completed = validateHistoryOperationMarker(parseJson(completedBytes, "writing-state completed marker"));
    assertHistoryOperationMarkerMatchesIntent(completed, intent);
    return;
  }
  await persistImmutableOrVerify(
    projectRoot,
    historyOperationMarkerLocator("pending", intent.requestHash),
    markerBytes,
  );
}

async function finalizeHistoryOperationPending(
  projectRoot: string,
  intent: WritingStateHistoryOperationIntent,
): Promise<boolean> {
  if (!await loadHistoryOperationLayout(projectRoot, intent.projectId)) return false;
  const expectedMarker = historyOperationMarkerForIntent(intent);
  const expectedBytes = jsonBytes(expectedMarker);
  const completedLocator = historyOperationMarkerLocator("completed-markers", intent.requestHash);
  const pendingLocator = historyOperationMarkerLocator("pending", intent.requestHash);
  const completedBytes = await readOptionalProjectFile(projectRoot, completedLocator, expectedBytes.byteLength);
  const pendingBytes = await readOptionalProjectFile(projectRoot, pendingLocator, expectedBytes.byteLength);
  if (completedBytes) {
    const completed = validateHistoryOperationMarker(parseJson(completedBytes, "writing-state completed marker"));
    assertHistoryOperationMarkerMatchesIntent(completed, intent);
    if (pendingBytes) throw new Error("writing-state operation marker 同时存在 pending/completed 分叉。");
    return false;
  }
  if (!pendingBytes) return false;
  const pending = validateHistoryOperationMarker(parseJson(pendingBytes, "writing-state pending marker"));
  assertHistoryOperationMarkerMatchesIntent(pending, intent);
  if (!pendingBytes.equals(expectedBytes)) throw new Error("writing-state pending marker 字节身份不一致。");
  const pendingResolved = resolveNovelProjectLocator(projectRoot, pendingLocator);
  const pendingDirectory = await inspectExistingConfinedDirectory(projectRoot, path.dirname(pendingResolved.absolutePath));
  const pendingRead = await readConfinedRegularFileWithIdentity(
    pendingDirectory,
    path.basename(pendingResolved.absolutePath),
    expectedBytes.byteLength,
  );
  if (!pendingRead.bytes.equals(expectedBytes)) throw new Error("writing-state pending marker 在移动前发生变化。");
  const completedTarget = await ensureNovelCreateTargetParent(projectRoot, completedLocator);
  await moveConfinedFileNoReplaceCas(
    pendingRead.identity,
    sha256(pendingRead.bytes),
    pendingRead.bytes.byteLength,
    completedTarget.parent,
    completedTarget.name,
  );
  return true;
}

async function inspectHistoryOperationDirectory(
  projectRoot: string,
  requestHash: string,
): Promise<string[]> {
  const operationRoot = resolveNovelProjectLocator(
    projectRoot,
    `${WRITING_STATE_HISTORY_OPERATIONS_RELATIVE_PATH}/${requestHash}`,
  ).absolutePath;
  const entries = (await readdir(operationRoot)).sort((left, right) => left.localeCompare(right, "en"));
  for (const name of entries) {
    if (!WRITING_STATE_HISTORY_OPERATION_FILE_NAMES.has(name)) {
      throw new Error(`writing-state operation 包含未归属节点：${name}`);
    }
    const metadata = await lstat(path.join(operationRoot, name));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error(`writing-state operation 工件必须是单链接普通文件：${name}`);
    }
  }
  return entries;
}

async function assertHistoryOperationArtifactClosure(
  projectRoot: string,
  intent: WritingStateHistoryOperationIntent,
): Promise<string[]> {
  const entries = await inspectHistoryOperationDirectory(projectRoot, intent.requestHash);
  const expected = new Set([
    "intent.json",
    intent.resultObjectName,
    ...intent.targets.map((target) => target.afterObjectName),
  ]);
  if (entries.includes("completed.json")) expected.add("completed.json");
  if (entries.length !== expected.size || entries.some((name) => !expected.has(name))) {
    throw new Error("writing-state operation 工件闭包与 intent 不一致。");
  }
  return entries;
}

async function readHistoryMutableTarget(
  projectRoot: string,
  locator: string,
  maxBytes: number,
): Promise<Buffer | null> {
  return readOptionalProjectFile(projectRoot, locator, Math.max(maxBytes, 1));
}

async function replaceHistoryMutableTargetCas(
  projectRoot: string,
  locator: string,
  expectedSha256: string,
  expectedByteLength: number,
  afterBytes: Buffer,
): Promise<void> {
  const resolved = resolveNovelProjectLocator(projectRoot, locator);
  const directory = await inspectExistingConfinedDirectory(projectRoot, path.dirname(resolved.absolutePath));
  const read = await readConfinedRegularFileWithIdentity(
    directory,
    path.basename(resolved.absolutePath),
    Math.max(expectedByteLength, 1),
  );
  if (sha256(read.bytes) !== expectedSha256 || read.bytes.byteLength !== expectedByteLength) {
    throw new Error(`writing-state operation 目标已分叉：${locator}`);
  }
  await replaceConfinedBytesCas(read.identity, expectedSha256, expectedByteLength, afterBytes);
}

async function applyHistoryMutableTarget(
  projectRoot: string,
  intent: WritingStateHistoryOperationIntent,
  target: WritingStateHistoryMutableTarget,
): Promise<void> {
  const afterBytes = await readOptionalProjectFile(
    projectRoot,
    historyOperationLocator(intent.requestHash, target.afterObjectName),
    Math.max(target.afterByteLength, 1),
  );
  if (!afterBytes || sha256(afterBytes) !== target.afterSha256
    || afterBytes.byteLength !== target.afterByteLength) {
    throw new Error(`writing-state operation after 工件损坏：${target.label}`);
  }
  const current = await readHistoryMutableTarget(
    projectRoot,
    target.locator,
    Math.max(target.beforeByteLength ?? 0, target.afterByteLength),
  );
  if (current && sha256(current) === target.afterSha256 && current.byteLength === target.afterByteLength) return;
  if (target.beforeSha256 === null) {
    if (current) throw new Error(`writing-state operation 发现第三方分叉：${target.locator}`);
    await persistImmutableOrVerify(projectRoot, target.locator, afterBytes);
    return;
  }
  if (!current || sha256(current) !== target.beforeSha256
    || current.byteLength !== target.beforeByteLength) {
    throw new Error(`writing-state operation 发现第三方分叉：${target.locator}`);
  }
  await replaceHistoryMutableTargetCas(
    projectRoot,
    target.locator,
    target.beforeSha256,
    target.beforeByteLength!,
    afterBytes,
  );
}

async function recoverWritingStateHistoryIntent(
  projectRoot: string,
  intent: WritingStateHistoryOperationIntent,
): Promise<boolean> {
  const completedBytes = await readOptionalProjectFile(
    projectRoot,
    historyOperationLocator(intent.requestHash, "completed.json"),
    MAX_WRITING_ARTIFACT_BYTES,
  );
  if (completedBytes) {
    const receipt = validateHistoryOperationReceipt(parseJson(completedBytes, "writing-state operation receipt"));
    assertHistoryOperationReceiptMatchesIntent(receipt, intent);
    await assertHistoryOperationArtifactClosure(projectRoot, intent);
    return finalizeHistoryOperationPending(projectRoot, intent);
  }
  await assertHistoryOperationArtifactClosure(projectRoot, intent);
  for (const target of intent.targets) {
    await applyHistoryMutableTarget(projectRoot, intent, target);
    maybeInterruptWritingStateHistoryForTests(`after-${target.label}` as "after-state" | "after-control" | "after-decision");
  }
  const receipt = artifactWithFingerprint({
    schemaVersion: 1 as const,
    kind: "novel-writing-state-operation-receipt" as const,
    operationId: intent.operationId,
    requestHash: intent.requestHash,
    command: intent.command,
    projectId: intent.projectId,
    resultObjectName: intent.resultObjectName,
    resultSha256: intent.resultSha256,
    resultByteLength: intent.resultByteLength,
    completedAt: intent.createdAt,
  });
  await persistImmutableOrVerify(
    projectRoot,
    historyOperationLocator(intent.requestHash, "completed.json"),
    jsonBytes(receipt),
  );
  await finalizeHistoryOperationPending(projectRoot, intent);
  return true;
}

async function executeWritingStateHistoryOperation(input: {
  projectRoot: string;
  projectId: string;
  command: string;
  createdAt: string;
  targets: Array<{
    label: WritingStateHistoryMutableTarget["label"];
    locator: string;
    beforeBytes: Buffer | null;
    afterBytes: Buffer;
  }>;
  result: unknown;
}): Promise<{ replayed: boolean }> {
  const context = getOperationContext();
  if (!context || !SHA256_PATTERN.test(context.requestHash) || context.command !== input.command) {
    throw new Error("writing-state history 写入缺少匹配的 command operation context。");
  }
  if (!await loadHistoryOperationLayout(input.projectRoot, input.projectId)) {
    await recoverIncompleteNovelWritingStateOperations(input.projectRoot, input.projectId);
  }
  const resultBytes = jsonBytes(input.result);
  const targets = input.targets
    .filter((target) => !target.beforeBytes || !target.beforeBytes.equals(target.afterBytes))
    .map((target) => ({
      label: target.label,
      locator: target.locator,
      beforeSha256: target.beforeBytes ? sha256(target.beforeBytes) : null,
      beforeByteLength: target.beforeBytes?.byteLength ?? null,
      afterObjectName: `after-${target.label}.json`,
      afterSha256: sha256(target.afterBytes),
      afterByteLength: target.afterBytes.byteLength,
    } satisfies WritingStateHistoryMutableTarget));
  if (targets.length === 0) throw new Error("writing-state history operation 没有可提交目标。");
  const semantic = {
    schemaVersion: 1 as const,
    kind: "novel-writing-state-operation-intent" as const,
    operationId: `novel-state-operation-${fingerprint({ requestHash: context.requestHash, command: input.command }).slice(0, 32)}`,
    requestHash: context.requestHash,
    command: input.command,
    projectId: input.projectId,
    targets,
    resultObjectName: "result.json" as const,
    resultSha256: sha256(resultBytes),
    resultByteLength: resultBytes.byteLength,
    createdAt: input.createdAt,
  };
  const intent = artifactWithFingerprint(semantic);
  const existingIntentBytes = await readOptionalProjectFile(
    input.projectRoot,
    historyOperationLocator(context.requestHash, "intent.json"),
    MAX_WRITING_ARTIFACT_BYTES,
  );
  if (existingIntentBytes) {
    const existing = validateHistoryOperationIntent(parseJson(existingIntentBytes, "writing-state operation intent"));
    if (existing.fingerprint !== intent.fingerprint) {
      throw new Error("同 requestHash 的 writing-state history intent 与本次操作不同。");
    }
    await assertHistoryOperationArtifactClosure(input.projectRoot, existing);
    const existingCompletedBytes = await readOptionalProjectFile(
      input.projectRoot,
      historyOperationLocator(context.requestHash, "completed.json"),
      MAX_WRITING_ARTIFACT_BYTES,
    );
    if (!existingCompletedBytes) await registerHistoryOperationPending(input.projectRoot, existing);
    await recoverWritingStateHistoryIntent(input.projectRoot, existing);
    return { replayed: true };
  }
  const operationArtifacts: Array<{ name: string; bytes: Buffer }> = [];
  for (const target of input.targets) {
    const targetContract = targets.find((entry) => entry.label === target.label);
    if (!targetContract) continue;
    operationArtifacts.push({ name: targetContract.afterObjectName, bytes: target.afterBytes });
  }
  operationArtifacts.push(
    { name: "result.json", bytes: resultBytes },
    { name: "intent.json", bytes: jsonBytes(intent) },
  );
  const operationDirectory = await ensureConfinedDirectory(
    input.projectRoot,
    resolveNovelProjectLocator(
      input.projectRoot,
      `${WRITING_STATE_HISTORY_OPERATIONS_RELATIVE_PATH}/${context.requestHash}`,
    ).absolutePath,
  );
  await persistConfinedBytesNoReplaceBatch(operationDirectory, operationArtifacts, { commitName: "intent.json" });
  await assertHistoryOperationArtifactClosure(input.projectRoot, intent);
  await registerHistoryOperationPending(input.projectRoot, intent);
  maybeInterruptWritingStateHistoryForTests("after-intent");
  await recoverWritingStateHistoryIntent(input.projectRoot, intent);
  return { replayed: false };
}

const WRITING_STATE_HISTORY_OPERATION_ROOT_FIXED_ENTRIES = new Set([
  "layout.json",
  "pending",
  "completed-markers",
]);

async function listLegacyHistoryOperationNames(projectRoot: string): Promise<string[]> {
  const operationsRoot = resolveNovelProjectLocator(projectRoot, WRITING_STATE_HISTORY_OPERATIONS_RELATIVE_PATH).absolutePath;
  let entries: string[];
  try {
    entries = await readdir(operationsRoot);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const operationNames: string[] = [];
  for (const name of entries.sort()) {
    const metadata = await lstat(path.join(operationsRoot, name));
    if (WRITING_STATE_HISTORY_OPERATION_ROOT_FIXED_ENTRIES.has(name)) {
      const validLayout = name === "layout.json"
        ? metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1
        : metadata.isDirectory() && !metadata.isSymbolicLink();
      if (!validLayout) throw new Error(`writing-state operations 固定节点类型无效：${name}`);
      continue;
    }
    if (!SHA256_PATTERN.test(name)) throw new Error("writing-state operations 目录包含无法归属的节点。");
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("writing-state operation 节点必须是真实目录。");
    }
    operationNames.push(name);
  }
  return operationNames;
}

async function loadHistoryOperationIntentByHash(
  projectRoot: string,
  requestHash: string,
  expectedProjectId: string,
): Promise<{ intent: WritingStateHistoryOperationIntent | null; entries: string[] }> {
  const entries = await inspectHistoryOperationDirectory(projectRoot, requestHash);
  const intentBytes = await readOptionalProjectFile(
    projectRoot,
    historyOperationLocator(requestHash, "intent.json"),
    MAX_WRITING_ARTIFACT_BYTES,
  );
  if (!intentBytes) {
    if (entries.includes("completed.json")) {
      throw new Error("writing-state operation completed receipt 缺少 intent。");
    }
    return { intent: null, entries };
  }
  const intent = validateHistoryOperationIntent(parseJson(intentBytes, "writing-state operation intent"));
  if (intent.requestHash !== requestHash || intent.projectId !== expectedProjectId) {
    throw new Error("writing-state operation 目录、工程身份与 intent 不一致。");
  }
  await assertHistoryOperationArtifactClosure(projectRoot, intent);
  return { intent, entries };
}

async function recoverLegacyHistoryOperations(
  projectRoot: string,
  expectedProjectId: string,
): Promise<number> {
  let recovered = 0;
  for (const name of await listLegacyHistoryOperationNames(projectRoot)) {
    const { intent } = await loadHistoryOperationIntentByHash(projectRoot, name, expectedProjectId);
    if (intent && await recoverWritingStateHistoryIntent(projectRoot, intent)) recovered += 1;
  }
  return recovered;
}

async function inspectLegacyHistoryOperations(
  projectRoot: string,
  expectedProjectId: string,
): Promise<Array<{ requestHash: string; command: string; operationId: string }>> {
  const pending: Array<{ requestHash: string; command: string; operationId: string }> = [];
  for (const name of await listLegacyHistoryOperationNames(projectRoot)) {
    const { intent } = await loadHistoryOperationIntentByHash(projectRoot, name, expectedProjectId);
    if (!intent) continue;
    const completedBytes = await readOptionalProjectFile(
      projectRoot,
      historyOperationLocator(name, "completed.json"),
      MAX_WRITING_ARTIFACT_BYTES,
    );
    if (!completedBytes) pending.push({ requestHash: name, command: intent.command, operationId: intent.operationId });
    else assertHistoryOperationReceiptMatchesIntent(
      validateHistoryOperationReceipt(parseJson(completedBytes, "writing-state operation receipt")),
      intent,
    );
  }
  return pending;
}

async function listHistoryPendingMarkerHashes(projectRoot: string): Promise<string[]> {
  const pendingRoot = resolveNovelProjectLocator(
    projectRoot,
    WRITING_STATE_HISTORY_OPERATION_PENDING_RELATIVE_PATH,
  ).absolutePath;
  let entries: string[];
  try {
    entries = await readdir(pendingRoot);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const hashes: string[] = [];
  for (const name of entries.sort()) {
    const match = /^([a-f0-9]{64})\.json$/u.exec(name);
    if (!match) throw new Error("writing-state pending marker 目录包含无法归属的节点。");
    const metadata = await lstat(path.join(pendingRoot, name));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error("writing-state pending marker 必须是单链接普通文件。");
    }
    hashes.push(match[1]!);
  }
  return hashes;
}

async function loadValidatedHistoryPendingOperation(
  projectRoot: string,
  requestHash: string,
  expectedProjectId: string,
): Promise<WritingStateHistoryOperationIntent> {
  const markerBytes = await readOptionalProjectFile(
    projectRoot,
    historyOperationMarkerLocator("pending", requestHash),
    MAX_WRITING_ARTIFACT_BYTES,
  );
  if (!markerBytes) throw new Error("writing-state pending marker 在扫描期间消失。");
  const marker = validateHistoryOperationMarker(parseJson(markerBytes, "writing-state pending marker"));
  const { intent } = await loadHistoryOperationIntentByHash(projectRoot, requestHash, expectedProjectId);
  if (!intent) throw new Error("writing-state pending marker 缺少已提交 intent。");
  assertHistoryOperationMarkerMatchesIntent(marker, intent);
  return intent;
}

async function recoverPendingHistoryOperations(
  projectRoot: string,
  expectedProjectId: string,
): Promise<number> {
  let recovered = 0;
  for (const requestHash of await listHistoryPendingMarkerHashes(projectRoot)) {
    const intent = await loadValidatedHistoryPendingOperation(projectRoot, requestHash, expectedProjectId);
    if (await recoverWritingStateHistoryIntent(projectRoot, intent)) recovered += 1;
  }
  return recovered;
}

async function inspectPendingHistoryOperations(
  projectRoot: string,
  expectedProjectId: string,
): Promise<Array<{ requestHash: string; command: string; operationId: string }>> {
  const pending: Array<{ requestHash: string; command: string; operationId: string }> = [];
  for (const requestHash of await listHistoryPendingMarkerHashes(projectRoot)) {
    const intent = await loadValidatedHistoryPendingOperation(projectRoot, requestHash, expectedProjectId);
    const completedBytes = await readOptionalProjectFile(
      projectRoot,
      historyOperationLocator(requestHash, "completed.json"),
      MAX_WRITING_ARTIFACT_BYTES,
    );
    if (completedBytes) assertHistoryOperationReceiptMatchesIntent(
      validateHistoryOperationReceipt(parseJson(completedBytes, "writing-state operation receipt")),
      intent,
    );
    pending.push({ requestHash, command: intent.command, operationId: intent.operationId });
  }
  return pending;
}

export async function recoverIncompleteNovelWritingStateOperations(
  projectRoot: string,
  expectedProjectId: string,
): Promise<number> {
  if (await loadHistoryOperationLayout(projectRoot, expectedProjectId)) {
    return recoverPendingHistoryOperations(projectRoot, expectedProjectId);
  }
  const recovered = await recoverLegacyHistoryOperations(projectRoot, expectedProjectId);
  await persistHistoryOperationLayout(projectRoot, expectedProjectId);
  return recovered;
}

export async function loadNovelWritingStateOperationProof(
  projectRoot: string,
  requestHash: string,
): Promise<{ command: string; projectId: string; result: unknown } | null> {
  if (!SHA256_PATTERN.test(requestHash)) throw new Error("writing-state operation requestHash 无效。");
  const intentBytes = await readOptionalProjectFile(
    projectRoot,
    historyOperationLocator(requestHash, "intent.json"),
    MAX_WRITING_ARTIFACT_BYTES,
  );
  const completedBytes = await readOptionalProjectFile(
    projectRoot,
    historyOperationLocator(requestHash, "completed.json"),
    MAX_WRITING_ARTIFACT_BYTES,
  );
  if (!intentBytes || !completedBytes) return null;
  const intent = validateHistoryOperationIntent(parseJson(intentBytes, "writing-state operation intent"));
  const receipt = validateHistoryOperationReceipt(parseJson(completedBytes, "writing-state operation receipt"));
  if (intent.requestHash !== requestHash) throw new Error("writing-state operation proof 目录身份不一致。");
  assertHistoryOperationReceiptMatchesIntent(receipt, intent);
  await assertHistoryOperationArtifactClosure(projectRoot, intent);
  const resultBytes = await readOptionalProjectFile(
    projectRoot,
    historyOperationLocator(requestHash, intent.resultObjectName),
    Math.max(intent.resultByteLength, 1),
  );
  if (!resultBytes || resultBytes.byteLength !== intent.resultByteLength
    || sha256(resultBytes) !== intent.resultSha256) {
    throw new Error("writing-state operation proof result 损坏。");
  }
  return { command: intent.command, projectId: intent.projectId, result: parseJson(resultBytes, "writing-state operation result") };
}

async function inspectIncompleteNovelWritingStateOperations(
  projectRoot: string,
  expectedProjectId: string,
  options: { fullAudit?: boolean } = {},
): Promise<Array<{ requestHash: string; command: string; operationId: string }>> {
  const layout = await loadHistoryOperationLayout(projectRoot, expectedProjectId);
  if (!layout) return inspectLegacyHistoryOperations(projectRoot, expectedProjectId);
  const markerPending = await inspectPendingHistoryOperations(projectRoot, expectedProjectId);
  if (!options.fullAudit) return markerPending;
  const legacyPending = await inspectLegacyHistoryOperations(projectRoot, expectedProjectId);
  return [...new Map([...legacyPending, ...markerPending].map((entry) => [entry.requestHash, entry])).values()];
}

export async function getNovelWritingStateHistoryStatus(
  projectRoot: string,
  expectedProjectId: string,
  options: { verificationMode?: "head" | "full" } = {},
): Promise<{
  schemaVersion: 1;
  kind: "novel-writing-state-history-status";
  initialized: boolean;
  healthy: boolean;
  recoveryRequired: boolean;
  verificationMode: "head" | "full";
  verifiedEventCount: number;
  publicHead: NovelWritingStateHistoryControl["publicHead"] | null;
  activeRebuild: NovelWritingStateHistoryActiveRebuild | null;
  pendingOperations: Array<{ requestHash: string; command: string; operationId: string }>;
  issue: string | null;
  nextTools: Array<{ tool: string; argsMode: "partial"; args: Record<string, unknown>; requiredArgs: string[]; purpose: string }>;
}> {
  const verificationMode = options.verificationMode ?? "full";
  const publicState = await loadNovelPublicWritingState(projectRoot, expectedProjectId);
  if (!publicState) {
    return {
      schemaVersion: 1,
      kind: "novel-writing-state-history-status",
      initialized: false,
      healthy: false,
      recoveryRequired: false,
      verificationMode,
      verifiedEventCount: 0,
      publicHead: null,
      activeRebuild: null,
      pendingOperations: [],
      issue: "writing_state_missing",
      nextTools: [],
    };
  }
  const [control, pendingOperations] = await Promise.all([
    loadHistoryControl(projectRoot, expectedProjectId),
    inspectIncompleteNovelWritingStateOperations(projectRoot, expectedProjectId, {
      fullAudit: verificationMode === "full",
    }),
  ]);
  if (!control) {
    return {
      schemaVersion: 1,
      kind: "novel-writing-state-history-status",
      initialized: false,
      healthy: true,
      recoveryRequired: false,
      verificationMode,
      verifiedEventCount: 0,
      publicHead: null,
      activeRebuild: null,
      pendingOperations,
      issue: "legacy_history_not_initialized",
      nextTools: [],
    };
  }
  let issue: string | null = null;
  let verifiedEventCount = 0;
  try {
    if (control.publicHead.stateRevision !== publicState.revision
      || control.publicHead.stateFingerprint !== publicState.fingerprint) {
      throw new Error("public_head_mismatch");
    }
    await verifyHistoryHeadClosure({ projectRoot, projectId: expectedProjectId, head: control.publicHead, state: publicState });
    if (verificationMode === "full") {
      verifiedEventCount += await verifyHistoryLineageFromHead({
        projectRoot,
        projectId: expectedProjectId,
        headEventId: control.publicHead.headEventId,
        headCheckpointId: control.publicHead.checkpointId,
        headState: publicState,
      });
    } else {
      verifiedEventCount += control.publicHead.headEventId ? 1 : 0;
    }
    if (control.activeRebuild) {
      const shadow = await loadHistoryShadowState(projectRoot, control.activeRebuild, expectedProjectId);
      await verifyActiveRebuildClosure({ projectRoot, projectId: expectedProjectId, rebuild: control.activeRebuild, state: shadow });
      if (verificationMode === "full") {
        verifiedEventCount += await verifyHistoryLineageFromHead({
          projectRoot,
          projectId: expectedProjectId,
          headEventId: control.activeRebuild.shadowHeadEventId,
          headCheckpointId: control.activeRebuild.shadowCheckpointId,
          headState: shadow,
        });
      } else {
        verifiedEventCount += control.activeRebuild.shadowHeadEventId ? 1 : 0;
      }
    }
  } catch (error) {
    issue = error instanceof Error ? error.message : String(error);
  }
  const recoveryRequired = pendingOperations.length > 0;
  const nextTools = recoveryRequired ? [{
    tool: "execute_command" as const,
    argsMode: "partial" as const,
    args: { request: { command: "novel_recover_writing_state", payload: {} } },
    requiredArgs: ["projectRoot", "requestId", "idempotencyKey"],
    purpose: "按 intent 的 before/after 身份确定性收敛未完成 writing-state operation",
  }] : issue ? [{
    tool: "get_novel_state_rebuild_status" as const,
    argsMode: "partial" as const,
    args: {},
    requiredArgs: ["projectRoot"],
    purpose: "由 human owner 复核 history control/event/checkpoint/shadow 闭包；完整性错误禁止自动改写",
  }] : [];
  return {
    schemaVersion: 1,
    kind: "novel-writing-state-history-status",
    initialized: true,
    healthy: !issue && !recoveryRequired,
    recoveryRequired,
    verificationMode,
    verifiedEventCount,
    publicHead: control.publicHead,
    activeRebuild: control.activeRebuild ?? null,
    pendingOperations,
    issue,
    nextTools,
  };
}

export async function assertNovelWritingStateHistoryReadable(
  projectRoot: string,
  expectedProjectId: string,
): Promise<Awaited<ReturnType<typeof getNovelWritingStateHistoryStatus>>> {
  let status: Awaited<ReturnType<typeof getNovelWritingStateHistoryStatus>>;
  try {
    status = await getNovelWritingStateHistoryStatus(projectRoot, expectedProjectId, {
      verificationMode: "head",
    });
  } catch (error) {
    throw new NovelWritingStateRejectedError("Writing-state history 工件无法通过结构与指纹复验。", {
      reason: "state_history_integrity_mismatch",
      nextAction: `由 human owner 检查受管状态历史，禁止自动覆盖：${error instanceof Error ? error.message : String(error)}`,
      requiresHumanOwner: true,
    });
  }
  if (status.recoveryRequired) {
    throw new NovelWritingStateRejectedError("Writing-state 存在已提交但未收敛的 operation，读取写章上下文前必须恢复。", {
      reason: "state_history_recovery_required",
      nextAction: "执行 novel_recover_writing_state；恢复器只接受 intent 声明的 before/after 身份，第三种 SHA 会失败关闭",
      nextTools: status.nextTools,
    });
  }
  if (status.initialized && !status.healthy) {
    throw new NovelWritingStateRejectedError("Writing-state history control/event/checkpoint/shadow 闭包不完整。", {
      reason: "state_history_integrity_mismatch",
      nextAction: `由 human owner 检查受管状态历史，禁止自动覆盖：${status.issue ?? "unknown_history_issue"}`,
      requiresHumanOwner: true,
      nextTools: status.nextTools,
    });
  }
  return status;
}

function createHistoryCommitEvent(input: {
  projectId: string;
  lineageId: string;
  parentEventId: string | null;
  beforeCheckpointId: string;
  operationKind: NovelWritingStateCommitEvent["operationKind"];
  chapter?: NovelChapterSourceIdentity;
  candidateId?: string;
  candidateFingerprint?: string;
  decisionId?: string;
  decisionFingerprint?: string;
  contribution?: "changes" | "no_change";
  beforeState: NovelWritingStateDocument;
  afterState: NovelWritingStateDocument;
  temporalManifestDigest: string;
  coverageMode: "complete" | "head_only";
  coverageBaseChapterId: string;
  createdAt: string;
}): { event: NovelWritingStateCommitEvent; checkpoint: NovelWritingStateCheckpoint } {
  const eventId = `novel-state-event-${fingerprint({
    projectId: input.projectId,
    lineageId: input.lineageId,
    parentEventId: input.parentEventId,
    beforeCheckpointId: input.beforeCheckpointId,
    operationKind: input.operationKind,
    candidateId: input.candidateId ?? null,
    beforeStateFingerprint: input.beforeState.fingerprint,
    afterStateFingerprint: input.afterState.fingerprint,
  }).slice(0, 32)}`;
  const checkpoint = createHistoryCheckpoint({
    projectId: input.projectId,
    lineageId: input.lineageId,
    headEventId: eventId,
    coverageMode: input.coverageMode,
    coverageBaseChapterId: input.coverageBaseChapterId,
    state: input.afterState,
    createdAt: input.createdAt,
  });
  const event = artifactWithFingerprint({
    schemaVersion: 1 as const,
    kind: "novel-writing-state-commit-event" as const,
    eventId,
    projectId: input.projectId,
    lineageId: input.lineageId,
    parentEventId: input.parentEventId,
    operationKind: input.operationKind,
    ...(input.chapter ? { chapter: input.chapter } : {}),
    ...(input.candidateId ? { candidateId: input.candidateId } : {}),
    ...(input.candidateFingerprint ? { candidateFingerprint: input.candidateFingerprint } : {}),
    ...(input.decisionId ? { decisionId: input.decisionId } : {}),
    ...(input.decisionFingerprint ? { decisionFingerprint: input.decisionFingerprint } : {}),
    ...(input.contribution ? { contribution: input.contribution } : {}),
    beforeStateRevision: input.beforeState.revision,
    beforeStateFingerprint: input.beforeState.fingerprint,
    beforeCheckpointId: input.beforeCheckpointId,
    afterStateRevision: input.afterState.revision,
    afterStateFingerprint: input.afterState.fingerprint,
    checkpointId: checkpoint.checkpointId,
    temporalManifestDigest: input.temporalManifestDigest,
    createdAt: input.createdAt,
  });
  return { event, checkpoint };
}

async function commitPublicWritingStateHistoryTransition(input: {
  projectRoot: string;
  snapshot: NovelWorkspaceSnapshot;
  command: string;
  beforeState: NovelWritingStateDocument;
  afterState: NovelWritingStateDocument;
  operationKind: Extract<NovelWritingStateCommitEvent["operationKind"], "chapter_state_commit" | "story_bible_commit">;
  chapter?: NovelChapterSourceIdentity;
  candidateId: string;
  candidateFingerprint: string;
  contribution?: "changes" | "no_change";
  decision: NovelChapterStateDecision | NovelStoryBibleDecision;
  decisionLocator: string;
  result: unknown;
}): Promise<void> {
  const publicState = await loadNovelPublicWritingState(input.projectRoot, input.snapshot.workspace.projectId);
  if (!publicState || publicState.fingerprint !== input.beforeState.fingerprint
    || publicState.revision !== input.beforeState.revision) {
    throw new Error("history transition 的公开 writing-state before 身份不一致。");
  }
  const control = await ensureHistoryControlForPublicState(input.projectRoot, publicState);
  if (control.activeRebuild) throw new Error("active rebuild 不能走公开 forward history transition。");
  const { event, checkpoint } = createHistoryCommitEvent({
    projectId: input.snapshot.workspace.projectId,
    lineageId: control.publicHead.lineageId,
    parentEventId: control.publicHead.headEventId,
    beforeCheckpointId: control.publicHead.checkpointId,
    operationKind: input.operationKind,
    ...(input.chapter ? { chapter: input.chapter } : {}),
    candidateId: input.candidateId,
    candidateFingerprint: input.candidateFingerprint,
    decisionId: input.decision.decisionId,
    decisionFingerprint: input.decision.fingerprint,
    ...(input.contribution ? { contribution: input.contribution } : {}),
    beforeState: input.beforeState,
    afterState: input.afterState,
    temporalManifestDigest: temporalManifestDigest(input.snapshot),
    coverageMode: control.publicHead.coverageMode,
    coverageBaseChapterId: control.publicHead.coverageBaseChapterId,
    createdAt: input.afterState.updatedAt,
  });
  await persistHistoryCheckpoint(input.projectRoot, checkpoint);
  await persistHistoryEvent(input.projectRoot, event);
  const nextControl = historyControlWithFingerprint({
    ...control,
    revision: control.revision + 1,
    publicHead: {
      ...control.publicHead,
      headEventId: event.eventId,
      checkpointId: checkpoint.checkpointId,
      stateRevision: input.afterState.revision,
      stateFingerprint: input.afterState.fingerprint,
      throughChapterId: input.afterState.currentThroughChapterId,
    },
    updatedAt: input.afterState.updatedAt,
  });
  await executeWritingStateHistoryOperation({
    projectRoot: input.projectRoot,
    projectId: input.snapshot.workspace.projectId,
    command: input.command,
    createdAt: input.afterState.updatedAt,
    targets: [
      {
        label: "control",
        locator: WRITING_STATE_HISTORY_CONTROL_RELATIVE_PATH,
        beforeBytes: jsonBytes(control),
        afterBytes: jsonBytes(nextControl),
      },
      {
        label: "state",
        locator: NOVEL_WRITING_STATE_RELATIVE_PATH,
        beforeBytes: jsonBytes(input.beforeState),
        afterBytes: jsonBytes(input.afterState),
      },
      {
        label: "decision",
        locator: input.decisionLocator,
        beforeBytes: null,
        afterBytes: jsonBytes(input.decision),
      },
    ],
    result: input.result,
  });
}

async function commitShadowWritingStateHistoryTransition(input: {
  projectRoot: string;
  snapshot: NovelWorkspaceSnapshot;
  beforeState: NovelWritingStateDocument;
  afterState: NovelWritingStateDocument;
  candidate: NovelChapterStateCandidate;
  decision: NovelChapterStateDecision;
  result: unknown;
}): Promise<void> {
  const publicState = await loadNovelPublicWritingState(input.projectRoot, input.snapshot.workspace.projectId);
  if (!publicState) throw new Error("shadow transition 缺少公开 writing-state。");
  const control = await loadHistoryControl(input.projectRoot, publicState.projectId);
  const active = control?.activeRebuild;
  if (!control || !active) throw new Error("shadow transition 缺少 active rebuild control。");
  if (control.publicHead.stateRevision !== publicState.revision
    || control.publicHead.stateFingerprint !== publicState.fingerprint
    || active.shadowStateRevision !== input.beforeState.revision
    || active.shadowStateFingerprint !== input.beforeState.fingerprint
    || active.nextChapterId !== input.candidate.chapter.chapterId
    || active.temporalManifestDigest !== temporalManifestDigest(input.snapshot)
    || active.manifestRevision !== input.snapshot.chapters!.revision) {
    rejectWritingState("状态重建上下文或正文时序已漂移。", {
      reason: "revision_conflict",
      chapterId: active.nextChapterId,
      candidateId: input.candidate.candidateId,
      nextAction: "重新读取 rebuild 状态并重新规划；禁止盲目继续旧 shadow queue",
    });
  }
  const finalPromotion = !input.afterState.rebuild;
  const { event, checkpoint } = createHistoryCommitEvent({
    projectId: publicState.projectId,
    lineageId: active.lineageId,
    parentEventId: active.shadowHeadEventId,
    beforeCheckpointId: active.shadowCheckpointId,
    operationKind: finalPromotion ? "rebuild_promotion" : "rebuild_shadow_commit",
    chapter: input.candidate.chapter,
    candidateId: input.candidate.candidateId,
    candidateFingerprint: input.candidate.fingerprint,
    decisionId: input.decision.decisionId,
    decisionFingerprint: input.decision.fingerprint,
    contribution: input.candidate.changeKind === "no_state_change" ? "no_change" : "changes",
    beforeState: input.beforeState,
    afterState: input.afterState,
    temporalManifestDigest: active.temporalManifestDigest,
    coverageMode: control.publicHead.coverageMode,
    coverageBaseChapterId: control.publicHead.coverageBaseChapterId,
    createdAt: input.afterState.updatedAt,
  });
  await persistHistoryCheckpoint(input.projectRoot, checkpoint);
  await persistHistoryEvent(input.projectRoot, event);

  if (!finalPromotion) {
    const shadowStateLocator = historyShadowStateLocator(active.rebuildId, input.afterState.fingerprint);
    await persistImmutableOrVerify(input.projectRoot, shadowStateLocator, jsonBytes(input.afterState));
    const rebuild = input.afterState.rebuild!;
    const nextActive: NovelWritingStateHistoryActiveRebuild = {
      ...active,
      pendingChapterIds: [...rebuild.pendingChapterIds],
      nextChapterId: rebuild.nextChapterId,
      shadowHeadEventId: event.eventId,
      shadowCheckpointId: checkpoint.checkpointId,
      shadowStateLocator,
      shadowStateRevision: input.afterState.revision,
      shadowStateFingerprint: input.afterState.fingerprint,
    };
    const nextControl = historyControlWithFingerprint({
      ...control,
      revision: control.revision + 1,
      activeRebuild: nextActive,
      updatedAt: input.afterState.updatedAt,
    });
    await executeWritingStateHistoryOperation({
      projectRoot: input.projectRoot,
      projectId: publicState.projectId,
      command: "novel_review_chapter_state_candidate",
      createdAt: input.afterState.updatedAt,
      targets: [
        {
          label: "control",
          locator: WRITING_STATE_HISTORY_CONTROL_RELATIVE_PATH,
          beforeBytes: jsonBytes(control),
          afterBytes: jsonBytes(nextControl),
        },
        {
          label: "decision",
          locator: decisionLocator(input.candidate.candidateId),
          beforeBytes: null,
          afterBytes: jsonBytes(input.decision),
        },
      ],
      result: input.result,
    });
    return;
  }

  const nextControl = historyControlWithFingerprint({
    ...control,
    revision: control.revision + 1,
    publicHead: {
      lineageId: active.lineageId,
      headEventId: event.eventId,
      checkpointId: checkpoint.checkpointId,
      stateRevision: input.afterState.revision,
      stateFingerprint: input.afterState.fingerprint,
      throughChapterId: input.afterState.currentThroughChapterId,
      coverageMode: control.publicHead.coverageMode,
      coverageBaseChapterId: control.publicHead.coverageBaseChapterId,
    },
    activeRebuild: undefined,
    updatedAt: input.afterState.updatedAt,
  });
  const { activeRebuild: _activeRebuild, ...controlWithoutUndefined } = nextControl;
  const promotedControl = historyControlWithFingerprint((({ fingerprint: _fingerprint, ...semantic }) => semantic)(controlWithoutUndefined));
  await executeWritingStateHistoryOperation({
    projectRoot: input.projectRoot,
    projectId: publicState.projectId,
    command: "novel_review_chapter_state_candidate",
    createdAt: input.afterState.updatedAt,
    targets: [
      {
        label: "control",
        locator: WRITING_STATE_HISTORY_CONTROL_RELATIVE_PATH,
        beforeBytes: jsonBytes(control),
        afterBytes: jsonBytes(promotedControl),
      },
      {
        label: "state",
        locator: NOVEL_WRITING_STATE_RELATIVE_PATH,
        beforeBytes: jsonBytes(publicState),
        afterBytes: jsonBytes(input.afterState),
      },
      {
        label: "decision",
        locator: decisionLocator(input.candidate.candidateId),
        beforeBytes: null,
        afterBytes: jsonBytes(input.decision),
      },
    ],
    result: input.result,
  });
}

interface NovelChapterWriteLeaseRecord {
  chapterId: string;
  leaseId: string;
  fence: number;
  status: "active" | "released";
  actorFingerprint: string;
  tokenSha256: string;
  targetChapterRevision: number;
  targetChapterSha256: string;
  writingStateRevision: number;
  writingStateFingerprint: string;
  contextPackFingerprint: string;
  preflightId: string;
  contextPackReceipt?: NovelContextPackReceipt;
  expiresAt: string;
  updatedAt: string;
}

interface NovelChapterWriteLeaseDocument {
  schemaVersion: 1;
  kind: "novel-chapter-write-leases";
  projectId: string;
  revision: number;
  leases: NovelChapterWriteLeaseRecord[];
  updatedAt: string;
  fingerprint: string;
}

function leaseDocumentWithFingerprint(
  value: Omit<NovelChapterWriteLeaseDocument, "fingerprint">,
): NovelChapterWriteLeaseDocument {
  return { ...value, fingerprint: fingerprint(value) };
}

const RECEIPT_TRACE_SECTIONS = new Set([
  "hardCanon",
  "taskBrief",
  "entities",
  "characterProfiles",
  "characterAppearances",
  "characterStates",
  "knowledge",
  "relationships",
  "timeline",
  "foreshadowing",
  "excerpts",
]);

function isSafeReceiptIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 500
    && value === value.normalize("NFC").trim()
    && !/[\p{Cc}]/u.test(value)
    && !path.isAbsolute(value)
    && !/^[a-zA-Z]:[\\/]/u.test(value);
}

function validateContextPackReceipt(value: unknown): NovelContextPackReceipt {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "novel-context-pack-receipt"
    || !isRecord(value.targetChapter)
    || !isSafeReceiptIdentifier(value.targetChapter.chapterId)
    || !Number.isSafeInteger(value.targetChapter.revision)
    || Number(value.targetChapter.revision) < 1
    || typeof value.targetChapter.sha256 !== "string"
    || !SHA256_PATTERN.test(value.targetChapter.sha256)
    || !(value.cutoffChapterId === null || isSafeReceiptIdentifier(value.cutoffChapterId))
    || !Number.isSafeInteger(value.manifestRevision)
    || Number(value.manifestRevision) < 1
    || !Number.isSafeInteger(value.writingStateRevision)
    || Number(value.writingStateRevision) < 1
    || typeof value.writingStateFingerprint !== "string"
    || !SHA256_PATTERN.test(value.writingStateFingerprint)
    || typeof value.contextPackFingerprint !== "string"
    || !SHA256_PATTERN.test(value.contextPackFingerprint)
    || typeof value.preflightId !== "string"
    || !PREFLIGHT_ID_PATTERN.test(value.preflightId)
    || value.ready !== true
    || !Array.isArray(value.nextTools)
    || !isRecord(value.selectionTrace)
    || typeof value.fingerprint !== "string"
    || !SHA256_PATTERN.test(value.fingerprint)) {
    throw new Error("Context Pack receipt 结构或身份无效。");
  }
  for (const nextTool of value.nextTools) {
    if (!isRecord(nextTool)
      || !isSafeReceiptIdentifier(nextTool.tool)
      || typeof nextTool.purpose !== "string"
      || nextTool.purpose.length === 0
      || nextTool.purpose.length > 1_000
      || /[\p{Cc}]/u.test(nextTool.purpose)) {
      throw new Error("Context Pack receipt nextTools 无效。");
    }
  }
  const trace = value.selectionTrace;
  if (trace.schemaVersion !== 1
    || trace.kind !== "novel-context-pack-selection-trace"
    || trace.targetChapterId !== value.targetChapter.chapterId
    || trace.cutoffChapterId !== value.cutoffChapterId
    || !["continue_chapter", "revise_chapter", "review_chapter"].includes(String(trace.taskType))
    || !["formal", "rehearsal"].includes(String(trace.workflowMode))
    || !Array.isArray(trace.requiredCharacterIds)
    || trace.requiredCharacterIds.some((entry) => !isSafeReceiptIdentifier(entry))
    || !isRecord(trace.budget)
    || !Number.isSafeInteger(trace.budget.maximumCharacters)
    || !Number.isSafeInteger(trace.budget.usedCharacters)
    || !Number.isSafeInteger(trace.budget.reservedCharacters)
    || !Array.isArray(trace.budget.partitions)
    || !Array.isArray(trace.entries)
    || !isRecord(trace.policies)
    || trace.policies.chapterBrief !== "exact_target_chapter"
    || trace.policies.hardCanon !== "writer_visible_only"
    || trace.policies.futureChapters !== "excluded_after_cutoff"
    || trace.policies.authorOnlyCanon !== "excluded_without_receipt_entry"
    || trace.policies.absolutePaths !== "never_persisted"
    || trace.policies.uiRecomputation !== "forbidden") {
    throw new Error("Context Pack receipt selection trace 无效。");
  }
  for (const partition of trace.budget.partitions) {
    if (!isRecord(partition)
      || !["hard_requirements", "required_cast", "critical_memory", "recent_chapters"].includes(String(partition.partitionId))
      || !["protected", "compressible"].includes(String(partition.protection))
      || !["always_include", "fail_on_omission", "fit_remaining_budget"].includes(String(partition.policy))
      || !Number.isSafeInteger(partition.usedCharacters)
      || !Number.isSafeInteger(partition.includedItems)
      || !Number.isSafeInteger(partition.omittedItems)) {
      throw new Error("Context Pack receipt budget partition 无效。");
    }
  }
  for (const entry of trace.entries) {
    if (!isRecord(entry)
      || !RECEIPT_TRACE_SECTIONS.has(String(entry.section))
      || !isSafeReceiptIdentifier(entry.itemId)
      || !["included", "omitted"].includes(String(entry.disposition))
      || !["writing_state", "managed_chapter"].includes(String(entry.source))
      || !Array.isArray(entry.sourceIds)
      || entry.sourceIds.some((sourceId) => !isSafeReceiptIdentifier(sourceId))
      || !["protected", "compressible"].includes(String(entry.protection))
      || !(entry.priority === undefined || (Number.isSafeInteger(entry.priority) && Number(entry.priority) >= 0))
      || !Number.isSafeInteger(entry.characterCost)
      || Number(entry.characterCost) < 0
      || typeof entry.rule !== "string"
      || entry.rule.length === 0
      || typeof entry.reason !== "string"
      || entry.reason.length === 0) {
      throw new Error("Context Pack receipt trace entry 无效。");
    }
  }
  const { fingerprint: stored, ...semantic } = value;
  if (fingerprint(semantic) !== stored) throw new Error("Context Pack receipt fingerprint 复验失败。");
  return value as unknown as NovelContextPackReceipt;
}

function validateLeaseDocument(value: unknown, projectId: string): NovelChapterWriteLeaseDocument {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "novel-chapter-write-leases"
    || value.projectId !== projectId
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 1
    || !Array.isArray(value.leases)
    || typeof value.fingerprint !== "string") {
    throw new Error("chapter-write-leases.json 结构或工程身份无效。");
  }
  const { fingerprint: stored, ...semantic } = value;
  if (fingerprint(semantic) !== stored) throw new Error("chapter-write-leases.json fingerprint 复验失败。");
  for (const lease of value.leases) {
    if (!isRecord(lease)) throw new Error("chapter-write-leases.json lease 条目无效。");
    if (lease.contextPackReceipt !== undefined) {
      const receipt = validateContextPackReceipt(lease.contextPackReceipt);
      if (receipt.targetChapter.chapterId !== lease.chapterId
        || receipt.targetChapter.revision !== lease.targetChapterRevision
        || receipt.targetChapter.sha256 !== lease.targetChapterSha256
        || receipt.contextPackFingerprint !== lease.contextPackFingerprint
        || receipt.preflightId !== lease.preflightId
        || receipt.writingStateRevision !== lease.writingStateRevision
        || receipt.writingStateFingerprint !== lease.writingStateFingerprint) {
        throw new Error("chapter-write-leases.json receipt 与 lease 身份不一致。");
      }
    }
  }
  return value as unknown as NovelChapterWriteLeaseDocument;
}

async function loadLeaseDocument(projectRoot: string, projectId: string): Promise<NovelChapterWriteLeaseDocument | null> {
  const bytes = await readOptionalProjectFile(projectRoot, CHAPTER_WRITE_LEASES_RELATIVE_PATH, MAX_WRITING_ARTIFACT_BYTES);
  return bytes ? validateLeaseDocument(parseJson(bytes, "chapter-write-leases.json"), projectId) : null;
}

async function persistLeaseDocument(
  projectRoot: string,
  expected: NovelChapterWriteLeaseDocument | null,
  next: NovelChapterWriteLeaseDocument,
): Promise<void> {
  const nextBytes = jsonBytes(next);
  if (!expected) {
    const target = await ensureNovelCreateTargetParent(projectRoot, CHAPTER_WRITE_LEASES_RELATIVE_PATH);
    const persisted = await persistConfinedBytesNoReplace(target.parent, target.name, nextBytes);
    if (!persisted.created || persisted.sha256 !== sha256(nextBytes)) throw new Error("章节写租约文件创建回执无效。");
    return;
  }
  const resolved = resolveNovelProjectLocator(projectRoot, CHAPTER_WRITE_LEASES_RELATIVE_PATH);
  const directory = await inspectExistingConfinedDirectory(projectRoot, path.dirname(resolved.absolutePath));
  const read = await readConfinedRegularFileWithIdentity(directory, path.basename(resolved.absolutePath), MAX_WRITING_ARTIFACT_BYTES);
  const current = validateLeaseDocument(parseJson(read.bytes, "chapter-write-leases.json"), expected.projectId);
  if (current.revision !== expected.revision || current.fingerprint !== expected.fingerprint) {
    rejectWritingState("章节写租约 CAS 已变化。", {
      reason: "chapter_write_lease_conflict",
      expectedRevision: expected.revision,
      currentRevision: current.revision,
      expectedFingerprint: expected.fingerprint,
      currentFingerprint: current.fingerprint,
      nextAction: "重新执行 prepare_novel_chapter_write",
    });
  }
  await replaceConfinedBytesCas(read.identity, sha256(read.bytes), read.bytes.byteLength, nextBytes);
}

function actorFingerprint(attribution: NovelActorAttribution): string {
  for (const [key, value] of Object.entries(attribution)) {
    if (typeof value !== "string" || value.length === 0 || value.length > 500
      || value !== value.normalize("NFC").trim() || /[\p{Cc}]/u.test(value)) {
      throw new Error(`novel actor attribution.${key} 无效。`);
    }
  }
  return fingerprint(attribution);
}

export async function acquireNovelChapterWriteLease(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
  input: NovelAcquireChapterWriteLeaseInput,
) {
  requireManagedSnapshot(snapshot);
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 1_800) {
    throw new Error("章节写租约 ttlSeconds 必须为 60–1800 秒。");
  }
  const state = await loadNovelWritingState(projectRoot, snapshot.workspace.projectId);
  if (!state) rejectWritingState("写作状态尚未初始化。", { reason: "writing_state_missing", chapterId: input.targetChapterId });
  const currentPreflight = deriveNovelWritePreflight(snapshot, state, {
    targetChapterId: input.targetChapterId,
    contextPackFingerprint: input.contextPackFingerprint,
    characterIds: input.characterIds,
    workflowMode: input.workflowMode,
  });
  if (!currentPreflight.ready || currentPreflight.preflightId !== input.preflightId) {
    rejectWritingState("获取章节写租约时 preflight 已过期或未通过。", {
      reason: "context_preflight_stale",
      chapterId: input.targetChapterId,
      expectedFingerprint: input.contextPackFingerprint,
      currentFingerprint: currentPreflight.contextPackFingerprint,
      nextAction: "重新生成 Context Pack 与 preflight 后再 prepare",
    });
  }
  const chapter = requireChapter(snapshot, input.targetChapterId);
  const contextPackReceipt = input.contextPackReceipt === undefined
    ? undefined
    : validateContextPackReceipt(input.contextPackReceipt);
  if (contextPackReceipt && (contextPackReceipt.targetChapter.chapterId !== chapter.chapterId
    || contextPackReceipt.targetChapter.revision !== chapter.revision
    || contextPackReceipt.targetChapter.sha256 !== chapter.sha256
    || contextPackReceipt.cutoffChapterId !== currentPreflight.cutoffChapterId
    || contextPackReceipt.manifestRevision !== snapshot.chapters!.revision
    || contextPackReceipt.writingStateRevision !== state.revision
    || contextPackReceipt.writingStateFingerprint !== state.fingerprint
    || contextPackReceipt.contextPackFingerprint !== input.contextPackFingerprint
    || contextPackReceipt.preflightId !== input.preflightId
    || contextPackReceipt.selectionTrace.workflowMode !== input.workflowMode
    || JSON.stringify(contextPackReceipt.selectionTrace.requiredCharacterIds)
      !== JSON.stringify([...input.characterIds].sort((left, right) => left.localeCompare(right, "en"))))) {
    rejectWritingState("Context Pack receipt 与当前章节、状态或 preflight 身份不一致。", {
      reason: "context_preflight_stale",
      chapterId: input.targetChapterId,
      nextAction: "重新执行 prepare_novel_chapter_write 获取同一 CAS 中签发的 receipt 与租约",
    });
  }
  const holderFingerprint = actorFingerprint(input.attribution);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const current = await loadLeaseDocument(projectRoot, snapshot.workspace.projectId);
  const prior = current?.leases.find((lease) => lease.chapterId === input.targetChapterId);
  if (prior?.status === "active"
    && prior.targetChapterRevision === chapter.revision
    && prior.targetChapterSha256 === chapter.sha256
    && Date.parse(prior.expiresAt) > nowMs) {
    rejectWritingState("目标章节已有未过期写租约。", {
      reason: "chapter_write_lease_conflict",
      chapterId: input.targetChapterId,
      nextAction: `等待租约 ${prior.leaseId} 于 ${prior.expiresAt} 到期，或由持有者显式释放`,
    });
  }
  const token = `novel-lease-token-${randomBytes(32).toString("base64url")}`;
  const tokenSha256 = sha256(token);
  const fence = (prior?.fence ?? 0) + 1;
  const leaseId = `novel-write-lease-${fingerprint({
    projectId: snapshot.workspace.projectId,
    chapter: chapterIdentity(chapter),
    stateFingerprint: state.fingerprint,
    holderFingerprint,
    fence,
    tokenSha256,
  }).slice(0, 24)}`;
  const lease: NovelChapterWriteLeaseRecord = {
    chapterId: input.targetChapterId,
    leaseId,
    fence,
    status: "active",
    actorFingerprint: holderFingerprint,
    tokenSha256,
    targetChapterRevision: chapter.revision,
    targetChapterSha256: chapter.sha256,
    writingStateRevision: state.revision,
    writingStateFingerprint: state.fingerprint,
    contextPackFingerprint: input.contextPackFingerprint,
    preflightId: input.preflightId,
    ...(contextPackReceipt ? { contextPackReceipt } : {}),
    expiresAt: new Date(nowMs + input.ttlSeconds * 1_000).toISOString(),
    updatedAt: now,
  };
  const next = leaseDocumentWithFingerprint({
    schemaVersion: 1,
    kind: "novel-chapter-write-leases",
    projectId: snapshot.workspace.projectId,
    revision: (current?.revision ?? 0) + 1,
    leases: [...(current?.leases ?? []).filter((entry) => {
      if (entry.chapterId === input.targetChapterId || entry.status !== "active" || Date.parse(entry.expiresAt) <= nowMs) return false;
      const currentChapter = snapshot.chapters?.chapters.find((chapterEntry) => chapterEntry.chapterId === entry.chapterId);
      return Boolean(currentChapter
        && currentChapter.revision === entry.targetChapterRevision
        && currentChapter.sha256 === entry.targetChapterSha256);
    }), lease]
      .sort((left, right) => left.chapterId.localeCompare(right.chapterId, "en")),
    updatedAt: now,
  });
  await persistLeaseDocument(projectRoot, current, next);
  const { tokenSha256: _hiddenTokenSha256, ...publicLease } = lease;
  return { lease: publicLease, leaseToken: token, actorFingerprint: holderFingerprint };
}

export async function getNovelChapterWriteLeaseStatus(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
  chapterId: string,
) {
  requireManagedSnapshot(snapshot);
  const chapter = requireChapter(snapshot, chapterId);
  const current = await loadLeaseDocument(projectRoot, snapshot.workspace.projectId);
  const lease = current?.leases.find((entry) => entry.chapterId === chapterId);
  if (!lease) return { held: false as const, fence: 0 };
  const currentIdentity = lease.targetChapterRevision === chapter.revision
    && lease.targetChapterSha256 === chapter.sha256;
  const active = lease.status === "active" && currentIdentity && Date.parse(lease.expiresAt) > Date.now();
  return active
    ? {
      held: true as const,
      leaseId: lease.leaseId,
      fence: lease.fence,
      expiresAt: lease.expiresAt,
      targetChapterRevision: lease.targetChapterRevision,
      targetChapterSha256: lease.targetChapterSha256,
      ...(lease.contextPackReceipt ? { contextPackReceipt: lease.contextPackReceipt } : {}),
    }
    : { held: false as const, fence: lease.fence };
}

export async function assertNovelChapterWriteLease(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
  chapterId: string,
  context: NovelAiWriteContext,
  runtime: NovelChapterWriteLeaseRuntime | undefined,
): Promise<void> {
  if (!context.leaseId || !context.leaseFence || !context.actorFingerprint || !runtime) {
    rejectWritingState("正式 Agent 写章缺少 prepare 签发的章节写租约。", {
      reason: "chapter_write_lease_required",
      chapterId,
      nextAction: "执行 prepare_novel_chapter_write，并原样携带 leaseId/fence/actorFingerprint 与 leaseToken",
    });
  }
  const current = await loadLeaseDocument(projectRoot, snapshot.workspace.projectId);
  const lease = current?.leases.find((entry) => entry.chapterId === chapterId);
  const runtimeActorFingerprint = actorFingerprint(runtime.attribution);
  const chapter = requireChapter(snapshot, chapterId);
  if (!lease
    || lease.status !== "active"
    || lease.leaseId !== context.leaseId
    || lease.fence !== context.leaseFence
    || lease.actorFingerprint !== context.actorFingerprint
    || lease.actorFingerprint !== runtimeActorFingerprint
    || lease.tokenSha256 !== sha256(runtime.leaseToken)
    || lease.targetChapterRevision !== chapter.revision
    || lease.targetChapterSha256 !== chapter.sha256
    || lease.contextPackFingerprint !== context.contextPackFingerprint
    || lease.preflightId !== context.preflightId
    || Date.parse(lease.expiresAt) <= Date.now()) {
    rejectWritingState("章节写租约已过期、被接管或与当前 actor/章节/preflight 不一致。", {
      reason: "chapter_write_lease_stale",
      chapterId,
      nextAction: "停止使用旧正文结果，重新执行 prepare_novel_chapter_write 获取新 fence",
    });
  }
}

export async function releaseNovelChapterWriteLease(
  projectRoot: string,
  projectId: string,
  chapterId: string,
  context: NovelAiWriteContext,
  runtime: NovelChapterWriteLeaseRuntime,
): Promise<void> {
  const current = await loadLeaseDocument(projectRoot, projectId);
  const lease = current?.leases.find((entry) => entry.chapterId === chapterId);
  if (!current || !lease || lease.status !== "active"
    || lease.leaseId !== context.leaseId
    || lease.fence !== context.leaseFence
    || lease.actorFingerprint !== actorFingerprint(runtime.attribution)
    || lease.tokenSha256 !== sha256(runtime.leaseToken)) return;
  const now = new Date().toISOString();
  const released: NovelChapterWriteLeaseRecord = { ...lease, status: "released", updatedAt: now, expiresAt: now };
  const { fingerprint: _currentFingerprint, ...currentSemantic } = current;
  const next = leaseDocumentWithFingerprint({
    ...currentSemantic,
    revision: current.revision + 1,
    leases: current.leases.map((entry) => entry.chapterId === chapterId ? released : entry),
    updatedAt: now,
  });
  await persistLeaseDocument(projectRoot, current, next);
}

function orderedChapters(snapshot: NovelWorkspaceSnapshot): NovelChapterRecord[] {
  if (!snapshot.chapters) return [];
  const volumeOrder = new Map(snapshot.chapters.volumes.map((volume) => [volume.volumeId, volume.order]));
  return [...snapshot.chapters.chapters].sort((left, right) =>
    (volumeOrder.get(left.volumeId) ?? Number.MAX_SAFE_INTEGER) - (volumeOrder.get(right.volumeId) ?? Number.MAX_SAFE_INTEGER)
    || left.order - right.order
    || left.chapterId.localeCompare(right.chapterId, "en"));
}

function requireManagedSnapshot(snapshot: NovelWorkspaceSnapshot): asserts snapshot is NovelWorkspaceSnapshot & {
  chapters: NonNullable<NovelWorkspaceSnapshot["chapters"]>;
} {
  if (snapshot.workspace.sourceMode !== "managed_markdown" || !snapshot.chapters) {
    rejectWritingState("写作状态只支持 managed Markdown 小说工程。", {
      reason: "invalid_target",
      nextAction: "先将小说转换为受管 Markdown",
    });
  }
}

function chapterIdentity(chapter: NovelChapterRecord): NovelChapterSourceIdentity {
  return {
    chapterId: chapter.chapterId,
    chapterRevision: chapter.revision,
    chapterSha256: chapter.sha256,
  };
}

function requireChapter(snapshot: NovelWorkspaceSnapshot, chapterId: string): NovelChapterRecord {
  const chapter = snapshot.chapters?.chapters.find((entry) => entry.chapterId === chapterId);
  if (!chapter) rejectWritingState("写作状态引用的章节不存在。", { reason: "not_found", chapterId });
  return chapter;
}

function assertChapterCas(
  chapter: NovelChapterRecord,
  expectedRevision: number,
  expectedSha256: string,
): void {
  if (chapter.revision !== expectedRevision || chapter.sha256 !== expectedSha256) {
    rejectWritingState("章节 revision/SHA CAS 已过期。", {
      reason: chapter.revision !== expectedRevision ? "revision_conflict" : "content_conflict",
      chapterId: chapter.chapterId,
      expectedRevision,
      currentRevision: chapter.revision,
      expectedSha256,
      currentSha256: chapter.sha256,
      nextAction: "重新读取章节后重试",
    });
  }
}

function assertStateCas(
  state: NovelWritingStateDocument,
  expectedRevision: number,
  expectedFingerprint: string,
): void {
  if (state.revision !== expectedRevision || state.fingerprint !== expectedFingerprint) {
    rejectWritingState("写作状态 revision/fingerprint CAS 已过期。", {
      reason: "revision_conflict",
      expectedRevision,
      currentRevision: state.revision,
      expectedFingerprint,
      currentFingerprint: state.fingerprint,
      nextAction: "重新读取写作状态后重试",
    });
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} 不得重复。`);
}

function assertSeedReferences(snapshot: NovelWorkspaceSnapshot, input: NovelSeedWritingStateInput): void {
  requireManagedSnapshot(snapshot);
  const chapters = new Set(snapshot.chapters.chapters.map((chapter) => chapter.chapterId));
  const sources = new Set(input.sourceDocuments.map((source) => source.sourceId));
  const entities = new Set(input.entities.map((entity) => entity.entityId));
  assertUnique([...sources], "sourceId");
  assertUnique([...entities], "entityId");
  assertUnique(input.hardCanon.map((entry) => entry.ruleId), "ruleId");
  assertUnique(input.characterStates.map((entry) => entry.stateId), "stateId");
  assertUnique(input.knowledge.map((entry) => entry.knowledgeId), "knowledgeId");
  assertUnique(input.relationships.map((entry) => entry.relationshipId), "relationshipId");
  assertUnique(input.timeline.map((entry) => entry.timelineId), "timelineId");
  assertUnique(input.foreshadowing.map((entry) => entry.foreshadowingId), "foreshadowingId");
  assertUnique(input.chapterBriefs.map((entry) => entry.chapterId), "chapterBrief.chapterId");
  assertUnique((input.characterProfiles ?? []).map((entry) => entry.entityId), "characterProfile.entityId");
  assertUnique((input.characterAppearances ?? []).map((entry) => entry.entityId), "characterAppearance.entityId");
  assertUnique(input.completedChapterIds, "completedChapterId");
  if (!chapters.has(input.currentThroughChapterId)) throw new Error("currentThroughChapterId 不存在。");
  if (!input.completedChapterIds.includes(input.currentThroughChapterId)) {
    throw new Error("currentThroughChapterId 必须有对应的已批准chapter completion。");
  }
  const ordered = orderedChapters(snapshot);
  const indices = new Map(ordered.map((chapter, index) => [chapter.chapterId, index]));
  const currentThroughIndex = indices.get(input.currentThroughChapterId)!;
  if (input.completedChapterIds.some((chapterId) => (indices.get(chapterId) ?? Number.MAX_SAFE_INTEGER) > currentThroughIndex)) {
    throw new Error("completedChapterIds 不得越过 currentThroughChapterId。");
  }
  for (const chapterId of [...input.completedChapterIds, ...input.chapterBriefs.map((entry) => entry.chapterId)]) {
    if (!chapters.has(chapterId)) throw new Error(`写作状态引用未知章节：${chapterId}`);
  }
  for (const chapterId of [
    ...input.entities.map((entry) => entry.effectiveFromChapterId),
    ...input.hardCanon.map((entry) => entry.effectiveFromChapterId),
  ]) {
    if (chapterId && !chapters.has(chapterId)) throw new Error(`写作状态引用未知生效章节：${chapterId}`);
  }
  const referencedSourceIds = [
    ...input.entities.flatMap((entry) => entry.sourceIds),
    ...input.hardCanon.flatMap((entry) => entry.sourceIds),
    ...input.characterStates.flatMap((entry) => entry.sourceIds),
    ...input.knowledge.flatMap((entry) => entry.sourceIds),
    ...input.relationships.flatMap((entry) => entry.sourceIds),
    ...input.timeline.flatMap((entry) => entry.sourceIds),
    ...input.foreshadowing.flatMap((entry) => entry.sourceIds),
    ...input.chapterBriefs.flatMap((entry) => entry.sourceIds),
    ...(input.characterProfiles ?? []).flatMap((entry) => entry.sourceIds),
    ...(input.characterAppearances ?? []).flatMap((entry) => entry.sourceIds),
  ];
  for (const sourceId of referencedSourceIds) {
    if (!sources.has(sourceId)) throw new Error(`写作状态引用未知 sourceId：${sourceId}`);
  }
  for (const state of input.characterStates) {
    if (!entities.has(state.entityId) || !chapters.has(state.throughChapterId)) {
      throw new Error(`角色状态引用未知实体或章节：${state.stateId}`);
    }
  }
  for (const knowledge of input.knowledge) {
    if (!entities.has(knowledge.entityId)) throw new Error(`知情记录引用未知实体：${knowledge.knowledgeId}`);
  }
  for (const relationship of input.relationships) {
    if (!entities.has(relationship.fromEntityId) || !entities.has(relationship.toEntityId)
      || !chapters.has(relationship.throughChapterId)) {
      throw new Error(`关系记录引用未知实体或章节：${relationship.relationshipId}`);
    }
  }
  for (const brief of input.chapterBriefs) {
    if (brief.requiredCharacterIds === undefined) continue;
    assertUnique(brief.requiredCharacterIds, `chapterBrief.requiredCharacterIds:${brief.chapterId}`);
    for (const entityId of brief.requiredCharacterIds) {
      if (!entities.has(entityId)) throw new Error(`章节 brief 引用未知必需角色：${entityId}`);
    }
  }
  for (const profile of input.characterProfiles ?? []) {
    if (!entities.has(profile.entityId)) throw new Error(`人物声口卡引用未知实体：${profile.entityId}`);
    if (profile.effectiveFromChapterId && !chapters.has(profile.effectiveFromChapterId)) {
      throw new Error(`人物声口卡引用未知生效章节：${profile.entityId}`);
    }
    assertUnique(profile.relationshipVoices.map((entry) => entry.targetEntityId), `characterProfile.relationshipVoices:${profile.entityId}`);
    for (const voice of profile.relationshipVoices) {
      if (!entities.has(voice.targetEntityId)) throw new Error(`人物声口卡引用未知关系对象：${voice.targetEntityId}`);
    }
  }
  for (const appearance of input.characterAppearances ?? []) {
    if (!entities.has(appearance.entityId)) throw new Error(`人物外形卡引用未知实体：${appearance.entityId}`);
    if (appearance.effectiveFromChapterId && !chapters.has(appearance.effectiveFromChapterId)) {
      throw new Error(`人物外形卡引用未知生效章节：${appearance.entityId}`);
    }
    if (appearance.locks.length === 0) throw new Error(`人物外形卡至少需要一个结构化锁：${appearance.entityId}`);
    assertUnique(appearance.locks.map((entry) => entry.lockId), `characterAppearance.lockId:${appearance.entityId}`);
    for (const lock of appearance.locks) {
      assertUnique(lock.allowedVariants, `characterAppearance.allowedVariants:${appearance.entityId}:${lock.lockId}`);
      assertUnique(lock.contradictionPhrases, `characterAppearance.contradictionPhrases:${appearance.entityId}:${lock.lockId}`);
    }
  }
}

function sourceChapterFor(snapshot: NovelWorkspaceSnapshot, chapterId?: string): NovelChapterSourceIdentity | undefined {
  if (!chapterId) return undefined;
  const chapter = snapshot.chapters?.chapters.find((entry) => entry.chapterId === chapterId);
  return chapter ? chapterIdentity(chapter) : undefined;
}

export async function loadNovelPublicWritingState(
  projectRoot: string,
  expectedProjectId?: string,
): Promise<NovelWritingStateDocument | null> {
  const bytes = await readOptionalProjectFile(projectRoot, NOVEL_WRITING_STATE_RELATIVE_PATH, MAX_WRITING_STATE_BYTES);
  return bytes ? validateStateDocument(parseJson(bytes, "writing-state.json"), expectedProjectId) : null;
}

export async function loadNovelWritingState(
  projectRoot: string,
  expectedProjectId?: string,
): Promise<NovelWritingStateDocument | null> {
  const publicState = await loadNovelPublicWritingState(projectRoot, expectedProjectId);
  if (!publicState) return null;
  const control = await loadHistoryControl(projectRoot, publicState.projectId);
  if (!control) return publicState;
  if (control.publicHead.stateRevision !== publicState.revision
    || control.publicHead.stateFingerprint !== publicState.fingerprint
    || control.publicHead.throughChapterId !== publicState.currentThroughChapterId) {
    throw new Error("writing-state 公开投影与 history control 不一致；需要执行 writing-state recovery。");
  }
  await verifyHistoryHeadClosure({
    projectRoot,
    projectId: publicState.projectId,
    head: control.publicHead,
    state: publicState,
  });
  if (!control.activeRebuild) return publicState;
  const shadow = await loadHistoryShadowState(projectRoot, control.activeRebuild, publicState.projectId);
  await verifyActiveRebuildClosure({
    projectRoot,
    projectId: publicState.projectId,
    rebuild: control.activeRebuild,
    state: shadow,
  });
  return shadow;
}

export async function seedNovelWritingState(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
  input: NovelSeedWritingStateInput,
): Promise<{ state: NovelWritingStateDocument; replayed: boolean }> {
  requireManagedSnapshot(snapshot);
  if (!SHA256_PATTERN.test(input.sourceTreeAggregateSha256)) throw new Error("sourceTreeAggregateSha256 无效。");
  assertSeedReferences(snapshot, input);

  const sources = await Promise.all(input.sourceDocuments.map(async (source) => {
    const bytes = Buffer.from(source.content, "utf8");
    const sourceSha = sha256(bytes);
    const objectRelativePath = `${WRITING_SOURCE_OBJECTS_RELATIVE_PATH}/${sourceSha}.md`;
    await persistImmutableOrVerify(projectRoot, objectRelativePath, bytes);
    return {
      sourceId: source.sourceId,
      displayPath: source.displayPath,
      objectRelativePath,
      sha256: sourceSha,
      byteLength: bytes.byteLength,
    };
  }));
  const createdAt = snapshot.workspace.createdAt;
  const completions: NovelChapterStateCompletion[] = input.completedChapterIds.map((chapterId) => {
    const chapter = requireChapter(snapshot, chapterId);
    return {
      chapterId,
      chapterRevision: chapter.revision,
      chapterSha256: chapter.sha256,
      stateCommitId: `novel-state-commit-seed-${fingerprint({ projectId: snapshot.workspace.projectId, chapter: chapterIdentity(chapter) }).slice(0, 24)}`,
      committedAt: chapter.updatedAt,
    };
  });
  const state = stateWithFingerprint({
    schemaVersion: 1,
    kind: "novel-writing-state",
    projectId: snapshot.workspace.projectId,
    revision: 1,
    baselineStatus: input.baselineStatus,
    sourceTreeAggregateSha256: input.sourceTreeAggregateSha256,
    currentThroughChapterId: input.currentThroughChapterId,
    historyBaseChapterId: input.currentThroughChapterId,
    sources,
    entities: input.entities.map((entry) => ({ ...entry, revision: 1 })),
    hardCanon: input.hardCanon.map((entry) => ({ ...entry, revision: 1 })),
    characterStates: input.characterStates.map((entry) => ({
      ...entry,
      sourceChapter: sourceChapterFor(snapshot, entry.throughChapterId),
      revision: 1,
    })),
    knowledge: input.knowledge.map((entry) => ({ ...entry, revision: 1 })),
    relationships: input.relationships.map((entry) => ({
      ...entry,
      sourceChapter: sourceChapterFor(snapshot, entry.throughChapterId),
      revision: 1,
    })),
    timeline: input.timeline.map((entry) => ({ ...entry, revision: 1 })),
    foreshadowing: input.foreshadowing.map((entry) => ({ ...entry, revision: 1 })),
    chapterBriefs: input.chapterBriefs.map((entry) => ({ ...entry, revision: 1 })),
    characterProfiles: (input.characterProfiles ?? []).map((entry) => ({ ...entry, revision: 1 })),
    characterAppearances: (input.characterAppearances ?? []).map((entry) => ({ ...entry, revision: 1 })),
    chapterCompletions: completions,
    appliedCandidateIds: [],
    createdAt,
    updatedAt: createdAt,
  });
  const existing = await loadNovelPublicWritingState(projectRoot, snapshot.workspace.projectId);
  if (existing) {
    if (existing.fingerprint === state.fingerprint) {
      await ensureHistoryControlForPublicState(projectRoot, existing);
      return { state: existing, replayed: true };
    }
    rejectWritingState("小说工程已经存在不同的写作状态，拒绝覆盖初始化。", {
      reason: "writing_state_exists",
      expectedFingerprint: state.fingerprint,
      currentFingerprint: existing.fingerprint,
      nextAction: "读取现有写作状态或创建新的隔离工程",
    });
  }
  await createStateDocument(projectRoot, state);
  await ensureHistoryControlForPublicState(projectRoot, state);
  return { state, replayed: false };
}

function chapterIndexMap(snapshot: NovelWorkspaceSnapshot): Map<string, number> {
  return new Map(orderedChapters(snapshot).map((chapter, index) => [chapter.chapterId, index]));
}

function recordAtOrBefore(index: Map<string, number>, chapterId: string | undefined, cutoffIndex: number): boolean {
  if (!chapterId) return true;
  const recordIndex = index.get(chapterId);
  return recordIndex !== undefined && recordIndex <= cutoffIndex;
}

function latestByKey<T>(items: readonly T[], key: (item: T) => string, order: (item: T) => number): T[] {
  const selected = new Map<string, T>();
  for (const item of items) {
    const prior = selected.get(key(item));
    if (!prior || order(item) >= order(prior)) selected.set(key(item), item);
  }
  return [...selected.values()].sort((left, right) => key(left).localeCompare(key(right), "en"));
}

function revisionOrder(chapterOrder: number, revision: number): number {
  return chapterOrder * 1_000_000_000 + revision;
}

function recordEventChapterId(
  entry: { sourceChapter?: NovelChapterSourceIdentity },
  fallbackChapterId?: string,
): string | undefined {
  return entry.sourceChapter?.chapterId ?? fallbackChapterId;
}

export interface NovelWritingStateQueryInput {
  targetChapterId: string;
  cutoff: "before" | "through";
  characterIds?: string[];
}

export function projectNovelWritingState(
  snapshot: NovelWorkspaceSnapshot,
  state: NovelWritingStateDocument,
  input: NovelWritingStateQueryInput,
) {
  requireManagedSnapshot(snapshot);
  const ordered = orderedChapters(snapshot);
  const targetIndex = ordered.findIndex((chapter) => chapter.chapterId === input.targetChapterId);
  if (targetIndex < 0) rejectWritingState("目标章节不存在。", { reason: "not_found", chapterId: input.targetChapterId });
  const cutoffIndex = input.cutoff === "before" ? targetIndex - 1 : targetIndex;
  const cutoffChapter = cutoffIndex >= 0 ? ordered[cutoffIndex]! : null;
  const indices = chapterIndexMap(snapshot);
  const characterFilter = input.characterIds?.length ? new Set(input.characterIds) : null;
  const entities = latestByKey(
    state.entities.filter((entry) => recordAtOrBefore(indices, entry.effectiveFromChapterId, targetIndex)
      && (!characterFilter || characterFilter.has(entry.entityId))),
    (entry) => entry.entityId,
    (entry) => entry.revision,
  );
  const hardCanon = latestByKey(
    state.hardCanon.filter((entry) => recordAtOrBefore(indices, entry.effectiveFromChapterId, targetIndex)),
    (entry) => entry.ruleId,
    (entry) => entry.revision,
  ).filter((entry) => entry.visibility === "writer");
  const characterProfiles = latestByKey(
    (state.characterProfiles ?? []).filter((entry) =>
      recordAtOrBefore(indices, entry.effectiveFromChapterId, targetIndex)
      && (!characterFilter || characterFilter.has(entry.entityId))),
    (entry) => entry.entityId,
    (entry) => entry.revision,
  );
  const characterAppearances = latestByKey(
    (state.characterAppearances ?? []).filter((entry) =>
      recordAtOrBefore(indices, entry.effectiveFromChapterId, targetIndex)
      && (!characterFilter || characterFilter.has(entry.entityId))),
    (entry) => entry.entityId,
    (entry) => entry.revision,
  );
  const continuityIssues = latestByKey(
    (state.continuityIssues ?? []).filter((entry) => entry.chapterIds.length === 0
      || entry.chapterIds.some((chapterId) => recordAtOrBefore(indices, chapterId, cutoffIndex))),
    (entry) => entry.issueId,
    (entry) => entry.revision,
  );
  const characterStates = latestByKey(
    state.characterStates.filter((entry) =>
      recordAtOrBefore(indices, recordEventChapterId(entry, entry.throughChapterId), cutoffIndex)
      && (!characterFilter || characterFilter.has(entry.entityId))),
    (entry) => entry.entityId,
    (entry) => revisionOrder(
      indices.get(recordEventChapterId(entry, entry.throughChapterId) ?? "") ?? -1,
      entry.revision,
    ),
  );
  const knowledge = latestByKey(
    state.knowledge.filter((entry) =>
      (!characterFilter || characterFilter.has(entry.entityId))
      && !(entry.status === "planned_later" && !entry.effectiveFromChapterId)
      && recordAtOrBefore(
        indices,
        recordEventChapterId(entry, entry.effectiveFromChapterId),
        cutoffIndex,
      )
      && recordAtOrBefore(indices, entry.effectiveFromChapterId, cutoffIndex)
      && (!entry.effectiveUntilChapterId || (indices.get(entry.effectiveUntilChapterId) ?? -1) >= cutoffIndex)),
    (entry) => entry.knowledgeId,
    (entry) => revisionOrder(
      indices.get(recordEventChapterId(entry, entry.effectiveFromChapterId) ?? "") ?? -1,
      entry.revision,
    ),
  );
  const relationships = latestByKey(
    state.relationships.filter((entry) =>
      recordAtOrBefore(indices, recordEventChapterId(entry, entry.throughChapterId), cutoffIndex)
      && (!characterFilter || characterFilter.has(entry.fromEntityId) || characterFilter.has(entry.toEntityId))),
    (entry) => entry.relationshipId,
    (entry) => revisionOrder(
      indices.get(recordEventChapterId(entry, entry.throughChapterId) ?? "") ?? -1,
      entry.revision,
    ),
  );
  const timeline = latestByKey(
    state.timeline.filter((entry) => recordAtOrBefore(
      indices,
      recordEventChapterId(entry, entry.disclosureChapterId ?? entry.endChapterId ?? entry.startChapterId),
      cutoffIndex,
    )),
    (entry) => entry.timelineId,
    (entry) => revisionOrder(
      indices.get(recordEventChapterId(
        entry,
        entry.disclosureChapterId ?? entry.endChapterId ?? entry.startChapterId,
      ) ?? "") ?? -1,
      entry.revision,
    ),
  );
  const foreshadowing = latestByKey(
    state.foreshadowing.filter((entry) => recordAtOrBefore(
      indices,
      recordEventChapterId(
        entry,
        entry.payoffChapterId ?? entry.maintenanceChapterIds.at(-1) ?? entry.setupChapterId,
      ),
      cutoffIndex,
    )),
    (entry) => entry.foreshadowingId,
    (entry) => revisionOrder(
      indices.get(recordEventChapterId(
        entry,
        entry.payoffChapterId ?? entry.maintenanceChapterIds.at(-1) ?? entry.setupChapterId,
      ) ?? "") ?? -1,
      entry.revision,
    ),
  )
    .map((entry) => ({
      ...entry,
      maintenanceChapterIds: entry.maintenanceChapterIds.filter((chapterId) => recordAtOrBefore(indices, chapterId, cutoffIndex)),
      ...(entry.payoffChapterId && !recordAtOrBefore(indices, entry.payoffChapterId, cutoffIndex)
        ? { payoffChapterId: undefined }
        : {}),
    }));
  const targetBrief = latestByKey(
    state.chapterBriefs.filter((entry) => entry.chapterId === input.targetChapterId),
    (entry) => entry.chapterId,
    (entry) => entry.revision,
  )[0] ?? null;
  const requiredCompletion = input.cutoff === "before" ? cutoffChapter : ordered[targetIndex]!;
  const completion = requiredCompletion
    ? state.chapterCompletions.find((entry) => entry.chapterId === requiredCompletion.chapterId
      && entry.chapterRevision === requiredCompletion.revision
      && entry.chapterSha256 === requiredCompletion.sha256) ?? null
    : null;
  const readyForTargetChapter = input.cutoff === "before"
    ? (!requiredCompletion || Boolean(completion) && state.currentThroughChapterId === requiredCompletion.chapterId)
    : Boolean(completion) && state.currentThroughChapterId === requiredCompletion?.chapterId;
  return {
    stateIdentity: {
      revision: state.revision,
      fingerprint: state.fingerprint,
      baselineStatus: state.baselineStatus,
      currentThroughChapterId: state.currentThroughChapterId,
      sourceTreeAggregateSha256: state.sourceTreeAggregateSha256,
      updatedAt: state.updatedAt,
      rebuild: state.rebuild ? {
        rebuildId: state.rebuild.rebuildId,
        targetFromChapterId: state.rebuild.targetFromChapterId,
        previousCurrentThroughChapterId: state.rebuild.previousCurrentThroughChapterId,
        nextChapterId: state.rebuild.nextChapterId,
        remainingChapters: state.rebuild.pendingChapterIds.length,
        planFingerprint: state.rebuild.planFingerprint,
      } : null,
    },
    targetChapter: ordered[targetIndex]!,
    temporal: {
      cutoff: input.cutoff,
      cutoffChapterId: cutoffChapter?.chapterId ?? null,
      entities,
      hardCanon,
      characterProfiles,
      characterAppearances,
      continuityIssues,
      characterStates,
      knowledge,
      relationships,
      timeline,
      foreshadowing,
      chapterBrief: targetBrief,
    },
    completion: {
      requiredChapterId: requiredCompletion?.chapterId ?? null,
      record: completion,
      readyForTargetChapter,
    },
  };
}

export async function getNovelWritingStateProjection(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
  input: NovelWritingStateQueryInput,
) {
  const state = await loadNovelWritingState(projectRoot, snapshot.workspace.projectId);
  if (!state) rejectWritingState("小说工程尚未初始化写作状态。", {
    reason: "writing_state_missing",
    chapterId: input.targetChapterId,
    nextAction: "执行 novel_seed_writing_state",
  });
  return projectNovelWritingState(snapshot, state, input);
}

export async function planNovelWritingStateRebuild(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
  targetChapterId: string,
) {
  requireManagedSnapshot(snapshot);
  const state = await loadNovelWritingState(projectRoot, snapshot.workspace.projectId);
  if (!state) rejectWritingState("写作状态尚未初始化。", {
    reason: "writing_state_missing",
    chapterId: targetChapterId,
    nextAction: "由 owner 执行 novel_seed_writing_state",
  });
  const ordered = orderedChapters(snapshot);
  const targetIndex = ordered.findIndex((chapter) => chapter.chapterId === targetChapterId);
  const currentIndex = ordered.findIndex((chapter) => chapter.chapterId === state.currentThroughChapterId);
  const historyBaseIndex = state.historyBaseChapterId
    ? ordered.findIndex((chapter) => chapter.chapterId === state.historyBaseChapterId)
    : -1;
  const baseChapter = targetIndex > 0 ? ordered[targetIndex - 1]! : null;
  const affectedChapters = targetIndex >= 0 && currentIndex >= targetIndex
    ? ordered.slice(targetIndex, currentIndex + 1)
    : [];
  let allowed = true;
  let reason: "ready" | "not_found" | "target_not_committed" | "history_gap" | "rebuild_active" = "ready";
  if (state.rebuild) {
    allowed = false;
    reason = "rebuild_active";
  } else if (targetIndex < 0) {
    allowed = false;
    reason = "not_found";
  } else if (currentIndex < targetIndex) {
    allowed = false;
    reason = "target_not_committed";
  } else if (!baseChapter || historyBaseIndex < 0 || targetIndex <= historyBaseIndex) {
    allowed = false;
    reason = "history_gap";
  }
  const semantic = {
    schemaVersion: 1,
    kind: "novel-state-rebuild-plan" as const,
    projectId: snapshot.workspace.projectId,
    manifestRevision: snapshot.chapters!.revision,
    writingStateRevision: state.revision,
    writingStateFingerprint: state.fingerprint,
    historyBaseChapterId: state.historyBaseChapterId ?? null,
    targetChapterId,
    baseChapterId: baseChapter?.chapterId ?? null,
    previousCurrentThroughChapterId: state.currentThroughChapterId,
    affectedChapters: affectedChapters.map((chapter) => chapterIdentity(chapter)),
    allowed,
    reason,
    activeRebuild: state.rebuild ? {
      rebuildId: state.rebuild.rebuildId,
      nextChapterId: state.rebuild.nextChapterId,
      remainingChapters: state.rebuild.pendingChapterIds.length,
    } : null,
  };
  return { ...semantic, fingerprint: fingerprint(semantic) };
}

function recordBeforeTarget(indices: Map<string, number>, targetIndex: number, chapterId: string | undefined): boolean {
  if (!chapterId) return true;
  const index = indices.get(chapterId);
  return index !== undefined && index < targetIndex;
}

export async function invalidateNovelWritingStateFrom(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
  input: NovelInvalidateWritingStateFromInput,
): Promise<{ state: NovelWritingStateDocument; rebuild: NovelWritingStateDocument["rebuild"]; replayed: boolean; snapshotLocator: string }> {
  requireManagedSnapshot(snapshot);
  await recoverIncompleteNovelWritingStateOperations(projectRoot, snapshot.workspace.projectId);
  const state = await loadNovelPublicWritingState(projectRoot, snapshot.workspace.projectId);
  if (!state) rejectWritingState("写作状态尚未初始化。", {
    reason: "writing_state_missing",
    chapterId: input.targetChapterId,
  });
  const control = await ensureHistoryControlForPublicState(projectRoot, state);
  if (control.activeRebuild) {
    const shadow = await loadHistoryShadowState(projectRoot, control.activeRebuild, state.projectId);
    if (control.activeRebuild.targetFromChapterId === input.targetChapterId
      && control.activeRebuild.planFingerprint === input.expectedPlanFingerprint
      && state.revision === input.expectedWritingStateRevision
      && state.fingerprint === input.expectedWritingStateFingerprint) {
      return {
        state: shadow,
        rebuild: shadow.rebuild,
        replayed: true,
        snapshotLocator: `${WRITING_STATE_REBUILDS_RELATIVE_PATH}/${control.activeRebuild.rebuildId}/before.json`,
      };
    }
    rejectWritingState("已有状态重建正在进行，禁止并行启动另一条分支。", {
      reason: "state_rebuild_active",
      chapterId: control.activeRebuild.nextChapterId,
      nextAction: "先读取当前 rebuild 状态并按 nextChapterId 顺序完成",
    });
  }
  assertStateCas(state, input.expectedWritingStateRevision, input.expectedWritingStateFingerprint);
  const plan = await planNovelWritingStateRebuild(projectRoot, snapshot, input.targetChapterId);
  if (plan.fingerprint !== input.expectedPlanFingerprint) {
    rejectWritingState("状态重建计划已过期。", {
      reason: "revision_conflict",
      chapterId: input.targetChapterId,
      expectedFingerprint: input.expectedPlanFingerprint,
      currentFingerprint: plan.fingerprint,
      nextAction: "重新执行 plan_novel_state_rebuild 后由 owner 确认",
    });
  }
  if (!plan.allowed || !plan.baseChapterId || plan.affectedChapters.length === 0) {
    rejectWritingState("当前状态历史无法安全执行该重建计划。", {
      reason: plan.reason === "history_gap" ? "state_rebuild_history_gap" : "invalid_target",
      chapterId: input.targetChapterId,
      nextAction: plan.reason === "history_gap"
        ? "在隔离工程重建可信基线，或由 owner 提供目标章前一章完整 checkpoint"
        : "重新选择已提交且位于可信历史覆盖后的目标章",
    });
  }
  const rebuildId = `novel-state-rebuild-${plan.fingerprint.slice(0, 24)}`;
  const snapshotLocator = `${WRITING_STATE_REBUILDS_RELATIVE_PATH}/${rebuildId}/before.json`;
  await persistImmutableOrVerify(projectRoot, snapshotLocator, jsonBytes(state));
  const ordered = orderedChapters(snapshot);
  const indices = new Map(ordered.map((chapter, index) => [chapter.chapterId, index]));
  const targetIndex = indices.get(input.targetChapterId)!;
  const invalidatedCompletions = state.chapterCompletions.filter((completion) =>
    (indices.get(completion.chapterId) ?? Number.MAX_SAFE_INTEGER) >= targetIndex);
  const invalidatedCandidateIds = new Set(invalidatedCompletions.flatMap((completion) => completion.candidateId ? [completion.candidateId] : []));
  const startedAt = nextIsoTimestamp(state.updatedAt);
  const pendingChapterIds = plan.affectedChapters.map((chapter) => chapter.chapterId);
  const generation = 1;
  const lineageId = `novel-state-lineage-${fingerprint({
    rebuildId,
    generation,
    publicHeadEventId: control.publicHead.headEventId,
  }).slice(0, 32)}`;
  const manifestDigest = temporalManifestDigest(snapshot);
  const { fingerprint: _previousFingerprint, rebuild: _previousRebuild, ...baseState } = state;
  const next = stateWithFingerprint({
    ...baseState,
    revision: state.revision + 1,
    currentThroughChapterId: plan.baseChapterId,
    characterStates: state.characterStates.filter((entry) => recordBeforeTarget(
      indices,
      targetIndex,
      recordEventChapterId(entry, entry.throughChapterId),
    )),
    knowledge: state.knowledge.filter((entry) => recordBeforeTarget(
      indices,
      targetIndex,
      recordEventChapterId(entry, entry.effectiveFromChapterId),
    )),
    relationships: state.relationships.filter((entry) => recordBeforeTarget(
      indices,
      targetIndex,
      recordEventChapterId(entry, entry.throughChapterId),
    )),
    timeline: state.timeline.filter((entry) => recordBeforeTarget(
      indices,
      targetIndex,
      recordEventChapterId(entry, entry.disclosureChapterId ?? entry.endChapterId ?? entry.startChapterId),
    )),
    foreshadowing: state.foreshadowing.filter((entry) => recordBeforeTarget(
      indices,
      targetIndex,
      recordEventChapterId(entry, entry.payoffChapterId ?? entry.maintenanceChapterIds.at(-1) ?? entry.setupChapterId),
    )),
    chapterCompletions: state.chapterCompletions.filter((completion) =>
      (indices.get(completion.chapterId) ?? Number.MAX_SAFE_INTEGER) < targetIndex),
    appliedCandidateIds: state.appliedCandidateIds.filter((candidateId) => !invalidatedCandidateIds.has(candidateId)),
    rebuild: {
      rebuildId,
      targetFromChapterId: input.targetChapterId,
      baseChapterId: plan.baseChapterId,
      previousCurrentThroughChapterId: plan.previousCurrentThroughChapterId,
      pendingChapterIds,
      nextChapterId: pendingChapterIds[0]!,
      originalWritingStateRevision: state.revision,
      originalWritingStateFingerprint: state.fingerprint,
      planFingerprint: plan.fingerprint,
      startedAt,
      generation,
      lineageId,
      parentEventId: null,
      publicWritingStateRevision: state.revision,
      publicWritingStateFingerprint: state.fingerprint,
      manifestRevision: snapshot.chapters!.revision,
      temporalManifestDigest: manifestDigest,
    },
    updatedAt: startedAt,
  });
  const shadowState = next;
  const shadowStateLocator = historyShadowStateLocator(rebuildId, shadowState.fingerprint);
  await persistImmutableOrVerify(projectRoot, shadowStateLocator, jsonBytes(shadowState));
  const { event: rebuildStartedEvent, checkpoint } = createHistoryCommitEvent({
    projectId: state.projectId,
    lineageId,
    parentEventId: control.publicHead.headEventId,
    beforeCheckpointId: control.publicHead.checkpointId,
    operationKind: "rebuild_started",
    beforeState: state,
    afterState: shadowState,
    temporalManifestDigest: manifestDigest,
    coverageMode: control.publicHead.coverageMode,
    coverageBaseChapterId: control.publicHead.coverageBaseChapterId,
    createdAt: startedAt,
  });
  await persistHistoryCheckpoint(projectRoot, checkpoint);
  await persistHistoryEvent(projectRoot, rebuildStartedEvent);
  const activeRebuild: NovelWritingStateHistoryActiveRebuild = {
    rebuildId,
    generation,
    lineageId,
    planFingerprint: plan.fingerprint,
    targetFromChapterId: input.targetChapterId,
    baseChapterId: plan.baseChapterId,
    previousCurrentThroughChapterId: plan.previousCurrentThroughChapterId,
    pendingChapterIds,
    nextChapterId: pendingChapterIds[0]!,
    shadowHeadEventId: rebuildStartedEvent.eventId,
    shadowCheckpointId: checkpoint.checkpointId,
    shadowStateLocator,
    shadowStateRevision: shadowState.revision,
    shadowStateFingerprint: shadowState.fingerprint,
    manifestRevision: snapshot.chapters!.revision,
    temporalManifestDigest: manifestDigest,
    startedAt,
  };
  const nextControl = historyControlWithFingerprint({
    ...control,
    revision: control.revision + 1,
    activeRebuild,
    updatedAt: startedAt,
  });
  const result = { state: shadowState, rebuild: shadowState.rebuild, replayed: false, snapshotLocator };
  await executeWritingStateHistoryOperation({
    projectRoot,
    projectId: state.projectId,
    command: "novel_invalidate_writing_state_from",
    createdAt: startedAt,
    targets: [{
      label: "control",
      locator: WRITING_STATE_HISTORY_CONTROL_RELATIVE_PATH,
      beforeBytes: jsonBytes(control),
      afterBytes: jsonBytes(nextControl),
    }],
    result,
  });
  return result;
}

export interface NovelWritePreflightInput {
  targetChapterId: string;
  contextPackFingerprint: string;
  characterIds?: string[];
  workflowMode?: NovelWritingWorkflowMode;
}

export function deriveNovelWritePreflight(
  snapshot: NovelWorkspaceSnapshot,
  state: NovelWritingStateDocument,
  input: NovelWritePreflightInput,
) {
  requireManagedSnapshot(snapshot);
  if (!SHA256_PATTERN.test(input.contextPackFingerprint)) throw new Error("contextPackFingerprint 无效。");
  const projection = projectNovelWritingState(snapshot, state, {
    targetChapterId: input.targetChapterId,
    cutoff: "before",
    characterIds: input.characterIds,
  });
  const workflowMode = input.workflowMode ?? "formal";
  const blockers: Array<{
    code: "state_commit_required" | "hard_canon_conflict" | "baseline_not_locked" | "state_rebuild_out_of_order";
    chapterId?: string;
    ruleIds?: string[];
    message: string;
    nextAction: string;
  }> = [];
  if (workflowMode === "formal" && state.baselineStatus !== "locked") {
    blockers.push({
      code: "baseline_not_locked",
      message: "正式写作要求 baselineStatus=locked；provisional 只能使用显式 rehearsal 模式。",
      nextAction: "由正典 owner 锁定基线，或明确改用 rehearsal 并禁止同步正式正文",
    });
  }
  if (state.rebuild && input.targetChapterId !== state.rebuild.nextChapterId) {
    blockers.push({
      code: "state_rebuild_out_of_order",
      chapterId: state.rebuild.nextChapterId,
      message: "状态重建期间只能处理 rebuild queue 的精确下一章。",
      nextAction: `为 ${state.rebuild.nextChapterId} 重新生成 Context Pack 与 preflight`,
    });
  }
  if (!projection.completion.readyForTargetChapter && projection.completion.requiredChapterId) {
    blockers.push({
      code: "state_commit_required",
      chapterId: projection.completion.requiredChapterId,
      message: "上一章正文尚无与当前revision/SHA一致的已批准状态提交。",
      nextAction: "stage并人工accepted上一章状态候选",
    });
  }
  const ordered = orderedChapters(snapshot);
  const cutoffIndex = projection.temporal.cutoffChapterId
    ? ordered.findIndex((chapter) => chapter.chapterId === projection.temporal.cutoffChapterId)
    : -1;
  const currentById = new Map(ordered.map((chapter) => [chapter.chapterId, chapter]));
  const staleCompletion = state.chapterCompletions.find((completion) => {
    const chapter = currentById.get(completion.chapterId);
    const chapterIndex = chapter ? ordered.indexOf(chapter) : -1;
    return chapterIndex >= 0 && chapterIndex <= cutoffIndex
      && (chapter!.revision !== completion.chapterRevision || chapter!.sha256 !== completion.chapterSha256);
  });
  if (staleCompletion && !blockers.some((blocker) => blocker.code === "state_commit_required"
    && blocker.chapterId === staleCompletion.chapterId)) {
    blockers.push({
      code: "state_commit_required",
      chapterId: staleCompletion.chapterId,
      message: "已批准章末状态依赖的正文revision/SHA已变化，下游状态投影已stale。",
      nextAction: "从该章开始重新stage并人工accepted状态候选",
    });
  }
  const conflictedRuleIds = projection.temporal.hardCanon
    .filter((entry) => entry.canonStatus === "conflicted")
    .map((entry) => entry.ruleId);
  if (conflictedRuleIds.length) {
    blockers.push({
      code: "hard_canon_conflict",
      ruleIds: conflictedRuleIds,
      message: "存在未裁决硬正典冲突。",
      nextAction: "由正典owner裁决冲突后更新writing-state",
    });
  }
  const target = projection.targetChapter;
  const semantic = {
    schemaVersion: 1,
    kind: "novel-write-preflight",
    projectId: snapshot.workspace.projectId,
    targetChapter: chapterIdentity(target),
    cutoffChapterId: projection.temporal.cutoffChapterId,
    manifestRevision: snapshot.chapters.revision,
    writingStateRevision: state.revision,
    writingStateFingerprint: state.fingerprint,
    contextPackFingerprint: input.contextPackFingerprint,
    workflowMode,
    blockers,
  };
  return {
    ...semantic,
    preflightId: `novel-write-preflight-${fingerprint(semantic).slice(0, 24)}`,
    ready: blockers.length === 0,
    targetChapter: {
      chapterId: target.chapterId,
      revision: target.revision,
      sha256: target.sha256,
    },
    writingState: { revision: state.revision, fingerprint: state.fingerprint },
  };
}

export async function validateNovelAiWriteContext(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
  chapterId: string,
  context: NovelAiWriteContext,
): Promise<void> {
  if (!PREFLIGHT_ID_PATTERN.test(context.preflightId) || !SHA256_PATTERN.test(context.contextPackFingerprint)) {
    rejectWritingState("AI写入身份格式无效。", {
      reason: "context_preflight_stale",
      chapterId,
      nextAction: "重新生成context pack与preflight",
    });
  }
  const state = await loadNovelWritingState(projectRoot, snapshot.workspace.projectId);
  if (!state) rejectWritingState("AI写入前缺少writing-state。", {
    reason: "writing_state_missing",
    chapterId,
    nextAction: "执行 novel_seed_writing_state",
  });
  const current = deriveNovelWritePreflight(snapshot, state, {
    targetChapterId: chapterId,
    contextPackFingerprint: context.contextPackFingerprint,
    workflowMode: context.workflowMode,
  });
  if (!current.ready) {
    const blocker = current.blockers[0]!;
    rejectWritingState(blocker.message, {
      reason: blocker.code,
      chapterId: blocker.chapterId ?? chapterId,
      nextAction: blocker.nextAction,
    });
  }
  if (current.preflightId !== context.preflightId) {
    rejectWritingState("AI写入preflight已过期。", {
      reason: "context_preflight_stale",
      chapterId,
      expectedFingerprint: context.contextPackFingerprint,
      currentFingerprint: current.contextPackFingerprint,
      nextAction: "重新生成context pack与preflight",
    });
  }
}

function candidateLocator(candidateId: string): string {
  return `${WRITING_CANDIDATES_RELATIVE_PATH}/${candidateId}.json`;
}

function decisionLocator(candidateId: string): string {
  return `${WRITING_DECISIONS_RELATIVE_PATH}/${candidateId}.json`;
}

export async function stageNovelChapterStateCandidate(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
  input: NovelStageChapterStateCandidateInput,
): Promise<{ candidate: NovelChapterStateCandidate; replayed: boolean }> {
  requireManagedSnapshot(snapshot);
  const chapter = requireChapter(snapshot, input.chapterId);
  assertChapterCas(chapter, input.expectedChapterRevision, input.expectedChapterSha256);
  const state = await loadNovelWritingState(projectRoot, snapshot.workspace.projectId);
  if (!state) rejectWritingState("写作状态尚未初始化。", {
    reason: "writing_state_missing",
    chapterId: input.chapterId,
    nextAction: "执行 novel_seed_writing_state",
  });
  assertStateCas(state, input.expectedWritingStateRevision, input.expectedWritingStateFingerprint);
  if (state.rebuild && input.chapterId !== state.rebuild.nextChapterId) {
    rejectWritingState("状态重建必须严格按队列下一章提交候选。", {
      reason: "state_rebuild_out_of_order",
      chapterId: input.chapterId,
      nextAction: `当前只允许为 ${state.rebuild.nextChapterId} 重新组包、写章并 stage 状态`,
    });
  }
  const deltaCount = input.delta.characterStates.length
    + input.delta.knowledge.length
    + input.delta.relationships.length
    + input.delta.timeline.length
    + input.delta.foreshadowing.length;
  if (deltaCount === 0 && !input.noStateChange) {
    rejectWritingState("状态候选没有任何变更；不得用空 delta 静默推进 completion。", {
      reason: "state_delta_required",
      chapterId: input.chapterId,
      nextAction: "提交至少一项有证据的状态变更；确无变化时使用显式 noStateChange 裁决",
    });
  }
  if (deltaCount > 0 && input.noStateChange) {
    rejectWritingState("有状态变更时不得同时声明 noStateChange。", {
      reason: "state_delta_required",
      chapterId: input.chapterId,
      nextAction: "删除 noStateChange 或清空 delta 后重新提交",
    });
  }
  const chapterRead = await readNovelProjectFile(projectRoot, chapter.relativePath, {
    maxBytes: Math.max(chapter.byteLength, 1),
  });
  if (chapterRead.sha256 !== chapter.sha256 || chapterRead.bytes.byteLength !== chapter.byteLength) {
    rejectWritingState("状态候选证据绑定的章节正文已发生外部变化。", {
      reason: "content_conflict",
      chapterId: input.chapterId,
      expectedSha256: chapter.sha256,
      currentSha256: chapterRead.sha256,
      nextAction: "重新读取正文、刷新章节身份并定位证据",
    });
  }
  const chapterContent = new TextDecoder("utf-8", { fatal: true }).decode(chapterRead.bytes);
  if (chapterContent.length !== chapter.charCount) {
    rejectWritingState("状态候选证据绑定的章节字符数与 manifest 不一致。", {
      reason: "content_conflict",
      chapterId: input.chapterId,
      nextAction: "先修复或重新导入发生外部变化的章节",
    });
  }
  const evidenceIds = new Set<string>();
  for (const evidence of input.evidenceSpans) {
    if (evidenceIds.has(evidence.evidenceId)) {
      rejectWritingState(`状态候选证据 ID 重复：${evidence.evidenceId}`, {
        reason: "invalid_reference",
        chapterId: input.chapterId,
        nextAction: "为每个证据 span 使用唯一 evidenceId",
      });
    }
    evidenceIds.add(evidence.evidenceId);
    if (!Number.isSafeInteger(evidence.startOffset) || !Number.isSafeInteger(evidence.endOffset)
      || evidence.startOffset < 0 || evidence.endOffset <= evidence.startOffset
      || evidence.endOffset > chapterContent.length
      || splitsUtf16SurrogatePair(chapterContent, evidence.startOffset)
      || splitsUtf16SurrogatePair(chapterContent, evidence.endOffset)
      || chapterContent.slice(evidence.startOffset, evidence.endOffset) !== evidence.evidenceExcerpt) {
      rejectWritingState(`状态候选证据 ${evidence.evidenceId} 的 UTF-16 位置或摘录与当前正文不一致。`, {
        reason: "content_conflict",
        chapterId: input.chapterId,
        expectedSha256: chapter.sha256,
        currentSha256: chapterRead.sha256,
        nextAction: "重新读取当前正文并用 UTF-16 code unit 重新定位证据",
      });
    }
  }
  const requireEvidenceIds = (ids: readonly string[], label: string): void => {
    if (ids.length === 0 || ids.some((id) => !evidenceIds.has(id))) {
      rejectWritingState(`${label} 必须引用至少一个已验证的正文证据 span。`, {
        reason: "invalid_reference",
        chapterId: input.chapterId,
        nextAction: "补齐 evidenceSpans，并在 changeEvidence/noStateChange 中引用 evidenceId",
      });
    }
  };
  if (input.noStateChange) {
    requireEvidenceIds(input.noStateChange.evidenceSpanIds, "noStateChange");
    const requiredCharacterIds = state.chapterBriefs.find((entry) => entry.chapterId === input.chapterId)?.requiredCharacterIds;
    const checked = input.noStateChange.checkedCharacterIds;
    if (requiredCharacterIds === undefined
      || new Set(checked).size !== checked.length
      || checked.length !== requiredCharacterIds.length
      || checked.some((entityId) => !requiredCharacterIds.includes(entityId))) {
      rejectWritingState("noStateChange 必须逐一声明已检查章 brief 的完整 required cast。", {
        reason: "invalid_reference",
        chapterId: input.chapterId,
        nextAction: "读取目标章 brief，并令 checkedCharacterIds 与 requiredCharacterIds 完全一致",
      });
    }
  }
  const expectedChangeKeys = [
    ...input.delta.characterStates.map((entry) => `character_state:${entry.stateId}`),
    ...input.delta.knowledge.map((entry) => `knowledge:${entry.knowledgeId}`),
    ...input.delta.relationships.map((entry) => `relationship:${entry.relationshipId}`),
    ...input.delta.timeline.map((entry) => `timeline:${entry.timelineId}`),
    ...input.delta.foreshadowing.map((entry) => `foreshadowing:${entry.foreshadowingId}`),
  ];
  const suppliedChangeKeys = input.changeEvidence.map((entry) => `${entry.kind}:${entry.recordId}`);
  if (new Set(expectedChangeKeys).size !== expectedChangeKeys.length
    || new Set(suppliedChangeKeys).size !== suppliedChangeKeys.length
    || expectedChangeKeys.length !== suppliedChangeKeys.length
    || expectedChangeKeys.some((key) => !suppliedChangeKeys.includes(key))) {
    rejectWritingState("每项状态 delta 必须有且只有一条匹配的 changeEvidence。", {
      reason: "invalid_reference",
      chapterId: input.chapterId,
      nextAction: "按 kind + recordId 为每项 delta 补齐 changeEvidence，且不得提交额外记录",
    });
  }
  for (const change of input.changeEvidence) {
    requireEvidenceIds(change.evidenceSpanIds, `${change.kind}:${change.recordId}`);
  }
  const entityIds = new Set(state.entities.map((entry) => entry.entityId));
  const chapterIds = new Set(orderedChapters(snapshot).map((entry) => entry.chapterId));
  const rejectReference = (message: string): never => rejectWritingState(message, {
    reason: "invalid_reference",
    chapterId: input.chapterId,
    nextAction: "重新读取当前 writing-state 与章节列表后修正候选引用",
  });
  for (const delta of input.delta.characterStates) {
    if (!entityIds.has(delta.entityId)) rejectReference(`角色状态引用未知实体：${delta.entityId}`);
    const prior = state.characterStates.find((entry) => entry.stateId === delta.stateId);
    if (prior && prior.entityId !== delta.entityId) {
      rejectReference(`stateId ${delta.stateId} 已绑定其他实体，拒绝换绑。`);
    }
  }
  for (const delta of input.delta.knowledge) {
    if (!entityIds.has(delta.entityId)) rejectReference(`知情记录引用未知实体：${delta.entityId}`);
    for (const chapterId of [delta.effectiveFromChapterId, delta.effectiveUntilChapterId]) {
      if (chapterId && !chapterIds.has(chapterId)) rejectReference(`知情记录引用未知章节：${chapterId}`);
    }
    const prior = state.knowledge.find((entry) => entry.knowledgeId === delta.knowledgeId);
    if (prior && prior.entityId !== delta.entityId) {
      rejectReference(`knowledgeId ${delta.knowledgeId} 已绑定其他实体，拒绝换绑。`);
    }
  }
  for (const delta of input.delta.relationships) {
    if (!entityIds.has(delta.fromEntityId) || !entityIds.has(delta.toEntityId)) {
      rejectReference(`关系记录引用未知实体：${delta.relationshipId}`);
    }
  }
  for (const delta of input.delta.timeline) {
    for (const chapterId of [delta.startChapterId, delta.endChapterId, delta.disclosureChapterId]) {
      if (chapterId && !chapterIds.has(chapterId)) rejectReference(`时间线引用未知章节：${chapterId}`);
    }
  }
  for (const delta of input.delta.foreshadowing) {
    for (const chapterId of [delta.setupChapterId, ...delta.maintenanceChapterIds, delta.payoffChapterId]) {
      if (chapterId && !chapterIds.has(chapterId)) rejectReference(`伏笔记录引用未知章节：${chapterId}`);
    }
  }
  const requiredCharacterIds = state.chapterBriefs.find((entry) => entry.chapterId === input.chapterId)?.requiredCharacterIds;
  const checkedCharacterIds = input.auditScope.checkedCharacterIds;
  const requiredStateKinds = ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"] as const;
  if (requiredCharacterIds === undefined
    || new Set(checkedCharacterIds).size !== checkedCharacterIds.length
    || checkedCharacterIds.length !== requiredCharacterIds.length
    || checkedCharacterIds.some((entityId) => !requiredCharacterIds.includes(entityId))) {
    rejectReference("candidate auditScope.checkedCharacterIds 必须与目标章 required cast 完全一致。");
  }
  if (new Set(input.auditScope.checkedStateKinds).size !== requiredStateKinds.length
    || requiredStateKinds.some((kind) => !input.auditScope.checkedStateKinds.includes(kind))) {
    rejectReference("candidate auditScope.checkedStateKinds 必须完整覆盖五类状态。");
  }
  if (input.noStateChange
    && (input.noStateChange.checkedCharacterIds.length !== checkedCharacterIds.length
      || input.noStateChange.checkedCharacterIds.some((entityId) => !checkedCharacterIds.includes(entityId)))) {
    rejectReference("noStateChange.checkedCharacterIds 必须与 candidate auditScope 完全一致。");
  }
  const identity = {
    projectId: snapshot.workspace.projectId,
    chapter: chapterIdentity(chapter),
    baseWritingStateRevision: state.revision,
    baseWritingStateFingerprint: state.fingerprint,
    summary: input.summary,
    delta: input.delta,
    evidenceSpans: input.evidenceSpans,
    changeEvidence: input.changeEvidence,
    ...(input.noStateChange === undefined ? {} : { noStateChange: input.noStateChange }),
    auditScope: input.auditScope,
    changeKind: input.noStateChange ? "no_state_change" as const : "delta" as const,
    offsetEncoding: "utf16-code-unit" as const,
  };
  const candidateId = `novel-state-candidate-${fingerprint(identity).slice(0, 24)}`;
  const candidate = artifactWithFingerprint({
    schemaVersion: 2 as const,
    kind: "novel-chapter-state-candidate" as const,
    candidateId,
    ...identity,
    createdAt: chapter.updatedAt,
  });
  const created = await persistImmutableOrVerify(projectRoot, candidateLocator(candidateId), jsonBytes(candidate));
  return { candidate, replayed: !created };
}

async function loadCandidate(projectRoot: string, candidateId: string, projectId: string): Promise<NovelAnyChapterStateCandidate> {
  const bytes = await readOptionalProjectFile(projectRoot, candidateLocator(candidateId), MAX_WRITING_ARTIFACT_BYTES);
  if (!bytes) rejectWritingState("状态候选不存在。", { reason: "not_found", candidateId });
  const candidate = validateFingerprintArtifact<NovelAnyChapterStateCandidate>(
    parseJson(bytes, "状态候选"),
    "novel-chapter-state-candidate",
  );
  if (candidate.projectId !== projectId || candidate.candidateId !== candidateId) {
    throw new Error("状态候选与工程或locator身份不一致。");
  }
  return candidate;
}

async function loadDecision(projectRoot: string, candidateId: string): Promise<NovelChapterStateDecision | null> {
  const bytes = await readOptionalProjectFile(projectRoot, decisionLocator(candidateId), MAX_WRITING_ARTIFACT_BYTES);
  return bytes ? validateFingerprintArtifact<NovelChapterStateDecision>(
    parseJson(bytes, "状态候选裁决"),
    "novel-chapter-state-decision",
  ) : null;
}

/**
 * 有界列出仍未裁决的章末状态候选。目录与每个普通文件都复验受管身份；
 * 调用方拿到的是已验证 artifact，不需要也不得自行扫描 sidecar。
 */
export async function listNovelPendingChapterStateCandidates(
  projectRoot: string,
  projectId: string,
  maximumEntries = 10_000,
): Promise<NovelAnyChapterStateCandidate[]> {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 100_000) {
    throw new Error("状态候选目录读取上限无效。");
  }
  const resolved = resolveNovelProjectLocator(projectRoot, WRITING_CANDIDATES_RELATIVE_PATH);
  let directory;
  try {
    directory = await inspectExistingConfinedDirectory(projectRoot, resolved.absolutePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  await revalidateConfinedDirectory(directory);
  const entries = await readdir(directory.directory, { withFileTypes: true });
  await revalidateConfinedDirectory(directory);
  if (entries.length > maximumEntries) throw new Error("状态候选目录条目超过允许上限。");

  const candidateIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
      throw new Error(`状态候选目录包含非受管 JSON 普通文件：${entry.name}`);
    }
    const candidateId = entry.name.slice(0, -5);
    if (!STATE_CANDIDATE_ID_PATTERN.test(candidateId)) {
      throw new Error(`状态候选文件名无效：${entry.name}`);
    }
    candidateIds.push(candidateId);
  }

  const pending: NovelAnyChapterStateCandidate[] = [];
  for (const candidateId of candidateIds.sort((left, right) => left.localeCompare(right, "en"))) {
    const candidate = await loadCandidate(projectRoot, candidateId, projectId);
    const decision = await loadDecision(projectRoot, candidateId);
    if (decision) {
      if (decision.projectId !== projectId
        || decision.candidateId !== candidate.candidateId
        || decision.candidateFingerprint !== candidate.fingerprint) {
        throw new Error(`状态候选裁决与候选身份不一致：${candidateId}`);
      }
      continue;
    }
    pending.push(candidate);
  }
  return pending.sort((left, right) => left.createdAt.localeCompare(right.createdAt, "en")
    || left.candidateId.localeCompare(right.candidateId, "en"));
}

function upsertById<T>(items: readonly T[], next: T, id: (value: T) => string): T[] {
  const nextId = id(next);
  const found = items.some((item) => id(item) === nextId);
  return found ? items.map((item) => id(item) === nextId ? next : item) : [...items, next];
}

function nextRecordRevision<T>(items: readonly T[], id: (value: T) => string, targetId: string, revision: (value: T) => number): number {
  return items.reduce((maximum, item) => id(item) === targetId ? Math.max(maximum, revision(item)) : maximum, 0) + 1;
}

function applyCandidate(
  state: NovelWritingStateDocument,
  candidate: NovelChapterStateCandidate,
): NovelWritingStateDocument {
  const sourceChapter = candidate.chapter;
  let characterStates = [...state.characterStates];
  for (const delta of candidate.delta.characterStates) {
    const revision = nextRecordRevision(characterStates, (entry) => entry.stateId, delta.stateId, (entry) => entry.revision);
    characterStates.push({
      stateId: delta.stateId,
      entityId: delta.entityId,
      throughChapterId: candidate.chapter.chapterId,
      fields: delta.fields,
      sourceIds: [],
      sourceChapter,
      revision,
    });
  }
  let knowledge = [...state.knowledge];
  for (const delta of candidate.delta.knowledge) {
    const revision = nextRecordRevision(knowledge, (entry) => entry.knowledgeId, delta.knowledgeId, (entry) => entry.revision);
    const next: NovelKnowledgeRecord = {
      ...delta,
      sourceIds: [],
      sourceChapter,
      revision,
    };
    knowledge.push(next);
  }
  let relationships = [...state.relationships];
  for (const delta of candidate.delta.relationships) {
    const revision = nextRecordRevision(relationships, (entry) => entry.relationshipId, delta.relationshipId, (entry) => entry.revision);
    const next: NovelRelationshipRecord = {
      ...delta,
      throughChapterId: candidate.chapter.chapterId,
      sourceIds: [],
      sourceChapter,
      revision,
    };
    relationships.push(next);
  }
  let timeline = [...state.timeline];
  for (const delta of candidate.delta.timeline) {
    const revision = nextRecordRevision(timeline, (entry) => entry.timelineId, delta.timelineId, (entry) => entry.revision);
    const next: NovelTimelineRecord = {
      ...delta,
      sourceIds: [],
      sourceChapter,
      revision,
    };
    timeline.push(next);
  }
  let foreshadowing = [...state.foreshadowing];
  for (const delta of candidate.delta.foreshadowing) {
    const revision = nextRecordRevision(foreshadowing, (entry) => entry.foreshadowingId, delta.foreshadowingId, (entry) => entry.revision);
    const next: NovelForeshadowingRecord = {
      ...delta,
      sourceIds: [],
      sourceChapter,
      revision,
    };
    foreshadowing.push(next);
  }
  const updatedAt = nextIsoTimestamp(state.updatedAt);
  const completion: NovelChapterStateCompletion = {
    chapterId: candidate.chapter.chapterId,
    chapterRevision: candidate.chapter.chapterRevision,
    chapterSha256: candidate.chapter.chapterSha256,
    stateCommitId: `novel-state-commit-${fingerprint({ candidateId: candidate.candidateId, state: state.fingerprint }).slice(0, 24)}`,
    candidateId: candidate.candidateId,
    committedAt: updatedAt,
  };
  let nextRebuild: NovelWritingStateDocument["rebuild"];
  if (state.rebuild) {
    if (state.rebuild.nextChapterId !== candidate.chapter.chapterId
      || state.rebuild.pendingChapterIds[0] !== candidate.chapter.chapterId) {
      rejectWritingState("状态候选与当前 rebuild cursor 不一致。", {
        reason: "state_rebuild_out_of_order",
        chapterId: candidate.chapter.chapterId,
        candidateId: candidate.candidateId,
        nextAction: `只允许处理 ${state.rebuild.nextChapterId}`,
      });
    }
    const remaining = state.rebuild.pendingChapterIds.slice(1);
    nextRebuild = remaining.length ? {
      ...state.rebuild,
      pendingChapterIds: remaining,
      nextChapterId: remaining[0]!,
    } : undefined;
  }
  const { fingerprint: _previousFingerprint, rebuild: _previousRebuild, ...baseState } = state;
  return stateWithFingerprint({
    ...baseState,
    revision: state.revision + 1,
    currentThroughChapterId: candidate.chapter.chapterId,
    characterStates,
    knowledge,
    relationships,
    timeline,
    foreshadowing,
    chapterCompletions: upsertById(state.chapterCompletions, completion, (entry) => entry.chapterId),
    appliedCandidateIds: [...state.appliedCandidateIds, candidate.candidateId],
    ...(nextRebuild ? { rebuild: nextRebuild } : {}),
    updatedAt,
  });
}

export async function reviewNovelChapterStateCandidate(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
  input: NovelReviewChapterStateCandidateInput,
): Promise<{ decision: NovelChapterStateDecision; state: NovelWritingStateDocument; replayed: boolean }> {
  requireManagedSnapshot(snapshot);
  await recoverIncompleteNovelWritingStateOperations(projectRoot, snapshot.workspace.projectId);
  const candidate = await loadCandidate(projectRoot, input.candidateId, snapshot.workspace.projectId);
  if (candidate.fingerprint !== input.expectedCandidateFingerprint) {
    rejectWritingState("状态候选fingerprint CAS已过期。", {
      reason: "content_conflict",
      candidateId: input.candidateId,
      expectedFingerprint: input.expectedCandidateFingerprint,
      currentFingerprint: candidate.fingerprint,
    });
  }
  let state = await loadNovelWritingState(projectRoot, snapshot.workspace.projectId);
  if (!state) rejectWritingState("写作状态尚未初始化。", {
    reason: "writing_state_missing",
    chapterId: candidate.chapter.chapterId,
    nextAction: "执行 novel_seed_writing_state",
  });
  const existing = await loadDecision(projectRoot, candidate.candidateId);
  if (existing) {
    if (existing.candidateFingerprint !== candidate.fingerprint
      || existing.decision !== input.decision
      || existing.reviewer !== input.reviewer
      || existing.note !== input.note) {
      rejectWritingState("状态候选已有不同裁决。", {
        reason: "content_conflict",
        candidateId: candidate.candidateId,
        currentFingerprint: existing.fingerprint,
      });
    }
    return { decision: existing, state, replayed: true };
  }
  if (candidate.schemaVersion !== 2) {
    rejectWritingState("旧版状态候选缺少完整审计范围与可复验证据，禁止首次裁决。", {
      reason: "legacy_candidate_requires_restage",
      chapterId: candidate.chapter.chapterId,
      candidateId: candidate.candidateId,
      nextAction: "基于当前正文和 writing-state 重新 stage V2 候选",
    });
  }
  const chapter = requireChapter(snapshot, candidate.chapter.chapterId);
  assertChapterCas(chapter, candidate.chapter.chapterRevision, candidate.chapter.chapterSha256);
  const chapterRead = await readNovelProjectFile(projectRoot, chapter.relativePath, {
    maxBytes: Math.max(chapter.byteLength, 1),
  });
  if (chapterRead.sha256 !== candidate.chapter.chapterSha256
    || chapterRead.bytes.byteLength !== chapter.byteLength) {
    rejectWritingState("状态候选裁决前检测到真实正文已偏离候选证据。", {
      reason: "content_conflict",
      chapterId: chapter.chapterId,
      candidateId: candidate.candidateId,
      expectedSha256: candidate.chapter.chapterSha256,
      currentSha256: chapterRead.sha256,
      nextAction: "恢复/纳管正文外部变化后，基于当前正文重新 stage 状态候选",
    });
  }
  const chapterContent = new TextDecoder("utf-8", { fatal: true }).decode(chapterRead.bytes);
  if (!Array.isArray(candidate.evidenceSpans) || candidate.evidenceSpans.length === 0
    || chapterContent.length !== chapter.charCount
    || candidate.evidenceSpans.some((evidence) => !Number.isSafeInteger(evidence.startOffset)
      || !Number.isSafeInteger(evidence.endOffset)
      || evidence.startOffset < 0
      || evidence.endOffset <= evidence.startOffset
      || evidence.endOffset > chapterContent.length
      || splitsUtf16SurrogatePair(chapterContent, evidence.startOffset)
      || splitsUtf16SurrogatePair(chapterContent, evidence.endOffset)
      || chapterContent.slice(evidence.startOffset, evidence.endOffset) !== evidence.evidenceExcerpt)) {
    rejectWritingState("状态候选的正文证据在裁决时无法复验。", {
      reason: "content_conflict",
      chapterId: chapter.chapterId,
      candidateId: candidate.candidateId,
      expectedSha256: candidate.chapter.chapterSha256,
      currentSha256: chapterRead.sha256,
      nextAction: "重新读取当前正文并以 UTF-16 code unit 证据重新 stage 候选",
    });
  }
  const alreadyApplied = state.appliedCandidateIds.includes(candidate.candidateId);
  if (!alreadyApplied) {
    assertStateCas(state, input.expectedWritingStateRevision, input.expectedWritingStateFingerprint);
    if (candidate.baseWritingStateRevision !== state.revision
      || candidate.baseWritingStateFingerprint !== state.fingerprint) {
      rejectWritingState("状态候选基线已过期。", {
        reason: "revision_conflict",
        candidateId: candidate.candidateId,
        expectedRevision: candidate.baseWritingStateRevision,
        currentRevision: state.revision,
        expectedFingerprint: candidate.baseWritingStateFingerprint,
        currentFingerprint: state.fingerprint,
        nextAction: "基于当前状态重新stage候选",
      });
    }
    const ordered = orderedChapters(snapshot);
    const currentThroughChapterId = state.currentThroughChapterId;
    const currentIndex = ordered.findIndex((entry) => entry.chapterId === currentThroughChapterId);
    const candidateIndex = ordered.findIndex((entry) => entry.chapterId === candidate.chapter.chapterId);
    if (currentIndex < 0 || candidateIndex !== currentIndex + 1) {
      rejectWritingState("accepted状态候选必须精确推进到currentThrough的下一章。", {
        reason: "invalid_target",
        chapterId: candidate.chapter.chapterId,
        candidateId: candidate.candidateId,
        nextAction: "先补齐中间章节的状态commit",
      });
    }
  }
  const nextState = input.decision === "accepted" && !alreadyApplied
    ? applyCandidate(state, candidate)
    : state;
  const decidedAt = input.decision === "accepted" ? nextState.updatedAt : nextIsoTimestamp(state.updatedAt);
  const decision = artifactWithFingerprint({
    schemaVersion: 1 as const,
    kind: "novel-chapter-state-decision" as const,
    decisionId: `novel-state-decision-${fingerprint({ candidateId: candidate.candidateId, decision: input.decision, reviewer: input.reviewer }).slice(0, 24)}`,
    projectId: snapshot.workspace.projectId,
    candidateId: candidate.candidateId,
    candidateFingerprint: candidate.fingerprint,
    decision: input.decision,
    reviewer: input.reviewer,
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.decision === "accepted" ? {
      writingStateRevision: nextState.revision,
      writingStateFingerprint: nextState.fingerprint,
    } : {}),
    decidedAt,
  });
  if (input.decision === "accepted" && !alreadyApplied) {
    const result = { decision, state: nextState, replayed: false };
    if (state.rebuild) {
      await commitShadowWritingStateHistoryTransition({
        projectRoot,
        snapshot,
        beforeState: state,
        afterState: nextState,
        candidate,
        decision,
        result,
      });
      return result;
    }
    await commitPublicWritingStateHistoryTransition({
      projectRoot,
      snapshot,
      command: "novel_review_chapter_state_candidate",
      beforeState: state,
      afterState: nextState,
      operationKind: "chapter_state_commit",
      chapter: candidate.chapter,
      candidateId: candidate.candidateId,
      candidateFingerprint: candidate.fingerprint,
      contribution: candidate.changeKind === "no_state_change" ? "no_change" : "changes",
      decision,
      decisionLocator: decisionLocator(candidate.candidateId),
      result,
    });
    return result;
  }
  await persistImmutableOrVerify(projectRoot, decisionLocator(candidate.candidateId), jsonBytes(decision));
  return { decision, state: nextState, replayed: false };
}

function storyBibleCandidateLocator(candidateId: string): string {
  return `${STORY_BIBLE_CANDIDATES_RELATIVE_PATH}/${candidateId}.json`;
}

function storyBibleDecisionLocator(candidateId: string): string {
  return `${STORY_BIBLE_DECISIONS_RELATIVE_PATH}/${candidateId}.json`;
}

async function loadStoryBibleCandidate(
  projectRoot: string,
  candidateId: string,
  projectId: string,
): Promise<NovelStoryBibleCandidate> {
  const bytes = await readOptionalProjectFile(projectRoot, storyBibleCandidateLocator(candidateId), MAX_WRITING_ARTIFACT_BYTES);
  if (!bytes) rejectWritingState("Story Bible 候选不存在。", { reason: "not_found", candidateId });
  const candidate = validateFingerprintArtifact<NovelStoryBibleCandidate>(
    parseJson(bytes, "Story Bible 候选"),
    "novel-story-bible-candidate",
  );
  if (candidate.projectId !== projectId || candidate.candidateId !== candidateId || candidate.schemaVersion !== 1) {
    throw new Error("Story Bible 候选与工程或 locator 身份不一致。");
  }
  return candidate;
}

async function loadStoryBibleDecision(projectRoot: string, candidateId: string): Promise<NovelStoryBibleDecision | null> {
  const bytes = await readOptionalProjectFile(projectRoot, storyBibleDecisionLocator(candidateId), MAX_WRITING_ARTIFACT_BYTES);
  return bytes ? validateFingerprintArtifact<NovelStoryBibleDecision>(
    parseJson(bytes, "Story Bible 候选裁决"),
    "novel-story-bible-decision",
  ) : null;
}

function latestRevisionMap<T>(items: readonly T[], id: (item: T) => string, revision: (item: T) => number): Map<string, T> {
  return new Map(latestByKey(items, id, revision).map((item) => [id(item), item]));
}

export async function stageNovelStoryBibleCandidate(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
  input: NovelStageStoryBibleCandidateInput,
): Promise<{ candidate: NovelStoryBibleCandidate; replayed: boolean }> {
  requireManagedSnapshot(snapshot);
  const state = await loadNovelWritingState(projectRoot, snapshot.workspace.projectId);
  if (!state) rejectWritingState("写作状态尚未初始化。", {
    reason: "writing_state_missing",
    nextAction: "由 owner 执行 novel_seed_writing_state",
  });
  assertStateCas(state, input.expectedWritingStateRevision, input.expectedWritingStateFingerprint);
  assertUnique(input.changes.map((change) => change.changeId), "storyBible.changeId");
  const ordered = orderedChapters(snapshot);
  const chapterIndices = new Map(ordered.map((chapter, index) => [chapter.chapterId, index]));
  const currentIndex = chapterIndices.get(state.currentThroughChapterId);
  if (currentIndex === undefined) throw new Error("writing-state currentThroughChapterId 不存在于当前章节顺序。");
  const sourceIds = new Set(state.sources.map((source) => source.sourceId));
  const resolvedSourceBindings = await Promise.all(input.changes
    .filter((change) => change.kind === "source_binding")
    .map((change) => resolveNovelWritingSourceBinding(
      projectRoot,
      snapshot.workspace.projectId,
      change.value,
    )));
  assertUnique(resolvedSourceBindings.map((source) => source.sourceId), "storyBible.sourceBinding.sourceId");
  for (const source of resolvedSourceBindings) {
    const existing = state.sources.find((entry) => entry.sourceId === source.sourceId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(source)) {
      rejectWritingState(`sourceId 已绑定另一份来源身份：${source.sourceId}`, {
        reason: "invalid_reference",
        nextAction: "重新读取 writing source receipts，使用 Core 派生的 suggestedSourceId",
      });
    }
    sourceIds.add(source.sourceId);
  }
  const latestEntities = latestRevisionMap(state.entities, (entry) => entry.entityId, (entry) => entry.revision);
  const latestCanon = latestRevisionMap(state.hardCanon, (entry) => entry.ruleId, (entry) => entry.revision);
  const latestBriefs = latestRevisionMap(state.chapterBriefs, (entry) => entry.chapterId, (entry) => entry.revision);
  const latestProfiles = latestRevisionMap(state.characterProfiles ?? [], (entry) => entry.entityId, (entry) => entry.revision);
  const latestAppearances = latestRevisionMap(state.characterAppearances ?? [], (entry) => entry.entityId, (entry) => entry.revision);
  const latestIssues = latestRevisionMap(state.continuityIssues ?? [], (entry) => entry.issueId, (entry) => entry.revision);
  const entityIds = new Set([...latestEntities.keys(), ...input.changes
    .filter((change) => change.kind === "entity")
    .map((change) => change.value.entityId)]);
  const targetKeys = input.changes.map((change) => {
    if (change.kind === "source_binding") return `source_binding:${change.value.sourceId}`;
    if (change.kind === "entity") return `entity:${change.value.entityId}`;
    if (change.kind === "hard_canon") return `hard_canon:${change.value.ruleId}`;
    if (change.kind === "chapter_brief") return `chapter_brief:${change.value.chapterId}`;
    if (change.kind === "character_profile") return `character_profile:${change.value.entityId}`;
    if (change.kind === "character_appearance") return `character_appearance:${change.value.entityId}`;
    return `continuity_issue:${change.value.issueId}`;
  });
  assertUnique(targetKeys, "storyBible change target");
  const rejectReference = (message: string): never => rejectWritingState(message, {
    reason: "invalid_reference",
    nextAction: "重新读取当前 writing-state/章节列表，修正 Story Bible 候选后重试",
  });
  const requireSources = (ids: readonly string[], label: string): void => {
    for (const sourceId of ids) if (!sourceIds.has(sourceId)) rejectReference(`${label} 引用未知 sourceId：${sourceId}`);
  };
  const requireFutureChapter = (chapterId: string | undefined, label: string): void => {
    const index = chapterId ? chapterIndices.get(chapterId) : undefined;
    if (index === undefined) return rejectReference(`${label} 必须引用存在的 effectiveFromChapterId。`);
    if (index <= currentIndex) {
      rejectWritingState(`${label} 会回溯改变已完成章节，必须先进入显式状态重建。`, {
        reason: "retcon_requires_invalidation",
        chapterId,
        nextAction: "先规划并由 owner 启动从最早受影响章节开始的 state rebuild",
      });
    }
  };
  const requireSupersedes = (existing: { revision: number } | undefined, supplied: number | undefined, label: string): void => {
    if (existing && supplied !== existing.revision) rejectReference(`${label} supersedesRevision 必须等于当前 revision ${existing.revision}。`);
    if (!existing && supplied !== undefined) rejectReference(`${label} 是新记录，不得声明 supersedesRevision。`);
  };
  for (const change of input.changes) {
    if (change.kind === "source_binding") continue;
    if (change.kind === "entity") {
      const existing = latestEntities.get(change.value.entityId);
      requireSupersedes(existing, change.supersedesRevision, `entity:${change.value.entityId}`);
      requireFutureChapter(change.value.effectiveFromChapterId, `entity:${change.value.entityId}`);
      requireSources(change.value.sourceIds, `entity:${change.value.entityId}`);
      continue;
    }
    if (change.kind === "hard_canon") {
      const existing = latestCanon.get(change.value.ruleId);
      requireSupersedes(existing, change.supersedesRevision, `hard_canon:${change.value.ruleId}`);
      requireFutureChapter(change.value.effectiveFromChapterId, `hard_canon:${change.value.ruleId}`);
      requireSources(change.value.sourceIds, `hard_canon:${change.value.ruleId}`);
      continue;
    }
    if (change.kind === "chapter_brief") {
      const existing = latestBriefs.get(change.value.chapterId);
      requireSupersedes(existing, change.supersedesRevision, `chapter_brief:${change.value.chapterId}`);
      requireFutureChapter(change.value.chapterId, `chapter_brief:${change.value.chapterId}`);
      requireSources(change.value.sourceIds, `chapter_brief:${change.value.chapterId}`);
      const requiredCharacterIds = change.value.requiredCharacterIds
        ?? rejectReference("受管 chapter brief 必须显式声明 requiredCharacterIds。");
      assertUnique(requiredCharacterIds, `chapterBrief.requiredCharacterIds:${change.value.chapterId}`);
      for (const entityId of requiredCharacterIds) {
        if (!entityIds.has(entityId)) rejectReference(`chapter brief 引用未知角色：${entityId}`);
      }
      continue;
    }
    if (change.kind === "character_profile") {
      const existing = latestProfiles.get(change.value.entityId);
      requireSupersedes(existing, change.supersedesRevision, `character_profile:${change.value.entityId}`);
      if (!entityIds.has(change.value.entityId)) rejectReference(`人物声口卡引用未知角色：${change.value.entityId}`);
      requireFutureChapter(change.value.effectiveFromChapterId, `character_profile:${change.value.entityId}`);
      requireSources(change.value.sourceIds, `character_profile:${change.value.entityId}`);
      assertUnique(change.value.relationshipVoices.map((entry) => entry.targetEntityId), `relationshipVoices:${change.value.entityId}`);
      for (const relation of change.value.relationshipVoices) {
        if (!entityIds.has(relation.targetEntityId)) rejectReference(`人物声口卡引用未知关系对象：${relation.targetEntityId}`);
      }
      continue;
    }
    if (change.kind === "character_appearance") {
      const existing = latestAppearances.get(change.value.entityId);
      requireSupersedes(existing, change.supersedesRevision, `character_appearance:${change.value.entityId}`);
      if (!entityIds.has(change.value.entityId)) rejectReference(`人物外形卡引用未知角色：${change.value.entityId}`);
      requireFutureChapter(change.value.effectiveFromChapterId, `character_appearance:${change.value.entityId}`);
      requireSources(change.value.sourceIds, `character_appearance:${change.value.entityId}`);
      if (change.value.locks.length === 0) rejectReference(`人物外形卡至少需要一个结构化锁：${change.value.entityId}`);
      assertUnique(change.value.locks.map((entry) => entry.lockId), `characterAppearance.lockId:${change.value.entityId}`);
      for (const lock of change.value.locks) {
        assertUnique(lock.allowedVariants, `characterAppearance.allowedVariants:${change.value.entityId}:${lock.lockId}`);
        assertUnique(lock.contradictionPhrases, `characterAppearance.contradictionPhrases:${change.value.entityId}:${lock.lockId}`);
      }
      if (existing) {
        const nextLocks = new Map(change.value.locks.map((lock) => [lock.lockId, lock]));
        for (const priorLock of existing.locks.filter((lock) => lock.mutability === "immutable")) {
          const nextLock = nextLocks.get(priorLock.lockId);
          const immutableIdentityUnchanged = Boolean(nextLock
            && nextLock.mutability === "immutable"
            && nextLock.category === priorLock.category
            && nextLock.canonicalDescription === priorLock.canonicalDescription
            && JSON.stringify(nextLock.allowedVariants) === JSON.stringify(priorLock.allowedVariants));
          if (!immutableIdentityUnchanged) {
            rejectWritingState(`人物外形不可变锁 ${priorLock.lockId} 不得删除或改写。`, {
              reason: "retcon_requires_invalidation",
              chapterId: change.value.effectiveFromChapterId,
              nextAction: "先由 owner 评估是否需要从最早受影响章节启动 state rebuild；不得用普通未来 revision 静默改写不可变外形",
            });
          }
        }
      }
      continue;
    }
    const existing = latestIssues.get(change.value.issueId);
    requireSupersedes(existing, change.supersedesRevision, `continuity_issue:${change.value.issueId}`);
    requireSources(change.value.sourceIds, `continuity_issue:${change.value.issueId}`);
    assertUnique(change.value.chapterIds, `continuityIssue.chapterIds:${change.value.issueId}`);
    assertUnique(change.value.entityIds, `continuityIssue.entityIds:${change.value.issueId}`);
    for (const chapterId of change.value.chapterIds) if (!chapterIndices.has(chapterId)) rejectReference(`连续性问题引用未知章节：${chapterId}`);
    for (const entityId of change.value.entityIds) if (!entityIds.has(entityId)) rejectReference(`连续性问题引用未知实体：${entityId}`);
    if (change.value.status === "resolved" && !change.value.resolution) {
      rejectReference(`已解决连续性问题必须填写 resolution：${change.value.issueId}`);
    }
  }
  const identity = {
    projectId: snapshot.workspace.projectId,
    baseWritingStateRevision: state.revision,
    baseWritingStateFingerprint: state.fingerprint,
    summary: input.summary,
    changes: input.changes,
    ...(resolvedSourceBindings.length ? { resolvedSourceBindings } : {}),
  };
  const candidateId = `novel-bible-candidate-${fingerprint(identity).slice(0, 24)}`;
  const candidate = artifactWithFingerprint({
    schemaVersion: 1 as const,
    kind: "novel-story-bible-candidate" as const,
    candidateId,
    ...identity,
    createdAt: state.updatedAt,
  });
  const created = await persistImmutableOrVerify(projectRoot, storyBibleCandidateLocator(candidateId), jsonBytes(candidate));
  return { candidate, replayed: !created };
}

function applyStoryBibleCandidate(
  state: NovelWritingStateDocument,
  candidate: NovelStoryBibleCandidate,
): NovelWritingStateDocument {
  let entities = [...state.entities];
  let sources = [...state.sources];
  let hardCanon = [...state.hardCanon];
  let chapterBriefs = [...state.chapterBriefs];
  let characterProfiles = [...(state.characterProfiles ?? [])];
  let characterAppearances = [...(state.characterAppearances ?? [])];
  let continuityIssues = [...(state.continuityIssues ?? [])];
  for (const change of candidate.changes) {
    if (change.kind === "source_binding") {
      const source = candidate.resolvedSourceBindings?.find((entry) => entry.sourceId === change.value.sourceId);
      if (!source) throw new Error(`Story Bible candidate 缺少已解析 source binding：${change.value.sourceId}`);
      const existing = sources.find((entry) => entry.sourceId === source.sourceId);
      if (!existing) sources.push(source);
      else if (JSON.stringify(existing) !== JSON.stringify(source)) throw new Error(`Story Bible source binding 身份冲突：${source.sourceId}`);
    } else if (change.kind === "entity") {
      entities.push({ ...change.value, revision: nextRecordRevision(entities, (entry) => entry.entityId, change.value.entityId, (entry) => entry.revision) });
    } else if (change.kind === "hard_canon") {
      hardCanon.push({ ...change.value, revision: nextRecordRevision(hardCanon, (entry) => entry.ruleId, change.value.ruleId, (entry) => entry.revision) });
    } else if (change.kind === "chapter_brief") {
      chapterBriefs.push({ ...change.value, revision: nextRecordRevision(chapterBriefs, (entry) => entry.chapterId, change.value.chapterId, (entry) => entry.revision) });
    } else if (change.kind === "character_profile") {
      characterProfiles.push({
        ...change.value,
        revision: nextRecordRevision(characterProfiles, (entry) => entry.entityId, change.value.entityId, (entry) => entry.revision),
      });
    } else if (change.kind === "character_appearance") {
      characterAppearances.push({
        ...change.value,
        revision: nextRecordRevision(characterAppearances, (entry) => entry.entityId, change.value.entityId, (entry) => entry.revision),
      });
    } else {
      continuityIssues.push({
        ...change.value,
        revision: nextRecordRevision(continuityIssues, (entry) => entry.issueId, change.value.issueId, (entry) => entry.revision),
      });
    }
  }
  const updatedAt = nextIsoTimestamp(state.updatedAt);
  const { fingerprint: _previousFingerprint, ...baseState } = state;
  return stateWithFingerprint({
    ...baseState,
    revision: state.revision + 1,
    sources,
    entities,
    hardCanon,
    chapterBriefs,
    characterProfiles,
    characterAppearances,
    continuityIssues,
    appliedStoryBibleCandidateIds: [...(state.appliedStoryBibleCandidateIds ?? []), candidate.candidateId],
    updatedAt,
  });
}

export async function reviewNovelStoryBibleCandidate(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
  input: NovelReviewStoryBibleCandidateInput,
): Promise<{ decision: NovelStoryBibleDecision; state: NovelWritingStateDocument; replayed: boolean }> {
  requireManagedSnapshot(snapshot);
  await recoverIncompleteNovelWritingStateOperations(projectRoot, snapshot.workspace.projectId);
  const candidate = await loadStoryBibleCandidate(projectRoot, input.candidateId, snapshot.workspace.projectId);
  if (candidate.fingerprint !== input.expectedCandidateFingerprint) {
    rejectWritingState("Story Bible 候选 fingerprint CAS 已过期。", {
      reason: "content_conflict",
      candidateId: input.candidateId,
      expectedFingerprint: input.expectedCandidateFingerprint,
      currentFingerprint: candidate.fingerprint,
    });
  }
  let state = await loadNovelWritingState(projectRoot, snapshot.workspace.projectId);
  if (!state) rejectWritingState("写作状态尚未初始化。", { reason: "writing_state_missing" });
  if (state.rebuild) rejectWritingState("状态重建期间禁止并行修改 Story Bible。", {
    reason: "state_rebuild_active",
    chapterId: state.rebuild.nextChapterId,
    nextAction: `先按顺序完成 ${state.rebuild.nextChapterId} 起的状态重建`,
  });
  const existing = await loadStoryBibleDecision(projectRoot, candidate.candidateId);
  if (existing) {
    if (existing.candidateFingerprint !== candidate.fingerprint
      || existing.decision !== input.decision
      || existing.reviewer !== input.reviewer
      || existing.note !== input.note) {
      rejectWritingState("Story Bible 候选已有不同裁决。", {
        reason: "content_conflict",
        candidateId: candidate.candidateId,
        currentFingerprint: existing.fingerprint,
      });
    }
    return { decision: existing, state, replayed: true };
  }
  assertStateCas(state, input.expectedWritingStateRevision, input.expectedWritingStateFingerprint);
  if (candidate.baseWritingStateRevision !== state.revision
    || candidate.baseWritingStateFingerprint !== state.fingerprint) {
    rejectWritingState("Story Bible 候选基线已过期。", {
      reason: "revision_conflict",
      candidateId: candidate.candidateId,
      expectedRevision: candidate.baseWritingStateRevision,
      currentRevision: state.revision,
      expectedFingerprint: candidate.baseWritingStateFingerprint,
      currentFingerprint: state.fingerprint,
      nextAction: "基于当前 writing-state 重新 stage Story Bible 候选",
    });
  }
  const nextState = input.decision === "accepted" ? applyStoryBibleCandidate(state, candidate) : state;
  const decidedAt = input.decision === "accepted" ? nextState.updatedAt : nextIsoTimestamp(state.updatedAt);
  const decision = artifactWithFingerprint({
    schemaVersion: 1 as const,
    kind: "novel-story-bible-decision" as const,
    decisionId: `novel-bible-decision-${fingerprint({ candidateId: candidate.candidateId, decision: input.decision, reviewer: input.reviewer }).slice(0, 24)}`,
    projectId: snapshot.workspace.projectId,
    candidateId: candidate.candidateId,
    candidateFingerprint: candidate.fingerprint,
    decision: input.decision,
    reviewer: input.reviewer,
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.decision === "accepted" ? {
      writingStateRevision: nextState.revision,
      writingStateFingerprint: nextState.fingerprint,
    } : {}),
    decidedAt,
  });
  if (input.decision === "accepted") {
    const result = { decision, state: nextState, replayed: false };
    await commitPublicWritingStateHistoryTransition({
      projectRoot,
      snapshot,
      command: "novel_review_story_bible_candidate",
      beforeState: state,
      afterState: nextState,
      operationKind: "story_bible_commit",
      candidateId: candidate.candidateId,
      candidateFingerprint: candidate.fingerprint,
      decision,
      decisionLocator: storyBibleDecisionLocator(candidate.candidateId),
      result,
    });
    return result;
  }
  await persistImmutableOrVerify(projectRoot, storyBibleDecisionLocator(candidate.candidateId), jsonBytes(decision));
  return { decision, state: nextState, replayed: false };
}

export async function attachNovelReviewTicket(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
  input: NovelAttachReviewTicketInput,
  chapterContent: string,
): Promise<{ ticket: NovelReviewTicket; replayed: boolean }> {
  requireManagedSnapshot(snapshot);
  const chapter = requireChapter(snapshot, input.chapterId);
  assertChapterCas(chapter, input.expectedChapterRevision, input.expectedChapterSha256);
  if (!Number.isSafeInteger(input.startOffset) || !Number.isSafeInteger(input.endOffset)
    || input.startOffset < 0 || input.endOffset <= input.startOffset || input.endOffset > chapterContent.length
    || chapterContent.slice(input.startOffset, input.endOffset) !== input.evidenceExcerpt) {
    rejectWritingState("审稿票UTF-16位置或证据摘录与当前正文不一致。", {
      reason: "content_conflict",
      chapterId: chapter.chapterId,
      expectedSha256: input.expectedChapterSha256,
      currentSha256: chapter.sha256,
      nextAction: "重新读取正文并定位证据",
    });
  }
  const identity = {
    projectId: snapshot.workspace.projectId,
    chapter: chapterIdentity(chapter),
    startOffset: input.startOffset,
    endOffset: input.endOffset,
    evidenceExcerpt: input.evidenceExcerpt,
    severity: input.severity,
    impact: input.impact,
    minimalFix: input.minimalFix,
    confidence: input.confidence,
    reviewer: input.reviewer,
  };
  const ticketId = `novel-review-${fingerprint(identity).slice(0, 24)}`;
  const ticket = artifactWithFingerprint({
    schemaVersion: 1 as const,
    kind: "novel-review-ticket" as const,
    ticketId,
    ...identity,
    offsetEncoding: "utf16-code-unit" as const,
    createdAt: chapter.updatedAt,
  });
  const locator = `${WRITING_REVIEWS_RELATIVE_PATH}/${ticketId}.json`;
  const created = await persistImmutableOrVerify(projectRoot, locator, jsonBytes(ticket));
  return { ticket, replayed: !created };
}
