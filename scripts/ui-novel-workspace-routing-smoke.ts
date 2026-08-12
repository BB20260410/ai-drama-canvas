import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import sharp from "sharp";
import { createManagedStudioProject } from "../src/core/service.js";
import {
  getActiveHybridWorkspacePreference,
  setActiveProjectRegistration,
} from "../src/core/sidecar.js";
import type { CanvasApi } from "../src/preload/index.js";

const sourceWorkspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildWorkspace = path.resolve(process.argv[2] ?? "");
const evidenceRoot = path.resolve(
  process.argv[3] ?? path.join(sourceWorkspace, "docs", "evidence", "novel-mode-v1", "p1"),
);

if (!process.argv[2] || !path.isAbsolute(process.argv[2])) {
  throw new Error("第一个参数必须是已经完成 npm run build 的绝对隔离源码快照路径。");
}

const expectedEvidenceParent = path.join(sourceWorkspace, "docs", "evidence", "novel-mode-v1", "p1");
const evidenceRelative = path.relative(expectedEvidenceParent, evidenceRoot);
if (evidenceRelative === ".." || evidenceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(evidenceRelative)) {
  throw new Error(`P1 UI 证据必须写入 ${expectedEvidenceParent}：${evidenceRoot}`);
}

const outputPaths = {
  route: path.join(evidenceRoot, "workspace-routing.json"),
  drama: path.join(evidenceRoot, "drama-workspace.png"),
  novel: path.join(evidenceRoot, "novel-workspace.png"),
  hybridNovel: path.join(evidenceRoot, "hybrid-novel-before-switch.png"),
  hybridDrama: path.join(evidenceRoot, "hybrid-drama-after-restart.png"),
};

for (const output of Object.values(outputPaths)) {
  await access(output).then(
    () => { throw new Error(`证据已存在，拒绝覆盖：${output}`); },
    () => undefined,
  );
}
await mkdir(evidenceRoot, { recursive: true });

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileIdentity(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const bytes = await readFile(filePath);
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}

interface TreeDigest {
  entries: number;
  files: number;
  bytes: number;
  sha256: string;
  records: string[];
}

async function treeDigest(root: string): Promise<TreeDigest> {
  const records: string[] = [];
  let files = 0;
  let bytes = 0;
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new Error(`隔离 UI fixture 不应包含 symlink：${relative}`);
      if (metadata.isDirectory()) {
        records.push(`d\t${relative}`);
        await visit(absolute);
      } else if (metadata.isFile()) {
        const contents = await readFile(absolute);
        files += 1;
        bytes += contents.byteLength;
        records.push(`f\t${relative}\t${contents.byteLength}\t${sha256(contents)}`);
      } else {
        throw new Error(`隔离 UI fixture 不应包含特殊文件：${relative}`);
      }
    }
  }
  await visit(root);
  return { entries: records.length, files, bytes, sha256: sha256(`${records.join("\n")}\n`), records };
}

function treeDelta(before: TreeDigest, after: TreeDigest): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before.records);
  const afterSet = new Set(after.records);
  return {
    added: after.records.filter((record) => !beforeSet.has(record)),
    removed: before.records.filter((record) => !afterSet.has(record)),
  };
}

async function screenshotIdentity(filePath: string): Promise<{
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  channels: number;
  entropy: number;
}> {
  const bytes = await readFile(filePath);
  const image = sharp(bytes);
  const [metadata, stats] = await Promise.all([image.metadata(), image.stats()]);
  if (!metadata.width || !metadata.height || !metadata.channels) throw new Error(`截图不可解码：${filePath}`);
  const entropy = stats.entropy;
  if (bytes.byteLength < 40_000 || metadata.width < 1400 || metadata.height < 850 || entropy < 1.2) {
    throw new Error(`截图机械质量不足：${filePath}`);
  }
  return {
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    width: metadata.width,
    height: metadata.height,
    channels: metadata.channels,
    entropy,
  };
}

