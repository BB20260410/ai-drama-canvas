import { describe, expect, it } from "vitest";
import {
  autoLayoutStudioPanels,
  collectStudioCanvasNodePositions,
  mergeStudioCanvasLayout,
  normalizeStudioCanvasLayout,
  resolveStudioCanvasNodePosition,
  studioCanvasNodeId,
  StudioCanvasLayoutError,
} from "../src/core/studio-canvas-layout.js";

describe("studio-canvas-layout", () => {
  it("规范化布局并生成稳定 fingerprint；合并补丁覆盖节点", () => {
    const first = normalizeStudioCanvasLayout({
      viewport: { x: 10, y: 20, zoom: 0.75 },
      nodes: { "panel:a": { x: 0, y: 0 } },
      workspaceMode: "workflow",
      pinnedNodeIds: ["panel:a"],
      draftCanvasEdges: [{
        sourceId: "panel:a",
        targetId: "media:raw:a",
        sourceKind: "panel",
        targetKind: "raw",
      }],
      workflowGroups: [{
        id: "wg-1",
        title: "第一批",
        panelIds: ["panel-a", "panel-b"],
        pipeline: ["image", "review"],
        createdAt: "2026-07-18T00:00:00.000Z",
      }],
      updatedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(first.schemaVersion).toBe(1);
    expect(first.kind).toBe("studio-canvas-layout");
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.workspaceMode).toBe("workflow");
    expect(first.pinnedNodeIds).toEqual(["panel:a"]);
    expect(first.draftCanvasEdges).toEqual([{
      sourceId: "panel:a",
      targetId: "media:raw:a",
      sourceKind: "panel",
      targetKind: "raw",
    }]);
    expect(first.workflowGroups[0]!.pipeline).toEqual(["image", "review"]);

    const again = normalizeStudioCanvasLayout({
      viewport: first.viewport,
      nodes: first.nodes,
      workspaceMode: first.workspaceMode,
      pinnedNodeIds: first.pinnedNodeIds,
      draftCanvasEdges: first.draftCanvasEdges,
      workflowGroups: first.workflowGroups,
      updatedAt: first.updatedAt,
    });
    expect(again.fingerprint).toBe(first.fingerprint);

    const retained = mergeStudioCanvasLayout(first, {
      nodes: { "panel:a": { x: 50, y: 60 } },
      updatedAt: "2026-07-18T00:30:00.000Z",
    });
    expect(retained.workspaceMode).toBe("workflow");
    expect(retained.pinnedNodeIds).toEqual(first.pinnedNodeIds);
    expect(retained.draftCanvasEdges).toEqual(first.draftCanvasEdges);

    const merged = mergeStudioCanvasLayout(retained, {
      nodes: { "panel:a": { x: 100, y: 200 }, "panel:c": { x: 1, y: 2 } },
      pinnedNodeIds: ["panel:a", "panel:c"],
      draftCanvasEdges: [{
        sourceId: "panel:c",
        targetId: "media:raw:c",
        sourceKind: "panel",
        targetKind: "raw",
      }],
      updatedAt: "2026-07-18T01:00:00.000Z",
    });
    expect(merged.nodes["panel:a"]).toEqual({ x: 100, y: 200 });
    expect(merged.nodes["panel:c"]).toEqual({ x: 1, y: 2 });
    expect(merged.workspaceMode).toBe("workflow");
    expect(merged.pinnedNodeIds).toEqual(["panel:a", "panel:c"]);
    expect(merged.draftCanvasEdges[0]?.targetId).toBe("media:raw:c");
    expect(merged.fingerprint).not.toBe(first.fingerprint);
  });

  it("旧布局草稿缺少自由工作区字段时使用兼容默认值；新增字段进入 fingerprint", () => {
    const legacy = normalizeStudioCanvasLayout({
      viewport: { x: 1, y: 2, zoom: 1 },
      nodes: { "panel:legacy": { x: 3, y: 4 } },
      updatedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(legacy.workspaceMode).toBe("projection");
    expect(legacy.pinnedNodeIds).toEqual([]);
    expect(legacy.draftCanvasEdges).toEqual([]);

    const workflow = normalizeStudioCanvasLayout({
      viewport: legacy.viewport,
      nodes: legacy.nodes,
      workspaceMode: "workflow",
      pinnedNodeIds: ["panel:legacy"],
      draftCanvasEdges: [],
      updatedAt: legacy.updatedAt,
    });
    expect(workflow.fingerprint).not.toBe(legacy.fingerprint);
  });

  it("竖排自动布局与非法输入失败关闭", () => {
    const nodes = autoLayoutStudioPanels(["p1", "p2", "p3"], { originX: 360, originY: 80, rowGap: 140 });
    expect(nodes[studioCanvasNodeId("panel", "p1")]).toEqual({ x: 360, y: 80 });
    expect(nodes[studioCanvasNodeId("panel", "p2")]).toEqual({ x: 360, y: 220 });
    expect(nodes[studioCanvasNodeId("panel", "p3")]).toEqual({ x: 360, y: 360 });

    expect(() => normalizeStudioCanvasLayout({ viewport: { zoom: 0 } })).toThrow(StudioCanvasLayoutError);
    expect(() => normalizeStudioCanvasLayout({
      pinnedNodeIds: Array.from({ length: 5_001 }, (_, index) => `panel:${index}`),
    })).toThrow(StudioCanvasLayoutError);
    expect(() => normalizeStudioCanvasLayout({
      draftCanvasEdges: Array.from({ length: 10_001 }, (_, index) => ({
        sourceId: `panel:${index}`,
        targetId: `media:raw:${index}`,
        sourceKind: "panel",
        targetKind: "raw",
      })),
    })).toThrow(StudioCanvasLayoutError);
    expect(() => normalizeStudioCanvasLayout({
      draftCanvasEdges: [{
        sourceId: "panel:a",
        targetId: "panel:a",
        sourceKind: "panel",
        targetKind: "panel",
      }],
    })).toThrow(StudioCanvasLayoutError);
    expect(() => normalizeStudioCanvasLayout({
      workflowGroups: [{
        id: "wg",
        title: "x",
        panelIds: [],
        pipeline: ["image"],
        createdAt: "t",
      }],
    })).toThrow(StudioCanvasLayoutError);
  });

  it("坐标优先级：会话 > 持久化 layout > fallback", () => {
    const id = studioCanvasNodeId("panel", "p1");
    expect(resolveStudioCanvasNodePosition(id, {
      layoutNodes: { [id]: { x: 10, y: 20 } },
      fallback: { x: 1, y: 2 },
    })).toEqual({ x: 10, y: 20 });
    expect(resolveStudioCanvasNodePosition(id, {
      sessionPositions: { [id]: { x: 99, y: 88 } },
      layoutNodes: { [id]: { x: 10, y: 20 } },
      fallback: { x: 1, y: 2 },
    })).toEqual({ x: 99, y: 88 });
    expect(resolveStudioCanvasNodePosition(id, {
      fallback: { x: 1, y: 2 },
    })).toEqual({ x: 1, y: 2 });
    expect(collectStudioCanvasNodePositions([
      { id, position: { x: 3, y: 4 } },
      { id: "bad id", position: { x: 0, y: 0 } },
    ])).toEqual({ [id]: { x: 3, y: 4 } });
  });
});
