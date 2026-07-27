import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { loadFusionProductionAssets, loadFusionProjectManifest, parseFusionUnitStoryboardReferenceAssetIds, type FusionProductionAssetCatalog } from "./fusion-production.js";
import { loadFusionStoryboardGridSelections, materializeAllFusionStoryboardGrids } from "./fusion-storyboard-production.js";
import { normalizeFusionStoryboardGridContract, type FusionStoryboardGridContract, type FusionStoryboardGridPanel } from "./fusion-storyboard-grid.js";
import { getSidecarPaths, loadIndex, readJson, writeJsonAtomic } from "./sidecar.js";
import { withProjectLock } from "./locks.js";
import type { PublicationStore } from "./publication.js";
import { reviewCoversArtifacts } from "./review-evidence.js";
import type { Artifact, GenerationJob, ProjectIndex, ProjectOverrides, ReviewStore, StoryboardRow, StoryboardStore, WorkItem } from "./types.js";
import type { FusionStoryboardGridSelectionStore } from "./types.js";
import type { MaterializedContinuitySpan, FusionContinuityStore } from "./fusion-production.js";
import type { FusionProjectManifest } from "./fusion-package.js";
import { loadCurrentCanonicalAssetAuthorityProjection } from "./canonical-assets.js";

export const FUSION_PANEL_REFERENCE_RESOLVER_VERSION = "panel-reference-resolution-v1" as const;
export const FUSION_PANEL_REFERENCE_CONTRACT_COVERAGE_VERSION = 1 as const;

export type PanelReferenceProvenanceKind =
  | "storyboard-row"
  | "source-shot-schedule"
  | "continuity-span"
  | "panel-continuity-reference"
  | "manual-include";

export interface PanelReferenceProvenance {
  kind: PanelReferenceProvenanceKind;
  storyboardRowId?: string;
  scheduleRowIndexes?: number[];
  sourceShotNumbers?: number[];
  continuitySpanIds?: string[];
  note: string;
}

export interface PanelHardLockSnapshot {
  assetId: string;
  workItemId: string;
  lockId: string;
  authority: "user-authority" | "reviewed-hard-lock";
  artifactId?: string;
  reviewId?: string;
  path: string;
  sha256: string;
  referenceVersion: string;
}

export interface PanelReferenceSemanticAsset {
  assetId: string;
  assetName: string;
  category: "character" | "scene" | "prop";
  provenance: PanelReferenceProvenance[];
  hardLock?: PanelHardLockSnapshot;
  bindingId: string;
}

export interface PanelReferenceSlot {
  id: string;
  kind: "canonical-asset" | "derived-composite";
  coveredAssetIds: string[];
  readiness: "ready" | "pending-hard-lock" | "pending-derived-artifact" | "stale";
  assetId?: string;
  derivedAssetId?: string;
  artifactId?: string;
  path?: string;
  sha256?: string;
  reviewId?: string;
}

export interface PanelReferenceTimelineReconciliation {
  assetId: string;
  difference: "storyboard-only" | "continuity-only" | "panel-continuity-only" | "parser-artifact";
  resolution: "include-storyboard-authority" | "include-overlapping-continuity" | "include-explicit-panel-continuity" | "exclude-undeclared-parser-artifact";
  status: "resolved";
  evidenceIds: string[];
  note: string;
}

export interface PanelReferenceManualOverride {
  id: string;
  revision: number;
  contractId: string;
  panelId: string;
  expectedResolutionId: string;
  includeAssetIds: string[];
  excludeAssetIds: string[];
  reason: string;
  updatedAt: string;
}

export interface DerivedPanelReferenceAsset {
  id: string;
  version: number;
  kind: "group-composite" | "prop-composite" | "mixed-composite";
  name: string;
  memberAssetIds: string[];
  memberDefinitionVersions: Record<string, string>;
  definitionFingerprint: string;
  definitionReview: {
    id: string;
    status: "approved";
    reviewedBy: "codex-p2-migration" | "user";
    reviewedAt: string;
    basis: string;
  };
  visualArtifact?: {
    artifactId: string;
    path: string;
    sha256: string;
    reviewId: string;
    memberHardLockDigest: string;
    reviewer: "user" | "codex";
    reviewedAt: string;
    reviewNote: string;
    review: {
      schemaVersion: 1;
      reviewType: "derived-panel-reference-image";
      decision: "pass";
      reviewer: "user" | "codex";
      reviewedAt: string;
      note: string;
      artifactSha256: string;
      definitionFingerprint: string;
      memberHardLockDigest: string;
    };
    width: number;
    height: number;
    fileSize: number;
  };
  status: "definition-approved" | "visual-ready" | "stale";
}

export interface PanelReferenceResolutionInputSnapshot {
  storyboardRevision: number;
  storyboardsSha256: string;
  continuitySha256: string;
  productionAssetsSha256: string;
  projectConfigSha256: string;
  gridSelectionsSha256: string;
  gridContractsDigest: string;
  hardLockSnapshotsDigest: string;
  unitMarkdownsDigest: string;
  overrideRevision: number;
  derivedDefinitionsDigest: string;
}

export interface PanelReferenceResolution {
  schemaVersion: 1;
  resolverVersion: typeof FUSION_PANEL_REFERENCE_RESOLVER_VERSION;
  resolutionId: string;
  resolutionFingerprint: string;
  projectId: string;
  sourceContentAddress: `sha256:${string}`;
  unitItemId: string;
  gridContractId: string;
  gridSourceFingerprint: string;
  panelId: string;
  panelIndex: number;
  panelCount: number;
  startSeconds: number;
  endSeconds: number;
  storyboardRowIds: string[];
  sourceShotNumbers: number[];
  scheduleRowIndexes: number[];
  inputSnapshot: PanelReferenceResolutionInputSnapshot;
  semanticAssets: PanelReferenceSemanticAsset[];
  excludedAssets: Array<{ assetId: string; reason: string; source: "manual-override" | "parser-reconciliation"; overrideId?: string }>;
  referenceSlots: PanelReferenceSlot[];
  timelineReconciliations: PanelReferenceTimelineReconciliation[];
  detectedOverflow: boolean;
  overflowHandledByDerivedAssetId?: string;
  closureStatus: "resolved" | "confirmed-empty" | "unresolved";
  generationReady: boolean;
  blockerCodes: Array<"unknown-asset" | "timeline-conflict" | "pending-hard-lock" | "pending-derived-artifact" | "stale-derived-artifact">;
  issues: string[];
}

export interface FusionPanelReferenceAudit {
  schemaVersion: 1;
  resolverVersion: typeof FUSION_PANEL_REFERENCE_RESOLVER_VERSION;
  /** 审计必须反查当前宫格合同，不能只证明 resolution 内部自洽。 */
  contractCoverageVersion: typeof FUSION_PANEL_REFERENCE_CONTRACT_COVERAGE_VERSION;
  currentContracts: number;
  panels: number;
  panelDistribution: Record<string, number>;
  semanticAssetBindings: number;
  referenceSlots: number;
  confirmedEmptyPanels: number;
  generationReadyPanels: number;
  pendingHardLockPanels: number;
  pendingHardLockReferences: number;
  pendingDerivedArtifactPanels: number;
  detectedOverflowPanels: number;
  derivedDefinitions: number;
  detectedRowContinuityDifferencePanels: number;
  detectedRowContinuityDifferences: number;
  unresolvedPanels: number;
  unresolvedReferences: number;
  knownAssetMissingBindingPanels: number;
  knownAssetMissingBindings: number;
  semanticAssetMissingSlotPanels: number;
  semanticAssetMissingSlots: number;
  contractAssetMissingBindingPanels: number;
  contractAssetMissingBindings: number;
  explicitContinuityMissingBindingPanels: number;
  explicitContinuityMissingBindings: number;
  unhandledOverflowPanels: number;
  timeSpanContinuityMismatchPanels: number;
  timeSpanContinuityMismatches: number;
  maximumSemanticAssetsPerPanel: number;
  maximumReferenceSlotsPerPanel: number;
  closurePassed: boolean;
  auditFingerprint: string;
}

export type LegacyGenerationJobEvidence = {
  kind: "current-resolution";
  contractId: string;
  panelId: string;
  resolutionId: string;
  resolutionFingerprint: string;
  jobLedgerFingerprint: string;
} | {
  kind: "obsolete-terminal";
  itemId: string;
  contractId: string;
  panelId: string;
  terminalStatus: "failed" | "cancelled";
  disposition: "non-current-contract-no-output";
  jobLedgerFingerprint: string;
  publicationIntentIds: string[];
  publicationLedgerFingerprint: string;
};

export interface FusionPanelReferenceResolutionStore {
  schemaVersion: 1;
  kind: "fusion-panel-reference-resolutions";
  resolverVersion: typeof FUSION_PANEL_REFERENCE_RESOLVER_VERSION;
  revision: number;
  projectId: string;
  sourceContentAddress: `sha256:${string}`;
  inputSnapshot: PanelReferenceResolutionInputSnapshot;
  resolutions: Record<string, PanelReferenceResolution>;
  derivedAssets: Record<string, DerivedPanelReferenceAsset>;
  overrides: Record<string, PanelReferenceManualOverride>;
  /** 首次启用 P2 前已经存在、因此不可能携带 P2 身份的只读历史任务白名单。 */
  legacyGenerationJobIds: string[];
  /**
   * 不改写历史 Job：当前合同任务旁路冻结首次 P2 resolution；已经被当前合同淘汰、
   * 且确定无输出的失败/取消任务则显式冻结为 obsolete-terminal，永远不能伪装成
   * 当前 resolution、Artifact 或 Review。
   */
  legacyGenerationJobEvidence: Record<string, LegacyGenerationJobEvidence>;
  audit: FusionPanelReferenceAudit;
  storeFingerprint: string;
  updatedAt: string;
}

export interface PanelReferenceResolutionQuery {
  episode?: number;
  unitItemId?: string;
  closureStatus?: PanelReferenceResolution["closureStatus"];
  generationReady?: boolean;
  overflowOnly?: boolean;
  offset?: number;
  limit?: number;
}

export interface PanelReferenceResolutionPage {
  total: number;
  offset: number;
  limit: number;
  items: PanelReferenceResolution[];
  audit: FusionPanelReferenceAudit;
  storeRevision: number;
  storeFingerprint: string;
}

export interface FusionPanelReferenceCurrentness {
  current: boolean;
  checkedAt: string;
  storeRevision: number;
  storeFingerprint: string;
  driftedInputs: string[];
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

export function gridSelectionSemanticDigest(store: FusionStoryboardGridSelectionStore): string {
  return digest({
    schemaVersion: store.schemaVersion,
    revision: store.revision,
    items: Object.entries(store.items)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([unitItemId, selection]) => [unitItemId, {
        contractId: selection.contractId,
        sourceFingerprint: selection.sourceFingerprint,
        productionFingerprint: selection.productionFingerprint,
        sourceStoryboardRevision: selection.sourceStoryboardRevision,
        panelCount: selection.panelCount,
        selectedBy: selection.selectedBy,
      }]),
  });
}

async function readFileSnapshot(filePath: string): Promise<{ content: Buffer; sha256: string }> {
  const before = await stat(filePath);
  if (!before.isFile()) throw new Error(`P2 引用闭包只接受常规文件：${filePath}`);
  const content = await readFile(filePath);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`P2 引用闭包读取期间文件发生变化：${filePath}`);
  }
  return { content, sha256: createHash("sha256").update(content).digest("hex") };
}

async function digestFile(filePath: string): Promise<string> {
  return (await readFileSnapshot(filePath)).sha256;
}

