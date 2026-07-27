import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { EXPECTED_MCP_TOOL_COUNT } from "./helpers/mcp-tool-count.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function parsed(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "{}") as Record<string, any>;
}

async function createClient(runtimeRoot: string): Promise<{ client: Client; transport: StdioClientTransport }> {
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd,
    env: { ...process.env, AI_CANVAS_REGISTRY_PATH: path.join(runtimeRoot, "projects.json") },
    stderr: "pipe",
  });
  const client = new Client({ name: "canonical-assets-mcp-test", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("canonical asset MCP", () => {
  it("暴露三个只读工具，严格分页并对未迁移项目明确返回 unavailable", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-mcp-canonical-")));
    roots.push(runtimeRoot);
    const projectRoot = path.join(runtimeRoot, "project");
    await mkdir(projectRoot, { recursive: true });
    const { client } = await createClient(runtimeRoot);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(EXPECTED_MCP_TOOL_COUNT);
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        "get_canonical_asset_catalog_state",
        "list_canonical_assets",
        "get_canonical_asset",
      ]));
      expect(names).not.toContain("preview_canonical_asset_migration");
      expect(names).not.toContain("migrate_canonical_assets");
      for (const name of ["get_canonical_asset_catalog_state", "list_canonical_assets", "get_canonical_asset"]) {
        expect(tools.tools.find((tool) => tool.name === name)?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      }
      const executeSchema = tools.tools.find((tool) => tool.name === "execute_command")?.inputSchema as {
        properties?: { request?: { oneOf?: Array<{ properties?: { command?: { const?: string }; payload?: { properties?: Record<string, unknown>; required?: string[] } } }>; anyOf?: Array<{ properties?: { command?: { const?: string }; payload?: { properties?: Record<string, unknown>; required?: string[] } } }> } };
      };
      const commandVariants = executeSchema.properties?.request?.oneOf ?? executeSchema.properties?.request?.anyOf ?? [];
      const migrationVariant = commandVariants.find((variant) => variant.properties?.command?.const === "migrate_canonical_assets");
      expect(migrationVariant?.properties?.payload?.properties).toEqual(expect.objectContaining({ expectedStoreRevision: expect.anything(), expectedCandidateFingerprint: expect.anything() }));
      expect(migrationVariant?.properties?.payload?.required).toEqual(expect.arrayContaining(["expectedStoreRevision", "expectedCandidateFingerprint"]));

      const stateSchema = tools.tools.find((tool) => tool.name === "get_canonical_asset_catalog_state")?.inputSchema as { required?: string[] };
      expect(stateSchema.required).toContain("projectRoot");
      const listSchema = tools.tools.find((tool) => tool.name === "list_canonical_assets")?.inputSchema as {
        required?: string[];
        properties?: Record<string, { enum?: string[]; default?: number; maximum?: number }>;
      };
      expect(listSchema.required).toContain("projectRoot");
      expect(listSchema.properties?.category?.enum).toEqual(["character", "scene", "prop"]);
      expect(listSchema.properties?.authority?.enum).toEqual(["any", "with-authority", "without-authority"]);
      expect(listSchema.properties?.offset?.default).toBe(0);
      expect(listSchema.properties?.limit).toMatchObject({ default: 30, maximum: 100 });

      const state = parsed(await client.callTool({ name: "get_canonical_asset_catalog_state", arguments: { projectRoot } }));
      expect(state).toMatchObject({ available: false });
      const page = parsed(await client.callTool({ name: "list_canonical_assets", arguments: { projectRoot } }));
      expect(page).toMatchObject({ available: false, total: 0, offset: 0, limit: 30, items: [] });
      const missing = parsed(await client.callTool({ name: "get_canonical_asset", arguments: { projectRoot, assetId: "C01" } }));
      expect(missing).toMatchObject({ error: { code: "NOT_FOUND" } });
      const legacy = parsed(await client.callTool({ name: "list_fusion_production_assets", arguments: { projectRoot } }));
      expect(legacy).toMatchObject({ available: false, total: 0, items: [] });
      expect(JSON.stringify({ state, page, missing, legacy })).not.toMatch(/data:[^;,]+;base64,|base64,/iu);
    } finally {
      await client.close();
    }
  }, 30_000);
});
