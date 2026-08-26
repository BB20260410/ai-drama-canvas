import { createHash } from "node:crypto";
import {
  digestStudioCanonicalJson as stableDigest,
  serializeStudioCanonicalJsonPretty,
} from "./studio-canonical-json.js";
import {
  evaluateStudioAssetApplicability,
  getStudioCanonicalAssetKnowledgeSnapshot,
  getStudioCanonicalAsset,
  getStudioMedia as getStudioMediaUncached,
  verifyStudioMediaObject as verifyStudioMediaObjectUncached,
  type StudioAssetApplicability,
  type StudioAssetApplicabilityEvaluation,
  type StudioAssetApplicabilityTarget,
  type StudioAssetDefinitionVersion,
  type StudioAssetRelationCurrentness,
  type StudioAssetRelationEndpointCurrentness,
  type StudioAssetRelationEndpointSnapshot,
  type StudioAssetRelationKind,
  type StudioAssetVersion,
  type StudioAuthorityEvent,
  type StudioCanonicalAssetDetail,
  type StudioMediaMetadata,
} from "./material-studio.js";
import { inspectManagedProject } from "./managed-project.js";
import {
  adaptStudioBindingSetToPanelReferenceResolution,
  assertPanelReferenceResolutionIntegrity,
  type PanelReferenceControlInput,
  type PanelReferenceDependencyInput,
  type PanelReferenceResolutionCore,
} from "./panel-reference-resolution-core.js";
import {
  STUDIO_CONTINUITY_FIELDS,
  createStudioContinuityReadiness,
  type StudioContinuityField,
  type StudioContinuityScope,
} from "./studio-continuity.js";
import {
  queryStudioContinuityTimelines,
} from "./studio-continuity-ledger.js";
import {
  createStudioPanelBindingScopeFingerprint,
  getCurrentStudioPanelAssetBindingSet,
  getStudioAssetBindingReadiness,
  getStudioAssetMentionAnalysis,
  getStudioMentionIdentityKeyFingerprint,
  getStudioMentionDecisions,
  getStudioProductionPanelTimeContext,
  getStudioPanelBindingScopeFingerprint,
  getStudioProductionUnitSnapshot,
  getStudioScriptSectionRevision,
  studioIdentityDependencyKey,
  type StudioAssetBindingCurrentContext,
  type StudioAssetBindingSet,
  type StudioAssetBindingSourceSnapshot,
  type StudioAssetMentionAnalysis,
  type StudioAssetCategory,
  type StudioAssetPresence,
  type StudioPanelAssetBinding,
  type StudioMentionDecisionReceipt,
  type StudioProductionPanel,
  type StudioTextRevision,
} from "./studio-production.js";
import {
  StudioUnitGridReadEpochDriftError,
  memoStudioUnitGridRead,
  verifyStudioUnitGridMediaOnce,
} from "./studio-unit-grid-read-epoch.js";
import {
  FROZEN_PANEL_LIGHTING_COSTUME_TOOL_NOTE,
  SCENE_BACK_REFERENCE_TOOL_NOTE,
  formatPreviousStandingPromptLine,
  parseFrozenPanelCostumeFromRenderedPrompt,
  parseFrozenPanelLightingFromRenderedPrompt,
  parsePreviousStandingFromRenderedPrompt,
  pickPreviousPanelStanding,
  type StudioPanelStandingHandoff,
} from "./studio-panel-standing.js";

export {
  formatPreviousStandingPromptLine,
  parsePreviousStandingFromRenderedPrompt,
  pickPreviousPanelStanding,
  previousStandingFromAnyFrozenPack,
  previousStandingFromFrozenRenderedPrompt,
  formatPreviousStandingReadonlyLine,
  formatUnitLockPreviousStandingLine,
  UNIT_GRID_PREVIOUS_STANDING_TOOL_NOTE,
  type StudioPanelStandingHandoff,
} from "./studio-panel-standing.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
/** 内部账本定位串不是可供模型执行的视觉状态，禁止被当作已解析连续性。 */
const OPAQUE_CONTINUITY_LOCATOR_PATTERN = /^(?:[a-z][a-z0-9_-]*:)?S\d+E\d+-U\d+:panel-[a-z0-9_-]+:[a-z0-9_-]+:(?:costume|injury|heldObject|position|facing|emotion|layout|lighting)$/iu;

export function isStudioOpaqueContinuityLocator(value: string): boolean {
  return OPAQUE_CONTINUITY_LOCATOR_PATTERN.test(value.trim());
}

export type StudioGenerationFreezeErrorCode =
  | "unmanaged-project"
  | "unit-not-found"
  | "panel-not-found"
  | "asset-binding-missing"
  | "asset-binding-ambiguous"
  | "asset-binding-unconfirmed"
  | "asset-binding-stale"
  | "asset-binding-drift"
  | "panel-asset-invalid"
  | "canonical-asset-missing"
  | "asset-category-mismatch"
  | "asset-not-applicable"
  | "asset-relation-stale"
  | "definition-missing"
  | "definition-ambiguous"
  | "authority-missing"
  | "authority-ambiguous"
  | "version-missing"
  | "version-ambiguous"
  | "version-not-approved"
  | "media-missing"
  | "media-invalid"
  | "media-drift"
  | "continuity-not-ready"
  | "continuity-opaque"
  | "continuity-drift"
  | "previous-review-invalid"
  | "previous-raw-invalid"
  | "previous-panel-not-adjacent"
  | "too-few-references"
  | "too-many-references"
  | "revision-drift"
  | "input-drift"
  | "storage-invalid";

export class StudioGenerationFreezeError extends Error {
  readonly code: StudioGenerationFreezeErrorCode;
  readonly details: string[];

  constructor(code: StudioGenerationFreezeErrorCode, message: string, details: string[] = [], options?: ErrorOptions) {
    super(message, options);
    this.name = "StudioGenerationFreezeError";
    this.code = code;
    this.details = details;
  }
}

export interface StudioGenerationQueryInput {
  unitId: string;
  panelId: string;
  /** 只有显式提供且通过 current pass Review + 紧邻前格证明时，才注入 continuity-frame。 */
  previousApprovedRawReviewId?: string;
}

export interface StudioFrozenTextRevision {
  id: string;
  documentId: string;
  documentKind: "script" | "prompt";
  documentTitle: string;
  ordinal: number;
  bodySha256: string;
  bodySizeBytes: number;
  /** JavaScript/SQLite source spans use UTF-16 code-unit offsets, not UTF-8 bytes. */
  bodySizeUtf16: number;
  source: string;
  sourceVersion: string;
}

export interface StudioFrozenPromptRevision extends StudioFrozenTextRevision {
  documentKind: "prompt";
  body: string;
}

export interface StudioFrozenAssetDefinition {
  id: string;
  assetId: string;
  ordinal: number;
  assetRevision: number;
  category: StudioAssetCategory;
  name: string;
  description: string;
  aliases: string[];
  identityFeatures: string[];
  positiveLocks: string[];
  negativeLocks: string[];
  defaultPrompt: string;
  applicability: StudioAssetApplicability;
  createdAt: string;
}

/**
 * 单张控制参考的执行用途。首版从当前资产 definition 的受控约定推导，
 * 因而无需新增第二事实源或立即迁移 Binding SQLite。
 */
export interface StudioReferenceUsage {
  purpose: "identity" | "continuity" | "composition-hint" | "scale-reference";
  inheritOnly: string[];
  excludeFromOutput: string[];
  carrierPolicy: "none" | "reference-only";
}

type StudioReferenceUsageDefinitionInput = Pick<
  StudioFrozenAssetDefinition,
  "description" | "identityFeatures" | "positiveLocks" | "negativeLocks" | "defaultPrompt"
>;

const DEFAULT_STUDIO_REFERENCE_USAGE: StudioReferenceUsage = {
  purpose: "identity",
  inheritOnly: ["all"],
  excludeFromOutput: [],
  carrierPolicy: "none",
};

/**
 * Material Studio 现有 definition 的最小兼容适配器。
 * `reference-only + 尺度载体` 是显式 opt-in；未命中约定的历史资产保持 identity/all。
 */
export function deriveStudioReferenceUsage(
  definition: StudioReferenceUsageDefinitionInput,
): StudioReferenceUsage {
  const corpus = [
    definition.description,
    ...definition.identityFeatures,
    ...definition.positiveLocks,
    ...definition.negativeLocks,
    definition.defaultPrompt,
  ].join("\n");
  if (!/reference-only/iu.test(corpus) || !/(?:尺度|标尺)(?:标定)?载体|尺度参考/iu.test(corpus)) {
    return structuredClone(DEFAULT_STUDIO_REFERENCE_USAGE);
  }
  const excludeFromOutput = [
    /手套/iu.test(corpus) ? "手套" : "",
    /手指|指尖/iu.test(corpus) ? "手指" : "",
    /夹持姿势|夹持动作/iu.test(corpus) ? "夹持姿势" : "",
    /灯笼|冥灯/iu.test(corpus) ? "灯笼" : "",
    /背景/iu.test(corpus) ? "背景" : "",
  ].filter((entry): entry is string => entry.length > 0);
  return {
    purpose: "scale-reference",
    inheritOnly: ["碎片形制", "材质", "指纹", "相对尺度"],
    excludeFromOutput,
    carrierPolicy: "reference-only",
  };
}

export interface StudioFrozenAssetRelationEndpointCurrentness {
  snapshot: StudioAssetRelationEndpointSnapshot;
  current: StudioAssetRelationEndpointSnapshot;
  revisionCurrent: boolean;
  definitionCurrent: boolean;
  authorityCurrent: boolean;
  semanticCurrent: boolean;
}

/**
 * 只冻结与当前资产生成语义相关的追加式关系：
 * - derived/variant/reference：当前资产作为 subject；
 * - composite_member：当前组合资产作为 object。
 * relation 保留写入时端点快照，subject/object 保留当前端点与逐维 currentness。
 */
export interface StudioFrozenAssetRelationProvenance {
  relation: {
    id: string;
    seriesId: string;
    revision: number;
    supersedesRelationId?: string;
    head: true;
    kind: StudioAssetRelationKind;
    subject: StudioAssetRelationEndpointSnapshot;
    object: StudioAssetRelationEndpointSnapshot;
    ordinal?: number;
    role: string;
    note: string;
    fingerprint: string;
    createdAt: string;
  };
  current: true;
  subject: StudioFrozenAssetRelationEndpointCurrentness;
  object: StudioFrozenAssetRelationEndpointCurrentness;
}

export interface StudioFrozenAssetVersion {
  id: string;
  assetId: string;
  ordinal: number;
  reviewStatus: "approved";
  mediaSha256: string;
  sourceNote: string;
  createdAt: string;
}

export interface StudioFrozenAuthority {
  eventId: string;
  versionId: string;
  assetRevision: number;
  previousVersionId?: string;
  note: string;
  createdAt: string;
  current: true;
}

export interface StudioFrozenMediaReference {
  sha256: string;
  kind: "image";
  sizeBytes: number;
  mimeType: string;
  objectPath: string;
  sourceBasename: string;
  derivativeStatus: "ready";
  casVerified: true;
}

export interface StudioFrozenContinuityHead {
  headKey: string;
  headRevision: number;
  entryId: string;
  entryFingerprint: string;
  field: StudioContinuityField;
  scope: StudioContinuityScope;
  state: {
    status: "resolved" | "not-applicable";
    value?: string;
    reason?: string;
    provenance: Array<{
      kind: string;
      reference: string;
      sourceFingerprint?: string;
      note?: string;
      fingerprint: string;
    }>;
    fingerprint: string;
  };
  fingerprint: string;
}

export interface StudioFrozenAssetContinuitySnapshot {
  assetId: string;
  scope: StudioContinuityScope;
  requiredFields: StudioContinuityField[];
  timelineFingerprint: string;
  readinessFingerprint: string;
  heads: StudioFrozenContinuityHead[];
  fingerprint: string;
}

export interface StudioFrozenContinuitySnapshot {
  schemaVersion: 1;
  kind: "studio-generation-continuity-snapshot";
  scope: StudioContinuityScope;
  requiredFields: StudioContinuityField[];
  assets: StudioFrozenAssetContinuitySnapshot[];
  fingerprint: string;
}

export interface StudioFrozenAssetReference {
  assetId: string;
  /** definition/authority 生成语义水位；不是 canonical asset 的全局 revision。 */
  semanticRevision: number;
  category: StudioAssetCategory;
  presence: "required" | "optional";
  role: string;
  referenceUsage: StudioReferenceUsage;
  continuity: StudioFrozenAssetContinuitySnapshot;
  applicabilityEvaluation: StudioAssetApplicabilityEvaluation;
  relations: StudioFrozenAssetRelationProvenance[];
  definition: StudioFrozenAssetDefinition;
  authority: StudioFrozenAuthority;
  version: StudioFrozenAssetVersion;
  media: StudioFrozenMediaReference;
  sourceFingerprint: string;
}

export interface StudioFrozenForbiddenAsset {
  assetId: string;
  /** forbidden 资产只冻结 definition 生成语义水位。 */
  semanticRevision: number;
  category: StudioAssetCategory;
  presence: "forbidden";
  role: string;
  applicabilityEvaluation: StudioAssetApplicabilityEvaluation;
  relations: StudioFrozenAssetRelationProvenance[];
  definition: StudioFrozenAssetDefinition;
  authority: StudioFrozenAuthority;
  version: StudioFrozenAssetVersion;
  sourceFingerprint: string;
}

export interface StudioGenerationTarget {
  unitId: string;
  seasonId: string;
  episodeId: string;
  /** 同一 season + episode 内从 1 开始的 15 秒单元序号。 */
  unitSequence: number;
  unitRevision: number;
  panelId: string;
  panelIndex: number;
  panelCount: number;
  unitLocalStartSeconds: number;
  unitLocalEndSeconds: number;
  episodeAbsoluteStartSeconds: number;
  episodeAbsoluteEndSeconds: number;
  durationSeconds: number;
  totalDurationSeconds: number;
}

export interface StudioPreviousApprovedRawSnapshot {
  reviewId: string;
  reviewFingerprint: string;
  generationRunId: string;
  rawResultId: string;
  rawResultFingerprint: string;
  rawSha256: string;
  rawLocalPath: string;
  labeledResultId: string;
  labeledSha256: string;
  packId: string;
  packFingerprint: string;
  continuityFingerprint: string;
  sourceTarget: StudioGenerationTarget;
  fingerprint: string;
}

export interface StudioGenerationPanelInstruction {
  title: string;
  visualAction: string;
  shotComposition: string;
  filmingMethod: string;
  dialogue: string;
  subtitle: string;
  /** P20：转场描述；空 = "无"（默认硬切）。 */
  transition: string;
  /** P20：服装状态；非空 = 抑制全部资产 costume 账本行并追加格级覆盖行（整格统一）。 */
  costumeState: string;
  /** P20：场景光线；非空 = 抑制全部资产 lighting 账本行并追加格级覆盖行。 */
  sceneLighting: string;
  /** P20：原镜/扩写。 */
  shotType: "original" | "extension";
  /** P20：逐格负提示词；与资产 negativeLocks 按条 trim 精确去重合并。 */
  negativePrompt: string;
}

export interface StudioCodexModelPayload {
  exactlyOneImage: true;
  /**
   * 单镜 RAW 画幅；新包必须显式写入。schema v4 历史包可能缺少该字段，
   * 只读/trace/Review 时按旧合同解释为 9:16，禁止为补字段改写历史 CAS。
   */
  layout?: "9:16-vertical" | "cinematic-wide";
  renderedPrompt: string;
  target: StudioGenerationTarget;
  panel: StudioGenerationPanelInstruction;
  prompt: {
    revisionId: string;
    sha256: string;
    text: string;
  };
  assets: Array<{
    assetId: string;
    category: StudioAssetCategory;
    presence: "required" | "optional";
    role: string;
    referenceUsage?: StudioReferenceUsage;
    definitionVersionId: string;
    assetVersionId: string;
    authorityEventId: string;
    mediaSha256: string;
    identityFeatures: string[];
    positiveLocks: string[];
    negativeLocks: string[];
    defaultPrompt: string;
    continuity: StudioFrozenAssetContinuitySnapshot;
    applicabilityEvaluation: StudioAssetApplicabilityEvaluation;
    relations: StudioFrozenAssetRelationProvenance[];
    sourceFingerprint: string;
  }>;
  forbiddenAssets: Array<{
    assetId: string;
    category: StudioAssetCategory;
    presence: "forbidden";
    role: string;
    definitionVersionId: string;
    authorityEventId: string;
    assetVersionId: string;
    mediaSha256: string;
    name: string;
    negativeLocks: string[];
    applicabilityEvaluation: StudioAssetApplicabilityEvaluation;
    relations: StudioFrozenAssetRelationProvenance[];
    sourceFingerprint: string;
  }>;
}

