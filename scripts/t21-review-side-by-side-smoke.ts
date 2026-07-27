/**
 * T21 审片并排布局 Electron 真实验证（复用既有 out/ 构建产物）。
 *
 * 验证目标：隔离夹具工程完成一次 raw+labeled commit 后打开 Review workbench，
 * 断言 compareMode=并排 双图同时渲染且按媒体真实尺寸解码（naturalWidth/naturalHeight
 * 等于 commit 回执里的真实宽高，非缩略图），切换 A/B、擦除、差分各模式无 renderer
 * 错误，四个模式各留一张经 sharp 方差校验的防空白截图。
 *
 * 边界（与 P30 骨架一致）：
 *  - 仅使用临时《嘟嘟》隔离夹具、隔离 registry/userData 与确定性本地 SVG 位图；
 *    不调用 imagegen、外部供应商或动态视频模型，不读/写正式受管工程，不制作安装包。
 *  - 唯一 UI 写操作（画布“开始”）只落在 /tmp 隔离夹具工程，不触真实受管工程。
 *  - 证据（报告 JSON + 四张模式截图）一律 flag:"wx" 写入
 *    .planning/2026-07-24-infinite-canvas-unified-remediation/evidence/t21/，拒绝覆盖。
 *  - 与 t23-layer4 验证进程互斥：启动 Electron 前等待其退出，避免双窗口竞态。
 *
 * 退出码：0=全部断言 PASS；1=断言失败（报告照常落盘并标注 FAIL 项）；2=前置错误。
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import {
  finalizeDuduReadonlyManagedProject,
  getDuduReadonlyImportControl,
  stageDuduReadonlyManagedProject,
} from "../src/core/dudu-readonly-import.js";
import { inspectDuduReadonlySources } from "../src/core/dudu-readonly-source.js";
import { commitAgentImagegenResultBundle } from "../src/core/studio-agent-imagegen-result-bundle.js";
import {
  listStudioGenerationPlanProjections,
  prepareStudioImagegenCall,
  readStudioUnitGridGenerationFrozenPack,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import {
  createDuduReadonlySourceFixture,
  type DuduReadonlySourceFixture,
} from "../tests/helpers/dudu-readonly-source-fixture.js";
import {
  assertBuildArtifacts,
  captureScreenshotEvidence,
  isExternalHttp,
  launchBuiltElectron,
  type LaunchedUi,
  type ScreenshotEvidence,
} from "./lib/t23-project-ui-verify-shared.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = path.join(
  workspace,
  ".planning",
  "2026-07-24-infinite-canvas-unified-remediation",
  "evidence",
  "t21",
);
const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
const reportPath = path.join(evidenceDirectory, `t21-review-side-by-side-${timestamp}.json`);
const screenshotPaths = {
  sideBySide: path.join(evidenceDirectory, `t21-compare-side-by-side-${timestamp}.png`),
  ab: path.join(evidenceDirectory, `t21-compare-ab-${timestamp}.png`),
  wipe: path.join(evidenceDirectory, `t21-compare-wipe-${timestamp}.png`),
  difference: path.join(evidenceDirectory, `t21-compare-difference-${timestamp}.png`),
} as const;

/** 与另一个 Electron 验证进程互斥的等待上限：30 分钟。 */
const T23_WAIT_DEADLINE_MS = 30 * 60 * 1_000;
const T23_PROCESS_PATTERN = "t23-layer4-project-ui-verify";

class PreconditionError extends Error {}

interface CheckRecord {
  name: string;
  status: "pass" | "fail";
  durationMs: number;
  detail?: string;
}

interface ImageDecodeState {
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
}

const assertions: CheckRecord[] = [];
const screenshots: Partial<Record<keyof typeof screenshotPaths, ScreenshotEvidence & { relativePath: string }>> = {};

