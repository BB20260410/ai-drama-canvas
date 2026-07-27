import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(process.argv[2] || "/tmp/ai-canvas-continuity-ui-smoke-project");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-continuity-ui-smoke-registry.json");
const screenshotPath = path.resolve(process.argv[4] || "/tmp/ai-canvas-continuity-ui-smoke.png");
const packagedExecutable = process.env.AI_CANVAS_ELECTRON_EXECUTABLE?.trim();
await mkdir(path.dirname(screenshotPath), { recursive: true });

const app = await electron.launch({
  ...(packagedExecutable
    ? { executablePath: path.resolve(packagedExecutable), args: [] }
    : { args: ["."] }),
  cwd: workspace,
  env: {
    ...process.env,
    AI_CANVAS_PROJECT_ROOT: projectRoot,
    AI_CANVAS_REGISTRY_PATH: registryPath,
    AI_CANVAS_WINDOW_WIDTH: "1560",
    AI_CANVAS_WINDOW_HEIGHT: "980",
  },
});

const pageErrors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "连续性", exact: true }).click();
  await page.getByRole("heading", { name: "角色、场景与道具出场轨道" }).waitFor();
  await page.locator(".track-list > button").first().waitFor();
  await page.locator(".span-row").first().waitFor();

  const apiState = await page.evaluate(async ({ projectRoot }) => {
    const tracks = await window.canvasApi.listContinuityTracks(projectRoot, { offset: 0, limit: 30 });
    if (!tracks.available || !tracks.items[0]) throw new Error("连续性轨道侧车不可用。 ");
    const spans = await window.canvasApi.getContinuitySpans(projectRoot, tracks.items[0].assetId, { offset: 0, limit: 80 });
    const index = await window.canvasApi.getIndex(projectRoot);
    const firstSpan = spans.items[0];
    const target = firstSpan ? index.items.find((item) => item.id === firstSpan.unitItemId && item.type === "unit") : undefined;
    return {
      trackTotal: tracks.total,
      trackPageSize: tracks.items.length,
      spanTotal: spans.total,
      spanPageSize: spans.items.length,
      firstAssetId: tracks.items[0].assetId,
      firstUnitItemId: firstSpan?.unitItemId,
      firstUnitTitle: target?.title,
    };
  }, { projectRoot });

  if (apiState.trackTotal !== 77) throw new Error(`连续性轨道总数不是 77：${apiState.trackTotal}`);
  if (apiState.trackPageSize !== 30) throw new Error(`轨道首屏没有按 30 条分页：${apiState.trackPageSize}`);
  if (apiState.spanPageSize !== Math.min(80, apiState.spanTotal)) throw new Error(`跨度首屏没有按 80 条分页：${apiState.spanPageSize}/${apiState.spanTotal}`);
  if (!apiState.firstUnitItemId || !apiState.firstUnitTitle) throw new Error("首条连续性跨度没有映射到真实单元节点。 ");

  const rendered = {
    tracks: await page.locator(".track-list > button").count(),
    spans: await page.locator(".span-row").count(),
    trackPage: (await page.locator(".track-rail .pager span").textContent())?.trim(),
    spanPage: (await page.locator(".span-pager span").textContent())?.trim(),
  };
  if (rendered.tracks !== apiState.trackPageSize || rendered.spans !== apiState.spanPageSize) {
    throw new Error(`UI 分页与只读 API 不一致：${JSON.stringify({ apiState, rendered })}`);
  }

  await page.screenshot({ path: screenshotPath, type: "png", animations: "disabled" });
  await page.locator(".span-row").first().click();
  await page.locator(".module-nav button.active").filter({ hasText: "生产画布" }).waitFor();
  await page.locator(".inspector.open h2").filter({ hasText: apiState.firstUnitTitle }).waitFor();
  await page.getByText(`已定位 ${apiState.firstUnitTitle}`, { exact: true }).waitFor();

  const canvas = await page.evaluate(({ targetId }) => ({
    activeModule: document.querySelector(".module-nav button.active")?.textContent?.trim(),
    inspectorTitle: document.querySelector(".inspector.open h2")?.textContent?.trim(),
    targetPresent: window.aiCanvasDiagnostics?.snapshot().productionNodeIds.includes(targetId) ?? false,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }), { targetId: apiState.firstUnitItemId });
  if (!canvas.targetPresent || canvas.horizontalOverflow) throw new Error(`单元画布定位验收失败：${JSON.stringify(canvas)}`);
  if (pageErrors.length) throw new Error(`页面运行错误：${pageErrors.join("；")}`);

  process.stdout.write(`${JSON.stringify({
    projectRoot,
    registryPath,
    screenshotPath,
    apiState,
    rendered,
    canvas,
    pageErrors,
  }, null, 2)}\n`);
} finally {
  await app.close();
}
