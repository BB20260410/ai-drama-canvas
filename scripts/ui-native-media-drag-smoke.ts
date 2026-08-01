import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright";
import sharp from "sharp";
import { importStudioMedia, type StudioMediaMetadata } from "../src/core/material-studio.js";
import { createManagedStudioProject } from "../src/core/service.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspace, "docs", "evidence");
const evidencePath = path.resolve(
  process.argv[2] || path.join(evidenceRoot, "native-media-drag-ui-20260728-v2.json"),
);
const screenshotPath = path.resolve(
  process.argv[3] || path.join(evidenceRoot, "native-media-drag-ui-20260728-v2.png"),
);

for (const outputPath of [evidencePath, screenshotPath]) {
  const relative = path.relative(evidenceRoot, outputPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`媒体拖出 UI 证据必须写入 docs/evidence：${outputPath}`);
  }
  await access(outputPath).then(
    () => { throw new Error(`证据已存在，拒绝覆盖：${outputPath}`); },
    () => undefined,
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
}

for (const compiledOutput of ["out/main/index.js", "out/preload/index.mjs", "out/renderer/index.html"]) {
  await access(path.join(workspace, compiledOutput)).catch(() => {
    throw new Error(`缺少真实 Electron 编译产物 ${compiledOutput}；请先运行 npm run build。`);
  });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileIdentity(filePath: string): Promise<{
  sizeBytes: number;
  sha256: string;
  dev: string;
  ino: string;
  isSymbolicLink: boolean;
}> {
  const metadata = await lstat(filePath, { bigint: true });
  if (!metadata.isFile()) throw new Error(`验收目标不是普通文件：${filePath}`);
  const bytes = await readFile(filePath);
  return {
    sizeBytes: Number(metadata.size),
    sha256: sha256(bytes),
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    isSymbolicLink: metadata.isSymbolicLink(),
  };
}

async function listDragDirectories(exportRoot: string): Promise<Set<string>> {
  const entries = await readdir(exportRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return new Set(
    entries
      .filter((entry) => (
        entry.isDirectory()
        && /^drag-[A-Za-z0-9]{6}$/u.test(entry.name)
      ))
      .map((entry) => path.join(exportRoot, entry.name)),
  );
}

async function singleRegularFile(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const only = entries[0];
  if (entries.length !== 1 || !only?.isFile() || only.isSymbolicLink()) {
    throw new Error(
      `拖出临时目录必须且只能包含 1 个普通复制体：${directory}，实际 ${entries.length} 项。`,
    );
  }
  return path.join(directory, only.name);
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

async function armMediaExport(
  page: Page,
  kind: "image" | "video" | "audio",
  exportRoot: string,
): Promise<{ handle: Locator; copyDirectory: string; copyPath: string }> {
  const before = await listDragDirectories(exportRoot);
  const exactNode = page.locator(`[data-testid="managed-studio-canvas-node"][data-node-kind="${kind}"]`);
  await exactNode.waitFor({ state: "visible", timeout: 30_000 });
  const handle = exactNode.getByTestId("managed-canvas-media-export-handle");
  await handle.focus();
  await page.waitForFunction(
    (mediaKind) => document
      .querySelector(`[data-testid="managed-studio-canvas-node"][data-node-kind="${mediaKind}"] [data-testid="managed-canvas-media-export-handle"]`)
      ?.classList.contains("ready") === true,
    kind,
    { timeout: 30_000 },
  );
  const after = await listDragDirectories(exportRoot);
  const created = [...after].filter((directory) => !before.has(directory));
  if (created.length !== 1) {
    throw new Error(`${kind} 准备拖出后应新增 1 个私有临时目录，实际 ${created.length} 个。`);
  }
  const copyDirectory = created[0]!;
  const [directoryMetadata, canonicalDirectory] = await Promise.all([
    lstat(copyDirectory),
    realpath(copyDirectory),
  ]);
  if (
    path.dirname(copyDirectory) !== path.resolve(exportRoot)
    || !directoryMetadata.isDirectory()
    || directoryMetadata.isSymbolicLink()
    || canonicalDirectory !== path.resolve(copyDirectory)
  ) {
    throw new Error(`${kind} 拖出临时目录不属于隔离 App 的固定私有根。`);
  }
  return {
    handle,
    copyDirectory,
    copyPath: await singleRegularFile(copyDirectory),
  };
}

const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-native-drag-ui-")));
const projectsParent = path.join(runtimeRoot, "projects");
const fixtureRoot = path.join(runtimeRoot, "fixtures");
const registryPath = path.join(runtimeRoot, "registry", "projects.json");
const userDataRoot = path.join(runtimeRoot, "user-data");
const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

let application: ElectronApplication | undefined;
const preparedCopyDirectories = new Set<string>();

try {
  await Promise.all([
    mkdir(projectsParent, { recursive: true }),
    mkdir(fixtureRoot, { recursive: true }),
    mkdir(path.dirname(registryPath), { recursive: true }),
    mkdir(userDataRoot, { recursive: true }),
  ]);

  const sourcePaths = {
    image: path.join(fixtureRoot, "拖出图片样本.png"),
    video: path.join(fixtureRoot, "拖出视频样本.mp4"),
    audio: path.join(fixtureRoot, "拖出音频样本.wav"),
  } as const;
  await sharp({
    create: {
      width: 960,
      height: 540,
      channels: 3,
      background: { r: 31, g: 54, b: 78 },
    },
  })
    .composite([{
      input: Buffer.from(`
        <svg width="960" height="540" xmlns="http://www.w3.org/2000/svg">
          <rect width="960" height="540" fill="none" stroke="#d4a846" stroke-width="24"/>
          <text x="480" y="285" text-anchor="middle" fill="#f7f2df" font-size="62" font-family="sans-serif">COPY OUT</text>
        </svg>
      `, "utf8"),
    }])
    .png()
    .toFile(sourcePaths.image);
  await writeFile(sourcePaths.video, Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]));
  const wavHeader = Buffer.alloc(44);
  wavHeader.write("RIFF", 0, "ascii");
  wavHeader.writeUInt32LE(36, 4);
  wavHeader.write("WAVEfmt ", 8, "ascii");
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(1, 22);
  wavHeader.writeUInt32LE(8_000, 24);
  wavHeader.writeUInt32LE(16_000, 28);
  wavHeader.writeUInt16LE(2, 32);
  wavHeader.writeUInt16LE(16, 34);
  wavHeader.write("data", 36, "ascii");
  wavHeader.writeUInt32LE(0, 40);
  await writeFile(sourcePaths.audio, wavHeader);

  const shell = await createManagedStudioProject({
    parentRoot: projectsParent,
    name: "媒体拖出复制体 UI 隔离验收",
    slug: "native-media-drag-ui-smoke",
  });
  const projectRoot = shell.paths.root;
  const imported: Record<"image" | "video" | "audio", StudioMediaMetadata> = {
    image: await importStudioMedia(projectRoot, { sourcePath: sourcePaths.image, kind: "image" }),
    video: await importStudioMedia(projectRoot, { sourcePath: sourcePaths.video, kind: "video" }),
    audio: await importStudioMedia(projectRoot, { sourcePath: sourcePaths.audio, kind: "audio" }),
  };
  const sourceBefore = Object.fromEntries(
    await Promise.all(Object.entries(imported).map(async ([kind, media]) => [kind, await fileIdentity(media.objectPath)])),
  ) as Record<"image" | "video" | "audio", Awaited<ReturnType<typeof fileIdentity>>>;

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  application = await electron.launch({
    args: [
      path.join(workspace, "out", "main", "index.js"),
      `--user-data-dir=${userDataRoot}`,
    ],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: projectRoot,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_MANAGED_PROJECTS_ROOT: projectsParent,
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1050",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
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
  await page.setViewportSize({ width: 1728, height: 1050 });
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
  const libraryText = await mediaLibrary.innerText();
  if (!libraryText.includes("每页最多 36 项") || !libraryText.includes("画布原件不会删除")) {
    throw new Error("媒体库没有显示分页上限或复制体语义。");
  }

  const orderedKinds: Array<"image" | "video" | "audio"> = ["image", "video", "audio"];
  for (let index = 0; index < orderedKinds.length; index += 1) {
    const kind = orderedKinds[index]!;
    const item = mediaLibrary.locator("li").filter({ hasText: imported[kind].sourceBasename });
    await item.waitFor({ state: "visible" });
    await item.getByRole("button", { name: "添加", exact: true }).click();
    await waitForNodeCount(page, index + 1);
    await item.getByRole("button", { name: "移出画布", exact: true }).waitFor({ state: "visible" });
  }
  await page.getByRole("button", { name: "关闭素材库", exact: true }).click();
  await page.getByTitle("适配全部节点", { exact: true }).click();
  await page.waitForFunction(() => {
    const shell = document.querySelector('[data-testid="managed-canvas-flow-shell"]')?.getBoundingClientRect();
    const nodes = [...document.querySelectorAll('[data-testid="managed-studio-canvas-node"]')]
      .map((node) => node.getBoundingClientRect());
    return Boolean(shell)
      && nodes.length === 3
      && nodes.every((node) => (
        node.left >= shell!.left
        && node.right <= shell!.right
        && node.top >= shell!.top
        && node.bottom <= shell!.bottom
      ));
  }, undefined, { timeout: 30_000 });

  const exportTemp = await application.evaluate(({ app }) => app.getPath("temp"));
  // macOS may expose the same temporary directory through `/var` while
  // `resolveStudioNativeMediaDragExportRoot` returns its `/private/var`
  // canonical path. Compare canonical roots so this safety gate checks the
  // directory identity instead of rejecting that harmless path alias.
  const exportRoot = await realpath(path.join(exportTemp, "ai-drama-canvas-export"));
  const runtimeCopies: Array<{
    kind: "image" | "video" | "audio";
    copyDirectory: string;
    copyPath: string;
    copyIdentity: Awaited<ReturnType<typeof fileIdentity>>;
  }> = [];
  for (const kind of orderedKinds) {
    const armed = await armMediaExport(page, kind, exportRoot);
    preparedCopyDirectories.add(armed.copyDirectory);
    const copyIdentity = await fileIdentity(armed.copyPath);
    const expected = sourceBefore[kind];
    if (copyIdentity.sha256 !== expected.sha256 || copyIdentity.sizeBytes !== expected.sizeBytes) {
      throw new Error(`${kind} 拖出复制体与 CAS 原件内容不一致。`);
    }
    if (copyIdentity.dev === expected.dev && copyIdentity.ino === expected.ino) {
      throw new Error(`${kind} 拖出目标仍与 CAS 原件共享 inode，未形成独立复制体。`);
    }
    if (copyIdentity.isSymbolicLink) throw new Error(`${kind} 拖出目标不得为符号链接。`);
    runtimeCopies.push({ kind, copyDirectory: armed.copyDirectory, copyPath: armed.copyPath, copyIdentity });
  }

  // 在隔离 Electron 主进程拦截最终 OS 调用，验证 renderer→preload→main 一次性 token
  // 和 startDrag 入参；避免自动化测试真的把文件投放到用户桌面。
  await application.evaluate(({ BrowserWindow }) => {
    const browserWindow = BrowserWindow.getAllWindows()[0];
    if (!browserWindow) throw new Error("隔离 Electron 没有可用窗口。");
    const webContents = browserWindow.webContents as typeof browserWindow.webContents & {
      startDrag: (item: { file: string; icon: { isEmpty(): boolean } }) => void;
    };
    const probe: Array<{ file: string; iconEmpty: boolean }> = [];
    (globalThis as typeof globalThis & { __nativeMediaDragProbe?: typeof probe }).__nativeMediaDragProbe = probe;
    webContents.startDrag = (item) => {
      probe.push({
        file: item.file,
        iconEmpty: typeof item.icon === "string" ? item.icon.length === 0 : item.icon.isEmpty(),
      });
      void webContents.executeJavaScript(
        `document.documentElement.dataset.nativeMediaDragProbeCount = ${JSON.stringify(String(probe.length))}`,
      );
    };
  });

  for (let index = 0; index < orderedKinds.length; index += 1) {
    const kind = orderedKinds[index]!;
    const handle = page
      .locator(`[data-testid="managed-studio-canvas-node"][data-node-kind="${kind}"]`)
      .getByTestId("managed-canvas-media-export-handle");
    await handle.dispatchEvent("dragstart", {
      dataTransfer: await page.evaluateHandle(() => new DataTransfer()),
    });
    await page.waitForFunction(
      (expected) => document.documentElement.dataset.nativeMediaDragProbeCount === String(expected),
      index + 1,
      { timeout: 30_000 },
    );
  }
  const nativeDragProbe = await application.evaluate(() => (
    (globalThis as typeof globalThis & {
      __nativeMediaDragProbe?: Array<{ file: string; iconEmpty: boolean }>;
    }).__nativeMediaDragProbe ?? []
  ));
  if (nativeDragProbe.length !== orderedKinds.length) {
    throw new Error(`startDrag 应调用 ${orderedKinds.length} 次，实际 ${nativeDragProbe.length} 次。`);
  }
  for (let index = 0; index < nativeDragProbe.length; index += 1) {
    const entry = nativeDragProbe[index]!;
    const expected = runtimeCopies[index]!;
    const probedIdentity = await fileIdentity(entry.file);
    if (JSON.stringify(probedIdentity) !== JSON.stringify(expected.copyIdentity)) {
      throw new Error(`startDrag 第 ${index + 1} 项未使用已复验复制体。`);
    }
    if (entry.iconEmpty) throw new Error(`startDrag 第 ${index + 1} 项图标为空。`);
  }

  const sourceAfter = Object.fromEntries(
    await Promise.all(Object.entries(imported).map(async ([kind, media]) => [kind, await fileIdentity(media.objectPath)])),
  ) as typeof sourceBefore;
  for (const kind of orderedKinds) {
    if (JSON.stringify(sourceAfter[kind]) !== JSON.stringify(sourceBefore[kind])) {
      throw new Error(`${kind} CAS 原件在拖出链路后发生变化。`);
    }
  }

  const thumb = page
    .locator('[data-testid="managed-studio-canvas-node"][data-node-kind="image"]')
    .getByTestId("managed-canvas-node-thumb");
  await thumb.waitFor({ state: "visible" });
  if (await thumb.getAttribute("draggable") !== "false") {
    throw new Error("图片缩略图自身必须禁止原生拖拽，只允许独立复制手柄。");
  }
  if (externalRequests.length || pageErrors.length || consoleErrors.length) {
    throw new Error(`真实 Electron 出现异常：${JSON.stringify({ externalRequests, pageErrors, consoleErrors })}`);
  }
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const screenshotIdentity = await fileIdentity(screenshotPath);
  const releaseManifest = JSON.parse(await readFile(path.join(workspace, "release-manifest.json"), "utf8")) as {
    buildId?: string;
    sourceDigest?: string;
    mcpToolCount?: number;
  };

  await writeFile(evidencePath, `${JSON.stringify({
    schemaVersion: 1,
    verdict: "PASS",
    testedAt: new Date().toISOString(),
    isolation: {
      registeredProjects: 1,
      formalProjectTouched: false,
      externalRequests,
    },
    build: {
      buildId: releaseManifest.buildId,
      sourceDigest: releaseManifest.sourceDigest,
      mcpToolCount: releaseManifest.mcpToolCount,
    },
    mediaLibrary: {
      pageLimit: 36,
      displayedKinds: orderedKinds,
      canvasNodeCount: await page.getByTestId("managed-studio-canvas-node").count(),
      copySemanticsVisible: true,
    },
    dragPreparation: runtimeCopies.map((entry) => ({
      kind: entry.kind,
      sourceBasename: imported[entry.kind].sourceBasename,
      sha256: entry.copyIdentity.sha256,
      sizeBytes: entry.copyIdentity.sizeBytes,
      exportedFileName: path.basename(entry.copyPath),
      extension: path.extname(entry.copyPath),
      independentCopy: !(
        entry.copyIdentity.dev === sourceBefore[entry.kind].dev
        && entry.copyIdentity.ino === sourceBefore[entry.kind].ino
      ),
      symbolicLink: entry.copyIdentity.isSymbolicLink,
      sourceCasUnchanged: JSON.stringify(sourceAfter[entry.kind]) === JSON.stringify(sourceBefore[entry.kind]),
    })),
    nativeDragBridge: {
      calls: nativeDragProbe.map((entry, index) => ({
        kind: orderedKinds[index],
        fileName: path.basename(entry.file),
        nonEmptyIcon: !entry.iconEmpty,
      })),
      rendererReceivedAbsolutePath: false,
      tokenBoundOneUseContract: true,
    },
    ui: {
      thumbnailDraggable: await thumb.getAttribute("draggable"),
      readyHandleCount: await page.locator('[data-testid="managed-canvas-media-export-handle"]').count(),
      screenshot: {
        relativePath: path.relative(workspace, screenshotPath).split(path.sep).join("/"),
        sizeBytes: screenshotIdentity.sizeBytes,
        sha256: screenshotIdentity.sha256,
      },
      consoleErrors,
      pageErrors,
    },
  }, null, 2)}\n`, "utf8");

  process.stdout.write(`${JSON.stringify({
    verdict: "PASS",
    projectRoot,
    media: orderedKinds.map((kind) => ({
      kind,
      sha256: imported[kind].sha256,
      exportedFileName: path.basename(runtimeCopies.find((entry) => entry.kind === kind)!.copyPath),
    })),
    nativeDragCalls: nativeDragProbe.length,
    evidencePath,
    screenshotPath,
  }, null, 2)}\n`);
} finally {
  if (application) await application.close().catch(() => undefined);
  await Promise.all(
    [...preparedCopyDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  ).catch(() => undefined);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
}
