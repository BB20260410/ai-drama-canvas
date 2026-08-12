import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("同根冷启动 reconcile 桌面路由", () => {
  it("先用只读 activation 快照启动 reconcile，并在提交受管 UI 前等待它；legacy 路径保持显式 activate", () => {
    const app = source("src/renderer/src/App.vue");
    const preload = source("src/preload/index.ts");
    const main = source("src/main/index.ts");
    const startupStart = app.indexOf("onMounted(async () =>");
    const startupEnd = app.indexOf("onBeforeUnmount", startupStart);
    const startup = app.slice(startupStart, startupEnd);
    expect(preload).toContain("reconcileActiveManagedProjectStartup");
    expect(main).toContain('"canvas:reconcile-active-managed-project-startup"');
    expect(startup).toContain("const startupReconcilePromise =");
    expect(startup).toContain("app-startup-reconcile-start");
    expect(startup).toContain("app-startup-reconcile-ready");
    expect(startup).toContain("app-dashboard-units-prefetch-start");
    expect(startup).toContain("studioDashboardApi.getDashboard(activeProject.primaryRoot");
    expect(startup).toContain('operation: "units"');
    expect(startup).toContain("limit: 36");
    expect(startup.indexOf("app-startup-reconcile-ready")).toBeLessThan(
      startup.indexOf("app-dashboard-units-prefetch-start"),
    );
    const bootstrapAwaitStart = startup.indexOf("const [activeProject, registeredProjects");
    const bootstrapAwaitEnd = startup.indexOf("]);", bootstrapAwaitStart);
    const bootstrapAwait = startup.slice(bootstrapAwaitStart, bootstrapAwaitEnd);
    expect(bootstrapAwait).toContain("startupReconcilePromise,");
    expect(bootstrapAwaitEnd).toBeLessThan(startup.indexOf("managedShell.value = startupShell"));
    const legacyBranch = startup.slice(startup.indexOf("} else {", startup.indexOf("const startupRoot")));
    expect(startup).toContain("await window.canvasApi.activateProject(startupRoot)");
    expect(legacyBranch).not.toContain("reconcileActiveManagedProjectStartup");
  });
});
