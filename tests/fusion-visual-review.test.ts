import { describe, expect, it } from "vitest";
import {
  artifactReviewEvidence,
  fusionVisualReviewRuleRequirements,
  reviewCoversFusionStoryboardRequirement,
  visualConstraintAttestationsCoverRequirement,
} from "../src/core/review-evidence.js";
import { normalizeVisualConstraintAttestations } from "../src/core/reviews.js";
import type {
  Artifact,
  FusionStoryboardReviewPanelRequirement,
  FusionStoryboardReviewRequirement,
  FusionVisualReviewRuleAttestation,
  ReviewRecord,
  SubmitReviewInput,
} from "../src/core/types.js";

const hashes = {
  constraint: "a".repeat(64),
  model: "b".repeat(64),
  review: "c".repeat(64),
  raw1: "d".repeat(64),
  labeled1: "e".repeat(64),
  raw2: "f".repeat(64),
  labeled2: "1".repeat(64),
};

function panel(
  panelId: string,
  panelIndex: number,
  ruleIds: string[],
  rawHash: string,
  labeledHash: string,
): FusionStoryboardReviewPanelRequirement {
  return {
    panelId,
    panelIndex,
    panelCount: 2,
    frameRole: panelIndex === 1 ? "start" : "end",
    generationJobId: `job-${panelIndex}`,
    publicationReceiptId: `receipt-${panelIndex}`,
    panelVisualConstraintEvidenceVersion: 1,
    panelVisualConstraintId: `constraint-${panelId}`,
    panelVisualConstraintFingerprint: hashes.constraint,
    panelVisualModelFingerprint: hashes.model,
    panelVisualReviewRulesFingerprint: hashes.review,
    visualReviewRules: ruleIds.map((id) => ({
      id,
      code: "SCENE_LAYOUT",
      enforcement: "human-visual-final",
      instruction: `人工检查 ${id}`,
      evidenceAssetIds: ["S01"],
    })),
    visualWarnings: [{
      code: "SCENE_LAYOUT",
      severity: "warning",
      detection: "human-visual",
      message: "人工检查场景布局",
      evidenceAssetIds: ["S01"],
    }],
    raw: { artifactId: `raw-${panelIndex}`, path: `/tmp/raw-${panelIndex}.png`, sha256: rawHash },
    labeled: { artifactId: `labeled-${panelIndex}`, path: `/tmp/labeled-${panelIndex}.png`, sha256: labeledHash },
    issues: [],
  };
}

function requirement(): FusionStoryboardReviewRequirement {
  const panels = [
    panel("panel-01", 1, ["rule-1", "rule-2"], hashes.raw1, hashes.labeled1),
    panel("panel-02", 2, ["rule-3"], hashes.raw2, hashes.labeled2),
  ];
  return {
    schemaVersion: 1,
    kind: "fusion-storyboard-grid-images",
    id: "fusion-review-current",
    itemId: "unit-1",
    reviewType: "image",
    contractId: "grid-contract",
    sourceFingerprint: "source",
    productionFingerprint: "production",
    panelCount: 2,
    complete: true,
    artifactIds: panels.flatMap((entry) => [entry.raw!.artifactId, entry.labeled!.artifactId]),
    artifactHashes: Object.fromEntries(panels.flatMap((entry) => [entry.raw!, entry.labeled!]).map((entry) => [entry.artifactId, entry.sha256])),
    panels,
    issues: [],
  };
}

function attestations(current: FusionStoryboardReviewRequirement): FusionVisualReviewRuleAttestation[] {
  return fusionVisualReviewRuleRequirements(current).map((entry) => ({ ...entry, result: "pass" }));
}

function submission(
  current: FusionStoryboardReviewRequirement,
  entries: FusionVisualReviewRuleAttestation[] | undefined,
): SubmitReviewInput {
  return {
    itemId: current.itemId,
    reviewType: "image",
    artifactIds: current.artifactIds,
    expectedScanId: "scan-1",
    expectedArtifactHashes: current.artifactHashes,
    expectedRequirementId: current.id,
    visualConstraintAttestations: entries,
    decision: "pass",
    criteria: [],
  };
}

