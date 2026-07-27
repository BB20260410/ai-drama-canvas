import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { loadFusionProjectManifest } from "./fusion-production.js";
import { buildFusionStoryboardProgress, buildFusionStoryboardReviewRequirement, loadFusionStoryboardEvidenceSnapshot } from "./fusion-storyboard-evidence.js";
import { reviewCoversFusionStoryboardRequirement } from "./review-evidence.js";
import { getPublicationReceipt } from "./publication.js";
import { getSidecarPaths, loadIndex, readJson } from "./sidecar.js";
import {
  FUSION_STORYBOARD_SHEET_RENDER_POLICY_VERSION,
  buildFusionStoryboardSheetId,
  fusionStoryboardSheetInputFingerprint,
  listFusionStoryboardSheetArtifactSnapshot,
  loadFusionStoryboardSheetRecord,
  loadFusionStoryboardSheetStore,
  type FusionStoryboardSheetCurrentEvidence,
  type FusionStoryboardSheetRenderPolicySnapshot,
  type FusionStoryboardSheetSnapshot,
} from "./fusion-storyboard-sheet-store.js";
import {
  previewFusionStoryboardSheetMigration,
  type FusionStoryboardSheetMigrationPreview,
} from "./fusion-storyboard-sheet-migration.js";
import type { FusionStoryboardGridContract } from "./fusion-storyboard-grid.js";
import type {
  Artifact,
  FusionStoryboardReviewRequirement,
  GenerationJob,
  ReviewRecord,
  ReviewStore,
} from "./types.js";

export type FusionStoryboardSheetPanelPlacement =
  | { fit?: "contain" }
  | { fit: "crop"; reason: string; focalPoint: { x: number; y: number }; rect?: never }
  | { fit: "crop"; reason: string; focalPoint?: never; rect: { x: number; y: number; width: number; height: number } };

export interface FusionStoryboardSheetReadiness {
  canRender: boolean;
  blockers: string[];
  expectedInputFingerprint?: string;
  expectedSheetId?: string;
  requirementId?: string;
  reviewId?: string;
}

export interface FusionStoryboardSheetVersionArtifactSummary {
  role: "png" | "svg" | "receipt";
  path: string;
  pageIndex?: number;
  pageCount: number;
}

export interface FusionStoryboardSheetVersionSummary {
  sheetId: string;
  itemId: string;
  inputFingerprint?: string;
  createdAt: string;
  status: "current" | "stale" | "invalid" | "legacy-invalid";
  reasons: string[];
  contractId: string;
  requirementId?: string;
  reviewId?: string;
  artifacts: FusionStoryboardSheetVersionArtifactSummary[];
}

export interface FusionStoryboardSheetState {
  schemaVersion: 2;
  kind: "fusion-storyboard-sheet-state";
  itemId: string;
  storeRevision: number;
  currentContract?: FusionStoryboardGridContract;
  readiness: FusionStoryboardSheetReadiness;
  currentSheetId?: string;
  versions: FusionStoryboardSheetVersionSummary[];
  migrationPreview: FusionStoryboardSheetMigrationPreview;
}

export function selectAuthoritativeFusionStoryboardSheetReview(
  records: readonly ReviewRecord[],
  itemId: string,
  requirementId: string,
): ReviewRecord | undefined {
  return records
    .filter((record) => record.itemId === itemId
      && record.reviewType === "image"
      && record.requirementId === requirementId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id, "en"))[0];
}

export interface InspectFusionStoryboardSheetEvidenceResult {
  itemId: string;
  contract?: FusionStoryboardGridContract;
  requirement?: FusionStoryboardReviewRequirement;
  review?: ReviewRecord;
  jobs: GenerationJob[];
  artifacts: Artifact[];
  currentEvidence?: FusionStoryboardSheetCurrentEvidence;
  readiness: FusionStoryboardSheetReadiness;
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

async function fileEvidence(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`不是安全普通文件：${filePath}`);
  const content = await readFile(filePath);
  return { sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length };
}

