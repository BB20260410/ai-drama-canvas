import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import fg from "fast-glob";
import { buildFusionStoryboardProgress, loadFusionStoryboardEvidenceSnapshot } from "../src/core/fusion-storyboard-evidence.js";
import { scanAndPersist } from "../src/core/service.js";
import { getSidecarPaths, readJson, writeJsonAtomicExclusive } from "../src/core/sidecar.js";
import type { GenerationJob, ProjectIndex } from "../src/core/types.js";
import type { PublicationStore } from "../src/core/publication.js";

const workspace = path.resolve(process.argv[2] ?? "/Users/hxx/Documents/无限画布");
const projectRoot = path.resolve(process.argv[3] ?? path.join(workspace, "productions/gushujuan-s3-f1a688020bfb7af6"));
const evidencePath = path.resolve(process.argv[4] ?? path.join(workspace, "docs/evidence/p1-generation-projection-refresh-20260717.json"));
const sourceRoot = path.resolve(process.argv[5] ?? "/Users/hxx/Documents/古蜀卷第三季");
const jobId = process.argv[6] ?? "gen-2026-07-16T12-10-57-215Z-892023c0";
const itemId = "season-三-ep01-unit008";
const paths = getSidecarPaths(projectRoot);
const backupRoot = path.join(paths.root, "backups", "p1-generation-projection-20260717-before-scan");

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  }));
  return hash.digest("hex");
}

async function sourceSnapshot(root: string): Promise<{ files: number; bytes: number; aggregateSha256: string }> {
  const relativePaths = (await fg("**/*", { cwd: root, onlyFiles: true, followSymbolicLinks: false, dot: true }))
    .sort((left, right) => left.localeCompare(right, "en"));
  const records: Array<{ relativePath: string; bytes: number; mtimeMs: number; sha256: string }> = [];
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const metadata = await stat(absolutePath);
    records.push({ relativePath, bytes: metadata.size, mtimeMs: metadata.mtimeMs, sha256: await sha256File(absolutePath) });
  }
  return {
    files: records.length,
    bytes: records.reduce((sum, record) => sum + record.bytes, 0),
    aggregateSha256: sha256(records.map((record) => `${record.relativePath}\0${record.bytes}\0${record.mtimeMs}\0${record.sha256}`).join("\n")),
  };
}

async function fileEvidence(filePath: string): Promise<{ path: string; bytes: number; sha256: string }> {
  const metadata = await stat(filePath);
  return { path: filePath, bytes: metadata.size, sha256: await sha256File(filePath) };
}

if (await access(evidencePath).then(() => true).catch(() => false)) throw new Error(`证据文件已存在，拒绝覆盖：${evidencePath}`);
if (await access(backupRoot).then(() => true).catch(() => false)) throw new Error(`刷新备份已存在，拒绝重复执行：${backupRoot}`);

const [jobsBytesBefore, publicationsBytesBefore, indexBefore, sourceBefore] = await Promise.all([
  readFile(paths.generationJobs),
  readFile(paths.publications),
  readJson<ProjectIndex | null>(paths.index, null),
  sourceSnapshot(sourceRoot),
]);
if (!indexBefore) throw new Error("正式 index.json 缺失。");
const jobsBefore = JSON.parse(jobsBytesBefore.toString("utf8")) as GenerationJob[];
const publicationsBefore = JSON.parse(publicationsBytesBefore.toString("utf8")) as PublicationStore;
const jobBefore = jobsBefore.find((job) => job.id === jobId);
if (!jobBefore
  || jobBefore.status !== "generation_unknown"
  || jobBefore.attempts !== 1
  || jobBefore.subagentCheckpoint?.stage !== "generation_unknown"
  || jobBefore.subagentCheckpoint.unknown?.code !== "legacy_leased_without_call_receipt") {
  throw new Error(`正式 Job 不是待投影的 P1 unknown 状态：${JSON.stringify(jobBefore)}`);
}
const storedBefore = indexBefore.items.find((item) => item.id === itemId)?.fusionStoryboard;
if (!storedBefore || storedBefore.panels[4]?.generationJobId !== jobId) throw new Error("正式索引没有把目标 Job 绑定到 EP01_008 宫格05。");
const liveSnapshotBefore = await loadFusionStoryboardEvidenceSnapshot(projectRoot);
const liveBefore = buildFusionStoryboardProgress(itemId, indexBefore.artifacts, liveSnapshotBefore);
if (liveBefore?.panels[4]?.state !== "generation_unknown"
  || liveBefore.panels[4].generationStatus !== "generation_unknown"
  || !liveBefore.panels[4].issues.some((issue) => issue.includes("禁止重试"))) {
  throw new Error(`实时宫格证据没有投影 unknown：${JSON.stringify(liveBefore?.panels[4])}`);
}

