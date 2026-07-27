import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeJsonAtomicExclusive } from "../src/core/sidecar.js";

const workspace = path.resolve(process.argv[2] ?? "/Users/hxx/Documents/无限画布");
const projectRoot = path.resolve(process.argv[3] ?? path.join(workspace, "productions/gushujuan-s3-f1a688020bfb7af6"));
const jobId = process.argv[4] ?? "gen-2026-07-16T12-10-57-215Z-892023c0";
const evidencePath = path.resolve(process.argv[5] ?? path.join(workspace, "docs/evidence/p1-generation-recovery-mcp-smoke-20260717.json"));
const sidecar = path.join(projectRoot, ".aicanvas");
const serverPath = path.join(workspace, "dist-mcp/mcp/server.js");

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFiles(files: Record<string, string>): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, filePath]) => [
    name,
    sha256(await readFile(filePath)),
  ])));
}

function parse<T>(value: unknown): T {
  const result = value as { isError?: boolean; content: Array<{ type: string; text?: string }> };
  const block = result.content.find((entry) => entry.type === "text" && typeof entry.text === "string");
  if (!block?.text) throw new Error("MCP 未返回文本结果。");
  if (result.isError) throw new Error(block.text);
  return JSON.parse(block.text) as T;
}

if (await access(evidencePath).then(() => true).catch(() => false)) {
  throw new Error(`证据文件已存在，拒绝覆盖：${evidencePath}`);
}
await mkdir(path.dirname(evidencePath), { recursive: true });
const guardedFiles = {
  generationJobs: path.join(sidecar, "generation-jobs.json"),
  generationSettings: path.join(sidecar, "generation.json"),
  publications: path.join(sidecar, "publications.json"),
  events: path.join(sidecar, "events.jsonl"),
  index: path.join(sidecar, "index.json"),
  overrides: path.join(sidecar, "overrides.json"),
  commandLedger: path.join(sidecar, "command-ledger.json"),
  subagentPlan: path.join(sidecar, "generation-requests", `${jobId}.subagent-imagegen.json`),
};
const beforeHashes = await hashFiles(guardedFiles);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: workspace,
  env: { ...process.env, AI_CANVAS_PROJECT_ROOT: projectRoot },
  stderr: "pipe",
});
const client = new Client({ name: "ai-drama-canvas-p1-generation-recovery-smoke", version: "0.1.0" });
const stderr: string[] = [];
transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const listGenerationSchema = tools.tools.find((tool) => tool.name === "list_generation_jobs")?.inputSchema as {
    properties?: { status?: { enum?: string[] } };
  } | undefined;
  const statuses = listGenerationSchema?.properties?.status?.enum ?? [];
  for (const status of ["generating", "generation_unknown", "candidate_generated", "visual_rejected"]) {
    if (!statuses.includes(status)) throw new Error(`list_generation_jobs 缺少 P1 状态：${status}`);
  }

  const capabilities = parse<{
    generation: { subagentImagegen: Record<string, unknown> };
    commandTypes: string[];
  }>(await client.callTool({ name: "get_capabilities", arguments: { projectRoot } }));
  const subagentCapabilities = capabilities.generation.subagentImagegen;
  if (subagentCapabilities.projectConcurrency !== 1
    || subagentCapabilities.providerConcurrency !== 1
    || subagentCapabilities.callIntentBeforeModel !== true
    || subagentCapabilities.callWithoutReceipt !== "generation_unknown-no-retry"
    || subagentCapabilities.rawLabeledPublicationBundleRequired !== true
    || !capabilities.commandTypes.includes("migrate_generation_execution_state")) {
    throw new Error(`P1 MCP 能力清单不完整：${JSON.stringify(subagentCapabilities)}`);
  }

  const doctor = parse<{
    summary: { errors: number; warnings: number; ok: number };
    checks: Array<{ id: string; level: string; detail: string; suggestedAction?: string }>;
    suggestedNextCalls: string[];
  }>(await client.callTool({ name: "doctor_project", arguments: { projectRoot } }));
  const generationCheck = doctor.checks.find((check) => check.id === "generation-jobs");
  if (generationCheck?.level !== "warning"
    || !generationCheck.detail.includes("调用结果不明 1")
    || !generationCheck.suggestedAction?.includes("严禁 claim、取消或重生")
    || JSON.stringify(doctor.suggestedNextCalls) !== JSON.stringify(["list_generation_jobs", "get_subagent_image_generation_plan", "list_publications", "doctor_project"])) {
    throw new Error(`P1 Doctor 未把 unknown 对账置为唯一下一动作：${JSON.stringify({ generationCheck, next: doctor.suggestedNextCalls })}`);
  }

  const jobs = parse<Array<Record<string, unknown>>>(await client.callTool({
    name: "list_generation_jobs",
    arguments: { projectRoot, status: "generation_unknown", limit: 50 },
  }));
  if (jobs.length !== 1) throw new Error(`P1 MCP unknown Job 数量不是 1：${jobs.length}`);
  const job = jobs[0] as {
    id?: string;
    status?: string;
    attempts?: number;
    resultPath?: string;
    companionPath?: string;
    publicationBundleId?: string;
    publicationIntentId?: string;
    publicationReceiptId?: string;
    companionPublicationIntentId?: string;
    companionPublicationReceiptId?: string;
    subagentCheckpoint?: { schemaVersion?: number; revision?: number; stage?: string; unknown?: { code?: string }; callIntent?: unknown; output?: unknown };
  };
  if (job.id !== jobId
    || job.status !== "generation_unknown"
    || job.attempts !== 1
    || job.resultPath
    || job.companionPath
    || job.publicationBundleId !== `generation-bundle-${jobId}`
    || job.publicationIntentId !== "publication-472b11c0-0821-4ed1-8051-32d8f046f565"
    || !job.companionPublicationIntentId
    || job.publicationReceiptId
    || job.companionPublicationReceiptId
    || job.subagentCheckpoint?.schemaVersion !== 2
    || job.subagentCheckpoint.revision !== 3
    || job.subagentCheckpoint.stage !== "generation_unknown"
    || job.subagentCheckpoint.unknown?.code !== "legacy_leased_without_call_receipt"
    || job.subagentCheckpoint.callIntent
    || job.subagentCheckpoint.output) {
    throw new Error(`P1 MCP Job 摘要不完整或错误：${JSON.stringify(job)}`);
  }

  const plan = parse<{
    jobId: string;
    publicationIntentId: string;
    publicationBundleId?: string;
    companionPublicationIntentId?: string;
    expectedOutputPath: string;
    expectedCompanionPath?: string;
    contract: Record<string, unknown>;
    currentCheckpoint?: { revision?: number; stage?: string; unknown?: { code?: string } };
  }>(await client.callTool({ name: "get_subagent_image_generation_plan", arguments: { projectRoot, jobId } }));
  if (plan.jobId !== jobId
    || plan.publicationBundleId !== job.publicationBundleId
    || plan.publicationIntentId !== job.publicationIntentId
    || plan.companionPublicationIntentId !== job.companionPublicationIntentId
    || !plan.expectedOutputPath.endsWith("_raw.png")
    || !plan.expectedCompanionPath?.endsWith("_labeled.png")
    || plan.contract.persistCallIntentBeforeModel !== true
    || plan.contract.rawLabeledBundleRequired !== true
    || plan.currentCheckpoint?.stage !== "generation_unknown"
    || plan.currentCheckpoint.unknown?.code !== "legacy_leased_without_call_receipt") {
    throw new Error(`P1 MCP 子代理计划与正式 Job 不一致：${JSON.stringify(plan)}`);
  }

  const publications = parse<{
    intents: Array<{ id: string; status: string; bundleId?: string; bundleMember?: string; receiptId?: string; reservationToken?: string }>;
    receipts: Array<{ id: string }>;
  }>(await client.callTool({ name: "list_publications", arguments: { projectRoot, status: "reserved", limit: 100 } }));
  const bundleIntents = publications.intents
    .filter((intent) => intent.bundleId === job.publicationBundleId)
    .sort((left, right) => String(left.bundleMember).localeCompare(String(right.bundleMember)));
  if (bundleIntents.length !== 2
    || bundleIntents.some((intent) => intent.status !== "reserved" || intent.receiptId || intent.reservationToken)
    || bundleIntents.map((intent) => intent.bundleMember).join(",") !== "companion,primary") {
    throw new Error(`P1 MCP Publication bundle 异常：${JSON.stringify(bundleIntents)}`);
  }

  const snapshot = parse<{
    generationJobs: Array<Record<string, unknown>>;
    suggestedNextCalls: string[];
    continuation: { prompt: string };
  }>(await client.callTool({ name: "get_project_snapshot", arguments: { projectRoot } }));
  const snapshotJob = snapshot.generationJobs.find((entry) => entry.id === jobId) as typeof job | undefined;
  if (!snapshotJob
    || snapshotJob.status !== "generation_unknown"
    || snapshotJob.publicationBundleId !== job.publicationBundleId
    || snapshotJob.companionPublicationIntentId !== job.companionPublicationIntentId
    || JSON.stringify(snapshot.suggestedNextCalls) !== JSON.stringify(["get_subagent_image_generation_plan", "list_publications", "doctor_project"])
    || !snapshot.continuation.prompt.includes("generation_unknown 只能对账")
    || !snapshot.continuation.prompt.includes("绝不重复调用")) {
    throw new Error(`P1 MCP 统一快照恢复路由异常：${JSON.stringify({ snapshotJob, next: snapshot.suggestedNextCalls })}`);
  }

  const continuation = parse<{
    generationRecovery: Array<{ jobId: string; status: string; subagentCheckpoint?: { stage?: string; revision?: number } }>;
    nextItems: unknown[];
    prompt: string;
  }>(await client.callTool({ name: "get_continuation", arguments: { projectRoot } }));
  const recovery = continuation.generationRecovery.find((entry) => entry.jobId === jobId);
  if (recovery?.status !== "generation_unknown"
    || recovery.subagentCheckpoint?.stage !== "generation_unknown"
    || recovery.subagentCheckpoint.revision !== 3
    || continuation.nextItems.length !== 0
    || !continuation.prompt.includes("generation_unknown 只能对账")
    || !continuation.prompt.includes("完成提交结果对账前禁止领取新任务或再次提交")) {
    throw new Error(`P1 MCP 接续快照没有阻断新任务：${JSON.stringify({ recovery, nextItems: continuation.nextItems.length })}`);
  }

  const prompt = await client.getPrompt({ name: "recover_interrupted_work", arguments: { projectRoot, jobId } });
  const promptText = (prompt.messages[0]?.content as { text?: string }).text ?? "";
  if (!promptText.includes("generation_unknown 只能核对既有调用证据")
    || !promptText.includes("严禁 claim、takeover、cancel、process 或再次调用生图")
    || !promptText.includes("raw/labeled Publication bundle")) {
    throw new Error("P1 MCP 中断恢复 Prompt 缺少 unknown/事务发布铁律。");
  }

  const combined = JSON.stringify({ jobs, plan, publications, snapshot, continuation });
  if (combined.includes("reservationToken") || combined.includes("publicationReservationToken") || combined.includes("companionPublicationReservationToken")) {
    throw new Error("P1 MCP 只读结果泄露了 Publication 预留令牌。");
  }
  const afterHashes = await hashFiles(guardedFiles);
  if (JSON.stringify(beforeHashes) !== JSON.stringify(afterHashes)) {
    throw new Error(`P1 MCP 只读烟测改写了正式状态：${JSON.stringify({ beforeHashes, afterHashes })}`);
  }

  const evidence = {
    schemaVersion: 1,
    kind: "p1-generation-recovery-mcp-smoke",
    createdAt: new Date().toISOString(),
    serverPath,
    projectRoot,
    jobId,
    guardedFiles: { beforeHashes, afterHashes, unchanged: true },
    tools: { count: tools.tools.length, generationStatusFilter: statuses },
    capabilities: {
      subagentImagegen: subagentCapabilities,
      migrationCommandExposed: capabilities.commandTypes.includes("migrate_generation_execution_state"),
    },
    doctor: {
      summary: doctor.summary,
      generationCheck,
      suggestedNextCalls: doctor.suggestedNextCalls,
    },
    job: {
      id: job.id,
      status: job.status,
      attempts: job.attempts,
      publicationBundleId: job.publicationBundleId,
      publicationIntentId: job.publicationIntentId,
      companionPublicationIntentId: job.companionPublicationIntentId,
      checkpoint: job.subagentCheckpoint,
    },
    plan: {
      jobId: plan.jobId,
      publicationBundleId: plan.publicationBundleId,
      publicationIntentId: plan.publicationIntentId,
      companionPublicationIntentId: plan.companionPublicationIntentId,
      expectedOutputPath: plan.expectedOutputPath,
      expectedCompanionPath: plan.expectedCompanionPath,
      contract: plan.contract,
      currentCheckpoint: plan.currentCheckpoint,
    },
    publications: { bundleIntents, matchingReceiptCount: publications.receipts.filter((receipt) => bundleIntents.some((intent) => intent.receiptId === receipt.id)).length },
    snapshot: { suggestedNextCalls: snapshot.suggestedNextCalls, job: snapshotJob, continuationPromptSha256: sha256(snapshot.continuation.prompt) },
    continuation: { recovery, nextItemCount: continuation.nextItems.length, promptSha256: sha256(continuation.prompt) },
    recoveryPromptSha256: sha256(promptText),
    secretExposure: false,
    stderrSha256: sha256(stderr.join("")),
    assertions: {
      newStatusesExposed: true,
      unknownJobAndBundleObservable: true,
      doctorPrioritizesReconciliation: true,
      snapshotPrioritizesReconciliation: true,
      continuationBlocksNewWork: true,
      recoveryPromptForbidsReplay: true,
      publicationTokensRedacted: true,
      readOnlyCallsDidNotWrite: true,
    },
  };
  await writeJsonAtomicExclusive(evidencePath, evidence);
  process.stdout.write(`${JSON.stringify({
    evidencePath,
    guardedFiles: evidence.guardedFiles,
    doctor: evidence.doctor,
    job: { id: job.id, status: job.status, attempts: job.attempts, publicationBundleId: job.publicationBundleId },
    continuation: evidence.continuation,
    assertions: evidence.assertions,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
