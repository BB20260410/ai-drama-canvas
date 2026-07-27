import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type Page } from "playwright";
import sharp from "sharp";
import { inspectManagedProject } from "../src/core/managed-project.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(
  process.argv[2]
    ?? path.join(workspace, "projects", "local-import-dudu-world-prologue-b8bfcf14"),
);
const evidenceRoot = path.join(workspace, "output", "playwright");
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const evidencePath = path.resolve(
  process.argv[3] ?? path.join(evidenceRoot, `p6-script-product-formal-${stamp}.json`),
);
const libraryScreenshotPath = path.resolve(
  process.argv[4] ?? path.join(evidenceRoot, `p6-script-product-library-${stamp}.png`),
);
const alignScreenshotPath = path.resolve(
  process.argv[5] ?? path.join(evidenceRoot, `p6-script-product-align-${stamp}.png`),
);
const wizardScreenshotPath = path.resolve(
  process.argv[6] ?? path.join(evidenceRoot, `p6-script-product-wizard-${stamp}.png`),
);
const targetUnitId = "unit-local-e61b4628ca1abe8d8752c50d304fdb6e77847b16";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function screenshotEvidence(page: Page, outputPath: string) {
  const bytes = await page.screenshot({
    type: "png",
    fullPage: false,
    animations: "disabled",
  });
  await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
  const [metadata, statistics, file] = await Promise.all([
    sharp(bytes).metadata(),
    sharp(bytes).stats(),
    stat(outputPath),
  ]);
  const maxChannelStandardDeviation = Math.max(...statistics.channels.map((channel) => channel.stdev));
  if ((metadata.width ?? 0) < 1_400
    || (metadata.height ?? 0) < 800
    || file.size < 30_000
    || maxChannelStandardDeviation < 5) {
    throw new Error(`截图疑似空白或占位：${path.basename(outputPath)}`);
  }
  return {
    path: path.relative(workspace, outputPath).split(path.sep).join("/"),
    sha256: sha256(bytes),
    sizeBytes: file.size,
    width: metadata.width,
    height: metadata.height,
    maxChannelStandardDeviation,
  };
}

for (const outputPath of [
  evidencePath,
  libraryScreenshotPath,
  alignScreenshotPath,
  wizardScreenshotPath,
]) {
  if (!outputPath.startsWith(`${evidenceRoot}${path.sep}`)) {
    throw new Error(`P6 UI 证据必须写入 output/playwright：${outputPath}`);
  }
}
await mkdir(evidenceRoot, { recursive: true });
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p6-script-product-ui-"));
const registryPath = path.join(runtimeRoot, "registry", "projects.json");
const userDataPath = path.join(runtimeRoot, "user-data");
await mkdir(path.dirname(registryPath), { recursive: true });
await mkdir(userDataPath, { recursive: true });

