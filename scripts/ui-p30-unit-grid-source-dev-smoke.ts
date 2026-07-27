/**
 * P30 S3 源码态 Electron 定向旅程。
 *
 * 仅使用临时《嘟嘟》夹具、隔离 registry/userData 和确定性本地图像；不调用
 * imagegen、外部供应商或动态视频模型，不读取/写入正式工程，也不制作安装包。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import sharp from "sharp";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import { computeSourceDigest } from "../src/core/build-identity.js";
import {
  finalizeDuduReadonlyManagedProject,
  getDuduReadonlyImportControl,
  stageDuduReadonlyManagedProject,
} from "../src/core/dudu-readonly-import.js";
import { inspectDuduReadonlySources } from "../src/core/dudu-readonly-source.js";
import { commitAgentImagegenResultBundle } from "../src/core/studio-agent-imagegen-result-bundle.js";
import {
  getStudioGenerationLedgerState,
  listStudioGenerationPlanProjections,
  listStudioGenerationUnitGridHistory,
  prepareStudioImagegenCall,
  readStudioUnitGridGenerationFrozenPack,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import {
  getStudioVideoPackageControl,
  prepareStudioVideoPackageExport,
} from "../src/core/studio-video-package.js";
import {
  createDuduReadonlySourceFixture,
  type DuduReadonlySourceFixture,
} from "../tests/helpers/dudu-readonly-source-fixture.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = path.join(workspace, ".planning", "reviews", "P30", "evidence");
const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
const evidencePath = path.resolve(process.argv[2] ?? path.join(
  evidenceDirectory,
  `p30-s3-unit-grid-source-electron-${timestamp}.json`,
));
const generationScreenshotPath = path.resolve(process.argv[3] ?? path.join(
  evidenceDirectory,
  `p30-s3-unit-grid-generation-${timestamp}.png`,
));
const reviewScreenshotPath = path.resolve(process.argv[4] ?? path.join(
  evidenceDirectory,
  `p30-s3-unit-grid-review-${timestamp}.png`,
));

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function generationMutationCounts(state: Awaited<ReturnType<typeof getStudioGenerationLedgerState>>) {
  return {
    packs: state.counts.packs,
    dispatches: state.counts.dispatches,
    results: state.counts.results,
    plans: state.counts.plans,
    runEvents: state.counts.runEvents,
    callIntents: state.counts.callIntents,
    callEvents: state.counts.callEvents,
  };
}

async function absent(filePath: string): Promise<boolean> {
  return access(filePath).then(() => false, () => true);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配 Electron CDP 端口。"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForCdp(port: number, child: ChildProcess): Promise<string> {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`源码态 Electron 提前退出：exit=${child.exitCode}`);
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return endpoint;
    } catch {
      // Electron/Vite 尚在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("源码态 Electron CDP 90 秒内未就绪。");
}

async function stopProcessGroup(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || !child.pid || child.pid <= 1) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

function isExternalHttp(urlValue: string): boolean {
  try {
    const url = new URL(urlValue);
    return (url.protocol === "http:" || url.protocol === "https:")
      && !["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function screenshotEvidence(page: Page, outputPath: string): Promise<{
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  width: number;
  height: number;
  maxChannelStandardDeviation: number;
}> {
  const bytes = await page.screenshot({ type: "png", fullPage: false, animations: "disabled" });
  await writeFile(outputPath, bytes, { flag: "wx" });
  const [metadata, imageStats, fileStats] = await Promise.all([
    sharp(bytes).metadata(),
    sharp(bytes).stats(),
    stat(outputPath),
  ]);
  const standardDeviation = Math.max(...imageStats.channels.map((channel) => channel.stdev));
  if ((metadata.width ?? 0) < 1_400 || (metadata.height ?? 0) < 800
    || fileStats.size < 30_000 || standardDeviation < 5) {
    throw new Error(`Electron 截图疑似空白或占位：${path.basename(outputPath)}`);
  }
  return {
    relativePath: path.relative(workspace, outputPath).split(path.sep).join("/"),
    sha256: digest(bytes),
    sizeBytes: fileStats.size,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    maxChannelStandardDeviation: standardDeviation,
  };
}

for (const output of [evidencePath, generationScreenshotPath, reviewScreenshotPath]) {
  if (!await absent(output)) throw new Error(`证据路径已存在，拒绝覆盖：${output}`);
}
await mkdir(evidenceDirectory, { recursive: true });

const sourceBefore = await computeSourceDigest(workspace);
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "p30-s3-source-electron-"));
const userDataRoot = path.join(runtimeRoot, "electron-user-data");
await mkdir(userDataRoot, { recursive: true });
const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
let fixture: DuduReadonlySourceFixture | undefined;
let browser: Browser | undefined;
let devProcess: ChildProcess | undefined;
let success = false;
let generationScreenshot: Awaited<ReturnType<typeof screenshotEvidence>> | undefined;
let reviewScreenshot: Awaited<ReturnType<typeof screenshotEvidence>> | undefined;

try {
  fixture = await createDuduReadonlySourceFixture();
  process.env.AI_CANVAS_REGISTRY_PATH = fixture.registryPath;
  const inspection = await inspectDuduReadonlySources(fixture.source);
  const historicalUnitId = inspection.computedProjection.historicalStoryboardPassUnitIds[0];
  const bindingReadyPendingUnitIds = inspection.computedProjection.pendingStoryboardUnitIds
    .filter((unitId) => inspection.computedProjection.bindingReadyUnitIds.includes(unitId));
  const unknownUnitId = bindingReadyPendingUnitIds[0];
  const targetUnitId = bindingReadyPendingUnitIds[1];
  if (!historicalUnitId || !unknownUnitId || !targetUnitId) {
    throw new Error("Dudu fixture 缺少动态历史 PASS 或两个 binding-ready pending 单元。");
  }
  const unknownEvidenceReference = "fixture:p30-source-electron-detached-unknown";

  const staged = await stageDuduReadonlyManagedProject({
    projectsRoot: fixture.projectsRoot,
    source: fixture.source,
    detachedUnknownObservations: [{
      unitId: unknownUnitId,
      sourceTaskId: "p30-source-electron-stopped-task",
      evidenceReference: unknownEvidenceReference,
      evidenceFingerprint: digest(Buffer.from(unknownEvidenceReference, "utf8")),
      note: "隔离 fixture：模拟已停止任务留下的未知调用；只验证 UI/Core 防重，不代表正式 U 单元。",
    }],
  });
  const stagedControl = await getDuduReadonlyImportControl(staged.shell.paths.root);
  if (stagedControl.status !== "staging-verified") throw new Error(`Dudu staging 未闭合：${stagedControl.status}`);
  await finalizeDuduReadonlyManagedProject(staged.shell.paths.root, fixture.source);
  const activeControl = await getDuduReadonlyImportControl(staged.shell.paths.root);
  if (activeControl.status !== "active" || activeControl.nextAction !== "ready") {
    throw new Error(`Dudu active 投影未闭合：${activeControl.status}/${activeControl.nextAction}`);
  }

  const unknownReceipt = staged.receipt.units.find((unit) => unit.unitId === unknownUnitId);
  const targetReceipt = staged.receipt.units.find((unit) => unit.unitId === targetUnitId);
  const historicalReceipt = staged.receipt.units.find((unit) => unit.unitId === historicalUnitId);
  if (!unknownReceipt?.packId || !targetReceipt?.packId || !historicalReceipt?.packId) {
    throw new Error("动态目标或 unknown 单元缺少 unit-grid pack。 ");
  }
  const historicalHistory = await listStudioGenerationUnitGridHistory(staged.shell.paths.root, {
    unitId: historicalUnitId,
    order: "newest-first",
    limit: 24,
  });
  if (historicalHistory.items.length !== 0) throw new Error("历史导入单元不应伪造正式 result 历史。 ");

  const pack = await readStudioUnitGridGenerationFrozenPack(staged.shell.paths.root, targetReceipt.packId);
  if (!pack) throw new Error("动态目标 unit-grid pack 不可读。 ");

  const port = await freePort();
  const devLogs: string[] = [];
  devProcess = spawn(path.join(workspace, "node_modules", ".bin", "electron-vite"), [
    "--remoteDebuggingPort", String(port), "--", `--user-data-dir=${userDataRoot}`,
  ], {
    cwd: workspace,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: staged.shell.paths.root,
      AI_CANVAS_REGISTRY_PATH: fixture.registryPath,
      AI_CANVAS_MANAGED_PROJECTS_ROOT: fixture.projectsRoot,
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
    },
  });
  const collectLog = (chunk: Buffer) => {
    devLogs.push(chunk.toString("utf8"));
    if (devLogs.join("").length > 20_000) devLogs.splice(0, Math.max(1, devLogs.length - 8));
  };
  devProcess.stdout?.on("data", collectLog);
  devProcess.stderr?.on("data", collectLog);
  const cdpEndpoint = await waitForCdp(port, devProcess);
  browser = await chromium.connectOverCDP(cdpEndpoint);
  const browserContext = browser.contexts()[0];
  if (!browserContext) throw new Error("Electron CDP 未暴露默认 BrowserContext。 ");
  let page = browserContext.pages().find((candidate) => !candidate.url().startsWith("devtools:"));
  const pageDeadline = Date.now() + 30_000;
  while (!page && Date.now() < pageDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    page = browserContext.pages().find((candidate) => !candidate.url().startsWith("devtools:"));
  }
  if (!page) throw new Error("Electron 源码态 renderer 页面未创建。 ");
  page.setDefaultTimeout(45_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", (request) => { if (isExternalHttp(request.url())) externalRequests.push(request.url()); });

  const studio = page.locator('[data-testid="material-studio-view"]');
  await studio.waitFor();
  const initialText = await studio.innerText();
  if (!initialText.includes("《嘟嘟》S1E1 隔离受管工程")) throw new Error("源码态 Electron 未打开隔离 Dudu owner。 ");
  await page.locator('[data-testid="studio-step-generation"]').click();
  const generationControl = page.locator('[data-testid="studio-generation-control"]');
  await generationControl.waitFor();

  const historicalButton = generationControl.locator(`.unit-rail > button[data-unit-id="${historicalUnitId}"]`);
  await historicalButton.click();
  const historicalVideo = generationControl.locator('[data-testid="studio-video-package-control"]');
  await historicalVideo.filter({ hasText: "尚未建立视频包意图" }).waitFor();
  const historicalGenerationText = await generationControl.innerText();
  if (!historicalGenerationText.includes("整板冻结包可用")
    || historicalGenerationText.includes("尚无可核对的 unit-grid 生成包")) {
    throw new Error("零 result/零 plan 历史单元未从 Core readiness 恢复 pack。 ");
  }

  const unknownLedgerBefore = await getStudioGenerationLedgerState(staged.shell.paths.root);
  await generationControl.locator(`.unit-rail > button[data-unit-id="${unknownUnitId}"]`).click();
  const unknownBlock = generationControl.locator('[data-testid="studio-generation-unknown-block"]');
  await unknownBlock.waitFor();
  const unknownText = await unknownBlock.innerText();
  if (!unknownText.includes("generation_unknown") || !unknownText.includes("禁止再次派发、重试或生图")) {
    throw new Error("detached unknown 前端未显示明确防重锁定。");
  }
  if (!await generationControl.locator('[data-testid="studio-generation-open-review"]').isDisabled()) {
    throw new Error("detached unknown 单元的 Review 入口未禁用。");
  }
  await generationControl.locator('[data-testid="studio-generation-open-canvas"]').click();
  const managedCanvas = page.locator('[data-testid="managed-studio-canvas-view"]');
  await managedCanvas.waitFor();
  await managedCanvas.locator('[data-testid="managed-canvas-primary-start"]').click();
  await managedCanvas.locator(".canvas-error")
    .filter({ hasText: /generation_unknown|禁止再次冻结|禁止再次/u })
    .waitFor();
  const unknownLedgerAfter = await getStudioGenerationLedgerState(staged.shell.paths.root);
  if (JSON.stringify(generationMutationCounts(unknownLedgerAfter))
    !== JSON.stringify(generationMutationCounts(unknownLedgerBefore))) {
    throw new Error("detached unknown 点击开始后 generation ledger 发生增量。");
  }

  await page.locator('[data-testid="studio-step-generation"]').click();
  await generationControl.waitFor();
  const targetButton = generationControl.locator(`.unit-rail > button[data-unit-id="${targetUnitId}"]`);
  await targetButton.click();
  await generationControl.locator('[data-testid="studio-generation-open-canvas"]').click();
  await managedCanvas.waitFor();
  const targetLedgerBefore = await getStudioGenerationLedgerState(staged.shell.paths.root);
  await managedCanvas.locator('[data-testid="managed-canvas-primary-start"]').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="managed-canvas-workflow-run-summary"]')?.textContent?.includes("成功 1 · 失败 0") === true
  ));
  const targetLedgerAfterStart = await getStudioGenerationLedgerState(staged.shell.paths.root);
  if (targetLedgerAfterStart.counts.plans !== targetLedgerBefore.counts.plans + 1
    || targetLedgerAfterStart.counts.dispatches !== targetLedgerBefore.counts.dispatches + 1
    || targetLedgerAfterStart.counts.results !== targetLedgerBefore.counts.results
    || targetLedgerAfterStart.counts.callIntents !== targetLedgerBefore.counts.callIntents) {
    throw new Error("Canvas 开始未产生且仅产生一个 unit-grid plan/dispatch。");
  }
  const targetPlans = (await listStudioGenerationPlanProjections(staged.shell.paths.root, { limit: 36 }))
    .filter((candidate) => candidate.nodes.some((node) => (
      node.targetKind === "unit-grid" && node.unitId === targetUnitId
    )));
  const plan = targetPlans[0];
  const targetNode = plan?.nodes.find((node) => node.targetKind === "unit-grid" && node.unitId === targetUnitId);
  const generationRunId = targetNode?.generationRunId;
  if (!plan || plan.nodes.length !== 1 || !targetNode || targetNode.status !== "dispatched" || !generationRunId
    || targetNode.packId !== pack.id || targetNode.packFingerprint !== pack.fingerprint) {
    throw new Error("Canvas 开始后 unit-grid pack/plan/run 身份未闭合。");
  }

  const context = await getActiveManagedStudioContext();
  const call = await prepareStudioImagegenCall(staged.shell.paths.root, {
    projectContextToken: context.projectContextToken,
    packId: pack.id,
    packFingerprint: pack.fingerprint,
    generationRunId,
    provider: "codex",
    commandRequestId: "p30-s3-source-electron-fixture-call",
    expectedRevision: 0,
  });
  if (!call.callAllowed) throw new Error("隔离 fixture 首次 pre-call 未得到一次性授权。 ");

  const rawPath = path.join(runtimeRoot, "p30-s3-deterministic-unit-grid-raw.png");
  const fixtureSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1600" viewBox="0 0 900 1600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#17293f"/><stop offset="0.52" stop-color="#526b62"/><stop offset="1" stop-color="#b98956"/></linearGradient></defs><rect width="900" height="1600" fill="url(#g)"/><circle cx="300" cy="520" r="190" fill="#d5b078" fill-opacity=".72"/><path d="M90 1320 L450 780 L810 1320 Z" fill="#243d4d" fill-opacity=".88"/><rect x="110" y="110" width="680" height="1380" rx="26" fill="none" stroke="#f0d8ac" stroke-width="10" stroke-opacity=".6"/></svg>`, "utf8");
  await sharp(fixtureSvg).png({ compressionLevel: 9 }).toFile(rawPath);
  const rawBytes = await readFile(rawPath);
  const committed = await commitAgentImagegenResultBundle(staged.shell.paths.root, {
    projectContextToken: context.projectContextToken,
    packId: pack.id,
    packFingerprint: pack.fingerprint,
    generationRunId,
    provider: "codex",
    rawPath,
    rawSha256: digest(rawBytes),
    expectedRevision: pack.target.unitRevision,
    executionReceipt: {
      schemaVersion: 1,
      kind: "agent-imagegen-execution-receipt",
      provider: "codex",
      source: "fixture-canary",
      attestationLevel: "unverified-external-agent",
      cryptographicProviderReceipt: false,
      callId: call.callId,
      model: "deterministic-local-svg-fixture",
      generatedAt: new Date().toISOString(),
    },
  });
  const review = await submitStudioGenerationReview(staged.shell.paths.root, {
    operationId: "p30-s3-source-electron-fixture-review",
    generationRunId,
    kind: "observation",
    expectedHeadRevision: 0,
    rawResultId: committed.results.raw.resultId,
    rawSha256: committed.results.raw.mediaSha256,
    labeledResultId: committed.results.labeled.resultId,
    labeledSha256: committed.results.labeled.mediaSha256,
    expectedPackFingerprint: pack.fingerprint,
    continuityFingerprint: pack.continuityFingerprint,
    decision: "pass",
    criteria: [
      { code: "fixture-decode", status: "pass", note: "仅验证隔离软件链可解码。" },
      { code: "fixture-pair", status: "pass", note: "仅验证 raw/labeled 身份闭合。" },
    ],
    reviewer: "p30-source-electron-fixture",
    note: "确定性隔离 fixture；不代表真实 canary 或人工视觉验收。",
  });
  await prepareStudioVideoPackageExport(staged.shell.paths.root, {
    operationId: "p30-s3-source-electron-fixture-video-intent",
    authority: { kind: "studio-review", reviewId: review.reviewId },
    expectedRevision: pack.target.unitRevision,
  });
  const videoControl = await getStudioVideoPackageControl(staged.shell.paths.root, {
    by: "authority-latest",
    authority: { kind: "studio-review", reviewId: review.reviewId },
  });
  if (videoControl.status !== "resolved" || videoControl.control?.dynamicModelStatus !== "not-run") {
    throw new Error("隔离 fixture 视频包控制面未保持 dynamic-model not-run。 ");
  }

  await page.locator('[data-testid="studio-step-generation"]').click();
  await generationControl.waitFor();
  await generationControl.locator(`.unit-rail > button[data-unit-id="${targetUnitId}"]`).click();
  await page.waitForFunction(({ unitId }) => {
    const selected = document.querySelector(`.unit-rail > button[data-unit-id="${unitId}"]`);
    const reviewButton = document.querySelector('[data-testid="studio-generation-open-review"]') as HTMLButtonElement | null;
    return selected?.classList.contains("active")
      && document.querySelectorAll(".result-row").length >= 2
      && reviewButton?.disabled === false;
  }, { unitId: targetUnitId });
  // 视频包控制面在历史之后异步加载；等它真正落出 Core 投影再读全文，禁止竞态断言。
  await generationControl.locator('[data-testid="studio-video-package-control"]')
    .filter({ hasText: "动态视频模型：未运行" })
    .waitFor();
  await generationControl.locator('[data-testid="studio-video-package-authority-head"]').waitFor();
  const targetUnit = staged.receipt.units.find((unit) => unit.unitId === targetUnitId)!;
  const targetGenerationText = await generationControl.innerText();
  if (!targetGenerationText.includes(`整板 · ${targetUnitId}`)
    || !targetGenerationText.includes(`${targetUnit.durationSeconds} 秒 · ${targetUnit.panelCount} 宫格`)
    || !targetGenerationText.includes("原始图")
    || !targetGenerationText.includes("标注图")
    || !targetGenerationText.includes("权威头：")
    || !targetGenerationText.includes("仅机械状态")
    || !targetGenerationText.includes("动态视频模型：未运行")) {
    throw new Error("unit-grid 计划、真实时长、成对结果、权威头或视频 not-run 文案未闭合。 ");
  }

  const targetPlanNode = generationControl.locator(".plan-node").filter({ hasText: targetUnitId });
  await targetPlanNode.getByRole("button", { name: "定位结果" }).click();
  await page.locator('[data-testid="managed-studio-canvas-view"]').waitFor();
  // 定位结果必须把受管画布聚焦到目标单元内容：labeled 媒体节点居中入视口（画布按视口剔除渲染），
  // 且上下文行只显示真实单元状态；不得读 App.vue 旧画布诊断面。
  await managedCanvas.locator('.vue-flow__node[data-id^="media:labeled:"]').first().waitFor();
  await managedCanvas.locator(".canvas-context").filter({ hasText: "宫格" }).waitFor();
  await page.locator('[data-testid="studio-step-generation"]').click();
  await generationControl.waitFor();
  await generationControl.locator(`.unit-rail > button[data-unit-id="${targetUnitId}"]`).click();
  await generationControl.locator('[data-testid="studio-generation-open-review"]:not([disabled])').waitFor();
  generationScreenshot = await screenshotEvidence(page, generationScreenshotPath);

  await generationControl.locator('[data-testid="studio-generation-open-review"]').click();
  const reviewView = page.locator('[data-testid="studio-continuity-review-view"]');
  await reviewView.waitFor();
  await reviewView.locator('[data-testid="continuity-focused-scope"]').filter({ hasText: "整板生成结果" }).waitFor();
  await reviewView.locator('[data-testid="continuity-focused-scope"]').filter({ hasText: "连续性辅助范围" }).waitFor();
  try {
    await reviewView.locator('[data-testid="studio-review-workbench"]').waitFor({ timeout: 15_000 });
  } catch (reason) {
    const diagnostic = await reviewView.evaluate((element) => ({
      workbenchCount: element.querySelectorAll('[data-testid="studio-review-workbench"]').length,
      mediaState: element.querySelector(".media-state")?.textContent ?? null,
      errorRole: element.querySelector('[role="alert"]')?.textContent ?? null,
      loaderCount: element.querySelectorAll("[data-review-request]").length,
      text: (element as HTMLElement).innerText.slice(0, 600),
    }));
    throw new Error(`review workbench 未渲染诊断：${JSON.stringify(diagnostic)}`, { cause: reason });
  }
  await reviewView.filter({ hasText: "raw/labeled 已加载并通过浏览器解码" }).waitFor();
  reviewScreenshot = await screenshotEvidence(page, reviewScreenshotPath);

  const resourceUrls = await page.evaluate(() => performance.getEntriesByType("resource")
    .map((entry) => (entry as PerformanceResourceTiming).name));
  externalRequests.push(...resourceUrls.filter(isExternalHttp));
  if (pageErrors.length || consoleErrors.length || externalRequests.length) {
    throw new Error(`源码态 Electron 出现 renderer/外网错误：${JSON.stringify({
      pageErrors,
      consoleErrors,
      externalRequests,
    })}`);
  }

  const targetHistory = await listStudioGenerationUnitGridHistory(staged.shell.paths.root, {
    unitId: targetUnitId,
    order: "newest-first",
    limit: 24,
  });
  if (targetHistory.items.length !== 2
    || targetHistory.items.some((item) => "panelId" in item || "panelIndex" in item)) {
    throw new Error("unit-grid 公开结果历史未保持两项且物理省略 panel 兼容锚点。 ");
  }
  const ledger = await getStudioGenerationLedgerState(staged.shell.paths.root);
  const sourceAfterUi = await computeSourceDigest(workspace);
  if (sourceAfterUi.sourceDigest !== sourceBefore.sourceDigest) {
    throw new Error("源码态 Electron 旅程期间产品源码发生漂移。 ");
  }

  await browser.close();
  browser = undefined;
  await stopProcessGroup(devProcess);
  devProcess = undefined;
  const fixtureRoot = fixture.root;
  await fixture.cleanup();
  fixture = undefined;
  await rm(runtimeRoot, { recursive: true, force: true });
  if (!await absent(fixtureRoot) || !await absent(runtimeRoot)) throw new Error("隔离 fixture/runtime 未清理。 ");
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;

  const sourceAfterCleanup = await computeSourceDigest(workspace);
  if (sourceAfterCleanup.sourceDigest !== sourceBefore.sourceDigest) throw new Error("清理后源码摘要漂移。 ");
  const evidence = {
    schemaVersion: 1,
    kind: "p30-s3-unit-grid-source-electron-smoke",
    status: "pass",
    createdAt: new Date().toISOString(),
    source: {
      mode: "electron-vite-dev",
      before: sourceBefore,
      after: sourceAfterCleanup,
      stable: true,
    },
    duduFixture: {
      isolated: true,
      projectId: staged.shell.project.id,
      importFingerprint: staged.receipt.fingerprint,
      activeStatus: activeControl.status,
      counts: activeControl.counts,
      historicalUnit: {
        unitId: historicalUnitId,
        resultCount: historicalHistory.items.length,
        planCountForUnit: 0,
        packRecoveredFromCoreReadiness: true,
        videoControlStatus: "not-prepared",
      },
      fixtureResultUnit: {
        unitId: targetUnitId,
        durationSeconds: targetUnit.durationSeconds,
        panelCount: targetUnit.panelCount,
        planId: plan.planId,
        generationRunId,
        packId: pack.id,
        rawResultId: committed.results.raw.resultId,
        labeledResultId: committed.results.labeled.resultId,
        pairComplete: committed.results.raw.pairComplete && committed.results.labeled.pairComplete,
        reviewId: review.reviewId,
        reviewDecision: review.decision,
        publicPanelCompatibilityFieldsExposed: false,
      },
      ledgerCounts: ledger.counts,
    },
    ui: {
      projectOpened: true,
      historicalZeroResultRestartRecovered: true,
      unitGridPlanVisible: true,
      actualDurationVisible: true,
      rawLabeledVisible: true,
      locateResultToUnitNode: true,
      reviewTargetLabel: "整板生成结果",
      continuityScopeExplicitlyAuxiliary: true,
      reviewPairDecoded: true,
      dynamicVideoModelStatus: "not-run",
      pageErrors: 0,
      consoleErrors: 0,
      externalRequests: 0,
    },
    screenshots: {
      generation: generationScreenshot,
      review: reviewScreenshot,
    },
    boundaries: {
      temporaryFixtureOnly: true,
      isolatedRegistry: true,
      isolatedUserData: true,
      formalProjectReads: 0,
      formalProjectWrites: 0,
      imagegenCalls: 0,
      deterministicFixtureImportOnly: true,
      humanVisualAcceptanceClaimed: false,
      videoBuilderInvocations: 0,
      dynamicVideoModelCalls: 0,
      uploads: 0,
      installs: 0,
      applicationsAppTouched: false,
      fixtureCleaned: true,
      runtimeCleaned: true,
    },
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  success = true;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    evidencePath,
    generationScreenshotPath,
    reviewScreenshotPath,
    sourceDigest: sourceAfterCleanup.sourceDigest,
    historicalUnitId,
    targetUnitId,
  }, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => undefined);
  await stopProcessGroup(devProcess).catch(() => undefined);
  await fixture?.cleanup().catch(() => undefined);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
  if (!success) {
    await Promise.all([
      rm(evidencePath, { force: true }),
      rm(generationScreenshotPath, { force: true }),
      rm(reviewScreenshotPath, { force: true }),
    ]).catch(() => undefined);
  }
}
