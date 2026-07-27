import { execFile } from "node:child_process";
import { access, copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getProjectSnapshot } from "../src/core/codex.js";
import { createEditProject, startEditRender, waitForEditRender } from "../src/core/editor.js";
import { listProjectLocks } from "../src/core/locks.js";
import { listPublicationReceipts } from "../src/core/publication.js";
import { scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import { mkdtempOwnedFixtureRoot, resetOwnedFixtureRoot } from "./lib/owned-fixture-root.js";

const execFileAsync = promisify(execFile);
const root = process.argv[2]
  ? await resetOwnedFixtureRoot(path.resolve(process.argv[2]), "scan-render-contention-smoke")
  : (await mkdtempOwnedFixtureRoot("ai-canvas-scan-render-contention", "scan-render-contention-smoke")).root;
const metricsPath = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const unitCount = Math.max(12, Math.min(48, Number(process.argv[4]) || 24));

const config = await ensureSidecar(root);
config.name = "扫描与真实渲染并发验收";
config.sourceRoots = [];
config.outputRoots = [root];
config.hardLocks = [];
await writeJsonAtomic(getSidecarPaths(root).config, config);

const sourcePath = path.join(root, ".contention-source.mp4");
await execFileAsync("ffmpeg", [
  "-v", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
  "-t", "1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p",
  sourcePath,
], { maxBuffer: 2_000_000 });

for (let index = 1; index <= unitCount; index += 1) {
  const unit = String(index).padStart(3, "0");
  const directory = path.join(root, `EP01_15s_${unit}_并发验收`);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "00_信息.md"), `# EP01_15s_${unit}\n\n扫描与成片渲染真实并发验收夹具。\n视频最终状态：通过\n`, "utf8"),
    copyFile(sourcePath, path.join(directory, `EP01_15s_${unit}_v001.mp4`)),
  ]);
}

const baseline = await scanAndPersist(root);
if (baseline.summary.total !== unitCount) throw new Error(`基线只识别到 ${baseline.summary.total}/${unitCount} 个生产单元。`);
const editProject = await createEditProject(root, { name: "EP01_15s_099_并发验收成片", episode: 1, width: 1280, height: 720, fps: 30 });
const clipCount = editProject.tracks.find((track) => track.kind === "visual")?.clips.length ?? 0;
if (clipCount !== unitCount) throw new Error(`剪辑工程只载入 ${clipCount}/${unitCount} 个视频片段。`);

