import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), "utf8");

describe("受管 Studio style UI", () => {
  it("素材中心与无限画布均提供独立风格分类、中文标签和分页入口", () => {
    const material = source("src/renderer/src/components/MaterialStudioView.vue");
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const dashboard = source("src/renderer/src/components/StudioProductionDashboardView.vue");
    const review = source("src/renderer/src/components/StudioContinuityReviewView.vue");
    const binding = source("src/renderer/src/components/StudioBindingWorkbench.vue");
    for (const [filename, contents] of [
      ["MaterialStudioView.vue", material],
      ["ManagedStudioCanvasView.vue", canvas],
      ["StudioProductionDashboardView.vue", dashboard],
      ["StudioContinuityReviewView.vue", review],
      ["StudioBindingWorkbench.vue", binding],
    ] as const) {
      expect(parse(contents, { filename }).errors).toEqual([]);
    }
    expect(material).toContain('{ id: "style", label: "风格", icon: Palette }');
    expect(material).toContain('openCreateDialog(\'style\')');
    expect(material).toContain('(["character", "scene", "prop", "style"] as const)');
    expect(canvas).toContain('{ kind: "style", label: "风格", mark: "风" }');
    expect(canvas).toContain('kind === "prop" || kind === "style"');
    for (const contents of [dashboard, review, binding]) {
      expect(contents).toMatch(/style:\s*"风格"/u);
    }
  });
});

describe("绑定工作台单元行视口剔除", () => {
  it("unit-row 使用 content-visibility，离屏单元跳过同步布局", () => {
    const binding = source("src/renderer/src/components/StudioBindingWorkbench.vue");
    expect(binding).toContain('v-for="unit in units"');
    expect(binding).toContain("content-visibility: auto;");
    expect(binding).toContain("contain-intrinsic-size: auto 56px;");
    expect(binding).not.toMatch(/\.unit-row \{[^}]*content-visibility:\s*hidden/);
  });
});
