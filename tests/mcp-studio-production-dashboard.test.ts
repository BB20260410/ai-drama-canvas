import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { countDeclaredMcpTools } from "../src/core/release-manifest.js";
import { createManagedProject } from "../src/core/managed-project.js";

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
  const client = new Client({ name: "studio-production-dashboard-mcp", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

describe("P8 get_studio_production_dashboard MCP", () => {
  it("只新增只读驾驶舱工具，工具数与注册源一致且不返回路径", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-p8-dashboard-")));
    roots.push(runtimeRoot);
    const projectRoot = (await createManagedProject({ parentRoot: runtimeRoot, name: "P8 MCP" })).paths.root;
    const client = await clientFor(runtimeRoot);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(await countDeclaredMcpTools(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")));
      const tool = tools.tools.find((entry) => entry.name === "get_studio_production_dashboard");
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(tools.tools.find((entry) => entry.name === "write_studio_production_dashboard")).toBeUndefined();

      const overview = parsed(await client.callTool({
        name: "get_studio_production_dashboard",
        arguments: { projectRoot, query: { operation: "overview" } },
      }));
      expect(overview).toMatchObject({
        kind: "studio-production-dashboard",
        operation: "overview",
        nextAction: { code: "import-script" },
      });
      expect(JSON.stringify(overview)).not.toMatch(/\.sqlite|objectPath|bodyPath|databasePath/u);

      const units = parsed(await client.callTool({
        name: "get_studio_production_dashboard",
        arguments: { projectRoot, query: { operation: "units", limit: 36 } },
      }));
      expect(units.operation).toBe("units");
      expect(units.page.items).toEqual([]);
    } finally {
      await client.close();
    }
  }, 60_000);
});
