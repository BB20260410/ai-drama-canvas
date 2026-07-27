import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { executeIdempotentCommand, listCommandLedger, reconcileCommand } from "../src/core/command-bus.js";
import { doctorProject, getProjectSnapshot } from "../src/core/codex.js";
import { createVideoContinuationPack, listVideoContinuationPacks } from "../src/core/editor.js";
import {
  cancelGenerationJob,
  enqueueGeneration,
  getGenerationSettings,
  listGenerationJobs,
  processGenerationQueue,
  reconcileHttpGenerationSubmission,
  saveGenerationSettings,
} from "../src/core/generation.js";
import { cancelPublication, failPublication, getPublicationIntent, registerPublication } from "../src/core/publication.js";
import { scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import { seedProductionReady } from "./workflow-helpers.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-http-reconciliation-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  config.hardLocks = [];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const directory = path.join(root, "EP01_15s_001_HTTP对账");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "00_信息.md"), "# HTTP 对账\n\n首帧提示词：青铜神树下的人物。\n", "utf8");
  await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#3d3428" } }).png().toFile(path.join(directory, "EP01_15s_001_首帧_v1_raw.png"));
  await scanAndPersist(root);
  await seedProductionReady(root, "frames");
  const settings = await getGenerationSettings(root);
  const now = new Date().toISOString();
  settings.providers.push({
    id: "http-reconciliation-test",
    name: "HTTP 对账测试",
    adapter: "http-json",
    kinds: ["image", "video"],
    enabled: true,
    endpoint: "http://127.0.0.1:1/submit",
    pollEndpoint: "http://127.0.0.1:1/tasks/{taskId}",
    taskIdPath: "data.id",
    statusPath: "data.status",
    resultUrlPath: "data.url",
    allowPrivateNetwork: true,
    capabilities: { referenceModes: ["text", "first_frame"], maxReferenceImages: 12, maxReferenceVideos: 1, supportedDurations: [5], supportedAspectRatios: ["9:16"], supportedResolutions: ["1080p"], models: [], maxConcurrency: 1, supportsCancel: false },
    outputRoot: root,
    createdAt: now,
    updatedAt: now,
  });
  await saveGenerationSettings(root, settings);
  return root;
}

async function createUnknownJob(root: string) {
  const [created] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-reconciliation-test", prompt: "PROMPT_MUST_NOT_ENTER_LEDGER" });
  await processGenerationQueue(root, { jobId: created!.id });
  const job = (await listGenerationJobs(root)).find((candidate) => candidate.id === created!.id)!;
  expect(job).toMatchObject({ status: "submission_unknown", clientJobId: created!.id, httpSubmissionCheckpoint: { revision: 1, stage: "submission_unknown", submissionIntent: { clientJobId: created!.id, attempt: 1 } } });
  expect((await getPublicationIntent(root, job.publicationIntentId!))?.status).toBe("reserved");
  return job;
}

