import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("MCP GenerationSessionSnapshot / callerAgentId schema", () => {
  it("沿既有 generation control 与 execute_command 暴露且保持严格可选字段", async () => {
    const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-mcp-p4-schema-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp/server.ts"],
      cwd,
      env: {
        ...process.env,
        AI_CANVAS_REGISTRY_PATH: path.join(runtimeRoot, "projects.json"),
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "ai-canvas-p4-schema-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const generation = tools.tools.find((tool) => tool.name === "get_studio_generation_control");
      const generationSchema = generation?.inputSchema as {
        properties?: {
          query?: {
            oneOf?: Array<{ properties?: Record<string, unknown>; required?: string[] }>;
            anyOf?: Array<{ properties?: Record<string, unknown>; required?: string[] }>;
          };
        };
      };
      const generationVariants =
        generationSchema.properties?.query?.oneOf
        ?? generationSchema.properties?.query?.anyOf
        ?? [];
      expect(generationVariants).toEqual(expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            operation: { type: "string", const: "session-snapshot" },
            unitId: expect.any(Object),
            panelId: expect.any(Object),
          }),
          required: ["operation", "unitId"],
        }),
      ]));

      const execute = tools.tools.find((tool) => tool.name === "execute_command");
      const executeSchema = execute?.inputSchema as {
        properties?: {
          request?: {
            oneOf?: Array<{ properties?: { command?: { const?: string }; payload?: { properties?: Record<string, unknown>; required?: string[] } } }>;
            anyOf?: Array<{ properties?: { command?: { const?: string }; payload?: { properties?: Record<string, unknown>; required?: string[] } } }>;
          };
        };
      };
      const commandVariants =
        executeSchema.properties?.request?.oneOf
        ?? executeSchema.properties?.request?.anyOf
        ?? [];
      const prepare = commandVariants.find((variant) =>
        variant.properties?.command?.const === "prepare_studio_imagegen_call");
      expect(prepare?.properties?.payload?.properties).toHaveProperty("callerAgentId");
      expect(prepare?.properties?.payload?.required).not.toContain("callerAgentId");
    } finally {
      await client.close();
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
