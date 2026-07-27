/**
 * P17 受管桌面全导航与支持页真实 Electron 烟测。
 *
 * 覆盖：五步生产导航、无限画布、驾驶舱、正式生成页、Agent 状态刷新、
 * 帮助、备份/恢复取消、项目中心键盘关闭。所有数据均来自隔离 P7 夹具；
 * 不修改真实 Agent 配置，不生成图片，不访问外网。
 */
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import sharp from "sharp";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "../tests/helpers/studio-p7-fixture.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspace, "docs", "evidence");
const evidencePath = path.resolve(process.argv[2] || path.join(evidenceRoot, "p17-navigation-support-ui-smoke-20260719-01.json"));
const screenshotPath = path.resolve(process.argv[3] || path.join(evidenceRoot, "p17-navigation-support-ui-smoke-20260719-01.png"));

for (const output of [evidencePath, screenshotPath]) {
  const relative = path.relative(evidenceRoot, output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`P17 UI 证据必须写入 docs/evidence：${output}`);
  }
  await access(output).then(
    () => { throw new Error(`P17 UI 证据已存在，拒绝覆盖：${output}`); },
    () => undefined,
  );
  await mkdir(path.dirname(output), { recursive: true });
}
for (const built of ["out/main/index.js", "out/preload/index.mjs", "out/renderer/index.html"]) {
  await access(path.join(workspace, built)).catch(() => {
    throw new Error(`缺少真实 Electron 编译产物 ${built}；请先运行 npm run build。`);
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileEvidence(filePath: string): Promise<{ path: string; sizeBytes: number; sha256: string }> {
  const bytes = await readFile(filePath);
  const metadata = await stat(filePath);
  return { path: filePath, sizeBytes: metadata.size, sha256: sha256(bytes) };
}

async function waitReady(page: Page, selector: string): Promise<void> {
  const target = page.locator(selector);
  await target.waitFor({ timeout: 60_000 });
  await page.waitForFunction((value) => {
    const element = document.querySelector(String(value));
    return element && element.getAttribute("aria-busy") !== "true";
  }, selector, { timeout: 60_000 });
}

async function ensurePanelProjection(page: Page): Promise<void> {
  if (await page.locator(".vue-flow__node.panel-node").count() >= 2) return;
  const unit = page.locator(".vue-flow__node.unit-node").first();
  await unit.waitFor();
  await unit.click();
  await page.locator(".vue-flow__node.panel-node").first().waitFor();
}

async function armOperationShieldProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    type ProbeWindow = Window & {
      __p17OperationShieldSeen?: boolean;
      __p17OperationShieldObserver?: MutationObserver;
    };
    const target = window as ProbeWindow;
    target.__p17OperationShieldObserver?.disconnect();
    target.__p17OperationShieldSeen = Boolean(document.querySelector('[data-testid="managed-project-operation-shield"]'));
    target.__p17OperationShieldObserver = new MutationObserver(() => {
      if (document.querySelector('[data-testid="managed-project-operation-shield"]')) {
        target.__p17OperationShieldSeen = true;
      }
    });
    target.__p17OperationShieldObserver.observe(document.body, { childList: true, subtree: true });
  });
}

async function assertOperationShieldSeen(page: Page, label: string): Promise<void> {
  const seen = await page.evaluate(() => {
    const target = window as Window & {
      __p17OperationShieldSeen?: boolean;
      __p17OperationShieldObserver?: MutationObserver;
    };
    target.__p17OperationShieldObserver?.disconnect();
    return target.__p17OperationShieldSeen === true;
  });
  if (!seen) throw new Error(`${label}期间未显示全局写入屏障。`);
}

async function closeApplication(target: ElectronApplication): Promise<void> {
  let fallback: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    target.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      fallback = setTimeout(() => {
        target.process().kill();
        resolve();
      }, 5_000);
    }),
  ]);
  if (fallback) clearTimeout(fallback);
}

const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p17-navigation-ui-")));
const registryPath = path.join(runtimeRoot, "registry", "projects.json");
const managedProjectsRoot = path.join(runtimeRoot, "managed-projects");
const userDataPath = path.join(runtimeRoot, "user-data");
const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
await Promise.all([
  mkdir(path.dirname(registryPath), { recursive: true }),
  mkdir(managedProjectsRoot, { recursive: true }),
  mkdir(userDataPath, { recursive: true }),
]);

let fixture: StudioP7Fixture | undefined;
let application: ElectronApplication | undefined;
let evidenceWritten = false;
let screenshotWritten = false;

