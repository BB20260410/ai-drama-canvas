import type { RuntimeMcpEffect } from "./runtime-mcp-effect.js";

export interface RuntimeMcpToolMetric {
  tool: string;
  effect: RuntimeMcpEffect;
  calls: number;
  failures: number;
  totalDurationMs: number;
  maxDurationMs: number;
  totalGateDurationMs: number;
  maxGateDurationMs: number;
}

export interface RuntimeMcpPerformanceSnapshot {
  capturedAt: string;
  tools: RuntimeMcpToolMetric[];
}

export interface RuntimeMcpPerformanceProbe {
  record(input: {
    tool: string;
    effect: RuntimeMcpEffect;
    durationMs: number;
    gateDurationMs: number;
    failed: boolean;
  }): void;
  snapshot(): RuntimeMcpPerformanceSnapshot;
}

/**
 * MCP 的低成本聚合计时器。只记录工具名、耗时与失败次数，不保留参数、项目路径、
 * 返回内容或媒体数据，避免性能诊断成为第二套业务事实源。
 */
export function createRuntimeMcpPerformanceProbe(
  capturedAt: () => string = () => new Date().toISOString(),
): RuntimeMcpPerformanceProbe {
  const metrics = new Map<string, RuntimeMcpToolMetric>();
  return {
    record(input) {
      const durationMs = Math.max(0, input.durationMs);
      const gateDurationMs = Math.max(0, Math.min(durationMs, input.gateDurationMs));
      const current = metrics.get(input.tool) ?? {
        tool: input.tool,
        effect: input.effect,
        calls: 0,
        failures: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        totalGateDurationMs: 0,
        maxGateDurationMs: 0,
      };
      current.calls += 1;
      if (input.failed) current.failures += 1;
      current.totalDurationMs += durationMs;
      current.maxDurationMs = Math.max(current.maxDurationMs, durationMs);
      current.totalGateDurationMs += gateDurationMs;
      current.maxGateDurationMs = Math.max(current.maxGateDurationMs, gateDurationMs);
      metrics.set(input.tool, current);
    },
    snapshot: () => ({
      capturedAt: capturedAt(),
      tools: [...metrics.values()]
        .map((entry) => ({ ...entry }))
        .sort((left, right) => (
          right.totalDurationMs - left.totalDurationMs
          || left.tool.localeCompare(right.tool, "en")
        )),
    }),
  };
}
