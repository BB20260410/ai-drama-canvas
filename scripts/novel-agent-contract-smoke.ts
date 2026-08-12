import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  executeIdempotentCommand,
  getNovelImportCommandOwnerRoot,
} from "../src/core/command-bus.js";
import { createManagedProject } from "../src/core/managed-project.js";
import { createAuthorizedNovelImportPreflight } from "../src/core/novel-import.js";
import { NovelRepository, orderedNovelChapters } from "../src/core/novel-manuscript.js";
import {
  listRegisteredProjects,
  registerProject,
  setActiveProjectRegistration,
} from "../src/core/sidecar.js";
import type { NovelCommandRequest } from "../src/core/novel-command-runtime.js";
import {
  buildNovelScaleFixture,
  DEFAULT_FIXTURE_SEED,
  STANDARD_ORACLE_COUNTS,
  type GoldenAnswerDocument,
} from "./create-novel-scale-fixtures.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspaceRoot, "docs", "evidence", "novel-agent-contract-v1");
const evidencePath = path.join(evidenceRoot, "ai-first-v1-acceptance-r2.json");

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function commandEnvelope(command: string, payload: Record<string, unknown>) {
  const suffix = randomUUID();
  return {
    requestId: `novel-agent-smoke-request-${suffix}`,
    idempotencyKey: `novel-agent-smoke-key-${suffix}`,
    request: { command, payload },
  } as Parameters<typeof executeIdempotentCommand>[1];
}

async function runCli(request: unknown, registryPath: string): Promise<{
  code: number;
  response: Record<string, any>;
  durationMs: number;
}> {
  const startedAt = performance.now();
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/novel-agent-cli.ts"], {
    cwd: workspaceRoot,
    env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(request));
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal) reject(new Error(`Novel Agent CLI 被信号 ${signal} 终止`));
      else resolve(exitCode ?? 1);
    });
  });
  let response: Record<string, any>;
  try {
    response = JSON.parse(stdout.trim()) as Record<string, any>;
  } catch {
    throw new Error(`Novel Agent CLI stdout 不是单一 JSON：${stdout.slice(0, 500)}；stderr=${stderr.slice(0, 500)}`);
  }
  return { code, response, durationMs: Math.round(performance.now() - startedAt) };
}

function parseMcpResult(result: unknown): Record<string, any> {
  const typed = result as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
  const text = typed.content?.find((entry) => entry.type === "text")?.text ?? "{}";
  const value = JSON.parse(text) as Record<string, any>;
  if (typed.isError) throw new Error(`MCP 工具失败：${text.slice(0, 2_000)}`);
  return value;
}

async function connectSourceMcp(registryPath: string): Promise<{
  client: Client;
  transport: StdioClientTransport;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd: workspaceRoot,
    env: {
      ...process.env,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_MCP_ALLOW_MULTI: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "novel-agent-contract-smoke", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function callMcp(client: Client, name: string, args: Record<string, unknown>) {
  return parseMcpResult(await client.callTool({ name, arguments: args }));
}

await access(evidencePath).then(
  () => { throw new Error(`验收证据已存在，拒绝覆盖：${evidencePath}`); },
  () => undefined,
);

const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "novel-agent-contract-")));
const registryPath = path.join(temporaryRoot, "registry", "projects.json");
const projectsRoot = path.join(temporaryRoot, "projects");
const sourceRoot = path.join(temporaryRoot, "source");
await Promise.all([
  mkdir(path.dirname(registryPath), { recursive: true }),
  mkdir(projectsRoot),
  mkdir(sourceRoot),
]);

const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
let mcp: Awaited<ReturnType<typeof connectSourceMcp>> | undefined;

