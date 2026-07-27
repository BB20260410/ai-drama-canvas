import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(process.argv[2] || "/tmp/ai-canvas-browser-safety-ui");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-browser-safety-ui-registry.json");
const packagedExecutable = process.env.AI_CANVAS_ELECTRON_EXECUTABLE?.trim();
const evidenceDirectory = path.join(workspace, "docs", "evidence");
const tsx = path.join(workspace, "node_modules", ".bin", "tsx");
await mkdir(evidenceDirectory, { recursive: true });

const prepared = await execFileAsync(tsx, ["scripts/prepare-browser-safety-ui-fixture.ts", projectRoot, registryPath], {
  cwd: workspace,
  env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath },
  maxBuffer: 2_000_000,
});
const fixture = JSON.parse(prepared.stdout);
if (fixture.remoteSubmitted !== false || fixture.checkpoint?.stage !== "submission_unknown" || fixture.checkpoint?.revision !== 4 || fixture.checkpoint?.submissionIntent?.clientJobId !== fixture.jobId) throw new Error(`隔离网页安全夹具不符合预期：${prepared.stdout}`);

const app = await electron.launch({
  ...(packagedExecutable ? { executablePath: path.resolve(packagedExecutable), args: [] } : { args: ["."] }),
  cwd: workspace,
  env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath, AI_CANVAS_PROJECT_ROOT: projectRoot, AI_CANVAS_WINDOW_WIDTH: "1560", AI_CANVAS_WINDOW_HEIGHT: "980" },
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const capture = async (outputPath) => {
    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const raw = await page.screenshot({ type: "png" });
    await sharp(raw).resize(size.width, size.height, { fit: "fill" }).png().toFile(outputPath);
  };
  const fit = async () => page.evaluate(() => {
    const row = [...document.querySelectorAll(".job-row")].find((candidate) => candidate.textContent?.includes("隔离网页安全夹具"));
    const list = document.querySelector(".job-list");
    const rowRect = row?.getBoundingClientRect();
    const listRect = list?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      documentOverflowY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      row: rowRect ? { left: rowRect.left, top: rowRect.top, right: rowRect.right, bottom: rowRect.bottom, width: rowRect.width } : null,
      list: listRect ? { left: listRect.left, top: listRect.top, right: listRect.right, bottom: listRect.bottom, width: listRect.width } : null,
    };
  });
  const assertFit = (value, label) => {
    if (value.documentOverflowX || value.documentOverflowY) throw new Error(`${label} 页面发生非预期溢出：${JSON.stringify(value)}`);
    if (!value.row || !value.list || value.row.left < value.list.left - 1 || value.row.right > value.list.right + 1 || value.row.top < value.list.top - 1 || value.row.bottom > value.list.bottom + 1) throw new Error(`${label} 网页安全任务行被裁切：${JSON.stringify(value)}`);
  };

  const launchedSize = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await page.getByRole("button", { name: "生成队列" }).click();
  await page.getByRole("heading", { name: "可恢复生成队列" }).waitFor();
  const row = page.locator(".job-row").filter({ hasText: "隔离网页安全夹具（未提交）" });
  await row.waitFor();
  await row.locator(".browser-checkpoint").getByText(/网页 submission_unknown · R4 · 已核 \d+ 个槽位/).waitFor();
  await row.locator(".submit-intent").getByText(/提交意图已保存 · 第 \d+ 次 · 禁止自动重提/).waitFor();
  const slotText = (await row.locator(".upload-slots").innerText()).trim();
  if (!slotText.includes("→参考槽位")) throw new Error(`语义角色到实际槽位的映射不可见：${slotText}`);

  const kindSelect = page.locator(".queue-toolbar select").first();
  await kindSelect.selectOption("video");
  await row.waitFor({ state: "hidden" });
  await kindSelect.selectOption("image");
  await row.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "供应商" }).click();
  await page.locator(".provider-settings").waitFor();
  await page.getByRole("button", { name: "供应商" }).click();
  await page.locator(".provider-settings").waitFor({ state: "hidden" });

  const fullFit = await fit();
  assertFit(fullFit, "1560×980");
  const suffix = packagedExecutable ? "-packaged" : "";
  const screenshot = path.join(evidenceDirectory, `browser-generation-safety-checkpoint${suffix}.png`);
  await capture(screenshot);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 760));
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(500);
  const compactFit = await fit();
  assertFit(compactFit, "1280×760");
  const compactScreenshot = path.join(evidenceDirectory, `browser-generation-safety-checkpoint${suffix}-1280.png`);
  await capture(compactScreenshot);

  await page.getByRole("button", { name: "Codex 接续" }).click();
  await page.getByRole("heading", { name: "项目记忆与执行规则" }).waitFor();
  const recoveryBanner = page.locator(".recovery-banner");
  await recoveryBanner.getByText("1 个生成任务必须先对账").waitFor();
  await recoveryBanner.getByText("禁止自动重提").waitFor();
  await recoveryBanner.getByText(fixture.jobId).first().waitFor();
  const recoveryFit = async () => page.evaluate(() => {
    const banner = document.querySelector(".recovery-banner")?.getBoundingClientRect();
    const main = document.querySelector(".brief-main")?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      documentOverflowY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      banner: banner ? { left: banner.left, top: banner.top, right: banner.right, bottom: banner.bottom, width: banner.width } : null,
      main: main ? { left: main.left, top: main.top, right: main.right, bottom: main.bottom, width: main.width } : null,
    };
  });
  const assertRecoveryFit = (value, label) => {
    if (value.documentOverflowX || value.documentOverflowY) throw new Error(`${label} 接续恢复页发生非预期溢出：${JSON.stringify(value)}`);
    if (!value.banner || !value.main || value.banner.left < value.main.left - 1 || value.banner.right > value.main.right + 1 || value.banner.top < value.main.top - 1) throw new Error(`${label} 待对账提示被裁切：${JSON.stringify(value)}`);
  };
  const recoveryCompactFit = await recoveryFit();
  assertRecoveryFit(recoveryCompactFit, "1280×760");
  const recoveryCompactScreenshot = path.join(evidenceDirectory, `codex-generation-recovery${suffix}-1280.png`);
  await capture(recoveryCompactScreenshot);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1560, 980));
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(500);
  const recoveryFullFit = await recoveryFit();
  assertRecoveryFit(recoveryFullFit, "1560×980");
  const recoveryScreenshot = path.join(evidenceDirectory, `codex-generation-recovery${suffix}.png`);
  await capture(recoveryScreenshot);

  const metrics = {
    projectRoot,
    registryPath,
    executablePath: packagedExecutable ? path.resolve(packagedExecutable) : undefined,
    fixture,
    launchedSize,
    fullFit,
    compactFit,
    recoveryFullFit,
    recoveryCompactFit,
    slotText,
    interactions: ["打开生成队列", "图片切换到视频", "视频切回图片", "供应商面板打开", "供应商面板关闭", "打开 Codex 接续", "验证待对账优先提示"],
    screenshots: [screenshot, compactScreenshot, recoveryScreenshot, recoveryCompactScreenshot],
  };
  const metricsPath = path.join(evidenceDirectory, `browser-generation-safety-checkpoint${suffix}.metrics.json`);
  await writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...metrics, metricsPath }, null, 2)}\n`);
} finally {
  await app.close();
}
