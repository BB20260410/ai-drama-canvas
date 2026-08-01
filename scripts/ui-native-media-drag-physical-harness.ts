import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import sharp from "sharp";
import { importStudioMedia, type StudioMediaMetadata } from "../src/core/material-studio.js";
import { createManagedStudioProject } from "../src/core/service.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionPath = path.resolve(
  process.argv[2] || path.join(workspace, ".aicanvas-runtime", "native-media-drag-physical-session.json"),
);
const packagedExecutableInput = process.env.AI_CANVAS_PHYSICAL_APP_EXECUTABLE?.trim();
const packagedExecutable = packagedExecutableInput ? path.resolve(packagedExecutableInput) : undefined;

if (packagedExecutable) {
  await access(packagedExecutable).catch(() => {
    throw new Error(`安装版 App 可执行文件不存在：${packagedExecutable}`);
  });
} else {
  for (const compiledOutput of ["out/main/index.js", "out/preload/index.mjs", "out/renderer/index.html"]) {
    await access(path.join(workspace, compiledOutput)).catch(() => {
      throw new Error(`缺少真实 Electron 编译产物 ${compiledOutput}；请先运行 npm run build。`);
    });
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileIdentity(filePath: string): Promise<{
  path: string;
  sizeBytes: number;
  sha256: string;
  dev: string;
  ino: string;
  isSymbolicLink: boolean;
}> {
  const metadata = await lstat(filePath, { bigint: true });
  if (!metadata.isFile()) throw new Error(`验收目标不是普通文件：${filePath}`);
  return {
    path: filePath,
    sizeBytes: Number(metadata.size),
    sha256: sha256(await readFile(filePath)),
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    isSymbolicLink: metadata.isSymbolicLink(),
  };
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/opt/homebrew/bin/ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 失败（${code ?? "signal"}）：${Buffer.concat(errors).toString("utf8")}`));
    });
  });
}

async function waitForCanvasReady(page: Page): Promise<void> {
  const canvas = page.getByTestId("managed-studio-canvas-view");
  await canvas.waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="managed-studio-canvas-view"]')?.getAttribute("aria-busy") === "false"
  ), undefined, { timeout: 60_000 });
}

async function waitForNodeCount(page: Page, expected: number): Promise<void> {
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-testid="managed-studio-canvas-node"]').length === count,
    expected,
    { timeout: 30_000 },
  );
}

const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-native-drag-physical-")));
const projectsParent = path.join(runtimeRoot, "projects");
const fixtureRoot = path.join(runtimeRoot, "fixtures");
const registryPath = path.join(runtimeRoot, "registry", "projects.json");
const userDataRoot = path.join(runtimeRoot, "user-data");
const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

let application: ElectronApplication | undefined;
let shuttingDown = false;
let canvasObservationTimer: ReturnType<typeof setInterval> | undefined;
let canvasObservationInFlight = false;
const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const externalRequests: string[] = [];
let session: Record<string, unknown> = {};

async function persistSession(overrides: Record<string, unknown> = {}): Promise<void> {
  session = {
    ...session,
    ...overrides,
    updatedAt: new Date().toISOString(),
    consoleErrors,
    pageErrors,
    externalRequests,
  };
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (canvasObservationTimer) clearInterval(canvasObservationTimer);
  canvasObservationTimer = undefined;
  await persistSession({ state: "closed", closeReason: reason }).catch(() => undefined);
  if (application) await application.close().catch(() => undefined);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
}

process.once("SIGINT", () => {
  void shutdown("SIGINT").finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM").finally(() => process.exit(143));
});

try {
  await Promise.all([
    mkdir(projectsParent, { recursive: true }),
    mkdir(fixtureRoot, { recursive: true }),
    mkdir(path.dirname(registryPath), { recursive: true }),
    mkdir(userDataRoot, { recursive: true }),
  ]);

  const sourcePaths = {
    image: path.join(fixtureRoot, "Finder拖出图片.png"),
    video: path.join(fixtureRoot, "Finder拖出视频.mp4"),
    audio: path.join(fixtureRoot, "Finder拖出音频.wav"),
  } as const;

  await sharp({
    create: {
      width: 960,
      height: 540,
      channels: 3,
      background: { r: 35, g: 58, b: 86 },
    },
  })
    .composite([{
      input: Buffer.from(`
        <svg width="960" height="540" xmlns="http://www.w3.org/2000/svg">
          <rect x="16" y="16" width="928" height="508" rx="30" fill="none" stroke="#d4a846" stroke-width="20"/>
          <text x="480" y="270" text-anchor="middle" fill="#f7f2df" font-size="66" font-family="sans-serif">FINDER COPY</text>
          <text x="480" y="342" text-anchor="middle" fill="#d4a846" font-size="32" font-family="sans-serif">AI DRAMA CANVAS</text>
        </svg>
      `, "utf8"),
    }])
    .png()
    .toFile(sourcePaths.image);

  await runFfmpeg([
    "-f", "lavfi", "-i", "color=c=0x233a56:s=960x540:d=2:r=24",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-movflags", "+faststart", sourcePaths.video,
  ]);
  await runFfmpeg([
    "-f", "lavfi", "-i", "sine=frequency=660:duration=2",
    "-c:a", "pcm_s16le", sourcePaths.audio,
  ]);

  const shell = await createManagedStudioProject({
    parentRoot: projectsParent,
    name: "真实 Finder 拖出物理验收",
    slug: "native-media-drag-physical",
  });
  const projectRoot = shell.paths.root;
  const imported: Record<"image" | "video" | "audio", StudioMediaMetadata> = {
    image: await importStudioMedia(projectRoot, { sourcePath: sourcePaths.image, kind: "image" }),
    video: await importStudioMedia(projectRoot, { sourcePath: sourcePaths.video, kind: "video" }),
    audio: await importStudioMedia(projectRoot, { sourcePath: sourcePaths.audio, kind: "audio" }),
  };
  const sourceIdentities = Object.fromEntries(
    await Promise.all(Object.entries(imported).map(async ([kind, media]) => [kind, await fileIdentity(media.objectPath)])),
  );

  const launchOptions = {
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: projectRoot,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_MANAGED_PROJECTS_ROOT: projectsParent,
      AI_CANVAS_WINDOW_WIDTH: "1180",
      AI_CANVAS_WINDOW_HEIGHT: "900",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  };
  application = packagedExecutable
    ? await electron.launch({
        ...launchOptions,
        executablePath: packagedExecutable,
        args: [`--user-data-dir=${userDataRoot}`],
      })
    : await electron.launch({
        ...launchOptions,
        args: [
          path.join(workspace, "out", "main", "index.js"),
          `--user-data-dir=${userDataRoot}`,
        ],
      });
  const page = await application.firstWindow();
  page.setDefaultTimeout(45_000);
  page.on("console", (entry) => {
    if (entry.type() === "error") consoleErrors.push(entry.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/iu.test(request.url())) externalRequests.push(request.url());
  });

  await page.getByTestId("material-studio-view").waitFor({ state: "visible", timeout: 60_000 });
  await page.getByTestId("studio-mode-canvas").click();
  await waitForCanvasReady(page);
  await page.getByTestId("managed-canvas-open-library").click();
  const mediaTab = page
    .getByRole("navigation", { name: "素材类型" })
    .getByRole("button", { name: "媒体", exact: true });
  await mediaTab.click();
  const mediaLibrary = page.getByTestId("managed-canvas-media-library");
  await mediaLibrary.waitFor({ state: "visible" });

  const orderedKinds: Array<"image" | "video" | "audio"> = ["image", "video", "audio"];
  for (let index = 0; index < orderedKinds.length; index += 1) {
    const kind = orderedKinds[index]!;
    const item = mediaLibrary.locator("li").filter({ hasText: imported[kind].sourceBasename });
    await item.waitFor({ state: "visible" });
    await item.getByRole("button", { name: "添加", exact: true }).click();
    await waitForNodeCount(page, index + 1);
  }
  await page.getByRole("button", { name: "关闭素材库", exact: true }).click();
  await page.getByTitle("适配全部节点", { exact: true }).click();
  await page.waitForFunction(() => (
    document.querySelectorAll('[data-testid="managed-studio-canvas-node"]').length === 3
    && document.querySelectorAll('[data-testid="managed-canvas-media-export-handle"]').length === 3
  ), undefined, { timeout: 30_000 });

  const releaseManifestPath = packagedExecutable
    ? path.resolve(path.dirname(packagedExecutable), "../Resources/release-manifest.json")
    : path.join(workspace, "release-manifest.json");
  const releaseManifest = JSON.parse(await readFile(releaseManifestPath, "utf8")) as {
    buildId?: string;
    sourceDigest?: string;
    mcpToolCount?: number;
  };
  const window = await application.evaluate(({ BrowserWindow }) => {
    const current = BrowserWindow.getAllWindows()[0];
    return current
      ? { id: current.id, title: current.getTitle(), bounds: current.getBounds(), webContentsId: current.webContents.id }
      : null;
  });
  const screenshotPath = path.join(runtimeRoot, "physical-harness-ready.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const exportTemp = await application.evaluate(({ app }) => app.getPath("temp"));

  await persistSession({
    schemaVersion: 1,
    state: "ready",
    startedAt: new Date().toISOString(),
    workspace,
    launchMode: packagedExecutable ? "installed-app" : "source-build",
    executablePath: packagedExecutable ?? null,
    runtimeRoot,
    registryPath,
    projectRoot,
    userDataRoot,
    exportRoot: path.join(exportTemp, "ai-drama-canvas-export"),
    window,
    build: releaseManifest,
    media: Object.fromEntries(orderedKinds.map((kind) => [kind, {
      kind,
      sourceBasename: imported[kind].sourceBasename,
      sourceFixturePath: sourcePaths[kind],
      casObjectPath: imported[kind].objectPath,
      sha256: imported[kind].sha256,
      mimeType: imported[kind].mimeType,
      sourceIdentity: sourceIdentities[kind],
    }])),
    screenshotPath,
  });

  const observeCanvasRetention = async (): Promise<void> => {
    if (canvasObservationInFlight || shuttingDown) return;
    canvasObservationInFlight = true;
    try {
      const canvasState = await page.evaluate(() => ({
        observedAt: new Date().toISOString(),
        nodeCount: document.querySelectorAll(
          '[data-testid="managed-studio-canvas-node"]',
        ).length,
        exportHandleCount: document.querySelectorAll(
          '[data-testid="managed-canvas-media-export-handle"]',
        ).length,
        mediaKinds: Array.from(document.querySelectorAll(
          '[data-testid="managed-studio-canvas-node"][data-node-kind]',
        ))
          .map((element) => element.getAttribute("data-node-kind"))
          .filter((value): value is string => Boolean(value))
          .sort(),
      }));
      await persistSession({ canvasState });
    } catch (error) {
      consoleErrors.push(
        `canvas-retention-observer: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      canvasObservationInFlight = false;
    }
  };
  await observeCanvasRetention();
  canvasObservationTimer = setInterval(() => {
    void observeCanvasRetention();
  }, 1_000);
  canvasObservationTimer.unref();

  process.stdout.write(`${JSON.stringify({
    state: "ready",
    sessionPath,
    projectRoot,
    window,
    media: orderedKinds.map((kind) => ({
      kind,
      sourceBasename: imported[kind].sourceBasename,
      sha256: imported[kind].sha256,
    })),
  }, null, 2)}\n`);

  await new Promise<void>(() => undefined);
} catch (error) {
  await persistSession({
    state: "failed",
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  }).catch(() => undefined);
  await shutdown("startup-failed");
  throw error;
}
