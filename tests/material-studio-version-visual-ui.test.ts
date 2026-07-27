import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("素材版本具体视觉裁决 UI", () => {
  it("pending 版本使用轻量缩略图，并只在用户点击后按需打开受管原图", () => {
    const view = readFileSync(
      path.join(root, "src/renderer/src/components/MaterialStudioView.vue"),
      "utf8",
    );
    const app = readFileSync(path.join(root, "src/renderer/src/App.vue"), "utf8");
    expect(parse(view, { filename: "MaterialStudioView.vue" }).errors).toEqual([]);
    expect(view).toContain('class="version-visual"');
    expect(view).toContain("@click=\"openVersionPreview(version)\"");
    expect(view).toContain('v-if="versionPreview"');
    expect(view).toContain('class="version-preview-dialog"');
    expect(view).toContain(":src=\"versionPreview.mediaUrl\"");
    expect(view).toContain("批准、拒绝和提升权威仍在版本卡片中分别执行");
    expect(app).toContain("version.thumbnailRecipeKey");
    expect(app).toContain("aicanvas-studio://media/${version.mediaSha256}");
  });
});
