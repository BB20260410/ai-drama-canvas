/**
 * T23 第四层门：真实受管工程 Electron UI 只读验证（verify:project-ui）。
 *
 * 分层测试门第四层（前三层：typecheck:app → 核心状态机单测 → MCP 隔离工程纵向链）。
 * 骨架来源：scripts/ui-p30-unit-grid-source-dev-smoke.ts（dev-CDP）、
 * scripts/ui-managed-studio-smoke.ts（构建版 launch）、
 * scripts/p18-performance-baseline.ts（媒体/解码观察手法）、
 * scripts/ui-p13-p14-installed-production-loop-smoke.ts（隔离 userData/registry）。
 *
 * 全程只读：不点击任何写按钮、不触发 execute_command 写命令、不平移/缩放画布
 * （视口移动会触发布局写回）；隔离 userData 与 registry 副本；结束清理隔离目录；
 * 截图与报告 JSON 保留在 evidence/t23/（已存在即拒绝覆盖）。
 *
 * 断言：a 启动直达受管画布 / b 时间线单元与双编号 / c 媒体加载失败=0 /
 * d console error=0（可配置良性忽略）/ e 截图方差防空白 / f 首屏性能软目标 /
 * g 构建身份展示（源码产品硬门）/ h 六项候选只读护栏哨兵 SHA+bytes+mtime 不变。
 *
 * 退出码：0=全部 PASS/SKIP；1=任一 FAIL 或基础设施失败；2=参数/前置校验错误。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import {
  assertBuildArtifacts,
  captureScreenshotEvidence,
  deriveProjectUnitCount,
  isExternalHttp,
  launchBuiltElectron,
  launchDevElectron,
  matchesT23DualUnitLabel,
  parseT23VerifyCli,
  pathExists,
  prepareIsolatedRuntime,
  snapshotT23ReadonlyProjectTree,
  snapshotT23ReadonlySentinels,
  T23_READONLY_SENTINEL_CANDIDATE_PATHS,
  T23_VERIFY_USAGE,
  UsageError,
  verifyT23ReadonlySentinels,
  verifyT23ReadonlyProjectTree,
  type LaunchedUi,
  type ScreenshotEvidence,
  type T23ReadonlySentinelEvidence,
  type T23ReadonlySentinelVerification,
  type T23ReadonlyProjectTreeSnapshot,
  type T23ReadonlyProjectTreeVerification,
  type T23VerifyCliOptions,
} from "./lib/t23-project-ui-verify-shared.js";
import {
  summarizeT23RawVisualDecode,
  type T23RawVisualDecode,
} from "./lib/t23-raw-sha-ui-verify-shared.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultEvidenceDir = path.join(
  workspace,
  "docs",
  "evidence",
  "source-project-ui",
  "layer4",
);

/** 已知良性 console error 子串（大小写不敏感）；可用 --ignore-console 追加。 */
const DEFAULT_CONSOLE_IGNORE_SUBSTRINGS = [
  "Electron Security Warning",
  "DevTools failed to load source map",
  "Download the Vue Devtools",
  "vue-devtools",
];

/** 首屏到首批单元卡渲染耗时软目标（毫秒）：超时只 WARN 不 FAIL，硬门待性能波次。 */
const FIRST_UNIT_NODE_SOFT_BUDGET_MS = 1_500;

type AssertionStatus = "PASS" | "FAIL" | "SKIP";

interface AssertionRecord {
  id: string;
  title: string;
  status: AssertionStatus;
  detail?: string;
  durationMs?: number;
  warnings?: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function validateCliTargets(cli: T23VerifyCliOptions): Promise<void> {
  const projectStat = await pathExists(cli.projectRoot);
  if (!projectStat) throw new UsageError(`受管工程主根不存在：${cli.projectRoot}`);
  const managedMarker = path.join(cli.projectRoot, ".aicanvas", "managed-project.json");
  if (!await pathExists(managedMarker)) {
    throw new UsageError(`目标不是受管工程（缺少 .aicanvas/managed-project.json）：${cli.projectRoot}`);
  }
  if (!await pathExists(cli.sourceRegistryPath)) {
    throw new UsageError(`源注册表不存在：${cli.sourceRegistryPath}（可用 --registry 指定）`);
  }
  if (cli.mode === "build") await assertBuildArtifacts(workspace);
}

interface PageWatchState {
  pageErrors: string[];
  consoleErrors: string[];
  studioMediaRequests: string[];
  mediaFailures: string[];
  externalRequests: string[];
}

function observePage(page: Page, state: PageWatchState): void {
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") state.consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("aicanvas-studio:")) state.studioMediaRequests.push(url);
    if (isExternalHttp(url)) state.externalRequests.push(url);
  });
  page.on("requestfailed", (request) => {
    if (request.url().startsWith("aicanvas-studio:")) {
      state.mediaFailures.push(`${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`);
    }
  });
  page.on("response", (response) => {
    if (response.url().startsWith("aicanvas-studio:") && response.status() >= 400) {
      state.mediaFailures.push(`${response.url()} :: HTTP ${response.status()}`);
    }
  });
}

