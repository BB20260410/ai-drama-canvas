import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

describe("旧版生产画布按需加载", () => {
  it("不把 VueFlow 运行时和旧画布节点静态装入所有工作区的首屏", async () => {
    const app = await readFile(path.join(process.cwd(), "src/renderer/src/App.vue"), "utf8");

    expect(parse(app, { filename: "App.vue" }).errors).toEqual([]);
    expect(app).not.toMatch(/import\s+\{[^}]*\b(?:VueFlow|useVueFlow)\b[^}]*\}\s+from\s+"@vue-flow\/core"/su);
    expect(app).not.toContain('import { Background } from "@vue-flow/background"');
    expect(app).not.toContain('import { Controls } from "@vue-flow/controls"');

    expect(app).toContain('const LegacyVueFlow = defineAsyncComponent(async () => (await import("@vue-flow/core")).VueFlow)');
    expect(app).toContain('const LegacyVueFlowBackground = defineAsyncComponent(async () => (await import("@vue-flow/background")).Background)');
    expect(app).toContain('const LegacyVueFlowControls = defineAsyncComponent(async () => (await import("@vue-flow/controls")).Controls)');
    for (const component of ["ProductionNode", "ZoneNode", "InspectorPanel", "CanvasNoteNode", "CanvasGroupNode", "NarrativeNode"]) {
      expect(app).toContain(`const ${component} = defineAsyncComponent(() => import("./components/${component}.vue"))`);
    }
    expect(app).toContain('<LegacyVueFlow');
    expect(app).toContain('@pane-ready="onProductionFlowPaneReady"');
    expect(app).toContain('<LegacyVueFlowBackground');
    expect(app).toContain('<LegacyVueFlowControls');
    expect(app).toContain("const productionFlow = shallowRef<LegacyProductionFlowHandle | null>(null)");
    expect(app).toContain("productionFlow.value?.getViewport() ?? canvasViewport.value");
  });

  it("搜索输入合并重建，并用集合索引连接叙事节点", async () => {
    const app = await readFile(path.join(process.cwd(), "src/renderer/src/App.vue"), "utf8");

    expect(app).toContain("const debouncedCanvasSearch = ref");
    expect(app).toContain("watch(search, (value) =>");
    expect(app).toContain("watch([visibleItems, viewKey, compactZoom], scheduleLegacyFlowRebuild)");
    expect(app).toContain('import { projectLegacyCanvasFlow } from "./legacy-canvas-flow-projection"');
    const projection = await readFile(path.join(process.cwd(), "src/renderer/src/legacy-canvas-flow-projection.ts"), "utf8");
    expect(projection).toContain("const eventFactIds = new Set");
    expect(projection).toContain("const visibleIds = new Set");
    expect(projection).not.toContain("eventFacts.some((fact) => fact.id === factId)");
    expect(projection).not.toContain("items.some((item) => item.id === itemId)");
  });

  it("遗留生产画布 Vue Flow Controls Arrow/Home/End 只移焦，不静态装入 VueFlow", async () => {
    const app = await readFile(path.join(process.cwd(), "src/renderer/src/App.vue"), "utf8");
    expect(app).toContain("#production-flow .vue-flow__controls-button");
    expect(app).toContain("function moveProductionFlowControlsFocus");
    expect(app).toContain("function onCanvasShortcut(");
    const shortcutStart = app.indexOf("function onCanvasShortcut(");
    const shortcutEnd = app.indexOf("function showMessage(");
    const shortcut = app.slice(shortcutStart, shortcutEnd);
    expect(shortcut).toContain('event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End"');
    expect(shortcut).toContain("moveProductionFlowControlsFocus");
    expect(shortcut.indexOf("moveProductionFlowControlsFocus")).toBeLessThan(shortcut.indexOf('event.key.toLowerCase() !== "z"'));
    expect(shortcut).not.toContain("createCanvasEntity");
    expect(app).not.toMatch(/import\s+\{[^}]*\b(?:VueFlow|useVueFlow)\b[^}]*\}\s+from\s+"@vue-flow\/core"/su);
    expect(app).toContain('const LegacyVueFlowControls = defineAsyncComponent(async () => (await import("@vue-flow/controls")).Controls)');
  });
});
