import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { loadFusionProductionAssets, loadFusionProjectManifest } from "./fusion-production.js";
import {
  FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION,
  FUSION_STORYBOARD_VISIBLE_TIME_POLICY_VERSION,
  buildFusionStoryboardGrid,
  normalizeFusionStoryboardGridContract,
  type FusionStoryboardGridContract,
  type FusionStoryboardGridOverride,
  type FusionStoryboardGridReferenceOverride,
} from "./fusion-storyboard-grid.js";
import { getConfirmedStoryboardContracts } from "./production.js";
import {
  renderFusionStoryboardSheetV2,
  type FusionStoryboardSheetPanelImageInput,
  type FusionStoryboardSheetRenderResult,
} from "./fusion-storyboard-sheet.js";
import { getSidecarPaths, loadIndex, readJson, writeJsonAtomic, writeJsonAtomicExclusive } from "./sidecar.js";
import type { FusionStoryboardGridSelection, FusionStoryboardGridSelectionStore, GenerationJob } from "./types.js";
import { getPublicationReceipt } from "./publication.js";
import { withProjectLock } from "./locks.js";
import { buildFusionStoryboardReviewRequirement, loadFusionStoryboardEvidenceSnapshot } from "./fusion-storyboard-evidence.js";
import { reviewCoversFusionStoryboardRequirement } from "./review-evidence.js";
import type { ReviewStore } from "./types.js";
import {
  getFusionStoryboardSheetState,
  inspectFusionStoryboardSheetEvidence,
  type FusionStoryboardSheetPanelPlacement,
} from "./fusion-storyboard-sheet-evidence.js";
import {
  buildFusionStoryboardSheetId,
  loadFusionStoryboardSheetStore,
  registerFusionStoryboardSheetRecord,
  selectFusionStoryboardSheetRecord,
  type FusionStoryboardSheetCurrentEvidence,
  type FusionStoryboardSheetRegistrationInput,
} from "./fusion-storyboard-sheet-store.js";
import { ConfirmedCommandFailure, RejectedCommandFailure } from "./command-outcome.js";

function safeId(value: string, label: string): string {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,199}$/u.test(value) || value === "." || value === "..") throw new Error(`${label} 非法：${value}`);
  return value;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveSafeStoryboardInfoPath(projectRoot: string, infoPath: string): Promise<string> {
  const lexicalRoot = path.resolve(projectRoot);
  const lexicalInfo = path.resolve(infoPath);
  if (!isWithinRoot(lexicalRoot, lexicalInfo)) throw new Error(`宫格单元的 infoPath 越出隔离工程：${infoPath}`);
  const [canonicalRoot, canonicalInfo] = await Promise.all([realpath(lexicalRoot), realpath(lexicalInfo)]);
  const metadata = await lstat(lexicalInfo);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`宫格单元的 infoPath 不是安全普通文件：${infoPath}`);
  if (!isWithinRoot(canonicalRoot, canonicalInfo)) throw new Error(`宫格单元的 infoPath 真实路径越出隔离工程：${infoPath}`);
  // 输出目录由 infoPath 的父目录派生。若父目录经由符号链接到达，
  // 即使最终仍在工程内也拒绝，避免检查后替换链接导致写入边界漂移。
  if (path.dirname(canonicalInfo) !== path.dirname(lexicalInfo)) {
    throw new Error(`宫格单元的 infoPath 父目录含有符号链接：${infoPath}`);
  }
  return canonicalInfo;
}

async function prepareSafeStoryboardOutputDirectory(
  projectRoot: string,
  safeInfoPath: string,
): Promise<{ path: string; created: boolean }> {
  const canonicalRoot = await realpath(projectRoot);
  const outputDirectory = path.join(path.dirname(safeInfoPath), "AI画布生成");
  let created = false;
  try {
    await mkdir(outputDirectory, { recursive: false });
    created = true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
    if (code !== "EEXIST") throw error;
  }
  const metadata = await lstat(outputDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`P4 输出目录不是安全普通目录或是符号链接：${outputDirectory}`);
  }
  const canonicalOutput = await realpath(outputDirectory);
  if (!isWithinRoot(canonicalRoot, canonicalOutput) || canonicalOutput !== path.resolve(outputDirectory)) {
    throw new Error(`P4 输出目录真实路径越出隔离工程或含有符号链接：${outputDirectory}`);
  }
  return { path: canonicalOutput, created };
}

