import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type Page } from "playwright";
import sharp from "sharp";
import { getStudioContinuityReviewControl } from "../src/core/studio-continuity-review-control.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "../tests/helpers/studio-p7-fixture.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspace, "docs", "evidence");
const evidencePath = path.resolve(
  process.argv[2] || path.join(evidenceRoot, "p7-continuity-review-ui-smoke-latest.json"),
);
const screenshotPath = path.resolve(
  process.argv[3] || path.join(evidenceRoot, "p7-continuity-review-ui-smoke-latest.png"),
);

for (const output of [evidencePath, screenshotPath]) {
  const relative = path.relative(evidenceRoot, output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`P7 UI 证据必须写入 docs/evidence：${output}`);
  }
  await access(output).then(
    () => { throw new Error(`P7 UI 证据已存在，拒绝覆盖：${output}`); },
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

async function absent(filePath: string): Promise<boolean> {
  return access(filePath).then(() => false, () => true);
}

async function resourceUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => performance.getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => typeof name === "string"));
}

async function submitContinuityQuery(page: Page): Promise<void> {
  const view = page.locator('[data-testid="studio-continuity-review-view"]');
  const form = page.locator('[data-testid="continuity-query-form"]');
  await form.getByRole("button", { name: /读取控制面/u }).click();
  await page.waitForFunction(() => {
    const control = document.querySelector('[data-testid="studio-continuity-review-view"]');
    return control?.getAttribute("aria-busy") === "false"
      && Boolean(document.querySelector('[data-testid="continuity-next-action"]'));
  });
  await view.locator('[data-testid="continuity-assets"]').waitFor();
}

const temporaryBase = await realpath("/tmp");
const runtimeRoot = await realpath(await mkdtemp(path.join(temporaryBase, "ai-canvas-p7-ui-runtime-")));
const registryPath = path.join(runtimeRoot, "registry", "projects.json");
const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

let fixture: StudioP7Fixture | undefined;
let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
let screenshotWritten = false;
let evidenceWritten = false;