interface RunContext {
  cli: T23VerifyCliOptions;
  assertions: AssertionRecord[];
  watch: PageWatchState;
  timings: {
    launchToStudioViewMs?: number;
    launchToFirstUnitNodeMs?: number;
  };
  expectedUnits?: number;
  derivedUnits?: number;
  unitDerivationError?: string;
  renderedUnitNodeCount?: number;
  canvasMetricsText?: string;
  screenshot?: ScreenshotEvidence;
  rawVisualDecode?: ReturnType<typeof summarizeT23RawVisualDecode>;
  screenshotPath: string;
  projectName: string;
  projectRoot: string;
}

function record(ctx: RunContext, assertion: AssertionRecord): void {
  ctx.assertions.push(assertion);
  const detail = assertion.detail ? ` — ${assertion.detail}` : "";
  process.stdout.write(`[t23] ${assertion.status} ${assertion.id}${detail}\n`);
}

/** a + b + f：启动直达受管画布、时间线单元与双编号、首屏性能计时。 */
async function assertStartupAndTimeline(ctx: RunContext, page: Page, launchedAt: number): Promise<void> {
  const started = performance.now();
  const unitNodes = page.locator(".vue-flow__node.unit-node");
  try {
    const studioView = page.locator('[data-testid="material-studio-view"]');
    await studioView.waitFor();
    ctx.timings.launchToStudioViewMs = Math.round(performance.now() - launchedAt);
    const canvas = page.locator('[data-testid="managed-studio-canvas-view"]');
    await canvas.waitFor();
    // “首个单元卡”按真实首次可见时刻计时；不能先等全部 overview/资产/文稿
    // 后台加载结束再计，否则测到的是整页沉降时间而不是用户看到首卡的时间。
    await Promise.all([
      unitNodes.first().waitFor().then(() => {
        ctx.timings.launchToFirstUnitNodeMs = Math.round(performance.now() - launchedAt);
      }),
      page.waitForFunction(() => (
        document.querySelector('[data-testid="material-studio-view"]')?.getAttribute("aria-busy") === "false"
        && document.querySelector('[data-testid="managed-studio-canvas-view"]')?.getAttribute("aria-busy") === "false"
      )),
    ]);
    const heading = await page.locator(".studio-header h1").textContent().catch(() => "") ?? "";
    const firstRunCount = await page.locator('[data-testid="first-run-screen"]').count();
    const url = page.url();
    const problems: string[] = [];
    if (firstRunCount !== 0) problems.push("显示了 first-run 首启页而非受管工程");
    if (!heading.includes(ctx.projectName)) problems.push(`工程标题未命中「${ctx.projectName}」（实际：${heading.slice(0, 80)}）`);
    if (url.startsWith("about:") || url.startsWith("chrome-error:")) problems.push(`页面 URL 异常：${url}`);
    record(ctx, {
      id: "a-startup-managed-canvas",
      title: "应用启动后直达受管工程画布（非首启/默认页）",
      status: problems.length ? "FAIL" : "PASS",
      detail: problems.length ? problems.join("；") : `直达「${ctx.projectName}」受管画布，url=${url || "(electron)"}`,
      durationMs: Math.round(performance.now() - started),
    });
  } catch (error) {
    record(ctx, {
      id: "a-startup-managed-canvas",
      title: "应用启动后直达受管工程画布（非首启/默认页）",
      status: "FAIL",
      detail: errorMessage(error),
      durationMs: Math.round(performance.now() - started),
    });
    throw new Error("启动断言失败，后续 UI 断言无意义，提前终止旅程。");
  }

  const timelineStarted = performance.now();
  try {
    await unitNodes.first().waitFor();
    // 双编号是《嘟嘟》等项目的显式项目合同，不是所有受管工程的通用命名规则。
    // 开启硬门时有界等待异步批量投影补齐编号；通用规模工程只验真实单元节点与总数。
    const dualLabelWaitStarted = performance.now();
    let dualLabelHit = false;
    let nodeTexts: string[] = [];
    while (performance.now() - dualLabelWaitStarted < (ctx.cli.requireDualUnitLabel ? 8_000 : 1)) {
      nodeTexts = await unitNodes.allInnerTexts();
      dualLabelHit = nodeTexts.some(matchesT23DualUnitLabel);
      if (dualLabelHit || !ctx.cli.requireDualUnitLabel) break;
      await page.waitForTimeout(250);
    }
    ctx.renderedUnitNodeCount = nodeTexts.length;
    const metricsText = (await page.locator('[data-testid="managed-canvas-metrics"]').innerText())
      .replace(/\s+/gu, " ").trim();
    ctx.canvasMetricsText = metricsText;
    const metricsMatch = metricsText.match(/(\d+)\s*单元/u);

    const problems: string[] = [];
    if (ctx.cli.requireDualUnitLabel && !dualLabelHit) {
      problems.push("有界等待 8s 后仍未命中项目要求的双编号格式 \\d{3}｜S\\d+E\\d+-U\\d+");
    }
    if (ctx.expectedUnits !== undefined) {
      if (!metricsMatch) {
        problems.push(`画布规模指标缺少「N 单元」：${metricsText.slice(0, 120)}`);
      } else if (Number(metricsMatch[1]) !== ctx.expectedUnits) {
        problems.push(`指标单元数 ${metricsMatch[1]} ≠ 期望 ${ctx.expectedUnits}`);
      }
    }
    const countNote = ctx.expectedUnits !== undefined
      ? `指标单元数=${metricsMatch?.[1] ?? "?"}，期望=${ctx.expectedUnits}`
      : `未提供期望单元数（${ctx.unitDerivationError ?? "推导未执行"}），跳过计数比对`;
    record(ctx, {
      id: "b-timeline-units",
      title: ctx.cli.requireDualUnitLabel
        ? "时间线渲染工程单元且双编号至少命中一个"
        : "时间线渲染工程单元",
      status: problems.length ? "FAIL" : "PASS",
      detail: problems.length
        ? `${problems.join("；")}（首屏视口内单元节点 ${nodeTexts.length} 个；注意画布按视口剔除渲染，若工程保存视口不含单元节点会导致本断言失败）`
        : `${countNote}；首屏渲染单元节点 ${nodeTexts.length} 个；${ctx.cli.requireDualUnitLabel ? "双编号命中" : "通用工程未启用双编号硬门"}`,
      durationMs: Math.round(performance.now() - timelineStarted),
    });
  } catch (error) {
    record(ctx, {
      id: "b-timeline-units",
      title: ctx.cli.requireDualUnitLabel
        ? "时间线渲染工程单元且双编号至少命中一个"
        : "时间线渲染工程单元",
      status: "FAIL",
      detail: `${errorMessage(error)}（画布按视口剔除渲染；只读合同禁止移动视口，若保存视口内无单元节点则本断言失败）`,
      durationMs: Math.round(performance.now() - timelineStarted),
    });
  }
}