function unitCoordinates(itemId: string): { episodeNumber: number; sequence: number } {
  const match = itemId.match(/^season-三-ep(\d{2})-unit(\d{3})$/u);
  if (!match) throw new Error(`融合宫格只接受第三季 15 秒单元：${itemId}`);
  return { episodeNumber: Number(match[1]), sequence: Number(match[2]) };
}

function contractPath(projectRoot: string, itemId: string, contractId: string): string {
  return path.join(getSidecarPaths(projectRoot).storyboardGrids, safeId(itemId, "单元 ID"), `${safeId(contractId, "宫格合同 ID")}.json`);
}

async function persistFusionStoryboardGridContract(projectRoot: string, contract: FusionStoryboardGridContract): Promise<void> {
  const filePath = contractPath(projectRoot, contract.unit.unitId, contract.contractId);
  try {
    await writeJsonAtomicExclusive(filePath, contract);
  } catch (error) {
    const existing = await readJson<FusionStoryboardGridContract | null>(filePath, null);
    if (!existing) throw error;
    const normalized = normalizeFusionStoryboardGridContract(existing);
    if (normalized.contractId !== contract.contractId
      || normalized.sourceFingerprint !== contract.sourceFingerprint
      || normalized.productionFingerprint !== contract.productionFingerprint) throw error;
    // 历史 v1 合同缺少后来新增的可推导字段时保留原内容寻址文件，不覆盖。
  }
}

const emptyGridSelectionStore = (): FusionStoryboardGridSelectionStore => ({
  schemaVersion: 1,
  revision: 0,
  items: {},
  updatedAt: new Date(0).toISOString(),
});

export async function loadFusionStoryboardGridSelections(projectRoot: string): Promise<FusionStoryboardGridSelectionStore> {
  return readJson(getSidecarPaths(projectRoot).storyboardGridSelections, emptyGridSelectionStore());
}

function gridSelection(contract: FusionStoryboardGridContract, selectedBy: FusionStoryboardGridSelection["selectedBy"]): FusionStoryboardGridSelection {
  const normalized = normalizeFusionStoryboardGridContract(contract);
  return {
    contractId: normalized.contractId,
    sourceFingerprint: normalized.sourceFingerprint,
    productionFingerprint: normalized.productionFingerprint,
    sourceStoryboardRevision: normalized.sourceStoryboardRevision,
    panelCount: normalized.selection.panelCount,
    selectedAt: new Date().toISOString(),
    selectedBy,
  };
}

export async function selectFusionStoryboardGridContracts(
  projectRoot: string,
  contracts: FusionStoryboardGridContract[],
  selectedBy: FusionStoryboardGridSelection["selectedBy"],
  expectedRevision?: number,
): Promise<FusionStoryboardGridSelectionStore> {
  return withProjectLock(projectRoot, "storyboard-grid-selections", async () => {
    const store = await loadFusionStoryboardGridSelections(projectRoot);
    if (expectedRevision !== undefined && store.revision !== expectedRevision) {
      throw new Error(`宫格当前合同选择已变化（期望 r${expectedRevision}，实际 r${store.revision}），拒绝覆盖。`);
    }
    let changed = false;
    for (const contract of contracts) {
      const next = gridSelection(contract, selectedBy);
      const previous = store.items[contract.unit.unitId];
      if (previous
        && previous.contractId === next.contractId
        && previous.sourceFingerprint === next.sourceFingerprint
        && previous.productionFingerprint === next.productionFingerprint
        && previous.panelCount === next.panelCount) continue;
      store.items[contract.unit.unitId] = next;
      changed = true;
    }
    if (!changed) return store;
    store.revision += 1;
    store.updatedAt = new Date().toISOString();
    await writeJsonAtomic(getSidecarPaths(projectRoot).storyboardGridSelections, store);
    return store;
  });
}

