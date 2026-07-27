import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import sharp from "sharp";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  getMaterialStudioState,
  importStudioMedia,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
} from "../src/core/material-studio.js";
import { createManagedStudioProject } from "../src/core/service.js";
import {
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  getStudioProductionState,
  type StudioProductionPanelInput,
} from "../src/core/studio-production.js";
import type { CanvasApi } from "../src/preload/index.js";
import type { ProjectEvent } from "../src/core/types.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = path.resolve(process.argv[2] || path.join(workspace, "docs", "evidence", "p5-managed-studio-ui-smoke-20260718-01.json"));
const screenshotPath = path.resolve(process.argv[3] || path.join(workspace, "docs", "evidence", "p5-managed-studio-ui-smoke-20260718-01.png"));
const outputs = [evidencePath, screenshotPath];
if (new Set(outputs).size !== outputs.length) throw new Error("UI 证据 JSON 与截图必须使用不同路径。");
for (const output of outputs) {
  const relative = path.relative(path.join(workspace, "docs", "evidence"), output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`UI 证据必须写入 docs/evidence：${output}`);
  }
  await access(output).then(
    () => { throw new Error(`UI 证据已存在，拒绝覆盖：${output}`); },
    () => undefined,
  );
  await mkdir(path.dirname(output), { recursive: true });
}

const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-managed-studio-ui-")));
const projectsParent = path.join(temporaryRoot, "projects");
const registryPath = path.join(temporaryRoot, "registry", "projects.json");
const oldRoot = path.join(temporaryRoot, "old-project-must-not-scan");
const priorRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
await Promise.all([mkdir(projectsParent, { recursive: true }), mkdir(path.dirname(registryPath), { recursive: true }), mkdir(oldRoot, { recursive: true })]);
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

