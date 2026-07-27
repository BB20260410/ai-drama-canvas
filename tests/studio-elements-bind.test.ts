import { describe, expect, it } from "vitest";
import {
  classifyStudioElementKind,
  planExplicitElementBind,
} from "../src/core/studio-elements-bind.js";

describe("classifyStudioElementKind", () => {
  it("识别角色/场景/道具", () => {
    expect(classifyStudioElementKind("character-r07-dudu")).toBe("character");
    expect(classifyStudioElementKind("scene-night-market")).toBe("scene");
    expect(classifyStudioElementKind("prop-d01-golden-mask")).toBe("prop");
    expect(classifyStudioElementKind("unknown")).toBe(null);
  });
});

describe("planExplicitElementBind", () => {
  const allowed = ["character-r07-dudu", "prop-d01-golden-mask", "scene-s1"];

  it("显式拖入允许集内角色 → bind", () => {
    const r = planExplicitElementBind({
      panelId: "S1E01-U01-G1",
      assetId: "character-r07-dudu",
      expectedKind: "character",
      allowedAssetIds: allowed,
    });
    expect(r.kind).toBe("bind");
    if (r.kind !== "bind") return;
    expect(r.assetId).toBe("character-r07-dudu");
    expect(r.elementKind).toBe("character");
  });

  it("不在允许集 → fail-close", () => {
    const r = planExplicitElementBind({
      panelId: "p1",
      assetId: "character-outsider",
      allowedAssetIds: allowed,
    });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.code).toBe("not-in-scope");
  });

  it("空 asset / 类型不匹配 → fail-close", () => {
    expect(
      planExplicitElementBind({
        panelId: "p1",
        assetId: "",
        allowedAssetIds: allowed,
      }).kind,
    ).toBe("blocked");
    const kind = planExplicitElementBind({
      panelId: "p1",
      assetId: "prop-d01-golden-mask",
      expectedKind: "character",
      allowedAssetIds: allowed,
    });
    expect(kind.kind).toBe("blocked");
    if (kind.kind !== "blocked") return;
    expect(kind.code).toBe("kind-mismatch");
  });

  it("歧义上下文下未知实体不静默选第一候选", () => {
    const r = planExplicitElementBind({
      panelId: "p1",
      assetId: "character-r07-dudu",
      allowedAssetIds: allowed,
      ambiguousContext: true,
      entityText: "某某路人甲",
    });
    // 决策表未命中 → blocked（非 bind 到 candidates[0]）
    expect(r.kind).toBe("blocked");
  });

  it("歧义上下文 + 决策表命中嘟嘟 且拖入一致 → bind", () => {
    const r = planExplicitElementBind({
      panelId: "p1",
      assetId: "character-r07-dudu",
      allowedAssetIds: allowed,
      ambiguousContext: true,
      entityText: "嘟嘟",
    });
    expect(r.kind).toBe("bind");
  });
});
