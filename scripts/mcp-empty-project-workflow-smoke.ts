import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expectedRuntimeMcpToolCount } from "../src/core/release-manifest.js";
import { resetOwnedFixtureRoot } from "./lib/owned-fixture-root.js";

function parseToolResult(result: unknown): unknown {
  const response = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = response.content?.find((entry) => entry.type === "text" && typeof entry.text === "string")?.text;
  if (!text) throw new Error("MCP 没有返回结构化文本。");
  const parsed = JSON.parse(text) as { error?: { message?: string }; status?: string; result?: unknown };
  if (response.isError) throw new Error(parsed.error?.message || text);
  return parsed.status === "succeeded" && Object.hasOwn(parsed, "result") ? parsed.result : parsed;
}

function transportFor(projectRoot: string, registryPath: string): StdioClientTransport {
  const packagedRuntime = process.env.AI_CANVAS_MCP_RUNTIME?.trim();
  const compiledServer = process.env.AI_CANVAS_MCP_SERVER_PATH?.trim();
  const env = { ...process.env, AI_CANVAS_PROJECT_ROOT: projectRoot, AI_CANVAS_REGISTRY_PATH: registryPath };
  if (packagedRuntime && compiledServer) return new StdioClientTransport({
    command: "/usr/bin/env",
    args: ["ELECTRON_RUN_AS_NODE=1", path.resolve(packagedRuntime), path.resolve(compiledServer)],
    cwd: process.cwd(),
    env,
    stderr: "pipe",
  });
  if (compiledServer) return new StdioClientTransport({ command: process.execPath, args: [path.resolve(compiledServer)], cwd: process.cwd(), env, stderr: "pipe" });
  return new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp/server.ts"], cwd: process.cwd(), env, stderr: "pipe" });
}

