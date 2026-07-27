import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import { listScriptDocuments } from "../src/core/documents.js";
import { scanAndPersist } from "../src/core/service.js";
import { createShotTaskPack, getUnitTimelines, saveUnitTimeline } from "../src/core/timeline.js";
import { enqueueGeneration } from "../src/core/generation.js";
import { seedProductionReady } from "./workflow-helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-timeline-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  config.hardLocks = [];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const unit = path.join(root, "EP02_15s_003_祭祀场");
  await mkdir(unit, { recursive: true });
  await writeFile(path.join(unit, "00_信息.md"), "首帧提示词：祭祀场全景。\n尾帧提示词：火光升高。\n", "utf8");
  for (const [shot, duration] of [["01", 4], ["02", 5], ["03", 6]] as const) {
    const directory = path.join(unit, `EP02_镜${shot}_测试镜头`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "00_信息.md"), `镜头提示词：保持连续性。\n时长：${duration}秒\n`, "utf8");
  }
  await scanAndPersist(root);
  await seedProductionReady(root, "frames");
  return root;
}

describe("15 秒原镜头时间线", () => {
  it("从真实子目录推断顺序、父节点和总时长", async () => {
    const root = await project();
    const timeline = (await getUnitTimelines(root, 2)).find((value) => value.unitId === "main-ep02-unit003")!;
    expect(timeline.shots.map((entry) => entry.item.shot)).toEqual(["1", "2", "3"]);
    expect(timeline.shots.every((entry) => entry.item.parentId === timeline.unitId)).toBe(true);
    expect(timeline.shots.map((entry) => entry.timing.durationSeconds)).toEqual([4, 5, 6]);
    expect(timeline.totalDurationSeconds).toBe(15);
    expect(timeline.valid).toBe(true);
    const documents = await listScriptDocuments(root);
    expect(documents.filter((document) => document.itemType === "shot")).toHaveLength(3);
    expect(documents.find((document) => document.itemType === "shot")?.parentId).toBe(timeline.unitId);
    const cache = new DatabaseSync(getSidecarPaths(root).cache);
    const cached = cache.prepare("SELECT type, parent_id, shot FROM items WHERE id = ?").get(timeline.shots[0]!.item.id) as { type: string; parent_id: string; shot: string };
    cache.close();
    expect(cached).toEqual({ type: "shot", parent_id: timeline.unitId, shot: "1" });
  });

  it("保存人工顺序并创建只含同一父单元原镜头的任务包", async () => {
    const root = await project();
    const initial = (await getUnitTimelines(root, 2))[0]!;
    const reversed = [...initial.shots].reverse().map((entry, order) => ({ shotId: entry.item.id, order, durationSeconds: 5 }));
    const saved = await saveUnitTimeline(root, initial.unitId, reversed);
    expect(saved.shots.map((entry) => entry.item.id)).toEqual(reversed.map((entry) => entry.shotId));
    const { task } = await createShotTaskPack(root, initial.unitId);
    expect(task.kind).toBe("image");
    expect(task.itemIds).toEqual(reversed.map((entry) => entry.shotId));
    expect(task.itemIds).toHaveLength(3);
    expect(task.boundary).toMatchObject({ episode: 2, parentId: initial.unitId, pauseAfterVisualReview: true });
    expect(task.itemSnapshots.every((snapshot) => snapshot.type === "shot" && snapshot.parentId === initial.unitId)).toBe(true);
    expect(task.itemSnapshots.every((snapshot) => snapshot.suggestedOutputDirectory.startsWith(root))).toBe(true);
    expect(task.acceptanceCriteria).toContain("每个原镜头的 raw/labeled 成对，禁止用父单元图片冒充镜头结果");
    const jobs = await enqueueGeneration(root, { itemIds: reversed.map((entry) => entry.shotId), kind: "image", taskId: task.id });
    expect(jobs).toHaveLength(3);
    expect(jobs.every((job) => /EP02_镜0[1-3]_画面_.*_raw\.png$/.test(job.expectedOutputPath))).toBe(true);
    expect(jobs.every((job) => job.expectedCompanionPath?.endsWith("_labeled.png"))).toBe(true);
    await expect(enqueueGeneration(root, { itemIds: [initial.unitId, reversed[0]!.shotId], kind: "image" })).rejects.toThrow("不能混合");
  });

  it("拒绝超过 15 秒或与真实扫描不一致的编排", async () => {
    const root = await project();
    const timeline = (await getUnitTimelines(root, 2))[0]!;
    await expect(saveUnitTimeline(root, timeline.unitId, timeline.shots.map((entry, order) => ({ shotId: entry.item.id, order, durationSeconds: 6 })))).rejects.toThrow("超过 15 秒");
    await expect(saveUnitTimeline(root, timeline.unitId, [{ shotId: timeline.shots[0]!.item.id, order: 0, durationSeconds: 4 }])).rejects.toThrow("镜头集合");
  });
});
