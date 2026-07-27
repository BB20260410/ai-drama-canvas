import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import fg from "fast-glob";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { getSidecarPaths, readJson, writeJsonAtomicExclusive } from "../src/core/sidecar.js";
import type { GenerationJob } from "../src/core/types.js";
import type { PublicationStore } from "../src/core/publication.js";

const workspace = path.resolve(process.argv[2] ?? "/Users/hxx/Documents/无限画布");
const projectRoot = path.resolve(process.argv[3] ?? path.join(workspace, "productions/gushujuan-s3-f1a688020bfb7af6"));
const jobId = process.argv[4] ?? "gen-2026-07-16T12-10-57-215Z-892023c0";
const evidencePath = path.resolve(process.argv[5] ?? path.join(workspace, "docs/evidence/p1-generation-execution-migration-20260717.json"));
const sourceRoot = path.resolve(process.argv[6] ?? "/Users/hxx/Documents/古蜀卷第三季");
const apply = process.argv.includes("--apply");
const paths = getSidecarPaths(projectRoot);
const backupRoot = path.join(paths.root, "backups", "p1-generation-execution-20260717-before-migration");

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

async function fileEvidence(filePath: string): Promise<{ path: string; bytes: number; sha256: string }> {
  const metadata = await stat(filePath);
  return { path: filePath, bytes: metadata.size, sha256: await sha256File(filePath) };
}

async function sourceSnapshot(root: string): Promise<{ files: number; bytes: number; aggregateSha256: string }> {
  const relativePaths = (await fg("**/*", {
    cwd: root,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: true,
  })).sort((left, right) => left.localeCompare(right, "en"));
  const records: Array<{ relativePath: string; bytes: number; mtimeMs: number; sha256: string }> = [];
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const metadata = await stat(absolutePath);
    records.push({
      relativePath,
      bytes: metadata.size,
      mtimeMs: metadata.mtimeMs,
      sha256: await sha256File(absolutePath),
    });
  }
  return {
    files: records.length,
    bytes: records.reduce((sum, record) => sum + record.bytes, 0),
    aggregateSha256: sha256(records.map((record) => `${record.relativePath}\0${record.bytes}\0${record.mtimeMs}\0${record.sha256}`).join("\n")),
  };
}

async function optionalInventory(root: string): Promise<Array<{ relativePath: string; bytes: number; sha256: string }>> {
  if (!await access(root).then(() => true).catch(() => false)) return [];
  const files = (await fg("**/*", { cwd: root, onlyFiles: true, followSymbolicLinks: false, dot: true })).sort();
  return Promise.all(files.map(async (relativePath) => {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const metadata = await stat(absolutePath);
    return { relativePath, bytes: metadata.size, sha256: await sha256File(absolutePath) };
  }));
}

