import { describe, expect, it } from "vitest";
import {
  mapMaterialStudioProjectOverview,
  materialTimelineStatus,
  studioPanelStatusLabel,
} from "../src/renderer/src/material-studio-read-mapper.js";
import type { MaterialStudioReadMapperInput } from "../src/renderer/src/material-studio-read-mapper.js";

function fixture(overrides: Partial<MaterialStudioReadMapperInput> = {}): MaterialStudioReadMapperInput {
  return {
    shell: { project: { name: "测试工程" } } as MaterialStudioReadMapperInput["shell"],
    material: {
      counts: { characters: 2, scenes: 3, props: 4, styles: 5, media: 6, canonicalAssets: 14 },
    } as MaterialStudioReadMapperInput["material"],
    production: {
      counts: { textDocuments: 7, scriptDocuments: 4, promptDocuments: 3, units: 8 },
    } as MaterialStudioReadMapperInput["production"],
    dashboardOverview: {
      operation: "overview",
      nextAction: { code: "core-next", label: "继续绑定", reason: "Core 原因", requiresWrite: true },
      checkpoint: { completedSlotCount: 9 },
    } as MaterialStudioReadMapperInput["dashboardOverview"],
    currentUnit: null,
    ...overrides,
  };
}

describe("Material Studio read mapper", () => {
  it("nextAction 直接透传 Core，且无 locator 时不臆造定位", () => {
    const overview = mapMaterialStudioProjectOverview(fixture());
    expect(overview.nextAction).toBe("继续绑定：Core 原因");
    expect(overview.nextActionControl).toEqual({
      code: "core-next", label: "继续绑定", reason: "Core 原因", requiresWrite: true,
    });
    expect(overview.nextActionControl?.locator).toBeUndefined();
    expect(overview.timeline.completedUnitCount).toBe(9);
    expect(overview.timeline.currentLabel).toBe("已审片槽位 9");
  });

  it("有当前单元时保留 panel 顺序和 checkpoint 已审片槽位", () => {
    const overview = mapMaterialStudioProjectOverview(fixture({
      currentUnit: {
        operation: "unit",
        unit: { episodeId: "EP01", label: "开场", panelCount: 2 },
        panels: [
          { id: "p-1", ordinal: 1, label: "门口", durationSeconds: 3, status: "ambiguous" },
          { id: "p-2", ordinal: 2, label: "转身", durationSeconds: 12, status: "generation-ready" },
        ],
      } as MaterialStudioReadMapperInput["currentUnit"],
    }));

    expect(overview.timeline.currentLabel).toBe("EP01 · 开场 · 2 宫格 · 已审片槽位 9");
    expect(overview.timeline.segments).toEqual([
      { id: "p-1", label: "1. 门口 · 待消歧", durationSeconds: 3, status: "current" },
      { id: "p-2", label: "2. 转身 · 可生成", durationSeconds: 12, status: "complete" },
    ]);
  });

  it("完整映射 binding 状态，未知 status 不进入 UI 合同", () => {
    expect([
      ["generation-ready", "complete", "可生成"],
      ["ambiguous", "current", "待消歧"],
      ["unmatched", "current", "缺少资产"],
      ["bound", "current", "已绑定"],
      ["stale", "current", "需更新"],
      ["pending", "pending", "待处理"],
      ["unchecked", "pending", "待分析"],
    ].map(([status, timeline, label]) => ({
      timeline: materialTimelineStatus(status as Parameters<typeof materialTimelineStatus>[0]),
      label: studioPanelStatusLabel(status as Parameters<typeof studioPanelStatusLabel>[0]),
      expectedTimeline: timeline,
      expectedLabel: label,
    }))).toEqual(expect.arrayContaining([
      { timeline: "complete", label: "可生成", expectedTimeline: "complete", expectedLabel: "可生成" },
      { timeline: "current", label: "待消歧", expectedTimeline: "current", expectedLabel: "待消歧" },
      { timeline: "current", label: "缺少资产", expectedTimeline: "current", expectedLabel: "缺少资产" },
      { timeline: "current", label: "已绑定", expectedTimeline: "current", expectedLabel: "已绑定" },
      { timeline: "current", label: "需更新", expectedTimeline: "current", expectedLabel: "需更新" },
      { timeline: "pending", label: "待处理", expectedTimeline: "pending", expectedLabel: "待处理" },
      { timeline: "pending", label: "待分析", expectedTimeline: "pending", expectedLabel: "待分析" },
    ]));
  });
});
