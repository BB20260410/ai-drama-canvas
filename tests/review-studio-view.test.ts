import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/ReviewStudioView.vue"), "utf8");
}

function buttonAttrs(text: string, testId: string): string {
  const marker = `data-testid="${testId}"`;
  const idx = text.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  const start = text.lastIndexOf("<button", idx);
  const end = text.indexOf(">", idx);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end + 1);
}

function handlerBody(text: string, signature: string, nextSignature: string): string {
  const start = text.indexOf(signature);
  const end = text.indexOf(nextSignature, start + signature.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("导演验收台源码合同", () => {
  it("SFC 可解析并暴露设为权威动作", () => {
    const vue = source();
    expect(parse(vue, { filename: "ReviewStudioView.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="review-set-authority"');
  });

  it("设为权威在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();
    expect(vue).toContain("const settingAuthority = ref(false);");

    const button = buttonAttrs(vue, "review-set-authority");
    expect(button).toContain(':disabled="settingAuthority"');
    expect(button).toContain("正在处理，不能再设为权威");

    const setAuthority = handlerBody(vue, "async function setAuthority(", "async function submit(");
    expect(setAuthority).toContain("if (!active.value || settingAuthority.value) return;");
    expect(setAuthority).toContain("settingAuthority.value = true");
    expect(setAuthority).toContain("settingAuthority.value = false");
    expect(setAuthority.indexOf("if (!active.value || settingAuthority.value) return;")).toBeLessThan(
      setAuthority.indexOf("settingAuthority.value = true"),
    );
    expect(setAuthority.indexOf("settingAuthority.value = true")).toBeLessThan(
      setAuthority.indexOf("await window.canvasApi.setAuthoritativeArtifact"),
    );
    expect(setAuthority).toContain("finally");
  });

  it("提交验收在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();
    expect(vue).toContain("const submitting = ref(false);");

    for (const testId of ["review-submit-pending", "review-submit-rework", "review-submit-pass"]) {
      const button = buttonAttrs(vue, testId);
      expect(button).toContain(':disabled="submitting');
      expect(button).toContain("正在处理，不能再提交验收");
    }

    const submit = handlerBody(vue, "async function submit(", "function reviewAssetUrl(");
    expect(submit).toContain("if (!active.value || !artifactA.value || submitting.value) return;");
    expect(submit).toContain("submitting.value = true");
    expect(submit).toContain("submitting.value=false");
    expect(submit.indexOf("if (!active.value || !artifactA.value || submitting.value) return;")).toBeLessThan(
      submit.indexOf("submitting.value = true"),
    );
    expect(submit.indexOf("submitting.value = true")).toBeLessThan(
      submit.indexOf("await window.canvasApi.submitReview"),
    );
    expect(submit).toContain("finally");
  });
});

describe("导演验收台历史视口剔除", () => {
  it("review-history article 使用 content-visibility，离屏验收记录跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="record in history"');
    expect(vue).toContain(".review-inspector{min-height:0;overflow:auto;border-left:1px solid #30322c;background:#171815}");
    expect(vue).toContain(
      ".review-history article{display:flex;gap:8px;padding:10px 0;border-bottom:1px solid #292b25;content-visibility:auto;contain-intrinsic-size:auto 56px}",
    );
    expect(vue).not.toMatch(/\.review-history article\{[^}]*content-visibility:hidden/);
    expect(vue).not.toMatch(/\.annotation-editor>article\{[^}]*content-visibility/);
  });
});
