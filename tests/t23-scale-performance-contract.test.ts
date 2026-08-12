import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateT23ScalePerformance,
  T23_SCALE_PERFORMANCE_BUDGET,
  type T23ScalePerformanceMeasurements,
} from "../scripts/lib/t23-scale-performance-contract.js";
import { t23RendererCyclePageFunction } from "../scripts/lib/t23-renderer-cycle-page-function.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const passingMeasurements: T23ScalePerformanceMeasurements = {
  fixtureUnitCount: 36,
  projectedUnitNodeCount: 36,
  uniqueProjectedUnitNodeCount: 36,
  passRawCount: 4,
  uniqueRawShaCount: 4,
  uniqueRawUrlCount: 4,
  referenceCount: 4,
  uniqueReferenceShaCount: 4,
  uniqueReferenceUrlCount: 4,
  devToolchainToCdpReadyMs: 8_000,
  rendererFirstCardMs: 1_000,
  rendererFirstRawMs: 2_000,
  rendererAllPassReferencesMs: 3_000,
  peakOutstandingProjectionIpc: 4,
};

describe("T23 源码 dev 规模硬预算", () => {
  it("同一 Renderer 文档必须原子返回里程碑、IPC 与 raw 快照", () => {
    const source = t23RendererCyclePageFunction.toString();

    const timeline = {
      schemaVersion: 1 as const,
      milestones: [
        { milestone: "canvas-first-card-dom-ready", atMs: 123.4 },
        { milestone: "canvas-raw-span-start:7", atMs: 150 },
        { milestone: "canvas-first-raw-unit:7:S1E01-U01", atMs: 234 },
        { milestone: "canvas-first-raw-ready:7", atMs: 345.6 },
        { milestone: "canvas-all-pass-reference-unit:7:S1E01-U01", atMs: 456 },
        { milestone: "canvas-all-pass-reference-unit:7:S1E01-U02", atMs: 457 },
        { milestone: "canvas-all-pass-references-ready:7", atMs: 567.8 },
        { milestone: "canvas-raw-span-complete:7", atMs: 678 },
      ],
    };
    const rawSnapshot = {
      loading: false,
      unitNodeIds: ["S1E01-U01", "S1E01-U02"],
      corePassUnitIds: ["S1E01-U01", "S1E01-U02"],
      referenceCount: 2,
      referenceUnitIds: ["S1E01-U01", "S1E01-U02"],
      raws: [],
      references: [],
    };
    const probe = {
      enabled: true,
      totalCalls: 8,
      currentOutstanding: 0,
      peakOutstanding: 3,
      channels: [],
      rendererStartupTimeline: timeline,
    };
    const pageWindow = {
      canvasApi: {
        getT23IpcPerformanceProbeSnapshot: () => probe,
      },
      __aiCanvasManagedStudioVerify: {
        getUnitGridRawSnapshot: () => rawSnapshot,
      },
    };
    // new Function 模拟 Playwright 把函数源码送入隔离页面；没有 tsx 宿主 __name。
    const input = { expectedPassUnitIds: ["S1E01-U01", "S1E01-U02"], drainBudgetMs: 5_000 };
    const predicate = new Function("window", "performance", `return (${source});`)(
      pageWindow,
      { timeOrigin: 1_000, now: () => 700 },
    ) as typeof t23RendererCyclePageFunction;
    const result = predicate(input);

    expect(result)
      .toMatchObject({
        ok: true,
        timeOrigin: 1_000,
        rendererFirstCardMs: 123,
        rendererFirstRawMs: 346,
        rendererAllPassReferencesMs: 568,
        rawSnapshot,
        ipcProbe: probe,
      });
    expect(source).not.toContain("__name");
  });

  it("新文档空探针必须等待，同文档完整 timeline 缺 hook 必须明确失败", () => {
    const source = t23RendererCyclePageFunction.toString();
    const createPredicate = (pageWindow: object) => new Function(
      "window",
      "performance",
      `return (${source});`,
    )(pageWindow, { timeOrigin: 2_000, now: () => 900 }) as (
      input: { expectedPassUnitIds: string[]; drainBudgetMs: number },
    ) => unknown;

    expect(createPredicate({
      canvasApi: { getT23IpcPerformanceProbeSnapshot: () => ({ enabled: true, totalCalls: 0 }) },
    })({ expectedPassUnitIds: ["S1E01-U01"], drainBudgetMs: 5_000 })).toBe(false);

    const completeTimeline = {
      schemaVersion: 1,
      milestones: [
        { milestone: "canvas-first-card-dom-ready", atMs: 100 },
        { milestone: "canvas-raw-span-start:1", atMs: 200 },
        { milestone: "canvas-first-raw-unit:1:S1E01-U01", atMs: 300 },
        { milestone: "canvas-first-raw-ready:1", atMs: 400 },
        { milestone: "canvas-all-pass-reference-unit:1:S1E01-U01", atMs: 500 },
        { milestone: "canvas-all-pass-references-ready:1", atMs: 600 },
        { milestone: "canvas-raw-span-complete:1", atMs: 700 },
      ],
    };
    expect(createPredicate({
      canvasApi: {
        getT23IpcPerformanceProbeSnapshot: () => ({
          enabled: true,
          totalCalls: 8,
          currentOutstanding: 0,
          rendererStartupTimeline: completeTimeline,
        }),
      },
    })({ expectedPassUnitIds: ["S1E01-U01"], drainBudgetMs: 5_000 })).toMatchObject({
      ok: false,
      error: "product-hook-missing",
      timeOrigin: 2_000,
    });
  });

  it("App 文档出现后禁止重载重计时，等待总时限固定为 30 秒", () => {
    const smoke = readFileSync(path.join(root, "scripts/t23-scale-performance-dev-smoke.ts"), "utf8");
    expect(smoke).toContain("{ timeout: 30_000 }");
    expect(smoke).toContain("rendererDocumentReloadCount > 0");
    expect(smoke).toContain("rendererCycle.timeOrigin !== initialRendererTimeOrigin");
    expect(smoke).toContain("T23 Renderer 在严格测量期间发生重载");
    expect(smoke).toContain("await launched.page.waitForFunction(");
    expect(smoke).toContain("t23RendererCyclePageFunction,");
    expect(smoke).not.toContain("T23_RENDERER_CYCLE_PAGE_FUNCTION");
    expect(smoke).not.toContain("const expression =");
    expect(smoke).not.toMatch(/contextAttempts\s*<=\s*2/u);
  });

  it("真实首卡必须早于 Canvas/Material overview，raw 必须晚于必要 overview", () => {
    const smoke = readFileSync(path.join(root, "scripts/t23-scale-performance-dev-smoke.ts"), "utf8");
    expect(smoke).toContain('"canvas-raw-activation-start"');
    expect(smoke).toContain('"app-startup-reconcile-start"');
    expect(smoke).toContain('"app-startup-reconcile-ready"');
    expect(smoke).toContain('["app-managed-shell-ready", "app-startup-reconcile-start"]');
    expect(smoke).toContain('["app-startup-reconcile-start", "app-startup-reconcile-ready"]');
    expect(smoke).toContain('["app-startup-reconcile-ready", "canvas-mounted"]');
    expect(smoke).not.toContain('["app-startup-reconcile-ready", "app-managed-studio-chunks-start"]');
    expect(smoke).toContain('["canvas-first-card-dom-ready", "canvas-dashboard-overview-start"]');
    expect(smoke).toContain('["canvas-first-card-dom-ready", "material-overview-start"]');
    expect(smoke).toContain('["canvas-dashboard-overview-ready", "canvas-raw-activation-start"]');
    expect(smoke).toContain('["app-managed-shell-ready", "app-managed-studio-chunks-start"]');
    expect(smoke).toContain('["app-managed-studio-chunks-start", "app-bootstrap-reads-ready"]');
    expect(smoke).toContain('["app-managed-studio-chunks-ready", "canvas-mounted"]');
    expect(smoke).toContain('entry.milestone.startsWith("canvas-first-card-dom-unit:")');
    expect(smoke).toContain("expectedUnitIds.has(firstCardUnitId)");
    expect(smoke).toContain("readLatestT23RawReferenceSpan");
    expect(smoke).toContain("assertCompleteT23RawReferenceSpan");
    expect(smoke).toContain("canvas-raw-span-start");
    expect(smoke).toContain("canvas-first-raw-ready");
    expect(smoke).toContain("canvas-all-pass-references-ready");
    expect(smoke).toContain("canvas-raw-span-complete");
    expect(smoke).not.toContain("app-project-activation-ready");
  });

  it("strict smoke 必须从同一 Renderer 快照验收 units 匿名阶段与查询计数", () => {
    const smoke = readFileSync(path.join(root, "scripts/t23-scale-performance-dev-smoke.ts"), "utf8");
    expect(smoke).toContain("unitsReadTimeline?:");
    expect(smoke).toContain("function assertUnitsReadTimeline");
    expect(smoke).toContain("assertUnitsReadTimeline(probe)");
    expect(smoke).toContain('"main-managed-project-preflight"');
    expect(smoke).toContain('"managed-generation-ledger"');
    expect(smoke).toContain('"production-page"');
    expect(smoke).toContain("productionBusinessSqlExecutions");
    expect(smoke).toContain("unitTimingQueries");
    expect(smoke).toContain("episodeStartQueries");
    expect(smoke).toContain("6 + 2 * counters.returnedUnitCount");
  });

  it("成功与失败证据都只能保存脱敏后的 raw/reference 绑定", () => {
    const smoke = readFileSync(path.join(root, "scripts/t23-scale-performance-dev-smoke.ts"), "utf8");
    const redactionCalls = smoke.match(/redactT23ScaleRendererProbeForEvidence\(rawSnapshot\)/gu) ?? [];

    expect(redactionCalls).toHaveLength(2);
    expect(smoke).not.toContain("pageUrl?: string");
    expect(smoke).not.toContain("bodyText?: string");
    expect(smoke).not.toContain("report.error = error instanceof Error");
    expect(smoke).toContain('report.error = "T23_SMOKE_FAILED"');
  });

  it("全部满足时才 PASS", () => {
    expect(evaluateT23ScalePerformance(passingMeasurements)).toMatchObject({
      ok: true,
      status: "PASS",
      checks: expect.not.arrayContaining([
        expect.objectContaining({ status: "FAIL" }),
      ]),
    });
  });

  it.each([
    ["单元不足", { fixtureUnitCount: 35 }, "fixture-unit-count"],
    ["renderer 单元节点不足", { projectedUnitNodeCount: 35 }, "renderer-unit-node-count"],
    ["renderer 单元节点重复", {
      uniqueProjectedUnitNodeCount: 35,
    }, "renderer-unique-unit-node-count"],
    ["PASS raw 不足", { passRawCount: 3 }, "fixture-pass-raw-count"],
    ["raw SHA 重复", { uniqueRawShaCount: 3 }, "fixture-unique-raw-sha-count"],
    ["raw URL 重复", { uniqueRawUrlCount: 3 }, "renderer-unique-raw-url-count"],
    ["参考不足", { referenceCount: 3 }, "fixture-reference-count"],
    ["参考 SHA 重复", {
      uniqueReferenceShaCount: 3,
    }, "fixture-unique-reference-sha-count"],
    ["参考 URL 重复", {
      uniqueReferenceUrlCount: 3,
    }, "renderer-unique-reference-url-count"],
    ["dev 冷启动超时", {
      devToolchainToCdpReadyMs: T23_SCALE_PERFORMANCE_BUDGET.maxDevToolchainToCdpReadyMs + 1,
    }, "dev-toolchain-to-cdp"],
    ["首卡超时", {
      rendererFirstCardMs: T23_SCALE_PERFORMANCE_BUDGET.maxRendererFirstCardMs + 1,
    }, "renderer-first-card"],
    ["首 raw 超时", {
      rendererFirstRawMs: T23_SCALE_PERFORMANCE_BUDGET.maxRendererFirstRawMs + 1,
    }, "renderer-first-raw"],
    ["全参考超时", {
      rendererAllPassReferencesMs:
        T23_SCALE_PERFORMANCE_BUDGET.maxRendererAllPassReferencesMs + 1,
    }, "renderer-all-pass-references"],
    ["IPC 峰值超限", {
      peakOutstandingProjectionIpc:
        T23_SCALE_PERFORMANCE_BUDGET.maxOutstandingProjectionIpc + 1,
    }, "peak-outstanding-projection-ipc"],
  ])("%s 必须 FAIL，禁止 PASS + WARN", (_label, patch, failedId) => {
    const result = evaluateT23ScalePerformance({ ...passingMeasurements, ...patch });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("FAIL");
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: failedId,
      status: "FAIL",
    }));
  });

  it("NaN 等无效计时同样 fail closed", () => {
    const result = evaluateT23ScalePerformance({
      ...passingMeasurements,
      rendererFirstRawMs: Number.NaN,
    });
    expect(result.status).toBe("FAIL");
    expect(result.checks.find((check) => check.id === "renderer-first-raw")?.status)
      .toBe("FAIL");
  });
});
