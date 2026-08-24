import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/StudioContinuityReviewView.vue"), "utf8");
}

function buttonAttrs(text: string, testId: string): string {
  const marker = `data-testid="${testId}"`;
  const idx = text.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  const start = text.lastIndexOf("<button", idx);
  expect(start).toBeGreaterThan(-1);
  let quote: string | null = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return text.slice(start, i + 1);
  }
  throw new Error(`button tag for ${testId} was not closed`);
}

function handlerBody(text: string, signature: string, nextSignature: string): string {
  const start = text.indexOf(signature);
  const end = text.indexOf(nextSignature, start + signature.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("连续性审片提交源码合同", () => {
  it("SFC 可解析并暴露返工/拒绝/通过动作", () => {
    const vue = source();
    expect(parse(vue, { filename: "StudioContinuityReviewView.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="continuity-review-rework"');
    expect(vue).toContain('data-testid="continuity-review-reject"');
    expect(vue).toContain('data-testid="continuity-review-pass"');
  });

  it("审片下一动作诊断 summary 含 testid，不铺资产/冲突/批次行", () => {
    const vue = source();
    expect(vue).toContain('class="technical-diagnostics next-action-diagnostics"');
    expect(vue).toContain('data-testid="studio-continuity-next-action-diagnostics"');
    expect(vue).toContain('<summary data-testid="studio-continuity-next-action-diagnostics">诊断详情</summary>');
    expect(vue).not.toContain('next-action-diagnostics" role="dialog"');
    expect(vue).not.toContain("material-studio-diagnostics");
    expect(vue).not.toContain("studio-generation-message-diagnostics");
  });

  it("审片头栏诊断 summary 含 testid，不铺资产/冲突/批次", () => {
    const vue = source();
    expect(vue).toContain('class="review-head"');
    expect(vue).toContain('data-testid="studio-continuity-review-head-diagnostics"');
    expect(vue).toContain('<summary data-testid="studio-continuity-review-head-diagnostics">诊断详情</summary>');
    expect(vue).toContain("Head revision {{ loadState.control.review.control.headRevision }}");
    expect(vue).toContain('data-testid="review-rework-guidance"');
    expect(vue).toContain('data-testid="studio-continuity-next-action-diagnostics"');
    expect(vue).toContain("`studio-review-identity-${review.reviewId}`");
    expect(vue).not.toMatch(/class="review-head"[^>]*role="dialog"/);
  });

  it("审片提交时身份 summary 含共享 testid，不改 per-review details", () => {
    const vue = source();
    expect(vue).toContain('class="technical-diagnostics review-identity"');
    expect(vue).toContain("`studio-review-identity-${review.reviewId}`");
    expect(vue).toContain('data-testid="studio-review-identity-summary"');
    expect(vue).toContain('<summary data-testid="studio-review-identity-summary">提交时身份（生成时版本）</summary>');
    expect(vue).not.toContain("studio-review-identity-summary-");
    expect(vue).not.toContain('review-identity" role="dialog"');
    expect(vue).toContain('data-testid="studio-continuity-review-head-diagnostics"');
    expect(vue).toContain('data-testid="studio-continuity-next-action-diagnostics"');
    expect(vue).toContain('data-testid="studio-continuity-empty-diagnostics"');
  });

  it("资产卡诊断 summary 含共享 testid，不铺冲突/批次/头栏", () => {
    const vue = source();
    expect(vue).toContain('class="asset-control"');
    expect(vue).toContain('data-testid="studio-continuity-asset-diagnostics"');
    expect(vue).toContain('<summary data-testid="studio-continuity-asset-diagnostics">诊断详情</summary>');
    expect(vue).toContain("{{ asset.assetId }}");
    expect(vue).toContain('data-testid="continuity-assets"');
    expect(vue).not.toContain("studio-continuity-asset-diagnostics-");
  });

  it("冲突卡诊断 summary 含共享 testid，不铺批次/资产/头栏", () => {
    const vue = source();
    expect(vue).toContain('class="control-section conflict-section"');
    expect(vue).toContain('data-testid="studio-continuity-conflict-diagnostics"');
    expect(vue).toContain('<summary data-testid="studio-continuity-conflict-diagnostics">诊断详情</summary>');
    expect(vue).toContain("{{ conflict.subjectId }} · {{ conflict.conflictId }} · r{{ conflict.revision }}");
    expect(vue).toContain('data-testid="continuity-conflicts"');
    expect(vue).not.toContain("studio-continuity-conflict-diagnostics-");
    expect(vue).toContain('<summary data-testid="studio-continuity-batch-diagnostics">诊断详情</summary>');
  });

  it("批次卡诊断 summary 含共享 testid，不给 blocking-batch 新加 details", () => {
    const vue = source();
    expect(vue).toContain('class="batch-grid"');
    expect(vue).toContain('data-testid="generation-checkpoint-control"');
    expect(vue).toContain('data-testid="studio-continuity-batch-diagnostics"');
    expect(vue).toContain('<summary data-testid="studio-continuity-batch-diagnostics">诊断详情</summary>');
    expect(vue).toContain("checkpoint r{{ batch.checkpointHeadRevision }} · attestation r{{ batch.attestationHeadRevision }}");
    expect(vue).toContain('<article v-if="loadState.control.checkpoint.blockingBatch" class="blocking-batch">');
    expect(vue).toContain("<strong>当前阻断：第 {{ loadState.control.checkpoint.blockingBatch.batchNumber }} 批</strong>");
    expect(vue).not.toContain("studio-continuity-batch-diagnostics-");
    expect(vue).not.toContain('class="blocking-batch"><details');
    expect(vue).toContain('data-testid="studio-continuity-asset-diagnostics"');
    expect(vue).toContain('data-testid="studio-continuity-conflict-diagnostics"');
    expect(vue).toContain('data-testid="studio-continuity-review-head-diagnostics"');
    expect(vue).toContain('data-testid="studio-continuity-next-action-diagnostics"');
  });

  it("审片空态诊断 summary 含 testid，不改查询表单与下一动作", () => {
    const vue = source();
    expect(vue).toContain('class="review-entry-empty"');
    expect(vue).toContain('data-testid="continuity-business-empty"');
    expect(vue).toContain('class="diagnostic-details"');
    expect(vue).toContain('data-testid="studio-continuity-empty-diagnostics"');
    expect(vue).toContain('<summary data-testid="studio-continuity-empty-diagnostics">诊断详情</summary>');
    expect(vue).toContain('data-testid="continuity-query-form"');
    expect(vue).toContain('class="empty-goto-canvas"');
    expect(vue).not.toContain('diagnostic-details" role="dialog"');
    expect(vue).toContain('data-testid="studio-continuity-next-action-diagnostics"');
    expect(vue).toContain('data-testid="studio-continuity-batch-diagnostics"');
  });

  it("审片提交进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();

    const rework = buttonAttrs(vue, "continuity-review-rework");
    expect(rework).toContain(':disabled="reviewSubmitting || !reviewPairReady || !reviewNote.trim() || incompleteDraftCount > 0"');
    expect(rework).toContain("正在处理，不能再返工");
    expect(vue).toContain('{{ reviewSubmitting ? "提交中" : "返工" }}');

    const reject = buttonAttrs(vue, "continuity-review-reject");
    expect(reject).toContain(':disabled="reviewSubmitting || !reviewPairReady || !reviewNote.trim() || incompleteDraftCount > 0"');
    expect(reject).toContain("正在处理，不能再拒绝");
    expect(vue).toContain('{{ reviewSubmitting ? "提交中" : "拒绝" }}');

    const pass = buttonAttrs(vue, "continuity-review-pass");
    expect(pass).toContain(':disabled="reviewSubmitting || !reviewPairReady || !reviewNote.trim() || incompleteDraftCount > 0"');
    expect(pass).toContain("正在处理，不能再通过");
    expect(vue).toContain('{{ reviewSubmitting ? "提交中" : "通过" }}');

    const submit = handlerBody(vue, "async function submitVisualReview(", "async function removeHeadAnnotation(");
    expect(submit).toContain("if (reviewSubmitting.value) return;");
    expect(submit).toContain("reviewSubmitting.value = true");
    expect(submit.indexOf("if (reviewSubmitting.value) return;")).toBeLessThan(
      submit.indexOf("reviewSubmitting.value = true"),
    );
    expect(submit.indexOf("reviewSubmitting.value = true")).toBeLessThan(
      submit.indexOf("await props.api.getReviewIdentity"),
    );
    expect(submit.indexOf("if (reviewSubmitting.value) return;")).toBeLessThan(
      submit.indexOf("++reviewSubmissionSequence"),
    );
    expect(submit).toContain("reviewSubmitting.value = false");
  });

  it("移除已提交批注 fail-closed：busy 早退，按钮禁用并给出大白话原因", () => {
    const vue = source();
    const clickAt = vue.indexOf('@click="removeHeadAnnotation');
    expect(clickAt).toBeGreaterThan(-1);
    const start = vue.lastIndexOf("<button", clickAt);
    expect(start).toBeGreaterThan(-1);
    const remove = vue.slice(start, vue.indexOf(">", start) + 1);
    expect(remove).toContain(':disabled="reviewSubmitting"');
    expect(remove).toContain("正在处理，不能再移除批注");

    const handler = handlerBody(vue, "async function removeHeadAnnotation(", "function decodedOf(");
    expect(handler).toContain("if (reviewSubmitting.value) return;");
    expect(handler).toContain("reviewSubmitting.value = true");
    expect(handler.indexOf("if (reviewSubmitting.value) return;")).toBeLessThan(
      handler.indexOf("reviewSubmitting.value = true"),
    );
    expect(handler.indexOf("reviewSubmitting.value = true")).toBeLessThan(
      handler.indexOf("await props.api.getReviewIdentity"),
    );
    expect(handler.indexOf("if (reviewSubmitting.value) return;")).toBeLessThan(
      handler.indexOf("++reviewSubmissionSequence"),
    );
    expect(handler).toContain("reviewSubmitting.value = false");
  });
});
