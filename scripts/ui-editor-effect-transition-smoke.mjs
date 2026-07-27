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
const evidencePath = path.resolve(process.argv[2] || path.join(workspace, "docs", "evidence", "editor-effect-transition-ui-smoke-20260714.json"));
const evidenceDirectory = path.dirname(evidencePath);
const packagedExecutable = process.env.AI_CANVAS_ELECTRON_EXECUTABLE?.trim();
const screenshotPath = process.env.AI_CANVAS_UI_SCREENSHOT_PATH?.trim()
  ? path.resolve(process.env.AI_CANVAS_UI_SCREENSHOT_PATH)
  : path.join(evidenceDirectory, packagedExecutable ? "editor-effect-transition-packaged-ui-20260714.png" : "editor-effect-transition-ui-20260714.png");
const fixtureScript = path.join(workspace, "scripts", "create-effect-transition-ui-fixture.ts");
const tsxExecutable = path.join(workspace, "node_modules", ".bin", "tsx");
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-editor-effect-transition-ui-"));
const root = path.join(runtimeRoot, "project");
const userDataPath = path.join(root, "electron-user-data");
const registryPath = path.join(runtimeRoot, "registry.json");
await mkdir(evidenceDirectory, { recursive: true });
let app;
let evidence;

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
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
  return { pixels, brightRatio: brightPixels / pixels, chromaticRatio: chromaticPixels / pixels };
}

async function captureStableUi(page) {
  let content;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.bringToFront();
    await page.waitForTimeout(700);
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const raw = await page.screenshot({ type: "png", animations: "disabled" });
    await sharp(raw).resize(viewport.width, viewport.height, { fit: "fill" }).png().toFile(screenshotPath);
    content = await screenshotContent(screenshotPath);
    if (content.brightRatio >= .01 && content.chromaticRatio >= .005) return { attempt, content };
  }
  throw new Error(`永久截图连续三次内容覆盖不足：${JSON.stringify(content)}`);
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

async function openEditor(page, projectId) {
  await page.waitForLoadState("domcontentloaded");
  const firstRun = page.getByTestId("first-run-screen");
  if (await firstRun.isVisible().catch(() => false)) {
    await page.getByTestId("first-run-recent").click();
  }
  await page.getByRole("button", { name: "导演剪辑台" }).click();
  await page.getByRole("heading", { name: "导演剪辑台" }).waitFor();
  const selector = page.locator(".editor-actions select");
  if (await selector.inputValue() !== projectId) await selector.selectOption(projectId);
}

async function seekFrame(page, frame) {
  await page.locator(".transport input[type=range]").evaluate((element, seconds) => {
    element.value = String(seconds);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, frame / 24);
  await page.waitForFunction((expected) => document.querySelector(".transport span")?.textContent?.includes(`F${expected}`), frame);
}

async function waitForDualPreview(page) {
  const outgoing = page.getByTestId("preview-main-video");
  const incoming = page.getByTestId("preview-transition-incoming");
  await Promise.all([outgoing.waitFor({ state: "visible" }), incoming.waitFor({ state: "visible" })]);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="preview-main-video"],[data-testid="preview-transition-incoming"]')].every((element) => element instanceof HTMLVideoElement && element.readyState >= 1 && element.videoWidth > 0 && !element.error), undefined, { timeout: 20_000 });
  return page.evaluate(() => {
    const outgoingElement = document.querySelector('[data-testid="preview-main-video"]');
    const incomingElement = document.querySelector('[data-testid="preview-transition-incoming"]');
    if (!(outgoingElement instanceof HTMLVideoElement) || !(incomingElement instanceof HTMLVideoElement)) throw new Error("双流预览元素缺失。");
    return {
      outgoing: { currentTime: outgoingElement.currentTime, opacity: Number(outgoingElement.style.opacity), muted: outgoingElement.muted, readyState: outgoingElement.readyState, source: outgoingElement.currentSrc },
      incoming: { currentTime: incomingElement.currentTime, opacity: Number(incomingElement.style.opacity), muted: incomingElement.muted, readyState: incomingElement.readyState, source: incomingElement.currentSrc },
    };
  });
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
      AI_CANVAS_WINDOW_WIDTH: "1560",
      AI_CANVAS_WINDOW_HEIGHT: "980",
    },
  });
}

