import type { StudioGenerationResultRecord } from "../../core/studio-generation-ledger.js";
import type { StudioGenerationReviewControl } from "../../core/studio-generation-review.js";

export interface CurrentApprovedUnitGridResultIdentityInput {
  review: StudioGenerationReviewControl;
  generationRunId: string;
  raw: StudioGenerationResultRecord;
  labeled: StudioGenerationResultRecord;
  selectedRawSha256: string;
  selectedLabeledSha256: string;
  selectedPackFingerprint?: string | null;
}

/**
 * 核对核心选中的 unit-grid 结果仍与当前 Review head 完全一致。
 *
 * 核心时间线负责“选中哪张正式 raw”；渲染层在异步读取结束前只做执行身份复核，
 * 防止 PASS 被撤销、结果对被替换或冻结包变化后，旧 worker 把旧 raw 回写画布。
 */
export function isCurrentApprovedUnitGridResultIdentity(
  input: CurrentApprovedUnitGridResultIdentityInput,
): boolean {
  const {
    review,
    generationRunId,
    raw,
    labeled,
    selectedRawSha256,
    selectedLabeledSha256,
    selectedPackFingerprint,
  } = input;
  const head = review.head;
  return review.generationRunId === generationRunId
    && review.status === "pass"
    && Boolean(head)
    && head!.current
    && head!.approvedRawEligible
    && head!.decision === "pass"
    && head!.rawResultId === raw.resultId
    && head!.rawSha256 === selectedRawSha256
    && head!.labeledResultId === labeled.resultId
    && head!.labeledSha256 === selectedLabeledSha256
    && head!.packId === raw.packId
    && head!.packId === labeled.packId
    && head!.packFingerprint === raw.packFingerprint
    && head!.packFingerprint === labeled.packFingerprint
    && (!selectedPackFingerprint || head!.packFingerprint === selectedPackFingerprint);
}
