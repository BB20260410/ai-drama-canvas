import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import sharp from "sharp";
import { createManagedStudioProject } from "../src/core/service.js";
import { getStudioProductionState } from "../src/core/studio-production.js";

const SCRIPT_COUNT = 10_000;
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspace, "docs", "evidence");
const evidencePath = path.resolve(process.argv[2] || path.join(evidenceRoot, "p5-managed-studio-scale-ui-smoke-20260718-01.json"));
const screenshotPath = path.resolve(process.argv[3] || path.join(evidenceRoot, "p5-managed-studio-scale-ui-smoke-20260718-01.png"));

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

async function fileIdentity(filePath: string) {
  const bytes = await readFile(filePath);
  return {
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function collectBuildIdentity() {
  const rendererAssetsRoot = path.join(workspace, "out", "renderer", "assets");
  const rendererAssets = await readdir(rendererAssetsRoot, { withFileTypes: true });
  const paths = [
    path.join(workspace, "out", "main", "index.js"),
    path.join(workspace, "out", "preload", "index.mjs"),
    path.join(workspace, "out", "renderer", "index.html"),
    ...rendererAssets.filter((entry) => entry.isFile()).map((entry) => path.join(rendererAssetsRoot, entry.name)),
  ].sort((left, right) => left.localeCompare(right));
  return {
    files: await Promise.all(paths.map(async (filePath) => ({
      relativePath: path.relative(workspace, filePath).split(path.sep).join("/"),
      sizeBytes: (await stat(filePath)).size,
      sha256: createHash("sha256").update(await readFile(filePath)).digest("hex"),
    }))),
  };
}

function populateTextMetadata(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  const insert = database.prepare(`
    INSERT INTO studio_text_documents(id, kind, title, revision, created_at, updated_at)
    VALUES(?, ?, ?, 0, ?, ?)
  `);
  const createdAt = new Date(0).toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < SCRIPT_COUNT; index += 1) {
      const suffix = String(index).padStart(5, "0");
      insert.run(`scale-script-${suffix}`, "script", `剧本元数据 ${suffix}`, createdAt, createdAt);
    }
    insert.run("scale-prompt-00000", "prompt", "提示词元数据 00000", createdAt, createdAt);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-managed-scale-ui-")));
const projectsParent = path.join(temporaryRoot, "projects");
const registryPath = path.join(temporaryRoot, "registry", "projects.json");
const priorRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
await Promise.all([mkdir(projectsParent, { recursive: true }), mkdir(path.dirname(registryPath), { recursive: true })]);
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  const shell = await createManagedStudioProject({
    parentRoot: projectsParent,
    name: "P5 十万级前的 10k UI 有界分页验证",
    slug: "p5-scale-ui",
  });
  populateTextMetadata(shell.paths.productionDatabase);
  const productionState = await getStudioProductionState(shell.paths.root);
  if (productionState.counts.scriptDocuments !== SCRIPT_COUNT || productionState.counts.promptDocuments !== 1) {
    throw new Error(`10k 文本元数据 fixture 计数不正确：${JSON.stringify(productionState.counts)}`);
  }

  const buildIdentity = await collectBuildIdentity();
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  const launchedAt = performance.now();
  application = await electron.launch({
    args: [".", `--user-data-dir=${path.join(temporaryRoot, "electron-user-data")}`],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: shell.paths.root,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_WINDOW_WIDTH: "1680",
      AI_CANVAS_WINDOW_HEIGHT: "1020",
      AI_CANVAS_ELECTRON_BACKGROUND_SMOKE: "1",
    },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(90_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/iu.test(request.url())) externalRequests.push(request.url());
  });

  const studio = page.locator('[data-testid="material-studio-view"]');
  await studio.waitFor();
  // 正式 App 默认打开无限画布；规模测试必须显式走真实“剧本”入口，
  // 不能在隐藏的素材面板上空等分页标记。
  await page.locator('[data-testid="studio-step-script"]').click();
  await page.locator('[data-testid="material-page-indicator"]').filter({ hasText: `共 ${SCRIPT_COUNT} 项` }).waitFor();
  const readyMs = Math.round(performance.now() - launchedAt);
  const entries = page.locator(".material-entry");
  const pageOne = await entries.allTextContents();
  const pageOneDomCount = await entries.count();
  if (pageOneDomCount !== 36) throw new Error(`第一页 DOM 条目应为 36，实际 ${pageOneDomCount}`);

  await page.locator('[data-testid="material-page-next"]').click();
  await page.locator('[data-testid="material-page-indicator"]').filter({ hasText: "第 2 页" }).waitFor();
  const pageTwo = await entries.allTextContents();
  const pageTwoDomCount = await entries.count();
  if (pageTwoDomCount !== 36 || pageTwo[0] === pageOne[0]) {
    throw new Error(`下一页没有替换当前页：${JSON.stringify({ pageOneDomCount, pageTwoDomCount, firstOne: pageOne[0], firstTwo: pageTwo[0] })}`);
  }
  if (new Set([...pageOne, ...pageTwo]).size !== 72) throw new Error("前两页条目发生重复或旧页仍残留 DOM。");

  await page.locator('[data-testid="material-page-previous"]').click();
  await page.locator('[data-testid="material-page-indicator"]').filter({ hasText: "第 1 页" }).waitFor();
  const restoredPageOne = await entries.allTextContents();
  const restoredDomCount = await entries.count();
  if (restoredDomCount !== 36 || JSON.stringify(restoredPageOne) !== JSON.stringify(pageOne)) {
    throw new Error("上一页没有恢复同一批轻量元数据，或发生 DOM 累加。");
  }

  await page.locator(".rail-entry").filter({ hasText: "提示词" }).click();
  await page.locator('[data-testid="material-page-indicator"]').filter({ hasText: "共 1 项" }).waitFor();
  const promptDomCount = await entries.count();
  if (promptDomCount !== 1 || !(await entries.first().innerText()).includes("提示词元数据 00000")) {
    throw new Error("提示词列表没有使用独立、真实的 kind 过滤与计数。");
  }
  await page.locator(".rail-entry").filter({ hasText: "剧本" }).click();
  await page.locator('[data-testid="material-page-indicator"]').filter({ hasText: "第 1 页" }).waitFor();
  const resetDomCount = await entries.count();
  if (resetDomCount !== 36) throw new Error("种类切换后分页栈没有重置为有界第一页。");

  const maximumDomCount = Math.max(pageOneDomCount, pageTwoDomCount, restoredDomCount, promptDomCount, resetDomCount);
  if (maximumDomCount > 36) throw new Error(`素材 DOM 超过硬上限：${maximumDomCount}`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await application.close();
  application = undefined;

  if (pageErrors.length || externalRequests.length) {
    throw new Error(`规模 UI 出现 renderer 错误或外网请求：${JSON.stringify({ pageErrors, externalRequests })}`);
  }
  const screenshotIdentity = await fileIdentity(screenshotPath);
  const [metadata, stats] = await Promise.all([sharp(screenshotPath).metadata(), sharp(screenshotPath).stats()]);
  const stdev = Math.max(...stats.channels.map((channel) => channel.stdev));
  if ((metadata.width ?? 0) < 1_400 || (metadata.height ?? 0) < 800 || screenshotIdentity.sizeBytes < 40_000 || stdev < 5) {
    throw new Error("10k 规模 UI 截图疑似空白或占位图。");
  }

  const evidence = {
    schemaVersion: 1,
    kind: "p5-managed-studio-scale-ui-smoke",
    status: "pass",
    createdAt: new Date().toISOString(),
    buildIdentity,
    fixture: {
      metadataDocuments: SCRIPT_COUNT + 1,
      scriptDocuments: SCRIPT_COUNT,
      promptDocuments: 1,
      sourceRoots: shell.project.sourceRoots,
      startupPolicy: shell.manifest.startupPolicy,
    },
    startup: { readyMs, pageErrors: 0, externalRequests: 0 },
    ui: {
      pageLimit: 36,
      maximumMaterialEntryDomCount: maximumDomCount,
      pageOneDomCount,
      pageTwoDomCount,
      previousRestored: true,
      kindSwitchReset: true,
      promptKindCount: promptDomCount,
      pageOneFirstEntry: pageOne[0],
      pageTwoFirstEntry: pageTwo[0],
    },
    screenshot: {
      path: screenshotPath,
      ...screenshotIdentity,
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      stdev,
    },
    boundaries: { filesystemScans: 0, formalImageGenerationCalls: 0, browserSupplierCalls: 0, uploads: 0 },
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({ evidencePath, screenshotPath, readyMs, maximumDomCount })}\n`);
} finally {
  await application?.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
  if (priorRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistry;
}
