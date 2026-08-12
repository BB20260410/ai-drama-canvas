import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAdaptationStore, saveAdaptationStore } from "../src/core/adaptation.js";
import { commitProjectImport, prepareProjectImport } from "../src/core/importer.js";
import { createNovelAnalysisTask, submitNovelAnalysisProposal } from "../src/core/novel-analysis.js";
import { __setNovelAnalysisExecutionIntentHookForTests, __setNovelAnalysisMarkExecutionHookForTests, __setNovelAnalysisRunProgressHookForTests, executeNextNovelAnalysisRunTask, executeNovelAnalysisTask, getNovelAnalysisExecutionRecoveryStatus, getNovelAnalysisProviderSettings, getNovelAnalysisRunProgress, markNovelAnalysisExecutionReconciliationRequired, planNovelAnalysisRun, probeNovelAnalysisProvider, reconcileNovelAnalysisExecution, replaceNovelAnalysisRunTask, upsertNovelAnalysisProvider } from "../src/core/novel-analysis-provider.js";
import { __setNovelAnalysisAddressResolverForTests } from "../src/core/novel-analysis-transport.js";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { listCommandLedgerEntries } from "../src/core/command-ledger-store.js";
import { getSidecarPaths } from "../src/core/sidecar.js";
import { importStoryFile } from "../src/core/story.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  __setNovelAnalysisAddressResolverForTests(undefined);
  __setNovelAnalysisExecutionIntentHookForTests(undefined);
  __setNovelAnalysisMarkExecutionHookForTests(undefined);
  __setNovelAnalysisRunProgressHookForTests(undefined);
  delete process.env.AI_CANVAS_TEST_NOVEL_KEY;
  delete process.env.AI_CANVAS_TEST_NOVEL_ANALYSIS_INTERRUPT;
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-model-provider-"));
  roots.push(root);
  const novelPath = path.join(root, "真实小说.md");
  await writeFile(novelPath, "# 第一章 石门\n清晨，阿航穿着黑袍走进祭坛。\n嘟嘟低声说：“不要触碰完整黄金面具。”\n", "utf8");
  const preview = await prepareProjectImport({ primaryRoot: root, projectMode: "story_first", name: "模型执行测试" });
  await commitProjectImport({ previewId: preview.previewId, config: preview.config, projectMode: "story_first" });
  await importStoryFile(root, novelPath, "石门");
  return root;
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未监听 TCP 端口");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

function provider(baseUrl: string, overrides: Partial<Parameters<typeof upsertNovelAnalysisProvider>[1]["provider"]> = {}): Parameters<typeof upsertNovelAnalysisProvider>[1]["provider"] {
  return { id: "local-qwen", name: "本机 Qwen", adapter: "openai-compatible", enabled: true, baseUrl, model: "qwen-test", apiKeyEnv: "AI_CANVAS_TEST_NOVEL_KEY", allowPrivateNetwork: true, allowStoryUpload: true, useJsonResponseFormat: true, timeoutSeconds: 10, maxInputCharacters: 100_000, temperature: 0, ...overrides };
}

