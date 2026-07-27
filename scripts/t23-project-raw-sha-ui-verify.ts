/**
 * 受管工程指定季集的正式 raw SHA UI 核对。
 *
 * 文件名保留旧 T23 入口以兼容现有命令，但实现不再硬编码 S1E1。它先把完整工程
 * 复制到临时目录，再以源码 dev/build 打开副本；正式工程全程不交给 Electron。
 *
 * 用法：
 *   npx tsx scripts/t23-s1e1-raw-sha-ui-verify.ts \
 *     --projectRoot=/abs/project --season=S1 --episode=S1E2 [--mode=dev|build]
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getApprovedTimelineProjection } from "../src/core/studio-approved-timeline-projection.js";
import {
  captureScreenshotEvidence,
  launchBuiltElectron,
  launchDevElectron,
  prepareIsolatedRuntime,
  snapshotT23ReadonlyProjectTree,
  verifyT23ReadonlyProjectTree,
  type LaunchedUi,
} from "./lib/t23-project-ui-verify-shared.js";
import {
  compareT23RawShaProjection,
  summarizeT23RawVisualDecode,
  type T23ObservedRaw,
  type T23RawVisualDecode,
} from "./lib/t23-raw-sha-ui-verify-shared.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW_SHA_USAGE = `源码 UI 正式 raw SHA 验收

用法：
  npm run verify:project-raw-sha-ui -- \\
    --projectRoot=<绝对路径> --season=<季ID> --episode=<集ID> [--mode=dev|build]

可选：
  --registry=<projects.json>  源注册表，只读
  --evidence-dir=<目录>       JSON 与截图输出目录
  --help                      显示说明

安全边界：完整工程临时副本；仅源码 dev/build；不使用或安装桌面 .app。`;

interface CliOptions {
  projectRoot: string;
  season: string;
  episode: string;
  mode: "dev" | "build";
  sourceRegistryPath: string;
  evidenceDir: string;
}

function argumentValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((argument) => argument.startsWith(`${name}=`));
  return hit?.slice(name.length + 1).trim();
}

function parseCli(argv: string[]): CliOptions {
  const allowedPrefixes = [
    "--projectRoot=",
    "--season=",
    "--episode=",
    "--mode=",
    "--registry=",
    "--evidence-dir=",
  ];
  const unknown = argv.find((argument) => argument !== "--"
    && !allowedPrefixes.some((prefix) => argument.startsWith(prefix)));
  if (unknown) throw new Error(`未知参数：${unknown}`);
  const projectRoot = argumentValue(argv, "--projectRoot");
  const season = argumentValue(argv, "--season");
  const episode = argumentValue(argv, "--episode");
  const mode = argumentValue(argv, "--mode") ?? "dev";
  if (!projectRoot || !path.isAbsolute(projectRoot)) {
    throw new Error("--projectRoot=<绝对路径> 为必填项。");
  }
  if (!season || !episode) {
    throw new Error("--season 与 --episode 均为必填项，禁止猜测 S1E1。");
  }
  if (mode !== "dev" && mode !== "build") {
    throw new Error(`--mode 只接受 dev|build；禁止安装版：${mode}`);
  }
  const scope = `${season}-${episode}`.replace(/[^0-9A-Za-z_-]+/gu, "_");
  return {
    projectRoot: path.resolve(projectRoot),
    season,
    episode,
    mode,
    sourceRegistryPath: path.resolve(
      argumentValue(argv, "--registry")
        ?? path.join(os.homedir(), ".aicanvas", "projects.json"),
    ),
    evidenceDir: path.resolve(
      argumentValue(argv, "--evidence-dir")
        ?? path.join(workspace, "docs/evidence/source-project-ui/raw-sha", scope),
    ),
  };
}

async function exists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true, () => false);
}

/** DOM 与 verify hook 同时取证；重复来源由比较器按 unit+SHA 归约。 */
async function collectRawNodes(page: import("playwright").Page): Promise<{
  rows: T23ObservedRaw[];
  loading: boolean | null;
  corePassUnitIds: string[];
  attrRawCount: number | null;
  visuals: T23RawVisualDecode[];
}> {
  // page.evaluate 会序列化函数体；使用纯字符串避免 tsx 的 __name 注入。
  return page.evaluate(`(async () => {
    const rows = [];
    const visualCandidates = [];
    const nodes = document.querySelectorAll("[data-media-sha256]");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const mediaSha256 = (el.getAttribute("data-media-sha256") || "").trim();
      const unitId = (el.getAttribute("data-unit-id") || "").trim();
      const kind = (el.getAttribute("data-node-kind") || "").trim();
      if (kind && kind !== "raw") continue;
      if (unitId && mediaSha256) rows.push({ unitId, mediaSha256, source: "dom" });
    }
    let loading = null;
    let corePassUnitIds = [];
    const verify = window.__aiCanvasManagedStudioVerify;
    if (verify && typeof verify.getUnitGridRawSnapshot === "function") {
      const snapshot = verify.getUnitGridRawSnapshot();
      loading = snapshot.loading;
      corePassUnitIds = snapshot.corePassUnitIds || [];
      const raws = snapshot.raws || [];
      for (let i = 0; i < raws.length; i++) {
        rows.push({
          unitId: raws[i].unitId,
          mediaSha256: raws[i].rawMediaSha256,
          source: "pipeline-snapshot"
        });
        visualCandidates.push({
          unitId: raws[i].unitId,
          url: typeof raws[i].thumbnailUrl === "string" ? raws[i].thumbnailUrl : ""
        });
      }
    }
    const visuals = [];
    const decodeOne = (candidate) => new Promise((resolve) => {
      if (!candidate.url) {
        resolve({
          unitId: candidate.unitId,
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
          unitId: candidate.unitId,
          status: "FAIL",
          naturalWidth: 0,
          naturalHeight: 0,
          reason: "decode-timeout",
          url: candidate.url.slice(0, 300)
        });
      }, 15000);
      image.onload = async () => {
        window.clearTimeout(timeout);
        if (typeof image.decode === "function") await image.decode().catch(() => undefined);
        const passed = image.naturalWidth > 0 && image.naturalHeight > 0;
        resolve({
          unitId: candidate.unitId,
          status: passed ? "PASS" : "FAIL",
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          ...(passed ? {} : { reason: "natural-size-zero" }),
          url: candidate.url.slice(0, 300)
        });
      };
      image.onerror = () => {
        window.clearTimeout(timeout);
        resolve({
          unitId: candidate.unitId,
          status: "FAIL",
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          reason: "image-error",
          url: candidate.url.slice(0, 300)
        });
      };
      image.src = candidate.url;
    });
    for (let offset = 0; offset < visualCandidates.length; offset += 4) {
      const batch = await Promise.all(visualCandidates.slice(offset, offset + 4).map(decodeOne));
      visuals.push(...batch);
    }
    const root = document.querySelector('[data-testid="managed-studio-canvas-view"]');
    const rawCount = root ? root.getAttribute("data-unit-grid-raw-count") : null;
    return {
      rows,
      loading,
      corePassUnitIds,
      attrRawCount: rawCount == null ? null : Number(rawCount),
      visuals
    };
  })()`);
}

