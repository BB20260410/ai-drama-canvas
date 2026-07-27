/**
 * 本机创作项目导入的源码版 Electron 项目中心烟测。
 *
 * 边界：
 * - 使用真实项目注册表的只读镜像和真实项目目录；
 * - 不点击任何项目行，不切换工程，不触发生成或业务写操作；
 * - 真实 ~/.aicanvas/active-project.json 必须在前后保持逐字节一致；
 * - 证据文件只创建一次，拒绝覆盖。
 */
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import sharp from "sharp";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspace, "docs", "evidence", "local-creative-project-ingestion-20260725");
const evidencePath = path.resolve(process.argv[2] ?? path.join(evidenceRoot, "project-center-source-electron-smoke-v5.json"));
const screenshotPath = path.resolve(process.argv[3] ?? path.join(evidenceRoot, "project-center-source-electron-smoke-v5.png"));
const realRegistryPath = path.join(os.homedir(), ".aicanvas", "projects.json");
const realActiveProjectPath = path.join(os.homedir(), ".aicanvas", "active-project.json");

interface FileIdentity {
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
}

interface ActiveProjectState {
  primaryRoot: string;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileIdentity(filePath: string): Promise<FileIdentity> {
  const [metadata, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
  return {
    sizeBytes: metadata.size,
    mtimeMs: metadata.mtimeMs,
    sha256: sha256(bytes),
  };
}

async function collectBuildIdentity(): Promise<Array<{ path: string; sizeBytes: number; sha256: string }>> {
  const rendererAssetsRoot = path.join(workspace, "out", "renderer", "assets");
  const rendererEntries = await readdir(rendererAssetsRoot, { withFileTypes: true });
  const files = [
    path.join(workspace, "out", "main", "index.js"),
    path.join(workspace, "out", "preload", "index.mjs"),
    path.join(workspace, "out", "renderer", "index.html"),
    ...rendererEntries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(rendererAssetsRoot, entry.name)),
  ].sort((left, right) => left.localeCompare(right));
  return Promise.all(files.map(async (filePath) => ({
    path: path.relative(workspace, filePath).split(path.sep).join("/"),
    sizeBytes: (await stat(filePath)).size,
    sha256: sha256(await readFile(filePath)),
  })));
}

function assertOutputInsideEvidenceRoot(output: string): void {
  const relative = path.relative(evidenceRoot, output);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`证据必须写入 ${evidenceRoot}：${output}`);
  }
}

async function assertAbsent(filePath: string): Promise<void> {
  await access(filePath).then(
    () => { throw new Error(`证据已存在，拒绝覆盖：${filePath}`); },
    () => undefined,
  );
}

async function textList(locator: ReturnType<Page["locator"]>): Promise<string[]> {
  return locator.evaluateAll((elements) => elements.map((element) => (element.textContent ?? "").replace(/\s+/gu, " ").trim()));
}

for (const output of [evidencePath, screenshotPath]) {
  assertOutputInsideEvidenceRoot(output);
  await assertAbsent(output);
}
await mkdir(evidenceRoot, { recursive: true });

const realActiveBefore = await fileIdentity(realActiveProjectPath);
const realRegistryIdentity = await fileIdentity(realRegistryPath);
const activeState = JSON.parse(await readFile(realActiveProjectPath, "utf8")) as ActiveProjectState;
if (!activeState.primaryRoot?.trim()) throw new Error("真实活动项目登记缺少 primaryRoot。");

const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-local-project-center-ui-")));
const mirrorRegistryPath = path.join(temporaryRoot, "registry", "projects.json");
const mirrorActiveProjectPath = path.join(temporaryRoot, "registry", "active-project.json");
const userDataDir = path.join(temporaryRoot, "electron-user-data");
const temporaryScreenshotPath = path.join(temporaryRoot, "project-center.png");
await Promise.all([
  mkdir(path.dirname(mirrorRegistryPath), { recursive: true }),
  mkdir(userDataDir, { recursive: true }),
]);
await Promise.all([
  copyFile(realRegistryPath, mirrorRegistryPath),
  copyFile(realActiveProjectPath, mirrorActiveProjectPath),
]);
const mirrorActiveBefore = await fileIdentity(mirrorActiveProjectPath);

