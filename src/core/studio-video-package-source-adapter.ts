/**
 * 通用视频提交包“来源规范”适配层。
 *
 * 本模块只读取 Managed Studio 的当前证据闭包：
 * Canonical Panel → unit-grid freeze pack → raw/labeled result → current PASS Review。
 * 它不读取任何项目专属源目录、不构建文件包，也不把冻结计划冒充为实际成片观测。
 */
import { createHash } from "node:crypto";
import { inspectManagedProjectReadOnly } from "./managed-project.js";
import {
  readAnyStudioGenerationFrozenPack,
  readStudioGenerationResult,
  type AnyStudioGenerationFreezePack,
  type StudioGenerationResultRecord,
} from "./studio-generation-ledger.js";
import {
  readStudioGenerationReview,
  type StudioGenerationReviewProjection,
} from "./studio-generation-review.js";
import {
  getStudioProductionUnitSnapshot,
  type StudioProductionPanel,
  type StudioProductionUnitSnapshot,
} from "./studio-production.js";
import {
  assertStudioUnitGridGenerationFreezePackCurrent,
  type StudioUnitGridGenerationFreezePack,
  type StudioUnitGridActualTailContinuationSourceSnapshot,
  type StudioUnitGridPanelFreeze,
} from "./studio-unit-grid-generation.js";
import {
  readLocalCreativeUnitSourceContract,
  type LocalCreativeUnitSourcePanelContract,
} from "./local-creative-unit-source-contract.js";
import {
  getStudioPostResultObservationControl,
  type StudioPostResultEvidenceKind,
  type StudioPostResultObservationControl,
  type StudioPostResultObservedAvailability,
} from "./studio-post-result-observation.js";
import type { StudioSeedanceObservedState } from "./studio-seedance-prompt-compiler.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;

export type StudioVideoPackageSourceAdapterErrorCode =
  | "invalid-input"
  | "review-not-found"
  | "review-not-current-pass"
  | "pack-not-found"
  | "target-not-unit-grid"
  | "panel-count-invalid"
  | "evidence-drift";

export class StudioVideoPackageSourceAdapterError extends Error {
  readonly code: StudioVideoPackageSourceAdapterErrorCode;
  readonly details: string[];

  constructor(
    code: StudioVideoPackageSourceAdapterErrorCode,
    message: string,
    details: string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StudioVideoPackageSourceAdapterError";
    this.code = code;
    this.details = details;
  }
}

export interface StudioVideoPackageSourceAdapter<TInput, TSource> {
  readonly adapterKind: string;
  build(projectRoot: string, input: TInput): Promise<TSource>;
}

/**
 * 三层调用方 CAS。适配器仍会从 Review 追溯 result/pack/unit，并在返回前复读
 * Review；这些 expected 值用于拒绝调用方基于旧界面或旧查询继续导出。
 */
export interface ManagedEvidenceVideoPackageSourceInput {
  reviewId: string;
  expectedReviewFingerprint: string;
  expectedPackFingerprint: string;
  expectedUnitSnapshotFingerprint: string;
  expectedObservationControlFingerprint: string;
  expectedObservationHeadRevision: number;
  expectedObservationStatus: "missing" | "current" | "stale";
  expectedObservationHeadId: string | null;
  expectedObservationHeadFingerprint: string | null;
  expectedObservationEvidenceSha256: string | null;
}

export interface ManagedEvidenceVideoPackageObservationControlIdentity {
  fingerprint: string;
  status: "missing" | "current" | "stale";
  headRevision: number;
  headId: string | null;
  headFingerprint: string | null;
  evidenceContractVersion: number | null;
  evidenceKind: StudioPostResultEvidenceKind | null;
  evidenceSha256: string | null;
  evidenceLineageFingerprint: string | null;
}

export interface ManagedEvidenceVideoPackageReference {
  referenceId: string;
  mediaSha256: string;
  coveredAssetIds: string[];
  categories: string[];
  roles: string[];
  source: "canonical-control-reference" | "approved-continuation-source";
}

export interface ManagedEvidenceVideoPackageUnknownObservation {
  status: "unknown";
  endState: null;
  evidenceFingerprint: null;
  reason:
    | "post-result-observation-not-provided"
    | "post-result-observation-not-current"
    | "post-result-observation-applies-to-terminal-panel-only";
}

