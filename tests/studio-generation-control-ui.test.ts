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

describe("正式生图页列表视口剔除", () => {
  it("unit-rail 与 panel-list 行使用 content-visibility，离屏单元/宫格跳过同步布局", () => {
    const view = read("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(view).toContain(".unit-rail>button{width:100%;display:grid;gap:5px;padding:11px 14px;border:0;border-bottom:1px solid var(--ui-line);background:transparent;color:var(--ui-text-2);text-align:left;cursor:pointer;content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(view).toContain(".panel-list>button{min-height:96px;display:grid;grid-template-columns:30px 1fr;align-items:start;gap:9px;padding:14px;border:0;border-right:1px solid var(--ui-line);border-bottom:1px solid var(--ui-line);background:var(--ui-bg);color:var(--ui-text-2);text-align:left;cursor:pointer;content-visibility:auto;contain-intrinsic-size:auto 96px}");
    expect(view).not.toMatch(/\.unit-rail>button\{[^}]*content-visibility:hidden/);
    expect(view).not.toMatch(/\.panel-list>button\{[^}]*content-visibility:hidden/);
  });

  it("plan-node 使用 content-visibility，离屏计划节点跳过同步布局", () => {
    const view = read("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(view).toContain('v-for="node in group.nodes"');
    expect(view).toContain(".generation-plans{border-bottom:1px solid var(--ui-line);background:var(--ui-surface);max-height:220px;overflow:auto}");
    expect(view).toContain(
      ".plan-node{display:grid;grid-template-columns:110px minmax(0,1fr) auto;gap:10px;align-items:center;padding:5px 18px;content-visibility:auto;contain-intrinsic-size:auto 32px}",
    );
    expect(view).not.toMatch(/\.plan-node\{[^}]*content-visibility:hidden/);
    expect(view).not.toMatch(/\.result-row\{[^}]*content-visibility/);
  });
});

describe("正式生图页 Higgsfield 图片排队", () => {
  it("queueHiggsfieldImage 在 generationActionsBlocked 时 fail-closed：不能边核验未知节点边排队", () => {
    const view = read("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(view).toContain(':disabled="loading || higgsfieldQueueBusy || !generationProjectionCurrent || generationActionsBlocked || isUnknownBlockedNode(node)"');
    expect(view).toContain("正在处理，不能再用 Higgsfield 排队");
    const start = view.indexOf("async function queueHiggsfieldImage(");
    const end = view.indexOf("async function nextUnits()", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = view.slice(start, end);
    expect(handler).toContain("if (higgsfieldQueueBusy.value || generationActionsBlocked.value || node.status !== \"dispatched\" || isUnknownBlockedNode(node)) return;");
    expect(handler.indexOf("generationActionsBlocked.value")).toBeLessThan(handler.indexOf("higgsfieldQueueBusy.value = true"));
  });
});

describe("正式生图页计划取消/重拍", () => {
  it("runPlanAction 在 confirm 前 fail-closed：actionBusy 挡住连点双对话框", () => {
    const view = read("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(view).toContain("正在处理，不能再取消该任务");
    expect(view).toContain("正在处理，不能再重拍节点");
    expect(view).toContain('@click="cancelNode(node)"');
    expect(view).toContain("@click=\"retryPlan(group.planId)\"");
    expect(view).toContain("@click=\"retryPlan(group.planId, node.nodeIndex)\"");
    const start = view.indexOf("async function runPlanAction(");
    const end = view.indexOf("function cancelNode(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = view.slice(start, end);
    expect(handler).toContain("if (actionBusy.value) return;");
    expect(handler).toContain("window.confirm(confirmText)");
    expect(handler.indexOf("if (actionBusy.value) return;")).toBeLessThan(handler.indexOf("window.confirm(confirmText)"));
    expect(handler.indexOf("if (actionBusy.value) return;")).toBeLessThan(handler.indexOf("actionBusy.value = request.command"));
  });
});

describe("正式生图页锁版光线服化与场景回指", () => {
  it("无冻结包才退锁版光线服化，有包仍只认覆盖行；场景回指点穿不猜第一格", () => {
    const view = read("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(view).toContain('data-testid="studio-lock-lighting"');
    expect(view).toContain('data-testid="studio-lock-costume"');
    expect(view).toContain('data-testid="studio-control-scene-backrefs"');
    expect(view).toContain('data-testid="studio-control-prop-backrefs"');
    expect(view).toContain("getStudioUnitLockOverlays");
    expect(view).toContain("getStudioSceneBackReferences");
    expect(view).toContain("formatUnitLockPanelLightingLine");
    expect(view).toContain("formatUnitLockPanelCostumeLine");
    expect(view).toContain("revealControlSceneBackRef");
    expect(view).toContain("lightingCostumeSource.value = \"frozen-rendered-prompt\"");
    expect(view).toContain("lightingCostumeSource.value = \"unit-lock\"");
    expect(view).toContain("禁止猜第一格");
    expect(view).not.toContain("studio-unit-lock-overlays-read");
    expect(view).not.toContain("studio-scene-backrefs-read");
    expect(view).not.toContain("evaluateStudioConsistency");
    expect(view).not.toContain("getStudioBindingControl");
    const revealStart = view.indexOf("async function revealControlSceneBackRef(");
    const revealEnd = view.indexOf("function resetHistoryPagination(", revealStart);
    expect(revealStart).toBeGreaterThan(-1);
    expect(revealEnd).toBeGreaterThan(revealStart);
    const reveal = view.slice(revealStart, revealEnd);
    expect(reveal).toContain("next.panels.some((panel) => panel.id === panelId)");
    expect(reveal).not.toContain("panels[0]");
    expect(reveal).not.toContain("pickFirstCoveredPanel");
    const switchStart = view.indexOf("watch(() => props.projectRoot,");
    const afterDetailNull = view.indexOf("detail.value = null;", switchStart);
    expect(afterDetailNull).toBeGreaterThan(switchStart);
    expect(view.indexOf("clearControlLockOverlayCache();", afterDetailNull)).toBeGreaterThan(afterDetailNull);
  });
});
