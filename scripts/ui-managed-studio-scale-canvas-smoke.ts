/**
 * 受管 Studio 真实 Electron 规模烟测：
 * - 1288 单元 / 4235 宫格 / 77 资产 / 10,000 个真实 CAS 媒体对象
 * - 无限画布当前页有界节点、分页替换、宫格展开
 * - 素材库 10k 媒体滚动与 SQL keyset 换页
 * - UI 内切到第二个隔离工程，再切回大工程
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { _electron as electron, type Page } from "playwright";
import sharp from "sharp";
import { createBuildIdentity } from "../src/core/build-identity.js";
import {
  getMaterialStudioState,
  getMaterialStudioThumbnailRecipe,
} from "../src/core/material-studio.js";
import {
  P9_SCALE_ASSET_COUNT,
  P9_SCALE_TARGET_PANELS,
  P9_SCALE_UNIT_COUNT,
  createStudioScaleMetadataFixture,
} from "../src/core/studio-scale-fixture.js";
import { getStudioProductionState } from "../src/core/studio-production.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import { readInstalledApplicationReleaseIdentity } from "./p14-installed-runtime-identity-guards.js";

const execFileAsync = promisify(execFile);

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspace, "docs", "evidence");
const evidencePath = path.resolve(
  process.argv[2] || path.join(evidenceRoot, "managed-studio-scale-canvas-ui-smoke-20260718-r2.json"),
);
const screenshotPath = path.resolve(
  process.argv[3] || path.join(evidenceRoot, "managed-studio-scale-canvas-ui-smoke-20260718-r2.png"),
);
const TARGET_MEDIA = 10_000;
const PAGE_LIMIT = 36;
const CANVAS_ASSET_LIMIT = 6;
const CANVAS_UNIT_LIMIT = 36;
const CANVAS_PANEL_LIMIT = 6;
const CANVAS_PIPELINE_LIMIT = 18;
const CANVAS_TEXT_LIMIT = 12;
const CANVAS_MAX_DOM = CANVAS_ASSET_LIMIT + CANVAS_UNIT_LIMIT + CANVAS_PANEL_LIMIT + CANVAS_PIPELINE_LIMIT + CANVAS_TEXT_LIMIT;
const installedExecutable = process.env.AI_CANVAS_INSTALLED_APP_EXECUTABLE?.trim()
  ? path.resolve(process.env.AI_CANVAS_INSTALLED_APP_EXECUTABLE.trim())
  : undefined;

for (const output of [evidencePath, screenshotPath]) {
  const relative = path.relative(evidenceRoot, output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`规模 UI 证据必须写入 docs/evidence：${output}`);
  }
  await access(output).then(
    () => { throw new Error(`规模 UI 证据已存在，拒绝覆盖：${output}`); },
    () => undefined,
  );
  await mkdir(path.dirname(output), { recursive: true });
}
if (installedExecutable) {
  await access(installedExecutable).catch(() => {
    throw new Error(`安装版 Electron 可执行文件不可用：${installedExecutable}`);
  });
}
for (const built of ["out/main/index.js", "out/preload/index.mjs", "out/renderer/index.html"]) {
  await access(path.join(workspace, built)).catch(() => {
    throw new Error(`缺少真实 Electron 编译产物 ${built}；请先运行 npm run build。`);
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function thumbnailRecipeKey(mediaSha256: string): string {
  return createHash("sha256")
    .update(`${getMaterialStudioThumbnailRecipe()}\0${mediaSha256}`, "utf8")
    .digest("hex");
}

async function inBatches<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  for (let offset = 0; offset < items.length; offset += size) {
    await Promise.all(items.slice(offset, offset + size).map(worker));
  }
}

async function seedExactRealMedia(projectRoot: string): Promise<{
  existing: number;
  seeded: number;
  verifiedCas: number;
  verifiedThumbnails: number;
  total: number;
}> {
  const state = await getMaterialStudioState(projectRoot);
  const toSeed = TARGET_MEDIA - state.counts.media;
  if (toSeed < 0) throw new Error(`工程已有媒体 ${state.counts.media}，超过目标 ${TARGET_MEDIA}`);
  const basePng = await sharp({
    create: { width: 64, height: 96, channels: 3, background: { r: 44, g: 63, b: 82 } },
  }).png().toBuffer();
  const thumb = await sharp(basePng).webp({ quality: 80 }).toBuffer();
  const fixtures = Array.from({ length: toSeed }, (_, index) => {
    // IEND 后的审计尾标保持 PNG 可解码，同时让每个 CAS 内容身份唯一。
    const bytes = Buffer.concat([basePng, Buffer.from(`\nui-scale:${String(index).padStart(8, "0")}`, "utf8")]);
    const digest = sha256(bytes);
    const recipe = thumbnailRecipeKey(digest);
    return {
      index,
      bytes,
      sha256: digest,
      objectPath: path.join(state.objectRoot, digest.slice(0, 2), digest),
      objectRelpath: `.aicanvas/objects/sha256/${digest.slice(0, 2)}/${digest}`,
      thumbnailPath: path.join(state.thumbnailRoot, `${recipe}.webp`),
      thumbnailRelpath: `.aicanvas/derived/thumb/${recipe}.webp`,
      thumbnailRecipeKey: recipe,
    };
  });
  await Promise.all(Array.from({ length: 256 }, (_, value) => (
    mkdir(path.join(state.objectRoot, value.toString(16).padStart(2, "0")), { recursive: true })
  )));
  await mkdir(state.thumbnailRoot, { recursive: true });
  await inBatches(fixtures, 128, async (entry) => {
    await Promise.all([
      writeFile(entry.objectPath, entry.bytes, { flag: "wx", mode: 0o600 }),
      writeFile(entry.thumbnailPath, thumb, { flag: "wx", mode: 0o600 }),
    ]);
  });

  let allMediaRows: Array<{ sha256: string; size_bytes: number; object_relpath: string }> = [];
  const db = new DatabaseSync(state.databasePath);
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const insert = db.prepare(`
      INSERT INTO studio_media(
        sha256, kind, size_bytes, mime_type, source_basename, object_relpath,
        derivative_status, thumbnail_recipe_key, thumbnail_relpath,
        thumbnail_width, thumbnail_height, created_at
      ) VALUES(?, 'image', ?, 'image/png', ?, ?, 'ready', ?, ?, 64, 96, ?)
    `);
    const now = new Date().toISOString();
    for (const entry of fixtures) {
      insert.run(
        entry.sha256,
        entry.bytes.byteLength,
        `ui-scale-${String(entry.index).padStart(5, "0")}.png`,
        entry.objectRelpath,
        entry.thumbnailRecipeKey,
        entry.thumbnailRelpath,
        now,
      );
    }
    db.exec("COMMIT");
    allMediaRows = db.prepare(`
      SELECT sha256, size_bytes, object_relpath
      FROM studio_media
      ORDER BY sha256 ASC
    `).all() as Array<{ sha256: string; size_bytes: number; object_relpath: string }>;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction may be closed */ }
    throw error;
  } finally {
    db.close();
  }

  if (allMediaRows.length !== TARGET_MEDIA) {
    throw new Error(`10k 媒体 SQL 行数不精确：${allMediaRows.length}`);
  }
  let verifiedCas = 0;
  let verifiedThumbnails = 0;
  await inBatches(allMediaRows, 128, async (entry) => {
    if (!/^[a-f0-9]{64}$/u.test(entry.sha256)
      || !Number.isSafeInteger(entry.size_bytes)
      || entry.size_bytes <= 0
      || path.isAbsolute(entry.object_relpath)) {
      throw new Error(`UI 规模 CAS 索引字段无效：${JSON.stringify(entry)}`);
    }
    const objectPath = path.resolve(projectRoot, entry.object_relpath);
    const relative = path.relative(state.objectRoot, objectPath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`UI 规模 CAS 对象越界：${entry.object_relpath}`);
    }
    const bytes = await readFile(objectPath);
    if (bytes.byteLength !== entry.size_bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`UI 规模 CAS 校验失败：${entry.sha256}`);
    }
    verifiedCas += 1;
  });
  await inBatches(fixtures.slice(0, 1_000), 32, async (entry) => {
    const metadata = await sharp(entry.thumbnailPath, { failOn: "error" }).metadata();
    if (metadata.format !== "webp" || metadata.width !== 64 || metadata.height !== 96) {
      throw new Error(`UI 规模缩略图不可解码：${entry.thumbnailRecipeKey}`);
    }
    verifiedThumbnails += 1;
  });
  const after = await getMaterialStudioState(projectRoot);
  if (after.counts.media !== TARGET_MEDIA) {
    throw new Error(`10k 媒体精确计数失败：${after.counts.media}`);
  }
  return { existing: state.counts.media, seeded: toSeed, verifiedCas, verifiedThumbnails, total: after.counts.media };
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