export async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${RAW_SHA_USAGE}\n`);
    return;
  }
  const cli = parseCli(argv);
  for (const candidate of [
    cli.projectRoot,
    path.join(cli.projectRoot, ".aicanvas", "managed-project.json"),
    cli.sourceRegistryPath,
  ]) {
    if (!await exists(candidate)) throw new Error(`前置文件不存在：${candidate}`);
  }
  await mkdir(cli.evidenceDir, { recursive: true });
  const formalTreeBefore = await snapshotT23ReadonlyProjectTree(cli.projectRoot);

  const isolated = await prepareIsolatedRuntime({
    projectRoot: cli.projectRoot,
    sourceRegistryPath: cli.sourceRegistryPath,
    copyProject: true,
  });
  const isolatedProjectRoot = isolated.project.primaryRoot;
  let launched: LaunchedUi | undefined;
  const logTail: string[] = [];
  try {
    const core = await getApprovedTimelineProjection(isolatedProjectRoot, {
      season: cli.season,
      episode: cli.episode,
      fastMode: true,
    });
    const expected = core.units
      .filter((unit) => unit.productionStatus === "pass")
      .map((unit) => ({
        unitId: unit.unitId,
        mediaSha256: unit.selectedRawSha256 ?? "",
      }));
    if (!expected.length) {
      throw new Error(`${cli.season}/${cli.episode} 的 Core 投影没有 PASS 单元，不能伪造 raw 验收。`);
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: isolatedProjectRoot,
      AI_CANVAS_REGISTRY_PATH: isolated.registryPath,
      AI_CANVAS_MANAGED_PROJECTS_ROOT: isolated.managedProjectsRoot,
      AI_CANVAS_MEDIA_RUNTIME_DIR: isolated.mediaRuntimeRoot,
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      AI_CANVAS_DISABLE_AUTO_UPDATE: "1",
    };
    launched = cli.mode === "dev"
      ? await launchDevElectron({
        workspace,
        userDataRoot: isolated.userDataRoot,
        env,
        logTail,
      })
      : await launchBuiltElectron({
        workspace,
        userDataRoot: isolated.userDataRoot,
        env,
      });

    const page = launched.page;
    await page.locator('[data-testid="managed-studio-canvas-view"]').waitFor({ timeout: 90_000 });
    const seasonSelect = page.locator('select[aria-label="季"]');
    const episodeSelect = page.locator('select[aria-label="集"]');
    // 季/集筛选位于“素材库 → 15 秒分镜”抽屉内，不在画布常驻顶栏。
    // 只做只读导航，不能依赖已淘汰的常驻 selector，也不能跳过 scope 核验。
    if (await seasonSelect.count() === 0 || await episodeSelect.count() === 0) {
      await page.locator('[data-testid="managed-canvas-open-library"]').click();
      const unitTab = page.locator('#managed-canvas-library nav[aria-label="素材类型"] button', {
        hasText: "15 秒分镜",
      });
      await unitTab.click();
      await seasonSelect.waitFor({ state: "visible", timeout: 30_000 });
      await episodeSelect.waitFor({ state: "visible", timeout: 30_000 });
    }
    await seasonSelect.selectOption(cli.season);
    await page.waitForFunction((episode) => Array.from(
      document.querySelectorAll<HTMLSelectElement>('select[aria-label="集"] option'),
    ).some((option) => option.value === episode), cli.episode, { timeout: 30_000 });
    await episodeSelect.selectOption(cli.episode);
    await page.waitForFunction(() => Boolean(
      document.querySelector('[data-testid="managed-studio-canvas-view"]')
      && (window as unknown as { __aiCanvasManagedStudioVerify?: unknown }).__aiCanvasManagedStudioVerify
    ), undefined, { timeout: 60_000 });

    let collected = await collectRawNodes(page);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const comparison = compareT23RawShaProjection(expected, collected.rows);
      const hookSet = new Set(collected.corePassUnitIds);
      const hookExact = hookSet.size === expected.length
        && expected.every((row) => hookSet.has(row.unitId));
      const visual = summarizeT23RawVisualDecode(expected.map((row) => row.unitId), collected.visuals);
      if (collected.loading === false && comparison.ok && hookExact && visual.ok) break;
      await page.waitForTimeout(500);
      collected = await collectRawNodes(page);
    }

    const comparison = compareT23RawShaProjection(expected, collected.rows);
    const expectedUnitIds = expected.map((row) => row.unitId).sort();
    const uiCorePassUnitIds = [...new Set(collected.corePassUnitIds)].sort();
    const corePassSetExact = JSON.stringify(uiCorePassUnitIds) === JSON.stringify(expectedUnitIds);
    const visualDecode = summarizeT23RawVisualDecode(expectedUnitIds, collected.visuals);
    const formalTreeVerification = await verifyT23ReadonlyProjectTree(cli.projectRoot, formalTreeBefore);
    const screenshotPath = path.join(
      cli.evidenceDir,
      `raw-sha-${cli.season}-${cli.episode}-${cli.mode}-${Date.now()}.png`,
    );
    const screenshot = await captureScreenshotEvidence(page, screenshotPath);
    const ok = comparison.ok
      && corePassSetExact
      && collected.loading === false
      && collected.attrRawCount === expected.length
      && visualDecode.ok
      && formalTreeVerification.ok;
    const report = {
      schemaVersion: 2,
      kind: "t23-source-project-raw-sha-ui-verify",
      createdAt: new Date().toISOString(),
      ok,
      mode: cli.mode,
      sourceProjectRoot: cli.projectRoot,
      runtimeProjectRoot: isolatedProjectRoot,
      scope: { season: cli.season, episode: cli.episode },
      core: {
        unitCount: core.unitCount,
        passCount: expected.length,
        summary: core.summary,
      },
      ui: {
        loading: collected.loading,
        attrRawCount: collected.attrRawCount,
        corePassSetExact,
        corePassUnitIds: uiCorePassUnitIds,
        observedRows: collected.rows.length,
        visualDecode,
      },
      comparison,
      readonlyProjectTree: formalTreeVerification,
      screenshot: { ...screenshot, path: screenshotPath },
      boundaries: {
        sourceOnly: true,
        installedAppUsed: false,
        isolatedProjectCopy: isolated.isolatedProjectCopy,
        formalProjectWrites: formalTreeVerification.changedPaths.length,
        imageGenerationCalls: 0,
      },
      ...(logTail.length ? { sourceDevLogTail: logTail.join("").slice(-2_000) } : {}),
    };
    const reportPath = path.join(
      cli.evidenceDir,
      `raw-sha-${cli.season}-${cli.episode}-${cli.mode}-${Date.now()}.json`,
    );
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    process.stdout.write(`${JSON.stringify({
      ok,
      reportPath,
      screenshotPath,
      expectedPassRaw: expected.length,
      matched: comparison.matchedCount,
      missing: comparison.missingUnitIds,
      stray: comparison.strayUnitIds,
      mismatches: comparison.mismatches.length,
    }, null, 2)}\n`);
    if (!ok) process.exitCode = 1;
  } finally {
    await launched?.close().catch(() => undefined);
    await isolated.cleanup().catch(() => undefined);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
