import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { cancelTask, claimTask, createTaskPack, finishBatch, getItem, getNextTask, heartbeatTask, reconcileTaskReviews, registerArtifact, releaseTask, scanAndPersist, updateStatus, updateStatusOverridesBatch } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, listEvents, readTaskPack, writeJsonAtomic, writeTaskPack } from "../src/core/sidecar.js";
import { getReviewQueue, submitReview } from "../src/core/reviews.js";
import type { ReviewCriterionKey } from "../src/core/types.js";
import { seedProductionReady } from "./workflow-helpers.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-service-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  config.hardLocks = [];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const directory = path.join(root, "EP03_15s_001_服务测试");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "00_信息.md"), "首帧提示词：测试\n尾帧提示词：测试\n", "utf8");
  for (const variant of ["首帧", "尾帧"]) {
    await sharp({ create: { width: 941, height: 1672, channels: 3, background: "#666666" } })
      .png({ compressionLevel: 0 })
      .toFile(path.join(directory, `EP03_15s_001_${variant}_raw.png`));
    await sharp({ create: { width: 941, height: 1672, channels: 3, background: "#777777" } })
      .png({ compressionLevel: 0 })
      .toFile(path.join(directory, `EP03_15s_001_${variant}_labeled.png`));
  }
  await scanAndPersist(root);
  await seedProductionReady(root, "frames");
  return root;
}

async function reviewSnapshot(root: string, itemId: string, artifactIds: string[]) {
  const entry = (await getReviewQueue(root, { includeResolved: true })).find((candidate) => candidate.item.id === itemId);
  if (!entry) throw new Error(`找不到验收节点：${itemId}`);
  return {
    expectedScanId: entry.reviewSnapshot.scanId,
    expectedArtifactHashes: Object.fromEntries(artifactIds.map((artifactId) => [artifactId, entry.reviewSnapshot.artifactHashes[artifactId]!])),
  };
}

