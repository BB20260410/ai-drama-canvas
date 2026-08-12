import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject } from "../src/core/managed-project.js";
import { activateProject } from "../src/core/service.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];
const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(workspace, relativePath), "utf8");
}

afterEach(async () => {
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P1 小说工作区桌面路由", () => {
  it("三种模式使用独立壳路由，hybrid 通过全局 sidecar 显式切换", async () => {
    const [app, center, novel, preload, main, ipcEffect] = await Promise.all([
      source("src/renderer/src/App.vue"),
      source("src/renderer/src/components/ProjectCenter.vue"),
      source("src/renderer/src/components/NovelStudioView.vue"),
      source("src/preload/index.ts"),
      source("src/main/index.ts"),
      source("src/core/runtime-ipc-effect.ts"),
    ]);

    expect(parse(app, { filename: "App.vue" }).errors).toEqual([]);
    expect(parse(center, { filename: "ProjectCenter.vue" }).errors).toEqual([]);
    expect(parse(novel, { filename: "NovelStudioView.vue" }).errors).toEqual([]);

    expect(app).toContain("const NovelStudioView = defineAsyncComponent");
    expect(app).toContain("managedWorkspaceView === 'drama'");
    expect(app).toContain('managedWorkspaceView.value !== "novel"');
    expect(app).toContain("getActiveHybridWorkspacePreference");
    expect(app).toContain("setActiveHybridWorkspacePreference");
    expect(app).toContain('ref="novelStudioRef"');
    expect(app).toContain(':key="novelStudioProject.projectRoot"');
    expect(app).toContain('requestActiveWorkspaceLeave("workspace_switch")');
    expect(app).toContain('requestActiveWorkspaceLeave("project_switch")');
    expect(app).toContain('requestActiveWorkspaceLeave("window_close")');
    expect(app).toContain("await requestNovelStudioLeave(reason)");
    expect(app).toContain("await requestVideoEditorLeave(reason)");
    expect(app).toContain("onWindowCloseRequested");
    expect(app).toContain("respondToWindowClose");
    expect(app).toContain('next === "novel" ? "已切换到小说创作');
    expect(app).not.toContain("localStorage");

    for (const mode of ["drama", "novel", "hybrid"] as const) {
      expect(center).toContain(`{ mode: "${mode}"`);
    }
    expect(center).toContain("`managed-workspace-mode-${option.mode}`");
    expect(center).toContain('VITE_AI_CANVAS_NOVEL_WORKSPACE !== "0"');
    expect(center).toContain('createDraft.workspaceMode === "drama"');
    expect(center).toContain("? validated.input");

    for (const bridge of [preload, main]) {
      expect(bridge).toContain("canvas:get-active-hybrid-workspace-preference");
      expect(bridge).toContain("canvas:set-active-hybrid-workspace-preference");
    }
    expect(preload).toContain("canvas:window-close-requested");
    expect(preload).toContain("canvas:window-close-response");
    expect(main).toContain("pendingRendererCloseRequest");
    expect(main).toContain("event.sender.id !== pending.webContentsId");
    expect(main).toContain("rendererWindowCloseApproved");
    expect(main).toContain("quitAfterRendererApproval");
    expect(app.indexOf('await requestActiveWorkspaceLeave("project_switch")'))
      .toBeLessThan(app.indexOf("const invalidated = invalidateLegacyProjectAsyncState()", app.indexOf("async function openProject")));
    const refreshStart = app.indexOf("async function refreshNovelStudio");
    expect(app.indexOf('await requestActiveWorkspaceLeave("workspace_switch")', refreshStart))
      .toBeLessThan(app.indexOf("managedShell.value = refreshed", refreshStart));
    expect(ipcEffect).toContain('"canvas:get-active-hybrid-workspace-preference"');
    expect(ipcEffect).toContain('"canvas:get-managed-project-shell"');
    expect(main).toContain("return getManagedProjectShell(absoluteRoot);");
    expect(main).toContain("await inspectManagedProjectReadOnly(resolvedRoot);");
  });

  it("保持 Material Studio owner，并延迟非素材库首屏分页读取", async () => {
    const material = await source("src/renderer/src/components/MaterialStudioView.vue");
    expect(parse(material, { filename: "MaterialStudioView.vue" }).errors).toEqual([]);
    expect(material).toContain('data-testid="material-studio-view"');
    expect(material).toContain('activeMode.value === "library"');
    expect(material).toContain("currentLibraryRefreshPending.value = true");
    expect(material).toContain("默认无限画布首屏只读取 overview");
    expect(material).not.toContain("localStorage");
  });

  it("future managed manifest 在全局活动指针写入前失败关闭", async () => {
    const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "ai-canvas-p1-route-"));
    temporaryRoots.push(root);
    const registryPath = path.join(root, "registry", "projects.json");
    process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
    const parent = path.join(root, "projects");
    await mkdir(parent, { recursive: true });

    const drama = await createManagedProject({ parentRoot: parent, name: "Drama" });
    const future = await createManagedProject({ parentRoot: parent, name: "Future", workspaceMode: "hybrid" });
    await registerProject(drama.project);
    await registerProject(future.project);
    await setActiveProjectRegistration(drama.paths.root);

    const activePath = path.join(path.dirname(registryPath), "active-project.json");
    const before = await readFile(activePath);
    const manifest = JSON.parse(await readFile(future.paths.manifest, "utf8")) as Record<string, unknown>;
    manifest.schemaVersion = 99;
    manifest.minimumWriterSchemaVersion = 99;
    await writeFile(future.paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(activateProject(future.paths.root)).rejects.toThrow(/高于当前 writer/);
    expect(await readFile(activePath)).toEqual(before);
  });
});
