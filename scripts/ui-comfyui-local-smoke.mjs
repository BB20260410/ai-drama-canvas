import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import sharp from "sharp";
import { removeOwnedTemporaryFixtureRoot } from "./lib/owned-fixture-root.ts";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(process.argv[2] || "/tmp/ai-canvas-comfyui-local-ui");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-comfyui-local-ui-registry.json");
const evidencePath = path.resolve(process.argv[4] || path.join(workspace, "docs", "evidence", "comfyui-local-ui-smoke-20260714.json"));
const screenshotPath = path.join(path.dirname(evidencePath), "comfyui-local-ui-20260714.png");
const settingsScreenshotPath = path.join(path.dirname(evidencePath), "comfyui-local-settings-ui-20260714.png");
const tsx = path.join(workspace, "node_modules", ".bin", "tsx");
const outputImage = await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#9a6b40" } }).png().toBuffer();
const submissions = new Map();
const states = new Map();
const counts = { post: 0, history: 0, queue: 0, view: 0 };

function isTemporaryPath(candidate) {
  return [os.tmpdir(), "/tmp", "/private/tmp"].map((base) => path.resolve(base)).some((base) => {
    const relative = path.relative(base, path.resolve(candidate));
    return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
}

if (![projectRoot, registryPath].every(isTemporaryPath)) {
  throw new Error("ComfyUI UI fixture 的 project/registry 必须全部位于临时目录。");
}

const body = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};
const tuple = (id, number = 1) => {
  const submitted = submissions.get(id);
  if (!submitted) throw new Error(`UI loopback 缺少提交 ${id}`);
  return [number, id, submitted.prompt, { client_id: submitted.client_id, aicanvas: submitted.extra_data.aicanvas }, ["9"]];
};
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const json = (status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  try {
    if (request.method === "GET" && url.pathname === "/system_stats") return json(200, { system: { comfyui_version: "electron-loopback", os: "loopback" }, devices: [] });
    if (request.method === "GET" && url.pathname === "/features") return json(200, { api_jobs_cancel: true });
    if (request.method === "GET" && url.pathname.startsWith("/object_info/")) return json(200, { [decodeURIComponent(url.pathname.slice("/object_info/".length))]: { input: { required: {} }, output: [] } });
    if (request.method === "POST" && url.pathname === "/prompt") {
      const payload = await body(request);
      counts.post += 1;
      submissions.set(payload.prompt_id, payload);
      states.set(payload.prompt_id, "pending");
      return json(200, { prompt_id: payload.prompt_id, number: counts.post, node_errors: {} });
    }
    if (request.method === "GET" && url.pathname === "/queue") {
      counts.queue += 1;
      return json(200, { queue_running: [], queue_pending: [...states].filter(([, state]) => state === "pending").map(([id]) => tuple(id, 2)) });
    }
    if (request.method === "GET" && url.pathname.startsWith("/history/")) {
      counts.history += 1;
      const id = decodeURIComponent(url.pathname.slice("/history/".length));
      if (states.get(id) !== "success") return json(200, {});
      return json(200, { [id]: { prompt: tuple(id), status: { status_str: "success", completed: true, messages: [["execution_success", { prompt_id: id }]] }, outputs: { "9": { images: [{ filename: "electron-result.png", subfolder: "AI_Canvas", type: "output" }] } } } });
    }
    if (request.method === "GET" && url.pathname === "/view") {
      counts.view += 1;
      response.writeHead(200, { "content-type": "image/png", "content-length": outputImage.length });
      response.end(outputImage);
      return;
    }
    response.writeHead(404).end();
  } catch {
    json(500, { error: "loopback failed" });
  }
});

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const exists = (filePath) => access(filePath).then(() => true).catch(() => false);
const capture = async (app, page, outputPath) => {
  await page.waitForTimeout(700);
  const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const nativePath = `${outputPath}.native.png`;
  await app.evaluate(async ({ BrowserWindow }, targetPath) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Electron 原生截图找不到 BrowserWindow。 ");
    const image = await window.capturePage();
    process.getBuiltinModule("fs").writeFileSync(targetPath, image.toPNG());
  }, nativePath);
  await sharp(nativePath).resize(size.width, size.height, { fit: "fill" }).png().toFile(outputPath);
  await rm(nativePath, { force: true });
};
const captureElement = async (page, locator, outputPath) => {
  await page.waitForTimeout(700);
  const raw = await locator.screenshot({ type: "png", animations: "disabled" });
  await sharp(raw).png().toFile(outputPath);
};
const inspectImage = async (filePath) => {
  const bytes = await readFile(filePath);
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let bright = 0;
  let chromatic = 0;
  let nonDark = 0;
  for (let index = 0; index < data.length; index += info.channels) {
    const red = data[index] ?? 0;
    const green = data[index + 1] ?? 0;
    const blue = data[index + 2] ?? 0;
    if (red + green + blue > 420) bright += 1;
    if (Math.max(red, green, blue) - Math.min(red, green, blue) > 25) chromatic += 1;
    if (red + green + blue > 90) nonDark += 1;
  }
  const pixels = info.width * info.height;
  const stats = await sharp(bytes).stats();
  return { path: filePath, bytes: bytes.length, sha256: sha256(bytes), width: info.width, height: info.height, brightRatio: bright / pixels, chromaticRatio: chromatic / pixels, nonDarkRatio: nonDark / pixels, entropy: stats.entropy, channelStdDev: stats.channels.slice(0, 3).map((channel) => channel.stdev) };
};

