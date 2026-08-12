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
import process from "node:process";
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
} from "../src/core/sidecar.js";
import type { NovelCommandRequest } from "../src/core/novel-command-runtime.js";
import {
  buildNovelScaleFixture,
  DEFAULT_FIXTURE_SEED,
  STANDARD_ORACLE_COUNTS,
  type GoldenAnswerDocument,
} from "./create-novel-scale-fixtures.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceArgument = process.argv.find((entry) => entry.startsWith("--evidence="))?.slice("--evidence=".length);
const evidencePath = evidenceArgument
  ? path.resolve(evidenceArgument)
  : path.join(workspaceRoot, "docs/evidence/novel-agent-contract-v1/writing-os-v1-1m-500-acceptance.json");

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function commandEnvelope(command: string, payload: Record<string, unknown>, label: string = randomUUID()) {
  const identity = sha256(`${label}\0${command}`).slice(0, 32);
  return {
    requestId: `writing-os-smoke-request-${identity}`,
    idempotencyKey: `writing-os-smoke-key-${identity}`,
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
      if (signal) reject(new Error(`Novel Agent CLI被信号${signal}终止。`));
      else resolve(exitCode ?? 1);
    });
  });
  let response: Record<string, any>;
  try {
    response = JSON.parse(stdout.trim()) as Record<string, any>;
  } catch {
    throw new Error(`CLI stdout不是单一JSON：${stdout.slice(0, 500)}；stderr=${stderr.slice(0, 500)}`);
  }
  return { code, response, durationMs: Math.round(performance.now() - startedAt) };
}

function parseMcpResult(result: unknown): Record<string, any> {
  const typed = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = typed.content?.find((entry) => entry.type === "text")?.text ?? "{}";
  const value = JSON.parse(text) as Record<string, any>;
  if (typed.isError) throw new Error(`MCP工具失败：${text.slice(0, 2_000)}`);
  return value;
}

async function connectSourceMcp(registryPath: string) {
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
  const client = new Client({ name: "novel-writing-os-smoke", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function callMcp(client: Client, name: string, args: Record<string, unknown>) {
  return parseMcpResult(await client.callTool({ name, arguments: args }));
}

function cliRequest(operation: string, projectRoot: string, input: Record<string, unknown>) {
  return { schemaVersion: 1, operation, projectRoot, input };
}

await access(evidencePath).then(
  () => { throw new Error(`验收证据已存在，拒绝覆盖：${path.relative(workspaceRoot, evidencePath)}`); },
  () => undefined,
);

const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "novel-writing-os-")));
const registryPath = path.join(temporaryRoot, "registry", "projects.json");
const projectsRoot = path.join(temporaryRoot, "projects");
const sourceRoot = path.join(temporaryRoot, "source");
await Promise.all([mkdir(path.dirname(registryPath), { recursive: true }), mkdir(projectsRoot), mkdir(sourceRoot)]);
const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
let mcp: Awaited<ReturnType<typeof connectSourceMcp>> | undefined;

