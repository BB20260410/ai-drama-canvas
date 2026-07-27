import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("受管 Studio 正式生图页", () => {
  it("素材中心只挂载正式 Studio 账本视图，不再挂旧 GenerationQueueView", () => {
    const material = read("src/renderer/src/components/MaterialStudioView.vue");
    expect(material).toContain("AsyncStudioGenerationControlView");
    expect(material).toContain("./StudioGenerationControlView.vue");
    expect(material).not.toContain("./GenerationQueueView.vue");
    expect(material).not.toContain("<AsyncGenerationQueueView");
  });

  it("正式页只读取受管账本和 Dashboard，不暴露网页/HTTP/Mock 供应商编辑", () => {
    const view = read("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(view).toContain("getStudioGenerationLedgerState");
    expect(view).toContain("listStudioGenerationPanelHistory");
    expect(view).toContain("getDashboard");
    expect(view).toContain("派发只表示本地已登记意图，图片尚未生成");
    expect(view).not.toMatch(/codex-browser|http-json|ComfyUI|Mock 验证|加入下一批/u);
  });

  it("继续按钮由 Core 动作驱动，缺少动作时禁用且不自动打开文件选择器", () => {
    const material = read("src/renderer/src/components/MaterialStudioView.vue");
    expect(material).toContain("!overview?.nextActionControl");
    expect(material).toContain("Core 尚未返回可执行的下一步");
    expect(material).toContain("请点击“导入剧本”选择文件");
    const continueBody = material.slice(
      material.indexOf("async function continueFromCore"),
      material.indexOf("function selectStudioMode"),
    );
    expect(continueBody).not.toContain("void importScript()");
  });

  it("generation_unknown 全量有界核验并用 dirty-loop 合并生成事件", () => {
    const view = read("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(view).toContain("loadDetachedUnknownNodeStates");
    expect(view).toContain("getStudioDetachedUnknownUnitStates(root, unitIds)");
    const progressBlock = view.slice(view.indexOf("async function loadProgress"), view.indexOf("function planNodeStatusLabel"));
    expect(progressBlock).not.toContain('operation: "detached-unknown"');
    expect(view).not.toContain("unitIds.slice(0, 100)");
    expect(view).toContain("createDebouncedDirtyRefreshLoop");
    expect(view).toContain("generationEventRefreshLoop.markDirty()");
    expect(view).toContain("ledgerLoadGate.isCurrent(loadSequence)");
    expect(view).toContain("historyLoadGate.isCurrent(loadSequence)");
    const eventHandler = view.slice(
      view.indexOf("unsubscribeProgress = window.canvasApi.onStudioGenerationProgress"),
      view.indexOf("onBeforeUnmount"),
    );
    expect(eventHandler).not.toContain("Promise.all([loadProgress");
    expect(eventHandler).not.toContain(".then(() => loadHistory");
  });
});
