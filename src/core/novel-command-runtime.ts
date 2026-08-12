import { z } from "zod";
import path from "node:path";
import type {
  CreateNovelChapterInput,
  CreateNovelVolumeInput,
  MoveNovelChapterInput,
  NovelAttachReviewTicketInput,
  NovelReviewChapterStateCandidateInput,
  NovelReviewStoryBibleCandidateInput,
  NovelSeedWritingStateInput,
  NovelStageChapterStateCandidateInput,
  NovelStageStoryBibleCandidateInput,
  RenameNovelChapterInput,
  ReorderNovelChaptersInput,
  SaveNovelChapterInput,
  NovelImportDuplicateResolution,
  NovelInvalidateWritingStateFromInput,
  NovelImportWritingSourceSnapshotInput,
} from "./novel-types.js";
import { NOVEL_APPEARANCE_CATEGORIES } from "./novel-types.js";

export const NOVEL_COMMAND_NAMES = [
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
  "novel_import_external_snapshot",
] as const;

export type NovelCommandName = typeof NOVEL_COMMAND_NAMES[number];

export type NovelCommandRequest =
  | { command: "novel_initialize_manuscript"; payload: { sourceMode?: "managed_markdown" | "external_snapshot" } }
  | { command: "novel_create_volume"; payload: CreateNovelVolumeInput }
  | { command: "novel_create_chapter"; payload: CreateNovelChapterInput }
  | { command: "novel_save_chapter"; payload: SaveNovelChapterInput }
  | { command: "novel_rename_chapter"; payload: RenameNovelChapterInput }
  | { command: "novel_move_chapter"; payload: MoveNovelChapterInput }
  | { command: "novel_reorder_chapters"; payload: ReorderNovelChaptersInput }
  | { command: "novel_rebuild_search_index"; payload: Record<string, never> }
  | { command: "novel_recover_manuscript"; payload: Record<string, never> }
  | { command: "novel_recover_writing_state"; payload: Record<string, never> }
  | { command: "novel_seed_writing_state"; payload: NovelSeedWritingStateInput }
  | { command: "novel_stage_chapter_state_candidate"; payload: NovelStageChapterStateCandidateInput }
  | { command: "novel_review_chapter_state_candidate"; payload: NovelReviewChapterStateCandidateInput }
  | { command: "novel_stage_story_bible_candidate"; payload: NovelStageStoryBibleCandidateInput }
  | { command: "novel_review_story_bible_candidate"; payload: NovelReviewStoryBibleCandidateInput }
  | { command: "novel_invalidate_writing_state_from"; payload: NovelInvalidateWritingStateFromInput }
  | { command: "novel_attach_review_ticket"; payload: NovelAttachReviewTicketInput }
  | { command: "novel_import_writing_source_snapshot"; payload: NovelImportWritingSourceSnapshotInput }
  | {
    command: "novel_import_external_snapshot";
    payload: {
      projectsRoot: string;
      projectName: string;
      preflightId: string;
      preflightFingerprint: string;
      sourceTreeAggregateSha256: string;
      duplicateResolution: NovelImportDuplicateResolution;
      convertToManagedMarkdown: true;
      /** 仅首次/未完成提交使用；不进请求哈希、durable snapshot 或账本。 */
      preflightAuthorization?: string;
    };
  };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_CHAPTER_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_REORDERED_CHAPTERS = 1_000_000;
const PREFLIGHT_ID_PATTERN = /^novel-preflight-[a-f0-9]{24}$/u;
const PREFLIGHT_AUTHORIZATION_PATTERN = /^novel-preflight-auth-[A-Za-z0-9_-]{43}$/u;
const WRITE_PREFLIGHT_ID_PATTERN = /^novel-write-preflight-[a-f0-9]{24}$/u;
const STATE_CANDIDATE_ID_PATTERN = /^novel-state-candidate-[a-f0-9]{24}$/u;
const STORY_BIBLE_CANDIDATE_ID_PATTERN = /^novel-bible-candidate-[a-f0-9]{24}$/u;
const WRITING_SOURCE_RECEIPT_ID_PATTERN = /^novel-writing-source-receipt-[a-f0-9]{32}$/u;

const uuidSchema = z.string().regex(UUID_PATTERN);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const titleSchema = z.string().max(200)
  .transform((value) => value.normalize("NFC").trim())
  .refine(
    (value) => value.length > 0 && !/\p{Cc}/u.test(value),
    "标题为空或包含控制字符",
  );
