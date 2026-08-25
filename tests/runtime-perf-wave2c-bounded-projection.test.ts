/**
 * Wave 2-C：有界时间线对照（Linux 可跑）。
 * 不建受管工程、不扫正式工程、不走 Darwin dirfd / P7 fixture。
 * P7 owner 对照仍留在 studio-approved-timeline-projection.test.ts（需 macOS）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as managedProject from "../src/core/managed-project.js";
import * as ledgerReadiness from "../src/core/studio-generation-ledger-readiness.js";
import * as production from "../src/core/studio-production.js";
import * as generationLedger from "../src/core/studio-generation-ledger.js";
import * as historicalRead from "../src/core/studio-generation-historical-imports-read.js";
import { getApprovedTimelineProjection } from "../src/core/studio-approved-timeline-projection.js";
import type { ProjectShell } from "../src/core/managed-project.js";
import type { StudioProductionUnitSummary } from "../src/core/studio-production.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const SEASON = "S1";
const EPISODE = "S1E1";

function fakeShell(): ProjectShell {
  return {
    project: { id: "proj-w2c-mock" },
    paths: { generationDatabase: "/tmp/w2c-mock-ledger.sqlite" },
  } as unknown as ProjectShell;
}

function fakeUnits(count: number): StudioProductionUnitSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `S1E1-U${String(index).padStart(2, "0")}`,
    sequence: index + 1,
    title: `unit-${index + 1}`,
    revision: 1,
    panelCount: 4,
  }) as StudioProductionUnitSummary);
}

function leanIdentity(unit: StudioProductionUnitSummary) {
  return {
    id: unit.id,
    sequence: unit.sequence,
    title: unit.title,
    revision: unit.revision,
    panelCount: unit.panelCount,
  };
}

function installIdleEpisode(units: StudioProductionUnitSummary[]): void {
  vi.spyOn(managedProject, "inspectManagedProjectReadOnly").mockResolvedValue(fakeShell());
  vi.spyOn(ledgerReadiness, "assertGenerationLedgerSchemaFileReady").mockImplementation(() => undefined);
  vi.spyOn(production, "listStudioProductionUnits").mockResolvedValue({
    items: units,
    nextCursor: undefined,
  });
  vi.spyOn(production, "listStudioProductionUnitIdentitiesByIds").mockImplementation(
    async (_projectRoot, query) => {
      const wanted = new Set(query.unitIds);
      return units.filter((unit) => wanted.has(unit.id)).map(leanIdentity);
    },
  );
  vi.spyOn(generationLedger, "listStudioGenerationLatestUnitGridRuns").mockResolvedValue([]);
  vi.spyOn(historicalRead, "readStudioGenerationProjectionSelectionFacts").mockResolvedValue({
    historicalPassByUnit: new Map(),
    packFingerprintByRunId: new Map(),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Wave 2-C 有界投影对照（无 P7 fixture）", () => {
  it("省略 unitIds 返回今日全量，bounded=false", async () => {
    const units = fakeUnits(5);
    installIdleEpisode(units);
    const projection = await getApprovedTimelineProjection("/tmp/w2c-mock", {
      season: SEASON,
      episode: EPISODE,
    });
    expect(projection.bounded).toBe(false);
    expect(projection.unitCount).toBe(5);
    expect(projection.units.map((unit) => unit.unitId)).toEqual(units.map((unit) => unit.id));
    expect(production.listStudioProductionUnits).toHaveBeenCalled();
    expect(production.listStudioProductionUnitIdentitiesByIds).not.toHaveBeenCalled();
  });

  it("unitIds 有界：返回集 ⊆ 请求 id，且 bounded=true", async () => {
    const units = fakeUnits(5);
    installIdleEpisode(units);
    const requested = [units[3]!.id, units[1]!.id, "missing-unit"];
    const projection = await getApprovedTimelineProjection("/tmp/w2c-mock", {
      season: SEASON,
      episode: EPISODE,
      unitIds: requested,
    });
    const returned = projection.units.map((unit) => unit.unitId);
    expect(projection.bounded).toBe(true);
    expect(returned).toHaveLength(2);
    expect(returned.every((id) => requested.includes(id))).toBe(true);
    expect(returned).toEqual([units[1]!.id, units[3]!.id]);
    expect(production.listStudioProductionUnits).not.toHaveBeenCalled();
    expect(production.listStudioProductionUnitIdentitiesByIds).toHaveBeenCalledTimes(1);
  });

  it("unitIds 有界不翻页扫集：2500 槽末页 36 只走 by-id 一次", async () => {
    const units = fakeUnits(2500);
    installIdleEpisode(units);
    const requested = units.slice(-36).map((unit) => unit.id);
    const projection = await getApprovedTimelineProjection("/tmp/w2c-mock", {
      season: SEASON,
      episode: EPISODE,
      unitIds: requested,
    });
    expect(projection.bounded).toBe(true);
    expect(projection.units).toHaveLength(36);
    expect(projection.units.map((unit) => unit.unitId)).toEqual(requested);
    expect(production.listStudioProductionUnits).not.toHaveBeenCalled();
    expect(production.listStudioProductionUnitIdentitiesByIds).toHaveBeenCalledTimes(1);
    expect(production.listStudioProductionUnitIdentitiesByIds).toHaveBeenCalledWith("/tmp/w2c-mock", {
      season: SEASON,
      episode: EPISODE,
      unitIds: requested,
    });
  });

  it("省略全量与「请求全部现存 id」集合一致", async () => {
    const units = fakeUnits(5);
    installIdleEpisode(units);
    const omitted = await getApprovedTimelineProjection("/tmp/w2c-mock", {
      season: SEASON,
      episode: EPISODE,
    });
    const allIds = await getApprovedTimelineProjection("/tmp/w2c-mock", {
      season: SEASON,
      episode: EPISODE,
      unitIds: units.map((unit) => unit.id),
    });
    expect(omitted.units.map((unit) => unit.unitId)).toEqual(allIds.units.map((unit) => unit.unitId));
    expect(omitted.bounded).toBe(false);
    expect(allIds.bounded).toBe(true);
    expect(production.listStudioProductionUnits).toHaveBeenCalledTimes(1);
    expect(production.listStudioProductionUnitIdentitiesByIds).toHaveBeenCalledTimes(1);
  });

  it("源码合同：有界 unitIds 走 by-id；by-id 不记 T23 timing / 不扫页", () => {
    const projection = source("src/core/studio-approved-timeline-projection.ts");
    expect(projection).toContain("listStudioProductionUnitIdentitiesByIds");
    expect(projection).toContain("有 unitIds 时按 id 直读");
    const byIdStart = projection.indexOf("const unitSummaries = wantedIds");
    const byIdEnd = projection.indexOf("listApprovedTimelineEpisodeUnitIdentities(projectRoot", byIdStart);
    expect(byIdStart).toBeGreaterThan(-1);
    expect(byIdEnd).toBeGreaterThan(byIdStart);
    expect(projection.slice(byIdStart, byIdEnd)).toContain("listStudioProductionUnitIdentitiesByIds");
    expect(projection.slice(byIdStart, byIdEnd)).not.toContain("listStudioProductionUnits");

    const productionSource = source("src/core/studio-production.ts");
    const start = productionSource.indexOf("export async function listStudioProductionUnitIdentitiesByIds");
    const end = productionSource.indexOf("export async function getStudioProductionScopeFacets", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = productionSource.slice(start, end);
    expect(fn).toContain("id IN (");
    expect(fn).toContain("SELECT id, sequence, title, revision, panel_count");
    expect(fn).not.toContain("unitSummaryFromRow");
    expect(fn).not.toContain("unitTimingQueries");
    expect(fn).not.toContain("episodeStartQueries");
    expect(fn).not.toContain("unitPageQueries");
    expect(fn).not.toContain("SELECT * FROM studio_production_units");
  });
});