async function connect(projectRoot: string, registryPath: string): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = transportFor(projectRoot, registryPath);
  transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  const client = new Client({ name: "ai-drama-canvas-empty-project-e2e", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}

export async function runMcpEmptyProjectWorkflow(projectRoot: string, registryPath: string): Promise<Record<string, unknown>> {
  const root = path.resolve(projectRoot);
  const registry = path.resolve(registryPath);
  await Promise.all([resetOwnedFixtureRoot(root, "mcp-empty-project-workflow-smoke"), rm(registry, { force: true })]);
  const novelPath = path.join(root, "01_雾河来客.md");
  await writeFile(novelPath, `# 第一章 雾河来客

清晨，阿航穿着黑袍走进雾河边的古老祭坛，浓雾贴着石阶缓慢流动。
嘟嘟守在门外，低声说：“别碰那副完整黄金面具。”
阿航想起师父的警告：完整黄金面具不得改成半面具，也不能遮掉一半脸。
忽然火光熄灭，水声从地底传来。阿航心中害怕，却仍伸手拿起黄金面具。
石门轰然关闭，嘟嘟冲进祭坛。阿航回头看向她，面具表面的金光照亮两人的脸。

# 第二章 门后回声

门后的黑暗里传来脚步声。嘟嘟举起火把，阿航将完整黄金面具护在胸前。
两人沿着右侧石壁前进，始终没有跨过中央裂缝。远处，一个披着祭司袍的人影停在雾中。
`, "utf8");

  const first = await connect(root, registry);
  let toolCount = 0;
  let splitPlanId = "";
  let splitUnits = 0;
  let chapters = 0;
  let facts = 0;
  let beats = 0;
  let storyboardRows = 0;
  let directorContract: { id: string; fields: Record<string, unknown> } | null = null;
  const directorFieldNames = ["cameraAngle", "lens", "composition", "staging", "expression", "emotion", "eyeline", "screenDirection", "axisSide", "narration", "ambience", "soundEffects", "continuityBefore", "continuityAfter", "referenceNames", "referencePaths", "referenceArtifactIds", "upstreamFactRefs", "upstreamBeatRefs", "sourceSpans", "adaptationPlanId", "adaptationUnitId", "directorIntent", "emotionalIntent", "continuityNotes"] as const;
  const jsonPath = path.join(root, "导出", "雾河来客_纯MCP分镜_v001.json");
  const markdownPath = path.join(root, "导出", "雾河来客_纯MCP分镜_v001.md");
  try {
    const tools = (await first.client.listTools()).tools;
    toolCount = tools.length;
    const expectedToolCount = await expectedRuntimeMcpToolCount(process.cwd());
    if (toolCount !== expectedToolCount) throw new Error(`纯 MCP 空项目工具数应为 ${expectedToolCount}，实际 ${toolCount}。`);
    if (!tools.some((tool) => tool.name === "get_studio_continuity_review_control")) throw new Error("纯 MCP 空项目验收缺少连续性与 Review 只读控制工具。");
    const importOptions = { primaryRoot: root, projectMode: "story_first", name: "雾河来客 · 纯 MCP 验收" };
    const preview = parseToolResult(await first.client.callTool({ name: "preview_project_import", arguments: importOptions })) as { previewId: string; projectMode: string; canImport: boolean; recognized: { units: number }; issues: Array<{ code: string }> };
    if (!preview.canImport || preview.projectMode !== "story_first" || preview.recognized.units !== 0 || !preview.issues.some((issue) => issue.code === "story_first_empty")) throw new Error("空目录没有通过 story_first 两阶段预检。");
    await access(path.join(root, ".aicanvas")).then(() => { throw new Error("导入预检意外创建了侧车。"); }).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("意外创建")) throw error;
    });
    const importAttemptId = randomUUID();
    parseToolResult(await first.client.callTool({ name: "commit_project_import", arguments: { ...importOptions, previewId: preview.previewId, requestId: `request-empty-import-${importAttemptId}`, idempotencyKey: `empty-story-first-import-${importAttemptId}` } }));
    await access(path.join(root, ".aicanvas", "index.json"));

    const imported = parseToolResult(await first.client.callTool({ name: "import_story_file", arguments: { projectRoot: root, filePath: novelPath, title: "雾河来客", requestId: "request-empty-story-001", idempotencyKey: "empty-story-import-v1" } })) as { chapters: unknown[] };
    chapters = imported.chapters.length;
    const analyzed = parseToolResult(await first.client.callTool({ name: "analyze_novel_chapters", arguments: { projectRoot: root, expectedRevision: 0, requestId: "request-empty-analyze-001", idempotencyKey: "empty-analyze-v1" } })) as { revision: number; facts: unknown[]; beats: unknown[] };
    facts = analyzed.facts.length;
    beats = analyzed.beats.length;
    const generated = parseToolResult(await first.client.callTool({ name: "generate_adaptation_plans", arguments: { projectRoot: root, expectedRevision: analyzed.revision, episode: 1, startUnit: 1, requestId: "request-empty-plans-001", idempotencyKey: "empty-plans-v1" } })) as { workspace: { revision: number }; plans: Array<{ id: string; mode: string; units: unknown[] }> };
    const split = generated.plans.find((plan) => plan.mode === "split");
    if (!split || split.units.length < 2) throw new Error("纯 MCP 流程没有生成至少两个拆分单元。");
    splitPlanId = split.id;
    splitUnits = split.units.length;
    const selected = parseToolResult(await first.client.callTool({ name: "select_adaptation_plan", arguments: { projectRoot: root, planId: split.id, expectedRevision: generated.workspace.revision, requestId: "request-empty-select-001", idempotencyKey: "empty-select-v1" } })) as { revision: number };
    const materialized = parseToolResult(await first.client.callTool({ name: "materialize_adaptation_plan", arguments: { projectRoot: root, expectedRevision: selected.revision, requestId: "request-empty-materialize-001", idempotencyKey: "empty-materialize-v1" } })) as { storyboardRows: Array<Record<string, unknown>>; unitPaths: string[] };
    if (materialized.unitPaths.length !== splitUnits) throw new Error("物化单元数与选定拆分方案不一致。");
    for (const [index, row] of materialized.storyboardRows.entries()) {
      const input = {
        id: row.id,
        itemId: row.itemId,
        shotItemId: row.shotItemId,
        order: row.order,
        durationSeconds: row.durationSeconds,
        shotSize: row.shotSize,
        cameraMovement: row.cameraMovement,
        action: row.action,
        dialogue: row.dialogue,
        firstFramePrompt: row.firstFramePrompt,
        endFramePrompt: row.endFramePrompt,
        videoPrompt: row.videoPrompt,
        referencePaths: row.referencePaths ?? [],
        status: "confirmed",
        expectedRevision: row.revision,
      };
      const expectedFields = Object.fromEntries(directorFieldNames.map((field) => [field, row[field]]));
      const confirmed = parseToolResult(await first.client.callTool({ name: "upsert_storyboard_row", arguments: { projectRoot: root, ...input, requestId: `request-empty-row-${String(index + 1).padStart(3, "0")}`, idempotencyKey: `empty-confirm-row-${String(index + 1).padStart(3, "0")}-v1` } })) as Record<string, unknown>;
      for (const field of directorFieldNames) if (JSON.stringify(confirmed[field]) !== JSON.stringify(expectedFields[field])) throw new Error(`MCP 局部确认分镜时丢失导演字段：${field}`);
      if (!directorContract) directorContract = { id: String(row.id), fields: expectedFields };
    }
    const storyboard = parseToolResult(await first.client.callTool({ name: "get_storyboard", arguments: { projectRoot: root } })) as { rows: Array<{ status: string }>; valid: boolean };
    storyboardRows = storyboard.rows.length;
    if (!storyboard.valid || !storyboard.rows.length || storyboard.rows.some((row) => row.status !== "confirmed")) throw new Error("纯 MCP 正式分镜未全部确认或校验失败。");
    const validation = parseToolResult(await first.client.callTool({ name: "validate_adaptation_plan", arguments: { projectRoot: root, planId: split.id } })) as { hardErrors: unknown[] };
    if (validation.hardErrors.length) throw new Error("纯 MCP 改编方案存在硬错误。");
    await mkdir(path.dirname(jsonPath), { recursive: true });
    parseToolResult(await first.client.callTool({ name: "export_adaptation", arguments: { projectRoot: root, format: "json", outputPath: jsonPath, planId: split.id, requestId: "request-empty-export-json-001", idempotencyKey: "empty-export-json-v1" } }));
    parseToolResult(await first.client.callTool({ name: "export_adaptation", arguments: { projectRoot: root, format: "markdown", outputPath: markdownPath, planId: split.id, requestId: "request-empty-export-md-001", idempotencyKey: "empty-export-md-v1" } }));
  } finally {
    await first.client.close();
  }

  const restarted = await connect(root, registry);
  try {
    const workspace = parseToolResult(await restarted.client.callTool({ name: "get_adaptation_workspace", arguments: { projectRoot: root } })) as { selectedPlanId?: string; facts: unknown[]; beats: unknown[] };
    const storyboard = parseToolResult(await restarted.client.callTool({ name: "get_storyboard", arguments: { projectRoot: root } })) as { rows: Array<Record<string, unknown> & { id: string; status: string }>; valid: boolean };
    const snapshot = parseToolResult(await restarted.client.callTool({ name: "get_project_snapshot", arguments: { projectRoot: root } })) as { project: { id: string }; progress: { total: number } };
    const json = JSON.parse(await readFile(jsonPath, "utf8")) as { plan?: { id?: string; units?: unknown[] } };
    const markdown = await readFile(markdownPath, "utf8");
    if (workspace.selectedPlanId !== splitPlanId || workspace.facts.length !== facts || workspace.beats.length !== beats) throw new Error("重启后改编工作区与首次运行不一致。");
    if (!storyboard.valid || storyboard.rows.length !== storyboardRows || storyboard.rows.some((row) => row.status !== "confirmed")) throw new Error("重启后正式分镜未完整恢复。");
    const restoredDirectorRow = storyboard.rows.find((row) => row.id === directorContract?.id);
    if (!restoredDirectorRow || !directorContract) throw new Error("重启后找不到导演合同验收分镜。");
    for (const field of directorFieldNames) if (JSON.stringify(restoredDirectorRow[field]) !== JSON.stringify(directorContract.fields[field])) throw new Error(`重启后导演字段不一致：${field}`);
    if (json.plan?.id !== splitPlanId || json.plan.units?.length !== splitUnits || !markdown.includes("镜头") || !markdown.includes("15s 001")) throw new Error("纯 MCP JSON/Markdown 导出不完整。");
    const ledger = parseToolResult(await restarted.client.callTool({ name: "list_command_ledger", arguments: { projectRoot: root, limit: 500 } })) as Array<{ status: string }>;
    if (ledger.some((entry) => ["running", "unknown"].includes(entry.status))) throw new Error("纯 MCP 空项目闭环留下未确认命令。");
    return {
      root,
      registryPath: registry,
      transport: process.env.AI_CANVAS_MCP_RUNTIME ? "packaged-electron-node" : process.env.AI_CANVAS_MCP_SERVER_PATH ? "compiled-node" : "source-stdio",
      desktopUiLaunched: false,
      toolCount,
      chapters,
      facts,
      beats,
      splitUnits,
      storyboardRows,
      directorContractPreserved: true,
      projectId: snapshot.project.id,
      totalItems: snapshot.progress.total,
      jsonPath,
      markdownPath,
      ledgerEntries: ledger.length,
      uncertainCommands: 0,
      restartVerified: true,
    };
  } finally {
    await restarted.client.close();
  }
}

const defaultSuffix = `${process.pid}-${randomUUID()}`;
const projectRoot = path.resolve(process.argv[2] || path.join(os.tmpdir(), `ai-canvas-mcp-empty-project-${defaultSuffix}`));
const registryPath = path.resolve(process.argv[3] || path.join(os.tmpdir(), `ai-canvas-mcp-empty-project-registry-${defaultSuffix}.json`));
process.stdout.write(`${JSON.stringify(await runMcpEmptyProjectWorkflow(projectRoot, registryPath), null, 2)}\n`);
