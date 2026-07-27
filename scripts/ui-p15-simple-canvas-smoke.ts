/**
 * P15/P16 极简自由画布真实 Electron 烟测：
 * 空工作区轻量切换连线 → 添加素材/单元 → 左右加号点击连线 → 清空视图 →
 * 一键 Codex freeze+dispatch → 重启恢复。
 * 不调用外网模型，不登记图片结果，不把派发冒充生图完成。
 */
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import sharp from "sharp";
import { getStudioGenerationLedgerState } from "../src/core/studio-generation-ledger.js";
import { loadStudioCanvasLayout } from "../src/core/studio-canvas-layout-store.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "../tests/helpers/studio-p7-fixture.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspace, "docs", "evidence");
const evidencePath = path.resolve(process.argv[2] || path.join(evidenceRoot, "p15-simple-canvas-ui-smoke-20260719.json"));
const screenshotPath = path.resolve(process.argv[3] || path.join(evidenceRoot, "p15-simple-canvas-ui-smoke-20260719.png"));
const installedExecutable = process.env.AI_CANVAS_INSTALLED_APP_EXECUTABLE?.trim()
  ? path.resolve(process.env.AI_CANVAS_INSTALLED_APP_EXECUTABLE.trim())
  : undefined;

for (const output of [evidencePath, screenshotPath]) {
  const relative = path.relative(evidenceRoot, output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`P15 证据必须写入 docs/evidence：${output}`);
  }
  await access(output).then(
    () => { throw new Error(`P15 证据已存在，拒绝覆盖：${output}`); },
    () => undefined,
  );
  await mkdir(path.dirname(output), { recursive: true });
}
for (const built of ["out/main/index.js", "out/preload/index.mjs", "out/renderer/index.html"]) {
  await access(path.join(workspace, built)).catch(() => {
    throw new Error(`缺少 Electron 编译产物 ${built}；请先运行 npm run build。`);
  });
}
if (installedExecutable) {
  await access(installedExecutable).catch(() => {
    throw new Error(`安装版 Electron 可执行文件不可用：${installedExecutable}`);
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function progress(step: string): void {
  process.stdout.write(`[p15-ui] ${step}\n`);
}

async function fileEvidence(filePath: string): Promise<{ path: string; sizeBytes: number; sha256: string }> {
  const bytes = await readFile(filePath);
  const metadata = await stat(filePath);
  return { path: filePath, sizeBytes: metadata.size, sha256: sha256(bytes) };
}

async function absent(filePath: string): Promise<boolean> {
  return access(filePath).then(() => false, () => true);
}

async function launch(registryPath: string, projectRoot: string, userDataPath: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    ...(installedExecutable ? { executablePath: installedExecutable } : {}),
    args: [...(installedExecutable ? [] : ["."]), `--user-data-dir=${userDataPath}`],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_PROJECT_ROOT: projectRoot,
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(120_000);
  await page.setViewportSize({ width: 1728, height: 1029 });
  await page.locator('[data-testid="managed-studio-canvas-view"]').waitFor();
  await page.locator('[data-testid="managed-canvas-primary-start"]').waitFor();
  return { app, page };
}

async function closeApplication(target: ElectronApplication): Promise<void> {
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    target.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      fallbackTimer = setTimeout(() => {
        target.process().kill();
        resolve();
      }, 5_000);
    }),
  ]);
  if (fallbackTimer) clearTimeout(fallbackTimer);
}

async function addFirstAsset(
  page: Page,
  categoryLabel: "角色" | "场景" | "道具" = "角色",
  expectedPinnedCount = 1,
): Promise<void> {
  await page.locator('[data-testid="managed-canvas-add-node"]').click();
  const menu = page.locator(".add-menu");
  await menu.locator("button").filter({ hasText: categoryLabel }).click();
  // 分类切换会异步分页读取素材；旧探针只等到上一页残留行可见便点击，偶发在
  // refresh/rebuildGraph 尚未稳定时与固定节点读取交错。必须先等当前分类加载完成。
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="managed-studio-canvas-view"]')?.getAttribute("aria-busy") === "false"
  ));
  const row = page.locator(".canvas-library .library-list li").first();
  await row.waitFor();
  await row.locator(".pin-button").click();
  try {
    await page.waitForFunction(
      (count) => (
        document.querySelector('[data-testid="managed-studio-canvas-view"]')?.getAttribute("aria-busy") === "false"
        && document.querySelectorAll(".vue-flow__node.asset-node").length === count
      ),
      expectedPinnedCount,
      { timeout: 20_000 },
    );
  } catch {
    const diagnostic = await page.evaluate(() => ({
      error: document.querySelector(".canvas-error")?.textContent?.replace(/\s+/gu, " ").trim(),
      status: document.querySelector('[data-testid="managed-canvas-result-status"]')?.textContent?.replace(/\s+/gu, " ").trim(),
      library: document.querySelector(".canvas-library")?.textContent?.replace(/\s+/gu, " ").trim().slice(0, 500),
      assetNodes: document.querySelectorAll(".vue-flow__node.asset-node").length,
    }));
    throw new Error(`跨分类素材没有进入工作流画布：${JSON.stringify({ categoryLabel, expectedPinnedCount, diagnostic })}`);
  }
}

