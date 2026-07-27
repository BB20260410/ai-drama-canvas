import { createHash } from "node:crypto";
import path from "node:path";
import { loadFusionProjectManifest } from "./fusion-production.js";
import {
  loadFusionPanelReferenceStoreSnapshot,
  type FusionPanelReferenceResolutionStore,
} from "./fusion-panel-references.js";
import {
  buildFusionPanelVisualConstraintStore,
  getPanelVisualConstraint,
  validateFusionPanelVisualConstraintStore,
  type FusionPanelVisualConstraintStore,
  type PanelGoldenMaskRevealAuthorization,
  type PanelVisualAssetPresence,
  type PanelVisualConstraint,
  type PanelVisualLegacyGenerationJobEvidence,
  type PanelVisualPresenceOverride,
} from "./fusion-visual-constraints.js";
import { normalizeFusionStoryboardGridContract, type FusionStoryboardGridContract } from "./fusion-storyboard-grid.js";
import { loadFusionStoryboardGridSelections } from "./fusion-storyboard-production.js";
import { withProjectLock } from "./locks.js";
import { getSidecarPaths, readJson, writeJsonAtomic } from "./sidecar.js";
import type { FusionProjectManifest } from "./fusion-package.js";
import type { GenerationJob, StoryboardProductionContract, StoryboardStore } from "./types.js";

export interface FusionPanelVisualConstraintCurrentness {
  current: boolean;
  checkedAt: string;
  storeRevision: number;
  storeFingerprint: string;
  p2StoreRevision: number;
  p2StoreFingerprint: string;
  driftedInputs: string[];
}

export interface PanelVisualConstraintQuery {
  episode?: number;
  unitItemId?: string;
  generationReady?: boolean;
  warningCode?: string;
  hiddenMaskStatus?: PanelVisualConstraint["hiddenMaskPolicy"]["status"];
  unresolvedSpatialOnly?: boolean;
  offset?: number;
  limit?: number;
}

export interface PanelVisualConstraintPage {
  total: number;
  offset: number;
  limit: number;
  items: PanelVisualConstraint[];
  audit: FusionPanelVisualConstraintStore["audit"];
  storeRevision: number;
  storeFingerprint: string;
}

interface VisualConstraintBuildInputs {
  manifest: FusionProjectManifest;
  contracts: FusionStoryboardGridContract[];
  p2: FusionPanelReferenceResolutionStore;
  storyboardRows: StoryboardProductionContract[];
  jobs: GenerationJob[];
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

function safeSegment(value: string, label: string): string {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,199}$/u.test(value) || value === "." || value === "..") {
    throw new Error(`${label} 非法：${value}`);
  }
  return value;
}

async function loadCurrentContracts(projectRoot: string, manifest: FusionProjectManifest): Promise<FusionStoryboardGridContract[]> {
  const selections = await loadFusionStoryboardGridSelections(projectRoot);
  const expectedUnitIds = manifest.units.map((unit) => `season-三-ep${String(unit.episodeNumber).padStart(2, "0")}-unit${String(unit.sequence).padStart(3, "0")}`).sort();
  const selectedUnitIds = Object.keys(selections.items).sort();
  if (JSON.stringify(expectedUnitIds) !== JSON.stringify(selectedUnitIds)) {
    throw new Error(`P3 视觉约束要求 ${expectedUnitIds.length} 个 manifest 单元都显式选择当前宫格合同。`);
  }
  const paths = getSidecarPaths(projectRoot);
  const contracts: FusionStoryboardGridContract[] = [];
  for (const itemId of selectedUnitIds) {
    const selected = selections.items[itemId]!;
    const filePath = path.join(paths.storyboardGrids, safeSegment(itemId, "单元 ID"), `${safeSegment(selected.contractId, "宫格合同 ID")}.json`);
    const stored = await readJson<FusionStoryboardGridContract | null>(filePath, null);
    if (!stored) throw new Error(`P3 找不到当前宫格合同：${filePath}`);
    const contract = normalizeFusionStoryboardGridContract(stored);
    if (contract.unit.unitId !== itemId
      || contract.contractId !== selected.contractId
      || contract.sourceFingerprint !== selected.sourceFingerprint
      || contract.productionFingerprint !== selected.productionFingerprint
      || contract.selection.panelCount !== selected.panelCount) {
      throw new Error(`P3 当前宫格选择与合同内容冲突：${itemId}`);
    }
    contracts.push(contract);
  }
  return contracts.sort((left, right) => left.unit.unitId.localeCompare(right.unit.unitId, "en"));
}

