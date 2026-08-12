import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { executeIdempotentCommand, type IdempotentCommandInput } from "../src/core/command-bus.js";
import { createManagedProject } from "../src/core/managed-project.js";
import { NovelRepository } from "../src/core/novel-manuscript.js";
import {
  registerProject,
  setActiveHybridWorkspacePreference,
  setActiveProjectRegistration,
} from "../src/core/sidecar.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalContent = "青铜树下，守夜人把第一份记录写进正文。";
const cancelledWorkspaceDraft = `${originalContent}\n\n这段修改必须在取消切换后仍留在编辑器，但不能写入磁盘。`;
const savedOnCloseContent = `${originalContent}\n\n这段修改必须在关闭窗口时经用户确认后写入磁盘。`;

let sequence = 0;
function envelope(command: string, payload: Record<string, unknown>): IdempotentCommandInput {
  sequence += 1;
  return {
    requestId: `unsaved-guard-${sequence}-${randomUUID()}`,
    idempotencyKey: `unsaved-guard-key-${sequence}-${randomUUID()}`,
    request: { command, payload },
  } as IdempotentCommandInput;
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

async function requestNativeClose(application: ElectronApplication): Promise<void> {
  await application.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows()[0];
    if (!target) throw new Error("没有可关闭的 Electron 窗口。");
    target.close();
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

const temporaryRoot = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), "ai-canvas-unsaved-guard-")));
const projectsRoot = path.join(temporaryRoot, "projects");
const registryPath = path.join(temporaryRoot, "registry", "projects.json");
const userDataPath = path.join(temporaryRoot, "user-data");
await Promise.all([
  mkdir(projectsRoot, { recursive: true }),
  mkdir(path.dirname(registryPath), { recursive: true }),
  mkdir(userDataPath, { recursive: true }),
]);

const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
let application: ElectronApplication | undefined;

try {
  const shell = await createManagedProject({
    parentRoot: projectsRoot,
    name: "未保存正文门禁验收",
    slug: "novel-unsaved-guard",
    workspaceMode: "hybrid",
  });
  await registerProject(shell.project);
  await setActiveProjectRegistration(shell.paths.root);
  await setActiveHybridWorkspacePreference(shell.project.id, "novel");

  const initialized = await executeIdempotentCommand(shell.paths.root, envelope("novel_initialize_manuscript", {
    sourceMode: "managed_markdown",
  }), { novelWriteActor: "human_ui" });
  if (initialized.status !== "succeeded") throw new Error(`小说初始化失败：${initialized.status}`);
  const initialManifest = (initialized.result as {
    chapters: { revision: number; volumes: Array<{ volumeId: string }> };
  }).chapters;
  const volumeId = initialManifest.volumes[0]?.volumeId;
  if (!volumeId) throw new Error("初始化结果缺少默认卷。");

  const created = await executeIdempotentCommand(shell.paths.root, envelope("novel_create_chapter", {
    volumeId,
    title: "第一章 未保存保护",
    content: originalContent,
    expectedManifestRevision: initialManifest.revision,
  }), { novelWriteActor: "human_ui" });
  if (created.status !== "succeeded") throw new Error(`章节创建失败：${created.status}`);
  const chapterId = (created.result as { chapter: { chapterId: string } }).chapter.chapterId;

  const diagnostics: Diagnostics = { pageErrors: [], consoleErrors: [], externalRequests: [] };
  application = await electron.launch({
    args: [".", `--user-data-dir=${userDataPath}`],
    cwd: workspaceRoot,
    env: {
      ...process.env,
      AI_CANVAS_MCP_ALLOW_MULTI: "1",
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_PROJECT_ROOT: shell.paths.root,
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
  const editor = page.locator('[data-testid="novel-chapter-editor"]');
  await editor.waitFor();
  if (await editor.inputValue() !== originalContent) throw new Error("初始正文与磁盘夹具不一致。");

  await editor.fill(cancelledWorkspaceDraft);
  await page.locator('[data-testid="novel-switch-drama"]').click();
  const leaveDialog = page.locator('[data-testid="novel-unsaved-dialog"]');
  await leaveDialog.waitFor();
  await page.locator('[data-testid="novel-leave-cancel"]').click();
  await leaveDialog.waitFor({ state: "detached" });
  if (await editor.inputValue() !== cancelledWorkspaceDraft) {
    throw new Error("取消工作区切换后，未保存正文没有保留在编辑器。");
  }
  const diskAfterCancelledSwitch = await new NovelRepository(shell.paths.root).readChapter(chapterId);
  if (diskAfterCancelledSwitch.status !== "healthy" || diskAfterCancelledSwitch.content !== originalContent) {
    throw new Error("取消工作区切换错误地改写了权威正文。");
  }

  await page.locator('[data-testid="novel-switch-drama"]').click();
  await leaveDialog.waitFor();
  await page.locator('[data-testid="novel-leave-discard"]').click();
  await page.locator('[data-testid="managed-drama-workspace"]').waitFor();
  await page.locator('[data-testid="hybrid-switch-novel"]').click();
  await editor.waitFor();
  if (await editor.inputValue() !== originalContent) {
    throw new Error("放弃修改后重新进入小说工作区，正文没有恢复权威磁盘版本。");
  }

  await editor.fill(savedOnCloseContent);
  await requestNativeClose(application);
  await leaveDialog.waitFor();
  await page.locator('[data-testid="novel-leave-cancel"]').click();
  await leaveDialog.waitFor({ state: "detached" });
  if (page.isClosed() || await editor.inputValue() !== savedOnCloseContent) {
    throw new Error("取消关闭窗口后，窗口或未保存正文没有保留。");
  }
  const diskAfterCancelledClose = await new NovelRepository(shell.paths.root).readChapter(chapterId);
  if (diskAfterCancelledClose.status !== "healthy" || diskAfterCancelledClose.content !== originalContent) {
    throw new Error("取消关闭窗口错误地改写了权威正文。");
  }

  const pageClosed = page.waitForEvent("close", { timeout: 90_000 });
  await requestNativeClose(application);
  await leaveDialog.waitFor();
  await page.locator('[data-testid="novel-leave-save"]').click();
  await pageClosed;

  const diskAfterSavedClose = await new NovelRepository(shell.paths.root).readChapter(chapterId);
  if (diskAfterSavedClose.status !== "healthy" || diskAfterSavedClose.content !== savedOnCloseContent) {
    throw new Error("关闭窗口时选择保存，但权威正文没有持久化。");
  }
  if (diagnostics.pageErrors.length || diagnostics.consoleErrors.length || diagnostics.externalRequests.length) {
    throw new Error(`Electron 诊断不干净：${JSON.stringify(diagnostics)}`);
  }

  process.stdout.write(`${JSON.stringify({
    verdict: "PASS",
    workspaceSwitch: { cancelPreservedDraft: true, discardPreservedDisk: true },
    nativeWindowClose: { cancelKeptWindowAndDraft: true, savePersistedBeforeClose: true },
    authority: { chapterId, finalCharacters: savedOnCloseContent.length },
    diagnostics,
  }, null, 2)}\n`);
} finally {
  await closeApplication(application);
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
  await rm(temporaryRoot, { recursive: true, force: true });
}