try {
  fixture = await createStudioP7Fixture();
  if (!path.resolve(fixture.root).startsWith(`${temporaryBase}${path.sep}`)) {
    throw new Error(`P7 UI fixture 必须隔离在 /tmp：${fixture.root}`);
  }
  if (fixture.shell.project.sourceRoots.length !== 0) {
    throw new Error("P7 UI fixture 必须保持 sourceRoots=[]，禁止扫描历史工程。");
  }
  await registerProject(fixture.shell.project);
  await setActiveProjectRegistration(fixture.root);

  const unit = fixture.units.sixPanel;
  const panel = unit.panels[0]!;
  const assetIds = panel.assets.map((asset) => asset.assetId);
  const controlInput = {
    unitId: unit.unit.id,
    unitRevision: unit.unit.revision,
    panelId: panel.id,
    startMilliseconds: Math.round(panel.startSeconds * 1_000),
    endMilliseconds: Math.round(panel.endSeconds * 1_000),
    assetIds,
  } as const;
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  const rendererRequests: string[] = [];
  let rendererCrashed = false;
  const launchedAt = performance.now();

  application = await electron.launch({
    args: ["."],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_WINDOW_WIDTH: "1900",
      AI_CANVAS_WINDOW_HEIGHT: "1200",
    },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(45_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("crash", () => { rendererCrashed = true; });
  page.on("request", (request) => {
    rendererRequests.push(request.url());
    if (/^https?:/iu.test(request.url())) externalRequests.push(request.url());
  });

  const materialStudio = page.locator('[data-testid="material-studio-view"]');
  await materialStudio.waitFor();
  const canvasView = page.locator('[data-testid="managed-studio-canvas-view"]');
  await canvasView.waitFor();
  const canvasTab = page.locator('[data-testid="studio-mode-canvas"]');
  if (!((await canvasTab.getAttribute("class"))?.split(/\s+/u).includes("active"))) {
    throw new Error("受管工程启动后没有默认停留无限画布。");
  }
  if (await page.locator('[data-testid="studio-continuity-review-view"]').count() !== 0) {
    throw new Error("启动默认错误预加载了连续性 / Review 组件。");
  }
  const beforeTabResources = await resourceUrls(page);
  const beforeTabRequestCount = rendererRequests.length;
  const preloadedContinuityChunks = beforeTabResources.filter((url) => /StudioContinuityReviewView/iu.test(url));
  if (preloadedContinuityChunks.length !== 0) {
    throw new Error(`启动默认错误请求了连续性异步 chunk：${preloadedContinuityChunks.join(", ")}`);
  }

  await page.locator('[data-testid="studio-step-review"]').click();
  const continuityView = page.locator('[data-testid="studio-continuity-review-view"]');
  await continuityView.waitFor();
  const afterTabResources = await resourceUrls(page);
  const beforeResourceSet = new Set(beforeTabResources);
  const lazyContinuityChunks = [...new Set([
    ...afterTabResources.filter((url) => !beforeResourceSet.has(url)),
    ...rendererRequests.slice(beforeTabRequestCount),
  ].filter((url) => /StudioContinuityReviewView/iu.test(url)))];
  if (lazyContinuityChunks.length === 0) {
    throw new Error("点击连续性 / Review tab 后没有观察到按需加载的组件 chunk。");
  }

  const form = page.locator('[data-testid="continuity-query-form"]');
  await continuityView.locator("details.diagnostic-details > summary").click();
  await form.getByLabel("15 秒单元 ID").fill(controlInput.unitId);
  await form.getByLabel("单元 revision").fill(String(controlInput.unitRevision));
  await form.getByLabel("宫格 ID").fill(controlInput.panelId);
  await form.getByLabel("起始毫秒").fill(String(controlInput.startMilliseconds));
  await form.getByLabel("结束毫秒").fill(String(controlInput.endMilliseconds));
  await form.getByLabel("资产 ID（最多 6 项）").fill(assetIds.join(", "));
  await submitContinuityQuery(page);

  const assetCards = continuityView.locator("article.asset-control");
  if (await assetCards.count() !== 3) throw new Error("真实 fixture 宫格没有显示三项规范资产。");
  if (await continuityView.locator(".field-grid > div").count() !== 27) {
    throw new Error("三项资产没有逐项显示完整九字段。");
  }
  if (await continuityView.locator(".field-missing").count() !== 27
    || await continuityView.locator("article.asset-control.ready").count() !== 0) {
    throw new Error("未 seed 的真实 fixture 宫格没有失败关闭为 27 个九字段缺口。");
  }
  const unresolvedUiNextAction = await page.locator('[data-testid="continuity-next-action"]').innerText();
  if (!unresolvedUiNextAction.includes("补齐连续性状态")) {
    throw new Error(`未 seed 时没有回显 Core 唯一下一动作：${unresolvedUiNextAction}`);
  }
  const unresolvedSummary = await continuityView.locator(".summary-strip").innerText();
  if (!unresolvedSummary.includes("0/3") || !unresolvedSummary.includes("阻断")) {
    throw new Error(`未 seed 时摘要没有显示 0/3 与 generation blocked：${unresolvedSummary}`);
  }
  const unresolvedCore = await getStudioContinuityReviewControl(fixture.root, controlInput);
  if (unresolvedCore.assets.some((asset) => asset.ready)
    || unresolvedCore.assets.flatMap((asset) => asset.fields).some((field) => field.status !== "missing")
    || unresolvedCore.generation.status !== "blocked"
    || unresolvedCore.nextAction.code !== "record-continuity-state") {
    throw new Error("UI 的九字段缺口没有与 Core 未解析投影一致。");
  }

  const seeded = await seedStudioP7ResolvedContinuity(fixture);
  const readyCore = await getStudioContinuityReviewControl(fixture.root, controlInput);
  if (readyCore.assets.some((asset) => !asset.ready)
    || readyCore.assets.flatMap((asset) => asset.fields).some((field) => field.status !== "resolved")
    || readyCore.generation.status !== "ready"
    || (readyCore.nextAction.code !== "execute-agent-imagegen"
      && readyCore.nextAction.code !== "execute-codex-imagegen"
      && readyCore.nextAction.code !== "freeze-generation-pack")) {
    throw new Error("显式 seed 后 Core 没有得到九字段 ready / generation.ready。");
  }

  await submitContinuityQuery(page);
  await page.waitForFunction(() => document.querySelectorAll("article.asset-control.ready").length === 3
    && document.querySelectorAll(".field-resolved").length === 27);
  const readySummary = await continuityView.locator(".summary-strip").innerText();
  if (!readySummary.includes("3/3") || !readySummary.includes("就绪")) {
    throw new Error(`seed 后摘要没有显示 3/3 与 generation ready：${readySummary}`);
  }
  const readyUiNextAction = await page.locator('[data-testid="continuity-next-action"]').innerText();
  for (const expected of [readyCore.nextAction.label, readyCore.nextAction.reason]) {
    if (expected && !readyUiNextAction.includes(expected)) {
      throw new Error(`UI 没有直接展示 Core nextAction：缺少 ${expected}`);
    }
  }

  const reviewControl = page.locator('[data-testid="generation-review-control"]');
  const checkpointControl = page.locator('[data-testid="generation-checkpoint-control"]');
  await Promise.all([reviewControl.waitFor(), checkpointControl.waitFor()]);
  const reviewControlText = await reviewControl.innerText();
  const checkpointControlText = await checkpointControl.innerText();
  if (!reviewControlText.includes("画面验收写回") || !reviewControlText.includes("当前宫格尚无可读取的审片结果或历史")) {
    throw new Error("Review control 区域没有按无 run 状态显示。");
  }
  if (!checkpointControlText.includes("每六图一致性停检")
    || !checkpointControlText.includes("当前收集 0/6")
    || !checkpointControlText.includes("允许新增生产槽")) {
    throw new Error(`六图 checkpoint 区域没有显示当前 Core 状态：${checkpointControlText}`);
  }

  await reviewControl.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    document.querySelector('[data-testid="generation-review-control"]')?.scrollIntoView({ block: "start" });
  });
  const screenshotBuffer = await page.screenshot({ type: "png" });
  await writeFile(screenshotPath, screenshotBuffer, { flag: "wx" });
  screenshotWritten = true;
  const readyMs = Math.round(performance.now() - launchedAt);

  await application.close();
  application = undefined;
  if (pageErrors.length || consoleErrors.length || externalRequests.length || rendererCrashed) {
    throw new Error(`P7 UI 出现 renderer 错误、崩溃或外网请求：${JSON.stringify({
      pageErrors,
      consoleErrors,
      externalRequests,
      rendererCrashed,
    })}`);
  }

  const screenshot = await fileEvidence(screenshotPath);
  const metadata = await sharp(screenshotPath).metadata();
  const stats = await sharp(screenshotPath).stats();
  const stdev = Math.max(...stats.channels.map((channel) => channel.stdev));
  if ((metadata.width ?? 0) < 1_500 || (metadata.height ?? 0) < 900
    || screenshot.sizeBytes < 35_000 || stdev < 5) {
    throw new Error("P7 UI 截图疑似空白或占位图。");
  }

  const fixtureProjectId = fixture.shell.project.id;
  const fixtureSourceRoots = [...fixture.shell.project.sourceRoots];
  const fixtureRoot = fixture.root;
  await fixture.cleanup();
  fixture = undefined;
  const fixtureCleaned = await absent(fixtureRoot);
  if (!fixtureCleaned) throw new Error("P7 UI fixture 没有完成清理。");
  await rm(runtimeRoot, { recursive: true, force: true });
  const runtimeRootCleaned = await absent(runtimeRoot);
  if (!runtimeRootCleaned) throw new Error("P7 UI 隔离 registry 没有完成清理。");
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;

  const evidence = {
    schemaVersion: 1,
    kind: "p7-continuity-review-ui-smoke",
    status: "pass",
    createdAt: new Date().toISOString(),
    fixture: {
      projectId: fixtureProjectId,
      sourceRoots: fixtureSourceRoots,
      units: 2,
      panels: 8,
      canonicalAssets: 3,
      queriedUnitId: controlInput.unitId,
      queriedPanelId: controlInput.panelId,
      queriedAssetIds: assetIds,
      continuityWriteCount: seeded.writes.length,
      readinessFingerprintCount: Object.keys(seeded.readinessByPanelAsset).length,
      visualReviewClaimed: false,
      fixtureCleaned,
      runtimeRootCleaned,
    },
    ui: {
      compiledElectronBuild: true,
      startupDefaultCanvas: true,
      continuityTabNotPreloadedAtStartup: true,
      continuityChunkLazyLoaded: true,
      lazyChunkFiles: lazyContinuityChunks.map((url) => path.basename(new URL(url).pathname)),
      unresolvedBeforeSeed: {
        assetCount: unresolvedCore.assets.length,
        readyCount: unresolvedCore.assets.filter((asset) => asset.ready).length,
        fieldCount: unresolvedCore.assets.flatMap((asset) => asset.fields).length,
        missingFieldCount: unresolvedCore.assets.flatMap((asset) => asset.fields)
          .filter((field) => field.status === "missing").length,
        generationStatus: unresolvedCore.generation.status,
        nextActionCode: unresolvedCore.nextAction.code,
        nextActionLabel: unresolvedCore.nextAction.label,
      },
      readyAfterSeed: {
        assetCount: readyCore.assets.length,
        readyCount: readyCore.assets.filter((asset) => asset.ready).length,
        fieldCount: readyCore.assets.flatMap((asset) => asset.fields).length,
        resolvedFieldCount: readyCore.assets.flatMap((asset) => asset.fields)
          .filter((field) => field.status === "resolved").length,
        generationStatus: readyCore.generation.status,
        nextActionCode: readyCore.nextAction.code,
        nextActionLabel: readyCore.nextAction.label,
        nextActionReason: readyCore.nextAction.reason,
        nextActionCommand: readyCore.nextAction.command,
      },
      reviewControlVisible: true,
      reviewControlText,
      checkpointControlVisible: true,
      checkpointControlText,
      readyMs,
      pageErrors: 0,
      consoleErrors: 0,
      rendererCrashes: 0,
      externalRequests: 0,
    },
    screenshot: {
      ...screenshot,
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      stdev,
    },
    boundaries: {
      temporaryFixtureOnly: true,
      isolatedRegistry: true,
      formalProjectAccesses: 0,
      formalProjectWrites: 0,
      filesystemScans: 0,
      imageGenerationCalls: 0,
      browserSupplierCalls: 0,
      uploads: 0,
    },
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  evidenceWritten = true;
  process.stdout.write(`${JSON.stringify({ evidencePath, screenshotPath, readyMs, fixtureCleaned, runtimeRootCleaned })}\n`);
} finally {
  await application?.close().catch(() => undefined);
  await fixture?.cleanup().catch(() => undefined);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
  if (!evidenceWritten) {
    await rm(evidencePath, { force: true }).catch(() => undefined);
    if (screenshotWritten) await rm(screenshotPath, { force: true }).catch(() => undefined);
  }
}
