import { describe, expect, it } from "vitest";
import {
  extractStudioCanvasWorkflowPanelConnections,
  normalizeStudioCanvasWorkflowDraft,
  STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_ASSETS_PER_PANEL,
  STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_EDGES,
  STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_NODES,
  StudioCanvasWorkflowDraftError,
  validateStudioCanvasWorkflowDraft,
  type StudioCanvasWorkflowDraftInput,
} from "../src/core/studio-canvas-workflow-draft.js";

function baseDraft(): StudioCanvasWorkflowDraftInput {
  return {
    nodes: [
      { id: " panel-node ", kind: "panel", panelId: " panel-01 " },
      { id: "prompt-node", kind: "prompt", documentId: "prompt-doc-01" },
      { id: "asset-b", kind: "asset", assetId: "asset-b" },
      { id: "script-node", kind: "script", documentId: "script-doc-01" },
      { id: "asset-a", kind: "asset", assetId: "asset-a" },
    ],
    edges: [
      { sourceId: "panel-node", targetId: "asset-b" },
      { id: " prompt-edge ", sourceId: "prompt-node", targetId: "panel-node" },
      { sourceId: "asset-a", targetId: "panel-node" },
      { id: "script-edge", sourceId: "script-node", targetId: "panel-node" },
    ],
  };
}