interface BrowserDiagnostics {
  pageErrors: string[];
  consoleErrors: string[];
  externalRequests: string[];
}

function observePage(page: Page, diagnostics: BrowserDiagnostics): void {
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  page.on("console", (entry) => {
    if (entry.type() === "error") diagnostics.consoleErrors.push(entry.text());
  });
  page.on("request", (request) => {
    if (/^https?:/iu.test(request.url())) diagnostics.externalRequests.push(request.url());
  });
}

async function readRendererRouteIdentity(page: Page): Promise<{
  projectId: string;
  projectRoot: string;
  workspaceMode: "drama" | "novel" | "hybrid";
}> {
  return page.evaluate(async () => {
    const browserWindow = window as typeof window & { canvasApi: CanvasApi };
    const active = await browserWindow.canvasApi.getActiveProject();
    if (!active?.available) throw new Error("renderer 没有可用活动工程。");
    const shell = await browserWindow.canvasApi.getManagedProjectShell(active.primaryRoot);
    if (!shell) throw new Error("renderer 活动工程不是受管工程。");
    return {
      projectId: shell.project.id,
      projectRoot: active.primaryRoot,
      workspaceMode: shell.workspaceMode,
    };
  });
}

async function waitForMaterialReady(page: Page): Promise<void> {
  await page.locator('[data-testid="material-studio-view"]').waitFor();
  await page.locator('[data-testid="managed-studio-canvas-view"]').waitFor();
  await page.locator(".flow-loading").waitFor({ state: "detached" });
  await page.waitForTimeout(250);
}

async function closeApplication(application: ElectronApplication | undefined): Promise<void> {
  if (!application) return;
  await application.close().catch(async () => {
    const child = application.process();
    if (child.exitCode === null) child.kill("SIGTERM");
  });
}

const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p1-routing-ui-")));
const projectsParent = path.join(temporaryRoot, "projects");
const registryPath = path.join(temporaryRoot, "registry", "projects.json");
const priorRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
await Promise.all([mkdir(projectsParent, { recursive: true }), mkdir(path.dirname(registryPath), { recursive: true })]);

let application: ElectronApplication | undefined;
let evidenceWritten = false;

