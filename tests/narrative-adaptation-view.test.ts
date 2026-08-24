import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/NarrativeAdaptationView.vue"), "utf8");
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

describe("自动改编工作台分析章节源码合同", () => {
  it("SFC 可解析并暴露分析真实章节", () => {
    const vue = source();
    expect(parse(vue, { filename: "NarrativeAdaptationView.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="adaptation-analyze"');
  });

  it("分析真实章节在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();
    const analyzeButton = buttonAttrs(vue, "adaptation-analyze");
    expect(analyzeButton).toContain(':disabled="busy"');
    expect(analyzeButton).toContain("正在处理，不能再分析章节");
    expect(vue).toContain("{{ busyAction === 'analyze' ? '分析中' : '分析真实章节' }}");

    const run = handlerBody(vue, "async function run(", "async function analyze(");
    expect(run).toContain("if(busyAction.value)return");
    expect(run).toContain("busyAction.value=action");
    expect(run.indexOf("if(busyAction.value)return")).toBeLessThan(run.indexOf("busyAction.value=action"));
    expect(run.indexOf("busyAction.value=action")).toBeLessThan(run.indexOf("await operation()"));
    expect(run).toContain('emit("failed",message(error))');
    expect(run).toContain('busyAction.value=""');

    const analyze = handlerBody(vue, "async function analyze()", "async function createModelTask()");
    expect(analyze).toContain('run("analyze"');
    expect(analyze).toContain("await window.canvasApi.analyzeNovelChapters");
    expect(analyze.indexOf('run("analyze"')).toBeLessThan(analyze.indexOf("await window.canvasApi.analyzeNovelChapters"));
  });

  it("替换失败批次与批量审核在 prompt/confirm 前 fail-closed：busy 挡住连点双对话框", () => {
    const vue = source();
    expect(vue).toContain("正在处理，不能再替换失败批次");
    expect(vue).toContain("正在处理，不能再批量审核提案");
    expect(vue).toContain(':disabled="busy"');
    expect(vue).toContain('@click="replaceFailedBatch"');
    expect(vue).toContain('@click="batchReview(\'accepted\')"');
    expect(vue).toContain('@click="batchReview(\'rejected\')"');

    const replace = handlerBody(vue, "async function replaceFailedBatch()", "function newProvider()");
    expect(replace).toContain("if(busyAction.value)return");
    expect(replace).toContain("window.prompt");
    expect(replace.indexOf("if(busyAction.value)return")).toBeLessThan(replace.indexOf("window.prompt"));
    expect(replace.indexOf("if(busyAction.value)return")).toBeLessThan(replace.indexOf('run("model-replace"'));

    const batch = handlerBody(vue, "async function batchReview(", "async function validate()");
    expect(batch).toContain("if(busyAction.value)return");
    expect(batch).toContain("window.confirm");
    expect(batch.indexOf("if(busyAction.value)return")).toBeLessThan(batch.indexOf("window.confirm"));
    expect(batch.indexOf("if(busyAction.value)return")).toBeLessThan(batch.indexOf('run("review-batch"'));
  });
});

describe("自动改编工作台事实/节拍行视口剔除", () => {
  it("fact-list、beat-sequence、review-queue 行使用 content-visibility，离屏全量列表跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="fact in filteredFacts"');
    expect(vue).toContain('v-for="beat in workspace.beats"');
    expect(vue).toContain(".fact-list{height:calc(52% - 92px);overflow:auto}");
    expect(vue).toContain(".beat-sequence{overflow:auto;padding:10px 0}");
    expect(vue).toContain(".review-queue{overflow:auto}");
    expect(vue).toContain(".fact-list>button{width:100%;padding:10px 13px;border:0;border-bottom:1px solid #262823;border-left:2px solid transparent;background:transparent;color:#a6a9a0;text-align:left;content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(vue).toContain(".beat-sequence>button{position:relative;width:100%;display:grid;grid-template-columns:44px minmax(0,1fr) 18px;align-items:center;min-height:62px;padding:8px 16px;border:0;border-bottom:1px solid #272924;background:transparent;color:#aaa;text-align:left;content-visibility:auto;contain-intrinsic-size:auto 62px}");
    expect(vue).toContain(".review-queue>button{width:100%;display:block;padding:11px 14px;border:0;border-bottom:1px solid #282a25;border-left:2px solid transparent;background:transparent;color:#a9aca4;text-align:left;content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(vue).not.toMatch(/\.fact-list>button\{[^}]*content-visibility:hidden/);
  });
});

describe("自动改编工作台方案单元/供应商行视口剔除", () => {
  it("unit-list、provider-list、shot-list 行使用 content-visibility，离屏条目跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="unit in activePlan.units"');
    expect(vue).toContain('v-for="provider in providerSettings.providers"');
    expect(vue).toContain(".unit-list{max-height:35%;overflow:auto}");
    expect(vue).toContain(".provider-list{overflow:auto;border-bottom:1px solid #30322c}");
    expect(vue).toContain(".unit-list>section>button{width:100%;padding:11px 13px;border:0;border-left:2px solid transparent;background:transparent;color:#aaa;text-align:left;content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(vue).toContain(".provider-list>button{width:100%;display:block;padding:10px 14px;border:0;border-bottom:1px solid #282a25;border-left:2px solid transparent;background:transparent;color:#aaa;text-align:left;content-visibility:auto;contain-intrinsic-size:auto 52px}");
    expect(vue).toContain(".shot-list>button{width:100%;display:grid;grid-template-columns:28px minmax(0,1fr);padding:8px;border:0;border-top:1px solid #252721;background:#11120f;color:#999;text-align:left;content-visibility:auto;contain-intrinsic-size:auto 40px}");
    expect(vue).not.toMatch(/\.unit-list>section>button\{[^}]*content-visibility:hidden/);
  });
});
