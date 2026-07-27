import { createHash } from "node:crypto";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rootArgument = process.argv.slice(2).find((argument) => !argument.startsWith("--")) ?? process.env.AI_CANVAS_PROJECT_ROOT;
if (!rootArgument) throw new Error("必须显式提供项目主根：npm run mcp:real-smoke -- /tmp/项目路径 [--create]；脚本不会默认扫描正式项目。");
const projectRoot = path.resolve(rootArgument);
const shouldCreate = process.argv.includes("--create");
const serverPath = path.resolve("dist-mcp/mcp/server.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: process.cwd(),
  env: { ...process.env, AI_CANVAS_PROJECT_ROOT: projectRoot },
  stderr: "pipe",
});
const client = new Client({ name: "ai-drama-canvas-real-smoke", version: "0.1.0" });
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));

function parse(value: unknown): unknown {
  const result = value as { isError?: boolean; content: Array<{ type: string; text?: string }> };
  const block = result.content.find((entry) => entry.type === "text" && typeof entry.text === "string");
  if (!block?.text) throw new Error("MCP 未返回文本结果");
  if (result.isError) throw new Error(block.text);
  return JSON.parse(block.text);
}

try {
  await client.connect(transport);
  const capabilities = parse(await client.callTool({ name: "get_capabilities", arguments: { projectRoot } })) as { server: { toolCount: number }; commandTypes: string[] };
  const doctor = parse(await client.callTool({ name: "doctor_project", arguments: { projectRoot } })) as { summary: { ok: number; warning: number; error: number } };
  const progress = parse(await client.callTool({ name: "get_progress", arguments: { projectRoot } })) as {
    project: { name: string };
    summary: { total: number; active: number };
    scanId: string;
  };
  const next = parse(await client.callTool({ name: "get_next_task", arguments: { projectRoot, limit: 3 } })) as Array<{
    id: string;
    status: string;
    infoPath?: string;
  }>;
  const documents = parse(await client.callTool({ name: "list_script_documents", arguments: { projectRoot } })) as { total: number; documents: Array<{ path: string }> };
  const generationJobs = parse(await client.callTool({ name: "list_generation_jobs", arguments: { projectRoot, limit: 10 } })) as Array<{ id: string }>;
  let created: { taskId: string; count: number; path: string } | undefined;
  if (shouldCreate) {
    if (!next.length) throw new Error("当前项目没有可创建任务包的下一节点；请先完成生产门禁或使用新的隔离夹具。");
    const fingerprint = createHash("sha256").update(JSON.stringify({ projectRoot, scanId: progress.scanId, itemIds: next.map((item) => item.id) })).digest("hex").slice(0, 32);
    const command = parse(await client.callTool({
      name: "create_task_pack",
      arguments: { projectRoot, requestId: `real-smoke-${fingerprint}`, idempotencyKey: `real-smoke-task-${fingerprint}`, itemIds: next.map((item) => item.id), kind: "image", mode: "autopilot" },
    })) as { status: string; result?: { task: { id: string; itemIds: string[] }; path: string } };
    const result = command.result;
    if (command.status !== "succeeded" || !result) throw new Error(`任务包命令没有成功回执：${JSON.stringify(command)}`);
    created = { taskId: result.task.id, count: result.task.itemIds.length, path: result.path };
  }
  process.stdout.write(`${JSON.stringify({
    projectRoot,
    toolCount: capabilities.server.toolCount,
    commandTypes: capabilities.commandTypes.length,
    doctor: doctor.summary,
    project: progress.project.name,
    total: progress.summary.total,
    active: progress.summary.active,
    scanId: progress.scanId,
    scriptDocuments: documents.total,
    generationJobs: generationJobs.length,
    next: next.map(({ id, status, infoPath }) => ({ id, status, infoPath })),
    created,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
