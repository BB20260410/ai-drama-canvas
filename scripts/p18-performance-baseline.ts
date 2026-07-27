/**
 * P18 画布性能与易用性增量 · 三项性能假设实测脚本（只测量，不修改产品行为）
 *
 *  M1：连续缩放 100 次（旧画布 0.62↔0.80 交替 + 亚迟滞细扫；受管画布真实控件点击 100 次），
 *      记录图重建证据（DOM 变更批次）、布局 IPC 次数、帧耗时与长任务。
 *  M2：可见节点实际请求的是缩略图 URL 还是原媒体 URL：请求数、服务字节、解码尺寸、JS 堆。
 *  M3：当前 production build 冷启动：DOMContentLoaded / load / 首次绘制 / 主 chunk 资源 / 可交互。
 *
 * 注入约束（实测得出）：
 *  - 字符串形式 evaluate 被页面 CSP（script-src 'self'）拒绝，必须用函数形式；
 *  - tsx 默认开启 esbuild keep-names，会给一切具名函数注入页面上下文不存在的 __name 辅助符号。
 *    因此本脚本不经 tsx 运行：用 esbuild 打包（默认关闭 keep-names）为 out/p18/p18.mjs 后以 node 运行。
 *
 * 运行方式：npx esbuild scripts/p18-performance-baseline.ts --bundle --format=esm --platform=node \
 *   --target=es2023 --external:sharp --external:playwright --outfile=out/p18/p18.mjs && node out/p18/p18.mjs
 *
 * 证据输出：docs/evidence/p18-performance-baseline-20260719.json（已存在则拒绝覆盖）。
 */
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import sharp from "sharp";
import { scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, registerProject, setActiveProjectRegistration, writeJsonAtomic } from "../src/core/sidecar.js";
import { createStudioP7Fixture } from "../tests/helpers/studio-p7-fixture.js";

const execFileAsync = promisify(execFile);
const workspace = process.cwd();
const tsxBin = path.join(workspace, "node_modules", ".bin", "tsx");
const evidencePath = path.join(workspace, "docs", "evidence", "p18-performance-baseline-20260719.json");

function progress(step: string): void {
  process.stdout.write(`[p18] ${step}\n`);
}

function percentile(sorted: number[], value: number): number {
  if (!sorted.length) return 0;
  return Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0) * 100) / 100;
}

function summarizeTimes(times: number[]): { count: number; p50Ms: number; p95Ms: number; maxMs: number; meanMs: number } {
  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.length ? times.reduce((sum, entry) => sum + entry, 0) / times.length : 0;
  return { count: times.length, p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), maxMs: percentile(sorted, 1), meanMs: Math.round(mean * 100) / 100 };
}

interface ProbeSnapshot {
  ipcCounts: Record<string, number>;
  wrapped: string[];
  wrapFailures: Record<string, string>;
  mutations: { batches: number; addedNodes: number; removedNodes: number };
  longTasks: Array<{ startTime: number; duration: number }>;
  frames: number[];
  heapUsedBytes: number | null;
}

interface MediaInventoryEntry {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  complete: boolean;
  servedBytes: number | null;
}

interface MediaInventory {
  images: MediaInventoryEntry[];
  resources: Array<{ name: string; duration: number; transferSize: number; encodedBodySize: number; decodedBodySize: number }>;
  heapUsedBytes: number | null;
}

interface LaunchOptions {
  registryPath: string;
  projectRoot: string;
  userDataPath: string;
  width?: number;
  height?: number;
}

async function launchApp(options: LaunchOptions): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [".", `--user-data-dir=${options.userDataPath}`],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_REGISTRY_PATH: options.registryPath,
      AI_CANVAS_PROJECT_ROOT: options.projectRoot,
      AI_CANVAS_WINDOW_WIDTH: String(options.width ?? 1560),
      AI_CANVAS_WINDOW_HEIGHT: String(options.height ?? 980),
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(120_000);
  await page.setViewportSize({ width: options.width ?? 1560, height: options.height ?? 980 });
  return { app, page };
}

