import { describe, expect, it } from "vitest";
import {
  isStudioCanvasEdgeKindAllowed,
  listStudioCanvasAllowedEdgeKinds,
  listTwitCanvaGroundedSemanticEdges,
  TWITCANVA_NODE_TYPE_TO_STUDIO_KIND,
  validateStudioCanvasEdges,
} from "../src/core/studio-canvas-edge-validation.js";

describe("studio-canvas-edge-validation（TwitCanva 源码级重做）", () => {
  it("接受合法 pipeline 边，拒绝自环；asset→media 现合法（ref→video 语义）", () => {
    const result = validateStudioCanvasEdges([
      { sourceId: "u1", targetId: "p1", sourceKind: "unit", targetKind: "panel" },
      { sourceId: "p1", targetId: "r1", sourceKind: "panel", targetKind: "raw" },
      { sourceId: "p1", targetId: "p1", sourceKind: "panel", targetKind: "panel" },
      { sourceId: "a1", targetId: "m1", sourceKind: "asset", targetKind: "media" },
    ]);
    expect(result.rejected.some((e) => e.issue.code === "self-loop")).toBe(true);
    // asset→media 非 ALLOWED；asset→raw 才是参考图输入
    expect(result.rejected.some((e) => e.sourceId === "a1" && e.issue.code === "kind-mismatch")).toBe(true);
    expect(result.accepted.length).toBeGreaterThanOrEqual(2);
  });

  it("TwitCanva 映射：Text→Image/Video、Image→Video、Video→Video", () => {
    expect(TWITCANVA_NODE_TYPE_TO_STUDIO_KIND.Text).toBe("script");
    expect(TWITCANVA_NODE_TYPE_TO_STUDIO_KIND.Image).toBe("raw");
    expect(TWITCANVA_NODE_TYPE_TO_STUDIO_KIND.Video).toBe("media");
    expect(isStudioCanvasEdgeKindAllowed("script", "raw")).toBe(true);
    expect(isStudioCanvasEdgeKindAllowed("script", "media")).toBe(true);
    expect(isStudioCanvasEdgeKindAllowed("raw", "media")).toBe(true);
    expect(isStudioCanvasEdgeKindAllowed("media", "media")).toBe(true);
    expect(isStudioCanvasEdgeKindAllowed("raw", "raw")).toBe(true);
    expect(listTwitCanvaGroundedSemanticEdges()).toContain("Image→Video");
    const allowed = listStudioCanvasAllowedEdgeKinds();
    expect(allowed).toContain("script→raw");
    expect(allowed).toContain("raw→media");
    expect(allowed).toContain("unit→unit");
    expect(isStudioCanvasEdgeKindAllowed("unit", "unit")).toBe(true);
  });

  it("P15 草稿输入允许提示词进入宫格，但未知组合继续失败关闭", () => {
    expect(isStudioCanvasEdgeKindAllowed("prompt", "panel")).toBe(true);
    expect(isStudioCanvasEdgeKindAllowed("prompt", "raw")).toBe(true);
    expect(isStudioCanvasEdgeKindAllowed("prompt", "unit")).toBe(false);
  });
});

