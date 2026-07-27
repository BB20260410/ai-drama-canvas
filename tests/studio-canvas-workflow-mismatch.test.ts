import { describe, expect, it } from "vitest";
import { describeStudioCanvasWorkflowMismatch } from "../src/core/studio-canvas-workflow-mismatch.js";

describe("studio-canvas-workflow-mismatch", () => {
  it("按人物、场景、道具列出缺少/多出资产与文稿", () => {
    const result = describeStudioCanvasWorkflowMismatch({
      panels: [{ panelId: "p1", label: "宫格 1", expectedAssetIds: ["character-a", "scene-a", "prop-a"] }],
      connections: [{
        panelId: "p1",
        assetIds: ["character-a", "prop-extra"],
        scriptDocumentId: null,
        promptDocumentId: null,
      }],
      assets: [
        { id: "character-a", category: "character", name: "阿航" },
        { id: "scene-a", category: "scene", name: "古蜀山道" },
        { id: "prop-a", category: "prop", name: "黄金面具" },
        { id: "prop-extra", category: "prop", name: "错误道具" },
      ],
    });
    expect(result).toMatchObject({
      panelId: "p1",
      missingAssetIds: ["prop-a", "scene-a"],
      extraAssetIds: ["prop-extra"],
      missingScript: true,
      missingPrompt: true,
    });
    expect(result?.message).toContain("场景“古蜀山道”");
    expect(result?.message).toContain("道具“黄金面具”");
    expect(result?.message).toContain("多出 道具“错误道具”");
    expect(result?.message).toContain("缺少当前剧本连线");
    expect(result?.message).toContain("缺少当前提示词连线");
  });

  it("差集完整时返回 null，不代替正式 owner 准入", () => {
    expect(describeStudioCanvasWorkflowMismatch({
      panels: [{ panelId: "p1", label: "宫格 1", expectedAssetIds: ["a", "b"] }],
      connections: [{ panelId: "p1", assetIds: ["b", "a"], scriptDocumentId: "script", promptDocumentId: "prompt" }],
    })).toBeNull();
  });
});