export interface StudioCodexControlReference {
  assetId: string;
  category: StudioAssetCategory;
  presence: "required" | "optional";
  role: string;
  referenceUsage?: StudioReferenceUsage;
  definitionVersionId: string;
  authorityEventId: string;
  assetVersionId: string;
  mediaSha256: string;
  localPath: string;
}

export interface StudioCodexContinuityFrameControl {
  id: string;
  kind: "continuity-frame";
  purpose: "continuity";
  coveredAssetIds: string[];
  reviewId: string;
  generationRunId: string;
  rawResultId: string;
  rawSha256: string;
  mediaSha256: string;
  localPath: string;
  packId: string;
  packFingerprint: string;
  fingerprint: string;
}

export interface StudioFrozenAssetBindingDecision {
  id: string;
  proposalId: string;
  proposalFingerprint: string;
  action: "accept" | "select" | "exclude";
  selectedAssetId?: string;
  presence: StudioAssetPresence;
  role: string;
  reviewer: string;
  note: string;
  fingerprint: string;
  createdAt: string;
}

export interface StudioFrozenAssetBindingProposal {
  id: string;
  mentionId: string;
  startOffsetUtf16: number;
  endOffsetUtf16: number;
  surfaceSha256: string;
  /** 最窄的当前章节/场景修订；用于证明剧本结构来源并精准失效。 */
  sectionRevisionId?: string;
  sectionFingerprint?: string;
  presence: StudioAssetPresence;
  role: string;
  status: "matched" | "ambiguous" | "unmatched";
  normalizedIdentityKey: string;
  candidateSetFingerprint: string;
  decisionReceiptId?: string;
  resolvedAssetId?: string;
  unresolvedOptional: boolean;
}

export interface StudioFrozenAssetResolutionSnapshot {
  assetId: string;
  category: StudioAssetCategory;
  presence: StudioAssetPresence;
  role: string;
  mentionIds: string[];
  definitionVersionId: string;
  authorityEventId: string;
  authorityVersionId: string;
  assetVersionId: string;
  mediaSha256: string;
  knowledgeFingerprint: string;
  applicabilityFingerprint: string;
  bindingSemanticFingerprint: string;
  fingerprint: string;
}

export interface StudioFrozenAssetBindingProvenance {
  bindingSet: {
    id: string;
    revision: number;
    fingerprint: string;
    analysisId: string;
    unitId: string;
    unitRevision: number;
    unitFingerprint: string;
    /** 仅覆盖目标宫格及必要单元语义；其他宫格变化不会污染该身份。 */
    panelBindingScopeFingerprint: string;
    panelIndex: number;
    scriptRevisionId: string;
    scriptSha256: string;
    promptRevisionId: string;
    promptSha256: string;
    sourceSpans: Array<{
      scriptRevisionId: string;
      scriptSha256: string;
      startOffsetUtf16: number;
      endOffsetUtf16: number;
      surfaceSha256: string;
    }>;
  };
  analysis: {
    id: string;
    revision: number;
    fingerprint: string;
    resolverVersion: string;
    proposals: StudioFrozenAssetBindingProposal[];
  };
  decisions: StudioFrozenAssetBindingDecision[];
  /** 每项资产的不可变输入快照；闭包与生成准入由 pack.panelReferenceResolution 唯一表达。 */
  assetResolutionSnapshots: StudioFrozenAssetResolutionSnapshot[];
  currentness: {
    head: true;
    current: true;
    ready: true;
    staleReasons: [];
    blockers: [];
    warnings: string[];
  };
  fingerprint: string;
}

export interface StudioCodexSafetyConstraint {
  assetId: string;
  definitionVersionId: string;
  authorityEventId: string;
  assetVersionId: string;
  mediaSha256: string;
  role: string;
  negativeLocks: string[];
  fingerprint: string;
}

export interface StudioCodexGenerationRequest {
  schemaVersion: 4;
  /**
   * 历史 kind 名保留以兼容既有 CAS 语义前缀；执行面已统一为 agent-imagegen，
   * 正式允许 Codex / Grok 两类 Agent，见 allowedProviders。
   */
  kind: "studio-codex-generation-request";
  provenance: "asset-binding-set";
  id: string;
  fingerprint: string;
  projectId: string;
  /** 统一 Agent 执行面；历史包可能为 codex-imagegen。 */
  executorKind: "agent-imagegen" | "codex-imagegen";
  /** 正式可执行的 Agent 提供方；新包固定 codex+grok。 */
  allowedProviders: readonly ("codex" | "grok")[];
  exactlyOneImage: true;
  maxCalls: 1;
  target: StudioGenerationTarget;
  sourceRevisions: {
    script: StudioFrozenTextRevision;
    prompt: StudioFrozenPromptRevision;
    sourceSpans: StudioFrozenAssetBindingProvenance["bindingSet"]["sourceSpans"];
  };
  assetBinding: {
    bindingSetId: string;
    bindingSetFingerprint: string;
    analysisId: string;
    analysisFingerprint: string;
    decisionFingerprints: string[];
    referenceResolutionFingerprint: string;
    provenanceFingerprint: string;
  };
  continuity: StudioFrozenContinuitySnapshot;
  previousApprovedRaw?: StudioPreviousApprovedRawSnapshot;
  modelPayload: StudioCodexModelPayload;
  controlReferences: StudioCodexControlReference[];
  continuityFrame?: StudioCodexContinuityFrameControl;
  safetyConstraints: StudioCodexSafetyConstraint[];
}

/** Codex 单图请求包；P6 起显式携带 UTF-16 原文区间与 surface SHA。 */
export type StudioCodexGenerationRequestPack = StudioCodexGenerationRequest;

export interface StudioGenerationFreezePack {
  schemaVersion: 4;
  kind: "studio-generation-freeze-pack";
  provenance: "asset-binding-set";
  id: string;
  fingerprint: string;
  projectId: string;
  managedManifestFingerprint: string;
  unitSnapshotFingerprint: string;
  target: StudioGenerationTarget;
  scriptRevision: StudioFrozenTextRevision;
  promptRevision: StudioFrozenPromptRevision;
  panel: StudioGenerationPanelInstruction;
  assetBinding: StudioFrozenAssetBindingProvenance;
  /** Studio/Fusion 共用的唯一逐宫格引用闭包模型。 */
  panelReferenceResolution: PanelReferenceResolutionCore;
  continuity: StudioFrozenContinuitySnapshot;
  previousApprovedRaw?: StudioPreviousApprovedRawSnapshot;
  assets: StudioFrozenAssetReference[];
  forbiddenAssets: StudioFrozenForbiddenAsset[];
  request: StudioCodexGenerationRequest;
}

export interface StudioGenerationReadyResult {
  status: "ready";
  packId: string;
  fingerprint: string;
  pack: StudioGenerationFreezePack;
  request: StudioCodexGenerationRequest;
}

export interface StudioGenerationBlockedResult {
  status: "blocked";
  code: StudioGenerationFreezeErrorCode;
  message: string;
  details: string[];
}

export type StudioGenerationQueryResult = StudioGenerationReadyResult | StudioGenerationBlockedResult;

function fail(code: StudioGenerationFreezeErrorCode, message: string, details: string[] = []): never {
  throw new StudioGenerationFreezeError(code, message, details);
}

function readStudioMedia(
  projectRoot: string,
  mediaSha256: string,
): ReturnType<typeof getStudioMediaUncached> {
  return memoStudioUnitGridRead(
    projectRoot,
    `material:media:${mediaSha256}`,
    () => getStudioMediaUncached(projectRoot, mediaSha256),
  );
}

function verifyStudioMedia(
  projectRoot: string,
  mediaSha256: string,
  objectPath: string,
): Promise<boolean> {
  return verifyStudioUnitGridMediaOnce(
    projectRoot,
    mediaSha256,
    objectPath,
    () => verifyStudioMediaObjectUncached(projectRoot, mediaSha256),
  );
}

function readStudioProductionUnitSnapshot(
  projectRoot: string,
  unitId: string,
): ReturnType<typeof getStudioProductionUnitSnapshot> {
  return memoStudioUnitGridRead(
    projectRoot,
    `production:unit-snapshot:${unitId}`,
    () => getStudioProductionUnitSnapshot(projectRoot, unitId),
  );
}

function readStudioMentionIdentityKeyFingerprint(
  projectRoot: string,
  surfaceText: string,
  category: Parameters<typeof getStudioMentionIdentityKeyFingerprint>[2],
): ReturnType<typeof getStudioMentionIdentityKeyFingerprint> {
  return memoStudioUnitGridRead(
    projectRoot,
    `material:identity-key:${stableDigest({ surfaceText, category })}`,
    () => getStudioMentionIdentityKeyFingerprint(projectRoot, surfaceText, category),
  );
}

function requiredId(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail("panel-asset-invalid", `${field} 不能为空。`);
  return value.trim();
}

function assertTextRevisionBody(revision: StudioTextRevision, expectedKind: "script" | "prompt"): void {
  if (revision.documentKind !== expectedKind) fail("revision-drift", `修订 ${revision.id} 不是 ${expectedKind} 修订。`);
  const bodySha256 = createHash("sha256").update(revision.body, "utf8").digest("hex");
  if (!SHA256_PATTERN.test(revision.bodySha256) || bodySha256 !== revision.bodySha256) {
    fail("revision-drift", `修订 ${revision.id} 正文与冻结 SHA-256 不一致。`);
  }
  if (Buffer.byteLength(revision.body, "utf8") !== revision.bodySizeBytes) {
    fail("revision-drift", `修订 ${revision.id} 正文长度与冻结字节数不一致。`);
  }
}

function freezeTextRevision(revision: StudioTextRevision): StudioFrozenTextRevision {
  return {
    id: revision.id,
    documentId: revision.documentId,
    documentKind: revision.documentKind,
    documentTitle: revision.documentTitle,
    ordinal: revision.ordinal,
    bodySha256: revision.bodySha256,
    bodySizeBytes: revision.bodySizeBytes,
    bodySizeUtf16: revision.body.length,
    source: revision.source,
    sourceVersion: revision.sourceVersion,
  };
}

function freezePromptRevision(revision: StudioTextRevision): StudioFrozenPromptRevision {
  if (revision.documentKind !== "prompt") fail("revision-drift", `修订 ${revision.id} 不是 prompt 修订。`);
  return { ...freezeTextRevision(revision), documentKind: "prompt", body: revision.body };
}

function freezeDefinition(definition: StudioAssetDefinitionVersion): StudioFrozenAssetDefinition {
  return {
    id: definition.id,
    assetId: definition.assetId,
    ordinal: definition.ordinal,
    assetRevision: definition.assetRevision,
    category: definition.category,
    name: definition.name,
    description: definition.description,
    aliases: [...definition.aliases],
    identityFeatures: [...definition.identityFeatures],
    positiveLocks: [...definition.positiveLocks],
    negativeLocks: [...definition.negativeLocks],
    defaultPrompt: definition.defaultPrompt,
    applicability: freezeApplicability(definition.applicability),
    createdAt: definition.createdAt,
  };
}

function freezeApplicability(applicability: StudioAssetApplicability): StudioAssetApplicability {
  return {
    projects: [...applicability.projects],
    seasons: [...applicability.seasons],
    episodes: [...applicability.episodes],
    units: [...applicability.units],
    timeRanges: applicability.timeRanges.map((range) => ({ ...range })),
    tags: [...applicability.tags],
  };
}

function freezeApplicabilityEvaluation(
  evaluation: StudioAssetApplicabilityEvaluation,
): StudioAssetApplicabilityEvaluation {
  return {
    applicable: evaluation.applicable,
    reasons: [...evaluation.reasons],
    ...(evaluation.matchedTimeRange ? { matchedTimeRange: { ...evaluation.matchedTimeRange } } : {}),
  };
}

function freezeEndpointSnapshot(snapshot: StudioAssetRelationEndpointSnapshot): StudioAssetRelationEndpointSnapshot {
  return {
    assetId: snapshot.assetId,
    category: snapshot.category,
    assetRevision: snapshot.assetRevision,
    definitionVersionId: snapshot.definitionVersionId,
    ...(snapshot.authorityVersionId ? { authorityVersionId: snapshot.authorityVersionId } : {}),
    ...(snapshot.authorityMediaSha256 ? { authorityMediaSha256: snapshot.authorityMediaSha256 } : {}),
  };
}

function freezeEndpointCurrentness(
  endpoint: StudioAssetRelationEndpointCurrentness,
): StudioFrozenAssetRelationEndpointCurrentness {
  return {
    snapshot: freezeEndpointSnapshot(endpoint.snapshot),
    current: freezeEndpointSnapshot(endpoint.current),
    revisionCurrent: endpoint.revisionCurrent,
    definitionCurrent: endpoint.definitionCurrent,
    authorityCurrent: endpoint.authorityCurrent,
    semanticCurrent: endpoint.semanticCurrent,
  };
}

function relationIsGenerationRelevant(assetId: string, entry: StudioAssetRelationCurrentness): boolean {
  return entry.relation.kind === "composite_member"
    ? entry.relation.object.assetId === assetId
    : entry.relation.subject.assetId === assetId;
}

function freezeRelationProvenance(entry: StudioAssetRelationCurrentness): StudioFrozenAssetRelationProvenance {
  if (!entry.current) {
    fail(
      "asset-relation-stale",
      `资产关系 ${entry.relation.id} 的 definition 或 authority 端点已漂移。`,
      [
        `subject:${entry.relation.subject.assetId}:definition=${entry.subject.definitionCurrent}:authority=${entry.subject.authorityCurrent}`,
        `object:${entry.relation.object.assetId}:definition=${entry.object.definitionCurrent}:authority=${entry.object.authorityCurrent}`,
      ],
    );
  }
  return {
    relation: {
      id: entry.relation.id,
      seriesId: entry.relation.seriesId,
      revision: entry.relation.revision,
      ...(entry.relation.supersedesRelationId ? { supersedesRelationId: entry.relation.supersedesRelationId } : {}),
      head: true,
      kind: entry.relation.kind,
      subject: freezeEndpointSnapshot(entry.relation.subject),
      object: freezeEndpointSnapshot(entry.relation.object),
      ...(entry.relation.ordinal !== undefined ? { ordinal: entry.relation.ordinal } : {}),
      role: entry.relation.role,
      note: entry.relation.note,
      fingerprint: entry.relation.fingerprint,
      createdAt: entry.relation.createdAt,
    },
    current: true,
    subject: freezeEndpointCurrentness(entry.subject),
    object: freezeEndpointCurrentness(entry.object),
  };
}

function freezeVersion(version: StudioAssetVersion): StudioFrozenAssetVersion {
  if (version.reviewStatus !== "approved") {
    fail("version-not-approved", `资产 ${version.assetId} 的当前主权威版本 ${version.id} 未 approved。`);
  }
  return {
    id: version.id,
    assetId: version.assetId,
    ordinal: version.ordinal,
    reviewStatus: "approved",
    mediaSha256: version.mediaSha256,
    sourceNote: version.sourceNote,
    createdAt: version.createdAt,
  };
}

function currentAuthorityEvent(detail: StudioCanonicalAssetDetail, versionId: string): StudioAuthorityEvent {
  if (detail.authorityHistory.length === 0) {
    fail("authority-missing", `资产 ${detail.id} 的当前主权威缺少可审计 authority 事件。`);
  }
  const latestRevision = Math.max(...detail.authorityHistory.map((event) => event.assetRevision));
  const latest = detail.authorityHistory.filter((event) => event.assetRevision === latestRevision);
  if (latest.length !== 1) {
    fail("authority-ambiguous", `资产 ${detail.id} 的当前主权威事件不唯一。`, latest.map((event) => event.id));
  }
  if (latest[0]!.versionId !== versionId) {
    fail("input-drift", `资产 ${detail.id} 的主权威指针与最新 authority 事件已漂移。`);
  }
  return latest[0]!;
}

function selectCurrentDefinition(detail: StudioCanonicalAssetDetail): StudioAssetDefinitionVersion {
  const candidates = detail.definitionVersions.filter((definition) => definition.id === detail.currentDefinitionVersionId);
  if (candidates.length === 0) fail("definition-missing", `资产 ${detail.id} 缺少当前 definition 版本。`);
  if (candidates.length !== 1) {
    fail("definition-ambiguous", `资产 ${detail.id} 的当前 definition 版本不唯一。`, candidates.map((entry) => entry.id));
  }
  return candidates[0]!;
}

