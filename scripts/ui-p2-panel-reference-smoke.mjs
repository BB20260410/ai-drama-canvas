import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import sharp from "sharp";

function parseCli(argv) {
  const known = new Set(["--workspace", "--project-root", "--registry", "--evidence", "--screenshot"]);
  const named = new Map();
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    if (!known.has(token)) throw new Error(`P2 UI 烟测未知参数：${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`P2 UI 烟测参数缺少值：${token}`);
    if (named.has(token)) throw new Error(`P2 UI 烟测参数重复：${token}`);
    named.set(token, value);
    index += 1;
  }
  if (positional.length > 4) throw new Error(`P2 UI 烟测位置参数过多：${positional.join(" ")}`);
  return { named, positional };
}

const cli = parseCli(process.argv.slice(2));
const workspace = path.resolve(cli.named.get("--workspace") || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const projectRoot = path.resolve(cli.named.get("--project-root") || cli.positional[0] || "/Users/hxx/Documents/无限画布/productions/gushujuan-s3-f1a688020bfb7af6");
const evidencePath = path.resolve(cli.named.get("--evidence") || cli.positional[2] || "/tmp/ai-canvas-p2-panel-reference-ui-smoke.json");
const screenshotPath = path.resolve(cli.named.get("--screenshot") || cli.positional[3] || "/tmp/ai-canvas-p2-panel-reference-ui-smoke.png");
const defaultRegistryName = `ai-canvas-p2-panel-reference-ui-registry-${createHash("sha256").update(evidencePath).digest("hex").slice(0, 16)}.json`;
const registryPath = path.resolve(cli.named.get("--registry") || cli.positional[1] || path.join(os.tmpdir(), defaultRegistryName));
const sidecar = path.join(projectRoot, ".aicanvas");

async function exists(filePath) {
  return access(filePath).then(() => true).catch(() => false);
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function hashFiles(files) {
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, filePath]) => [name, await sha256(filePath)])));
}

function isWithin(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalTarget(target) {
  const suffix = [];
  let cursor = path.resolve(target);
  while (!await exists(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`P2 UI 烟测无法解析输出路径：${target}`);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(await realpath(cursor), ...suffix);
}

const projectConfig = JSON.parse(await readFile(path.join(sidecar, "project.json"), "utf8"));
const outputs = [registryPath, evidencePath, screenshotPath];
if (new Set(outputs.map((entry) => path.resolve(entry))).size !== outputs.length) {
  throw new Error("P2 UI 烟测 registry/evidence/screenshot 必须是三个不同路径。");
}
const [canonicalOutputs, allowedRoots, forbiddenRoots] = await Promise.all([
  Promise.all(outputs.map(canonicalTarget)),
  Promise.all([
    canonicalTarget(path.join(workspace, "docs", "evidence")),
    canonicalTarget(os.tmpdir()),
    canonicalTarget("/tmp"),
    canonicalTarget("/private/tmp"),
  ]),
  Promise.all([
    canonicalTarget(projectRoot),
    canonicalTarget(path.join(workspace, "productions")),
    ...(projectConfig.sourceRoots ?? []).map((root) => canonicalTarget(root)),
  ]),
]);
for (let index = 0; index < outputs.length; index += 1) {
  const outputPath = outputs[index];
  const canonical = canonicalOutputs[index];
  if (!allowedRoots.some((root) => isWithin(canonical, root))) {
    throw new Error(`P2 UI 烟测输出只允许落在系统临时目录或 workspace/docs/evidence：${outputPath}`);
  }
  if (forbiddenRoots.some((root) => isWithin(canonical, root))) {
    throw new Error(`P2 UI 烟测输出禁止落入项目、只读源或 productions：${outputPath}`);
  }
  if (await exists(outputPath)) throw new Error(`P2 UI 证据已存在，拒绝覆盖：${outputPath}`);
  await mkdir(path.dirname(outputPath), { recursive: true });
}

const guardedFiles = {
  resolutions: path.join(sidecar, "panel-reference-resolutions.json"),
  selections: path.join(sidecar, "storyboard-grid-selections.json"),
  storyboards: path.join(sidecar, "storyboards.json"),
  continuity: path.join(sidecar, "continuity-tracks.json"),
  productionAssets: path.join(sidecar, "production-assets.json"),
};
for (const filePath of Object.values(guardedFiles)) {
  if (!await exists(filePath)) throw new Error(`P2 UI 烟测缺少只读输入：${filePath}`);
}
const beforeHashes = await hashFiles(guardedFiles);
await writeFile(registryPath, `${JSON.stringify([{
  id: projectConfig.id,
  name: projectConfig.name,
  primaryRoot: projectRoot,
  updatedAt: projectConfig.updatedAt,
}], null, 2)}\n`, "utf8");

const pageErrors = [];
const app = await electron.launch({
  args: ["."],
  cwd: workspace,
  env: {
    ...process.env,
    AI_CANVAS_PROJECT_ROOT: projectRoot,
    AI_CANVAS_REGISTRY_PATH: registryPath,
    AI_CANVAS_WINDOW_WIDTH: "1760",
    AI_CANVAS_WINDOW_HEIGHT: "1120",
  },
});

try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(120_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "引用闭包", exact: true }).click();
  await page.getByRole("heading", { name: "逐分镜引用闭包", exact: true }).waitFor();
  await page.locator('[data-testid="panel-reference-audit"], [data-testid="panel-reference-unavailable"]').first().waitFor();
  if (await page.locator('[data-testid="panel-reference-unavailable"]').isVisible()) {
    throw new Error(`P2 UI 失败关闭：${(await page.locator('[data-testid="panel-reference-unavailable"]').textContent())?.replace(/\s+/gu, " ").trim()}`);
  }
  await page.locator('[data-testid="panel-reference-currentness"]').waitFor();

  const apiState = await page.evaluate(async (root) => {
    const [currentness, audit, pageResult, derived] = await Promise.all([
      window.canvasApi.inspectFusionPanelReferenceCurrentness(root),
      window.canvasApi.auditFusionPanelReferences(root),
      window.canvasApi.listFusionPanelReferenceResolutions(root, { offset: 0, limit: 50 }),
      window.canvasApi.listDerivedPanelReferenceAssets(root, { offset: 0, limit: 200 }),
    ]);
    return {
      currentness,
      audit,
      page: { total: pageResult.total, count: pageResult.items.length, storeRevision: pageResult.storeRevision, storeFingerprint: pageResult.storeFingerprint, auditFingerprint: pageResult.audit.auditFingerprint },
      derived: { total: derived.total, count: derived.items.length, storeRevision: derived.storeRevision, items: derived.items },
    };
  }, projectRoot);

  if (!apiState.currentness.current
    || apiState.audit.currentContracts !== 1_288
    || apiState.audit.panels !== 4_330
    || apiState.audit.contractCoverageVersion !== 1
    || apiState.audit.semanticAssetBindings !== 13_812
    || apiState.audit.referenceSlots !== 12_720
    || apiState.audit.detectedRowContinuityDifferencePanels !== 913
    || apiState.audit.detectedRowContinuityDifferences !== 1_994
    || !apiState.audit.closurePassed
    || apiState.audit.unresolvedPanels !== 0
    || apiState.audit.knownAssetMissingBindingPanels !== 0
    || apiState.audit.semanticAssetMissingSlotPanels !== 0
    || apiState.audit.contractAssetMissingBindingPanels !== 0
    || apiState.audit.explicitContinuityMissingBindingPanels !== 0
    || apiState.audit.unhandledOverflowPanels !== 0
    || apiState.audit.timeSpanContinuityMismatchPanels !== 0
    || apiState.page.total !== 4_330
    || apiState.page.count !== 50
    || apiState.page.storeRevision !== apiState.currentness.storeRevision
    || apiState.page.storeFingerprint !== apiState.currentness.storeFingerprint
    || apiState.page.auditFingerprint !== apiState.audit.auditFingerprint
    || apiState.derived.storeRevision !== apiState.currentness.storeRevision
    || apiState.derived.total < 1
    || apiState.derived.count !== apiState.derived.total) {
    throw new Error(`P2 API 审计合同异常：${JSON.stringify(apiState)}`);
  }

  const currentnessUi = (await page.locator('[data-testid="panel-reference-currentness"]').textContent())?.replace(/\s+/gu, " ").trim();
  if (!currentnessUi?.includes(`CURRENT · r${apiState.currentness.storeRevision}`)
    || !currentnessUi.includes(apiState.currentness.storeFingerprint.slice(0, 10))) {
    throw new Error(`P2 UI currentness 身份展示异常：${currentnessUi}`);
  }

  const auditUi = await page.locator('[data-testid="panel-reference-audit"]').evaluate((element) => ({
    verdict: element.querySelector(".audit-verdict")?.textContent?.replace(/\s+/gu, " ").trim(),
    production: [...element.querySelectorAll(".production-counts > div")].map((node) => node.textContent?.replace(/\s+/gu, " ").trim()),
    closureErrors: [...element.querySelectorAll(".closure-errors > div")].map((node) => node.textContent?.replace(/\s+/gu, " ").trim()),
  }));
  if (!auditUi.verdict?.includes("闭包通过")
    || !auditUi.verdict.includes("1,288 单元 / 4,330 宫格")
    || auditUi.production.length !== 3
    || !auditUi.production[0]?.includes(new Intl.NumberFormat("zh-CN").format(apiState.audit.generationReadyPanels))
    || !auditUi.production[1]?.includes(new Intl.NumberFormat("zh-CN").format(apiState.audit.pendingHardLockPanels))
    || !auditUi.production[2]?.includes(new Intl.NumberFormat("zh-CN").format(apiState.audit.pendingDerivedArtifactPanels))
    || auditUi.closureErrors.length !== 4
    || auditUi.closureErrors.some((entry) => !entry?.endsWith("0"))) {
    throw new Error(`P2 UI 审计呈现异常：${JSON.stringify(auditUi)}`);
  }

  const collectedDerivedIds = new Set();
  let derivedPagesVisited = 0;
  for (;;) {
    derivedPagesVisited += 1;
    const ids = await page.locator(".derived-card").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-derived-id")));
    ids.filter(Boolean).forEach((id) => collectedDerivedIds.add(id));
    const nextDerived = page.locator('[data-testid="derived-reference-pager"]').getByRole("button", { name: "下一页", exact: false });
    if (await nextDerived.isDisabled()) break;
    const previousFirst = ids[0];
    await nextDerived.click();
    await page.waitForFunction((oldFirst) => document.querySelector(".derived-card")?.getAttribute("data-derived-id") !== oldFirst, previousFirst);
  }
  if (collectedDerivedIds.size !== apiState.derived.total || derivedPagesVisited !== Math.ceil(apiState.derived.total / 10)) {
    throw new Error(`P2 派生资产未全量可分页访问：${JSON.stringify({ collected: collectedDerivedIds.size, total: apiState.derived.total, derivedPagesVisited })}`);
  }
  const derivedCard = page.locator(".derived-card").first();
  const selectedDerivedId = await derivedCard.getAttribute("data-derived-id");
  await derivedCard.click();
  await page.locator('[data-testid="derived-reference-detail"]').waitFor();
  const selectedDerivedApi = apiState.derived.items.find((item) => item.id === selectedDerivedId);
  const derivedUi = {
    total: collectedDerivedIds.size,
    pagesVisited: derivedPagesVisited,
    selectedId: selectedDerivedId,
    listText: (await derivedCard.textContent())?.replace(/\s+/gu, " ").trim(),
    detailText: (await page.locator('[data-testid="derived-reference-detail"]').textContent())?.replace(/\s+/gu, " ").trim(),
  };
  if (!selectedDerivedApi || !derivedUi.detailText?.includes(selectedDerivedApi.status)) {
    throw new Error(`P2 派生资产详情缺失状态：${JSON.stringify(derivedUi)}`);
  }
  if (selectedDerivedApi.visualArtifact) {
    for (const expected of [selectedDerivedApi.visualArtifact.path, selectedDerivedApi.visualArtifact.sha256, selectedDerivedApi.visualArtifact.reviewer, selectedDerivedApi.visualArtifact.reviewNote, selectedDerivedApi.visualArtifact.reviewId]) {
      if (!derivedUi.detailText.includes(expected)) throw new Error(`P2 派视觉产物详情缺失：${expected}`);
    }
  } else if (!derivedUi.detailText.includes("未登记")) {
    throw new Error("P2 派生资产没有视觉产物时未显式失败关闭。");
  }

  await page.getByLabel("集数").selectOption("1");
  await page.waitForTimeout(100);
  await page.waitForFunction(() => !document.querySelector(".list-loading"));
  const episodeRows = await page.locator(".resolution-row").count();
  if (episodeRows < 1 || episodeRows > 50) throw new Error(`EP01 分页行数异常：${episodeRows}`);

  await page.getByLabel("集数").selectOption("all");
  await page.getByLabel("仅看超出六项").check();
  await page.waitForFunction((expected) => document.querySelector(".result-count")?.textContent?.includes(expected), new Intl.NumberFormat("zh-CN").format(apiState.audit.detectedOverflowPanels));
  const overflowRows = page.locator(".resolution-row");
  if (await overflowRows.count() < 1) throw new Error("EP01 未显示任何由派生组合承接的超限宫格。");
  await overflowRows.first().click();
  await page.locator(".evidence-header").waitFor();
  const detailUi = await page.locator('[data-testid="panel-reference-evidence"]').evaluate((element) => ({
    heading: element.querySelector(".evidence-header h3")?.textContent?.trim(),
    identityLines: [...element.querySelectorAll(".identity-block code")].map((node) => node.textContent?.trim()),
    semanticAssets: element.querySelectorAll(".asset-evidence").length,
    referenceSlots: element.querySelectorAll(".slot-evidence").length,
    derivedVisible: element.querySelector(".derived-section")?.textContent?.includes("派生组合资产"),
    issuesSection: Boolean(element.querySelector('[data-testid="panel-reference-issues"]')),
    exclusionsSection: Boolean(element.querySelector('[data-testid="panel-reference-exclusions"]')),
    reconciliationsSection: Boolean(element.querySelector('[data-testid="panel-reference-reconciliations"]')),
  }));
  if (!detailUi.heading
    || detailUi.identityLines.length !== 2
    || detailUi.identityLines.some((entry) => !entry)
    || detailUi.semanticAssets < 7
    || detailUi.referenceSlots > 6
    || !detailUi.derivedVisible
    || !detailUi.issuesSection
    || !detailUi.exclusionsSection
    || !detailUi.reconciliationsSection) {
    throw new Error(`P2 单条证据或六槽门禁呈现异常：${JSON.stringify(detailUi)}`);
  }

  const layout = await page.evaluate(() => ({
    rootOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    workbenchOverflow: (() => {
      const node = document.querySelector('[data-testid="panel-reference-workbench"]');
      return node ? node.scrollWidth > node.clientWidth : true;
    })(),
    navLabels: [...document.querySelectorAll(".module-nav button")].map((node) => node.textContent?.trim()),
  }));
  if (layout.rootOverflow || layout.workbenchOverflow || !layout.navLabels.includes("引用闭包")) {
    throw new Error(`P2 UI 布局或导航异常：${JSON.stringify(layout)}`);
  }

  await page.screenshot({ path: screenshotPath, type: "png", animations: "disabled" });
  const [screenshotStat, screenshotMetadata, screenshotSha256] = await Promise.all([
    stat(screenshotPath),
    sharp(screenshotPath).metadata(),
    sha256(screenshotPath),
  ]);
  if (!screenshotMetadata.width || !screenshotMetadata.height || screenshotMetadata.width < 900 || screenshotMetadata.height < 600) {
    throw new Error(`P2 UI 截图不可解码或尺寸不足：${JSON.stringify(screenshotMetadata)}`);
  }
  const screenshotEvidence = {
    path: screenshotPath,
    sha256: screenshotSha256,
    bytes: screenshotStat.size,
    dimensions: [screenshotMetadata.width, screenshotMetadata.height],
  };
  const afterHashes = await hashFiles(guardedFiles);
  if (JSON.stringify(beforeHashes) !== JSON.stringify(afterHashes)) {
    throw new Error(`P2 只读 UI 意外改写侧车：${JSON.stringify({ beforeHashes, afterHashes })}`);
  }
  if (pageErrors.length) throw new Error(`P2 UI 出现 pageerror：${pageErrors.join("；")}`);

  const evidence = {
    schemaVersion: 1,
    kind: "p2-panel-reference-ui-smoke",
    createdAt: new Date().toISOString(),
    transport: "electron-current-production-build",
    projectRoot,
    auditFingerprint: apiState.audit.auditFingerprint,
    registryPath,
    screenshot: screenshotEvidence,
    guardedFiles: { beforeHashes, afterHashes, unchanged: true },
    apiState,
    currentnessUi,
    auditUi,
    derivedUi,
    detailUi,
    layout,
    pageErrors,
    assertions: {
      fullSeasonCountsVisible: true,
      fourClosureErrorsVisibleAndZero: true,
      generationReadinessSeparated: true,
      filtersAndPaginationOperational: true,
      derivedAssetsFullyPaginated: true,
      storeIdentityBoundAcrossReads: true,
      exactResolutionEvidenceVisible: true,
      issuesExclusionsAndReconciliationsVisible: true,
      derivedVisualEvidenceFieldsVisible: true,
      derivedAssetsVisible: true,
      supplierSlotsNeverExceedSix: true,
      readOnlyUiDidNotWrite: true,
    },
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({ evidencePath, screenshotPath, audit: apiState.audit, auditUi, detailUi, layout }, null, 2)}\n`);
} finally {
  await app.close();
}
