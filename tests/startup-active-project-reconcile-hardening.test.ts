import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runtimeIpcEffect, runtimeIpcGateMode } from "../src/core/runtime-ipc-effect.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("startup reconcile review hardening", () => {
  it("v2/managed-required 工程缺少 shell 时必须失败关闭，不能走 legacy 读取、监听或 activate", () => {
    const app = source("src/renderer/src/App.vue");
    const startupStart = app.indexOf("const startupReconcilePromise =");
    const startup = app.slice(startupStart, app.indexOf("onBeforeUnmount", startupStart));
    expect(startup).toContain("managedStartupRequired");
    expect(startup).toContain("受管工程 shell 不可读");
    const managedFallback = startup.slice(startup.indexOf("const startupShell ="), startup.indexOf("} else {", startup.indexOf("const startupShell =")));
    expect(managedFallback).not.toContain("loadIndex(false");
    expect(managedFallback).not.toContain("startWatch(startupRoot)");
    expect(managedFallback).not.toContain("activateProject(startupRoot)");
  });

  it("恢复副本校验从纯 shell 读取中拆出为强门禁 mutation，并绑定 pending 的 exact root", () => {
    const main = source("src/main/index.ts");
    const preload = source("src/preload/index.ts");
    const app = source("src/renderer/src/App.vue");
    const shellStart = main.indexOf('ipcMain.handle("canvas:get-managed-project-shell"');
    const shellEnd = main.indexOf('ipcMain.handle("canvas:validate-restored-managed-project-shell"', shellStart);
    const shellHandler = main.slice(shellStart, shellEnd);
    expect(shellHandler).not.toContain("pendingRestoredProjects");
    expect(main).toContain('ipcMain.handle("canvas:validate-restored-managed-project-shell"');
    expect(main).toContain("pending.projectRoot !== absoluteRoot");
    expect(preload).toContain("validateRestoredManagedProjectShell");
    expect(app).toContain("validateRestoredManagedProjectShell(targetRoot)");
    expect(runtimeIpcEffect("canvas:validate-restored-managed-project-shell")).toBe("mutation");
    expect(runtimeIpcGateMode("canvas:validate-restored-managed-project-shell")).toBe("strong");
  });

  it("恢复校验只在离开确认与切换所有权之后发生；失败释放 pending 以便重试", () => {
    const main = source("src/main/index.ts");
    const preload = source("src/preload/index.ts");
    const app = source("src/renderer/src/App.vue");
    const openStart = app.indexOf("async function openProject(");
    const openEnd = app.indexOf("async function removeProject", openStart);
    const openProject = app.slice(openStart, openEnd);
    const restoredStart = app.indexOf("async function openRestoredProject");
    const restoredEnd = app.indexOf("async function persistStudioContext", restoredStart);
    const restored = app.slice(restoredStart, restoredEnd);
    expect(restored).not.toContain("validateRestoredManagedProjectShell");
    expect(restored).toContain('validateRestoredManagedProject: true');
    expect(openProject.indexOf("requestActiveWorkspaceLeave(\"project_switch\")")).toBeLessThan(
      openProject.indexOf("validateRestoredManagedProjectShell(targetRoot)"),
    );
    expect(openProject.indexOf("projectSwitching.value = true")).toBeLessThan(
      openProject.indexOf("validateRestoredManagedProjectShell(targetRoot)"),
    );
    expect(openProject).toContain("releaseRestoredManagedProjectShellValidation(targetRoot)");
    expect(main).toContain('ipcMain.handle("canvas:release-restored-managed-project-shell-validation"');
    expect(main).toContain("pendingRestoredProjects.delete(root);");
    expect(preload).toContain("releaseRestoredManagedProjectShellValidation");
    expect(runtimeIpcEffect("canvas:release-restored-managed-project-shell-validation")).toBe("mutation");
    expect(runtimeIpcGateMode("canvas:release-restored-managed-project-shell-validation")).toBe("strong");
  });

  it("persistStudioContext 在途合并最新焦点，不并行写 sidecar", () => {
    const app = source("src/renderer/src/App.vue");
    expect(app).toContain("const persistStudioContextBusy = ref(false);");
    const start = app.indexOf("async function persistStudioContext(");
    const end = app.indexOf("async function onProjectDrop(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = app.slice(start, end);
    expect(body).toContain("pendingStudioContext = context;");
    expect(body).toContain("if (persistStudioContextBusy.value || projectSwitching.value || projectRemovingRoot.value) return;");
    expect(body).toContain("while (pendingStudioContext)");
    expect(body.indexOf("persistStudioContextBusy.value = true")).toBeLessThan(
      body.indexOf("await window.canvasApi.setActiveStudioContext"),
    );
    expect(body.indexOf("if (persistStudioContextBusy.value || projectSwitching.value || projectRemovingRoot.value) return;")).toBeLessThan(
      body.indexOf("persistStudioContextBusy.value = true"),
    );
    expect(body).toContain("void persistStudioContext(pendingStudioContext);");
  });

  it("启动把 reconcile 和 workspace 偏好先准备为局部变量，再一次性提交受管 UI", () => {
    const app = source("src/renderer/src/App.vue");
    const startupStart = app.indexOf("const startupReconcilePromise =");
    const startup = app.slice(startupStart, app.indexOf("onBeforeUnmount", startupStart));
    expect(startup).toContain("const startupWorkspaceView =");
    expect(startup.indexOf("await startupManagedShell.workspaceViewPromise")).toBeLessThan(
      startup.indexOf("projectRoot.value = startupRoot"),
    );
    expect(startup.indexOf("projectRoot.value = startupRoot")).toBeLessThan(
      startup.indexOf("managedShell.value = startupShell"),
    );
    expect(app).toContain("void workspaceViewPromise.catch(() => undefined)");
  });

  it("冷启动 reconcile 只持有 project-registry 锁，仍保留首尾 root+activationId CAS 与兼容修复", () => {
    const sidecar = source("src/core/sidecar.ts");
    const reconcileStart = sidecar.indexOf("export async function reconcileActiveProjectStartup");
    const reconcileEnd = sidecar.indexOf("/**\n * 在同一注册表锁内执行调用方的只读冲突门", reconcileStart);
    const reconcile = sidecar.slice(reconcileStart, reconcileEnd);
    expect(reconcile).toContain("return withRegistryLock(registryPath, async () => {");
    expect(reconcile).not.toContain("withActiveProjectActivationFence");
    expect(reconcile.match(/assertExpected\(await readActiveProjectStateWithPreferences\(\)\)/gu)).toHaveLength(2);
    expect(reconcile).toContain("repairLegacyV2RegistryLeaksUnderLock(");
  });
});
