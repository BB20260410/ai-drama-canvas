import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MEDIA_WEIGHTS, readMachineMediaRuntimeSnapshot, runMediaProcess, startManagedMediaProcess } from "../src/core/media-runtime.js";

const evidencePath = path.resolve(process.argv[2] || path.join("docs", "evidence", `media-runtime-smoke-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}.json`));
const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-media-smoke-"));
const runtimeDirectory = path.join(root, "runtime");
const projectA = path.join(root, "project-a");
const projectB = path.join(root, "project-b");
const ffmpeg = process.env.AI_CANVAS_FFMPEG || "ffmpeg";
const ffprobe = process.env.AI_CANVAS_FFPROBE || "ffprobe";
process.env.AI_CANVAS_MEDIA_RUNTIME_DIR = runtimeDirectory;
process.env.AI_CANVAS_MEDIA_CAPACITY = "4";

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`真实媒体 smoke 等待条件超过 ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function compactResult(result: Awaited<ReturnType<typeof runMediaProcess>>) {
  return { status: result.status, code: result.code, signal: result.signal, waitMs: result.waitMs, durationMs: result.durationMs, leaseId: result.leaseId };
}

let evidence: Record<string, unknown>;
try {
  await Promise.all([mkdir(projectA, { recursive: true }), mkdir(projectB, { recursive: true })]);
  const seedPath = path.join(projectA, "seed.mp4");
  const renderPath = path.join(projectA, "render.mp4");
  const foregroundPath = path.join(projectB, "foreground.mp4");
  const seed = await runMediaProcess(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", seedPath], {
    projectRoot: projectA,
    tool: "ffmpeg",
    stage: "smoke-seed",
    weight: MEDIA_WEIGHTS.foreground,
    timeoutMs: 60_000,
  });
  if (seed.status !== "succeeded") throw new Error(`真实 FFmpeg 种子生成失败：${seed.output.slice(-2_000)}`);

  const render = await startManagedMediaProcess(ffmpeg, ["-hide_banner", "-loglevel", "error", "-re", "-i", seedPath, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", renderPath], {
    projectRoot: projectA,
    tool: "ffmpeg",
    stage: "smoke-render",
    weight: MEDIA_WEIGHTS.render,
    timeoutMs: 60_000,
  });
  await waitUntil(async () => (await readMachineMediaRuntimeSnapshot()).active.some((entry) => entry.stage === "smoke-render"));

  // 延迟包装器仍会实际执行本机 ffprobe，只为留下足够观察窗口，证明权重 3 的
  // 渲染与权重 1 的探测可以并行占满容量 4。
  const delayedProbePath = path.join(root, "delayed-ffprobe.mjs");
  await writeFile(delayedProbePath, `import { spawn } from "node:child_process";\nconst [command,...args]=process.argv.slice(2);\nsetTimeout(()=>{const child=spawn(command,args,{stdio:["ignore","inherit","inherit"]});child.once("error",()=>process.exit(127));child.once("close",(code)=>process.exit(code??1));},500);\n`, "utf8");
  const delayedProbe = runMediaProcess(process.execPath, [delayedProbePath, ffprobe, "-v", "error", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "json", seedPath], {
    projectRoot: projectB,
    tool: "ffprobe",
    stage: "smoke-probe",
    weight: MEDIA_WEIGHTS.probe,
    timeoutMs: 30_000,
  });
  await waitUntil(async () => (await readMachineMediaRuntimeSnapshot()).active.some((entry) => entry.stage === "smoke-probe"));
  const foreground = runMediaProcess(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", foregroundPath], {
    projectRoot: projectB,
    tool: "ffmpeg",
    stage: "smoke-foreground",
    weight: MEDIA_WEIGHTS.foreground,
    timeoutMs: 60_000,
  });
  await waitUntil(async () => (await readMachineMediaRuntimeSnapshot()).queued.some((entry) => entry.stage === "smoke-foreground"));
  const peak = await readMachineMediaRuntimeSnapshot();
  const [renderResult, probeResult, foregroundResult] = await Promise.all([render.completion, delayedProbe, foreground]);
  for (const [name, result] of [["render", renderResult], ["probe", probeResult], ["foreground", foregroundResult]] as const) {
    if (result.status !== "succeeded") throw new Error(`真实 ${name} 任务失败：${result.output.slice(-2_000)}`);
  }
  const validate = (projectRoot: string, filePath: string, stage: string) => runMediaProcess(ffprobe, ["-v", "error", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "json", filePath], {
    projectRoot,
    tool: "ffprobe",
    stage,
    weight: MEDIA_WEIGHTS.probe,
    timeoutMs: 30_000,
  });
  const [renderValidation, foregroundValidation] = await Promise.all([
    validate(projectA, renderPath, "smoke-validation-render"),
    validate(projectB, foregroundPath, "smoke-validation-foreground"),
  ]);
  if (renderValidation.status !== "succeeded" || foregroundValidation.status !== "succeeded") throw new Error(`真实 ffprobe 终检失败：${renderValidation.output.slice(-1_000)}\n${foregroundValidation.output.slice(-1_000)}`);
  const final = await readMachineMediaRuntimeSnapshot();
  if (peak.activeWeight !== 4 || !peak.queued.some((entry) => entry.stage === "smoke-foreground")) throw new Error("未观察到预期的容量 4 峰值和前台任务排队。 ");
  if (final.activeWeight !== 0 || final.queueDepth !== 0 || final.metrics.maxObservedWeight > final.capacity) throw new Error("真实媒体任务结束后运行时没有完全释放，或曾超过机器容量。 ");
  const files = await Promise.all([seedPath, renderPath, foregroundPath].map(async (filePath) => ({ name: path.basename(filePath), size: (await stat(filePath)).size, sha256: await sha256(filePath) })));
  evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    success: true,
    command: "npm run media:runtime-smoke -- <evidence-path>",
    environment: { platform: process.platform, arch: process.arch, node: process.version, ffmpeg, ffprobe, isolatedRuntime: true },
    scheduling: {
      capacity: peak.capacity,
      peakActiveWeight: peak.activeWeight,
      peakActive: peak.active.map((entry) => ({ tool: entry.tool, stage: entry.stage, weight: entry.weight, ownerAlive: entry.ownerAlive })),
      peakQueued: peak.queued.map((entry) => ({ tool: entry.tool, stage: entry.stage, weight: entry.weight, ownerAlive: entry.ownerAlive })),
      final: { activeWeight: final.activeWeight, queueDepth: final.queueDepth, metrics: final.metrics },
    },
    results: { seed: compactResult(seed), render: compactResult(renderResult), probe: compactResult(probeResult), foreground: compactResult(foregroundResult), renderValidation: compactResult(renderValidation), foregroundValidation: compactResult(foregroundValidation) },
    validation: { render: JSON.parse(renderValidation.stdout) as unknown, foreground: JSON.parse(foregroundValidation.stdout) as unknown },
    files,
  };
} catch (error) {
  evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), success: false, error: error instanceof Error ? error.message : String(error) };
} finally {
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence!, null, 2)}\n`, "utf8");
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ success: evidence!.success, evidencePath })}\n`);
if (!evidence!.success) process.exitCode = 1;
