import { execFile } from "node:child_process";
import { access, copyFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runFullWorkflow } from "./full-workflow-smoke.js";
import { expectedRuntimeMcpToolCount } from "../src/core/release-manifest.js";

const execFileAsync = promisify(execFile);
const imageCriteria = ["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"] as const;
const videoCriteria = ["character_identity", "hard_lock", "prop_costume", "scene_continuity", "motion_continuity", "duration_audio", "image_quality"] as const;

function parseToolResult(result: unknown): unknown {
  const response = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = response.content?.find((entry) => entry.type === "text" && typeof entry.text === "string")?.text;
  if (!text) throw new Error("MCP 没有返回结构化文本。 ");
  const parsed = JSON.parse(text) as { error?: { message?: string }; status?: string; result?: unknown };
  if (response.isError) throw new Error(parsed.error?.message || text);
  return parsed.status === "succeeded" && Object.hasOwn(parsed, "result") ? parsed.result : parsed;
}

function textFromPrompt(result: Awaited<ReturnType<Client["getPrompt"]>>): string {
  return result.messages.map((message) => message.content.type === "text" ? message.content.text : "").join("\n");
}

function transportFor(projectRoot: string, registryPath: string): StdioClientTransport {
  const packagedRuntime = process.env.AI_CANVAS_MCP_RUNTIME?.trim();
  const compiledServer = process.env.AI_CANVAS_MCP_SERVER_PATH?.trim();
  const env = { ...process.env, AI_CANVAS_PROJECT_ROOT: projectRoot, AI_CANVAS_REGISTRY_PATH: registryPath };
  if (packagedRuntime && compiledServer) {
    return new StdioClientTransport({
      command: "/usr/bin/env",
      args: ["ELECTRON_RUN_AS_NODE=1", path.resolve(packagedRuntime), path.resolve(compiledServer)],
      cwd: process.cwd(),
      env,
      stderr: "pipe",
    });
  }
  if (compiledServer) return new StdioClientTransport({ command: process.execPath, args: [path.resolve(compiledServer)], cwd: process.cwd(), env, stderr: "pipe" });
  return new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp/server.ts"], cwd: process.cwd(), env, stderr: "pipe" });
}

async function waitForRender(client: Client, projectRoot: string, renderId: string): Promise<{ id: string; status: string; outputPath: string; error?: string }> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const job = parseToolResult(await client.callTool({ name: "get_edit_render_job", arguments: { projectRoot, renderId } })) as { id: string; status: string; outputPath: string; error?: string };
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`后台剪辑导出在 15 秒内没有结束：${renderId}`);
}

type McpReviewEntry = {
  item: { id: string };
  reviewType: "image" | "video";
  artifacts: Array<{ id: string; kind: string; variant: string; authoritative: boolean; deprecated: boolean }>;
  reviewSnapshot: { scanId: string; artifactHashes: Record<string, string> };
};

async function currentReviewEntry(client: Client, projectRoot: string, itemId: string): Promise<McpReviewEntry> {
  const queue = parseToolResult(await client.callTool({ name: "get_review_queue", arguments: { projectRoot, includeResolved: true, limit: 100 } })) as McpReviewEntry[];
  const entry = queue.find((candidate) => candidate.item.id === itemId);
  if (!entry) throw new Error(`get_review_queue 没有返回 ${itemId} 的内容快照。`);
  return entry;
}

function snapshotPayload(entry: McpReviewEntry, artifactIds: string[]) {
  return {
    expectedScanId: entry.reviewSnapshot.scanId,
    expectedArtifactHashes: Object.fromEntries(artifactIds.map((artifactId) => [artifactId, entry.reviewSnapshot.artifactHashes[artifactId]])),
  };
}

