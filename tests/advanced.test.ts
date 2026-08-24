import { access, mkdtemp, mkdir, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { seedProductionReady } from "./workflow-helpers.js";
import { listScriptDocuments, readScriptDocument, saveScriptDocument } from "../src/core/documents.js";
import { doctorProject } from "../src/core/codex.js";
import { createVideoContinuationPack, listVideoContinuationPacks, updateVideoContinuationPack } from "../src/core/editor.js";
import { cancelGenerationJob, enqueueGeneration, getBrowserGenerationPlan, getGenerationProvider, getGenerationSettings, listGenerationJobs, processGenerationQueue, saveGenerationSettings, updateBrowserGenerationJob, upsertGenerationProvider } from "../src/core/generation.js";
import { promoteAssetToHardLock, scanAndPersist, setAuthoritativeArtifact } from "../src/core/service.js";
import { getReviewQueue, submitReview } from "../src/core/reviews.js";
import { ensureSidecar, getSidecarPaths, loadProjectConfig, writeJsonAtomic } from "../src/core/sidecar.js";
import { cancelPublication, getPublicationIntent, getPublicationReceipt, listPublicationIntents } from "../src/core/publication.js";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { toJsLiteral } from "../src/core/js-code-literal.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-advanced-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  config.hardLocks = [];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const directory = path.join(root, "EP01_15s_001_高级测试");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "00_信息.md"), "# 高级测试\n\n首帧提示词：青铜树下的人物。\n尾帧提示词：人物回头。\n", "utf8");
  for (const version of ["v1", "v2"]) {
    await sharp({ create: { width: 720, height: 1280, channels: 3, background: version === "v1" ? "#654321" : "#345678" } })
      .png()
      .toFile(path.join(directory, `EP01_15s_001_首帧_${version}_raw.png`));
  }
  await scanAndPersist(root);
  await seedProductionReady(root, "frames");
  return root;
}

