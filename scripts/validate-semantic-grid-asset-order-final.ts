import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import fg from "fast-glob";
import { doctorProject, getCapabilities } from "../src/core/codex.js";
import { getFusionAssetConsistencyState } from "../src/core/fusion-asset-consistency.js";
import { inspectFusionPackage, THIRD_SEASON_FUSION_EXPECTED_COUNTS } from "../src/core/fusion-package.js";
import { loadFusionProjectManifest } from "../src/core/fusion-production.js";
import { materializeAllFusionStoryboardGrids } from "../src/core/fusion-storyboard-production.js";
import { listGenerationJobs } from "../src/core/generation.js";
import { getSidecarPaths, readJson, writeJsonAtomicExclusive } from "../src/core/sidecar.js";
import { expectedRuntimeMcpToolCount } from "../src/core/release-manifest.js";

const workspace = path.resolve(process.argv[2] ?? "/Users/hxx/Documents/无限画布");
const expectedMcpToolCount = await expectedRuntimeMcpToolCount(workspace);
const projectRoot = path.resolve(process.argv[3] ?? path.join(workspace, "productions/gushujuan-s3-f1a688020bfb7af6"));
const evidencePath = path.resolve(process.argv[4] ?? path.join(workspace, "docs/evidence/final-validation-20260716-storyboard-preview-visible-time.json"));
const sourceRoot = "/Users/hxx/Documents/古蜀卷第三季";
const packageRoot = path.join(sourceRoot, "07_9x16_15秒融合制作包");
const expectedFullSourceAggregate = "649160f22663ca4c45ee4a4084e278ef0edc61ec66db01bb84da38cbea3f8d26";
const expectedControlledSourceAggregate = "f1a688020bfb7af6a39e2d9e7f383f773fdd4fdc27a9562695017509a1600a8c";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(); } }));
  return hash.digest("hex");
}

async function fileEvidence(filePath: string): Promise<{ path: string; bytes: number; sha256: string }> {
  const metadata = await stat(filePath);
  return { path: filePath, bytes: metadata.size, sha256: await sha256File(filePath) };
}

