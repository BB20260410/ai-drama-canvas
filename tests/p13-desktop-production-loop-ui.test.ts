import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

function expectRenderedMarkerOnlyInsideCollapsedDetails(file: string, marker: string): void {
  const template = parse(file).descriptor.template?.content ?? "";
  let cursor = 0;
  let found = false;
  while ((cursor = template.indexOf(marker, cursor)) >= 0) {
    found = true;
    expect(template.lastIndexOf("<details", cursor)).toBeGreaterThan(template.lastIndexOf("</details>", cursor));
    cursor += marker.length;
  }
  expect(found).toBe(true);
  expect(template).not.toContain("<details open");
}

describe("P13 零说明桌面生产闭环 UI", () => {
  it("首次启动只呈现新建、最近与导入三条业务入口，且不猜测首个注册工程", () => {
    const app = source("src/renderer/src/App.vue");
    expect(parse(app, { filename: "App.vue" }).errors).toEqual([]);
    for (const marker of [
      'data-testid="first-run-create"',
      'data-testid="first-run-recent"',
      'data-testid="first-run-import"',
      "新建短剧工程",
      "打开最近工程",
      "导入已有工程",
    ]) expect(app).toContain(marker);
    expect(app).toContain("启动只恢复显式活动项目；缺失/不可用时不猜测项目列表第一项");
    expect(app).not.toMatch(/openMaterialStudio\(projects\.value\[0\]/u);
  });

  it("项目切换先完成新工程预检、监听和活动登记，再一次性提交 UI，失败恢复旧工程", () => {
    const app = source("src/renderer/src/App.vue");
    expect(parse(app, { filename: "App.vue" }).errors).toEqual([]);
    const openStart = app.indexOf("async function openProject(next:");
    const openEnd = app.indexOf("async function removeProject", openStart);
    const openProject = app.slice(openStart, openEnd);
    expect(openProject).toContain("if (projectSwitching.value)");
    expect(openProject).toContain("const generation = ++projectSwitchGeneration");
    expect(openProject).toContain("const snapshot = captureProjectUiSnapshot()");
    expect(openProject).toContain("const invalidated = invalidateLegacyProjectAsyncState()");
    expect(openProject.indexOf("stageProjectUi(targetRoot")).toBeLessThan(openProject.indexOf("startWatch(targetRoot)"));
    expect(openProject.indexOf("startWatch(targetRoot)")).toBeLessThan(openProject.indexOf("activateProject(targetRoot)"));
    expect(openProject.indexOf("activateProject(targetRoot)")).toBeLessThan(openProject.indexOf("commitProjectUi(staged, generation, epoch)"));
    for (const marker of [
      "stopWatch(targetRoot)",
      "startWatch(snapshot.projectRoot)",
      "activateProject(activeProjectBefore.primaryRoot)",
      "restoreProjectUiSnapshot(snapshot)",
      "项目切换失败，已保留原工程",
    ]) expect(openProject).toContain(marker);
    expect(app).toContain(':switching="projectSwitching"');
    expect(app).toContain("updated.project.primaryRoot !== projectRoot.value");
  });

  it("打开最近工程优先显式活动登记，受管底部时间线跟随 Core 下一动作定位", () => {
    const app = source("src/renderer/src/App.vue");
    const recentStart = app.indexOf("async function openMostRecentProject");
    const recentEnd = app.indexOf("async function chooseManagedParentRoot", recentStart);
    const recent = app.slice(recentStart, recentEnd);
    expect(recent).toContain("getActiveProject()");
    expect(recent).toContain("activeProject?.available");
    expect(recent).toMatch(/const recent = activeProject\?\.available\s*\? activeProject\s*:/u);
    expect(app).toContain("dashboardOverview.nextAction.locator?.unitId");
    expect(app).toContain('operation: "unit"');
    expect(app).toContain("materialTimelineStatus(panel.status)");
    expect(app).toContain("studioPanelStatusLabel(panel.status)");
    expect(app).not.toContain("completedUnitCount: 0");
    expect(app).not.toContain('listStudioProductionUnits(root, { limit: 1 })');
  });

  it("项目中心忙碌期锁住关闭和破坏性入口，不可用登记仍可键盘确认移除", () => {
    const center = source("src/renderer/src/components/ProjectCenter.vue");
    const template = parse(center, { filename: "ProjectCenter.vue" }).descriptor.template?.content ?? "";
    expect(parse(center, { filename: "ProjectCenter.vue" }).errors).toEqual([]);
    for (const marker of [
      'role="dialog"',
      'aria-modal="true"',
      '@keydown.esc.stop.prevent="requestClose"',
      ':aria-busy="busy"',
      'role="status"',
      'class="project-open"',
      'class="row-action"',
      "removeConfirmationRoot",
      "确认移除",
      "dialogElement.value?.focus",
    ]) expect(center).toContain(marker);
    expect(center).toContain("if (busy.value) return");
    expect(template).not.toMatch(/<button[\s\S]{0,120}class="project-row"/u);
    expect(template).toMatch(/<button[\s\S]{0,180}class="row-action"/u);
    expect(template).toContain(':disabled="busy || !project.available"');
    expect(template).toContain(':disabled="busy"');
  });

  it("固定剧本到审片五步流程，并由 Core nextAction 驱动唯一继续按钮", () => {
    const material = source("src/renderer/src/components/MaterialStudioView.vue");
    expect(parse(material, { filename: "MaterialStudioView.vue" }).errors).toEqual([]);
    for (const marker of ["1 剧本", "2 资产", "3 绑定", "4 生成", "5 审片", 'data-testid="studio-continue-action"']) {
      expect(material).toContain(marker);
    }
    expect(material).toContain("overview.value?.nextActionControl");
    expect(material).not.toMatch(/nextAction\s*=\s*computed/u);
  });

  it("画布结果链是真实 ledger 投影并可一键打开审片，不运行演示态计时器", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    for (const marker of [
      "listStudioGenerationPanelHistory",
      "getStudioGenerationReviewControl",
      'kind: "raw"',
      'kind: "labeled"',
      'kind: "review"',
      "openPanelReview",
      'emit("requestGeneration"',
    ]) expect(canvas).toContain(marker);
    expect(canvas).not.toMatch(/setTimeout\([\s\S]{0,300}(?:生成完成|演示态|假装)/u);
    expect(canvas).toMatch(/\.flow-shell\s*\{[^}]*overflow:\s*hidden;[^}]*isolation:\s*isolate;/u);
    expect(canvas).toContain('const studioFlow = useVueFlow("managed-studio-flow")');
    expect(canvas).toContain('node.id === `media:labeled:${focusPanelId}`');
    expect(canvas).toContain("await studioFlow.setCenter");
  });

  it("普通界面隐藏技术字段，备份恢复与 Agent 连接集中在支持页", () => {
    const support = source("src/renderer/src/components/DesktopSupportView.vue");
    const review = source("src/renderer/src/components/StudioContinuityReviewView.vue");
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const material = source("src/renderer/src/components/MaterialStudioView.vue");
    expect(parse(support, { filename: "DesktopSupportView.vue" }).errors).toEqual([]);
    expect(parse(review, { filename: "StudioContinuityReviewView.vue" }).errors).toEqual([]);
    for (const marker of ["Agent 连接", "备份当前工程", "恢复到新目录", "诊断详情（高级）"]) expect(support).toContain(marker);
    expect(review).toContain('data-testid="continuity-business-empty"');
    expect(review).toContain("请从宫格或结果节点打开审片");
    expect(review).toContain("<details class=\"diagnostic-details\">");
    expect(review).not.toContain("<details open");
    // P26：检查器已拆分为 CanvasInspectorPanel.vue，标记随子组件迁移（仍在折叠 details 内）。
    const inspectorPanel = source("src/renderer/src/components/CanvasInspectorPanel.vue");
    for (const marker of ["{{ selection.asset.id }}", "{{ selection.doc.id }}", "{{ selection.asset.revision }}", "{{ selection.doc.revision }}"]) {
      expectRenderedMarkerOnlyInsideCollapsedDetails(inspectorPanel, marker);
    }
    for (const marker of ["{{ loadState.control.nextAction.command }}", "{{ asset.assetId }}", "{{ conflict.subjectId }}", "{{ loadState.control.review.control.headRevision }}"]) {
      expectRenderedMarkerOnlyInsideCollapsedDetails(review, marker);
    }
    for (const marker of ["{{ detail.id }}", "{{ detail.revision }}", "detail.textDocument.bodySha256", "{{ detail.prompt.positive }}", "{{ detail.prompt.negative }}", "{{ relation.id }}"]) {
      expectRenderedMarkerOnlyInsideCollapsedDetails(material, marker);
    }
    expect(material).not.toContain("原媒体按 SHA-256 存放");
    expect(material).not.toContain("搜索媒体名、类型或 SHA");
  });

  it("Codex 可在没有 Grok 时独立检查和修复，备份恢复互斥且采用桌面验证后的两阶段激活", () => {
    const support = source("src/renderer/src/components/DesktopSupportView.vue");
    const main = source("src/main/index.ts");
    expect(parse(support, { filename: "DesktopSupportView.vue" }).errors).toEqual([]);
    for (const marker of [
      "GROK（可选）",
      "未安装 Grok 不影响 Codex",
      "if (busy.value) return",
      "data-testid=\"managed-project-operation-state\"",
      "等待选择备份保存目录",
      "等待选择恢复后的新目录",
      "sourceRoot",
      "targetPath",
      "requestSequence === statusSequence && props.projectRoot === projectRoot",
      "currentAction(sequence, projectRoot)",
    ]) expect(support).toContain(marker);
    expect(main).toContain('ipcMain.handle("canvas:get-managed-project-operation-state"');
    expect(main).toContain('webContents.send("canvas:managed-project-operation-state", next)');
    const preload = source("src/preload/index.ts");
    const app = source("src/renderer/src/App.vue");
    expect(preload).toContain("getManagedProjectOperationState");
    expect(preload).toContain("onManagedProjectOperationState");
    expect(support).not.toContain("ai-drama-canvas:managed-project-operation");
    expect(app).not.toContain("ai-drama-canvas:managed-project-operation");
    expect(app).toContain("applyManagedProjectOperationState(operationState)");
    expect(app).toContain("removeManagedProjectOperationListener?.()");
    expect(main).toContain("if (managedProjectOperationState.busy)");
    expect(main).toContain("const repairAvailable = Boolean(codexPath && serverAvailable)");
    expect(main).toContain("repairCodexConnectionOnly");
    expect(main).toContain("if (!codexPath) throw new Error");
    expect(main).not.toContain('if (!codexPath || !grokPath) throw new Error("必须先安装 Codex 与 Grok CLI');

    const restoreStart = main.indexOf('ipcMain.handle("canvas:restore-managed-project"');
    const restoreEnd = main.indexOf('ipcMain.handle("canvas:get-agent-connection-status"', restoreStart);
    const restoreHandler = main.slice(restoreStart, restoreEnd);
    expect(restoreHandler).toContain("pendingRestoredProjects.set");
    expect(restoreHandler).toContain("requireManagedStudioProject(restored.projectRoot)");
    expect(restoreHandler).toContain('phase: "running", busy: true');
    expect(restoreHandler).not.toContain("activateProject(restored.projectRoot)");
    expect(restoreHandler).not.toContain("registerProject(restoredShell.project)");

    const activateStart = main.indexOf('ipcMain.handle("canvas:activate-project"');
    const activateEnd = main.indexOf('ipcMain.handle("canvas:get-managed-project-shell"', activateStart);
    const activateHandler = main.slice(activateStart, activateEnd);
    expect(activateHandler).toContain("pending.rendererValidated");
    expect(activateHandler).toContain('phase: "succeeded"');
    expect(activateHandler).toContain('busy: false');
    const registrationIndex = activateHandler.indexOf("registerProject(restoredShell.project)");
    expect(registrationIndex).toBeGreaterThan(0);
    expect(registrationIndex).toBeLessThan(activateHandler.indexOf("activateProject(absoluteRoot)", registrationIndex));
    expect(activateHandler).toContain("removeProjectRegistration(absoluteRoot)");
    expect(activateHandler).toContain("activateProject(previousActive.primaryRoot)");
  });
});