async function closeApplication(target: ElectronApplication | undefined): Promise<void> {
  if (!target) return;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    target.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      fallbackTimer = setTimeout(() => {
        target.process().kill();
        resolve();
      }, 5_000);
    }),
  ]);
  if (fallbackTimer) clearTimeout(fallbackTimer);
}

/** 在页面内安装测量探针：布局 IPC 包装计数（contextBridge 可能禁止覆盖，如实记录成败）、DOM 变更批次、长任务、帧采样。 */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface WindowProbe {
      ipcCounts: Record<string, number>;
      wrapped: string[];
      wrapFailures: Record<string, string>;
      mutations: { batches: number; addedNodes: number; removedNodes: number };
      longTasks: Array<{ startTime: number; duration: number }>;
      frames: number[];
      heapUsedBytes: number | null;
    }
    const probe: WindowProbe = {
      ipcCounts: {},
      wrapped: [],
      wrapFailures: {},
      mutations: { batches: 0, addedNodes: 0, removedNodes: 0 },
      longTasks: [],
      frames: [],
      heapUsedBytes: null,
    };
    (window as unknown as { __p18: WindowProbe }).__p18 = probe;
    const api = (window as unknown as { canvasApi?: Record<string, unknown> }).canvasApi;
    if (api) {
      for (const name of ["loadLayout", "saveLayout", "loadStudioCanvasLayout", "saveStudioCanvasLayout", "getStudioMedia"]) {
        const original = api[name];
        if (typeof original !== "function") continue;
        try {
          const originalFn = original as (...inner: unknown[]) => unknown;
          function counted(this: unknown, ...args: unknown[]): unknown {
            probe.ipcCounts[name] = (probe.ipcCounts[name] ?? 0) + 1;
            return originalFn.apply(this, args);
          }
          (api as Record<string, unknown>)[name] = counted;
          if (api[name] !== original) probe.wrapped.push(name);
          else probe.wrapFailures[name] = "assignment-not-effective";
        } catch (error) {
          probe.wrapFailures[name] = String(error);
        }
      }
    }
    function countFlowNodes(list: NodeList): number {
      let count = 0;
      for (const node of Array.from(list)) {
        if (node instanceof HTMLElement && node.classList.contains("vue-flow__node")) count += 1;
      }
      return count;
    }
    function onMutation(records: MutationRecord[]): void {
      probe.mutations.batches += 1;
      for (const record of records) {
        probe.mutations.addedNodes += countFlowNodes(record.addedNodes);
        probe.mutations.removedNodes += countFlowNodes(record.removedNodes);
      }
    }
    const viewport = document.querySelector(".vue-flow__viewport");
    if (viewport) new MutationObserver(onMutation).observe(viewport, { childList: true, subtree: true });
    function onLongTask(list: PerformanceObserverEntryList): void {
      for (const entry of list.getEntries()) probe.longTasks.push({ startTime: Math.round(entry.startTime), duration: Math.round(entry.duration) });
    }
    try {
      new PerformanceObserver(onLongTask).observe({ entryTypes: ["longtask"] });
    } catch {
      probe.wrapFailures.longtask = "unsupported";
    }
    let previous = performance.now();
    function sampleFrame(now: number): void {
      probe.frames.push(now - previous);
      previous = now;
      if (probe.frames.length < 20_000) requestAnimationFrame(sampleFrame);
    }
    requestAnimationFrame(sampleFrame);
  });
}

async function probeSnapshot(page: Page): Promise<ProbeSnapshot> {
  return page.evaluate(() => {
    const w = window as unknown as { __p18: ProbeSnapshot };
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return { ...w.__p18, frames: [...w.__p18.frames], longTasks: [...w.__p18.longTasks], heapUsedBytes: memory?.usedJSHeapSize ?? null };
  });
}

async function resetProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __p18: ProbeSnapshot };
    w.__p18.ipcCounts = {};
    w.__p18.mutations = { batches: 0, addedNodes: 0, removedNodes: 0 };
    w.__p18.longTasks = [];
    w.__p18.frames = [];
  });
}