async function addUnit(page: Page, unitTitle: string): Promise<void> {
  await page.locator('[data-testid="managed-canvas-add-node"]').click();
  const menu = page.locator(".add-menu");
  await menu.locator("button").filter({ hasText: "15 秒分镜" }).click();
  const rows = page.locator(".canvas-library .unit-list li");
  const row = rows.filter({ hasText: unitTitle }).first();
  await row.waitFor();
  await row.locator(".pin-button").click();
  // Vue 的 async click handler 先展开宫格、再收起素材库并重新适配；等待最终稳定态，
  // 不能把中间一帧误当成“添加完成”。
  await page.waitForFunction(() => (
    !document.querySelector(".canvas-library")
    && document.querySelector('[data-testid="managed-studio-canvas-view"]')?.getAttribute("aria-busy") === "false"
    && document.querySelectorAll(".vue-flow__node.panel-node").length >= 2
  ));
  await page.waitForTimeout(300);
}

const temporaryBase = await realpath(os.tmpdir());
const runtimeRoot = await realpath(await mkdtemp(path.join(temporaryBase, "ai-canvas-p15-ui-")));
const registryPath = path.join(runtimeRoot, "registry", "projects.json");
const userDataPath = path.join(runtimeRoot, "user-data");
const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

let fixture: StudioP7Fixture | undefined;
let application: ElectronApplication | undefined;
let screenshotWritten = false;
let evidenceWritten = false;

