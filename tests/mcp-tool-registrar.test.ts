import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runtimeMcpEffect, runtimeMcpGateMode } from "../src/core/runtime-mcp-effect.js";
import { countDeclaredMcpTools } from "../src/core/release-manifest.js";
import { createMcpToolRegistrar, type McpToolRegistrarDependencies } from "../src/mcp/tool-registrar.js";

type CapturedRegistration = { name: string; config: Record<string, unknown>; callback: (...args: unknown[]) => unknown };
type LooseRegistrar = (name: string, config: Record<string, unknown>, callback: (...args: unknown[]) => unknown) => CapturedRegistration;

function registerCaptured(
  registrar: ReturnType<typeof createMcpToolRegistrar>,
  name: string,
  config: Record<string, unknown>,
  callback: (...args: unknown[]) => unknown,
): CapturedRegistration {
  return (registrar.registerTool as unknown as LooseRegistrar)(name, config, callback);
}

function fixtureDependencies(events: string[], overrides: Partial<McpToolRegistrarDependencies> = {}): McpToolRegistrarDependencies {
  return {
    rawRegisterTool: ((name: string, config: Record<string, unknown>, callback: (...args: unknown[]) => unknown) => {
      events.push(`raw:${name}`);
      return { name, config, callback };
    }) as unknown as McpServer["registerTool"],
    runtimeMcpEffect: () => "mutation",
    runtimeMcpGateMode: () => "strong",
    assertRuntimeCurrent: async () => { events.push("current"); },
    recordRuntimePerformance: () => { events.push("metric"); },
    toolError: (error) => ({ isError: true, message: error instanceof Error ? error.message : String(error) }),
    guardedWriteCommands: { guarded_tool: "save_script_document" },
    guardedPayloadNormalizers: { save_script_document: (payload) => { events.push("normalize"); return payload; } },
    getCommandRequestSchema: () => ({ safeParse: () => { events.push("schema"); return { success: true }; } }),
    createGuardedWriteBridge: () => ({ flush: async () => { events.push("flush"); } }),
    executeGuardedWrite: async () => { events.push("ledger"); return { content: [] }; },
    ...overrides,
  };
}

describe("MCP tool registrar", () => {
  it("在任何 guarded ledger I/O 前运行 currentness，并记录被拒绝的 metric", async () => {
    const events: string[] = [];
    const registrar = createMcpToolRegistrar(fixtureDependencies(events, {
      assertRuntimeCurrent: async () => { events.push("current"); throw new Error("stale"); },
    }));
    const captured = registerCaptured(registrar, "guarded_tool", { inputSchema: {}, description: "guarded" }, (() => { events.push("handler"); }));

    const result = await captured.callback({ projectRoot: "/tmp/project", requestId: "request-0001", idempotencyKey: "idem-0001" });
    expect(result).toMatchObject({ isError: true, message: "stale" });
    expect(events).toEqual(["raw:guarded_tool", "current", "metric"]);
  });

  it("保持 runtime → guarded schema/ledger 的顺序，且原 handler 不绕过 command bus", async () => {
    const events: string[] = [];
    const registrar = createMcpToolRegistrar(fixtureDependencies(events));
    const captured = registerCaptured(registrar, "guarded_tool", { inputSchema: {}, description: "guarded" }, (() => { events.push("handler"); }));

    await captured.callback({ projectRoot: "/tmp/project", requestId: "request-0001", idempotencyKey: "idem-0001" });
    expect(events).toEqual(["raw:guarded_tool", "current", "normalize", "schema", "ledger", "flush", "metric"]);
    expect(captured.config.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    expect(captured.config.description).toContain("稳定 requestId");
  });

  it("对 Zod object 保持两次 safeExtend，而非退化为一次 spread", () => {
    const events: string[] = [];
    const extensions: Array<string[]> = [];
    const schema = {
      safeExtend(shape: Record<string, unknown>) {
        extensions.push(Object.keys(shape));
        return schema;
      },
    };
    const registrar = createMcpToolRegistrar(fixtureDependencies(events));
    registerCaptured(registrar, "guarded_tool", { inputSchema: schema }, (() => undefined));
    expect(extensions).toEqual([
      ["requestId", "idempotencyKey"],
      ["writeLeaseHolderId", "writeLeaseToken"],
    ]);
  });
});

describe("MCP tool ABI", () => {
  it("冻结 220 个工具的顺序、声明元数据及 effect/gate 分类", async () => {
    const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-tool-abi-"));
    const fixture = JSON.parse(await readFile(path.join(cwd, "tests/fixtures/mcp-tool-abi.json"), "utf8")) as {
      toolCount: number;
      toolAbiSha256: string;
    };
    expect(await countDeclaredMcpTools(cwd)).toBe(fixture.toolCount);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp/server.ts"],
      cwd,
      env: { ...process.env, AI_CANVAS_REGISTRY_PATH: path.join(runtimeRoot, "projects.json") },
      stderr: "pipe",
    });
    const client = new Client({ name: "mcp-tool-abi", version: "0.1.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const tools = listed.tools.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({
        name,
        title,
        description,
        inputSchema,
        outputSchema,
        annotations,
        effect: runtimeMcpEffect(name),
        gate: runtimeMcpGateMode(name),
      }));
      expect(tools).toHaveLength(fixture.toolCount);
      expect(createHash("sha256").update(JSON.stringify(tools)).digest("hex")).toBe(fixture.toolAbiSha256);
    } finally {
      await client.close();
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
