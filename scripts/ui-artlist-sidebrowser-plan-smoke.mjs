import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(process.argv[2] || "/Users/hxx/Documents/无限画布/productions/gushujuan-s3-f1a688020bfb7af6");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-artlist-sidebrowser-plan-ui-registry-20260716.json");
const evidencePath = path.resolve(process.argv[4] || path.join(workspace, "docs/evidence/artlist-sidebrowser-plan-ui-smoke-20260716.json"));
const screenshotPath = path.resolve(process.argv[5] || path.join(workspace, "docs/evidence/artlist-sidebrowser-plan-ui-smoke-20260716.png"));
const jobId = process.argv[6] || "gen-2026-07-15T11-19-38-303Z-23ac427f";
const sidecar = path.join(projectRoot, ".aicanvas");
const executionSurface = { id: "codex-in-app-side-browser", version: "1" };

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
  commandLedger: path.join(sidecar, "command-ledger.json"),
  generationSettings: path.join(sidecar, "generation.json"),
  browserPlan: path.join(sidecar, "generation-requests", `${jobId}.browser.json`),
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
    AI_CANVAS_WINDOW_HEIGHT: "1080",
  },
});

try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(120_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "生成队列", exact: true }).click();
  await page.getByRole("heading", { name: "可恢复生成队列" }).waitFor();
  const row = page.locator(".job-row").filter({ hasText: jobId });
  if (await row.count() !== 1) throw new Error(`正式 P01 job 行数不是 1：${await row.count()}`);
  await row.locator(".browser-checkpoint").waitFor();

  const apiState = await page.evaluate(async ({ projectRoot, jobId }) => {
    const [jobs, settings] = await Promise.all([
      window.canvasApi.listGenerationJobs(projectRoot),
      window.canvasApi.getGenerationSettings(projectRoot),
    ]);
    const job = jobs.find((entry) => entry.id === jobId);
    return {
      jobCount: jobs.length,
      settingsRevision: settings.revision,
      job: job ? {
        id: job.id,
        itemId: job.itemId,
        status: job.status,
        browserState: job.browserState,
        browserCheckpoint: job.browserCheckpoint,
        model: job.model,
        parameters: job.parameters,
        referencePaths: job.referencePaths,
        externalTaskId: job.externalTaskId,
        resultPath: job.resultPath,
        publicationReceiptId: job.publicationReceiptId,
        publicationIntentId: job.publicationIntentId,
      } : undefined,
      provider: settings.providers.find((entry) => entry.id === "artlist-gpt-image-2"),
    };
  }, { projectRoot, jobId });
  if (!apiState.job || apiState.jobCount !== 6 || apiState.job.status !== "waiting_external" || apiState.job.browserState !== "plan_ready") throw new Error(`P01 API 状态不正确：${JSON.stringify(apiState)}`);
  if (apiState.job.browserCheckpoint?.revision !== 3 || apiState.job.browserCheckpoint.stage !== "plan_ready") throw new Error(`P01 检查点不是 R3 / plan_ready：${JSON.stringify(apiState.job.browserCheckpoint)}`);
  if (JSON.stringify(apiState.job.browserCheckpoint.executionSurface) !== JSON.stringify(executionSurface)) throw new Error(`P01 检查点执行面漂移：${JSON.stringify(apiState.job.browserCheckpoint)}`);
  if (apiState.settingsRevision !== 3 || JSON.stringify(apiState.provider?.executionSurface) !== JSON.stringify(executionSurface)) throw new Error(`Artlist provider 执行面迁移未落盘：${JSON.stringify(apiState.provider)}`);
  if (!apiState.provider?.browserInstructions?.includes("Codex 应用内侧边浏览器") || apiState.provider.browserInstructions.includes("已登录 Chrome")) throw new Error(`Artlist provider 文案仍指向错误执行面：${JSON.stringify(apiState.provider)}`);
  if (apiState.job.model !== "GPT Image 2" || apiState.job.parameters?.aspectRatio !== "9:16" || apiState.job.parameters?.resolution !== "Medium" || apiState.job.parameters?.imageCount !== 1 || apiState.job.referencePaths.length !== 0) throw new Error(`P01 冻结合同漂移：${JSON.stringify(apiState.job)}`);
  if (apiState.job.externalTaskId || apiState.job.resultPath || apiState.job.publicationReceiptId) throw new Error(`P01 出现未授权远端或结果身份：${JSON.stringify(apiState.job)}`);

  const rendered = await row.evaluate((element) => ({
    status: element.querySelector(".job-state")?.textContent?.replace(/\s+/gu, " ").trim(),
    checkpoint: element.querySelector(".browser-checkpoint")?.textContent?.replace(/\s+/gu, " ").trim(),
    blockedCount: element.querySelectorAll(".preflight-blocked").length,
    submitIntentCount: element.querySelectorAll(".submit-intent").length,
    uploadSlotCount: element.querySelectorAll(".upload-slots").length,
    rowRect: (() => { const rect = element.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width }; })(),
    listRect: (() => { const rect = element.closest(".job-list")?.getBoundingClientRect(); return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width } : undefined; })(),
    pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    pageOverflowY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
  if (rendered.status !== "等待外部落盘" || !rendered.checkpoint?.includes("网页 plan_ready · R3 · codex-in-app-side-browser@1")) throw new Error(`P01 side-browser UI 文本不完整：${JSON.stringify(rendered)}`);
  if (rendered.blockedCount || rendered.submitIntentCount || rendered.uploadSlotCount || rendered.pageOverflowX || rendered.pageOverflowY || pageErrors.length) throw new Error(`P01 UI 误显示副作用或发生溢出：${JSON.stringify({ rendered, pageErrors })}`);
  if (!rendered.listRect || rendered.rowRect.left < rendered.listRect.left - 1 || rendered.rowRect.right > rendered.listRect.right + 1 || rendered.rowRect.top < rendered.listRect.top - 1 || rendered.rowRect.bottom > rendered.listRect.bottom + 1) throw new Error(`P01 job 行被裁切：${JSON.stringify(rendered)}`);

  await page.screenshot({ path: screenshotPath, type: "png", animations: "disabled" });
  const afterHashes = Object.fromEntries(await Promise.all(Object.entries(guardedFiles).map(async ([key, filePath]) => [key, await fileSha256(filePath)])));
  if (JSON.stringify(beforeHashes) !== JSON.stringify(afterHashes)) throw new Error(`只读 UI 烟测意外改写生产侧车：${JSON.stringify({ beforeHashes, afterHashes })}`);
  const screenshotSha256 = await fileSha256(screenshotPath);
  const report = {
    schemaVersion: 1,
    kind: "artlist-sidebrowser-plan-ui-smoke",
    createdAt: new Date().toISOString(),
    transport: "electron-current-production-build",
    projectRoot,
    jobId,
    registryPath,
    screenshot: { path: screenshotPath, sha256: screenshotSha256 },
    guardedFiles: { beforeHashes, afterHashes, unchanged: true },
    apiState,
    rendered,
    pageErrors,
  };
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ evidencePath, screenshotPath, screenshotSha256, rendered, guardedFiles: report.guardedFiles, pageErrors }, null, 2)}\n`);
} finally {
  await app.close();
}
