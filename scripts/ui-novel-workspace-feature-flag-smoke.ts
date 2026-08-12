import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import sharp from "sharp";
import type { CanvasApi } from "../src/preload/index.js";

const sourceWorkspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildWorkspace = path.resolve(process.argv[2] ?? "");
const evidenceRoot = path.resolve(
  process.argv[3] ?? path.join(sourceWorkspace, "docs", "evidence", "novel-mode-v1", "p1"),
);
if (!process.argv[2] || !path.isAbsolute(process.argv[2])) {
  throw new Error("第一个参数必须是 VITE_AI_CANVAS_NOVEL_WORKSPACE=0 的绝对隔离构建路径。");
}
const allowedEvidenceRoot = path.join(sourceWorkspace, "docs", "evidence", "novel-mode-v1", "p1");
const evidenceRelative = path.relative(allowedEvidenceRoot, evidenceRoot);
if (evidenceRelative === ".." || evidenceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(evidenceRelative)) {
  throw new Error(`证据必须写入 ${allowedEvidenceRoot}。`);
}

const evidencePath = path.join(evidenceRoot, "feature-flag-off.json");
const screenshotPath = path.join(evidenceRoot, "feature-flag-off-drama.png");
for (const output of [evidencePath, screenshotPath]) {
  await access(output).then(
    () => { throw new Error(`证据已存在，拒绝覆盖：${output}`); },
    () => undefined,
  );
}
await mkdir(evidenceRoot, { recursive: true });

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Diagnostics {
  pageErrors: string[];
  consoleErrors: string[];
  externalRequests: string[];
}

function observe(page: Page, diagnostics: Diagnostics): void {
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  page.on("console", (entry) => {
    if (entry.type() === "error") diagnostics.consoleErrors.push(entry.text());
  });
  page.on("request", (request) => {
    if (/^https?:/iu.test(request.url())) diagnostics.externalRequests.push(request.url());
  });
}

async function closeApplication(application: ElectronApplication | undefined): Promise<void> {
  if (!application) return;
  await application.close().catch(() => {
    const process = application.process();
    if (process.exitCode === null) process.kill("SIGTERM");
  });
}

const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p1-feature-off-")));
const projectsRoot = path.join(temporaryRoot, "projects");
const registryPath = path.join(temporaryRoot, "registry", "projects.json");
const userDataPath = path.join(temporaryRoot, "user-data");
await Promise.all([
  mkdir(projectsRoot, { recursive: true }),
  mkdir(path.dirname(registryPath), { recursive: true }),
  mkdir(userDataPath, { recursive: true }),
]);

