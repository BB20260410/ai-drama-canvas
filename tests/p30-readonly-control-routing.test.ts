import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("P30 Dudu / 视频包受控路由", () => {
  it("具名 IPC/preload/MCP 只暴露查询，写面仅进入 execute_command 且不公开 publication", async () => {
    const [main, preload, mcp, codex, projectCenter, generationView, workflowRunner, commandRuntime] = await Promise.all([
      readFile(path.join(workspace, "src/main/index.ts"), "utf8"),
      readFile(path.join(workspace, "src/preload/index.ts"), "utf8"),
      readFile(path.join(workspace, "src/mcp/server.ts"), "utf8"),
      readFile(path.join(workspace, "src/core/codex.ts"), "utf8"),
      readFile(path.join(workspace, "src/renderer/src/components/ProjectCenter.vue"), "utf8"),
      readFile(path.join(workspace, "src/renderer/src/components/StudioGenerationControlView.vue"), "utf8"),
      readFile(path.join(workspace, "src/core/studio-canvas-workflow-runner.ts"), "utf8"),
      readFile(path.join(workspace, "src/core/studio-command-runtime.ts"), "utf8"),
    ]);

    expect(main).toContain('ipcMain.handle("canvas:get-dudu-readonly-import-control"');
    expect(main).toContain('ipcMain.handle("canvas:discover-dudu-readonly-import-projects"');
    expect(main).toContain('ipcMain.handle("canvas:get-studio-video-package-control"');
    expect(preload).toContain('ipcRenderer.invoke("canvas:get-dudu-readonly-import-control"');
    expect(preload).toContain('ipcRenderer.invoke("canvas:discover-dudu-readonly-import-projects"');
    expect(preload).toContain('ipcRenderer.invoke("canvas:get-studio-video-package-control"');
    expect(mcp).toContain('"get_dudu_readonly_import_control"');
    expect(mcp).toContain('"discover_dudu_readonly_import_projects"');
    expect(mcp).toContain('"get_studio_video_package_control"');
    expect(codex).toContain('stageFinalizeExposure: "execute-command-only-no-named-tools"');
    expect(codex).toContain('discovery: "bounded-direct-children-zero-one-conflict-never-select-first"');
    expect(codex).toContain('builderExecution: "managed-evidence-only-via-execute-command"');
    expect(codex).toContain('dynamicVideoModel: "never"');
    expect(codex).toContain('selectors: ["intent", "authority-latest"]');
    expect(mcp).toContain('by: z.enum(["intent", "authority-latest"])');
    expect(mcp).toContain('command: z.literal("stage_dudu_readonly_managed_project")');
    // P30 其余三条写命令的 z.literal 已迁址到 Core 唯一 schema owner；server.ts 经展开仍接受。
    expect(mcp).toContain("...STUDIO_CODEX_PUBLIC_COMMAND_SCHEMA_OPTIONS");
    expect(commandRuntime).toContain('command: z.literal("finalize_dudu_readonly_managed_project")');
    expect(commandRuntime).toContain('command: z.literal("prepare_studio_video_package_export")');
    expect(commandRuntime).toContain('command: z.literal("build_studio_video_package")');
    expect(commandRuntime).toContain('destinationPolicy: z.literal("managed-evidence-only")');
    expect(projectCenter).toContain("discoverDuduReadonlyImportProjects");
    expect(projectCenter).toContain("已停止自动选择");
    expect(projectCenter).toContain("不会创建工程、续跑导入、登记、激活或生成图片");
    expect(generationView).toContain('historyTargetKind === "unit-grid"');
    expect(generationView).toContain('node.targetKind === "unit-grid"');
    expect(generationView).toContain("getStudioVideoPackageControl");
    expect(generationView).toContain("本界面不直接执行构建");
    expect(generationView).toContain("动态视频模型：未运行");
    expect(generationView).toContain('operation: "detached-unknown"');
    expect(generationView).toContain("禁止再次派发、重试或生图");
    expect(workflowRunner).toContain('bootstrapClaim?.purpose === "dudu-readonly-import"');
    expect(workflowRunner).toContain('"unit-grid-target-required"');
    expect(workflowRunner).toContain('listStudioActiveDetachedGenerationUnknownObservations');

    expect(main).not.toContain("canvas:execute-dudu-bootstrap-command");
    expect(preload).not.toContain("executeDuduBootstrapCommand");

    for (const source of [main, preload, mcp]) {
      expect(source).not.toMatch(/(?:canvas:|registerTool\(\s*)["'](?:execute[-_])?(?:stage|finalize)[-_]dudu/iu);
      expect(source).not.toMatch(/(?:canvas:|registerTool\(\s*)["'](?:execute[-_])?(?:build|publish)[-_]studio[-_]video[-_]package/iu);
    }
  });

  it("renderer 不直写四条 P30 命令，视频包过桥经公开投影，UI 使用语义命令信封与防迟到令牌", async () => {
    const [main, preload, generationView, projectCenter, managedCanvas, reviewView] = await Promise.all([
      readFile(path.join(workspace, "src/main/index.ts"), "utf8"),
      readFile(path.join(workspace, "src/preload/index.ts"), "utf8"),
      readFile(path.join(workspace, "src/renderer/src/components/StudioGenerationControlView.vue"), "utf8"),
      readFile(path.join(workspace, "src/renderer/src/components/ProjectCenter.vue"), "utf8"),
      readFile(path.join(workspace, "src/renderer/src/components/ManagedStudioCanvasView.vue"), "utf8"),
      readFile(path.join(workspace, "src/renderer/src/components/StudioContinuityReviewView.vue"), "utf8"),
    ]);

    // renderer 任何地方不得出现四条写命令字面量（写面只属于 MCP execute_command 与受授权 Core）。
    for (const view of [generationView, projectCenter, managedCanvas, reviewView]) {
      expect(view).not.toContain("stage_dudu_readonly_managed_project");
      expect(view).not.toContain("finalize_dudu_readonly_managed_project");
      expect(view).not.toContain("prepare_studio_video_package_export");
      expect(view).not.toContain("build_studio_video_package");
    }

    // 视频包控制面只经公开投影过桥：main 必须投影，preload 公开类型不得回退到含路径的完整 lookup。
    expect(main).toContain("toStudioVideoPackagePublicControlLookup");
    expect(preload).toContain("StudioVideoPackagePublicControlLookup");
    expect(generationView).toContain("StudioVideoPackagePublicControlLookup");
    expect(generationView).not.toContain("productionRoot");

    // authority head 与 mechanical-only 呈现合同。
    expect(generationView).toContain('data-testid="studio-video-package-authority-head"');
    expect(generationView).toContain("权威头：");
    expect(generationView).toContain("仅机械状态：不代表人工视觉验收或真实视频模型验证。");

    // 取消/重试必须使用共享语义命令信封，禁止随机幂等键与类型绕过。
    expect(generationView).toContain("createStudioCommandEnvelope");
    expect(generationView).not.toContain("studio-generation-ui-key-");
    expect(generationView).not.toContain("as never");

    // Dudu discovery 必须有防迟到令牌与卸载失效。
    expect(projectCenter).toContain("duduDiscoveryToken");
    expect(projectCenter).toContain("onBeforeUnmount");
  });
});