export async function selectFusionStoryboardGridContract(
  projectRoot: string,
  contract: FusionStoryboardGridContract,
  selectedBy: FusionStoryboardGridSelection["selectedBy"],
  expectedRevision?: number,
): Promise<FusionStoryboardGridSelectionStore> {
  return selectFusionStoryboardGridContracts(projectRoot, [contract], selectedBy, expectedRevision);
}

export async function buildFusionStoryboardGridForProject(
  projectRoot: string,
  itemId: string,
  options: { override?: FusionStoryboardGridOverride; referenceOverride?: FusionStoryboardGridReferenceOverride; persist?: boolean } = {},
): Promise<FusionStoryboardGridContract> {
  const [manifest, catalog] = await Promise.all([
    loadFusionProjectManifest(projectRoot),
    loadFusionProductionAssets(projectRoot),
  ]);
  if (!manifest || !catalog) throw new Error("当前工程不是已物化的融合工程。 ");
  if (manifest.contentAddress !== catalog.sourceContentAddress || manifest.projectId !== catalog.projectId) {
    throw new Error("融合 manifest 与资产目录内容地址不一致，停止构建宫格。 ");
  }
  const coordinates = unitCoordinates(itemId);
  const unit = manifest.units.find((candidate) => candidate.episodeNumber === coordinates.episodeNumber && candidate.sequence === coordinates.sequence);
  if (!unit) throw new Error(`manifest 中找不到宫格单元：${itemId}`);
  const confirmed = await getConfirmedStoryboardContracts(projectRoot, [itemId], "image");
  const rows = confirmed.byItemId.get(itemId) ?? [];
  const contract = buildFusionStoryboardGrid({
    unit: {
      unitId: itemId,
      title: `${unit.episode} ${unit.title}`,
      episodeLabel: unit.episode,
      unitSequence: unit.sequence,
      storyGoal: unit.storyGoal,
      aspectRatio: unit.aspectRatio,
      standardDurationSeconds: unit.standardDurationSeconds,
    },
    storyboardRevision: confirmed.revision,
    rows,
    schedule: unit.schedule,
    assetIdsByRowId: Object.fromEntries(rows.map((row) => [row.storyboardRowId, [...new Set(row.referenceNames ?? [])]])),
    override: options.override,
    referenceOverride: options.referenceOverride,
  });
  if (options.persist !== false) {
    await persistFusionStoryboardGridContract(projectRoot, contract);
    await selectFusionStoryboardGridContract(projectRoot, contract, "build");
  }
  return contract;
}

export async function loadCurrentFusionStoryboardGrid(
  projectRoot: string,
  itemId: string,
  contractId: string,
): Promise<FusionStoryboardGridContract> {
  const filePath = contractPath(projectRoot, itemId, contractId);
  await access(filePath);
  const storedInput = await readJson<FusionStoryboardGridContract | null>(filePath, null);
  const stored = storedInput ? normalizeFusionStoryboardGridContract(storedInput) : null;
  if (!stored || stored.schemaVersion !== 1 || stored.kind !== "fusion-storyboard-grid-contract" || stored.contractId !== contractId || stored.unit.unitId !== itemId) {
    throw new Error(`宫格合同文件无效：${filePath}`);
  }
  const selections = await loadFusionStoryboardGridSelections(projectRoot);
  const selected = selections.items[itemId];
  if (!selected) throw new Error(`宫格单元 ${itemId} 尚未显式选择当前合同；请先构建或迁移槽位证据。`);
  if (selected.contractId !== contractId
    || selected.sourceFingerprint !== stored.sourceFingerprint
    || selected.productionFingerprint !== stored.productionFingerprint) {
    throw new Error(`宫格合同 ${contractId} 不是 ${itemId} 当前选定合同（当前为 ${selected.contractId}）。`);
  }
  return validateFusionStoryboardGridAgainstCurrent(projectRoot, stored);
}

