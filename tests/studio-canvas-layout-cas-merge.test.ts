import { describe, expect, it, vi } from "vitest";
import type { StudioCanvasLayout } from "../src/core/studio-canvas-layout-types.js";
import {
  mergeStudioCanvasLayoutThreeWay,
  saveStudioCanvasLayoutWithCasMerge,
  snapshotStudioCanvasLayout,
  StudioCanvasLayoutMergeConflictError,
} from "../src/renderer/src/studio-canvas-layout-cas-merge.js";

function layout(input: Partial<StudioCanvasLayout> = {}): StudioCanvasLayout {
  return {
    schemaVersion: 1,
    kind: "studio-canvas-layout",
    fingerprint: input.fingerprint ?? "1".repeat(64),
    viewport: input.viewport ?? { x: 0, y: 0, zoom: 1 },
    nodes: input.nodes ?? { "panel:a": { x: 0, y: 0 } },
    workspaceMode: input.workspaceMode ?? "workflow",
    pinnedNodeIds: input.pinnedNodeIds ?? ["panel:a"],
    draftCanvasEdges: input.draftCanvasEdges ?? [],
    workflowGroups: input.workflowGroups ?? [],
    updatedAt: input.updatedAt ?? "2026-07-26T00:00:00.000Z",
  };
}

describe("画布布局 CAS 三方合并", () => {
  it("保留本地节点移动与远端新增的分组、连线和固定节点", () => {
    const base = snapshotStudioCanvasLayout(layout());
    const local = structuredClone(base);
    local.nodes["panel:a"] = { x: 100, y: 200 };
    const remote = structuredClone(base);
    remote.pinnedNodeIds.push("asset:scene");
    remote.draftCanvasEdges.push({
      sourceId: "asset:scene",
      targetId: "panel:a",
      sourceKind: "scene",
      targetKind: "panel",
    });
    remote.workflowGroups.push({
      id: "workflow-remote",
      title: "远端工作流",
      panelIds: ["panel-a"],
      pipeline: ["image"],
      createdAt: "2026-07-26T00:01:00.000Z",
    });

    expect(mergeStudioCanvasLayoutThreeWay(base, local, remote)).toMatchObject({
      nodes: { "panel:a": { x: 100, y: 200 } },
      pinnedNodeIds: ["panel:a", "asset:scene"],
      draftCanvasEdges: [{ sourceId: "asset:scene", targetId: "panel:a" }],
      workflowGroups: [{ id: "workflow-remote" }],
    });
  });

  it("同一节点被两个写者改成不同位置时失败关闭", () => {
    const base = snapshotStudioCanvasLayout(layout());
    const local = structuredClone(base);
    const remote = structuredClone(base);
    local.nodes["panel:a"] = { x: 10, y: 20 };
    remote.nodes["panel:a"] = { x: 30, y: 40 };

    expect(() => mergeStudioCanvasLayoutThreeWay(base, local, remote))
      .toThrow(StudioCanvasLayoutMergeConflictError);
  });

  it("跨窗口同时修改 viewport 仍失败关闭，不以当前窗口静默覆盖远端", () => {
    const base = snapshotStudioCanvasLayout(layout());
    const local = structuredClone(base);
    const remote = structuredClone(base);
    local.viewport = { x: 10, y: 20, zoom: 1.1 };
    remote.viewport = { x: 30, y: 40, zoom: 0.9 };

    expect(() => mergeStudioCanvasLayoutThreeWay(base, local, remote))
      .toThrow(StudioCanvasLayoutMergeConflictError);
  });

  it("首次 CAS 冲突后重读并合并；二次冲突报告真实重试错误", async () => {
    const baseLayout = layout();
    const remoteLayout = layout({
      fingerprint: "2".repeat(64),
      workflowGroups: [{
        id: "workflow-remote",
        title: "远端工作流",
        panelIds: ["panel-a"],
        pipeline: ["image"],
        createdAt: "2026-07-26T00:01:00.000Z",
      }],
    });
    const local = snapshotStudioCanvasLayout(baseLayout);
    local.nodes["panel:a"] = { x: 20, y: 30 };
    const savedLayout = layout({
      fingerprint: "3".repeat(64),
      nodes: local.nodes,
      workflowGroups: remoteLayout.workflowGroups,
    });
    const api = {
      loadLayout: vi.fn().mockResolvedValue(remoteLayout),
      saveLayout: vi.fn()
        .mockRejectedValueOnce(new Error("画布布局 fingerprint 不匹配"))
        .mockResolvedValueOnce({ layout: savedLayout, created: false }),
    };
    const result = await saveStudioCanvasLayoutWithCasMerge({
      api,
      projectRoot: "/project",
      base: baseLayout,
      local,
      expectedFingerprint: baseLayout.fingerprint,
      now: () => "2026-07-26T00:02:00.000Z",
    });
    expect(result.merged).toBe(true);
    expect(api.saveLayout.mock.calls[1]?.[1]).toMatchObject({
      expectedFingerprint: remoteLayout.fingerprint,
      patch: {
        nodes: { "panel:a": { x: 20, y: 30 } },
        workflowGroups: [{ id: "workflow-remote" }],
      },
    });

    const retryFailureApi = {
      loadLayout: vi.fn().mockResolvedValue(remoteLayout),
      saveLayout: vi.fn()
        .mockRejectedValueOnce(new Error("fingerprint 不匹配"))
        .mockRejectedValueOnce(new Error("第二次真实冲突")),
    };
    await expect(saveStudioCanvasLayoutWithCasMerge({
      api: retryFailureApi,
      projectRoot: "/project",
      base: baseLayout,
      local,
      expectedFingerprint: baseLayout.fingerprint,
    })).rejects.toThrow("第二次真实冲突");
  });
});