try {
  const smallShell = await createManagedProject({
    parentRoot: projectsRoot,
    name: "AI Agent 百字小说",
    workspaceMode: "novel",
  });
  await registerProject(smallShell.project);
  const initialized = await executeIdempotentCommand(smallShell.paths.root, commandEnvelope(
    "novel_initialize_manuscript",
    { sourceMode: "managed_markdown" },
  ));
  const initResult = initialized.result as {
    chapters: { revision: number; volumes: Array<{ volumeId: string }> };
  };
  const seed = "青铜树下，嘟嘟听见风从古蜀城门穿过，铜铃在夜色里回应。";
  const smallText = seed.repeat(Math.ceil(100 / seed.length)).slice(0, 100);
  requireCondition(smallText.length === 100, "百字夹具长度不等于 100。 ");
  const created = await executeIdempotentCommand(smallShell.paths.root, commandEnvelope("novel_create_chapter", {
    volumeId: initResult.chapters.volumes[0]!.volumeId,
    title: "第一章 百字验收",
    content: smallText,
    expectedManifestRevision: initResult.chapters.revision,
  }), { novelWriteActor: "human_ui" });
  const smallChapter = (created.result as {
    chapter: { chapterId: string; revision: number; sha256: string };
  }).chapter;
  await executeIdempotentCommand(smallShell.paths.root, commandEnvelope("novel_seed_writing_state", {
    baselineStatus: "locked",
    sourceTreeAggregateSha256: sha256("agent-contract-small-state"),
    currentThroughChapterId: smallChapter.chapterId,
    sourceDocuments: [],
    entities: [],
    hardCanon: [],
    characterStates: [],
    knowledge: [],
    relationships: [],
    timeline: [],
    foreshadowing: [],
    chapterBriefs: [],
    completedChapterIds: [smallChapter.chapterId],
  }), { novelWriteActor: "human_owner" });
  await setActiveProjectRegistration(smallShell.paths.root);

  mcp = await connectSourceMcp(registryPath);
  const tools = await mcp.client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  const requiredTools = [
    "get_novel_manuscript_workspace",
    "list_novel_manuscript_chapters",
    "read_novel_manuscript_range",
    "search_novel_manuscript",
    "build_novel_context_pack",
    "execute_command",
  ];
  requireCondition(requiredTools.every((tool) => toolNames.has(tool)), "源码 MCP 缺少 Novel Agent 工具。 ");
  const capabilities = await callMcp(mcp.client, "get_capabilities", {});
  requireCondition(capabilities.novelAgent?.contract === "aicanvas.novel-agent", "get_capabilities 未声明 Novel Agent 合同。 ");
  const activeWorkspace = await callMcp(mcp.client, "get_novel_manuscript_workspace", {});
  requireCondition(activeWorkspace.project?.projectId === smallShell.project.id
    && activeWorkspace.project?.selection === "active", "零参数 MCP 没有解析到明确活动小说工程。 ");

  const readRequests = {
    workspace: {
      mcpTool: "get_novel_manuscript_workspace",
      mcpInput: { projectRoot: smallShell.paths.root },
      cli: { schemaVersion: 1, operation: "workspace", projectRoot: smallShell.paths.root },
    },
    list: {
      mcpTool: "list_novel_manuscript_chapters",
      mcpInput: { projectRoot: smallShell.paths.root, targetChapterId: smallChapter.chapterId, cutoff: "through", offset: 0, limit: 100 },
      cli: { schemaVersion: 1, operation: "list_chapters", projectRoot: smallShell.paths.root, input: { targetChapterId: smallChapter.chapterId, cutoff: "through", offset: 0, limit: 100 } },
    },
    range: {
      mcpTool: "read_novel_manuscript_range",
      mcpInput: { projectRoot: smallShell.paths.root, targetChapterId: smallChapter.chapterId, cutoff: "through", chapterId: smallChapter.chapterId, startOffset: 0, maxCharacters: 100 },
      cli: { schemaVersion: 1, operation: "read_chapter_range", projectRoot: smallShell.paths.root, input: { targetChapterId: smallChapter.chapterId, cutoff: "through", chapterId: smallChapter.chapterId, startOffset: 0, maxCharacters: 100 } },
    },
    search: {
      mcpTool: "search_novel_manuscript",
      mcpInput: { projectRoot: smallShell.paths.root, targetChapterId: smallChapter.chapterId, cutoff: "through", query: "青铜树", limit: 50, maxHitsPerChapter: 5 },
      cli: { schemaVersion: 1, operation: "search", projectRoot: smallShell.paths.root, input: { targetChapterId: smallChapter.chapterId, cutoff: "through", query: "青铜树", limit: 50, maxHitsPerChapter: 5 } },
    },
    context: {
      mcpTool: "build_novel_context_pack",
      mcpInput: { projectRoot: smallShell.paths.root, query: "青铜树", cutoffChapterId: smallChapter.chapterId, maxCharacters: 256, maxSearchHits: 20 },
      cli: { schemaVersion: 1, operation: "build_context_pack", projectRoot: smallShell.paths.root, input: { query: "青铜树", cutoffChapterId: smallChapter.chapterId, maxCharacters: 256, maxSearchHits: 20 } },
    },
  } as const;
  const equivalence: Record<string, boolean> = {};
  const cliDurations: Record<string, number> = {};
  for (const [name, request] of Object.entries(readRequests)) {
    const mcpData = await callMcp(mcp.client, request.mcpTool, request.mcpInput);
    const cliResult = await runCli(request.cli, registryPath);
    requireCondition(cliResult.code === 0 && cliResult.response.ok === true, `CLI ${name} 调用失败。`);
    equivalence[name] = isDeepStrictEqual(mcpData, cliResult.response.data);
    cliDurations[name] = cliResult.durationMs;
    requireCondition(equivalence[name], `MCP/CLI ${name} 语义不一致。`);
  }

  const saveArguments = {
    projectRoot: smallShell.paths.root,
    requestId: "novel-agent-mcp-save-request-001",
    idempotencyKey: "novel-agent-cross-interface-save-001",
    request: {
      command: "novel_save_chapter",
      payload: {
        chapterId: smallChapter.chapterId,
        content: `${smallText}保存。`,
        expectedRevision: smallChapter.revision,
        expectedSha256: smallChapter.sha256,
      },
    },
  };
  const mcpSave = await callMcp(mcp.client, "execute_command", saveArguments);
  requireCondition(mcpSave.status === "succeeded" && mcpSave.replayed === false, "MCP CAS 保存未成功。 ");
  const cliReplay = await runCli({
    schemaVersion: 1,
    operation: "execute_command",
    projectRoot: smallShell.paths.root,
    input: {
      requestId: saveArguments.requestId,
      idempotencyKey: saveArguments.idempotencyKey,
      request: saveArguments.request,
    },
  }, registryPath);
  requireCondition(cliReplay.code === 0
    && cliReplay.response.data?.status === "succeeded"
    && cliReplay.response.data?.replayed === true, "CLI 没有重放 MCP 已完成的同键保存。 ");
  const stale = await runCli({
    schemaVersion: 1,
    operation: "execute_command",
    projectRoot: smallShell.paths.root,
    input: {
      requestId: "novel-agent-stale-save-request-001",
      idempotencyKey: "novel-agent-stale-save-key-001",
      request: {
        command: "novel_save_chapter",
        payload: {
          chapterId: smallChapter.chapterId,
          content: "过期 AI 不得覆盖",
          expectedRevision: smallChapter.revision,
          expectedSha256: smallChapter.sha256,
        },
      },
    },
  }, registryPath);
  requireCondition(stale.code === 1
    && stale.response.error?.code === "COMMAND_REJECTED", "CLI stale CAS 没有结构化拒绝。 ");
  const savedRead = await new NovelRepository(smallShell.paths.root).readChapter(smallChapter.chapterId);
  requireCondition(savedRead.status === "healthy" && savedRead.content === `${smallText}保存。`, "stale CAS 覆盖了成功正文。 ");

  const fixture = buildNovelScaleFixture({
    profile: "acceptance",
    scale: "S1",
    targetCharacters: 1_000_000,
    chapterCount: 500,
    seed: DEFAULT_FIXTURE_SEED,
    oracleCounts: { ...STANDARD_ORACLE_COUNTS },
  });
  const golden = JSON.parse(fixture.goldenAnswersJson) as GoldenAnswerDocument;
  const oracle = golden.answers.find((answer) => answer.category === "exact");
  requireCondition(oracle, "S1 夹具缺少 exact oracle。 ");
  const millionSearchQuery = oracle.expected.canonicalEntity;
  requireCondition(fixture.corpus.indexOf(millionSearchQuery) >= 0
    && fixture.corpus.indexOf(millionSearchQuery, fixture.corpus.indexOf(millionSearchQuery) + millionSearchQuery.length) < 0,
  "S1 exact canonical entity 不是唯一搜索锚点。 ");
  const sourcePath = path.join(sourceRoot, "agent-million.md");
  await writeFile(sourcePath, fixture.corpus, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const sourceBefore = {
    sha256: sha256(await readFile(sourcePath)),
    byteLength: (await stat(sourcePath)).size,
    charCount: fixture.corpus.length,
  };
  requireCondition(sourceBefore.sha256 === fixture.manifest.corpusSha256
    && sourceBefore.charCount === 1_000_000, "S1 来源身份不符合冻结 manifest。 ");

  const authorized = await createAuthorizedNovelImportPreflight(sourcePath);
  requireCondition(authorized.preflight.eligible && authorized.authorization, "S1 来源预检未通过。 ");
  requireCondition(authorized.preflight.summary.chapterCount === 500
    && authorized.preflight.summary.charCount === 1_000_000, "S1 预检规模错误。 ");
  const importRequest: Extract<NovelCommandRequest, { command: "novel_import_external_snapshot" }> = {
    command: "novel_import_external_snapshot",
    payload: {
      projectsRoot,
      projectName: "AI Agent 百万字小说",
      preflightId: authorized.preflight.preflightId,
      preflightFingerprint: authorized.preflight.fingerprint,
      sourceTreeAggregateSha256: authorized.preflight.sourceTreeAggregateSha256,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
      preflightAuthorization: authorized.authorization.authorizationId,
    },
  };
  const importStartedAt = performance.now();
  const imported = await executeIdempotentCommand(getNovelImportCommandOwnerRoot(), {
    requestId: "novel-agent-million-import-request-001",
    idempotencyKey: `novel-agent-million-import-${fixture.manifest.corpusSha256.slice(0, 40)}`,
    request: importRequest,
  });
  const importDurationMs = Math.round(performance.now() - importStartedAt);
  requireCondition(imported.status === "succeeded", "S1 导入命令未成功。 ");
  const importedProjectId = (imported.result as { receipt?: { projectId?: string } }).receipt?.projectId;
  requireCondition(importedProjectId, "S1 导入结果缺少 projectId。 ");
  const registration = (await listRegisteredProjects()).find((entry) => entry.id === importedProjectId);
  requireCondition(registration, "S1 导入工程没有注册。 ");
  const millionRoot = await realpath(registration.primaryRoot);
  const millionSnapshot = await new NovelRepository(millionRoot).snapshot();
  const millionChapters = orderedNovelChapters(millionSnapshot.chapters);
  const millionLastChapter = millionChapters.at(-1);
  requireCondition(millionLastChapter, "S1 导入工程缺少末章。");
  await executeIdempotentCommand(millionRoot, commandEnvelope("novel_seed_writing_state", {
    baselineStatus: "locked",
    sourceTreeAggregateSha256: authorized.preflight.sourceTreeAggregateSha256,
    currentThroughChapterId: millionLastChapter.chapterId,
    sourceDocuments: [],
    entities: [],
    hardCanon: [],
    characterStates: [],
    knowledge: [],
    relationships: [],
    timeline: [],
    foreshadowing: [],
    chapterBriefs: [],
    completedChapterIds: millionChapters.map((chapter) => chapter.chapterId),
  }), { novelWriteActor: "human_owner" });
  const millionWorkspace = await callMcp(mcp.client, "get_novel_manuscript_workspace", { projectRoot: millionRoot });
  requireCondition(millionWorkspace.manuscript?.chapterCount === 500, "MCP 未读到 500 章。 ");

  await callMcp(mcp.client, "search_novel_manuscript", {
    projectRoot: millionRoot,
    targetChapterId: millionLastChapter.chapterId,
    cutoff: "through",
    query: millionSearchQuery,
    limit: 200,
    maxHitsPerChapter: 5,
  });
  const searchStartedAt = performance.now();
  const millionSearch = await callMcp(mcp.client, "search_novel_manuscript", {
    projectRoot: millionRoot,
    targetChapterId: millionLastChapter.chapterId,
    cutoff: "through",
    query: millionSearchQuery,
    limit: 200,
    maxHitsPerChapter: 5,
  });
  const hotSearchDurationMs = Math.round(performance.now() - searchStartedAt);
  requireCondition(millionSearch.scannedChapters === 500
    && millionSearch.skippedExternalChanges === 0
    && millionSearch.hits.length >= 1, "百万字 MCP 搜索没有完整扫描或命中。 ");
  requireCondition(hotSearchDurationMs < 1_000, `百万字 MCP 热搜索耗时 ${hotSearchDurationMs}ms，超过 1 秒。`);
  const hit = millionSearch.hits.find((entry: Record<string, any>) => entry.snippet?.includes(millionSearchQuery))
    ?? millionSearch.hits[0];
  requireCondition(hit?.chapter?.chapterId, "百万字命中缺少 chapterId。 ");
  const millionContext = await callMcp(mcp.client, "build_novel_context_pack", {
    projectRoot: millionRoot,
    query: millionSearchQuery,
    cutoffChapterId: hit.chapter.chapterId,
    maxCharacters: 512,
    maxSearchHits: 20,
  });
  requireCondition(millionContext.excerpts?.length >= 1
    && millionContext.budget?.usedCharacters <= 512, "百万字上下文包缺失或超预算。 ");
  const excerpt = millionContext.excerpts[0];
  const excerptRead = await callMcp(mcp.client, "read_novel_manuscript_range", {
    projectRoot: millionRoot,
    targetChapterId: millionLastChapter.chapterId,
    cutoff: "through",
    chapterId: excerpt.chapter.chapterId,
    startOffset: excerpt.range.startOffset,
    maxCharacters: excerpt.range.endOffset - excerpt.range.startOffset,
  });
  requireCondition(excerptRead.content === excerpt.text
    && excerptRead.chapter.sha256 === excerpt.chapter.sha256, "context excerpt 无法按 locator 精确反查。 ");

  const sourceAfter = {
    sha256: sha256(await readFile(sourcePath)),
    byteLength: (await stat(sourcePath)).size,
    charCount: fixture.corpus.length,
  };
  requireCondition(isDeepStrictEqual(sourceBefore, sourceAfter), "导入、搜索或上下文读取改写了百万字来源。 ");

  const report = {
    schemaVersion: 1,
    kind: "novel-agent-contract-v1-acceptance",
    status: "PASS",
    generatedAt: new Date().toISOString(),
    scope: {
      aiFirst: true,
      uiChanged: false,
      remoteModelsCalled: false,
      secondAuthorityStoreAdded: false,
    },
    mcp: {
      sourceProcessStarted: true,
      toolCount: tools.tools.length,
      requiredTools,
      capabilityContract: capabilities.novelAgent.contract,
      activeProjectSelection: activeWorkspace.project.selection,
    },
    short100: {
      projectId: smallShell.project.id,
      initialCharacters: smallText.length,
      chapterId: smallChapter.chapterId,
      equivalence,
      cliDurationsMs: cliDurations,
      mcpSaveStatus: mcpSave.status,
      crossInterfaceReplay: cliReplay.response.data.replayed,
      staleCasRejected: stale.response.error.code,
      finalRevision: savedRead.status === "healthy" ? savedRead.chapter.revision : null,
      finalCharacters: savedRead.status === "healthy" ? savedRead.content.length : null,
    },
    million: {
      scale: "S1",
      projectId: importedProjectId,
      generatorVersion: fixture.manifest.generatorVersion,
      generatorSourceSha256: fixture.manifest.generatorSourceSha256,
      corpusSha256: fixture.manifest.corpusSha256,
      utf16Characters: fixture.manifest.utf16Characters,
      utf8Bytes: fixture.manifest.utf8Bytes,
      chapterCount: fixture.manifest.chapterCount,
      importDurationMs,
      search: {
        query: millionSearchQuery,
        hotDurationMs: hotSearchDurationMs,
        manifestRevision: millionSearch.manifestRevision,
        scannedChapters: millionSearch.scannedChapters,
        skippedExternalChanges: millionSearch.skippedExternalChanges,
        hitCount: millionSearch.hits.length,
      },
      context: {
        maximumCharacters: millionContext.budget.maximumCharacters,
        usedCharacters: millionContext.budget.usedCharacters,
        excerptCount: millionContext.excerpts.length,
        locatorRoundTrip: true,
        fingerprint: millionContext.fingerprint,
      },
      sourceUnchanged: isDeepStrictEqual(sourceBefore, sourceAfter),
    },
  };
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    evidencePath,
    mcpToolCount: report.mcp.toolCount,
    shortEquivalence: report.short100.equivalence,
    millionSearch: report.million.search,
    sourceUnchanged: report.million.sourceUnchanged,
  }, null, 2)}\n`);
} finally {
  await mcp?.client.close().catch(() => {});
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
  await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
}