try {
  const fixtureResult = await execFileAsync(tsxExecutable, [fixtureScript, root, registryPath], { cwd: workspace, env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath }, maxBuffer: 2 * 1024 * 1024 });
  const fixture = JSON.parse(fixtureResult.stdout);
  if (!fixture.editProjectId || fixture.inOffsetFrames !== 3 || fixture.outOffsetFrames !== 5) throw new Error(`Effect/Transition UI fixture 无效：${fixtureResult.stdout}`);

  app = await launchApplication();
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openEditor(page, fixture.editProjectId);
  await page.getByTestId(`timeline-clip-${fixture.outgoingClipId}`).click();
  await page.getByTestId("edit-dissolve-fields").waitFor();
  const initialInspector = {
    transition: await page.getByTestId("edit-transition-select").inputValue(),
    inOffsetFrames: Number(await page.getByTestId("edit-transition-in-offset").inputValue()),
    outOffsetFrames: Number(await page.getByTestId("edit-transition-out-offset").inputValue()),
    playbackDisabled: await page.getByTestId("edit-playback-rate").isDisabled(),
    keyframeDisabled: await page.getByTestId("visual-transform-add-keyframe").isDisabled(),
  };
  if (initialInspector.transition !== "smpte_dissolve" || initialInspector.inOffsetFrames !== 3 || initialInspector.outOffsetFrames !== 5 || !initialInspector.playbackDisabled || !initialInspector.keyframeDisabled) throw new Error(`标准转场 Inspector 初态错误：${JSON.stringify(initialInspector)}`);

  await seekFrame(page, 24);
  const initialPreview = await waitForDualPreview(page);
  if (!initialPreview.outgoing.muted || !initialPreview.incoming.muted || !(initialPreview.outgoing.opacity > initialPreview.incoming.opacity && initialPreview.incoming.opacity > .2)) throw new Error(`双流转场初始权重或静音状态错误：${JSON.stringify(initialPreview)}`);

  await page.getByTestId("edit-transition-in-offset").fill("2");
  await page.getByTestId("edit-transition-in-offset").dispatchEvent("change");
  await page.getByTestId("edit-transition-out-offset").fill("4");
  await page.getByTestId("edit-transition-out-offset").dispatchEvent("change");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const saved = await waitForProject(page, fixture.editProjectId, (project) => project.revision === fixture.revision + 1 && project.tracks[0].clips[0].transition?.inOffsetFrames === 2 && project.tracks[0].clips[0].transition?.outOffsetFrames === 4, "UI 保存标准转场 offsets");

  await page.getByTitle("撤销剪辑").click();
  const undone = await waitForProject(page, fixture.editProjectId, (project) => project.revision === saved.revision + 1 && project.tracks[0].clips[0].transition?.inOffsetFrames === 3 && project.tracks[0].clips[0].transition?.outOffsetFrames === 5, "UI 撤销标准转场 offsets");
  await page.getByTitle("重做剪辑").click();
  const redone = await waitForProject(page, fixture.editProjectId, (project) => project.revision === undone.revision + 1 && project.tracks[0].clips[0].transition?.inOffsetFrames === 2 && project.tracks[0].clips[0].transition?.outOffsetFrames === 4, "UI 重做标准转场 offsets");
  await page.getByTestId(`timeline-clip-${fixture.outgoingClipId}`).click();
  await seekFrame(page, 24);
  const previewAfterRedo = await waitForDualPreview(page);

  const exported = await page.evaluate(async ({ root, projectId, revision }) => window.canvasApi.exportEditOtio(root, projectId, revision), { root, projectId: redone.id, revision: redone.revision });
  const exportedDocument = JSON.parse(await readFile(exported.path, "utf8"));
  const exportedTransition = exportedDocument.tracks.children[0].children.find((child) => child.OTIO_SCHEMA === "Transition.1");
  if (exportedTransition?.transition_type !== "SMPTE_Dissolve" || exportedTransition.in_offset.value !== 2 || exportedTransition.out_offset.value !== 4) throw new Error(`UI 保存结果没有标准 OTIO 导出：${JSON.stringify(exportedTransition)}`);

  const screenshotCapture = await captureStableUi(page);
  const screenshot = await imageEvidence(screenshotPath);
  if (screenshot.bytes < 20_000 || screenshot.width !== 1560 || screenshot.height !== 980 || pageErrors.length) throw new Error(`首次 Electron UI 证据异常：${JSON.stringify({ screenshot, pageErrors })}`);

  await app.close();
  app = undefined;
  app = await launchApplication();
  const restartPage = await app.firstWindow();
  const restartPageErrors = [];
  restartPage.on("pageerror", (error) => restartPageErrors.push(error.message));
  await openEditor(restartPage, fixture.editProjectId);
  await restartPage.getByTestId(`timeline-clip-${fixture.outgoingClipId}`).click();
  const restartInspector = { inOffsetFrames: Number(await restartPage.getByTestId("edit-transition-in-offset").inputValue()), outOffsetFrames: Number(await restartPage.getByTestId("edit-transition-out-offset").inputValue()) };
  await seekFrame(restartPage, 24);
  const restartPreview = await waitForDualPreview(restartPage);
  const restartProject = await restartPage.evaluate(async ({ root, projectId }) => window.canvasApi.getEditProject(root, projectId), { root, projectId: fixture.editProjectId });
  if (restartProject.revision !== redone.revision || restartInspector.inOffsetFrames !== 2 || restartInspector.outOffsetFrames !== 4 || restartPageErrors.length) throw new Error(`应用重启后标准转场漂移：${JSON.stringify({ restartProject, restartInspector, restartPageErrors })}`);

  const sourceFiles = ["src/core/types.ts", "src/core/editor.ts", "src/core/codex.ts", "src/mcp/server.ts", "src/renderer/src/components/VideoEditorView.vue", "scripts/create-effect-transition-ui-fixture.ts", "scripts/ui-editor-effect-transition-smoke.mjs"];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (relative) => [relative, sha256Buffer(await readFile(path.join(workspace, relative)))])));
  evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: "passed",
    transport: packagedExecutable ? "packaged-electron-current-source" : "electron-current-production-build",
    executablePath: packagedExecutable ? path.resolve(packagedExecutable) : undefined,
    userDataPath,
    fixture,
    inspector: { initial: initialInspector, restart: restartInspector },
    preview: { initial: initialPreview, afterRedo: previewAfterRedo, afterApplicationRestart: restartPreview },
    revisions: { fixture: fixture.revision, saved: saved.revision, undone: undone.revision, redone: redone.revision, afterApplicationRestart: restartProject.revision },
    undoRedo: { undoRestoredOffsets: [3, 5], redoRestoredOffsets: [2, 4] },
    otioExport: { path: exported.path, transition: exportedTransition, contract: exportedDocument.metadata.aicanvas.effectTransitionContract },
    screenshot: { ...screenshot, captureAttempt: screenshotCapture.attempt, content: screenshotCapture.content },
    pageErrors: [...pageErrors, ...restartPageErrors],
    sourceHashes,
  };
} finally {
  if (app) await app.close();
  await rm(runtimeRoot, { recursive: true, force: true });
}

if (!evidence) throw new Error("Electron Effect/Transition smoke 未生成证据对象。");
const rootRemoved = await access(root).then(() => false, () => true);
const registryRemoved = await access(registryPath).then(() => false, () => true);
const userDataRemoved = await access(userDataPath).then(() => false, () => true);
if (!rootRemoved || !registryRemoved || !userDataRemoved) throw new Error(`隔离夹具未清理：${JSON.stringify({ rootRemoved, registryRemoved, userDataRemoved })}`);
evidence.terminal = { rootRemoved, registryRemoved, userDataRemoved };
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ evidencePath, status: evidence.status, revisions: evidence.revisions, inspector: evidence.inspector, preview: evidence.preview, screenshot: evidence.screenshot, terminal: evidence.terminal }, null, 2)}\n`);
