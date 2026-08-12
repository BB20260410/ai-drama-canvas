import type { RuntimeIpcPerformanceSnapshot } from "../core/runtime-ipc-observability.js";
import type { RuntimeStorageReadMetrics } from "../core/runtime-storage-observability.js";
import type { StudioNativeMediaDragResourceSnapshot } from "./studio-native-media-drag-resources.js";

export interface RuntimeStabilityProcessMetricInput {
  pid: number;
  type: string;
  cpu: {
    percentCPUUsage: number;
    idleWakeupsPerSecond: number;
    cumulativeCPUUsage?: number;
  };
  memory: {
    workingSetSize: number;
    peakWorkingSetSize: number;
  };
}

export interface RuntimeStabilityProbeInput {
  capturedAt: string;
  processMetrics: readonly RuntimeStabilityProcessMetricInput[];
  ipc: RuntimeIpcPerformanceSnapshot;
  storage: RuntimeStorageReadMetrics;
  watchers: {
    sourceRuntimeGate: number;
    legacyActive: number;
    legacyRetained: number;
    generationLedger: number;
  };
  tasks: {
    activeOperations: number;
    activeScans: number;
    manualScans: number;
    projectLists: number;
    editorSessions: number;
    watcherDebounceTimers: number;
    watcherScans: number;
  };
  nativeDrag: StudioNativeMediaDragResourceSnapshot | null;
  windowCount: number;
}

export interface RuntimeStabilityProbeSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  processes: Array<{
    pid: number;
    type: string;
    cpuPercent: number;
    idleWakeupsPerSecond: number;
    cumulativeCpuSeconds?: number;
    workingSetKiB: number;
    peakWorkingSetKiB: number;
  }>;
  ipc: RuntimeIpcPerformanceSnapshot;
  storage: RuntimeStorageReadMetrics;
  watchers: RuntimeStabilityProbeInput["watchers"] & { total: number };
  tasks: RuntimeStabilityProbeInput["tasks"] & { total: number };
  nativeDrag: StudioNativeMediaDragResourceSnapshot | null;
  windowCount: number;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function nonNegativeInteger(value: number): number {
  return Math.trunc(nonNegative(value));
}

/**
 * 性能验收专用匿名快照。只投影聚合数字和进程类型，不接受工程路径、IPC 参数、
 * 正文、媒体或凭据，因此不会形成第二个运行状态 owner。
 */
export function createRuntimeStabilityProbeSnapshot(
  input: RuntimeStabilityProbeInput,
): RuntimeStabilityProbeSnapshot {
  const watchers = {
    sourceRuntimeGate: nonNegativeInteger(input.watchers.sourceRuntimeGate),
    legacyActive: nonNegativeInteger(input.watchers.legacyActive),
    legacyRetained: nonNegativeInteger(input.watchers.legacyRetained),
    generationLedger: nonNegativeInteger(input.watchers.generationLedger),
  };
  const tasks = {
    activeOperations: nonNegativeInteger(input.tasks.activeOperations),
    activeScans: nonNegativeInteger(input.tasks.activeScans),
    manualScans: nonNegativeInteger(input.tasks.manualScans),
    projectLists: nonNegativeInteger(input.tasks.projectLists),
    editorSessions: nonNegativeInteger(input.tasks.editorSessions),
    watcherDebounceTimers: nonNegativeInteger(input.tasks.watcherDebounceTimers),
    watcherScans: nonNegativeInteger(input.tasks.watcherScans),
  };
  return {
    schemaVersion: 1,
    capturedAt: input.capturedAt,
    processes: input.processMetrics.map((metric) => ({
      pid: nonNegativeInteger(metric.pid),
      type: String(metric.type).slice(0, 80),
      cpuPercent: nonNegative(metric.cpu.percentCPUUsage),
      idleWakeupsPerSecond: nonNegative(metric.cpu.idleWakeupsPerSecond),
      ...(typeof metric.cpu.cumulativeCPUUsage === "number"
        ? { cumulativeCpuSeconds: nonNegative(metric.cpu.cumulativeCPUUsage) }
        : {}),
      workingSetKiB: nonNegativeInteger(metric.memory.workingSetSize),
      peakWorkingSetKiB: nonNegativeInteger(metric.memory.peakWorkingSetSize),
    })),
    ipc: {
      capturedAt: input.ipc.capturedAt,
      channels: input.ipc.channels.map((channel) => ({ ...channel })),
    },
    storage: { ...input.storage },
    watchers: {
      ...watchers,
      total: Object.values(watchers).reduce((sum, value) => sum + value, 0),
    },
    tasks: {
      ...tasks,
      total: Object.values(tasks).reduce((sum, value) => sum + value, 0),
    },
    nativeDrag: input.nativeDrag ? { ...input.nativeDrag } : null,
    windowCount: nonNegativeInteger(input.windowCount),
  };
}