try {
  progress("create fixture");
  fixture = await createStudioP7Fixture();
  progress("seed continuity");
  await seedStudioP7ResolvedContinuity(fixture);
  await registerProject(fixture.shell.project);
  await setActiveProjectRegistration(fixture.root);

  const unit = fixture.units.twoPanel;
  const beforeLedger = await getStudioGenerationLedgerState(fixture.root);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  let rendererCrashed = false;

  progress("launch electron");
  let launched = await launch(registryPath, fixture.root, userDataPath);
  application = launched.app;
  let page = launched.page;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (entry) => { if (entry.type() === "error") consoleErrors.push(entry.text()); });
  page.on("request", (request) => { if (/^https?:/iu.test(request.url())) externalRequests.push(request.url()); });
  page.on("crash", () => { rendererCrashed = true; });

  if (await page.locator(".canvas-library").count()) throw new Error("素材库应默认收起。 ");
  for (const testId of ["managed-canvas-add-node", "managed-canvas-open-library", "managed-canvas-connect-mode", "managed-canvas-primary-start"]) {
    if (await page.locator(`[data-testid="${testId}"]`).count() !== 1) throw new Error(`缺少极简主入口 ${testId}`);
  }
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="managed-studio-canvas-view"]')?.getAttribute("aria-busy") === "false"
    && document.querySelectorAll(".vue-flow__node").length > 0
  ));

  // P16 原始回归：历史实现点击“连线”会强制切到空 workflow 并重建整图，用户看到节点
  // 瞬间消失，表现为“卡住”。现在按钮只能切换轻量视觉辅助，节点和端点数量必须不变。
  const initialNodeCount = await page.locator(".vue-flow__node").count();
  const initialPlusCount = await page.locator('[data-testid="managed-canvas-node-left-plus"], [data-testid="managed-canvas-node-right-plus"]').count();
  if (initialNodeCount === 0 || initialPlusCount === 0) {
    throw new Error(`初始投影视图缺少节点或常驻加号：${JSON.stringify({ initialNodeCount, initialPlusCount })}`);
  }
  const connectToggleStartedAt = Date.now();
  await page.locator('[data-testid="managed-canvas-connect-mode"]').click();
  const connectToggleMs = Date.now() - connectToggleStartedAt;
  const toggledNodeCount = await page.locator(".vue-flow__node").count();
  const toggledPlusCount = await page.locator('[data-testid="managed-canvas-node-left-plus"], [data-testid="managed-canvas-node-right-plus"]').count();
  if (connectToggleMs > 1_500 || toggledNodeCount !== initialNodeCount || toggledPlusCount !== initialPlusCount) {
    throw new Error(`连线辅助仍触发卡顿或整图变化：${JSON.stringify({ connectToggleMs, initialNodeCount, toggledNodeCount, initialPlusCount, toggledPlusCount })}`);
  }
  await page.locator('[data-testid="managed-canvas-connect-mode"]').click();

  progress("canvas ready");
  await addFirstAsset(page, "角色", 1);
  await addFirstAsset(page, "场景", 2);
  await addFirstAsset(page, "道具", 3);
  progress("character/scene/prop pinned");
  await addUnit(page, unit.unit.title);
  progress("unit pinned and panels ready");
  await page.getByRole("button", { name: "适配", exact: true }).click();
  await page.waitForTimeout(300);

  // 实际拖动节点、缩放和中键平移，避免只凭配置声明“自由画布可用”。
  const draggableNode = page.locator(".vue-flow__node.asset-node").first();
  const draggableNodeId = await draggableNode.getAttribute("data-id");
  const dragBox = await draggableNode.boundingBox();
  if (!draggableNodeId || !dragBox) throw new Error("缺少可拖动素材节点或节点 ID。");
  const beforeDragLayout = await loadStudioCanvasLayout(fixture.root);
  const beforeDragPosition = beforeDragLayout?.nodes[draggableNodeId];
  await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + dragBox.width / 2 + 86, dragBox.y + dragBox.height / 2 + 42, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  const afterDragLayout = await loadStudioCanvasLayout(fixture.root);
  const afterDragPosition = afterDragLayout?.nodes[draggableNodeId];
  if (!beforeDragPosition || !afterDragPosition
    || (Math.abs(afterDragPosition.x - beforeDragPosition.x) < 25 && Math.abs(afterDragPosition.y - beforeDragPosition.y) < 20)) {
    throw new Error(`节点拖动没有持久化：${JSON.stringify({ draggableNodeId, beforeDragPosition, afterDragPosition })}`);
  }
  await draggableNode.click();
  await page.locator(".canvas-inspector").waitFor();
  await page.locator(".canvas-inspector .inspector-close").click();

  const beforeZoom = afterDragLayout?.viewport.zoom ?? 0;
  const beforeZoomTransform = await page.locator(".vue-flow__transformationpane").evaluate((element) => getComputedStyle(element).transform);
  await page.locator(".vue-flow__controls-zoomin").click();
  await page.waitForTimeout(1_200);
  const afterZoomTransform = await page.locator(".vue-flow__transformationpane").evaluate((element) => getComputedStyle(element).transform);
  const afterZoomLayout = await loadStudioCanvasLayout(fixture.root);
  if ((afterZoomLayout?.viewport.zoom ?? 0) <= beforeZoom) {
    throw new Error(`画布缩放没有生效：${JSON.stringify({ beforeZoom, after: afterZoomLayout?.viewport.zoom, beforeZoomTransform, afterZoomTransform })}`);
  }

  const pane = page.locator(".vue-flow__pane");
  const paneBox = await pane.boundingBox();
  if (!paneBox) throw new Error("画布平移区域不可用。");
  const beforePan = afterZoomLayout?.viewport;
  await page.mouse.move(paneBox.x + paneBox.width * 0.72, paneBox.y + paneBox.height * 0.72);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(paneBox.x + paneBox.width * 0.72 + 72, paneBox.y + paneBox.height * 0.72 + 38, { steps: 6 });
  await page.mouse.up({ button: "middle" });
  await page.waitForTimeout(1_200);
  const afterPanLayout = await loadStudioCanvasLayout(fixture.root);
  if (!beforePan || !afterPanLayout
    || (Math.abs(afterPanLayout.viewport.x - beforePan.x) < 20 && Math.abs(afterPanLayout.viewport.y - beforePan.y) < 20)) {
    throw new Error(`画布平移没有生效：${JSON.stringify({ beforePan, after: afterPanLayout?.viewport })}`);
  }
  await page.getByRole("button", { name: "适配", exact: true }).click();
  await page.waitForTimeout(300);
  const preConnectLayout = await loadStudioCanvasLayout(fixture.root);
  const source = page.locator('.vue-flow__node.asset-node [data-testid="managed-canvas-node-right-plus"]').first();
  const target = page.locator('.vue-flow__node.panel-node [data-testid="managed-canvas-node-left-plus"]').first();
  const sourceVisible = await source.isVisible().catch(() => false);
  const targetVisible = await target.isVisible().catch(() => false);
  if (!sourceVisible || !targetVisible) {
    const diagnostics = await page.evaluate(() => ({
      sourceCount: document.querySelectorAll('.vue-flow__node.asset-node [data-testid="managed-canvas-node-right-plus"]').length,
      targetCount: document.querySelectorAll('.vue-flow__node.panel-node [data-testid="managed-canvas-node-left-plus"]').length,
      assetNodes: document.querySelectorAll(".vue-flow__node.asset-node").length,
      panelNodes: document.querySelectorAll(".vue-flow__node.panel-node").length,
      logicalCounts: document.querySelector('[data-testid="managed-canvas-dom-counts"]')?.textContent?.replace(/\s+/gu, " ").trim(),
      connectPressed: document.querySelector('[data-testid="managed-canvas-connect-mode"]')?.getAttribute("aria-pressed"),
      flowTransform: getComputedStyle(document.querySelector(".vue-flow__transformationpane") ?? document.body).transform,
    }));
    throw new Error(`自由连线端点不可见：${JSON.stringify({
      sourceVisible,
      targetVisible,
      pinnedNodeIds: preConnectLayout?.pinnedNodeIds,
      diagnostics,
    })}`);
  }
  // 小云雀式入口：打开轻量连线提示后，直接点击一张图右侧的＋，再点击目标宫格左侧的＋。
  // 连接点本身始终可用，按钮只增强视觉提示，不能再重建画布。
  await page.locator('[data-testid="managed-canvas-connect-mode"]').click();
  await source.focus();
  await source.press("Enter");
  await target.focus();
  await target.press("Space");
  const draftEdge = page.locator(".draft-input-edge");
  await draftEdge.waitFor();
  progress("draft edge connected");

  // 反向加号：panel target 先点、asset source 后点，Loose 模式必须仍规范为 input→panel。
  const reverseTarget = page.locator('.vue-flow__node.panel-node [data-testid="managed-canvas-node-left-plus"]').nth(1);
  const reverseSource = page.locator('.vue-flow__node.asset-node [data-testid="managed-canvas-node-right-plus"]').nth(1);
  await reverseTarget.click();
  await reverseSource.click();
  await page.waitForFunction(() => document.querySelectorAll(".draft-input-edge").length === 2);

  // 重复连线与 panel→panel 非法连线必须失败关闭，不增加草稿边。
  await source.click();
  await target.click();
  await page.waitForFunction(() => document.querySelector(".canvas-error")?.textContent?.includes("边重复"));
  if (await page.locator(".draft-input-edge").count() !== 2) throw new Error("重复连线污染了草稿边。");
  await page.locator(".canvas-error button").click();
  const illegalSource = page.locator('.vue-flow__node.panel-node [data-testid="managed-canvas-node-right-plus"]').first();
  const illegalTarget = page.locator('.vue-flow__node.panel-node [data-testid="managed-canvas-node-left-plus"]').nth(1);
  await illegalSource.click();
  await illegalTarget.click();
  await page.waitForFunction(() => document.querySelector(".canvas-error")?.textContent?.includes("只需把角色"));
  if (await page.locator(".draft-input-edge").count() !== 2) throw new Error("非法连线污染了草稿边。");
  await page.locator(".canvas-error button").click();

  await page.locator('[data-testid="managed-canvas-toggle-edges"]').click();
  if (await page.locator(".draft-input-edge:visible").count() !== 0) throw new Error("隐藏连线未生效。");
  await page.locator('[data-testid="managed-canvas-toggle-edges"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".draft-input-edge").length === 2);

  // 草稿边可独立选中删除，再用加号恢复；不用清空整张画布。
  await page.locator(".draft-input-edge .vue-flow__edge-path").nth(1).click({ force: true });
  await page.locator('[data-testid="managed-canvas-delete-edge"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".draft-input-edge").length === 1);
  await reverseTarget.click();
  await reverseSource.click();
  await page.waitForFunction(() => document.querySelectorAll(".draft-input-edge").length === 2);
  await page.waitForTimeout(2_000);

  const draftLayout = await loadStudioCanvasLayout(fixture.root);
  if (draftLayout?.workspaceMode !== "workflow" || draftLayout.draftCanvasEdges.length !== 2
    || draftLayout.pinnedNodeIds.filter((id) => id.startsWith("asset:")).length !== 3
    || !draftLayout.pinnedNodeIds.includes(`unit:${unit.unit.id}`)) {
    const layoutStatus = await page.locator('[data-testid="managed-canvas-layout-status"]').textContent().catch(() => null);
    const uiError = await page.locator(".canvas-error").textContent().catch(() => null);
    throw new Error(`自由画布草稿没有按视图合同落盘：${JSON.stringify({ draftLayout, layoutStatus, uiError })}`);
  }

  const beforeMismatchLedger = await getStudioGenerationLedgerState(fixture.root);
  await page.locator('[data-testid="managed-canvas-primary-start"]').click();
  await page.waitForFunction(() => {
    const text = document.querySelector(".canvas-error")?.textContent ?? "";
    return text.includes("连线不完整") && (text.includes("剧本") || text.includes("提示词"));
  });
  const afterMismatchLedger = await getStudioGenerationLedgerState(fixture.root);
  if (afterMismatchLedger.counts.packs !== beforeMismatchLedger.counts.packs
    || afterMismatchLedger.counts.dispatches !== beforeMismatchLedger.counts.dispatches) {
    throw new Error("带线 Start 不完整预检在失败前产生了账本副作用。");
  }
  await page.locator(".canvas-error button").click();

  // 单项 remove 同时剪掉相关草稿边，不依赖“清空”全量操作。
  await page.locator('[data-testid="managed-canvas-add-node"]').click();
  await page.locator(".add-menu button").filter({ hasText: "角色" }).click();
  const pinnedCharacterRow = page.locator(".canvas-library .library-list li").filter({ has: page.locator('.pin-button', { hasText: "移出画布" }) }).first();
  await pinnedCharacterRow.locator(".pin-button").click();
  await page.waitForFunction(() => document.querySelectorAll(".vue-flow__node.asset-node").length === 2);
  await page.waitForTimeout(800);
  const afterRemoveLayout = await loadStudioCanvasLayout(fixture.root);
  if (afterRemoveLayout?.pinnedNodeIds.filter((id) => id.startsWith("asset:")).length !== 2
    || afterRemoveLayout.draftCanvasEdges.length !== 1) {
    throw new Error(`单项移除未剪掉节点/连线：${JSON.stringify(afterRemoveLayout)}`);
  }
  await page.locator(".canvas-library > header button").click();

  const clearButton = page.getByRole("button", { name: "清空画布视图", exact: true });
  await clearButton.click();
  await page.getByRole("button", { name: "再点一次确认清空", exact: true }).waitFor();
  if (await page.locator(".draft-input-edge").count() !== 1) throw new Error("清空确认第一步不应提前修改画布。");
  await page.getByRole("button", { name: "再点一次确认清空", exact: true }).click();
  await page.waitForFunction(() => (
    ![...document.querySelectorAll(".bottom-tools button")].some((button) => button.textContent?.includes("清空画布视图"))
    && document.querySelectorAll(".vue-flow__node").length > 0
  ));
  await page.waitForTimeout(1_000);
  const clearedLayout = await loadStudioCanvasLayout(fixture.root);
  if (clearedLayout?.workspaceMode !== "projection" || clearedLayout.pinnedNodeIds.length !== 0
    || clearedLayout.draftCanvasEdges.length !== 0 || clearedLayout.workflowGroups.length !== 0) {
    throw new Error(`清空画布视图后没有安全回到可浏览投影：${JSON.stringify(clearedLayout)}`);
  }
  await addFirstAsset(page, "角色", 1);
  await addFirstAsset(page, "场景", 2);
  await addFirstAsset(page, "道具", 3);
  await addUnit(page, unit.unit.title);
  progress("workspace reset and asset/unit restored");
  await page.locator('[data-testid="managed-canvas-primary-start"]').click();
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-testid="managed-canvas-result-status"]')?.textContent ?? "";
    return text.includes("已交给后台生成") || text.includes("派发未完成") || text.includes("需要处理");
  });
  const resultStatus = (await page.locator('[data-testid="managed-canvas-result-status"]').innerText()).replace(/\s+/gu, " ");
  if (!resultStatus.includes("已交给后台生成") || !resultStatus.includes("失败 0")) {
    throw new Error(`一键开始没有完成 freeze+Codex dispatch：${resultStatus}`);
  }
  const afterLedger = await getStudioGenerationLedgerState(fixture.root);
  progress("codex dispatch verified");
  if (afterLedger.counts.dispatches !== beforeLedger.counts.dispatches + unit.panels.length
    || afterLedger.counts.results !== beforeLedger.counts.results) {
    throw new Error(`一键开始账本结果不符：before=${JSON.stringify(beforeLedger.counts)} after=${JSON.stringify(afterLedger.counts)}`);
  }
  await page.locator('[data-testid="managed-canvas-primary-start"]').click();
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="managed-canvas-primary-start"]') as HTMLButtonElement | null;
    const status = document.querySelector('[data-testid="managed-canvas-result-status"]')?.textContent ?? "";
    return button?.disabled === false && status.includes("成功 2") && status.includes("失败 0");
  });
  const afterDuplicateStartLedger = await getStudioGenerationLedgerState(fixture.root);
  if (afterDuplicateStartLedger.counts.packs !== afterLedger.counts.packs
    || afterDuplicateStartLedger.counts.dispatches !== afterLedger.counts.dispatches
    || afterDuplicateStartLedger.counts.results !== afterLedger.counts.results) {
    throw new Error(`重复点击开始产生了重复派发：first=${JSON.stringify(afterLedger.counts)} duplicate=${JSON.stringify(afterDuplicateStartLedger.counts)}`);
  }
  if (await page.locator(".canvas-error").count()) {
    throw new Error(`重复点击开始虽然账本幂等，但界面仍报错：${await page.locator(".canvas-error").innerText()}`);
  }

  const canvasNodes = await page.locator(".vue-flow__node").evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      className: element.className,
      title: element.querySelector(".title")?.textContent?.trim() ?? "",
      transform: (element as HTMLElement).style.transform,
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }));
  const maxNodeWidth = Math.max(...canvasNodes.map((node) => node.width));
  const maxNodeHeight = Math.max(...canvasNodes.map((node) => node.height));
  if (maxNodeWidth > 260 || maxNodeHeight > 260) {
    throw new Error(`画布节点尺寸失控或遮罩撑满画布：${JSON.stringify({ maxNodeWidth, maxNodeHeight, canvasNodes })}`);
  }
  const panelRects = canvasNodes.filter((node) => node.className.includes("panel-node")).sort((a, b) => a.top - b.top);
  const panelRowsSeparated = panelRects.every((node, index) => (
    index === 0 || node.top >= panelRects[index - 1]!.top + panelRects[index - 1]!.height + 4
  ));
  if (!panelRowsSeparated) {
    throw new Error(`宫格节点纵向重叠：${JSON.stringify(panelRects)}`);
  }
  progress(`node layout bounded: ${canvasNodes.length} nodes, max ${maxNodeWidth}×${maxNodeHeight}`);

  const screenshot = await page.screenshot({ type: "png" });
  await writeFile(screenshotPath, screenshot, { flag: "wx" });
  screenshotWritten = true;
  await closeApplication(application);
  application = undefined;

  progress("restart electron");
  launched = await launch(registryPath, fixture.root, userDataPath);
  application = launched.app;
  page = launched.page;
  await page.waitForFunction((input) => (
    (Boolean(document.querySelector(`.vue-flow__node.unit-node [data-id="${input.unitId}"]`))
      || document.querySelectorAll(".vue-flow__node.unit-node").length === 1)
    && document.querySelectorAll(".vue-flow__node.panel-node").length === input.panelCount
    && document.querySelectorAll(".vue-flow__node.raw-node, .vue-flow__node.labeled-node, .vue-flow__node.review-node").length === input.panelCount * 3
  ), { unitId: unit.unit.id, panelCount: unit.panels.length });
  const reloadedLayout = await loadStudioCanvasLayout(fixture.root);
  if (reloadedLayout?.workspaceMode !== "workflow"
    || !reloadedLayout.pinnedNodeIds.includes(`unit:${unit.unit.id}`)
    || !reloadedLayout.pinnedNodeIds.some((id) => id.startsWith("asset:"))
    || reloadedLayout.draftCanvasEdges.length !== 0) {
    throw new Error("退出重开后自由工作区没有保持已固定单元和已清空草稿边。 ");
  }
  await closeApplication(application);
  application = undefined;
  progress("restart state verified");

  if (pageErrors.length || consoleErrors.length || externalRequests.length || rendererCrashed) {
    throw new Error(`P15 Electron 出现错误、崩溃或外网请求：${JSON.stringify({ pageErrors, consoleErrors, externalRequests, rendererCrashed })}`);
  }
  const screenshotInfo = await fileEvidence(screenshotPath);
  const releaseManifest = JSON.parse(await readFile(path.join(workspace, "release-manifest.json"), "utf8")) as {
    sourceDigest: string;
    buildId: string;
    capabilities: { mcpToolCount: number };
  };
  const metadata = await sharp(screenshotPath).metadata();
  const stats = await sharp(screenshotPath).stats();
  const stdev = Math.max(...stats.channels.map((channel) => channel.stdev));
  if ((metadata.width ?? 0) < 1_400 || (metadata.height ?? 0) < 850 || screenshotInfo.sizeBytes < 30_000 || stdev < 5) {
    throw new Error("P15 UI 截图疑似空白或占位图。 ");
  }

  const fixtureRoot = fixture.root;
  const projectId = fixture.shell.project.id;
  await fixture.cleanup();
  fixture = undefined;
  await rm(runtimeRoot, { recursive: true, force: true });
  const cleanup = { fixture: await absent(fixtureRoot), runtime: await absent(runtimeRoot) };
  if (!cleanup.fixture || !cleanup.runtime) throw new Error(`隔离烟测清理失败：${JSON.stringify(cleanup)}`);

  const evidence = {
    schemaVersion: 1,
    kind: "p15-simple-canvas-ui-smoke",
    status: "pass",
    createdAt: new Date().toISOString(),
    buildIdentity: releaseManifest,
    projectId,
    runtime: installedExecutable ? "installed-app" : "workspace-build",
    ui: {
      simpleEntrypoints: ["添加", "素材库", "连线", "开始"],
      libraryCollapsedByDefault: true,
      freeDrag: true,
      nodeInspectorOpenClose: true,
      zoomControl: true,
      middleButtonPan: true,
      connectionHandles: true,
      plusConnectorsAlwaysVisible: true,
      plusToPlusConnection: true,
      reversePlusConnection: true,
      keyboardPlusConnectionGuard: true,
      duplicateEdgeRejected: true,
      illegalEdgeRejected: true,
      partialDraftStartRejectedBeforeLedgerWrite: true,
      individualRemovePrunedEdge: true,
      selectedEdgeDeleteAndReconnect: true,
      hideShowEdges: true,
      connectTogglePreservedNodeCount: true,
      connectToggleMs,
      nodeLayoutBounded: true,
      visibleNodeCount: canvasNodes.length,
      maxNodeWidth,
      maxNodeHeight,
      panelRowsSeparated,
      crossCategoryPinnedAssets: 3,
      draftEdgePersisted: true,
      clearWorkspaceIsViewOnly: true,
      clearWorkspaceRequiresConfirmation: true,
      restartPreserved: true,
      restartExpandedPanels: true,
      provider: "codex",
      duplicateStartIdempotent: true,
      externalRequests: 0,
      pageErrors: 0,
      consoleErrors: 0,
      rendererCrashed: false,
    },
    production: {
      targetPanels: unit.panels.length,
      packsAdded: afterLedger.counts.packs - beforeLedger.counts.packs,
      dispatchesAdded: afterLedger.counts.dispatches - beforeLedger.counts.dispatches,
      resultsAdded: afterLedger.counts.results - beforeLedger.counts.results,
      realImageGenerated: false,
      visualReviewClaimed: false,
    },
    safety: {
      draftIsNotBindingSource: true,
      formalFreezeRebuiltByOwner: true,
      noBrowserGeneration: true,
      noUpload: true,
      noPayment: true,
      noPublish: true,
      isolatedFixtureCleaned: cleanup,
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
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  if (application) await closeApplication(application).catch(() => undefined);
  if (fixture) await fixture.cleanup().catch(() => undefined);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
  if (!evidenceWritten) await rm(evidencePath, { force: true }).catch(() => undefined);
  if (!screenshotWritten || !evidenceWritten) await rm(screenshotPath, { force: true }).catch(() => undefined);
}
