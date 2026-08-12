import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { executeIdempotentCommand, listCommandLedger } from "../src/core/command-bus.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  doctorNovelAgent,
  prepareNovelChapterWrite,
  probeNovelChapterConsistency,
} from "../src/core/novel-agent-service.js";
import {
  executeNovelAgentJsonRequest,
  parseNovelAgentJsonRequest,
} from "../src/core/novel-agent-json.js";
import { NovelRepository } from "../src/core/novel-manuscript.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];
const originalRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
let sequence = 0;
const cliAttribution = {
  actorId: "codex-cli-test-writer",
  provider: "openai",
  model: "fixture-model",
  sessionId: "novel-agent-cli-test",
  transport: "json_cli" as const,
};

afterEach(async () => {
  if (originalRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = originalRegistryPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function commandEnvelope(command: string, payload: Record<string, unknown>) {
  sequence += 1;
  return {
    requestId: `cli-fixture-request-${sequence}-${randomUUID()}`,
    idempotencyKey: `cli-fixture-key-${sequence}-${randomUUID()}`,
    request: { command, payload },
  } as Parameters<typeof executeIdempotentCommand>[1];
}

async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "小说 CLI 空格-")));
  roots.push(parent);
  const registryPath = path.join(parent, "registry with spaces", "projects.json");
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  const shell = await createManagedProject({
    parentRoot: parent,
    name: "Claude Grok 中文小说",
    workspaceMode: "novel",
  });
  const initialized = await executeIdempotentCommand(shell.paths.root, commandEnvelope(
    "novel_initialize_manuscript",
    { sourceMode: "managed_markdown" },
  ));
  const init = initialized.result as { chapters: { revision: number; volumes: Array<{ volumeId: string }> } };
  const created = await executeIdempotentCommand(shell.paths.root, commandEnvelope("novel_create_chapter", {
    volumeId: init.chapters.volumes[0]!.volumeId,
    title: "CLI 第一章",
    content: "青铜树下的 CLI 原始正文",
    expectedManifestRevision: init.chapters.revision,
  }), { novelWriteActor: "human_ui" });
  const chapter = (created.result as {
    chapter: { chapterId: string; revision: number; sha256: string };
  }).chapter;
  await executeIdempotentCommand(shell.paths.root, commandEnvelope("novel_seed_writing_state", {
    baselineStatus: "locked",
    sourceTreeAggregateSha256: "a".repeat(64),
    currentThroughChapterId: chapter.chapterId,
    sourceDocuments: [],
    entities: [],
    hardCanon: [],
    characterStates: [],
    knowledge: [],
    relationships: [],
    timeline: [],
    foreshadowing: [],
    chapterBriefs: [{
      chapterId: chapter.chapterId,
      summary: "在不改变既有正典的前提下验证 CLI 修订与 CAS 行为。",
      mustDo: ["仅修改目标章节正文"],
      mustNotDo: ["引入未声明角色"],
      requiredCharacterIds: [],
      sourceIds: [],
    }],
    completedChapterIds: [chapter.chapterId],
  }), { novelWriteActor: "human_owner" });
  return { shell, registryPath, chapter };
}

async function writeContext(projectRoot: string, chapterId: string) {
  const prepared = await prepareNovelChapterWrite(projectRoot, {
    taskType: "revise_chapter",
    targetChapterId: chapterId,
    workflowMode: "formal",
    maxCharacters: 12_000,
    maxSearchHits: 20,
    attribution: cliAttribution,
  });
  if (!prepared.ready) throw new Error("CLI 夹具正式 prepare 未 ready。");
  return {
    aiWriteContext: prepared.aiWriteContext,
    novelWriteLeaseToken: prepared.leaseToken,
    novelActorAttribution: prepared.attribution,
  };
}

async function runCli(request: unknown, registryPath?: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  response: Record<string, any>;
}> {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/novel-agent-cli.ts"], {
    cwd: workspace,
    env: {
      ...process.env,
      ...(registryPath ? { AI_CANVAS_REGISTRY_PATH: registryPath } : {}),
    },
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
  return {
    code,
    stdout,
    stderr,
    response: JSON.parse(stdout.trim() || "{}") as Record<string, any>,
  };
}