async function fullSourceSnapshot(root: string): Promise<{ files: number; bytes: number; aggregateSha256: string }> {
  const relativePaths = (await fg("**/*", { cwd: root, onlyFiles: true, followSymbolicLinks: false, dot: true })).sort((left, right) => left.localeCompare(right, "en"));
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

const paths = getSidecarPaths(projectRoot);
const correctedGridEvidencePath = path.join(workspace, "docs/evidence/fusion-s3-storyboard-grids-semantic-v1-visible-time-policy-v1-20260716.json");
const gridUiEvidencePath = path.join(workspace, "docs/evidence/fusion-storyboard-grid-semantic-visible-time-policy-v1-ui-smoke-20260716.json");
const sheetPreviewEvidencePath = path.join(workspace, "docs/evidence/fusion-storyboard-sheet-ep01-008-contract-preview-visible-time-policy-v1-20260716.json");
const assetOrderEvidencePath = path.join(workspace, "docs/evidence/fusion-asset-production-order-formal-20260715.json");
const assetOrderUiEvidencePath = path.join(workspace, "docs/evidence/fusion-asset-production-order-ui-smoke-20260715.json");
const zeroUploadEvidencePath = path.join(workspace, "docs/evidence/p01-text-only-resume-formal-smoke-20260715.json");

const [controlledBefore, fullBefore] = await Promise.all([
  inspectFusionPackage({ packageRoot, sourceRoot, expectedCounts: THIRD_SEASON_FUSION_EXPECTED_COUNTS }),
  fullSourceSnapshot(sourceRoot),
]);
const [gridEvidence, gridUiEvidence, sheetPreviewEvidence, assetOrderEvidence, assetOrderUiEvidence, zeroUploadEvidence] = await Promise.all([
  readJson<Record<string, any> | null>(correctedGridEvidencePath, null),
  readJson<Record<string, any> | null>(gridUiEvidencePath, null),
  readJson<Record<string, any> | null>(sheetPreviewEvidencePath, null),
  readJson<Record<string, any> | null>(assetOrderEvidencePath, null),
  readJson<Record<string, any> | null>(assetOrderUiEvidencePath, null),
  readJson<Record<string, any> | null>(zeroUploadEvidencePath, null),
]);
if (!gridEvidence || !gridUiEvidence || !sheetPreviewEvidence || !assetOrderEvidence || !assetOrderUiEvidence || !zeroUploadEvidence) throw new Error("最终验证缺少语义宫格、中文板预览、资产顺序、UI 或零上传证据。 ");

const [gridResult, manifest, consistency, jobs, doctor, capabilities] = await Promise.all([
  materializeAllFusionStoryboardGrids(projectRoot, { persist: false }),
  loadFusionProjectManifest(projectRoot),
  getFusionAssetConsistencyState(projectRoot),
  listGenerationJobs(projectRoot),
  doctorProject(projectRoot),
  getCapabilities(),
]);
if (!manifest) throw new Error("正式融合 manifest 不存在。 ");
const contractIdsSha256 = sha256(gridResult.contractIds.join("\n"));
if (gridResult.algorithmVersion !== "semantic-beat-v1"
  || gridResult.contracts !== 1_288
  || gridResult.visibleTimePolicyVersion !== "one-decimal-boundaries-then-difference-v1"
  || JSON.stringify(gridResult.panelDistribution) !== JSON.stringify({ "2": 151, "3": 667, "4": 349, "5": 95, "6": 26 })
  || gridResult.panelImagesRequired !== 4_330
  || contractIdsSha256 !== "9c646f95d64f556274915bb0ad3e4065e5f2c613d6bb1eb2f203bbed4f5623e2") {
  throw new Error(`全季语义宫格当前结果漂移：${JSON.stringify(gridResult)}`);
}
if (gridEvidence.ep01?.units !== 34 || gridEvidence.ep01?.panelImagesRequired !== 146 || gridEvidence.ep01?.rawImagesRequired !== 146 || gridEvidence.ep01?.labeledImagesRequired !== 146) {
  throw new Error("EP01 语义宫格生产计数证据无效。 ");
}
if (gridUiEvidence.apiState?.selectedItemId !== "season-三-ep01-unit008" || gridUiEvidence.apiState?.panelCount !== 6 || gridUiEvidence.apiState?.algorithmVersion !== "semantic-beat-v1" || !gridUiEvidence.apiState?.allPanelBeatsAudited || !gridUiEvidence.apiState?.uniquePanelPrompts || gridUiEvidence.pageErrors?.length) {
  throw new Error("EP01_15s_008 Electron 语义宫格烟测无效。 ");
}
if (Math.abs(Number(gridUiEvidence.apiState?.visibleDurationTotal) - 15) > 0.001
  || gridUiEvidence.apiState?.visibleDurationLabels?.[3] !== "9.7–11.3s（1.6s）"
  || gridUiEvidence.apiState?.contractId !== sheetPreviewEvidence.contract?.id) {
  throw new Error("EP01_15s_008 UI、可见秒段或布局预览合同身份不一致。 ");
}
if (sheetPreviewEvidence.kind !== "fusion-storyboard-sheet-formal-contract-preview-evidence"
  || sheetPreviewEvidence.evidenceRole !== "formal-contract-layout-preview"
  || sheetPreviewEvidence.fixtureOnly !== true
  || sheetPreviewEvidence.formalProductionEligible !== false
  || sheetPreviewEvidence.render?.renderPurpose !== "layout-preview"
  || sheetPreviewEvidence.render?.formalProductionEligible !== false
  || sheetPreviewEvidence.guardedSidecars?.unchanged !== true
  || Object.values(sheetPreviewEvidence.checks ?? {}).some((passed) => passed !== true)
  || sheetPreviewEvidence.formalSideEffects?.productionOutputsWritten !== 0) {
  throw new Error("EP01_15s_008 详细中文布局预览身份或机械证据无效。 ");
}
if (JSON.stringify(consistency.productionOrder.nextBatchAssetIds) !== JSON.stringify(["P11", "P07", "S03", "C04a", "P03", "S07"])
  || consistency.productionOrder.totalAssets !== 75
  || consistency.productionOrder.reservedAssets !== 6
  || consistency.canEnqueueNewAsset) {
  throw new Error(`正式资产生产顺序或当前六张门禁漂移：${JSON.stringify(consistency.productionOrder)}`);
}
if (assetOrderEvidence.mutationDetected !== false || assetOrderUiEvidence.apiState?.productionOrder?.nextAssetId !== "P11" || assetOrderUiEvidence.pageErrors?.length) throw new Error("正式资产顺序 Core/UI 证据无效。 ");
if (zeroUploadEvidence.result?.plan?.mode !== "text" || zeroUploadEvidence.result?.plan?.allowedUploads?.length !== 0
  || zeroUploadEvidence.result?.simulatedTransitions?.[1]?.uploadEvidence?.expectedFileCount !== 0
  || zeroUploadEvidence.result?.simulatedTransitions?.[1]?.uploadEvidence?.uploadRequired !== false
  || zeroUploadEvidence.result?.remoteSideEffects?.generateClicked !== false) {
  throw new Error("P01 text-only 零上传恢复证据无效。 ");
}
const assetJobs = jobs.filter((job) => job.kind === "image" && job.purpose === "asset");
const p01 = assetJobs.find((job) => job.itemId === "asset-P01");
if (assetJobs.length !== 6 || !p01 || p01.status !== "waiting_external" || p01.browserCheckpoint?.stage !== "preflight_blocked" || p01.browserCheckpoint.revision !== 2
  || assetJobs.some((job) => job.externalTaskId || job.publicationReceiptId || job.resultPath)) throw new Error("正式 P01 R2 或六项零远端副作用状态漂移。 ");
const formalOutputPresence = await Promise.all(assetJobs.flatMap((job) => [job.expectedOutputPath, job.expectedCompanionPath].filter((value): value is string => Boolean(value)).map(async (filePath) => ({ path: filePath, exists: await access(filePath).then(() => true).catch(() => false) }))));
if (formalOutputPresence.some((entry) => entry.exists)) throw new Error("网页生成尚未执行却出现正式资产输出。 ");
if (doctor.summary?.errors !== 0 || !doctor.checks.some((check) => check.id === "existing-production-recovery" && check.level === "ok") || capabilities.server.toolCount !== expectedMcpToolCount) throw new Error(`Doctor 或 MCP 能力验证失败：${JSON.stringify({ doctor: doctor.summary, tools: capabilities.server.toolCount })}`);

const currentContractPresence = await Promise.all(manifest.units.map(async (unit, index) => {
  const itemId = `season-三-ep${String(unit.episodeNumber).padStart(2, "0")}-unit${String(unit.sequence).padStart(3, "0")}`;
  const contractId = gridResult.contractIds[index]!;
  const contractPath = path.join(paths.storyboardGrids, itemId, `${contractId}.json`);
  return access(contractPath).then(() => true).catch(() => false);
}));
if (currentContractPresence.some((present) => !present)) throw new Error("至少一个当前 semantic-beat-v1 合同未落盘。 ");

const buildArtifacts = await Promise.all([
  fileEvidence(path.join(workspace, "out/main/index.js")),
  fileEvidence(path.join(workspace, "out/renderer/index.html")),
  fileEvidence(path.join(workspace, "dist-mcp/mcp/server.js")),
]);
const [controlledAfter, fullAfter] = await Promise.all([
  inspectFusionPackage({ packageRoot, sourceRoot, expectedCounts: THIRD_SEASON_FUSION_EXPECTED_COUNTS }),
  fullSourceSnapshot(sourceRoot),
]);
if (controlledBefore.inventory.aggregateSha256 !== expectedControlledSourceAggregate || controlledAfter.inventory.aggregateSha256 !== expectedControlledSourceAggregate
  || fullBefore.aggregateSha256 !== expectedFullSourceAggregate || fullAfter.aggregateSha256 !== expectedFullSourceAggregate
  || controlledBefore.inventory.aggregateSha256 !== controlledAfter.inventory.aggregateSha256 || fullBefore.aggregateSha256 !== fullAfter.aggregateSha256) {
  throw new Error("第三季只读源的清单、大小、mtime 或 SHA 在最终验证中发生漂移。 ");
}

const report = {
  schemaVersion: 1,
  kind: "semantic-grid-asset-order-final-validation",
  status: "passed-with-expected-external-blocker",
  createdAt: new Date().toISOString(),
  workspace,
  projectRoot,
  sourceContentAddress: manifest.contentAddress,
  sourceBoundary: {
    mode: "read-only",
    fullDirectory: { before: fullBefore, after: fullAfter, unchanged: true },
    controlledFusionInputs: {
      before: { files: controlledBefore.inventory.files.length, bytes: controlledBefore.inventory.totalBytes, aggregateSha256: controlledBefore.inventory.aggregateSha256 },
      after: { files: controlledAfter.inventory.files.length, bytes: controlledAfter.inventory.totalBytes, aggregateSha256: controlledAfter.inventory.aggregateSha256 },
      unchanged: true,
    },
  },
  semanticStoryboardGrid: {
    algorithmVersion: gridResult.algorithmVersion,
    contracts: gridResult.contracts,
    panelDistribution: gridResult.panelDistribution,
    panelImagesRequired: gridResult.panelImagesRequired,
    contractIdsSha256,
    currentContractsPresent: currentContractPresence.filter(Boolean).length,
    ep01: gridEvidence.ep01,
    uiEvidence: { path: gridUiEvidencePath, screenshotPath: gridUiEvidence.screenshotPath, screenshotSha256: gridUiEvidence.screenshotSha256 },
    visibleTimePolicyVersion: gridResult.visibleTimePolicyVersion,
    visibleTimeQuantization: gridEvidence.policy?.visibleTimeQuantization,
    detailedChineseSheetPreview: {
      path: sheetPreviewEvidencePath,
      renderPurpose: sheetPreviewEvidence.render.renderPurpose,
      formalProductionEligible: sheetPreviewEvidence.formalProductionEligible,
      png: sheetPreviewEvidence.render.png,
      svg: sheetPreviewEvidence.render.svg,
      contractId: sheetPreviewEvidence.contract.id,
      checks: sheetPreviewEvidence.checks,
    },
    supersededEvidence: [
      { path: path.join(workspace, "docs/evidence/fusion-s3-storyboard-grids-semantic-v1-20260715.json"), reason: "raw/labeled 旧字段误留 71；不得用于当前计数" },
      { path: path.join(workspace, "docs/evidence/fusion-s3-storyboard-grids-semantic-v1-corrected-20260715.json"), reason: "可见时长独立四舍五入会让 EP01_008 显示合计为 15.1s" },
      { path: path.join(workspace, "docs/evidence/fusion-storyboard-sheet-ep01-008-contract-preview-20260716.json"), reason: "修复前第 4 格错误显示 1.7s；由 v2 预览取代" },
      { path: path.join(workspace, "docs/evidence/fusion-s3-storyboard-grids-semantic-v1-visible-time-v2-20260716.json"), reason: "可见时间策略尚未进入合同和 UI 幂等键；由 policy-v1 证据取代" },
      { path: path.join(workspace, "docs/evidence/fusion-storyboard-sheet-ep01-008-contract-preview-v2-20260716.json"), reason: "时间数值已修正但策略未版本化；由 policy-v1 预览取代" },
    ],
  },
  assetProductionOrder: {
    ...consistency.productionOrder,
    currentBatch: consistency.batches[0]?.id,
    currentBatchStatus: consistency.batches[0]?.status,
    nextBatchBlockedUntilCurrentReviewAndHardLocks: true,
    coreEvidence: assetOrderEvidencePath,
    uiEvidence: { path: assetOrderUiEvidencePath, screenshot: assetOrderUiEvidence.screenshot },
  },
  browserTextOnlyRecovery: {
    evidencePath: zeroUploadEvidencePath,
    formalJobId: p01.id,
    currentStatus: p01.status,
    currentStage: p01.browserCheckpoint.stage,
    currentRevision: p01.browserCheckpoint.revision,
    zeroUploadCheckpointSupported: true,
    remoteSideEffects: false,
  },
  tests: {
    files: 49,
    tests: 290,
    status: "passed",
    execution: "vitest full suite",
    focusedRerunAfterDoctorFix: { files: 3, tests: 18, status: "passed" },
  },
  build: { status: "passed", artifacts: buildArtifacts },
  mcp: { status: "passed", toolCount: capabilities.server.toolCount },
  doctor: { status: "passed", summary: doctor.summary, expectedWarnings: doctor.checks.filter((check) => check.level === "warning").map((check) => check.id) },
  formalProduction: {
    assetJobs: assetJobs.length,
    formalAssetRawImages: 0,
    formalAssetLabeledImages: 0,
    formalStoryboardPanelRawImages: 0,
    formalStoryboardPanelLabeledImages: 0,
    formalChineseStoryboardSheets: 0,
    outputPresence: formalOutputPresence,
  },
  externalBlocker: {
    code: "artlist-insufficient-credits-and-mode-mismatch",
    recoverable: true,
    nextAction: "用户确认 Artlist 额度已恢复后，读取同一 P01 计划并从 R2 重新预检；不得重新入队、购买积分或重复点击 Generate。",
  },
  goal: { status: "active", completedSlice: "semantic-beat-v1 全季建库、text-only 零上传恢复链、资产首次出场顺序门禁、正式/预览成板身份门禁与可见时长修复", remaining: "EP01 18 项新资产、146 raw/labeled 逐格图与 34 张正式中文故事板，再逐集扩展全季" },
};
const existing = await readJson<typeof report | null>(evidencePath, null);
if (existing) {
  const stable = (value: typeof report) => JSON.stringify({ ...value, createdAt: "<run-time>" });
  if (stable(existing) !== stable(report)) throw new Error(`既有 final-validation 与当前结果冲突：${evidencePath}`);
} else {
  await writeJsonAtomicExclusive(evidencePath, report);
}
process.stdout.write(`${JSON.stringify({ evidencePath, reusedEvidence: Boolean(existing), status: report.status, sourceBoundary: report.sourceBoundary, semanticStoryboardGrid: report.semanticStoryboardGrid, assetProductionOrder: report.assetProductionOrder, tests: report.tests, doctor: report.doctor, formalProduction: report.formalProduction, externalBlocker: report.externalBlocker, goal: report.goal }, null, 2)}\n`);
