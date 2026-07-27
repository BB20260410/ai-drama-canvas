import { describe, expect, it } from "vitest";
import {
  assertStudioCanvasUnitsPageBounded,
  buildStudioCanvasPipelineGraph,
  STUDIO_CANVAS_PIPELINE_MAX_PANELS,
  StudioCanvasPipelineGraphError,
} from "../src/core/studio-canvas-pipeline-graph.js";

describe("studio-canvas-pipeline-graph", () => {
  it("为 2–6 宫格构建有界流水线且无 path/sha 泄漏", () => {
    const graph = buildStudioCanvasPipelineGraph({
      unitId: "unit-1",
      label: "单元 1",
      panels: [
        { panelId: "p1", ordinal: 1, label: "格1", hasRaw: true, hasLabeled: false, reviewDecision: "none" },
        { panelId: "p2", ordinal: 2, label: "格2", hasRaw: true, hasLabeled: true, reviewDecision: "pass" },
      ],
    });
    expect(graph.bounded).toBe(true);
    expect(graph.panelCount).toBe(2);
    expect(graph.nodes.some((n) => n.kind === "panel")).toBe(true);
    expect(graph.nodes.some((n) => n.kind === "raw")).toBe(true);
    expect(graph.edges.length).toBeGreaterThan(4);
    const json = JSON.stringify(graph);
    expect(json).not.toMatch(/localPath|sqlite|base64/i);
    // data 仅 flags，无 sha 字段
    for (const node of graph.nodes) {
      expect(JSON.stringify(node.data)).not.toMatch(/sha256|mediaSha/i);
    }
  });

  it("超过 6 宫格或超页单元拒绝", () => {
    const panels = Array.from({ length: STUDIO_CANVAS_PIPELINE_MAX_PANELS + 1 }, (_, i) => ({
      panelId: `p${i + 1}`,
      ordinal: i + 1,
      label: `格${i + 1}`,
    }));
    expect(() => buildStudioCanvasPipelineGraph({
      unitId: "u",
      label: "x",
      panels,
    })).toThrow(StudioCanvasPipelineGraphError);

    expect(() => assertStudioCanvasUnitsPageBounded(37)).toThrow(/分页/);
    expect(() => assertStudioCanvasUnitsPageBounded(36)).not.toThrow();
  });
});
