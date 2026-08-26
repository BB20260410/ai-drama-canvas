import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyPackMediaToPanels,
  buildMissingMediaReport,
  formatPanelCoverageMarks,
  normalizeSourceSpans,
  pickFirstCoveredPanel,
  pickRawLabeledFromResults,
  resolveScriptSpanMediaMap,
  selectLatestPanelPack,
  spansOverlap,
  SCRIPT_LIBRARY_PROJECTION_SCHEMA_VERSION,
  type EpisodeUnitMediaMap,
  type UnitSpanMediaMapEntry,
} from "../src/core/studio-script-library-projection.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("studio-script-library-projection pure helpers", () => {
  it("pickRawLabeledFromResults prefers raw/labeled variants", () => {
    const picked = pickRawLabeledFromResults([
      { variant: "labeled", mediaSha256: "lab1", generationRunId: "run-a" },
      { variant: "raw", mediaSha256: "raw1", generationRunId: "run-a" },
    ]);
    expect(picked.rawSha256).toBe("raw1");
    expect(picked.labeledSha256).toBe("lab1");
    expect(picked.generationRunId).toBe("run-a");
  });

  it("pickRawLabeledFromResults falls back to first media when no variant", () => {
    const picked = pickRawLabeledFromResults([{ mediaSha256: "only1" }]);
    expect(picked.rawSha256).toBe("only1");
    expect(picked.labeledSha256).toBeNull();
  });

  it("normalizeSourceSpans drops invalid ranges", () => {
    expect(
      normalizeSourceSpans([
        { startOffsetUtf16: 0, endOffsetUtf16: 10 },
        { startOffsetUtf16: 5, endOffsetUtf16: 3 },
        null,
        { startOffsetUtf16: "x", endOffsetUtf16: 1 },
      ]),
    ).toEqual([{ startOffsetUtf16: 0, endOffsetUtf16: 10 }]);
  });

  it("schema version is frozen for SSL-0", () => {
    expect(SCRIPT_LIBRARY_PROJECTION_SCHEMA_VERSION).toBe(1);
  });

  it("buildMissingMediaReport classifies covered/partial/missing", () => {
    const map = {
      schemaVersion: 1,
      kind: "studio-episode-unit-media-map",
      projectRoot: "/tmp/p",
      season: "S1",
      episode: "S1E2",
      unitCount: 3,
      withAnyMedia: 2,
      missingAllMedia: 1,
      truncated: false,
      builtAt: "t",
      units: [
        {
          unitId: "U1",
          unitRevision: 1,
          season: "S1",
          episode: "S1E2",
          sequence: 1,
          title: "a",
          scriptRevisionId: "r1",
          scriptDocumentId: "d1",
          durationSeconds: 15,
          panelCount: 2,
          panels: [],
          coveredPanelCount: 2,
          missingPanelCount: 0,
        },
        {
          unitId: "U2",
          unitRevision: 1,
          season: "S1",
          episode: "S1E2",
          sequence: 2,
          title: "b",
          scriptRevisionId: null,
          scriptDocumentId: null,
          durationSeconds: 15,
          panelCount: 3,
          panels: [],
          coveredPanelCount: 1,
          missingPanelCount: 2,
        },
        {
          unitId: "U3",
          unitRevision: 1,
          season: "S1",
          episode: "S1E2",
          sequence: 3,
          title: "c",
          scriptRevisionId: null,
          scriptDocumentId: null,
          durationSeconds: 15,
          panelCount: 2,
          panels: [],
          coveredPanelCount: 0,
          missingPanelCount: 2,
        },
      ],
    } as EpisodeUnitMediaMap;
    const report = buildMissingMediaReport(map);
    expect(report.coveredCount).toBe(1);
    expect(report.partialCount).toBe(1);
    expect(report.missingAllCount).toBe(1);
    expect(report.items.map((i) => i.status)).toEqual(["covered", "partial", "missing-all"]);
  });

  it("spansOverlap uses half-open ranges and rejects empty spans", () => {
    expect(spansOverlap({ startOffsetUtf16: 0, endOffsetUtf16: 10 }, { startOffsetUtf16: 10, endOffsetUtf16: 20 })).toBe(false);
    expect(spansOverlap({ startOffsetUtf16: 0, endOffsetUtf16: 10 }, { startOffsetUtf16: 9, endOffsetUtf16: 12 })).toBe(true);
    expect(spansOverlap({ startOffsetUtf16: 5, endOffsetUtf16: 5 }, { startOffsetUtf16: 0, endOffsetUtf16: 10 })).toBe(false);
  });

  it("resolveScriptSpanMediaMap returns intersecting panels only", () => {
    const unit = (partial: Partial<UnitSpanMediaMapEntry> & Pick<UnitSpanMediaMapEntry, "unitId" | "sequence" | "panels">): UnitSpanMediaMapEntry => ({
      unitRevision: 1,
      season: "S1",
      episode: "E2",
      title: partial.unitId,
      scriptRevisionId: "rev-1",
      scriptDocumentId: "doc-1",
      durationSeconds: 15,
      panelCount: partial.panels.length,
      coveredPanelCount: partial.panels.filter((panel) => panel.hasMedia).length,
      missingPanelCount: partial.panels.filter((panel) => !panel.hasMedia).length,
      ...partial,
    });
    const map = {
      projectRoot: "/tmp/iso",
      season: "S1",
      episode: "E2",
      units: [
        unit({
          unitId: "U1",
          sequence: 1,
          panels: [{
            panelIndex: 1,
            panelId: "p1",
            title: "g1",
            sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: 20 }],
            packId: "pack-1",
            packFingerprint: "fp",
            rawSha256: "aa",
            labeledSha256: null,
            generationRunId: "run-1",
            hasMedia: true,
          }],
        }),
        unit({
          unitId: "U2",
          sequence: 2,
          panels: [{
            panelIndex: 1,
            panelId: "p2",
            title: "g1",
            sourceSpans: [{ startOffsetUtf16: 40, endOffsetUtf16: 60 }],
            packId: null,
            packFingerprint: null,
            rawSha256: null,
            labeledSha256: null,
            generationRunId: null,
            hasMedia: false,
          }],
        }),
      ],
    };
    const hit = resolveScriptSpanMediaMap(map, { startOffsetUtf16: 10, endOffsetUtf16: 15 });
    expect(hit.kind).toBe("studio-script-span-media-map");
    expect(hit.matchCount).toBe(1);
    expect(hit.missingCount).toBe(0);
    expect(hit.hits[0]?.unitId).toBe("U1");
    expect(hit.hits[0]?.rawSha256).toBe("aa");
    const miss = resolveScriptSpanMediaMap(map, { startOffsetUtf16: 40, endOffsetUtf16: 45 });
    expect(miss.matchCount).toBe(1);
    expect(miss.missingCount).toBe(1);
    expect(resolveScriptSpanMediaMap(map, { startOffsetUtf16: 80, endOffsetUtf16: 90 }).matchCount).toBe(0);
    expect(() => resolveScriptSpanMediaMap(map, { startOffsetUtf16: 9, endOffsetUtf16: 3 })).toThrow(/有效/);
  });

  it("selectLatestPanelPack ignores unit-grid and other panels", () => {
    const packs = [
      { targetKind: "unit-grid", panelId: "unit-grid:U1", sequence: 9, packId: "grid-new" },
      { targetKind: "panel", panelId: "p2", sequence: 8, packId: "p2-new" },
      { targetKind: "panel", panelId: "p1", sequence: 3, packId: "p1-old" },
      { targetKind: "panel", panelId: "p1", sequence: 5, packId: "p1-new" },
    ];
    expect(selectLatestPanelPack(packs, "p1")?.packId).toBe("p1-new");
    expect(selectLatestPanelPack(packs, "p2")?.packId).toBe("p2-new");
    expect(selectLatestPanelPack(packs, "p3")).toBeUndefined();
  });

  it("applyPackMediaToPanels does not copy one pack onto every panel", () => {
    const panels = applyPackMediaToPanels(
      [
        { index: 1, id: "p1", title: "g1", sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: 10 }] },
        { index: 2, id: "p2", title: "g2", sourceSpans: [{ startOffsetUtf16: 10, endOffsetUtf16: 20 }] },
      ],
      new Map([
        ["p2", {
          packId: "pack-p2",
          packFingerprint: "fp2",
          rawSha256: "raw-p2",
          labeledSha256: null,
          generationRunId: "run-p2",
        }],
      ]),
    );
    expect(panels[0]).toMatchObject({ panelId: "p1", hasMedia: false, rawSha256: null, packId: null });
    expect(panels[1]).toMatchObject({ panelId: "p2", hasMedia: true, rawSha256: "raw-p2", packId: "pack-p2" });
    expect(pickFirstCoveredPanel(panels)?.panelId).toBe("p2");
    expect(formatPanelCoverageMarks(panels)).toBe("G1缺 G2有");
  });
});