let application: ElectronApplication | undefined;
let evidenceWritten = false;
let screenshotWritten = false;
try {
  const build = await collectBuildIdentity();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const launchedAt = performance.now();
  application = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    cwd: workspace,
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: "",
      AI_CANVAS_PROJECT_ROOT: activeState.primaryRoot,
      AI_CANVAS_REGISTRY_PATH: mirrorRegistryPath,
      AI_CANVAS_WINDOW_WIDTH: "1920",
      AI_CANVAS_WINDOW_HEIGHT: "1200",
    },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(90_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (entry) => {
    if (entry.type() === "error") consoleErrors.push(entry.text());
  });

  const projectButton = page.locator('[data-testid="studio-open-project-center"]');
  await projectButton.waitFor();
  const rendererReadyMs = Math.round(performance.now() - launchedAt);
  await projectButton.click();

  const dialog = page.locator('[data-testid="project-center-dialog"]');
  await dialog.waitFor();
  const duduReadonlyRecovery = dialog.locator('[data-testid="dudu-readonly-recovery"]');
  await duduReadonlyRecovery.waitFor();
  await duduReadonlyRecovery.getByText("未发现隔离续作工程", { exact: true }).waitFor();
  const duduReadonlyRecoveryErrors = await duduReadonlyRecovery.locator(".dudu-recovery-error").count();
  if (duduReadonlyRecoveryErrors) {
    throw new Error(`缺失默认保存根仍显示只读恢复错误：${await duduReadonlyRecovery.innerText()}`);
  }
  const toolbar = dialog.locator(".project-list-toolbar");
  const availableLabel = (await toolbar.locator("span").innerText()).trim();
  const unavailableToggle = toolbar.locator('button[aria-expanded]');
  const unavailableToggleLabel = (await unavailableToggle.innerText()).trim();
  const availableCount = Number.parseInt(availableLabel, 10);
  const unavailableCount = Number.parseInt(unavailableToggleLabel.replace(/\D+/gu, " "), 10);
  if (availableCount !== 26) throw new Error(`项目中心可用项目应为 26，实际 ${availableCount}。`);
  if (unavailableCount !== 27) throw new Error(`项目中心失效登记应为 27，实际 ${unavailableCount}。`);
  if (await dialog.locator(".project-row.unavailable").count()) {
    throw new Error("失效登记默认没有折叠。");
  }
  if (await unavailableToggle.getAttribute("aria-expanded") !== "false") {
    throw new Error("失效登记默认折叠状态的 aria-expanded 不是 false。");
  }

  const localRows = dialog.locator(".project-row:has(.local-import-summary)");
  await localRows.first().waitFor();
  const localProjectCount = await localRows.count();
  if (localProjectCount !== 20) {
    throw new Error(`本机创作项目应显示 20 个，实际 ${localProjectCount}。`);
  }
  const localProjectNames = await textList(localRows.locator(".project-copy > b"));
  const localLockSummaries = await textList(localRows.locator(".local-import-summary"));
  const localContentSummaries = await textList(localRows.locator(".local-import-content-summary"));
  if (localLockSummaries.length !== 20) {
    throw new Error(`本机创作项目锁记录摘要应有 20 条，实际 ${localLockSummaries.length}。`);
  }
  const ambiguousLockLabels = localLockSummaries
    .map((summary, index) => ({ name: localProjectNames[index] ?? `#${index + 1}`, summary }))
    .filter(({ summary }) => !summary.includes("锁记录") || !summary.includes("候选记录"));
  if (ambiguousLockLabels.length) {
    throw new Error(`仍有本机创作项目使用含混的锁/候选文案：${JSON.stringify(ambiguousLockLabels)}`);
  }
  if (localContentSummaries.length !== 20) {
    throw new Error(`本机创作项目内容状态应有 20 条，实际 ${localContentSummaries.length}。`);
  }
  const notCompleted = localContentSummaries
    .map((summary, index) => ({ name: localProjectNames[index] ?? `#${index + 1}`, summary }))
    .filter(({ summary }) => !/^完成\s*·/u.test(summary));
  if (notCompleted.length) {
    throw new Error(`仍有本机创作项目未显示为完成：${JSON.stringify(notCompleted)}`);
  }
  const ambiguousMediaLabels = localContentSummaries
    .map((summary, index) => ({ name: localProjectNames[index] ?? `#${index + 1}`, summary }))
    .filter(({ summary }) => !summary.includes("媒体来源") || !summary.includes("文档记录"));
  if (ambiguousMediaLabels.length) {
    throw new Error(`仍有本机创作项目使用含混的媒体/文档计数文案：${JSON.stringify(ambiguousMediaLabels)}`);
  }

  const searchInput = toolbar.getByRole("searchbox", { name: "搜索项目名称或文件夹" });
  const searchedProject = localProjectNames[0];
  if (!searchedProject) throw new Error("没有可用于搜索验证的本机创作项目。");
  await searchInput.fill(searchedProject);
  const searchMatches = dialog.locator(".project-row").filter({ hasText: searchedProject });
  await searchMatches.first().waitFor();
  const searchMatchNames = await textList(searchMatches.locator(".project-copy > b"));
  if (!searchMatchNames.includes(searchedProject)) {
    throw new Error(`搜索没有返回目标项目：${searchedProject}`);
  }
  await searchInput.fill("");
  await page.waitForFunction(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索项目名称或文件夹"]');
    return input?.value === "";
  });

  await unavailableToggle.click();
  await dialog.locator(".project-row.unavailable").first().waitFor();
  const expandedUnavailableCount = await dialog.locator(".project-row.unavailable").count();
  if (expandedUnavailableCount !== 27) {
    throw new Error(`展开后应显示 27 个失效登记，实际 ${expandedUnavailableCount}。`);
  }
  if (await unavailableToggle.getAttribute("aria-expanded") !== "true") {
    throw new Error("失效登记展开后的 aria-expanded 不是 true。");
  }
  await unavailableToggle.click();
  await page.waitForFunction(() => document.querySelectorAll(".project-row.unavailable").length === 0);

  await page.screenshot({ path: temporaryScreenshotPath, fullPage: true });
  const [screenshotIdentity, screenshotMetadata, screenshotStats] = await Promise.all([
    fileIdentity(temporaryScreenshotPath),
    sharp(temporaryScreenshotPath).metadata(),
    sharp(temporaryScreenshotPath).stats(),
  ]);
  const screenshotStdev = Math.max(...screenshotStats.channels.map((channel) => channel.stdev));
  if ((screenshotMetadata.width ?? 0) < 1_400
    || (screenshotMetadata.height ?? 0) < 850
    || screenshotIdentity.sizeBytes < 25_000
    || screenshotStdev < 5) {
    throw new Error(`截图疑似空白或尺寸不足：${JSON.stringify({
      width: screenshotMetadata.width,
      height: screenshotMetadata.height,
      sizeBytes: screenshotIdentity.sizeBytes,
      stdev: screenshotStdev,
    })}`);
  }
  if (pageErrors.length || consoleErrors.length) {
    throw new Error(`Electron 页面出现错误：${JSON.stringify({ pageErrors, consoleErrors })}`);
  }

  await application.close();
  application = undefined;
  const mirrorActiveAfter = await fileIdentity(mirrorActiveProjectPath);
  const realActiveAfter = await fileIdentity(realActiveProjectPath);
  if (realActiveAfter.sha256 !== realActiveBefore.sha256 || realActiveAfter.sizeBytes !== realActiveBefore.sizeBytes) {
    throw new Error(`真实活动项目登记发生变化：${realActiveBefore.sha256} -> ${realActiveAfter.sha256}`);
  }

  const evidence = {
    schemaVersion: 1,
    kind: "local-creative-project-center-source-electron-smoke",
    createdAt: new Date().toISOString(),
    verdict: "PASS",
    scope: {
      runtime: "workspace source build",
      registry: "真实注册表逐字节只读镜像",
      projectRoots: "真实项目目录",
      forbiddenActions: ["切换项目", "生成图片", "写业务状态", "安装", "打包"],
    },
    build,
    registry: {
      realRegistryPath,
      realRegistryIdentity,
      mirrorRegistryPath,
    },
    activeProjectGuard: {
      realActiveProjectPath,
      primaryRoot: activeState.primaryRoot,
      before: realActiveBefore,
      after: realActiveAfter,
      byteIdentical: true,
      mirrorBefore: mirrorActiveBefore,
      mirrorAfter: mirrorActiveAfter,
      note: "Electron 仅可改动临时镜像中的活动登记；真实活动登记未改变。",
    },
    ui: {
      rendererReadyMs,
      availableCount,
      unavailableCount,
      unavailableDefaultCollapsed: true,
      unavailableExpandedCount: expandedUnavailableCount,
      unavailableCanExpandAndCollapse: true,
      localCreativeProjectCount: localProjectCount,
      localCreativeCompletedCount: localContentSummaries.filter((summary) => /^完成\s*·/u.test(summary)).length,
      localCreativeLockRecordLabelCount: localLockSummaries.filter((summary) => summary.includes("锁记录")).length,
      localCreativeCandidateRecordLabelCount: localLockSummaries.filter((summary) => summary.includes("候选记录")).length,
      localCreativeMediaSourceLabelCount: localContentSummaries.filter((summary) => summary.includes("媒体来源")).length,
      localCreativeDocumentRecordLabelCount: localContentSummaries.filter((summary) => summary.includes("文档记录")).length,
      localProjectNames,
      localLockSummaries,
      localContentSummaries,
      search: {
        query: searchedProject,
        matchNames: searchMatchNames,
        passed: true,
      },
      duduReadonlyRecovery: {
        missingDefaultRootHandledAsNone: true,
        expectedText: "未发现隔离续作工程",
        visibleErrorCount: duduReadonlyRecoveryErrors,
      },
      pageErrors,
      consoleErrors,
    },
    screenshot: {
      path: screenshotPath,
      ...screenshotIdentity,
      width: screenshotMetadata.width,
      height: screenshotMetadata.height,
      format: screenshotMetadata.format,
      stdev: screenshotStdev,
      nonBlank: true,
    },
  };

  await rename(temporaryScreenshotPath, screenshotPath);
  screenshotWritten = true;
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  evidenceWritten = true;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    evidencePath,
    screenshotPath,
    localCreativeProjectCount: localProjectCount,
    localCreativeCompletedCount: evidence.ui.localCreativeCompletedCount,
    availableCount,
    unavailableCount,
    activeProjectSha256: realActiveAfter.sha256,
  }, null, 2)}\n`);
} finally {
  await application?.close().catch(() => undefined);
  if (!evidenceWritten) await rm(evidencePath, { force: true }).catch(() => undefined);
  if (!screenshotWritten) await rm(screenshotPath, { force: true }).catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
}
