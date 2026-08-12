/**
 * P17 受管桌面全导航与支持页真实 Electron 烟测。
 *
 * 覆盖：五步生产导航、无限画布、驾驶舱、正式生成页、Agent 状态刷新、
 * 帮助、备份/恢复取消、项目中心键盘关闭。所有数据均来自隔离 P7 夹具；
 * 不修改真实 Agent 配置，不生成图片，不访问外网。
 */
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import sharp from "sharp";
import {
  captureBackgroundElectronStateOrThrow,
  closeElectronApplicationOrThrow,
  forceCleanupElectronApplication,
  type ElectronBackgroundStateEvidence,
  type ElectronCloseEvidence,
} from "./lib/electron-application-close.mjs";
import {
  mkdtempOwnedFixtureRoot,
  removeOwnedTemporaryFixtureRoot,
} from "./lib/owned-fixture-root.js";
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

async function captureRuntimeStabilitySnapshot(
  application: ElectronApplication,
  label: string,
): Promise<{ label: string; snapshot: unknown }> {
  const snapshot = await application.evaluate(() => (
    (globalThis as typeof globalThis & {
      __AI_CANVAS_RUNTIME_STABILITY_SNAPSHOT__?: () => unknown;
    }).__AI_CANVAS_RUNTIME_STABILITY_SNAPSHOT__?.()
  ));
  if (!snapshot) throw new Error(`${label} 缺少 runtime stability probe。`);
  return { label, snapshot };
}

async function measureUiAction<T>(
  samples: Record<string, number | number[]>,
  name: string,
  action: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const result = await action();
  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
  const current = samples[name];
  if (Array.isArray(current)) current.push(durationMs);
  else if (typeof current === "number") samples[name] = [current, durationMs];
  else samples[name] = durationMs;
  return result;
}

