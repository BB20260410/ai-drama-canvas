import { describe, expect, it } from "vitest";
import {
  getRuntimeStorageReadMetrics,
  recordManagedProjectShellInspection,
  recordSqliteSnapshotOpened,
  recordSqliteSnapshotRequest,
  recordSqliteSnapshotRetry,
  recordSqliteStableDatabaseCapture,
} from "../src/core/runtime-storage-observability.js";

describe("运行时受管检查与 SQLite 快照探针", () => {
  it("只累计匿名计数，不保存工程内容", () => {
    const before = getRuntimeStorageReadMetrics();
    recordManagedProjectShellInspection();
    recordSqliteSnapshotRequest();
    recordSqliteStableDatabaseCapture();
    recordSqliteSnapshotRetry();
    recordSqliteSnapshotOpened();
    expect(getRuntimeStorageReadMetrics()).toEqual({
      managedProjectShellInspections: before.managedProjectShellInspections + 1,
      sqliteSnapshotRequests: before.sqliteSnapshotRequests + 1,
      sqliteStableDatabaseCaptures: before.sqliteStableDatabaseCaptures + 1,
      sqliteSnapshotRetries: before.sqliteSnapshotRetries + 1,
      sqliteSnapshotsOpened: before.sqliteSnapshotsOpened + 1,
    });
  });
});
