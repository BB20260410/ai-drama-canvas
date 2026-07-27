import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(process.argv[2] || "/Users/hxx/Documents/无限画布/productions/gushujuan-s3-f1a688020bfb7af6");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-p0-panel-review-ui-registry-20260717.json");
const evidencePath = path.resolve(process.argv[4] || path.join(workspace, "docs/evidence/p0-panel-review-ui-smoke-20260717.json"));
const screenshotPath = path.resolve(process.argv[5] || path.join(workspace, "docs/evidence/p0-panel-review-ui-smoke-20260717.png"));
await Promise.all([
  mkdir(path.dirname(evidencePath), { recursive: true }),
  mkdir(path.dirname(screenshotPath), { recursive: true }),
  mkdir(path.dirname(registryPath), { recursive: true }),
]);
const projectConfig = JSON.parse(await readFile(path.join(projectRoot, ".aicanvas", "project.json"), "utf8"));
await writeFile(registryPath, `${JSON.stringify([{ id: projectConfig.id, name: projectConfig.name, primaryRoot: projectRoot, updatedAt: projectConfig.updatedAt }], null, 2)}\n`, "utf8");

const jobsPath = path.join(projectRoot, ".aicanvas", "generation-jobs.json");
const publicationsPath = path.join(projectRoot, ".aicanvas", "publications.json");
const jobsBeforeSha256 = createHash("sha256").update(await readFile(jobsPath)).digest("hex");
const publicationsBeforeSha256 = createHash("sha256").update(await readFile(publicationsPath)).digest("hex");
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

  const apiState = await page.evaluate(async ({ projectRoot }) => {
    const [index, queue] = await Promise.all([
      window.canvasApi.getIndex(projectRoot),
      window.canvasApi.getReviewQueue(projectRoot, { includeResolved: true }),
    ]);
    const ep001 = index.items.find((item) => item.id === "season-三-ep01-unit001");
    const ep008 = index.items.find((item) => item.id === "season-三-ep01-unit008");
    const review001 = queue.find((entry) => entry.item.id === ep001?.id && entry.reviewType === "image");
    return {
      unitCount: index.items.filter((item) => item.type === "unit").length,
      ep001: ep001 && {
        status: ep001.status,
        contractId: ep001.fusionStoryboard?.contractId,
        panelCount: ep001.fusionStoryboard?.panelCount,
        completedPanelCount: ep001.fusionStoryboard?.completedPanelCount,
        visuallyApproved: ep001.fusionStoryboard?.visuallyApproved,
      },
      ep008: ep008 && {
        status: ep008.status,
        contractId: ep008.fusionStoryboard?.contractId,
        panelCount: ep008.fusionStoryboard?.panelCount,
        completedPanelCount: ep008.fusionStoryboard?.completedPanelCount,
        states: ep008.fusionStoryboard?.panels.map((panel) => panel.state),
      },
      review001: review001 && {
        requirementId: review001.reviewRequirement?.id,
        complete: review001.reviewRequirement?.complete,
        panelCount: review001.reviewRequirement?.panelCount,
        artifactCount: review001.reviewRequirement?.artifactIds.length,
        panelArtifactPairs: review001.reviewRequirement?.panels.map((panel) => ({
          panelId: panel.panelId,
          raw: panel.raw?.artifactId,
          labeled: panel.labeled?.artifactId,
        })),
      },
    };
  }, { projectRoot });
  if (apiState.unitCount !== 1_288) throw new Error(`正式画布单元数不是 1288：${apiState.unitCount}`);
  if (JSON.stringify(apiState.ep001) !== JSON.stringify({
    status: "待视频",
    contractId: "grid-6c02035d032128e0f62a",
    panelCount: 4,
    completedPanelCount: 4,
    visuallyApproved: true,
  })) throw new Error(`EP01_001 P0 状态异常：${JSON.stringify(apiState.ep001)}`);
  if (apiState.ep008?.status !== "待尾帧"
    || apiState.ep008.contractId !== "grid-76e6545a6efec0e4091b"
    || apiState.ep008.panelCount !== 6
    || apiState.ep008.completedPanelCount !== 4
    || apiState.ep008.states?.slice(0, 4).some((state) => state !== "awaiting_review")
    || apiState.ep008.states?.[4] !== "generating"
    || apiState.ep008.states?.[5] !== "missing") {
    throw new Error(`EP01_008 P0 进度异常：${JSON.stringify(apiState.ep008)}`);
  }
  if (!apiState.review001?.complete || apiState.review001.panelCount !== 4 || apiState.review001.artifactCount !== 8
    || apiState.review001.panelArtifactPairs?.some((panel) => !panel.raw || !panel.labeled)) {
    throw new Error(`EP01_001 Review requirement 不完整：${JSON.stringify(apiState.review001)}`);
  }

  await page.getByRole("button", { name: "导演验收", exact: true }).click();
  await page.getByRole("heading", { name: "版本对照与视觉结论" }).waitFor();
  await page.getByRole("button", { name: "刷新", exact: true }).waitFor();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((node) => node.textContent?.includes("刷新"));
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await page.getByLabel("显示已处理").check();
  const ep001QueueButton = page.locator(".queue-list button").filter({ hasText: "15s 001" }).first();
  try {
    await ep001QueueButton.waitFor({ timeout: 45_000 });
  } catch {
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await ep001QueueButton.waitFor({ timeout: 75_000 });
  }
  await ep001QueueButton.click();
  const panelButtons = page.locator(".frame-tabs button");
  if (await panelButtons.count() !== 4) throw new Error(`ReviewStudio 没有显示 4 个宫格标签：${await panelButtons.count()}`);
  const passButton = page.locator(".decision-actions .pass");
  if (!(await passButton.isDisabled())) throw new Error("尚未查看全部宫格和检查项时，视觉通过按钮不应启用。");
  for (let index = 0; index < 4; index += 1) await panelButtons.nth(index).click();
  const viewedCount = await page.locator(".frame-tabs button.viewed").count();
  if (viewedCount !== 4) throw new Error(`逐格查看门禁未记录全部 4 格：${viewedCount}`);
  const criteria = page.locator(".criteria-list article");
  for (let index = 0; index < await criteria.count(); index += 1) await criteria.nth(index).locator(".criterion-actions button").first().click();
  if (await passButton.isDisabled()) throw new Error("全部 4 格和全部检查项明确通过后，视觉通过按钮仍被错误禁用。");
  const reviewUi = await page.evaluate(() => ({
    panelLabels: [...document.querySelectorAll(".frame-tabs button")].map((node) => node.textContent?.replace(/\s+/gu, "").trim()),
    viewedPanelCount: document.querySelectorAll(".frame-tabs button.viewed").length,
    requirementHint: document.querySelector(".frame-tabs em")?.textContent?.trim(),
    passEnabled: !(document.querySelector(".decision-actions .pass")?.hasAttribute("disabled") ?? true),
    horizontalPageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  await page.screenshot({ path: screenshotPath, type: "png", animations: "disabled" });

  await page.getByRole("button", { name: "生产设计", exact: true }).click();
  await page.getByRole("heading", { name: "生产设计与连续性" }).waitFor();
  await page.getByRole("button", { name: "正式分镜表", exact: true }).click();
  await page.getByTestId("migrate-fusion-storyboard-evidence").waitFor();
  const migrationButtonVisible = await page.getByTestId("migrate-fusion-storyboard-evidence").isVisible();

  const jobsAfterSha256 = createHash("sha256").update(await readFile(jobsPath)).digest("hex");
  const publicationsAfterSha256 = createHash("sha256").update(await readFile(publicationsPath)).digest("hex");
  if (jobsAfterSha256 !== jobsBeforeSha256 || publicationsAfterSha256 !== publicationsBeforeSha256) {
    throw new Error("P0 UI smoke 意外修改了 GenerationJob 或 Publication。");
  }
  if (reviewUi.horizontalPageOverflow || pageErrors.length || !migrationButtonVisible) {
    throw new Error(`P0 UI 运行异常：${JSON.stringify({ reviewUi, migrationButtonVisible, pageErrors })}`);
  }
  const screenshotSha256 = createHash("sha256").update(await readFile(screenshotPath)).digest("hex");
  const report = {
    schemaVersion: 1,
    kind: "p0-fusion-panel-review-ui-smoke",
    createdAt: new Date().toISOString(),
    projectRoot,
    registryPath,
    screenshotPath,
    screenshotSha256,
    apiState,
    reviewUi,
    migrationButtonVisible,
    sideEffects: {
      generationJobsUnchanged: jobsAfterSha256 === jobsBeforeSha256,
      publicationsUnchanged: publicationsAfterSha256 === publicationsBeforeSha256,
      generationJobsSha256: jobsAfterSha256,
      publicationsSha256: publicationsAfterSha256,
    },
    pageErrors,
  };
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ evidencePath, ...report }, null, 2)}\n`);
} finally {
  await app.close();
}