const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  const shell = await inspectManagedProject(projectRoot);
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  await registerProject(shell.project);
  await setActiveProjectRegistration(shell.paths.root);

  application = await electron.launch({
    args: [
      path.join(workspace, "out", "main", "index.js"),
      `--user-data-dir=${userDataPath}`,
    ],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: shell.paths.root,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1728, height: 1029 });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.waitForSelector('[data-testid="material-studio-view"]', { timeout: 60_000 });
  await page.locator('[data-testid="studio-mode-script-align"]').click();
  await page.waitForSelector('[data-testid="script-media-align-view"]', { timeout: 60_000 });
  await page.waitForSelector('[data-testid="script-library-diagnostics"]', { timeout: 120_000 });

  const season = await page.locator('[data-testid="align-season"]').inputValue();
  const episode = await page.locator('[data-testid="align-episode"]').inputValue();
  if (season !== "WORLD" || episode !== "PROLOGUE") {
    throw new Error(`未自动定位正式季/集：${season}/${episode}`);
  }
  const libraryDocuments = await page.locator('[data-testid^="script-library-document-"]').count();
  if (libraryDocuments < 1) throw new Error("剧本库没有显示当前剧本文档。");
  const diagnosticsText = (await page.locator('[data-testid="script-library-diagnostics"]').innerText()).trim();
  if (!diagnosticsText.includes("正文 CAS") || !diagnosticsText.includes("提示词 / QC 诊断")) {
    throw new Error(`剧本库缺少 CAS/QC 诊断：${diagnosticsText.slice(0, 800)}`);
  }
  const libraryScreenshot = await screenshotEvidence(page, libraryScreenshotPath);

  await page.locator('[data-testid="script-product-tab-reader"]').click();
  const readerBody = page.locator('[data-testid="script-reader-body"]');
  await readerBody.waitFor({ state: "visible", timeout: 60_000 });
  const selectedRange = await readerBody.evaluate((element: HTMLTextAreaElement) => {
    const body = element.value;
    const terminators = [...body.matchAll(/[。！？.!?]/gu)].slice(0, 3);
    const end = terminators[2]?.index !== undefined
      ? terminators[2].index + terminators[2][0].length
      : Math.min(body.length, 1_500);
    element.focus();
    element.setSelectionRange(0, end);
    element.dispatchEvent(new Event("select", { bubbles: true }));
    return { start: element.selectionStart, end: element.selectionEnd, bodyLength: body.length };
  });
  if (selectedRange.end <= selectedRange.start || selectedRange.bodyLength < 1) {
    throw new Error(`正文选区失败：${JSON.stringify(selectedRange)}`);
  }
  await page.locator('[data-testid="script-reader-to-wizard"]').click();
  await page.waitForSelector('[data-testid="storyboard-wizard-pane"]', { timeout: 60_000 });
  const wizardPanelCount = await page.locator('article[data-testid^="storyboard-wizard-panel-"]').count();
  if (wizardPanelCount < 2 || wizardPanelCount > 6) {
    throw new Error(`向导宫格数不合法：${wizardPanelCount}`);
  }
  const materializeEnabled = !(await page.locator('[data-testid="storyboard-wizard-materialize"]').isDisabled());
  const wizardScreenshot = await screenshotEvidence(page, wizardScreenshotPath);

  await page.locator('[data-testid="script-product-tab-align"]').click();
  const targetRow = page.locator(`[data-testid="align-row-${targetUnitId}"]`);
  await targetRow.waitFor({ state: "visible", timeout: 120_000 });
  await targetRow.click();
  const rawPreview = page.locator('[data-testid="align-media-preview"] img');
  await rawPreview.waitFor({ state: "visible", timeout: 60_000 });
  const previewSource = await rawPreview.getAttribute("src");
  if (!previewSource?.startsWith("aicanvas-studio:")) {
    throw new Error(`raw 预览没有使用本地受管协议：${previewSource}`);
  }
  const alignSummary = (await page.locator('[data-testid="align-summary"]').innerText()).trim();
  const alignScreenshot = await screenshotEvidence(page, alignScreenshotPath);

  await targetRow.getByRole("button", { name: "绑定" }).click();
  await page.waitForSelector('[data-testid="studio-binding-workbench"]', { timeout: 60_000 });
  await page.waitForSelector('[data-testid="binding-panel-timeline"]', { timeout: 60_000 });
  const bindingUnitEntries = await page.locator('[data-testid="binding-unit-entry"]').count();
  const bindingPanelEntries = await page.locator('[data-testid="binding-panel-entry"]').count();
  if (bindingPanelEntries < 1) throw new Error("图文对照点穿 Binding 后没有显示目标单元宫格。");

  const externalResources = await page.evaluate(() =>
    performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => /^https?:/iu.test(name)
        && !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/)/iu.test(name)));
  if (externalResources.length > 0) {
    throw new Error(`UI 实机验收检测到外网资源：${externalResources.join(", ")}`);
  }
  if (pageErrors.length > 0 || consoleErrors.length > 0) {
    throw new Error(`页面错误：page=${JSON.stringify(pageErrors)} console=${JSON.stringify(consoleErrors)}`);
  }

  const evidence = {
    schemaVersion: 1,
    kind: "p6-script-product-formal-electron-smoke",
    createdAt: new Date().toISOString(),
    projectId: shell.project.id,
    projectRoot: shell.paths.root,
    detectedEpisode: { season, episode },
    libraryDocuments,
    diagnosticsText,
    selectedRange,
    wizardPanelCount,
    materializeEnabled,
    materializeClicked: false,
    alignSummary,
    targetUnitId,
    previewSourceProtocol: previewSource ? new URL(previewSource).protocol : null,
    bindingPointThrough: {
      opened: true,
      visibleUnitEntries: bindingUnitEntries,
      visiblePanelEntries: bindingPanelEntries,
    },
    pageErrors,
    consoleErrors,
    externalResources,
    screenshots: {
      library: libraryScreenshot,
      wizard: wizardScreenshot,
      align: alignScreenshot,
    },
    formalProjectWriteCount: 0,
    externalUploadCount: 0,
    imageGenerationCount: 0,
    paidActionCount: 0,
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const written = await readFile(evidencePath);
  console.log(JSON.stringify({
    ok: true,
    evidencePath,
    evidenceSha256: sha256(written),
    detectedEpisode: evidence.detectedEpisode,
    libraryDocuments,
    wizardPanelCount,
    materializeEnabled,
    targetUnitId,
    screenshots: evidence.screenshots,
  }, null, 2));
} finally {
  if (application) await application.close().catch(() => undefined);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
}
