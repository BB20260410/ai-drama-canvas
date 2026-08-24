import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type Page } from "playwright";
import sharp from "sharp";
import { inspectManagedProject } from "../src/core/managed-project.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import {
  assertRedlineProjectSentinelsUnchanged,
  createIsolatedRedlineProjectCopy,
  snapshotRedlineProjectSentinels,
} from "./lib/redline-project-sentinel-shared.js";
import { assertWorkspaceRuntimeBuildIdentity } from "./lib/workspace-runtime-build-identity.js";
import { closeElectronApplicationOrThrow, forceCleanupElectronApplication } from "./lib/electron-application-close.mjs";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceProjectRoot = path.resolve(
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

interface BufferedScreenshotEvidence {
  bytes: Buffer;
  evidence: {
    sha256: string;
    sizeBytes: number;
    width: number | undefined;
    height: number | undefined;
    maxChannelStandardDeviation: number;
  };
}

async function captureScreenshotEvidence(page: Page): Promise<BufferedScreenshotEvidence> {
  const bytes = await page.screenshot({
    type: "png",
    fullPage: false,
    animations: "disabled",
  });
  const [metadata, statistics] = await Promise.all([
    sharp(bytes).metadata(),
    sharp(bytes).stats(),
  ]);
  const maxChannelStandardDeviation = Math.max(...statistics.channels.map((channel) => channel.stdev));
  if ((metadata.width ?? 0) < 1_400
    || (metadata.height ?? 0) < 800
    || bytes.byteLength < 30_000
    || maxChannelStandardDeviation < 5) {
    throw new Error("截图疑似空白或占位。");
  }
  return {
    bytes,
    evidence: {
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      width: metadata.width,
      height: metadata.height,
      maxChannelStandardDeviation,
    },
  };
}

async function assertPathAbsent(absolutePath: string): Promise<void> {
  try {
    await lstat(absolutePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`隔离运行目录清理后仍存在：${absolutePath}`);
}

const outputOwned = {
  evidence: false,
  overview: false,
  tracks: false,
};
const outputEverOwned = {
  evidence: false,
  overview: false,
  tracks: false,
};

const outputPaths = {
  evidence: evidencePath,
  overview: overviewScreenshotPath,
  tracks: tracksScreenshotPath,
} as const;
type OutputKind = keyof typeof outputPaths;

async function removeOwnedEvidenceOutputs(): Promise<Error[]> {
  const errors: Error[] = [];
  for (const kind of Object.keys(outputPaths) as OutputKind[]) {
    if (!outputOwned[kind]) continue;
    try {
      await rm(outputPaths[kind], { force: true });
      outputOwned[kind] = false;
    } catch (error) {
      errors.push(new Error(`删除本轮拥有的 ${kind} 证据失败：${outputPaths[kind]}`, { cause: error }));
    }
  }
  return errors;
}

async function assertEverOwnedEvidenceOutputsAbsent(): Promise<Error[]> {
  const errors: Error[] = [];
  for (const kind of Object.keys(outputPaths) as OutputKind[]) {
    if (!outputEverOwned[kind]) continue;
    try {
      await assertPathAbsent(outputPaths[kind]);
    } catch (error) {
      errors.push(new Error(`本轮拥有的 ${kind} 证据删除后仍存在：${outputPaths[kind]}`, { cause: error }));
    }
  }
  return errors;
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function combineFailure(primary: unknown, cleanupErrors: readonly Error[]): Error {
  if (cleanupErrors.length === 0) {
    return primary instanceof Error ? primary : new Error(describeFailure(primary));
  }
  const cleanupDetail = cleanupErrors.map(describeFailure).join("；");
  if (primary) {
    return new Error(`P5 smoke 主流程失败；附加清理失败：${cleanupDetail}`, { cause: primary });
  }
  return new Error(`P5 smoke 清理失败：${cleanupDetail}`);
}

async function writeOwnedEvidenceOutput(
  kind: OutputKind,
  outputPath: string,
  content: string | Buffer,
): Promise<void> {
  let primaryFailure: unknown;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const closeErrors: Error[] = [];
  try {
    handle = await open(outputPath, "wx", 0o600);
    outputOwned[kind] = true;
    outputEverOwned[kind] = true;
    await handle.writeFile(content);
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        closeErrors.push(new Error(`关闭本轮拥有的 ${kind} 证据句柄失败：${outputPath}`, { cause: error }));
      }
    }
  }
  if (primaryFailure || closeErrors.length > 0) {
    throw combineFailure(primaryFailure, closeErrors);
  }
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
await Promise.all([
  assertPathAbsent(evidencePath),
  assertPathAbsent(overviewScreenshotPath),
  assertPathAbsent(tracksScreenshotPath),
]);
await mkdir(evidenceRoot, { recursive: true });
const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
const previousMediaRuntimePath = process.env.AI_CANVAS_MEDIA_RUNTIME_DIR;
const previousManagedProjectsRoot = process.env.AI_CANVAS_MANAGED_PROJECTS_ROOT;
let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
const sourceProjectSentinelsBefore = await snapshotRedlineProjectSentinels(sourceProjectRoot);
let isolated: Awaited<ReturnType<typeof createIsolatedRedlineProjectCopy>> | undefined;
let isolatedPaths: { runtimeRoot: string; projectRoot: string } | undefined;
let evidence: Record<string, unknown> | undefined;
let overviewScreenshot: BufferedScreenshotEvidence | undefined;
let tracksScreenshot: BufferedScreenshotEvidence | undefined;
let outputsWritten = false;
let closeEvidence: Awaited<ReturnType<typeof closeElectronApplicationOrThrow>> | undefined;
let primaryFailure: unknown;

try {
  isolated = await createIsolatedRedlineProjectCopy(sourceProjectRoot);
  isolatedPaths = { runtimeRoot: isolated.runtimeRoot, projectRoot: isolated.projectRoot };
  const registryPath = path.join(isolated.runtimeRoot, "registry", "projects.json");
  const userDataPath = path.join(isolated.runtimeRoot, "user-data");
  const mediaRuntimeRoot = path.join(isolated.runtimeRoot, "media-runtime");
  const managedProjectsRoot = path.join(isolated.runtimeRoot, "managed-projects");
  await Promise.all([
    mkdir(path.dirname(registryPath), { recursive: true }),
    mkdir(userDataPath, { recursive: true }),
    mkdir(mediaRuntimeRoot, { recursive: true }),
    mkdir(managedProjectsRoot, { recursive: true }),
  ]);
  const shell = await inspectManagedProject(isolated.projectRoot);
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  process.env.AI_CANVAS_MEDIA_RUNTIME_DIR = mediaRuntimeRoot;
  process.env.AI_CANVAS_MANAGED_PROJECTS_ROOT = managedProjectsRoot;
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
      AI_CANVAS_PROJECT_ROOT: isolated.projectRoot,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_MEDIA_RUNTIME_DIR: mediaRuntimeRoot,
      AI_CANVAS_MANAGED_PROJECTS_ROOT: managedProjectsRoot,
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1728, height: 1029 });
  const runtimeBuildIdentity = await assertWorkspaceRuntimeBuildIdentity(workspace, page);
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

  const playbackSelect = page.locator('[data-testid="multimedia-playback-select"]');
  const playbackOptions = await playbackSelect.locator("option").evaluateAll((options) =>
    options.map((option) => ({
      value: (option as HTMLOptionElement).value,
      label: option.textContent?.trim() ?? "",
    })));
  const unselectedPlaybackState = {
    selectedValue: await playbackSelect.inputValue(),
    videoPlayers: await page.locator('[data-testid="multimedia-video-player"]').count(),
    audioPlayers: await page.locator('[data-testid="multimedia-audio-player"]').count(),
    emptyText: (await page.locator('[data-testid="multimedia-playback-empty"]').innerText()).trim(),
  };
  if (unselectedPlaybackState.selectedValue
    || unselectedPlaybackState.videoPlayers !== 0
    || unselectedPlaybackState.audioPlayers !== 0
    || !unselectedPlaybackState.emptyText.includes("未选择时不会加载原媒体")) {
    throw new Error(`未选择媒体时发生了自动加载：${JSON.stringify(unselectedPlaybackState)}`);
  }
  const videoOption = playbackOptions.find((option) => option.label.includes("视频"));
  const audioOption = playbackOptions.find((option) => option.label.includes("对白"));
  if (!videoOption) throw new Error(`播放器没有视频选项：${JSON.stringify(playbackOptions)}`);
  if (!audioOption) throw new Error(`播放器没有对白选项：${JSON.stringify(playbackOptions)}`);
  await playbackSelect.selectOption(videoOption.value);
  const videoPlayback = await playForProbe(page, "multimedia-video-player");
  if (!videoPlayback.advanced || videoPlayback.errorCode !== null) {
    throw new Error(`视频没有真实推进：${JSON.stringify(videoPlayback)}`);
  }
  await playbackSelect.selectOption(audioOption.value);
  const audioPlayback = await playForProbe(page, "multimedia-audio-player");
  if (!audioPlayback.advanced || audioPlayback.errorCode !== null) {
    throw new Error(`音频没有真实推进：${JSON.stringify(audioPlayback)}`);
  }

  await page.locator('[data-testid="multimedia-playback-deck"]').scrollIntoViewIfNeeded();
  overviewScreenshot = await captureScreenshotEvidence(page);
  await page.locator('[data-testid="multimedia-video-track"]').scrollIntoViewIfNeeded();
  tracksScreenshot = await captureScreenshotEvidence(page);
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
  evidence = {
    schemaVersion: 2,
    kind: "p5-multimedia-formal-electron-smoke",
    createdAt: new Date().toISOString(),
    runtimeBuildIdentity,
    projectId: shell.project.id,
    sourceProjectRoot,
    isolatedProjectId: shell.project.id,
    isolatedProjectCopy: true,
    unitId: targetUnitId,
    availabilityText,
    videoEntries,
    audioEntries,
    gapText,
    importButtonEnabled: true,
    playbackOptions,
    unselectedPlaybackState,
    videoPlayback,
    audioPlayback,
    derivativeLabels: await page.locator('[data-testid="multimedia-derivative-status"] span').allTextContents(),
    pageErrors,
    consoleErrors,
    externalResources,
    readonlyProjectSentinels: {
      unchanged: true,
      before: sourceProjectSentinelsBefore,
      after: null,
    },
    screenshots: null,
    electronClose: null,
    externalUploadCount: 0,
    imageGenerationCount: 0,
    paidActionCount: 0,
  };
  if (application) {
    closeEvidence = await closeElectronApplicationOrThrow(application, {
      label: "P5 multimedia Electron",
      timeoutMs: 20_000,
    });
    application = undefined;
  }
  await isolated.cleanup();
  await Promise.all([
    assertPathAbsent(isolated.runtimeRoot),
    assertPathAbsent(isolated.projectRoot),
  ]);
  isolated = undefined;
  const sourceProjectSentinelsAfter = await assertRedlineProjectSentinelsUnchanged(
    sourceProjectRoot,
    sourceProjectSentinelsBefore,
  );
  if (evidence) {
    const readonlyProjectSentinels = evidence.readonlyProjectSentinels as {
      after: unknown;
    };
    readonlyProjectSentinels.after = sourceProjectSentinelsAfter;
  }
  if (!overviewScreenshot || !tracksScreenshot || !evidence || !closeEvidence) {
    throw new Error("P5 smoke 缺少待落盘的截图、关闭证据或验收数据。");
  }
  evidence.electronClose = closeEvidence;
  evidence.screenshots = {
    overview: {
      path: path.relative(workspace, overviewScreenshotPath).split(path.sep).join("/"),
      ...overviewScreenshot.evidence,
    },
    tracks: {
      path: path.relative(workspace, tracksScreenshotPath).split(path.sep).join("/"),
      ...tracksScreenshot.evidence,
    },
  };
  await writeOwnedEvidenceOutput("overview", overviewScreenshotPath, overviewScreenshot.bytes);
  await writeOwnedEvidenceOutput("tracks", tracksScreenshotPath, tracksScreenshot.bytes);
  await writeOwnedEvidenceOutput("evidence", evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  outputsWritten = true;
} catch (error) {
  primaryFailure = error;
} finally {
  const cleanupErrors: Error[] = [];
  if (application) {
    try {
      const forced = await forceCleanupElectronApplication(application);
      if (!forced.exited) {
        throw new Error(`Electron 强制清理后仍未退出：${JSON.stringify(forced)}`);
      }
    } catch (error) {
      cleanupErrors.push(new Error("P5 Electron 失败路径清理失败", { cause: error }));
    }
  }
  if (isolated) {
    try {
      await isolated.cleanup();
    } catch (error) {
      cleanupErrors.push(new Error("P5 隔离副本失败路径清理失败", { cause: error }));
    }
  }
  if (isolatedPaths) {
    for (const isolatedPath of [isolatedPaths.runtimeRoot, isolatedPaths.projectRoot]) {
      try {
        await assertPathAbsent(isolatedPath);
      } catch (error) {
        cleanupErrors.push(new Error(`P5 隔离路径未确认删除：${isolatedPath}`, { cause: error }));
      }
    }
  }
  try {
    await assertRedlineProjectSentinelsUnchanged(sourceProjectRoot, sourceProjectSentinelsBefore);
  } catch (error) {
    cleanupErrors.push(new Error("P5 失败路径正式工程红线复核失败", { cause: error }));
  }
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
  if (previousMediaRuntimePath === undefined) delete process.env.AI_CANVAS_MEDIA_RUNTIME_DIR;
  else process.env.AI_CANVAS_MEDIA_RUNTIME_DIR = previousMediaRuntimePath;
  if (previousManagedProjectsRoot === undefined) delete process.env.AI_CANVAS_MANAGED_PROJECTS_ROOT;
  else process.env.AI_CANVAS_MANAGED_PROJECTS_ROOT = previousManagedProjectsRoot;
  if (!outputsWritten || cleanupErrors.length > 0) {
    cleanupErrors.push(...await removeOwnedEvidenceOutputs());
    cleanupErrors.push(...await assertEverOwnedEvidenceOutputsAbsent());
  }
  if (cleanupErrors.length > 0) primaryFailure = combineFailure(primaryFailure, cleanupErrors);
}

if (primaryFailure) throw primaryFailure;
if (!evidence) throw new Error("P5 smoke 未生成验收证据。");
const written = await readFile(evidencePath);
console.log(JSON.stringify({
  ok: true,
  evidencePath,
  evidenceSha256: sha256(written),
  availabilityText: evidence.availabilityText,
  videoPlayback: evidence.videoPlayback,
  audioPlayback: evidence.audioPlayback,
  screenshots: evidence.screenshots,
}, null, 2));
