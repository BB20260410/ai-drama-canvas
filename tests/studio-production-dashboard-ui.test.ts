import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import {
  createDashboardLoadController,
  createStudioDashboardRequestCoalescer,
  dashboardRequestToken,
  type StudioProductionDashboardUiApi,
} from "../src/renderer/src/studio-production-dashboard-store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function dashboardSource(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/StudioProductionDashboardView.vue"), "utf8");
}

function expectMarkerInsideCollapsedDetails(template: string, marker: string): void {
  const position = template.indexOf(marker);
  expect(position).toBeGreaterThanOrEqual(0);
  expect(template.lastIndexOf("<details", position)).toBeGreaterThan(template.lastIndexOf("</details>", position));
  expect(template).not.toContain("<details open");
}

describe("P8 Dashboard UI 源码合同", () => {
  it("画布源码暴露时间线进度过滤入口并调用 Core filter", () => {
    const canvas = readFileSync("src/renderer/src/components/ManagedStudioCanvasView.vue", "utf8");
    expect(canvas).toContain('data-testid="managed-canvas-timeline-progress-filter"');
    expect(canvas).toContain("filterStudioCanvasTimelineProgress");
    expect(canvas).toContain("timelineProgressQuery");
  });

  it("前端源码不自行推导业务 nextAction，仅展示 Core 投影", () => {
    const app = readFileSync(path.join(root, "src/renderer/src/App.vue"), "utf8");
    expect(app).toContain("getStudioProductionDashboard");
    expect(app).toContain("dashboardOverview.nextAction");
    expect(app).not.toMatch(/const nextAction = counts\.scripts === 0/);

    const view = readFileSync(path.join(root, "src/renderer/src/components/StudioProductionDashboardView.vue"), "utf8");
    expect(view).toContain("data-testid=\"studio-production-dashboard-view\"");
    expect(view).toContain("currentNextAction");
    expect(view).toContain("limit: 36");
    expect(view).not.toMatch(/counts\.scripts === 0\s*\?\s*[\"']导入/);
  });

  it("异步 token 绑定 projectRoot+query，切项目使旧响应失效", () => {
    const controller = createDashboardLoadController();
    const tokenA = controller.begin("/tmp/project-a", { operation: "overview" });
    expect(controller.isCurrent(tokenA)).toBe(true);
    const tokenB = controller.begin("/tmp/project-b", { operation: "overview" });
    expect(controller.isCurrent(tokenA)).toBe(false);
    expect(controller.isCurrent(tokenB)).toBe(true);
    controller.invalidate();
    expect(controller.isCurrent(tokenB)).toBe(false);
    expect(dashboardRequestToken("/tmp/x", { operation: "units", limit: 36 }))
      .toContain("units");
  });

  it("overview/units/unit 等操作使用独立 stream token，互不取消", () => {
    const controller = createDashboardLoadController();
    const overview = controller.begin("/tmp/p", { operation: "overview" });
    const units = controller.begin("/tmp/p", { operation: "units", limit: 36 });
    const unit = controller.begin("/tmp/p", {
      operation: "unit",
      unitId: "u1",
      panelId: "p1",
    });
    expect(controller.isCurrent(overview, { operation: "overview" })).toBe(true);
    expect(controller.isCurrent(units, { operation: "units", limit: 36 })).toBe(true);
    expect(controller.isCurrent(unit, { operation: "unit", unitId: "u1", panelId: "p1" })).toBe(true);
    // 同 stream 新请求使旧 overview 失效，但不影响 units
    const overview2 = controller.begin("/tmp/p", { operation: "overview" });
    expect(controller.isCurrent(overview, { operation: "overview" })).toBe(false);
    expect(controller.isCurrent(overview2, { operation: "overview" })).toBe(true);
    expect(controller.isCurrent(units, { operation: "units", limit: 36 })).toBe(true);
  });

  it("同工程并发 overview 共享进行中请求，完成后不缓存结果", async () => {
    type DashboardResponse = Awaited<ReturnType<StudioProductionDashboardUiApi["getDashboard"]>>;
    let overviewCalls = 0;
    const overviewResult = { operation: "overview" } as DashboardResponse;
    let resolveOverview!: (value: DashboardResponse) => void;
    const firstOverview = new Promise<DashboardResponse>((resolve) => {
      resolveOverview = resolve;
    });
    const api = createStudioDashboardRequestCoalescer({
      getDashboard: async (_projectRoot, query) => {
        if (query.operation === "overview") {
          overviewCalls += 1;
          if (overviewCalls === 1) return firstOverview;
        }
        return { operation: query.operation } as DashboardResponse;
      },
    });

    const first = api.getDashboard("/tmp/project-a", { operation: "overview" });
    const duplicate = api.getDashboard("/tmp/project-a", { operation: "overview" });
    expect(overviewCalls).toBe(1);
    resolveOverview(overviewResult);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { operation: "overview" },
      { operation: "overview" },
    ]);

    await api.getDashboard("/tmp/project-a", { operation: "overview" });
    expect(overviewCalls).toBe(2);
  });

  it("宫格选择与打开画布是同级按钮，异常队列和资产出场均可双向翻页", () => {
    const view = dashboardSource();
    const parsed = parse(view, { filename: "StudioProductionDashboardView.vue" });
    expect(parsed.errors).toEqual([]);
    const template = parsed.descriptor.template?.content ?? "";
    expect(template).toMatch(/<article[\s\S]{0,180}class="panel-card"/u);
    expect(template).toContain('class="panel-select"');
    expect(template).toContain('class="open-canvas-link panel-canvas-action"');
    expect(template).toContain('data-testid="dashboard-open-continuity-review"');
    expect(view).toContain("function openContinuityReview");
    expect(view).toContain('emit("openReview"');
    expect(view).toContain("getCheckpointCanvasProjection");
    expect(view).toContain("readContinuityEvidenceWithin");
    expect(view).toContain('generationTarget: { targetKind: "unit-grid"');
    expect(template).not.toMatch(/<button[\s\S]{0,180}class="panel-card"/u);
    for (const marker of [
      'data-testid="dashboard-queue-pager"',
      'data-testid="dashboard-appearances-pager"',
      "queueNext",
      "queuePrev",
      "appearancesNext",
      "appearancesPrev",
      "queueCursorStack",
      "appearancesCursorStack",
    ]) expect(view).toContain(marker);
  });

  it("生成预检使用 Material Studio 显式供应方，未知队列数量交给正式受管账本且不伪造零", () => {
    const view = dashboardSource();
    expect(view).toContain('generationProvider: "codex" | "grok"');
    expect(view).toContain("provider: props.generationProvider");
    expect(view).toContain("providerLabel(generationPreflight.provider)");
    expect(view).not.toContain("queueInFlight: 0");
    expect(view).toContain("generationQueueInFlightFromFormalProjection");
    expect(view).toContain("进行中数量由受管账本决定");
    expect(view).toContain("queueInFlightKnown");
  });

  it("并发查询 busy 按 token/stream 独立结算，单一流完成不会误清其他流", () => {
    const view = dashboardSource();
    for (const marker of [
      "queryBusyTokens",
      "markQueryBusy(token, query.operation)",
      "clearQueryBusy(token)",
      "isStreamBusy('units')",
      "isStreamBusy('queue')",
      "isStreamBusy('appearances')",
    ]) expect(view).toContain(marker);
    expect(view).not.toContain("loading.value = false");
  });

  it("局部 Core 硬停机优先于概览导航提示，命令、指纹和内部资产 ID 仅在折叠诊断中", () => {
    const view = dashboardSource();
    const template = parse(view, { filename: "StudioProductionDashboardView.vue" }).descriptor.template?.content ?? "";
    const nextActionStart = view.indexOf("const currentNextAction");
    const nextActionEnd = view.indexOf("const preparationChecklist", nextActionStart);
    const nextAction = view.slice(nextActionStart, nextActionEnd);
    expect(nextAction).toContain("isHardSafetyNextAction(unitAction)");
    expect(view).toContain('action?.code === "generation-projection-degraded"');
    expect(view).toContain('action?.code === "continuity-opaque"');
    expect(nextAction.indexOf("if (isHardSafetyNextAction(unitAction))")).toBeLessThan(nextAction.indexOf("overview.value?.nextAction"));
    for (const marker of [
      "{{ currentNextAction.command }}",
      "{{ asset.assetId }}",
      "unitDetail.selectedPanel.panel.bindingFingerprint",
      "{{ shortHash(overview.fingerprint) }}",
    ]) expectMarkerInsideCollapsedDetails(template, marker);
    const core = readFileSync(path.join(root, "src/core/studio-production-dashboard.ts"), "utf8");
    expect(core).toContain("resolvedGenerationRunId");
    expect(core).toContain("unitGridFreezeBlockNextAction");
    expect(core).toContain('label: "补齐真实连续性状态"');
    expect(core).toContain("unit-grid 冻结预检");
    expect(core).toContain('unitGridNext?.code === "continuity-opaque"');
    expect(core).toContain("连续性仍含内部定位；先录入真实视觉状态，禁止冻结或重新派发。");
    expect(core).toContain("unit: StudioDashboardUnitSummary & { revision: number }");
    expect(core).toContain("readStudioContinuityEntry");
    expect(core).toContain("P0 必须聚焦到 freeze gate 真正指出的宫格");
  });
});