try {
  const smallShell = await createManagedProject({ parentRoot: projectsRoot, name: "写作OS三章闭环", workspaceMode: "novel" });
  await registerProject(smallShell.project);
  const initialized = await executeIdempotentCommand(smallShell.paths.root, commandEnvelope(
    "novel_initialize_manuscript",
    { sourceMode: "managed_markdown" },
    "small-initialize",
  ));
  let manifest = (initialized.result as {
    chapters: { revision: number; volumes: Array<{ volumeId: string }> };
  }).chapters;
  const volumeId = manifest.volumes[0]!.volumeId;
  const smallChapters: Array<{ chapterId: string; revision: number; sha256: string }> = [];
  for (const [index, content] of ["第一章已完成。", "", ""].entries()) {
    const created = await executeIdempotentCommand(smallShell.paths.root, commandEnvelope(
      "novel_create_chapter",
      { volumeId, title: `第${index + 1}章`, content, expectedManifestRevision: manifest.revision },
      `small-create-${index + 1}`,
    ), { novelWriteActor: "human_ui" });
    const result = created.result as {
      chapter: { chapterId: string; revision: number; sha256: string };
      manifest: typeof manifest;
    };
    smallChapters.push(result.chapter);
    manifest = result.manifest;
  }
  const [chapter1, chapter2, chapter3] = smallChapters as [
    { chapterId: string; revision: number; sha256: string },
    { chapterId: string; revision: number; sha256: string },
    { chapterId: string; revision: number; sha256: string },
  ];

  mcp = await connectSourceMcp(registryPath);
  const tools = await mcp.client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  const requiredTools = [
    "get_novel_manuscript_workspace",
    "get_novel_writing_state",
    "build_novel_context_pack",
    "prepare_novel_chapter_write",
    "doctor_novel_agent",
    "preflight_novel_chapter_write",
    "plan_novel_state_rebuild",
    "probe_novel_chapter_consistency",
    "search_novel_manuscript",
    "read_novel_manuscript_range",
    "execute_command",
  ];
  requireCondition(requiredTools.every((tool) => toolNames.has(tool)), "源码MCP缺少Writing OS工具。");
  const seedCommand: Extract<NovelCommandRequest, { command: "novel_seed_writing_state" }> = {
    command: "novel_seed_writing_state",
    payload: {
      baselineStatus: "locked",
      sourceTreeAggregateSha256: sha256("small-source-tree"),
      currentThroughChapterId: chapter1.chapterId,
      sourceDocuments: [{ sourceId: "small-p0", displayPath: "设定/P0.md", content: "不能把代价转嫁给无辜者。" }],
      entities: [{ entityId: "character-small", name: "小易", aliases: [], level: "L1", baseSummary: "证据优先。", sourceIds: ["small-p0"] }],
      hardCanon: [{ ruleId: "small-rule", text: "不能把代价转嫁给无辜者。", priority: 100, canonStatus: "canon", visibility: "writer", sourceIds: ["small-p0"] }],
      characterStates: [{
        stateId: "small-state",
        entityId: "character-small",
        throughChapterId: chapter1.chapterId,
        fields: { body: "正常", emotion: "警惕", known: ["第一章证据"], unknown: ["幕后身份"], relationships: [], goals: ["写第二章"], psychology: "先证据后行动", unresolved: [] },
        sourceIds: ["small-p0"],
      }],
      knowledge: [],
      relationships: [],
      timeline: [],
      foreshadowing: [],
      chapterBriefs: [
        { chapterId: chapter2.chapterId, summary: "推进证据", mustDo: ["做决定"], mustNotDo: ["泄露未来"], requiredCharacterIds: ["character-small"], sourceIds: ["small-p0"] },
        { chapterId: chapter3.chapterId, summary: "承接第二章状态", mustDo: ["继续证据链"], mustNotDo: ["跳过状态提交"], requiredCharacterIds: ["character-small"], sourceIds: ["small-p0"] },
      ],
      characterProfiles: [{
        entityId: "character-small",
        valuePriorities: ["证据优先", "不伤无辜"],
        coreDesire: "查清责任链",
        coreFear: "误伤无辜",
        secret: "仍在隐瞒旧案压力",
        boundaries: ["不转嫁代价"],
        forbiddenPhrases: ["一切尽在掌握"],
        vocabulary: ["证据", "对账"],
        sentencePatterns: ["短句，先结论后证据"],
        relationshipVoices: [],
        sampleLines: ["先对账。"],
        sourceIds: ["small-p0"],
      }],
      completedChapterIds: [chapter1.chapterId],
    },
  };
  const seeded = await executeIdempotentCommand(smallShell.paths.root, {
    requestId: "writing-os-small-seed-request",
    idempotencyKey: "writing-os-small-seed-key",
    request: seedCommand,
  }, { novelWriteActor: "human_owner" });
  requireCondition(seeded.status === "succeeded", "MCP seed writing state失败。");

  const smallStateMcp = await callMcp(mcp.client, "get_novel_writing_state", {
    projectRoot: smallShell.paths.root,
    targetChapterId: chapter2.chapterId,
    cutoff: "before",
    characterIds: ["character-small"],
  });
  const smallStateCli = await runCli(cliRequest("get_writing_state", smallShell.paths.root, {
    targetChapterId: chapter2.chapterId,
    cutoff: "before",
    characterIds: ["character-small"],
  }), registryPath);
  requireCondition(smallStateCli.code === 0 && isDeepStrictEqual(smallStateMcp, smallStateCli.response.data),
    "MCP/CLI writing-state语义不一致。");
  const doctorArgs = {
    projectRoot: smallShell.paths.root,
    targetChapterId: chapter2.chapterId,
    workflowMode: "formal" as const,
  };
  const doctorMcp = await callMcp(mcp.client, "doctor_novel_agent", doctorArgs);
  const doctorCli = await runCli(cliRequest("doctor", smallShell.paths.root, {
    targetChapterId: chapter2.chapterId,
    workflowMode: "formal",
  }), registryPath);
  requireCondition(doctorMcp.readyForPrepare === true && doctorCli.code === 0
    && isDeepStrictEqual(doctorMcp, doctorCli.response.data), "MCP/CLI doctor语义不一致或写章未ready。");
  const packArgs = {
    projectRoot: smallShell.paths.root,
    taskType: "continue_chapter",
    targetChapterId: chapter2.chapterId,
    characterIds: ["character-small"],
    maxCharacters: 2_048,
  };
  const smallPackMcp = await callMcp(mcp.client, "build_novel_context_pack", packArgs);
  const smallPackCli = await runCli(cliRequest("build_context_pack", smallShell.paths.root, {
    taskType: "continue_chapter",
    targetChapterId: chapter2.chapterId,
    characterIds: ["character-small"],
    maxCharacters: 2_048,
    maxSearchHits: 20,
  }), registryPath);
  requireCondition(smallPackCli.code === 0 && isDeepStrictEqual(smallPackMcp, smallPackCli.response.data),
    "MCP/CLI Context Pack 2.0语义不一致。");
  const preflightArgs = {
    projectRoot: smallShell.paths.root,
    targetChapterId: chapter2.chapterId,
    contextPackFingerprint: smallPackMcp.fingerprint,
    characterIds: ["character-small"],
    maxCharacters: 2_048,
    maxSearchHits: 20,
  };
  const smallPreflightMcp = await callMcp(mcp.client, "preflight_novel_chapter_write", preflightArgs);
  const smallPreflightCli = await runCli(cliRequest("preflight_chapter_write", smallShell.paths.root, {
    targetChapterId: chapter2.chapterId,
    contextPackFingerprint: smallPackMcp.fingerprint,
    characterIds: ["character-small"],
    maxCharacters: 2_048,
    maxSearchHits: 20,
  }), registryPath);
  requireCondition(smallPreflightMcp.ready === true && smallPreflightCli.code === 0
    && isDeepStrictEqual(smallPreflightMcp, smallPreflightCli.response.data), "MCP/CLI preflight语义不一致。");
  const smallAttribution = {
    actorId: "contract-smoke-writer",
    provider: "local-fixture",
    model: "deterministic-smoke",
    sessionId: "writing-os-contract-smoke",
    transport: "mcp" as const,
  };
  const prepared = await callMcp(mcp.client, "prepare_novel_chapter_write", {
    projectRoot: smallShell.paths.root,
    taskType: "continue_chapter",
    targetChapterId: chapter2.chapterId,
    characterIds: ["character-small"],
    maxCharacters: 2_048,
    maxSearchHits: 20,
    attribution: smallAttribution,
  });
  requireCondition(prepared.ready === true && prepared.leaseToken && prepared.aiWriteContext,
    "MCP prepare_novel_chapter_write未签发正式写租约。");
  const saveRequest = {
    command: "novel_save_chapter",
    payload: {
      chapterId: chapter2.chapterId,
      content: "第二章AI受管正文。",
      expectedRevision: chapter2.revision,
      expectedSha256: chapter2.sha256,
      aiWriteContext: prepared.aiWriteContext,
    },
  };
  const saved = await callMcp(mcp.client, "execute_command", {
    projectRoot: smallShell.paths.root,
    requestId: "writing-os-small-save-request",
    idempotencyKey: "writing-os-small-save-key",
    request: saveRequest,
    novelWriteLeaseToken: prepared.leaseToken,
    novelActorAttribution: smallAttribution,
  });
  requireCondition(saved.status === "succeeded" && saved.replayed === false, "MCP AI save失败。");
  const replay = await runCli(cliRequest("execute_command", smallShell.paths.root, {
    requestId: "writing-os-small-save-request",
    idempotencyKey: "writing-os-small-save-key",
    request: saveRequest,
    novelWriteLeaseToken: prepared.leaseToken,
    novelActorAttribution: smallAttribution,
  }), registryPath);
  requireCondition(replay.code === 0 && replay.response.data?.replayed === true, "CLI未重放MCP保存。");
  const savedChapter = saved.result.chapter as { chapterId: string; revision: number; sha256: string };
  const stale = await runCli(cliRequest("execute_command", smallShell.paths.root, {
    requestId: "writing-os-small-stale-request",
    idempotencyKey: "writing-os-small-stale-key",
    request: {
      command: "novel_save_chapter",
      payload: {
        chapterId: savedChapter.chapterId,
        content: "旧上下文不得覆盖。",
        expectedRevision: savedChapter.revision,
        expectedSha256: savedChapter.sha256,
        aiWriteContext: prepared.aiWriteContext,
      },
    },
    novelWriteLeaseToken: prepared.leaseToken,
    novelActorAttribution: smallAttribution,
  }), registryPath);
  requireCondition(stale.code === 1 && stale.response.error?.details?.reason === "context_preflight_stale",
    "CLI没有按context_preflight_stale拒绝旧AI身份。");
  const ticket = await runCli(cliRequest("execute_command", smallShell.paths.root, {
    requestId: "writing-os-small-ticket-request",
    idempotencyKey: "writing-os-small-ticket-key",
    request: {
      command: "novel_attach_review_ticket",
      payload: {
        chapterId: savedChapter.chapterId,
        expectedChapterRevision: savedChapter.revision,
        expectedChapterSha256: savedChapter.sha256,
        startOffset: 0,
        endOffset: 3,
        evidenceExcerpt: "第二章",
        severity: "P1",
        impact: "开场可具体",
        minimalFix: "补动作",
        confidence: 0.9,
        reviewer: "local-reviewer",
      },
    },
  }), registryPath);
  requireCondition(ticket.code === 0, "CLI attach review ticket失败。");
  const beforeCandidateState = await callMcp(mcp.client, "get_novel_writing_state", {
    projectRoot: smallShell.paths.root,
    targetChapterId: chapter2.chapterId,
    cutoff: "through",
  });
  const staged = await callMcp(mcp.client, "execute_command", {
    projectRoot: smallShell.paths.root,
    requestId: "writing-os-small-stage-request",
    idempotencyKey: "writing-os-small-stage-key",
    request: {
      command: "novel_stage_chapter_state_candidate",
      payload: {
        chapterId: savedChapter.chapterId,
        expectedChapterRevision: savedChapter.revision,
        expectedChapterSha256: savedChapter.sha256,
        expectedWritingStateRevision: beforeCandidateState.stateIdentity.revision,
        expectedWritingStateFingerprint: beforeCandidateState.stateIdentity.fingerprint,
        summary: "第二章章末勾账",
        delta: {
          characterStates: [{
            stateId: "small-state",
            entityId: "character-small",
            fields: { body: "正常", emotion: "坚定", known: ["第二章证据"], unknown: ["幕后身份"], relationships: [], goals: ["写第三章"], psychology: "决定继续", unresolved: [] },
          }],
          knowledge: [], relationships: [], timeline: [], foreshadowing: [],
        },
        evidenceSpans: [{ evidenceId: "small-evidence-state", startOffset: 0, endOffset: 3, evidenceExcerpt: "第二章" }],
        changeEvidence: [{
          kind: "character_state",
          recordId: "small-state",
          reason: "第二章正文形成新的章末人物目标",
          evidenceSpanIds: ["small-evidence-state"],
        }],
        auditScope: {
          checkedCharacterIds: ["character-small"],
          checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"],
        },
      },
    },
  });
  const candidate = staged.result.candidate as { candidateId: string; fingerprint: string };
  const committed = await executeIdempotentCommand(smallShell.paths.root, {
    requestId: "writing-os-small-commit-request",
    idempotencyKey: "writing-os-small-commit-key",
    request: {
      command: "novel_review_chapter_state_candidate",
      payload: {
        candidateId: candidate.candidateId,
        expectedCandidateFingerprint: candidate.fingerprint,
        expectedWritingStateRevision: beforeCandidateState.stateIdentity.revision,
        expectedWritingStateFingerprint: beforeCandidateState.stateIdentity.fingerprint,
        decision: "accepted",
        reviewer: "human-owner",
      },
    },
  }, { novelWriteActor: "human_owner" });
  requireCondition((committed.result as { state?: { currentThroughChapterId?: string } }).state?.currentThroughChapterId === chapter2.chapterId,
    "owner accepted candidate未推进writing-state。");
  const probeMcp = await callMcp(mcp.client, "probe_novel_chapter_consistency", {
    projectRoot: smallShell.paths.root,
    targetChapterId: chapter2.chapterId,
    workflowMode: "formal",
  });
  const probeCli = await runCli(cliRequest("probe_chapter_consistency", smallShell.paths.root, {
    targetChapterId: chapter2.chapterId,
    workflowMode: "formal",
  }), registryPath);
  requireCondition(probeMcp.status === "pass" && probeCli.code === 0
    && isDeepStrictEqual(probeMcp, probeCli.response.data), "MCP/CLI一致性probe语义不一致或未通过。");
  const pack3 = await callMcp(mcp.client, "build_novel_context_pack", {
    projectRoot: smallShell.paths.root,
    taskType: "continue_chapter",
    targetChapterId: chapter3.chapterId,
    characterIds: ["character-small"],
    maxCharacters: 2_048,
  });
  const preflight3 = await callMcp(mcp.client, "preflight_novel_chapter_write", {
    projectRoot: smallShell.paths.root,
    targetChapterId: chapter3.chapterId,
    contextPackFingerprint: pack3.fingerprint,
    characterIds: ["character-small"],
    maxCharacters: 2_048,
  });
  requireCondition(preflight3.ready === true, "状态commit后第三章preflight未ready。");

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
  requireCondition(oracle, "S1夹具缺少exact oracle。");
  const sourcePath = path.join(sourceRoot, "writing-os-million.md");
  await writeFile(sourcePath, fixture.corpus, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const sourceBefore = {
    sha256: sha256(await readFile(sourcePath)),
    byteLength: (await stat(sourcePath)).size,
    charCount: fixture.corpus.length,
  };
  const authorized = await createAuthorizedNovelImportPreflight(sourcePath);
  requireCondition(authorized.preflight.eligible && authorized.authorization
    && authorized.preflight.summary.chapterCount === 500, "S1来源预检未通过。");
  const importRequest: Extract<NovelCommandRequest, { command: "novel_import_external_snapshot" }> = {
    command: "novel_import_external_snapshot",
    payload: {
      projectsRoot,
      projectName: "Writing OS 百万字500章",
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
    requestId: "writing-os-million-import-request",
    idempotencyKey: `writing-os-million-import-${fixture.manifest.corpusSha256.slice(0, 40)}`,
    request: importRequest,
  });
  const importDurationMs = Math.round(performance.now() - importStartedAt);
  const importedProjectId = (imported.result as { receipt?: { projectId?: string } }).receipt?.projectId;
  requireCondition(importedProjectId, "S1导入缺少projectId。");
  const registration = (await listRegisteredProjects()).find((entry) => entry.id === importedProjectId);
  requireCondition(registration, "S1导入工程未注册。");
  const millionRoot = await realpath(registration.primaryRoot);
  const millionSnapshot = await new NovelRepository(millionRoot).snapshot();
  const millionChapters = orderedNovelChapters(millionSnapshot.chapters);
  requireCondition(millionChapters.length === 500, "S1受管工程不是500章。");
  const target = millionChapters[499]!;
  const through = millionChapters[498]!;
  const seedStartedAt = performance.now();
  await executeIdempotentCommand(millionRoot, commandEnvelope("novel_seed_writing_state", {
    baselineStatus: "locked",
    sourceTreeAggregateSha256: authorized.preflight.sourceTreeAggregateSha256,
    currentThroughChapterId: through.chapterId,
    sourceDocuments: [{ sourceId: "scale-p0", displayPath: "fixture/P0.md", content: "规模夹具硬规则：不得读取目标章及其后的正文。" }],
    entities: [{ entityId: "scale-character", name: "规模角色", aliases: [], level: "L1", baseSummary: "跨章状态测试角色。", sourceIds: ["scale-p0"] }],
    hardCanon: [{ ruleId: "scale-past-only", text: "不得读取目标章及其后的正文。", priority: 100, canonStatus: "canon", visibility: "writer", sourceIds: ["scale-p0"] }],
    characterStates: [{
      stateId: "scale-state",
      entityId: "scale-character",
      throughChapterId: through.chapterId,
      fields: { body: "稳定", emotion: "专注", known: ["前499章"], unknown: ["第500章正文"], relationships: [], goals: ["继续第500章"], psychology: "保持过去时", unresolved: [] },
      sourceIds: ["scale-p0"],
    }],
    knowledge: [{
      knowledgeId: "scale-future-secret",
      entityId: "scale-character",
      fact: "未来章秘密",
      status: "planned_later",
      rawValue: "第500章后知",
      sourceIds: ["scale-p0"],
    }],
    relationships: [],
    timeline: [{ timelineId: "scale-timeline", storyTime: "第499章末", summary: "规模状态截止", endChapterId: through.chapterId, sourceIds: ["scale-p0"] }],
    foreshadowing: [],
    chapterBriefs: [{ chapterId: target.chapterId, summary: "继续第500章", mustDo: ["保持状态"], mustNotDo: ["偷看第500章现有正文"], requiredCharacterIds: ["scale-character"], sourceIds: ["scale-p0"] }],
    characterProfiles: [{
      entityId: "scale-character",
      valuePriorities: ["时态一致", "只使用截止章证据"],
      coreDesire: "稳定推进长篇任务",
      coreFear: "把未来信息写回过去",
      secret: "无",
      boundaries: ["不越过 cutoff"],
      forbiddenPhrases: ["未来章秘密"],
      vocabulary: ["截止章", "状态"],
      sentencePatterns: ["简洁陈述"],
      relationshipVoices: [],
      sampleLines: ["只按截止章继续。"],
      sourceIds: ["scale-p0"],
    }],
    completedChapterIds: millionChapters.slice(0, 499).map((chapter) => chapter.chapterId),
  }, "million-state-seed"), { novelWriteActor: "human_owner" });
  const seedDurationMs = Math.round(performance.now() - seedStartedAt);
  const stateArgs = {
    projectRoot: millionRoot,
    targetChapterId: target.chapterId,
    cutoff: "before",
    characterIds: ["scale-character"],
  };
  const scaleStateMcp = await callMcp(mcp.client, "get_novel_writing_state", stateArgs);
  const scaleStateCli = await runCli(cliRequest("get_writing_state", millionRoot, {
    targetChapterId: target.chapterId,
    cutoff: "before",
    characterIds: ["scale-character"],
  }), registryPath);
  requireCondition(scaleStateCli.code === 0 && isDeepStrictEqual(scaleStateMcp, scaleStateCli.response.data)
    && scaleStateMcp.temporal.cutoffChapterId === through.chapterId
    && !scaleStateMcp.temporal.knowledge.some((entry: { knowledgeId: string }) => entry.knowledgeId === "scale-future-secret"),
  "S1时态投影、MCP/CLI等价或future knowledge过滤失败。");
  const scalePackArgs = {
    projectRoot: millionRoot,
    taskType: "continue_chapter",
    targetChapterId: target.chapterId,
    characterIds: ["scale-character"],
    maxCharacters: 4_096,
  };
  const packStartedAt = performance.now();
  const scalePackMcp = await callMcp(mcp.client, "build_novel_context_pack", scalePackArgs);
  const packDurationMs = Math.round(performance.now() - packStartedAt);
  const scalePackRepeat = await callMcp(mcp.client, "build_novel_context_pack", scalePackArgs);
  const scalePackCli = await runCli(cliRequest("build_context_pack", millionRoot, {
    taskType: "continue_chapter",
    targetChapterId: target.chapterId,
    characterIds: ["scale-character"],
    maxCharacters: 4_096,
    maxSearchHits: 20,
  }), registryPath);
  requireCondition(scalePackCli.code === 0 && isDeepStrictEqual(scalePackMcp, scalePackCli.response.data)
    && scalePackMcp.fingerprint === scalePackRepeat.fingerprint
    && scalePackMcp.contextPackVersion === 2
    && scalePackMcp.budget.usedCharacters <= 4_096
    && !scalePackMcp.excerpts.some((entry: { chapter: { chapterId: string } }) => entry.chapter.chapterId === target.chapterId),
  "S1 Context Pack 2.0等价、确定性、预算或future正文隔离失败。");
  const scalePreflightMcp = await callMcp(mcp.client, "preflight_novel_chapter_write", {
    projectRoot: millionRoot,
    targetChapterId: target.chapterId,
    contextPackFingerprint: scalePackMcp.fingerprint,
    characterIds: ["scale-character"],
    maxCharacters: 4_096,
  });
  const scalePreflightCli = await runCli(cliRequest("preflight_chapter_write", millionRoot, {
    targetChapterId: target.chapterId,
    contextPackFingerprint: scalePackMcp.fingerprint,
    characterIds: ["scale-character"],
    maxCharacters: 4_096,
    maxSearchHits: 20,
  }), registryPath);
  requireCondition(scalePreflightMcp.ready === true && scalePreflightCli.code === 0
    && isDeepStrictEqual(scalePreflightMcp, scalePreflightCli.response.data), "S1 preflight不ready或MCP/CLI不等价。");
  const excerpt = scalePackMcp.excerpts[0];
  requireCondition(excerpt, "S1 Context Pack 2.0没有正文excerpt。");
  const excerptRead = await callMcp(mcp.client, "read_novel_manuscript_range", {
    projectRoot: millionRoot,
    targetChapterId: target.chapterId,
    cutoff: "before",
    chapterId: excerpt.chapter.chapterId,
    startOffset: excerpt.range.startOffset,
    maxCharacters: excerpt.range.endOffset - excerpt.range.startOffset,
  });
  requireCondition(excerptRead.content === excerpt.text && excerptRead.chapter.sha256 === excerpt.chapter.sha256,
    "S1 excerpt locator无法精确反查。");
  await callMcp(mcp.client, "search_novel_manuscript", {
    projectRoot: millionRoot,
    targetChapterId: target.chapterId,
    cutoff: "before",
    query: oracle.expected.canonicalEntity,
    limit: 200,
    maxHitsPerChapter: 5,
  });
  const searchStartedAt = performance.now();
  const searchResult = await callMcp(mcp.client, "search_novel_manuscript", {
    projectRoot: millionRoot,
    targetChapterId: target.chapterId,
    cutoff: "before",
    query: oracle.expected.canonicalEntity,
    limit: 200,
    maxHitsPerChapter: 5,
  });
  const searchDurationMs = Math.round(performance.now() - searchStartedAt);
  requireCondition(searchResult.scannedChapters === 499 && searchResult.skippedExternalChanges === 0
    && searchResult.hits.length >= 1, "S1搜索未完整扫描或命中。");
  const sourceAfter = {
    sha256: sha256(await readFile(sourcePath)),
    byteLength: (await stat(sourcePath)).size,
    charCount: fixture.corpus.length,
  };
  requireCondition(isDeepStrictEqual(sourceBefore, sourceAfter), "S1导入/状态/检索改写了来源。");

  const report = {
    schemaVersion: 1,
    kind: "novel-writing-os-v1-1m-500-acceptance",
    status: "PASS",
    generatedAt: new Date().toISOString(),
    scope: {
      remoteModelsCalled: false,
      feesIncurred: false,
      formalNovelSourcesTouched: false,
      temporaryProjectsCleanedAfterReport: true,
    },
    runtime: {
      transport: "source-stdio-and-json-cli",
      toolCount: tools.tools.length,
      requiredTools,
    },
    smallVerticalSlice: {
      mcpCliEquivalent: { state: true, contextPack2: true, preflight: true },
      aiSaveRevision: savedChapter.revision,
      crossInterfaceReplay: true,
      staleReason: stale.response.error.details.reason,
      reviewTicketAttached: true,
      stateCommittedThroughChapter2: true,
      chapter3PreflightReady: preflight3.ready,
    },
    million: {
      scale: "S1",
      targetCharacters: fixture.manifest.targetCharacters,
      utf16Characters: fixture.manifest.utf16Characters,
      utf8Bytes: fixture.manifest.utf8Bytes,
      chapterCount: millionChapters.length,
      corpusSha256: fixture.manifest.corpusSha256,
      logicalFingerprint: fixture.manifest.logicalFingerprint,
      importDurationMs,
      seedDurationMs,
      stateRevision: scaleStateMcp.stateIdentity.revision,
      completionCount: millionChapters.slice(0, 499).length,
      cutoffChapterId: scaleStateMcp.temporal.cutoffChapterId,
      contextPack: {
        version: scalePackMcp.contextPackVersion,
        fingerprint: scalePackMcp.fingerprint,
        deterministicRepeat: scalePackMcp.fingerprint === scalePackRepeat.fingerprint,
        maximumCharacters: scalePackMcp.budget.maximumCharacters,
        usedCharacters: scalePackMcp.budget.usedCharacters,
        excerptCount: scalePackMcp.excerpts.length,
        targetChapterExcluded: !scalePackMcp.excerpts.some((entry: { chapter: { chapterId: string } }) => entry.chapter.chapterId === target.chapterId),
        locatorRoundTrip: true,
        durationMs: packDurationMs,
      },
      preflight: { ready: scalePreflightMcp.ready, preflightId: scalePreflightMcp.preflightId },
      search: {
        scannedChapters: searchResult.scannedChapters,
        skippedExternalChanges: searchResult.skippedExternalChanges,
        hitCount: searchResult.hits.length,
        hotDurationMs: searchDurationMs,
      },
      sourceUnchanged: true,
    },
  };
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    evidence: path.relative(workspaceRoot, evidencePath),
    toolCount: tools.tools.length,
    smallChapter3Ready: preflight3.ready,
    millionChapters: millionChapters.length,
    millionContextMs: packDurationMs,
    millionSearchMs: searchDurationMs,
  })}\n`);
} finally {
  await mcp?.client.close().catch(() => undefined);
  await mcp?.transport.close().catch(() => undefined);
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
  await rm(temporaryRoot, { recursive: true, force: true });
}
