import { createHash } from "node:crypto";
import type { FusionProjectManifest, FusionUnitDefinition, ProductionAssetCategory, ProductionAssetDefinition } from "./fusion-package.js";
import type { PanelReferenceResolution, PanelReferenceSemanticAsset } from "./fusion-panel-references.js";
import type { FusionStoryboardGridContract, FusionStoryboardGridPanel } from "./fusion-storyboard-grid.js";
import type { StoryboardProductionContract } from "./types.js";

export const FUSION_PANEL_VISUAL_CONSTRAINT_VERSION = "panel-visual-constraint-v1" as const;
export const FUSION_PANEL_VISUAL_PROMPT_POLICY_VERSION = "model-review-separation-v1" as const;
export const FUSION_HIDDEN_MASK_POLICY_VERSION = "golden-mask-panel-allowlist-v1" as const;

export const PANEL_VISUAL_WARNING_CODES = [
  "AHANG_IDENTITY",
  "DUDU_MARKINGS",
  "HIDDEN_MASK_DISCLOSURE",
  "OCR_OR_TEXT",
  "WATERMARK_OR_UI",
  "MODERN_OBJECT",
  "COLLAGE_OR_SPLIT",
  "PROP_STRUCTURE",
  "SCENE_LAYOUT",
  "EXTRA_CHARACTER",
  "AMBIGUOUS_VISIBILITY",
  "SPATIAL_LOCK_UNKNOWN",
] as const;

export type PanelVisualWarningCode = (typeof PANEL_VISUAL_WARNING_CODES)[number];
export type PanelVisualAssetPresence = "on-screen" | "continuity-only" | "optional-offscreen";
export type PanelVisualSpatialField =
  | "shotSize"
  | "cameraMovement"
  | "cameraAngle"
  | "lens"
  | "composition"
  | "staging"
  | "eyeline"
  | "screenDirection"
  | "axisSide";

const SPATIAL_FIELDS: readonly PanelVisualSpatialField[] = [
  "shotSize",
  "cameraMovement",
  "cameraAngle",
  "lens",
  "composition",
  "staging",
  "eyeline",
  "screenDirection",
  "axisSide",
];

const HIDDEN_MASK_ASSET_ID = "P01";
const AHANG_ASSET_ID = "C01";
const DUDU_ASSET_ID = "C02";
const SAFE_BAG_DESCRIPTION = "同一已验收的闭合不透明素麻布囊，内部完全不可见、不发光、不新增金属元素。";
const GENERIC_MODEL_NEGATIVE = [
  "画面内不要任何中文、英文、字母、数字、字幕或标题",
  "不要水印、应用界面、按钮、边框或平台标识",
  "不要现代物件、现代服装、现代建筑或现代照明",
  "不要拼图、分屏、画中画或多张图并排",
  "不要新增剧情未声明的人物或动物",
];

const HIDDEN_MASK_DISCLOSURE_PATTERN = /(?:黄金面具|完整面具|半(?:张|面)?面具|裂(?:开|损|纹|面)?面具|金色面具|青铜面具|面具三视图|面具参考图|面具权威|纵目(?:结构|造型)?|兽耳(?:结构|造型)?|獠牙(?:结构|口型)?|裂面|半面具|面具口型)/iu;
const HIDDEN_MASK_DISCLOSURE_GLOBAL = new RegExp(HIDDEN_MASK_DISCLOSURE_PATTERN.source, "giu");
const LOCAL_PATH_PATTERN = /(?:file:\/\/|\/Users\/|\/private\/|\/var\/|\/tmp\/|[A-Za-z]:\\)[^\s，。；！？）)]+/iu;
const LOCAL_PATH_GLOBAL = new RegExp(LOCAL_PATH_PATTERN.source, "giu");
const RELATIVE_MEDIA_PATH_PATTERN = /(?:^|\s)(?:\.{0,2}\/)?[^\s，。；！？]+\.(?:png|jpe?g|webp|gif|tiff?|bmp)(?=$|\s|，|。|；|！|？)/iu;

export class FusionPanelVisualConstraintValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FusionPanelVisualConstraintValidationError";
  }
}

export interface PanelVisualPresenceOverride {
  contractId: string;
  panelId: string;
  assetId: string;
  expectedResolutionId: string;
  expectedBindingId: string;
  presence: PanelVisualAssetPresence;
  reason: string;
}

export interface PanelGoldenMaskRevealAuthorization {
  schemaVersion: 1;
  subject: "golden-mask";
  authorizationId: string;
  contractId: string;
  panelId: string;
  expectedGridSourceFingerprint: string;
  expectedResolutionId: string;
  approvedBy: "user";
  reason: string;
  /** 只有逐格授权后才能进入模型侧；仍禁止本地路径。 */
  modelRevealDescription: string;
}

export interface PanelVisualMustAppear {
  assetId: string;
  assetName: string;
  category: ProductionAssetCategory;
  presence: "on-screen";
  referenceBindingId: string;
  modelInstruction: string;
}

export interface PanelVisualMustNotAppear {
  id: string;
  subject:
    | "text-or-ocr"
    | "watermark-or-ui"
    | "modern-object"
    | "collage-or-split"
    | "extra-character"
    | "p01-internal-content";
  modelInstruction: string;
  warningCode: PanelVisualWarningCode;
}

export interface PanelVisualIdentityLock {
  assetId: string;
  assetName: string;
  category: ProductionAssetCategory;
  presence: PanelVisualAssetPresence;
  bindingId: string;
  status: "locked" | "unresolved";
  authority?: "user-authority" | "reviewed-hard-lock";
  artifactId?: string;
  reviewId?: string;
  referenceVersion?: string;
  referenceSha256?: string;
  requirements: string[];
}

export interface PanelVisualSpatialLockEvidence {
  storyboardRowId: string;
  storyboardRowRevision: number;
  value?: string;
}

export interface PanelVisualSpatialLock {
  field: PanelVisualSpatialField;
  status: "resolved" | "unresolved";
  values: string[];
  evidence: PanelVisualSpatialLockEvidence[];
  reason?: string;
}

export interface PanelVisualContinuityLock {
  assetId: string;
  assetName: string;
  category: ProductionAssetCategory;
  presence: PanelVisualAssetPresence;
  status: "resolved" | "unresolved";
  spanIds: string[];
  referenceVersions: string[];
  costumeValues: string[];
  stateValues: string[];
  reason?: string;
}

export interface PanelVisualReviewRule {
  id: string;
  code: PanelVisualWarningCode;
  enforcement: "human-visual-final" | "deterministic-and-human-visual";
  instruction: string;
  evidenceAssetIds: string[];
}

export interface PanelVisualWarning {
  code: PanelVisualWarningCode;
  severity: "warning" | "blocker";
  detection: "human-visual" | "deterministic-input-and-human-visual";
  message: string;
  evidenceAssetIds: string[];
}

export interface PanelVisualConstraintInputSnapshot {
  manifestSha256: string;
  sourceContentAddress: `sha256:${string}`;
  unitId: string;
  unitMarkdownSha256: string;
  gridContractId: string;
  gridSourceFingerprint: string;
  gridProductionFingerprint: string;
  panelId: string;
  resolutionId: string;
  resolutionFingerprint: string;
  storyboardRowsDigest: string;
  presenceOverridesDigest: string;
  revealAuthorizationDigest: string;
  hiddenMaskDisclosureDetected: boolean;
  promptPolicyVersion: typeof FUSION_PANEL_VISUAL_PROMPT_POLICY_VERSION;
  hiddenMaskPolicyVersion: typeof FUSION_HIDDEN_MASK_POLICY_VERSION;
}

export interface PanelVisualConstraint {
  schemaVersion: 1;
  kind: "panel-visual-constraint";
  builderVersion: typeof FUSION_PANEL_VISUAL_CONSTRAINT_VERSION;
  constraintId: string;
  fingerprint: string;
  /** 只冻结模型载荷、实际参考硬锁与隐藏/reveal 策略。 */
  modelFingerprint: string;
  /** 只冻结人工审核规则、警告与最终人工 Review 要求。 */
  reviewRulesFingerprint: string;
  projectId: string;
  sourceContentAddress: `sha256:${string}`;
  unitItemId: string;
  episodeNumber: number;
  gridContractId: string;
  panelId: string;
  panelIndex: number;
  inputSnapshot: PanelVisualConstraintInputSnapshot;
  assetPresence: Array<{
    assetId: string;
    assetName: string;
    category: ProductionAssetCategory;
    bindingId: string;
    presence: PanelVisualAssetPresence;
    basis: "storyboard-row" | "continuity-evidence" | "manual-override";
    reason: string;
  }>;
  mustAppear: PanelVisualMustAppear[];
  mustNotAppear: PanelVisualMustNotAppear[];
  identityLocks: PanelVisualIdentityLock[];
  spatialLocks: PanelVisualSpatialLock[];
  continuityLocks: PanelVisualContinuityLock[];
  modelPrompt: string;
  modelNegativePrompt: string;
  reviewRules: PanelVisualReviewRule[];
  warnings: PanelVisualWarning[];
  hiddenMaskPolicy: {
    status: "not-applicable" | "concealed" | "reveal-authorized";
    authorizationId?: string;
  };
  humanVisualReviewRequired: true;
  generationGate: {
    status: "ready" | "blocked";
    blockerCodes: Array<"p2-not-generation-ready" | "identity-lock-unresolved">;
  };
}

