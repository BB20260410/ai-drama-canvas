import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachAlignRowConsistencyPeeks,
  matchOutlineAnchorsForUnit,
  SCRIPT_MEDIA_ALIGN_SCHEMA_VERSION,
  type ScriptMediaAlignRow,
} from "../src/core/studio-script-media-align.js";
import {
  indexStudioConsistencyPeek,
  peekStudioConsistencyVerdictByRunId,
  type ConsistencyEvaluationResult,
} from "../src/core/studio-consistency-evaluator.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function alignRow(partial: Partial<ScriptMediaAlignRow> & Pick<ScriptMediaAlignRow, "unitId" | "sequence">): ScriptMediaAlignRow {
  return {
    title: partial.unitId,
    formalCommitted: false,
    isEarliest: false,
    reviewDecision: null,
    scriptRevisionId: null,
    panelCount: 2,
    coveredPanelCount: 2,
    missingPanelCount: 0,
    status: "covered",
    rawSha256: null,
    labeledSha256: null,
    packId: null,
    packFingerprint: null,
    generationRunId: null,
    trace: { byPack: null, byRun: null },
    sourceSpans: [],
    outlineAnchors: [],
    consistencyPeek: { status: "unevaluated" },
    panels: [],
    ...partial,
  };
}

describe("studio-script-media-align", () => {
  it("matches outline headings containing unit id", () => {
    const outline = [
      { level: 2, title: "场1", lineIndex: 0, startOffsetUtf16: 0, endOffsetUtf16: 2 },
      {
        level: 2,
        title: "S1E2-U01 · 15s · 4宫格",
        lineIndex: 1,
        startOffsetUtf16: 10,
        endOffsetUtf16: 30,
      },
      {
        level: 3,
        title: "S1E2-U01-G1 · 5s",
        lineIndex: 2,
        startOffsetUtf16: 40,
        endOffsetUtf16: 55,
      },
      {
        level: 2,
        title: "S1E2-U02 下一单元",
        lineIndex: 3,
        startOffsetUtf16: 60,
        endOffsetUtf16: 80,
      },
    ];
    const anchors = matchOutlineAnchorsForUnit("S1E2-U01", outline);
    expect(anchors).toHaveLength(2);
    expect(anchors[0]?.title).toContain("U01");
    expect(matchOutlineAnchorsForUnit("S1E2-U99", outline)).toEqual([]);
  });

  it("schema frozen", () => {
    expect(SCRIPT_MEDIA_ALIGN_SCHEMA_VERSION).toBe(1);
  });

  it("attachAlignRowConsistencyPeeks 只挂缓存四态，未命中为未评估", () => {
    const rows = attachAlignRowConsistencyPeeks(
      [
        alignRow({ unitId: "U1", sequence: 1, generationRunId: "run-hit" }),
        alignRow({ unitId: "U2", sequence: 2, generationRunId: "run-miss" }),
        alignRow({ unitId: "U3", sequence: 3 }),
      ],
      new Map([["run-hit", "needs-review"]]),
    );
    expect(rows[0]?.consistencyPeek).toEqual({ status: "cached", verdict: "needs-review" });
    expect(rows[1]?.consistencyPeek).toEqual({ status: "unevaluated" });
    expect(rows[2]?.consistencyPeek).toEqual({ status: "unevaluated" });
    const withPanels = attachAlignRowConsistencyPeeks(
      [alignRow({
        unitId: "U4",
        sequence: 4,
        generationRunId: "run-unit",
        panels: [{
          panelIndex: 2,
          panelId: "p2",
          title: "g2",
          sourceSpans: [],
          packId: null,
          packFingerprint: null,
          rawSha256: "raw2",
          labeledSha256: null,
          generationRunId: "run-panel",
          hasMedia: true,
          shotComposition: "中景",
          visualAction: "停住",
          consistencyPeek: { status: "unevaluated" },
        }],
      })],
      new Map([["run-panel", "drifted"], ["run-unit", "consistent"]]),
    );
    expect(withPanels[0]?.consistencyPeek).toEqual({ status: "cached", verdict: "consistent" });
    expect(withPanels[0]?.panels[0]?.consistencyPeek).toEqual({ status: "cached", verdict: "drifted" });
  });

  it("runId peek 不跑像素，瞬态结果不编入", () => {
    const cached: ConsistencyEvaluationResult = {
      schemaVersion: 1,
      kind: "studio-consistency-evaluation",
      verdict: "drifted",
      assets: [],
      evidence: {
        projectId: "p",
        generationRunId: "run-align-peek",
        resultSha256: "aa",
        referenceSha256: [],
        assetVersionIds: [],
        packFingerprint: "fp",
        evaluatorVersion: "test",
        configSha: "cfg",
      },
      computedAt: "2026-08-26T17:51:00.000Z",
      durationMs: 1,
      frameNotes: [],
    };
    indexStudioConsistencyPeek(cached);
    expect(peekStudioConsistencyVerdictByRunId("run-align-peek")).toBe("drifted");
    indexStudioConsistencyPeek({ ...cached, evidence: { ...cached.evidence, generationRunId: "run-transient" }, transient: true, verdict: "not-checkable" });
    expect(peekStudioConsistencyVerdictByRunId("run-transient")).toBeUndefined();
    expect(peekStudioConsistencyVerdictByRunId("run-never")).toBeUndefined();
  });
});

describe("对照行四态 peek 源码合同", () => {
  it("align 动态 import peek，不调用 evaluate，不自动 Review PASS", () => {
    const align = readFileSync(path.join(repoRoot, "src/core/studio-script-media-align.ts"), "utf8");
    const vue = readFileSync(path.join(repoRoot, "src/renderer/src/components/ScriptMediaAlignView.vue"), "utf8");
    expect(align).toContain('import("./studio-consistency-evaluator.js")');
    expect(align).toContain("peekStudioConsistencyVerdictByRunId");
    expect(align).not.toContain("evaluateStudioConsistency");
    expect(align).not.toContain("evaluateStudioReviewTargetConsistency");
    expect(align).not.toMatch(/^import \{[^}]*peekStudioConsistencyVerdictByRunId/mu);
    expect(vue).toContain("align-peek-");
    expect(vue).toContain("未评估");
    expect(vue).toContain("peekLabel");
    expect(align).toContain("panels: u.panels");
    expect(vue).toContain("align-panel-list");
    expect(vue).toContain("align-panel-peek");
    expect(align).toContain("row.panels.map((panel) => panel.generationRunId)");
  });
});