function storyboardContract(row: StoryboardStore["rows"][number]): StoryboardProductionContract {
  return {
    storyboardRowId: row.id,
    storyboardRowRevision: row.revision,
    itemId: row.itemId,
    shotItemId: row.shotItemId,
    order: row.order,
    durationSeconds: row.durationSeconds,
    shotSize: row.shotSize,
    cameraMovement: row.cameraMovement,
    cameraAngle: row.cameraAngle,
    lens: row.lens,
    composition: row.composition,
    staging: row.staging,
    action: row.action,
    expression: row.expression,
    emotion: row.emotion,
    eyeline: row.eyeline,
    screenDirection: row.screenDirection,
    axisSide: row.axisSide,
    dialogue: row.dialogue,
    narration: row.narration,
    ambience: row.ambience,
    soundEffects: row.soundEffects,
    continuityBefore: row.continuityBefore,
    continuityAfter: row.continuityAfter,
    referenceNames: row.referenceNames,
    firstFramePrompt: row.firstFramePrompt,
    endFramePrompt: row.endFramePrompt,
    videoPrompt: row.videoPrompt,
    referencePaths: row.referencePaths,
    referenceArtifactIds: row.referenceArtifactIds ?? [],
    upstreamFactRefs: row.upstreamFactRefs,
    upstreamBeatRefs: row.upstreamBeatRefs,
    sourceSpans: row.sourceSpans,
    adaptationPlanId: row.adaptationPlanId,
    adaptationUnitId: row.adaptationUnitId,
    directorIntent: row.directorIntent,
    emotionalIntent: row.emotionalIntent,
    continuityNotes: row.continuityNotes,
  };
}

async function loadBuildInputs(projectRoot: string): Promise<VisualConstraintBuildInputs> {
  const [manifest, p2Snapshot, storyboardStore, jobs] = await Promise.all([
    loadFusionProjectManifest(projectRoot),
    loadFusionPanelReferenceStoreSnapshot(projectRoot),
    readJson<StoryboardStore>(getSidecarPaths(projectRoot).storyboards, { schemaVersion: 1, revision: 0, rows: [], updatedAt: new Date(0).toISOString() }),
    readJson<GenerationJob[]>(getSidecarPaths(projectRoot).generationJobs, []),
  ]);
  if (!manifest) throw new Error("P3 视觉约束只支持已物化的融合工程。");
  if (!p2Snapshot) throw new Error("P3 视觉约束要求先完成 P2 逐格引用闭包。");
  if (!p2Snapshot.currentness.current) {
    throw new Error(`P2 逐格引用仓已漂移，拒绝物化 P3：${p2Snapshot.currentness.driftedInputs.join("、")}`);
  }
  const contracts = await loadCurrentContracts(projectRoot, manifest);
  const storyboardRows = storyboardStore.rows.filter((row) => row.status === "confirmed").map(storyboardContract);
  return { manifest, contracts, p2: p2Snapshot.store, storyboardRows, jobs };
}