export interface PanelVisualConstraintAudit {
  schemaVersion: 1;
  builderVersion: typeof FUSION_PANEL_VISUAL_CONSTRAINT_VERSION;
  contracts: number;
  expectedPanels: number;
  constraints: number;
  missingConstraints: number;
  extraConstraints: number;
  invalidConstraints: number;
  duplicateConstraintIds: number;
  onScreenAssets: number;
  continuityOnlyAssets: number;
  optionalOffscreenAssets: number;
  unresolvedIdentityLocks: number;
  unresolvedSpatialLocks: number;
  unresolvedContinuityLocks: number;
  invalidModelFingerprints: number;
  invalidReviewRulesFingerprints: number;
  modelPromptLeakPanels: number;
  modelPathLeakPanels: number;
  concealedMaskPanels: number;
  revealAuthorizedPanels: number;
  warningCounts: Record<PanelVisualWarningCode, number>;
  warningsWithoutReviewRules: number;
  closurePassed: boolean;
  auditFingerprint: string;
}

export interface PanelVisualConstraintStoreInputSnapshot {
  manifestSha256: string;
  sourceContentAddress: `sha256:${string}`;
  gridContractsDigest: string;
  resolutionsDigest: string;
  storyboardRowsDigest: string;
  presenceOverridesDigest: string;
  revealAllowlistDigest: string;
  legacyGenerationJobEvidenceDigest: string;
}

export interface PanelVisualLegacyGenerationJobEvidence {
  jobId: string;
  contractId: string;
  panelId: string;
  constraintId: string;
  constraintFingerprint: string;
  modelFingerprint: string;
  reviewRulesFingerprint: string;
  jobLedgerFingerprint: string;
  disposition: "current-constraint-readonly" | "obsolete-terminal-readonly" | "superseded-constraint-readonly";
  supersededReason?: "current-constraint-identity-changed" | "current-constraint-missing";
  supersededByConstraintId?: string;
}

export interface FusionPanelVisualConstraintStore {
  schemaVersion: 1;
  kind: "fusion-panel-visual-constraints";
  builderVersion: typeof FUSION_PANEL_VISUAL_CONSTRAINT_VERSION;
  revision: number;
  projectId: string;
  sourceContentAddress: `sha256:${string}`;
  inputSnapshot: PanelVisualConstraintStoreInputSnapshot;
  /** 是可重建的正式裁决数据，不得只保留 digest。 */
  presenceOverrides: PanelVisualPresenceOverride[];
  /** EP32 仍逐格授权；空数组代表未授权任何宫格。 */
  revealAllowlist: PanelGoldenMaskRevealAuthorization[];
  /** 只冻结旧 Job 的内容身份；Core 不读写或改造 Job 账本。 */
  legacyGenerationJobEvidence: Record<string, PanelVisualLegacyGenerationJobEvidence>;
  constraints: Record<string, PanelVisualConstraint>;
  audit: PanelVisualConstraintAudit;
  storeFingerprint: string;
}

export interface BuildPanelVisualConstraintInput {
  manifest: FusionProjectManifest;
  contract: FusionStoryboardGridContract;
  panelId: string;
  resolution: PanelReferenceResolution;
  storyboardRows: readonly StoryboardProductionContract[];
  presenceOverrides?: readonly PanelVisualPresenceOverride[];
  revealAuthorization?: PanelGoldenMaskRevealAuthorization;
}

export interface BuildFusionPanelVisualConstraintStoreInput {
  manifest: FusionProjectManifest;
  contracts: readonly FusionStoryboardGridContract[];
  resolutions: Readonly<Record<string, PanelReferenceResolution>>;
  storyboardRows: readonly StoryboardProductionContract[];
  presenceOverrides?: readonly PanelVisualPresenceOverride[];
  revealAllowlist?: readonly PanelGoldenMaskRevealAuthorization[];
  legacyGenerationJobEvidence?: Readonly<Record<string, PanelVisualLegacyGenerationJobEvidence>>;
  revision?: number;
}

export interface PanelVisualModelPayload {
  schemaVersion: 1;
  constraintId: string;
  constraintFingerprint: string;
  modelFingerprint: string;
  episodeNumber: number;
  panelId: string;
  prompt: string;
  negativePrompt: string;
  mustAppearInstructions: string[];
  referenceLocks: Array<{
    assetId: string;
    presence: Exclude<PanelVisualAssetPresence, "optional-offscreen">;
    referenceSha256: string;
    referenceVersion: string;
  }>;
  hiddenMaskPolicy: PanelVisualConstraint["hiddenMaskPolicy"];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right, "en"));
}

function constraintKey(contractId: string, panelId: string): string {
  return `${contractId}:${panelId}`;
}

function unitItemId(unit: FusionUnitDefinition): string {
  return `season-三-ep${String(unit.episodeNumber).padStart(2, "0")}-unit${String(unit.sequence).padStart(3, "0")}`;
}

function assertRegularHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new FusionPanelVisualConstraintValidationError(`${label} 不是有效 SHA-256`);
}

function stripLocalPaths(value: string): string {
  return value.replace(LOCAL_PATH_GLOBAL, "").replace(/\s{2,}/gu, " ").trim();
}

function containsLocalPath(value: string): boolean {
  return LOCAL_PATH_PATTERN.test(value) || RELATIVE_MEDIA_PATH_PATTERN.test(value);
}

