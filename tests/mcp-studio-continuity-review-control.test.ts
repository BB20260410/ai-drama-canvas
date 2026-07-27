import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject } from "../src/core/managed-project.js";
import { EXPECTED_MCP_TOOL_COUNT } from "./helpers/mcp-tool-count.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function parsed(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "{}") as Record<string, any>;
}

async function clientFor(runtimeRoot: string): Promise<Client> {
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd,
    env: { ...process.env, AI_CANVAS_REGISTRY_PATH: path.join(runtimeRoot, "projects.json") },
    stderr: "pipe",
  });
  const client = new Client({ name: "studio-continuity-review-control-test", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function rejected(call: Promise<unknown>): Promise<string> {
  try {
    const value = await call as { isError?: boolean };
    expect(value.isError).toBe(true);
    return JSON.stringify(value);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("P7 连续性 / Review MCP 只读控制面", () => {
  it("只新增严格只读命名工具，限制六资产与所有列表页，不新增命名写工具", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-p7-control-")));
    roots.push(runtimeRoot);
    const projectRoot = (await createManagedProject({ parentRoot: runtimeRoot, name: "P7 MCP 控制" })).paths.root;
    const client = await clientFor(runtimeRoot);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(EXPECTED_MCP_TOOL_COUNT);
      const tool = tools.tools.find((entry) => entry.name === "get_studio_continuity_review_control");
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      const schema = tool?.inputSchema as {
        required?: string[];
        properties?: { query?: { required?: string[]; properties?: Record<string, any>; additionalProperties?: boolean } };
      };
      expect(schema.required).toEqual(["projectRoot", "query"]);
      expect(schema.properties?.query?.required).toEqual(expect.arrayContaining([
        "unitId", "unitRevision", "panelId", "startMilliseconds", "endMilliseconds", "assetIds",
      ]));
      expect(schema.properties?.query?.additionalProperties).toBe(false);
      expect(schema.properties?.query?.properties?.assetIds).toMatchObject({ maxItems: 6 });
      expect(schema.properties?.query?.properties?.timelineLimit).toMatchObject({ minimum: 1, maximum: 36, default: 36 });
      expect(schema.properties?.query?.properties?.conflictLimit).toMatchObject({ minimum: 1, maximum: 36, default: 36 });
      expect(schema.properties?.query?.properties?.reviewLimit).toMatchObject({ minimum: 1, maximum: 20, default: 20 });
      expect(schema.properties?.query?.properties?.checkpointLimit).toMatchObject({ minimum: 1, maximum: 12, default: 12 });
      for (const forbiddenName of [
        "append_studio_continuity_observation",
        "append_studio_continuity_correction",
        "submit_studio_generation_review",
        "refresh_studio_generation_checkpoint",
        "attest_studio_generation_checkpoint",
      ]) {
        expect(tools.tools.find((entry) => entry.name === forbiddenName)).toBeUndefined();
      }

      const empty = parsed(await client.callTool({
        name: "get_studio_continuity_review_control",
        arguments: {
          projectRoot,
          query: {
            unitId: "unit-empty",
            unitRevision: 1,
            panelId: "panel-empty-01",
            startMilliseconds: 0,
            endMilliseconds: 7_500,
            assetIds: [],
          },
        },
      }));
      expect(empty).toMatchObject({
        kind: "studio-continuity-review-control",
        assets: [],
        conflicts: { total: 0, items: [] },
        checkpoint: { completedSlotCount: 0, batches: { total: 0, items: [] } },
        generation: { status: "blocked" },
        nextAction: { code: "resolve-generation-input" },
      });
      expect(JSON.stringify(empty)).not.toMatch(/databasePath|objectPath|bodyPath|mediaCas|\/tmp\//u);

      const base = {
        projectRoot,
        query: {
          unitId: "unit-empty",
          unitRevision: 1,
          panelId: "panel-empty-01",
          startMilliseconds: 0,
          endMilliseconds: 7_500,
          assetIds: [],
        },
      };
      expect(await rejected(client.callTool({
        name: "get_studio_continuity_review_control",
        arguments: { ...base, query: { ...base.query, assetIds: Array.from({ length: 7 }, (_, index) => `asset-${index}`) } },
      }))).toMatch(/6|too_big|invalid/i);
      expect(await rejected(client.callTool({
        name: "get_studio_continuity_review_control",
        arguments: { ...base, query: { ...base.query, endMilliseconds: 0 } },
      }))).toMatch(/endMilliseconds|greater|invalid/i);
      expect(await rejected(client.callTool({
        name: "get_studio_continuity_review_control",
        arguments: { ...base, query: { ...base.query, databasePath: "/tmp/forged.sqlite" } },
      }))).toMatch(/databasePath|unrecognized|invalid/i);
    } finally {
      await client.close();
    }
  }, 60_000);
});
