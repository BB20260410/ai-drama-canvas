/**
 * Wave 4 补刀：get_capabilities 握手不得 withEditor / 探测 FFmpeg。
 * 不建受管工程、不扫正式工程。doctor / probe_video_engine 仍会加载 editor。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCapabilities } from "../src/core/codex.js";
import { DEFERRED_VIDEO_ENGINE_CAPABILITY } from "../src/core/editor-lazy.js";
import * as editorLazy from "../src/core/editor-lazy.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Wave 4 get_capabilities 握手不探测剪辑引擎", () => {
  it("常量：deferred，不冒充 available", () => {
    expect(DEFERRED_VIDEO_ENGINE_CAPABILITY).toEqual({
      status: "deferred",
      probed: false,
      probeTool: "probe_video_engine",
      issues: ["get_capabilities 不探测剪辑引擎；请调用 probe_video_engine。"],
    });
    expect(DEFERRED_VIDEO_ENGINE_CAPABILITY).not.toHaveProperty("available");
    expect(DEFERRED_VIDEO_ENGINE_CAPABILITY).not.toHaveProperty("ffmpegPath");
  });

  it("getCapabilities 源码不再握手 probeVideoEngine", () => {
    const codex = source("src/core/codex.ts");
    const start = codex.indexOf("export async function getCapabilities");
    const end = codex.indexOf("export async function getProjectChanges");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = codex.slice(start, end);
    expect(body).toContain("DEFERRED_VIDEO_ENGINE_CAPABILITY");
    expect(body).not.toContain("withEditor");
    expect(body).not.toContain("probeVideoEngine");
    expect(codex).toContain("withEditor");
    expect(source("src/mcp/server.ts")).toContain("probe_video_engine");
    expect(source("src/mcp/server.ts")).toContain("withEditor((editor) => editor.probeVideoEngine())");
  });

  it("运行时：零参数握手不调用 withEditor", async () => {
    const spy = vi.spyOn(editorLazy, "withEditor").mockImplementation(async () => {
      throw new Error("get_capabilities 不得加载 editor");
    });
    const capabilities = await getCapabilities();
    expect(spy).not.toHaveBeenCalled();
    expect(capabilities.editor.engine).toEqual(DEFERRED_VIDEO_ENGINE_CAPABILITY);
    expect(capabilities.editor.features).toContain("otio-linear-time-warp");
  });
});