function sanitizeHiddenMaskDisclosure(value: string): string {
  return stripLocalPaths(value)
    .replace(HIDDEN_MASK_DISCLOSURE_GLOBAL, "布囊内部物件")
    .replace(/面具/gu, "内部物件")
    .replace(/(?:布囊内部物件\s*){2,}/gu, "布囊内部物件")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function findUnit(manifest: FusionProjectManifest, contract: FusionStoryboardGridContract): FusionUnitDefinition {
  const matches = manifest.units.filter((unit) => unitItemId(unit) === contract.unit.unitId);
  if (matches.length !== 1) {
    throw new FusionPanelVisualConstraintValidationError(`宫格合同 ${contract.contractId} 不能唯一对应 manifest 单元`);
  }
  const unit = matches[0]!;
  const episodeLabel = contract.unit.episodeLabel?.match(/EP\s*(\d{1,2})/iu)?.[1];
  if (episodeLabel && Number(episodeLabel) !== unit.episodeNumber) {
    throw new FusionPanelVisualConstraintValidationError(`宫格合同 ${contract.contractId} 的集数与 manifest 冲突`);
  }
  return unit;
}

function definitionsById(manifest: FusionProjectManifest): Map<string, ProductionAssetDefinition> {
  const result = new Map<string, ProductionAssetDefinition>();
  for (const definition of manifest.assets) {
    if (!definition.id || result.has(definition.id)) throw new FusionPanelVisualConstraintValidationError(`manifest 资产 ID 缺失或重复：${definition.id}`);
    result.set(definition.id, definition);
  }
  return result;
}

function validatePanelInputs(
  manifest: FusionProjectManifest,
  contract: FusionStoryboardGridContract,
  panel: FusionStoryboardGridPanel,
  resolution: PanelReferenceResolution,
): void {
  if (manifest.projectId !== resolution.projectId || manifest.contentAddress !== resolution.sourceContentAddress) {
    throw new FusionPanelVisualConstraintValidationError("宫格 P2 resolution 与 manifest 项目身份不一致");
  }
  if (resolution.gridContractId !== contract.contractId
    || resolution.gridSourceFingerprint !== contract.sourceFingerprint
    || resolution.panelId !== panel.id
    || resolution.panelIndex !== panel.index
    || resolution.panelCount !== contract.selection.panelCount
    || resolution.unitItemId !== contract.unit.unitId) {
    throw new FusionPanelVisualConstraintValidationError("宫格 P2 resolution 与当前合同或 panel 身份冲突");
  }
  if (resolution.closureStatus === "unresolved") {
    throw new FusionPanelVisualConstraintValidationError(`宫格 ${panel.id} 的 P2 引用闭包未解决`);
  }
  if (JSON.stringify(unique(resolution.storyboardRowIds)) !== JSON.stringify(unique(panel.storyboardRowIds))) {
    throw new FusionPanelVisualConstraintValidationError(`宫格 ${panel.id} 的 P2 storyboard row 集合已漂移`);
  }
  const semanticIds = unique(resolution.semanticAssets.map((asset) => asset.assetId));
  const excludedIds = new Set(resolution.excludedAssets.map((asset) => asset.assetId));
  const expectedIds = unique(panel.assetIds.filter((assetId) => !excludedIds.has(assetId)));
  if (JSON.stringify(semanticIds.filter((id) => expectedIds.includes(id))) !== JSON.stringify(expectedIds)) {
    throw new FusionPanelVisualConstraintValidationError(`宫格 ${panel.id} 的合同资产未被 P2 resolution 精确覆盖`);
  }
}

function rowsForPanel(
  panel: FusionStoryboardGridPanel,
  storyboardRows: readonly StoryboardProductionContract[],
): StoryboardProductionContract[] {
  const byId = new Map<string, StoryboardProductionContract>();
  for (const row of storyboardRows) {
    if (!row.storyboardRowId || byId.has(row.storyboardRowId)) {
      throw new FusionPanelVisualConstraintValidationError(`storyboard row ID 缺失或重复：${row.storyboardRowId}`);
    }
    byId.set(row.storyboardRowId, row);
  }
  return panel.storyboardRowIds.map((rowId, index) => {
    const row = byId.get(rowId);
    if (!row) throw new FusionPanelVisualConstraintValidationError(`宫格 ${panel.id} 缺少 storyboard row ${rowId}`);
    if (row.storyboardRowRevision !== panel.storyboardRowRevisions[index]) {
      throw new FusionPanelVisualConstraintValidationError(`storyboard row ${rowId} 修订已漂移`);
    }
    return row;
  });
}

function defaultPresence(asset: PanelReferenceSemanticAsset): Exclude<PanelVisualAssetPresence, "optional-offscreen"> {
  return asset.provenance.some((entry) => entry.kind === "storyboard-row") ? "on-screen" : "continuity-only";
}

function presenceEntries(
  resolution: PanelReferenceResolution,
  definitions: Map<string, ProductionAssetDefinition>,
  overrides: readonly PanelVisualPresenceOverride[],
): PanelVisualConstraint["assetPresence"] {
  const overrideByAsset = new Map<string, PanelVisualPresenceOverride>();
  for (const override of overrides) {
    if (override.contractId !== resolution.gridContractId || override.panelId !== resolution.panelId) {
      throw new FusionPanelVisualConstraintValidationError(`presence override ${override.assetId} 不属于当前宫格`);
    }
    if (!override.reason.trim() || override.expectedResolutionId !== resolution.resolutionId) {
      throw new FusionPanelVisualConstraintValidationError(`presence override ${override.assetId} 缺少原因或 resolution CAS 已冲突`);
    }
    if (overrideByAsset.has(override.assetId)) throw new FusionPanelVisualConstraintValidationError(`presence override 资产重复：${override.assetId}`);
    overrideByAsset.set(override.assetId, override);
  }
  const entries = resolution.semanticAssets.map((asset) => {
    const definition = definitions.get(asset.assetId);
    if (!definition) throw new FusionPanelVisualConstraintValidationError(`P2 resolution 引用 manifest 不存在的资产 ${asset.assetId}`);
    const override = overrideByAsset.get(asset.assetId);
    if (override && override.expectedBindingId !== asset.bindingId) {
      throw new FusionPanelVisualConstraintValidationError(`presence override ${asset.assetId} 的 binding CAS 已冲突`);
    }
    const presence = override?.presence ?? defaultPresence(asset);
    return {
      assetId: asset.assetId,
      assetName: definition.name,
      category: definition.category,
      bindingId: asset.bindingId,
      presence,
      basis: override ? "manual-override" as const
        : presence === "on-screen" ? "storyboard-row" as const : "continuity-evidence" as const,
      reason: override?.reason.trim() ?? (presence === "on-screen"
        ? "P2 provenance 含已确认分镜行显式引用。"
        : "P2 仅有连续性或手工补入证据，不得强制入画。"),
    };
  }).sort((left, right) => left.assetId.localeCompare(right.assetId, "en"));
  const unknownOverrides = [...overrideByAsset.keys()].filter((assetId) => !entries.some((entry) => entry.assetId === assetId));
  if (unknownOverrides.length) throw new FusionPanelVisualConstraintValidationError(`presence override 引用当前宫格不存在的资产：${unknownOverrides.join("、")}`);
  return entries;
}

function spatialLocks(rows: readonly StoryboardProductionContract[]): PanelVisualSpatialLock[] {
  return SPATIAL_FIELDS.map((field) => {
    const evidence = rows.map((row) => {
      const raw = row[field];
      const value = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
      return {
        storyboardRowId: row.storyboardRowId,
        storyboardRowRevision: row.storyboardRowRevision,
        ...(value ? { value } : {}),
      };
    });
    const values = unique(evidence.flatMap((entry) => entry.value ? [entry.value] : []));
    const status = evidence.every((entry) => entry.value) ? "resolved" as const : "unresolved" as const;
    return {
      field,
      status,
      values,
      evidence,
      ...(status === "unresolved" ? { reason: `至少一条已确认 storyboard row 没有 ${field}；禁止臆造。` } : {}),
    };
  });
}

function continuityLocks(
  manifest: FusionProjectManifest,
  unit: FusionUnitDefinition,
  panel: FusionStoryboardGridPanel,
  presence: PanelVisualConstraint["assetPresence"],
  resolution: PanelReferenceResolution,
): PanelVisualContinuityLock[] {
  return presence.map((entry) => {
    const track = manifest.continuityTracks.find((candidate) => candidate.assetId === entry.assetId);
    if (!track) throw new FusionPanelVisualConstraintValidationError(`manifest 缺少资产 ${entry.assetId} 的 continuity track`);
    const spans = track.spans.filter((span) => span.unitId === unit.id
      && span.startSeconds < panel.endSeconds - 1e-6
      && span.endSeconds > panel.startSeconds + 1e-6);
    const resolutionAsset = resolution.semanticAssets.find((asset) => asset.assetId === entry.assetId)!;
    const resolutionSpanIds = unique(resolutionAsset.provenance.flatMap((provenance) => provenance.kind === "continuity-span"
      ? provenance.continuitySpanIds ?? [] : []));
    const manifestSpanIds = unique(spans.map((span) => span.id));
    if (JSON.stringify(resolutionSpanIds) !== JSON.stringify(manifestSpanIds)) {
      throw new FusionPanelVisualConstraintValidationError(`资产 ${entry.assetId} 的 P2 continuity span 与 manifest 当前宫格重叠证据不一致`);
    }
    const versions = unique(spans.map((span) => span.referenceVersion));
    const status = spans.length > 0 && versions.length === 1 ? "resolved" as const : "unresolved" as const;
    return {
      assetId: entry.assetId,
      assetName: entry.assetName,
      category: entry.category,
      presence: entry.presence,
      status,
      spanIds: unique(spans.map((span) => span.id)),
      referenceVersions: versions,
      costumeValues: unique(spans.flatMap((span) => span.costume ? [span.costume] : [])),
      stateValues: unique(spans.flatMap((span) => span.state ? [span.state] : [])),
      ...(status === "unresolved" ? { reason: spans.length ? "当前宫格重叠的 continuity span 存在版本冲突。" : "当前宫格没有可证明的重叠 continuity span。" } : {}),
    };
  });
}

function identityRequirements(assetId: string, category: ProductionAssetCategory): string[] {
  if (assetId === AHANG_ASSET_ID) return ["与阿航权威图同脸、同黑衣、同发髻和左侧银白挑染，禁止换脸或改色。"];
  if (assetId === DUDU_ASSET_ID) return ["锁定\u561f\u561f的犬种、脸型、黑白棕花纹与白色卷尾，禁止漂移。"];
  if (assetId === HIDDEN_MASK_ASSET_ID) return ["布囊结构、材质、尺寸和系挂位置与已验收硬锁一致。"];
  if (category === "character") return ["人物身份、脸型、发型、服装与当前硬锁版本一致。"];
  if (category === "scene") return ["场景的建筑、地形、主要物件与空间关系与当前硬锁版本一致。"];
  return ["道具的形制、材质、尺寸比例和破损状态与当前硬锁版本一致。"];
}

function identityLocks(
  resolution: PanelReferenceResolution,
  presence: PanelVisualConstraint["assetPresence"],
): PanelVisualIdentityLock[] {
  const presenceById = new Map(presence.map((entry) => [entry.assetId, entry]));
  return resolution.semanticAssets.map((asset) => {
    const entry = presenceById.get(asset.assetId)!;
    const lock = asset.hardLock;
    return {
      assetId: asset.assetId,
      assetName: entry.assetName,
      category: entry.category,
      presence: entry.presence,
      bindingId: asset.bindingId,
      status: lock ? "locked" as const : "unresolved" as const,
      ...(lock ? {
        authority: lock.authority,
        ...(lock.artifactId ? { artifactId: lock.artifactId } : {}),
        ...(lock.reviewId ? { reviewId: lock.reviewId } : {}),
        referenceVersion: lock.referenceVersion,
        referenceSha256: lock.sha256,
      } : {}),
      requirements: identityRequirements(asset.assetId, entry.category),
    };
  }).sort((left, right) => left.assetId.localeCompare(right.assetId, "en"));
}

function validateRevealAuthorization(
  authorization: PanelGoldenMaskRevealAuthorization | undefined,
  contract: FusionStoryboardGridContract,
  panel: FusionStoryboardGridPanel,
  resolution: PanelReferenceResolution,
  episodeNumber: number,
): PanelGoldenMaskRevealAuthorization | undefined {
  if (!authorization) return undefined;
  if (episodeNumber !== 32) throw new FusionPanelVisualConstraintValidationError("黄金面具 reveal allowlist 仅允许 EP32 逐格授权");
  if (authorization.schemaVersion !== 1
    || authorization.subject !== "golden-mask"
    || authorization.approvedBy !== "user"
    || !authorization.authorizationId.trim()
    || !authorization.reason.trim()
    || !authorization.modelRevealDescription.trim()
    || authorization.contractId !== contract.contractId
    || authorization.panelId !== panel.id
    || authorization.expectedGridSourceFingerprint !== contract.sourceFingerprint
    || authorization.expectedResolutionId !== resolution.resolutionId) {
    throw new FusionPanelVisualConstraintValidationError(`宫格 ${panel.id} 的 reveal allowlist 缺少逐格身份、用户授权或 CAS 证据`);
  }
  if (containsLocalPath(authorization.modelRevealDescription)) {
    throw new FusionPanelVisualConstraintValidationError(`宫格 ${panel.id} 的 reveal 模型描述含本地路径`);
  }
  return authorization;
}

function mustAppear(
  presence: PanelVisualConstraint["assetPresence"],
  revealAuthorized: boolean,
): PanelVisualMustAppear[] {
  return presence.filter((entry) => entry.presence === "on-screen").map((entry) => {
    let modelInstruction: string;
    if (entry.assetId === HIDDEN_MASK_ASSET_ID && !revealAuthorized) {
      modelInstruction = SAFE_BAG_DESCRIPTION;
    } else if (entry.category === "character") {
      modelInstruction = `画面必须出现已验收的角色 ${entry.assetName}，严格保持当前硬锁身份。`;
    } else if (entry.category === "scene") {
      modelInstruction = `画面必须使用已验收场景 ${entry.assetName}，严格保持空间布局。`;
    } else {
      modelInstruction = `画面必须出现已验收道具 ${entry.assetName}，严格保持结构和材质。`;
    }
    return {
      assetId: entry.assetId,
      assetName: entry.assetName,
      category: entry.category,
      presence: "on-screen" as const,
      referenceBindingId: entry.bindingId,
      modelInstruction: revealAuthorized ? stripLocalPaths(modelInstruction) : sanitizeHiddenMaskDisclosure(modelInstruction),
    };
  });
}

function mustNotAppear(concealMask: boolean): PanelVisualMustNotAppear[] {
  const entries: PanelVisualMustNotAppear[] = [
    { id: "exclude-text-or-ocr", subject: "text-or-ocr", modelInstruction: GENERIC_MODEL_NEGATIVE[0]!, warningCode: "OCR_OR_TEXT" },
    { id: "exclude-watermark-or-ui", subject: "watermark-or-ui", modelInstruction: GENERIC_MODEL_NEGATIVE[1]!, warningCode: "WATERMARK_OR_UI" },
    { id: "exclude-modern-object", subject: "modern-object", modelInstruction: GENERIC_MODEL_NEGATIVE[2]!, warningCode: "MODERN_OBJECT" },
    { id: "exclude-collage-or-split", subject: "collage-or-split", modelInstruction: GENERIC_MODEL_NEGATIVE[3]!, warningCode: "COLLAGE_OR_SPLIT" },
    { id: "exclude-extra-character", subject: "extra-character", modelInstruction: GENERIC_MODEL_NEGATIVE[4]!, warningCode: "EXTRA_CHARACTER" },
  ];
  if (concealMask) entries.push({
    id: "exclude-p01-internal-content",
    subject: "p01-internal-content",
    modelInstruction: "布囊不得打开、不得透明、不得发光、不得显示任何内部物件或新增金属元素",
    warningCode: "HIDDEN_MASK_DISCLOSURE",
  });
  return entries;
}

function addWarning(
  target: Map<PanelVisualWarningCode, PanelVisualWarning>,
  warning: PanelVisualWarning,
): void {
  const previous = target.get(warning.code);
  if (!previous) {
    target.set(warning.code, { ...warning, evidenceAssetIds: unique(warning.evidenceAssetIds) });
    return;
  }
  target.set(warning.code, {
    ...previous,
    severity: previous.severity === "blocker" || warning.severity === "blocker" ? "blocker" : "warning",
    detection: previous.detection === "deterministic-input-and-human-visual" || warning.detection === "deterministic-input-and-human-visual"
      ? "deterministic-input-and-human-visual" : "human-visual",
    message: previous.message === warning.message ? previous.message : `${previous.message} ${warning.message}`,
    evidenceAssetIds: unique([...previous.evidenceAssetIds, ...warning.evidenceAssetIds]),
  });
}

function warningsFor(
  presence: PanelVisualConstraint["assetPresence"],
  spatial: readonly PanelVisualSpatialLock[],
  continuity: readonly PanelVisualContinuityLock[],
  concealMask: boolean,
  hiddenDisclosureDetected: boolean,
): PanelVisualWarning[] {
  const result = new Map<PanelVisualWarningCode, PanelVisualWarning>();
  const common: Array<[PanelVisualWarningCode, string]> = [
    ["OCR_OR_TEXT", "人工核验画面不含字幕、标题、字母、数字或其他可读文字。"],
    ["WATERMARK_OR_UI", "人工核验画面不含水印、平台标识或界面元素。"],
    ["MODERN_OBJECT", "人工核验画面不含剧情时代之外的现代物件、服饰、建筑或照明。"],
    ["COLLAGE_OR_SPLIT", "人工核验输出是一张独立纯画面，不是拼图、分屏或画中画。"],
    ["EXTRA_CHARACTER", "人工核验画面没有新增剧情未声明的人物或动物。"],
  ];
  for (const [code, message] of common) addWarning(result, { code, severity: "warning", detection: "human-visual", message, evidenceAssetIds: [] });
  const ids = new Set(presence.map((entry) => entry.assetId));
  if (ids.has(AHANG_ASSET_ID)) addWarning(result, {
    code: "AHANG_IDENTITY", severity: "warning", detection: "human-visual",
    message: "人工核验阿航与权威图同脸、同黑衣、同发髻和左侧银白挑染。", evidenceAssetIds: [AHANG_ASSET_ID],
  });
  if (ids.has(DUDU_ASSET_ID)) addWarning(result, {
    code: "DUDU_MARKINGS", severity: "warning", detection: "human-visual",
    message: "人工核验\u561f\u561f的犬种、脸型、黑白棕花纹与白色卷尾不漂移。", evidenceAssetIds: [DUDU_ASSET_ID],
  });
  if (concealMask || hiddenDisclosureDetected) addWarning(result, {
    code: "HIDDEN_MASK_DISCLOSURE", severity: "warning", detection: "deterministic-input-and-human-visual",
    message: "黄金面具的真实身份只用于人工审核；未获当前宫格 reveal 授权时，画面不得露出实体、轮廓、透视、裂面、半面或口型。", evidenceAssetIds: ids.has(HIDDEN_MASK_ASSET_ID) ? [HIDDEN_MASK_ASSET_ID] : [],
  });
  const props = presence.filter((entry) => entry.category === "prop").map((entry) => entry.assetId);
  if (props.length) addWarning(result, {
    code: "PROP_STRUCTURE", severity: "warning", detection: "human-visual",
    message: "人工核验道具形制、材质、比例、破损状态和携带方式与硬锁一致。", evidenceAssetIds: props,
  });
  const scenes = presence.filter((entry) => entry.category === "scene").map((entry) => entry.assetId);
  if (scenes.length) addWarning(result, {
    code: "SCENE_LAYOUT", severity: "warning", detection: "human-visual",
    message: "人工核验场景入口、建筑、地形、主要物件与光线方向的空间关系稳定。", evidenceAssetIds: scenes,
  });
  const ambiguous = presence.filter((entry) => entry.presence !== "on-screen").map((entry) => entry.assetId);
  if (ambiguous.length || continuity.some((entry) => entry.status === "unresolved")) addWarning(result, {
    code: "AMBIGUOUS_VISIBILITY", severity: "warning", detection: "deterministic-input-and-human-visual",
    message: "连续性参考或可选画外资产不等于强制出镜；人工审核必须核对当前剧情可见性。", evidenceAssetIds: ambiguous,
  });
  if (spatial.some((entry) => entry.status === "unresolved")) addWarning(result, {
    code: "SPATIAL_LOCK_UNKNOWN", severity: "warning", detection: "deterministic-input-and-human-visual",
    message: "至少一项空间锁没有来源值，已显式记为 unresolved；人工审核不得把臆测当作已锁布局。", evidenceAssetIds: scenes,
  });
  return [...result.values()].sort((left, right) => left.code.localeCompare(right.code, "en"));
}

function reviewRulesFor(warnings: readonly PanelVisualWarning[]): PanelVisualReviewRule[] {
  return warnings.map((warning) => ({
    id: `visual-review-rule-${digest({ code: warning.code, message: warning.message, evidenceAssetIds: warning.evidenceAssetIds }).slice(0, 24)}`,
    code: warning.code,
    enforcement: warning.detection === "human-visual" ? "human-visual-final" : "deterministic-and-human-visual",
    instruction: warning.message,
    evidenceAssetIds: [...warning.evidenceAssetIds],
  }));
}

function modelFingerprintPayload(constraint: Pick<PanelVisualConstraint,
  "builderVersion" | "projectId" | "sourceContentAddress" | "unitItemId" | "episodeNumber" | "gridContractId" | "panelId" | "panelIndex"
  | "mustAppear" | "modelPrompt" | "modelNegativePrompt" | "identityLocks" | "hiddenMaskPolicy">): unknown {
  return {
    builderVersion: constraint.builderVersion,
    projectId: constraint.projectId,
    sourceContentAddress: constraint.sourceContentAddress,
    unitItemId: constraint.unitItemId,
    episodeNumber: constraint.episodeNumber,
    gridContractId: constraint.gridContractId,
    panelId: constraint.panelId,
    panelIndex: constraint.panelIndex,
    prompt: constraint.modelPrompt,
    negativePrompt: constraint.modelNegativePrompt,
    mustAppearInstructions: constraint.mustAppear.map((entry) => entry.modelInstruction),
    referenceLocks: constraint.identityLocks.flatMap((entry) => entry.status === "locked" && entry.presence !== "optional-offscreen"
      ? [{
        assetId: entry.assetId,
        presence: entry.presence,
        referenceSha256: entry.referenceSha256,
        referenceVersion: entry.referenceVersion,
      }] : []),
    hiddenMaskPolicy: constraint.hiddenMaskPolicy,
  };
}

function reviewRulesFingerprintPayload(constraint: Pick<PanelVisualConstraint, "reviewRules" | "warnings" | "humanVisualReviewRequired">): unknown {
  return {
    reviewRules: constraint.reviewRules,
    warnings: constraint.warnings,
    humanVisualReviewRequired: constraint.humanVisualReviewRequired,
  };
}

export function panelVisualModelFingerprint(constraint: Pick<PanelVisualConstraint,
  "builderVersion" | "projectId" | "sourceContentAddress" | "unitItemId" | "episodeNumber" | "gridContractId" | "panelId" | "panelIndex"
  | "mustAppear" | "modelPrompt" | "modelNegativePrompt" | "identityLocks" | "hiddenMaskPolicy">): string {
  return digest(modelFingerprintPayload(constraint));
}

export function panelVisualReviewRulesFingerprint(
  constraint: Pick<PanelVisualConstraint, "reviewRules" | "warnings" | "humanVisualReviewRequired">,
): string {
  return digest(reviewRulesFingerprintPayload(constraint));
}

function constraintFingerprintPayload(constraint: Omit<PanelVisualConstraint, "constraintId" | "fingerprint">): unknown {
  return constraint;
}

function storeFingerprintPayload(store: Omit<FusionPanelVisualConstraintStore, "storeFingerprint">): unknown {
  return store;
}

export function buildPanelVisualConstraint(input: BuildPanelVisualConstraintInput): PanelVisualConstraint {
  const panel = input.contract.panels.find((candidate) => candidate.id === input.panelId);
  if (!panel) throw new FusionPanelVisualConstraintValidationError(`宫格合同不存在 panel ${input.panelId}`);
  const unit = findUnit(input.manifest, input.contract);
  validatePanelInputs(input.manifest, input.contract, panel, input.resolution);
  const definitions = definitionsById(input.manifest);
  const rows = rowsForPanel(panel, input.storyboardRows);
  if (rows.some((row) => row.itemId !== input.contract.unit.unitId)) {
    throw new FusionPanelVisualConstraintValidationError(`宫格 ${panel.id} 混入其他单元的 storyboard row`);
  }
  const overrides = [...(input.presenceOverrides ?? [])];
  const presence = presenceEntries(input.resolution, definitions, overrides);
  const authorization = validateRevealAuthorization(input.revealAuthorization, input.contract, panel, input.resolution, unit.episodeNumber);
  const p01Present = presence.some((entry) => entry.assetId === HIDDEN_MASK_ASSET_ID);
  // 不得用旧 `imageGenerationPrompt` 判定剧情实体：该字段正是 P3 要隔离的
  // 全局身份/负面词污染源。只有当前格的画面动作与语义节拍能证明剧情泄露。
  const sourceText = [panel.imageContentAction, ...panel.semanticBeats.map((beat) => beat.text)].join("\n");
  const hiddenDisclosureDetected = HIDDEN_MASK_DISCLOSURE_PATTERN.test(sourceText) || /面具/iu.test(sourceText);
  const concealMask = !authorization && (p01Present || hiddenDisclosureDetected);
  const spatial = spatialLocks(rows);
  const continuity = continuityLocks(input.manifest, unit, panel, presence, input.resolution);
  const identities = identityLocks(input.resolution, presence);
  const required = mustAppear(presence, Boolean(authorization));
  const excluded = mustNotAppear(concealMask);
  const basePrompt = [panel.imageContentAction, panel.shotComposition && `景别与构图：${panel.shotComposition}`, panel.shootingMethod && `拍摄方式：${panel.shootingMethod}`]
    .filter(Boolean).join("。");
  const sanitizedBase = authorization ? stripLocalPaths(basePrompt) : sanitizeHiddenMaskDisclosure(basePrompt);
  const modelPromptParts = ["高质量电影写实漫剧单帧，9:16竖屏，只生成一张独立纯画面。", sanitizedBase, ...required.map((entry) => entry.modelInstruction)];
  if (p01Present && !authorization && !required.some((entry) => entry.assetId === HIDDEN_MASK_ASSET_ID)) {
    modelPromptParts.push(`若胸前布囊进入构图：${SAFE_BAG_DESCRIPTION}`);
  }
  if (authorization) modelPromptParts.push(stripLocalPaths(authorization.modelRevealDescription));
  const modelPrompt = modelPromptParts.map((entry) => entry.trim()).filter(Boolean).join(" ");
  const modelNegativePrompt = excluded.map((entry) => entry.modelInstruction).join("；");
  const warnings = warningsFor(presence, spatial, continuity, concealMask, hiddenDisclosureDetected && !authorization);
  const reviewRules = reviewRulesFor(warnings);
  const blockerCodes: PanelVisualConstraint["generationGate"]["blockerCodes"] = [];
  if (!input.resolution.generationReady) blockerCodes.push("p2-not-generation-ready");
  if (identities.some((entry) => entry.status === "unresolved")) blockerCodes.push("identity-lock-unresolved");
  const inputSnapshot: PanelVisualConstraintInputSnapshot = {
    manifestSha256: input.manifest.manifestSha256,
    sourceContentAddress: input.manifest.contentAddress,
    unitId: unit.id,
    unitMarkdownSha256: unit.markdownSha256,
    gridContractId: input.contract.contractId,
    gridSourceFingerprint: input.contract.sourceFingerprint,
    gridProductionFingerprint: input.contract.productionFingerprint,
    panelId: panel.id,
    resolutionId: input.resolution.resolutionId,
    resolutionFingerprint: input.resolution.resolutionFingerprint,
    storyboardRowsDigest: digest(rows.map((row) => row)),
    presenceOverridesDigest: digest(overrides.map((override) => override).sort((left, right) => left.assetId.localeCompare(right.assetId, "en"))),
    revealAuthorizationDigest: authorization ? digest(authorization) : "none",
    hiddenMaskDisclosureDetected: hiddenDisclosureDetected,
    promptPolicyVersion: FUSION_PANEL_VISUAL_PROMPT_POLICY_VERSION,
    hiddenMaskPolicyVersion: FUSION_HIDDEN_MASK_POLICY_VERSION,
  };
  const basePayload: Omit<PanelVisualConstraint, "constraintId" | "fingerprint" | "modelFingerprint" | "reviewRulesFingerprint"> = {
    schemaVersion: 1,
    kind: "panel-visual-constraint",
    builderVersion: FUSION_PANEL_VISUAL_CONSTRAINT_VERSION,
    projectId: input.manifest.projectId,
    sourceContentAddress: input.manifest.contentAddress,
    unitItemId: input.contract.unit.unitId,
    episodeNumber: unit.episodeNumber,
    gridContractId: input.contract.contractId,
    panelId: panel.id,
    panelIndex: panel.index,
    inputSnapshot,
    assetPresence: presence,
    mustAppear: required,
    mustNotAppear: excluded,
    identityLocks: identities,
    spatialLocks: spatial,
    continuityLocks: continuity,
    modelPrompt,
    modelNegativePrompt,
    reviewRules,
    warnings,
    hiddenMaskPolicy: authorization ? { status: "reveal-authorized", authorizationId: authorization.authorizationId }
      : concealMask ? { status: "concealed" } : { status: "not-applicable" },
    humanVisualReviewRequired: true,
    generationGate: { status: blockerCodes.length ? "blocked" : "ready", blockerCodes },
  };
  const modelFingerprint = panelVisualModelFingerprint(basePayload);
  const reviewRulesFingerprint = panelVisualReviewRulesFingerprint(basePayload);
  const payload: Omit<PanelVisualConstraint, "constraintId" | "fingerprint"> = { ...basePayload, modelFingerprint, reviewRulesFingerprint };
  const fingerprint = digest(constraintFingerprintPayload(payload));
  const constraint: PanelVisualConstraint = { ...payload, fingerprint, constraintId: `panel-visual-${fingerprint.slice(0, 28)}` };
  validatePanelVisualConstraint(constraint);
  return constraint;
}

export function buildPanelVisualModelPayload(constraint: PanelVisualConstraint): PanelVisualModelPayload {
  validatePanelVisualConstraint(constraint);
  const payload: PanelVisualModelPayload = {
    schemaVersion: 1,
    constraintId: constraint.constraintId,
    constraintFingerprint: constraint.fingerprint,
    modelFingerprint: constraint.modelFingerprint,
    episodeNumber: constraint.episodeNumber,
    panelId: constraint.panelId,
    prompt: constraint.modelPrompt,
    negativePrompt: constraint.modelNegativePrompt,
    mustAppearInstructions: constraint.mustAppear.map((entry) => entry.modelInstruction),
    referenceLocks: constraint.identityLocks.flatMap((entry) => entry.status === "locked" && entry.presence !== "optional-offscreen"
      ? [{
        assetId: entry.assetId,
        presence: entry.presence,
        referenceSha256: entry.referenceSha256!,
        referenceVersion: entry.referenceVersion!,
      }] : []),
    hiddenMaskPolicy: constraint.hiddenMaskPolicy,
  };
  assertPanelVisualModelPayloadSafe(payload);
  return payload;
}

export function assertPanelVisualModelPayloadSafe(payload: PanelVisualModelPayload): void {
  const modelText = [payload.prompt, payload.negativePrompt, ...payload.mustAppearInstructions].join("\n");
  if (containsLocalPath(modelText)) throw new FusionPanelVisualConstraintValidationError(`宫格 ${payload.panelId} 模型载荷含本地或媒体路径`);
  if (payload.hiddenMaskPolicy.status !== "reveal-authorized" && (HIDDEN_MASK_DISCLOSURE_PATTERN.test(modelText) || /面具/iu.test(modelText))) {
    throw new FusionPanelVisualConstraintValidationError(`宫格 ${payload.panelId} 模型载荷泄露黄金面具身份或外观`);
  }
  if (payload.hiddenMaskPolicy.status === "reveal-authorized" && payload.episodeNumber !== 32) {
    throw new FusionPanelVisualConstraintValidationError(`宫格 ${payload.panelId} 在 EP32 之前非法 reveal`);
  }
}

export function validatePanelVisualConstraint(constraint: PanelVisualConstraint): void {
  if (constraint.schemaVersion !== 1 || constraint.kind !== "panel-visual-constraint" || constraint.builderVersion !== FUSION_PANEL_VISUAL_CONSTRAINT_VERSION) {
    throw new FusionPanelVisualConstraintValidationError("P3 宫格视觉约束 schema 不受支持");
  }
  assertRegularHash(constraint.fingerprint, `宫格 ${constraint.panelId} fingerprint`);
  assertRegularHash(constraint.modelFingerprint, `宫格 ${constraint.panelId} modelFingerprint`);
  assertRegularHash(constraint.reviewRulesFingerprint, `宫格 ${constraint.panelId} reviewRulesFingerprint`);
  const expectedModelFingerprint = panelVisualModelFingerprint(constraint);
  const expectedReviewRulesFingerprint = panelVisualReviewRulesFingerprint(constraint);
  if (constraint.modelFingerprint !== expectedModelFingerprint) {
    throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} 模型载荷或参考硬锁摘要不匹配`);
  }
  if (constraint.reviewRulesFingerprint !== expectedReviewRulesFingerprint) {
    throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} Review 规则摘要不匹配`);
  }
  const { constraintId: _constraintId, fingerprint: _fingerprint, ...payload } = constraint;
  const expectedFingerprint = digest(constraintFingerprintPayload(payload));
  if (expectedFingerprint !== constraint.fingerprint || constraint.constraintId !== `panel-visual-${expectedFingerprint.slice(0, 28)}`) {
    throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} 约束内容摘要不匹配`);
  }
  const presenceIds = unique(constraint.assetPresence.map((entry) => entry.assetId));
  if (presenceIds.length !== constraint.assetPresence.length) throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} 存在重复资产 presence`);
  const onScreenIds = unique(constraint.assetPresence.filter((entry) => entry.presence === "on-screen").map((entry) => entry.assetId));
  if (JSON.stringify(onScreenIds) !== JSON.stringify(unique(constraint.mustAppear.map((entry) => entry.assetId)))) {
    throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} mustAppear 未精确对应 on-screen 资产`);
  }
  if (JSON.stringify(presenceIds) !== JSON.stringify(unique(constraint.identityLocks.map((entry) => entry.assetId)))
    || JSON.stringify(presenceIds) !== JSON.stringify(unique(constraint.continuityLocks.map((entry) => entry.assetId)))) {
    throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} 身份或连续性锁未覆盖全部语义资产`);
  }
  if (constraint.spatialLocks.length !== SPATIAL_FIELDS.length
    || JSON.stringify([...constraint.spatialLocks.map((entry) => entry.field)].sort()) !== JSON.stringify([...SPATIAL_FIELDS].sort())) {
    throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} 空间锁字段不完整`);
  }
  for (const lock of constraint.spatialLocks) {
    if (lock.status === "unresolved" && !lock.reason) throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} 的 ${lock.field} 未显式记录 unresolved 原因`);
    if (lock.status === "resolved" && (!lock.values.length || lock.evidence.some((entry) => !entry.value))) {
      throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} 的 ${lock.field} 伪装为 resolved`);
    }
  }
  for (const lock of constraint.identityLocks) {
    if (lock.status === "locked") {
      if (!lock.referenceSha256 || !lock.referenceVersion || !lock.authority) throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} 的已锁资产 ${lock.assetId} 缺少内容身份`);
      assertRegularHash(lock.referenceSha256, `资产 ${lock.assetId} referenceSha256`);
    }
  }
  const warningCodes = unique(constraint.warnings.map((entry) => entry.code));
  const reviewCodes = unique(constraint.reviewRules.map((entry) => entry.code));
  if (warningCodes.length !== constraint.warnings.length || JSON.stringify(warningCodes) !== JSON.stringify(reviewCodes)) {
    throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} 警告与人工 Review 规则不精确一致`);
  }
  if (constraint.humanVisualReviewRequired !== true) throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} 不得绕过人工视觉 Review`);
  const p01Present = constraint.assetPresence.some((entry) => entry.assetId === HIDDEN_MASK_ASSET_ID);
  const hiddenDisclosureDetected = constraint.inputSnapshot.hiddenMaskDisclosureDetected;
  if (constraint.hiddenMaskPolicy.status === "reveal-authorized") {
    if (constraint.episodeNumber !== 32
      || !constraint.hiddenMaskPolicy.authorizationId
      || constraint.inputSnapshot.revealAuthorizationDigest === "none") {
      throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} 缺少 EP32 逐格 reveal 授权身份`);
    }
  } else {
    if (constraint.inputSnapshot.revealAuthorizationDigest !== "none") {
      throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} 含未消费的 reveal 授权`);
    }
    const mustConceal = p01Present || hiddenDisclosureDetected;
    if (mustConceal !== (constraint.hiddenMaskPolicy.status === "concealed")) {
      throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} 的隐藏面具政策与输入证据不一致`);
    }
    if (mustConceal && (!constraint.mustNotAppear.some((entry) => entry.subject === "p01-internal-content")
      || !warningCodes.includes("HIDDEN_MASK_DISCLOSURE"))) {
      throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} 缺少隐藏面具的模型安全规则或人工 Review 规则`);
    }
  }
  const expectedGate = constraint.generationGate.blockerCodes.length ? "blocked" : "ready";
  if (constraint.generationGate.status !== expectedGate) throw new FusionPanelVisualConstraintValidationError(`宫格 ${constraint.panelId} generation gate 状态不自洽`);
  buildPanelVisualModelPayloadUnchecked(constraint);
}