function eventLines(value: string): Array<Record<string, unknown>> {
  return value.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assertLegacyJob(job: GenerationJob | undefined): asserts job is GenerationJob {
  if (!job) throw new Error(`找不到待迁移任务：${jobId}`);
  if (job.status !== "waiting_external" || job.executionSnapshot?.provider.adapter !== "codex-subagent-imagegen") {
    throw new Error(`待迁移任务不是 waiting_external/codex-subagent-imagegen：${job.status}/${job.executionSnapshot?.provider.adapter}`);
  }
  const checkpoint = job.subagentCheckpoint;
  if (!checkpoint || checkpoint.schemaVersion !== 1 || checkpoint.stage !== "leased" || checkpoint.revision < 1 || !checkpoint.lease || checkpoint.output || checkpoint.callIntent) {
    throw new Error("待迁移任务不是无调用回执的 legacy leased 检查点。");
  }
}

const beforeJobsBytes = await readFile(paths.generationJobs);
const beforePublicationsBytes = await readFile(paths.publications);
const beforeEventsText = await readFile(paths.events, "utf8");
const beforeLedgerBytes = await readFile(paths.commandLedger);
const beforeJobs = JSON.parse(beforeJobsBytes.toString("utf8")) as GenerationJob[];
const beforePublications = JSON.parse(beforePublicationsBytes.toString("utf8")) as PublicationStore;
const beforeJob = beforeJobs.find((job) => job.id === jobId);
assertLegacyJob(beforeJob);
const primaryBefore = beforePublications.intents.find((intent) => intent.id === beforeJob.publicationIntentId);
if (!primaryBefore || primaryBefore.status !== "reserved" || primaryBefore.receiptId) throw new Error("legacy Job 的 primary Publication 不是 reserved。");
if (beforeJob.publicationBundleId || beforeJob.companionPublicationIntentId) throw new Error("legacy Job 已包含 bundle 字段，拒绝重复迁移。");
for (const outputPath of [beforeJob.expectedOutputPath, beforeJob.expectedCompanionPath].filter((value): value is string => Boolean(value))) {
  if (await access(outputPath).then(() => true).catch(() => false)) throw new Error(`迁移前正式输出已经存在：${outputPath}`);
}
const downloadsRoot = path.join(paths.generationDownloads, jobId);
const downloadsBefore = await optionalInventory(downloadsRoot);
const sourceBefore = await sourceSnapshot(sourceRoot);
const before = {
  generationJobs: { bytes: beforeJobsBytes.length, sha256: sha256(beforeJobsBytes), count: beforeJobs.length },
  publications: { bytes: beforePublicationsBytes.length, sha256: sha256(beforePublicationsBytes), intents: beforePublications.intents.length, receipts: beforePublications.receipts.length },
  events: { bytes: Buffer.byteLength(beforeEventsText), sha256: sha256(beforeEventsText), count: eventLines(beforeEventsText).length },
  commandLedger: { bytes: beforeLedgerBytes.length, sha256: sha256(beforeLedgerBytes) },
  job: {
    id: beforeJob.id,
    status: beforeJob.status,
    attempts: beforeJob.attempts,
    checkpointRevision: beforeJob.subagentCheckpoint!.revision,
    checkpointStage: beforeJob.subagentCheckpoint!.stage,
    leaseId: beforeJob.subagentCheckpoint!.lease!.leaseId,
    agentTaskName: beforeJob.subagentCheckpoint!.lease!.agentTaskName,
    publicationIntentId: beforeJob.publicationIntentId,
    expectedOutputPath: beforeJob.expectedOutputPath,
    expectedCompanionPath: beforeJob.expectedCompanionPath,
  },
  downloads: downloadsBefore,
  source: sourceBefore,
};

if (!apply) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, apply: false, projectRoot, jobId, backupRoot, before }, null, 2)}\n`);
  process.exit(0);
}

await mkdir(path.dirname(backupRoot), { recursive: true });
await mkdir(backupRoot, { recursive: false });
const backupFiles = [
  paths.generationJobs,
  paths.publications,
  paths.events,
  paths.commandLedger,
  paths.index,
  paths.overrides,
  beforeJob.requestPath,
].filter((value): value is string => Boolean(value));
const backupManifest: Array<{ sourcePath: string; backupPath: string; bytes: number; sha256: string }> = [];
for (const sourcePath of backupFiles) {
  const relativeName = sourcePath.startsWith(paths.root)
    ? path.relative(paths.root, sourcePath)
    : path.join("external-request", path.basename(sourcePath));
  const backupPath = path.join(backupRoot, relativeName);
  await mkdir(path.dirname(backupPath), { recursive: true });
  await cp(sourcePath, backupPath, { errorOnExist: true, force: false });
  const evidence = await fileEvidence(backupPath);
  backupManifest.push({ sourcePath, backupPath, bytes: evidence.bytes, sha256: evidence.sha256 });
}
await writeFile(path.join(backupRoot, "manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  projectRoot,
  jobId,
  files: backupManifest,
}, null, 2)}\n`, "utf8");

