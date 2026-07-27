import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import sharp from "sharp";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(process.argv[2] || "/tmp/ai-canvas-editor-ui-20260713");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-editor-ui-registry-20260713.json");
const packagedExecutable = process.env.AI_CANVAS_ELECTRON_EXECUTABLE?.trim();
const evidenceDirectory = path.join(workspace, "docs", "evidence");
await mkdir(evidenceDirectory, { recursive: true });

const app = await electron.launch({
  ...(packagedExecutable ? { executablePath: path.resolve(packagedExecutable), args: [] } : { args: ["."] }),
  cwd: workspace,
  env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath, AI_CANVAS_WINDOW_WIDTH: "1560", AI_CANVAS_WINDOW_HEIGHT: "980" },
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "生产设计" }).click();
  await page.getByRole("heading", { name: "生产设计与连续性" }).waitFor();
  await page.waitForTimeout(800);
  const stageCount = await page.locator(".stage-strip button").count();
  if (stageCount !== 15) {
    const diagnostic = await page.evaluate(async ({ projectRoot }) => {
      try {
        const timed = async (name, promise) => Promise.race([promise.then((value) => ({ name, status: "ok", count: Array.isArray(value) ? value.length : undefined })), new Promise((resolve) => setTimeout(() => resolve({ name, status: "timeout" }), 2_000))]);
        const [workflow, checks] = await Promise.all([window.canvasApi.getProductionWorkflow(projectRoot), Promise.all([
          timed("bibles", window.canvasApi.listCreativeBibles(projectRoot)), timed("relations", window.canvasApi.listAssetRelations(projectRoot)), timed("voices", window.canvasApi.listVoiceIdentities(projectRoot)),
        ])]);
        return { workflowRevision: workflow.revision, stages: workflow.stages.length, auditStages: workflow.evidenceAudit?.stages.length, checks, body: document.body.innerText.slice(0, 2_000) };
      }
      catch (error) { return { error: error instanceof Error ? error.message : String(error), body: document.body.innerText.slice(0, 2_000) }; }
    }, { projectRoot });
    throw new Error(`生产设计没有显示完整 15 阶段，实际 ${stageCount}：${JSON.stringify(diagnostic)}`);
  }
  await page.getByText("本阶段尚不可完成").waitFor();
  const sourceIssues = await page.locator(".audit-result li").allTextContents();
  if (!sourceIssues.some((issue) => issue.includes("尚未通过小说导入"))) throw new Error(`原文证据缺口没有显示：${sourceIssues.join("；")}`);

  await page.locator(".stage-strip button").nth(9).click();
  await page.getByText("本阶段证据就绪").waitFor();
  const storyboardAudit = await page.locator(".audit-result").innerText();
  if (!storyboardAudit.includes("生产单元") || !storyboardAudit.includes("确认镜头")) throw new Error(`正式分镜审计指标不完整：${storyboardAudit}`);

  await page.locator(".stage-strip button").first().click();
  await page.getByText("本阶段尚不可完成").waitFor();
  const screenshot = path.join(evidenceDirectory, packagedExecutable ? "production-evidence-audit-packaged.png" : "production-evidence-audit.png");
  const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const raw = await page.screenshot({ type: "png" });
  await sharp(raw).resize(size.width, size.height, { fit: "fill" }).png().toFile(screenshot);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 760));
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(350);
  const fit = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    workflow: (() => { const box = document.querySelector(".workflow-body")?.getBoundingClientRect(); return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : null; })(),
  }));
  if (fit.overflowX || !fit.workflow || fit.workflow.left < -1 || fit.workflow.right > fit.width + 1) throw new Error(`1280x760 生产证据审计越界：${JSON.stringify(fit)}`);
  process.stdout.write(`${JSON.stringify({ projectRoot, registryPath, executablePath: packagedExecutable ? path.resolve(packagedExecutable) : undefined, stageCount, sourceIssues, storyboardAudit, screenshot, fit }, null, 2)}\n`);
} finally {
  await app.close();
}
