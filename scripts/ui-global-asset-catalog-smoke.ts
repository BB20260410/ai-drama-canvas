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
import sharp from "sharp";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  importStudioMedia,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
  type StudioCanonicalAssetCategory,
} from "../src/core/material-studio.js";
import {
  activateProject,
  createManagedStudioProject,
} from "../src/core/service.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = path.resolve(
  process.argv[2] || path.join(workspace, "docs", "evidence", "global-asset-resource-images-ui-20260728-v4.json"),
);
const screenshotPath = path.resolve(
  process.argv[3] || path.join(workspace, "docs", "evidence", "global-asset-resource-images-ui-20260728-v4.png"),
);
const evidenceRoot = path.join(workspace, "docs", "evidence");
for (const output of [evidencePath, screenshotPath]) {
  const relative = path.relative(evidenceRoot, output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`全剧本素材 UI 证据必须写入 docs/evidence：${output}`);
  }
  await access(output).then(
    () => { throw new Error(`全剧本素材 UI 证据已存在，拒绝覆盖：${output}`); },
    () => undefined,
  );
}
await mkdir(evidenceRoot, { recursive: true });

const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "global-asset-catalog-ui-")));
const projectsParent = path.join(temporaryRoot, "projects");
const registryPath = path.join(temporaryRoot, "registry", "projects.json");
await Promise.all([
  mkdir(projectsParent, { recursive: true }),
  mkdir(path.dirname(registryPath), { recursive: true }),
]);
const priorRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