await mkdir(path.dirname(backupRoot), { recursive: true });
await mkdir(backupRoot, { recursive: false });
const backupSources = [paths.index, paths.events, paths.cache];
const backupManifest = [];
for (const sourcePath of backupSources) {
  const backupPath = path.join(backupRoot, path.basename(sourcePath));
  await cp(sourcePath, backupPath, { errorOnExist: true, force: false });
  backupManifest.push({ sourcePath, backupPath, ...await fileEvidence(backupPath) });
}
await writeFile(path.join(backupRoot, "manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  projectRoot,
  jobId,
  files: backupManifest,
}, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

const scanned = await scanAndPersist(projectRoot);
const [jobsBytesAfter, publicationsBytesAfter, sourceAfter] = await Promise.all([
  readFile(paths.generationJobs),
  readFile(paths.publications),
  sourceSnapshot(sourceRoot),
]);
if (sha256(jobsBytesAfter) !== sha256(jobsBytesBefore)) throw new Error("投影刷新修改了 GenerationJob。");
if (sha256(publicationsBytesAfter) !== sha256(publicationsBytesBefore)) throw new Error("投影刷新修改了 Publication。");
if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) throw new Error("投影刷新期间只读第三季源目录发生变化。");

const storedAfter = scanned.items.find((item) => item.id === itemId)?.fusionStoryboard;
if (scanned.items.filter((item) => item.type === "unit").length !== 1_288
  || !storedAfter
  || storedAfter.contractId !== "grid-76e6545a6efec0e4091b"
  || storedAfter.panelCount !== 6
  || storedAfter.completedPanelCount !== 4
  || storedAfter.panels.slice(0, 4).some((panel) => panel.state !== "awaiting_review")
  || storedAfter.panels[4]?.state !== "generation_unknown"
  || storedAfter.panels[4].generationStatus !== "generation_unknown"
  || storedAfter.panels[4].generationJobId !== jobId
  || !storedAfter.panels[4].issues.some((issue) => issue.includes("禁止重试"))
  || storedAfter.panels[5]?.state !== "missing") {
  throw new Error(`刷新后的 EP01_008 画布投影不正确：${JSON.stringify(storedAfter)}`);
}
for (const outputPath of [jobBefore.expectedOutputPath, jobBefore.expectedCompanionPath].filter((value): value is string => Boolean(value))) {
  if (await access(outputPath).then(() => true).catch(() => false)) throw new Error(`投影刷新意外产生正式输出：${outputPath}`);
}
const publicationsAfter = JSON.parse(publicationsBytesAfter.toString("utf8")) as PublicationStore;
if (publicationsAfter.intents.length !== publicationsBefore.intents.length
  || publicationsAfter.receipts.length !== publicationsBefore.receipts.length) {
  throw new Error("投影刷新改变了 Publication 数量。");
}

const evidence = {
  schemaVersion: 1,
  kind: "p1-generation-projection-refresh",
  createdAt: new Date().toISOString(),
  workspace,
  projectRoot,
  jobId,
  itemId,
  backupRoot,
  backupManifest,
  sourceBoundary: { before: sourceBefore, after: sourceAfter, unchanged: true },
  immutableGenerationState: {
    generationJobsBeforeSha256: sha256(jobsBytesBefore),
    generationJobsAfterSha256: sha256(jobsBytesAfter),
    publicationsBeforeSha256: sha256(publicationsBytesBefore),
    publicationsAfterSha256: sha256(publicationsBytesAfter),
    jobs: jobsBefore.length,
    publicationIntents: publicationsBefore.intents.length,
    publicationReceipts: publicationsBefore.receipts.length,
  },
  before: {
    scanId: indexBefore.scanId,
    storedPanelState: storedBefore.panels[4]?.state,
    livePanelState: liveBefore.panels[4]?.state,
    liveIssue: liveBefore.panels[4]?.issues.find((issue) => issue.includes("禁止重试")),
  },
  after: {
    scanId: scanned.scanId,
    unitCount: scanned.items.filter((item) => item.type === "unit").length,
    contractId: storedAfter.contractId,
    panelCount: storedAfter.panelCount,
    completedPanelCount: storedAfter.completedPanelCount,
    panelStates: storedAfter.panels.map((panel) => panel.state),
    panel05GenerationStatus: storedAfter.panels[4]?.generationStatus,
    panel05Issue: storedAfter.panels[4]?.issues.find((issue) => issue.includes("禁止重试")),
  },
  assertions: {
    backupCreated: true,
    liveProjectionWasAlreadyUnknown: true,
    storedCanvasProjectionRefreshed: true,
    generationJobUnchanged: true,
    publicationsUnchanged: true,
    noOutputCreated: true,
    sourceUnchanged: true,
  },
};
await writeJsonAtomicExclusive(evidencePath, evidence);
process.stdout.write(`${JSON.stringify({ evidencePath, ...evidence }, null, 2)}\n`);
