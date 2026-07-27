import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

function parseCli(argv) {
  const known = new Set(["--workspace", "--project-root", "--registry", "--evidence", "--screenshot"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!known.has(key)) throw new Error(`P3 UI 烟测未知参数：${key}`);
    if (!value || value.startsWith("--")) throw new Error(`P3 UI 烟测参数缺少值：${key}`);
    if (values.has(key)) throw new Error(`P3 UI 烟测参数重复：${key}`);
    values.set(key, value);
  }
  return values;
}

const cli = parseCli(process.argv.slice(2));
const workspace = path.resolve(cli.get("--workspace") || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const projectRoot = path.resolve(cli.get("--project-root") || "/Users/hxx/Documents/无限画布/productions/gushujuan-s3-f1a688020bfb7af6");
const evidencePath = path.resolve(cli.get("--evidence") || path.join(os.tmpdir(), "ai-canvas-p3-visual-constraints-ui-smoke.json"));
const screenshotPath = path.resolve(cli.get("--screenshot") || path.join(os.tmpdir(), "ai-canvas-p3-visual-constraints-ui-smoke.png"));
const registryPath = path.resolve(cli.get("--registry") || path.join(os.tmpdir(), `ai-canvas-p3-ui-registry-${createHash("sha256").update(evidencePath).digest("hex").slice(0, 16)}.json`));
const sidecar = path.join(projectRoot, ".aicanvas");

async function exists(filePath) {
  return access(filePath).then(() => true).catch(() => false);
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
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

const outputs = [registryPath, evidencePath, screenshotPath];
if (new Set(outputs).size !== outputs.length) throw new Error("P3 UI 烟测的 registry/evidence/screenshot 必须为不同路径。");
const [canonicalOutputs, allowedRoots, forbiddenRoot] = await Promise.all([
  Promise.all(outputs.map(canonicalTarget)),
  Promise.all([canonicalTarget(os.tmpdir()), canonicalTarget("/tmp"), canonicalTarget("/private/tmp"), canonicalTarget(path.join(workspace, "docs", "evidence"))]),
  canonicalTarget(projectRoot),
]);
for (let index = 0; index < outputs.length; index += 1) {
  if (!allowedRoots.some((root) => isWithin(canonicalOutputs[index], root)) || isWithin(canonicalOutputs[index], forbiddenRoot)) {
    throw new Error(`P3 UI 烟测输出路径越界：${outputs[index]}`);
  }
  if (await exists(outputs[index])) throw new Error(`P3 UI 烟测证据已存在，拒绝覆盖：${outputs[index]}`);
  await mkdir(path.dirname(outputs[index]), { recursive: true });
}

const guardedFiles = {
  visualConstraints: path.join(sidecar, "panel-visual-constraints.json"),
  panelReferences: path.join(sidecar, "panel-reference-resolutions.json"),
  jobs: path.join(sidecar, "generation-jobs.json"),
  publications: path.join(sidecar, "publications.json"),
  reviews: path.join(sidecar, "reviews.json"),
};
for (const filePath of Object.values(guardedFiles)) {
  if (!await exists(filePath)) throw new Error(`P3 UI 烟测缺少只读输入：${filePath}`);
}
const beforeHashes = Object.fromEntries(await Promise.all(Object.entries(guardedFiles).map(async ([key, filePath]) => [key, await sha256(filePath)])));
const projectConfig = JSON.parse(await readFile(path.join(sidecar, "project.json"), "utf8"));
await writeFile(registryPath, `${JSON.stringify([{ id: projectConfig.id, name: projectConfig.name, primaryRoot: projectRoot, updatedAt: projectConfig.updatedAt }], null, 2)}\n`, "utf8");

const pageErrors = [];
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

let referenceEvidence;
let reviewEvidence;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(180_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");

  await page.getByRole("button", { name: "引用闭包", exact: true }).click();
  await page.getByRole("heading", { name: "逐分镜引用闭包", exact: true }).waitFor();
  await page.locator('[data-testid="panel-reference-audit"]').waitFor();
  const apiReference = await page.evaluate(async (root) => {
    const currentness = await window.canvasApi.inspectFusionPanelVisualConstraintCurrentness(root);
    const pageResult = await window.canvasApi.listFusionPanelReferenceResolutions(root, { episode: 1, offset: 0, limit: 50 });
    const row = pageResult.items[0];
    if (!row) throw new Error("EP01 没有 P2 宫格详情。");
    const constraint = await window.canvasApi.getFusionPanelVisualConstraint(root, row.gridContractId, row.panelId);
    return { currentness, row, constraint };
  }, projectRoot);
  if (!apiReference.currentness.current || apiReference.constraint.inputSnapshot.resolutionId !== apiReference.row.resolutionId) {
    throw new Error(`P3 IPC 身份或 currentness 异常：${JSON.stringify(apiReference.currentness)}`);
  }
  if (/\/Users\/|file:\/\/|\u9ec4金面具|完整面具|半面具|裂面/iu.test(`${apiReference.constraint.modelPrompt}\n${apiReference.constraint.modelNegativePrompt}`)) {
    throw new Error("EP01 P3 模型载荷泄露本地路径或隐藏面具身份。");
  }
  const targetRow = page.locator(`.resolution-row[data-contract-id="${apiReference.row.gridContractId}"][data-panel-id="${apiReference.row.panelId}"]`);
  await targetRow.click();
  await page.locator('[data-testid="panel-visual-currentness"]').waitFor();
  if (await page.locator('[data-testid="panel-visual-unavailable"]').count()) throw new Error("P3 详情在当前工程不可用。");
  const constraintUi = await page.locator('[data-testid="panel-visual-constraints"]').textContent();
  for (const expected of ["P3 剧情与视觉硬锁", "Must appear", "Must not appear", "身份硬锁", "空间与机位锁", "连续性锁", "模型安全载荷", "本地人工视觉规则", "不宣称已自动识别"]) {
    if (!constraintUi?.includes(expected)) throw new Error(`P3 详情 UI 缺少：${expected}`);
  }
  referenceEvidence = {
    currentness: apiReference.currentness,
    contractId: apiReference.row.gridContractId,
    panelId: apiReference.row.panelId,
    constraintId: apiReference.constraint.constraintId,
    reviewRules: apiReference.constraint.reviewRules.length,
    warnings: apiReference.constraint.warnings.length,
    unresolved: {
      identity: apiReference.constraint.identityLocks.filter((entry) => entry.status === "unresolved").length,
      spatial: apiReference.constraint.spatialLocks.filter((entry) => entry.status === "unresolved").length,
      continuity: apiReference.constraint.continuityLocks.filter((entry) => entry.status === "unresolved").length,
    },
  };

  const targetReview = await page.evaluate(async (root) => {
    const entries = await window.canvasApi.getReviewQueue(root, { episode: 1, includeResolved: true });
    const target = entries.find((entry) => entry.reviewType === "image"
      && entry.reviewRequirement?.complete
      && entry.reviewRequirement.panels.every((panel) => panel.panelVisualConstraintEvidenceVersion === 1 && panel.visualReviewRules?.length));
    if (!target) throw new Error("EP01 没有带完整 P3 规则的图片 Review 节点。");
    return { itemId: target.item.id, episode: target.item.episode, requirement: target.reviewRequirement };
  }, projectRoot);

  await page.getByRole("button", { name: "导演验收", exact: true }).click();
  await page.getByRole("heading", { name: "版本对照与视觉结论", exact: true }).waitFor();
  const resolvedToggle = page.locator(".queue-filter input[type=checkbox]");
  if (!await resolvedToggle.isChecked()) await resolvedToggle.check();
  await page.locator(".queue-filter select").selectOption(String(targetReview.episode));
  const queueTarget = page.locator(`[data-item-id="${targetReview.itemId}"]`);
  await queueTarget.waitFor();
  await queueTarget.click();
  await page.locator('[data-testid="visual-constraint-review"]').waitFor();
  const passButton = page.getByRole("button", { name: "视觉通过", exact: true });
  if (!await passButton.isDisabled()) throw new Error("P3 规则未人工确认时，视觉通过按钮未失败关闭。");
  let ruleButtonsClicked = 0;
  for (const panel of targetReview.requirement.panels) {
    await page.locator(`[data-panel-id="${panel.panelId}"]`).click();
    const rules = page.locator('[data-testid="visual-constraint-review"] > article');
    if (await rules.count() !== panel.visualReviewRules.length) throw new Error(`宫格 ${panel.panelId} 的人工规则数量不一致。`);
    const passRules = rules.locator(".visual-rule-actions button:first-child");
    for (let index = 0; index < await passRules.count(); index += 1) {
      await passRules.nth(index).click();
      ruleButtonsClicked += 1;
    }
  }
  for (const criterion of await page.locator(".criteria-list article").all()) await criterion.locator(".criterion-actions button").first().click();
  if (await passButton.isDisabled()) throw new Error("P3 全宫格规则和通用检查已人工确认后，视觉通过仍被错误阻断。");
  const remainingText = await page.locator('[data-testid="visual-constraint-review"] > footer').textContent();
  if (!remainingText?.includes("还需 0 条")) throw new Error(`P3 人工规则计数未归零：${remainingText}`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  reviewEvidence = {
    itemId: targetReview.itemId,
    requirementId: targetReview.requirement.id,
    panelCount: targetReview.requirement.panelCount,
    expectedRules: targetReview.requirement.panels.reduce((sum, panel) => sum + panel.visualReviewRules.length, 0),
    ruleButtonsClicked,
    passInitiallyDisabled: true,
    passEnabledAfterExplicitHumanChecks: true,
    submitClicked: false,
  };
} finally {
  await app.close();
}

const afterHashes = Object.fromEntries(await Promise.all(Object.entries(guardedFiles).map(async ([key, filePath]) => [key, await sha256(filePath)])));
if (JSON.stringify(beforeHashes) !== JSON.stringify(afterHashes)) {
  throw new Error(`P3 UI 只读烟测改写了正式侧车：${JSON.stringify({ beforeHashes, afterHashes })}`);
}
if (pageErrors.length) throw new Error(`P3 UI 页面异常：${pageErrors.join("；")}`);
const evidence = {
  schemaVersion: 1,
  kind: "p3-visual-constraints-ui-smoke",
  createdAt: new Date().toISOString(),
  workspace,
  projectRoot,
  referenceEvidence,
  reviewEvidence,
  guardedFiles: { before: beforeHashes, after: afterHashes, unchanged: true },
  screenshotPath,
  vendorOrGenerationInvoked: false,
  passed: true,
};
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ passed: true, evidencePath, screenshotPath, referenceEvidence, reviewEvidence }, null, 2));