try {
  const buildManifestPath = path.join(buildWorkspace, "release-manifest.json");
  const buildManifest = JSON.parse(await readFile(buildManifestPath, "utf8")) as {
    sourceDigest?: string;
    buildId?: string;
    buildIdentityFingerprint?: string;
  };
  if (!/^[a-f0-9]{64}$/u.test(buildManifest.sourceDigest ?? "") || !/^[a-f0-9]{32}$/u.test(buildManifest.buildId ?? "")) {
    throw new Error(`隔离构建 release manifest 无效：${buildManifestPath}`);
  }
  for (const required of ["out/main/index.js", "out/preload/index.mjs", "out/renderer/index.html"]) {
    await access(path.join(buildWorkspace, required));
  }

  const drama = await createManagedStudioProject({
    parentRoot: projectsParent,
    name: "P1 纯短剧路由",
    slug: "p1-drama-route",
  });
  const novel = await createManagedStudioProject({
    parentRoot: projectsParent,
    name: "P1 纯小说路由",
    slug: "p1-novel-route",
    workspaceMode: "novel",
  });
  const hybrid = await createManagedStudioProject({
    parentRoot: projectsParent,
    name: "P1 混合路由",
    slug: "p1-hybrid-route",
    workspaceMode: "hybrid",
  });

  // 证明 novel shell 的打开/刷新链路不会借既有 drama owner 惰性补写 ledger。
  await rm(novel.paths.generationDatabase, { force: true });
  // 新建夹具的 CAS 叶目录应为空；只移除精确叶 owner，意外有内容时失败关闭。
  await rmdir(novel.paths.generationPackCas);

  const shells = { drama, novel, hybrid };
  const manifestBefore = Object.fromEntries(await Promise.all(Object.entries(shells).map(async ([mode, shell]) => [
    mode,
    await fileIdentity(shell.paths.manifest),
  ])));
  const projectTreesBefore = {
    novel: await treeDigest(novel.paths.root),
    hybrid: await treeDigest(hybrid.paths.root),
  };

  const diagnostics: Record<string, BrowserDiagnostics> = {};
  const routeChecks: Record<string, unknown> = {};
  let hybridReadonlyTreeAfterNovelShell: TreeDigest | undefined;

  async function launchFor(
    key: string,
    projectRoot: string,
    userDataName: string,
  ): Promise<{ page: Page; diagnostics: BrowserDiagnostics }> {
    await setActiveProjectRegistration(projectRoot);
    const userDataPath = path.join(temporaryRoot, "user-data", userDataName);
    await mkdir(userDataPath, { recursive: true });
    application = await electron.launch({
      args: [".", `--user-data-dir=${userDataPath}`],
      cwd: buildWorkspace,
      env: {
        ...process.env,
        AI_CANVAS_REGISTRY_PATH: registryPath,
        AI_CANVAS_PROJECT_ROOT: projectRoot,
        AI_CANVAS_MANAGED_PROJECTS_ROOT: projectsParent,
        AI_CANVAS_WORKSPACE: buildWorkspace,
        AI_CANVAS_WINDOW_WIDTH: "1728",
        AI_CANVAS_WINDOW_HEIGHT: "1029",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
    });
    const observed: BrowserDiagnostics = { pageErrors: [], consoleErrors: [], externalRequests: [] };
    const observedPages = new WeakSet<Page>();
    const attach = (candidate: Page): void => {
      if (observedPages.has(candidate)) return;
      observedPages.add(candidate);
      observePage(candidate, observed);
    };
    application.on("window", attach);
    const page = await application.firstWindow();
    attach(page);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 1728, height: 1029 });
    diagnostics[key] = observed;
    await page.locator('[data-testid="root-runtime-write-gate"]').waitFor({ state: "detached" });
    return { page, diagnostics: observed };
  }

  {
    const { page } = await launchFor("drama", drama.paths.root, "drama");
    await page.locator('[data-testid="managed-drama-workspace"]').waitFor();
    await waitForMaterialReady(page);
    if (await page.locator('[data-testid="novel-studio-view"]').count()) throw new Error("纯短剧工程错误进入小说壳。");
    const identity = await readRendererRouteIdentity(page);
    if (identity.projectId !== drama.project.id || identity.workspaceMode !== "drama") {
      throw new Error(`纯短剧 renderer 身份错误：${JSON.stringify(identity)}`);
    }
    await page.screenshot({ path: outputPaths.drama, animations: "disabled" });
    routeChecks.drama = {
      projectId: drama.project.id,
      manifestSchemaVersion: drama.manifest.schemaVersion,
      declaredWorkspaceMode: drama.workspaceMode,
      visibleRoute: "material-studio",
      rendererProjectRootSha256: sha256(identity.projectRoot),
      materialStudioVisible: await page.locator('[data-testid="material-studio-view"]').isVisible(),
      novelStudioCount: await page.locator('[data-testid="novel-studio-view"]').count(),
    };
    await closeApplication(application);
    application = undefined;
  }

  {
    const { page } = await launchFor("novel", novel.paths.root, "novel");
    await page.locator('[data-testid="novel-studio-view"]').waitFor();
    await page.locator('[data-testid="novel-readonly-banner"]').waitFor();
    if (await page.locator('[data-testid="material-studio-view"]').count()) throw new Error("纯小说工程错误渲染 MaterialStudio。");
    const statusCount = await page.locator('[data-testid="novel-summary"] > div').count();
    if (statusCount !== 8) throw new Error(`小说首页状态数不是 8：${statusCount}`);
    const identity = await readRendererRouteIdentity(page);
    if (identity.projectId !== novel.project.id || identity.workspaceMode !== "novel") {
      throw new Error(`纯小说 renderer 身份错误：${JSON.stringify(identity)}`);
    }
    await page.screenshot({ path: outputPaths.novel, animations: "disabled" });
    routeChecks.novel = {
      projectId: novel.project.id,
      manifestSchemaVersion: novel.manifest.schemaVersion,
      minimumWriterSchemaVersion: novel.manifest.minimumWriterSchemaVersion,
      declaredWorkspaceMode: novel.workspaceMode,
      visibleRoute: "novel-studio",
      rendererProjectRootSha256: sha256(identity.projectRoot),
      readonlyBannerVisible: await page.locator('[data-testid="novel-readonly-banner"]').isVisible(),
      homepageStatusCount: statusCount,
      materialStudioCount: await page.locator('[data-testid="material-studio-view"]').count(),
    };
    await closeApplication(application);
    application = undefined;
  }

  {
    const { page } = await launchFor("hybrid-before-switch", hybrid.paths.root, "hybrid-before");
    await page.locator('[data-testid="novel-studio-view"]').waitFor();
    await page.locator('[data-testid="novel-workspace-switch"]').waitFor();
    const identityBeforeSwitch = await readRendererRouteIdentity(page);
    if (identityBeforeSwitch.projectId !== hybrid.project.id || identityBeforeSwitch.workspaceMode !== "hybrid") {
      throw new Error(`hybrid 切换前 renderer 身份错误：${JSON.stringify(identityBeforeSwitch)}`);
    }
    await page.screenshot({ path: outputPaths.hybridNovel, animations: "disabled" });
    hybridReadonlyTreeAfterNovelShell = await treeDigest(hybrid.paths.root);
    if (JSON.stringify(projectTreesBefore.hybrid) !== JSON.stringify(hybridReadonlyTreeAfterNovelShell)) {
      throw new Error(`hybrid 小说只读壳改变了项目树：${JSON.stringify(
        treeDelta(projectTreesBefore.hybrid, hybridReadonlyTreeAfterNovelShell),
      )}`);
    }
    await page.locator('[data-testid="novel-switch-drama"]').click();
    await page.locator('[data-testid="managed-drama-workspace"]').waitFor();
    await page.locator('[data-testid="hybrid-drama-workspace-switch"]').waitFor();
    await waitForMaterialReady(page);
    const identityAfterSwitch = await readRendererRouteIdentity(page);
    const preferenceAfterClick = await getActiveHybridWorkspacePreference(hybrid.project.id);
    if (preferenceAfterClick?.mode !== "drama") throw new Error("hybrid 点击切换后没有持久化 drama 偏好。");
    routeChecks.hybridBeforeRestart = {
      projectId: hybrid.project.id,
      rendererProjectRootSha256: sha256(identityBeforeSwitch.projectRoot),
      projectRootStable: identityBeforeSwitch.projectRoot === identityAfterSwitch.projectRoot,
      projectIdStable: identityBeforeSwitch.projectId === identityAfterSwitch.projectId,
      defaultVisibleRoute: "novel-studio",
      switchedVisibleRoute: "material-studio",
      persistedPreference: preferenceAfterClick.mode,
    };
    await closeApplication(application);
    application = undefined;
  }

  {
    const { page } = await launchFor("hybrid-after-restart", hybrid.paths.root, "hybrid-after");
    await page.locator('[data-testid="managed-drama-workspace"]').waitFor();
    await page.locator('[data-testid="hybrid-drama-workspace-switch"]').waitFor();
    await waitForMaterialReady(page);
    if (await page.locator('[data-testid="novel-studio-view"]').count()) throw new Error("hybrid 重启后没有恢复已保存的 drama 工作区。");
    const identityAfterRestart = await readRendererRouteIdentity(page);
    const beforeRestartRoute = routeChecks.hybridBeforeRestart as {
      rendererProjectRootSha256: string;
      projectId: string;
    };
    const rootSharedAcrossModes = beforeRestartRoute.rendererProjectRootSha256 === sha256(identityAfterRestart.projectRoot);
    const projectIdSharedAcrossModes = beforeRestartRoute.projectId === identityAfterRestart.projectId;
    if (!rootSharedAcrossModes || !projectIdSharedAcrossModes) {
      throw new Error("hybrid 切换/重启后工程根或 projectId 发生变化。");
    }
    await page.screenshot({ path: outputPaths.hybridDrama, animations: "disabled" });
    routeChecks.hybridAfterRestart = {
      projectId: hybrid.project.id,
      declaredWorkspaceMode: hybrid.workspaceMode,
      manifestSchemaVersion: hybrid.manifest.schemaVersion,
      minimumWriterSchemaVersion: hybrid.manifest.minimumWriterSchemaVersion,
      restoredVisibleRoute: "material-studio",
      rendererProjectRootSha256: sha256(identityAfterRestart.projectRoot),
      hybridSwitchVisible: await page.locator('[data-testid="hybrid-drama-workspace-switch"]').isVisible(),
      projectRootSharedAcrossModes: rootSharedAcrossModes,
      projectIdSharedAcrossModes,
    };
    await closeApplication(application);
    application = undefined;
  }

  for (const [key, observed] of Object.entries(diagnostics)) {
    if (observed.pageErrors.length || observed.consoleErrors.length || observed.externalRequests.length) {
      throw new Error(`${key} Electron 诊断不干净：${JSON.stringify(observed)}`);
    }
  }

  const manifestAfter = Object.fromEntries(await Promise.all(Object.entries(shells).map(async ([mode, shell]) => [
    mode,
    await fileIdentity(shell.paths.manifest),
  ])));
  if (JSON.stringify(manifestBefore) !== JSON.stringify(manifestAfter)) {
    throw new Error("Electron 路由 smoke 改写了受管工程 manifest。");
  }

  const forbiddenNovelPaths = [
    "manuscript",
    "story-bible",
    path.join(".aicanvas", "novel"),
  ];
  const forbiddenPathChecks: Record<string, Record<string, boolean>> = {};
  for (const [mode, shell] of Object.entries({ novel, hybrid })) {
    forbiddenPathChecks[mode] = {};
    for (const relative of forbiddenNovelPaths) {
      const exists = await access(path.join(shell.paths.root, relative)).then(() => true, () => false);
      forbiddenPathChecks[mode][relative.split(path.sep).join("/")] = exists;
      if (exists) throw new Error(`${mode} P1 只读壳错误创建了小说事实路径：${relative}`);
    }
  }

  const projectTreesAfter = {
    novel: await treeDigest(novel.paths.root),
    hybrid: await treeDigest(hybrid.paths.root),
  };
  if (JSON.stringify(projectTreesBefore.novel) !== JSON.stringify(projectTreesAfter.novel)) {
    throw new Error(`P1 纯小说路由改变了项目树；只读壳验收失败：${JSON.stringify(
      treeDelta(projectTreesBefore.novel, projectTreesAfter.novel),
    )}`);
  }
  if (!hybridReadonlyTreeAfterNovelShell) throw new Error("缺少 hybrid 小说只读壳树快照。");
  const hybridDramaTreeDelta = treeDelta(hybridReadonlyTreeAfterNovelShell, projectTreesAfter.hybrid);
  const isLegacyDramaLedgerRecord = (record: string): boolean => (
    /^f\t\.aicanvas\/studio-generation-ledger\.sqlite(?:-(?:shm|wal))?\t/u.test(record)
  );
  const unexpectedHybridDramaChanges = [
    ...hybridDramaTreeDelta.added,
    ...hybridDramaTreeDelta.removed,
  ].filter((record) => !isLegacyDramaLedgerRecord(record));
  if (unexpectedHybridDramaChanges.length > 0) {
    throw new Error(`hybrid 切入既有短剧工作区后出现非 generation ledger 写入：${JSON.stringify(
      unexpectedHybridDramaChanges,
    )}`);
  }
  const pureNovelGenerationLedgerRemainedAbsent = {
    database: !await access(novel.paths.generationDatabase).then(() => true, () => false),
    packCas: !await access(novel.paths.generationPackCas).then(() => true, () => false),
  };
  if (!pureNovelGenerationLedgerRemainedAbsent.database || !pureNovelGenerationLedgerRemainedAbsent.packCas) {
    throw new Error("纯小说 shell 打开期间重新创建了已移除的 generation ledger。");
  }

  const screenshotFiles = {
    drama: outputPaths.drama,
    novel: outputPaths.novel,
    hybridNovelBeforeSwitch: outputPaths.hybridNovel,
    hybridDramaAfterRestart: outputPaths.hybridDrama,
  } as const;
  const screenshotIdentities: Record<keyof typeof screenshotFiles, Awaited<ReturnType<typeof screenshotIdentity>>> = {
    drama: await screenshotIdentity(screenshotFiles.drama),
    novel: await screenshotIdentity(screenshotFiles.novel),
    hybridNovelBeforeSwitch: await screenshotIdentity(screenshotFiles.hybridNovelBeforeSwitch),
    hybridDramaAfterRestart: await screenshotIdentity(screenshotFiles.hybridDramaAfterRestart),
  };

  const evidence = {
    schemaVersion: 1,
    kind: "novel-workspace-routing-electron-smoke",
    verdict: "PASS",
    capturedAt: new Date().toISOString(),
    buildIdentity: {
      sourceDigest: buildManifest.sourceDigest,
      buildId: buildManifest.buildId,
      buildIdentityFingerprint: buildManifest.buildIdentityFingerprint,
      releaseManifest: await fileIdentity(buildManifestPath),
    },
    fixture: {
      isolated: true,
      formalNovelSourceUsed: false,
      activeProductionProjectUsed: false,
      temporaryRegistry: true,
      temporaryUserData: true,
    },
    routes: routeChecks,
    diagnostics,
    manifestStable: JSON.stringify(manifestBefore) === JSON.stringify(manifestAfter),
    readOnlyProjectTreesStable: {
      novel: JSON.stringify(projectTreesBefore.novel) === JSON.stringify(projectTreesAfter.novel),
      hybridBeforeDramaSwitch: JSON.stringify(projectTreesBefore.hybrid) === JSON.stringify(hybridReadonlyTreeAfterNovelShell),
    },
    hybridDramaWorkspaceTreeDelta: {
      expectedLegacyGenerationLedgerOnly: unexpectedHybridDramaChanges.length === 0,
      added: hybridDramaTreeDelta.added,
      removed: hybridDramaTreeDelta.removed,
    },
    noNovelAuthorityPathsCreated: forbiddenPathChecks,
    pureNovelGenerationLedgerRemainedAbsent,
    screenshots: Object.fromEntries(Object.entries(screenshotIdentities).map(([key, identity]) => [
      key,
      {
        relativePath: path.relative(
          sourceWorkspace,
          screenshotFiles[key as keyof typeof screenshotFiles],
        ).split(path.sep).join("/"),
        ...identity,
      },
    ])),
  };

  await writeFile(outputPaths.route, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(outputPaths.route, 0o600);
  evidenceWritten = true;
  process.stdout.write(`${JSON.stringify({ verdict: "PASS", routeEvidence: outputPaths.route, screenshots: screenshotIdentities }, null, 2)}\n`);
} finally {
  await closeApplication(application);
  if (!evidenceWritten) {
    await Promise.all(Object.values(outputPaths).map((output) => rm(output, { force: true })));
  }
  if (priorRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistry;
  await rm(temporaryRoot, { recursive: true, force: true });
}
