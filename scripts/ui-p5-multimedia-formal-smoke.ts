import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type Page } from "playwright";
import sharp from "sharp";
import { inspectManagedProject } from "../src/core/managed-project.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(
  process.argv[2]
    ?? path.join(workspace, "projects", "local-import-dudu-world-prologue-b8bfcf14"),
);
const evidenceRoot = path.join(workspace, "output", "playwright");
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const evidencePath = path.resolve(
  process.argv[3] ?? path.join(evidenceRoot, `p5-multimedia-formal-${stamp}.json`),
);
const overviewScreenshotPath = path.resolve(
  process.argv[4] ?? path.join(evidenceRoot, `p5-multimedia-formal-overview-${stamp}.png`),
);
const tracksScreenshotPath = path.resolve(
  process.argv[5] ?? path.join(evidenceRoot, `p5-multimedia-formal-tracks-${stamp}.png`),
);
const targetUnitId = "unit-local-e61b4628ca1abe8d8752c50d304fdb6e77847b16";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function screenshotEvidence(page: Page, outputPath: string) {
  const bytes = await page.screenshot({
    type: "png",
    fullPage: false,
    animations: "disabled",
  });
  await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
  const [metadata, statistics, file] = await Promise.all([
    sharp(bytes).metadata(),
    sharp(bytes).stats(),
    stat(outputPath),
  ]);
  const maxChannelStandardDeviation = Math.max(...statistics.channels.map((channel) => channel.stdev));
  if ((metadata.width ?? 0) < 1_400
    || (metadata.height ?? 0) < 800
    || file.size < 30_000
    || maxChannelStandardDeviation < 5) {
    throw new Error(`截图疑似空白或占位：${path.basename(outputPath)}`);
  }
  return {
    path: path.relative(workspace, outputPath).split(path.sep).join("/"),
    sha256: sha256(bytes),
    sizeBytes: file.size,
    width: metadata.width,
    height: metadata.height,
    maxChannelStandardDeviation,
  };
}

async function playForProbe(
  page: Page,
  testId: "multimedia-video-player" | "multimedia-audio-player",
) {
  const player = page.locator(`[data-testid="${testId}"]`);
  await player.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction((selector) => {
    const media = document.querySelector<HTMLMediaElement>(selector);
    return Boolean(media
      && media.readyState >= HTMLMediaElement.HAVE_METADATA
      && Number.isFinite(media.duration)
      && media.duration > 0);
  }, `[data-testid="${testId}"]`, { timeout: 30_000 });
  return player.evaluate(async (media: HTMLMediaElement) => {
    const startSeconds = media.currentTime;
    await media.play();
    await new Promise((resolve) => setTimeout(resolve, 850));
    media.pause();
    return {
      readyState: media.readyState,
      networkState: media.networkState,
      durationSeconds: media.duration,
      startSeconds,
      endSeconds: media.currentTime,
      advanced: media.currentTime > startSeconds + 0.2,
      paused: media.paused,
      errorCode: media.error?.code ?? null,
      sourceProtocol: new URL(media.currentSrc || media.src).protocol,
    };
  });
}

for (const outputPath of [evidencePath, overviewScreenshotPath, tracksScreenshotPath]) {
  if (!outputPath.startsWith(`${evidenceRoot}${path.sep}`)) {
    throw new Error(`P5 UI 证据必须写入 output/playwright：${outputPath}`);
  }
}
await mkdir(evidenceRoot, { recursive: true });
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p5-multimedia-ui-"));
const registryPath = path.join(runtimeRoot, "registry", "projects.json");
const userDataPath = path.join(runtimeRoot, "user-data");
await mkdir(path.dirname(registryPath), { recursive: true });
await mkdir(userDataPath, { recursive: true });