function buildPanelVisualModelPayloadUnchecked(constraint: PanelVisualConstraint): void {
  const payload: PanelVisualModelPayload = {
    schemaVersion: 1,
    constraintId: constraint.constraintId,
    constraintFingerprint: constraint.fingerprint,
    modelFingerprint: constraint.modelFingerprint,
    episodeNumber: constraint.episodeNumber,
    panelId: constraint.panelId,
    prompt: constraint.modelPrompt,
    negativePrompt: constraint.modelNegativePrompt,
    mustAppearInstructions: constraint.mustAppear.map((entry) => entry.modelInstruction),
    referenceLocks: constraint.identityLocks.flatMap((entry) => entry.status === "locked" && entry.presence !== "optional-offscreen"
      ? [{ assetId: entry.assetId, presence: entry.presence, referenceSha256: entry.referenceSha256!, referenceVersion: entry.referenceVersion! }] : []),
    hiddenMaskPolicy: constraint.hiddenMaskPolicy,
  };
  assertPanelVisualModelPayloadSafe(payload);
}

function emptyWarningCounts(): Record<PanelVisualWarningCode, number> {
  return Object.fromEntries(PANEL_VISUAL_WARNING_CODES.map((code) => [code, 0])) as Record<PanelVisualWarningCode, number>;
}

