import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = path.resolve(process.argv[2] || path.join(workspace, "docs", "evidence", "editor-main-track-keyframe-ui-smoke-20260714.json"));
const evidenceDirectory = path.dirname(evidencePath);
const screenshotPath = path.join(evidenceDirectory, "editor-main-track-keyframe-ui-20260714.png");
const permanentOtioPath = path.join(evidenceDirectory, "editor-main-track-keyframe-split-20260714.otio");
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-editor-main-track-ui-"));
const root = path.join(runtimeRoot, "project");
const registryPath = path.join(runtimeRoot, "registry.json");
const fixtureScript = path.join(workspace, "scripts", "create-editor-ui-fixture.ts");
const tsxExecutable = path.join(workspace, "node_modules", ".bin", "tsx");
const frameSeconds = (frame) => frame * 1_001 / 24_000;
await mkdir(evidenceDirectory, { recursive: true });

let app;
let evidence;

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function fileEvidence(filePath, visual = false) {
  const buffer = await readFile(filePath);
  const result = { path: filePath, bytes: buffer.byteLength, sha256: sha256Buffer(buffer) };
  if (visual) {
    const metadata = await sharp(buffer).metadata();
    Object.assign(result, { width: metadata.width, height: metadata.height });
  }
  return result;
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
  throw new Error(`主画面 UI 永久截图连续三次内容覆盖不足：${JSON.stringify(content)}`);
}

function mainClips(project) {
  return project.tracks.filter((track) => track.kind === "visual").sort((left, right) => left.order - right.order)[0]?.clips.slice().sort((left, right) => left.startFrame - right.startFrame) ?? [];
}

async function getProject(page, fixture) {
  return page.evaluate(async ({ root, projectId }) => window.canvasApi.getEditProject(root, projectId), { root, projectId: fixture.editProjectId });
}