export async function validateFusionStoryboardGridAgainstCurrent(
  projectRoot: string,
  storedInput: FusionStoryboardGridContract,
): Promise<FusionStoryboardGridContract> {
  const stored = normalizeFusionStoryboardGridContract(storedInput);
  const override = stored.selection.mode === "explicit-override"
    ? {
        panelCount: stored.selection.panelCount,
        expectedRevision: stored.sourceStoryboardRevision,
        reason: stored.selection.overrideReason ?? "",
      }
    : undefined;
  const current = normalizeFusionStoryboardGridContract(await buildFusionStoryboardGridForProject(projectRoot, stored.unit.unitId, {
    override,
    referenceOverride: stored.referenceOverride,
    persist: false,
  }));
  if (current.sourceFingerprint !== stored.sourceFingerprint || current.productionFingerprint !== stored.productionFingerprint) {
    throw new Error(`宫格合同 ${stored.contractId} 已与当前 storyboard 修订冲突，请重新构建。`);
  }
  return stored;
}

export async function materializeAllFusionStoryboardGrids(projectRoot: string, options: { persist?: boolean } = {}): Promise<{
  algorithmVersion: typeof FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION;
  visibleTimePolicyVersion: typeof FUSION_STORYBOARD_VISIBLE_TIME_POLICY_VERSION;
  sourceContentAddress: string;
  contracts: number;
  panelDistribution: Record<string, number>;
  panelImagesRequired: number;
  contractIds: string[];
}> {
  const [manifest, catalog] = await Promise.all([
    loadFusionProjectManifest(projectRoot),
    loadFusionProductionAssets(projectRoot),
  ]);
  if (!manifest || !catalog) throw new Error("当前工程不是已物化的融合工程。 ");
  if (manifest.contentAddress !== catalog.sourceContentAddress || manifest.projectId !== catalog.projectId) {
    throw new Error("融合 manifest 与资产目录内容地址不一致，停止批量构建宫格。 ");
  }
  const itemIds = manifest.units.map((unit) => `season-三-ep${String(unit.episodeNumber).padStart(2, "0")}-unit${String(unit.sequence).padStart(3, "0")}`);
  const confirmed = await getConfirmedStoryboardContracts(projectRoot, itemIds, "image");
  const existingSelections = await loadFusionStoryboardGridSelections(projectRoot);
  const panelDistribution: Record<string, number> = {};
  const contractIds: string[] = [];
  const contracts: FusionStoryboardGridContract[] = [];
  let panelImagesRequired = 0;
  for (const [unitIndex, unit] of manifest.units.entries()) {
    const itemId = itemIds[unitIndex]!;
    const rows = confirmed.byItemId.get(itemId) ?? [];
    const selected = existingSelections.items[itemId];
    const selectedStored = selected
      ? await readJson<FusionStoryboardGridContract | null>(contractPath(projectRoot, itemId, selected.contractId), null)
      : null;
    const selectedContract = selectedStored ? normalizeFusionStoryboardGridContract(selectedStored) : undefined;
    const preservedOverride = selectedContract?.selection.mode === "explicit-override"
      ? {
          panelCount: selectedContract.selection.panelCount,
          expectedRevision: confirmed.revision,
          reason: selectedContract.selection.overrideReason ?? "保留当前显式宫格选择",
        }
      : undefined;
    const currentCandidate = buildFusionStoryboardGrid({
      unit: {
        unitId: itemId,
        title: `${unit.episode} ${unit.title}`,
        episodeLabel: unit.episode,
        unitSequence: unit.sequence,
        storyGoal: unit.storyGoal,
        aspectRatio: unit.aspectRatio,
        standardDurationSeconds: unit.standardDurationSeconds,
      },
      storyboardRevision: confirmed.revision,
      rows,
      schedule: unit.schedule,
      assetIdsByRowId: Object.fromEntries(rows.map((row) => [row.storyboardRowId, [...new Set(row.referenceNames ?? [])]])),
      override: preservedOverride,
      referenceOverride: selectedContract?.referenceOverride,
    });
    const contract = selectedContract
      && selectedContract.sourceStoryboardRevision === confirmed.revision
      && selectedContract.sourceFingerprint === selected?.sourceFingerprint
      && selectedContract.productionFingerprint === selected?.productionFingerprint
      && selectedContract.sourceFingerprint === currentCandidate.sourceFingerprint
      && selectedContract.productionFingerprint === currentCandidate.productionFingerprint
      ? selectedContract
      : currentCandidate;
    if (options.persist !== false) await persistFusionStoryboardGridContract(projectRoot, contract);
    panelDistribution[String(contract.selection.panelCount)] = (panelDistribution[String(contract.selection.panelCount)] ?? 0) + 1;
    panelImagesRequired += contract.selection.panelCount;
    contractIds.push(contract.contractId);
    contracts.push(contract);
  }
  if (options.persist !== false) await selectFusionStoryboardGridContracts(projectRoot, contracts, "build", existingSelections.revision);
  return {
    algorithmVersion: FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION,
    visibleTimePolicyVersion: FUSION_STORYBOARD_VISIBLE_TIME_POLICY_VERSION,
    sourceContentAddress: manifest.contentAddress,
    contracts: contractIds.length,
    panelDistribution,
    panelImagesRequired,
    contractIds,
  };
}

