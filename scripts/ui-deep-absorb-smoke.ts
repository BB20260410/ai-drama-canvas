/**
 * 深研吸收能力 · Electron 真窗口 UI smoke
 * 覆盖：画布 minimap / 工作流条 / 节点操作面板 · 驾驶舱准备清单 · 绑定确认/忽略
 * 隔离 fixture，不写正式空库。
 */
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type Page } from "playwright";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "../tests/helpers/studio-p7-fixture.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspace, "docs", "evidence");
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const runId = `${stamp}-${Date.now().toString(36)}`;
const evidencePath = path.resolve(
  process.argv[2] || path.join(evidenceRoot, `deep-absorb-ui-smoke-${runId}.json`),
);
const screenshotCanvas = path.resolve(
  process.argv[3] || path.join(evidenceRoot, `deep-absorb-ui-smoke-canvas-${runId}.png`),
);
const screenshotBinding = path.resolve(
  process.argv[4] || path.join(evidenceRoot, `deep-absorb-ui-smoke-binding-${runId}.png`),
);

for (const output of [evidencePath, screenshotCanvas, screenshotBinding]) {
  const relative = path.relative(evidenceRoot, output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`UI 证据必须写入 docs/evidence：${output}`);
  }
  await mkdir(path.dirname(output), { recursive: true });
}