function initialLegacyEvidence(
  p2: FusionPanelReferenceResolutionStore,
  jobs: GenerationJob[],
  constraints: Record<string, PanelVisualConstraint>,
): Record<string, PanelVisualLegacyGenerationJobEvidence> {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const result: Record<string, PanelVisualLegacyGenerationJobEvidence> = {};
  for (const jobId of [...p2.legacyGenerationJobIds].sort((left, right) => left.localeCompare(right, "en"))) {
    const job = jobsById.get(jobId);
    const p2Evidence = p2.legacyGenerationJobEvidence[jobId];
    if (!job || !p2Evidence || job.panelVisualConstraintEvidenceVersion) {
      throw new Error(`P3 无法冻结旧逐格任务身份：${jobId}`);
    }
    if (p2Evidence.kind === "current-resolution") {
      const constraint = constraints[`${p2Evidence.contractId}:${p2Evidence.panelId}`];
      if (!constraint) throw new Error(`P3 旧任务 ${jobId} 不能映射当前视觉约束。`);
      result[jobId] = {
        jobId,
        contractId: p2Evidence.contractId,
        panelId: p2Evidence.panelId,
        constraintId: constraint.constraintId,
        constraintFingerprint: constraint.fingerprint,
        modelFingerprint: constraint.modelFingerprint,
        reviewRulesFingerprint: constraint.reviewRulesFingerprint,
        jobLedgerFingerprint: p2Evidence.jobLedgerFingerprint,
        disposition: "current-constraint-readonly",
      };
      continue;
    }
    const constraintFingerprint = digest({ kind: "obsolete-pre-p3-job", jobId, contractId: p2Evidence.contractId, panelId: p2Evidence.panelId });
    result[jobId] = {
      jobId,
      contractId: p2Evidence.contractId,
      panelId: p2Evidence.panelId,
      constraintId: `panel-visual-${constraintFingerprint.slice(0, 28)}`,
      constraintFingerprint,
      modelFingerprint: digest({ kind: "obsolete-pre-p3-model", jobId }),
      reviewRulesFingerprint: digest({ kind: "obsolete-pre-p3-review", jobId }),
      jobLedgerFingerprint: p2Evidence.jobLedgerFingerprint,
      disposition: "obsolete-terminal-readonly",
    };
  }
  return result;
}

function assertLegacyEvidenceCurrent(
  store: FusionPanelVisualConstraintStore,
  p2: FusionPanelReferenceResolutionStore,
): void {
  const p2Ids = [...p2.legacyGenerationJobIds].sort();
  const p3Ids = Object.keys(store.legacyGenerationJobEvidence).sort();
  if (JSON.stringify(p2Ids) !== JSON.stringify(p3Ids)) throw new Error("P3 旧任务旁路集合已与 P2 漂移。");
  for (const jobId of p3Ids) {
    if (store.legacyGenerationJobEvidence[jobId]!.jobLedgerFingerprint !== p2.legacyGenerationJobEvidence[jobId]!.jobLedgerFingerprint) {
      throw new Error(`P3 旧任务 ${jobId} 的不可变账本身份已漂移。`);
    }
  }
}

export function reconcileSupersededLegacyGenerationJobEvidence(
  input: Readonly<Record<string, PanelVisualLegacyGenerationJobEvidence>>,
  constraints: Readonly<Record<string, PanelVisualConstraint>>,
): Record<string, PanelVisualLegacyGenerationJobEvidence> {
  return Object.fromEntries(Object.keys(input).sort((left, right) => left.localeCompare(right, "en")).map((jobId) => {
    const evidence = input[jobId]!;
    if (evidence.disposition !== "current-constraint-readonly") return [jobId, { ...evidence }];
    const current = constraints[`${evidence.contractId}:${evidence.panelId}`];
    if (current
      && current.constraintId === evidence.constraintId
      && current.fingerprint === evidence.constraintFingerprint
      && current.modelFingerprint === evidence.modelFingerprint
      && current.reviewRulesFingerprint === evidence.reviewRulesFingerprint) {
      return [jobId, { ...evidence }];
    }
    return [jobId, {
      ...evidence,
      disposition: "superseded-constraint-readonly" as const,
      supersededReason: current ? "current-constraint-identity-changed" as const : "current-constraint-missing" as const,
      ...(current ? { supersededByConstraintId: current.constraintId } : {}),
    }];
  }));
}

