import { describe, expect, it } from "vitest";
import type { StudioGenerationResultRecord } from "../src/core/studio-generation-ledger.js";
import type { StudioGenerationReviewControl } from "../src/core/studio-generation-review.js";
import { isCurrentApprovedUnitGridResultIdentity } from "../src/renderer/src/unit-grid-selected-result-identity.js";

function result(variant: "raw" | "labeled"): StudioGenerationResultRecord {
  const mediaSha256 = variant === "raw" ? "a".repeat(64) : "b".repeat(64);
  return {
    sequence: variant === "raw" ? 1 : 2,
    resultId: `${variant}-result`,
    generationRunId: "run-1",
    variant,
    status: "pending",
    mediaSha256,
    dispatchId: "dispatch-1",
    provider: "codex",
    dispatchProvenance: "local-dispatch-intent",
    dispatchedAt: "2026-07-26T00:00:00.000Z",
    packId: "pack-1",
    packFingerprint: "c".repeat(64),
    unitId: "S1E2-U01",
    unitRevision: 1,
    pairComplete: true,
    inputCurrent: true,
    promotionEligible: true,
    staleReasons: [],
    createdAt: "2026-07-26T00:00:01.000Z",
    targetKind: "unit-grid",
    targetKey: "unit-grid:S1E2-U01",
  };
}

function review(): StudioGenerationReviewControl {
  return {
    schemaVersion: 1,
    kind: "studio-generation-review-control",
    generationRunId: "run-1",
    headRevision: 1,
    status: "pass",
    blockers: [],
    nextAction: "approved-raw-ready",
    fingerprint: "d".repeat(64),
    head: {
      sequence: 3,
      reviewId: "review-1",
      generationRunId: "run-1",
      kind: "observation",
      baseHeadRevision: 0,
      headRevision: 1,
      rawResultId: "raw-result",
      rawSha256: "a".repeat(64),
      labeledResultId: "labeled-result",
      labeledSha256: "b".repeat(64),
      packId: "pack-1",
      packFingerprint: "c".repeat(64),
      continuityFingerprint: "e".repeat(64),
      decision: "pass",
      criteria: [],
      annotations: [],
      reviewer: "human",
      note: "",
      currentAtSubmission: true,
      advancesHead: true,
      staleReasons: [],
      fingerprint: "f".repeat(64),
      createdAt: "2026-07-26T00:00:02.000Z",
      head: true,
      current: true,
      approvedRawEligible: true,
      currentStaleReasons: [],
    },
  };
}

function matches(control = review()): boolean {
  return isCurrentApprovedUnitGridResultIdentity({
    review: control,
    generationRunId: "run-1",
    raw: result("raw"),
    labeled: result("labeled"),
    selectedRawSha256: "a".repeat(64),
    selectedLabeledSha256: "b".repeat(64),
    selectedPackFingerprint: "c".repeat(64),
  });
}

describe("unit-grid selected result identity", () => {
  it("只接受当前、可晋升且与结果对和冻结包完全一致的 PASS head", () => {
    expect(matches()).toBe(true);
  });

  it("PASS 被撤销为 rework 后立即失效", () => {
    const control = review();
    control.status = "rework";
    control.nextAction = "submit-correction";
    expect(matches(control)).toBe(false);
  });

  it("旧 head 或任一结果身份错配均失效", () => {
    const stale = review();
    stale.head!.current = false;
    expect(matches(stale)).toBe(false);

    const wrongRaw = review();
    wrongRaw.head!.rawSha256 = "9".repeat(64);
    expect(matches(wrongRaw)).toBe(false);

    const wrongPack = review();
    wrongPack.head!.packFingerprint = "8".repeat(64);
    expect(matches(wrongPack)).toBe(false);
  });
});
