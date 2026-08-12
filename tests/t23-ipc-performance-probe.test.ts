import { describe, expect, it } from "vitest";
import { createT23IpcPerformanceProbe } from "../src/preload/t23-ipc-performance-probe.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function unitsReadTimeline(durationMs = 25) {
  return {
    schemaVersion: 1 as const,
    phases: [
      { phase: "main-managed-project-preflight", startOffsetMs: 0, durationMs: 5 },
      { phase: "dashboard-core-total", startOffsetMs: 5, durationMs },
    ],
    counters: {
      managedProjectShellInspections: 4,
      generationLedgerEnsureCalls: 1,
      generationLedgerInitializationStarts: 1,
      generationLedgerInitializationJoins: 0,
      productionDirectoryEnsureCalls: 4,
      productionOpenDatabaseCalls: 4,
      productionReadOnlyProbeConnections: 4,
      productionOwnerConnections: 4,
      productionBusinessSqlExecutions: 78,
      unitPageQueries: 1,
      unitTimingQueries: 36,
      episodeStartQueries: 36,
      facetQueries: 3,
      bindingHeadQueries: 1,
      successorQueries: 1,
      productionSchemaCacheHits: 3,
      productionSchemaCacheMisses: 1,
      returnedUnitCount: 36,
    },
  };
}

