import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { listProjectLocks } from "../src/core/locks.js";
import { MEDIA_WEIGHTS, readMachineMediaRuntimeSnapshot, runMediaProcess } from "../src/core/media-runtime.js";
import { cancelPublication, getPublicationIntent, listPublicationIntents, listPublicationReceipts, preflightPublication, registerPublication } from "../src/core/publication.js";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";

const execFileAsync = promisify(execFile);
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const evidencePath = path.resolve(process.argv[2] || path.join("docs", "evidence", `publication-consistency-smoke-${stamp}.json`));
const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-publication-smoke-"));
const output = path.join(root, "outputs");
const ffmpeg = process.env.AI_CANVAS_FFMPEG || "ffmpeg";
const realFfprobe = process.env.AI_CANVAS_FFPROBE || "ffprobe";
process.env.AI_CANVAS_REGISTRY_PATH = path.join(root, "registry.json");
process.env.AI_CANVAS_MEDIA_RUNTIME_DIR = path.join(root, "media-runtime");
process.env.AI_CANVAS_MEDIA_CAPACITY = "4";

async function waitForPath(filePath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await access(filePath).then(() => true).catch(() => false))) {
    if (Date.now() >= deadline) throw new Error(`等待文件超时：${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

let evidence: Record<string, unknown>;
let cancellationEvidence: Record<string, unknown> | undefined;
try {
  await mkdir(output, { recursive: true });
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [output];
  await writeJsonAtomic(getSidecarPaths(root).config, config);

  const primary = await preflightPublication(root, { idempotencyKey: "smoke-publication-primary-001", requestedPath: path.join(output, "primary.mp4"), allowedRoot: output, kind: "video", context: { purpose: "edit-render", jobId: "smoke-primary" } });
  const generated = await runMediaProcess(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", primary.targetPath], { projectRoot: root, tool: "ffmpeg", stage: "publication-smoke-seed", weight: MEDIA_WEIGHTS.foreground, timeoutMs: 60_000 });
  if (generated.status !== "succeeded") throw new Error(`真实视频生成失败：${generated.output.slice(-2_000)}`);

  let validationFinished!: () => void;
  let releaseCommit!: () => void;
  const reachedCommit = new Promise<void>((resolve) => { validationFinished = resolve; });
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const registeringPrimary = registerPublication(root, { intentId: primary.id, reservationToken: primary.reservationToken, expectedRevision: primary.revision }, "codex", { beforeCommit: async () => { validationFinished(); await commitGate; } });
  await reachedCommit;
  const unrelatedStarted = Date.now();
  const unrelated = await preflightPublication(root, { idempotencyKey: "smoke-publication-unrelated-001", requestedPath: path.join(output, "unrelated.bin"), allowedRoot: output, kind: "other", context: { purpose: "other" } });
  const unrelatedPreflightMs = Date.now() - unrelatedStarted;
  releaseCommit();
  const primaryReceipt = await registeringPrimary;
  await cancelPublication(root, { intentId: unrelated.id, reservationToken: unrelated.reservationToken, expectedRevision: unrelated.revision, reason: "真实 smoke 清理无关预留" });
  const replay = await registerPublication(root, { intentId: primary.id, reservationToken: primary.reservationToken, expectedRevision: primary.revision + 1 });
  if (replay.id !== primaryReceipt.id) throw new Error("真实媒体幂等复验没有返回同一回执。 ");

  const casIntent = await preflightPublication(root, { idempotencyKey: "smoke-publication-file-cas-001", requestedPath: path.join(output, "strong-cas.bin"), allowedRoot: output, kind: "other", context: { purpose: "other" } });
  await writeFile(casIntent.targetPath, "AAAA", "utf8");
  const casBefore = await stat(casIntent.targetPath);
  const replacementPath = path.join(output, "strong-cas-replacement.tmp");
  await writeFile(replacementPath, "BBBB", "utf8");
  await utimes(replacementPath, casBefore.atime, casBefore.mtime);
  let casConflict = "";
  try {
    await registerPublication(root, { intentId: casIntent.id, reservationToken: casIntent.reservationToken, expectedRevision: casIntent.revision }, "codex", { beforeCommit: async () => { await rename(replacementPath, casIntent.targetPath); await utimes(casIntent.targetPath, casBefore.atime, casBefore.mtime); } });
  } catch (error) {
    casConflict = error instanceof Error ? error.message : String(error);
  }
  if (!/变化|CAS/.test(casConflict) || (await getPublicationIntent(root, casIntent.id))?.status !== "reserved") throw new Error("强文件身份 CAS 没有拒绝同尺寸同 mtime 原子替换。 ");
  const casReceipt = await registerPublication(root, { intentId: casIntent.id, reservationToken: casIntent.reservationToken, expectedRevision: casIntent.revision });

  const cancelledIntent = await preflightPublication(root, { idempotencyKey: "smoke-publication-cancel-race-001", requestedPath: path.join(output, "cancel-race.mp4"), allowedRoot: output, kind: "video", context: { purpose: "edit-render", jobId: "smoke-cancel" } });
  await copyFile(primary.targetPath, cancelledIntent.targetPath);
  const probeMarker = path.join(root, "delayed-probe-started");
  const probeGate = path.join(root, "delayed-probe-release");
  const delayedProbe = path.join(root, "delayed-real-ffprobe.mjs");
  await writeFile(delayedProbe, `#!/usr/bin/env node\nimport { existsSync, writeFileSync } from "node:fs";\nimport { spawn } from "node:child_process";\nwriteFileSync(${JSON.stringify(probeMarker)}, "started");\nconst timer=setInterval(()=>{if(!existsSync(${JSON.stringify(probeGate)}))return;clearInterval(timer);const child=spawn(${JSON.stringify(realFfprobe)},process.argv.slice(2),{stdio:["ignore","inherit","inherit"]});child.once("error",()=>process.exit(127));child.once("close",code=>process.exit(code??1));},10);\n`, "utf8");
  await chmod(delayedProbe, 0o755);
  const previousProbe = process.env.FFPROBE_PATH;
  process.env.FFPROBE_PATH = delayedProbe;
  let cancellationError = "";
  try {
    const registeringCancelled = registerPublication(root, { intentId: cancelledIntent.id, reservationToken: cancelledIntent.reservationToken, expectedRevision: cancelledIntent.revision });
    await waitForPath(probeMarker);
    const cancellationStarted = Date.now();
    const cancelled = await cancelPublication(root, { intentId: cancelledIntent.id, reservationToken: cancelledIntent.reservationToken, expectedRevision: cancelledIntent.revision, reason: "真实 smoke 在 ffprobe 期间取消" }, "user");
    const cancellationMs = Date.now() - cancellationStarted;
    await writeFile(probeGate, "release", "utf8");
    try { await registeringCancelled; }
    catch (error) { cancellationError = error instanceof Error ? error.message : String(error); }
    if (cancelled.status !== "cancelled" || !/cancelled|状态已变化/.test(cancellationError)) throw new Error("ffprobe 期间取消没有优先于旧校验结果。 ");
    cancellationEvidence = { cancellationMs, terminalStatus: cancelled.status, staleValidationError: cancellationError };
  } finally {
    if (previousProbe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousProbe;
    await writeFile(probeGate, "release", "utf8").catch(() => undefined);
  }

  const concurrent = await preflightPublication(root, { idempotencyKey: "smoke-publication-cross-process-001", requestedPath: path.join(output, "cross-process.mp4"), allowedRoot: output, kind: "video", context: { purpose: "edit-render", jobId: "smoke-cross-process" } });
  await copyFile(primary.targetPath, concurrent.targetPath);
  const workerArgs = ["--import", "tsx", "scripts/publication-register-worker.ts", root, concurrent.id, concurrent.reservationToken, String(concurrent.revision), "normal"];
  const [firstWorker, secondWorker] = await Promise.all([execFileAsync(process.execPath, workerArgs, { cwd: process.cwd(), env: process.env }), execFileAsync(process.execPath, workerArgs, { cwd: process.cwd(), env: process.env })]);
  const concurrentReceiptIds = [firstWorker.stdout, secondWorker.stdout].map((value) => (JSON.parse(value.trim()) as { receiptId: string }).receiptId);
  if (new Set(concurrentReceiptIds).size !== 1) throw new Error("跨进程注册没有收敛到唯一回执。 ");

  const crashIntent = await preflightPublication(root, { idempotencyKey: "smoke-publication-crash-001", requestedPath: path.join(output, "crash.mp4"), allowedRoot: output, kind: "video", context: { purpose: "edit-render", jobId: "smoke-crash" } });
  await copyFile(primary.targetPath, crashIntent.targetPath);
  const crashMarker = path.join(root, "crash-before-commit.marker");
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/publication-register-worker.ts", root, crashIntent.id, crashIntent.reservationToken, String(crashIntent.revision), "hold-before-commit", crashMarker], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const childClosed = once(child, "close");
  await waitForPath(crashMarker);
  child.kill("SIGKILL");
  await childClosed;
  const afterCrash = await getPublicationIntent(root, crashIntent.id);
  const locksAfterCrash = await listProjectLocks(root);
  if (afterCrash?.status !== "reserved" || locksAfterCrash.length || (await listPublicationReceipts(root)).some((receipt) => receipt.intentId === crashIntent.id)) throw new Error("校验后崩溃没有保留可恢复 reserved 状态或仍遗留项目锁。 ");
  const crashReceipt = await registerPublication(root, { intentId: crashIntent.id, reservationToken: crashIntent.reservationToken, expectedRevision: crashIntent.revision });

  const [locks, mediaRuntime, intents, receipts, mediaFile] = await Promise.all([listProjectLocks(root), readMachineMediaRuntimeSnapshot(), listPublicationIntents(root), listPublicationReceipts(root), stat(primary.targetPath)]);
  if (locks.length || mediaRuntime.activeWeight || mediaRuntime.queueDepth) throw new Error("真实 Publication smoke 结束后仍有项目锁或机器媒体租约。 ");
  evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    success: true,
    command: "npm run publication:consistency-smoke -- <evidence-path>",
    environment: { platform: process.platform, arch: process.arch, node: process.version, ffmpeg, ffprobe: realFfprobe, isolatedProject: true, isolatedMediaRuntime: true },
    realMedia: { pathClass: "temporary-isolated", sizeBytes: mediaFile.size, sha256: await sha256(primary.targetPath), receiptId: primaryReceipt.id, check: primaryReceipt.check, replaySameReceipt: replay.id === primaryReceipt.id },
    twoPhase: { mode: "snapshot-validate-cas", validationOutsideProjectLock: true, unrelatedPreflightMs, unrelatedPreflightCommitted: true, storeRevisionNotUsedAsCas: true },
    cancellation: cancellationEvidence,
    fileCas: { sameSize: true, mtimeRestored: true, conflict: casConflict, remainedReserved: true, retryReceiptId: casReceipt.id, retrySha256: casReceipt.check.sha256 },
    crossProcess: { workers: 2, receiptIds: concurrentReceiptIds, uniqueReceiptCount: new Set(concurrentReceiptIds).size },
    crashRecovery: { killedAfterValidationBeforeCommit: true, statusAfterCrash: afterCrash.status, locksAfterCrash: locksAfterCrash.length, retryReceiptId: crashReceipt.id },
    final: { intentCounts: Object.fromEntries((["reserved", "registered", "cancelled", "failed"] as const).map((status) => [status, intents.filter((intent) => intent.status === status).length])), receiptCount: receipts.length, projectLocks: locks.length, activeMediaWeight: mediaRuntime.activeWeight, mediaQueueDepth: mediaRuntime.queueDepth },
    boundaries: { formalProjectRootsTouched: false, uploadsPerformed: false, paidSubmissionsPerformed: false, existingPackageOverwritten: false, softwarePublished: false, notarizationPerformed: false },
  };
} catch (error) {
  evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), success: false, error: error instanceof Error ? error.message : String(error) };
} finally {
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence!, null, 2)}\n`, "utf8");
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ success: evidence!.success, evidencePath })}\n`);
if (!evidence!.success) process.exitCode = 1;
