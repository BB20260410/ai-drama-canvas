import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSidecar, getSidecarPaths, listEvents, writeJsonAtomic } from "../src/core/sidecar.js";
import { getProjectIndex, scanAndPersist } from "../src/core/service.js";
import { getReviewQueue, listReviewRecords, submitReview } from "../src/core/reviews.js";
import { enqueueGeneration, processGenerationQueue } from "../src/core/generation.js";
import type { ReviewCriterion, ReviewCriterionKey, ReviewQueueEntry, ReviewStore } from "../src/core/types.js";
import { seedProductionReady } from "./workflow-helpers.js";
import { getPublicationIntent } from "../src/core/publication.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function image(filePath: string, color: string): Promise<void> {
  await sharp({ create: { width: 720, height: 1280, channels: 3, background: color } }).png().toFile(filePath);
}

function passing(keys: ReviewCriterionKey[]): ReviewCriterion[] {
  return keys.map((key) => ({ key, result: "pass" }));
}

function snapshot(entry: ReviewQueueEntry, artifactIds: string[]) {
  return {
    expectedScanId: entry.reviewSnapshot.scanId,
    expectedArtifactHashes: Object.fromEntries(artifactIds.map((artifactId) => [artifactId, entry.reviewSnapshot.artifactHashes[artifactId]!])),
  };
}

async function project(): Promise<{ root: string; info: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-review-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  config.hardLocks = [];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const directory = path.join(root, "EP01_15s_001_验收测试");
  await mkdir(directory, { recursive: true });
  const info = path.join(directory, "00_信息.md");
  await writeFile(info, "首帧提示词：人物站在祭坛。\n尾帧提示词：人物抬头。\n", "utf8");
  for (const [variant, color] of [["首帧", "#48637a"], ["尾帧", "#a5793f"]] as const) {
    await image(path.join(directory, `EP01_15s_001_${variant}_raw.png`), color);
    await image(path.join(directory, `EP01_15s_001_${variant}_labeled.png`), color);
  }
  const shot = path.join(directory, "EP01_镜01_人物近景");
  await mkdir(shot, { recursive: true });
  await writeFile(path.join(shot, "00_信息.md"), "镜头提示词：人物脸部近景。\n时长：5秒\n", "utf8");
  await image(path.join(shot, "EP01_镜01_人物近景_raw.png"), "#674c42");
  await image(path.join(shot, "EP01_镜01_人物近景_labeled.png"), "#674c42");
  await scanAndPersist(root);
  await seedProductionReady(root, "frames");
  return { root, info };
}