export function auditPanelVisualConstraints(input: {
  contracts: readonly FusionStoryboardGridContract[];
  constraints: Readonly<Record<string, PanelVisualConstraint>>;
}): PanelVisualConstraintAudit {
  const expectedKeys = input.contracts.flatMap((contract) => contract.panels.map((panel) => constraintKey(contract.contractId, panel.id))).sort();
  const actualKeys = Object.keys(input.constraints).sort();
  const expectedSet = new Set(expectedKeys);
  const actualSet = new Set(actualKeys);
  let invalidConstraints = 0;
  let invalidModelFingerprints = 0;
  let invalidReviewRulesFingerprints = 0;
  let modelPromptLeakPanels = 0;
  let modelPathLeakPanels = 0;
  let warningsWithoutReviewRules = 0;
  const warningCounts = emptyWarningCounts();
  for (const constraint of Object.values(input.constraints)) {
    if (constraint.modelFingerprint !== panelVisualModelFingerprint(constraint)) invalidModelFingerprints += 1;
    if (constraint.reviewRulesFingerprint !== panelVisualReviewRulesFingerprint(constraint)) invalidReviewRulesFingerprints += 1;
    try {
      validatePanelVisualConstraint(constraint);
    } catch {
      invalidConstraints += 1;
    }
    const modelText = [constraint.modelPrompt, constraint.modelNegativePrompt, ...constraint.mustAppear.map((entry) => entry.modelInstruction)].join("\n");
    if (constraint.hiddenMaskPolicy.status !== "reveal-authorized" && (HIDDEN_MASK_DISCLOSURE_PATTERN.test(modelText) || /面具/iu.test(modelText))) modelPromptLeakPanels += 1;
    if (containsLocalPath(modelText)) modelPathLeakPanels += 1;
    const reviewCodes = new Set(constraint.reviewRules.map((entry) => entry.code));
    for (const warning of constraint.warnings) {
      warningCounts[warning.code] += 1;
      if (!reviewCodes.has(warning.code)) warningsWithoutReviewRules += 1;
    }
  }
  const constraintIds = Object.values(input.constraints).map((entry) => entry.constraintId);
  const payload: Omit<PanelVisualConstraintAudit, "auditFingerprint"> = {
    schemaVersion: 1,
    builderVersion: FUSION_PANEL_VISUAL_CONSTRAINT_VERSION,
    contracts: input.contracts.length,
    expectedPanels: expectedKeys.length,
    constraints: actualKeys.length,
    missingConstraints: expectedKeys.filter((key) => !actualSet.has(key)).length,
    extraConstraints: actualKeys.filter((key) => !expectedSet.has(key)).length,
    invalidConstraints,
    duplicateConstraintIds: constraintIds.length - new Set(constraintIds).size,
    onScreenAssets: Object.values(input.constraints).flatMap((entry) => entry.assetPresence).filter((entry) => entry.presence === "on-screen").length,
    continuityOnlyAssets: Object.values(input.constraints).flatMap((entry) => entry.assetPresence).filter((entry) => entry.presence === "continuity-only").length,
    optionalOffscreenAssets: Object.values(input.constraints).flatMap((entry) => entry.assetPresence).filter((entry) => entry.presence === "optional-offscreen").length,
    unresolvedIdentityLocks: Object.values(input.constraints).flatMap((entry) => entry.identityLocks).filter((entry) => entry.status === "unresolved").length,
    unresolvedSpatialLocks: Object.values(input.constraints).flatMap((entry) => entry.spatialLocks).filter((entry) => entry.status === "unresolved").length,
    unresolvedContinuityLocks: Object.values(input.constraints).flatMap((entry) => entry.continuityLocks).filter((entry) => entry.status === "unresolved").length,
    invalidModelFingerprints,
    invalidReviewRulesFingerprints,
    modelPromptLeakPanels,
    modelPathLeakPanels,
    concealedMaskPanels: Object.values(input.constraints).filter((entry) => entry.hiddenMaskPolicy.status === "concealed").length,
    revealAuthorizedPanels: Object.values(input.constraints).filter((entry) => entry.hiddenMaskPolicy.status === "reveal-authorized").length,
    warningCounts,
    warningsWithoutReviewRules,
    closurePassed: false,
  };
  payload.closurePassed = payload.missingConstraints === 0
    && payload.extraConstraints === 0
    && payload.invalidConstraints === 0
    && payload.invalidModelFingerprints === 0
    && payload.invalidReviewRulesFingerprints === 0
    && payload.duplicateConstraintIds === 0
    && payload.modelPromptLeakPanels === 0
    && payload.modelPathLeakPanels === 0
    && payload.warningsWithoutReviewRules === 0;
  return { ...payload, auditFingerprint: digest(payload) };
}

