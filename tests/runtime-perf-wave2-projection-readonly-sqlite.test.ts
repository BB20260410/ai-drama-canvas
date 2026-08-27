/**
 * Wave 2/3 §1.3 残差：真实 getApprovedTimelineProjection 在 Linux 真 sqlite 上接线。
 * 只 mock inspectManagedProjectReadOnly（createManagedProject / P7 fixture 需 Darwin dirfd）。
 * 身份 / 账本批读 / 历史 PASS / schema 闸走真函数 + 手工 sqlite。
 * 不是 P7 owner，不是安装版 T23，不是 GUI 探针。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as managedProject from "../src/core/managed-project.js";
import * as production from "../src/core/studio-production.js";
import * as generationLedger from "../src/core/studio-generation-ledger.js";
import * as historicalRead from "../src/core/studio-generation-historical-imports-read.js";
import * as sqliteSnapshot from "../src/core/sqlite-readonly-snapshot.js";
import { getApprovedTimelineProjection } from "../src/core/studio-approved-timeline-projection.js";
import { GENERATION_LEDGER_UNINITIALIZED_MESSAGE } from "../src/core/studio-generation-ledger-readiness.js";
import { STUDIO_PRODUCTION_UNITS_UNINITIALIZED_MESSAGE } from "../src/core/studio-production.js";
import { withStudioUnitsReadProbe } from "../src/core/studio-units-read-phase-timeline.js";
import type { ProjectShell } from "../src/core/managed-project.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const SEASON = "S1";
const EPISODE = "S1E1";
const PROJECT_ID = "proj-w2-proj-ro-sqlite";

let tempRoot: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (!tempRoot) return;
  await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function unitIdAt(index: number): string {
  return `${EPISODE}-U${String(index).padStart(4, "0")}`;
}

function lastPageIds(unitCount: number, pageSize = 36): string[] {
  return Array.from({ length: pageSize }, (_, index) => unitIdAt(unitCount - pageSize + index));
}

function generationDatabasePath(root: string): string {
  return path.join(root, ".aicanvas", "studio-generation-ledger.sqlite");
}

function productionDatabasePath(root: string): string {
  return path.join(root, ".aicanvas", "studio-production.sqlite");
}

function mediaCasRoot(root: string): string {
  return path.join(root, ".aicanvas", "objects", "sha256");
}

function installInspectOnly(root: string): void {
  vi.spyOn(managedProject, "inspectManagedProjectReadOnly").mockResolvedValue({
    project: { id: PROJECT_ID },
    paths: {
      root,
      generationDatabase: generationDatabasePath(root),
      mediaCas: mediaCasRoot(root),
    },
  } as unknown as ProjectShell);
}

function forbidWritableHotPaths(): void {
  vi.spyOn(production, "listStudioProductionUnits").mockImplementation(async () => {
    throw new Error("时间线投影不得走 listStudioProductionUnits");
  });
  vi.spyOn(generationLedger, "listStudioGenerationLatestUnitGridRuns").mockImplementation(async () => {
    throw new Error("时间线投影不得走可写 listStudioGenerationLatestUnitGridRuns");
  });
  vi.spyOn(historicalRead, "readStudioGenerationProjectionSelectionFacts").mockImplementation(async () => {
    throw new Error("时间线投影不得走 readStudioGenerationProjectionSelectionFacts");
  });
  vi.spyOn(sqliteSnapshot, "openSqliteReadOnlySnapshot").mockImplementation(async () => {
    throw new Error("时间线投影不得走 openSqliteReadOnlySnapshot");
  });
}

async function seedProjectionSqlite(unitCount: number, dispatchedCount: number): Promise<string> {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-perf-proj-ro-"));
  const sidecar = path.join(tempRoot, ".aicanvas");
  await mkdir(mediaCasRoot(tempRoot), { recursive: true });
  const productionDb = new DatabaseSync(productionDatabasePath(tempRoot));
  try {
    productionDb.exec(`
      CREATE TABLE studio_production_units (
        id TEXT PRIMARY KEY,
        season TEXT NOT NULL,
        episode TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        title TEXT NOT NULL,
        revision INTEGER NOT NULL,
        panel_count INTEGER NOT NULL
      );
    `);
    const insertUnit = productionDb.prepare(`
      INSERT INTO studio_production_units(id, season, episode, sequence, title, revision, panel_count)
      VALUES(?, ?, ?, ?, ?, 1, 4)
    `);
    for (let index = 0; index < unitCount; index += 1) {
      insertUnit.run(unitIdAt(index), SEASON, EPISODE, index + 1, `unit-${index + 1}`);
    }
  } finally {
    productionDb.close();
  }

  const ledgerDb = new DatabaseSync(generationDatabasePath(tempRoot));
  try {
    ledgerDb.exec(`
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
    const insertTarget = ledgerDb.prepare(`
      INSERT INTO studio_generation_pack_targets(target_key, target_kind, pack_id, pack_fingerprint)
      VALUES(?, 'unit-grid', ?, ?)
    `);
    const insertDispatch = ledgerDb.prepare(`
      INSERT INTO studio_generation_dispatches(
        generation_run_id, pack_id, pack_fingerprint, executor_provider, dispatched_at, sequence
      ) VALUES(?, ?, ?, 'codex', '2026-08-25T00:00:00.000Z', 1)
    `);
    for (let index = 0; index < dispatchedCount; index += 1) {
      const id = unitIdAt(index);
      insertTarget.run(`unit-grid:${id}`, `pack-${id}`, `fp-${id}`);
      insertDispatch.run(`run-${id}`, `pack-${id}`, `fp-${id}`);
    }
  } finally {
    ledgerDb.close();
  }
  return tempRoot;
}

describe("runtime-perf wave2 projection readonly sqlite", () => {
  it("缺生产库失败关闭，不建 studio-production.sqlite", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-perf-proj-ro-missing-prod-"));
    await mkdir(path.join(tempRoot, ".aicanvas"), { recursive: true });
    const ledger = new DatabaseSync(generationDatabasePath(tempRoot));
    ledger.exec(`
      CREATE TABLE studio_generation_ledger_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO studio_generation_ledger_meta(key, value) VALUES('schema_version', '7');
    `);
    ledger.close();
    installInspectOnly(tempRoot);
    forbidWritableHotPaths();
    await expect(getApprovedTimelineProjection(tempRoot, {
      season: SEASON,
      episode: EPISODE,
      unitIds: [unitIdAt(0)],
    })).rejects.toThrow(STUDIO_PRODUCTION_UNITS_UNINITIALIZED_MESSAGE);
    expect(existsSync(productionDatabasePath(tempRoot))).toBe(false);
    expect(production.listStudioProductionUnits).not.toHaveBeenCalled();
  });

  it("缺账本失败关闭，不建 studio-generation-ledger.sqlite", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-perf-proj-ro-missing-ledger-"));
    await mkdir(path.join(tempRoot, ".aicanvas"), { recursive: true });
    const productionDb = new DatabaseSync(productionDatabasePath(tempRoot));
    productionDb.exec(`
      CREATE TABLE studio_production_units (
        id TEXT PRIMARY KEY,
        season TEXT NOT NULL,
        episode TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        title TEXT NOT NULL,
        revision INTEGER NOT NULL,
        panel_count INTEGER NOT NULL
      );
    `);
    productionDb.close();
    installInspectOnly(tempRoot);
    forbidWritableHotPaths();
    await expect(getApprovedTimelineProjection(tempRoot, {
      season: SEASON,
      episode: EPISODE,
      limit: 1,
    })).rejects.toThrow(GENERATION_LEDGER_UNINITIALIZED_MESSAGE);
    expect(existsSync(generationDatabasePath(tempRoot))).toBe(false);
    expect(generationLedger.listStudioGenerationLatestUnitGridRuns).not.toHaveBeenCalled();
  });

  it("2500 行末页 36：真投影只物化 36，不走 T23 list / 可写账本 / 整库 snapshot", async () => {
    const root = await seedProjectionSqlite(2500, 2464);
    installInspectOnly(root);
    forbidWritableHotPaths();
    const requested = lastPageIds(2500);
    const probed = await withStudioUnitsReadProbe(true, () => getApprovedTimelineProjection(root, {
      season: SEASON,
      episode: EPISODE,
      unitIds: requested,
    }));
    const projection = probed.value;
    expect(projection.projectId).toBe(PROJECT_ID);
    expect(projection.bounded).toBe(true);
    expect(projection.fastMode).toBe(true);
    expect(projection.unitCount).toBe(36);
    expect(projection.units).toHaveLength(36);
    expect(projection.units.map((unit) => unit.unitId)).toEqual(requested);
    expect(projection.units[0]?.displaySequence).toBe(2465);
    expect(projection.units[35]?.displaySequence).toBe(2500);
    expect(projection.units[0]?.latestRunId).toBeNull();
    expect(projection.units[0]?.productionStatus).toBe("ready_to_freeze");
    expect(probed.snapshot?.counters.unitTimingQueries).toBe(0);
    expect(probed.snapshot?.counters.unitPageQueries).toBe(0);
    expect(probed.snapshot?.counters.episodeStartQueries).toBe(0);
    expect(probed.snapshot?.counters.productionOpenDatabaseCalls).toBe(0);
    expect(probed.snapshot?.counters.productionDirectoryEnsureCalls).toBe(0);
    expect(probed.snapshot?.counters.generationLedgerEnsureCalls).toBe(0);
    expect(probed.snapshot?.counters.productionBusinessSqlExecutions).toBe(1);
    expect(production.listStudioProductionUnits).not.toHaveBeenCalled();
    expect(generationLedger.listStudioGenerationLatestUnitGridRuns).not.toHaveBeenCalled();
    expect(historicalRead.readStudioGenerationProjectionSelectionFacts).not.toHaveBeenCalled();
    expect(sqliteSnapshot.openSqliteReadOnlySnapshot).not.toHaveBeenCalled();
  });

  it("limit 36 只回前 36；省略走 lean 全 2500，仍不记 T23 timing", async () => {
    const root = await seedProjectionSqlite(2500, 80);
    installInspectOnly(root);
    forbidWritableHotPaths();

    const limited = await withStudioUnitsReadProbe(true, () => getApprovedTimelineProjection(root, {
      season: SEASON,
      episode: EPISODE,
      limit: 36,
    }));
    expect(limited.value.bounded).toBe(true);
    expect(limited.value.units).toHaveLength(36);
    expect(limited.value.units.map((unit) => unit.unitId)).toEqual(
      Array.from({ length: 36 }, (_, index) => unitIdAt(index)),
    );
    expect(limited.value.units[0]?.latestRunId).toBe(`run-${unitIdAt(0)}`);
    expect(limited.value.units[0]?.productionStatus).toBe("dispatched_no_call");
    expect(limited.snapshot?.counters.unitTimingQueries).toBe(0);
    expect(limited.snapshot?.counters.productionOpenDatabaseCalls).toBe(0);
    expect(limited.snapshot?.counters.generationLedgerEnsureCalls).toBe(0);

    const omitted = await withStudioUnitsReadProbe(true, () => getApprovedTimelineProjection(root, {
      season: SEASON,
      episode: EPISODE,
    }));
    expect(omitted.value.bounded).toBe(false);
    expect(omitted.value.unitCount).toBe(2500);
    expect(omitted.value.units[0]?.unitId).toBe(unitIdAt(0));
    expect(omitted.value.units[2499]?.unitId).toBe(unitIdAt(2499));
    expect(omitted.value.units[79]?.latestRunId).toBe(`run-${unitIdAt(79)}`);
    expect(omitted.value.units[80]?.latestRunId).toBeNull();
    expect(omitted.snapshot?.counters.unitTimingQueries).toBe(0);
    expect(omitted.snapshot?.counters.unitPageQueries).toBe(0);
    expect(omitted.snapshot?.counters.productionOpenDatabaseCalls).toBe(0);
    expect(production.listStudioProductionUnits).not.toHaveBeenCalled();
    expect(generationLedger.listStudioGenerationLatestUnitGridRuns).not.toHaveBeenCalled();
    expect(sqliteSnapshot.openSqliteReadOnlySnapshot).not.toHaveBeenCalled();
  });

  it("源码合同：投影接线仍只走只读旁路", () => {
    const projection = source("src/core/studio-approved-timeline-projection.ts");
    expect(projection).toContain("inspectManagedProjectReadOnly");
    expect(projection).toContain("assertGenerationLedgerSchemaFileReady");
    expect(projection).toContain("listStudioProductionUnitIdentitiesByIds");
    expect(projection).toContain("listStudioProductionUnitIdentities");
    expect(projection).toContain("listStudioGenerationLatestUnitGridRunsReadOnly");
    expect(projection).toContain("readStudioGenerationProjectionSelectionFactsReadOnly");
    expect(projection).not.toContain("listStudioProductionUnits");
    expect(projection).not.toMatch(/listStudioGenerationLatestUnitGridRuns\(/u);
    expect(projection).not.toMatch(/readStudioGenerationProjectionSelectionFacts\(/u);
    expect(projection).not.toContain("openSqliteReadOnlySnapshot");
    expect(projection).not.toContain("inspectManagedProject(");
    expect(projection).not.toContain("createStudioP7Fixture");
  });
});