describe("导演视觉验收闭环", () => {
  it("图片通过后推进视频，视频通过后完成并保留追加式历史", async () => {
    const { root, info } = await project();
    const originalInfo = await readFile(info, "utf8");
    const queue = await getReviewQueue(root);
    const unit = queue.find((entry) => entry.item.id === "main-ep01-unit001")!;
    expect(unit.reviewType).toBe("image");
    const imageIds = unit.artifacts.filter((artifact) => artifact.kind.includes("image") && !artifact.deprecated).map((artifact) => artifact.id);
    const imageSnapshot = snapshot(unit, imageIds);
    await expect(submitReview(root, { itemId: unit.item.id, reviewType: "image", artifactIds: imageIds, ...imageSnapshot, decision: "pass", criteria: [] })).rejects.toThrow("全部检查项");
    expect(await listReviewRecords(root)).toHaveLength(0);
    const imageReview = await submitReview(root, {
      itemId: unit.item.id,
      reviewType: "image",
      artifactIds: imageIds,
      ...imageSnapshot,
      decision: "pass",
      criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"]),
      note: "首尾帧连续性通过。",
    });
    expect(imageReview.item.status).toBe("待视频");

    const [invalidJob] = await enqueueGeneration(root, { itemIds: [unit.item.id], kind: "video" });
    const invalidSubmitted = await processGenerationQueue(root);
    const invalidWaiting = invalidSubmitted.find((job) => job.id === invalidJob!.id)!;
    await writeFile(invalidWaiting.expectedOutputPath, "broken video", "utf8");
    const invalidCompleted = await processGenerationQueue(root);
    expect(invalidCompleted.find((job) => job.id === invalidJob!.id)?.status).toBe("failed");
    expect((await getPublicationIntent(root, invalidJob!.publicationIntentId!))?.status).toBe("failed");
    expect((await getProjectIndex(root)).items.find((item) => item.id === unit.item.id)?.status).toBe("待视频");

    const [videoJob] = await enqueueGeneration(root, { itemIds: [unit.item.id], kind: "video" });
    expect((await getProjectIndex(root)).items.find((item) => item.id === unit.item.id)?.status).toBe("视频生成中");
    const submitted = await processGenerationQueue(root);
    const waiting = submitted.find((job) => job.id === videoJob!.id)!;
    expect(waiting.status).toBe("waiting_external");
    await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", waiting.expectedOutputPath]);
    const completed = await processGenerationQueue(root);
    const completedVideoJob = completed.find((job) => job.id === videoJob!.id)!;
    expect(completedVideoJob.status).toBe("succeeded");
    expect(completedVideoJob.publicationReceiptId).toMatch(/^receipt-/);
    const videoQueue = await getReviewQueue(root);
    const videoEntry = videoQueue.find((entry) => entry.item.id === unit.item.id)!;
    expect(videoEntry.item.status).toBe("待视频验收");
    expect(videoEntry.reviewType).toBe("video");
    const videoIds = videoEntry.artifacts.filter((artifact) => artifact.kind === "video").map((artifact) => artifact.id);
    const videoSnapshot = snapshot(videoEntry, videoIds);
    const reviewedVideo = videoEntry.artifacts.find((artifact) => artifact.kind === "video" && (artifact.check.duration ?? 0) > 0)!;
    await expect(submitReview(root, {
      itemId: unit.item.id,
      reviewType: "video",
      artifactIds: videoIds,
      ...videoSnapshot,
      decision: "pending",
      criteria: [],
      annotations: [{ artifactId: reviewedVideo.id, type: "issue", timeSeconds: (reviewedVideo.check.duration ?? 0) + 1, x: .5, y: .5, text: "越界时间码" }],
    })).rejects.toThrow("超出素材时长");
    const videoReview = await submitReview(root, {
      itemId: unit.item.id,
      reviewType: "video",
      artifactIds: videoIds,
      ...videoSnapshot,
      decision: "pass",
      criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "motion_continuity", "duration_audio", "image_quality"]),
      annotations: [{ artifactId: reviewedVideo.id, type: "keep", timeSeconds: .5, x: .4, y: .3, text: "保留此处人物抬头节奏。" }],
      note: "时长、动作与角色连续性通过。",
    });
    expect(videoReview.item.status).toBe("已完成");
    expect(videoReview.record.annotations?.[0]).toEqual(expect.objectContaining({ artifactId: reviewedVideo.id, type: "keep", timeSeconds: .5, x: .4, y: .3, createdBy: "user" }));
    expect(await listReviewRecords(root, { itemId: unit.item.id })).toHaveLength(2);
    const resolvedQueue = await getReviewQueue(root, { includeResolved: true });
    const firstResolved = resolvedQueue.find((entry) => !["待视觉验收", "待视频验收", "返工"].includes(entry.item.status));
    expect(firstResolved?.item.id).toBe(unit.item.id);
    expect(firstResolved?.latestReview?.id).toBe(videoReview.record.id);
    expect(await readFile(info, "utf8")).toBe(originalInfo);
    const reviewEvent = (await listEvents(root, 50)).find((event) => event.type === "review.submitted");
    expect(reviewEvent?.actor).toBe("user");

    const reviewedHash = videoEntry.reviewSnapshot.artifactHashes[reviewedVideo.id];
    await execFileAsync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=800x450:rate=24", "-t", "1.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", reviewedVideo.path]);
    const videoRescan = await scanAndPersist(root, { includeHashes: true });
    const replacedVideo = videoRescan.artifacts.find((artifact) => artifact.id === reviewedVideo.id)!;
    expect(replacedVideo.check.ok).toBe(true);
    expect(replacedVideo.check.sha256).not.toBe(reviewedHash);
    expect(videoRescan.items.find((item) => item.id === unit.item.id)?.status).toBe("待视频验收");
    const reopenedVideo = (await getReviewQueue(root)).find((entry) => entry.item.id === unit.item.id);
    expect(reopenedVideo?.reviewType).toBe("video");
    expect(reopenedVideo?.latestReview).toBeUndefined();
  });

  it("真实生成后首尾帧同路径漂移会阻断视频通过并返回图片验收", async () => {
    const { root } = await project();
    const unit = (await getReviewQueue(root)).find((entry) => entry.item.type === "unit")!;
    const imageIds = unit.artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated && ["raw-image", "labeled-image"].includes(artifact.kind)).map((artifact) => artifact.id);
    const imageReview = await submitReview(root, {
      itemId: unit.item.id,
      reviewType: "image",
      artifactIds: imageIds,
      ...snapshot(unit, imageIds),
      decision: "pass",
      criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"]),
    });
    const overrideAfterImage = JSON.parse(await readFile(getSidecarPaths(root).overrides, "utf8")) as { items: Record<string, { reviewEvidenceIds?: { image?: string }; statusEvidenceId?: string }> };
    expect(overrideAfterImage.items[unit.item.id]?.reviewEvidenceIds?.image).toBe(imageReview.record.id);

    const [job] = await enqueueGeneration(root, { itemIds: [unit.item.id], kind: "video" });
    const submitted = await processGenerationQueue(root);
    const waiting = submitted.find((candidate) => candidate.id === job!.id)!;
    await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", waiting.expectedOutputPath]);
    expect((await processGenerationQueue(root)).find((candidate) => candidate.id === job!.id)?.status).toBe("succeeded");
    const videoEntry = (await getReviewQueue(root)).find((entry) => entry.item.id === unit.item.id)!;
    expect(videoEntry.reviewType).toBe("video");
    const videoIds = videoEntry.artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated && artifact.kind === "video").map((artifact) => artifact.id);
    const startRaw = videoEntry.artifacts.find((artifact) => artifact.authoritative && artifact.kind === "raw-image" && artifact.variant === "start")!;

    await sharp({ create: { width: 736, height: 1280, channels: 3, background: "#164f71" } }).png({ compressionLevel: 0 }).toFile(startRaw.path);
    const drifted = await scanAndPersist(root, { includeHashes: true });
    expect(drifted.items.find((item) => item.id === unit.item.id)?.status).toBe("待视觉验收");
    const reopened = (await getReviewQueue(root)).find((entry) => entry.item.id === unit.item.id)!;
    expect(reopened.reviewType).toBe("image");
    expect(reopened.latestReview).toBeUndefined();

    await expect(submitReview(root, {
      itemId: unit.item.id,
      reviewType: "video",
      artifactIds: videoIds,
      ...snapshot(videoEntry, videoIds),
      decision: "pass",
      criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "motion_continuity", "duration_audio", "image_quality"]),
    })).rejects.toThrow(/当前全部宫格图片视觉通过证据已失效|当前首尾帧视觉通过证据已失效/u);
    expect(await listReviewRecords(root, { itemId: unit.item.id })).toHaveLength(1);
    const finalOverride = JSON.parse(await readFile(getSidecarPaths(root).overrides, "utf8")) as { items: Record<string, { reviewEvidenceIds?: { image?: string; video?: string } }> };
    expect(finalOverride.items[unit.item.id]?.reviewEvidenceIds).toEqual({ image: imageReview.record.id });
  });

  it("视频返工保持视频验收路由与当前返工记录", async () => {
    const { root } = await project();
    const unit = (await getReviewQueue(root)).find((entry) => entry.item.type === "unit")!;
    const imageIds = unit.artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated && ["raw-image", "labeled-image"].includes(artifact.kind)).map((artifact) => artifact.id);
    await submitReview(root, { itemId: unit.item.id, reviewType: "image", artifactIds: imageIds, ...snapshot(unit, imageIds), decision: "pass", criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"]) });
    const [job] = await enqueueGeneration(root, { itemIds: [unit.item.id], kind: "video" });
    const waiting = (await processGenerationQueue(root)).find((candidate) => candidate.id === job!.id)!;
    await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", waiting.expectedOutputPath]);
    await processGenerationQueue(root);
    const videoEntry = (await getReviewQueue(root)).find((entry) => entry.item.id === unit.item.id)!;
    const videoIds = videoEntry.artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated && artifact.kind === "video").map((artifact) => artifact.id);
    const rework = await submitReview(root, { itemId: unit.item.id, reviewType: "video", artifactIds: videoIds, ...snapshot(videoEntry, videoIds), decision: "rework", criteria: [], note: "动作衔接需要重新生成。" });
    expect(rework.item.status).toBe("返工");
    const reopened = (await getReviewQueue(root)).find((entry) => entry.item.id === unit.item.id)!;
    expect(reopened.reviewType).toBe("video");
    expect(reopened.latestReview?.id).toBe(rework.record.id);
  });

  it("视频通过必须选择当前权威版本而不能用同类旧视频", async () => {
    const { root } = await project();
    const unit = (await getReviewQueue(root)).find((entry) => entry.item.type === "unit")!;
    const imageIds = unit.artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated && ["raw-image", "labeled-image"].includes(artifact.kind)).map((artifact) => artifact.id);
    await submitReview(root, { itemId: unit.item.id, reviewType: "image", artifactIds: imageIds, ...snapshot(unit, imageIds), decision: "pass", criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"]) });
    const directory = path.dirname(unit.item.infoPath!);
    for (const version of [1, 2]) {
      await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${640 + version * 16}x360:rate=24`, "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(directory, `EP01_15s_001_视频_v${version}.mp4`)]);
    }
    await scanAndPersist(root, { includeHashes: true });
    const entry = (await getReviewQueue(root, { includeResolved: true })).find((candidate) => candidate.item.id === unit.item.id)!;
    const oldVideoIds = entry.artifacts.filter((artifact) => artifact.kind === "video" && !artifact.authoritative && !artifact.deprecated).map((artifact) => artifact.id);
    expect(oldVideoIds).toHaveLength(1);
    await expect(submitReview(root, {
      itemId: unit.item.id,
      reviewType: "video",
      artifactIds: oldVideoIds,
      ...snapshot(entry, oldVideoIds),
      decision: "pass",
      criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "motion_continuity", "duration_audio", "image_quality"]),
    })).rejects.toThrow("当前权威视频版本");
  });

  it("legacy 完成记录与旧索引都无 SHA 时队列仍可补哈希并重新验收", async () => {
    const { root } = await project();
    const entry = (await getReviewQueue(root)).find((candidate) => candidate.item.type === "shot")!;
    const artifactIds = entry.artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated && ["raw-image", "labeled-image"].includes(artifact.kind)).map((artifact) => artifact.id);
    const passed = await submitReview(root, { itemId: entry.item.id, reviewType: "image", artifactIds, ...snapshot(entry, artifactIds), decision: "pass", criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"]) });
    const reviewPath = getSidecarPaths(root).reviews;
    const store = JSON.parse(await readFile(reviewPath, "utf8")) as ReviewStore;
    const legacy = store.records.find((record) => record.id === passed.record.id)!;
    delete legacy.artifactEvidence;
    delete legacy.sourceScanId;
    await writeJsonAtomic(reviewPath, store);
    const indexPath = getSidecarPaths(root).index;
    const persisted = JSON.parse(await readFile(indexPath, "utf8")) as { artifacts: Array<{ itemId: string; check: { sha256?: string } }> };
    for (const artifact of persisted.artifacts.filter((candidate) => candidate.itemId === entry.item.id)) delete artifact.check.sha256;
    await writeJsonAtomic(indexPath, persisted);

    const reopened = (await getReviewQueue(root)).find((candidate) => candidate.item.id === entry.item.id)!;
    expect(reopened.item.status).toBe("待视觉验收");
    expect(artifactIds.map((id) => reopened.reviewSnapshot.artifactHashes[id])).toEqual(artifactIds.map(() => expect.stringMatching(/^[a-f0-9]{64}$/)));
    const replay = await submitReview(root, { itemId: entry.item.id, reviewType: "image", artifactIds, ...snapshot(reopened, artifactIds), decision: "pass", criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"]) });
    expect(replay.item.status).toBe("已完成");
  });

  it("图片证据记录丢失时即使已有视频也保守回到待视觉验收", async () => {
    const { root } = await project();
    const entry = (await getReviewQueue(root)).find((candidate) => candidate.item.type === "unit")!;
    const artifactIds = entry.artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated && ["raw-image", "labeled-image"].includes(artifact.kind)).map((artifact) => artifact.id);
    await submitReview(root, { itemId: entry.item.id, reviewType: "image", artifactIds, ...snapshot(entry, artifactIds), decision: "pass", criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"]) });
    const videoPath = path.join(path.dirname(entry.item.infoPath!), "EP01_15s_001_已有视频.mp4");
    await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath]);
    await writeJsonAtomic(getSidecarPaths(root).reviews, { schemaVersion: 1, records: [] });
    const rescanned = await scanAndPersist(root, { includeHashes: true });
    expect(rescanned.items.find((item) => item.id === entry.item.id)?.status).toBe("待视觉验收");
    expect((await getReviewQueue(root)).find((candidate) => candidate.item.id === entry.item.id)?.reviewType).toBe("image");
  });

  it("图片批注绑定具体素材，标准化坐标经过持久化校验", async () => {
    const { root } = await project();
    const queue = await getReviewQueue(root);
    const shot = queue.find((entry) => entry.item.type === "shot")!;
    const artifact = shot.artifacts.find((entry) => entry.kind === "raw-image")!;
    const input = { itemId: shot.item.id, reviewType: "image" as const, artifactIds: [artifact.id], ...snapshot(shot, [artifact.id]), decision: "pending" as const, criteria: [] };

    await expect(submitReview(root, { ...input, annotations: [{ artifactId: "artifact-not-selected", type: "issue", x: .2, y: .3, text: "错误绑定" }] })).rejects.toThrow("必须绑定本次验收 artifactIds");
    await expect(submitReview(root, { ...input, annotations: [{ artifactId: artifact.id, type: "issue", x: 1.01, y: .3, text: "坐标越界" }] })).rejects.toThrow("坐标必须在 0..1");
    await expect(submitReview(root, { ...input, annotations: [{ artifactId: artifact.id, type: "issue", timeSeconds: 0, x: .2, y: .3, text: "图片错误时间码" }] })).rejects.toThrow("图片批注不能携带视频时间码");

    const submitted = await submitReview(root, { ...input, annotations: [{ artifactId: artifact.id, type: "continuity", x: .1256789, y: .8754321, text: " 保持视线方向一致。 " }] });
    expect(submitted.record.annotations?.[0]).toEqual(expect.objectContaining({ artifactId: artifact.id, type: "continuity", x: .125679, y: .875432, text: "保持视线方向一致。", createdBy: "user" }));
    expect(submitted.record.annotations?.[0]?.id).toMatch(/^annotation-/);
    expect((await listReviewRecords(root, { itemId: shot.item.id }))[0]?.annotations?.[0]?.artifactId).toBe(artifact.id);
    const event = (await listEvents(root, 20)).find((entry) => entry.type === "review.submitted");
    expect(event?.data?.annotationCount).toBe(1);
  });

  it("同路径替换已通过的原镜头后状态回落且旧记录只保留为历史", async () => {
    const { root } = await project();
    const entry = (await getReviewQueue(root)).find((candidate) => candidate.item.type === "shot")!;
    const artifactIds = entry.artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated && ["raw-image", "labeled-image"].includes(artifact.kind)).map((artifact) => artifact.id);
    const rawBefore = entry.artifacts.find((artifact) => artifact.authoritative && artifact.kind === "raw-image")!;
    const passed = await submitReview(root, {
      itemId: entry.item.id,
      reviewType: "image",
      artifactIds,
      ...snapshot(entry, artifactIds),
      decision: "pass",
      criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"]),
    });
    expect(passed.item.status).toBe("已完成");
    expect(passed.record.artifactEvidence).toHaveLength(2);

    await sharp({ create: { width: 800, height: 1280, channels: 3, background: "#1b5964" } }).png({ compressionLevel: 0 }).toFile(rawBefore.path);
    const rescanned = await scanAndPersist(root, { includeHashes: true });
    const rawAfter = rescanned.artifacts.find((artifact) => artifact.id === rawBefore.id)!;
    expect(rawAfter.id).toBe(rawBefore.id);
    expect(rawAfter.check.ok).toBe(true);
    expect(rawAfter.check.sha256).not.toBe(rawBefore.check.sha256);
    expect(rescanned.items.find((item) => item.id === entry.item.id)?.status).toBe("待视觉验收");
    const reopened = (await getReviewQueue(root)).find((candidate) => candidate.item.id === entry.item.id);
    expect(reopened?.item.status).toBe("待视觉验收");
    expect(reopened?.latestReview).toBeUndefined();
    expect((await listReviewRecords(root, { itemId: entry.item.id }))[0]?.id).toBe(passed.record.id);
  });

  it("队列快照后内容变化会拒绝旧结论且不写验收记录", async () => {
    const { root } = await project();
    const entry = (await getReviewQueue(root)).find((candidate) => candidate.item.type === "shot")!;
    const artifactIds = entry.artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated && ["raw-image", "labeled-image"].includes(artifact.kind)).map((artifact) => artifact.id);
    const raw = entry.artifacts.find((artifact) => artifact.authoritative && artifact.kind === "raw-image")!;
    await sharp({ create: { width: 808, height: 1280, channels: 3, background: "#5b3049" } }).png({ compressionLevel: 0 }).toFile(raw.path);
    await expect(submitReview(root, {
      itemId: entry.item.id,
      reviewType: "image",
      artifactIds,
      ...snapshot(entry, artifactIds),
      decision: "pass",
      criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"]),
    })).rejects.toThrow("读取验收队列后已变化");
    expect(await listReviewRecords(root, { itemId: entry.item.id })).toHaveLength(0);
  });

  it("提交窗口内替换内容会触发最终 CAS 且不推进状态", async () => {
    const { root } = await project();
    const entry = (await getReviewQueue(root)).find((candidate) => candidate.item.type === "shot")!;
    const artifactIds = entry.artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated && ["raw-image", "labeled-image"].includes(artifact.kind)).map((artifact) => artifact.id);
    const raw = entry.artifacts.find((artifact) => artifact.authoritative && artifact.kind === "raw-image")!;
    await expect(submitReview(root, {
      itemId: entry.item.id,
      reviewType: "image",
      artifactIds,
      ...snapshot(entry, artifactIds),
      decision: "pass",
      criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"]),
    }, "user", {
      beforeCommit: async () => sharp({ create: { width: 816, height: 1280, channels: 3, background: "#314c70" } }).png({ compressionLevel: 0 }).toFile(raw.path).then(() => undefined),
    })).rejects.toThrow("提交窗口内已变化");
    expect(await listReviewRecords(root, { itemId: entry.item.id })).toHaveLength(0);
    expect((await getProjectIndex(root)).items.find((item) => item.id === entry.item.id)?.status).toBe("待视觉验收");
  });

  it("最终扫描后外部替换会拒绝写入任何虚假验收记录", async () => {
    const { root } = await project();
    const entry = (await getReviewQueue(root)).find((candidate) => candidate.item.type === "shot")!;
    const artifactIds = entry.artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated && ["raw-image", "labeled-image"].includes(artifact.kind)).map((artifact) => artifact.id);
    const raw = entry.artifacts.find((artifact) => artifact.authoritative && artifact.kind === "raw-image")!;
    await expect(submitReview(root, {
      itemId: entry.item.id,
      reviewType: "image",
      artifactIds,
      ...snapshot(entry, artifactIds),
      decision: "pass",
      criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"]),
    }, "user", {
      afterFinalScanBeforeRecord: async () => sharp({ create: { width: 824, height: 1280, channels: 3, background: "#61402f" } }).png({ compressionLevel: 0 }).toFile(raw.path).then(() => undefined),
    })).rejects.toThrow("视觉验收素材内容在最终写入前已变化");
    expect(await listReviewRecords(root, { itemId: entry.item.id })).toHaveLength(0);
    expect((await getProjectIndex(root)).items.find((item) => item.id === entry.item.id)?.status).toBe("待视觉验收");
    expect((await getReviewQueue(root)).find((candidate) => candidate.item.id === entry.item.id)?.latestReview).toBeUndefined();
    expect((await listEvents(root, 50)).some((event) => event.type === "review.invalidated_during_status_commit")).toBe(false);
  });

  it("通过结论必须覆盖当前权威版本而不是同类旧版本", async () => {
    const { root } = await project();
    const initial = (await getReviewQueue(root)).find((candidate) => candidate.item.type === "shot")!;
    const shotDirectory = path.dirname(initial.item.infoPath!);
    await sharp({ create: { width: 820, height: 1280, channels: 3, background: "#74402f" } }).png({ compressionLevel: 0 }).toFile(path.join(shotDirectory, "EP01_镜01_人物近景_v2_raw.png"));
    await sharp({ create: { width: 820, height: 1280, channels: 3, background: "#74402f" } }).png({ compressionLevel: 0 }).toFile(path.join(shotDirectory, "EP01_镜01_人物近景_v2_labeled.png"));
    await scanAndPersist(root);
    const entry = (await getReviewQueue(root)).find((candidate) => candidate.item.id === initial.item.id)!;
    const oldIds = entry.artifacts.filter((artifact) => !artifact.authoritative && !artifact.deprecated && ["raw-image", "labeled-image"].includes(artifact.kind)).map((artifact) => artifact.id);
    expect(oldIds).toHaveLength(2);
    await expect(submitReview(root, {
      itemId: entry.item.id,
      reviewType: "image",
      artifactIds: oldIds,
      ...snapshot(entry, oldIds),
      decision: "pass",
      criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"]),
    })).rejects.toThrow("当前权威 raw/labeled");
  });

  it("旧 artifactIds-only 验收记录保留历史但不能继续证明完成", async () => {
    const { root } = await project();
    const entry = (await getReviewQueue(root)).find((candidate) => candidate.item.type === "shot")!;
    const artifactIds = entry.artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated && ["raw-image", "labeled-image"].includes(artifact.kind)).map((artifact) => artifact.id);
    const passed = await submitReview(root, {
      itemId: entry.item.id,
      reviewType: "image",
      artifactIds,
      ...snapshot(entry, artifactIds),
      decision: "pass",
      criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"]),
    });
    const reviewPath = getSidecarPaths(root).reviews;
    const store = JSON.parse(await readFile(reviewPath, "utf8")) as ReviewStore;
    const persisted = store.records.find((record) => record.id === passed.record.id)!;
    delete persisted.artifactEvidence;
    delete persisted.sourceScanId;
    await writeJsonAtomic(reviewPath, store);

    const rescanned = await scanAndPersist(root, { includeHashes: true });
    expect(rescanned.items.find((item) => item.id === entry.item.id)?.status).toBe("待视觉验收");
    expect(await listReviewRecords(root, { itemId: entry.item.id })).toHaveLength(1);
    expect((await getReviewQueue(root)).find((candidate) => candidate.item.id === entry.item.id)?.latestReview).toBeUndefined();
  });

  it("失败检查项进入返工且不能虚报通过", async () => {
    const { root } = await project();
    const queue = await getReviewQueue(root);
    const shot = queue.find((entry) => entry.item.type === "shot")!;
    const artifactIds = shot.artifacts.filter((artifact) => artifact.kind.includes("image")).map((artifact) => artifact.id);
    const currentSnapshot = snapshot(shot, artifactIds);
    const criteria = passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"]);
    criteria.find((criterion) => criterion.key === "character_identity")!.result = "fail";
    criteria.find((criterion) => criterion.key === "character_identity")!.note = "脸型与硬锁不一致";
    await expect(submitReview(root, { itemId: shot.item.id, reviewType: "image", artifactIds, ...currentSnapshot, decision: "pass", criteria })).rejects.toThrow("存在失败");
    const rework = await submitReview(root, { itemId: shot.item.id, reviewType: "image", artifactIds, ...currentSnapshot, decision: "rework", criteria, note: "保持原镜头，生成新版本返工。" });
    expect(rework.item.status).toBe("返工");
    expect(rework.record.criteria.find((criterion) => criterion.key === "character_identity")?.result).toBe("fail");
  });

  it("验收证据落盘后崩溃不会把节点虚报为完成", async () => {
    const { root } = await project();
    const queue = await getReviewQueue(root);
    const shot = queue.find((entry) => entry.item.type === "shot")!;
    const artifactIds = shot.artifacts.filter((artifact) => artifact.kind.includes("image")).map((artifact) => artifact.id);
    const currentSnapshot = snapshot(shot, artifactIds);
    process.env.AI_CANVAS_TEST_REVIEW_CRASH_AFTER_RECORD = "1";
    try {
      await expect(submitReview(root, {
        itemId: shot.item.id,
        reviewType: "image",
        artifactIds,
        ...currentSnapshot,
        decision: "pass",
        criteria: passing(["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"]),
      })).rejects.toThrow("TEST_ONLY_CRASH_AFTER_REVIEW_RECORD");
    } finally {
      delete process.env.AI_CANVAS_TEST_REVIEW_CRASH_AFTER_RECORD;
    }
    expect(await listReviewRecords(root, { itemId: shot.item.id })).toHaveLength(1);
    expect((await getProjectIndex(root, true)).items.find((item) => item.id === shot.item.id)?.status).toBe("待视觉验收");
  });

  it("两个独立进程同时提交不同节点验收不会丢记录", async () => {
    const { root } = await project();
    const queue = await getReviewQueue(root);
    const itemIds = queue.filter((entry) => ["unit", "shot"].includes(entry.item.type)).slice(0, 2).map((entry) => entry.item.id);
    const executable = path.join(process.cwd(), "node_modules", ".bin", "tsx");
    await Promise.all(itemIds.map((itemId) => execFileAsync(executable, ["scripts/review-worker.ts", root, itemId], { cwd: process.cwd() })));
    const records = await listReviewRecords(root, { limit: 10 });
    expect(records.filter((record) => itemIds.includes(record.itemId))).toHaveLength(2);
  });
});