function normalizeCoordinate(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} 必须位于 [0,1]。`);
  return value;
}

export function buildFusionStoryboardSheetRenderPolicy(
  panelIds: readonly string[],
  placements: Record<string, FusionStoryboardSheetPanelPlacement> = {},
): FusionStoryboardSheetRenderPolicySnapshot {
  const expected = new Set(panelIds);
  for (const panelId of Object.keys(placements)) {
    if (!expected.has(panelId)) throw new Error(`裁切策略引用了当前合同外宫格：${panelId}`);
  }
  const panelImagePolicies = Object.fromEntries(panelIds.map((panelId) => {
    const placement = placements[panelId];
    if (!placement || placement.fit === undefined || placement.fit === "contain") return [panelId, { fit: "contain" as const }];
    if (!("reason" in placement)) throw new Error(`宫格 ${panelId} crop 缺少审计理由。`);
    const reason = placement.reason.trim();
    if (reason.length < 3) throw new Error(`宫格 ${panelId} 的 crop 必须填写至少 3 字审计理由。`);
    if (placement.focalPoint) {
      return [panelId, {
        fit: "crop" as const,
        reason,
        evidence: {
          kind: "normalized-focus" as const,
          x: normalizeCoordinate(placement.focalPoint.x, `${panelId}.focalPoint.x`),
          y: normalizeCoordinate(placement.focalPoint.y, `${panelId}.focalPoint.y`),
        },
      }];
    }
    const rect = placement.rect;
    if (!rect) throw new Error(`宫格 ${panelId} crop 必须提供 focalPoint 或 rect。`);
    const x = normalizeCoordinate(rect.x, `${panelId}.rect.x`);
    const y = normalizeCoordinate(rect.y, `${panelId}.rect.y`);
    const width = normalizeCoordinate(rect.width, `${panelId}.rect.width`);
    const height = normalizeCoordinate(rect.height, `${panelId}.rect.height`);
    if (width <= 0 || height <= 0 || x + width > 1 || y + height > 1) throw new Error(`宫格 ${panelId} crop rect 必须完整位于归一化画布。`);
    return [panelId, { fit: "crop" as const, reason, evidence: { kind: "normalized-rect" as const, x, y, width, height } }];
  }));
  return {
    policyVersion: FUSION_STORYBOARD_SHEET_RENDER_POLICY_VERSION,
    renderer: "svg-sharp-v2",
    locale: "zh-CN",
    defaultImageFit: "contain",
    textMeasurement: "deterministic-character-units-v2",
    overflowPolicy: "long-sheet",
    rowHeightPolicy: "dynamic-content-measured",
    silentTruncation: false,
    pageWidth: 2160,
    basePageHeight: 3840,
    maximumPageHeight: 32000,
    panelImagePolicies,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function publicationMatches(input: {
  job: GenerationJob;
  receipt: Awaited<ReturnType<typeof getPublicationReceipt>>;
  itemId: string;
  targetPath: string;
  sha256: string;
  expectedIntentId: string;
  expectedKind: "raw-image" | "labeled-image";
  expectedBundle?: { id: string; member: "primary" | "companion" };
}): boolean {
  return Boolean(input.receipt
    && input.receipt.context.purpose === "generation-output"
    && input.receipt.context.jobId === input.job.id
    && input.receipt.context.itemId === input.itemId
    && input.receipt.intentId === input.expectedIntentId
    && input.receipt.kind === input.expectedKind
    && (input.expectedBundle
      ? input.receipt.bundleId === input.expectedBundle.id
        && input.receipt.bundleMember === input.expectedBundle.member
      : input.receipt.bundleId === undefined && input.receipt.bundleMember === undefined)
    && path.resolve(input.receipt.targetPath) === path.resolve(input.targetPath)
    && input.receipt.check.sha256 === input.sha256);
}

export async function inspectFusionStoryboardSheetEvidence(
  projectRoot: string,
  input: { itemId: string; contractId?: string; placements?: Record<string, FusionStoryboardSheetPanelPlacement> },
): Promise<InspectFusionStoryboardSheetEvidenceResult> {
  const blockers: string[] = [];
  // 延迟加载避免 scanner -> sheet evidence -> storyboard production -> scanner
  // 的模块初始化环；这里只在真实状态查询时读取函数。
  const { loadCurrentFusionStoryboardGrid, loadFusionStoryboardGridSelections } = await import("./fusion-storyboard-production.js");
  const [manifest, index, jobs, reviewStore, selections, sheetStore] = await Promise.all([
    loadFusionProjectManifest(projectRoot),
    loadIndex(projectRoot),
    readJson<GenerationJob[]>(getSidecarPaths(projectRoot).generationJobs, []),
    readJson<ReviewStore>(getSidecarPaths(projectRoot).reviews, { schemaVersion: 1, records: [] }),
    loadFusionStoryboardGridSelections(projectRoot),
    loadFusionStoryboardSheetStore(projectRoot),
  ]);
  if (!manifest) blockers.push("当前工程缺少融合 manifest");
  if (!index) blockers.push("当前工程缺少真实扫描索引");
  const selected = selections.items[input.itemId];
  if (!selected) blockers.push("当前单元尚未显式选择宫格合同");
  const contractId = input.contractId ?? selected?.contractId;
  if (input.contractId && selected && input.contractId !== selected.contractId) blockers.push(`请求合同不是当前合同（当前 ${selected.contractId}）`);
  let contract: FusionStoryboardGridContract | undefined;
  if (contractId) {
    try { contract = await loadCurrentFusionStoryboardGrid(projectRoot, input.itemId, contractId); }
    catch (error) { blockers.push(error instanceof Error ? error.message : String(error)); }
  }
  const item = index?.items.find((candidate) => candidate.id === input.itemId && candidate.type === "unit");
  if (!item) blockers.push("扫描索引中找不到当前 15 秒单元");
  const artifacts = index?.artifacts.filter((artifact) => artifact.itemId === input.itemId) ?? [];
  const fusionEvidence = item ? await loadFusionStoryboardEvidenceSnapshot(projectRoot) : undefined;
  const liveProgress = item && fusionEvidence ? buildFusionStoryboardProgress(item.id, artifacts, fusionEvidence) : undefined;
  const liveItem = item && liveProgress ? { ...item, fusionStoryboard: liveProgress } : undefined;
  const requirement = liveItem && fusionEvidence ? buildFusionStoryboardReviewRequirement(liveItem, artifacts, fusionEvidence) : undefined;
  if (!requirement) blockers.push("当前单元没有可构建的宫格 Review requirement");
  else if (!requirement.complete) blockers.push(...requirement.issues.length ? requirement.issues : ["当前宫格 Review requirement 不完整"]);
  const authoritativeReview = requirement?.complete
    ? selectAuthoritativeFusionStoryboardSheetReview(reviewStore.records, input.itemId, requirement.id)
    : undefined;
  const review = authoritativeReview?.decision === "pass"
    && reviewCoversFusionStoryboardRequirement(authoritativeReview, requirement, artifacts)
    ? authoritativeReview
    : undefined;
  if (requirement?.complete && authoritativeReview && authoritativeReview.decision !== "pass") {
    blockers.push(`当前 requirement 的最新视觉裁决为 ${authoritativeReview.decision}，旧 pass Review 已失效`);
  } else if (requirement?.complete && !review) blockers.push("当前全部宫格缺少覆盖 P3 逐规则证明的有效视觉通过 Review");
  const selectedJobs: GenerationJob[] = [];
  const panelEvidence: FusionStoryboardSheetCurrentEvidence["panels"] = [];
  if (requirement?.complete) {
    for (const panel of [...requirement.panels].sort((left, right) => left.panelIndex - right.panelIndex)) {
      const job = jobs.find((candidate) => candidate.id === panel.generationJobId);
      if (!job || job.status !== "succeeded") {
        blockers.push(`宫格 ${panel.panelId} 没有 succeeded GenerationJob`);
        continue;
      }
      selectedJobs.push(job);
      if (!job.resultPath || !job.companionPath || !job.resultSha256 || !job.publicationIntentId || !job.publicationReceiptId || !panel.raw || !panel.labeled) {
        blockers.push(`宫格 ${panel.panelId} 缺少 raw/labeled、SHA 或 Publication 身份`);
        continue;
      }
      if (!job.publicationBundleId && (job.companionPublicationIntentId
        || job.companionPublicationReservationToken
        || job.companionPublicationReceiptId)) {
        blockers.push(`宫格 ${panel.panelId} 的 non-bundle Publication 含有孤立 companion 身份`);
        continue;
      }
      if (path.resolve(job.resultPath) !== path.resolve(panel.raw.path)
        || path.resolve(job.companionPath) !== path.resolve(panel.labeled.path)
        || path.resolve(job.resultPath) !== path.resolve(job.expectedOutputPath)
        || (job.expectedCompanionPath && path.resolve(job.companionPath) !== path.resolve(job.expectedCompanionPath))) {
        blockers.push(`宫格 ${panel.panelId} 的任务路径与当前 requirement 不一致`);
        continue;
      }
      let rawFile: { sha256: string; bytes: number };
      let labeledFile: { sha256: string; bytes: number };
      try {
        [rawFile, labeledFile] = await Promise.all([fileEvidence(job.resultPath), fileEvidence(job.companionPath)]);
      } catch (error) {
        blockers.push(`宫格 ${panel.panelId} 文件无法验真：${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (rawFile.sha256 !== panel.raw.sha256 || rawFile.sha256 !== job.resultSha256) blockers.push(`宫格 ${panel.panelId} raw SHA 已漂移`);
      if (labeledFile.sha256 !== panel.labeled.sha256) blockers.push(`宫格 ${panel.panelId} labeled SHA 已漂移`);
      const rawArtifact = artifacts.find((artifact) => artifact.id === panel.raw!.artifactId);
      const labeledArtifact = artifacts.find((artifact) => artifact.id === panel.labeled!.artifactId);
      if (!rawArtifact || !labeledArtifact
        || rawArtifact.check.size !== rawFile.bytes
        || labeledArtifact.check.size !== labeledFile.bytes) blockers.push(`宫格 ${panel.panelId} Artifact 大小身份不一致`);
      const receipt = await getPublicationReceipt(projectRoot, job.publicationReceiptId);
      const expectedBundle = job.publicationBundleId
        ? { id: job.publicationBundleId, member: "primary" as const }
        : undefined;
      if (!publicationMatches({
        job,
        receipt,
        itemId: input.itemId,
        targetPath: job.resultPath,
        sha256: rawFile.sha256,
        expectedIntentId: job.publicationIntentId,
        expectedKind: "raw-image",
        expectedBundle,
      })) {
        blockers.push(`宫格 ${panel.panelId} raw Publication 回执无效`);
        continue;
      }
      let companionReceiptId: string | undefined;
      let companionReceiptFingerprint: string | undefined;
      if (job.publicationBundleId && (!job.companionPublicationIntentId || !job.companionPublicationReceiptId)) {
        blockers.push(`宫格 ${panel.panelId} 缺少 labeled Publication bundle 回执`);
        continue;
      }
      if (job.companionPublicationReceiptId) {
        const companion = await getPublicationReceipt(projectRoot, job.companionPublicationReceiptId);
        if (!publicationMatches({
          job,
          receipt: companion,
          itemId: input.itemId,
          targetPath: job.companionPath,
          sha256: labeledFile.sha256,
          expectedIntentId: job.companionPublicationIntentId!,
          expectedKind: "labeled-image",
          expectedBundle: job.publicationBundleId
            ? { id: job.publicationBundleId, member: "companion" }
            : undefined,
        })) {
          blockers.push(`宫格 ${panel.panelId} labeled Publication 回执无效`);
          continue;
        }
        companionReceiptId = companion!.id;
        companionReceiptFingerprint = digest(companion);
      }
      panelEvidence.push({
        panelId: panel.panelId,
        panelIndex: panel.panelIndex,
        panelCount: panel.panelCount,
        generationJobId: job.id,
        generationJobFingerprint: digest(job),
        publicationReceiptId: receipt!.id,
        publicationReceiptFingerprint: digest(receipt),
        ...(companionReceiptId ? {
          companionPublicationReceiptId: companionReceiptId,
          companionPublicationReceiptFingerprint: companionReceiptFingerprint,
        } : {}),
        raw: { artifactId: panel.raw.artifactId, path: panel.raw.path, sha256: rawFile.sha256, bytes: rawFile.bytes },
        labeled: { artifactId: panel.labeled.artifactId, path: panel.labeled.path, sha256: labeledFile.sha256, bytes: labeledFile.bytes },
      });
    }
  }
  let renderPolicy: FusionStoryboardSheetRenderPolicySnapshot | undefined;
  if (contract) {
    try {
      const panelIds = contract.panels.map((panel) => panel.id);
      const selectedSheet = sheetStore.currentByItemId[input.itemId];
      const selectedRecord = selectedSheet ? await loadFusionStoryboardSheetRecord(projectRoot, selectedSheet.sheetId) : undefined;
      const retainedPolicy = input.placements === undefined
        && selectedRecord?.contract.contractId === contract.contractId
        ? selectedRecord.renderPolicy
        : undefined;
      if (retainedPolicy) {
        const retainedPanelIds = Object.keys(retainedPolicy.panelImagePolicies).sort((left, right) => left.localeCompare(right, "en"));
        const expectedPanelIds = [...panelIds].sort((left, right) => left.localeCompare(right, "en"));
        if (JSON.stringify(retainedPanelIds) !== JSON.stringify(expectedPanelIds)) {
          throw new Error("当前已选故事板的裁切策略与宫格合同不一致，拒绝静默回退 contain。");
        }
        // 未显式传 placements 时，沿用已登记 current 版本的审计策略。这样
        // Scanner、UI 和重启后的只读状态不会把合法 crop 板误判为 stale；调用
        // 方若要明确恢复默认 contain，必须传入显式空对象 `{}`。
        renderPolicy = retainedPolicy;
      } else {
        renderPolicy = buildFusionStoryboardSheetRenderPolicy(panelIds, input.placements);
      }
    }
    catch (error) { blockers.push(error instanceof Error ? error.message : String(error)); }
  }
  if (contract && panelEvidence.length !== contract.selection.panelCount) blockers.push(`完整宫格证据不足：${panelEvidence.length}/${contract.selection.panelCount}`);
  const currentEvidence = manifest && index && contract && requirement?.complete && review && renderPolicy
    && panelEvidence.length === contract.selection.panelCount && blockers.length === 0
    ? {
        projectId: index.project.id,
        sourceContentAddress: manifest.contentAddress,
        itemId: input.itemId,
        contract: {
          contractId: contract.contractId,
          sourceFingerprint: contract.sourceFingerprint,
          productionFingerprint: contract.productionFingerprint,
          contractFingerprint: digest(contract),
        },
        requirement: {
          requirementId: requirement.id,
          requirementFingerprint: digest(requirement),
          complete: true as const,
        },
        review: { reviewId: review.id, reviewFingerprint: digest(review), decision: "pass" as const },
        panels: panelEvidence,
        renderPolicy,
      } satisfies FusionStoryboardSheetCurrentEvidence
    : undefined;
  const expectedInputFingerprint = currentEvidence ? fusionStoryboardSheetInputFingerprint(currentEvidence) : undefined;
  const expectedSheetId = currentEvidence ? buildFusionStoryboardSheetId(currentEvidence) : undefined;
  return {
    itemId: input.itemId,
    contract,
    requirement,
    review,
    jobs: selectedJobs,
    artifacts,
    currentEvidence,
    readiness: {
      canRender: Boolean(currentEvidence),
      blockers: unique(blockers),
      expectedInputFingerprint,
      expectedSheetId,
      requirementId: requirement?.id,
      reviewId: review?.id,
    },
  };
}