const renderStarted = await startEditRender(root, editProject.id, { expectedRevision: editProject.revision });
for (let attempt = 0; attempt < 500; attempt += 1) {
  if (await stat(renderStarted.outputPath).then((metadata) => metadata.size > 0).catch(() => false)) break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (!(await stat(renderStarted.outputPath).then((metadata) => metadata.size > 0).catch(() => false))) {
  throw new Error("后台 FFmpeg 没有在 5 秒内创建真实输出，无法执行并发扫描验收。 ");
}

const scanStartedAt = Date.now();
const renderAliveAtScanStart = Boolean(renderStarted.pid && (() => { try { process.kill(renderStarted.pid!, 0); return true; } catch { return false; } })());
const machineAtScanStart = (await getProjectSnapshot(root)).runtimeResources.machineMedia;
let scanCompletedAt = 0;
const duringRender = await scanAndPersist(root, { includeHashes: true }).finally(() => { scanCompletedAt = Date.now(); });
const renderAliveAtScanCompletion = Boolean(renderStarted.pid && (() => { try { process.kill(renderStarted.pid!, 0); return true; } catch { return false; } })());
const rendered = await waitForEditRender(root, renderStarted.id);
if (rendered.status !== "succeeded") throw new Error(`后台成片导出失败：${rendered.error ?? "未知错误"}`);
if (!duringRender.scanStats?.reservedPublicationFilesSkipped) throw new Error("并发扫描没有记录跳过写入中的预留成片输出。 ");
if (duringRender.artifacts.some((artifact) => path.resolve(artifact.path) === path.resolve(rendered.outputPath))) {
  throw new Error("扫描把仍处于发布预留状态的成片输出写进了素材索引。 ");
}

const finalIndex = await scanAndPersist(root, { includeHashes: true });
const finalRenderArtifact = finalIndex.artifacts.find((artifact) => path.resolve(artifact.path) === path.resolve(rendered.outputPath));
if (!finalRenderArtifact?.check.ok) throw new Error("发布注册后的成片没有在下一次扫描中作为可解码素材恢复。 ");
const receipts = await listPublicationReceipts(root);
const renderReceipt = receipts.find((receipt) => receipt.intentId === rendered.publicationIntentId);
if (!renderReceipt || renderReceipt.targetPath !== rendered.outputPath) throw new Error("真实成片完成后没有形成匹配的发布回执。 ");
await access(rendered.outputPath);
const outputSize = (await stat(rendered.outputPath)).size;
const { stdout: probeStdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", rendered.outputPath], { maxBuffer: 2_000_000 });
const probe = JSON.parse(probeStdout) as { streams?: Array<{ codec_type?: string; width?: number; height?: number }>; format?: { duration?: string } };
if (!probe.streams?.some((stream) => stream.codec_type === "video" && stream.width === 1280 && stream.height === 720)) throw new Error("真实成片没有通过 1280x720 视频流复核。 ");
const snapshot = await getProjectSnapshot(root);
const locks = await listProjectLocks(root);
if (locks.length) throw new Error(`验收结束后仍有项目锁：${locks.map((lock) => lock.name).join("、")}`);
if (snapshot.runtimeResources.scan.active || snapshot.runtimeResources.editor.activeRenderIds.length || snapshot.runtimeResources.blockedActions.length) {
  throw new Error("验收结束后统一资源快照没有恢复空闲。 ");
}

const renderCompletedAt = Date.parse(rendered.completedAt ?? "");
const metrics = {
  schemaVersion: 1,
  root,
  unitCount,
  clipCount,
  baseline: { scanId: baseline.scanId, durationMs: baseline.scanDurationMs, stats: baseline.scanStats },
  contention: {
    scanId: duringRender.scanId,
    durationMs: duringRender.scanDurationMs,
    wallDurationMs: scanCompletedAt - scanStartedAt,
    stats: duringRender.scanStats,
    skippedOutputPath: rendered.outputPath,
    outputIndexedWhileReserved: false,
    renderAliveAtScanStart,
    renderAliveAtScanCompletion,
    // 时间区间有交集只要求扫描开始时渲染仍活着，且渲染完成时间晚于扫描开始；
    // 渲染在扫描结束前正常完成仍然是有效重叠，不应被误判为失败。
    overlapObserved: renderAliveAtScanStart && Number.isFinite(renderCompletedAt) && scanStartedAt < renderCompletedAt,
    machineAtScanStart,
    registeredOutputIndexedAfterCompletion: true,
    registeredArtifactId: finalRenderArtifact.id,
  },
  render: {
    id: rendered.id,
    pid: renderStarted.pid,
    status: rendered.status,
    durationSeconds: rendered.durationSeconds,
    outputPath: rendered.outputPath,
    outputSize,
    publicationIntentId: rendered.publicationIntentId,
    publicationReceiptId: rendered.publicationReceiptId,
    probe,
  },
  recovery: {
    finalScanId: finalIndex.scanId,
    finalStats: finalIndex.scanStats,
    activeScan: snapshot.runtimeResources.scan.active,
    activeRenderIds: snapshot.runtimeResources.editor.activeRenderIds,
    blockedActions: snapshot.runtimeResources.blockedActions,
    locks,
  },
  verifiedAt: new Date().toISOString(),
};
if (!metrics.contention.overlapObserved) throw new Error("没有观察到扫描与真实后台渲染的时间重叠。 ");
if (metricsPath) {
  await mkdir(path.dirname(metricsPath), { recursive: true });
  await writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
