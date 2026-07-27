import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import sharp from "sharp";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(process.argv[2] || "/tmp/ai-canvas-novel-batch-ui3-20260713");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-novel-batch-ui3-registry-20260713.json");
const evidenceDirectory = path.join(workspace, "docs", "evidence");
await mkdir(evidenceDirectory, { recursive: true });

const app = await electron.launch({
  args: ["."],
  cwd: workspace,
  env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath, AI_CANVAS_WINDOW_WIDTH: "1560", AI_CANVAS_WINDOW_HEIGHT: "980" },
});

try {
  const page = await app.firstWindow();
  const capture = async (outputPath) => {
    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const raw = await page.screenshot({ type: "png" });
    await sharp(raw).resize(size.width, size.height, { fit: "fill" }).png().toFile(outputPath);
  };
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "生成队列" }).click();
  await page.getByRole("heading", { name: "可恢复生成队列" }).waitFor();
  await page.getByRole("button", { name: "供应商" }).click();
  const panel = page.locator(".provider-settings");
  await panel.getByRole("heading", { name: "供应商与桥接" }).waitFor();
  const editor = panel.locator(".provider-editor").first();
  await editor.getByText("可复现工作流").waitFor();
  await editor.getByText(/SHA-256 [a-f0-9]{16}/).waitFor();
  await editor.scrollIntoViewIfNeeded();

  const versionInput = editor.locator(".workflow-editor label").filter({ hasText: "版本" }).locator("input");
  await versionInput.fill("2026.07.13-ui");
  await panel.getByRole("button", { name: "保存配置" }).click();
  await page.getByText("生成供应商配置与工作流快照已保存").waitFor();
  const persisted = await page.evaluate(async ({ projectRoot }) => {
    const settings = await window.canvasApi.getGenerationSettings(projectRoot);
    const provider = settings.providers.find((entry) => entry.id === "folder-image");
    return { version: provider?.workflow?.version, workflowHash: provider?.workflowHash };
  }, { projectRoot });
  if (persisted.version !== "2026.07.13-ui" || !/^[a-f0-9]{64}$/.test(persisted.workflowHash ?? "")) throw new Error(`工作流配置没有通过 UI 持久化：${JSON.stringify(persisted)}`);
  await editor.getByText(new RegExp(`SHA-256 ${persisted.workflowHash.slice(0, 16)}`)).waitFor();

  const fit = await page.evaluate(() => {
    const panelRect = document.querySelector(".provider-settings")?.getBoundingClientRect();
    const workflowRect = document.querySelector(".provider-settings .workflow-editor")?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      panel: panelRect ? { left: panelRect.left, top: panelRect.top, right: panelRect.right, bottom: panelRect.bottom } : null,
      workflow: workflowRect ? { left: workflowRect.left, top: workflowRect.top, right: workflowRect.right, bottom: workflowRect.bottom } : null,
    };
  });
  if (!fit.panel || fit.panel.left < -1 || fit.panel.top < -1 || fit.panel.right > fit.innerWidth + 1 || fit.panel.bottom > fit.innerHeight + 1) throw new Error(`供应商面板超出窗口：${JSON.stringify(fit)}`);
  const screenshot = path.join(evidenceDirectory, "generation-workflow-snapshot.png");
  await capture(screenshot);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 760));
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(500);
  await editor.scrollIntoViewIfNeeded();
  const compactFit = await page.evaluate(() => {
    const panelRect = document.querySelector(".provider-settings")?.getBoundingClientRect();
    return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth, panel: panelRect ? { left: panelRect.left, top: panelRect.top, right: panelRect.right, bottom: panelRect.bottom } : null };
  });
  if (!compactFit.panel || compactFit.panel.left < -1 || compactFit.panel.top < -1 || compactFit.panel.right > compactFit.innerWidth + 1 || compactFit.panel.bottom > compactFit.innerHeight + 1) throw new Error(`1280x760 供应商面板超出窗口：${JSON.stringify(compactFit)}`);
  const compactScreenshot = path.join(evidenceDirectory, "generation-workflow-snapshot-1280.png");
  await capture(compactScreenshot);

  process.stdout.write(`${JSON.stringify({ projectRoot, registryPath, screenshot, compactScreenshot, persisted, fit, compactFit }, null, 2)}\n`);
} finally {
  await app.close();
}