function summarizeVersions(snapshot: FusionStoryboardSheetSnapshot): FusionStoryboardSheetVersionSummary[] {
  const groups = new Map<string, FusionStoryboardSheetVersionSummary>();
  for (const item of snapshot.items) {
    const existing = groups.get(item.sheetId) ?? {
      sheetId: item.sheetId,
      itemId: item.itemId,
      inputFingerprint: item.inputFingerprint,
      createdAt: item.createdAt,
      status: item.status,
      reasons: [],
      contractId: item.contractId,
      requirementId: item.requirementId,
      reviewId: item.reviewId,
      artifacts: [],
    };
    if (existing.status !== "invalid" && item.status === "invalid") existing.status = "invalid";
    else if (existing.status === "current" && item.status !== "current") existing.status = item.status;
    existing.reasons.push(...item.reasons);
    existing.artifacts.push({ role: item.role, path: item.path, pageIndex: item.pageIndex, pageCount: item.pageCount });
    groups.set(item.sheetId, existing);
  }
  return [...groups.values()].map((version) => ({
    ...version,
    reasons: unique(version.reasons),
    artifacts: version.artifacts.sort((left, right) => left.role.localeCompare(right.role, "en") || (left.pageIndex ?? 0) - (right.pageIndex ?? 0)),
  })).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.sheetId.localeCompare(right.sheetId, "en"));
}

