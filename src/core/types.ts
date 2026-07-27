export const WORK_ITEM_STATUSES = [
  "待规划",
  "待提示词",
  "待首帧",
  "待尾帧",
  "待机械验收",
  "待视觉验收",
  "待视频",
  "视频生成中",
  "待视频验收",
  "已完成",
  "返工",
  "阻塞",
  "弃用",
] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export type WorkItemType = "project" | "season" | "episode" | "unit" | "shot" | "asset";
export type ArtifactKind =
  | "info"
  | "prompt"
  | "raw-image"
  | "labeled-image"
  | "storyboard-sheet-png"
  | "storyboard-sheet-svg"
  | "storyboard-sheet-receipt"
  | "video"
  | "audio"
  | "manifest"
  | "other";
export type ArtifactVariant = "start" | "end" | "generic";
export const REVIEW_CRITERIA_KEYS = [
  "character_identity",
  "hard_lock",
  "prop_costume",
  "scene_continuity",
  "composition",
  "image_quality",
  "raw_labeled_pair",
  "motion_continuity",
  "duration_audio",
] as const;
export type ReviewCriterionKey = (typeof REVIEW_CRITERIA_KEYS)[number];
export type ReviewResult = "pass" | "fail" | "na";
export type ReviewDecision = "pending" | "pass" | "rework";
export const REVIEW_ANNOTATION_TYPES = ["issue", "keep", "question", "continuity"] as const;
export type ReviewAnnotationType = (typeof REVIEW_ANNOTATION_TYPES)[number];

export interface HardLock {
  id: string;
  name: string;
  path: string;
  note: string;
}

export interface ProjectNamingRule {
  id: string;
  type: "unit" | "shot";
  pattern: string;
  scope?: string;
}

export interface ProjectManualMapping {
  pathPrefix: string;
  type: "unit" | "shot";
  episode: number;
  unit?: number;
  shot?: string;
  title?: string;
  scope?: string;
}

export interface ProjectNamingRules {
  patterns: ProjectNamingRule[];
  manualMappings: ProjectManualMapping[];
}

export interface ProjectConfig {
  schemaVersion: 1;
  id: string;
  name: string;
  primaryRoot: string;
  sourceRoots: string[];
  outputRoots: string[];
  ignoreSegments: string[];
  namingRules: ProjectNamingRules;
  hardLocks: HardLock[];
  automation: {
    imageBatchSize: number;
    videoBatchSize: number;
    pauseAfterVisualBatch: boolean;
    allowOverwriteAuthoritative: false;
  };
  createdAt: string;
  updatedAt: string;
}

export interface MechanicalCheck {
  inspectionVersion?: number;
  ok: boolean;
  exists: boolean;
  decodable?: boolean;
  width?: number;
  height?: number;
  duration?: number;
  size: number;
  sha256?: string;
  modifiedAt?: string;
  ctimeMs?: number;
  issues: string[];
}

export interface FusionStoryboardPanelArtifactBinding {
  schemaVersion: 1;
  type: "fusion-storyboard-panel";
  contractId: string;
  sourceFingerprint: string;
  productionFingerprint: string;
  panelId: string;
  panelIndex: number;
  panelCount: number;
  frameRole: "start" | "middle" | "end";
  startSeconds: number;
  endSeconds: number;
  generationJobId: string;
  publicationReceiptId?: string;
  panelReferenceEvidenceVersion?: 1;
  panelReferenceResolutionId?: string;
  panelReferenceResolutionFingerprint?: string;
  panelVisualConstraintEvidenceVersion?: 1;
  panelVisualConstraintId?: string;
  panelVisualConstraintFingerprint?: string;
  panelVisualModelFingerprint?: string;
  panelVisualReviewRulesFingerprint?: string;
}

export type FusionStoryboardSheetDerivedStatus = "current" | "stale" | "invalid" | "legacy-invalid";

export interface FusionStoryboardSheetArtifactBinding {
  schemaVersion: 1;
  type: "fusion-storyboard-sheet";
  sheetId: string;
  inputFingerprint?: string;
  contractId: string;
  requirementId?: string;
  reviewId?: string;
  role: "png" | "svg" | "receipt";
  pageIndex?: number;
  pageCount: number;
  status: FusionStoryboardSheetDerivedStatus;
  reasons: string[];
}

export type FusionStoryboardPanelState =
  | "missing"
  | "queued"
  | "generating"
  | "generation_unknown"
  | "candidate_review"
  | "visual_rejected"
  | "produced"
  | "mechanical_failed"
  | "awaiting_review"
  | "approved";

export interface FusionStoryboardPanelProgress {
  panelId: string;
  panelIndex: number;
  panelCount: number;
  frameRole: "start" | "middle" | "end";
  startSeconds: number;
  endSeconds: number;
  state: FusionStoryboardPanelState;
  generationJobId?: string;
  generationStatus?: GenerationJobStatus;
  publicationReceiptId?: string;
  rawArtifactId?: string;
  labeledArtifactId?: string;
  issues: string[];
}

export interface FusionStoryboardProgress {
  contractId: string;
  sourceFingerprint: string;
  productionFingerprint: string;
  sourceStoryboardRevision: number;
  panelCount: number;
  completedPanelCount: number;
  mechanicallyValidPanelCount: number;
  visuallyApproved: boolean;
  selectionSource: "explicit" | "inferred";
  panels: FusionStoryboardPanelProgress[];
  issues: string[];
}

export interface Artifact {
  id: string;
  uri: string;
  itemId: string;
  path: string;
  rootSlot: string;
  relativePath: string;
  kind: ArtifactKind;
  variant: ArtifactVariant;
  versionLabel: string;
  deprecated: boolean;
  authoritative: boolean;
  accepted: boolean;
  modifiedAt: string;
  check: MechanicalCheck;
  fusionStoryboardPanel?: FusionStoryboardPanelArtifactBinding;
  fusionStoryboardSheet?: FusionStoryboardSheetArtifactBinding;
}

export interface WorkItem {
  id: string;
  parentId?: string;
  type: WorkItemType;
  /** 仅资产节点使用；必须来自显式资产定义或规范资产库，禁止从路径或标题推断。 */
  assetCategory?: "character" | "scene" | "prop";
  title: string;
  episode?: number;
  unit?: number;
  shot?: string;
  status: WorkItemStatus;
  inferredStatus: WorkItemStatus;
  stage: "剧本" | "硬锁资产" | "首尾帧" | "视频" | "验收";
  priority: number;
  sourcePaths: string[];
  infoPath?: string;
  infoExcerpt?: string;
  nextAction: string;
  failureReason?: string;
  hardLockIds: string[];
  artifactIds: string[];
  thumbnailPath?: string;
  dependencies: string[];
  updatedAt: string;
  fusionStoryboard?: FusionStoryboardProgress;
}

export interface ProgressSummary {
  total: number;
  active: number;
  completed: number;
  deprecated: number;
  blocked: number;
  byStatus: Record<WorkItemStatus, number>;
  byEpisode: Record<string, { total: number; completed: number; active: number }>;
  rawImages: number;
  labeledImages: number;
  videos: number;
  storyboardSheets?: {
    current: number;
    stale: number;
    invalid: number;
    legacyInvalid: number;
    pages: number;
  };
  mechanicalFailures: number;
  fusionStoryboardPanels?: {
    required: number;
    produced: number;
    mechanicallyValid: number;
    approved: number;
  };
}

export interface ProjectIndex {
  schemaVersion: 1;
  project: ProjectConfig;
  scanId: string;
  scannedAt: string;
  scanDurationMs: number;
  scanStats?: {
    discoveredFiles: number;
    candidateFiles: number;
    reservedPublicationFilesSkipped: number;
    referenceAssets: number;
    productionAssets?: number;
    inspectedChecks: number;
    reusedChecks: number;
    textFilesRead: number;
    includeHashes: boolean;
    inspectionConcurrency: number;
  };
  warnings: string[];
  summary: ProgressSummary;
  items: WorkItem[];
  artifacts: Artifact[];
}

export type ImportIssueSeverity = "info" | "warning" | "error";
export type ProjectImportMode = "filesystem" | "story_first";

export interface ProjectImportOptions {
  primaryRoot: string;
  projectMode?: ProjectImportMode;
  name?: string;
  sourceRoots?: string[];
  outputRoots?: string[];
  ignoreSegments?: string[];
  namingRules?: ProjectNamingRules;
}

export interface ImportRootReport {
  root: string;
  role: "primary" | "source" | "output";
  exists: boolean;
  readable: boolean;
  writable: boolean;
  discoveredFiles: number;
  recognizedArtifacts: number;
}

export interface ProjectImportIssue {
  severity: ImportIssueSeverity;
  code: string;
  message: string;
  path?: string;
  itemId?: string;
}

export interface ProjectImportPreview {
  previewId: string;
  mode: "new" | "resume" | "registered";
  projectMode: ProjectImportMode;
  canImport: boolean;
  config: ProjectConfig;
  summary: ProgressSummary;
  scanDurationMs: number;
  roots: ImportRootReport[];
  issues: ProjectImportIssue[];
  sampleItems: WorkItem[];
  recognized: {
    units: number;
    shots: number;
    nestedShots: number;
    assets: number;
    artifacts: number;
    deprecatedArtifacts: number;
    mechanicalFailures: number;
  };
  willWrite: string[];
}

