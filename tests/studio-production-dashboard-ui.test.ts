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

  it("冷启动默认 units 共享进行中请求，并把刚完成的 prefetch 一次性交给首卡 waiter", async () => {
    type DashboardResponse = Awaited<ReturnType<StudioProductionDashboardUiApi["getDashboard"]>>;
    let unitsCalls = 0;
    let resolveUnits!: (value: DashboardResponse) => void;
    const firstUnits = new Promise<DashboardResponse>((resolve) => {
      resolveUnits = resolve;
    });
    let clock = 1_000;
    const api = createStudioDashboardRequestCoalescer({
      getDashboard: async (_projectRoot, query) => {
        if (query.operation === "units") {
          unitsCalls += 1;
          if (unitsCalls === 1) return firstUnits;
        }
        return { operation: query.operation } as DashboardResponse;
      },
    }, { now: () => clock, firstCardUnitsHoldMs: 200 });

    const prefetched = api.getDashboard("/tmp/project-a", { operation: "units", limit: 36 });
    const canvasRead = api.getDashboard("/tmp/project-a", { operation: "units", limit: 36 });
    const differentCursor = api.getDashboard("/tmp/project-a", {
      operation: "units",
      limit: 36,
      cursor: "next",
    });
    const differentProject = api.getDashboard("/tmp/project-b", { operation: "units", limit: 36 });
    expect(unitsCalls).toBe(3);

    resolveUnits({ operation: "units" } as DashboardResponse);
    await expect(Promise.all([prefetched, canvasRead, differentCursor, differentProject])).resolves.toHaveLength(4);
    await api.getDashboard("/tmp/project-a", { operation: "units", limit: 36 });
    expect(unitsCalls).toBe(3);

    await api.getDashboard("/tmp/project-a", { operation: "units", limit: 36 });
    expect(unitsCalls).toBe(4);

    clock += 201;
    await api.getDashboard("/tmp/project-a", { operation: "units", limit: 36 });
    expect(unitsCalls).toBe(5);
  });

  it("失败的 units prefetch 不进入首卡 hold", async () => {
    type DashboardResponse = Awaited<ReturnType<StudioProductionDashboardUiApi["getDashboard"]>>;
    let unitsCalls = 0;
    const api = createStudioDashboardRequestCoalescer({
      getDashboard: async (_projectRoot, query) => {
        if (query.operation === "units") {
          unitsCalls += 1;
          if (unitsCalls === 1) throw new Error("prefetch failed");
        }
        return { operation: query.operation } as DashboardResponse;
      },
    });
    await expect(api.getDashboard("/tmp/project-a", { operation: "units", limit: 36 }))
      .rejects.toThrow(/prefetch failed/u);
    await expect(api.getDashboard("/tmp/project-a", { operation: "units", limit: 36 }))
      .resolves.toMatchObject({ operation: "units" });
    expect(unitsCalls).toBe(2);
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
    expect(core).toContain("persistedUnitGridPackId");
    expect(core).toContain("getStudioGenerationLatestPlanForUnitGrid");
    expect(core).toContain("hasCurrentPlan");
    expect(core).toContain("readiness 候选不当冻结包");
    expect(core).toContain('unitGridNext?.code === "continuity-opaque"');
    expect(core).toContain("连续性仍含内部定位；先录入真实视觉状态，禁止冻结或重新派发。");
    expect(core).toContain("unit: StudioDashboardUnitSummary & { revision: number }");
    expect(core).toContain("readStudioContinuityEntry");
    expect(core).toContain("P0 必须聚焦到 freeze gate 真正指出的宫格");
  });

  it("驾驶舱头栏下一动作诊断 summary 含 testid，不铺单元/资产/页脚", () => {
    const view = dashboardSource();
    expect(view).toContain('data-testid="dashboard-next-action"');
    expect(view).toContain('data-testid="studio-dashboard-next-action-diagnostics"');
    expect(view).toContain('<summary data-testid="studio-dashboard-next-action-diagnostics">诊断详情</summary>');
    expect(view).toContain("{{ currentNextAction.command }}");
    expect(view).not.toContain("studio-dashboard-next-action-diagnostics-");
    expect(view).not.toContain('dashboard-next-action" role="dialog"');
    expect(view).toContain("{{ shortHash(overview.fingerprint) }}");
  });

  it("驾驶舱单元遗留诊断 summary 含 testid，不铺头栏/资产/页脚", () => {
    const view = dashboardSource();
    expect(view).toContain('class="detail-block diagnostic-details legacy-diagnostics"');
    expect(view).toContain('data-testid="studio-dashboard-unit-diagnostics"');
    expect(view).toContain('<summary data-testid="studio-dashboard-unit-diagnostics">诊断详情</summary>');
    expect(view).toContain("unitDetail.selectedPanel.legacy.sourceShot");
    expect(view).not.toContain("studio-dashboard-unit-diagnostics-");
    expect(view).toContain('data-testid="studio-dashboard-next-action-diagnostics"');
  });

  it("驾驶舱控制资产诊断 summary 含共享 testid，不铺准备清单/页脚", () => {
    const view = dashboardSource();
    expect(view).toContain('data-testid="dashboard-control-assets"');
    expect(view).toContain('data-testid="studio-dashboard-asset-diagnostics"');
    expect(view).toContain('<summary data-testid="studio-dashboard-asset-diagnostics">诊断详情</summary>');
    expect(view).toContain("{{ asset.assetId }}");
    expect(view).not.toContain("studio-dashboard-asset-diagnostics-");
    expect(view).toContain('data-testid="studio-dashboard-next-action-diagnostics"');
    expect(view).toContain('data-testid="studio-dashboard-unit-diagnostics"');
  });

  it("驾驶舱页脚状态指纹诊断 summary 含 testid，不铺准备清单/预览/绑定指纹", () => {
    const view = dashboardSource();
    expect(view).toContain('data-testid="dashboard-counts"');
    expect(view).toContain('class="dashboard-footer"');
    expect(view).toContain('data-testid="studio-dashboard-overview-diagnostics"');
    expect(view).toContain('<summary data-testid="studio-dashboard-overview-diagnostics">诊断详情</summary>');
    expect(view).toContain("状态指纹：{{ shortHash(overview.fingerprint) }}");
    expect(view).not.toContain("studio-dashboard-overview-diagnostics-");
    expect(view).toContain('data-testid="studio-dashboard-next-action-diagnostics"');
    expect(view).toContain('data-testid="studio-dashboard-asset-diagnostics"');
    expect(view).toContain('data-testid="studio-dashboard-unit-diagnostics"');
  });

  it("驾驶舱准备清单诊断 summary 含共享 testid，不铺预览/绑定指纹", () => {
    const view = dashboardSource();
    expect(view).toContain('data-testid="dashboard-preparation-checklist"');
    expect(view).toContain('data-testid="studio-dashboard-prep-diagnostics"');
    expect(view).toContain('<summary data-testid="studio-dashboard-prep-diagnostics">诊断详情</summary>');
    expect(view).toContain("{{ item.reason }}");
    expect(view).not.toContain("studio-dashboard-prep-diagnostics-");
    expect(view).toContain('data-testid="studio-dashboard-overview-diagnostics"');
  });

  it("驾驶舱生成前预览诊断 summary 含共享 testid，不铺绑定指纹", () => {
    const view = dashboardSource();
    expect(view).toContain('data-testid="dashboard-generation-preflight"');
    expect(view).toContain('data-testid="studio-dashboard-preflight-diagnostics"');
    expect(view).toContain('<summary data-testid="studio-dashboard-preflight-diagnostics">诊断详情</summary>');
    expect(view).toContain("{{ reason }}");
    expect(view).not.toContain("studio-dashboard-preflight-diagnostics-");
    expect(view).toContain('data-testid="studio-dashboard-prep-diagnostics"');
    expect(view).toContain('data-testid="studio-dashboard-overview-diagnostics"');
    expect(view).toContain("Binding 指纹：{{ shortHash(unitDetail.selectedPanel.panel.bindingFingerprint) }}");
  });

  it("驾驶舱绑定指纹诊断 summary 含 testid，不抢头栏/页脚/资产", () => {
    const view = dashboardSource();
    expect(view).toContain("unitDetail.selectedPanel.panel.bindingFingerprint");
    expect(view).toContain('data-testid="studio-dashboard-binding-diagnostics"');
    expect(view).toContain('<summary data-testid="studio-dashboard-binding-diagnostics">诊断详情</summary>');
    expect(view).toContain("Binding 指纹：{{ shortHash(unitDetail.selectedPanel.panel.bindingFingerprint) }}");
    expect(view).not.toContain("studio-dashboard-binding-diagnostics-");
    expect(view).not.toContain('bindingFingerprint" role="dialog"');
    expect(view).toContain('data-testid="studio-dashboard-next-action-diagnostics"');
    expect(view).toContain('data-testid="studio-dashboard-overview-diagnostics"');
    expect(view).toContain('data-testid="studio-dashboard-asset-diagnostics"');
    expect(view).toContain('data-testid="studio-dashboard-prep-diagnostics"');
    expect(view).toContain('data-testid="studio-dashboard-preflight-diagnostics"');
    expect(view).not.toContain("<summary>诊断详情</summary>");
  });
});