async function reviewVideo(client: Client, projectRoot: string, itemId: string, write: (name: string, args: Record<string, unknown>, key?: string) => Promise<unknown>, keySuffix = ""): Promise<{ item: { status: string }; record: { id: string } }> {
  const entry = await currentReviewEntry(client, projectRoot, itemId);
  const artifactIds = entry.artifacts.filter((artifact) => artifact.kind === "video" && artifact.authoritative && !artifact.deprecated).map((artifact) => artifact.id);
  if (!artifactIds.length) throw new Error(`${itemId} 没有可验收的权威视频。`);
  return await write("submit_review", {
    itemId,
    reviewType: "video",
    artifactIds,
    ...snapshotPayload(entry, artifactIds),
    decision: "pass",
    criteria: videoCriteria.map((key) => ({ key, result: "pass" })),
    note: "Headless MCP 隔离夹具视觉验收通过。",
  }, `headless-review-video-${itemId}${keySuffix ? `-${keySuffix}` : ""}`) as { item: { status: string }; record: { id: string } };
}

async function reviewCurrentImages(client: Client, projectRoot: string, itemId: string, write: (name: string, args: Record<string, unknown>, key?: string) => Promise<unknown>): Promise<void> {
  const entry = await currentReviewEntry(client, projectRoot, itemId);
  const artifactIds = entry.artifacts
    .filter((artifact) => ["raw-image", "labeled-image"].includes(artifact.kind) && ["start", "end"].includes(artifact.variant) && artifact.authoritative && !artifact.deprecated)
    .map((artifact) => artifact.id);
  await write("submit_review", {
    itemId,
    reviewType: "image",
    artifactIds,
    ...snapshotPayload(entry, artifactIds),
    decision: "pass",
    criteria: imageCriteria.map((key) => ({ key, result: "pass" })),
    note: "Headless MCP 已对续接产生的当前首帧版本重新完成视觉验收。",
  }, `headless-review-current-images-${itemId}`);
}

