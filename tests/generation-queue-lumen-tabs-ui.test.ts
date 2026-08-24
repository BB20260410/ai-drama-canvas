import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("GenerationQueueView LumenX 分桶接线", () => {
  it("使用 buildStudioGenerationQueueView 与 active/done/failed tab", () => {
    const vue = source("src/renderer/src/components/GenerationQueueView.vue");
    expect(parse(vue, { filename: "GenerationQueueView.vue" }).errors).toEqual([]);
    expect(vue).toContain("buildStudioGenerationQueueView");
    expect(vue).toContain('data-testid="generation-queue-lumen-tabs"');
    expect(vue).toContain('data-queue-tab="active"');
    expect(vue).toContain('data-queue-tab="done"');
    expect(vue).toContain('data-queue-tab="failed"');
    expect(vue).toContain("queueView.inFlightCount");
    expect(vue).toContain("kindScopedJobs");
  });

  it("LumenX TaskQueue：取消 / 跳转 / 预览接线", () => {
    const vue = source("src/renderer/src/components/GenerationQueueView.vue");
    expect(vue).toContain('data-testid="generation-queue-cancel"');
    expect(vue).toContain('data-testid="generation-queue-jump"');
    expect(vue).toContain('data-testid="generation-queue-preview"');
    expect(vue).toContain("resolveStudioGenerationQueueJumpTarget");
    expect(vue).toContain("previewJob");
    expect(vue).toContain("jumpJob");
    const app = source("src/renderer/src/App.vue");
    expect(app).toContain('@jump="onGenerationQueueJump"');
    expect(app).toContain("function onGenerationQueueJump");
    expect(app).toContain("openItemInList");
  });

  it("取消/保存配置/入队在进行中 fail-closed：busy 在首个 await 之前置位，连点不会重复取消或写配置", () => {
    const vue = source("src/renderer/src/components/GenerationQueueView.vue");
    expect(vue).toContain('data-testid="generation-queue-cancel"');
    expect(vue).toContain(':disabled="busy"');
    expect(vue).toContain("正在处理，不能再取消");
    expect(vue).toContain('data-testid="generation-queue-save-settings"');
    expect(vue).toContain("正在处理，不能再保存配置");

    const cancelStart = vue.indexOf("async function cancel(");
    const cancelEnd = vue.indexOf("\nasync function reviewCandidate(", cancelStart);
    expect(cancelStart).toBeGreaterThan(-1);
    expect(cancelEnd).toBeGreaterThan(cancelStart);
    const cancel = vue.slice(cancelStart, cancelEnd);
    expect(cancel).toContain("if (busy.value) return;");
    expect(cancel).toContain("busy.value=true");
    expect(cancel.indexOf("if (busy.value) return;")).toBeLessThan(cancel.indexOf("busy.value=true"));
    expect(cancel.indexOf("busy.value=true")).toBeLessThan(cancel.indexOf("await window.canvasApi.cancelGenerationJob"));
    expect(cancel).toContain("busy.value=false");

    const saveStart = vue.indexOf("async function saveSettings()");
    const saveEnd = vue.indexOf("\nfunction addProvider()", saveStart);
    expect(saveStart).toBeGreaterThan(-1);
    expect(saveEnd).toBeGreaterThan(saveStart);
    const save = vue.slice(saveStart, saveEnd);
    expect(save).toContain("if (!settings.value || busy.value) return;");
    expect(save).toContain("busy.value = true");
    expect(save.indexOf("if (!settings.value || busy.value) return;")).toBeLessThan(save.indexOf("busy.value = true"));
    expect(save.indexOf("busy.value = true")).toBeLessThan(save.indexOf("await window.canvasApi.saveGenerationSettings"));
    expect(save).toContain("busy.value = false");

    const enqueueStart = vue.indexOf("async function enqueueNext()");
    const enqueueEnd = vue.indexOf("\nasync function processJob(", enqueueStart);
    const enqueue = vue.slice(enqueueStart, enqueueEnd);
    expect(enqueue).toContain("if (busy.value) return;");
    expect(enqueue.indexOf("if (busy.value) return;")).toBeLessThan(enqueue.indexOf("busy.value = true"));
  });

  it("视觉通过/返工在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source("src/renderer/src/components/GenerationQueueView.vue");
    expect(vue).toContain("const busy = ref(false);");

    for (const testId of ["generation-queue-visual-accept", "generation-queue-visual-reject"]) {
      const marker = `data-testid="${testId}"`;
      const idx = vue.indexOf(marker);
      expect(idx).toBeGreaterThan(-1);
      const start = vue.lastIndexOf("<button", idx);
      const end = vue.indexOf(">", idx);
      const button = vue.slice(start, end + 1);
      expect(button).toContain(':disabled="busy"');
      expect(button).toContain("正在处理，不能再提交视觉验收");
    }

    const reviewStart = vue.indexOf("async function reviewCandidate(");
    const reviewEnd = vue.indexOf("\nasync function saveSettings()", reviewStart);
    expect(reviewStart).toBeGreaterThan(-1);
    expect(reviewEnd).toBeGreaterThan(reviewStart);
    const review = vue.slice(reviewStart, reviewEnd);
    expect(review).toContain("if (busy.value) return;");
    expect(review).toContain("busy.value=true");
    expect(review).toContain("busy.value=false");
    expect(review.indexOf("if (busy.value) return;")).toBeLessThan(review.indexOf("busy.value=true"));
    expect(review.indexOf("busy.value=true")).toBeLessThan(review.indexOf("window.prompt"));
    expect(review.indexOf("busy.value=true")).toBeLessThan(review.indexOf("await window.canvasApi.updateSubagentImageGenerationJob"));
    expect(review).toContain("finally");
  });

  it("定向处理在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复处理", () => {
    const vue = source("src/renderer/src/components/GenerationQueueView.vue");
    const marker = 'data-testid="generation-queue-process"';
    const idx = vue.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    const start = vue.lastIndexOf("<button", idx);
    const end = vue.indexOf(">", idx);
    const button = vue.slice(start, end + 1);
    expect(button).toContain(':disabled="busy"');
    expect(button).toContain("正在处理，不能再定向处理");

    const processStart = vue.indexOf("async function processJob(");
    const processEnd = vue.indexOf("\nasync function cancel(", processStart);
    expect(processStart).toBeGreaterThan(-1);
    expect(processEnd).toBeGreaterThan(processStart);
    const process = vue.slice(processStart, processEnd);
    expect(process).toContain("if (busy.value) return;");
    expect(process).toContain("busy.value=true");
    expect(process).toContain("busy.value=false");
    expect(process.indexOf("if (busy.value) return;")).toBeLessThan(process.indexOf("busy.value=true"));
    expect(process.indexOf("busy.value=true")).toBeLessThan(process.indexOf("await window.canvasApi.processGenerationQueue"));
    expect(process).toContain("finally");
  });
});

describe("生成队列行视口剔除", () => {
  it("job-row 使用 content-visibility，离屏任务行跳过同步布局", () => {
    const vue = source("src/renderer/src/components/GenerationQueueView.vue");
    expect(vue).toContain('class="job-row"');
    expect(vue).toContain(".job-list{min-height:0;overflow:auto;padding:0 26px 70px}");
    expect(vue).toContain(".job-row{min-width:760px;display:grid;grid-template-columns:110px minmax(260px,1.4fr) minmax(260px,1fr) 150px;gap:14px;align-items:center;min-height:92px;border-bottom:1px solid #2b2d27;content-visibility:auto;contain-intrinsic-size:auto 92px}");
    expect(vue).not.toMatch(/\.job-row\{[^}]*content-visibility:hidden/);
  });
});


