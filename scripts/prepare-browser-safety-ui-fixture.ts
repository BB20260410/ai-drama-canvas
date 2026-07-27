import path from "node:path";
import { runFullWorkflow } from "./full-workflow-smoke.js";
import { enqueueGeneration, getBrowserGenerationPlan, getGenerationSettings, processGenerationQueue, updateBrowserGenerationJob, upsertGenerationProvider } from "../src/core/generation.js";
import { getProjectIndex } from "../src/core/service.js";

const root = path.resolve(process.argv[2] || "/tmp/ai-canvas-browser-safety-ui");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-browser-safety-ui-registry.json");
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

await runFullWorkflow(root, registryPath);
const settings = await getGenerationSettings(root);
const saved = await upsertGenerationProvider(root, {
  expectedRevision: settings.revision,
  setAsDefaultFor: "image",
  provider: {
    id: "browser-safety-ui",
    name: "隔离网页安全夹具（未提交）",
    adapter: "codex-browser",
    kinds: ["image"],
    enabled: true,
    siteUrl: "http://127.0.0.1:65535/generate",
    browserInstructions: "仅用于本机 UI 验收；不得打开网站或提交任务。",
    workflow: { schemaVersion: 1, name: "浏览器安全槽位验收", version: "1", format: "browser-recipe", definition: { purpose: "ui-safety-fixture", submit: false } },
    capabilities: {
      referenceModes: ["text", "multi_image"],
      maxReferenceImages: 8,
      maxReferenceVideos: 0,
      supportedDurations: [],
      supportedAspectRatios: ["9:16"],
      supportedResolutions: ["1080p"],
      models: ["fixture-only"],
      maxConcurrency: 1,
      supportsCancel: false,
    },
    model: "fixture-only",
    outputRoot: root,
  },
}, "codex");

const index = await getProjectIndex(root);
const item = index.items.find((candidate) => candidate.type === "unit" && candidate.episode === 1);
if (!item) throw new Error("隔离夹具没有可用于网页生成验收的 15 秒单元。");
const [created] = await enqueueGeneration(root, { itemIds: [item.id], kind: "image", providerId: "browser-safety-ui", prompt: "隔离 UI 验收任务，不进行真实生成。" });
if (!created) throw new Error("隔离网页生成任务没有创建。");
await processGenerationQueue(root);
const plan = await getBrowserGenerationPlan(root, created.id);
if (plan.currentCheckpoint?.revision !== 1 || plan.currentCheckpoint.stage !== "plan_ready") throw new Error("网页生成计划没有从 R1 / plan_ready 开始。");
const preflight = await updateBrowserGenerationJob(root, created.id, {
  expectedRevision: 1,
  status: "preflight",
  note: "隔离 UI 夹具：仅验证状态展示，不代表真实网站登录或余额检查。",
  preflightEvidence: {
    observedHost: "127.0.0.1",
    loginVerified: true,
    pageReady: true,
    generationModeVerified: true,
    balanceChecked: true,
    paidActionRequired: false,
    paidActionAuthorized: false,
    observedGeneration: { model: "fixture-only", aspectRatio: "9:16", resolution: "1080p", generateEnabled: true },
  },
});
const uploaded = await updateBrowserGenerationJob(root, created.id, {
  expectedRevision: preflight.browserCheckpoint!.revision,
  status: "uploaded",
  note: "隔离 UI 夹具：按冻结计划核对本地路径和语义槽位；未向任何网站上传。",
  uploadEvidence: {
    files: plan.allowedUploads.map((reference) => ({
      path: reference.path,
      role: reference.role,
      order: reference.order,
      slot: `参考槽位 ${reference.order + 1}`,
    })),
  },
});
const submitIntent = await updateBrowserGenerationJob(root, created.id, {
  expectedRevision: uploaded.browserCheckpoint!.revision,
  status: "submit_intent",
  note: "隔离 UI 夹具：仅持久化提交意图，未打开网站、未点击按钮、未产生付费动作。",
});
if (submitIntent.status !== "submission_unknown" || submitIntent.browserCheckpoint?.revision !== 4 || submitIntent.browserCheckpoint.stage !== "submission_unknown") throw new Error("隔离网页任务没有停在 R4 / submission_unknown。");
if (submitIntent.browserCheckpoint.submissionIntent?.clientJobId !== created.id) throw new Error("隔离网页任务没有持久化 clientJobId。");

process.stdout.write(`${JSON.stringify({
  root,
  registryPath,
  providerRevision: saved.revision,
  jobId: created.id,
  itemId: item.id,
  checkpoint: submitIntent.browserCheckpoint,
  remoteSubmitted: false,
}, null, 2)}\n`);
