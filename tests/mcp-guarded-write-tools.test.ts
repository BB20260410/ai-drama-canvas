import path from "node:path";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * P27（MCP 审查 F1/F2/F3/F15）：guarded 命名写工具的参数归一化与 union 闸口校验端到端回归。
 * 经真实 stdio MCP 调用——此前 save_script_document/save_unit_timeline 100% TypeError 毒化账本、
 * upsert_canvas_entity 静默丢弃坐标写 (0,0)。
 */

const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let client: Client;
let transport: StdioClientTransport;
let runtimeRoot: string;
let projectRoot: string;

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.find((entry) => entry.type === "text")?.text ?? "";
}

beforeAll(async () => {
  runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "p27-guarded-tools-"));
  projectRoot = path.join(runtimeRoot, "project");
  await mkdir(projectRoot, { recursive: true });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd,
    env: { ...process.env, AI_CANVAS_REGISTRY_PATH: path.join(runtimeRoot, "projects.json") },
    stderr: "pipe",
  });
  client = new Client({ name: "p27-guarded-tools-test", version: "0.1.0" });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client.close();
  await rm(runtimeRoot, { recursive: true, force: true });
});

describe("P27 guarded 命名写工具归一化", () => {
  it("save_script_document：公开字段 path 归一化为 filePath，真实写盘成功（原 100% TypeError）", async () => {
    const result = await client.callTool({
      name: "save_script_document",
      arguments: {
        projectRoot,
        path: path.join(projectRoot, "ep01.md"),
        content: "# 第一集\n阿航出场。",
        requestId: "p27-save-script-0001",
        idempotencyKey: "p27-save-script-0001",
      },
    });
    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(text).not.toContain("TypeError");
    const written = await readFile(path.join(projectRoot, "ep01.md"), "utf8");
    expect(written).toContain("阿航出场");
  }, 60_000);

  it("upsert_canvas_entity：扁平 x/y 归一化为 position，读回坐标为 500/300（原静默写 0,0）", async () => {
    const upsert = await client.callTool({
      name: "upsert_canvas_entity",
      arguments: {
        projectRoot,
        kind: "note",
        title: "坐标回归",
        body: "x/y 必须落到 position。",
        color: "gold",
        x: 500,
        y: 300,
        requestId: "p27-upsert-entity-0001",
        idempotencyKey: "p27-upsert-entity-0001",
      },
    });
    expect(upsert.isError).not.toBe(true);
    const state = await client.callTool({ name: "get_canvas_state", arguments: { projectRoot } });
    const parsed = JSON.parse(textOf(state)) as { entities?: Array<{ title?: string; position?: { x?: number; y?: number } }> };
    const entity = (parsed.entities ?? []).find((entry) => entry.title === "坐标回归");
    expect(entity).toBeDefined();
    expect(entity?.position?.x).toBe(500);
    expect(entity?.position?.y).toBe(300);
  }, 60_000);

  it("save_unit_timeline：shots 归一化为 timings，错误是确定性业务错误而非 TypeError（原毒化账本）", async () => {
    const result = await client.callTool({
      name: "save_unit_timeline",
      arguments: {
        projectRoot,
        unitId: "unit-not-exist",
        shots: [{ shotId: "shot-1", durationSeconds: 5, note: "备注" }],
        requestId: "p27-save-timeline-0001",
        idempotencyKey: "p27-save-timeline-0001",
      },
    });
    const text = textOf(result);
    expect(text).not.toContain("TypeError");
    expect(text).not.toContain("timings.length");
    expect(text).not.toContain("unknown");
    expect(text).toMatch(/找不到|不存在|不一致/);
  }, 60_000);

  it("闸口校验：载荷过命名 schema 但违 union 时被确定性拒绝（盲审 F-5：必须真实触达闸口而非 SDK 前置拦截）", async () => {
    const result = await client.callTool({
      name: "save_unit_timeline",
      arguments: {
        projectRoot,
        unitId: "unit-x",
        // 命名 schema 仅要求 positive（无上限），union 要求 max(15)——16 能过 SDK、必触 union 闸口。
        shots: [{ shotId: "shot-1", durationSeconds: 16 }],
        requestId: "p27-gate-payload-0001",
        idempotencyKey: "p27-gate-payload-0001",
      },
    });
    const text = textOf(result);
    expect(text).toContain("载荷不符合合同");
  }, 60_000);
});
