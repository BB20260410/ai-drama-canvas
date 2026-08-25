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

const productionFiles = [
  "src/mcp/server.ts",
  "src/main/index.ts",
  "src/core/command-bus.ts",
  "src/core/codex.ts",
  "src/core/generation.ts",
  "src/core/material-studio.ts",
  "src/core/studio-generation-ledger.ts",
  "src/core/publication.ts",
  "src/core/scanner.ts",
  "src/core/editor.ts",
  "src/core/studio-video-package.ts",
  "src/core/studio-agent-imagegen-result-bundle.ts",
  "src/core/studio-labeled-layout.ts",
  "src/core/studio-media-derivatives.ts",
  "src/core/studio-consistency-evaluator.ts",
  "src/core/legacy-thumbnails.ts",
  "src/core/fusion-panel-references.ts",
  "src/core/fusion-storyboard-sheet.ts",
  "src/core/fusion-references.ts",
  "src/core/fusion-asset-consistency.ts",
  "src/core/studio-scale-fixture.ts",
];

describe("Wave 4-F sharp 经媒体网关首次 touch", () => {
  it("生产入口与媒体 owner 不静态值导入 sharp", () => {
    for (const file of productionFiles) {
      expect(valueImportLines(source(file), "sharp"), file).toEqual([]);
    }
  });

  it("懒加载器才 import(\"sharp\")，且不改缩略/派生 recipe", () => {
    const lazy = source("src/core/sharp-lazy.ts");
    expect(lazy).toContain('import("sharp")');
    expect(source("src/core/codex.ts")).toContain("loadSharp()");
    expect(source("src/core/codex.ts")).not.toContain('import("sharp")');
    expect(source("src/core/material-studio.ts")).toContain(
      "material-studio-thumb:v1:autorotate:inside-512:no-enlarge:webp-q82",
    );
    expect(source("src/core/studio-media-derivatives.ts")).toContain(
      "studio-video-poster:v1:first-frame:max-1280x720:webp-q82",
    );
    expect(source("src/core/legacy-thumbnails.ts")).toContain("const LEGACY_THUMBNAIL_MAX_EDGE = 512");
    expect(source("src/core/legacy-thumbnails.ts")).toContain("const LEGACY_THUMBNAIL_WEBP_QUALITY = 82");
  });
});
