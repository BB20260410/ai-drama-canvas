import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import { _electron as electron } from "playwright";
import sharp from "sharp";

const EP01_001 = "season-三-ep01-unit001";
const EP01_008 = "season-三-ep01-unit008";
const RAW_LABELED_PATTERNS = ["**/*_raw.png", "**/*_labeled.png"];
const RAW_LABELED_IGNORES = [
  ".aicanvas/backups/**",
  ".aicanvas/generation-downloads/**",
  ".aicanvas/subagent-staging/**",
];

function parseCli(argv) {
  const values = new Map();
  const valueOptions = new Set(["--workspace", "--project-root", "--registry", "--evidence", "--screenshot"]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") continue;
    if (!valueOptions.has(key)) throw new Error(`P4 UI 烟测未知参数：${key}`);
    if (values.has(key)) throw new Error(`P4 UI 烟测参数重复：${key}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`P4 UI 烟测参数缺少值：${key}`);
    values.set(key, value);
  }
  return values;
}

function usage() {
  return `P4 Electron 中文故事板状态烟测

用法：
  npm run ui:p4-storyboard-sheet-smoke -- [参数]

参数：
  --workspace <path>      工作区
  --project-root <path>   已完成 P4 正式迁移的隔离工程
  --registry <path>       临时项目注册表
  --evidence <path>       机器证据 JSON
  --screenshot <path>     EP01_001 截图；EP01_008 自动使用同名 -ep01-008.png
  --help                  显示帮助

只打开本地 Electron 页面并读取状态；不点击迁移、成板、排队或供应商网页。
`;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(usage());
  process.exit(0);
}

const cli = parseCli(process.argv.slice(2));
const workspace = path.resolve(cli.get("--workspace") || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const projectRoot = path.resolve(cli.get("--project-root") || "/Users/hxx/Documents/无限画布/productions/gushujuan-s3-f1a688020bfb7af6");
const evidencePath = path.resolve(cli.get("--evidence") || path.join(os.tmpdir(), "ai-canvas-p4-storyboard-sheet-ui-smoke.json"));
const screenshot001Path = path.resolve(cli.get("--screenshot") || path.join(os.tmpdir(), "ai-canvas-p4-storyboard-sheet-ui-smoke-ep01-001.png"));
const screenshotExtension = path.extname(screenshot001Path) || ".png";
const screenshot008Path = path.join(path.dirname(screenshot001Path), `${path.basename(screenshot001Path, screenshotExtension)}-ep01-008${screenshotExtension}`);
const registryPath = path.resolve(cli.get("--registry") || path.join(os.tmpdir(), `ai-canvas-p4-ui-registry-${createHash("sha256").update(evidencePath).digest("hex").slice(0, 16)}.json`));
const sidecarRoot = path.join(projectRoot, ".aicanvas");

async function exists(filePath) {
  return access(filePath).then(() => true, () => false);
}

async function canonicalTarget(target) {
  const suffix = [];
  let cursor = path.resolve(target);
  while (!await exists(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`无法解析输出路径：${target}`);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(await realpath(cursor), ...suffix);
}

function isWithin(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

const outputs = [registryPath, evidencePath, screenshot001Path, screenshot008Path];
if (new Set(outputs).size !== outputs.length) throw new Error("P4 UI 的 registry/evidence/两张截图必须使用不同路径。 ");
const [canonicalOutputs, allowedRoots, forbiddenRoot] = await Promise.all([
  Promise.all(outputs.map(canonicalTarget)),
  Promise.all([
    canonicalTarget(os.tmpdir()),
    canonicalTarget("/tmp"),
    canonicalTarget("/private/tmp"),
    canonicalTarget(path.join(workspace, "docs", "evidence")),
  ]),
  canonicalTarget(projectRoot),
]);
for (let index = 0; index < outputs.length; index += 1) {
  if (!allowedRoots.some((root) => isWithin(canonicalOutputs[index], root)) || isWithin(canonicalOutputs[index], forbiddenRoot)) {
    throw new Error(`P4 UI 输出路径越界：${outputs[index]}`);
  }
  if (await exists(outputs[index])) throw new Error(`P4 UI 证据已存在，拒绝覆盖：${outputs[index]}`);
  await mkdir(path.dirname(outputs[index]), { recursive: true });
}

async function fileIdentity(filePath) {
  if (!await exists(filePath)) return { path: filePath, exists: false };
  const link = await lstat(filePath);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error(`P4 UI 受保护路径不是普通文件：${filePath}`);
  const before = await stat(filePath);
  const content = await readFile(filePath);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`P4 UI 计算 SHA 期间文件发生变化：${filePath}`);
  }
  return { path: filePath, exists: true, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
}

async function inventory(root, patterns = "**/*", ignore = []) {
  if (!await exists(root)) return { root, files: 0, bytes: 0, sha256: createHash("sha256").update("").digest("hex") };
  const entries = (await fg(patterns, { cwd: root, dot: true, onlyFiles: true, followSymbolicLinks: false, unique: true, ignore }))
    .sort((left, right) => left.localeCompare(right, "en"));
  const rows = [];
  for (const relativePath of entries) {
    const identity = await fileIdentity(path.join(root, ...relativePath.split("/")));
    if (!identity.exists) throw new Error(`P4 UI 清单文件消失：${relativePath}`);
    rows.push({ path: relativePath, bytes: identity.bytes, sha256: identity.sha256 });
  }
  return {
    root,
    files: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
  };
}

async function guardedSnapshot() {
  return {
    projectConfig: await fileIdentity(path.join(sidecarRoot, "project.json")),
    projectIndex: await fileIdentity(path.join(sidecarRoot, "index.json")),
    overrides: await fileIdentity(path.join(sidecarRoot, "overrides.json")),
    generationSettings: await fileIdentity(path.join(sidecarRoot, "generation.json")),
    jobs: await fileIdentity(path.join(sidecarRoot, "generation-jobs.json")),
    publications: await fileIdentity(path.join(sidecarRoot, "publications.json")),
    reviews: await fileIdentity(path.join(sidecarRoot, "reviews.json")),
    gridSelections: await fileIdentity(path.join(sidecarRoot, "storyboard-grid-selections.json")),
    panelReferenceResolutions: await fileIdentity(path.join(sidecarRoot, "panel-reference-resolutions.json")),
    panelVisualConstraints: await fileIdentity(path.join(sidecarRoot, "panel-visual-constraints.json")),
    sheetIndex: await fileIdentity(path.join(sidecarRoot, "storyboard-sheet-index.json")),
    sheetStore: await inventory(path.join(sidecarRoot, "storyboard-sheets")),
    commandLedger: await fileIdentity(path.join(sidecarRoot, "command-ledger.json")),
    scannerCache: await fileIdentity(path.join(sidecarRoot, "cache.sqlite")),
    events: await fileIdentity(path.join(sidecarRoot, "events.jsonl")),
    requests: await inventory(path.join(sidecarRoot, "generation-requests")),
    downloads: await inventory(path.join(sidecarRoot, "generation-downloads")),
    subagentStaging: await inventory(path.join(sidecarRoot, "subagent-staging")),
    rawLabeled: await inventory(projectRoot, RAW_LABELED_PATTERNS, RAW_LABELED_IGNORES),
  };
}

async function inspectScreenshot(filePath) {
  const file = await fileIdentity(filePath);
  const [metadata, stats] = await Promise.all([sharp(filePath).metadata(), sharp(filePath).stats()]);
  const standardDeviation = Math.max(...stats.channels.map((channel) => channel.stdev));
  if (!file.exists || (file.bytes || 0) < 50_000 || (metadata.width || 0) < 1_200 || (metadata.height || 0) < 700
    || metadata.format !== "png" || standardDeviation < 5) {
    throw new Error(`P4 UI 截图疑似占位或不可验收：${JSON.stringify({ file, metadata, standardDeviation })}`);
  }
  return { ...file, width: metadata.width, height: metadata.height, format: metadata.format, standardDeviation };
}

const before = await guardedSnapshot();
const projectConfig = JSON.parse(await readFile(path.join(sidecarRoot, "project.json"), "utf8"));
await writeFile(registryPath, `${JSON.stringify([{
  id: projectConfig.id,
  name: projectConfig.name,
  primaryRoot: projectRoot,
  updatedAt: projectConfig.updatedAt,
}], null, 2)}\n`, { encoding: "utf8", flag: "wx" });

const pageErrors = [];
const externalRequests = [];
const externalPages = [];
const app = await electron.launch({
  args: ["."],
  cwd: workspace,
  env: {
    ...process.env,
    AI_CANVAS_PROJECT_ROOT: projectRoot,
    AI_CANVAS_REGISTRY_PATH: registryPath,
    AI_CANVAS_WINDOW_WIDTH: "1820",
    AI_CANVAS_WINDOW_HEIGHT: "1160",
  },
});

let ui001;
let ui008;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(180_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/iu.test(request.url())) externalRequests.push(request.url());
  });
  app.on("window", (candidate) => {
    candidate.on("framenavigated", (frame) => {
      if (frame === candidate.mainFrame() && /^https?:/iu.test(frame.url())) externalPages.push(frame.url());
    });
  });
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "生产设计", exact: true }).click();
  await page.getByRole("heading", { name: "生产设计与连续性", exact: true }).waitFor();
  await page.locator('[data-testid="design-tab-storyboard"]').click();
  await page.locator('[data-testid="fusion-sheet-state"]').waitFor();

  const selector = page.locator(".storyboard-toolbar select");
  await selector.selectOption(EP01_001);
  await page.waitForFunction((itemId) => {
    const select = document.querySelector(".storyboard-toolbar select");
    const status = document.querySelector('[data-testid="fusion-sheet-state"] > header > small');
    return select?.value === itemId && status?.textContent?.includes("store r");
  }, EP01_001);
  const state001 = await page.evaluate(async ({ root, itemId }) => window.canvasApi.getFusionStoryboardSheetState(root, { itemId }), { root: projectRoot, itemId: EP01_001 });
  const current001 = (await page.locator('[data-testid="fusion-sheet-current-count"]').textContent())?.trim();
  const fingerprint001 = (await page.locator('[data-testid="fusion-sheet-fingerprint"]').textContent())?.trim();
  const history001 = (await page.locator('[data-testid="fusion-sheet-history"]').textContent())?.trim() || "";
  const blockers001 = (await page.locator('[data-testid="fusion-sheet-blockers"]').textContent())?.trim() || "";
  const render001 = page.locator('[data-testid="render-fusion-storyboard-sheet"]');
  const migrate001 = page.locator('[data-testid="migrate-fusion-storyboard-sheets"]');
  if (state001.itemId !== EP01_001 || state001.currentSheetId !== undefined || state001.readiness.canRender
    || current001 !== "current 0/1" || fingerprint001 !== "未签发"
    || !history001.includes("stale") || !history001.includes("legacy-invalid")
    || await render001.count() !== 1 || !await render001.isDisabled() || !await migrate001.isDisabled()) {
    throw new Error(`EP01_001 P4 UI 未失败关闭：${JSON.stringify({ state001, current001, fingerprint001, history001, blockers001 })}`);
  }
  await page.screenshot({ path: screenshot001Path, fullPage: true });
  ui001 = {
    itemId: EP01_001,
    current: current001,
    fingerprint: fingerprint001,
    historyStatuses: state001.versions.map((entry) => entry.status),
    blockers: state001.readiness.blockers,
    renderDisabled: true,
    migrationDisabled: true,
  };

  await selector.selectOption(EP01_008);
  await page.waitForFunction((itemId) => {
    const select = document.querySelector(".storyboard-toolbar select");
    const status = document.querySelector('[data-testid="fusion-sheet-state"] > header > small');
    const panels = document.querySelectorAll('[data-testid^="fusion-grid-panel-"]');
    return select?.value === itemId && status?.textContent?.includes("store r") && panels.length === 6;
  }, EP01_008);
  const state008 = await page.evaluate(async ({ root, itemId }) => window.canvasApi.getFusionStoryboardSheetState(root, { itemId }), { root: projectRoot, itemId: EP01_008 });
  const current008 = (await page.locator('[data-testid="fusion-sheet-current-count"]').textContent())?.trim();
  const fingerprint008 = (await page.locator('[data-testid="fusion-sheet-fingerprint"]').textContent())?.trim();
  const blockers008 = (await page.locator('[data-testid="fusion-sheet-blockers"]').textContent())?.trim() || "";
  const panelTexts008 = await page.locator('[data-testid^="fusion-grid-panel-"]').allTextContents();
  const render008 = page.locator('[data-testid="render-fusion-storyboard-sheet"]');
  const migrate008 = page.locator('[data-testid="migrate-fusion-storyboard-sheets"]');
  const enqueue005 = page.locator('[data-testid="enqueue-fusion-grid-panel-5"]');
  const enqueue006 = page.locator('[data-testid="enqueue-fusion-grid-panel-6"]');
  const toolbarText008 = (await page.locator(".storyboard-toolbar").textContent())?.trim() || "";
  if (state008.itemId !== EP01_008 || state008.currentSheetId !== undefined || state008.readiness.canRender
    || state008.currentContract?.selection.panelCount !== 6 || state008.versions.length !== 0 || current008 !== "current 0/1" || fingerprint008 !== "未签发"
    || !/(?:完整宫格证据不足|不完整|没有 succeeded GenerationJob)/u.test(blockers008)
    || panelTexts008.length !== 6 || !panelTexts008[4]?.includes("generation_unknown")
    || !panelTexts008[5]?.includes("missing")
    || !toolbarText008.includes("4/6 格") || await render008.count() !== 1 || !await render008.isDisabled() || !await migrate008.isDisabled()
    || await enqueue005.count() !== 1 || !await enqueue005.isDisabled() || await enqueue006.count() !== 1 || await enqueue006.isDisabled()) {
    throw new Error(`EP01_008 P4 UI 未呈现 0 current/6 格缺口：${JSON.stringify({ state008, current008, fingerprint008, blockers008, panelTexts008, toolbarText008 })}`);
  }
  await page.screenshot({ path: screenshot008Path, fullPage: true });
  ui008 = {
    itemId: EP01_008,
    current: current008,
    contractPanels: 6,
    scannedProgress: "4/6",
    fingerprint: fingerprint008,
    blockers: state008.readiness.blockers,
    panelStates: panelTexts008.map((text, index) => ({ panel: index + 1, unknown: text.includes("generation_unknown"), missing: text.includes("missing") })),
    panel5EnqueueDisabled: true,
    panel6EnqueueDisabled: false,
    renderDisabled: true,
    migrationDisabled: true,
  };
} finally {
  await app.close();
}

const after = await guardedSnapshot();
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("P4 UI 只读烟测改写了正式工程。 ");
if (pageErrors.length) throw new Error(`P4 UI 页面异常：${pageErrors.join("；")}`);
if (externalRequests.length || externalPages.length) {
  throw new Error(`P4 UI 烟测访问了外部网页：${JSON.stringify({ externalRequests, externalPages })}`);
}
const screenshots = [await inspectScreenshot(screenshot001Path), await inspectScreenshot(screenshot008Path)];
const evidence = {
  schemaVersion: 1,
  kind: "p4-storyboard-sheet-ui-smoke",
  createdAt: new Date().toISOString(),
  workspace,
  projectRoot,
  ep01_001: ui001,
  ep01_008: ui008,
  guarded: { before, after, unchanged: true },
  screenshots,
  pageErrors,
  externalRequests,
  externalPages,
  clicked: { migrate: false, render: false, enqueue: false, generate: false },
  passed: true,
};
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({
  passed: true,
  evidencePath,
  screenshots: screenshots.map((entry) => entry.path),
  ep01_001: ui001,
  ep01_008: ui008,
  pageErrors: 0,
  externalWebpages: 0,
  guardedUnchanged: true,
}, null, 2)}\n`);