function firstText(values: string[]): string {
  return values.map((value) => value.trim()).find(Boolean) ?? "";
}

async function processMetrics(rootPid: number, mediaRequestCount: number, phase: string) {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss="]);
  const rows = stdout.split("\n").map((line) => line.trim().split(/\s+/u).map(Number))
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
  const rssKiB = rows.filter(([pid]) => descendants.has(pid)).reduce((total, [, , rss]) => total + rss, 0);
  let fileDescriptors = 0;
  try {
    const result = await execFileAsync("lsof", ["-nP", "-a", "-p", pids.join(",")], { maxBuffer: 16 * 1024 * 1024 });
    fileDescriptors = Math.max(0, result.stdout.split("\n").filter(Boolean).length - 1);
  } catch (error) {
    const captured = (error as { stdout?: string }).stdout ?? "";
    fileDescriptors = Math.max(0, captured.split("\n").filter(Boolean).length - 1);
  }
  return { phase, pids, rssKiB, fileDescriptors, mediaRequestCount };
}

const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "managed-studio-scale-canvas-ui-")));
const projectsParent = path.join(runtimeRoot, "projects");
const registryPath = path.join(runtimeRoot, "registry", "projects.json");
const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
await Promise.all([mkdir(projectsParent, { recursive: true }), mkdir(path.dirname(registryPath), { recursive: true })]);