/** c：等媒体解码沉降后汇总协议失败 / HTTP≥400 / img 解码失败。 */
async function assertMediaLoad(ctx: RunContext, page: Page): Promise<void> {
  const started = performance.now();
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll<HTMLImageElement>('[data-testid="managed-studio-canvas-view"] img'))
      .every((img) => img.complete),
    undefined,
    { timeout: 30_000 },
  ).catch(() => undefined);
  const brokenImages = await page.evaluate(() => {
    const broken: Array<{ src: string; complete: boolean; naturalWidth: number }> = [];
    for (const img of Array.from(document.querySelectorAll<HTMLImageElement>('[data-testid="managed-studio-canvas-view"] img'))) {
      if (img.complete && img.naturalWidth > 0) continue;
      broken.push({ src: (img.currentSrc || img.src || "").slice(0, 200), complete: img.complete, naturalWidth: img.naturalWidth });
    }
    return broken;
  });
  for (const image of brokenImages) {
    ctx.watch.mediaFailures.push(`img 解码失败 ${image.src} :: complete=${image.complete} naturalWidth=${image.naturalWidth}`);
  }
  const uniqueFailures = [...new Set(ctx.watch.mediaFailures)];
  record(ctx, {
    id: "c-media-load",
    title: "媒体加载失败数=0（aicanvas-studio: 协议失败 / HTTP≥400 / img 解码失败）",
    status: uniqueFailures.length ? "FAIL" : "PASS",
    detail: uniqueFailures.length
      ? `${uniqueFailures.length} 项失败：${uniqueFailures.slice(0, 8).join("；")}`
      : `aicanvas-studio 请求 ${ctx.watch.studioMediaRequests.length} 次，失败 0`,
    durationMs: Math.round(performance.now() - started),
  });
}

