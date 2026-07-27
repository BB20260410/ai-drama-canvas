import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { inspectFusionPackage } from "../src/core/fusion-package.js";
import { materializeFusionProject } from "../src/core/fusion-production.js";
import { cancelGenerationJob, enqueueGeneration, processGenerationQueue } from "../src/core/generation.js";
import { getPublicationIntent, registerPublication } from "../src/core/publication.js";
import { getReviewQueue, submitReview } from "../src/core/reviews.js";
import { promoteAssetToHardLock, scanAndPersist } from "../src/core/service.js";
import { getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import { doctorProject, getProjectSnapshot } from "../src/core/codex.js";
import {
  FUSION_ASSET_CONSISTENCY_CRITERIA,
  FUSION_ASSET_CONSISTENCY_BOARD_RENDER_VERSION,
  getFusionAssetConsistencyState,
  initializeFusionAssetConsistency,
  prepareFusionAssetConsistencyReview,
  sealFinalFusionAssetConsistencyBatch,
  submitFusionAssetConsistencyReview,
} from "../src/core/fusion-asset-consistency.js";
import type { GenerationJob, ReviewCriterionKey } from "../src/core/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const ASSET_IDS = ["C03", "S01", "P01", "P02", "P03", "P04", "P05"] as const;
const PRODUCTION_ORDER = ["P01", "C03", "S01", "P02", "P03", "P04", "P05"] as const;
const IMAGE_CRITERIA: ReviewCriterionKey[] = ["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"];

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-six-asset-")));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const targetParent = path.join(root, "targets");
  const packageRoot = path.join(sourceRoot, "07_9x16_15秒融合制作包");
  const unitRelative = "第三季_EP01_测试/04_15秒融合分镜/EP01_15s_001_测试.md";
  await Promise.all([
    mkdir(path.join(packageRoot, path.dirname(unitRelative)), { recursive: true }),
    mkdir(path.join(sourceRoot, "05_提示词"), { recursive: true }),
    mkdir(path.join(sourceRoot, "01_剧本"), { recursive: true }),
    mkdir(targetParent, { recursive: true }),
  ]);
  const definitions = ASSET_IDS.map((id) => `### ${id} ${id === "C03" ? "青年同伴" : id === "S01" ? "祭台" : `道具${id.slice(1)}`}

- **出场集数**：EP01
- **AI 出图提示词**：
  电影级写实商周资产 ${id}，9:16，单一资产，无文字。
`).join("\n");
  const mention = ASSET_IDS.map((id) => `@${id}`).join("、");
  const unit = `# EP01 15s-001｜测试

## 3. 机位 / 焦段 / 运镜

| 原镜 | 景别 | 焦段 | 机位 | 运镜 | 帧率 | 备注 |
|---|---|---|---|---|---|---|
| 镜01 | 全景 | 35mm | 平视 | 固定 | 24 | 测试 |

## 4. 人物 / 道具站位

${mention}

## 7. 首帧生图提示词

电影级写实，9:16，测试画面。

## 8. 图生视频中文提示词

### 原镜01 视频提示词

参考素材：${mention}。
七项资产依次展示。
尾帧：动作收束。

## 9. 生成注意事项

无现代物。
`;
  const fused = [{
    id: "EP01_15s_001",
    episode: "EP01",
    episode_title: "测试",
    unit_title: "测试",
    md_path: unitRelative,
    source_script: "01_剧本/第三季_EP01_测试.md",
    source_prompt_table: "05_提示词/第三季_EP01_提示词表.md",
    source_shots: [1],
    source_duration_seconds: 15,
    standard_duration_seconds: 15,
    aspect_ratio: "9:16",
    story_goal: "测试六张门禁",
    schedule: [{ start: 0, end: 15, shot: "镜01", seconds: 15, content: "七项资产依次展示" }],
    asset_ids: [...ASSET_IDS],
    reference_image_paths: [],
    validation: { source_order_preserved: true, source_duration_lte_15: true, no_compression: true },
  }];
  await Promise.all([
    writeFile(path.join(packageRoot, "15s_fused_units.json"), `${JSON.stringify(fused, null, 2)}\n`, "utf8"),
    writeFile(path.join(packageRoot, unitRelative), unit, "utf8"),
    writeFile(path.join(sourceRoot, "05_提示词", "00_全季资产库.md"), `# 全季资产库\n\n${definitions}`, "utf8"),
    writeFile(path.join(sourceRoot, "05_提示词", "第三季_EP01_提示词表.md"), `# EP01 提示词\n\n#### 镜01 [15s] 【全景】（24帧）\n**参考素材**：${mention}\n`, "utf8"),
    writeFile(path.join(sourceRoot, "01_剧本", "第三季_EP01_测试.md"), "# EP01 测试\n", "utf8"),
  ]);
  const inspection = await inspectFusionPackage({
    packageRoot,
    sourceRoot,
    expectedCounts: { episodes: 1, units: 1, sourceShots: 1, scheduleRows: 1, assets: 7, characters: 1, scenes: 1, props: 5, standardDurationSeconds: 15 },
  });
  const created = await materializeFusionProject({ inspection, targetParent });
  await scanAndPersist(created.targetRoot);
  return created.targetRoot;
}