const command = await executeIdempotentCommand(projectRoot, {
  requestId: `p1-migrate-generation-execution-${jobId.slice(-8)}-request-v1`,
  idempotencyKey: `p1-migrate-generation-execution-${jobId.slice(-8)}-v1`,
  request: {
    command: "migrate_generation_execution_state",
    payload: {
      jobId,
      expectedRevision: beforeJob.subagentCheckpoint!.revision,
      evidenceReference: `legacy-unreceipted-lease-${jobId.slice(-8)}`,
      note: "P1 正式迁移：旧协议 lease 后没有模型调用前 intent 与调用后 receipt，无法证明 image_gen 未执行；保持同一 Job/attempt/Publication 并进入 generation_unknown。",
    },
  },
});
if (command.status !== "succeeded") throw new Error(`迁移命令未成功：${command.status}`);

const afterJobsBytes = await readFile(paths.generationJobs);
const afterPublicationsBytes = await readFile(paths.publications);
const afterEventsText = await readFile(paths.events, "utf8");
const afterLedgerBytes = await readFile(paths.commandLedger);
const afterJobs = JSON.parse(afterJobsBytes.toString("utf8")) as GenerationJob[];
const afterPublications = JSON.parse(afterPublicationsBytes.toString("utf8")) as PublicationStore;
const afterJob = afterJobs.find((job) => job.id === jobId);
if (!afterJob) throw new Error("迁移后 Job 消失。");
if (afterJobs.length !== beforeJobs.length) throw new Error("迁移改变了 GenerationJob 数量。");
if (afterJob.status !== "generation_unknown"
  || afterJob.attempts !== beforeJob.attempts
  || afterJob.subagentCheckpoint?.schemaVersion !== 2
  || afterJob.subagentCheckpoint.stage !== "generation_unknown"
  || afterJob.subagentCheckpoint.revision !== beforeJob.subagentCheckpoint!.revision + 1
  || afterJob.subagentCheckpoint.unknown?.code !== "legacy_leased_without_call_receipt"
  || afterJob.subagentCheckpoint.lease?.leaseId !== beforeJob.subagentCheckpoint!.lease!.leaseId
  || afterJob.subagentCheckpoint.output
  || afterJob.subagentCheckpoint.callIntent) {
  throw new Error(`迁移后 Job 状态不满足 unknown 合同：${JSON.stringify(afterJob.subagentCheckpoint)}`);
}
if (!afterJob.publicationBundleId || !afterJob.companionPublicationIntentId || !afterJob.companionPublicationReservationToken) {
  throw new Error("迁移后没有建立 raw/labeled Publication bundle。");
}
const primaryAfter = afterPublications.intents.find((intent) => intent.id === afterJob.publicationIntentId);
const companionAfter = afterPublications.intents.find((intent) => intent.id === afterJob.companionPublicationIntentId);
if (!primaryAfter || !companionAfter
  || primaryAfter.status !== "reserved"
  || companionAfter.status !== "reserved"
  || primaryAfter.bundleId !== afterJob.publicationBundleId
  || primaryAfter.bundleMember !== "primary"
  || companionAfter.bundleId !== afterJob.publicationBundleId
  || companionAfter.bundleMember !== "companion"
  || afterPublications.receipts.length !== beforePublications.receipts.length
  || afterPublications.intents.length !== beforePublications.intents.length + 1) {
  throw new Error("迁移后 Publication bundle 数量、状态或成员身份不正确。");
}
for (const outputPath of [afterJob.expectedOutputPath, afterJob.expectedCompanionPath].filter((value): value is string => Boolean(value))) {
  if (await access(outputPath).then(() => true).catch(() => false)) throw new Error(`迁移意外生成正式输出：${outputPath}`);
}
const downloadsAfter = await optionalInventory(downloadsRoot);
if (JSON.stringify(downloadsAfter) !== JSON.stringify(downloadsBefore)) throw new Error("迁移改变了隔离候选目录。");
const sourceAfter = await sourceSnapshot(sourceRoot);
if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) throw new Error("只读第三季源目录在迁移期间发生变化。");
const addedEvents = eventLines(afterEventsText).slice(before.events.count);
const committedEvent = addedEvents.find((event) =>
  event.type === "command.side-effect-committed"
  && event.requestId === command.requestId);
