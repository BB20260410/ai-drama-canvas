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
});
