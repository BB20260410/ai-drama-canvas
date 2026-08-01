/**
 * 使用真实 registry / 真实受管项目做“全项目图片总资源”只读 Electron 验收。
 *
 * registry 先复制到隔离临时路径，UI 不执行任何调用按钮；所有正式 Material DB
 * 在前后做文件身份比较，证明总目录浏览没有改写来源工程。
 */
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { inspectManagedProjectReadOnly } from "../src/core/managed-project.js";
import {
  listRegisteredProjects,
  setActiveProjectRegistration,
} from "../src/core/sidecar.js";
import { listGlobalStudioImageResources } from "../src/core/studio-global-image-resource-catalog.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realRegistryPath = "/Users/hxx/.aicanvas/projects.json";
const targetProjectRoot = path.join(workspace, "projects", "codex-ai-drama-studio");
const evidenceRoot = path.join(workspace, "docs", "evidence");
const evidencePath = path.resolve(
  process.argv[2]
    || path.join(evidenceRoot, "global-image-resource-live-ui-20260728-v1.json"),
);
const screenshotPath = path.resolve(
  process.argv[3]
    || path.join(evidenceRoot, "global-image-resource-live-ui-20260728-v1.png"),
);
const releaseManifestPath = path.join(workspace, "release-manifest.json");

interface FileIdentity {
  sha256: string;
  sizeBytes: string;
  mtimeNs: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function ensureFreshEvidenceTarget(output: string): Promise<void> {
  const relative = path.relative(evidenceRoot, output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`真实总资源证据必须写入 docs/evidence：${output}`);
  }
  await access(output).then(
    () => { throw new Error(`真实总资源证据已存在，拒绝覆盖：${output}`); },
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

await Promise.all([
  ensureFreshEvidenceTarget(evidencePath),
  ensureFreshEvidenceTarget(screenshotPath),
]);
await mkdir(evidenceRoot, { recursive: true });

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "global-image-resource-live-"));
const isolatedRegistryPath = path.join(temporaryRoot, "runtime", "projects.json");
const isolatedUserData = path.join(temporaryRoot, "electron-user-data");
const temporaryEvidencePath = path.join(temporaryRoot, "evidence.json");
const temporaryScreenshotPath = path.join(temporaryRoot, "screenshot.png");
await Promise.all([
  mkdir(path.dirname(isolatedRegistryPath), { recursive: true }),
  mkdir(isolatedUserData, { recursive: true }),
]);
await copyFile(realRegistryPath, isolatedRegistryPath);