describe("第二阶段生产闭环", () => {
  it("生成配置读取无副作用，单供应商增量保存带 CAS 保护", async () => {
    const root = await fixture();
    const settingsPath = getSidecarPaths(root).generationSettings;
    await expect(access(settingsPath)).rejects.toThrow();
    const defaults = await getGenerationSettings(root);
    expect(defaults.revision).toBe(0);
    expect(defaults.providers.map((provider) => provider.id)).toEqual(["folder-image", "folder-video"]);
    await expect(access(settingsPath)).rejects.toThrow();

    const saved = await upsertGenerationProvider(root, {
      expectedRevision: 0,
      setAsDefaultFor: "image",
      provider: {
        id: "browser-codex",
        name: "Codex 网页生图",
        adapter: "codex-browser",
        kinds: ["image"],
        enabled: true,
        siteUrl: "https://example.com/generate",
        browserInstructions: "只上传任务包白名单内参考素材。",
        workflow: { schemaVersion: 1, name: "网页生图", version: "1", format: "browser-recipe", definition: { mode: "cinematic", aspectRatio: "9:16" } },
        outputRoot: root,
      },
    }, "codex");
    expect(saved.revision).toBe(1);
    expect(saved.defaultImageProviderId).toBe("browser-codex");
    expect(saved.providers.map((provider) => provider.id)).toEqual(["folder-image", "folder-video", "browser-codex"]);
    await expect(access(settingsPath)).resolves.toBeUndefined();
    const detailed = await getGenerationProvider(root, "browser-codex");
    expect(detailed.settingsRevision).toBe(1);
    expect(detailed.provider.workflow?.definition).toEqual({ aspectRatio: "9:16", mode: "cinematic" });
    await expect(upsertGenerationProvider(root, {
      expectedRevision: 1,
      provider: {
        id: "http-query-secret",
        name: "HTTP 敏感参数",
        adapter: "http-json",
        kinds: ["image"],
        enabled: true,
        endpoint: "https://api.example.test/submit?api_key=QUERY_SECRET_MUST_NOT_PERSIST",
        outputRoot: root,
      },
    })).rejects.toThrow("不能在 query 或 fragment 内嵌凭据");
    await expect(upsertGenerationProvider(root, {
      expectedRevision: 1,
      provider: { ...saved.providers[2]!, siteUrl: "https://example.com/generate#access_token=FRAGMENT_SECRET_MUST_NOT_PERSIST" },
    })).rejects.toThrow("不能在 query 或 fragment 内嵌凭据");
    await expect(upsertGenerationProvider(root, { expectedRevision: 0, provider: { ...saved.providers[2]!, name: "过期修改" } })).rejects.toThrow("修订冲突");
  });

  it("项目医生同时检查媒体引擎、DOCX、供应商、任务与资产引用", async () => {
    const root = await fixture();
    const report = await doctorProject(root);
    const ids = report.checks.map((check) => check.id);
    expect(ids).toEqual(expect.arrayContaining(["sharp", "docx", "ffmpeg", "generation-providers", "task-packs", "asset-registry", "artifact-mapping"]));
    expect(report.checks.find((check) => check.id === "sharp")?.level).toBe("ok");
    expect(report.checks.find((check) => check.id === "docx")?.level).toBe("ok");
  });

  it("编辑真实 Markdown 时保留历史并阻止并发覆盖", async () => {
    const root = await fixture();
    const [document] = await listScriptDocuments(root);
    expect(document?.path.endsWith("00_信息.md")).toBe(true);
    const opened = await readScriptDocument(root, document!.path);
    const saved = await saveScriptDocument(root, document!.path, `${opened.content}\n## 人工修订\n保留连续性。\n`, opened.modifiedAt);
    await expect(access(saved.historyPath)).resolves.toBeUndefined();
    await expect(saveScriptDocument(root, document!.path, "冲突覆盖", "2000-01-01T00:00:00.000Z")).rejects.toThrow("其他程序修改");
  });

  it("按素材种类与首尾帧维度选择权威版本", async () => {
    const root = await fixture();
    const initial = await scanAndPersist(root);
    const item = initial.items.find((candidate) => candidate.id === "main-ep01-unit001")!;
    const rawVersions = initial.artifacts.filter((artifact) => item.artifactIds.includes(artifact.id) && artifact.kind === "raw-image");
    expect(rawVersions).toHaveLength(2);
    const alternative = rawVersions.find((artifact) => !artifact.authoritative)!;
    await setAuthoritativeArtifact(root, item.id, alternative.id, "测试人工选择");
    const refreshed = await scanAndPersist(root);
    const selected = refreshed.artifacts.find((artifact) => artifact.id === alternative.id);
    expect(selected?.authoritative).toBe(true);
    expect(refreshed.artifacts.filter((artifact) => item.artifactIds.includes(artifact.id) && artifact.kind === "raw-image" && artifact.authoritative)).toHaveLength(1);
  });

  it("普通资产必须完成 SHA 绑定视觉验收后才可提升硬锁，且不移动原文件", async () => {
    const root = await fixture();
    const assetPath = path.join(root, "00_全剧资产锁定", "02_场景三视图", "S99_测试场景_raw.png");
    await mkdir(path.dirname(assetPath), { recursive: true });
    await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#34553d" } }).png().toFile(assetPath);
    const index = await scanAndPersist(root);
    const asset = index.items.find((item) => item.type === "asset" && item.sourcePaths.includes(assetPath))!;
    expect(asset.hardLockIds).toHaveLength(0);
    expect(asset.status).toBe("待视觉验收");
    await expect(promoteAssetToHardLock(root, asset.id, "未验收不应成功")).rejects.toThrow("图片视觉通过证据");

    const entry = (await getReviewQueue(root)).find((candidate) => candidate.item.id === asset.id)!;
    const artifactIds = entry.artifacts.map((artifact) => artifact.id);
    const criteriaKeys = ["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"] as const;
    const reviewed = await submitReview(root, {
      itemId: asset.id,
      reviewType: "image",
      artifactIds,
      expectedScanId: entry.reviewSnapshot.scanId,
      expectedArtifactHashes: Object.fromEntries(artifactIds.map((artifactId) => [artifactId, entry.reviewSnapshot.artifactHashes[artifactId]!])),
      decision: "pass",
      criteria: criteriaKeys.map((key) => ({ key, result: "pass" as const })),
      note: "已核对当前权威资产图内容。",
    });
    expect(reviewed.item.status).toBe("已完成");
    expect(reviewed.record.artifactEvidence?.every((evidence) => /^[a-f0-9]{64}$/.test(evidence.sha256))).toBe(true);

    const promoted = await promoteAssetToHardLock(root, asset.id, "测试显式硬锁");
    expect(promoted.hardLockIds).toHaveLength(1);
    expect((await loadProjectConfig(root)).hardLocks.some((lock) => lock.path === assetPath)).toBe(true);
    await expect(access(assetPath)).resolves.toBeUndefined();
  });

  it("视频机械验收读取真实画面尺寸与时长", async () => {
    const root = await fixture();
    const videoPath = path.join(root, "EP01_15s_001_高级测试", "EP01_15s_001_测试视频.mp4");
    await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath]);
    const index = await scanAndPersist(root);
    const video = index.artifacts.find((artifact) => artifact.path === videoPath)!;
    expect(video.check.ok).toBe(true);
    expect(video.check.decodable).toBe(true);
    expect(video.check.width).toBe(640);
    expect(video.check.height).toBe(360);
    expect(video.check.duration).toBeGreaterThanOrEqual(1);
  });

  it("落盘桥接队列可提交请求并在真实结果出现后恢复为成功", async () => {
    const root = await fixture();
    const settings = await getGenerationSettings(root);
    expect(settings.defaultImageProviderId).toBe("folder-image");
    const [job] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image" });
    expect(job?.status).toBe("queued");
    expect(job?.publicationIntentId).toMatch(/^publication-/);
    expect(job?.publicationReservationToken).toBeTruthy();
    expect((await getPublicationIntent(root, job!.publicationIntentId!))?.targetPath).toBe(job?.expectedOutputPath);
    const submitted = await processGenerationQueue(root);
    const waiting = submitted.find((candidate) => candidate.id === job!.id)!;
    expect(waiting.status).toBe("waiting_external");
    await expect(access(waiting.requestPath!)).resolves.toBeUndefined();
    await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#222222" } }).png().toFile(waiting.expectedOutputPath);
    const polled = await processGenerationQueue(root);
    const completedJob = polled.find((candidate) => candidate.id === job!.id)!;
    expect(completedJob.status).toBe("succeeded");
    expect(completedJob.publicationReceiptId).toMatch(/^receipt-/);
    expect((await getPublicationIntent(root, job!.publicationIntentId!))?.status).toBe("registered");
    expect((await getPublicationReceipt(root, completedJob.publicationReceiptId!))?.check.sha256).toBe(completedJob.resultSha256);
    expect((await listGenerationJobs(root)).find((candidate) => candidate.id === job!.id)?.resultPath).toBe(waiting.expectedOutputPath);
    await expect(access(waiting.expectedCompanionPath!)).resolves.toBeUndefined();
    expect(polled.find((candidate) => candidate.id === job!.id)?.companionPath).toBe(waiting.expectedCompanionPath);
  });

  it("Codex 浏览器适配器只暴露上传白名单并可回收下载结果", async () => {
    const root = await fixture();
    const settings = await getGenerationSettings(root);
    const now = new Date().toISOString();
    settings.providers.push({
      id: "browser-test",
      name: "网页生图测试",
      adapter: "codex-browser",
      kinds: ["image"],
      enabled: true,
      siteUrl: "https://example.com/generate",
      browserInstructions: "使用 9:16 写实模式。",
      workflow: { schemaVersion: 1, name: "网页角色一致性", version: "v1", format: "browser-recipe", definition: { mode: "cinematic", slots: [{ role: "first_frame", index: 1 }] }, environment: { engine: "Browser", models: [{ name: "Seedance", version: "2.0" }] } },
      outputRoot: root,
      createdAt: now,
      updatedAt: now,
    });
    await saveGenerationSettings(root, settings);
    const [job] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "browser-test" });
    expect(job?.executionSnapshot?.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(job?.executionSnapshot?.workflowHash).toMatch(/^[a-f0-9]{64}$/);
    const frozenSnapshotHash = job!.executionSnapshot!.snapshotHash;
    const frozenWorkflowHash = job!.executionSnapshot!.workflowHash;
    const changedSettings = await getGenerationSettings(root);
    const changedProvider = changedSettings.providers.find((provider) => provider.id === "browser-test")!;
    changedProvider.siteUrl = "https://changed.example/generate";
    changedProvider.workflow!.version = "v2";
    changedProvider.workflow!.definition = { mode: "illustration", slots: [] };
    await saveGenerationSettings(root, changedSettings);
    const interruptedJobs = await listGenerationJobs(root);
    job!.status = "submitting";
    await writeJsonAtomic(getSidecarPaths(root).generationJobs, interruptedJobs.map((candidate) => candidate.id === job!.id ? job! : candidate));
    const locallyResumed = await processGenerationQueue(root);
    expect(locallyResumed.find((candidate) => candidate.id === job!.id)?.status).toBe("queued");
    expect(locallyResumed.find((candidate) => candidate.id === job!.id)?.status).not.toBe("submission_unknown");
    await processGenerationQueue(root);
    const plan = await getBrowserGenerationPlan(root, job!.id);
    expect(plan.siteUrl).toBe("https://example.com/generate");
    expect(plan.executionSnapshotHash).toBe(frozenSnapshotHash);
    expect(plan.workflowHash).toBe(frozenWorkflowHash);
    expect(plan.workflow?.version).toBe("v1");
    expect(plan.workflow?.definition).toEqual({ mode: "cinematic", slots: [{ index: 1, role: "first_frame" }] });
    expect(plan.allowedUploadPaths.every((filePath) => path.isAbsolute(filePath))).toBe(true);
    expect(plan.allowedUploadPaths.some((filePath) => /_raw\.(?:png|jpe?g|webp)$/i.test(filePath))).toBe(true);
    expect(plan.allowedUploadPaths.some((filePath) => /_labeled\.(?:png|jpe?g|webp)$/i.test(filePath))).toBe(false);
    expect(plan.allowedUploads.some((reference) => reference.role === "first_frame")).toBe(true);
    expect(plan.allowedUploads.every((reference) => /^[a-f0-9]{64}$/.test(reference.sha256 ?? ""))).toBe(true);
    expect(plan.currentCheckpoint).toMatchObject({ stage: "plan_ready", revision: 1 });
    expect(plan.capabilities.referenceModes).toContain("first_last_frame");
    expect(path.isAbsolute(plan.isolatedDownloadDirectory)).toBe(true);
    expect(plan.safety.uploadOnlyAllowlistedPaths).toBe(true);
    expect(plan.safety.persistIntentBeforeSubmit).toBe(true);
    expect(plan.steps.find((step) => step.id === "inspect")?.action).toContain("status=preflight");
    expect(plan.steps.find((step) => step.id === "inspect")?.action).toContain("status=preflight_blocked");
    expect(plan.steps.find((step) => step.id === "inspect")?.action).toContain("preflightEvidence");
    expect(plan.steps.find((step) => step.id === "upload")?.action).toContain("status=uploaded");
    expect(plan.steps.find((step) => step.id === "submit-intent")?.action).toContain("status=submit_intent");
    await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#203040" } }).png().toFile(job!.expectedOutputPath);
    await processGenerationQueue(root, { jobId: job!.id });
    const bypassRejected = (await listGenerationJobs(root)).find((candidate) => candidate.id === job!.id)!;
    expect(bypassRejected).toMatchObject({ status: "waiting_external", browserCheckpoint: { stage: "plan_ready", revision: 1 } });
    expect(bypassRejected.publicationReceiptId).toBeUndefined();
    expect(bypassRejected.error).toContain("拒绝旁路验收");
    expect((await getPublicationIntent(root, job!.publicationIntentId!))?.status).toBe("reserved");
    await rm(job!.expectedOutputPath);
    const uploadEvidence = { files: plan.allowedUploads.map((reference) => ({ path: reference.path, role: reference.role, order: reference.order, slot: `slot-${reference.order}-${reference.role}` })) };
    await expect(updateBrowserGenerationJob(root, job!.id, { expectedRevision: 1, status: "submitted", externalTaskId: "should-not-submit" })).rejects.toThrow("必须依次完成预检");
    await expect(updateBrowserGenerationJob(root, job!.id, { expectedRevision: 1, status: "preflight" })).rejects.toThrow("必须记录域名、登录态、页面模式和余额/付费动作检查结果");
    await expect(updateBrowserGenerationJob(root, job!.id, { expectedRevision: 1, status: "preflight", note: "域名、登录态、页面模式和余额已检查" })).rejects.toThrow("必须提交结构化 preflightEvidence");
    await expect(updateBrowserGenerationJob(root, job!.id, { expectedRevision: 1, status: "preflight", note: "已检查", preflightEvidence: { observedHost: "evil.example", loginVerified: true, pageReady: true, generationModeVerified: true, balanceChecked: true, paidActionRequired: false, paidActionAuthorized: false } })).rejects.toThrow("网页预检域名不匹配");
    await expect(updateBrowserGenerationJob(root, job!.id, { expectedRevision: 1, status: "preflight", note: "发现付费确认", preflightEvidence: { observedHost: "example.com", loginVerified: true, pageReady: true, generationModeVerified: true, balanceChecked: true, paidActionRequired: true, paidActionAuthorized: false } })).rejects.toThrow("没有记录用户授权依据");
    const preflightCommand = { requestId: "browser-preflight-request-001", idempotencyKey: "browser-preflight-idempotent-v1", request: { command: "update_browser_generation" as const, payload: { jobId: job!.id, expectedRevision: 1, status: "preflight" as const, note: "域名、登录态、页面模式和余额已检查，无额外付费确认", preflightEvidence: { observedHost: "example.com", loginVerified: true, pageReady: true, generationModeVerified: true, balanceChecked: true, paidActionRequired: false, paidActionAuthorized: false, observedGeneration: { aspectRatio: "9:16", resolution: "1080p", generateEnabled: true } } } } };
    const firstPreflightCommand = await executeIdempotentCommand(root, preflightCommand);
    const replayedPreflightCommand = await executeIdempotentCommand(root, { ...preflightCommand, requestId: "browser-preflight-request-002" });
    expect(replayedPreflightCommand.result).toEqual(firstPreflightCommand.result);
    const preflight = firstPreflightCommand.result as Awaited<ReturnType<typeof updateBrowserGenerationJob>>;
    expect(preflight.browserCheckpoint?.revision).toBe(2);
    await expect(updateBrowserGenerationJob(root, job!.id, { expectedRevision: 1, status: "uploaded", uploadEvidence })).rejects.toThrow("修订冲突");
    await expect(updateBrowserGenerationJob(root, job!.id, { expectedRevision: 2, status: "submitted", externalTaskId: "should-not-submit" })).rejects.toThrow("必须依次完成预检");
    await expect(updateBrowserGenerationJob(root, job!.id, { expectedRevision: 2, status: "uploaded", note: "只写说明" })).rejects.toThrow("必须提交结构化 uploadEvidence");
    await expect(updateBrowserGenerationJob(root, job!.id, { expectedRevision: 2, status: "uploaded", uploadEvidence: { files: [] } })).rejects.toThrow("上传证据数量与计划不一致");
    const unlistedEvidence = { files: uploadEvidence.files.map((file, index) => index === 0 ? { ...file, path: path.join(root, "未授权参考图.png") } : file) };
    await expect(updateBrowserGenerationJob(root, job!.id, { expectedRevision: 2, status: "uploaded", uploadEvidence: unlistedEvidence })).rejects.toThrow("不在计划顺序或白名单中");
    const wrongRoleEvidence = { files: uploadEvidence.files.map((file, index) => index === 0 ? { ...file, role: file.role === "style" ? "character" as const : "style" as const } : file) };
    await expect(updateBrowserGenerationJob(root, job!.id, { expectedRevision: 2, status: "uploaded", uploadEvidence: wrongRoleEvidence })).rejects.toThrow("语义角色应为");
    const uploaded = await updateBrowserGenerationJob(root, job!.id, { expectedRevision: 2, status: "uploaded", note: "逐个槽位已核对", uploadEvidence });
    expect(uploaded.browserCheckpoint?.revision).toBe(3);
    expect(uploaded.browserCheckpoint?.uploadEvidence?.files).toHaveLength(plan.allowedUploads.length);
    await expect(updateBrowserGenerationJob(root, job!.id, { expectedRevision: 3, status: "submitted", externalTaskId: "should-not-submit" })).rejects.toThrow("必须依次完成预检");
    const submitIntentCommand = { requestId: "browser-submit-intent-request-001", idempotencyKey: "browser-submit-intent-v1", request: { command: "update_browser_generation" as const, payload: { jobId: job!.id, expectedRevision: 3, status: "submit_intent" as const, note: "点击付费按钮前先持久化" } } };
    const firstSubmitIntentCommand = await executeIdempotentCommand(root, submitIntentCommand);
    const replayedSubmitIntentCommand = await executeIdempotentCommand(root, { ...submitIntentCommand, requestId: "browser-submit-intent-request-002" });
    expect(replayedSubmitIntentCommand.result).toEqual(firstSubmitIntentCommand.result);
    const submitIntent = firstSubmitIntentCommand.result as Awaited<ReturnType<typeof updateBrowserGenerationJob>>;
    expect(submitIntent.status).toBe("submission_unknown");
    expect(submitIntent.browserState).toBe("submission_unknown");
    expect(submitIntent.browserCheckpoint).toMatchObject({ revision: 4, stage: "submission_unknown", submissionIntent: { clientJobId: job!.id, attempt: 1 } });
    const generationModule = new URL("../src/core/generation.ts", import.meta.url).href;
    const unknownProcess = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { processGenerationQueue, listGenerationJobs, getBrowserGenerationPlan } from ${toJsLiteral(generationModule)}; const root=${toJsLiteral(root)}; await processGenerationQueue(root); const job=(await listGenerationJobs(root)).find((entry)=>entry.id===${toJsLiteral(job!.id)}); const plan=await getBrowserGenerationPlan(root,${toJsLiteral(job!.id)}); process.stdout.write(JSON.stringify({status:job?.status,externalTaskId:job?.externalTaskId,stage:plan.currentCheckpoint?.stage,revision:plan.currentCheckpoint?.revision}));`], { cwd: process.cwd() });
    expect(JSON.parse(unknownProcess.stdout)).toEqual({ status: "submission_unknown", stage: "submission_unknown", revision: 4 });
    await expect(updateBrowserGenerationJob(root, job!.id, { expectedRevision: 4, status: "failed", error: "没有收到回执" })).rejects.toThrow("必须先提交 result=not_found 的结构化对账证据");
    await expect(updateBrowserGenerationJob(root, job!.id, { expectedRevision: 4, status: "submitted", externalTaskId: "web-123", submissionReconciliation: { method: "browser_history", result: "not_found", note: "历史中没有找到" } })).rejects.toThrow("对账结果必须为 found");
    const submitted = await updateBrowserGenerationJob(root, job!.id, { expectedRevision: 4, status: "submitted", externalTaskId: "web-123", submissionReconciliation: { method: "browser_history", result: "found", note: "单次点击后页面显示任务编号", externalTaskId: "web-123" } });
    expect(submitted.browserState).toBe("submitted");
    const resumedProcess = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { listGenerationJobs, getBrowserGenerationPlan } from ${toJsLiteral(generationModule)}; const root=${toJsLiteral(root)}; const job=(await listGenerationJobs(root)).find((entry)=>entry.id===${toJsLiteral(job!.id)}); const plan=await getBrowserGenerationPlan(root,${toJsLiteral(job!.id)}); process.stdout.write(JSON.stringify({status:job?.status,externalTaskId:job?.externalTaskId,stage:plan.currentCheckpoint?.stage}));`], { cwd: process.cwd() });
    expect(JSON.parse(resumedProcess.stdout)).toEqual({ status: "waiting_external", externalTaskId: "web-123", stage: "submitted" });
    const unrelatedDirectory = path.join(root, "EP01_15s_002_队列隔离");
    await mkdir(unrelatedDirectory, { recursive: true });
    await writeFile(path.join(unrelatedDirectory, "00_信息.md"), "# 队列隔离\n\n首帧提示词：测试定向处理不会触发其他任务。\n", "utf8");
    await scanAndPersist(root);
    await seedProductionReady(root, "storyboard");
    const [unrelatedQueued] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit002"], kind: "image", providerId: "folder-image" });
    expect(unrelatedQueued?.status).toBe("queued");
    expect(unrelatedQueued?.requestPath).toBeUndefined();
    const download = path.join(root, "browser-download.png");
    await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#1a2938" } }).png().toFile(download);
    const completed = await updateBrowserGenerationJob(root, job!.id, { expectedRevision: 5, status: "downloaded", downloadedPath: download });
    expect(completed.status).toBe("succeeded");
    expect(completed.externalTaskId).toBe("web-123");
    expect(completed.browserCheckpoint?.stage).toBe("verified");
    expect(completed.browserCheckpoint?.revision).toBe(7);
    expect(completed.browserCheckpoint?.preflightEvidence?.observedHost).toBe("example.com");
    expect(completed.browserCheckpoint?.uploadEvidence?.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(completed.browserCheckpoint?.submissionIntent?.clientJobId).toBe(job!.id);
    expect(completed.browserCheckpoint?.submissionReconciliation).toMatchObject({ method: "browser_history", result: "found", externalTaskId: "web-123" });
    expect(completed.resultMagic).toBe("image/png");
    expect(completed.resultSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(completed.publicationReceiptId).toMatch(/^receipt-/);
    expect((await getPublicationIntent(root, completed.publicationIntentId!))?.status).toBe("registered");
    expect(completed.isolatedDownloadPath).toContain(path.join(".aicanvas", "generation-downloads", job!.id));
    await expect(access(completed.expectedOutputPath)).resolves.toBeUndefined();
    await expect(access(completed.expectedCompanionPath!)).resolves.toBeUndefined();
    const unrelatedAfterDownload = (await listGenerationJobs(root)).find((candidate) => candidate.id === unrelatedQueued!.id)!;
    expect(unrelatedAfterDownload.status).toBe("queued");
    expect(unrelatedAfterDownload.requestPath).toBeUndefined();

    const [reconciledJob] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "browser-test" });
    await processGenerationQueue(root);
    const reconciledPlan = await getBrowserGenerationPlan(root, reconciledJob!.id);
    await expect(updateBrowserGenerationJob(root, reconciledJob!.id, { expectedRevision: 1, status: "preflight_blocked", note: "发现额度不足", preflightEvidence: { observedHost: "changed.example", loginVerified: true, pageReady: true, generationModeVerified: false, balanceChecked: true, paidActionRequired: true, paidActionAuthorized: false } })).rejects.toThrow("至少记录一个结构化阻塞代码");
    const blockedCommand = {
      requestId: "browser-preflight-blocked-request-001",
      idempotencyKey: "browser-preflight-blocked-v1",
      request: {
        command: "update_browser_generation" as const,
        payload: {
          jobId: reconciledJob!.id,
          expectedRevision: 1,
          status: "preflight_blocked" as const,
          note: "已登录，但额度不足且可见模型/画幅与冻结合同不符；上传和提交前停止。",
          preflightEvidence: {
            observedHost: "changed.example",
            loginVerified: true,
            pageReady: true,
            generationModeVerified: false,
            balanceChecked: true,
            paidActionRequired: true,
            paidActionAuthorized: false,
            blockers: ["insufficient_credits" as const, "generation_mode_mismatch" as const],
            observedGeneration: { model: "Other Image Model", aspectRatio: "16:9", resolution: "2K", imageCount: 1, generateEnabled: false, creditMessage: "Insufficient credits" },
          },
        },
      },
    };
    const blockedRecord = await executeIdempotentCommand(root, blockedCommand);
    const blockedReplay = await executeIdempotentCommand(root, { ...blockedCommand, requestId: "browser-preflight-blocked-request-002" });
    expect(blockedReplay.result).toEqual(blockedRecord.result);
    const blocked = blockedRecord.result as Awaited<ReturnType<typeof updateBrowserGenerationJob>>;
    expect(blocked).toMatchObject({ status: "waiting_external", browserState: "preflight_blocked", browserCheckpoint: { stage: "preflight_blocked", revision: 2, preflightEvidence: { blockers: ["insufficient_credits", "generation_mode_mismatch"], observedGeneration: { generateEnabled: false, creditMessage: "Insufficient credits" } } } });
    expect((await getPublicationIntent(root, reconciledJob!.publicationIntentId!))?.status).toBe("reserved");
    await expect(updateBrowserGenerationJob(root, reconciledJob!.id, { expectedRevision: 2, status: "uploaded", uploadEvidence: { files: [] } })).rejects.toThrow("必须依次完成预检");
    await processGenerationQueue(root, { jobId: reconciledJob!.id });
    expect((await getBrowserGenerationPlan(root, reconciledJob!.id)).currentCheckpoint).toMatchObject({ stage: "preflight_blocked", revision: 2 });
    const blockedDoctor = await doctorProject(root);
    expect(blockedDoctor.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "generation-jobs", level: "warning", detail: expect.stringContaining("1 个网页任务停在可恢复 preflight_blocked") })]));
    expect(blockedDoctor.suggestedNextCalls).toEqual(["get_browser_generation_plan", "update_browser_generation_job", "doctor_project"]);
    const reconciledPreflight = await updateBrowserGenerationJob(root, reconciledJob!.id, { expectedRevision: blocked.browserCheckpoint!.revision, status: "preflight", note: "额度和冻结生成模式已恢复，第二任务完成全部预检。", preflightEvidence: { observedHost: "changed.example", loginVerified: true, pageReady: true, generationModeVerified: true, balanceChecked: true, paidActionRequired: false, paidActionAuthorized: false, blockers: [], observedGeneration: { aspectRatio: "9:16", resolution: "1080p", generateEnabled: true } } });
    expect(reconciledPreflight).toMatchObject({ status: "waiting_external", browserState: "preflight", browserCheckpoint: { stage: "preflight", revision: 3, preflightEvidence: { blockers: [], observedGeneration: { generateEnabled: true } } } });
    const reconciledUploadEvidence = { files: reconciledPlan.allowedUploads.map((reference) => ({ path: reference.path, role: reference.role, order: reference.order, slot: `reconcile-slot-${reference.order}` })) };
    const reconciledUploaded = await updateBrowserGenerationJob(root, reconciledJob!.id, { expectedRevision: reconciledPreflight.browserCheckpoint!.revision, status: "uploaded", uploadEvidence: reconciledUploadEvidence });
    const reconciledUnknown = await updateBrowserGenerationJob(root, reconciledJob!.id, { expectedRevision: reconciledUploaded.browserCheckpoint!.revision, status: "submit_intent" });
    const reconciledFailed = await updateBrowserGenerationJob(root, reconciledJob!.id, { expectedRevision: reconciledUnknown.browserCheckpoint!.revision, status: "failed", error: "人工确认供应商没有接收任务；旧任务关闭，后续必须创建新版本。", submissionReconciliation: { method: "client_job_id_search", result: "not_found", note: "在供应商任务列表按 clientJobId 搜索无结果" } });
    expect(reconciledFailed.status).toBe("failed");
    expect(reconciledFailed.browserCheckpoint).toMatchObject({ stage: "failed", revision: reconciledUnknown.browserCheckpoint!.revision + 1, submissionReconciliation: { method: "client_job_id_search", result: "not_found" } });
    expect((await getPublicationIntent(root, reconciledFailed.publicationIntentId!))?.status).toBe("failed");
  });

  it("网页执行面变更时刷新同一 job/Publication，并使旧预检证据失效", async () => {
    const root = await fixture();
    const initialSettings = await getGenerationSettings(root);
    const chromeSettings = await upsertGenerationProvider(root, {
      expectedRevision: initialSettings.revision,
      provider: {
        id: "browser-surface-migration",
        name: "网页执行面迁移测试",
        adapter: "codex-browser",
        kinds: ["image"],
        enabled: true,
        model: "GPT Image 2",
        siteUrl: "https://example.com/image",
        browserInstructions: "使用外部 Chrome 执行。",
        executionSurface: { id: "external-chrome", version: "1" },
        outputRoot: root,
      },
    });
    const [job] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "browser-surface-migration" });
    await processGenerationQueue(root, { jobId: job!.id });
    const originalPlan = await getBrowserGenerationPlan(root, job!.id);
    expect(originalPlan).toMatchObject({
      executionSurface: { id: "external-chrome", version: "1" },
      configuredExecutionSurface: { id: "external-chrome", version: "1" },
      executionSurfaceStatus: "current",
      currentCheckpoint: { revision: 1, stage: "plan_ready", executionSurface: { id: "external-chrome", version: "1" } },
    });
    const blocked = await updateBrowserGenerationJob(root, job!.id, {
      expectedRevision: 1,
      status: "preflight_blocked",
      note: "外部执行面页面未就绪。",
      preflightEvidence: {
        executionSurface: { id: "external-chrome", version: "1" },
        observedHost: "example.com",
        loginVerified: true,
        pageReady: false,
        generationModeVerified: false,
        balanceChecked: false,
        paidActionRequired: false,
        paidActionAuthorized: false,
        blockers: ["page_not_ready"],
      },
    });
    expect(blocked.browserCheckpoint).toMatchObject({ revision: 2, stage: "preflight_blocked", executionSurface: { id: "external-chrome", version: "1" } });
    const frozenIdentity = {
      jobId: job!.id,
      publicationIntentId: job!.publicationIntentId,
      expectedOutputPath: job!.expectedOutputPath,
      expectedCompanionPath: job!.expectedCompanionPath,
      requestPath: blocked.requestPath,
      promptSha256: blocked.executionSnapshot!.promptSha256,
      parametersSha256: blocked.executionSnapshot!.parametersSha256,
      oldSnapshotHash: blocked.executionSnapshot!.snapshotHash,
    };
    const oldProvider = chromeSettings.providers.find((provider) => provider.id === "browser-surface-migration")!;
    const sideBrowserSettings = await upsertGenerationProvider(root, {
      expectedRevision: chromeSettings.revision,
      provider: {
        ...oldProvider,
        browserInstructions: "仅使用 Codex 应用内侧边浏览器。",
        executionSurface: { id: "codex-in-app-side-browser", version: "1" },
      },
    });
    expect(sideBrowserSettings.revision).toBe(chromeSettings.revision + 1);
    const stalePlan = await getBrowserGenerationPlan(root, job!.id);
    expect(stalePlan).toMatchObject({
      executionSurface: { id: "external-chrome", version: "1" },
      configuredExecutionSurface: { id: "codex-in-app-side-browser", version: "1" },
      executionSurfaceStatus: "provider_mismatch",
      currentCheckpoint: { revision: 2, stage: "preflight_blocked" },
    });
    await expect(updateBrowserGenerationJob(root, job!.id, {
      expectedRevision: 2,
      status: "preflight_blocked",
      note: "不应沿用旧执行面。",
      preflightEvidence: {
        executionSurface: { id: "external-chrome", version: "1" },
        observedHost: "example.com",
        loginVerified: true,
        pageReady: false,
        generationModeVerified: false,
        balanceChecked: false,
        paidActionRequired: false,
        paidActionAuthorized: false,
        blockers: ["page_not_ready"],
      },
    })).rejects.toThrow("status=refresh_plan");
    await expect(updateBrowserGenerationJob(root, job!.id, { expectedRevision: 2, status: "refresh_plan" })).rejects.toThrow("供应商配置修订");
    const refreshed = await updateBrowserGenerationJob(root, job!.id, {
      expectedRevision: 2,
      expectedSettingsRevision: sideBrowserSettings.revision,
      status: "refresh_plan",
      note: "迁移到 Codex 应用内侧边浏览器，保留原 job 和 Publication。",
    });
    expect(refreshed).toMatchObject({
      id: frozenIdentity.jobId,
      publicationIntentId: frozenIdentity.publicationIntentId,
      expectedOutputPath: frozenIdentity.expectedOutputPath,
      expectedCompanionPath: frozenIdentity.expectedCompanionPath,
      requestPath: frozenIdentity.requestPath,
      status: "waiting_external",
      browserState: "plan_ready",
      browserCheckpoint: { revision: 3, stage: "plan_ready", executionSurface: { id: "codex-in-app-side-browser", version: "1" } },
    });
    expect(refreshed.browserCheckpoint?.preflightEvidence).toBeUndefined();
    expect(refreshed.executionSnapshot?.snapshotHash).not.toBe(frozenIdentity.oldSnapshotHash);
    expect(refreshed.executionSnapshot?.promptSha256).toBe(frozenIdentity.promptSha256);
    expect(refreshed.executionSnapshot?.parametersSha256).toBe(frozenIdentity.parametersSha256);
    expect(refreshed.executionSnapshot?.provider.executionSurface).toEqual({ id: "codex-in-app-side-browser", version: "1" });
    expect((await getPublicationIntent(root, frozenIdentity.publicationIntentId!))?.status).toBe("reserved");
    const refreshedPlan = await getBrowserGenerationPlan(root, job!.id);
    expect(refreshedPlan).toMatchObject({
      executionSurface: { id: "codex-in-app-side-browser", version: "1" },
      configuredExecutionSurface: { id: "codex-in-app-side-browser", version: "1" },
      executionSurfaceStatus: "current",
      currentCheckpoint: { revision: 3, stage: "plan_ready" },
    });
    expect(refreshedPlan.instructions).toContain("Codex 应用内侧边浏览器");
    expect(refreshedPlan.steps.find((step) => step.id === "execution-surface")?.action).toContain("codex-in-app-side-browser@1");
    await expect(updateBrowserGenerationJob(root, job!.id, {
      expectedRevision: 3,
      status: "preflight",
      note: "缺少执行面身份。",
      preflightEvidence: { observedHost: "example.com", loginVerified: true, pageReady: true, generationModeVerified: true, balanceChecked: true, paidActionRequired: false, paidActionAuthorized: false },
    })).rejects.toThrow("executionSurface 不匹配");
    const preflight = await updateBrowserGenerationJob(root, job!.id, {
      expectedRevision: 3,
      status: "preflight",
      note: "Codex 应用内侧边浏览器完成当前预检。",
      preflightEvidence: {
        executionSurface: { id: "codex-in-app-side-browser", version: "1" },
        observedHost: "example.com",
        loginVerified: true,
        pageReady: true,
        generationModeVerified: true,
        balanceChecked: true,
        paidActionRequired: false,
        paidActionAuthorized: false,
        observedGeneration: { model: "GPT Image 2", aspectRatio: "9:16", resolution: "1080p", imageCount: 1, generateEnabled: true },
      },
    });
    expect(preflight.browserCheckpoint).toMatchObject({ revision: 4, stage: "preflight", executionSurface: { id: "codex-in-app-side-browser", version: "1" }, preflightEvidence: { executionSurface: { id: "codex-in-app-side-browser", version: "1" } } });
  });

  it("text-only 网页任务以显式零上传证据通过 uploaded 与 submit_intent，但不跳过检查点", async () => {
    const root = await fixture();
    const settings = await getGenerationSettings(root);
    const now = new Date().toISOString();
    settings.providers.push({
      id: "browser-text-only",
      name: "网页纯文本生图测试",
      adapter: "codex-browser",
      kinds: ["image"],
      enabled: true,
      model: "GPT Image 2",
      siteUrl: "https://example.com/text-only",
      browserInstructions: "纯文本任务，页面保持零参考图。",
      capabilities: {
        referenceModes: ["text"],
        maxReferenceImages: 0,
        maxReferenceVideos: 0,
        supportedDurations: [],
        supportedAspectRatios: ["9:16"],
        supportedResolutions: ["Medium"],
        models: ["GPT Image 2"],
        maxConcurrency: 1,
        supportsCancel: false,
      },
      outputRoot: root,
      createdAt: now,
      updatedAt: now,
    });
    await saveGenerationSettings(root, settings);
    const [job] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "browser-text-only" });
    await processGenerationQueue(root, { jobId: job!.id });
    const plan = await getBrowserGenerationPlan(root, job!.id);
    expect(plan.parameters.mode).toBe("text");
    expect(plan.allowedUploads).toEqual([]);
    expect(plan.steps.find((step) => step.id === "upload")?.action).toContain("uploadEvidence={files:[],observedReferenceThumbnailCount:0}");
    await expect(updateBrowserGenerationJob(root, job!.id, {
      expectedRevision: 1,
      status: "preflight",
      note: "错误地只声明模式已核对。",
      preflightEvidence: { observedHost: "example.com", loginVerified: true, pageReady: true, generationModeVerified: true, balanceChecked: true, paidActionRequired: false, paidActionAuthorized: false },
    })).rejects.toThrow("必须记录当前可见模型");
    await expect(updateBrowserGenerationJob(root, job!.id, {
      expectedRevision: 1,
      status: "preflight",
      note: "页面仍是错误模型和画幅。",
      preflightEvidence: { observedHost: "example.com", loginVerified: true, pageReady: true, generationModeVerified: true, balanceChecked: true, paidActionRequired: false, paidActionAuthorized: false, observedGeneration: { model: "Nano Banana", aspectRatio: "16:9", resolution: "2K", imageCount: 2, generateEnabled: true } },
    })).rejects.toThrow("与冻结生成计划不一致");
    await expect(updateBrowserGenerationJob(root, job!.id, {
      expectedRevision: 1,
      status: "preflight",
      note: "Generate 仍不可用。",
      preflightEvidence: { observedHost: "example.com", loginVerified: true, pageReady: true, generationModeVerified: true, balanceChecked: true, paidActionRequired: false, paidActionAuthorized: false, observedGeneration: { model: "GPT Image 2", aspectRatio: "9:16", resolution: "Medium", imageCount: 1, generateEnabled: false } },
    })).rejects.toThrow("Generate 必须明确可用");
    const preflight = await updateBrowserGenerationJob(root, job!.id, {
      expectedRevision: 1,
      status: "preflight",
      note: "登录、页面、GPT Image 2、9:16、Medium、1 Image 与可用额度全部通过。",
      preflightEvidence: {
        observedHost: "example.com",
        loginVerified: true,
        pageReady: true,
        generationModeVerified: true,
        balanceChecked: true,
        paidActionRequired: false,
        paidActionAuthorized: false,
        blockers: [],
        observedGeneration: { model: "GPT Image 2", aspectRatio: "9:16", resolution: "Medium", imageCount: 1, generateEnabled: true },
      },
    });
    await expect(updateBrowserGenerationJob(root, job!.id, { expectedRevision: preflight.browserCheckpoint!.revision, status: "submit_intent" })).rejects.toThrow("必须依次完成预检、上传确认、提交和下载");
    await expect(updateBrowserGenerationJob(root, job!.id, {
      expectedRevision: preflight.browserCheckpoint!.revision,
      status: "uploaded",
      note: "没有记录页面缩略图数量。",
      uploadEvidence: { files: [] },
    })).rejects.toThrow("参考缩略图数量为 0");
    const uploaded = await updateBrowserGenerationJob(root, job!.id, {
      expectedRevision: preflight.browserCheckpoint!.revision,
      status: "uploaded",
      note: "冻结计划和网页均为零参考图，显式登记 text-only。",
      uploadEvidence: { files: [], observedReferenceThumbnailCount: 0 },
    });
    expect(uploaded.browserCheckpoint).toMatchObject({
      stage: "uploaded",
      revision: 3,
      uploadEvidence: { files: [], observedReferenceThumbnailCount: 0, expectedFileCount: 0, uploadRequired: false },
    });
    const unknown = await updateBrowserGenerationJob(root, job!.id, {
      expectedRevision: uploaded.browserCheckpoint!.revision,
      status: "submit_intent",
      note: "零上传检查点已完成；点击 Generate 前持久化唯一提交意图。",
    });
    expect(unknown).toMatchObject({
      status: "submission_unknown",
      browserState: "submission_unknown",
      browserCheckpoint: {
        stage: "submission_unknown",
        revision: 4,
        uploadEvidence: { files: [], observedReferenceThumbnailCount: 0, expectedFileCount: 0, uploadRequired: false },
        submissionIntent: { clientJobId: job!.id, attempt: 1 },
      },
    });
    expect(unknown.externalTaskId).toBeUndefined();
    expect((await getPublicationIntent(root, job!.publicationIntentId!))?.status).toBe("reserved");
  });

  it("视频续接包只投影唯一 GenerationJob，并在提交不明时跨进程阻止重复付费", async () => {
    const root = await fixture();
    const index = await scanAndPersist(root);
    const firstFrame = index.artifacts.find((artifact) => artifact.itemId === "main-ep01-unit001" && artifact.kind === "raw-image" && artifact.authoritative && artifact.check.ok)!;
    const settings = await getGenerationSettings(root);
    const now = new Date().toISOString();
    settings.providers.push({
      id: "browser-video-continuation",
      name: "网页视频续接测试",
      adapter: "codex-browser",
      kinds: ["video"],
      enabled: true,
      siteUrl: "https://example.com/video",
      browserInstructions: "首帧槽位只上传冻结白名单。",
      workflow: { schemaVersion: 1, name: "网页首帧续接", version: "1", format: "browser-recipe", definition: { mode: "first_frame_video", slots: [{ role: "first_frame", index: 1 }] } },
      outputRoot: root,
      createdAt: now,
      updatedAt: now,
    });
    await saveGenerationSettings(root, settings);
    const pack = await createVideoContinuationPack(root, { itemId: "main-ep01-unit001", lastFramePath: firstFrame.path, prompt: "从冻结首帧继续向右运动，保持角色与道具连续。" });
    const [job] = await enqueueGeneration(root, { itemIds: [pack.itemId], kind: "video", providerId: "browser-video-continuation", prompt: pack.prompt, continuation: { continuationId: pack.id, firstFrameArtifactId: firstFrame.id } });
    expect(job).toMatchObject({ purpose: "video_continuation", continuationId: pack.id, continuationFirstFrameArtifactId: firstFrame.id, status: "queued" });
    let projected = (await listVideoContinuationPacks(root)).find((entry) => entry.id === pack.id)!;
    expect(projected).toMatchObject({ status: "queued", generationJobId: job!.id, generationStatus: "queued", revision: 2 });
    await expect(enqueueGeneration(root, { itemIds: [pack.itemId], kind: "video", providerId: "browser-video-continuation", continuation: { continuationId: pack.id, firstFrameArtifactId: firstFrame.id } })).rejects.toThrow("已经进入生成流程");
    await processGenerationQueue(root);
    projected = (await listVideoContinuationPacks(root)).find((entry) => entry.id === pack.id)!;
    expect(projected.status).toBe("queued");
    const plan = await getBrowserGenerationPlan(root, job!.id);
    expect(plan.allowedUploads[0]).toMatchObject({ artifactId: firstFrame.id, role: "first_frame", order: 0 });
    const preflight = await updateBrowserGenerationJob(root, job!.id, { expectedRevision: 1, status: "preflight", note: "登录、页面、余额和模式已核对。", preflightEvidence: { observedHost: "example.com", loginVerified: true, pageReady: true, generationModeVerified: true, balanceChecked: true, paidActionRequired: true, paidActionAuthorized: true, authorizationReference: "隔离夹具测试授权", observedGeneration: { aspectRatio: "9:16", resolution: "1080p", generateEnabled: true } } });
    projected = (await listVideoContinuationPacks(root)).find((entry) => entry.id === pack.id)!;
    expect(projected).toMatchObject({ status: "preflight", generationStatus: preflight.status, browserCheckpoint: { revision: 2, stage: "preflight" } });
    const uploadEvidence = { files: plan.allowedUploads.map((reference) => ({ path: reference.path, role: reference.role, order: reference.order, slot: `continuation-slot-${reference.order}` })) };
    const uploaded = await updateBrowserGenerationJob(root, job!.id, { expectedRevision: 2, status: "uploaded", uploadEvidence });
    expect((await listVideoContinuationPacks(root)).find((entry) => entry.id === pack.id)?.status).toBe("uploaded");
    const unknown = await updateBrowserGenerationJob(root, job!.id, { expectedRevision: uploaded.browserCheckpoint!.revision, status: "submit_intent", note: "点击前持久化唯一提交意图。" });
    projected = (await listVideoContinuationPacks(root)).find((entry) => entry.id === pack.id)!;
    expect(projected).toMatchObject({ status: "submission_unknown", generationStatus: "submission_unknown", browserCheckpoint: { revision: 4, stage: "submission_unknown", submissionIntent: { clientJobId: job!.id } } });
    await expect(updateVideoContinuationPack(root, pack.id, { expectedRevision: projected.revision, status: "cancelled", error: "不得绕过生成任务。" })).rejects.toThrow("状态只能由 GenerationJob 投影");
    const doctor = await doctorProject(root);
    expect(doctor.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "video-continuations", level: "warning", detail: expect.stringContaining("1 个提交结果待对账") })]));
    const generationModule = new URL("../src/core/generation.ts", import.meta.url).href;
    const editorModule = new URL("../src/core/editor.ts", import.meta.url).href;
    const recovered = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { listGenerationJobs } from ${toJsLiteral(generationModule)}; import { listVideoContinuationPacks } from ${toJsLiteral(editorModule)}; const root=${toJsLiteral(root)}; const job=(await listGenerationJobs(root)).find((entry)=>entry.id===${toJsLiteral(job!.id)}); const pack=(await listVideoContinuationPacks(root)).find((entry)=>entry.id===${toJsLiteral(pack.id)}); process.stdout.write(JSON.stringify({jobStatus:job?.status,packStatus:pack?.status,clientJobId:pack?.browserCheckpoint?.submissionIntent?.clientJobId,packRevision:pack?.revision}));`], { cwd: process.cwd() });
    expect(JSON.parse(recovered.stdout)).toEqual({ jobStatus: "submission_unknown", packStatus: "submission_unknown", clientJobId: job!.id, packRevision: projected.revision });
    const submitted = await updateBrowserGenerationJob(root, job!.id, { expectedRevision: unknown.browserCheckpoint!.revision, status: "submitted", externalTaskId: "video-web-001", submissionReconciliation: { method: "client_job_id_search", result: "found", note: "按 clientJobId 找到唯一任务。", externalTaskId: "video-web-001" } });
    expect((await listVideoContinuationPacks(root)).find((entry) => entry.id === pack.id)).toMatchObject({ status: "submitted", externalTaskId: "video-web-001" });
    const download = path.join(root, "browser-video-continuation.mp4");
    await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=24", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", download]);
    const completed = await updateBrowserGenerationJob(root, job!.id, { expectedRevision: submitted.browserCheckpoint!.revision, status: "downloaded", downloadedPath: download });
    expect(completed).toMatchObject({ status: "succeeded", browserCheckpoint: { stage: "verified" } });
    projected = (await listVideoContinuationPacks(root)).find((entry) => entry.id === pack.id)!;
    expect(projected).toMatchObject({ status: "completed", generationStatus: "succeeded", externalTaskId: "video-web-001", outputVideoPath: completed.expectedOutputPath });
    expect(projected.browserCheckpoint?.stage).toBe("verified");
  });

  it("工作流拒绝凭据并在执行快照被修改时阻止外部副作用", async () => {
    const root = await fixture();
    const settings = await getGenerationSettings(root);
    const provider = settings.providers.find((candidate) => candidate.id === "folder-image")!;
    provider.workflow = { schemaVersion: 1, name: "不安全工作流", version: "1", format: "generic-json", definition: { api_key: "secret-value" } };
    await expect(saveGenerationSettings(root, settings)).rejects.toThrow("不能保存凭据字段");

    provider.workflow = { schemaVersion: 1, name: "安全工作流", version: "1", format: "comfyui-api", definition: { "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } } }, environment: { engine: "ComfyUI", engineVersion: "0.3", models: [{ name: "model.safetensors" }] } };
    const saved = await saveGenerationSettings(root, settings);
    expect(saved.providers.find((candidate) => candidate.id === provider.id)?.workflowHash).toMatch(/^[a-f0-9]{64}$/);
    const [job] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: provider.id });
    expect(job?.executionSnapshot?.workflowHash).toBe(saved.providers.find((candidate) => candidate.id === provider.id)?.workflowHash);

    const jobs = await listGenerationJobs(root);
    const tampered = jobs.find((candidate) => candidate.id === job!.id)!;
    tampered.executionSnapshot!.provider.workflow!.definition = { replaced: true };
    await writeJsonAtomic(getSidecarPaths(root).generationJobs, jobs);
    const processed = await processGenerationQueue(root);
    const rejected = processed.find((candidate) => candidate.id === job!.id)!;
    expect(rejected.status).toBe("failed");
    expect(rejected.error).toContain("执行快照校验失败");
    expect(rejected.requestPath).toBeUndefined();
    expect((await getPublicationIntent(root, job!.publicationIntentId!))?.status).toBe("failed");
  });

  it("HTTP JSON 适配器可提交、轮询并下载新版本", async () => {
    const root = await fixture();
    const imageBuffer = await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#a87931" } }).png().toBuffer();
    let origin = "";
    let submitCount = 0;
    let cancelCount = 0;
    let submittedPayload: Record<string, unknown> | undefined;
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/submit") {
        submitCount += 1;
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          submittedPayload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: { id: "remote-1", status: "queued" } }));
        });
        return;
      }
      if (request.method === "GET" && request.url === "/tasks/remote-1") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { status: "completed", url: `${origin}/result.png` } }));
        return;
      }
      if (request.method === "POST" && request.url === "/tasks/remote-1/cancel") {
        cancelCount += 1;
        if (cancelCount === 1) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: { status: "cancelling" } }));
        } else response.writeHead(204).end();
        return;
      }
      if (request.method === "GET" && request.url === "/result.png") {
        response.writeHead(200, { "content-type": "image/png", "content-length": imageBuffer.length });
        response.end(imageBuffer);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const settings = await getGenerationSettings(root);
      const now = new Date().toISOString();
      settings.providers.push({
        id: "http-test",
        name: "HTTP 测试",
        adapter: "http-json",
        kinds: ["image"],
        enabled: true,
        endpoint: `${origin}/submit`,
        pollEndpoint: `${origin}/tasks/{taskId}`,
        cancelEndpoint: `${origin}/tasks/{taskId}/cancel`,
        cancelMethod: "POST",
        taskIdPath: "data.id",
        statusPath: "data.status",
        resultUrlPath: "data.url",
        allowPrivateNetwork: true,
        workflow: { schemaVersion: 1, name: "HTTP 生图工作流", version: "1", format: "generic-json", definition: { sampler: { steps: 24, cfg: 6.5 } }, environment: { engine: "Remote Runner", models: [{ name: "cinematic-v1" }] } },
        capabilities: { referenceModes: ["text"], maxReferenceImages: 12, maxReferenceVideos: 1, supportedDurations: [5, 10, 15], supportedAspectRatios: ["9:16"], supportedResolutions: ["1080p"], models: [], maxConcurrency: 1, supportsCancel: true },
        outputRoot: root,
        createdAt: now,
        updatedAt: now,
      });
      await saveGenerationSettings(root, settings);
      const [job] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-test" });
      const submitted = await processGenerationQueue(root);
      expect(submitted.find((candidate) => candidate.id === job!.id)?.status).toBe("waiting_remote");
      expect(submitted.find((candidate) => candidate.id === job!.id)?.externalTaskId).toBe("remote-1");
      expect(submittedPayload?.execution_snapshot_hash).toBe(job?.executionSnapshot?.snapshotHash);
      expect(submittedPayload?.workflow_hash).toBe(job?.executionSnapshot?.workflowHash);
      expect((submittedPayload?.workflow as { definition?: unknown } | undefined)?.definition).toEqual({ sampler: { cfg: 6.5, steps: 24 } });
      const conflictingCompanion = await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#264861" } }).png().toBuffer();
      await writeFile(job!.expectedCompanionPath!, conflictingCompanion);
      const blocked = await processGenerationQueue(root, { jobId: job!.id });
      expect(blocked.find((candidate) => candidate.id === job!.id)).toMatchObject({ status: "waiting_remote", remoteObservation: { state: "retryable_or_unknown", stage: "publish", nextAction: "inspect_publication" } });
      expect(await readFile(job!.expectedCompanionPath!)).toEqual(conflictingCompanion);
      expect((await getPublicationIntent(root, job!.publicationIntentId!))?.status).toBe("reserved");
      await rm(job!.expectedCompanionPath!);
      const completed = await processGenerationQueue(root, { jobId: job!.id });
      const result = completed.find((candidate) => candidate.id === job!.id)!;
      expect(result.status).toBe("succeeded");
      expect(result.publicationReceiptId).toMatch(/^receipt-/);
      await expect(access(result.expectedOutputPath)).resolves.toBeUndefined();
      await expect(access(result.expectedCompanionPath!)).resolves.toBeUndefined();

      const crashedAfterRegistration = await listGenerationJobs(root);
      const staleRegisteredJob = crashedAfterRegistration.find((candidate) => candidate.id === job!.id)!;
      staleRegisteredJob.status = "waiting_remote";
      staleRegisteredJob.publicationReceiptId = undefined;
      staleRegisteredJob.remoteObservation = { state: "retryable_or_unknown", stage: "publish", observedAt: new Date().toISOString(), message: "模拟 Publication 已登记但 Job 终态尚未落盘", retryCount: 1, nextAction: "retry_same_task" };
      await writeJsonAtomic(getSidecarPaths(root).generationJobs, crashedAfterRegistration);
      const reconciledInsteadOfCancelled = await cancelGenerationJob(root, job!.id);
      expect(reconciledInsteadOfCancelled).toMatchObject({ status: "succeeded", publicationReceiptId: result.publicationReceiptId, remoteObservation: { state: "succeeded", stage: "publish", nextAction: "none" } });
      expect(cancelCount).toBe(0);
      expect((await getPublicationIntent(root, job!.publicationIntentId!))?.status).toBe("registered");

      const [uncertainJob] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-test" });
      process.env.AI_CANVAS_TEST_GENERATION_CRASH_AFTER_REMOTE_ACCEPT = uncertainJob!.id;
      try { await processGenerationQueue(root); }
      finally { delete process.env.AI_CANVAS_TEST_GENERATION_CRASH_AFTER_REMOTE_ACCEPT; }
      const acceptedBeforeCrash = (await listGenerationJobs(root)).find((candidate) => candidate.id === uncertainJob!.id)!;
      expect(acceptedBeforeCrash.status).toBe("waiting_remote");
      expect(acceptedBeforeCrash.externalTaskId).toBe("remote-1");
      expect(acceptedBeforeCrash.remoteObservation).toMatchObject({ state: "retryable_or_unknown", stage: "submit" });
      expect((await getPublicationIntent(root, uncertainJob!.publicationIntentId!))?.status).toBe("reserved");
      const submittedBeforeCancel = submitCount;
      await expect(cancelGenerationJob(root, uncertainJob!.id)).rejects.toThrow("未返回结构化 cancelled/canceled 终态");
      expect((await listGenerationJobs(root)).find((candidate) => candidate.id === uncertainJob!.id)?.status).toBe("waiting_remote");
      expect((await getPublicationIntent(root, uncertainJob!.publicationIntentId!))?.status).toBe("reserved");
      expect((await cancelGenerationJob(root, uncertainJob!.id)).status).toBe("cancelled");
      expect(submitCount).toBe(submittedBeforeCancel);
      expect((await getPublicationIntent(root, uncertainJob!.publicationIntentId!))?.status).toBe("cancelled");
      expect(cancelCount).toBe(2);

      const [unknownWithoutId] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-test" });
      const allJobs = await listGenerationJobs(root);
      unknownWithoutId!.status = "submission_unknown";
      unknownWithoutId!.externalTaskId = undefined;
      await writeJsonAtomic(getSidecarPaths(root).generationJobs, allJobs.map((candidate) => candidate.id === unknownWithoutId!.id ? unknownWithoutId! : candidate));
      await expect(cancelGenerationJob(root, unknownWithoutId!.id)).rejects.toThrow("不能确认任务未提交，也不能制造本地假取消");
      expect((await getPublicationIntent(root, unknownWithoutId!.publicationIntentId!))?.status).toBe("reserved");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("按 jobId 恢复 HTTP 任务时绝不顺带提交其他 queued 任务", async () => {
    const root = await fixture();
    const secondDirectory = path.join(root, "EP01_15s_002_定向恢复隔离");
    await mkdir(secondDirectory, { recursive: true });
    await writeFile(path.join(secondDirectory, "00_信息.md"), "首帧提示词：另一个仍在排队的任务。\n尾帧提示词：不得被定向恢复顺带提交。\n", "utf8");
    const rescanned = await scanAndPersist(root);
    expect(rescanned.items.some((item) => item.id === "main-ep01-unit002")).toBe(true);
    await seedProductionReady(root, "frames");

    let origin = "";
    let submitCount = 0;
    let pollCount = 0;
    const submittedClientJobIds: string[] = [];
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/submit") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          submitCount += 1;
          submittedClientJobIds.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { client_job_id: string }).client_job_id);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: { id: "remote-targeted-only", status: "queued" } }));
        });
        return;
      }
      if (request.method === "GET" && request.url === "/tasks/remote-targeted-only") {
        pollCount += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { status: pollCount === 1 ? "processing" : "failed" } }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const settings = await getGenerationSettings(root);
      const now = new Date().toISOString();
      settings.providers.push({
        id: "http-targeted-recovery-test",
        name: "HTTP 定向恢复测试",
        adapter: "http-json",
        kinds: ["image"],
        enabled: true,
        endpoint: `${origin}/submit`,
        pollEndpoint: `${origin}/tasks/{taskId}`,
        taskIdPath: "data.id",
        statusPath: "data.status",
        allowPrivateNetwork: true,
        capabilities: { referenceModes: ["text"], maxReferenceImages: 12, maxReferenceVideos: 1, supportedDurations: [5], supportedAspectRatios: ["9:16"], supportedResolutions: ["1080p"], models: [], maxConcurrency: 1, supportsCancel: false },
        outputRoot: root,
        createdAt: now,
        updatedAt: now,
      });
      await saveGenerationSettings(root, settings);
      const [targetedJob] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-targeted-recovery-test" });
      const [unrelatedJob] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit002"], kind: "image", providerId: "http-targeted-recovery-test" });

      await processGenerationQueue(root, { jobId: targetedJob!.id });
      await processGenerationQueue(root, { jobId: targetedJob!.id });
      const afterPending = await listGenerationJobs(root);
      expect(afterPending.find((job) => job.id === targetedJob!.id)).toMatchObject({ status: "waiting_remote", externalTaskId: "remote-targeted-only", remoteObservation: { state: "pending", stage: "poll", nextAction: "poll_same_task" } });
      expect(afterPending.find((job) => job.id === unrelatedJob!.id)?.status).toBe("queued");
      expect(submitCount).toBe(1);
      expect(submittedClientJobIds).toEqual([targetedJob!.id]);

      await processGenerationQueue(root, { jobId: targetedJob!.id });
      expect((await listGenerationJobs(root)).find((job) => job.id === targetedJob!.id)?.status).toBe("failed");
      expect((await getPublicationIntent(root, targetedJob!.publicationIntentId!))?.status).toBe("failed");
      expect(submitCount).toBe(1);
      expect((await listGenerationJobs(root)).find((job) => job.id === unrelatedJob!.id)?.status).toBe("queued");
      expect((await cancelGenerationJob(root, unrelatedJob!.id)).status).toBe("cancelled");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("HTTP 无 Content-Length 的截断图片必须完整解码后才能发布", async () => {
    const root = await fixture();
    const completeImage = await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#61472f" } }).png().toBuffer();
    const truncatedImage = completeImage.subarray(0, completeImage.length - 20);
    expect((await sharp(truncatedImage, { failOn: "error" }).metadata()).width).toBe(720);
    await expect(sharp(truncatedImage, { failOn: "error" }).raw().toBuffer()).rejects.toThrow();

    let origin = "";
    let submitCount = 0;
    let downloadCount = 0;
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/submit") {
        submitCount += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { id: "remote-truncated-image", status: "queued" } }));
        return;
      }
      if (request.method === "GET" && request.url === "/tasks/remote-truncated-image") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { status: "completed", url: `${origin}/truncated.png` } }));
        return;
      }
      if (request.method === "GET" && request.url === "/truncated.png") {
        downloadCount += 1;
        response.writeHead(200, { "content-type": "image/png" });
        response.end(truncatedImage);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const settings = await getGenerationSettings(root);
      const now = new Date().toISOString();
      settings.providers.push({
        id: "http-truncated-image-test",
        name: "HTTP 截断图片测试",
        adapter: "http-json",
        kinds: ["image"],
        enabled: true,
        endpoint: `${origin}/submit`,
        pollEndpoint: `${origin}/tasks/{taskId}`,
        taskIdPath: "data.id",
        statusPath: "data.status",
        resultUrlPath: "data.url",
        allowPrivateNetwork: true,
        capabilities: { referenceModes: ["text"], maxReferenceImages: 12, maxReferenceVideos: 1, supportedDurations: [5], supportedAspectRatios: ["9:16"], supportedResolutions: ["1080p"], models: [], maxConcurrency: 1, supportsCancel: false },
        outputRoot: root,
        createdAt: now,
        updatedAt: now,
      });
      await saveGenerationSettings(root, settings);
      const [job] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-truncated-image-test" });
      await processGenerationQueue(root, { jobId: job!.id });
      await processGenerationQueue(root, { jobId: job!.id });
      const rejected = (await listGenerationJobs(root)).find((candidate) => candidate.id === job!.id)!;
      expect(rejected).toMatchObject({ status: "waiting_remote", remoteObservation: { state: "retryable_or_unknown", stage: "validation", nextAction: "retry_same_task" } });
      expect(rejected.error).toMatch(/read error|decode|解码/i);
      expect(submitCount).toBe(1);
      expect(downloadCount).toBe(1);
      expect((await getPublicationIntent(root, job!.publicationIntentId!))?.status).toBe("reserved");
      await expect(access(rejected.expectedOutputPath)).rejects.toThrow();
      await expect(access(path.join(getSidecarPaths(root).generationDownloads, job!.id, "result.ready"))).rejects.toThrow();
      await expect(access(path.join(getSidecarPaths(root).generationDownloads, job!.id, "result.partial"))).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("崩溃恢复时已有 result.ready 仍必须重新执行统一大小上限", async () => {
    const root = await fixture();
    const settings = await getGenerationSettings(root);
    const now = new Date().toISOString();
    settings.providers.push({
      id: "http-oversized-ready-test",
      name: "HTTP 超限 ready 测试",
      adapter: "http-json",
      kinds: ["image"],
      enabled: true,
      endpoint: "http://127.0.0.1:9/submit",
      pollEndpoint: "http://127.0.0.1:9/tasks/{taskId}",
      taskIdPath: "data.id",
      statusPath: "data.status",
      resultUrlPath: "data.url",
      allowPrivateNetwork: true,
      capabilities: { referenceModes: ["text"], maxReferenceImages: 12, maxReferenceVideos: 1, supportedDurations: [5], supportedAspectRatios: ["9:16"], supportedResolutions: ["1080p"], models: [], maxConcurrency: 1, supportsCancel: false },
      outputRoot: root,
      createdAt: now,
      updatedAt: now,
    });
    await saveGenerationSettings(root, settings);
    const [job] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-oversized-ready-test" });
    const jobs = await listGenerationJobs(root);
    const oversized = jobs.find((candidate) => candidate.id === job!.id)!;
    const isolatedDirectory = path.join(getSidecarPaths(root).generationDownloads, oversized.id);
    const readyPath = path.join(isolatedDirectory, "result.ready");
    await mkdir(isolatedDirectory, { recursive: true });
    await writeFile(readyPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await truncate(readyPath, 100 * 1024 * 1024 + 1);
    oversized.status = "waiting_remote";
    oversized.externalTaskId = "remote-oversized-ready";
    oversized.remoteResultUrl = "http://127.0.0.1:9/result.png";
    oversized.remoteAcceptedAt = now;
    oversized.isolatedDownloadPath = readyPath;
    oversized.partialDownloadPath = path.join(isolatedDirectory, "result.partial");
    oversized.remoteObservation = { state: "retryable_or_unknown", stage: "download", observedAt: now, message: "模拟崩溃后 ready", retryCount: 1, nextAction: "retry_same_task" };
    await writeJsonAtomic(getSidecarPaths(root).generationJobs, jobs);

    await processGenerationQueue(root, { jobId: oversized.id });
    const rejected = (await listGenerationJobs(root)).find((candidate) => candidate.id === oversized.id)!;
    expect(rejected).toMatchObject({ status: "waiting_remote", remoteObservation: { state: "retryable_or_unknown", stage: "validation", nextAction: "retry_same_task" } });
    expect(rejected.error).toContain("超过 104857600 字节上限");
    expect((await getPublicationIntent(root, oversized.publicationIntentId!))?.status).toBe("reserved");
    await expect(access(readyPath)).rejects.toThrow();
    await expect(access(oversized.expectedOutputPath)).rejects.toThrow();
  });

  it("HTTP 远端暂态错误、隔离 partial 与明确失败按同一任务恢复且绝不重提", async () => {
    const root = await fixture();
    const imageBuffer = await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#7a542c" } }).png().toBuffer();
    let origin = "";
    let submitCount = 0;
    let resilientPollCount = 0;
    let downloadCount = 0;
    const clientJobIds: string[] = [];
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/submit") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          submitCount += 1;
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { client_job_id: string };
          clientJobIds.push(payload.client_job_id);
          if (submitCount === 4) {
            request.socket.destroy();
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: { id: submitCount === 1 ? "remote-resilient" : submitCount === 2 ? "remote-failed" : "remote-conflict", status: "queued" } }));
        });
        return;
      }
      if (request.method === "GET" && request.url === "/tasks/remote-resilient") {
        resilientPollCount += 1;
        if (resilientPollCount === 1) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "temporary" }));
        } else if (resilientPollCount === 2) {
          request.socket.destroy();
        } else if (resilientPollCount === 3) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{bad-json");
        } else if (resilientPollCount === 4) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: { status: "completed" } }));
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: { status: "completed", url: `${origin}/resilient.png` } }));
        }
        return;
      }
      if (request.method === "GET" && request.url === "/tasks/remote-failed") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { status: "failed" } }));
        return;
      }
      if (request.method === "GET" && request.url === "/tasks/remote-conflict") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { status: "completed", url: `${origin}/conflict.png` } }));
        return;
      }
      if (request.method === "GET" && request.url === "/resilient.png") {
        downloadCount += 1;
        response.writeHead(200, { "content-type": "image/png", "content-length": imageBuffer.length });
        if (downloadCount === 1) {
          response.flushHeaders();
          response.write(imageBuffer.subarray(0, Math.max(16, Math.floor(imageBuffer.length / 3))));
          setTimeout(() => response.destroy(), 25);
        } else response.end(imageBuffer);
        return;
      }
      if (request.method === "GET" && request.url === "/conflict.png") {
        response.writeHead(200, { "content-type": "image/png", "content-length": imageBuffer.length });
        response.end(imageBuffer);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const settings = await getGenerationSettings(root);
      const now = new Date().toISOString();
      settings.providers.push({
        id: "http-resilience-test",
        name: "HTTP 恢复测试",
        adapter: "http-json",
        kinds: ["image"],
        enabled: true,
        endpoint: `${origin}/submit`,
        pollEndpoint: `${origin}/tasks/{taskId}`,
        taskIdPath: "data.id",
        statusPath: "data.status",
        resultUrlPath: "data.url",
        allowPrivateNetwork: true,
        capabilities: { referenceModes: ["text"], maxReferenceImages: 12, maxReferenceVideos: 1, supportedDurations: [5], supportedAspectRatios: ["9:16"], supportedResolutions: ["1080p"], models: [], maxConcurrency: 1, supportsCancel: false },
        outputRoot: root,
        createdAt: now,
        updatedAt: now,
      });
      await saveGenerationSettings(root, settings);
      const [job] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-resilience-test" });
      await processGenerationQueue(root);
      expect((await listGenerationJobs(root)).find((candidate) => candidate.id === job!.id)).toMatchObject({ status: "waiting_remote", externalTaskId: "remote-resilient", clientJobId: job!.id, submissionIntent: { clientJobId: job!.id, attempt: 1 } });

      for (const expectedStage of ["poll", "poll", "poll", "poll"] as const) {
        await processGenerationQueue(root);
        const retrying = (await listGenerationJobs(root)).find((candidate) => candidate.id === job!.id)!;
        expect(retrying.status).toBe("waiting_remote");
        expect(retrying.remoteObservation).toMatchObject({ state: "retryable_or_unknown", stage: expectedStage, nextAction: "retry_same_task" });
        expect(retrying.externalTaskId).toBe("remote-resilient");
        expect((await getPublicationIntent(root, job!.publicationIntentId!))?.status).toBe("reserved");
        expect(submitCount).toBe(1);
      }

      await processGenerationQueue(root);
      const interrupted = (await listGenerationJobs(root)).find((candidate) => candidate.id === job!.id)!;
      expect(interrupted.status).toBe("waiting_remote");
      expect(interrupted.remoteObservation).toMatchObject({ state: "retryable_or_unknown", stage: "download" });
      expect(interrupted.remoteResultUrl).toBe(`${origin}/resilient.png`);
      await expect(access(interrupted.expectedOutputPath)).rejects.toThrow();
      await expect(access(interrupted.partialDownloadPath!)).resolves.toBeUndefined();
      expect(path.relative(path.join(getSidecarPaths(root).generationDownloads, job!.id), interrupted.partialDownloadPath!).startsWith("..")).toBe(false);
      expect(await readdir(path.dirname(interrupted.partialDownloadPath!))).toContain("result.partial");
      expect((await getPublicationIntent(root, job!.publicationIntentId!))?.status).toBe("reserved");

      const generationModule = new URL("../src/core/generation.ts", import.meta.url).href;
      await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { processGenerationQueue } from ${toJsLiteral(generationModule)}; await processGenerationQueue(${toJsLiteral(root)});`], { cwd: process.cwd() });
      const recovered = (await listGenerationJobs(root)).find((candidate) => candidate.id === job!.id)!;
      expect(recovered.status).toBe("succeeded");
      expect(recovered.remoteObservation).toMatchObject({ state: "succeeded", stage: "publish", nextAction: "none" });
      expect(recovered.publicationReceiptId).toMatch(/^receipt-/);
      expect(await readFile(recovered.expectedOutputPath)).toEqual(imageBuffer);
      await expect(access(path.join(getSidecarPaths(root).generationDownloads, job!.id, "result.partial"))).rejects.toThrow();
      await expect(access(recovered.isolatedDownloadPath!)).resolves.toBeUndefined();
      expect((await getPublicationIntent(root, job!.publicationIntentId!))?.status).toBe("registered");
      expect(submitCount).toBe(1);
      expect(downloadCount).toBe(2);

      const [failedJob] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-resilience-test" });
      await processGenerationQueue(root);
      expect((await listGenerationJobs(root)).find((candidate) => candidate.id === failedJob!.id)?.status).toBe("waiting_remote");
      await processGenerationQueue(root);
      const failed = (await listGenerationJobs(root)).find((candidate) => candidate.id === failedJob!.id)!;
      expect(failed.remoteObservation).toMatchObject({ state: "confirmed_failed", stage: "poll", observedStatus: "failed", nextAction: "none" });
      expect(failed.status).toBe("failed");
      expect((await getPublicationIntent(root, failedJob!.publicationIntentId!))?.status).toBe("failed");

      const [conflictJob] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-resilience-test" });
      const conflictingBuffer = await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#173a59" } }).png().toBuffer();
      await writeFile(conflictJob!.expectedOutputPath, conflictingBuffer);
      await processGenerationQueue(root);
      await processGenerationQueue(root);
      const conflicted = (await listGenerationJobs(root)).find((candidate) => candidate.id === conflictJob!.id)!;
      expect(conflicted.status).toBe("waiting_remote");
      expect(conflicted.remoteObservation).toMatchObject({ state: "retryable_or_unknown", stage: "publish", nextAction: "inspect_publication" });
      expect(conflicted.error).toContain("内容不同，拒绝覆盖");
      expect(await readFile(conflictJob!.expectedOutputPath)).toEqual(conflictingBuffer);
      await expect(access(conflicted.isolatedDownloadPath!)).resolves.toBeUndefined();
      expect((await getPublicationIntent(root, conflictJob!.publicationIntentId!))?.status).toBe("reserved");
      await rm(conflictJob!.expectedOutputPath);
      await processGenerationQueue(root, { jobId: conflictJob!.id });
      expect((await listGenerationJobs(root)).find((candidate) => candidate.id === conflictJob!.id)?.status).toBe("succeeded");

      const [resultOnlyJob] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-resilience-test" });
      const resultOnlyJobs = await listGenerationJobs(root);
      const resultOnly = resultOnlyJobs.find((candidate) => candidate.id === resultOnlyJob!.id)!;
      resultOnly.status = "waiting_remote";
      resultOnly.remoteAcceptedAt = new Date().toISOString();
      resultOnly.remoteResultUrl = `${origin}/resilient.png`;
      resultOnly.externalTaskId = "result-only-manual-cancel";
      await writeJsonAtomic(getSidecarPaths(root).generationJobs, resultOnlyJobs);
      await expect(cancelGenerationJob(root, resultOnly.id)).rejects.toThrow("没有可验证的取消接口");
      const resultOnlyIntent = (await getPublicationIntent(root, resultOnly.publicationIntentId!))!;
      await cancelPublication(root, {
        intentId: resultOnlyIntent.id,
        reservationToken: resultOnlyIntent.reservationToken,
        expectedRevision: resultOnlyIntent.revision,
        reason: "测试供应商侧已经结构化确认取消后的跨存储恢复",
        provenance: { schemaVersion: 1, source: "generation", generationJobId: resultOnly.id, cause: "remote_cancel_confirmed", clientJobId: resultOnly.id, attempt: 1, externalTaskId: resultOnly.externalTaskId },
      });
      await processGenerationQueue(root, { jobId: resultOnly.id });
      expect((await listGenerationJobs(root)).find((candidate) => candidate.id === resultOnly.id)?.status).toBe("cancelled");

      const [unknownJob] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-resilience-test" });
      await processGenerationQueue(root);
      const unknown = (await listGenerationJobs(root)).find((candidate) => candidate.id === unknownJob!.id)!;
      expect(unknown.status).toBe("submission_unknown");
      expect(unknown.externalTaskId).toBeUndefined();
      expect(unknown.remoteObservation).toMatchObject({ state: "retryable_or_unknown", stage: "submit", nextAction: "inspect_remote_task" });
      expect((await getPublicationIntent(root, unknownJob!.publicationIntentId!))?.status).toBe("reserved");
      const submitCountBeforeRestart = submitCount;
      await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { processGenerationQueue } from ${toJsLiteral(generationModule)}; await processGenerationQueue(${toJsLiteral(root)}, { jobId: ${toJsLiteral(unknownJob!.id)} });`], { cwd: process.cwd() });
      expect(submitCount).toBe(submitCountBeforeRestart);
      const intentCountBeforeDuplicate = (await listPublicationIntents(root)).length;
      await expect(enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-resilience-test" })).rejects.toThrow("拒绝创建可能重复付费的新任务");
      await expect(enqueueGeneration(root, { itemIds: ["main-ep01-unit001", "main-ep01-unit001"], kind: "image", providerId: "http-resilience-test" })).rejects.toThrow("不能重复包含");
      expect((await listPublicationIntents(root)).length).toBe(intentCountBeforeDuplicate);
      expect(clientJobIds).toEqual([job!.id, failedJob!.id, conflictJob!.id, unknownJob!.id]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
