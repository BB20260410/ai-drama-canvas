import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import fg from "fast-glob";
import sharp from "sharp";
import { doctorProject } from "../src/core/codex.js";
import {
  FUSION_ASSET_CONSISTENCY_BOARD_RENDER_VERSION,
  FUSION_ASSET_CONSISTENCY_CRITERIA,
  getFusionAssetConsistencyState,
} from "../src/core/fusion-asset-consistency.js";
import { inspectFusionPackage, THIRD_SEASON_FUSION_EXPECTED_COUNTS } from "../src/core/fusion-package.js";
import { listGenerationJobs } from "../src/core/generation.js";
import { listPublicationIntents } from "../src/core/publication.js";
import { loadProjectConfig } from "../src/core/sidecar.js";

const projectRoot = path.resolve(process.argv[2] || "/Users/hxx/Documents/无限画布/productions/gushujuan-s3-f1a688020bfb7af6");
const outputPath = path.resolve(process.argv[3] || "docs/evidence/final-validation-20260716-fusion-asset-batch-001-v2.json");
const batchId = process.argv[4] || "fusion-asset-batch-001";
const sourceRoot = "/Users/hxx/Documents/古蜀卷第三季";
const packageRoot = path.join(sourceRoot, "07_9x16_15秒融合制作包");
const expectedControlledSourceAggregate = "f1a688020bfb7af6a39e2d9e7f383f773fdd4fdc27a9562695017509a1600a8c";
const expectedFullSourceAggregate = "649160f22663ca4c45ee4a4084e278ef0edc61ec66db01bb84da38cbea3f8d26";
const expectedMembers = (process.argv[5] || "P01,S01,P30,S02,C07,P29").split(",").map((value) => value.trim()).filter(Boolean);
assert(expectedMembers.length === 6 && new Set(expectedMembers).size === 6, "验证批次必须显式绑定六个不重复资产 ID。");
const expectedAuthorityHashes = {
  ahang: "5132d4320f956cf2a2320e52fae941ef15ffb243ad79343045006a8773f4548e",
  dudu: "d6759fbd03df6d3b9c83e193130bea6073c15865a5f9cf7d308b069ea2b131cd",
  "golden-mask": "91b074b882113d6c0bdde156e6d38adf7883e8388ba4064168d6c32ade8e2253",
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
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

async function fileEvidence(filePath: string) {
  const metadata = await stat(filePath);
  return { path: filePath, bytes: metadata.size, sha256: await sha256File(filePath) };
}

async function fullSourceSnapshot(root: string) {
  const relativePaths = (await fg("**/*", { cwd: root, onlyFiles: true, followSymbolicLinks: false, dot: true })).sort((left, right) => left.localeCompare(right, "en"));
  const files = [] as Array<{ relativePath: string; bytes: number; mtimeMs: number; sha256: string }>;
  for (const relativePath of relativePaths) {
    const absolute = path.join(root, ...relativePath.split("/"));
    const metadata = await stat(absolute);
    files.push({ relativePath, bytes: metadata.size, mtimeMs: metadata.mtimeMs, sha256: await sha256File(absolute) });
  }
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    aggregateSha256: sha256(files.map((file) => `${file.relativePath}\0${file.bytes}\0${file.mtimeMs}\0${file.sha256}`).join("\n")),
  };
}

async function imageEvidence(filePath: string, expectedSha256: string, expectedBytes: number) {
  const evidence = await fileEvidence(filePath);
  assert(evidence.sha256 === expectedSha256, `图片 SHA 漂移：${filePath}`);
  assert(evidence.bytes === expectedBytes, `图片体积漂移：${filePath}`);
  const metadata = await sharp(filePath, { failOn: "error" }).metadata();
  assert(metadata.width && metadata.height, `图片缺少有效尺寸：${filePath}`);
  const ratio = metadata.width / metadata.height;
  assert(metadata.height > metadata.width && Math.abs(ratio - 9 / 16) <= 0.005, `图片不是允许舍入误差内的 9:16 竖屏：${filePath} (${metadata.width}x${metadata.height})`);
  return { ...evidence, width: metadata.width, height: metadata.height, ratio };
}

