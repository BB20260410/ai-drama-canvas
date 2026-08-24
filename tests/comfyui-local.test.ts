import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { cancelGenerationJob, enqueueGeneration, getGenerationSettings, getHttpGenerationSubmissionCheckpoint, listGenerationJobs, processGenerationQueue, upsertGenerationProvider } from "../src/core/generation.js";
import { doctorProject, getProjectSnapshot } from "../src/core/codex.js";
import { getContinuationSnapshot } from "../src/core/memory.js";
import { getPublicationIntent, registerPublication } from "../src/core/publication.js";
import { scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import { seedProductionReady } from "./workflow-helpers.js";
import { toJsLiteral } from "../src/core/js-code-literal.js";

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-comfyui-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  config.hardLocks = [];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const directory = path.join(root, "EP01_15s_001_ComfyUI测试");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "00_信息.md"), "# ComfyUI 测试\n\n首帧提示词：青铜树下的人物。\n尾帧提示词：人物回头。\n", "utf8");
  await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#5b3f2a" } }).png().toFile(path.join(directory, "EP01_15s_001_首帧_v1_raw.png"));
  await scanAndPersist(root);
  await seedProductionReady(root, "frames");
  return root;
}

function workflow(outputNodeId = "9", outputIndex = 0) {
  return {
    schemaVersion: 1 as const,
    name: "ComfyUI 本机图片工作流",
    version: "1",
    format: "comfyui-api" as const,
    definition: {
      "6": { class_type: "CLIPTextEncode", inputs: { text: "将由任务提示词替换", clip: ["4", 1] } },
      "9": { class_type: "SaveImage", inputs: { filename_prefix: "AI_Canvas", images: ["8", 0] } },
    },
    comfyUi: {
      promptInputs: [{ nodeId: "6", inputName: "text" }],
      outputNodeId,
      outputIndex,
    },
  };
}

function provider(root: string, endpoint: string, override: Record<string, unknown> = {}) {
  return {
    id: "comfyui-loopback",
    name: "ComfyUI 本机",
    adapter: "comfyui-local",
    kinds: ["image"],
    enabled: true,
    endpoint,
    workflow: workflow(),
    outputRoot: root,
    capabilities: {
      referenceModes: ["text"],
      maxReferenceImages: 0,
      maxReferenceVideos: 0,
      supportedDurations: [],
      supportedAspectRatios: ["9:16"],
      supportedResolutions: ["720p"],
      models: [],
      maxConcurrency: 1,
      supportsCancel: true,
    },
    ...override,
  };
}

