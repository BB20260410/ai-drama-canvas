#!/usr/bin/env node
/**
 * P8 临时打包端 30 分钟主动实机 soak。
 *
 * 正式工程只用于复制前后红线校验；所有画布布局、扫描、媒体播放与活动项目
 * 写入均发生在 APFS 隔离副本和隔离 registry/userData。循环动作覆盖：
 * A↔B↔A 切工程、画布平移/滚动、按需打开受管原图、真实视频/音频推进、
 * renderer bridge 发起并取消扫描、SIGKILL 后恢复活动工程。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, access, chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import sharp from "sharp";
import {
  createManagedProject,
  inspectManagedProjectReadOnly,
} from "../src/core/managed-project.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import {
  assertRedlineProjectSentinelsUnchanged,
  rebindCopiedManagedProjectMetadata,
  snapshotRedlineProjectSentinels,
} from "./lib/redline-project-sentinel-shared.js";
import { readInstalledApplicationReleaseIdentity } from "./p14-installed-runtime-identity-guards.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FORMAL_ROOT = path.join(workspace, "projects", "local-import-dudu-world-prologue-b8bfcf14");
const DEFAULT_MEDIA_UNIT_ID = "unit-local-e61b4628ca1abe8d8752c50d304fdb6e77847b16";

interface ResourceSample {
  at: string;
  elapsedMs: number;
  phase: string;
  cycle: number;
  pids: number[];
  rssKiB: number;
  fileDescriptors: number;
  mediaRequestCount: number;
}

interface PlaybackEvidence {
  readyState: number;
  networkState: number;
  durationSeconds: number;
  startSeconds: number;
  endSeconds: number;
  advanced: boolean;
  paused: boolean;
  errorCode: number | null;
  sourceProtocol: string;
}

interface CycleEvidence {
  cycle: number;
  startedAt: string;
  finishedAt: string;
  projectSwitches: number;
  canvas: {
    panDistancePx: number;
    wheelDeltaY: number;
  };
  original: {
    alt: string;
    naturalWidth: number;
    naturalHeight: number;
    sourceProtocol: string;
  };
  playback: {
    availability: string;
    video: PlaybackEvidence;
    audio: PlaybackEvidence;
  };
  scanCancel: {
    accepted: boolean;
    scanOutcome: string;
    scanError?: string;
    probeStarted: boolean;
    probeTerminated: boolean;
  };
  durationMs: number;
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

function requiredAbsoluteOption(name: string, fallback?: string): string {
  const value = (option(name) ?? fallback ?? "").trim();
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`--${name}=... 必须是绝对路径`);
  }
  return path.normalize(value);
}

function numericOption(name: string, fallback: number): number {
  const raw = option(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name}=... 必须是正数`);
  return value;
}

const executable = requiredAbsoluteOption("executable");
const formalRoot = requiredAbsoluteOption("formal-root", DEFAULT_FORMAL_ROOT);
const durationMs = numericOption("duration-ms", 1_800_000);
const cycleIntervalMs = numericOption("cycle-interval-ms", 60_000);
const allowShort = process.argv.includes("--allow-short");
if (!allowShort && durationMs < 1_800_000) {
  throw new Error("P8 正式 soak 必须至少 30 分钟；仅脚本调试可显式传 --allow-short。");
}
if (durationMs < 10_000) throw new Error("soak 时长至少 10 秒。");
if (cycleIntervalMs < 5_000) throw new Error("主动周期至少 5 秒。");
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const reportPath = requiredAbsoluteOption(
  "report",
  path.join(workspace, "output", "evidence", `p8-packaged-active-soak-${stamp}.json`),
);
const screenshotPath = requiredAbsoluteOption(
  "screenshot",
  path.join(workspace, "output", "playwright", `p8-packaged-active-soak-${stamp}.png`),
);
const mediaUnitId = option("media-unit-id")?.trim() || DEFAULT_MEDIA_UNIT_ID;

for (const outputPath of [reportPath, screenshotPath]) {
  if (await access(outputPath).then(() => true, () => false)) {
    throw new Error(`证据已存在，拒绝覆盖：${outputPath}`);
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
}
await Promise.all([access(executable), access(formalRoot)]);

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function median(values: readonly number[]): number {
  assert(values.length > 0);
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

async function cloneFormalProject(sourceRoot: string, cloneParent: string): Promise<string> {
  await mkdir(cloneParent, { recursive: true });
  const destination = path.join(cloneParent, path.basename(sourceRoot));
  try {
    await execFileAsync("cp", ["-cR", sourceRoot, destination], {
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    await cp(sourceRoot, destination, {
      recursive: true,
      dereference: true,
      preserveTimestamps: true,
      force: false,
      errorOnExist: true,
    });
  }
  const canonical = await realpath(destination);
  await rebindCopiedManagedProjectMetadata(canonical);
  return canonical;
}

async function createLegacyScanCancellationFixture(runtimeRoot: string): Promise<{
  root: string;
  fakeFfprobePath: string;
  startedMarkerPath: string;
  terminatedMarkerPath: string;
}> {
  const root = path.join(runtimeRoot, "legacy-scan-cancellation");
  const shotRoot = path.join(root, "EP99_15s_001_P8取消");
  const fakeFfprobePath = path.join(root, "p8-fake-ffprobe.mjs");
  const startedMarkerPath = path.join(root, "p8-fake-ffprobe-started.log");
  const terminatedMarkerPath = path.join(root, "p8-fake-ffprobe-terminated.log");
  await mkdir(shotRoot, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(shotRoot, "00_信息.md"),
      "P8 隔离扫描取消夹具；不属于受管生产工程。\n",
      "utf8",
    ),
    writeFile(path.join(shotRoot, "EP99_15s_001_取消扫描.mp4"), Buffer.alloc(60_000, 7)),
    writeFile(
      fakeFfprobePath,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(startedMarkerPath)}, String(process.pid) + "\\n");
process.on("SIGTERM", () => {
  appendFileSync(${JSON.stringify(terminatedMarkerPath)}, String(process.pid) + "\\n");
  process.exit(143);
});
setInterval(() => undefined, 1000);
`,
      "utf8",
    ),
  ]);
  await chmod(fakeFfprobePath, 0o755);
  return {
    root: await realpath(root),
    fakeFfprobePath,
    startedMarkerPath,
    terminatedMarkerPath,
  };
}

async function processMetrics(
  rootPid: number,
  mediaRequestCount: number,
  phase: string,
  cycle: number,
  soakStartedAt: number,
): Promise<ResourceSample> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss="]);
  const rows = stdout.split("\n")
    .map((line) => line.trim().split(/\s+/u).map(Number))
    .filter((row) => row.length === 3 && row.every(Number.isFinite)) as Array<[number, number, number]>;
  const descendants = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of rows) {
      if (descendants.has(ppid) && !descendants.has(pid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  const pids = [...descendants].sort((left, right) => left - right);
  const rssKiB = rows
    .filter(([pid]) => descendants.has(pid))
    .reduce((total, [, , rss]) => total + rss, 0);
  let fileDescriptors = 0;
  try {
    const output = await execFileAsync(
      "lsof",
      ["-nP", "-a", "-p", pids.join(",")],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    fileDescriptors = Math.max(0, output.stdout.split("\n").filter(Boolean).length - 1);
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? "";
    fileDescriptors = Math.max(0, stdout.split("\n").filter(Boolean).length - 1);
  }
  return {
    at: new Date().toISOString(),
    elapsedMs: Math.max(0, Date.now() - soakStartedAt),
    phase,
    cycle,
    pids,
    rssKiB,
    fileDescriptors,
    mediaRequestCount,
  };
}

async function waitCanvasReady(page: Page, projectName: string): Promise<void> {
  await page.locator('[data-testid="material-studio-view"]').waitFor({ timeout: 120_000 });
  await page.locator('[data-testid="managed-studio-canvas-view"]').waitFor({ timeout: 120_000 });
  await page.waitForFunction((name) => {
    const view = document.querySelector('[data-testid="managed-studio-canvas-view"]');
    const title = document.querySelector(".studio-header h1")?.textContent ?? "";
    return view?.getAttribute("aria-busy") === "false" && title.includes(String(name));
  }, projectName, { timeout: 120_000 });
}

async function playForProbe(
  page: Page,
  testId: "multimedia-video-player" | "multimedia-audio-player",
): Promise<PlaybackEvidence> {
  const selector = `[data-testid="${testId}"]`;
  const player = page.locator(selector);
  await player.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction((target) => {
    const media = document.querySelector<HTMLMediaElement>(String(target));
    return Boolean(media
      && media.readyState >= HTMLMediaElement.HAVE_METADATA
      && Number.isFinite(media.duration)
      && media.duration > 0);
  }, selector, { timeout: 30_000 });
  return player.evaluate(async (media: HTMLMediaElement) => {
    if (media.duration - media.currentTime < 1.2) media.currentTime = 0;
    const startSeconds = media.currentTime;
    await media.play();
    await new Promise<void>((resolve) => setTimeout(resolve, 850));
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

async function switchProject(page: Page, projectName: string): Promise<void> {
  await page.locator('[data-testid="studio-open-project-center"]').click();
  const row = page.locator(".project-row").filter({ hasText: projectName });
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.click();
  await waitCanvasReady(page, projectName);
}

async function exerciseCanvas(page: Page): Promise<CycleEvidence["canvas"]> {
  await page.locator('[data-testid="studio-mode-canvas"]').click();
  const pane = page.locator(".vue-flow__pane");
  await pane.waitFor({ state: "visible", timeout: 30_000 });
  const box = await pane.boundingBox();
  assert(box && box.width > 300 && box.height > 200, "画布 pane 尺寸异常");
  const startX = box.x + Math.min(box.width - 80, Math.max(100, box.width * 0.58));
  const startY = box.y + Math.min(box.height - 80, Math.max(100, box.height * 0.56));
  const endX = startX - 96;
  const endY = startY + 42;
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(endX, endY, { steps: 6 });
  await page.mouse.up({ button: "middle" });
  await page.mouse.wheel(0, 420);
  await delay(150);
  return {
    panDistancePx: Math.round(Math.hypot(endX - startX, endY - startY)),
    wheelDeltaY: 420,
  };
}

async function openOriginal(page: Page): Promise<CycleEvidence["original"]> {
  await page.locator('[data-testid="studio-step-assets"]').click();
  const entry = page.locator(".material-entry").first();
  await entry.waitFor({ state: "visible", timeout: 30_000 });
  await entry.scrollIntoViewIfNeeded();
  await entry.click();
  const visual = page.locator(".version-visual").first();
  await visual.waitFor({ state: "visible", timeout: 30_000 });
  await visual.click();
  const image = page.locator(".version-preview-dialog img");
  await image.waitFor({ state: "visible", timeout: 30_000 });
  const inspected = await image.evaluate((node: HTMLImageElement) => {
    if (!node.complete || node.naturalWidth <= 0 || node.naturalHeight <= 0) {
      throw new Error("受管原图未完成解码");
    }
    return {
      alt: node.alt,
      naturalWidth: node.naturalWidth,
      naturalHeight: node.naturalHeight,
      sourceProtocol: new URL(node.currentSrc || node.src).protocol,
    };
  });
  assert.equal(inspected.sourceProtocol, "aicanvas-studio:");
  await page.locator('button[aria-label="关闭原图检查"]').click();
  return inspected;
}

async function exercisePlayback(page: Page): Promise<CycleEvidence["playback"]> {
  await page.locator('[data-testid="studio-mode-multimedia-timeline"]').click();
  const view = page.locator('[data-testid="studio-multimedia-timeline-view"]');
  await view.waitFor({ state: "visible", timeout: 60_000 });
  const unit = page.locator(`[data-testid="multimedia-unit-list"] [data-unit-id="${mediaUnitId}"]`);
  await unit.waitFor({ state: "visible", timeout: 60_000 });
  await unit.click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="studio-multimedia-timeline-view"]')
      ?.getAttribute("aria-busy") === "false"
  ), undefined, { timeout: 60_000 });
  const availability = (await page.locator('[data-testid="multimedia-availability"]').innerText())
    .replace(/\s+/gu, " ")
    .trim();
  assert(availability.includes("视频 可用") && availability.includes("音频 可用"), availability);
  const select = page.locator('[data-testid="multimedia-playback-select"]');
  const options = await select.locator("option").evaluateAll((candidates) =>
    candidates.map((candidate) => ({
      value: (candidate as HTMLOptionElement).value,
      label: candidate.textContent?.trim() ?? "",
    })));
  assert.equal(await select.inputValue(), "", "媒体播放器不得默认选择首条正式媒体");
  assert.equal(await page.locator(
    '[data-testid="multimedia-video-player"], [data-testid="multimedia-audio-player"]',
  ).count(), 0, "媒体播放器不得在用户选择前挂载原媒体");
  assert.match(
    (await page.locator('[data-testid="multimedia-playback-empty"]').innerText()).trim(),
    /未选择时不会加载原媒体/u,
  );
  const videoOption = options.find((candidate) => /视频/iu.test(candidate.label)) ?? null;
  const audioOption = (() => {
    return options.find((candidate) => candidate.label.includes("对白"))
      ?? options.find((candidate) => /audio|音频/iu.test(candidate.label))
      ?? null;
  })();
  assert(videoOption, "媒体播放器缺少视频选项");
  assert(audioOption, "媒体播放器缺少音频选项");
  await select.selectOption(videoOption.value);
  const video = await playForProbe(page, "multimedia-video-player");
  assert(video.advanced && video.errorCode === null && video.sourceProtocol === "aicanvas-studio:");
  await select.selectOption(audioOption.value);
  const audio = await playForProbe(page, "multimedia-audio-player");
  assert(audio.advanced && audio.errorCode === null && audio.sourceProtocol === "aicanvas-studio:");
  return { availability, video, audio };
}

async function exerciseScanCancellation(
  page: Page,
  projectRoot: string,
  startedMarkerPath: string,
  terminatedMarkerPath: string,
): Promise<CycleEvidence["scanCancel"]> {
  const markerCount = async (filePath: string) => readFile(filePath, "utf8")
    .then((value) => value.split("\n").filter(Boolean).length, () => 0);
  const startedBefore = await markerCount(startedMarkerPath);
  const terminatedBefore = await markerCount(terminatedMarkerPath);
  await page.evaluate((root) => {
    const api = (window as unknown as {
      canvasApi: {
        scan(projectRoot: string): Promise<unknown>;
      };
      __p8ScanCancellationPromise?: Promise<{ scanOutcome: string; scanError?: string }>;
    });
    api.__p8ScanCancellationPromise = api.canvasApi.scan(root).then(
      () => ({ scanOutcome: "completed" }),
      (error: unknown) => ({
        scanOutcome: "rejected",
        scanError: error instanceof Error ? error.message : String(error),
      }),
    );
  }, projectRoot);
  let probeStarted = false;
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    if (await markerCount(startedMarkerPath) > startedBefore) {
      probeStarted = true;
      break;
    }
    await delay(10);
  }
  assert(probeStarted, "隔离扫描未进入 ffprobe 可取消窗口");
  const result = await page.evaluate(async (root) => {
    const api = (window as unknown as {
      canvasApi: {
        cancelScan(projectRoot: string): Promise<boolean>;
      };
      __p8ScanCancellationPromise?: Promise<{ scanOutcome: string; scanError?: string }>;
    });
    const accepted = await api.canvasApi.cancelScan(root);
    const outcome = await Promise.race([
      api.__p8ScanCancellationPromise
        ?? Promise.resolve({ scanOutcome: "missing-scan-promise" }),
      new Promise<{ scanOutcome: string; scanError?: string }>((resolve) => {
        setTimeout(() => resolve({ scanOutcome: "settlement-timeout-after-cancel" }), 15_000);
      }),
    ]);
    delete api.__p8ScanCancellationPromise;
    return { accepted, ...outcome };
  }, projectRoot);
  let probeTerminated = false;
  for (let attempt = 0; attempt < 1_500; attempt += 1) {
    if (await markerCount(terminatedMarkerPath) > terminatedBefore) {
      probeTerminated = true;
      break;
    }
    await delay(10);
  }
  return { ...result, probeStarted, probeTerminated };
}

async function screenshotEvidence(page: Page, outputPath: string) {
  await page.screenshot({ path: outputPath, fullPage: true });
  const bytes = await readFile(outputPath);
  const [metadata, statistics, file] = await Promise.all([
    sharp(bytes).metadata(),
    sharp(bytes).stats(),
    stat(outputPath),
  ]);
  const maxChannelStandardDeviation = Math.max(
    ...statistics.channels.map((channel) => channel.stdev),
  );
  if ((metadata.width ?? 0) < 1_400
    || (metadata.height ?? 0) < 800
    || file.size < 30_000
    || maxChannelStandardDeviation < 5) {
    throw new Error("P8 soak 截图疑似空白或占位图");
  }
  return {
    relativePath: path.relative(workspace, outputPath).split(path.sep).join("/"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: metadata.width,
    height: metadata.height,
    sizeBytes: file.size,
    maxChannelStandardDeviation,
  };
}

const releaseIdentity = await readInstalledApplicationReleaseIdentity(executable);
const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p8-active-soak-")));
const registryPath = path.join(runtimeRoot, "registry", "projects.json");
const userDataPath = path.join(runtimeRoot, "user-data");
const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
const pageErrors: string[] = [];
const consoleErrors: string[] = [];
const externalRequests: string[] = [];
const cycles: CycleEvidence[] = [];
const samples: ResourceSample[] = [];
let mediaRequestCount = 0;
let application: ElectronApplication | undefined;
let formalSnapshotAfter: Awaited<ReturnType<typeof snapshotRedlineProjectSentinels>> | undefined;
let cloneRoot = "";
let legacyScanRoot = "";
let smallProjectId = "";
let cloneProjectId = "";
let soakStartedAt = 0;
let restartEvidence: Record<string, unknown> | undefined;
let screenshot: Awaited<ReturnType<typeof screenshotEvidence>> | undefined;
let passReportWritten = false;

try {
  const formalSnapshotBefore = await snapshotRedlineProjectSentinels(formalRoot);
  cloneRoot = await cloneFormalProject(formalRoot, path.join(runtimeRoot, "projects"));
  const clone = await inspectManagedProjectReadOnly(cloneRoot);
  const legacyScanFixture = await createLegacyScanCancellationFixture(runtimeRoot);
  legacyScanRoot = legacyScanFixture.root;
  const small = await createManagedProject({
    parentRoot: runtimeRoot,
    name: "P8 A-B-A 隔离切换工程",
    slug: "p8-switch-fixture",
  });
  cloneProjectId = clone.project.id;
  smallProjectId = small.project.id;
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  await mkdir(path.dirname(registryPath), { recursive: true });
  await registerProject(clone.project);
  await registerProject(small.project);
  await setActiveProjectRegistration(clone.paths.root);

  const attachObservers = (page: Page) => {
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("request", (request) => {
      const url = request.url();
      if (/^https?:/iu.test(url)) externalRequests.push(url);
      if (/^aicanvas-studio:/iu.test(url)) mediaRequestCount += 1;
    });
  };
  const launch = async () => {
    const launched = await electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${userDataPath}`],
      cwd: workspace,
      env: {
        ...process.env,
        AI_CANVAS_PROJECT_ROOT: clone.paths.root,
        AI_CANVAS_REGISTRY_PATH: registryPath,
        AI_CANVAS_WINDOW_WIDTH: "1728",
        AI_CANVAS_WINDOW_HEIGHT: "1029",
        FFPROBE_PATH: legacyScanFixture.fakeFfprobePath,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
    });
    const page = await launched.firstWindow();
    page.setDefaultTimeout(120_000);
    await page.setViewportSize({ width: 1728, height: 1029 });
    attachObservers(page);
    return { launched, page };
  };

  let launched = await launch();
  application = launched.launched;
  let page = launched.page;
  await waitCanvasReady(page, clone.project.name);
  soakStartedAt = Date.now();
  samples.push(await processMetrics(
    application.process().pid!,
    mediaRequestCount,
    "initial-ready",
    0,
    soakStartedAt,
  ));

  let cycleNumber = 0;
  while (Date.now() - soakStartedAt < durationMs || cycleNumber === 0) {
    cycleNumber += 1;
    const cycleStartedAt = Date.now();
    await switchProject(page, small.project.name);
    await switchProject(page, clone.project.name);
    const canvas = await exerciseCanvas(page);
    const original = await openOriginal(page);
    const playback = await exercisePlayback(page);
    await page.locator('[data-testid="studio-mode-canvas"]').click();
    await waitCanvasReady(page, clone.project.name);
    const scanCancel = await exerciseScanCancellation(
      page,
      legacyScanFixture.root,
      legacyScanFixture.startedMarkerPath,
      legacyScanFixture.terminatedMarkerPath,
    );
    assert(scanCancel.accepted, "隔离旧工程扫描取消未被接受");
    assert.equal(scanCancel.scanOutcome, "rejected", "取消后的扫描未以拒绝终止");
    assert(scanCancel.probeStarted, "隔离扫描未启动 ffprobe 子进程");
    assert(scanCancel.probeTerminated, "取消后 ffprobe 子进程未终止");
    cycles.push({
      cycle: cycleNumber,
      startedAt: new Date(cycleStartedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      projectSwitches: 2,
      canvas,
      original,
      playback,
      scanCancel,
      durationMs: Date.now() - cycleStartedAt,
    });
    samples.push(await processMetrics(
      application.process().pid!,
      mediaRequestCount,
      "active-cycle",
      cycleNumber,
      soakStartedAt,
    ));
    const elapsed = Date.now() - soakStartedAt;
    process.stdout.write(
      `[P8 soak] cycle=${cycleNumber} elapsed=${Math.round(elapsed / 1000)}s`
        + ` rss=${samples.at(-1)!.rssKiB}KiB fd=${samples.at(-1)!.fileDescriptors}`
        + ` scanCancel=${String(scanCancel.accepted)}\n`,
    );
    if (elapsed >= durationMs) break;
    await delay(Math.min(Math.max(0, cycleIntervalMs - (Date.now() - cycleStartedAt)), durationMs - elapsed));
  }

  const actualDurationMs = Date.now() - soakStartedAt;
  if (!allowShort) {
    assert(actualDurationMs >= 1_800_000, `正式 soak 实际时长不足：${actualDurationMs}`);
  }
  assert(cycles.length >= (allowShort ? 1 : 20), `主动周期不足：${cycles.length}`);
  assert(cycles.some((cycle) => cycle.scanCancel.accepted), "没有任何真实扫描取消被接受");
  assert(cycles.every((cycle) => cycle.playback.video.advanced && cycle.playback.audio.advanced));
  assert(cycles.every((cycle) => cycle.original.naturalWidth > 0 && cycle.original.naturalHeight > 0));

  const activeSamples = samples.filter((sample) => sample.phase === "active-cycle");
  const tailSamples = activeSamples.filter((sample) => sample.elapsedMs >= actualDurationMs * 0.5);
  const tailWindow = tailSamples.length >= 6 ? tailSamples : activeSamples;
  assert(tailWindow.length >= (allowShort ? 1 : 6), "资源尾部样本不足");
  const windowSize = Math.min(3, Math.max(1, Math.floor(tailWindow.length / 2)));
  const headWindow = tailWindow.slice(0, windowSize);
  const endWindow = tailWindow.slice(-windowSize);
  const tailRssStartKiB = median(headWindow.map((sample) => sample.rssKiB));
  const tailRssEndKiB = median(endWindow.map((sample) => sample.rssKiB));
  const tailRssGrowthRatio = (tailRssEndKiB - tailRssStartKiB) / Math.max(1, tailRssStartKiB);
  const tailFdStart = median(headWindow.map((sample) => sample.fileDescriptors));
  const tailFdEnd = median(endWindow.map((sample) => sample.fileDescriptors));
  const tailFdDelta = tailFdEnd - tailFdStart;
  if (!allowShort) {
    assert(tailRssGrowthRatio <= 0.10, `RSS 稳定尾部增长超过 10%：${tailRssGrowthRatio}`);
    assert(tailFdDelta <= 5, `FD 稳定尾部净增长超过 5：${tailFdDelta}`);
  }

  const killedPid = application.process().pid!;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    application!.process().once("exit", (code, signal) => resolve({ code, signal }));
  });
  application.process().kill("SIGKILL");
  const killed = await Promise.race([
    exit,
    delay(15_000).then(() => {
      throw new Error("打包端 SIGKILL 后 15 秒内未退出");
    }),
  ]);
  assert.equal(killed.signal, "SIGKILL");
  await application.close().catch(() => undefined);
  application = undefined;

  launched = await launch();
  application = launched.launched;
  page = launched.page;
  await waitCanvasReady(page, clone.project.name);
  const restoredTitle = (await page.locator(".studio-header h1").innerText()).trim();
  const restoredMetrics = (await page.locator('[data-testid="managed-canvas-metrics"]').innerText())
    .replace(/\s+/gu, " ")
    .trim();
  restartEvidence = {
    killedPid,
    exitCode: killed.code,
    exitSignal: killed.signal,
    reopened: true,
    expectedProjectId: clone.project.id,
    restoredTitle,
    restoredMetrics,
  };
  samples.push(await processMetrics(
    application.process().pid!,
    mediaRequestCount,
    "force-restart-ready",
    cycles.length,
    soakStartedAt,
  ));
  screenshot = await screenshotEvidence(page, screenshotPath);
  await application.close();
  application = undefined;

  formalSnapshotAfter = await assertRedlineProjectSentinelsUnchanged(
    formalRoot,
    formalSnapshotBefore,
  );
  assert.equal(pageErrors.length, 0, `page errors: ${JSON.stringify(pageErrors)}`);
  assert.equal(consoleErrors.length, 0, `console errors: ${JSON.stringify(consoleErrors)}`);
  assert.equal(externalRequests.length, 0, `external requests: ${JSON.stringify(externalRequests)}`);

  const report = {
    schemaVersion: 1,
    kind: "p8-packaged-active-soak",
    status: "PASS",
    generatedAt: new Date().toISOString(),
    buildIdentity: releaseIdentity,
    runtime: {
      executable,
      packaged: true,
      installed: executable.startsWith("/Applications/"),
      isolatedUserData: true,
      isolatedRegistry: true,
      formalProjectOpenedDirectly: false,
    },
    projectIsolation: {
      formalRoot,
      formalProjectMutated: false,
      formalSentinelsBefore: formalSnapshotBefore,
      formalSentinelsAfter: formalSnapshotAfter,
      cloneProjectId,
      smallProjectId,
      legacyScanCancellationFixture: {
        rootWasIsolated: true,
        managedProject: false,
        acceptedCount: cycles.filter((cycle) => cycle.scanCancel.accepted).length,
        fakeProbeTerminationObserved: true,
      },
      cloneRemovedAfterRun: true,
    },
    endurance: {
      requestedDurationMs: durationMs,
      actualDurationMs,
      cycleIntervalMs,
      activeCycleCount: cycles.length,
      projectSwitchCount: cycles.length * 2,
      cycles,
      resourceSamples: samples,
      tailPolicy: "second-half first-3 median vs last-3 median",
      tailRssStartKiB,
      tailRssEndKiB,
      tailRssGrowthRatio,
      tailRssGrowthLimit: 0.10,
      tailFdStart,
      tailFdEnd,
      tailFdDelta,
      tailFdDeltaLimit: 5,
      acceptedScanCancellationCount: cycles.filter((cycle) => cycle.scanCancel.accepted).length,
    },
    errors: { pageErrors, consoleErrors, externalRequests },
    forceRestart: restartEvidence,
    screenshot,
    boundaries: {
      formalGenerationCalls: 0,
      externalProviderCalls: 0,
      browserSupplierCalls: 0,
      uploads: 0,
      publishing: 0,
      gitStage: 0,
    },
  };
  await writeJsonAtomic(reportPath, report);
  passReportWritten = true;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    reportPath,
    screenshotPath,
    actualDurationMs,
    activeCycleCount: cycles.length,
    projectSwitchCount: cycles.length * 2,
    tailRssGrowthRatio,
    tailFdDelta,
  }, null, 2)}\n`);
} catch (error) {
  if (!passReportWritten) {
    await writeJsonAtomic(reportPath, {
      schemaVersion: 1,
      kind: "p8-packaged-active-soak",
      status: "FAIL",
      generatedAt: new Date().toISOString(),
      error: errorMessage(error),
      buildIdentity: releaseIdentity,
      runtime: { executable, packaged: true },
      partial: {
        cloneProjectId,
        smallProjectId,
        legacyScanRoot,
        elapsedMs: soakStartedAt ? Date.now() - soakStartedAt : 0,
        cycles,
        resourceSamples: samples,
        pageErrors,
        consoleErrors,
        externalRequests,
        restartEvidence,
        screenshot,
        formalSnapshotAfter,
      },
      boundaries: {
        formalGenerationCalls: 0,
        externalProviderCalls: 0,
        uploads: 0,
        publishing: 0,
        gitStage: 0,
      },
    }).catch(() => undefined);
  }
  throw error;
} finally {
  await application?.close().catch(() => undefined);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
}