describe("T23 IPC 性能探针", () => {
  it("关闭时完全透传且不累计生产调用", async () => {
    let clockReads = 0;
    const probe = createT23IpcPerformanceProbe(
      false,
      async <T>(_channel: string, value: unknown) => value as T,
      () => {
        clockReads += 1;
        return 0;
      },
    );
    await expect(probe.invoke<string>("canvas:fixture", "ok")).resolves.toBe("ok");
    expect(clockReads).toBe(0);
    expect(probe.snapshot()).toEqual({
      enabled: false,
      totalCalls: 0,
      completedCalls: 0,
      currentOutstanding: 0,
      peakOutstanding: 0,
      totalDurationMs: 0,
      averageDurationMs: null,
      maxDurationMs: null,
      lastDurationMs: null,
      channels: [],
    });
  });

  it("只在显式启用时记录有界 renderer 冷启动里程碑", () => {
    const disabled = createT23IpcPerformanceProbe(false, async <T>() => undefined as T);
    disabled.recordRendererMilestone("app-mounted", 12);
    expect(disabled.snapshot().rendererStartupTimeline).toBeUndefined();

    const enabled = createT23IpcPerformanceProbe(true, async <T>() => undefined as T);
    enabled.recordRendererMilestone("app-mounted", 12.5);
    enabled.recordRendererMilestone("canvas-units-ready", 48.25);
    enabled.recordRendererMilestone("", 50);
    enabled.recordRendererMilestone("x".repeat(81), 51);
    enabled.recordRendererMilestone("invalid-time", Number.NaN);
    expect(enabled.snapshot().rendererStartupTimeline).toEqual({
      schemaVersion: 1,
      milestones: [
        { milestone: "app-mounted", atMs: 12.5 },
        { milestone: "canvas-units-ready", atMs: 48.25 },
      ],
    });
  });

  it("记录全局与逐通道峰值，并在成功/失败后都归零", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let call = 0;
    let nowMs = 100;
    const probe = createT23IpcPerformanceProbe(true, async <T>() => {
      call += 1;
      return (call === 1 ? first.promise : second.promise) as Promise<T>;
    }, () => nowMs);

    const firstCall = probe.invoke<string>("canvas:get-studio-media");
    nowMs = 110;
    const secondCall = probe.invoke<string>("canvas:get-studio-media");
    expect(probe.snapshot()).toMatchObject({
      enabled: true,
      totalCalls: 2,
      completedCalls: 0,
      currentOutstanding: 2,
      peakOutstanding: 2,
      totalDurationMs: 0,
      averageDurationMs: null,
      maxDurationMs: null,
      lastDurationMs: null,
      channels: [{
        channel: "canvas:get-studio-media",
        totalCalls: 2,
        completedCalls: 0,
        currentOutstanding: 2,
        peakOutstanding: 2,
        totalDurationMs: 0,
        averageDurationMs: null,
        maxDurationMs: null,
        lastDurationMs: null,
      }],
    });

    nowMs = 140;
    first.resolve("done");
    await expect(firstCall).resolves.toBe("done");
    nowMs = 190;
    second.reject(new Error("fixture failure"));
    await expect(secondCall).rejects.toThrow("fixture failure");
    expect(probe.snapshot()).toMatchObject({
      totalCalls: 2,
      completedCalls: 2,
      currentOutstanding: 0,
      peakOutstanding: 2,
      totalDurationMs: 120,
      averageDurationMs: 60,
      maxDurationMs: 80,
      lastDurationMs: 80,
      channels: [{
        completedCalls: 2,
        currentOutstanding: 0,
        peakOutstanding: 2,
        totalDurationMs: 120,
        averageDurationMs: 60,
        maxDurationMs: 80,
        lastDurationMs: 80,
      }],
    });
  });

  it("按通道独立聚合完成时长，包含失败调用", async () => {
    let nowMs = 1_000;
    const media = deferred<string>();
    const dashboard = deferred<string>();
    let call = 0;
    const probe = createT23IpcPerformanceProbe(true, async <T>() => {
      call += 1;
      return (call === 1 ? media.promise : dashboard.promise) as Promise<T>;
    }, () => nowMs);

    const mediaCall = probe.invoke<string>("canvas:get-studio-media");
    nowMs = 1_010;
    const dashboardCall = probe.invoke<string>("canvas:get-studio-production-dashboard");
    nowMs = 1_040;
    media.resolve("media");
    await expect(mediaCall).resolves.toBe("media");
    nowMs = 1_070;
    dashboard.reject(new Error("dashboard failed"));
    await expect(dashboardCall).rejects.toThrow("dashboard failed");

    expect(probe.snapshot().channels).toEqual([
      {
        channel: "canvas:get-studio-media",
        totalCalls: 1,
        completedCalls: 1,
        currentOutstanding: 0,
        peakOutstanding: 1,
        totalDurationMs: 40,
        averageDurationMs: 40,
        maxDurationMs: 40,
        lastDurationMs: 40,
      },
      {
        channel: "canvas:get-studio-production-dashboard",
        totalCalls: 1,
        completedCalls: 1,
        currentOutstanding: 0,
        peakOutstanding: 1,
        totalDurationMs: 60,
        averageDurationMs: 60,
        maxDurationMs: 60,
        lastDurationMs: 60,
      },
    ]);
  });

  it("只在显式探针结果中保留最后一次有界深投影阶段，不改写 IPC 返回值", async () => {
    let nowMs = 0;
    const response = {
      kind: "studio-production-projection-bundle",
      __t23ProjectionTimeline: {
        schemaVersion: 1,
        phases: [
          { phase: "main-managed-project-preflight", durationMs: 2 },
          { phase: "panel-fanout", durationMs: 31, panelCount: 6, controlAssetCount: 9 },
          { phase: "core-total", durationMs: 45 },
        ],
      },
    };
    const probe = createT23IpcPerformanceProbe(true, async <T>() => response as T, () => nowMs);
    const pending = probe.invoke<typeof response>("canvas:get-studio-production-projection-bundle");
    nowMs = 50;
    await expect(pending).resolves.toBe(response);
    expect(probe.snapshot().projectionTimeline).toEqual(response.__t23ProjectionTimeline);
  });

  it("只从 units Dashboard 响应捕获有界匿名读链，不让其他 operation 覆盖", async () => {
    const timeline = unitsReadTimeline();
    let response: unknown = { operation: "units", __t23UnitsReadTimeline: timeline };
    const probe = createT23IpcPerformanceProbe(true, async <T>() => response as T);

    const unitsResult = await probe.invoke(
      "canvas:get-studio-production-dashboard",
      "/fixture/project",
      { operation: "units", limit: 36 },
    );
    expect(unitsResult).toBe(response);
    expect(probe.snapshot().unitsReadTimeline).toEqual(timeline);

    response = {
      operation: "overview",
      __t23UnitsReadTimeline: unitsReadTimeline(999),
    };
    await probe.invoke(
      "canvas:get-studio-production-dashboard",
      "/fixture/project",
      { operation: "overview" },
    );
    expect(probe.snapshot().unitsReadTimeline).toEqual(timeline);
    expect(JSON.stringify(probe.snapshot().unitsReadTimeline)).not.toMatch(/fixture|sqlite|SELECT/u);
  });

  it("units 最新请求失败后保持空，旧成功迟到不得恢复陈旧读链", async () => {
    const old = deferred<unknown>();
    let call = 0;
    const probe = createT23IpcPerformanceProbe(true, async <T>() => {
      call += 1;
      if (call === 1) return old.promise as Promise<T>;
      throw new Error("latest units failed");
    });
    const oldPending = probe.invoke(
      "canvas:get-studio-production-dashboard",
      "/fixture/project",
      { operation: "units", limit: 36 },
    );
    await expect(probe.invoke(
      "canvas:get-studio-production-dashboard",
      "/fixture/project",
      { operation: "units", limit: 36 },
    )).rejects.toThrow("latest units failed");
    old.resolve({ __t23UnitsReadTimeline: unitsReadTimeline(99) });
    await oldPending;
    expect(probe.snapshot().unitsReadTimeline).toBeUndefined();
  });

  it("拒绝非法 units 阶段或计数，不把未验证诊断写入快照", async () => {
    const invalid = unitsReadTimeline();
    invalid.counters.unitTimingQueries = -1;
    const probe = createT23IpcPerformanceProbe(true, async <T>() => ({
      __t23UnitsReadTimeline: invalid,
    }) as T);
    await probe.invoke(
      "canvas:get-studio-production-dashboard",
      "/fixture/project",
      { operation: "units", limit: 36 },
    );
    expect(probe.snapshot().unitsReadTimeline).toBeUndefined();
  });

  it("深投影失败会清除上一条成功 timeline，禁止陈旧诊断冒充本次结果", async () => {
    const response = {
      __t23ProjectionTimeline: {
        schemaVersion: 1,
        phases: [{ phase: "core-total", durationMs: 12 }],
      },
    };
    let fail = false;
    const probe = createT23IpcPerformanceProbe(true, async <T>() => {
      if (fail) throw new Error("fixture failure");
      return response as T;
    });
    await probe.invoke("canvas:get-studio-production-projection-bundle");
    expect(probe.snapshot().projectionTimeline).toBeDefined();
    fail = true;
    await expect(probe.invoke("canvas:get-studio-production-projection-bundle")).rejects.toThrow("fixture failure");
    expect(probe.snapshot().projectionTimeline).toBeUndefined();
  });

  it("并发旧请求成功、最新请求失败时不遗留旧 timeline", async () => {
    let resolveOld!: (value: unknown) => void;
    let rejectLatest!: (error: Error) => void;
    const old = new Promise((resolve) => { resolveOld = resolve; });
    const latest = new Promise((_, reject) => { rejectLatest = reject; });
    let call = 0;
    const probe = createT23IpcPerformanceProbe(true, async <T>() => (
      (++call === 1 ? old : latest) as Promise<T>
    ));
    const oldPending = probe.invoke("canvas:get-studio-production-projection-bundle");
    const latestPending = probe.invoke("canvas:get-studio-production-projection-bundle");
    resolveOld({
      __t23ProjectionTimeline: {
        schemaVersion: 1,
        phases: [{ phase: "core-total", durationMs: 10 }],
      },
    });
    await oldPending;
    rejectLatest(new Error("latest failed"));
    await expect(latestPending).rejects.toThrow("latest failed");
    expect(probe.snapshot()).toMatchObject({ currentOutstanding: 0 });
    expect(probe.snapshot().projectionTimeline).toBeUndefined();
  });

  it("最新请求成功后，旧请求迟到成功也不能覆盖最新 timeline", async () => {
    let resolveOld!: (value: unknown) => void;
    let resolveLatest!: (value: unknown) => void;
    const old = new Promise((resolve) => { resolveOld = resolve; });
    const latest = new Promise((resolve) => { resolveLatest = resolve; });
    let call = 0;
    const probe = createT23IpcPerformanceProbe(true, async <T>() => (
      (++call === 1 ? old : latest) as Promise<T>
    ));
    const oldPending = probe.invoke("canvas:get-studio-production-projection-bundle");
    const latestPending = probe.invoke("canvas:get-studio-production-projection-bundle");
    const latestTimeline = {
      schemaVersion: 1,
      phases: [{ phase: "core-total", durationMs: 20 }],
    } as const;
    resolveLatest({ __t23ProjectionTimeline: latestTimeline });
    await latestPending;
    resolveOld({
      __t23ProjectionTimeline: {
        schemaVersion: 1,
        phases: [{ phase: "core-total", durationMs: 99 }],
      },
    });
    await oldPending;
    expect(probe.snapshot().projectionTimeline).toEqual(latestTimeline);
  });
});
