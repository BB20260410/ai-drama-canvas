import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import sharp from "sharp";
import {
  executeIdempotentCommand,
  getNovelImportCommandOwnerRoot,
} from "../src/core/command-bus.js";
import { createAuthorizedNovelImportPreflight } from "../src/core/novel-import.js";
import { listRegisteredProjects, setActiveProjectRegistration } from "../src/core/sidecar.js";
import type { NovelCommandRequest } from "../src/core/novel-command-runtime.js";
import type { CanvasApi } from "../src/preload/index.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspaceRoot, "docs", "evidence", "novel-mode-lite-v1");
const profileName = process.env.NOVEL_LITE_SMOKE_PROFILE === "short100" ? "short100" : "long1m";
const runId = process.env.NOVEL_LITE_SMOKE_RUN_ID ?? (profileName === "short100" ? "lite-100-ui-smoke" : "lite-1m-ui-smoke");
if (!/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(runId)) throw new Error(`非法证据 run id：${runId}`);
const profile = profileName === "short100"
  ? {
      targetCharacters: 100,
      chapterCount: 1,
      charactersPerChapter: 100,
      minimumManagedCharacters: 75,
      anchor: "百字短篇验收锚点",
      sourceName: "百字小说.md",
      projectName: "轻量小说百字验收",
      memoryStatement: "百字短篇中的可追溯验收记忆",
      editAppendix: "本地编辑保存验收通过。",
    }
  : {
      targetCharacters: 1_000_000,
      chapterCount: 500,
      charactersPerChapter: 2_000,
      minimumManagedCharacters: 990_000,
      anchor: "轻量百万字验收锚点",
      sourceName: "百万字小说.md",
      projectName: "轻量小说百万字验收",
      memoryStatement: "百万字工程中的可追溯验收记忆",
      editAppendix: "本地编辑保存验收通过。",
    };
const evidencePath = path.join(evidenceRoot, `${runId}.json`);
const screenshotPath = path.join(evidenceRoot, `${runId}.png`);

for (const output of [evidencePath, screenshotPath]) {
  await access(output).then(
    () => { throw new Error(`证据已存在，拒绝覆盖：${output}`); },
    () => undefined,
  );
}
await mkdir(evidenceRoot, { recursive: true });

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildCorpus(): string {
  const bodyPattern = "山海之间，风从古蜀群山吹过。嘟嘟循着气味前行，远处铜铃回应。";
  const chapters: string[] = [];
  const anchorChapter = profile.chapterCount === 1 ? 1 : 377;
  for (let index = 1; index <= profile.chapterCount; index += 1) {
    const heading = `# 第${String(index).padStart(3, "0")}章 ${profile.chapterCount === 1 ? "本地短篇验证" : "本地长篇验证"}\n\n`;
    const special = index === anchorChapter ? `${profile.anchor}。` : "";
    const required = profile.charactersPerChapter - heading.length - special.length - 2;
    if (required < 0) throw new Error(`夹具章节预算不足：${profile.charactersPerChapter}`);
    const body = bodyPattern.repeat(Math.ceil(required / bodyPattern.length)).slice(0, required);
    chapters.push(`${heading}${special}${body}\n\n`);
  }
  const corpus = chapters.join("");
  if (corpus.length !== profile.targetCharacters) throw new Error(`小说夹具长度错误：${corpus.length}`);
  return corpus;
}

interface Diagnostics {
  pageErrors: string[];
  consoleErrors: string[];
  externalRequests: string[];
}

function observe(page: Page, diagnostics: Diagnostics): void {
  page.on("pageerror", (entry) => diagnostics.pageErrors.push(entry.message));
  page.on("console", (entry) => {
    if (entry.type() === "error") diagnostics.consoleErrors.push(entry.text());
  });
  page.on("request", (request) => {
    if (/^https?:/iu.test(request.url())) diagnostics.externalRequests.push(request.url());
  });
}

async function closeApplication(application: ElectronApplication | undefined): Promise<void> {
  if (!application) return;
  const child = application.process();
  const graceful = application.close().then(() => true).catch(() => false);
  const closed = await Promise.race([
    graceful,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (closed || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const temporaryRoot = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), `ai-canvas-novel-lite-${profileName}-`)));
const sourceRoot = path.join(temporaryRoot, "source");
const sourcePath = path.join(sourceRoot, profile.sourceName);
const projectsRoot = path.join(temporaryRoot, "projects");
const registryPath = path.join(temporaryRoot, "registry", "projects.json");
const userDataPath = path.join(temporaryRoot, "user-data");
await Promise.all([
  mkdir(sourceRoot),
  mkdir(projectsRoot),
  mkdir(path.dirname(registryPath), { recursive: true }),
  mkdir(userDataPath),
]);