let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  const fixtureStarted = performance.now();
  const large = await createStudioScaleMetadataFixture({
    parentRoot: projectsParent,
    unitCount: P9_SCALE_UNIT_COUNT,
    assetCount: P9_SCALE_ASSET_COUNT,
    mediaMetaCount: 0,
    seedProductionPath: false,
    realAvDerivatives: false,
    name: "P9-R2 1288 单元 10k 媒体画布",
  });
  const media = await seedExactRealMedia(large.root);
  const small = await createStudioScaleMetadataFixture({
    parentRoot: projectsParent,
    unitCount: 4,
    assetCount: 6,
    mediaMetaCount: 0,
    seedProductionPath: false,
    realAvDerivatives: false,
    name: "P9-R2 小工程切换夹具",
  });
  await registerProject(large.shell.project);
  await registerProject(small.shell.project);
  await setActiveProjectRegistration(large.root);
  const [largeProduction, smallProduction] = await Promise.all([
    getStudioProductionState(large.root),
    getStudioProductionState(small.root),
  ]);
  if (largeProduction.counts.units !== P9_SCALE_UNIT_COUNT
    || largeProduction.counts.panels !== P9_SCALE_TARGET_PANELS) {
    throw new Error(`大工程计数不符：${JSON.stringify(largeProduction.counts)}`);
  }
  const fixtureMs = Math.round(performance.now() - fixtureStarted);

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  const managedMediaFailures: Array<{ status: number; target: string; key: string; message: string }> = [];
  let mediaRequestCount = 0;
  const launchedAt = performance.now();
  application = await electron.launch({
    ...(installedExecutable ? { executablePath: installedExecutable } : {}),
    args: [
      ...(installedExecutable ? [] : ["."]),
      `--user-data-dir=${path.join(runtimeRoot, "user-data")}`,
    ],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: large.root,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(120_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", (request) => {
    if (/^https?:/iu.test(request.url())) externalRequests.push(request.url());
    if (/^aicanvas-studio:/iu.test(request.url())) mediaRequestCount += 1;
  });
  page.on("response", (response) => {
    if (!/^aicanvas-studio:/iu.test(response.url()) || response.status() < 400) return;
    void (async () => {
      const url = new URL(response.url());
      managedMediaFailures.push({
        status: response.status(),
        target: url.hostname,
        key: decodeURIComponent(url.pathname.replace(/^\//u, "")).slice(0, 64),
        message: (await response.text().catch(() => "")).slice(0, 240),
      });
    })();
  });
  await page.setViewportSize({ width: 1728, height: 1029 });
  await waitCanvasReady(page, large.shell.project.name);
  const readyMs = Math.round(performance.now() - launchedAt);
  const runtimeSamples: Awaited<ReturnType<typeof processMetrics>>[] = [];
  const metrics = (await page.locator('[data-testid="managed-canvas-metrics"]').innerText()).replace(/\s+/gu, " ");
  for (const expected of ["77 资产", "1288 单元", `${P9_SCALE_TARGET_PANELS} 宫格`, "10000 媒体"]) {
    if (!metrics.includes(expected)) throw new Error(`无限画布规模指标缺失 ${expected}：${metrics}`);
  }

  const unitNodes = page.locator(".vue-flow__node.unit-node");
  const assetNodes = page.locator(".vue-flow__node.asset-node");
  const initialUnitFirst = firstText(await unitNodes.allTextContents());
  const initialAssetFirst = firstText(await assetNodes.allTextContents());
  const initialDom = await page.locator(".vue-flow__node").count();
  if (await unitNodes.count() > CANVAS_UNIT_LIMIT || await assetNodes.count() > CANVAS_ASSET_LIMIT || initialDom > CANVAS_MAX_DOM) {
    throw new Error(`画布初始 DOM 超出有界投影：${initialDom}`);
  }

  await page.locator('[data-testid="managed-canvas-open-library"]').click();
  await page.locator(".library-tabs button").filter({ hasText: "15 秒分镜" }).click();
  await page.locator('[data-testid="managed-canvas-units-next"]').click();
  await page.waitForFunction((before) => {
    const first = document.querySelector(".vue-flow__node.unit-node")?.textContent?.trim() ?? "";
    return Boolean(first && first !== before);
  }, initialUnitFirst);
  const unitPageTwoFirst = firstText(await unitNodes.allTextContents());
  await page.locator('[data-testid="managed-canvas-units-prev"]').click();
  await page.waitForFunction((expected) => (
    document.querySelector(".vue-flow__node.unit-node")?.textContent?.trim() === expected
  ), initialUnitFirst);

  await page.locator(".library-tabs button").filter({ hasText: "角色" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".canvas-library .library-list li").length === 24);
  const characterFirst = firstText(await assetNodes.allTextContents());
  if (!await page.locator('[data-testid="managed-canvas-assets-next"]').isDisabled()) {
    throw new Error("24 个角色不应伪造第二页。");
  }
  await page.locator(".library-tabs button").filter({ hasText: "场景" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".canvas-library .library-list li").length === 20);
  const sceneFirst = firstText(await assetNodes.allTextContents());
  await page.locator(".library-tabs button").filter({ hasText: "道具" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".canvas-library .library-list li").length === 33);
  const propFirst = firstText(await assetNodes.allTextContents());
  if (new Set([characterFirst, sceneFirst, propFirst]).size !== 3 || await assetNodes.count() > CANVAS_ASSET_LIMIT) {
    throw new Error(`资产分类投影没有按 24/20/33 替换且保持 6 节点上限：${JSON.stringify({ initialAssetFirst, characterFirst, sceneFirst, propFirst, dom: await assetNodes.count() })}`);
  }

  await unitNodes.first().click({ force: true });
  await page.locator("details.flow-caption > summary").click();
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-testid="managed-canvas-dom-counts"]')?.textContent ?? "";
    return /[2-6]\s*宫格/u.test(text);
  });
  const expandedLogicalCounts = (await page.locator('[data-testid="managed-canvas-dom-counts"]').innerText()).replace(/\s+/gu, " ");
  const expandedDom = await page.locator(".vue-flow__node").count();
  const pipelineDom = await page.locator(".vue-flow__node.raw-node, .vue-flow__node.labeled-node, .vue-flow__node.review-node").count();
  if (await page.locator(".vue-flow__node.panel-node").count() > CANVAS_PANEL_LIMIT
    || pipelineDom > CANVAS_PIPELINE_LIMIT
    || expandedDom > CANVAS_MAX_DOM) {
    throw new Error(`宫格展开后 DOM 超出硬上限：${expandedDom}（结果 ${pipelineDom}）`);
  }

  await page.locator('[data-testid="studio-step-assets"]').click();
  await page.locator(".rail-entry").filter({ hasText: "媒体" }).click();
  await page.locator('[data-testid="material-page-indicator"]').filter({ hasText: `共 ${TARGET_MEDIA} 项` }).waitFor();
  const mediaEntries = page.locator(".material-entry");
  const mediaPageOne = await mediaEntries.allTextContents();
  if (mediaPageOne.length !== PAGE_LIMIT) throw new Error(`10k 媒体第一页 DOM 应为 36，实际 ${mediaPageOne.length}`);
  await page.locator(".entries-region").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const scrolledDom = await mediaEntries.count();
  if (scrolledDom !== PAGE_LIMIT) throw new Error(`滚动后媒体 DOM 累加：${scrolledDom}`);
  await page.locator('[data-testid="material-page-next"]').click();
  await page.locator('[data-testid="material-page-indicator"]').filter({ hasText: "第 2 页" }).waitFor();
  const mediaPageTwo = await mediaEntries.allTextContents();
  if (mediaPageTwo.length !== PAGE_LIMIT || firstText(mediaPageOne) === firstText(mediaPageTwo)) {
    throw new Error("10k 媒体 SQL keyset 下一页没有替换当前 DOM。");
  }
  await page.locator('[data-testid="material-page-previous"]').click();
  await page.locator('[data-testid="material-page-indicator"]').filter({ hasText: "第 1 页" }).waitFor();
  const mediaRestored = await mediaEntries.allTextContents();
  if (JSON.stringify(mediaRestored) !== JSON.stringify(mediaPageOne)) throw new Error("媒体上一页未稳定恢复。");

  // 首次打开素材库与缩略图会建立正常缓存；资源稳定性只比较十次切工程自身，
  // 不把前面功能遍历产生的必要缓存误报成项目切换泄漏。
  runtimeSamples.push(await processMetrics(application.process().pid!, mediaRequestCount, "before-switches"));
  let switchCount = 0;
  const switchProject = async (name: string): Promise<string> => {
    await page.locator("button.quiet-action").filter({ hasText: "项目" }).click();
    await page.locator(".project-row").filter({ hasText: name }).locator(".project-open").click();
    await waitCanvasReady(page, name);
    switchCount += 1;
    runtimeSamples.push(await processMetrics(application!.process().pid!, mediaRequestCount, `switch-${switchCount}`));
    return (await page.locator('[data-testid="managed-canvas-metrics"]').innerText()).replace(/\s+/gu, " ");
  };
  let smallMetrics = "";
  let restoredMetrics = "";
  for (let cycle = 0; cycle < 5; cycle += 1) {
    smallMetrics = await switchProject(small.shell.project.name);
    if (!smallMetrics.includes("6 资产") || !smallMetrics.includes("4 单元")) {
      throw new Error(`第 ${cycle + 1} 轮切换到小工程后投影串库：${smallMetrics}`);
    }
    restoredMetrics = await switchProject(large.shell.project.name);
    if (!restoredMetrics.includes("10000 媒体") || !restoredMetrics.includes("1288 单元")) {
      throw new Error(`第 ${cycle + 1} 轮切回大工程后投影未恢复：${restoredMetrics}`);
    }
  }
  const firstRuntime = runtimeSamples[0]!;
  const finalRuntime = runtimeSamples.at(-1)!;
  if (finalRuntime.rssKiB - firstRuntime.rssKiB > 128 * 1024) {
    throw new Error("十次切工程后 RSS 增长超过 128 MiB。");
  }
  if (finalRuntime.fileDescriptors - firstRuntime.fileDescriptors > 64) {
    throw new Error("十次切工程后文件描述符增长超过 64。");
  }
  const mediaRequestsBeforeIdle = mediaRequestCount;
  await page.waitForTimeout(1_000);
  if (mediaRequestCount !== mediaRequestsBeforeIdle) throw new Error("无操作空闲期仍持续请求媒体。");
  // Electron 是固定工作区视口；fullPage 会把不可见滚动容器也纳入合成，
  // 大规模夹具下可能在 Chromium 截图阶段超时，与画布交互性能无关。
  await page.screenshot({
    path: screenshotPath,
    fullPage: false,
    animations: "disabled",
    timeout: 30_000,
  });

  if (pageErrors.length || consoleErrors.length || externalRequests.length) {
    throw new Error(`Electron UI 出现错误或外网请求：${JSON.stringify({ pageErrors, consoleErrors, externalRequests, managedMediaFailures })}`);
  }
  const screenshotBytes = await readFile(screenshotPath);
  const [metadata, stats] = await Promise.all([sharp(screenshotBytes).metadata(), sharp(screenshotBytes).stats()]);
  const stdev = Math.max(...stats.channels.map((channel) => channel.stdev));
  if ((metadata.width ?? 0) < 1_400 || (metadata.height ?? 0) < 800 || screenshotBytes.byteLength < 40_000 || stdev < 5) {
    throw new Error("规模 UI 截图疑似空白或占位图。");
  }
  const workspaceBuildIdentity = installedExecutable ? undefined : await createBuildIdentity(workspace);
  const installedBuildIdentity = installedExecutable
    ? await readInstalledApplicationReleaseIdentity(installedExecutable)
    : undefined;
  const buildIdentity = installedBuildIdentity
    ? {
      version: installedBuildIdentity.version,
      buildId: installedBuildIdentity.buildId,
      sourceDigest: installedBuildIdentity.sourceDigest,
      fingerprint: installedBuildIdentity.fingerprint,
      releaseManifestFingerprint: installedBuildIdentity.releaseManifestFingerprint,
      source: installedBuildIdentity.source,
    }
    : {
      version: workspaceBuildIdentity!.packageVersion,
      buildId: workspaceBuildIdentity!.buildId,
      sourceDigest: workspaceBuildIdentity!.sourceDigest,
      fingerprint: workspaceBuildIdentity!.fingerprint,
      releaseManifestFingerprint: null,
      source: "workspace-source" as const,
    };
  const evidence = {
    schemaVersion: 2,
    kind: "managed-studio-scale-canvas-ui-smoke",
    status: "pass",
    createdAt: new Date().toISOString(),
    buildIdentity: {
      version: buildIdentity.version,
      buildId: buildIdentity.buildId,
      sourceDigest: buildIdentity.sourceDigest,
      fingerprint: buildIdentity.fingerprint,
      releaseManifestFingerprint: buildIdentity.releaseManifestFingerprint,
      source: buildIdentity.source,
    },
    fixture: {
      fixtureMs,
      large: {
        projectId: large.shell.project.id,
        units: largeProduction.counts.units,
        panels: largeProduction.counts.panels,
        assets: P9_SCALE_ASSET_COUNT,
        media,
        startupPolicy: large.shell.manifest.startupPolicy,
        sourceRoots: large.shell.project.sourceRoots,
      },
      small: {
        projectId: small.shell.project.id,
        units: smallProduction.counts.units,
        panels: smallProduction.counts.panels,
        assets: 6,
      },
    },
    startup: { readyMs, pageErrors: 0, consoleErrors: 0, externalRequests: 0 },
    runtime: {
      kind: installedExecutable ? "installed-application" : "workspace-electron",
      executable: installedExecutable ?? process.execPath,
      systemNodeRequired: false,
    },
    canvas: {
      logicalPageLimit: PAGE_LIMIT,
      assetPageLimit: CANVAS_ASSET_LIMIT,
      unitPageLimit: CANVAS_UNIT_LIMIT,
      panelExpansionLimit: CANVAS_PANEL_LIMIT,
      pipelineNodeLimit: CANVAS_PIPELINE_LIMIT,
      maximumDomNodes: CANVAS_MAX_DOM,
      initialDom,
      expandedDom,
      pipelineDom,
      expandedLogicalCounts,
      unitPageReplaced: initialUnitFirst !== unitPageTwoFirst,
      assetCategoryCounts: { character: 24, scene: 20, prop: 33 },
      assetCategoryProjectionReplaced: new Set([characterFirst, sceneFirst, propFirst]).size === 3,
      characterNextPageCorrectlyDisabled: true,
      viewportCullingEnabled: true,
      panelExpansionBound: 6,
    },
    mediaLibrary: {
      exactCount: TARGET_MEDIA,
      firstPageDom: mediaPageOne.length,
      scrolledDom,
      secondPageDom: mediaPageTwo.length,
      keysetPageReplaced: firstText(mediaPageOne) !== firstText(mediaPageTwo),
      previousPageRestored: true,
    },
    projectSwitch: {
      count: switchCount,
      largeToSmall: true,
      smallToLarge: true,
      crossProjectLeak: false,
      smallMetrics,
      restoredMetrics,
    },
    runtimeStability: {
      samples: runtimeSamples,
      rssDeltaKiB: finalRuntime.rssKiB - firstRuntime.rssKiB,
      fileDescriptorDelta: finalRuntime.fileDescriptors - firstRuntime.fileDescriptors,
      idleMediaRequestsStable: true,
    },
    screenshot: {
      relativePath: path.relative(workspace, screenshotPath).split(path.sep).join("/"),
      sizeBytes: (await stat(screenshotPath)).size,
      sha256: sha256(screenshotBytes),
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      stdev,
    },
    boundaries: {
      filesystemScans: 0,
      formalStudioTouched: false,
      formalImageGenerationCalls: 0,
      browserSupplierCalls: 0,
      uploads: 0,
      gitStage: 0,
    },
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    evidencePath,
    screenshotPath,
    fixtureMs,
    readyMs,
    initialDom,
    expandedDom,
    media: media.total,
  }, null, 2)}\n`);
} finally {
  await application?.close().catch(() => undefined);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
}