function relativeToWorkspace(filePath: string): string {
  return path.relative(workspace, filePath).split(path.sep).join("/");
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function absent(filePath: string): Promise<boolean> {
  return access(filePath).then(() => false, () => true);
}

/** pgrep 命中即视为仍在运行；脚本名不含该模式，不会自匹配。 */
function t23StillRunning(): boolean {
  try {
    execSync(`pgrep -f ${T23_PROCESS_PATTERN}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function waitForT23Exit(): Promise<void> {
  const deadline = Date.now() + T23_WAIT_DEADLINE_MS;
  let waited = false;
  while (t23StillRunning()) {
    if (Date.now() > deadline) {
      throw new PreconditionError(`等待 ${T23_PROCESS_PATTERN} 退出超过 30 分钟，为避免双窗口竞态放弃启动。`);
    }
    if (!waited) {
      process.stdout.write(`检测到 ${T23_PROCESS_PATTERN} 仍在运行，每 5 秒轮询等待其退出…\n`);
      waited = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (waited) {
    // 退出后短暂静置，避免窗口/锁残留竞态。
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/** 把包装错误的 details（FreezeError 等）与 cause 链全部展开，避免只看最外层消息。 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  const details = (error as { details?: unknown }).details;
  if (Array.isArray(details) && details.length) parts.push(`details=${JSON.stringify(details)}`);
  let cause: unknown = (error as { cause?: unknown }).cause;
  while (cause instanceof Error) {
    parts.push(`cause=${cause.message}`);
    const inner = (cause as { details?: unknown }).details;
    if (Array.isArray(inner) && inner.length) parts.push(`cause.details=${JSON.stringify(inner)}`);
    cause = (cause as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

/**
 * 与常驻 Electron 进程共用同一工程 sqlite（WAL 单写者）：派发后 App 侧 watcher/outbox
 * 仍可能短暂持有写事务，脚本侧 Core 写调用偶发 "database is locked"。
 * 三个调用都按 operationId/commandRequestId/generationRunId 幂等，有限退避重试安全。
 */
async function withSqliteRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!describeError(error).includes("database is locked")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
  throw lastError;
}

async function check(name: string, fn: () => Promise<void>): Promise<boolean> {
  const startedAt = performance.now();
  try {
    await fn();
    assertions.push({ name, status: "pass", durationMs: Math.round(performance.now() - startedAt) });
    process.stdout.write(`PASS ${name}\n`);
    return true;
  } catch (error) {
    const detail = describeError(error);
    assertions.push({
      name,
      status: "fail",
      durationMs: Math.round(performance.now() - startedAt),
      detail,
    });
    process.stdout.write(`FAIL ${name}: ${detail}\n`);
    return false;
  }
}

async function main(): Promise<number> {
  const overallStartedAt = performance.now();
  let status: "pass" | "fail" | "precondition-error" = "fail";
  let preconditionError = "";
  let fixture: DuduReadonlySourceFixture | undefined;
  let launched: LaunchedUi | undefined;
  let runtimeRoot = "";
  const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
  let restoreDisableWriteLease: (() => void) | undefined;
  const target: Record<string, unknown> = {};
  let fixtureCleaned = false;
  const renderer = {
    pageErrors: [] as string[],
    consoleErrors: [] as string[],
    externalRequests: [] as string[],
  };

  const writeReport = async (): Promise<void> => {
    await mkdir(evidenceDirectory, { recursive: true });
    const report = {
      schemaVersion: 1,
      kind: "t21-review-side-by-side-smoke",
      status,
      createdAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - overallStartedAt),
      mode: "electron-build-out",
      preconditionError: preconditionError || undefined,
      target,
      assertions,
      screenshots,
      renderer: {
        pageErrors: renderer.pageErrors,
        consoleErrors: renderer.consoleErrors,
        externalRequests: renderer.externalRequests,
      },
      boundaries: {
        temporaryFixtureOnly: true,
        isolatedRegistry: true,
        isolatedUserData: true,
        formalProjectReads: 0,
        formalProjectWrites: 0,
        imagegenCalls: 0,
        deterministicFixtureMediaOnly: true,
        paidProviderCalls: 0,
        humanVisualAcceptanceClaimed: false,
        uploads: 0,
        installs: 0,
        gitMutations: 0,
        evidenceWrittenWithWxNoOverwrite: true,
        writeLeaseKillSwitchForIsolatedFixture: process.argv.includes("--lease-bypass"),
        fixtureCleaned,
      },
      productFindings: process.argv.includes("--lease-bypass") ? [
        "本次以 --lease-bypass 打开官方旁路 AI_CANVAS_DISABLE_WRITE_LEASE=1 走通隔离旅程。",
      ] : [
        "canvas:run-studio-canvas-workflow-group 已接 ensureDesktopWriteLeaseForCommand（T21 发现的租约缺口已修）；"
        + "本次未使用任何旁路，require 租约模式下画布「开始」真实可用即为本修复的运行证据。",
      ],
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  };

  try {
    /* -------------------------------- 前置（exit 2） -------------------------------- */
    await waitForT23Exit();
    for (const output of [reportPath, ...Object.values(screenshotPaths)]) {
      if (!await absent(output)) throw new PreconditionError(`证据路径已存在，拒绝覆盖：${output}`);
    }
    await mkdir(evidenceDirectory, { recursive: true });
    await assertBuildArtifacts(workspace);

    // 写租约门禁：canvas:run-studio-canvas-workflow-group 主进程 IPC 已接
    // ensureDesktopWriteLeaseForCommand（T21 发现的缺口已修），默认不走旁路，
    // 以此验证 require 租约模式下画布「开始」真实可用。仅当显式传 --lease-bypass
    // 时才对本进程与 Electron 子进程打开官方旁路 AI_CANVAS_DISABLE_WRITE_LEASE=1。
    const leaseBypass = process.argv.includes("--lease-bypass");
    if (leaseBypass) {
      const previousDisableWriteLease = process.env.AI_CANVAS_DISABLE_WRITE_LEASE;
      process.env.AI_CANVAS_DISABLE_WRITE_LEASE = "1";
      restoreDisableWriteLease = () => {
        if (previousDisableWriteLease === undefined) delete process.env.AI_CANVAS_DISABLE_WRITE_LEASE;
        else process.env.AI_CANVAS_DISABLE_WRITE_LEASE = previousDisableWriteLease;
      };
    }

    fixture = await createDuduReadonlySourceFixture();
    process.env.AI_CANVAS_REGISTRY_PATH = fixture.registryPath;
    const inspection = await inspectDuduReadonlySources(fixture.source);
    const bindingReadyPendingUnitIds = inspection.computedProjection.pendingStoryboardUnitIds
      .filter((unitId) => inspection.computedProjection.bindingReadyUnitIds.includes(unitId));
    const targetUnitId = bindingReadyPendingUnitIds[0];
    if (!targetUnitId) throw new PreconditionError("Dudu fixture 缺少 binding-ready pending 单元。");

    const staged = await stageDuduReadonlyManagedProject({
      projectsRoot: fixture.projectsRoot,
      source: fixture.source,
      detachedUnknownObservations: [],
    });
    const stagedControl = await getDuduReadonlyImportControl(staged.shell.paths.root);
    if (stagedControl.status !== "staging-verified") {
      throw new PreconditionError(`Dudu staging 未闭合：${stagedControl.status}`);
    }
    await finalizeDuduReadonlyManagedProject(staged.shell.paths.root, fixture.source);
    const activeControl = await getDuduReadonlyImportControl(staged.shell.paths.root);
    if (activeControl.status !== "active" || activeControl.nextAction !== "ready") {
      throw new PreconditionError(`Dudu active 投影未闭合：${activeControl.status}/${activeControl.nextAction}`);
    }
    const targetReceipt = staged.receipt.units.find((unit) => unit.unitId === targetUnitId);
    if (!targetReceipt?.packId) throw new PreconditionError("目标单元缺少 unit-grid pack。");
    const pack = await readStudioUnitGridGenerationFrozenPack(staged.shell.paths.root, targetReceipt.packId);
    if (!pack) throw new PreconditionError("目标 unit-grid pack 不可读。");

    runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "t21-review-side-by-side-"));
    const userDataRoot = path.join(runtimeRoot, "electron-user-data");
    await mkdir(userDataRoot, { recursive: true });
    launched = await launchBuiltElectron({
      workspace,
      userDataRoot,
      env: {
        ...process.env,
        AI_CANVAS_PROJECT_ROOT: staged.shell.paths.root,
        AI_CANVAS_REGISTRY_PATH: fixture.registryPath,
        AI_CANVAS_MANAGED_PROJECTS_ROOT: fixture.projectsRoot,
        AI_CANVAS_DISABLE_WRITE_LEASE: "1",
        AI_CANVAS_WINDOW_WIDTH: "1900",
        AI_CANVAS_WINDOW_HEIGHT: "1200",
      },
    });
    const page = launched.page;
    page.setDefaultTimeout(45_000);
    page.on("pageerror", (error) => renderer.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") renderer.consoleErrors.push(message.text());
    });
    page.on("request", (request) => {
      if (isExternalHttp(request.url())) renderer.externalRequests.push(request.url());
    });

    /* ------------------------------ 旅程 + 断言（exit 1） ------------------------------ */
    let journeyBroken = false;
    const journey = async (name: string, fn: () => Promise<void>): Promise<boolean> => {
      if (journeyBroken) {
        assertions.push({ name, status: "fail", durationMs: 0, detail: "前序旅程步骤失败，本步骤跳过。" });
        return false;
      }
      const ok = await check(name, fn);
      if (!ok) journeyBroken = true;
      return ok;
    };

    const studio = page.locator('[data-testid="material-studio-view"]');
    const generationControl = page.locator('[data-testid="studio-generation-control"]');
    const managedCanvas = page.locator('[data-testid="managed-studio-canvas-view"]');
    const reviewView = page.locator('[data-testid="studio-continuity-review-view"]');
    const workbench = reviewView.locator('[data-testid="studio-review-workbench"]');
    const compareTabs = workbench.locator('[data-testid="review-compare-modes"]');
    let expectedRaw = { width: 0, height: 0 };
    let expectedLabeled = { width: 0, height: 0 };

    await journey("journey:open-isolated-project", async () => {
      await studio.waitFor();
      const initialText = await studio.innerText();
      if (!initialText.includes("《嘟嘟》S1E1 隔离受管工程")) {
        throw new Error("构建版 Electron 未打开隔离 Dudu owner。");
      }
    });

    await journey("journey:canvas-start-dispatch", async () => {
      await page.locator('[data-testid="studio-step-generation"]').click();
      await generationControl.waitFor();
      await generationControl.locator(`.unit-rail > button[data-unit-id="${targetUnitId}"]`).click();
      await generationControl.locator('[data-testid="studio-generation-open-canvas"]').click();
      await managedCanvas.waitFor();
      await managedCanvas.locator('[data-testid="managed-canvas-primary-start"]').click();
      try {
        await page.waitForFunction(() => (
          document.querySelector('[data-testid="managed-canvas-workflow-run-summary"]')?.textContent?.includes("成功 1 · 失败 0") === true
        ));
      } catch (reason) {
        // 超时时抓画布诊断面，避免盲猜：摘要/错误条/主按钮状态/单元焦点一目了然。
        // 注意：tsx(esbuild keepNames) 会给 evaluate 内「变量=箭头函数」注入 __name 辅助，
        // 序列化进浏览器后必然 ReferenceError；此处只用内联表达式，不声明任何嵌套函数。
        const diagnostic = await page.evaluate(() => {
          const primary = document.querySelector('[data-testid="managed-canvas-primary-start"]');
          return {
            runSummary: document.querySelector('[data-testid="managed-canvas-workflow-run-summary"]')?.textContent?.trim() ?? null,
            canvasError: document.querySelector(".canvas-error")?.textContent?.trim() ?? null,
            resultStatus: document.querySelector('[data-testid="managed-canvas-result-status"]')?.textContent?.trim() ?? null,
            generationProjection: document.querySelector('[data-testid="managed-canvas-generation-projection"]')?.textContent?.trim() ?? null,
            canvasContext: document.querySelector(".canvas-context")?.textContent?.trim() ?? null,
            unitLeaseBanner: document.querySelector('[data-testid="managed-canvas-unit-lease-banner"]')?.textContent?.trim() ?? null,
            primaryStartDisabled: primary instanceof HTMLButtonElement ? primary.disabled : null,
            primaryStartText: primary?.textContent?.trim() ?? null,
          };
        });
        throw new Error(`画布开始未在 45s 内闭合，诊断：${JSON.stringify(diagnostic)}`, { cause: reason });
      }
      const plans = (await listStudioGenerationPlanProjections(staged.shell.paths.root, { limit: 36 }))
        .filter((candidate) => candidate.nodes.some((node) => (
          node.targetKind === "unit-grid" && node.unitId === targetUnitId
        )));
      const plan = plans[0];
      const node = plan?.nodes.find((candidate) => candidate.targetKind === "unit-grid" && candidate.unitId === targetUnitId);
      if (!plan || plan.nodes.length !== 1 || !node || node.status !== "dispatched" || !node.generationRunId
        || node.packId !== pack.id || node.packFingerprint !== pack.fingerprint) {
        throw new Error("画布开始后 unit-grid pack/plan/run 身份未闭合。");
      }
      target.unitId = targetUnitId;
      target.planId = plan.planId;
      target.generationRunId = node.generationRunId;
    });

    await journey("journey:commit-raw-labeled-review", async () => {
      // 子步骤打标：三个 Core 写调用任一个失败都能直接定位，不必重跑排查。
      let subStep = "getActiveManagedStudioContext/prepareStudioImagegenCall";
      try {
      const generationRunId = String(target.generationRunId);
      const context = await getActiveManagedStudioContext();
      const call = await withSqliteRetry(() => prepareStudioImagegenCall(staged.shell.paths.root, {
        projectContextToken: context.projectContextToken,
        packId: pack.id,
        packFingerprint: pack.fingerprint,
        generationRunId,
        provider: "codex",
        commandRequestId: "t21-side-by-side-fixture-call",
        expectedRevision: 0,
      }));
      if (!call.callAllowed) throw new Error("隔离 fixture 首次 pre-call 未得到一次性授权。");

      // 确定性 900x1600 本地 SVG 位图：只证明解码/布局链路，不代表任何真实生图。
      const rawPath = path.join(runtimeRoot, "t21-deterministic-unit-grid-raw.png");
      const fixtureSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1600" viewBox="0 0 900 1600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#17293f"/><stop offset="0.52" stop-color="#526b62"/><stop offset="1" stop-color="#b98956"/></linearGradient></defs><rect width="900" height="1600" fill="url(#g)"/><circle cx="300" cy="520" r="190" fill="#d5b078" fill-opacity=".72"/><path d="M90 1320 L450 780 L810 1320 Z" fill="#243d4d" fill-opacity=".88"/><rect x="110" y="110" width="680" height="1380" rx="26" fill="none" stroke="#f0d8ac" stroke-width="10" stroke-opacity=".6"/></svg>`, "utf8");
      await sharp(fixtureSvg).png({ compressionLevel: 9 }).toFile(rawPath);
      const rawBytes = await readFile(rawPath);
      subStep = "commitAgentImagegenResultBundle";
      const committed = await withSqliteRetry(() => commitAgentImagegenResultBundle(staged.shell.paths.root, {
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
      }));
      subStep = "submitStudioGenerationReview";
      const review = await withSqliteRetry(() => submitStudioGenerationReview(staged.shell.paths.root, {
        operationId: "t21-side-by-side-fixture-review",
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
        reviewer: "t21-side-by-side-fixture",
        note: "确定性隔离 fixture；不代表真实 canary 或人工视觉验收。",
      }));
      expectedRaw = { width: committed.media.raw.width, height: committed.media.raw.height };
      expectedLabeled = { width: committed.media.labeled.width, height: committed.media.labeled.height };
      target.packId = pack.id;
      target.rawResultId = committed.results.raw.resultId;
      target.labeledResultId = committed.results.labeled.resultId;
      target.reviewId = review.reviewId;
      target.media = {
        raw: { sha256: committed.media.raw.sha256, ...expectedRaw },
        labeled: { sha256: committed.media.labeled.sha256, ...expectedLabeled },
      };
      } catch (error) {
        throw new Error(`子步骤[${subStep}]失败：${describeError(error)}`, { cause: error });
      }
    });

    await journey("journey:open-review-workbench", async () => {
      await page.locator('[data-testid="studio-step-generation"]').click();
      await generationControl.waitFor();
      await generationControl.locator(`.unit-rail > button[data-unit-id="${targetUnitId}"]`).click();
      await generationControl.locator('[data-testid="studio-generation-open-review"]:not([disabled])').waitFor();
      await generationControl.locator('[data-testid="studio-generation-open-review"]').click();
      await reviewView.waitFor();
      await reviewView.locator('[data-testid="continuity-focused-scope"]')
        .filter({ hasText: "整板生成结果" })
        .waitFor();
      await workbench.waitFor({ timeout: 15_000 });
      await reviewView.filter({ hasText: "raw/labeled 已加载并通过浏览器解码" }).waitFor();
    });

    const sideBySideStageImages = ".review-comparison .annotation-stage img";
    const readStageDecode = (stage: "raw" | "labeled"): Promise<ImageDecodeState | null> => page.evaluate(
      (stageName) => {
        const image = document.querySelector(
          `[data-testid="studio-review-workbench"] .review-comparison .annotation-stage[data-stage="${stageName}"] img`,
        );
        return image instanceof HTMLImageElement
          ? { complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight }
          : null;
      },
      stage,
    );

    if (!journeyBroken) {
      await check("side-by-side-default-active", async () => {
        const tab = compareTabs.getByRole("tab", { name: "并排", exact: true });
        await tab.waitFor();
        if (await tab.getAttribute("aria-selected") !== "true") {
          throw new Error("打开 workbench 后默认对比模式不是「并排」。");
        }
        await workbench.locator(".review-comparison").waitFor();
      });

      await check("side-by-side-dual-render", async () => {
        const images = workbench.locator(sideBySideStageImages);
        const count = await images.count();
        if (count !== 2) throw new Error(`并排模式可见舞台 img 数=${count}，期望 2。`);
        for (const index of [0, 1]) {
          if (!await images.nth(index).isVisible()) throw new Error(`并排模式第 ${index + 1} 张图不可见。`);
        }
        const figures = workbench.locator(".review-comparison figure");
        if (await figures.count() !== 2) throw new Error("并排模式 figure 数不是 2（raw/labeled 未同屏）。");
      });

      await check("side-by-side-decode-complete", async () => {
        await page.waitForFunction(() => {
          const images = Array.from(document.querySelectorAll(
            '[data-testid="studio-review-workbench"] .review-comparison .annotation-stage img',
          ));
          return images.length === 2 && images.every((image) => (
            image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
          ));
        });
        for (const stage of ["raw", "labeled"] as const) {
          const state = await readStageDecode(stage);
          if (!state?.complete || state.naturalWidth <= 0) {
            throw new Error(`并排模式 ${stage} 图未完成浏览器解码：${JSON.stringify(state)}`);
          }
        }
      });

      await check("side-by-side-natural-size", async () => {
        const raw = await readStageDecode("raw");
        const labeled = await readStageDecode("labeled");
        if (!raw || raw.naturalWidth !== expectedRaw.width || raw.naturalHeight !== expectedRaw.height) {
          throw new Error(`raw 图 natural 尺寸 ${JSON.stringify(raw)} ≠ 媒体真实尺寸 ${JSON.stringify(expectedRaw)}。`);
        }
        if (!labeled || labeled.naturalWidth !== expectedLabeled.width || labeled.naturalHeight !== expectedLabeled.height) {
          throw new Error(`labeled 图 natural 尺寸 ${JSON.stringify(labeled)} ≠ 媒体真实尺寸 ${JSON.stringify(expectedLabeled)}。`);
        }
      });

      await check("screenshot-side-by-side", async () => {
        await compareTabs.scrollIntoViewIfNeeded();
        screenshots.sideBySide = {
          ...await captureScreenshotEvidence(page, screenshotPaths.sideBySide),
          relativePath: relativeToWorkspace(screenshotPaths.sideBySide),
        };
      });

      await check("ab-mode-switch-and-toggle", async () => {
        await compareTabs.getByRole("tab", { name: "A/B 切换", exact: true }).click();
        await workbench.locator(".ab-switch").waitFor();
        // 默认展示 raw，切到 labeled 后 img 以 :key 重建；两次都等 natural 尺寸落位。
        await page.waitForFunction((expected) => {
          const image = document.querySelector(
            '[data-testid="studio-review-workbench"] .review-single .annotation-stage img',
          );
          return image instanceof HTMLImageElement && image.complete
            && image.naturalWidth === expected.width && image.naturalHeight === expected.height;
        }, expectedRaw);
        await workbench.locator(".ab-switch").getByRole("button", { name: "标注图", exact: true }).click();
        await page.waitForFunction((expected) => {
          const image = document.querySelector(
            '[data-testid="studio-review-workbench"] .review-single .annotation-stage[data-stage="labeled"] img',
          );
          return image instanceof HTMLImageElement && image.complete
            && image.naturalWidth === expected.width && image.naturalHeight === expected.height;
        }, expectedLabeled);
      });

      await check("screenshot-ab", async () => {
        await compareTabs.scrollIntoViewIfNeeded();
        screenshots.ab = {
          ...await captureScreenshotEvidence(page, screenshotPaths.ab),
          relativePath: relativeToWorkspace(screenshotPaths.ab),
        };
      });

      await check("wipe-mode-dual-layer", async () => {
        await compareTabs.getByRole("tab", { name: "擦除", exact: true }).click();
        const wipeStage = workbench.locator(".wipe-stage");
        await wipeStage.waitFor();
        if (await wipeStage.locator("img").count() !== 2) {
          throw new Error("擦除模式未同时挂载 wipe-base(raw) 与 wipe-top(labeled) 双图层。");
        }
        await workbench.locator(".wipe-divider").waitFor();
        await page.waitForFunction((expected) => {
          const base = document.querySelector(
            '[data-testid="studio-review-workbench"] .wipe-stage img.wipe-base',
          );
          const top = document.querySelector(
            '[data-testid="studio-review-workbench"] .wipe-stage img.wipe-top',
          );
          return base instanceof HTMLImageElement && top instanceof HTMLImageElement
            && base.complete && top.complete
            && base.naturalWidth === expected.raw.width && base.naturalHeight === expected.raw.height
            && top.naturalWidth === expected.labeled.width && top.naturalHeight === expected.labeled.height;
        }, { raw: expectedRaw, labeled: expectedLabeled });
      });

      await check("screenshot-wipe", async () => {
        await compareTabs.scrollIntoViewIfNeeded();
        screenshots.wipe = {
          ...await captureScreenshotEvidence(page, screenshotPaths.wipe),
          relativePath: relativeToWorkspace(screenshotPaths.wipe),
        };
      });

      await check("difference-mode-canvas", async () => {
        await compareTabs.getByRole("tab", { name: "差分", exact: true }).click();
        const canvas = workbench.locator("canvas.difference-canvas");
        await canvas.waitFor({ state: "visible", timeout: 30_000 });
        const size = await page.evaluate(() => {
          const element = document.querySelector(
            '[data-testid="studio-review-workbench"] canvas.difference-canvas',
          );
          return element instanceof HTMLCanvasElement ? { width: element.width, height: element.height } : null;
        });
        if (!size || size.width < 1 || size.height < 1) {
          throw new Error(`差分画布未产出有效像素：${JSON.stringify(size)}`);
        }
      });

      await check("screenshot-difference", async () => {
        await compareTabs.scrollIntoViewIfNeeded();
        screenshots.difference = {
          ...await captureScreenshotEvidence(page, screenshotPaths.difference),
          relativePath: relativeToWorkspace(screenshotPaths.difference),
        };
      });

      await check("restore-side-by-side", async () => {
        await compareTabs.getByRole("tab", { name: "并排", exact: true }).click();
        await workbench.locator(".review-comparison").waitFor();
        await page.waitForFunction(() => {
          const images = Array.from(document.querySelectorAll(
            '[data-testid="studio-review-workbench"] .review-comparison .annotation-stage img',
          ));
          return images.length === 2 && images.every((image) => (
            image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
          ));
        });
      });
    }

    await check("no-renderer-errors", async () => {
      const resourceUrls = await page.evaluate(() => performance.getEntriesByType("resource")
        .map((entry) => (entry as PerformanceResourceTiming).name));
      renderer.externalRequests.push(...resourceUrls.filter(isExternalHttp));
      if (renderer.pageErrors.length || renderer.consoleErrors.length || renderer.externalRequests.length) {
        throw new Error(`renderer/外网错误：${JSON.stringify(renderer)}`);
      }
    });

    status = assertions.every((record) => record.status === "pass") ? "pass" : "fail";
    return status === "pass" ? 0 : 1;
  } catch (error) {
    if (error instanceof PreconditionError || assertions.length === 0) {
      status = "precondition-error";
      preconditionError = error instanceof Error ? error.message : String(error);
      return 2;
    }
    status = "fail";
    preconditionError = `旅程外未捕获异常：${error instanceof Error ? error.message : String(error)}`;
    return 1;
  } finally {
    await launched?.close().catch(() => undefined);
    if (fixture) {
      const fixtureRoot = fixture.root;
      await fixture.cleanup().catch(() => undefined);
      fixtureCleaned = await absent(fixtureRoot);
    }
    if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
    else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
    restoreDisableWriteLease?.();
    await writeReport().catch((error: unknown) => {
      process.stderr.write(`报告落盘失败：${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
}

const exitCode = await main();
process.stdout.write(`${JSON.stringify({
  ok: exitCode === 0,
  exitCode,
  reportPath: relativeToWorkspace(reportPath),
  screenshots: Object.fromEntries(Object.entries(screenshots).map(([key, value]) => [key, value?.relativePath])),
  assertions: assertions.map((record) => `${record.status === "pass" ? "PASS" : "FAIL"} ${record.name}`),
}, null, 2)}\n`);
process.exitCode = exitCode;
