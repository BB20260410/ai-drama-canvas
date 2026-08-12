import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitProjectImport, prepareProjectImport } from "../src/core/importer.js";
import { reviewNovelAnalysisBatch } from "../src/core/novel-analysis.js";
import { executeNextNovelAnalysisRunTask, getNovelAnalysisRunProgress, listNovelAnalysisRunProgress, planNovelAnalysisRun, upsertNovelAnalysisProvider } from "../src/core/novel-analysis-provider.js";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { importStoryFile } from "../src/core/story.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-long-run-"));
  roots.push(root);
  const line = (index: number) => `第${index}次钟声响起，阿航握紧完整黄金面具，嘟嘟提醒他不要越过石门。`;
  const novelPath = path.join(root, "长篇小说.md");
  await writeFile(novelPath, [
    "# 第一章 雾门",
    ...Array.from({ length: 18 }, (_, index) => line(index + 1)),
    "# 第二章 长夜",
    ...Array.from({ length: 75 }, (_, index) => line(index + 101)),
    "# 第三章 火种",
    ...Array.from({ length: 18 }, (_, index) => line(index + 201)),
  ].join("\n"), "utf8");
  const preview = await prepareProjectImport({ primaryRoot: root, projectMode: "story_first", name: "长篇模型批次测试" });
  await commitProjectImport({ previewId: preview.previewId, config: preview.config, projectMode: "story_first" });
  await importStoryFile(root, novelPath, "长篇小说");
  await upsertNovelAnalysisProvider(root, {
    expectedRevision: 0,
    provider: { id: "mock-long", name: "长篇测试模型", adapter: "mock", enabled: true, model: "deterministic-mock", allowPrivateNetwork: false, allowStoryUpload: false, useJsonResponseFormat: true, timeoutSeconds: 10, maxInputCharacters: 1_200, temperature: 0 },
    setAsDefault: true,
  });
  return root;
}

