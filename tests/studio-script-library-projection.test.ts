import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyPackMediaToPanels,
  buildMissingMediaReport,
  countCoveredUnits,
  formatPanelCoverageMarks,
  formatPanelBeatLine,
  formatPanelLightingCostumeLine,
  formatPanelShotTypeLine,
  formatUnitBeatLine,
  formatPanelStandingGaps,
  formatPanelStandingHandoff,
  formatSceneBackReferences,
  formatWizardCharacterBackReferenceLine,
  formatWizardPropBackReferenceLine,
  formatWizardSceneBackReferenceLine,
  listPanelStandingGaps,
  listSceneAssetMentions,
  listSceneBackReferences,
  wizardCharacterMentionsFromSuggestedIds,
  wizardPropMentionsFromSuggestedIds,
  wizardSceneMentionsFromSuggestedIds,
  WIZARD_CHARACTER_BACKREF_UNLOADED_NOTE,
  WIZARD_PROP_BACKREF_UNLOADED_NOTE,
  WIZARD_SCENE_BACKREF_UNLOADED_NOTE,
  normalizeSourceSpans,
  summarizePanelAssetMentions,
  pickFirstCoveredPanel,
  pickFirstMissingPanel,
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

  it("countCoveredUnits counts units with any panel media", () => {
    expect(countCoveredUnits([
      { panels: [{ hasMedia: false }, { hasMedia: true }] },
      { panels: [{ hasMedia: false }] },
      { panels: [] },
    ])).toBe(1);
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
            shotComposition: "近景",
            visualAction: "抬手",
            filmingMethod: "固定",
            sceneLighting: "窗侧冷光",
            costumeState: "素袍",
            shotType: "original",
            assetMentions: [],
            previousHandoff: null,
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
            shotComposition: "",
            visualAction: "",
            filmingMethod: "",
            sceneLighting: "",
            costumeState: "",
            shotType: "",
            assetMentions: [],
            previousHandoff: null,
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
    expect(hit.hits[0]?.shotComposition).toBe("近景");
    expect(hit.hits[0]?.visualAction).toBe("抬手");
    expect(hit.hits[0]?.filmingMethod).toBe("固定");
    expect(hit.hits[0]?.previousHandoff).toBeNull();
    expect(hit.hits[0]?.sceneLighting).toBe("窗侧冷光");
    expect(hit.hits[0]?.costumeState).toBe("素袍");
    expect(hit.hits[0]?.shotType).toBe("original");
    expect(hit.hits[0]?.shotTypeLine).toContain("原镜：G1");
    expect(hit.hits[0]?.shotTypeLine).toContain("必须锚定原文");
    expect(hit.hits[0]?.shotTypeLine).toContain("不是 BindingSet");
    expect(formatPanelShotTypeLine(hit.hits[0])).toContain("原镜：G1");
    expect(formatPanelShotTypeLine({ panelIndex: 2, shotType: "extension" })).toContain("扩写格：G2");
    expect(formatPanelShotTypeLine({ panelIndex: 3, shotType: "" })).toContain("锁版未记镜头类型");
    expect(formatPanelShotTypeLine(null)).toBe("没有宫格可查镜头类型");
    expect(hit.hits[0]?.beatLine).toBe("锁版未记 15s 节拍。不是 BindingSet，不能当 generation-ready。");
    expect(formatPanelBeatLine(null)).toBe("没有宫格可查 15s 节拍");
    expect(formatPanelBeatLine({ panelIndex: 1, startSeconds: 0, endSeconds: 5, durationSeconds: 5 })).toContain("15s 节拍：G1 0–5s（5s）");
    expect(formatPanelBeatLine({ panelIndex: 1, startSeconds: 0, endSeconds: 5, durationSeconds: 5 })).toContain("本单元须 2–6 格合计 15.0s");
    expect(formatPanelBeatLine({ panelIndex: 2, startSeconds: 0, endSeconds: 16, durationSeconds: 16 })).toContain("单格超过 15.0s");
    expect(formatUnitBeatLine([])).toBe("没有宫格可查 15s 节拍");
    expect(formatUnitBeatLine([
      { panelIndex: 1, startSeconds: 0, endSeconds: 7.5, durationSeconds: 7.5 },
      { panelIndex: 2, startSeconds: 7.5, endSeconds: 15, durationSeconds: 7.5 },
    ])).toContain("2 格合计 15.0s");
    expect(formatUnitBeatLine([
      { panelIndex: 1, startSeconds: 0, endSeconds: 5, durationSeconds: 5 },
    ])).toContain("格数 1（须 2–6）");
    expect(hit.hits[0]?.sceneBackReferences).toEqual([]);
    expect(hit.hits[0]?.sceneBackReferenceLine).toContain("本格快照未提及场景");
    expect(hit.hits[0]?.propBackReferences).toEqual([]);
    expect(hit.hits[0]?.propBackReferenceLine).toContain("本格快照未提及道具");
    expect(hit.hits[0]?.characterBackReferences).toEqual([]);
    expect(hit.hits[0]?.characterBackReferenceLine).toContain("本格快照未提及角色");
    expect(formatPanelLightingCostumeLine(hit.hits[0])).toContain("锁版光线：G1 窗侧冷光");
    expect(formatPanelLightingCostumeLine(hit.hits[0])).toContain("锁版服装：G1 素袍");
    expect(formatPanelLightingCostumeLine(hit.hits[0])).toContain("不是 BindingSet");
    const miss = resolveScriptSpanMediaMap(map, { startOffsetUtf16: 40, endOffsetUtf16: 45 });
    expect(miss.matchCount).toBe(1);
    expect(miss.missingCount).toBe(1);
    expect(resolveScriptSpanMediaMap(map, { startOffsetUtf16: 80, endOffsetUtf16: 90 }).matchCount).toBe(0);
    expect(() => resolveScriptSpanMediaMap(map, { startOffsetUtf16: 9, endOffsetUtf16: 3 })).toThrow(/有效/);
  });

  it("resolveScriptSpanMediaMap copies previous-panel standing handoff", () => {
    const panels = applyPackMediaToPanels(
      [
        {
          index: 1,
          id: "p1",
          title: "g1",
          sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: 20 }],
          shotComposition: "中景",
          visualAction: "站定",
          filmingMethod: "固定",
        },
        {
          index: 2,
          id: "p2",
          title: "g2",
          sourceSpans: [{ startOffsetUtf16: 10, endOffsetUtf16: 30 }],
          shotComposition: "近景",
          visualAction: "抬手",
          filmingMethod: "推",
        },
      ],
      new Map(),
    );
    const map = {
      projectRoot: "/tmp/iso",
      season: "S1",
      episode: "E2",
      units: [{
        unitId: "U1",
        unitRevision: 1,
        season: "S1",
        episode: "E2",
        sequence: 1,
        title: "U1",
        scriptRevisionId: "rev-1",
        scriptDocumentId: "doc-1",
        durationSeconds: 15,
        panelCount: 2,
        coveredPanelCount: 0,
        missingPanelCount: 2,
        panels,
      }],
    };
    const hit = resolveScriptSpanMediaMap(map, { startOffsetUtf16: 12, endOffsetUtf16: 18 });
    expect(hit.matchCount).toBe(2);
    expect(hit.hits[0]?.panelId).toBe("p1");
    expect(hit.hits[0]?.previousHandoff).toBeNull();
    expect(hit.hits[1]?.panelId).toBe("p2");
    expect(hit.hits[1]?.shotComposition).toBe("近景");
    expect(hit.hits[1]?.filmingMethod).toBe("推");
    expect(hit.hits[1]?.previousHandoff).toEqual({
      panelIndex: 1,
      panelId: "p1",
      shotComposition: "中景",
      visualAction: "站定",
      filmingMethod: "固定",
    });
    expect(hit.hits[1]?.sceneLighting).toBe("");
    expect(hit.hits[1]?.costumeState).toBe("");
    expect(hit.hits[1]?.sceneBackReferences).toEqual([]);
    expect(hit.hits[1]?.sceneBackReferenceLine).toContain("本格快照未提及场景");
    expect(hit.hits[1]?.propBackReferences).toEqual([]);
    expect(hit.hits[1]?.propBackReferenceLine).toContain("本格快照未提及道具");
    expect(hit.hits[1]?.characterBackReferences).toEqual([]);
    expect(hit.hits[1]?.characterBackReferenceLine).toContain("本格快照未提及角色");
    expect(formatPanelStandingHandoff(hit.hits[1]?.previousHandoff ?? null)).toContain("G1 中景");
    expect(formatPanelLightingCostumeLine(hit.hits[1])).toContain("锁版未记光线");
    expect(formatPanelLightingCostumeLine(null)).toBe("没有宫格可查光线/服化");
  });

  it("resolveScriptSpanMediaMap 投影跨单元场景回指，忽略更晚单元", () => {
    const map = {
      projectRoot: "/tmp/iso",
      season: "S1",
      episode: "E2",
      units: [
        {
          unitId: "U1",
          unitRevision: 1,
          season: "S1",
          episode: "E2",
          sequence: 1,
          title: "早",
          scriptRevisionId: null,
          scriptDocumentId: null,
          durationSeconds: 15,
          panelCount: 1,
          coveredPanelCount: 0,
          missingPanelCount: 1,
          panels: [{
            panelIndex: 1,
            panelId: "u1p1",
            title: "g1",
            sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: 10 }],
            packId: null,
            packFingerprint: null,
            rawSha256: null,
            labeledSha256: null,
            generationRunId: null,
            hasMedia: false,
            shotComposition: "",
            visualAction: "",
            filmingMethod: "",
            sceneLighting: "",
            costumeState: "",
            shotType: "" as const,
            assetMentions: [
              { assetId: "scene-stone", category: "scene", role: "石室" },
              { assetId: "prop-mask", category: "prop", role: "黄金面具" },
              { assetId: "char-dou", category: "character", role: "豆姐" },
            ],
            previousHandoff: null,
          }],
        },
        {
          unitId: "U2",
          unitRevision: 1,
          season: "S1",
          episode: "E2",
          sequence: 2,
          title: "后",
          scriptRevisionId: null,
          scriptDocumentId: null,
          durationSeconds: 15,
          panelCount: 1,
          coveredPanelCount: 0,
          missingPanelCount: 1,
          panels: [{
            panelIndex: 1,
            panelId: "u2p1",
            title: "g1",
            sourceSpans: [{ startOffsetUtf16: 10, endOffsetUtf16: 20 }],
            packId: null,
            packFingerprint: null,
            rawSha256: null,
            labeledSha256: null,
            generationRunId: null,
            hasMedia: false,
            shotComposition: "",
            visualAction: "",
            filmingMethod: "",
            sceneLighting: "",
            costumeState: "",
            shotType: "" as const,
            assetMentions: [
              { assetId: "scene-stone", category: "scene", role: "石室" },
              { assetId: "prop-mask", category: "prop", role: "黄金面具" },
              { assetId: "char-dou", category: "character", role: "豆姐" },
            ],
            previousHandoff: null,
          }],
        },
        {
          unitId: "U3",
          unitRevision: 1,
          season: "S1",
          episode: "E2",
          sequence: 3,
          title: "更晚",
          scriptRevisionId: null,
          scriptDocumentId: null,
          durationSeconds: 15,
          panelCount: 1,
          coveredPanelCount: 0,
          missingPanelCount: 1,
          panels: [{
            panelIndex: 1,
            panelId: "u3p1",
            title: "g1",
            sourceSpans: [{ startOffsetUtf16: 20, endOffsetUtf16: 30 }],
            packId: null,
            packFingerprint: null,
            rawSha256: null,
            labeledSha256: null,
            generationRunId: null,
            hasMedia: false,
            shotComposition: "",
            visualAction: "",
            filmingMethod: "",
            sceneLighting: "",
            costumeState: "",
            shotType: "" as const,
            assetMentions: [
              { assetId: "scene-stone", category: "scene", role: "石室" },
              { assetId: "prop-mask", category: "prop", role: "黄金面具" },
              { assetId: "char-dou", category: "character", role: "豆姐" },
            ],
            previousHandoff: null,
          }],
        },
      ],
    };
    const hit = resolveScriptSpanMediaMap(map, { startOffsetUtf16: 10, endOffsetUtf16: 20 });
    expect(hit.hits).toHaveLength(1);
    expect(hit.hits[0]?.sceneBackReferenceLine).toContain("U1 G1 石室");
    expect(hit.hits[0]?.sceneBackReferenceLine).toContain("不是 BindingSet");
    expect(hit.hits[0]?.sceneBackReferenceLine).not.toContain("U3");
    expect(hit.hits[0]?.sceneBackReferences).toEqual([{
      assetId: "scene-stone",
      role: "石室",
      unitId: "U1",
      sequence: 1,
      panelIndex: 1,
      panelId: "u1p1",
    }]);
    expect(hit.hits[0]?.propBackReferenceLine).toContain("U1 G1 黄金面具");
    expect(hit.hits[0]?.propBackReferenceLine).toContain("不是 BindingSet");
    expect(hit.hits[0]?.propBackReferenceLine).not.toContain("U3");
    expect(hit.hits[0]?.propBackReferences).toEqual([{
      assetId: "prop-mask",
      role: "黄金面具",
      unitId: "U1",
      sequence: 1,
      panelIndex: 1,
      panelId: "u1p1",
    }]);
    expect(hit.hits[0]?.characterBackReferenceLine).toContain("U1 G1 豆姐");
    expect(hit.hits[0]?.characterBackReferenceLine).toContain("不是 BindingSet");
    expect(hit.hits[0]?.characterBackReferenceLine).not.toContain("U3");
    expect(hit.hits[0]?.characterBackReferences).toEqual([{
      assetId: "char-dou",
      role: "豆姐",
      unitId: "U1",
      sequence: 1,
      panelIndex: 1,
      panelId: "u1p1",
    }]);
    expect(hit.hits[0]?.sceneLighting).toBe("");
    expect(hit.hits[0]?.costumeState).toBe("");
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
    expect(panels[0]).toMatchObject({ panelId: "p1", hasMedia: false, rawSha256: null, packId: null, shotComposition: "", visualAction: "" });
    expect(panels[1]).toMatchObject({ panelId: "p2", hasMedia: true, rawSha256: "raw-p2", packId: "pack-p2" });
    const timed = applyPackMediaToPanels(
      [
        { index: 1, id: "p1", startSeconds: 0, endSeconds: 7.5, durationSeconds: 7.5 },
        { index: 2, id: "p2", startSeconds: 7.5, endSeconds: 15 },
      ],
      new Map(),
    );
    expect(timed[0]).toMatchObject({ startSeconds: 0, endSeconds: 7.5, durationSeconds: 7.5 });
    expect(timed[1]).toMatchObject({ startSeconds: 7.5, endSeconds: 15, durationSeconds: 7.5 });
    expect(formatPanelBeatLine(timed[1])).toContain("7.5–15s（7.5s）");
    expect(formatUnitBeatLine(timed)).toContain("2 格合计 15.0s");
    const withComp = applyPackMediaToPanels(
      [{ index: 1, id: "p1", title: "g1", shotComposition: "近景三分", visualAction: "抬手" }],
      new Map(),
    );
    expect(withComp[0]).toMatchObject({ shotComposition: "近景三分", visualAction: "抬手", hasMedia: false, previousHandoff: null });
    const handed = applyPackMediaToPanels(
      [
        { index: 1, id: "p1", title: "g1", shotComposition: "中景", visualAction: "站定", filmingMethod: "固定", assets: [{ assetId: "char-a", category: "character", role: "豆姐" }] },
        { index: 2, id: "p2", title: "g2", shotComposition: "近景", visualAction: "抬手", filmingMethod: "推" },
      ],
      new Map(),
    );
    expect(handed[0]?.previousHandoff).toBeNull();
    expect(handed[1]?.previousHandoff).toEqual({
      panelIndex: 1,
      panelId: "p1",
      shotComposition: "中景",
      visualAction: "站定",
      filmingMethod: "固定",
    });
    expect(handed[0]?.assetMentions).toEqual([{ assetId: "char-a", category: "character", role: "豆姐" }]);
    expect(formatPanelStandingHandoff(handed[1]?.previousHandoff ?? null)).toContain("G1 中景");
    expect(listPanelStandingGaps(handed[1])).toEqual([]);
    expect(formatPanelStandingGaps(handed[1])).toContain("锁版站位已记");
    expect(listPanelStandingGaps({ shotComposition: "", visualAction: "抬手", filmingMethod: "" })).toEqual(["缺构图", "缺运镜"]);
    expect(formatPanelStandingGaps({
      shotComposition: "",
      visualAction: "",
      filmingMethod: "",
      previousHandoff: handed[1]?.previousHandoff ?? null,
    })).toContain("不是 BindingSet");
    expect(summarizePanelAssetMentions([{ assetId: "  ", role: "x" }, { assetId: "prop-1", category: "prop", role: "面具" }])).toEqual([
      { assetId: "prop-1", category: "prop", role: "面具" },
    ]);
    expect(listSceneAssetMentions([
      { assetId: "char-a", category: "character", role: "豆姐" },
      { assetId: "scene-stone", category: "scene", role: "石室" },
    ])).toEqual([{ assetId: "scene-stone", category: "scene", role: "石室" }]);
    expect(listSceneBackReferences({
      currentUnitId: "u2",
      currentSequence: 2,
      currentPanelIndex: 1,
      currentPanelId: "u2p1",
      sceneMentions: [{ assetId: "scene-stone", role: "石室" }],
      units: [
        {
          unitId: "u1",
          sequence: 1,
          panels: [{
            panelId: "u1p1",
            panelIndex: 1,
            assetMentions: [{ assetId: "scene-stone", category: "scene", role: "石室" }],
          }],
        },
        {
          unitId: "u2",
          sequence: 2,
          panels: [{
            panelId: "u2p1",
            panelIndex: 1,
            assetMentions: [{ assetId: "scene-stone", category: "scene", role: "石室" }],
          }],
        },
        {
          unitId: "u3",
          sequence: 3,
          panels: [{
            panelId: "u3p1",
            panelIndex: 1,
            assetMentions: [{ assetId: "scene-stone", category: "scene", role: "石室" }],
          }],
        },
      ],
    })).toEqual([{
      assetId: "scene-stone",
      role: "石室",
      unitId: "u1",
      sequence: 1,
      panelIndex: 1,
      panelId: "u1p1",
    }]);
    expect(listSceneBackReferences({
      currentUnitId: "u1",
      currentSequence: 1,
      currentPanelIndex: 2,
      currentPanelId: "u1p2",
      sceneMentions: [{ assetId: "scene-stone", role: "石室" }],
      units: [{
        unitId: "u1",
        sequence: 1,
        panels: [
          {
            panelId: "u1p1",
            panelIndex: 1,
            assetMentions: [{ assetId: "scene-stone", category: "scene", role: "石室" }],
          },
          {
            panelId: "u1p2",
            panelIndex: 2,
            assetMentions: [{ assetId: "scene-stone", category: "scene", role: "石室" }],
          },
        ],
      }],
    })).toEqual([{
      assetId: "scene-stone",
      role: "石室",
      unitId: "u1",
      sequence: 1,
      panelIndex: 1,
      panelId: "u1p1",
    }]);
    expect(listSceneBackReferences({
      currentUnitId: "u1",
      currentSequence: 1,
      currentPanelIndex: 1,
      currentPanelId: "u1p1",
      sceneMentions: [{ assetId: "scene-stone" }],
      units: [{
        unitId: "u1",
        sequence: 1,
        panels: [{
          panelId: "u1p1",
          panelIndex: 1,
          assetMentions: [{ assetId: "scene-stone", category: "scene", role: "石室" }],
        }],
      }],
    })).toEqual([]);
    expect(formatSceneBackReferences(0, [])).toContain("本格快照未提及场景");
    expect(formatSceneBackReferences(1, [])).toContain("没有同场景快照提及");
    expect(formatSceneBackReferences(1, [{
      assetId: "scene-stone",
      role: "石室",
      unitId: "u1",
      sequence: 1,
      panelIndex: 2,
      panelId: "u1p2",
    }])).toContain("U1 G2 石室");
    expect(formatSceneBackReferences(1, [{
      assetId: "scene-stone",
      role: "石室",
      unitId: "u1",
      sequence: 1,
      panelIndex: 2,
      panelId: "u1p2",
    }])).toContain("不是 BindingSet");
    expect(pickFirstCoveredPanel(panels)?.panelId).toBe("p2");
    expect(formatPanelCoverageMarks(panels)).toBe("G1缺 G2有");
    expect(pickFirstMissingPanel(panels)?.panelId).toBe("p1");
    expect(pickFirstMissingPanel(panels.filter((panel) => panel.hasMedia))).toBeUndefined();
  });

  it("向导场景回指只认对照板里出现过的 scene，不写冻结提示词", () => {
    const units = [{
      unitId: "u1",
      sequence: 1,
      panels: [{
        panelId: "u1p1",
        panelIndex: 1,
        assetMentions: [
          { assetId: "scene-stone", category: "scene", role: "石室" },
          { assetId: "char-a", category: "character", role: "豆姐" },
          { assetId: "prop-mask", category: "prop", role: "黄金面具" },
        ],
      }],
    }];
    expect(wizardSceneMentionsFromSuggestedIds(["scene-stone", "char-a"], units)).toEqual([
      { assetId: "scene-stone", category: "scene", role: "石室" },
    ]);
    expect(wizardSceneMentionsFromSuggestedIds(["char-a"], units)).toEqual([]);
    expect(wizardPropMentionsFromSuggestedIds(["prop-mask", "char-a"], units)).toEqual([
      { assetId: "prop-mask", category: "prop", role: "黄金面具" },
    ]);
    expect(wizardPropMentionsFromSuggestedIds(["char-a"], units)).toEqual([]);
    expect(wizardCharacterMentionsFromSuggestedIds(["char-a", "scene-stone"], units)).toEqual([
      { assetId: "char-a", category: "character", role: "豆姐" },
    ]);
    expect(wizardCharacterMentionsFromSuggestedIds(["scene-stone"], units)).toEqual([]);
    expect(formatWizardSceneBackReferenceLine({
      boardLoaded: false,
      currentSequence: 2,
      currentPanelIndex: 1,
      suggestedAssetIds: ["scene-stone"],
      units,
    })).toBe(WIZARD_SCENE_BACKREF_UNLOADED_NOTE);
    expect(formatWizardSceneBackReferenceLine({
      boardLoaded: true,
      currentSequence: 2,
      currentPanelIndex: 1,
      suggestedAssetIds: ["scene-stone"],
      units,
    })).toContain("U1 G1 石室");
    expect(formatWizardPropBackReferenceLine({
      boardLoaded: false,
      currentSequence: 2,
      currentPanelIndex: 1,
      suggestedAssetIds: ["prop-mask"],
      units,
    })).toBe(WIZARD_PROP_BACKREF_UNLOADED_NOTE);
    expect(formatWizardPropBackReferenceLine({
      boardLoaded: true,
      currentSequence: 2,
      currentPanelIndex: 1,
      suggestedAssetIds: ["prop-mask"],
      units,
    })).toContain("U1 G1 黄金面具");
    expect(formatWizardCharacterBackReferenceLine({
      boardLoaded: false,
      currentSequence: 2,
      currentPanelIndex: 1,
      suggestedAssetIds: ["char-a"],
      units,
    })).toBe(WIZARD_CHARACTER_BACKREF_UNLOADED_NOTE);
    expect(formatWizardCharacterBackReferenceLine({
      boardLoaded: true,
      currentSequence: 2,
      currentPanelIndex: 1,
      suggestedAssetIds: ["char-a"],
      units,
    })).toContain("U1 G1 豆姐");
    const wizard = readFileSync(path.join(repoRoot, "src/core/studio-storyboard-wizard.ts"), "utf8");
    expect(wizard).toContain("formatWizardPromptBody(input.panels)");
    expect(wizard).not.toContain("formatWizardSceneBackReferenceLine");
    expect(wizard).not.toContain("formatWizardPropBackReferenceLine");
    expect(wizard).not.toContain("formatWizardCharacterBackReferenceLine");
    expect(wizard).not.toContain("场景回指");
    expect(wizard).not.toContain("道具回指");
    expect(wizard).not.toContain("角色回指");
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
    expect(source).toContain("attachPanelStandingHandoffs");
    expect(source).toContain("summarizePanelAssetMentions");
    expect(source).toContain("listSceneBackReferences");
    expect(source).toContain("formatSceneBackReferenceLineFromBoard");
    expect(source).toContain("formatWizardSceneBackReferenceLine");
    expect(source).toContain("wizardSceneMentionsFromSuggestedIds");
    expect(source).toContain("sceneBackReferenceLine");
    expect(source).toContain("sceneBackReferences");
    expect(source).toContain("propBackReferenceLine");
    expect(source).toContain("propBackReferences");
    expect(source).toContain("characterBackReferenceLine");
    expect(source).toContain("characterBackReferences");
    expect(source).toContain("formatCharacterBackReferences");
    expect(source).toContain("formatPropBackReferences");
    expect(source).toContain("formatPanelLightingCostumeLine");
    expect(source).toContain("formatPanelShotTypeLine");
    expect(source).toContain("shotTypeLine");
    expect(source).toContain("formatPanelBeatLine");
    expect(source).toContain("formatUnitBeatLine");
    expect(source).toContain("beatLine");
    expect(source).toContain('from "./studio-scene-backrefs.js"');
    expect(source).toContain("不是 BindingSet，不能当 generation-ready");
    expect(source).not.toContain("getStudioBindingControl");
    expect(source).not.toContain("evaluateStudioConsistency");
    expect(source).not.toContain("panel 级 media 目前与 unit-grid 共享同一结果图");
    expect(source).toContain("summarizeScriptRevisionUnits");
    expect(source).toContain("coveredMediaCount = summary.coveredMediaCount");
    expect(source).not.toContain("轻量：不二次扫 pack；coveredMediaCount 在 episode map 更准");
    const align = readFileSync(path.join(repoRoot, "src/core/studio-script-media-align.ts"), "utf8");
    expect(align).toContain("pickFirstCoveredPanel");
    expect(align).toContain("panels: u.panels");
    expect(align).not.toContain("const firstPanel = u.panels[0]");
  });
});
