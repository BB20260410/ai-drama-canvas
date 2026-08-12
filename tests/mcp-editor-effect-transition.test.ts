import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { EXPECTED_MCP_TOOL_COUNT } from "./helpers/mcp-tool-count.js";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true }))));

function parseToolResult(result: unknown): any {
  const response = result as { content?: Array<{ type: string; text?: string }> };
  const text = response.content?.find((entry) => entry.type === "text" && typeof entry.text === "string")?.text ?? "{}";
  const parsed = JSON.parse(text) as { status?: string; result?: unknown };
  return parsed.status === "succeeded" && Object.hasOwn(parsed, "result") ? parsed.result : parsed;
}

function rational(value: number) {
  return { OTIO_SCHEMA: "RationalTime.1", value, rate: 24 };
}

function range(start: number, duration: number) {
  return { OTIO_SCHEMA: "TimeRange.1", start_time: rational(start), duration: rational(duration) };
}

function clip(name: string, sourcePath: string, start: number, duration: number, effects: unknown[] = []) {
  return {
    OTIO_SCHEMA: "Clip.2",
    name,
    source_range: range(start, duration),
    media_reference: {
      OTIO_SCHEMA: "ExternalReference.1",
      target_url: pathToFileURL(sourcePath).href,
      available_range: range(0, 48),
      available_image_bounds: null,
      metadata: {},
    },
    effects,
    markers: [],
    metadata: {},
  };
}

function otioDocument(firstVideo: string, secondVideo: string, audio: string) {
  const dissolve = {
    OTIO_SCHEMA: "Transition.1",
    name: "MCP 标准溶解",
    transition_type: "SMPTE_Dissolve",
    in_offset: rational(3),
    out_offset: rational(5),
    enabled: true,
    metadata: {},
  };
  const timeWarp = { OTIO_SCHEMA: "LinearTimeWarp.1", name: "2x", effect_name: "LinearTimeWarp", time_scalar: 2, enabled: true, metadata: {} };
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: "MCP Effect Transition",
    global_start_time: null,
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      source_range: null,
      effects: [],
      markers: [],
      metadata: {},
      children: [
        { OTIO_SCHEMA: "Track.1", name: "V1", kind: "Video", source_range: null, effects: [], markers: [], metadata: {}, children: [clip("A", firstVideo, 0, 24), dissolve, clip("B", secondVideo, 4, 24)] },
        { OTIO_SCHEMA: "Track.1", name: "A1", kind: "Audio", source_range: null, effects: [], markers: [], metadata: {}, children: [clip("2x audio", audio, 0, 48, [timeWarp])] },
      ],
    },
    metadata: { aicanvas: { fps: 24, width: 320, height: 320, backgroundColor: "#000000" } },
  };
}

