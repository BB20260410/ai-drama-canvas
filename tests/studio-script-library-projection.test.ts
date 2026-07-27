import { describe, expect, it } from "vitest";
import {
  buildMissingMediaReport,
  normalizeSourceSpans,
  pickRawLabeledFromResults,
  SCRIPT_LIBRARY_PROJECTION_SCHEMA_VERSION,
  type EpisodeUnitMediaMap,
} from "../src/core/studio-script-library-projection.js";

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
});
