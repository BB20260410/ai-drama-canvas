import { describe, expect, it } from "vitest";
import { createRuntimeStabilityProbeSnapshot } from "../src/main/runtime-stability-probe.js";

describe("runtime stability probe", () => {
  it("只投影匿名运行数字并归一化无效计数", () => {
    const snapshot = createRuntimeStabilityProbeSnapshot({
      capturedAt: "2026-08-10T00:00:00.000Z",
      processMetrics: [{
        pid: 42,
        type: "Browser",
        cpu: { percentCPUUsage: 12.5, idleWakeupsPerSecond: -1, cumulativeCPUUsage: 3.25 },
        memory: { workingSetSize: 1024, peakWorkingSetSize: 2048 },
        secretPath: "/Users/example/private-project",
      } as never],
      ipc: {
        capturedAt: "2026-08-10T00:00:00.000Z",
        channels: [{
          channel: "canvas:list-projects",
          effect: "read-only",
          calls: 2,
          failures: 0,
          totalDurationMs: 4,
          maxDurationMs: 3,
          totalGateDurationMs: 0,
          maxGateDurationMs: 0,
        }],
      },
      storage: {
        managedProjectShellInspections: 1,
        sqliteSnapshotRequests: 2,
        sqliteStableDatabaseCaptures: 2,
        sqliteSnapshotRetries: 0,
        sqliteSnapshotsOpened: 2,
      },
      watchers: {
        sourceRuntimeGate: 2,
        legacyActive: 2,
        legacyRetained: -3,
        generationLedger: 1,
      },
      tasks: {
        activeOperations: 1,
        activeScans: 0,
        manualScans: 0,
        projectLists: 1,
        editorSessions: 1,
        watcherDebounceTimers: 0,
        watcherScans: Number.NaN,
      },
      nativeDrag: {
        activePreparations: 0,
        capacityReservations: 0,
        prepared: 0,
        claimed: 0,
        activeOsHandoffs: 0,
        retained: 0,
        ownedDirectories: 0,
        closing: false,
      },
      windowCount: 1,
    });

    expect(snapshot.watchers).toEqual({
      sourceRuntimeGate: 2,
      legacyActive: 2,
      legacyRetained: 0,
      generationLedger: 1,
      total: 5,
    });
    expect(snapshot.tasks.total).toBe(3);
    expect(snapshot.processes).toEqual([expect.objectContaining({
      pid: 42,
      type: "Browser",
      cpuPercent: 12.5,
      idleWakeupsPerSecond: 0,
      workingSetKiB: 1024,
    })]);
    expect(JSON.stringify(snapshot)).not.toContain("private-project");
  });
});