function selectAuthorityVersion(detail: StudioCanonicalAssetDetail): StudioAssetVersion {
  if (!detail.primaryAuthority) fail("authority-missing", `资产 ${detail.id} 缺少当前主权威。`);
  const candidates = detail.versions.filter((version) => version.id === detail.primaryAuthority!.versionId);
  if (candidates.length === 0) fail("version-missing", `资产 ${detail.id} 的主权威版本不存在。`);
  if (candidates.length !== 1) {
    fail("version-ambiguous", `资产 ${detail.id} 的主权威版本不唯一。`, candidates.map((entry) => entry.id));
  }
  const version = candidates[0]!;
  if (version.mediaSha256 !== detail.primaryAuthority.mediaSha256) {
    fail("input-drift", `资产 ${detail.id} 的主权威 SHA 与版本 SHA 已漂移。`);
  }
  return version;
}

function freezeAuthority(event: StudioAuthorityEvent): StudioFrozenAuthority {
  return {
    eventId: event.id,
    versionId: event.versionId,
    assetRevision: event.assetRevision,
    ...(event.previousVersionId ? { previousVersionId: event.previousVersionId } : {}),
    note: event.note,
    createdAt: event.createdAt,
    current: true,
  };
}

function freezeMedia(media: StudioMediaMetadata): StudioFrozenMediaReference {
  if (media.kind !== "image") fail("media-invalid", `媒体 ${media.sha256} 不是可用作 Codex 控制引用的 image。`);
  if (media.derivativeStatus !== "ready") fail("media-invalid", `图片媒体 ${media.sha256} 派生状态不是 ready。`);
  return {
    sha256: media.sha256,
    kind: "image",
    sizeBytes: media.sizeBytes,
    mimeType: media.mimeType,
    objectPath: media.objectPath,
    sourceBasename: media.sourceBasename,
    derivativeStatus: "ready",
    casVerified: true,
  };
}

interface StudioLoadedCanonicalKnowledge {
  detail: StudioCanonicalAssetDetail;
  definition: StudioAssetDefinitionVersion;
  applicabilityEvaluation: StudioAssetApplicabilityEvaluation;
  relations: StudioFrozenAssetRelationProvenance[];
  knowledgeFingerprint: string;
  applicabilityFingerprint: string;
  sourceFingerprint: string;
}

interface StudioBindingAssetInput {
  assetId: string;
  category: StudioAssetCategory;
  presence: StudioAssetPresence;
  role: string;
}

async function loadCanonicalKnowledgeUncached(
  projectRoot: string,
  mention: StudioBindingAssetInput,
  target: StudioAssetApplicabilityTarget,
): Promise<StudioLoadedCanonicalKnowledge> {
  const detail = await getStudioCanonicalAsset(projectRoot, mention.assetId);
  if (!detail) fail("canonical-asset-missing", `panel 资产 ${mention.assetId} 不存在 CanonicalAsset。`);
  if (detail.category !== mention.category) {
    fail("asset-category-mismatch", `资产 ${mention.assetId} 的 panel category 与 CanonicalAsset category 不一致。`);
  }
  const definition = selectCurrentDefinition(detail);
  const knowledge = await getStudioCanonicalAssetKnowledgeSnapshot(projectRoot, mention.assetId, target);
  if (!knowledge) fail("canonical-asset-missing", `panel 资产 ${mention.assetId} 缺少可冻结知识快照。`);
  if (knowledge.assetId !== detail.id
    || knowledge.category !== detail.category
    || knowledge.assetRevision !== detail.revision
    || knowledge.definitionVersionId !== definition.id
    || knowledge.authorityVersionId !== detail.primaryAuthority?.versionId
    || knowledge.authorityMediaSha256 !== detail.primaryAuthority?.mediaSha256) {
    fail("input-drift", `资产 ${mention.assetId} 的规范详情与知识快照不一致。`);
  }
  const applicabilityEvaluation = evaluateStudioAssetApplicability(knowledge.applicability, target);
  if (!knowledge.applicabilityEvaluation
    || stableDigest(knowledge.applicabilityEvaluation) !== stableDigest(applicabilityEvaluation)) {
    fail("input-drift", `资产 ${mention.assetId} 的适用范围判断在冻结期间不一致。`);
  }
  if (!applicabilityEvaluation.applicable) {
    fail(
      "asset-not-applicable",
      `资产 ${mention.assetId} 不适用于当前项目、集、15 秒单元或宫格秒段。`,
      applicabilityEvaluation.reasons.map((reason) => `${mention.assetId}:${reason}`),
    );
  }
  const relations = knowledge.relations
    .filter((entry) => entry.head && relationIsGenerationRelevant(detail.id, entry))
    .sort((left, right) => left.relation.id.localeCompare(right.relation.id, "en"))
    .map(freezeRelationProvenance);
  const frozenEvaluation = freezeApplicabilityEvaluation(applicabilityEvaluation);
  const sourceFingerprint = stableDigest({
    assetId: detail.id,
    category: detail.category,
    definition: freezeDefinition(definition),
    applicabilityEvaluation: frozenEvaluation,
    relations,
  });
  return {
    detail,
    definition,
    applicabilityEvaluation: frozenEvaluation,
    relations,
    knowledgeFingerprint: knowledge.fingerprint,
    applicabilityFingerprint: stableDigest(frozenEvaluation),
    sourceFingerprint,
  };
}

function loadCanonicalKnowledge(
  projectRoot: string,
  mention: StudioBindingAssetInput,
  target: StudioAssetApplicabilityTarget,
): Promise<StudioLoadedCanonicalKnowledge> {
  return memoStudioUnitGridRead(
    projectRoot,
    `material:canonical-knowledge:${stableDigest({ mention, target })}`,
    () => loadCanonicalKnowledgeUncached(projectRoot, mention, target),
  );
}

async function assertCanonicalKnowledgeUnchanged(
  projectRoot: string,
  mention: StudioBindingAssetInput,
  target: StudioAssetApplicabilityTarget,
  expectedSourceFingerprint: string,
): Promise<StudioLoadedCanonicalKnowledge> {
  const current = await loadCanonicalKnowledge(projectRoot, mention, target);
  if (current.sourceFingerprint !== expectedSourceFingerprint) {
    fail("input-drift", `资产 ${mention.assetId} 在冻结期间发生定义、适用范围或相关关系漂移。`);
  }
  return current;
}

function allowedAssetSourceFingerprint(input: {
  knowledge: StudioLoadedCanonicalKnowledge;
  version: StudioFrozenAssetVersion;
  authority: StudioFrozenAuthority;
  media: StudioFrozenMediaReference;
}): string {
  return stableDigest({
    canonicalKnowledgeFingerprint: input.knowledge.sourceFingerprint,
    version: input.version,
    authority: input.authority,
    media: input.media,
  });
}

async function freezeForbiddenAsset(
  projectRoot: string,
  mention: StudioBindingAssetInput,
  target: StudioAssetApplicabilityTarget,
): Promise<StudioFrozenForbiddenAsset> {
  const loaded = await loadCanonicalKnowledge(projectRoot, mention, target);
  const version = selectAuthorityVersion(loaded.detail);
  const frozenVersion = freezeVersion(version);
  const authorityEvent = currentAuthorityEvent(loaded.detail, version.id);
  const frozenAuthority = freezeAuthority(authorityEvent);
  const media = await readStudioMedia(projectRoot, frozenVersion.mediaSha256);
  if (!media) fail("media-missing", `禁止资产 ${loaded.detail.id} 的主权威媒体 ${frozenVersion.mediaSha256} 不存在。`);
  if (!await verifyStudioMedia(projectRoot, frozenVersion.mediaSha256, media.objectPath)) {
    fail("media-drift", `禁止资产 ${loaded.detail.id} 的项目内媒体 CAS 当前 SHA 校验失败。`, [media.objectPath]);
  }
  await assertCanonicalKnowledgeUnchanged(projectRoot, mention, target, loaded.sourceFingerprint);
  const result: Omit<StudioFrozenForbiddenAsset, "sourceFingerprint"> = {
    assetId: loaded.detail.id,
    semanticRevision: loaded.definition.assetRevision,
    category: loaded.detail.category,
    presence: "forbidden",
    role: mention.role,
    applicabilityEvaluation: loaded.applicabilityEvaluation,
    relations: loaded.relations,
    definition: freezeDefinition(loaded.definition),
    authority: frozenAuthority,
    version: frozenVersion,
  };
  return {
    ...result,
    sourceFingerprint: stableDigest({
      canonicalKnowledgeFingerprint: loaded.sourceFingerprint,
      version: frozenVersion,
      authority: frozenAuthority,
      mediaSha256: frozenVersion.mediaSha256,
    }),
  };
}

async function freezeAllowedAsset(
  projectRoot: string,
  mention: StudioBindingAssetInput,
  target: StudioAssetApplicabilityTarget,
  continuity: StudioFrozenAssetContinuitySnapshot,
): Promise<StudioFrozenAssetReference> {
  const loaded = await loadCanonicalKnowledge(projectRoot, mention, target);
  const { detail, definition } = loaded;
  if (definition.assetId !== detail.id || definition.category !== detail.category) {
    fail("input-drift", `资产 ${detail.id} 的当前 definition 归属或类别已漂移。`);
  }
  const version = selectAuthorityVersion(detail);
  const frozenVersion = freezeVersion(version);
  const authorityEvent = currentAuthorityEvent(detail, version.id);
  if (authorityEvent.assetRevision > detail.revision) {
    fail("input-drift", `资产 ${detail.id} 的 authority 修订超过当前资产修订。`);
  }
  const media = await readStudioMedia(projectRoot, frozenVersion.mediaSha256);
  if (!media) fail("media-missing", `资产 ${detail.id} 的主权威媒体 ${frozenVersion.mediaSha256} 不存在。`);
  if (media.sha256 !== frozenVersion.mediaSha256) fail("input-drift", `资产 ${detail.id} 媒体索引 SHA 已漂移。`);
  if (!await verifyStudioMedia(projectRoot, media.sha256, media.objectPath)) {
    fail("media-drift", `资产 ${detail.id} 的项目内媒体 CAS 当前 SHA 校验失败。`, [media.objectPath]);
  }

  const frozenDefinition = freezeDefinition(definition);
  const frozenAuthority = freezeAuthority(authorityEvent);
  const frozenMedia = freezeMedia(media);
  const sourceFingerprint = allowedAssetSourceFingerprint({
    knowledge: loaded,
    version: frozenVersion,
    authority: frozenAuthority,
    media: frozenMedia,
  });
  const currentLoaded = await assertCanonicalKnowledgeUnchanged(projectRoot, mention, target, loaded.sourceFingerprint);
  const currentVersion = freezeVersion(selectAuthorityVersion(currentLoaded.detail));
  const currentAuthority = freezeAuthority(currentAuthorityEvent(currentLoaded.detail, currentVersion.id));
  const currentMediaRecord = await readStudioMedia(projectRoot, currentVersion.mediaSha256);
  if (!currentMediaRecord) fail("media-missing", `资产 ${detail.id} 的当前主权威媒体 ${currentVersion.mediaSha256} 不存在。`);
  const currentMedia = freezeMedia(currentMediaRecord);
  if (allowedAssetSourceFingerprint({
    knowledge: currentLoaded,
    version: currentVersion,
    authority: currentAuthority,
    media: currentMedia,
  }) !== sourceFingerprint) {
    fail("input-drift", `资产 ${mention.assetId} 在冻结期间发生权威版本或媒体漂移。`);
  }
  const result: Omit<StudioFrozenAssetReference, "sourceFingerprint"> = {
    assetId: detail.id,
    semanticRevision: Math.max(definition.assetRevision, authorityEvent.assetRevision),
    category: detail.category,
    presence: mention.presence as "required" | "optional",
    role: mention.role,
    referenceUsage: deriveStudioReferenceUsage(frozenDefinition),
    continuity,
    applicabilityEvaluation: loaded.applicabilityEvaluation,
    relations: loaded.relations,
    definition: frozenDefinition,
    authority: frozenAuthority,
    version: frozenVersion,
    media: frozenMedia,
  };
  return { ...result, sourceFingerprint };
}

function panelInstruction(panel: StudioProductionPanel): StudioGenerationPanelInstruction {
  return {
    title: panel.title,
    visualAction: panel.visualAction,
    shotComposition: panel.shotComposition,
    filmingMethod: panel.filmingMethod,
    dialogue: panel.dialogue,
    subtitle: panel.subtitle,
    transition: panel.transition,
    costumeState: panel.costumeState,
    sceneLighting: panel.sceneLighting,
    shotType: panel.shotType,
    negativePrompt: panel.negativePrompt,
  };
}

function panelContinuityScope(target: StudioGenerationTarget): StudioContinuityScope {
  const startMilliseconds = target.unitLocalStartSeconds * 1_000;
  const endMilliseconds = target.unitLocalEndSeconds * 1_000;
  if (!Number.isSafeInteger(startMilliseconds) || !Number.isSafeInteger(endMilliseconds)) {
    fail("continuity-not-ready", `panel ${target.panelId} 的秒段不能无损表达为整数毫秒半开区间。`);
  }
  return {
    kind: "panel",
    scopeId: target.panelId,
    unitId: target.unitId,
    unitRevision: target.unitRevision,
    startMilliseconds,
    endMilliseconds,
    fingerprint: stableDigest({
      kind: "panel",
      scopeId: target.panelId,
      unitId: target.unitId,
      unitRevision: target.unitRevision,
      startMilliseconds,
      endMilliseconds,
    }),
  };
}

function continuityHeadSemantic(head: Omit<StudioFrozenContinuityHead, "fingerprint">): unknown {
  return head;
}

function assertContinuitySnapshotIntegrity(snapshot: StudioFrozenContinuitySnapshot): void {
  if (snapshot.schemaVersion !== 1 || snapshot.kind !== "studio-generation-continuity-snapshot"
    || snapshot.requiredFields.length !== STUDIO_CONTINUITY_FIELDS.length
    || snapshot.requiredFields.some((field, index) => field !== STUDIO_CONTINUITY_FIELDS[index])) {
    fail("continuity-drift", "generation continuity snapshot schema 或固定九字段顺序无效。");
  }
  const { fingerprint: _scopeFingerprint, ...scopeSemantic } = snapshot.scope;
  if (snapshot.scope.fingerprint !== stableDigest(scopeSemantic)
    || snapshot.scope.kind !== "panel"
    || !Number.isSafeInteger(snapshot.scope.startMilliseconds)
    || !Number.isSafeInteger(snapshot.scope.endMilliseconds)
    || snapshot.scope.endMilliseconds <= snapshot.scope.startMilliseconds) {
    fail("continuity-drift", "generation continuity snapshot 的 panel 半开 scope 无效。");
  }
  const assetIds = snapshot.assets.map((asset) => asset.assetId);
  if (new Set(assetIds).size !== assetIds.length
    || assetIds.some((assetId, index) => index > 0 && assetIds[index - 1]!.localeCompare(assetId, "en") >= 0)) {
    fail("continuity-drift", "generation continuity snapshot 的资产集合必须唯一且稳定排序。");
  }
  for (const asset of snapshot.assets) {
    if (asset.heads.length === 0) fail("continuity-drift", `资产 ${asset.assetId} 的 continuity snapshot 没有任何 head。`);
    for (const head of asset.heads) {
      const { fingerprint, ...semantic } = head;
      if (fingerprint !== stableDigest(continuityHeadSemantic(semantic))
        || !SHA256_PATTERN.test(head.entryFingerprint)
        || !SHA256_PATTERN.test(head.state.fingerprint)
        || !STUDIO_CONTINUITY_FIELDS.includes(head.field)
        || !studioScopeOverlaps(head.scope, snapshot.scope)
        || (head.state.status === "resolved" && (!head.state.value || head.state.reason !== undefined))
        || (head.state.status === "not-applicable" && (!head.state.reason || head.state.value !== undefined))) {
        fail("continuity-drift", `资产 ${asset.assetId} 的 continuity head ${head.headKey} 内容地址无效。`);
      }
      if (head.state.status === "resolved"
        && head.field !== "referenceSha256"
        && isStudioOpaqueContinuityLocator(head.state.value ?? "")) {
        fail(
          "continuity-opaque",
          `资产 ${asset.assetId} 的 ${head.field} 是内部定位，不是可执行视觉状态。`,
          [`${head.entryId}:${head.field}`],
        );
      }
    }
    const { fingerprint, ...semantic } = asset;
    if (fingerprint !== stableDigest(semantic)
      || !SHA256_PATTERN.test(asset.timelineFingerprint)
      || !SHA256_PATTERN.test(asset.readinessFingerprint)
      || asset.scope.fingerprint !== snapshot.scope.fingerprint
      || asset.requiredFields.some((field, index) => field !== STUDIO_CONTINUITY_FIELDS[index])) {
      fail("continuity-drift", `资产 ${asset.assetId} 的 continuity snapshot 内容地址无效。`);
    }
    for (const field of STUDIO_CONTINUITY_FIELDS) {
      const ranges = asset.heads.filter((head) => head.field === field)
        .map((head) => ({
          start: Math.max(head.scope.startMilliseconds, snapshot.scope.startMilliseconds),
          end: Math.min(head.scope.endMilliseconds, snapshot.scope.endMilliseconds),
        }))
        .sort((left, right) => left.start - right.start || left.end - right.end);
      let cursor = snapshot.scope.startMilliseconds;
      for (const range of ranges) {
        if (range.start > cursor) break;
        if (range.end > cursor) cursor = range.end;
      }
      if (cursor < snapshot.scope.endMilliseconds) {
        fail("continuity-drift", `资产 ${asset.assetId} 的 continuity 字段 ${field} 存在缺口。`);
      }
    }
  }
  const { fingerprint, ...semantic } = snapshot;
  if (fingerprint !== stableDigest(semantic)) fail("continuity-drift", "generation continuity snapshot 内容地址无效。");
}

