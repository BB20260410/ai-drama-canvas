import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

function valueEditorImportLines(text: string): string[] {
  return text.split("\n").filter((line) => /from\s+["'][^"']*editor\.js["']/u.test(line) && !/import\s+type\b/u.test(line));
}

describe("Wave 4-A editor / OTIO 冷域动态 import", () => {
  it("MCP / Main / command-bus / codex / production 不静态拉 editor.js", () => {
    for (const file of [
      "src/mcp/server.ts",
      "src/main/index.ts",
      "src/core/command-bus.ts",
      "src/core/codex.ts",
      "src/core/production.ts",
    ]) {
      expect(valueEditorImportLines(source(file)), file).toEqual([]);
      expect(source(file)).toContain("withEditor");
    }
  });

  it("懒加载器才动态 import editor，且不搬家写路径", () => {
    const lazy = source("src/core/editor-lazy.ts");
    expect(lazy).toContain('import("./editor.js")');
    expect(lazy).not.toMatch(/executeIdempotentCommand/u);
    const commandBus = source("src/core/command-bus.ts");
    expect(commandBus).toContain('case "create_edit_project"');
    expect(commandBus).toContain('case "export_edit_otio"');
    expect(commandBus).toContain("withEditor");
  });
});