const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  const shell = await inspectManagedProject(projectRoot);
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  await registerProject(shell.project);
  await setActiveProjectRegistration(shell.paths.root);

  application = await electron.launch({
    args: [
      path.join(workspace, "out", "main", "index.js"),
      `--user-data-dir=${userDataPath}`,
    ],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: shell.paths.root,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1728, height: 1029 });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  try {
    await page.waitForSelector('[data-testid="material-studio-view"]', { timeout: 60_000 });
  } catch (error) {
    const windows = await Promise.all(application.windows().map(async (candidate, index) => ({
      index,
      url: candidate.url(),
      title: await candidate.title().catch(() => ""),
      body: (await candidate.locator("body").innerText().catch(() => "")).slice(0, 2_000),
      testIds: await candidate.locator("[data-testid]").evaluateAll((nodes) =>
        nodes.slice(0, 80).map((node) => node.getAttribute("data-testid"))),
    })));
    throw new Error(`Electron 未进入受管 Studio：${JSON.stringify({ windows, pageErrors, consoleErrors })}`, {
      cause: error,
    });
  }
  await page.locator('[data-testid="studio-mode-multimedia-timeline"]').click();
  await page.waitForSelector('[data-testid="studio-multimedia-timeline-view"]', { timeout: 60_000 });
  const unitButton = page.locator(`[data-testid="multimedia-unit-list"] [data-unit-id="${targetUnitId}"]`);
  await unitButton.waitFor({ state: "visible", timeout: 60_000 });
  await unitButton.click();
  await page.waitForFunction(() => {
    const view = document.querySelector('[data-testid="studio-multimedia-timeline-view"]');
    const heading = document.querySelector('[data-testid="multimedia-unit-heading"]');
    return view?.getAttribute("aria-busy") === "false" && Boolean(heading);
  }, undefined, { timeout: 60_000 });

  const availabilityText = (await page.locator('[data-testid="multimedia-availability"]').innerText()).trim();
  if (!availabilityText.includes("视频 可用") || !availabilityText.includes("音频 可用")) {
    throw new Error(`UI 没有显示视频/音频可用：${availabilityText}`);
  }
  const videoEntries = await page.locator('[data-testid="multimedia-video-track"] article.track-entry').count();
  const audioEntries = await page.locator('[data-testid="multimedia-audio-track"] article.track-entry').count();
  if (videoEntries !== 1 || audioEntries !== 1) {
    throw new Error(`正式轨道数量不匹配：video=${videoEntries}, audio=${audioEntries}`);
  }
  const gapText = (await page.locator('[data-testid="multimedia-gap-register"]').innerText()).trim();
  if (!gapText.includes("无已知缺失") || !gapText.includes("Core 未报告")) {
    throw new Error(`UI 仍显示媒体缺口：${gapText}`);
  }
  const importButton = page.locator('[data-testid="multimedia-pick-media"]');
  if (await importButton.isDisabled()) throw new Error("导入并绑定正式媒体按钮不可用。");

  const videoPlayback = await playForProbe(page, "multimedia-video-player");
  if (!videoPlayback.advanced || videoPlayback.errorCode !== null) {
    throw new Error(`视频没有真实推进：${JSON.stringify(videoPlayback)}`);
  }
  const playbackSelect = page.locator('[data-testid="multimedia-playback-select"]');
  const playbackOptions = await playbackSelect.locator("option").evaluateAll((options) =>
    options.map((option) => ({
      value: (option as HTMLOptionElement).value,
      label: option.textContent?.trim() ?? "",
    })));
  const audioOption = playbackOptions.find((option) => option.label.includes("对白"));
  if (!audioOption) throw new Error(`播放器没有对白选项：${JSON.stringify(playbackOptions)}`);
  await playbackSelect.selectOption(audioOption.value);
  const audioPlayback = await playForProbe(page, "multimedia-audio-player");
  if (!audioPlayback.advanced || audioPlayback.errorCode !== null) {
    throw new Error(`音频没有真实推进：${JSON.stringify(audioPlayback)}`);
  }

  await page.locator('[data-testid="multimedia-playback-deck"]').scrollIntoViewIfNeeded();
  const overviewScreenshot = await screenshotEvidence(page, overviewScreenshotPath);
  await page.locator('[data-testid="multimedia-video-track"]').scrollIntoViewIfNeeded();
  const tracksScreenshot = await screenshotEvidence(page, tracksScreenshotPath);
  const externalResources = await page.evaluate(() =>
    performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => /^https?:/iu.test(name)
        && !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/)/iu.test(name)));
  if (externalResources.length > 0) {
    throw new Error(`UI 实机验收检测到外网资源：${externalResources.join(", ")}`);
  }
  if (pageErrors.length > 0 || consoleErrors.length > 0) {
    throw new Error(`页面错误：page=${JSON.stringify(pageErrors)} console=${JSON.stringify(consoleErrors)}`);
  }

  const evidence = {
    schemaVersion: 1,
    kind: "p5-multimedia-formal-electron-smoke",
    createdAt: new Date().toISOString(),
    projectId: shell.project.id,
    unitId: targetUnitId,
    availabilityText,
    videoEntries,
    audioEntries,
    gapText,
    importButtonEnabled: true,
    playbackOptions,
    videoPlayback,
    audioPlayback,
    derivativeLabels: await page.locator('[data-testid="multimedia-derivative-status"] span').allTextContents(),
    pageErrors,
    consoleErrors,
    externalResources,
    screenshots: {
      overview: overviewScreenshot,
      tracks: tracksScreenshot,
    },
    externalUploadCount: 0,
    imageGenerationCount: 0,
    paidActionCount: 0,
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const written = await readFile(evidencePath);
  console.log(JSON.stringify({
    ok: true,
    evidencePath,
    evidenceSha256: sha256(written),
    availabilityText,
    videoPlayback,
    audioPlayback,
    screenshots: evidence.screenshots,
  }, null, 2));
} finally {
  if (application) await application.close().catch(() => undefined);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
}