describe("P8 Dashboard 队列/单元行视口剔除", () => {
  it("queue-entry 与 unit-entry 使用 content-visibility，离屏条目跳过同步布局", () => {
    const view = dashboardSource();
    expect(view).toContain('class="queue-entry"');
    expect(view).toContain('class="unit-entry"');
    expect(view).toContain("limit: 36");
    expect(view).toContain(".left-rail,\n.right-rail,\n.center-stage {\n  min-height: 0;\n  overflow: auto;");
    expect(view).toContain(".unit-entry,\n.queue-entry {\n  content-visibility: auto;\n  contain-intrinsic-size: auto 52px;\n}");
    expect(view).not.toMatch(/\.queue-entry \{[^}]*content-visibility:\s*hidden/);
    expect(view).not.toMatch(/\.unit-entry \{[^}]*content-visibility:\s*hidden/);
  });

  it("appearances 行使用 content-visibility，离屏出场条目跳过同步布局", () => {
    const view = dashboardSource();
    expect(view).toContain('data-testid="dashboard-appearances"');
    expect(view).toContain('data-testid="dashboard-appearances-pager"');
    expect(view).toContain("[data-testid=\"dashboard-appearances\"] button {\n  content-visibility: auto;\n  contain-intrinsic-size: auto 40px;\n}");
    expect(view).not.toMatch(/\[data-testid="dashboard-appearances"\] button \{[^}]*content-visibility:\s*hidden/);
  });
});