function assertPreviousApprovedRawSnapshotIntegrity(previous: StudioPreviousApprovedRawSnapshot): void {
  const { fingerprint, ...semantic } = previous;
  const expectedRawFingerprint = stableDigest({
    packId: previous.packId,
    packFingerprint: previous.packFingerprint,
    generationRunId: previous.generationRunId,
    variant: "raw",
    mediaSha256: previous.rawSha256,
    status: "pending",
  });
  if (fingerprint !== stableDigest(semantic)
    || previous.rawResultFingerprint !== expectedRawFingerprint
    || previous.rawResultId !== `studio-generation-result-${expectedRawFingerprint.slice(0, 40)}`
    || !SHA256_PATTERN.test(previous.reviewFingerprint)
    || !SHA256_PATTERN.test(previous.rawSha256)
    || !SHA256_PATTERN.test(previous.labeledSha256)
    || !SHA256_PATTERN.test(previous.packFingerprint)
    || !SHA256_PATTERN.test(previous.continuityFingerprint)
    || previous.rawLocalPath.trim() === "") {
    fail("previous-raw-invalid", `上一格 raw snapshot ${previous.rawResultId} 内容地址无效。`);
  }
}

function assertContinuityFrameIntegrity(
  frame: StudioCodexContinuityFrameControl,
  previous: StudioPreviousApprovedRawSnapshot,
  coveredAssetIds: string[],
): void {
  const { fingerprint, ...semantic } = frame;
  const expectedIds = [...coveredAssetIds].sort((left, right) => left.localeCompare(right, "en"));
  if (fingerprint !== stableDigest(semantic)
    || frame.kind !== "continuity-frame" || frame.purpose !== "continuity"
    || frame.reviewId !== previous.reviewId
    || frame.generationRunId !== previous.generationRunId
    || frame.rawResultId !== previous.rawResultId
    || frame.rawSha256 !== previous.rawSha256 || frame.mediaSha256 !== previous.rawSha256
    || frame.localPath !== previous.rawLocalPath
    || frame.packId !== previous.packId || frame.packFingerprint !== previous.packFingerprint
    || stableDigest(frame.coveredAssetIds) !== stableDigest(expectedIds)) {
    fail("previous-raw-invalid", `continuity-frame ${frame.id} 与上一格 approved raw snapshot 不一致。`);
  }
}

async function freezePanelContinuity(
  projectRoot: string,
  target: StudioGenerationTarget,
  allowedBindings: StudioPanelAssetBinding[],
): Promise<StudioFrozenContinuitySnapshot> {
  const scope = panelContinuityScope(target);
  const requiredFields = [...STUDIO_CONTINUITY_FIELDS];
  const assets: StudioFrozenAssetContinuitySnapshot[] = [];
  const bindings = [...allowedBindings].sort((left, right) => left.assetId.localeCompare(right.assetId, "en"));
  const timelines = bindings.length === 0 ? [] : await queryStudioContinuityTimelines(
    projectRoot,
    bindings.map((binding) => ({ scopeAnchor: scope, subjectId: binding.assetId })),
  );
  for (const [index, binding] of bindings.entries()) {
    const timeline = timelines[index]!;
    const readiness = createStudioContinuityReadiness({
      scope,
      subjectId: binding.assetId,
      requiredFields,
      currentEntries: timeline.items.map((item) => item.entry),
      openConflicts: timeline.openConflicts,
    });
    if (!readiness.ready) {
      fail(
        "continuity-not-ready",
        `允许资产 ${binding.assetId} 在 panel ${target.panelId} 的固定九字段连续性未 ready。`,
        [
          `scope:${scope.kind}:${scope.scopeId}:${scope.unitId}:r${scope.unitRevision}:${scope.startMilliseconds}-${scope.endMilliseconds}ms`,
          `timeline:${timeline.items.length}:${timeline.items.map((item) => `${item.entry.field}@r${item.entry.scope.unitRevision}:${item.entry.scope.startMilliseconds}-${item.entry.scope.endMilliseconds}ms`).join(",") || "empty"}`,
          ...readiness.blockers.map((blocker) => [
            blocker.code,
            blocker.field,
            blocker.startMilliseconds === undefined ? "" : `${blocker.startMilliseconds}-${blocker.endMilliseconds}ms`,
            blocker.entryId ?? blocker.conflictId ?? "",
          ].filter(Boolean).join(":")),
        ],
      );
    }
    const heads = timeline.items
      .filter((item) => studioScopeOverlaps(item.entry.scope, scope))
      .map((item): StudioFrozenContinuityHead => {
        if (item.entry.state.status === "unresolved") {
          fail("continuity-drift", `readiness=ready 却包含 unresolved continuity entry：${item.entry.id}`);
        }
        if (item.entry.state.status === "resolved"
          && item.entry.field !== "referenceSha256"
          && isStudioOpaqueContinuityLocator(item.entry.state.value ?? "")) {
          fail(
            "continuity-opaque",
            `允许资产 ${binding.assetId} 的 ${item.entry.field} 仍是内部定位，必须录入实际视觉状态后才能冻结。`,
            [`${item.entry.id}:${item.entry.field}`],
          );
        }
        const state = item.entry.state.status === "resolved"
          ? {
              status: "resolved" as const,
              value: item.entry.state.value,
              provenance: item.entry.state.provenance.map((entry) => ({ ...entry })),
              fingerprint: item.entry.state.fingerprint,
            }
          : {
              status: "not-applicable" as const,
              reason: item.entry.state.reason,
              provenance: item.entry.state.provenance.map((entry) => ({ ...entry })),
              fingerprint: item.entry.state.fingerprint,
            };
        const semantic: Omit<StudioFrozenContinuityHead, "fingerprint"> = {
          headKey: item.headKey,
          headRevision: item.headRevision,
          entryId: item.entry.id,
          entryFingerprint: item.entry.fingerprint,
          field: item.entry.field,
          scope: { ...item.entry.scope },
          state,
        };
        return { ...semantic, fingerprint: stableDigest(continuityHeadSemantic(semantic)) };
      });
    const semantic: Omit<StudioFrozenAssetContinuitySnapshot, "fingerprint"> = {
      assetId: binding.assetId,
      scope: { ...scope },
      requiredFields,
      timelineFingerprint: timeline.fingerprint,
      readinessFingerprint: readiness.fingerprint,
      heads,
    };
    assets.push({ ...semantic, fingerprint: stableDigest(semantic) });
  }
  const semantic: Omit<StudioFrozenContinuitySnapshot, "fingerprint"> = {
    schemaVersion: 1,
    kind: "studio-generation-continuity-snapshot",
    scope,
    requiredFields,
    assets,
  };
  const result = { ...semantic, fingerprint: stableDigest(semantic) };
  assertContinuitySnapshotIntegrity(result);
  return result;
}

function studioScopeOverlaps(left: StudioContinuityScope, right: StudioContinuityScope): boolean {
  return left.kind === right.kind
    && left.scopeId === right.scopeId
    && left.unitId === right.unitId
    && left.unitRevision === right.unitRevision
    && left.startMilliseconds < right.endMilliseconds
    && right.startMilliseconds < left.endMilliseconds;
}

async function freezePreviousApprovedRaw(
  projectRoot: string,
  reviewIdInput: string,
  currentTarget: StudioGenerationTarget,
): Promise<StudioPreviousApprovedRawSnapshot> {
  const reviewId = requiredId(reviewIdInput, "previousApprovedRawReviewId");
  let review;
  try {
    const reviewModule = await import("./studio-generation-review.js");
    review = await reviewModule.readStudioGenerationReview(projectRoot, reviewId);
  } catch (error) {
    fail("previous-review-invalid", `上一格 Review ${reviewId} 无法验证。`, [error instanceof Error ? error.message : String(error)]);
  }
  if (!review || !review.head || !review.current || !review.approvedRawEligible || review.decision !== "pass") {
    fail(
      "previous-review-invalid",
      `previousApprovedRawReviewId=${reviewId} 必须是 current pass Review Head。`,
      review?.currentStaleReasons ?? ["review-not-found"],
    );
  }

  let raw;
  let labeled;
  let sourcePack;
  try {
    const ledger = await import("./studio-generation-ledger.js");
    [raw, labeled, sourcePack] = await Promise.all([
      ledger.readStudioGenerationResult(projectRoot, review.rawResultId),
      ledger.readStudioGenerationResult(projectRoot, review.labeledResultId),
      ledger.readStudioGenerationFrozenPack(projectRoot, review.packId),
    ]);
  } catch (error) {
    fail("previous-raw-invalid", `上一格 Review ${reviewId} 的 result/pack 无法验证。`, [error instanceof Error ? error.message : String(error)]);
  }
  if (!raw || !labeled || !sourcePack
    || sourcePack.schemaVersion !== 4
    || raw.variant !== "raw" || labeled.variant !== "labeled"
    || raw.resultId !== review.rawResultId || raw.mediaSha256 !== review.rawSha256
    || labeled.resultId !== review.labeledResultId || labeled.mediaSha256 !== review.labeledSha256
    || raw.generationRunId !== review.generationRunId || labeled.generationRunId !== review.generationRunId
    || raw.packId !== review.packId || labeled.packId !== review.packId || sourcePack.id !== review.packId
    || raw.packFingerprint !== review.packFingerprint
    || labeled.packFingerprint !== review.packFingerprint
    || sourcePack.fingerprint !== review.packFingerprint
    || review.continuityFingerprint !== sourcePack.continuity.fingerprint
    || !raw.pairComplete || !labeled.pairComplete
    || !raw.promotionEligible || !labeled.promotionEligible) {
    fail("previous-raw-invalid", `上一格 Review ${reviewId} 的 raw+labeled/pack/media SHA 闭包无效。`);
  }
  const sourceTarget = sourcePack.target;
  const withinUnitAdjacent = sourceTarget.unitId === currentTarget.unitId
    && sourceTarget.unitRevision === currentTarget.unitRevision
    && sourceTarget.panelIndex + 1 === currentTarget.panelIndex;
  const acrossUnitAdjacent = sourceTarget.unitSequence + 1 === currentTarget.unitSequence
    && sourceTarget.panelIndex === sourceTarget.panelCount
    && currentTarget.panelIndex === 1;
  if (sourceTarget.seasonId !== currentTarget.seasonId
    || sourceTarget.episodeId !== currentTarget.episodeId
    || sourceTarget.episodeAbsoluteEndSeconds !== currentTarget.episodeAbsoluteStartSeconds
    || (!withinUnitAdjacent && !acrossUnitAdjacent)) {
    fail(
      "previous-panel-not-adjacent",
      `Review ${reviewId} 的 raw 不是当前 panel 的同季同集紧邻前格。`,
      [
        `previous=${sourceTarget.seasonId}/${sourceTarget.episodeId}/${sourceTarget.unitSequence}/${sourceTarget.panelIndex}`,
        `current=${currentTarget.seasonId}/${currentTarget.episodeId}/${currentTarget.unitSequence}/${currentTarget.panelIndex}`,
      ],
    );
  }
  const rawMedia = await readStudioMedia(projectRoot, raw.mediaSha256);
  if (!rawMedia || rawMedia.kind !== "image" || rawMedia.derivativeStatus !== "ready"
    || !await verifyStudioMedia(projectRoot, raw.mediaSha256, rawMedia.objectPath)) {
    fail("previous-raw-invalid", `上一格 raw ${raw.resultId} 的 media CAS 无效。`);
  }
  const rawIdentity = {
    packId: raw.packId,
    packFingerprint: raw.packFingerprint,
    generationRunId: raw.generationRunId,
    variant: "raw" as const,
    mediaSha256: raw.mediaSha256,
    status: "pending" as const,
  };
  const rawResultFingerprint = stableDigest(rawIdentity);
  if (raw.resultId !== `studio-generation-result-${rawResultFingerprint.slice(0, 40)}`) {
    fail("previous-raw-invalid", `上一格 raw ${raw.resultId} 的内容地址无效。`);
  }
  const semantic: Omit<StudioPreviousApprovedRawSnapshot, "fingerprint"> = {
    reviewId: review.reviewId,
    reviewFingerprint: review.fingerprint,
    generationRunId: review.generationRunId,
    rawResultId: raw.resultId,
    rawResultFingerprint,
    rawSha256: raw.mediaSha256,
    rawLocalPath: rawMedia.objectPath,
    labeledResultId: labeled.resultId,
    labeledSha256: labeled.mediaSha256,
    packId: sourcePack.id,
    packFingerprint: sourcePack.fingerprint,
    continuityFingerprint: sourcePack.continuity.fingerprint,
    sourceTarget: { ...sourceTarget },
  };
  return { ...semantic, fingerprint: stableDigest(semantic) };
}

function continuityDependencies(snapshot: StudioFrozenContinuitySnapshot): PanelReferenceDependencyInput[] {
  return [
    {
      kind: "continuity-snapshot",
      key: `studio:continuity:snapshot:${snapshot.scope.fingerprint}`,
      fingerprint: snapshot.fingerprint,
    },
    ...snapshot.assets.flatMap((asset) => [
      {
        kind: "continuity-readiness",
        key: `studio:continuity:readiness:${asset.assetId}:${snapshot.scope.fingerprint}`,
        fingerprint: asset.readinessFingerprint,
      },
      ...asset.heads.map((head) => ({
        kind: "continuity-head",
        key: `studio:continuity:head:${head.headKey}`,
        fingerprint: head.fingerprint,
      })),
    ]),
  ];
}

function previousRawReferenceInput(
  previous: StudioPreviousApprovedRawSnapshot,
  coveredAssetIds: string[],
): { control: PanelReferenceControlInput; dependencies: PanelReferenceDependencyInput[] } {
  const control: PanelReferenceControlInput = {
    id: `continuity-frame-${stableDigest({ reviewId: previous.reviewId, rawResultId: previous.rawResultId }).slice(0, 32)}`,
    kind: "continuity-frame",
    purpose: "continuity",
    coveredAssetIds: [...coveredAssetIds].sort((left, right) => left.localeCompare(right, "en")),
    readiness: "ready",
    contentAddress: previous.rawSha256,
    referenceVersion: previous.rawResultId,
    provenance: [{
      source: "studio-generation-result",
      reference: previous.rawResultId,
      sourceFingerprint: previous.rawResultFingerprint,
    }, {
      source: "studio-generation-review",
      reference: previous.reviewId,
      sourceFingerprint: previous.reviewFingerprint,
    }, {
      source: "studio-generation-pack",
      reference: previous.packId,
      sourceFingerprint: previous.packFingerprint,
    }],
    extensions: {
      generationRunId: previous.generationRunId,
      labeledResultId: previous.labeledResultId,
      previousSnapshotFingerprint: previous.fingerprint,
    },
  };
  return {
    control,
    dependencies: [{
      kind: "continuity-media",
      key: `continuity:media:${previous.rawResultId}`,
      fingerprint: previous.rawSha256,
    }, {
      kind: "generation-result",
      key: `continuity:result:${previous.rawResultId}`,
      fingerprint: previous.rawResultFingerprint,
    }, {
      kind: "result-review",
      key: `continuity:review:${previous.reviewId}`,
      fingerprint: previous.reviewFingerprint,
    }, {
      kind: "generation-pack",
      key: `continuity:pack:${previous.packId}`,
      fingerprint: previous.packFingerprint,
    }],
  };
}

