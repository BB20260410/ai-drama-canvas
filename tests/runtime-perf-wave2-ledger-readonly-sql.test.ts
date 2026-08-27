/**
 * Wave 2/3 §1.3 残差：时间线账本批读对已有 sqlite 只读打开。
 * 不建受管工程、不走 Darwin dirfd / P7 fixture、不改可写入口 SQL。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  GENERATION_LEDGER_SCHEMA_UNREADY_MESSAGE,
  GENERATION_LEDGER_UNINITIALIZED_MESSAGE,
  openGenerationLedgerReadOnly,
} from "../src/core/studio-generation-ledger-readiness.js";
import { listStudioGenerationLatestUnitGridRunsReadOnly } from "../src/core/studio-generation-ledger.js";

let tempRoot: string | undefined;

afterEach(async () => {
  if (!tempRoot) return;
  await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

async function seedLedger(unitCount: number, dispatchedCount = unitCount): Promise<string> {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-perf-ledger-ro-"));
  const sidecar = path.join(tempRoot, ".aicanvas", "studio-generation");
  await mkdir(sidecar, { recursive: true });
  const databasePath = path.join(sidecar, "ledger.sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE studio_generation_ledger_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO studio_generation_ledger_meta(key, value) VALUES('schema_version', '7');
      CREATE TABLE studio_generation_pack_targets (
        target_key TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        pack_fingerprint TEXT NOT NULL
      );
      CREATE TABLE studio_generation_dispatches (
        generation_run_id TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        pack_fingerprint TEXT NOT NULL,
        executor_provider TEXT NOT NULL,
        dispatched_at TEXT NOT NULL,
        sequence INTEGER NOT NULL
      );
    `);
    const insertTarget = db.prepare(`
      INSERT INTO studio_generation_pack_targets(target_key, target_kind, pack_id, pack_fingerprint)
      VALUES(?, 'unit-grid', ?, ?)
    `);
    const insertDispatch = db.prepare(`
      INSERT INTO studio_generation_dispatches(
        generation_run_id, pack_id, pack_fingerprint, executor_provider, dispatched_at, sequence
      ) VALUES(?, ?, ?, 'codex', '2026-08-25T00:00:00.000Z', 1)
    `);
    for (let index = 0; index < dispatchedCount; index += 1) {
      const unitId = `S1E1-U${String(index).padStart(4, "0")}`;
      const packId = `pack-${unitId}`;
      const fingerprint = `fp-${unitId}`;
      insertTarget.run(`unit-grid:${unitId}`, packId, fingerprint);
      insertDispatch.run(`run-${unitId}`, packId, fingerprint);
    }
  } finally {
    db.close();
  }
  return databasePath;
}

describe("runtime-perf wave2 ledger readonly sql", () => {
  it("空 unitIds 不打开库；缺库失败关闭且不建文件", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-perf-ledger-missing-"));
    const missing = path.join(tempRoot, "missing-ledger.sqlite");
    await expect(listStudioGenerationLatestUnitGridRunsReadOnly(missing, [])).resolves.toEqual([]);
    expect(existsSync(missing)).toBe(false);
    await expect(listStudioGenerationLatestUnitGridRunsReadOnly(missing, ["S1E1-U0000"]))
      .rejects.toThrow(GENERATION_LEDGER_UNINITIALIZED_MESSAGE);
    expect(existsSync(missing)).toBe(false);
    expect(() => openGenerationLedgerReadOnly(missing)).toThrow(GENERATION_LEDGER_UNINITIALIZED_MESSAGE);
    expect(existsSync(missing)).toBe(false);
  });

  it("空库 / 错误 schema 失败关闭，不建 meta", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-perf-ledger-empty-"));
    const emptyPath = path.join(tempRoot, "empty.sqlite");
    const empty = new DatabaseSync(emptyPath);
    empty.close();
    await expect(listStudioGenerationLatestUnitGridRunsReadOnly(emptyPath, ["S1E1-U0000"]))
      .rejects.toThrow(GENERATION_LEDGER_SCHEMA_UNREADY_MESSAGE);
    const probe = new DatabaseSync(emptyPath, { readOnly: true });
    try {
      const row = probe.prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'studio_generation_ledger_meta'",
      ).get() as { found?: number } | undefined;
      expect(row).toBeUndefined();
    } finally {
      probe.close();
    }

    const stalePath = path.join(tempRoot, "stale.sqlite");
    const stale = new DatabaseSync(stalePath);
    stale.exec(`
      CREATE TABLE studio_generation_ledger_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO studio_generation_ledger_meta(key, value) VALUES('schema_version', '6');
    `);
    stale.close();
    await expect(listStudioGenerationLatestUnitGridRunsReadOnly(stalePath, ["S1E1-U0000"]))
      .rejects.toThrow(GENERATION_LEDGER_SCHEMA_UNREADY_MESSAGE);
  });

  it("36 单元只读批读：已派发回 latestRun，未派发为 null；不走可写入口", async () => {
    const databasePath = await seedLedger(36, 35);
    const unitIds = Array.from({ length: 36 }, (_, index) => `S1E1-U${String(index).padStart(4, "0")}`);
    const rows = await listStudioGenerationLatestUnitGridRunsReadOnly(databasePath, unitIds);
    expect(rows).toHaveLength(36);
    expect(rows.map((row) => row.unitId)).toEqual(unitIds);
    for (let index = 0; index < 35; index += 1) {
      expect(rows[index]?.latestRun?.generationRunId).toBe(`run-${unitIds[index]}`);
      expect(rows[index]?.latestRun?.packId).toBe(`pack-${unitIds[index]}`);
      expect(rows[index]?.latestRun?.provider).toBe("codex");
      expect(rows[index]?.latestRun?.terminal).toBe(false);
      expect(rows[index]?.rawMediaSha256).toBeNull();
      expect(rows[index]?.labeledMediaSha256).toBeNull();
      expect(rows[index]?.approvedResultIdentity).toBeNull();
    }
    expect(rows[35]).toEqual({
      unitId: "S1E1-U0035",
      latestRun: null,
      rawMediaSha256: null,
      labeledMediaSha256: null,
      approvedResultIdentity: null,
    });
  });
});
