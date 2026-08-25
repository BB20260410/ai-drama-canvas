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

describe("Wave 4-B story / adaptation / novel-agent 冷域动态 import", () => {
  it("MCP / Main / command-bus / codex / production 不静态拉 story.js 或 adaptation.js", () => {
    for (const file of [
      "src/mcp/server.ts",
      "src/main/index.ts",
      "src/core/command-bus.ts",
      "src/core/codex.ts",
      "src/core/production.ts",
    ]) {
      const text = source(file);
      expect(valueImportLines(text, "story\\.js"), file).toEqual([]);
      expect(valueImportLines(text, "adaptation\\.js"), file).toEqual([]);
      expect(text).toMatch(/withStory|withAdaptation/u);
    }
  });

  it("handshake 与启动入口不静态拉 novel-agent-service.js", () => {
    for (const file of [
      "src/mcp/server.ts",
      "src/main/index.ts",
      "src/core/codex.ts",
      "src/core/novel-desktop-writing-os.ts",
    ]) {
      expect(valueImportLines(source(file), "novel-agent-service\\.js"), file).toEqual([]);
    }
    expect(source("src/core/codex.ts")).toContain("novel-agent-capabilities");
    expect(source("src/mcp/server.ts")).toContain("withNovelAgent");
  });

  it("隐藏边不把 story / adaptation / novel-agent-service 拉回启动图", () => {
    expect(valueImportLines(source("src/core/adaptation.ts"), "story\\.js")).toEqual([]);
    expect(source("src/core/adaptation.ts")).toContain("withStory");
    expect(valueImportLines(source("src/core/novel-analysis.ts"), "story\\.js")).toEqual([]);
    expect(valueImportLines(source("src/core/novel-analysis.ts"), "adaptation\\.js")).toEqual([]);
    expect(valueImportLines(source("src/core/novel-analysis-provider.ts"), "story\\.js")).toEqual([]);
    expect(valueImportLines(source("src/core/novel-analysis-provider.ts"), "adaptation\\.js")).toEqual([]);
    expect(valueImportLines(source("src/core/novel-memory-authority.ts"), "adaptation\\.js")).toEqual([]);
    expect(source("src/core/novel-memory-authority.ts")).toContain("withAdaptation");
    expect(source("src/core/novel-desktop-writing-os.ts")).toContain("withNovelAgent");
  });

  it("story.ts 只在解析 docx 时动态 import mammoth，且不搬家写路径", () => {
    const story = source("src/core/story.ts");
    expect(valueImportLines(story, "mammoth")).toEqual([]);
    expect(story).toContain('import("mammoth")');
    const commandBus = source("src/core/command-bus.ts");
    expect(commandBus).toContain('case "import_story_file"');
    expect(commandBus).toContain('case "analyze_novel_chapters"');
    expect(commandBus).toContain('case "export_adaptation"');
    expect(commandBus).toContain("withStory");
    expect(commandBus).toContain("withAdaptation");
    expect(source("src/core/story-lazy.ts")).toContain('import("./story.js")');
    expect(source("src/core/adaptation-lazy.ts")).toContain('import("./adaptation.js")');
    expect(source("src/core/novel-agent-lazy.ts")).toContain('import("./novel-agent-service.js")');
  });
});