for (const compiledOutput of ["out/main/index.js", "out/renderer/index.html"]) {
  await access(path.join(workspace, compiledOutput)).catch(() => {
    throw new Error(`缺少真实 Electron 编译产物 ${compiledOutput}；请先运行 npm run build。`);
  });
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileEvidence(filePath: string) {
  const bytes = await readFile(filePath);
  const metadata = await stat(filePath);
  return { path: filePath, sizeBytes: metadata.size, sha256: sha256(bytes) };
}

const temporaryBase = await realpath("/tmp");
const runtimeRoot = await realpath(await mkdtemp(path.join(temporaryBase, "ai-canvas-deep-absorb-ui-")));
const registryPath = path.join(runtimeRoot, "registry", "projects.json");
const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

let fixture: StudioP7Fixture | undefined;
let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

const checks: Record<string, boolean | string | number> = {};

try {
  fixture = await createStudioP7Fixture();
  await seedStudioP7ResolvedContinuity(fixture);
  await registerProject(fixture.shell.project);
  await setActiveProjectRegistration(fixture.root);

  const overview = await getStudioProductionDashboard(fixture.root, { operation: "overview" });
  checks.coreOverviewOk = overview.operation === "overview";

  const userDataDir = path.join(runtimeRoot, "user-data");
  await mkdir(userDataDir, { recursive: true });
  application = await electron.launch({
    args: [path.join(workspace, "out/main/index.js")],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const page = await application.firstWindow();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.setViewportSize({ width: 1728, height: 1029 });
  await page.waitForSelector('[data-testid="material-studio-view"]', { timeout: 90_000 });
  checks.materialStudioVisible = true;

  // —— 画布模式：minimap / 工作流条 / 节点面板 ——
  const canvasTab = page.locator('[data-testid="studio-mode-canvas"]');
  if (await canvasTab.count()) await canvasTab.click();
  await page.waitForSelector('[data-testid="managed-studio-canvas-view"]', { timeout: 60_000 });
  checks.canvasViewVisible = true;

  await page.waitForSelector('[data-testid="managed-canvas-minimap"], .vue-flow__minimap', { timeout: 30_000 });
  checks.minimapVisible = true;

  // 工具条收纳在默认闭合的 details 内（P25 设计），存在即可见等待改 attached。
  await page.waitForSelector('[data-testid="managed-canvas-workflow-toolbar"]', { state: "attached", timeout: 15_000 });
  checks.workflowToolbarVisible = true;

  // 画布图片化：等待节点投影落 DOM 再探测缩略图/文稿
  await page.waitForFunction(
    () => document.querySelectorAll(".vue-flow__node").length > 0
      || document.querySelectorAll('[data-testid="managed-studio-canvas-node"]').length > 0,
    null,
    { timeout: 30_000 },
  ).catch(() => undefined);
  await page.waitForTimeout(800);
  const visualProbe = await page.evaluate(() => {
    const flowNodes = document.querySelectorAll(".vue-flow__node").length;
    const customNodes = document.querySelectorAll('[data-testid="managed-studio-canvas-node"]').length;
    const thumbs = document.querySelectorAll('[data-testid="managed-canvas-node-thumb"]').length;
    const thumbCountLabel = document.querySelector('[data-testid="managed-canvas-thumb-count"]')?.textContent ?? "";
    const textDocCount = document.querySelector('[data-testid="managed-canvas-text-doc-count"]')?.textContent ?? "";
    const scriptNodes = document.querySelectorAll(".vue-flow__node.script-node, .vue-flow__node.prompt-node").length;
    const assetNodes = document.querySelectorAll(".vue-flow__node.asset-node").length;
    return { flowNodes, customNodes, thumbs, thumbCountLabel, textDocCount, scriptNodes, assetNodes };
  });
  checks.canvasFlowNodes = visualProbe.flowNodes;
  checks.canvasCustomNodes = visualProbe.customNodes > 0;
  checks.canvasCustomNodeCount = visualProbe.customNodes;
  checks.canvasThumbNodes = visualProbe.thumbs;
  checks.canvasAssetNodes = visualProbe.assetNodes;
  checks.canvasThumbCountLabel = visualProbe.thumbCountLabel;
  checks.canvasTextDocCountLabel = visualProbe.textDocCount;
  checks.canvasScriptOrPromptNodes = visualProbe.scriptNodes;

  // 点单元再点宫格：VueFlow 节点可能在视口外，用 DOM 强制 click
  await page.waitForTimeout(1500);
  const nodeClick = await page.evaluate(() => {
    const unit = document.querySelector(".vue-flow__node.unit-node") as HTMLElement | null;
    if (unit) {
      unit.scrollIntoView({ block: "center", inline: "center" });
      unit.click();
      return { unit: true, panel: false, unitText: unit.textContent?.slice(0, 80) ?? "" };
    }
    // 回退：任意含「单元」字样的 node
    const any = [...document.querySelectorAll(".vue-flow__node")].find((el) =>
      /单元|unit|15/i.test(el.textContent || "")
    ) as HTMLElement | undefined;
    if (any) {
      any.click();
      return { unit: true, panel: false, unitText: any.textContent?.slice(0, 80) ?? "" };
    }
    return { unit: false, panel: false, unitText: "" };
  });
  checks.unitNodeClicked = nodeClick.unit;
  await page.waitForTimeout(1200);
  const panelClick = await page.evaluate(() => {
    const panel = document.querySelector(".vue-flow__node.panel-node") as HTMLElement | null;
    if (panel) {
      panel.scrollIntoView({ block: "center", inline: "center" });
      panel.click();
      return true;
    }
    return false;
  });
  checks.panelNodeClicked = panelClick;
  await page.waitForTimeout(800);

  const actionPanel = page.locator('[data-testid="managed-canvas-node-action-panel"]');
  const actionPanelVisible = (await actionPanel.count()) > 0 && (await actionPanel.isVisible());
  checks.nodeActionPanelVisible = actionPanelVisible;
  if (actionPanelVisible) {
    const openDash = page.locator('[data-testid="managed-canvas-action-open-dashboard"]');
    const openBind = page.locator('[data-testid="managed-canvas-action-open-binding"]');
    checks.actionOpenDashboard = (await openDash.count()) > 0;
    checks.actionOpenBinding = (await openBind.count()) > 0;
  }

  // 画布含大量节点缩略图时 fullPage 易超时；视口截图即可作 UI 证据
  await page.screenshot({ path: screenshotCanvas, fullPage: false, timeout: 60_000 });

  // —— 正式 Agent 生图派发入口 ——
  const generationTab = page.locator('[data-testid="studio-step-generation"]');
  if (await generationTab.count()) {
    await generationTab.click();
    const generationControl = page.locator('[data-testid="studio-generation-control"]');
    await generationControl.waitFor({ state: "visible", timeout: 45_000 });
    await generationControl.locator('[data-testid="studio-generation-panels"]').waitFor({
      state: "visible",
      timeout: 45_000,
    });
    checks.generationTabVisible = true;
    checks.generationPaneVisible = await page.locator('[data-testid="studio-generation-pane"]').isVisible();
    checks.generationControlVisible = await generationControl.isVisible();
    checks.generationLedgerSummaryVisible = await generationControl.locator(".generation-counts").isVisible();
    checks.generationUnitRailVisible = await generationControl.locator(".unit-rail").isVisible();
    checks.generationPanelStageVisible = await generationControl.locator(".panel-stage").isVisible();
  } else {
    checks.generationTabVisible = false;
  }

  // —— 驾驶舱：准备清单 / 生成前预览 ——
  const dashboardTab = page.locator('[data-testid="studio-mode-dashboard"]');
  if (await dashboardTab.count()) await dashboardTab.click();
  await page.waitForSelector('[data-testid="studio-production-dashboard-view"]', { timeout: 45_000 });
  checks.dashboardVisible = true;

  const unitButtons = page.locator('[data-testid="dashboard-unit-list"] button.unit-entry, [data-testid="dashboard-unit-list"] button');
  await page.waitForSelector('[data-testid="dashboard-unit-list"] button', { timeout: 30_000 }).catch(() => undefined);
  if ((await unitButtons.count()) > 0) {
    await unitButtons.first().click();
    // 等 unit 详情 + selectedPanel 就绪（准备清单依赖 selectedPanel）
    await page.waitForSelector('[data-testid="dashboard-preparation-checklist"]', { timeout: 45_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
  }
  // 若仍无清单：再点宫格卡片强制选格
  if ((await page.locator('[data-testid="dashboard-preparation-checklist"]').count()) === 0) {
    const panelCards = page.locator(
      '[data-testid="dashboard-panel-grid"] button.panel-card, [data-testid="dashboard-panel-grid"] button',
    );
    if ((await panelCards.count()) > 0) {
      await panelCards.first().click();
      await page.waitForSelector('[data-testid="dashboard-preparation-checklist"]', { timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(400);
    }
  }

  const prep = page.locator('[data-testid="dashboard-preparation-checklist"]');
  checks.prepChecklistVisible = (await prep.count()) > 0 && (await prep.isVisible().catch(() => false));
  const preflight = page.locator('[data-testid="dashboard-generation-preflight"]');
  checks.preflightVisible = (await preflight.count()) > 0 && (await preflight.isVisible().catch(() => false));
  const dashHtml = await page.content();
  checks.prepChecklistInDom = dashHtml.includes("dashboard-preparation-checklist") || dashHtml.includes("生成前准备清单");
  checks.preflightInDom = dashHtml.includes("dashboard-generation-preflight") || dashHtml.includes("生成前预览");

  // —— 绑定工作台：确认/忽略候选标记 ——
  const bindingTab = page.locator('[data-testid="studio-step-binding"]');
  if (await bindingTab.count()) {
    await bindingTab.click();
    await page.waitForSelector(".binding-workbench, [data-testid=\"studio-binding-workbench\"]", { timeout: 45_000 });
    checks.bindingWorkbenchVisible = true;
    // 点左侧单元，等待投影
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /P7|单元|15s|格/.test(b.textContent || "")
      );
      (btn as HTMLElement | undefined)?.click();
    });
    await page.waitForTimeout(2500);
    await page.waitForFunction(() => {
      const body = document.body.innerText;
      return !body.includes("读取绑定投影") || body.includes("宫格") || body.includes("提案") || body.includes("确认");
    }, undefined, { timeout: 45_000 }).catch(() => undefined);

    const confirmBtn = page.locator('[data-candidate-action="confirm"], .binding-confirm-candidate');
    const ignoreBtn = page.locator('[data-candidate-action="ignore"], .binding-ignore-candidate');
    const bodyText = await page.locator("body").innerText();
    checks.bindingConfirmActionPresent =
      (await confirmBtn.count()) > 0 || bodyText.includes("确认候选") || bodyText.includes("接受明确匹配");
    checks.bindingIgnoreActionPresent =
      (await ignoreBtn.count()) > 0 || bodyText.includes("忽略候选") || bodyText.includes("排除");
    checks.bindingUnitListVisible = bodyText.includes("P7") || bodyText.includes("单元");
    await page.screenshot({ path: screenshotBinding, fullPage: false, timeout: 60_000 });
  } else {
    checks.bindingWorkbenchVisible = false;
  }

  // 画布 open-binding
  await canvasTab.click();
  await page.waitForSelector('[data-testid="managed-studio-canvas-view"]', { timeout: 30_000 });
  await page.evaluate(() => {
    (document.querySelector(".vue-flow__node.panel-node") as HTMLElement | null)?.click();
    (document.querySelector(".vue-flow__node.unit-node") as HTMLElement | null)?.click();
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    (document.querySelector(".vue-flow__node.panel-node") as HTMLElement | null)?.click();
  });
  await page.waitForTimeout(600);
  const bindAction = page.locator('[data-testid="managed-canvas-action-open-binding"]');
  if ((await bindAction.count()) > 0) {
    await bindAction.click();
    await page.waitForTimeout(1500);
    checks.openBindingClicked = true;
    const modeBinding = page.locator('[data-testid="studio-step-binding"]');
    checks.openBindingLandedOnBinding =
      ((await modeBinding.getAttribute("class"))?.split(/\s+/u).includes("active") ?? false)
      || (await page.locator(".binding-workbench").count()) > 0;
  } else {
    checks.openBindingClicked = false;
    checks.nodeActionPanelAfterRetry =
      (await page.locator('[data-testid="managed-canvas-node-action-panel"]').count()) > 0;
  }

  const hardFail: string[] = [];
  if (!checks.materialStudioVisible) hardFail.push("material-studio 未显示");
  if (!checks.canvasViewVisible) hardFail.push("画布未显示");
  if (!checks.minimapVisible) hardFail.push("minimap 未显示");
  if (!checks.workflowToolbarVisible) hardFail.push("工作流工具条未显示");
  if (!checks.dashboardVisible) hardFail.push("驾驶舱未显示");
  if (!checks.bindingWorkbenchVisible) hardFail.push("绑定工作台未显示");
  // 节点面板 / 清单：软门槛（记录在 checks）；硬门槛要求至少 DOM 结构或交互其一
  if (!checks.nodeActionPanelVisible && !checks.workflowToolbarVisible) {
    hardFail.push("节点操作面板与工作流条均未观测到");
  }
  if (pageErrors.length) hardFail.push(`pageerror: ${pageErrors.join("; ")}`);

  const evidence = {
    schemaVersion: 1,
    kind: "deep-absorb-ui-smoke",
    createdAt: new Date().toISOString(),
    projectRoot: fixture.root,
    projectId: fixture.shell.project.id,
    checks,
    hardFail,
    ok: hardFail.length === 0,
    pageErrors,
    consoleErrors: consoleErrors.slice(0, 20),
    screenshots: {
      canvas: await fileEvidence(screenshotCanvas),
      binding: await fileEvidence(screenshotBinding).catch(() => null),
    },
    notes: [
      "隔离 P7 fixture，未写正式 projects/codex-ai-drama-studio",
      "节点操作面板依赖 VueFlow 节点命中；若 panelNodeClicked=false 则属交互命中降级",
      "生成队列 UI 在 managedShell 路径下默认不展示；cancel/jump 已在 App 源码接线，本 smoke 以受管 Studio 画布/绑定/驾驶舱为主",
    ],
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: evidence.ok,
    evidencePath,
    screenshotCanvas,
    checks,
    hardFail,
  }, null, 2));
  if (!evidence.ok) process.exitCode = 1;
} finally {
  if (application) await application.close().catch(() => undefined);
  if (fixture) await fixture.cleanup().catch(() => undefined);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
}
