/**
 * Wave 2/3 §1.3 残差：Linux 手工 schema v1 侧车，零 mock 走
 * inspectManagedProjectReadOnly + getApprovedTimelineProjection。
 * 不调用 createManagedProject / createStudioP7Fixture（需 Darwin dirfd）。
 * 不是 P7 owner，不是安装版 T23，不是 GUI 探针。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as production from "../src/core/studio-production.js";
import * as generationLedger from "../src/core/studio-generation-ledger.js";
import * as historicalRead from "../src/core/studio-generation-historical-imports-read.js";
import * as sqliteSnapshot from "../src/core/sqlite-readonly-snapshot.js";
import { inspectManagedProjectReadOnly } from "../src/core/managed-project.js";
import { getApprovedTimelineProjection } from "../src/core/studio-approved-timeline-projection.js";
import { GENERATION_LEDGER_UNINITIALIZED_MESSAGE } from "../src/core/studio-generation-ledger-readiness.js";
import { STUDIO_PRODUCTION_UNITS_UNINITIALIZED_MESSAGE } from "../src/core/studio-production.js";
import { withStudioUnitsReadProbe } from "../src/core/studio-units-read-phase-timeline.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const SEASON = "S1";
const EPISODE = "S1E1";
const PROJECT_ID = "proj-w2-unmocked-inspect";
const PROJECT_NAME = "linux-readonly-inspect";

let tempRoot: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (!tempRoot) return;
  await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function unitIdAt(index: number): string {
  return `${EPISODE}-U${String(index).padStart(4, "0")}`;
}

function lastPageIds(unitCount: number, pageSize = 36): string[] {
  return Array.from({ length: pageSize }, (_, index) => unitIdAt(unitCount - pageSize + index));
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

async function seedUnmockedProject(unitCount: number, dispatchedCount: number): Promise<string> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "runtime-perf-unmocked-"));
  const root = await realpath(tmp);
  tempRoot = tmp;
  const sidecar = path.join(root, ".aicanvas");
  await Promise.all([
    mkdir(path.join(sidecar, "objects", "sha256"), { recursive: true }),
    mkdir(path.join(sidecar, "derived", "thumb"), { recursive: true }),
    mkdir(path.join(sidecar, "derived", "proxy"), { recursive: true }),
    mkdir(path.join(sidecar, "derived", "waveform"), { recursive: true }),
    mkdir(path.join(sidecar, "studio-production", "objects", "sha256"), { recursive: true }),
    mkdir(path.join(sidecar, "studio-generation", "objects", "sha256"), { recursive: true }),
  ]);

  const project = {
    schemaVersion: 1 as const,
    id: PROJECT_ID,
    name: PROJECT_NAME,
    primaryRoot: root,
    sourceRoots: [] as string[],
    outputRoots: [root],
  };
  const projectBytes = Buffer.from(`${JSON.stringify(project, null, 2)}\n`, "utf8");
  await writeFile(path.join(sidecar, "project.json"), projectBytes);
  const index = {
    schemaVersion: 1 as const,
    project,
    scanId: "managed-bootstrap-linux1",
    scannedAt: "2026-08-25T00:00:00.000Z",
    scanDurationMs: 0,
    warnings: [] as string[],
    summary: { total: 0 },
    items: [] as unknown[],
    artifacts: [] as unknown[],
  };
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8");
  await writeFile(path.join(sidecar, "index.json"), indexBytes);
  const relativePaths = {
    config: ".aicanvas/project.json",
    index: ".aicanvas/index.json",
    cache: ".aicanvas/cache.sqlite",
    materialDatabase: ".aicanvas/material-studio.sqlite",
    productionDatabase: ".aicanvas/studio-production.sqlite",
    textCas: ".aicanvas/studio-production/objects/sha256",
    generationDatabase: ".aicanvas/studio-generation-ledger.sqlite",
    generationPackCas: ".aicanvas/studio-generation/objects/sha256",
    mediaCas: ".aicanvas/objects/sha256",
    mediaPreviews: ".aicanvas/derived/thumb",
    mediaProxies: ".aicanvas/derived/proxy",
    mediaWaveforms: ".aicanvas/derived/waveform",
  };
  const payload = {
    schemaVersion: 1 as const,
    kind: "ai-canvas-managed-project",
    projectId: project.id,
    projectName: project.name,
    rootRealpath: root,
    storageMode: "managed",
    startupPolicy: "no-filesystem-scan",
    mediaMode: "project-local-cas",
    legacyRoots: [] as string[],
    projectConfigSha256: sha256(projectBytes),
    bootstrapIndexSha256: sha256(indexBytes),
    bootstrapScanId: index.scanId,
    relativePaths,
    createdAt: "2026-08-25T00:00:00.000Z",
  };
  const manifest = {
    ...payload,
    fingerprint: sha256(JSON.stringify(stableValue(payload))),
  };
  await writeFile(path.join(sidecar, "managed-project.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(sidecar, "cache.sqlite"), "");
  await writeFile(path.join(sidecar, "material-studio.sqlite"), "");

  const productionDb = new DatabaseSync(path.join(sidecar, "studio-production.sqlite"));
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

  const ledgerDb = new DatabaseSync(path.join(sidecar, "studio-generation-ledger.sqlite"));
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
  return root;
}

describe("runtime-perf wave2 projection unmocked inspect", () => {
  it("手工 schema v1 侧车可被 inspectManagedProjectReadOnly 打开", async () => {
    const root = await seedUnmockedProject(1, 0);
    const shell = await inspectManagedProjectReadOnly(root);
    expect(shell.project.id).toBe(PROJECT_ID);
    expect(shell.paths.generationDatabase).toBe(path.join(root, ".aicanvas", "studio-generation-ledger.sqlite"));
    expect(shell.paths.productionDatabase).toBe(path.join(root, ".aicanvas", "studio-production.sqlite"));
  });

  it("空生产库表失败关闭，不走 T23 list", async () => {
    const root = await seedUnmockedProject(0, 0);
    const empty = new DatabaseSync(path.join(root, ".aicanvas", "studio-production.sqlite"));
    empty.exec("DROP TABLE studio_production_units");
    empty.close();
    forbidWritableHotPaths();
    await expect(getApprovedTimelineProjection(root, {
      season: SEASON,
      episode: EPISODE,
      unitIds: [unitIdAt(0)],
    })).rejects.toThrow(STUDIO_PRODUCTION_UNITS_UNINITIALIZED_MESSAGE);
    expect(production.listStudioProductionUnits).not.toHaveBeenCalled();
  });

  it("缺账本失败关闭，不建 studio-generation-ledger.sqlite", async () => {
    const root = await seedUnmockedProject(1, 0);
    const ledgerPath = path.join(root, ".aicanvas", "studio-generation-ledger.sqlite");
    await rm(ledgerPath, { force: true });
    expect(existsSync(ledgerPath)).toBe(false);
    forbidWritableHotPaths();
    await expect(getApprovedTimelineProjection(root, {
      season: SEASON,
      episode: EPISODE,
      limit: 1,
    })).rejects.toThrow(GENERATION_LEDGER_UNINITIALIZED_MESSAGE);
    expect(existsSync(ledgerPath)).toBe(false);
    expect(generationLedger.listStudioGenerationLatestUnitGridRuns).not.toHaveBeenCalled();
  });

  it("零 mock：2500 末页 36 只物化 36，不走 T23 list / 可写账本 / 整库 snapshot", async () => {
    const root = await seedUnmockedProject(2500, 2464);
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
    expect(probed.snapshot?.counters.managedProjectShellInspections).toBe(1);
    expect(probed.snapshot?.counters.productionBusinessSqlExecutions).toBe(1);
    expect(production.listStudioProductionUnits).not.toHaveBeenCalled();
    expect(generationLedger.listStudioGenerationLatestUnitGridRuns).not.toHaveBeenCalled();
    expect(historicalRead.readStudioGenerationProjectionSelectionFacts).not.toHaveBeenCalled();
    expect(sqliteSnapshot.openSqliteReadOnlySnapshot).not.toHaveBeenCalled();
  });

  it("零 mock：limit 36 与省略 2500 仍不记 T23 timing", async () => {
    const root = await seedUnmockedProject(2500, 80);
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
    expect(limited.snapshot?.counters.generationLedgerEnsureCalls).toBe(0);

    const omitted = await withStudioUnitsReadProbe(true, () => getApprovedTimelineProjection(root, {
      season: SEASON,
      episode: EPISODE,
    }));
    expect(omitted.value.bounded).toBe(false);
    expect(omitted.value.unitCount).toBe(2500);
    expect(omitted.value.units).toHaveLength(2500);
    expect(omitted.value.units[2499]?.unitId).toBe(unitIdAt(2499));
    expect(omitted.value.units[79]?.latestRunId).toBe(`run-${unitIdAt(79)}`);
    expect(omitted.value.units[80]?.latestRunId).toBeNull();
    expect(omitted.snapshot?.counters.unitTimingQueries).toBe(0);
    expect(omitted.snapshot?.counters.productionOpenDatabaseCalls).toBe(0);
    expect(production.listStudioProductionUnits).not.toHaveBeenCalled();
    expect(generationLedger.listStudioGenerationLatestUnitGridRuns).not.toHaveBeenCalled();
    expect(sqliteSnapshot.openSqliteReadOnlySnapshot).not.toHaveBeenCalled();
  });

  it("源码合同：投影入口仍只走 ReadOnly inspect，不创建 P7 fixture", () => {
    const projection = source("src/core/studio-approved-timeline-projection.ts");
    expect(projection).toContain("inspectManagedProjectReadOnly");
    expect(projection).not.toMatch(/inspectManagedProject\(/u);
    expect(projection).not.toContain("createManagedProject");
    expect(projection).not.toContain("createStudioP7Fixture");
    expect(projection).not.toContain("ensureManagedGenerationLedger");
    expect(projection).toContain("listStudioProductionUnitIdentitiesByIds");
    expect(projection).toContain("listStudioGenerationLatestUnitGridRunsReadOnly");
    expect(projection).toContain("readStudioGenerationProjectionSelectionFactsReadOnly");
    expect(projection).toContain("assertGenerationLedgerSchemaFileReady");
    expect(projection).not.toContain("listStudioProductionUnits");
    expect(projection).not.toMatch(/listStudioGenerationLatestUnitGridRuns\(/u);
    expect(projection).not.toContain("openSqliteReadOnlySnapshot");
  });
});
