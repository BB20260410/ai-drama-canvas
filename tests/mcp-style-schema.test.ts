import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

function objects(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  return [object, ...Object.values(object).flatMap(objects)];
}

describe("受管 MCP style 合同", () => {
  it("只扩展受管 Studio 资产/驾驶舱/命令 schema，style 可被 Codex 读取并写入", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp/server.ts"],
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      env: {
        ...process.env,
        AI_CANVAS_RECORDED_SOURCE_DIGEST: "",
        AI_CANVAS_MCP_ALLOW_MULTI: "1",
      },
      stderr: "pipe",
    });
    client = new Client({ name: "style-schema-test", version: "0.1.0" });
    await client.connect(transport);
    const tools = (await client.listTools()).tools;

    const listAssets = tools.find((tool) => tool.name === "list_studio_assets");
    expect((listAssets?.inputSchema as any)?.properties?.category?.enum).toEqual([
      "character", "scene", "prop", "style",
    ]);

    const dashboard = tools.find((tool) => tool.name === "get_studio_production_dashboard");
    const dashboardAssetVariant = objects(dashboard?.inputSchema)
      .find((entry) => (entry.properties as any)?.operation?.const === "assets");
    expect((dashboardAssetVariant?.properties as any)?.category?.enum).toEqual([
      "character", "scene", "prop", "style",
    ]);

    const execute = tools.find((tool) => tool.name === "execute_command");
    const createAssetVariant = objects(execute?.inputSchema)
      .find((entry) => (entry.properties as any)?.command?.const === "create_studio_asset");
    expect((createAssetVariant?.properties as any)?.payload?.properties?.category?.enum).toEqual([
      "character", "scene", "prop", "style",
    ]);
  });
});
