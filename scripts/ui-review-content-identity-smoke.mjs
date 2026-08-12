import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import sharp from "sharp";
import {
  captureBackgroundElectronStateOrThrow,
  closeElectronApplicationOrThrow,
} from "./lib/electron-application-close.mjs";
import {
  assertFreshOutputSet,
  createUniqueEvidenceStem,
  writeBytesAtomicExclusive,
  writeJsonAtomicExclusive,
} from "./lib/exclusive-evidence-output.mjs";
import {
  removeOwnedTemporaryFixtureRoot,
  resetOwnedFixtureRoot,
} from "./lib/owned-fixture-root.ts";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = process.env.AI_CANVAS_EVIDENCE_RUN_ID?.trim()
  || createUniqueEvidenceStem("review-content-identity-ui-smoke");
const projectRoot = path.resolve(process.argv[2] || "/tmp/ai-canvas-review-content-identity-ui");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-review-content-identity-registry.json");
const evidencePath = path.resolve(process.argv[4] || path.join(workspace, "docs", "evidence", `${runId}.json`));
const screenshotPath = path.resolve(process.argv[5] || path.join(workspace, "docs", "evidence", `${runId}.png`));
const packagedExecutable = process.env.AI_CANVAS_ELECTRON_EXECUTABLE?.trim();
const userDataPath = path.resolve(process.env.AI_CANVAS_ELECTRON_USER_DATA_PATH?.trim() || `${projectRoot}-electron-user-data`);
const backgroundSmokeEnabled = process.env.AI_CANVAS_ELECTRON_BACKGROUND_SMOKE === "1";
const closeRuns = [];
const backgroundSnapshots = [];
let bringToFrontUsed = false;
let app;

async function closeCurrentApplication(label) {
  if (!app) return;
  const current = app;
  app = undefined;
  let backgroundError;
  if (backgroundSmokeEnabled) {
    try {
      backgroundSnapshots.push(await captureBackgroundElectronStateOrThrow(current, { label: `${label}:before-close` }));
    } catch (error) {
      backgroundError = error;
    }
  }
  closeRuns.push(await closeElectronApplicationOrThrow(current, { label, timeoutMs: 20_000 }));
  if (backgroundError) throw backgroundError;
}

function isTemporaryPath(candidate) {
  return [os.tmpdir(), "/tmp", "/private/tmp"].map((base) => path.resolve(base)).some((base) => {
    const relative = path.relative(base, path.resolve(candidate));
    return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
}

const cleanupFixture = [projectRoot, registryPath, userDataPath].every(isTemporaryPath);
if (!cleanupFixture) throw new Error("ReviewStudio 的 project/registry/user-data 必须全部位于临时目录。 ");
await access(registryPath).then(
  () => { throw new Error(`ReviewStudio registry 必须是全新文件，拒绝覆盖：${registryPath}`); },
  () => undefined,
);
await mkdir(path.dirname(evidencePath), { recursive: true });
await mkdir(path.dirname(screenshotPath), { recursive: true });
await assertFreshOutputSet([
  { label: "ReviewStudio UI 证据", path: evidencePath },
  { label: "ReviewStudio UI 截图", path: screenshotPath },
]);
await resetOwnedFixtureRoot(userDataPath, "ui-review-content-identity-user-data");

async function screenshotContent(filePath) {
  const { data, info } = await sharp(filePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let brightPixels = 0;
  let chromaticPixels = 0;
  const regions = {
    top: { pixels: 0, brightPixels: 0 },
    left: { pixels: 0, brightPixels: 0 },
    right: { pixels: 0, brightPixels: 0 },
  };
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const pixel = offset / info.channels;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? 0;
    const blue = data[offset + 2] ?? 0;
    const bright = Math.max(red, green, blue) >= 50;
    if (bright) brightPixels += 1;
    if (Math.max(red, green, blue) - Math.min(red, green, blue) >= 28) chromaticPixels += 1;
    if (y < info.height * .2) { regions.top.pixels += 1; if (bright) regions.top.brightPixels += 1; }
    if (x < info.width * .18) { regions.left.pixels += 1; if (bright) regions.left.brightPixels += 1; }
    if (x >= info.width * .82) { regions.right.pixels += 1; if (bright) regions.right.brightPixels += 1; }
  }
  const pixels = info.width * info.height;
  return {
    pixels,
    brightPixels,
    brightRatio: brightPixels / pixels,
    chromaticPixels,
    chromaticRatio: chromaticPixels / pixels,
    edgeBrightRatios: Object.fromEntries(Object.entries(regions).map(([name, region]) => [name, region.brightPixels / region.pixels])),
  };
}

async function captureStableUi(page) {
  let content;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (!backgroundSmokeEnabled) {
      bringToFrontUsed = true;
      await page.bringToFront();
    }
    await page.waitForTimeout(700);
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const raw = await page.screenshot({ type: "png", animations: "disabled" });
    const candidatePath = path.join(userDataPath, `review-screenshot-${attempt}.png`);
    await sharp(raw).resize(viewport.width, viewport.height, { fit: "fill" }).png().toFile(candidatePath);
    content = await screenshotContent(candidatePath);
    if (content.brightRatio >= .01
      && content.chromaticRatio >= .005
      && Object.values(content.edgeBrightRatios).every((ratio) => ratio >= .003)) {
      await writeBytesAtomicExclusive(screenshotPath, await readFile(candidatePath));
      return { attempt, content };
    }
  }
  throw new Error(`ReviewStudio UI 截图连续三次内容覆盖不足：${JSON.stringify(content)}`);
}

async function launchApplication() {
  return electron.launch({
    ...(packagedExecutable
      ? { executablePath: path.resolve(packagedExecutable), args: [`--user-data-dir=${userDataPath}`] }
      : { args: [".", `--user-data-dir=${userDataPath}`] }),
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_PROJECT_ROOT: projectRoot,
      AI_CANVAS_WINDOW_WIDTH: "1560",
      AI_CANVAS_WINDOW_HEIGHT: "980",
    },
  });
}