async function assertAllPassRawImagesDecode(ctx: RunContext, page: Page): Promise<void> {
  const started = performance.now();
  const snapshot = await page.evaluate(`(async () => {
    const verify = window.__aiCanvasManagedStudioVerify;
    if (!verify || typeof verify.getUnitGridRawSnapshot !== "function") {
      return { hookAvailable: false, loading: null, corePassUnitIds: [], visuals: [] };
    }
    let state = verify.getUnitGridRawSnapshot();
    const deadline = Date.now() + 60000;
    while (state.loading && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      state = verify.getUnitGridRawSnapshot();
    }
    const raws = state.raws || [];
    const visuals = [];
    const decodeOne = (raw) => new Promise((resolve) => {
      if (!raw.thumbnailUrl) {
        resolve({
          unitId: raw.unitId,
          status: "SKIP",
          naturalWidth: 0,
          naturalHeight: 0,
          reason: "thumbnail-url-missing"
        });
        return;
      }
      const image = new Image();
      const timeout = window.setTimeout(() => {
        image.src = "";
        resolve({
          unitId: raw.unitId,
          status: "FAIL",
          naturalWidth: 0,
          naturalHeight: 0,
          reason: "decode-timeout",
          url: raw.thumbnailUrl.slice(0, 300)
        });
      }, 15000);
      image.onload = async () => {
        window.clearTimeout(timeout);
        if (typeof image.decode === "function") await image.decode().catch(() => undefined);
        const passed = image.naturalWidth > 0 && image.naturalHeight > 0;
        resolve({
          unitId: raw.unitId,
          status: passed ? "PASS" : "FAIL",
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          ...(passed ? {} : { reason: "natural-size-zero" }),
          url: raw.thumbnailUrl.slice(0, 300)
        });
      };
      image.onerror = () => {
        window.clearTimeout(timeout);
        resolve({
          unitId: raw.unitId,
          status: "FAIL",
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          reason: "image-error",
          url: raw.thumbnailUrl.slice(0, 300)
        });
      };
      image.src = raw.thumbnailUrl;
    });
    for (let offset = 0; offset < raws.length; offset += 4) {
      visuals.push(...await Promise.all(raws.slice(offset, offset + 4).map(decodeOne)));
    }
    return {
      hookAvailable: true,
      loading: state.loading,
      corePassUnitIds: state.corePassUnitIds || [],
      visuals
    };
  })()`) as {
    hookAvailable: boolean;
    loading: boolean | null;
    corePassUnitIds: string[];
    visuals: T23RawVisualDecode[];
  };
  if (!snapshot.hookAvailable) {
    record(ctx, {
      id: "c2-all-pass-raw-decode",
      title: "全部 Core PASS raw 图片实际解码且 naturalWidth>0",
      status: "SKIP",
      detail: "当前运行工件没有只读 raw verify hook，未把可视 DOM 误报为全量覆盖。",
      durationMs: Math.round(performance.now() - started),
    });
    return;
  }
  if (!snapshot.corePassUnitIds.length) {
    record(ctx, {
      id: "c2-all-pass-raw-decode",
      title: "全部 Core PASS raw 图片实际解码且 naturalWidth>0",
      status: "SKIP",
      detail: "当前工程投影没有 Core PASS raw。",
      durationMs: Math.round(performance.now() - started),
    });
    return;
  }
  const summary = summarizeT23RawVisualDecode(snapshot.corePassUnitIds, snapshot.visuals);
  ctx.rawVisualDecode = summary;
  record(ctx, {
    id: "c2-all-pass-raw-decode",
    title: "全部 Core PASS raw 图片实际解码且 naturalWidth>0",
    status: summary.ok && snapshot.loading === false ? "PASS" : "FAIL",
    detail: `PASS ${summary.passed} / FAIL ${summary.failed} / SKIP ${summary.skipped} / missing ${summary.missingUnitIds.length}`,
    durationMs: Math.round(performance.now() - started),
  });
}

/** d：console error=0（忽略内置+用户配置良性子串）；pageerror 恒为 FAIL。 */
function assertConsoleClean(ctx: RunContext, ignores: string[]): string[] {
  const effective = ctx.watch.consoleErrors.filter((text) => (
    !ignores.some((substring) => text.toLowerCase().includes(substring.toLowerCase()))
  ));
  const problems: string[] = [];
  if (effective.length) problems.push(`console error ${effective.length} 条：${effective.slice(0, 6).join("；")}`);
  if (ctx.watch.pageErrors.length) problems.push(`pageerror ${ctx.watch.pageErrors.length} 条：${ctx.watch.pageErrors.slice(0, 4).join("；")}`);
  record(ctx, {
    id: "d-console-clean",
    title: "页面 console error=0（良性名单可配置）且 pageerror=0",
    status: problems.length ? "FAIL" : "PASS",
    detail: problems.length
      ? problems.join("；")
      : `原始 console error ${ctx.watch.consoleErrors.length} 条，忽略 ${ctx.watch.consoleErrors.length - effective.length} 条后 0`,
  });
  return effective;
}

/** e：截图 + sharp 方差防空白。 */
async function assertScreenshot(ctx: RunContext, page: Page): Promise<void> {
  const started = performance.now();
  try {
    ctx.screenshot = await captureScreenshotEvidence(page, ctx.screenshotPath);
    record(ctx, {
      id: "e-screenshot-nonblank",
      title: "截图落盘且 sharp 方差校验防空白",
      status: "PASS",
      detail: `${ctx.screenshot.width}×${ctx.screenshot.height}，${ctx.screenshot.sizeBytes}B，stdev=${ctx.screenshot.maxChannelStandardDeviation.toFixed(2)}`,
      durationMs: Math.round(performance.now() - started),
    });
  } catch (error) {
    record(ctx, {
      id: "e-screenshot-nonblank",
      title: "截图落盘且 sharp 方差校验防空白",
      status: "FAIL",
      detail: errorMessage(error),
      durationMs: Math.round(performance.now() - started),
    });
  }
}

