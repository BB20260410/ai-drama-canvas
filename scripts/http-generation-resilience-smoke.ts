import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { doctorProject, getCapabilities, getProjectSnapshot } from "../src/core/codex.js";
import { cancelGenerationJob, enqueueGeneration, getGenerationSettings, listGenerationJobs, processGenerationQueue, reconcileHttpGenerationSubmission, saveGenerationSettings } from "../src/core/generation.js";
import { listProjectLocks } from "../src/core/locks.js";
import { readMachineMediaRuntimeSnapshot } from "../src/core/media-runtime.js";
import { getPublicationIntent, listPublicationIntents, listPublicationReceipts } from "../src/core/publication.js";
import { scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import type { GenerationJob } from "../src/core/types.js";
import { seedProductionReady } from "../tests/workflow-helpers.js";

const execFileAsync = promisify(execFile);
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const evidencePath = path.resolve(process.argv[2] || path.join("docs", "evidence", `http-generation-resilience-smoke-${stamp}.json`));
const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-http-generation-smoke-"));
process.env.AI_CANVAS_REGISTRY_PATH = path.join(root, "registry.json");
process.env.AI_CANVAS_MEDIA_RUNTIME_DIR = path.join(root, "media-runtime");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true).catch(() => false);
}

async function sha256Bytes(value: Buffer): Promise<string> {
  return createHash("sha256").update(value).digest("hex");
}

