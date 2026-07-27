import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

describe("P6 桌面剧本绑定集成", () => {
  it("主线程与 preload 只暴露两个专用只读 IPC，写入继续经过 execute command", async () => {
    const [main, preload] = await Promise.all([
      source("src/main/index.ts"),
      source("src/preload/index.ts"),
    ]);

    expect(main).toContain('from "../core/studio-binding-control.js"');
    expect(main).toMatch(/ipcMain\.handle\("canvas:list-studio-binding-units"[\s\S]*?requireManagedStudioProject\(projectRoot\)[\s\S]*?listStudioBindingUnits\(projectRoot, query\)/u);
    expect(main).toMatch(/ipcMain\.handle\("canvas:get-studio-binding-control"[\s\S]*?requireManagedStudioProject\(projectRoot\)[\s\S]*?getStudioBindingControl\(projectRoot, input\)/u);
    expect(main).toContain('ipcMain.handle("canvas:execute-studio-command"');
    expect(main).not.toMatch(/ipcMain\.handle\("canvas:(?:analyze-studio-script-entities|resolve-studio-entity-proposal|confirm-studio-panel-empty|freeze-studio-asset-binding-set)"/u);

    expect(preload).toContain('ipcRenderer.invoke("canvas:list-studio-binding-units", projectRoot, query)');
    expect(preload).toContain('ipcRenderer.invoke("canvas:get-studio-binding-control", projectRoot, input)');
    expect(preload).not.toMatch(/ipcRenderer\.invoke\("canvas:(?:analyze-studio-script-entities|resolve-studio-entity-proposal|confirm-studio-panel-empty|freeze-studio-asset-binding-set)"/u);
  });

  it("受管工程默认进入有界画布，切到剧本绑定后才异步加载工作台", async () => {
    const [app, material] = await Promise.all([
      source("src/renderer/src/App.vue"),
      source("src/renderer/src/components/MaterialStudioView.vue"),
    ]);
    expect(parse(app, { filename: "App.vue" }).errors).toEqual([]);
    const parsedMaterial = parse(material, { filename: "MaterialStudioView.vue" });
    expect(parsedMaterial.errors).toEqual([]);

    expect(app).toContain(':binding-api="studioBindingApi"');
    expect(app).not.toMatch(/import\s+StudioBindingWorkbench\s+from/u);
    expect(material).toContain('data-testid="studio-step-assets"');
    expect(material).toContain('data-testid="studio-step-binding"');
    expect(parsedMaterial.descriptor.template?.content).toContain("无限画布");
    expect(parsedMaterial.descriptor.template?.content).toContain("剧本绑定");
    expect(material).toContain('activeMode');
    expect(material).toContain('props.dashboardApi ? "canvas" : "library"');
    expect(material).toContain('defineAsyncComponent(() => import("./StudioBindingWorkbench.vue"))');
    expect(material).toContain('v-else-if="activeMode === \'library\'"');
    expect(material).toContain('v-else-if="activeMode === \'binding\'"');
    expect(material).toContain('data-testid="studio-mode-dashboard"');
  });

  it("四种绑定写操作均经现有 executeStudioCommand，宫格解析不暴露前端提议编辑", async () => {
    const app = await source("src/renderer/src/App.vue");
    const adapterStart = app.indexOf("const studioBindingApi");
    const adapterEnd = app.indexOf("const studioContinuityReviewApi", adapterStart);
    const adapter = app.slice(adapterStart, adapterEnd);

    expect(adapter.match(/window\.canvasApi\.executeStudioCommand\(/gu)).toHaveLength(4);
    expect(adapter).toContain('command: "analyze_studio_script_entities"');
    expect(adapter).toContain('command: "resolve_studio_entity_proposal"');
    expect(adapter).toContain('command: "confirm_studio_panel_empty"');
    expect(adapter).toContain('command: "freeze_studio_asset_binding_set"');
    expect(adapter).toContain("window.canvasApi.listStudioBindingUnits(root, query)");
    expect(adapter).toContain("window.canvasApi.getStudioBindingControl(root, query)");
    expect(adapter).not.toContain("extractedMentions");
    expect(adapter).not.toMatch(/nextAction\s*[:=]|freezeAllowed\s*[:=]/u);
  });

  it("“解析当前宫格”必须选中 panelId 并原样带回 expectedRevisionToken", async () => {
    const [workbench, pagination] = await Promise.all([
      source("src/renderer/src/components/StudioBindingWorkbench.vue"),
      source("src/renderer/src/studio-binding-pagination.ts"),
    ]);
    const analyzeStart = workbench.indexOf("async function analyzeSelectedUnit");
    const analyzeEnd = workbench.indexOf("async function resolveProposal", analyzeStart);
    const analyze = workbench.slice(analyzeStart, analyzeEnd);

    expect(workbench).toContain("解析当前宫格");
    expect(workbench).toContain(':disabled="!selectedPanel || !control?.revisionToken || Boolean(busyAction)"');
    expect(analyze).toContain("const panel = selectedPanel.value");
    expect(analyze).toContain("if (!snapshot || !panel) return");
    expect(analyze).toContain("panelId: panel.id");
    expect(analyze).toContain("expectedRevisionToken: snapshot.revisionToken");

    const analyzeTypeStart = pagination.indexOf("export interface StudioBindingAnalyzeInput");
    const analyzeTypeEnd = pagination.indexOf("export interface StudioBindingResolveInput", analyzeTypeStart);
    const analyzeType = pagination.slice(analyzeTypeStart, analyzeTypeEnd);
    expect(analyzeType).toContain("panelId: string");
    expect(analyzeType).toContain("expectedRevisionToken: string");
    expect(analyzeType).toContain("extractedMentions?:");
    expect(analyzeType).not.toMatch(/panelId\?|expectedRevisionToken\?/u);
    expect(pagination).toContain("return !panel.freezeAllowed");
  });
});
