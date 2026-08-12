import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron } from "playwright";
import sharp from "sharp";
import { getCanvasSemanticState } from "../src/core/canvas-state.js";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  getStudioCanonicalAsset,
  getStudioMedia,
  importStudioMedia,
  listStudioGlobalResourceReuseProvenance,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
} from "../src/core/material-studio.js";
import { activateProject, createManagedStudioProject } from "../src/core/service.js";
import { materializeStudioMediaDerivatives } from "../src/core/studio-media-derivatives.js";
import {
  reuseStudioGlobalResource,
  type ReuseStudioGlobalResourceInput,
} from "../src/core/studio-global-resource-reuse.js";
import { getStudioProductionState } from "../src/core/studio-production.js";
import {
  captureBackgroundElectronStateOrThrow,
  closeElectronApplicationOrThrow,
  forceCleanupElectronApplication,
} from "./lib/electron-application-close.mjs";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = path.resolve(
  process.argv[2]
    || path.join(workspace, "docs", "evidence", "global-resource-center-live-ui-20260728-v1.json"),
);
const screenshotPath = path.resolve(
  process.argv[3]
    || path.join(workspace, "docs", "evidence", "global-resource-center-live-ui-20260728-v1.png"),
);
const evidenceRoot = path.join(workspace, "docs", "evidence");
const releaseManifestPath = path.join(workspace, "release-manifest.json");

interface FileIdentity {
  sha256: string;
  sizeBytes: string;
  mtimeNs: string;
}

interface TreeIdentityEntry extends FileIdentity {
  relativePath: string;
}

interface CharacterFixture {
  assetId: string;
  versionId: string;
  assetRevision: number;
  name: string;
  mediaSha256: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function captureRuntimeStabilitySnapshot(
  application: Awaited<ReturnType<typeof electron.launch>>,
  label: string,
): Promise<{ label: string; snapshot: unknown }> {
  const snapshot = await application.evaluate(() => (
    (globalThis as typeof globalThis & {
      __AI_CANVAS_RUNTIME_STABILITY_SNAPSHOT__?: () => unknown;
    }).__AI_CANVAS_RUNTIME_STABILITY_SNAPSHOT__?.()
  ));
  if (!snapshot) throw new Error(`${label} 缺少 runtime stability probe。`);
  return { label, snapshot };
}

async function measure<T>(action: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const startedAt = performance.now();
  const value = await action();
  return {
    value,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}

async function ensureFreshEvidenceTarget(output: string): Promise<void> {
  const relative = path.relative(evidenceRoot, output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`总资源中心证据必须写入 docs/evidence：${output}`);
  }
  await access(output).then(
    () => { throw new Error(`总资源中心证据已存在，拒绝覆盖：${output}`); },
    () => undefined,
  );
}

async function fileIdentity(filePath: string): Promise<FileIdentity> {
  const [bytes, metadata] = await Promise.all([
    readFile(filePath),
    stat(filePath, { bigint: true }),
  ]);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: metadata.size.toString(),
    mtimeNs: metadata.mtimeNs.toString(),
  };
}

async function treeIdentity(root: string): Promise<TreeIdentityEntry[]> {
  const entries: TreeIdentityEntry[] = [];
  async function visit(current: string): Promise<void> {
    const children = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, child.name);
      if (child.isSymbolicLink()) throw new Error(`验收目录中出现符号链接：${absolute}`);
      if (child.isDirectory()) {
        await visit(absolute);
      } else if (child.isFile()) {
        entries.push({
          relativePath: path.relative(root, absolute).split(path.sep).join("/"),
          ...await fileIdentity(absolute),
        });
      }
    }
  }
  await visit(root);
  return entries;
}

function checkpointDatabase(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function countRowsIfPresent(databasePath: string, table: string): number {
  if (!/^[a-z_]+$/u.test(table)) throw new Error("测试表名无效。");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const present = db.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    if (!present) return 0;
    return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  } finally {
    db.close();
  }
}