describe("HTTP submission_unknown 结构化对账", () => {
  it("found 只绑定原 externalTaskId 并进入同任务轮询，Publication 继续 reserved", async () => {
    const root = await fixture();
    const unknown = await createUnknownJob(root);
    const result = await reconcileHttpGenerationSubmission(root, unknown.id, {
      expectedRevision: 1,
      reconciliation: {
        result: "found",
        method: "client_job_id_search",
        externalTaskId: "remote-task-001",
        evidenceReference: "provider-search-audit-001",
        note: "按稳定 clientJobId 找到唯一远端任务",
      },
    });
    expect(result).toMatchObject({ applied: true, outcome: "found", status: "waiting_remote", externalTaskId: "remote-task-001", httpSubmissionCheckpoint: { revision: 2, stage: "reconciled_found", reconciliation: { result: "found", clientJobId: unknown.id, attempt: 1, evidenceReference: "provider-search-audit-001" } }, publicationStatus: "reserved" });
    const stored = (await listGenerationJobs(root)).find((candidate) => candidate.id === unknown.id)!;
    expect(stored.submissionIntent).toEqual(unknown.submissionIntent);
    expect(stored.remoteObservation).toMatchObject({ state: "pending", stage: "submit", nextAction: "poll_same_task" });
    expect((await getPublicationIntent(root, stored.publicationIntentId!))?.status).toBe("reserved");
    await processGenerationQueue(root, { jobId: stored.id });
    expect((await listGenerationJobs(root)).find((candidate) => candidate.id === stored.id)).toMatchObject({ status: "waiting_remote", externalTaskId: "remote-task-001", httpSubmissionCheckpoint: { revision: 2 } });
  });

  it("not_found 先闭合带来源的 Publication，再终结旧 Job 并允许显式新版本", async () => {
    const root = await fixture();
    const unknown = await createUnknownJob(root);
    const result = await reconcileHttpGenerationSubmission(root, unknown.id, {
      expectedRevision: 1,
      reconciliation: {
        result: "not_found",
        method: "provider_task_list",
        confirmNoRemoteResult: true,
        evidenceReference: "provider-task-list-snapshot-001",
        note: "供应商任务列表与请求日志均无此 clientJobId",
      },
    });
    expect(result).toMatchObject({ applied: true, outcome: "not_found", status: "failed", httpSubmissionCheckpoint: { revision: 2, stage: "reconciled_not_found", reconciliation: { result: "not_found", confirmNoRemoteResult: true } }, publicationStatus: "failed" });
    expect(result.remoteObservation).toBeUndefined();
    const intent = await getPublicationIntent(root, unknown.publicationIntentId!);
    expect(intent).toMatchObject({ status: "failed", terminal: { provenance: { source: "generation", generationJobId: unknown.id, cause: "http_submission_not_found", checkpointRevision: 2, reconciliation: { result: "not_found", evidenceReference: "provider-task-list-snapshot-001" } } } });
    const [next] = await enqueueGeneration(root, { itemIds: [unknown.itemId], kind: "image", providerId: "http-reconciliation-test" });
    expect(next!.id).not.toBe(unknown.id);
    expect(next!.expectedOutputPath).not.toBe(unknown.expectedOutputPath);
  });

  it("过期修订、非法证据、ID 冲突和已有文件都零副作用并形成 confirmed 命令失败", async () => {
    const root = await fixture();
    const unknown = await createUnknownJob(root);
    const before = JSON.stringify((await listGenerationJobs(root)).find((candidate) => candidate.id === unknown.id));
    await expect(reconcileHttpGenerationSubmission(root, unknown.id, {
      expectedRevision: 2,
      reconciliation: { result: "found", method: "client_job_id_search", externalTaskId: "remote-1", evidenceReference: "audit-001", note: "找到唯一任务" },
    })).rejects.toThrow("修订冲突");
    await expect(reconcileHttpGenerationSubmission(root, unknown.id, {
      expectedRevision: 1,
      reconciliation: { result: "found", method: "client_job_id_search", externalTaskId: "https://secret.example/task?token=x", evidenceReference: "audit-002", note: "找到唯一任务" },
    })).rejects.toThrow("externalTaskId");
    await expect(reconcileHttpGenerationSubmission(root, unknown.id, {
      expectedRevision: 1,
      reconciliation: { result: "not_found", method: "provider_support", confirmNoRemoteResult: true, evidenceReference: "audit-003", note: "查看 https://provider.example/task?token=SECRET" },
    })).rejects.toThrow("不能包含 URL 或凭据");
    expect(JSON.stringify((await listGenerationJobs(root)).find((candidate) => candidate.id === unknown.id))).toBe(before);

    await writeFile(unknown.expectedOutputPath, Buffer.from("unexpected-result"));
    await expect(reconcileHttpGenerationSubmission(root, unknown.id, {
      expectedRevision: 1,
      reconciliation: { result: "not_found", method: "provider_task_list", confirmNoRemoteResult: true, evidenceReference: "audit-004", note: "列表中没有任务" },
    })).rejects.toThrow("已有最终、隔离或 partial 文件");
    expect((await getPublicationIntent(root, unknown.publicationIntentId!))?.status).toBe("reserved");
    await expect(access(unknown.expectedOutputPath)).resolves.toBeUndefined();

    const command = await executeIdempotentCommand(root, {
      requestId: "request-http-stale-reconciliation-001",
      idempotencyKey: "http-stale-reconciliation-job-001",
      request: { command: "reconcile_http_generation_submission", payload: { jobId: unknown.id, expectedRevision: 9, reconciliation: { result: "found", method: "client_job_id_search", externalTaskId: "remote-safe", evidenceReference: "audit-005", note: "找到唯一任务" } } },
    }).catch(() => undefined);
    expect(command).toBeUndefined();
    expect((await listCommandLedger(root))[0]).toMatchObject({ command: "reconcile_http_generation_submission", status: "failed", result: { applied: false, jobId: unknown.id } });
  });

  it("无结构化来源的 Publication failed/cancelled 不得终结 Job、续接或释放重复提交锁", async () => {
    for (const terminal of ["failed", "cancelled"] as const) {
      const root = await fixture();
      const unknown = await createUnknownJob(root);
      const intent = (await getPublicationIntent(root, unknown.publicationIntentId!))!;
      const input = { intentId: intent.id, reservationToken: intent.reservationToken, expectedRevision: intent.revision, reason: `旧系统自由文本 ${terminal}，没有远端对账来源` };
      if (terminal === "failed") await failPublication(root, input);
      else await cancelPublication(root, input);
      await processGenerationQueue(root, { jobId: unknown.id });
      const locked = (await listGenerationJobs(root)).find((candidate) => candidate.id === unknown.id)!;
      expect(locked).toMatchObject({ status: "submission_unknown", httpSubmissionCheckpoint: { stage: "submission_unknown", revision: 1 }, remoteObservation: { state: "retryable_or_unknown", nextAction: "inspect_publication" } });
      expect(locked.error).toContain("缺少与当前生成任务匹配的结构化终态来源");
      await expect(enqueueGeneration(root, { itemIds: [unknown.itemId], kind: "image", providerId: "http-reconciliation-test" })).rejects.toThrow("拒绝创建可能重复付费的新任务");
      await expect(cancelGenerationJob(root, unknown.id)).rejects.toThrow("保持锁定");
      const doctor = await doctorProject(root);
      expect(doctor.checks.find((check) => check.id === "generation-jobs")).toMatchObject({ level: "error" });
      const snapshot = await getProjectSnapshot(root);
      expect(snapshot.generationJobs.find((candidate) => candidate.id === unknown.id)).toMatchObject({ status: "submission_unknown", httpSubmissionCheckpoint: { revision: 1, stage: "submission_unknown" } });
    }
  });

  it("Doctor 与统一快照在 browser/HTTP submission_unknown 混合时同时给出两类可执行动作", async () => {
    const root = await fixture();
    const httpUnknown = await createUnknownJob(root);
    const jobs = await listGenerationJobs(root);
    jobs.unshift({
      ...structuredClone(httpUnknown),
      id: "gen-browser-mixed-001",
      providerId: "browser-mixed-test",
      expectedOutputPath: path.join(root, "browser-mixed-output.png"),
      publicationIntentId: undefined,
      publicationReservationToken: undefined,
      submissionIntent: { clientJobId: "gen-browser-mixed-001", attempt: 1, createdAt: new Date().toISOString() },
      clientJobId: "gen-browser-mixed-001",
      httpSubmissionCheckpoint: undefined,
      browserState: "submission_unknown",
      browserCheckpoint: { revision: 4, stage: "submission_unknown", updatedAt: new Date().toISOString(), submissionIntent: { clientJobId: "gen-browser-mixed-001", attempt: 1, createdAt: new Date().toISOString() } },
    });
    await writeJsonAtomic(getSidecarPaths(root).generationJobs, jobs);
    const doctor = await doctorProject(root);
    expect(doctor.suggestedNextCalls).toEqual(expect.arrayContaining(["get_browser_generation_plan", "reconcile_http_generation_submission", "list_command_ledger"]));
    expect(doctor.checks.find((check) => check.id === "generation-jobs")?.detail).toContain("网页 1、HTTP 1");
    const snapshot = await getProjectSnapshot(root);
    expect(snapshot.suggestedNextCalls).toEqual(expect.arrayContaining(["get_browser_generation_plan", "reconcile_http_generation_submission", "list_command_ledger"]));
    expect(snapshot.generationJobs.find((candidate) => candidate.id === httpUnknown.id)?.httpSubmissionCheckpoint).toMatchObject({ revision: 1, stage: "submission_unknown" });
  });

  it("Publication 注册竞态优先恢复成功，Publication 已闭合后的崩溃可从来源证据恢复", async () => {
    const root = await fixture();
    const unknown = await createUnknownJob(root);
    const registered = await reconcileHttpGenerationSubmission(root, unknown.id, {
      expectedRevision: 1,
      reconciliation: { result: "not_found", method: "provider_task_list", confirmNoRemoteResult: true, evidenceReference: "race-audit-registered-001", note: "检查时没有看到任务" },
    }, {
      beforePublicationClose: async () => {
        await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#654321" } }).png().toFile(unknown.expectedOutputPath);
        const intent = (await getPublicationIntent(root, unknown.publicationIntentId!))!;
        await registerPublication(root, { intentId: intent.id, reservationToken: intent.reservationToken, expectedRevision: intent.revision }, "scanner");
      },
    });
    expect(registered).toMatchObject({ applied: false, outcome: "publication_registered", status: "succeeded", publicationStatus: "registered" });
    expect((await listGenerationJobs(root)).find((candidate) => candidate.id === unknown.id)).toMatchObject({ status: "succeeded", publicationReceiptId: expect.stringMatching(/^receipt-/) });
    expect((await getPublicationIntent(root, unknown.publicationIntentId!))?.status).toBe("registered");

    const crashRoot = await fixture();
    const crashUnknown = await createUnknownJob(crashRoot);
    await expect(reconcileHttpGenerationSubmission(crashRoot, crashUnknown.id, {
      expectedRevision: 1,
      reconciliation: { result: "not_found", method: "provider_request_log", confirmNoRemoteResult: true, evidenceReference: "crash-window-audit-001", note: "请求日志确认没有建立任务" },
    }, { afterPublicationClose: () => { throw new Error("TEST_ONLY_CRASH_AFTER_PUBLICATION_CLOSE"); } })).rejects.toThrow("TEST_ONLY_CRASH_AFTER_PUBLICATION_CLOSE");
    expect((await getPublicationIntent(crashRoot, crashUnknown.publicationIntentId!))).toMatchObject({ status: "failed", terminal: { provenance: { cause: "http_submission_not_found", checkpointRevision: 2 } } });
    expect((await listGenerationJobs(crashRoot)).find((candidate) => candidate.id === crashUnknown.id)).toMatchObject({ status: "submission_unknown", httpSubmissionCheckpoint: { revision: 1 } });
    await processGenerationQueue(crashRoot, { jobId: crashUnknown.id });
    expect((await listGenerationJobs(crashRoot)).find((candidate) => candidate.id === crashUnknown.id)).toMatchObject({ status: "failed", httpSubmissionCheckpoint: { revision: 2, stage: "reconciled_not_found" } });
  });

  it("HTTP 对账修订与状态同步投影到唯一视频续接包", async () => {
    const root = await fixture();
    const index = await scanAndPersist(root);
    const firstFrame = index.artifacts.find((artifact) => artifact.itemId === "main-ep01-unit001" && artifact.kind === "raw-image" && artifact.authoritative && artifact.check.ok)!;
    const pack = await createVideoContinuationPack(root, { itemId: "main-ep01-unit001", lastFramePath: firstFrame.path, prompt: "保持角色和青铜道具连续，延续上一帧运动。" });
    const [job] = await enqueueGeneration(root, { itemIds: [pack.itemId], kind: "video", providerId: "http-reconciliation-test", prompt: pack.prompt, continuation: { continuationId: pack.id, firstFrameArtifactId: firstFrame.id } });
    await processGenerationQueue(root, { jobId: job!.id });
    expect((await listVideoContinuationPacks(root)).find((candidate) => candidate.id === pack.id)).toMatchObject({ status: "submission_unknown", generationStatus: "submission_unknown", httpSubmissionCheckpoint: { revision: 1, stage: "submission_unknown" } });
    await reconcileHttpGenerationSubmission(root, job!.id, { expectedRevision: 1, reconciliation: { result: "found", method: "provider_idempotency_lookup", externalTaskId: "remote-continuation-001", evidenceReference: "continuation-audit-001", note: "幂等查询找到唯一视频任务" } });
    expect((await listVideoContinuationPacks(root)).find((candidate) => candidate.id === pack.id)).toMatchObject({ status: "submitted", generationStatus: "waiting_remote", externalTaskId: "remote-continuation-001", httpSubmissionCheckpoint: { revision: 2, stage: "reconciled_found" } });

    const failedRoot = await fixture();
    const failedIndex = await scanAndPersist(failedRoot);
    const failedFirstFrame = failedIndex.artifacts.find((artifact) => artifact.itemId === "main-ep01-unit001" && artifact.kind === "raw-image" && artifact.authoritative && artifact.check.ok)!;
    const failedPack = await createVideoContinuationPack(failedRoot, { itemId: "main-ep01-unit001", lastFramePath: failedFirstFrame.path, prompt: "续接失败投影测试。" });
    const [failedJob] = await enqueueGeneration(failedRoot, { itemIds: [failedPack.itemId], kind: "video", providerId: "http-reconciliation-test", prompt: failedPack.prompt, continuation: { continuationId: failedPack.id, firstFrameArtifactId: failedFirstFrame.id } });
    await processGenerationQueue(failedRoot, { jobId: failedJob!.id });
    await reconcileHttpGenerationSubmission(failedRoot, failedJob!.id, { expectedRevision: 1, reconciliation: { result: "not_found", method: "provider_request_log", confirmNoRemoteResult: true, evidenceReference: "continuation-audit-002", note: "请求日志确认没有建立视频任务" } });
    expect((await listVideoContinuationPacks(failedRoot)).find((candidate) => candidate.id === failedPack.id)).toMatchObject({ status: "failed", generationStatus: "failed", httpSubmissionCheckpoint: { revision: 2, stage: "reconciled_not_found" }, completedAt: expect.any(String) });
  });

  it("远端取消响应期间 Publication 并发注册时成功回执获胜，Job 不写假 cancelled", async () => {
    const root = await fixture();
    let cancelCalls = 0;
    let job: Awaited<ReturnType<typeof listGenerationJobs>>[number] | undefined;
    const server = createServer((request, response) => {
      void (async () => {
        if (!job || request.method !== "POST" || request.url !== "/cancel/remote-cancel-race-001") {
          response.writeHead(404).end();
          return;
        }
        cancelCalls += 1;
        await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#2c5f55" } }).png().toFile(job.expectedOutputPath);
        const intent = (await getPublicationIntent(root, job.publicationIntentId!))!;
        await registerPublication(root, { intentId: intent.id, reservationToken: intent.reservationToken, expectedRevision: intent.revision }, "scanner");
        response.writeHead(204).end();
      })().catch((error) => response.writeHead(500).end(String(error)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const settings = await getGenerationSettings(root);
      const provider = settings.providers.find((candidate) => candidate.id === "http-reconciliation-test")!;
      provider.cancelEndpoint = `${origin}/cancel/{taskId}`;
      provider.cancelMethod = "POST";
      provider.capabilities = { ...provider.capabilities!, supportsCancel: true };
      await saveGenerationSettings(root, settings);
      const [created] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "http-reconciliation-test" });
      const jobs = await listGenerationJobs(root);
      job = jobs.find((candidate) => candidate.id === created!.id)!;
      const currentJob = job;
      currentJob.status = "waiting_remote";
      currentJob.attempts = 1;
      currentJob.submissionIntent = { clientJobId: currentJob.id, attempt: 1, createdAt: new Date().toISOString() };
      currentJob.externalTaskId = "remote-cancel-race-001";
      currentJob.remoteAcceptedAt = new Date().toISOString();
      await writeJsonAtomic(getSidecarPaths(root).generationJobs, jobs);
      await expect(cancelGenerationJob(root, currentJob.id)).rejects.toThrow("Publication 已是 registered");
      expect(cancelCalls).toBe(1);
      expect((await listGenerationJobs(root)).find((candidate) => candidate.id === currentJob.id)?.status).toBe("waiting_remote");
      expect((await getPublicationIntent(root, currentJob.publicationIntentId!))?.status).toBe("registered");
      await processGenerationQueue(root, { jobId: currentJob.id });
      expect((await listGenerationJobs(root)).find((candidate) => candidate.id === currentJob.id)).toMatchObject({ status: "succeeded", publicationReceiptId: expect.stringMatching(/^receipt-/) });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("命令总线同键只应用一次，回执崩溃后按终态事件对账且账本不保存完整 Job", async () => {
    const root = await fixture();
    const unknown = await createUnknownJob(root);
    const input = {
      requestId: "request-http-found-command-001",
      idempotencyKey: "http-found-command-job-001",
      request: { command: "reconcile_http_generation_submission" as const, payload: { jobId: unknown.id, expectedRevision: 1, reconciliation: { result: "found" as const, method: "provider_idempotency_lookup" as const, externalTaskId: "remote-command-001", evidenceReference: "idempotency-lookup-audit-001", note: "幂等查询返回唯一远端任务" } } },
    };
    const first = await executeIdempotentCommand(root, input);
    const replay = await executeIdempotentCommand(root, { ...input, requestId: "request-http-found-command-002" });
    expect(first).toMatchObject({ status: "succeeded", replayed: false, result: { applied: true, outcome: "found", status: "waiting_remote" } });
    expect(replay).toMatchObject({ status: "succeeded", replayed: true, result: { applied: true, outcome: "found", status: "waiting_remote", externalTaskId: "remote-command-001" } });
    const serialized = JSON.stringify(await listCommandLedger(root));
    expect(serialized).not.toContain("PROMPT_MUST_NOT_ENTER_LEDGER");
    expect(serialized).not.toContain("publicationReservationToken");
    expect(serialized).not.toContain("remoteResultUrl");

    const rootAfterCrash = await fixture();
    const unknownAfterCrash = await createUnknownJob(rootAfterCrash);
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "reconcile_http_generation_submission";
    const crashInput = {
      requestId: "request-http-not-found-crash-001",
      idempotencyKey: "http-not-found-crash-job-001",
      request: { command: "reconcile_http_generation_submission" as const, payload: { jobId: unknownAfterCrash.id, expectedRevision: 1, reconciliation: { result: "not_found" as const, method: "provider_request_log" as const, confirmNoRemoteResult: true as const, evidenceReference: "request-log-audit-001", note: "请求日志确认未建立远端任务" } } },
    };
    await expect(executeIdempotentCommand(rootAfterCrash, crashInput)).rejects.toThrow("结果未确认");
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    expect((await listGenerationJobs(rootAfterCrash)).find((candidate) => candidate.id === unknownAfterCrash.id)?.status).toBe("failed");
    expect((await listCommandLedger(rootAfterCrash))[0]?.status).toBe("unknown");
    expect((await reconcileCommand(rootAfterCrash, { idempotencyKey: crashInput.idempotencyKey })).status).toBe("succeeded");
  });
});
