import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("项目中心本机创作内容导入摘要", () => {
  it("显示真实性状态、覆盖量和实时来源变化，不把历史完成冒充当前完整", () => {
    const source = readFileSync(path.join(root, "src/renderer/src/components/ProjectCenter.vue"), "utf8");
    expect(parse(source, { filename: "ProjectCenter.vue" }).errors).toEqual([]);
    for (const marker of [
      "未导入",
      "导入中",
      "当前完整",
      "按策略部分接入",
      "来源已变化",
      "有失败",
      "待实时核验",
      "processedMedia",
      "eligibleMedia",
      "importedDocuments",
      "sourceDocuments",
      "pendingAssets",
      "源目录已变化",
      "来源待核验",
      "来源核验失败",
    ]) expect(source).toContain(marker);
    expect(source).toContain('data-testid="project-center-refresh-sources"');
    expect(source).toContain(":disabled=\"busy || refreshing\"");
    expect(source).toContain("刷新清单");
    expect(source).toContain("verifySource");
    expect(source).toContain("核验来源");
    expect(source).toContain("const SOURCE_REFRESH_INTERVAL_MS = 60_000");
    expect(source).not.toContain("setInterval(() => emit(\"refresh\"), 10_000)");
    expect(source).not.toContain("源快照已更新");
    const app = readFileSync(path.join(root, "src/renderer/src/App.vue"), "utf8");
    expect(parse(app, { filename: "App.vue" }).errors).toEqual([]);
    expect(app).toContain("createProjectListRefreshController");
    expect(app).toContain("projectListRefreshController.requestList()");
    expect(app).toContain("projectListRefreshController.verifySource(sourceProjectRoot)");
    expect(app).toContain("requestProjectList()");
    expect(app).not.toContain("await window.canvasApi.listProjects()");
    expect(app).toContain("PROJECT_LIST_TIMEOUT_MS");
    expect(app).toContain("PROJECT_SOURCE_VERIFY_TIMEOUT_MS");
    expect(app).toContain("cancelProjectListRequest");
    expect(app).toContain("verifyProjectSource");
    expect(app).toContain('data-testid="root-runtime-write-gate"');
    expect(app).toMatch(/onMounted\(async \(\) => \{[\s\S]{0,500}getRuntimeWriteGate\(\)/u);
    expect(app.indexOf("getRuntimeWriteGate()")).toBeGreaterThan(-1);
    expect(app.indexOf("getRuntimeWriteGate()")).toBeLessThan(app.indexOf("getActiveProject()"));
    expect(app).toContain("未取得可验证的内容 SHA 结果");
    expect(app).toContain(":refreshing=\"projectsRefreshing\"");
    const preload = readFileSync(path.join(root, "src/preload/index.ts"), "utf8");
    const main = readFileSync(path.join(root, "src/main/index.ts"), "utf8");
    expect(preload).toContain('ipcRenderer.invoke("canvas:cancel-project-list-request", requestId)');
    expect(main).toContain('ipcMain.handle("canvas:cancel-project-list-request"');
    expect(main).toContain("activeProjectListControllers");
    expect(main).toContain("signal: controller.signal");
  });
});

describe("项目中心工程行视口剔除", () => {
  it("project-row 使用 content-visibility，离屏工程跳过同步布局", () => {
    const vue = readFileSync(path.join(root, "src/renderer/src/components/ProjectCenter.vue"), "utf8");
    expect(vue).toContain('v-for="project in visibleProjects"');
    expect(vue).toContain(".project-list { max-height: 280px; overflow-y: auto; padding: 10px 24px; }");
    expect(vue).toContain(".project-row { width: 100%; display: flex; align-items: stretch; border-bottom: 1px solid var(--ui-line); background: transparent; content-visibility: auto; contain-intrinsic-size: auto 48px; }");
    expect(vue).not.toMatch(/\.project-row \{[^}]*content-visibility:\s*hidden/);
  });
});