async function fixtureImage(filePath: string, index: number): Promise<void> {
  const hue = (index * 37) % 360;
  const label = `总资源人物-${String(index).padStart(2, "0")}`;
  const svg = Buffer.from(`
    <svg width="420" height="560" xmlns="http://www.w3.org/2000/svg">
      <rect width="420" height="560" fill="hsl(${hue} 28% 18%)"/>
      <circle cx="210" cy="180" r="${68 + (index % 7)}" fill="hsl(${hue} 32% 56%)"/>
      <path d="M85 515c10-160 240-160 250 0" fill="hsl(${(hue + 28) % 360} 35% 34%)"/>
      <rect x="24" y="24" width="372" height="512" rx="18" fill="none" stroke="#d8ad56" stroke-width="6"/>
      <text x="210" y="474" text-anchor="middle" fill="#f4ead8" font-size="25" font-family="sans-serif">${label}</text>
    </svg>
  `, "utf8");
  await sharp(svg).png().toFile(filePath);
}

async function createCharacterFixture(
  sourceRoot: string,
  fixtureRoot: string,
  index: number,
): Promise<CharacterFixture> {
  const suffix = String(index).padStart(2, "0");
  const name = `总资源人物-${suffix}`;
  const assetId = `character-global-resource-${suffix}`;
  const imagePath = path.join(fixtureRoot, `${assetId}.png`);
  await fixtureImage(imagePath, index);
  const media = await importStudioMedia(sourceRoot, {
    sourcePath: imagePath,
    kind: "image",
  });
  const created = await createStudioCanonicalAsset(sourceRoot, {
    id: assetId,
    category: "character",
    name,
    aliases: [name],
    identityFeatures: [`fixture 身份 ${suffix}`],
    positiveLocks: ["电影写实"],
    negativeLocks: ["禁止换脸"],
    expectedRevision: 0,
  });
  const appended = await appendStudioAssetVersion(sourceRoot, {
    assetId,
    mediaSha256: media.sha256,
    reviewStatus: "pending",
    sourceNote: "总资源中心 Electron 隔离验收 fixture。",
    expectedRevision: created.revision,
  });
  const reviewed = await reviewStudioAssetVersion(sourceRoot, {
    assetId,
    versionId: appended.version.id,
    decision: "approved",
    note: "隔离 fixture 已完成机械与视觉抽样确认。",
    expectedRevision: appended.assetRevision,
  });
  const promoted = await setStudioPrimaryAuthority(sourceRoot, {
    assetId,
    versionId: appended.version.id,
    expectedRevision: reviewed.revision,
    note: "总资源中心 smoke Primary。",
  });
  return {
    assetId,
    versionId: appended.version.id,
    assetRevision: promoted.revision,
    name,
    mediaSha256: media.sha256,
  };
}

async function createMediaFixtures(fixtureRoot: string): Promise<{
  audioPath: string;
  videoPath: string;
}> {
  const audioPath = path.join(fixtureRoot, "总资源旁白.wav");
  const videoPath = path.join(fixtureRoot, "总资源预告片.mp4");
  await execFileAsync("/opt/homebrew/bin/ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1.2",
    "-c:a",
    "pcm_s16le",
    audioPath,
  ]);
  await execFileAsync("/opt/homebrew/bin/ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x5b452c:s=640x360:d=1.4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:duration=1.4",
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    videoPath,
  ]);
  return { audioPath, videoPath };
}

async function decodedImages(page: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>["firstWindow"]>>): Promise<void> {
  const images = page.locator('[data-testid="global-resource-item"] img');
  for (let index = 0; index < await images.count(); index += 1) {
    const image = images.nth(index);
    await image.scrollIntoViewIfNeeded();
    const result = await image.evaluate(async (element) => {
      const img = element as HTMLImageElement;
      if (!img.complete) {
        await new Promise<void>((resolve, reject) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => reject(new Error(`资源图片加载失败：${img.src}`)), { once: true });
        });
      }
      await img.decode().catch(() => undefined);
      return {
        width: img.naturalWidth,
        height: img.naturalHeight,
        loading: img.loading,
        decoding: img.decoding,
      };
    });
    assert(
      result.width > 0
      && result.height > 0
      && result.loading === "lazy"
      && result.decoding === "async",
      `资源预览没有按 lazy/async 成功解码：${JSON.stringify(result)}`,
    );
  }
}

await Promise.all([
  ensureFreshEvidenceTarget(evidencePath),
  ensureFreshEvidenceTarget(screenshotPath),
]);
await mkdir(evidenceRoot, { recursive: true });