const chapterContentSchema = z.string().refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_CHAPTER_CONTENT_BYTES,
  "章节正文超过 64 MiB UTF-8 上限",
);
const revisionSchema = z.number().int().positive();
const orderSchema = z.number().int().min(0);
const identitySchema = z.string().min(1).max(240)
  .refine((value) => value === value.normalize("NFC").trim() && !/[\p{Cc}/\\]/u.test(value), "身份字段无效");
const boundedTextSchema = z.string().max(200_000);
const shortTextSchema = z.string().min(1).max(2_000)
  .refine((value) => value === value.normalize("NFC").trim() && !/\p{Cc}/u.test(value), "文本为空或包含控制字符");
const stringListSchema = z.array(z.string().max(4_000)).max(10_000);
const sourceIdsSchema = z.array(identitySchema).max(10_000);

const initializePayloadSchema = z.object({
  sourceMode: z.enum(["managed_markdown", "external_snapshot"]).optional(),
}).strict();

const createVolumePayloadSchema = z.object({
  title: titleSchema,
  order: orderSchema.optional(),
  expectedManifestRevision: revisionSchema,
}).strict();

const createChapterPayloadSchema = z.object({
  volumeId: uuidSchema,
  title: titleSchema,
  content: chapterContentSchema.optional(),
  order: orderSchema.optional(),
  expectedManifestRevision: revisionSchema,
}).strict();

const saveChapterPayloadSchema = z.object({
  chapterId: uuidSchema,
  content: chapterContentSchema,
  expectedRevision: revisionSchema,
  expectedSha256: sha256Schema,
  aiWriteContext: z.object({
    preflightId: z.string().regex(WRITE_PREFLIGHT_ID_PATTERN),
    contextPackFingerprint: sha256Schema,
    workflowMode: z.enum(["formal", "rehearsal"]).optional(),
    leaseId: z.string().regex(/^novel-write-lease-[a-f0-9]{24}$/u).optional(),
    leaseFence: z.number().int().positive().optional(),
    actorFingerprint: sha256Schema.optional(),
  }).strict().optional(),
}).strict();

const sourceDocumentSchema = z.object({
  sourceId: identitySchema,
  displayPath: z.string().min(1).max(2_000).refine((value) => !value.includes("\0")
    && !value.includes("\\") && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && path.posix.normalize(value) === value
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  "displayPath 必须是规范 POSIX 相对路径"),
  content: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 16 * 1024 * 1024, "来源文档超过16MiB"),
}).strict();

const dynamicFieldsSchema = z.object({
  body: boundedTextSchema,
  emotion: boundedTextSchema,
  known: stringListSchema,
  unknown: stringListSchema,
  relationships: stringListSchema,
  goals: stringListSchema,
  psychology: boundedTextSchema,
  unresolved: stringListSchema,
}).strict();

const entitySchema = z.object({
  entityId: identitySchema,
  name: shortTextSchema,
  aliases: z.array(z.string().max(500)).max(10_000),
  level: z.enum(["L1", "L2", "L3", "L4"]),
  baseSummary: boundedTextSchema,
  effectiveFromChapterId: uuidSchema.optional(),
  sourceIds: sourceIdsSchema,
}).strict();

const hardCanonSchema = z.object({
  ruleId: identitySchema,
  text: boundedTextSchema,
  priority: z.number().int().min(0).max(1_000_000),
  canonStatus: z.enum(["canon", "conflicted"]),
  visibility: z.enum(["writer", "author_only"]),
  effectiveFromChapterId: uuidSchema.optional(),
  sourceIds: sourceIdsSchema,
}).strict();

const characterStateSeedSchema = z.object({
  stateId: identitySchema,
  entityId: identitySchema,
  throughChapterId: uuidSchema,
  fields: dynamicFieldsSchema,
  sourceIds: sourceIdsSchema,
}).strict();

const knowledgeSeedSchema = z.object({
  knowledgeId: identitySchema,
  entityId: identitySchema,
  fact: boundedTextSchema,
  status: z.enum(["known", "unknown", "partial", "misbelieved", "planned_later", "forgotten", "unresolved"]),
  rawValue: boundedTextSchema,
  effectiveFromChapterId: uuidSchema.optional(),
  effectiveUntilChapterId: uuidSchema.optional(),
  sourceIds: sourceIdsSchema,
}).strict();

const relationshipSeedSchema = z.object({
  relationshipId: identitySchema,
  fromEntityId: identitySchema,
  toEntityId: identitySchema,
  relation: boundedTextSchema,
  state: boundedTextSchema,
  throughChapterId: uuidSchema,
  sourceIds: sourceIdsSchema,
}).strict();

