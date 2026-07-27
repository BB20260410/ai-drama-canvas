/**
 * P14 正式受管工程只读备份/恢复演练。
 *
 * - 源工程只经 project-backup owner 建立 SQLite 写屏障快照；
 * - 恢复始终落到新目录，绝不覆盖源工程；
 * - 逐文件 SHA 由 schema v2 owner 全量校验，本脚本再做 SQLite
 *   integrity、媒体抽样解码与恢复副本安全写入。
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createBuildIdentity } from "../src/core/build-identity.js";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { getMaterialStudioState, listStudioMedia, verifyStudioMediaObject, type StudioMediaKind } from "../src/core/material-studio.js";
import { inspectManagedProject } from "../src/core/managed-project.js";
import {
  createManagedProjectBackup,
  restoreManagedProjectBackup,
  verifyProjectTreeAgainstManifest,
} from "../src/core/project-backup.js";
import { getStudioProductionState } from "../src/core/studio-production.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const projectRoot = path.resolve(process.argv[2] ?? path.join(workspace, "projects", "codex-ai-drama-studio"));
const backupParent = path.resolve(process.argv[3] ?? path.join(workspace, "output", "p14-formal-backups"));
const restoreParent = path.resolve(process.argv[4] ?? path.join(workspace, "output", `p14-formal-restore-${stamp}`));
const evidencePath = path.resolve(process.argv[5] ?? path.join(workspace, "docs", "evidence", `formal-backup-restore-${stamp}-p14.json`));

async function refuseOverwrite(filePath: string): Promise<void> {
  if (await access(filePath).then(() => true, () => false)) throw new Error(`证据已存在，拒绝覆盖：${filePath}`);
  await mkdir(path.dirname(filePath), { recursive: true });
}

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

async function listSqliteFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`恢复副本含符号链接：${path.join(current, entry.name)}`);
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(".sqlite")) files.push(absolute);
    }
  }
  await walk(path.join(root, ".aicanvas"));
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function verifySqliteIntegrity(databasePath: string): { relativePath: string; result: "ok" } {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    const values = rows.flatMap((row) => Object.values(row));
    if (values.length !== 1 || values[0] !== "ok") throw new Error(`SQLite integrity_check 失败：${databasePath}`);
    return { relativePath: path.relative(workspace, databasePath).split(path.sep).join("/"), result: "ok" };
  } finally {
    db.close();
  }
}

async function probeMedia(project: string, kind: StudioMediaKind, limit: number): Promise<Array<Record<string, unknown>>> {
  const page = await listStudioMedia(project, { kind, limit });
  const results: Array<Record<string, unknown>> = [];
  for (const media of page.items) {
    if (!await verifyStudioMediaObject(project, media.sha256)) throw new Error(`CAS SHA 校验失败：${media.sha256}`);
    if (kind === "image") {
      const metadata = await sharp(media.objectPath, { failOn: "error" }).metadata();
      if (!metadata.width || !metadata.height || !metadata.format) throw new Error(`图像不可解码：${media.sha256}`);
      results.push({ sha256: media.sha256, kind, width: metadata.width, height: metadata.height, format: metadata.format });
      continue;
    }
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,sample_rate", "-of", "json", media.objectPath,
    ], { maxBuffer: 1024 * 1024 });
    const decoded = JSON.parse(stdout) as { streams?: unknown[]; format?: { duration?: string } };
    if (!Array.isArray(decoded.streams) || decoded.streams.length === 0) throw new Error(`${kind} 不可解码：${media.sha256}`);
    results.push({ sha256: media.sha256, kind, streams: decoded.streams, duration: decoded.format?.duration });
  }
  return results;
}

async function countMediaByKind(project: string): Promise<Record<StudioMediaKind, number>> {
  const count = async (kind: StudioMediaKind): Promise<number> => {
    let cursor: string | undefined;
    let total = 0;
    do {
      const page = await listStudioMedia(project, { kind, limit: 100, ...(cursor ? { cursor } : {}) });
      total += page.items.length;
      cursor = page.nextCursor;
    } while (cursor);
    return total;
  };
  const [image, video, audio] = await Promise.all([count("image"), count("video"), count("audio")]);
  return { image, video, audio };
}

await refuseOverwrite(evidencePath);
await mkdir(backupParent, { recursive: true });
await mkdir(restoreParent, { recursive: true });
const [canonicalProjectRoot, canonicalBackupParent, canonicalRestoreParent] = await Promise.all([
  realpath(projectRoot), realpath(backupParent), realpath(restoreParent),
]);
if (canonicalProjectRoot !== projectRoot) throw new Error("正式工程必须使用无符号链接的真实路径。");

const startedAt = new Date().toISOString();
const [sourceShellBefore, sourceMaterialBefore, sourceProductionBefore, sourceMediaInventory, identity] = await Promise.all([
  inspectManagedProject(canonicalProjectRoot),
  getMaterialStudioState(canonicalProjectRoot),
  getStudioProductionState(canonicalProjectRoot),
  countMediaByKind(canonicalProjectRoot),
  createBuildIdentity(workspace),
]);

const backupStarted = performance.now();
const backup = await createManagedProjectBackup(canonicalProjectRoot, canonicalBackupParent, { sqliteBusyTimeoutMs: 60_000 });
const backupMs = Math.round(performance.now() - backupStarted);
await verifyProjectTreeAgainstManifest(path.join(backup.backupRoot, "project"), backup.manifest);

const restoreStarted = performance.now();
const restored = await restoreManagedProjectBackup(backup.backupRoot, canonicalRestoreParent);
const restoreMs = Math.round(performance.now() - restoreStarted);
const [restoredShell, restoredMaterial, restoredProduction, restoredMediaInventory] = await Promise.all([
  inspectManagedProject(restored.projectRoot),
  getMaterialStudioState(restored.projectRoot),
  getStudioProductionState(restored.projectRoot),
  countMediaByKind(restored.projectRoot),
]);
if (restored.projectRoot === canonicalProjectRoot) throw new Error("恢复结果意外覆盖源工程。");
if (restoredShell.project.id !== sourceShellBefore.project.id) throw new Error("恢复副本 projectId 漂移。");
if (restoredMaterial.counts.media !== sourceMaterialBefore.counts.media
  || restoredProduction.counts.units !== sourceProductionBefore.counts.units
  || restoredProduction.counts.panels !== sourceProductionBefore.counts.panels) {
  throw new Error("恢复副本核心计数与备份前不一致。");
}
if (JSON.stringify(restoredMediaInventory) !== JSON.stringify(sourceMediaInventory)) {
  throw new Error(`恢复副本媒体分类库存与备份前不一致：${JSON.stringify({ sourceMediaInventory, restoredMediaInventory })}`);
}

const sqliteIntegrity = (await listSqliteFiles(restored.projectRoot)).map(verifySqliteIntegrity);
const mediaSamples = {
  images: await probeMedia(restored.projectRoot, "image", 12),
  videos: await probeMedia(restored.projectRoot, "video", 3),
  audio: await probeMedia(restored.projectRoot, "audio", 3),
};

const writeProbeId = `p14-restored-write-probe-${Date.now()}`;
const writeRequestId = `p14.restore.write.${randomUUID()}`;
const writeProbe = await executeIdempotentCommand(restored.projectRoot, {
  requestId: writeRequestId,
  idempotencyKey: writeRequestId,
  request: {
    command: "create_studio_prompt_document",
    payload: { id: writeProbeId, title: "P14 恢复副本安全写入验证", expectedRevision: 0 },
  },
});
if (writeProbe.status !== "succeeded") throw new Error(`恢复副本安全写入失败：${writeProbe.error?.message ?? writeProbe.status}`);

const sourceShellAfter = await inspectManagedProject(canonicalProjectRoot);
if (sourceShellAfter.manifestFingerprint !== sourceShellBefore.manifestFingerprint) {
  throw new Error("备份/恢复演练期间源工程受管 manifest 发生漂移。");
}

const backupManifestPath = path.join(backup.backupRoot, "manifest.json");
const report = {
  schemaVersion: 1,
  kind: "p14-formal-project-backup-restore-validation",
  status: "pass",
  startedAt,
  completedAt: new Date().toISOString(),
  buildIdentity: { sourceDigest: identity.sourceDigest, buildId: identity.buildId },
  source: {
    projectId: sourceShellBefore.project.id,
    projectName: sourceShellBefore.project.name,
    manifestFingerprint: sourceShellBefore.manifestFingerprint,
    counts: { material: sourceMaterialBefore.counts, production: sourceProductionBefore.counts },
    mediaInventory: sourceMediaInventory,
    writeCommandsByThisRun: 0,
  },
  backup: {
    root: path.relative(workspace, backup.backupRoot).split(path.sep).join("/"),
    schemaVersion: backup.manifest.schemaVersion,
    fileCount: backup.manifest.fileCount,
    aggregateSha256: backup.manifest.aggregateSha256,
    manifestSha256: await sha256File(backupManifestPath),
    snapshot: backup.manifest.snapshot,
    durationMs: backupMs,
  },
  restore: {
    root: path.relative(workspace, restored.projectRoot).split(path.sep).join("/"),
    overwriteSource: false,
    projectIdPreserved: true,
    durationMs: restoreMs,
    sqliteIntegrity,
    mediaInventory: restoredMediaInventory,
    mediaSamples,
    safeWrite: { command: "create_studio_prompt_document", documentId: writeProbeId, status: writeProbe.status },
  },
  boundaries: {
    formalProjectGenerationCalls: 0,
    formalProjectWriteCommands: 0,
    restoredCopyWriteCommands: 1,
    browserCalls: 0,
    uploads: 0,
    gitStage: 0,
  },
};
await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({
  ok: true,
  evidencePath,
  backupRoot: backup.backupRoot,
  restoredProjectRoot: restored.projectRoot,
  fileCount: backup.manifest.fileCount,
  mediaSamples: Object.values(mediaSamples).reduce((total, entries) => total + entries.length, 0),
  backupMs,
  restoreMs,
}, null, 2)}\n`);
