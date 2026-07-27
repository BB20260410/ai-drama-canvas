import { describe, expect, it } from "vitest";
import {
  applyStudioCanvasTimelinePositions,
  buildStudioCanvasTimelineLayout,
  filterStudioCanvasTimelineProgress,
  StudioCanvasTimelineLayoutError,
} from "../src/core/studio-canvas-timeline-layout.js";

describe("studio-canvas-timeline-layout", () => {
  it("按 sequence 与 startSeconds 排布单元/宫格并生成系统边", () => {
    const layout = buildStudioCanvasTimelineLayout({
      assets: [
        { assetId: "character-a", category: "character" },
        { assetId: "scene-b", category: "scene" },
      ],
      units: [
        {
          unitId: "U02",
          sequence: 2,
          label: "第二单元",
          panels: [],
        },
      {
        unitId: "U01",
        sequence: 1,
        label: "第一单元",
        hasApprovedUnitGridRaw: true,
        references: [
          { referenceId: "char-lock-v1", referenceType: "character", label: "角色参考" },
          { referenceId: "scene-lock-v1", referenceType: "scene", label: "场景参考" },
        ],
        panels: [
            {
              panelId: "P2",
              ordinal: 2,
              startSeconds: 5,
              assetIds: ["character-a", "scene-b"],
              hasRaw: true,
              hasLabeled: true,
              reviewDecision: "pass",
            },
            {
              panelId: "P1",
              ordinal: 1,
              startSeconds: 0,
              assetIds: ["character-a"],
              hasRaw: false,
              hasLabeled: false,
              reviewDecision: "none",
            },
          ],
        },
      ],
    }, { activeUnitId: "U01" });

    expect(layout.kind).toBe("studio-canvas-timeline-layout");
    expect(layout.activeUnitId).toBe("U01");
    expect(layout.unitCount).toBe(2);
    expect(layout.panelCount).toBe(2);
    // 单元时间序：U01 在 U02 左侧
    expect(layout.nodes["unit:U01"]!.x).toBeLessThan(layout.nodes["unit:U02"]!.x);
    // 宫格按 startSeconds：P1 在 P2 上方
    expect(layout.nodes["panel:P1"]!.y).toBeLessThan(layout.nodes["panel:P2"]!.y);
    // 流水线向右
    expect(layout.nodes["media:raw:P1"]!.x).toBeGreaterThan(layout.nodes["panel:P1"]!.x);
    expect(layout.nodes["media:labeled:P1"]!.x).toBeGreaterThan(layout.nodes["media:raw:P1"]!.x);
    // 已人工通过的整板 raw 贴在对应 15 秒单元下方，不混进 active panel 流水线。
    expect(layout.nodes["media:unit-grid-raw:U01"]!.x).toBe(layout.nodes["unit:U01"]!.x);
    expect(layout.nodes["media:unit-grid-raw:U01"]!.y).toBeGreaterThan(layout.nodes["unit:U01"]!.y);
    // 正式整板后的图生视频与末格交接各有独立列，不能与下一单元重叠。
    expect(layout.nodes["video-package:U01"]!.x).toBeGreaterThan(layout.nodes["media:unit-grid-raw:U01"]!.x);
    expect(layout.nodes["continuity:out:U01"]!.x).toBeGreaterThan(layout.nodes["video-package:U01"]!.x);
    expect(layout.nodes["continuity:out:U01"]!.x).toBeLessThan(layout.nodes["unit:U02"]!.x);
    expect(layout.nodes["reference:U01:char-lock-v1"]!.x).toBe(layout.nodes["media:unit-grid-raw:U01"]!.x);
    expect(layout.nodes["reference:U01:char-lock-v1"]!.y).toBeGreaterThan(layout.nodes["media:unit-grid-raw:U01"]!.y);
    expect(layout.nodes["reference:U01:char-lock-v1"]!.y).toBe(layout.nodes["reference:U01:scene-lock-v1"]!.y);
    expect(layout.nodes["reference:U01:char-lock-v1"]!.x).toBeLessThan(layout.nodes["reference:U01:scene-lock-v1"]!.x);

    const edgeIds = new Set(layout.edges.map((edge) => edge.id));
    expect(edgeIds.has("system:unit-next:U01:U02")).toBe(true);
    expect(edgeIds.has("system:panel-next:P1:P2")).toBe(true);
    expect(edgeIds.has("system:asset-panel:character-a:P1")).toBe(true);
    expect(edgeIds.has("system:panel-raw:P1")).toBe(true);
    expect(edgeIds.has("system:unit-raw:U01")).toBe(true);
    expect(edgeIds.has("system:reference-raw:U01:char-lock-v1")).toBe(true);
    expect(layout.edges.find((edge) => edge.id === "system:reference-raw:U01:char-lock-v1")).toMatchObject({
      sourceKind: "asset",
      targetKind: "raw",
      label: "角色参考",
    });

    expect(layout.panelTimeline.map((row) => row.panelId)).toEqual(["P1", "P2"]);
    expect(JSON.stringify(layout)).not.toMatch(/localPath|sqlite|base64|sha256/i);
  });

  it("force 应用可覆盖未钉死节点", () => {
    const timeline = buildStudioCanvasTimelineLayout({
      units: [{ unitId: "U1", sequence: 1, panels: [{ panelId: "p1", ordinal: 1, startSeconds: 0 }] }],
    });
    const applied = applyStudioCanvasTimelinePositions(
      { "panel:p1": { x: 1, y: 1 }, "unit:U1": { x: 9, y: 9 } },
      timeline,
      { pinnedNodeIds: ["unit:U1"], force: false },
    );
    expect(applied["unit:U1"]).toEqual({ x: 9, y: 9 });
    expect(applied["panel:p1"]).toEqual(timeline.nodes["panel:p1"]);

    const forced = applyStudioCanvasTimelinePositions(
      { "unit:U1": { x: 9, y: 9 } },
      timeline,
      { pinnedNodeIds: ["unit:U1"], force: true },
    );
    expect(forced["unit:U1"]).toEqual(timeline.nodes["unit:U1"]);
  });

  it("整板 raw 按单元剧情序贴在时间线下方，未通过单元不生成图片节点", () => {
    const layout = buildStudioCanvasTimelineLayout({
      units: [
        { unitId: "S1E01-U02", sequence: 2, hasApprovedUnitGridRaw: true },
        { unitId: "S1E01-U00", sequence: 0, hasApprovedUnitGridRaw: true },
        { unitId: "S1E01-U01", sequence: 1, hasApprovedUnitGridRaw: false },
      ],
    });
    const u00 = layout.nodes["unit:S1E01-U00"]!;
    const u01 = layout.nodes["unit:S1E01-U01"]!;
    const u02 = layout.nodes["unit:S1E01-U02"]!;
    expect(u00.x).toBeLessThan(u01.x);
    expect(u01.x).toBeLessThan(u02.x);
    expect(layout.nodes["media:unit-grid-raw:S1E01-U00"]!.x).toBe(u00.x);
    expect(layout.nodes["media:unit-grid-raw:S1E01-U02"]!.x).toBe(u02.x);
    expect(layout.nodes["media:unit-grid-raw:S1E01-U01"]).toBeUndefined();
  });

  it("超界与非法输入失败关闭", () => {
    expect(() => buildStudioCanvasTimelineLayout({
      units: Array.from({ length: 37 }, (_, i) => ({ unitId: `u${i}`, sequence: i + 1 })),
    })).toThrow(StudioCanvasTimelineLayoutError);

    expect(() => buildStudioCanvasTimelineLayout({
      units: [{ unitId: "u", panels: [{ panelId: "p", ordinal: 1, startSeconds: 99 }] }],
    })).toThrow(/startSeconds/);

    expect(() => buildStudioCanvasTimelineLayout({
      units: [{
        unitId: "u",
        hasApprovedUnitGridRaw: true,
        references: Array.from({ length: 7 }, (_, index) => ({ referenceId: `ref-${index}`, referenceType: "prop" as const })),
      }],
    })).toThrow(/冻结参考超过/);
  });

  it("多单元进度过滤：unitId / 角色 / review 状态", () => {
    const units = [
      {
        unitId: "U01",
        sequence: 1,
        panels: [
          {
            panelId: "P1",
            ordinal: 1,
            startSeconds: 0,
            assetIds: ["character-qingdeng-ke"],
            reviewDecision: "pass" as const,
          },
          {
            panelId: "P2",
            ordinal: 2,
            startSeconds: 5,
            assetIds: ["character-qingdeng-ke"],
            reviewDecision: "rework" as const,
          },
        ],
      },
      {
        unitId: "U02",
        sequence: 2,
        panels: [
          {
            panelId: "P3",
            ordinal: 1,
            startSeconds: 0,
            assetIds: ["character-other", "scene-shixue"],
            reviewDecision: "none" as const,
          },
        ],
      },
      {
        unitId: "U03",
        sequence: 3,
        panels: [
          {
            panelId: "P4",
            ordinal: 1,
            startSeconds: 0,
            assetIds: ["character-qingdeng-ke"],
            reviewDecision: "pass" as const,
          },
        ],
      },
    ];
    const assets = [
      { assetId: "character-qingdeng-ke", category: "character" as const, label: "青灯客" },
      { assetId: "character-other", category: "character" as const, label: "路人" },
    ];

    const byUnit = filterStudioCanvasTimelineProgress({ units, assets }, { unitId: "U02" });
    expect(byUnit.matchedUnitIds).toEqual(["U02"]);
    expect(byUnit.matchedPanelIds).toEqual(["P3"]);

    const byEpisodePrefix = filterStudioCanvasTimelineProgress(
      {
        units: [
          { unitId: "S1E2-U01", label: "开场", panels: [] },
          { unitId: "S1E2-U02", label: "承接", panels: [] },
          { unitId: "S1E3-U01", label: "别集", panels: [] },
        ],
      },
      { unitQuery: "S1E2" },
    );
    expect(byEpisodePrefix.matchedUnitIds).toEqual(["S1E2-U01", "S1E2-U02"]);

    const byCharacter = filterStudioCanvasTimelineProgress(
      { units, assets },
      { characterQuery: "青灯" },
    );
    expect(byCharacter.matchedUnitIds).toEqual(["U01", "U03"]);
    expect(byCharacter.matchedPanelIds).toEqual(["P1", "P2", "P4"]);

    const bySceneSha = filterStudioCanvasTimelineProgress(
      {
        units,
        assets: [
          ...assets,
          { assetId: "scene-shixue", category: "scene" as const, label: "蜀山石穴 618224e5fd9bd0bf" },
        ],
      },
      { assetQuery: "618224e5" },
    );
    expect(bySceneSha.matchedUnitIds).toEqual(["U02"]);
    expect(bySceneSha.matchedPanelIds).toEqual(["P3"]);

    const pending = filterStudioCanvasTimelineProgress(
      { units, assets },
      { reviewStatus: "any-pending" },
    );
    expect(pending.matchedPanelIds).toEqual(["P2", "P3"]);

    // multi-unit layout still orders by sequence
    const layout = buildStudioCanvasTimelineLayout({ units, assets }, { activeUnitId: "U01" });
    expect(layout.nodes["unit:U01"]!.x).toBeLessThan(layout.nodes["unit:U02"]!.x);
    expect(layout.nodes["unit:U02"]!.x).toBeLessThan(layout.nodes["unit:U03"]!.x);
    expect(layout.edges.some((edge) => edge.id === "system:unit-next:U01:U02")).toBe(true);
  });
});
