import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { EXPECTED_MCP_TOOL_COUNT } from "./helpers/mcp-tool-count.js";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true }))));

describe("应用关闭时的 stdio MCP 生产闭环", () => {
  it("仅通过真实 MCP 完成任务、视频、验收、剪辑、续接、Resources 与 Prompts", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const root = path.join(os.tmpdir(), `ai-canvas-mcp-headless-test-${suffix}`);
    const registry = path.join(os.tmpdir(), `ai-canvas-mcp-headless-registry-${suffix}.json`);
    cleanup.push(root, registry);
    const executable = path.join(process.cwd(), "node_modules", ".bin", "tsx");
    const { stdout } = await execFileAsync(executable, ["scripts/mcp-headless-workflow-smoke.ts", root, registry], { cwd: process.cwd(), env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registry }, maxBuffer: 4_000_000 });
    const result = JSON.parse(stdout) as {
      transport: string;
      desktopUiLaunched: boolean;
      toolCount: number;
      resourceReads: number;
      promptReads: number;
      task: { id: string; replayedId: string; finalItemStatus: string };
      generation: { status: string; publicationReceiptId: string };
      generationProvider: { id: string; settingsRevision: number };
      editor: { clips: number; timebase: { rateNumerator: number; rateDenominator: number }; renderStatus: string; renderPath: string };
      continuation: { status: string; outputPath: string; reviewStatus: string };
      workflow: { video: string; edit: string };
      uncertainCommands: number;
      finalDoctor: { errors: number };
    };
    const expectedTransport = process.env.AI_CANVAS_MCP_RUNTIME && process.env.AI_CANVAS_MCP_SERVER_PATH
      ? "packaged-electron-node"
      : process.env.AI_CANVAS_MCP_SERVER_PATH
        ? "compiled-node"
        : "source-stdio";
    expect(result).toEqual(expect.objectContaining({ transport: expectedTransport, desktopUiLaunched: false, toolCount: EXPECTED_MCP_TOOL_COUNT, resourceReads: 9, promptReads: 7, uncertainCommands: 0 }));
    expect(result.task).toEqual(expect.objectContaining({ id: result.task.replayedId, finalItemStatus: "已完成" }));
    expect(result.generation).toEqual(expect.objectContaining({ status: "succeeded", publicationReceiptId: expect.stringMatching(/^receipt-/) }));
    expect(result.generationProvider).toEqual({ id: "headless-browser", settingsRevision: 1 });
    expect(result.editor).toEqual(expect.objectContaining({ clips: expect.any(Number), timebase: { rateNumerator: 24_000, rateDenominator: 1_001 }, renderStatus: "succeeded", renderPath: expect.stringContaining(root) }));
    expect(result.editor.clips).toBeGreaterThanOrEqual(2);
    expect(result.continuation).toEqual(expect.objectContaining({ status: "completed", outputPath: expect.stringContaining(root), reviewStatus: "已完成" }));
    expect(result.workflow).toEqual({ video: "completed", edit: "completed" });
    expect(result.finalDoctor.errors).toBe(0);
    // 2026-08-09 真实 source-stdio 全链实测约 155 秒，其中 bootstrap 约 93 秒；
    // 240 秒保留负载抖动空间，同时仍对死锁保持明确上界。
  }, 240_000);
});