async function openReviewStudio(page, options = {}) {
  await page.waitForLoadState("domcontentloaded");
  const firstRun = page.getByTestId("first-run-screen");
  const reviewButton = page.getByRole("button", { name: "导演验收" });
  if (await firstRun.isVisible().catch(() => false) && !await reviewButton.isVisible().catch(() => false)) {
    const recent = page.getByTestId("first-run-recent");
    await recent.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
    if (await recent.isVisible().catch(() => false)) {
      // The project may auto-open between the visibility check and click. In
      // that case the final ReviewStudio button below remains the hard gate.
      await recent.click({ timeout: 10_000 }).catch(() => undefined);
    }
  }
  await reviewButton.waitFor({ state: "visible", timeout: 90_000 });
  await reviewButton.click();
  await page.getByRole("heading", { name: "版本对照与视觉结论" }).waitFor();
  if (options.includeResolved) await page.locator(".queue-filter input[type=checkbox]").check();
  await page.locator(".media-frame img").first().waitFor();
}

const fixtureExecutable = path.join(workspace, "node_modules", ".bin", "tsx");
await execFileAsync(fixtureExecutable, ["scripts/create-review-fixture.ts", projectRoot], {
  cwd: workspace,
  env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath, AI_CANVAS_PROJECT_ROOT: projectRoot },
  maxBuffer: 2_000_000,
});

