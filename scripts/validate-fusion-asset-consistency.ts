import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import fg from "fast-glob";
import { getCapabilities, doctorProject, getProjectSnapshot } from "../src/core/codex.js";
import { getFusionAssetConsistencyState } from "../src/core/fusion-asset-consistency.js";
import { inspectFusionPackage, THIRD_SEASON_FUSION_EXPECTED_COUNTS } from "../src/core/fusion-package.js";
import { getBrowserGenerationPlan, listGenerationJobs } from "../src/core/generation.js";
import { listPublicationIntents } from "../src/core/publication.js";
import { getSidecarPaths } from "../src/core/sidecar.js";
import { expectedRuntimeMcpToolCount } from "../src/core/release-manifest.js";

const projectRoot = path.resolve(process.argv[2] || "/Users/hxx/Documents/无限画布/productions/gushujuan-s3-f1a688020bfb7af6");
const outputPath = path.resolve(process.argv[3] || "docs/evidence/artlist-preflight-blocked-formal-20260715.json");
const sourceRoot = "/Users/hxx/Documents/古蜀卷第三季";
const packageRoot = path.join(sourceRoot, "07_9x16_15秒融合制作包");
const expectedControlledSourceAggregate = "f1a688020bfb7af6a39e2d9e7f383f773fdd4fdc27a9562695017509a1600a8c";
const expectedFullSourceAggregate = "649160f22663ca4c45ee4a4084e278ef0edc61ec66db01bb84da38cbea3f8d26";
const expectedJobStoreSha256 = "3fc7dd327fb0d4c51feefab39d568e89d3248f26925cb89732f9188b436919f7";
const expectedPublicationStoreSha256 = "6d7a0d603abc669c3e400fe3edeefa0301f2293350f02f99056f7ef38f5dd70c";
const expectedCommandLedgerSha256 = "671120e72b6eb40df3385ada746bdd571d8a582e8871ab936dd83a05cfa5ebd7";
const expectedMembers = ["P01", "S01", "P30", "S02", "C07", "P29"];
const expectedMcpToolCount = await expectedRuntimeMcpToolCount(path.resolve("."));

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileEvidence(filePath: string) {
  const bytes = await readFile(filePath);
  const info = await stat(filePath);
  return { path: filePath, bytes: info.size, sha256: sha256(bytes), mtimeMs: info.mtimeMs };
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(); } }));
  return hash.digest("hex");
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

