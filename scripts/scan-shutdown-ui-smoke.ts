import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetOwnedFixtureRoot } from "./lib/owned-fixture-root.js";

const defaultSuffix = `${process.pid}-${randomUUID()}`;
const root = path.resolve(process.argv[2] || path.join(os.tmpdir(), `ai-canvas-scan-shutdown-ui-${defaultSuffix}`));
const registryPath = path.resolve(process.argv[3] || path.join(os.tmpdir(), `ai-canvas-scan-shutdown-ui-registry-${defaultSuffix}.json`));
const screenshotPath = path.resolve(process.argv[4] || path.join(os.tmpdir(), `ai-canvas-scan-shutdown-ui-${defaultSuffix}.png`));
await Promise.all([resetOwnedFixtureRoot(root, "scan-shutdown-ui-smoke"), rm(registryPath, { force: true }), rm(screenshotPath, { force: true }), rm(`${screenshotPath}.debug.json`, { force: true })]);
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
const [{ scanAndPersist }, { ensureSidecar, getSidecarPaths, listEvents, loadIndex, writeJsonAtomic }, { listProjectLocks }] = await Promise.all([
  import("../src/core/service.js"),
  import("../src/core/sidecar.js"),
  import("../src/core/locks.js"),
]);
const config = await ensureSidecar(root);
config.name = "扫描退出恢复门禁";
config.sourceRoots = [];
config.outputRoots = [root];
await writeJsonAtomic(getSidecarPaths(root).config, config);
const unitDirectory = path.join(root, "EP01_15s_001_退出门禁");
await mkdir(unitDirectory, { recursive: true });
await writeFile(path.join(unitDirectory, "00_信息.md"), "首帧提示词：扫描退出时保留稳定快照。\n", "utf8");
const baseline = await scanAndPersist(root);
const baselineScanEvents = (await listEvents(root, 1_000)).filter((event) => event.type === "project.scanned").map((event) => event.id);

const pidPath = path.join(root, "fake-ffprobe.pid");
const markerPath = path.join(root, "fake-ffprobe.terminated");
const startLogPath = path.join(root, "fake-ffprobe.starts");
const fakeProbe = path.join(root, "fake-ffprobe.mjs");
await writeFile(fakeProbe, `#!/usr/bin/env node\nimport { appendFileSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nappendFileSync(${JSON.stringify(startLogPath)}, String(process.pid) + "\\n");\nprocess.on("SIGTERM", () => { writeFileSync(${JSON.stringify(markerPath)}, "terminated"); process.exit(143); });\nsetInterval(() => {}, 1000);\n`, "utf8");
await chmod(fakeProbe, 0o755);

const packagedExecutable = process.env.AI_CANVAS_APP_EXECUTABLE?.trim();
const executable = packagedExecutable ? path.resolve(packagedExecutable) : path.join(process.cwd(), "node_modules", ".bin", "electron");
const child = spawn(executable, packagedExecutable ? ["--disable-gpu"] : ["."], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    AI_CANVAS_REGISTRY_PATH: registryPath,
    AI_CANVAS_SCREENSHOT: screenshotPath,
    AI_CANVAS_SCREENSHOT_DELAY_MS: "5000",
    AI_CANVAS_WINDOW_WIDTH: "1280",
    AI_CANVAS_WINDOW_HEIGHT: "820",
    FFPROBE_PATH: fakeProbe,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-20_000); });
child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-20_000); });
await new Promise((resolve) => setTimeout(resolve, 1_500));
const videoPath = path.join(unitDirectory, "EP01_15s_001_退出测试.mp4");
for (let change = 1; change <= 4; change += 1) {
  await writeFile(videoPath, Buffer.alloc(60_000, change));
  await new Promise((resolve) => setTimeout(resolve, 80));
}

const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
  const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Electron 扫描退出门禁超过 20 秒。")); }, 20_000);
  child.once("error", (error) => { clearTimeout(timeout); reject(error); });
  child.once("exit", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
});
if (exit.code !== 0) throw new Error(`Electron 非正常退出：${JSON.stringify({ exit, stdout, stderr })}`);
await access(markerPath);
const pid = Number(await readFile(pidPath, "utf8"));
const probeStarts = (await readFile(startLogPath, "utf8")).trim().split("\n").filter(Boolean);
if (probeStarts.length !== 1) throw new Error(`连续文件抖动启动了 ${probeStarts.length} 轮 ffprobe，没有合并为最新扫描。`);
let probeAlive = true;
for (let attempt = 0; attempt < 100; attempt += 1) {
  try { process.kill(pid, 0); }
  catch { probeAlive = false; break; }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (probeAlive) throw new Error(`ffprobe 子进程 ${pid} 在应用退出后仍存活。`);
const after = await loadIndex(root);
const afterScanEvents = (await listEvents(root, 1_000)).filter((event) => event.type === "project.scanned").map((event) => event.id);
if (after?.scanId !== baseline.scanId) throw new Error("退出期间的取消扫描覆盖了稳定索引。 ");
if (JSON.stringify(afterScanEvents) !== JSON.stringify(baselineScanEvents)) throw new Error("退出期间的取消扫描追加了扫描完成事件。 ");
const locks = await listProjectLocks(root);
if (locks.length) throw new Error(`应用退出后仍有扫描锁：${JSON.stringify(locks)}`);
await access(screenshotPath);

process.stdout.write(`${JSON.stringify({
  root,
  registryPath,
  screenshotPath,
  transport: packagedExecutable ? "packaged-app" : "source-electron",
  baselineScanId: baseline.scanId,
  preservedScanId: after?.scanId,
  scanEventCount: afterScanEvents.length,
  probePid: pid,
  probeStarts: probeStarts.length,
  probeTerminated: true,
  locks: locks.length,
  exit,
}, null, 2)}\n`);