/** 旧画布：通过既有 aiCanvasDiagnostics.setZoom 做缩放扫描，返回每步耗时。 */
async function legacyZoomSweep(page: Page, options: { mode: "coarse" | "fine"; steps: number; from: number; to: number }): Promise<number[]> {
  return page.evaluate(async ({ mode, steps, from, to }) => {
    const diagnostics = (window as unknown as { aiCanvasDiagnostics: { setZoom: (target: number) => Promise<unknown> } }).aiCanvasDiagnostics;
    function waitFrame(): Promise<void> {
      return new Promise((resolve) => {
        function secondFrame(): void {
          resolve();
        }
        function firstFrame(): void {
          requestAnimationFrame(secondFrame);
        }
        requestAnimationFrame(firstFrame);
      });
    }
    const times: number[] = [];
    for (let index = 0; index < steps; index += 1) {
      const target = mode === "coarse" ? (index % 2 === 0 ? to : from) : from + ((to - from) * (index + 1)) / steps;
      const started = performance.now();
      await diagnostics.setZoom(target);
      await waitFrame();
      times.push(Math.round((performance.now() - started) * 100) / 100);
    }
    return times;
  }, options);
}

/** M2：枚举当前文档全部 img 的真实 URL、解码尺寸，并逐一取回服务字节数。 */
async function mediaInventory(page: Page): Promise<MediaInventory> {
  return page.evaluate(async () => {
    const entries: MediaInventoryEntry[] = [];
    for (const img of Array.from(document.querySelectorAll("img"))) {
      const src = img.currentSrc || img.src;
      let servedBytes: number | null = null;
      try {
        const response = await fetch(src);
        servedBytes = (await response.blob()).size;
      } catch {
        servedBytes = null;
      }
      entries.push({ src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, complete: img.complete, servedBytes });
    }
    const resources: MediaInventory["resources"] = [];
    for (const entry of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
      if (!entry.name.startsWith("aicanvas")) continue;
      resources.push({
        name: entry.name,
        duration: Math.round(entry.duration * 100) / 100,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
      });
    }
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return { images: entries, resources, heapUsedBytes: memory?.usedJSHeapSize ?? null };
  });
}

interface ImageDecodeWait {
  ok: boolean;
  pending: Array<{ src: string; complete: boolean; naturalWidth: number }>;
}

async function waitAllImagesDecoded(page: Page, timeoutMs = 30_000): Promise<ImageDecodeWait> {
  try {
    await page.waitForFunction(
      () => {
        const imgs = Array.from(document.querySelectorAll<HTMLImageElement>(".vue-flow__viewport img"));
        return imgs.every((img) => img.complete && img.naturalWidth > 0);
      },
      undefined,
      { timeout: timeoutMs },
    );
    return { ok: true, pending: [] };
  } catch {
    const pending = await page.evaluate(() => {
      const list: Array<{ src: string; complete: boolean; naturalWidth: number }> = [];
      for (const img of Array.from(document.querySelectorAll<HTMLImageElement>(".vue-flow__viewport img"))) {
        if (img.complete && img.naturalWidth > 0) continue;
        list.push({ src: (img.currentSrc || img.src || "").slice(0, 200), complete: img.complete, naturalWidth: img.naturalWidth });
      }
      return list;
    });
    return { ok: false, pending };
  }
}

interface PhaseResult {
  [key: string]: unknown;
}

let temporaryBase = "";
const results: Record<string, PhaseResult> = {};

