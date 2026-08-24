import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("P6.5 cross-project asset reuse desktop wiring", () => {
  it("exposes explicit export/import UI while preserving target Review language", async () => {
    const view = await readFile(
      path.join(root, "src/renderer/src/components/MaterialStudioView.vue"),
      "utf8",
    );
    expect(view).toContain('data-testid="cross-project-asset-reuse"');
    expect(view).toContain('data-testid="cross-project-asset-export"');
    expect(view).toContain('data-testid="cross-project-asset-pick-package"');
    expect(view).toContain("导入为 pending");
    expect(view).toContain("必须在目标工程独立批准后才能提升 Primary");
    expect(view).not.toMatch(/导入.{0,20}(?:自动|直接).{0,20}(?:批准|Primary)/u);
  });

  it("选择复用包 fail-closed：pendingAction 在 pick 前挡连点双开系统目录框", async () => {
    const view = await readFile(
      path.join(root, "src/renderer/src/components/MaterialStudioView.vue"),
      "utf8",
    );
    expect(view).toContain('data-testid="cross-project-asset-pick-package"');
    expect(view).toContain("正在处理，不能再选择复用包");
    const start = view.indexOf("async function pickCrossProjectAssetPackage(");
    const end = view.indexOf("async function importCrossProjectAssetItem(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = view.slice(start, end);
    expect(handler).toContain('runAction("pick-package"');
    expect(handler).toContain("pickCrossProjectAssetPackage");
    expect(handler.indexOf('runAction("pick-package"')).toBeLessThan(
      handler.indexOf("props.api.pickCrossProjectAssetPackage!("),
    );
  });

  it("routes both mutations through executeStudioCommand and main only inspects selected packages", async () => {
    const [app, main, preload] = await Promise.all([
      readFile(path.join(root, "src/renderer/src/App.vue"), "utf8"),
      readFile(path.join(root, "src/main/index.ts"), "utf8"),
      readFile(path.join(root, "src/preload/index.ts"), "utf8"),
    ]);
    expect(app).toContain('command: "export_studio_cross_project_asset_package"');
    expect(app).toContain('command: "import_studio_cross_project_asset_package"');
    expect(main).toContain('"canvas:pick-studio-cross-project-asset-package"');
    expect(main).toContain("inspectStudioCrossProjectAssetPackage");
    expect(preload).toContain("pickStudioCrossProjectAssetExportRoot");
    expect(preload).toContain("pickStudioCrossProjectAssetPackage");
  });
});