describe("SSL-0 ScriptSpanMediaMap 入口", () => {
  it("MCP 暴露 script-span-media-map", () => {
    const server = readFileSync(path.join(repoRoot, "src/mcp/server.ts"), "utf8");
    expect(server).toContain("script-span-media-map");
    expect(server).toContain("resolveScriptSpanMediaMap");
    expect(server).toContain("startOffsetUtf16");
    expect(readFileSync(path.join(repoRoot, "src/core/studio-script-library-projection.ts"), "utf8")).toContain("export async function getStudioScriptSpanMediaMap");
  });

  it("episode-unit-media-map 按 panel 读 pack，不把 unit-grid 摊到所有宫格", () => {
    const source = readFileSync(path.join(repoRoot, "src/core/studio-script-library-projection.ts"), "utf8");
    expect(source).toContain("listStudioGenerationPacksByUnit(projectRoot, { unitId, panelId, limit: 20 })");
    expect(source).toContain("listPanelPacksNewestFirst");
    expect(source).toContain("applyPackMediaToPanels");
    expect(source).not.toContain("panel 级 media 目前与 unit-grid 共享同一结果图");
    const align = readFileSync(path.join(repoRoot, "src/core/studio-script-media-align.ts"), "utf8");
    expect(align).toContain("pickFirstCoveredPanel");
    expect(align).toContain("panels: u.panels");
    expect(align).not.toContain("const firstPanel = u.panels[0]");
  });
});