function requestSemantic(request: Omit<StudioCodexGenerationRequest, "id" | "fingerprint">): unknown {
  return request;
}

function mergeNegativePromptLines(assetLocks: string[], panelNegativePrompt: string): string[] {
  // P20：资产 negativeLocks 与格 negativePrompt 按 "；" 拆条、trim、精确去重（大小写敏感）、保序（先资产后本格）。
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...assetLocks, ...panelNegativePrompt.split("；")]) {
    const item = raw.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    merged.push(item);
  }
  return merged;
}

function renderStudioPrompt(input: {
  panel: StudioGenerationPanelInstruction;
  promptRevision: StudioFrozenPromptRevision;
  assets: StudioFrozenAssetReference[];
  forbiddenAssets: StudioFrozenForbiddenAsset[];
  layout: StudioCodexModelPayload["layout"];
  previousStanding?: StudioPanelStandingHandoff | null;
}): string {
  const previousLine = formatPreviousStandingPromptLine(input.previousStanding);
  const lines = [
    input.layout === "cinematic-wide"
      ? "只生成一张电影宽银幕横幅、电影写实的 AI 短剧分镜图；保持横屏，不要竖屏、拼图、分屏、字幕、水印、界面文字或现代物。"
      : "只生成一张 9:16 竖屏、电影写实的 AI 短剧分镜图；不要拼图、分屏、字幕、水印、界面文字或现代物。",
    `宫格画面：${input.panel.title}。${input.panel.visualAction}`,
    `景别与构图：${input.panel.shotComposition}`,
    `拍摄方式：${input.panel.filmingMethod}`,
    ...(previousLine ? [previousLine] : []),
    `本格冻结提示词：${input.promptRevision.body}`,
    `镜头类型：${input.panel.shotType === "extension" ? "扩写延续（保持与前一格连续，不重新起镜）" : "原镜"}`,
  ];
  if (input.panel.transition) lines.push(`转场：${input.panel.transition}`);
  if (input.panel.dialogue) lines.push(`表演语境（不要把文字画进图中）：${input.panel.dialogue}`);
  // P20：宫格覆盖——costumeState/sceneLighting 非空时抑制全部资产对应账本行，追加格级覆盖行（标注来源）。
  const suppressCostume = input.panel.costumeState.trim().length > 0;
  const suppressLighting = input.panel.sceneLighting.trim().length > 0;
  const allNegativeLocks: string[] = [];
  for (const asset of input.assets) {
    lines.push(
      `${asset.category === "character" ? "角色" : asset.category === "scene" ? "场景" : asset.category === "prop" ? "道具" : "风格"}「${asset.definition.name}」：${asset.role}`,
      `身份特征：${asset.definition.identityFeatures.join("；") || "以控制参考图为准"}`,
      `必须保持：${asset.definition.positiveLocks.join("；") || "以当前 approved 权威版本为准"}`,
      `禁止偏移：${asset.definition.negativeLocks.join("；") || "不得偏离当前权威版本"}`,
      `参考用途「${asset.definition.name}」：${asset.referenceUsage.purpose}`,
      `只继承「${asset.definition.name}」：${asset.referenceUsage.inheritOnly.join("；") || "none"}`,
      `禁止复制载体「${asset.definition.name}」：${asset.referenceUsage.excludeFromOutput.join("；") || "none"}`,
    );
    allNegativeLocks.push(...asset.definition.negativeLocks);
    for (const head of asset.continuity.heads) {
      if (suppressCostume && head.field === "costume") continue;
      if (suppressLighting && head.field === "lighting") continue;
      const interval = `[${head.scope.startMilliseconds},${head.scope.endMilliseconds})ms`;
      lines.push(head.state.status === "resolved"
        ? `连续性账本 ${head.field} ${interval}：${head.state.value}`
        : `连续性账本 ${head.field} ${interval}：not-applicable（${head.state.reason}）`);
    }
    if (asset.definition.defaultPrompt) lines.push(`资产提示词：${asset.definition.defaultPrompt}`);
  }
  if (suppressCostume) lines.push(`服装（宫格覆盖）：${input.panel.costumeState}`);
  if (suppressLighting) lines.push(`光线（宫格覆盖）：${input.panel.sceneLighting}`);
  const mergedNegative = mergeNegativePromptLines(allNegativeLocks, input.panel.negativePrompt);
  if (mergedNegative.length > 0) lines.push(`本格负提示词：${mergedNegative.join("；")}`);
  for (const asset of input.forbiddenAssets) {
    lines.push(
      `禁止出画资产「${asset.definition.name}」：${asset.role}`,
      `禁止约束：${asset.definition.negativeLocks.join("；")}`,
    );
  }
  lines.push("按逐参考“用途/只继承/禁止复制载体”合同使用 approved 控制参考；identity 参考保持身份一致，reference-only 参考的载体排除优先且不得被本句覆盖；不得自行换脸、换造型、改空间布局、改画风或增加未声明主体。");
  return lines.join("\n");
}

export function inferStudioPanelImageLayout(input: {
  visualAction: string;
  shotComposition: string;
  promptText: string;
}): NonNullable<StudioCodexModelPayload["layout"]> {
  const explicit = `${input.visualAction}\n${input.shotComposition}\n${input.promptText}`;
  if (/(?:电影宽银幕|电影横幅|横幅单幅|横屏|21\s*:\s*9|2\.(?:3[0-9]|4)\s*:\s*1)/u.test(explicit)) {
    return "cinematic-wide";
  }
  return "9:16-vertical";
}

export function effectiveStudioPanelImageLayout(
  modelPayload: Pick<StudioCodexModelPayload, "layout">,
): NonNullable<StudioCodexModelPayload["layout"]> {
  return modelPayload.layout ?? "9:16-vertical";
}

function buildRequest(input: {
  projectId: string;
  target: StudioGenerationTarget;
  scriptRevision: StudioFrozenTextRevision;
  promptRevision: StudioFrozenPromptRevision;
  panel: StudioGenerationPanelInstruction;
  assetBinding: StudioFrozenAssetBindingProvenance;
  panelReferenceResolution: PanelReferenceResolutionCore;
  continuity: StudioFrozenContinuitySnapshot;
  previousApprovedRaw?: StudioPreviousApprovedRawSnapshot;
  assets: StudioFrozenAssetReference[];
  forbiddenAssets: StudioFrozenForbiddenAsset[];
  previousStanding?: StudioPanelStandingHandoff | null;
}): StudioCodexGenerationRequest {
  const layout = inferStudioPanelImageLayout({
    visualAction: input.panel.visualAction,
    shotComposition: input.panel.shotComposition,
    promptText: input.promptRevision.body,
  });
  const modelPayload: StudioCodexModelPayload = {
    exactlyOneImage: true,
    layout,
    renderedPrompt: renderStudioPrompt({
      ...input,
      layout,
      ...(input.previousStanding ? { previousStanding: input.previousStanding } : {}),
    }),
    target: input.target,
    panel: input.panel,
    prompt: {
      revisionId: input.promptRevision.id,
      sha256: input.promptRevision.bodySha256,
      text: input.promptRevision.body,
    },
    assets: input.assets.map((asset) => ({
      assetId: asset.assetId,
      category: asset.category,
      presence: asset.presence,
      role: asset.role,
      referenceUsage: structuredClone(asset.referenceUsage),
      definitionVersionId: asset.definition.id,
      assetVersionId: asset.version.id,
      authorityEventId: asset.authority.eventId,
      mediaSha256: asset.media.sha256,
      identityFeatures: [...asset.definition.identityFeatures],
      positiveLocks: [...asset.definition.positiveLocks],
      negativeLocks: [...asset.definition.negativeLocks],
      defaultPrompt: asset.definition.defaultPrompt,
      continuity: structuredClone(asset.continuity),
      applicabilityEvaluation: freezeApplicabilityEvaluation(asset.applicabilityEvaluation),
      relations: asset.relations.map((relation) => structuredClone(relation)),
      sourceFingerprint: asset.sourceFingerprint,
    })),
    forbiddenAssets: input.forbiddenAssets.map((asset) => ({
      assetId: asset.assetId,
      category: asset.category,
      presence: "forbidden" as const,
      role: asset.role,
      definitionVersionId: asset.definition.id,
      authorityEventId: asset.authority.eventId,
      assetVersionId: asset.version.id,
      mediaSha256: asset.version.mediaSha256,
      name: asset.definition.name,
      negativeLocks: [...asset.definition.negativeLocks],
      applicabilityEvaluation: freezeApplicabilityEvaluation(asset.applicabilityEvaluation),
      relations: asset.relations.map((relation) => structuredClone(relation)),
      sourceFingerprint: asset.sourceFingerprint,
    })),
  };
  const safetyConstraints = input.forbiddenAssets.map((asset): StudioCodexSafetyConstraint => {
    const semantic = {
      assetId: asset.assetId,
      definitionVersionId: asset.definition.id,
      authorityEventId: asset.authority.eventId,
      assetVersionId: asset.version.id,
      mediaSha256: asset.version.mediaSha256,
      role: asset.role,
      negativeLocks: [...asset.definition.negativeLocks],
    };
    return { ...semantic, fingerprint: stableDigest(semantic) };
  });
  const continuityFrame = input.previousApprovedRaw
    ? (() => {
        const reference = previousRawReferenceInput(input.previousApprovedRaw, input.assets.map((asset) => asset.assetId)).control;
        const semantic: Omit<StudioCodexContinuityFrameControl, "fingerprint"> = {
          id: reference.id,
          kind: "continuity-frame",
          purpose: "continuity",
          coveredAssetIds: [...reference.coveredAssetIds],
          reviewId: input.previousApprovedRaw.reviewId,
          generationRunId: input.previousApprovedRaw.generationRunId,
          rawResultId: input.previousApprovedRaw.rawResultId,
          rawSha256: input.previousApprovedRaw.rawSha256,
          mediaSha256: input.previousApprovedRaw.rawSha256,
          localPath: input.previousApprovedRaw.rawLocalPath,
          packId: input.previousApprovedRaw.packId,
          packFingerprint: input.previousApprovedRaw.packFingerprint,
        };
        return { ...semantic, fingerprint: stableDigest(semantic) };
      })()
    : undefined;
  if (input.assets.length + (continuityFrame ? 1 : 0) > 6) {
    fail("too-many-references", "identity + continuity 控制引用合计超过 6 项。 ");
  }
  const referenceResolutionFingerprint = input.panelReferenceResolution.fingerprint;
  const semantic: Omit<StudioCodexGenerationRequest, "id" | "fingerprint"> = {
    schemaVersion: 4,
    kind: "studio-codex-generation-request",
    provenance: "asset-binding-set",
    projectId: input.projectId,
    executorKind: "agent-imagegen",
    allowedProviders: ["codex", "grok"] as const,
    exactlyOneImage: true,
    maxCalls: 1,
    target: input.target,
    sourceRevisions: {
      script: input.scriptRevision,
      prompt: input.promptRevision,
      sourceSpans: input.assetBinding.bindingSet.sourceSpans.map((span) => ({ ...span })),
    },
    assetBinding: {
      bindingSetId: input.assetBinding.bindingSet.id,
      bindingSetFingerprint: input.assetBinding.bindingSet.fingerprint,
      analysisId: input.assetBinding.analysis.id,
      analysisFingerprint: input.assetBinding.analysis.fingerprint,
      decisionFingerprints: input.assetBinding.decisions.map((decision) => decision.fingerprint),
      referenceResolutionFingerprint,
      provenanceFingerprint: input.assetBinding.fingerprint,
    },
    continuity: structuredClone(input.continuity),
    ...(input.previousApprovedRaw ? { previousApprovedRaw: structuredClone(input.previousApprovedRaw) } : {}),
    modelPayload,
    controlReferences: input.assets.map((asset) => ({
      assetId: asset.assetId,
      category: asset.category,
      presence: asset.presence,
      role: asset.role,
      referenceUsage: structuredClone(asset.referenceUsage),
      definitionVersionId: asset.definition.id,
      authorityEventId: asset.authority.eventId,
      assetVersionId: asset.version.id,
      mediaSha256: asset.media.sha256,
      localPath: asset.media.objectPath,
    })),
    ...(continuityFrame ? { continuityFrame } : {}),
    safetyConstraints,
  };
  const fingerprint = stableDigest(requestSemantic(semantic));
  return { ...semantic, id: `studio-codex-request-${fingerprint.slice(0, 32)}`, fingerprint };
}

async function currentBindingSource(
  projectRoot: string,
  binding: StudioPanelAssetBinding,
  target: StudioAssetApplicabilityTarget,
): Promise<StudioAssetBindingSourceSnapshot> {
  return buildStudioAssetBindingSourceSnapshot(projectRoot, {
    assetId: binding.assetId,
    category: binding.category,
    presence: binding.presence,
    role: binding.role,
  }, target);
}

/**
 * 从真实规范资产、approved 主权威、CAS 实测和目标适用范围构建 BindingSet 来源。
 * 调用方不能自行声明 definition/authority/media/knowledge 指纹。
 */
export async function buildStudioAssetBindingSourceSnapshot(
  projectRoot: string,
  input: {
    assetId: string;
    category: StudioAssetCategory;
    presence: StudioAssetPresence;
    role: string;
  },
  target: StudioAssetApplicabilityTarget,
): Promise<StudioAssetBindingSourceSnapshot> {
  if (input.presence !== "required" && input.presence !== "optional" && input.presence !== "forbidden") {
    fail("panel-asset-invalid", "binding presence 必须是 required、optional 或 forbidden。");
  }
  const mention: StudioBindingAssetInput = {
    assetId: requiredId(input.assetId, "binding assetId"),
    category: input.category,
    presence: input.presence,
    role: requiredId(input.role, "binding role"),
  };
  const loaded = await loadCanonicalKnowledge(projectRoot, mention, target);
  const version = selectAuthorityVersion(loaded.detail);
  const frozenVersion = freezeVersion(version);
  const authority = currentAuthorityEvent(loaded.detail, version.id);
  const media = await readStudioMedia(projectRoot, version.mediaSha256);
  if (!media) fail("media-missing", `BindingSet 资产 ${input.assetId} 的权威媒体不存在。`);
  if (!await verifyStudioMedia(projectRoot, media.sha256, media.objectPath)) {
    fail("media-drift", `BindingSet 资产 ${input.assetId} 的权威媒体 CAS 已漂移。`, [media.objectPath]);
  }
  return {
    assetId: loaded.detail.id,
    category: loaded.detail.category,
    assetRevision: loaded.detail.revision,
    definitionVersionId: loaded.definition.id,
    authorityEventId: authority.id,
    authorityVersionId: authority.versionId,
    assetVersionId: frozenVersion.id,
    mediaSha256: frozenVersion.mediaSha256,
    knowledgeFingerprint: loaded.knowledgeFingerprint,
    applicabilityFingerprint: loaded.applicabilityFingerprint,
  };
}

function freezeDecision(decision: StudioMentionDecisionReceipt): StudioFrozenAssetBindingDecision {
  return {
    id: decision.id,
    proposalId: decision.proposalId,
    proposalFingerprint: decision.proposalFingerprint,
    action: decision.action,
    ...(decision.selectedAssetId ? { selectedAssetId: decision.selectedAssetId } : {}),
    presence: decision.presence,
    role: decision.role,
    reviewer: decision.reviewer,
    note: decision.note,
    fingerprint: decision.fingerprint,
    createdAt: decision.createdAt,
  };
}

