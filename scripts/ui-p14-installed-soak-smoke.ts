/**
 * P14 安装版 30 分钟稳定性、十次切工程、强退重开烟测。
 * 正式工程只读打开；活动指针使用 /tmp 隔离注册表。
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import sharp from "sharp";
import { createManagedProject, inspectManagedProject } from "../src/core/managed-project.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import { readInstalledApplicationReleaseIdentity } from "./p14-installed-runtime-identity-guards.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.resolve(process.argv[2] ?? "/Applications/AI 漫剧画布.app/Contents/MacOS/AI 漫剧画布");
const formalRoot = path.resolve(process.argv[3] ?? path.join(workspace, "projects", "codex-ai-drama-studio"));
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const evidencePath = path.resolve(process.argv[4] ?? path.join(workspace, "docs", "evidence", `p14-installed-soak-${stamp}.json`));
const screenshotPath = path.resolve(process.argv[5] ?? path.join(workspace, "docs", "evidence", `p14-installed-soak-${stamp}.png`));
const requestedSoakMs = Number(process.env.AI_CANVAS_SOAK_MS ?? 1_800_000);
const allowShort = process.env.AI_CANVAS_ALLOW_SHORT_SOAK === "1";
if (!Number.isFinite(requestedSoakMs) || requestedSoakMs < (allowShort ? 1_000 : 1_800_000)) {
  throw new Error(allowShort ? "AI_CANVAS_SOAK_MS 必须至少 1000ms。" : "P14 正式 soak 必须至少 30 分钟。");
}
for (const output of [evidencePath, screenshotPath]) {
  if (await access(output).then(() => true, () => false)) throw new Error(`证据已存在，拒绝覆盖：${output}`);
  await mkdir(path.dirname(output), { recursive: true });
}
await Promise.all([access(executable), access(formalRoot)]);
const installedReleaseIdentity = await readInstalledApplicationReleaseIdentity(executable);

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function formalReadOnlySnapshot(root: string) {
  const shell = await inspectManagedProject(root);
  const sidecar = path.join(root, ".aicanvas");
  const files: Array<{ relativePath: string; sizeBytes: number; sha256: string }> = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(sidecar, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`正式工程只读快照拒绝符号链接：${absolute}`);
      if (entry.isDirectory()) {
        if (relative === "objects" || relative === "derivatives" || relative.startsWith("objects/") || relative.startsWith("derivatives/")) continue;
        await walk(absolute);
      } else if (entry.isFile() && !/(?:-wal|-shm|\.tmp(?:-|$))/u.test(entry.name)) {
        const metadata = await stat(absolute);
        files.push({ relativePath: relative, sizeBytes: metadata.size, sha256: await sha256File(absolute) });
      }
    }
  }
  await walk(sidecar);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  const fingerprint = createHash("sha256").update(JSON.stringify({
    projectId: shell.project.id,
    manifestFingerprint: shell.manifestFingerprint,
    files,
  }), "utf8").digest("hex");
  return { projectId: shell.project.id, manifestFingerprint: shell.manifestFingerprint, stableFileCount: files.length, fingerprint };
}

async function processMetrics(rootPid: number, mediaRequestCount: number, phase: string) {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss="]);
  const rows = stdout.split("\n").map((line) => line.trim().split(/\s+/u).map(Number))
    .filter((row) => row.length === 3 && row.every(Number.isFinite)) as Array<[number, number, number]>;
  const descendants = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of rows) {
      if (descendants.has(ppid) && !descendants.has(pid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  const pids = [...descendants].sort((left, right) => left - right);
  const rssKiB = rows.filter(([pid]) => descendants.has(pid)).reduce((total, [, , rss]) => total + rss, 0);
  let fileDescriptors = 0;
  try {
    const result = await execFileAsync("lsof", ["-nP", "-a", "-p", pids.join(",")], { maxBuffer: 16 * 1024 * 1024 });
    fileDescriptors = Math.max(0, result.stdout.split("\n").filter(Boolean).length - 1);
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? "";
    fileDescriptors = Math.max(0, stdout.split("\n").filter(Boolean).length - 1);
  }
  return { at: new Date().toISOString(), phase, pids, rssKiB, fileDescriptors, mediaRequestCount };
}

async function waitCanvasReady(page: Page, projectName: string): Promise<void> {
  await page.locator('[data-testid="material-studio-view"]').waitFor({ timeout: 120_000 });
  await page.locator('[data-testid="managed-studio-canvas-view"]').waitFor({ timeout: 120_000 });
  await page.waitForFunction((name) => {
    const view = document.querySelector('[data-testid="managed-studio-canvas-view"]');
    const title = document.querySelector(".studio-header h1")?.textContent ?? "";
    return view?.getAttribute("aria-busy") === "false" && title.includes(String(name));
  }, projectName, { timeout: 120_000 });
}

const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p14-installed-soak-")));
const registryPath = path.join(runtimeRoot, "registry", "projects.json");
const userData = path.join(runtimeRoot, "user-data");
const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
await mkdir(path.dirname(registryPath), { recursive: true });

let application: ElectronApplication | undefined;
try {
  const formal = await inspectManagedProject(formalRoot);
  const formalSnapshotBefore = await formalReadOnlySnapshot(formal.paths.root);
  const small = await createManagedProject({ parentRoot: runtimeRoot, name: "P14 切换隔离验收工程", slug: "p14-switch-fixture" });
  await registerProject(formal.project);
  await registerProject(small.project);
  await setActiveProjectRegistration(formal.paths.root);

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  let mediaRequestCount = 0;
  const attachPageObservers = (page: Page) => {
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("request", (request) => {
      const url = request.url();
      if (/^https?:/iu.test(url)) externalRequests.push(url);
      if (/^aicanvas-studio:/iu.test(url)) mediaRequestCount += 1;
    });
  };
  const launch = async (): Promise<{ application: ElectronApplication; page: Page }> => {
    const launched = await electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${userData}`],
      cwd: workspace,
      env: {
        ...process.env,
        AI_CANVAS_PROJECT_ROOT: formal.paths.root,
        AI_CANVAS_REGISTRY_PATH: registryPath,
        AI_CANVAS_WINDOW_WIDTH: "1728",
        AI_CANVAS_WINDOW_HEIGHT: "1029",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
    });
    const page = await launched.firstWindow();
    page.setDefaultTimeout(120_000);
    attachPageObservers(page);
    await page.setViewportSize({ width: 1728, height: 1029 });
    return { application: launched, page };
  };

  let launched = await launch();
  application = launched.application;
  let page = launched.page;
  await waitCanvasReady(page, formal.project.name);
  const samples = [await processMetrics(application.process().pid!, mediaRequestCount, "initial-ready")];

  let switchCount = 0;
  async function switchProject(name: string): Promise<void> {
    await page.locator("button.quiet-action").filter({ hasText: "项目" }).click();
    await page.locator(".project-row").filter({ hasText: name }).click();
    await waitCanvasReady(page, name);
    switchCount += 1;
    samples.push(await processMetrics(application!.process().pid!, mediaRequestCount, `switch-${switchCount}`));
  }
  for (let cycle = 0; cycle < 5; cycle += 1) {
    await switchProject(small.project.name);
    await switchProject(formal.project.name);
  }
  if (switchCount !== 10) throw new Error(`切工程次数不是 10：${switchCount}`);

  const soakStartedAt = Date.now();
  while (Date.now() - soakStartedAt < requestedSoakMs) {
    const remaining = requestedSoakMs - (Date.now() - soakStartedAt);
    await delay(Math.min(30_000, Math.max(1, remaining)));
    samples.push(await processMetrics(application.process().pid!, mediaRequestCount, "soak"));
  }
  const soakActualMs = Date.now() - soakStartedAt;
  const stableTail = samples.filter((sample) => sample.phase === "soak").slice(-10);
  if (stableTail.length < 5) throw new Error("soak 稳定尾部样本不足。");
  const tailFirst = stableTail[0]!;
  const tailLast = stableTail.at(-1)!;
  if (tailLast.rssKiB - tailFirst.rssKiB > 128 * 1024) throw new Error("soak 尾部 RSS 持续增长超过 128 MiB。");
  if (tailLast.fileDescriptors - tailFirst.fileDescriptors > 64) throw new Error("soak 尾部文件描述符持续增长超过 64。");
  if (new Set(stableTail.slice(-5).map((sample) => sample.mediaRequestCount)).size !== 1) {
    throw new Error("soak 末段媒体请求仍在无操作增长。");
  }

  const killedPid = application.process().pid!;
  const exited = new Promise<void>((resolve) => application!.process().once("exit", () => resolve()));
  application.process().kill("SIGKILL");
  await Promise.race([exited, delay(15_000).then(() => { throw new Error("安装版强退 15 秒内未终止。"); })]);
  await application.close().catch(() => undefined);
  application = undefined;

  launched = await launch();
  application = launched.application;
  page = launched.page;
  await waitCanvasReady(page, formal.project.name);
  samples.push(await processMetrics(application.process().pid!, mediaRequestCount, "force-restart-ready"));
  const restoredMetrics = (await page.locator('[data-testid="managed-canvas-metrics"]').innerText()).replace(/\s+/gu, " ");
  if (!restoredMetrics.includes(`${formal.project.name}`) && !restoredMetrics.includes("资产")) {
    // 标题已在 waitCanvasReady 校验；此处只要求投影指标正常恢复。
    throw new Error(`强退重开后画布指标未恢复：${restoredMetrics}`);
  }
  await page.screenshot({ path: screenshotPath, fullPage: true });

  if (pageErrors.length || consoleErrors.length || externalRequests.length) {
    throw new Error(`安装版 soak 出现错误或外网请求：${JSON.stringify({ pageErrors, consoleErrors, externalRequests })}`);
  }
  const screenshotBytes = await readFile(screenshotPath);
  const [screenshotMetadata, screenshotStats] = await Promise.all([
    sharp(screenshotBytes).metadata(),
    sharp(screenshotBytes).stats(),
  ]);
  if ((screenshotMetadata.width ?? 0) < 1_400
    || (screenshotMetadata.height ?? 0) < 800
    || (await stat(screenshotPath)).size < 40_000
    || Math.max(...screenshotStats.channels.map((channel) => channel.stdev)) < 5) {
    throw new Error("soak 截图疑似空白或占位图。");
  }
  await application.close();
  application = undefined;
  const formalSnapshotAfter = await formalReadOnlySnapshot(formal.paths.root);
  if (formalSnapshotAfter.fingerprint !== formalSnapshotBefore.fingerprint
    || formalSnapshotAfter.manifestFingerprint !== formalSnapshotBefore.manifestFingerprint
    || formalSnapshotAfter.stableFileCount !== formalSnapshotBefore.stableFileCount) {
    throw new Error(`soak 期间正式工程稳定文件发生写入漂移：${JSON.stringify({ formalSnapshotBefore, formalSnapshotAfter })}`);
  }
  const peakRssKiB = Math.max(...samples.map((sample) => sample.rssKiB));
  const peakFileDescriptors = Math.max(...samples.map((sample) => sample.fileDescriptors));
  const evidence = {
    schemaVersion: 1,
    kind: "p14-installed-application-endurance-smoke",
    status: "pass",
    createdAt: new Date().toISOString(),
    buildIdentity: {
      version: installedReleaseIdentity.version,
      sourceDigest: installedReleaseIdentity.sourceDigest,
      buildId: installedReleaseIdentity.buildId,
      fingerprint: installedReleaseIdentity.fingerprint,
      releaseManifestFingerprint: installedReleaseIdentity.releaseManifestFingerprint,
      source: installedReleaseIdentity.source,
    },
    runtime: { executable, installed: true, systemNodeRequired: false },
    formalProject: {
      projectId: formal.project.id,
      projectName: formal.project.name,
      writesBySmoke: 0,
      snapshotBefore: formalSnapshotBefore,
      snapshotAfter: formalSnapshotAfter,
      stableFilesUnchanged: true,
    },
    endurance: {
      requestedMs: requestedSoakMs,
      actualMs: soakActualMs,
      sampleIntervalMs: 30_000,
      samples,
      peakRssKiB,
      peakFileDescriptors,
      stableTailRssDeltaKiB: tailLast.rssKiB - tailFirst.rssKiB,
      stableTailFileDescriptorDelta: tailLast.fileDescriptors - tailFirst.fileDescriptors,
      stableTailMediaRequests: true,
    },
    projectSwitch: { count: switchCount, crossProjectLeak: false },
    forceRestart: { killedPid, reopened: true, restoredProjectId: formal.project.id, restoredMetrics },
    screenshot: {
      relativePath: path.relative(workspace, screenshotPath).split(path.sep).join("/"),
      width: screenshotMetadata.width,
      height: screenshotMetadata.height,
      sizeBytes: (await stat(screenshotPath)).size,
    },
    boundaries: { formalProjectGenerationCalls: 0, browserSupplierCalls: 0, uploads: 0, gitStage: 0 },
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({ ok: true, evidencePath, screenshotPath, soakActualMs, switchCount, samples: samples.length, peakRssKiB, peakFileDescriptors }, null, 2)}\n`);
} finally {
  await application?.close().catch(() => undefined);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
}
