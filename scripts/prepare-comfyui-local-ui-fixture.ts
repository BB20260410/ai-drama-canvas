import { access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { enqueueGeneration, getGenerationSettings, listGenerationJobs, processGenerationQueue, upsertGenerationProvider } from "../src/core/generation.js";
import { scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import { seedProductionReady } from "../tests/workflow-helpers.js";
import { mkdtempOwnedFixtureRoot, resetOwnedFixtureRoot } from "./lib/owned-fixture-root.js";

const root = process.argv[2]
  ? await resetOwnedFixtureRoot(path.resolve(process.argv[2]), "prepare-comfyui-local-ui-fixture")
  : (await mkdtempOwnedFixtureRoot("ai-canvas-comfyui-local-ui", "prepare-comfyui-local-ui-fixture")).root;
const registryPath = path.resolve(process.argv[3] || path.join(os.tmpdir(), `ai-canvas-comfyui-local-ui-registry-${process.pid}.json`));
const endpoint = process.argv[4];
if (!endpoint) throw new Error("ComfyUI UI fixture 缺少 loopback endpoint。 ");
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

await access(registryPath).then(
  () => { throw new Error(`registry 必须是全新文件，拒绝覆盖：${registryPath}`); },
  () => undefined,
);
const config = await ensureSidecar(root);
config.sourceRoots = [];
config.outputRoots = [root];
config.hardLocks = [];
await writeJsonAtomic(getSidecarPaths(root).config, config);
const unit = path.join(root, "EP01_15s_001_ComfyUI桌面验收");
await mkdir(unit, { recursive: true });
await writeFile(path.join(unit, "00_信息.md"), "# ComfyUI 桌面验收\n\n首帧提示词：电影写实，完整黄金面具。\n尾帧提示词：保持角色、道具与场景连续。\n", "utf8");
await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#62472f" } }).png().toFile(path.join(unit, "EP01_15s_001_首帧_v1_raw.png"));
await scanAndPersist(root);
await seedProductionReady(root, "frames");

const settings = await getGenerationSettings(root);
const saved = await upsertGenerationProvider(root, {
  expectedRevision: settings.revision,
  setAsDefaultFor: "image",
  provider: {
    id: "comfyui-electron-loopback",
    name: "ComfyUI Electron 协议夹具",
    adapter: "comfyui-local",
    kinds: ["image"],
    enabled: true,
    endpoint,
    outputRoot: root,
    workflow: {
      schemaVersion: 1,
      name: "ComfyUI Electron Official Tuple",
      version: "2026.07.14",
      format: "comfyui-api",
      definition: {
        "6": { class_type: "CLIPTextEncode", inputs: { text: "materialized", clip: ["4", 1] } },
        "9": { class_type: "SaveImage", inputs: { filename_prefix: "AI_Canvas", images: ["8", 0] } },
      },
      comfyUi: { promptInputs: [{ nodeId: "6", inputName: "text" }], outputNodeId: "9", outputIndex: 0 },
    },
    capabilities: { referenceModes: ["text"], maxReferenceImages: 0, maxReferenceVideos: 0, supportedDurations: [], supportedAspectRatios: ["9:16"], supportedResolutions: ["720p"], models: [], maxConcurrency: 1, supportsCancel: true },
  },
});

const [created] = await enqueueGeneration(root, { itemIds: ["main-ep01-unit001"], kind: "image", providerId: "comfyui-electron-loopback", prompt: "电影写实，完整黄金面具，角色与道具连续，不得换脸。" });
if (!created) throw new Error("ComfyUI UI fixture 没有创建生成任务。 ");
await processGenerationQueue(root, { jobId: created.id });
const job = (await listGenerationJobs(root)).find((candidate) => candidate.id === created.id);
if (job?.status !== "waiting_remote" || job.comfyUiCheckpoint?.stage !== "queued" || !job.externalTaskId) throw new Error(`ComfyUI UI fixture 未停在 waiting_remote/queued：${JSON.stringify(job)}`);

process.stdout.write(`${JSON.stringify({ root, registryPath, endpoint, providerRevision: saved.revision, jobId: job.id, promptId: job.externalTaskId, checkpoint: job.comfyUiCheckpoint, remoteSubmitted: true, realComfyUiCalled: false }, null, 2)}\n`);
