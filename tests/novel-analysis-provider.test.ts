import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitProjectImport, prepareProjectImport } from "../src/core/importer.js";
import { createNovelAnalysisTask } from "../src/core/novel-analysis.js";
import { executeNextNovelAnalysisRunTask, executeNovelAnalysisTask, getNovelAnalysisProviderSettings, getNovelAnalysisRunProgress, planNovelAnalysisRun, probeNovelAnalysisProvider, replaceNovelAnalysisRunTask, upsertNovelAnalysisProvider } from "../src/core/novel-analysis-provider.js";
import { getSidecarPaths } from "../src/core/sidecar.js";
import { importStoryFile } from "../src/core/story.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_NOVEL_KEY;
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
});
