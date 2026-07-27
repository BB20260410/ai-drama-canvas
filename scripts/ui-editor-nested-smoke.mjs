import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = path.resolve(process.argv[2] || path.join(workspace, "docs", "evidence", "editor-nested-ui-smoke-20260714.json"));
const evidenceDirectory = path.dirname(evidencePath);
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-editor-nested-ui-"));
const root = path.join(runtimeRoot, "project");
const registryPath = path.join(runtimeRoot, "registry.json");
const screenshotPath = path.join(evidenceDirectory, "editor-nested-ui-20260714.png");
const fixtureScript = path.join(workspace, "scripts", "create-editor-ui-fixture.ts");
const tsxExecutable = path.join(workspace, "node_modules", ".bin", "tsx");

await mkdir(evidenceDirectory, { recursive: true });
let app;
let evidence;

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function dataFileEvidence(filePath) {
  const buffer = await readFile(filePath);
  return { path: filePath, bytes: buffer.byteLength, sha256: sha256Buffer(buffer) };
}

async function imageEvidence(filePath) {
  const buffer = await readFile(filePath);
  const metadata = await sharp(buffer).metadata();
  return { path: filePath, bytes: buffer.byteLength, sha256: sha256Buffer(buffer), width: metadata.width, height: metadata.height };
}

async function screenshotContent(filePath) {
  const { data, info } = await sharp(filePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let brightPixels = 0;
  let chromaticPixels = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? 0;
    const blue = data[offset + 2] ?? 0;
    if (Math.max(red, green, blue) >= 50) brightPixels += 1;
    if (Math.max(red, green, blue) - Math.min(red, green, blue) >= 28) chromaticPixels += 1;
  }
  const pixels = info.width * info.height;
  return { pixels, brightPixels, brightRatio: brightPixels / pixels, chromaticPixels, chromaticRatio: chromaticPixels / pixels };
}

async function captureStableUi(page, outputPath) {
  let content;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.bringToFront();
    await page.waitForTimeout(700);
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const raw = await page.screenshot({ type: "png", animations: "disabled" });
    await sharp(raw).resize(viewport.width, viewport.height, { fit: "fill" }).png().toFile(outputPath);
    content = await screenshotContent(outputPath);
    if (content.brightRatio >= .01 && content.chromaticRatio >= .005) return { attempt, content };
  }
  throw new Error(`永久截图连续三次内容覆盖不足：${JSON.stringify(content)}`);
}

function findNestedClip(project) {
  return project.tracks.flatMap((track) => track.clips).find((clip) => clip.kind === "timeline");
}

async function waitForProject(page, projectId, predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await page.evaluate(async ({ root, projectId }) => window.canvasApi.getEditProject(root, projectId), { root, projectId });
    if (predicate(latest)) return latest;
    await page.waitForTimeout(100);
  }
  throw new Error(`${label} 超时：${JSON.stringify(latest)}`);
}

async function waitForNestedPreview(page, timeoutMs = 25_000) {
  const video = page.getByTestId("preview-main-video");
  try {
    await video.waitFor({ state: "visible", timeout: timeoutMs });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      alerts: [...document.querySelectorAll('[role="alert"]')].map((entry) => entry.textContent),
      toast: document.querySelector(".toast-message")?.textContent,
      timelineClips: [...document.querySelectorAll(".timeline-clip")].map((entry) => entry.textContent),
      previewHtml: document.querySelector(".preview-frame")?.innerHTML,
    }));
    throw new Error(`等待嵌套视频元素超时：${JSON.stringify(diagnostics)}；${error instanceof Error ? error.message : String(error)}`);
  }
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-testid="preview-main-video"]');
    return element instanceof HTMLVideoElement && element.readyState >= 1 && element.videoWidth > 0 && element.videoHeight > 0 && Number.isFinite(element.duration) && element.duration > 0 && !element.error && Boolean(element.currentSrc);
  }, undefined, { timeout: timeoutMs });
  const metadata = await video.evaluate((element) => ({
    readyState: element.readyState,
    videoWidth: element.videoWidth,
    videoHeight: element.videoHeight,
    duration: element.duration,
    error: element.error ? { code: element.error.code, message: element.error.message } : null,
    currentSrc: element.currentSrc,
  }));
  if (!metadata.currentSrc.includes(".mp4")) throw new Error(`嵌套浏览器预览不是 MP4：${metadata.currentSrc}`);
  return metadata;
}

