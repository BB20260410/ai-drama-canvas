import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  buildFusionStoryboardReviewRequirement,
  loadFusionStoryboardEvidenceSnapshot,
} from "./fusion-storyboard-evidence.js";
import { selectFusionStoryboardGridContracts } from "./fusion-storyboard-production.js";
import { artifactReviewEvidence, reviewCoversFusionStoryboardRequirement } from "./review-evidence.js";
import { scanAndPersist, updateStatus } from "./service.js";
import { appendEvent, getSidecarPaths, readJson, writeJsonAtomic } from "./sidecar.js";
import type { Artifact, ReviewRecord, ReviewStore } from "./types.js";
import { withProjectLock } from "./locks.js";
import { loadFusionPanelReferenceStore, materializeFusionPanelReferenceResolutions } from "./fusion-panel-references.js";

export interface FusionStoryboardEvidenceMigrationItem {
  itemId: string;
  contractId?: string;
  panelCount?: number;
  completedPanelCount?: number;
  mechanicallyValidPanelCount?: number;
  missingPanelIndexes: number[];
  selection: "persisted" | "already_explicit" | "unavailable";
  review: "migrated" | "already_current" | "incomplete" | "legacy_review_unavailable";
  reviewId?: string;
  migratedFromReviewId?: string;
  issues: string[];
}

export interface FusionStoryboardEvidenceMigrationResult {
  schemaVersion: 1;
  projectRoot: string;
  items: FusionStoryboardEvidenceMigrationItem[];
  migratedSelections: number;
  migratedReviews: number;
  scannedAt: string;
}

function legacyEvidenceMatches(record: ReviewRecord, required: Artifact[]): boolean {
  if (record.decision !== "pass" || record.reviewType !== "image" || !record.artifactEvidence?.length) return false;
  const expectedIds = required.map((artifact) => artifact.id).sort();
  if (JSON.stringify([...record.artifactIds].sort()) !== JSON.stringify(expectedIds)) return false;
  return required.every((artifact) => {
    const evidence = record.artifactEvidence?.find((candidate) => candidate.artifactId === artifact.id);
    return Boolean(
      evidence
      && evidence.rootSlot === artifact.rootSlot
      && evidence.relativePath === artifact.relativePath
      && evidence.kind === artifact.kind
      && evidence.variant === artifact.variant
      && evidence.size === artifact.check.size
      && evidence.sha256 === artifact.check.sha256,
    );
  });
}