export interface FusionStoryboardSheetProductionResult extends FusionStoryboardSheetRenderResult {
  itemId: string;
  sheetId: string;
  inputFingerprint: string;
  recordFingerprint: string;
  storeRevision: number;
  receiptPath: string;
  generationJobIds: string[];
  reviewId: string;
  requirementId: string;
}

export interface RenderCompletedFusionStoryboardSheetInput {
  itemId: string;
  contractId: string;
  expectedInputFingerprint: string;
  placements?: Record<string, FusionStoryboardSheetPanelPlacement>;
}

function renderPanelInput(
  panelId: string,
  filePath: string,
  expectedSha256: string,
  policy: FusionStoryboardSheetCurrentEvidence["renderPolicy"]["panelImagePolicies"][string] | undefined,
): FusionStoryboardSheetPanelImageInput {
  if (!policy || policy.fit === "contain") return { panelId, path: filePath, expectedSha256 };
  if (policy.evidence.kind === "normalized-focus") {
    return { panelId, path: filePath, expectedSha256, imageTransform: { fit: "crop", focalPoint: { x: policy.evidence.x, y: policy.evidence.y } } };
  }
  if (policy.evidence.kind === "normalized-rect") {
    return {
      panelId,
      path: filePath,
      expectedSha256,
      imageTransform: {
        fit: "crop",
        rect: {
          x: policy.evidence.x,
          y: policy.evidence.y,
          width: policy.evidence.width,
          height: policy.evidence.height,
        },
      },
    };
  }
  throw new Error(`宫格 ${panelId} crop 缺少归一化焦点或矩形。`);
}

