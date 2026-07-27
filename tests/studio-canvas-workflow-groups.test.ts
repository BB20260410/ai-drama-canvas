import { describe, expect, it } from "vitest";
import {
  applyStudioCanvasWorkflowGroupsToLayout,
  createStudioCanvasWorkflowGroup,
  createWorkflowGroupFromCanvasSelection,
  deleteStudioCanvasWorkflowGroup,
  extractStudioCanvasPanelIdsFromSelection,
  getPanelWorkflowGroupMap,
  normalizeStudioCanvasPipeline,
  STUDIO_CANVAS_DEFAULT_PIPELINE,
  StudioCanvasWorkflowGroupsError,
} from "../src/core/studio-canvas-workflow-groups.js";
import { normalizeStudioCanvasLayout } from "../src/core/studio-canvas-layout.js";

describe("studio-canvas-workflow-groups（LocalMiniDrama LMD-1 clean-room）", () => {
  it("normalizeStudioCanvasPipeline 过滤非法步骤并默认 image", () => {
    expect(normalizeStudioCanvasPipeline(undefined)).toEqual([...STUDIO_CANVAS_DEFAULT_PIPELINE]);
    expect(normalizeStudioCanvasPipeline([])).toEqual(["image"]);
    expect(normalizeStudioCanvasPipeline(["image", "bogus", "video", "image", "review"])).toEqual([
      "image",
      "video",
      "review",
    ]);
  });

  it("extractStudioCanvasPanelIdsFromSelection 支持节点 id / kind / 裸 id", () => {
    const ids = extractStudioCanvasPanelIdsFromSelection([
      "panel:p1",
      { kind: "panel", id: "p2" },
      { id: "panel:p3" },
      { data: { kind: "panel", id: "p4" } },
      { panelId: "p5" },
      { kind: "unit", id: "u1" }, // 忽略
      "panel:p1", // 去重
      "p6",
    ]);
    expect(ids).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
  });

  it("create/delete 组 + panel map + 写回 layout 指纹稳定", () => {
    const groups = createStudioCanvasWorkflowGroup([], {
      title: "第一场",
      panelIds: ["panel:a", "b", "b", "c"],
      pipeline: ["image", "video"],
      now: "2026-07-18T12:00:00.000Z",
      id: "wg-test-1",
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: "wg-test-1",
      title: "第一场",
      panelIds: ["a", "b", "c"],
      pipeline: ["image", "video"],
      createdAt: "2026-07-18T12:00:00.000Z",
    });

    const map = getPanelWorkflowGroupMap(groups);
    expect(map.get("b")?.id).toBe("wg-test-1");
    expect(map.get("missing")).toBeUndefined();

    const layout = applyStudioCanvasWorkflowGroupsToLayout(null, groups, {
      updatedAt: "2026-07-18T12:00:00.000Z",
    });
    expect(layout.kind).toBe("studio-canvas-layout");
    expect(layout.workflowGroups).toHaveLength(1);
    expect(layout.fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const again = normalizeStudioCanvasLayout({
      viewport: layout.viewport,
      nodes: layout.nodes,
      workflowGroups: layout.workflowGroups,
      updatedAt: layout.updatedAt,
    });
    expect(again.fingerprint).toBe(layout.fingerprint);

    const deleted = deleteStudioCanvasWorkflowGroup(groups, "wg-test-1");
    expect(deleted).toEqual([]);
  });

  it("写回工作流组时保留自由画布视图状态，不把草稿边升级为业务真源", () => {
    const base = normalizeStudioCanvasLayout({
      workspaceMode: "workflow",
      pinnedNodeIds: ["asset:a1", "unit:u1"],
      draftCanvasEdges: [{ sourceId: "asset:a1", targetId: "panel:p1", sourceKind: "asset", targetKind: "panel" }],
    });
    const groups = createStudioCanvasWorkflowGroup([], {
      id: "wg-keep-view",
      title: "保持视图",
      panelIds: ["p1"],
      now: "2026-07-19T08:00:00.000Z",
    });
    const next = applyStudioCanvasWorkflowGroupsToLayout(base, groups, {
      updatedAt: "2026-07-19T08:00:00.000Z",
    });
    expect(next.workspaceMode).toBe("workflow");
    expect(next.pinnedNodeIds).toEqual(base.pinnedNodeIds);
    expect(next.draftCanvasEdges).toEqual(base.draftCanvasEdges);
    expect(next.workflowGroups[0]?.id).toBe("wg-keep-view");
  });

  it("createWorkflowGroupFromCanvasSelection 端到端：选中 → layout 含组", () => {
    const { layout, group } = createWorkflowGroupFromCanvasSelection(
      null,
      [
        { kind: "panel", id: "panel-x" },
        "panel:panel-y",
      ],
      {
        title: "框选组",
        pipeline: ["image"],
        now: "2026-07-18T13:00:00.000Z",
        id: "wg-sel-1",
      },
    );
    expect(group.panelIds).toEqual(["panel-x", "panel-y"]);
    expect(layout.workflowGroups[0]!.id).toBe("wg-sel-1");
    expect(getPanelWorkflowGroupMap(layout.workflowGroups).get("panel-y")?.title).toBe("框选组");
  });

  it("空选择 / 非法 id 失败关闭", () => {
    expect(() => createStudioCanvasWorkflowGroup([], { panelIds: [] })).toThrow(StudioCanvasWorkflowGroupsError);
    expect(() =>
      createStudioCanvasWorkflowGroup([], { panelIds: ["bad id with space"] }),
    ).toThrow(StudioCanvasWorkflowGroupsError);
    expect(() => createWorkflowGroupFromCanvasSelection(null, [{ kind: "unit", id: "u1" }])).toThrow(
      StudioCanvasWorkflowGroupsError,
    );
  });
});
