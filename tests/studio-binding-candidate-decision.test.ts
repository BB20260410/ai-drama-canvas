import { describe, expect, it } from "vitest";
import {
  planStudioBindingCandidateConfirm,
  planStudioBindingCandidateIgnore,
  STUDIO_BINDING_CANDIDATE_DECISION_MAP,
} from "../src/core/studio-binding-candidate-decision.js";

describe("studio-binding-candidate-decision（Jellyfish #3）", () => {
  it("映射表含 pending/linked/ignored", () => {
    expect(STUDIO_BINDING_CANDIDATE_DECISION_MAP.uiToResolve.confirm).toBe("select");
    expect(STUDIO_BINDING_CANDIDATE_DECISION_MAP.uiToResolve.ignore).toBe("exclude");
    expect(STUDIO_BINDING_CANDIDATE_DECISION_MAP.fromJellyfish.linked).toContain("确认");
  });

  it("confirm 无资产失败；有资产 select；matched 可 accept", () => {
    expect(planStudioBindingCandidateConfirm({ proposalId: "pr1" }).ok).toBe(false);
    const sel = planStudioBindingCandidateConfirm({ proposalId: "pr1", selectedAssetId: "a1" });
    expect(sel.ok).toBe(true);
    expect(sel.decision).toBe("select");
    const acc = planStudioBindingCandidateConfirm({
      proposalId: "pr1",
      matchedAssetId: "a9",
      preferAcceptWhenMatched: true,
    });
    expect(acc.decision).toBe("accept");
  });

  it("ignore → exclude", () => {
    const plan = planStudioBindingCandidateIgnore("pr2");
    expect(plan.ok).toBe(true);
    expect(plan.decision).toBe("exclude");
    expect(plan.action).toBe("ignore");
  });
});
