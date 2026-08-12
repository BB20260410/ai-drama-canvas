import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  currentMcpRuntimeEnvironment,
  resolveCurrentMcpRuntime,
} from "../src/core/current-mcp-runtime.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`缺少 ${prefix}<path>`);
  return path.resolve(value);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseToolResult(result: unknown): Record<string, any> {
  const typed = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = typed.content?.find((entry) => entry.type === "text")?.text;
  if (!text) throw new Error("current MCP没有返回JSON文本。 ");
  if (typed.isError) throw new Error(`current MCP工具失败：${text.slice(0, 2_000)}`);
  return JSON.parse(text) as Record<string, any>;
}

const pilotEvidencePath = argument("pilot-evidence");
const evidencePath = argument("evidence");
requireCondition(
  path.relative(workspaceRoot, evidencePath) !== ""
    && !path.relative(workspaceRoot, evidencePath).startsWith(`..${path.sep}`),
  "current MCP smoke证据必须位于工作区内。",
);
await access(evidencePath).then(
  () => { throw new Error(`证据已存在，拒绝覆盖：${path.relative(workspaceRoot, evidencePath)}`); },
  () => undefined,
);

const pilot = JSON.parse(await readFile(pilotEvidencePath, "utf8")) as {
  managedProjectRelativePath: string;
  chapter11: {
    cutoffChapterId?: string;
    beforeProjection?: { cutoffChapterId: string };
  };
  manuscript: { chapters: Array<{ number: number; chapterId: string }> };
};
const projectRoot = await realpath(path.join(workspaceRoot, pilot.managedProjectRelativePath));
requireCondition(
  !path.relative(workspaceRoot, projectRoot).startsWith(`..${path.sep}`),
  "pilot工程逃逸工作区。",
);
const chapter11 = pilot.manuscript.chapters.find((entry) => entry.number === 11);
const chapter12 = pilot.manuscript.chapters.find((entry) => entry.number === 12);
requireCondition(chapter11 && chapter12, "pilot证据缺少011/012章节身份。 ");
const expectedChapter11Cutoff = pilot.chapter11.beforeProjection?.cutoffChapterId
  ?? pilot.chapter11.cutoffChapterId;
