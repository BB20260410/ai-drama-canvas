import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { getActiveProjectReadOnly } from "../src/core/service.js";
import {
  listGlobalStudioAssetResourceImages,
  type GlobalStudioAssetResourceImageItem,
} from "../src/core/studio-global-asset-catalog.js";
import {
  getProjectRegistryPath,
  listRegisteredProjects,
} from "../src/core/sidecar.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = path.resolve(
  process.argv[2]
  || path.join(workspace, "docs", "evidence", "global-asset-resource-images-canvas-live-ui-20260728-v5.json"),
);
const screenshotPath = path.resolve(
  process.argv[3]
  || path.join(workspace, "docs", "evidence", "global-asset-resource-images-canvas-live-ui-20260728-v5.png"),
);
const evidenceRoot = path.join(workspace, "docs", "evidence");

for (const output of [evidencePath, screenshotPath]) {
  const relative = path.relative(evidenceRoot, output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`无限画布剧本资源 UI 证据必须写入 docs/evidence：${output}`);
  }
  await access(output).then(
    () => { throw new Error(`无限画布剧本资源 UI 证据已存在，拒绝覆盖：${output}`); },
    () => undefined,
  );
}
await mkdir(evidenceRoot, { recursive: true });

interface FileIdentity {
  sha256: string;
  sizeBytes: number;
  mtimeNs: string;
}

interface CanvasGraphSnapshot {
  allNodeIds: string[];
  edgeIds: string[];
  pinnedNodeIds: string[];
  layoutFingerprint?: string;
}

async function identity(filePath: string): Promise<FileIdentity> {
  const [bytes, metadata] = await Promise.all([
    readFile(filePath),
    stat(filePath, { bigint: true }),
  ]);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: Number(metadata.size),
    mtimeNs: metadata.mtimeNs.toString(),
  };
}

function sameIdentity(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function findSharedResource(): Promise<GlobalStudioAssetResourceImageItem> {
  for (const category of ["character", "scene", "prop", "style"] as const) {
    let cursor: string | undefined;
    do {
      const page = await listGlobalStudioAssetResourceImages({
        category,
        limit: 36,
        ...(cursor ? { cursor } : {}),
      });
      const shared = page.items.find((item) => item.associations.length > 1);
      if (shared) return shared;
      cursor = page.nextCursor;
    } while (cursor);
  }
  throw new Error("实库没有找到多名称共享图片，无法核对全部关联名称。");
}

const originalRegistryPath = getProjectRegistryPath();
const originalRegisteredProjects = await listRegisteredProjects();
const activeProject = await getActiveProjectReadOnly();
if (!activeProject?.available) {
  throw new Error(`当前没有可读取的活动受管工程：${activeProject?.unavailableReason ?? "not-active"}`);
}

const guardedDatabasePaths: string[] = [];
for (const project of originalRegisteredProjects) {
  const databasePath = path.join(project.primaryRoot, ".aicanvas", "material-studio.sqlite");
  if (await access(databasePath).then(() => true, () => false)) guardedDatabasePaths.push(databasePath);
}
const guardedPaths = [originalRegistryPath, ...guardedDatabasePaths];
const guardedBefore = await Promise.all(guardedPaths.map(identity));

const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "global-asset-canvas-live-ui-")));
const isolatedRegistryPath = path.join(temporaryRoot, "registry", "projects.json");
const isolatedActivePath = path.join(path.dirname(isolatedRegistryPath), "active-project.json");
const isolatedUserData = path.join(temporaryRoot, "electron-user-data");
await Promise.all([
  mkdir(path.dirname(isolatedRegistryPath), { recursive: true }),
  mkdir(isolatedUserData, { recursive: true }),
]);
await writeFile(isolatedRegistryPath, await readFile(originalRegistryPath));
const now = new Date().toISOString();
const activationId = createHash("sha256")
  .update(`${activeProject.primaryRoot}\0canvas-global-resources-live-ui`, "utf8")
  .digest("hex")
  .slice(0, 32);