/** f：首屏到首批单元卡渲染耗时（软目标 ≤1.5s，超时 WARN 不 FAIL）。 */
function assertPerformance(ctx: RunContext): string[] {
  const warnings: string[] = [];
  const firstCardMs = ctx.timings.launchToFirstUnitNodeMs;
  if (firstCardMs === undefined) {
    record(ctx, {
      id: "f-perf-first-screen",
      title: `首屏到首批单元卡渲染耗时（软目标 ≤${FIRST_UNIT_NODE_SOFT_BUDGET_MS}ms）`,
      status: "SKIP",
      detail: "单元卡未渲染（见 b-timeline-units），无计时样本。",
    });
    return warnings;
  }
  const over = firstCardMs > FIRST_UNIT_NODE_SOFT_BUDGET_MS;
  if (over) {
    warnings.push(`首屏到首批单元卡 ${firstCardMs}ms 超过软目标 ${FIRST_UNIT_NODE_SOFT_BUDGET_MS}ms（dev 模式含 vite 编译为预期；真实硬门待性能波次）`);
  }
  record(ctx, {
    id: "f-perf-first-screen",
    title: `首屏到首批单元卡渲染耗时（软目标 ≤${FIRST_UNIT_NODE_SOFT_BUDGET_MS}ms，超时 WARN 不 FAIL）`,
    status: "PASS",
    detail: `launch→material-studio-view ${ctx.timings.launchToStudioViewMs ?? "?"}ms；launch→首个单元卡 ${firstCardMs}ms${over ? "（WARN：超软目标）" : ""}`,
    warnings: over ? warnings : undefined,
  });
  return warnings;
}

/** g：等待开发态源码摘要计算完成，并把真实构建身份作为源码产品硬门。 */
async function assertBuildIdentity(ctx: RunContext, page: Page): Promise<void> {
  const selector = '[data-testid*="build-identity"], [data-testid*="build-info"], [data-testid*="app-version"]';
  await page.locator(selector).first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  const probe = await page.evaluate(() => {
    const element = document.querySelector(
      '[data-testid*="build-identity"], [data-testid*="build-info"], [data-testid*="app-version"]',
    );
    const elementText = element?.textContent?.trim();
    if (elementText) return { source: "data-testid", value: elementText.slice(0, 300) };
    const studioText = document.querySelector('[data-testid="material-studio-view"]')?.textContent ?? "";
    const matched = studioText.match(/构建身份[^。\n]{0,120}|构建指纹[^。\n]{0,120}|buildId[::][^\s]{4,80}|sourceDigest[::][^\s]{4,80}/iu);
    return matched ? { source: "text", value: matched[0] } : null;
  }).catch(() => null);
  record(ctx, {
    id: "g-build-identity",
    title: "构建身份/指纹展示读取",
    status: probe ? "PASS" : "FAIL",
    detail: probe
      ? `来源=${probe.source}，值=${probe.value}`
      : "15 秒内未显示 buildId/sourceDigest；源码运行态身份不可追溯。",
  });
}

/** g2：门禁必须完成核验并明确 allowed；checking 不能被截图成“必须重启”。 */
async function assertRuntimeWriteGateReady(ctx: RunContext, page: Page): Promise<void> {
  const canvas = page.locator('[data-testid="managed-studio-canvas-view"]');
  await page.waitForFunction(() => {
    const state = document.querySelector('[data-testid="managed-studio-canvas-view"]')
      ?.getAttribute("data-runtime-write-gate-state");
    return Boolean(state && state !== "checking");
  }, undefined, { timeout: 30_000 }).catch(() => undefined);
  const state = await canvas.getAttribute("data-runtime-write-gate-state");
  const restartBannerVisible = await page.locator('[data-testid="managed-canvas-runtime-restart-banner"]')
    .isVisible()
    .catch(() => false);
  const ok = state === "allowed" && !restartBannerVisible;
  record(ctx, {
    id: "g2-runtime-write-gate",
    title: "源码运行时门禁完成核验且未误报必须重启",
    status: ok ? "PASS" : "FAIL",
    detail: ok
      ? "data-runtime-write-gate-state=allowed；重启横幅不可见"
      : `state=${state ?? "missing"}；restartBannerVisible=${String(restartBannerVisible)}`,
  });
}