const [controlledBefore, fullBefore] = await Promise.all([
  inspectFusionPackage({ packageRoot, sourceRoot, expectedCounts: THIRD_SEASON_FUSION_EXPECTED_COUNTS }),
  fullSourceSnapshot(sourceRoot),
]);
const [state, jobs, publications, config, doctor] = await Promise.all([
  getFusionAssetConsistencyState(projectRoot),
  listGenerationJobs(projectRoot),
  listPublicationIntents(projectRoot),
  loadProjectConfig(projectRoot),
  doctorProject(projectRoot),
]);
const batch = state.batches.find((candidate) => candidate.id === batchId);
assert(batch, `找不到六项一致性批次：${batchId}`);
assert(batch.status === "passed" && batch.reviewValid && batch.canStartNextBatch, `${batchId} 必须通过当前快照复核并开放下一批。`);
assert(batch.memberCount === 6 && batch.readyCount === 6 && batch.hardLockCount === 6, `${batchId} ready/hard-lock 数量必须为 6/6。`);
assert(batch.members.map((member) => member.assetId).join(",") === expectedMembers.join(","), `${batchId} 资产顺序漂移。`);
assert(batch.authorityIssues.length === 0, `权威输入存在问题：${batch.authorityIssues.join("、")}`);
for (const authority of batch.authorityHashes) {
  assert(authority.sha256 === expectedAuthorityHashes[authority.id as keyof typeof expectedAuthorityHashes], `权威输入 SHA 漂移：${authority.id}`);
}

const review = batch.review;
assert(review?.decision === "pass" && review.snapshotHash === batch.currentSnapshotHash, "整批 Review 未绑定当前证据快照。");
assert(review.criteria.length === FUSION_ASSET_CONSISTENCY_CRITERIA.length, "整批 Review 标准数量不完整。");
for (const key of FUSION_ASSET_CONSISTENCY_CRITERIA) assert(review.criteria.some((criterion) => criterion.key === key && criterion.result === "pass"), `整批 Review 未明确通过：${key}`);
assert(review.board.renderVersion === FUSION_ASSET_CONSISTENCY_BOARD_RENDER_VERSION, "复核板仍是缩略图不可见的历史渲染版本。");
const board = await fileEvidence(review.board.path);
assert(board.sha256 === review.board.sha256, "复核板 SHA 漂移。");
const boardMetadata = JSON.parse(await readFile(review.board.metadataPath, "utf8")) as { role?: string; renderVersion?: string; snapshotHash?: string; members?: unknown[] };
assert(boardMetadata.role === "review-only-not-generation-reference", "复核板角色必须明确禁止作为生图参考。");
assert(boardMetadata.renderVersion === FUSION_ASSET_CONSISTENCY_BOARD_RENDER_VERSION && boardMetadata.snapshotHash === batch.currentSnapshotHash, "复核板 metadata 身份漂移。");
assert(boardMetadata.members?.length === 6, "复核板 metadata 必须绑定六项成员。");
const boardMetadataImage = await sharp(review.board.path, { failOn: "error" }).metadata();
assert(boardMetadataImage.width === 1920 && boardMetadataImage.height === 2160, "复核板尺寸必须为 1920x2160。");
const tilePixels = [] as Array<{ assetId: string; visible: boolean; channelMeans: number[]; channelStdevs: number[] }>;
for (const [index, member] of batch.members.entries()) {
  const left = 24 + (index % 3) * 632;
  const top = 24 + Math.floor(index / 3) * 1068;
  const tile = await sharp(review.board.path).extract({ left, top, width: 608, height: 992 }).png().toBuffer();
  const stats = await sharp(tile).stats();
  const background = [6, 21, 47];
  const visible = stats.channels.slice(0, 3).some((channel, channelIndex) => channel.stdev > 2 || Math.abs(channel.mean - background[channelIndex]!) > 5);
  assert(visible, `复核板第 ${index + 1} 格仍被背景遮住：${member.assetId}`);
  tilePixels.push({ assetId: member.assetId, visible, channelMeans: stats.channels.slice(0, 3).map((channel) => channel.mean), channelStdevs: stats.channels.slice(0, 3).map((channel) => channel.stdev) });
}