async function readJsonSnapshot<T>(filePath: string): Promise<{ value: T; sha256: string }> {
  const snapshot = await readFileSnapshot(filePath);
  try {
    return { value: JSON.parse(snapshot.content.toString("utf8")) as T, sha256: snapshot.sha256 };
  } catch (error) {
    throw new Error(`P2 输入 JSON 无法解析：${filePath}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

async function readJsonSnapshotOrDefault<T>(filePath: string, fallback: T): Promise<{ value: T; sha256: string }> {
  try {
    return await readJsonSnapshot<T>(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { value: fallback, sha256: "absent" };
    }
    throw error;
  }
}

async function digestFileOrAbsent(filePath: string): Promise<string> {
  try {
    return await digestFile(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

function legacyJobLedgerFingerprint(job: GenerationJob): string {
  return digest(job);
}

function publicationEvidenceForJob(job: GenerationJob, publications: PublicationStore): {
  publicationIntentIds: string[];
  publicationLedgerFingerprint: string;
  safeTerminal: boolean;
} {
  const publicationIntentIds = [...new Set([
    job.publicationIntentId,
    job.companionPublicationIntentId,
  ].filter((id): id is string => Boolean(id)))].sort((left, right) => left.localeCompare(right, "en"));
  const intents = publications.intents
    .filter((intent) => publicationIntentIds.includes(intent.id))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const receipts = publications.receipts
    .filter((receipt) => publicationIntentIds.includes(receipt.intentId))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const safeTerminal = intents.length === publicationIntentIds.length
    && intents.every((intent) => intent.status === "failed" || intent.status === "cancelled")
    && receipts.length === 0;
  return {
    publicationIntentIds,
    publicationLedgerFingerprint: digest({ intents, receipts }),
    safeTerminal,
  };
}

function obsoleteTerminalEvidence(
  job: GenerationJob,
  publications: PublicationStore,
): Extract<LegacyGenerationJobEvidence, { kind: "obsolete-terminal" }> {
  const panel = job.fusionStoryboardPanel;
  const publication = publicationEvidenceForJob(job, publications);
  const hasOutput = Boolean(
    job.resultPath
    || job.companionPath
    || job.publicationReceiptId
    || job.companionPublicationReceiptId
    || job.isolatedDownloadPath
    || job.partialDownloadPath
    || job.resultSha256
    || job.remoteResultUrl
    || job.subagentCheckpoint?.output,
  );
  if (!panel
    || (job.status !== "failed" && job.status !== "cancelled")
    || hasOutput
    || !publication.safeTerminal) {
    throw new Error(`历史逐格任务 ${job.id} 不属于当前合同且不能证明为无输出终态，拒绝建立 P2 旁路。`);
  }
  return {
    kind: "obsolete-terminal",
    itemId: job.itemId,
    contractId: panel.contractId,
    panelId: panel.panelId,
    terminalStatus: job.status,
    disposition: "non-current-contract-no-output",
    jobLedgerFingerprint: legacyJobLedgerFingerprint(job),
    publicationIntentIds: publication.publicationIntentIds,
    publicationLedgerFingerprint: publication.publicationLedgerFingerprint,
  };
}

function legacyEvidenceLedgerCurrent(
  evidence: LegacyGenerationJobEvidence,
  job: GenerationJob | undefined,
  publications: PublicationStore,
): boolean {
  if (!job
    || job.purpose !== "fusion_storyboard_panel"
    || !job.fusionStoryboardPanel
    || evidence.contractId !== job.fusionStoryboardPanel.contractId
    || evidence.panelId !== job.fusionStoryboardPanel.panelId
    || evidence.jobLedgerFingerprint !== legacyJobLedgerFingerprint(job)) return false;
  if (evidence.kind === "current-resolution") return true;
  try {
    return digest(obsoleteTerminalEvidence(job, publications)) === digest(evidence);
  } catch {
    return false;
  }
}

function resolutionKey(contractId: string, panelId: string): string {
  return `${contractId}:${panelId}`;
}

async function legacyJobMatchesStoredContract(projectRoot: string, job: GenerationJob): Promise<boolean> {
  const panel = job.fusionStoryboardPanel;
  if (!panel
    || !/^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,199}$/u.test(job.itemId)
    || !/^grid-[a-f0-9]{20}$/u.test(panel.contractId)) return false;
  const filePath = path.join(getSidecarPaths(projectRoot).storyboardGrids, job.itemId, `${panel.contractId}.json`);
  const stored = await readJson<FusionStoryboardGridContract | null>(filePath, null);
  if (!stored
    || stored.schemaVersion !== 1
    || stored.kind !== "fusion-storyboard-grid-contract"
    || stored.contractId !== panel.contractId
    || stored.unit.unitId !== job.itemId) return false;
  const contract = normalizeFusionStoryboardGridContract(stored);
  const matched = contract.panels.find((candidate) => candidate.id === panel.panelId);
  return Boolean(matched)
    && contract.sourceFingerprint === panel.sourceFingerprint
    && contract.selection.panelCount === panel.panelCount
    && matched!.index === panel.panelIndex
    && matched!.frameRole === panel.frameRole
    && Math.abs(matched!.startSeconds - panel.startSeconds) <= 1e-6
    && Math.abs(matched!.endSeconds - panel.endSeconds) <= 1e-6;
}

function storeFingerprintFor(store: Pick<FusionPanelReferenceResolutionStore,
  "schemaVersion" | "kind" | "resolverVersion" | "projectId" | "sourceContentAddress" | "inputSnapshot" | "resolutions" | "derivedAssets" | "overrides" | "legacyGenerationJobIds" | "legacyGenerationJobEvidence" | "audit">): string {
  return digest({
    schemaVersion: store.schemaVersion,
    kind: store.kind,
    resolverVersion: store.resolverVersion,
    projectId: store.projectId,
    sourceContentAddress: store.sourceContentAddress,
    inputSnapshot: store.inputSnapshot,
    resolutions: store.resolutions,
    derivedAssets: store.derivedAssets,
    overrides: store.overrides,
    legacyGenerationJobIds: store.legacyGenerationJobIds,
    legacyGenerationJobEvidence: store.legacyGenerationJobEvidence,
    audit: store.audit,
  });
}

function episodeFromUnit(itemId: string): number | undefined {
  const match = itemId.match(/-ep(\d{2})-/u);
  return match ? Number(match[1]) : undefined;
}

function overlaps(panel: FusionStoryboardGridPanel, span: MaterializedContinuitySpan): boolean {
  return span.startSeconds < panel.endSeconds - 1e-6 && span.endSeconds > panel.startSeconds + 1e-6;
}

function activeRaw(index: ProjectIndex, item: WorkItem, expectedPath: string): Artifact | undefined {
  return index.artifacts.find((artifact) => artifact.itemId === item.id
    && artifact.kind === "raw-image"
    && artifact.authoritative
    && !artifact.deprecated
    && artifact.check.ok
    && artifact.check.decodable !== false
    && path.resolve(artifact.path) === path.resolve(expectedPath));
}

export async function resolvePanelHardLockSnapshots(
  projectRoot: string,
  index: ProjectIndex,
  catalog: FusionProductionAssetCatalog,
  reviews: ReviewStore,
  overrides: ProjectOverrides,
): Promise<Map<string, PanelHardLockSnapshot>> {
  const result = new Map<string, PanelHardLockSnapshot>();
  const canonicalProjection = await loadCurrentCanonicalAssetAuthorityProjection(projectRoot);
  const canonicalAuthorities = new Map(canonicalProjection?.assets.map((entry) => [entry.assetId, entry]) ?? []);
  const configured = new Map((index.project.hardLocks ?? []).map((lock) => [lock.id, lock]));
  for (const entry of catalog.assets) {
    const assetId = entry.definition.id;
    const item = index.items.find((candidate) => candidate.id === entry.workItemId && candidate.type === "asset");
    if (!item) continue;
    if (canonicalProjection) {
      const authority = canonicalAuthorities.get(assetId);
      if (!authority) continue;
      const actualSha = await digestFile(authority.path).catch(() => undefined);
      if (actualSha !== authority.sha256) throw new Error(`规范资产 ${assetId} 主权威文件 SHA 已漂移，禁止回退旧硬锁。`);
      const artifact = activeRaw(index, item, authority.path);
      if (!artifact || artifact.check.sha256 !== authority.sha256 || !item.hardLockIds.includes(assetId)) {
        throw new Error(`Scanner 尚未按规范资产 ${assetId} 主权威建立当前投影。`);
      }
      if (authority.labeledPath && authority.labeledSha256) {
        const labeled = index.artifacts.find((candidate) => candidate.itemId === item.id
          && candidate.kind === "labeled-image"
          && candidate.authoritative
          && !candidate.deprecated
          && candidate.check.ok
          && candidate.check.decodable !== false
          && path.resolve(candidate.path) === path.resolve(authority.labeledPath!)
          && candidate.check.sha256 === authority.labeledSha256);
        if (!labeled) throw new Error(`Scanner 缺少规范资产 ${assetId} 的权威 labeled 成员。`);
      }
      result.set(assetId, {
        assetId,
        workItemId: item.id,
        lockId: authority.authorityId,
        authority: authority.authority,
        artifactId: artifact.id,
        ...(authority.reviewId ? { reviewId: authority.reviewId } : {}),
        path: path.resolve(authority.path),
        sha256: authority.sha256,
        referenceVersion: authority.versionId,
      });
      continue;
    }
    const authority = entry.authority;
    const lock = authority
      ? { id: assetId, path: authority.snapshotPath }
      : configured.get(assetId) ?? item.hardLockIds.map((id) => configured.get(id)).find(Boolean);
    if (!lock?.path || !item.hardLockIds.length) continue;
    const actualSha = await digestFile(lock.path).catch(() => undefined);
    if (!actualSha) continue;
    if (authority && (actualSha !== authority.snapshotSha256 || path.resolve(lock.path) !== path.resolve(authority.snapshotPath))) continue;
    const artifact = activeRaw(index, item, lock.path);
    if (!artifact && !authority) continue;
    if (!authority && artifact?.check.sha256 && artifact.check.sha256 !== actualSha) continue;
    const labeled = artifact && index.artifacts.find((candidate) => candidate.itemId === item.id
      && candidate.kind === "labeled-image"
      && candidate.variant === "generic"
      && candidate.authoritative
      && !candidate.deprecated);
    if (labeled && (!labeled.check.ok || labeled.check.decodable === false)) continue;
    const requiredArtifacts = artifact ? labeled ? [artifact, labeled] : [artifact] : [];
    const explicitReviewId = overrides.items[item.id]?.reviewEvidenceIds?.image;
    const review = authority ? undefined : reviews.records
      .filter((candidate) => candidate.id === explicitReviewId
        && candidate.itemId === item.id
        && candidate.reviewType === "image"
        && candidate.decision === "pass"
        && candidate.resultingStatus === "已完成"
        && reviewCoversArtifacts(candidate, requiredArtifacts))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    // 用户权威参考是外部明确授权边界；项目内提升的硬锁则必须复用与
    // promoteAssetToHardLock 完全相同的“当前文件 SHA + 视觉 pass”证据，
    // 不能仅凭 config 中存在 hardLock 就让逐格引用进入 ready。
    if (!authority && !review) continue;
    result.set(assetId, {
      assetId,
      workItemId: item.id,
      lockId: lock.id,
      authority: authority ? "user-authority" : "reviewed-hard-lock",
      artifactId: artifact?.id,
      reviewId: authority ? undefined : review?.id,
      path: path.resolve(lock.path),
      sha256: actualSha,
      referenceVersion: digest({ assetId, path: path.resolve(lock.path), sha256: actualSha, reviewId: review?.id, sourceSectionSha256: entry.definition.sourceSectionSha256 }),
    });
  }
  return result;
}

function definitionKind(memberAssetIds: string[], catalog: FusionProductionAssetCatalog): DerivedPanelReferenceAsset["kind"] {
  const categories = new Set(memberAssetIds.map((id) => catalog.assets.find((entry) => entry.definition.id === id)?.definition.category));
  if (categories.size === 1 && categories.has("prop")) return "prop-composite";
  if (categories.size === 1 && categories.has("character")) return "group-composite";
  return "mixed-composite";
}

function derivedAssetFor(
  memberAssetIds: string[],
  catalog: FusionProductionAssetCatalog,
  previous: Record<string, DerivedPanelReferenceAsset>,
  now: string,
): DerivedPanelReferenceAsset {
  const sorted = [...new Set(memberAssetIds)].sort();
  const versions = Object.fromEntries(sorted.map((assetId) => {
    const entry = catalog.assets.find((candidate) => candidate.definition.id === assetId);
    return [assetId, entry?.definition.sourceSectionSha256 ?? "missing-definition"];
  }));
  const definitionFingerprint = digest({ resolverVersion: FUSION_PANEL_REFERENCE_RESOLVER_VERSION, memberAssetIds: sorted, memberDefinitionVersions: versions });
  const id = `derived-reference-${definitionFingerprint.slice(0, 24)}`;
  const existing = previous[id];
  if (existing?.definitionFingerprint === definitionFingerprint) return existing;
  const kind = definitionKind(sorted, catalog);
  return {
    id,
    version: existing ? existing.version + 1 : 1,
    kind,
    name: `${kind === "prop-composite" ? "道具组合" : kind === "group-composite" ? "群像组合" : "混合组合"}·${sorted.join("+")}`,
    memberAssetIds: sorted,
    memberDefinitionVersions: versions,
    definitionFingerprint,
    definitionReview: {
      id: `derived-reference-review-${definitionFingerprint.slice(0, 24)}`,
      status: "approved",
      reviewedBy: "codex-p2-migration",
      reviewedAt: now,
      basis: "P2 逐宫格引用闭包迁移：完整覆盖超出六槽的语义集合；该结构审核不替代组合图视觉验收。",
    },
    status: "definition-approved",
  };
}

function digestMemberHardLocks(assets: PanelReferenceSemanticAsset[]): string | undefined {
  if (assets.some((asset) => !asset.hardLock)) return undefined;
  return digest(assets.map((asset) => ({
    assetId: asset.assetId,
    referenceVersion: asset.hardLock!.referenceVersion,
    sha256: asset.hardLock!.sha256,
  })).sort((left, right) => left.assetId.localeCompare(right.assetId, "en")));
}

function isInsideProject(projectRoot: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function validateDerivedVisualArtifact(
  projectRoot: string,
  asset: DerivedPanelReferenceAsset,
  currentMemberHardLockDigest: string | undefined,
): Promise<DerivedPanelReferenceAsset> {
  const visual = asset.visualArtifact;
  if (!visual) return { ...asset, status: "definition-approved" };
  if (!currentMemberHardLockDigest
    || visual.memberHardLockDigest !== currentMemberHardLockDigest
    || !isInsideProject(projectRoot, visual.path)
    || visual.review?.schemaVersion !== 1
    || visual.review.reviewType !== "derived-panel-reference-image"
    || visual.review.decision !== "pass"
    || visual.review.reviewer !== visual.reviewer
    || visual.review.reviewedAt !== visual.reviewedAt
    || visual.review.note !== visual.reviewNote
    || visual.review.artifactSha256 !== visual.sha256
    || visual.review.definitionFingerprint !== asset.definitionFingerprint
    || visual.review.memberHardLockDigest !== visual.memberHardLockDigest) return { ...asset, status: "stale" };
  const actualSha = await digestFile(visual.path).catch(() => undefined);
  if (!actualSha || actualSha !== visual.sha256) return { ...asset, status: "stale" };
  const metadata = await sharp(visual.path, { failOn: "error" }).metadata().catch(() => undefined);
  const file = await stat(visual.path).catch(() => undefined);
  if (!metadata?.width || !metadata.height || !file?.isFile()
    || metadata.width !== visual.width || metadata.height !== visual.height || file.size !== visual.fileSize) {
    return { ...asset, status: "stale" };
  }
  return { ...asset, status: "visual-ready" };
}

async function loadCorrectedUnitReferenceExpectations(
  projectRoot: string,
  manifest: FusionProjectManifest,
): Promise<{ byUnitItemId: Map<string, Map<number, string[]>>; aggregateDigest: string }> {
  const packageRelative = path.relative(path.resolve(manifest.source.root), path.resolve(manifest.source.packageRoot));
  if (!packageRelative || packageRelative.startsWith("..") || path.isAbsolute(packageRelative)) {
    throw new Error("P2 无法从融合 manifest 安全定位隔离的制作包快照。");
  }
  const snapshotPackageRoot = path.join(projectRoot, "source_snapshot", packageRelative);
  if (!isInsideProject(projectRoot, snapshotPackageRoot)) throw new Error("P2 制作包快照路径越出隔离工程。");
  const records = await Promise.all(manifest.units.map(async (unit) => {
    const markdownPath = path.join(snapshotPackageRoot, ...unit.markdownPath.split("/"));
    if (!isInsideProject(snapshotPackageRoot, markdownPath)) throw new Error(`P2 单元 Markdown 路径越界：${unit.id}`);
    const snapshot = await readFileSnapshot(markdownPath);
    const markdownSha256 = snapshot.sha256;
    if (markdownSha256 !== unit.markdownSha256) throw new Error(`P2 单元 Markdown 快照 SHA 漂移：${unit.id}`);
    const markdown = snapshot.content.toString("utf8");
    return {
      unitItemId: `season-三-ep${String(unit.episodeNumber).padStart(2, "0")}-unit${String(unit.sequence).padStart(3, "0")}`,
      markdownSha256,
      references: parseFusionUnitStoryboardReferenceAssetIds(unit, markdown),
    };
  }));
  return {
    byUnitItemId: new Map(records.map((record) => [record.unitItemId, record.references])),
    aggregateDigest: digest(records.map((record) => [record.unitItemId, record.markdownSha256])
      .sort(([left], [right]) => String(left).localeCompare(String(right), "en"))),
  };
}

function provenanceForAsset(
  assetId: string,
  rows: StoryboardRow[],
  spans: MaterializedContinuitySpan[],
  panel: FusionStoryboardGridPanel,
  manuallyIncluded: boolean,
): PanelReferenceProvenance[] {
  const result: PanelReferenceProvenance[] = [];
  const rowIds = rows.filter((row) => row.referenceNames?.includes(assetId)).map((row) => row.id);
  for (const rowId of rowIds) result.push({ kind: "storyboard-row", storyboardRowId: rowId, note: "已确认分镜行显式引用" });
  const matching = spans.filter((span) => span.assetId === assetId);
  if (matching.length) result.push({
    kind: "continuity-span",
    continuitySpanIds: matching.map((span) => span.id).sort(),
    scheduleRowIndexes: [...new Set(matching.flatMap((span) => span.scheduleRowIndexes))].sort((a, b) => a - b),
    sourceShotNumbers: [...new Set(matching.flatMap((span) => span.sourceShots))].sort((a, b) => a - b),
    note: "连续性时间段与当前宫格半开区间相交",
  });
  if (panel.continuityReferenceAssetIds.includes(assetId)) result.push({
    kind: "panel-continuity-reference",
    scheduleRowIndexes: [...panel.scheduleRowIndexes],
    sourceShotNumbers: [...panel.sourceShotNumbers],
    note: "当前宫格合同显式要求的连续性参考；用于身份或道具一致性，不等于强制出镜",
  });
  if (panel.sourceShotNumbers.length) result.push({
    kind: "source-shot-schedule",
    scheduleRowIndexes: [...panel.scheduleRowIndexes],
    sourceShotNumbers: [...panel.sourceShotNumbers],
    note: "宫格对应的原镜与融合排期秒段",
  });
  if (manuallyIncluded) result.push({ kind: "manual-include", note: "带原因和 resolution CAS 的人工补入" });
  return result;
}

async function loadContracts(
  projectRoot: string,
  frozenSelections?: FusionStoryboardGridSelectionStore,
): Promise<FusionStoryboardGridContract[]> {
  const paths = getSidecarPaths(projectRoot);
  const selections = frozenSelections ?? await loadFusionStoryboardGridSelections(projectRoot);
  const result: FusionStoryboardGridContract[] = [];
  for (const [unitItemId, selection] of Object.entries(selections.items)) {
    const filePath = path.join(paths.storyboardGrids, unitItemId, `${selection.contractId}.json`);
    const stored = await readJsonSnapshot<FusionStoryboardGridContract>(filePath).catch(() => undefined);
    if (!stored) throw new Error(`P2 当前宫格合同缺失或损坏：${unitItemId}/${selection.contractId}`);
    const contract = normalizeFusionStoryboardGridContract(stored.value);
    if (contract.unit.unitId !== unitItemId
      || contract.contractId !== selection.contractId
      || contract.sourceFingerprint !== selection.sourceFingerprint
      || contract.productionFingerprint !== selection.productionFingerprint) {
      throw new Error(`P2 当前宫格选择与合同内容冲突：${unitItemId}`);
    }
    result.push(contract);
  }
  return result.sort((left, right) => left.unit.unitId.localeCompare(right.unit.unitId, "en"));
}

function auditFor(
  contracts: FusionStoryboardGridContract[],
  resolutions: Record<string, PanelReferenceResolution>,
  derivedAssets: Record<string, DerivedPanelReferenceAsset>,
): FusionPanelReferenceAudit {
  const items = Object.values(resolutions);
  const semanticSlotMissingByPanel = items.map((resolution) => {
    const covered = new Set(resolution.referenceSlots.flatMap((slot) => slot.coveredAssetIds));
    return resolution.semanticAssets.filter((asset) => !covered.has(asset.assetId));
  });
  const missingKeys = new Set<string>();
  const missingPanels = new Set<string>();
  const contractMissingKeys = new Set<string>();
  const contractMissingPanels = new Set<string>();
  const explicitContinuityMissingKeys = new Set<string>();
  const explicitContinuityMissingPanels = new Set<string>();
  for (const [index, resolution] of items.entries()) {
    for (const asset of semanticSlotMissingByPanel[index] ?? []) {
      const key = `${resolution.gridContractId}\0${resolution.panelId}\0${asset.assetId}`;
      missingKeys.add(key);
      missingPanels.add(`${resolution.gridContractId}\0${resolution.panelId}`);
    }
  }
  for (const contract of contracts) {
    for (const panel of contract.panels) {
      const panelKey = `${contract.contractId}\0${panel.id}`;
      const resolution = resolutions[resolutionKey(contract.contractId, panel.id)];
      const semantic = new Set(resolution?.semanticAssets.map((asset) => asset.assetId) ?? []);
      const explicitlyExcluded = new Set(resolution?.excludedAssets.map((asset) => asset.assetId) ?? []);
      for (const assetId of panel.assetIds) {
        if (semantic.has(assetId) || explicitlyExcluded.has(assetId)) continue;
        const key = `${panelKey}\0${assetId}`;
        missingKeys.add(key);
        missingPanels.add(panelKey);
        contractMissingKeys.add(key);
        contractMissingPanels.add(panelKey);
      }
      for (const assetId of panel.continuityReferenceAssetIds) {
        if (semantic.has(assetId)) continue;
        const key = `${panelKey}\0${assetId}`;
        missingKeys.add(key);
        missingPanels.add(panelKey);
        explicitContinuityMissingKeys.add(key);
        explicitContinuityMissingPanels.add(panelKey);
      }
    }
  }
  const unresolved = items.filter((resolution) => resolution.closureStatus === "unresolved");
  const timelineUnresolved = items.filter((resolution) => resolution.blockerCodes.includes("timeline-conflict"));
  const overflowUnhandled = items.filter((resolution) => resolution.detectedOverflow && !resolution.overflowHandledByDerivedAssetId);
  const differencePanels = items.filter((resolution) => resolution.timelineReconciliations.length > 0);
  const panelDistribution: Record<string, number> = {};
  for (const contract of contracts) panelDistribution[String(contract.selection.panelCount)] = (panelDistribution[String(contract.selection.panelCount)] ?? 0) + 1;
  const base = {
    schemaVersion: 1 as const,
    resolverVersion: FUSION_PANEL_REFERENCE_RESOLVER_VERSION,
    contractCoverageVersion: FUSION_PANEL_REFERENCE_CONTRACT_COVERAGE_VERSION,
    currentContracts: contracts.length,
    panels: items.length,
    panelDistribution,
    semanticAssetBindings: items.reduce((sum, item) => sum + item.semanticAssets.length, 0),
    referenceSlots: items.reduce((sum, item) => sum + item.referenceSlots.length, 0),
    confirmedEmptyPanels: items.filter((item) => item.closureStatus === "confirmed-empty").length,
    generationReadyPanels: items.filter((item) => item.generationReady).length,
    pendingHardLockPanels: items.filter((item) => item.blockerCodes.includes("pending-hard-lock")).length,
    pendingHardLockReferences: items.reduce((sum, item) => sum + item.referenceSlots.filter((slot) => slot.readiness === "pending-hard-lock").length, 0),
    pendingDerivedArtifactPanels: items.filter((item) => item.blockerCodes.includes("pending-derived-artifact")).length,
    detectedOverflowPanels: items.filter((item) => item.detectedOverflow).length,
    derivedDefinitions: Object.keys(derivedAssets).length,
    detectedRowContinuityDifferencePanels: differencePanels.length,
    detectedRowContinuityDifferences: differencePanels.reduce((sum, item) => sum + item.timelineReconciliations.length, 0),
    unresolvedPanels: unresolved.length,
    unresolvedReferences: unresolved.reduce((sum, item) => sum + item.blockerCodes.filter((code) => code === "unknown-asset" || code === "timeline-conflict").length, 0),
    knownAssetMissingBindingPanels: missingPanels.size,
    knownAssetMissingBindings: missingKeys.size,
    semanticAssetMissingSlotPanels: semanticSlotMissingByPanel.filter((missing) => missing.length > 0).length,
    semanticAssetMissingSlots: semanticSlotMissingByPanel.reduce((sum, missing) => sum + missing.length, 0),
    contractAssetMissingBindingPanels: contractMissingPanels.size,
    contractAssetMissingBindings: contractMissingKeys.size,
    explicitContinuityMissingBindingPanels: explicitContinuityMissingPanels.size,
    explicitContinuityMissingBindings: explicitContinuityMissingKeys.size,
    unhandledOverflowPanels: overflowUnhandled.length,
    timeSpanContinuityMismatchPanels: timelineUnresolved.length,
    timeSpanContinuityMismatches: timelineUnresolved.reduce((sum, item) => sum + item.issues.filter((issue) => issue.includes("时间段")).length, 0),
    maximumSemanticAssetsPerPanel: Math.max(0, ...items.map((item) => item.semanticAssets.length)),
    maximumReferenceSlotsPerPanel: Math.max(0, ...items.map((item) => item.referenceSlots.length)),
  };
  const closurePassed = base.currentContracts === 1_288
    && base.panels === 4_330
    && base.unresolvedPanels === 0
    && base.knownAssetMissingBindings === 0
    && base.unhandledOverflowPanels === 0
    && base.timeSpanContinuityMismatches === 0
    && base.maximumReferenceSlotsPerPanel <= 6;
  return { ...base, closurePassed, auditFingerprint: digest({ ...base, closurePassed }) };
}

async function computeStore(
  projectRoot: string,
  previous: FusionPanelReferenceResolutionStore | null,
): Promise<Omit<FusionPanelReferenceResolutionStore, "revision" | "updatedAt" | "storeFingerprint">> {
  const paths = getSidecarPaths(projectRoot);
  // 所有直接输入都从“同一份字节”同时得到解析值和 SHA，避免先解析 S1、
  // 后摘要 S2 的混合快照。函数尾还会二次核对，写者无需共享 P2 锁也会失败关闭。
  const [manifestSnapshot, catalogSnapshot, continuitySnapshot, storyboardSnapshot, indexSnapshot, reviewsSnapshot, overridesSnapshot, selectionsSnapshot, configSnapshot, generationJobsSnapshot, publicationsSnapshot] = await Promise.all([
    readJsonSnapshot<FusionProjectManifest>(paths.fusionProjectManifest),
    readJsonSnapshot<FusionProductionAssetCatalog>(paths.productionAssets),
    readJsonSnapshot<FusionContinuityStore>(paths.continuityTracks),
    readJsonSnapshot<StoryboardStore>(paths.storyboards),
    readJsonSnapshot<ProjectIndex>(paths.index),
    readJsonSnapshotOrDefault<ReviewStore>(paths.reviews, { schemaVersion: 1, records: [] }),
    readJsonSnapshotOrDefault<ProjectOverrides>(paths.overrides, { schemaVersion: 1, items: {} }),
    readJsonSnapshot<FusionStoryboardGridSelectionStore>(paths.storyboardGridSelections),
    readJsonSnapshot<{ hardLocks?: Array<{ id: string; name: string; path: string; note: string }> }>(paths.config),
    readJsonSnapshotOrDefault<GenerationJob[]>(paths.generationJobs, []),
    readJsonSnapshotOrDefault<PublicationStore>(paths.publications, { schemaVersion: 1, revision: 0, intents: [], receipts: [], updatedAt: new Date(0).toISOString() }),
  ]);
  const manifest = manifestSnapshot.value;
  const catalog = catalogSnapshot.value;
  const continuity = continuitySnapshot.value;
  const storyboardStore = storyboardSnapshot.value;
  const index = indexSnapshot.value;
  const reviews = reviewsSnapshot.value;
  const projectConfig = configSnapshot.value;
  const projectOverrides = overridesSnapshot.value;
  const contracts = await loadContracts(projectRoot, selectionsSnapshot.value);
  if (manifest.projectId !== catalog.projectId
    || manifest.contentAddress !== catalog.sourceContentAddress
    || continuity.sourceContentAddress !== manifest.contentAddress
    || index.project.id !== manifest.projectId) {
    throw new Error("P2 引用闭包输入不属于同一内容寻址工程。");
  }
  if (contracts.length !== manifest.units.length) throw new Error(`P2 当前合同应为 ${manifest.units.length}，实际为 ${contracts.length}`);
  const expectedUnitItemIds = manifest.units.map((unit) => `season-三-ep${String(unit.episodeNumber).padStart(2, "0")}-unit${String(unit.sequence).padStart(3, "0")}`).sort();
  const contractUnitItemIds = contracts.map((contract) => contract.unit.unitId).sort();
  if (new Set(contractUnitItemIds).size !== contractUnitItemIds.length || JSON.stringify(contractUnitItemIds) !== JSON.stringify(expectedUnitItemIds)) {
    throw new Error("P2 当前宫格合同的单元集合与 manifest 不精确一致（缺失、重复或越界）。");
  }
  const correctedReferenceExpectations = await loadCorrectedUnitReferenceExpectations(projectRoot, manifest);
  const generationJobs = generationJobsSnapshot.value;
  const publications = publicationsSnapshot.value;
  const projectConfigDigest = digest([...(projectConfig.hardLocks ?? [])].sort((left, right) => left.id.localeCompare(right.id, "en")));
  const fileDigests = [storyboardSnapshot.sha256, continuitySnapshot.sha256, catalogSnapshot.sha256, gridSelectionSemanticDigest(selectionsSnapshot.value)];
  const locks = await resolvePanelHardLockSnapshots(projectRoot, index, catalog, reviews, projectOverrides);
  const definitions = new Map(catalog.assets.map((entry) => [entry.definition.id, entry.definition]));
  const rowsById = new Map(storyboardStore.rows.map((row) => [row.id, row]));
  const spansByUnit = new Map<string, MaterializedContinuitySpan[]>();
  const continuityIntegrityByUnit = new Map<string, string[]>();
  const globalContinuityIntegrityIssues: string[] = [];
  const seenContinuityTrackAssets = new Set<string>();
  const seenContinuitySpanIds = new Set<string>();
  const continuityDefinitions = new Map(catalog.assets.map((entry) => [entry.definition.id, entry.definition]));
  const unitsByItemId = new Map(manifest.units.map((unit) => [
    `season-三-ep${String(unit.episodeNumber).padStart(2, "0")}-unit${String(unit.sequence).padStart(3, "0")}`,
    unit,
  ]));
  const addContinuityIssue = (unitItemId: string, issue: string) => {
    const issues = continuityIntegrityByUnit.get(unitItemId) ?? [];
    issues.push(issue);
    continuityIntegrityByUnit.set(unitItemId, issues);
  };
  for (const track of continuity.tracks) {
    if (seenContinuityTrackAssets.has(track.assetId)) globalContinuityIntegrityIssues.push(`连续性资产 ${track.assetId} 存在重复 track`);
    seenContinuityTrackAssets.add(track.assetId);
    const trackDefinition = continuityDefinitions.get(track.assetId);
    if (!trackDefinition) globalContinuityIntegrityIssues.push(`连续性 track 引用了资产目录不存在的 ${track.assetId}`);
    else if (track.assetName !== trackDefinition.name || track.category !== trackDefinition.category) globalContinuityIntegrityIssues.push(`连续性资产 ${track.assetId} 的名称或类别与资产目录不一致`);
    if (track.workItemId !== `asset-${track.assetId}`) globalContinuityIntegrityIssues.push(`连续性资产 ${track.assetId} 的 workItemId 不一致`);
    const trackUnits = [...new Set(track.unitIds)].sort();
    const spanUnits = [...new Set(track.spans.map((span) => span.unitId))].sort();
    const trackEpisodes = [...new Set(track.episodeCodes)].sort();
    const spanEpisodes = [...new Set(track.spans.map((span) => span.episode))].sort();
    if (trackUnits.length !== track.unitIds.length) globalContinuityIntegrityIssues.push(`连续性资产 ${track.assetId} 的 unitIds 存在重复项`);
    if (trackEpisodes.length !== track.episodeCodes.length) globalContinuityIntegrityIssues.push(`连续性资产 ${track.assetId} 的 episodeCodes 存在重复项`);
    if (JSON.stringify(trackUnits) !== JSON.stringify(spanUnits)) globalContinuityIntegrityIssues.push(`连续性资产 ${track.assetId} 的 unitIds 与 spans 聚合不一致`);
    if (JSON.stringify(trackEpisodes) !== JSON.stringify(spanEpisodes)) globalContinuityIntegrityIssues.push(`连续性资产 ${track.assetId} 的 episodeCodes 与 spans 聚合不一致`);
    for (const span of track.spans) {
    if (seenContinuitySpanIds.has(span.id)) globalContinuityIntegrityIssues.push(`连续性时间段 ID 重复：${span.id}`);
    seenContinuitySpanIds.add(span.id);
    const unitSpans = spansByUnit.get(span.unitItemId) ?? [];
    unitSpans.push(span);
    spansByUnit.set(span.unitItemId, unitSpans);
    const unit = unitsByItemId.get(span.unitItemId);
    if (!unit) {
      globalContinuityIntegrityIssues.push(`时间段 ${span.id} 指向 manifest 不存在的单元 ${span.unitItemId}`);
      continue;
    }
    if (track.assetId !== span.assetId) addContinuityIssue(span.unitItemId, `时间段 ${span.id} 的 track/asset 身份不一致`);
    if (span.unitId !== unit.id
      || span.episode !== unit.episode
      || span.episodeNumber !== unit.episodeNumber
      || span.unitSequence !== unit.sequence) {
      addContinuityIssue(span.unitItemId, `时间段 ${span.id} 的集、单元或序号身份不一致`);
    }
    const indexes = [...new Set(span.scheduleRowIndexes)].sort((left, right) => left - right);
    const rows = indexes.map((index) => unit.schedule.find((row) => row.index === index));
    if (!indexes.length || indexes.length !== span.scheduleRowIndexes.length || rows.some((row) => !row)) {
      addContinuityIssue(span.unitItemId, `时间段 ${span.id} 的 scheduleRowIndexes 非法或重复`);
      continue;
    }
    const expectedShots = rows
      .map((row) => row?.sourceShotNumber)
      .filter((shot): shot is number => shot !== undefined)
      .sort((left, right) => left - right);
    const actualShots = [...new Set(span.sourceShots)].sort((left, right) => left - right);
    if (JSON.stringify(expectedShots) !== JSON.stringify(actualShots)) {
      addContinuityIssue(span.unitItemId, `时间段 ${span.id} 的 sourceShots 与排期行不一致`);
    }
    const expectedStart = rows[0]!.startSeconds;
    const lastRow = rows.at(-1)!;
    const lastSource = unit.schedule.filter((row) => row.kind === "source-shot").at(-1);
    const expectedEnd = lastRow.index === lastSource?.index && unit.schedule.at(-1)?.kind === "extension"
      ? unit.standardDurationSeconds
      : lastRow.endSeconds;
    if (Math.abs(span.startSeconds - expectedStart) > 1e-6 || Math.abs(span.endSeconds - expectedEnd) > 1e-6) {
      addContinuityIssue(span.unitItemId, `时间段 ${span.id} 的秒段与 scheduleRowIndexes 不一致`);
    }
    }
  }
  const expectedContinuityAssets = [...continuityDefinitions.keys()].sort();
  const actualContinuityAssets = [...seenContinuityTrackAssets].sort();
  if (JSON.stringify(expectedContinuityAssets) !== JSON.stringify(actualContinuityAssets)) {
    globalContinuityIntegrityIssues.push("连续性 track 资产集合与正式资产目录不精确一致");
  }
  if (globalContinuityIntegrityIssues.length) {
    throw new Error(`P2 连续性轨存在全局结构错误：${globalContinuityIntegrityIssues.slice(0, 20).join("；")}`);
  }
  const overrides = previous?.overrides ?? {};
  const derivedAssets: Record<string, DerivedPanelReferenceAsset> = {};
  const contractDigest = digest(contracts.map((contract) => [contract.unit.unitId, contract.contractId, contract.sourceFingerprint, contract.productionFingerprint]));
  const preliminaryInput: PanelReferenceResolutionInputSnapshot = {
    storyboardRevision: storyboardStore.revision,
    storyboardsSha256: fileDigests[0]!,
    continuitySha256: fileDigests[1]!,
    productionAssetsSha256: fileDigests[2]!,
    projectConfigSha256: projectConfigDigest,
    gridSelectionsSha256: fileDigests[3]!,
    gridContractsDigest: contractDigest,
    hardLockSnapshotsDigest: digest([...locks.values()].sort((a, b) => a.assetId.localeCompare(b.assetId, "en"))),
    unitMarkdownsDigest: correctedReferenceExpectations.aggregateDigest,
    overrideRevision: Math.max(0, ...Object.values(overrides).map((entry) => entry.revision)),
    derivedDefinitionsDigest: "pending",
  };
  const partial: Array<{ contract: FusionStoryboardGridContract; panel: FusionStoryboardGridPanel; data: Omit<PanelReferenceResolution, "resolutionId" | "resolutionFingerprint" | "inputSnapshot"> }> = [];
  for (const contract of contracts) {
    const unitSpans = spansByUnit.get(contract.unit.unitId) ?? [];
    const unitDefinition = manifest.units.find((unit) => `season-三-ep${String(unit.episodeNumber).padStart(2, "0")}-unit${String(unit.sequence).padStart(3, "0")}` === contract.unit.unitId);
    if (!unitDefinition) throw new Error(`P2 manifest 找不到当前合同单元：${contract.unit.unitId}`);
    for (const panel of contract.panels) {
      const rows = panel.storyboardRowIds.map((id) => rowsById.get(id)).filter((row): row is StoryboardRow => Boolean(row));
      const issues: string[] = [];
      const blockerCodes = new Set<PanelReferenceResolution["blockerCodes"][number]>();
      const continuityIntegrityIssues = continuityIntegrityByUnit.get(contract.unit.unitId) ?? [];
      if (continuityIntegrityIssues.length) {
        issues.push(...continuityIntegrityIssues);
        blockerCodes.add("timeline-conflict");
      }
      if (rows.length !== panel.storyboardRowIds.length) {
        issues.push("宫格引用的已确认分镜行缺失");
        blockerCodes.add("timeline-conflict");
      }
      const invalidSpans = unitSpans.filter((span) => !Number.isFinite(span.startSeconds) || !Number.isFinite(span.endSeconds)
        || span.startSeconds < 0 || span.endSeconds > 15 || span.endSeconds <= span.startSeconds);
      if (invalidSpans.length) {
        issues.push(`连续性时间段非法：${invalidSpans.map((span) => span.id).join("、")}`);
        blockerCodes.add("timeline-conflict");
      }
      const overlapping = unitSpans.filter((span) => overlaps(panel, span));
      const versionsByAsset = new Map<string, Set<string>>();
      for (const span of overlapping) {
        const versions = versionsByAsset.get(span.assetId) ?? new Set<string>();
        versions.add(span.referenceVersion);
        versionsByAsset.set(span.assetId, versions);
      }
      for (const [assetId, versions] of versionsByAsset) if (versions.size > 1) {
        issues.push(`${assetId} 在同一宫格出现冲突的连续性参考版本：${[...versions].join("、")}`);
        blockerCodes.add("timeline-conflict");
      }
      const rawRowIds = new Set(rows.flatMap((row) => row.referenceNames ?? []).map((id) => id.trim()).filter(Boolean));
      const continuityIds = new Set(overlapping.map((span) => span.assetId));
      const panelContinuityIds = new Set(panel.continuityReferenceAssetIds);
      const panelAssetIds = new Set(panel.assetIds);
      const detachedPanelContinuityIds = [...panelContinuityIds].filter((assetId) => !panelAssetIds.has(assetId));
      if (detachedPanelContinuityIds.length) {
        issues.push(`宫格显式连续性参考未进入完整语义资产集合：${detachedPanelContinuityIds.join("、")}`);
        blockerCodes.add("timeline-conflict");
      }
      const correctedByScheduleRow = correctedReferenceExpectations.byUnitItemId.get(contract.unit.unitId);
      if (!correctedByScheduleRow) throw new Error(`P2 缺少单元 Markdown 纠错证据：${contract.unit.unitId}`);
      const correctedRowIds = new Set(rows.flatMap((row) => correctedByScheduleRow.get(row.order - 1) ?? []));
      // 旧物化器的无边界正则与末镜块越界会把后续 EPxx/三级标题内容中的已知
      // 资产污染到 revision 1 分镜。只有“当前隔离 Markdown 用修复后的解析器明确
      // 不包含、且没有重叠连续性证据”的初始物化引用才被显式排除；人工修订行
      // 永不靠启发式删除，必须通过 override CAS 裁决。
      const parserArtifactIds = new Set([...rawRowIds].filter((assetId) => {
        const sourceRows = rows.filter((row) => row.referenceNames?.includes(assetId));
        return definitions.has(assetId)
          && sourceRows.length > 0
          && sourceRows.every((row) => row.revision === 1)
          && !correctedRowIds.has(assetId)
          && !continuityIds.has(assetId)
          && !panelContinuityIds.has(assetId);
      }));
      const rowIds = new Set([...rawRowIds].filter((assetId) => !parserArtifactIds.has(assetId)));
      const key = resolutionKey(contract.contractId, panel.id);
      const override = overrides[key];
      const includeIds = new Set(override?.includeAssetIds ?? []);
      const excludeIds = new Set(override?.excludeAssetIds ?? []);
      const baseIds = new Set([...rowIds, ...continuityIds, ...panelContinuityIds, ...includeIds]);
      const excludedAssets: PanelReferenceResolution["excludedAssets"] = [...parserArtifactIds].sort().map((assetId) => ({
        assetId,
        source: "parser-reconciliation" as const,
        reason: "旧无边界正则把 EPxx 文本误识别为 Pxx；该资产不在当前格对应的源分镜声明或重叠连续性证据中。",
      }));
      for (const assetId of excludeIds) {
        if (!baseIds.has(assetId)) {
          issues.push(`人工排除了当前格不存在的资产：${assetId}`);
          blockerCodes.add("unknown-asset");
          continue;
        }
        baseIds.delete(assetId);
        excludedAssets.push({ assetId, reason: override!.reason, source: "manual-override", overrideId: override!.id });
      }
      const unknown = [...baseIds].filter((assetId) => !definitions.has(assetId));
      if (unknown.length) {
        issues.push(`未知资产 ID：${unknown.join("、")}`);
        blockerCodes.add("unknown-asset");
      }
      const semanticAssets = [...baseIds].filter((assetId) => definitions.has(assetId)).sort().map((assetId): PanelReferenceSemanticAsset => {
        const definition = definitions.get(assetId)!;
        return {
          assetId,
          assetName: definition.name,
          category: definition.category,
          provenance: provenanceForAsset(assetId, rows, overlapping.filter((span) => span.assetId === assetId), panel, includeIds.has(assetId)),
          hardLock: locks.get(assetId),
          bindingId: `panel-binding-${digest({ contractId: contract.contractId, panelId: panel.id, assetId }).slice(0, 24)}`,
        };
      });
      const timelineReconciliations: PanelReferenceTimelineReconciliation[] = [
        ...[...parserArtifactIds].sort().map((assetId) => ({
          assetId,
          difference: "parser-artifact" as const,
          resolution: "exclude-undeclared-parser-artifact" as const,
          status: "resolved" as const,
          evidenceIds: rows.filter((row) => row.referenceNames?.includes(assetId)).map((row) => row.id),
          note: "资产未被当前格对应的源分镜声明且没有重叠连续性证据；按 P2 已知旧解析缺陷显式排除并保留裁决。",
        })),
        ...[...rowIds].filter((assetId) => !continuityIds.has(assetId) && definitions.has(assetId)).sort().map((assetId) => ({
          assetId,
          difference: "storyboard-only" as const,
          resolution: "include-storyboard-authority" as const,
          status: "resolved" as const,
          evidenceIds: rows.filter((row) => row.referenceNames?.includes(assetId)).map((row) => row.id),
          note: "已确认分镜行是当前画面显式出场权威；记录连续性轨缺口但不静默删图。",
        })),
        ...[...continuityIds].filter((assetId) => !rowIds.has(assetId) && definitions.has(assetId)).sort().map((assetId) => ({
          assetId,
          difference: "continuity-only" as const,
          resolution: "include-overlapping-continuity" as const,
          status: "resolved" as const,
          evidenceIds: overlapping.filter((span) => span.assetId === assetId).map((span) => span.id),
          note: "重叠连续性跨度是已知人物/场景/道具证据；显式补入，禁止退化为 text-only。",
        })),
        ...[...panelContinuityIds]
          .filter((assetId) => !rowIds.has(assetId) && !continuityIds.has(assetId) && definitions.has(assetId))
          .sort()
          .map((assetId) => ({
            assetId,
            difference: "panel-continuity-only" as const,
            resolution: "include-explicit-panel-continuity" as const,
            status: "resolved" as const,
            evidenceIds: [panel.id],
            note: "宫格合同显式补充该连续性参考；必须进入引用闭包，但未明确出镜时不得强行画入画面。",
          })),
      ];
      const detectedOverflow = semanticAssets.length > 6;
      let overflowHandledByDerivedAssetId: string | undefined;
      let referenceSlots: PanelReferenceSlot[];
      if (detectedOverflow) {
        const defined = derivedAssetFor(semanticAssets.map((asset) => asset.assetId), catalog, previous?.derivedAssets ?? {}, catalog.updatedAt);
        const derived = await validateDerivedVisualArtifact(projectRoot, defined, digestMemberHardLocks(semanticAssets));
        derivedAssets[derived.id] = derived;
        overflowHandledByDerivedAssetId = derived.id;
        const visual = derived.status === "visual-ready" ? derived.visualArtifact : undefined;
        referenceSlots = [{
          id: `panel-slot-${digest({ contractId: contract.contractId, panelId: panel.id, derivedAssetId: derived.id }).slice(0, 24)}`,
          kind: "derived-composite",
          coveredAssetIds: semanticAssets.map((asset) => asset.assetId),
          readiness: visual ? "ready" : derived.status === "stale" ? "stale" : "pending-derived-artifact",
          derivedAssetId: derived.id,
          artifactId: visual?.artifactId,
          path: visual?.path,
          sha256: visual?.sha256,
          reviewId: visual?.reviewId,
        }];
        if (!visual) blockerCodes.add(derived.status === "stale" ? "stale-derived-artifact" : "pending-derived-artifact");
      } else {
        referenceSlots = semanticAssets.map((asset): PanelReferenceSlot => ({
          id: `panel-slot-${asset.bindingId.slice("panel-binding-".length)}`,
          kind: "canonical-asset",
          coveredAssetIds: [asset.assetId],
          readiness: asset.hardLock ? "ready" : "pending-hard-lock",
          assetId: asset.assetId,
          artifactId: asset.hardLock?.artifactId,
          path: asset.hardLock?.path,
          sha256: asset.hardLock?.sha256,
          reviewId: asset.hardLock?.reviewId,
        }));
        if (referenceSlots.some((slot) => slot.readiness === "pending-hard-lock")) blockerCodes.add("pending-hard-lock");
      }
      const closureStatus: PanelReferenceResolution["closureStatus"] = blockerCodes.has("unknown-asset") || blockerCodes.has("timeline-conflict")
        ? "unresolved"
        : semanticAssets.length ? "resolved" : "confirmed-empty";
      const generationReady = closureStatus !== "unresolved" && referenceSlots.every((slot) => slot.readiness === "ready");
      partial.push({ contract, panel, data: {
        schemaVersion: 1,
        resolverVersion: FUSION_PANEL_REFERENCE_RESOLVER_VERSION,
        projectId: manifest.projectId,
        sourceContentAddress: manifest.contentAddress,
        unitItemId: contract.unit.unitId,
        gridContractId: contract.contractId,
        gridSourceFingerprint: contract.sourceFingerprint,
        panelId: panel.id,
        panelIndex: panel.index,
        panelCount: contract.selection.panelCount,
        startSeconds: panel.startSeconds,
        endSeconds: panel.endSeconds,
        storyboardRowIds: [...panel.storyboardRowIds],
        sourceShotNumbers: [...panel.sourceShotNumbers],
        scheduleRowIndexes: [...panel.scheduleRowIndexes],
        semanticAssets,
        excludedAssets,
        referenceSlots,
        timelineReconciliations,
        detectedOverflow,
        overflowHandledByDerivedAssetId,
        closureStatus,
        generationReady,
        blockerCodes: [...blockerCodes].sort() as PanelReferenceResolution["blockerCodes"],
        issues,
      } });
    }
  }
  const derivedDefinitionsDigest = digest(Object.values(derivedAssets).map((asset) => ({
    id: asset.id,
    definitionFingerprint: asset.definitionFingerprint,
    visualArtifact: asset.visualArtifact,
    status: asset.status,
  })).sort((left, right) => left.id.localeCompare(right.id, "en")));
  const inputSnapshot: PanelReferenceResolutionInputSnapshot = { ...preliminaryInput, derivedDefinitionsDigest };
  const resolutions: Record<string, PanelReferenceResolution> = {};
  for (const { data } of partial) {
    // Resolution 身份只绑定当前宫格的可观察输入与裁决；全仓 inputSnapshot 仍随记录
    // 保存并用于审计 currentness，但不能让无关集的修订使 4330 格任务集体失效。
    const resolutionFingerprint = digest(data);
    const resolutionId = `panel-reference-${resolutionFingerprint.slice(0, 28)}`;
    resolutions[resolutionKey(data.gridContractId, data.panelId)] = { ...data, inputSnapshot, resolutionFingerprint, resolutionId };
  }
  const audit = auditFor(contracts, resolutions, derivedAssets);
  const jobsById = new Map(generationJobs.map((job) => [job.id, job]));
  let legacyGenerationJobIds: string[];
  let legacyGenerationJobEvidence: Record<string, LegacyGenerationJobEvidence>;
  if (previous) {
    legacyGenerationJobIds = [...previous.legacyGenerationJobIds];
    const previousEvidence = previous.legacyGenerationJobEvidence;
    const evidenceIds = Object.keys(previousEvidence).sort((left, right) => left.localeCompare(right, "en"));
    const frozenIds = [...legacyGenerationJobIds].sort((left, right) => left.localeCompare(right, "en"));
    if (new Set(frozenIds).size !== frozenIds.length || JSON.stringify(evidenceIds) !== JSON.stringify(frozenIds)) {
      throw new Error("P2 历史逐格任务白名单与旁路证据集合不精确一致。");
    }
    legacyGenerationJobEvidence = {};
    for (const jobId of frozenIds) {
      const job = jobsById.get(jobId);
      const frozen = previousEvidence[jobId]!;
      if (!legacyEvidenceLedgerCurrent(frozen, job, publications)) {
        throw new Error(`P2 历史逐格任务账本已漂移：${jobId}`);
      }
      if (!job?.fusionStoryboardPanel || !await legacyJobMatchesStoredContract(projectRoot, job)) {
        throw new Error(`P2 历史逐格任务的内容寻址合同已漂移：${jobId}`);
      }
      if (frozen.kind === "obsolete-terminal") {
        const refreshed = obsoleteTerminalEvidence(job, publications);
        if (JSON.stringify(refreshed) !== JSON.stringify(frozen)) {
          throw new Error(`P2 已冻结 obsolete-terminal 任务证据不再精确一致：${jobId}`);
        }
        legacyGenerationJobEvidence[jobId] = refreshed;
        continue;
      }
      const resolution = resolutions[resolutionKey(job.fusionStoryboardPanel.contractId, job.fusionStoryboardPanel.panelId)];
      if (!resolution) throw new Error(`P2 历史 current-resolution 任务不再属于当前合同：${jobId}`);
      legacyGenerationJobEvidence[jobId] = {
        kind: "current-resolution",
        contractId: job.fusionStoryboardPanel.contractId,
        panelId: job.fusionStoryboardPanel.panelId,
        resolutionId: resolution.resolutionId,
        resolutionFingerprint: resolution.resolutionFingerprint,
        jobLedgerFingerprint: legacyJobLedgerFingerprint(job),
      };
    }
  } else {
    const legacyJobs = generationJobs
      .filter((job) => job.purpose === "fusion_storyboard_panel" && job.panelReferenceEvidenceVersion !== 1)
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
    legacyGenerationJobIds = legacyJobs.map((job) => job.id);
    legacyGenerationJobEvidence = {};
    for (const job of legacyJobs) {
      const panel = job.fusionStoryboardPanel;
      if (!panel) throw new Error(`历史逐格任务 ${job.id} 缺少宫格身份，拒绝建立 P2 白名单。`);
      if (!await legacyJobMatchesStoredContract(projectRoot, job)) {
        throw new Error(`历史逐格任务 ${job.id} 的宫格身份与其内容寻址合同不精确一致，拒绝建立 P2 白名单。`);
      }
      const resolution = resolutions[resolutionKey(panel.contractId, panel.panelId)];
      legacyGenerationJobEvidence[job.id] = resolution ? {
        kind: "current-resolution",
        contractId: panel.contractId,
        panelId: panel.panelId,
        resolutionId: resolution.resolutionId,
        resolutionFingerprint: resolution.resolutionFingerprint,
        jobLedgerFingerprint: legacyJobLedgerFingerprint(job),
      } : obsoleteTerminalEvidence(job, publications);
    }
  }
  const [endingDirectDigests, endingContracts, endingCorrectedReferences, endingIndex, endingReviews, endingOverrides] = await Promise.all([
    Promise.all([
      digestFile(paths.fusionProjectManifest),
      digestFile(paths.productionAssets),
      digestFile(paths.continuityTracks),
      digestFile(paths.storyboards),
      digestFile(paths.index),
      digestFileOrAbsent(paths.reviews),
      digestFileOrAbsent(paths.overrides),
      digestFile(paths.storyboardGridSelections),
      digestFile(paths.config),
      digestFileOrAbsent(paths.generationJobs),
      digestFileOrAbsent(paths.publications),
    ]),
    loadContracts(projectRoot, selectionsSnapshot.value),
    loadCorrectedUnitReferenceExpectations(projectRoot, manifest),
    readJsonSnapshot<ProjectIndex>(paths.index),
    readJsonSnapshotOrDefault<ReviewStore>(paths.reviews, { schemaVersion: 1, records: [] }),
    readJsonSnapshotOrDefault<ProjectOverrides>(paths.overrides, { schemaVersion: 1, items: {} }),
  ]);
  const startingDirectDigests = [
    manifestSnapshot.sha256,
    catalogSnapshot.sha256,
    continuitySnapshot.sha256,
    storyboardSnapshot.sha256,
    indexSnapshot.sha256,
    reviewsSnapshot.sha256,
    overridesSnapshot.sha256,
    selectionsSnapshot.sha256,
    configSnapshot.sha256,
    generationJobsSnapshot.sha256,
    publicationsSnapshot.sha256,
  ];
  if (endingDirectDigests.some((value, position) => value !== startingDirectDigests[position])) {
    throw new Error("P2 引用闭包物化期间输入 sidecar 发生并发变化，拒绝写入混合快照。");
  }
  const endingContractDigest = digest(endingContracts.map((contract) => [contract.unit.unitId, contract.contractId, contract.sourceFingerprint, contract.productionFingerprint]));
  if (endingContractDigest !== contractDigest || endingCorrectedReferences.aggregateDigest !== correctedReferenceExpectations.aggregateDigest) {
    throw new Error("P2 引用闭包物化期间宫格合同或单元 Markdown 发生并发变化，拒绝写入混合快照。");
  }
  const endingLocks = await resolvePanelHardLockSnapshots(projectRoot, endingIndex.value, catalog, endingReviews.value, endingOverrides.value);
  if (digest([...endingLocks.values()].sort((a, b) => a.assetId.localeCompare(b.assetId, "en"))) !== preliminaryInput.hardLockSnapshotsDigest) {
    throw new Error("P2 引用闭包物化期间硬锁或视觉审核证据发生并发变化，拒绝写入混合快照。");
  }
  return {
    schemaVersion: 1,
    kind: "fusion-panel-reference-resolutions",
    resolverVersion: FUSION_PANEL_REFERENCE_RESOLVER_VERSION,
    projectId: manifest.projectId,
    sourceContentAddress: manifest.contentAddress,
    inputSnapshot,
    resolutions,
    derivedAssets,
    overrides,
    legacyGenerationJobIds,
    legacyGenerationJobEvidence,
    audit,
  };
}

export async function loadFusionPanelReferenceStore(projectRoot: string): Promise<FusionPanelReferenceResolutionStore | null> {
  const store = await readJson<FusionPanelReferenceResolutionStore | null>(getSidecarPaths(projectRoot).panelReferenceResolutions, null);
  if (!store) return null;
  if (store.schemaVersion !== 1 || store.kind !== "fusion-panel-reference-resolutions" || store.resolverVersion !== FUSION_PANEL_REFERENCE_RESOLVER_VERSION) {
    throw new Error("P2 逐格引用解析仓 schema 不受支持，已失败关闭。");
  }
  if (!Array.isArray(store.legacyGenerationJobIds) || store.legacyGenerationJobIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error("P2 逐格引用解析仓缺少有效的历史任务白名单，已失败关闭。");
  }
  const frozenIds = [...store.legacyGenerationJobIds].sort((left, right) => left.localeCompare(right, "en"));
  const evidenceIds = Object.keys(store.legacyGenerationJobEvidence ?? {}).sort((left, right) => left.localeCompare(right, "en"));
  if (!store.legacyGenerationJobEvidence || typeof store.legacyGenerationJobEvidence !== "object"
    || new Set(frozenIds).size !== frozenIds.length
    || JSON.stringify(frozenIds) !== JSON.stringify(evidenceIds)
    || evidenceIds.some((id) => {
      const evidence = store.legacyGenerationJobEvidence[id];
      return !evidence
        || (evidence.kind !== "current-resolution" && evidence.kind !== "obsolete-terminal")
        || typeof evidence.jobLedgerFingerprint !== "string"
        || !evidence.jobLedgerFingerprint;
    })) {
    throw new Error("P2 逐格引用解析仓缺少有效的历史任务解析证据，已失败关闭。");
  }
  const expected = storeFingerprintFor(store);
  if (expected !== store.storeFingerprint) throw new Error("P2 逐格引用解析仓内容摘要不匹配，禁止使用损坏数据。");
  return store;
}

export async function inspectFusionPanelReferenceCurrentness(
  projectRoot: string,
  options: { verifyAllContractFiles?: boolean; verifyAllUnitMarkdowns?: boolean } = {},
): Promise<FusionPanelReferenceCurrentness> {
  const store = await loadFusionPanelReferenceStore(projectRoot);
  if (!store) throw new Error("P2 逐格引用解析尚未物化；先执行 materialize_fusion_panel_references。");
  const paths = getSidecarPaths(projectRoot);
  const [configSnapshot, storyboardSnapshot, continuitySnapshot, catalogSnapshot, selectionsSnapshot, indexSnapshot, reviewsSnapshot, overridesSnapshot, manifestSnapshot, generationJobsSnapshot, publicationsSnapshot] = await Promise.all([
    readJsonSnapshot<{ hardLocks?: Array<{ id: string; name: string; path: string; note: string }> }>(paths.config),
    readJsonSnapshot<StoryboardStore>(paths.storyboards),
    readJsonSnapshot<FusionContinuityStore>(paths.continuityTracks),
    readJsonSnapshot<FusionProductionAssetCatalog>(paths.productionAssets),
    readJsonSnapshot<FusionStoryboardGridSelectionStore>(paths.storyboardGridSelections),
    readJsonSnapshot<ProjectIndex>(paths.index),
    readJsonSnapshotOrDefault<ReviewStore>(paths.reviews, { schemaVersion: 1, records: [] }),
    readJsonSnapshotOrDefault<ProjectOverrides>(paths.overrides, { schemaVersion: 1, items: {} }),
    readJsonSnapshot<FusionProjectManifest>(paths.fusionProjectManifest),
    readJsonSnapshotOrDefault<GenerationJob[]>(paths.generationJobs, []),
    readJsonSnapshotOrDefault<PublicationStore>(paths.publications, { schemaVersion: 1, revision: 0, intents: [], receipts: [], updatedAt: new Date(0).toISOString() }),
  ]);
  const currentConfig = configSnapshot.value;
  const catalog = catalogSnapshot.value;
  const index = indexSnapshot.value;
  const reviews = reviewsSnapshot.value;
  const projectOverrides = overridesSnapshot.value;
  const manifest = manifestSnapshot.value;
  const generationJobsById = new Map(generationJobsSnapshot.value.map((job) => [job.id, job]));
  const currentDigests = [
    storyboardSnapshot.sha256,
    continuitySnapshot.sha256,
    catalogSnapshot.sha256,
    gridSelectionSemanticDigest(selectionsSnapshot.value),
  ];
  const contractsResult = options.verifyAllContractFiles !== false
    ? await loadContracts(projectRoot, selectionsSnapshot.value).then((contracts) => ({ contracts }), (error: unknown) => ({ error }))
    : undefined;
  const drifted = new Set<string>();
  if (store.audit.contractCoverageVersion !== FUSION_PANEL_REFERENCE_CONTRACT_COVERAGE_VERSION
    || !Number.isInteger(store.audit.contractAssetMissingBindings)
    || !Number.isInteger(store.audit.explicitContinuityMissingBindings)
    || !Number.isInteger(store.audit.semanticAssetMissingSlots)) {
    drifted.add("resolver-contract-coverage");
  }
  for (const jobId of store.legacyGenerationJobIds) {
    if (!legacyEvidenceLedgerCurrent(store.legacyGenerationJobEvidence[jobId]!, generationJobsById.get(jobId), publicationsSnapshot.value)) {
      drifted.add("legacy-generation-jobs");
      break;
    }
  }
  if (!manifest || manifest.projectId !== store.projectId || manifest.contentAddress !== store.sourceContentAddress) drifted.add("fusion-manifest");
  if (continuitySnapshot.value.sourceContentAddress !== store.sourceContentAddress
    || catalog.sourceContentAddress !== store.sourceContentAddress
    || catalog.projectId !== store.projectId
    || index.project.id !== store.projectId) drifted.add("project-identity");
  const currentConfigDigest = digest([...(currentConfig.hardLocks ?? [])].sort((left, right) => left.id.localeCompare(right.id, "en")));
  const expected = store.inputSnapshot;
  const directInputs: Array<[string, string, string]> = [
    ["storyboards", currentDigests[0]!, expected.storyboardsSha256],
    ["continuity", currentDigests[1]!, expected.continuitySha256],
    ["production-assets", currentDigests[2]!, expected.productionAssetsSha256],
    ["project-config", currentConfigDigest, expected.projectConfigSha256],
    ["grid-selections", currentDigests[3]!, expected.gridSelectionsSha256],
  ];
  for (const [name, actual, frozen] of directInputs) if (actual !== frozen) drifted.add(name);
  if (contractsResult) {
    if ("error" in contractsResult) {
      drifted.add("grid-contracts");
    } else {
      const expectedUnits = manifest?.units.map((unit) => `season-三-ep${String(unit.episodeNumber).padStart(2, "0")}-unit${String(unit.sequence).padStart(3, "0")}`).sort() ?? [];
      const actualUnits = contractsResult.contracts.map((contract) => contract.unit.unitId).sort();
      const contractDigest = digest(contractsResult.contracts.map((contract) => [contract.unit.unitId, contract.contractId, contract.sourceFingerprint, contract.productionFingerprint]));
      if (new Set(actualUnits).size !== actualUnits.length
        || JSON.stringify(actualUnits) !== JSON.stringify(expectedUnits)
        || contractDigest !== expected.gridContractsDigest) drifted.add("grid-contracts");
    }
  }
  if (!catalog || !index) {
    drifted.add("hard-locks");
  } else {
    const locks = await resolvePanelHardLockSnapshots(projectRoot, index, catalog, reviews, projectOverrides);
    const currentLocksDigest = digest([...locks.values()].sort((left, right) => left.assetId.localeCompare(right.assetId, "en")));
    if (currentLocksDigest !== expected.hardLockSnapshotsDigest) drifted.add("hard-locks");
  }
  let checkedMarkdownDigest: string | undefined;
  if (!manifest) {
    drifted.add("unit-markdowns");
  } else if (options.verifyAllUnitMarkdowns !== false) {
    const currentMarkdowns = await loadCorrectedUnitReferenceExpectations(projectRoot, manifest).catch(() => undefined);
    checkedMarkdownDigest = currentMarkdowns?.aggregateDigest;
    if (!currentMarkdowns || currentMarkdowns.aggregateDigest !== expected.unitMarkdownsDigest) drifted.add("unit-markdowns");
  } else {
    const manifestUnitMarkdownsDigest = digest(manifest.units.map((unit) => [
      `season-三-ep${String(unit.episodeNumber).padStart(2, "0")}-unit${String(unit.sequence).padStart(3, "0")}`,
      unit.markdownSha256,
    ]).sort(([left], [right]) => String(left).localeCompare(String(right), "en")));
    if (manifestUnitMarkdownsDigest !== expected.unitMarkdownsDigest) drifted.add("unit-markdowns");
  }
  const currentOverrideRevision = Math.max(0, ...Object.values(store.overrides).map((entry) => entry.revision));
  if (currentOverrideRevision !== expected.overrideRevision) drifted.add("overrides");
  const currentDerivedDefinitionsDigest = digest(Object.values(store.derivedAssets).map((asset) => ({
    id: asset.id,
    definitionFingerprint: asset.definitionFingerprint,
    visualArtifact: asset.visualArtifact,
    status: asset.status,
  })).sort((left, right) => left.id.localeCompare(right.id, "en")));
  if (currentDerivedDefinitionsDigest !== expected.derivedDefinitionsDigest) drifted.add("derived-assets");
  const checkedFiles = new Map<string, string>();
  for (const resolution of Object.values(store.resolutions)) {
    for (const asset of resolution.semanticAssets) if (asset.hardLock) checkedFiles.set(asset.hardLock.path, asset.hardLock.sha256);
    for (const slot of resolution.referenceSlots) if (slot.path && slot.sha256) checkedFiles.set(slot.path, slot.sha256);
  }
  for (const [filePath, frozenSha] of checkedFiles) {
    const actualSha = await digestFile(filePath).catch(() => undefined);
    if (actualSha !== frozenSha) drifted.add("reference-files");
  }
  const endingDirectDigests = await Promise.all([
    digestFile(paths.config),
    digestFile(paths.storyboards),
    digestFile(paths.continuityTracks),
    digestFile(paths.productionAssets),
    digestFile(paths.storyboardGridSelections),
    digestFile(paths.index),
    digestFileOrAbsent(paths.reviews),
    digestFileOrAbsent(paths.overrides),
    digestFile(paths.fusionProjectManifest),
    digestFileOrAbsent(paths.generationJobs),
    digestFileOrAbsent(paths.publications),
  ]);
  const startingDirectDigests = [
    configSnapshot.sha256,
    storyboardSnapshot.sha256,
    continuitySnapshot.sha256,
    catalogSnapshot.sha256,
    selectionsSnapshot.sha256,
    indexSnapshot.sha256,
    reviewsSnapshot.sha256,
    overridesSnapshot.sha256,
    manifestSnapshot.sha256,
    generationJobsSnapshot.sha256,
    publicationsSnapshot.sha256,
  ];
  if (endingDirectDigests.some((value, index) => value !== startingDirectDigests[index])) drifted.add("concurrent-inputs");
  if (options.verifyAllContractFiles !== false && contractsResult && "contracts" in contractsResult) {
    const firstDigest = digest(contractsResult.contracts.map((contract) => [contract.unit.unitId, contract.contractId, contract.sourceFingerprint, contract.productionFingerprint]));
    const endingContracts = await loadContracts(projectRoot, selectionsSnapshot.value).catch(() => undefined);
    const endingDigest = endingContracts ? digest(endingContracts.map((contract) => [contract.unit.unitId, contract.contractId, contract.sourceFingerprint, contract.productionFingerprint])) : undefined;
    if (!endingDigest || endingDigest !== firstDigest) drifted.add("concurrent-contracts");
  }
  if (options.verifyAllUnitMarkdowns !== false && checkedMarkdownDigest) {
    const endingMarkdowns = await loadCorrectedUnitReferenceExpectations(projectRoot, manifest).catch(() => undefined);
    if (!endingMarkdowns || endingMarkdowns.aggregateDigest !== checkedMarkdownDigest) drifted.add("concurrent-unit-markdowns");
  }
  return {
    current: drifted.size === 0,
    checkedAt: new Date().toISOString(),
    storeRevision: store.revision,
    storeFingerprint: store.storeFingerprint,
    driftedInputs: [...drifted].sort(),
  };
}

async function assertReadStoreIdentity(
  projectRoot: string,
  store: FusionPanelReferenceResolutionStore,
  currentness: FusionPanelReferenceCurrentness,
  operation: string,
): Promise<void> {
  if (currentness.storeRevision !== store.revision || currentness.storeFingerprint !== store.storeFingerprint) {
    throw new Error(`${operation} 期间逐格引用仓发生并发修订，拒绝返回旧快照。`);
  }
  const latest = await loadFusionPanelReferenceStore(projectRoot);
  if (!latest || latest.revision !== store.revision || latest.storeFingerprint !== store.storeFingerprint) {
    throw new Error(`${operation} 完成前逐格引用仓再次变化，拒绝返回旧快照。`);
  }
}

export async function inspectFusionPanelReferenceAudit(projectRoot: string): Promise<{
  audit: FusionPanelReferenceAudit;
  currentness: FusionPanelReferenceCurrentness;
  storeRevision: number;
  storeFingerprint: string;
}> {
  const store = await loadFusionPanelReferenceStore(projectRoot);
  if (!store) throw new Error("P2 逐格引用解析尚未物化；先执行 materialize_fusion_panel_references。");
  const currentness = await inspectFusionPanelReferenceCurrentness(projectRoot);
  await assertReadStoreIdentity(projectRoot, store, currentness, "逐格引用审计");
  return { audit: store.audit, currentness, storeRevision: store.revision, storeFingerprint: store.storeFingerprint };
}

export async function loadFusionPanelReferenceStoreSnapshot(projectRoot: string): Promise<{
  store: FusionPanelReferenceResolutionStore;
  currentness: FusionPanelReferenceCurrentness;
} | null> {
  const store = await loadFusionPanelReferenceStore(projectRoot);
  if (!store) return null;
  const currentness = await inspectFusionPanelReferenceCurrentness(projectRoot).catch((): FusionPanelReferenceCurrentness => ({
    current: false,
    checkedAt: new Date().toISOString(),
    storeRevision: store.revision,
    storeFingerprint: store.storeFingerprint,
    driftedInputs: ["currentness-check-failed"],
  }));
  await assertReadStoreIdentity(projectRoot, store, currentness, "逐格引用证据快照");
  return { store, currentness };
}

export async function materializeFusionPanelReferenceResolutions(projectRoot: string): Promise<FusionPanelReferenceResolutionStore> {
  return withProjectLock(projectRoot, "generation", () => withProjectLock(projectRoot, "panel-reference-resolutions", async () => {
    await materializeAllFusionStoryboardGrids(projectRoot, { persist: true });
    const previous = await loadFusionPanelReferenceStore(projectRoot);
    const computed = await computeStore(projectRoot, previous);
    const storeFingerprint = storeFingerprintFor(computed);
    if (previous?.storeFingerprint === storeFingerprint) return previous;
    const next: FusionPanelReferenceResolutionStore = {
      ...computed,
      revision: (previous?.revision ?? 0) + 1,
      storeFingerprint,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(getSidecarPaths(projectRoot).panelReferenceResolutions, next);
    return next;
  }));
}

export async function auditFusionPanelReferences(projectRoot: string): Promise<FusionPanelReferenceAudit> {
  // 审计是取证入口：即使输入已漂移，也要允许 MCP 把冻结计数与
  // currentness=false 一起返回；分页、单格读取和生图门禁仍严格拒绝陈旧仓。
  return (await inspectFusionPanelReferenceAudit(projectRoot)).audit;
}

export async function listFusionPanelReferenceResolutions(
  projectRoot: string,
  query: PanelReferenceResolutionQuery = {},
): Promise<PanelReferenceResolutionPage> {
  const store = await loadFusionPanelReferenceStore(projectRoot);
  if (!store) throw new Error("P2 逐格引用解析尚未物化。");
  const currentness = await inspectFusionPanelReferenceCurrentness(projectRoot);
  await assertReadStoreIdentity(projectRoot, store, currentness, "逐格引用分页");
  if (!currentness.current) throw new Error(`P2 逐格引用解析输入已漂移（${currentness.driftedInputs.join("、")}），拒绝返回陈旧分页。`);
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 50)));
  const items = Object.values(store.resolutions)
    .filter((item) => query.episode === undefined || episodeFromUnit(item.unitItemId) === query.episode)
    .filter((item) => !query.unitItemId || item.unitItemId === query.unitItemId)
    .filter((item) => !query.closureStatus || item.closureStatus === query.closureStatus)
    .filter((item) => query.generationReady === undefined || item.generationReady === query.generationReady)
    .filter((item) => !query.overflowOnly || item.detectedOverflow)
    .sort((left, right) => left.unitItemId.localeCompare(right.unitItemId, "en") || left.panelIndex - right.panelIndex);
  return { total: items.length, offset, limit, items: items.slice(offset, offset + limit), audit: store.audit, storeRevision: store.revision, storeFingerprint: store.storeFingerprint };
}

export async function getFusionPanelReferenceResolution(
  projectRoot: string,
  contractId: string,
  panelId: string,
): Promise<PanelReferenceResolution> {
  const store = await loadFusionPanelReferenceStore(projectRoot);
  if (store) {
    const currentness = await inspectFusionPanelReferenceCurrentness(projectRoot);
    await assertReadStoreIdentity(projectRoot, store, currentness, "逐格引用详情读取");
    if (!currentness.current) throw new Error(`P2 逐格引用解析输入已漂移（${currentness.driftedInputs.join("、")}），拒绝返回陈旧解析。`);
  }
  const resolution = store?.resolutions[resolutionKey(contractId, panelId)];
  if (!resolution) throw new Error(`找不到当前宫格引用解析：${contractId}/${panelId}`);
  return resolution;
}

export async function listDerivedPanelReferenceAssets(
  projectRoot: string,
  query: { offset?: number; limit?: number } = {},
): Promise<{ total: number; offset: number; limit: number; items: DerivedPanelReferenceAsset[]; storeRevision: number }> {
  const store = await loadFusionPanelReferenceStore(projectRoot);
  if (!store) throw new Error("P2 逐格引用解析尚未物化。");
  const currentness = await inspectFusionPanelReferenceCurrentness(projectRoot);
  await assertReadStoreIdentity(projectRoot, store, currentness, "派生引用分页");
  if (!currentness.current) throw new Error(`P2 逐格引用解析输入已漂移（${currentness.driftedInputs.join("、")}），拒绝返回陈旧派生资产。`);
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 50)));
  const items = Object.values(store.derivedAssets).sort((left, right) => left.id.localeCompare(right.id, "en"));
  return { total: items.length, offset, limit, items: items.slice(offset, offset + limit), storeRevision: store.revision };
}

export async function upsertPanelReferenceOverride(projectRoot: string, input: {
  contractId: string;
  panelId: string;
  expectedResolutionId: string;
  expectedStoreRevision: number;
  includeAssetIds?: string[];
  excludeAssetIds?: string[];
  reason: string;
}): Promise<FusionPanelReferenceResolutionStore> {
  const reason = input.reason.trim();
  if (!reason) throw new Error("逐格引用人工覆盖必须记录原因。");
  const includeAssetIds = [...new Set(input.includeAssetIds ?? [])].sort();
  const excludeAssetIds = [...new Set(input.excludeAssetIds ?? [])].sort();
  if (includeAssetIds.some((assetId) => excludeAssetIds.includes(assetId))) throw new Error("同一资产不能同时补入和排除。");
  await withProjectLock(projectRoot, "generation", () => withProjectLock(projectRoot, "panel-reference-resolutions", async () => {
    const store = await loadFusionPanelReferenceStore(projectRoot);
    if (!store) throw new Error("逐格引用覆盖要求先物化 P2 解析仓。");
    if (store.revision !== input.expectedStoreRevision) throw new Error(`逐格引用仓修订冲突（期望 r${input.expectedStoreRevision}，实际 r${store.revision}）。`);
    const key = resolutionKey(input.contractId, input.panelId);
    const current = store.resolutions[key];
    if (!current || current.resolutionId !== input.expectedResolutionId) throw new Error("逐格引用覆盖绑定的 resolution 已变化，拒绝写入旧结论。");
    const catalog = await loadFusionProductionAssets(projectRoot);
    const known = new Set(catalog?.assets.map((entry) => entry.definition.id) ?? []);
    const unknown = [...includeAssetIds, ...excludeAssetIds].filter((assetId) => !known.has(assetId));
    if (unknown.length) throw new Error(`逐格引用覆盖包含未知资产：${[...new Set(unknown)].join("、")}`);
    const previous = store.overrides[key];
    const override: PanelReferenceManualOverride = {
      id: previous?.id ?? `panel-reference-override-${digest({ key }).slice(0, 24)}`,
      revision: (previous?.revision ?? 0) + 1,
      contractId: input.contractId,
      panelId: input.panelId,
      expectedResolutionId: input.expectedResolutionId,
      includeAssetIds,
      excludeAssetIds,
      reason,
      updatedAt: new Date().toISOString(),
    };
    const pending = structuredClone(store);
    pending.overrides[key] = override;
    pending.revision += 1;
    pending.updatedAt = new Date().toISOString();
    pending.resolutions[key] = { ...current, closureStatus: "unresolved", generationReady: false, issues: [...current.issues, "人工覆盖已写入，等待重新物化引用解析"], blockerCodes: [...new Set([...current.blockerCodes, "timeline-conflict"])] as PanelReferenceResolution["blockerCodes"] };
    pending.audit = { ...pending.audit, closurePassed: false, unresolvedPanels: pending.audit.unresolvedPanels + (current.closureStatus === "unresolved" ? 0 : 1) };
    pending.audit.auditFingerprint = digest({ ...pending.audit, auditFingerprint: undefined });
    pending.storeFingerprint = storeFingerprintFor(pending);
    await writeJsonAtomic(getSidecarPaths(projectRoot).panelReferenceResolutions, pending);
  }));
  return materializeFusionPanelReferenceResolutions(projectRoot);
}

export async function registerDerivedPanelReferenceArtifact(projectRoot: string, input: {
  derivedAssetId: string;
  expectedStoreRevision: number;
  expectedVersion: number;
  filePath: string;
  expectedSha256?: string;
  reviewer: "user" | "codex";
  reviewNote: string;
}): Promise<FusionPanelReferenceResolutionStore> {
  const reviewer = input.reviewer;
  const reviewNote = input.reviewNote.trim();
  if (!reviewNote) throw new Error("组合派生参考图必须记录人工视觉审核说明。");
  await withProjectLock(projectRoot, "generation", () => withProjectLock(projectRoot, "panel-reference-resolutions", async () => {
    const store = await loadFusionPanelReferenceStore(projectRoot);
    if (!store) throw new Error("组合派生参考图登记要求先物化 P2 解析仓。");
    if (store.revision !== input.expectedStoreRevision) {
      throw new Error(`逐格引用仓修订冲突（期望 r${input.expectedStoreRevision}，实际 r${store.revision}）。`);
    }
    const current = store.derivedAssets[input.derivedAssetId];
    if (!current) throw new Error(`找不到组合派生资产：${input.derivedAssetId}`);
    if (current.version !== input.expectedVersion) {
      throw new Error(`组合派生资产版本冲突（期望 v${input.expectedVersion}，实际 v${current.version}）。`);
    }
    const relevant = Object.values(store.resolutions)
      .filter((resolution) => resolution.overflowHandledByDerivedAssetId === current.id);
    if (!relevant.length) throw new Error("组合派生资产没有当前宫格使用者，拒绝登记孤立文件。");
    const memberDigests = new Set(relevant.map((resolution) => digestMemberHardLocks(resolution.semanticAssets)));
    if (memberDigests.has(undefined) || memberDigests.size !== 1) {
      throw new Error("组合派生资产的全部成员必须先具有一致的当前硬锁，才能进行视觉审核登记。");
    }
    const memberHardLockDigest = [...memberDigests][0]!;
    const [canonicalRoot, canonicalFile] = await Promise.all([
      realpath(projectRoot),
      realpath(path.resolve(input.filePath)).catch(() => { throw new Error(`组合派生参考图不存在：${input.filePath}`); }),
    ]);
    if (!isInsideProject(canonicalRoot, canonicalFile)) throw new Error("组合派生参考图必须位于当前隔离工程内，禁止登记外部或只读源文件。");
    const [file, metadata, sha256] = await Promise.all([
      stat(canonicalFile),
      sharp(canonicalFile, { failOn: "error" }).metadata().catch(() => { throw new Error("组合派生参考图无法解码。"); }),
      digestFile(canonicalFile),
    ]);
    if (!file.isFile() || !metadata.width || !metadata.height || metadata.width < 256 || metadata.height < 256 || file.size < 1_024) {
      throw new Error("组合派生参考图尺寸或体积不足，拒绝登记疑似占位图。");
    }
    if (input.expectedSha256 && input.expectedSha256 !== sha256) throw new Error("组合派生参考图 SHA 与预期不一致。");
    const reviewedAt = new Date().toISOString();
    const visualFingerprint = digest({
      derivedAssetId: current.id,
      definitionFingerprint: current.definitionFingerprint,
      sha256,
      memberHardLockDigest,
      reviewer,
      reviewNote,
    });
    const pending = structuredClone(store);
    pending.derivedAssets[current.id] = {
      ...current,
      version: current.version + 1,
      status: "visual-ready",
      visualArtifact: {
        artifactId: `derived-reference-artifact-${visualFingerprint.slice(0, 24)}`,
        path: canonicalFile,
        sha256,
        reviewId: `derived-reference-visual-review-${visualFingerprint.slice(0, 24)}`,
        memberHardLockDigest,
        reviewer,
        reviewedAt,
        reviewNote,
        review: {
          schemaVersion: 1,
          reviewType: "derived-panel-reference-image",
          decision: "pass",
          reviewer,
          reviewedAt,
          note: reviewNote,
          artifactSha256: sha256,
          definitionFingerprint: current.definitionFingerprint,
          memberHardLockDigest,
        },
        width: metadata.width,
        height: metadata.height,
        fileSize: file.size,
      },
    };
    pending.revision += 1;
    pending.updatedAt = reviewedAt;
    pending.audit = { ...pending.audit, closurePassed: false };
    pending.audit.auditFingerprint = digest({ ...pending.audit, auditFingerprint: undefined });
    pending.storeFingerprint = storeFingerprintFor(pending);
    await writeJsonAtomic(getSidecarPaths(projectRoot).panelReferenceResolutions, pending);
  }));
  return materializeFusionPanelReferenceResolutions(projectRoot);
}

export async function assertFusionPanelReferenceResolutionCurrent(
  projectRoot: string,
  contractId: string,
  panelId: string,
): Promise<PanelReferenceResolution> {
  const store = await loadFusionPanelReferenceStore(projectRoot);
  const resolution = store?.resolutions[resolutionKey(contractId, panelId)];
  if (!store || !resolution) throw new Error("当前宫格缺少 P2 引用闭包，禁止生成。");
  const currentness = await inspectFusionPanelReferenceCurrentness(projectRoot);
  if (currentness.storeRevision !== store.revision || currentness.storeFingerprint !== store.storeFingerprint) {
    throw new Error("逐格引用解析在校验期间发生并发修订；拒绝返回旧 resolution，请重新读取。 ");
  }
  if (!currentness.current) throw new Error(`逐格引用解析输入已漂移（${currentness.driftedInputs.join("、")}）；必须重新物化并审计，禁止使用旧引用板。`);
  if (resolution.closureStatus === "unresolved") throw new Error(`宫格引用闭包未解决：${resolution.issues.join("；")}`);
  if (!resolution.generationReady) throw new Error(`宫格引用已解析但尚未生产就绪：${resolution.blockerCodes.join("、")}`);
  if (resolution.referenceSlots.length > 6) throw new Error("宫格解析结果超过 6 个供应商引用槽，拒绝静默裁剪。");
  for (const asset of resolution.semanticAssets) {
    if (!asset.hardLock) throw new Error(`已知资产 ${asset.assetId} 缺少当前硬锁，禁止生成。`);
    const actual = await digestFile(asset.hardLock.path);
    if (actual !== asset.hardLock.sha256) throw new Error(`成员硬锁 ${asset.assetId} 文件 SHA 已漂移。`);
  }
  for (const slot of resolution.referenceSlots) {
    if (!slot.path || !slot.sha256 || !slot.reviewId && slot.kind === "derived-composite") throw new Error(`引用槽 ${slot.id} 缺少完整路径、SHA 或派生视觉 Review。`);
    const actual = await digestFile(slot.path);
    if (actual !== slot.sha256) throw new Error(`引用槽 ${slot.id} 文件 SHA 已漂移。`);
  }
  const latestStore = await loadFusionPanelReferenceStore(projectRoot);
  if (!latestStore || latestStore.revision !== store.revision || latestStore.storeFingerprint !== store.storeFingerprint) {
    throw new Error("逐格引用解析在文件校验期间发生并发修订；拒绝使用旧 resolution。 ");
  }
  return resolution;
}