function buildStore(
  inputs: VisualConstraintBuildInputs,
  previous: FusionPanelVisualConstraintStore | null,
  revision: number,
  overrides = previous?.presenceOverrides ?? [],
  revealAllowlist = previous?.revealAllowlist ?? [],
): FusionPanelVisualConstraintStore {
  const provisional = buildFusionPanelVisualConstraintStore({
    manifest: inputs.manifest,
    contracts: inputs.contracts,
    resolutions: inputs.p2.resolutions,
    storyboardRows: inputs.storyboardRows,
    presenceOverrides: overrides,
    revealAllowlist,
    revision,
  });
  const legacyGenerationJobEvidence = previous
    ? reconcileSupersededLegacyGenerationJobEvidence(previous.legacyGenerationJobEvidence, provisional.constraints)
    : initialLegacyEvidence(inputs.p2, inputs.jobs, provisional.constraints);
  const next = buildFusionPanelVisualConstraintStore({
    manifest: inputs.manifest,
    contracts: inputs.contracts,
    resolutions: inputs.p2.resolutions,
    storyboardRows: inputs.storyboardRows,
    presenceOverrides: overrides,
    revealAllowlist,
    legacyGenerationJobEvidence,
    revision,
  });
  assertLegacyEvidenceCurrent(next, inputs.p2);
  return next;
}

export async function loadFusionPanelVisualConstraintStore(projectRoot: string): Promise<FusionPanelVisualConstraintStore | null> {
  const store = await readJson<FusionPanelVisualConstraintStore | null>(getSidecarPaths(projectRoot).panelVisualConstraints, null);
  if (!store) return null;
  if (store.schemaVersion !== 1 || store.kind !== "fusion-panel-visual-constraints") {
    throw new Error("P3 视觉约束仓 schema 不受支持，已失败关闭。");
  }
  const manifest = await loadFusionProjectManifest(projectRoot);
  if (!manifest) throw new Error("P3 视觉约束仓缺少融合 manifest。");
  const contracts = await loadCurrentContracts(projectRoot, manifest);
  validateFusionPanelVisualConstraintStore(store, manifest, contracts);
  return store;
}

export async function inspectFusionPanelVisualConstraintCurrentness(projectRoot: string): Promise<FusionPanelVisualConstraintCurrentness> {
  const store = await loadFusionPanelVisualConstraintStore(projectRoot);
  if (!store) throw new Error("P3 视觉约束尚未物化；先执行 materialize_fusion_visual_constraints。");
  const drifted = new Set<string>();
  let inputs: VisualConstraintBuildInputs | undefined;
  try {
    inputs = await loadBuildInputs(projectRoot);
  } catch {
    drifted.add("input-load-or-p2-currentness");
  }
  if (inputs) {
    try {
      const rebuilt = buildStore(inputs, store, store.revision);
      if (rebuilt.storeFingerprint !== store.storeFingerprint) drifted.add("constraint-inputs");
    } catch {
      drifted.add("constraint-rebuild");
    }
  }
  return {
    current: drifted.size === 0,
    checkedAt: new Date().toISOString(),
    storeRevision: store.revision,
    storeFingerprint: store.storeFingerprint,
    p2StoreRevision: inputs?.p2.revision ?? 0,
    p2StoreFingerprint: inputs?.p2.storeFingerprint ?? "unavailable",
    driftedInputs: [...drifted].sort(),
  };
}

export async function materializeFusionPanelVisualConstraints(projectRoot: string): Promise<FusionPanelVisualConstraintStore> {
  return withProjectLock(projectRoot, "generation", () => withProjectLock(projectRoot, "panel-visual-constraints", async () => {
    const previous = await loadFusionPanelVisualConstraintStore(projectRoot);
    const inputs = await loadBuildInputs(projectRoot);
    const sameRevision = buildStore(inputs, previous, previous?.revision ?? 1);
    if (previous?.storeFingerprint === sameRevision.storeFingerprint) return previous;
    const next = previous ? buildStore(inputs, previous, previous.revision + 1) : sameRevision;
    await writeJsonAtomic(getSidecarPaths(projectRoot).panelVisualConstraints, next);
    return next;
  }));
}