try {
  fixture = await createStudioP7Fixture();
  await seedStudioP7ResolvedContinuity(fixture);
  await registerProject(fixture.shell.project);
  await setActiveProjectRegistration(fixture.root);

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  const visited: string[] = [];

  application = await electron.launch({
    args: [".", `--user-data-dir=${userDataPath}`],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_PROJECT_ROOT: fixture.root,
      AI_CANVAS_MANAGED_PROJECTS_ROOT: managedProjectsRoot,
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 1728, height: 1029 });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (entry) => { if (entry.type() === "error") consoleErrors.push(entry.text()); });
  page.on("request", (request) => { if (/^https?:/iu.test(request.url())) externalRequests.push(request.url()); });

  // 烟测只验证原生目录选择器的取消分支，避免弹窗依赖人工操作。
  await application.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => {
      await new Promise((resolve) => setTimeout(resolve, 260));
      return { canceled: true, filePaths: [] };
    };
  });

  await waitReady(page, '[data-testid="managed-studio-canvas-view"]');
  visited.push("无限画布");

  // 画布的轻量交互不应切走、清空或卡住当前投影。
  const beforeNodes = await page.locator(".vue-flow__node").count();
  await page.locator('[data-testid="managed-canvas-connect-mode"]').click();
  await page.locator('[data-testid="managed-canvas-connect-mode"]').click();
  await page.locator(".floating-tools button").filter({ hasText: "帮助" }).click();
  await page.getByRole("dialog", { name: "画布帮助" }).waitFor();
  await page.getByRole("button", { name: "关闭帮助" }).click();
  await page.locator('[data-testid="managed-canvas-add-node"]').click();
  await page.locator('[data-testid="managed-canvas-add-node"]').click();
  const afterNodes = await page.locator(".vue-flow__node").count();
  if (beforeNodes !== afterNodes) throw new Error(`轻量画布交互改变了投影节点：${beforeNodes} → ${afterNodes}`);

  // 逐个执行节点“下一步”按钮，防止按钮只渲染但没有真正接线。
  await ensurePanelProjection(page);
  const firstPanel = page.locator(".vue-flow__node.panel-node").first();
  await firstPanel.waitFor();
  await firstPanel.click();
  await page.locator('[data-testid="managed-canvas-action-open-binding"]').click();
  await waitReady(page, '[data-testid="studio-binding-workbench"]');
  visited.push("宫格→绑定工作台");

  await page.locator('[data-testid="studio-mode-canvas"]').click();
  await waitReady(page, '[data-testid="managed-studio-canvas-view"]');
  await ensurePanelProjection(page);
  await page.locator(".vue-flow__node.panel-node").first().click();
  await page.locator('[data-testid="managed-canvas-action-open-dashboard"]').click();
  await waitReady(page, '[data-testid="studio-production-dashboard-view"]');
  visited.push("宫格→驾驶舱");

  await page.locator('[data-testid="studio-mode-canvas"]').click();
  await waitReady(page, '[data-testid="managed-studio-canvas-view"]');
  await ensurePanelProjection(page);
  await page.locator(".vue-flow__node.panel-node").first().click();
  const generationAction = page.locator('[data-testid="managed-canvas-action-freeze-dispatch"]');
  if (await generationAction.isDisabled()) throw new Error("已就绪宫格的 Agent 生图队列入口被错误禁用。");
  await generationAction.click();
  await waitReady(page, '[data-testid="studio-generation-control"]');
  visited.push("宫格→Agent 生图队列");

  await page.locator('[data-testid="studio-mode-canvas"]').click();
  await waitReady(page, '[data-testid="managed-studio-canvas-view"]');
  await ensurePanelProjection(page);
  await page.locator(".vue-flow__node.panel-node").first().click();
  await page.locator('[data-testid="managed-canvas-action-close-panel"]').click();
  await page.locator('[data-testid="managed-canvas-node-action-panel"]').waitFor({ state: "detached" });
  await page.locator(".vue-flow__node.panel-node").first().click();
  await page.locator('[data-testid="managed-canvas-node-action-panel"]').waitFor();
  visited.push("节点面板收起与重新打开");

  await page.getByRole("button", { name: "适配", exact: true }).click();
  await page.waitForTimeout(300);
  const assetNode = page.locator(".vue-flow__node.asset-node").first();
  await assetNode.waitFor();
  await assetNode.click();
  await page.locator('[data-testid="managed-canvas-action-open-dashboard"]').click();
  await page.locator('[data-testid="managed-canvas-appearances"]').waitFor();
  if (!await page.locator('[data-testid="managed-studio-canvas-view"]').isVisible()) throw new Error("资产“查看出场”错误切离了画布。");
  visited.push("资产→出场时间线");

  const unitNode = page.locator(".vue-flow__node.unit-node").first();
  await unitNode.click();
  await page.locator('[data-testid="managed-canvas-action-focus-unit"]').click();
  await waitReady(page, '[data-testid="managed-studio-canvas-view"]');
  if (await page.locator(".vue-flow__node.panel-node").count() < 2) throw new Error("展开宫格动作没有保留 2–6 宫格投影。");
  visited.push("单元→展开宫格");

  await page.locator('[data-testid="studio-step-script"]').click();
  await page.locator("#studio-library-pane").waitFor();
  if (!(await page.locator(".section-rail .rail-entry.active").innerText()).includes("剧本")) throw new Error("剧本导航没有定位剧本素材。");
  visited.push("剧本");

  await page.locator('[data-testid="studio-step-assets"]').click();
  await page.locator("#studio-library-pane").waitFor();
  const activeAssetRail = await page.locator(".section-rail .rail-entry.active").innerText();
  if (!/(角色|场景|道具|媒体)/u.test(activeAssetRail)) throw new Error(`资产导航定位错误：${activeAssetRail}`);
  visited.push("资产");

  await page.locator('[data-testid="studio-step-binding"]').click();
  await waitReady(page, '[data-testid="studio-binding-workbench"]');
  await page.locator('[data-testid="binding-unit-entry"]').first().click();
  visited.push("绑定");

  await page.locator('[data-testid="studio-step-generation"]').click();
  await waitReady(page, '[data-testid="studio-generation-control"]');
  const panels = page.locator('[data-testid="studio-generation-panels"] > button');
  if (await panels.count() < 2) throw new Error("正式生成页没有显示 2–6 宫格单元。");
  await panels.nth(1).click();
  await waitReady(page, '[data-testid="studio-generation-control"]');
  if (!(await page.locator('[data-testid="studio-generation-open-review"]').isDisabled())) {
    throw new Error("无真实结果时生成页不应允许进入审片。");
  }
  await page.getByRole("button", { name: "检查绑定", exact: true }).click();
  await waitReady(page, '[data-testid="studio-binding-workbench"]');
  await page.locator('[data-testid="studio-step-generation"]').click();
  await waitReady(page, '[data-testid="studio-generation-control"]');
  await page.locator('[data-testid="studio-generation-open-canvas"]').click();
  await waitReady(page, '[data-testid="managed-studio-canvas-view"]');
  visited.push("生成");

  await page.locator('[data-testid="studio-step-review"]').click();
  await waitReady(page, '[data-testid="studio-continuity-review-view"]');
  await page.locator('[data-testid="continuity-business-empty"]').waitFor();
  visited.push("审片");

  await page.locator('[data-testid="studio-mode-dashboard"]').click();
  await waitReady(page, '[data-testid="studio-production-dashboard-view"]');
  const dashboardUnits = page.locator('[data-testid="dashboard-unit-list"] button');
  if (await dashboardUnits.count()) await dashboardUnits.first().click();
  await page.locator('[data-testid="dashboard-panel-grid"]').waitFor();
  const dashboardPanels = await page.locator('[data-testid="dashboard-panel-grid"] .panel-card').count();
  if (dashboardPanels < 2 || dashboardPanels > 6) throw new Error(`驾驶舱宫格渲染越界：${dashboardPanels}`);
  visited.push("驾驶舱");

  await page.locator('[data-testid="studio-mode-agent"]').click();
  await waitReady(page, '[data-testid="desktop-support-view"]');
  const repair = page.locator('[data-testid="desktop-support-repair"]');
  if (!(await repair.isDisabled())) throw new Error("开发版不得允许写入 Agent 配置。");
  await page.locator('[data-testid="desktop-support-refresh"]').click();
  await waitReady(page, '[data-testid="desktop-support-view"]');
  visited.push("Agent 连接");

  await page.locator('[data-testid="studio-mode-help"]').click();
  await waitReady(page, '[data-testid="desktop-support-view"]');
  await armOperationShieldProbe(page);
  await page.locator('[data-testid="desktop-support-backup"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="managed-project-operation-state"]')?.textContent?.includes("备份已取消"));
  await assertOperationShieldSeen(page, "备份");
  await page.locator('[data-testid="managed-project-operation-shield"]').waitFor({ state: "detached" });
  await waitReady(page, '[data-testid="desktop-support-view"]');
  await armOperationShieldProbe(page);
  await page.locator('[data-testid="desktop-support-restore"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="managed-project-operation-state"]')?.textContent?.includes("恢复已取消"));
  await assertOperationShieldSeen(page, "恢复");
  await page.locator('[data-testid="managed-project-operation-shield"]').waitFor({ state: "detached" });
  await waitReady(page, '[data-testid="desktop-support-view"]');
  visited.push("帮助与安全", "备份取消", "恢复取消");

  await page.locator('[data-testid="studio-open-project-center"]').click();
  const projectDialog = page.locator('[data-testid="project-center-dialog"]');
  await projectDialog.waitFor();
  await page.keyboard.press("Shift+Tab");
  const focusTrapped = await page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="project-center-dialog"]');
    return Boolean(dialog && document.activeElement && dialog.contains(document.activeElement));
  });
  if (!focusTrapped) throw new Error("项目中心 Shift+Tab 焦点逃出了模态框。");
  await projectDialog.locator('input[name="managed-project-name"]').fill("尚未建立的测试工程");
  await page.keyboard.press("Escape");
  await projectDialog.getByRole("alert").waitFor();
  if (!await projectDialog.isVisible()) throw new Error("未保存工程名第一次 Escape 不应直接丢失。");
  await page.keyboard.press("Escape");
  await projectDialog.waitFor({ state: "detached" });
  visited.push("项目中心焦点闭环", "未保存名称二次确认");

  await application.evaluate(async ({ BrowserWindow }, outputPath) => {
    const target = BrowserWindow.getAllWindows()[0];
    if (!target) throw new Error("Electron 主窗口不存在。");
    const image = await target.capturePage();
    const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
    fs.writeFileSync(String(outputPath), image.toPNG(), { flag: "wx" });
  }, screenshotPath);
  screenshotWritten = true;

  if (pageErrors.length || consoleErrors.length || externalRequests.length) {
    throw new Error(`全导航烟测出现错误或外网访问：${JSON.stringify({ pageErrors, consoleErrors, externalRequests })}`);
  }

  const releaseManifest = JSON.parse(await readFile(path.join(workspace, "release-manifest.json"), "utf8")) as {
    sourceDigest: string;
    buildId: string;
    capabilities: { mcpToolCount: number };
  };
  const screenshotInfo = await fileEvidence(screenshotPath);
  const metadata = await sharp(screenshotPath).metadata();
  const stats = await sharp(screenshotPath).stats();
  const stdev = Math.max(...stats.channels.map((channel) => channel.stdev));
  if ((metadata.width ?? 0) < 1_400 || (metadata.height ?? 0) < 850 || screenshotInfo.sizeBytes < 25_000 || stdev < 5) {
    throw new Error("P17 全导航截图疑似空白或占位图。");
  }

  const evidence = {
    schemaVersion: 1,
    kind: "p17-navigation-support-ui-smoke",
    status: "pass",
    createdAt: new Date().toISOString(),
    buildIdentity: releaseManifest,
    projectId: fixture.shell.project.id,
    runtime: "workspace-build",
    ui: {
      visited,
      canvasNodeCountPreserved: beforeNodes === afterNodes,
      nodeActionsExecuted: ["open-binding", "open-dashboard", "freeze-dispatch", "close-panel", "asset-appearances", "focus-unit"],
      generationPanelCount: await panels.count(),
      dashboardPanelCount: dashboardPanels,
      reviewBlockedWithoutResult: true,
      agentRepairBlockedInDevelopment: true,
      backupCancel: true,
      restoreCancel: true,
      operationShieldDuringBackupRestore: true,
      projectCenterFocusTrap: true,
      projectCenterUnsavedCloseConfirmation: true,
      pageErrors: 0,
      consoleErrors: 0,
      externalRequests: 0,
    },
    safety: {
      isolatedFixture: true,
      agentConfigurationWrites: 0,
      realImageGenerated: false,
      browser: false,
      upload: false,
      payment: false,
      publish: false,
    },
    screenshot: {
      ...screenshotInfo,
      width: metadata.width,
      height: metadata.height,
      stdev,
    },
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  evidenceWritten = true;
  process.stdout.write(`${JSON.stringify({ ok: true, evidencePath, screenshotPath, visited }, null, 2)}\n`);
} finally {
  if (application) await closeApplication(application).catch(() => undefined);
  if (fixture) await fixture.cleanup().catch(() => undefined);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
  if (!evidenceWritten) await rm(evidencePath, { force: true }).catch(() => undefined);
  if (!screenshotWritten || !evidenceWritten) await rm(screenshotPath, { force: true }).catch(() => undefined);
}