const paths = getSidecarPaths(projectRoot);
const [beforeSource, fullSourceBefore] = await Promise.all([
  inspectFusionPackage({ packageRoot, sourceRoot, expectedCounts: THIRD_SEASON_FUSION_EXPECTED_COUNTS }),
  fullSourceSnapshot(sourceRoot),
]);
const [state, jobs, publications, doctor, snapshot, capabilities] = await Promise.all([
  getFusionAssetConsistencyState(projectRoot),
  listGenerationJobs(projectRoot),
  listPublicationIntents(projectRoot),
  doctorProject(projectRoot),
  getProjectSnapshot(projectRoot),
  getCapabilities(),
]);
const [afterSource, fullSourceAfter] = await Promise.all([
  inspectFusionPackage({ packageRoot, sourceRoot, expectedCounts: THIRD_SEASON_FUSION_EXPECTED_COUNTS }),
  fullSourceSnapshot(sourceRoot),
]);
const batch = state.batches.at(-1);
const assetJobs = jobs.filter((job) => job.kind === "image" && job.purpose === "asset").sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
const p01 = assetJobs.find((job) => job.itemId === "asset-P01");
if (!batch || !state.persisted || state.batchSize !== 6 || state.canEnqueueNewAsset || batch.status !== "generating" || !batch.sealed || batch.sealedReason !== "batch_size_reached" || batch.memberCount !== 6) throw new Error(`正式六张门禁状态无效：${JSON.stringify(state)}`);
if (batch.members.map((member) => member.assetId).join(",") !== expectedMembers.join(",")) throw new Error(`正式批次顺序漂移：${batch.members.map((member) => member.assetId).join(",")}`);
if (assetJobs.length !== 6 || assetJobs.some((job) => job.externalTaskId || job.publicationReceiptId || !["queued", "waiting_external"].includes(job.status))) throw new Error("当前六项任务存在远端身份、回执或意外状态，禁止继续验证。");
if (!p01 || p01.status !== "waiting_external" || p01.browserCheckpoint?.stage !== "preflight_blocked" || p01.browserCheckpoint.revision !== 2) throw new Error("P01 可恢复 R2 网页预检检查点没有被原样保留。");
const p01Preflight = p01.browserCheckpoint.preflightEvidence;
if (!p01Preflight || !p01Preflight.loginVerified || !p01Preflight.pageReady || p01Preflight.generationModeVerified || !p01Preflight.balanceChecked || !p01Preflight.paidActionRequired || p01Preflight.paidActionAuthorized) throw new Error("P01 R2 网页预检证据语义无效。");
if (p01Preflight.blockers?.join(",") !== "insufficient_credits,generation_mode_mismatch" || p01Preflight.observedGeneration?.model !== "纳米香蕉 2" || p01Preflight.observedGeneration.aspectRatio !== "16:9" || p01Preflight.observedGeneration.resolution !== "2K" || p01Preflight.observedGeneration.imageCount !== 1 || p01Preflight.observedGeneration.generateEnabled !== false || !p01Preflight.observedGeneration.creditMessage?.includes("积分不足")) throw new Error("P01 R2 阻塞代码或当前网页参数证据漂移。");
const browserPlan = await getBrowserGenerationPlan(projectRoot, p01.id);
const browserParameters = browserPlan.parameters as typeof browserPlan.parameters & { quality?: string; imageCount?: number };
if (browserParameters.model !== "GPT Image 2" || browserParameters.aspectRatio !== "9:16" || browserParameters.resolution !== "Medium" || browserParameters.quality !== "Medium" || browserParameters.imageCount !== 1 || browserPlan.capabilities.maxConcurrency !== 1) throw new Error(`P01 网页计划供应商参数漂移：${JSON.stringify(browserParameters)}`);
const outputPresence = await Promise.all(assetJobs.flatMap((job) => [job.expectedOutputPath, job.expectedCompanionPath].filter((value): value is string => Boolean(value)).map(async (filePath) => ({ path: filePath, exists: await exists(filePath) }))));
if (outputPresence.some((entry) => entry.exists)) throw new Error(`尚未执行网页生成却出现正式输出：${outputPresence.filter((entry) => entry.exists).map((entry) => entry.path).join("、")}`);
const jobStore = await fileEvidence(paths.generationJobs);
const publicationStore = await fileEvidence(paths.publications);
const consistencyStore = await fileEvidence(paths.assetConsistencyBatches);
const commandLedgerStore = await fileEvidence(paths.commandLedger);
if (jobStore.sha256 !== expectedJobStoreSha256 || publicationStore.sha256 !== expectedPublicationStoreSha256 || commandLedgerStore.sha256 !== expectedCommandLedgerSha256) throw new Error("正式 R2 检查点的 GenerationJob、Publication 或命令账本发生漂移。");
if (publications.filter((intent) => intent.status === "reserved").length !== 6 || publications.some((intent) => intent.receiptId)) throw new Error("正式 Publication 预留或回执数量异常。");
if (beforeSource.inventory.aggregateSha256 !== expectedControlledSourceAggregate || afterSource.inventory.aggregateSha256 !== expectedControlledSourceAggregate) throw new Error("第三季受控融合输入清单哈希漂移。");
if (fullSourceBefore.aggregateSha256 !== expectedFullSourceAggregate || fullSourceAfter.aggregateSha256 !== expectedFullSourceAggregate) throw new Error("第三季完整只读源目录的清单、大小、mtime 或 SHA 漂移。");
const doctorCheck = doctor.checks.find((check) => check.id === "fusion-asset-consistency");
if (!doctorCheck || doctorCheck.level !== "warning" || !doctorCheck.detail.includes("6/6")) throw new Error("Doctor 未正确暴露正式六张批次。");
if (snapshot.productionDesign.assetConsistency?.batches.at(-1)?.status !== "generating") throw new Error("统一项目快照未暴露六张批次状态。");
if (capabilities.server.toolCount !== expectedMcpToolCount) throw new Error(`MCP 能力工具数应为 ${expectedMcpToolCount}，实际 ${capabilities.server.toolCount}`);