function normalizedLegacyGenerationJobEvidence(
  input: Readonly<Record<string, PanelVisualLegacyGenerationJobEvidence>>,
  constraints: Readonly<Record<string, PanelVisualConstraint>>,
): Record<string, PanelVisualLegacyGenerationJobEvidence> {
  const normalized: Record<string, PanelVisualLegacyGenerationJobEvidence> = {};
  for (const jobId of Object.keys(input).sort((left, right) => left.localeCompare(right, "en"))) {
    const evidence = input[jobId];
    if (!evidence || !jobId || evidence.jobId !== jobId || !evidence.contractId || !evidence.panelId) {
      throw new FusionPanelVisualConstraintValidationError(`P3 旧 Job 证据键或宫格身份无效：${jobId}`);
    }
    assertRegularHash(evidence.constraintFingerprint, `旧 Job ${jobId} constraintFingerprint`);
    assertRegularHash(evidence.modelFingerprint, `旧 Job ${jobId} modelFingerprint`);
    assertRegularHash(evidence.reviewRulesFingerprint, `旧 Job ${jobId} reviewRulesFingerprint`);
    assertRegularHash(evidence.jobLedgerFingerprint, `旧 Job ${jobId} jobLedgerFingerprint`);
    if (evidence.constraintId !== `panel-visual-${evidence.constraintFingerprint.slice(0, 28)}`) {
      throw new FusionPanelVisualConstraintValidationError(`P3 旧 Job ${jobId} 的 constraintId 与 fingerprint 不匹配`);
    }
    const current = constraints[constraintKey(evidence.contractId, evidence.panelId)];
    if (evidence.disposition === "current-constraint-readonly") {
      if (!current
        || current.constraintId !== evidence.constraintId
        || current.fingerprint !== evidence.constraintFingerprint
        || current.modelFingerprint !== evidence.modelFingerprint
        || current.reviewRulesFingerprint !== evidence.reviewRulesFingerprint) {
        throw new FusionPanelVisualConstraintValidationError(`P3 旧 Job ${jobId} 的当前约束身份已漂移`);
      }
    } else if (evidence.disposition === "superseded-constraint-readonly") {
      if (evidence.supersededReason !== "current-constraint-identity-changed"
        && evidence.supersededReason !== "current-constraint-missing") {
        throw new FusionPanelVisualConstraintValidationError(`P3 旧 Job ${jobId} 缺少有效的 supersededReason`);
      }
      if (evidence.supersededReason === "current-constraint-identity-changed") {
        if (!evidence.supersededByConstraintId || !/^panel-visual-[a-f0-9]{28}$/u.test(evidence.supersededByConstraintId)) {
          throw new FusionPanelVisualConstraintValidationError(`P3 旧 Job ${jobId} 缺少替代约束身份`);
        }
      } else if (evidence.supersededByConstraintId !== undefined) {
        throw new FusionPanelVisualConstraintValidationError(`P3 旧 Job ${jobId} 的缺失约束裁决不得伪造替代身份`);
      }
    } else if (evidence.disposition !== "obsolete-terminal-readonly") {
      throw new FusionPanelVisualConstraintValidationError(`P3 旧 Job ${jobId} 的 disposition 不受支持`);
    }
    normalized[jobId] = { ...evidence };
  }
  return normalized;
}

