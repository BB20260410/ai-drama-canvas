import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(process.argv[2] || "/tmp/ai-canvas-storyboard-contract-ui-20260713");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-storyboard-contract-ui-registry-20260713.json");
const packagedExecutable = process.env.AI_CANVAS_ELECTRON_EXECUTABLE?.trim();
const evidenceDirectory = path.join(workspace, "docs", "evidence");
const screenshot = path.join(evidenceDirectory, packagedExecutable ? "storyboard-director-contract-editor-packaged.png" : "storyboard-director-contract-editor.png");
await mkdir(evidenceDirectory, { recursive: true });

const directorFields = ["shotItemId", "cameraAngle", "lens", "composition", "staging", "expression", "emotion", "eyeline", "screenDirection", "axisSide", "narration", "ambience", "soundEffects", "continuityBefore", "continuityAfter", "referenceNames", "referencePaths", "referenceArtifactIds", "upstreamFactRefs", "upstreamBeatRefs", "sourceSpans", "adaptationPlanId", "adaptationUnitId", "directorIntent", "emotionalIntent", "continuityNotes"];

async function launch() {
  return electron.launch({ ...(packagedExecutable ? { executablePath: path.resolve(packagedExecutable), args: [] } : { args: ["."] }), cwd: workspace, env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath, AI_CANVAS_WINDOW_WIDTH: "1560", AI_CANVAS_WINDOW_HEIGHT: "980" } });
}

async function openStoryboard(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "生产设计" }).click();
  await page.getByRole("heading", { name: "生产设计与连续性" }).waitFor();
  await page.getByRole("button", { name: "正式分镜表" }).click();
  await page.locator(".storyboard-table>button").first().waitFor();
  await page.locator(".storyboard-table>button").first().click();
}

const firstApp = await launch();
let rowId = "";
let before = null;
try {
  const page = await firstApp.firstWindow();
  await openStoryboard(page);
  before = await page.evaluate(async ({ projectRoot }) => {
    const storyboard = await window.canvasApi.getStoryboard(projectRoot);
    return storyboard.rows[0];
  }, { projectRoot });
  if (!before?.id || !before.cameraAngle || !before.lens || !before.composition || !before.sourceSpans?.length) throw new Error(`夹具没有完整导演合同：${JSON.stringify(before)}`);
  rowId = before.id;

  await page.locator(".row-editor summary").filter({ hasText: "对白、旁白与声音" }).click();
  const dialogue = page.locator(".row-editor label").filter({ hasText: "对白 / 字幕" }).locator("textarea");
  await dialogue.fill("UI 只修改这一句对白，其他导演字段必须保留。");
  await page.getByRole("button", { name: "保存分镜" }).click();
  await page.getByText(/正式分镜已安全保存/).waitFor();

  const after = await page.evaluate(async ({ projectRoot, rowId }) => {
    const storyboard = await window.canvasApi.getStoryboard(projectRoot);
    return storyboard.rows.find((row) => row.id === rowId);
  }, { projectRoot, rowId });
  if (after?.dialogue !== "UI 只修改这一句对白，其他导演字段必须保留。") throw new Error("桌面端没有保存目标对白。 ");
  for (const field of directorFields) if (JSON.stringify(after?.[field]) !== JSON.stringify(before[field])) throw new Error(`桌面局部保存丢失导演字段：${field}`);

  await page.locator(".row-editor").evaluate((element) => { element.scrollTop = 0; });
  await page.bringToFront();
  await page.waitForTimeout(800);
  await page.screenshot({ path: screenshot, type: "png" });
} finally {
  await firstApp.close();
}

const secondApp = await launch();
try {
  const page = await secondApp.firstWindow();
  await openStoryboard(page);
  const restored = await page.evaluate(async ({ projectRoot, rowId }) => {
    const storyboard = await window.canvasApi.getStoryboard(projectRoot);
    return storyboard.rows.find((row) => row.id === rowId);
  }, { projectRoot, rowId });
  if (!restored || restored.dialogue !== "UI 只修改这一句对白，其他导演字段必须保留。") throw new Error("应用重启后目标对白没有恢复。 ");
  for (const field of directorFields) if (JSON.stringify(restored[field]) !== JSON.stringify(before[field])) throw new Error(`应用重启后导演字段不一致：${field}`);
  process.stdout.write(`${JSON.stringify({ projectRoot, registryPath, executablePath: packagedExecutable ? path.resolve(packagedExecutable) : undefined, rowId, revision: restored.revision, directorFieldsPreserved: directorFields.length, restartVerified: true, screenshot }, null, 2)}\n`);
} finally {
  await secondApp.close();
}
