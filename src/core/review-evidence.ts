import path from "node:path";
import type {
  Artifact,
  FusionStoryboardReviewRequirement,
  FusionVisualReviewRuleAttestation,
  ReviewArtifactEvidence,
  ReviewRecord,
} from "./types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function artifactReviewEvidence(artifact: Artifact): ReviewArtifactEvidence {
  const sha256 = artifact.check.sha256;
  if (!sha256 || !SHA256_PATTERN.test(sha256)) {
    throw new Error(`${path.basename(artifact.path)} 缺少有效 SHA-256，不能锁定视觉验收内容。`);
  }
  return {
    artifactId: artifact.id,
    path: artifact.path,
    rootSlot: artifact.rootSlot,
    relativePath: artifact.relativePath,
    kind: artifact.kind,
    variant: artifact.variant,
    size: artifact.check.size,
    sha256,
    fusionStoryboardPanel: artifact.fusionStoryboardPanel,
  };
}

function sameFusionPanelBinding(
  evidence: ReviewArtifactEvidence["fusionStoryboardPanel"],
  current: Artifact["fusionStoryboardPanel"],
): boolean {
  if (!evidence && !current) return true;
  if (!evidence || !current) return false;
  return evidence.schemaVersion === current.schemaVersion
    && evidence.type === current.type
    && evidence.contractId === current.contractId
    && evidence.sourceFingerprint === current.sourceFingerprint
    && evidence.productionFingerprint === current.productionFingerprint
    && evidence.panelId === current.panelId
    && evidence.panelIndex === current.panelIndex
    && evidence.panelCount === current.panelCount
    && evidence.frameRole === current.frameRole
    && evidence.startSeconds === current.startSeconds
    && evidence.endSeconds === current.endSeconds
    && evidence.generationJobId === current.generationJobId
    && evidence.publicationReceiptId === current.publicationReceiptId
    && evidence.panelReferenceEvidenceVersion === current.panelReferenceEvidenceVersion
    && evidence.panelReferenceResolutionId === current.panelReferenceResolutionId
    && evidence.panelReferenceResolutionFingerprint === current.panelReferenceResolutionFingerprint
    && evidence.panelVisualConstraintEvidenceVersion === current.panelVisualConstraintEvidenceVersion
    && evidence.panelVisualConstraintId === current.panelVisualConstraintId
    && evidence.panelVisualConstraintFingerprint === current.panelVisualConstraintFingerprint
    && evidence.panelVisualModelFingerprint === current.panelVisualModelFingerprint
    && evidence.panelVisualReviewRulesFingerprint === current.panelVisualReviewRulesFingerprint;
}

export interface FusionVisualReviewRuleRequirement {
  panelId: string;
  constraintId: string;
  reviewRulesFingerprint: string;
  ruleId: string;
}

function attestationKey(value: FusionVisualReviewRuleRequirement): string {
  return [value.panelId, value.constraintId, value.reviewRulesFingerprint, value.ruleId].join("\0");
}

/**
 * P3 的人工视觉检查清单。这里仅展开已经冻结进 requirement 的规则，绝不
 * 从 warning 或机械检测结果推断“已人工检查”。
 */
export function fusionVisualReviewRuleRequirements(
  requirement: FusionStoryboardReviewRequirement | undefined,
): FusionVisualReviewRuleRequirement[] {
  if (!requirement) return [];
  return requirement.panels.flatMap((panel) => {
    if (panel.panelVisualConstraintEvidenceVersion !== 1
      || !panel.panelVisualConstraintId
      || !panel.panelVisualReviewRulesFingerprint) return [];
    return (panel.visualReviewRules ?? []).map((rule) => ({
      panelId: panel.panelId,
      constraintId: panel.panelVisualConstraintId!,
      reviewRulesFingerprint: panel.panelVisualReviewRulesFingerprint!,
      ruleId: rule.id,
    }));
  });
}

export function visualConstraintAttestationsCoverRequirement(
  attestations: readonly FusionVisualReviewRuleAttestation[] | undefined,
  requirement: FusionStoryboardReviewRequirement | undefined,
): boolean {
  const expected = fusionVisualReviewRuleRequirements(requirement);
  const hasP3Panels = Boolean(requirement?.panels.some((panel) => panel.panelVisualConstraintEvidenceVersion === 1));
  if (!hasP3Panels) return !attestations?.length;
  if (!requirement?.complete || !expected.length || attestations?.length !== expected.length) return false;
  const expectedKeys = new Set(expected.map(attestationKey));
  if (expectedKeys.size !== expected.length) return false;
  const actualKeys = new Set<string>();
  for (const attestation of attestations ?? []) {
    if (attestation.result !== "pass") return false;
    const key = attestationKey(attestation);
    if (!expectedKeys.has(key) || actualKeys.has(key)) return false;
    actualKeys.add(key);
  }
  return actualKeys.size === expectedKeys.size;
}

export function reviewCoversArtifact(record: ReviewRecord | undefined, artifact: Artifact | undefined): boolean {
  if (!record || !artifact?.check.sha256 || !record.artifactEvidence?.length) return false;
  const evidence = record.artifactEvidence.find((candidate) => candidate.artifactId === artifact.id);
  return Boolean(
    evidence
    && evidence.rootSlot === artifact.rootSlot
    && evidence.relativePath === artifact.relativePath
    && evidence.kind === artifact.kind
    && evidence.variant === artifact.variant
    && evidence.size === artifact.check.size
    && evidence.sha256 === artifact.check.sha256
    && sameFusionPanelBinding(evidence.fusionStoryboardPanel, artifact.fusionStoryboardPanel),
  );
}

export function reviewCoversArtifacts(record: ReviewRecord | undefined, artifacts: Array<Artifact | undefined>): boolean {
  return artifacts.length > 0 && artifacts.every((artifact) => reviewCoversArtifact(record, artifact));
}

export function reviewCoversAnyArtifact(record: ReviewRecord | undefined, artifacts: Artifact[]): boolean {
  return artifacts.some((artifact) => reviewCoversArtifact(record, artifact));
}

export function reviewCoversFusionStoryboardRequirement(
  record: ReviewRecord | undefined,
  requirement: FusionStoryboardReviewRequirement | undefined,
  artifacts: Artifact[],
): boolean {
  if (!record || !requirement?.complete || record.requirementId !== requirement.id || record.requirement?.id !== requirement.id) return false;
  const expectedIds = [...requirement.artifactIds].sort();
  const recordedIds = [...record.artifactIds].sort();
  if (expectedIds.length !== requirement.panelCount * 2 || JSON.stringify(recordedIds) !== JSON.stringify(expectedIds)) return false;
  if (record.requirement.contractId !== requirement.contractId
    || record.requirement.sourceFingerprint !== requirement.sourceFingerprint
    || record.requirement.productionFingerprint !== requirement.productionFingerprint
    || record.requirement.panelCount !== requirement.panelCount
    || JSON.stringify(record.requirement.panels) !== JSON.stringify(requirement.panels)) return false;
  if (!visualConstraintAttestationsCoverRequirement(record.visualConstraintAttestations, requirement)) return false;
  return expectedIds.every((artifactId) => {
    const artifact = artifacts.find((candidate) => candidate.id === artifactId);
    return reviewCoversArtifact(record, artifact) && artifact?.check.sha256 === requirement.artifactHashes[artifactId];
  });
}

export function reviewEvidencePaths(records: ReviewRecord[]): string[] {
  return [...new Set(records.flatMap((record) => record.artifactEvidence?.map((evidence) => path.resolve(evidence.path)) ?? []))];
}
