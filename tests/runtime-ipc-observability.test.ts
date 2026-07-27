import { describe, expect, it } from "vitest";
import { createRuntimeIpcPerformanceProbe } from "../src/core/runtime-ipc-observability.js";

describe("源码 main IPC 性能探针", () => {
  it("只聚合通道、门禁和失败计数，并按累计耗时排序", () => {
    const probe = createRuntimeIpcPerformanceProbe(() => "2026-07-26T00:00:00.000Z");
    probe.record({
      channel: "canvas:get-active-project",
      effect: "read-only",
      durationMs: 12,
      gateDurationMs: 8,
      failed: false,
    });
    probe.record({
      channel: "canvas:get-active-project",
      effect: "read-only",
      durationMs: 9,
      gateDurationMs: 4,
      failed: true,
    });
    probe.record({
      channel: "canvas:execute-studio-command",
      effect: "mutation",
      durationMs: 5,
      gateDurationMs: 3,
      failed: false,
    });

    expect(probe.snapshot()).toEqual({
      capturedAt: "2026-07-26T00:00:00.000Z",
      channels: [
        {
          channel: "canvas:get-active-project",
          effect: "read-only",
          calls: 2,
          failures: 1,
          totalDurationMs: 21,
          maxDurationMs: 12,
          totalGateDurationMs: 12,
          maxGateDurationMs: 8,
        },
        {
          channel: "canvas:execute-studio-command",
          effect: "mutation",
          calls: 1,
          failures: 0,
          totalDurationMs: 5,
          maxDurationMs: 5,
          totalGateDurationMs: 3,
          maxGateDurationMs: 3,
        },
      ],
    });
  });

  it("拒绝负耗时和大于总耗时的门禁耗时污染指标", () => {
    const probe = createRuntimeIpcPerformanceProbe();
    probe.record({
      channel: "canvas:probe",
      effect: "diagnostic-read",
      durationMs: -5,
      gateDurationMs: 99,
      failed: false,
    });
    expect(probe.snapshot().channels[0]).toMatchObject({
      totalDurationMs: 0,
      totalGateDurationMs: 0,
    });
  });
});
