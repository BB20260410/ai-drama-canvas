/**
 * 八库残余 TAKE 接线门：managed 生成队列入口 + 工作流重跑 + 驾驶舱首格自动选
 * 结构测驱动真实源码字符串，非假实现。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("八库残余零件吸收 · UI 接线", () => {
  it("受管壳 MaterialStudio 只暴露正式 Studio 生图账本，旧 LumenX 队列仍与受管入口隔离", () => {
    const material = src("src/renderer/src/components/MaterialStudioView.vue");
    expect(material).toContain('data-testid="studio-step-generation"');
    expect(material).toContain('data-testid="studio-generation-pane"');
    expect(material).toContain("AsyncStudioGenerationControlView");
    expect(material).not.toContain("<AsyncGenerationQueueView");
    const formal = src("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(formal).toContain("getStudioGenerationLedgerState");
    expect(formal).toContain("listStudioGenerationPanelHistory");
    const queue = src("src/renderer/src/components/GenerationQueueView.vue");
    expect(queue).toContain("managedEmbed");
    expect(queue).toContain('data-testid="generation-queue-managed-hint"');
    expect(queue).toContain("index?: ProjectIndex");
  });

  it("LocalMiniDrama residual：画布可执行最近工作流组 + IPC", () => {
    const canvas = src("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain('data-testid="managed-canvas-run-workflow"');
    expect(canvas).toContain("runLastWorkflowGroup");
    expect(canvas).toContain("runStudioCanvasWorkflowGroup");
    expect(canvas).toContain('imageMode: "freeze-dispatch-only"');
    const preload = src("src/preload/index.ts");
    expect(preload).toContain("runStudioCanvasWorkflowGroup");
    expect(preload).toContain("canvas:run-studio-canvas-workflow-group");
    const main = src("src/main/index.ts");
    expect(main).toContain("canvas:run-studio-canvas-workflow-group");
    expect(main).toContain("runStudioCanvasWorkflowGroup");
  });

  it("Jellyfish residual：选单元二次拉格 + 准备清单 testid", () => {
    const dash = src("src/renderer/src/components/StudioProductionDashboardView.vue");
    expect(dash).toContain("resolveUnitPanelFetchPlan");
    expect(dash).toContain("needsRefetchWithPanel");
    expect(dash).toContain('data-testid="dashboard-preparation-checklist"');
    const selection = src("src/core/studio-dashboard-unit-selection.ts");
    expect(selection).toContain("resolveUnitPanelFetchPlan");
    expect(selection).toContain("unitDetailHasPrepChecklistSource");
  });

  it("矩阵落盘且 OpenCut 仍 SKIP", () => {
    const matrix = src("docs/ref-study/parts-absorb-residual-matrix-20260718.md");
    expect(matrix).toContain("LocalMiniDrama");
    expect(matrix).toContain("LumenX");
    expect(matrix).toContain("Jellyfish");
    expect(matrix).toContain("OpenCut");
    expect(matrix).toMatch(/OpenCut[\s\S]*SKIP/);
    expect(matrix).not.toContain("第二 SQLite 已落地");
  });

  it("不引入第二 SQLite / 平行 dashboard 写 API", () => {
    const main = src("src/main/index.ts");
    expect(main).not.toMatch(/openDatabase\(["']dashboard/i);
    expect(main).not.toMatch(/second.?sqlite|parallel.?dashboard.?write/i);
    const material = src("src/renderer/src/components/MaterialStudioView.vue");
    expect(material).not.toMatch(/new DatabaseSync|better-sqlite3/);
  });
});