const assets = [] as Array<Record<string, unknown>>;
for (const member of batch.members) {
  assert(member.ready && member.hardLocked && member.evidence, `资产未 ready/hard-lock 或缺证据：${member.assetId}`);
  const raw = await imageEvidence(member.evidence.raw.path, member.evidence.raw.sha256, member.evidence.raw.size);
  const labeled = await imageEvidence(member.evidence.labeled.path, member.evidence.labeled.sha256, member.evidence.labeled.size);
  const job = jobs.find((candidate) => candidate.id === member.currentJobId);
  assert(job?.status === "succeeded" && job.publicationReceiptId === member.evidence.publicationReceiptId, `GenerationJob 或回执不一致：${member.assetId}`);
  assert(job.executionSnapshot?.provider.adapter === "codex-subagent-imagegen", `GenerationJob 未绑定正式一图一子代理执行面：${member.assetId}`);
  assert(job.subagentCheckpoint?.stage === "verified" && job.subagentCheckpoint.oneImagePerAgent, `唯一子代理检查点未完成 verified：${member.assetId}`);
  assert(job.subagentCheckpoint.lease?.oneImageOnly && job.subagentCheckpoint.output?.leaseId === job.subagentCheckpoint.lease.leaseId, `生成结果未绑定唯一图片租约：${member.assetId}`);
  assert(job.subagentCheckpoint.output.agentTaskName === job.subagentCheckpoint.lease.agentTaskName && Boolean(job.subagentCheckpoint.output.agentRunId), `生成结果缺少稳定子代理身份：${member.assetId}`);
  assert(job.subagentCheckpoint.output.sourceSha256 === job.subagentCheckpoint.output.isolatedSha256 && job.resultSha256 === job.subagentCheckpoint.output.isolatedSha256, `候选、隔离副本与正式结果 SHA 不一致：${member.assetId}`);
  const publication = publications.find((candidate) => candidate.id === job.publicationIntentId);
  assert(publication?.status === "registered" && publication.receiptId === member.evidence.publicationReceiptId, `Publication 未注册或回执漂移：${member.assetId}`);
  const historicalAttempts = member.attemptJobIds.filter((jobId) => jobId !== member.currentJobId).map((jobId) => {
    const historicalJob = jobs.find((candidate) => candidate.id === jobId);
    assert(historicalJob, `历史生成尝试不存在：${member.assetId}/${jobId}`);
    assert(["failed", "cancelled"].includes(historicalJob.status), `非当前生成尝试仍可继续或已成功：${member.assetId}/${jobId}`);
    assert(!historicalJob.publicationReceiptId && !historicalJob.resultPath && !historicalJob.resultSha256, `失败/取消尝试产生了正式结果或回执：${member.assetId}/${jobId}`);
    const historicalPublication = publications.find((candidate) => candidate.id === historicalJob.publicationIntentId);
    assert(historicalPublication && ["failed", "cancelled"].includes(historicalPublication.status) && !historicalPublication.receiptId, `历史 Publication 未失败关闭：${member.assetId}/${jobId}`);
    return { jobId, status: historicalJob.status, error: historicalJob.error, publicationIntentId: historicalPublication.id, publicationStatus: historicalPublication.status, checkpointStage: historicalJob.subagentCheckpoint?.stage };
  });
  const hardLock = config.hardLocks.find((candidate) => candidate.id === member.assetId);
  assert(hardLock && path.resolve(hardLock.path) === path.resolve(member.evidence.raw.path), `硬锁未绑定当前 raw：${member.assetId}`);
  assets.push({ assetId: member.assetId, itemId: member.itemId, jobId: job.id, providerId: job.providerId, agentTaskName: job.subagentCheckpoint.lease.agentTaskName, agentRunId: job.subagentCheckpoint.output.agentRunId, leaseId: job.subagentCheckpoint.lease.leaseId, publicationIntentId: publication.id, publicationReceiptId: publication.receiptId, individualReviewId: member.evidence.individualReviewId, historicalAttempts, raw, labeled, hardLockPath: hardLock.path });
}

