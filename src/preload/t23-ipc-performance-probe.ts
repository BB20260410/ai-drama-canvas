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
  projectionTimeline?: {
    schemaVersion: 1;
    phases: Array<{
      phase: string;
      durationMs: number;
      panelCount?: number;
      controlAssetCount?: number;
      neighborCount?: number;
      frozenReferenceCount?: number;
    }>;
  };
  unitsReadTimeline?: {
    schemaVersion: 1;
    phases: Array<{
      phase: string;
      startOffsetMs: number;
      durationMs: number;
    }>;
    counters: {
      managedProjectShellInspections: number;
      generationLedgerEnsureCalls: number;
      generationLedgerInitializationStarts: number;
      generationLedgerInitializationJoins: number;
      productionDirectoryEnsureCalls: number;
      productionOpenDatabaseCalls: number;
      productionReadOnlyProbeConnections: number;
      productionOwnerConnections: number;
      productionBusinessSqlExecutions: number;
      unitPageQueries: number;
      unitTimingQueries: number;
      episodeStartQueries: number;
      facetQueries: number;
      bindingHeadQueries: number;
      successorQueries: number;
      productionSchemaCacheHits: number;
      productionSchemaCacheMisses: number;
      returnedUnitCount: number;
    };
  };
  rendererStartupTimeline?: {
    schemaVersion: 1;
    milestones: Array<{
      milestone: string;
      atMs: number;
    }>;
  };
}