const committedData = committedEvent?.data && typeof committedEvent.data === "object"
  ? committedEvent.data as Record<string, unknown>
  : undefined;
if (!committedData || typeof committedData.resultDigest !== "string") {
  throw new Error("迁移命令缺少 command.side-effect-committed 的 resultDigest。");
}
const supplierCallEvents = addedEvents.filter((event) => [
  "generation.subagent-call-intent",
  "generation.subagent-candidate-recorded",
  "generation.subagent-bundle-verified",
  "generation.succeeded",
].includes(String(event.type)));
if (supplierCallEvents.length) throw new Error(`迁移期间出现供应商调用/结果事件：${JSON.stringify(supplierCallEvents)}`);

const evidence = {
  schemaVersion: 1,
  kind: "p1-generation-execution-migration",
  createdAt: new Date().toISOString(),
  projectRoot,
  jobId,
  backupRoot,
  backupManifest,
  command: {
    requestId: command.requestId,
    idempotencyKey: command.idempotencyKey,
    status: command.status,
    requestHash: command.requestHash,
    resultDigest: committedData.resultDigest,
    replayed: command.replayed,
  },
  before,
  after: {
    generationJobs: { bytes: afterJobsBytes.length, sha256: sha256(afterJobsBytes), count: afterJobs.length },
    publications: { bytes: afterPublicationsBytes.length, sha256: sha256(afterPublicationsBytes), intents: afterPublications.intents.length, receipts: afterPublications.receipts.length },
    events: { bytes: Buffer.byteLength(afterEventsText), sha256: sha256(afterEventsText), count: eventLines(afterEventsText).length, addedTypes: addedEvents.map((event) => event.type) },
    commandLedger: { bytes: afterLedgerBytes.length, sha256: sha256(afterLedgerBytes) },
    job: {
      id: afterJob.id,
      status: afterJob.status,
      attempts: afterJob.attempts,
      checkpointSchemaVersion: afterJob.subagentCheckpoint.schemaVersion,
      checkpointRevision: afterJob.subagentCheckpoint.revision,
      checkpointStage: afterJob.subagentCheckpoint.stage,
      unknownCode: afterJob.subagentCheckpoint.unknown?.code,
      leaseId: afterJob.subagentCheckpoint.lease?.leaseId,
      publicationBundleId: afterJob.publicationBundleId,
      publicationIntentId: afterJob.publicationIntentId,
      companionPublicationIntentId: afterJob.companionPublicationIntentId,
      rawPublicationStatus: primaryAfter.status,
      companionPublicationStatus: companionAfter.status,
      expectedOutputPath: afterJob.expectedOutputPath,
      expectedCompanionPath: afterJob.expectedCompanionPath,
    },
    downloads: downloadsAfter,
    source: sourceAfter,
    supplierCallEvents: supplierCallEvents.length,
  },
  assertions: {
    sameGenerationJobCount: true,
    sameJobId: true,
    sameAttempt: true,
    legacyLeasePreserved: true,
    statusGenerationUnknown: true,
    noCallIntentOrReceiptFabricated: true,
    rawLabeledBundleReserved: true,
    noPublicationReceiptAdded: true,
    noFormalOutput: true,
    noCandidateAdopted: true,
    noSupplierCall: true,
    sourceUnchanged: true,
  },
};
await mkdir(path.dirname(evidencePath), { recursive: true });
await writeJsonAtomicExclusive(evidencePath, evidence);
process.stdout.write(`${JSON.stringify({ evidencePath, ...evidence }, null, 2)}\n`);