const timelineSeedSchema = z.object({
  timelineId: identitySchema,
  storyTime: boundedTextSchema,
  summary: boundedTextSchema,
  startChapterId: uuidSchema.optional(),
  endChapterId: uuidSchema.optional(),
  disclosureChapterId: uuidSchema.optional(),
  sourceIds: sourceIdsSchema,
}).strict();

const foreshadowingSeedSchema = z.object({
  foreshadowingId: identitySchema,
  summary: boundedTextSchema,
  status: z.enum(["planned", "setup", "progression", "payoff", "abandoned", "unresolved"]),
  setupChapterId: uuidSchema.optional(),
  maintenanceChapterIds: z.array(uuidSchema).max(1_000_000),
  payoffChapterId: uuidSchema.optional(),
  sourceIds: sourceIdsSchema,
}).strict();

const chapterBriefSchema = z.object({
  chapterId: uuidSchema,
  summary: boundedTextSchema,
  mustDo: stringListSchema,
  mustNotDo: stringListSchema,
  requiredCharacterIds: z.array(identitySchema).max(100_000).optional(),
  sourceIds: sourceIdsSchema,
}).strict();

const characterProseProfileSeedSchema = z.object({
  entityId: identitySchema,
  effectiveFromChapterId: uuidSchema.optional(),
  valuePriorities: stringListSchema,
  coreDesire: boundedTextSchema,
  coreFear: boundedTextSchema,
  secret: boundedTextSchema,
  boundaries: stringListSchema,
  forbiddenPhrases: stringListSchema,
  vocabulary: stringListSchema,
  sentencePatterns: stringListSchema,
  relationshipVoices: z.array(z.object({
    targetEntityId: identitySchema,
    guidance: boundedTextSchema,
  }).strict()).max(100_000),
  sampleLines: stringListSchema,
  sourceIds: sourceIdsSchema,
}).strict();

const characterAppearanceSeedSchema = z.object({
  entityId: identitySchema,
  effectiveFromChapterId: uuidSchema.optional(),
  summary: boundedTextSchema,
  locks: z.array(z.object({
    lockId: identitySchema,
    category: z.enum(NOVEL_APPEARANCE_CATEGORIES),
    canonicalDescription: boundedTextSchema,
    allowedVariants: stringListSchema,
    contradictionPhrases: stringListSchema,
    mutability: z.enum(["immutable", "story_event_required"]),
    enforcement: z.enum(["block", "review"]),
  }).strict()).min(1).max(64),
  sourceIds: sourceIdsSchema,
}).strict();

const seedWritingStatePayloadSchema = z.object({
  baselineStatus: z.enum(["provisional", "locked"]),
  sourceTreeAggregateSha256: sha256Schema,
  currentThroughChapterId: uuidSchema,
  sourceDocuments: z.array(sourceDocumentSchema).max(100_000),
  entities: z.array(entitySchema).max(100_000),
  hardCanon: z.array(hardCanonSchema).max(100_000),
  characterStates: z.array(characterStateSeedSchema).max(1_000_000),
  knowledge: z.array(knowledgeSeedSchema).max(1_000_000),
  relationships: z.array(relationshipSeedSchema).max(1_000_000),
  timeline: z.array(timelineSeedSchema).max(1_000_000),
  foreshadowing: z.array(foreshadowingSeedSchema).max(1_000_000),
  chapterBriefs: z.array(chapterBriefSchema).max(1_000_000),
  characterProfiles: z.array(characterProseProfileSeedSchema).max(100_000).optional(),
  characterAppearances: z.array(characterAppearanceSeedSchema).max(100_000).optional(),
  completedChapterIds: z.array(uuidSchema).max(1_000_000),
}).strict();

const knowledgeDeltaSchema = knowledgeSeedSchema.omit({ sourceIds: true });
const relationshipDeltaSchema = relationshipSeedSchema.omit({ sourceIds: true, throughChapterId: true });
const timelineDeltaSchema = timelineSeedSchema.omit({ sourceIds: true });
const foreshadowingDeltaSchema = foreshadowingSeedSchema.omit({ sourceIds: true });
const stateDeltaSchema = z.object({
  characterStates: z.array(z.object({
    stateId: identitySchema,
    entityId: identitySchema,
    fields: dynamicFieldsSchema,
  }).strict()).max(100_000),
  knowledge: z.array(knowledgeDeltaSchema).max(100_000),
  relationships: z.array(relationshipDeltaSchema).max(100_000),
  timeline: z.array(timelineDeltaSchema).max(100_000),
  foreshadowing: z.array(foreshadowingDeltaSchema).max(100_000),
}).strict();