const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
let application: ElectronApplication | undefined;
let completed = false;

try {
  const corpus = buildCorpus();
  await writeFile(sourcePath, corpus, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const sourceBefore = {
    bytes: (await stat(sourcePath)).size,
    sha256: sha256(await readFile(sourcePath)),
  };

  const preflightStartedAt = performance.now();
  const authorized = await createAuthorizedNovelImportPreflight(sourcePath);
  const preflightMs = Math.round(performance.now() - preflightStartedAt);
  if (!authorized.preflight.eligible || !authorized.authorization) throw new Error("小说来源预检未通过。 ");
  if (authorized.preflight.summary.charCount !== profile.targetCharacters || authorized.preflight.summary.chapterCount !== profile.chapterCount) {
    throw new Error(`预检规模不正确：${JSON.stringify(authorized.preflight.summary)}`);
  }

  const request: Extract<NovelCommandRequest, { command: "novel_import_external_snapshot" }> = {
    command: "novel_import_external_snapshot",
    payload: {
      projectsRoot,
      projectName: profile.projectName,
      preflightId: authorized.preflight.preflightId,
      preflightFingerprint: authorized.preflight.fingerprint,
      sourceTreeAggregateSha256: authorized.preflight.sourceTreeAggregateSha256,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
      preflightAuthorization: authorized.authorization.authorizationId,
    },
  };
  const importStartedAt = performance.now();
  const commandResult = await executeIdempotentCommand(getNovelImportCommandOwnerRoot(), {
    requestId: `${runId}-import-request`,
    idempotencyKey: `${runId}-${authorized.preflight.fingerprint.slice(0, 40)}`,
    request,
  });
  const importMs = Math.round(performance.now() - importStartedAt);
  if (commandResult.status !== "succeeded") throw new Error(`小说导入命令未成功：${commandResult.status}`);
  const receipt = (commandResult.result as { receipt?: { projectId?: string } }).receipt;
  if (!receipt?.projectId) throw new Error("小说导入结果缺少 projectId。 ");
  const registration = (await listRegisteredProjects()).find((entry) => entry.id === receipt.projectId);
  if (!registration) throw new Error("小说导入工程未注册。 ");
  const projectRoot = await realpath(registration.primaryRoot);
  await setActiveProjectRegistration(projectRoot);

  const sourceAfterImport = {
    bytes: (await stat(sourcePath)).size,
    sha256: sha256(await readFile(sourcePath)),
  };
  if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfterImport)) {
    throw new Error("小说导入改写了原始来源。 ");
  }

  const diagnostics: Diagnostics = { pageErrors: [], consoleErrors: [], externalRequests: [] };
  const launchStartedAt = performance.now();
  application = await electron.launch({
    args: [".", `--user-data-dir=${userDataPath}`],
    cwd: workspaceRoot,
    env: {
      ...process.env,
      AI_CANVAS_MCP_ALLOW_MULTI: "1",
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_PROJECT_ROOT: projectRoot,
      AI_CANVAS_MANAGED_PROJECTS_ROOT: projectsRoot,
      AI_CANVAS_WORKSPACE: workspaceRoot,
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const page = await application.firstWindow();
  observe(page, diagnostics);
  page.setDefaultTimeout(90_000);
  await page.setViewportSize({ width: 1728, height: 1029 });
  await page.locator('[data-testid="root-runtime-write-gate"]').waitFor({ state: "detached" });
  await page.locator('[data-testid="novel-studio-view"]').waitFor();
  await page.locator('[data-testid="novel-chapter-editor"]').waitFor();
  const workspaceReadyMs = Math.round(performance.now() - launchStartedAt);

  const searchStartedAt = performance.now();
  await page.locator('[data-testid="novel-search-input"]').fill(profile.anchor);
  await page.locator('[data-testid="novel-search-submit"]').click();
  const resultButton = page.locator('[data-testid="novel-search-results"] > button').first();
  await resultButton.waitFor();
  const searchMs = Math.round(performance.now() - searchStartedAt);
  await resultButton.click();

  const editor = page.locator('[data-testid="novel-chapter-editor"]');
  await page.waitForFunction((selectedText) => {
    const textarea = document.querySelector('[data-testid="novel-chapter-editor"]') as HTMLTextAreaElement | null;
    return textarea?.value.includes(String(selectedText)) === true;
  }, profile.anchor);
  await editor.evaluate((element, selectedText) => {
    const textarea = element as HTMLTextAreaElement;
    const start = textarea.value.indexOf(String(selectedText));
    if (start < 0) throw new Error("搜索结果未跳转到验收锚点。 ");
    textarea.focus();
    textarea.setSelectionRange(start, start + String(selectedText).length);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
  }, profile.anchor);
  const originalChapterContent = await editor.inputValue();
  const saveStartedAt = performance.now();
  await editor.fill(`${originalChapterContent}\n\n${profile.editAppendix}`);
  await page.locator('[data-testid="novel-save-chapter"]').click();
  await page.locator('[data-testid="novel-save-chapter"]').filter({ hasText: "已保存" }).waitFor();
  const saveMs = Math.round(performance.now() - saveStartedAt);

  const runtimeState = await page.evaluate(async ({ selectedAnchor }) => {
    const api = (window as typeof window & { canvasApi: CanvasApi }).canvasApi;
    const active = await api.getActiveProject();
    if (!active?.available) throw new Error("Electron 没有活动小说工程。 ");
    const navigation = await api.novel.getNavigation(active.primaryRoot, { offset: 0, limit: 50 });
    const consistencySearchStartedAt = performance.now();
    const consistencySearch = await api.novel.searchChapters(active.primaryRoot, {
      query: selectedAnchor,
      limit: 200,
      maxHitsPerChapter: 5,
    });
    return {
      projectId: navigation.workspace.projectId,
      chapterCount: navigation.totals.chapterCount,
      totalCharacters: navigation.totals.charCount,
      manifestRevision: navigation.manifestRevision,
      navigationDom: {
        volumeButtons: document.querySelectorAll(".volume-toggle").length,
        chapterButtons: document.querySelectorAll(".volume-section [data-chapter-id]").length,
      },
      searchConsistency: {
        durationMs: Math.round(performance.now() - consistencySearchStartedAt),
        manifestRevision: consistencySearch.manifestRevision,
        scannedChapters: consistencySearch.scannedChapters,
        skippedExternalChanges: consistencySearch.skippedExternalChanges,
        hitCount: consistencySearch.hits.length,
      },
    };
  }, { selectedAnchor: profile.anchor });
  if (runtimeState.chapterCount !== profile.chapterCount
    || runtimeState.totalCharacters < profile.minimumManagedCharacters
    || runtimeState.navigationDom.volumeButtons > 50
    || runtimeState.navigationDom.chapterButtons > 100
    || runtimeState.searchConsistency.scannedChapters !== profile.chapterCount
    || runtimeState.searchConsistency.skippedExternalChanges !== 0
    || runtimeState.searchConsistency.hitCount < 1) {
    throw new Error(`Electron 小说状态不符合预期：${JSON.stringify(runtimeState)}`);
  }

  await page.screenshot({ path: screenshotPath, animations: "disabled" });
  const screenshotBytes = await readFile(screenshotPath);
  const image = sharp(screenshotBytes);
  const [metadata, statistics] = await Promise.all([image.metadata(), image.stats()]);
  if ((metadata.width ?? 0) < 1400 || (metadata.height ?? 0) < 850 || screenshotBytes.byteLength < 40_000 || statistics.entropy < 1.1) {
    throw new Error("小说轻量工作区截图机械质量不足。 ");
  }
  if (diagnostics.pageErrors.length || diagnostics.consoleErrors.length || diagnostics.externalRequests.length) {
    throw new Error(`Electron 诊断不干净：${JSON.stringify(diagnostics)}`);
  }

  const sourceAfterUi = {
    bytes: (await stat(sourcePath)).size,
    sha256: sha256(await readFile(sourcePath)),
  };
  if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfterUi)) {
    throw new Error("Electron 写作流程改写了原始来源。 ");
  }

  const evidence = {
    schemaVersion: 1,
    kind: `novel-lite-${profileName}-electron-smoke`,
    verdict: "PASS",
    capturedAt: new Date().toISOString(),
    scope: {
      profile: profileName,
      targetCharacters: profile.targetCharacters,
      chapterCount: profile.chapterCount,
      originalSourceReadOnly: true,
      remoteServicesUsed: false,
      installedApplicationReplaced: false,
    },
    timingsMs: { preflight: preflightMs, import: importMs, workspaceReady: workspaceReadyMs, fullTextSearch: searchMs, editSave: saveMs },
    runtimeState,
    sourceIdentity: sourceBefore,
    sourceStableAfterImportAndUi: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfterUi),
    diagnostics,
    screenshot: {
      relativePath: path.relative(workspaceRoot, screenshotPath).split(path.sep).join("/"),
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
  process.stdout.write(`${JSON.stringify({ verdict: "PASS", evidencePath, screenshotPath, timingsMs: evidence.timingsMs }, null, 2)}\n`);
} finally {
  await closeApplication(application);
  if (!completed) await Promise.all([evidencePath, screenshotPath].map((output) => rm(output, { force: true })));
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
  await rm(temporaryRoot, { recursive: true, force: true });
}