export async function migrateFusionStoryboardEvidence(
  projectRoot: string,
  options: { itemIds?: string[] } = {},
): Promise<FusionStoryboardEvidenceMigrationResult> {
  return withProjectLock(projectRoot, "reviews", async () => {
    const initial = await loadFusionStoryboardEvidenceSnapshot(projectRoot);
    const scope = options.itemIds?.length ? new Set(options.itemIds) : undefined;
    const inferred = [...initial.selections.entries()]
      .filter(([itemId, selected]) => selected.source === "inferred" && (!scope || scope.has(itemId)));
    if (inferred.length) {
      await selectFusionStoryboardGridContracts(projectRoot, inferred.map(([, selected]) => selected.contract), "migration");
      // P2 已启用的工程若丢失 current selection，先恢复选择，再按新语义修订
      // 重物化引用仓；否则后续扫描会正确地把旧 P2 仓判 stale，却无法迁移 Review。
      if (await loadFusionPanelReferenceStore(projectRoot)) await materializeFusionPanelReferenceResolutions(projectRoot);
    }
    const selectedSnapshot = await loadFusionStoryboardEvidenceSnapshot(projectRoot);
    const selectedEntries = [...selectedSnapshot.selections.entries()]
      .filter(([itemId]) => !scope || scope.has(itemId));
    const includeHashPaths = selectedEntries.flatMap(([itemId, selected]) => selectedSnapshot.jobs
      .filter((job) => job.itemId === itemId
        && job.purpose === "fusion_storyboard_panel"
        && job.fusionStoryboardPanel?.contractId === selected.contract.contractId)
      .flatMap((job) => [job.resultPath, job.expectedOutputPath, job.companionPath, job.expectedCompanionPath])
      .filter((candidate): candidate is string => Boolean(candidate))
      .map((candidate) => path.resolve(candidate)));
    const index = await scanAndPersist(projectRoot, { includeHashPaths });
    const snapshot = await loadFusionStoryboardEvidenceSnapshot(projectRoot);
    const store = await readJson<ReviewStore>(getSidecarPaths(projectRoot).reviews, { schemaVersion: 1, records: [] });
    const results: FusionStoryboardEvidenceMigrationItem[] = [];
    let storeChanged = false;
    let migratedReviews = 0;

    for (const [itemId, selected] of [...snapshot.selections.entries()].filter(([candidate]) => !scope || scope.has(candidate))) {
      const item = index.items.find((candidate) => candidate.id === itemId);
      const artifacts = index.artifacts.filter((artifact) => artifact.itemId === itemId);
      if (!item?.fusionStoryboard) {
        results.push({
          itemId,
          contractId: selected.contract.contractId,
          panelCount: selected.contract.selection.panelCount,
          missingPanelIndexes: selected.contract.panels.map((panel) => panel.index),
          selection: selected.source === "explicit" ? "already_explicit" : "unavailable",
          review: "incomplete",
          issues: ["扫描索引没有建立宫格进度"],
        });
        continue;
      }
      const requirement = buildFusionStoryboardReviewRequirement(item, artifacts, snapshot);
      const missingPanelIndexes = item.fusionStoryboard.panels
        .filter((panel) => !panel.rawArtifactId || !panel.labeledArtifactId)
        .map((panel) => panel.panelIndex);
      const base: Omit<FusionStoryboardEvidenceMigrationItem, "review"> = {
        itemId,
        contractId: item.fusionStoryboard.contractId,
        panelCount: item.fusionStoryboard.panelCount,
        completedPanelCount: item.fusionStoryboard.completedPanelCount,
        mechanicallyValidPanelCount: item.fusionStoryboard.mechanicallyValidPanelCount,
        missingPanelIndexes,
        selection: inferred.some(([candidate]) => candidate === itemId) ? "persisted" : "already_explicit",
        issues: requirement?.issues ?? ["未形成宫格 Review requirement"],
      };
      if (!requirement?.complete) {
        results.push({ ...base, review: "incomplete" });
        continue;
      }
      const existing = store.records
        .filter((record) => record.itemId === itemId && record.reviewType === "image" && record.decision === "pass")
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .find((record) => reviewCoversFusionStoryboardRequirement(record, requirement, artifacts));
      if (existing) {
        results.push({ ...base, review: "already_current", reviewId: existing.id, issues: [] });
        continue;
      }
      const required = requirement.artifactIds
        .map((artifactId) => artifacts.find((artifact) => artifact.id === artifactId))
        .filter((artifact): artifact is Artifact => Boolean(artifact));
      const latestImageRecord = store.records
        .filter((record) => record.itemId === itemId && record.reviewType === "image")
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      const legacy = latestImageRecord?.decision === "pass" && legacyEvidenceMatches(latestImageRecord, required)
        ? latestImageRecord
        : undefined;
      if (!legacy) {
        results.push({ ...base, review: "legacy_review_unavailable", issues: ["没有精确覆盖当前全部宫格文件与 SHA 的旧 Review"] });
        continue;
      }
      const migrated: ReviewRecord = {
        ...legacy,
        id: `review-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
        sourceScanId: index.scanId,
        artifactIds: [...requirement.artifactIds],
        artifactEvidence: required.map(artifactReviewEvidence),
        requirementId: requirement.id,
        requirement,
        migratedFromReviewId: legacy.id,
        note: [legacy.note, `P0 宫格槽位迁移：从 ${legacy.id} 派生，旧记录保持不可变。`].filter(Boolean).join("\n"),
        reviewer: "codex",
        resultingStatus: "待视频",
        createdAt: new Date().toISOString(),
      };
      store.records.push(migrated);
      storeChanged = true;
      migratedReviews += 1;
      results.push({
        ...base,
        review: "migrated",
        reviewId: migrated.id,
        migratedFromReviewId: legacy.id,
        issues: [],
      });
    }

    if (storeChanged) await writeJsonAtomic(getSidecarPaths(projectRoot).reviews, store);
    for (const result of results.filter((entry) => entry.review === "migrated" || entry.review === "already_current")) {
      const record = store.records.find((candidate) => candidate.id === result.reviewId);
      if (!record?.requirementId) continue;
      await updateStatus(projectRoot, result.itemId, "待视频", "P0 宫格全部槽位视觉证据已迁移并重新绑定", undefined, "codex", "review", record.id, "image", record.requirementId);
    }
    await appendEvent(projectRoot, {
      actor: "codex",
      type: "fusion_storyboard.evidence_migrated",
      data: {
        itemIds: results.map((result) => result.itemId),
        migratedSelections: inferred.length,
        migratedReviews,
      },
    });
    return {
      schemaVersion: 1,
      projectRoot: path.resolve(projectRoot),
      items: results,
      migratedSelections: inferred.length,
      migratedReviews,
      scannedAt: new Date().toISOString(),
    };
  });
}