async function saveProvider(root: string, endpoint: string, override: Record<string, unknown> = {}) {
  const settings = await getGenerationSettings(root);
  return upsertGenerationProvider(root, {
    expectedRevision: settings.revision,
    setAsDefaultFor: "image",
    provider: provider(root, endpoint, override) as never,
  });
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

type PromptState = "pending" | "running" | "success" | "failed" | "cancelled";
type PreflightMode = "ok" | "503" | "bad_json" | "missing_node" | "incompatible_404";
type HistoryEventMode = "normal" | "error_text_mentions_interrupt" | "wrong_prompt" | "mixed";

async function protocolServer(options: { disconnectSubmit?: boolean; hideAfterDisconnect?: boolean; interruptStatus?: number; atomicCancelResult?: boolean; outputType?: string; outputNodeId?: string; filename?: string; subfolder?: string; preflightMode?: PreflightMode; viewStatus?: number; delayRunningCancelHistory?: boolean } = {}) {
  const image = await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#765238" } }).png().toBuffer();
  const states = new Map<string, PromptState>();
  const submitted: Array<{ prompt_id: string; client_id: string; prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>; extra_data: { aicanvas: Record<string, unknown> } }> = [];
  let postCount = 0;
  let queueDeleteCount = 0;
  let interruptCount = 0;
  let atomicCancelCount = 0;
  let viewCount = 0;
  let hide = Boolean(options.hideAfterDisconnect);
  let preflightMode: PreflightMode = options.preflightMode ?? "ok";
  let viewStatus = options.viewStatus ?? 200;
  let historyRevision = 0;
  let historyEventMode: HistoryEventMode = "normal";
  let historyOverride: { promptId?: string; clientId?: string; prompt?: Record<string, unknown>; tag?: Record<string, unknown>; outputsToExecute?: string[] } = {};
  let delayRunningCancelHistory = Boolean(options.delayRunningCancelHistory);
  let beforeCancel: ((promptId: string) => Promise<void>) | undefined;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && url.pathname === "/system_stats") {
      if (preflightMode === "503") return json(503, { error: "temporarily unavailable" });
      if (preflightMode === "bad_json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{bad json");
        return;
      }
      return json(200, { system: { comfyui_version: "0.test", os: "loopback" }, devices: [] });
    }
    if (request.method === "GET" && url.pathname === "/features") return json(200, { supports_preview_metadata: true });
    if (request.method === "GET" && url.pathname.startsWith("/object_info/")) {
      if (preflightMode === "missing_node") return json(200, {});
      if (preflightMode === "incompatible_404") return json(404, { error: "node not installed" });
      return json(200, { [decodeURIComponent(url.pathname.slice("/object_info/".length))]: { input: { required: {} }, output: [] } });
    }
    if (request.method === "POST" && url.pathname === "/prompt") {
      const payload = await body(request) as { prompt_id: string; client_id: string; prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>; extra_data: { aicanvas: Record<string, unknown> } };
      postCount += 1;
      submitted.push(payload);
      states.set(payload.prompt_id, "pending");
      if (options.disconnectSubmit) {
        request.socket.destroy();
        return;
      }
      return json(200, { prompt_id: payload.prompt_id, number: postCount, node_errors: {} });
    }
    if (request.method === "GET" && url.pathname === "/queue") {
      const tuple = (id: string, number: number) => {
        const submittedPrompt = submitted.find((candidate) => candidate.prompt_id === id)!;
        return [number, id, submittedPrompt.prompt, { client_id: submittedPrompt.client_id, aicanvas: submittedPrompt.extra_data.aicanvas }, ["9"]];
      };
      const running = hide ? [] : [...states].filter(([, state]) => state === "running").map(([id]) => tuple(id, 1));
      const pending = hide ? [] : [...states].filter(([, state]) => state === "pending").map(([id]) => tuple(id, 2));
      return json(200, { queue_running: running, queue_pending: pending });
    }
    if (request.method === "GET" && url.pathname.startsWith("/history/")) {
      const id = decodeURIComponent(url.pathname.slice("/history/".length));
      const state = states.get(id);
      if (hide || !state || state === "pending" || state === "running") return json(200, {});
      const submittedPrompt = submitted.find((candidate) => candidate.prompt_id === id)!;
      const promptTuple = [
        1,
        historyOverride.promptId ?? id,
        historyOverride.prompt ?? submittedPrompt.prompt,
        { client_id: historyOverride.clientId ?? submittedPrompt.client_id, aicanvas: { ...submittedPrompt.extra_data.aicanvas, ...historyOverride.tag } },
        historyOverride.outputsToExecute ?? ["9"],
      ];
      if (state === "failed") {
        const errorPayload = { prompt_id: historyEventMode === "wrong_prompt" ? "00000000-0000-4000-8000-000000000000" : id, exception_message: historyEventMode === "error_text_mentions_interrupt" ? "ordinary node failure text mentions execution_interrupted but is not that event" : "loopback node failed" };
        const messages = historyEventMode === "mixed" ? [["execution_error", errorPayload], ["execution_interrupted", { prompt_id: id }]] : [["execution_error", errorPayload]];
        return json(200, { [id]: { prompt: promptTuple, status: { status_str: "error", completed: false, messages }, outputs: {}, meta: { historyRevision } } });
      }
      if (state === "cancelled") return json(200, { [id]: { prompt: promptTuple, status: { status_str: "error", completed: false, messages: [["execution_interrupted", { prompt_id: id }]] }, outputs: {} } });
      const nodeId = options.outputNodeId ?? "9";
      return json(200, { [id]: { prompt: promptTuple, status: { status_str: "success", completed: true, messages: [["execution_success", { prompt_id: id }]] }, outputs: { [nodeId]: { images: [{ filename: options.filename ?? "result.png", subfolder: options.subfolder ?? "AI_Canvas", type: options.outputType ?? "output" }] } }, meta: { historyRevision } } });
    }
    if (request.method === "GET" && url.pathname === "/view") {
      viewCount += 1;
      if (viewStatus !== 200) return json(viewStatus, { error: "view unavailable" });
      response.writeHead(200, { "content-type": "image/png", "content-length": image.length });
      response.end(image);
      return;
    }
    if (request.method === "POST" && url.pathname === "/queue") {
      const payload = await body(request) as { delete?: string[] };
      queueDeleteCount += 1;
      if (payload.delete?.[0] && beforeCancel) await beforeCancel(payload.delete[0]);
      for (const id of payload.delete ?? []) if (states.get(id) === "pending") states.set(id, "cancelled");
      return json(200, {});
    }
    if (request.method === "POST" && url.pathname === "/interrupt") {
      interruptCount += 1;
      return json(410, { error: "legacy interrupt forbidden" });
    }
    const atomicCancel = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && atomicCancel) {
      const id = decodeURIComponent(atomicCancel[1]!);
      atomicCancelCount += 1;
      if (options.interruptStatus && options.interruptStatus !== 200) return json(options.interruptStatus, { error: "atomic cancel unavailable" });
      if (beforeCancel) await beforeCancel(id);
      const current = states.get(id);
      const cancelled = options.atomicCancelResult ?? (current === "pending" || current === "running");
      if (cancelled && current === "pending") states.delete(id);
      else if (cancelled && current === "running") {
        if (delayRunningCancelHistory) states.delete(id);
        else states.set(id, "cancelled");
      }
      return json(200, { cancelled });
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoint,
    image,
    states,
    submitted,
    counts: () => ({ postCount, queueDeleteCount, interruptCount, atomicCancelCount, viewCount }),
    reveal: () => { hide = false; },
    setBeforeCancel: (hook: ((promptId: string) => Promise<void>) | undefined) => { beforeCancel = hook; },
    setPreflightMode: (mode: PreflightMode) => { preflightMode = mode; },
    setViewStatus: (status: number) => { viewStatus = status; },
    setHistoryRevision: (revision: number) => { historyRevision = revision; },
    setHistoryEventMode: (mode: HistoryEventMode) => { historyEventMode = mode; },
    setHistoryOverride: (override: typeof historyOverride) => { historyOverride = override; },
    setDelayRunningCancelHistory: (value: boolean) => { delayRunningCancelHistory = value; },
  };
}

