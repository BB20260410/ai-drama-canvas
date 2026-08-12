import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  listCommandLedger,
  type IdempotentCommandInput,
} from "../src/core/command-bus.js";
import { createManagedProject, type WorkspaceMode } from "../src/core/managed-project.js";
import {
  NOVEL_COMMAND_NAMES,
  parseNovelCommandRequestForCore,
  type NovelCommandRequest,
} from "../src/core/novel-command-runtime.js";
import { NovelRepository } from "../src/core/novel-manuscript.js";
import { runWithOperationContext } from "../src/core/operation-context.js";
import { findEventsByIdempotencyKey } from "../src/core/sidecar.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.AI_CANVAS_WRITE_LEASE_MODE;
  delete process.env.AI_CANVAS_TEST_NOVEL_MUTATION_INTERRUPT;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryParent(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "novel-command-bus-")));
  roots.push(root);
  return root;
}

async function managedFixture(workspaceMode: WorkspaceMode): Promise<Awaited<ReturnType<typeof createManagedProject>>> {
  const parentRoot = await temporaryParent();
  return createManagedProject({ parentRoot, name: `${workspaceMode} command fixture`, workspaceMode });
}

function envelope(label: string, request: NovelCommandRequest): IdempotentCommandInput {
  return {
    requestId: `novel-request-${label}`,
    idempotencyKey: `novel-idempotency-${label}`,
    request,
  };
}

async function treeSnapshot(root: string): Promise<string[]> {
  const snapshot: string[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot.push(`directory:${relativePath}`);
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        snapshot.push(`file:${relativePath}:${createHash("sha256").update(await readFile(absolutePath)).digest("hex")}`);
      } else {
        snapshot.push(`other:${relativePath}`);
      }
    }
  }
  await visit(root, "");
  return snapshot;
}

const fixtureChapterId = "11111111-1111-4111-8111-111111111111";
const fixtureVolumeId = "22222222-2222-4222-8222-222222222222";

