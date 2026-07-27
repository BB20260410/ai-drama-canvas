import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(process.argv[2] || "/Users/hxx/Documents/无限画布/productions/gushujuan-s3-f1a688020bfb7af6");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-fusion-asset-consistency-ui-registry-20260715.json");
const evidencePath = path.resolve(process.argv[4] || path.join(workspace, "docs/evidence/fusion-asset-production-order-ui-smoke-20260715.json"));
const screenshotPath = path.resolve(process.argv[5] || path.join(workspace, "docs/evidence/fusion-asset-production-order-ui-smoke-20260715.png"));
const sidecar = path.join(projectRoot, ".aicanvas");

async function fileSha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

await Promise.all([
  mkdir(path.dirname(registryPath), { recursive: true }),
  mkdir(path.dirname(evidencePath), { recursive: true }),
  mkdir(path.dirname(screenshotPath), { recursive: true }),
]);
const projectConfig = JSON.parse(await readFile(path.join(sidecar, "project.json"), "utf8"));
await writeFile(registryPath, `${JSON.stringify([{ id: projectConfig.id, name: projectConfig.name, primaryRoot: projectRoot, updatedAt: projectConfig.updatedAt }], null, 2)}\n`, "utf8");

const guardedFiles = {
  generationJobs: path.join(sidecar, "generation-jobs.json"),
  publications: path.join(sidecar, "publications.json"),
  consistency: path.join(sidecar, "asset-consistency-batches.json"),
};
const beforeHashes = Object.fromEntries(await Promise.all(Object.entries(guardedFiles).map(async ([key, filePath]) => [key, await fileSha256(filePath)])));
const pageErrors = [];
const app = await electron.launch({
  args: ["."],
  cwd: workspace,
  env: {
    ...process.env,
    AI_CANVAS_PROJECT_ROOT: projectRoot,
    AI_CANVAS_REGISTRY_PATH: registryPath,
    AI_CANVAS_WINDOW_WIDTH: "1720",
    AI_CANVAS_WINDOW_HEIGHT: "1100",
  },
});

try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(120_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "生产设计", exact: true }).click();
  await page.getByRole("heading", { name: "生产设计与连续性" }).waitFor();
  await page.getByTestId("design-tab-consistency").click();
  await page.getByTestId("fusion-asset-consistency-view").waitFor();
  await page.getByTestId("refresh-fusion-asset-consistency").click();
  await page.getByText("fusion-asset-batch-001 · 生成中", { exact: true }).waitFor();

  const apiState = await page.evaluate(async ({ projectRoot }) => {
    const [state, jobs] = await Promise.all([
      window.canvasApi.getFusionAssetConsistency(projectRoot),
      window.canvasApi.listGenerationJobs(projectRoot),
    ]);
    const batch = state.batches.at(-1);
    return {
      persisted: state.persisted,
      batchSize: state.batchSize,
      canEnqueueNewAsset: state.canEnqueueNewAsset,
      productionOrder: state.productionOrder,
      batch: batch ? {
        id: batch.id,
        status: batch.status,
        sealed: batch.sealed,
        memberCount: batch.memberCount,
        readyCount: batch.readyCount,
        hardLockCount: batch.hardLockCount,
        requiredCriteria: batch.requiredCriteria,
        members: batch.members.map((member) => ({ order: member.order, assetId: member.assetId, itemId: member.itemId, jobId: member.currentJobId, jobStatus: member.jobStatus })),
      } : undefined,
      jobs: jobs.map((job) => ({ id: job.id, status: job.status, stage: job.browserCheckpoint?.stage, externalTaskId: job.externalTaskId, publicationReceiptId: job.publicationReceiptId })),
    };
  }, { projectRoot });
  if (!apiState.persisted || apiState.batchSize !== 6 || apiState.canEnqueueNewAsset || apiState.batch?.status !== "generating" || apiState.batch.memberCount !== 6 || !apiState.batch.sealed) {
    throw new Error(`六张门禁 API 状态不符合正式批次：${JSON.stringify(apiState)}`);
  }
  const expectedAssets = ["P01", "S01", "P30", "S02", "C07", "P29"];
  const expectedNextBatch = ["P11", "P07", "S03", "C04a", "P03", "S07"];
  if (apiState.batch.members.map((member) => member.assetId).join(",") !== expectedAssets.join(",")) throw new Error(`正式六项顺序漂移：${JSON.stringify(apiState.batch.members)}`);
  if (apiState.productionOrder?.version !== "hidden-mask-first-then-first-appearance-v1" || apiState.productionOrder.nextBatchAssetIds.join(",") !== expectedNextBatch.join(",")) throw new Error(`正式后续资产顺序漂移：${JSON.stringify(apiState.productionOrder)}`);
  if (apiState.jobs.some((job) => job.externalTaskId || job.publicationReceiptId)) throw new Error(`烟测前已有未授权远端身份或 Publication 回执：${JSON.stringify(apiState.jobs)}`);

  const rendered = await page.evaluate(() => ({
    memberCards: document.querySelectorAll(".consistency-members article").length,
    criteria: document.querySelectorAll(".consistency-review select").length,
    heading: document.querySelector(".consistency-overview>header")?.textContent?.replace(/\s+/gu, " ").trim(),
    metrics: document.querySelector(".consistency-metrics")?.textContent?.replace(/\s+/gu, " ").trim(),
    productionOrder: document.querySelector('[data-testid="fusion-asset-production-order"]')?.textContent?.replace(/\s+/gu, " ").trim(),
    submitDisabled: document.querySelector('[data-testid="submit-fusion-asset-consistency"]')?.hasAttribute("disabled"),
    pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  if (rendered.memberCards !== 6 || rendered.criteria !== 7 || !rendered.productionOrder?.includes(expectedNextBatch.join(" → ")) || !rendered.submitDisabled || rendered.pageOverflowX || pageErrors.length) throw new Error(`六张复核 UI 结构、生产顺序或运行状态异常：${JSON.stringify({ rendered, pageErrors })}`);

  await page.screenshot({ path: screenshotPath, type: "png", animations: "disabled" });
  const afterHashes = Object.fromEntries(await Promise.all(Object.entries(guardedFiles).map(async ([key, filePath]) => [key, await fileSha256(filePath)])));
  if (JSON.stringify(beforeHashes) !== JSON.stringify(afterHashes)) throw new Error(`只读 UI 烟测意外改写了生产侧车：${JSON.stringify({ beforeHashes, afterHashes })}`);
  const screenshotSha256 = await fileSha256(screenshotPath);
  const report = {
    schemaVersion: 1,
    kind: "fusion-asset-consistency-ui-smoke",
    createdAt: new Date().toISOString(),
    transport: "electron-current-production-build",
    projectRoot,
    registryPath,
    screenshot: { path: screenshotPath, sha256: screenshotSha256 },
    guardedFiles: { beforeHashes, afterHashes, unchanged: true },
    apiState,
    rendered,
    pageErrors,
  };
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ evidencePath, screenshotPath, screenshotSha256, apiState, rendered, pageErrors }, null, 2)}\n`);
} finally {
  await app.close();
}
