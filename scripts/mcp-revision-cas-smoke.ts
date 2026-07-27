import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import { scanAndPersist } from "../src/core/service.js";

type ToolResult = { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
type LedgerEntry = { idempotencyKey: string; status: string; result?: { reason?: string } };

const outputPath = path.resolve(process.argv[2] ?? "docs/evidence/revision-cas-mcp-latest.json");

function payload<T>(result: unknown): T {
  const value = result as ToolResult;
  const text = value.content?.find((entry) => entry.type === "text")?.text;
  if (text) {
    const parsed = JSON.parse(text) as { status?: string; result?: unknown };
    return (parsed.status === "succeeded" && "result" in parsed ? parsed.result : parsed) as T;
  }
  const structured = value.structuredContent as { status?: string; result?: unknown } | undefined;
  return (structured?.status === "succeeded" && "result" in structured ? structured.result : structured ?? {}) as T;
}

async function expectToolError(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const result = await client.callTool({ name, arguments: args }) as ToolResult;
    if (!result.isError) throw new Error(`${name} 预期失败但返回成功`);
    return result.content?.find((entry) => entry.type === "text")?.text ?? "tool error";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function runMode(mode: "source" | "compiled") {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), `ai-canvas-revision-cas-mcp-${mode}-`));
  const projectRoot = path.join(runtimeRoot, "project");
  const registryPath = path.join(runtimeRoot, "projects.json");
  await mkdir(projectRoot, { recursive: true });
  const config = await ensureSidecar(projectRoot);
  config.sourceRoots = [];
  config.outputRoots = [projectRoot];
  await writeJsonAtomic(getSidecarPaths(projectRoot).config, config);
  for (const [number, title] of [[1, "CAS 一号"], [2, "CAS 二号"]] as const) {
    const directory = path.join(projectRoot, `EP01_15s_00${number}_${title}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "00_信息.md"), `首帧提示词：${title}\n尾帧提示词：保持连续。\n`, "utf8");
  }
  await scanAndPersist(projectRoot);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: mode === "source" ? ["--import", "tsx", "src/mcp/server.ts"] : [path.resolve("dist-mcp/mcp/server.js")],
    cwd: process.cwd(),
    env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath },
    stderr: "pipe",
  });
  const client = new Client({ name: `revision-cas-${mode}`, version: "0.1.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    const requiredSchemaNames = ["update_production_workflow_stage", "upsert_creative_bible", "upsert_asset_relation", "upsert_voice_identity", "upsert_context", "delete_context", "execute_command"];
    for (const name of requiredSchemaNames) {
      const schema = JSON.stringify(byName.get(name)?.inputSchema ?? {});
      if (!schema.includes("expectedRevision")) throw new Error(`${mode} ${name} schema 缺少 expectedRevision：${schema.slice(0, 2_000)}`);
    }

    const guarded = async <T>(name: string, key: string, args: Record<string, unknown>): Promise<T> => payload<T>(await client.callTool({ name, arguments: { projectRoot, requestId: `request-${mode}-${key}`, idempotencyKey: `${mode}-${key}-v1`, ...args } }));
    const context = await guarded<{ id: string; revision: number }>("upsert_context", "context-create", { kind: "decision", title: "MCP CAS", content: "初始内容" });
    const contextUpdated = await guarded<{ id: string; revision: number }>("upsert_context", "context-update", { id: context.id, kind: "decision", title: "MCP CAS", content: "新窗口内容", expectedRevision: context.revision });
    await expectToolError(client, "upsert_context", { projectRoot, requestId: `request-${mode}-context-stale`, idempotencyKey: `${mode}-context-stale-v1`, id: context.id, kind: "decision", title: "MCP CAS", content: "旧窗口内容", expectedRevision: context.revision });
    await expectToolError(client, "upsert_context", { projectRoot, requestId: `request-${mode}-context-unknown`, idempotencyKey: `${mode}-context-unknown-v1`, id: "context-missing", kind: "decision", title: "不存在", content: "不得创建", expectedRevision: 1 });
    const missingContextRevision = await expectToolError(client, "upsert_context", { projectRoot, requestId: `request-${mode}-context-missing-revision`, idempotencyKey: `${mode}-context-missing-revision-v1`, id: context.id, kind: "decision", title: "MCP CAS", content: "缺 revision" });
    const invalidContextCreate = await expectToolError(client, "upsert_context", { projectRoot, requestId: `request-${mode}-context-invalid-create`, idempotencyKey: `${mode}-context-invalid-create-v1`, kind: "decision", title: "非法创建", content: "create 带 revision", expectedRevision: 1 });

    const bible = await guarded<{ id: string; revision: number }>("upsert_creative_bible", "bible-create", { kind: "director", name: "MCP Bible", summary: "CAS" });
    await expectToolError(client, "upsert_creative_bible", { projectRoot, requestId: `request-${mode}-bible-stale`, idempotencyKey: `${mode}-bible-stale-v1`, id: bible.id, kind: "director", name: "旧 Bible", summary: "CAS", expectedRevision: bible.revision + 1 });
    const relation = await guarded<{ id: string; revision: number }>("upsert_asset_relation", "relation-create", { kind: "reference_of", parentItemId: "main-ep01-unit001", childItemId: "main-ep01-unit002" });
    await expectToolError(client, "upsert_asset_relation", { projectRoot, requestId: `request-${mode}-relation-stale`, idempotencyKey: `${mode}-relation-stale-v1`, id: relation.id, kind: "reference_of", parentItemId: "main-ep01-unit001", childItemId: "main-ep01-unit002", expectedRevision: relation.revision + 1 });
    const voice = await guarded<{ id: string; revision: number }>("upsert_voice_identity", "voice-create", { name: "MCP 音色" });
    await expectToolError(client, "upsert_voice_identity", { projectRoot, requestId: `request-${mode}-voice-stale`, idempotencyKey: `${mode}-voice-stale-v1`, id: voice.id, name: "旧音色", expectedRevision: voice.revision + 1 });

    const workflow = payload<{ revision: number }>(await client.callTool({ name: "get_production_workflow", arguments: { projectRoot } }));
    const workflowUpdated = await guarded<{ revision: number }>("update_production_workflow_stage", "workflow-update", { stageId: "source", status: "in_progress", expectedRevision: workflow.revision });
    await expectToolError(client, "update_production_workflow_stage", { projectRoot, requestId: `request-${mode}-workflow-stale`, idempotencyKey: `${mode}-workflow-stale-v1`, stageId: "source", status: "review", expectedRevision: workflow.revision });
    const missingWorkflowRevision = await expectToolError(client, "update_production_workflow_stage", { projectRoot, requestId: `request-${mode}-workflow-missing`, idempotencyKey: `${mode}-workflow-missing-v1`, stageId: "source", status: "review" });

    await expectToolError(client, "delete_context", { projectRoot, requestId: `request-${mode}-context-delete-stale`, idempotencyKey: `${mode}-context-delete-stale-v1`, contextId: context.id, expectedRevision: context.revision });
    await guarded("delete_context", "context-delete", { contextId: context.id, expectedRevision: contextUpdated.revision });

    const executeCreate = payload<{ id: string; revision: number }>(await client.callTool({ name: "execute_command", arguments: { projectRoot, requestId: `request-${mode}-execute-create`, idempotencyKey: `${mode}-execute-create-v1`, request: { command: "upsert_context", payload: { kind: "continuity", title: "execute CAS", content: "合法创建" } } } }));
    const executeMissingRevision = await expectToolError(client, "execute_command", { projectRoot, requestId: `request-${mode}-execute-missing`, idempotencyKey: `${mode}-execute-missing-v1`, request: { command: "upsert_context", payload: { id: executeCreate.id, kind: "continuity", title: "execute CAS", content: "缺 revision" } } });

    const ledger = payload<LedgerEntry[]>(await client.callTool({ name: "list_command_ledger", arguments: { projectRoot, limit: 200 } }));
    const expectedFailed = [`${mode}-context-stale-v1`, `${mode}-context-unknown-v1`, `${mode}-bible-stale-v1`, `${mode}-relation-stale-v1`, `${mode}-voice-stale-v1`, `${mode}-workflow-stale-v1`, `${mode}-context-delete-stale-v1`];
    for (const key of expectedFailed) {
      const entry = ledger.find((candidate) => candidate.idempotencyKey === key);
      if (entry?.status !== "failed" || !["revision_conflict", "not_found"].includes(entry.result?.reason ?? "")) throw new Error(`${mode} ${key} 未形成确定性 failed 终态`);
    }
    const unknownKeys = ledger.filter((entry) => entry.status === "unknown").map((entry) => entry.idempotencyKey);
    if (unknownKeys.length) throw new Error(`${mode} CAS smoke 出现 unknown 命令：${unknownKeys.join("、")}`);
    for (const key of [`${mode}-context-missing-revision-v1`, `${mode}-context-invalid-create-v1`, `${mode}-workflow-missing-v1`, `${mode}-execute-missing-v1`]) {
      if (ledger.some((entry) => entry.idempotencyKey === key)) throw new Error(`${mode} schema 拒绝 ${key} 不应进入命令账本`);
    }

    return {
      mode,
      toolCount: tools.tools.length,
      schemaTools: requiredSchemaNames,
      revisions: { contextCreated: context.revision, contextUpdated: contextUpdated.revision, workflowBefore: workflow.revision, workflowAfter: workflowUpdated.revision },
      schemaRejections: { missingContextRevision, invalidContextCreate, missingWorkflowRevision, executeMissingRevision },
      failedLedger: expectedFailed.map((key) => ledger.find((entry) => entry.idempotencyKey === key)),
      unknownLedgerCount: ledger.filter((entry) => entry.status === "unknown").length,
    };
  } finally {
    await client.close().catch(() => undefined);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

const startedAt = new Date().toISOString();
const runs = [];
for (const mode of ["source", "compiled"] as const) runs.push(await runMode(mode));
const evidence = { schemaVersion: 1, kind: "long-lived-fact-revision-cas-mcp", startedAt, completedAt: new Date().toISOString(), success: true, runs };
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ success: true, outputPath, modes: runs.map((run) => run.mode), toolCounts: runs.map((run) => run.toolCount) })}\n`);