const report = {
  schemaVersion: 1,
  kind: "fusion-asset-consistency-formal-validation",
  createdAt: new Date().toISOString(),
  projectRoot,
  sourceBoundary: {
    mode: "read-only",
    fullDirectory: { before: fullSourceBefore, after: fullSourceAfter, unchanged: fullSourceBefore.aggregateSha256 === fullSourceAfter.aggregateSha256 },
    controlledFusionInputs: {
      before: { files: beforeSource.inventory.files.length, bytes: beforeSource.inventory.totalBytes, aggregateSha256: beforeSource.inventory.aggregateSha256 },
      after: { files: afterSource.inventory.files.length, bytes: afterSource.inventory.totalBytes, aggregateSha256: afterSource.inventory.aggregateSha256 },
      unchanged: beforeSource.inventory.aggregateSha256 === afterSource.inventory.aggregateSha256,
    },
  },
  sidecars: { generationJobs: jobStore, publications: publicationStore, assetConsistency: consistencyStore, commandLedger: commandLedgerStore, existingStoresUnchangedDuringBootstrap: true },
  batch: {
    id: batch.id,
    status: batch.status,
    sealed: batch.sealed,
    sealedReason: batch.sealedReason,
    memberCount: batch.memberCount,
    readyCount: batch.readyCount,
    hardLockCount: batch.hardLockCount,
    requiredCriteria: batch.requiredCriteria,
    members: batch.members.map((member) => ({ order: member.order, assetId: member.assetId, itemId: member.itemId, jobId: member.currentJobId, jobStatus: member.jobStatus, issues: member.issues })),
  },
  existingP01: {
    jobId: p01.id,
    status: p01.status,
    browserStage: p01.browserCheckpoint?.stage,
    checkpointRevision: p01.browserCheckpoint?.revision,
    preflightEvidence: p01Preflight,
    plan: { model: browserParameters.model, aspectRatio: browserParameters.aspectRatio, quality: browserParameters.quality, imageCount: browserParameters.imageCount, concurrency: browserPlan.capabilities.maxConcurrency, allowedUploads: browserPlan.allowedUploadPaths },
    remoteIdentityAbsent: !p01.externalTaskId,
    publicationReceiptAbsent: !p01.publicationReceiptId,
  },
  outputPresence,
  publications: { total: publications.length, reserved: publications.filter((intent) => intent.status === "reserved").length, receipts: publications.filter((intent) => intent.receiptId).length },
  doctor: doctorCheck,
  snapshot: { storeRevision: snapshot.productionDesign.assetConsistency?.storeRevision, status: snapshot.productionDesign.assetConsistency?.batches.at(-1)?.status, suggestedNextCalls: snapshot.suggestedNextCalls },
  mcp: { protocolVersion: capabilities.server.protocolVersion, toolCount: capabilities.server.toolCount },
  assertions: { sourceUnchanged: true, formalCheckpointStoresStable: true, existingPublicationsUnchanged: true, noRemoteSubmission: true, noFormalOutputs: true, sameP01RecoverablyBlocked: true, seventhAssetBlocked: true },
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, sourceBoundary: report.sourceBoundary, batch: report.batch, existingP01: report.existingP01, mcp: report.mcp, assertions: report.assertions }, null, 2)}\n`);