export interface StatusOverride {
  status?: WorkItemStatus;
  statusAuthority?: "general" | "review";
  /**
   * 当前节点各验收相位绑定的不可变 ReviewRecord。图片通过证据必须在视频
   * 生成/验收期间继续保留；否则视频通过会错误掩盖已经漂移的首尾帧。
   */
  reviewEvidenceIds?: Partial<Record<"image" | "video", string>>;
  reviewRequirementIds?: Partial<Record<"image" | "video", string>>;
  /** 旧侧车与当前状态上下文兼容字段；新代码同时写入 reviewEvidenceIds。 */
  statusEvidenceId?: string;
  authoritativePath?: string;
  authoritativePaths?: Record<string, string>;
  authoritativeArtifactId?: string;
  authoritativeArtifactIds?: Record<string, string>;
  note?: string;
  updatedAt: string;
}

export interface ProjectOverrides {
  schemaVersion: 1;
  items: Record<string, StatusOverride>;
}

export interface TaskPack {
  schemaVersion: 2;
  id: string;
  projectId: string;
  revision: number;
  status: "ready" | "claimed" | "awaiting_review" | "completed" | "blocked" | "cancelled";
  kind: "image" | "video";
  mode: "observe" | "collaborate" | "autopilot";
  itemIds: string[];
  episode?: number;
  boundary?: {
    episode?: number;
    parentId?: string;
    maxItems: number;
    pauseAfterVisualReview: boolean;
  };
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  lease?: {
    id: string;
    owner: string;
    claimedAt: string;
    heartbeatAt: string;
    leaseUntil: string;
    leaseSeconds: number;
  };
  lastRelease?: { leaseId: string; owner: string; reason?: string; releasedAt: string };
  cancellation?: {
    reason: string;
    cancelledAt: string;
    previousStatus: "ready" | "claimed";
    previousLeaseId?: string;
    previousOwner?: string;
  };
  result?: {
    status: "awaiting_review" | "completed" | "blocked";
    completedItemIds: string[];
    failedItemIds: string[];
    awaitingReviewItemIds: string[];
    verifiedScanId: string;
    reviewRequirements?: Record<string, {
      reviewType: "image" | "video";
      artifactIds: string[];
      artifactHashes: Record<string, string>;
      requirementId?: string;
      notBefore: string;
    }>;
    note?: string;
    finishedAt: string;
  };
  instructions: string[];
  hardLocks: HardLock[];
  skillRefs: Array<Pick<AgentSkill, "id" | "name" | "description" | "category" | "path" | "revision">>;
  outputRules: string[];
  acceptanceCriteria: string[];
  itemSnapshots: Array<Pick<WorkItem, "id" | "type" | "parentId" | "title" | "episode" | "unit" | "shot" | "status" | "infoPath" | "nextAction" | "sourcePaths" | "thumbnailPath" | "hardLockIds"> & {
    promptExcerpt?: string;
    suggestedOutputDirectory: string;
    referencePaths: string[];
    storyboardRows: StoryboardProductionContract[];
    storyEventIds: string[];
  }>;
}

export const PROJECT_CONTEXT_KINDS = ["canon", "character", "location", "prop", "continuity", "decision", "issue", "handoff"] as const;
export type ProjectContextKind = (typeof PROJECT_CONTEXT_KINDS)[number];

export type RevisionedUpsertInput<T extends object> =
  | (T & { id?: never; expectedRevision?: never })
  | (T & { id: string; expectedRevision: number });

export interface ProjectContextInputFields {
  kind: ProjectContextKind;
  title: string;
  content: string;
  tags?: string[];
  itemIds?: string[];
  sourcePaths?: string[];
}

export type ProjectContextUpsertInput = RevisionedUpsertInput<ProjectContextInputFields>;
export interface ProjectContextDeleteInput { contextId: string; expectedRevision: number }