const chapterEvidenceSpanSchema = z.object({
  evidenceId: identitySchema,
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().positive(),
  evidenceExcerpt: boundedTextSchema,
}).strict().refine((value) => value.endOffset > value.startOffset, {
  path: ["endOffset"],
  message: "endOffset 必须大于 startOffset",
});

const stateChangeEvidenceSchema = z.object({
  kind: z.enum(["character_state", "knowledge", "relationship", "timeline", "foreshadowing"]),
  recordId: identitySchema,
  reason: shortTextSchema,
  evidenceSpanIds: z.array(identitySchema).min(1).max(1_000),
}).strict();

const noStateChangeSchema = z.object({
  reason: shortTextSchema,
  evidenceSpanIds: z.array(identitySchema).min(1).max(1_000),
  checkedCharacterIds: z.array(identitySchema).max(100_000),
}).strict();

const candidateAuditScopeSchema = z.object({
  checkedCharacterIds: z.array(identitySchema).max(100_000),
  checkedStateKinds: z.array(z.enum(["character_state", "knowledge", "relationship", "timeline", "foreshadowing"]))
    .min(5).max(5),
}).strict();

const stageChapterStateCandidatePayloadSchema = z.object({
  chapterId: uuidSchema,
  expectedChapterRevision: revisionSchema,
  expectedChapterSha256: sha256Schema,
  expectedWritingStateRevision: revisionSchema,
  expectedWritingStateFingerprint: sha256Schema,
  summary: shortTextSchema,
  delta: stateDeltaSchema,
  evidenceSpans: z.array(chapterEvidenceSpanSchema).max(100_000),
  changeEvidence: z.array(stateChangeEvidenceSchema).max(500_000),
  noStateChange: noStateChangeSchema.optional(),
  auditScope: candidateAuditScopeSchema,
}).strict();

const reviewChapterStateCandidatePayloadSchema = z.object({
  candidateId: z.string().regex(STATE_CANDIDATE_ID_PATTERN),
  expectedCandidateFingerprint: sha256Schema,
  expectedWritingStateRevision: revisionSchema,
  expectedWritingStateFingerprint: sha256Schema,
  decision: z.enum(["accepted", "rejected"]),
  reviewer: identitySchema,
  note: z.string().max(20_000).optional(),
}).strict();

const characterProseProfileSchema = characterProseProfileSeedSchema;

const continuityIssueSchema = z.object({
  issueId: identitySchema,
  status: z.enum(["open", "resolved", "waived"]),
  severity: z.enum(["P0", "P1", "P2"]),
  summary: boundedTextSchema,
  chapterIds: z.array(uuidSchema).max(100_000),
  entityIds: z.array(identitySchema).max(100_000),
  evidence: boundedTextSchema,
  resolution: boundedTextSchema.optional(),
  sourceIds: sourceIdsSchema,
}).strict();

const storyBibleChangeBaseSchema = z.object({
  changeId: identitySchema,
  reason: shortTextSchema,
  supersedesRevision: revisionSchema.optional(),
});

const storyBibleChangeSchema = z.discriminatedUnion("kind", [
  storyBibleChangeBaseSchema.omit({ supersedesRevision: true }).extend({
    kind: z.literal("source_binding"),
    value: z.object({
      receiptId: z.string().regex(WRITING_SOURCE_RECEIPT_ID_PATTERN),
      receiptFingerprint: sha256Schema,
      sourceRelativePath: z.string().min(1).max(4_000)
        .refine((value) => !value.includes("\\") && !value.includes("\0")
          && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value
          && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
        "sourceRelativePath 必须是规范 POSIX 相对路径"),
      sourceId: identitySchema,
    }).strict(),
  }).strict(),
  storyBibleChangeBaseSchema.extend({ kind: z.literal("entity"), value: entitySchema }).strict(),
  storyBibleChangeBaseSchema.extend({ kind: z.literal("hard_canon"), value: hardCanonSchema }).strict(),
  storyBibleChangeBaseSchema.extend({ kind: z.literal("chapter_brief"), value: chapterBriefSchema }).strict(),
  storyBibleChangeBaseSchema.extend({ kind: z.literal("character_profile"), value: characterProseProfileSchema }).strict(),
  storyBibleChangeBaseSchema.extend({ kind: z.literal("character_appearance"), value: characterAppearanceSeedSchema }).strict(),
  storyBibleChangeBaseSchema.extend({ kind: z.literal("continuity_issue"), value: continuityIssueSchema }).strict(),
]);