requireCondition(expectedChapter11Cutoff, "pilot证据缺少011 before cutoff。 ");
const current = await resolveCurrentMcpRuntime({ workspace: workspaceRoot });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [current.launcherPath],
  cwd: workspaceRoot,
  env: currentMcpRuntimeEnvironment(current, { ...process.env, AI_CANVAS_MCP_ALLOW_MULTI: "1" }),
  stderr: "pipe",
});
const client = new Client({ name: "writing-os-current-runtime-smoke", version: "1.0.0" });
let stderrTail = "";
transport.stderr?.on("data", (chunk) => {
  stderrTail = `${stderrTail}${String(chunk)}`.slice(-4_000);
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = tools.tools.map((entry) => entry.name);
  const requiredTools = [
    "doctor_novel_agent",
    "prepare_novel_chapter_write",
    "probe_novel_chapter_consistency",
    "get_novel_writing_state",
    "execute_command",
  ];
  requireCondition(requiredTools.every((name) => toolNames.includes(name)), "current MCP缺少Writing OS关键工具。 ");

  const capabilities = parseToolResult(await client.callTool({
    name: "get_capabilities",
    arguments: { projectRoot },
  }));
  requireCondition(capabilities.server?.toolCount === tools.tools.length, "capabilities toolCount与tools/list不一致。 ");
  requireCondition(capabilities.buildCurrentness?.allowed === true, "current MCP buildCurrentness.allowed不是true。 ");
  requireCondition(capabilities.buildCurrentness?.sourceDigest === current.receipt.sourceDigest, "current MCP sourceDigest与启动候选不一致。 ");
  requireCondition(capabilities.buildCurrentness?.buildId === current.receipt.buildId, "current MCP buildId与启动候选不一致。 ");

  const state = parseToolResult(await client.callTool({
    name: "get_novel_writing_state",
    arguments: { projectRoot, targetChapterId: chapter11.chapterId, cutoff: "before" },
  }));
  requireCondition(
    state.temporal?.cutoffChapterId === expectedChapter11Cutoff,
    "current MCP 011 before cutoff与pilot证据不一致。",
  );
  requireCondition(
    state.temporal.characterStates.every((entry: { throughChapterId: string }) => entry.throughChapterId !== chapter11.chapterId),
    "current MCP泄漏011人物状态。",
  );
  requireCondition(
    state.temporal.hardCanon.every((entry: { visibility: string }) => entry.visibility === "writer"),
    "current MCP泄漏author_only正典。",
  );

  const doctor = parseToolResult(await client.callTool({
    name: "doctor_novel_agent",
    arguments: { projectRoot, targetChapterId: chapter12.chapterId, workflowMode: "rehearsal" },
  }));
  requireCondition(doctor.kind === "novel-agent-doctor" && Array.isArray(doctor.safeWorkflow), "current MCP doctor合同无效。 ");
  requireCondition(Array.isArray(doctor.blockers) && Array.isArray(doctor.nextTools), "current MCP doctor缺少结构化修复入口。 ");

  const probe = parseToolResult(await client.callTool({
    name: "probe_novel_chapter_consistency",
    arguments: { projectRoot, targetChapterId: chapter11.chapterId, workflowMode: "rehearsal" },
  }));
  requireCondition(
    Array.isArray(probe.machineConflicts) && Array.isArray(probe.reviewRequired) && Array.isArray(probe.limitations),
    "current MCP probe合同无效。",
  );

  const receipt = {
    schemaVersion: 1,
    kind: "writing-os-current-runtime-smoke",
    status: "PASS",
    generatedAt: new Date().toISOString(),
    projectRelativePath: pilot.managedProjectRelativePath,
    runtime: {
      candidateId: current.receipt.candidateId,
      sourceDigest: current.receipt.sourceDigest,
      buildId: current.receipt.buildId,
      entrySha256: current.receipt.entrySha256,
      buildCurrentnessAllowed: capabilities.buildCurrentness?.allowed,
      toolCount: tools.tools.length,
      requiredTools,
    },
    temporalBoundary: {
      targetChapterId: chapter11.chapterId,
      cutoffChapterId: state.temporal.cutoffChapterId,
      chapter11StateVisible: state.temporal.characterStates.some(
        (entry: { throughChapterId: string }) => entry.throughChapterId === chapter11.chapterId,
      ),
      authorOnlyVisible: state.temporal.hardCanon.some(
        (entry: { visibility: string }) => entry.visibility === "author_only",
      ),
    },
    doctor: {
      targetChapterId: chapter12.chapterId,
      readyForPrepare: doctor.readyForPrepare,
      blockerCodes: doctor.blockers.map((entry: { code: string }) => entry.code),
      nextToolNames: doctor.nextTools.map((entry: { tool: string }) => entry.tool),
      fingerprint: doctor.fingerprint,
    },
    probe: {
      targetChapterId: chapter11.chapterId,
      machineConflictCodes: probe.machineConflicts.map((entry: { code: string }) => entry.code),
      reviewRequiredCodes: probe.reviewRequired.map((entry: { code: string }) => entry.code),
      limitationCount: probe.limitations.length,
      fingerprint: probe.fingerprint,
    },
    stderrTail,
  };
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    evidence: path.relative(workspaceRoot, evidencePath).split(path.sep).join("/"),
    candidateId: receipt.runtime.candidateId,
    toolCount: receipt.runtime.toolCount,
    doctorReady: receipt.doctor.readyForPrepare,
    probeMachineConflicts: receipt.probe.machineConflictCodes,
  })}\n`);
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
}