export async function getFusionStoryboardSheetState(
  projectRoot: string,
  input: { itemId: string; contractId?: string; placements?: Record<string, FusionStoryboardSheetPanelPlacement> },
): Promise<FusionStoryboardSheetState> {
  const inspected = await inspectFusionStoryboardSheetEvidence(projectRoot, input);
  const store = await loadFusionStoryboardSheetStore(projectRoot);
  const snapshot = await listFusionStoryboardSheetArtifactSnapshot(projectRoot, {
    currentEvidenceByItemId: { [input.itemId]: inspected.currentEvidence },
    verifyFiles: true,
    store,
  });
  const itemSheetIds = new Set(snapshot.items.filter((entry) => entry.itemId === input.itemId).map((entry) => entry.sheetId));
  const versions = summarizeVersions(snapshot).filter((version) => itemSheetIds.has(version.sheetId));
  const selected = store.currentByItemId[input.itemId];
  const currentSheetId = selected && versions.some((version) => version.sheetId === selected.sheetId && version.status === "current")
    ? selected.sheetId
    : undefined;
  const migrationPreview = await previewFusionStoryboardSheetMigration(projectRoot, { itemIds: [input.itemId] }, { store });
  return {
    schemaVersion: 2,
    kind: "fusion-storyboard-sheet-state",
    itemId: input.itemId,
    storeRevision: store.revision,
    currentContract: inspected.contract,
    readiness: inspected.readiness,
    currentSheetId,
    versions,
    migrationPreview,
  };
}