/* ---------------------------------- Phase A：旧画布 400 单元 · 缩放重建与 IPC 实测（M1-old） ---------------------------------- */
async function phaseA(): Promise<void> {
  progress("A: 创建 400 单元旧工程夹具");
  const runtimeRoot = await realpath(await mkdtemp(path.join(temporaryBase, "ai-canvas-p18-a-")));
  const registryPath = path.join(runtimeRoot, "registry", "projects.json");
  await mkdir(path.dirname(registryPath), { recursive: true });
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  const fixtureRoot = path.join(runtimeRoot, "legacy-400");
  const fixture = await execFileAsync(tsxBin, ["scripts/create-large-fixture.ts", "400", fixtureRoot, "--thumbnails"], {
    cwd: workspace,
    env: { ...process.env },
    maxBuffer: 2_000_000,
  });
  const fixtureResult = JSON.parse(fixture.stdout) as { recognized: number; thumbnails: number };
  if (fixtureResult.recognized !== 400) throw new Error(`Phase A 夹具不完整：${fixture.stdout}`);
  await setActiveProjectRegistration(fixtureRoot);

  progress("A: 启动 Electron");
  const { app, page } = await launchApp({ registryPath, projectRoot: fixtureRoot, userDataPath: path.join(runtimeRoot, "user-data") });
  try {
    await page.waitForFunction(
      () => (window as unknown as { aiCanvasDiagnostics?: { snapshot: () => { logicalProductionNodes: number } } }).aiCanvasDiagnostics?.snapshot().logicalProductionNodes === 400,
      undefined,
      { timeout: 120_000 },
    );
    await installProbe(page);

    progress("A: 粗扫 100 次缩放（0.62↔0.80，每步均越过 0.04 迟滞）");
    await resetProbe(page);
    const coarseTimes = await legacyZoomSweep(page, { mode: "coarse", steps: 100, from: 0.62, to: 0.80 });
    const afterCoarse = await probeSnapshot(page);

    progress("A: 细扫 20 次缩放（0.62→0.80，步长 0.009，低于 0.04 迟滞）");
    await resetProbe(page);
    const fineTimes = await legacyZoomSweep(page, { mode: "fine", steps: 20, from: 0.62, to: 0.80 });
    const afterFine = await probeSnapshot(page);

    progress("A: 媒体清单（小图夹具）");
    const media = await mediaInventory(page);

    results.phaseA = {
      fixture: { units: 400, images: "270×480 PNG ×400（小图）" },
      coarse100: {
        stepTimes: summarizeTimes(coarseTimes),
        ipcCounts: afterCoarse.ipcCounts,
        wrapped: afterCoarse.wrapped,
        wrapFailures: afterCoarse.wrapFailures,
        mutationBatches: afterCoarse.mutations.batches,
        mutationNodesReplaced: afterCoarse.mutations.addedNodes + afterCoarse.mutations.removedNodes,
        longTasks: afterCoarse.longTasks,
        frames: summarizeTimes(afterCoarse.frames.slice(1)),
        heapUsedBytes: afterCoarse.heapUsedBytes,
      },
      fine20SubHysteresis: {
        stepTimes: summarizeTimes(fineTimes),
        ipcCounts: afterFine.ipcCounts,
        mutationBatches: afterFine.mutations.batches,
        mutationNodesReplaced: afterFine.mutations.addedNodes + afterFine.mutations.removedNodes,
        longTasks: afterFine.longTasks,
        frames: summarizeTimes(afterFine.frames.slice(1)),
      },
      media,
    };
  } finally {
    await closeApplication(app);
  }
}

