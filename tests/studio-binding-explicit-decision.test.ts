import { describe, expect, it } from "vitest";
import {
  lookupExplicitAssetId,
  planExplicitBindingDecision,
  S1_EXPLICIT_ENTITY_ASSET_MAP,
} from "../src/core/studio-binding-explicit-decision.js";

describe("studio-binding-explicit-decision", () => {
  it("maps hard-lock aliases to imported asset ids", () => {
    expect(lookupExplicitAssetId("王卿")).toBe("character-wangqing");
    expect(lookupExplicitAssetId("女性巫祝")).toBe("character-wuzhu-female");
    expect(lookupExplicitAssetId("嘟嘟")).toBe("character-r07-dudu");
    expect(lookupExplicitAssetId("A01")).toBe("character-a01-energy");
    expect(lookupExplicitAssetId("完整黄金面具")).toBe("prop-d01-golden-mask");
    expect(lookupExplicitAssetId("豆姐")).toBe("prop-d01-golden-mask");
    expect(S1_EXPLICIT_ENTITY_ASSET_MAP["王卿"]).toBe("character-wangqing");
  });

  it("accepts unique matched without using candidates[0]", () => {
    const plan = planExplicitBindingDecision({
      entityText: "王卿",
      status: "matched",
      matchedAssetId: "character-wangqing",
      candidates: [
        { assetId: "character-wangqing" },
        { assetId: "character-shuwang" },
      ],
    });
    expect(plan).toMatchObject({
      kind: "accept",
      selectedAssetId: "character-wangqing",
    });
  });

  it("selects mapped asset among ambiguous candidates, never first", () => {
    const plan = planExplicitBindingDecision({
      entityText: "巫祝",
      status: "ambiguous",
      candidates: [
        { assetId: "character-zhangli" },
        { assetId: "character-wuzhu-female" },
      ],
    });
    expect(plan.kind).toBe("select");
    if (plan.kind === "select") {
      expect(plan.selectedAssetId).toBe("character-wuzhu-female");
      expect(plan.selectedAssetId).not.toBe("character-zhangli");
    }
  });

  it("blocks ambiguous without map hit instead of silent first candidate", () => {
    const plan = planExplicitBindingDecision({
      entityText: "神秘人甲",
      status: "ambiguous",
      candidates: [
        { assetId: "character-bandits" },
        { assetId: "character-liukou" },
      ],
    });
    expect(plan.kind).toBe("blocked");
  });

  it("excludes unmatched with zero candidates", () => {
    const plan = planExplicitBindingDecision({
      entityText: "旁白语气",
      status: "unmatched",
      candidates: [],
    });
    expect(plan).toMatchObject({ kind: "exclude" });
  });
});
