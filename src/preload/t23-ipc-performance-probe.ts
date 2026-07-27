export interface T23IpcPerformanceChannelSnapshot {
  channel: string;
  totalCalls: number;
  completedCalls: number;
  currentOutstanding: number;
  peakOutstanding: number;
  totalDurationMs: number;
  averageDurationMs: number | null;
  maxDurationMs: number | null;
  lastDurationMs: number | null;
}

export interface T23IpcPerformanceProbeSnapshot {
  enabled: boolean;
  totalCalls: number;
  completedCalls: number;
  currentOutstanding: number;
  peakOutstanding: number;
  totalDurationMs: number;
  averageDurationMs: number | null;
  maxDurationMs: number | null;
  lastDurationMs: number | null;
  channels: T23IpcPerformanceChannelSnapshot[];
}

export interface T23IpcPerformanceProbe {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
  snapshot(): T23IpcPerformanceProbeSnapshot;
}

/**
 * T23 源码 dev 规模验收专用只读探针。
 *
 * 生产默认关闭；只有显式设置 AI_CANVAS_T23_PERF_PROBE=1 才累计调用、时长与并发数据。
 * 探针既不取消、不重试，也不改变 IPC 的参数、返回值或错误。
 */
export function createT23IpcPerformanceProbe(
  enabled: boolean,
  invoke: <T>(channel: string, ...args: unknown[]) => Promise<T>,
  now: () => number = () => performance.now(),
): T23IpcPerformanceProbe {
  let totalCalls = 0;
  let completedCalls = 0;
  let currentOutstanding = 0;
  let peakOutstanding = 0;
  let totalDurationMs = 0;
  let maxDurationMs: number | null = null;
  let lastDurationMs: number | null = null;
  const channels = new Map<string, {
    totalCalls: number;
    completedCalls: number;
    currentOutstanding: number;
    peakOutstanding: number;
    totalDurationMs: number;
    maxDurationMs: number | null;
    lastDurationMs: number | null;
  }>();

  const snapshot = (): T23IpcPerformanceProbeSnapshot => ({
    enabled,
    totalCalls,
    completedCalls,
    currentOutstanding,
    peakOutstanding,
    totalDurationMs,
    averageDurationMs: completedCalls > 0 ? totalDurationMs / completedCalls : null,
    maxDurationMs,
    lastDurationMs,
    channels: [...channels.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([channel, state]) => ({
        channel,
        ...state,
        averageDurationMs: state.completedCalls > 0
          ? state.totalDurationMs / state.completedCalls
          : null,
      })),
  });

  return {
    async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      if (!enabled) return invoke<T>(channel, ...args);

      const startedAt = now();
      totalCalls += 1;
      currentOutstanding += 1;
      peakOutstanding = Math.max(peakOutstanding, currentOutstanding);
      const channelState = channels.get(channel) ?? {
        totalCalls: 0,
        completedCalls: 0,
        currentOutstanding: 0,
        peakOutstanding: 0,
        totalDurationMs: 0,
        maxDurationMs: null,
        lastDurationMs: null,
      };
      channelState.totalCalls += 1;
      channelState.currentOutstanding += 1;
      channelState.peakOutstanding = Math.max(
        channelState.peakOutstanding,
        channelState.currentOutstanding,
      );
      channels.set(channel, channelState);

      try {
        return await invoke<T>(channel, ...args);
      } finally {
        const durationMs = Math.max(0, now() - startedAt);
        completedCalls += 1;
        currentOutstanding -= 1;
        totalDurationMs += durationMs;
        maxDurationMs = maxDurationMs === null
          ? durationMs
          : Math.max(maxDurationMs, durationMs);
        lastDurationMs = durationMs;
        channelState.completedCalls += 1;
        channelState.currentOutstanding -= 1;
        channelState.totalDurationMs += durationMs;
        channelState.maxDurationMs = channelState.maxDurationMs === null
          ? durationMs
          : Math.max(channelState.maxDurationMs, durationMs);
        channelState.lastDurationMs = durationMs;
      }
    },
    snapshot,
  };
}
