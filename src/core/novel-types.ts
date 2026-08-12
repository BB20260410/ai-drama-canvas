export const WORKSPACE_MODES = ["drama", "novel", "hybrid"] as const;

export type WorkspaceMode = typeof WORKSPACE_MODES[number];

export const MANAGED_PROJECT_WRITER_SCHEMA_VERSION = 2 as const;
export const NOVEL_MANIFEST_RELATIVE_PATH = ".aicanvas/novel/manifest.json" as const;
export const NOVEL_CHAPTER_MANIFEST_RELATIVE_PATH = "manuscript/chapters.json" as const;
export const NOVEL_OFFSET_ENCODING = "utf16-code-unit" as const;

export const NOVEL_SOURCE_MODES = ["managed_markdown", "external_snapshot"] as const;
export type NovelSourceMode = typeof NOVEL_SOURCE_MODES[number];

export const NOVEL_IMPORT_SOURCE_KINDS = ["text", "markdown", "docx"] as const;
export type NovelImportSourceKind = typeof NOVEL_IMPORT_SOURCE_KINDS[number];

export const NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM = "aicanvas-heading-paragraph-utf16-v1" as const;
export const NOVEL_IMPORT_DUPLICATE_RESOLUTIONS = [
  "include_all",
  "skip_later_exact_duplicates",
] as const;
export type NovelImportDuplicateResolution = typeof NOVEL_IMPORT_DUPLICATE_RESOLUTIONS[number];

export type NovelTextEncoding = "utf-8" | "gb18030" | "docx";

export interface NovelVolumeRecord {
  volumeId: string;
  title: string;
  order: number;
  revision: number;
}