export interface ManagedEvidenceVideoPackageCurrentObservation {
  status: "current";
  endState: ManagedEvidenceVideoPackageObservedEndState;
  evidenceFingerprint: string;
  observationId: string;
  observationControlFingerprint: string;
  evidenceKind: StudioPostResultEvidenceKind;
  evidenceSha256: string;
  terminalPanelId: string | null;
  observedAvailability: StudioPostResultObservedAvailability;
}

export type ManagedEvidenceVideoPackageObservedEndState =
  Pick<StudioSeedanceObservedState, "referenceSha256">
  & Partial<Omit<StudioSeedanceObservedState, "referenceSha256">>;

export type ManagedEvidenceVideoPackageObservation =
  | ManagedEvidenceVideoPackageUnknownObservation
  | ManagedEvidenceVideoPackageCurrentObservation;

export interface ManagedEvidenceVideoPackageUnknownPreviousActual {
  status: "unknown";
  endState: null;
  sourceFingerprint: null;
  reason: "first-unit-or-no-continuation-source" | "legacy-continuation-source-not-observed";
}

export interface ManagedEvidenceVideoPackageCurrentPreviousActual {
  status: "current";
  endState: ManagedEvidenceVideoPackageObservedEndState;
  sourceFingerprint: string;
  sourceUnitId: string;
  sourceUnitRevision: number;
  observationId: string;
  observationControlFingerprint: string;
  evidenceKind: "terminal-panel-crop";
  evidenceSha256: string;
  evidenceLineageFingerprint: string;
}

export type ManagedEvidenceVideoPackagePreviousActual =
  | ManagedEvidenceVideoPackageUnknownPreviousActual
  | ManagedEvidenceVideoPackageCurrentPreviousActual;

export interface ManagedEvidenceVideoPackagePanel {
  order: number;
  panelId: string;
  panelIndex: number;
  timecode: {
    unitStartSeconds: number;
    unitEndSeconds: number;
    episodeStartSeconds: number;
    episodeEndSeconds: number;
    durationSeconds: number;
  };
  visualAction: string;
  shotComposition: string;
  cameraMovement: string;
  dialogue: string | null;
  subtitle: string | null;
  transition: string | null;
  costumeState: string | null;
  sceneLighting: string | null;
  shotType: "original" | "extension";
  positivePrompt: string;
  positiveLocks: string[];
  negativePrompt: string | null;
  forbiddenAssetIds: string[];
  promptRevisionId: string;
  promptSha256: string;
  planned: {
    status: "frozen-plan";
    panelPackId: string;
    panelPackFingerprint: string;
    continuityFingerprint: string;
  };
  observed: ManagedEvidenceVideoPackageObservation;
  sound: {
    dialogueSource: "canonical-panel" | "none";
    subtitleSource: "canonical-panel" | "none";
    voiceover: null;
    soundEffects: null;
    sourceSoundAndText: string | null;
    sourceSoundAndTextSource: "local-creative-source-contract" | "none";
    unspecifiedStatus: "unknown";
  };
  fingerprint: string;
}

export interface ManagedEvidenceVideoPackageSourceSpec {
  schemaVersion: 1;
  kind: "studio-video-package-source-spec";
  adapterKind: "managed-evidence-v1";
  id: string;
  projectId: string;
  unit: {
    unitId: string;
    unitRevision: number;
    unitSnapshotFingerprint: string;
    seasonId: string;
    episodeId: string;
    sequence: number;
    title: string;
    durationSeconds: number;
    episodeStartSeconds: number;
    episodeEndSeconds: number;
    panelCount: number;
  };
  evidence: {
    reviewId: string;
    reviewFingerprint: string;
    generationRunId: string;
    reviewDecision: "pass";
    packId: string;
    packFingerprint: string;
    continuityFingerprint: string;
    rawResultId: string;
    rawSha256: string;
    labeledResultId: string;
    labeledSha256: string;
    observationControl: ManagedEvidenceVideoPackageObservationControlIdentity;
  };
  references: ManagedEvidenceVideoPackageReference[];
  panels: ManagedEvidenceVideoPackagePanel[];
  continuity: {
    planned: {
      status: "frozen-plan";
      fingerprint: string;
    };
    previousActual: ManagedEvidenceVideoPackagePreviousActual;
    observed: ManagedEvidenceVideoPackageObservation;
  };
  fingerprint: string;
}

