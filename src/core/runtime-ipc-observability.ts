import type { RuntimeIpcEffect } from "./runtime-ipc-effect.js";

export interface RuntimeIpcChannelMetric {
  channel: string;
  effect: RuntimeIpcEffect;
  calls: number;
  failures: number;
  totalDurationMs: number;
  maxDurationMs: number;
  totalGateDurationMs: number;
  maxGateDurationMs: number;
}

export interface RuntimeIpcPerformanceSnapshot {
  capturedAt: string;
  channels: RuntimeIpcChannelMetric[];
}

export interface RuntimeIpcPerformanceProbe {
  record(input: {
    channel: string;
    effect: RuntimeIpcEffect;
    durationMs: number;
    gateDurationMs: number;
    failed: boolean;
  }): void;
  snapshot(): RuntimeIpcPerformanceSnapshot;
}

/**
 * main 进程的低成本 IPC 计时器。它只保留每通道聚合数字，不保存参数、路径或
 * 返回内容，避免性能诊断本身泄露正式工程数据或成为新状态 owner。
 */
export function createRuntimeIpcPerformanceProbe(
  capturedAt: () => string = () => new Date().toISOString(),
): RuntimeIpcPerformanceProbe {
  const metrics = new Map<string, RuntimeIpcChannelMetric>();
  return {
    record(input) {
      const durationMs = Math.max(0, input.durationMs);
      const gateDurationMs = Math.max(0, Math.min(durationMs, input.gateDurationMs));
      const current = metrics.get(input.channel) ?? {
        channel: input.channel,
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
      metrics.set(input.channel, current);
    },
    snapshot: () => ({
      capturedAt: capturedAt(),
      channels: [...metrics.values()]
        .map((entry) => ({ ...entry }))
        .sort((left, right) => (
          right.totalDurationMs - left.totalDurationMs
          || left.channel.localeCompare(right.channel, "en")
        )),
    }),
  };
}
