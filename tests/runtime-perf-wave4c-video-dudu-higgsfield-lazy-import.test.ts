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

const startupFiles = [
  "src/mcp/server.ts",
  "src/main/index.ts",
  "src/core/command-bus.ts",
  "src/core/studio-command-executor.ts",
  "src/core/service.ts",
  "src/core/studio-production-projection-bundle.ts",
  "src/core/studio-agent-imagegen-result-bundle.ts",
];

describe("Wave 4-C video-package / Higgsfield / dudu / local-creative 冷域动态 import", () => {
  it("启动入口与隐藏边不静态拉视频包 / Dudu / Higgsfield 重模块", () => {
    for (const file of startupFiles) {
      const text = source(file);
      expect(valueImportLines(text, "studio-video-package\\.js"), file).toEqual([]);
      expect(valueImportLines(text, "dudu-readonly-import\\.js"), file).toEqual([]);
      expect(valueImportLines(text, "studio-higgsfield-video-generation\\.js"), file).toEqual([]);
      expect(valueImportLines(text, "studio-higgsfield-connector-queue\\.js"), file).toEqual([]);
    }
  });

  it("local-creative 重模块不进 MCP/Main/service 启动解析", () => {
    for (const file of [
      "src/mcp/server.ts",
      "src/main/index.ts",
      "src/core/command-bus.ts",
      "src/core/studio-command-executor.ts",
      "src/core/service.ts",
    ]) {
      const text = source(file);
      expect(valueImportLines(text, "local-creative-project-ingest-status\\.js"), file).toEqual([]);
      expect(valueImportLines(text, "local-creative-production-unit-preview\\.js"), file).toEqual([]);
      expect(valueImportLines(text, "local-creative-production-unit-materializer\\.js"), file).toEqual([]);
      expect(valueImportLines(text, "local-creative-source-inventory\\.js"), file).toEqual([]);
      expect(valueImportLines(text, "local-creative-project-content-import\\.js"), file).toEqual([]);
    }
  });

  it("懒加载器才动态 import，且不搬家写路径", () => {
    expect(source("src/core/studio-video-package-lazy.ts")).toContain('import("./studio-video-package.js")');
    expect(source("src/core/dudu-readonly-import-lazy.ts")).toContain('import("./dudu-readonly-import.js")');
    expect(source("src/core/studio-higgsfield-lazy.ts")).toContain('import("./studio-higgsfield-video-generation.js")');
    expect(source("src/core/studio-higgsfield-lazy.ts")).toContain('import("./studio-higgsfield-connector-queue.js")');
    expect(source("src/core/local-creative-lazy.ts")).toContain('import("./local-creative-production-unit-materializer.js")');
    const commandBus = source("src/core/command-bus.ts");
    expect(commandBus).toContain('case "stage_dudu_readonly_managed_project"');
    expect(commandBus).toContain("withDuduReadonlyImport");
    expect(commandBus).toContain("withStudioVideoPackage");
    const executor = source("src/core/studio-command-executor.ts");
    expect(executor).toContain('case "build_studio_video_package"');
    expect(executor).toContain('case "prepare_studio_higgsfield_video_generation"');
    expect(executor).toContain("withHiggsfieldVideo");
    expect(executor).toContain("withHiggsfieldQueue");
  });

  it("MCP 同步消毒器仍可静态拉无重依赖的 higgsfield-mcp-projection", () => {
    const server = source("src/mcp/server.ts");
    expect(server).toContain("studio-higgsfield-mcp-projection");
    expect(server).toContain("projectHiggsfieldPrepareConnectorRequestForMcp");
    expect(source("src/core/studio-higgsfield-mcp-projection.ts")).not.toMatch(/from\s+["'][^"']*studio-video-package\.js["']/u);
    expect(source("src/core/studio-higgsfield-mcp-projection.ts")).not.toMatch(/from\s+["'][^"']*studio-higgsfield-connector-queue\.js["']/u);
  });
});
