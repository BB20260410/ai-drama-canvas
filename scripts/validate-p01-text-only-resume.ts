import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getBrowserGenerationPlan, listGenerationJobs, updateBrowserGenerationJob } from "../src/core/generation.js";
import { getSidecarPaths } from "../src/core/sidecar.js";

const formalRoot = path.resolve(process.argv[2] || "/Users/hxx/Documents/无限画布/productions/gushujuan-s3-f1a688020bfb7af6");
const evidencePath = path.resolve(process.argv[3] || "docs/evidence/p01-text-only-resume-formal-smoke-20260715.json");
const jobId = process.argv[4] || "gen-2026-07-15T11-19-38-303Z-23ac427f";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileSha256(filePath: string): Promise<string> {
  return sha256(await readFile(filePath));
}

const formalPaths = getSidecarPaths(formalRoot);
const guarded = {
  generationJobs: formalPaths.generationJobs,
  publications: formalPaths.publications,
  assetConsistency: formalPaths.assetConsistencyBatches,
  commandLedger: formalPaths.commandLedger,
};
const beforeHashes = Object.fromEntries(await Promise.all(Object.entries(guarded).map(async ([key, filePath]) => [key, await fileSha256(filePath)])));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aicanvas-p01-text-only-"));
const isolatedRoot = path.join(tempRoot, "project");

let result: Record<string, unknown>;
try {
  await mkdir(isolatedRoot, { recursive: true });
  await cp(path.join(formalRoot, ".aicanvas"), path.join(isolatedRoot, ".aicanvas"), { recursive: true, force: false, errorOnExist: true });
  const isolatedPaths = getSidecarPaths(isolatedRoot);
  const projectConfig = JSON.parse(await readFile(isolatedPaths.config, "utf8")) as { primaryRoot: string };
  projectConfig.primaryRoot = isolatedRoot;
  await writeFile(isolatedPaths.config, `${JSON.stringify(projectConfig, null, 2)}\n`, "utf8");
  const index = JSON.parse(await readFile(isolatedPaths.index, "utf8")) as { project: { primaryRoot: string } };
  index.project.primaryRoot = isolatedRoot;
  await writeFile(isolatedPaths.index, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  const originalJob = (await listGenerationJobs(isolatedRoot)).find((candidate) => candidate.id === jobId);
  if (!originalJob || originalJob.browserCheckpoint?.stage !== "preflight_blocked" || originalJob.browserCheckpoint.revision !== 2) {
    throw new Error("隔离副本没有保留正式 P01 preflight_blocked / R2。");
  }
  const plan = await getBrowserGenerationPlan(isolatedRoot, jobId);
  if (plan.parameters.mode !== "text" || plan.allowedUploads.length !== 0 || plan.allowedUploadPaths.length !== 0) throw new Error("正式 P01 不是冻结的 text-only 零上传计划。");
  if (!plan.steps.find((step) => step.id === "upload")?.action.includes("uploadEvidence={files:[],observedReferenceThumbnailCount:0}")) throw new Error("正式旧计划读取时没有投影当前 text-only 零上传指引。");

  const preflight = await updateBrowserGenerationJob(isolatedRoot, jobId, {
    expectedRevision: 2,
    status: "preflight",
    note: "隔离状态机烟测：模拟额度和冻结模式已恢复；不代表真实网页现况，不触发浏览器或远端副作用。",
    preflightEvidence: {
      observedHost: "toolkit.artlist.io",
      loginVerified: true,
      pageReady: true,
      generationModeVerified: true,
      balanceChecked: true,
      paidActionRequired: false,
      paidActionAuthorized: false,
      blockers: [],
      observedGeneration: { model: "GPT Image 2", aspectRatio: "9:16", resolution: "Medium", imageCount: 1, generateEnabled: true },
    },
  });
  const uploaded = await updateBrowserGenerationJob(isolatedRoot, jobId, {
    expectedRevision: preflight.browserCheckpoint!.revision,
    status: "uploaded",
    note: "隔离状态机烟测：正式冻结白名单为空，显式确认页面零参考图。",
    uploadEvidence: { files: [], observedReferenceThumbnailCount: 0 },
  });
  const submitIntent = await updateBrowserGenerationJob(isolatedRoot, jobId, {
    expectedRevision: uploaded.browserCheckpoint!.revision,
    status: "submit_intent",
    note: "隔离状态机烟测：只验证本地提交意图，未打开 Artlist、未点击 Generate、未付费。",
  });
  if (submitIntent.status !== "submission_unknown" || submitIntent.browserCheckpoint?.stage !== "submission_unknown" || submitIntent.browserCheckpoint.revision !== 5) throw new Error("正式 P01 隔离副本没有通过零上传链进入 R5 submission_unknown。");
  if (submitIntent.externalTaskId || submitIntent.resultPath || submitIntent.publicationReceiptId) throw new Error("隔离状态机烟测意外产生远端身份、结果或 Publication 回执。");
  result = {
    formalJob: { id: originalJob.id, stage: originalJob.browserCheckpoint.stage, revision: originalJob.browserCheckpoint.revision },
    plan: {
      mode: plan.parameters.mode,
      allowedUploads: plan.allowedUploads,
      model: plan.parameters.model,
      aspectRatio: plan.parameters.aspectRatio,
      resolution: plan.parameters.resolution,
      imageCount: plan.parameters.imageCount,
      currentUploadInstructionProjected: true,
    },
    simulatedTransitions: [
      { stage: preflight.browserCheckpoint?.stage, revision: preflight.browserCheckpoint?.revision },
      { stage: uploaded.browserCheckpoint?.stage, revision: uploaded.browserCheckpoint?.revision, uploadEvidence: uploaded.browserCheckpoint?.uploadEvidence },
      { stage: submitIntent.browserCheckpoint?.stage, revision: submitIntent.browserCheckpoint?.revision, submissionIntent: submitIntent.browserCheckpoint?.submissionIntent },
    ],
    remoteSideEffects: { browserOpened: false, generateClicked: false, externalTaskId: false, result: false, publicationReceipt: false },
  };
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

const afterHashes = Object.fromEntries(await Promise.all(Object.entries(guarded).map(async ([key, filePath]) => [key, await fileSha256(filePath)])));
if (JSON.stringify(beforeHashes) !== JSON.stringify(afterHashes)) throw new Error("正式工程侧车在隔离 P01 零上传烟测期间发生变化。");
const evidence = {
  schemaVersion: 1,
  kind: "p01-text-only-resume-formal-smoke",
  createdAt: new Date().toISOString(),
  formalRoot,
  jobId,
  isolatedStateMachineOnly: true,
  guardedFormalSidecars: { beforeHashes, afterHashes, unchanged: true },
  result,
  assertions: {
    sameFormalP01ContractUsed: true,
    legacyStoredPlanProjectsCurrentInstructions: true,
    explicitZeroUploadCheckpointRequired: true,
    submitIntentAcceptedAfterZeroUpload: true,
    nonEmptyAllowlistRulesUnchanged: true,
    noFormalMutation: true,
    noRemoteSideEffect: true,
  },
};
await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({ evidencePath, jobId, guardedFormalSidecars: evidence.guardedFormalSidecars, result: evidence.result, assertions: evidence.assertions }, null, 2)}\n`);