function assertBindingResolutionComplete(
  bindingSet: StudioAssetBindingSet,
  analysis: StudioAssetMentionAnalysis,
  decisions: StudioMentionDecisionReceipt[],
): Map<string, StudioMentionDecisionReceipt> {
  const unresolvedOptional = new Set(bindingSet.unresolvedOptionalMentionIds);
  const byProposal = new Map(decisions.map((decision) => [decision.proposalId, decision] as const));
  if (byProposal.size !== decisions.length || decisions.length !== bindingSet.decisionReceiptIds.length) {
    fail("asset-binding-ambiguous", `BindingSet ${bindingSet.id} 的 decision receipt 不唯一或缺失。`);
  }
  const boundMentions = new Map<string, StudioPanelAssetBinding>();
  for (const binding of bindingSet.bindings) {
    if (binding.mentionIds.length === 0) fail("asset-binding-unconfirmed", `资产绑定 ${binding.assetId} 没有来源 mention。`);
    for (const mentionId of binding.mentionIds) {
      if (boundMentions.has(mentionId)) fail("asset-binding-ambiguous", `mention ${mentionId} 被多个资产绑定消费。`);
      boundMentions.set(mentionId, binding);
    }
  }
  for (const proposal of analysis.proposals) {
    const decision = byProposal.get(proposal.id);
    if (!decision) {
      if (proposal.presence === "optional" && unresolvedOptional.has(proposal.mentionId)
        && !boundMentions.has(proposal.mentionId)) continue;
      fail("asset-binding-unconfirmed", `提及 ${proposal.mentionId} 缺少人工确认 decision。`);
    }
    if (decision.proposalFingerprint !== proposal.fingerprint
      || !SHA256_PATTERN.test(decision.proposalFingerprint) || !SHA256_PATTERN.test(decision.fingerprint)) {
      fail("asset-binding-drift", `提及 ${proposal.mentionId} 的 decision fingerprint 无效。`);
    }
    const binding = boundMentions.get(proposal.mentionId);
    if (decision.action === "exclude") {
      if (binding) fail("asset-binding-ambiguous", `已 exclude 的提及 ${proposal.mentionId} 仍进入引用解析。`);
      continue;
    }
    if (!decision.selectedAssetId || !binding || binding.assetId !== decision.selectedAssetId) {
      fail("asset-binding-unconfirmed", `提及 ${proposal.mentionId} 尚未唯一解析到当前 BindingSet 资产。`);
    }
    const selectedCandidate = proposal.candidates.find((candidate) => candidate.assetId === decision.selectedAssetId);
    if (!selectedCandidate || selectedCandidate.category !== binding.category) {
      fail("asset-binding-drift", `提及 ${proposal.mentionId} 的当前 decision 候选分类与 BindingSet 不一致。`);
    }
    if ((proposal.status === "ambiguous" || proposal.status === "unmatched") && decision.action !== "select") {
      fail("asset-binding-unconfirmed", `提及 ${proposal.mentionId} 的 ${proposal.status} 尚未被显式 select 解决。`);
    }
  }
  if (boundMentions.size !== analysis.proposals.filter((proposal) => {
    const decision = byProposal.get(proposal.id);
    return decision !== undefined && decision.action !== "exclude";
  }).length) {
    fail("asset-binding-ambiguous", `BindingSet ${bindingSet.id} 的 mention 引用闭包不完整。`);
  }
  for (const binding of bindingSet.bindings) {
    const bindingDecisions = analysis.proposals
      .filter((proposal) => binding.mentionIds.includes(proposal.mentionId))
      .map((proposal) => byProposal.get(proposal.id))
      .filter((decision): decision is StudioMentionDecisionReceipt => decision !== undefined && decision.action !== "exclude");
    if (bindingDecisions.length !== binding.mentionIds.length
      || bindingDecisions.some((decision) => decision.selectedAssetId !== binding.assetId || decision.role !== binding.role)) {
      fail("asset-binding-drift", `资产 ${binding.assetId} 的当前 decision selected asset/role 与冻结 binding 不一致。`);
    }
    const presences = new Set(bindingDecisions.map((decision) => decision.presence));
    if (presences.has("forbidden") && presences.size > 1) {
      fail("asset-binding-ambiguous", `资产 ${binding.assetId} 的当前 decision 同时声明 forbidden 与可见 presence。`);
    }
    const expectedPresence: StudioAssetPresence = presences.has("forbidden")
      ? "forbidden"
      : presences.has("required")
        ? "required"
        : "optional";
    if (binding.presence !== expectedPresence) {
      fail("asset-binding-drift", `资产 ${binding.assetId} 的当前 decision presence 与冻结 binding 不一致。`);
    }
  }
  return byProposal;
}

async function freezeCurrentAssetBindingUncached(
  projectRoot: string,
  unitId: string,
  panel: StudioProductionPanel,
  panelBindingScopeFingerprint: string,
  target: StudioAssetApplicabilityTarget,
): Promise<{ bindingSet: StudioAssetBindingSet; provenance: StudioFrozenAssetBindingProvenance; bindings: {
  allowed: StudioPanelAssetBinding[];
  forbidden: StudioPanelAssetBinding[];
} }> {
  const bindingSet = await getCurrentStudioPanelAssetBindingSet(projectRoot, unitId, panel.id);
  if (!bindingSet) {
    fail(
      "asset-binding-missing",
      `panel ${panel.id} 缺少 current confirmed AssetBindingSet；历史 panel.assets 永不作为 generation 回退输入。`,
    );
  }
  const historicalScopeFingerprint = await getStudioPanelBindingScopeFingerprint(
    projectRoot,
    unitId,
    panel.index,
    bindingSet.unitRevision,
  );
  if (bindingSet.unitId !== unitId || bindingSet.panelIndex !== panel.index
    || historicalScopeFingerprint === null
    || historicalScopeFingerprint !== panelBindingScopeFingerprint
    || bindingSet.promptRevisionId !== panel.promptRevisionId
    || bindingSet.promptSha256 !== panel.promptRevision.bodySha256) {
    fail("asset-binding-stale", `BindingSet ${bindingSet.id} 与当前单元或 panel 修订不一致。`);
  }
  const analysis = await getStudioAssetMentionAnalysis(projectRoot, bindingSet.analysisId);
  if (!analysis || analysis.id !== bindingSet.analysisId || analysis.unitId !== unitId
    || analysis.panelIndex !== panel.index || analysis.fingerprint === "") {
    fail("asset-binding-drift", `BindingSet ${bindingSet.id} 的 analysis 证据缺失或归属漂移。`);
  }
  const decisions = await getStudioMentionDecisions(projectRoot, bindingSet.decisionReceiptIds);
  const decisionByProposal = assertBindingResolutionComplete(bindingSet, analysis, decisions);
  const identityKeyFingerprints: Record<string, string> = {};
  for (const proposal of analysis.proposals) {
    const key = studioIdentityDependencyKey(proposal.surfaceText, proposal.category);
    const fingerprint = await readStudioMentionIdentityKeyFingerprint(
      projectRoot,
      proposal.surfaceText,
      proposal.category,
    );
    if (identityKeyFingerprints[key] && identityKeyFingerprints[key] !== fingerprint) {
      fail("asset-binding-ambiguous", `analysis ${analysis.id} 的 identity key 不唯一：${key}`);
    }
    identityKeyFingerprints[key] = fingerprint;
  }
  const sources: StudioAssetBindingSourceSnapshot[] = [];
  for (const binding of bindingSet.bindings) {
    sources.push(await currentBindingSource(projectRoot, binding, target));
  }
  const context: StudioAssetBindingCurrentContext = { identityKeyFingerprints, assets: sources };
  const readiness = await getStudioAssetBindingReadiness(projectRoot, bindingSet.id, context);
  if (!readiness) fail("asset-binding-missing", `BindingSet ${bindingSet.id} 无法读取 readiness。`);
  if (!readiness.head || !readiness.current || !readiness.ready) {
    fail(
      "asset-binding-stale",
      `BindingSet ${bindingSet.id} 不是 current + ready，禁止生成。`,
      readiness.blockers.length > 0 ? [...readiness.blockers] : [...readiness.staleReasons],
    );
  }
  const sourceByAsset = new Map(sources.map((source) => [source.assetId, source] as const));
  const assetResolutionSnapshots = bindingSet.bindings.map((binding): StudioFrozenAssetResolutionSnapshot => {
    const source = sourceByAsset.get(binding.assetId);
    if (!source) fail("asset-binding-drift", `BindingSet ${bindingSet.id} 缺少当前来源 ${binding.assetId}。`);
    const semantic = {
      assetId: binding.assetId,
      category: binding.category,
      presence: binding.presence,
      role: binding.role,
      mentionIds: [...binding.mentionIds],
      definitionVersionId: source.definitionVersionId,
      authorityEventId: source.authorityEventId,
      authorityVersionId: source.authorityVersionId,
      assetVersionId: source.assetVersionId,
      mediaSha256: source.mediaSha256,
      knowledgeFingerprint: source.knowledgeFingerprint,
      applicabilityFingerprint: source.applicabilityFingerprint,
      bindingSemanticFingerprint: binding.semanticFingerprint,
    };
    return { ...semantic, fingerprint: stableDigest(semantic) };
  }).sort((left, right) => left.assetId.localeCompare(right.assetId, "en"));
  const frozenDecisions = decisions.map(freezeDecision).sort((left, right) => left.id.localeCompare(right.id, "en"));
  const sectionFingerprints = new Map<string, string>();
  for (const sectionRevisionId of [...new Set(analysis.proposals.flatMap((proposal) => proposal.sectionRevisionId ? [proposal.sectionRevisionId] : []))]) {
    const section = await getStudioScriptSectionRevision(projectRoot, sectionRevisionId);
    if (!section) fail("asset-binding-drift", `analysis ${analysis.id} 引用的章节/场景修订不存在：${sectionRevisionId}`);
    sectionFingerprints.set(sectionRevisionId, section.fingerprint);
  }
  const frozenProposals = analysis.proposals.map((proposal): StudioFrozenAssetBindingProposal => {
    const decision = decisionByProposal.get(proposal.id);
    return {
      id: proposal.id,
      mentionId: proposal.mentionId,
      startOffsetUtf16: proposal.startOffsetUtf16,
      endOffsetUtf16: proposal.endOffsetUtf16,
      surfaceSha256: proposal.surfaceSha256,
      ...(proposal.sectionRevisionId ? {
        sectionRevisionId: proposal.sectionRevisionId,
        sectionFingerprint: sectionFingerprints.get(proposal.sectionRevisionId)!,
      } : {}),
      presence: proposal.presence,
      role: proposal.role,
      status: proposal.status,
      normalizedIdentityKey: proposal.normalizedIdentityKey,
      candidateSetFingerprint: proposal.candidateSetFingerprint,
      ...(decision ? { decisionReceiptId: decision.id } : {}),
      ...(decision?.selectedAssetId ? { resolvedAssetId: decision.selectedAssetId } : {}),
      unresolvedOptional: decision === undefined,
    };
  }).sort((left, right) => left.mentionId.localeCompare(right.mentionId, "en"));
  const provenanceWithoutFingerprint: Omit<StudioFrozenAssetBindingProvenance, "fingerprint"> = {
    bindingSet: {
      id: bindingSet.id,
      revision: bindingSet.revision,
      fingerprint: bindingSet.fingerprint,
      analysisId: bindingSet.analysisId,
      unitId: bindingSet.unitId,
      unitRevision: bindingSet.unitRevision,
      unitFingerprint: bindingSet.unitFingerprint,
      panelBindingScopeFingerprint,
      panelIndex: bindingSet.panelIndex,
      scriptRevisionId: bindingSet.scriptRevisionId,
      scriptSha256: bindingSet.scriptSha256,
      promptRevisionId: bindingSet.promptRevisionId,
      promptSha256: bindingSet.promptSha256,
      sourceSpans: panel.sourceSpans.map((span) => ({ ...span })),
    },
    analysis: {
      id: analysis.id,
      revision: analysis.revision,
      fingerprint: analysis.fingerprint,
      resolverVersion: analysis.resolverVersion,
      proposals: frozenProposals,
    },
    decisions: frozenDecisions,
    assetResolutionSnapshots,
    currentness: {
      head: true,
      current: true,
      ready: true,
      staleReasons: [],
      blockers: [],
      warnings: [...readiness.warnings],
    },
  };
  const provenance: StudioFrozenAssetBindingProvenance = {
    ...provenanceWithoutFingerprint,
    fingerprint: stableDigest(provenanceWithoutFingerprint),
  };
  return {
    bindingSet,
    provenance,
    bindings: {
      allowed: bindingSet.bindings.filter((entry) => entry.presence !== "forbidden")
        .sort((left, right) => left.assetId.localeCompare(right.assetId, "en")),
      forbidden: bindingSet.bindings.filter((entry) => entry.presence === "forbidden")
        .sort((left, right) => left.assetId.localeCompare(right.assetId, "en")),
    },
  };
}

function freezeCurrentAssetBinding(
  projectRoot: string,
  unitId: string,
  panel: StudioProductionPanel,
  panelBindingScopeFingerprint: string,
  target: StudioAssetApplicabilityTarget,
): ReturnType<typeof freezeCurrentAssetBindingUncached> {
  return memoStudioUnitGridRead(
    projectRoot,
    `production:current-asset-binding:${stableDigest({
      unitId,
      panelId: panel.id,
      panelIndex: panel.index,
      panelBindingScopeFingerprint,
      target,
    })}`,
    () => freezeCurrentAssetBindingUncached(
      projectRoot,
      unitId,
      panel,
      panelBindingScopeFingerprint,
      target,
    ),
  );
}