const stageStoryBibleCandidatePayloadSchema = z.object({
  expectedWritingStateRevision: revisionSchema,
  expectedWritingStateFingerprint: sha256Schema,
  summary: shortTextSchema,
  changes: z.array(storyBibleChangeSchema).min(1).max(100_000),
}).strict();

const reviewStoryBibleCandidatePayloadSchema = z.object({
  candidateId: z.string().regex(STORY_BIBLE_CANDIDATE_ID_PATTERN),
  expectedCandidateFingerprint: sha256Schema,
  expectedWritingStateRevision: revisionSchema,
  expectedWritingStateFingerprint: sha256Schema,
  decision: z.enum(["accepted", "rejected"]),
  reviewer: identitySchema,
  note: z.string().max(20_000).optional(),
}).strict();

const invalidateWritingStateFromPayloadSchema = z.object({
  targetChapterId: uuidSchema,
  expectedWritingStateRevision: revisionSchema,
  expectedWritingStateFingerprint: sha256Schema,
  expectedPlanFingerprint: sha256Schema,
}).strict();

const attachReviewTicketPayloadSchema = z.object({
  chapterId: uuidSchema,
  expectedChapterRevision: revisionSchema,
  expectedChapterSha256: sha256Schema,
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().positive(),
  evidenceExcerpt: boundedTextSchema,
  severity: z.enum(["P0", "P1", "P2"]),
  impact: shortTextSchema,
  minimalFix: shortTextSchema,
  confidence: z.number().min(0).max(1),
  reviewer: identitySchema,
}).strict().refine((value) => value.endOffset > value.startOffset, {
  path: ["endOffset"],
  message: "endOffset 必须大于 startOffset",
});

const renameChapterPayloadSchema = z.object({
  chapterId: uuidSchema,
  title: titleSchema,
  expectedRevision: revisionSchema,
  expectedManifestRevision: revisionSchema,
}).strict();

const moveChapterPayloadSchema = z.object({
  chapterId: uuidSchema,
  volumeId: uuidSchema,
  order: orderSchema.optional(),
  expectedRevision: revisionSchema,
  expectedSha256: sha256Schema,
  expectedManifestRevision: revisionSchema,
}).strict();

const reorderChaptersPayloadSchema = z.object({
  orderedChapterIds: z.array(uuidSchema).max(MAX_REORDERED_CHAPTERS),
  expectedManifestRevision: revisionSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.orderedChapterIds).size !== value.orderedChapterIds.length) {
    context.addIssue({ code: "custom", path: ["orderedChapterIds"], message: "chapterId 不得重复" });
  }
});

const emptyPayloadSchema = z.object({}).strict();

const importExternalSnapshotPayloadSchema = z.object({
  projectsRoot: z.string().refine(
    (value) => value.length > 0 && !value.includes("\0") && path.isAbsolute(value),
    "projectsRoot 必须是非空绝对路径",
  ).transform((value) => path.normalize(value)),
  projectName: z.string().max(120).transform((value) => value.normalize("NFC").trim())
    .refine((value) => value.length > 0 && !/\p{Cc}/u.test(value), "导入项目名称为空或包含控制字符"),
  preflightId: z.string().regex(PREFLIGHT_ID_PATTERN),
  preflightFingerprint: sha256Schema,
  sourceTreeAggregateSha256: sha256Schema,
  duplicateResolution: z.enum(["include_all", "skip_later_exact_duplicates"]),
  convertToManagedMarkdown: z.literal(true),
  preflightAuthorization: z.string().regex(PREFLIGHT_AUTHORIZATION_PATTERN).optional(),
}).strict();

const importWritingSourceSnapshotPayloadSchema = z.object({
  preflightId: z.string().regex(PREFLIGHT_ID_PATTERN),
  preflightFingerprint: sha256Schema,
  sourceTreeAggregateSha256: sha256Schema,
  preflightAuthorization: z.string().regex(PREFLIGHT_AUTHORIZATION_PATTERN).optional(),
}).strict();

