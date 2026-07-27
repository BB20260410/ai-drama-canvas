import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { getReviewQueue, submitReview } from "../src/core/reviews.js";
import { getProjectIndex, promoteAssetToHardLock, scanAndPersist, updateStatus, updateStatusOverridesBatch } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, loadProjectConfig, writeJsonAtomic } from "../src/core/sidecar.js";
import type { ReviewCriterionKey, ReviewQueueEntry } from "../src/core/types.js";

const roots: string[] = [];
const IMAGE_CRITERIA: ReviewCriterionKey[] = [
  "character_identity",
  "hard_lock",
  "prop_costume",
  "scene_continuity",
  "composition",
  "image_quality",
  "raw_labeled_pair",
];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function writeImage(filePath: string, color: string, width = 720, height = 1280): Promise<void> {
  await sharp({ create: { width, height, channels: 3, background: color } })
    .png({ compressionLevel: 0 })
    .toFile(filePath);
}

function snapshot(entry: ReviewQueueEntry, artifactIds: string[]) {
  return {
    expectedScanId: entry.reviewSnapshot.scanId,
    expectedArtifactHashes: Object.fromEntries(artifactIds.map((artifactId) => [artifactId, entry.reviewSnapshot.artifactHashes[artifactId]!])),
  };
}

async function assetProject(options: { paired?: boolean; legacyHardLock?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-asset-review-"));
  roots.push(root);
  const directory = path.join(root, "00_全剧资产锁定", "01_人物三视图");
  await mkdir(directory, { recursive: true });
  const rawPath = path.join(directory, "C99_测试角色_raw.png");
  const labeledPath = path.join(directory, "C99_测试角色_labeled.png");
  await writeImage(rawPath, "#18354f");
  if (options.paired) await writeImage(labeledPath, "#315875");
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  config.hardLocks = options.legacyHardLock
    ? [{ id: "legacy-c99", name: "C99 历史单图硬锁", path: rawPath, note: "历史单 raw 兼容。" }]
    : [];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const index = await scanAndPersist(root);
  const asset = index.items.find((item) => item.type === "asset" && item.sourcePaths.includes(rawPath));
  if (!asset) throw new Error("测试资产未被扫描器识别。");
  return { root, rawPath, labeledPath, asset };
}

describe("资产图片视觉验收与硬锁提升", () => {
  it("资产 image pass 必须绑定当前 generic raw/labeled，通过后才可提升硬锁", async () => {
    const { root, rawPath, asset } = await assetProject({ paired: true });
    expect(asset.status).toBe("待视觉验收");
    const entry = (await getReviewQueue(root)).find((candidate) => candidate.item.id === asset.id)!;
    expect(entry.reviewType).toBe("image");
    expect(entry.artifacts.map((artifact) => `${artifact.kind}:${artifact.variant}`).sort()).toEqual([
      "labeled-image:generic",
      "raw-image:generic",
    ]);
    const rawId = entry.artifacts.find((artifact) => artifact.kind === "raw-image")!.id;
    await expect(submitReview(root, {
      itemId: asset.id,
      reviewType: "video",
      artifactIds: [rawId],
      ...snapshot(entry, [rawId]),
      decision: "pass",
      criteria: [],
    })).rejects.toThrow("资产节点不支持视频验收");
    await expect(submitReview(root, {
      itemId: asset.id,
      reviewType: "image",
      artifactIds: [rawId],
      ...snapshot(entry, [rawId]),
      decision: "pass",
      criteria: IMAGE_CRITERIA.map((key) => ({ key, result: "pass" })),
    })).rejects.toThrow("generic labeled 时必须成对");

    const artifactIds = entry.artifacts.map((artifact) => artifact.id);
    const reviewed = await submitReview(root, {
      itemId: asset.id,
      reviewType: "image",
      artifactIds,
      ...snapshot(entry, artifactIds),
      decision: "pass",
      criteria: IMAGE_CRITERIA.map((key) => ({ key, result: "pass" })),
      note: "资产身份与成对文件通过。",
    });
    expect(reviewed.record.resultingStatus).toBe("已完成");
    expect(reviewed.item.status).toBe("已完成");

    const promoted = await promoteAssetToHardLock(root, asset.id, "已完成内容绑定视觉验收。");
    expect(promoted.id).toBe(asset.id);
    expect(promoted.hardLockIds).toHaveLength(1);
    expect((await loadProjectConfig(root)).hardLocks.some((lock) => lock.path === rawPath)).toBe(true);
  });

  it("权威 raw 文件内容漂移会使 pass 失效并阻止硬锁提升", async () => {
    const { root, rawPath, asset } = await assetProject();
    const entry = (await getReviewQueue(root)).find((candidate) => candidate.item.id === asset.id)!;
    const artifactIds = entry.artifacts.map((artifact) => artifact.id);
    await submitReview(root, {
      itemId: asset.id,
      reviewType: "image",
      artifactIds,
      ...snapshot(entry, artifactIds),
      decision: "pass",
      criteria: IMAGE_CRITERIA.map((key) => ({ key, result: "pass" })),
    });
    await writeImage(rawPath, "#9a3e35", 768, 1365);
    const drifted = await scanAndPersist(root);
    const driftedAsset = drifted.items.find((item) => item.id === asset.id)!;
    expect(driftedAsset.status).toBe("待视觉验收");
    expect(driftedAsset.failureReason).toContain("缺少仍有效的视觉通过证据");
    await expect(promoteAssetToHardLock(root, asset.id)).rejects.toThrow("缺少绑定当前文件内容");
  });

  it("未验收资产不能提升硬锁，通用单条与批量状态入口也不能直接完成", async () => {
    const { root, asset } = await assetProject();
    await expect(promoteAssetToHardLock(root, asset.id)).rejects.toThrow("图片视觉通过证据");
    await expect(updateStatus(root, asset.id, "已完成")).rejects.toThrow("资产节点只能由");
    await expect(updateStatusOverridesBatch(root, [{ itemId: asset.id, status: "已完成" }])).rejects.toThrow("资产节点只能由");
    expect((await getProjectIndex(root)).items.find((item) => item.id === asset.id)?.status).toBe("待视觉验收");
  });

  it("历史配置中的可解码单 raw 硬锁保持完成兼容", async () => {
    const { root, rawPath, asset } = await assetProject({ legacyHardLock: true });
    expect(asset.status).toBe("已完成");
    expect(asset.hardLockIds).toEqual(["legacy-c99"]);
    const artifacts = (await getProjectIndex(root)).artifacts.filter((artifact) => artifact.itemId === asset.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ path: rawPath, kind: "raw-image", variant: "generic", authoritative: true });
  });
});
