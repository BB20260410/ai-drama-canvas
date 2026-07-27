import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, root), "utf8");
}

describe("Studio 四媒体时间线端到端接线", () => {
  it("主进程与 preload 只读暴露同一 Core 投影", async () => {
    const [main, preload] = await Promise.all([
      source("src/main/index.ts"),
      source("src/preload/index.ts"),
    ]);

    expect(main).toContain('import { getStudioMultimediaTimelineProjection } from "../core/studio-multimedia-timeline.js"');
    expect(main).toContain('"canvas:get-studio-multimedia-timeline"');
    expect(main).toMatch(
      /canvas:get-studio-multimedia-timeline[\s\S]*requireManagedStudioProject\(projectRoot\)[\s\S]*getStudioMultimediaTimelineProjection\(projectRoot, query\)/,
    );
    expect(preload).toContain("getStudioMultimediaTimeline:");
    expect(preload).toContain('ipcRenderer.invoke("canvas:get-studio-multimedia-timeline", projectRoot, query)');
  });

  it("源码 UI 通过受管素材中心打开媒体时间线且不批量读取每个单元", async () => {
    const [app, studio, timeline] = await Promise.all([
      source("src/renderer/src/App.vue"),
      source("src/renderer/src/components/MaterialStudioView.vue"),
      source("src/renderer/src/components/StudioMultimediaTimelineView.vue"),
    ]);

    expect(app).toContain(':multimedia-timeline-api="studioMultimediaTimelineApi"');
    expect(app).toContain("window.canvasApi.listStudioProductionUnits(root, query)");
    expect(app).toContain("window.canvasApi.getStudioMultimediaTimeline(root, query)");
    expect(app).toContain("window.canvasApi.pickStudioMediaFiles()");
    expect(app).toContain('command: "import_studio_media"');
    expect(app).toContain('command: "attach_studio_multimedia_timeline_media"');
    expect(studio).toContain('data-testid="studio-mode-multimedia-timeline"');
    expect(studio).toContain('v-else-if="activeMode === \'multimedia-timeline\'"');
    expect(studio).toContain("<AsyncStudioMultimediaTimelineView");
    expect(timeline).toContain("await props.api.listUnits(projectRoot, query)");
    expect(timeline).toContain("await props.api.getTimeline(projectRoot, { unitId })");
    expect(timeline).not.toMatch(/Promise\.all\([^)]*getTimeline/);
  });

  it("MCP 与 Codex capability 公开只读时间线，写入仍统一经过命令总线", async () => {
    const [mcp, codex, runtime] = await Promise.all([
      source("src/mcp/server.ts"),
      source("src/core/codex.ts"),
      source("src/core/studio-command-runtime.ts"),
    ]);

    expect(mcp).toContain('"get_studio_multimedia_timeline"');
    expect(mcp).toMatch(
      /get_studio_multimedia_timeline[\s\S]*annotations: \{ readOnlyHint: true, openWorldHint: false \}/,
    );
    expect(codex).toContain('"get_studio_multimedia_timeline"');
    expect(codex).toContain('"attach_studio_multimedia_timeline_media"');
    expect(runtime).toContain('command: z.literal("attach_studio_multimedia_timeline_media")');
  });
});