let application: ElectronApplication | undefined;
let completed = false;
try {
  const buildManifestPath = path.join(buildWorkspace, "release-manifest.json");
  const buildManifestBytes = await readFile(buildManifestPath);
  const buildManifest = JSON.parse(buildManifestBytes.toString("utf8")) as {
    sourceDigest?: string;
    buildId?: string;
    buildIdentityFingerprint?: string;
  };
  if (!/^[a-f0-9]{64}$/u.test(buildManifest.sourceDigest ?? "") || !/^[a-f0-9]{32}$/u.test(buildManifest.buildId ?? "")) {
    throw new Error("feature-off 隔离构建 identity 无效。");
  }

  const diagnostics: Diagnostics = { pageErrors: [], consoleErrors: [], externalRequests: [] };
  application = await electron.launch({
    args: [".", `--user-data-dir=${userDataPath}`],
    cwd: buildWorkspace,
    env: {
      ...process.env,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_MANAGED_PROJECTS_ROOT: projectsRoot,
      AI_CANVAS_WORKSPACE: buildWorkspace,
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const observedPages = new WeakSet<Page>();
  const attach = (page: Page): void => {
    if (observedPages.has(page)) return;
    observedPages.add(page);
    observe(page, diagnostics);
  };
  application.on("window", attach);
  const page = await application.firstWindow();
  attach(page);
  page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 1728, height: 1029 });
  await page.locator('[data-testid="root-runtime-write-gate"]').waitFor({ state: "detached" });
  await page.locator('[data-testid="first-run-screen"]').waitFor();
  await page.locator('[data-testid="first-run-create"]').click();
  await page.locator('[data-testid="managed-project-create"]').waitFor();

  const hiddenCounts = {
    modeFieldset: await page.locator('[data-testid="managed-workspace-mode"]').count(),
    novelOption: await page.locator('[data-testid="managed-workspace-mode-novel"]').count(),
    hybridOption: await page.locator('[data-testid="managed-workspace-mode-hybrid"]').count(),
  };
  if (Object.values(hiddenCounts).some((count) => count !== 0)) {
    throw new Error(`feature flag 关闭后仍显示 novel/hybrid 入口：${JSON.stringify(hiddenCounts)}`);
  }

  await page.locator('input[name="managed-project-name"]').fill("P1 回滚开关纯短剧");
  await page.locator('[data-testid="managed-project-create"] .create-button').click();
  await page.locator('[data-testid="managed-drama-workspace"]').waitFor();
  await page.locator('[data-testid="material-studio-view"]').waitFor();
  await page.locator('[data-testid="managed-studio-canvas-view"]').waitFor();
  await page.locator(".flow-loading").waitFor({ state: "detached" });
  await page.waitForTimeout(250);
  if (await page.locator('[data-testid="novel-studio-view"]').count()) {
    throw new Error("feature flag 关闭后创建结果错误进入小说壳。");
  }

  const rendererIdentity = await page.evaluate(async () => {
    const browserWindow = window as typeof window & { canvasApi: CanvasApi };
    const active = await browserWindow.canvasApi.getActiveProject();
    if (!active?.available) throw new Error("feature-off 创建后没有活动工程。");
    const shell = await browserWindow.canvasApi.getManagedProjectShell(active.primaryRoot);
    if (!shell) throw new Error("feature-off 创建结果不是受管工程。");
    return {
      projectId: shell.project.id,
      projectRoot: active.primaryRoot,
      workspaceMode: shell.workspaceMode,
    };
  });
  if (rendererIdentity.workspaceMode !== "drama") throw new Error("feature-off 创建结果不是 drama。");

  const manifestPath = path.join(rendererIdentity.projectRoot, ".aicanvas", "managed-project.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
  if (manifest.schemaVersion !== 1
    || "workspaceMode" in manifest
    || "minimumWriterSchemaVersion" in manifest
    || "novelManifest" in manifest) {
    throw new Error(`feature-off 没有保留 v1 drama manifest：${manifestBytes.toString("utf8")}`);
  }

  await page.screenshot({ path: screenshotPath, animations: "disabled" });
  const screenshotBytes = await readFile(screenshotPath);
  const screenshot = sharp(screenshotBytes);
  const [metadata, statistics] = await Promise.all([screenshot.metadata(), screenshot.stats()]);
  if ((metadata.width ?? 0) < 1400 || (metadata.height ?? 0) < 850
    || screenshotBytes.byteLength < 40_000 || statistics.entropy < 1.2) {
    throw new Error("feature-off 截图机械质量不足。");
  }
  if (diagnostics.pageErrors.length || diagnostics.consoleErrors.length || diagnostics.externalRequests.length) {
    throw new Error(`feature-off Electron 诊断不干净：${JSON.stringify(diagnostics)}`);
  }

  const evidence = {
    schemaVersion: 1,
    kind: "novel-workspace-feature-flag-off-electron-smoke",
    verdict: "PASS",
    capturedAt: new Date().toISOString(),
    buildIdentity: {
      sourceDigest: buildManifest.sourceDigest,
      buildId: buildManifest.buildId,
      buildIdentityFingerprint: buildManifest.buildIdentityFingerprint,
      releaseManifestSha256: sha256(buildManifestBytes),
    },
    featureFlag: { name: "VITE_AI_CANVAS_NOVEL_WORKSPACE", buildValue: "0" },
    entryCounts: hiddenCounts,
    createdProject: {
      projectId: rendererIdentity.projectId,
      projectRootSha256: sha256(rendererIdentity.projectRoot),
      workspaceMode: rendererIdentity.workspaceMode,
      manifestSchemaVersion: manifest.schemaVersion,
      manifestHasWorkspaceMode: "workspaceMode" in manifest,
      manifestSha256: sha256(manifestBytes),
      materialStudioVisible: await page.locator('[data-testid="material-studio-view"]').isVisible(),
      novelStudioCount: await page.locator('[data-testid="novel-studio-view"]').count(),
    },
    diagnostics,
    screenshot: {
      relativePath: path.relative(sourceWorkspace, screenshotPath).split(path.sep).join("/"),
      bytes: screenshotBytes.byteLength,
      sha256: sha256(screenshotBytes),
      width: metadata.width,
      height: metadata.height,
      entropy: statistics.entropy,
    },
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(evidencePath, 0o600);
  completed = true;
  process.stdout.write(`${JSON.stringify({ verdict: "PASS", evidencePath, screenshotPath }, null, 2)}\n`);
} finally {
  await closeApplication(application);
  if (!completed) await Promise.all([evidencePath, screenshotPath].map((output) => rm(output, { force: true })));
  await rm(temporaryRoot, { recursive: true, force: true });
}