function artifact(id: string, hash: string, panelRequirement: FusionStoryboardReviewPanelRequirement, kind: "raw-image" | "labeled-image"): Artifact {
  const path = `/tmp/${id}.png`;
  return {
    id,
    uri: `file://${path}`,
    itemId: "unit-1",
    path,
    rootSlot: "output-1",
    relativePath: `${id}.png`,
    kind,
    variant: panelRequirement.frameRole === "middle" ? "generic" : panelRequirement.frameRole,
    versionLabel: "current",
    deprecated: false,
    authoritative: true,
    accepted: false,
    modifiedAt: "2026-07-17T00:00:00.000Z",
    check: { ok: true, exists: true, size: 1024, sha256: hash, issues: [] },
    fusionStoryboardPanel: {
      schemaVersion: 1,
      type: "fusion-storyboard-panel",
      contractId: "grid-contract",
      sourceFingerprint: "source",
      productionFingerprint: "production",
      panelId: panelRequirement.panelId,
      panelIndex: panelRequirement.panelIndex,
      panelCount: 2,
      frameRole: panelRequirement.frameRole,
      startSeconds: panelRequirement.panelIndex === 1 ? 0 : 7.5,
      endSeconds: panelRequirement.panelIndex === 1 ? 7.5 : 15,
      generationJobId: panelRequirement.generationJobId!,
      publicationReceiptId: panelRequirement.publicationReceiptId,
      panelVisualConstraintEvidenceVersion: 1,
      panelVisualConstraintId: panelRequirement.panelVisualConstraintId,
      panelVisualConstraintFingerprint: panelRequirement.panelVisualConstraintFingerprint,
      panelVisualModelFingerprint: panelRequirement.panelVisualModelFingerprint,
      panelVisualReviewRulesFingerprint: panelRequirement.panelVisualReviewRulesFingerprint,
    },
  };
}

describe("P3 宫格人工视觉 Review 证据", () => {
  it("总体 pass 必须精确覆盖每格每条规则，重复、缺失和 fail 均失败关闭", () => {
    const current = requirement();
    const complete = attestations(current);
    expect(normalizeVisualConstraintAttestations(submission(current, complete), current)).toEqual(complete);
    expect(visualConstraintAttestationsCoverRequirement(complete, current)).toBe(true);

    expect(() => normalizeVisualConstraintAttestations(submission(current, complete.slice(1)), current)).toThrow("逐格逐条");
    expect(() => normalizeVisualConstraintAttestations(submission(current, [...complete, complete[0]!]), current)).toThrow("重复");
    expect(() => normalizeVisualConstraintAttestations(submission(current, complete.map((entry, index) => index ? entry : { ...entry, result: "fail" })), current)).toThrow("机械检查不能替代");
    expect(visualConstraintAttestationsCoverRequirement(complete.slice(1), current)).toBe(false);
  });

  it("普通非 P3 requirement 保持兼容，但拒绝无来源的 P3 确认", () => {
    const current = requirement();
    const legacy = {
      ...current,
      panels: current.panels.map(({ panelVisualConstraintEvidenceVersion: _version, panelVisualConstraintId: _id,
        panelVisualConstraintFingerprint: _fingerprint, panelVisualModelFingerprint: _model,
        panelVisualReviewRulesFingerprint: _review, visualReviewRules: _rules, visualWarnings: _warnings, ...entry }) => entry),
    } satisfies FusionStoryboardReviewRequirement;
    expect(normalizeVisualConstraintAttestations(submission(legacy, undefined), legacy)).toBeUndefined();
    expect(() => normalizeVisualConstraintAttestations(submission(legacy, attestations(current)), legacy)).toThrow("没有 P3");
  });

  it("约束、模型或人工规则漂移后旧 Review 自动失效", () => {
    const current = requirement();
    const artifacts = current.panels.flatMap((entry) => [
      artifact(entry.raw!.artifactId, entry.raw!.sha256, entry, "raw-image"),
      artifact(entry.labeled!.artifactId, entry.labeled!.sha256, entry, "labeled-image"),
    ]);
    const record: ReviewRecord = {
      id: "review-1",
      itemId: current.itemId,
      reviewType: "image",
      artifactIds: current.artifactIds,
      artifactEvidence: artifacts.map(artifactReviewEvidence),
      requirementId: current.id,
      requirement: current,
      visualConstraintAttestations: attestations(current),
      decision: "pass",
      criteria: [],
      reviewer: "user",
      resultingStatus: "待视频",
      createdAt: "2026-07-17T00:00:00.000Z",
    };
    expect(reviewCoversFusionStoryboardRequirement(record, current, artifacts)).toBe(true);

    const constraintDrifted = structuredClone(current);
    constraintDrifted.panels[0]!.panelVisualConstraintFingerprint = "8".repeat(64);
    expect(reviewCoversFusionStoryboardRequirement(record, constraintDrifted, artifacts)).toBe(false);

    const modelDrifted = structuredClone(current);
    modelDrifted.panels[0]!.panelVisualModelFingerprint = "7".repeat(64);
    expect(reviewCoversFusionStoryboardRequirement(record, modelDrifted, artifacts)).toBe(false);

    const reviewRulesDrifted = structuredClone(current);
    reviewRulesDrifted.panels[0]!.panelVisualReviewRulesFingerprint = "9".repeat(64);
    reviewRulesDrifted.panels[0]!.visualReviewRules![0]!.instruction = "已经变化的人工规则";
    expect(reviewCoversFusionStoryboardRequirement(record, reviewRulesDrifted, artifacts)).toBe(false);

    const missingAttestation = { ...record, visualConstraintAttestations: record.visualConstraintAttestations!.slice(1) };
    expect(reviewCoversFusionStoryboardRequirement(missingAttestation, current, artifacts)).toBe(false);
  });
});