function fail(
  code: StudioVideoPackageSourceAdapterErrorCode,
  message: string,
  details: string[] = [],
): never {
  throw new StudioVideoPackageSourceAdapterError(code, message, details);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function normalizedId(value: unknown, field: string): string {
  if (typeof value !== "string") fail("invalid-input", `${field} 必须是稳定 ID。`);
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized)) fail("invalid-input", `${field} 必须是稳定 ID。`);
  return normalized;
}

function normalizedSha(value: unknown, field: string): string {
  if (typeof value !== "string") fail("invalid-input", `${field} 必须是 SHA-256。`);
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) fail("invalid-input", `${field} 必须是 SHA-256。`);
  return normalized;
}

function normalizedNullableId(value: unknown, field: string): string | null {
  return value === null ? null : normalizedId(value, field);
}

function normalizedNullableSha(value: unknown, field: string): string | null {
  return value === null ? null : normalizedSha(value, field);
}

function nullableText(value: string): string | null {
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function uniqueTexts(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function isUnitGridPack(pack: AnyStudioGenerationFreezePack): pack is StudioUnitGridGenerationFreezePack {
  return pack.schemaVersion === 5
    && pack.provenance === "unit-grid-binding-sets"
    && "targetKind" in pack.target
    && pack.target.targetKind === "unit-grid";
}

function assertCurrentPassReview(
  review: StudioGenerationReviewProjection,
  expectedReviewFingerprint: string,
): void {
  if (review.fingerprint !== expectedReviewFingerprint) {
    fail("evidence-drift", "Review 指纹与调用方预期不一致。", [
      `expected=${expectedReviewFingerprint}`,
      `actual=${review.fingerprint}`,
    ]);
  }
  if (!review.head || !review.current || !review.approvedRawEligible || review.decision !== "pass") {
    fail("review-not-current-pass", "只有当前 Head 的 PASS Review 才能导出通用视频包来源。", [
      `reviewId=${review.reviewId}`,
      `head=${review.head}`,
      `current=${review.current}`,
      `decision=${review.decision}`,
      ...review.currentStaleReasons,
    ]);
  }
}

function assertUnitGridResult(
  result: StudioGenerationResultRecord | null,
  variant: "raw" | "labeled",
  review: StudioGenerationReviewProjection,
): StudioGenerationResultRecord & { targetKind: "unit-grid" } {
  if (!result) fail("evidence-drift", `${variant} result 不存在。`);
  const expectedResultId = variant === "raw" ? review.rawResultId : review.labeledResultId;
  const expectedSha = variant === "raw" ? review.rawSha256 : review.labeledSha256;
  if (result.targetKind !== "unit-grid") {
    fail("target-not-unit-grid", `${variant} result 不是 unit-grid 目标。`);
  }
  if (result.variant !== variant
    || result.resultId !== expectedResultId
    || result.mediaSha256 !== expectedSha
    || result.generationRunId !== review.generationRunId
    || result.packId !== review.packId
    || result.packFingerprint !== review.packFingerprint
    || !result.pairComplete
    || !result.inputCurrent
    || !result.promotionEligible
    || result.staleReasons.length > 0) {
    fail("evidence-drift", `${variant} result 已漂移或不再具备正式导出资格。`, [
      `resultId=${result.resultId}`,
      `pairComplete=${result.pairComplete}`,
      `inputCurrent=${result.inputCurrent}`,
      `promotionEligible=${result.promotionEligible}`,
      ...result.staleReasons,
    ]);
  }
  return result;
}

function assertPanelIdentity(
  frozen: StudioUnitGridPanelFreeze,
  canonical: StudioProductionPanel | undefined,
): StudioProductionPanel {
  if (!canonical) fail("evidence-drift", `Canonical Panel 不存在：${frozen.panelId}`);
  if (canonical.id !== frozen.panelId
    || canonical.index !== frozen.panelIndex
    || canonical.startSeconds !== frozen.startSeconds
    || canonical.endSeconds !== frozen.endSeconds
    || canonical.durationSeconds !== frozen.durationSeconds
    || canonical.promptRevision.id !== frozen.panelPack.promptRevision.id
    || canonical.promptRevision.bodySha256 !== frozen.panelPack.promptRevision.bodySha256) {
    fail("evidence-drift", `Canonical Panel 与冻结包不一致：${frozen.panelId}`);
  }
  return canonical;
}

function unknownObservation(
  reason: ManagedEvidenceVideoPackageUnknownObservation["reason"],
): ManagedEvidenceVideoPackageUnknownObservation {
  return {
    status: "unknown",
    endState: null,
    evidenceFingerprint: null,
    reason,
  };
}

function observationControlIdentity(
  control: StudioPostResultObservationControl,
): ManagedEvidenceVideoPackageObservationControlIdentity {
  const lineage = control.head?.evidenceLineage;
  return {
    fingerprint: control.fingerprint,
    status: control.status,
    headRevision: control.headRevision,
    headId: control.head?.observationId ?? null,
    headFingerprint: control.head?.fingerprint ?? null,
    evidenceContractVersion: control.head?.evidenceContractVersion ?? null,
    evidenceKind: control.head?.evidenceKind ?? null,
    evidenceSha256: control.head?.evidenceSha256 ?? null,
    evidenceLineageFingerprint: lineage ? digest(lineage) : null,
  };
}

function assertExpectedObservationControl(
  control: StudioPostResultObservationControl,
  expected: Pick<
    ManagedEvidenceVideoPackageSourceInput,
    | "expectedObservationControlFingerprint"
    | "expectedObservationHeadRevision"
    | "expectedObservationStatus"
    | "expectedObservationHeadId"
    | "expectedObservationHeadFingerprint"
    | "expectedObservationEvidenceSha256"
  >,
): ManagedEvidenceVideoPackageObservationControlIdentity {
  const identity = observationControlIdentity(control);
  if (identity.fingerprint !== expected.expectedObservationControlFingerprint
    || identity.headRevision !== expected.expectedObservationHeadRevision
    || identity.status !== expected.expectedObservationStatus
    || identity.headId !== expected.expectedObservationHeadId
    || identity.headFingerprint !== expected.expectedObservationHeadFingerprint
    || identity.evidenceSha256 !== expected.expectedObservationEvidenceSha256) {
    fail("evidence-drift", "Observation control 与调用方 expected managed source 身份不一致。", [
      `expectedControl=${expected.expectedObservationControlFingerprint}`,
      `actualControl=${identity.fingerprint}`,
      `expectedHead=${expected.expectedObservationHeadId ?? "null"}`,
      `actualHead=${identity.headId ?? "null"}`,
    ]);
  }
  return identity;
}

function terminalFrozenPanel(
  pack: StudioUnitGridGenerationFreezePack,
): StudioUnitGridPanelFreeze | undefined {
  return [...pack.panels].sort((left, right) =>
    left.endSeconds - right.endSeconds
    || left.order - right.order
    || left.panelId.localeCompare(right.panelId, "en")).at(-1);
}

function currentObservation(
  control: StudioPostResultObservationControl,
  review: StudioGenerationReviewProjection,
  pack: StudioUnitGridGenerationFreezePack,
): ManagedEvidenceVideoPackageCurrentObservation | null {
  const head = control.head;
  if (control.status !== "current"
    || control.generationRunId !== review.generationRunId
    || !head
    || !head.head
    || !head.current
    || !head.continuationEligible
    || head.currentStaleReasons.length > 0
    || head.continuationIneligibleReasons.length > 0
    || head.evidenceContractVersion < 3
    || head.evidenceKind !== "terminal-panel-crop"
    || !head.evidenceSha256
    || !head.evidenceLineage
    || head.generationRunId !== review.generationRunId
    || head.reviewId !== review.reviewId
    || head.reviewFingerprint !== review.fingerprint
    || head.rawResultId !== review.rawResultId
    || head.rawSha256 !== review.rawSha256
    || head.labeledResultId !== review.labeledResultId
    || head.labeledSha256 !== review.labeledSha256
    || head.packId !== pack.id
    || head.packId !== review.packId
    || head.packFingerprint !== pack.fingerprint
    || head.packFingerprint !== review.packFingerprint
    || head.plannedContinuityFingerprint !== pack.continuityFingerprint
    || head.plannedContinuityFingerprint !== review.continuityFingerprint
    || head.observedState.referenceSha256 !== head.evidenceSha256) {
    return null;
  }
  const terminalPanel = terminalFrozenPanel(pack);
  if (!terminalPanel || head.terminalPanelId !== terminalPanel.panelId) {
    return null;
  }
  if (head.observedAvailability.motionVector === "observed"
      || head.observedAvailability.cameraPhase === "observed"
      || head.observedAvailability.audioPhase === "observed") {
    return null;
  }
  const endState: ManagedEvidenceVideoPackageObservedEndState = {
    referenceSha256: head.observedState.referenceSha256,
  };
  for (const [field, value] of Object.entries(head.observedState) as Array<
    [keyof StudioSeedanceObservedState, string]
  >) {
    if (field === "referenceSha256") continue;
    const availability = head.observedAvailability[
      field as keyof StudioPostResultObservedAvailability
    ];
    if (availability !== "observed") continue;
    endState[field as Exclude<keyof StudioSeedanceObservedState, "referenceSha256">] = value;
  }
  return {
    status: "current",
    endState,
    evidenceFingerprint: head.fingerprint,
    observationId: head.observationId,
    observationControlFingerprint: control.fingerprint,
    evidenceKind: head.evidenceKind,
    evidenceSha256: head.evidenceSha256,
    terminalPanelId: head.terminalPanelId ?? null,
    observedAvailability: { ...head.observedAvailability },
  };
}

function previousActual(
  source: StudioUnitGridGenerationFreezePack["continuationSource"],
): ManagedEvidenceVideoPackagePreviousActual {
  if (!source) {
    return {
      status: "unknown",
      endState: null,
      sourceFingerprint: null,
      reason: "first-unit-or-no-continuation-source",
    };
  }
  if (source.schemaVersion === 1) {
    return {
      status: "unknown",
      endState: null,
      sourceFingerprint: null,
      reason: "legacy-continuation-source-not-observed",
    };
  }
  const current = source as StudioUnitGridActualTailContinuationSourceSnapshot;
  return {
    status: "current",
    endState: {
      referenceSha256: current.evidenceSha256,
      ...current.actualState,
    },
    sourceFingerprint: current.fingerprint,
    sourceUnitId: current.sourceUnitId,
    sourceUnitRevision: current.sourceUnitRevision,
    observationId: current.observationId,
    observationControlFingerprint: current.observationControlFingerprint,
    evidenceKind: current.evidenceKind,
    evidenceSha256: current.evidenceSha256,
    evidenceLineageFingerprint: digest(current.evidenceLineage),
  };
}

function panelSource(
  frozen: StudioUnitGridPanelFreeze,
  canonical: StudioProductionPanel,
  episodeStartSeconds: number,
  localSourcePanel: LocalCreativeUnitSourcePanelContract | undefined,
  observed: ManagedEvidenceVideoPackageObservation,
): ManagedEvidenceVideoPackagePanel {
  const requiredAssets = frozen.panelPack.assets;
  const forbiddenAssets = frozen.panelPack.forbiddenAssets;
  const positiveLocks = uniqueTexts(requiredAssets.flatMap((asset) => asset.definition.positiveLocks));
  const negativeParts = uniqueTexts([
    canonical.negativePrompt,
    ...requiredAssets.flatMap((asset) => asset.definition.negativeLocks),
    ...forbiddenAssets.flatMap((asset) => asset.definition.negativeLocks),
  ]);
  const semantic = {
    order: frozen.order,
    panelId: canonical.id,
    panelIndex: canonical.index,
    timecode: {
      unitStartSeconds: canonical.startSeconds,
      unitEndSeconds: canonical.endSeconds,
      episodeStartSeconds: episodeStartSeconds + canonical.startSeconds,
      episodeEndSeconds: episodeStartSeconds + canonical.endSeconds,
      durationSeconds: canonical.durationSeconds,
    },
    visualAction: canonical.visualAction,
    shotComposition: canonical.shotComposition,
    cameraMovement: canonical.filmingMethod,
    dialogue: nullableText(canonical.dialogue),
    subtitle: nullableText(canonical.subtitle),
    transition: nullableText(canonical.transition),
    costumeState: nullableText(canonical.costumeState),
    sceneLighting: nullableText(canonical.sceneLighting),
    shotType: canonical.shotType,
    positivePrompt: frozen.panelPack.promptRevision.body,
    positiveLocks,
    negativePrompt: negativeParts.length > 0 ? negativeParts.join("；") : null,
    forbiddenAssetIds: forbiddenAssets.map((asset) => asset.assetId).sort((left, right) => left.localeCompare(right, "en")),
    promptRevisionId: frozen.panelPack.promptRevision.id,
    promptSha256: frozen.panelPack.promptRevision.bodySha256,
    planned: {
      status: "frozen-plan" as const,
      panelPackId: frozen.panelPack.id,
      panelPackFingerprint: frozen.panelPack.fingerprint,
      continuityFingerprint: frozen.panelPack.continuity.fingerprint,
    },
    observed,
    sound: {
      dialogueSource: canonical.dialogue.trim() ? "canonical-panel" as const : "none" as const,
      subtitleSource: canonical.subtitle.trim() ? "canonical-panel" as const : "none" as const,
      voiceover: null,
      soundEffects: null,
      sourceSoundAndText: nullableText(localSourcePanel?.soundAndText ?? ""),
      sourceSoundAndTextSource: localSourcePanel?.soundAndText.trim()
        ? "local-creative-source-contract" as const
        : "none" as const,
      unspecifiedStatus: "unknown" as const,
    },
  };
  return { ...semantic, fingerprint: digest(semantic) };
}

function packageReferences(pack: StudioUnitGridGenerationFreezePack): ManagedEvidenceVideoPackageReference[] {
  return pack.request.controlReferences
    .map((reference) => ({
      referenceId: reference.referenceId,
      mediaSha256: reference.mediaSha256,
      coveredAssetIds: [...reference.coveredAssetIds].sort((left, right) => left.localeCompare(right, "en")),
      categories: [...reference.categories].sort((left, right) => left.localeCompare(right, "en")),
      roles: [...reference.roles].sort((left, right) => left.localeCompare(right, "en")),
      source: reference.referenceId === pack.continuationSource?.referenceId
        ? "approved-continuation-source" as const
        : "canonical-control-reference" as const,
    }))
    .sort((left, right) => left.referenceId.localeCompare(right.referenceId, "en"));
}

function assertPackAndUnit(
  pack: StudioUnitGridGenerationFreezePack,
  snapshot: StudioProductionUnitSnapshot,
  expectedPackFingerprint: string,
  expectedUnitSnapshotFingerprint: string,
  review: StudioGenerationReviewProjection,
): void {
  if (pack.fingerprint !== expectedPackFingerprint
    || pack.fingerprint !== review.packFingerprint
    || pack.unitSnapshotFingerprint !== expectedUnitSnapshotFingerprint
    || snapshot.fingerprint !== expectedUnitSnapshotFingerprint
    || snapshot.fingerprint !== pack.unitSnapshotFingerprint
    || pack.target.unitId !== snapshot.unit.id
    || pack.target.unitRevision !== snapshot.unit.revision
    || pack.target.panelCount !== snapshot.panels.length
    || pack.continuityFingerprint !== review.continuityFingerprint) {
    fail("evidence-drift", "Review、unit-grid pack 与 Canonical Unit 的身份闭包不一致。");
  }
  if (pack.panels.length < 2 || pack.panels.length > 6
    || snapshot.panels.length < 2 || snapshot.panels.length > 6
    || pack.panels.length !== pack.target.panelCount
    || snapshot.panels.length !== snapshot.unit.panelCount) {
    fail("panel-count-invalid", "视频包来源只接受完整的 2–6 格 unit-grid。");
  }
}

/**
 * 从当前受管证据建立内容寻址的通用 package source spec。
 * 该函数无写入、无项目名/目录名假设，也不会把 planned continuity 写成 observed。
 */
export async function buildManagedEvidenceVideoPackageSource(
  projectRoot: string,
  rawInput: ManagedEvidenceVideoPackageSourceInput,
): Promise<ManagedEvidenceVideoPackageSourceSpec> {
  const input = {
    reviewId: normalizedId(rawInput.reviewId, "reviewId"),
    expectedReviewFingerprint: normalizedSha(rawInput.expectedReviewFingerprint, "expectedReviewFingerprint"),
    expectedPackFingerprint: normalizedSha(rawInput.expectedPackFingerprint, "expectedPackFingerprint"),
    expectedUnitSnapshotFingerprint: normalizedSha(
      rawInput.expectedUnitSnapshotFingerprint,
      "expectedUnitSnapshotFingerprint",
    ),
    expectedObservationControlFingerprint: normalizedSha(
      rawInput.expectedObservationControlFingerprint,
      "expectedObservationControlFingerprint",
    ),
    expectedObservationHeadRevision: rawInput.expectedObservationHeadRevision,
    expectedObservationStatus: rawInput.expectedObservationStatus,
    expectedObservationHeadId: normalizedNullableId(
      rawInput.expectedObservationHeadId,
      "expectedObservationHeadId",
    ),
    expectedObservationHeadFingerprint: normalizedNullableSha(
      rawInput.expectedObservationHeadFingerprint,
      "expectedObservationHeadFingerprint",
    ),
    expectedObservationEvidenceSha256: normalizedNullableSha(
      rawInput.expectedObservationEvidenceSha256,
      "expectedObservationEvidenceSha256",
    ),
  };
  if (!Number.isSafeInteger(input.expectedObservationHeadRevision)
    || input.expectedObservationHeadRevision < 0
    || (input.expectedObservationStatus !== "missing"
      && input.expectedObservationStatus !== "current"
      && input.expectedObservationStatus !== "stale")
    || (input.expectedObservationHeadId === null)
      !== (input.expectedObservationHeadFingerprint === null)
    || (input.expectedObservationHeadRevision === 0
      && input.expectedObservationHeadId !== null)
    || (input.expectedObservationHeadRevision > 0
      && input.expectedObservationHeadId === null)) {
    fail("invalid-input", "expected Observation control/head 身份不闭合。");
  }
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const review = await readStudioGenerationReview(shell.paths.root, input.reviewId);
  if (!review) fail("review-not-found", `Review 不存在：${input.reviewId}`);
  assertCurrentPassReview(review, input.expectedReviewFingerprint);

  const anyPack = await readAnyStudioGenerationFrozenPack(shell.paths.root, review.packId);
  if (!anyPack) fail("pack-not-found", `Review 引用的冻结包不存在：${review.packId}`);
  if (!isUnitGridPack(anyPack)) {
    fail("target-not-unit-grid", "通用视频包来源只接受 unit-grid 冻结包。");
  }
  const pack = anyPack;
  const [raw, labeled, snapshot] = await Promise.all([
    readStudioGenerationResult(shell.paths.root, review.rawResultId),
    readStudioGenerationResult(shell.paths.root, review.labeledResultId),
    getStudioProductionUnitSnapshot(shell.paths.root, pack.target.unitId),
  ]);
  const currentRaw = assertUnitGridResult(raw, "raw", review);
  const currentLabeled = assertUnitGridResult(labeled, "labeled", review);
  if (!snapshot) fail("evidence-drift", `Canonical Unit 不存在：${pack.target.unitId}`);
  assertPackAndUnit(
    pack,
    snapshot,
    input.expectedPackFingerprint,
    input.expectedUnitSnapshotFingerprint,
    review,
  );
  await assertStudioUnitGridGenerationFreezePackCurrent(shell.paths.root, pack);
  const localSourceContract = snapshot.unit.id.startsWith("unit-local-")
    ? await readLocalCreativeUnitSourceContract(shell.paths.root, snapshot.unit.id, snapshot.unit.revision)
    : null;
  if (snapshot.unit.id.startsWith("unit-local-") && !localSourceContract) {
    fail("evidence-drift", "本机来源单元缺少当前修订来源合同，禁止丢失声明声音或参考后构建视频包。");
  }
  const localSourcePanels = new Map(
    (localSourceContract?.panels ?? []).map((panel) => [panel.panelId, panel] as const),
  );
  const observationControl = await getStudioPostResultObservationControl(
    shell.paths.root,
    review.generationRunId,
  );
  const observationIdentity = assertExpectedObservationControl(observationControl, input);
  const verifiedObservation = currentObservation(observationControl, review, pack);
  const fallbackObservation = unknownObservation(
    observationControl.status === "missing"
      ? "post-result-observation-not-provided"
      : "post-result-observation-not-current",
  );
  const nonTerminalObservation = verifiedObservation
    ? unknownObservation("post-result-observation-applies-to-terminal-panel-only")
    : fallbackObservation;
  const terminalPanelId = terminalFrozenPanel(pack)?.panelId;

  const panels = [...pack.panels]
    .sort((left, right) => left.order - right.order)
    .map((frozen) => panelSource(
      frozen,
      assertPanelIdentity(
        frozen,
        snapshot.panels.find((candidate) => candidate.id === frozen.panelId),
      ),
      snapshot.unit.episodeStartSeconds,
      localSourcePanels.get(frozen.panelId),
      verifiedObservation && frozen.panelId === terminalPanelId
        ? verifiedObservation
        : nonTerminalObservation,
    ));
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-video-package-source-spec" as const,
    adapterKind: "managed-evidence-v1" as const,
    projectId: shell.project.id,
    unit: {
      unitId: snapshot.unit.id,
      unitRevision: snapshot.unit.revision,
      unitSnapshotFingerprint: snapshot.fingerprint,
      seasonId: snapshot.unit.season,
      episodeId: snapshot.unit.episode,
      sequence: snapshot.unit.sequence,
      title: snapshot.unit.title,
      durationSeconds: snapshot.unit.durationSeconds,
      episodeStartSeconds: snapshot.unit.episodeStartSeconds,
      episodeEndSeconds: snapshot.unit.episodeEndSeconds,
      panelCount: snapshot.unit.panelCount,
    },
    evidence: {
      reviewId: review.reviewId,
      reviewFingerprint: review.fingerprint,
      generationRunId: review.generationRunId,
      reviewDecision: "pass" as const,
      packId: pack.id,
      packFingerprint: pack.fingerprint,
      continuityFingerprint: pack.continuityFingerprint,
      rawResultId: currentRaw.resultId,
      rawSha256: currentRaw.mediaSha256,
      labeledResultId: currentLabeled.resultId,
      labeledSha256: currentLabeled.mediaSha256,
      observationControl: observationIdentity,
    },
    references: packageReferences(pack),
    panels,
    continuity: {
      planned: {
        status: "frozen-plan" as const,
        fingerprint: pack.continuityFingerprint,
      },
      previousActual: previousActual(pack.continuationSource),
      observed: verifiedObservation ?? fallbackObservation,
    },
  };

  // 防止 adapter 长耗时读取期间 Review Head 或结果资格发生漂移。
  const revalidatedReview = await readStudioGenerationReview(shell.paths.root, input.reviewId);
  if (!revalidatedReview
    || revalidatedReview.fingerprint !== review.fingerprint
    || !revalidatedReview.head
    || !revalidatedReview.current
    || !revalidatedReview.approvedRawEligible) {
    fail("evidence-drift", "视频包来源读取期间 Review Head 或结果资格发生漂移。");
  }
  const revalidatedObservationControl = await getStudioPostResultObservationControl(
    shell.paths.root,
    review.generationRunId,
  );
  if (digest(observationControlIdentity(revalidatedObservationControl))
    !== digest(observationIdentity)) {
    fail("evidence-drift", "视频包来源读取期间实际末态 Observation Head 或证据资格发生漂移。");
  }
  const fingerprint = digest(semantic);
  return {
    ...semantic,
    id: `studio-video-package-source-${fingerprint.slice(0, 40)}`,
    fingerprint,
  };
}

export const managedEvidenceVideoPackageSourceAdapter: StudioVideoPackageSourceAdapter<
  ManagedEvidenceVideoPackageSourceInput,
  ManagedEvidenceVideoPackageSourceSpec
> = {
  adapterKind: "managed-evidence-v1",
  build: buildManagedEvidenceVideoPackageSource,
};
