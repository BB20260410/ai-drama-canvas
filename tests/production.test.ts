import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeChangeImpact, assertProductionWorkflowGate, getConfirmedStoryboardContracts, getProductionWorkflow, getStoryboard, listCreativeBibles, updateProductionWorkflowStage, upsertCreativeBible, upsertStoryboardRow } from "../src/core/production.js";
import { createTaskPack, getNextTask, getProjectIndex, scanAndPersist } from "../src/core/service.js";
import { enqueueGeneration } from "../src/core/generation.js";
import { ensureSidecar, getSidecarPaths, listEvents, writeJsonAtomic } from "../src/core/sidecar.js";
import { seedProductionReady } from "./workflow-helpers.js";
import { getReviewQueue, submitReview } from "../src/core/reviews.js";
import { importStoryFile } from "../src/core/story.js";
import type { ReviewCriterionKey } from "../src/core/types.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-production-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const unit = path.join(root, "EP01_15s_001_生产状态机");
  await mkdir(unit, { recursive: true });
  const infoPath = path.join(unit, "00_信息.md");
  await writeFile(infoPath, "# 生产状态机\n首帧提示词：角色进入。\n尾帧提示词：角色回头。\n", "utf8");
  await scanAndPersist(root);
  return { root, infoPath };
}

describe("内容生产状态机与正式分镜", () => {
  it("生产阶段与 Creative Bible 对既有事实强制 revision CAS", async () => {
    const { root, infoPath } = await fixture();
    const initial = await getProductionWorkflow(root);
    const workflowEventsBefore = (await listEvents(root, 200)).filter((event) => event.type === "production.workflow-stage-updated").length;

    await expect(updateProductionWorkflowStage(root, { stageId: "source", status: "in_progress" } as any)).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { applied: false, reason: "revision_required", entityType: "production_workflow", currentRevision: initial.revision },
    });
    await expect(updateProductionWorkflowStage(root, { stageId: "source", status: "in_progress", expectedRevision: initial.revision + 1 })).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { applied: false, reason: "revision_conflict", expectedRevision: initial.revision + 1, currentRevision: initial.revision },
    });
    expect((await getProductionWorkflow(root)).revision).toBe(initial.revision);
    expect((await listEvents(root, 200)).filter((event) => event.type === "production.workflow-stage-updated")).toHaveLength(workflowEventsBefore);

    const workflowRace = await Promise.allSettled([
      updateProductionWorkflowStage(root, { stageId: "source", status: "in_progress", note: "窗口 A", expectedRevision: initial.revision }),
      updateProductionWorkflowStage(root, { stageId: "source", status: "review", note: "窗口 B", expectedRevision: initial.revision }),
    ]);
    expect(workflowRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(workflowRace.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((workflowRace.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ name: "RejectedCommandFailure", result: { reason: "revision_conflict" } });
    expect((await getProductionWorkflow(root)).revision).toBe(initial.revision + 1);

    await expect(upsertCreativeBible(root, { kind: "director", name: "非法创建", summary: "create 不得携带 revision", expectedRevision: 1 } as any)).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { applied: false, reason: "invalid_create_revision", entityType: "creative_bible" },
    });
    const bible = await upsertCreativeBible(root, { kind: "director", name: "导演总则", summary: "连续性优先", rules: ["角色稳定"], forbidden: ["换脸"], referencePaths: [infoPath], tags: ["全剧"] });
    await expect(upsertCreativeBible(root, { id: "", kind: bible.kind, name: bible.name, summary: bible.summary, expectedRevision: bible.revision } as any)).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { applied: false, reason: "invalid_id" } });
    await expect(upsertCreativeBible(root, { id: "bible-missing", kind: bible.kind, name: bible.name, summary: bible.summary, expectedRevision: 1 })).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { applied: false, reason: "not_found", entityId: "bible-missing" } });
    await expect(upsertCreativeBible(root, { id: bible.id, kind: bible.kind, name: bible.name, summary: bible.summary } as any)).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { applied: false, reason: "revision_required", currentRevision: bible.revision } });
    await expect(upsertCreativeBible(root, { id: bible.id, kind: bible.kind, name: bible.name, summary: bible.summary, expectedRevision: bible.revision + 1 })).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { applied: false, reason: "revision_conflict", currentRevision: bible.revision } });

    const bibleRace = await Promise.allSettled([
      upsertCreativeBible(root, { id: bible.id, kind: bible.kind, name: "窗口 A", summary: bible.summary, expectedRevision: bible.revision }),
      upsertCreativeBible(root, { id: bible.id, kind: bible.kind, name: "窗口 B", summary: bible.summary, expectedRevision: bible.revision }),
    ]);
    expect(bibleRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(bibleRace.filter((result) => result.status === "rejected")).toHaveLength(1);
    const persistedBible = (await listCreativeBibles(root)).find((candidate) => candidate.id === bible.id)!;
    expect(persistedBible.revision).toBe(bible.revision + 1);
    expect(persistedBible.tags).toEqual(["全剧"]);
    expect(persistedBible.rules).toEqual(["角色稳定"]);
  });

  it("阶段完成必须有真实证据和前置门禁", async () => {
    const { root } = await fixture();
    const novelPath = path.join(root, "生产状态机小说.txt");
    await writeFile(novelPath, "第一章 雾中来客\n\n阿航握紧完整黄金面具，听见门后传来脚步声。\n", "utf8");
    const imported = await importStoryFile(root, novelPath);
    const initial = await getProductionWorkflow(root);
    expect(initial.stages.map((stage) => stage.id)).toEqual(["source", "chapters", "events", "skeleton", "adaptation", "episodes", "director", "visual_bible", "assets", "storyboard", "frames", "video", "edit", "review", "publish"]);
    expect(initial.stages.every((stage) => stage.inputRequirements.length && stage.outputRequirements.length && stage.acceptanceCriteria.length && stage.failurePaths.length && stage.nextActions.length)).toBe(true);
    const sourceDone = await updateProductionWorkflowStage(root, { stageId: "source", status: "completed", evidencePaths: [imported.source.snapshotPath], expectedRevision: 0 });
    expect(sourceDone.stages[0]?.status).toBe("completed");
    expect(sourceDone.stages[0]?.evidenceVerification?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await expect(updateProductionWorkflowStage(root, { stageId: "events", status: "completed", expectedRevision: sourceDone.revision })).rejects.toThrow("前置阶段尚未完成：章节拆分");
    const chaptersReview = await updateProductionWorkflowStage(root, { stageId: "chapters", status: "review", note: "等待章节确认", expectedRevision: sourceDone.revision });
    await expect(updateProductionWorkflowStage(root, { stageId: "events", status: "completed", expectedRevision: chaptersReview.revision })).rejects.toThrow("前置阶段尚未完成：章节拆分");
    const eventsWorking = await updateProductionWorkflowStage(root, { stageId: "events", status: "in_progress", note: "等待人工确认", expectedRevision: chaptersReview.revision });
    expect(eventsWorking.stages.find((stage) => stage.id === "events")?.status).toBe("in_progress");
  });

  it("完成阶段的原文快照漂移会被实时审计并阻断后续领取", async () => {
    const { root } = await fixture();
    const novelPath = path.join(root, "证据漂移小说.md");
    await writeFile(novelPath, "# 第一章\n\n阿航走入雾中，嘟嘟守在门边。\n", "utf8");
    const imported = await importStoryFile(root, novelPath);
    let workflow = await getProductionWorkflow(root);
    workflow = await updateProductionWorkflowStage(root, { stageId: "source", status: "completed", evidencePaths: [imported.source.snapshotPath], expectedRevision: workflow.revision });
    await seedProductionReady(root, "storyboard");

    await writeFile(imported.source.snapshotPath, "# 第一章\n\n快照被外部改写。\n", "utf8");
    const audited = await getProductionWorkflow(root, { includeEvidenceAudit: true });
    const sourceAudit = audited.evidenceAudit?.stages.find((stage) => stage.stageId === "source");
    expect(sourceAudit).toMatchObject({ ready: false, statusEvidenceValid: false, legacyUnverified: false });
    expect(sourceAudit?.issues.join("；")).toContain("原文快照哈希失配");
    await expect(updateProductionWorkflowStage(root, { stageId: "chapters", status: "completed", expectedRevision: audited.revision })).rejects.toThrow("前置阶段真实证据已失效");
    await expect(getNextTask(root)).rejects.toThrow("生产工作流真实证据已失效");
  });

  it("读取实时证据审计不会创建渲染侧车或遗留写锁", async () => {
    const { root } = await fixture();
    const paths = getSidecarPaths(root);
    await rm(paths.editorRenders, { force: true });
    const audited = await getProductionWorkflow(root, { includeEvidenceAudit: true });
    expect(audited.evidenceAudit?.stages).toHaveLength(15);
    await expect(access(paths.editorRenders)).rejects.toThrow();
    const lockNames = await readdir(path.join(root, ".aicanvas", "locks")).catch(() => [] as string[]);
    expect(lockNames.filter((name) => name.startsWith("editor-renders"))).toEqual([]);
  });

  it("只有完成正式分镜门禁后才可领任务，分镜合同进入任务包与生成任务", async () => {
    const { root, infoPath } = await fixture();
    await expect(getNextTask(root)).rejects.toThrow("生产工作流门禁未通过");
    const assetPath = path.join(path.dirname(infoPath), "角色参考_raw.png");
    await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#82634b" } }).png().toFile(assetPath);
    await scanAndPersist(root);
    const referenceArtifact = (await getProjectIndex(root)).artifacts.find((artifact) => artifact.path === assetPath)!;
    const row = await upsertStoryboardRow(root, {
      itemId: "main-ep01-unit001",
      order: 1,
      durationSeconds: 15,
      shotSize: "中景",
      cameraMovement: "缓慢推进",
      action: "角色进入后回头",
      firstFramePrompt: "正式首帧提示词",
      endFramePrompt: "正式尾帧提示词",
      videoPrompt: "正式视频提示词",
      referencePaths: [infoPath],
      referenceArtifactIds: [referenceArtifact.id],
      status: "confirmed",
    });
    await seedProductionReady(root, "storyboard");
    await expect(createTaskPack(root, { kind: "video" })).rejects.toThrow("首尾帧生产（not_started）");
    await expect(enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "video" })).rejects.toThrow("首尾帧生产（not_started）");
    const next = await getNextTask(root);
    const { task } = await createTaskPack(root, { itemIds: [next[0]!.id], kind: "image" });
    expect(task.itemSnapshots[0]?.storyboardRows[0]).toMatchObject({ storyboardRowId: row.id, firstFramePrompt: "正式首帧提示词" });
    expect(task.itemSnapshots[0]?.storyboardRows[0]?.referenceArtifactIds).toContain(referenceArtifact.id);
    expect(task.itemSnapshots[0]?.referencePaths).toContain(infoPath);
    const [job] = await enqueueGeneration(root, { itemIds: [next[0]!.id], kind: "image", taskId: task.id });
    expect(job?.prompt).toBe("正式尾帧提示词");
    expect(job?.storyboardRows[0]?.storyboardRowId).toBe(row.id);
    expect(job?.references?.some((reference) => reference.artifactId === referenceArtifact.id)).toBe(true);
    expect(job?.referencePaths).toContain(infoPath);
    await upsertStoryboardRow(root, { id: row.id, expectedRevision: row.revision, itemId: row.itemId, order: row.order, durationSeconds: row.durationSeconds, shotSize: row.shotSize, cameraMovement: row.cameraMovement, action: row.action, firstFramePrompt: "修改后的首帧提示词", endFramePrompt: row.endFramePrompt, videoPrompt: row.videoPrompt, referencePaths: row.referencePaths, referenceArtifactIds: row.referenceArtifactIds, status: "confirmed" });
    await expect(enqueueGeneration(root, { itemIds: [next[0]!.id], kind: "image", taskId: task.id })).rejects.toThrow("正式分镜已变化");
  });

  it("Bible、正式分镜和变更影响均绑定真实节点", async () => {
    const { root, infoPath } = await fixture();
    const bible = await upsertCreativeBible(root, { kind: "director", name: "导演总则", summary: "电影写实与连续性优先。", rules: ["角色身份稳定", "完整黄金面具不可改变"], forbidden: ["半面具"], referencePaths: [infoPath], tags: ["全剧"] });
    expect((await listCreativeBibles(root, "director"))[0]?.id).toBe(bible.id);
    const row = await upsertStoryboardRow(root, { itemId: "main-ep01-unit001", order: 1, durationSeconds: 6, shotSize: "中景", cameraMovement: "缓慢推进", action: "角色进入并回头", dialogue: "这里不对。", firstFramePrompt: "角色进入", endFramePrompt: "角色回头", videoPrompt: "保持动作连续", referencePaths: [infoPath], status: "confirmed" });
    expect(row.revision).toBe(1);
    const storyboard = await getStoryboard(root, "main-ep01-unit001");
    expect(storyboard.valid).toBe(true);
    expect(storyboard.totalDurationSeconds).toBe(6);
    await expect(upsertStoryboardRow(root, { itemId: "main-ep01-unit001", order: 2, durationSeconds: 1, shotSize: "", cameraMovement: "固定", action: "测试", firstFramePrompt: "首帧", endFramePrompt: "尾帧", videoPrompt: "视频", referencePaths: [], status: "confirmed" })).rejects.toThrow("确认正式分镜前必须补齐：景别");
    await expect(upsertStoryboardRow(root, { itemId: "main-ep01-unit001", order: 2, durationSeconds: 1, shotSize: "特写", cameraMovement: "固定", action: "测试", firstFramePrompt: "首帧", endFramePrompt: "尾帧", videoPrompt: "视频", referencePaths: [path.join(root, "不存在.png")], status: "draft" })).rejects.toThrow("分镜参考路径不存在");
    await expect(upsertStoryboardRow(root, { itemId: "main-ep01-unit001", order: 1, durationSeconds: 1, shotSize: "特写", cameraMovement: "固定", action: "测试", firstFramePrompt: "首帧", endFramePrompt: "尾帧", videoPrompt: "视频", referencePaths: [], status: "draft" })).rejects.toThrow("重复分镜顺序");
    await expect(upsertStoryboardRow(root, { itemId: "main-ep01-unit001", order: 2, durationSeconds: 10, shotSize: "特写", cameraMovement: "固定", action: "面具发光", firstFramePrompt: "发光前", endFramePrompt: "发光后", videoPrompt: "光线渐强", referencePaths: [], status: "draft" })).rejects.toThrow("累计不能超过 15 秒");
    const impact = await analyzeChangeImpact(root, { targetType: "item", targetId: "main-ep01-unit001" });
    expect(impact.affectedItemIds).toContain("main-ep01-unit001");
    expect(impact.storyboardRows[0]?.id).toBe(row.id);
  });

  it("局部修订正式分镜时保留完整导演合同和参考资产", async () => {
    const { root, infoPath } = await fixture();
    const created = await upsertStoryboardRow(root, {
      itemId: "main-ep01-unit001", order: 1, durationSeconds: 6,
      shotSize: "近景", cameraMovement: "缓慢推进", cameraAngle: "右侧过肩", lens: "50mm", composition: "三分构图，人物位于右侧",
      staging: "阿航在前景转身，嘟嘟停在后景门边", action: "阿航举起完整黄金面具并回望", expression: "警觉", emotion: "克制的恐惧",
      eyeline: "阿航看向画面左侧的嘟嘟", screenDirection: "由右向左", axisSide: "轴线北侧",
      dialogue: "门后有人。", narration: "雾气压低了火光。", ambience: "低沉风声", soundEffects: ["金属轻响", "远处脚步"],
      continuityBefore: "承接阿航右手拿起面具", continuityAfter: "下一镜仍保持面具在右手", referenceNames: ["阿航", "完整黄金面具"],
      firstFramePrompt: "阿航右手持完整黄金面具", endFramePrompt: "阿航回头看向嘟嘟", videoPrompt: "缓慢推进，保持人物与完整黄金面具一致",
      referencePaths: [infoPath], referenceArtifactIds: [], directorIntent: "用过肩机位强化警觉", emotionalIntent: "恐惧中保持行动力", continuityNotes: ["完整面具不得变成半面具"], status: "confirmed",
    });

    await expect(upsertStoryboardRow(root, { id: created.id, dialogue: "不要回头。" })).rejects.toThrow("expectedRevision");
    const updated = await upsertStoryboardRow(root, { id: created.id, expectedRevision: created.revision, dialogue: "不要回头。" });
    expect(updated).toMatchObject({
      dialogue: "不要回头。", cameraAngle: created.cameraAngle, lens: created.lens, composition: created.composition, staging: created.staging,
      expression: created.expression, emotion: created.emotion, eyeline: created.eyeline, screenDirection: created.screenDirection, axisSide: created.axisSide,
      narration: created.narration, ambience: created.ambience, soundEffects: created.soundEffects, continuityBefore: created.continuityBefore,
      continuityAfter: created.continuityAfter, referenceNames: created.referenceNames, referencePaths: created.referencePaths,
      directorIntent: created.directorIntent, emotionalIntent: created.emotionalIntent, continuityNotes: created.continuityNotes,
    });
    const persisted = (await getStoryboard(root, created.itemId)).rows[0]!;
    expect(persisted).toEqual(updated);
    const contracts = await getConfirmedStoryboardContracts(root, [created.itemId]);
    expect(contracts.byItemId.get(created.itemId)?.[0]).toMatchObject({ cameraAngle: "右侧过肩", lens: "50mm", dialogue: "不要回头。", referenceNames: ["阿航", "完整黄金面具"] });
  });

  it("首尾帧阶段不能用一张孤立 raw 假完成，完整配对仍须绑定当前版本视觉验收", async () => {
    const { root, infoPath } = await fixture();
    await seedProductionReady(root, "storyboard");
    const directory = path.dirname(infoPath);
    await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#302a28" } }).png().toFile(path.join(directory, "orphan_raw.png"));
    await scanAndPersist(root);
    let workflow = await getProductionWorkflow(root);
    await expect(updateProductionWorkflowStage(root, { stageId: "frames", status: "completed", expectedRevision: workflow.revision })).rejects.toThrow("缺少当前权威首/尾帧 raw/labeled 配对");

    for (const [variant, color] of [["首帧", "#48637a"], ["尾帧", "#a5793f"]] as const) {
      await sharp({ create: { width: 720, height: 1280, channels: 3, background: color } }).png().toFile(path.join(directory, `EP01_15s_001_${variant}_raw.png`));
      await sharp({ create: { width: 720, height: 1280, channels: 3, background: color } }).png().toFile(path.join(directory, `EP01_15s_001_${variant}_labeled.png`));
    }
    const index = await scanAndPersist(root);
    workflow = await getProductionWorkflow(root);
    await expect(updateProductionWorkflowStage(root, { stageId: "frames", status: "completed", expectedRevision: workflow.revision })).rejects.toThrow("没有绑定当前首尾帧版本的视觉通过记录");
    const unit = index.items.find((item) => item.id === "main-ep01-unit001")!;
    const artifactIds = index.artifacts.filter((artifact) => artifact.itemId === unit.id && artifact.authoritative && !artifact.deprecated && ["raw-image", "labeled-image"].includes(artifact.kind)).map((artifact) => artifact.id);
    const reviewEntry = (await getReviewQueue(root, { includeResolved: true })).find((entry) => entry.item.id === unit.id)!;
    const keys: ReviewCriterionKey[] = ["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"];
    await submitReview(root, { itemId: unit.id, reviewType: "image", artifactIds, expectedScanId: reviewEntry.reviewSnapshot.scanId, expectedArtifactHashes: Object.fromEntries(artifactIds.map((artifactId) => [artifactId, reviewEntry.reviewSnapshot.artifactHashes[artifactId]!])), decision: "pass", criteria: keys.map((key) => ({ key, result: "pass" })) });
    const completed = await updateProductionWorkflowStage(root, { stageId: "frames", status: "completed", expectedRevision: workflow.revision });
    expect(completed.stages.find((stage) => stage.id === "frames")?.status).toBe("completed");
  });

  it("同路径替换权威首尾帧后旧视觉通过记录立即失效", async () => {
    const { root, infoPath } = await fixture();
    await seedProductionReady(root, "storyboard");
    const directory = path.dirname(infoPath);
    const startRawPath = path.join(directory, "EP01_15s_001_首帧_raw.png");
    for (const [variant, color] of [["首帧", "#48637a"], ["尾帧", "#a5793f"]] as const) {
      await sharp({ create: { width: 720, height: 1280, channels: 3, background: color } }).png().toFile(path.join(directory, `EP01_15s_001_${variant}_raw.png`));
      await sharp({ create: { width: 720, height: 1280, channels: 3, background: color } }).png().toFile(path.join(directory, `EP01_15s_001_${variant}_labeled.png`));
    }
    const before = await scanAndPersist(root, { includeHashes: true });
    const unit = before.items.find((item) => item.id === "main-ep01-unit001")!;
    const required = before.artifacts.filter((artifact) => artifact.itemId === unit.id && artifact.authoritative && !artifact.deprecated && ["raw-image", "labeled-image"].includes(artifact.kind));
    const startRawBefore = required.find((artifact) => artifact.path === startRawPath)!;
    expect(startRawBefore.check.sha256).toMatch(/^[a-f0-9]{64}$/);
    const reviewEntry = (await getReviewQueue(root, { includeResolved: true })).find((entry) => entry.item.id === unit.id)!;
    const keys: ReviewCriterionKey[] = ["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"];
    const artifactIds = required.map((artifact) => artifact.id);
    await submitReview(root, { itemId: unit.id, reviewType: "image", artifactIds, expectedScanId: reviewEntry.reviewSnapshot.scanId, expectedArtifactHashes: Object.fromEntries(artifactIds.map((artifactId) => [artifactId, reviewEntry.reviewSnapshot.artifactHashes[artifactId]!])), decision: "pass", criteria: keys.map((key) => ({ key, result: "pass" })) });
    let workflow = await getProductionWorkflow(root);
    workflow = await updateProductionWorkflowStage(root, { stageId: "frames", status: "completed", expectedRevision: workflow.revision });
    expect(workflow.stages.find((stage) => stage.id === "frames")?.status).toBe("completed");

    const videoPath = path.join(directory, "EP01_15s_001_已验收视频.mp4");
    await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath]);
    await scanAndPersist(root, { includeHashes: true });
    const videoEntry = (await getReviewQueue(root, { includeResolved: true })).find((entry) => entry.item.id === unit.id)!;
    const videoIds = videoEntry.artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated && artifact.kind === "video").map((artifact) => artifact.id);
    await submitReview(root, {
      itemId: unit.id,
      reviewType: "video",
      artifactIds: videoIds,
      expectedScanId: videoEntry.reviewSnapshot.scanId,
      expectedArtifactHashes: Object.fromEntries(videoIds.map((artifactId) => [artifactId, videoEntry.reviewSnapshot.artifactHashes[artifactId]!])),
      decision: "pass",
      criteria: (["character_identity", "hard_lock", "prop_costume", "scene_continuity", "motion_continuity", "duration_audio", "image_quality"] as ReviewCriterionKey[]).map((key) => ({ key, result: "pass" })),
    });
    workflow = await getProductionWorkflow(root);
    workflow = await updateProductionWorkflowStage(root, { stageId: "video", status: "completed", expectedRevision: workflow.revision });
    expect(workflow.stages.find((stage) => stage.id === "video")?.status).toBe("completed");

    await sharp({ create: { width: 724, height: 1280, channels: 3, background: "#154f63" } }).png({ compressionLevel: 0 }).toFile(startRawPath);
    const after = await scanAndPersist(root, { includeHashes: true });
    const startRawAfter = after.artifacts.find((artifact) => artifact.path === startRawPath)!;
    expect(startRawAfter.id).toBe(startRawBefore.id);
    expect(startRawAfter.check.sha256).not.toBe(startRawBefore.check.sha256);

    const audited = await getProductionWorkflow(root, { includeEvidenceAudit: true });
    const framesAudit = audited.evidenceAudit?.stages.find((stage) => stage.stageId === "frames");
    const videoAudit = audited.evidenceAudit?.stages.find((stage) => stage.stageId === "video");
    const reviewAudit = audited.evidenceAudit?.stages.find((stage) => stage.stageId === "review");
    expect(framesAudit).toMatchObject({ ready: false, statusEvidenceValid: false, legacyUnverified: false });
    expect(videoAudit).toMatchObject({ ready: false, statusEvidenceValid: false, legacyUnverified: false });
    expect(reviewAudit?.ready).toBe(false);
    expect(framesAudit?.issues.join("；")).toContain("没有绑定当前首尾帧版本的视觉通过记录");
    expect(videoAudit?.issues.join("；")).toContain("当前权威首/尾帧没有仍有效的视觉通过记录");
    expect(reviewAudit?.issues.join("；")).toContain("当前权威首/尾帧没有仍有效的视觉通过记录");
    await expect(assertProductionWorkflowGate(root, "video", [unit.id])).rejects.toThrow("真实证据已失效");
  });

  it("上游阶段返工会阻塞所有已经推进的下游阶段", async () => {
    const { root } = await fixture();
    await seedProductionReady(root, "publish");
    const workflow = await getProductionWorkflow(root);
    const changed = await updateProductionWorkflowStage(root, { stageId: "storyboard", status: "in_progress", note: "正式分镜需要返工", expectedRevision: workflow.revision });
    expect(changed.stages.find((stage) => stage.id === "storyboard")?.status).toBe("in_progress");
    expect(changed.stages.filter((stage) => ["frames", "video", "edit", "review", "publish"].includes(stage.id)).every((stage) => stage.status === "blocked")).toBe(true);
    expect(changed.stages.find((stage) => stage.id === "frames")?.note).toContain("上游阶段“正式分镜”");
    expect(changed.stages.find((stage) => stage.id === "assets")?.status).toBe("completed");
  });

  it("旧 11 阶段侧车按阶段 ID 懒迁移为 15 阶段且保留旧状态", async () => {
    const { root, infoPath } = await fixture();
    const old = await getProductionWorkflow(root);
    old.stages = old.stages.filter((stage) => !["chapters", "director", "visual_bible", "publish"].includes(stage.id));
    old.stages[0] = { ...old.stages[0]!, status: "completed", evidencePaths: [infoPath], note: "旧版已完成" };
    await writeJsonAtomic(getSidecarPaths(root).productionWorkflow, old);
    const migrated = await getProductionWorkflow(root);
    expect(migrated.stages).toHaveLength(15);
    expect(migrated.stages.find((stage) => stage.id === "source")?.status).toBe("completed");
    expect(migrated.stages.find((stage) => stage.id === "source")?.note).toBe("旧版已完成");
    expect(migrated.stages.find((stage) => stage.id === "publish")?.status).toBe("not_started");
  });
});