describe("Codex 任务闭环", () => {
  it("不同节点并发写状态不会在 overrides read-modify-write 中互相覆盖", async () => {
    const root = await project();
    const secondDirectory = path.join(root, "EP03_15s_002_并发状态测试");
    await mkdir(secondDirectory, { recursive: true });
    await writeFile(path.join(secondDirectory, "00_信息.md"), "首帧提示词：并发二\n尾帧提示词：并发二\n", "utf8");
    for (const variant of ["首帧", "尾帧"]) {
      await sharp({ create: { width: 941, height: 1672, channels: 3, background: "#555555" } }).png({ compressionLevel: 0 }).toFile(path.join(secondDirectory, `EP03_15s_002_${variant}_raw.png`));
      await sharp({ create: { width: 941, height: 1672, channels: 3, background: "#888888" } }).png({ compressionLevel: 0 }).toFile(path.join(secondDirectory, `EP03_15s_002_${variant}_labeled.png`));
    }
    await scanAndPersist(root);
    await Promise.all([
      updateStatusOverridesBatch(root, [{ itemId: "main-ep03-unit001", status: "阻塞", note: "并发一" }]),
      updateStatusOverridesBatch(root, [{ itemId: "main-ep03-unit002", status: "阻塞", note: "并发二" }]),
    ]);
    const index = await scanAndPersist(root);
    expect(index.items.filter((item) => ["main-ep03-unit001", "main-ep03-unit002"].includes(item.id)).map((item) => [item.id, item.status]).sort()).toEqual([
      ["main-ep03-unit001", "阻塞"],
      ["main-ep03-unit002", "阻塞"],
    ]);
  });

  it("创建不跨集任务包、写回状态并完成批次", async () => {
    const root = await project();
    const next = await getNextTask(root, { limit: 6 });
    expect(next).toHaveLength(1);
    expect(next[0]?.status).toBe("待视觉验收");

    const { task, path: taskPath } = await createTaskPack(root, { itemIds: [next[0]!.id], mode: "autopilot" });
    expect(task.schemaVersion).toBe(2);
    expect(task.revision).toBe(1);
    expect(task.episode).toBe(3);
    expect(task.kind).toBe("image");
    expect(task.itemSnapshots[0]?.storyboardRows).toHaveLength(1);
    expect(task.itemSnapshots[0]?.promptExcerpt).toContain("首帧");
    expect(taskPath.startsWith(root)).toBe(true);
    await expect(updateStatus(root, next[0]!.id, "已完成", "错误提前完成")).rejects.toThrow("缺少可解码视频");

    await expect(createTaskPack(root, { itemIds: [next[0]!.id], kind: "image" })).rejects.toThrow("未结束任务包");
    await expect(claimTask(root, task.id, { agentId: "codex-a" } as unknown as Parameters<typeof claimTask>[2])).rejects.toThrow("必须提供有效的 expectedRevision");
    const claimed = await claimTask(root, task.id, { agentId: "codex-a", leaseSeconds: 300, expectedRevision: task.revision });
    expect(claimed.status).toBe("claimed");
    expect(claimed.lease?.owner).toBe("codex-a");
    await expect(claimTask(root, task.id, { agentId: "codex-b", expectedRevision: claimed.revision })).rejects.toThrow("不能重复领取");
    await expect(heartbeatTask(root, task.id, { leaseId: claimed.lease!.id, agentId: "codex-a" } as unknown as Parameters<typeof heartbeatTask>[2])).rejects.toThrow("必须提供有效的 expectedRevision");
    const heartbeat = await heartbeatTask(root, task.id, { leaseId: claimed.lease!.id, agentId: "codex-a", expectedRevision: claimed.revision });
    await expect(finishBatch(root, task.id, { leaseId: heartbeat.lease!.id, agentId: "codex-b", expectedRevision: heartbeat.revision, completedItemIds: task.itemIds })).rejects.toThrow("有效任务租约");
    await expect(finishBatch(root, task.id, { leaseId: heartbeat.lease!.id, agentId: "codex-a", completedItemIds: task.itemIds } as unknown as Parameters<typeof finishBatch>[2])).rejects.toThrow("必须提供有效的 expectedRevision");
    const awaiting = await finishBatch(root, task.id, { leaseId: heartbeat.lease!.id, agentId: "codex-a", expectedRevision: heartbeat.revision, completedItemIds: task.itemIds, note: "机械门禁通过" });
    expect(awaiting.status).toBe("awaiting_review");
    expect(awaiting.result?.verifiedScanId).toBeTruthy();
    expect((await getNextTask(root, { limit: 6 }))).toHaveLength(0);

    const current = await getItem(root, next[0]!.id);
    const imageArtifacts = current.artifacts.filter((artifact) => artifact.kind.includes("image") && artifact.authoritative && !artifact.deprecated);
    const artifactIds = imageArtifacts.map((artifact) => artifact.id);
    const criteria = (["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"] satisfies ReviewCriterionKey[]).map((key) => ({ key, result: "pass" as const }));
    await submitReview(root, { itemId: next[0]!.id, reviewType: "image", artifactIds, ...await reviewSnapshot(root, next[0]!.id, artifactIds), decision: "pass", criteria });
    expect((await readTaskPack(root, task.id))?.status).toBe("completed");
    expect((await getItem(root, next[0]!.id)).item.status).toBe("待视频");

    const { task: videoTask } = await createTaskPack(root, { kind: "video" });
    expect(videoTask.kind).toBe("video");
    expect(videoTask.itemIds).toEqual([next[0]!.id]);
    await expect(createTaskPack(root, { kind: "image" })).rejects.toThrow("没有可创建图片任务包");
    const videoClaim = await claimTask(root, videoTask.id, { agentId: "desktop-app", expectedRevision: videoTask.revision });
    await expect(releaseTask(root, videoTask.id, { leaseId: videoClaim.lease!.id, agentId: "desktop-app" } as unknown as Parameters<typeof releaseTask>[2])).rejects.toThrow("必须提供有效的 expectedRevision");
    const released = await releaseTask(root, videoTask.id, { leaseId: videoClaim.lease!.id, agentId: "desktop-app", expectedRevision: videoClaim.revision, reason: "稍后继续" });
    expect(released.status).toBe("ready");
  });

  it("并发领取只有一个执行者成功，过期租约可审计接管", async () => {
    const root = await project();
    const { task } = await createTaskPack(root, { kind: "image" });
    const attempts = await Promise.allSettled([
      claimTask(root, task.id, { agentId: "codex-a", expectedRevision: task.revision }),
      claimTask(root, task.id, { agentId: "codex-b", expectedRevision: task.revision }),
    ]);
    expect(attempts.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const claimed = (attempts.find((entry): entry is PromiseFulfilledResult<Awaited<ReturnType<typeof claimTask>>> => entry.status === "fulfilled"))!.value;
    const sameOwner = await claimTask(root, task.id, { agentId: claimed.lease!.owner, expectedRevision: claimed.revision });
    expect(sameOwner.lease?.id).toBe(claimed.lease?.id);
    expect(sameOwner.revision).toBe(claimed.revision);
    sameOwner.lease!.leaseUntil = new Date(Date.now() - 1_000).toISOString();
    await writeTaskPack(root, sameOwner);
    const reclaimed = await claimTask(root, task.id, { agentId: "codex-c", expectedRevision: sameOwner.revision });
    expect(reclaimed.lease?.owner).toBe("codex-c");
    expect(reclaimed.lease?.id).not.toBe(sameOwner.lease?.id);
    await expect(finishBatch(root, task.id, { leaseId: reclaimed.lease!.id, agentId: "codex-c", expectedRevision: reclaimed.revision, status: "blocked", completedItemIds: [], failedItemIds: task.itemIds })).rejects.toThrow("真实失败原因");
    const blocked = await finishBatch(root, task.id, { leaseId: reclaimed.lease!.id, agentId: "codex-c", expectedRevision: reclaimed.revision, status: "blocked", completedItemIds: [], failedItemIds: task.itemIds, note: "外部生成供应商暂不可用" });
    expect(blocked.status).toBe("blocked");
    await expect(readTaskPack(root, "../escape")).rejects.toThrow("ID 不合法");
  });

  it("只允许按修订取消待领取或租约已过期的任务，并保留取消审计", async () => {
    const root = await project();
    const { task: readyTask } = await createTaskPack(root, { kind: "image" });
    await expect(cancelTask(root, readyTask.id, { expectedRevision: readyTask.revision + 1, reason: "计划调整" })).rejects.toThrow("当前修订");
    await expect(cancelTask(root, readyTask.id, { expectedRevision: readyTask.revision, reason: "   " })).rejects.toThrow("必须填写真实原因");

    const cancelledReady = await cancelTask(root, readyTask.id, { expectedRevision: readyTask.revision, reason: "本批优先级调整" });
    expect(cancelledReady).toEqual(expect.objectContaining({ status: "cancelled", revision: readyTask.revision + 1, lease: undefined }));
    expect(cancelledReady.cancellation).toEqual(expect.objectContaining({ reason: "本批优先级调整", previousStatus: "ready" }));
    expect(cancelledReady.cancelledAt).toBeTruthy();
    expect(await getNextTask(root, { limit: 6 })).toHaveLength(1);

    const { task } = await createTaskPack(root, { kind: "image" });
    const claimed = await claimTask(root, task.id, { agentId: "codex-cancel", expectedRevision: task.revision });
    await expect(cancelTask(root, task.id, { expectedRevision: claimed.revision, reason: "强制抢占" })).rejects.toThrow("活跃租约");
    claimed.lease!.leaseUntil = new Date(Date.now() - 1_000).toISOString();
    await writeTaskPack(root, claimed);
    const cancelledExpired = await cancelTask(root, task.id, { expectedRevision: claimed.revision, reason: "执行窗口已关闭" });
    expect(cancelledExpired.status).toBe("cancelled");
    expect(cancelledExpired.lease).toBeUndefined();
    expect(cancelledExpired.cancellation).toEqual(expect.objectContaining({
      reason: "执行窗口已关闭",
      previousStatus: "claimed",
      previousLeaseId: claimed.lease?.id,
      previousOwner: "codex-cancel",
    }));

    const events = await listEvents(root);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "task.cancelled", taskId: readyTask.id, data: expect.objectContaining({ reason: "本批优先级调整", previousStatus: "ready" }) }),
      expect.objectContaining({ type: "task.lease-expired", taskId: task.id, data: expect.objectContaining({ action: "cancel", previousLeaseId: claimed.lease?.id }) }),
      expect.objectContaining({ type: "task.cancelled", taskId: task.id, data: expect.objectContaining({ reason: "执行窗口已关闭", previousStatus: "claimed" }) }),
    ]));
  });

  it("两个独立 Node 进程不能同时领取同一任务", async () => {
    const root = await project();
    const { task } = await createTaskPack(root, { kind: "image" });
    const executable = path.join(process.cwd(), "node_modules", ".bin", "tsx");
    const attempts = await Promise.allSettled([
      execFileAsync(executable, ["scripts/task-claim-worker.ts", root, task.id, "process-a", String(task.revision)], { cwd: process.cwd() }),
      execFileAsync(executable, ["scripts/task-claim-worker.ts", root, task.id, "process-b", String(task.revision)], { cwd: process.cwd() }),
    ]);
    expect(attempts.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const persisted = await readTaskPack(root, task.id);
    expect(["process-a", "process-b"]).toContain(persisted?.lease?.owner);
    expect(persisted?.revision).toBe(2);
  });

  it("awaiting_review 任务的产物同路径漂移后即使新验收通过也不能完成旧批次", async () => {
    const root = await project();
    const itemId = "main-ep03-unit001";
    const { task } = await createTaskPack(root, { itemIds: [itemId], kind: "image" });
    const claimed = await claimTask(root, task.id, { agentId: "codex-drift", expectedRevision: task.revision });
    const awaiting = await finishBatch(root, task.id, { leaseId: claimed.lease!.id, agentId: "codex-drift", expectedRevision: claimed.revision, completedItemIds: [itemId] });
    expect(awaiting.status).toBe("awaiting_review");
    const before = await getItem(root, itemId);
    const raw = before.artifacts.find((artifact) => artifact.authoritative && artifact.kind === "raw-image" && artifact.variant === "start")!;
    await sharp({ create: { width: 952, height: 1672, channels: 3, background: "#315878" } }).png({ compressionLevel: 0 }).toFile(raw.path);
    await scanAndPersist(root, { includeHashes: true });
    const entry = (await getReviewQueue(root)).find((candidate) => candidate.item.id === itemId)!;
    const artifactIds = entry.artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated && ["raw-image", "labeled-image"].includes(artifact.kind)).map((artifact) => artifact.id);
    const criteria = (["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"] satisfies ReviewCriterionKey[]).map((key) => ({ key, result: "pass" as const }));
    await submitReview(root, { itemId, reviewType: "image", artifactIds, ...await reviewSnapshot(root, itemId, artifactIds), decision: "pass", criteria, note: "漂移后的新内容验收通过" });
    await reconcileTaskReviews(root, itemId);
    expect((await readTaskPack(root, task.id))?.status).toBe("awaiting_review");
  });

  it("旧验收和 pause=false 都不能跳过本批视觉门禁", async () => {
    const root = await project();
    const itemId = "main-ep03-unit001";
    const before = await getItem(root, itemId);
    const imageArtifacts = before.artifacts.filter((artifact) => artifact.kind.includes("image") && artifact.authoritative && !artifact.deprecated);
    const oldArtifactIds = imageArtifacts.map((artifact) => artifact.id);
    const criteria = (["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"] satisfies ReviewCriterionKey[]).map((key) => ({ key, result: "pass" as const }));
    await submitReview(root, { itemId, reviewType: "image", artifactIds: oldArtifactIds, ...await reviewSnapshot(root, itemId, oldArtifactIds), decision: "pass", criteria, note: "旧版本验收" });
    await updateStatus(root, itemId, "待视觉验收", "出现新版本，需要本批重新验收");
    const config = await ensureSidecar(root);
    config.automation.pauseAfterVisualBatch = false;
    await writeJsonAtomic(getSidecarPaths(root).config, config);
    await scanAndPersist(root);
    const { task } = await createTaskPack(root, { itemIds: [itemId], kind: "image" });
    expect(task.boundary?.pauseAfterVisualReview).toBe(false);
    const claimed = await claimTask(root, task.id, { agentId: "codex-review-gate", expectedRevision: task.revision });
    const awaiting = await finishBatch(root, task.id, { leaseId: claimed.lease!.id, agentId: "codex-review-gate", expectedRevision: claimed.revision, completedItemIds: [itemId] });
    expect(awaiting.status).toBe("awaiting_review");
    await reconcileTaskReviews(root, itemId);
    expect((await readTaskPack(root, task.id))?.status).toBe("awaiting_review");
    const current = await getItem(root, itemId);
    const currentArtifactIds = current.artifacts.filter((artifact) => artifact.kind.includes("image") && artifact.authoritative && !artifact.deprecated).map((artifact) => artifact.id);
    await submitReview(root, { itemId, reviewType: "image", artifactIds: currentArtifactIds, ...await reviewSnapshot(root, itemId, currentArtifactIds), decision: "pass", criteria, note: "本批新验收" });
    expect((await readTaskPack(root, task.id))?.status).toBe("completed");
  });

  it("存在但未映射到目标节点的文件不能虚报登记成功", async () => {
    const root = await project();
    const unmapped = path.join(root, "unmapped_raw.png");
    await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#333333" } }).png().toFile(unmapped);
    await expect(registerArtifact(root, { itemId: "main-ep03-unit001", artifactPath: unmapped, kind: "raw-image", variant: "generic" })).rejects.toThrow("拒绝虚报已登记");
  });
});
