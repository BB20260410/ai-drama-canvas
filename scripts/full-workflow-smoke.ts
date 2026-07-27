import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import {
  analyzeNovelChapters,
  exportAdaptation,
  generateAdaptationPlans,
  materializeSelectedAdaptationPlan,
  selectAdaptationPlan,
} from "../src/core/adaptation.js";
import { applyEditOperation, createEditProject, listVideoContinuationPacks, prepareTimelineVideoContinuation, renderEditProject } from "../src/core/editor.js";
import { enqueueGeneration, processGenerationQueue } from "../src/core/generation.js";
import { commitProjectImport, prepareProjectImport } from "../src/core/importer.js";
import { getProductionWorkflow, updateProductionWorkflowStage, upsertCreativeBible, upsertStoryboardRow } from "../src/core/production.js";
import { getReviewQueue, submitReview } from "../src/core/reviews.js";
import { getSidecarPaths, readTaskPack } from "../src/core/sidecar.js";
import { claimTask, createTaskPack, finishBatch, getItem, getProjectIndex } from "../src/core/service.js";
import { importStoryFile, upsertStoryEvent } from "../src/core/story.js";
import type { ReviewCriterionKey, StoryboardRow } from "../src/core/types.js";
import { resetOwnedFixtureRoot } from "./lib/owned-fixture-root.js";

const execFileAsync = promisify(execFile);
const imageCriteria: ReviewCriterionKey[] = ["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"];
const videoCriteria: ReviewCriterionKey[] = ["character_identity", "hard_lock", "prop_costume", "scene_continuity", "motion_continuity", "duration_audio", "image_quality"];

