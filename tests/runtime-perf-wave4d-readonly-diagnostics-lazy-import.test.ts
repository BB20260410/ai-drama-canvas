import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

function valueImportLines(text: string, specifier: string): string[] {
  return text.split("\n").filter((line) => {
    const fromMatch = new RegExp(`from\\s+["'][^"']*${specifier}["']`, "u").test(line);
    return fromMatch && !/import\s+type\b/u.test(line);
  });
}

const mcpStartupFiles = [
  "src/mcp/server.ts",
  "src/core/command-bus.ts",
  "src/core/studio-command-executor.ts",
  "src/core/active-managed-studio-context.ts",
];

const diagnosticSpecifiers = [
  "studio-episode-earliest\\.js",
  "studio-production-projection-bundle\\.js",
  "studio-production-dashboard\\.js",
  "studio-multimedia-timeline\\.js",
  "studio-post-result-observation\\.js",
  "studio-script-library-reader\\.js",
  "studio-script-media-align\\.js",
];

describe("Wave 4-D MCP 只读诊断面动态 import", () => {
  it("MCP 入口与隐藏边不静态拉只读诊断重模块", () => {
    for (const file of mcpStartupFiles) {
      const text = source(file);
      for (const specifier of diagnosticSpecifiers) {
        expect(valueImportLines(text, specifier), `${file} ${specifier}`).toEqual([]);
      }
      expect(valueImportLines(text, "studio-project-write-lease\\.js"), file).toEqual([]);
    }
    expect(valueImportLines(source("src/mcp/server.ts"), "studio-generation-ledger\\.js")).toEqual([]);
    expect(valueImportLines(source("src/mcp/server.ts"), "studio-approved-timeline-projection\\.js")).toEqual([]);
    expect(valueImportLines(source("src/mcp/server.ts"), "studio-production-diagnostics\\.js")).toEqual([]);
    expect(valueImportLines(source("src/mcp/server.ts"), "studio-continuous-generation-state\\.js")).toEqual([]);
  });

  it("懒加载器才动态 import，且不搬家写路径", () => {
    const lazy = source("src/core/studio-readonly-diagnostics-lazy.ts");
    expect(lazy).toContain('import("./studio-episode-earliest.js")');
    expect(lazy).toContain('import("./studio-production-projection-bundle.js")');
    expect(lazy).toContain('import("./studio-production-dashboard.js")');
    expect(lazy).toContain('import("./studio-multimedia-timeline.js")');
    expect(lazy).toContain('import("./studio-post-result-observation.js")');
    expect(lazy).toContain('import("./studio-project-write-lease.js")');
    expect(lazy).toContain('import("./studio-script-library-reader.js")');
    expect(lazy).toContain('import("./studio-script-media-align.js")');
    const commandBus = source("src/core/command-bus.ts");
    expect(commandBus).toContain('"attach_studio_multimedia_timeline_media"');
    expect(commandBus).toContain('"submit_studio_post_result_observation"');
    expect(commandBus).toContain("withStudioMultimediaTimeline");
    expect(commandBus).toContain("withStudioPostResultObservation");
    const executor = source("src/core/studio-command-executor.ts");
    expect(executor).toContain('case "attach_studio_multimedia_timeline_media"');
    expect(executor).toContain('case "submit_studio_post_result_observation"');
    expect(executor).toContain("withStudioMultimediaTimeline");
    expect(executor).toContain("withStudioPostResultObservation");
  });

  it("MCP 诊断工具经 withX；ledger 只读处置面用 handler 内动态 import", () => {
    const server = source("src/mcp/server.ts");
    expect(server).toContain("withStudioEpisodeEarliest");
    expect(server).toContain("withStudioProductionProjectionBundle");
    expect(server).toContain("withStudioProductionDashboard");
    expect(server).toContain("withStudioMultimediaTimeline");
    expect(server).toContain("withStudioProjectWriteLease");
    expect(server).toContain("withStudioScriptLibraryReader");
    expect(server).toContain("withStudioScriptMediaAlign");
    expect(server).toContain('import("../core/studio-generation-ledger.js")');
    expect(source("src/core/active-managed-studio-context.ts")).toContain("withStudioProjectWriteLease");
    expect(source("src/mcp/server.ts")).toContain("function sanitizeCommandRecord");
    expect(source("src/mcp/server.ts")).not.toMatch(/async function sanitizeCommandRecord/u);
  });

  it("Main 已有 IPC await import 仍在，且未把 dashboard 从顶栏误卸成影响 T23 的空转", () => {
    const main = source("src/main/index.ts");
    expect(main).toContain('await import("../core/studio-approved-timeline-projection.js")');
    expect(main).toContain('await import("../core/studio-production-diagnostics.js")');
    expect(main).toContain('await import("../core/studio-continuous-generation-state.js")');
    expect(main).toContain('await import("../core/studio-project-write-lease.js")');
    expect(main).toContain('await import("../core/studio-post-result-observation.js")');
    expect(main).toContain('await import("../core/studio-generation-ledger.js")');
    expect(valueImportLines(main, "studio-production-dashboard\\.js").length).toBeGreaterThan(0);
  });
});
