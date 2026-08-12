import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  commandLedgerSqlitePathFor,
  upsertCommandLedgerEntry,
} from "../src/core/command-ledger-store.js";
import {
  RetrySafeSqliteBusyError,
  isRetrySafeSqliteBusyError,
  isSqliteBusyError,
  sqliteBusyTimeoutWithinDeadline,
  studioSqliteBusyTimeoutMs,
  withSqliteBusyRetry,
  withStudioSqliteBusyDeadline,
} from "../src/core/studio-sqlite-busy.js";

describe("Studio SQLite busy proof and deadline", () => {
  it("原始 busy 默认 outcome unknown，只有 typed 零副作用证明可自动重试", async () => {
    const raw = Object.assign(new Error("database is locked"), { errcode: 5 });
    expect(isSqliteBusyError(raw)).toBe(true);
    expect(isRetrySafeSqliteBusyError(raw)).toBe(false);
    let rawCalls = 0;
    await expect(withSqliteBusyRetry(async () => {
      rawCalls += 1;
      throw raw;
    }, { sleep: async () => undefined })).rejects.toBe(raw);
    expect(rawCalls).toBe(1);

    let safeCalls = 0;
    const value = await withSqliteBusyRetry(async () => {
      safeCalls += 1;
      if (safeCalls < 3) throw new RetrySafeSqliteBusyError(raw, { kind: "before_domain_execute" });
      return "ok";
    }, { sleep: async () => undefined });
    expect(value).toBe("ok");
    expect(safeCalls).toBe(3);
  });

  it("同步 DatabaseSync timeout 被同一绝对 deadline 剩余预算 clamp", async () => {
    expect(sqliteBusyTimeoutWithinDeadline(120_000, 10_000, 8_750)).toBe(1_250);
    expect(sqliteBusyTimeoutWithinDeadline(5_000, 10_000, 1_000)).toBe(5_000);
    expect(sqliteBusyTimeoutWithinDeadline(120_000, 10_000, 10_001)).toBe(1);

    const deadlineAtMs = Date.now() + 200;
    await withStudioSqliteBusyDeadline(deadlineAtMs, async () => {
      const timeout = studioSqliteBusyTimeoutMs(120_000);
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(200);
    });
    expect(studioSqliteBusyTimeoutMs(120_000)).toBe(120_000);
  });

  it("真实 SQLite writer lock 不能越过短 deadline 等待 120 秒", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aic-sqlite-deadline-"));
    const databasePath = path.join(root, "deadline.sqlite");
    const owner = new DatabaseSync(databasePath);
    owner.exec("CREATE TABLE value_store(value TEXT); BEGIN IMMEDIATE;");
    const startedAt = Date.now();
    try {
      await withStudioSqliteBusyDeadline(Date.now() + 80, async () => {
        const timeout = studioSqliteBusyTimeoutMs(120_000);
        const contender = new DatabaseSync(databasePath, { timeout });
        try {
          contender.exec(`PRAGMA busy_timeout=${timeout}`);
          expect(() => contender.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/u);
        } finally {
          contender.close();
        }
      });
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      owner.exec("ROLLBACK");
      owner.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("command ledger writable owner 也继承同一短 deadline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aic-command-ledger-deadline-"));
    const timestamp = new Date().toISOString();
    const entry = {
      schemaVersion: 1 as const,
      requestId: "request-ledger-deadline-001",
      idempotencyKey: "ledger-deadline-key-001",
      command: "test_command",
      status: "running" as const,
      replayed: false,
      requestHash: "a".repeat(64),
      startedAt: timestamp,
    };
    await upsertCommandLedgerEntry(root, entry, timestamp);
    const owner = new DatabaseSync(commandLedgerSqlitePathFor(root));
    owner.exec("BEGIN IMMEDIATE");
    const startedAt = Date.now();
    try {
      const failure = await withStudioSqliteBusyDeadline(Date.now() + 80, () =>
        upsertCommandLedgerEntry(root, { ...entry, requestId: "request-ledger-deadline-002" }, timestamp))
        .catch((error: unknown) => error);
      expect(isSqliteBusyError(failure)).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      owner.exec("ROLLBACK");
      owner.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