async function jobById(jobId: string): Promise<GenerationJob> {
  const job = (await listGenerationJobs(root)).find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`找不到 smoke 生成任务：${jobId}`);
  return job;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("等待隔离 HTTP smoke 条件超时。 ");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function processInFreshNode(jobId: string): Promise<void> {
  const moduleUrl = new URL("../src/core/generation.ts", import.meta.url).href;
  await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { processGenerationQueue } from ${JSON.stringify(moduleUrl)}; await processGenerationQueue(${JSON.stringify(root)}, { jobId: ${JSON.stringify(jobId)} });`], { cwd: process.cwd(), env: process.env });
}

const sourceImage = await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#93622f" } }).png().toBuffer();
const conflictImage = await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#163d62" } }).png().toBuffer();
let origin = "";
const requestCounts = { submit: 0, resilientPoll: 0, resilientDownload: 0, failedPoll: 0, cancel: 0, conflictPoll: 0, conflictDownload: 0, reconciledFoundPoll: 0, reconciledFoundDownload: 0 };
const clientJobIds: string[] = [];

const server = createServer((request, response) => {
  if (request.method === "POST" && request.url === "/submit") {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requestCounts.submit += 1;
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { client_job_id: string };
      clientJobIds.push(payload.client_job_id);
      if (requestCounts.submit === 5 || requestCounts.submit === 6) {
        request.socket.destroy();
        return;
      }
      const externalTaskId = requestCounts.submit === 1
        ? "remote-resilient"
        : requestCounts.submit === 2
          ? "remote-confirmed-failed"
          : requestCounts.submit === 3
            ? "remote-cancel"
            : "remote-conflict";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { id: externalTaskId, status: "queued" } }));
    });
    return;
  }
  if (request.method === "GET" && request.url === "/tasks/remote-resilient") {
    requestCounts.resilientPoll += 1;
    if (requestCounts.resilientPoll === 1) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "temporary upstream" }));
    } else if (requestCounts.resilientPoll === 2) {
      request.socket.destroy();
    } else if (requestCounts.resilientPoll === 3) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{broken-json");
    } else if (requestCounts.resilientPoll === 4) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { status: "completed" } }));
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { status: "completed", url: `${origin}/resilient.png?signature=local-secret-query` } }));
    }
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/resilient.png")) {
    requestCounts.resilientDownload += 1;
    response.writeHead(200, { "content-type": "image/png", "content-length": sourceImage.length });
    if (requestCounts.resilientDownload === 1) {
      response.flushHeaders();
      response.write(sourceImage.subarray(0, Math.max(16, Math.floor(sourceImage.length / 3))));
    } else response.end(sourceImage);
    return;
  }
  if (request.method === "GET" && request.url === "/tasks/remote-confirmed-failed") {
    requestCounts.failedPoll += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { status: "failed" } }));
    return;
  }
  if (request.method === "POST" && request.url === "/tasks/remote-cancel/cancel") {
    requestCounts.cancel += 1;
    if (requestCounts.cancel === 1) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { status: "cancelling" } }));
    } else if (requestCounts.cancel === 2) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "cancel not confirmed" }));
    } else response.writeHead(204).end();
    return;
  }
  if (request.method === "GET" && request.url === "/tasks/remote-conflict") {
    requestCounts.conflictPoll += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { status: "completed", url: `${origin}/conflict.png` } }));
    return;
  }
  if (request.method === "GET" && request.url === "/tasks/remote-disconnected-found") {
    requestCounts.reconciledFoundPoll += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { status: "completed", url: `${origin}/reconciled-found.png?signature=must-remain-local` } }));
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/reconciled-found.png")) {
    requestCounts.reconciledFoundDownload += 1;
    response.writeHead(200, { "content-type": "image/png", "content-length": sourceImage.length });
    response.end(sourceImage);
    return;
  }
  if (request.method === "GET" && request.url === "/conflict.png") {
    requestCounts.conflictDownload += 1;
    response.writeHead(200, { "content-type": "image/png", "content-length": sourceImage.length });
    response.end(sourceImage);
    return;
  }
  response.writeHead(404).end();
});

let evidence: Record<string, unknown> = {};
let serverStarted = false;
let serverClosed = false;
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverStarted = true;
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  config.hardLocks = [];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const unitDirectory = path.join(root, "EP01_15s_001_HTTP恢复证据");
  await mkdir(unitDirectory, { recursive: true });
  await writeFile(path.join(unitDirectory, "00_信息.md"), "# HTTP 恢复证据\n\n首帧提示词：电影写实测试。\n尾帧提示词：保持角色连续。\n", "utf8");
  await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#5b412b" } }).png().toFile(path.join(unitDirectory, "EP01_15s_001_首帧_v1_raw.png"));
  await scanAndPersist(root);
  await seedProductionReady(root, "frames");

  const settings = await getGenerationSettings(root);
  const now = new Date().toISOString();
  settings.providers.push({
    id: "http-resilience-smoke",
    name: "HTTP 恢复 Smoke",
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
    capabilities: { referenceModes: ["text"], maxReferenceImages: 12, maxReferenceVideos: 1, supportedDurations: [5], supportedAspectRatios: ["9:16"], supportedResolutions: ["1080p"], models: [], maxConcurrency: 1, supportsCancel: true },
    outputRoot: root,
    createdAt: now,
    updatedAt: now,
  });
  await saveGenerationSettings(root, settings);

  const [resilientJob] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-resilience-smoke" });
  assert(resilientJob, "未创建 resilient smoke 任务。 ");
  const observations: Array<Record<string, unknown>> = [];
  await processGenerationQueue(root, { jobId: resilientJob.id });
  let current = await jobById(resilientJob.id);
  assert(current.status === "waiting_remote" && current.externalTaskId === "remote-resilient", "首次提交未持久化远端身份。 ");
  for (const label of ["http-500", "socket-disconnect", "invalid-json", "completed-without-url"]) {
    await processGenerationQueue(root, { jobId: resilientJob.id });
    current = await jobById(resilientJob.id);
    const intent = await getPublicationIntent(root, resilientJob.publicationIntentId!);
    assert(current.status === "waiting_remote", `${label} 被错误闭合为终态。`);
    assert(current.remoteObservation?.state === "retryable_or_unknown", `${label} 未记录 retryable_or_unknown。`);
    assert(intent?.status === "reserved", `${label} 错误关闭 Publication。`);
    assert(requestCounts.submit === 1, `${label} 导致重复 POST。`);
    observations.push({ label, status: current.status, observation: current.remoteObservation, intentStatus: intent.status, submitCount: requestCounts.submit, externalTaskId: current.externalTaskId });
  }
  const doctorDuringRetry = await doctorProject(root);
  const snapshotDuringRetry = await getProjectSnapshot(root);
  const generationCheck = doctorDuringRetry.checks.find((check) => check.id === "generation-jobs");
  assert(generationCheck?.suggestedAction?.includes("process_generation_queue(jobId)"), "Doctor 生成检查没有给出定向同任务恢复动作。 ");
  assert(snapshotDuringRetry.runtimeResources.generation.activeJobIds.includes(resilientJob.id), "统一快照漏掉 waiting_remote 活跃任务。 ");
  assert(!JSON.stringify(snapshotDuringRetry).includes("local-secret-query"), "统一快照泄露签名结果 URL。 ");

  const moduleUrl = new URL("../src/core/generation.ts", import.meta.url).href;
  const crashWorker = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { processGenerationQueue } from ${JSON.stringify(moduleUrl)}; await processGenerationQueue(${JSON.stringify(root)}, { jobId: ${JSON.stringify(resilientJob.id)} });`], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "ignore", "pipe"] });
  const crashStderr: Buffer[] = [];
  crashWorker.stderr?.on("data", (chunk) => crashStderr.push(Buffer.from(chunk)));
  const crashClosed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => crashWorker.once("close", (code, signal) => resolve({ code, signal })));
  const partialPath = path.join(getSidecarPaths(root).generationDownloads, resilientJob.id, "result.partial");
  await waitFor(async () => await stat(partialPath).then((metadata) => metadata.size > 0).catch(() => false));
  const locksWhileDownloading = await listProjectLocks(root);
  crashWorker.kill("SIGKILL");
  const crashExit = await crashClosed;
  assert(crashExit.signal === "SIGKILL", `下载 worker 未按 SIGKILL 异常退出：${JSON.stringify(crashExit)} ${Buffer.concat(crashStderr).toString("utf8").slice(-1_000)}`);
  const locksAfterCrash = await listProjectLocks(root);
  const interrupted = await jobById(resilientJob.id);
  assert(interrupted.status === "waiting_remote" && interrupted.remoteObservation?.stage === "download", "partial 下载未保持 waiting_remote/download 观测。 ");
  assert(!(await exists(interrupted.expectedOutputPath)), "partial 下载污染了最终预留目标。 ");
  assert(Boolean(interrupted.partialDownloadPath) && await exists(partialPath), "partial 没有留在任务隔离目录。 ");
  assert(!(await exists(path.join(getSidecarPaths(root).generationDownloads, resilientJob.id, "result.ready"))), "异常退出前不应存在 ready 文件。 ");
  const partialStat = await stat(partialPath);
  assert(partialStat.size > 0 && partialStat.size < sourceImage.length, "partial 大小不符合中断证据。 ");

  await processInFreshNode(resilientJob.id);
  const recovered = await jobById(resilientJob.id);
  const recoveredIntent = await getPublicationIntent(root, resilientJob.publicationIntentId!);
  const recoveredBytes = await readFile(recovered.expectedOutputPath);
  assert(recovered.status === "succeeded" && recovered.remoteObservation?.state === "succeeded", "跨进程恢复没有成功。 ");
  assert(recoveredIntent?.status === "registered" && Boolean(recovered.publicationReceiptId), "恢复成功但没有唯一 Publication 回执。 ");
  assert(recoveredBytes.equals(sourceImage), "最终媒体与 loopback 源结果不一致。 ");
  assert(!(await exists(path.join(getSidecarPaths(root).generationDownloads, resilientJob.id, "result.partial"))), "恢复成功后仍残留 partial。 ");
  assert(await exists(recovered.isolatedDownloadPath!), "恢复成功后缺少完整隔离结果。 ");
  assert(requestCounts.submit === 1 && requestCounts.resilientDownload === 2, "跨进程恢复重复 POST 或未重试下载。 ");
  const staleRegisteredJobs = await listGenerationJobs(root);
  const staleRegistered = staleRegisteredJobs.find((job) => job.id === resilientJob.id)!;
  staleRegistered.status = "waiting_remote";
  staleRegistered.publicationReceiptId = undefined;
  staleRegistered.remoteObservation = { state: "retryable_or_unknown", stage: "publish", observedAt: new Date().toISOString(), message: "模拟 Publication 已登记但 Job 终态未落盘", retryCount: 1, nextAction: "retry_same_task" };
  await writeJsonAtomic(getSidecarPaths(root).generationJobs, staleRegisteredJobs);
  const registeredCrashRecovery = await cancelGenerationJob(root, resilientJob.id);
  assert(registeredCrashRecovery.status === "succeeded" && registeredCrashRecovery.publicationReceiptId === recovered.publicationReceiptId, "取消前没有从已登记 Publication 恢复成功终态。 ");
  assert(requestCounts.cancel === 0, "已登记 Publication 恢复仍错误调用了远端取消。 ");

  const [failedJob] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-resilience-smoke" });
  assert(failedJob, "未创建 confirmed failed 任务。 ");
  await processGenerationQueue(root, { jobId: failedJob.id });
  await processGenerationQueue(root, { jobId: failedJob.id });
  const confirmedFailed = await jobById(failedJob.id);
  assert(confirmedFailed.status === "failed" && confirmedFailed.remoteObservation?.state === "confirmed_failed", "结构化 failed 未闭合为 confirmed_failed。 ");
  assert((await getPublicationIntent(root, failedJob.publicationIntentId!))?.status === "failed", "confirmed failed 没有关闭 Publication。 ");

  const [cancelJob] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-resilience-smoke" });
  assert(cancelJob, "未创建取消任务。 ");
  await processGenerationQueue(root, { jobId: cancelJob.id });
  const cancelPartial = path.join(getSidecarPaths(root).generationDownloads, cancelJob.id, "result.partial");
  await mkdir(path.dirname(cancelPartial), { recursive: true });
  await writeFile(cancelPartial, "cancel cleanup partial", "utf8");
  let cancelPendingFailure = "";
  try { await cancelGenerationJob(root, cancelJob.id); }
  catch (error) { cancelPendingFailure = error instanceof Error ? error.message : String(error); }
  assert(/cancelled\/canceled/.test(cancelPendingFailure), "取消 HTTP 200 pending 被错误当作确认终态。 ");
  assert((await jobById(cancelJob.id)).status === "waiting_remote" && (await getPublicationIntent(root, cancelJob.publicationIntentId!))?.status === "reserved", "取消 HTTP 200 pending 错误改变本地终态。 ");
  assert(await exists(cancelPartial), "取消失败错误清理了隔离 partial。 ");
  let cancelHttpFailure = "";
  try { await cancelGenerationJob(root, cancelJob.id); }
  catch (error) { cancelHttpFailure = error instanceof Error ? error.message : String(error); }
  assert(/503/.test(cancelHttpFailure), "取消 503 没有保留本地状态。 ");
  assert((await jobById(cancelJob.id)).status === "waiting_remote" && (await getPublicationIntent(root, cancelJob.publicationIntentId!))?.status === "reserved", "取消 503 错误改变本地终态。 ");
  assert(await exists(cancelPartial), "取消 503 错误清理了隔离 partial。 ");
  const cancelled = await cancelGenerationJob(root, cancelJob.id);
  assert(cancelled.status === "cancelled" && Number(requestCounts.cancel) === 3, "真实远端取消没有在确认后终结。 ");
  assert((await getPublicationIntent(root, cancelJob.publicationIntentId!))?.status === "cancelled", "取消没有同步 Publication。 ");
  assert(!(await exists(path.dirname(cancelPartial))) && !cancelled.remoteObservation, "取消成功后仍残留隔离下载或重试动作。 ");

  const [conflictJob] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-resilience-smoke" });
  assert(conflictJob, "未创建不可覆盖冲突任务。 ");
  await writeFile(conflictJob.expectedOutputPath, conflictImage);
  await processGenerationQueue(root, { jobId: conflictJob.id });
  await processGenerationQueue(root, { jobId: conflictJob.id });
  const conflict = await jobById(conflictJob.id);
  assert(conflict.status === "waiting_remote" && conflict.remoteObservation?.stage === "publish" && conflict.remoteObservation.nextAction === "inspect_publication", "最终路径冲突没有保持人工核对状态。 ");
  assert((await readFile(conflictJob.expectedOutputPath)).equals(conflictImage), "不可覆盖发布改写了既有最终文件。 ");
  assert((await getPublicationIntent(root, conflictJob.publicationIntentId!))?.status === "reserved", "最终路径冲突错误关闭 Publication。 ");
  const conflictObservation = structuredClone(conflict.remoteObservation);
  const conflictSha256 = await sha256Bytes(await readFile(conflictJob.expectedOutputPath));
  await rm(conflictJob.expectedOutputPath);
  await processInFreshNode(conflictJob.id);
  const conflictRecovered = await jobById(conflictJob.id);
  assert(conflictRecovered.status === "succeeded", "人工解除路径占用后同一任务没有从隔离 ready 恢复。 ");

  const [unknownJob] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-resilience-smoke" });
  assert(unknownJob, "未创建 submit disconnect 任务。 ");
  await processGenerationQueue(root, { jobId: unknownJob.id });
  const unknown = await jobById(unknownJob.id);
  assert(unknown.status === "submission_unknown" && !unknown.externalTaskId, "POST 断连没有进入 submission_unknown。 ");
  assert((await getPublicationIntent(root, unknownJob.publicationIntentId!))?.status === "reserved", "POST 断连错误关闭 Publication。 ");
  const submitBeforeUnknownRestart = requestCounts.submit;
  await processInFreshNode(unknownJob.id);
  assert(requestCounts.submit === submitBeforeUnknownRestart, "submission_unknown 在重启后重复 POST。 ");
  const intentCountBeforeDuplicate = (await listPublicationIntents(root)).length;
  let duplicateError = "";
  try { await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-resilience-smoke" }); }
  catch (error) { duplicateError = error instanceof Error ? error.message : String(error); }
  assert(/重复付费/.test(duplicateError) && (await listPublicationIntents(root)).length === intentCountBeforeDuplicate, "submission_unknown 未阻止重复任务或产生了额外 Publication。 ");

  const foundReconciliation = await reconcileHttpGenerationSubmission(root, unknownJob.id, {
    expectedRevision: 1,
    reconciliation: { result: "found", method: "client_job_id_search", externalTaskId: "remote-disconnected-found", evidenceReference: "loopback-provider-search-audit-001", note: "按 clientJobId 在 loopback 任务列表找到唯一任务" },
  });
  assert(foundReconciliation.applied && foundReconciliation.outcome === "found" && foundReconciliation.httpSubmissionCheckpoint.revision === 2, "found 对账没有推进独立检查点。 ");
  assert(requestCounts.submit === submitBeforeUnknownRestart, "found 对账命令错误发起 POST。 ");
  await processInFreshNode(unknownJob.id);
  const foundRecovered = await jobById(unknownJob.id);
  const submitAfterFound = requestCounts.submit;
  assert(foundRecovered.status === "succeeded" && foundRecovered.externalTaskId === "remote-disconnected-found", "found 对账后没有在 fresh Node 恢复同一远端任务。 ");
  assert(requestCounts.submit === submitBeforeUnknownRestart && requestCounts.reconciledFoundPoll === 1 && requestCounts.reconciledFoundDownload === 1, "found 对账后重复 POST 或没有定向轮询/下载。 ");
  assert((await getPublicationIntent(root, unknownJob.publicationIntentId!))?.status === "registered", "found 对账恢复没有登记 Publication。 ");

  const [notFoundJob] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-resilience-smoke" });
  assert(notFoundJob, "未创建 not_found submit disconnect 任务。 ");
  await processGenerationQueue(root, { jobId: notFoundJob.id });
  const notFoundUnknown = await jobById(notFoundJob.id);
  assert(notFoundUnknown.status === "submission_unknown" && notFoundUnknown.httpSubmissionCheckpoint?.revision === 1, "第二次 POST 断连没有进入 HTTP unknown R1。 ");
  const submitBeforeNotFound = requestCounts.submit;
  const notFoundReconciliation = await reconcileHttpGenerationSubmission(root, notFoundJob.id, {
    expectedRevision: 1,
    reconciliation: { result: "not_found", method: "provider_request_log", confirmNoRemoteResult: true, evidenceReference: "loopback-request-log-audit-002", note: "loopback 请求日志确认未建立远端任务" },
  });
  assert(notFoundReconciliation.applied && notFoundReconciliation.outcome === "not_found" && notFoundReconciliation.status === "failed", "not_found 对账没有安全闭合旧任务。 ");
  assert(requestCounts.submit === submitBeforeNotFound, "not_found 对账命令错误发起 POST。 ");
  const notFoundIntent = await getPublicationIntent(root, notFoundJob.publicationIntentId!);
  assert(notFoundIntent?.status === "failed" && notFoundIntent.terminal?.provenance?.cause === "http_submission_not_found", "not_found 没有写入匹配来源的 Publication 终态。 ");
  const [replacementJob] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-resilience-smoke" });
  assert(replacementJob?.status === "queued" && replacementJob.id !== notFoundJob.id && requestCounts.submit === submitBeforeNotFound, "not_found 后没有允许显式新版本，或入队时错误自动 POST。 ");

  const [locks, runtime, intents, receipts, capabilities] = await Promise.all([listProjectLocks(root), readMachineMediaRuntimeSnapshot(), listPublicationIntents(root), listPublicationReceipts(root), getCapabilities(root)]);
  const rootTree = await readdir(root, { recursive: true });
  const transientFiles = rootTree.filter((entry) => entry.endsWith("result.partial") || entry.includes(".publish.tmp"));
  assert(!locks.length && runtime.activeWeight === 0 && runtime.queueDepth === 0, "HTTP smoke 结束后仍有锁或媒体租约。 ");
  assert(!transientFiles.length, `HTTP smoke 结束后仍有 partial/publish 临时文件：${transientFiles.join("、")}`);
  assert(receipts.filter((receipt) => receipt.intentId === resilientJob.publicationIntentId).length === 1, "恢复任务不是唯一 Publication 回执。 ");
  assert(capabilities.generation.httpRemoteRecovery.automaticPostReplayAfterUnknown === false, "能力合同错误声明可自动重放 POST。 ");
  assert(capabilities.generation.httpRemoteRecovery.recoveryScope === "single-job", "能力合同没有声明定向恢复作用域。 ");
  assert(capabilities.generation.httpRemoteRecovery.cancellationConfirmation === "204-or-200-structured-cancelled" && capabilities.generation.httpRemoteRecovery.publicationTerminalReconciledBeforeCancel === true, "能力合同没有声明严格取消确认与 Publication 优先对账。 ");
  assert(capabilities.generation.httpRemoteRecovery.mcpCommandResultsSanitized === true, "能力合同没有声明 MCP 写命令结果脱敏。 ");
  assert(capabilities.generation.httpRemoteRecovery.submissionUnknownReconciliationCAS === true && capabilities.generation.httpRemoteRecovery.submissionUnknownReconciliationMakesRemoteRequests === false, "能力合同没有声明 HTTP unknown 对账 CAS 与零网络副作用。 ");
  assert(capabilities.generation.httpRemoteRecovery.generationPublicationTerminalRequiresStructuredProvenance === true, "能力合同没有声明 Generation/Publication 终态来源绑定。 ");
  assert(new Set(clientJobIds).size === clientJobIds.length && clientJobIds.length === 6 && clientJobIds[0] === resilientJob.id, "clientJobId 不稳定、重复或请求数量异常。 ");

  evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    success: true,
    command: "npm run generation:http-resilience-smoke -- <evidence-path>",
    environment: { platform: process.platform, arch: process.arch, node: process.version, loopbackOnly: true, isolatedProject: true, realImageDecode: true },
    cases: {
      resilientPolling: { jobId: resilientJob.id, externalTaskId: recovered.externalTaskId, clientJobId: recovered.clientJobId, observations, finalStatus: recovered.status, observation: recovered.remoteObservation, submitCount: 1 },
      partialRestart: { partialBytes: partialStat.size, sourceBytes: sourceImage.length, workerPid: crashWorker.pid, workerExit: crashExit, killedWithSigkill: crashExit.signal === "SIGKILL", generationLockPresentWhileDownloading: locksWhileDownloading.some((entry) => entry.name === "generation"), locksObservedAfterCrash: locksAfterCrash.map(({ name, pid, ageMs, stale }) => ({ name, pid, ageMs, stale })), finalWasAbsentBeforeRestart: true, readyWasAbsentBeforeRestart: true, freshNodeRecovery: true, finalSha256: await sha256Bytes(recoveredBytes), sourceSha256: await sha256Bytes(sourceImage), readyPresent: await exists(recovered.isolatedDownloadPath!), partialRemoved: !(await exists(path.join(getSidecarPaths(root).generationDownloads, resilientJob.id, "result.partial"))) },
      registeredCrashRecovery: { staleStatus: "waiting_remote", cancelRequestResult: registeredCrashRecovery.status, publicationReceiptId: registeredCrashRecovery.publicationReceiptId, remoteCancelRequests: 0 },
      confirmedFailure: { jobId: failedJob.id, status: confirmedFailed.status, observation: confirmedFailed.remoteObservation, intentStatus: (await getPublicationIntent(root, failedJob.publicationIntentId!))?.status, receiptPresent: Boolean(confirmedFailed.publicationReceiptId) },
      cancellation: { jobId: cancelJob.id, pending200Attempt: cancelPendingFailure, failed503Attempt: cancelHttpFailure, statusAfterFailedAttempts: "waiting_remote", intentAfterFailedAttempts: "reserved", finalStatus: cancelled.status, remoteCancelCount: requestCounts.cancel, intentStatus: (await getPublicationIntent(root, cancelJob.publicationIntentId!))?.status, isolatedDirectoryRemoved: !(await exists(path.dirname(cancelPartial))), retryObservationCleared: !cancelled.remoteObservation },
      submitDisconnect: { jobId: unknownJob.id, initialStatus: unknown.status, observation: unknown.remoteObservation, initialIntentStatus: "reserved", postCountBeforeRestart: submitBeforeUnknownRestart, postCountAfterRestart: submitBeforeUnknownRestart, duplicateBlocked: /重复付费/.test(duplicateError) },
      submissionUnknownFound: { jobId: unknownJob.id, reconciliation: foundReconciliation, freshNodeRecoveryStatus: foundRecovered.status, externalTaskId: foundRecovered.externalTaskId, publicationStatus: (await getPublicationIntent(root, unknownJob.publicationIntentId!))?.status, postCount: submitAfterFound, pollCount: requestCounts.reconciledFoundPoll, downloadCount: requestCounts.reconciledFoundDownload },
      submissionUnknownNotFound: { jobId: notFoundJob.id, unknownCheckpoint: notFoundUnknown.httpSubmissionCheckpoint, reconciliation: notFoundReconciliation, publicationStatus: notFoundIntent.status, publicationProvenance: notFoundIntent.terminal?.provenance, postCountBefore: submitBeforeNotFound, postCountAfter: requestCounts.submit, replacementJob: { id: replacementJob.id, status: replacementJob.status, expectedOutputPath: replacementJob.expectedOutputPath } },
      noClobber: { jobId: conflictJob.id, blockedStatus: conflict.status, observation: conflictObservation, conflictingFileSha256: conflictSha256, expectedConflictSha256: await sha256Bytes(conflictImage), isolatedReadyPresentWhileBlocked: await exists(conflict.isolatedDownloadPath!), blockedIntentStatus: "reserved", recoveredAfterManualResolution: conflictRecovered.status, recoveredFinalSha256: await sha256Bytes(await readFile(conflictJob.expectedOutputPath)), recoveredIntentStatus: (await getPublicationIntent(root, conflictJob.publicationIntentId!))?.status },
    },
    requestCounts,
    clientJobIds,
    doctor: { generationCheck, suggestedNextCalls: doctorDuringRetry.suggestedNextCalls },
    snapshot: { activeGeneration: snapshotDuringRetry.runtimeResources.generation, retryJob: snapshotDuringRetry.generationJobs.find((job) => job.id === resilientJob.id), signedUrlQueryExposed: JSON.stringify(snapshotDuringRetry).includes("local-secret-query") },
    capabilities: capabilities.generation.httpRemoteRecovery,
    publication: { intentCounts: Object.fromEntries((["reserved", "registered", "cancelled", "failed"] as const).map((status) => [status, intents.filter((intent) => intent.status === status).length])), receiptCount: receipts.length, resilientReceiptCount: receipts.filter((receipt) => receipt.intentId === resilientJob.publicationIntentId).length },
    terminal: { projectLocks: locks.length, activeMediaWeight: runtime.activeWeight, mediaQueueDepth: runtime.queueDepth, generationDownloadEntries: await readdir(getSidecarPaths(root).generationDownloads), transientFiles },
    boundaries: { formalProjectRootsTouched: false, realProvidersContacted: false, uploadsPerformed: false, paidSubmissionsPerformed: false, existingMediaOverwritten: false, signedPackageOverwritten: false, softwarePublished: false, notarizationPerformed: false },
  };
} catch (error) {
  evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), success: false, error: error instanceof Error ? error.stack ?? error.message : String(error), requestCounts };
} finally {
  if (serverStarted) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  serverClosed = true;
  await rm(root, { recursive: true, force: true });
  evidence.cleanup = { serverClosed, isolatedProjectRemoved: !(await exists(root)), registryRemovedWithProject: !(await exists(process.env.AI_CANVAS_REGISTRY_PATH!)) };
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify({ success: evidence.success, evidencePath })}\n`);
if (!evidence.success) process.exitCode = 1;