export function buildFusionPanelVisualConstraintStore(input: BuildFusionPanelVisualConstraintStoreInput): FusionPanelVisualConstraintStore {
  const revision = input.revision ?? 1;
  if (!Number.isInteger(revision) || revision < 1) throw new FusionPanelVisualConstraintValidationError("P3 约束 store revision 必须是正整数");
  const sortedContracts = [...input.contracts].sort((left, right) => left.unit.unitId.localeCompare(right.unit.unitId, "en") || left.contractId.localeCompare(right.contractId, "en"));
  const contractIds = sortedContracts.map((contract) => contract.contractId);
  if (new Set(contractIds).size !== contractIds.length) throw new FusionPanelVisualConstraintValidationError("P3 约束 store 含重复 contractId");
  const expectedUnitIds = input.manifest.units.map(unitItemId).sort();
  const actualUnitIds = sortedContracts.map((contract) => contract.unit.unitId).sort();
  if (JSON.stringify(expectedUnitIds) !== JSON.stringify(actualUnitIds)) {
    throw new FusionPanelVisualConstraintValidationError("P3 约束 store 必须精确覆盖 manifest 全部单元");
  }
  const expectedKeys = sortedContracts.flatMap((contract) => contract.panels.map((panel) => constraintKey(contract.contractId, panel.id))).sort();
  if (new Set(expectedKeys).size !== expectedKeys.length) throw new FusionPanelVisualConstraintValidationError("P3 约束 store 含重复 panel 身份");
  const resolutionKeys = Object.keys(input.resolutions).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(resolutionKeys)) {
    throw new FusionPanelVisualConstraintValidationError("P3 约束 store 与 P2 resolution 集合不精确一致");
  }
  const overrides = [...(input.presenceOverrides ?? [])];
  const revealAllowlist = [...(input.revealAllowlist ?? [])];
  const overrideKeys = overrides.map((entry) => `${constraintKey(entry.contractId, entry.panelId)}:${entry.assetId}`);
  const revealKeys = revealAllowlist.map((entry) => constraintKey(entry.contractId, entry.panelId));
  if (new Set(overrideKeys).size !== overrideKeys.length) throw new FusionPanelVisualConstraintValidationError("P3 presence override 存在重复宫格资产");
  if (new Set(revealKeys).size !== revealKeys.length) throw new FusionPanelVisualConstraintValidationError("P3 reveal allowlist 存在重复宫格");
  const constraints: Record<string, PanelVisualConstraint> = {};
  for (const contract of sortedContracts) {
    for (const panel of contract.panels) {
      const key = constraintKey(contract.contractId, panel.id);
      const resolution = input.resolutions[key];
      if (!resolution) throw new FusionPanelVisualConstraintValidationError(`宫格 ${key} 缺少 P2 resolution`);
      constraints[key] = buildPanelVisualConstraint({
        manifest: input.manifest,
        contract,
        panelId: panel.id,
        resolution,
        storyboardRows: input.storyboardRows,
        presenceOverrides: overrides.filter((entry) => entry.contractId === contract.contractId && entry.panelId === panel.id),
        revealAuthorization: revealAllowlist.find((entry) => entry.contractId === contract.contractId && entry.panelId === panel.id),
      });
    }
  }
  const usedOverrideKeys = new Set(Object.values(constraints).flatMap((constraint) => constraint.assetPresence
    .filter((entry) => entry.basis === "manual-override")
    .map((entry) => `${constraintKey(constraint.gridContractId, constraint.panelId)}:${entry.assetId}`)));
  const unusedOverrides = overrideKeys.filter((key) => !usedOverrideKeys.has(key));
  if (unusedOverrides.length) throw new FusionPanelVisualConstraintValidationError(`P3 presence override 未被消费：${unusedOverrides.join("、")}`);
  const usedRevealKeys = new Set(Object.values(constraints).filter((constraint) => constraint.hiddenMaskPolicy.status === "reveal-authorized")
    .map((constraint) => constraintKey(constraint.gridContractId, constraint.panelId)));
  const unusedReveal = revealKeys.filter((key) => !usedRevealKeys.has(key));
  if (unusedReveal.length) throw new FusionPanelVisualConstraintValidationError(`P3 reveal allowlist 未被消费：${unusedReveal.join("、")}`);
  const legacyGenerationJobEvidence = normalizedLegacyGenerationJobEvidence(input.legacyGenerationJobEvidence ?? {}, constraints);
  const audit = auditPanelVisualConstraints({ contracts: sortedContracts, constraints });
  if (!audit.closurePassed) throw new FusionPanelVisualConstraintValidationError(`P3 约束 store 审计未闭包：${audit.auditFingerprint}`);
  const inputSnapshot: PanelVisualConstraintStoreInputSnapshot = {
    manifestSha256: input.manifest.manifestSha256,
    sourceContentAddress: input.manifest.contentAddress,
    gridContractsDigest: digest(sortedContracts.map((contract) => [contract.contractId, contract.sourceFingerprint, contract.productionFingerprint])),
    resolutionsDigest: digest(expectedKeys.map((key) => [key, input.resolutions[key]!.resolutionId, input.resolutions[key]!.resolutionFingerprint])),
    storyboardRowsDigest: digest([...input.storyboardRows].sort((left, right) => left.storyboardRowId.localeCompare(right.storyboardRowId, "en"))),
    presenceOverridesDigest: digest(overrides.sort((left, right) => `${left.contractId}:${left.panelId}:${left.assetId}`.localeCompare(`${right.contractId}:${right.panelId}:${right.assetId}`, "en"))),
    revealAllowlistDigest: digest(revealAllowlist.sort((left, right) => `${left.contractId}:${left.panelId}`.localeCompare(`${right.contractId}:${right.panelId}`, "en"))),
    legacyGenerationJobEvidenceDigest: digest(legacyGenerationJobEvidence),
  };
  const payload: Omit<FusionPanelVisualConstraintStore, "storeFingerprint"> = {
    schemaVersion: 1,
    kind: "fusion-panel-visual-constraints",
    builderVersion: FUSION_PANEL_VISUAL_CONSTRAINT_VERSION,
    revision,
    projectId: input.manifest.projectId,
    sourceContentAddress: input.manifest.contentAddress,
    inputSnapshot,
    presenceOverrides: overrides,
    revealAllowlist,
    legacyGenerationJobEvidence,
    constraints,
    audit,
  };
  const store: FusionPanelVisualConstraintStore = { ...payload, storeFingerprint: digest(storeFingerprintPayload(payload)) };
  validateFusionPanelVisualConstraintStore(store, input.manifest, sortedContracts);
  return store;
}

