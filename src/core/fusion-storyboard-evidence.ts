import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  fusionStoryboardProductionFingerprint,
  normalizeFusionStoryboardGridContract,
  type FusionStoryboardGridContract,
} from "./fusion-storyboard-grid.js";
import { getSidecarPaths, readJson } from "./sidecar.js";
import type {
  Artifact,
  FusionStoryboardGridSelection,
  FusionStoryboardGridSelectionStore,
  FusionStoryboardPanelArtifactBinding,
  FusionStoryboardPanelProgress,
  FusionStoryboardProgress,
  FusionStoryboardReviewRequirement,
  GenerationJob,
  ProjectConfig,
  WorkItem,
} from "./types.js";
import type { PublicationReceipt, PublicationStore } from "./publication.js";
import { gridSelectionSemanticDigest, loadFusionPanelReferenceStoreSnapshot } from "./fusion-panel-references.js";
import type { PanelVisualConstraint } from "./fusion-visual-constraints.js";

const ACTIVE_JOB_STATUSES = new Set<GenerationJob["status"]>([
  "queued",
  "submitting",
  "submission_unknown",
  "waiting_external",
  "waiting_remote",
  "generating",
  "generation_unknown",
  "candidate_generated",
]);

export interface SelectedFusionStoryboardGrid {
  selection: FusionStoryboardGridSelection;
  contract: FusionStoryboardGridContract;
  source: "explicit" | "inferred";
}

interface ArtifactBinding {
  kind: "raw-image" | "labeled-image";
  binding: FusionStoryboardPanelArtifactBinding;
}

export interface FusionStoryboardEvidenceSnapshot {
  jobs: GenerationJob[];
  receiptsById: Map<string, PublicationReceipt>;
  selections: Map<string, SelectedFusionStoryboardGrid>;
  bindingsByPath: Map<string, ArtifactBinding>;
  referenceEvidenceByJobId: Map<string, FusionStoryboardReferenceEvidence>;
  validPanelJobIds: Set<string>;
  confirmedEmptyPanelJobIds: Set<string>;
  panelReferenceIdentityByJobId: Map<string, {
    legacy: boolean;
    panelReferenceEvidenceVersion: 1;
    panelReferenceResolutionId: string;
    panelReferenceResolutionFingerprint: string;
  }>;
  panelVisualConstraintsEnabled: boolean;
  panelVisualConstraintsCurrent: boolean;
  panelVisualConstraintsByPanelKey: Map<string, PanelVisualConstraint>;
  panelVisualConstraintIdentityByJobId: Map<string, {
    legacy: boolean;
    panelVisualConstraintEvidenceVersion: 1;
    panelVisualConstraintId: string;
    panelVisualConstraintFingerprint: string;
    panelVisualModelFingerprint: string;
    panelVisualReviewRulesFingerprint: string;
  }>;
  warnings: string[];
}

interface FusionStoryboardReferenceSourceEvidence {
  assetId: string;
  path: string;
  sha256: string;
  coveredAssetIds?: string[];
  derivedReferenceAssetId?: string;
  reviewId?: string;
}

interface FusionStoryboardReferenceEvidence {
  path?: string;
  sha256?: string;
  promptSha256?: string;
  sourceAssets: FusionStoryboardReferenceSourceEvidence[];
  issues: string[];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

async function hashFile(filePath: string, cache: Map<string, Promise<string | undefined>>): Promise<string | undefined> {
  const absolutePath = path.resolve(filePath);
  const existing = cache.get(absolutePath);
  if (existing) return existing;
  const pending = readFile(absolutePath)
    .then((content) => createHash("sha256").update(content).digest("hex"))
    .catch(() => undefined);
  cache.set(absolutePath, pending);
  return pending;
}

function contractPath(projectRoot: string, itemId: string, contractId: string): string | undefined {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,199}$/u.test(itemId) || !/^grid-[a-f0-9]{20}$/u.test(contractId)) return undefined;
  return path.join(getSidecarPaths(projectRoot).storyboardGrids, itemId, `${contractId}.json`);
}

async function loadContract(projectRoot: string, itemId: string, contractId: string): Promise<FusionStoryboardGridContract | undefined> {
  const filePath = contractPath(projectRoot, itemId, contractId);
  if (!filePath) return undefined;
  const stored = await readJson<FusionStoryboardGridContract | null>(filePath, null);
  if (!stored
    || stored.schemaVersion !== 1
    || stored.kind !== "fusion-storyboard-grid-contract"
    || stored.contractId !== contractId
    || stored.unit.unitId !== itemId) return undefined;
  return normalizeFusionStoryboardGridContract(stored);
}

function inferredContractId(itemJobs: GenerationJob[]): { contractId?: string; issue?: string } {
  const byContract = new Map<string, GenerationJob[]>();
  for (const job of itemJobs) {
    const contractId = job.fusionStoryboardPanel?.contractId;
    if (!contractId) continue;
    const list = byContract.get(contractId) ?? [];
    list.push(job);
    byContract.set(contractId, list);
  }
  if (!byContract.size) return {};
  const candidates = [...byContract].map(([contractId, jobs]) => ({
    contractId,
    jobs,
    active: jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).length,
    succeededPanels: new Set(jobs.filter((job) => job.status === "succeeded").map((job) => job.fusionStoryboardPanel!.panelId)).size,
    latest: jobs.map((job) => job.updatedAt).sort().at(-1) ?? "",
  }));
  const active = candidates.filter((candidate) => candidate.active > 0);
  if (active.length === 1) return { contractId: active[0]!.contractId };
  if (active.length > 1) {
    return { issue: `存在多个非终态宫格合同：${active.map((candidate) => candidate.contractId).join("、")}` };
  }
  const succeeded = candidates.filter((candidate) => candidate.succeededPanels > 0);
  if (succeeded.length === 1) return { contractId: succeeded[0]!.contractId };
  if (succeeded.length > 1) return { issue: `存在多个有成功产物的历史宫格合同，必须显式选择：${succeeded.map((candidate) => candidate.contractId).join("、")}` };
  return { issue: `没有可由成功任务确定的当前宫格合同：${candidates.map((candidate) => candidate.contractId).join("、")}` };
}

function selectionFor(contract: FusionStoryboardGridContract, selectedBy: FusionStoryboardGridSelection["selectedBy"]): FusionStoryboardGridSelection {
  return {
    contractId: contract.contractId,
    sourceFingerprint: contract.sourceFingerprint,
    productionFingerprint: fusionStoryboardProductionFingerprint(contract),
    sourceStoryboardRevision: contract.sourceStoryboardRevision,
    panelCount: contract.selection.panelCount,
    selectedAt: new Date(0).toISOString(),
    selectedBy,
  };
}

