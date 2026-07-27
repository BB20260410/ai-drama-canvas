import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { EXPECTED_MCP_TOOL_COUNT } from "./helpers/mcp-tool-count.js";

const cleanup: string[] = [];

afterEach(async () => Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true }))));

function parseToolResult(result: unknown): unknown {
  const response = result as { content?: Array<{ type: string; text?: string }> };
  const text = response.content?.find((entry) => entry.type === "text" && typeof entry.text === "string")?.text ?? "{}";
  const parsed = JSON.parse(text) as { status?: string; result?: unknown };
  return parsed.status === "succeeded" && Object.hasOwn(parsed, "result") ? parsed.result : parsed;
}

function nestedClip(project: any): any {
  return project.tracks.flatMap((track: any) => track.clips).find((clip: any) => clip.kind === "timeline");
}

describe("stdio MCP 嵌套时间线", () => {
  it("经真实 MCP 新增、重放、CAS 拒绝并显式刷新冻结子工程", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const root = path.join(os.tmpdir(), `ai-canvas-mcp-editor-nested-${suffix}`);
    const registry = path.join(os.tmpdir(), `ai-canvas-mcp-editor-nested-registry-${suffix}.json`);
    const imagePath = path.join(root, "child-source.png");
    const unitDirectory = path.join(root, "EP01_15s_001_MCP嵌套");
    cleanup.push(root, registry);
    await mkdir(unitDirectory, { recursive: true });
    await writeFile(path.join(unitDirectory, "00_信息.md"), "首帧提示词：MCP 嵌套时间线测试。\n", "utf8");
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "#5b3fd6" } }).png().toFile(imagePath);

    const compiledServer = process.env.AI_CANVAS_MCP_SERVER_PATH?.trim();
    const packagedRuntime = process.env.AI_CANVAS_MCP_RUNTIME?.trim();
    const transport = new StdioClientTransport({
      command: packagedRuntime && compiledServer ? "/usr/bin/env" : process.execPath,
      args: packagedRuntime && compiledServer
        ? ["ELECTRON_RUN_AS_NODE=1", path.resolve(packagedRuntime), path.resolve(compiledServer)]
        : compiledServer ? [path.resolve(compiledServer)] : ["--import", "tsx", "src/mcp/server.ts"],
      cwd: process.cwd(),
      env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registry },
      stderr: "pipe",
    });
    const client = new Client({ name: "ai-canvas-mcp-editor-nested-test", version: "0.1.0" });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(EXPECTED_MCP_TOOL_COUNT);
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["create_edit_project", "save_edit_project", "get_edit_project", "execute_command"]));
      const scanRaw = await client.callTool({
        name: "scan_project",
        arguments: { projectRoot: root, requestId: "request-mcp-nested-scan-001", idempotencyKey: "mcp-nested-scan-v1" },
      });
      expect(scanRaw.isError).not.toBe(true);

      const childRaw = await client.callTool({
        name: "create_edit_project",
        arguments: { projectRoot: root, requestId: "request-mcp-nested-child-create-001", idempotencyKey: "mcp-nested-child-create-v1", name: "MCP 子时间线", width: 320, height: 256, fps: 24, autoPopulate: false },
      });
      if (childRaw.isError) throw new Error(JSON.stringify(childRaw));
      const child = parseToolResult(childRaw) as any;
      const childVisual = child.tracks.find((track: any) => track.kind === "visual");
      childVisual.clips.push({
        id: "clip-mcp-nested-child",
        trackId: childVisual.id,
        kind: "image",
        name: "MCP 子画面",
        sourcePath: imagePath,
        startSeconds: 0,
        durationSeconds: 1,
        trimStartSeconds: 0,
        playbackRate: 1,
        volume: 0,
        opacity: 1,
        muted: true,
        positionX: 0,
        positionY: 0,
        scale: 1,
        rotation: 0,
        filter: "none",
        filterIntensity: 1,
        keyframes: [],
      });
      const savedChild = parseToolResult(await client.callTool({
        name: "save_edit_project",
        arguments: { projectRoot: root, requestId: "request-mcp-nested-child-save-001", idempotencyKey: "mcp-nested-child-save-v1", project: child, expectedRevision: child.revision },
      })) as any;

      const parent = parseToolResult(await client.callTool({
        name: "create_edit_project",
        arguments: { projectRoot: root, requestId: "request-mcp-nested-parent-create-001", idempotencyKey: "mcp-nested-parent-create-v1", name: "MCP 父时间线", width: 320, height: 256, fps: 30, autoPopulate: false },
      })) as any;
      const parentVisual = parent.tracks.find((track: any) => track.kind === "visual");
      const addRequest = {
        projectRoot: root,
        requestId: "request-mcp-nested-add-001",
        idempotencyKey: "mcp-nested-add-v1",
        request: {
          command: "apply_edit_operation",
          payload: {
            editProjectId: parent.id,
            expectedRevision: parent.revision,
            operation: {
              type: "add_nested_timeline",
              trackId: parentVisual.id,
              childEditProjectId: savedChild.id,
              childExpectedRevision: savedChild.revision,
              startFrame: 0,
            },
          },
        },
      };
      const addedRaw = await client.callTool({ name: "execute_command", arguments: addRequest });
      expect(addedRaw.isError).not.toBe(true);
      const added = parseToolResult(addedRaw) as any;
      expect(added).toEqual(expect.objectContaining({ editProjectId: parent.id, revision: parent.revision + 1 }));

      const addReplayRaw = await client.callTool({
        name: "execute_command",
        arguments: { ...addRequest, requestId: "request-mcp-nested-add-002" },
      });
      expect(addReplayRaw.isError).not.toBe(true);
      expect((addReplayRaw.structuredContent as any)?.replayed).toBe(true);
      expect(parseToolResult(addReplayRaw)).toEqual(added);

      const attachedParent = parseToolResult(await client.callTool({
        name: "get_edit_project",
        arguments: { projectRoot: root, editProjectId: parent.id },
      })) as any;
      const attachedClip = nestedClip(attachedParent);
      expect(attachedClip).toMatchObject({
        trackId: parentVisual.id,
        kind: "timeline",
        startFrame: 0,
        durationFrames: 30,
        nestedTimeline: {
          childEditProjectId: savedChild.id,
          childEditProjectRevision: savedChild.revision,
          childTimebase: { rateNumerator: 24, rateDenominator: 1 },
          sourceStep: { numerator: 4, denominator: 5 },
          sourceOffset: { numerator: 0, denominator: 1 },
        },
      });
      const firstSnapshot = attachedClip.nestedTimeline.childSnapshotSha256;
      expect(firstSnapshot).toMatch(/^[a-f0-9]{64}$/);

      const staleAddRaw = await client.callTool({
        name: "execute_command",
        arguments: {
          projectRoot: root,
          requestId: "request-mcp-nested-stale-001",
          idempotencyKey: "mcp-nested-stale-v1",
          request: {
            command: "apply_edit_operation",
            payload: {
              editProjectId: parent.id,
              expectedRevision: parent.revision,
              operation: {
                type: "add_nested_timeline",
                trackId: parentVisual.id,
                childEditProjectId: savedChild.id,
                childExpectedRevision: savedChild.revision,
                startFrame: 60,
              },
            },
          },
        },
      });
      expect(staleAddRaw.isError).toBe(true);
      expect(JSON.stringify(staleAddRaw)).toMatch(/其他窗口更新|revision|修订/i);
      expect((parseToolResult(await client.callTool({ name: "get_edit_project", arguments: { projectRoot: root, editProjectId: parent.id } })) as any).revision).toBe(added.revision);

      const childUpdateRaw = await client.callTool({
        name: "execute_command",
        arguments: {
          projectRoot: root,
          requestId: "request-mcp-nested-child-update-001",
          idempotencyKey: "mcp-nested-child-update-v1",
          request: {
            command: "apply_edit_operation",
            payload: {
              editProjectId: savedChild.id,
              expectedRevision: savedChild.revision,
              operation: { type: "update_clip", clipId: "clip-mcp-nested-child", patch: { opacity: 0.8 } },
            },
          },
        },
      });
      expect(childUpdateRaw.isError).not.toBe(true);
      const childUpdated = parseToolResult(childUpdateRaw) as any;
      expect(childUpdated.revision).toBe(savedChild.revision + 1);

      const stillFrozen = parseToolResult(await client.callTool({
        name: "get_edit_project",
        arguments: { projectRoot: root, editProjectId: parent.id },
      })) as any;
      expect(nestedClip(stillFrozen).nestedTimeline).toEqual(attachedClip.nestedTimeline);

      const refreshRequest = {
        projectRoot: root,
        requestId: "request-mcp-nested-refresh-001",
        idempotencyKey: "mcp-nested-refresh-v1",
        request: {
          command: "apply_edit_operation",
          payload: {
            editProjectId: parent.id,
            expectedRevision: added.revision,
            operation: {
              type: "refresh_nested_timeline",
              clipId: attachedClip.id,
              childExpectedRevision: childUpdated.revision,
            },
          },
        },
      };
      const refreshedRaw = await client.callTool({ name: "execute_command", arguments: refreshRequest });
      expect(refreshedRaw.isError).not.toBe(true);
      const refreshed = parseToolResult(refreshedRaw) as any;
      expect(refreshed.revision).toBe(added.revision + 1);

      const refreshReplayRaw = await client.callTool({
        name: "execute_command",
        arguments: { ...refreshRequest, requestId: "request-mcp-nested-refresh-002" },
      });
      expect(refreshReplayRaw.isError).not.toBe(true);
      expect((refreshReplayRaw.structuredContent as any)?.replayed).toBe(true);
      expect(parseToolResult(refreshReplayRaw)).toEqual(refreshed);

      const refreshedParent = parseToolResult(await client.callTool({
        name: "get_edit_project",
        arguments: { projectRoot: root, editProjectId: parent.id },
      })) as any;
      expect(refreshedParent.revision).toBe(refreshed.revision);
      expect(nestedClip(refreshedParent).nestedTimeline).toEqual(expect.objectContaining({
        childEditProjectId: savedChild.id,
        childEditProjectRevision: childUpdated.revision,
        childSnapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }));
      expect(nestedClip(refreshedParent).nestedTimeline.childSnapshotSha256).not.toBe(firstSnapshot);

      const ledger = parseToolResult(await client.callTool({
        name: "list_command_ledger",
        arguments: { projectRoot: root, limit: 20 },
      })) as Array<{ idempotencyKey: string; status: string }>;
      expect(ledger).toEqual(expect.arrayContaining([
        expect.objectContaining({ idempotencyKey: "mcp-nested-add-v1", status: "succeeded" }),
        expect.objectContaining({ idempotencyKey: "mcp-nested-stale-v1", status: "failed" }),
        expect.objectContaining({ idempotencyKey: "mcp-nested-child-update-v1", status: "succeeded" }),
        expect.objectContaining({ idempotencyKey: "mcp-nested-refresh-v1", status: "succeeded" }),
      ]));
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 60_000);
});