let app;
let fixture;
let serverClosed = false;
let projectRemoved = false;
let registryRemoved = false;
let result = {};
await mkdir(path.dirname(evidencePath), { recursive: true });
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const prepared = await execFileAsync(tsx, ["scripts/prepare-comfyui-local-ui-fixture.ts", projectRoot, registryPath, endpoint], { cwd: workspace, env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath }, maxBuffer: 2_000_000 });
  fixture = JSON.parse(prepared.stdout);
  if (!fixture.remoteSubmitted || fixture.realComfyUiCalled || fixture.checkpoint?.stage !== "queued") throw new Error(`ComfyUI Electron fixture 不符合预期：${prepared.stdout}`);

  app = await electron.launch({ args: ["."], cwd: workspace, env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath, AI_CANVAS_PROJECT_ROOT: projectRoot, AI_CANVAS_WINDOW_WIDTH: "1560", AI_CANVAS_WINDOW_HEIGHT: "980" } });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "生成队列" }).click();
  await page.getByRole("heading", { name: "可恢复生成队列" }).waitFor();
  const row = page.locator(".job-row").filter({ hasText: "ComfyUI Electron 协议夹具" });
  await row.waitFor();
  await row.locator(".comfy-checkpoint").getByText(/ComfyUI queued · R\d+ · prompt/).waitFor();
  const queuedText = (await row.innerText()).trim();

  await page.getByRole("button", { name: "供应商" }).click();
  const editors = page.locator(".provider-editor");
  const editorIndex = await editors.evaluateAll((nodes, expectedName) => nodes.findIndex((node) => node.querySelector(".provider-head input")?.value === expectedName), "ComfyUI Electron 协议夹具");
  if (editorIndex < 0) throw new Error("供应商设置中找不到 ComfyUI Electron 协议夹具。 ");
  const editor = editors.nth(editorIndex);
  await editor.waitFor();
  await editor.getByText(/仅允许 localhost.*原子 jobs 接口/).waitFor();
  await editor.getByText(/SHA-256 [a-f0-9]{16}/).waitFor();
  const settingsFit = await page.evaluate(async (targetIndex) => {
    window.scrollTo(0, 0);
    const scroller = document.querySelector(".settings-scroll");
    const target = scroller?.querySelectorAll(".provider-editor")[targetIndex];
    if (!(scroller instanceof HTMLElement) || !(target instanceof HTMLElement)) return null;
    const initialScrollRect = scroller.getBoundingClientRect();
    const initialTargetRect = target.getBoundingClientRect();
    scroller.scrollTop += initialTargetRect.top - initialScrollRect.top;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const scrollRect = scroller.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return { scrollTop: scroller.scrollTop, windowScrollX: window.scrollX, windowScrollY: window.scrollY, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, scroller: { top: scrollRect.top, bottom: scrollRect.bottom }, target: { top: targetRect.top, bottom: targetRect.bottom } };
  }, editorIndex);
  if (!settingsFit || settingsFit.windowScrollX !== 0 || settingsFit.windowScrollY !== 0 || settingsFit.target.top < settingsFit.scroller.top - 1 || settingsFit.target.top >= settingsFit.scroller.bottom) throw new Error(`ComfyUI 供应商设置未滚动到可见区域：${JSON.stringify(settingsFit)}`);
  await page.waitForTimeout(120);
  await captureElement(page, page.locator(".provider-settings"), settingsScreenshotPath);
  await page.getByRole("button", { name: "供应商" }).click();
  await page.locator(".provider-settings").waitFor({ state: "hidden" });
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.waitForTimeout(120);

  states.set(fixture.promptId, "success");
  await page.getByRole("button", { name: "提交 / 轮询" }).click();
  await page.getByText("生成队列已提交并轮询外部落盘结果").waitFor();
  await row.getByText("已完成").waitFor();
  await row.locator(".comfy-checkpoint").getByText(/ComfyUI verified · R\d+ · prompt .* · 9\[0\] \/ electron-result\.png/).waitFor();
  const completedText = (await row.innerText()).trim();
  const fit = await page.evaluate(() => {
    const row = document.querySelector(".job-row")?.getBoundingClientRect();
    const list = document.querySelector(".job-list")?.getBoundingClientRect();
    return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth, documentOverflowY: document.documentElement.scrollHeight > document.documentElement.clientHeight, row: row ? { left: row.left, top: row.top, right: row.right, bottom: row.bottom } : null, list: list ? { left: list.left, top: list.top, right: list.right, bottom: list.bottom } : null };
  });
  if (fit.documentOverflowX || fit.documentOverflowY || !fit.row || !fit.list || fit.row.left < fit.list.left - 1 || fit.row.right > fit.list.right + 1 || fit.row.top < fit.list.top - 1 || fit.row.bottom > fit.list.bottom + 1) throw new Error(`ComfyUI Electron 任务行布局异常：${JSON.stringify(fit)}`);
  await page.evaluate(async () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(120);
  await capture(app, page, screenshotPath);

  const stored = await page.evaluate(async ({ projectRoot, jobId }) => (await window.canvasApi.listGenerationJobs(projectRoot)).find((job) => job.id === jobId), { projectRoot, jobId: fixture.jobId });
  if (stored?.status !== "succeeded" || stored.comfyUiCheckpoint?.stage !== "verified" || stored.comfyUiCheckpoint?.history?.eventName !== "execution_success" || stored.comfyUiCheckpoint?.output?.nodeId !== "9") throw new Error(`Electron UI 后端状态未完成严格 ComfyUI 验收：${JSON.stringify(stored)}`);
  const outputBytes = await readFile(stored.expectedOutputPath);
  if (!outputBytes.equals(outputImage)) throw new Error("Electron UI 生成结果与 loopback 原图不一致。 ");
  const [screenshot, settingsScreenshot] = await Promise.all([inspectImage(screenshotPath), inspectImage(settingsScreenshotPath)]);
  const hasVisualSignal = (image) => image.nonDarkRatio >= 0.01 && image.entropy >= 0.5 && Math.max(...image.channelStdDev) >= 8;
  if (!hasVisualSignal(screenshot) || !hasVisualSignal(settingsScreenshot)) throw new Error(`ComfyUI Electron 截图疑似黑屏或空白：${JSON.stringify({ screenshot, settingsScreenshot })}`);

  result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    success: true,
    workspace,
    fixture: { jobId: fixture.jobId, promptId: fixture.promptId, providerRevision: fixture.providerRevision, remoteSubmitted: fixture.remoteSubmitted, realComfyUiCalled: fixture.realComfyUiCalled },
    interaction: { queuedText, completedText, steps: ["打开生成队列", "核验 queued 稳定 promptId", "打开供应商设置", "核验 official tuple/原子取消边界", "关闭设置", "点击提交 / 轮询", "核验 verified 输出节点"] },
    persisted: { status: stored.status, attempts: stored.attempts, externalTaskId: stored.externalTaskId, checkpoint: stored.comfyUiCheckpoint, resultPath: stored.resultPath, resultSha256: stored.resultSha256, publicationReceiptId: stored.publicationReceiptId, outputBytes: outputBytes.length, outputSha256: sha256(outputBytes) },
    protocolCounts: counts,
    fit,
    settingsFit,
    screenshot,
    settingsScreenshot,
    settingsScreenshotScope: "visible-provider-settings-panel",
    cleanup: { projectRoot, registryPath, projectRemoved: false, registryRemoved: false, serverClosed: false },
    boundaries: { realComfyUiCalled: false, externalProviderCalled: false, websiteOpened: false, uploadPerformed: false, paidActionPerformed: false, signedDmgTouched: false },
  };
} finally {
  if (app) await app.close().catch(() => undefined);
  await new Promise((resolve) => server.close(() => resolve()));
  serverClosed = true;
  if (await exists(projectRoot)) {
    await removeOwnedTemporaryFixtureRoot(projectRoot, "prepare-comfyui-local-ui-fixture");
  }
  await rm(registryPath, { force: true });
  projectRemoved = !(await exists(projectRoot));
  registryRemoved = !(await exists(registryPath));
}

result.cleanup = { ...(result.cleanup ?? {}), projectRemoved, registryRemoved, serverClosed };
await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ evidencePath, success: result.success, screenshots: [screenshotPath, settingsScreenshotPath], protocolCounts: counts, cleanup: result.cleanup }, null, 2)}\n`);
