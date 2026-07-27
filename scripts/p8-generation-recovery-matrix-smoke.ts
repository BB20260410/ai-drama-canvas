#!/usr/bin/env node
/**
 * P8 生成链六阶段 SIGKILL 恢复矩阵。
 *
 * 每个阶段在独立、非 Dudu 的受管夹具工程中由 worker 完成真实 Core 写入；
 * worker 落下阶段收据后保持存活，父进程对整个进程组发 SIGKILL，再从磁盘
 * 重新打开工程并验证恢复投影。全程不调用任何外部生图/视频供应商。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  commitUnitGridBundle,
  createUnitGridFixtureProject,
  createUnitGridTestImage,
  freezeDispatchPrepareUnitGrid,
  passUnitGridReview,
  type UnitGridRunHandle,
} from "../tests/helpers/studio-unit-grid-fixture.js";
import { inspectManagedProjectReadOnly } from "../src/core/managed-project.js";
import { buildNextShotContinuitySnapshot } from "../src/core/studio-next-shot-continuity.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioUnitGridGenerationPack,
  listStudioGenerationActiveRuns,
  readStudioGenerationResultBundle,
  readStudioUnitGridGenerationFrozenPack,
} from "../src/core/studio-generation-ledger.js";
import {
  getStudioGenerationReviewControl,
} from "../src/core/studio-generation-review.js";
import {
  getStudioPostResultObservationControl,
  submitStudioPostResultObservation,
} from "../src/core/studio-post-result-observation.js";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.js";
import {
  buildAndVerifyStudioVideoPackage,
  getStudioVideoPackageExportControl,
  prepareStudioVideoPackageExport,
  prepareStudioVideoPackageSource,
} from "../src/core/studio-video-package.js";

const STAGES = [
  "before-call",
  "generation-unknown",
  "result-cas",
  "review",
  "observation",
  "video-receipt",
] as const;
type Stage = typeof STAGES[number];

interface StageReceipt {
  status: "ready" | "error";
  stage: Stage;
  root?: string;
  unitId?: string;
  generationRunId?: string;
  packId?: string;
  packFingerprint?: string;
  callId?: string;
  bundle?: {
    rawResultId: string;
    rawSha256: string;
    labeledResultId: string;
    labeledSha256: string;
  };
  review?: { reviewId: string; fingerprint: string };
  observation?: { observationId: string; fingerprint: string };
  video?: {
    intentId: string;
    receiptId: string;
    receiptFingerprint: string;
    storageKind: string;
    manifestSha256: string;
  };
  externalProviderInvocationCount: 0;
  error?: string;
  readyAt: string;
}

interface RecoveryStageEvidence {
  stage: Stage;
  sigkill: {
    pid: number;
    signal: "SIGKILL";
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
  };
  durable: Record<string, unknown>;
  quickCheck: string;
  externalProviderInvocationCount: 0;
  restartVerifiedAt: string;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

function requiredArgument(name: string): string {
  const value = argument(name)?.trim();
  if (!value) throw new Error(`缺少 --${name}=...`);
  return value;
}

function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function bundleIdentity(
  bundle: Awaited<ReturnType<typeof commitUnitGridBundle>>,
): NonNullable<StageReceipt["bundle"]> {
  return {
    rawResultId: bundle.raw.resultId,
    rawSha256: bundle.raw.mediaSha256,
    labeledResultId: bundle.labeled.resultId,
    labeledSha256: bundle.labeled.mediaSha256,
  };
}

async function createDispatchedRun(
  root: string,
  unitId: string,
  generationRunId: string,
): Promise<UnitGridRunHandle & { callId: "" }> {
  const pack = await freezeAndPersistStudioUnitGridGenerationPack(root, {
    targetKind: "unit-grid",
    unitId,
  });
  await dispatchStudioGenerationPack(root, {
    packId: pack.packId,
    packFingerprint: pack.fingerprint,
    generationRunId,
    provider: "codex",
  });
  return { pack, callId: "", generationRunId };
}

async function submitCurrentObservation(
  root: string,
  unitId: string,
  run: UnitGridRunHandle,
  bundle: Awaited<ReturnType<typeof commitUnitGridBundle>>,
  review: Awaited<ReturnType<typeof passUnitGridReview>>,
  stage: Stage,
) {
  const terminalEvidence = await createUnitGridTestImage(
    root,
    `${stage}-accepted-last-frame`,
    "#294b63",
  );
  const terminalPanelId = run.pack.pack.panels.at(-1)!.panelId;
  const continuitySnapshot = buildNextShotContinuitySnapshot({
    sourceUnitId: unitId,
    sourcePanelId: terminalPanelId,
    sourceRawSha256: bundle.raw.mediaSha256,
    characters: [{
      assetId: "character-ahang",
      costumeState: "棕色古蜀麻布短衣完整，无新增污损",
      position: "画面中央",
      facing: "身体朝右，头回望左后方",
      gazeDirection: "注视画面左后方",
      actionEndPose: "停步回望并收稳",
      nextActionStart: "保持停步姿态，从回望状态承接下一镜",
      expression: "警觉",
      injuryState: "无可见伤势",
    }],
    props: [{
      assetId: "prop-complete-mask",
      heldBy: null,
      position: "藏于布囊且未入画",
      physicalState: "完整、闭合",
    }],
    scene: {
      layout: "阿航居中，古蜀石墙在后",
      axisLine: "人物沿画面左右方向形成运动轴线",
      screenDirection: "人物身体向右、视线回到左后方",
      entryExits: ["画面右侧石门"],
      lighting: "左侧火光，右侧较暗",
      timeOfDay: "夜",
      cutExit: "人物回望动作收稳时切出",
    },
    vfx: [],
    referenceSha256List: [bundle.raw.mediaSha256, terminalEvidence.sha256],
  });
  return submitStudioPostResultObservation(root, {
    operationId: `p8-${stage}-observation`,
    generationRunId: run.generationRunId,
    expectedHeadRevision: 0,
    expectedReviewId: review.reviewId,
    expectedReviewFingerprint: review.fingerprint,
    rawResultId: bundle.raw.resultId,
    rawSha256: bundle.raw.mediaSha256,
    labeledResultId: bundle.labeled.resultId,
    labeledSha256: bundle.labeled.mediaSha256,
    packId: run.pack.packId,
    packFingerprint: run.pack.fingerprint,
    plannedContinuityFingerprint: run.pack.pack.continuityFingerprint,
    evidenceKind: "accepted-last-frame",
    evidenceSha256: terminalEvidence.sha256,
    observedState: {
      costume: "棕色古蜀麻布短衣完整，无新增污损。",
      injury: "无可见伤势。",
      heldObject: "双手空置，完整黄金面具藏于布囊且未入画。",
      position: "人物位于画面中央。",
      facing: "身体朝右，头回望左后方。",
      emotion: "神情警觉。",
      layout: "阿航居中，古蜀石墙在后。",
      lighting: "左侧火光，右侧较暗。",
      referenceSha256: terminalEvidence.sha256,
      motionVector: "静态尾帧不声明动态运动。",
      cameraPhase: "静态尾帧不声明动态机位。",
      focusState: "焦点落在阿航。",
      audioPhase: "静态尾帧不声明音频状态。",
    },
    observedAvailability: {
      costume: "observed",
      injury: "observed",
      heldObject: "observed",
      position: "observed",
      facing: "observed",
      emotion: "observed",
      layout: "observed",
      lighting: "observed",
      motionVector: "unknown",
      cameraPhase: "unknown",
      focusState: "observed",
      audioPhase: "unknown",
    },
    continuitySnapshot,
    observer: "p8-recovery-matrix",
    note: "P8 隔离机械夹具的实际尾帧观察；只证明收据与恢复，不代表正式视觉验收。",
  });
}

async function buildVideoReceipt(
  root: string,
  run: UnitGridRunHandle,
  review: Awaited<ReturnType<typeof passUnitGridReview>>,
) {
  const [snapshot, observationControl] = await Promise.all([
    getStudioProductionUnitSnapshot(root, run.pack.unitId),
    getStudioPostResultObservationControl(root, run.generationRunId),
  ]);
  assert(snapshot, "视频包阶段无法读取 unit snapshot");
  const source = await prepareStudioVideoPackageSource(root, {
    adapterKind: "managed-evidence-v1",
    reviewId: review.reviewId,
    expectedReviewFingerprint: review.fingerprint,
    expectedPackFingerprint: run.pack.fingerprint,
    expectedUnitSnapshotFingerprint: snapshot.fingerprint,
    expectedObservationControlFingerprint: observationControl.fingerprint,
    expectedObservationHeadRevision: observationControl.headRevision,
    expectedObservationStatus: observationControl.status,
    expectedObservationHeadId: observationControl.head?.observationId ?? null,
    expectedObservationHeadFingerprint: observationControl.head?.fingerprint ?? null,
    expectedObservationEvidenceSha256: observationControl.head?.evidenceSha256 ?? null,
  });
  const prepared = await prepareStudioVideoPackageExport(root, {
    operationId: "p8-video-receipt-export",
    authority: { kind: "studio-review", reviewId: review.reviewId },
    expectedManagedSource: {
      adapterKind: "managed-evidence-v1",
      reviewId: review.reviewId,
      expectedSourceFingerprint: source.fingerprint,
      expectedReviewFingerprint: review.fingerprint,
      expectedPackFingerprint: run.pack.fingerprint,
      expectedUnitSnapshotFingerprint: snapshot.fingerprint,
      expectedObservationControlFingerprint: observationControl.fingerprint,
      expectedObservationHeadRevision: observationControl.headRevision,
      expectedObservationStatus: observationControl.status,
      expectedObservationHeadId: observationControl.head?.observationId ?? null,
      expectedObservationHeadFingerprint: observationControl.head?.fingerprint ?? null,
      expectedObservationEvidenceSha256: observationControl.head?.evidenceSha256 ?? null,
    },
  });
  const built = await buildAndVerifyStudioVideoPackage(
    root,
    prepared.intent.intentId,
    { destinationPolicy: "managed-evidence-only" },
  );
  return { prepared, built };
}

async function runWorker(): Promise<void> {
  const stageValue = requiredArgument("stage");
  if (!isStage(stageValue)) throw new Error(`无效 stage：${stageValue}`);
  const stage = stageValue;
  const parentRoot = requiredArgument("parent-root");
  const receiptPath = requiredArgument("receipt");
  let receipt: StageReceipt = {
    status: "error",
    stage,
    externalProviderInvocationCount: 0,
    readyAt: new Date().toISOString(),
  };
  try {
    await mkdir(parentRoot, { recursive: true });
    const fixture = await createUnitGridFixtureProject(parentRoot, {
      unitId: `p8-${stage}`,
      season: "P8",
      episode: "RECOVERY",
      sequence: 1,
    });
    const generationRunId = `p8-${stage}-run-1`;
    const run = stage === "before-call"
      ? await createDispatchedRun(fixture.root, fixture.unitId, generationRunId)
      : await freezeDispatchPrepareUnitGrid(fixture.root, fixture.unitId, generationRunId);
    let bundle: Awaited<ReturnType<typeof commitUnitGridBundle>> | undefined;
    let review: Awaited<ReturnType<typeof passUnitGridReview>> | undefined;
    let observation: Awaited<ReturnType<typeof submitCurrentObservation>> | undefined;
    let video: Awaited<ReturnType<typeof buildVideoReceipt>> | undefined;
    if (["result-cas", "review", "observation", "video-receipt"].includes(stage)) {
      bundle = await commitUnitGridBundle(fixture.root, run, `p8-${stage}`);
    }
    if (["review", "observation", "video-receipt"].includes(stage)) {
      review = await passUnitGridReview(
        fixture.root,
        run,
        bundle!,
        `p8-${stage}-review`,
        {
          reviewer: "p8-recovery-matrix",
          note: "P8 隔离确定性夹具 Review PASS；只验证恢复链，不代表正式视觉验收。",
        },
      );
    }
    if (stage === "observation") {
      observation = await submitCurrentObservation(
        fixture.root,
        fixture.unitId,
        run,
        bundle!,
        review!,
        stage,
      );
    }
    if (stage === "video-receipt") {
      video = await buildVideoReceipt(fixture.root, run, review!);
    }
    receipt = {
      status: "ready",
      stage,
      root: fixture.root,
      unitId: fixture.unitId,
      generationRunId,
      packId: run.pack.packId,
      packFingerprint: run.pack.fingerprint,
      ...(run.callId ? { callId: run.callId } : {}),
      ...(bundle ? { bundle: bundleIdentity(bundle) } : {}),
      ...(review ? { review: { reviewId: review.reviewId, fingerprint: review.fingerprint } } : {}),
      ...(observation
        ? {
            observation: {
              observationId: observation.observationId,
              fingerprint: observation.fingerprint,
            },
          }
        : {}),
      ...(video
        ? {
            video: {
              intentId: video.prepared.intent.intentId,
              receiptId: video.built.receipt.receiptId,
              receiptFingerprint: video.built.receipt.fingerprint,
              storageKind: video.built.receipt.storageKind,
              manifestSha256: video.built.receipt.manifestSha256,
            },
          }
        : {}),
      externalProviderInvocationCount: 0,
      readyAt: new Date().toISOString(),
    };
    await writeJsonAtomic(receiptPath, receipt);
    // 父进程必须观察到一个仍存活的 worker，再发真正的 SIGKILL。
    await new Promise<never>(() => {
      setInterval(() => undefined, 60_000);
    });
  } catch (error) {
    receipt = {
      ...receipt,
      status: "error",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      readyAt: new Date().toISOString(),
    };
    await writeJsonAtomic(receiptPath, receipt).catch(() => undefined);
    throw error;
  }
}

async function waitForWorkerReceipt(
  child: ChildProcess,
  receiptPath: string,
  timeoutMs: number,
): Promise<StageReceipt> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = JSON.parse(await readFile(receiptPath, "utf8")) as StageReceipt;
      if (value.status === "error") throw new Error(value.error ?? "worker 未知错误");
      if (value.status === "ready") return value;
    } catch (error) {
      if (error instanceof Error && !("code" in error && error.code === "ENOENT")) throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`worker 提前退出：exit=${String(child.exitCode)} signal=${String(child.signalCode)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`worker ${child.pid ?? "unknown"} 等待阶段收据超时 ${timeoutMs}ms`);
}

async function waitForExit(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function sqliteQuickCheck(projectRoot: string): string {
  const db = new DatabaseSync(
    path.join(projectRoot, ".aicanvas", "studio-generation-ledger.sqlite"),
    { readOnly: true },
  );
  try {
    const rows = db.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    return rows.map((entry) => entry.quick_check).join(",");
  } finally {
    db.close();
  }
}

async function verifyAfterKill(receipt: StageReceipt): Promise<Record<string, unknown>> {
  assert.equal(receipt.status, "ready");
  assert(receipt.root && receipt.unitId && receipt.generationRunId && receipt.packId && receipt.packFingerprint);
  const shell = await inspectManagedProjectReadOnly(receipt.root);
  const [pack, active, bundle, reviewControl] = await Promise.all([
    readStudioUnitGridGenerationFrozenPack(receipt.root, receipt.packId),
    listStudioGenerationActiveRuns(receipt.root, {
      unitId: receipt.unitId,
      targetKind: "unit-grid",
    }),
    readStudioGenerationResultBundle(receipt.root, receipt.generationRunId),
    getStudioGenerationReviewControl(receipt.root, receipt.generationRunId),
  ]);
  assert(pack, "SIGKILL 后冻结包不可读");
  assert.equal(pack.fingerprint, receipt.packFingerprint);
  const run = active.runs.find((entry) => entry.generationRunId === receipt.generationRunId);
  assert(run, "SIGKILL 后 run 不可发现");
  const durable: Record<string, unknown> = {
    projectId: shell.project.id,
    packId: pack.id,
    packFingerprint: pack.fingerprint,
    run,
    blockingRuns: active.blockingRuns,
  };

  if (receipt.stage === "before-call") {
    assert.equal(run.hasCallIntent, false);
    assert.equal(run.callStatus, null);
    assert.equal(run.hasResultPair, false);
    assert.equal(run.nextAction, "prepare-call-or-await");
    assert.equal(bundle, null);
    durable.recoveryDecision = "prepare-call-or-await";
  } else if (receipt.stage === "generation-unknown") {
    assert.equal(run.hasCallIntent, true);
    assert.equal(run.callId, receipt.callId);
    assert.equal(run.callStatus, "generation_unknown");
    assert.equal(run.nextAction, "reconcile-or-abandon-call");
    assert.equal(bundle, null);
    const beforeCount = active.runs.length;
    let duplicateDispatchRejected: { name: string; code?: unknown; message: string } | undefined;
    try {
      await dispatchStudioGenerationPack(receipt.root, {
        packId: receipt.packId,
        packFingerprint: receipt.packFingerprint,
        generationRunId: `${receipt.generationRunId}-forbidden-retry`,
        provider: "codex",
      });
    } catch (error) {
      duplicateDispatchRejected = {
        name: error instanceof Error ? error.name : "UnknownError",
        code: error && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    assert(duplicateDispatchRejected, "generation_unknown 时重复派发未被拒绝");
    const after = await listStudioGenerationActiveRuns(receipt.root, {
      unitId: receipt.unitId,
      targetKind: "unit-grid",
    });
    assert.equal(after.runs.length, beforeCount, "拒绝重复派发后 run 数发生变化");
    durable.recoveryDecision = "reconcile-or-abandon-call";
    durable.duplicateDispatchRejected = duplicateDispatchRejected;
    durable.providerCountUnchanged = true;
  } else {
    assert(receipt.bundle && bundle, "SIGKILL 后结果 bundle 不可读");
    assert.deepEqual(bundleIdentity(bundle), receipt.bundle);
    assert.equal(run.hasResultPair, true);
    assert.equal(run.callStatus, "result-committed");
    durable.bundle = bundleIdentity(bundle);
    if (receipt.stage === "result-cas") {
      assert.equal(reviewControl.status, "unreviewed");
      durable.recoveryDecision = "submit-review";
    }
  }

  if (["review", "observation", "video-receipt"].includes(receipt.stage)) {
    assert(receipt.review, "worker review 收据缺失");
    assert.equal(reviewControl.status, "pass");
    assert.equal(reviewControl.head?.reviewId, receipt.review.reviewId);
    assert.equal(reviewControl.head?.fingerprint, receipt.review.fingerprint);
    durable.review = {
      status: reviewControl.status,
      headRevision: reviewControl.headRevision,
      reviewId: reviewControl.head?.reviewId,
      fingerprint: reviewControl.head?.fingerprint,
    };
  }

  if (receipt.stage === "observation") {
    assert(receipt.observation);
    const observation = await getStudioPostResultObservationControl(
      receipt.root,
      receipt.generationRunId,
    );
    assert.equal(observation.status, "current");
    assert.equal(observation.headRevision, 1);
    assert.equal(observation.head?.observationId, receipt.observation.observationId);
    assert.equal(observation.head?.fingerprint, receipt.observation.fingerprint);
    assert.equal(observation.nextAction, "use-observed-end-state");
    durable.observation = {
      status: observation.status,
      headRevision: observation.headRevision,
      observationId: observation.head?.observationId,
      fingerprint: observation.head?.fingerprint,
      nextAction: observation.nextAction,
    };
  }

  if (receipt.stage === "video-receipt") {
    assert(receipt.video);
    const video = await getStudioVideoPackageExportControl(receipt.root, receipt.video.intentId);
    assert.equal(video.status, "mechanically-verified");
    assert.equal(video.receipt?.receiptId, receipt.video.receiptId);
    assert.equal(video.receipt?.fingerprint, receipt.video.receiptFingerprint);
    assert.equal(video.receipt?.manifestSha256, receipt.video.manifestSha256);
    durable.video = {
      status: video.status,
      nextAction: video.nextAction,
      receiptId: video.receipt?.receiptId,
      receiptFingerprint: video.receipt?.fingerprint,
      storageKind: video.receipt?.storageKind,
      manifestSha256: video.receipt?.manifestSha256,
    };
  }
  return durable;
}

async function runParent(): Promise<void> {
  const reportPath = path.resolve(
    argument("report")
      ?? path.join(process.cwd(), "output", "evidence", "p8-generation-recovery-matrix.json"),
  );
  const keepProjects = process.argv.includes("--keep-projects");
  const temporaryRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p8-recovery-")),
  );
  const scriptPath = path.resolve(process.argv[1]!);
  const tsxPath = path.resolve(process.cwd(), "node_modules", ".bin", "tsx");
  const stages: RecoveryStageEvidence[] = [];
  try {
    for (const stage of STAGES) {
      const stageRoot = path.join(temporaryRoot, stage);
      const receiptPath = path.join(stageRoot, "worker-receipt.json");
      await mkdir(stageRoot, { recursive: true });
      const child = spawn(tsxPath, [
        scriptPath,
        "--worker",
        `--stage=${stage}`,
        `--parent-root=${stageRoot}`,
        `--receipt=${receiptPath}`,
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "test",
          AI_CANVAS_STUDIO_FORMAL_PROVIDER: "codex",
        },
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-16_000);
      });
      const receipt = await waitForWorkerReceipt(child, receiptPath, 300_000)
        .catch(async (error) => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              // 已退出。
            }
          }
          await waitForExit(child).catch(() => undefined);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}`
              + (stderr.trim() ? `\nworker stderr:\n${stderr.trim()}` : ""),
          );
        });
      assert(child.pid, "worker PID 缺失");
      const pid = child.pid;
      process.kill(-pid, "SIGKILL");
      const exited = await waitForExit(child);
      assert.equal(exited.signal, "SIGKILL", `阶段 ${stage} 未由 SIGKILL 终止`);
      const durable = await verifyAfterKill(receipt);
      const quickCheck = sqliteQuickCheck(receipt.root!);
      assert.equal(quickCheck, "ok");
      stages.push({
        stage,
        sigkill: {
          pid,
          signal: "SIGKILL",
          exitCode: exited.code,
          exitSignal: exited.signal,
        },
        durable,
        quickCheck,
        externalProviderInvocationCount: 0,
        restartVerifiedAt: new Date().toISOString(),
      });
      process.stdout.write(
        `[P8] ${stage}: SIGKILL=${String(exited.signal)} reopen=PASS quick_check=${quickCheck}\n`,
      );
    }
    const report = {
      schemaVersion: 1,
      kind: "p8-generation-recovery-matrix",
      status: "PASS",
      generatedAt: new Date().toISOString(),
      scope: {
        projectKind: "isolated-managed-non-dudu-fixture",
        stages: [...STAGES],
        externalProviderInvocationCount: 0,
        formalProjectMutated: false,
      },
      assertions: {
        everyWorkerActuallySigkilled: stages.every((entry) => entry.sigkill.exitSignal === "SIGKILL"),
        everyDatabaseQuickCheckOk: stages.every((entry) => entry.quickCheck === "ok"),
        generationUnknownBlocksDuplicateDispatch: Boolean(
          stages.find((entry) => entry.stage === "generation-unknown")
            ?.durable.duplicateDispatchRejected,
        ),
        providerCountUnchanged: true,
        resultPairRecoveredExactly: true,
        reviewHeadRecoveredExactly: true,
        observationHeadRecoveredExactly: true,
        videoReceiptRecoveredExactly: true,
      },
      stages,
      temporaryProjectsRetained: keepProjects,
      ...(keepProjects ? { temporaryRoot } : {}),
    };
    await writeJsonAtomic(reportPath, report);
    process.stdout.write(`[P8] recovery matrix PASS: ${reportPath}\n`);
  } finally {
    if (!keepProjects) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv.includes("--worker")) {
  await runWorker();
} else {
  await runParent();
}
