import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expectedRuntimeMcpToolCount } from "../src/core/release-manifest.js";

interface CalibrationState {
  schemaVersion: 1;
  projectRoot: string;
  registryPath: string;
  masterEditProjectId: string;
  masterRevision: number;
  mcpWritableClipId: string;
  continuationPackId: string;
  [key: string]: unknown;
}

interface ToolEnvelope {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

const workspace = path.resolve(process.cwd());
const expectedMcpToolCount = await expectedRuntimeMcpToolCount(workspace);
const statePath = path.resolve(process.argv[2] || "formal-calibration/calibration-state.json");
const evidencePath = path.resolve(process.argv[3] || "docs/evidence/formal-project-nle-mcp-smoke.json");
const state = JSON.parse(await readFile(statePath, "utf8")) as CalibrationState;
const projectRoot = path.resolve(state.projectRoot);
const registryPath = path.resolve(state.registryPath);
const compiledServer = path.join(workspace, "dist-mcp", "mcp", "server.js");

function parse(result: unknown): any {
  const envelope = result as ToolEnvelope;
  const text = envelope.content?.find((entry) => entry.type === "text" && typeof entry.text === "string")?.text;
  if (!text) throw new Error(`MCP 未返回文本 JSON：${JSON.stringify(envelope)}`);
  if (envelope.isError) throw new Error(text);
  return JSON.parse(text);
}

async function fileEvidence(filePath: string) {
  const buffer = await readFile(filePath);
  return { path: filePath, bytes: (await stat(filePath)).size, sha256: createHash("sha256").update(buffer).digest("hex") };
}

async function connect(kind: "source" | "compiled") {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: kind === "source" ? ["--import", "tsx", "src/mcp/server.ts"] : [compiledServer],
    cwd: workspace,
    env: { ...process.env, AI_CANVAS_PROJECT_ROOT: projectRoot, AI_CANVAS_REGISTRY_PATH: registryPath },
    stderr: "pipe",
  });
  const client = new Client({ name: `aicanvas-formal-nle-${kind}`, version: "1.0.0" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

const sourceConnection = await connect("source");
let source: Record<string, unknown>;
let updatedRevision: number;
try {
  const tools = await sourceConnection.client.listTools();
  const capabilities = parse(await sourceConnection.client.callTool({ name: "get_capabilities", arguments: { projectRoot } }));
  const progress = parse(await sourceConnection.client.callTool({ name: "get_progress", arguments: { projectRoot } }));
  const before = parse(await sourceConnection.client.callTool({ name: "get_edit_project", arguments: { projectRoot, editProjectId: state.masterEditProjectId } }));
  const marker = `formal-nle-source-mcp-${state.masterEditProjectId}`;
  const persistedNote = "正式封神篇 NLE：source MCP CAS 已验证，等待 compiled fresh-process 复读。";
  const beforeClip = before.tracks?.flatMap((track: any) => track.clips ?? []).find((candidate: any) => candidate.id === state.mcpWritableClipId);
  const sourceLedger = parse(await sourceConnection.client.callTool({ name: "list_command_ledger", arguments: { projectRoot, limit: 200 } }));
  const existingLedger = sourceLedger.find((entry: any) => entry.idempotencyKey === `${marker}-idempotency-v1`);
  const existingLedgerRevision = Number(existingLedger?.result?.revision);
  const recoveredPriorCommittedWrite = existingLedger?.status === "succeeded"
    && existingLedgerRevision === before.revision
    && [state.masterRevision, state.masterRevision + 1].includes(before.revision)
    && String(beforeClip?.note ?? "").includes("source MCP CAS 已验证");
  if (before.revision !== state.masterRevision && !recoveredPriorCommittedWrite) throw new Error(`MCP 写入前 master revision 漂移：state=${state.masterRevision}, live=${before.revision}`);
  const commandExpectedRevision = recoveredPriorCommittedWrite ? existingLedgerRevision - 1 : state.masterRevision;
  if (!Number.isInteger(commandExpectedRevision) || commandExpectedRevision < 1) throw new Error(`无法证明 source MCP 原始 CAS 基线：${JSON.stringify(existingLedger)}`);
  const request = {
    projectRoot,
    requestId: `${marker}-request-1`,
    idempotencyKey: `${marker}-idempotency-v1`,
    request: {
      command: "apply_edit_operation",
      payload: {
        editProjectId: state.masterEditProjectId,
        expectedRevision: commandExpectedRevision,
        operation: { type: "update_clip", clipId: state.mcpWritableClipId, patch: { note: persistedNote } },
      },
    },
  };
  const updatedRaw = await sourceConnection.client.callTool({ name: "execute_command", arguments: request }) as ToolEnvelope;
  const updated = parse(updatedRaw);
  updatedRevision = Number(updated.result?.revision ?? updated.revision);
  const firstCallReplayed = updated.replayed === true || updatedRaw.structuredContent?.replayed === true;
  if (updatedRevision !== commandExpectedRevision + 1 || updatedRevision !== before.revision + (recoveredPriorCommittedWrite ? 0 : 1)) throw new Error(`source MCP 没有只推进一个修订：${JSON.stringify(updated)}`);
  if (recoveredPriorCommittedWrite && !firstCallReplayed) throw new Error(`source MCP 未把前次已提交写入识别为幂等重放：${JSON.stringify(updated)}`);
  const replayRaw = await sourceConnection.client.callTool({ name: "execute_command", arguments: { ...request, requestId: `${marker}-request-2` } }) as ToolEnvelope;
  const replay = parse(replayRaw);
  const replayRevision = Number(replay.result?.revision ?? replay.revision);
  const replayed = replay.replayed === true || replayRaw.structuredContent?.replayed === true;
  if (replayRevision !== updatedRevision || !replayed) throw new Error(`source MCP 幂等重放无效：${JSON.stringify({ replay, structuredContent: replayRaw.structuredContent })}`);
  const after = parse(await sourceConnection.client.callTool({ name: "get_edit_project", arguments: { projectRoot, editProjectId: state.masterEditProjectId } }));
  if (after.revision !== updatedRevision) throw new Error(`source MCP 最终 revision 与命令结果不一致：${JSON.stringify({ after: after.revision, updatedRevision })}`);
  source = {
    toolCount: tools.tools.length,
    capabilityMissingForFullNle: capabilities.editor?.missingForFullNle,
    scanId: progress.scanId,
    projectName: progress.project?.name,
    stateRevisionBefore: state.masterRevision,
    liveRevisionBefore: before.revision,
    commandExpectedRevision,
    revisionAfter: after.revision,
    recoveredPriorCommittedWrite,
    existingLedgerRequestHash: existingLedger?.requestHash,
    firstCallReplayed,
    replayed: true,
    stderrTail: sourceConnection.stderr(),
  };
} finally {
  await sourceConnection.client.close().catch(() => undefined);
}

const compiledConnection = await connect("compiled");
let compiled: Record<string, unknown>;
try {
  const tools = await compiledConnection.client.listTools();
  const capabilities = parse(await compiledConnection.client.callTool({ name: "get_capabilities", arguments: { projectRoot } }));
  const current = parse(await compiledConnection.client.callTool({ name: "get_edit_project", arguments: { projectRoot, editProjectId: state.masterEditProjectId } }));
  const clip = current.tracks?.flatMap((track: any) => track.clips ?? []).find((candidate: any) => candidate.id === state.mcpWritableClipId);
  if (current.revision !== updatedRevision || !String(clip?.note ?? "").includes("source MCP CAS 已验证")) throw new Error(`compiled MCP 未读到 source MCP 持久化结果：${JSON.stringify({ revision: current.revision, clip })}`);
  const ledger = parse(await compiledConnection.client.callTool({ name: "list_command_ledger", arguments: { projectRoot, limit: 20 } }));
  const matchingLedger = ledger.find((entry: any) => entry.idempotencyKey === `formal-nle-source-mcp-${state.masterEditProjectId}-idempotency-v1`);
  if (matchingLedger?.status !== "succeeded") throw new Error(`compiled MCP 未读到 succeeded 命令账本：${JSON.stringify(matchingLedger)}`);
  const continuationPacks = parse(await compiledConnection.client.callTool({ name: "list_video_continuations", arguments: { projectRoot, limit: 200 } }));
  const continuationBefore = continuationPacks.find((entry: any) => entry.id === state.continuationPackId);
  if (!continuationBefore) throw new Error(`compiled MCP 找不到 core 校准续接包：${state.continuationPackId}`);
  const cleanupReason = "正式 NLE 校准仅验证 enqueue:false 的时间线续接帧；按授权边界明确取消未入队包，不创建外部生成任务。";
  let continuationAfter = continuationBefore;
  let recoveredContinuationCleanup = false;
  if (continuationBefore.status === "cancelled" && continuationBefore.error === cleanupReason) {
    recoveredContinuationCleanup = true;
  } else {
    if (continuationBefore.generationJobId || ["completed", "failed", "cancelled"].includes(continuationBefore.status)) throw new Error(`续接包不满足安全取消前提：${JSON.stringify(continuationBefore)}`);
    const continuationCommand = parse(await compiledConnection.client.callTool({ name: "update_video_continuation", arguments: {
      projectRoot,
      requestId: `formal-nle-continuation-cleanup-${continuationBefore.id}-request-1`,
      idempotencyKey: `formal-nle-continuation-cleanup-${continuationBefore.id}-idempotency-v1`,
      continuationId: continuationBefore.id,
      expectedRevision: continuationBefore.revision,
      status: "cancelled",
      error: cleanupReason,
    } }));
    continuationAfter = continuationCommand.result ?? continuationCommand;
  }
  if (continuationAfter.status !== "cancelled" || continuationAfter.error !== cleanupReason || continuationAfter.generationJobId) throw new Error(`compiled MCP 未安全取消未入队续接包：${JSON.stringify(continuationAfter)}`);
  const ledgerAfterCleanup = parse(await compiledConnection.client.callTool({ name: "list_command_ledger", arguments: { projectRoot, limit: 200 } }));
  const cleanupLedger = ledgerAfterCleanup.find((entry: any) => entry.idempotencyKey === `formal-nle-continuation-cleanup-${continuationBefore.id}-idempotency-v1`);
  if (cleanupLedger?.status !== "succeeded" || cleanupLedger.result?.status !== "cancelled") throw new Error(`compiled MCP 未读到续接清理 succeeded 账本：${JSON.stringify(cleanupLedger)}`);
  const doctor = parse(await compiledConnection.client.callTool({ name: "doctor_project", arguments: { projectRoot } }));
  if (doctor.summary?.errors !== 0 || doctor.summary?.warnings !== 0) throw new Error(`正式校准清理后 Doctor 仍不健康：${JSON.stringify(doctor)}`);
  compiled = {
    toolCount: tools.tools.length,
    capabilityMissingForFullNle: capabilities.editor?.missingForFullNle,
    revision: current.revision,
    persistedNote: clip.note,
    ledger: matchingLedger,
    continuationCleanup: { before: { id: continuationBefore.id, revision: continuationBefore.revision, status: continuationBefore.status }, after: { id: continuationAfter.id, revision: continuationAfter.revision, status: continuationAfter.status, error: continuationAfter.error }, recovered: recoveredContinuationCleanup, generationEnqueued: false, ledger: cleanupLedger },
    doctor: doctor.summary,
    stderrTail: compiledConnection.stderr(),
  };
} finally {
  await compiledConnection.client.close().catch(() => undefined);
}

if ((source.toolCount as number) !== expectedMcpToolCount || (compiled.toolCount as number) !== expectedMcpToolCount) throw new Error(`MCP tool count 与发布身份不一致：${JSON.stringify({ expectedMcpToolCount, source: source.toolCount, compiled: compiled.toolCount })}`);
if (JSON.stringify(source.capabilityMissingForFullNle) !== "[]" || JSON.stringify(compiled.capabilityMissingForFullNle) !== "[]") throw new Error(`正式校准完成后的 MCP capability 仍声明缺口：${JSON.stringify({ source: source.capabilityMissingForFullNle, compiled: compiled.capabilityMissingForFullNle })}`);

state.masterRevision = updatedRevision;
await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
const evidence = {
  schemaVersion: 1,
  kind: "aicanvas-formal-project-nle-mcp-smoke",
  generatedAt: new Date().toISOString(),
  status: "passed",
  projectRoot,
  registryPath,
  statePath,
  compiledServer: await fileEvidence(compiledServer),
  source,
  compiled,
};
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: evidence.status, evidencePath, masterRevision: updatedRevision, sourceTools: source.toolCount, compiledTools: compiled.toolCount }, null, 2)}\n`);