await writeFile(isolatedActivePath, `${JSON.stringify({
  schemaVersion: 2,
  primaryRoot: activeProject.primaryRoot,
  activationId,
  activatedAt: now,
  updatedAt: now,
  studio: {
    mode: "canvas",
    updatedAt: now,
  },
}, null, 2)}\n`, "utf8");

const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = isolatedRegistryPath;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  const sharedResource = await findSharedResource();
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  const failedStudioMediaRequests: string[] = [];
  const launchedAt = performance.now();

  app = await electron.launch({
    // Playwright Electron 要求 app path 为首参；当前 smoke 在正常退出用户窗口后独占运行。
    args: [".", `--user-data-dir=${isolatedUserData}`],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_REGISTRY_PATH: isolatedRegistryPath,
      AI_CANVAS_WINDOW_WIDTH: "1720",
      AI_CANVAS_WINDOW_HEIGHT: "1120",
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
      failedStudioMediaRequests.push(`${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`);
    }
  });

  await page.locator('[data-testid="material-studio-view"]').waitFor();
  const canvas = page.locator('[data-testid="managed-studio-canvas-view"]');
  if (!(await canvas.count())) {
    await page.locator('[data-testid="studio-mode-canvas"]').click();
  }
  await canvas.waitFor();
  await page.waitForFunction(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="managed-studio-canvas-view"]');
    const verify = (window as unknown as {
      __aiCanvasManagedStudioVerify?: {
        getUnitGridRawSnapshot?: () => {
          allNodeIds?: string[];
          edgeIds?: string[];
          pinnedNodeIds?: string[];
          layoutFingerprint?: string;
          referenceCount?: number;
          formalProjectionInFlight?: boolean;
          raws?: unknown[];
        };
      };
    }).__aiCanvasManagedStudioVerify?.getUnitGridRawSnapshot;
    const snapshot = verify?.();
    if (root?.getAttribute("aria-busy") !== "false"
      || root.dataset.rawProjectionLoading !== "0"
      || snapshot?.formalProjectionInFlight
      || !snapshot?.allNodeIds?.length
      || !snapshot.raws?.length
      || !snapshot.referenceCount) {
      return false;
    }
    const key = JSON.stringify({
      nodes: [...snapshot.allNodeIds].sort(),
      edges: [...(snapshot.edgeIds ?? [])].sort(),
      pinned: [...(snapshot.pinnedNodeIds ?? [])].sort(),
      layoutFingerprint: snapshot.layoutFingerprint ?? null,
    });
    const holder = window as unknown as {
      __aiCanvasGlobalResourceStableProbe?: { key: string; since: number };
    };
    const now = performance.now();
    if (holder.__aiCanvasGlobalResourceStableProbe?.key !== key) {
      holder.__aiCanvasGlobalResourceStableProbe = { key, since: now };
      return false;
    }
    return now - holder.__aiCanvasGlobalResourceStableProbe.since >= 1_200;
  }, null, { polling: 100, timeout: 90_000 });

  const readGraphSnapshot = async (): Promise<CanvasGraphSnapshot> => page.evaluate(() => {
    const snapshot = (window as unknown as {
      __aiCanvasManagedStudioVerify?: {
        getUnitGridRawSnapshot?: () => CanvasGraphSnapshot;
      };
    }).__aiCanvasManagedStudioVerify?.getUnitGridRawSnapshot?.();
    if (!snapshot) throw new Error("画布只读验收 hook 不可用。");
    return {
      allNodeIds: [...snapshot.allNodeIds].sort(),
      edgeIds: [...snapshot.edgeIds].sort(),
      pinnedNodeIds: [...snapshot.pinnedNodeIds].sort(),
      ...(snapshot.layoutFingerprint ? { layoutFingerprint: snapshot.layoutFingerprint } : {}),
    };
  });
  const graphBefore = await readGraphSnapshot();

  await page.locator('[data-testid="managed-canvas-open-global-resources"]').click();
  const drawer = page.locator('[data-testid="managed-canvas-global-resource-library"]');
  await drawer.waitFor();
  const summary = drawer.locator('[data-testid="managed-canvas-global-resource-summary"]');
  await summary.filter({ hasText: "共 549 张" }).waitFor();
  await summary.filter({ hasText: "人物 396" }).waitFor();
  await summary.filter({ hasText: "场景 100" }).waitFor();
  await summary.filter({ hasText: "道具 50" }).waitFor();
  await summary.filter({ hasText: "风格 3" }).waitFor();
  await summary.filter({ hasText: "已读取 26 / 28 个受管剧本" }).waitFor();
  await summary.filter({ hasText: "2 个剧本暂不可读取" }).waitFor();

  const cards = drawer.locator('[data-testid="managed-canvas-global-resource-item"]');
  await page.waitForFunction(() => (
    document.querySelectorAll('[data-testid="managed-canvas-global-resource-item"]').length === 36
  ));
  if (await cards.count() !== 36) throw new Error("人物第一页不是精确 36 张。");
  if (await drawer.getByRole("button", { name: /^(添加|移出画布|复用|Review|审核|提升)$/u }).count()) {
    throw new Error("剧本资源抽屉泄漏写入口。");
  }
  const associationGroups = drawer.locator('[data-testid="managed-canvas-global-resource-associations"]');
  if (await associationGroups.count() !== 36) throw new Error("人物第一页存在缺少名称/版本关联的卡片。");
  const sourceLabels = drawer.locator(".global-resource-source");
  if (await sourceLabels.count() !== 36) throw new Error("人物第一页存在缺少来源剧本名的卡片。");

  const firstPageKeys = await cards.evaluateAll((items) => items.map((item) => (
    (item as HTMLElement).dataset.resourceKey || ""
  )));
  if (new Set(firstPageKeys).size !== 36 || firstPageKeys.some((key) => !key)) {
    throw new Error("人物第一页资源键不唯一或为空。");
  }

  const firstPageImages = drawer.locator('[data-testid="managed-canvas-global-resource-item"] img');
  for (let index = 0; index < await firstPageImages.count(); index += 1) {
    const image = firstPageImages.nth(index);
    await image.scrollIntoViewIfNeeded();
    const decoded = await image.evaluate(async (element) => {
      const img = element as HTMLImageElement;
      if (!img.complete) {
        await new Promise<void>((resolve, reject) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => reject(new Error(`缩略图加载失败：${img.src}`)), { once: true });
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
    if (decoded.width <= 0 || decoded.height <= 0 || decoded.loading !== "lazy" || decoded.decoding !== "async") {
      throw new Error(`人物第一页缩略图未按 lazy/async 成功解码：${JSON.stringify(decoded)}`);
    }
  }
  await drawer.locator('[data-testid="managed-canvas-global-resource-viewport"]').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await drawer.locator('[data-testid="managed-canvas-global-resources-next"]').click();
  await page.waitForFunction((firstKey) => {
    const cards = [...document.querySelectorAll<HTMLElement>('[data-testid="managed-canvas-global-resource-item"]')];
    return cards.length === 36 && cards.every((card) => card.dataset.resourceKey !== firstKey);
  }, firstPageKeys[0]);
  const secondPageKeys = await cards.evaluateAll((items) => items.map((item) => (
    (item as HTMLElement).dataset.resourceKey || ""
  )));
  if (secondPageKeys.length !== 36 || secondPageKeys.some((key) => firstPageKeys.includes(key))) {
    throw new Error("人物第二页没有替换第一页 DOM，或资源跨页重复。");
  }

  await drawer.locator('[data-testid="managed-canvas-global-resources-prev"]').click();
  await page.waitForFunction((expected) => {
    const keys = [...document.querySelectorAll<HTMLElement>('[data-testid="managed-canvas-global-resource-item"]')]
      .map((item) => item.dataset.resourceKey || "");
    return JSON.stringify(keys) === JSON.stringify(expected);
  }, firstPageKeys);

  await drawer.locator(`[data-testid="managed-canvas-global-resource-${sharedResource.category}"]`).click();
  const search = drawer.getByPlaceholder("输入名称或 SHA，按回车搜索");
  await search.fill(sharedResource.mediaSha256);
  await search.press("Enter");
  await page.waitForFunction((resourceKey) => {
    const cards = [...document.querySelectorAll<HTMLElement>('[data-testid="managed-canvas-global-resource-item"]')];
    return cards.length === 1 && cards[0]?.dataset.resourceKey === resourceKey;
  }, `global-resource-image:${sharedResource.sourceProject.id}:${sharedResource.mediaSha256}`);
  const sharedCard = drawer.locator('[data-testid="managed-canvas-global-resource-item"]');
  const sharedAssociations = sharedCard.locator('[data-testid="managed-canvas-global-resource-associations"] li');
  if (await sharedAssociations.count() !== sharedResource.associations.length) {
    throw new Error("共享图片没有展示全部名称/版本关联。");
  }
  for (const association of sharedResource.associations) {
    await sharedCard.filter({ hasText: association.name }).waitFor();
  }

  const graphAfter = await readGraphSnapshot();
  if (!sameIdentity(graphAfter, graphBefore)) {
    const graphDiff = {
      addedNodes: graphAfter.allNodeIds.filter((id) => !graphBefore.allNodeIds.includes(id)),
      removedNodes: graphBefore.allNodeIds.filter((id) => !graphAfter.allNodeIds.includes(id)),
      addedEdges: graphAfter.edgeIds.filter((id) => !graphBefore.edgeIds.includes(id)),
      removedEdges: graphBefore.edgeIds.filter((id) => !graphAfter.edgeIds.includes(id)),
      addedPinned: graphAfter.pinnedNodeIds.filter((id) => !graphBefore.pinnedNodeIds.includes(id)),
      removedPinned: graphBefore.pinnedNodeIds.filter((id) => !graphAfter.pinnedNodeIds.includes(id)),
      layoutBefore: graphBefore.layoutFingerprint ?? null,
      layoutAfter: graphAfter.layoutFingerprint ?? null,
    };
    throw new Error(`打开、翻页或搜索剧本资源改变了 VueFlow 状态：${JSON.stringify(graphDiff)}`);
  }

  const guardedAfter = await Promise.all(guardedPaths.map(identity));
  if (!sameIdentity(guardedAfter, guardedBefore)) {
    throw new Error("无限画布剧本资源只读浏览改写了真实注册表或来源数据库。");
  }
  if (pageErrors.length) throw new Error(`Renderer pageerror：${pageErrors.join(" | ")}`);
  if (externalRequests.length) throw new Error(`UI smoke 发生外网请求：${externalRequests.join(" | ")}`);
  if (failedStudioMediaRequests.length) {
    throw new Error(`来源工程缩略图读取失败：${failedStudioMediaRequests.join(" | ")}`);
  }

  const evidence = {
    schemaVersion: 1,
    kind: "global-asset-resource-images-canvas-live-ui-smoke",
    status: "PASS",
    checkedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - launchedAt),
    sourceRuntime: "out Electron build",
    activeProject: {
      id: activeProject.id,
      name: activeProject.name,
      root: activeProject.primaryRoot,
    },
    checks: {
      registeredProjects: 28,
      readableProjects: 26,
      unavailableProjects: 2,
      resourceImages: {
        total: 549,
        character: 396,
        scene: 100,
        prop: 50,
        style: 3,
      },
      canvasGlobalResourceEntry: true,
      firstPageItems: firstPageKeys.length,
      secondPageItems: secondPageKeys.length,
      paginationReplacesDom: true,
      previousPageRestoresOrder: true,
      sharedImageAssociationCount: sharedResource.associations.length,
      sharedImageKeepsAllNames: true,
      sourceProjectLabels: true,
      thumbnailsLazyAsyncDecoded: true,
      globalWritesAbsent: true,
      canvasGraphUnchanged: true,
      sourceRegistryAndDatabasesUnchanged: true,
      isolatedRuntimeRegistry: isolatedRegistryPath,
      pageErrors,
      externalRequests,
      failedStudioMediaRequests,
    },
    screenshotPath: path.relative(workspace, screenshotPath).split(path.sep).join("/"),
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await app?.close().catch(() => undefined);
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
  await rm(temporaryRoot, { recursive: true, force: true });
}
