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
});