describe("P2 novel command runtime", () => {
  it("全部 allowlist 均严格拒绝载荷或 request 额外字段", () => {
    const valid: NovelCommandRequest[] = [
      { command: "novel_initialize_manuscript", payload: { sourceMode: "managed_markdown" } },
      { command: "novel_create_volume", payload: { title: "第二卷", expectedManifestRevision: 1 } },
      { command: "novel_create_chapter", payload: { volumeId: fixtureVolumeId, title: "第一章", expectedManifestRevision: 1 } },
      { command: "novel_save_chapter", payload: { chapterId: fixtureChapterId, content: "正文", expectedRevision: 1, expectedSha256: "a".repeat(64) } },
      { command: "novel_rename_chapter", payload: { chapterId: fixtureChapterId, title: "新标题", expectedRevision: 1, expectedManifestRevision: 1 } },
      { command: "novel_move_chapter", payload: { chapterId: fixtureChapterId, volumeId: fixtureVolumeId, expectedRevision: 1, expectedSha256: "b".repeat(64), expectedManifestRevision: 1 } },
      { command: "novel_reorder_chapters", payload: { orderedChapterIds: [fixtureChapterId], expectedManifestRevision: 1 } },
      { command: "novel_rebuild_search_index", payload: {} },
      { command: "novel_recover_manuscript", payload: {} },
      { command: "novel_recover_writing_state", payload: {} },
      {
        command: "novel_seed_writing_state",
        payload: {
          baselineStatus: "provisional",
          sourceTreeAggregateSha256: "c".repeat(64),
          currentThroughChapterId: fixtureChapterId,
          sourceDocuments: [],
          entities: [],
          hardCanon: [],
          characterStates: [],
          knowledge: [],
          relationships: [],
          timeline: [],
          foreshadowing: [],
          chapterBriefs: [],
          completedChapterIds: [fixtureChapterId],
        },
      },
      {
        command: "novel_stage_chapter_state_candidate",
        payload: {
          chapterId: fixtureChapterId,
          expectedChapterRevision: 1,
          expectedChapterSha256: "d".repeat(64),
          expectedWritingStateRevision: 1,
          expectedWritingStateFingerprint: "e".repeat(64),
          summary: "章末状态候选",
          delta: { characterStates: [], knowledge: [], relationships: [], timeline: [], foreshadowing: [] },
          evidenceSpans: [],
          changeEvidence: [],
          auditScope: {
            checkedCharacterIds: [],
            checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"],
          },
        },
      },
      {
        command: "novel_review_chapter_state_candidate",
        payload: {
          candidateId: `novel-state-candidate-${"a".repeat(24)}`,
          expectedCandidateFingerprint: "f".repeat(64),
          expectedWritingStateRevision: 1,
          expectedWritingStateFingerprint: "a".repeat(64),
          decision: "accepted",
          reviewer: "human-owner",
        },
      },
      {
        command: "novel_stage_story_bible_candidate",
        payload: {
          expectedWritingStateRevision: 1,
          expectedWritingStateFingerprint: "b".repeat(64),
          summary: "Story Bible 候选",
          changes: [{
            changeId: "change-issue-1",
            kind: "continuity_issue",
            reason: "记录待复核问题",
            value: {
              issueId: "issue-1",
              status: "open",
              severity: "P1",
              summary: "人物状态待核对",
              chapterIds: [fixtureChapterId],
              entityIds: [],
              evidence: "测试证据",
              sourceIds: [],
            },
          }],
        },
      },
      {
        command: "novel_review_story_bible_candidate",
        payload: {
          candidateId: `novel-bible-candidate-${"b".repeat(24)}`,
          expectedCandidateFingerprint: "c".repeat(64),
          expectedWritingStateRevision: 1,
          expectedWritingStateFingerprint: "d".repeat(64),
          decision: "accepted",
          reviewer: "human-owner",
        },
      },
      {
        command: "novel_invalidate_writing_state_from",
        payload: {
          targetChapterId: fixtureChapterId,
          expectedWritingStateRevision: 1,
          expectedWritingStateFingerprint: "e".repeat(64),
          expectedPlanFingerprint: "f".repeat(64),
        },
      },
      {
        command: "novel_attach_review_ticket",
        payload: {
          chapterId: fixtureChapterId,
          expectedChapterRevision: 1,
          expectedChapterSha256: "b".repeat(64),
          startOffset: 0,
          endOffset: 2,
          evidenceExcerpt: "正文",
          severity: "P1",
          impact: "影响说明",
          minimalFix: "最小修法",
          confidence: 0.9,
          reviewer: "local-reviewer",
        },
      },
      {
        command: "novel_import_writing_source_snapshot",
        payload: {
          preflightId: `novel-preflight-${"a".repeat(24)}`,
          preflightFingerprint: "b".repeat(64),
          sourceTreeAggregateSha256: "c".repeat(64),
          preflightAuthorization: `novel-preflight-auth-${"A".repeat(43)}`,
        },
      },
      {
        command: "novel_import_external_snapshot",
        payload: {
          projectsRoot: "/tmp/novel-projects",
          projectName: "外部小说",
          preflightId: `novel-preflight-${"a".repeat(24)}`,
          preflightFingerprint: "b".repeat(64),
          sourceTreeAggregateSha256: "c".repeat(64),
          duplicateResolution: "include_all",
          convertToManagedMarkdown: true,
          preflightAuthorization: `novel-preflight-auth-${"A".repeat(43)}`,
        },
      },
    ];

    expect(valid.map((request) => request.command)).toEqual(NOVEL_COMMAND_NAMES);
    for (const request of valid) {
      expect(parseNovelCommandRequestForCore(request)).toEqual(request);
      expect(() => parseNovelCommandRequestForCore({
        ...request,
        payload: { ...request.payload, unexpected: true },
      })).toThrow(/严格合同/u);
      expect(() => parseNovelCommandRequestForCore({ ...request, unexpected: true })).toThrow(/严格合同/u);
    }
    expect(parseNovelCommandRequestForCore({ command: "import_story_text", payload: {} })).toBeNull();
  });

  it("畸形 novel 命令在 managed 探测、锁和命令账本 I/O 前失败，项目树零写", async () => {
    const shell = await managedFixture("novel");
    const before = await treeSnapshot(shell.paths.root);
    const malformed = {
      requestId: "novel-request-malformed",
      idempotencyKey: "novel-idempotency-malformed",
      request: {
        command: "novel_initialize_manuscript",
        payload: { sourceMode: "managed_markdown", unexpected: true },
      },
    } as unknown as IdempotentCommandInput;

    await expect(executeIdempotentCommand(shell.paths.root, malformed)).rejects.toThrow(/严格合同/u);
    expect(await treeSnapshot(shell.paths.root)).toEqual(before);
    expect((await readdir(shell.paths.sidecar)).filter((name) => name.startsWith("command-ledger.sqlite"))).toEqual([]);
    await expect(access(path.join(shell.paths.root, "manuscript"))).rejects.toThrow();
    await expect(access(path.join(shell.paths.sidecar, "novel"))).rejects.toThrow();
  });

  it("drama 和跨根 storageRoot 在登记账本前拒绝 novel 命令", async () => {
    const drama = await managedFixture("drama");
    const dramaBefore = await treeSnapshot(drama.paths.root);
    const initialize = envelope("drama-blocked", {
      command: "novel_initialize_manuscript",
      payload: { sourceMode: "managed_markdown" },
    });
    await expect(executeIdempotentCommand(drama.paths.root, initialize)).rejects.toThrow(/schema v2 novel\/hybrid/u);
    expect(await treeSnapshot(drama.paths.root)).toEqual(dramaBefore);

    const novel = await managedFixture("novel");
    const novelBefore = await treeSnapshot(novel.paths.root);
    await expect(executeIdempotentCommand(novel.paths.root, envelope("cross-root", {
      command: "novel_initialize_manuscript",
      payload: {},
    }), { storageRoot: path.dirname(novel.paths.root) })).rejects.toThrow(/storageRoot/u);
    expect(await treeSnapshot(novel.paths.root)).toEqual(novelBefore);
  });

  it("novel 初始化在无 Studio lease 时成功，同一幂等键只重放一条账本记录", async () => {
    process.env.AI_CANVAS_WRITE_LEASE_MODE = "require";
    const shell = await managedFixture("novel");
    const input = envelope("initialize-once", {
      command: "novel_initialize_manuscript",
      payload: { sourceMode: "managed_markdown" },
    });

    const first = await executeIdempotentCommand(shell.paths.root, input);
    expect(first).toMatchObject({
      status: "succeeded",
      replayed: false,
      command: "novel_initialize_manuscript",
      result: {
        workspace: { sourceMode: "managed_markdown", projectId: shell.project.id },
        chapters: { revision: 1, volumes: [{ title: "第一卷" }], chapters: [] },
      },
    });
    const replay = await executeIdempotentCommand(shell.paths.root, {
      ...input,
      requestId: "novel-request-initialize-replay",
    });
    expect(replay).toMatchObject({ status: "succeeded", replayed: true, requestHash: first.requestHash });

    const ledger = await listCommandLedger(shell.paths.root);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      idempotencyKey: input.idempotencyKey,
      command: "novel_initialize_manuscript",
      status: "succeeded",
    });
    await expect(new NovelRepository(shell.paths.root).snapshot()).resolves.toMatchObject({
      workspace: { sourceMode: "managed_markdown" },
      chapters: { revision: 1 },
    });
  });

  it("Agent 创建非空章或保存正文必须走 Writing OS，只有显式 human_ui 可兼容人工正文", async () => {
    const shell = await managedFixture("novel");
    await executeIdempotentCommand(shell.paths.root, envelope("actor-initialize", {
      command: "novel_initialize_manuscript",
      payload: { sourceMode: "managed_markdown" },
    }));
    const initialized = await new NovelRepository(shell.paths.root).snapshot();
    const createWithBody = envelope("actor-create", {
      command: "novel_create_chapter",
      payload: {
        volumeId: initialized.chapters!.volumes[0]!.volumeId,
        title: "Agent 写入门",
        content: "人工初稿",
        expectedManifestRevision: initialized.chapters!.revision,
      },
    });
    await expect(executeIdempotentCommand(shell.paths.root, createWithBody)).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: {
        applied: false,
        entityType: "novel_writing_state",
        reason: "context_preflight_required",
      },
    });
    expect((await listCommandLedger(shell.paths.root)).some((entry) => entry.idempotencyKey === createWithBody.idempotencyKey))
      .toBe(false);
    const created = await executeIdempotentCommand(shell.paths.root, createWithBody, { novelWriteActor: "human_ui" });
    const chapter = (created.result as {
      chapter: { chapterId: string; revision: number; sha256: string };
    }).chapter;
    const agentSave = envelope("actor-agent-save", {
      command: "novel_save_chapter",
      payload: {
        chapterId: chapter.chapterId,
        content: "不得绕过 preflight 的 Agent 正文",
        expectedRevision: chapter.revision,
        expectedSha256: chapter.sha256,
      },
    });

    await expect(executeIdempotentCommand(shell.paths.root, agentSave)).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: {
        applied: false,
        entityType: "novel_writing_state",
        reason: "context_preflight_required",
        chapterId: chapter.chapterId,
      },
    });
    expect((await listCommandLedger(shell.paths.root)).some((entry) => entry.idempotencyKey === agentSave.idempotencyKey))
      .toBe(false);

    const humanSaveInput = envelope("actor-human-save", {
      command: "novel_save_chapter",
      payload: {
        chapterId: chapter.chapterId,
        content: "桌面人工保存保持兼容",
        expectedRevision: chapter.revision,
        expectedSha256: chapter.sha256,
      },
    });
    const humanSave = await executeIdempotentCommand(shell.paths.root, humanSaveInput, { novelWriteActor: "human_ui" });
    expect(humanSave).toMatchObject({ status: "succeeded", result: { chapter: { revision: 2 } } });
    await expect(executeIdempotentCommand(shell.paths.root, humanSaveInput)).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { applied: false, reason: "context_preflight_required" },
    });
  });

  it("rehearsal 只能演练上下文，禁止写入权威章节且不得登记命令账本", async () => {
    const shell = await managedFixture("novel");
    await executeIdempotentCommand(shell.paths.root, envelope("rehearsal-initialize", {
      command: "novel_initialize_manuscript",
      payload: { sourceMode: "managed_markdown" },
    }));
    const repository = new NovelRepository(shell.paths.root);
    const initialized = await repository.snapshot();
    const created = await executeIdempotentCommand(shell.paths.root, envelope("rehearsal-create", {
      command: "novel_create_chapter",
      payload: {
        volumeId: initialized.chapters!.volumes[0]!.volumeId,
        title: "演练写入门",
        content: "权威正文原文",
        expectedManifestRevision: initialized.chapters!.revision,
      },
    }), { novelWriteActor: "human_ui" });
    const chapter = (created.result as {
      chapter: { chapterId: string; revision: number; sha256: string };
    }).chapter;
    const before = await repository.readChapter(chapter.chapterId);
    const rehearsalSave = envelope("rehearsal-save-forbidden", {
      command: "novel_save_chapter",
      payload: {
        chapterId: chapter.chapterId,
        content: "REHEARSAL-MUST-NOT-WRITE",
        expectedRevision: chapter.revision,
        expectedSha256: chapter.sha256,
        aiWriteContext: {
          preflightId: "novel-write-preflight-0123456789abcdef01234567",
          contextPackFingerprint: "a".repeat(64),
          workflowMode: "rehearsal",
        },
      },
    });

    await expect(executeIdempotentCommand(shell.paths.root, rehearsalSave)).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: {
        applied: false,
        entityType: "novel_writing_state",
        reason: "workflow_mode_forbidden",
        chapterId: chapter.chapterId,
      },
    });
    expect(await repository.readChapter(chapter.chapterId)).toEqual(before);
    expect((await listCommandLedger(shell.paths.root)).some((entry) => entry.idempotencyKey === rehearsalSave.idempotencyKey))
      .toBe(false);
  });

  it("旧 story 写命令在 novel 受管项目仍失败关闭且不登记账本", async () => {
    const shell = await managedFixture("novel");
    const before = await treeSnapshot(shell.paths.root);
    const legacy = {
      requestId: "novel-request-legacy-story",
      idempotencyKey: "novel-idempotency-legacy-story",
      request: { command: "import_story_text", payload: { title: "旧入口", content: "不得写入" } },
    } as IdempotentCommandInput;

    await expect(executeIdempotentCommand(shell.paths.root, legacy)).rejects.toThrow(/拒绝旧命令 import_story_text/u);
    expect(await treeSnapshot(shell.paths.root)).toEqual(before);
    expect((await readdir(shell.paths.sidecar)).filter((name) => name.startsWith("command-ledger.sqlite"))).toEqual([]);
  });

  it("真实 createChapter 成功后，过期 SHA 的 saveChapter 因 CAS 冲突且正文不变", async () => {
    const shell = await managedFixture("hybrid");
    await executeIdempotentCommand(shell.paths.root, envelope("cas-initialize", {
      command: "novel_initialize_manuscript",
      payload: { sourceMode: "managed_markdown" },
    }));
    const initialized = await new NovelRepository(shell.paths.root).snapshot();
    const volumeId = initialized.chapters!.volumes[0]!.volumeId;
    const created = await executeIdempotentCommand(shell.paths.root, envelope("cas-create", {
      command: "novel_create_chapter",
      payload: {
        volumeId,
        title: "第一章 真实 CAS",
        content: "第一版正文",
        expectedManifestRevision: 1,
      },
    }), { novelWriteActor: "human_ui" });
    const createdResult = created.result as {
      chapter: { chapterId: string; revision: number; sha256: string };
    };
    expect(createdResult.chapter).toMatchObject({ revision: 1 });
    const before = await new NovelRepository(shell.paths.root).readChapter(createdResult.chapter.chapterId);

    const staleInput = envelope("cas-stale-save", {
      command: "novel_save_chapter",
      payload: {
        chapterId: createdResult.chapter.chapterId,
        content: "不应覆盖的第二版",
        expectedRevision: createdResult.chapter.revision,
        expectedSha256: "0".repeat(64),
      },
    });
    await expect(executeIdempotentCommand(shell.paths.root, staleInput, { novelWriteActor: "human_ui" }))
      .rejects.toThrow(/revision\/SHA CAS 已过期/u);

    const after = await new NovelRepository(shell.paths.root).readChapter(createdResult.chapter.chapterId);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ status: "healthy", content: "第一版正文" });
    expect((await listCommandLedger(shell.paths.root)).find((entry) => entry.idempotencyKey === staleInput.idempotencyKey))
      .toMatchObject({
        status: "failed",
        result: { applied: false, entityType: "novel_manuscript", reason: "content_conflict" },
      });
    expect(await findEventsByIdempotencyKey(shell.paths.root, staleInput.idempotencyKey, 20))
      .toContainEqual(expect.objectContaining({ type: "command.failed", data: expect.objectContaining({ committed: false }) }));
  });

  it("stale revision、外部编辑与 not-found 都只落 failed/committed=false", async () => {
    const shell = await managedFixture("novel");
    await executeIdempotentCommand(shell.paths.root, envelope("rejection-initialize", {
      command: "novel_initialize_manuscript",
      payload: { sourceMode: "managed_markdown" },
    }));
    const repository = new NovelRepository(shell.paths.root);
    const initialized = await repository.snapshot();
    const created = await executeIdempotentCommand(shell.paths.root, envelope("rejection-create", {
      command: "novel_create_chapter",
      payload: {
        volumeId: initialized.chapters!.volumes[0]!.volumeId,
        title: "拒绝语义验证章",
        content: "正典正文",
        expectedManifestRevision: initialized.chapters!.revision,
      },
    }), { novelWriteActor: "human_ui" });
    const chapter = (created.result as { chapter: { chapterId: string; revision: number; sha256: string; relativePath: string } }).chapter;

    const cases: Array<{
      label: string;
      expectedReason: string;
      prepare?: () => Promise<void>;
      request: NovelCommandRequest;
    }> = [
      {
        label: "stale-revision",
        expectedReason: "revision_conflict",
        request: {
          command: "novel_save_chapter",
          payload: {
            chapterId: chapter.chapterId,
            content: "不得写入 stale revision",
            expectedRevision: chapter.revision + 1,
            expectedSha256: chapter.sha256,
          },
        },
      },
      {
        label: "external-edit",
        expectedReason: "external_change",
        prepare: () => writeFile(path.join(shell.paths.root, ...chapter.relativePath.split("/")), "外部编辑器正文", "utf8"),
        request: {
          command: "novel_save_chapter",
          payload: {
            chapterId: chapter.chapterId,
            content: "不得覆盖外部编辑",
            expectedRevision: chapter.revision,
            expectedSha256: chapter.sha256,
          },
        },
      },
      {
        label: "not-found",
        expectedReason: "not_found",
        request: {
          command: "novel_save_chapter",
          payload: {
            chapterId: randomUUID(),
            content: "不存在",
            expectedRevision: 1,
            expectedSha256: "f".repeat(64),
          },
        },
      },
    ];

    for (const item of cases) {
      await item.prepare?.();
      const input = envelope(`rejection-${item.label}`, item.request);
      await expect(executeIdempotentCommand(shell.paths.root, input, { novelWriteActor: "human_ui" })).rejects.toMatchObject({
        name: "RejectedCommandFailure",
        result: expect.objectContaining({ applied: false, reason: item.expectedReason }),
      });
      expect((await listCommandLedger(shell.paths.root)).find((entry) => entry.idempotencyKey === input.idempotencyKey))
        .toMatchObject({ status: "failed", result: { applied: false, reason: item.expectedReason } });
      expect(await findEventsByIdempotencyKey(shell.paths.root, input.idempotencyKey, 20))
        .toContainEqual(expect.objectContaining({ type: "command.failed", data: expect.objectContaining({ committed: false }) }));
    }
  });

  it("当前命令先恢复遗留 intent 产生写入后，后续 stale 拒绝不得记为 committed=false", async () => {
    const shell = await managedFixture("novel");
    await executeIdempotentCommand(shell.paths.root, envelope("recover-write-initialize", {
      command: "novel_initialize_manuscript",
      payload: { sourceMode: "managed_markdown" },
    }));
    const repository = new NovelRepository(shell.paths.root);
    const initialized = await repository.snapshot();
    const created = await executeIdempotentCommand(shell.paths.root, envelope("recover-write-create", {
      command: "novel_create_chapter",
      payload: {
        volumeId: initialized.chapters!.volumes[0]!.volumeId,
        title: "恢复写入语义",
        content: "before-recovery",
        expectedManifestRevision: initialized.chapters!.revision,
      },
    }), { novelWriteActor: "human_ui" });
    const chapter = (created.result as {
      chapter: { chapterId: string; revision: number; sha256: string };
    }).chapter;
    const interruptedRequestHash = createHash("sha256").update("prior-incomplete-save").digest("hex");
    process.env.AI_CANVAS_TEST_NOVEL_MUTATION_INTERRUPT = "after-file-mutation";
    await expect(runWithOperationContext({
      requestId: "prior-incomplete-request",
      idempotencyKey: "prior-incomplete-idempotency",
      requestHash: interruptedRequestHash,
      command: "novel_save_chapter",
    }, () => repository.saveChapter({
      chapterId: chapter.chapterId,
      content: "recovered-canonical-content",
      expectedRevision: chapter.revision,
      expectedSha256: chapter.sha256,
    }))).rejects.toThrow(/test-only novel mutation interruption/u);
    delete process.env.AI_CANVAS_TEST_NOVEL_MUTATION_INTERRUPT;

    const currentInput = envelope("recover-write-then-stale", {
      command: "novel_save_chapter",
      payload: {
        chapterId: chapter.chapterId,
        content: "current-request-must-not-apply",
        expectedRevision: chapter.revision,
        expectedSha256: chapter.sha256,
      },
    });
    await expect(executeIdempotentCommand(shell.paths.root, currentInput, { novelWriteActor: "human_ui" }))
      .rejects.toThrow(/已恢复 1 个遗留正文操作/u);

    await expect(repository.readChapter(chapter.chapterId))
      .resolves.toMatchObject({ status: "healthy", content: "recovered-canonical-content" });
    const ledger = (await listCommandLedger(shell.paths.root))
      .find((entry) => entry.idempotencyKey === currentInput.idempotencyKey);
    expect(ledger).toMatchObject({ status: "unknown" });
    expect(ledger?.result).toBeUndefined();
    const events = await findEventsByIdempotencyKey(shell.paths.root, currentInput.idempotencyKey, 20);
    expect(events).toContainEqual(expect.objectContaining({ type: "command.outcome-unknown" }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "command.failed",
      data: expect.objectContaining({ committed: false }),
    }));
  });
});
