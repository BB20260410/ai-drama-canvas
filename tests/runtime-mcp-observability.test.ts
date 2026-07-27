import { describe, expect, it } from "vitest";
import { createRuntimeMcpPerformanceProbe } from "../src/core/runtime-mcp-observability.js";

describe("源码 MCP 性能探针", () => {
  it("只聚合工具、门禁耗时和失败次数", () => {
    const probe = createRuntimeMcpPerformanceProbe(() => "2026-07-26T00:00:00.000Z");
    probe.record({
      tool: "get_active_managed_studio_context",
      effect: "read-only",
      durationMs: 12,
      gateDurationMs: 8,
      failed: false,
    });
    probe.record({
      tool: "get_active_managed_studio_context",
      effect: "read-only",
      durationMs: 9,
      gateDurationMs: 4,
      failed: true,
    });
    probe.record({
      tool: "execute_command",
      effect: "mutation",
      durationMs: 5,
      gateDurationMs: 3,
      failed: false,
    });

    expect(probe.snapshot()).toEqual({
      capturedAt: "2026-07-26T00:00:00.000Z",
      tools: [
        {
          tool: "get_active_managed_studio_context",
          effect: "read-only",
          calls: 2,
          failures: 1,
          totalDurationMs: 21,
          maxDurationMs: 12,
          totalGateDurationMs: 12,
          maxGateDurationMs: 8,
        },
        {
          tool: "execute_command",
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

  it("夹紧非法耗时", () => {
    const probe = createRuntimeMcpPerformanceProbe();
    probe.record({
      tool: "probe",
      effect: "diagnostic-read",
      durationMs: -1,
      gateDurationMs: 99,
      failed: false,
    });
    expect(probe.snapshot().tools[0]).toMatchObject({
      totalDurationMs: 0,
      totalGateDurationMs: 0,
    });
  });
});