export interface ProjectContextEntry {
  id: string;
  kind: ProjectContextKind;
  title: string;
  content: string;
  tags: string[];
  itemIds: string[];
  sourcePaths: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectContextStore {
  schemaVersion: 1;
  revision: number;
  entries: ProjectContextEntry[];
  updatedAt: string;
}

export type AgentSkillCategory = "orchestration" | "production" | "continuity" | "review" | "custom";

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  category: AgentSkillCategory;
  enabled: boolean;
  content: string;
  path: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContextSearchHit {
  id: string;
  source: "memory" | "item" | "hard-lock" | "review" | "event";
  score: number;
  title: string;
  excerpt: string;
  kind?: ProjectContextKind;
  itemId?: string;
  path?: string;
  updatedAt?: string;
}

export interface ContinuationSnapshot {
  generatedAt: string;
  projectRoot: string;
  projectName: string;
  scannedAt: string;
  summary: ProgressSummary;
  focusItem?: WorkItem;
  nextItems: WorkItem[];
  blockers: WorkItem[];
  generationRecovery: Array<{
    jobId: string;
    itemId: string;
    kind: GenerationKind;
    providerId: string;
    status: GenerationJobStatus;
    expectedOutputPath: string;
    requestPath?: string;
    error?: string;
    browserCheckpoint?: Pick<BrowserGenerationCheckpoint, "revision" | "stage" | "updatedAt" | "submissionIntent" | "submissionReconciliation">;
    httpSubmissionCheckpoint?: HttpGenerationSubmissionCheckpoint;
    comfyUiCheckpoint?: ComfyUiGenerationCheckpoint;
    subagentCheckpoint?: SubagentImageGenerationCheckpoint;
  }>;
  relatedContext: ContextSearchHit[];
  recentEvents: ProjectEvent[];
  recentReviews: ReviewRecord[];
  activeSkills: Array<Pick<AgentSkill, "id" | "name" | "description" | "category" | "path" | "revision">>;
  prompt: string;
}

export type StorySourceKind = "text" | "markdown" | "docx";

export interface StorySource {
  id: string;
  title: string;
  originalPath: string;
  snapshotPath: string;
  kind: StorySourceKind;
  encoding: "utf-8" | "gb18030" | "docx";
  sha256: string;
  size: number;
  charCount: number;
  chapterIds: string[];
  revision: number;
  importedAt: string;
  updatedAt: string;
}

export interface StoryChapter {
  id: string;
  sourceId: string;
  index: number;
  title: string;
  path: string;
  charCount: number;
  sha256: string;
  startOffset: number;
  endOffset: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoryLibrary {
  schemaVersion: 1;
  revision: number;
  sources: StorySource[];
  chapters: StoryChapter[];
  updatedAt: string;
}

export interface StoryChapterContent {
  chapter: StoryChapter;
  content: string;
}

export type StoryEventStatus = "draft" | "confirmed" | "deprecated";

export interface StoryEvent {
  id: string;
  chapterId: string;
  order: number;
  title: string;
  description: string;
  sourceExcerpt?: string;
  characters: string[];
  locations: string[];
  props: string[];
  tags: string[];
  episode?: number;
  unit?: number;
  itemIds: string[];
  dependencyIds: string[];
  status: StoryEventStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoryEventGraph {
  schemaVersion: 1;
  revision: number;
  events: StoryEvent[];
  updatedAt: string;
}

export interface StoryContextBundle {
  generatedAt: string;
  item: WorkItem;
  events: StoryEvent[];
  chapterExcerpts: Array<{ chapter: StoryChapter; excerpt: string }>;
  hardLocks: HardLock[];
  projectContext: ContextSearchHit[];
  prompt: string;
}

export interface SourceSpan {
  sourceId: string;
  chapterId: string;
  chapterRevision: number;
  chapterSha256: string;
  startOffset: number;
  endOffset: number;
  text: string;
}

export type NovelFactKind = "event" | "character" | "location" | "prop" | "rule" | "dialogue" | "relationship" | "time" | "weather" | "costume" | "narration" | "psychology" | "environment";
export type EpistemicStatus = "confirmed" | "inferred" | "uncertain";

export interface NovelFact {
  schemaVersion: 1;
  id: string;
  kind: NovelFactKind;
  epistemicStatus: EpistemicStatus;
  statement: string;
  subject?: string;
  predicate?: string;
  object?: string;
  sourceSpans: SourceSpan[];
  tags: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface NarrativeBeat {
  schemaVersion: 1;
  id: string;
  order: number;
  title: string;
  summary: string;
  narrativePurpose: string;
  visualAction: string;
  emotionalShift: string;
  conflict?: string;
  turn?: string;
  outcome?: string;
  narration?: string;
  psychology?: string;
  ambience?: string;
  mustKeep: string[];
  estimatedDurationSeconds: number;
  factIds: string[];
  sourceSpans: SourceSpan[];
  dialogue?: string;
  intensity: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface EntityRevisionRef {
  id: string;
  revision: number;
}

export interface AdaptationValidation {
  hardErrors: string[];
  warnings: string[];
  checkedAt: string;
}

export interface AdaptationUnit {
  id: string;
  episode: number;
  unit: number;
  title: string;
  durationSeconds: number;
  beatIds: string[];
  factIds: string[];
  directorIntent: string;
  emotionalArc: string;
  continuityNotes: string[];
  storyboardRows: StoryboardRow[];
}

export interface AdaptationPlan {
  schemaVersion: 1;
  id: string;
  name: string;
  mode: "concise" | "split";
  status: "draft" | "selected" | "materialized";
  sourceLibraryRevision: number;
  units: AdaptationUnit[];
  validation: AdaptationValidation;
  revision: number;
  createdAt: string;
  updatedAt: string;
  materializedAt?: string;
  pendingUnitIds?: string[];
}

export interface AdaptationChangeImpact {
  changedFactIds: string[];
  changedBeatIds: string[];
  affectedBeatIds: string[];
  affectedPlanIds: string[];
  affectedUnitIds: string[];
  affectedRowIds: string[];
  affectedItemIds: string[];
  plans: Array<{
    planId: string;
    status: AdaptationPlan["status"];
    unitIds: string[];
    rowIds: string[];
    itemIds: string[];
  }>;
}

export type NovelAnalysisProviderKind = "codex" | "external";
export type NovelAnalysisProviderAdapter = "openai-compatible" | "mock";
export type NovelAnalysisTaskStatus = "prepared" | "executing" | "submission_unknown" | "reviewing" | "completed" | "failed";
export type NovelAnalysisReviewStatus = "pending" | "accepted" | "rejected";

export interface NovelAnalysisProvider {
  schemaVersion: 1;
  id: string;
  name: string;
  adapter: NovelAnalysisProviderAdapter;
  enabled: boolean;
  baseUrl?: string;
  model: string;
  apiKeyEnv?: string;
  allowPrivateNetwork: boolean;
  allowStoryUpload: boolean;
  useJsonResponseFormat: boolean;
  timeoutSeconds: number;
  maxInputCharacters: number;
  temperature: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface NovelAnalysisProviderSettings {
  schemaVersion: 1;
  revision: number;
  defaultProviderId?: string;
  providers: NovelAnalysisProvider[];
  updatedAt: string;
}

export interface NovelAnalysisExecution {
  id: string;
  providerId: string;
  providerRevision: number;
  status: "submitting" | "submission_unknown" | "succeeded" | "failed";
  requestHash: string;
  startedAt: string;
  completedAt?: string;
  responseId?: string;
  responseModel?: string;
  proposalPath?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  error?: string;
}

export interface NovelAnalysisChapterRef {
  chapterId: string;
  sourceId: string;
  revision: number;
  sha256: string;
  path: string;
  startOffset?: number;
  endOffset?: number;
  characterCount?: number;
  segmentIndex?: number;
  segmentCount?: number;
}

export interface NovelAnalysisTask {
  schemaVersion: 1;
  id: string;
  providerId: string;
  providerKind: NovelAnalysisProviderKind;
  status: NovelAnalysisTaskStatus;
  sourceLibraryRevision: number;
  chapterRefs: NovelAnalysisChapterRef[];
  runId?: string;
  batchIndex?: number;
  batchCount?: number;
  plannedCharacterCount?: number;
  beatOrderBase?: number;
  providerRevisionSnapshot?: number;
  maxInputCharactersSnapshot?: number;
  attempt?: number;
  supersedesTaskId?: string;
  replacedByTaskId?: string;
  replacementReason?: string;
  taskJsonPath: string;
  taskMarkdownPath: string;
  reviewItemIds: string[];
  execution?: NovelAnalysisExecution;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type NovelAnalysisRunStatus = "ready" | "running" | "awaiting_review" | "completed" | "blocked" | "stale";

export interface NovelAnalysisRunProgress {
  runId: string;
  providerId: string;
  providerRevision: number;
  sourceLibraryRevision: number;
  status: NovelAnalysisRunStatus;
  totalBatches: number;
  completedBatches: number;
  reviewingBatches: number;
  preparedBatches: number;
  executingBatches: number;
  failedBatches: number;
  unknownBatches: number;
  plannedCharacterCount: number;
  taskIds: string[];
  nextTaskId?: string;
  blocker?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NovelAnalysisReviewItem {
  schemaVersion: 1;
  id: string;
  taskId: string;
  kind: "fact" | "beat";
  status: NovelAnalysisReviewStatus;
  fact?: Omit<NovelFact, "schemaVersion" | "revision" | "createdAt" | "updatedAt">;
  beat?: Omit<NarrativeBeat, "schemaVersion" | "revision" | "createdAt" | "updatedAt">;
  evidenceIssues: string[];
  appliedEntityId?: string;
  decisionNote?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdaptationWorkspace {
  schemaVersion: 1;
  revision: number;
  sourceLibraryRevision: number;
  facts: NovelFact[];
  beats: NarrativeBeat[];
  plans: AdaptationPlan[];
  analysisTasks: NovelAnalysisTask[];
  analysisReviews: NovelAnalysisReviewItem[];
  selectedPlanId?: string;
  updatedAt: string;
}

export type AdaptationStore = AdaptationWorkspace;

export interface CanvasPosition {
  x: number;
  y: number;
}

export type CanvasEntityKind = "note" | "group";
export type CanvasEntityColor = "gold" | "blue" | "green" | "red" | "purple" | "gray";
export type CanvasLinkKind = "continuity" | "reference" | "dependency" | "comment";

export interface CanvasEntity {
  id: string;
  kind: CanvasEntityKind;
  title: string;
  body: string;
  color: CanvasEntityColor;
  position: CanvasPosition;
  width: number;
  height: number;
  memberIds: string[];
  memberOffsets: Record<string, CanvasPosition>;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasSemanticLink {
  id: string;
  sourceId: string;
  targetId: string;
  kind: CanvasLinkKind;
  label?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasSemanticState {
  schemaVersion: 1;
  revision: number;
  entities: CanvasEntity[];
  links: CanvasSemanticLink[];
  updatedAt: string;
}

export interface CanvasHistoryInfo {
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
  revision: number;
}

export interface ReviewCriterion {
  key: ReviewCriterionKey;
  result: ReviewResult;
  note?: string;
}

export interface ReviewAnnotationInput {
  artifactId: string;
  type: ReviewAnnotationType;
  timeSeconds?: number;
  x: number;
  y: number;
  text: string;
}

export interface ReviewAnnotation extends ReviewAnnotationInput {
  id: string;
  createdBy: "user" | "codex";
  createdAt: string;
}

export interface SubmitReviewInput {
  itemId: string;
  reviewType: "image" | "video";
  artifactIds: string[];
  expectedScanId: string;
  expectedArtifactHashes: Record<string, string>;
  expectedRequirementId?: string;
  visualConstraintAttestations?: FusionVisualReviewRuleAttestation[];
  decision: ReviewDecision;
  criteria: ReviewCriterion[];
  annotations?: ReviewAnnotationInput[];
  note?: string;
}

export interface FusionVisualReviewRuleSnapshot {
  id: string;
  code: string;
  enforcement: "human-visual-final" | "deterministic-and-human-visual";
  instruction: string;
  evidenceAssetIds: string[];
}

export interface FusionVisualWarningSnapshot {
  code: string;
  severity: "warning" | "blocker";
  detection: "human-visual" | "deterministic-input-and-human-visual";
  message: string;
  evidenceAssetIds: string[];
}

export interface FusionVisualReviewRuleAttestation {
  panelId: string;
  constraintId: string;
  reviewRulesFingerprint: string;
  ruleId: string;
  result: "pass" | "fail";
  note?: string;
}

export interface ReviewArtifactEvidence {
  artifactId: string;
  path: string;
  rootSlot: string;
  relativePath: string;
  kind: ArtifactKind;
  variant: ArtifactVariant;
  size: number;
  sha256: string;
  fusionStoryboardPanel?: FusionStoryboardPanelArtifactBinding;
}

export interface FusionStoryboardReviewArtifactRequirement {
  artifactId: string;
  path: string;
  sha256: string;
}

export interface FusionStoryboardReviewPanelRequirement {
  panelId: string;
  panelIndex: number;
  panelCount: number;
  frameRole: "start" | "middle" | "end";
  generationJobId?: string;
  publicationReceiptId?: string;
  panelReferenceEvidenceVersion?: 1;
  panelReferenceResolutionId?: string;
  panelReferenceResolutionFingerprint?: string;
  panelVisualConstraintEvidenceVersion?: 1;
  panelVisualConstraintId?: string;
  panelVisualConstraintFingerprint?: string;
  panelVisualModelFingerprint?: string;
  panelVisualReviewRulesFingerprint?: string;
  visualReviewRules?: FusionVisualReviewRuleSnapshot[];
  visualWarnings?: FusionVisualWarningSnapshot[];
  referenceBoard?: {
    path: string;
    sha256: string;
    promptSha256: string;
    sourceAssets: Array<{
      assetId: string;
      path: string;
      sha256: string;
      coveredAssetIds?: string[];
      derivedReferenceAssetId?: string;
      reviewId?: string;
    }>;
  };
  raw?: FusionStoryboardReviewArtifactRequirement;
  labeled?: FusionStoryboardReviewArtifactRequirement;
  issues: string[];
}

export interface FusionStoryboardReviewRequirement {
  schemaVersion: 1;
  kind: "fusion-storyboard-grid-images";
  id: string;
  itemId: string;
  reviewType: "image";
  contractId: string;
  sourceFingerprint: string;
  productionFingerprint: string;
  panelCount: number;
  complete: boolean;
  artifactIds: string[];
  artifactHashes: Record<string, string>;
  panels: FusionStoryboardReviewPanelRequirement[];
  issues: string[];
}

export interface ReviewRecord {
  id: string;
  itemId: string;
  reviewType: "image" | "video";
  artifactIds: string[];
  sourceScanId?: string;
  artifactEvidence?: ReviewArtifactEvidence[];
  requirementId?: string;
  requirement?: FusionStoryboardReviewRequirement;
  visualConstraintAttestations?: FusionVisualReviewRuleAttestation[];
  migratedFromReviewId?: string;
  decision: ReviewDecision;
  criteria: ReviewCriterion[];
  annotations?: ReviewAnnotation[];
  note?: string;
  reviewer: "user" | "codex";
  resultingStatus: WorkItemStatus;
  createdAt: string;
}

export interface ReviewStore {
  schemaVersion: 1;
  records: ReviewRecord[];
}

export interface ReviewQueueEntry {
  item: WorkItem;
  reviewType: "image" | "video";
  artifacts: Artifact[];
  reviewSnapshot: {
    scanId: string;
    artifactHashes: Record<string, string>;
  };
  latestReview?: ReviewRecord;
  reviewRequirement?: FusionStoryboardReviewRequirement;
}

export interface FusionStoryboardGridSelection {
  contractId: string;
  sourceFingerprint: string;
  productionFingerprint: string;
  sourceStoryboardRevision: number;
  panelCount: number;
  selectedAt: string;
  selectedBy: "build" | "migration" | "user";
}

export interface FusionStoryboardGridSelectionStore {
  schemaVersion: 1;
  revision: number;
  items: Record<string, FusionStoryboardGridSelection>;
  updatedAt: string;
}

export interface ProjectEvent {
  id: string;
  type: string;
  at: string;
  actor: "user" | "codex" | "scanner" | "app";
  itemId?: string;
  taskId?: string;
  requestId?: string;
  idempotencyKey?: string;
  command?: string;
  data?: Record<string, unknown>;
}

export interface ScriptDocument {
  id: string;
  itemId: string;
  itemType: "unit" | "shot";
  parentId?: string;
  title: string;
  episode?: number;
  unit?: number;
  shot?: string;
  path: string;
  kind: "info" | "prompt";
  modifiedAt: string;
  size: number;
  excerpt: string;
  relatedAssetIds: string[];
}

export type GenerationKind = "image" | "video";
export type GenerationAdapterType = "folder-bridge" | "http-json" | "comfyui-local" | "codex-browser" | "codex-subagent-imagegen" | "mock";
export type GenerationReferenceRole = "character" | "costume" | "prop" | "scene" | "style" | "reference_board" | "first_frame" | "last_frame" | "source_video" | "mask";
export type GenerationReferenceMode = "text" | "first_frame" | "last_frame" | "first_last_frame" | "multi_image" | "video_reference";

export interface GenerationReference {
  path: string;
  role: GenerationReferenceRole;
  order: number;
  itemId?: string;
  artifactId?: string;
  hardLockId?: string;
  sha256?: string;
}

export interface GenerationProviderCapabilities {
  referenceModes: GenerationReferenceMode[];
  maxReferenceImages: number;
  maxReferenceVideos: number;
  supportedDurations: number[];
  supportedAspectRatios: string[];
  supportedResolutions: string[];
  models: string[];
  maxConcurrency: number;
  supportsCancel: boolean;
}

export type GenerationWorkflowFormat = "generic-json" | "comfyui-api" | "browser-recipe";
export type GenerationWorkflowJsonValue = string | number | boolean | null | GenerationWorkflowJsonValue[] | { [key: string]: GenerationWorkflowJsonValue };

export interface GenerationWorkflowEnvironment {
  engine?: string;
  engineVersion?: string;
  platform?: string;
  device?: string;
  models?: Array<{ name: string; version?: string; sha256?: string; nodeId?: string }>;
  customNodes?: Array<{ name: string; version?: string; commit?: string }>;
  notes?: string[];
}

export interface ComfyUiWorkflowPromptBinding {
  nodeId: string;
  inputName: string;
}

export interface ComfyUiWorkflowBinding {
  promptInputs: ComfyUiWorkflowPromptBinding[];
  outputNodeId: string;
  outputIndex: number;
}

export interface GenerationWorkflowDefinition {
  schemaVersion: 1;
  name: string;
  version: string;
  format: GenerationWorkflowFormat;
  definition: { [key: string]: GenerationWorkflowJsonValue };
  environment?: GenerationWorkflowEnvironment;
  comfyUi?: ComfyUiWorkflowBinding;
}

export type GenerationJobStatus =
  | "queued"
  | "submitting"
  | "submission_unknown"
  | "waiting_external"
  | "waiting_remote"
  | "generating"
  | "generation_unknown"
  | "candidate_generated"
  | "visual_rejected"
  | "succeeded"
  | "failed"
  | "cancelled";

export type GenerationRemoteObservationState = "pending" | "succeeded" | "confirmed_failed" | "retryable_or_unknown";

export type GenerationRemoteObservationStage = "submit" | "poll" | "download" | "validation" | "publish";

export interface GenerationRemoteObservation {
  state: GenerationRemoteObservationState;
  stage: GenerationRemoteObservationStage;
  observedAt: string;
  observedStatus?: string;
  httpStatus?: number;
  message: string;
  retryCount: number;
  nextAction: "poll_same_task" | "retry_same_task" | "inspect_remote_task" | "inspect_publication" | "none";
}

export interface GenerationSubmissionIntent {
  clientJobId: string;
  attempt: number;
  createdAt: string;
}

export type HttpGenerationSubmissionReconciliationMethod =
  | "provider_task_list"
  | "client_job_id_search"
  | "provider_idempotency_lookup"
  | "provider_request_log"
  | "provider_support";

export interface HttpGenerationSubmissionReconciliation {
  method: HttpGenerationSubmissionReconciliationMethod;
  result: "found" | "not_found";
  clientJobId: string;
  attempt: number;
  evidenceReference: string;
  note: string;
  externalTaskId?: string;
  confirmNoRemoteResult?: true;
  checkedAt: string;
}

export type HttpGenerationSubmissionReconciliationInput =
  | {
      method: HttpGenerationSubmissionReconciliationMethod;
      result: "found";
      externalTaskId: string;
      evidenceReference: string;
      note: string;
    }
  | {
      method: HttpGenerationSubmissionReconciliationMethod;
      result: "not_found";
      confirmNoRemoteResult: true;
      evidenceReference: string;
      note: string;
    };

export interface HttpGenerationSubmissionCheckpoint {
  revision: number;
  stage: "submission_unknown" | "reconciled_found" | "reconciled_not_found";
  updatedAt: string;
  submissionIntent: GenerationSubmissionIntent;
  reconciliation?: HttpGenerationSubmissionReconciliation;
}

export interface ComfyUiPreflightEvidence {
  checkedAt: string;
  observedOrigin: string;
  comfyUiVersion?: string;
  systemStatsSha256: string;
  featuresSha256: string;
  nodeDefinitions: Array<{ classType: string; sha256: string }>;
}

export interface ComfyUiOutputIdentity {
  promptId: string;
  nodeId: string;
  index: number;
  filename: string;
  subfolder: string;
  type: "output";
  historySha256: string;
}

export interface ComfyUiHistoryEvidence {
  generationJobId: string;
  promptId: string;
  clientId: string;
  clientJobId: string;
  attempt: number;
  workflowHash: string;
  submittedWorkflowHash: string;
  outputNodeId: string;
  outputIndex: number;
  historySha256: string;
  eventName: "execution_success" | "execution_error" | "execution_interrupted";
  observedAt: string;
}

export interface ComfyUiCancellationObservation {
  state: "absent" | "pending" | "running" | "history_succeeded" | "history_failed" | "history_interrupted";
  observedAt: string;
  historySha256?: string;
  eventName?: ComfyUiHistoryEvidence["eventName"];
}

export interface ComfyUiCancellationEvidence {
  requestedAt: string;
  promptId: string;
  preObservedState: "pending" | "running" | "unknown";
  endpoint: "api_jobs_cancel" | "history_observation";
  attempt: number;
  responseReceivedAt?: string;
  httpStatus?: number;
  responseSha256?: string;
  outcome: "unknown" | "not_acted" | "acted";
  serverActed?: boolean;
  observations: ComfyUiCancellationObservation[];
  confirmation?: {
    kind: "history_interrupted" | "pending_deleted";
    confirmedAt: string;
    historySha256?: string;
    eventName?: "execution_interrupted";
    stableAbsentCount?: number;
  };
}

export interface ComfyUiGenerationCheckpoint {
  schemaVersion: 1;
  revision: number;
  stage: "prepared" | "posting" | "submission_unknown" | "queued" | "running" | "history_succeeded" | "history_failed" | "downloading" | "verified" | "cancel_requested" | "cancelled";
  updatedAt: string;
  clientId: string;
  promptId: string;
  workflowHash: string;
  submittedWorkflowHash: string;
  requestPath: string;
  outputNodeId: string;
  outputIndex: number;
  postAttemptedAt?: string;
  queueNumber?: number;
  preflight?: ComfyUiPreflightEvidence;
  history?: ComfyUiHistoryEvidence;
  output?: ComfyUiOutputIdentity;
  cancellation?: ComfyUiCancellationEvidence;
}

export interface ReconcileHttpGenerationSubmissionInput {
  expectedRevision: number;
  reconciliation: HttpGenerationSubmissionReconciliationInput;
}

export interface HttpGenerationSubmissionReconciliationResult {
  schemaVersion: 1;
  applied: boolean;
  outcome: "found" | "not_found" | "publication_registered" | "publication_failed" | "publication_cancelled" | "publication_conflict";
  jobId: string;
  itemId: string;
  providerId: string;
  status: GenerationJobStatus;
  clientJobId: string;
  externalTaskId?: string;
  remoteAcceptedAt?: string;
  remoteObservation?: GenerationRemoteObservation;
  httpSubmissionCheckpoint: HttpGenerationSubmissionCheckpoint;
  publicationIntentId?: string;
  publicationStatus?: "reserved" | "registered" | "cancelled" | "failed";
  updatedAt: string;
}

export interface GenerationProvider {
  id: string;
  name: string;
  adapter: GenerationAdapterType;
  kinds: GenerationKind[];
  enabled: boolean;
  model?: string;
  endpoint?: string;
  pollEndpoint?: string;
  cancelEndpoint?: string;
  cancelMethod?: "POST" | "DELETE";
  apiKeyEnv?: string;
  taskIdPath?: string;
  statusPath?: string;
  resultUrlPath?: string;
  successValues?: string[];
  failureValues?: string[];
  siteUrl?: string;
  browserInstructions?: string;
  /**
   * `codex-subagent-imagegen` 执行面向每个独立图片代理冻结的附加约束。
   * 这里只保存制作规则，不保存凭据、图片二进制或聊天输出。
   */
  subagentInstructions?: string;
  /**
   * 网页任务实际由哪一类浏览器执行。Core 只校验身份与版本，
   * 不假设 Chrome、Codex 侧边浏览器或其他具体实现。
   */
  executionSurface?: BrowserExecutionSurfaceIdentity;
  allowPrivateNetwork?: boolean;
  allowedResultHosts?: string[];
  sendLocalPaths?: boolean;
  capabilities?: GenerationProviderCapabilities;
  workflow?: GenerationWorkflowDefinition;
  workflowHash?: string;
  outputRoot?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationSettings {
  schemaVersion: 1;
  revision: number;
  providers: GenerationProvider[];
  defaultImageProviderId?: string;
  defaultVideoProviderId?: string;
  concurrency: number;
  updatedAt: string;
}

export const BROWSER_PREFLIGHT_BLOCKER_CODES = [
  "login_required",
  "page_not_ready",
  "generation_mode_mismatch",
  "insufficient_credits",
  "paid_action_unauthorized",
  "provider_error",
  "other",
] as const;

export type BrowserPreflightBlockerCode = (typeof BROWSER_PREFLIGHT_BLOCKER_CODES)[number];

export interface BrowserExecutionSurfaceIdentity {
  id: string;
  version: string;
}

export interface BrowserObservedGenerationState {
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  imageCount?: number;
  generateEnabled?: boolean;
  creditMessage?: string;
}

export interface BrowserPreflightEvidence {
  /** 必须与冻结网页计划的执行面身份一致；旧未声明计划可缺省。 */
  executionSurface?: BrowserExecutionSurfaceIdentity;
  observedHost: string;
  loginVerified: boolean;
  pageReady: boolean;
  generationModeVerified: boolean;
  balanceChecked: boolean;
  paidActionRequired: boolean;
  paidActionAuthorized: boolean;
  authorizationReference?: string;
  blockers?: BrowserPreflightBlockerCode[];
  observedGeneration?: BrowserObservedGenerationState;
  checkedAt: string;
}

export type BrowserPreflightInput = Omit<BrowserPreflightEvidence, "checkedAt">;

export interface BrowserUploadEvidenceEntry {
  path: string;
  role: GenerationReferenceRole;
  order: number;
  slot: string;
  sha256: string;
}

export interface BrowserUploadEvidence {
  files: BrowserUploadEvidenceEntry[];
  /**
   * 网页上传区当前可见的参考缩略图数量。text-only 任务必须显式为 0，
   * 防止复用旧会话时把残留参考图静默带入生成。
   */
  observedReferenceThumbnailCount?: number;
  /** 冻结网页计划要求的文件数；text-only 任务为 0。 */
  expectedFileCount: number;
  /** false 表示已经显式核验为 text-only/零上传，不代表跳过 uploaded 检查点。 */
  uploadRequired: boolean;
  confirmedAt: string;
}

export interface BrowserUploadInput {
  files: Array<Omit<BrowserUploadEvidenceEntry, "sha256">>;
  /** text-only 任务必填且必须为 0；旧的非 text-only 调用保持兼容。 */
  observedReferenceThumbnailCount?: number;
}

export interface BrowserSubmissionIntent {
  clientJobId: string;
  attempt: number;
  createdAt: string;
}

export interface BrowserSubmissionReconciliation {
  method: "provider_task_list" | "client_job_id_search" | "browser_history";
  result: "found" | "not_found";
  note: string;
  externalTaskId?: string;
  checkedAt: string;
}

export type BrowserSubmissionReconciliationInput = Omit<BrowserSubmissionReconciliation, "checkedAt">;

export type BrowserGenerationUpdateStatus = "refresh_plan" | "preflight_blocked" | "preflight" | "uploaded" | "submit_intent" | "submitted" | "processing" | "downloaded" | "failed";

export interface BrowserGenerationCheckpoint {
  revision: number;
  stage: "plan_ready" | "preflight_blocked" | "preflight" | "uploaded" | "submission_unknown" | "submitted" | "processing" | "downloaded" | "verified" | "failed" | "cancelled";
  updatedAt: string;
  externalTaskId?: string;
  isolatedPath?: string;
  note?: string;
  executionSurface?: BrowserExecutionSurfaceIdentity;
  preflightEvidence?: BrowserPreflightEvidence;
  uploadEvidence?: BrowserUploadEvidence;
  submissionIntent?: BrowserSubmissionIntent;
  submissionReconciliation?: BrowserSubmissionReconciliation;
  panelVisualConstraintId?: string;
  panelVisualConstraintFingerprint?: string;
  panelVisualModelFingerprint?: string;
  panelVisualReviewRulesFingerprint?: string;
}

export interface SubagentImageGenerationLease {
  leaseId: string;
  agentTaskName: string;
  claimedAt: string;
  /** v2 租约拥有者；旧 v1 租约缺失时必须按未知调用处理，不能猜测接管。 */
  owner?: string;
  /** 最近一次成功续租时间。 */
  heartbeatAt?: string;
  /** 租约硬到期时间。 */
  leaseUntil?: string;
  /** 每次领取或续租的 TTL。 */
  leaseSeconds?: number;
  /** 单调 fencing 代数，迟到写入必须与当前代数一致。 */
  fence?: number;
  /** 仅安全接管时记录被替代的过期租约。 */
  takeoverOf?: {
    leaseId: string;
    owner?: string;
    agentTaskName: string;
    leaseUntil?: string;
  };
  oneImageOnly: true;
  promptSha256: string;
  parametersSha256: string;
  referencesSha256: string;
  executionSnapshotHash: string;
  panelVisualConstraintId?: string;
  panelVisualConstraintFingerprint?: string;
  panelVisualModelFingerprint?: string;
  panelVisualReviewRulesFingerprint?: string;
}

export interface SubagentImageGenerationCallIntent {
  schemaVersion: 1;
  callId: string;
  runId: string;
  leaseId: string;
  owner: string;
  agentTaskName: string;
  attempt: number;
  maxCalls: 1;
  promptSha256: string;
  parametersSha256: string;
  referencesSha256: string;
  executionSnapshotHash: string;
  panelVisualConstraintId?: string;
  panelVisualConstraintFingerprint?: string;
  panelVisualModelFingerprint?: string;
  panelVisualReviewRulesFingerprint?: string;
  createdAt: string;
}

export interface SubagentImageGenerationOutputEvidence {
  leaseId: string;
  agentTaskName: string;
  agentRunId: string;
  /** v2 调用回执字段；旧 v1 output 缺失时不能用于接管归因。 */
  callId?: string;
  owner?: string;
  runId?: string;
  sourcePath: string;
  sourceSha256: string;
  isolatedPath: string;
  isolatedSha256: string;
  bytes: number;
  magic: string;
  isolatedCompanionPath?: string;
  isolatedCompanionSha256?: string;
  companionBytes?: number;
  companionMagic?: string;
  recordedAt: string;
}

export interface SubagentImageGenerationUnknownEvidence {
  code: "legacy_leased_without_call_receipt" | "call_intent_without_receipt" | "lease_released_after_call" | "execution_lost_after_call";
  observedAt: string;
  note: string;
  previousStage: string;
  leaseId?: string;
  owner?: string;
  callId?: string;
  runId?: string;
  evidenceReference?: string;
}

export interface SubagentImageGenerationReconciliation {
  result: "not_invoked" | "candidate_found";
  evidenceReference: string;
  note: string;
  checkedAt: string;
  candidatePath?: string;
  candidateSha256?: string;
}

export interface SubagentImageGenerationRelease {
  leaseId: string;
  owner: string;
  fence?: number;
  releasedAt: string;
  reason?: string;
  outcome: "plan_ready" | "generation_unknown";
}

export interface SubagentImageGenerationVisualReview {
  decision: "accepted" | "rejected";
  reviewedAt: string;
  reviewer: string;
  note: string;
  candidateSha256: string;
}

export interface GenerationPublicationBundleCheckpoint {
  bundleId: string;
  stage: "reserved" | "publishing" | "registered";
  rawIntentId: string;
  labeledIntentId: string;
  rawReceiptId?: string;
  labeledReceiptId?: string;
  updatedAt: string;
}

export interface SubagentImageGenerationCheckpoint {
  schemaVersion: 1 | 2;
  revision: number;
  stage:
    | "plan_ready"
    | "leased"
    | "generating"
    | "generation_unknown"
    | "candidate_generated"
    | "generated"
    | "visual_rejected"
    | "verified"
    | "failed"
    | "cancelled";
  updatedAt: string;
  remoteIdentityRequired: false;
  oneImagePerAgent: true;
  panelVisualConstraintId?: string;
  panelVisualConstraintFingerprint?: string;
  panelVisualModelFingerprint?: string;
  panelVisualReviewRulesFingerprint?: string;
  migratedFrom?: {
    providerId: string;
    adapter: GenerationAdapterType;
    executionSnapshotHash?: string;
    browserCheckpointRevision?: number;
    browserCheckpointStage?: BrowserGenerationCheckpoint["stage"];
  };
  lease?: SubagentImageGenerationLease;
  callIntent?: SubagentImageGenerationCallIntent;
  output?: SubagentImageGenerationOutputEvidence;
  unknown?: SubagentImageGenerationUnknownEvidence;
  reconciliation?: SubagentImageGenerationReconciliation;
  lastRelease?: SubagentImageGenerationRelease;
  visualReview?: SubagentImageGenerationVisualReview;
  publicationBundle?: GenerationPublicationBundleCheckpoint;
  note?: string;
}

export type SubagentImageGenerationUpdateStatus =
  | "migrate_plan"
  | "migrate_execution_state"
  | "claim"
  | "heartbeat"
  | "takeover"
  | "release"
  | "start_call"
  | "generated"
  | "visual_accept"
  | "visual_rejected"
  | "reconcile_unknown"
  | "failed";

export interface GenerationJob {
  schemaVersion: 1;
  id: string;
  projectId: string;
  itemId: string;
  taskId?: string;
  providerId: string;
  kind: GenerationKind;
  purpose?: "standard" | "asset" | "fusion_frame" | "fusion_storyboard_panel" | "video_continuation" | "timeline_continuation";
  /** P2 新建逐格任务必须为 1；只有首次 P2 物化冻结的历史任务白名单可缺省。 */
  panelReferenceEvidenceVersion?: 1;
  /** P3 新建逐格任务必须冻结当前结构化视觉约束；历史任务只能通过 P3 store 旁路证明。 */
  panelVisualConstraintEvidenceVersion?: 1;
  /** 第三季融合资产的持久化六图一致性批次；旧任务可由批次侧车确定性接管。 */
  assetConsistencyBatchId?: string;
  /** 冻结资产定义身份，防止生图任务与后来漂移的资产目录静默混用。 */
  fusionAssetContract?: {
    assetId: string;
    contractId: string;
    sourceSectionSha256: string;
  };
  continuationId?: string;
  continuationFirstFrameArtifactId?: string;
  existingProductionBaselineId?: string;
  existingProductionBaselineDigest?: string;
  status: GenerationJobStatus;
  prompt: string;
  referencePaths: string[];
  references?: GenerationReference[];
  fusionReferenceBoard?: {
    path: string;
    metadataPath: string;
    sha256: string;
    promptSha256: string;
    sourceAssetIds: string[];
    panelReferenceResolutionId?: string;
    panelReferenceResolutionFingerprint?: string;
    panelVisualConstraintId?: string;
    panelVisualConstraintFingerprint?: string;
    panelVisualModelFingerprint?: string;
    panelVisualReviewRulesFingerprint?: string;
  };
  fusionStoryboardPanel?: {
    contractId: string;
    sourceFingerprint: string;
    panelId: string;
    panelIndex: number;
    panelCount: number;
    frameRole: "start" | "middle" | "end";
    startSeconds: number;
    endSeconds: number;
    panelReferenceResolutionId?: string;
    panelReferenceResolutionFingerprint?: string;
    panelVisualConstraintId?: string;
    panelVisualConstraintFingerprint?: string;
    panelVisualModelFingerprint?: string;
    panelVisualReviewRulesFingerprint?: string;
  };
  storyboardRevision: number;
  storyboardRows: StoryboardProductionContract[];
  model?: string;
  parameters?: { durationSeconds?: number; aspectRatio?: string; resolution?: string; quality?: string; imageCount?: number; mode?: GenerationReferenceMode };
  executionSnapshot?: GenerationExecutionSnapshot;
  expectedOutputPath: string;
  expectedCompanionPath?: string;
  publicationBundleId?: string;
  publicationIntentId?: string;
  publicationReservationToken?: string;
  publicationReceiptId?: string;
  companionPublicationIntentId?: string;
  companionPublicationReservationToken?: string;
  companionPublicationReceiptId?: string;
  companionPath?: string;
  requestPath?: string;
  resultPath?: string;
  clientJobId?: string;
  submissionIntent?: GenerationSubmissionIntent;
  externalTaskId?: string;
  remoteResultUrl?: string;
  remoteAcceptedAt?: string;
  remoteObservation?: GenerationRemoteObservation;
  httpSubmissionCheckpoint?: HttpGenerationSubmissionCheckpoint;
  comfyUiCheckpoint?: ComfyUiGenerationCheckpoint;
  browserState?: "plan_ready" | "preflight_blocked" | "preflight" | "uploaded" | "submission_unknown" | "submitted" | "processing" | "downloaded" | "verified";
  browserCheckpoint?: BrowserGenerationCheckpoint;
  subagentCheckpoint?: SubagentImageGenerationCheckpoint;
  resultSha256?: string;
  resultMagic?: string;
  isolatedDownloadPath?: string;
  partialDownloadPath?: string;
  downloadBytes?: number;
  pollAttempts?: number;
  downloadAttempts?: number;
  lastPolledAt?: string;
  error?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationExecutionSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  provider: GenerationProvider;
  workflowHash?: string;
  promptSha256: string;
  parametersSha256: string;
  storyboardRowsSha256: string;
  referencesSha256: string;
  panelVisualConstraintId?: string;
  panelVisualConstraintFingerprint?: string;
  panelVisualModelFingerprint?: string;
  panelVisualReviewRulesFingerprint?: string;
  snapshotHash: string;
}

export interface BrowserGenerationPlan {
  schemaVersion: 1;
  jobId: string;
  providerId: string;
  providerName: string;
  kind: GenerationKind;
  siteUrl: string;
  /** 写入 browser request 和任务执行快照的冻结执行面。 */
  executionSurface?: BrowserExecutionSurfaceIdentity;
  /** getBrowserGenerationPlan 按当前供应商配置计算，不是远端证据。 */
  configuredExecutionSurface?: BrowserExecutionSurfaceIdentity;
  executionSurfaceStatus?: "current" | "legacy_unidentified" | "provider_mismatch";
  requiresExistingLogin: true;
  prompt: string;
  promptSha256?: string;
  instructionsSha256?: string;
  requestPlanFingerprint?: string;
  panelVisualConstraintId?: string;
  panelVisualConstraintFingerprint?: string;
  panelVisualModelFingerprint?: string;
  panelVisualReviewRulesFingerprint?: string;
  allowedUploadPaths: string[];
  allowedUploads: GenerationReference[];
  capabilities: GenerationProviderCapabilities;
  parameters: { model?: string; durationSeconds?: number; aspectRatio?: string; resolution?: string; quality?: string; imageCount?: number; mode?: GenerationReferenceMode };
  executionSnapshotHash?: string;
  workflowHash?: string;
  workflow?: GenerationWorkflowDefinition;
  isolatedDownloadDirectory: string;
  expectedOutputPath: string;
  expectedCompanionPath?: string;
  instructions?: string;
  steps: Array<{ id: string; action: string; checkpoint: string }>;
  safety: {
    uploadOnlyAllowlistedPaths: true;
    doNotExposeSecrets: true;
    doNotOverwriteExistingFiles: true;
    verifyBeforeSubmit: true;
    requireSequentialCheckpoints: true;
    requireStructuredPreflightEvidence: true;
    requirePaidActionAuthorization: true;
    persistIntentBeforeSubmit: true;
    recordExternalTaskId: true;
  };
  currentCheckpoint?: GenerationJob["browserCheckpoint"];
  createdAt: string;
}

export interface SubagentImageGenerationPlan {
  schemaVersion: 1;
  jobId: string;
  providerId: string;
  providerName: string;
  kind: "image";
  model?: string;
  prompt: string;
  promptSha256: string;
  instructionsSha256?: string;
  requestPlanFingerprint?: string;
  panelVisualConstraintId?: string;
  panelVisualConstraintFingerprint?: string;
  panelVisualModelFingerprint?: string;
  panelVisualReviewRulesFingerprint?: string;
  parameters: NonNullable<GenerationJob["parameters"]>;
  parametersSha256: string;
  allowedReferences: GenerationReference[];
  referencesSha256: string;
  executionSnapshotHash: string;
  publicationIntentId: string;
  publicationBundleId?: string;
  companionPublicationIntentId?: string;
  isolatedOutputDirectory: string;
  expectedOutputPath: string;
  expectedCompanionPath?: string;
  subagentInstructions?: string;
  contract: {
    exactlyOneImage: true;
    oneAgentPerImage: true;
    sequentialOnly: true;
    remoteIdentityRequired: false;
    copyThroughIsolation: true;
    persistCallIntentBeforeModel: true;
    recordCandidateBeforePublication: true;
    rawLabeledBundleRequired: true;
    mainAgentVisualReviewRequired: true;
    publicationAndMechanicalValidationRequired: true;
  };
  currentCheckpoint?: SubagentImageGenerationCheckpoint;
}

export interface ShotTiming {
  shotId: string;
  order: number;
  durationSeconds: number;
  note?: string;
}

export interface UnitTimelineOverride {
  shots: ShotTiming[];
  updatedAt: string;
}

export interface TimelineOverrides {
  schemaVersion: 1;
  units: Record<string, UnitTimelineOverride>;
}

export interface UnitTimeline {
  unitId: string;
  title: string;
  episode: number;
  unit: number;
  shots: Array<{ item: WorkItem; timing: ShotTiming }>;
  totalDurationSeconds: number;
  valid: boolean;
  issues: string[];
  updatedAt?: string;
}

export type EditTrackKind = "visual" | "audio" | "subtitle";
export type EditClipKind = "video" | "image" | "audio" | "subtitle" | "timeline";
export type EditFilterKind = "none" | "grayscale" | "sepia" | "warm" | "cool" | "vivid" | "contrast" | "blur";

export interface EditSourceAvailableRange {
  startFrame: number;
  durationFrames: number;
}

export interface EditSmpteDissolveTransition {
  contract: "aicanvas.otio-transition.v1";
  kind: "smpte_dissolve";
  targetClipId: string;
  inOffsetFrames: number;
  outOffsetFrames: number;
}

export interface EditRationalFrame {
  numerator: number;
  denominator: number;
}

export interface EditNestedTimelineRef {
  contract: "aicanvas.nested-timeline.v1";
  ownerProjectId: string;
  childEditProjectId: string;
  childEditProjectRevision: number;
  childSnapshotSha256: string;
  childTimebase: { rateNumerator: number; rateDenominator: number };
  childCanvas: { width: number; height: number };
  childDurationFrames: number;
  sourceRange: { startFrame: number; durationFrames: number };
  sourceOffset: EditRationalFrame;
  sourceStep: EditRationalFrame;
  mappedDurationFrames: number;
}

export type EditKeyframeEasing = "linear" | "ease_in" | "ease_out" | "ease_in_out" | "hold" | "cubic_bezier";
export type EditCubicBezierMode = "unit" | "derived_monotone";
export type EditCubicBezierSourceEasing = Exclude<EditKeyframeEasing, "hold">;

export interface EditKeyframeTransform {
  positionX: number;
  positionY: number;
  scale: number;
  rotation: number;
}

export interface EditKeyframeSourceTransform {
  start: EditKeyframeTransform;
  end: EditKeyframeTransform;
}

export interface EditCubicBezierSourceWindow {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  sourceEasing: EditCubicBezierSourceEasing;
  startX: number;
  endX: number;
  startFrame?: number;
  endFrame?: number;
  totalFrames?: number;
}

export interface EditCubicBezier {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mode?: EditCubicBezierMode;
  sourceWindow?: EditCubicBezierSourceWindow;
}

export interface EditKeyframe {
  id: string;
  timeSeconds: number;
  frame?: number;
  easing?: EditKeyframeEasing;
  bezier?: EditCubicBezier;
  sourceTransform?: EditKeyframeSourceTransform;
  positionX: number;
  positionY: number;
  scale: number;
  rotation: number;
}

export interface EditClip {
  id: string;
  trackId: string;
  kind: EditClipKind;
  name: string;
  sourcePath?: string;
  artifactId?: string;
  itemId?: string;
  sourceAvailableRange?: EditSourceAvailableRange;
  nestedTimeline?: EditNestedTimelineRef;
  startSeconds: number;
  durationSeconds: number;
  trimStartSeconds: number;
  startFrame?: number;
  durationFrames?: number;
  trimStartFrame?: number;
  playbackRate: number;
  volume: number;
  opacity: number;
  muted: boolean;
  positionX?: number;
  positionY?: number;
  scale?: number;
  rotation?: number;
  filter?: EditFilterKind;
  filterIntensity?: number;
  keyframes?: EditKeyframe[];
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
  transitionOut?: "cut" | "fade" | "smpte_dissolve";
  transitionDurationSeconds?: number;
  transition?: EditSmpteDissolveTransition;
  text?: string;
  fontSize?: number;
  fontColor?: string;
  subtitleBackground?: string;
  note?: string;
}

export interface EditTrack {
  id: string;
  kind: EditTrackKind;
  name: string;
  order: number;
  locked: boolean;
  muted: boolean;
  hidden: boolean;
  clips: EditClip[];
}

export interface EditProject {
  schemaVersion: 1;
  id: string;
  projectId: string;
  name: string;
  episode?: number;
  width: number;
  height: number;
  fps: number;
  timebase?: { rateNumerator: number; rateDenominator: number };
  backgroundColor: string;
  tracks: EditTrack[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface EditorSessionState {
  schemaVersion: 1;
  sessionId: string;
  cleanShutdown: boolean;
  recoveryPending: boolean;
  lastProjectId?: string;
  lastProjectRevision?: number;
  lastStableRevision?: number;
  incompleteRenderIds: string[];
  openedAt: string;
  closedAt?: string;
  updatedAt: string;
}

export interface EditorRecoveryInfo {
  projectId: string;
  projectName: string;
  latestRevision: number;
  stableRevision?: number;
  stableAvailable: boolean;
  interruptedAt: string;
  incompleteRenderIds: string[];
}

export interface EditorSessionOpenResult {
  state: EditorSessionState;
  recovery?: EditorRecoveryInfo;
}

export interface EditorSessionResolution {
  state: EditorSessionState;
  project: EditProject;
  choice: "stable" | "latest";
}

export interface EditMediaItem {
  id: string;
  artifactId: string;
  itemId: string;
  kind: "video" | "image" | "audio";
  name: string;
  path: string;
  thumbnailPath?: string;
  filmstripPath?: string;
  waveformPath?: string;
  proxyPath?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  authoritative: boolean;
  accepted: boolean;
  episode?: number;
  unit?: number;
}

export interface EditMediaPreview {
  artifactId: string;
  kind: "video" | "image" | "audio";
  thumbnailPath?: string;
  filmstripPath?: string;
  waveformPath?: string;
  proxyPath?: string;
  sourceModifiedAt: string;
  generatedAt: string;
}

export interface EditNestedTimelinePreview {
  schemaVersion: 1;
  clipId: string;
  path: string;
  width: number;
  height: number;
  durationFrames: number;
  trimStartFrame: number;
  trimStartSeconds: number;
  timebase: { rateNumerator: number; rateDenominator: number };
  childEditProjectId: string;
  childEditProjectRevision: number;
  childSnapshotSha256: string;
  dependencyManifestSha256: string;
  renderPlanSha256: string;
}

export type EditRenderStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface EditRenderDependencyRef {
  editProjectId: string;
  revision: number;
  snapshotSha256: string;
  depth: number;
}

export interface EditSourceClipRef {
  editProjectId: string;
  editProjectRevision: number;
  clipId: string;
}

export interface EditRenderJob {
  schemaVersion: 1;
  id: string;
  editProjectId: string;
  editProjectRevision?: number;
  dependencyManifestSha256?: string;
  renderPlanSha256?: string;
  renderPlanPath?: string;
  commandSha256?: string;
  dependencyRefs?: EditRenderDependencyRef[];
  status: EditRenderStatus;
  outputPath: string;
  commandPath?: string;
  logPath: string;
  progress: number;
  durationSeconds: number;
  pid?: number;
  processGroupId?: number;
  machineLeaseId?: string;
  stageTimeoutMs?: number;
  publicationIntentId?: string;
  publicationReservationToken?: string;
  publicationIntentRevision?: number;
  publicationReceiptId?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  cancelRequestedAt?: string;
}

export interface VideoEngineInfo {
  available: boolean;
  ffmpegPath?: string;
  ffprobePath?: string;
  ffmpegVersion?: string;
  issues: string[];
}

export interface LastFrameExtraction {
  itemId: string;
  sourceVideoPath: string;
  framePath: string;
  width: number;
  height: number;
  extractedAt: string;
  scanId: string;
}

export interface TimelineFrameExtraction {
  schemaVersion: 1;
  id: string;
  editProjectId: string;
  editProjectRevision: number;
  timeSeconds: number;
  framePath: string;
  width: number;
  height: number;
  sourceClipIds: string[];
  sourceArtifactIds: string[];
  sourceItemIds: string[];
  sourceClipRefs?: EditSourceClipRef[];
  dependencyManifestSha256?: string;
  renderPlanSha256?: string;
  dependencyRefs?: EditRenderDependencyRef[];
  registeredItemId?: string;
  registeredVariant?: "start" | "end";
  registeredArtifactId?: string;
  extractedAt: string;
  scanId?: string;
}

export interface VideoContinuationPack {
  schemaVersion: 1;
  id: string;
  revision: number;
  projectId: string;
  itemId: string;
  sourceType?: "video" | "timeline";
  sourceVideoPath?: string;
  editProjectId?: string;
  editProjectRevision?: number;
  dependencyManifestSha256?: string;
  renderPlanSha256?: string;
  timelineFrameId?: string;
  timelineTimeSeconds?: number;
  targetFirstFrameArtifactId?: string;
  generationJobId?: string;
  lastFramePath: string;
  prompt: string;
  referencePaths: string[];
  hardLocks: HardLock[];
  expectedOutputDirectory: string;
  acceptanceCriteria: string[];
  status: "ready" | "queued" | "preflight_blocked" | "preflight" | "uploaded" | "submit_intent" | "submission_unknown" | "submitted" | "processing" | "downloaded" | "completed" | "failed" | "cancelled";
  generationStatus?: GenerationJobStatus;
  browserCheckpoint?: BrowserGenerationCheckpoint;
  httpSubmissionCheckpoint?: HttpGenerationSubmissionCheckpoint;
  comfyUiCheckpoint?: ComfyUiGenerationCheckpoint;
  provider?: string;
  externalTaskId?: string;
  outputVideoPath?: string;
  error?: string;
  submittedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const PRODUCTION_WORKFLOW_STAGE_IDS = ["source", "chapters", "events", "skeleton", "adaptation", "episodes", "director", "visual_bible", "assets", "storyboard", "frames", "video", "edit", "review", "publish"] as const;
export type ProductionWorkflowStageId = (typeof PRODUCTION_WORKFLOW_STAGE_IDS)[number];
export type ProductionWorkflowStageStatus = "not_started" | "in_progress" | "review" | "blocked" | "completed";
export type ExistingProductionRecoveryTarget = "image" | "video_continuation";

export type ExistingProductionRecoveryContractInput = Omit<
  StoryboardProductionContract,
  "storyboardRowId" | "storyboardRowRevision" | "referencePaths" | "referenceArtifactIds"
> & {
  referencePaths?: string[];
  referenceArtifactIds?: string[];
};

export interface ExistingProductionRecoveryInput {
  itemIds: string[];
  allowedTargets: ExistingProductionRecoveryTarget[];
  contracts: ExistingProductionRecoveryContractInput[];
  note?: string;
}

export interface ExistingProductionRecoveryCommitInput extends ExistingProductionRecoveryInput {
  previewId: string;
  expectedWorkflowRevision: number;
}

export interface ExistingProductionRecoveryEvidenceFile {
  path: string;
  size: number;
  sha256: string;
  artifactId?: string;
}

export interface ExistingProductionRecoveryEvidenceItem {
  itemId: string;
  itemType: "unit" | "shot";
  infoPath: string;
  infoSize: number;
  infoSha256: string;
  referencePaths: string[];
  references: ExistingProductionRecoveryEvidenceFile[];
}

export interface ExistingProductionRecoveryEvidence {
  projectId: string;
  scanId: string;
  items: ExistingProductionRecoveryEvidenceItem[];
  fingerprint: string;
}

export interface ExistingProductionRecoveryPreview {
  schemaVersion: 1;
  ready: true;
  previewId: string;
  expectedWorkflowRevision: number;
  itemIds: string[];
  allowedTargets: ExistingProductionRecoveryTarget[];
  contracts: StoryboardProductionContract[];
  evidence: ExistingProductionRecoveryEvidence;
  warnings: string[];
  note?: string;
}

export interface ExistingProductionBaseline {
  schemaVersion: 1;
  id: string;
  digest: string;
  itemIds: string[];
  allowedTargets: ExistingProductionRecoveryTarget[];
  contracts: StoryboardProductionContract[];
  evidence: ExistingProductionRecoveryEvidence;
  note?: string;
  createdAt: string;
}

export interface ProductionStageEvidenceVerification {
  checkedAt: string;
  fingerprint: string;
  workflowRevision: number;
}

export interface ProductionStageEvidenceAudit {
  stageId: ProductionWorkflowStageId;
  ready: boolean;
  statusEvidenceValid: boolean;
  legacyUnverified: boolean;
  issues: string[];
  metrics: Record<string, number>;
  checkedAt: string;
  fingerprint: string;
}

export interface ProductionWorkflowEvidenceAudit {
  schemaVersion: 1;
  workflowRevision: number;
  valid: boolean;
  readyStageCount: number;
  completedStageCount: number;
  verifiedCompletedStageCount: number;
  stages: ProductionStageEvidenceAudit[];
  checkedAt: string;
}

export interface ProductionWorkflowEvidenceStageSummary {
  stageId: ProductionWorkflowStageId;
  name: string;
  status: ProductionWorkflowStageStatus;
  ready: boolean;
  statusEvidenceValid: boolean;
  legacyUnverified: boolean;
  issues: string[];
  evidencePaths: string[];
  itemIds: string[];
  nextActions: string[];
}

export interface ProductionWorkflowEvidenceSummary {
  schemaVersion: 1;
  workflowRevision: number;
  checkedAt: string;
  valid: boolean;
  repairRequired: boolean;
  counts: {
    ready: number;
    completed: number;
    verifiedCompleted: number;
    invalidCompleted: number;
    legacyUnverified: number;
  };
  blockers: ProductionWorkflowEvidenceStageSummary[];
  legacyUnverifiedStages: ProductionWorkflowEvidenceStageSummary[];
  nextStage?: ProductionWorkflowEvidenceStageSummary;
  nextRepair?: {
    stageId: ProductionWorkflowStageId;
    name: string;
    reason: "evidence_drift" | "legacy_unverified";
    mustRepairEvidenceFirst: boolean;
    issues: string[];
    evidencePaths: string[];
    itemIds: string[];
    executeCommand: {
      tool: "execute_command";
      requestIdHint: string;
      idempotencyKeyHint: string;
      request: {
        command: "update_workflow_stage";
        payload: {
          stageId: ProductionWorkflowStageId;
          status: "completed";
          note: string;
          expectedRevision: number;
        };
      };
    };
    afterSuccess: ["get_production_workflow", "doctor_project"];
  };
  suggestedCalls: string[];
}

export interface ProductionWorkflowStage {
  id: ProductionWorkflowStageId;
  name: string;
  status: ProductionWorkflowStageStatus;
  note?: string;
  evidencePaths: string[];
  itemIds: string[];
  inputRequirements: string[];
  outputRequirements: string[];
  acceptanceCriteria: string[];
  failurePaths: string[];
  nextActions: string[];
  evidenceVerification?: ProductionStageEvidenceVerification;
  updatedAt: string;
}

export interface ProductionWorkflow {
  schemaVersion: 1;
  revision: number;
  stages: ProductionWorkflowStage[];
  existingProductionBaselines?: ExistingProductionBaseline[];
  evidenceAudit?: ProductionWorkflowEvidenceAudit;
  updatedAt: string;
}

export interface ProductionWorkflowStageUpdateInput {
  stageId: ProductionWorkflowStageId;
  status: ProductionWorkflowStageStatus;
  note?: string;
  evidencePaths?: string[];
  itemIds?: string[];
  inputRequirements?: string[];
  outputRequirements?: string[];
  acceptanceCriteria?: string[];
  failurePaths?: string[];
  nextActions?: string[];
  expectedRevision: number;
}

export type CreativeBibleKind = "director" | "visual" | "character" | "world";
export interface CreativeBibleInputFields {
  kind: CreativeBibleKind;
  name: string;
  summary: string;
  rules?: string[];
  forbidden?: string[];
  referencePaths?: string[];
  tags?: string[];
}
export type CreativeBibleUpsertInput = RevisionedUpsertInput<CreativeBibleInputFields>;
export interface CreativeBible {
  schemaVersion: 1;
  id: string;
  kind: CreativeBibleKind;
  name: string;
  summary: string;
  rules: string[];
  forbidden: string[];
  referencePaths: string[];
  tags: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoryboardRow {
  id: string;
  itemId: string;
  shotItemId?: string;
  order: number;
  durationSeconds: number;
  shotSize: string;
  cameraMovement: string;
  cameraAngle?: string;
  lens?: string;
  composition?: string;
  staging?: string;
  action: string;
  expression?: string;
  emotion?: string;
  eyeline?: string;
  screenDirection?: string;
  axisSide?: string;
  dialogue?: string;
  narration?: string;
  ambience?: string;
  soundEffects?: string[];
  continuityBefore?: string;
  continuityAfter?: string;
  referenceNames?: string[];
  firstFramePrompt: string;
  endFramePrompt: string;
  videoPrompt: string;
  referencePaths: string[];
  referenceArtifactIds?: string[];
  upstreamFactRefs?: EntityRevisionRef[];
  upstreamBeatRefs?: EntityRevisionRef[];
  sourceSpans?: SourceSpan[];
  adaptationPlanId?: string;
  adaptationUnitId?: string;
  directorIntent?: string;
  emotionalIntent?: string;
  continuityNotes?: string[];
  status: "draft" | "confirmed" | "deprecated";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type StoryboardRowInputFields = Omit<StoryboardRow, "id" | "revision" | "createdAt" | "updatedAt">;

/**
 * 新建分镜时必须提交完整合同；修订已有分镜时允许只提交变化字段，
 * 但必须携带稳定 ID 与 expectedRevision，未提交字段由核心层保留。
 */
export type StoryboardRowUpsertInput = Partial<StoryboardRowInputFields> & { id?: string; expectedRevision?: number };

/** 已确认正式分镜向任务包和生成队列传递的不可变快照。 */
export interface StoryboardProductionContract {
  storyboardRowId: string;
  storyboardRowRevision: number;
  itemId: string;
  shotItemId?: string;
  order: number;
  durationSeconds: number;
  shotSize: string;
  cameraMovement: string;
  cameraAngle?: string;
  lens?: string;
  composition?: string;
  staging?: string;
  action: string;
  expression?: string;
  emotion?: string;
  eyeline?: string;
  screenDirection?: string;
  axisSide?: string;
  dialogue?: string;
  narration?: string;
  ambience?: string;
  soundEffects?: string[];
  continuityBefore?: string;
  continuityAfter?: string;
  referenceNames?: string[];
  firstFramePrompt: string;
  endFramePrompt: string;
  videoPrompt: string;
  referencePaths: string[];
  referenceArtifactIds: string[];
  upstreamFactRefs?: EntityRevisionRef[];
  upstreamBeatRefs?: EntityRevisionRef[];
  sourceSpans?: SourceSpan[];
  adaptationPlanId?: string;
  adaptationUnitId?: string;
  directorIntent?: string;
  emotionalIntent?: string;
  continuityNotes?: string[];
}

export interface StoryboardStore {
  schemaVersion: 1;
  revision: number;
  rows: StoryboardRow[];
  updatedAt: string;
}

export type AssetRelationKind = "derived_from" | "variant_of" | "reference_of";
export interface AssetRelationInputFields {
  kind: AssetRelationKind;
  parentArtifactId?: string;
  parentItemId?: string;
  childArtifactId?: string;
  childItemId?: string;
  operation?: string;
  note?: string;
}
export type AssetRelationUpsertInput = RevisionedUpsertInput<AssetRelationInputFields>;
export interface AssetRelation {
  id: string;
  kind: AssetRelationKind;
  parentArtifactId?: string;
  parentItemId?: string;
  childArtifactId?: string;
  childItemId?: string;
  operation?: string;
  note?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceIdentity {
  id: string;
  name: string;
  provider?: string;
  providerVoiceId?: string;
  language: string;
  description: string;
  samplePaths: string[];
  characterItemIds: string[];
  hardLockId?: string;
  tags: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceIdentityInputFields {
  name: string;
  provider?: string;
  providerVoiceId?: string;
  language?: string;
  description?: string;
  samplePaths?: string[];
  characterItemIds?: string[];
  hardLockId?: string;
  tags?: string[];
}
export type VoiceIdentityUpsertInput = RevisionedUpsertInput<VoiceIdentityInputFields>;
