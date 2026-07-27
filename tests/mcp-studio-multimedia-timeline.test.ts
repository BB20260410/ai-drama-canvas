import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.js";
import {
  createUnitGridFixtureProject,
  createUnitGridTestImage,
} from "./helpers/studio-unit-grid-fixture.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function parsed(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "{}") as Record<string, unknown>;
}

function expectNoPrivatePaths(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toMatch(/"(?:localPath|objectPath|bodyPath|databasePath|storageRoot|casPath)"\s*:/u);
  expect(serialized).not.toMatch(/[\\/]\.aicanvas[\\/]/u);
  expect(serialized).not.toMatch(/(?:^|["'\s])(?:\/tmp\/|\/private\/var\/folders\/)/u);
  expect(serialized).not.toMatch(/data:[^;,]+;base64,/iu);
}

async function createClient(runtimeRoot: string): Promise<Client> {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  // 这是独立源码态进程；不得把本机已连接 MCP 的旧 build digest 带入测试。
  delete env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
  delete env.AI_CANVAS_RELEASE_MANIFEST_PATH;
  env.AI_CANVAS_REGISTRY_PATH = path.join(runtimeRoot, "projects.json");
  env.AI_CANVAS_MCP_ALLOW_MULTI = "1";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd: workspace,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "studio-multimedia-timeline-mcp-test", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function mcpFailure(call: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    const result = await call as { isError?: boolean };
    expect(result.isError).toBe(true);
    return parsed(result);
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
}

describe("Studio 四媒体时间线 MCP 运行时", () => {
  it("只读工具可发现；execute_command 绑定既有 CAS 图片后可投影，且响应不泄漏本机路径", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-studio-multimedia-")));
    temporaryRoots.push(runtimeRoot);
    const fixture = await createUnitGridFixtureProject(runtimeRoot, {
      unitId: "multimedia-mcp-unit-001",
      season: "S09",
      episode: "EP02",
    });
    const snapshot = await getStudioProductionUnitSnapshot(fixture.root, fixture.unitId);
    if (!snapshot) throw new Error("fixture unit snapshot missing");
    const image = await createUnitGridTestImage(fixture.root, "multimedia-mcp-storyboard", "#354b61");
    const client = await createClient(runtimeRoot);
    try {
      const tools = await client.listTools();
      const timelineTool = tools.tools.find((tool) => tool.name === "get_studio_multimedia_timeline");
      expect(timelineTool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect((timelineTool?.inputSchema as { required?: string[] }).required)
        .toEqual(expect.arrayContaining(["projectRoot", "unitId"]));
      expect(tools.tools.find((tool) => tool.name === "attach_studio_multimedia_timeline_media")).toBeUndefined();
      const executeTool = tools.tools.find((tool) => tool.name === "execute_command");
      expect(JSON.stringify(executeTool?.inputSchema)).toContain("attach_studio_multimedia_timeline_media");

      const invalidCommand = await mcpFailure(client.callTool({
        name: "execute_command",
        arguments: {
          projectRoot: fixture.root,
          requestId: "multimedia-mcp-invalid-request-001",
          idempotencyKey: "multimedia-mcp-invalid-key-001",
          request: {
            command: "attach_studio_multimedia_timeline_media",
            payload: { unexpected: true },
          },
        },
      }));
      // SDK 在 JSON schema 前置拒绝时只保留通用 MCP error；关键是该无效 payload
      // 没有进入命令总线，也没有得到成功记录。
      expect(JSON.stringify(invalidCommand)).toMatch(/MCP error|unitId|payload|invalid|unrecognized|required/i);
      expectNoPrivatePaths(invalidCommand);

      const before = parsed(await client.callTool({
        name: "get_studio_multimedia_timeline",
        arguments: { projectRoot: fixture.root, unitId: fixture.unitId },
      }));
      expect(before).toMatchObject({
        kind: "studio-multimedia-timeline-projection",
        unit: { id: fixture.unitId, revision: snapshot.unit.revision },
        tracks: [],
      });
      expectNoPrivatePaths(before);

      const command = parsed(await client.callTool({
        name: "execute_command",
        arguments: {
          projectRoot: fixture.root,
          requestId: "multimedia-mcp-attach-request-001",
          idempotencyKey: "multimedia-mcp-attach-key-001",
          request: {
            command: "attach_studio_multimedia_timeline_media",
            payload: {
              unitId: fixture.unitId,
              unitRevision: snapshot.unit.revision,
              expectedUnitFingerprint: snapshot.fingerprint,
              slotId: "storyboard-panel-01",
              expectedHeadRevision: 0,
              panelIndex: 1,
              startSeconds: 0,
              endSeconds: 7,
              role: "storyboard",
              mediaSha256: image.sha256,
              note: "MCP runtime fixture storyboard.",
            },
          },
        },
      }));
      expect(command).toMatchObject({
        status: "succeeded",
        replayed: false,
        result: { binding: { unitId: fixture.unitId, role: "storyboard", mediaSha256: image.sha256 } },
      });
      expectNoPrivatePaths(command);

      const projection = parsed(await client.callTool({
        name: "get_studio_multimedia_timeline",
        arguments: { projectRoot: fixture.root, unitId: fixture.unitId, unitRevision: snapshot.unit.revision },
      }));
      expect(projection).toMatchObject({
        kind: "studio-multimedia-timeline-projection",
        unit: { id: fixture.unitId, revision: snapshot.unit.revision, durationSeconds: 15 },
        tracks: [{
          binding: { slotId: "storyboard-panel-01", role: "storyboard", mediaSha256: image.sha256 },
          media: { sha256: image.sha256, kind: "image", casVerified: true },
        }],
      });
      expectNoPrivatePaths(projection);

      const missing = parsed(await client.callTool({
        name: "get_studio_multimedia_timeline",
        arguments: { projectRoot: fixture.root, unitId: "multimedia-mcp-unit-missing" },
      }));
      // 当前 Core 的不存在语义是显式 null：不回退到其它单元，更不会暴露临时工程数据。
      expect(missing).toBeNull();
      expectNoPrivatePaths(missing);
    } finally {
      await client.close();
    }
  }, 120_000);
});
