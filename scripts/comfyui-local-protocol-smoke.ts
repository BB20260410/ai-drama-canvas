import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { doctorProject, getCapabilities, getProjectSnapshot } from "../src/core/codex.js";
import { cancelGenerationJob, enqueueGeneration, getGenerationSettings, getHttpGenerationSubmissionCheckpoint, listGenerationJobs, processGenerationQueue, upsertGenerationProvider } from "../src/core/generation.js";
import { listProjectLocks } from "../src/core/locks.js";
import { readMachineMediaRuntimeSnapshot } from "../src/core/media-runtime.js";
import { getPublicationIntent, listPublicationIntents, listPublicationReceipts } from "../src/core/publication.js";
import { scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import type { GenerationJob } from "../src/core/types.js";
import { seedProductionReady } from "../tests/workflow-helpers.js";
import { toJsLiteral } from "../src/core/js-code-literal.js";

const execFileAsync = promisify(execFile);
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const evidencePath = path.resolve(process.argv[2] || path.join("docs", "evidence", `comfyui-local-protocol-smoke-${stamp}.json`));
const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-comfyui-protocol-smoke-"));
const registryPath = path.join(root, "registry.json");
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
process.env.AI_CANVAS_MEDIA_RUNTIME_DIR = path.join(root, "media-runtime");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true).catch(() => false);
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function jobById(jobId: string): Promise<GenerationJob> {
  const job = (await listGenerationJobs(root)).find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`找不到 ComfyUI smoke 任务：${jobId}`);
  return job;
}