async function buildFreezePackInternal(
  projectRoot: string,
  input: StudioGenerationQueryInput,
  preflightShell?: Awaited<ReturnType<typeof inspectManagedProject>>,
): Promise<StudioGenerationFreezePack> {
  const unitId = requiredId(input.unitId, "unitId");
  const panelId = requiredId(input.panelId, "panelId");
  let shell: Awaited<ReturnType<typeof inspectManagedProject>>;
  if (preflightShell) {
    shell = preflightShell;
  } else {
    try {
      shell = await inspectManagedProject(projectRoot);
    } catch (error) {
      throw new StudioGenerationFreezeError(
        "unmanaged-project",
        "Codex 一致性冻结包只允许读取通过验证的受管项目。",
        [error instanceof Error ? error.message : String(error)],
        { cause: error },
      );
    }
  }
  const root = shell.paths.root;
  const snapshot = await readStudioProductionUnitSnapshot(root, unitId);
  if (!snapshot) fail("unit-not-found", `15 秒生产单元不存在：${unitId}`);
  const panelCandidates = snapshot.panels.filter((candidate) => candidate.id === panelId);
  if (panelCandidates.length === 0) fail("panel-not-found", `生产单元 ${unitId} 不包含 panel ${panelId}。`);
  if (panelCandidates.length !== 1) fail("panel-asset-invalid", `panel ${panelId} 在单元快照中不唯一。`);
  const panel = panelCandidates[0]!;
  const panelBindingScopeFingerprint = createStudioPanelBindingScopeFingerprint(snapshot, panel.index);
  assertTextRevisionBody(snapshot.scriptRevision, "script");
  assertTextRevisionBody(panel.promptRevision, "prompt");
  if (panel.promptRevisionId !== panel.promptRevision.id) fail("revision-drift", `panel ${panelId} 的 prompt revision 引用已漂移。`);
  const timeContext = getStudioProductionPanelTimeContext(snapshot.unit, panel);
  const { episodeAbsoluteStartSeconds, episodeAbsoluteEndSeconds } = timeContext;
  const target: StudioGenerationTarget = {
    unitId: snapshot.unit.id,
    seasonId: snapshot.unit.season,
    episodeId: snapshot.unit.episode,
    unitSequence: snapshot.unit.sequence,
    unitRevision: snapshot.unit.revision,
    panelId: panel.id,
    panelIndex: panel.index,
    panelCount: snapshot.unit.panelCount,
    unitLocalStartSeconds: timeContext.unitLocalStartSeconds,
    unitLocalEndSeconds: timeContext.unitLocalEndSeconds,
    episodeAbsoluteStartSeconds,
    episodeAbsoluteEndSeconds,
    durationSeconds: panel.durationSeconds,
    totalDurationSeconds: snapshot.unit.durationSeconds,
  };
  const applicabilityTarget: StudioAssetApplicabilityTarget = {
    projectId: shell.project.id,
    seasonId: snapshot.unit.season,
    episodeId: snapshot.unit.episode,
    unitId: snapshot.unit.id,
    unitLocalStartSeconds: timeContext.unitLocalStartSeconds,
    unitLocalEndSeconds: timeContext.unitLocalEndSeconds,
    episodeAbsoluteStartSeconds,
    episodeAbsoluteEndSeconds,
  };
  const binding = await freezeCurrentAssetBinding(root, unitId, panel, panelBindingScopeFingerprint, applicabilityTarget);
  // 其他宫格可在本格绑定后独立修订；生成身份仍锚定本格 BindingSet 的历史单元修订。
  target.unitRevision = binding.bindingSet.unitRevision;
  const bindings = binding.bindings;
  const continuity = await freezePanelContinuity(root, target, bindings.allowed);
  const continuityByAsset = new Map(continuity.assets.map((entry) => [entry.assetId, entry] as const));
  let previousApprovedRaw: StudioPreviousApprovedRawSnapshot | undefined;
  let previousReference: ReturnType<typeof previousRawReferenceInput> | undefined;
  if (input.previousApprovedRawReviewId !== undefined) {
    if (bindings.allowed.length === 0) {
      fail("previous-raw-invalid", "没有允许资产的 panel 不得注入 continuity-frame。");
    }
    previousApprovedRaw = await freezePreviousApprovedRaw(root, input.previousApprovedRawReviewId, target);
    previousReference = previousRawReferenceInput(
      previousApprovedRaw,
      bindings.allowed.map((entry) => entry.assetId),
    );
  }
  const assets: StudioFrozenAssetReference[] = [];
  for (const assetBinding of bindings.allowed) {
    const assetContinuity = continuityByAsset.get(assetBinding.assetId);
    if (!assetContinuity) fail("continuity-drift", `允许资产 ${assetBinding.assetId} 缺少冻结 continuity snapshot。`);
    assets.push(await freezeAllowedAsset(root, assetBinding, applicabilityTarget, assetContinuity));
  }
  if (assets.length + (previousApprovedRaw ? 1 : 0) > 6) {
    fail("too-many-references", `panel ${panelId} 的 identity + continuity 控制参考超过单张图片最多 6 项；请先建立经审核的组合派生资产。`);
  }
  const forbiddenAssets: StudioFrozenForbiddenAsset[] = [];
  for (const assetBinding of bindings.forbidden) {
    forbiddenAssets.push(await freezeForbiddenAsset(root, assetBinding, applicabilityTarget));
  }
  const forbiddenIds = new Set(forbiddenAssets.map((asset) => asset.assetId));
  if (assets.some((asset) => forbiddenIds.has(asset.assetId))) fail("panel-asset-invalid", "forbidden 资产不得进入引用集。");
  const panelReferenceResolution = adaptStudioBindingSetToPanelReferenceResolution({
    projectId: shell.project.id,
    target,
    bindingSet: binding.bindingSet,
    frozen: binding.provenance,
    continuityControlReferences: previousReference ? [previousReference.control] : [],
    continuityDependencies: [
      ...continuityDependencies(continuity),
      ...(previousReference?.dependencies ?? []),
    ],
  });
  assertPanelReferenceResolutionIntegrity(panelReferenceResolution);
  if (!panelReferenceResolution.generationReady || panelReferenceResolution.closure === "unresolved") {
    fail(
      "asset-binding-unconfirmed",
      `panel ${panelId} 的统一引用闭包未达到 generation-ready。`,
      panelReferenceResolution.blockers.map((entry) => `${entry.code}:${entry.message}`),
    );
  }
  const resolutionByAsset = new Map(binding.provenance.assetResolutionSnapshots.map((entry) => [entry.assetId, entry] as const));
  for (const asset of assets) {
    const resolution = resolutionByAsset.get(asset.assetId);
    if (!resolution || resolution.presence === "forbidden"
      || resolution.definitionVersionId !== asset.definition.id
      || resolution.authorityEventId !== asset.authority.eventId
      || resolution.authorityVersionId !== asset.authority.versionId
      || resolution.assetVersionId !== asset.version.id
      || resolution.mediaSha256 !== asset.media.sha256) {
      fail("asset-binding-drift", `允许资产 ${asset.assetId} 与 BindingSet 引用解析身份不一致。`);
    }
  }
  for (const asset of forbiddenAssets) {
    const resolution = resolutionByAsset.get(asset.assetId);
    if (!resolution || resolution.presence !== "forbidden"
      || resolution.definitionVersionId !== asset.definition.id
      || resolution.authorityEventId !== asset.authority.eventId
      || resolution.authorityVersionId !== asset.authority.versionId
      || resolution.assetVersionId !== asset.version.id
      || resolution.mediaSha256 !== asset.version.mediaSha256) {
      fail("asset-binding-drift", `禁止资产 ${asset.assetId} 与 BindingSet 安全约束身份不一致。`);
    }
  }
  if (resolutionByAsset.size !== assets.length + forbiddenAssets.length) {
    fail("asset-binding-ambiguous", `BindingSet ${binding.bindingSet.id} 的引用闭包与派生控制平面不一致。`);
  }

  const currentSnapshot = await readStudioProductionUnitSnapshot(root, unitId);
  const currentPanel = currentSnapshot?.panels.find((candidate) => candidate.id === panelId);
  if (!currentSnapshot || !currentPanel
    || createStudioPanelBindingScopeFingerprint(currentSnapshot, currentPanel.index) !== panelBindingScopeFingerprint) {
    fail("revision-drift", `生产单元 ${unitId} 的目标宫格在冻结期间发生修订漂移。`);
  }
  const currentBinding = await freezeCurrentAssetBinding(
    root,
    unitId,
    currentPanel,
    panelBindingScopeFingerprint,
    applicabilityTarget,
  );
  if (currentBinding.bindingSet.id !== binding.bindingSet.id
    || currentBinding.bindingSet.fingerprint !== binding.bindingSet.fingerprint
    || currentBinding.provenance.fingerprint !== binding.provenance.fingerprint) {
    fail("asset-binding-drift", `BindingSet ${binding.bindingSet.id} 在冻结期间发生 currentness 或解析身份漂移。`);
  }
  const scriptRevision = freezeTextRevision(snapshot.scriptRevision);
  const promptRevision = freezePromptRevision(panel.promptRevision);
  const instruction = panelInstruction(panel);
  const previousStanding = pickPreviousPanelStanding(snapshot.panels, panel.index);
  const request = buildRequest({
    projectId: shell.project.id,
    target,
    scriptRevision,
    promptRevision,
    panel: instruction,
    assetBinding: binding.provenance,
    panelReferenceResolution,
    continuity,
    ...(previousApprovedRaw ? { previousApprovedRaw } : {}),
    assets,
    forbiddenAssets,
    ...(previousStanding ? { previousStanding } : {}),
  });
  const semantic: Omit<StudioGenerationFreezePack, "id" | "fingerprint"> = {
    schemaVersion: 4,
    kind: "studio-generation-freeze-pack",
    provenance: "asset-binding-set",
    projectId: shell.project.id,
    managedManifestFingerprint: shell.manifestFingerprint,
    unitSnapshotFingerprint: panelBindingScopeFingerprint,
    target,
    scriptRevision,
    promptRevision,
    panel: instruction,
    assetBinding: binding.provenance,
    panelReferenceResolution,
    continuity,
    ...(previousApprovedRaw ? { previousApprovedRaw } : {}),
    assets,
    forbiddenAssets,
    request,
  };
  const fingerprint = stableDigest(semantic);
  return { ...semantic, id: `studio-generation-freeze-${fingerprint.slice(0, 32)}`, fingerprint };
}

/**
 * 严格入口：任何受管身份、revision、authority、approved 状态或 CAS SHA 问题都抛错，
 * 不会返回降级包。
 */
export async function buildStudioGenerationFreezePack(
  projectRoot: string,
  input: StudioGenerationQueryInput,
): Promise<StudioGenerationFreezePack> {
  try {
    return await buildFreezePackInternal(projectRoot, input);
  } catch (error) {
    if (error instanceof StudioGenerationFreezeError) throw error;
    throw new StudioGenerationFreezeError(
      "storage-invalid",
      "生产快照或素材库无法通过冻结验证。",
      [error instanceof Error ? error.message : String(error)],
      { cause: error },
    );
  }
}

/**
 * @internal unit-grid 已在 read epoch 外完成受管工程 preflight；逐格构建复用同一
 * 只读 shell，避免每格重新初始化 generation ledger。普通 panel API 不走此入口。
 */
export async function buildStudioGenerationFreezePackForUnitGridReadEpoch(
  projectRoot: string,
  input: StudioGenerationQueryInput,
  preflightShell: Awaited<ReturnType<typeof inspectManagedProject>>,
): Promise<StudioGenerationFreezePack> {
  try {
    return await buildFreezePackInternal(projectRoot, input, preflightShell);
  } catch (error) {
    if (error instanceof StudioGenerationFreezeError
      || error instanceof StudioUnitGridReadEpochDriftError) throw error;
    throw new StudioGenerationFreezeError(
      "storage-invalid",
      "生产快照或素材库无法通过 unit-grid 只读冻结验证。",
      [error instanceof Error ? error.message : String(error)],
      { cause: error },
    );
  }
}

/** 查询入口：blocked 结果绝不包含 request，防止调用方绕过失败关闭。 */
export async function queryStudioGenerationFreeze(
  projectRoot: string,
  input: StudioGenerationQueryInput,
): Promise<StudioGenerationQueryResult> {
  try {
    const pack = await buildStudioGenerationFreezePack(projectRoot, input);
    return { status: "ready", packId: pack.id, fingerprint: pack.fingerprint, pack, request: pack.request };
  } catch (error) {
    if (!(error instanceof StudioGenerationFreezeError)) throw error;
    return { status: "blocked", code: error.code, message: error.message, details: [...error.details] };
  }
}

const STUDIO_REFERENCE_PURPOSES = new Set<StudioReferenceUsage["purpose"]>([
  "identity",
  "continuity",
  "composition-hint",
  "scale-reference",
]);

function assertStudioReferenceUsage(
  usage: StudioReferenceUsage,
  label: string,
): void {
  if (!STUDIO_REFERENCE_PURPOSES.has(usage.purpose)
    || (usage.carrierPolicy !== "none" && usage.carrierPolicy !== "reference-only")
    || !Array.isArray(usage.inheritOnly) || usage.inheritOnly.length === 0
    || usage.inheritOnly.some((entry) => typeof entry !== "string" || entry.trim() !== entry || !entry)
    || new Set(usage.inheritOnly).size !== usage.inheritOnly.length
    || !Array.isArray(usage.excludeFromOutput)
    || usage.excludeFromOutput.some((entry) => typeof entry !== "string" || entry.trim() !== entry || !entry)
    || new Set(usage.excludeFromOutput).size !== usage.excludeFromOutput.length
    || (usage.carrierPolicy === "reference-only" && usage.excludeFromOutput.length === 0)) {
    fail("input-drift", `${label} 的 referenceUsage 无效。`);
  }
}

function assertRequestIntegrity(request: StudioCodexGenerationRequest): void {
  if (request.schemaVersion !== 4 || request.kind !== "studio-codex-generation-request"
    || request.provenance !== "asset-binding-set") {
    fail("input-drift", "Agent 生图请求必须是 schema v4 / asset-binding-set；v3 仅供历史读取，禁止进入执行面。");
  }
  if (request.executorKind !== "agent-imagegen" && request.executorKind !== "codex-imagegen") {
    fail("input-drift", "executorKind 必须是 agent-imagegen（或历史 codex-imagegen）。");
  }
  if (!Array.isArray(request.allowedProviders) || request.allowedProviders.length === 0) {
    fail("input-drift", "allowedProviders 不能为空。");
  }
  const allowed = [...request.allowedProviders].sort((a, b) => a.localeCompare(b, "en"));
  if (allowed.some((provider) => provider !== "codex" && provider !== "grok")) {
    fail("input-drift", "allowedProviders 只能包含 codex 与 grok。");
  }
  if (JSON.stringify(allowed) !== JSON.stringify([...request.allowedProviders].sort((a, b) => a.localeCompare(b, "en")))) {
    // already sorted check above for content; require deterministic ascending for fingerprint stability
  }
  if (request.executorKind === "agent-imagegen") {
    if (allowed.join(",") !== "codex,grok") {
      fail("input-drift", "agent-imagegen 新包必须同时允许 codex 与 grok。");
    }
  }
  if (request.exactlyOneImage !== true || request.maxCalls !== 1) {
    fail("input-drift", "正式 Agent 生图必须 exactlyOneImage=true 且 maxCalls=1。");
  }
  if (request.modelPayload.layout !== undefined
    && request.modelPayload.layout !== "9:16-vertical"
    && request.modelPayload.layout !== "cinematic-wide") {
    fail("input-drift", "单镜 Agent 生图 layout 必须是 9:16-vertical 或 cinematic-wide。");
  }
  const { id: _id, fingerprint: _fingerprint, ...semantic } = request;
  const fingerprint = stableDigest(requestSemantic(semantic));
  if (request.fingerprint !== fingerprint || request.id !== `studio-codex-request-${fingerprint.slice(0, 32)}`) {
    fail("input-drift", "Agent 生图请求包内容与内容地址不一致。");
  }
  assertContinuitySnapshotIntegrity(request.continuity);
  const expectedContinuityScope = panelContinuityScope(request.target);
  if (request.continuity.scope.fingerprint !== expectedContinuityScope.fingerprint) {
    fail("continuity-drift", "Codex 请求的 continuity snapshot 不属于目标 panel 精确半开区间。");
  }
  const script = request.sourceRevisions.script;
  if (!SHA256_PATTERN.test(script.bodySha256)
    || !Number.isSafeInteger(script.bodySizeBytes) || script.bodySizeBytes < 0
    || !Number.isSafeInteger(script.bodySizeUtf16) || script.bodySizeUtf16 < 0) {
    fail("input-drift", "Codex 请求中的剧本修订身份或长度无效。");
  }
  const sourceSpans = request.sourceRevisions.sourceSpans;
  // P20 合同：extension（扩写）格禁锚定剧本 spans（studio-production.ts normalizeUnitDraft 强制为空），
  // 因此 sourceSpans=0 对 extension 格是合法形态；original 格仍必须携带 1–64 个有界 span。
  const isExtensionPanel = request.modelPayload.panel.shotType === "extension";
  if (!Array.isArray(sourceSpans) || sourceSpans.length > 64 || (sourceSpans.length === 0 && !isExtensionPanel)) {
    fail("input-drift", "Codex 请求必须携带 1–64 个有界剧本 source span（extension 扩写格豁免，必须为 0 个）。");
  }
  if (isExtensionPanel && sourceSpans.length > 0) {
    fail("input-drift", "extension 扩写格不得携带剧本 source span。");
  }
  let previousEnd = 0;
  for (const [index, span] of sourceSpans.entries()) {
    if (span.scriptRevisionId !== script.id || span.scriptSha256 !== script.bodySha256
      || !SHA256_PATTERN.test(span.surfaceSha256)
      || !Number.isSafeInteger(span.startOffsetUtf16) || !Number.isSafeInteger(span.endOffsetUtf16)
      || span.startOffsetUtf16 < 0 || span.endOffsetUtf16 <= span.startOffsetUtf16
      || span.endOffsetUtf16 > script.bodySizeUtf16
      || (index > 0 && span.startOffsetUtf16 < previousEnd)) {
      fail("input-drift", `Codex 请求的剧本 source span ${index + 1} 无法由冻结剧本修订验证。`);
    }
    previousEnd = span.endOffsetUtf16;
  }
  const forbiddenIds = new Set(request.modelPayload.forbiddenAssets.map((asset) => asset.assetId));
  if (request.controlReferences.some((reference) => forbiddenIds.has(reference.assetId))) {
    fail("input-drift", "Codex 请求包将 forbidden 资产放入了控制引用。");
  }
  if (request.modelPayload.forbiddenAssets.some((asset) => "continuity" in asset)) {
    fail("continuity-drift", "forbidden 资产不得被呈现为 continuity-confirmed。");
  }
  const continuityByAsset = new Map(request.continuity.assets.map((asset) => [asset.assetId, asset] as const));
  const visibleIds = request.modelPayload.assets.map((asset) => asset.assetId);
  if (continuityByAsset.size !== visibleIds.length || new Set(visibleIds).size !== visibleIds.length) {
    fail("continuity-drift", "Codex 请求的可见资产与 continuity snapshot 集合不闭合。");
  }
  for (const asset of request.modelPayload.assets) {
    const continuity = continuityByAsset.get(asset.assetId);
    if (!continuity || stableDigest(asset.continuity) !== stableDigest(continuity)) {
      fail("continuity-drift", `Codex 请求资产 ${asset.assetId} 的 continuity snapshot 不一致。`);
    }
  }
  const usageContractPresent = request.modelPayload.assets.some((asset) => asset.referenceUsage !== undefined)
    || request.controlReferences.some((reference) => reference.referenceUsage !== undefined);
  if (usageContractPresent) {
    if (request.modelPayload.assets.some((asset) => asset.referenceUsage === undefined)
      || request.controlReferences.some((reference) => reference.referenceUsage === undefined)) {
      fail("input-drift", "Codex 请求的 referenceUsage 合同不完整。");
    }
    const modelAssetById = new Map(request.modelPayload.assets.map((asset) => [asset.assetId, asset] as const));
    if (modelAssetById.size !== request.controlReferences.length) {
      fail("input-drift", "Codex 请求的 referenceUsage 资产闭包与控制引用数量不一致。");
    }
    for (const reference of request.controlReferences) {
      const modelAsset = modelAssetById.get(reference.assetId);
      if (!modelAsset?.referenceUsage || !reference.referenceUsage) {
        fail("input-drift", `Codex 请求控制引用 ${reference.assetId} 缺少 referenceUsage。`);
      }
      assertStudioReferenceUsage(modelAsset.referenceUsage, `模型资产 ${reference.assetId}`);
      assertStudioReferenceUsage(reference.referenceUsage, `控制引用 ${reference.assetId}`);
      const expected = deriveStudioReferenceUsage({
        description: "",
        identityFeatures: modelAsset.identityFeatures,
        positiveLocks: modelAsset.positiveLocks,
        negativeLocks: modelAsset.negativeLocks,
        defaultPrompt: modelAsset.defaultPrompt,
      });
      if (stableDigest(modelAsset.referenceUsage) !== stableDigest(expected)
        || stableDigest(reference.referenceUsage) !== stableDigest(expected)) {
        fail("input-drift", `Codex 请求控制引用 ${reference.assetId} 的 referenceUsage 与当前冻结 definition 不一致。`);
      }
    }
  }
  const safetyIds = new Set(request.safetyConstraints.map((constraint) => constraint.assetId));
  if (safetyIds.size !== request.safetyConstraints.length
    || forbiddenIds.size !== safetyIds.size
    || [...forbiddenIds].some((assetId) => !safetyIds.has(assetId))) {
    fail("input-drift", "Codex 请求的 forbidden 模型约束与安全控制平面不一致。");
  }
  for (const constraint of request.safetyConstraints) {
    const { fingerprint: _constraintFingerprint, ...constraintSemantic } = constraint;
    if (constraint.fingerprint !== stableDigest(constraintSemantic)) {
      fail("input-drift", `forbidden 安全约束 ${constraint.assetId} 内容地址无效。`);
    }
  }
  if (!SHA256_PATTERN.test(request.assetBinding.bindingSetFingerprint)
    || !SHA256_PATTERN.test(request.assetBinding.analysisFingerprint)
    || !SHA256_PATTERN.test(request.assetBinding.referenceResolutionFingerprint)
    || !SHA256_PATTERN.test(request.assetBinding.provenanceFingerprint)
    || request.assetBinding.decisionFingerprints.some((fingerprint) => !SHA256_PATTERN.test(fingerprint))) {
    fail("input-drift", "Codex 请求缺少可验证的 BindingSet/analysis/decision/reference resolution 身份。");
  }
  if ((request.previousApprovedRaw === undefined) !== (request.continuityFrame === undefined)) {
    fail("previous-raw-invalid", "previousApprovedRaw 与 continuityFrame 必须同时存在或同时缺省。");
  }
  if (request.previousApprovedRaw && request.continuityFrame) {
    assertPreviousApprovedRawSnapshotIntegrity(request.previousApprovedRaw);
    assertContinuityFrameIntegrity(request.continuityFrame, request.previousApprovedRaw, visibleIds);
  }
  if (request.controlReferences.length + (request.continuityFrame ? 1 : 0) > 6) {
    fail("too-many-references", "Codex 请求包控制参考超过 6 项。 ");
  }
}

