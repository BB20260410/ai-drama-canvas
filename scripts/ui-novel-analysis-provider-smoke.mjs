import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import sharp from "sharp";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(process.argv[2] || "/tmp/ai-canvas-novel-provider-final");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-novel-provider-registry.json");
const evidenceDirectory = path.join(workspace, "docs", "evidence");
await mkdir(evidenceDirectory, { recursive: true });

const app = await electron.launch({
  args: ["."],
  cwd: workspace,
  env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath, AI_CANVAS_WINDOW_WIDTH: "1560", AI_CANVAS_WINDOW_HEIGHT: "980" },
});

try {
  const page = await app.firstWindow();
  const captureCss = async (outputPath) => {
    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const raw = await page.screenshot({ type: "png" });
    await sharp(raw).resize(size.width, size.height, { fit: "fill" }).png().toFile(outputPath);
  };
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "自动改编" }).click();
  await page.getByRole("heading", { name: "自动改编工作台" }).waitFor();

  const reviewSummary = page.locator(".review-bar");
  await reviewSummary.getByText("2 待处理").waitFor();
  await reviewSummary.getByText(/长篇 0\/1 · 待人工确认/).waitFor();
  const executeButton = page.getByRole("button", { name: "执行模型" });
  if (!(await executeButton.isDisabled())) throw new Error("已执行的任务不应允许再次调用模型");

  await page.getByRole("button", { name: "模型连接" }).click();
  const providerDrawer = page.locator(".provider-drawer");
  await providerDrawer.getByText("小说分析模型").waitFor();
  await providerDrawer.getByText("验收用本地模拟模型").click();
  await providerDrawer.getByRole("button", { name: "探测 /models" }).click();
  await providerDrawer.getByText(/探测成功/).waitFor();

  const fit = await page.evaluate(() => {
    const drawer = document.querySelector(".provider-drawer")?.getBoundingClientRect();
    const editor = document.querySelector(".provider-editor")?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      canScrollY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      drawer: drawer ? { left: drawer.left, top: drawer.top, right: drawer.right, bottom: drawer.bottom } : null,
      editor: editor ? { left: editor.left, top: editor.top, right: editor.right, bottom: editor.bottom } : null,
    };
  });
  if (!fit.drawer || fit.drawer.left < 0 || fit.drawer.top < 0 || fit.drawer.right > fit.innerWidth || fit.drawer.bottom > fit.innerHeight) throw new Error(`模型抽屉超出窗口：${JSON.stringify(fit)}`);
  const providerScreenshot = path.join(evidenceDirectory, "novel-analysis-provider-connection.png");
  await captureCss(providerScreenshot);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 760));
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(500);
  const compactFit = await page.evaluate(() => {
    const drawer = document.querySelector(".provider-drawer")?.getBoundingClientRect();
    return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth, canScrollY: document.documentElement.scrollHeight > document.documentElement.clientHeight, drawer: drawer ? { left: drawer.left, top: drawer.top, right: drawer.right, bottom: drawer.bottom } : null };
  });
  if (!compactFit.drawer || compactFit.drawer.left < 0 || compactFit.drawer.top < 0 || compactFit.drawer.right > compactFit.innerWidth || compactFit.drawer.bottom > compactFit.innerHeight) throw new Error(`1280×760 模型抽屉超出窗口：${JSON.stringify(compactFit)}`);
  const compactScreenshot = path.join(evidenceDirectory, "novel-analysis-provider-connection-1280.png");
  await captureCss(compactScreenshot);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1560, 980));
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(500);

  await providerDrawer.locator("header button").click();
  await page.getByRole("button", { name: "审核队列" }).click();
  const reviewDrawer = page.locator(".review-drawer");
  await reviewDrawer.getByText("模型提案").waitFor();
  await reviewDrawer.locator(".review-queue button").first().click();
  await reviewDrawer.getByText("原文区间校验通过").first().waitFor();
  const reviewScreenshot = path.join(evidenceDirectory, "novel-analysis-provider-review.png");
  await captureCss(reviewScreenshot);

  page.once("dialog", (dialog) => dialog.accept());
  await reviewDrawer.getByRole("button", { name: "接受可核验 2" }).click();
  await reviewDrawer.getByText("0 待确认").waitFor();
  await reviewSummary.getByText(/长篇 1\/1 · 已完成/).waitFor();
  const reviewCount = await page.locator(".review-queue>button").count();
  const pendingAfterBatch = await page.locator(".review-queue>button:not(.done)").count();
  await reviewDrawer.locator("header button").click();
  await reviewDrawer.waitFor({ state: "detached" });
  await page.bringToFront();
  await page.waitForTimeout(800);
  const batchCompletedScreenshot = path.join(evidenceDirectory, "novel-analysis-provider-review-batch-completed.png");
  await captureCss(batchCompletedScreenshot);

  process.stdout.write(`${JSON.stringify({ projectRoot, title: await page.title(), providerScreenshot, compactScreenshot, reviewScreenshot, batchCompletedScreenshot, executeLocked: await executeButton.isDisabled(), reviewCount, pendingAfterBatch, fit, compactFit }, null, 2)}\n`);
} finally {
  await app.close();
}