/* ---------------------------------- Phase B：旧画布 40 单元 × 4K 原图 · 节点媒体实测（M2-old） ---------------------------------- */
async function phaseB(): Promise<void> {
  progress("B: 创建 40 单元 × 4K 原图夹具");
  const runtimeRoot = await realpath(await mkdtemp(path.join(temporaryBase, "ai-canvas-p18-b-")));
  const registryPath = path.join(runtimeRoot, "registry", "projects.json");
  await mkdir(path.dirname(registryPath), { recursive: true });
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  const fixtureRoot = path.join(runtimeRoot, "legacy-4k");
  await mkdir(fixtureRoot, { recursive: true });

  const bigPng = await sharp({
    create: { width: 3840, height: 2160, channels: 3, background: "#263442" },
  })
    .composite([{
      input: Buffer.from(
        `<svg width="3840" height="2160" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop stop-color="#91b3c3"/><stop offset="1" stop-color="#152027"/></linearGradient><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".55" numOctaves="3" seed="29"/></filter></defs><rect width="3840" height="2160" fill="url(#g)"/><circle cx="1950" cy="960" r="680" fill="#d7af55" opacity=".24"/><rect width="3840" height="2160" filter="url(#n)" opacity=".08"/></svg>`,
      ),
    }])
    .png({ compressionLevel: 6 })
    .toBuffer();

  for (let index = 0; index < 40; index += 1) {
    const stem = `EP01_15s_${String(index + 1).padStart(3, "0")}`;
    const directory = path.join(fixtureRoot, `${stem}_大图镜头_${String(index + 1).padStart(4, "0")}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "00_信息.md"), `# ${stem}\n首帧提示词：P18 大图实测镜头 ${index + 1}。\n尾帧提示词：保持连续。\n`, "utf8");
    await writeFile(path.join(directory, `${stem}_首帧_raw.png`), bigPng);
    await writeFile(path.join(directory, `${stem}_尾帧_raw.png`), bigPng);
  }

  const config = await ensureSidecar(fixtureRoot);
  config.name = "P18 大图媒体夹具 · 40 单元";
  config.sourceRoots = [];
  config.outputRoots = [fixtureRoot];
  await writeJsonAtomic(getSidecarPaths(fixtureRoot).config, config);
  const index = await scanAndPersist(fixtureRoot);
  if (index.summary.total !== 40) throw new Error(`Phase B 夹具识别异常：${index.summary.total}`);
  await registerProject(config);
  await setActiveProjectRegistration(fixtureRoot);
  const bigPngBytes = bigPng.length;

  progress("B: 启动 Electron");
  const { app, page } = await launchApp({ registryPath, projectRoot: fixtureRoot, userDataPath: path.join(runtimeRoot, "user-data") });
  try {
    await page.waitForFunction(
      () => (window as unknown as { aiCanvasDiagnostics?: { snapshot: () => { logicalProductionNodes: number } } }).aiCanvasDiagnostics?.snapshot().logicalProductionNodes === 40,
      undefined,
      { timeout: 120_000 },
    );
    await installProbe(page);
    const initialDecode = await waitAllImagesDecoded(page, 60_000);
    const initialMedia = await mediaInventory(page);
    const heapBeforeFocus = (await probeSnapshot(page)).heapUsedBytes;

    progress("B: 平移到末尾节点，迫使剔除换入新原图");
    const lastNodeId = await page.evaluate(
      () => (window as unknown as { aiCanvasDiagnostics: { snapshot: () => { productionNodeIds: string[] } } }).aiCanvasDiagnostics.snapshot().productionNodeIds.at(-1) ?? "",
    );
    await resetProbe(page);
    const focusMs = await page.evaluate(async (nodeId) => {
      const diagnostics = (window as unknown as { aiCanvasDiagnostics: { focusNode: (id: string, zoom?: number) => Promise<boolean> } }).aiCanvasDiagnostics;
      const started = performance.now();
      await diagnostics.focusNode(nodeId, 0.62);
      return Math.round((performance.now() - started) * 100) / 100;
    }, lastNodeId);
    const focusDecode = await waitAllImagesDecoded(page, 60_000);
    const afterFocus = await probeSnapshot(page);
    const focusedMedia = await mediaInventory(page);

    results.phaseB = {
      fixture: { units: 40, perUnitImages: "3840×2160 PNG ×2", singlePngBytes: bigPngBytes },
      initialDecode,
      initialMedia,
      focusLastNodeMs: focusMs,
      focusDecode,
      afterFocus: {
        longTasks: afterFocus.longTasks,
        frames: summarizeTimes(afterFocus.frames.slice(1)),
        heapDeltaBytes: (afterFocus.heapUsedBytes ?? 0) - (heapBeforeFocus ?? 0),
      },
      focusedMedia,
    };
  } finally {
    await closeApplication(app);
  }
}

/* ---------------------------------- Phase C：受管画布 · 真实控件缩放 100 次（M1-managed）+ 缩略图清单（M2-managed） ---------------------------------- */
async function phaseC(): Promise<void> {
  progress("C: 创建受管工程夹具");
  const runtimeRoot = await realpath(await mkdtemp(path.join(temporaryBase, "ai-canvas-p18-c-")));
  const registryPath = path.join(runtimeRoot, "registry", "projects.json");
  await mkdir(path.dirname(registryPath), { recursive: true });
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  const fixture = await createStudioP7Fixture();
  await registerProject(fixture.shell.project);
  await setActiveProjectRegistration(fixture.root);

  progress("C: 启动 Electron");
  const { app, page } = await launchApp({ registryPath, projectRoot: fixture.root, userDataPath: path.join(runtimeRoot, "user-data") });
  try {
    await page.locator('[data-testid="managed-studio-canvas-view"]').waitFor();
    await installProbe(page);

    progress("C: 固定一个角色资产到画布（产生缩略图节点）");
    await page.locator('[data-testid="managed-canvas-add-node"]').click();
    const menu = page.locator(".add-menu");
    await menu.locator("button").filter({ hasText: "角色" }).click();
    const row = page.locator(".canvas-library .library-list li").first();
    await row.waitFor();
    await row.locator(".pin-button").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".vue-flow__node.asset-node").length === 1
        && document.querySelector('[data-testid="managed-studio-canvas-view"]')?.getAttribute("aria-busy") === "false",
      undefined,
      { timeout: 20_000 },
    );
    const managedDecode = await waitAllImagesDecoded(page, 60_000);
    const managedMedia = await mediaInventory(page);

    progress("C: 真实控件缩放 100 次（zoomin/zoomout 交替 ×50 对，避免触及缩放上下限）");
    await resetProbe(page);
    const zoomInButton = page.locator(".vue-flow__controls-zoomin");
    const zoomOutButton = page.locator(".vue-flow__controls-zoomout");
    const clickTimes: number[] = [];
    for (let index = 0; index < 50; index += 1) {
      const startedIn = Date.now();
      await zoomInButton.click();
      clickTimes.push(Date.now() - startedIn);
      const startedOut = Date.now();
      await zoomOutButton.click();
      clickTimes.push(Date.now() - startedOut);
    }
    await page.waitForTimeout(700);
    const afterZoom = await probeSnapshot(page);

    results.phaseC = {
      fixture: { root: fixture.root, kind: "studio-p7 受管工程" },
      managedDecode,
      managedMedia,
      zoomClicks100: {
        clickTimes: summarizeTimes(clickTimes),
        ipcCounts: afterZoom.ipcCounts,
        wrapped: afterZoom.wrapped,
        wrapFailures: afterZoom.wrapFailures,
        mutationBatches: afterZoom.mutations.batches,
        mutationNodesReplaced: afterZoom.mutations.addedNodes + afterZoom.mutations.removedNodes,
        longTasks: afterZoom.longTasks,
        frames: summarizeTimes(afterZoom.frames.slice(1)),
        heapUsedBytes: afterZoom.heapUsedBytes,
      },
    };
  } finally {
    await closeApplication(app);
  }
}