/** 返回键序稳定、可重现的 JSON；不加入当前时间或伪造 source span。 */
export function serializeStudioGenerationRequest(request: StudioCodexGenerationRequest): string {
  assertRequestIntegrity(request);
  return serializeStudioCanonicalJsonPretty(request);
}

/**
 * Agent 生图简报：默认只带 assetId + mediaSha256。
 * localPath 仅允许出现在 MCP pack 操作的 request.controlReferences
 * （经 media CAS 与 SHA 校验后）；brief 本身永不携带 localPath。
 */
export interface StudioAgentImagegenBrief {
  schemaVersion: 1;
  kind: "studio-agent-imagegen-brief";
  provider: "codex" | "grok";
  executorKind: "agent-imagegen" | "codex-imagegen";
  allowedProviders: readonly ("codex" | "grok")[];
  packId: string;
  packFingerprint: string;
  unitId: string;
  panelId: string;
  exactlyOneImage: true;
  maxCalls: 1;
  renderedPrompt: string;
  /** 从 renderedPrompt 还原；历史包无前镜行则为 null。 */
  previousStanding: StudioPanelStandingHandoff | null;
  /** 从 renderedPrompt 还原；历史包无宫格覆盖行则为 null。 */
  frozenPanelLighting: string | null;
  frozenPanelCostume: string | null;
  controlReferences: Array<{
    assetId: string;
    category: string;
    presence: string;
    role: string;
    referenceUsage: StudioReferenceUsage;
    mediaSha256: string;
  }>;
  continuityFrame?: {
    mediaSha256: string;
    purpose: "continuity";
  };
  toolHints: {
    primaryTool: string;
    referenceTool?: string;
    maxImages: 1;
    notes: string[];
  };
  registerContract: {
    dispatchCommand: "dispatch_studio_generation_pack";
    registerCommand: "register_studio_generation_result";
    requiredProviderField: true;
    variants: ["raw", "labeled"];
  };
  /** 参考图本地路径只在 pack 操作的 request.controlReferences 中提供。 */
  referencePathSource: "pack-operation-controlReferences-only";
  forbidden: string[];
}

/**
 * 给 Codex / Grok Agent 的同一冻结包执行简报。
 * 应用不内嵌生图；Agent 按 provider 工具生成后必须带回 provider 登记。
 * 简报不暴露 localPath（MCP readiness/pack 安全合同）。
 */
export function buildStudioAgentImagegenBrief(
  pack: StudioGenerationFreezePack,
  provider: "codex" | "grok",
): StudioAgentImagegenBrief {
  assertRequestIntegrity(pack.request);
  if (!pack.request.allowedProviders.includes(provider)) {
    fail(
      "input-drift",
      `冻结包 allowedProviders 不包含 ${provider}：${pack.request.allowedProviders.join(",")}`,
    );
  }
  const toolHints = provider === "codex"
    ? {
      primaryTool: "image_gen（Codex / OpenAI 图像能力）",
      maxImages: 1 as const,
      notes: [
        "严格只调用一次生图工具，只产出一张图。",
        "人物/场景/道具/风格只能来自冻结 pack 的 controlReferences 与 modelPayload。",
        "参考图本地路径只读 pack 操作返回的 request.controlReferences.localPath（已 CAS/SHA 校验）。",
        "若 previousStanding 或 renderedPrompt 含「前镜交接」，必须从该站位连续起拍，禁止重起镜、镜像或改空间布局。",
        FROZEN_PANEL_LIGHTING_COSTUME_TOOL_NOTE,
        SCENE_BACK_REFERENCE_TOOL_NOTE,
        "禁止浏览器、Artlist、ComfyUI、网页自动化旁路。",
      ],
    }
    : {
      primaryTool: "image_gen",
      referenceTool: "image_edit（有参考图时优先图生图保持一致性）",
      maxImages: 1 as const,
      notes: [
        `严格只生成一张${effectiveStudioPanelImageLayout(pack.request.modelPayload) === "cinematic-wide" ? "电影宽银幕横幅" : "9:16 竖屏"}分镜；有权威参考时用 image_edit 绑定角色/场景/道具/风格。`,
        "参考图 localPath 只来自 pack 操作的 verified controlReferences，不使用 brief 内路径。",
        "不得替换冻结包外的身份；不得把字幕/分屏画进 raw。",
        "若 previousStanding 或 renderedPrompt 含「前镜交接」，必须从该站位连续起拍，禁止重起镜、镜像或改空间布局。",
        FROZEN_PANEL_LIGHTING_COSTUME_TOOL_NOTE,
        SCENE_BACK_REFERENCE_TOOL_NOTE,
        "禁止浏览器、Artlist、网页自动化旁路。",
      ],
    };
  return {
    schemaVersion: 1,
    kind: "studio-agent-imagegen-brief",
    provider,
    executorKind: pack.request.executorKind,
    allowedProviders: pack.request.allowedProviders,
    packId: pack.id,
    packFingerprint: pack.fingerprint,
    unitId: pack.target.unitId,
    panelId: pack.target.panelId,
    exactlyOneImage: true,
    maxCalls: 1,
    renderedPrompt: pack.request.modelPayload.renderedPrompt,
    previousStanding: parsePreviousStandingFromRenderedPrompt(pack.request.modelPayload.renderedPrompt),
    frozenPanelLighting: parseFrozenPanelLightingFromRenderedPrompt(pack.request.modelPayload.renderedPrompt),
    frozenPanelCostume: parseFrozenPanelCostumeFromRenderedPrompt(pack.request.modelPayload.renderedPrompt),
    controlReferences: pack.request.controlReferences.map((ref) => ({
      assetId: ref.assetId,
      category: ref.category,
      presence: ref.presence,
      role: ref.role,
      referenceUsage: structuredClone(ref.referenceUsage ?? DEFAULT_STUDIO_REFERENCE_USAGE),
      mediaSha256: ref.mediaSha256,
    })),
    ...(pack.request.continuityFrame
      ? {
        continuityFrame: {
          mediaSha256: pack.request.continuityFrame.mediaSha256,
          purpose: "continuity" as const,
        },
      }
      : {}),
    toolHints,
    registerContract: {
      dispatchCommand: "dispatch_studio_generation_pack",
      registerCommand: "register_studio_generation_result",
      requiredProviderField: true,
      variants: ["raw", "labeled"],
    },
    referencePathSource: "pack-operation-controlReferences-only",
    forbidden: [
      "browser-generation",
      "artlist",
      "comfyui-as-formal",
      "multi-image-batch",
      "text-only-when-bindings-exist",
    ],
  };
}

/** 提交前重建当前包；任何定义、权威、审核、媒体或文本修订漂移均失败。 */
export async function assertStudioGenerationFreezePackCurrent(
  projectRoot: string,
  pack: StudioGenerationFreezePack,
): Promise<StudioGenerationFreezePack> {
  if (pack.schemaVersion !== 4 || pack.kind !== "studio-generation-freeze-pack"
    || pack.provenance !== "asset-binding-set") {
    fail("input-drift", "只允许校验 schema v4 / asset-binding-set 冻结包；v3 仅供历史读取且不会自动提升。");
  }
  assertRequestIntegrity(pack.request);
  assertContinuitySnapshotIntegrity(pack.continuity);
  const { id: _id, fingerprint: _fingerprint, ...semantic } = pack;
  const fingerprint = stableDigest(semantic);
  if (pack.fingerprint !== fingerprint || pack.id !== `studio-generation-freeze-${fingerprint.slice(0, 32)}`) {
    fail("input-drift", "冻结包内容与内容地址不一致。");
  }
  const { fingerprint: _bindingFingerprint, ...bindingSemantic } = pack.assetBinding;
  if (pack.assetBinding.fingerprint !== stableDigest(bindingSemantic)
    || pack.request.assetBinding.bindingSetId !== pack.assetBinding.bindingSet.id
    || pack.request.assetBinding.bindingSetFingerprint !== pack.assetBinding.bindingSet.fingerprint
    || pack.request.assetBinding.analysisId !== pack.assetBinding.analysis.id
    || pack.request.assetBinding.analysisFingerprint !== pack.assetBinding.analysis.fingerprint
    || pack.request.assetBinding.provenanceFingerprint !== pack.assetBinding.fingerprint
    || pack.request.assetBinding.referenceResolutionFingerprint !== pack.panelReferenceResolution.fingerprint
    || stableDigest(pack.request.sourceRevisions.sourceSpans) !== stableDigest(pack.assetBinding.bindingSet.sourceSpans)
    || stableDigest(pack.request.continuity) !== stableDigest(pack.continuity)
    || (pack.request.previousApprovedRaw === undefined) !== (pack.previousApprovedRaw === undefined)
    || (pack.request.previousApprovedRaw !== undefined && pack.previousApprovedRaw !== undefined
      && stableDigest(pack.request.previousApprovedRaw) !== stableDigest(pack.previousApprovedRaw))) {
    fail("input-drift", "冻结包 BindingSet provenance 与 Codex 请求不一致。");
  }
  const continuityByAsset = new Map(pack.continuity.assets.map((asset) => [asset.assetId, asset] as const));
  if (pack.assets.length !== continuityByAsset.size) {
    fail("continuity-drift", "冻结包允许资产与 continuity snapshot 集合不闭合。");
  }
  for (const asset of pack.assets) {
    const frozenContinuity = continuityByAsset.get(asset.assetId);
    if (!frozenContinuity || stableDigest(asset.continuity) !== stableDigest(frozenContinuity)) {
      fail("continuity-drift", `冻结包允许资产 ${asset.assetId} 的 continuity snapshot 不一致。`);
    }
  }
  if (pack.forbiddenAssets.some((asset) => "continuity" in asset)) {
    fail("continuity-drift", "冻结包 forbidden 资产不得携带 continuity-confirmed 状态。");
  }
  try {
    assertPanelReferenceResolutionIntegrity(pack.panelReferenceResolution);
  } catch (error) {
    fail("input-drift", "冻结包的统一逐宫格引用闭包已损坏。", [error instanceof Error ? error.message : String(error)]);
  }
  if (!pack.panelReferenceResolution.generationReady
    || pack.panelReferenceResolution.overflowControlReferences.length > 0) {
    fail("input-drift", "冻结包的统一逐宫格引用闭包不是 generation-ready。");
  }
  const expectedDependencies = [
    ...continuityDependencies(pack.continuity),
    ...(pack.previousApprovedRaw
      ? previousRawReferenceInput(pack.previousApprovedRaw, pack.assets.map((asset) => asset.assetId)).dependencies
      : []),
  ];
  for (const dependency of expectedDependencies) {
    const matches = pack.panelReferenceResolution.dependencies.filter((entry) => entry.kind === dependency.kind
      && entry.key === dependency.key && entry.fingerprint === dependency.fingerprint);
    if (matches.length !== 1) {
      fail("continuity-drift", `PanelReferenceResolution 缺少唯一 continuity 依赖 ${dependency.kind}:${dependency.key}。`);
    }
  }
  const continuityControls = pack.panelReferenceResolution.controlReferences
    .filter((control) => control.kind === "continuity-frame" || control.purpose === "continuity");
  if (!pack.previousApprovedRaw && continuityControls.length !== 0) {
    fail("previous-raw-invalid", "未显式请求 previousApprovedRaw 时不得自动注入 continuity-frame。");
  }
  if (pack.previousApprovedRaw) {
    assertPreviousApprovedRawSnapshotIntegrity(pack.previousApprovedRaw);
    if (!pack.request.continuityFrame || continuityControls.length !== 1) {
      fail("previous-raw-invalid", "显式 previousApprovedRaw 缺少唯一 continuity-frame 控制引用。");
    }
    const expected = previousRawReferenceInput(pack.previousApprovedRaw, pack.assets.map((asset) => asset.assetId)).control;
    const actual = continuityControls[0]!;
    if (actual.id !== expected.id || actual.kind !== expected.kind || actual.purpose !== "continuity"
      || actual.contentAddress !== expected.contentAddress || actual.referenceVersion !== expected.referenceVersion
      || stableDigest(actual.coveredAssetIds) !== stableDigest(expected.coveredAssetIds)
      || stableDigest(actual.provenance.map((entry) => ({
        source: entry.source,
        reference: entry.reference,
        ...(entry.sourceFingerprint ? { sourceFingerprint: entry.sourceFingerprint } : {}),
      })).sort((left, right) => stableDigest(left).localeCompare(stableDigest(right), "en")))
        !== stableDigest([...(expected.provenance ?? [])]
          .sort((left, right) => stableDigest(left).localeCompare(stableDigest(right), "en")))) {
      fail("previous-raw-invalid", "PanelReferenceResolution continuity-frame 与上一格 approved raw 不一致。");
    }
  }
  const current = await buildStudioGenerationFreezePack(projectRoot, {
    unitId: pack.target.unitId,
    panelId: pack.target.panelId,
    ...(pack.previousApprovedRaw ? { previousApprovedRawReviewId: pack.previousApprovedRaw.reviewId } : {}),
  });
  if (current.fingerprint !== pack.fingerprint || current.id !== pack.id || current.request.fingerprint !== pack.request.fingerprint) {
    fail("input-drift", "Codex 一致性冻结包输入已漂移，必须重新冻结。");
  }
  return pack;
}