describe("Novel Agent JSON CLI", () => {
  it("capabilities 是单请求/单 JSON stdout，且无需项目或 UI", async () => {
    const result = await runCli({ schemaVersion: 1, operation: "capabilities" });
    expect(result.code).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.response).toMatchObject({
      schemaVersion: 1,
      ok: true,
      operation: "capabilities",
      data: {
        contract: "aicanvas.novel-agent",
        transport: { jsonCli: true },
        operations: {
          controlTools: ["prepare_novel_chapter_write"],
          controlOperations: [{
            transports: {
              mcpTool: "prepare_novel_chapter_write",
              jsonCliOperation: "prepare_novel_chapter_write",
              jsonCliLegacyAliases: ["prepare_chapter_write"],
            },
          }],
        },
      },
    });
  });

  it("JSON V1 同时接受 canonical prepare 名与 legacy 短名", () => {
    const input = {
      targetChapterId: "chapter-contract-alias",
      workflowMode: "rehearsal" as const,
      attribution: {
        actorId: "grok-contract-check",
        provider: "xai",
        model: "grok-4.5",
        sessionId: "contract-alias-session",
        transport: "json_cli" as const,
      },
    };
    expect(parseNovelAgentJsonRequest({
      schemaVersion: 1,
      operation: "prepare_novel_chapter_write",
      projectRoot: "/tmp/alias-only-no-read",
      input,
    })).toMatchObject({ operation: "prepare_novel_chapter_write", input });
    expect(parseNovelAgentJsonRequest({
      schemaVersion: 1,
      operation: "prepare_chapter_write",
      projectRoot: "/tmp/alias-only-no-read",
      input,
    })).toMatchObject({ operation: "prepare_chapter_write", input });
  });

  it("JSON CLI 暴露状态谱系与 rebuild recovery 状态", async () => {
    const { shell } = await fixture();
    await expect(executeNovelAgentJsonRequest({
      schemaVersion: 1,
      operation: "get_state_rebuild_status",
      projectRoot: shell.paths.root,
    })).resolves.toMatchObject({
      operation: "get_state_rebuild_status",
      data: {
        kind: "novel-writing-state-history-status",
        initialized: true,
        healthy: true,
        recoveryRequired: false,
        verificationMode: "full",
        verifiedEventCount: 0,
      },
    });
  });

  it("中文空格路径可通过 CLI 读/搜，并由同一 execute_command 做 CAS 保存和幂等重放", async () => {
    const { shell, registryPath, chapter } = await fixture();
    expect(shell.paths.root).toMatch(/小说 CLI 空格/u);

    const workspaceResult = await runCli({
      schemaVersion: 1,
      operation: "workspace",
      projectRoot: shell.paths.root,
    }, registryPath);
    expect(workspaceResult).toMatchObject({
      code: 0,
      response: { ok: true, operation: "workspace", data: { manuscript: { chapterCount: 1 } } },
    });

    const searchResult = await runCli({
      schemaVersion: 1,
      operation: "search",
      projectRoot: shell.paths.root,
      input: {
        targetChapterId: chapter.chapterId,
        cutoff: "through",
        query: "青铜树",
        limit: 10,
        maxHitsPerChapter: 2,
      },
    }, registryPath);
    expect(searchResult.response).toMatchObject({
      ok: true,
      data: { scannedChapters: 1, skippedExternalChanges: 0, hits: [{ chapter: { chapterId: chapter.chapterId } }] },
    });

    const write = await writeContext(shell.paths.root, chapter.chapterId);

    const saveRequest = {
      schemaVersion: 1,
      operation: "execute_command",
      projectRoot: shell.paths.root,
      input: {
        requestId: "novel-cli-save-request-001",
        idempotencyKey: "novel-cli-save-key-001",
        novelWriteLeaseToken: write.novelWriteLeaseToken,
        novelActorAttribution: write.novelActorAttribution,
        request: {
          command: "novel_save_chapter",
          payload: {
            chapterId: chapter.chapterId,
            content: "CLI 保存后的正文",
            expectedRevision: chapter.revision,
            expectedSha256: chapter.sha256,
            aiWriteContext: write.aiWriteContext,
          },
        },
      },
    };
    const saved = await runCli(saveRequest, registryPath);
    expect(saved.response).toMatchObject({
      ok: true,
      operation: "execute_command",
      data: { status: "succeeded", replayed: false, command: "novel_save_chapter" },
    });
    const replay = await runCli(saveRequest, registryPath);
    expect(replay.response).toMatchObject({ ok: true, data: { status: "succeeded", replayed: true } });
    await expect(new NovelRepository(shell.paths.root).readChapter(chapter.chapterId)).resolves.toMatchObject({
      status: "healthy",
      content: "CLI 保存后的正文",
      chapter: { revision: 2 },
    });
  });

  it("stale CAS 返回结构化非零错误，且不会覆盖第一次成功保存", async () => {
    const { shell, registryPath, chapter } = await fixture();
    const firstWrite = await writeContext(shell.paths.root, chapter.chapterId);
    const first = await runCli({
      schemaVersion: 1,
      operation: "execute_command",
      projectRoot: shell.paths.root,
      input: {
        requestId: "novel-cli-first-save-request",
        idempotencyKey: "novel-cli-first-save-key",
        novelWriteLeaseToken: firstWrite.novelWriteLeaseToken,
        novelActorAttribution: firstWrite.novelActorAttribution,
        request: {
          command: "novel_save_chapter",
          payload: {
            chapterId: chapter.chapterId,
            content: "第一次成功保存",
            expectedRevision: chapter.revision,
            expectedSha256: chapter.sha256,
            aiWriteContext: firstWrite.aiWriteContext,
          },
        },
      },
    }, registryPath);
    expect(first.code).toBe(0);

    const currentWrite = await writeContext(shell.paths.root, chapter.chapterId);

    const stale = await runCli({
      schemaVersion: 1,
      operation: "execute_command",
      projectRoot: shell.paths.root,
      input: {
        requestId: "novel-cli-stale-save-request",
        idempotencyKey: "novel-cli-stale-save-key",
        novelWriteLeaseToken: currentWrite.novelWriteLeaseToken,
        novelActorAttribution: currentWrite.novelActorAttribution,
        request: {
          command: "novel_save_chapter",
          payload: {
            chapterId: chapter.chapterId,
            content: "过期 AI 不应覆盖",
            expectedRevision: chapter.revision,
            expectedSha256: chapter.sha256,
            aiWriteContext: currentWrite.aiWriteContext,
          },
        },
      },
    }, registryPath);
    expect(stale.code).toBe(1);
    expect(stale.response).toMatchObject({
      schemaVersion: 1,
      ok: false,
      operation: "execute_command",
      error: {
        code: "COMMAND_REJECTED",
        details: { applied: false, entityType: "novel_manuscript" },
      },
    });
    await expect(new NovelRepository(shell.paths.root).readChapter(chapter.chapterId)).resolves.toMatchObject({
      status: "healthy",
      content: "第一次成功保存",
    });
  });

  it("Agent CLI 创建非空章或无 aiWriteContext 保存均失败关闭，且不创建命令账本", async () => {
    const { shell, registryPath, chapter } = await fixture();
    const repository = new NovelRepository(shell.paths.root);
    const beforeCreate = await repository.snapshot();
    const createIdempotencyKey = "novel-cli-no-context-create-key";
    const rejectedCreate = await runCli({
      schemaVersion: 1,
      operation: "execute_command",
      projectRoot: shell.paths.root,
      input: {
        requestId: "novel-cli-no-context-create-request",
        idempotencyKey: createIdempotencyKey,
        request: {
          command: "novel_create_chapter",
          payload: {
            volumeId: beforeCreate.chapters!.volumes[0]!.volumeId,
            title: "不得绕过 Writing OS 的新章",
            content: "Agent 不能在 create 中直接塞入完整正文",
            expectedManifestRevision: beforeCreate.chapters!.revision,
          },
        },
      },
    }, registryPath);
    expect(rejectedCreate).toMatchObject({
      code: 1,
      response: {
        ok: false,
        operation: "execute_command",
        error: { code: "COMMAND_REJECTED", details: { reason: "context_preflight_required" } },
      },
    });
    expect((await listCommandLedger(shell.paths.root)).some((entry) => entry.idempotencyKey === createIdempotencyKey))
      .toBe(false);
    expect((await repository.snapshot()).chapters).toMatchObject({
      revision: beforeCreate.chapters!.revision,
      chapters: [{ chapterId: chapter.chapterId }],
    });

    const idempotencyKey = "novel-cli-no-context-save-key";
    const rejected = await runCli({
      schemaVersion: 1,
      operation: "execute_command",
      projectRoot: shell.paths.root,
      input: {
        requestId: "novel-cli-no-context-save-request",
        idempotencyKey,
        request: {
          command: "novel_save_chapter",
          payload: {
            chapterId: chapter.chapterId,
            content: "不得绕过 Writing OS",
            expectedRevision: chapter.revision,
            expectedSha256: chapter.sha256,
          },
        },
      },
    }, registryPath);
    expect(rejected.code).toBe(1);
    expect(rejected.response).toMatchObject({
      schemaVersion: 1,
      ok: false,
      operation: "execute_command",
      error: {
        code: "COMMAND_REJECTED",
        details: {
          applied: false,
          reason: "context_preflight_required",
          chapterId: chapter.chapterId,
        },
      },
    });
    expect((await listCommandLedger(shell.paths.root)).some((entry) => entry.idempotencyKey === idempotencyKey))
      .toBe(false);
    await expect(repository.readChapter(chapter.chapterId)).resolves.toMatchObject({
      status: "healthy",
      content: "青铜树下的 CLI 原始正文",
      chapter: { revision: 1 },
    });
  });

  it("额外字段、超预算和坏 operation 在业务读取前被合同拒绝", async () => {
    expect(() => parseNovelAgentJsonRequest({
      schemaVersion: 1,
      operation: "capabilities",
      unexpected: true,
    })).toThrow(/不符合合同/u);
    await expect(executeNovelAgentJsonRequest({
      schemaVersion: 1,
      operation: "build_context_pack",
      projectRoot: "/tmp/不会读取",
      input: { maxCharacters: 200_001 },
    })).rejects.toThrow(/不符合合同/u);

    const bad = await runCli({ schemaVersion: 1, operation: "write_everything" });
    expect(bad.code).toBe(1);
    expect(bad.response).toMatchObject({
      schemaVersion: 1,
      ok: false,
      operation: "write_everything",
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("doctor 与 consistency probe 在 JSON CLI 和 Core 返回同一语义", async () => {
    const { shell, registryPath, chapter } = await fixture();
    const doctorInput = { targetChapterId: chapter.chapterId, workflowMode: "rehearsal" as const };
    const directDoctor = await doctorNovelAgent(shell.paths.root, doctorInput);
    const cliDoctor = await runCli({
      schemaVersion: 1,
      operation: "doctor",
      projectRoot: shell.paths.root,
      input: doctorInput,
    }, registryPath);
    expect(cliDoctor).toMatchObject({ code: 0, response: { ok: true, operation: "doctor" } });
    expect(cliDoctor.response.data).toEqual(directDoctor);
    expect(directDoctor.blockers).toEqual([]);

    const probeInput = { targetChapterId: chapter.chapterId, workflowMode: "rehearsal" as const };
    const directProbe = await probeNovelChapterConsistency(shell.paths.root, probeInput);
    const cliProbe = await runCli({
      schemaVersion: 1,
      operation: "probe_chapter_consistency",
      projectRoot: shell.paths.root,
      input: probeInput,
    }, registryPath);
    expect(cliProbe).toMatchObject({ code: 0, response: { ok: true, operation: "probe_chapter_consistency" } });
    expect(cliProbe.response.data).toEqual(directProbe);
    expect(directProbe.status).toBe("pass");
  });
});