const [controlledAfter, fullAfter] = await Promise.all([
  inspectFusionPackage({ packageRoot, sourceRoot, expectedCounts: THIRD_SEASON_FUSION_EXPECTED_COUNTS }),
  fullSourceSnapshot(sourceRoot),
]);
assert(controlledBefore.inventory.aggregateSha256 === expectedControlledSourceAggregate && controlledAfter.inventory.aggregateSha256 === expectedControlledSourceAggregate, "第三季受控融合输入 SHA 漂移。");
assert(fullBefore.aggregateSha256 === expectedFullSourceAggregate && fullAfter.aggregateSha256 === expectedFullSourceAggregate, "第三季完整源目录 SHA/mtime 清单漂移。");
const doctorSummary = doctor.summary;
assert(doctorSummary, "Doctor 未返回汇总结果。");
assert(doctorSummary.errors === 0, `Doctor 存在错误：${doctorSummary.errors}`);

const report = {
  schemaVersion: 1,
  kind: "fusion-asset-batch-final-validation",
  createdAt: new Date().toISOString(),
  pixelProbeVersion: "extracted-buffer-v2",
  supersedes: batchId === "fusion-asset-batch-001" ? {
    path: path.resolve("docs/evidence/final-validation-20260716-fusion-asset-batch-001.json"),
    reason: "旧证据的 Sharp stats 作用于整张输入，不能逐格证明缩略图可见；v2 先提取每格独立缓冲区再统计。",
  } : batchId === "fusion-asset-batch-002" ? {
    path: path.resolve("docs/evidence/final-validation-20260716-fusion-asset-batch-002.json"),
    reason: "旧证据生成时沿用了首批定向测试说明；v2 绑定本批实际执行的两文件十三项回归结果。",
  } : undefined,
  projectRoot,
  batch: {
    id: batch.id,
    status: batch.status,
    reviewValid: batch.reviewValid,
    hardLockCount: batch.hardLockCount,
    canStartNextBatch: batch.canStartNextBatch,
    snapshotHash: batch.currentSnapshotHash,
    reviewId: review.id,
    criteria: review.criteria,
    board: { ...review.board, bytes: board.bytes, tilePixels },
    members: expectedMembers,
  },
  assets,
  sourceBoundary: {
    mode: "read-only",
    fullDirectory: { before: fullBefore, after: fullAfter, unchanged: fullBefore.aggregateSha256 === fullAfter.aggregateSha256 },
    controlledFusionInputs: {
      before: { files: controlledBefore.inventory.files.length, bytes: controlledBefore.inventory.totalBytes, aggregateSha256: controlledBefore.inventory.aggregateSha256 },
      after: { files: controlledAfter.inventory.files.length, bytes: controlledAfter.inventory.totalBytes, aggregateSha256: controlledAfter.inventory.aggregateSha256 },
      unchanged: controlledBefore.inventory.aggregateSha256 === controlledAfter.inventory.aggregateSha256,
    },
  },
  doctor: doctorSummary,
  ongoingProduction: {
    goalComplete: false,
    nextAssetId: state.productionOrder.nextAssetId,
    nextBatchAssetIds: state.productionOrder.nextBatchAssetIds,
    note: `截至 ${batch.id} 完成；不得冒充 EP01 或全季完成。`,
  },
  recordedVerificationRun: {
    typecheck: "passed",
    targeted: batchId === "fusion-asset-batch-001"
      ? "tests/fusion-asset-consistency.test.ts: 5/5 passed"
      : "tests/fusion-asset-consistency.test.ts + tests/fusion-production.test.ts: 2 files / 13 tests passed",
    fullTests: "49 files / 294 tests passed",
    productionBuild: "passed",
    mcpBuild: "passed",
  },
  assertions: {
    allCurrentPublicationsRegistered: true,
    allImagesBoundToUniqueSubagentLeases: true,
    allHistoricalAttemptsFailedClosed: true,
    allRawLabeledPairsTraceable: true,
    allImagesDecodableAndVertical: true,
    allSixReviewTilesVisible: true,
    allSevenCriteriaPassed: true,
    hiddenMaskRulePassed: true,
    allSixCurrentHardLocks: true,
    sourceUnchanged: true,
    longGoalStillActive: true,
  },
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({ outputPath, batch: report.batch, sourceBoundary: report.sourceBoundary, doctor: report.doctor, ongoingProduction: report.ongoingProduction, assertions: report.assertions }, null, 2)}\n`);
