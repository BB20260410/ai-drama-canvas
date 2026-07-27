/**
 * P14 安装版真实 canary UI 审片验收。
 *
 * 本脚本不生图、不创建 fixture，只消费已经完成原子 raw/labeled 写回的 canary-state.json。
 * decision 是调用主 Agent显式传入的受授权决定；脚本只验证机械可解码、UI 可见、
 * UI owner 写回及重启持久性，不推断视觉质量，也不声称用户亲自确认。
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright";
import sharp from "sharp";
import { getStudioMedia } from "../src/core/material-studio.js";
import { inspectManagedProject } from "../src/core/managed-project.js";
import { readReleaseManifest } from "../src/core/release-manifest.js";
import { getActiveProjectRegistration, writeJsonAtomic } from "../src/core/sidecar.js";
import { readStudioGenerationResultBundle } from "../src/core/studio-generation-ledger.js";
import {
  getStudioGenerationReviewControl,
} from "../src/core/studio-generation-review.js";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.js";
import {
  verifyP14RealCanaryAuthorities,
  type P14CanaryState,
} from "./p14-real-canary-orchestrator.js";
import {
  assertP14CanaryOutputsOutsideRun,
  assertP14InstalledRealCanaryUiEvidence,
  assertP14PendingRealCanaryState,
  P14_INSTALLED_REAL_CANARY_SCREENSHOTS,
  p14CanaryStateDigest,
  parseP14InstalledRealCanaryUiCli,
  sealP14CanaryState,
  type P14InstalledRealCanaryScreenshotEvidence,
  type P14InstalledRealCanaryUiEvidence,
} from "./p14-installed-real-canary-ui-guards.js";

const cli = parseP14InstalledRealCanaryUiCli(process.argv.slice(2));
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const formalProjectRoot = path.join(workspaceRoot, "projects", "codex-ai-drama-studio");

const executableStats = await stat(cli.executablePath).catch(() => null);
if (!executableStats?.isFile()) throw new Error(`安装版可执行文件不存在或不是普通文件：${cli.executablePath}`);
await access(cli.executablePath, constants.X_OK).catch(() => {
  throw new Error(`安装版可执行文件不可执行：${cli.executablePath}`);
});
for (const output of [cli.evidencePath, cli.screenshotDirectory]) {
  if (await access(output).then(() => true, () => false)) throw new Error(`输出已存在，拒绝覆盖：${output}`);
}

const stateValue = JSON.parse(await readFile(cli.statePath, "utf8")) as unknown;
assertP14PendingRealCanaryState(stateValue, cli.statePath, formalProjectRoot);
const state: P14CanaryState = stateValue;
assertP14CanaryOutputsOutsideRun(state, cli.evidencePath, cli.screenshotDirectory, formalProjectRoot);
const initialStateFingerprint = state.fingerprint;

const appMarker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
const appBundleRoot = cli.executablePath.slice(0, cli.executablePath.indexOf(appMarker));
const releaseManifest = await readReleaseManifest(path.join(appBundleRoot, "Contents", "Resources", "release-manifest.json"));
const prepareEvidence = JSON.parse(await readFile(state.prepareEvidencePath, "utf8")) as {
  activeContext?: { sourceDigest?: string; buildId?: string };
};
if (prepareEvidence.activeContext?.sourceDigest !== releaseManifest.sourceDigest) {
  throw new Error(`安装版 sourceDigest 与 canary prepare 不一致：installed=${releaseManifest.sourceDigest} canary=${prepareEvidence.activeContext?.sourceDigest ?? "(missing)"}`);
}

const shell = await inspectManagedProject(state.project.root);
if (shell.project.id !== state.project.id || shell.manifestFingerprint !== state.project.manifestFingerprint) {
  throw new Error("canary 工程 projectId 或 manifest fingerprint 与 state 不一致。");
}
const authorityVerification = await verifyP14RealCanaryAuthorities(state);
const targetUnit = await getStudioProductionUnitSnapshot(state.project.root, state.target.unitId);
if (!targetUnit || targetUnit.unit.revision !== state.target.unitRevision
  || !targetUnit.panels.some((panel) => panel.id === state.target.panelId)) {
  throw new Error("canary 目标单元、revision 或宫格已漂移。");
}
const bundle = await readStudioGenerationResultBundle(state.project.root, state.generationRunId);
if (!bundle || !state.finalization || bundle.fingerprint !== state.finalization.bundle.fingerprint
  || !bundle.pairComplete || bundle.raw.mediaSha256 !== state.finalization.rawSha256
  || bundle.labeled.mediaSha256 !== state.finalization.bundle.labeled.mediaSha256) {
  throw new Error("canary raw/labeled bundle 与 state 不一致。");
}
const beforeReview = await getStudioGenerationReviewControl(state.project.root, state.generationRunId);
if (beforeReview.status !== "unreviewed" || beforeReview.headRevision !== 0 || beforeReview.head) {
  throw new Error("canary 已存在 Review Head，拒绝重复或改绑显式 decision。");
}

interface DecodedMedia {
  sha256: string;
  width: number;
  height: number;
  sizeBytes: number;
  format: string;
}

async function decodeStudioImage(sha256: string, label: string): Promise<DecodedMedia> {
  const media = await getStudioMedia(state.project.root, sha256);
  if (!media || media.kind !== "image") throw new Error(`${label} 不存在或不是 image：${sha256}`);
  const bytes = await readFile(media.objectPath);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`${label} CAS SHA 漂移。`);
  const metadata = await sharp(bytes, { failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error(`${label} 无法解码出有效尺寸。`);
  return { sha256, width: metadata.width, height: metadata.height, sizeBytes: bytes.length, format: metadata.format };
}

const [rawDecoded, labeledDecoded] = await Promise.all([
  decodeStudioImage(bundle.raw.mediaSha256, "raw"),
  decodeStudioImage(bundle.labeled.mediaSha256, "labeled"),
]);

const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = state.registryPath;
const registeredActive = await getActiveProjectRegistration();
if (!registeredActive || registeredActive.id !== state.project.id
  || path.resolve(registeredActive.primaryRoot) !== path.resolve(state.project.root)) {
  throw new Error("独立 registry 的显式活动工程与 canary state 不一致，拒绝猜测其他工程。");
}

await mkdir(path.dirname(cli.evidencePath), { recursive: true });
await mkdir(path.dirname(cli.screenshotDirectory), { recursive: true });
await mkdir(cli.screenshotDirectory);
const temporaryRuntime = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p14-real-canary-ui-"));
const homeRoot = path.join(temporaryRuntime, "home");
const tempRoot = path.join(temporaryRuntime, "tmp");
const userDataRoot = path.join(temporaryRuntime, "electron-user-data");
const mediaRuntimeRoot = path.join(temporaryRuntime, "media-runtime");
await Promise.all([homeRoot, tempRoot, userDataRoot, mediaRuntimeRoot].map((directory) => mkdir(directory, { recursive: true })));

const screenshots: P14InstalledRealCanaryScreenshotEvidence[] = [];
const pageErrors: string[] = [];
const consoleErrors: string[] = [];
const externalRequests: string[] = [];
let application: ElectronApplication | undefined;
let applicationClosed = false;
let temporaryRuntimeRemoved = false;

function absent(candidate: string): Promise<boolean> {
  return access(candidate).then(() => false, () => true);
}

async function writeExclusiveAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await link(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function capture(page: Page, fileName: typeof P14_INSTALLED_REAL_CANARY_SCREENSHOTS[number]): Promise<void> {
  const screenshotPath = path.join(cli.screenshotDirectory, fileName);
  if (!(await absent(screenshotPath))) throw new Error(`截图已存在，拒绝覆盖：${screenshotPath}`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const bytes = await readFile(screenshotPath);
  const [metadata, imageStats, fileStats] = await Promise.all([sharp(bytes).metadata(), sharp(bytes).stats(), stat(screenshotPath)]);
  const evidence = {
    fileName,
    path: screenshotPath,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    sizeBytes: fileStats.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    maxChannelStandardDeviation: Math.max(...imageStats.channels.map((channel) => channel.stdev)),
  } satisfies P14InstalledRealCanaryScreenshotEvidence;
  if (evidence.width < 1_200 || evidence.height < 700 || evidence.sizeBytes < 20_000
    || evidence.maxChannelStandardDeviation < 3) throw new Error(`截图疑似空白或占位：${JSON.stringify(evidence)}`);
  screenshots.push(evidence);
}

function observe(page: Page): void {
  page.setDefaultTimeout(120_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", (request) => { if (/^https?:/iu.test(request.url())) externalRequests.push(request.url()); });
}

async function launch(): Promise<{ application: ElectronApplication; page: Page }> {
  const launched = await electron.launch({
    executablePath: cli.executablePath,
    args: [`--user-data-dir=${userDataRoot}`],
    cwd: state.runRoot,
    env: {
      ...process.env,
      HOME: homeRoot,
      TMPDIR: tempRoot,
      AI_CANVAS_REGISTRY_PATH: state.registryPath,
      AI_CANVAS_MEDIA_RUNTIME_DIR: mediaRuntimeRoot,
      AI_CANVAS_PROJECT_ROOT: state.project.root,
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const page = await launched.firstWindow();
  observe(page);
  await page.setViewportSize({ width: 1728, height: 1029 });
  return { application: launched, page };
}

async function waitCanaryProject(page: Page): Promise<void> {
  await page.locator('[data-testid="material-studio-view"]').waitFor();
  await page.waitForFunction((expectedProjectName) => {
    const view = document.querySelector('[data-testid="material-studio-view"]');
    return view?.getAttribute("aria-busy") === "false"
      && document.body.innerText.includes(String(expectedProjectName));
  }, shell.project.name);
  const active = await page.evaluate(async () => {
    const bridge = (window as unknown as {
      canvasApi: { getActiveProject(): Promise<{ id: string; primaryRoot: string; available: boolean } | null> };
    }).canvasApi;
    return bridge.getActiveProject();
  });
  if (!active?.available || active.id !== state.project.id || path.resolve(active.primaryRoot) !== path.resolve(state.project.root)) {
    throw new Error(`安装版活动工程不是 canary：${JSON.stringify(active)}`);
  }
}

interface OpenedReview {
  reviewWorkbench: Locator;
  nodeStatusText: string;
}

async function openTargetReview(page: Page, captureCanvasNodes: boolean): Promise<OpenedReview> {
  await waitCanaryProject(page);
  await page.locator('[data-testid="studio-mode-canvas"]').click();
  const canvas = page.locator('[data-testid="managed-studio-canvas-view"]');
  await canvas.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="managed-studio-canvas-view"]')?.getAttribute("aria-busy") === "false");
  const fitView = page.locator(".vue-flow__controls-fitview");
  if (await fitView.count()) await fitView.click();
  const unitNode = page.locator(`[data-id="unit:${state.target.unitId}"]`);
  await unitNode.waitFor();
  await unitNode.click();
  if (await fitView.count()) await fitView.click();
  const rawNode = page.locator(`[data-id="media:raw:${state.target.panelId}"]`);
  const labeledNode = page.locator(`[data-id="media:labeled:${state.target.panelId}"]`);
  const reviewNode = page.locator(`[data-id="media:review:${state.target.panelId}"]`);
  await Promise.all([rawNode.waitFor(), labeledNode.waitFor(), reviewNode.waitFor()]);
  if (!(await rawNode.innerText()).includes("原始生成图") || !(await labeledNode.innerText()).includes("中文标注图")) {
    throw new Error("真实 canary 画布没有投影 raw/labeled 结果节点。");
  }
  const nodeStatusText = await reviewNode.innerText();
  if (captureCanvasNodes) await capture(page, "01-canvas-result-nodes.png");
  await reviewNode.click();
  const reviewWorkbench = page.locator('[data-testid="studio-review-workbench"]');
  await reviewWorkbench.waitFor();
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll('[data-testid="studio-review-workbench"] img'));
    return images.length === 2 && images.every((image) => image instanceof HTMLImageElement
      && image.complete && image.naturalWidth > 0 && image.getBoundingClientRect().width > 0 && image.getBoundingClientRect().height > 0);
  });
  return { reviewWorkbench, nodeStatusText };
}

const reviewNote = `主 Agent按显式 CLI decision=${cli.decision} 执行受授权桌面 UI 审片；未声明用户亲自确认；脚本只验证 raw/labeled 可解码与界面可见，不推断视觉质量。`;
const decisionLabels = { pass: "通过", rework: "返工", reject: "拒绝" } as const;
const restartNodeLabels = { pass: "已通过", rework: "需返工", reject: "已拒绝" } as const;

try {
  let launched = await launch();
  application = launched.application;
  let page = launched.page;
  const pendingReview = await openTargetReview(page, true);
  if (!pendingReview.nodeStatusText.includes("待审片")) throw new Error(`提交前 Review 节点不是待审片：${pendingReview.nodeStatusText}`);
  await pendingReview.reviewWorkbench.scrollIntoViewIfNeeded();
  await capture(page, "02-review-before-decision.png");
  await pendingReview.reviewWorkbench.locator("textarea").fill(reviewNote);
  await pendingReview.reviewWorkbench.getByRole("button", { name: decisionLabels[cli.decision], exact: true }).click();
  await page.waitForFunction((label) => {
    const view = document.querySelector('[data-testid="studio-continuity-review-view"]');
    const current = document.querySelector(".review-head strong")?.textContent?.trim();
    return view?.getAttribute("aria-busy") === "false" && current === label;
  }, decisionLabels[cli.decision]);
  await capture(page, "03-review-after-decision.png");

  const afterDecision = await getStudioGenerationReviewControl(state.project.root, state.generationRunId);
  const submittedHead = afterDecision.head;
  if (afterDecision.status !== cli.decision || afterDecision.headRevision !== 1 || !submittedHead?.current
    || submittedHead.reviewer !== "user" || submittedHead.note !== reviewNote) {
    throw new Error(`UI owner Review Head 不符合显式 decision：${JSON.stringify(afterDecision)}`);
  }

  await application.close();
  application = undefined;
  launched = await launch();
  application = launched.application;
  page = launched.page;
  const reopened = await openTargetReview(page, false);
  if (!reopened.nodeStatusText.includes(restartNodeLabels[cli.decision])) {
    throw new Error(`重启后 Review 节点未保持 ${cli.decision}：${reopened.nodeStatusText}`);
  }
  await page.waitForFunction((label) => document.querySelector(".review-head strong")?.textContent?.trim() === label, decisionLabels[cli.decision]);
  await capture(page, "04-review-after-restart.png");
  const afterRestart = await getStudioGenerationReviewControl(state.project.root, state.generationRunId);
  const restartedHead = afterRestart.head;
  if (afterRestart.status !== cli.decision || restartedHead?.fingerprint !== submittedHead.fingerprint
    || afterRestart.headRevision !== afterDecision.headRevision) throw new Error("重启后 Review Head 发生漂移。");
  if (pageErrors.length || consoleErrors.length || externalRequests.length) {
    throw new Error(`真实 canary UI 出现 renderer 错误或外网请求：${JSON.stringify({ pageErrors, consoleErrors, externalRequests })}`);
  }

  await application.close();
  application = undefined;
  applicationClosed = true;
  await rm(temporaryRuntime, { recursive: true, force: true });
  temporaryRuntimeRemoved = await absent(temporaryRuntime);

  const latestStateValue = JSON.parse(await readFile(cli.statePath, "utf8")) as unknown;
  assertP14PendingRealCanaryState(latestStateValue, cli.statePath, formalProjectRoot);
  const latestState = latestStateValue as P14CanaryState;
  if (latestState.fingerprint !== initialStateFingerprint) throw new Error("UI 审片期间 canary-state 被并发修改。");
  const reviewEvidencePath = path.join(state.runRoot, "installed-ui-review-evidence.json");
  if (!(await absent(reviewEvidencePath))) throw new Error(`canary UI Review 证据已存在，拒绝覆盖：${reviewEvidencePath}`);
  const reviewedAt = new Date().toISOString();
  const { fingerprint: _fingerprint, ...priorState } = latestState;
  const reviewedState = sealP14CanaryState({
    ...priorState,
    phase: "reviewed",
    updatedAt: reviewedAt,
    review: {
      decision: cli.decision,
      review: restartedHead,
      evidencePath: reviewEvidencePath,
      authorization: {
        actor: "main-agent",
        source: "explicit-cli-decision",
        userConfirmationClaimed: false,
        ledgerReviewer: "user",
      },
    },
  });
  const internalEvidenceBody = {
    schemaVersion: 1,
    kind: "p14-installed-real-canary-ui-review-evidence",
    status: "review-head-verified",
    createdAt: reviewedAt,
    statePath: cli.statePath,
    initialStateFingerprint,
    reviewedStateFingerprint: reviewedState.fingerprint,
    project: state.project,
    generationRunId: state.generationRunId,
    decision: cli.decision,
    reviewId: restartedHead.reviewId,
    reviewFingerprint: restartedHead.fingerprint,
    ledgerReviewer: restartedHead.reviewer,
    authority: {
      actor: "main-agent",
      source: "explicit-cli-decision",
      userConfirmationClaimed: false,
      ledgerReviewerMeaning: "desktop UI owner routing label; not evidence that the user personally clicked",
      visualQualityInferredByScript: false,
    },
  };
  await writeExclusiveAtomic(reviewEvidencePath, {
    ...internalEvidenceBody,
    fingerprint: p14CanaryStateDigest(internalEvidenceBody),
  });
  await writeJsonAtomic(cli.statePath, reviewedState);
  const persistedState = JSON.parse(await readFile(cli.statePath, "utf8")) as P14CanaryState;
  if (persistedState.fingerprint !== reviewedState.fingerprint || persistedState.phase !== "reviewed"
    || persistedState.review?.review.fingerprint !== restartedHead.fingerprint
    || persistedState.review.authorization?.userConfirmationClaimed !== false) {
    throw new Error("UI Review 后 canary-state reviewed 转移未精确读回。");
  }

  const evidence = {
    schemaVersion: 1,
    kind: "p14-installed-real-canary-review-ui-smoke",
    status: "pass",
    createdAt: new Date().toISOString(),
    decision: cli.decision,
    authority: {
      actor: "main-agent",
      source: "explicit-cli-decision",
      userConfirmationClaimed: false,
      visualQualityInferredByScript: false,
    },
    runtime: {
      executablePath: cli.executablePath,
      release: {
        version: releaseManifest.version,
        sourceDigest: releaseManifest.sourceDigest,
        buildId: releaseManifest.buildId,
        mcpToolCount: releaseManifest.mcpToolCount,
        distribution: releaseManifest.distribution,
      },
    },
    canary: {
      statePath: cli.statePath,
      initialStateFingerprint,
      reviewedStateFingerprint: reviewedState.fingerprint,
      projectId: state.project.id,
      manifestFingerprint: state.project.manifestFingerprint,
      generationRunId: state.generationRunId,
      packFingerprint: state.pack.fingerprint,
      reviewId: restartedHead.reviewId,
      reviewFingerprint: restartedHead.fingerprint,
      ledgerReviewer: restartedHead.reviewer,
      internalReviewEvidencePath: reviewEvidencePath,
      authorityReferences: state.authorityReferences,
    },
    mechanicalMedia: { raw: rawDecoded, labeled: labeledDecoded },
    assertions: {
      stateFingerprintValidated: true,
      pendingReviewPhaseValidated: true,
      projectManifestMatched: true,
      activeRegistryProjectMatched: true,
      installedBuildMatchedCanary: true,
      realAuthorityReferencesValidated: true,
      authoritySourcesUnchanged: authorityVerification.authoritySourcesUnchanged,
      primaryAuthoritiesCurrent: authorityVerification.primaryAuthoritiesCurrent,
      packReferencesMatched: authorityVerification.packReferencesMatched,
      continuityReferencesMatched: authorityVerification.continuityReferencesMatched,
      fixtureAuthoritiesExcluded: authorityVerification.fixtureAuthoritiesExcluded,
      goldenMaskDefinitionLocked: authorityVerification.goldenMaskDefinitionLocked,
      rawDecoded: true,
      labeledDecoded: true,
      rawAndLabeledVisible: true,
      canvasResultNodesVisible: true,
      oneClickOpenedReview: true,
      decisionSubmittedThroughUiOwner: true,
      explicitCliDecisionRecorded: true,
      reviewHeadMatchedDecision: true,
      reviewPersistedAfterRestart: true,
    },
    ui: {
      note: reviewNote,
      beforeStatus: beforeReview.status,
      afterStatus: afterDecision.status,
      afterRestartStatus: afterRestart.status,
      pageErrors,
      consoleErrors,
    },
    isolation: {
      canaryProjectOnly: true,
      formalProjectOpened: false,
      formalProjectWrites: 0,
      externalRequests: externalRequests.length,
      agentRepairClicks: 0,
      imageGenerationCalls: 0,
    },
    screenshots,
    terminal: {
      applicationClosed,
      temporaryRuntimeRemoved,
      reviewPersistedAfterRestart: true,
    },
    boundaries: {
      imageGeneratedByScript: false,
      fixtureCreatedByScript: false,
      userPersonallyClickedClaimed: false,
      mechanicalDecodeEqualsVisualApproval: false,
      agentConfigurationMutated: false,
      browserUsed: false,
      uploads: 0,
      gitActions: 0,
    },
  } satisfies P14InstalledRealCanaryUiEvidence;
  assertP14InstalledRealCanaryUiEvidence(evidence);
  await writeExclusiveAtomic(cli.evidencePath, evidence);
  process.stdout.write(`${JSON.stringify({ ok: true, evidencePath: cli.evidencePath, screenshotDirectory: cli.screenshotDirectory, decision: cli.decision, reviewedStateFingerprint: reviewedState.fingerprint }, null, 2)}\n`);
} finally {
  await application?.close().catch(() => undefined);
  await rm(temporaryRuntime, { recursive: true, force: true }).catch(() => undefined);
  // 失败截图是部分证据；调用方目录只要求全新，不做递归清理或覆盖。
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
}
