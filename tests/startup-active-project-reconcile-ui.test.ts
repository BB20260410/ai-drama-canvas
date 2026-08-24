import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("同根冷启动 reconcile 桌面路由", () => {
  it("先走只读 preflight；仅 repair-required 才调用 strong reconcile，并在提交受管 UI 前等待它；legacy 路径保持显式 activate", () => {
    const app = source("src/renderer/src/App.vue");
    const preload = source("src/preload/index.ts");
    const main = source("src/main/index.ts");
    const startupStart = app.indexOf("onMounted(async () =>");
    const startupEnd = app.indexOf("onBeforeUnmount", startupStart);
    const startup = app.slice(startupStart, startupEnd);
    expect(preload).toContain("preflightActiveManagedProjectStartup");
    expect(main).toContain('"canvas:preflight-active-managed-project-startup"');
    expect(preload).toContain("reconcileActiveManagedProjectStartup");
    expect(main).toContain('"canvas:reconcile-active-managed-project-startup"');
    expect(startup).toContain("const startupReconcilePromise =");
    expect(startup).toContain("app-startup-reconcile-start");
    expect(startup).toContain("app-startup-reconcile-ready");
    expect(startup).toContain("const preflight = await window.canvasApi.preflightActiveManagedProjectStartup");
    expect(startup).toContain('if (preflight.kind === "healthy")');
    expect(startup).toContain('else if (preflight.kind === "repair-required")');
    expect(startup).toContain("throw new Error(\"受管工程启动预检返回未知状态");
    const healthyBranch = startup.slice(
      startup.indexOf('if (preflight.kind === "healthy")'),
      startup.indexOf('else if (preflight.kind === "repair-required")'),
    );
    expect(healthyBranch).toContain("shell = preflight.shell");
    expect(healthyBranch).not.toContain("reconcileActiveManagedProjectStartup");
    expect(startup).toContain("错误、未知或 manifest/CAS 漂移绝不回退为写路径");
    expect(startup).toContain("app-dashboard-units-prefetch-start");
    expect(startup).toContain("studioDashboardApi.getDashboard(activeProject.primaryRoot");
    expect(startup).toContain('operation: "units"');
    expect(startup).toContain("limit: 36");
    // units 是纯读取，可与 CAS 对账并行；不得把 prefetch 重新串回 reconcile-ready 之后。
    expect(startup.indexOf("app-dashboard-units-prefetch-start")).toBeLessThan(
      startup.indexOf("app-startup-reconcile-ready"),
    );
    expect(startup).toContain("units 是纯读取，可与 CAS 对账并行");
    const bootstrapAwaitStart = startup.indexOf("const [activeProject, registeredProjects");
    const bootstrapAwaitEnd = startup.indexOf("]);", bootstrapAwaitStart);
    const bootstrapAwait = startup.slice(bootstrapAwaitStart, bootstrapAwaitEnd);
    expect(bootstrapAwait).toContain("startupReconcilePromise,");
    expect(bootstrapAwaitEnd).toBeLessThan(startup.indexOf("managedShell.value = startupShell"));
    const legacyBranch = startup.slice(startup.indexOf("} else {", startup.indexOf("const startupRoot")));
    expect(startup).toContain("await window.canvasApi.activateProject(startupRoot)");
    expect(legacyBranch).not.toContain("reconcileActiveManagedProjectStartup");
  });

  it("write-gate allowed 后仍不得把 first-card 受管 UI 挂到未经 CAS 的 shell 上", () => {
    const app = source("src/renderer/src/App.vue");
    const smoke = source("scripts/t23-scale-performance-dev-smoke.ts");
    const startupStart = app.indexOf("onMounted(async () =>");
    const startupEnd = app.indexOf("onBeforeUnmount", startupStart);
    const startup = app.slice(startupStart, startupEnd);
    const publishStart = startup.indexOf("projectRoot.value = startupRoot");
    const publish = startup.slice(publishStart, startup.indexOf("} else {", publishStart));
    expect(startup).toContain("reconcile 与工作区偏好均已完成后再一次性发布受管 UI");
    expect(startup.indexOf("startupReconcilePromise,")).toBeLessThan(publishStart);
    expect(publish).toContain("managedShell.value = startupShell");
    expect(publish).toContain('activeView.value = "studio"');
    expect(publish).not.toContain("reconcileActiveManagedProjectStartup");
    expect(smoke).toContain('["app-startup-reconcile-ready", "canvas-mounted"]');
    expect(smoke).toContain('["canvas-units-ready", "canvas-first-card-dom-ready"]');
  });

  it("健康快路在首卡后独立做强 CAS watcher 生命周期，不能污染 preflight 或阻塞首卡", () => {
    const app = source("src/renderer/src/App.vue");
    const material = source("src/renderer/src/components/MaterialStudioView.vue");
    const preload = source("src/preload/index.ts");
    const main = source("src/main/index.ts");
    const smoke = source("scripts/t23-scale-performance-dev-smoke.ts");
    expect(material).toContain('emit("initialUnitCardsCommitted", {');
    expect(material).toContain("startupMutationChecks: payload.startupMutationChecks");
    expect(app).toContain('@initial-unit-cards-committed="onManagedInitialUnitCardsCommitted"');
    const lifecycle = app.slice(
      app.indexOf("function onManagedInitialUnitCardsCommitted"),
      app.indexOf("async function refreshProjects", app.indexOf("function onManagedInitialUnitCardsCommitted")),
    );
    expect(lifecycle).toContain("void (async () => {");
    expect(lifecycle).toContain("ensureActiveManagedProjectGenerationWatcher");
    expect(lifecycle).toContain("app-generation-watcher-lifecycle-ready");
    expect(lifecycle).not.toContain("getRuntimeWriteGate");
    expect(preload).toContain("ensureActiveManagedProjectGenerationWatcher");
    const lifecycleHandler = main.slice(
      main.indexOf('ipcMain.handle("canvas:ensure-active-managed-project-generation-watcher"'),
      main.indexOf('ipcMain.handle("canvas:reconcile-active-managed-project-startup"'),
    );
    expect(lifecycleHandler).toContain("reconcileActiveManagedProjectStartupWithLifecycle(");
    expect(lifecycleHandler).toContain("async (confirmed) => ensureStudioGenerationLedgerWatcher(confirmed.paths.root)");
    const legacyReconcileHandlerStart = main.indexOf('ipcMain.handle("canvas:reconcile-active-managed-project-startup"');
    const legacyReconcileHandler = main.slice(
      legacyReconcileHandlerStart,
      main.indexOf('ipcMain.handle("canvas:activate-project"', legacyReconcileHandlerStart),
    );
    expect(legacyReconcileHandler).toContain("}) => reconcileActiveManagedProjectStartup(input));");
    expect(legacyReconcileHandler).not.toContain("ensureStudioGenerationLedgerWatcher");
    expect(legacyReconcileHandler).not.toContain("console.warn");
    const activationHandler = main.slice(
      main.indexOf('ipcMain.handle("canvas:activate-project"'),
      main.indexOf('ipcMain.handle("canvas:open-project-center"', main.indexOf('ipcMain.handle("canvas:activate-project"')),
    );
    expect(activationHandler).toContain("const activated = await activateProject(absoluteRoot)");
    expect(activationHandler).toContain("generationLedgerWatchedRoot !== absoluteRoot");
    expect(activationHandler).toContain("await closeStudioGenerationLedgerWatcher()");
    expect(smoke).toContain("T23 首卡前 startup mutationChecks 被读取路径增加");
    expect(smoke).toContain("T23 首卡后的 watcher 生命周期时间线不完整或错误提前执行");
    const failureHandlerStart = smoke.indexOf("const rawError = error instanceof Error");
    const failureHandler = smoke.slice(failureHandlerStart, smoke.indexOf("} finally {", failureHandlerStart));
    expect(failureHandler).toContain("readRuntimeStartupGate(launched).catch(() => undefined)");
    expect(failureHandler).toContain("runtimeStartupGate: summarizeRuntimeStartupGate(runtimeStartupGate)");
    expect(smoke).toContain("function summarizeRuntimeStartupGate");
    expect(smoke).toContain("/^canvas:[a-z0-9-]+$/u.test(entry.channel)");
  });
});
