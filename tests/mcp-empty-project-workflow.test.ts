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

describe("空目录纯 stdio MCP 小说分镜闭环", () => {
  it("从 story_first 导入到分镜导出与跨进程恢复均不调用核心函数", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const root = path.join(os.tmpdir(), `ai-canvas-mcp-empty-test-${suffix}`);
    const registry = path.join(os.tmpdir(), `ai-canvas-mcp-empty-registry-${suffix}.json`);
    cleanup.push(root, registry);
    const executable = path.join(process.cwd(), "node_modules", ".bin", "tsx");
    const { stdout } = await execFileAsync(executable, ["scripts/mcp-empty-project-workflow-smoke.ts", root, registry], { cwd: process.cwd(), env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registry }, maxBuffer: 4_000_000 });
    const result = JSON.parse(stdout) as {
      transport: string;
      desktopUiLaunched: boolean;
      toolCount: number;
      chapters: number;
      facts: number;
      beats: number;
      splitUnits: number;
      storyboardRows: number;
      totalItems: number;
      jsonPath: string;
      markdownPath: string;
      uncertainCommands: number;
      restartVerified: boolean;
    };
    expect(result).toEqual(expect.objectContaining({ transport: "source-stdio", desktopUiLaunched: false, toolCount: EXPECTED_MCP_TOOL_COUNT, chapters: 2, uncertainCommands: 0, restartVerified: true, directorContractPreserved: true }));
    expect(result.facts).toBeGreaterThan(0);
    expect(result.beats).toBeGreaterThan(0);
    expect(result.splitUnits).toBeGreaterThanOrEqual(2);
    expect(result.storyboardRows).toBeGreaterThanOrEqual(result.splitUnits);
    expect(result.totalItems).toBeGreaterThanOrEqual(result.splitUnits);
    expect(result.jsonPath).toContain(root);
    expect(result.markdownPath).toContain(root);
  }, 120_000);
});
