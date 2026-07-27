import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getFusionAssetConsistencyState } from "../src/core/fusion-asset-consistency.js";
import { getSidecarPaths, readJson, writeJsonAtomicExclusive } from "../src/core/sidecar.js";

const projectRoot = path.resolve(process.argv[2] ?? "/Users/hxx/Documents/无限画布/productions/gushujuan-s3-f1a688020bfb7af6");
const evidencePath = path.resolve(process.argv[3] ?? "/Users/hxx/Documents/无限画布/docs/evidence/fusion-asset-production-order-formal-20260715.json");

async function fileSha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

const paths = getSidecarPaths(projectRoot);
const guardedPaths = {
  generationJobs: paths.generationJobs,
  publications: paths.publications,
  assetConsistency: paths.assetConsistencyBatches,
  commandLedger: paths.commandLedger,
};
const beforeHashes = Object.fromEntries(await Promise.all(Object.entries(guardedPaths).map(async ([key, filePath]) => [key, await fileSha256(filePath)])));
const state = await getFusionAssetConsistencyState(projectRoot);
const firstBatch = state.batches[0]?.members.map((member) => member.assetId) ?? [];
const expectedFirstBatch = ["P01", "S01", "P30", "S02", "C07", "P29"];
const expectedNextBatch = ["P11", "P07", "S03", "C04a", "P03", "S07"];
if (JSON.stringify(firstBatch) !== JSON.stringify(expectedFirstBatch)) throw new Error(`正式首批资产顺序漂移：${JSON.stringify(firstBatch)}`);
if (state.productionOrder.version !== "hidden-mask-first-then-first-appearance-v1"
  || state.productionOrder.totalAssets !== 75
  || state.productionOrder.reservedAssets !== 6
  || state.productionOrder.nextAssetId !== "P11"
  || JSON.stringify(state.productionOrder.nextBatchAssetIds) !== JSON.stringify(expectedNextBatch)) {
  throw new Error(`正式后续资产生产顺序漂移：${JSON.stringify(state.productionOrder)}`);
}
if (state.canEnqueueNewAsset || !state.blockingIssues.some((issue) => issue.includes("fusion-asset-batch-001"))) {
  throw new Error("正式首批尚未通过时必须继续阻止第二批入队。 ");
}
const afterHashes = Object.fromEntries(await Promise.all(Object.entries(guardedPaths).map(async ([key, filePath]) => [key, await fileSha256(filePath)])));
if (JSON.stringify(beforeHashes) !== JSON.stringify(afterHashes)) throw new Error("正式资产生产顺序只读核验期间侧车发生变化。 ");

const report = {
  schemaVersion: 1,
  kind: "fusion-asset-production-order-formal-validation",
  createdAt: new Date().toISOString(),
  projectRoot,
  sourceContentAddress: state.sourceContentAddress,
  firstBatch,
  productionOrder: state.productionOrder,
  gate: {
    canEnqueueNewAsset: state.canEnqueueNewAsset,
    currentBatchId: state.batches[0]?.id,
    currentBatchStatus: state.batches[0]?.status,
    nextBatchRemainsBlocked: true,
  },
  guardedSidecarHashes: afterHashes,
  mutationDetected: false,
};
const existing = await readJson<typeof report | null>(evidencePath, null);
if (existing) {
  const stable = (value: typeof report) => JSON.stringify({ ...value, createdAt: "<run-time>" });
  if (stable(existing) !== stable(report)) throw new Error(`既有正式资产顺序证据与当前核验冲突：${evidencePath}`);
} else {
  await writeJsonAtomicExclusive(evidencePath, report);
}
process.stdout.write(`${JSON.stringify({ evidencePath, reusedEvidence: Boolean(existing), ...report }, null, 2)}\n`);
