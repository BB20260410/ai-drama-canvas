import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import sharp from "sharp";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(process.argv[2] || "/tmp/ai-canvas-editor-ui-20260713");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-editor-ui-registry-20260713.json");
const evidencePath = path.resolve(process.argv[4] || path.join(workspace, "docs", "evidence", "editor-bezier-ui-smoke-20260714.json"));
const packagedExecutable = process.env.AI_CANVAS_ELECTRON_EXECUTABLE?.trim();
const evidenceDirectory = path.join(workspace, "docs", "evidence");
await mkdir(evidenceDirectory, { recursive: true });

const app = await electron.launch({
  ...(packagedExecutable ? { executablePath: path.resolve(packagedExecutable), args: [] } : { args: ["."] }),
  cwd: workspace,
  env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath, AI_CANVAS_WINDOW_WIDTH: "1560", AI_CANVAS_WINDOW_HEIGHT: "980" },
});

try {
  const page = await app.firstWindow();
  const capture = async (outputPath) => {
    let content;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await page.bringToFront();
      await page.waitForTimeout(700);
      const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      const raw = await page.screenshot({ type: "png", animations: "disabled" });
      await sharp(raw).resize(size.width, size.height, { fit: "fill" }).png().toFile(outputPath);
      const decoded = await sharp(outputPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let brightPixels = 0;
      let chromaticPixels = 0;
      for (let offset = 0; offset < decoded.data.length; offset += decoded.info.channels) {
        const red = decoded.data[offset] ?? 0;
        const green = decoded.data[offset + 1] ?? 0;
        const blue = decoded.data[offset + 2] ?? 0;
        if (Math.max(red, green, blue) >= 50) brightPixels += 1;
        if (Math.max(red, green, blue) - Math.min(red, green, blue) >= 28) chromaticPixels += 1;
      }
      const pixels = decoded.info.width * decoded.info.height;
      content = { captureAttempt: attempt, pixels, brightPixels, brightRatio: brightPixels / pixels, chromaticPixels, chromaticRatio: chromaticPixels / pixels };
      if (content.brightRatio >= .01 && content.chromaticRatio >= .005) return content;
    }
    throw new Error(`剪辑台截图连续三次内容覆盖不足：${JSON.stringify(content)}`);
  };
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "导演剪辑台" }).click();
  await page.getByRole("heading", { name: "导演剪辑台" }).waitFor();
  await page.locator(".timeline-clip").first().waitFor();
  const timebaseText = await page.locator(".transport span").innerText();
  if (!timebaseText.includes("24000/1001") || !timebaseText.includes("F0")) throw new Error(`剪辑台没有显示权威时间基与播放头帧：${timebaseText}`);
  const rangeStep = Number(await page.locator(".transport input[type=range]").getAttribute("step"));
  if (Math.abs(rangeStep - 1001 / 24000) > 1e-7) throw new Error(`播放头步长不是单帧：${rangeStep}`);
  await page.locator(".transport input[type=range]").evaluate((element) => {
    const input = element;
    input.value = "0.5";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const splitButton = page.getByRole("button", { name: "分割" });
  if (await splitButton.isDisabled()) throw new Error("播放头进入片段内部后，分割按钮仍不可用。");
  await splitButton.click();
  await page.getByText(/已在 .* 分割片段/).waitFor();
  if (await page.locator(".timeline-clip").count() !== 4) throw new Error("分割后时间线片段数量不正确。");
  const projectAfterSplit = await page.evaluate(async ({ projectRoot }) => {
    const projects = await window.canvasApi.listEditProjects(projectRoot);
    return projects[0];
  }, { projectRoot });
  const mainClips = projectAfterSplit?.tracks?.find((track) => track.kind === "visual" && track.order === 0)?.clips?.slice().sort((left, right) => left.startFrame - right.startFrame) ?? [];
  const frameContinuous = mainClips.every((clip, index) => Number.isInteger(clip.startFrame) && Number.isInteger(clip.durationFrames) && clip.durationFrames > 0 && (index === 0 || clip.startFrame === mainClips[index - 1].startFrame + mainClips[index - 1].durationFrames));
  if (projectAfterSplit?.revision < 2 || projectAfterSplit?.timebase?.rateNumerator !== 24_000 || projectAfterSplit?.timebase?.rateDenominator !== 1_001 || !frameContinuous || mainClips[1]?.startFrame !== 12) throw new Error(`分割或分数时间基没有按整数帧持久化：${JSON.stringify({ projectAfterSplit, mainClips, frameContinuous })}`);

  const screenshot = path.join(evidenceDirectory, packagedExecutable ? "editor-bezier-packaged-20260714.png" : "editor-bezier-20260714.png");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Ripple 删除" }).click();
  await page.getByText(/已 Ripple 删除/).waitFor();
  if (await page.locator(".timeline-clip").count() !== 3) throw new Error("Ripple 删除后时间线没有收拢到预期片段数。");
  await page.locator(".editor-actions .icon-history").first().click();
  await page.getByText(/已撤销到新修订/).waitFor();
  if (await page.locator(".timeline-clip").count() !== 4) throw new Error("撤销 Ripple 删除后没有恢复分割结果。");

  await page.getByRole("button", { name: /贝塞尔 UI 覆盖层/ }).click();
  const curveRow = page.getByTestId("keyframe-row-kf-ui-bezier-end");
  await curveRow.waitFor();
  const curveSelect = curveRow.getByRole("combobox", { name: /缓动曲线/ });
  if (await curveSelect.inputValue() !== "cubic_bezier") throw new Error("夹具自定义曲线没有在 UI 中恢复。");
  const curvePath = curveRow.locator(".bezier-curve");
  const curveAPath = await curvePath.getAttribute("d");
  const readCurveInputs = async () => Object.fromEntries(await Promise.all(["x1", "y1", "x2", "y2"].map(async (coordinate) => [coordinate, Number(await page.getByTestId(`bezier-kf-ui-bezier-end-${coordinate}`).inputValue())])));
  const curveA = await readCurveInputs();
  if (JSON.stringify(curveA) !== JSON.stringify({ x1: .25, y1: .1, x2: .25, y2: 1 })) throw new Error(`初始曲线控制点不正确：${JSON.stringify(curveA)}`);
  await page.locator(".transport input[type=range]").evaluate((element) => {
    element.value = "1";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const transformA = await page.locator(".preview-overlay").first().evaluate((element) => getComputedStyle(element).transform);

  const persistedBeforeInvalid = await page.evaluate(async ({ projectRoot }) => (await window.canvasApi.listEditProjects(projectRoot))[0], { projectRoot });
  await page.getByTestId("bezier-kf-ui-bezier-end-x1").fill("1.2");
  await page.locator(".editor-actions button").filter({ hasText: "保存" }).click();
  await page.getByText(/cubic-bezier 控制点必须全部位于 0–1/).waitFor();
  const persistedAfterInvalid = await page.evaluate(async ({ projectRoot }) => (await window.canvasApi.listEditProjects(projectRoot))[0], { projectRoot });
  if (persistedAfterInvalid.revision !== persistedBeforeInvalid.revision) throw new Error("非法控制点错误地推进了工程修订。");

  for (const [coordinate, value] of Object.entries({ x1: .42, y1: 0, x2: .58, y2: 1 })) await page.getByTestId(`bezier-kf-ui-bezier-end-${coordinate}`).fill(String(value));
  const curveBPath = await curvePath.getAttribute("d");
  if (!curveAPath || !curveBPath || curveAPath === curveBPath) throw new Error("控制点变化没有更新 SVG 曲线。");
  const transformB = await page.locator(".preview-overlay").first().evaluate((element) => getComputedStyle(element).transform);
  if (transformA === transformB) throw new Error("控制点变化没有更新播放头预览 transform。");
  await page.locator(".editor-actions button").filter({ hasText: "保存" }).click();
  await page.getByText(/剪辑工程已保存为修订/).waitFor();
  const persistedB = await page.evaluate(async ({ projectRoot }) => (await window.canvasApi.listEditProjects(projectRoot))[0], { projectRoot });
  const persistedCurveB = persistedB.tracks.flatMap((track) => track.clips).find((clip) => clip.id === "clip-ui-bezier-overlay")?.keyframes?.find((keyframe) => keyframe.id === "kf-ui-bezier-end")?.bezier;
  if (JSON.stringify(persistedCurveB) !== JSON.stringify({ x1: .42, y1: 0, x2: .58, y2: 1 })) throw new Error(`曲线 B 未持久化：${JSON.stringify(persistedCurveB)}`);

  const projectSelector = page.locator(".editor-actions select");
  await projectSelector.selectOption("");
  await projectSelector.selectOption(persistedB.id);
  await page.getByRole("button", { name: /贝塞尔 UI 覆盖层/ }).click();
  await page.getByTestId("keyframe-row-kf-ui-bezier-end").waitFor();
  if (Number(await page.getByTestId("bezier-kf-ui-bezier-end-x1").inputValue()) !== .42) throw new Error("工程重载后没有恢复曲线 B。");

  await page.getByTitle("撤销剪辑").click();
  await page.waitForFunction(async ({ projectRoot, revision }) => (await window.canvasApi.listEditProjects(projectRoot))[0]?.revision > revision, { projectRoot, revision: persistedB.revision });
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="bezier-kf-ui-bezier-end-x1"]')?.value) === .25);
  const persistedAAfterUndo = await page.evaluate(async ({ projectRoot }) => (await window.canvasApi.listEditProjects(projectRoot))[0], { projectRoot });
  await page.getByTitle("重做剪辑").click();
  await page.waitForFunction(async ({ projectRoot, revision }) => (await window.canvasApi.listEditProjects(projectRoot))[0]?.revision > revision, { projectRoot, revision: persistedAAfterUndo.revision });
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="bezier-kf-ui-bezier-end-x1"]')?.value) === .42);
  const persistedAfterRedo = await page.evaluate(async ({ projectRoot }) => (await window.canvasApi.listEditProjects(projectRoot))[0], { projectRoot });
  await page.getByTestId("keyframe-row-kf-ui-bezier-end").scrollIntoViewIfNeeded();
  const screenshotContent = await capture(screenshot);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 760));
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(500);
  await page.getByTestId("keyframe-row-kf-ui-bezier-end").scrollIntoViewIfNeeded();
  const compactFit = await page.evaluate(() => {
    const body = document.querySelector(".editor-body")?.getBoundingClientRect();
    const tools = document.querySelector(".timeline-tools")?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      body: body ? { left: body.left, right: body.right, top: body.top, bottom: body.bottom } : null,
      tools: tools ? { left: tools.left, right: tools.right, top: tools.top, bottom: tools.bottom } : null,
    };
  });
  if (compactFit.documentOverflowX || !compactFit.body || !compactFit.tools || compactFit.body.left < -1 || compactFit.body.right > compactFit.innerWidth + 1 || compactFit.tools.right > compactFit.innerWidth + 1) throw new Error(`1280x760 剪辑台超出窗口：${JSON.stringify(compactFit)}`);
  const compactScreenshot = path.join(evidenceDirectory, packagedExecutable ? "editor-bezier-packaged-1280-20260714.png" : "editor-bezier-1280-20260714.png");
  const compactScreenshotContent = await capture(compactScreenshot);
  const fileEvidence = async (filePath) => {
    const buffer = await readFile(filePath);
    const metadata = await sharp(buffer).metadata();
    return { path: filePath, bytes: buffer.byteLength, sha256: createHash("sha256").update(buffer).digest("hex"), width: metadata.width, height: metadata.height };
  };
  const sourceHashes = Object.fromEntries(await Promise.all(["src/core/keyframe-curve.ts", "src/core/editor.ts", "src/renderer/src/components/VideoEditorView.vue"].map(async (relative) => [relative, createHash("sha256").update(await readFile(path.join(workspace, relative))).digest("hex")])));
  const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), transport: packagedExecutable ? "packaged-electron" : "source-electron-current-build", projectRoot, registryPath, executablePath: packagedExecutable ? path.resolve(packagedExecutable) : undefined, screenshot: { ...await fileEvidence(screenshot), content: screenshotContent }, compactScreenshot: { ...await fileEvidence(compactScreenshot), content: compactScreenshotContent }, curve: { ownership: "destination-keyframe-controls-entering-segment", curveA, curveAPath, curveB: persistedCurveB, curveBPath, transformA, transformB, invalidRevisionRejected: persistedAfterInvalid.revision === persistedBeforeInvalid.revision, reloaded: true, undoCurve: { x1: .25, y1: .1, x2: .25, y2: 1 }, redoCurve: persistedAfterRedo.tracks.flatMap((track) => track.clips).find((clip) => clip.id === "clip-ui-bezier-overlay")?.keyframes?.find((keyframe) => keyframe.id === "kf-ui-bezier-end")?.bezier, revisions: { beforeInvalid: persistedBeforeInvalid.revision, afterInvalid: persistedAfterInvalid.revision, savedB: persistedB.revision, undoA: persistedAAfterUndo.revision, redoB: persistedAfterRedo.revision } }, projectAfterSplit: { id: projectAfterSplit.id, revision: projectAfterSplit.revision, timebase: projectAfterSplit.timebase, mainClipFrames: mainClips.map((clip) => ({ startFrame: clip.startFrame, durationFrames: clip.durationFrames })) }, timebaseText, rangeStep, compactFit, sourceHashes };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ evidencePath, ...evidence }, null, 2)}\n`);
} finally {
  await app.close();
}