export async function runMcpHeadlessWorkflow(projectRoot: string, registryPath: string): Promise<Record<string, unknown>> {
  const root = path.resolve(projectRoot);
  const registry = path.resolve(registryPath);
  const bootstrap = await runFullWorkflow(root, registry);
  const transport = transportFor(root, registry);
  const client = new Client({ name: "ai-drama-canvas-headless-e2e", version: "0.1.0" });
  transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  let writeCounter = 0;
  const write = async (name: string, args: Record<string, unknown>, key = `headless-${name}-${++writeCounter}`): Promise<unknown> => {
    const result = await client.callTool({
      name,
      arguments: { projectRoot: root, requestId: `request-${key}-${writeCounter}`.slice(0, 160), idempotencyKey: key, ...args },
    });
    return parseToolResult(result);
  };

  try {
    await client.connect(transport);
    const [tools, resources, templates, prompts] = await Promise.all([client.listTools(), client.listResources(), client.listResourceTemplates(), client.listPrompts()]);
    const capabilities = parseToolResult(await client.callTool({ name: "get_capabilities", arguments: { projectRoot: root } })) as { server: { toolCount: number }; commandTypes: string[]; editor?: { mediaScheduling?: { foregroundHeavyJobsPerProject?: number; activeRenderBlocksForegroundJobs?: boolean } } };
    const initialDoctor = parseToolResult(await client.callTool({ name: "doctor_project", arguments: { projectRoot: root } })) as { healthy: boolean; summary: { errors: number; warnings: number; ok: number } };
    const initialSnapshot = parseToolResult(await client.callTool({ name: "get_project_snapshot", arguments: { projectRoot: root, focusItemId: "main-ep01-unit003" } })) as { project: { id: string }; focus?: { id: string }; scan: { scanId: string }; runtimeResources?: { scan?: { active?: boolean }; editor?: { foregroundCapacity?: number; renderCapacity?: number }; blockedActions?: string[] }; productionDesign?: { evidence?: { nextRepair?: { stageId: string; reason: string; mustRepairEvidenceFirst: boolean; executeCommand?: { tool: string; request?: { command?: string; payload?: { expectedRevision?: number } } } } } } };
    const expectedToolCount = await expectedRuntimeMcpToolCount(process.cwd());
    if (capabilities.server.toolCount !== tools.tools.length || tools.tools.length !== expectedToolCount) throw new Error("capabilities、release manifest 与真实 MCP 工具集合不一致。 ");
    if (!tools.tools.some((tool) => tool.name === "get_studio_continuity_review_control")) throw new Error("MCP 工具集合缺少连续性与 Review 只读控制工具。 ");
    if (capabilities.editor?.mediaScheduling?.foregroundHeavyJobsPerProject !== 1 || !capabilities.editor.mediaScheduling.activeRenderBlocksForegroundJobs) throw new Error("capabilities 没有公开项目级媒体容量合同。 ");
    if (initialSnapshot.focus?.id !== "main-ep01-unit003") throw new Error("统一快照没有读取到 headless 目标节点。 ");
    if (initialSnapshot.runtimeResources?.scan?.active !== false || initialSnapshot.runtimeResources.editor?.foregroundCapacity !== 1 || initialSnapshot.runtimeResources.editor.renderCapacity !== 1 || initialSnapshot.runtimeResources.blockedActions?.length) throw new Error("统一快照没有返回空闲且可执行的资源状态。 ");
    const initialRepair = initialSnapshot.productionDesign?.evidence?.nextRepair;
    if (initialRepair?.stageId !== "frames" || initialRepair.reason !== "evidence_drift" || !initialRepair.mustRepairEvidenceFirst || initialRepair.executeCommand?.tool !== "execute_command" || initialRepair.executeCommand.request?.command !== "update_workflow_stage" || !Number.isInteger(initialRepair.executeCommand.request.payload?.expectedRevision)) throw new Error("统一快照没有返回可执行的首尾帧证据修复合同。 ");

    const generationSettings = parseToolResult(await client.callTool({ name: "get_generation_settings", arguments: { projectRoot: root } })) as { revision: number };
    const configuredSettings = await write("upsert_generation_provider", {
      expectedRevision: generationSettings.revision,
      provider: {
        id: "headless-browser",
        name: "Headless MCP 网页生成",
        adapter: "codex-browser",
        kinds: ["image", "video"],
        enabled: true,
        siteUrl: "https://example.com/generate",
        browserInstructions: "仅使用任务包白名单和结构化检查点。",
        workflow: { schemaVersion: 1, name: "Headless browser recipe", version: "1", format: "browser-recipe", definition: { mode: "cinematic", slots: ["first_frame", "last_frame"] } },
        outputRoot: root,
      },
    }, "headless-upsert-generation-provider") as { revision: number };
    const configuredProvider = parseToolResult(await client.callTool({ name: "get_generation_provider", arguments: { projectRoot: root, providerId: "headless-browser" } })) as { settingsRevision: number; provider: { id: string; workflow?: { definition?: unknown } } };
    if (configuredProvider.settingsRevision !== configuredSettings.revision || configuredProvider.provider.id !== "headless-browser" || !configuredProvider.provider.workflow?.definition) throw new Error("Headless MCP 没有按修订号持久化生成供应商工作流。 ");

    const taskKey = "headless-create-unit003-video-task";
    const createdTask = await write("create_task_pack", { itemIds: ["main-ep01-unit003"], kind: "video", mode: "autopilot" }, taskKey) as { task: { id: string; revision: number; itemIds: string[] }; path: string };
    const replayedTask = await write("create_task_pack", { itemIds: ["main-ep01-unit003"], kind: "video", mode: "autopilot" }, taskKey) as typeof createdTask;
    if (replayedTask.task.id !== createdTask.task.id) throw new Error("相同幂等键重放创建了第二个任务包。 ");
    const claimed = await write("claim_task", { taskId: createdTask.task.id, agentId: "codex-headless", leaseSeconds: 900, expectedRevision: createdTask.task.revision }) as { id: string; revision: number; lease?: { id: string } };
    if (!claimed.lease?.id) throw new Error("Headless MCP 没有取得任务租约。 ");

    const [videoJob] = await write("enqueue_generation", { itemIds: ["main-ep01-unit003"], kind: "video", taskId: createdTask.task.id }) as Array<{ id: string; status: string; expectedOutputPath: string }>;
    if (!videoJob) throw new Error("Headless MCP 没有创建视频生成任务。 ");
    const submitted = await write("process_generation_queue", { jobId: videoJob.id }) as { processedJobId?: string; recent: Array<{ id: string; status: string; expectedOutputPath: string }> };
    const waiting = submitted.recent.find((job) => job.id === videoJob.id);
    if (waiting?.status !== "waiting_external") throw new Error("Headless MCP 生成任务没有进入文件桥接等待态。 ");
    await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=24000/1001", "-t", "1.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", waiting.expectedOutputPath]);
    const processed = await write("process_generation_queue", { jobId: videoJob.id }) as { processedJobId?: string; recent: Array<{ id: string; status: string; publicationReceiptId?: string }> };
    const succeeded = processed.recent.find((job) => job.id === videoJob.id);
    if (succeeded?.status !== "succeeded" || !succeeded.publicationReceiptId) throw new Error("Headless MCP 视频没有完成机械验收与发布登记。 ");

    const awaitingReview = await write("finish_batch", {
      taskId: createdTask.task.id,
      leaseId: claimed.lease.id,
      agentId: "codex-headless",
      expectedRevision: claimed.revision,
      completedItemIds: ["main-ep01-unit003"],
      failedItemIds: [],
      note: "Headless MCP 已确认新视频路径、ffprobe、SHA-256 和发布回执。",
    }) as { status: string; result?: { reviewRequirements?: Record<string, { artifactIds: string[] }> } };
    const reviewArtifactIds = awaitingReview.result?.reviewRequirements?.["main-ep01-unit003"]?.artifactIds ?? [];
    const unit3ReviewEntry = await currentReviewEntry(client, root, "main-ep01-unit003");
    const unit3Review = await write("submit_review", {
      itemId: "main-ep01-unit003",
      reviewType: "video",
      artifactIds: reviewArtifactIds,
      ...snapshotPayload(unit3ReviewEntry, reviewArtifactIds),
      decision: "pass",
      criteria: videoCriteria.map((key) => ({ key, result: "pass" })),
      note: "Headless MCP 隔离夹具视频视觉验收通过。",
    }) as { item: { status: string }; record: { id: string } };
    if (unit3Review.item.status !== "已完成") throw new Error("任务包视频验收后节点没有完成。 ");

    const editProject = await write("create_edit_project", { name: "Headless MCP EP01", episode: 1, width: 360, height: 640, fps: 23.976, autoPopulate: true }) as { id: string; revision: number; tracks: Array<{ kind: string; clips: Array<{ id: string; kind: string; startSeconds: number; durationSeconds: number }> }>; timebase: { rateNumerator: number; rateDenominator: number } };
    const clip = editProject.tracks.find((track) => track.kind === "visual")?.clips.find((candidate) => candidate.kind === "video");
    if (!clip) throw new Error("Headless MCP 剪辑工程没有载入权威视频。 ");
    const splitAt = clip.startSeconds + Math.min(0.45, clip.durationSeconds / 2);
    const split = await write("apply_edit_operation", { editProjectId: editProject.id, expectedRevision: editProject.revision, operation: { type: "split_clip", clipId: clip.id, timeSeconds: splitAt } }) as { editProjectId: string; revision: number; affectedTrackIds: string[]; affectedClipIds: string[] };
    const splitProject = parseToolResult(await client.callTool({ name: "get_edit_project", arguments: { projectRoot: root, editProjectId: split.editProjectId } })) as { id: string; revision: number; tracks: Array<{ clips: unknown[] }>; timebase: { rateNumerator: number; rateDenominator: number } };
    if (splitProject.revision !== split.revision || splitProject.timebase.rateNumerator !== 24_000 || splitProject.timebase.rateDenominator !== 1_001) throw new Error("Headless MCP 剪辑操作丢失修订号或分数时间基。 ");
    const renderStarted = await write("start_edit_render", { editProjectId: editProject.id, expectedRevision: splitProject.revision }) as { id: string; status: string; outputPath: string };
    const rendered = await waitForRender(client, root, renderStarted.id);
    if (rendered.status !== "succeeded") throw new Error(`Headless MCP 后台渲染失败：${rendered.error ?? "未知错误"}`);
    await access(rendered.outputPath);

    const prepared = await write("prepare_timeline_continuation", {
      editProjectId: editProject.id,
      targetItemId: "main-ep01-unit004",
      expectedRevision: splitProject.revision,
      prompt: "承接时间线合成末帧继续前进，保持完整黄金面具、角色身份、空间方向与雾中光线连续。",
      enqueue: true,
    }, "headless-prepare-unit004-continuation") as { pack: { id: string }; generationJob?: { id: string } };
    if (!prepared.generationJob) throw new Error("Headless MCP 时间线续接没有创建生成任务。 ");
    const continuationSubmitted = await write("process_generation_queue", { jobId: prepared.generationJob.id }) as { processedJobId?: string; recent: Array<{ id: string; status: string; expectedOutputPath: string }> };
    const continuationWaiting = continuationSubmitted.recent.find((job) => job.id === prepared.generationJob!.id);
    if (continuationWaiting?.status !== "waiting_external") throw new Error("Headless MCP 续接生成没有进入等待态。 ");
    await copyFile(rendered.outputPath, continuationWaiting.expectedOutputPath);
    const continuationProcessed = await write("process_generation_queue", { jobId: prepared.generationJob.id }) as { processedJobId?: string; recent: Array<{ id: string; status: string; publicationReceiptId?: string }> };
    const continuationJob = continuationProcessed.recent.find((job) => job.id === prepared.generationJob!.id);
    if (continuationJob?.status !== "succeeded" || !continuationJob.publicationReceiptId) throw new Error("Headless MCP 续接视频没有取得发布回执。 ");
    const continuationPacks = parseToolResult(await client.callTool({ name: "list_video_continuations", arguments: { projectRoot: root, itemId: "main-ep01-unit004" } })) as Array<{ id: string; status: string; outputVideoPath?: string }>;
    const completedPack = continuationPacks.find((pack) => pack.id === prepared.pack.id);
    if (completedPack?.status !== "completed" || !completedPack.outputVideoPath) throw new Error("续接生成成功后包状态没有自动闭合。 ");
    const workflow = parseToolResult(await client.callTool({ name: "get_production_workflow", arguments: { projectRoot: root } })) as { revision: number; evidenceAudit?: { workflowRevision: number; stages: Array<{ stageId: string; ready: boolean; issues: string[] }> } };
    if (workflow.evidenceAudit?.workflowRevision !== workflow.revision || workflow.evidenceAudit.stages.length !== 15) throw new Error("Headless MCP 没有返回 15 阶段实时证据审计。 ");
    if (!workflow.evidenceAudit.stages.find((stage) => stage.stageId === "frames")?.issues.some((issue) => issue.includes("main-ep01-unit002"))) throw new Error("实时证据审计没有暴露续接首帧造成的局部视觉验收漂移。 ");
    await reviewCurrentImages(client, root, "main-ep01-unit002", write);
    await reviewCurrentImages(client, root, "main-ep01-unit004", write);
    const unit2Review = await reviewVideo(client, root, "main-ep01-unit002", write, "post-frame-recheck");
    const unit4Review = await reviewVideo(client, root, "main-ep01-unit004", write, "post-frame-recheck");
    if (unit4Review.item.status !== "已完成" || unit2Review.item.status !== "已完成") throw new Error("续接首帧重新验收后，视频视觉验收没有完成目标节点。 ");
    const repairedWorkflow = parseToolResult(await client.callTool({ name: "get_production_workflow", arguments: { projectRoot: root } })) as { revision: number; evidenceAudit?: { stages: Array<{ stageId: string; ready: boolean; issues: string[] }> } };
    if (!repairedWorkflow.evidenceAudit?.stages.find((stage) => stage.stageId === "frames")?.ready) throw new Error("续接首帧重新验收后，首尾帧阶段证据仍未恢复。 ");
    const completedVideoStage = await write("update_production_workflow_stage", { stageId: "video", status: "completed", expectedRevision: repairedWorkflow.revision, note: "四个单元均有当前权威可解码视频与视觉通过记录。" }) as { revision: number; stages: Array<{ id: string; status: string }> };
    if (completedVideoStage.stages.find((stage) => stage.id === "video")?.status !== "completed") throw new Error("Headless MCP 没有通过真实视频阶段门禁。 ");
    const completedEditStage = await write("update_production_workflow_stage", { stageId: "edit", status: "completed", expectedRevision: completedVideoStage.revision, evidencePaths: [rendered.outputPath], note: "Headless MCP 后台成片已通过 ffprobe。" }) as { stages: Array<{ id: string; status: string }> };
    if (completedEditStage.stages.find((stage) => stage.id === "edit")?.status !== "completed") throw new Error("Headless MCP 没有通过真实剪辑阶段门禁。 ");

    const chapters = parseToolResult(await client.callTool({ name: "list_story_chapters", arguments: { projectRoot: root, limit: 10 } })) as Array<{ id: string }>;
    const unit3 = parseToolResult(await client.callTool({ name: "get_item", arguments: { projectRoot: root, itemId: "main-ep01-unit003" } })) as { artifacts: Array<{ id: string; kind: string; authoritative: boolean }> };
    const unit3VideoArtifact = unit3.artifacts.find((artifact) => artifact.kind === "video" && artifact.authoritative);
    if (!chapters[0] || !unit3VideoArtifact) throw new Error("Resource 验收缺少章节或权威视频 ID。 ");
    const resourceUris = [
      `aicanvas://projects/${initialSnapshot.project.id}/snapshot`,
      `aicanvas://projects/${initialSnapshot.project.id}/items/main-ep01-unit003`,
      `aicanvas://projects/${initialSnapshot.project.id}/artifacts/${unit3VideoArtifact.id}`,
      `aicanvas://projects/${initialSnapshot.project.id}/canvas`,
      `aicanvas://projects/${initialSnapshot.project.id}/tasks`,
      `aicanvas://projects/${initialSnapshot.project.id}/generation/${prepared.generationJob.id}`,
      `aicanvas://projects/${initialSnapshot.project.id}/editor/${editProject.id}`,
      `aicanvas://projects/${initialSnapshot.project.id}/story/chapters/${chapters[0].id}`,
      `aicanvas://projects/${initialSnapshot.project.id}/changes/start`,
    ];
    for (const uri of resourceUris) {
      const result = await client.readResource({ uri });
      const content = result.contents[0];
      if (!content || !("text" in content) || !content.text.trim()) throw new Error(`Resource 没有返回结构化文本：${uri}`);
      JSON.parse(content.text);
    }

    const promptResults = await Promise.all([
      client.getPrompt({ name: "resume_project", arguments: { projectRoot: root, focusItemId: "main-ep01-unit003" } }),
      client.getPrompt({ name: "produce_next_image_batch", arguments: { projectRoot: root, episode: "1" } }),
      client.getPrompt({ name: "produce_next_video_batch", arguments: { projectRoot: root, episode: "1" } }),
      client.getPrompt({ name: "run_browser_generation", arguments: { projectRoot: root, jobId: prepared.generationJob.id } }),
      client.getPrompt({ name: "continue_video_from_last_frame", arguments: { projectRoot: root, itemId: "main-ep01-unit004", editProjectId: editProject.id } }),
      client.getPrompt({ name: "review_visual_batch", arguments: { projectRoot: root, reviewType: "video" } }),
      client.getPrompt({ name: "recover_interrupted_work", arguments: { projectRoot: root, lastCursor: "start", jobId: prepared.generationJob.id } }),
    ]);
    const promptTexts = promptResults.map(textFromPrompt);
    if (promptTexts.some((text) => text.length < 80) || !promptTexts[3]!.includes("status=preflight") || !promptTexts[3]!.includes("status=uploaded")) throw new Error("MCP Prompts 未返回完整、安全且有序的执行说明。 ");

    const ledger = parseToolResult(await client.callTool({ name: "list_command_ledger", arguments: { projectRoot: root, limit: 500 } })) as Array<{ status: string; idempotencyKey: string }>;
    const finalDoctor = parseToolResult(await client.callTool({ name: "doctor_project", arguments: { projectRoot: root } })) as { healthy: boolean; summary: { errors: number; warnings: number; ok: number }; checks: Array<{ id: string; level: string; detail: string }> };
    const finalSnapshot = parseToolResult(await client.callTool({ name: "get_project_snapshot", arguments: { projectRoot: root, focusItemId: "main-ep01-unit004" } })) as { focus?: { status: string }; generationJobs: Array<{ status: string }>; renderJobs: Array<{ status: string }>; videoContinuations: Array<{ status: string }>; runtimeResources?: { editor?: { activeRenderIds?: string[] }; blockedActions?: string[] } };
    if (finalSnapshot.runtimeResources?.editor?.activeRenderIds?.length || finalSnapshot.runtimeResources?.blockedActions?.length) throw new Error("Headless 闭环结束后仍残留媒体资源占用。 ");
    const uncertainCommands = ledger.filter((entry) => ["running", "unknown"].includes(entry.status));
    if (uncertainCommands.length || finalDoctor.summary.errors) {
      const doctorErrors = finalDoctor.checks.filter((check) => check.level === "error").map((check) => `${check.id}：${check.detail}`).join("；");
      throw new Error(`Headless MCP 闭环结束后仍有未确认命令或 Doctor 错误：uncertainCommands=${uncertainCommands.length}${doctorErrors ? `；${doctorErrors}` : ""}`);
    }

    return {
      root,
      registryPath: registry,
      bootstrap: { splitUnits: bootstrap.splitUnits, restartVerified: bootstrap.restartVerified },
      transport: process.env.AI_CANVAS_MCP_RUNTIME ? "packaged-electron-node" : process.env.AI_CANVAS_MCP_SERVER_PATH ? "compiled-node" : "source-stdio",
      desktopUiLaunched: false,
      toolCount: tools.tools.length,
      staticResources: resources.resources.length,
      resourceTemplates: templates.resourceTemplates.length,
      resourceReads: resourceUris.length,
      prompts: prompts.prompts.length,
      promptReads: promptResults.length,
      commandTypes: capabilities.commandTypes.length,
      initialDoctor: initialDoctor.summary,
      generationProvider: { id: configuredProvider.provider.id, settingsRevision: configuredProvider.settingsRevision },
      task: { id: createdTask.task.id, replayedId: replayedTask.task.id, status: awaitingReview.status, finalItemStatus: unit3Review.item.status },
      generation: { jobId: videoJob.id, status: succeeded.status, publicationReceiptId: succeeded.publicationReceiptId },
      editor: { id: editProject.id, revision: splitProject.revision, clips: splitProject.tracks.flatMap((track) => track.clips).length, timebase: splitProject.timebase, renderId: rendered.id, renderStatus: rendered.status, renderPath: rendered.outputPath },
      continuation: { id: completedPack.id, status: completedPack.status, outputPath: completedPack.outputVideoPath, reviewStatus: unit4Review.item.status },
      workflow: { video: "completed", edit: "completed" },
      ledgerEntries: ledger.length,
      uncertainCommands: uncertainCommands.length,
      finalDoctor: finalDoctor.summary,
      finalSnapshot: { focusStatus: finalSnapshot.focus?.status, succeededGenerations: finalSnapshot.generationJobs.filter((job) => job.status === "succeeded").length, succeededRenders: finalSnapshot.renderJobs.filter((job) => job.status === "succeeded").length, completedContinuations: finalSnapshot.videoContinuations.filter((pack) => pack.status === "completed").length, runtimeResourcesIdle: !finalSnapshot.runtimeResources?.editor?.activeRenderIds?.length && !finalSnapshot.runtimeResources?.blockedActions?.length },
    };
  } finally {
    await client.close();
  }
}

const projectRoot = path.resolve(process.argv[2] || "/tmp/ai-canvas-mcp-headless-workflow-20260713");
const registryPath = path.resolve(process.argv[3] || "/tmp/ai-canvas-mcp-headless-workflow-registry-20260713.json");
process.stdout.write(`${JSON.stringify(await runMcpHeadlessWorkflow(projectRoot, registryPath), null, 2)}\n`);