async function domSnapshot(page: Page, label: string): Promise<{
  label: string;
  totalElements: number;
  vueFlowNodes: number;
  resourceCards: number;
  timelineClips: number;
  images: number;
  videos: number;
  audios: number;
}> {
  return page.evaluate((snapshotLabel) => ({
    label: snapshotLabel,
    totalElements: document.querySelectorAll("*").length,
    vueFlowNodes: document.querySelectorAll(".vue-flow__node").length,
    resourceCards: document.querySelectorAll('[data-testid="global-resource-item"]').length,
    timelineClips: document.querySelectorAll(".timeline-clip").length,
    images: document.images.length,
    videos: document.querySelectorAll("video").length,
    audios: document.querySelectorAll("audio").length,
  }), label);
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

interface UiAuditEvidence {
  label: string;
  buttonCount: number;
  unnamedVisibleButtons: string[];
  duplicateIds: string[];
  horizontalOverflowPx: number;
}

async function auditVisibleUi(page: Page, label: string): Promise<UiAuditEvidence> {
  // 以纯字符串注入，避免 tsx/esbuild 给浏览器闭包插入 Node 侧 __name helper。
  const audit = await page.evaluate(`(() => {
    const visibleButtons = [];
    for (const button of document.querySelectorAll("button")) {
      const style = getComputedStyle(button);
      const box = button.getBoundingClientRect();
      if (style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0) {
        visibleButtons.push(button);
      }
    }
    const unnamedVisibleButtons = [];
    for (const button of visibleButtons) {
      if (!(button.getAttribute("aria-label")?.trim() || button.getAttribute("title")?.trim() || button.textContent?.trim())) {
        unnamedVisibleButtons.push(button.outerHTML.slice(0, 180));
      }
    }
    const idCounts = new Map();
    for (const element of document.querySelectorAll("[id]")) {
      const id = element.id.trim();
      if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
    }
    const duplicateIds = [];
    for (const [id, count] of idCounts.entries()) {
      if (count > 1) duplicateIds.push(id);
    }
    return {
      label: ${JSON.stringify(label)},
      buttonCount: visibleButtons.length,
      unnamedVisibleButtons,
      duplicateIds,
      horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    };
  })()`) as UiAuditEvidence;
  if (audit.unnamedVisibleButtons.length || audit.duplicateIds.length || audit.horizontalOverflowPx > 1) {
    throw new Error(`${label} UI 静态运行门禁失败：${JSON.stringify(audit)}`);
  }
  return audit;
}

const fixtureOwnerId = "p17-navigation-support-smoke";
const runtimeFixture = await mkdtempOwnedFixtureRoot("ai-canvas-p17-navigation-ui", fixtureOwnerId);
const runtimeRoot = runtimeFixture.root;
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
let closeEvidence: ElectronCloseEvidence | undefined;
let backgroundSnapshot: ElectronBackgroundStateEvidence | undefined;
let runtimeRemoved = false;

try {
  fixture = await createStudioP7Fixture();
  await seedStudioP7ResolvedContinuity(fixture);
  await registerProject(fixture.shell.project);
  await setActiveProjectRegistration(fixture.root);

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  const visited: string[] = [];
  const uiAudits: UiAuditEvidence[] = [];
  const actionTimings: Record<string, number | number[]> = {};
  const runtimeStability: Array<{ label: string; snapshot: unknown }> = [];
  const domSamples: Awaited<ReturnType<typeof domSnapshot>>[] = [];
  const smokeStartedAt = Date.now();

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
      AI_CANVAS_ELECTRON_BACKGROUND_SMOKE: "1",
      AI_CANVAS_RUNTIME_STABILITY_PROBE: "1",
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
  const readyDurationMs = Date.now() - smokeStartedAt;
  backgroundSnapshot = await captureBackgroundElectronStateOrThrow(application, { label: "P17 navigation ready" });
  runtimeStability.push(await captureRuntimeStabilitySnapshot(application, "ready"));
  domSamples.push(await domSnapshot(page, "canvas-ready"));
  uiAudits.push(await auditVisibleUi(page, "无限画布初始页"));
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
  runtimeStability.push(await captureRuntimeStabilitySnapshot(application, "before-unit-expand"));
  await measureUiAction(actionTimings, "canvasNodeSelectAndExpandMs", async () => {
    await unitNode.click();
    await page.locator('[data-testid="managed-canvas-action-focus-unit"]').click();
    await waitReady(page, '[data-testid="managed-studio-canvas-view"]');
  });
  runtimeStability.push(await captureRuntimeStabilitySnapshot(application, "after-unit-expand"));
  if (await page.locator(".vue-flow__node.panel-node").count() < 2) throw new Error("展开宫格动作没有保留 2–6 宫格投影。");
  visited.push("单元→展开宫格");

  // 真实操作总资源、媒体时间线与图文对照，覆盖跨项目目录缓存、分页筛选和只读刷新。
  await measureUiAction(actionTimings, "globalResourcesOpenMs", async () => {
    await page.locator('[data-testid="studio-mode-global-resources"]').click();
    await waitReady(page, '[data-testid="global-resource-center-view"]');
  });
  const resourceTabs = page.locator('[data-testid^="global-resource-tab-"]');
  if (await resourceTabs.count() < 4) throw new Error("总资源分类页签不完整。");
  actionTimings.globalResourceCategoryMs = [];
  for (let index = 0; index < Math.min(4, await resourceTabs.count()); index += 1) {
    await measureUiAction(actionTimings, "globalResourceCategoryMs", async () => {
      await resourceTabs.nth(index).click();
      await waitReady(page, '[data-testid="global-resource-center-view"]');
    });
  }
  await measureUiAction(actionTimings, "globalResourceSearchNoMatchMs", async () => {
    await page.locator('[data-testid="global-resource-search"]').fill("P17-无匹配筛选");
    await page.getByRole("heading", { name: "没有匹配结果" }).waitFor();
  });
  await measureUiAction(actionTimings, "globalResourceSearchClearMs", async () => {
    await page.locator('[data-testid="global-resource-search"]').fill("");
    await page.getByRole("heading", { name: "没有匹配结果" }).waitFor({ state: "detached" });
    await waitReady(page, '[data-testid="global-resource-center-view"]');
  });
  domSamples.push(await domSnapshot(page, "global-resources"));
  runtimeStability.push(await captureRuntimeStabilitySnapshot(application, "after-global-resources"));
  uiAudits.push(await auditVisibleUi(page, "总资源中心"));
  visited.push("总资源分类与搜索");

  await page.locator('[data-testid="studio-mode-multimedia-timeline"]').click();
  await waitReady(page, '[data-testid="studio-multimedia-timeline-view"]');
  await page.locator('[data-testid="multimedia-refresh"]').click();
  await waitReady(page, '[data-testid="studio-multimedia-timeline-view"]');
  uiAudits.push(await auditVisibleUi(page, "四媒体时间线"));
  visited.push("四媒体时间线刷新");

  await page.locator('[data-testid="studio-mode-script-align"]').click();
  await waitReady(page, '[data-testid="script-media-align-view"]');
  await page.locator('[data-testid="align-reload"]').click();
  await waitReady(page, '[data-testid="script-media-align-view"]');
  uiAudits.push(await auditVisibleUi(page, "图文对照"));
  visited.push("图文对照刷新");

  await page.locator('[data-testid="studio-mode-canvas"]').click();
  await waitReady(page, '[data-testid="managed-studio-canvas-view"]');

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
  const generationPanelCount = await panels.count();
  if (generationPanelCount < 2) throw new Error("正式生成页没有显示 2–6 宫格单元。");
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
  uiAudits.push(await auditVisibleUi(page, "生产驾驶舱"));
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
  uiAudits.push(await auditVisibleUi(page, "帮助与安全"));
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

  // 小窗口下复验顶层布局；只允许内部工作区滚动，不允许 document 横向溢出。
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.waitForTimeout(120);
  uiAudits.push(await auditVisibleUi(page, "1280×760 紧凑窗口"));
  if (!await page.locator('[data-testid="studio-production-steps"]').isVisible()) {
    throw new Error("紧凑窗口下生产导航不可见。");
  }
  await page.setViewportSize({ width: 1728, height: 1029 });
  await page.waitForTimeout(120);

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

  backgroundSnapshot = await captureBackgroundElectronStateOrThrow(application, { label: "P17 navigation before close" });
  await page.waitForTimeout(600);
  runtimeStability.push(await captureRuntimeStabilitySnapshot(application, "idle-before-close"));
  domSamples.push(await domSnapshot(page, "final-view"));
  const interactionDurationMs = Date.now() - smokeStartedAt;
  closeEvidence = await closeElectronApplicationOrThrow(application, {
    label: "P17 navigation Electron",
    timeoutMs: 20_000,
  });
  application = undefined;
  const projectId = fixture.shell.project.id;
  await fixture.cleanup();
  fixture = undefined;
  await removeOwnedTemporaryFixtureRoot(runtimeRoot, fixtureOwnerId);
  runtimeRemoved = true;

  const evidence = {
    schemaVersion: 1,
    kind: "p17-navigation-support-ui-smoke",
    status: "pass",
    createdAt: new Date().toISOString(),
    buildIdentity: releaseManifest,
    projectId,
    runtime: "workspace-build",
    performance: {
      readyDurationMs,
      interactionDurationMs,
      actionTimings,
      runtimeStability,
      domSamples,
      renderedTaskLimits: { generationBucket: 36, managedAssetPage: 36, panelsPerUnit: 6 },
    },
    ui: {
      visited,
      audits: uiAudits,
      canvasNodeCountPreserved: beforeNodes === afterNodes,
      nodeActionsExecuted: ["open-binding", "open-dashboard", "freeze-dispatch", "close-panel", "asset-appearances", "focus-unit"],
      generationPanelCount,
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
      backgroundSnapshot,
      closeEvidence,
      runtimeRootRemoved: runtimeRemoved,
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
  if (application) await forceCleanupElectronApplication(application).catch(() => undefined);
  if (fixture) await fixture.cleanup().catch(() => undefined);
  if (!runtimeRemoved) await removeOwnedTemporaryFixtureRoot(runtimeRoot, fixtureOwnerId).catch(() => undefined);
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
  if (!evidenceWritten) await rm(evidencePath, { force: true }).catch(() => undefined);
  if (!screenshotWritten || !evidenceWritten) await rm(screenshotPath, { force: true }).catch(() => undefined);
}