describe("长篇小说可恢复模型批次", () => {
  it("超长单章按绝对区间分段，顺序装箱且不会静默截断", async () => {
    const root = await fixture();
    const result = await planNovelAnalysisRun(root, { expectedRevision: 0, providerId: "mock-long", targetCharacters: 1_000, maxChaptersPerBatch: 3 });
    expect(result.tasks.length).toBeGreaterThan(3);
    expect(result.progress).toMatchObject({ status: "ready", nextTaskId: result.tasks[0]!.id, completedBatches: 0 });
    expect(result.tasks.every((task, index) => task.batchIndex === index + 1 && task.batchCount === result.tasks.length && (task.plannedCharacterCount ?? Infinity) <= 1_000)).toBe(true);
    expect(result.tasks.every((task) => task.providerRevisionSnapshot === 1 && task.maxInputCharactersSnapshot === 1_200)).toBe(true);
    await Promise.all(result.tasks.flatMap((task) => [expect(access(task.taskJsonPath)).resolves.toBeUndefined(), expect(access(task.taskMarkdownPath)).resolves.toBeUndefined()]));

    const refsByChapter = new Map<string, typeof result.tasks[number]["chapterRefs"]>();
    for (const task of result.tasks) for (const ref of task.chapterRefs) refsByChapter.set(ref.chapterId, [...(refsByChapter.get(ref.chapterId) ?? []), ref]);
    const segmented = [...refsByChapter.values()].find((refs) => refs.length > 1)!;
    const ordered = [...segmented].sort((left, right) => (left.startOffset ?? 0) - (right.startOffset ?? 0));
    const chapterText = (await readFile(ordered[0]!.path, "utf8")).replace(/\n$/, "");
    expect(ordered[0]!.startOffset).toBe(0);
    expect(ordered.at(-1)!.endOffset).toBe(chapterText.length);
    for (let index = 1; index < ordered.length; index += 1) expect(ordered[index]!.startOffset).toBe(ordered[index - 1]!.endOffset);
    expect(ordered.reduce((sum, ref) => sum + (ref.characterCount ?? 0), 0)).toBe(chapterText.length);
    const taskJson = await readFile(result.tasks.find((task) => task.chapterRefs.some((ref) => ref.segmentCount && ref.segmentCount > 1))!.taskJsonPath, "utf8");
    expect(taskJson).toContain("startOffset");
    expect(taskJson).toContain("绝对偏移");
  });

  it("每次只执行一个批次，人工确认后解锁下一批并在重启读取时恢复", async () => {
    const root = await fixture();
    const planned = await planNovelAnalysisRun(root, { expectedRevision: 0, providerId: "mock-long", targetCharacters: 1_000, maxChaptersPerBatch: 2 });
    const first = await executeNextNovelAnalysisRunTask(root, { runId: planned.runId, expectedRevision: planned.workspace.revision });
    expect(first.outcome).toBe("reviewing");
    expect(first.task.batchIndex).toBe(1);
    expect(first.progress.status).toBe("awaiting_review");
    expect(first.progress.nextTaskId).toBeUndefined();
    await expect(executeNextNovelAnalysisRunTask(root, { runId: planned.runId, expectedRevision: first.workspace.revision })).rejects.toThrow("等待人工确认");

    const pending = first.workspace.analysisReviews.filter((review) => review.taskId === first.task.id && review.status === "pending");
    const accepted = await reviewNovelAnalysisBatch(root, { expectedRevision: first.workspace.revision, decisions: pending.map((review) => ({ reviewId: review.id, decision: "accepted", reviewExpectedRevision: review.revision })) });
    const recovered = await getNovelAnalysisRunProgress(root, planned.runId);
    expect(recovered).toMatchObject({ status: "ready", completedBatches: 1, nextTaskId: planned.tasks[1]!.id });
    expect((await listNovelAnalysisRunProgress(root))[0]).toEqual(recovered);

    const second = await executeNextNovelAnalysisRunTask(root, { runId: planned.runId, expectedRevision: accepted.workspace.revision });
    const secondPending = second.workspace.analysisReviews.filter((review) => review.taskId === second.task.id && review.status === "pending");
    const acceptedSecond = await reviewNovelAnalysisBatch(root, { expectedRevision: second.workspace.revision, decisions: secondPending.map((review) => ({ reviewId: review.id, decision: "accepted", reviewExpectedRevision: review.revision })) });
    const orders = acceptedSecond.workspace.beats.map((beat) => beat.order).sort((left, right) => left - right);
    expect(orders[0]).toBe(1);
    expect(orders[1]).toBe(1_001);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("Provider 修订漂移后将运行标记失效而不是继续提交", async () => {
    const root = await fixture();
    const planned = await planNovelAnalysisRun(root, { expectedRevision: 0, providerId: "mock-long", targetCharacters: 1_000 });
    await upsertNovelAnalysisProvider(root, {
      expectedRevision: 1,
      provider: { id: "mock-long", name: "长篇测试模型 R2", adapter: "mock", enabled: true, model: "deterministic-mock-v2", allowPrivateNetwork: false, allowStoryUpload: false, useJsonResponseFormat: true, timeoutSeconds: 10, maxInputCharacters: 1_200, temperature: 0, revision: 1 },
    });
    const progress = await getNovelAnalysisRunProgress(root, planned.runId);
    expect(progress.status).toBe("stale");
    expect(progress.blocker).toContain("Provider");
    await expect(executeNextNovelAnalysisRunTask(root, { runId: planned.runId, expectedRevision: planned.workspace.revision })).rejects.toThrow("Provider");
  });

  it("命令账本重放不会重复创建长篇批次", async () => {
    const root = await fixture();
    const request = { command: "plan_novel_analysis_run" as const, payload: { expectedRevision: 0, providerId: "mock-long", targetCharacters: 1_000 } };
    const first = await executeIdempotentCommand(root, { requestId: "long-run-request-0001", idempotencyKey: "long-run-plan-key-0001", request });
    const replay = await executeIdempotentCommand(root, { requestId: "long-run-request-0002", idempotencyKey: "long-run-plan-key-0001", request });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect((await listNovelAnalysisRunProgress(root))).toHaveLength(1);
  });

  it("401 个真实章节可按稳定顺序规划且每批不超过章节上限", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-401-chapters-"));
    roots.push(root);
    const novelPath = path.join(root, "四百章.md");
    await writeFile(novelPath, Array.from({ length: 401 }, (_, index) => `# 第${index + 1}章\n阿航在第${index + 1}道石门前确认完整黄金面具仍然完好。`).join("\n"), "utf8");
    const preview = await prepareProjectImport({ primaryRoot: root, projectMode: "story_first", name: "401章长篇测试" });
    await commitProjectImport({ previewId: preview.previewId, config: preview.config, projectMode: "story_first" });
    await importStoryFile(root, novelPath, "四百章");
    await upsertNovelAnalysisProvider(root, { expectedRevision: 0, provider: { id: "mock-401", name: "401章测试模型", adapter: "mock", enabled: true, model: "deterministic-mock", allowPrivateNetwork: false, allowStoryUpload: false, useJsonResponseFormat: true, timeoutSeconds: 10, maxInputCharacters: 10_000, temperature: 0 } });
    const startedAt = Date.now();
    const planned = await planNovelAnalysisRun(root, { expectedRevision: 0, providerId: "mock-401", targetCharacters: 10_000, maxChaptersPerBatch: 8 });
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(planned.tasks).toHaveLength(51);
    expect(planned.tasks.every((task) => task.chapterRefs.length <= 8 && new Set(task.chapterRefs.map((ref) => ref.sourceId)).size === 1)).toBe(true);
    const refs = planned.tasks.flatMap((task) => task.chapterRefs);
    expect(refs).toHaveLength(401);
    expect(new Set(refs.map((ref) => ref.chapterId)).size).toBe(401);
    expect(planned.progress).toMatchObject({ status: "ready", totalBatches: 51, preparedBatches: 51 });
    // 2026-08-12（wq-0007 收口）：空载基线约 16.3s，恢复 20s 严格门。
    // 该门只用于稳定的单 worker 性能回归；不得与其他重型夹具并跑后据此放宽。
  }, 20_000);
});
