/**
 * P13/P14 安装版“零说明桌面生产闭环”真实 UI smoke。
 *
 * 只接受显式安装版可执行文件、全新证据 JSON 与全新截图目录；运行期间仅使用
 * 临时 HOME/userData/registry/受管工程。脚本不会安装应用、不会修复 Agent 配置、
 * 不会打开或写入正式工程，也不会调用任何外部生图供应方。
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright";
import sharp from "sharp";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import { saveStudioCanvasLayout } from "../src/core/studio-canvas-layout-store.js";
import { inspectManagedProject } from "../src/core/managed-project.js";
import { readReleaseManifest } from "../src/core/release-manifest.js";
import { registerProject } from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "../tests/helpers/studio-p7-fixture.js";
import {
  assertP13P14InstalledUiSmokeEvidence,
  assertPathInsideOneOf,
  P13_P14_INSTALLED_UI_SCREENSHOTS,
  parseP13P14InstalledUiSmokeCli,
  type P13P14InstalledUiSmokeEvidence,
  type P13P14InstalledUiSmokeScreenshotEvidence,
} from "./p13-p14-installed-ui-smoke-guards.js";

const cli = parseP13P14InstalledUiSmokeCli(process.argv.slice(2));
const executableStats = await stat(cli.executablePath).catch(() => null);
if (!executableStats?.isFile()) throw new Error(`安装版可执行文件不存在或不是普通文件：${cli.executablePath}`);
await access(cli.executablePath, constants.X_OK).catch(() => {
  throw new Error(`安装版可执行文件不可执行：${cli.executablePath}`);
});
await access(cli.evidencePath).then(
  () => { throw new Error(`证据已存在，拒绝覆盖：${cli.evidencePath}`); },
  () => undefined,
);
await access(cli.screenshotDirectory).then(
  () => { throw new Error(`截图目录必须是全新路径，拒绝复用：${cli.screenshotDirectory}`); },
  () => undefined,
);

const appMarker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
const appBundleRoot = cli.executablePath.slice(0, cli.executablePath.indexOf(appMarker));
const releaseManifestPath = path.join(appBundleRoot, "Contents", "Resources", "release-manifest.json");
const releaseManifest = await readReleaseManifest(releaseManifestPath);
if (!releaseManifest.localOnly || releaseManifest.distribution !== "local-only") {
  throw new Error("安装版 release manifest 不是 local-only，拒绝运行本机验收。");
}

await mkdir(path.dirname(cli.evidencePath), { recursive: true });
await mkdir(path.dirname(cli.screenshotDirectory), { recursive: true });
await mkdir(cli.screenshotDirectory);

const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p13-p14-installed-ui-")));
const homeRoot = path.join(runtimeRoot, "home");
const documentsRoot = path.join(homeRoot, "Documents");
const tempRoot = path.join(runtimeRoot, "tmp");
const userDataRoot = path.join(runtimeRoot, "electron-user-data");
const registryPath = path.join(runtimeRoot, "registry", "projects.json");
const mediaRuntimeRoot = path.join(runtimeRoot, "media-runtime");
const defaultProjectRoot = path.join(runtimeRoot, "default-project-root");
const projectsParent = path.join(runtimeRoot, "projects");
const backupParent = path.join(runtimeRoot, "backups");
const restoreParent = path.join(runtimeRoot, "restores");
await Promise.all([
  homeRoot,
  documentsRoot,
  tempRoot,
  userDataRoot,
  path.dirname(registryPath),
  mediaRuntimeRoot,
  defaultProjectRoot,
  projectsParent,
  backupParent,
  restoreParent,
].map((directory) => mkdir(directory, { recursive: true })));

const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

interface DialogRoutes {
  managedProjectsParent: string;
  backupParent: string;
  restoreBackupRoot?: string;
  restoreParent: string;
}

interface ActiveRegistration {
  id: string;
  name: string;
  primaryRoot: string;
  available: boolean;
}

const screenshots: P13P14InstalledUiSmokeScreenshotEvidence[] = [];
const pageErrors: string[] = [];
const consoleErrors: string[] = [];
const externalRequests: string[] = [];
let fixture: StudioP7Fixture | undefined;
let application: ElectronApplication | undefined;
let applicationClosed = false;
let runtimeRootRemoved = false;
let fixtureRootRemoved = false;

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function absent(candidate: string): Promise<boolean> {
  return access(candidate).then(() => false, () => true);
}

async function writeEvidenceExclusiveAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await link(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function capture(page: Page, fileName: typeof P13_P14_INSTALLED_UI_SCREENSHOTS[number]): Promise<void> {
  const screenshotPath = path.join(cli.screenshotDirectory, fileName);
  if (!(await absent(screenshotPath))) throw new Error(`截图已存在，拒绝覆盖：${screenshotPath}`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const bytes = await readFile(screenshotPath);
  const [metadata, imageStats, fileStats] = await Promise.all([
    sharp(bytes).metadata(),
    sharp(bytes).stats(),
    stat(screenshotPath),
  ]);
  const evidence = {
    fileName,
    path: screenshotPath,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    sizeBytes: fileStats.size,
    sha256: sha256(bytes),
    maxChannelStandardDeviation: Math.max(...imageStats.channels.map((channel) => channel.stdev)),
  } satisfies P13P14InstalledUiSmokeScreenshotEvidence;
  if (evidence.width < 1_200 || evidence.height < 700 || evidence.sizeBytes < 20_000
    || evidence.maxChannelStandardDeviation < 3) {
    throw new Error(`截图疑似空白、占位或尺寸不足：${JSON.stringify(evidence)}`);
  }
  screenshots.push(evidence);
}

function observe(page: Page): void {
  page.setDefaultTimeout(120_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    if (/^https?:/iu.test(request.url())) externalRequests.push(request.url());
  });
}

async function installDialogRouter(target: ElectronApplication, routes: DialogRoutes): Promise<void> {
  // Playwright 会把 evaluate 回调的函数源码序列化到 Electron 主进程。
  // tsx/esbuild 的 keepNames 转换可能使内联回调依赖宿主侧 __name helper；
  // Function 构造器保留自包含源码，安装版中不会引用外部 helper。
  const evaluation = new Function("electron", "initialRoutes", `
    const dialog = electron.dialog;
    const scoped = globalThis;
    scoped.__aiCanvasP13P14DialogRoutes = initialRoutes;
    const replacement = async (...args) => {
      const options = args.at(-1) || {};
      const title = options.title || "";
      const current = scoped.__aiCanvasP13P14DialogRoutes;
      if (!current) throw new Error("P13/P14 UI smoke 原生目录路由未初始化。");
      if (title === "选择 AI 漫剧工程保存位置") return { canceled: false, filePaths: [current.managedProjectsParent] };
      if (title === "选择 AI 漫剧项目主根") return { canceled: true, filePaths: [] };
      if (title === "选择备份保存位置") return { canceled: false, filePaths: [current.backupParent] };
      if (title === "选择要恢复的备份目录") {
        if (!current.restoreBackupRoot) throw new Error("恢复入口在备份完成前被触发，已失败关闭。");
        return { canceled: false, filePaths: [current.restoreBackupRoot] };
      }
      if (title === "选择恢复后的新位置（不会覆盖原工程）") return { canceled: false, filePaths: [current.restoreParent] };
      throw new Error("P13/P14 UI smoke 拒绝未声明的原生文件选择器：" + (title || "(无标题)"));
    };
    Object.defineProperty(dialog, "showOpenDialog", { configurable: true, value: replacement });
  `) as unknown as (electronModule: typeof import("electron"), initialRoutes: DialogRoutes) => void;
  await target.evaluate(evaluation, routes);
}

async function updateRestoreBackupRoute(target: ElectronApplication, backupRoot: string): Promise<void> {
  const evaluation = new Function("electron", "selectedBackupRoot", `
    const scoped = globalThis;
    if (!scoped.__aiCanvasP13P14DialogRoutes) throw new Error("P13/P14 UI smoke 原生目录路由未初始化。");
    scoped.__aiCanvasP13P14DialogRoutes.restoreBackupRoot = selectedBackupRoot;
  `) as unknown as (electronModule: typeof import("electron"), selectedBackupRoot: string) => void;
  await target.evaluate(evaluation, backupRoot);
}

async function launch(routes: DialogRoutes): Promise<{ application: ElectronApplication; page: Page }> {
  const launched = await electron.launch({
    executablePath: cli.executablePath,
    args: [`--user-data-dir=${userDataRoot}`],
    cwd: runtimeRoot,
    env: {
      ...process.env,
      HOME: homeRoot,
      TMPDIR: tempRoot,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_MEDIA_RUNTIME_DIR: mediaRuntimeRoot,
      AI_CANVAS_PROJECT_ROOT: defaultProjectRoot,
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  await installDialogRouter(launched, routes);
  const page = await launched.firstWindow();
  observe(page);
  await page.setViewportSize({ width: 1728, height: 1029 });
  return { application: launched, page };
}

async function activeProject(page: Page): Promise<ActiveRegistration | null> {
  return page.evaluate(async () => {
    const bridge = (window as unknown as {
      canvasApi: { getActiveProject(): Promise<ActiveRegistration | null> };
    }).canvasApi;
    const active = await bridge.getActiveProject();
    if (!active) return null;
    return {
      id: active.id,
      name: active.name,
      primaryRoot: active.primaryRoot,
      available: active.available,
    };
  });
}

async function waitManagedProject(
  page: Page,
  expectedName: string,
  expectedLocation: { root?: string; parent?: string } = {},
): Promise<ActiveRegistration> {
  await page.locator('[data-testid="material-studio-view"]').waitFor();
  const deadline = Date.now() + 120_000;
  let active: ActiveRegistration | null = null;
  while (Date.now() < deadline) {
    active = await activeProject(page);
    const parentRelative = expectedLocation.parent && active
      ? path.relative(path.resolve(expectedLocation.parent), path.resolve(active.primaryRoot))
      : undefined;
    const locationMatched = expectedLocation.root
      ? active?.primaryRoot === path.resolve(expectedLocation.root)
      : expectedLocation.parent
        ? Boolean(parentRelative) && parentRelative !== ".." && !parentRelative!.startsWith(`..${path.sep}`) && !path.isAbsolute(parentRelative!)
        : true;
    const viewReady = await page.locator('[data-testid="material-studio-view"]').getAttribute("aria-busy") === "false";
    const heading = await page.locator(".studio-header h1").textContent().catch(() => "");
    if (active?.available && active.name === expectedName && locationMatched && viewReady && heading?.includes(expectedName)) break;
    active = null;
    await page.waitForTimeout(100);
  }
  if (!active?.available || active.name !== expectedName) {
    throw new Error(`活动工程没有切到预期工程和显式位置：${JSON.stringify({ expectedName, expectedLocation, active })}`);
  }
  return active;
}

async function waitForRestoreFeedback(page: Page): Promise<string> {
  const feedbackHandle = await page.waitForFunction(() => {
    const supportNotice = document.querySelector<HTMLElement>('[data-testid="desktop-support-view"] .notice');
    const toast = document.querySelector<HTMLElement>(".toast-message");
    const supportText = supportNotice?.textContent?.trim() ?? "";
    const toastText = toast?.textContent?.trim() ?? "";
    if (supportNotice?.classList.contains("error")) return { text: supportText, error: true };
    if (toast?.classList.contains("error")) return { text: toastText, error: true };
    const text = [supportText, toastText].find((candidate) => /已恢复|恢复到新目录/u.test(candidate));
    return text ? { text, error: false } : null;
  });
  const feedback = await feedbackHandle.jsonValue() as { text: string; error: boolean };
  if (feedback.error || !/已恢复|恢复到新目录/u.test(feedback.text)) {
    throw new Error(`安装版恢复入口失败：${feedback.text || "界面未提供错误说明"}`);
  }
  return feedback.text;
}

async function clickNodeInsideFlowViewport(node: Locator): Promise<void> {
  const geometry = await node.evaluate((element) => {
    const nodeRect = element.getBoundingClientRect();
    const flowRect = element.closest(".flow-shell")?.getBoundingClientRect();
    if (!flowRect) return null;
    const left = Math.max(nodeRect.left, flowRect.left);
    const right = Math.min(nodeRect.right, flowRect.right);
    const top = Math.max(nodeRect.top, flowRect.top);
    const bottom = Math.min(nodeRect.bottom, flowRect.bottom);
    if (right <= left || bottom <= top) return null;
    const clientX = left + (right - left) / 2;
    const clientY = top + (bottom - top) / 2;
    const hit = document.elementFromPoint(clientX, clientY);
    return {
      x: clientX - nodeRect.left,
      y: clientY - nodeRect.top,
      visibleWidth: right - left,
      visibleHeight: bottom - top,
      hitNode: hit?.closest(".vue-flow__node") === element,
    };
  });
  if (!geometry || geometry.visibleWidth < 8 || geometry.visibleHeight < 8 || !geometry.hitNode) {
    throw new Error(`画布节点没有用户可点击的可见区域：${JSON.stringify(geometry)}`);
  }
  await node.click({ position: { x: geometry.x, y: geometry.y } });
}

async function openProjectCenterAndSwitch(
  page: Page,
  projectName: string,
  projectRoot?: string,
): Promise<ActiveRegistration> {
  await page.getByRole("button", { name: "项目", exact: true }).click();
  // 备份恢复保留 projectId 与名称，因此项目中心可能同时出现同名原工程和
  // 恢复副本。切换时用显式根路径消歧，绝不偷点第一条同名记录。
  const row = page.locator(".project-row").filter({ hasText: projectRoot ?? projectName });
  await row.waitFor();
  await row.click();
  return waitManagedProject(page, projectName, projectRoot ? { root: projectRoot } : {});
}

async function singleBackupRoot(parent: string): Promise<string> {
  const directories = (await readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name));
  if (directories.length !== 1) throw new Error(`备份目录数量不是 1：${JSON.stringify(directories)}`);
  return realpath(directories[0]!);
}

try {
  fixture = await createStudioP7Fixture();
  await seedStudioP7ResolvedContinuity(fixture);
  const fixturePanel = fixture.units.sixPanel.panels[0]!;
  const fixtureMedia = fixture.panelMediaPairs.find((entry) => entry.panelId === fixturePanel.id);
  if (!fixtureMedia) throw new Error(`P7 fixture 缺少宫格结果对：${fixturePanel.id}`);
  const fixturePack = await freezeAndPersistStudioGenerationPack(fixture.root, {
    unitId: fixture.units.sixPanel.unit.id,
    panelId: fixturePanel.id,
  });
  const generationRunId = "p13-p14-installed-ui-run-001";
  await dispatchStudioGenerationPack(fixture.root, {
    packId: fixturePack.packId,
    packFingerprint: fixturePack.fingerprint,
    generationRunId,
    provider: "codex",
  });
  await registerStudioGenerationResult(fixture.root, {
    packId: fixturePack.packId,
    packFingerprint: fixturePack.fingerprint,
    generationRunId,
    variant: "raw",
    mediaSha256: fixtureMedia.raw.imported.sha256,
    provider: "codex",
  });
  await registerStudioGenerationResult(fixture.root, {
    packId: fixturePack.packId,
    packFingerprint: fixturePack.fingerprint,
    generationRunId,
    variant: "labeled",
    mediaSha256: fixtureMedia.labeled.imported.sha256,
    provider: "codex",
  });
  await saveStudioCanvasLayout(fixture.root, {
    patch: {
      viewport: { x: -500, y: 80, zoom: 0.55 },
      updatedAt: new Date().toISOString(),
    },
  });

  const routes: DialogRoutes = { managedProjectsParent: projectsParent, backupParent, restoreParent };
  let launched = await launch(routes);
  application = launched.application;
  let page = launched.page;

  const firstRun = page.locator('[data-testid="first-run-screen"]');
  await firstRun.waitFor();
  const firstRunEntries = ["first-run-create", "first-run-recent", "first-run-import"] as const;
  for (const entry of firstRunEntries) {
    if (!(await page.locator(`[data-testid="${entry}"]`).isVisible())) throw new Error(`首次启动入口不可见：${entry}`);
  }
  if (!(await page.locator('[data-testid="first-run-recent"]').isDisabled())) {
    throw new Error("空注册表首次启动时“打开最近工程”没有失败关闭。");
  }
  await capture(page, "01-first-run.png");

  await page.locator('[data-testid="first-run-import"]').click();
  await firstRun.waitFor();
  if (await activeProject(page)) throw new Error("取消导入后意外产生了活动工程。");

  await page.locator('[data-testid="first-run-create"]').click();
  const createForm = page.locator('[data-testid="managed-project-create"]');
  await createForm.waitFor();
  await createForm.getByRole("button", { name: "更改位置" }).click();
  await createForm.getByText(projectsParent, { exact: false }).waitFor();
  await createForm.locator('input[name="managed-project-name"]').fill("P14 零说明桌面验收工程");
  await createForm.getByRole("button", { name: "建立并打开工程" }).click();
  const createdRegistration = await waitManagedProject(page, "P14 零说明桌面验收工程", { parent: projectsParent });
  assertPathInsideOneOf(createdRegistration.primaryRoot, [projectsParent], "UI 新建工程");
  const createdShell = await inspectManagedProject(createdRegistration.primaryRoot);
  if (createdShell.project.sourceRoots.length !== 0) throw new Error("UI 新建工程 sourceRoots 不是空数组。");

  await page.getByRole("button", { name: "帮助 / 备份", exact: true }).click();
  const helpSupport = page.locator('[data-testid="desktop-support-view"]');
  await helpSupport.waitFor();
  await helpSupport.getByRole("button", { name: "备份当前工程" }).click();
  await helpSupport.locator(".notice").filter({ hasText: "备份已完成" }).waitFor();
  const backupRoot = await singleBackupRoot(backupParent);
  assertPathInsideOneOf(backupRoot, [backupParent], "一致备份");
  await updateRestoreBackupRoute(application, backupRoot);
  await capture(page, "02-help-backup-restore.png");
  await helpSupport.getByRole("button", { name: "恢复到新目录" }).click();
  await waitForRestoreFeedback(page);
  const restoredRegistration = await waitManagedProject(page, "P14 零说明桌面验收工程", { parent: restoreParent });
  assertPathInsideOneOf(restoredRegistration.primaryRoot, [restoreParent], "UI 恢复工程");
  if (restoredRegistration.primaryRoot === createdRegistration.primaryRoot) {
    throw new Error("恢复覆盖了原工程，未落到新目录。");
  }

  await application.close();
  application = undefined;
  launched = await launch({ ...routes, restoreBackupRoot: backupRoot });
  application = launched.application;
  page = launched.page;
  const restartedRegistration = await waitManagedProject(page, "P14 零说明桌面验收工程", { root: restoredRegistration.primaryRoot });
  if (restartedRegistration.primaryRoot !== restoredRegistration.primaryRoot) {
    throw new Error("重启后没有恢复显式活动的恢复工程。");
  }
  await capture(page, "03-restart-restored-project.png");

  await page.getByRole("button", { name: "Agent 连接", exact: true }).click();
  const agentSupport = page.locator('[data-testid="desktop-support-view"]');
  await agentSupport.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="desktop-support-view"]')?.getAttribute("aria-busy") === "false");
  const agentStatusText = await agentSupport.innerText();
  for (const label of ["CODEX", "GROK", "画布连接服务", "只在你明确点击后才修复配置"]) {
    if (!agentStatusText.includes(label)) throw new Error(`Agent 连接页缺少状态：${label}`);
  }
  await capture(page, "04-agent-connection.png");

  await registerProject(fixture.shell.project);
  const fixtureRegistration = await openProjectCenterAndSwitch(page, fixture.shell.project.name);
  assertPathInsideOneOf(fixtureRegistration.primaryRoot, [fixture.parentRoot], "P7 UI fixture 工程");
  const switchedBack = await openProjectCenterAndSwitch(page, restoredRegistration.name, restoredRegistration.primaryRoot);
  if (switchedBack.primaryRoot !== restoredRegistration.primaryRoot) throw new Error("切回恢复工程发生串库。");
  const switchedFixture = await openProjectCenterAndSwitch(page, fixture.shell.project.name);
  if (switchedFixture.primaryRoot !== fixture.root) throw new Error("再次切入 fixture 发生串库。");

  await page.locator('[data-testid="studio-step-script"]').click();
  await page.getByText("P7 确定性夹具剧本", { exact: false }).first().waitFor();
  await page.locator(".section-rail .rail-entry").filter({ hasText: "提示词" }).click();
  await page.getByText("P7 确定性夹具提示词", { exact: false }).first().waitFor();
  await page.locator('[data-testid="studio-step-assets"]').click();
  for (const expected of [
    { section: "角色", item: "阿航" },
    { section: "场景", item: "石室" },
    { section: "道具", item: "完整黄金面具" },
  ]) {
    await page.locator(".section-rail .rail-entry").filter({ hasText: expected.section }).click();
    await page.getByText(expected.item, { exact: false }).first().waitFor();
  }
  await page.locator('[data-testid="studio-step-binding"]').click();
  await page.locator('[data-testid="studio-binding-workbench"]').waitFor();
  await page.locator('[data-testid="studio-step-generation"]').click();
  await page.locator('[data-testid="studio-generation-pane"]').waitFor();
  await page.locator('[data-testid="studio-step-review"]').click();
  await page.locator('[data-testid="continuity-business-empty"]').waitFor();

  await page.locator('[data-testid="studio-mode-canvas"]').click();
  const canvas = page.locator('[data-testid="managed-studio-canvas-view"]');
  await canvas.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="managed-studio-canvas-view"]')?.getAttribute("aria-busy") === "false");
  const metrics = (await page.locator('[data-testid="managed-canvas-metrics"]').innerText()).replace(/\s+/gu, " ");
  for (const expected of ["3 资产", "2 单元", "8 宫格", "2 文稿"]) {
    if (!metrics.includes(expected)) throw new Error(`画布规模指标缺少 ${expected}：${metrics}`);
  }
  const sixPanelUnitNode = page.locator(".vue-flow__node").filter({ hasText: "P7 六格连续性单元" }).first();
  await sixPanelUnitNode.waitFor();
  await clickNodeInsideFlowViewport(sixPanelUnitNode);
  const rawNode = page.locator(`[data-id="media:raw:${fixturePanel.id}"]`);
  const labeledNode = page.locator(`[data-id="media:labeled:${fixturePanel.id}"]`);
  const reviewNode = page.locator(`[data-id="media:review:${fixturePanel.id}"]`);
  await Promise.all([rawNode.waitFor(), labeledNode.waitFor(), reviewNode.waitFor()]);
  if (!(await rawNode.innerText()).includes("原始生成图")
    || !(await labeledNode.innerText()).includes("中文标注图")
    || !(await reviewNode.innerText()).includes("待审片")) {
    throw new Error("画布没有投影真实 raw/labeled/待审片结果节点。");
  }
  await capture(page, "05-managed-canvas-results.png");
  await reviewNode.click();
  const reviewWorkbench = page.locator('[data-testid="studio-review-workbench"]');
  await reviewWorkbench.waitFor();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-testid="studio-review-workbench"] img'))
    .every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0));
  await capture(page, "06-one-click-review.png");

  if (pageErrors.length || consoleErrors.length || externalRequests.length) {
    throw new Error(`安装版 UI smoke 出现 renderer 错误或外网请求：${JSON.stringify({ pageErrors, consoleErrors, externalRequests })}`);
  }

  await application.close();
  application = undefined;
  applicationClosed = true;
  const fixtureRoot = fixture.root;
  await fixture.cleanup();
  fixture = undefined;
  fixtureRootRemoved = await absent(fixtureRoot);
  await rm(runtimeRoot, { recursive: true, force: true });
  runtimeRootRemoved = await absent(runtimeRoot);

  const evidence = {
    schemaVersion: 1,
    kind: "p13-p14-installed-production-loop-ui-smoke",
    status: "pass",
    createdAt: new Date().toISOString(),
    runtime: {
      executablePath: cli.executablePath,
      installedBundle: true,
      systemNodeRequired: false,
      release: {
        version: releaseManifest.version,
        sourceDigest: releaseManifest.sourceDigest,
        buildId: releaseManifest.buildId,
        mcpToolCount: releaseManifest.mcpToolCount,
        distribution: releaseManifest.distribution,
      },
    },
    projects: {
      created: { projectId: createdRegistration.id, projectRoot: createdRegistration.primaryRoot, sourceRoots: 0 },
      restored: { projectId: restoredRegistration.id, projectRoot: restoredRegistration.primaryRoot, overwroteSource: false },
      fixture: {
        projectId: fixtureRegistration.id,
        projectRoot: fixtureRegistration.primaryRoot,
        assets: 3,
        textDocuments: 2,
        units: 2,
        panels: 8,
        generationRunId,
        provider: "codex",
        visualReviewClaimed: false,
      },
      switchCount: 3,
    },
    assertions: {
      firstRunThreeEntriesVisible: true,
      firstRunRecentDisabledWithoutExplicitActiveProject: true,
      importEntryCanceledWithoutMutation: true,
      projectCreatedThroughUi: true,
      backupCompletedThroughUi: true,
      restoreCompletedThroughUiToNewDirectory: true,
      restartRestoredExplicitActiveProject: true,
      projectSwitchIsolated: true,
      fiveStepNavigation: true,
      materialLibraryCharacterSceneProp: true,
      scriptAndPromptVisible: true,
      generationPaneVisible: true,
      managedCanvasVisible: true,
      rawLabeledReviewNodesVisible: true,
      oneClickResultNodeOpenedReview: true,
      agentConnectionStatusVisible: true,
      helpAndBackupRestoreEntriesVisible: true,
    },
    ui: {
      agentStatusText,
      canvasMetrics: metrics,
      pageErrors,
      consoleErrors,
    },
    isolation: {
      freshUserData: true,
      isolatedRegistry: true,
      createdProjectContained: true,
      restoredProjectContained: true,
      fixtureProjectContained: true,
      formalProjectOpened: false,
      formalProjectWrites: 0,
      externalRequests: externalRequests.length,
      agentRepairClicks: 0,
    },
    screenshots,
    terminal: {
      applicationClosed,
      runtimeRootRemoved,
      fixtureRootRemoved,
    },
    boundaries: {
      installedApplicationMutated: false,
      applicationInstalledBySmoke: false,
      agentConfigurationMutated: false,
      imageGenerationCalls: 0,
      browserSupplierCalls: 0,
      uploads: 0,
      gitActions: 0,
      visualReviewClaimed: false,
    },
  } satisfies P13P14InstalledUiSmokeEvidence;
  assertP13P14InstalledUiSmokeEvidence(evidence);
  await writeEvidenceExclusiveAtomic(cli.evidencePath, evidence);
  process.stdout.write(`${JSON.stringify({ ok: true, evidencePath: cli.evidencePath, screenshotDirectory: cli.screenshotDirectory, sourceDigest: releaseManifest.sourceDigest }, null, 2)}\n`);
} finally {
  await application?.close().catch(() => undefined);
  await fixture?.cleanup().catch(() => undefined);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  // 失败截图是部分证据；调用方目录只要求全新，不做递归清理或覆盖。
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
}
