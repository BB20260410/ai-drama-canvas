import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const root = path.resolve(process.argv[2] || "/tmp/ai-canvas-incremental-scan-400");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-incremental-scan-400-registry.json");
await rm(registryPath, { force: true });
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
const [{ scanAndPersist }, { listEvents, loadIndex }, { listProjectLocks }] = await Promise.all([
  import("../src/core/service.js"),
  import("../src/core/sidecar.js"),
  import("../src/core/locks.js"),
]);

const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
const fixtureRun = await execFileAsync(tsx, ["scripts/create-large-fixture.ts", "400", root, "--thumbnails"], {
  cwd: process.cwd(),
  env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath },
  maxBuffer: 2_000_000,
});
const fixture = JSON.parse(fixtureRun.stdout) as { recognized: number; scanStats?: { candidateFiles: number; inspectedChecks: number; reusedChecks: number } };
if (fixture.recognized !== 400 || fixture.scanStats?.candidateFiles !== 800 || fixture.scanStats.inspectedChecks !== 800) throw new Error(`首次 400 单元扫描统计异常：${fixtureRun.stdout}`);

const unchangedStarted = performance.now();
const unchanged = await scanAndPersist(root);
const unchangedElapsedMs = Math.round(performance.now() - unchangedStarted);
if (unchanged.scanStats?.inspectedChecks !== 0 || unchanged.scanStats.reusedChecks !== 800) throw new Error(`未变化扫描没有完整复用：${JSON.stringify(unchanged.scanStats)}`);

const changedArtifact = unchanged.artifacts.find((artifact) => artifact.kind === "raw-image" && artifact.itemId === "main-ep10-unit040");
if (!changedArtifact) throw new Error("找不到第 400 单元缩略图。 ");
await sharp({ create: { width: 271, height: 480, channels: 3, background: "#593e28" } }).png().toFile(changedArtifact.path);
const changedStarted = performance.now();
const changed = await scanAndPersist(root);
const changedElapsedMs = Math.round(performance.now() - changedStarted);
if (changed.scanStats?.inspectedChecks !== 1 || changed.scanStats.reusedChecks !== 799) throw new Error(`单文件变化扫描统计异常：${JSON.stringify(changed.scanStats)}`);
if (changed.artifacts.find((artifact) => artifact.id === changedArtifact.id)?.check.width !== 271) throw new Error("变化后的图片尺寸未进入索引。 ");

const stableIndexText = await readFile(path.join(root, ".aicanvas", "index.json"), "utf8");
const stableEvents = (await listEvents(root, 2_000)).filter((event) => event.type === "project.scanned").map((event) => event.id);
const controller = new AbortController();
let cancelProgress = 0;
try {
  await scanAndPersist(root, {
    signal: controller.signal,
    onProgress: (progress) => {
      cancelProgress = progress.completedChecks;
      if (progress.phase === "inspect" && progress.completedChecks >= 1) controller.abort("400 单元取消门禁");
    },
  });
  throw new Error("扫描取消门禁没有抛出 AbortError。 ");
} catch (error) {
  if (!(error instanceof Error && error.name === "AbortError")) throw error;
}
const afterCancel = await loadIndex(root);
const afterCancelText = await readFile(path.join(root, ".aicanvas", "index.json"), "utf8");
const afterCancelEvents = (await listEvents(root, 2_000)).filter((event) => event.type === "project.scanned").map((event) => event.id);
if (afterCancel?.scanId !== changed.scanId || afterCancelText !== stableIndexText) throw new Error("取消扫描改写了稳定索引。 ");
if (JSON.stringify(afterCancelEvents) !== JSON.stringify(stableEvents)) throw new Error("取消扫描追加了 project.scanned 事件。 ");
if ((await listProjectLocks(root)).length) throw new Error("取消扫描后仍残留项目锁。 ");

process.stdout.write(`${JSON.stringify({
  root,
  registryPath,
  fixture,
  unchanged: { elapsedMs: unchangedElapsedMs, scanDurationMs: unchanged.scanDurationMs, scanStats: unchanged.scanStats },
  oneFileChanged: { path: changedArtifact.path, elapsedMs: changedElapsedMs, scanDurationMs: changed.scanDurationMs, scanStats: changed.scanStats },
  cancellation: { progressAtAbort: cancelProgress, preservedScanId: afterCancel?.scanId, eventCount: afterCancelEvents.length, locks: 0 },
}, null, 2)}\n`);