async function requireCurrentStore(projectRoot: string): Promise<FusionPanelVisualConstraintStore> {
  const store = await loadFusionPanelVisualConstraintStore(projectRoot);
  if (!store) throw new Error("P3 视觉约束尚未物化。");
  const currentness = await inspectFusionPanelVisualConstraintCurrentness(projectRoot);
  if (!currentness.current
    || currentness.storeRevision !== store.revision
    || currentness.storeFingerprint !== store.storeFingerprint) {
    throw new Error(`P3 视觉约束仓已漂移：${currentness.driftedInputs.join("、")}`);
  }
  return store;
}

export async function auditFusionPanelVisualConstraints(projectRoot: string): Promise<{
  audit: FusionPanelVisualConstraintStore["audit"];
  currentness: FusionPanelVisualConstraintCurrentness;
}> {
  const store = await requireCurrentStore(projectRoot);
  const currentness = await inspectFusionPanelVisualConstraintCurrentness(projectRoot);
  return { audit: store.audit, currentness };
}

export async function listFusionPanelVisualConstraints(
  projectRoot: string,
  query: PanelVisualConstraintQuery = {},
): Promise<PanelVisualConstraintPage> {
  const store = await requireCurrentStore(projectRoot);
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.max(1, Math.min(query.limit ?? 20, 100));
  const items = Object.values(store.constraints)
    .filter((entry) => query.episode === undefined || entry.episodeNumber === query.episode)
    .filter((entry) => !query.unitItemId || entry.unitItemId === query.unitItemId)
    .filter((entry) => query.generationReady === undefined || (entry.generationGate.status === "ready") === query.generationReady)
    .filter((entry) => !query.warningCode || entry.warnings.some((warning) => warning.code === query.warningCode))
    .filter((entry) => !query.hiddenMaskStatus || entry.hiddenMaskPolicy.status === query.hiddenMaskStatus)
    .filter((entry) => !query.unresolvedSpatialOnly || entry.spatialLocks.some((lock) => lock.status === "unresolved"))
    .sort((left, right) => left.episodeNumber - right.episodeNumber || left.unitItemId.localeCompare(right.unitItemId, "en") || left.panelIndex - right.panelIndex);
  return {
    total: items.length,
    offset,
    limit,
    items: items.slice(offset, offset + limit),
    audit: store.audit,
    storeRevision: store.revision,
    storeFingerprint: store.storeFingerprint,
  };
}

export async function getFusionPanelVisualConstraint(
  projectRoot: string,
  contractId: string,
  panelId: string,
): Promise<PanelVisualConstraint> {
  const store = await requireCurrentStore(projectRoot);
  return getPanelVisualConstraint(store, contractId, panelId);
}

export async function assertFusionPanelVisualConstraintCurrent(
  projectRoot: string,
  contractId: string,
  panelId: string,
): Promise<PanelVisualConstraint> {
  return getFusionPanelVisualConstraint(projectRoot, contractId, panelId);
}

