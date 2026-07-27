import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(process.argv[2] || "/Users/hxx/Documents/无限画布/productions/gushujuan-s3-f1a688020bfb7af6");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-p1-generation-recovery-ui-registry-20260717.json");
const evidencePath = path.resolve(process.argv[4] || path.join(workspace, "docs/evidence/p1-generation-recovery-ui-smoke-20260717.json"));
const screenshotPath = path.resolve(process.argv[5] || path.join(workspace, "docs/evidence/p1-generation-recovery-ui-smoke-20260717.png"));
const jobId = process.argv[6] || "gen-2026-07-16T12-10-57-215Z-892023c0";
const sidecar = path.join(projectRoot, ".aicanvas");

async function exists(filePath) {
  return access(filePath).then(() => true).catch(() => false);
}

async function fileSha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function hashFiles(files) {
  return Object.fromEntries(await Promise.all(
    Object.entries(files).map(async ([name, filePath]) => [name, await fileSha256(filePath)]),
  ));
}

if (await exists(evidencePath)) throw new Error(`证据文件已存在，拒绝覆盖：${evidencePath}`);
if (await exists(screenshotPath)) throw new Error(`截图文件已存在，拒绝覆盖：${screenshotPath}`);
await Promise.all([
  mkdir(path.dirname(registryPath), { recursive: true }),
  mkdir(path.dirname(evidencePath), { recursive: true }),
  mkdir(path.dirname(screenshotPath), { recursive: true }),
]);

const projectConfig = JSON.parse(await readFile(path.join(sidecar, "project.json"), "utf8"));
await writeFile(registryPath, `${JSON.stringify([{
  id: projectConfig.id,
  name: projectConfig.name,
  primaryRoot: projectRoot,
  updatedAt: projectConfig.updatedAt,
}], null, 2)}\n`, "utf8");

const guardedFiles = {
  generationJobs: path.join(sidecar, "generation-jobs.json"),
  generationSettings: path.join(sidecar, "generation.json"),
  publications: path.join(sidecar, "publications.json"),
  events: path.join(sidecar, "events.jsonl"),
  index: path.join(sidecar, "index.json"),
  overrides: path.join(sidecar, "overrides.json"),
  commandLedger: path.join(sidecar, "command-ledger.json"),
};
const beforeHashes = await hashFiles(guardedFiles);
const publicationStore = JSON.parse(await readFile(guardedFiles.publications, "utf8"));
const sourceJobs = JSON.parse(await readFile(guardedFiles.generationJobs, "utf8"));
const sourceJob = sourceJobs.find((job) => job.id === jobId);
if (!sourceJob) throw new Error(`找不到 P1 正式 Job：${jobId}`);
const bundleIntents = publicationStore.intents
  .filter((intent) => intent.bundleId === sourceJob.publicationBundleId)
  .map((intent) => ({
    id: intent.id,
    status: intent.status,
    bundleId: intent.bundleId,
    bundleMember: intent.bundleMember,
    receiptId: intent.receiptId,
  }))
  .sort((left, right) => String(left.bundleMember).localeCompare(String(right.bundleMember)));