/** i：真实切换到四媒体时间线，核验剧本/图片/视频/音频四轨后返回画布。 */
async function assertMultimediaTimeline(ctx: RunContext, page: Page): Promise<void> {
  const started = performance.now();
  const problems: string[] = [];
  let availability = "";
  try {
    const timelineButton = page.locator('[data-testid="studio-mode-multimedia-timeline"]');
    await timelineButton.waitFor({ state: "visible", timeout: 15_000 });
    await timelineButton.click();
    const timelineView = page.locator('[data-testid="studio-multimedia-timeline-view"]');
    await timelineView.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="studio-multimedia-timeline-view"]')?.getAttribute("aria-busy") === "false"
    ), undefined, { timeout: 30_000 });
    for (const track of ["script", "image", "video", "audio"]) {
      const visible = await page.locator(`[data-testid="multimedia-${track}-track"]`).isVisible().catch(() => false);
      if (!visible) problems.push(`${track} 轨未显示`);
    }
    if (await page.locator('[data-testid="multimedia-timeline-error"]').isVisible().catch(() => false)) {
      problems.push(`时间线错误：${(await page.locator('[data-testid="multimedia-timeline-error"]').innerText()).slice(0, 160)}`);
    }
    if (!await page.locator('[data-testid="multimedia-unit-heading"]').isVisible().catch(() => false)) {
      problems.push("未投影当前单元标题");
    }
    availability = (await page.locator('[data-testid="multimedia-availability"]').innerText().catch(() => ""))
      .replace(/\s+/gu, " ").trim();
  } catch (error) {
    problems.push(errorMessage(error));
  } finally {
    try {
      await page.locator('[data-testid="studio-mode-canvas"]').click();
      await page.locator('[data-testid="managed-studio-canvas-view"]').waitFor({ state: "visible", timeout: 30_000 });
      await page.locator(".vue-flow__node.unit-node").first().waitFor({ state: "visible", timeout: 30_000 });
    } catch (error) {
      problems.push(`返回画布失败：${errorMessage(error)}`);
    }
  }
  record(ctx, {
    id: "i-multimedia-timeline",
    title: "四媒体时间线真实界面可读取并可返回画布",
    status: problems.length ? "FAIL" : "PASS",
    detail: problems.length ? problems.join("；") : `剧本/图片/视频/音频四轨可见；${availability || "可用性状态已投影"}`,
    durationMs: Math.round(performance.now() - started),
  });
}

/** h：只读护栏逐项复核（应用关闭后执行）。 */
async function assertReadonlyGuard(
  ctx: RunContext,
  before: T23ReadonlySentinelEvidence[],
): Promise<T23ReadonlySentinelVerification | undefined> {
  try {
    const verification = await verifyT23ReadonlySentinels(ctx.projectRoot, before);
    const problems = verification.items
      .filter((item) => item.status === "FAIL")
      .map((item) => `${item.relativePath} ${item.changedFields.join("+")} 变化`);
    const compared = verification.items.map((item) => (
      `${item.relativePath}[sha256=${item.before.sha256.slice(0, 12)}…,bytes=${item.before.bytes},mtimeMs=${item.before.mtimeMs}]`
    ));
    if (!verification.items.length) problems.push("六项候选哨兵在启动前均不存在，无法证明正式工程零写入");
    record(ctx, {
      id: "h-readonly-guard",
      title: "只读护栏：存在的六项候选工程哨兵 SHA-256、bytes、mtime 全程不变",
      status: verification.ok ? "PASS" : "FAIL",
      detail: problems.length
        ? problems.join("；")
        : `逐项复核 ${compared.join("；")}；mtime 精度=${verification.mtimePrecision}`,
    });
    return verification;
  } catch (error) {
    record(ctx, {
      id: "h-readonly-guard",
      title: "只读护栏：存在的六项候选工程哨兵 SHA-256、bytes、mtime 全程不变",
      status: "FAIL",
      detail: `哨兵复核执行失败：${errorMessage(error)}`,
    });
    return undefined;
  }
}

async function assertReadonlyProjectTreeGuard(
  ctx: RunContext,
  before: T23ReadonlyProjectTreeSnapshot,
): Promise<T23ReadonlyProjectTreeVerification | undefined> {
  try {
    const verification = await verifyT23ReadonlyProjectTree(ctx.projectRoot, before);
    record(ctx, {
      id: "h2-readonly-full-tree",
      title: "只读护栏：正式工程全树元数据与关键数据库内容 SHA 不变",
      status: verification.ok ? "PASS" : "FAIL",
      detail: verification.ok
        ? `${verification.afterEntryCount} 项全树节点未变化`
        : `变化 ${verification.changedPaths.length} 项；关键内容变化 ${verification.criticalContentChangedPaths.join("、") || "无"}`,
    });
    return verification;
  } catch (error) {
    record(ctx, {
      id: "h2-readonly-full-tree",
      title: "只读护栏：正式工程全树元数据与关键数据库内容 SHA 不变",
      status: "FAIL",
      detail: `全树复核执行失败：${errorMessage(error)}`,
    });
    return undefined;
  }
}

interface T23Report {
  schemaVersion: 1;
  kind: "t23-layer4-project-ui-verify";
  createdAt: string;
  ok: boolean;
  mode: "dev" | "build";
  project: { id: string; name: string; root: string };
  expectations: {
    expectUnits?: number;
    derivedUnits?: number;
    unitDerivationError?: string;
  };
  timings: {
    launchToStudioViewMs?: number;
    launchToFirstUnitNodeMs?: number;
    totalMs?: number;
    firstUnitNodeSoftBudgetMs: number;
  };
  assertions: AssertionRecord[];
  media: { studioRequests: number; failures: string[] };
  console: { rawErrors: string[]; ignoredErrors: string[]; effectiveErrors: string[]; pageErrors: string[] };
  network: { externalRequests: string[] };
  screenshot?: ScreenshotEvidence & { path: string };
  readonlySentinels: T23ReadonlySentinelVerification | {
    ok: false;
    candidateRelativePaths: string[];
    includedExistingCount: number;
    mtimePrecision: "integer-millisecond";
    items: [];
    error: string;
  };
  readonlyProjectTree?: T23ReadonlyProjectTreeVerification;
  warnings: string[];
  boundaries: Record<string, unknown>;
}