export interface T23IpcPerformanceProbe {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
  recordRendererMilestone(milestone: string, atMs: number): void;
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
  let projectionTimeline: T23IpcPerformanceProbeSnapshot["projectionTimeline"];
  let projectionTimelineAttempt = 0;
  let unitsReadTimeline: T23IpcPerformanceProbeSnapshot["unitsReadTimeline"];
  let unitsReadTimelineAttempt = 0;
  const rendererStartupMilestones: NonNullable<
    T23IpcPerformanceProbeSnapshot["rendererStartupTimeline"]
  >["milestones"] = [];
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
    ...(projectionTimeline ? { projectionTimeline: structuredClone(projectionTimeline) } : {}),
    ...(unitsReadTimeline ? { unitsReadTimeline: structuredClone(unitsReadTimeline) } : {}),
    ...(rendererStartupMilestones.length
      ? {
        rendererStartupTimeline: {
          schemaVersion: 1,
          milestones: rendererStartupMilestones.map((milestone) => ({ ...milestone })),
        },
      }
      : {}),
  });

  const captureProjectionTimeline = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const candidate = (value as Record<string, unknown>).__t23ProjectionTimeline;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
    const record = candidate as Record<string, unknown>;
    if (record.schemaVersion !== 1 || !Array.isArray(record.phases) || record.phases.length < 1 || record.phases.length > 16) return;
    const phases: NonNullable<T23IpcPerformanceProbeSnapshot["projectionTimeline"]>["phases"] = [];
    for (const phaseValue of record.phases) {
      if (!phaseValue || typeof phaseValue !== "object" || Array.isArray(phaseValue)) return;
      const phase = phaseValue as Record<string, unknown>;
      if (typeof phase.phase !== "string" || phase.phase.length > 80
        || typeof phase.durationMs !== "number" || !Number.isFinite(phase.durationMs) || phase.durationMs < 0) return;
      const counts: Record<string, number> = {};
      for (const key of ["panelCount", "controlAssetCount", "neighborCount", "frozenReferenceCount"] as const) {
        const count = phase[key];
        if (count === undefined) continue;
        if (!Number.isSafeInteger(count) || (count as number) < 0) return;
        counts[key] = count as number;
      }
      phases.push({ phase: phase.phase, durationMs: phase.durationMs, ...counts });
    }
    projectionTimeline = { schemaVersion: 1, phases };
  };

  const captureUnitsReadTimeline = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const candidate = (value as Record<string, unknown>).__t23UnitsReadTimeline;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
    const record = candidate as Record<string, unknown>;
    if (record.schemaVersion !== 1
      || !Array.isArray(record.phases)
      || record.phases.length < 1
      || record.phases.length > 24
      || !record.counters
      || typeof record.counters !== "object"
      || Array.isArray(record.counters)) return;
    const phases: NonNullable<T23IpcPerformanceProbeSnapshot["unitsReadTimeline"]>["phases"] = [];
    for (const phaseValue of record.phases) {
      if (!phaseValue || typeof phaseValue !== "object" || Array.isArray(phaseValue)) return;
      const phase = phaseValue as Record<string, unknown>;
      if (typeof phase.phase !== "string" || phase.phase.length < 1 || phase.phase.length > 80
        || typeof phase.startOffsetMs !== "number" || !Number.isFinite(phase.startOffsetMs) || phase.startOffsetMs < 0
        || typeof phase.durationMs !== "number" || !Number.isFinite(phase.durationMs) || phase.durationMs < 0) return;
      phases.push({
        phase: phase.phase,
        startOffsetMs: phase.startOffsetMs,
        durationMs: phase.durationMs,
      });
    }
    const counterNames = [
      "managedProjectShellInspections",
      "generationLedgerEnsureCalls",
      "generationLedgerInitializationStarts",
      "generationLedgerInitializationJoins",
      "productionDirectoryEnsureCalls",
      "productionOpenDatabaseCalls",
      "productionReadOnlyProbeConnections",
      "productionOwnerConnections",
      "productionBusinessSqlExecutions",
      "unitPageQueries",
      "unitTimingQueries",
      "episodeStartQueries",
      "facetQueries",
      "bindingHeadQueries",
      "successorQueries",
      "productionSchemaCacheHits",
      "productionSchemaCacheMisses",
      "returnedUnitCount",
    ] as const;
    const sourceCounters = record.counters as Record<string, unknown>;
    const counters = {} as NonNullable<T23IpcPerformanceProbeSnapshot["unitsReadTimeline"]>["counters"];
    for (const name of counterNames) {
      const count = sourceCounters[name];
      if (!Number.isSafeInteger(count) || (count as number) < 0) return;
      counters[name] = count as number;
    }
    unitsReadTimeline = { schemaVersion: 1, phases, counters };
  };

  return {
    recordRendererMilestone(milestone: string, atMs: number): void {
      if (!enabled
        || rendererStartupMilestones.length >= 64
        || typeof milestone !== "string"
        || milestone.length < 1
        || milestone.length > 80
        || !Number.isFinite(atMs)
        || atMs < 0) return;
      rendererStartupMilestones.push({ milestone, atMs });
    },
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

      // 深投影失败时 IPC 不会携带成功结果中的诊断字段；先清空旧值，避免把上一
      // 次成功 timeline 冒充本次失败的阶段证据。
      const isProjectionBundle = channel === "canvas:get-studio-production-projection-bundle";
      const projectionAttempt = isProjectionBundle ? ++projectionTimelineAttempt : undefined;
      if (isProjectionBundle) {
        projectionTimeline = undefined;
      }
      const dashboardQuery = args[1];
      const isUnitsDashboard = channel === "canvas:get-studio-production-dashboard"
        && Boolean(dashboardQuery)
        && typeof dashboardQuery === "object"
        && !Array.isArray(dashboardQuery)
        && (dashboardQuery as { operation?: unknown }).operation === "units";
      const unitsReadAttempt = isUnitsDashboard ? ++unitsReadTimelineAttempt : undefined;
      if (isUnitsDashboard) unitsReadTimeline = undefined;

      try {
        const result = await invoke<T>(channel, ...args);
        // 旧请求迟到时既不能覆盖最新成功，也不能在最新失败后重新留下旧 timeline。
        if (projectionAttempt === undefined || projectionAttempt === projectionTimelineAttempt) {
          captureProjectionTimeline(result);
        }
        if (unitsReadAttempt !== undefined && unitsReadAttempt === unitsReadTimelineAttempt) {
          captureUnitsReadTimeline(result);
        }
        return result;
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