if (bundleIntents.length !== 2
  || bundleIntents.some((intent) => intent.status !== "reserved" || intent.receiptId)
  || bundleIntents.map((intent) => intent.bundleMember).join(",") !== "companion,primary") {
  throw new Error(`P1 Publication bundle 不是两个无回执 reserved 成员：${JSON.stringify(bundleIntents)}`);
}
for (const outputPath of [sourceJob.expectedOutputPath, sourceJob.expectedCompanionPath]) {
  if (!outputPath || await exists(outputPath)) throw new Error(`P1 正式输出不应存在：${outputPath}`);
}
const candidateRoot = path.join(sidecar, "generation-downloads", jobId);
const candidateFiles = await exists(candidateRoot) ? await readdir(candidateRoot) : [];
if (candidateFiles.length) throw new Error(`P1 未知态不应存在隔离候选：${candidateFiles.join(", ")}`);

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
  if (await row.count() !== 1) throw new Error(`P1 正式 Job 行数不是 1：${await row.count()}`);
  await row.locator(".generation-unknown").waitFor();

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
      projectConcurrency: settings.concurrency,
      job: job && {
        id: job.id,
        itemId: job.itemId,
        status: job.status,
        attempts: job.attempts,
        providerId: job.providerId,
        model: job.model,
        parameters: job.parameters,
        referenceCount: job.referencePaths.length,
        resultPath: job.resultPath,
        companionPath: job.companionPath,
        publicationIntentId: job.publicationIntentId,
        publicationBundleId: job.publicationBundleId,
        companionPublicationIntentId: job.companionPublicationIntentId,
        publicationReceiptId: job.publicationReceiptId,
        companionPublicationReceiptId: job.companionPublicationReceiptId,
        checkpoint: job.subagentCheckpoint,
      },
      provider: provider && {
        id: provider.id,
        adapter: provider.adapter,
        enabled: provider.enabled,
        model: provider.model,
        maxConcurrency: provider.capabilities?.maxConcurrency,
      },
    };
  }, { projectRoot, jobId });

  const checkpoint = apiState.job?.checkpoint;
  if (apiState.jobCount !== 30
    || apiState.job?.status !== "generation_unknown"
    || apiState.job.attempts !== 1
    || apiState.job.providerId !== "codex-subagent-gpt-image-2"
    || apiState.job.model !== "GPT Image 2"
    || apiState.job.parameters?.aspectRatio !== "9:16"
    || apiState.job.parameters?.resolution !== "Medium"
    || apiState.job.parameters?.imageCount !== 1
    || apiState.job.referenceCount !== 4
    || apiState.job.resultPath
    || apiState.job.companionPath
    || apiState.job.publicationReceiptId
    || apiState.job.companionPublicationReceiptId
    || checkpoint?.schemaVersion !== 2
    || checkpoint.revision !== 3
    || checkpoint.stage !== "generation_unknown"
    || checkpoint.unknown?.code !== "legacy_leased_without_call_receipt"
    || checkpoint.callIntent
    || checkpoint.output
    || checkpoint.lease?.leaseId !== "subagent-lease-109aae14dd1db8b32dba07be"
    || checkpoint.lease?.owner
    || checkpoint.lease?.leaseUntil
    || checkpoint.lease?.heartbeatAt
    || checkpoint.lease?.fence) {
    throw new Error(`P1 正式未知态 API 合同异常：${JSON.stringify(apiState.job)}`);
  }
  if (apiState.settingsRevision !== 4
    || apiState.projectConcurrency !== 1
    || apiState.provider?.adapter !== "codex-subagent-imagegen"
    || apiState.provider.enabled !== true
    || apiState.provider.maxConcurrency !== 1) {
    throw new Error(`P1 项目/供应商串行设置异常：${JSON.stringify(apiState)}`);
  }

  const rendered = await row.evaluate((element) => ({
    status: element.querySelector(".job-state")?.textContent?.replace(/\s+/gu, " ").trim(),
    checkpoint: element.querySelector(".subagent-checkpoint")?.textContent?.replace(/\s+/gu, " ").trim(),
    leaseLines: [...element.querySelectorAll(".subagent-lease")].map((node) => node.textContent?.replace(/\s+/gu, " ").trim()),
    unknown: element.querySelector(".generation-unknown")?.textContent?.replace(/\s+/gu, " ").trim(),
    actions: [...element.querySelectorAll(".job-actions button")].map((button) => button.textContent?.trim()),
  }));
  if (rendered.status !== "调用结果不明"
    || !rendered.checkpoint?.includes("一图一代理 generation_unknown · R3 · /root/generate_ep01_008_p05_892023c0")
    || rendered.leaseLines.length !== 2
    || !rendered.leaseLines[0]?.includes("owner legacy-unknown")
    || !rendered.leaseLines[0]?.includes("fence —")
    || !rendered.leaseLines[1]?.includes("心跳 无")
    || !rendered.leaseLines[1]?.includes("到期 无 TTL")
    || !rendered.leaseLines[1]?.includes("旧协议 / 无法安全接管")
    || !rendered.unknown?.includes("legacy_leased_without_call_receipt")
    || !rendered.unknown.includes("禁止取消、接管、重生")
    || JSON.stringify(rendered.actions) !== JSON.stringify(["请求单"])) {
    throw new Error(`P1 未知态 UI 呈现或动作封锁异常：${JSON.stringify(rendered)}`);
  }

  const refreshButton = page.getByRole("button", { name: "只读刷新", exact: true });
  await refreshButton.click();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => entry.textContent?.replace(/\s+/gu, " ").trim() === "只读刷新");
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  const headerActions = await page.locator(".module-actions button").allTextContents();
  if (!headerActions.some((text) => text.includes("只读刷新"))
    || headerActions.some((text) => text.includes("提交") || text.includes("轮询"))) {
    throw new Error(`P1 队列头部仍含全局提交/轮询动作：${JSON.stringify(headerActions)}`);
  }

  await page.getByRole("button", { name: "供应商", exact: true }).click();
  const providerEditors = page.locator(".provider-editor");
  const providerIndex = await providerEditors.evaluateAll((elements) =>
    elements.findIndex((element) =>
      element.querySelector(".provider-head>input")?.value === "Codex 一图一子代理 · GPT Image 2"));
  if (providerIndex < 0) throw new Error("P1 UI 找不到 Codex 一图一子代理供应商。");
  const providerEditor = providerEditors.nth(providerIndex);
  await providerEditor.scrollIntoViewIfNeeded();
  const settingsUi = await page.evaluate((providerIndex) => {
    const editor = document.querySelectorAll(".provider-editor")[providerIndex];
    const defaults = document.querySelector(".defaults");
    return {
      selectedAdapter: editor?.querySelector("select")?.value,
      providerConcurrency: editor?.querySelector('input[disabled][type="number"]')?.value,
      providerBoundary: editor?.querySelector(".subagent-boundary")?.textContent?.replace(/\s+/gu, " ").trim(),
      projectConcurrency: defaults?.querySelector('input[disabled][type="number"]')?.value,
      projectBoundary: defaults?.querySelector(".subagent-boundary")?.textContent?.replace(/\s+/gu, " ").trim(),
      horizontalPageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  }, providerIndex);
  if (settingsUi.selectedAdapter !== "codex-subagent-imagegen"
    || settingsUi.providerConcurrency !== "1"
    || settingsUi.projectConcurrency !== "1"
    || !settingsUi.providerBoundary?.includes("严格串行")
    || !settingsUi.projectBoundary?.includes("项目并发 1")
    || settingsUi.horizontalPageOverflow) {
    throw new Error(`P1 串行设置 UI 异常：${JSON.stringify(settingsUi)}`);
  }

  await page.screenshot({ path: screenshotPath, type: "png", animations: "disabled" });
  const screenshotSha256 = await fileSha256(screenshotPath);
  const afterHashes = await hashFiles(guardedFiles);
  if (JSON.stringify(beforeHashes) !== JSON.stringify(afterHashes)) {
    throw new Error(`P1 只读刷新意外改写正式状态：${JSON.stringify({ beforeHashes, afterHashes })}`);
  }
  if (pageErrors.length) throw new Error(`P1 UI 出现 pageerror：${pageErrors.join("；")}`);

  const evidence = {
    schemaVersion: 1,
    kind: "p1-generation-recovery-ui-smoke",
    createdAt: new Date().toISOString(),
    transport: "electron-current-production-build",
    projectRoot,
    jobId,
    registryPath,
    screenshot: { path: screenshotPath, sha256: screenshotSha256 },
    guardedFiles: { beforeHashes, afterHashes, unchanged: true },
    apiState,
    bundleIntents,
    candidateFiles,
    rendered,
    headerActions,
    settingsUi,
    pageErrors,
    assertions: {
      unknownStateVisible: true,
      legacyLeaseVisibleAndNotTakeoverEligible: true,
      retryCancelTakeoverHidden: true,
      onlyReadRefreshAtHeader: true,
      readRefreshDidNotWrite: true,
      rawLabeledBundleReservedWithoutReceipts: true,
      noCandidateOrFormalOutput: true,
      projectAndProviderConcurrencyOne: true,
    },
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    evidencePath,
    screenshotPath,
    screenshotSha256,
    guardedFiles: evidence.guardedFiles,
    rendered,
    settingsUi,
    pageErrors,
  }, null, 2)}\n`);
} finally {
  await app.close();
}