export async function listFusionStoryboardSheets(
  projectRoot: string,
  input: {
    itemId?: string;
    sheetId?: string;
    status?: FusionStoryboardSheetVersionSummary["status"];
    placements?: Record<string, FusionStoryboardSheetPanelPlacement>;
    offset?: number;
    limit?: number;
  } = {},
): Promise<{
  storeRevision: number;
  migrationPreview: FusionStoryboardSheetMigrationPreview;
  total: number;
  offset: number;
  limit: number;
  items: FusionStoryboardSheetVersionSummary[];
}> {
  if (!input.itemId && input.placements && Object.keys(input.placements).length > 0) {
    throw new Error("listFusionStoryboardSheets 的 placements 必须绑定明确 itemId，拒绝跨单元套用裁切策略。 ");
  }
  const store = await loadFusionStoryboardSheetStore(projectRoot);
  const itemIds = input.itemId
    ? [input.itemId]
    : [...new Set([
        ...Object.values(store.records).map((record) => record.itemId),
        ...Object.values(store.legacyRecords).map((record) => record.itemId),
      ])];
  const currentEvidenceByItemId: Record<string, FusionStoryboardSheetCurrentEvidence | undefined> = {};
  for (const itemId of itemIds) {
    currentEvidenceByItemId[itemId] = (await inspectFusionStoryboardSheetEvidence(projectRoot, {
      itemId,
      ...(input.itemId === itemId && input.placements ? { placements: input.placements } : {}),
    })).currentEvidence;
  }
  const snapshot = await listFusionStoryboardSheetArtifactSnapshot(projectRoot, { currentEvidenceByItemId, verifyFiles: true, store });
  let versions = summarizeVersions(snapshot);
  if (input.itemId) {
    const ids = new Set(snapshot.items.filter((entry) => entry.itemId === input.itemId).map((entry) => entry.sheetId));
    versions = versions.filter((version) => ids.has(version.sheetId));
  }
  if (input.sheetId) versions = versions.filter((version) => version.sheetId === input.sheetId);
  if (input.status) versions = versions.filter((version) => version.status === input.status);
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 50)));
  const migrationPreview = await previewFusionStoryboardSheetMigration(projectRoot, input.itemId ? { itemIds: [input.itemId] } : {}, { store });
  return { storeRevision: store.revision, migrationPreview, total: versions.length, offset, limit, items: versions.slice(offset, offset + limit) };
}