describe("stdio MCP OTIO Effect / Transition", () => {
  it("source 与 compiled server 都可导入、CAS 修改、幂等重放并标准导出", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const root = path.join(os.tmpdir(), `ai-canvas-mcp-effect-transition-${suffix}`);
    const registry = path.join(os.tmpdir(), `ai-canvas-mcp-effect-transition-registry-${suffix}.json`);
    const unitDirectory = path.join(root, "EP01_15s_001_MCP标准转场");
    const firstVideo = path.join(root, "outgoing.mp4");
    const secondVideo = path.join(root, "incoming.mp4");
    const audio = path.join(root, "timewarp.wav");
    const inputOtio = path.join(root, "source.otio");
    cleanup.push(root, registry);
    await mkdir(unitDirectory, { recursive: true });
    await writeFile(path.join(unitDirectory, "00_信息.md"), "首帧提示词：MCP 标准转场测试。\n", "utf8");
    await Promise.all([
      execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x320:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", firstVideo]),
      execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x320:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", secondVideo]),
      execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=611:sample_rate=48000:duration=2", "-c:a", "pcm_s16le", "-y", audio]),
    ]);
    await writeFile(inputOtio, `${JSON.stringify(otioDocument(firstVideo, secondVideo, audio), null, 2)}\n`, "utf8");

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
    const client = new Client({ name: "ai-canvas-mcp-effect-transition-test", version: "0.1.0" });

    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(EXPECTED_MCP_TOOL_COUNT);
      const scan = await client.callTool({ name: "scan_project", arguments: { projectRoot: root, requestId: "request-mcp-effect-scan-001", idempotencyKey: "mcp-effect-scan-v1" } });
      expect(scan.isError, JSON.stringify(scan)).not.toBe(true);

      const importedRaw = await client.callTool({ name: "import_edit_otio", arguments: { projectRoot: root, requestId: "request-mcp-effect-import-001", idempotencyKey: "mcp-effect-import-v1", filePath: inputOtio, name: "MCP 标准兼容" } });
      if (importedRaw.isError) throw new Error(JSON.stringify(importedRaw));
      const imported = parseToolResult(importedRaw);
      const visualClips = imported.tracks.find((track: any) => track.kind === "visual").clips;
      const audioClip = imported.tracks.find((track: any) => track.kind === "audio").clips[0];
      expect(visualClips[0].transition).toEqual(expect.objectContaining({ targetClipId: visualClips[1].id, inOffsetFrames: 3, outOffsetFrames: 5 }));
      expect(audioClip).toEqual(expect.objectContaining({ playbackRate: 2, durationFrames: 24, sourceAvailableRange: { startFrame: 0, durationFrames: 48 } }));

      const updateRequest = {
        projectRoot: root,
        requestId: "request-mcp-effect-update-001",
        idempotencyKey: "mcp-effect-update-v1",
        request: {
          command: "apply_edit_operation",
          payload: {
            editProjectId: imported.id,
            expectedRevision: imported.revision,
            operation: {
              type: "update_clip",
              clipId: visualClips[0].id,
              patch: {
                transitionOut: "smpte_dissolve",
                transition: { contract: "aicanvas.otio-transition.v1", kind: "smpte_dissolve", targetClipId: visualClips[1].id, inOffsetFrames: 2, outOffsetFrames: 4 },
              },
            },
          },
        },
      };
      const updatedRaw = await client.callTool({ name: "execute_command", arguments: updateRequest });
      expect(updatedRaw.isError).not.toBe(true);
      const updated = parseToolResult(updatedRaw);
      expect(updated).toEqual(expect.objectContaining({ editProjectId: imported.id, revision: imported.revision + 1 }));

      const replayRaw = await client.callTool({ name: "execute_command", arguments: { ...updateRequest, requestId: "request-mcp-effect-update-002" } });
      expect(replayRaw.isError).not.toBe(true);
      expect((replayRaw.structuredContent as any)?.replayed).toBe(true);
      expect(parseToolResult(replayRaw)).toEqual(updated);

      const staleRaw = await client.callTool({
        name: "execute_command",
        arguments: {
          ...updateRequest,
          requestId: "request-mcp-effect-stale-001",
          idempotencyKey: "mcp-effect-stale-v1",
          request: { ...updateRequest.request, payload: { ...updateRequest.request.payload, operation: { type: "update_clip", clipId: visualClips[0].id, patch: { transitionOut: "cut" } } } },
        },
      });
      expect(staleRaw.isError).toBe(true);
      expect(JSON.stringify(staleRaw)).toMatch(/修订|revision|其他窗口/i);

      const current = parseToolResult(await client.callTool({ name: "get_edit_project", arguments: { projectRoot: root, editProjectId: imported.id } }));
      expect(current.revision).toBe(updated.revision);
      expect(current.tracks.find((track: any) => track.kind === "visual").clips[0].transition).toEqual(expect.objectContaining({ inOffsetFrames: 2, outOffsetFrames: 4 }));

      const fractionalRaw = await client.callTool({
        name: "apply_edit_operation",
        arguments: { projectRoot: root, requestId: "request-mcp-effect-fractional-001", idempotencyKey: "mcp-effect-fractional-v1", editProjectId: imported.id, expectedRevision: current.revision, operation: { type: "update_clip", clipId: visualClips[0].id, patch: { transition: { contract: "aicanvas.otio-transition.v1", kind: "smpte_dissolve", targetClipId: visualClips[1].id, inOffsetFrames: 2.5, outOffsetFrames: 4 } } } },
      }).then((result) => result, (error: unknown) => error);
      expect(JSON.stringify(fractionalRaw)).toMatch(/integer|整数|Invalid/i);

      const exported = parseToolResult(await client.callTool({ name: "export_edit_otio", arguments: { projectRoot: root, requestId: "request-mcp-effect-export-001", idempotencyKey: "mcp-effect-export-v1", editProjectId: imported.id, expectedRevision: current.revision } }));
      const document = JSON.parse(await readFile(exported.path, "utf8"));
      const transition = document.tracks.children[0].children.find((child: any) => child.OTIO_SCHEMA === "Transition.1");
      const timeWarp = document.tracks.children[1].children[0].effects[0];
      expect(transition).toEqual(expect.objectContaining({ transition_type: "SMPTE_Dissolve", in_offset: expect.objectContaining({ value: 2 }), out_offset: expect.objectContaining({ value: 4 }) }));
      expect(timeWarp).toEqual(expect.objectContaining({ OTIO_SCHEMA: "LinearTimeWarp.1", effect_name: "LinearTimeWarp", time_scalar: 2, enabled: true }));
      expect(document.metadata.aicanvas.effectTransitionContract).toBe("aicanvas.otio-effect-transition.v1");

      const ledger = parseToolResult(await client.callTool({ name: "list_command_ledger", arguments: { projectRoot: root, limit: 20 } }));
      expect(ledger).toEqual(expect.arrayContaining([
        expect.objectContaining({ idempotencyKey: "mcp-effect-update-v1", status: "succeeded" }),
        expect.objectContaining({ idempotencyKey: "mcp-effect-stale-v1", status: "failed" }),
      ]));
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 60_000);
});