const pageErrors = [];
let evidence;
try {
  app = await launchApplication();
  const page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(`initial:${error.message}`));
  await openReviewStudio(page);
  if (backgroundSmokeEnabled) {
    backgroundSnapshots.push(await captureBackgroundElectronStateOrThrow(app, { label: "ReviewStudio first ready" }));
  }

  const initial = await page.evaluate(async ({ projectRoot }) => {
    const queue = await window.canvasApi.getReviewQueue(projectRoot, { includeResolved: true });
    const entry = queue.find((candidate) => candidate.item.id === "main-ep01-unit001");
    if (!entry) throw new Error("UI smoke 没有找到目标验收节点。");
    const target = entry.artifacts.find((artifact) => artifact.kind === "raw-image" && artifact.variant === "start" && artifact.authoritative);
    if (!target?.check.sha256) throw new Error("UI smoke 目标素材缺少 SHA-256。");
    return {
      itemId: entry.item.id,
      targetPath: target.path,
      targetId: target.id,
      sha256: target.check.sha256,
      scanId: entry.reviewSnapshot.scanId,
      historicalReviewCount: await window.canvasApi.listReviewRecords(projectRoot, { itemId: entry.item.id, limit: 50 }).then((records) => records.length),
    };
  }, { projectRoot });
  const initialMediaSrc = await page.locator(".media-frame img").first().getAttribute("src");
  if (!initialMediaSrc?.includes(`sha256=${initial.sha256}`)) throw new Error(`初始媒体 URL 没有绑定当前 SHA-256：${initialMediaSrc}`);

  await page.locator(".frame-tabs button").filter({ hasText: "尾帧" }).click();
  for (const button of await page.locator(".criteria-list .criterion-actions button:first-child").all()) await button.click();
  const passButton = page.getByRole("button", { name: "视觉通过" });
  await passButton.waitFor();
  if (await passButton.isDisabled()) throw new Error("查看首尾帧并完成全部检查后，视觉通过按钮仍被禁用。");
  const staleAttemptMediaSrc = await page.locator(".media-frame img").first().getAttribute("src");

  // 保持页面上的旧 snapshot，不点刷新就替换同路径文件；真实点击必须被拒绝，
  // 并由 ReviewStudio 自动 reload 新内容，而不是把旧目视结论绑定给新文件。
  await sharp({ create: { width: 904, height: 1600, channels: 3, background: "#5d344f" } })
    .png({ compressionLevel: 0 })
    .toFile(initial.targetPath);
  await passButton.click();
  await page.waitForFunction((previousSrc) => document.querySelector(".media-frame img")?.getAttribute("src") !== previousSrc, staleAttemptMediaSrc);
  const staleRejectedMediaSrc = await page.locator(".media-frame img").first().getAttribute("src");
  const staleRejected = await page.evaluate(async ({ projectRoot, itemId, targetId }) => {
    const queue = await window.canvasApi.getReviewQueue(projectRoot, { includeResolved: true });
    const entry = queue.find((candidate) => candidate.item.id === itemId);
    const target = entry?.artifacts.find((artifact) => artifact.id === targetId);
    return {
      status: entry?.item.status,
      latestReviewId: entry?.latestReview?.id,
      sha256: target?.check.sha256,
      scanId: entry?.reviewSnapshot.scanId,
      historicalReviewCount: await window.canvasApi.listReviewRecords(projectRoot, { itemId, limit: 50 }).then((records) => records.length),
    };
  }, { projectRoot, itemId: initial.itemId, targetId: initial.targetId });
  if (staleRejected.status !== "待视觉验收" || staleRejected.latestReviewId !== undefined || staleRejected.historicalReviewCount !== initial.historicalReviewCount) {
    throw new Error(`旧快照提交没有被无副作用拒绝：${JSON.stringify({ initial, staleRejected })}`);
  }
  if (!staleRejected.sha256 || staleRejected.sha256 === initial.sha256 || !staleRejectedMediaSrc?.includes(`sha256=${staleRejected.sha256}`) || !(await passButton.isDisabled())) {
    throw new Error(`旧快照拒绝后没有自动载入新 SHA 或重置检查项：${JSON.stringify({ initialMediaSrc, staleRejectedMediaSrc, initial, staleRejected })}`);
  }

  await page.locator(".frame-tabs button").filter({ hasText: "尾帧" }).click();
  for (const button of await page.locator(".criteria-list .criterion-actions button:first-child").all()) await button.click();
  if (await passButton.isDisabled()) throw new Error("旧快照拒绝后重新检查全部素材，视觉通过按钮仍被禁用。");
  await passButton.click();
  await page.locator(".review-item-heading > b").filter({ hasText: "待视频" }).waitFor();

  const passed = await page.evaluate(async ({ projectRoot, itemId, targetId }) => {
    const queue = await window.canvasApi.getReviewQueue(projectRoot, { includeResolved: true });
    const entry = queue.find((candidate) => candidate.item.id === itemId);
    const target = entry?.artifacts.find((artifact) => artifact.id === targetId);
    return {
      status: entry?.item.status,
      latestReviewId: entry?.latestReview?.id,
      sha256: target?.check.sha256,
      historicalReviewCount: await window.canvasApi.listReviewRecords(projectRoot, { itemId, limit: 50 }).then((records) => records.length),
    };
  }, { projectRoot, itemId: initial.itemId, targetId: initial.targetId });
  const passedMediaSrc = await page.locator(".media-frame img").first().getAttribute("src");
  if (passed.status !== "待视频" || !passed.latestReviewId || passed.sha256 !== staleRejected.sha256 || !passedMediaSrc?.includes(`sha256=${passed.sha256}`)) {
    throw new Error(`重新检查后的视觉通过没有绑定当前 SHA：${JSON.stringify({ passed, passedMediaSrc, staleRejected })}`);
  }

  await closeCurrentApplication("ReviewStudio first graceful close");
  app = await launchApplication();
  const restartPage = await app.firstWindow();
  restartPage.on("pageerror", (error) => pageErrors.push(`restart:${error.message}`));
  await openReviewStudio(restartPage, { includeResolved: true });
  if (backgroundSmokeEnabled) {
    backgroundSnapshots.push(await captureBackgroundElectronStateOrThrow(app, { label: "ReviewStudio restart ready" }));
  }
  await restartPage.locator(".review-item-heading > b").filter({ hasText: "待视频" }).waitFor();
  const restarted = await restartPage.evaluate(async ({ projectRoot, itemId, targetId }) => {
    const queue = await window.canvasApi.getReviewQueue(projectRoot, { includeResolved: true });
    const entry = queue.find((candidate) => candidate.item.id === itemId);
    const target = entry?.artifacts.find((artifact) => artifact.id === targetId);
    return {
      status: entry?.item.status,
      latestReviewId: entry?.latestReview?.id,
      sha256: target?.check.sha256,
      historicalReviewCount: await window.canvasApi.listReviewRecords(projectRoot, { itemId, limit: 50 }).then((records) => records.length),
    };
  }, { projectRoot, itemId: initial.itemId, targetId: initial.targetId });
  const restartedMediaSrc = await restartPage.locator(".media-frame img").first().getAttribute("src");
  if (restarted.status !== "待视频" || restarted.latestReviewId !== passed.latestReviewId || restarted.sha256 !== passed.sha256 || !restartedMediaSrc?.includes(`sha256=${restarted.sha256}`)) {
    throw new Error(`完整应用重启后当前视觉通过没有恢复：${JSON.stringify({ passed, restarted, restartedMediaSrc })}`);
  }

  await sharp({ create: { width: 912, height: 1600, channels: 3, background: "#245867" } })
    .png({ compressionLevel: 0 })
    .toFile(initial.targetPath);
  await restartPage.locator(".review-header").getByRole("button", { name: /刷新/ }).click();
  await restartPage.locator(".review-item-heading > b").filter({ hasText: "待视觉验收" }).waitFor();
  await restartPage.locator(".media-frame img").first().waitFor();

  const refreshed = await restartPage.evaluate(async ({ projectRoot, itemId, targetId }) => {
    const queue = await window.canvasApi.getReviewQueue(projectRoot, { includeResolved: true });
    const entry = queue.find((candidate) => candidate.item.id === itemId);
    const target = entry?.artifacts.find((artifact) => artifact.id === targetId);
    return {
      status: entry?.item.status,
      latestReviewId: entry?.latestReview?.id,
      sha256: target?.check.sha256,
      scanId: entry?.reviewSnapshot.scanId,
      historicalReviewCount: await window.canvasApi.listReviewRecords(projectRoot, { itemId, limit: 50 }).then((records) => records.length),
    };
  }, { projectRoot, itemId: initial.itemId, targetId: initial.targetId });
  const refreshedMediaSrc = await restartPage.locator(".media-frame img").first().getAttribute("src");
  if (refreshed.status !== "待视觉验收" || refreshed.latestReviewId !== undefined) throw new Error(`内容漂移后当前验收状态错误：${JSON.stringify(refreshed)}`);
  if (!refreshed.sha256 || refreshed.sha256 === staleRejected.sha256 || !refreshedMediaSrc?.includes(`sha256=${refreshed.sha256}`) || refreshedMediaSrc === staleRejectedMediaSrc) {
    throw new Error(`内容漂移后媒体 URL/哈希没有刷新：${JSON.stringify({ staleRejectedMediaSrc, refreshedMediaSrc, staleRejected, refreshed })}`);
  }
  if ((refreshed.historicalReviewCount ?? 0) < 2) throw new Error("旧 pending/pass 验收历史没有保留。 ");

  await restartPage.waitForTimeout(2_600);
  const screenshotCapture = await captureStableUi(restartPage);
  const screenshotBuffer = await readFile(screenshotPath);
  const screenshotMetadata = await sharp(screenshotBuffer).metadata();
  const screenshotStat = await stat(screenshotPath);
  evidence = {
    schemaVersion: 3,
    runId,
    generatedAt: new Date().toISOString(),
    status: "passed",
    transport: packagedExecutable ? "packaged-electron-current-source" : "source-electron-current-build",
    executablePath: packagedExecutable ? path.resolve(packagedExecutable) : undefined,
    projectRoot,
    registryPath,
    userDataPath,
    initial: { ...initial, mediaSrc: initialMediaSrc },
    staleRejected: { ...staleRejected, attemptedMediaSrc: staleAttemptMediaSrc, mediaSrc: staleRejectedMediaSrc },
    passed: { ...passed, mediaSrc: passedMediaSrc },
    restarted: { ...restarted, mediaSrc: restartedMediaSrc },
    refreshed: { ...refreshed, mediaSrc: refreshedMediaSrc },
    pageErrors,
    backgroundSmoke: {
      enabled: backgroundSmokeEnabled,
      bringToFrontUsed,
      snapshots: backgroundSnapshots,
    },
    assertions: {
      staleSubmitRejectedThroughUi: true,
      staleAttemptWroteNoReview: staleRejected.historicalReviewCount === initial.historicalReviewCount,
      staleRejectAutoReloadedHash: staleRejected.sha256 !== initial.sha256 && staleRejectedMediaSrc !== initialMediaSrc,
      staleRejectResetCriteria: true,
      visualPassSubmittedThroughUi: true,
      passRestoredAfterApplicationRestart: restarted.status === "待视频" && restarted.latestReviewId === passed.latestReviewId,
      restartHashMatchesPassedContent: restarted.sha256 === passed.sha256 && restartedMediaSrc?.includes(`sha256=${passed.sha256}`),
      samePathArtifactIdStable: true,
      shaChanged: refreshed.sha256 !== initial.sha256,
      stalePassNotCurrent: refreshed.latestReviewId === undefined,
      statusReturnedToVisualReview: refreshed.status === "待视觉验收",
      cacheBustChanged: refreshedMediaSrc !== staleRejectedMediaSrc,
      historyPreserved: (refreshed.historicalReviewCount ?? 0) >= 2,
      pageErrors: pageErrors.length,
      screenshotCaptureAttempt: screenshotCapture.attempt,
    },
    screenshot: {
      path: screenshotPath,
      bytes: screenshotStat.size,
      sha256: createHash("sha256").update(screenshotBuffer).digest("hex"),
      width: screenshotMetadata.width,
      height: screenshotMetadata.height,
      content: screenshotCapture.content,
    },
  };
  if (pageErrors.length || evidence.screenshot.bytes < 20_000 || evidence.screenshot.width !== 1560 || evidence.screenshot.height !== 980) throw new Error(`ReviewStudio UI 证据异常：${JSON.stringify({ pageErrors, screenshot: evidence.screenshot })}`);
} finally {
  await closeCurrentApplication("ReviewStudio final graceful close");
  if (cleanupFixture) {
    if (await access(projectRoot).then(() => true, () => false)) {
      await removeOwnedTemporaryFixtureRoot(projectRoot, "create-review-fixture");
    }
    await rm(registryPath, { force: true });
    await removeOwnedTemporaryFixtureRoot(userDataPath, "ui-review-content-identity-user-data");
  }
}

if (!evidence) throw new Error("ReviewStudio UI smoke 未生成证据对象。 ");
const terminal = {
  rootRemoved: await access(projectRoot).then(() => false, () => true),
  registryRemoved: await access(registryPath).then(() => false, () => true),
  userDataRemoved: await access(userDataPath).then(() => false, () => true),
};
if (packagedExecutable && (!terminal.rootRemoved || !terminal.registryRemoved || !terminal.userDataRemoved)) throw new Error(`packaged ReviewStudio 隔离夹具未清理：${JSON.stringify(terminal)}`);
evidence.terminal = terminal;
evidence.closeRuns = closeRuns;
await writeJsonAtomicExclusive(evidencePath, evidence);
process.stdout.write(`${JSON.stringify({ evidencePath, status: evidence.status, transport: evidence.transport, screenshot: evidence.screenshot, assertions: evidence.assertions, terminal }, null, 2)}\n`);
