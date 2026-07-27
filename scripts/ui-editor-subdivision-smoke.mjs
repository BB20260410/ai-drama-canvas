import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = path.resolve(process.argv[2] || path.join(workspace, "docs", "evidence", "editor-subdivision-ui-smoke-20260714.json"));
const evidenceDirectory = path.dirname(evidencePath);
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-editor-subdivision-ui-"));
const root = path.join(runtimeRoot, "project");
const registryPath = path.join(runtimeRoot, "registry.json");
const screenshotPath = path.join(evidenceDirectory, "editor-subdivision-ui-20260714.png");
const fixtureScript = path.join(workspace, "scripts", "create-editor-ui-fixture.ts");
const tsxExecutable = path.join(workspace, "node_modules", ".bin", "tsx");
const frameSeconds = (frame) => frame * 1_001 / 24_000;
const sourceTransform = {
  start: { positionX: -120, positionY: -80, scale: .3, rotation: -6 },
  end: { positionX: 120, positionY: 80, scale: .5, rotation: 6 },
};

await mkdir(evidenceDirectory, { recursive: true });
let app;
let evidence;

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function fileEvidence(filePath) {
  const buffer = await readFile(filePath);
  const metadata = await sharp(buffer).metadata();
  return { path: filePath, bytes: buffer.byteLength, sha256: sha256Buffer(buffer), width: metadata.width, height: metadata.height };
}

async function dataFileEvidence(filePath) {
  const buffer = await readFile(filePath);
  return { path: filePath, bytes: buffer.byteLength, sha256: sha256Buffer(buffer) };
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

function overlayClips(project) {
  return project.tracks.find((track) => track.id === "track-ui-subdivision-overlay")?.clips.slice().sort((left, right) => left.startFrame - right.startFrame) ?? [];
}

function derivedAuthority(keyframe, expectedWindow, label) {
  const window = keyframe?.bezier?.sourceWindow;
  if (keyframe?.bezier?.mode !== "derived_monotone" || window?.sourceEasing !== "cubic_bezier") throw new Error(`${label} 缺少派生原曲线权威。`);
  for (const [key, value] of Object.entries(expectedWindow)) if (window[key] !== value) throw new Error(`${label} sourceWindow.${key}=${window[key]}，预期 ${value}。`);
  if (JSON.stringify(keyframe.sourceTransform) !== JSON.stringify(sourceTransform)) throw new Error(`${label} sourceTransform 未保留原段锚点：${JSON.stringify(keyframe.sourceTransform)}`);
}

async function waitForProject(page, projectId, predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await page.evaluate(async ({ root, projectId }) => window.canvasApi.getEditProject(root, projectId), { root, projectId });
    if (predicate(latest)) return latest;
    await page.waitForTimeout(80);
  }
  throw new Error(`${label} 超时：${JSON.stringify(latest)}`);
}

async function setPlayheadFrame(page, frame) {
  await page.locator(".transport input[type=range]").evaluate((element, value) => {
    element.value = String(value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, frameSeconds(frame));
  await page.locator(".transport span").filter({ hasText: `F${frame}` }).waitFor();
}

async function selectTimelineClip(page, clipId) {
  const locator = page.getByTestId(`timeline-clip-${clipId}`);
  await locator.waitFor();
  await locator.evaluate((element) => element.click());
}

async function dispatchGesture(handle, deltaPixels, pointerId, terminalEvent) {
  const box = await handle.boundingBox();
  if (!box) throw new Error("裁切手柄不可见。");
  const startX = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await handle.evaluate((element, { startX, y, pointerId }) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId, pointerType: "mouse", button: 0, buttons: 1, clientX: startX, clientY: y }));
  }, { startX, y, pointerId });
  await handle.page().evaluate(({ x, y, pointerId }) => {
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId, pointerType: "mouse", button: 0, buttons: 1, clientX: x, clientY: y }));
  }, { x: startX + deltaPixels, y, pointerId });
  await handle.page().waitForTimeout(60);
  await handle.evaluate((element, { type, x, y, pointerId }) => {
    element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, pointerType: "mouse", button: 0, buttons: 0, clientX: x, clientY: y }));
  }, { type: terminalEvent, x: startX + deltaPixels, y, pointerId });
}