const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = isolatedRegistryPath;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  const startedAt = performance.now();
  // Electron 桌面端只认 registry 同目录的活动工程指针；AI_CANVAS_PROJECT_ROOT
  // 仅供运行时 owner 使用，不能代替用户已选择工程。这里只写隔离 registry。
  await setActiveProjectRegistration(targetProjectRoot);
  const registered = await listRegisteredProjects();
  const managedDatabases: Array<{
    projectId: string;
    projectName: string;
    projectRoot: string;
    databasePath: string;
  }> = [];
  for (const project of registered) {
    try {
      const shell = await inspectManagedProjectReadOnly(project.primaryRoot);
      managedDatabases.push({
        projectId: shell.project.id,
        projectName: shell.project.name,
        projectRoot: shell.paths.root,
        databasePath: shell.paths.materialDatabase,
      });
    } catch {
      // 真实目录会在 catalog 的 unavailableProjects 中显式报告。
    }
  }
  const [realRegistryBefore, databaseIdentitiesBefore, catalog] = await Promise.all([
    fileIdentity(realRegistryPath),
    Promise.all(managedDatabases.map(async (entry) => ({
      ...entry,
      identity: await fileIdentity(entry.databasePath),
    }))),
    listGlobalStudioImageResources({ category: "all", limit: 36 }),
  ]);
  assert(catalog.projectImageEntries === 8_854, `真实目录项目图片条目不是 8,854：${catalog.projectImageEntries}`);
  assert(catalog.uniqueContentSha256 === 8_696, `真实目录不同 SHA 不是 8,696：${catalog.uniqueContentSha256}`);
  assert(catalog.items.length === 36, `真实目录第一页不是 36 张：${catalog.items.length}`);

  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  const failedStudioMediaRequests: string[] = [];
  app = await electron.launch({
    args: [".", `--user-data-dir=${isolatedUserData}`],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: targetProjectRoot,
      AI_CANVAS_REGISTRY_PATH: isolatedRegistryPath,
      AI_CANVAS_MANAGED_PROJECTS_ROOT: path.join(workspace, "projects"),
      AI_CANVAS_WINDOW_WIDTH: "1720",
      AI_CANVAS_WINDOW_HEIGHT: "1120",
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(120_000);
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
    await page.locator('[data-testid="material-studio-view"]').waitFor({ timeout: 30_000 });
  } catch (error) {
    const bodyText = (await page.locator("body").innerText().catch(() => ""))
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 2_000);
    throw new Error(`Material Studio 未进入可见态；页面文本：${bodyText || "<empty>"}`, {
      cause: error,
    });
  }
  await page.locator('[data-testid="studio-mode-global-resources"]').click();
  const center = page.locator('[data-testid="global-resource-center-view"]');
  await center.waitFor();
  await center.locator('[data-testid="global-resource-summary"]')
    .filter({ hasText: "共 8854 个项目图片条目" })
    .filter({ hasText: "8696 个不同图片内容" })
    .filter({ hasText: "549 个已有规范资产关联" })
    .filter({ hasText: "8305 个普通图片条目" })
    .waitFor();
  const expectedTabs = {
    all: 8_854,
    character: 447,
    scene: 124,
    prop: 104,
    style: 5,
    storyboard: 5_162,
    reference: 404,
    other: 2_608,
  } as const;
  for (const [category, count] of Object.entries(expectedTabs)) {
    await center.locator(`[data-testid="global-resource-tab-${category}"]`)
      .filter({ hasText: String(count) })
      .waitFor();
  }
  const cards = center.locator('[data-testid="global-resource-item"]');
  await page.waitForFunction(() => (
    document.querySelectorAll('[data-testid="global-resource-item"]').length === 36
  ));
  assert(await cards.count() === 36, "真实总资源第一页 DOM 不是 36 张。");
  await center.locator('[data-testid="global-resource-page-indicator"]')
    .filter({ hasText: "本页 36 / 共 8854 项" })
    .waitFor();
  assert(
    await center.locator('[data-testid="global-resource-classification"]').count() === 36,
    "真实总资源第一页没有逐卡分类证据。",
  );
  const images = cards.locator("img");
  for (let index = 0; index < Math.min(12, await images.count()); index += 1) {
    const image = images.nth(index);
    await image.scrollIntoViewIfNeeded();
    const decoded = await image.evaluate(async (element) => {
      const img = element as HTMLImageElement;
      if (!img.complete) {
        await new Promise<void>((resolve, reject) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => reject(new Error(img.src)), { once: true });
        });
      }
      await img.decode();
      return {
        width: img.naturalWidth,
        height: img.naturalHeight,
        loading: img.loading,
        decoding: img.decoding,
      };
    });
    assert(
      decoded.width > 0
      && decoded.height > 0
      && decoded.loading === "lazy"
      && decoded.decoding === "async",
      `真实总资源缩略图未按 lazy/async 解码：${JSON.stringify(decoded)}`,
    );
  }
  await page.screenshot({ path: temporaryScreenshotPath, fullPage: true });
  await app.close();
  app = undefined;

  const [realRegistryAfter, databaseIdentitiesAfter] = await Promise.all([
    fileIdentity(realRegistryPath),
    Promise.all(managedDatabases.map(async (entry) => ({
      ...entry,
      identity: await fileIdentity(entry.databasePath),
    }))),
  ]);
  assert(
    JSON.stringify(realRegistryAfter) === JSON.stringify(realRegistryBefore),
    "真实总资源 UI 浏览改写了正式 registry。",
  );
  assert(
    JSON.stringify(databaseIdentitiesAfter) === JSON.stringify(databaseIdentitiesBefore),
    "真实总资源 UI 浏览改写了一个或多个正式 Material DB。",
  );
  assert(pageErrors.length === 0, `真实总资源 Renderer pageerror：${pageErrors.join(" | ")}`);
  assert(externalRequests.length === 0, `真实总资源发生外网请求：${externalRequests.join(" | ")}`);
  assert(
    failedStudioMediaRequests.length === 0,
    `真实总资源缩略图协议失败：${failedStudioMediaRequests.join(" | ")}`,
  );

  const releaseManifest = JSON.parse(await readFile(releaseManifestPath, "utf8")) as {
    buildId?: string;
    sourceDigest?: string;
    mcpToolCount?: number;
  };
  const evidence = {
    schemaVersion: 1,
    kind: "global-image-resource-live-ui-smoke",
    status: "PASS",
    checkedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - startedAt),
    sourceRuntime: "out Electron build",
    buildIdentity: {
      buildId: releaseManifest.buildId ?? null,
      sourceDigest: releaseManifest.sourceDigest ?? null,
      mcpToolCount: releaseManifest.mcpToolCount ?? null,
    },
    liveCatalog: {
      projectImageEntries: catalog.projectImageEntries,
      uniqueContentSha256: catalog.uniqueContentSha256,
      canonicalImageEntries: catalog.canonicalImageEntries,
      ordinaryImageEntries: catalog.ordinaryImageEntries,
      counts: catalog.counts,
      roleCounts: catalog.roleCounts,
      classificationStateCounts: catalog.classificationStateCounts,
      registeredProjectCount: catalog.registeredProjectCount,
      readableProjectCount: catalog.readableProjectCount,
      unavailableProjects: catalog.unavailableProjects,
      classifierVersion: catalog.classifierVersion,
    },
    checks: {
      firstPageDomCount: 36,
      perCardClassification: true,
      decodedLazyAsyncThumbnails: Math.min(12, catalog.items.length),
      realRegistryUnchanged: true,
      formalMaterialDatabasesChecked: managedDatabases.length,
      formalMaterialDatabasesUnchanged: true,
      pageErrors,
      externalRequests,
      failedStudioMediaRequests,
    },
    screenshotPath: path.relative(workspace, screenshotPath).split(path.sep).join("/"),
  };
  await writeFile(temporaryEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await copyFile(temporaryScreenshotPath, `${screenshotPath}.tmp`);
  await copyFile(temporaryEvidencePath, `${evidencePath}.tmp`);
  await rename(`${screenshotPath}.tmp`, screenshotPath);
  await rename(`${evidencePath}.tmp`, evidencePath);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  await app?.close().catch(() => undefined);
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
  await rm(temporaryRoot, { recursive: true, force: true });
}
