import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { preflightPublication } from "../src/core/publication.js";
import { appendEvent, ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";

function parseToolResult(result: unknown): unknown {
  const response = result as { content?: Array<{ type: string; text?: string }> };
  const text = response.content?.find((entry) => entry.type === "text" && typeof entry.text === "string")?.text ?? "{}";
  const parsed = JSON.parse(text) as { status?: string; result?: unknown };
  return parsed.status === "succeeded" && Object.hasOwn(parsed, "result") ? parsed.result : parsed;
}

describe("stdio MCP 远端生成观测摘要", () => {
  it("源码态与编译态都只暴露可恢复字段、结果主机和脱敏诊断", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const root = await mkdtemp(path.join(os.tmpdir(), `ai-canvas-mcp-generation-observation-${suffix}-`));
    const registry = path.join(os.tmpdir(), `ai-canvas-mcp-generation-observation-registry-${suffix}.json`);
    const directory = path.join(root, "EP01_15s_001_MCP远端观测");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "00_信息.md"), "首帧提示词：MCP 观测脱敏测试。\n", "utf8");
    const config = await ensureSidecar(root);
    const now = new Date().toISOString();
    const legacyGenerationSettings = {
      schemaVersion: 1 as const,
      revision: 1,
      providers: [{
        id: "legacy-http-secret-url",
        name: "旧 HTTP 配置",
        adapter: "http-json" as const,
        kinds: ["image" as const],
        enabled: true,
        endpoint: "https://api.example.test/submit?api_key=LEGACY_ENDPOINT_SECRET&mode=image#LEGACY_ENDPOINT_FRAGMENT",
        pollEndpoint: "https://api.example.test/tasks/{taskId}?signature=LEGACY_POLL_SECRET",
        cancelEndpoint: "https://api.example.test/tasks/{taskId}/cancel?X-Amz-Signature=LEGACY_CANCEL_SECRET",
        outputRoot: root,
        createdAt: now,
        updatedAt: now,
      }, {
        id: "legacy-browser-secret-url",
        name: "旧网页配置",
        adapter: "codex-browser" as const,
        kinds: ["image" as const],
        enabled: true,
        siteUrl: "https://browser.example.test/generate?token=LEGACY_SITE_SECRET#LEGACY_SITE_FRAGMENT",
        outputRoot: root,
        createdAt: now,
        updatedAt: now,
      }, {
        id: "http-mcp-observation",
        name: "MCP 观测本地占位",
        adapter: "http-json" as const,
        kinds: ["image" as const],
        enabled: true,
        endpoint: "http://127.0.0.1:1/submit",
        pollEndpoint: "http://127.0.0.1:1/tasks/{taskId}",
        allowPrivateNetwork: true,
        outputRoot: root,
        createdAt: now,
        updatedAt: now,
      }],
      defaultImageProviderId: "legacy-http-secret-url",
      concurrency: 1,
      updatedAt: now,
    };
    await writeJsonAtomic(getSidecarPaths(root).generationSettings, legacyGenerationSettings);
    await writeJsonAtomic(getSidecarPaths(root).commandLedger, {
      schemaVersion: 1,
      entries: [{
        schemaVersion: 1,
        requestId: "request-legacy-provider-ledger-001",
        idempotencyKey: "legacy-provider-ledger-001",
        command: "upsert_generation_provider",
        status: "succeeded",
        replayed: false,
        requestHash: "a".repeat(64),
        result: legacyGenerationSettings,
        startedAt: now,
        executedAt: now,
      }],
      updatedAt: now,
    });
    const jobId = "gen-mcp-http-observation-001";
    const unknownJobId = "gen-mcp-http-unknown-001";
    const partialPath = path.join(getSidecarPaths(root).generationDownloads, jobId, "result.partial");
    const readyPath = path.join(getSidecarPaths(root).generationDownloads, jobId, "result.ready");
    const unknownPublication = await preflightPublication(root, {
      idempotencyKey: "mcp-http-unknown-publication-001",
      requestedPath: path.join(directory, "AI画布生成", "unknown_raw.png"),
      allowedRoot: root,
      kind: "raw-image",
      context: { purpose: "generation-output", itemId: "main-ep01-unit001", jobId: unknownJobId },
    });
    await writeJsonAtomic(getSidecarPaths(root).generationJobs, [{
      id: jobId,
      itemId: "main-ep01-unit001",
      providerId: "http-mcp-observation",
      kind: "image",
      purpose: "generated-image",
      prompt: "PROMPT_MUST_NOT_LEAK",
      status: "waiting_remote",
      expectedOutputPath: path.join(directory, "AI画布生成", "result_raw.png"),
      expectedCompanionPath: path.join(directory, "AI画布生成", "result_labeled.png"),
      requestPath: path.join(getSidecarPaths(root).generationRequests, `${jobId}.json`),
      referencePaths: [],
      references: [],
      clientJobId: jobId,
      submissionIntent: { clientJobId: jobId, attempt: 1, createdAt: now },
      externalTaskId: "remote-mcp-42",
      remoteResultUrl: "https://cdn.example.test/result.png?signature=SIGNED_QUERY_MUST_NOT_LEAK&access_token=TOKEN_MUST_NOT_LEAK",
      remoteAcceptedAt: now,
      remoteObservation: { state: "retryable_or_unknown", stage: "download", observedAt: now, observedStatus: "signature=STATUS_SECRET", message: "下载 https://cdn.example.test/result.png?signature=OBSERVATION_SECRET 失败，Authorization: Bearer LEGACY_BEARER_SECRET", retryCount: 2, nextAction: "retry_same_task", httpStatus: 503 },
      browserCheckpoint: { schemaVersion: 1, revision: 1, stage: "processing", externalTaskId: "token=CHECKPOINT_EXTERNAL_SECRET", submissionIntent: { clientJobId: jobId, intentAt: now, authorizationReference: "api_key=CHECKPOINT_SECRET" }, updatedAt: now, note: "参考 https://provider.example.test/task?token=CHECKPOINT_URL_SECRET" },
      isolatedDownloadPath: readyPath,
      partialDownloadPath: partialPath,
      downloadBytes: 4096,
      pollAttempts: 3,
      downloadAttempts: 2,
      error: "请求 https://provider.example.test/task?secret=ERROR_URL_SECRET 失败；Bearer ERROR_BEARER_SECRET",
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    }, {
      schemaVersion: 1,
      id: unknownJobId,
      projectId: config.id,
      itemId: "main-ep01-unit001",
      providerId: "legacy-http-secret-url",
      kind: "image",
      prompt: "HTTP_UNKNOWN_PROMPT_MUST_NOT_LEAK",
      status: "submission_unknown",
      expectedOutputPath: unknownPublication.targetPath,
      referencePaths: [],
      storyboardRevision: 1,
      storyboardRows: [],
      publicationIntentId: unknownPublication.id,
      publicationReservationToken: unknownPublication.reservationToken,
      clientJobId: unknownJobId,
      submissionIntent: { clientJobId: unknownJobId, attempt: 1, createdAt: now },
      httpSubmissionCheckpoint: { revision: 1, stage: "submission_unknown", updatedAt: now, submissionIntent: { clientJobId: unknownJobId, attempt: 1, createdAt: now } },
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    }]);
    await appendEvent(root, { actor: "app", type: "generation.remote-identity-persisted", data: { externalTaskId: "https://provider.example.test/task?token=EVENT_SECRET", observedStatus: "credential=EVENT_CREDENTIAL_SECRET" } });
    await writeJsonAtomic(registry, [{ id: config.id, name: config.name, primaryRoot: root, updatedAt: now }]);

    const compiledServer = process.env.AI_CANVAS_MCP_SERVER_PATH?.trim();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: compiledServer ? [path.resolve(compiledServer)] : ["--import", "tsx", "src/mcp/server.ts"],
      cwd: process.cwd(),
      env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registry },
      stderr: "pipe",
    });
    const client = new Client({ name: "ai-canvas-mcp-generation-observation-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const processTool = tools.tools.find((tool) => tool.name === "process_generation_queue");
      const reconciliationTool = tools.tools.find((tool) => tool.name === "reconcile_http_generation_submission");
      expect((processTool?.inputSchema as { properties?: Record<string, unknown> }).properties).toHaveProperty("jobId");
      expect(processTool?.description).toContain("定向恢复单个既有");
      expect((reconciliationTool?.inputSchema as { properties?: Record<string, unknown> }).properties).toEqual(expect.objectContaining({ jobId: expect.any(Object), expectedRevision: expect.any(Object), reconciliation: expect.any(Object), requestId: expect.any(Object), idempotencyKey: expect.any(Object) }));
      expect(reconciliationTool?.description).toContain("不发 POST、GET、轮询或下载");

      const generationSettings = parseToolResult(await client.callTool({ name: "get_generation_settings", arguments: { projectRoot: root } })) as { providers: Array<Record<string, unknown>> };
      const legacyHttp = generationSettings.providers.find((provider) => provider.id === "legacy-http-secret-url")!;
      const legacyBrowser = generationSettings.providers.find((provider) => provider.id === "legacy-browser-secret-url")!;
      const safeEndpoint = new URL(String(legacyHttp.endpoint));
      expect(safeEndpoint.searchParams.get("api_key")).toBe("[redacted]");
      expect(safeEndpoint.searchParams.get("mode")).toBe("image");
      expect(safeEndpoint.hash).toBe("");
      expect(new URL(String(legacyHttp.pollEndpoint)).searchParams.get("signature")).toBe("[redacted]");
      expect(new URL(String(legacyHttp.cancelEndpoint)).searchParams.get("X-Amz-Signature")).toBe("[redacted]");
      const safeSiteUrl = new URL(String(legacyBrowser.siteUrl));
      expect(safeSiteUrl.searchParams.get("token")).toBe("[redacted]");
      expect(safeSiteUrl.hash).toBe("");

      const providerResult = parseToolResult(await client.callTool({ name: "get_generation_provider", arguments: { projectRoot: root, providerId: "legacy-http-secret-url" } })) as { provider: Record<string, unknown> };
      expect(new URL(String(providerResult.provider.endpoint)).searchParams.get("api_key")).toBe("[redacted]");

      const listed = parseToolResult(await client.callTool({ name: "list_generation_jobs", arguments: { projectRoot: root } })) as Array<Record<string, unknown>>;
      expect(listed).toHaveLength(2);
      const observedSummary = listed.find((entry) => entry.id === jobId)!;
      const unknownSummary = listed.find((entry) => entry.id === unknownJobId)!;
      expect(observedSummary).toMatchObject({ id: jobId, clientJobId: jobId, externalTaskId: "remote-mcp-42", remoteResultHost: "cdn.example.test", isolatedDownloadPath: readyPath, partialDownloadPath: partialPath, pollAttempts: 3, downloadAttempts: 2, remoteObservation: { state: "retryable_or_unknown", stage: "download", httpStatus: 503, nextAction: "retry_same_task" } });
      expect(unknownSummary).toMatchObject({ id: unknownJobId, status: "submission_unknown", httpSubmissionCheckpoint: { revision: 1, stage: "submission_unknown", submissionIntent: { clientJobId: unknownJobId, attempt: 1 } } });
      expect(observedSummary).not.toHaveProperty("remoteResultUrl");
      expect(observedSummary).not.toHaveProperty("prompt");

      const reconciliationRequestId = "request-mcp-http-reconciliation-001";
      const reconciliationKey = "mcp-http-reconciliation-unknown-v1";
      const reconciliationArguments = { projectRoot: root, jobId: unknownJobId, expectedRevision: 1, reconciliation: { result: "found", method: "client_job_id_search", externalTaskId: "remote-mcp-reconciled-001", evidenceReference: "mcp-provider-search-audit-001", note: "按 clientJobId 找到唯一远端任务" }, requestId: reconciliationRequestId, idempotencyKey: reconciliationKey };
      const reconciledHttp = parseToolResult(await client.callTool({ name: "reconcile_http_generation_submission", arguments: reconciliationArguments })) as Record<string, unknown>;
      expect(reconciledHttp).toMatchObject({ applied: true, outcome: "found", jobId: unknownJobId, status: "waiting_remote", externalTaskId: "remote-mcp-reconciled-001", httpSubmissionCheckpoint: { revision: 2, stage: "reconciled_found" } });
      expect(reconciledHttp).not.toHaveProperty("prompt");
      expect(reconciledHttp).not.toHaveProperty("publicationReservationToken");

      const replayedHttp = parseToolResult(await client.callTool({ name: "execute_command", arguments: { projectRoot: root, requestId: "request-mcp-http-reconciliation-002", idempotencyKey: reconciliationKey, request: { command: "reconcile_http_generation_submission", payload: { jobId: unknownJobId, expectedRevision: 1, reconciliation: reconciliationArguments.reconciliation } } } })) as Record<string, unknown>;
      expect(replayedHttp).toMatchObject({ applied: true, outcome: "found", status: "waiting_remote", httpSubmissionCheckpoint: { revision: 2 } });

      const resource = await client.readResource({ uri: `aicanvas://projects/${config.id}/generation/${jobId}` });
      const resourceContent = resource.contents[0];
      const resourceSummary = JSON.parse(resourceContent && "text" in resourceContent ? resourceContent.text : "{}") as Record<string, unknown>;
      expect(resourceSummary).toMatchObject({ id: jobId, remoteResultHost: "cdn.example.test", remoteObservation: { state: "retryable_or_unknown", stage: "download", nextAction: "retry_same_task" } });
      expect(resourceSummary).not.toHaveProperty("remoteResultUrl");
      expect(resourceSummary).not.toHaveProperty("prompt");

      const requestId = "request-mcp-generation-process-001";
      const idempotencyKey = "mcp-generation-process-observation-v1";
      const processed = parseToolResult(await client.callTool({ name: "process_generation_queue", arguments: { projectRoot: root, jobId, requestId, idempotencyKey } })) as { processedJobId?: string; recent?: Array<Record<string, unknown>> };
      expect(processed).toMatchObject({ processedJobId: jobId, recent: [expect.objectContaining({ id: jobId, clientJobId: jobId, remoteResultHost: "cdn.example.test" })] });
      expect(processed.recent?.[0]).not.toHaveProperty("remoteResultUrl");
      expect(processed.recent?.[0]).not.toHaveProperty("prompt");

      const replayed = parseToolResult(await client.callTool({ name: "execute_command", arguments: { projectRoot: root, requestId, idempotencyKey, request: { command: "process_generation_queue", payload: { jobId } } } })) as { processedJobId?: string; recent?: Array<Record<string, unknown>> };
      expect(replayed).toMatchObject({ processedJobId: jobId, recent: [expect.objectContaining({ id: jobId, remoteResultHost: "cdn.example.test" })] });
      const ledger = parseToolResult(await client.callTool({ name: "list_command_ledger", arguments: { projectRoot: root, limit: 10 } })) as Array<{ command: string; result?: unknown }>;
      expect(ledger.find((entry) => entry.command === "process_generation_queue")?.result).toMatchObject({ recent: expect.arrayContaining([expect.objectContaining({ id: jobId, remoteResultHost: "cdn.example.test" })]) });
      const legacyProviderLedger = ledger.find((entry) => entry.command === "upsert_generation_provider")?.result as { providers?: Array<Record<string, unknown>> } | undefined;
      expect(new URL(String(legacyProviderLedger?.providers?.[0]?.endpoint)).searchParams.get("api_key")).toBe("[redacted]");
      const changesResource = await client.readResource({ uri: `aicanvas://projects/${config.id}/changes/start` });
      const changesContent = changesResource.contents[0];
      const changes = JSON.parse(changesContent && "text" in changesContent ? changesContent.text : "{}") as Record<string, unknown>;

      expect(ledger.find((entry) => entry.command === "reconcile_http_generation_submission")?.result).toMatchObject({ applied: true, outcome: "found", jobId: unknownJobId, httpSubmissionCheckpoint: { revision: 2 } });
      const serialized = JSON.stringify({ generationSettings, providerResult, listed, reconciledHttp, replayedHttp, resourceSummary, processed, replayed, ledger, changes });
      for (const forbidden of ["LEGACY_ENDPOINT_SECRET", "LEGACY_ENDPOINT_FRAGMENT", "LEGACY_POLL_SECRET", "LEGACY_CANCEL_SECRET", "LEGACY_SITE_SECRET", "LEGACY_SITE_FRAGMENT", "PROMPT_MUST_NOT_LEAK", "HTTP_UNKNOWN_PROMPT_MUST_NOT_LEAK", "SIGNED_QUERY_MUST_NOT_LEAK", "TOKEN_MUST_NOT_LEAK", "STATUS_SECRET", "OBSERVATION_SECRET", "LEGACY_BEARER_SECRET", "CHECKPOINT_EXTERNAL_SECRET", "CHECKPOINT_SECRET", "CHECKPOINT_URL_SECRET", "ERROR_URL_SECRET", "ERROR_BEARER_SECRET", "EVENT_SECRET", "EVENT_CREDENTIAL_SECRET"]) expect(serialized).not.toContain(forbidden);
      expect(serialized).toContain("[redacted-url]");
      expect(serialized).toContain("Bearer [redacted]");
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
      await rm(registry, { force: true });
    }
  }, 30_000);
});