async function processFresh(jobId: string): Promise<void> {
  const moduleUrl = new URL("../src/core/generation.ts", import.meta.url).href;
  await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { processGenerationQueue } from ${toJsLiteral(moduleUrl)}; await processGenerationQueue(${toJsLiteral(root)}, { jobId: ${toJsLiteral(jobId)} });`], { cwd: process.cwd(), env: process.env, maxBuffer: 2_000_000 });
}

type PromptState = "pending" | "running" | "success" | "failed" | "cancelled";
type Submission = {
  prompt_id: string;
  client_id: string;
  prompt: Record<string, unknown>;
  extra_data: { aicanvas: Record<string, unknown> };
};

const outputImage = await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#8b5f38" } }).png().toBuffer();
const states = new Map<string, PromptState>();
const submissions = new Map<string, Submission>();
const hidden = new Set<string>();
const historyModes = new Map<string, "normal" | "error_text_mentions_interrupt">();
const delayedRunningCancel = new Set<string>();
let preflightMode: "ok" | "503" = "ok";
let disconnectNext = false;
const counts = { post: 0, history: 0, queue: 0, view: 0, atomicCancel: 0, legacyQueueCancel: 0, legacyInterrupt: 0 };

function promptTuple(id: string, number = 1): unknown[] {
  const submission = submissions.get(id);
  if (!submission) throw new Error(`loopback 缺少提交：${id}`);
  return [number, id, submission.prompt, { client_id: submission.client_id, aicanvas: submission.extra_data.aicanvas }, ["9"]];
}

const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const json = (status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  try {
    if (request.method === "GET" && url.pathname === "/system_stats") return preflightMode === "503" ? json(503, { error: "temporary" }) : json(200, { system: { comfyui_version: "protocol-smoke", os: "loopback" }, devices: [] });
    if (request.method === "GET" && url.pathname === "/features") return json(200, { api_jobs_cancel: true });
    if (request.method === "GET" && url.pathname.startsWith("/object_info/")) return json(200, { [decodeURIComponent(url.pathname.slice("/object_info/".length))]: { input: { required: {} }, output: [] } });
    if (request.method === "POST" && url.pathname === "/prompt") {
      const payload = await requestBody(request) as unknown as Submission;
      counts.post += 1;
      submissions.set(payload.prompt_id, payload);
      states.set(payload.prompt_id, "pending");
      if (disconnectNext) {
        disconnectNext = false;
        hidden.add(payload.prompt_id);
        request.socket.destroy();
        return;
      }
      return json(200, { prompt_id: payload.prompt_id, number: counts.post, node_errors: {} });
    }
    if (request.method === "GET" && url.pathname === "/queue") {
      counts.queue += 1;
      const running = [...states].filter(([id, state]) => state === "running" && !hidden.has(id)).map(([id]) => promptTuple(id, 1));
      const pending = [...states].filter(([id, state]) => state === "pending" && !hidden.has(id)).map(([id]) => promptTuple(id, 2));
      return json(200, { queue_running: running, queue_pending: pending });
    }
    if (request.method === "GET" && url.pathname.startsWith("/history/")) {
      counts.history += 1;
      const id = decodeURIComponent(url.pathname.slice("/history/".length));
      const state = states.get(id);
      if (hidden.has(id) || !state || state === "pending" || state === "running") return json(200, {});
      if (state === "success") return json(200, { [id]: { prompt: promptTuple(id), status: { status_str: "success", completed: true, messages: [["execution_success", { prompt_id: id }]] }, outputs: { "9": { images: [{ filename: `${id}.png`, subfolder: "AI_Canvas", type: "output" }] } } } });
      if (state === "cancelled") return json(200, { [id]: { prompt: promptTuple(id), status: { status_str: "error", completed: false, messages: [["execution_interrupted", { prompt_id: id }]] }, outputs: {} } });
      const text = historyModes.get(id) === "error_text_mentions_interrupt" ? "ordinary failure text mentions execution_interrupted" : "node failed";
      return json(200, { [id]: { prompt: promptTuple(id), status: { status_str: "error", completed: false, messages: [["execution_error", { prompt_id: id, exception_message: text }]] }, outputs: {} } });
    }
    if (request.method === "GET" && url.pathname === "/view") {
      counts.view += 1;
      response.writeHead(200, { "content-type": "image/png", "content-length": outputImage.length });
      response.end(outputImage);
      return;
    }
    const atomicCancel = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && atomicCancel) {
      counts.atomicCancel += 1;
      const id = decodeURIComponent(atomicCancel[1]!);
      const state = states.get(id);
      if (state === "pending") states.delete(id);
      else if (state === "running") {
        if (delayedRunningCancel.has(id)) states.delete(id);
        else states.set(id, "cancelled");
      }
      return json(200, { cancelled: state === "pending" || state === "running" });
    }
    if (request.method === "POST" && url.pathname === "/queue") {
      counts.legacyQueueCancel += 1;
      return json(410, { error: "legacy queue cancel forbidden" });
    }
    if (request.method === "POST" && url.pathname === "/interrupt") {
      counts.legacyInterrupt += 1;
      return json(410, { error: "legacy interrupt forbidden" });
    }
    response.writeHead(404).end();
  } catch {
    json(500, { error: "loopback failed" });
  }
});

let serverStarted = false;
let serverClosed = false;
let rootRemoved = false;
let registryRemoved = false;
let evidence: Record<string, unknown> = {};

try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverStarted = true;
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  config.hardLocks = [];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const unit = path.join(root, "EP01_15s_001_ComfyUI协议证据");
  await mkdir(unit, { recursive: true });
  await writeFile(path.join(unit, "00_信息.md"), "# ComfyUI 协议证据\n\n首帧提示词：电影写实黄金面具。\n尾帧提示词：保持角色连续。\n", "utf8");
  await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#5c422d" } }).png().toFile(path.join(unit, "EP01_15s_001_首帧_v1_raw.png"));
  await scanAndPersist(root);
  await seedProductionReady(root, "frames");

  const settings = await getGenerationSettings(root);
  await upsertGenerationProvider(root, {
    expectedRevision: settings.revision,
    setAsDefaultFor: "image",
    provider: {
      id: "comfyui-protocol-smoke",
      name: "ComfyUI 本机协议 Smoke",
      adapter: "comfyui-local",
      kinds: ["image"],
      enabled: true,
      endpoint,
      outputRoot: root,
      workflow: {
        schemaVersion: 1,
        name: "ComfyUI 协议 Smoke",
        version: "1",
        format: "comfyui-api",
        definition: {
          "6": { class_type: "CLIPTextEncode", inputs: { text: "materialized", clip: ["4", 1] } },
          "9": { class_type: "SaveImage", inputs: { filename_prefix: "AI_Canvas", images: ["8", 0] } },
        },
        comfyUi: { promptInputs: [{ nodeId: "6", inputName: "text" }], outputNodeId: "9", outputIndex: 0 },
      },
      capabilities: { referenceModes: ["text"], maxReferenceImages: 0, maxReferenceVideos: 0, supportedDurations: [], supportedAspectRatios: ["9:16"], supportedResolutions: ["720p"], models: [], maxConcurrency: 1, supportsCancel: true },
    },
  });

  const createJob = async (prompt: string): Promise<GenerationJob> => {
    const [created] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-protocol-smoke", prompt });
    assert(created, `未创建 smoke 任务：${prompt}`);
    return created;
  };

  const happy = await createJob("happy official tuple");
  await processGenerationQueue(root, { jobId: happy.id });
  let current = await jobById(happy.id);
  assert(current.status === "waiting_remote" && current.comfyUiCheckpoint?.stage === "queued", "happy 未进入 queued。 ");
  states.set(current.externalTaskId!, "success");
  await processGenerationQueue(root, { jobId: current.id });
  current = await jobById(current.id);
  assert(current.status === "succeeded" && current.comfyUiCheckpoint?.history?.eventName === "execution_success", "happy 未按 official history 成功。 ");
  assert((await readFile(current.expectedOutputPath)).equals(outputImage), "happy 输出与 loopback 原图不一致。 ");
  const happyResult = { jobId: current.id, status: current.status, promptId: current.externalTaskId, attempt: current.submissionIntent?.attempt, checkpointRevision: current.comfyUiCheckpoint?.revision, historySha256: current.comfyUiCheckpoint?.history?.historySha256, resultSha256: current.resultSha256, publicationReceiptId: current.publicationReceiptId };

  preflightMode = "503";
  const prepared = await createJob("prepared restart");
  await processGenerationQueue(root, { jobId: prepared.id });
  current = await jobById(prepared.id);
  assert(current.status === "submitting" && current.attempts === 1 && current.comfyUiCheckpoint?.stage === "prepared" && !current.comfyUiCheckpoint.postAttemptedAt, "503 preflight 未保持 prepared。 ");
  const preparedPromptId = current.comfyUiCheckpoint.promptId;
  const postsBeforePreparedRecovery = counts.post;
  preflightMode = "ok";
  await processFresh(current.id);
  current = await jobById(current.id);
  assert(current.status === "waiting_remote" && current.attempts === 1 && current.comfyUiCheckpoint?.promptId === preparedPromptId && counts.post === postsBeforePreparedRecovery + 1, "prepared fresh Node 恢复改变 attempt/promptId 或重复 POST。 ");
  const preparedPostDelta = counts.post - postsBeforePreparedRecovery;
  states.set(current.externalTaskId!, "success");
  await processGenerationQueue(root, { jobId: current.id });
  const preparedRecovered = await jobById(current.id);

  disconnectNext = true;
  const disconnected = await createJob("disconnect unknown recovery");
  const postsBeforeDisconnect = counts.post;
  await processGenerationQueue(root, { jobId: disconnected.id });
  current = await jobById(disconnected.id);
  assert(current.status === "submission_unknown" && current.comfyUiCheckpoint?.stage === "submission_unknown" && counts.post === postsBeforeDisconnect + 1, "断连没有进入 ComfyUI submission_unknown。 ");
  assert(getHttpGenerationSubmissionCheckpoint(current) === undefined, "ComfyUI unknown 被错误合成 HTTP checkpoint。 ");
  const disconnectedPromptId = current.comfyUiCheckpoint.promptId;
  hidden.delete(disconnectedPromptId);
  states.set(disconnectedPromptId, "success");
  await processFresh(current.id);
  const disconnectedRecovered = await jobById(current.id);
  assert(disconnectedRecovered.status === "succeeded" && counts.post === postsBeforeDisconnect + 1, "断连恢复重复 POST 或未成功。 ");
  const disconnectedPostCountAfterRecovery = counts.post;

  const failed = await createJob("error text mentions execution_interrupted");
  await processGenerationQueue(root, { jobId: failed.id });
  current = await jobById(failed.id);
  historyModes.set(current.externalTaskId!, "error_text_mentions_interrupt");
  states.set(current.externalTaskId!, "failed");
  await processGenerationQueue(root, { jobId: current.id });
  const failedTerminal = await jobById(current.id);
  const failedIntent = await getPublicationIntent(root, failedTerminal.publicationIntentId!);
  assert(failedTerminal.status === "failed" && failedTerminal.comfyUiCheckpoint?.history?.eventName === "execution_error" && failedIntent?.status === "failed", "错误文本被误判成取消或未闭合失败。 ");

  const pendingCancel = await createJob("pending atomic cancel");
  await processGenerationQueue(root, { jobId: pendingCancel.id });
  const pendingCancelled = await cancelGenerationJob(root, pendingCancel.id);
  assert(pendingCancelled.status === "cancelled" && pendingCancelled.comfyUiCheckpoint?.cancellation?.confirmation?.kind === "pending_deleted", "pending 原子取消未按稳定 absent 确认。 ");

  const runningCancel = await createJob("running exact interrupted");
  await processGenerationQueue(root, { jobId: runningCancel.id });
  current = await jobById(runningCancel.id);
  states.set(current.externalTaskId!, "running");
  delayedRunningCancel.add(current.externalTaskId!);
  let runningFirstError = "";
  try { await cancelGenerationJob(root, current.id); }
  catch (error) { runningFirstError = error instanceof Error ? error.message : String(error); }
  current = await jobById(current.id);
  assert(Boolean(runningFirstError) && current.status === "waiting_remote" && current.comfyUiCheckpoint?.stage === "cancel_requested", "running absent 被错误标记为本地 cancelled。 ");
  assert((await getPublicationIntent(root, current.publicationIntentId!))?.status === "reserved", "running 未确认时错误关闭 Publication。 ");
  states.set(current.externalTaskId!, "cancelled");
  const runningCancelled = await cancelGenerationJob(root, current.id);
  assert(runningCancelled.status === "cancelled" && runningCancelled.comfyUiCheckpoint?.history?.eventName === "execution_interrupted" && runningCancelled.comfyUiCheckpoint.cancellation?.confirmation?.kind === "history_interrupted", "running 未按 exact execution_interrupted 收敛。 ");

  const owned = await createJob("queue ownership conflict");
  await processGenerationQueue(root, { jobId: owned.id });
  current = await jobById(owned.id);
  const viewBeforeConflict = counts.view;
  submissions.get(current.externalTaskId!)!.extra_data.aicanvas.attempt = 99;
  await processGenerationQueue(root, { jobId: current.id });
  const ownershipLocked = await jobById(current.id);
  assert(ownershipLocked.status === "waiting_remote" && ownershipLocked.remoteObservation?.nextAction === "inspect_remote_task" && counts.view === viewBeforeConflict, "queue 所有权漂移仍触发下载或终态。 ");
  assert((await getPublicationIntent(root, ownershipLocked.publicationIntentId!))?.status === "reserved", "queue 所有权漂移错误关闭 Publication。 ");

  const doctor = await doctorProject(root);
  const capabilities = await getCapabilities(root);
  const snapshot = await getProjectSnapshot(root);
  const publications = await listPublicationIntents(root);
  const receipts = await listPublicationReceipts(root);
  const locks = await listProjectLocks(root);
  const media = await readMachineMediaRuntimeSnapshot();
  const generationCheck = doctor.checks.find((check) => check.id === "generation-jobs");
  assert(capabilities.generationAdapterContracts.comfyUiLocal.cancellation.endpoint === "atomic-api-jobs-cancel", "Capabilities 未声明原子 jobs cancel。 ");
  assert(counts.legacyQueueCancel === 0 && counts.legacyInterrupt === 0, "smoke 调用了 legacy queue/interrupt。 ");
  assert(!JSON.stringify(snapshot).includes("httpSubmissionCheckpoint\":{\"revision"), "快照把 ComfyUI unknown 投影成 HTTP checkpoint。 ");

  const outputStat = await stat(happyResult.publicationReceiptId ? (await jobById(happy.id)).expectedOutputPath : "");
  evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    success: true,
    workspace: process.cwd(),
    protocol: {
      origin: endpoint,
      loopbackOnly: true,
      officialPromptTupleValidated: true,
      extraDataOwnershipTagValidated: true,
      exactTerminalEvents: true,
      historySha256Locked: true,
      atomicCancelEndpoint: "/api/jobs/{promptId}/cancel",
      legacyCancellationCalls: { queue: counts.legacyQueueCancel, interrupt: counts.legacyInterrupt },
    },
    scenarios: {
      happy: { ...happyResult, outputBytes: outputStat.size, outputSha256: sha256(await readFile((await jobById(happy.id)).expectedOutputPath)) },
      preparedFreshNode: { jobId: preparedRecovered.id, status: preparedRecovered.status, attempts: preparedRecovered.attempts, promptIdStable: preparedRecovered.comfyUiCheckpoint?.promptId === preparedPromptId, postDelta: preparedPostDelta },
      disconnectedFreshNode: { jobId: disconnectedRecovered.id, status: disconnectedRecovered.status, promptId: disconnectedPromptId, httpCheckpointAbsent: getHttpGenerationSubmissionCheckpoint(disconnectedRecovered) === undefined, postCountBefore: postsBeforeDisconnect, postCountAfterRecovery: disconnectedPostCountAfterRecovery, noReplay: disconnectedPostCountAfterRecovery === postsBeforeDisconnect + 1 },
      exactFailure: { jobId: failedTerminal.id, status: failedTerminal.status, eventName: failedTerminal.comfyUiCheckpoint?.history?.eventName, checkpointRevision: failedTerminal.comfyUiCheckpoint?.revision, publicationStatus: failedIntent?.status, provenance: failedIntent?.terminal?.provenance },
      pendingCancel: { jobId: pendingCancelled.id, status: pendingCancelled.status, cancellation: pendingCancelled.comfyUiCheckpoint?.cancellation },
      runningCancel: { jobId: runningCancelled.id, firstAttemptStayedLocked: Boolean(runningFirstError), status: runningCancelled.status, cancellation: runningCancelled.comfyUiCheckpoint?.cancellation },
      ownershipConflict: { jobId: ownershipLocked.id, status: ownershipLocked.status, nextAction: ownershipLocked.remoteObservation?.nextAction, viewCountUnchanged: counts.view === viewBeforeConflict, publicationStatus: (await getPublicationIntent(root, ownershipLocked.publicationIntentId!))?.status },
    },
    counts,
    capabilities: capabilities.generationAdapterContracts.comfyUiLocal,
    doctor: { generationCheck, suggestedNextCalls: doctor.suggestedNextCalls },
    snapshot: { generationJobs: snapshot.generationJobs.length, activeJobIds: snapshot.runtimeResources.generation.activeJobIds },
    publication: { reserved: publications.filter((intent) => intent.status === "reserved").length, registered: publications.filter((intent) => intent.status === "registered").length, cancelled: publications.filter((intent) => intent.status === "cancelled").length, failed: publications.filter((intent) => intent.status === "failed").length, receipts: receipts.length },
    terminal: { projectLocks: locks, machineActiveWeight: media.activeWeight, machineQueueDepth: media.queueDepth },
    cleanup: { projectRoot: root, registryPath, rootRemoved: false, registryRemoved: false, serverClosed: false },
    boundaries: { realComfyUiCalled: false, externalProviderCalled: false, websiteOpened: false, uploadPerformed: false, paidActionPerformed: false, signedDmgTouched: false },
  };
} finally {
  if (serverStarted) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    serverClosed = true;
  }
  await rm(root, { recursive: true, force: true });
  rootRemoved = !(await exists(root));
  registryRemoved = !(await exists(registryPath));
}

evidence.cleanup = { ...(evidence.cleanup as Record<string, unknown> | undefined), rootRemoved, registryRemoved, serverClosed };
await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ evidencePath, success: evidence.success, counts: evidence.counts, cleanup: evidence.cleanup }, null, 2)}\n`);