describe("小说分析 OpenAI 兼容 Provider", () => {
  it("要求明确授权正文外发和私网，并且从不把密钥值落盘", async () => {
    const root = await fixture();
    await expect(upsertNovelAnalysisProvider(root, { expectedRevision: 0, provider: provider("http://127.0.0.1:1234/v1", { allowPrivateNetwork: false }) })).rejects.toThrow("私网");
    await expect(upsertNovelAnalysisProvider(root, { expectedRevision: 0, provider: provider("http://93.184.216.34/v1") })).rejects.toThrow("HTTPS");
    await expect(upsertNovelAnalysisProvider(root, { expectedRevision: 0, provider: provider("http://public-provider.test/v1", { allowPrivateNetwork: false }) })).rejects.toThrow("HTTPS");
    await expect(upsertNovelAnalysisProvider(root, { expectedRevision: 0, provider: provider("https://example.com/v1", { allowPrivateNetwork: false, allowStoryUpload: false }) })).rejects.toThrow("allowStoryUpload");
    process.env.AI_CANVAS_TEST_NOVEL_KEY = "never-write-this-secret";
    const saved = await upsertNovelAnalysisProvider(root, { expectedRevision: 0, provider: provider("http://127.0.0.1:1234/v1"), setAsDefault: true });
    expect(saved.revision).toBe(1);
    expect(saved.defaultProviderId).toBe("local-qwen");
    const raw = await readFile(getSidecarPaths(root).storyAnalysisProviders, "utf8");
    expect(raw).toContain("AI_CANVAS_TEST_NOVEL_KEY");
    expect(raw).not.toContain("never-write-this-secret");
    expect((await getNovelAnalysisProviderSettings(root)).providers[0]?.revision).toBe(1);
  });

  it("连接期 DNS 门禁失败时任务保持 prepared，且不创建 execution", async () => {
    const root = await fixture();
    process.env.AI_CANVAS_TEST_NOVEL_KEY = "must-not-leave-process";
    await upsertNovelAnalysisProvider(root, {
      expectedRevision: 0,
      provider: provider("https://rebind-provider.test/v1", { allowPrivateNetwork: false }),
      setAsDefault: true,
    });
    const created = await createNovelAnalysisTask(root, { expectedRevision: 0, providerId: "local-qwen", providerKind: "external" });
    __setNovelAnalysisAddressResolverForTests(async () => [{ address: "127.0.0.1", family: 4 }]);

    await expect(executeNovelAnalysisTask(root, {
      taskId: created.task.id,
      providerId: "local-qwen",
      expectedRevision: created.workspace.revision,
    })).rejects.toMatchObject({ code: "NOVEL_PROVIDER_PRIVATE_NETWORK_DENIED" });

    const workspace = await loadAdaptationStore(root);
    expect(workspace.revision).toBe(created.workspace.revision);
    const persistedTask = workspace.analysisTasks.find((task) => task.id === created.task.id);
    expect(persistedTask?.status).toBe("prepared");
    expect(persistedTask?.execution).toBeUndefined();
  });

  it("分析任务目录被软链到工程外时，创建在任何任务文件写入前失败关闭", async () => {
    const root = await fixture();
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-analysis-task-symlink-"));
    roots.push(outsideRoot);
    await rm(getSidecarPaths(root).storyAnalysisTasks, { recursive: true, force: true });
    await symlink(outsideRoot, getSidecarPaths(root).storyAnalysisTasks);

    await expect(createNovelAnalysisTask(root, {
      expectedRevision: 0,
      providerId: "codex",
      providerKind: "codex",
    })).rejects.toThrow(/符号链接|受管目录|输出目录/u);
    expect(await readdir(outsideRoot)).toEqual([]);
    expect((await loadAdaptationStore(root)).analysisTasks).toEqual([]);
  });

  it("预检后到 execution intent 前任务绑定漂移时仍保持 prepared 且零 POST", async () => {
    const root = await fixture();
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-analysis-intent-race-"));
    roots.push(outsideRoot);
    process.env.AI_CANVAS_TEST_NOVEL_KEY = "intent-race-test-token";
    let remotePostCount = 0;
    const { baseUrl } = await listen(async (request, response) => {
      if (request.url === "/v1/chat/completions") remotePostCount += 1;
      for await (const _chunk of request) { /* drain */ }
      response.statusCode = 500;
      response.end("intent-race-provider-response");
    });
    const providerBaseUrl = baseUrl.replace("127.0.0.1", "intent-race-provider.test");
    await upsertNovelAnalysisProvider(root, { expectedRevision: 0, provider: provider(providerBaseUrl) });
    const created = await createNovelAnalysisTask(root, {
      expectedRevision: 0,
      providerId: "local-qwen",
      providerKind: "external",
    });
    let mutated = false;
    __setNovelAnalysisAddressResolverForTests(async () => {
      if (!mutated) {
        mutated = true;
        const store = await loadAdaptationStore(root);
        const task = store.analysisTasks.find((candidate) => candidate.id === created.task.id)!;
        task.taskJsonPath = path.join(outsideRoot, "task.json");
        task.taskMarkdownPath = path.join(outsideRoot, "任务说明.md");
        await saveAdaptationStore(root, store);
      }
      return [{ address: "127.0.0.1", family: 4 }];
    });

    await expect(executeNovelAnalysisTask(root, {
      taskId: created.task.id,
      providerId: "local-qwen",
      expectedRevision: created.workspace.revision,
    })).rejects.toMatchObject({ code: "NOVEL_ANALYSIS_PRE_DISPATCH_TASK_BINDING_FAILED" });
    expect(remotePostCount).toBe(0);
    const task = (await loadAdaptationStore(root)).analysisTasks.find((candidate) => candidate.id === created.task.id)!;
    expect(task.status).toBe("prepared");
    expect(task.execution).toBeUndefined();
  });

  it("预检后到 execution intent 前章节索引损坏仍归类为 library unavailable 且零 POST", async () => {
    const root = await fixture();
    process.env.AI_CANVAS_TEST_NOVEL_KEY = "intent-library-race-token";
    let remotePostCount = 0;
    const { baseUrl } = await listen(async (request, response) => {
      if (request.url === "/v1/chat/completions") remotePostCount += 1;
      for await (const _chunk of request) { /* drain */ }
      response.statusCode = 500;
      response.end("must-not-be-reached");
    });
    await upsertNovelAnalysisProvider(root, {
      expectedRevision: 0,
      provider: provider(baseUrl.replace("127.0.0.1", "intent-library-race.test")),
    });
    const created = await createNovelAnalysisTask(root, {
      expectedRevision: 0,
      providerId: "local-qwen",
      providerKind: "external",
    });
    let mutated = false;
    __setNovelAnalysisAddressResolverForTests(async () => {
      if (!mutated) {
        mutated = true;
        await writeFile(getSidecarPaths(root).storyIndex, "{broken-story-index", "utf8");
      }
      return [{ address: "127.0.0.1", family: 4 }];
    });

    await expect(executeNovelAnalysisTask(root, {
      taskId: created.task.id,
      providerId: "local-qwen",
      expectedRevision: created.workspace.revision,
    })).rejects.toMatchObject({ code: "NOVEL_ANALYSIS_PRE_DISPATCH_LIBRARY_UNAVAILABLE" });
    expect(remotePostCount).toBe(0);
    const task = (await loadAdaptationStore(root)).analysisTasks.find((candidate) => candidate.id === created.task.id)!;
    expect(task.status).toBe("prepared");
    expect(task.execution).toBeUndefined();
  });

  it("预检后到 execution intent 前章节正文消失仍归类为 chapter unavailable 且零 POST", async () => {
    const root = await fixture();
    process.env.AI_CANVAS_TEST_NOVEL_KEY = "intent-chapter-race-token";
    let remotePostCount = 0;
    const { baseUrl } = await listen(async (request, response) => {
      if (request.url === "/v1/chat/completions") remotePostCount += 1;
      for await (const _chunk of request) { /* drain */ }
      response.statusCode = 500;
      response.end("must-not-be-reached");
    });
    await upsertNovelAnalysisProvider(root, {
      expectedRevision: 0,
      provider: provider(baseUrl.replace("127.0.0.1", "intent-chapter-race.test")),
    });
    const created = await createNovelAnalysisTask(root, {
      expectedRevision: 0,
      providerId: "local-qwen",
      providerKind: "external",
    });
    let mutated = false;
    __setNovelAnalysisAddressResolverForTests(async () => {
      if (!mutated) {
        mutated = true;
        await rm(created.task.chapterRefs[0]!.path);
      }
      return [{ address: "127.0.0.1", family: 4 }];
    });

    await expect(executeNovelAnalysisTask(root, {
      taskId: created.task.id,
      providerId: "local-qwen",
      expectedRevision: created.workspace.revision,
    })).rejects.toMatchObject({ code: "NOVEL_ANALYSIS_PRE_DISPATCH_CHAPTER_UNAVAILABLE" });
    expect(remotePostCount).toBe(0);
    const task = (await loadAdaptationStore(root)).analysisTasks.find((candidate) => candidate.id === created.task.id)!;
    expect(task.status).toBe("prepared");
    expect(task.execution).toBeUndefined();
  });

  it("执行时只读取当前 StoryLibrary 绑定章节，拒绝 task 伪造的任意本机路径", async () => {
    const root = await fixture();
    const secretRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-model-provider-secret-"));
    roots.push(secretRoot);
    const secretText = "PRIVATE-LOCAL-FILE-MUST-NEVER-LEAVE-THIS-MAC";
    const secretPath = path.join(secretRoot, "private.txt");
    await writeFile(secretPath, secretText, "utf8");
    process.env.AI_CANVAS_TEST_NOVEL_KEY = "path-binding-test-token";
    let remotePostCount = 0;
    let observedBody = "";
    const { baseUrl } = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.statusCode = 404;
        response.end();
        return;
      }
      remotePostCount += 1;
      for await (const chunk of request) observedBody += chunk.toString();
      response.statusCode = 500;
      response.end("provider-test-failure");
    });
    await upsertNovelAnalysisProvider(root, { expectedRevision: 0, provider: provider(baseUrl) });
    const created = await createNovelAnalysisTask(root, {
      expectedRevision: 0,
      providerId: "local-qwen",
      providerKind: "external",
    });
    const store = await loadAdaptationStore(root);
    const task = store.analysisTasks.find((candidate) => candidate.id === created.task.id)!;
    task.chapterRefs[0] = {
      ...task.chapterRefs[0]!,
      path: secretPath,
      sha256: createHash("sha256").update(secretText, "utf8").digest("hex"),
    };
    await saveAdaptationStore(root, store);
    const taskContract = JSON.parse(await readFile(created.task.taskJsonPath, "utf8")) as { chapters: Array<Record<string, unknown>> };
    taskContract.chapters[0] = { ...taskContract.chapters[0], path: secretPath, sha256: task.chapterRefs[0].sha256 };
    await writeFile(created.task.taskJsonPath, `${JSON.stringify(taskContract, null, 2)}\n`, "utf8");

    await expect(executeNovelAnalysisTask(root, {
      taskId: task.id,
      providerId: "local-qwen",
      expectedRevision: store.revision,
    })).rejects.toMatchObject({ code: "NOVEL_ANALYSIS_PRE_DISPATCH_SOURCE_BINDING_FAILED" });

    expect(remotePostCount).toBe(0);
    expect(observedBody).not.toContain(secretText);
    const persisted = (await loadAdaptationStore(root)).analysisTasks.find((candidate) => candidate.id === task.id)!;
    expect(persisted.status).toBe("prepared");
    expect(persisted.execution).toBeUndefined();
  });

  it("提案只能写入任务 ID 派生的受管目录，拒绝 taskJsonPath 重定向", async () => {
    const root = await fixture();
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-model-provider-output-"));
    roots.push(outsideRoot);
    await upsertNovelAnalysisProvider(root, {
      expectedRevision: 0,
      provider: provider("https://example.com/v1", {
        id: "local-mock",
        name: "本地模拟",
        adapter: "mock",
        apiKeyEnv: undefined,
        allowPrivateNetwork: false,
        allowStoryUpload: false,
      }),
    });
    const created = await createNovelAnalysisTask(root, {
      expectedRevision: 0,
      providerId: "local-mock",
      providerKind: "external",
    });
    const store = await loadAdaptationStore(root);
    const task = store.analysisTasks.find((candidate) => candidate.id === created.task.id)!;
    task.taskJsonPath = path.join(outsideRoot, "task.json");
    task.taskMarkdownPath = path.join(outsideRoot, "任务说明.md");
    await saveAdaptationStore(root, store);

    await expect(executeNovelAnalysisTask(root, {
      taskId: task.id,
      providerId: "local-mock",
      expectedRevision: store.revision,
    })).rejects.toMatchObject({ code: "NOVEL_ANALYSIS_PRE_DISPATCH_TASK_BINDING_FAILED" });

    await expect(access(path.join(outsideRoot, "proposal.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const persisted = (await loadAdaptationStore(root)).analysisTasks.find((candidate) => candidate.id === task.id)!;
    expect(persisted.status).toBe("prepared");
    expect(persisted.execution).toBeUndefined();
  });

  it.each([
    {
      label: "章节正文读取失败",
      expectedCode: "NOVEL_ANALYSIS_PRE_DISPATCH_CHAPTER_UNAVAILABLE",
      corrupt: async (root: string, task: Awaited<ReturnType<typeof createNovelAnalysisTask>>["task"]) => {
        await rm(task.chapterRefs[0]!.path);
      },
    },
    {
      label: "章节索引读取失败",
      expectedCode: "NOVEL_ANALYSIS_PRE_DISPATCH_LIBRARY_UNAVAILABLE",
      corrupt: async (root: string) => {
        await writeFile(getSidecarPaths(root).storyIndex, `{"leak":"${root} 清晨，阿航穿着黑袍走进祭坛。"`, "utf8");
      },
    },
    {
      label: "改编工作区读取失败",
      expectedCode: "NOVEL_ANALYSIS_PRE_DISPATCH_STORE_UNAVAILABLE",
      corrupt: async (root: string) => {
        await writeFile(getSidecarPaths(root).storyAdaptation, `{"leak":"${root} 清晨，阿航穿着黑袍走进祭坛。"`, "utf8");
      },
    },
  ])("dispatch 前 $label 只投影稳定安全分类，且不写入绝对路径、正文或 token", async ({ expectedCode, corrupt }) => {
    const root = await fixture();
    const token = "pre-dispatch-token-must-not-persist";
    process.env.AI_CANVAS_TEST_NOVEL_KEY = token;
    await upsertNovelAnalysisProvider(root, {
      expectedRevision: 0,
      provider: provider("https://example.com/v1", { allowPrivateNetwork: false }),
    });
    const created = await createNovelAnalysisTask(root, {
      expectedRevision: 0,
      providerId: "local-qwen",
      providerKind: "external",
    });
    await corrupt(root, created.task);
    const eventsBefore = await readFile(getSidecarPaths(root).events, "utf8");
    const request = {
      command: "execute_novel_analysis_task" as const,
      payload: { taskId: created.task.id, providerId: "local-qwen", expectedRevision: created.workspace.revision },
    };

    const failure = await executeIdempotentCommand(root, {
      requestId: `pre-dispatch-${expectedCode.slice(-12).toLowerCase()}`,
      idempotencyKey: `pre-dispatch-${expectedCode.slice(-12).toLowerCase()}-key`,
      request,
    }).then(
      () => { throw new Error("预期执行被安全拒绝"); },
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: expectedCode });
    const failureText = String(failure instanceof Error ? failure.message : failure);
    expect(failureText).not.toContain(root);
    expect(failureText).not.toContain("清晨，阿航穿着黑袍走进祭坛。");
    expect(failureText).not.toContain(token);
    const workspace = await loadAdaptationStore(root).catch(() => undefined);
    if (workspace) {
      const persistedTask = workspace.analysisTasks.find((task) => task.id === created.task.id);
      expect(persistedTask?.status).toBe("prepared");
      expect(persistedTask?.execution).toBeUndefined();
    }
    const ledger = await listCommandLedgerEntries(root, 20);
    const entry = ledger.find((candidate) => candidate.idempotencyKey === `pre-dispatch-${expectedCode.slice(-12).toLowerCase()}-key`)!;
    expect(entry).toMatchObject({ status: "failed", error: { message: expect.stringContaining(expectedCode) } });
    const persisted = JSON.stringify(entry);
    const newEvents = (await readFile(getSidecarPaths(root).events, "utf8")).slice(eventsBefore.length);
    for (const text of [persisted, newEvents]) {
      expect(text).not.toContain(root);
      expect(text).not.toContain("清晨，阿航穿着黑袍走进祭坛。");
      expect(text).not.toContain(token);
    }
  });

  it("intent 已落盘但 started event 失败时只写 unknown 安全投影，且不自动重提", async () => {
    const root = await fixture();
    const token = "intent-window-token-must-not-persist";
    const privateStory = "清晨，阿航穿着黑袍走进祭坛。";
    await upsertNovelAnalysisProvider(root, {
      expectedRevision: 0,
      provider: provider("https://example.com/v1", {
        id: "local-mock",
        name: "本地模拟",
        adapter: "mock",
        apiKeyEnv: undefined,
        allowPrivateNetwork: false,
        allowStoryUpload: false,
      }),
    });
    const created = await createNovelAnalysisTask(root, {
      expectedRevision: 0,
      providerId: "local-mock",
      providerKind: "external",
    });
    const eventsBefore = await readFile(getSidecarPaths(root).events, "utf8");
    __setNovelAnalysisExecutionIntentHookForTests(() => {
      throw new Error(`intent event failure ${root} ${token} ${privateStory}`);
    });
    const request = {
      command: "execute_novel_analysis_task" as const,
      payload: { taskId: created.task.id, providerId: "local-mock", expectedRevision: created.workspace.revision },
    };
    const failure = await executeIdempotentCommand(root, {
      requestId: "intent-window-request-0001",
      idempotencyKey: "intent-window-command-key-0001",
      request,
    }).then(
      () => { throw new Error("预期 intent 窗口被安全锁定"); },
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: "NOVEL_ANALYSIS_EXECUTION_STATE_UNAVAILABLE", phase: "post_intent" });
    const ledger = await listCommandLedgerEntries(root, 20);
    expect(ledger.find((entry) => entry.idempotencyKey === "intent-window-command-key-0001")).toMatchObject({
      status: "unknown",
      error: { message: expect.stringContaining("NOVEL_ANALYSIS_EXECUTION_STATE_UNAVAILABLE") },
    });
    const persistedTask = (await loadAdaptationStore(root)).analysisTasks.find((task) => task.id === created.task.id)!;
    expect(persistedTask).toMatchObject({ status: "executing", execution: { dispatchCheckpoint: "intent_persisted" } });
    const newEvents = (await readFile(getSidecarPaths(root).events, "utf8")).slice(eventsBefore.length);
    for (const text of [String(failure instanceof Error ? failure.message : failure), JSON.stringify(ledger), newEvents]) {
      expect(text).not.toContain(root);
      expect(text).not.toContain(token);
      expect(text).not.toContain(privateStory);
      expect(text).not.toContain("intent event failure");
    }
  });

  it("批次执行前进度读取失败时保持 prepared，且只写 pre_dispatch 安全投影", async () => {
    const root = await fixture();
    const token = "run-progress-before-token-must-not-persist";
    const privateStory = "清晨，阿航穿着黑袍走进祭坛。";
    await upsertNovelAnalysisProvider(root, {
      expectedRevision: 0,
      provider: provider("https://example.com/v1", {
        id: "local-mock",
        name: "本地模拟",
        adapter: "mock",
        apiKeyEnv: undefined,
        allowPrivateNetwork: false,
        allowStoryUpload: false,
      }),
    });
    const planned = await planNovelAnalysisRun(root, { expectedRevision: 0, providerId: "local-mock" });
    const eventsBefore = await readFile(getSidecarPaths(root).events, "utf8");
    __setNovelAnalysisRunProgressHookForTests((phase) => {
      if (phase === "before_execute") throw new Error(`progress before failure ${root} ${token} ${privateStory}`);
    });
    const request = {
      command: "execute_next_novel_analysis_run_task" as const,
      payload: { runId: planned.runId, expectedRevision: planned.workspace.revision },
    };
    const failure = await executeIdempotentCommand(root, {
      requestId: "run-progress-before-request-0001",
      idempotencyKey: "run-progress-before-command-key-0001",
      request,
    }).then(
      () => { throw new Error("预期进度读取被安全拒绝"); },
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: "NOVEL_ANALYSIS_PRE_DISPATCH_RUN_PROGRESS_UNAVAILABLE", phase: "pre_dispatch" });
    const persistedTask = (await loadAdaptationStore(root)).analysisTasks.find((task) => task.id === planned.tasks[0]!.id)!;
    expect(persistedTask.status).toBe("prepared");
    expect(persistedTask.execution).toBeUndefined();
    const ledger = await listCommandLedgerEntries(root, 20);
    expect(ledger.find((entry) => entry.idempotencyKey === "run-progress-before-command-key-0001")).toMatchObject({ status: "failed" });
    const newEvents = (await readFile(getSidecarPaths(root).events, "utf8")).slice(eventsBefore.length);
    for (const text of [String(failure instanceof Error ? failure.message : failure), JSON.stringify(ledger), newEvents]) {
      expect(text).not.toContain(root);
      expect(text).not.toContain(token);
      expect(text).not.toContain(privateStory);
      expect(text).not.toContain("progress before failure");
    }
  });

  it("批次已提交后进度读取失败时保留 reviewing 事实，仅写已提交态安全错误", async () => {
    const root = await fixture();
    const token = "run-progress-after-token-must-not-persist";
    const privateStory = "清晨，阿航穿着黑袍走进祭坛。";
    await upsertNovelAnalysisProvider(root, {
      expectedRevision: 0,
      provider: provider("https://example.com/v1", {
        id: "local-mock",
        name: "本地模拟",
        adapter: "mock",
        apiKeyEnv: undefined,
        allowPrivateNetwork: false,
        allowStoryUpload: false,
      }),
    });
    const planned = await planNovelAnalysisRun(root, { expectedRevision: 0, providerId: "local-mock" });
    const eventsBefore = await readFile(getSidecarPaths(root).events, "utf8");
    __setNovelAnalysisRunProgressHookForTests((phase) => {
      if (phase === "after_execute") throw new Error(`progress after failure ${root} ${token} ${privateStory}`);
    });
    const request = {
      command: "execute_next_novel_analysis_run_task" as const,
      payload: { runId: planned.runId, expectedRevision: planned.workspace.revision },
    };
    const failure = await executeIdempotentCommand(root, {
      requestId: "run-progress-after-request-0001",
      idempotencyKey: "run-progress-after-command-key-0001",
      request,
    }).then(
      () => { throw new Error("预期已提交结果的进度读取被安全锁定"); },
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: "NOVEL_ANALYSIS_RESULT_COMMITTED", phase: "post_dispatch" });
    const persistedTask = (await loadAdaptationStore(root)).analysisTasks.find((task) => task.id === planned.tasks[0]!.id)!;
    expect(persistedTask).toMatchObject({ status: "reviewing", execution: { status: "succeeded" } });
    const ledger = await listCommandLedgerEntries(root, 20);
    expect(ledger.find((entry) => entry.idempotencyKey === "run-progress-after-command-key-0001")).toMatchObject({ status: "unknown" });
    const newEvents = (await readFile(getSidecarPaths(root).events, "utf8")).slice(eventsBefore.length);
    for (const text of [String(failure instanceof Error ? failure.message : failure), JSON.stringify(ledger), newEvents]) {
      expect(text).not.toContain(root);
      expect(text).not.toContain(token);
      expect(text).not.toContain(privateStory);
      expect(text).not.toContain("progress after failure");
    }
  });

  it("真实调用兼容服务后只创建人工复核项，并保留可对账提案", async () => {
    const root = await fixture();
    process.env.AI_CANVAS_TEST_NOVEL_KEY = "test-bearer";
    let task: Awaited<ReturnType<typeof createNovelAnalysisTask>>["task"] | undefined;
    let observedAuthorization = "";
    let observedBody = "";
    const { baseUrl } = await listen(async (request, response) => {
      observedAuthorization = String(request.headers.authorization ?? "");
      if (request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "qwen-test" }] }));
        return;
      }
      for await (const chunk of request) observedBody += chunk.toString();
      const chapter = task!.chapterRefs[0]!;
      const content = await readFile(chapter.path, "utf8");
      const evidence = "清晨，阿航穿着黑袍走进祭坛。";
      const startOffset = content.indexOf(evidence);
      const span = { sourceId: chapter.sourceId, chapterId: chapter.chapterId, chapterRevision: chapter.revision, chapterSha256: chapter.sha256, startOffset, endOffset: startOffset + evidence.length, text: evidence };
      const proposal = { facts: [{ id: "fact-1", kind: "event", epistemicStatus: "confirmed", statement: evidence, sourceSpans: [span], tags: ["模型提案"] }], beats: [{ id: "beat-1", order: 1, title: "走进祭坛", summary: evidence, narrativePurpose: "建立人物与空间", visualAction: "阿航走进祭坛", emotionalShift: "平静转警觉", mustKeep: [evidence], estimatedDurationSeconds: 4, factIds: ["fact-1"], sourceSpans: [span], intensity: 2 }] };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "chatcmpl-test", model: "qwen-test", choices: [{ message: { content: JSON.stringify(proposal) } }], usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 } }));
    });
    await upsertNovelAnalysisProvider(root, { expectedRevision: 0, provider: provider(baseUrl), setAsDefault: true });
    const probe = await probeNovelAnalysisProvider(root, "local-qwen");
    expect(probe.ok).toBe(true);
    expect(probe.models).toEqual(["qwen-test"]);
    const created = await createNovelAnalysisTask(root, { expectedRevision: 0, providerId: "local-qwen", providerKind: "external" });
    task = created.task;
    const result = await executeNovelAnalysisTask(root, { taskId: task.id, providerId: "local-qwen", expectedRevision: created.workspace.revision });
    expect(result.outcome).toBe("reviewing");
    expect(result.reviewCount).toBe(2);
    expect(result.workspace.facts).toEqual([]);
    expect(result.workspace.beats).toEqual([]);
    expect(result.workspace.analysisReviews.every((review) => review.status === "pending" && review.evidenceIssues.length === 0)).toBe(true);
    expect(result.task.execution).toMatchObject({ status: "succeeded", responseId: "chatcmpl-test", responseModel: "qwen-test", usage: { totalTokens: 200 } });
    expect(observedAuthorization).toBe("Bearer test-bearer");
    expect(observedBody).toContain("清晨，阿航穿着黑袍走进祭坛");
    expect(observedBody).not.toContain(root);
    await expect(access(result.task.execution!.proposalPath!)).resolves.toBeUndefined();
    await expect(executeNovelAnalysisTask(root, { taskId: task.id, providerId: "local-qwen", expectedRevision: result.workspace.revision })).rejects.toThrow("禁止自动重提");
  });

  it("服务已接收但连接中断时锁定为 submission_unknown", async () => {
    const root = await fixture();
    process.env.AI_CANVAS_TEST_NOVEL_KEY = "test-bearer";
    const { baseUrl } = await listen((request) => { if (request.url === "/v1/chat/completions") request.socket.destroy(); });
    await upsertNovelAnalysisProvider(root, { expectedRevision: 0, provider: provider(baseUrl) });
    const created = await planNovelAnalysisRun(root, { expectedRevision: 0, providerId: "local-qwen", targetCharacters: 24_000 });
    const result = await executeNextNovelAnalysisRunTask(root, { runId: created.runId, expectedRevision: created.workspace.revision });
    expect(result.outcome).toBe("submission_unknown");
    expect(result.task.status).toBe("submission_unknown");
    expect(result.task.execution?.error).toBeTruthy();
    expect(await getNovelAnalysisRunProgress(root, created.runId)).toMatchObject({ status: "blocked", unknownBatches: 1, nextTaskId: undefined });
    await expect(executeNextNovelAnalysisRunTask(root, { runId: created.runId, expectedRevision: result.workspace.revision })).rejects.toThrow("回执不明");
    await expect(replaceNovelAnalysisRunTask(root, { runId: created.runId, batchIndex: 1, expectedRevision: result.workspace.revision, reason: "准备重新执行" })).rejects.toThrow("确认远端无可回收结果");
    const replacement = await replaceNovelAnalysisRunTask(root, { runId: created.runId, batchIndex: 1, expectedRevision: result.workspace.revision, reason: "已核对测试服务，确认连接中断未产生结果", confirmNoRemoteResult: true });
    expect(replacement.task).toMatchObject({ status: "prepared", attempt: 2, supersedesTaskId: result.task.id });
    expect(replacement.replacedTask).toMatchObject({ id: result.task.id, replacedByTaskId: replacement.task.id, status: "submission_unknown" });
    expect(replacement.progress).toMatchObject({ status: "ready", unknownBatches: 0, nextTaskId: replacement.task.id, totalBatches: 1 });
    await expect(access(replacement.task.taskJsonPath)).resolves.toBeUndefined();
  });

  it.each([
    { label: "HTTP 500 回显敏感内容", status: 500, body: "Authorization: Bearer test-bearer\nsecret-story", contentType: "text/plain" },
    { label: "2xx 非法 JSON", status: 200, body: "not-json", contentType: "application/json" },
  ])("POST 已发出后遇到 $label 时锁定为 submission_unknown，禁止无确认重发", async ({ status, body, contentType }) => {
    const root = await fixture();
    process.env.AI_CANVAS_TEST_NOVEL_KEY = "test-bearer";
    let remotePostCount = 0;
    const { baseUrl } = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.statusCode = 404;
        response.end();
        return;
      }
      for await (const _chunk of request) {
        // 完整接收请求体，证明远端已经拿到这次 POST。
      }
      remotePostCount += 1;
      response.statusCode = status;
      response.setHeader("content-type", contentType);
      response.end(body);
    });
    await upsertNovelAnalysisProvider(root, { expectedRevision: 0, provider: provider(baseUrl) });
    const created = await planNovelAnalysisRun(root, {
      expectedRevision: 0,
      providerId: "local-qwen",
      targetCharacters: 24_000,
    });
    const result = await executeNextNovelAnalysisRunTask(root, {
      runId: created.runId,
      expectedRevision: created.workspace.revision,
    });

    expect(remotePostCount).toBe(1);
    expect(result).toMatchObject({
      outcome: "submission_unknown",
      task: {
        status: "submission_unknown",
        execution: { status: "submission_unknown", dispatchCheckpoint: "request_dispatched" },
      },
    });
    expect(JSON.stringify(result.task)).not.toContain("test-bearer");
    expect(JSON.stringify(result.task)).not.toContain("secret-story");
    await expect(replaceNovelAnalysisRunTask(root, {
      runId: created.runId,
      batchIndex: 1,
      expectedRevision: result.workspace.revision,
      reason: "未完成远端对账，不得重发",
    })).rejects.toThrow("确认远端无可回收结果");
    expect(remotePostCount).toBe(1);
  });

  it("POST 后 markExecution 的二次失败只保留 submission_unknown，且不投影内部异常", async () => {
    const root = await fixture();
    const token = "mark-execution-token-must-not-persist";
    const privateStory = "清晨，阿航穿着黑袍走进祭坛。";
    process.env.AI_CANVAS_TEST_NOVEL_KEY = token;
    let remotePostCount = 0;
    const { baseUrl } = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.statusCode = 404;
        response.end();
        return;
      }
      for await (const _chunk of request) { /* drain request body */ }
      remotePostCount += 1;
      response.statusCode = 500;
      response.end(`Authorization: Bearer ${token}\n${privateStory}`);
    });
    await upsertNovelAnalysisProvider(root, { expectedRevision: 0, provider: provider(baseUrl) });
    const created = await planNovelAnalysisRun(root, { expectedRevision: 0, providerId: "local-qwen" });
    const eventsBefore = await readFile(getSidecarPaths(root).events, "utf8");
    let injected = false;
    __setNovelAnalysisMarkExecutionHookForTests((phase) => {
      if (phase === "before_persist" && !injected) {
        injected = true;
        throw new Error(`internal mark failure ${root} ${token} ${privateStory}`);
      }
    });

    const result = await executeNextNovelAnalysisRunTask(root, {
      runId: created.runId,
      expectedRevision: created.workspace.revision,
    });

    expect(remotePostCount).toBe(1);
    expect(result).toMatchObject({
      outcome: "submission_unknown",
      task: { status: "submission_unknown", execution: { status: "submission_unknown", dispatchCheckpoint: "request_dispatched" } },
    });
    const newEvents = (await readFile(getSidecarPaths(root).events, "utf8")).slice(eventsBefore.length);
    for (const text of [result.task.execution?.error ?? "", newEvents]) {
      expect(text).not.toContain(root);
      expect(text).not.toContain(token);
      expect(text).not.toContain(privateStory);
      expect(text).not.toContain("internal mark failure");
    }
  });

  it("POST 已发出且响应外壳合法、但业务提案契约无效时仍锁定为 submission_unknown", async () => {
    const root = await fixture();
    process.env.AI_CANVAS_TEST_NOVEL_KEY = "test-bearer";
    let remotePostCount = 0;
    const { baseUrl } = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.statusCode = 404;
        response.end();
        return;
      }
      for await (const _chunk of request) {
        // 完整接收 POST，证明响应契约错误发生在远端已经可能创建结果之后。
      }
      remotePostCount += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: "chatcmpl-invalid-proposal",
        model: "qwen-test",
        choices: [{ message: { content: JSON.stringify({ facts: "not-an-array", beats: [] }) } }],
      }));
    });
    await upsertNovelAnalysisProvider(root, { expectedRevision: 0, provider: provider(baseUrl) });
    const created = await planNovelAnalysisRun(root, {
      expectedRevision: 0,
      providerId: "local-qwen",
      targetCharacters: 24_000,
    });
    const result = await executeNextNovelAnalysisRunTask(root, {
      runId: created.runId,
      expectedRevision: created.workspace.revision,
    });

    expect(remotePostCount).toBe(1);
    expect(result).toMatchObject({
      outcome: "submission_unknown",
      task: {
        status: "submission_unknown",
        execution: { status: "submission_unknown", dispatchCheckpoint: "request_dispatched" },
      },
    });
    expect(result.task.execution?.error).toContain("内部错误细节未写入项目");
    expect(result.task.execution?.error).not.toContain(root);
    expect(result.task.execution?.error).not.toContain("proposal.json");
    await expect(replaceNovelAnalysisRunTask(root, {
      runId: created.runId,
      batchIndex: 1,
      expectedRevision: result.workspace.revision,
      reason: "业务提案无效但远端结果仍需对账",
    })).rejects.toThrow("确认远端无可回收结果");
    expect(remotePostCount).toBe(1);
  });

  it("POST 已返回有效提案但本地 proposal 持久化失败时仍锁定为 submission_unknown", async () => {
    const root = await fixture();
    process.env.AI_CANVAS_TEST_NOVEL_KEY = "test-bearer";
    let remotePostCount = 0;
    let proposal: unknown;
    const { baseUrl } = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.statusCode = 404;
        response.end();
        return;
      }
      for await (const _chunk of request) {
        // 完整接收 POST，证明本地落盘失败发生在远端已经返回有效结果之后。
      }
      remotePostCount += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: "chatcmpl-local-persist-failure",
        model: "qwen-test",
        choices: [{ message: { content: JSON.stringify(proposal) } }],
      }));
    });
    await upsertNovelAnalysisProvider(root, { expectedRevision: 0, provider: provider(baseUrl) });
    const created = await planNovelAnalysisRun(root, {
      expectedRevision: 0,
      providerId: "local-qwen",
      targetCharacters: 24_000,
    });
    const chapter = created.tasks[0]!.chapterRefs[0]!;
    const content = await readFile(chapter.path, "utf8");
    const evidence = "清晨，阿航穿着黑袍走进祭坛。";
    const startOffset = content.indexOf(evidence);
    proposal = {
      facts: [{
        id: "fact-local-persist-failure",
        kind: "event",
        epistemicStatus: "confirmed",
        statement: evidence,
        sourceSpans: [{
          sourceId: chapter.sourceId,
          chapterId: chapter.chapterId,
          chapterRevision: chapter.revision,
          chapterSha256: chapter.sha256,
          startOffset,
          endOffset: startOffset + evidence.length,
          text: evidence,
        }],
        tags: ["本地持久化失败夹具"],
      }],
      beats: [],
    };
    const proposalPath = path.join(path.dirname(created.tasks[0]!.taskJsonPath), "proposal.json");
    await mkdir(proposalPath);

    const result = await executeNextNovelAnalysisRunTask(root, {
      runId: created.runId,
      expectedRevision: created.workspace.revision,
    });

    expect(remotePostCount).toBe(1);
    expect(result).toMatchObject({
      outcome: "submission_unknown",
      task: {
        status: "submission_unknown",
        execution: { status: "submission_unknown", dispatchCheckpoint: "request_dispatched" },
      },
    });
    expect(result.task.execution?.error).toContain("内部错误细节未写入项目");
    expect(result.task.execution?.error).not.toContain(root);
    expect(result.task.execution?.error).not.toContain("proposal.json");
    await expect(replaceNovelAnalysisRunTask(root, {
      runId: created.runId,
      batchIndex: 1,
      expectedRevision: result.workspace.revision,
      reason: "本地 proposal 未可靠提交，必须先远端对账",
    })).rejects.toThrow("确认远端无可回收结果");
    await expect(executeNextNovelAnalysisRunTask(root, {
      runId: created.runId,
      expectedRevision: result.workspace.revision,
    })).rejects.toThrow("回执不明");
    expect(remotePostCount).toBe(1);
  });

  it("dispatch 前崩溃过期后只进入人工对账，not_found 后才允许显式 replacement", async () => {
    const root = await fixture();
    await upsertNovelAnalysisProvider(root, {
      expectedRevision: 0,
      provider: provider("https://example.com/v1", {
        id: "local-mock",
        name: "本地模拟",
        adapter: "mock",
        apiKeyEnv: undefined,
        allowPrivateNetwork: false,
        allowStoryUpload: false,
      }),
    });
    const created = await planNovelAnalysisRun(root, { expectedRevision: 0, providerId: "local-mock" });
    process.env.AI_CANVAS_TEST_NOVEL_ANALYSIS_INTERRUPT = "after-execution-started";
    await expect(executeNextNovelAnalysisRunTask(root, {
      runId: created.runId,
      expectedRevision: created.workspace.revision,
    })).rejects.toThrow(/test-only novel analysis interruption/u);
    delete process.env.AI_CANVAS_TEST_NOVEL_ANALYSIS_INTERRUPT;

    const crashedStore = await loadAdaptationStore(root);
    const crashedTask = crashedStore.analysisTasks.find((task) => task.runId === created.runId)!;
    expect(crashedTask).toMatchObject({
      status: "executing",
      execution: { status: "submitting", dispatchCheckpoint: "intent_persisted", fence: 2 },
    });
    expect(await getNovelAnalysisExecutionRecoveryStatus(root)).toMatchObject({ healthy: true, candidates: [] });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.parse(crashedTask.execution!.leaseUntil!) + 1));
    const recovery = await getNovelAnalysisExecutionRecoveryStatus(root);
    expect(recovery).toMatchObject({
      healthy: false,
      workspaceRevision: crashedStore.revision,
      candidates: [{
        taskId: crashedTask.id,
        taskRevision: crashedTask.revision,
        executionId: crashedTask.execution!.id,
        executionFence: crashedTask.execution!.fence,
        dispatchCheckpoint: "intent_persisted",
        expired: true,
      }],
    });
    expect(await getNovelAnalysisRunProgress(root, created.runId)).toMatchObject({
      status: "blocked",
      executingBatches: 0,
      reconciliationRequiredBatches: 1,
      nextTaskId: undefined,
    });

    const candidate = recovery.candidates[0]!;
    const marked = await markNovelAnalysisExecutionReconciliationRequired(root, {
      taskId: candidate.taskId,
      executionId: candidate.executionId,
      expectedRevision: recovery.workspaceRevision,
      expectedTaskRevision: candidate.taskRevision,
      expectedExecutionFence: candidate.executionFence,
      expectedLeaseUntil: candidate.leaseUntil,
      note: "应用重启后发现执行租约已过期",
    });
    expect(marked.task).toMatchObject({
      status: "reconciliation_required",
      execution: { status: "reconciliation_required", fence: candidate.executionFence + 1 },
    });
    await expect(submitNovelAnalysisProposal(root, {
      taskId: marked.task.id,
      expectedRevision: marked.workspace.revision,
      executionId: marked.task.execution!.id,
      expectedExecutionFence: candidate.executionFence,
      facts: [],
      beats: [],
    })).rejects.toThrow(/不能静默覆盖|fence/u);

    const reconciled = await reconcileNovelAnalysisExecution(root, {
      taskId: marked.task.id,
      executionId: marked.task.execution!.id,
      expectedRevision: marked.workspace.revision,
      expectedTaskRevision: marked.task.revision,
      expectedExecutionFence: marked.task.execution!.fence!,
      result: "not_found",
      evidenceReference: "provider-audit:no-task-for-request-hash",
      note: "已按 request hash 核对供应商任务列表，确认无结果",
    });
    expect(reconciled.task).toMatchObject({
      status: "submission_unknown",
      execution: { status: "submission_unknown", reconciliation: { status: "not_found" } },
    });
    await expect(replaceNovelAnalysisRunTask(root, {
      runId: created.runId,
      batchIndex: 1,
      expectedRevision: reconciled.workspace.revision,
      reason: "准备替换过期执行",
    })).rejects.toThrow(/确认远端无可回收结果/u);
    const replacement = await replaceNovelAnalysisRunTask(root, {
      runId: created.runId,
      batchIndex: 1,
      expectedRevision: reconciled.workspace.revision,
      reason: "远端无结果证据已完成核验",
      confirmNoRemoteResult: true,
    });
    expect(replacement.task).toMatchObject({ status: "prepared", attempt: 2, supersedesTaskId: crashedTask.id });
  });

  it("POST 已到服务端后人工对账推进 fence，迟到 worker 不能覆盖", async () => {
    const root = await fixture();
    process.env.AI_CANVAS_TEST_NOVEL_KEY = "test-bearer";
    let postCount = 0;
    let receivedResolve!: () => void;
    const received = new Promise<void>((resolve) => { receivedResolve = resolve; });
    let activeRequest: IncomingMessage | undefined;
    const { baseUrl } = await listen(async (request) => {
      if (request.url !== "/v1/chat/completions") return;
      postCount += 1;
      activeRequest = request;
      for await (const _chunk of request) { /* drain request body */ }
      receivedResolve();
    });
    await upsertNovelAnalysisProvider(root, { expectedRevision: 0, provider: provider(baseUrl) });
    const created = await planNovelAnalysisRun(root, { expectedRevision: 0, providerId: "local-qwen" });
    const worker = executeNextNovelAnalysisRunTask(root, { runId: created.runId, expectedRevision: created.workspace.revision });
    await received;
    expect(postCount).toBe(1);

    const executingStore = await loadAdaptationStore(root);
    const executingTask = executingStore.analysisTasks.find((task) => task.runId === created.runId)!;
    expect(executingTask.execution?.dispatchCheckpoint).toBe("request_dispatched");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.parse(executingTask.execution!.leaseUntil!) + 1));
    const recovery = await getNovelAnalysisExecutionRecoveryStatus(root);
    const candidate = recovery.candidates[0]!;
    const marked = await markNovelAnalysisExecutionReconciliationRequired(root, {
      taskId: candidate.taskId,
      executionId: candidate.executionId,
      expectedRevision: recovery.workspaceRevision,
      expectedTaskRevision: candidate.taskRevision,
      expectedExecutionFence: candidate.executionFence,
      expectedLeaseUntil: candidate.leaseUntil,
      note: "HTTP 请求已发出但 worker 租约过期",
    });
    const reconciled = await reconcileNovelAnalysisExecution(root, {
      taskId: marked.task.id,
      executionId: marked.task.execution!.id,
      expectedRevision: marked.workspace.revision,
      expectedTaskRevision: marked.task.revision,
      expectedExecutionFence: marked.task.execution!.fence!,
      result: "not_found",
      evidenceReference: "provider-audit:request-received-no-result",
      note: "供应商测试端确认请求未生成可回收结果",
    });
    const reconciledFence = reconciled.task.execution!.fence;
    activeRequest!.socket.destroy();
    await worker;
    const afterLateWorker = await loadAdaptationStore(root);
    const finalTask = afterLateWorker.analysisTasks.find((task) => task.id === reconciled.task.id)!;
    expect(finalTask).toMatchObject({
      status: "submission_unknown",
      execution: { fence: reconciledFence, reconciliation: { status: "not_found" } },
    });
    expect(postCount).toBe(1);
  });

  it("响应已持久化后崩溃可按 found 回收 proposal，全程不再 POST", async () => {
    const root = await fixture();
    process.env.AI_CANVAS_TEST_NOVEL_KEY = "test-bearer";
    let postCount = 0;
    let plannedTask: Awaited<ReturnType<typeof planNovelAnalysisRun>>["tasks"][number] | undefined;
    const { baseUrl } = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") return;
      postCount += 1;
      for await (const _chunk of request) { /* drain request body */ }
      const chapter = plannedTask!.chapterRefs[0]!;
      const content = await readFile(chapter.path, "utf8");
      const evidence = "清晨，阿航穿着黑袍走进祭坛。";
      const startOffset = content.indexOf(evidence);
      const span = { sourceId: chapter.sourceId, chapterId: chapter.chapterId, chapterRevision: chapter.revision, chapterSha256: chapter.sha256, startOffset, endOffset: startOffset + evidence.length, text: evidence };
      const proposal = {
        facts: [{ id: "recovered-fact", kind: "event", epistemicStatus: "confirmed", statement: evidence, sourceSpans: [span], tags: ["恢复提案"] }],
        beats: [{ id: "recovered-beat", order: 1, title: "恢复响应", summary: evidence, narrativePurpose: "验证恢复", visualAction: evidence, emotionalShift: "平静转警觉", mustKeep: [evidence], estimatedDurationSeconds: 4, factIds: ["recovered-fact"], sourceSpans: [span], intensity: 2 }],
      };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "chatcmpl-recovered", model: "qwen-test", choices: [{ message: { content: JSON.stringify(proposal) } }] }));
    });
    await upsertNovelAnalysisProvider(root, { expectedRevision: 0, provider: provider(baseUrl) });
    const created = await planNovelAnalysisRun(root, { expectedRevision: 0, providerId: "local-qwen" });
    plannedTask = created.tasks[0]!;
    process.env.AI_CANVAS_TEST_NOVEL_ANALYSIS_INTERRUPT = "after-response-persisted";
    await expect(executeNextNovelAnalysisRunTask(root, {
      runId: created.runId,
      expectedRevision: created.workspace.revision,
    })).rejects.toThrow(/test-only novel analysis interruption/u);
    delete process.env.AI_CANVAS_TEST_NOVEL_ANALYSIS_INTERRUPT;
    expect(postCount).toBe(1);

    const crashedStore = await loadAdaptationStore(root);
    const crashedTask = crashedStore.analysisTasks.find((task) => task.runId === created.runId)!;
    expect(crashedTask).toMatchObject({
      status: "executing",
      execution: { status: "response_persisted", dispatchCheckpoint: "response_persisted", responseId: "chatcmpl-recovered" },
    });
    await expect(access(crashedTask.execution!.proposalPath!)).resolves.toBeUndefined();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.parse(crashedTask.execution!.leaseUntil!) + 1));
    const recovery = await getNovelAnalysisExecutionRecoveryStatus(root);
    const candidate = recovery.candidates[0]!;
    const marked = await markNovelAnalysisExecutionReconciliationRequired(root, {
      taskId: candidate.taskId,
      executionId: candidate.executionId,
      expectedRevision: recovery.workspaceRevision,
      expectedTaskRevision: candidate.taskRevision,
      expectedExecutionFence: candidate.executionFence,
      expectedLeaseUntil: candidate.leaseUntil,
      note: "响应已落本地 proposal，但提交 review 前崩溃",
    });
    const reconciled = await reconcileNovelAnalysisExecution(root, {
      taskId: marked.task.id,
      executionId: marked.task.execution!.id,
      expectedRevision: marked.workspace.revision,
      expectedTaskRevision: marked.task.revision,
      expectedExecutionFence: marked.task.execution!.fence!,
      result: "found",
      evidenceReference: `local-proposal-sha256:${marked.task.execution!.proposalSha256}`,
      note: "本地 proposal SHA 与 execution 回执一致，采用回收结果",
    });
    expect(reconciled.task).toMatchObject({
      status: "reconciliation_required",
      execution: { status: "response_recovered", reconciliation: { status: "found" } },
    });
    const proposal = JSON.parse(await readFile(reconciled.task.execution!.proposalPath!, "utf8")) as Pick<Parameters<typeof submitNovelAnalysisProposal>[1], "facts" | "beats">;
    await expect(submitNovelAnalysisProposal(root, {
      taskId: reconciled.task.id,
      expectedRevision: reconciled.workspace.revision,
      executionId: reconciled.task.execution!.id,
      expectedExecutionFence: candidate.executionFence,
      ...proposal,
    })).rejects.toThrow(/fence/u);
    const submitted = await submitNovelAnalysisProposal(root, {
      taskId: reconciled.task.id,
      expectedRevision: reconciled.workspace.revision,
      executionId: reconciled.task.execution!.id,
      expectedExecutionFence: reconciled.task.execution!.fence,
      ...proposal,
    });
    expect(submitted.task.status).toBe("reviewing");
    expect(await getNovelAnalysisExecutionRecoveryStatus(root)).toMatchObject({ healthy: true, candidates: [] });
    expect(postCount).toBe(1);
  });
});