async function main(): Promise<number> {
  let cli: T23VerifyCliOptions;
  try {
    cli = parseT23VerifyCli(process.argv.slice(2), defaultEvidenceDir);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${T23_VERIFY_USAGE}\n`);
      return 2;
    }
    throw error;
  }
  if (cli.help) {
    process.stdout.write(`${T23_VERIFY_USAGE}\n`);
    return 0;
  }
  try {
    await validateCliTargets(cli);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const startedAt = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const reportPath = path.join(cli.evidenceDir, `t23-layer4-${cli.mode}-${timestamp}.json`);
  const screenshotPath = path.join(cli.evidenceDir, `t23-layer4-${cli.mode}-${timestamp}.png`);
  // 截图发生在报告写入之前；必须预先创建证据目录，避免首跑因 ENOENT 失败。
  await mkdir(cli.evidenceDir, { recursive: true });
  for (const output of [reportPath, screenshotPath]) {
    if (await pathExists(output)) {
      process.stderr.write(`证据路径已存在，拒绝覆盖：${output}\n`);
      return 2;
    }
  }

  const watch: PageWatchState = {
    pageErrors: [],
    consoleErrors: [],
    studioMediaRequests: [],
    mediaFailures: [],
    externalRequests: [],
  };
  const ctx: RunContext = {
    cli,
    assertions: [],
    watch,
    timings: {},
    screenshotPath,
    projectName: "",
    projectRoot: cli.projectRoot,
  };
  const warnings: string[] = [];
  let effectiveConsoleErrors: string[] = [];
  let sentinelBefore: T23ReadonlySentinelEvidence[] = [];
  let sentinelVerification: T23ReadonlySentinelVerification | undefined;
  let treeBefore: T23ReadonlyProjectTreeSnapshot;
  let treeVerification: T23ReadonlyProjectTreeVerification | undefined;
  const devLogTail: string[] = [];

  try {
    treeBefore = await snapshotT23ReadonlyProjectTree(cli.projectRoot);
  } catch (error) {
    process.stderr.write(`正式工程全树只读快照失败：${errorMessage(error)}\n`);
    return 2;
  }
  let isolated: Awaited<ReturnType<typeof prepareIsolatedRuntime>>;
  try {
    isolated = await prepareIsolatedRuntime({
      projectRoot: cli.projectRoot,
      sourceRegistryPath: cli.sourceRegistryPath,
      copyProject: true,
    });
  } catch (error) {
    process.stderr.write(`前置校验失败：${errorMessage(error)}\n`);
    return 2;
  }
  ctx.projectName = isolated.project.name;

  let launched: LaunchedUi | undefined;
  let flowSettled = false;
  let flowError: unknown;
  let timedOut = false;

  const flow = (async () => {
    // 工程单元数：--expect-units 优先；否则复制 sqlite 副本只读推导。
    if (cli.expectUnits !== undefined) {
      ctx.expectedUnits = cli.expectUnits;
    } else {
      try {
        ctx.derivedUnits = await deriveProjectUnitCount(isolated.project.primaryRoot, isolated.runtimeRoot);
        ctx.expectedUnits = ctx.derivedUnits;
      } catch (error) {
        ctx.unitDerivationError = `工程单元数推导失败：${errorMessage(error)}`;
      }
    }
    sentinelBefore = await snapshotT23ReadonlySentinels(cli.projectRoot);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: isolated.project.primaryRoot,
      AI_CANVAS_REGISTRY_PATH: isolated.registryPath,
      AI_CANVAS_MANAGED_PROJECTS_ROOT: isolated.managedProjectsRoot,
      AI_CANVAS_MEDIA_RUNTIME_DIR: isolated.mediaRuntimeRoot,
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    };
    const launchedAt = performance.now();
    if (cli.mode === "dev") {
      launched = await launchDevElectron({ workspace, userDataRoot: isolated.userDataRoot, env, logTail: devLogTail });
    } else {
      launched = await launchBuiltElectron({ workspace, userDataRoot: isolated.userDataRoot, env });
    }
    const { page } = launched;
    observePage(page, watch);

    await assertStartupAndTimeline(ctx, page, launchedAt);
    await assertMediaLoad(ctx, page);
    await assertAllPassRawImagesDecode(ctx, page);
    await assertBuildIdentity(ctx, page);
    await assertRuntimeWriteGateReady(ctx, page);
    await assertMultimediaTimeline(ctx, page);
    await assertScreenshot(ctx, page);
    warnings.push(...assertPerformance(ctx));
  })().then(
    () => { flowSettled = true; },
    (error: unknown) => { flowSettled = true; flowError = error; },
  );

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    flow,
    new Promise<void>((resolve) => {
      watchdog = setTimeout(() => { timedOut = true; resolve(); }, cli.timeoutMs);
    }),
  ]);
  if (watchdog) clearTimeout(watchdog);

  // 关闭应用（同时打断被看门狗 race 掉的挂起调用），再做关闭后断言。
  await launched?.close().catch(() => undefined);
  await flow.catch(() => undefined);

  if (timedOut && !flowSettled) {
    record(ctx, {
      id: "x-watchdog-timeout",
      title: `整体看门狗超时（${cli.timeoutMs}ms）`,
      status: "FAIL",
      detail: devLogTail.length ? `dev 日志尾：${devLogTail.join("").slice(-600)}` : "超时前未完成全部断言。",
    });
  } else if (flowError) {
    record(ctx, {
      id: "x-infrastructure",
      title: "基础设施/旅程执行",
      status: "FAIL",
      detail: `${errorMessage(flowError)}${devLogTail.length ? `；dev 日志尾：${devLogTail.join("").slice(-600)}` : ""}`,
    });
  }

  // d/h 在旅程结束后汇总（console 全量收集；哨兵在应用关闭后比对）。
  effectiveConsoleErrors = assertConsoleClean(ctx, [...DEFAULT_CONSOLE_IGNORE_SUBSTRINGS, ...cli.consoleIgnoreSubstrings]);
  sentinelVerification = await assertReadonlyGuard(ctx, sentinelBefore);
  treeVerification = await assertReadonlyProjectTreeGuard(ctx, treeBefore);

  await isolated.cleanup().catch(() => undefined);

  const ok = ctx.assertions.every((assertion) => assertion.status !== "FAIL");
  const report: T23Report = {
    schemaVersion: 1,
    kind: "t23-layer4-project-ui-verify",
    createdAt: new Date().toISOString(),
    ok,
    mode: cli.mode,
    project: { id: isolated.project.id, name: isolated.project.name, root: cli.projectRoot },
    expectations: {
      ...(cli.expectUnits !== undefined ? { expectUnits: cli.expectUnits } : {}),
      ...(ctx.derivedUnits !== undefined ? { derivedUnits: ctx.derivedUnits } : {}),
      ...(ctx.unitDerivationError ? { unitDerivationError: ctx.unitDerivationError } : {}),
    },
    timings: {
      ...ctx.timings,
      totalMs: Date.now() - startedAt,
      firstUnitNodeSoftBudgetMs: FIRST_UNIT_NODE_SOFT_BUDGET_MS,
    },
    assertions: ctx.assertions,
    media: {
      studioRequests: watch.studioMediaRequests.length,
      failures: [...new Set(watch.mediaFailures)],
    },
    console: {
      rawErrors: watch.consoleErrors,
      ignoredErrors: watch.consoleErrors.filter((text) => !effectiveConsoleErrors.includes(text)),
      effectiveErrors: effectiveConsoleErrors,
      pageErrors: watch.pageErrors,
    },
    network: { externalRequests: watch.externalRequests },
    ...(ctx.screenshot ? {
      screenshot: {
        ...ctx.screenshot,
        path: path.relative(workspace, screenshotPath).split(path.sep).join("/"),
      },
    } : {}),
    readonlySentinels: sentinelVerification ?? {
      ok: false,
      candidateRelativePaths: [...T23_READONLY_SENTINEL_CANDIDATE_PATHS],
      includedExistingCount: sentinelBefore.length,
      mtimePrecision: "integer-millisecond",
      items: [],
      error: "哨兵复核未产生结构化结果；见 h-readonly-guard。",
    },
    ...(treeVerification ? { readonlyProjectTree: treeVerification } : {}),
    ...(ctx.rawVisualDecode ? { rawVisualDecode: ctx.rawVisualDecode } : {}),
    warnings,
    boundaries: {
      readonlyJourney: true,
      writeButtonClicks: 0,
      executeCommandWrites: 0,
      viewportMoves: 0,
      isolatedUserData: true,
      isolatedRegistryCopy: true,
      isolatedProjectCopy: isolated.isolatedProjectCopy,
      isolatedManagedProjectsRoot: true,
      isolatedMediaRuntime: true,
      isolatedRuntimeCleaned: true,
      formalProjectWrites: treeVerification?.changedPaths.length ?? null,
      buildPerformedByScript: false,
      gitActions: 0,
    },
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  process.stdout.write(`${JSON.stringify({
    ok,
    reportPath,
    screenshotPath: ctx.screenshot ? screenshotPath : null,
    assertions: ctx.assertions.map(({ id, status }) => ({ id, status })),
    timings: report.timings,
    warnings,
  }, null, 2)}\n`);
  return ok ? 0 : 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    process.stderr.write(`T23 第四层门未捕获失败：${errorMessage(error)}\n`);
    process.exitCode = 1;
  },
);