export interface NovelChapterRecord {
  chapterId: string;
  volumeId: string;
  title: string;
  order: number;
  relativePath: string;
  sha256: string;
  byteLength: number;
  charCount: number;
  offsetEncoding: typeof NOVEL_OFFSET_ENCODING;
  revision: number;
  sourceReceiptId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NovelChapterManifest {
  schemaVersion: 1;
  kind: "novel-chapter-manifest";
  projectId: string;
  revision: number;
  volumes: NovelVolumeRecord[];
  chapters: NovelChapterRecord[];
  updatedAt: string;
}

export interface NovelWorkspaceManifest {
  schemaVersion: 1;
  kind: "novel-workspace-manifest";
  projectId: string;
  sourceMode: NovelSourceMode;
  chapterManifest?: typeof NOVEL_CHAPTER_MANIFEST_RELATIVE_PATH;
  sourceReceiptIds: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
}

/**
 * 小说工作区的只读组合快照。
 *
 * 该数据合同属于小说域类型层，而不是 ManuscriptRepository 的实现细节。
 * 将其放在纯类型模块可避免写作状态、源导入与仓库实现形成类型依赖环。
 */
export interface NovelWorkspaceSnapshot {
  workspace: NovelWorkspaceManifest;
  chapters: NovelChapterManifest | null;
}

export interface NovelPreflightFile {
  relativePath: string;
  kind: NovelImportSourceKind;
  byteLength: number;
  sha256: string;
  encoding: NovelTextEncoding;
  charCount: number;
  chapterCount: number;
  decodedTextSha256: string;
  docx?: {
    outputSha256: string;
    memberCount: number;
    expandedBytes: number;
    converter: { name: "mammoth"; version: string; contractVersion: 1 };
  };
  duplicateOf?: string;
  warnings: string[];
}

export interface NovelPreflightUnsupportedEntry {
  relativePath: string;
  entryType: "file" | "directory" | "symlink" | "special";
  reason: string;
  fatal: boolean;
}

export interface NovelImportPreflight {
  schemaVersion: 1;
  kind: "novel-import-preflight";
  preflightId: string;
  chapterSplitAlgorithm: typeof NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM;
  selectionKind: "file" | "directory";
  sourcePath: string;
  sourceRoot: string;
  sourceTreeAggregateSha256: string;
  eligible: boolean;
  limits: {
    maximumEntries: number;
    maximumSupportedFiles: number;
    maximumSingleFileBytes: number;
    maximumTotalBytes: number;
    maximumDocxMembers: number;
    maximumDocxMemberExpandedBytes: number;
    maximumDocxExpandedBytes: number;
    maximumDocxCompressionRatio: number;
    maximumDocxOutputChars: number;
    docxTimeoutMs: number;
  };
  summary: {
    entries: number;
    supportedFiles: number;
    unsupportedEntries: number;
    duplicateFiles: number;
    byteLength: number;
    charCount: number;
    chapterCount: number;
  };
  files: NovelPreflightFile[];
  unsupported: NovelPreflightUnsupportedEntry[];
  warnings: string[];
  fingerprint: string;
}

export interface NovelImportReceiptChapter {
  sourceRelativePath: string;
  sourceSha256: string;
  sourceChapterIndex: number;
  chapterId: string;
  volumeId: string;
  relativePath: string;
  sha256: string;
  byteLength: number;
  charCount: number;
}

export interface NovelImportReceipt {
  schemaVersion: 1;
  kind: "novel-import-receipt";
  receiptId: string;
  projectId: string;
  preflightId: string;
  preflightFingerprint: string;
  /** 冻结预检中的总章节数，用于重算不可变 state chain facts。 */
  preflightChapterCount: number;
  chapterSplitAlgorithm: typeof NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM;
  duplicateResolution: NovelImportDuplicateResolution;
  skippedDuplicateSourcePaths: string[];
  sourceMode: "external_snapshot";
  resultMode: NovelSourceMode;
  sourceDisplayName: string;
  sourceTreeAggregateSha256: string;
  converter: {
    name: "aicanvas-novel-import";
    version: 1;
    chapterSplitAlgorithm: typeof NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM;
    docx?: { library: "mammoth"; isolated: true };
  };
  sourceObjects: Array<{
    sourceRelativePath: string;
    objectRelativePath: string;
    sha256: string;
    byteLength: number;
  }>;
  chapters: NovelImportReceiptChapter[];
  committedAt: string;
  fingerprint: string;
}

export interface NovelWritingSourceSnapshotReceiptObject {
  sourceRelativePath: string;
  kind: NovelImportSourceKind;
  rawObjectRelativePath: string;
  rawSha256: string;
  rawByteLength: number;
  textObjectRelativePath: string;
  textSha256: string;
  textByteLength: number;
  transform: {
    algorithm: "aicanvas-writing-source-text-v1";
    sourceEncoding: NovelTextEncoding;
    docxConverter?: {
      name: "mammoth";
      version: string;
      contractVersion: 1;
      isolated: true;
    };
  };
  suggestedSourceId: string;
}

export interface NovelWritingSourceSnapshotReceipt {
  schemaVersion: 1;
  kind: "novel-writing-source-snapshot-receipt";
  receiptId: string;
  projectId: string;
  preflightId: string;
  preflightFingerprint: string;
  sourceDisplayName: string;
  sourceTreeAggregateSha256: string;
  objects: NovelWritingSourceSnapshotReceiptObject[];
  committedAt: string;
  fingerprint: string;
}

export interface NovelImportWritingSourceSnapshotInput {
  preflightId: string;
  preflightFingerprint: string;
  sourceTreeAggregateSha256: string;
  preflightAuthorization?: string;
}

export interface NovelChapterRead {
  chapter: NovelChapterRecord;
  content: string;
  status: "healthy";
}

export interface NovelChapterExternalChange {
  chapter: NovelChapterRecord;
  status: "external_change";
  actual: { sha256: string; byteLength: number; charCount?: number };
}

export type NovelChapterReadResult = NovelChapterRead | NovelChapterExternalChange;

export interface SearchNovelChaptersInput {
  query: string;
  limit?: number;
  maxHitsPerChapter?: number;
  /** 由受信任的 Agent service 计算；不直接暴露给公共 MCP/CLI。 */
  allowedChapterIds?: string[];
}

export interface NovelChapterSearchHit {
  chapter: NovelChapterRecord;
  startOffset: number;
  endOffset: number;
  snippet: string;
}

export type NovelSearchEngine = "fts5_trigram" | "linear_scan";

export type NovelSearchIndexState =
  | "missing"
  | "building"
  | "fresh"
  | "stale"
  | "corrupt";

export type NovelSearchFallbackReason =
  | "index_missing"
  | "index_building"
  | "index_stale"
  | "index_corrupt"
  | "query_too_short"
  | "chapter_identity_changed";

export interface NovelSearchIndexGeneration {
  generationId: string;
  projectId: string;
  manifestRevision: number;
  manifestDigest: string;
  tokenizer: "fts5-trigram-case-sensitive-v1";
  status: "building" | "active" | "inactive" | "failed" | "stale";
  chapterCount: number;
  indexedChapterCount: number;
  coverageFingerprint?: string;
  createdAt: string;
  activatedAt?: string;
}

export interface NovelSearchIndexStatus {
  schemaVersion: 1;
  databaseLocator: ".aicanvas/novel/novel-derived.sqlite";
  state: NovelSearchIndexState;
  expectedManifestRevision: number;
  expectedManifestDigest: string;
  activeGeneration?: NovelSearchIndexGeneration;
  pendingGenerationCount: number;
  reason?: string;
}

export interface NovelChapterSearchResult {
  query: string;
  manifestRevision: number;
  engine: NovelSearchEngine;
  indexedChapters: number;
  indexState: NovelSearchIndexState;
  indexGenerationId?: string;
  fallbackReason?: NovelSearchFallbackReason;
  scannedChapters: number;
  skippedExternalChanges: number;
  hits: NovelChapterSearchHit[];
}

export interface SaveNovelChapterInput {
  chapterId: string;
  content: string;
  expectedRevision: number;
  expectedSha256: string;
  aiWriteContext?: NovelAiWriteContext;
}

export const NOVEL_WRITING_BASELINE_STATUSES = ["provisional", "locked"] as const;
export type NovelWritingBaselineStatus = typeof NOVEL_WRITING_BASELINE_STATUSES[number];

export const NOVEL_WRITING_WORKFLOW_MODES = ["formal", "rehearsal"] as const;
export type NovelWritingWorkflowMode = typeof NOVEL_WRITING_WORKFLOW_MODES[number];

export const NOVEL_CHARACTER_LEVELS = ["L1", "L2", "L3", "L4"] as const;
export type NovelCharacterLevel = typeof NOVEL_CHARACTER_LEVELS[number];

export const NOVEL_KNOWLEDGE_STATUSES = [
  "known",
  "unknown",
  "partial",
  "misbelieved",
  "planned_later",
  "forgotten",
  "unresolved",
] as const;
export type NovelKnowledgeStatus = typeof NOVEL_KNOWLEDGE_STATUSES[number];

export const NOVEL_FORESHADOWING_STATUSES = [
  "planned",
  "setup",
  "progression",
  "payoff",
  "abandoned",
  "unresolved",
] as const;
export type NovelForeshadowingStatus = typeof NOVEL_FORESHADOWING_STATUSES[number];

export const NOVEL_REVIEW_SEVERITIES = ["P0", "P1", "P2"] as const;
export type NovelReviewSeverity = typeof NOVEL_REVIEW_SEVERITIES[number];

export interface NovelAiWriteContext {
  preflightId: string;
  contextPackFingerprint: string;
  workflowMode?: NovelWritingWorkflowMode;
  leaseId?: string;
  leaseFence?: number;
  actorFingerprint?: string;
}

export interface NovelActorAttribution {
  actorId: string;
  provider: string;
  model: string;
  sessionId: string;
  transport: "mcp" | "json_cli" | "main" | "internal";
}

export type NovelContextPackTraceSection =
  | "hardCanon"
  | "taskBrief"
  | "entities"
  | "characterProfiles"
  | "characterAppearances"
  | "characterStates"
  | "knowledge"
  | "relationships"
  | "timeline"
  | "foreshadowing"
  | "excerpts";

export interface NovelContextPackSelectionTraceEntry {
  section: NovelContextPackTraceSection;
  itemId: string;
  disposition: "included" | "omitted";
  source: "writing_state" | "managed_chapter";
  sourceIds: string[];
  protection: "protected" | "compressible";
  priority?: number;
  characterCost: number;
  rule: string;
  reason: string;
}

export interface NovelContextPackSelectionTrace {
  schemaVersion: 1;
  kind: "novel-context-pack-selection-trace";
  targetChapterId: string;
  cutoffChapterId: string | null;
  taskType: "continue_chapter" | "revise_chapter" | "review_chapter";
  workflowMode: NovelWritingWorkflowMode;
  requiredCharacterIds: string[];
  budget: {
    maximumCharacters: number;
    usedCharacters: number;
    reservedCharacters: number;
    partitions: Array<{
      partitionId: "hard_requirements" | "required_cast" | "critical_memory" | "recent_chapters";
      protection: "protected" | "compressible";
      policy: "always_include" | "fail_on_omission" | "fit_remaining_budget";
      usedCharacters: number;
      includedItems: number;
      omittedItems: number;
    }>;
  };
  entries: NovelContextPackSelectionTraceEntry[];
  policies: {
    chapterBrief: "exact_target_chapter";
    hardCanon: "writer_visible_only";
    futureChapters: "excluded_after_cutoff";
    authorOnlyCanon: "excluded_without_receipt_entry";
    absolutePaths: "never_persisted";
    uiRecomputation: "forbidden";
  };
}

export interface NovelContextPackReceipt {
  schemaVersion: 1;
  kind: "novel-context-pack-receipt";
  targetChapter: {
    chapterId: string;
    revision: number;
    sha256: string;
  };
  cutoffChapterId: string | null;
  manifestRevision: number;
  writingStateRevision: number;
  writingStateFingerprint: string;
  contextPackFingerprint: string;
  preflightId: string;
  ready: boolean;
  nextTools: Array<{ tool: string; purpose: string }>;
  selectionTrace: NovelContextPackSelectionTrace;
  fingerprint: string;
}

export interface NovelAcquireChapterWriteLeaseInput {
  targetChapterId: string;
  contextPackFingerprint: string;
  preflightId: string;
  characterIds: string[];
  workflowMode: NovelWritingWorkflowMode;
  attribution: NovelActorAttribution;
  ttlSeconds: number;
  contextPackReceipt?: NovelContextPackReceipt;
}

export interface NovelChapterWriteLeaseRuntime {
  leaseToken: string;
  attribution: NovelActorAttribution;
}

export interface NovelWritingSourceDocumentInput {
  sourceId: string;
  displayPath: string;
  content: string;
}

export interface NovelWritingSourceDocument {
  sourceId: string;
  displayPath: string;
  objectRelativePath: string;
  sha256: string;
  byteLength: number;
  receiptId?: string;
  receiptFingerprint?: string;
  sourceRelativePath?: string;
  rawObjectRelativePath?: string;
  rawSha256?: string;
  rawByteLength?: number;
}

export interface NovelWritingEntity {
  entityId: string;
  name: string;
  aliases: string[];
  level: NovelCharacterLevel;
  baseSummary: string;
  effectiveFromChapterId?: string;
  sourceIds: string[];
  revision: number;
}

export interface NovelHardCanonRule {
  ruleId: string;
  text: string;
  priority: number;
  canonStatus: "canon" | "conflicted";
  visibility: "writer" | "author_only";
  effectiveFromChapterId?: string;
  sourceIds: string[];
  revision: number;
}

export interface NovelCharacterDynamicFields {
  body: string;
  emotion: string;
  known: string[];
  unknown: string[];
  relationships: string[];
  goals: string[];
  psychology: string;
  unresolved: string[];
}

export interface NovelChapterSourceIdentity {
  chapterId: string;
  chapterRevision: number;
  chapterSha256: string;
}

export interface NovelCharacterStateRecord {
  stateId: string;
  entityId: string;
  throughChapterId: string;
  fields: NovelCharacterDynamicFields;
  sourceIds: string[];
  sourceChapter?: NovelChapterSourceIdentity;
  revision: number;
}

export interface NovelKnowledgeRecord {
  knowledgeId: string;
  entityId: string;
  fact: string;
  status: NovelKnowledgeStatus;
  rawValue: string;
  effectiveFromChapterId?: string;
  effectiveUntilChapterId?: string;
  sourceIds: string[];
  sourceChapter?: NovelChapterSourceIdentity;
  revision: number;
}

export interface NovelRelationshipRecord {
  relationshipId: string;
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  state: string;
  throughChapterId: string;
  sourceIds: string[];
  sourceChapter?: NovelChapterSourceIdentity;
  revision: number;
}

export interface NovelTimelineRecord {
  timelineId: string;
  storyTime: string;
  summary: string;
  startChapterId?: string;
  endChapterId?: string;
  disclosureChapterId?: string;
  sourceIds: string[];
  sourceChapter?: NovelChapterSourceIdentity;
  revision: number;
}

export interface NovelForeshadowingRecord {
  foreshadowingId: string;
  summary: string;
  status: NovelForeshadowingStatus;
  setupChapterId?: string;
  maintenanceChapterIds: string[];
  payoffChapterId?: string;
  sourceIds: string[];
  sourceChapter?: NovelChapterSourceIdentity;
  revision: number;
}

export interface NovelChapterBriefRecord {
  chapterId: string;
  summary: string;
  mustDo: string[];
  mustNotDo: string[];
  /** 缺失表示旧版未声明；空数组表示 owner 已明确确认本章无角色。 */
  requiredCharacterIds?: string[];
  sourceIds: string[];
  revision: number;
}

export interface NovelCharacterProseProfileRecord {
  entityId: string;
  effectiveFromChapterId?: string;
  valuePriorities: string[];
  coreDesire: string;
  coreFear: string;
  secret: string;
  boundaries: string[];
  forbiddenPhrases: string[];
  vocabulary: string[];
  sentencePatterns: string[];
  relationshipVoices: Array<{ targetEntityId: string; guidance: string }>;
  sampleLines: string[];
  sourceIds: string[];
  revision: number;
}

export const NOVEL_APPEARANCE_CATEGORIES = [
  "species_or_type",
  "age_presentation",
  "gender_presentation",
  "height_build",
  "skin",
  "hair",
  "eyes",
  "face",
  "distinctive_mark",
  "default_clothing",
  "accessory",
  "other",
] as const;

export type NovelAppearanceCategory = typeof NOVEL_APPEARANCE_CATEGORIES[number];

export interface NovelCharacterAppearanceLock {
  lockId: string;
  category: NovelAppearanceCategory;
  canonicalDescription: string;
  allowedVariants: string[];
  contradictionPhrases: string[];
  mutability: "immutable" | "story_event_required";
  enforcement: "block" | "review";
}

export interface NovelCharacterAppearanceProfileRecord {
  entityId: string;
  effectiveFromChapterId?: string;
  summary: string;
  locks: NovelCharacterAppearanceLock[];
  sourceIds: string[];
  revision: number;
}

export interface NovelContinuityIssueRecord {
  issueId: string;
  status: "open" | "resolved" | "waived";
  severity: NovelReviewSeverity;
  summary: string;
  chapterIds: string[];
  entityIds: string[];
  evidence: string;
  resolution?: string;
  sourceIds: string[];
  revision: number;
}

export interface NovelChapterStateCompletion {
  chapterId: string;
  chapterRevision: number;
  chapterSha256: string;
  stateCommitId: string;
  candidateId?: string;
  committedAt: string;
}

export interface NovelWritingStateRebuild {
  rebuildId: string;
  targetFromChapterId: string;
  baseChapterId: string;
  previousCurrentThroughChapterId: string;
  pendingChapterIds: string[];
  nextChapterId: string;
  originalWritingStateRevision: number;
  originalWritingStateFingerprint: string;
  planFingerprint: string;
  startedAt: string;
  /** Phase 4 shadow lineage fields；旧 V1 rebuild 可缺失。 */
  generation?: number;
  lineageId?: string;
  parentEventId?: string | null;
  shadowStateLocator?: string;
  shadowStateFingerprint?: string;
  publicWritingStateRevision?: number;
  publicWritingStateFingerprint?: string;
  manifestRevision?: number;
  temporalManifestDigest?: string;
}

export type NovelWritingStateHistoryCoverageMode = "complete" | "head_only";

export interface NovelWritingStateHistoryHead {
  lineageId: string;
  headEventId: string | null;
  checkpointId: string;
  stateRevision: number;
  stateFingerprint: string;
  throughChapterId: string;
  coverageMode: NovelWritingStateHistoryCoverageMode;
  coverageBaseChapterId: string;
}

export interface NovelWritingStateHistoryActiveRebuild {
  rebuildId: string;
  generation: number;
  lineageId: string;
  planFingerprint: string;
  targetFromChapterId: string;
  baseChapterId: string;
  previousCurrentThroughChapterId: string;
  pendingChapterIds: string[];
  nextChapterId: string;
  shadowHeadEventId: string | null;
  shadowCheckpointId: string;
  shadowStateLocator: string;
  shadowStateRevision: number;
  shadowStateFingerprint: string;
  manifestRevision: number;
  temporalManifestDigest: string;
  startedAt: string;
}

export interface NovelWritingStateHistoryControl {
  schemaVersion: 1;
  kind: "novel-writing-state-history-control";
  projectId: string;
  revision: number;
  publicHead: NovelWritingStateHistoryHead;
  activeRebuild?: NovelWritingStateHistoryActiveRebuild;
  updatedAt: string;
  fingerprint: string;
}

export interface NovelWritingStateCheckpoint {
  schemaVersion: 1;
  kind: "novel-writing-state-checkpoint";
  checkpointId: string;
  projectId: string;
  lineageId: string;
  headEventId: string | null;
  coverageMode: NovelWritingStateHistoryCoverageMode;
  coverageBaseChapterId: string;
  state: NovelWritingStateDocument;
  createdAt: string;
  fingerprint: string;
}

export interface NovelWritingStateCommitEvent {
  schemaVersion: 1;
  kind: "novel-writing-state-commit-event";
  eventId: string;
  projectId: string;
  lineageId: string;
  parentEventId: string | null;
  operationKind: "chapter_state_commit" | "story_bible_commit" | "rebuild_started" | "rebuild_shadow_commit" | "rebuild_promotion";
  chapter?: NovelChapterSourceIdentity;
  candidateId?: string;
  candidateFingerprint?: string;
  decisionId?: string;
  decisionFingerprint?: string;
  contribution?: "changes" | "no_change";
  beforeStateRevision: number;
  beforeStateFingerprint: string;
  beforeCheckpointId: string;
  afterStateRevision: number;
  afterStateFingerprint: string;
  checkpointId: string;
  temporalManifestDigest: string;
  createdAt: string;
  fingerprint: string;
}

export interface NovelWritingStateDocument {
  schemaVersion: 1;
  kind: "novel-writing-state";
  projectId: string;
  revision: number;
  baselineStatus: NovelWritingBaselineStatus;
  sourceTreeAggregateSha256: string;
  currentThroughChapterId: string;
  /** 新状态在 seed 时锁定；旧 V1 缺失时不得猜测可安全 rewind 的历史覆盖。 */
  historyBaseChapterId?: string;
  rebuild?: NovelWritingStateRebuild;
  sources: NovelWritingSourceDocument[];
  entities: NovelWritingEntity[];
  hardCanon: NovelHardCanonRule[];
  characterStates: NovelCharacterStateRecord[];
  knowledge: NovelKnowledgeRecord[];
  relationships: NovelRelationshipRecord[];
  timeline: NovelTimelineRecord[];
  foreshadowing: NovelForeshadowingRecord[];
  chapterBriefs: NovelChapterBriefRecord[];
  /** 旧 V1 状态文件可缺失；首次受管 story-bible 写入时 copy-on-write 补齐。 */
  characterProfiles?: NovelCharacterProseProfileRecord[];
  /** 旧 V1 状态文件可缺失；正式写章时 required cast 必须有 cutoff 有效的结构化外形卡。 */
  characterAppearances?: NovelCharacterAppearanceProfileRecord[];
  /** 旧 V1 状态文件可缺失；仅存受 owner 裁决的连续性问题。 */
  continuityIssues?: NovelContinuityIssueRecord[];
  chapterCompletions: NovelChapterStateCompletion[];
  appliedCandidateIds: string[];
  appliedStoryBibleCandidateIds?: string[];
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
}

export interface NovelSeedWritingStateInput {
  baselineStatus: NovelWritingBaselineStatus;
  sourceTreeAggregateSha256: string;
  currentThroughChapterId: string;
  sourceDocuments: NovelWritingSourceDocumentInput[];
  entities: Array<Omit<NovelWritingEntity, "revision">>;
  hardCanon: Array<Omit<NovelHardCanonRule, "revision">>;
  characterStates: Array<Omit<NovelCharacterStateRecord, "revision" | "sourceChapter">>;
  knowledge: Array<Omit<NovelKnowledgeRecord, "revision" | "sourceChapter">>;
  relationships: Array<Omit<NovelRelationshipRecord, "revision" | "sourceChapter">>;
  timeline: Array<Omit<NovelTimelineRecord, "revision" | "sourceChapter">>;
  foreshadowing: Array<Omit<NovelForeshadowingRecord, "revision" | "sourceChapter">>;
  chapterBriefs: Array<Omit<NovelChapterBriefRecord, "revision">>;
  /** 新建正式 Writing OS 基线时可直接锁定人物声口；旧调用缺失时仍可 rehearsal。 */
  characterProfiles?: Array<Omit<NovelCharacterProseProfileRecord, "revision">>;
  /** 新建正式 Writing OS 基线时可直接锁定人物外形；旧调用缺失时仍可 rehearsal。 */
  characterAppearances?: Array<Omit<NovelCharacterAppearanceProfileRecord, "revision">>;
  completedChapterIds: string[];
}

export interface NovelChapterStateDelta {
  characterStates: Array<{
    stateId: string;
    entityId: string;
    fields: NovelCharacterDynamicFields;
  }>;
  knowledge: Array<Omit<NovelKnowledgeRecord, "revision" | "sourceIds" | "sourceChapter">>;
  relationships: Array<Omit<NovelRelationshipRecord, "revision" | "sourceIds" | "sourceChapter" | "throughChapterId">>;
  timeline: Array<Omit<NovelTimelineRecord, "revision" | "sourceIds" | "sourceChapter">>;
  foreshadowing: Array<Omit<NovelForeshadowingRecord, "revision" | "sourceIds" | "sourceChapter">>;
}

export const NOVEL_STATE_CHANGE_KINDS = [
  "character_state",
  "knowledge",
  "relationship",
  "timeline",
  "foreshadowing",
] as const;
export type NovelStateChangeKind = typeof NOVEL_STATE_CHANGE_KINDS[number];

export interface NovelChapterEvidenceSpan {
  evidenceId: string;
  startOffset: number;
  endOffset: number;
  evidenceExcerpt: string;
}

export interface NovelStateChangeEvidence {
  kind: NovelStateChangeKind;
  recordId: string;
  reason: string;
  evidenceSpanIds: string[];
}

export interface NovelNoStateChangeDeclaration {
  reason: string;
  evidenceSpanIds: string[];
  checkedCharacterIds: string[];
}

export interface NovelCandidateAuditScope {
  checkedCharacterIds: string[];
  checkedStateKinds: NovelStateChangeKind[];
}

export interface NovelStageChapterStateCandidateInput {
  chapterId: string;
  expectedChapterRevision: number;
  expectedChapterSha256: string;
  expectedWritingStateRevision: number;
  expectedWritingStateFingerprint: string;
  summary: string;
  delta: NovelChapterStateDelta;
  evidenceSpans: NovelChapterEvidenceSpan[];
  changeEvidence: NovelStateChangeEvidence[];
  noStateChange?: NovelNoStateChangeDeclaration;
  auditScope: NovelCandidateAuditScope;
}

export interface NovelChapterStateCandidate {
  schemaVersion: 2;
  kind: "novel-chapter-state-candidate";
  candidateId: string;
  projectId: string;
  chapter: NovelChapterSourceIdentity;
  baseWritingStateRevision: number;
  baseWritingStateFingerprint: string;
  summary: string;
  delta: NovelChapterStateDelta;
  evidenceSpans: NovelChapterEvidenceSpan[];
  changeEvidence: NovelStateChangeEvidence[];
  noStateChange?: NovelNoStateChangeDeclaration;
  auditScope: NovelCandidateAuditScope;
  changeKind: "delta" | "no_state_change";
  offsetEncoding: typeof NOVEL_OFFSET_ENCODING;
  createdAt: string;
  fingerprint: string;
}

export interface NovelLegacyChapterStateCandidate {
  schemaVersion: 1;
  kind: "novel-chapter-state-candidate";
  candidateId: string;
  projectId: string;
  chapter: NovelChapterSourceIdentity;
  baseWritingStateRevision: number;
  baseWritingStateFingerprint: string;
  summary: string;
  delta: NovelChapterStateDelta;
  createdAt: string;
  fingerprint: string;
  evidenceSpans?: NovelChapterEvidenceSpan[];
  changeEvidence?: NovelStateChangeEvidence[];
  noStateChange?: NovelNoStateChangeDeclaration;
}

export type NovelAnyChapterStateCandidate = NovelChapterStateCandidate | NovelLegacyChapterStateCandidate;

export interface NovelReviewChapterStateCandidateInput {
  candidateId: string;
  expectedCandidateFingerprint: string;
  expectedWritingStateRevision: number;
  expectedWritingStateFingerprint: string;
  decision: "accepted" | "rejected";
  reviewer: string;
  note?: string;
}

export type NovelStoryBibleChange =
  | {
    changeId: string;
    kind: "source_binding";
    reason: string;
    value: {
      receiptId: string;
      receiptFingerprint: string;
      sourceRelativePath: string;
      sourceId: string;
    };
  }
  | {
    changeId: string;
    kind: "entity";
    reason: string;
    supersedesRevision?: number;
    value: Omit<NovelWritingEntity, "revision">;
  }
  | {
    changeId: string;
    kind: "hard_canon";
    reason: string;
    supersedesRevision?: number;
    value: Omit<NovelHardCanonRule, "revision">;
  }
  | {
    changeId: string;
    kind: "chapter_brief";
    reason: string;
    supersedesRevision?: number;
    value: Omit<NovelChapterBriefRecord, "revision">;
  }
  | {
    changeId: string;
    kind: "character_profile";
    reason: string;
    supersedesRevision?: number;
    value: Omit<NovelCharacterProseProfileRecord, "revision">;
  }
  | {
    changeId: string;
    kind: "character_appearance";
    reason: string;
    supersedesRevision?: number;
    value: Omit<NovelCharacterAppearanceProfileRecord, "revision">;
  }
  | {
    changeId: string;
    kind: "continuity_issue";
    reason: string;
    supersedesRevision?: number;
    value: Omit<NovelContinuityIssueRecord, "revision">;
  };

export interface NovelStageStoryBibleCandidateInput {
  expectedWritingStateRevision: number;
  expectedWritingStateFingerprint: string;
  summary: string;
  changes: NovelStoryBibleChange[];
}

export interface NovelStoryBibleCandidate {
  schemaVersion: 1;
  kind: "novel-story-bible-candidate";
  candidateId: string;
  projectId: string;
  baseWritingStateRevision: number;
  baseWritingStateFingerprint: string;
  summary: string;
  changes: NovelStoryBibleChange[];
  resolvedSourceBindings?: NovelWritingSourceDocument[];
  createdAt: string;
  fingerprint: string;
}

export interface NovelReviewStoryBibleCandidateInput {
  candidateId: string;
  expectedCandidateFingerprint: string;
  expectedWritingStateRevision: number;
  expectedWritingStateFingerprint: string;
  decision: "accepted" | "rejected";
  reviewer: string;
  note?: string;
}

export interface NovelInvalidateWritingStateFromInput {
  targetChapterId: string;
  expectedWritingStateRevision: number;
  expectedWritingStateFingerprint: string;
  expectedPlanFingerprint: string;
}

export interface NovelStoryBibleDecision {
  schemaVersion: 1;
  kind: "novel-story-bible-decision";
  decisionId: string;
  projectId: string;
  candidateId: string;
  candidateFingerprint: string;
  decision: "accepted" | "rejected";
  reviewer: string;
  note?: string;
  writingStateRevision?: number;
  writingStateFingerprint?: string;
  decidedAt: string;
  fingerprint: string;
}

export interface NovelChapterStateDecision {
  schemaVersion: 1;
  kind: "novel-chapter-state-decision";
  decisionId: string;
  projectId: string;
  candidateId: string;
  candidateFingerprint: string;
  decision: "accepted" | "rejected";
  reviewer: string;
  note?: string;
  writingStateRevision?: number;
  writingStateFingerprint?: string;
  decidedAt: string;
  fingerprint: string;
}

export interface NovelAttachReviewTicketInput {
  chapterId: string;
  expectedChapterRevision: number;
  expectedChapterSha256: string;
  startOffset: number;
  endOffset: number;
  evidenceExcerpt: string;
  severity: NovelReviewSeverity;
  impact: string;
  minimalFix: string;
  confidence: number;
  reviewer: string;
}

export interface NovelReviewTicket {
  schemaVersion: 1;
  kind: "novel-review-ticket";
  ticketId: string;
  projectId: string;
  chapter: NovelChapterSourceIdentity;
  startOffset: number;
  endOffset: number;
  offsetEncoding: typeof NOVEL_OFFSET_ENCODING;
  evidenceExcerpt: string;
  severity: NovelReviewSeverity;
  impact: string;
  minimalFix: string;
  confidence: number;
  reviewer: string;
  createdAt: string;
  fingerprint: string;
}

export interface CreateNovelChapterInput {
  volumeId: string;
  title: string;
  content?: string;
  order?: number;
  expectedManifestRevision: number;
}

export interface CreateNovelVolumeInput {
  title: string;
  order?: number;
  expectedManifestRevision: number;
}

export interface RenameNovelChapterInput {
  chapterId: string;
  title: string;
  expectedRevision: number;
  expectedManifestRevision: number;
}

export interface MoveNovelChapterInput {
  chapterId: string;
  volumeId: string;
  order?: number;
  expectedRevision: number;
  expectedSha256: string;
  expectedManifestRevision: number;
}

export interface ReorderNovelChaptersInput {
  orderedChapterIds: string[];
  expectedManifestRevision: number;
}

export interface NovelWorkspaceDeclaration {
  workspaceMode: WorkspaceMode;
  minimumWriterSchemaVersion: typeof MANAGED_PROJECT_WRITER_SCHEMA_VERSION;
  novelManifest?: typeof NOVEL_MANIFEST_RELATIVE_PATH;
}

export function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return typeof value === "string" && (WORKSPACE_MODES as readonly string[]).includes(value);
}

export function isNovelSourceMode(value: unknown): value is NovelSourceMode {
  return typeof value === "string" && (NOVEL_SOURCE_MODES as readonly string[]).includes(value);
}