async function deterministicImage(seed: number): Promise<Buffer> {
  const width = 720;
  const height = 1280;
  const pixels = Buffer.alloc(width * height * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    const pixel = offset / 3;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    pixels[offset] = (x * (seed + 3) + y * 7) % 256;
    pixels[offset + 1] = (x * 5 + y * (seed + 11)) % 256;
    pixels[offset + 2] = (x * 13 + y * 3 + seed * 17) % 256;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 6 }).toBuffer();
}

async function completeJobs(projectRoot: string, jobs: GenerationJob[]): Promise<void> {
  for (const [index, job] of jobs.entries()) {
    const bytes = await deterministicImage(index + 1);
    await writeFile(job.expectedOutputPath, bytes);
    await writeFile(job.expectedCompanionPath!, bytes);
    const intent = await getPublicationIntent(projectRoot, job.publicationIntentId!);
    const receipt = await registerPublication(projectRoot, { intentId: intent!.id, reservationToken: intent!.reservationToken, expectedRevision: intent!.revision });
    job.status = "succeeded";
    job.resultPath = job.expectedOutputPath;
    job.resultSha256 = createHash("sha256").update(bytes).digest("hex");
    job.companionPath = job.expectedCompanionPath;
    job.publicationReceiptId = receipt.id;
    job.updatedAt = new Date(Date.now() + index).toISOString();
  }
  const stored = JSON.parse(await readFile(getSidecarPaths(projectRoot).generationJobs, "utf8")) as GenerationJob[];
  const completed = new Map(jobs.map((job) => [job.id, job]));
  await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, stored.map((job) => completed.get(job.id) ?? job));
  await scanAndPersist(projectRoot, true);
}

async function passIndividualReviews(projectRoot: string, itemIds: string[]): Promise<void> {
  for (const itemId of itemIds) {
    const queue = await getReviewQueue(projectRoot, { includeResolved: true });
    const entry = queue.find((candidate) => candidate.item.id === itemId)!;
    const pair = entry.artifacts.filter((artifact) => ["raw-image", "labeled-image"].includes(artifact.kind) && artifact.variant === "generic" && artifact.authoritative && !artifact.deprecated);
    expect(pair).toHaveLength(2);
    await submitReview(projectRoot, {
      itemId,
      reviewType: "image",
      artifactIds: pair.map((artifact) => artifact.id),
      expectedScanId: entry.reviewSnapshot.scanId,
      expectedArtifactHashes: Object.fromEntries(pair.map((artifact) => [artifact.id, artifact.check.sha256!])),
      decision: "pass",
      criteria: IMAGE_CRITERIA.map((key) => ({ key, result: "pass" as const })),
      note: "测试夹具：单图机械与视觉门禁通过。",
    }, "codex");
  }
}

