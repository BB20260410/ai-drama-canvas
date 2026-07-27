import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

describe("P7 连续性 / Review 桌面纵向接线", () => {
  it("main 与 preload 只增加 get-control IPC，并在受管工程校验后调用 Core", async () => {
    const [main, preload] = await Promise.all([
      source("src/main/index.ts"),
      source("src/preload/index.ts"),
    ]);
    expect(main).toContain('from "../core/studio-continuity-review-control.js"');
    expect(main).toMatch(/ipcMain\.handle\("canvas:get-studio-continuity-review-control"[\s\S]*?requireManagedStudioProject\(projectRoot\)[\s\S]*?getStudioContinuityReviewControl\(projectRoot, input\)/u);
    expect(preload).toContain('ipcRenderer.invoke("canvas:get-studio-continuity-review-control", projectRoot, input)');
    for (const forbiddenIpc of [
      "append-studio-continuity-observation",
      "append-studio-continuity-correction",
      "submit-studio-generation-review",
      "refresh-studio-generation-checkpoint",
      "attest-studio-generation-checkpoint",
    ]) {
      expect(main).not.toContain(`ipcMain.handle("canvas:${forbiddenIpc}"`);
      expect(preload).not.toContain(`ipcRenderer.invoke("canvas:${forbiddenIpc}"`);
    }
  });

  it("素材中心第五个生产步骤才惰性加载控制面，默认仍停留素材库", async () => {
    const [app, material, controlView] = await Promise.all([
      source("src/renderer/src/App.vue"),
      source("src/renderer/src/components/MaterialStudioView.vue"),
      source("src/renderer/src/components/StudioContinuityReviewView.vue"),
    ]);
    expect(parse(app, { filename: "App.vue" }).errors).toEqual([]);
    expect(parse(material, { filename: "MaterialStudioView.vue" }).errors).toEqual([]);
    expect(parse(controlView, { filename: "StudioContinuityReviewView.vue" }).errors).toEqual([]);
    expect(app).toContain(':continuity-review-api="studioContinuityReviewApi"');
    expect(app).toContain("window.canvasApi.getStudioContinuityReviewControl(root, input)");
    expect(material).toContain('data-testid="studio-step-review"');
    expect(material).toContain("5 审片");
    expect(material).toContain('activeMode');
    expect(material).toContain('defineAsyncComponent(() => import("./StudioContinuityReviewView.vue"))');
    expect(material).not.toMatch(/import\s+StudioContinuityReviewView\s+from/u);
    expect(material).toContain('v-else-if="activeMode === \'binding\'"');
    expect(material).toContain('v-else-if="activeMode === \'continuity-review\'"');
    expect(material).toContain('id="studio-continuity-review-pane"');
    expect(material).toContain('data-testid="studio-mode-dashboard"');
    expect(controlView).not.toContain("onMounted(");
  });

  it("UI 读取 Core nextAction 与有界分页，审片只经 command bus owner 写回", async () => {
    const [app, controlView, store] = await Promise.all([
      source("src/renderer/src/App.vue"),
      source("src/renderer/src/components/StudioContinuityReviewView.vue"),
      source("src/renderer/src/studio-continuity-review-store.ts"),
    ]);
    const adapterStart = app.indexOf("const studioContinuityReviewApi");
    const adapterEnd = app.indexOf("const materialStudioApi", adapterStart);
    const adapter = app.slice(adapterStart, adapterEnd);
    expect(adapter.match(/window\.canvasApi\.getStudioContinuityReviewControl\(/gu)).toHaveLength(1);
    expect(adapter).toContain("executeStudioCommand");
    expect(adapter).toContain('command: "submit_studio_generation_review"');
    expect(adapter).toContain('reviewer: "user" as const');
    expect(store).toContain('Omit<SubmitStudioGenerationReviewInput, "operationId">');
    expect(controlView).not.toMatch(/operationId\s*:/u);
    expect(controlView).toContain("loadState.control.nextAction.label");
    expect(controlView).toContain("loadState.control.nextAction.reason");
    expect(controlView).not.toContain("executeStudioCommand");
    expect(controlView).toContain("api.submitReview");
    expect(controlView).toContain("请从宫格或结果节点打开审片");
    expect(controlView).toContain("<details class=\"diagnostic-details\">");
    expect(store).toContain("STUDIO_CONTINUITY_REVIEW_UI_ASSET_LIMIT = 6");
    expect(store).toContain("STUDIO_CONTINUITY_REVIEW_UI_TIMELINE_LIMIT = 18");
    expect(store).toContain("STUDIO_CONTINUITY_REVIEW_UI_HISTORY_LIMIT = 12");
    expect(store).not.toMatch(/nextAction\s*[:=]/u);
  });

  it("raw/labeled 必须均完成浏览器解码，失败或迟到请求不能提交或覆盖当前工程", async () => {
    const controlView = await source("src/renderer/src/components/StudioContinuityReviewView.vue");
    expect(parse(controlView, { filename: "StudioContinuityReviewView.vue" }).errors).toEqual([]);
    for (const marker of [
      "await image.decode()",
      "image.naturalWidth < 1",
      "image.naturalHeight < 1",
      "reviewMedia.rawDecoded",
      "reviewMedia.labeledDecoded",
      "当前 Review 缺少可核验的 raw/labeled 成对身份，已禁止提交",
      "原尺寸查看",
      "openOriginalPreview",
      "isCurrentMediaRequest",
      "isCurrentReviewSubmission",
      "const projectRoot = props.projectRoot",
      "const generationRunId = focus.generationRunId",
    ]) expect(controlView).toContain(marker);
    expect(controlView).toContain(':disabled="reviewSubmitting || !reviewPairReady || !reviewNote.trim() || incompleteDraftCount > 0"');
    expect(controlView).toContain("if (!reviewPairReady.value || !note) return");
    expect(controlView).toContain("reviewSubmissionSequence += 1");
    expect(controlView).toContain("invalidateReviewMedia()");
    expect(controlView).not.toContain("人工原尺寸对比 raw/labeled 通过");
    expect(controlView).not.toMatch(/props\.api\.submitReview\(props\.projectRoot/u);
  });
});