async function waitForProject(page, fixture, predicate, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await getProject(page, fixture);
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

async function selectClip(page, clipId) {
  const clip = page.getByTestId(`timeline-clip-${clipId}`);
  await clip.waitFor();
  await clip.evaluate((element) => element.click());
}

try {
  const fixtureResult = await execFileAsync(tsxExecutable, [fixtureScript, root, registryPath, "main-transform"], { cwd: workspace, env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath }, maxBuffer: 2 * 1024 * 1024 });
  const fixture = JSON.parse(fixtureResult.stdout);
  if (fixture.mode !== "main-transform" || fixture.mainClips !== 1 || !fixture.mainClipId || !fixture.mainEndKeyframeId) throw new Error(`主画面 UI 夹具不完整：${fixtureResult.stdout}`);

  app = await electron.launch({ args: ["."], cwd: workspace, env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath, AI_CANVAS_WINDOW_WIDTH: "1560", AI_CANVAS_WINDOW_HEIGHT: "980" } });
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "导演剪辑台" }).click();
  await page.getByRole("heading", { name: "导演剪辑台" }).waitFor();
  await selectClip(page, fixture.mainClipId);
  await page.getByTestId("visual-transform-inspector").waitFor();
  if ((await page.getByTestId("visual-transform-inspector").innerText()).trim() !== "主画面变换") throw new Error("主轨 inspector 仍显示为画中画变换。 ");
  if (await page.getByTestId("visual-transform-add-keyframe").count() !== 1) throw new Error("主轨没有显示添加关键帧按钮。 ");
  await page.getByTestId("preview-main-video").waitFor();

  await setPlayheadFrame(page, 0);
  const previewF0 = await page.getByTestId("preview-main-video").evaluate((element) => ({ transform: getComputedStyle(element).transform, opacity: getComputedStyle(element).opacity }));
  const previewBackground = await page.locator(".preview-frame").evaluate((element) => getComputedStyle(element).backgroundColor);
  await setPlayheadFrame(page, 18);
  const previewF18 = await page.getByTestId("preview-main-video").evaluate((element) => ({ transform: getComputedStyle(element).transform, opacity: getComputedStyle(element).opacity }));
  if (previewF0.transform === previewF18.transform || previewF0.opacity !== "0.72" || previewF18.opacity !== "0.72") throw new Error(`主画面预览没有逐帧 transform/opacity：${JSON.stringify({ previewF0, previewF18 })}`);
  if (previewBackground !== "rgb(24, 49, 79)") throw new Error(`预览没有使用工程背景色：${previewBackground}`);

  const baseline = await getProject(page, fixture);
  await page.getByTestId("visual-transform-scale").fill("5");
  await page.locator(".editor-actions button").filter({ hasText: "保存" }).click();
  await page.getByText(/缩放必须在 0\.02–4 之间/).waitFor();
  const afterInvalid = await getProject(page, fixture);
  if (afterInvalid.revision !== baseline.revision) throw new Error("非法主画面缩放错误推进了修订。 ");

  await page.getByTestId("visual-transform-x").fill("-30");
  await page.getByTestId("visual-transform-y").fill("20");
  await page.getByTestId("visual-transform-scale").fill("0.55");
  await page.getByTestId("visual-transform-rotation").fill("8");
  await page.getByTestId("visual-transform-opacity").fill("0.68");
  await setPlayheadFrame(page, 9);
  await page.getByTestId("visual-transform-add-keyframe").click();
  if (await page.locator(".keyframe-list article").count() !== 3) throw new Error("主画面播放头 F9 没有新增第三个关键帧。 ");
  await page.locator(".editor-actions button").filter({ hasText: "保存" }).click();
  const saved = await waitForProject(page, fixture, (project) => project.revision > baseline.revision && mainClips(project)[0]?.keyframes?.some((keyframe) => keyframe.frame === 9), "主画面 F9 保存");
  const savedClip = mainClips(saved)[0];
  const addedKeyframe = savedClip.keyframes.find((keyframe) => keyframe.frame === 9);
  if (!addedKeyframe || JSON.stringify({ x: addedKeyframe.positionX, y: addedKeyframe.positionY, scale: addedKeyframe.scale, rotation: addedKeyframe.rotation }) !== JSON.stringify({ x: -30, y: 20, scale: .55, rotation: 8 }) || savedClip.opacity !== .68) throw new Error(`主画面 F9/opacity 未持久化：${JSON.stringify(savedClip)}`);

  const selector = page.locator(".editor-actions select");
  await selector.selectOption("");
  await selector.selectOption(saved.id);
  await selectClip(page, fixture.mainClipId);
  await page.getByTestId(`keyframe-row-${addedKeyframe.id}`).waitFor();
  if (Number(await page.getByTestId("visual-transform-opacity").inputValue()) !== .68) throw new Error("工程重载没有恢复主画面 opacity。 ");

  await page.getByTitle("撤销剪辑").click();
  const undone = await waitForProject(page, fixture, (project) => project.revision > saved.revision && !mainClips(project)[0]?.keyframes?.some((keyframe) => keyframe.frame === 9), "撤销主画面 F9");
  await page.getByTitle("重做剪辑").click();
  const redone = await waitForProject(page, fixture, (project) => project.revision > undone.revision && mainClips(project)[0]?.keyframes?.some((keyframe) => keyframe.frame === 9), "重做主画面 F9");
  if (mainClips(redone)[0]?.opacity !== .68) throw new Error("重做没有恢复主画面 opacity。 ");

  await selectClip(page, fixture.mainClipId);
  await setPlayheadFrame(page, 13);
  const splitButton = page.getByRole("button", { name: "分割" });
  if (await splitButton.isDisabled()) throw new Error("主画面 F13 分割按钮不可用。 ");
  await splitButton.click();
  const split = await waitForProject(page, fixture, (project) => project.revision > redone.revision && mainClips(project).length === 2, "主画面 F13 分割");
  const splitClips = mainClips(split);
  if (splitClips[0].startFrame !== 0 || splitClips[0].durationFrames !== 13 || splitClips[1].startFrame !== 13 || splitClips[1].durationFrames !== 23) throw new Error(`主画面 F13 分割帧边界错误：${JSON.stringify(splitClips)}`);
  if (!splitClips.some((clip) => clip.keyframes?.some((keyframe) => keyframe.bezier?.mode === "derived_monotone"))) throw new Error("主画面 F13 分割没有生成派生曲线。 ");

  await page.getByTitle("撤销剪辑").click();
  const splitUndone = await waitForProject(page, fixture, (project) => project.revision > split.revision && mainClips(project).length === 1, "撤销主画面 split");
  await page.getByTitle("重做剪辑").click();
  const splitRedone = await waitForProject(page, fixture, (project) => project.revision > splitUndone.revision && mainClips(project).length === 2, "重做主画面 split");
  const redoneRight = mainClips(splitRedone)[1];
  if (redoneRight.id !== splitClips[1].id) throw new Error("重做主画面 split 没有恢复右片段 ID。 ");

  const otioPath = path.join(root, "main-track-ui-split.otio");
  const otioResult = await page.evaluate(async ({ root, projectId, revision, outputPath }) => window.canvasApi.exportEditOtio(root, projectId, revision, outputPath), { root, projectId: fixture.editProjectId, revision: splitRedone.revision, outputPath: otioPath });
  const otio = JSON.parse(await readFile(otioResult.path, "utf8"));
  if (otio.metadata?.aicanvas?.keyframeCurveContract !== "aicanvas.cubic-bezier.v2") throw new Error("主画面 Electron split OTIO 不是 v2。 ");
  await copyFile(otioResult.path, permanentOtioPath);

  await selectClip(page, redoneRight.id);
  const derived = redoneRight.keyframes.find((keyframe) => keyframe.bezier?.mode === "derived_monotone");
  if (!derived) throw new Error("重做后的主画面右片段缺少派生目标关键帧。 ");
  await page.getByTestId(`keyframe-row-${derived.id}`).scrollIntoViewIfNeeded();
  if ((await page.getByTestId("visual-transform-inspector").innerText()).trim() !== "主画面变换") throw new Error("分段后的主轨 inspector 丢失主画面语义。 ");
  const screenshotCapture = await captureStableUi(page, screenshotPath);
  const screenshot = await fileEvidence(screenshotPath, true);
  if (screenshot.bytes < 20_000 || screenshot.width !== 1560 || screenshot.height !== 980) throw new Error(`主画面 UI 截图尺寸或体积异常：${JSON.stringify(screenshot)}`);
  if (pageErrors.length) throw new Error(`主画面 UI 存在页面错误：${JSON.stringify(pageErrors)}`);

  const sourceFiles = ["src/core/editor.ts", "src/core/keyframe-curve.ts", "src/renderer/src/components/VideoEditorView.vue", "scripts/create-editor-ui-fixture.ts", "scripts/ui-editor-main-track-smoke.mjs", "package.json"];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (relative) => [relative, sha256Buffer(await readFile(path.join(workspace, relative)))])));
  evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    transport: "source-electron-current-build",
    fixture: { kind: "isolated-synthetic", root, registryPath, editProjectId: fixture.editProjectId, mainClipId: fixture.mainClipId, frameRate: 24_000 / 1_001, backgroundColor: "#18314f" },
    preview: { frame0: previewF0, frame18: previewF18, changedByKeyframes: previewF0.transform !== previewF18.transform, opacityApplied: previewF0.opacity === "0.72" && previewF18.opacity === "0.72", projectBackground: previewBackground },
    inspector: { title: "主画面变换", fields: ["positionX", "positionY", "scale", "rotation", "opacity"], addKeyframeVisible: true },
    validation: { invalidScale: 5, revisionBefore: baseline.revision, revisionAfter: afterInvalid.revision, rejectedWithoutRevision: baseline.revision === afterInvalid.revision },
    persistence: { addedKeyframe, opacity: savedClip.opacity, reloaded: true, revisions: { fixture: baseline.revision, saved: saved.revision, undo: undone.revision, redo: redone.revision } },
    split: { frame: 13, clips: splitClips.map((clip) => ({ id: clip.id, startFrame: clip.startFrame, durationFrames: clip.durationFrames, keyframes: clip.keyframes })), undoRevision: splitUndone.revision, redoRevision: splitRedone.revision, rightClipIdStable: redoneRight.id === splitClips[1].id },
    otio: { ...await fileEvidence(permanentOtioPath), contract: otio.metadata.aicanvas.keyframeCurveContract },
    screenshot: { ...screenshot, deviceScaleNormalized: true, captureAttempt: screenshotCapture.attempt, content: screenshotCapture.content },
    pageErrors,
    sourceHashes,
  };
} finally {
  if (app) await app.close();
  await rm(runtimeRoot, { recursive: true, force: true });
}

if (!evidence) throw new Error("主画面 Electron smoke 未生成证据对象。 ");
const rootRemoved = await access(runtimeRoot).then(() => false, () => true);
const registryRemoved = await access(registryPath).then(() => false, () => true);
if (!rootRemoved || !registryRemoved) throw new Error(`主画面 UI 隔离夹具未清理：${JSON.stringify({ rootRemoved, registryRemoved })}`);
evidence.terminal = { rootRemoved, registryRemoved };
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ evidencePath, preview: evidence.preview, validation: evidence.validation, persistence: evidence.persistence, split: { frame: evidence.split.frame, clips: evidence.split.clips.map((clip) => ({ id: clip.id, startFrame: clip.startFrame, durationFrames: clip.durationFrames })), undoRevision: evidence.split.undoRevision, redoRevision: evidence.split.redoRevision }, screenshot: evidence.screenshot, terminal: evidence.terminal }, null, 2)}\n`);
