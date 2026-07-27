import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import sharp from "sharp";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.resolve(process.argv[2] || path.join(workspace, "formal-calibration", "calibration-state.json"));
const evidencePath = path.resolve(process.argv[3] || path.join(workspace, "docs", "evidence", "formal-project-nle-ui-smoke.json"));
const state = JSON.parse(await readFile(statePath, "utf8"));
const projectRoot = path.resolve(state.projectRoot);
const registryPath = path.resolve(state.registryPath);
const screenshotPath = evidencePath.replace(/\.json$/i, ".png");
const restartScreenshotPath = evidencePath.replace(/\.json$/i, "-restart.png");
const nestedScreenshotPath = evidencePath.replace(/\.json$/i, "-nested.png");
const previewScreenshotPath = evidencePath.replace(/\.json$/i, "-preview.png");
const restartPreviewScreenshotPath = evidencePath.replace(/\.json$/i, "-restart-preview.png");
await mkdir(path.dirname(evidencePath), { recursive: true });

async function fileEvidence(filePath) {
  const buffer = await readFile(filePath);
  const metadata = await sharp(buffer).metadata();
  return { path: filePath, bytes: buffer.byteLength, sha256: createHash("sha256").update(buffer).digest("hex"), width: metadata.width, height: metadata.height };
}

async function capture(page, outputPath) {
  await page.bringToFront();
  await page.waitForTimeout(700);
  const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const raw = await page.screenshot({ type: "png", animations: "disabled" });
  await sharp(raw).resize(size.width, size.height, { fit: "fill" }).png().toFile(outputPath);
  const content = await imageContent(outputPath);
  if (content.brightRatio < .01 || content.chromaticRatio < .005) throw new Error(`正式项目剪辑台截图内容覆盖不足：${JSON.stringify(content)}`);
  return { ...await fileEvidence(outputPath), content };
}

