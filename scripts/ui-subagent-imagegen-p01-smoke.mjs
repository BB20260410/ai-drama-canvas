import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(process.argv[2] || "/Users/hxx/Documents/无限画布/productions/gushujuan-s3-f1a688020bfb7af6");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-subagent-imagegen-p01-ui-registry-20260716.json");
const evidencePath = path.resolve(process.argv[4] || path.join(workspace, "docs/evidence/subagent-imagegen-p01-ui-smoke-20260716.json"));
const screenshotPath = path.resolve(process.argv[5] || path.join(workspace, "docs/evidence/subagent-imagegen-p01-ui-smoke-20260716.png"));
const jobId = process.argv[6] || "gen-2026-07-15T11-19-38-303Z-23ac427f";
const sidecar = path.join(projectRoot, ".aicanvas");
const expectedRawSha256 = "907e96df267d3520c302ea2dad36afa5f6c42181f28492bd35a22450e5ad70a5";
const expectedLabeledSha256 = "efc6bf7e3c33470d2f4d78245caceb956840611c5db1209af702c36ebdabedfc";

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
  generationSettings: path.join(sidecar, "generation.json"),
  publications: path.join(sidecar, "publications.json"),
  reviews: path.join(sidecar, "reviews.json"),
  overrides: path.join(sidecar, "overrides.json"),
  consistency: path.join(sidecar, "asset-consistency-batches.json"),
  commandLedger: path.join(sidecar, "command-ledger.json"),
  subagentPlan: path.join(sidecar, "generation-requests", `${jobId}.subagent-imagegen.json`),
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
  await page.getByRole("button", { name: "生成队列", exact: true }).click();
  await page.getByRole("heading", { name: "可恢复生成队列" }).waitFor();
  const row = page.locator(".job-row").filter({ hasText: jobId });
  if (await row.count() !== 1) throw new Error(`正式 P01 job 行数不是 1：${await row.count()}`);
  await row.locator(".subagent-checkpoint").waitFor();

  const apiState = await page.evaluate(async ({ projectRoot, jobId }) => {
    const [jobs, settings] = await Promise.all([
      window.canvasApi.listGenerationJobs(projectRoot),
      window.canvasApi.getGenerationSettings(projectRoot),
    ]);
    const job = jobs.find((entry) => entry.id === jobId);
    const provider = settings.providers.find((entry) => entry.id === "codex-subagent-gpt-image-2");
    return {
      jobCount: jobs.length,
      settingsRevision: settings.revision,
      job: job ? {
        id: job.id,
        itemId: job.itemId,
        status: job.status,
        providerId: job.providerId,
        model: job.model,
        parameters: job.parameters,
        referencePaths: job.referencePaths,
        resultPath: job.resultPath,
        resultSha256: job.resultSha256,
        companionPath: job.companionPath,
        publicationIntentId: job.publicationIntentId,
        publicationReceiptId: job.publicationReceiptId,
        browserCheckpoint: job.browserCheckpoint,
        subagentCheckpoint: job.subagentCheckpoint,
      } : undefined,
      provider: provider ? {
        id: provider.id,
        name: provider.name,
        adapter: provider.adapter,
        kinds: provider.kinds,
        model: provider.model,
        capabilities: provider.capabilities,
        subagentInstructions: provider.subagentInstructions,
      } : undefined,
    };
  }, { projectRoot, jobId });
  if (!apiState.job || apiState.jobCount !== 6 || apiState.job.status !== "succeeded" || apiState.job.providerId !== "codex-subagent-gpt-image-2") throw new Error(`P01 API 状态不正确：${JSON.stringify(apiState)}`);
  if (apiState.settingsRevision !== 4 || apiState.provider?.adapter !== "codex-subagent-imagegen" || apiState.provider.capabilities?.maxConcurrency !== 1) throw new Error(`一图一子代理供应商没有冻结为并发 1：${JSON.stringify(apiState.provider)}`);
  if (!apiState.provider.subagentInstructions?.includes("每张图只能由一个唯一 canonical 子代理") || !apiState.provider.subagentInstructions.includes("EP32 前实体绝不露出")) throw new Error("供应商没有完整暴露一图一代理和黄金面具一致性铁律。");
  if (apiState.job.model !== "GPT Image 2" || apiState.job.parameters?.aspectRatio !== "9:16" || apiState.job.parameters?.resolution !== "Medium" || apiState.job.parameters?.imageCount !== 1 || apiState.job.referencePaths.length !== 0) throw new Error(`P01 冻结生成合同漂移：${JSON.stringify(apiState.job)}`);
  if (apiState.job.resultSha256 !== expectedRawSha256 || !apiState.job.resultPath || !apiState.job.companionPath || !apiState.job.publicationReceiptId) throw new Error(`P01 结果或 Publication 回执不完整：${JSON.stringify(apiState.job)}`);
  if (apiState.job.browserCheckpoint?.revision !== 3 || apiState.job.browserCheckpoint.stage !== "plan_ready") throw new Error("旧网页 R3 没有被保留为历史证据。");
  if (apiState.job.subagentCheckpoint?.revision !== 4 || apiState.job.subagentCheckpoint.stage !== "verified" || apiState.job.subagentCheckpoint.lease?.agentTaskName !== "/root/generate_p01_23ac427f" || !apiState.job.subagentCheckpoint.oneImagePerAgent) throw new Error(`唯一子代理租约或 R4 机械验证漂移：${JSON.stringify(apiState.job.subagentCheckpoint)}`);
  if (apiState.job.subagentCheckpoint.output?.sourceSha256 !== expectedRawSha256 || apiState.job.subagentCheckpoint.output?.isolatedSha256 !== expectedRawSha256) throw new Error("候选图、隔离图与正式 raw 的内容身份没有保持一致。");
  if (await fileSha256(apiState.job.resultPath) !== expectedRawSha256 || await fileSha256(apiState.job.companionPath) !== expectedLabeledSha256) throw new Error("UI API 返回的 raw/labeled 文件哈希与内容绑定 Review 不一致。");

  const rendered = await row.evaluate((element) => ({
    status: element.querySelector(".job-state")?.textContent?.replace(/\s+/gu, " ").trim(),
    checkpoint: element.querySelector(".subagent-checkpoint")?.textContent?.replace(/\s+/gu, " ").trim(),
    lease: element.querySelector(".subagent-lease")?.textContent?.replace(/\s+/gu, " ").trim(),
    output: element.querySelector(".subagent-output")?.textContent?.replace(/\s+/gu, " ").trim(),
    browserHistory: element.querySelector(".browser-checkpoint")?.textContent?.replace(/\s+/gu, " ").trim(),
    rawButton: [...element.querySelectorAll("button")].some((button) => button.textContent?.trim() === "raw"),
    labeledButton: [...element.querySelectorAll("button")].some((button) => button.textContent?.trim() === "labeled"),
    pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    pageOverflowY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
  if (rendered.status !== "机械验收通过" || !rendered.checkpoint?.includes("一图一代理 verified · R4 · /root/generate_p01_23ac427f") || !rendered.lease?.includes("唯一租约 subagent-lease-6ca") || !rendered.output?.includes("907e96df267d3520") || !rendered.browserHistory?.includes("网页历史 plan_ready · R3") || !rendered.rawButton || !rendered.labeledButton || rendered.pageOverflowX || rendered.pageOverflowY || pageErrors.length) throw new Error(`P01 一图一代理 UI 文本、文件入口或布局异常：${JSON.stringify({ rendered, pageErrors })}`);

  await page.getByRole("button", { name: "供应商", exact: true }).click();
  const providerEditors = page.locator(".provider-editor");
  const providerIndex = await providerEditors.evaluateAll((elements) => elements.findIndex((element) => element.querySelector(".provider-head>input")?.value === "Codex 一图一子代理 · GPT Image 2"));
  if (providerIndex < 0) throw new Error("找不到一图一代理供应商编辑器。");
  const providerEditor = providerEditors.nth(providerIndex);
  await providerEditor.scrollIntoViewIfNeeded();
  const providerRendered = await providerEditor.evaluate((element) => ({
    hasAdapterOption: [...element.querySelectorAll("option")].some((option) => option.value === "codex-subagent-imagegen" && option.textContent?.includes("Codex 一图一子代理")),
    selectedAdapter: element.querySelector("select")?.value,
    instructions: element.querySelector(".subagent-notes textarea")?.value,
    fixedConcurrency: element.querySelector('input[disabled][type="number"]')?.value,
  }));
  if (!providerRendered.hasAdapterOption || providerRendered.selectedAdapter !== "codex-subagent-imagegen" || providerRendered.fixedConcurrency !== "1" || !providerRendered.instructions?.includes("91b074b882113d6c0bdde156e6d38adf7883e8388ba4064168d6c32ade8e2253")) throw new Error(`供应商 UI 没有完整呈现冻结执行合同：${JSON.stringify(providerRendered)}`);

  await page.screenshot({ path: screenshotPath, type: "png", animations: "disabled" });
  const afterHashes = Object.fromEntries(await Promise.all(Object.entries(guardedFiles).map(async ([key, filePath]) => [key, await fileSha256(filePath)])));
  if (JSON.stringify(beforeHashes) !== JSON.stringify(afterHashes)) throw new Error(`只读 UI 烟测意外改写生产侧车：${JSON.stringify({ beforeHashes, afterHashes })}`);
  const screenshotSha256 = await fileSha256(screenshotPath);
  const report = {
    schemaVersion: 1,
    kind: "subagent-imagegen-p01-ui-smoke",
    createdAt: new Date().toISOString(),
    transport: "electron-current-production-build",
    projectRoot,
    jobId,
    registryPath,
    screenshot: { path: screenshotPath, sha256: screenshotSha256 },
    guardedFiles: { beforeHashes, afterHashes, unchanged: true },
    apiState,
    rendered,
    providerRendered: { ...providerRendered, instructionsSha256: createHash("sha256").update(providerRendered.instructions ?? "").digest("hex"), instructions: "[frozen; see generation settings]" },
    pageErrors,
  };
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ evidencePath, screenshotPath, screenshotSha256, rendered, providerRendered: report.providerRendered, guardedFiles: report.guardedFiles, pageErrors }, null, 2)}\n`);
} finally {
  await app.close();
}