async function dispatchTrimEnd(handle, deltaPixels, pointerId) {
  const box = await handle.boundingBox();
  if (!box) throw new Error("嵌套裁尾手柄不可见。 ");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await handle.evaluate((element, args) => element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: args.pointerId, pointerType: "mouse", button: 0, buttons: 1, clientX: args.x, clientY: args.y })), { pointerId, x, y });
  await handle.page().evaluate((args) => window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: args.pointerId, pointerType: "mouse", button: 0, buttons: 1, clientX: args.x, clientY: args.y })), { pointerId, x: x + deltaPixels, y });
  await handle.page().waitForTimeout(80);
  await handle.evaluate((element, args) => element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: args.pointerId, pointerType: "mouse", button: 0, buttons: 0, clientX: args.x, clientY: args.y })), { pointerId, x: x + deltaPixels, y });
}

async function seekToStart(page) {
  await page.locator(".transport input[type=range]").evaluate((element) => {
    element.value = "0";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator(".transport span").filter({ hasText: "F0" }).waitFor();
}

try {
  const fixtureResult = await execFileAsync(tsxExecutable, [fixtureScript, root, registryPath, "nested"], { cwd: workspace, env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath }, maxBuffer: 2 * 1024 * 1024 });
  const fixture = JSON.parse(fixtureResult.stdout);
  if (fixture.mode !== "nested" || !fixture.parentEditProjectId || !fixture.childEditProjectId || fixture.childClips < 1) throw new Error(`嵌套隔离夹具无效：${fixtureResult.stdout}`);

  app = await electron.launch({ args: ["."], cwd: workspace, env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath, AI_CANVAS_WINDOW_WIDTH: "1560", AI_CANVAS_WINDOW_HEIGHT: "980" } });
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "导演剪辑台" }).click();
  await page.getByRole("heading", { name: "导演剪辑台" }).waitFor();

  const projectSelector = page.locator(".editor-actions select");
  if (await projectSelector.inputValue() !== fixture.parentEditProjectId) await projectSelector.selectOption(fixture.parentEditProjectId);
  const nestedSelector = page.getByTestId("nested-project-select");
  const nestedOptions = await nestedSelector.locator("option").evaluateAll((options) => options.map((option) => ({ value: option.value, text: option.textContent })));
  if (nestedOptions.some((option) => option.value === fixture.parentEditProjectId) || !nestedOptions.some((option) => option.value === fixture.childEditProjectId)) throw new Error(`子时间线选择器没有排除自身或缺少子工程：${JSON.stringify(nestedOptions)}`);
  await nestedSelector.selectOption(fixture.childEditProjectId);
  const addButton = page.getByTestId("add-nested-timeline");
  if (await addButton.isDisabled()) throw new Error("选择有效子工程后插入按钮仍不可用。 ");
  await addButton.click();

  const attached = await waitForProject(page, fixture.parentEditProjectId, (project) => project.revision === fixture.parentRevision + 1 && Boolean(findNestedClip(project)), "UI 插入嵌套时间线");
  const attachedClip = findNestedClip(attached);
  await page.getByTestId(`timeline-clip-${attachedClip.id}`).waitFor();
  await page.getByTestId("nested-timeline-inspector").waitFor();
  const referenceBeforeRefresh = structuredClone(attachedClip.nestedTimeline);
  if (referenceBeforeRefresh.childEditProjectId !== fixture.childEditProjectId || referenceBeforeRefresh.childEditProjectRevision !== fixture.childRevision || referenceBeforeRefresh.sourceStep.numerator !== 4 || referenceBeforeRefresh.sourceStep.denominator !== 5 || !/^[a-f0-9]{64}$/.test(referenceBeforeRefresh.childSnapshotSha256)) throw new Error(`UI 插入的冻结引用不正确：${JSON.stringify(referenceBeforeRefresh)}`);
  const previewBefore = await waitForNestedPreview(page);
  if (await page.getByTestId("nested-timeline-inspector").getByRole("alert").count()) throw new Error("初次嵌套预览出现解码或依赖错误。 ");

  await page.getByTitle("撤销剪辑").click();
  const undone = await waitForProject(page, fixture.parentEditProjectId, (project) => project.revision === attached.revision + 1 && !findNestedClip(project), "撤销嵌套插入");
  await page.getByTitle("重做剪辑").click();
  const redone = await waitForProject(page, fixture.parentEditProjectId, (project) => project.revision === undone.revision + 1 && findNestedClip(project)?.id === attachedClip.id, "重做嵌套插入");
  await page.getByTestId(`timeline-clip-${attachedClip.id}`).waitFor();
  const previewAfterRedo = await waitForNestedPreview(page);

  const pixelsPerSecond = Number(await page.locator(".timeline-scale input[type=range]").inputValue());
  const frameRate = redone.timebase.rateNumerator / redone.timebase.rateDenominator;
  const trimFrames = 6;
  await dispatchTrimEnd(page.getByTestId(`trim-end-${attachedClip.id}`), -(trimFrames * pixelsPerSecond / frameRate), 141);
  const trimmed = await waitForProject(page, fixture.parentEditProjectId, (project) => project.revision > redone.revision && findNestedClip(project)?.durationFrames === attachedClip.durationFrames - trimFrames, "嵌套时间线裁尾");
  const trimmedClip = findNestedClip(trimmed);
  if (JSON.stringify(trimmedClip.nestedTimeline.sourceOffset) !== JSON.stringify({ numerator: 0, denominator: 1 })) throw new Error(`裁尾错误移动了源 offset：${JSON.stringify(trimmedClip.nestedTimeline)}`);

  await projectSelector.selectOption("");
  await projectSelector.selectOption(fixture.parentEditProjectId);
  await page.getByTestId(`timeline-clip-${attachedClip.id}`).waitFor();
  const reloaded = await page.evaluate(async ({ root, projectId }) => window.canvasApi.getEditProject(root, projectId), { root, projectId: fixture.parentEditProjectId });
  if (reloaded.revision !== trimmed.revision || findNestedClip(reloaded)?.durationFrames !== trimmedClip.durationFrames) throw new Error("嵌套裁尾没有跨 UI 重载持久化。 ");

  const childUpdated = await page.evaluate(async ({ root, childEditProjectId, childClipId }) => {
    const child = await window.canvasApi.getEditProject(root, childEditProjectId);
    return window.canvasApi.applyEditOperation(root, child.id, child.revision, { type: "update_clip", clipId: childClipId, patch: { opacity: .82 } });
  }, { root, childEditProjectId: fixture.childEditProjectId, childClipId: fixture.childClipId });
  if (childUpdated.project.revision !== fixture.childRevision + 1) throw new Error(`子工程外部更新 revision 异常：${JSON.stringify(childUpdated)}`);

  const parentFile = path.join(root, ".aicanvas", "editor", "projects", `${fixture.parentEditProjectId}.json`);
  const parentHashBeforeDirtyRefresh = sha256Buffer(await readFile(parentFile));
  await page.getByTestId("visual-transform-opacity").fill("0.55");
  if (Number(await page.getByTestId("visual-transform-opacity").inputValue()) !== .55) throw new Error("未能建立未保存父工程草稿。 ");
  await page.getByTestId("refresh-nested-timeline").click();
  const dirtyToast = page.locator(".toast-message.error");
  await dirtyToast.waitFor({ state: "visible" });
  const dirtyMessage = await dirtyToast.textContent();
  if (!dirtyMessage?.includes("存在未保存改动")) throw new Error(`脏草稿刷新没有给出明确拒绝：${dirtyMessage}`);
  const persistedAfterDirtyReject = await page.evaluate(async ({ root, projectId }) => window.canvasApi.getEditProject(root, projectId), { root, projectId: fixture.parentEditProjectId });
  const parentHashAfterDirtyRefresh = sha256Buffer(await readFile(parentFile));
  const dirtyDraftOpacity = Number(await page.getByTestId("visual-transform-opacity").inputValue());
  if (persistedAfterDirtyReject.revision !== trimmed.revision || parentHashAfterDirtyRefresh !== parentHashBeforeDirtyRefresh || dirtyDraftOpacity !== .55) throw new Error("脏草稿刷新拒绝后仍覆盖了父工程、落盘文件或内存草稿。 ");

  await projectSelector.selectOption("");
  await projectSelector.selectOption(fixture.parentEditProjectId);
  await page.getByTestId(`timeline-clip-${attachedClip.id}`).waitFor();
  if (Number(await page.getByTestId("visual-transform-opacity").inputValue()) !== 1) throw new Error("重新载入没有恢复落盘父工程。 ");
  const driftAlert = page.getByTestId("nested-timeline-inspector").getByRole("alert");
  await driftAlert.waitFor({ state: "visible", timeout: 15_000 });
  const driftMessage = await driftAlert.textContent();
  if (!driftMessage?.includes("修订已漂移")) throw new Error(`子工程漂移没有以可见错误呈现：${driftMessage}`);

  await page.getByTestId("refresh-nested-timeline").click();
  const refreshed = await waitForProject(page, fixture.parentEditProjectId, (project) => project.revision === trimmed.revision + 1 && findNestedClip(project)?.nestedTimeline.childEditProjectRevision === childUpdated.project.revision, "干净父工程显式刷新");
  const refreshedClip = findNestedClip(refreshed);
  if (refreshedClip.nestedTimeline.childSnapshotSha256 === referenceBeforeRefresh.childSnapshotSha256 || refreshedClip.durationFrames !== trimmedClip.durationFrames) throw new Error(`显式刷新没有更新快照或破坏了父裁尾：${JSON.stringify(refreshedClip)}`);
  await seekToStart(page);
  const previewAfterRefresh = await waitForNestedPreview(page);
  if (await page.getByTestId("nested-timeline-inspector").getByRole("alert").count()) throw new Error("显式刷新后预览仍有错误。 ");

  const preparedPreview = await page.evaluate(async ({ root, parentId, revision, clipId }) => window.canvasApi.prepareNestedTimelinePreview(root, parentId, revision, clipId), { root, parentId: refreshed.id, revision: refreshed.revision, clipId: refreshedClip.id });
  const previewFile = await dataFileEvidence(preparedPreview.path);
  if (!preparedPreview.path.endsWith(".mp4") || previewFile.bytes < 1_000) throw new Error(`浏览器预览落盘证据无效：${JSON.stringify({ preparedPreview, previewFile })}`);
  const { stdout: probeStdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", preparedPreview.path]);
  const previewProbe = JSON.parse(probeStdout);
  if (!previewProbe.streams?.some((stream) => stream.codec_type === "video" && stream.codec_name === "h264")) throw new Error(`浏览器预览不是 H.264：${probeStdout}`);

  await page.getByTestId(`timeline-clip-${refreshedClip.id}`).click();
  await page.getByTestId("nested-timeline-inspector").scrollIntoViewIfNeeded();
  const screenshotCapture = await captureStableUi(page, screenshotPath);
  const screenshot = await imageEvidence(screenshotPath);
  if (screenshot.bytes < 20_000 || screenshot.width !== 1560 || screenshot.height !== 980) throw new Error(`永久截图尺寸或体积异常：${JSON.stringify(screenshot)}`);
  if (pageErrors.length) throw new Error(`Electron 嵌套时间线出现页面错误：${JSON.stringify(pageErrors)}`);

  await app.close();
  app = undefined;
  app = await electron.launch({ args: ["."], cwd: workspace, env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath, AI_CANVAS_WINDOW_WIDTH: "1560", AI_CANVAS_WINDOW_HEIGHT: "980" } });
  const restartPage = await app.firstWindow();
  const restartPageErrors = [];
  restartPage.on("pageerror", (error) => restartPageErrors.push(error.message));
  await restartPage.waitForLoadState("domcontentloaded");
  await restartPage.getByRole("button", { name: "导演剪辑台" }).click();
  await restartPage.getByRole("heading", { name: "导演剪辑台" }).waitFor();
  const restartSelector = restartPage.locator(".editor-actions select");
  if (await restartSelector.inputValue() !== fixture.parentEditProjectId) await restartSelector.selectOption(fixture.parentEditProjectId);
  await restartPage.getByTestId(`timeline-clip-${refreshedClip.id}`).waitFor();
  await seekToStart(restartPage);
  const previewAfterApplicationRestart = await waitForNestedPreview(restartPage);
  const projectAfterApplicationRestart = await restartPage.evaluate(async ({ root, projectId }) => window.canvasApi.getEditProject(root, projectId), { root, projectId: fixture.parentEditProjectId });
  const restartClip = findNestedClip(projectAfterApplicationRestart);
  if (projectAfterApplicationRestart.revision !== refreshed.revision || restartClip?.nestedTimeline.childSnapshotSha256 !== refreshedClip.nestedTimeline.childSnapshotSha256 || restartClip.durationFrames !== refreshedClip.durationFrames) throw new Error(`应用重启后冻结身份或裁尾漂移：${JSON.stringify({ projectAfterApplicationRestart, refreshedClip })}`);
  if (await restartPage.getByTestId("nested-timeline-inspector").getByRole("alert").count() || restartPageErrors.length) throw new Error(`应用重启后仍有预览或页面错误：${JSON.stringify({ restartPageErrors })}`);

  const sourceFiles = ["src/core/types.ts", "src/core/editor.ts", "src/core/command-outcome.ts", "src/core/command-bus.ts", "src/main/index.ts", "src/preload/index.ts", "src/renderer/src/components/VideoEditorView.vue", "scripts/create-editor-ui-fixture.ts", "scripts/ui-editor-nested-smoke.mjs"];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (relative) => [relative, sha256Buffer(await readFile(path.join(workspace, relative)))])));
  evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    transport: "electron-current-production-build",
    fixture: { kind: "isolated-real-h264", root, registryPath, ...fixture },
    selector: { options: nestedOptions, selfExcluded: !nestedOptions.some((option) => option.value === fixture.parentEditProjectId), childPresent: nestedOptions.some((option) => option.value === fixture.childEditProjectId) },
    revisions: { parentFixture: fixture.parentRevision, attached: attached.revision, undone: undone.revision, redone: redone.revision, trimmed: trimmed.revision, dirtyRejected: persistedAfterDirtyReject.revision, refreshed: refreshed.revision, childFixture: fixture.childRevision, childUpdated: childUpdated.project.revision },
    attached: { clipId: attachedClip.id, durationFrames: attachedClip.durationFrames, reference: referenceBeforeRefresh },
    preview: { initial: previewBefore, afterRedo: previewAfterRedo, afterRefresh: previewAfterRefresh, afterApplicationRestart: previewAfterApplicationRestart, prepared: preparedPreview, file: previewFile, probe: previewProbe },
    undoRedo: { undoRemoved: !findNestedClip(undone), redoRestoredSameId: findNestedClip(redone)?.id === attachedClip.id },
    trim: { framesRemoved: trimFrames, revisionDelta: trimmed.revision - redone.revision, beforeDurationFrames: attachedClip.durationFrames, afterDurationFrames: trimmedClip.durationFrames, sourceOffset: trimmedClip.nestedTimeline.sourceOffset, persistedAcrossReload: findNestedClip(reloaded)?.durationFrames === trimmedClip.durationFrames },
    dirtyRefresh: { message: dirtyMessage, draftOpacity: dirtyDraftOpacity, draftOpacityPreserved: dirtyDraftOpacity === .55, revisionBefore: trimmed.revision, revisionAfter: persistedAfterDirtyReject.revision, parentHashBefore: parentHashBeforeDirtyRefresh, parentHashAfter: parentHashAfterDirtyRefresh, noDiskWrite: parentHashBeforeDirtyRefresh === parentHashAfterDirtyRefresh },
    drift: { message: driftMessage, frozenRevisionBefore: referenceBeforeRefresh.childEditProjectRevision, childCurrentRevision: childUpdated.project.revision },
    refresh: { oldSnapshotSha256: referenceBeforeRefresh.childSnapshotSha256, newSnapshotSha256: refreshedClip.nestedTimeline.childSnapshotSha256, childRevision: refreshedClip.nestedTimeline.childEditProjectRevision, trimPreserved: refreshedClip.durationFrames === trimmedClip.durationFrames },
    applicationRestart: { projectRevision: projectAfterApplicationRestart.revision, childSnapshotSha256: restartClip.nestedTimeline.childSnapshotSha256, durationFrames: restartClip.durationFrames, preview: previewAfterApplicationRestart, pageErrors: restartPageErrors },
    screenshot: { ...screenshot, deviceScaleNormalized: true, captureAttempt: screenshotCapture.attempt, content: screenshotCapture.content },
    pageErrors: [...pageErrors, ...restartPageErrors],
    sourceHashes,
  };
} finally {
  if (app) await app.close();
  await rm(runtimeRoot, { recursive: true, force: true });
}

if (!evidence) throw new Error("Electron 嵌套时间线 smoke 未生成证据对象。 ");
const rootRemoved = await access(runtimeRoot).then(() => false, () => true);
const registryRemoved = await access(registryPath).then(() => false, () => true);
if (!rootRemoved || !registryRemoved) throw new Error(`隔离夹具未清理：${JSON.stringify({ rootRemoved, registryRemoved })}`);
evidence.terminal = { rootRemoved, registryRemoved };
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ evidencePath, revisions: evidence.revisions, preview: evidence.preview, dirtyRefresh: evidence.dirtyRefresh, refresh: evidence.refresh, screenshot: evidence.screenshot, terminal: evidence.terminal }, null, 2)}\n`);