const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "global-resource-center-live-")));
const projectsParent = path.join(temporaryRoot, "projects");
const fixtureRoot = path.join(temporaryRoot, "fixtures");
const registryPath = path.join(temporaryRoot, "runtime", "projects.json");
const isolatedUserData = path.join(temporaryRoot, "electron-user-data");
const temporaryScreenshotPath = path.join(temporaryRoot, "global-resource-center.png");
const temporaryEvidencePath = path.join(temporaryRoot, "global-resource-center.json");
await Promise.all([
  mkdir(projectsParent, { recursive: true }),
  mkdir(fixtureRoot, { recursive: true }),
  mkdir(path.dirname(registryPath), { recursive: true }),
  mkdir(isolatedUserData, { recursive: true }),
]);

const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
let closeEvidence: Awaited<ReturnType<typeof closeElectronApplicationOrThrow>> | undefined;
const backgroundSnapshots: unknown[] = [];
const runtimeStability: Array<{ label: string; snapshot: unknown }> = [];
const actionTimings: Record<string, number> = {};
const domSamples: Array<{ label: string; totalElements: number; cards: number; images: number }> = [];

try {
  const startedAt = performance.now();
  const source = await createManagedStudioProject({
    parentRoot: projectsParent,
    name: "总资源来源项目",
    slug: "global-resource-source",
  });
  const target = await createManagedStudioProject({
    parentRoot: projectsParent,
    name: "总资源调用目标",
    slug: "global-resource-target",
  });
  const characters: CharacterFixture[] = [];
  for (let index = 1; index <= 40; index += 1) {
    characters.push(await createCharacterFixture(source.paths.root, fixtureRoot, index));
  }
  const mediaFixturePaths = await createMediaFixtures(fixtureRoot);
  const audio = await importStudioMedia(source.paths.root, {
    sourcePath: mediaFixturePaths.audioPath,
    kind: "audio",
  });
  const video = await importStudioMedia(source.paths.root, {
    sourcePath: mediaFixturePaths.videoPath,
    kind: "video",
  });
  const [audioDerivatives, videoDerivatives] = await Promise.all([
    materializeStudioMediaDerivatives(source.paths.root, { mediaSha256: audio.sha256 }),
    materializeStudioMediaDerivatives(source.paths.root, { mediaSha256: video.sha256 }),
  ]);
  assert(audioDerivatives.status === "ready", "音频波形 fixture 未能在进入 UI 前 ready。");
  assert(videoDerivatives.status === "ready", "视频 poster/proxy fixture 未能在进入 UI 前 ready。");
  await activateProject(target.paths.root);

  checkpointDatabase(source.paths.materialDatabase);
  checkpointDatabase(target.paths.materialDatabase);
  const sourceDatabaseBefore = await fileIdentity(source.paths.materialDatabase);
  const sourceCasBefore = await treeIdentity(source.paths.mediaCas);
  const sourceDerivativesBefore = [
    ...await treeIdentity(source.paths.mediaPreviews),
    ...await treeIdentity(source.paths.mediaProxies),
    ...await treeIdentity(source.paths.mediaWaveforms),
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const registryBefore = await fileIdentity(registryPath);
  const targetCanvasBefore = await getCanvasSemanticState(target.paths.root);
  const targetProductionBefore = await getStudioProductionState(target.paths.root);
  assert(targetProductionBefore.counts.units === 0, "隔离目标工程初始不应有生产单元。");

  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  const failedStudioMediaRequests: string[] = [];
  app = await electron.launch({
    args: [".", `--user-data-dir=${isolatedUserData}`],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: target.paths.root,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_MANAGED_PROJECTS_ROOT: projectsParent,
      AI_CANVAS_WINDOW_WIDTH: "1720",
      AI_CANVAS_WINDOW_HEIGHT: "1120",
      AI_CANVAS_ELECTRON_BACKGROUND_SMOKE: "1",
      AI_CANVAS_RUNTIME_STABILITY_PROBE: "1",
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(90_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/iu.test(request.url())) externalRequests.push(request.url());
  });
  page.on("requestfailed", (request) => {
    if (request.url().startsWith("aicanvas-studio:")) {
      failedStudioMediaRequests.push(
        `${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`,
      );
    }
  });

  await page.waitForLoadState("domcontentloaded");
  try {
    await page.locator('[data-testid="material-studio-view"]').waitFor({ timeout: 20_000 });
  } catch (error) {
    const bodyText = (await page.locator("body").innerText().catch(() => ""))
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 2_000);
    throw new Error(`Material Studio 未进入可见态；页面文本：${bodyText || "<empty>"}`, {
      cause: error,
    });
  }
  const center = page.locator('[data-testid="global-resource-center-view"]');
  actionTimings.openCenterMs = (await measure(async () => {
    await page.locator('[data-testid="studio-mode-global-resources"]').click();
    await center.waitFor();
  })).durationMs;
  backgroundSnapshots.push(await captureBackgroundElectronStateOrThrow(app, { label: "Global resource center ready" }));
  runtimeStability.push(await captureRuntimeStabilitySnapshot(app, "ready"));
  await center.locator('[data-testid="global-resource-target-project"]')
    .filter({ hasText: target.project.name })
    .waitFor();
  await center.locator('[data-testid="global-resource-summary"]')
    .filter({ hasText: "已读取 2 / 2 个受管项目" })
    .waitFor();
  await center.locator('[data-testid="global-resource-summary"]')
    .filter({ hasText: "共 40 个项目图片条目" })
    .filter({ hasText: "40 个不同图片内容" })
    .waitFor();

  const cards = center.locator('[data-testid="global-resource-item"]');
  await page.waitForFunction(() => (
    document.querySelectorAll('[data-testid="global-resource-item"]').length === 36
  ));
  assert(await cards.count() === 36, "全部图片第一页不是精确 36 项。");
  await center.locator('[data-testid="global-resource-page-indicator"]')
    .filter({ hasText: "本页 36 / 共 40 项" })
    .waitFor();
  await center.locator('[data-testid="global-resource-source-project"]')
    .filter({ hasText: source.project.name })
    .first()
    .waitFor();
  const firstPageKeys = await cards.evaluateAll((items) => items.map((item) => (
    (item as HTMLElement).dataset.resourceKey || ""
  )));
  assert(
    firstPageKeys.length === 36
    && firstPageKeys.every(Boolean)
    && new Set(firstPageKeys).size === 36,
    "全部图片第一页资源键不完整或不唯一。",
  );
  await decodedImages(page);
  domSamples.push(await page.evaluate(() => ({
    label: "image-first-page",
    totalElements: document.querySelectorAll("*").length,
    cards: document.querySelectorAll('[data-testid="global-resource-item"]').length,
    images: document.images.length,
  })));

  actionTimings.nextPageMs = (await measure(async () => {
    await center.locator('[data-testid="global-resource-next"]').click();
    await page.waitForFunction((previousKeys) => {
      const keys = [...document.querySelectorAll<HTMLElement>('[data-testid="global-resource-item"]')]
        .map((item) => item.dataset.resourceKey || "");
      return keys.length === 4 && keys.every((key) => !previousKeys.includes(key));
    }, firstPageKeys);
  })).durationMs;
  const secondPageKeys = await cards.evaluateAll((items) => items.map((item) => (
    (item as HTMLElement).dataset.resourceKey || ""
  )));
  assert(
    secondPageKeys.length === 4
    && secondPageKeys.every((key) => !firstPageKeys.includes(key)),
    "全部图片第二页不是余下 4 项，或与第一页重复。",
  );
  actionTimings.previousPageMs = (await measure(async () => {
    await center.locator('[data-testid="global-resource-prev"]').click();
    await page.waitForFunction((expected) => {
      const keys = [...document.querySelectorAll<HTMLElement>('[data-testid="global-resource-item"]')]
        .map((item) => item.dataset.resourceKey || "");
      return JSON.stringify(keys) === JSON.stringify(expected);
    }, firstPageKeys);
  })).durationMs;

  const resourceSearch = center.locator('[data-testid="global-resource-search"]');
  actionTimings.searchExactMs = (await measure(async () => {
    await resourceSearch.fill(characters[0]!.name);
    await page.waitForFunction(() => (
      document.querySelectorAll('[data-testid="global-resource-item"]').length === 1
    ));
  })).durationMs;
  actionTimings.searchClearMs = (await measure(async () => {
    await resourceSearch.fill("");
    await page.waitForFunction(() => (
      document.querySelectorAll('[data-testid="global-resource-item"]').length === 36
    ));
  })).durationMs;
  runtimeStability.push(await captureRuntimeStabilitySnapshot(app, "after-search-and-pagination"));

  const characterCard = cards.first();
  await characterCard.waitFor();
  const selectedResourceKey = await characterCard.getAttribute("data-resource-key");
  const selectedMediaSha256 = selectedResourceKey?.split(":").at(-1);
  const calledCharacter = characters.find((entry) => entry.mediaSha256 === selectedMediaSha256);
  assert(calledCharacter, "全部图片第一页首项没有对应到来源人物 fixture。");
  const imageCallButton = characterCard.locator(
    '[data-testid="global-resource-use-image-in-project"]',
  );
  await imageCallButton.click();
  await center.locator('[data-testid="global-resource-operation-notice"]')
    .filter({ hasText: "调用到当前项目 CAS" })
    .waitFor();
  await imageCallButton.filter({ hasText: "已调用" }).waitFor();

  const characterCallButton = characterCard.locator(
    '[data-testid="global-resource-use-in-project"]',
  );
  await characterCallButton.click();
  await center.locator('[data-testid="global-resource-operation-notice"]')
    .filter({ hasText: "作为 pending 候选" })
    .waitFor();
  await characterCallButton.filter({ hasText: "已调用，待审核" }).waitFor();

  actionTimings.audioCategoryMs = (await measure(async () => {
    await center.locator('[data-testid="global-resource-tab-audio"]').click();
    await page.waitForFunction(() => (
      document.querySelectorAll('[data-testid="global-resource-item"]').length === 1
    ));
  })).durationMs;
  const audioCard = cards.filter({ hasText: audio.sourceBasename });
  await audioCard.filter({ hasText: "已有波形" }).waitFor();
  await decodedImages(page);
  const audioCallButton = audioCard.locator('[data-testid="global-resource-use-in-project"]');
  await audioCallButton.click();
  await center.locator('[data-testid="global-resource-operation-notice"]')
    .filter({ hasText: "调用到当前项目 CAS" })
    .waitFor();
  await audioCallButton.filter({ hasText: "已调用" }).waitFor();

  actionTimings.videoCategoryMs = (await measure(async () => {
    await center.locator('[data-testid="global-resource-tab-video"]').click();
    await page.waitForFunction(() => (
      document.querySelectorAll('[data-testid="global-resource-item"]').length === 1
    ));
  })).durationMs;
  const videoCard = cards.filter({ hasText: video.sourceBasename });
  await videoCard.filter({ hasText: "已有封面" }).filter({ hasText: "已有轻量视频代理" }).waitFor();
  await decodedImages(page);
  const videoCallButton = videoCard.locator('[data-testid="global-resource-use-in-project"]');
  await videoCallButton.click();
  await center.locator('[data-testid="global-resource-operation-notice"]')
    .filter({ hasText: "调用到当前项目 CAS" })
    .waitFor();
  await videoCallButton.filter({ hasText: "已调用" }).waitFor();
  await page.screenshot({ path: temporaryScreenshotPath, fullPage: true });

  domSamples.push(await page.evaluate(() => ({
    label: "video-category",
    totalElements: document.querySelectorAll("*").length,
    cards: document.querySelectorAll('[data-testid="global-resource-item"]').length,
    images: document.images.length,
  })));
  await page.waitForTimeout(600);
  runtimeStability.push(await captureRuntimeStabilitySnapshot(app, "idle-before-close"));
  backgroundSnapshots.push(await captureBackgroundElectronStateOrThrow(app, { label: "Global resource center before close" }));
  closeEvidence = await closeElectronApplicationOrThrow(app, {
    label: "Global resource center Electron",
    timeoutMs: 20_000,
  });
  app = undefined;

  checkpointDatabase(target.paths.materialDatabase);
  const assetInput: Extract<ReuseStudioGlobalResourceInput, { resourceKind: "asset" }> = {
    resourceKind: "asset",
    sourceProjectRoot: source.paths.root,
    expectedSourceProjectId: source.project.id,
    sourceAssetId: calledCharacter.assetId,
    sourceVersionId: calledCharacter.versionId,
    expectedSourceAssetRevision: calledCharacter.assetRevision,
    targetExpectedRevision: 0,
  };
  const repeatedAsset = await reuseStudioGlobalResource(target.paths.root, assetInput, {
    commandRequestHash: "1".repeat(64),
  });
  assert(
    repeatedAsset.resourceKind === "asset" && repeatedAsset.disposition === "already-imported",
    "UI 人物调用后，Core 未能以 already-imported 找到同一目标资产。",
  );
  const targetAsset = await getStudioCanonicalAsset(
    target.paths.root,
    repeatedAsset.targetAssetId,
  );
  assert(targetAsset?.versions.length === 1, "目标人物资产没有且仅有一个版本。");
  assert(targetAsset.primaryAuthority === undefined, "跨项目人物不应自动成为目标 Primary。");
  assert(
    targetAsset.versions[0]?.reviewStatus === "pending"
    && targetAsset.versions[0]?.mediaSha256 === calledCharacter.mediaSha256,
    "跨项目人物没有以同一 SHA 的 pending 候选进入目标。",
  );

  const targetImage = await getStudioMedia(target.paths.root, calledCharacter.mediaSha256);
  const targetAudio = await getStudioMedia(target.paths.root, audio.sha256);
  const targetVideo = await getStudioMedia(target.paths.root, video.sha256);
  assert(
    targetImage?.kind === "image"
    && targetImage.derivativeStatus === "ready"
    && targetImage.thumbnail,
    "目标 CAS 缺少调用后的图片或 ready 缩略图。",
  );
  assert(targetAudio?.kind === "audio", "目标 CAS 缺少调用后的音频。");
  assert(targetVideo?.kind === "video", "目标 CAS 缺少调用后的视频。");
  const [imageProvenance, audioProvenance, videoProvenance] = await Promise.all([
    listStudioGlobalResourceReuseProvenance(target.paths.root, calledCharacter.mediaSha256),
    listStudioGlobalResourceReuseProvenance(target.paths.root, audio.sha256),
    listStudioGlobalResourceReuseProvenance(target.paths.root, video.sha256),
  ]);
  assert(imageProvenance.length === 1, "目标图片没有且仅有一条结构化来源。");
  assert(audioProvenance.length === 1, "目标音频没有且仅有一条结构化来源。");
  assert(videoProvenance.length === 1, "目标视频没有且仅有一条结构化来源。");
  assert(
    imageProvenance[0]?.sourceProjectId === source.project.id
    && audioProvenance[0]?.sourceProjectId === source.project.id
    && videoProvenance[0]?.sourceProjectId === source.project.id,
    "目标媒体来源没有指回来源项目。",
  );

  checkpointDatabase(target.paths.materialDatabase);
  const targetDatabaseBeforeReplay = await fileIdentity(target.paths.materialDatabase);
  const targetImageBeforeReplay = await fileIdentity(targetImage.objectPath);
  const targetImageThumbnailBeforeReplay = await fileIdentity(targetImage.thumbnail.path);
  const targetAudioBeforeReplay = await fileIdentity(targetAudio.objectPath);
  const targetVideoBeforeReplay = await fileIdentity(targetVideo.objectPath);
  const targetRowsBeforeReplay = {
    media: countRowsIfPresent(target.paths.materialDatabase, "studio_media"),
    provenance: countRowsIfPresent(
      target.paths.materialDatabase,
      "studio_global_resource_reuse_provenance",
    ),
    imageProvenance: countRowsIfPresent(
      target.paths.materialDatabase,
      "studio_global_image_resource_reuse_provenance",
    ),
    ordinaryImports: countRowsIfPresent(target.paths.materialDatabase, "studio_media_imports"),
  };
  const imageReplayHash = imageProvenance[0]?.commandRequestHash === "e".repeat(64)
    ? "f".repeat(64)
    : "e".repeat(64);
  const audioReplayHash = audioProvenance[0]?.commandRequestHash === "a".repeat(64)
    ? "b".repeat(64)
    : "a".repeat(64);
  const videoReplayHash = videoProvenance[0]?.commandRequestHash === "c".repeat(64)
    ? "d".repeat(64)
    : "c".repeat(64);
  const imageReplay = await reuseStudioGlobalResource(target.paths.root, {
    resourceKind: "image",
    sourceProjectRoot: source.paths.root,
    expectedSourceProjectId: source.project.id,
    sourceMediaSha256: calledCharacter.mediaSha256,
    expectedSourceMediaSizeBytes: targetImage.sizeBytes,
    targetExpectedRevision: 0,
  }, { commandRequestHash: imageReplayHash });
  const audioReplay = await reuseStudioGlobalResource(target.paths.root, {
    resourceKind: "audio",
    sourceProjectRoot: source.paths.root,
    expectedSourceProjectId: source.project.id,
    sourceMediaSha256: audio.sha256,
    expectedSourceMediaSizeBytes: audio.sizeBytes,
    targetExpectedRevision: 0,
  }, { commandRequestHash: audioReplayHash });
  const videoReplay = await reuseStudioGlobalResource(target.paths.root, {
    resourceKind: "video",
    sourceProjectRoot: source.paths.root,
    expectedSourceProjectId: source.project.id,
    sourceMediaSha256: video.sha256,
    expectedSourceMediaSizeBytes: video.sizeBytes,
    targetExpectedRevision: 0,
  }, { commandRequestHash: videoReplayHash });
  assert(
    imageReplay.resourceKind === "image" && imageReplay.disposition === "already-present",
    "不同命令哈希的图片重复调用不是 already-present。",
  );
  assert(
    audioReplay.resourceKind === "audio" && audioReplay.disposition === "already-present",
    "不同命令哈希的音频重复调用不是 already-present。",
  );
  assert(
    videoReplay.resourceKind === "video" && videoReplay.disposition === "already-present",
    "不同命令哈希的视频重复调用不是 already-present。",
  );
  assert(
    JSON.stringify(await fileIdentity(target.paths.materialDatabase))
      === JSON.stringify(targetDatabaseBeforeReplay),
    "重复媒体调用改写了目标 Material DB。",
  );
  assert(
    JSON.stringify(await fileIdentity(targetImage.objectPath))
      === JSON.stringify(targetImageBeforeReplay)
    && JSON.stringify(await fileIdentity(targetImage.thumbnail.path))
      === JSON.stringify(targetImageThumbnailBeforeReplay),
    "重复图片调用改写了目标 CAS 或缩略图。",
  );
  assert(
    JSON.stringify(await fileIdentity(targetAudio.objectPath))
      === JSON.stringify(targetAudioBeforeReplay),
    "重复音频调用改写了目标 CAS。",
  );
  assert(
    JSON.stringify(await fileIdentity(targetVideo.objectPath))
      === JSON.stringify(targetVideoBeforeReplay),
    "重复视频调用改写了目标 CAS。",
  );
  assert(
    JSON.stringify({
      media: countRowsIfPresent(target.paths.materialDatabase, "studio_media"),
      provenance: countRowsIfPresent(
        target.paths.materialDatabase,
        "studio_global_resource_reuse_provenance",
      ),
      imageProvenance: countRowsIfPresent(
        target.paths.materialDatabase,
        "studio_global_image_resource_reuse_provenance",
      ),
      ordinaryImports: countRowsIfPresent(target.paths.materialDatabase, "studio_media_imports"),
    }) === JSON.stringify(targetRowsBeforeReplay),
    "重复媒体调用追加了媒体、provenance 或普通导入来源行。",
  );

  const targetCanvasAfter = await getCanvasSemanticState(target.paths.root);
  const targetProductionAfter = await getStudioProductionState(target.paths.root);
  assert(
    JSON.stringify(targetCanvasAfter) === JSON.stringify(targetCanvasBefore),
    "总资源调用修改了目标语义画布。",
  );
  assert(
    targetProductionAfter.counts.units === 0,
    "总资源调用自动建立了生产单元或时间线挂接。",
  );
  assert(
    countRowsIfPresent(target.paths.productionDatabase, "studio_multimedia_timeline_bindings") === 0,
    "总资源调用自动挂接了媒体时间线。",
  );

  assert(
    JSON.stringify(await fileIdentity(source.paths.materialDatabase))
      === JSON.stringify(sourceDatabaseBefore),
    "真实 UI 调用改写了来源 Material Studio DB。",
  );
  assert(
    JSON.stringify(await treeIdentity(source.paths.mediaCas))
      === JSON.stringify(sourceCasBefore),
    "真实 UI 调用改写了来源 CAS。",
  );
  const sourceDerivativesAfter = [
    ...await treeIdentity(source.paths.mediaPreviews),
    ...await treeIdentity(source.paths.mediaProxies),
    ...await treeIdentity(source.paths.mediaWaveforms),
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  assert(
    JSON.stringify(sourceDerivativesAfter) === JSON.stringify(sourceDerivativesBefore),
    "真实 UI 浏览或调用即时生成/改写了来源派生物。",
  );
  assert(
    JSON.stringify(await fileIdentity(registryPath)) === JSON.stringify(registryBefore),
    "真实 UI 浏览或调用改写了隔离项目注册表。",
  );
  assert(pageErrors.length === 0, `Renderer pageerror：${pageErrors.join(" | ")}`);
  assert(externalRequests.length === 0, `总资源 UI 发生外网请求：${externalRequests.join(" | ")}`);
  assert(
    failedStudioMediaRequests.length === 0,
    `总资源媒体协议读取失败：${failedStudioMediaRequests.join(" | ")}`,
  );

  const releaseManifest = JSON.parse(await readFile(releaseManifestPath, "utf8")) as {
    buildId?: string;
    sourceDigest?: string;
    mcpToolCount?: number;
  };
  const evidence = {
    schemaVersion: 1,
    kind: "global-resource-center-live-ui-smoke",
    status: "PASS",
    checkedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - startedAt),
    performance: {
      actionTimings,
      runtimeStability,
      domSamples,
    },
    sourceRuntime: "out Electron build",
    buildIdentity: {
      buildId: releaseManifest.buildId ?? null,
      sourceDigest: releaseManifest.sourceDigest ?? null,
      mcpToolCount: releaseManifest.mcpToolCount ?? null,
    },
    fixture: {
      registeredProjects: 2,
      readableProjects: 2,
      characters: 40,
      audio: 1,
      video: 1,
      audioDerivatives: audioDerivatives.derivatives.map((entry) => entry.kind),
      videoDerivatives: videoDerivatives.derivatives.map((entry) => entry.kind),
    },
    checks: {
      targetProjectNamed: true,
      categories: [
        "all",
        "character",
        "scene",
        "prop",
        "style",
        "storyboard",
        "reference",
        "other",
        "audio",
        "video",
      ],
      imagePagination: { firstPage: 36, secondPage: 4, noDuplicateKeys: true },
      sourceProjectNamed: true,
      lazyPreviewDecode: true,
      imageReuse: {
        disposition: "imported",
        targetSha256: targetImage.sha256,
        thumbnailReady: true,
        provenanceRows: imageProvenance.length,
      },
      assetReuse: {
        disposition: "imported-pending",
        targetReviewStatus: targetAsset.versions[0]?.reviewStatus,
        targetPrimaryAuthority: null,
      },
      audioReuse: {
        disposition: "imported",
        targetSha256: targetAudio.sha256,
        provenanceRows: audioProvenance.length,
      },
      videoReuse: {
        disposition: "imported",
        targetSha256: targetVideo.sha256,
        provenanceRows: videoProvenance.length,
      },
      differentRequestHashReplay: {
        image: imageReplay.disposition,
        audio: audioReplay.disposition,
        video: videoReplay.disposition,
        targetDatabaseUnchanged: true,
        targetCasUnchanged: true,
        targetBusinessRowsUnchanged: true,
      },
      sourceDatabaseUnchanged: true,
      sourceCasUnchanged: true,
      sourceDerivativesUnchanged: true,
      registryUnchanged: true,
      canvasUnchanged: true,
      noTimelineBinding: true,
      pageErrors,
      externalRequests,
      failedStudioMediaRequests,
      backgroundSnapshots,
      closeEvidence,
    },
    screenshotPath: path.relative(workspace, screenshotPath).split(path.sep).join("/"),
  };
  await writeFile(temporaryEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await copyFile(temporaryScreenshotPath, `${screenshotPath}.tmp`);
  await copyFile(temporaryEvidencePath, `${evidencePath}.tmp`);
  await rename(`${screenshotPath}.tmp`, screenshotPath);
  await rename(`${evidencePath}.tmp`, evidencePath);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (app) await forceCleanupElectronApplication(app).catch(() => undefined);
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
  await rm(temporaryRoot, { recursive: true, force: true });
}