function assertRenderedPolicyMatchesEvidence(
  rendered: FusionStoryboardSheetRenderResult,
  evidence: NonNullable<Awaited<ReturnType<typeof inspectFusionStoryboardSheetEvidence>>["currentEvidence"]>,
): void {
  const policy = evidence.renderPolicy;
  if (rendered.renderPolicy.policyVersion !== policy.policyVersion
    || rendered.renderPolicy.renderer !== policy.renderer
    || rendered.renderPolicy.locale !== policy.locale
    || rendered.renderPolicy.defaultImageFit !== policy.defaultImageFit
    || rendered.renderPolicy.textMeasurement !== policy.textMeasurement
    || rendered.renderPolicy.overflowPolicy !== policy.overflowPolicy
    || rendered.renderPolicy.rowHeightPolicy !== policy.rowHeightPolicy
    || rendered.renderPolicy.silentTruncation !== policy.silentTruncation
    || rendered.renderPolicy.pageWidth !== policy.pageWidth
    || rendered.renderPolicy.basePageHeight !== policy.basePageHeight
    || rendered.renderPolicy.maximumPageHeight !== policy.maximumPageHeight) {
    throw new Error("P4 renderer 实际策略与冻结 inputFingerprint 不一致。");
  }
  if (!rendered.overflowReport.allRequiredTextVisible
    || rendered.overflowReport.silentTruncation
    || rendered.overflowReport.truncatedFields.length) throw new Error("P4 renderer 未证明全部中文字段完整可见。");
  for (const crop of rendered.cropAudit) {
    const expected = policy.panelImagePolicies[crop.panelId];
    if (!expected || crop.fit !== expected.fit) throw new Error(`宫格 ${crop.panelId} 实际图像适配与冻结策略不一致。`);
    if (expected.fit === "contain" && (crop.cropApplied || crop.geometry !== "none")) throw new Error(`宫格 ${crop.panelId} contain 发生了未授权裁切。`);
    if (expected.fit === "crop") {
      if (!crop.cropApplied) throw new Error(`宫格 ${crop.panelId} 的审计 crop 没有实际生效。`);
      if (expected.evidence.kind === "normalized-focus"
        && (crop.geometry !== "focal-point" || crop.focalPoint?.x !== expected.evidence.x || crop.focalPoint?.y !== expected.evidence.y)) {
        throw new Error(`宫格 ${crop.panelId} focal crop 审计不一致。`);
      }
      if (expected.evidence.kind === "normalized-rect"
        && (crop.geometry !== "rect"
          || crop.requestedRect?.x !== expected.evidence.x
          || crop.requestedRect?.y !== expected.evidence.y
          || crop.requestedRect?.width !== expected.evidence.width
          || crop.requestedRect?.height !== expected.evidence.height)) {
        throw new Error(`宫格 ${crop.panelId} rect crop 审计不一致。`);
      }
    }
  }
}