describe("studio-canvas-workflow-draft", () => {
  it("规范化反向拖线、生成稳定边 ID，并按宫格提取资产/剧本/提示词", () => {
    const draft = normalizeStudioCanvasWorkflowDraft(baseDraft());

    expect(draft).toMatchObject({
      schemaVersion: 1,
      kind: "studio-canvas-workflow-draft",
      bounded: true,
      limits: {
        maxNodes: STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_NODES,
        maxEdges: STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_EDGES,
        maxAssetsPerPanel: 6,
        maxScriptsPerPanel: 1,
        maxPromptsPerPanel: 1,
      },
    });
    expect(draft.nodes.map((node) => `${node.kind}:${node.id}`)).toEqual([
      "asset:asset-a",
      "asset:asset-b",
      "script:script-node",
      "prompt:prompt-node",
      "panel:panel-node",
    ]);
    expect(draft.edges).toEqual([
      { id: "draft-edge:asset-a:panel-node", sourceId: "asset-a", targetId: "panel-node" },
      { id: "draft-edge:asset-b:panel-node", sourceId: "asset-b", targetId: "panel-node" },
      { id: "prompt-edge", sourceId: "prompt-node", targetId: "panel-node" },
      { id: "script-edge", sourceId: "script-node", targetId: "panel-node" },
    ]);
    expect(draft.panels).toEqual([{
      panelNodeId: "panel-node",
      panelId: "panel-01",
      assetIds: ["asset-a", "asset-b"],
      scriptDocumentId: "script-doc-01",
      promptDocumentId: "prompt-doc-01",
    }]);
    expect(extractStudioCanvasWorkflowPanelConnections(baseDraft())).toEqual(draft.panels);
    expect(validateStudioCanvasWorkflowDraft(baseDraft())).toEqual({ ok: true, draft });
  });

  it("输出不受输入排列影响，并保留没有连接的宫格", () => {
    const first = normalizeStudioCanvasWorkflowDraft(baseDraft());
    const reversed = normalizeStudioCanvasWorkflowDraft({
      nodes: [...baseDraft().nodes].reverse(),
      edges: [...baseDraft().edges].reverse(),
    });
    expect(reversed).toEqual(first);

    const empty = normalizeStudioCanvasWorkflowDraft({
      nodes: [{ id: "panel-02", kind: "panel", panelId: "panel-02" }],
      edges: [],
    });
    expect(empty.panels).toEqual([{
      panelNodeId: "panel-02",
      panelId: "panel-02",
      assetIds: [],
      scriptDocumentId: null,
      promptDocumentId: null,
    }]);
  });

  it.each([
    {
      name: "空节点 ID",
      input: { nodes: [{ id: " ", kind: "panel", panelId: "p" }], edges: [] },
      code: "invalid-id",
      text: "节点 ID不能为空",
    },
    {
      name: "节点 ID 重复",
      input: {
        nodes: [
          { id: "same", kind: "panel", panelId: "p" },
          { id: "same", kind: "asset", assetId: "a" },
        ],
        edges: [],
      },
      code: "duplicate-node",
      text: "节点 ID 重复",
    },
    {
      name: "同类引用重复",
      input: {
        nodes: [
          { id: "a1", kind: "asset", assetId: "asset" },
          { id: "a2", kind: "asset", assetId: "asset" },
        ],
        edges: [],
      },
      code: "duplicate-reference",
      text: "节点引用重复",
    },
    {
      name: "边端点不存在",
      input: {
        nodes: [{ id: "p", kind: "panel", panelId: "p" }],
        edges: [{ sourceId: "missing", targetId: "p" }],
      },
      code: "missing-endpoint",
      text: "边端点不存在",
    },
    {
      name: "自环",
      input: {
        nodes: [{ id: "p", kind: "panel", panelId: "p" }],
        edges: [{ sourceId: "p", targetId: "p" }],
      },
      code: "self-loop",
      text: "禁止自环",
    },
    {
      name: "节点类型不允许",
      input: {
        nodes: [
          { id: "a", kind: "asset", assetId: "a" },
          { id: "s", kind: "script", documentId: "s" },
        ],
        edges: [{ sourceId: "a", targetId: "s" }],
      },
      code: "invalid-edge-kind",
      text: "只允许资产、剧本或提示词连接到宫格",
    },
  ])("拒绝$name并返回简单中文错误", ({ input, code, text }) => {
    const result = validateStudioCanvasWorkflowDraft(input as StudioCanvasWorkflowDraftInput);
    expect(result).toEqual({
      ok: false,
      error: { code, message: expect.stringContaining(text) },
    });
  });

  it("拒绝重复边 ID、规范化后的重复端点及空边 ID", () => {
    const nodes: StudioCanvasWorkflowDraftInput["nodes"] = [
      { id: "a", kind: "asset", assetId: "a" },
      { id: "b", kind: "asset", assetId: "b" },
      { id: "p", kind: "panel", panelId: "p" },
    ];
    expect(() => normalizeStudioCanvasWorkflowDraft({
      nodes,
      edges: [
        { id: "same", sourceId: "a", targetId: "p" },
        { id: "same", sourceId: "b", targetId: "p" },
      ],
    })).toThrowError(expect.objectContaining({ code: "duplicate-edge" }));
    expect(() => normalizeStudioCanvasWorkflowDraft({
      nodes,
      edges: [
        { sourceId: "a", targetId: "p" },
        { sourceId: "p", targetId: "a" },
      ],
    })).toThrowError(expect.objectContaining({ code: "duplicate-edge" }));
    expect(() => normalizeStudioCanvasWorkflowDraft({
      nodes,
      edges: [{ id: " ", sourceId: "a", targetId: "p" }],
    })).toThrowError(expect.objectContaining({ code: "invalid-id" }));
  });

  it("每宫格最多六项资产、一个剧本和一个提示词", () => {
    const sevenAssets: StudioCanvasWorkflowDraftInput = {
      nodes: [
        { id: "p", kind: "panel", panelId: "p" },
        ...Array.from({ length: STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_ASSETS_PER_PANEL + 1 }, (_, index) => ({
          id: `a-${index}`,
          kind: "asset" as const,
          assetId: `asset-${index}`,
        })),
      ],
      edges: Array.from({ length: STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_ASSETS_PER_PANEL + 1 }, (_, index) => ({
        sourceId: `a-${index}`,
        targetId: "p",
      })),
    };
    expect(() => normalizeStudioCanvasWorkflowDraft(sevenAssets)).toThrowError(
      expect.objectContaining({ code: "panel-limit-exceeded", message: expect.stringContaining("资产超过上限 6") }),
    );

    for (const kind of ["script", "prompt"] as const) {
      const documentLabel = kind === "script" ? "剧本文档" : "提示词文档";
      expect(() => normalizeStudioCanvasWorkflowDraft({
        nodes: [
          { id: "p", kind: "panel", panelId: "p" },
          { id: `${kind}-1`, kind, documentId: `${kind}-doc-1` },
          { id: `${kind}-2`, kind, documentId: `${kind}-doc-2` },
        ],
        edges: [
          { sourceId: `${kind}-1`, targetId: "p" },
          { sourceId: `${kind}-2`, targetId: "p" },
        ],
      })).toThrowError(expect.objectContaining({
        code: "panel-limit-exceeded",
        message: expect.stringContaining(`最多连接一个${documentLabel}`),
      }));
    }
  });

  it("节点和边超过有界上限时拒绝一次处理", () => {
    const nodes = Array.from({ length: STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_NODES + 1 }, (_, index) => ({
      id: `p-${index}`,
      kind: "panel" as const,
      panelId: `panel-${index}`,
    }));
    expect(() => normalizeStudioCanvasWorkflowDraft({ nodes, edges: [] })).toThrowError(
      expect.objectContaining({ code: "limit-exceeded", message: expect.stringContaining("节点超过上限") }),
    );

    expect(() => normalizeStudioCanvasWorkflowDraft({
      nodes: [],
      edges: Array.from({ length: STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_EDGES + 1 }, () => ({
        sourceId: "a",
        targetId: "p",
      })),
    })).toThrowError(expect.objectContaining({
      code: "limit-exceeded",
      message: expect.stringContaining("边超过上限"),
    }));
  });

  it("错误类型可由调用方稳定识别且模块不依赖 Node API", async () => {
    try {
      normalizeStudioCanvasWorkflowDraft({
        nodes: [{ id: "p", kind: "panel", panelId: "p" }],
        edges: [{ sourceId: "p", targetId: "p" }],
      });
      throw new Error("预期失败");
    } catch (error) {
      expect(error).toBeInstanceOf(StudioCanvasWorkflowDraftError);
      expect(error).toMatchObject({ code: "self-loop", message: "禁止自环：p。" });
    }

    const source = await import("../src/core/studio-canvas-workflow-draft.js");
    expect(Object.keys(source)).toContain("normalizeStudioCanvasWorkflowDraft");
  });
});