/* ---------------------------------- Phase D：当前 production build 冷启动 ×5（M3） ---------------------------------- */
async function phaseD(): Promise<void> {
  progress("D: 冷启动 ×5（旧工程夹具，当前 out/ 构建）");
  const runtimeRoot = await realpath(await mkdtemp(path.join(temporaryBase, "ai-canvas-p18-d-")));
  const registryPath = path.join(runtimeRoot, "registry", "projects.json");
  await mkdir(path.dirname(registryPath), { recursive: true });
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  const fixtureRoot = path.join(runtimeRoot, "legacy-400");
  const fixture = await execFileAsync(tsxBin, ["scripts/create-large-fixture.ts", "400", fixtureRoot, "--thumbnails"], {
    cwd: workspace,
    env: { ...process.env },
    maxBuffer: 2_000_000,
  });
  const fixtureResult = JSON.parse(fixture.stdout) as { recognized: number };
  if (fixtureResult.recognized !== 400) throw new Error(`Phase D 夹具不完整：${fixture.stdout}`);
  await setActiveProjectRegistration(fixtureRoot);

  const runs: Array<Record<string, unknown>> = [];
  for (let run = 1; run <= 5; run += 1) {
    progress(`D: 第 ${run}/5 次冷启动`);
    const startedAt = Date.now();
    const { app, page } = await launchApp({ registryPath, projectRoot: fixtureRoot, userDataPath: path.join(runtimeRoot, `user-data-${run}`) });
    try {
      await page.waitForLoadState("load");
      const wallToLoadMs = Date.now() - startedAt;
      await page.waitForSelector(".topbar-actions button:not([disabled])", { timeout: 60_000 });
      const wallToInteractiveMs = Date.now() - startedAt;
      const timing = await page.evaluate(() => {
        const t = performance.timing;
        const paints: Array<{ name: string; startTime: number }> = [];
        for (const entry of performance.getEntriesByType("paint")) {
          paints.push({ name: entry.name, startTime: Math.round(entry.startTime * 100) / 100 });
        }
        const mainJs: Array<{ name: string; duration: number; transferSize: number; decodedBodySize: number }> = [];
        for (const entry of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
          if (!/\/index-[^/]*\.js$/u.test(entry.name)) continue;
          mainJs.push({
            name: entry.name.split("/").pop() ?? entry.name,
            duration: Math.round(entry.duration * 100) / 100,
            transferSize: entry.transferSize,
            decodedBodySize: entry.decodedBodySize,
          });
        }
        const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        return {
          navToDomContentLoadedMs: t.domContentLoadedEventEnd - t.navigationStart,
          navToLoadMs: t.loadEventEnd - t.navigationStart,
          paints,
          mainJs,
          heapUsedBytes: memory?.usedJSHeapSize ?? null,
        };
      });
      runs.push({ run, wallToLoadMs, wallToInteractiveMs, ...timing });
    } finally {
      await closeApplication(app);
    }
  }
  results.phaseD = {
    note: "当前 out/ 为 19:39 构建，主 chunk 已含异步分包（743,525 B）；1.72MB 整包基线已被该构建覆盖，无法同机回测，此处给出当前构建的绝对值。",
    runs,
  };
}