describe("comfyui-local 专用可恢复适配", () => {
  it("只接受 loopback、图片、API-format 和显式 prompt/output 绑定", async () => {
    const root = await fixture();
    await expect(saveProvider(root, "https://example.com")).rejects.toThrow(/loopback|本机|回环/i);
    await expect(saveProvider(root, "http://0.0.0.0:8188")).rejects.toThrow(/loopback|本机|回环/i);
    await expect(saveProvider(root, "http://127.0.0.1:8188?token=secret")).rejects.toThrow(/query|fragment|凭据/i);
    await expect(saveProvider(root, "http://127.0.0.1:8188", { kinds: ["video"] })).rejects.toThrow(/图片|image/i);
    await expect(saveProvider(root, "http://127.0.0.1:8188", { workflow: { ...workflow(), comfyUi: undefined } })).rejects.toThrow(/绑定|comfy/i);
    await expect(saveProvider(root, "http://127.0.0.1:8188", { workflow: workflow("missing") })).rejects.toThrow(/输出节点|missing/i);
    const saved = await saveProvider(root, "http://127.0.0.1:8188/");
    expect(saved.providers.find((candidate) => candidate.id === "comfyui-loopback")).toMatchObject({ adapter: "comfyui-local", kinds: ["image"], endpoint: "http://127.0.0.1:8188" });
  });

  it("冻结 promptId/clientId 与物化工作流，并按 history 输出身份隔离发布", async () => {
    const root = await fixture();
    const loopback = await protocolServer();
    await saveProvider(root, loopback.endpoint);
    const [created] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback", prompt: "电影写实，完整黄金面具，不得换脸。" });
    await processGenerationQueue(root, { jobId: created!.id });
    let job = (await listGenerationJobs(root)).find((candidate) => candidate.id === created!.id)!;
    expect(job).toMatchObject({ status: "waiting_remote", externalTaskId: expect.any(String), comfyUiCheckpoint: { stage: "queued", clientId: created!.id, promptId: expect.any(String), outputNodeId: "9", outputIndex: 0 } });
    expect(loopback.counts().postCount).toBe(1);
    expect(loopback.submitted[0]?.prompt_id).toBe(job.comfyUiCheckpoint?.promptId);
    expect(loopback.submitted[0]?.client_id).toBe(created!.id);
    expect(loopback.submitted[0]?.prompt["6"]?.inputs.text).toBe("电影写实，完整黄金面具，不得换脸。");
    expect(loopback.submitted[0]?.extra_data.aicanvas).toMatchObject({ generationJobId: created!.id, clientJobId: created!.id, attempt: 1, submittedWorkflowHash: job.comfyUiCheckpoint?.submittedWorkflowHash, outputNodeId: "9", outputIndex: 0 });
    const request = JSON.parse(await readFile(job.requestPath!, "utf8")) as { promptId: string; submittedWorkflowHash: string; prompt: Record<string, unknown> };
    expect(request).toMatchObject({ promptId: job.externalTaskId, submittedWorkflowHash: job.comfyUiCheckpoint?.submittedWorkflowHash, prompt: expect.any(Object) });

    loopback.states.set(job.externalTaskId!, "success");
    await processGenerationQueue(root, { jobId: job.id });
    job = (await listGenerationJobs(root)).find((candidate) => candidate.id === job.id)!;
    expect(job).toMatchObject({ status: "succeeded", resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/), comfyUiCheckpoint: { stage: "verified", history: { generationJobId: created!.id, clientId: created!.id, attempt: 1, eventName: "execution_success", outputNodeId: "9", outputIndex: 0 }, output: { promptId: job.externalTaskId, nodeId: "9", index: 0, filename: "result.png", subfolder: "AI_Canvas", type: "output", historySha256: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    expect(await readFile(job.expectedOutputPath)).toEqual(loopback.image);
    expect(job.expectedCompanionPath).toBeTruthy();
    expect((await getPublicationIntent(root, job.publicationIntentId!))?.status).toBe("registered");
    expect(loopback.counts().postCount).toBe(1);
  });

  it("POST 已接收但回执断连后只查同一 promptId，fresh Node 恢复且绝不重 POST", async () => {
    const root = await fixture();
    const loopback = await protocolServer({ disconnectSubmit: true, hideAfterDisconnect: true });
    await saveProvider(root, loopback.endpoint);
    const [created] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
    await processGenerationQueue(root, { jobId: created!.id });
    let job = (await listGenerationJobs(root)).find((candidate) => candidate.id === created!.id)!;
    expect(job).toMatchObject({ status: "submission_unknown", comfyUiCheckpoint: { stage: "submission_unknown", promptId: expect.any(String) } });
    expect(job.externalTaskId).toBeUndefined();
    expect(getHttpGenerationSubmissionCheckpoint(job)).toBeUndefined();
    expect(loopback.counts().postCount).toBe(1);
    const doctor = await doctorProject(root);
    expect(doctor.checks.find((check) => check.id === "generation-jobs")).toMatchObject({ level: "warning", detail: expect.stringContaining("ComfyUI 1"), suggestedAction: expect.stringContaining("process_generation_queue") });
    expect(doctor.suggestedNextCalls).toEqual(["list_generation_jobs", "process_generation_queue", "doctor_project"]);
    const snapshot = await getProjectSnapshot(root);
    const snapshotJob = snapshot.generationJobs.find((candidate) => candidate.id === job.id)!;
    expect(snapshotJob).toMatchObject({ status: "submission_unknown", comfyUiCheckpoint: { stage: "submission_unknown", promptId: job.comfyUiCheckpoint!.promptId } });
    expect(snapshotJob.httpSubmissionCheckpoint).toBeUndefined();
    expect(snapshot.suggestedNextCalls).toEqual(["list_generation_jobs", "process_generation_queue", "doctor_project"]);
    const continuation = await getContinuationSnapshot(root);
    expect(continuation.generationRecovery[0]).toMatchObject({ jobId: job.id, comfyUiCheckpoint: { promptId: job.comfyUiCheckpoint!.promptId } });
    expect(continuation.prompt).toContain("只按已保存 promptId 查询 history/queue");
    loopback.reveal();
    loopback.states.set(job.comfyUiCheckpoint!.promptId, "success");
    const moduleUrl = new URL("../src/core/generation.ts", import.meta.url).href;
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { processGenerationQueue } from ${toJsLiteral(moduleUrl)}; await processGenerationQueue(${toJsLiteral(root)}, { jobId: ${toJsLiteral(job.id)} });`]);
    job = (await listGenerationJobs(root)).find((candidate) => candidate.id === job.id)!;
    expect(job.status).toBe("succeeded");
    expect(loopback.counts().postCount).toBe(1);
  });

  it("prepared/no-post 与暂态 preflight 复用同一 attempt，恢复后只 POST 一次", async () => {
    const root = await fixture();
    const loopback = await protocolServer({ preflightMode: "503" });
    await saveProvider(root, loopback.endpoint);
    const [created] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
    await processGenerationQueue(root, { jobId: created!.id });
    let job = (await listGenerationJobs(root)).find((candidate) => candidate.id === created!.id)!;
    const preparedIdentity = { promptId: job.comfyUiCheckpoint?.promptId, submittedWorkflowHash: job.comfyUiCheckpoint?.submittedWorkflowHash, requestPath: job.comfyUiCheckpoint?.requestPath };
    expect(job).toMatchObject({ status: "submitting", attempts: 1, submissionIntent: { attempt: 1 }, comfyUiCheckpoint: { stage: "prepared" }, remoteObservation: { state: "retryable_or_unknown", nextAction: "retry_same_task" } });
    expect(job.comfyUiCheckpoint?.postAttemptedAt).toBeUndefined();
    expect((await getPublicationIntent(root, job.publicationIntentId!))?.status).toBe("reserved");
    expect(loopback.counts().postCount).toBe(0);

    loopback.setPreflightMode("bad_json");
    await processGenerationQueue(root, { jobId: job.id });
    job = (await listGenerationJobs(root)).find((candidate) => candidate.id === job.id)!;
    expect(job).toMatchObject({ status: "submitting", attempts: 1, submissionIntent: { attempt: 1 }, comfyUiCheckpoint: { stage: "prepared", ...preparedIdentity } });
    expect(loopback.counts().postCount).toBe(0);

    loopback.setPreflightMode("ok");
    const moduleUrl = new URL("../src/core/generation.ts", import.meta.url).href;
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { processGenerationQueue } from ${toJsLiteral(moduleUrl)}; await processGenerationQueue(${toJsLiteral(root)}, { jobId: ${toJsLiteral(job.id)} });`]);
    job = (await listGenerationJobs(root)).find((candidate) => candidate.id === job.id)!;
    expect(job).toMatchObject({ status: "waiting_remote", attempts: 1, submissionIntent: { attempt: 1 }, comfyUiCheckpoint: { stage: "queued", ...preparedIdentity } });
    expect(loopback.counts().postCount).toBe(1);
  });

  it("明确缺少节点或不兼容 4xx 在 POST 前确定性失败", async () => {
    for (const preflightMode of ["missing_node", "incompatible_404"] as const) {
      const root = await fixture();
      const loopback = await protocolServer({ preflightMode });
      await saveProvider(root, loopback.endpoint);
      const [created] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
      await processGenerationQueue(root, { jobId: created!.id });
      const job = (await listGenerationJobs(root)).find((candidate) => candidate.id === created!.id)!;
      expect(job.status).toBe("failed");
      expect(loopback.counts().postCount).toBe(0);
      expect((await getPublicationIntent(root, job.publicationIntentId!))?.status).toBe("failed");
    }
  });

  it("history 必须匹配官方 tuple 所有权，且同 descriptor 的 history 漂移也保持锁定", async () => {
    const ownerRoot = await fixture();
    const ownerServer = await protocolServer();
    await saveProvider(ownerRoot, ownerServer.endpoint);
    const [ownerCreated] = await enqueueGeneration(ownerRoot, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
    await processGenerationQueue(ownerRoot, { jobId: ownerCreated!.id });
    let ownerJob = (await listGenerationJobs(ownerRoot)).find((candidate) => candidate.id === ownerCreated!.id)!;
    ownerServer.states.set(ownerJob.externalTaskId!, "success");
    ownerServer.setHistoryOverride({ clientId: "other-client" });
    await processGenerationQueue(ownerRoot, { jobId: ownerJob.id });
    ownerJob = (await listGenerationJobs(ownerRoot)).find((candidate) => candidate.id === ownerJob.id)!;
    expect(ownerJob).toMatchObject({ status: "waiting_remote", remoteObservation: { state: "retryable_or_unknown", nextAction: "inspect_remote_task" } });
    expect(ownerJob.error).toMatch(/所有权|client/i);
    expect(ownerServer.counts().viewCount).toBe(0);
    expect((await getPublicationIntent(ownerRoot, ownerJob.publicationIntentId!))?.status).toBe("reserved");

    const driftRoot = await fixture();
    const driftServer = await protocolServer({ viewStatus: 503 });
    await saveProvider(driftRoot, driftServer.endpoint);
    const [driftCreated] = await enqueueGeneration(driftRoot, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
    await processGenerationQueue(driftRoot, { jobId: driftCreated!.id });
    let driftJob = (await listGenerationJobs(driftRoot)).find((candidate) => candidate.id === driftCreated!.id)!;
    driftServer.states.set(driftJob.externalTaskId!, "success");
    await processGenerationQueue(driftRoot, { jobId: driftJob.id });
    driftJob = (await listGenerationJobs(driftRoot)).find((candidate) => candidate.id === driftJob.id)!;
    expect(driftJob.comfyUiCheckpoint).toMatchObject({ stage: "downloading", history: { eventName: "execution_success" }, output: { historySha256: expect.any(String) } });
    expect(driftServer.counts().viewCount).toBe(1);
    driftServer.setHistoryRevision(1);
    driftServer.setViewStatus(200);
    await processGenerationQueue(driftRoot, { jobId: driftJob.id });
    driftJob = (await listGenerationJobs(driftRoot)).find((candidate) => candidate.id === driftJob.id)!;
    expect(driftJob.status).toBe("waiting_remote");
    expect(driftJob.error).toMatch(/history.*漂移|history.*变化/i);
    expect(driftServer.counts().viewCount).toBe(1);
    expect((await getPublicationIntent(driftRoot, driftJob.publicationIntentId!))?.status).toBe("reserved");
  });

  it("只按 exact terminal event 分类，错误文本提及 interrupt 仍是失败", async () => {
    const root = await fixture();
    const loopback = await protocolServer();
    await saveProvider(root, loopback.endpoint);
    const [created] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
    await processGenerationQueue(root, { jobId: created!.id });
    let job = (await listGenerationJobs(root)).find((candidate) => candidate.id === created!.id)!;
    loopback.states.set(job.externalTaskId!, "failed");
    loopback.setHistoryEventMode("error_text_mentions_interrupt");
    await processGenerationQueue(root, { jobId: job.id });
    job = (await listGenerationJobs(root)).find((candidate) => candidate.id === job.id)!;
    expect(job).toMatchObject({ status: "failed", comfyUiCheckpoint: { stage: "history_failed", history: { eventName: "execution_error" } } });
    expect((await getPublicationIntent(root, job.publicationIntentId!))?.status).toBe("failed");
  });

  it("queue 所有权漂移与矛盾 history 事件都不触碰输出或 Publication", async () => {
    const queueRoot = await fixture();
    const queueServer = await protocolServer();
    await saveProvider(queueRoot, queueServer.endpoint);
    const [queueCreated] = await enqueueGeneration(queueRoot, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
    await processGenerationQueue(queueRoot, { jobId: queueCreated!.id });
    let queueJob = (await listGenerationJobs(queueRoot)).find((candidate) => candidate.id === queueCreated!.id)!;
    queueServer.submitted[0]!.extra_data.aicanvas.attempt = 99;
    await processGenerationQueue(queueRoot, { jobId: queueJob.id });
    queueJob = (await listGenerationJobs(queueRoot)).find((candidate) => candidate.id === queueJob.id)!;
    expect(queueJob.status).toBe("waiting_remote");
    expect(queueJob.error).toMatch(/所有权标签|attempt/i);
    expect(queueServer.counts().viewCount).toBe(0);
    expect((await getPublicationIntent(queueRoot, queueJob.publicationIntentId!))?.status).toBe("reserved");

    const mixedRoot = await fixture();
    const mixedServer = await protocolServer();
    await saveProvider(mixedRoot, mixedServer.endpoint);
    const [mixedCreated] = await enqueueGeneration(mixedRoot, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
    await processGenerationQueue(mixedRoot, { jobId: mixedCreated!.id });
    let mixedJob = (await listGenerationJobs(mixedRoot)).find((candidate) => candidate.id === mixedCreated!.id)!;
    mixedServer.states.set(mixedJob.externalTaskId!, "failed");
    mixedServer.setHistoryEventMode("mixed");
    await processGenerationQueue(mixedRoot, { jobId: mixedJob.id });
    mixedJob = (await listGenerationJobs(mixedRoot)).find((candidate) => candidate.id === mixedJob.id)!;
    expect(mixedJob.status).toBe("waiting_remote");
    expect(mixedJob.error).toMatch(/矛盾|终态事件/i);
    expect(mixedServer.counts().viewCount).toBe(0);
    expect((await getPublicationIntent(mixedRoot, mixedJob.publicationIntentId!))?.status).toBe("reserved");
  });

  it("history 明确失败会闭合 Publication；错误输出节点或非 output 文件保持锁定", async () => {
    const failedRoot = await fixture();
    const failedServer = await protocolServer();
    await saveProvider(failedRoot, failedServer.endpoint);
    const [failedCreated] = await enqueueGeneration(failedRoot, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
    await processGenerationQueue(failedRoot, { jobId: failedCreated!.id });
    let failedJob = (await listGenerationJobs(failedRoot)).find((candidate) => candidate.id === failedCreated!.id)!;
    failedServer.states.set(failedJob.externalTaskId!, "failed");
    await processGenerationQueue(failedRoot, { jobId: failedJob.id });
    failedJob = (await listGenerationJobs(failedRoot)).find((candidate) => candidate.id === failedJob.id)!;
    expect(failedJob).toMatchObject({ status: "failed", remoteObservation: { state: "confirmed_failed", stage: "poll" }, comfyUiCheckpoint: { stage: "history_failed" } });
    const failedIntent = await getPublicationIntent(failedRoot, failedJob.publicationIntentId!);
    expect(failedIntent).toMatchObject({ status: "failed", terminal: { provenance: { cause: "remote_confirmed_failed", externalTaskId: failedJob.externalTaskId, checkpointRevision: failedJob.comfyUiCheckpoint?.revision, comfyUi: { promptId: failedJob.externalTaskId, historySha256: failedJob.comfyUiCheckpoint?.history?.historySha256, eventName: "execution_error" } } } });
    const tamperedJobs = await listGenerationJobs(failedRoot);
    const tampered = tamperedJobs.find((candidate) => candidate.id === failedJob.id)!;
    tampered.status = "waiting_remote";
    tampered.comfyUiCheckpoint = { ...tampered.comfyUiCheckpoint!, revision: tampered.comfyUiCheckpoint!.revision + 1 };
    await writeJsonAtomic(getSidecarPaths(failedRoot).generationJobs, tamperedJobs);
    await processGenerationQueue(failedRoot, { jobId: tampered.id });
    expect((await listGenerationJobs(failedRoot)).find((candidate) => candidate.id === tampered.id)).toMatchObject({ status: "waiting_remote", remoteObservation: { nextAction: "inspect_publication" }, error: expect.stringContaining("结构化终态来源") });

    const lockedRoot = await fixture();
    const lockedServer = await protocolServer({ outputType: "temp" });
    await saveProvider(lockedRoot, lockedServer.endpoint);
    const [lockedCreated] = await enqueueGeneration(lockedRoot, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
    await processGenerationQueue(lockedRoot, { jobId: lockedCreated!.id });
    let lockedJob = (await listGenerationJobs(lockedRoot)).find((candidate) => candidate.id === lockedCreated!.id)!;
    lockedServer.states.set(lockedJob.externalTaskId!, "success");
    await processGenerationQueue(lockedRoot, { jobId: lockedJob.id });
    lockedJob = (await listGenerationJobs(lockedRoot)).find((candidate) => candidate.id === lockedJob.id)!;
    expect(lockedJob).toMatchObject({ status: "waiting_remote", remoteObservation: { state: "retryable_or_unknown", stage: "validation", nextAction: "inspect_remote_task" } });
    expect(lockedJob.error).toMatch(/output|temp|输出身份/i);
    expect((await getPublicationIntent(lockedRoot, lockedJob.publicationIntentId!))?.status).toBe("reserved");

    const missingNodeRoot = await fixture();
    const missingNodeServer = await protocolServer({ outputNodeId: "other", subfolder: "../escape" });
    await saveProvider(missingNodeRoot, missingNodeServer.endpoint);
    const [missingNodeCreated] = await enqueueGeneration(missingNodeRoot, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
    await processGenerationQueue(missingNodeRoot, { jobId: missingNodeCreated!.id });
    let missingNodeJob = (await listGenerationJobs(missingNodeRoot)).find((candidate) => candidate.id === missingNodeCreated!.id)!;
    missingNodeServer.states.set(missingNodeJob.externalTaskId!, "success");
    await processGenerationQueue(missingNodeRoot, { jobId: missingNodeJob.id });
    missingNodeJob = (await listGenerationJobs(missingNodeRoot)).find((candidate) => candidate.id === missingNodeJob.id)!;
    expect(missingNodeJob).toMatchObject({ status: "waiting_remote", remoteObservation: { stage: "validation", nextAction: "inspect_remote_task" } });
    expect(missingNodeJob.error).toContain("输出节点 9");
    expect((await getPublicationIntent(missingNodeRoot, missingNodeJob.publicationIntentId!))?.status).toBe("reserved");
  });

  it("pending/running 只使用原子 jobs cancel，未确认取消保持锁定", async () => {
    const root = await fixture();
    const loopback = await protocolServer();
    await saveProvider(root, loopback.endpoint);
    const [pendingCreated] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
    await processGenerationQueue(root, { jobId: pendingCreated!.id });
    const pending = (await listGenerationJobs(root)).find((candidate) => candidate.id === pendingCreated!.id)!;
    expect((await cancelGenerationJob(root, pending.id)).status).toBe("cancelled");
    expect(loopback.counts()).toMatchObject({ atomicCancelCount: 1, queueDeleteCount: 0, interruptCount: 0 });
    const pendingStored = (await listGenerationJobs(root)).find((candidate) => candidate.id === pending.id)!;
    expect(await getPublicationIntent(root, pending.publicationIntentId!)).toMatchObject({ status: "cancelled", terminal: { provenance: { comfyUi: { confirmationKind: "pending_deleted", cancellationResponseSha256: pendingStored.comfyUiCheckpoint?.cancellation?.responseSha256 } } } });

    const [runningCreated] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
    await processGenerationQueue(root, { jobId: runningCreated!.id });
    const running = (await listGenerationJobs(root)).find((candidate) => candidate.id === runningCreated!.id)!;
    loopback.states.set(running.externalTaskId!, "running");
    expect((await cancelGenerationJob(root, running.id)).status).toBe("cancelled");
    expect(loopback.counts()).toMatchObject({ atomicCancelCount: 2, queueDeleteCount: 0, interruptCount: 0 });

    const [raceCreated] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
    await processGenerationQueue(root, { jobId: raceCreated!.id });
    const race = (await listGenerationJobs(root)).find((candidate) => candidate.id === raceCreated!.id)!;
    loopback.setBeforeCancel(async () => {
      loopback.setBeforeCancel(undefined);
      await writeFile(race.expectedOutputPath, loopback.image);
      const intent = (await getPublicationIntent(root, race.publicationIntentId!))!;
      await registerPublication(root, { intentId: intent.id, reservationToken: race.publicationReservationToken!, expectedRevision: intent.revision }, "scanner");
    });
    const raceWinner = await cancelGenerationJob(root, race.id);
    expect(raceWinner.status).toBe("succeeded");
    expect(raceWinner.publicationReceiptId).toMatch(/^receipt-/);
    expect((await getPublicationIntent(root, race.publicationIntentId!))?.status).toBe("registered");

    const uncertainRoot = await fixture();
    const uncertainServer = await protocolServer({ interruptStatus: 503 });
    await saveProvider(uncertainRoot, uncertainServer.endpoint);
    const [uncertainCreated] = await enqueueGeneration(uncertainRoot, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
    await processGenerationQueue(uncertainRoot, { jobId: uncertainCreated!.id });
    const uncertain = (await listGenerationJobs(uncertainRoot)).find((candidate) => candidate.id === uncertainCreated!.id)!;
    uncertainServer.states.set(uncertain.externalTaskId!, "running");
    await expect(cancelGenerationJob(uncertainRoot, uncertain.id)).rejects.toThrow(/未确认|503|保持/i);
    expect((await listGenerationJobs(uncertainRoot)).find((candidate) => candidate.id === uncertain.id)?.status).toBe("waiting_remote");
    expect((await getPublicationIntent(uncertainRoot, uncertain.publicationIntentId!))?.status).toBe("reserved");

    const delayedRoot = await fixture();
    const delayedServer = await protocolServer({ delayRunningCancelHistory: true });
    await saveProvider(delayedRoot, delayedServer.endpoint);
    const [delayedCreated] = await enqueueGeneration(delayedRoot, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
    await processGenerationQueue(delayedRoot, { jobId: delayedCreated!.id });
    let delayed = (await listGenerationJobs(delayedRoot)).find((candidate) => candidate.id === delayedCreated!.id)!;
    delayedServer.states.set(delayed.externalTaskId!, "running");
    await expect(cancelGenerationJob(delayedRoot, delayed.id)).rejects.toThrow(/未确认|锁定/i);
    delayed = (await listGenerationJobs(delayedRoot)).find((candidate) => candidate.id === delayed.id)!;
    expect(delayed).toMatchObject({ status: "waiting_remote", comfyUiCheckpoint: { stage: "cancel_requested", cancellation: { endpoint: "api_jobs_cancel", preObservedState: "running", outcome: "acted", serverActed: true } } });
    expect((await getPublicationIntent(delayedRoot, delayed.publicationIntentId!))?.status).toBe("reserved");
    delayedServer.states.set(delayed.externalTaskId!, "cancelled");
    delayed = await cancelGenerationJob(delayedRoot, delayed.id);
    expect(delayed).toMatchObject({ status: "cancelled", comfyUiCheckpoint: { stage: "cancelled", history: { eventName: "execution_interrupted" }, cancellation: { confirmation: { kind: "history_interrupted", eventName: "execution_interrupted" } } } });
    const delayedIntent = await getPublicationIntent(delayedRoot, delayed.publicationIntentId!);
    expect(delayedIntent).toMatchObject({ status: "cancelled", terminal: { provenance: { cause: "remote_cancel_confirmed", externalTaskId: delayed.externalTaskId, checkpointRevision: delayed.comfyUiCheckpoint?.revision, comfyUi: { historySha256: delayed.comfyUiCheckpoint?.history?.historySha256, eventName: "execution_interrupted", confirmationKind: "history_interrupted" } } } });
    expect(delayedServer.counts()).toMatchObject({ atomicCancelCount: 1, queueDeleteCount: 0, interruptCount: 0 });

    const falseRoot = await fixture();
    const falseServer = await protocolServer({ atomicCancelResult: false });
    await saveProvider(falseRoot, falseServer.endpoint);
    const [falseCreated] = await enqueueGeneration(falseRoot, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-loopback" });
    await processGenerationQueue(falseRoot, { jobId: falseCreated!.id });
    const falseJob = (await listGenerationJobs(falseRoot)).find((candidate) => candidate.id === falseCreated!.id)!;
    falseServer.setBeforeCancel(async (promptId) => { falseServer.states.delete(promptId); });
    await expect(cancelGenerationJob(falseRoot, falseJob.id)).rejects.toThrow(/cancelled=false|未确认|锁定/i);
    expect((await listGenerationJobs(falseRoot)).find((candidate) => candidate.id === falseJob.id)).toMatchObject({ status: "waiting_remote", comfyUiCheckpoint: { stage: "cancel_requested", cancellation: { outcome: "not_acted", serverActed: false } } });
    expect((await getPublicationIntent(falseRoot, falseJob.publicationIntentId!))?.status).toBe("reserved");
  });
});