export async function renderCompletedFusionStoryboardSheetForProject(
  projectRoot: string,
  input: RenderCompletedFusionStoryboardSheetInput,
): Promise<FusionStoryboardSheetProductionResult> {
  const itemId = input.itemId;
  const contractId = input.contractId;
  let temporaryDirectory: string | undefined;
  let createdOutputDirectory: string | undefined;
  let durablePhase: "none" | "outputs-published" | "registering" | "registered" | "scanning" = "none";
  let publishedOutputPaths: string[] = [];
  const reject = (message: string, reason: string, currentInputFingerprint?: string): never => {
    throw new RejectedCommandFailure(message, {
      schemaVersion: 1,
      applied: false,
      reason,
      itemId,
      contractId,
      expectedInputFingerprint: input.expectedInputFingerprint,
      currentInputFingerprint,
    });
  };
  try {
    const inspected = await inspectFusionStoryboardSheetEvidence(projectRoot, input);
    if (!inspected.currentEvidence || !inspected.contract || !inspected.review || !inspected.requirement?.complete) {
      reject(`正式中文分镜板 Review requirement/证据门禁未通过：${inspected.readiness.blockers.join("；") || "当前证据不可用"}`, "evidence_gate_rejected", inspected.readiness.expectedInputFingerprint);
    }
    if (!input.expectedInputFingerprint || input.expectedInputFingerprint !== inspected.readiness.expectedInputFingerprint) {
      reject(`P4 expectedInputFingerprint 与当前证据不一致（当前 ${inspected.readiness.expectedInputFingerprint}），拒绝重放旧成板。`, "input_fingerprint_conflict", inspected.readiness.expectedInputFingerprint);
    }
    const contract = inspected.contract!;
    const evidence = inspected.currentEvidence!;
    const review = inspected.review!;
    const requirement = inspected.requirement!;
    const expectedSheetId = buildFusionStoryboardSheetId(evidence);
    if (expectedSheetId !== inspected.readiness.expectedSheetId) reject("P4 expectedSheetId 派生发生内部漂移。", "sheet_id_derivation_drift", inspected.readiness.expectedInputFingerprint);
    const index = await loadIndex(projectRoot);
    if (!index) reject("本地中文分镜板成板要求已有真实扫描索引。", "scan_index_missing");
    const authoritativeIndex = index!;
    const item = authoritativeIndex.items.find((candidate) => candidate.id === itemId && candidate.type === "unit");
    if (!item?.infoPath || !path.isAbsolute(item.infoPath)) reject(`宫格单元 ${itemId} 缺少可追溯的绝对 infoPath。`, "unsafe_info_path");
    const authoritativeItem = item!;
    let safeInfoPath: string;
    try {
      safeInfoPath = await resolveSafeStoryboardInfoPath(projectRoot, authoritativeItem.infoPath!);
    } catch (error) {
      reject(error instanceof Error ? error.message : String(error), "unsafe_info_path");
    }
    const selectedJobs = inspected.jobs;
    const prefix = `EP${String(authoritativeItem.episode ?? 0).padStart(2, "0")}_15s_${String(authoritativeItem.unit ?? 0).padStart(3, "0")}`;
    const preparedOutput = await prepareSafeStoryboardOutputDirectory(projectRoot, safeInfoPath!);
    const outputDirectory = preparedOutput.path;
    if (preparedOutput.created) createdOutputDirectory = outputDirectory;
    const finalDirectory = path.join(outputDirectory, expectedSheetId);
    const temporaryRoot = path.join(outputDirectory, `.${expectedSheetId}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
    temporaryDirectory = temporaryRoot;
    await mkdir(temporaryRoot, { recursive: false });
    const temporaryPngPath = path.join(temporaryRoot, `${prefix}_中文分镜板_${expectedSheetId}_p01-of-01.png`);
    const temporarySvgPath = temporaryPngPath.replace(/\.png$/u, ".svg");
    const temporaryRendered = await renderFusionStoryboardSheetV2({
      contract,
      panelImages: evidence.panels.map((panel) => renderPanelInput(
        panel.panelId,
        panel.raw.path,
        panel.raw.sha256,
        evidence.renderPolicy.panelImagePolicies[panel.panelId],
      )),
      outputPath: temporaryPngPath,
      svgOutputPath: temporarySvgPath,
      renderPurpose: "formal",
      renderPolicy: { overflowPolicy: "long-sheet", maximumPageHeight: evidence.renderPolicy.maximumPageHeight },
    });
    if (temporaryRendered.renderPurpose !== "formal" || !temporaryRendered.formalProductionEligible) {
      reject("正式中文故事板拒绝接收 layout-preview 渲染结果。", "non_formal_render_result");
    }
    assertRenderedPolicyMatchesEvidence(temporaryRendered, evidence);
    const preCommit = await inspectFusionStoryboardSheetEvidence(projectRoot, input);
    if (preCommit.readiness.expectedInputFingerprint !== input.expectedInputFingerprint) {
      reject("P4 渲染期间上游证据发生漂移；临时输出已清理且未发布。", "evidence_drift_before_publish", preCommit.readiness.expectedInputFingerprint);
    }

    let createdDirectory = false;
    try {
      await rename(temporaryRoot, finalDirectory);
      createdDirectory = true;
      temporaryDirectory = undefined;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      const finalMetadata = await lstat(finalDirectory);
      if (!finalMetadata.isDirectory() || finalMetadata.isSymbolicLink()) throw new Error(`P4 最终输出目录不安全：${finalDirectory}`);
      for (const temporaryArtifact of [temporaryRendered.png, temporaryRendered.svg]) {
        const finalPath = path.join(finalDirectory, path.basename(temporaryArtifact.path));
        const finalMetadataEntry = await lstat(finalPath);
        if (!finalMetadataEntry.isFile() || finalMetadataEntry.isSymbolicLink()) throw new Error(`P4 已有输出不是安全普通文件：${finalPath}`);
        const observed = await readFile(finalPath);
        const temporary = await readFile(temporaryArtifact.path);
        if (!observed.equals(temporary)) throw new Error(`P4 内容寻址输出目录已存在但文件内容冲突：${finalPath}`);
      }
      await rm(temporaryRoot, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
    const remapArtifact = (artifact: typeof temporaryRendered.png) => ({
      ...artifact,
      path: path.join(finalDirectory, path.basename(artifact.path)),
      status: createdDirectory ? "created" as const : "existing" as const,
    });
    const rendered: FusionStoryboardSheetRenderResult = {
      ...temporaryRendered,
      pages: temporaryRendered.pages.map((page) => ({ ...page, png: remapArtifact(page.png), svg: remapArtifact(page.svg) })),
      png: remapArtifact(temporaryRendered.png),
      svg: remapArtifact(temporaryRendered.svg),
      reused: !createdDirectory,
    };
    durablePhase = createdDirectory ? "outputs-published" : "none";
    publishedOutputPaths = rendered.pages.flatMap((page) => [page.png.path, page.svg.path]);
    const generationJobIds = selectedJobs.map((job) => job.id);
    const registrationInput: FusionStoryboardSheetRegistrationInput = {
      ...evidence,
      renderEvidence: {
        renderFingerprint: rendered.renderFingerprint,
        cropAudit: rendered.cropAudit,
        overflowReport: { ...rendered.overflowReport },
      },
      outputs: rendered.pages.flatMap((page) => [
        { role: "png" as const, path: page.png.path, sha256: page.png.sha256, bytes: page.png.bytes, width: page.width, height: page.height, pageIndex: page.pageIndex, pageCount: rendered.pageCount },
        { role: "svg" as const, path: page.svg.path, sha256: page.svg.sha256, bytes: page.svg.bytes, width: page.width, height: page.height, pageIndex: page.pageIndex, pageCount: rendered.pageCount },
      ]),
    };
    let store = await loadFusionStoryboardSheetStore(projectRoot);
    durablePhase = "registering";
    const registered = await registerFusionStoryboardSheetRecord(projectRoot, registrationInput, { expectedRevision: store.revision, selectCurrent: true });
    store = registered.store;
    durablePhase = "registered";
    if (!registered.selected) {
      store = await selectFusionStoryboardSheetRecord(projectRoot, {
        itemId,
        sheetId: registered.record.sheetId,
        expectedRevision: store.revision,
        expectedInputFingerprint: input.expectedInputFingerprint,
      });
    }
    const postCommit = await inspectFusionStoryboardSheetEvidence(projectRoot, input);
    if (postCommit.readiness.expectedInputFingerprint !== input.expectedInputFingerprint) {
      throw new Error("P4 登记后上游证据发生漂移；该板已自动派生为 stale，未返回 current 成功。");
    }
    const state = await getFusionStoryboardSheetState(projectRoot, input);
    if (state.currentSheetId !== registered.record.sheetId) throw new Error("P4 成板登记后未能派生为 current，拒绝返回成功。");
    durablePhase = "scanning";
    const { scanAndPersist } = await import("./service.js");
    await scanAndPersist(projectRoot, { includeHashPaths: [...registered.record.outputs.map((output) => output.path), registered.record.receiptPath] });
    return {
      ...rendered,
      itemId,
      sheetId: registered.record.sheetId,
      inputFingerprint: registered.record.inputFingerprint,
      recordFingerprint: registered.record.fingerprint,
      storeRevision: store.revision,
      receiptPath: registered.record.receiptPath,
      generationJobIds,
      reviewId: review.id,
      requirementId: requirement.id,
    };
  } catch (error) {
    if (error instanceof RejectedCommandFailure || error instanceof ConfirmedCommandFailure) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (durablePhase !== "none") {
      throw new ConfirmedCommandFailure(message, {
        schemaVersion: 1,
        applied: true,
        reason: "storyboard_sheet_failed_after_durable_effect",
        phase: durablePhase,
        itemId,
        contractId,
        expectedInputFingerprint: input.expectedInputFingerprint,
        outputPaths: publishedOutputPaths,
      });
    }
    throw new RejectedCommandFailure(message, {
      schemaVersion: 1,
      applied: false,
      reason: "storyboard_sheet_prepublication_failure",
      phase: "pre-publication",
      itemId,
      contractId,
      expectedInputFingerprint: input.expectedInputFingerprint,
    });
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (createdOutputDirectory && durablePhase === "none") {
      await rmdir(createdOutputDirectory).catch(() => undefined);
    }
  }
}