async function identity(filePath: string): Promise<{
  sha256: string;
  sizeBytes: number;
  mtimeNs: string;
}> {
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

async function fixtureImage(
  filePath: string,
  background: string,
  label: string,
): Promise<void> {
  const svg = Buffer.from(`
    <svg width="540" height="720" xmlns="http://www.w3.org/2000/svg">
      <rect width="540" height="720" fill="${background}"/>
      <rect x="42" y="42" width="456" height="636" rx="18" fill="none" stroke="#d4a846" stroke-width="8"/>
      <text x="270" y="360" text-anchor="middle" dominant-baseline="middle" fill="#f1ead7" font-size="46" font-family="sans-serif">${label.replace(/[&<>]/gu, "")}</text>
    </svg>
  `, "utf8");
  await sharp(svg).png().toFile(filePath);
}

async function authorityAsset(
  projectRoot: string,
  input: {
    id: string;
    category: StudioCanonicalAssetCategory;
    name: string;
    imagePath: string;
  },
): Promise<{
  mediaSha256: string;
  versionId: string;
}> {
  const media = await importStudioMedia(projectRoot, {
    sourcePath: input.imagePath,
    kind: "image",
  });
  const asset = await createStudioCanonicalAsset(projectRoot, {
    id: input.id,
    category: input.category,
    name: input.name,
    aliases: [input.name],
    expectedRevision: 0,
  });
  const appended = await appendStudioAssetVersion(projectRoot, {
    assetId: asset.id,
    mediaSha256: media.sha256,
    reviewStatus: "pending",
    sourceNote: "全剧本素材 UI 隔离 fixture。",
    expectedRevision: asset.revision,
  });
  const reviewed = await reviewStudioAssetVersion(projectRoot, {
    assetId: asset.id,
    versionId: appended.version.id,
    decision: "approved",
    expectedRevision: appended.assetRevision,
    note: "确定性 fixture 已核对。",
  });
  await setStudioPrimaryAuthority(projectRoot, {
    assetId: asset.id,
    versionId: appended.version.id,
    expectedRevision: reviewed.revision,
    note: "全剧本素材 UI smoke 主权威。",
  });
  return {
    mediaSha256: media.sha256,
    versionId: appended.version.id,
  };
}

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  const current = await createManagedStudioProject({
    parentRoot: projectsParent,
    name: "当前剧本·古蜀卷",
    slug: "global-catalog-current",
  });
  const other = await createManagedStudioProject({
    parentRoot: projectsParent,
    name: "来源剧本·封神篇",
    slug: "global-catalog-other",
  });
  const fixtureRoot = path.join(temporaryRoot, "fixture");
  await mkdir(fixtureRoot, { recursive: true });
  const fixtures = [
    { root: current.paths.root, id: "character-ahang", category: "character" as const, name: "成年阿航", color: "#2f4547" },
    { root: current.paths.root, id: "scene-bronze-palace", category: "scene" as const, name: "青铜王宫", color: "#675038" },
    { root: current.paths.root, id: "prop-golden-mask", category: "prop" as const, name: "完整黄金面具", color: "#8c6f24" },
    { root: other.paths.root, id: "character-daji", category: "character" as const, name: "妲己", color: "#683642" },
    { root: other.paths.root, id: "scene-zhaoge-palace", category: "scene" as const, name: "朝歌王宫", color: "#473c64" },
    { root: other.paths.root, id: "prop-nine-tail-token", category: "prop" as const, name: "九尾令牌", color: "#3e5f3e" },
  ];
  let sharedCharacterMediaSha256 = "";
  for (const [index, fixture] of fixtures.entries()) {
    const imagePath = path.join(fixtureRoot, `${fixture.id}.png`);
    await fixtureImage(imagePath, fixture.color, fixture.name);
    const result = await authorityAsset(fixture.root, { ...fixture, imagePath });
    if (fixture.id === "character-ahang") sharedCharacterMediaSha256 = result.mediaSha256;
    if (index === 2 || index === 5) {
      const ordinaryPath = path.join(fixtureRoot, `ordinary-${index}.png`);
      await fixtureImage(ordinaryPath, "#25282b", `普通分镜 ${index}`);
      await importStudioMedia(fixture.root, { sourcePath: ordinaryPath, kind: "image" });
    }
  }
  if (!sharedCharacterMediaSha256) throw new Error("共享角色图片 fixture 未建立。");
  const sharedAlias = await createStudioCanonicalAsset(current.paths.root, {
    id: "character-shared-guardian",
    category: "character",
    name: "神殿守卫（同图登记）",
    aliases: ["神殿守卫"],
    expectedRevision: 0,
  });
  await appendStudioAssetVersion(current.paths.root, {
    assetId: sharedAlias.id,
    mediaSha256: sharedCharacterMediaSha256,
    reviewStatus: "pending",
    sourceNote: "同一图片对应第二个明确角色名称，用于验证完整关联展示。",
    expectedRevision: sharedAlias.revision,
  });
  await activateProject(current.paths.root);

  const guardedDatabases = [
    current.paths.materialDatabase,
    other.paths.materialDatabase,
  ];
  const databasesBefore = await Promise.all(guardedDatabases.map(identity));
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  const failedStudioMediaRequests: string[] = [];
  const launchedAt = performance.now();

  app = await electron.launch({
    args: ["."],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: current.paths.root,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_MANAGED_PROJECTS_ROOT: projectsParent,
      AI_CANVAS_WINDOW_WIDTH: "1680",
      AI_CANVAS_WINDOW_HEIGHT: "1080",
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(60_000);
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
  await page.locator('[data-testid="studio-step-assets"]').click();
  await page.locator('[data-testid="material-asset-scope-all"]').waitFor();
  await page.locator('[data-testid="material-asset-scope-all"]').click();
  const summary = page.locator('[data-testid="material-global-asset-summary"]');
  await summary.filter({ hasText: "已读取 2 / 2 个受管剧本" }).waitFor();
  await summary.filter({ hasText: "已进入剧本资源 6 张 / 全部图片 8" }).waitFor();
  await summary.filter({ hasText: "7 个资产实体对应 6 张版本图片" }).waitFor();
  await summary.filter({ hasText: "仍有 2 张普通图片未归入" }).waitFor();
  const globalCounts = page.locator(".project-counts");
  await globalCounts.filter({ hasText: "6" }).filter({ hasText: "全部版本图片" }).waitFor();
  await globalCounts.filter({ hasText: "2" }).filter({ hasText: "人物" }).filter({ hasText: "场景" }).filter({ hasText: "道具" }).waitFor();

  const characterCards = page.locator(".material-entry");
  await characterCards.filter({ hasText: "成年阿航" }).waitFor();
  await characterCards.filter({ hasText: "神殿守卫（同图登记）" }).waitFor();
  await characterCards.filter({ hasText: "妲己" }).waitFor();
  await characterCards.filter({ hasText: "来源剧本：当前剧本·古蜀卷" }).waitFor();
  await characterCards.filter({ hasText: "来源剧本：来源剧本·封神篇" }).waitFor();
  if (await characterCards.count() !== 2) throw new Error("人物全剧本列表不是精确 2 项。");
  const sharedImageCard = characterCards
    .filter({ hasText: "成年阿航" })
    .filter({ hasText: "神殿守卫（同图登记）" });
  await sharedImageCard.locator('[data-testid="material-resource-image-associations"] li').filter({ hasText: "成年阿航" }).waitFor();
  await sharedImageCard.locator('[data-testid="material-resource-image-associations"] li').filter({ hasText: "神殿守卫（同图登记）" }).waitFor();
  if (await sharedImageCard.locator('[data-testid="material-resource-image-associations"] li').count() !== 2) {
    throw new Error("共享图片卡没有完整展示 2 条名称/版本关联。");
  }

  const disabledWriteCount = await page.locator(".rail-create button:disabled").count();
  if (disabledWriteCount !== 4) throw new Error(`全剧本模式仍有创建按钮可写：disabled=${disabledWriteCount}`);
  const importMediaButton = page.locator(".header-actions").getByRole("button", { name: "导入媒体", exact: true });
  if (!(await importMediaButton.isDisabled())) throw new Error("全剧本模式仍允许导入媒体。");

  await characterCards.filter({ hasText: "妲己" }).click();
  const readonlyDetail = page.locator('[data-testid="material-global-readonly-detail"]');
  await readonlyDetail.filter({ hasText: "来源剧本：来源剧本·封神篇" }).waitFor();
  if (await page.locator(".version-intake").count()) throw new Error("全剧本详情泄漏了版本写入口。");
  if (await page.locator('[data-testid="cross-project-asset-reuse"]').count()) {
    throw new Error("全剧本详情泄漏了跨工程包写入口。");
  }

  const search = page.locator(".search-field input");
  await search.fill("神殿守卫");
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll<HTMLElement>(".material-entry")];
    return cards.length === 1
      && cards[0]?.innerText.includes("成年阿航")
      && cards[0]?.innerText.includes("神殿守卫（同图登记）");
  });
  await page.locator(".material-entry").click();
  const resourceDetail = page.locator('[data-testid="material-resource-image-detail"]');
  await resourceDetail.filter({ hasText: "2 条关联" }).waitFor();
  await resourceDetail.filter({ hasText: "成年阿航" }).filter({ hasText: "神殿守卫（同图登记）" }).waitFor();

  await search.fill("");
  await page.locator('[data-testid="material-asset-representation-assets"]').click();
  await globalCounts.filter({ hasText: "7" }).filter({ hasText: "全部规范资产" }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll<HTMLElement>(".material-entry").length === 3);
  await page.locator('[data-testid="material-asset-representation-images"]').click();
  await globalCounts.filter({ hasText: "6" }).filter({ hasText: "全部版本图片" }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll<HTMLElement>(".material-entry").length === 2);

  await search.fill("妲己");
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll<HTMLElement>(".material-entry")];
    return cards.length === 1 && cards[0]?.innerText.includes("妲己");
  });
  await search.fill("");
  await page.locator(".rail-entry").filter({ hasText: "场景" }).click();
  await page.locator(".material-entry").filter({ hasText: "青铜王宫" }).waitFor();
  await page.locator(".material-entry").filter({ hasText: "朝歌王宫" }).waitFor();
  await page.locator(".rail-entry").filter({ hasText: "角色" }).click();
  await page.locator(".material-entry")
    .filter({ hasText: "成年阿航" })
    .filter({ hasText: "神殿守卫（同图登记）" })
    .waitFor();

  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".material-entry img")]
    .every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0));
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const databasesAfter = await Promise.all(guardedDatabases.map(identity));
  if (JSON.stringify(databasesAfter) !== JSON.stringify(databasesBefore)) {
    throw new Error("全部剧本只读浏览改写了来源 Material Studio 数据库。");
  }
  if (pageErrors.length) throw new Error(`Renderer pageerror：${pageErrors.join(" | ")}`);
  if (externalRequests.length) throw new Error(`UI smoke 发生外网请求：${externalRequests.join(" | ")}`);
  if (failedStudioMediaRequests.length) {
    throw new Error(`跨工程缩略图读取失败：${failedStudioMediaRequests.join(" | ")}`);
  }

  const evidence = {
    schemaVersion: 1,
    kind: "global-asset-resource-images-ui-smoke",
    status: "PASS",
    checkedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - launchedAt),
    sourceRuntime: "out Electron build",
    checks: {
      registeredProjects: 2,
      readableProjects: 2,
      namedAssetEntities: { character: 3, scene: 2, prop: 2 },
      resourceImages: { total: 6, character: 2, scene: 2, prop: 2 },
      versionAssociations: 7,
      imageCoverage: { totalImages: 8, assetVersionImages: 6, ordinaryImages: 2 },
      defaultRepresentation: "images",
      sharedImageKeepsAllNames: true,
      representationSwitch: true,
      sourceProjectLabels: true,
      globalDetailUsesSourceProject: true,
      globalWritesBlocked: true,
      search: true,
      thumbnailDecode: true,
      sourceDatabasesUnchanged: true,
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
  if (priorRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistry;
  await rm(temporaryRoot, { recursive: true, force: true });
}