/* ---------------------------------- 主流程 ---------------------------------- */
async function main(): Promise<void> {
  await access(evidencePath).then(
    () => { throw new Error(`P18 证据已存在，拒绝覆盖：${evidencePath}`); },
    () => undefined,
  );
  temporaryBase = await realpath(os.tmpdir());
  const { computeSourceDigest } = await import("../src/core/build-identity.js");
  await phaseA();
  await phaseB();
  await phaseC();
  await phaseD();
  const liveDigest = await computeSourceDigest(workspace);

  const evidence = {
    kind: "p18-performance-baseline",
    generatedAt: new Date().toISOString(),
    workspace,
    scope: "只测量，不修复；全部在自动清理的隔离夹具与隔离注册表中进行",
    buildState: {
      liveSourceDigest: liveDigest.sourceDigest,
      liveSourceFiles: liveDigest.sourceFiles,
      liveSourceBytes: liveDigest.sourceBytes,
      p17AcceptedSourceDigest: "863db9d19336710ff0bab6b56f35241375b1d2a40c98b798423f008ac9baeae6",
      note: "live 相对 P17 的增量 = large-canvas-ui-smoke 激活修复 + 探针写盘等待 + App.vue 异步分包（未验收中间态）+ 本测量脚本。",
    },
    phases: results,
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  progress(`证据已写入 ${evidencePath}`);
  process.stdout.write(`${JSON.stringify({ evidencePath, ok: true }, null, 2)}\n`);
}

void main();