export const NOVEL_MANUSCRIPT_COMMAND_SCHEMA_OPTIONS = [
  z.object({ command: z.literal("novel_initialize_manuscript"), payload: initializePayloadSchema }).strict(),
  z.object({ command: z.literal("novel_create_volume"), payload: createVolumePayloadSchema }).strict(),
  z.object({ command: z.literal("novel_create_chapter"), payload: createChapterPayloadSchema }).strict(),
  z.object({ command: z.literal("novel_save_chapter"), payload: saveChapterPayloadSchema }).strict(),
  z.object({ command: z.literal("novel_rename_chapter"), payload: renameChapterPayloadSchema }).strict(),
  z.object({ command: z.literal("novel_move_chapter"), payload: moveChapterPayloadSchema }).strict(),
  z.object({ command: z.literal("novel_reorder_chapters"), payload: reorderChaptersPayloadSchema }).strict(),
  z.object({ command: z.literal("novel_rebuild_search_index"), payload: emptyPayloadSchema }).strict(),
  z.object({ command: z.literal("novel_recover_manuscript"), payload: emptyPayloadSchema }).strict(),
  z.object({ command: z.literal("novel_recover_writing_state"), payload: emptyPayloadSchema }).strict(),
  z.object({ command: z.literal("novel_seed_writing_state"), payload: seedWritingStatePayloadSchema }).strict(),
  z.object({ command: z.literal("novel_stage_chapter_state_candidate"), payload: stageChapterStateCandidatePayloadSchema }).strict(),
  z.object({ command: z.literal("novel_review_chapter_state_candidate"), payload: reviewChapterStateCandidatePayloadSchema }).strict(),
  z.object({ command: z.literal("novel_stage_story_bible_candidate"), payload: stageStoryBibleCandidatePayloadSchema }).strict(),
  z.object({ command: z.literal("novel_review_story_bible_candidate"), payload: reviewStoryBibleCandidatePayloadSchema }).strict(),
  z.object({ command: z.literal("novel_invalidate_writing_state_from"), payload: invalidateWritingStateFromPayloadSchema }).strict(),
  z.object({ command: z.literal("novel_attach_review_ticket"), payload: attachReviewTicketPayloadSchema }).strict(),
  z.object({ command: z.literal("novel_import_writing_source_snapshot"), payload: importWritingSourceSnapshotPayloadSchema }).strict(),
] as const;

export const novelCommandRequestSchema = z.discriminatedUnion("command", [
  ...NOVEL_MANUSCRIPT_COMMAND_SCHEMA_OPTIONS,
  z.object({ command: z.literal("novel_import_external_snapshot"), payload: importExternalSnapshotPayloadSchema }).strict(),
]);

export function isNovelCommandName(value: unknown): value is NovelCommandName {
  return typeof value === "string" && (NOVEL_COMMAND_NAMES as readonly string[]).includes(value);
}

/**
 * 只对 novel allowlist 返回 canonical request；非 novel 命令返回 null。
 * allowlist 内任何结构错误直接抛出，供 command bus 在工程探测、锁和账本 I/O 前失败关闭。
 */
export function parseNovelCommandRequestForCore(value: unknown): NovelCommandRequest | null {
  if (!value || typeof value !== "object" || !isNovelCommandName((value as { command?: unknown }).command)) {
    return null;
  }
  const parsed = novelCommandRequestSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
      .join("; ");
    throw new Error(`novel 命令载荷不符合严格合同：${detail}`);
  }
  return parsed.data as NovelCommandRequest;
}

export function isNovelImportCommandRequest(
  request: NovelCommandRequest,
): request is Extract<NovelCommandRequest, { command: "novel_import_external_snapshot" }> {
  return request.command === "novel_import_external_snapshot";
}

export function isNovelWritingSourceImportCommandRequest(
  request: NovelCommandRequest,
): request is Extract<NovelCommandRequest, { command: "novel_import_writing_source_snapshot" }> {
  return request.command === "novel_import_writing_source_snapshot";
}

/**
 * capability 只授权当前调用栈，不属于命令的稳定业务身份。该投影是
 * requestHash、durable reconciliation snapshot 和任何持久记录的唯一输入。
 */
export function canonicalNovelCommandRequestForPersistence(
  request: NovelCommandRequest,
): NovelCommandRequest {
  if (isNovelImportCommandRequest(request)) {
    const { preflightAuthorization: _preflightAuthorization, ...payload } = request.payload;
    return { command: request.command, payload };
  }
  if (isNovelWritingSourceImportCommandRequest(request)) {
    const { preflightAuthorization: _preflightAuthorization, ...payload } = request.payload;
    return { command: request.command, payload };
  }
  return request;
}
