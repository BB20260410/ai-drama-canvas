import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("八库 TAKE 接线完成门（goal 收尾）", () => {
  it("command-bus preflight_publication 挂 OA-1 diagnostics", () => {
    const bus = src("src/core/command-bus.ts");
    expect(bus).toContain("enrichPublicationIntentWithDiagnostics");
    expect(bus).toContain('case "preflight_publication"');
  });

  it("pipeline-graph 强制边校验", () => {
    const graph = src("src/core/studio-canvas-pipeline-graph.ts");
    expect(graph).toContain("validateStudioCanvasEdges");
    expect(graph).toContain("流水线边校验失败");
  });

  it("OTIO 导出强制 probe", () => {
    const editor = src("src/core/editor.ts");
    expect(editor).toContain("probeStudioOtioDocument");
    expect(editor).toContain("OTIO 导出文档未通过子集 probe");
  });

  it("生成队列 UI 分桶 + 驾驶舱准备/预览", () => {
    const queue = src("src/renderer/src/components/GenerationQueueView.vue");
    expect(queue).toContain("buildStudioGenerationQueueView");
    expect(queue).toContain("generation-queue-lumen-tabs");
    const dash = src("src/renderer/src/components/StudioProductionDashboardView.vue");
    expect(dash).toContain("buildStudioPanelPreparationChecklist");
    expect(dash).toContain("buildStudioGenerationPreflightPreview");
    expect(dash).toContain("dashboard-generation-preflight");
  });

  it("画布 minimap + 工作流组创建", () => {
    const canvas = src("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("@vue-flow/minimap");
    expect(canvas).toContain("createStudioCanvasWorkflowGroup");
    expect(canvas).toContain("createWorkflowFromSelection");
  });
});