try {
  const fixtureResult = await execFileAsync(tsxExecutable, [fixtureScript, root, registryPath, "subdivision"], { cwd: workspace, env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath }, maxBuffer: 2 * 1024 * 1024 });
  const fixture = JSON.parse(fixtureResult.stdout);
  if (fixture.overlayStartFrame !== 6 || fixture.overlayDurationFrames !== 36) throw new Error(`隔离夹具帧边界不正确：${fixtureResult.stdout}`);

  app = await electron.launch({ args: ["."], cwd: workspace, env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath, AI_CANVAS_WINDOW_WIDTH: "1560", AI_CANVAS_WINDOW_HEIGHT: "980" } });
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "导演剪辑台" }).click();
  await page.getByRole("heading", { name: "导演剪辑台" }).waitFor();
  await page.getByTestId(`timeline-clip-${fixture.overlayClipId}`).waitFor();

  const beforeSave = await page.evaluate(async ({ root, projectId }) => window.canvasApi.getEditProject(root, projectId), { root, projectId: fixture.editProjectId });
  await page.locator(".editor-actions button").filter({ hasText: "保存" }).click();
  const baseline = await waitForProject(page, fixture.editProjectId, (project) => project.revision === beforeSave.revision + 1, "显式基线保存");
  const baselineRevision = baseline.revision;

  await selectTimelineClip(page, fixture.overlayClipId);
  await setPlayheadFrame(page, 13);
  const splitButton = page.getByRole("button", { name: "分割" });
  if (await splitButton.isDisabled()) throw new Error("覆盖层 F13 任意分割按钮不可用。");
  await splitButton.click();
  const afterSplit = await waitForProject(page, fixture.editProjectId, (project) => project.revision === baselineRevision + 1 && overlayClips(project).length === 2, "F13 任意分割");
  const splitClips = overlayClips(afterSplit);
  const left = splitClips[0];
  const right = splitClips[1];
  if (left.id !== fixture.overlayClipId || left.startFrame !== 6 || left.durationFrames !== 7 || right.startFrame !== 13 || right.durationFrames !== 29) throw new Error(`split 帧边界错误：${JSON.stringify(splitClips)}`);
  derivedAuthority(left.keyframes.at(-1), { startFrame: 0, endFrame: 7, totalFrames: 36 }, "split 左段");
  derivedAuthority(right.keyframes[0], { startFrame: 7, endFrame: 36, totalFrames: 36 }, "split 右段");

  const splitOtioPath = path.join(root, "subdivision-split.otio");
  const splitOtioResult = await page.evaluate(async ({ root, projectId, revision, outputPath }) => window.canvasApi.exportEditOtio(root, projectId, revision, outputPath), { root, projectId: fixture.editProjectId, revision: afterSplit.revision, outputPath: splitOtioPath });
  const splitOtio = JSON.parse(await readFile(splitOtioResult.path, "utf8"));
  if (splitOtio.metadata?.aicanvas?.keyframeCurveContract !== "aicanvas.cubic-bezier.v2") throw new Error("Electron preload 导出的 split OTIO 不是 v2。 ");
  const permanentSplitOtioPath = path.join(evidenceDirectory, "editor-subdivision-split-20260714.otio");
  await copyFile(splitOtioResult.path, permanentSplitOtioPath);
  const afterSplitExport = await page.evaluate(async ({ root, projectId }) => window.canvasApi.getEditProject(root, projectId), { root, projectId: fixture.editProjectId });
  if (afterSplitExport.revision !== afterSplit.revision) throw new Error("只读 OTIO 导出错误推进了工程修订。");

  await page.getByTitle("撤销剪辑").click();
  const afterUndo = await waitForProject(page, fixture.editProjectId, (project) => project.revision === afterSplit.revision + 1 && overlayClips(project).length === 1, "撤销 split");
  await page.getByTitle("重做剪辑").click();
  const afterRedo = await waitForProject(page, fixture.editProjectId, (project) => project.revision === afterUndo.revision + 1 && overlayClips(project).length === 2, "重做 split");
  const redoRight = overlayClips(afterRedo).find((clip) => clip.id === right.id);
  if (!redoRight) throw new Error("重做后右侧片段 ID 未恢复。");

  await selectTimelineClip(page, right.id);
  const derivedKeyframeId = redoRight.keyframes[0].id;
  const row = page.getByTestId(`keyframe-row-${derivedKeyframeId}`);
  await row.waitFor();
  const derivedSelect = row.getByRole("combobox", { name: /缓动曲线/ });
  const derivedInputs = row.locator(".bezier-fields input");
  const controlPoints = [redoRight.keyframes[0].bezier.x1, redoRight.keyframes[0].bezier.y1, redoRight.keyframes[0].bezier.x2, redoRight.keyframes[0].bezier.y2];
  const derivedSelectDisabled = await derivedSelect.isDisabled();
  const derivedInputsDisabled = await derivedInputs.first().isDisabled();
  if (!derivedSelectDisabled || await derivedInputs.count() !== 4 || !derivedInputsDisabled) throw new Error("派生曲线 UI 仍允许修改。");
  if (!controlPoints.some((value) => value < 0 || value > 1)) throw new Error(`UI 夹具没有覆盖框外派生控制点：${controlPoints}`);
  const editableHandles = await row.locator(".bezier-handle,.bezier-control").count();
  if (editableHandles) throw new Error("派生 UI 错误显示可编辑控制柄。");
  const derivedPath = await row.locator(".bezier-curve").getAttribute("d");
  const explanationVisible = await row.getByText(/原曲线帧窗口为求值事实/).isVisible();
  if (!derivedPath || !explanationVisible) throw new Error("派生曲线图或只读语义说明缺失。");

  const projectFile = path.join(root, ".aicanvas", "editor", "projects", `${fixture.editProjectId}.json`);
  const projectHashBeforeCancel = sha256Buffer(await readFile(projectFile));
  const rightClipLocator = page.getByTestId(`timeline-clip-${right.id}`);
  const styleBeforeCancel = await rightClipLocator.getAttribute("style");
  const geometryBeforeCancel = await rightClipLocator.evaluate((element) => { const box = element.getBoundingClientRect(); return { left: box.left, width: box.width }; });
  const cancelHandle = page.getByTestId(`trim-start-${right.id}`);
  const cancelBox = await cancelHandle.boundingBox();
  if (!cancelBox) throw new Error("pointercancel 测试手柄不可见。");
  const cancelStartX = cancelBox.x + cancelBox.width / 2;
  const cancelY = cancelBox.y + cancelBox.height / 2;
  await page.evaluate(() => {
    window.__aiCanvasPointerProbe = [];
    for (const type of ["pointerdown", "pointermove", "pointercancel"]) {
      window.addEventListener(type, (event) => window.__aiCanvasPointerProbe.push({ phase: "capture", type, pointerId: event.pointerId, bubbles: event.bubbles, target: event.target?.getAttribute?.("data-testid") ?? event.target?.tagName }), { capture: true });
      window.addEventListener(type, (event) => window.__aiCanvasPointerProbe.push({ phase: "bubble", type, pointerId: event.pointerId, bubbles: event.bubbles, target: event.target?.getAttribute?.("data-testid") ?? event.target?.tagName }));
    }
  });
  await cancelHandle.evaluate((element, args) => element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: args.pointerId, pointerType: "mouse", button: 0, buttons: 1, clientX: args.x, clientY: args.y })), { pointerId: 91, x: cancelStartX, y: cancelY });
  await page.evaluate((args) => window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: args.pointerId, pointerType: "mouse", button: 0, buttons: 1, clientX: args.x, clientY: args.y })), { pointerId: 91, x: cancelStartX + 20, y: cancelY });
  await page.waitForTimeout(60);
  const styleDuringCancel = await rightClipLocator.getAttribute("style");
  const geometryDuringCancel = await rightClipLocator.evaluate((element) => { const box = element.getBoundingClientRect(); return { left: box.left, width: box.width }; });
  if (styleDuringCancel === styleBeforeCancel) throw new Error("pointermove 没有产生裁切预览，无法证明 cancel 恢复。");
  await cancelHandle.evaluate((element, args) => element.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, cancelable: true, pointerId: args.pointerId, pointerType: "mouse", button: 0, buttons: 0, clientX: args.x, clientY: args.y })), { pointerId: 91, x: cancelStartX + 20, y: cancelY });
  await page.waitForTimeout(120);
  const styleAfterCancel = await rightClipLocator.getAttribute("style");
  const pointerProbe = await page.evaluate(() => window.__aiCanvasPointerProbe);
  const geometryAfterCancel = await rightClipLocator.evaluate((element) => { const box = element.getBoundingClientRect(); return { left: box.left, width: box.width }; });
  const geometryRestored = Math.abs(geometryAfterCancel.left - geometryBeforeCancel.left) < .01 && Math.abs(geometryAfterCancel.width - geometryBeforeCancel.width) < .01;
  if (!geometryRestored) throw new Error(`pointercancel 没有恢复时间线几何：${JSON.stringify({ geometryBeforeCancel, geometryDuringCancel, geometryAfterCancel, styleBeforeCancel, styleDuringCancel, styleAfterCancel, pointerProbe, pageErrors })}`);
  const projectHashAfterCancel = sha256Buffer(await readFile(projectFile));
  const afterCancel = await page.evaluate(async ({ root, projectId }) => window.canvasApi.getEditProject(root, projectId), { root, projectId: fixture.editProjectId });
  if (projectHashAfterCancel !== projectHashBeforeCancel || afterCancel.revision !== afterRedo.revision) throw new Error("pointercancel 错误地修改了落盘工程或修订。");
  if (pageErrors.length) throw new Error(`pointercancel 后仍有页面错误：${JSON.stringify(pageErrors)}`);

  const pixelsPerSecond = Number(await page.locator(".timeline-scale input[type=range]").inputValue());
  const sixFramePixels = 6 * pixelsPerSecond * 1_001 / 24_000;
  await dispatchGesture(page.getByTestId(`trim-start-${right.id}`), sixFramePixels, 92, "pointerup");
  const afterTrimStart = await waitForProject(page, fixture.editProjectId, (project) => {
    const clip = overlayClips(project).find((entry) => entry.id === right.id);
    return project.revision > afterRedo.revision && clip?.startFrame === 19 && clip?.durationFrames === 23;
  }, "关键帧裁头");
  const trimmedStart = overlayClips(afterTrimStart).find((clip) => clip.id === right.id);
  if (!trimmedStart || trimmedStart.startFrame !== 19 || trimmedStart.durationFrames !== 23) throw new Error(`裁头 6 帧结果错误：${JSON.stringify(trimmedStart)}`);
  derivedAuthority(trimmedStart.keyframes[0], { startFrame: 13, endFrame: 36, totalFrames: 36 }, "重复裁头");

  await selectTimelineClip(page, right.id);
  await dispatchGesture(page.getByTestId(`trim-end-${right.id}`), -sixFramePixels, 93, "pointerup");
  const afterTrimEnd = await waitForProject(page, fixture.editProjectId, (project) => {
    const clip = overlayClips(project).find((entry) => entry.id === right.id);
    return project.revision > afterTrimStart.revision && clip?.startFrame === 19 && clip?.durationFrames === 17;
  }, "关键帧裁尾");
  const trimmedEnd = overlayClips(afterTrimEnd).find((clip) => clip.id === right.id);
  if (!trimmedEnd || trimmedEnd.startFrame !== 19 || trimmedEnd.durationFrames !== 17) throw new Error(`裁尾 6 帧结果错误：${JSON.stringify(trimmedEnd)}`);
  derivedAuthority(trimmedEnd.keyframes.at(-1), { startFrame: 13, endFrame: 30, totalFrames: 36 }, "重复裁尾");

  const finalOtioPath = path.join(root, "subdivision-final.otio");
  const finalOtioResult = await page.evaluate(async ({ root, projectId, revision, outputPath }) => window.canvasApi.exportEditOtio(root, projectId, revision, outputPath), { root, projectId: fixture.editProjectId, revision: afterTrimEnd.revision, outputPath: finalOtioPath });
  const finalOtio = JSON.parse(await readFile(finalOtioResult.path, "utf8"));
  if (finalOtio.metadata?.aicanvas?.keyframeCurveContract !== "aicanvas.cubic-bezier.v2" || !JSON.stringify(finalOtio).includes('"startFrame":13') || !JSON.stringify(finalOtio).includes('"endFrame":30')) throw new Error("重复 trim 后的 OTIO v2 没有保真 source window。");
  const permanentFinalOtioPath = path.join(evidenceDirectory, "editor-subdivision-final-20260714.otio");
  await copyFile(finalOtioResult.path, permanentFinalOtioPath);

  await selectTimelineClip(page, right.id);
  const finalKeyframeId = trimmedEnd.keyframes.at(-1).id;
  await page.getByTestId(`keyframe-row-${finalKeyframeId}`).scrollIntoViewIfNeeded();
  const screenshotCapture = await captureStableUi(page, screenshotPath);
  const screenshot = await fileEvidence(screenshotPath);
  if (screenshot.bytes < 20_000 || screenshot.width !== 1560 || screenshot.height !== 980) throw new Error(`永久截图尺寸或体积异常：${JSON.stringify(screenshot)}`);

  const sourceFiles = ["src/core/types.ts", "src/core/keyframe-curve.ts", "src/core/editor.ts", "src/mcp/server.ts", "src/renderer/src/components/VideoEditorView.vue", "scripts/create-editor-ui-fixture.ts", "scripts/ui-editor-subdivision-smoke.mjs"];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (relative) => [relative, sha256Buffer(await readFile(path.join(workspace, relative)))])));
  evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    transport: "source-electron-current-build",
    fixture: { kind: "isolated-synthetic", root, registryPath, editProjectId: fixture.editProjectId, overlayClipId: fixture.overlayClipId, startFrame: 6, durationFrames: 36, curve: { x1: 1, y1: 0, x2: 0, y2: 1 } },
    revisions: { fixture: fixture.revision, baseline: baselineRevision, split: afterSplit.revision, undo: afterUndo.revision, redo: afterRedo.revision, pointercancel: afterCancel.revision, trimStart: afterTrimStart.revision, trimStartDelta: afterTrimStart.revision - afterRedo.revision, trimEnd: afterTrimEnd.revision, trimEndDelta: afterTrimEnd.revision - afterTrimStart.revision },
    split: { left: { id: left.id, startFrame: left.startFrame, durationFrames: left.durationFrames, keyframe: left.keyframes.at(-1) }, right: { id: right.id, startFrame: right.startFrame, durationFrames: right.durationFrames, keyframe: right.keyframes[0] } },
    otio: { split: { ...await dataFileEvidence(permanentSplitOtioPath), contract: splitOtio.metadata.aicanvas.keyframeCurveContract, revisionUnchanged: afterSplitExport.revision === afterSplit.revision }, final: { ...await dataFileEvidence(permanentFinalOtioPath), contract: finalOtio.metadata.aicanvas.keyframeCurveContract, sourceWindow: trimmedEnd.keyframes.at(-1).bezier.sourceWindow } },
    undoRedo: { undoRestoredSingleClip: overlayClips(afterUndo).length === 1, redoRestoredSplit: overlayClips(afterRedo).length === 2, rightClipIdStable: Boolean(redoRight) },
    derivedUi: { keyframeId: derivedKeyframeId, selectDisabled: derivedSelectDisabled, inputsDisabled: derivedInputsDisabled, controlPoints, outsideUnitRangePreserved: controlPoints.some((value) => value < 0 || value > 1), editableHandles, curvePath: derivedPath, explanationVisible },
    pointercancel: { revisionBefore: afterRedo.revision, revisionAfter: afterCancel.revision, projectHashBefore: projectHashBeforeCancel, projectHashAfter: projectHashAfterCancel, styleBefore: styleBeforeCancel, styleDuring: styleDuringCancel, styleAfter: styleAfterCancel, geometryBefore: geometryBeforeCancel, geometryDuring: geometryDuringCancel, geometryAfter: geometryAfterCancel, restored: geometryRestored, eventPath: pointerProbe.filter((entry) => entry.pointerId === 91), pageErrors },
    trims: { start: { startFrame: trimmedStart.startFrame, durationFrames: trimmedStart.durationFrames, sourceWindow: trimmedStart.keyframes[0].bezier.sourceWindow, sourceTransform: trimmedStart.keyframes[0].sourceTransform }, end: { startFrame: trimmedEnd.startFrame, durationFrames: trimmedEnd.durationFrames, sourceWindow: trimmedEnd.keyframes.at(-1).bezier.sourceWindow, sourceTransform: trimmedEnd.keyframes.at(-1).sourceTransform } },
    screenshot: { ...screenshot, deviceScaleNormalized: true, captureAttempt: screenshotCapture.attempt, content: screenshotCapture.content },
    sourceHashes,
  };
} finally {
  if (app) await app.close();
  await rm(runtimeRoot, { recursive: true, force: true });
}

if (!evidence) throw new Error("Electron 分段 smoke 未生成证据对象。");
const rootRemoved = await access(runtimeRoot).then(() => false, () => true);
const registryRemoved = await access(registryPath).then(() => false, () => true);
if (!rootRemoved || !registryRemoved) throw new Error(`隔离夹具未清理：${JSON.stringify({ rootRemoved, registryRemoved })}`);
evidence.terminal = { rootRemoved, registryRemoved };
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ evidencePath, revisions: evidence.revisions, split: evidence.split, pointercancel: evidence.pointercancel, trims: evidence.trims, screenshot: evidence.screenshot, terminal: evidence.terminal }, null, 2)}\n`);