async function identity(filePath: string) {
  const metadata = await stat(filePath);
  const bytes = await readFile(filePath);
  return {
    sizeBytes: metadata.size,
    mtimeMs: metadata.mtimeMs,
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

async function fixtureImage(filePath: string, accent: string, label: string): Promise<void> {
  const safeLabel = label.replace(/[&<>]/gu, "");
  const svg = Buffer.from(`
    <svg width="900" height="1600" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#10120f"/><stop offset="1" stop-color="${accent}"/></linearGradient></defs>
      <rect width="900" height="1600" fill="url(#g)"/>
      <circle cx="450" cy="520" r="230" fill="none" stroke="#d4a846" stroke-width="18"/>
      <path d="M170 1200 L450 850 L730 1200 Z" fill="none" stroke="#e8e5d9" stroke-width="16"/>
      <text x="450" y="1420" text-anchor="middle" fill="#e8e5d9" font-size="58" font-family="sans-serif">${safeLabel}</text>
    </svg>
  `, "utf8");
  await sharp(svg).png().toFile(filePath);
}

async function authorityAsset(
  projectRoot: string,
  input: { id: string; category: "character" | "scene" | "prop"; name: string; imagePath: string; locks: string[] },
): Promise<void> {
  const media = await importStudioMedia(projectRoot, { sourcePath: input.imagePath });
  const asset = await createStudioCanonicalAsset(projectRoot, {
    id: input.id,
    expectedRevision: 0,
    category: input.category,
    name: input.name,
    aliases: [input.name.replace(/（.*）/u, "")],
    identityFeatures: input.locks,
    positiveLocks: input.locks,
    negativeLocks: ["禁止换身份", "禁止现代物", "禁止拼图或分屏"],
    defaultPrompt: `${input.name}严格沿用当前 approved 权威图。`,
  });
  const pending = await appendStudioAssetVersion(projectRoot, {
    assetId: asset.id,
    mediaSha256: media.sha256,
    reviewStatus: "pending",
    expectedRevision: asset.revision,
    sourceNote: "确定性本地 UI fixture，仅验证软件链路，不是正式生图。",
  });
  const reviewed = await reviewStudioAssetVersion(projectRoot, {
    assetId: asset.id,
    versionId: pending.version.id,
    decision: "approved",
    expectedRevision: pending.assetRevision,
    note: "fixture 尺寸、身份和用途已机械确认。",
  });
  await setStudioPrimaryAuthority(projectRoot, {
    assetId: asset.id,
    versionId: pending.version.id,
    expectedRevision: reviewed.revision,
    note: "P5 UI smoke 当前主权威。",
  });
}

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  const shell = await createManagedStudioProject({ parentRoot: projectsParent, name: "P5 隔离素材中心 UI 验证", slug: "p5-managed-studio-ui" });
  const projectRoot = shell.paths.root;
  const fixtureRoot = path.join(temporaryRoot, "fixture-media");
  await mkdir(fixtureRoot, { recursive: true });
  const imagePaths = {
    character: path.join(fixtureRoot, "character-authority.png"),
    scene: path.join(fixtureRoot, "scene-authority.png"),
    prop: path.join(fixtureRoot, "prop-authority.png"),
    spare: path.join(fixtureRoot, "ui-spare.png"),
  };
  await Promise.all([
    fixtureImage(imagePaths.character, "#263b38", "CHARACTER"),
    fixtureImage(imagePaths.scene, "#4b3624", "SCENE"),
    fixtureImage(imagePaths.prop, "#59471c", "PROP"),
    fixtureImage(imagePaths.spare, "#24364f", "UI SOURCE"),
  ]);
  await authorityAsset(projectRoot, {
    id: "character-ahang",
    category: "character",
    name: "阿航（青年）",
    imagePath: imagePaths.character,
    locks: ["固定脸", "黑衣", "发髻", "左侧银白挑染"],
  });
  await authorityAsset(projectRoot, {
    id: "scene-stone-room",
    category: "scene",
    name: "古蜀石室",
    imagePath: imagePaths.scene,
    locks: ["同一石墙结构", "左侧火把主光", "纵深布局不变"],
  });
  await authorityAsset(projectRoot, {
    id: "prop-cloth-bag",
    category: "prop",
    name: "封口布囊",
    imagePath: imagePaths.prop,
    locks: ["粗布材质", "封口绳结构固定", "内部物体不可见"],
  });
  await importStudioMedia(projectRoot, { sourcePath: imagePaths.spare });

  const script = await createStudioScriptDocument(projectRoot, { id: "script-ep01", title: "EP01 石室入口", expectedRevision: 0 });
  const scriptRevision = await appendStudioScriptRevision(projectRoot, {
    documentId: script.id,
    expectedRevision: 0,
    body: "阿航走进古蜀石室，按住胸前封口布囊。",
    source: "fixture/EP01.md",
    sourceVersion: "p5-ui-smoke-v1",
  });
  const prompt = await createStudioPromptDocument(projectRoot, { id: "prompt-ep01", title: "EP01 电影写实提示词", expectedRevision: 0 });
  const promptRevision = await appendStudioPromptRevision(projectRoot, {
    documentId: prompt.id,
    expectedRevision: 0,
    body: "电影写实、9:16 竖屏，严格保持阿航、古蜀石室和封口布囊的一致性。",
    source: "fixture/EP01-prompt.txt",
    sourceVersion: "p5-ui-smoke-v1",
  });
  const panelInputs: StudioProductionPanelInput[] = [
    {
      id: "panel-01",
      title: "入场",
      visualAction: "阿航从石门进入古蜀石室。",
      shotComposition: "中景，人物居中，保留石门纵深。",
      filmingMethod: "35mm 稳定器缓慢跟入。",
      dialogue: "",
      subtitle: "",
      startSeconds: 0,
      endSeconds: 7,
      durationSeconds: 7,
      promptRevisionId: promptRevision.revision.id,
      assets: [
        { assetId: "character-ahang", category: "character", presence: "required", role: "主体", continuityState: "固定黑衣与发型", evidence: [{ kind: "hard-lock", reference: "character-authority", note: "当前权威" }] },
        { assetId: "scene-stone-room", category: "scene", presence: "required", role: "同一空间", continuityState: "左侧火把光", evidence: [{ kind: "script-source", reference: scriptRevision.revision.id, note: "场景事实" }] },
        { assetId: "prop-cloth-bag", category: "prop", presence: "optional", role: "胸前布囊", continuityState: "封口且内部不可见", evidence: [{ kind: "hard-lock", reference: "prop-authority", note: "当前权威" }] },
      ],
    },
    {
      id: "panel-02",
      title: "按住布囊",
      visualAction: "阿航警觉回头，右手按住胸前封口布囊。",
      shotComposition: "近景，手和布囊位于右下三分点。",
      filmingMethod: "50mm 缓慢推近。",
      dialogue: "阿航：别出声。",
      subtitle: "别出声",
      startSeconds: 7,
      endSeconds: 15,
      durationSeconds: 8,
      promptRevisionId: promptRevision.revision.id,
      assets: [
        { assetId: "character-ahang", category: "character", presence: "required", role: "主体", continuityState: "承接前格站位和黑衣", evidence: [{ kind: "hard-lock", reference: "character-authority", note: "当前权威" }] },
        { assetId: "scene-stone-room", category: "scene", presence: "required", role: "同一空间", continuityState: "机位推进但布局不变", evidence: [{ kind: "script-source", reference: scriptRevision.revision.id, note: "场景事实" }] },
        { assetId: "prop-cloth-bag", category: "prop", presence: "required", role: "胸前布囊", continuityState: "右手按住，内部不可见", evidence: [{ kind: "hard-lock", reference: "prop-authority", note: "当前权威" }] },
      ],
    },
  ];
  await createStudioProductionUnit(projectRoot, {
    id: "unit-ep01-001",
    expectedRevision: 0,
    season: "S03",
    episode: "EP01",
    sequence: 1,
    title: "石室入口",
    scriptRevisionId: scriptRevision.revision.id,
    panels: panelInputs,
  });

  const oldSentinel = path.join(oldRoot, "DO-NOT-SCAN.txt");
  await writeFile(oldSentinel, "old project sentinel", "utf8");
  const watcherProbeDirectory = path.join(oldRoot, "EP99_15s_001_watcher-switch-probe");
  const watcherProbePath = path.join(watcherProbeDirectory, "00_信息.md");
  await mkdir(watcherProbeDirectory, { recursive: true });
  await writeFile(watcherProbePath, "旧工程 watcher 切换前基线。\n", "utf8");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as Array<Record<string, unknown>>;
  registry.push({ id: "old-project-sentinel", name: "旧项目哨兵", primaryRoot: oldRoot, updatedAt: new Date(0).toISOString() });
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const guardedFiles = [
    path.join(projectRoot, ".aicanvas", "index.json"),
    path.join(projectRoot, ".aicanvas", "cache.sqlite"),
    oldSentinel,
  ];
  const before = Object.fromEntries(await Promise.all(guardedFiles.map(async (filePath) => [filePath, await identity(filePath)])));
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  const studioMediaRequests: string[] = [];
  const studioMediaFailures: string[] = [];
  const launchedAt = performance.now();
  const buildIdentity = await collectBuildIdentity();
  app = await electron.launch({
    args: ["."],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: projectRoot,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_MANAGED_PROJECTS_ROOT: projectsParent,
      AI_CANVAS_WINDOW_WIDTH: "1820",
      AI_CANVAS_WINDOW_HEIGHT: "1160",
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(45_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/iu.test(request.url())) externalRequests.push(request.url());
    if (request.url().startsWith("aicanvas-studio:")) studioMediaRequests.push(request.url());
  });
  page.on("requestfailed", (request) => {
    if (request.url().startsWith("aicanvas-studio:")) {
      studioMediaFailures.push(`${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`);
    }
  });
  const studioView = page.locator('[data-testid="material-studio-view"]');
  await studioView.waitFor();
  await page.locator('[data-testid="managed-studio-canvas-view"]').waitFor();
  await Promise.all([
    studioView.filter({ hasText: "P5 隔离素材中心 UI 验证" }).waitFor(),
    studioView.filter({ hasText: "石室入口" }).waitFor(),
  ]);
  const readyMs = Math.round(performance.now() - launchedAt);
  if (await page.locator(".module-nav").count()) throw new Error("受管工程错误显示了旧工程全量模块导航。");
  const initialText = await page.locator('[data-testid="material-studio-view"]').innerText();
  if (!initialText.includes("P5 隔离素材中心 UI 验证") || !initialText.includes("石室入口")) {
    throw new Error("受管画布没有显示工程身份或真实 15 秒单元。");
  }
  await page.locator(".studio-header .quiet-action").filter({ hasText: "项目" }).click();
  const managedCreate = page.locator('[data-testid="managed-project-create"]');
  await managedCreate.waitFor();
  const managedCreateText = await managedCreate.innerText();
  if (!managedCreateText.includes("全新隔离工程") || !managedCreateText.includes("不会扫描") || managedCreateText.includes("sourceRoots=[]")) {
    throw new Error("项目中心没有用普通用户语言显示隔离创建契约。");
  }
  await page.getByRole("button", { name: "关闭项目中心" }).click();

  await page.locator('[data-testid="studio-step-script"]').click();
  await page.locator(".timeline-dock").filter({ hasText: "1 个单元" }).waitFor();

  await page.locator(".rail-entry").filter({ hasText: "提示词" }).click();
  const promptEntry = page.locator(".material-entry").filter({ hasText: "EP01 电影写实提示词" });
  await promptEntry.waitFor();
  await promptEntry.click();
  await page.locator(".text-document-section").filter({ hasText: "严格保持阿航、古蜀石室和封口布囊的一致性" }).waitFor();
  await page.evaluate(async ({ legacyRoot, managedRoot }) => {
    const browserWindow = window as typeof window & {
      canvasApi: CanvasApi;
      __p5WatchErrors?: string[];
      __p5RemoveWatchError?: () => void;
    };
    browserWindow.__p5WatchErrors = [];
    browserWindow.__p5RemoveWatchError = browserWindow.canvasApi.onWatchError((message) => browserWindow.__p5WatchErrors?.push(message));
    await browserWindow.canvasApi.startWatch(legacyRoot);
    await browserWindow.canvasApi.startWatch(managedRoot);
  }, { legacyRoot: oldRoot, managedRoot: projectRoot });
  await writeFile(watcherProbePath, "旧工程 watcher 已切换到受管工程后，本次修改不得触发扫描。\n", "utf8");
  await page.waitForTimeout(1_800);
  const watcherSwitchErrors = await page.evaluate(() => {
    const browserWindow = window as typeof window & { __p5WatchErrors?: string[] };
    return [...(browserWindow.__p5WatchErrors ?? [])];
  });
  if (watcherSwitchErrors.length) throw new Error(`切换到受管工程后旧 watcher 仍然活动：${JSON.stringify(watcherSwitchErrors)}`);

  await page.locator(".rail-entry").filter({ hasText: "媒体" }).click();
  const mediaEntry = page.locator(".material-entry").filter({ hasText: "ui-spare.png" });
  await mediaEntry.waitFor();
  await mediaEntry.click();
  await page.locator(".rail-create button").filter({ hasText: "场景" }).click();
  const createDialog = page.locator(".create-dialog");
  await createDialog.getByLabel("正式名称").fill("UI 新建一致性场景");
  await createDialog.getByLabel("确认别名").fill("场景别名");
  await createDialog.getByLabel("身份特征").fill("固定石墙结构\n左侧火把主光");
  await createDialog.getByLabel("必须保持").fill("同一空间布局\n同一色温");
  await createDialog.getByLabel("禁止出现").fill("禁止现代物\n禁止换场景");
  await createDialog.getByLabel("集", { exact: true }).fill("EP01");
  await createDialog.getByLabel("15 秒单元", { exact: true }).fill("unit-ep01-001");
  await createDialog.getByLabel("检索标签", { exact: true }).fill("UI smoke, 石室");
  await createDialog.getByLabel("默认提示词").fill("电影写实古蜀石室，沿用权威图空间关系。");
  await createDialog.getByRole("button", { name: "创建资产", exact: true }).click();
  await page.getByText("追加参考版本", { exact: true }).waitFor();
  await page.getByText("集 EP01", { exact: true }).waitFor();
  await page.getByText("单元 unit-ep01-001", { exact: true }).waitFor();
  await page.getByText("标签 UI smoke", { exact: true }).waitFor();
  await page.locator(".version-intake textarea").fill("UI smoke 选中的项目内图片 SHA；作为场景候选版本。");
  await page.getByRole("button", { name: "追加为 pending 版本", exact: true }).click();
  const pendingVersion = page.locator(".versions-section article.pending");
  await pendingVersion.waitFor();
  await pendingVersion.locator("textarea").fill("核对结构、光线和用途，允许提升为 fixture 权威。");
  await pendingVersion.getByRole("button", { name: "批准", exact: true }).click();
  const approvedVersion = page.locator(".versions-section article.approved");
  await approvedVersion.waitFor();
  await approvedVersion.getByRole("button", { name: "提升为硬锁权威", exact: true }).click();
  await page.getByText("已锁定", { exact: true }).waitFor();
  await page.getByText("关联另一个资产", { exact: true }).click();
  const relationIntake = page.locator(".relation-intake");
  await relationIntake.getByLabel("查找资产", { exact: true }).fill("古蜀石室");
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLOptionElement>('[data-testid="relation-asset-select"] option')]
    .some((option) => option.value === "scene-stone-room"));
  await relationIntake.locator('[data-testid="relation-asset-select"]').selectOption("scene-stone-room");
  await relationIntake.getByLabel("关系角色", { exact: true }).fill("空间母版");
  await relationIntake.getByLabel("关系说明", { exact: true }).fill("UI 新建场景参考已锁定的古蜀石室空间结构。");
  await relationIntake.getByRole("button", { name: "追加关系", exact: true }).click();
  await page.locator(".relation-list").filter({ hasText: "空间母版" }).filter({ hasText: "参考自" }).waitFor();
  await page.locator(".material-entry").filter({ hasText: "古蜀石室" }).click();
  await page.locator(".version-intake textarea").fill("使关系端点 revision 漂移的第二个审核版本。 ");
  await page.getByRole("button", { name: "追加为 pending 版本", exact: true }).click();
  const driftPendingVersion = page.locator(".versions-section article.pending");
  await driftPendingVersion.waitFor();
  await driftPendingVersion.locator("textarea").fill("确认第二版媒体可用于 relation v2 漂移与重建烟测。 ");
  await driftPendingVersion.getByRole("button", { name: "批准", exact: true }).click();
  const approvedVersions = page.locator(".versions-section article.approved");
  await approvedVersions.filter({ hasText: "v2" }).getByRole("button", { name: "提升为硬锁权威", exact: true }).click();
  await page.locator(".relation-status-stale").filter({ hasText: "当前已过期" }).waitFor();
  await page.getByRole("button", { name: "重建当前关系", exact: true }).click();
  await page.locator(".relation-status-current").filter({ hasText: "当前有效" }).waitFor();
  await page.locator(".relation-status-superseded").filter({ hasText: "历史已替代" }).waitFor();
  const assetImages = page.locator('[data-testid="material-studio-view"] img');
  await assetImages.first().waitFor();
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>('[data-testid="material-studio-view"] img')];
    return images.length >= 2 && images.every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  });
  const decodedImageCount = await assetImages.count();
  if (studioMediaRequests.length < 2 || studioMediaFailures.length) {
    throw new Error(`受管缩略图协议未正常工作：${JSON.stringify({ requests: studioMediaRequests.length, failures: studioMediaFailures })}`);
  }

  const rendererState = await page.evaluate(async (root) => {
    const canvasApi = (window as typeof window & { canvasApi: CanvasApi }).canvasApi;
    const [shellState, material, production] = await Promise.all([
      canvasApi.getManagedProjectShell(root),
      canvasApi.getMaterialStudioState(root),
      canvasApi.getStudioProductionState(root),
    ]);
    return {
      shell: shellState ? { startupPolicy: shellState.manifest.startupPolicy, legacyRoots: shellState.manifest.legacyRoots } : null,
      materialCounts: material.counts,
      productionCounts: production.counts,
      bodyText: document.body.innerText.slice(0, 4_000),
      mediaDomCount: document.querySelectorAll(".material-entry").length,
      hasLegacyNavigation: Boolean(document.querySelector(".module-nav")),
    };
  }, projectRoot);
  if (!rendererState.shell || rendererState.shell.startupPolicy !== "no-filesystem-scan" || rendererState.shell.legacyRoots.length !== 0) {
    throw new Error("受管项目隔离策略未在真实 renderer 中成立。");
  }
  if (rendererState.materialCounts.canonicalAssets !== 4 || rendererState.materialCounts.primaryAuthorities !== 4
    || rendererState.materialCounts.assetRelations !== 2
    || rendererState.productionCounts.units !== 1 || rendererState.productionCounts.scriptDocuments !== 1
    || rendererState.productionCounts.promptDocuments !== 1) {
    throw new Error(`真实 UI 写回计数不正确：${JSON.stringify(rendererState)}`);
  }
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const fixtureGuardFiles = [
    shell.paths.index,
    shell.paths.cache,
    shell.paths.materialDatabase,
    shell.paths.productionDatabase,
    shell.paths.generationDatabase,
    path.join(shell.paths.sidecar, "events.jsonl"),
    oldSentinel,
  ];
  const fixtureBeforeManagedCreate = Object.fromEntries(await Promise.all(
    fixtureGuardFiles.map(async (filePath) => [filePath, await identity(filePath)]),
  ));
  const createdProjectName = "P5 UI 新建空白受管工程";
  await page.locator(".studio-header .quiet-action").filter({ hasText: "项目" }).click();
  const createManagedForm = page.locator('[data-testid="managed-project-create"]');
  await createManagedForm.locator('input[name="managed-project-name"]').fill(createdProjectName);
  await createManagedForm.getByRole("button", { name: "建立并打开工程", exact: true }).click();
  await studioView.filter({ hasText: createdProjectName }).waitFor();
  await page.locator('[data-testid="studio-step-script"]').click();
  await studioView.filter({ hasText: "全部素材" }).waitFor();

  const managedCreation = await page.evaluate(async ({ originalRoot, parentRoot, expectedName }) => {
    const canvasApi = (window as typeof window & { canvasApi: CanvasApi }).canvasApi;
    const active = await canvasApi.getActiveProject();
    if (!active) throw new Error("新建受管工程后没有活动项目指针。");
    const newRoot = active.primaryRoot;
    const [newShell, material, production, generation, taskCenter, bootstrapIndex] = await Promise.all([
      canvasApi.getManagedProjectShell(newRoot),
      canvasApi.getMaterialStudioState(newRoot),
      canvasApi.getStudioProductionState(newRoot),
      canvasApi.getStudioGenerationLedgerState(newRoot),
      canvasApi.getTaskCenter(newRoot),
      canvasApi.getIndex(newRoot, false),
    ]);
    if (!newShell) throw new Error("UI 新建结果不是受管工程。");
    const managedEvents = (taskCenter.events as ProjectEvent[]).filter((event) => event.type === "project.managed_created");
    return {
      originalRoot,
      newRoot,
      differentRoot: newRoot !== originalRoot,
      parentMatches: newRoot.startsWith(`${parentRoot}/`),
      isolatedDirectoryName: newRoot.split("/").at(-1) ?? "",
      activePointerMatches: active.primaryRoot === newRoot && active.id === newShell.project.id,
      project: {
        id: newShell.project.id,
        name: newShell.project.name,
        expectedName,
        sourceRoots: newShell.project.sourceRoots,
        outputRoots: newShell.project.outputRoots,
      },
      startupPolicy: newShell.manifest.startupPolicy,
      manifestFingerprint: newShell.manifestFingerprint,
      materialCounts: material.counts,
      productionCounts: production.counts,
      generationCounts: generation.counts,
      bootstrap: {
        total: bootstrapIndex.summary.total,
        items: bootstrapIndex.items.length,
        artifacts: bootstrapIndex.artifacts.length,
        discoveredFiles: bootstrapIndex.scanStats?.discoveredFiles,
      },
      managedEvents,
    };
  }, { originalRoot: projectRoot, parentRoot: projectsParent, expectedName: createdProjectName });
  const managedEvent = managedCreation.managedEvents[0];
  const zeroCounts = (counts: Record<string, number>) => Object.values(counts).every((count) => count === 0);
  if (!managedCreation.differentRoot || !managedCreation.parentMatches || !managedCreation.isolatedDirectoryName
    || !managedCreation.activePointerMatches || managedCreation.project.name !== managedCreation.project.expectedName
    || managedCreation.project.sourceRoots.length !== 0
    || managedCreation.project.outputRoots.length !== 1 || managedCreation.project.outputRoots[0] !== managedCreation.newRoot
    || managedCreation.startupPolicy !== "no-filesystem-scan"
    || !zeroCounts(managedCreation.materialCounts) || !zeroCounts(managedCreation.productionCounts) || !zeroCounts(managedCreation.generationCounts)
    || managedCreation.bootstrap.total !== 0 || managedCreation.bootstrap.items !== 0 || managedCreation.bootstrap.artifacts !== 0
    || managedCreation.bootstrap.discoveredFiles !== 0
    || managedCreation.managedEvents.length !== 1
    || managedEvent?.data?.projectMode !== "story_first"
    || managedEvent.data?.projectId !== managedCreation.project.id
    || managedEvent.data?.name !== createdProjectName
    || JSON.stringify(managedEvent.data?.sourceRoots) !== "[]"
    || JSON.stringify(managedEvent.data?.outputRoots) !== JSON.stringify([managedCreation.newRoot])
    || managedEvent.data?.startupPolicy !== "no-filesystem-scan"
    || managedEvent.data?.manifestFingerprint !== managedCreation.manifestFingerprint) {
    throw new Error(`UI 新建受管工程隔离或空库契约失败：${JSON.stringify(managedCreation)}`);
  }
  const fixtureAfterManagedCreate = Object.fromEntries(await Promise.all(
    fixtureGuardFiles.map(async (filePath) => [filePath, await identity(filePath)]),
  ));
  if (JSON.stringify(fixtureBeforeManagedCreate) !== JSON.stringify(fixtureAfterManagedCreate)) {
    throw new Error("UI 新建第二个受管工程时改写了原 fixture 或 legacy 哨兵。");
  }
  await page.evaluate(() => {
    const browserWindow = window as typeof window & { __p5RemoveWatchError?: () => void };
    browserWindow.__p5RemoveWatchError?.();
    delete browserWindow.__p5RemoveWatchError;
  });
  await app.close();
  app = undefined;

  const after = Object.fromEntries(await Promise.all(guardedFiles.map(async (filePath) => [filePath, await identity(filePath)])));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("受管工程启动或 UI 操作改写了 legacy index/cache 或旧工程哨兵。");
  const legacySidecarCreated = await access(path.join(oldRoot, ".aicanvas")).then(() => true, () => false);
  if (legacySidecarCreated) throw new Error("旧 watcher 切换后仍扫描并创建了旧工程 sidecar。");
  if (pageErrors.length || externalRequests.length) throw new Error(`真实 UI 出现错误或外网请求：${JSON.stringify({ pageErrors, externalRequests })}`);
  const screenshot = await identity(screenshotPath);
  const [metadata, stats] = await Promise.all([sharp(screenshotPath).metadata(), sharp(screenshotPath).stats()]);
  const stdev = Math.max(...stats.channels.map((channel) => channel.stdev));
  if ((metadata.width ?? 0) < 1_400 || (metadata.height ?? 0) < 850 || screenshot.sizeBytes < 50_000 || stdev < 5) {
    throw new Error("真实 UI 截图疑似空白或占位图。");
  }
  const finalMaterial = await getMaterialStudioState(projectRoot);
  const finalProduction = await getStudioProductionState(projectRoot);
  const evidence = {
    schemaVersion: 1,
    kind: "p5-managed-studio-ui-smoke",
    status: "pass",
    createdAt: new Date().toISOString(),
    buildIdentity,
    project: { id: shell.project.id, startupPolicy: shell.manifest.startupPolicy, legacyRoots: shell.manifest.legacyRoots },
    startup: {
      readyMs,
      oldProjectGuardUnchanged: true,
      legacyIndexAndCacheUnchanged: true,
      externalRequests: 0,
      pageErrors: 0,
      studioMediaRequests: studioMediaRequests.length,
      studioMediaFailures,
      watcherSwitch: {
        legacyWatcherStarted: true,
        switchedToManaged: true,
        postSwitchRelevantMutationWaitMs: 1_800,
        errors: watcherSwitchErrors,
        legacySidecarCreated,
      },
    },
    ui: {
      managedStudioVisible: true,
      legacyNavigationHidden: true,
      strictFifteenSecondTimelineVisible: true,
      panelCount: 2,
      assetWorkflow: ["create", "append-pending", "approve", "promote-authority"],
      applicabilityVisible: true,
      applicability: { episodes: ["EP01"], units: ["unit-ep01-001"], tags: ["UI smoke", "石室"] },
      relationWorkflow: ["append-reference-of", "render-current-relation"],
      relationRevisionWorkflow: ["render-stale", "rebase-current", "retain-superseded-history"],
      textDocumentWorkflow: ["list-prompt", "open-frozen-prompt-body"],
      managedProjectCreationEntryVisible: true,
      managedProjectCreatedAndOpened: true,
      managedProjectCreation: {
        differentRoot: managedCreation.differentRoot,
        parentMatches: managedCreation.parentMatches,
        isolatedDirectoryName: managedCreation.isolatedDirectoryName,
        activePointerMatches: managedCreation.activePointerMatches,
        projectId: managedCreation.project.id,
        projectName: managedCreation.project.name,
        projectRoot: managedCreation.newRoot,
        sourceRoots: managedCreation.project.sourceRoots,
        outputRoots: managedCreation.project.outputRoots,
        startupPolicy: managedCreation.startupPolicy,
        manifestFingerprint: managedCreation.manifestFingerprint,
        materialCounts: managedCreation.materialCounts,
        productionCounts: managedCreation.productionCounts,
        generationCounts: managedCreation.generationCounts,
        bootstrap: managedCreation.bootstrap,
        managedCreatedEventCount: managedCreation.managedEvents.length,
        originalFixtureAndLegacySentinelUnchanged: true,
      },
      materialCounts: finalMaterial.counts,
      productionCounts: finalProduction.counts,
      mediaDomCount: rendererState.mediaDomCount,
      decodedImageCount,
    },
    screenshot: { path: screenshotPath, ...screenshot, width: metadata.width, height: metadata.height, format: metadata.format, stdev },
    boundaries: { formalImageGenerationCalls: 0, browserSupplierCalls: 0, uploads: 0, sourceWrites: 0 },
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({ evidencePath, screenshotPath, readyMs, counts: finalMaterial.counts })}\n`);
} finally {
  await app?.close().catch(() => undefined);
  await chmod(oldRoot, 0o700).catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
  if (priorRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistry;
}
