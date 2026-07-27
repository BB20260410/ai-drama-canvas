import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import sharp from "sharp";
import {
  removeOwnedTemporaryFixtureRoot,
  resetOwnedFixtureRoot,
} from "./lib/owned-fixture-root.ts";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/T/, "-").slice(0, 13);
const projectRoot = path.resolve(process.argv[2] || `/tmp/ai-canvas-revision-cas-ui-${process.pid}`);
const registryPath = path.resolve(process.argv[3] || `/tmp/ai-canvas-revision-cas-ui-registry-${process.pid}.json`);
const evidencePath = path.resolve(process.argv[4] || path.join(workspace, "docs", "evidence", `revision-cas-electron-ui-${stamp}.json`));
const screenshotPath = path.resolve(process.argv[5] || path.join(workspace, "docs", "evidence", `revision-cas-electron-ui-${stamp}.png`));
const userDataA = `${projectRoot}-client-a`;
const userDataB = `${projectRoot}-client-b`;
const temporaryRoots = [projectRoot, registryPath, userDataA, userDataB];
if (!temporaryRoots.every((candidate) => {
  const relative = path.relative("/tmp", path.resolve(candidate).replace(/^\/private\/tmp\//u, "/tmp/"));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
})) throw new Error("Revision CAS UI 的 project/registry/user-data 必须全部位于临时目录。");
await Promise.all([
  mkdir(path.dirname(evidencePath), { recursive: true }),
  mkdir(path.dirname(screenshotPath), { recursive: true }),
  resetOwnedFixtureRoot(userDataA, "ui-revision-cas-client-a"),
  resetOwnedFixtureRoot(userDataB, "ui-revision-cas-client-b"),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function screenshotContent(filePath) {
  const { data, info } = await sharp(filePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let brightPixels = 0;
  let chromaticPixels = 0;
  const regions = {
    top: { pixels: 0, brightPixels: 0 },
    left: { pixels: 0, brightPixels: 0 },
    right: { pixels: 0, brightPixels: 0 },
  };
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const pixel = offset / info.channels;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? 0;
    const blue = data[offset + 2] ?? 0;
    const bright = Math.max(red, green, blue) >= 50;
    if (bright) brightPixels += 1;
    if (Math.max(red, green, blue) - Math.min(red, green, blue) >= 28) chromaticPixels += 1;
    if (y < info.height * .2) { regions.top.pixels += 1; if (bright) regions.top.brightPixels += 1; }
    if (x < info.width * .18) { regions.left.pixels += 1; if (bright) regions.left.brightPixels += 1; }
    if (x >= info.width * .82) { regions.right.pixels += 1; if (bright) regions.right.brightPixels += 1; }
  }
  const pixels = info.width * info.height;
  return {
    pixels,
    brightPixels,
    brightRatio: brightPixels / pixels,
    chromaticPixels,
    chromaticRatio: chromaticPixels / pixels,
    edgeBrightRatios: Object.fromEntries(Object.entries(regions).map(([name, region]) => [name, region.brightPixels / region.pixels])),
  };
}

async function captureStableUi(page) {
  let content;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.bringToFront();
    await page.waitForTimeout(350);
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const raw = await page.screenshot({ type: "png", animations: "disabled" });
    await sharp(raw).resize(viewport.width, viewport.height, { fit: "fill" }).png().toFile(screenshotPath);
    content = await screenshotContent(screenshotPath);
    if (content.brightRatio >= .01
      && content.chromaticRatio >= .005
      && Object.values(content.edgeBrightRatios).every((ratio) => ratio >= .003)) return { attempt, content };
  }
  throw new Error(`Revision CAS UI 截图连续三次内容覆盖不足：${JSON.stringify(content)}`);
}

async function openModule(page, buttonName, headingName) {
  await page.getByRole("button", { name: buttonName, exact: true }).click();
  await page.getByRole("heading", { name: headingName, exact: true }).waitFor();
}

async function selectContext(page, id) {
  const row = page.locator(`[data-testid="context-row"][data-context-id="${id}"]`);
  await row.waitFor();
  await row.click();
}

async function waitToast(page, text, error = false) {
  const locator = page.locator(error ? ".toast-message.error" : ".toast-message:not(.error)").filter({ hasText: text });
  await locator.waitFor({ state: "visible", timeout: 10_000 });
  return (await locator.textContent())?.trim() ?? "";
}

async function readState(page, fixture) {
  return page.evaluate(async ({ projectRoot, fixture }) => {
    const [workflow, bibles, relations, voices, contexts] = await Promise.all([
      window.canvasApi.getProductionWorkflow(projectRoot),
      window.canvasApi.listCreativeBibles(projectRoot),
      window.canvasApi.listAssetRelations(projectRoot),
      window.canvasApi.listVoiceIdentities(projectRoot),
      window.canvasApi.listContext(projectRoot),
    ]);
    return {
      workflow: {
        revision: workflow.revision,
        source: workflow.stages.find((stage) => stage.id === "source"),
      },
      bible: bibles.find((entry) => entry.id === fixture.bible.id),
      relation: relations.find((entry) => entry.id === fixture.relation.id),
      voice: voices.find((entry) => entry.id === fixture.voice.id),
      updateContext: contexts.find((entry) => entry.id === fixture.updateContext.id),
      deleteContext: contexts.find((entry) => entry.id === fixture.deleteContext.id),
    };
  }, { projectRoot, fixture });
}

const fixtureExecutable = path.join(workspace, "node_modules", ".bin", "tsx");
const fixtureRun = await execFileAsync(fixtureExecutable, ["scripts/prepare-revision-cas-ui-fixture.ts", projectRoot, registryPath], {
  cwd: workspace,
  env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath, AI_CANVAS_PROJECT_ROOT: projectRoot },
  maxBuffer: 2_000_000,
});
const fixture = JSON.parse(fixtureRun.stdout.trim());

const sharedEnv = {
  ...process.env,
  AI_CANVAS_REGISTRY_PATH: registryPath,
  AI_CANVAS_PROJECT_ROOT: projectRoot,
  AI_CANVAS_WINDOW_WIDTH: "1560",
  AI_CANVAS_WINDOW_HEIGHT: "980",
};
const [appA, appB] = await Promise.all([
  electron.launch({ args: [".", `--user-data-dir=${userDataA}`], cwd: workspace, env: sharedEnv }),
  electron.launch({ args: [".", `--user-data-dir=${userDataB}`], cwd: workspace, env: sharedEnv }),
]);

const pageErrors = { clientA: [], clientB: [] };
const conflicts = {};
const successes = {};
let finalState;
try {
  const [pageA, pageB] = await Promise.all([appA.firstWindow(), appB.firstWindow()]);
  pageA.on("pageerror", (error) => pageErrors.clientA.push(error.message));
  pageB.on("pageerror", (error) => pageErrors.clientB.push(error.message));
  pageB.on("dialog", (dialog) => void dialog.accept());
  await Promise.all([pageA.waitForLoadState("domcontentloaded"), pageB.waitForLoadState("domcontentloaded")]);

  // Context update: both clients first hold revision 1; A wins and B must be rejected.
  await Promise.all([
    openModule(pageA, "Codex 接续", "项目记忆与执行规则"),
    openModule(pageB, "Codex 接续", "项目记忆与执行规则"),
  ]);
  await Promise.all([
    pageA.getByTestId("continuation-tab-memory").click(),
    pageB.getByTestId("continuation-tab-memory").click(),
  ]);
  await Promise.all([selectContext(pageA, fixture.updateContext.id), selectContext(pageB, fixture.updateContext.id)]);
  await pageA.locator(".memory-editor").getByLabel("内容", { exact: true }).fill("CLIENT_A_CONTEXT_UPDATE_WINNER");
  await pageB.locator(".memory-editor").getByLabel("内容", { exact: true }).fill("CLIENT_B_CONTEXT_UPDATE_LOSER");
  await pageA.getByTestId("save-context").click();
  successes.contextUpdate = await waitToast(pageA, "项目记忆已保存");
  await pageB.getByTestId("save-context").click();
  conflicts.contextUpdate = await waitToast(pageB, "项目记忆已被其他窗口更新", true);

  // Context delete: B holds the old revision while A updates the same entry.
  await Promise.all([selectContext(pageA, fixture.deleteContext.id), selectContext(pageB, fixture.deleteContext.id)]);
  await pageA.locator(".memory-editor").getByLabel("内容", { exact: true }).fill("CLIENT_A_CONTEXT_DELETE_GUARD_WINNER");
  await pageA.getByTestId("save-context").click();
  successes.contextDeleteGuard = await waitToast(pageA, "项目记忆已保存");
  await pageB.getByTestId("delete-context").click();
  conflicts.contextDelete = await waitToast(pageB, "canvas:delete-context", true);

  // Both ProductionDesign components load the same initial workflow/entities before any winner writes.
  await Promise.all([
    openModule(pageA, "生产设计", "生产设计与连续性"),
    openModule(pageB, "生产设计", "生产设计与连续性"),
  ]);
  await Promise.all([
    pageA.getByTestId("save-production-stage").waitFor(),
    pageB.getByTestId("save-production-stage").waitFor(),
  ]);

  const stageA = pageA.locator(".editor-panel");
  const stageB = pageB.locator(".editor-panel");
  await stageA.locator("select").first().selectOption("in_progress");
  await stageB.locator("select").first().selectOption("review");
  await stageA.locator("textarea").first().fill("CLIENT_A_WORKFLOW_WINNER");
  await stageB.locator("textarea").first().fill("CLIENT_B_WORKFLOW_LOSER");
  await pageA.getByTestId("save-production-stage").click();
  successes.workflow = await waitToast(pageA, "生产阶段已保存");
  await pageB.getByTestId("save-production-stage").click();
  conflicts.workflow = await waitToast(pageB, "生产工作流已被其他窗口更新", true);

  await Promise.all([
    pageA.getByTestId("design-tab-bibles").click(),
    pageB.getByTestId("design-tab-bibles").click(),
  ]);
  const bibleRowA = pageA.locator(".bible-list > button").filter({ hasText: "双客户端导演 Bible" });
  const bibleRowB = pageB.locator(".bible-list > button").filter({ hasText: "双客户端导演 Bible" });
  await Promise.all([bibleRowA.click(), bibleRowB.click()]);
  await pageA.locator(".bible-editor").getByLabel("总述", { exact: true }).fill("CLIENT_A_BIBLE_WINNER");
  await pageB.locator(".bible-editor").getByLabel("总述", { exact: true }).fill("CLIENT_B_BIBLE_LOSER");
  await pageA.getByTestId("save-creative-bible").click();
  successes.bible = await waitToast(pageA, "创作 Bible 已保存");
  await pageB.getByTestId("save-creative-bible").click();
  conflicts.bible = await waitToast(pageB, "创作 Bible已被其他窗口更新", true);

  await Promise.all([
    pageA.getByTestId("design-tab-registry").click(),
    pageB.getByTestId("design-tab-registry").click(),
  ]);
  const relationRowA = pageA.locator(`[data-testid="asset-relation-row"][data-relation-id="${fixture.relation.id}"]`);
  const relationRowB = pageB.locator(`[data-testid="asset-relation-row"][data-relation-id="${fixture.relation.id}"]`);
  await Promise.all([relationRowA.click(), relationRowB.click()]);
  await pageA.locator(".registry-panel").first().getByLabel("衍生操作", { exact: true }).fill("CLIENT_A_RELATION_WINNER");
  await pageB.locator(".registry-panel").first().getByLabel("衍生操作", { exact: true }).fill("CLIENT_B_RELATION_LOSER");
  await pageA.getByTestId("save-asset-relation").click();
  successes.relation = await waitToast(pageA, "资产血缘已安全保存");
  await pageB.getByTestId("save-asset-relation").click();
  conflicts.relation = await waitToast(pageB, "资产关系已被其他窗口更新", true);

  const voiceRowA = pageA.locator(`[data-testid="voice-row"][data-voice-id="${fixture.voice.id}"]`);
  const voiceRowB = pageB.locator(`[data-testid="voice-row"][data-voice-id="${fixture.voice.id}"]`);
  await Promise.all([voiceRowA.click(), voiceRowB.click()]);
  await pageA.locator(".registry-panel").nth(1).getByLabel("声音描述", { exact: true }).fill("CLIENT_A_VOICE_WINNER");
  await pageB.locator(".registry-panel").nth(1).getByLabel("声音描述", { exact: true }).fill("CLIENT_B_VOICE_LOSER");
  await pageA.getByTestId("save-voice-identity").click();
  successes.voice = await waitToast(pageA, "角色音色已保存");
  await pageB.getByTestId("save-voice-identity").click();
  conflicts.voice = await waitToast(pageB, "音色身份已被其他窗口更新", true);

  finalState = await readState(pageA, fixture);
  assert(finalState.workflow.revision === fixture.workflowRevision + 1, `Workflow revision 错误：${JSON.stringify(finalState.workflow)}`);
  assert(finalState.workflow.source?.status === "in_progress" && finalState.workflow.source?.note === "CLIENT_A_WORKFLOW_WINNER", `Workflow loser 覆盖或 winner 未落盘：${JSON.stringify(finalState.workflow)}`);
  assert(finalState.bible?.revision === fixture.bible.revision + 1 && finalState.bible.summary === "CLIENT_A_BIBLE_WINNER", `Bible loser 覆盖或 winner 未落盘：${JSON.stringify(finalState.bible)}`);
  assert(finalState.bible?.tags?.includes("hidden-preserve"), `Bible 隐藏 tags 被 UI update 擦除：${JSON.stringify(finalState.bible)}`);
  assert(finalState.relation?.revision === fixture.relation.revision + 1 && finalState.relation.operation === "CLIENT_A_RELATION_WINNER", `Relation loser 覆盖或 winner 未落盘：${JSON.stringify(finalState.relation)}`);
  assert(finalState.voice?.revision === fixture.voice.revision + 1 && finalState.voice.description === "CLIENT_A_VOICE_WINNER", `Voice loser 覆盖或 winner 未落盘：${JSON.stringify(finalState.voice)}`);
  assert(finalState.voice?.tags?.includes("hidden-preserve"), `Voice 隐藏 tags 被 UI update 擦除：${JSON.stringify(finalState.voice)}`);
  assert(finalState.updateContext?.revision === fixture.updateContext.revision + 1 && finalState.updateContext.content === "CLIENT_A_CONTEXT_UPDATE_WINNER", `Context stale update 未拒绝：${JSON.stringify(finalState.updateContext)}`);
  assert(finalState.deleteContext?.revision === fixture.deleteContext.revision + 1 && finalState.deleteContext.content === "CLIENT_A_CONTEXT_DELETE_GUARD_WINNER", `Context stale delete 未拒绝或实体被误删：${JSON.stringify(finalState.deleteContext)}`);
  assert(!JSON.stringify(finalState).includes("_LOSER"), `最终状态含 loser 内容：${JSON.stringify(finalState)}`);
  assert(Object.keys(conflicts).length === 6 && Object.values(conflicts).every((value) => value.includes("其他窗口更新")), `冲突提示不完整：${JSON.stringify(conflicts)}`);
  assert(conflicts.contextDelete.includes("canvas:delete-context"), `Context stale delete 没有经过 delete IPC：${conflicts.contextDelete}`);
  assert(pageErrors.clientA.length === 0 && pageErrors.clientB.length === 0, `Electron pageerror：${JSON.stringify(pageErrors)}`);

  const screenshotCapture = await captureStableUi(pageB);
  const screenshotBuffer = await readFile(screenshotPath);
  const screenshotMetadata = await sharp(screenshotBuffer).metadata();
  const screenshotStat = await stat(screenshotPath);
  const screenshot = {
    path: screenshotPath,
    bytes: screenshotStat.size,
    sha256: createHash("sha256").update(screenshotBuffer).digest("hex"),
    width: screenshotMetadata.width,
    height: screenshotMetadata.height,
    content: screenshotCapture.content,
  };
  assert(screenshot.bytes >= 20_000 && screenshot.width === 1560 && screenshot.height === 980, `Electron 截图异常：${JSON.stringify(screenshot)}`);

  const evidence = {
    schemaVersion: 1,
    kind: "revision-cas-dual-electron",
    generatedAt: new Date().toISOString(),
    transport: "two-independent-electron-processes-current-build",
    projectRoot,
    registryPath,
    clients: {
      clientA: { userDataDir: userDataA, role: "winner" },
      clientB: { userDataDir: userDataB, role: "stale-loser" },
    },
    fixture,
    successes,
    conflicts,
    finalState,
    assertions: {
      twoIndependentElectronProcesses: true,
      sameProjectAndRegistry: true,
      contextStaleUpdateRejected: true,
      contextStaleDeleteRejected: true,
      workflowStaleUpdateRejected: true,
      bibleStaleUpdateRejected: true,
      relationStaleUpdateRejected: true,
      voiceStaleUpdateRejected: true,
      exactlyOneRevisionAdvancePerEntity: true,
      loserContentAbsent: true,
      hiddenFieldsPreserved: true,
      pageErrors,
      screenshotCaptureAttempt: screenshotCapture.attempt,
    },
    screenshot,
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ success: true, evidencePath, screenshot, conflicts: Object.keys(conflicts), pageErrors })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    success: false,
    message: error instanceof Error ? error.message : String(error),
    conflicts,
    successes,
    pageErrors,
  })}\n`);
  throw error;
} finally {
  await Promise.allSettled([appA.close(), appB.close()]);
  if (await stat(projectRoot).then(() => true, () => false)) {
    await removeOwnedTemporaryFixtureRoot(projectRoot, "prepare-revision-cas-ui-fixture");
  }
  await Promise.all([
    removeOwnedTemporaryFixtureRoot(userDataA, "ui-revision-cas-client-a"),
    removeOwnedTemporaryFixtureRoot(userDataB, "ui-revision-cas-client-b"),
  ]);
  await rm(registryPath, { force: true });
}