export function validateFusionPanelVisualConstraintStore(
  store: FusionPanelVisualConstraintStore,
  manifest: FusionProjectManifest,
  contracts: readonly FusionStoryboardGridContract[],
): void {
  if (store.schemaVersion !== 1 || store.kind !== "fusion-panel-visual-constraints" || store.builderVersion !== FUSION_PANEL_VISUAL_CONSTRAINT_VERSION) {
    throw new FusionPanelVisualConstraintValidationError("P3 视觉约束 store schema 不受支持");
  }
  assertRegularHash(store.storeFingerprint, "P3 storeFingerprint");
  const { storeFingerprint: _storeFingerprint, ...payload } = store;
  if (digest(storeFingerprintPayload(payload)) !== store.storeFingerprint) {
    throw new FusionPanelVisualConstraintValidationError("P3 视觉约束 store 内容摘要不匹配");
  }
  if (store.projectId !== manifest.projectId
    || store.sourceContentAddress !== manifest.contentAddress
    || store.inputSnapshot.manifestSha256 !== manifest.manifestSha256
    || store.inputSnapshot.sourceContentAddress !== manifest.contentAddress) {
    throw new FusionPanelVisualConstraintValidationError("P3 视觉约束 store 与 manifest 项目身份已漂移");
  }
  const sortedContracts = [...contracts].sort((left, right) => left.unit.unitId.localeCompare(right.unit.unitId, "en") || left.contractId.localeCompare(right.contractId, "en"));
  if (store.inputSnapshot.gridContractsDigest !== digest(sortedContracts.map((contract) => [contract.contractId, contract.sourceFingerprint, contract.productionFingerprint]))) {
    throw new FusionPanelVisualConstraintValidationError("P3 视觉约束 store 的宫格合同已漂移");
  }
  if (!Array.isArray(store.presenceOverrides) || !Array.isArray(store.revealAllowlist)
    || !store.legacyGenerationJobEvidence || typeof store.legacyGenerationJobEvidence !== "object") {
    throw new FusionPanelVisualConstraintValidationError("P3 视觉约束 store 缺少可重建的 presence/reveal/legacy Job 裁决数据");
  }
  const sortedOverrides = [...store.presenceOverrides].sort((left, right) => `${left.contractId}:${left.panelId}:${left.assetId}`.localeCompare(`${right.contractId}:${right.panelId}:${right.assetId}`, "en"));
  const sortedReveal = [...store.revealAllowlist].sort((left, right) => `${left.contractId}:${left.panelId}`.localeCompare(`${right.contractId}:${right.panelId}`, "en"));
  if (JSON.stringify(stableValue(sortedOverrides)) !== JSON.stringify(stableValue(store.presenceOverrides))
    || JSON.stringify(stableValue(sortedReveal)) !== JSON.stringify(stableValue(store.revealAllowlist))
    || store.inputSnapshot.presenceOverridesDigest !== digest(store.presenceOverrides)
    || store.inputSnapshot.revealAllowlistDigest !== digest(store.revealAllowlist)) {
    throw new FusionPanelVisualConstraintValidationError("P3 视觉约束 store 的 presence/reveal 裁决顺序或摘要不匹配");
  }
  for (const constraint of Object.values(store.constraints)) {
    const panelOverrides = store.presenceOverrides.filter((entry) => entry.contractId === constraint.gridContractId && entry.panelId === constraint.panelId);
    const panelReveal = store.revealAllowlist.find((entry) => entry.contractId === constraint.gridContractId && entry.panelId === constraint.panelId);
    if (constraint.inputSnapshot.presenceOverridesDigest !== digest(panelOverrides.map((entry) => entry).sort((left, right) => left.assetId.localeCompare(right.assetId, "en")))
      || constraint.inputSnapshot.revealAuthorizationDigest !== (panelReveal ? digest(panelReveal) : "none")) {
      throw new FusionPanelVisualConstraintValidationError(`P3 宫格 ${constraint.panelId} 与 store 正式 presence/reveal 裁决不一致`);
    }
  }
  const normalizedLegacy = normalizedLegacyGenerationJobEvidence(store.legacyGenerationJobEvidence, store.constraints);
  if (JSON.stringify(stableValue(normalizedLegacy)) !== JSON.stringify(stableValue(store.legacyGenerationJobEvidence))
    || store.inputSnapshot.legacyGenerationJobEvidenceDigest !== digest(store.legacyGenerationJobEvidence)) {
    throw new FusionPanelVisualConstraintValidationError("P3 视觉约束 store 的旧 Job 证据或摘要不匹配");
  }
  const audit = auditPanelVisualConstraints({ contracts, constraints: store.constraints });
  if (JSON.stringify(stableValue(audit)) !== JSON.stringify(stableValue(store.audit)) || !audit.closurePassed) {
    throw new FusionPanelVisualConstraintValidationError("P3 视觉约束 store 审计证据已漂移");
  }
}

export function assertFusionPanelVisualConstraintStoreCurrent(
  store: FusionPanelVisualConstraintStore,
  input: BuildFusionPanelVisualConstraintStoreInput,
): void {
  const rebuilt = buildFusionPanelVisualConstraintStore({ ...input, revision: store.revision });
  if (rebuilt.storeFingerprint !== store.storeFingerprint) {
    throw new FusionPanelVisualConstraintValidationError("P3 视觉约束 store 的 manifest、宫格合同、P2 resolution、storyboard、presence 或 reveal 输入已漂移");
  }
}

export function getPanelVisualConstraint(
  store: FusionPanelVisualConstraintStore,
  contractId: string,
  panelId: string,
): PanelVisualConstraint {
  const constraint = store.constraints[constraintKey(contractId, panelId)];
  if (!constraint) throw new FusionPanelVisualConstraintValidationError(`P3 约束 store 不存在宫格 ${contractId}/${panelId}`);
  validatePanelVisualConstraint(constraint);
  return constraint;
}