export async function upsertFusionPanelVisualPresenceOverride(projectRoot: string, input: {
  contractId: string;
  panelId: string;
  assetId: string;
  expectedStoreRevision: number;
  expectedConstraintId: string;
  expectedResolutionId: string;
  expectedBindingId: string;
  presence: PanelVisualAssetPresence;
  reason: string;
}): Promise<FusionPanelVisualConstraintStore> {
  return withProjectLock(projectRoot, "generation", () => withProjectLock(projectRoot, "panel-visual-constraints", async () => {
    const store = await requireCurrentStore(projectRoot);
    if (store.revision !== input.expectedStoreRevision) throw new Error(`P3 store revision 已变化（当前 r${store.revision}）。`);
    const current = getPanelVisualConstraint(store, input.contractId, input.panelId);
    if (current.constraintId !== input.expectedConstraintId) throw new Error("P3 宫格约束已变化，拒绝覆盖 presence。 ");
    const reason = input.reason.trim();
    if (reason.length < 3) throw new Error("P3 presence override 必须记录原因。");
    const nextOverride: PanelVisualPresenceOverride = {
      contractId: input.contractId,
      panelId: input.panelId,
      assetId: input.assetId,
      expectedResolutionId: input.expectedResolutionId,
      expectedBindingId: input.expectedBindingId,
      presence: input.presence,
      reason,
    };
    const overrides = [...store.presenceOverrides.filter((entry) => !(entry.contractId === input.contractId && entry.panelId === input.panelId && entry.assetId === input.assetId)), nextOverride]
      .sort((left, right) => `${left.contractId}:${left.panelId}:${left.assetId}`.localeCompare(`${right.contractId}:${right.panelId}:${right.assetId}`, "en"));
    const inputs = await loadBuildInputs(projectRoot);
    const next = buildStore(inputs, store, store.revision + 1, overrides, store.revealAllowlist);
    await writeJsonAtomic(getSidecarPaths(projectRoot).panelVisualConstraints, next);
    return next;
  }));
}

export async function upsertFusionPanelGoldenMaskRevealAuthorization(projectRoot: string, input: {
  action: "set" | "remove";
  contractId: string;
  panelId: string;
  expectedStoreRevision: number;
  expectedConstraintId: string;
  authorizationId?: string;
  approvedBy: "user";
  reason: string;
  modelRevealDescription?: string;
}): Promise<FusionPanelVisualConstraintStore> {
  return withProjectLock(projectRoot, "generation", () => withProjectLock(projectRoot, "panel-visual-constraints", async () => {
    const store = await requireCurrentStore(projectRoot);
    if (store.revision !== input.expectedStoreRevision) throw new Error(`P3 store revision 已变化（当前 r${store.revision}）。`);
    const current = getPanelVisualConstraint(store, input.contractId, input.panelId);
    if (current.constraintId !== input.expectedConstraintId) throw new Error("P3 宫格约束已变化，拒绝覆盖 reveal。 ");
    const reason = input.reason.trim();
    if (reason.length < 3) throw new Error("P3 reveal 变更必须记录原因。");
    let revealAllowlist = store.revealAllowlist.filter((entry) => !(entry.contractId === input.contractId && entry.panelId === input.panelId));
    if (input.action === "set") {
      const resolution = await (await loadFusionPanelReferenceStoreSnapshot(projectRoot))?.store.resolutions[`${input.contractId}:${input.panelId}`];
      if (!resolution) throw new Error("P3 reveal 找不到当前 P2 resolution。");
      const contract = (await loadCurrentContracts(projectRoot, (await loadFusionProjectManifest(projectRoot))!)).find((entry) => entry.contractId === input.contractId);
      if (!contract) throw new Error("P3 reveal 找不到当前宫格合同。");
      const authorization: PanelGoldenMaskRevealAuthorization = {
        schemaVersion: 1,
        subject: "golden-mask",
        authorizationId: input.authorizationId?.trim() || `golden-mask-reveal-${digest({ contractId: input.contractId, panelId: input.panelId, reason }).slice(0, 24)}`,
        contractId: input.contractId,
        panelId: input.panelId,
        expectedGridSourceFingerprint: contract.sourceFingerprint,
        expectedResolutionId: resolution.resolutionId,
        approvedBy: input.approvedBy,
        reason,
        modelRevealDescription: input.modelRevealDescription?.trim() ?? "",
      };
      revealAllowlist = [...revealAllowlist, authorization];
    }
    revealAllowlist.sort((left, right) => `${left.contractId}:${left.panelId}`.localeCompare(`${right.contractId}:${right.panelId}`, "en"));
    const inputs = await loadBuildInputs(projectRoot);
    const next = buildStore(inputs, store, store.revision + 1, store.presenceOverrides, revealAllowlist);
    await writeJsonAtomic(getSidecarPaths(projectRoot).panelVisualConstraints, next);
    return next;
  }));
}