async function imageContent(outputPath) {
  const decoded = await sharp(outputPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let bright = 0;
  let chromatic = 0;
  for (let offset = 0; offset < decoded.data.length; offset += decoded.info.channels) {
    const red = decoded.data[offset] ?? 0;
    const green = decoded.data[offset + 1] ?? 0;
    const blue = decoded.data[offset + 2] ?? 0;
    if (Math.max(red, green, blue) >= 50) bright += 1;
    if (Math.max(red, green, blue) - Math.min(red, green, blue) >= 28) chromatic += 1;
  }
  const pixels = decoded.info.width * decoded.info.height;
  return { pixels, brightPixels: bright, brightRatio: bright / pixels, chromaticPixels: chromatic, chromaticRatio: chromatic / pixels };
}

async function capturePreview(page, outputPath) {
  const video = page.getByTestId("preview-main-video");
  const raw = await video.screenshot({ type: "png", animations: "disabled" });
  await sharp(raw).png().toFile(outputPath);
  const content = await imageContent(outputPath);
  if (content.brightRatio < .05 || content.chromaticRatio < .01) throw new Error(`正式项目主预览仍是黑帧或低信息画面：${JSON.stringify(content)}`);
  return { ...await fileEvidence(outputPath), content };
}

function summarizeProject(project) {
  const visualTracks = project.tracks.filter((track) => track.kind === "visual").sort((left, right) => left.order - right.order);
  const main = visualTracks[0];
  const allClips = project.tracks.flatMap((track) => track.clips);
  const mainEndFrames = main.clips.map((clip) => (clip.startFrame ?? 0) + (clip.durationFrames ?? 0));
  return {
    id: project.id,
    name: project.name,
    revision: project.revision,
    timebase: project.timebase,
    mainClipCount: main.clips.length,
    totalFrames: Math.max(0, ...mainEndFrames),
    audioClips: project.tracks.filter((track) => track.kind === "audio").flatMap((track) => track.clips).length,
    subtitleClips: project.tracks.filter((track) => track.kind === "subtitle").flatMap((track) => track.clips).length,
    nestedClips: allClips.filter((clip) => clip.kind === "timeline").map((clip) => ({ id: clip.id, snapshot: clip.nestedTimeline?.childSnapshotSha256, childRevision: clip.nestedTimeline?.childEditProjectRevision })),
    keyframeClips: allClips.filter((clip) => (clip.keyframes?.length ?? 0) > 0).map((clip) => ({ id: clip.id, keyframes: clip.keyframes.length })),
    timewarpClips: allClips.filter((clip) => clip.playbackRate !== 1).map((clip) => ({ id: clip.id, playbackRate: clip.playbackRate })),
    transitionClips: allClips.filter((clip) => clip.transitionOut === "smpte_dissolve").map((clip) => ({ id: clip.id, transition: clip.transition })),
  };
}

async function launchAndInspect(outputPath, previewOutputPath, nestedOutputPath) {
  const pageErrors = [];
  const app = await electron.launch({
    args: ["."],
    cwd: workspace,
    env: { ...process.env, AI_CANVAS_PROJECT_ROOT: projectRoot, AI_CANVAS_REGISTRY_PATH: registryPath, AI_CANVAS_WINDOW_WIDTH: "1560", AI_CANVAS_WINDOW_HEIGHT: "980" },
  });
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.waitForLoadState("domcontentloaded");
    await page.getByRole("button", { name: "导演剪辑台" }).click();
    await page.getByRole("heading", { name: "导演剪辑台" }).waitFor({ timeout: 30_000 });
    const selector = page.locator(".editor-actions select").first();
    await selector.selectOption(state.masterEditProjectId);
    await page.waitForFunction(async ({ projectRoot, projectId }) => {
      const projects = await window.canvasApi.listEditProjects(projectRoot);
      return projects.some((entry) => entry.id === projectId);
    }, { projectRoot, projectId: state.masterEditProjectId });
    await page.locator(".timeline-clip").first().waitFor({ timeout: 60_000 });
    const snapshot = await page.evaluate(async ({ projectRoot, projectId }) => {
      const project = await window.canvasApi.getEditProject(projectRoot, projectId);
      const renders = await window.canvasApi.listEditRenderJobs(projectRoot);
      return { project, renders };
    }, { projectRoot, projectId: state.masterEditProjectId });
    const summary = summarizeProject(snapshot.project);
    if (summary.revision !== state.masterRevision) throw new Error(`Electron master revision 与校准 state 不一致：${JSON.stringify({ ui: summary.revision, state: state.masterRevision })}`);
    if (summary.timebase?.rateNumerator !== 24_000 || summary.timebase?.rateDenominator !== 1_001) throw new Error(`Electron 未恢复 24000/1001：${JSON.stringify(summary.timebase)}`);
    if (summary.mainClipCount !== state.expectedMasterMainClipCount || summary.totalFrames !== state.expectedMasterTotalFrames) throw new Error(`Electron 长时间线镜头或总帧漂移：${JSON.stringify({ summary, expected: { clips: state.expectedMasterMainClipCount, frames: state.expectedMasterTotalFrames } })}`);
    if (!summary.nestedClips.length || !summary.keyframeClips.length || !summary.audioClips || !summary.subtitleClips) throw new Error(`Electron 没有恢复多轨/nested/keyframe：${JSON.stringify(summary)}`);
    const timebaseText = await page.locator(".transport span").innerText();
    if (!timebaseText.includes("24000/1001")) throw new Error(`Electron transport 没有显示分数时间基：${timebaseText}`);
    const headerText = await page.locator(".clip-inspector>header").innerText();
    if (!headerText.includes(snapshot.project.name) || !headerText.includes("秒")) throw new Error(`Electron inspector 没有显示正式 master：${headerText}`);
    const mainTrack = snapshot.project.tracks.filter((track) => track.kind === "visual").sort((left, right) => left.order - right.order)[0];
    const previewClip = mainTrack.clips.find((clip) => clip.kind === "video" && clip.playbackRate === 1 && clip.transitionOut === "cut");
    if (!previewClip) throw new Error("正式 master 没有可用于主预览验收的常速 cut 视频片段。 ");
    await page.getByTestId(`timeline-clip-${previewClip.id}`).click();
    const seekFrame = previewClip.startFrame + Math.min(24, previewClip.durationFrames - 1);
    const seekSeconds = seekFrame * snapshot.project.timebase.rateDenominator / snapshot.project.timebase.rateNumerator;
    await page.locator(".transport input[type=range]").evaluate((element, seconds) => {
      element.value = String(seconds);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, seekSeconds);
    await page.locator(".transport span").filter({ hasText: `F${seekFrame}` }).waitFor({ timeout: 30_000 });
    const previewVideo = page.getByTestId("preview-main-video");
    await previewVideo.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="preview-main-video"]');
      return element instanceof HTMLVideoElement && element.readyState >= 2 && element.videoWidth > 0 && element.videoHeight > 0 && !element.error && Boolean(element.currentSrc);
    }, undefined, { timeout: 30_000 });
    const preview = await previewVideo.evaluate((element) => ({ currentSrc: element.currentSrc, currentTime: element.currentTime, readyState: element.readyState, videoWidth: element.videoWidth, videoHeight: element.videoHeight, error: element.error ? { code: element.error.code, message: element.error.message } : null }));
    const previewScreenshot = await capturePreview(page, previewOutputPath);
    const screenshot = await capture(page, outputPath);
    const nestedId = summary.nestedClips[0].id;
    await page.getByTestId(`timeline-clip-${nestedId}`).click();
    await page.getByTestId("nested-timeline-inspector").waitFor({ timeout: 60_000 });
    const nestedInspector = await page.getByTestId("nested-timeline-inspector").innerText();
    if (!nestedInspector.includes(String(summary.nestedClips[0].snapshot).slice(0, 12))) throw new Error(`Electron nested inspector 缺少冻结 SHA：${nestedInspector}`);
    const nestedScreenshot = nestedOutputPath ? await capture(page, nestedOutputPath) : undefined;
    return { summary, timebaseText, headerText, preview, previewScreenshot, nestedInspector, nestedScreenshot, renders: snapshot.renders.map((job) => ({ id: job.id, status: job.status, outputPath: job.outputPath, progress: job.progress })), pageErrors, screenshot };
  } finally {
    await app.close();
  }
}

const first = await launchAndInspect(screenshotPath, previewScreenshotPath, nestedScreenshotPath);
const restarted = await launchAndInspect(restartScreenshotPath, restartPreviewScreenshotPath);
if (first.pageErrors.length || restarted.pageErrors.length) throw new Error(`正式 Electron 出现 pageerror：${JSON.stringify({ first: first.pageErrors, restarted: restarted.pageErrors })}`);
if (JSON.stringify(first.summary) !== JSON.stringify(restarted.summary)) throw new Error(`完整 App 重启后工程漂移：${JSON.stringify({ first: first.summary, restarted: restarted.summary })}`);

const evidence = {
  schemaVersion: 1,
  kind: "aicanvas-formal-project-nle-electron-smoke",
  generatedAt: new Date().toISOString(),
  status: "passed",
  transport: "source-electron-current-build",
  projectRoot,
  registryPath,
  statePath,
  first,
  restarted,
  fullAppRestartPersisted: true,
  pageErrors: [],
};
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: evidence.status, evidencePath, screenshotPath, restartScreenshotPath, nestedScreenshotPath, previewScreenshotPath, restartPreviewScreenshotPath, master: first.summary }, null, 2)}\n`);
