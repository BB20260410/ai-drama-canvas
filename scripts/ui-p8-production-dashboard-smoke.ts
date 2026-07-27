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
const evidencePath = path.resolve(
  process.argv[2] || path.join(evidenceRoot, `p8-production-dashboard-ui-smoke-${stamp}-01.json`),
);
const screenshotPath = path.resolve(
  process.argv[3] || path.join(evidenceRoot, `p8-production-dashboard-ui-smoke-${stamp}-01.png`),
);

for (const output of [evidencePath, screenshotPath]) {
  const relative = path.relative(evidenceRoot, output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`P8 UI 证据必须写入 docs/evidence：${output}`);
  }
  await access(output).then(
    () => { throw new Error(`P8 UI 证据已存在，拒绝覆盖：${output}`); },
    () => undefined,
  );
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

async function resourceUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => performance.getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => typeof name === "string"));
}

const temporaryBase = await realpath("/tmp");
const runtimeRoot = await realpath(await mkdtemp(path.join(temporaryBase, "ai-canvas-p8-ui-runtime-")));
const registryPath = path.join(runtimeRoot, "registry", "projects.json");
const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

let fixture: StudioP7Fixture | undefined;
let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  fixture = await createStudioP7Fixture();
  await seedStudioP7ResolvedContinuity(fixture);
  await registerProject(fixture.shell.project);
  await setActiveProjectRegistration(fixture.root);

  const coreOverview = await getStudioProductionDashboard(fixture.root, { operation: "overview" });
  const coreUnits = await getStudioProductionDashboard(fixture.root, { operation: "units", limit: 36 });
  if (coreOverview.operation !== "overview" || coreUnits.operation !== "units") {
    throw new Error("Core dashboard operation 不匹配。");
  }

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
  const window = await application.firstWindow();
  const page = window;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.setViewportSize({ width: 1728, height: 1029 });
  await page.waitForSelector('[data-testid="material-studio-view"], [data-testid="studio-production-dashboard-view"]', {
    timeout: 60_000,
  });

  // 默认应进入生产驾驶舱；若仍在素材库则点击切换
  const dashboardTab = page.locator('[data-testid="studio-mode-dashboard"]');
  if (await dashboardTab.count()) {
    await dashboardTab.click();
  }
  await page.waitForSelector('[data-testid="studio-production-dashboard-view"]', { timeout: 60_000 });
  await page.waitForFunction(() => {
    const view = document.querySelector('[data-testid="studio-production-dashboard-view"]');
    return view?.getAttribute("aria-busy") === "false"
      && Boolean(document.querySelector('[data-testid="dashboard-next-action"]'));
  }, undefined, { timeout: 60_000 });

  const unitButtons = page.locator('[data-testid="dashboard-unit-list"] button');
  if (await unitButtons.count() > 0) {
    await unitButtons.first().click();
    await page.waitForSelector('[data-testid="dashboard-panel-grid"]', { timeout: 30_000 });
  }

  const panelCount = await page.locator('[data-testid="dashboard-panel-grid"] .panel-card').count();
  if (panelCount > 6) throw new Error(`UI 渲染宫格超过硬上限 6：${panelCount}`);

  const unitCount = await page.locator('[data-testid="dashboard-unit-list"] button').count();
  if (unitCount > 36) throw new Error(`UI 渲染单元超过硬上限 36：${unitCount}`);

  await page.screenshot({ path: screenshotPath, fullPage: true });
  const resources = await resourceUrls(page);
  const external = resources.filter((url) => /^https?:/i.test(url) && !url.startsWith("file:"));
  if (external.length) throw new Error(`检测到外网资源：${external.join(", ")}`);
  if (pageErrors.length || consoleErrors.length) {
    throw new Error(`页面错误：page=${JSON.stringify(pageErrors)} console=${JSON.stringify(consoleErrors)}`);
  }

  const uiNextAction = (await page.locator('[data-testid="dashboard-next-action"] strong').textContent())?.trim() ?? "";
  if (!uiNextAction) throw new Error("UI 未显示 Core nextAction 标签。");

  const evidence = {
    schemaVersion: 1,
    kind: "p8-production-dashboard-ui-smoke",
    createdAt: new Date().toISOString(),
    projectRoot: fixture.root,
    projectId: fixture.shell.project.id,
    core: {
      overviewFingerprint: coreOverview.fingerprint,
      overviewNextAction: coreOverview.nextAction,
      unitsCount: coreUnits.operation === "units" ? coreUnits.page.items.length : 0,
    },
    ui: {
      nextActionLabel: uiNextAction,
      unitDomCount: unitCount,
      panelDomCount: panelCount,
      pageErrors,
      consoleErrors,
      externalResources: external,
    },
    screenshot: await fileEvidence(screenshotPath),
    formalAccess: 0,
    imagegen: 0,
    browser: 0,
    upload: 0,
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    evidencePath,
    screenshotPath,
    overviewFingerprint: coreOverview.fingerprint,
    unitDomCount: unitCount,
    panelDomCount: panelCount,
  }, null, 2));
} finally {
  if (application) await application.close().catch(() => undefined);
  if (fixture) await fixture.cleanup().catch(() => undefined);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
}
