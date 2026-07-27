export interface RuntimeStorageReadMetrics {
  managedProjectShellInspections: number;
  sqliteSnapshotRequests: number;
  sqliteStableDatabaseCaptures: number;
  sqliteSnapshotRetries: number;
  sqliteSnapshotsOpened: number;
}

const metrics: RuntimeStorageReadMetrics = {
  managedProjectShellInspections: 0,
  sqliteSnapshotRequests: 0,
  sqliteStableDatabaseCaptures: 0,
  sqliteSnapshotRetries: 0,
  sqliteSnapshotsOpened: 0,
};

export function recordManagedProjectShellInspection(): void {
  metrics.managedProjectShellInspections += 1;
}

export function recordSqliteSnapshotRequest(): void {
  metrics.sqliteSnapshotRequests += 1;
}

export function recordSqliteStableDatabaseCapture(): void {
  metrics.sqliteStableDatabaseCaptures += 1;
}

export function recordSqliteSnapshotRetry(): void {
  metrics.sqliteSnapshotRetries += 1;
}

export function recordSqliteSnapshotOpened(): void {
  metrics.sqliteSnapshotsOpened += 1;
}

/** 仅返回进程内累计计数，不携带工程路径或媒体内容。 */
export function getRuntimeStorageReadMetrics(): RuntimeStorageReadMetrics {
  return { ...metrics };
}