describe("第三季六张资产一致性门禁", () => {
  it("第六项自动封存，第七项失败关闭，原成员返工不占新槽", async () => {
    const projectRoot = await fixture();
    await expect(enqueueGeneration(projectRoot, { itemIds: ["asset-C03"], kind: "image" })).rejects.toThrow(/下一项必须是 P01/u);
    const firstSix = await enqueueGeneration(projectRoot, { itemIds: PRODUCTION_ORDER.slice(0, 6).map((id) => `asset-${id}`), kind: "image" });
    expect(firstSix).toHaveLength(6);
    expect(new Set(firstSix.map((job) => job.assetConsistencyBatchId))).toEqual(new Set(["fusion-asset-batch-001"]));
    expect(firstSix.every((job) => job.fusionAssetContract?.sourceSectionSha256)).toBe(true);
    const state = await getFusionAssetConsistencyState(projectRoot);
    expect(state).toMatchObject({ persisted: true, canEnqueueNewAsset: false, batchSize: 6 });
    expect(state.productionOrder).toMatchObject({ version: "hidden-mask-first-then-first-appearance-v1", totalAssets: 7, reservedAssets: 6, nextAssetId: "P05", nextBatchAssetIds: ["P05"] });
    expect(state.batches[0]).toMatchObject({ memberCount: 6, sealed: true, sealedReason: "batch_size_reached", status: "generating" });
    await expect(enqueueGeneration(projectRoot, { itemIds: ["asset-P05"], kind: "image" })).rejects.toThrow(/第七个新资产被六张一致性门禁阻止/u);

    await cancelGenerationJob(projectRoot, firstSix[0]!.id);
    const [retry] = await enqueueGeneration(projectRoot, { itemIds: [firstSix[0]!.itemId], kind: "image" });
    expect(retry).toMatchObject({ assetConsistencyBatchId: "fusion-asset-batch-001", itemId: firstSix[0]!.itemId });
    const retried = await getFusionAssetConsistencyState(projectRoot);
    expect(retried.batches[0]!.memberCount).toBe(6);
    expect(retried.batches[0]!.members.find((member) => member.itemId === retry!.itemId)?.attemptJobIds).toHaveLength(2);
  });

  it("可安全接管仅 plan_ready 的既有六项且不改变任务，提交前仍复验批次", async () => {
    const projectRoot = await fixture();
    const jobs = await enqueueGeneration(projectRoot, { itemIds: PRODUCTION_ORDER.slice(0, 6).map((id) => `asset-${id}`), kind: "image" });
    await processGenerationQueue(projectRoot, { jobId: jobs[0]!.id });
    const before = JSON.parse(await readFile(getSidecarPaths(projectRoot).generationJobs, "utf8")) as GenerationJob[];
    const planReady = before.find((job) => job.id === jobs[0]!.id)!;
    expect(planReady).toMatchObject({ status: "waiting_external", browserCheckpoint: { stage: "plan_ready" } });
    await unlink(getSidecarPaths(projectRoot).assetConsistencyBatches);
    const initialized = await initializeFusionAssetConsistency(projectRoot);
    const after = JSON.parse(await readFile(getSidecarPaths(projectRoot).generationJobs, "utf8")) as GenerationJob[];
    expect(after).toEqual(before);
    const expectedOrder = [...before].filter((job) => job.purpose === "asset").sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).map((job) => job.id);
    expect(initialized.batches[0]!.members.map((member) => member.currentJobId)).toEqual(expectedOrder);
    const doctor = await doctorProject(projectRoot);
    expect(doctor.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "fusion-asset-consistency", level: "warning", detail: expect.stringContaining("6/6") })]));
    expect(doctor.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "existing-production-recovery", level: "ok", detail: expect.stringContaining("融合 manifest") })]));
    const snapshot = await getProjectSnapshot(projectRoot);
    expect(snapshot.productionDesign.assetConsistency).toMatchObject({ persisted: true, batchSize: 6, batches: [expect.objectContaining({ memberCount: 6, status: "generating" })] });
  });

  it("六项证据完整后生成复核板并通过；全批硬锁前仍禁止下一批，漂移使通过失效", async () => {
    const projectRoot = await fixture();
    const itemIds = PRODUCTION_ORDER.slice(0, 6).map((id) => `asset-${id}`);
    const jobs = await enqueueGeneration(projectRoot, { itemIds, kind: "image" });
    await completeJobs(projectRoot, jobs);
    await passIndividualReviews(projectRoot, itemIds);
    const prepared = await prepareFusionAssetConsistencyReview(projectRoot);
    expect(prepared).toMatchObject({ prepared: true, board: { width: 1920, height: 2160 } });
    expect(prepared.board?.path).toMatch(/asset-consistency-boards/u);
    expect(prepared.board?.path).toContain(FUSION_ASSET_CONSISTENCY_BOARD_RENDER_VERSION);
    const boardMetadata = JSON.parse(await readFile(prepared.board!.metadataPath, "utf8")) as { role: string; renderVersion: string };
    expect(boardMetadata).toMatchObject({ role: "review-only-not-generation-reference", renderVersion: FUSION_ASSET_CONSISTENCY_BOARD_RENDER_VERSION });
    const firstTile = await sharp(prepared.board!.path).extract({ left: 24, top: 24, width: 608, height: 992 }).png().toBuffer();
    const firstTileStats = await sharp(firstTile).stats();
    const background = [6, 21, 47];
    expect(firstTileStats.channels.slice(0, 3).some((channel, index) => channel.stdev > 2 || Math.abs(channel.mean - background[index]!) > 5)).toBe(true);
    const current = prepared.state.batches[0]!;
    expect(current).toMatchObject({ status: "awaiting_batch_review", readyCount: 6, canPrepareReview: true });
    await expect(submitFusionAssetConsistencyReview(projectRoot, {
      batchId: current.id,
      expectedRevision: prepared.state.storeRevision,
      expectedSnapshotHash: current.currentSnapshotHash!,
      decision: "pass",
      criteria: FUSION_ASSET_CONSISTENCY_CRITERIA.map((key) => ({ key, result: key === "hidden_mask_rule" ? "na" as const : "pass" as const })),
      note: "包含 P01 却错误标记隐藏面具铁律不适用。",
    }, "codex")).rejects.toThrow(/P01|隐藏面具/u);
    const passed = await submitFusionAssetConsistencyReview(projectRoot, {
      batchId: current.id,
      expectedRevision: prepared.state.storeRevision,
      expectedSnapshotHash: current.currentSnapshotHash!,
      decision: "pass",
      criteria: FUSION_ASSET_CONSISTENCY_CRITERIA.map((key) => ({ key, result: "pass" })),
      note: "测试夹具：六张跨资产一致性明确通过。",
    }, "codex");
    expect(passed.batches[0]).toMatchObject({ status: "passed", reviewValid: true, hardLockCount: 0, canStartNextBatch: false });
    await expect(enqueueGeneration(projectRoot, { itemIds: ["asset-P05"], kind: "image" })).rejects.toThrow(/全部提升硬锁/u);
    for (const itemId of itemIds) await promoteAssetToHardLock(projectRoot, itemId, "测试夹具硬锁");
    const locked = await getFusionAssetConsistencyState(projectRoot);
    expect(locked.batches[0]).toMatchObject({ status: "passed", hardLockCount: 6, canStartNextBatch: true });
    const [seventh] = await enqueueGeneration(projectRoot, { itemIds: ["asset-P05"], kind: "image" });
    expect(seventh).toMatchObject({ assetConsistencyBatchId: "fusion-asset-batch-002", itemId: "asset-P05" });
    const partial = await getFusionAssetConsistencyState(projectRoot);
    const sealedPartial = await sealFinalFusionAssetConsistencyBatch(projectRoot, { batchId: partial.batches[1]!.id, expectedRevision: partial.storeRevision });
    expect(sealedPartial.batches[1]).toMatchObject({ sealed: true, sealedReason: "final_partial", memberCount: 1, status: "generating" });
    await completeJobs(projectRoot, [seventh!]);
    await passIndividualReviews(projectRoot, [seventh!.itemId]);
    const preparedPartial = await prepareFusionAssetConsistencyReview(projectRoot, sealedPartial.batches[1]!.id);
    const partialBatch = preparedPartial.state.batches[1]!;
    expect(partialBatch).toMatchObject({ includesHiddenMaskAsset: false, canPrepareReview: true, readyCount: 1 });
    const passedPartial = await submitFusionAssetConsistencyReview(projectRoot, {
      batchId: partialBatch.id,
      expectedRevision: preparedPartial.state.storeRevision,
      expectedSnapshotHash: partialBatch.currentSnapshotHash!,
      decision: "pass",
      criteria: FUSION_ASSET_CONSISTENCY_CRITERIA.map((key) => ({ key, result: key === "hidden_mask_rule" ? "na" as const : "pass" as const })),
      note: "测试夹具：最终不足六项明确复核；本批不含 P01，隐藏面具标准不适用。",
    }, "codex");
    expect(passedPartial.batches[1]).toMatchObject({ status: "passed", reviewValid: true, memberCount: 1 });

    const rawPath = locked.batches[0]!.members[0]!.evidence!.raw.path;
    await writeFile(rawPath, await deterministicImage(99));
    const drifted = await getFusionAssetConsistencyState(projectRoot);
    expect(drifted.batches[0]).toMatchObject({ status: "invalidated", reviewValid: false });
  }, 120_000);

  it("一致性侧车损坏时 Doctor 报核心错误且资产入队不产生任务或 Publication", async () => {
    const projectRoot = await fixture();
    const paths = getSidecarPaths(projectRoot);
    await writeFile(paths.assetConsistencyBatches, "{broken", "utf8");
    await expect(getFusionAssetConsistencyState(projectRoot)).rejects.toThrow(/JSON|结构|损坏|Unexpected/u);
    const doctor = await doctorProject(projectRoot);
    expect(doctor.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "asset-consistency-store-corrupt", level: "error" }),
      expect.objectContaining({ id: "critical-sidecars", level: "error" }),
    ]));
    await expect(enqueueGeneration(projectRoot, { itemIds: ["asset-C03"], kind: "image" })).rejects.toThrow();
    await expect(readFile(paths.generationJobs, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.publications, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("第六与第七项并发入队时只允许顺序正确的第六项取得槽位，失败请求不预留 Publication", async () => {
    const projectRoot = await fixture();
    await enqueueGeneration(projectRoot, { itemIds: PRODUCTION_ORDER.slice(0, 5).map((id) => `asset-${id}`), kind: "image" });
    const results = await Promise.allSettled(["P04", "P05"].map((assetId) => enqueueGeneration(projectRoot, { itemIds: [`asset-${assetId}`], kind: "image" })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const paths = getSidecarPaths(projectRoot);
    const jobs = JSON.parse(await readFile(paths.generationJobs, "utf8")) as GenerationJob[];
    const publications = JSON.parse(await readFile(paths.publications, "utf8")) as { intents: unknown[] };
    expect(jobs).toHaveLength(6);
    expect(publications.intents).toHaveLength(6);
    const state = await getFusionAssetConsistencyState(projectRoot);
    expect(state.batches).toHaveLength(1);
    expect(state.batches[0]).toMatchObject({ sealed: true, memberCount: 6, status: "generating" });
    expect(new Set(state.batches[0]!.members.map((member) => member.itemId)).size).toBe(6);
  });
});