function addBinding(
  bindingsByPath: Map<string, ArtifactBinding>,
  conflictedPaths: Set<string>,
  warnings: string[],
  filePath: string | undefined,
  kind: ArtifactBinding["kind"],
  binding: FusionStoryboardPanelArtifactBinding,
): void {
  if (!filePath) return;
  const absolutePath = path.resolve(filePath);
  if (conflictedPaths.has(absolutePath)) return;
  const previous = bindingsByPath.get(absolutePath);
  if (previous && (previous.kind !== kind || previous.binding.generationJobId !== binding.generationJobId)) {
    bindingsByPath.delete(absolutePath);
    conflictedPaths.add(absolutePath);
    warnings.push(`宫格文件路径被多个任务声明，已失败关闭槽位映射：${absolutePath}`);
    return;
  }
  bindingsByPath.set(absolutePath, { kind, binding });
}

export async function loadFusionStoryboardEvidenceSnapshot(projectRoot: string): Promise<FusionStoryboardEvidenceSnapshot> {
  const sidecar = getSidecarPaths(projectRoot);
  // P3 store 依赖 storyboard-production，而 storyboard-production 也消费本模块。
  // 延迟加载可避免把这条运行时调用链升级成模块初始化环。
  const {
    inspectFusionPanelVisualConstraintCurrentness,
    loadFusionPanelVisualConstraintStore,
  } = await import("./fusion-visual-constraint-store.js");
  const [jobs, selectionStore, publications, config, productionAssets, panelReferenceSnapshot, panelVisualConstraintLoad] = await Promise.all([
    readJson<GenerationJob[]>(sidecar.generationJobs, []),
    readJson<FusionStoryboardGridSelectionStore>(sidecar.storyboardGridSelections, {
      schemaVersion: 1,
      revision: 0,
      items: {},
      updatedAt: new Date(0).toISOString(),
    }),
    readJson<PublicationStore>(sidecar.publications, {
      schemaVersion: 1,
      revision: 0,
      intents: [],
      receipts: [],
      updatedAt: new Date(0).toISOString(),
    }),
    readJson<ProjectConfig | null>(sidecar.config, null),
    readJson<{ assets?: Array<{ definition?: { id?: string }; authority?: { snapshotPath?: string; snapshotSha256?: string } }> } | null>(sidecar.productionAssets, null),
    loadFusionPanelReferenceStoreSnapshot(projectRoot),
    loadFusionPanelVisualConstraintStore(projectRoot)
      .then((store) => ({ store, error: undefined as string | undefined }))
      .catch((error) => ({ store: null, error: error instanceof Error ? error.message : String(error) })),
  ]);
  const panelVisualConstraintStore = panelVisualConstraintLoad.store;
  const panelVisualConstraintsEnabled = Boolean(panelVisualConstraintStore || panelVisualConstraintLoad.error);
  const panelReferenceStore = panelReferenceSnapshot?.store;
  const panelReferenceInputsAligned = !panelReferenceStore
    || gridSelectionSemanticDigest(selectionStore) === panelReferenceStore.inputSnapshot.gridSelectionsSha256;
  const panelJobs = jobs.filter((job) => job.purpose === "fusion_storyboard_panel" && job.fusionStoryboardPanel);
  const warnings: string[] = [];
  if (panelVisualConstraintLoad.error) {
    warnings.push(`P3 视觉约束仓无法读取或与当前合同不一致，Review 已失败关闭：${panelVisualConstraintLoad.error}`);
  }
  let panelVisualConstraintsCurrent = !panelVisualConstraintsEnabled;
  if (panelVisualConstraintStore) {
    try {
      const currentness = await inspectFusionPanelVisualConstraintCurrentness(projectRoot);
      panelVisualConstraintsCurrent = currentness.current
        && currentness.storeRevision === panelVisualConstraintStore.revision
        && currentness.storeFingerprint === panelVisualConstraintStore.storeFingerprint;
      if (!panelVisualConstraintsCurrent) {
        warnings.push(`P3 视觉约束仓输入已漂移（${currentness.driftedInputs.join("、") || "未知输入"}），Review 已失败关闭`);
      }
    } catch (error) {
      panelVisualConstraintsCurrent = false;
      warnings.push(`P3 视觉约束仓无法确认当前性，Review 已失败关闭：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const selections = new Map<string, SelectedFusionStoryboardGrid>();
  const itemIds = new Set([
    ...Object.keys(selectionStore.items),
    ...panelJobs.map((job) => job.itemId),
  ]);
  for (const itemId of itemIds) {
    const explicit = selectionStore.items[itemId];
    const inferred = explicit ? { contractId: explicit.contractId } : inferredContractId(panelJobs.filter((job) => job.itemId === itemId));
    if (inferred.issue) {
      warnings.push(`${itemId} ${inferred.issue}`);
      continue;
    }
    if (!inferred.contractId) continue;
    const contract = await loadContract(projectRoot, itemId, inferred.contractId);
    if (!contract) {
      warnings.push(`${itemId} 当前宫格合同文件缺失或无效：${inferred.contractId}`);
      continue;
    }
    const source = explicit ? "explicit" as const : "inferred" as const;
    const selection = explicit ?? selectionFor(contract, "migration");
    if (selection.sourceFingerprint !== contract.sourceFingerprint
      || selection.productionFingerprint !== contract.productionFingerprint
      || selection.panelCount !== contract.selection.panelCount) {
      warnings.push(`${itemId} 当前宫格选择与合同内容不一致，已失败关闭`);
      continue;
    }
    selections.set(itemId, { selection, contract, source });
  }

  const contractCache = new Map<string, FusionStoryboardGridContract>();
  const bindingsByPath = new Map<string, ArtifactBinding>();
  const conflictedPaths = new Set<string>();
  const fileHashCache = new Map<string, Promise<string | undefined>>();
  const referenceEvidenceByJobId = new Map<string, FusionStoryboardReferenceEvidence>();
  const validPanelJobIds = new Set<string>();
  const confirmedEmptyPanelJobIds = new Set<string>();
  const panelReferenceIdentityByJobId = new Map<string, {
    legacy: boolean;
    panelReferenceEvidenceVersion: 1;
    panelReferenceResolutionId: string;
    panelReferenceResolutionFingerprint: string;
  }>();
  const panelVisualConstraintsByPanelKey = new Map<string, PanelVisualConstraint>(
    Object.entries(panelVisualConstraintStore?.constraints ?? {}),
  );
  const panelVisualConstraintIdentityByJobId = new Map<string, {
    legacy: boolean;
    panelVisualConstraintEvidenceVersion: 1;
    panelVisualConstraintId: string;
    panelVisualConstraintFingerprint: string;
    panelVisualModelFingerprint: string;
    panelVisualReviewRulesFingerprint: string;
  }>();
  const catalogAuthorities = new Map((productionAssets?.assets ?? [])
    .filter((entry) => entry.definition?.id && entry.authority?.snapshotPath)
    .map((entry) => [entry.definition!.id!, { path: entry.authority!.snapshotPath!, sha256: entry.authority!.snapshotSha256 }]));
  const hardLocks = new Map((config?.hardLocks ?? []).map((lock) => [lock.id, lock]));
  for (const job of panelJobs) {
    const panel = job.fusionStoryboardPanel!;
    const cacheKey = `${job.itemId}\0${panel.contractId}`;
    let contract = contractCache.get(cacheKey);
    if (!contract) {
      contract = await loadContract(projectRoot, job.itemId, panel.contractId);
      if (contract) contractCache.set(cacheKey, contract);
    }
    if (!contract
      || contract.sourceFingerprint !== panel.sourceFingerprint
      || contract.selection.panelCount !== panel.panelCount
      || !contract.panels.some((candidate) =>
        candidate.id === panel.panelId
        && candidate.index === panel.panelIndex
        && candidate.frameRole === panel.frameRole
        && candidate.startSeconds === panel.startSeconds
        && candidate.endSeconds === panel.endSeconds)) {
      warnings.push(`${job.id} 的宫格任务身份与合同不一致，未映射到 Artifact`);
      continue;
    }
    const board = job.fusionReferenceBoard;
    let panelVisualConstraintIdentity: {
      legacy: boolean;
      panelVisualConstraintEvidenceVersion: 1;
      panelVisualConstraintId: string;
      panelVisualConstraintFingerprint: string;
      panelVisualModelFingerprint: string;
      panelVisualReviewRulesFingerprint: string;
    } | undefined;
    if (panelVisualConstraintStore) {
      const currentConstraint = panelVisualConstraintsByPanelKey.get(`${panel.contractId}:${panel.panelId}`);
      const legacy = panelVisualConstraintStore.legacyGenerationJobEvidence[job.id];
      let panelVisualIssue: string | undefined;
      if (!panelVisualConstraintsCurrent) {
        panelVisualIssue = "P3 视觉约束仓不是当前版本";
      } else if (!currentConstraint
        || currentConstraint.unitItemId !== job.itemId
        || currentConstraint.gridContractId !== panel.contractId
        || currentConstraint.panelId !== panel.panelId) {
        panelVisualIssue = "P3 当前宫格约束缺失或单元身份不一致";
      } else if (legacy) {
        if (legacy.disposition !== "current-constraint-readonly"
          || legacy.contractId !== panel.contractId
          || legacy.panelId !== panel.panelId
          || legacy.constraintId !== currentConstraint.constraintId
          || legacy.constraintFingerprint !== currentConstraint.fingerprint
          || legacy.modelFingerprint !== currentConstraint.modelFingerprint
          || legacy.reviewRulesFingerprint !== currentConstraint.reviewRulesFingerprint) {
          panelVisualIssue = "历史任务首次 P3 物化冻结的视觉约束身份已失效";
        } else {
          panelVisualConstraintIdentity = {
            legacy: true,
            panelVisualConstraintEvidenceVersion: 1,
            panelVisualConstraintId: legacy.constraintId,
            panelVisualConstraintFingerprint: legacy.constraintFingerprint,
            panelVisualModelFingerprint: legacy.modelFingerprint,
            panelVisualReviewRulesFingerprint: legacy.reviewRulesFingerprint,
          };
        }
      } else if (job.panelVisualConstraintEvidenceVersion !== 1
        || panel.panelVisualConstraintId !== currentConstraint.constraintId
        || panel.panelVisualConstraintFingerprint !== currentConstraint.fingerprint
        || panel.panelVisualModelFingerprint !== currentConstraint.modelFingerprint
        || panel.panelVisualReviewRulesFingerprint !== currentConstraint.reviewRulesFingerprint
        || (board && (board.panelVisualConstraintId !== currentConstraint.constraintId
          || board.panelVisualConstraintFingerprint !== currentConstraint.fingerprint
          || board.panelVisualModelFingerprint !== currentConstraint.modelFingerprint
          || board.panelVisualReviewRulesFingerprint !== currentConstraint.reviewRulesFingerprint))) {
        panelVisualIssue = "P3 任务、参考板与当前视觉约束身份不完整或不一致";
      } else {
        panelVisualConstraintIdentity = {
          legacy: false,
          panelVisualConstraintEvidenceVersion: 1,
          panelVisualConstraintId: currentConstraint.constraintId,
          panelVisualConstraintFingerprint: currentConstraint.fingerprint,
          panelVisualModelFingerprint: currentConstraint.modelFingerprint,
          panelVisualReviewRulesFingerprint: currentConstraint.reviewRulesFingerprint,
        };
      }
      if (panelVisualIssue) {
        warnings.push(`${job.id} ${panelVisualIssue}，未映射到 Artifact 或视觉 Review`);
        referenceEvidenceByJobId.set(job.id, {
          path: board?.path,
          sha256: board?.sha256,
          promptSha256: board?.promptSha256,
          sourceAssets: [],
          issues: [panelVisualIssue],
        });
        continue;
      }
    }
    let panelReferenceIdentity: {
      legacy: boolean;
      panelReferenceEvidenceVersion: 1;
      panelReferenceResolutionId: string;
      panelReferenceResolutionFingerprint: string;
    } | undefined;
    if (panelReferenceSnapshot) {
      const legacy = panelReferenceStore!.legacyGenerationJobIds.includes(job.id);
      const frozenLegacy = panelReferenceStore!.legacyGenerationJobEvidence[job.id];
      const currentResolution = panelReferenceStore!.resolutions[`${panel.contractId}:${panel.panelId}`];
      let panelReferenceIssue: string | undefined;
      if (!panelReferenceInputsAligned) {
        panelReferenceIssue = "证据快照读取到的宫格选择与 P2 引用仓不是同一语义修订";
      } else if (!panelReferenceSnapshot.currentness.current) {
        panelReferenceIssue = `P2 引用仓输入已漂移（${panelReferenceSnapshot.currentness.driftedInputs.join("、") || "未知输入"}）`;
      } else if (legacy) {
        if (!frozenLegacy
          || frozenLegacy.kind !== "current-resolution"
          || !currentResolution
          || frozenLegacy.contractId !== panel.contractId
          || frozenLegacy.panelId !== panel.panelId
          || currentResolution.unitItemId !== job.itemId
          || frozenLegacy.resolutionId !== currentResolution.resolutionId
          || frozenLegacy.resolutionFingerprint !== currentResolution.resolutionFingerprint) {
          panelReferenceIssue = "历史任务首次 P2 物化冻结的 resolution 已失效";
        } else {
          panelReferenceIdentity = {
            legacy: true,
            panelReferenceEvidenceVersion: 1,
            panelReferenceResolutionId: frozenLegacy.resolutionId,
            panelReferenceResolutionFingerprint: frozenLegacy.resolutionFingerprint,
          };
        }
      } else if (job.panelReferenceEvidenceVersion !== 1
        || !currentResolution
        || !panel.panelReferenceResolutionId
        || !panel.panelReferenceResolutionFingerprint
        || (currentResolution.referenceSlots.length > 0 && (!board?.panelReferenceResolutionId || !board.panelReferenceResolutionFingerprint))
        || (board && (board.panelReferenceResolutionId !== panel.panelReferenceResolutionId
          || board.panelReferenceResolutionFingerprint !== panel.panelReferenceResolutionFingerprint))
        || currentResolution.resolutionId !== panel.panelReferenceResolutionId
        || currentResolution.resolutionFingerprint !== panel.panelReferenceResolutionFingerprint
        || currentResolution.unitItemId !== job.itemId) {
        panelReferenceIssue = "P2 任务、参考板与当前 resolution 身份不完整或不一致";
      } else {
        panelReferenceIdentity = {
          legacy: false,
          panelReferenceEvidenceVersion: 1,
          panelReferenceResolutionId: currentResolution.resolutionId,
          panelReferenceResolutionFingerprint: currentResolution.resolutionFingerprint,
        };
      }
      if (panelReferenceIssue) {
        warnings.push(`${job.id} ${panelReferenceIssue}，未映射到 Artifact 或视觉 Review`);
        referenceEvidenceByJobId.set(job.id, {
          path: board?.path,
          sha256: board?.sha256,
          promptSha256: board?.promptSha256,
          sourceAssets: [],
          issues: [panelReferenceIssue],
        });
        continue;
      }
    }
    validPanelJobIds.add(job.id);
    const validResolution = panelReferenceStore?.resolutions[`${panel.contractId}:${panel.panelId}`];
    if (validResolution?.closureStatus === "confirmed-empty" && validResolution.referenceSlots.length === 0) confirmedEmptyPanelJobIds.add(job.id);
    if (panelReferenceIdentity) panelReferenceIdentityByJobId.set(job.id, panelReferenceIdentity);
    if (panelVisualConstraintIdentity) panelVisualConstraintIdentityByJobId.set(job.id, panelVisualConstraintIdentity);
    const binding: FusionStoryboardPanelArtifactBinding = {
      schemaVersion: 1,
      type: "fusion-storyboard-panel",
      contractId: panel.contractId,
      sourceFingerprint: panel.sourceFingerprint,
      productionFingerprint: contract.productionFingerprint,
      panelId: panel.panelId,
      panelIndex: panel.panelIndex,
      panelCount: panel.panelCount,
      frameRole: panel.frameRole,
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
      generationJobId: job.id,
      publicationReceiptId: job.publicationReceiptId,
      ...(panelReferenceIdentity && !panelReferenceIdentity.legacy ? {
        panelReferenceEvidenceVersion: panelReferenceIdentity.panelReferenceEvidenceVersion,
        panelReferenceResolutionId: panelReferenceIdentity.panelReferenceResolutionId,
        panelReferenceResolutionFingerprint: panelReferenceIdentity.panelReferenceResolutionFingerprint,
      } : {}),
      ...(panelVisualConstraintIdentity && !panelVisualConstraintIdentity.legacy ? {
        panelVisualConstraintEvidenceVersion: panelVisualConstraintIdentity.panelVisualConstraintEvidenceVersion,
        panelVisualConstraintId: panelVisualConstraintIdentity.panelVisualConstraintId,
        panelVisualConstraintFingerprint: panelVisualConstraintIdentity.panelVisualConstraintFingerprint,
        panelVisualModelFingerprint: panelVisualConstraintIdentity.panelVisualModelFingerprint,
        panelVisualReviewRulesFingerprint: panelVisualConstraintIdentity.panelVisualReviewRulesFingerprint,
      } : {}),
    };
    addBinding(bindingsByPath, conflictedPaths, warnings, job.expectedOutputPath, "raw-image", binding);
    addBinding(bindingsByPath, conflictedPaths, warnings, job.resultPath, "raw-image", binding);
    addBinding(bindingsByPath, conflictedPaths, warnings, job.expectedCompanionPath, "labeled-image", binding);
    addBinding(bindingsByPath, conflictedPaths, warnings, job.companionPath, "labeled-image", binding);

    const referenceIssues: string[] = [];
    const sourceAssets: FusionStoryboardReferenceSourceEvidence[] = [];
    if (!board) {
      if (!confirmedEmptyPanelJobIds.has(job.id)) referenceIssues.push("GenerationJob 缺少冻结参考板");
    } else {
      const currentBoardSha = await hashFile(board.path, fileHashCache);
      if (!currentBoardSha || currentBoardSha !== board.sha256) referenceIssues.push("冻结参考板文件缺失或 SHA 漂移");
      const metadata = await readJson<{
        promptSha256?: string;
        assetIds?: string[];
        sources?: Array<{
          assetId?: string;
          path?: string;
          sha256?: string;
          coveredAssetIds?: string[];
          derivedReferenceAssetId?: string;
          reviewId?: string;
        }>;
      } | null>(board.metadataPath, null);
      if (!metadata) {
        referenceIssues.push("冻结参考板 metadata 缺失或损坏");
      } else {
        if (metadata.promptSha256 !== board.promptSha256) referenceIssues.push("参考板 prompt SHA 与任务不一致");
        const metadataAssetIds = [...new Set(metadata.sources?.flatMap((source) => source.coveredAssetIds?.length
          ? source.coveredAssetIds
          : source.assetId ? [source.assetId] : []) ?? metadata.assetIds ?? [])].sort();
        if (JSON.stringify(metadataAssetIds) !== JSON.stringify([...board.sourceAssetIds].sort())) referenceIssues.push("参考板资产 ID 与任务冻结集合不一致");
        for (const source of metadata.sources ?? []) {
          if (!source.assetId || !source.path || !source.sha256) {
            referenceIssues.push("参考板 source 证据字段不完整");
            continue;
          }
          const actualSha = await hashFile(source.path, fileHashCache);
          if (!actualSha || actualSha !== source.sha256) referenceIssues.push(`${source.assetId} 参考源文件缺失或 SHA 漂移`);
          const coveredAssetIds = [...new Set(source.coveredAssetIds?.length ? source.coveredAssetIds : [source.assetId])].sort();
          if (source.derivedReferenceAssetId) {
            const derived = panelReferenceStore?.derivedAssets[source.derivedReferenceAssetId];
            const visual = derived?.visualArtifact;
            const resolution = panelReferenceStore?.resolutions[`${panel.contractId}:${panel.panelId}`];
            const derivedSlot = resolution?.referenceSlots.find((slot) => slot.derivedAssetId === source.derivedReferenceAssetId);
            if (!derived
              || derived.status !== "visual-ready"
              || !visual
              || !derivedSlot
              || derivedSlot.path !== source.path
              || derivedSlot.sha256 !== source.sha256
              || source.assetId !== derived.id
              || JSON.stringify(coveredAssetIds) !== JSON.stringify([...derived.memberAssetIds].sort())
              || path.resolve(visual.path) !== path.resolve(source.path)
              || visual.sha256 !== source.sha256
              || visual.reviewId !== source.reviewId) {
              referenceIssues.push(`${source.assetId} 派生组合定义、成员、视觉 Review 或冻结版本不一致`);
            }
          } else {
            if (coveredAssetIds.length !== 1 || coveredAssetIds[0] !== source.assetId) referenceIssues.push(`${source.assetId} 直接参考槽覆盖集合异常`);
            const resolution = panelReferenceStore?.resolutions[`${panel.contractId}:${panel.panelId}`];
            const canonicalSlot = resolution?.referenceSlots.find((slot) => slot.kind === "canonical-asset" && slot.assetId === source.assetId);
            if (panelReferenceStore) {
              if (!canonicalSlot?.path
                || canonicalSlot.path !== source.path
                || canonicalSlot.sha256 !== source.sha256
                || canonicalSlot.readiness !== "ready") {
                referenceIssues.push(`${source.assetId} 当前 P2 canonical slot 与参考板冻结版本不一致`);
              }
            } else {
              const catalogAuthority = catalogAuthorities.get(source.assetId);
              const hardLock = hardLocks.get(source.assetId);
              const currentAuthorityPath = catalogAuthority?.path ?? hardLock?.path;
              const currentAuthorityExpectedSha = catalogAuthority?.sha256;
              if (!currentAuthorityPath) {
                referenceIssues.push(`${source.assetId} 当前没有显式权威或硬锁`);
              } else {
                const currentAuthoritySha = await hashFile(currentAuthorityPath, fileHashCache);
                if (path.resolve(currentAuthorityPath) !== path.resolve(source.path)
                  || !currentAuthoritySha
                  || currentAuthoritySha !== source.sha256
                  || (currentAuthorityExpectedSha && currentAuthorityExpectedSha !== currentAuthoritySha)) {
                  referenceIssues.push(`${source.assetId} 当前权威版本与参考板冻结版本不一致`);
                }
              }
            }
          }
          sourceAssets.push({
            assetId: source.assetId,
            path: path.resolve(source.path),
            sha256: source.sha256,
            coveredAssetIds,
            derivedReferenceAssetId: source.derivedReferenceAssetId,
            reviewId: source.reviewId,
          });
        }
      }
    }
    referenceEvidenceByJobId.set(job.id, {
      path: board?.path,
      sha256: board?.sha256,
      promptSha256: board?.promptSha256,
      sourceAssets: sourceAssets.sort((left, right) => left.assetId.localeCompare(right.assetId)),
      issues: [...new Set(referenceIssues)],
    });
  }
  return {
    jobs,
    receiptsById: new Map(publications.receipts.map((receipt) => [receipt.id, receipt])),
    selections,
    bindingsByPath,
    referenceEvidenceByJobId,
    validPanelJobIds,
    confirmedEmptyPanelJobIds,
    panelReferenceIdentityByJobId,
    panelVisualConstraintsEnabled,
    panelVisualConstraintsCurrent,
    panelVisualConstraintsByPanelKey,
    panelVisualConstraintIdentityByJobId,
    warnings,
  };
}

export function artifactAuthorityKey(artifact: Pick<Artifact, "kind" | "variant" | "fusionStoryboardPanel" | "fusionStoryboardSheet">): string {
  const panel = artifact.fusionStoryboardPanel;
  const sheet = artifact.fusionStoryboardSheet;
  if (sheet) return `${artifact.kind}:fusion-sheet:${sheet.role}:${sheet.pageIndex ?? 0}`;
  return panel
    ? `${artifact.kind}:fusion-panel:${panel.contractId}:${panel.sourceFingerprint}:${panel.panelId}`
    : `${artifact.kind}:${artifact.variant}`;
}

export function currentFusionStoryboardArtifact(artifact: Artifact, snapshot: FusionStoryboardEvidenceSnapshot): boolean {
  const panel = artifact.fusionStoryboardPanel;
  if (!panel) return true;
  const selected = snapshot.selections.get(artifact.itemId);
  const identity = snapshot.panelReferenceIdentityByJobId.get(panel.generationJobId);
  const visualIdentity = snapshot.panelVisualConstraintIdentityByJobId.get(panel.generationJobId);
  return Boolean(selected
    && snapshot.validPanelJobIds.has(panel.generationJobId)
    && selected.selection.contractId === panel.contractId
    && selected.selection.sourceFingerprint === panel.sourceFingerprint
    && selected.selection.productionFingerprint === panel.productionFingerprint
    && (!identity || identity.legacy || (panel.panelReferenceEvidenceVersion === identity.panelReferenceEvidenceVersion
      && panel.panelReferenceResolutionId === identity.panelReferenceResolutionId
      && panel.panelReferenceResolutionFingerprint === identity.panelReferenceResolutionFingerprint))
    && (!snapshot.panelVisualConstraintsEnabled
      || (visualIdentity && (visualIdentity.legacy || (panel.panelVisualConstraintEvidenceVersion === visualIdentity.panelVisualConstraintEvidenceVersion
        && panel.panelVisualConstraintId === visualIdentity.panelVisualConstraintId
        && panel.panelVisualConstraintFingerprint === visualIdentity.panelVisualConstraintFingerprint
        && panel.panelVisualModelFingerprint === visualIdentity.panelVisualModelFingerprint
        && panel.panelVisualReviewRulesFingerprint === visualIdentity.panelVisualReviewRulesFingerprint)))));
}

function relevantJobs(snapshot: FusionStoryboardEvidenceSnapshot, itemId: string, contractId: string, panelId: string): GenerationJob[] {
  return snapshot.jobs
    .filter((job) => job.itemId === itemId
      && snapshot.validPanelJobIds.has(job.id)
      && job.purpose === "fusion_storyboard_panel"
      && job.fusionStoryboardPanel?.contractId === contractId
      && job.fusionStoryboardPanel?.panelId === panelId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function panelArtifacts(
  artifacts: Artifact[],
  contractId: string,
  sourceFingerprint: string,
  panelId: string,
): { raw?: Artifact; labeled?: Artifact } {
  const slot = artifacts.filter((artifact) =>
    artifact.authoritative
    && !artifact.deprecated
    && artifact.fusionStoryboardPanel?.contractId === contractId
    && artifact.fusionStoryboardPanel.sourceFingerprint === sourceFingerprint
    && artifact.fusionStoryboardPanel.panelId === panelId);
  return {
    raw: slot.find((artifact) => artifact.kind === "raw-image"),
    labeled: slot.find((artifact) => artifact.kind === "labeled-image"),
  };
}

function publicationIssues(
  itemId: string,
  job: GenerationJob | undefined,
  raw: Artifact | undefined,
  receipt: PublicationReceipt | undefined,
  labeled?: Artifact,
  companionReceipt?: PublicationReceipt,
): string[] {
  if (!job) return ["缺少绑定当前槽位的 GenerationJob", ...(raw ? [] : ["缺少当前槽位 raw"])];
  const issues: string[] = [];
  if (job.status !== "succeeded") issues.push(`GenerationJob 尚未成功：${job.status}`);
  if (!raw) return [...issues, "缺少当前槽位 raw"];
  if (!job.resultPath || path.resolve(job.resultPath) !== path.resolve(raw.path) || path.resolve(job.expectedOutputPath) !== path.resolve(raw.path)) {
    issues.push("raw 路径与 GenerationJob 预留/结果路径不一致");
  }
  if (!job.resultSha256 || job.resultSha256 !== raw.check.sha256) issues.push("raw SHA 与 GenerationJob 结果 SHA 不一致");
  if (!job.publicationReceiptId || !receipt) return [...issues, "缺少 raw Publication 回执"];
  if (receipt.context.purpose !== "generation-output"
    || receipt.context.itemId !== itemId
    || receipt.context.jobId !== job.id
    || path.resolve(receipt.targetPath) !== path.resolve(raw.path)
    || receipt.kind !== "raw-image"
    || receipt.check.sha256 !== raw.check.sha256) {
    issues.push("raw Publication 回执与当前任务、路径或 SHA 不一致");
  }
  if (job.publicationBundleId) {
    if (receipt.bundleId !== job.publicationBundleId || receipt.bundleMember !== "primary") issues.push("raw 回执未绑定 GenerationJob 的 primary bundle 身份");
    if (!job.companionPublicationReceiptId || !companionReceipt) issues.push("缺少 labeled Publication bundle 回执");
    else if (!labeled
      || companionReceipt.bundleId !== job.publicationBundleId
      || companionReceipt.bundleMember !== "companion"
      || companionReceipt.kind !== "labeled-image"
      || companionReceipt.context.jobId !== job.id
      || path.resolve(companionReceipt.targetPath) !== path.resolve(labeled.path)
      || companionReceipt.check.sha256 !== labeled.check.sha256) {
      issues.push("labeled Publication 回执与当前任务、bundle、路径或 SHA 不一致");
    }
  }
  const panel = job.fusionStoryboardPanel!;
  const metadata = receipt.context.metadata;
  if (metadata?.panelId !== undefined && metadata.panelId !== panel.panelId) issues.push("Publication panelId 与任务不一致");
  if (metadata?.contractId !== undefined && metadata.contractId !== panel.contractId) issues.push("Publication contractId 与任务不一致");
  if (metadata?.sourceFingerprint !== undefined && metadata.sourceFingerprint !== panel.sourceFingerprint) issues.push("Publication sourceFingerprint 与任务不一致");
  if (metadata?.panelIndex !== undefined && metadata.panelIndex !== panel.panelIndex) issues.push("Publication panelIndex 与任务不一致");
  if (job.panelReferenceEvidenceVersion === 1) {
    if (metadata?.panelReferenceResolutionId !== panel.panelReferenceResolutionId
      || metadata?.panelReferenceResolutionFingerprint !== panel.panelReferenceResolutionFingerprint) {
      issues.push("Publication 的 P2 resolution 身份与任务不一致");
    }
  }
  return issues;
}

function selectedJobForArtifacts(
  snapshot: FusionStoryboardEvidenceSnapshot,
  itemId: string,
  contractId: string,
  panelId: string,
  raw?: Artifact,
  labeled?: Artifact,
): GenerationJob | undefined {
  const jobId = raw?.fusionStoryboardPanel?.generationJobId ?? labeled?.fusionStoryboardPanel?.generationJobId;
  if (raw?.fusionStoryboardPanel?.generationJobId
    && labeled?.fusionStoryboardPanel?.generationJobId
    && raw.fusionStoryboardPanel.generationJobId !== labeled.fusionStoryboardPanel.generationJobId) return undefined;
  return jobId
    ? snapshot.jobs.find((job) => job.id === jobId)
    : relevantJobs(snapshot, itemId, contractId, panelId)[0];
}

export function buildFusionStoryboardProgress(
  itemId: string,
  artifacts: Artifact[],
  snapshot: FusionStoryboardEvidenceSnapshot,
): FusionStoryboardProgress | undefined {
  const selected = snapshot.selections.get(itemId);
  if (!selected) return undefined;
  const panels: FusionStoryboardPanelProgress[] = selected.contract.panels.map((panel) => {
    let { raw, labeled } = panelArtifacts(artifacts.filter((artifact) => currentFusionStoryboardArtifact(artifact, snapshot)), selected.contract.contractId, selected.contract.sourceFingerprint, panel.id);
    const jobs = relevantJobs(snapshot, itemId, selected.contract.contractId, panel.id);
    const activeJob = jobs.find((job) => ACTIVE_JOB_STATUSES.has(job.status));
    const boundJobId = raw?.fusionStoryboardPanel?.generationJobId ?? labeled?.fusionStoryboardPanel?.generationJobId;
    if (activeJob && activeJob.id !== boundJobId) {
      raw = undefined;
      labeled = undefined;
    }
    const job = activeJob ?? selectedJobForArtifacts(snapshot, itemId, selected.contract.contractId, panel.id, raw, labeled);
    const receipt = job?.publicationReceiptId ? snapshot.receiptsById.get(job.publicationReceiptId) : undefined;
    const companionReceipt = job?.companionPublicationReceiptId ? snapshot.receiptsById.get(job.companionPublicationReceiptId) : undefined;
    const issues = publicationIssues(itemId, job, raw, receipt, labeled, companionReceipt);
    issues.push(...(job ? snapshot.referenceEvidenceByJobId.get(job.id)?.issues ?? ["缺少参考板证据快照"] : []));
    if (!labeled) issues.push("缺少当前槽位 labeled");
    if (raw && !raw.check.ok) issues.push(`raw 机械验收失败：${raw.check.issues.join("；") || "未知原因"}`);
    if (labeled && !labeled.check.ok) issues.push(`labeled 机械验收失败：${labeled.check.issues.join("；") || "未知原因"}`);
    if (labeled && job?.expectedCompanionPath && path.resolve(labeled.path) !== path.resolve(job.expectedCompanionPath)) {
      issues.push("labeled 路径与 GenerationJob companion 预期不一致");
    }
    if (labeled && job?.status === "succeeded" && (!job.companionPath || path.resolve(labeled.path) !== path.resolve(job.companionPath))) {
      issues.push("labeled 路径与 GenerationJob 已登记 companion 不一致");
    }
    const mechanicallyValid = Boolean(raw?.check.ok && labeled?.check.ok);
    let state: FusionStoryboardPanelProgress["state"] = "missing";
    if (!raw && job && ACTIVE_JOB_STATUSES.has(job.status)) {
      state = job.status === "queued"
        ? "queued"
        : job.status === "generation_unknown"
          ? "generation_unknown"
          : job.status === "candidate_generated"
            ? "candidate_review"
            : "generating";
      if (job.status === "generation_unknown") issues.push("供应商调用结果不明；禁止重试，必须先完成结构化对账");
      if (job.status === "candidate_generated") issues.push("隔离候选已生成；必须先完成主代理视觉验收，尚未发布 raw/labeled");
    } else if (!raw && job?.status === "visual_rejected") {
      state = "visual_rejected";
      issues.push(job.error ? `候选视觉返工：${job.error}` : "候选视觉返工；隔离证据已保留");
    } else if (raw || labeled) {
      state = mechanicallyValid ? (issues.length ? "produced" : "awaiting_review") : "mechanical_failed";
    }
    return {
      panelId: panel.id,
      panelIndex: panel.index,
      panelCount: selected.contract.selection.panelCount,
      frameRole: panel.frameRole,
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
      state,
      generationJobId: job?.id,
      generationStatus: job?.status,
      publicationReceiptId: job?.publicationReceiptId,
      rawArtifactId: raw?.id,
      labeledArtifactId: labeled?.id,
      issues: [...new Set(issues)],
    };
  });
  return {
    contractId: selected.contract.contractId,
    sourceFingerprint: selected.contract.sourceFingerprint,
    productionFingerprint: selected.contract.productionFingerprint,
    sourceStoryboardRevision: selected.contract.sourceStoryboardRevision,
    panelCount: selected.contract.selection.panelCount,
    completedPanelCount: panels.filter((panel) => panel.rawArtifactId && panel.labeledArtifactId).length,
    mechanicallyValidPanelCount: panels.filter((panel) => {
      const raw = artifacts.find((artifact) => artifact.id === panel.rawArtifactId);
      const labeled = artifacts.find((artifact) => artifact.id === panel.labeledArtifactId);
      return raw?.check.ok && labeled?.check.ok;
    }).length,
    visuallyApproved: false,
    selectionSource: selected.source,
    panels,
    issues: panels.flatMap((panel) => panel.issues.map((issue) => `宫格${String(panel.panelIndex).padStart(2, "0")}：${issue}`)),
  };
}

export function fusionStoryboardRequiredArtifacts(item: WorkItem, artifacts: Artifact[]): Artifact[] {
  if (!item.fusionStoryboard) return [];
  return item.fusionStoryboard.panels.flatMap((panel) => [
    artifacts.find((artifact) => artifact.id === panel.rawArtifactId),
    artifacts.find((artifact) => artifact.id === panel.labeledArtifactId),
  ]).filter((artifact): artifact is Artifact => Boolean(artifact));
}

export function buildFusionStoryboardReviewRequirement(
  item: WorkItem,
  artifacts: Artifact[],
  snapshot: FusionStoryboardEvidenceSnapshot,
): FusionStoryboardReviewRequirement | undefined {
  const progress = item.fusionStoryboard;
  if (!progress) return undefined;
  const panels = progress.panels.map((panel) => {
    const raw = artifacts.find((artifact) => artifact.id === panel.rawArtifactId);
    const labeled = artifacts.find((artifact) => artifact.id === panel.labeledArtifactId);
    const issues = [...panel.issues];
    if (raw && !raw.check.sha256) issues.push("raw 缺少 SHA-256");
    if (labeled && !labeled.check.sha256) issues.push("labeled 缺少 SHA-256");
    const frozenPanelReferenceIdentity = panel.generationJobId ? snapshot.panelReferenceIdentityByJobId.get(panel.generationJobId) : undefined;
    const panelReferenceIdentity = frozenPanelReferenceIdentity && !frozenPanelReferenceIdentity.legacy ? {
      panelReferenceEvidenceVersion: frozenPanelReferenceIdentity.panelReferenceEvidenceVersion,
      panelReferenceResolutionId: frozenPanelReferenceIdentity.panelReferenceResolutionId,
      panelReferenceResolutionFingerprint: frozenPanelReferenceIdentity.panelReferenceResolutionFingerprint,
    } : undefined;
    if (panel.generationJobId && !snapshot.validPanelJobIds.has(panel.generationJobId)) issues.push("GenerationJob 的 P2 resolution 证据不是当前版本");
    const constraint = snapshot.panelVisualConstraintsByPanelKey.get(`${progress.contractId}:${panel.panelId}`);
    const frozenPanelVisualIdentity = panel.generationJobId
      ? snapshot.panelVisualConstraintIdentityByJobId.get(panel.generationJobId)
      : undefined;
    let panelVisualIdentity: {
      panelVisualConstraintEvidenceVersion: 1;
      panelVisualConstraintId: string;
      panelVisualConstraintFingerprint: string;
      panelVisualModelFingerprint: string;
      panelVisualReviewRulesFingerprint: string;
      visualReviewRules: NonNullable<FusionStoryboardReviewRequirement["panels"][number]["visualReviewRules"]>;
      visualWarnings: NonNullable<FusionStoryboardReviewRequirement["panels"][number]["visualWarnings"]>;
    } | undefined;
    if (snapshot.panelVisualConstraintsEnabled) {
      if (!snapshot.panelVisualConstraintsCurrent) issues.push("P3 视觉约束仓不是当前版本");
      if (!constraint) {
        issues.push("当前宫格缺少 P3 PanelVisualConstraint");
      } else if (!frozenPanelVisualIdentity
        || frozenPanelVisualIdentity.panelVisualConstraintId !== constraint.constraintId
        || frozenPanelVisualIdentity.panelVisualConstraintFingerprint !== constraint.fingerprint
        || frozenPanelVisualIdentity.panelVisualModelFingerprint !== constraint.modelFingerprint
        || frozenPanelVisualIdentity.panelVisualReviewRulesFingerprint !== constraint.reviewRulesFingerprint) {
        issues.push("GenerationJob 的 P3 PanelVisualConstraint 证据不是当前版本");
      } else {
        panelVisualIdentity = {
          panelVisualConstraintEvidenceVersion: 1,
          panelVisualConstraintId: constraint.constraintId,
          panelVisualConstraintFingerprint: constraint.fingerprint,
          panelVisualModelFingerprint: constraint.modelFingerprint,
          panelVisualReviewRulesFingerprint: constraint.reviewRulesFingerprint,
          visualReviewRules: constraint.reviewRules.map((rule) => ({
            id: rule.id,
            code: rule.code,
            enforcement: rule.enforcement,
            instruction: rule.instruction,
            evidenceAssetIds: [...rule.evidenceAssetIds],
          })),
          visualWarnings: constraint.warnings.map((warning) => ({
            code: warning.code,
            severity: warning.severity,
            detection: warning.detection,
            message: warning.message,
            evidenceAssetIds: [...warning.evidenceAssetIds],
          })),
        };
      }
    }
    return {
      panelId: panel.panelId,
      panelIndex: panel.panelIndex,
      panelCount: panel.panelCount,
      frameRole: panel.frameRole,
      generationJobId: panel.generationJobId,
      publicationReceiptId: panel.publicationReceiptId,
      ...panelReferenceIdentity,
      ...panelVisualIdentity,
      referenceBoard: (() => {
        const evidence = panel.generationJobId ? snapshot.referenceEvidenceByJobId.get(panel.generationJobId) : undefined;
        return evidence?.path && evidence.sha256 && evidence.promptSha256
          ? { path: evidence.path, sha256: evidence.sha256, promptSha256: evidence.promptSha256, sourceAssets: evidence.sourceAssets }
          : undefined;
      })(),
      raw: raw?.check.sha256 ? { artifactId: raw.id, path: raw.path, sha256: raw.check.sha256 } : undefined,
      labeled: labeled?.check.sha256 ? { artifactId: labeled.id, path: labeled.path, sha256: labeled.check.sha256 } : undefined,
      issues: [...new Set(issues)],
    };
  });
  const artifactIds = panels.flatMap((panel) => [panel.raw?.artifactId, panel.labeled?.artifactId]).filter((value): value is string => Boolean(value));
  const artifactHashes = Object.fromEntries(panels.flatMap((panel) => [panel.raw, panel.labeled])
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .map((artifact) => [artifact.artifactId, artifact.sha256]));
  const issues = panels.flatMap((panel) => panel.issues.map((issue) => `宫格${String(panel.panelIndex).padStart(2, "0")}：${issue}`));
  const complete = panels.length === progress.panelCount
    && panels.every((panel) => panel.raw
      && panel.labeled
      && panel.generationJobId
      && panel.publicationReceiptId
      && (panel.referenceBoard || snapshot.confirmedEmptyPanelJobIds.has(panel.generationJobId))
      && (!snapshot.panelVisualConstraintsEnabled || (panel.panelVisualConstraintEvidenceVersion === 1
        && panel.panelVisualConstraintId
        && panel.panelVisualConstraintFingerprint
        && panel.panelVisualModelFingerprint
        && panel.panelVisualReviewRulesFingerprint
        && Boolean(panel.visualReviewRules?.length && panel.visualWarnings?.length)))
      && panel.issues.length === 0)
    && artifactIds.length === progress.panelCount * 2;
  const payload = {
    itemId: item.id,
    contractId: progress.contractId,
    sourceFingerprint: progress.sourceFingerprint,
    productionFingerprint: progress.productionFingerprint,
    panelCount: progress.panelCount,
    panels: panels.map((panel) => ({
      panelId: panel.panelId,
      panelIndex: panel.panelIndex,
      panelCount: panel.panelCount,
      frameRole: panel.frameRole,
      generationJobId: panel.generationJobId,
      publicationReceiptId: panel.publicationReceiptId,
      panelReferenceEvidenceVersion: panel.panelReferenceEvidenceVersion,
      panelReferenceResolutionId: panel.panelReferenceResolutionId,
      panelReferenceResolutionFingerprint: panel.panelReferenceResolutionFingerprint,
      panelVisualConstraintEvidenceVersion: panel.panelVisualConstraintEvidenceVersion,
      panelVisualConstraintId: panel.panelVisualConstraintId,
      panelVisualConstraintFingerprint: panel.panelVisualConstraintFingerprint,
      panelVisualModelFingerprint: panel.panelVisualModelFingerprint,
      panelVisualReviewRulesFingerprint: panel.panelVisualReviewRulesFingerprint,
      visualReviewRules: panel.visualReviewRules,
      visualWarnings: panel.visualWarnings,
      referenceBoard: panel.referenceBoard,
      raw: panel.raw,
      labeled: panel.labeled,
    })),
  };
  return {
    schemaVersion: 1,
    kind: "fusion-storyboard-grid-images",
    id: `fusion-review-${sha256(payload)}`,
    itemId: item.id,
    reviewType: "image",
    contractId: progress.contractId,
    sourceFingerprint: progress.sourceFingerprint,
    productionFingerprint: progress.productionFingerprint,
    panelCount: progress.panelCount,
    complete,
    artifactIds,
    artifactHashes,
    panels,
    issues: [...new Set(issues)],
  };
}