function confirmInput(row: StoryboardRow): Omit<StoryboardRow, "id" | "revision" | "createdAt" | "updatedAt"> & { id: string; expectedRevision: number } {
  const { id, revision, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = row;
  return { ...input, id, expectedRevision: revision, status: "confirmed" };
}

async function createGeneratedImage(filePath: string, color: string): Promise<void> {
  await sharp({ create: { width: 720, height: 1280, channels: 3, background: color } }).png({ compressionLevel: 0 }).toFile(filePath);
}

async function settleFolderImage(projectRoot: string, taskId: string, itemId: string, color: string): Promise<void> {
  const [created] = await enqueueGeneration(projectRoot, { itemIds: [itemId], kind: "image", taskId });
  if (!created) throw new Error("图片生成任务没有创建。 ");
  const submitted = await processGenerationQueue(projectRoot);
  const waiting = submitted.find((job) => job.id === created.id);
  if (!waiting || waiting.status !== "waiting_external") throw new Error("图片生成任务没有进入文件桥接等待态。 ");
  await createGeneratedImage(waiting.expectedOutputPath, color);
  const completed = await processGenerationQueue(projectRoot);
  if (completed.find((job) => job.id === created.id)?.status !== "succeeded") throw new Error("图片生成结果没有通过机械验收与发布登记。 ");
}

async function reviewSnapshot(projectRoot: string, itemId: string, artifactIds: string[]) {
  const entry = (await getReviewQueue(projectRoot, { includeResolved: true })).find((candidate) => candidate.item.id === itemId);
  if (!entry) throw new Error(`找不到验收节点：${itemId}`);
  return {
    expectedScanId: entry.reviewSnapshot.scanId,
    expectedArtifactHashes: Object.fromEntries(artifactIds.map((artifactId) => [artifactId, entry.reviewSnapshot.artifactHashes[artifactId]!])),
  };
}

export async function runFullWorkflow(projectRoot: string, registryPath: string): Promise<Record<string, unknown>> {
  const root = path.resolve(projectRoot);
  const registry = path.resolve(registryPath);
  process.env.AI_CANVAS_REGISTRY_PATH = registry;
  await Promise.all([resetOwnedFixtureRoot(root, "full-workflow-smoke"), rm(registry, { force: true })]);
  const novelPath = path.join(root, "01_雾河来客.md");
  await writeFile(novelPath, `# 第一章 雾河来客

清晨，阿航穿着黑袍走进雾河边的古老祭坛，浓雾贴着石阶缓慢流动。
嘟嘟守在门外，低声说：“别碰那副完整黄金面具。”
阿航想起师父的警告：完整黄金面具不得改成半面具，也不能遮掉一半脸。
忽然火光熄灭，水声从地底传来。阿航心中害怕，却仍伸手拿起黄金面具。
石门轰然关闭，嘟嘟冲进祭坛。阿航回头看向她，面具表面的金光照亮两人的脸。

# 第二章 门后回声

门后的黑暗里传来脚步声。嘟嘟举起火把，阿航将完整黄金面具护在胸前。
两人沿着右侧石壁前进，始终没有跨过中央裂缝。远处，一个披着祭司袍的人影停在雾中。
`, "utf8");
  const lockedAssetPath = path.join(root, "00_全剧资产锁定", "01_人物三视图", "完整黄金面具_权威.png");
  await mkdir(path.dirname(lockedAssetPath), { recursive: true });
  await createGeneratedImage(lockedAssetPath, "#b88a32");

  const preview = await prepareProjectImport({ primaryRoot: root, projectMode: "story_first", name: "雾河来客 · 全链路验收" });
  if (!preview.canImport) throw new Error(`项目预检失败：${preview.issues.map((issue) => issue.message).join("；")}`);
  await commitProjectImport({ previewId: preview.previewId, config: preview.config, projectMode: "story_first" });
  const imported = await importStoryFile(root, novelPath, "雾河来客");
  const confirmedEvent = await upsertStoryEvent(root, {
    chapterId: imported.chapters[0]!.id,
    title: "阿航进入祭坛并触碰完整黄金面具",
    description: "阿航无视警告进入祭坛，拿起完整黄金面具，引发石门关闭。",
    sourceExcerpt: "清晨，阿航穿着黑袍走进雾河边的古老祭坛，浓雾贴着石阶缓慢流动。",
    characters: ["阿航", "嘟嘟"],
    locations: ["雾河祭坛"],
    props: ["完整黄金面具"],
    status: "confirmed",
  }, "codex");
  const skeletonPath = path.join(root, "02_故事骨架.md");
  await writeFile(skeletonPath, `# 故事骨架\n\n来源事件：${confirmedEvent.id}\n\n阿航进入祭坛并触碰完整黄金面具，石门关闭；嘟嘟追入，两人必须沿右侧石壁寻找出口。\n`, "utf8");
  const analyzed = await analyzeNovelChapters(root, { expectedRevision: 0 });
  const generated = await generateAdaptationPlans(root, { expectedRevision: analyzed.revision, episode: 1, startUnit: 1 });
  const split = generated.plans.find((plan) => plan.mode === "split");
  if (!split || split.units.length < 2) throw new Error("测试小说没有生成至少两个拆分单元。 ");
  const selected = await selectAdaptationPlan(root, split.id, generated.workspace.revision);
  const materialized = await materializeSelectedAdaptationPlan(root, { expectedRevision: selected.revision });
  for (const row of materialized.storyboardRows) await upsertStoryboardRow(root, confirmInput(row), "codex");
  await upsertCreativeBible(root, { kind: "director", name: "雾河来客导演 Bible", summary: "压迫感逐步增强，以阿航触碰面具后的因果变化为镜头核心。", rules: ["镜头变化必须服务冲突升级", "对话保持轴线与视线连续"], forbidden: ["无叙事理由的跳轴"], referencePaths: [skeletonPath] }, "codex");
  await upsertCreativeBible(root, { kind: "visual", name: "雾河来客视觉 Bible", summary: "电影写实、冷雾与暖火对比，完整黄金面具始终保持全脸完整形态。", rules: ["阿航黑袍连续", "完整黄金面具不得改成半面具"], forbidden: ["半面具", "随意换脸"], referencePaths: [lockedAssetPath] }, "codex");

  const index = await getProjectIndex(root);
  const units = index.items.filter((item) => item.type === "unit" && item.episode === 1).sort((a, b) => (a.unit ?? 0) - (b.unit ?? 0));
  const assetItems = index.items.filter((item) => item.type === "asset");
  const firstUnit = units[0];
  const continuationUnit = units[1];
  if (!firstUnit || !continuationUnit) throw new Error("物化后没有找到两个真实生产单元。 ");
  if (!assetItems.length) throw new Error("真实硬锁参考没有进入扫描索引。 ");

  const sidecar = getSidecarPaths(root);
  let productionWorkflow = await getProductionWorkflow(root);
  productionWorkflow = await updateProductionWorkflowStage(root, { stageId: "source", status: "completed", evidencePaths: [imported.source.snapshotPath], expectedRevision: productionWorkflow.revision }, "codex");
  productionWorkflow = await updateProductionWorkflowStage(root, { stageId: "chapters", status: "completed", evidencePaths: imported.chapters.map((chapter) => chapter.path), expectedRevision: productionWorkflow.revision }, "codex");
  productionWorkflow = await updateProductionWorkflowStage(root, { stageId: "events", status: "completed", evidencePaths: [sidecar.storyEvents], expectedRevision: productionWorkflow.revision }, "codex");
  productionWorkflow = await updateProductionWorkflowStage(root, { stageId: "skeleton", status: "completed", evidencePaths: [skeletonPath], expectedRevision: productionWorkflow.revision }, "codex");
  productionWorkflow = await updateProductionWorkflowStage(root, { stageId: "adaptation", status: "completed", evidencePaths: [sidecar.storyAdaptation], expectedRevision: productionWorkflow.revision }, "codex");
  productionWorkflow = await updateProductionWorkflowStage(root, { stageId: "episodes", status: "completed", evidencePaths: units.map((unit) => unit.infoPath!).filter(Boolean), itemIds: units.map((unit) => unit.id), expectedRevision: productionWorkflow.revision }, "codex");
  productionWorkflow = await updateProductionWorkflowStage(root, { stageId: "director", status: "completed", evidencePaths: [skeletonPath], expectedRevision: productionWorkflow.revision }, "codex");
  productionWorkflow = await updateProductionWorkflowStage(root, { stageId: "visual_bible", status: "completed", evidencePaths: [lockedAssetPath], expectedRevision: productionWorkflow.revision }, "codex");
  productionWorkflow = await updateProductionWorkflowStage(root, { stageId: "assets", status: "completed", evidencePaths: [lockedAssetPath], itemIds: assetItems.map((item) => item.id), expectedRevision: productionWorkflow.revision }, "codex");
  productionWorkflow = await updateProductionWorkflowStage(root, { stageId: "storyboard", status: "completed", evidencePaths: [sidecar.storyboards], itemIds: units.map((unit) => unit.id), expectedRevision: productionWorkflow.revision }, "codex");

  const imageItemIds = units.map((unit) => unit.id);
  const { task: imageTask } = await createTaskPack(root, { itemIds: imageItemIds, kind: "image", mode: "autopilot" });
  const claimedImageTask = await claimTask(root, imageTask.id, { agentId: "full-workflow-smoke", expectedRevision: imageTask.revision });
  for (const [position, unit] of units.entries()) {
    await settleFolderImage(root, imageTask.id, unit.id, position % 2 ? "#41634f" : "#31485f");
    if ((await getItem(root, unit.id)).item.status !== "待尾帧") throw new Error(`${unit.id} 首帧落盘后没有推进到待尾帧。`);
  }
  for (const [position, unit] of units.entries()) {
    await settleFolderImage(root, imageTask.id, unit.id, position % 2 ? "#8b663c" : "#a87931");
    if ((await getItem(root, unit.id)).item.status !== "待视觉验收") throw new Error(`${unit.id} 尾帧落盘后没有进入视觉验收。`);
  }

  const awaitingImageReview = await finishBatch(root, imageTask.id, {
    leaseId: claimedImageTask.lease!.id,
    agentId: "full-workflow-smoke",
    expectedRevision: claimedImageTask.revision,
    completedItemIds: imageItemIds,
    note: "真实首尾帧已通过图片解码、尺寸、SHA-256 与 raw/labeled 配对检查。",
  });
  for (const unit of units) {
    const imageArtifactIds = awaitingImageReview.result?.reviewRequirements?.[unit.id]?.artifactIds ?? [];
    await submitReview(root, { itemId: unit.id, reviewType: "image", artifactIds: imageArtifactIds, ...await reviewSnapshot(root, unit.id, imageArtifactIds), decision: "pass", criteria: imageCriteria.map((key) => ({ key, result: "pass" })), note: "隔离夹具视觉验收通过。" }, "codex");
  }
  if ((await readTaskPack(root, imageTask.id))?.status !== "completed") throw new Error("图片任务包没有在视觉验收后完成。 ");

  let workflow = await getProductionWorkflow(root);
  workflow = await updateProductionWorkflowStage(root, { stageId: "frames", status: "completed", expectedRevision: workflow.revision, note: "真实首尾帧和视觉验收记录齐全。" }, "codex");
  if (workflow.stages.find((stage) => stage.id === "frames")?.status !== "completed") throw new Error("首尾帧生产门禁没有完成。 ");

  const { task: videoTask } = await createTaskPack(root, { itemIds: [firstUnit.id], kind: "video", mode: "autopilot" });
  const claimedVideoTask = await claimTask(root, videoTask.id, { agentId: "full-workflow-smoke", expectedRevision: videoTask.revision });
  const [videoJob] = await enqueueGeneration(root, { itemIds: [firstUnit.id], kind: "video", taskId: videoTask.id });
  if (!videoJob) throw new Error("视频生成任务没有创建。 ");
  const submittedVideos = await processGenerationQueue(root);
  const waitingVideo = submittedVideos.find((job) => job.id === videoJob.id);
  if (!waitingVideo || waitingVideo.status !== "waiting_external") throw new Error("视频任务没有进入文件桥接等待态。 ");
  await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=24000/1001", "-t", "1.25", "-c:v", "libx264", "-pix_fmt", "yuv420p", waitingVideo.expectedOutputPath]);
  const completedVideos = await processGenerationQueue(root);
  if (completedVideos.find((job) => job.id === videoJob.id)?.status !== "succeeded") throw new Error("视频没有通过 ffprobe 与发布登记。 ");
  const awaitingVideoReview = await finishBatch(root, videoTask.id, {
    leaseId: claimedVideoTask.lease!.id,
    agentId: "full-workflow-smoke",
    expectedRevision: claimedVideoTask.revision,
    completedItemIds: [firstUnit.id],
    note: "真实视频已落盘并通过 ffprobe 机械验收。",
  });
  const videoArtifactIds = awaitingVideoReview.result?.reviewRequirements?.[firstUnit.id]?.artifactIds ?? [];
  await submitReview(root, { itemId: firstUnit.id, reviewType: "video", artifactIds: videoArtifactIds, ...await reviewSnapshot(root, firstUnit.id, videoArtifactIds), decision: "pass", criteria: videoCriteria.map((key) => ({ key, result: "pass" })), note: "隔离夹具视频视觉验收通过。" }, "codex");
  if ((await getItem(root, firstUnit.id)).item.status !== "已完成") throw new Error("视频视觉验收后节点没有完成。 ");

  const editProject = await createEditProject(root, { name: "EP01 全链路成片", episode: 1, width: 360, height: 640, fps: 23.976 });
  const sourceClip = editProject.tracks.find((track) => track.kind === "visual")?.clips[0];
  if (!sourceClip || sourceClip.kind !== "video") throw new Error("剪辑工程没有自动载入权威视频。 ");
  const splitAt = Math.min(0.5, sourceClip.durationSeconds / 2);
  const splitEdit = await applyEditOperation(root, editProject.id, editProject.revision, { type: "split_clip", clipId: sourceClip.id, timeSeconds: splitAt }, "codex");
  const render = await renderEditProject(root, editProject.id, { expectedRevision: splitEdit.project.revision });
  if (render.status !== "succeeded") throw new Error(`剪辑导出失败：${render.error ?? "未知错误"}`);

  const preparedContinuation = await prepareTimelineVideoContinuation(root, {
    editProjectId: editProject.id,
    targetItemId: continuationUnit.id,
    expectedRevision: splitEdit.project.revision,
    prompt: "承接上一段最后一帧，人物继续沿右侧石壁前进，保持完整黄金面具、运动方向和雾中光线连续。",
    enqueue: true,
  });
  if (!preparedContinuation.generationJob) throw new Error("时间线末帧没有创建续接生成任务。 ");
  const submittedContinuations = await processGenerationQueue(root);
  const waitingContinuation = submittedContinuations.find((job) => job.id === preparedContinuation.generationJob!.id);
  if (!waitingContinuation || waitingContinuation.status !== "waiting_external") throw new Error("视频续接任务没有进入文件桥接等待态。 ");
  await copyFile(render.outputPath, waitingContinuation.expectedOutputPath);
  const completedContinuations = await processGenerationQueue(root);
  if (completedContinuations.find((job) => job.id === preparedContinuation.generationJob!.id)?.status !== "succeeded") throw new Error("视频续接结果没有完成机械验收与回填。 ");
  const continuation = (await listVideoContinuationPacks(root)).find((entry) => entry.id === preparedContinuation.pack.id);
  if (continuation?.status !== "completed") throw new Error("生成完成后续接包没有自动同步为 completed。 ");

  const exportDirectory = path.join(root, "导出");
  await mkdir(exportDirectory, { recursive: true });
  const jsonPath = path.join(exportDirectory, "雾河来客_全链路分镜_v001.json");
  const markdownPath = path.join(exportDirectory, "雾河来客_全链路分镜_v001.md");
  await exportAdaptation(root, { format: "json", outputPath: jsonPath, planId: split.id });
  await exportAdaptation(root, { format: "markdown", outputPath: markdownPath, planId: split.id });
  if ((JSON.parse(await readFile(jsonPath, "utf8")) as { plan?: { id?: string } }).plan?.id !== split.id) throw new Error("JSON 导出没有保留选定计划。 ");

  const verifier = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const verification = await execFileAsync(verifier, ["scripts/full-workflow-verify.ts", root, editProject.id, split.id, jsonPath, markdownPath, continuation.id], {
    cwd: process.cwd(),
    env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registry },
    maxBuffer: 2_000_000,
  });
  const restart = JSON.parse(verification.stdout) as Record<string, unknown>;
  return {
    root,
    registryPath: registry,
    novelPath,
    sourceId: imported.source.id,
    chapters: imported.chapters.length,
    facts: analyzed.facts.length,
    beats: analyzed.beats.length,
    conciseUnits: generated.plans.find((plan) => plan.mode === "concise")?.units.length ?? 0,
    splitUnits: split.units.length,
    firstCompletedItemId: firstUnit.id,
    continuationItemId: continuationUnit.id,
    imageTaskId: imageTask.id,
    videoTaskId: videoTask.id,
    editProjectId: editProject.id,
    editRevision: splitEdit.project.revision,
    renderPath: render.outputPath,
    continuationId: continuation.id,
    continuationOutputPath: continuation.outputVideoPath,
    jsonPath,
    markdownPath,
    restartVerified: true,
    restart,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const defaultSuffix = `${process.pid}-${randomUUID()}`;
  const root = path.resolve(process.argv[2] || path.join(os.tmpdir(), `ai-canvas-full-workflow-${defaultSuffix}`));
  const registry = path.resolve(process.argv[3] || path.join(os.tmpdir(), `ai-canvas-full-workflow-registry-${defaultSuffix}.json`));
  process.stdout.write(`${JSON.stringify(await runFullWorkflow(root, registry), null, 2)}\n`);
}
