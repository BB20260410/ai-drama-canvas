/**
 * Wave 4 补刀：MCP / Main / command-bus / codex 启动路径不静态拉小说分析整图。
 * 写命令仍留在 command-bus 原 case，只改动态 import。
 */
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

describe("Wave 4 小说分析整图冷域动态 import", () => {
  it("启动入口不静态拉 novel-analysis.js / novel-analysis-provider.js", () => {
    for (const file of [
      "src/mcp/server.ts",
      "src/main/index.ts",
      "src/core/command-bus.ts",
      "src/core/codex.ts",
    ]) {
      const text = source(file);
      expect(valueImportLines(text, "novel-analysis\\.js"), file).toEqual([]);
      expect(valueImportLines(text, "novel-analysis-provider\\.js"), file).toEqual([]);
      expect(text).toMatch(/withNovelAnalysis|withNovelAnalysisProvider/u);
    }
  });

  it("懒加载器才动态 import，且不搬家写路径", () => {
    expect(source("src/core/novel-analysis-lazy.ts")).toContain('import("./novel-analysis.js")');
    expect(source("src/core/novel-analysis-provider-lazy.ts")).toContain('import("./novel-analysis-provider.js")');
    const commandBus = source("src/core/command-bus.ts");
    expect(commandBus).toContain('case "create_novel_analysis_task"');
    expect(commandBus).toContain('case "execute_novel_analysis_task"');
    expect(commandBus).toContain("withNovelAnalysis");
    expect(commandBus).toContain("withNovelAnalysisProvider");
    expect(commandBus).toContain("loadNovelAnalysisProvider");
  });
});
