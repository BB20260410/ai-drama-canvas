import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeIdempotentCommand, reconcileCommand, type IdempotentCommandInput } from "../src/core/command-bus.js";
import { upsertNovelFact } from "../src/core/adaptation.js";
import { createManagedProject } from "../src/core/managed-project.js";
import { getNovelMemoryAuthorityProjection } from "../src/core/novel-memory-authority.js";
import {
  buildNovelContextPack,
  doctorNovelAgent,
  getNovelStateRebuildStatus,
  getNovelWritingState,
  listNovelManuscriptChapters,
  planNovelStateRebuild,
  preflightNovelChapterWrite,
  prepareNovelChapterWrite,
  probeNovelChapterConsistency,
  readNovelManuscriptRange,
  searchNovelManuscript,
} from "../src/core/novel-agent-service.js";
import { NovelRepository } from "../src/core/novel-manuscript.js";

const roots: string[] = [];
let sequence = 0;
const testAttribution = {
  actorId: "codex-test-writer",
  provider: "openai",
  model: "fixture-model",
  sessionId: "novel-writing-state-test",
  transport: "internal" as const,
};

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_WRITING_STATE_HISTORY_INTERRUPT;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function envelope(command: string, payload: Record<string, unknown>): IdempotentCommandInput {
  sequence += 1;
  return {
    requestId: `novel-writing-request-${sequence}-${randomUUID()}`,
    idempotencyKey: `novel-writing-key-${sequence}-${randomUUID()}`,
    request: { command, payload },
  } as IdempotentCommandInput;
}

async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "novel-writing-state-")));
  roots.push(parent);
  const shell = await createManagedProject({ parentRoot: parent, name: "写章闭环夹具", workspaceMode: "novel" });
  const initialized = await executeIdempotentCommand(shell.paths.root, envelope(
    "novel_initialize_manuscript",
    { sourceMode: "managed_markdown" },
  ));
  let manifest = (initialized.result as {
    chapters: { revision: number; volumes: Array<{ volumeId: string }> };
  }).chapters;
  const volumeId = manifest.volumes[0]!.volumeId;
  const chapters: Array<{ chapterId: string; revision: number; sha256: string }> = [];
  for (const [title, content] of [["第010章", "上一章正典：担保链露一指。"], ["第011章", ""]] as const) {
    const created = await executeIdempotentCommand(shell.paths.root, envelope("novel_create_chapter", {
      volumeId,
      title,
      content,
      expectedManifestRevision: manifest.revision,
    }), { novelWriteActor: "human_ui" });
    const result = created.result as {
      chapter: { chapterId: string; revision: number; sha256: string };
      manifest: { revision: number; volumes: Array<{ volumeId: string }> };
    };
    chapters.push(result.chapter);
    manifest = result.manifest;
  }
  return { shell, repository: new NovelRepository(shell.paths.root), chapter10: chapters[0]!, chapter11: chapters[1]! };
}

function seedPayload(chapter10Id: string, chapter11Id: string) {
  return {
    baselineStatus: "locked",
    sourceTreeAggregateSha256: createHash("sha256").update("source-tree").digest("hex"),
    currentThroughChapterId: chapter10Id,
    sourceDocuments: [
      { sourceId: "p0", displayPath: "设定/正典锁_P0补丁.md", content: "过手只显回真实责任节点，不得转嫁给无辜者。" },
      { sourceId: "dynamic-010", displayPath: "追踪/角色状态.md", content: "第010章末：列证据方案，收指摸担保链。" },
    ],
    entities: [
      { entityId: "character-yihang", name: "易航", aliases: [], level: "L1", baseSummary: "冷、短、证据优先。", sourceIds: ["p0"] },
    ],
    hardCanon: [
      {
        ruleId: "canon-pass-through",
        text: "过手只显回真实责任节点，不得转嫁给无辜者。",
        priority: 100,
        canonStatus: "canon",
        visibility: "writer",
        sourceIds: ["p0"],
      },
    ],
    characterStates: [
      {
        stateId: "state-yihang",
        entityId: "character-yihang",
        throughChapterId: chapter10Id,
        fields: {
          body: "夜班透支，无明显重伤",
          emotion: "冷、短、压着抖",
          known: ["担保链短信存在"],
          unknown: ["担保链完整结构"],
          relationships: ["阿大：师友"],
          goals: ["收指摸担保链"],
          psychology: "证据不能只叠整齐",
          unresolved: ["是否回担保链"],
        },
        sourceIds: ["dynamic-010"],
      },
    ],
    knowledge: [
      {
        knowledgeId: "knowledge-chain",
        entityId: "character-yihang",
        fact: "担保链短信存在",
        status: "known",
        rawValue: "知",
        effectiveFromChapterId: chapter10Id,
        sourceIds: ["dynamic-010"],
      },
      {
        knowledgeId: "knowledge-future-chain-owner",
        entityId: "character-yihang",
        fact: "担保链最终后台身份",
        status: "planned_later",
        rawValue: "卷8",
        sourceIds: ["p0"],
      },
    ],
    relationships: [],
    timeline: [
      { timelineId: "timeline-d4", storyTime: "D4", summary: "到期字段-4", endChapterId: chapter10Id, sourceIds: ["dynamic-010"] },
    ],
    foreshadowing: [
      {
        foreshadowingId: "foreshadow-chain",
        summary: "担保链露一指",
        status: "progression",
        maintenanceChapterIds: [chapter10Id],
        sourceIds: ["dynamic-010"],
      },
    ],
    chapterBriefs: [
      {
        chapterId: chapter11Id,
        summary: "列证据方案，决定先打账。",
        mustDo: ["收指摸担保链"],
        mustNotDo: ["空手完成过手闭环"],
        requiredCharacterIds: ["character-yihang"],
        sourceIds: ["dynamic-010"],
      },
    ],
    characterProfiles: [{
      entityId: "character-yihang",
      valuePriorities: ["证据优先", "不伤无辜"],
      coreDesire: "把责任链钉回真实责任人",
      coreFear: "证据再次被权势抹掉",
      secret: "他会因旧案失控，但绝不主动承认",
      boundaries: ["不把债转嫁给无辜者"],
      forbiddenPhrases: ["一切尽在掌握"],
      vocabulary: ["证据", "责任节点", "先对账"],
      sentencePatterns: ["短句；先结论，后证据"],
      relationshipVoices: [],
      sampleLines: ["先对账。账不平，谁都别走。"],
      sourceIds: ["p0"],
    }],
    characterAppearances: [{
      entityId: "character-yihang",
      summary: "二十七岁左右的清瘦青年，右眉尾有一道浅疤。",
      locks: [
        {
          lockId: "appearance-yihang-brow-scar",
          category: "distinctive_mark",
          canonicalDescription: "右眉尾有一道浅疤",
          allowedVariants: ["右眉尾淡疤"],
          contradictionPhrases: ["眉尾光洁无疤"],
          mutability: "immutable",
          enforcement: "block",
        },
        {
          lockId: "appearance-yihang-clothing",
          category: "default_clothing",
          canonicalDescription: "常穿深灰旧夹克，不佩戴首饰",
          allowedVariants: ["深灰夹克"],
          contradictionPhrases: ["一身金饰"],
          mutability: "story_event_required",
          enforcement: "review",
        },
      ],
      sourceIds: ["p0"],
    }],
    completedChapterIds: [chapter10Id],
  };
}

async function createNoChangeReviewInput(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  label: string,
) {
  const { shell, chapter11 } = fixtureValue;
  const content = `${label}故障恢复正文。`;
  const saved = await executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
    chapterId: chapter11.chapterId,
    content,
    expectedRevision: chapter11.revision,
    expectedSha256: chapter11.sha256,
  }), { novelWriteActor: "human_ui" });
  const savedChapter = (saved.result as { chapter: { revision: number; sha256: string } }).chapter;
  const before = await getNovelWritingState(shell.paths.root, {
    targetChapterId: chapter11.chapterId,
    cutoff: "through",
  });
  const evidenceExcerpt = content.slice(0, Math.min(4, content.length));
  const staged = await executeIdempotentCommand(shell.paths.root, envelope("novel_stage_chapter_state_candidate", {
    chapterId: chapter11.chapterId,
    expectedChapterRevision: savedChapter.revision,
    expectedChapterSha256: savedChapter.sha256,
    expectedWritingStateRevision: before.stateIdentity.revision,
    expectedWritingStateFingerprint: before.stateIdentity.fingerprint,
    summary: `${label} 完整审计后无状态变化`,
    delta: { characterStates: [], knowledge: [], relationships: [], timeline: [], foreshadowing: [] },
    evidenceSpans: [{ evidenceId: `evidence-${label}`, startOffset: 0, endOffset: evidenceExcerpt.length, evidenceExcerpt }],
    changeEvidence: [],
    noStateChange: {
      reason: "逐项核对五类状态后确认无变化",
      evidenceSpanIds: [`evidence-${label}`],
      checkedCharacterIds: ["character-yihang"],
    },
    auditScope: {
      checkedCharacterIds: ["character-yihang"],
      checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"],
    },
  }));
  const candidate = (staged.result as { candidate: { candidateId: string; fingerprint: string } }).candidate;
  return {
    before,
    reviewInput: envelope("novel_review_chapter_state_candidate", {
      candidateId: candidate.candidateId,
      expectedCandidateFingerprint: candidate.fingerprint,
      expectedWritingStateRevision: before.stateIdentity.revision,
      expectedWritingStateFingerprint: before.stateIdentity.fingerprint,
      decision: "accepted",
      reviewer: "human-owner",
    }),
  };
}

describe("Novel writing state vertical slice", () => {
  it("以单一CAS状态文件初始化时态正典，并保留来源对象与provisional门", async () => {
    const { shell, repository, chapter10, chapter11 } = await fixture();
    const seed = seedPayload(chapter10.chapterId, chapter11.chapterId);
    seed.baselineStatus = "provisional";
    seed.hardCanon.push({
      ruleId: "canon-author-secret",
      text: "作者秘密：担保链最终后台身份。",
      priority: 200,
      canonStatus: "canon",
      visibility: "author_only",
      sourceIds: ["p0"],
    });
    const seeded = await executeIdempotentCommand(shell.paths.root, envelope(
      "novel_seed_writing_state",
      seed,
    ), { novelWriteActor: "human_ui" });
    expect(seeded).toMatchObject({
      status: "succeeded",
      result: {
        state: {
          revision: 1,
          baselineStatus: "provisional",
          currentThroughChapterId: chapter10.chapterId,
          chapterCompletions: [{ chapterId: chapter10.chapterId }],
        },
      },
    });
    const projected = await getNovelWritingState(shell.paths.root, {
      targetChapterId: chapter11.chapterId,
      cutoff: "before",
    });
    expect(projected).toMatchObject({
      stateIdentity: { baselineStatus: "provisional", revision: 1 },
      temporal: {
        cutoffChapterId: chapter10.chapterId,
        characterStates: [{ entityId: "character-yihang", throughChapterId: chapter10.chapterId }],
      },
      completion: { readyForTargetChapter: true },
    });
    expect(projected).not.toHaveProperty("state");
    expect(projected.temporal.hardCanon).toEqual([
      expect.objectContaining({ ruleId: "canon-pass-through", visibility: "writer" }),
    ]);
    expect(JSON.stringify(projected)).not.toContain("作者秘密");
    await upsertNovelFact(shell.paths.root, {
      kind: "character",
      epistemicStatus: "confirmed",
      statement: "legacy 双写事实，不得进入正式上下文",
      sourceSpans: [{
        sourceId: "legacy-adaptation",
        chapterId: chapter10.chapterId,
        chapterRevision: chapter10.revision,
        chapterSha256: chapter10.sha256,
        startOffset: 0,
        endOffset: 4,
        text: "上一章正",
      }],
      tags: ["legacy"],
    });
    const memory = await getNovelMemoryAuthorityProjection(shell.paths.root, await repository.snapshot());
    expect(memory).toMatchObject({
      authority: "writing_os_story_bible",
      writableVia: "novel_stage_story_bible_candidate_then_owner_review",
      legacyAdaptation: { status: "read_only_excluded_from_writing_context", factCount: 1 },
      writingState: { revision: 1, baselineStatus: "provisional" },
    });
    expect(memory.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "hard_canon:canon-pass-through", kind: "hard_canon" }),
      expect.objectContaining({ id: "character_state:character-yihang", kind: "character_state" }),
    ]));
    expect(JSON.stringify(memory)).not.toContain("legacy 双写事实");
    expect(JSON.stringify(memory)).not.toContain("作者秘密");
    const persisted = JSON.parse(await readFile(
      path.join(shell.paths.root, "story-bible", "writing-state.json"),
      "utf8",
    )) as { fingerprint: string; sources: Array<{ objectRelativePath: string }> };
    expect(persisted.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(persisted.sources).toHaveLength(2);
    expect(persisted.sources.every((source) => source.objectRelativePath.startsWith(".aicanvas/novel/writing-source-objects/sha256/")))
      .toBe(true);
  });

  it("正式模式要求 locked 与完整 required cast；provisional 只能显式 rehearsal", async () => {
    const { shell, chapter10, chapter11 } = await fixture();
    const seed = seedPayload(chapter10.chapterId, chapter11.chapterId);
    seed.baselineStatus = "provisional";
    await executeIdempotentCommand(shell.paths.root, envelope("novel_seed_writing_state", seed), {
      novelWriteActor: "human_owner",
    });

    const formalPack = await buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      workflowMode: "formal",
      maxCharacters: 1024,
    });
    expect(formalPack.selection).toMatchObject({
      workflowMode: "formal",
      characterIds: ["character-yihang"],
    });
    const formalPreflight = await preflightNovelChapterWrite(shell.paths.root, {
      targetChapterId: chapter11.chapterId,
      contextPackFingerprint: formalPack.fingerprint,
      workflowMode: "formal",
      maxCharacters: 1024,
    });
    expect(formalPreflight).toMatchObject({
      ready: false,
      workflowMode: "formal",
      blockers: [expect.objectContaining({ code: "baseline_not_locked" })],
    });

    const rehearsalPack = await buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      workflowMode: "rehearsal",
      maxCharacters: 1024,
    });
    expect(rehearsalPack.fingerprint).not.toBe(formalPack.fingerprint);
    const rehearsalPreflight = await preflightNovelChapterWrite(shell.paths.root, {
      targetChapterId: chapter11.chapterId,
      contextPackFingerprint: rehearsalPack.fingerprint,
      workflowMode: "rehearsal",
      maxCharacters: 1024,
    });
    expect(rehearsalPreflight).toMatchObject({ ready: true, workflowMode: "rehearsal" });

    await expect(buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      workflowMode: "rehearsal",
      characterIds: ["character-missing"],
      maxCharacters: 1024,
    })).rejects.toThrow(/未知.*角色|角色.*不存在/u);
  });

  it("正式 required cast 缺少结构化声口卡时失败关闭，rehearsal 仍可显式演练", async () => {
    const { shell, chapter10, chapter11 } = await fixture();
    const { characterProfiles: _profiles, ...seed } = seedPayload(chapter10.chapterId, chapter11.chapterId);
    await executeIdempotentCommand(shell.paths.root, envelope("novel_seed_writing_state", seed), {
      novelWriteActor: "human_owner",
    });

    await expect(buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      workflowMode: "formal",
      maxCharacters: 4096,
    })).rejects.toMatchObject({
      result: expect.objectContaining({
        reason: "character_profile_missing",
        nextTools: [expect.objectContaining({ tool: "execute_command" })],
      }),
    });

    const rehearsal = await buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      workflowMode: "rehearsal",
      maxCharacters: 4096,
    });
    expect(rehearsal.selection).toMatchObject({ workflowMode: "rehearsal" });
  });

  it("正式 required cast 缺少结构化外形 Authority 时失败关闭，rehearsal 不冒充正式就绪", async () => {
    const { shell, chapter10, chapter11 } = await fixture();
    const { characterAppearances: _appearances, ...seed } = seedPayload(chapter10.chapterId, chapter11.chapterId);
    await executeIdempotentCommand(shell.paths.root, envelope("novel_seed_writing_state", seed), {
      novelWriteActor: "human_owner",
    });

    await expect(buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      workflowMode: "formal",
      maxCharacters: 4096,
    })).rejects.toMatchObject({
      result: expect.objectContaining({
        reason: "character_appearance_missing",
        nextTools: [expect.objectContaining({ tool: "execute_command" })],
      }),
    });

    const rehearsal = await buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      workflowMode: "rehearsal",
      maxCharacters: 4096,
    });
    expect(rehearsal.selection).toMatchObject({ workflowMode: "rehearsal" });
  });

  it("写后一致性 probe 确定性区分 machine conflict 与人工复核候选", async () => {
    const { shell, chapter10, chapter11 } = await fixture();
    const body = "次日，易航眉尾光洁无疤，一身金饰。他说：‘一切尽在掌握。’屏幕写着担保链最终后台身份，真相揭晓。万能债转。";
    const saved = await executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
      chapterId: chapter11.chapterId,
      content: body,
      expectedRevision: chapter11.revision,
      expectedSha256: chapter11.sha256,
    }), { novelWriteActor: "human_ui" });
    const savedChapter = (saved.result as { chapter: typeof chapter11 }).chapter;
    const seed = seedPayload(chapter10.chapterId, chapter11.chapterId);
    seed.hardCanon.push({
      ruleId: "canon-banned-lexeme",
      text: "禁用词：万能债转",
      priority: 101,
      canonStatus: "canon",
      visibility: "writer",
      sourceIds: ["p0"],
    });
    await executeIdempotentCommand(shell.paths.root, envelope("novel_seed_writing_state", seed), {
      novelWriteActor: "human_owner",
    });

    const first = await probeNovelChapterConsistency(shell.paths.root, {
      targetChapterId: savedChapter.chapterId,
      workflowMode: "formal",
    });
    const second = await probeNovelChapterConsistency(shell.paths.root, {
      targetChapterId: savedChapter.chapterId,
      workflowMode: "formal",
    });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first.status).toBe("machine_conflict");
    expect(first.machineConflicts.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "state_commit_missing",
      "hard_canon_forbidden_lexeme",
      "voice_forbidden_phrase",
      "appearance_contradiction_phrase",
    ]));
    expect(first.reviewRequired.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "knowledge_boundary_candidate",
      "timeline_transition_without_update",
      "foreshadow_payoff_without_update",
      "appearance_contradiction_phrase",
    ]));
    expect(JSON.stringify(first)).not.toContain("作者秘密");
    expect(first.nextTools[0]).toMatchObject({
      tool: "execute_command",
      args: { request: { command: "novel_stage_chapter_state_candidate" } },
    });
    expect(first.limitations.join(" ")).toContain("不等于人物绝对一致");
  });

  it("任务时态 list/read/search 在服务端截止未来正文，owner 内部读取仍保留", async () => {
    const { shell, chapter10, chapter11 } = await fixture();
    const future = await executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
      chapterId: chapter11.chapterId,
      content: "未来秘密：第011章才揭晓后台身份。",
      expectedRevision: chapter11.revision,
      expectedSha256: chapter11.sha256,
    }), { novelWriteActor: "human_ui" });
    const futureChapter = (future.result as { chapter: { chapterId: string } }).chapter;
    await executeIdempotentCommand(shell.paths.root, envelope(
      "novel_seed_writing_state",
      seedPayload(chapter10.chapterId, chapter11.chapterId),
    ), { novelWriteActor: "human_owner" });
    const taskScope = { targetChapterId: chapter11.chapterId, cutoff: "before" as const };

    const listed = await listNovelManuscriptChapters(shell.paths.root, { taskScope });
    expect(listed.items.map((chapter) => chapter.chapterId)).toEqual([chapter10.chapterId]);
    expect(listed.taskBoundary?.effectiveCutoffChapterId).toBe(chapter10.chapterId);
    await expect(readNovelManuscriptRange(shell.paths.root, {
      chapterId: futureChapter.chapterId,
      taskScope,
    })).rejects.toThrow(/截止边界|未来正文/u);
    const searched = await searchNovelManuscript(shell.paths.root, {
      query: "未来秘密",
      taskScope,
    });
    expect(searched).toMatchObject({ scannedChapters: 1, hits: [] });
    expect(JSON.stringify(searched)).not.toContain("后台身份");

    const ownerRead = await readNovelManuscriptRange(shell.paths.root, {
      chapterId: futureChapter.chapterId,
    });
    expect(ownerRead).toMatchObject({ status: "healthy", content: "未来秘密：第011章才揭晓后台身份。" });
  });

  it("Agent 不能初始化或裁决写作状态，且空/未知引用候选在落盘前拒绝", async () => {
    const { shell, chapter10, chapter11 } = await fixture();
    const seed = seedPayload(chapter10.chapterId, chapter11.chapterId);
    await expect(executeIdempotentCommand(shell.paths.root, envelope(
      "novel_seed_writing_state",
      seed,
    ))).rejects.toMatchObject({
      result: expect.objectContaining({ reason: "actor_forbidden" }),
    });
    const seeded = await executeIdempotentCommand(shell.paths.root, envelope(
      "novel_seed_writing_state",
      seed,
    ), { novelWriteActor: "human_ui" });
    const state = (seeded.result as { state: { revision: number; fingerprint: string } }).state;

    await expect(executeIdempotentCommand(shell.paths.root, envelope("novel_stage_chapter_state_candidate", {
      chapterId: chapter11.chapterId,
      expectedChapterRevision: chapter11.revision,
      expectedChapterSha256: chapter11.sha256,
      expectedWritingStateRevision: state.revision,
      expectedWritingStateFingerprint: state.fingerprint,
      summary: "空状态候选",
      delta: { characterStates: [], knowledge: [], relationships: [], timeline: [], foreshadowing: [] },
      evidenceSpans: [],
      changeEvidence: [],
      auditScope: {
        checkedCharacterIds: ["character-yihang"],
        checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"],
      },
    }))).rejects.toMatchObject({
      result: expect.objectContaining({ reason: "state_delta_required" }),
    });

    await expect(executeIdempotentCommand(shell.paths.root, envelope("novel_stage_chapter_state_candidate", {
      chapterId: chapter10.chapterId,
      expectedChapterRevision: chapter10.revision,
      expectedChapterSha256: chapter10.sha256,
      expectedWritingStateRevision: state.revision,
      expectedWritingStateFingerprint: state.fingerprint,
      summary: "未知人物候选",
      delta: {
        characterStates: [{
          stateId: "state-missing",
          entityId: "character-missing",
          fields: {
            body: "未知",
            emotion: "未知",
            known: [],
            unknown: [],
            relationships: [],
            goals: [],
            psychology: "未知",
            unresolved: [],
          },
        }],
        knowledge: [], relationships: [], timeline: [], foreshadowing: [],
      },
      evidenceSpans: [{ evidenceId: "evidence-unknown", startOffset: 0, endOffset: 3, evidenceExcerpt: "上一章" }],
      changeEvidence: [{
        kind: "character_state",
        recordId: "state-missing",
        reason: "故意验证未知人物引用会被拒绝",
        evidenceSpanIds: ["evidence-unknown"],
      }],
      auditScope: {
        checkedCharacterIds: ["character-yihang"],
        checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"],
      },
    }))).rejects.toMatchObject({
      result: expect.objectContaining({ reason: "invalid_reference" }),
    });
  });

  it("显式 noStateChange 必须覆盖完整 cast、绑定正文证据并由 owner 裁决", async () => {
    const { shell, chapter10, chapter11 } = await fixture();
    const saved = await executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
      chapterId: chapter11.chapterId,
      content: "第011章人物状态与上一章完全一致。",
      expectedRevision: chapter11.revision,
      expectedSha256: chapter11.sha256,
    }), { novelWriteActor: "human_ui" });
    const savedChapter = (saved.result as { chapter: typeof chapter11 }).chapter;
    const seeded = await executeIdempotentCommand(shell.paths.root, envelope(
      "novel_seed_writing_state",
      seedPayload(chapter10.chapterId, chapter11.chapterId),
    ), { novelWriteActor: "human_owner" });
    const state = (seeded.result as { state: { revision: number; fingerprint: string } }).state;

    const staged = await executeIdempotentCommand(shell.paths.root, envelope("novel_stage_chapter_state_candidate", {
      chapterId: chapter11.chapterId,
      expectedChapterRevision: savedChapter.revision,
      expectedChapterSha256: savedChapter.sha256,
      expectedWritingStateRevision: state.revision,
      expectedWritingStateFingerprint: state.fingerprint,
      summary: "显式确认本章无人物状态变化",
      delta: { characterStates: [], knowledge: [], relationships: [], timeline: [], foreshadowing: [] },
      evidenceSpans: [{ evidenceId: "evidence-no-state", startOffset: 0, endOffset: 5, evidenceExcerpt: "第011章" }],
      changeEvidence: [],
      noStateChange: {
        reason: "正文明确说明人物状态与上一章一致",
        evidenceSpanIds: ["evidence-no-state"],
        checkedCharacterIds: ["character-yihang"],
      },
      auditScope: {
        checkedCharacterIds: ["character-yihang"],
        checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"],
      },
    }));
    const candidate = (staged.result as { candidate: { candidateId: string; fingerprint: string } }).candidate;
    await expect(executeIdempotentCommand(shell.paths.root, envelope("novel_review_chapter_state_candidate", {
      candidateId: candidate.candidateId,
      expectedCandidateFingerprint: candidate.fingerprint,
      expectedWritingStateRevision: state.revision,
      expectedWritingStateFingerprint: state.fingerprint,
      decision: "accepted",
      reviewer: "fake-owner",
    }))).rejects.toMatchObject({ result: expect.objectContaining({ reason: "actor_forbidden" }) });
    const accepted = await executeIdempotentCommand(shell.paths.root, envelope("novel_review_chapter_state_candidate", {
      candidateId: candidate.candidateId,
      expectedCandidateFingerprint: candidate.fingerprint,
      expectedWritingStateRevision: state.revision,
      expectedWritingStateFingerprint: state.fingerprint,
      decision: "accepted",
      reviewer: "human-owner",
    }), { novelWriteActor: "human_owner" });
    expect(accepted.result).toMatchObject({
      state: { currentThroughChapterId: chapter11.chapterId, revision: state.revision + 1 },
    });
  });

  it("候选 stage 后真实正文发生未纳管漂移时 owner 也不能接受旧证据", async () => {
    const { shell, repository, chapter10, chapter11 } = await fixture();
    const saved = await executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
      chapterId: chapter11.chapterId,
      content: "第011章人物状态保持不变。",
      expectedRevision: chapter11.revision,
      expectedSha256: chapter11.sha256,
    }), { novelWriteActor: "human_ui" });
    const savedChapter = (saved.result as { chapter: typeof chapter11 }).chapter;
    const seeded = await executeIdempotentCommand(shell.paths.root, envelope(
      "novel_seed_writing_state",
      seedPayload(chapter10.chapterId, chapter11.chapterId),
    ), { novelWriteActor: "human_owner" });
    const state = (seeded.result as { state: { revision: number; fingerprint: string } }).state;
    const staged = await executeIdempotentCommand(shell.paths.root, envelope("novel_stage_chapter_state_candidate", {
      chapterId: chapter11.chapterId,
      expectedChapterRevision: savedChapter.revision,
      expectedChapterSha256: savedChapter.sha256,
      expectedWritingStateRevision: state.revision,
      expectedWritingStateFingerprint: state.fingerprint,
      summary: "待复验的无变化声明",
      delta: { characterStates: [], knowledge: [], relationships: [], timeline: [], foreshadowing: [] },
      evidenceSpans: [{ evidenceId: "evidence-before-drift", startOffset: 0, endOffset: 5, evidenceExcerpt: "第011章" }],
      changeEvidence: [],
      noStateChange: {
        reason: "原正文声明状态不变",
        evidenceSpanIds: ["evidence-before-drift"],
        checkedCharacterIds: ["character-yihang"],
      },
      auditScope: {
        checkedCharacterIds: ["character-yihang"],
        checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"],
      },
    }));
    const candidate = (staged.result as { candidate: { candidateId: string; fingerprint: string } }).candidate;
    const snapshot = await repository.snapshot();
    const relativePath = snapshot.chapters?.chapters.find((entry) => entry.chapterId === chapter11.chapterId)?.relativePath;
    if (!relativePath) throw new Error("缺少测试章节 locator");
    await writeFile(path.join(shell.paths.root, relativePath), "外部未纳管漂移。", "utf8");
    await expect(executeIdempotentCommand(shell.paths.root, envelope("novel_review_chapter_state_candidate", {
      candidateId: candidate.candidateId,
      expectedCandidateFingerprint: candidate.fingerprint,
      expectedWritingStateRevision: state.revision,
      expectedWritingStateFingerprint: state.fingerprint,
      decision: "accepted",
      reviewer: "human-owner",
    }), { novelWriteActor: "human_owner" })).rejects.toMatchObject({
      result: expect.objectContaining({ reason: "content_conflict" }),
    });
  });

  it("Story Bible 由 Agent 提案、owner 原子裁决，并以 revision 进入后续 Context Pack", async () => {
    const { shell, chapter10, chapter11 } = await fixture();
    await executeIdempotentCommand(shell.paths.root, envelope(
      "novel_seed_writing_state",
      seedPayload(chapter10.chapterId, chapter11.chapterId),
    ), { novelWriteActor: "human_owner" });
    const before = await getNovelWritingState(shell.paths.root, { targetChapterId: chapter11.chapterId, cutoff: "before" });
    const oldPack = await buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      characterIds: ["character-yihang"],
      maxCharacters: 4096,
    });

    await expect(executeIdempotentCommand(shell.paths.root, envelope("novel_stage_story_bible_candidate", {
      expectedWritingStateRevision: before.stateIdentity.revision,
      expectedWritingStateFingerprint: before.stateIdentity.fingerprint,
      summary: "非法回溯改写已完成人物基础卡",
      changes: [{
        changeId: "change-retcon-yihang",
        kind: "entity",
        reason: "故意验证旧章回改门",
        supersedesRevision: 1,
        value: {
          entityId: "character-yihang",
          name: "易航",
          aliases: [],
          level: "L1",
          baseSummary: "回溯改写",
          effectiveFromChapterId: chapter10.chapterId,
          sourceIds: ["p0"],
        },
      }],
    }))).rejects.toMatchObject({
      result: expect.objectContaining({ reason: "retcon_requires_invalidation" }),
    });

    await expect(executeIdempotentCommand(shell.paths.root, envelope("novel_stage_story_bible_candidate", {
      expectedWritingStateRevision: before.stateIdentity.revision,
      expectedWritingStateFingerprint: before.stateIdentity.fingerprint,
      summary: "故意改写不可变眉尾浅疤",
      changes: [{
        changeId: "change-illegal-appearance-lock",
        kind: "character_appearance",
        reason: "验证 immutable 外形锁",
        supersedesRevision: 1,
        value: {
          entityId: "character-yihang",
          effectiveFromChapterId: chapter11.chapterId,
          summary: "错误地移除眉尾浅疤",
          locks: [{
            lockId: "appearance-yihang-brow-scar",
            category: "distinctive_mark",
            canonicalDescription: "眉尾无疤",
            allowedVariants: [],
            contradictionPhrases: ["右眉尾浅疤"],
            mutability: "immutable",
            enforcement: "block",
          }],
          sourceIds: ["p0"],
        },
      }],
    }))).rejects.toMatchObject({
      result: expect.objectContaining({ reason: "retcon_requires_invalidation" }),
    });

    const staged = await executeIdempotentCommand(shell.paths.root, envelope("novel_stage_story_bible_candidate", {
      expectedWritingStateRevision: before.stateIdentity.revision,
      expectedWritingStateFingerprint: before.stateIdentity.fingerprint,
      summary: "为第011章增加声口、角色、正典与连续性审计",
      changes: [
        {
          changeId: "change-add-ada",
          kind: "entity",
          reason: "为后续章节登记新角色",
          value: {
            entityId: "character-ada",
            name: "阿达",
            aliases: [],
            level: "L2",
            baseSummary: "账贩线联系人，谨慎而克制。",
            effectiveFromChapterId: chapter11.chapterId,
            sourceIds: ["p0"],
          },
        },
        {
          changeId: "change-yihang-profile",
          kind: "character_profile",
          reason: "把声口和行为底线结构化",
          supersedesRevision: 1,
          value: {
            entityId: "character-yihang",
            effectiveFromChapterId: chapter11.chapterId,
            valuePriorities: ["证据", "不伤无辜"],
            coreDesire: "摸清担保链并把责任推回真实节点",
            coreFear: "证据不足时误伤无辜",
            secret: "手抖仍未完全恢复",
            boundaries: ["不把债转嫁给无辜者"],
            forbiddenPhrases: ["相信我就行"],
            vocabulary: ["回执", "节点", "先打账"],
            sentencePatterns: ["短句；先证据，后判断"],
            relationshipVoices: [{ targetEntityId: "character-ada", guidance: "只问可核验的账，不交底" }],
            sampleLines: ["先打账。账对了，再谈人。"],
            sourceIds: ["p0"],
          },
        },
        {
          changeId: "change-yihang-appearance",
          kind: "character_appearance",
          reason: "锁定第011章起仍保留眉尾浅疤，并登记临时换装",
          supersedesRevision: 1,
          value: {
            entityId: "character-yihang",
            effectiveFromChapterId: chapter11.chapterId,
            summary: "清瘦青年，右眉尾浅疤不变；本章因潜入换穿黑色风衣。",
            locks: [
              {
                lockId: "appearance-yihang-brow-scar",
                category: "distinctive_mark",
                canonicalDescription: "右眉尾有一道浅疤",
                allowedVariants: ["右眉尾淡疤"],
                contradictionPhrases: ["眉尾光洁无疤"],
                mutability: "immutable",
                enforcement: "block",
              },
              {
                lockId: "appearance-yihang-clothing",
                category: "default_clothing",
                canonicalDescription: "第011章因潜入换穿黑色风衣",
                allowedVariants: ["黑色风衣"],
                contradictionPhrases: ["亮白礼服"],
                mutability: "story_event_required",
                enforcement: "review",
              },
            ],
            sourceIds: ["p0"],
          },
        },
        {
          changeId: "change-canon-evidence-first",
          kind: "hard_canon",
          reason: "锁定本卷行动原则",
          value: {
            ruleId: "canon-evidence-first",
            text: "易航必须先核验证据，再采取不可逆行动。",
            priority: 95,
            canonStatus: "canon",
            visibility: "writer",
            effectiveFromChapterId: chapter11.chapterId,
            sourceIds: ["p0"],
          },
        },
        {
          changeId: "change-brief-011",
          kind: "chapter_brief",
          reason: "补充正式声口检查任务",
          supersedesRevision: 1,
          value: {
            chapterId: chapter11.chapterId,
            summary: "列证据方案，决定先打账，并保持短句声口。",
            mustDo: ["收指摸担保链", "先证据后判断"],
            mustNotDo: ["空手完成过手闭环"],
            requiredCharacterIds: ["character-yihang"],
            sourceIds: ["dynamic-010"],
          },
        },
        {
          changeId: "change-issue-hand",
          kind: "continuity_issue",
          reason: "要求后续审稿持续核对手抖",
          value: {
            issueId: "issue-yihang-hand",
            status: "open",
            severity: "P1",
            summary: "易航手抖不能无证据突然消失",
            chapterIds: [chapter10.chapterId, chapter11.chapterId],
            entityIds: ["character-yihang"],
            evidence: "第010章状态记录为压着抖",
            sourceIds: ["dynamic-010"],
          },
        },
      ],
    }));
    const candidate = (staged.result as { candidate: { candidateId: string; fingerprint: string } }).candidate;
    await expect(executeIdempotentCommand(shell.paths.root, envelope("novel_review_story_bible_candidate", {
      candidateId: candidate.candidateId,
      expectedCandidateFingerprint: candidate.fingerprint,
      expectedWritingStateRevision: before.stateIdentity.revision,
      expectedWritingStateFingerprint: before.stateIdentity.fingerprint,
      decision: "accepted",
      reviewer: "fake-owner",
    }))).rejects.toMatchObject({ result: expect.objectContaining({ reason: "actor_forbidden" }) });
    const accepted = await executeIdempotentCommand(shell.paths.root, envelope("novel_review_story_bible_candidate", {
      candidateId: candidate.candidateId,
      expectedCandidateFingerprint: candidate.fingerprint,
      expectedWritingStateRevision: before.stateIdentity.revision,
      expectedWritingStateFingerprint: before.stateIdentity.fingerprint,
      decision: "accepted",
      reviewer: "human-owner",
    }), { novelWriteActor: "human_owner" });
    expect(accepted.result).toMatchObject({
      state: {
        revision: before.stateIdentity.revision + 1,
        currentThroughChapterId: chapter10.chapterId,
        characterProfiles: [
          expect.objectContaining({ entityId: "character-yihang", revision: 1 }),
          expect.objectContaining({ entityId: "character-yihang", revision: 2 }),
        ],
        characterAppearances: [
          expect.objectContaining({ entityId: "character-yihang", revision: 1 }),
          expect.objectContaining({ entityId: "character-yihang", revision: 2 }),
        ],
        continuityIssues: [expect.objectContaining({ issueId: "issue-yihang-hand", status: "open" })],
      },
    });
    const projection = await getNovelWritingState(shell.paths.root, { targetChapterId: chapter11.chapterId, cutoff: "before" });
    expect(projection.temporal.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: "character-ada" }),
    ]));
    expect(projection.temporal.chapterBrief).toMatchObject({ revision: 2, requiredCharacterIds: ["character-yihang"] });
    expect(projection.temporal.characterProfiles).toContainEqual(expect.objectContaining({ entityId: "character-yihang" }));
    expect(projection.temporal.characterAppearances).toContainEqual(expect.objectContaining({
      entityId: "character-yihang",
      revision: 2,
    }));
    expect(projection.temporal.hardCanon).toContainEqual(expect.objectContaining({ ruleId: "canon-evidence-first" }));
    const newPack = await buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      characterIds: ["character-yihang"],
      maxCharacters: 4096,
    });
    expect(newPack.fingerprint).not.toBe(oldPack.fingerprint);
    if (!("sections" in newPack)) throw new Error("预期 Context Pack 2.0");
    expect(newPack.sections.characterProfiles).toContainEqual(expect.objectContaining({ entityId: "character-yihang" }));
    expect(newPack.sections.characterAppearances).toContainEqual(expect.objectContaining({ entityId: "character-yihang", revision: 2 }));
  });

  it("改旧章后由 owner invalidate，并严格按队列重建到原 head 后恢复未来写作", async () => {
    const { shell, repository, chapter10, chapter11 } = await fixture();
    const snapshot = await repository.snapshot();
    if (!snapshot.chapters) throw new Error("缺少章节 manifest");
    const volumeId = snapshot.chapters.volumes[0]!.volumeId;
    let manifestRevision = snapshot.chapters.revision;
    const createdChapters: Array<{ chapterId: string; revision: number; sha256: string }> = [];
    for (const [title, content] of [["第012章", "第012章正文。"], ["第013章", "第013章正文。"]] as const) {
      const created = await executeIdempotentCommand(shell.paths.root, envelope("novel_create_chapter", {
        volumeId,
        title,
        content,
        expectedManifestRevision: manifestRevision,
      }), { novelWriteActor: "human_ui" });
      const result = created.result as {
        chapter: { chapterId: string; revision: number; sha256: string };
        manifest: { revision: number };
      };
      createdChapters.push(result.chapter);
      manifestRevision = result.manifest.revision;
    }
    const saved11 = await executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
      chapterId: chapter11.chapterId,
      content: "第011章旧版正文。",
      expectedRevision: chapter11.revision,
      expectedSha256: chapter11.sha256,
    }), { novelWriteActor: "human_ui" });
    let chapter11Current = (saved11.result as { chapter: typeof chapter11 }).chapter;
    const chapter12 = createdChapters[0]!;
    const chapter13 = createdChapters[1]!;
    const seed = seedPayload(chapter10.chapterId, chapter11.chapterId);
    seed.chapterBriefs.push(
      {
        chapterId: chapter12.chapterId,
        summary: "承接第011章状态。",
        mustDo: ["保持人物状态连续"],
        mustNotDo: ["偷看未来"],
        requiredCharacterIds: ["character-yihang"],
        sourceIds: ["dynamic-010"],
      },
      {
        chapterId: chapter13.chapterId,
        summary: "承接第012章状态。",
        mustDo: ["保持人物状态连续"],
        mustNotDo: ["偷看未来"],
        requiredCharacterIds: ["character-yihang"],
        sourceIds: ["dynamic-010"],
      },
    );
    await executeIdempotentCommand(shell.paths.root, envelope("novel_seed_writing_state", seed), {
      novelWriteActor: "human_owner",
    });

    const commitNoChange = async (chapter: { chapterId: string; revision: number; sha256: string }, label: string) => {
      const before = await getNovelWritingState(shell.paths.root, { targetChapterId: chapter.chapterId, cutoff: "through" });
      const staged = await executeIdempotentCommand(shell.paths.root, envelope("novel_stage_chapter_state_candidate", {
        chapterId: chapter.chapterId,
        expectedChapterRevision: chapter.revision,
        expectedChapterSha256: chapter.sha256,
        expectedWritingStateRevision: before.stateIdentity.revision,
        expectedWritingStateFingerprint: before.stateIdentity.fingerprint,
        summary: `${label} 完整状态审计后无变化`,
        delta: { characterStates: [], knowledge: [], relationships: [], timeline: [], foreshadowing: [] },
        evidenceSpans: [{ evidenceId: `evidence-${label}`, startOffset: 0, endOffset: 5, evidenceExcerpt: label }],
        changeEvidence: [],
        noStateChange: {
          reason: "逐一核对 required cast 与五类状态后确认无变化",
          evidenceSpanIds: [`evidence-${label}`],
          checkedCharacterIds: ["character-yihang"],
        },
        auditScope: {
          checkedCharacterIds: ["character-yihang"],
          checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"],
        },
      }));
      const candidate = (staged.result as { candidate: { candidateId: string; fingerprint: string } }).candidate;
      return executeIdempotentCommand(shell.paths.root, envelope("novel_review_chapter_state_candidate", {
        candidateId: candidate.candidateId,
        expectedCandidateFingerprint: candidate.fingerprint,
        expectedWritingStateRevision: before.stateIdentity.revision,
        expectedWritingStateFingerprint: before.stateIdentity.fingerprint,
        decision: "accepted",
        reviewer: "human-owner",
      }), { novelWriteActor: "human_owner" });
    };

    await commitNoChange(chapter11Current, "第011章");
    await commitNoChange(chapter12, "第012章");
    await commitNoChange(chapter13, "第013章");
    const atHead = await getNovelWritingState(shell.paths.root, { targetChapterId: chapter13.chapterId, cutoff: "through" });
    expect(atHead.stateIdentity).toMatchObject({ currentThroughChapterId: chapter13.chapterId, revision: 4 });
    const publicStateBeforeRebuild = JSON.parse(await readFile(
      path.join(shell.paths.root, "story-bible/writing-state.json"),
      "utf8",
    )) as { revision: number; fingerprint: string; currentThroughChapterId: string };
    expect(publicStateBeforeRebuild).toMatchObject({
      revision: 4,
      fingerprint: atHead.stateIdentity.fingerprint,
      currentThroughChapterId: chapter13.chapterId,
    });

    const revised11 = await executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
      chapterId: chapter11Current.chapterId,
      content: "第011章新版正文。",
      expectedRevision: chapter11Current.revision,
      expectedSha256: chapter11Current.sha256,
    }), { novelWriteActor: "human_ui" });
    chapter11Current = (revised11.result as { chapter: typeof chapter11 }).chapter;
    const plan = await planNovelStateRebuild(shell.paths.root, { targetChapterId: chapter11.chapterId });
    expect(plan).toMatchObject({
      allowed: true,
      baseChapterId: chapter10.chapterId,
      previousCurrentThroughChapterId: chapter13.chapterId,
      affectedChapters: [
        expect.objectContaining({ chapterId: chapter11.chapterId, chapterRevision: chapter11Current.revision }),
        expect.objectContaining({ chapterId: chapter12.chapterId }),
        expect.objectContaining({ chapterId: chapter13.chapterId }),
      ],
    });
    await expect(executeIdempotentCommand(shell.paths.root, envelope("novel_invalidate_writing_state_from", {
      targetChapterId: chapter11.chapterId,
      expectedWritingStateRevision: atHead.stateIdentity.revision,
      expectedWritingStateFingerprint: atHead.stateIdentity.fingerprint,
      expectedPlanFingerprint: plan.fingerprint,
    }))).rejects.toMatchObject({ result: expect.objectContaining({ reason: "actor_forbidden" }) });
    const invalidated = await executeIdempotentCommand(shell.paths.root, envelope("novel_invalidate_writing_state_from", {
      targetChapterId: chapter11.chapterId,
      expectedWritingStateRevision: atHead.stateIdentity.revision,
      expectedWritingStateFingerprint: atHead.stateIdentity.fingerprint,
      expectedPlanFingerprint: plan.fingerprint,
    }), { novelWriteActor: "human_owner" });
    const invalidatedResult = invalidated.result as {
      state: { revision: number; fingerprint: string; currentThroughChapterId: string; chapterCompletions: unknown[] };
      rebuild: { nextChapterId: string; pendingChapterIds: string[] };
      snapshotLocator: string;
    };
    expect(invalidatedResult).toMatchObject({
      state: { revision: 5, currentThroughChapterId: chapter10.chapterId, chapterCompletions: [expect.any(Object)] },
      rebuild: { nextChapterId: chapter11.chapterId, pendingChapterIds: [chapter11.chapterId, chapter12.chapterId, chapter13.chapterId] },
    });
    expect(JSON.parse(await readFile(path.join(shell.paths.root, invalidatedResult.snapshotLocator), "utf8"))).toMatchObject({
      currentThroughChapterId: chapter13.chapterId,
      fingerprint: atHead.stateIdentity.fingerprint,
    });
    expect(JSON.parse(await readFile(path.join(shell.paths.root, "story-bible/writing-state.json"), "utf8"))).toMatchObject({
      revision: publicStateBeforeRebuild.revision,
      fingerprint: publicStateBeforeRebuild.fingerprint,
      currentThroughChapterId: publicStateBeforeRebuild.currentThroughChapterId,
    });
    const rebuildStartedStatus = await getNovelStateRebuildStatus(shell.paths.root);
    expect(rebuildStartedStatus).toMatchObject({
      healthy: true,
      recoveryRequired: false,
      publicHead: { stateFingerprint: publicStateBeforeRebuild.fingerprint },
      activeRebuild: {
        nextChapterId: chapter11.chapterId,
        shadowHeadEventId: expect.stringMatching(/^novel-state-event-/u),
      },
    });
    const rebuildStartedEvent = JSON.parse(await readFile(path.join(
      shell.paths.root,
      ".aicanvas/novel/state-history/events/sha256",
      `${rebuildStartedStatus.activeRebuild!.shadowHeadEventId}.json`,
    ), "utf8")) as { operationKind: string; parentEventId: string | null; beforeCheckpointId: string };
    expect(rebuildStartedEvent).toMatchObject({
      operationKind: "rebuild_started",
      parentEventId: rebuildStartedStatus.publicHead!.headEventId,
      beforeCheckpointId: rebuildStartedStatus.publicHead!.checkpointId,
    });

    const afterInvalidate = await getNovelWritingState(shell.paths.root, { targetChapterId: chapter12.chapterId, cutoff: "through" });
    await expect(executeIdempotentCommand(shell.paths.root, envelope("novel_stage_chapter_state_candidate", {
      chapterId: chapter12.chapterId,
      expectedChapterRevision: chapter12.revision,
      expectedChapterSha256: chapter12.sha256,
      expectedWritingStateRevision: afterInvalidate.stateIdentity.revision,
      expectedWritingStateFingerprint: afterInvalidate.stateIdentity.fingerprint,
      summary: "故意越过第011章",
      delta: { characterStates: [], knowledge: [], relationships: [], timeline: [], foreshadowing: [] },
      evidenceSpans: [{ evidenceId: "evidence-out-of-order", startOffset: 0, endOffset: 5, evidenceExcerpt: "第012章" }],
      changeEvidence: [],
      noStateChange: {
        reason: "故障注入",
        evidenceSpanIds: ["evidence-out-of-order"],
        checkedCharacterIds: ["character-yihang"],
      },
      auditScope: {
        checkedCharacterIds: ["character-yihang"],
        checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"],
      },
    }))).rejects.toMatchObject({ result: expect.objectContaining({ reason: "state_rebuild_out_of_order" }) });

    await commitNoChange(chapter11Current, "第011章");
    await commitNoChange(chapter12, "第012章");
    expect(JSON.parse(await readFile(path.join(shell.paths.root, "story-bible/writing-state.json"), "utf8"))).toMatchObject({
      fingerprint: publicStateBeforeRebuild.fingerprint,
      currentThroughChapterId: chapter13.chapterId,
    });
    await commitNoChange(chapter13, "第013章");
    const rebuilt = await getNovelWritingState(shell.paths.root, { targetChapterId: chapter13.chapterId, cutoff: "through" });
    expect(rebuilt.stateIdentity).toMatchObject({
      revision: 8,
      currentThroughChapterId: chapter13.chapterId,
      rebuild: null,
    });
    expect(JSON.parse(await readFile(path.join(shell.paths.root, "story-bible/writing-state.json"), "utf8"))).toMatchObject({
      revision: 8,
      fingerprint: rebuilt.stateIdentity.fingerprint,
      currentThroughChapterId: chapter13.chapterId,
    });
    expect(await getNovelStateRebuildStatus(shell.paths.root)).toMatchObject({
      healthy: true,
      recoveryRequired: false,
      verificationMode: "full",
      verifiedEventCount: 7,
      publicHead: { stateFingerprint: rebuilt.stateIdentity.fingerprint },
      activeRebuild: null,
    });
    const historyGapPlan = await planNovelStateRebuild(shell.paths.root, { targetChapterId: chapter10.chapterId });
    expect(historyGapPlan).toMatchObject({ allowed: false, reason: "history_gap" });
  }, 60_000);

  it("Context Pack 2.0先保硬正典和任务，再裁正文，并为011生成可复验preflight", async () => {
    const { shell, chapter10, chapter11 } = await fixture();
    await executeIdempotentCommand(shell.paths.root, envelope(
      "novel_seed_writing_state",
      seedPayload(chapter10.chapterId, chapter11.chapterId),
    ), { novelWriteActor: "human_ui" });
    const pack = await buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      characterIds: ["character-yihang"],
      maxCharacters: 2048,
    });
    expect(pack).toMatchObject({
      contextPackVersion: 2,
      selection: { targetChapterId: chapter11.chapterId, cutoffChapterId: chapter10.chapterId },
      sections: {
        hardCanon: [{ ruleId: "canon-pass-through" }],
        taskBrief: { chapterId: chapter11.chapterId },
        characterStates: [{ entityId: "character-yihang" }],
      },
    });
    if (!("sections" in pack)) throw new Error("预期Context Pack 2.0。");
    expect(JSON.stringify(pack)).toContain("不得转嫁给无辜者");
    expect(pack.sections.knowledge).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ knowledgeId: "knowledge-future-chain-owner" }),
    ]));
    expect(pack.budget.usedCharacters).toBeLessThanOrEqual(2048);

    const preflight = await preflightNovelChapterWrite(shell.paths.root, {
      targetChapterId: chapter11.chapterId,
      contextPackFingerprint: pack.fingerprint,
      characterIds: ["character-yihang"],
      maxCharacters: 2048,
    });
    expect(preflight).toMatchObject({
      ready: true,
      targetChapter: { chapterId: chapter11.chapterId, revision: 1, sha256: chapter11.sha256 },
      writingState: { revision: 1 },
      contextPackFingerprint: pack.fingerprint,
    });
    expect(preflight.preflightId).toMatch(/^novel-write-preflight-[a-f0-9]{24}$/u);
  });

  it("formal 关键 timeline/foreshadowing 装不下时失败关闭，rehearsal 仅显式报告裁剪", async () => {
    const { shell, chapter10, chapter11 } = await fixture();
    const seed = seedPayload(chapter10.chapterId, chapter11.chapterId);
    seed.timeline[0]!.summary = "不得丢失的长时间线".repeat(120);
    await executeIdempotentCommand(shell.paths.root, envelope(
      "novel_seed_writing_state",
      seed,
    ), { novelWriteActor: "human_ui" });

    await expect(buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      characterIds: ["character-yihang"],
      workflowMode: "formal",
      maxCharacters: 512,
    })).rejects.toMatchObject({
      result: {
        applied: false,
        reason: "critical_memory_budget_insufficient",
        chapterId: chapter11.chapterId,
        minimumCharacters: expect.any(Number),
        maximumAllowedCharacters: 200_000,
        omittedSections: expect.arrayContaining([
          expect.objectContaining({ section: "timeline", count: 1 }),
          expect.objectContaining({ section: "foreshadowing", count: 1 }),
        ]),
        nextTools: [expect.objectContaining({
          tool: "prepare_novel_chapter_write",
          args: expect.objectContaining({
            targetChapterId: chapter11.chapterId,
            workflowMode: "formal",
            maxCharacters: expect.any(Number),
          }),
        })],
      },
    });

    const rehearsal = await buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      characterIds: ["character-yihang"],
      workflowMode: "rehearsal",
      maxCharacters: 512,
    });
    if (!("sections" in rehearsal)) throw new Error("预期 rehearsal Context Pack 2.0。");
    expect(rehearsal.budget).toMatchObject({
      maximumCharacters: 512,
      criticalMemory: {
        policy: "report_omission",
        sections: ["timeline", "foreshadowing"],
        requiredCharacters: 0,
      },
      truncated: true,
      omitted: expect.arrayContaining([expect.objectContaining({ section: "timeline", count: 1 })]),
    });
  });

  it("修订章 pack 与 preflight 使用同一 taskType 和预算参数，不被 continue 默认值误判 stale", async () => {
    const { shell, chapter10, chapter11 } = await fixture();
    await executeIdempotentCommand(shell.paths.root, envelope(
      "novel_seed_writing_state",
      seedPayload(chapter10.chapterId, chapter11.chapterId),
    ), { novelWriteActor: "human_ui" });
    const pack = await buildNovelContextPack(shell.paths.root, {
      taskType: "revise_chapter",
      targetChapterId: chapter11.chapterId,
      query: "上一章",
      chapterIds: [chapter10.chapterId],
      characterIds: ["character-yihang"],
      maxCharacters: 1024,
      maxSearchHits: 7,
      workflowMode: "formal",
    });
    if (!("sections" in pack) || !("writePreflightInput" in pack) || !pack.writePreflightInput) {
      throw new Error("预期可写 Context Pack 2.0。");
    }
    expect(pack.selection.taskType).toBe("revise_chapter");
    expect(pack.writePreflightInput).toEqual({
      taskType: "revise_chapter",
      workflowMode: "formal",
      targetChapterId: chapter11.chapterId,
      contextPackFingerprint: pack.fingerprint,
      query: "上一章",
      chapterIds: [chapter10.chapterId],
      characterIds: ["character-yihang"],
      maxCharacters: 1024,
      maxSearchHits: 7,
    });

    const preflight = await preflightNovelChapterWrite(shell.paths.root, pack.writePreflightInput);
    expect(preflight).toMatchObject({
      ready: true,
      contextPackFingerprint: pack.fingerprint,
      targetChapter: { chapterId: chapter11.chapterId },
    });

    const mismatches = [
      { ...pack.writePreflightInput, taskType: "continue_chapter" as const },
      { ...pack.writePreflightInput, query: "不存在" },
      { ...pack.writePreflightInput, chapterIds: [] },
      { ...pack.writePreflightInput, maxCharacters: 1025 },
      { ...pack.writePreflightInput, maxSearchHits: 8 },
    ];
    for (const mismatch of mismatches) {
      const stale = await preflightNovelChapterWrite(shell.paths.root, mismatch);
      expect(stale).toMatchObject({
        ready: false,
        contextPackFingerprint: pack.fingerprint,
        blockers: [expect.objectContaining({ code: "context_preflight_stale" })],
      });
      if (!("currentContextPackFingerprint" in stale) || !("currentWritePreflightInput" in stale)) {
        throw new Error("参数错配必须返回当前 Context Pack 与 canonical preflight 输入。");
      }
      expect(stale.currentContextPackFingerprint).not.toBe(pack.fingerprint);
      expect(stale.currentWritePreflightInput).toMatchObject({
        targetChapterId: chapter11.chapterId,
        contextPackFingerprint: stale.currentContextPackFingerprint,
      });
    }
    await expect(preflightNovelChapterWrite(shell.paths.root, {
      ...pack.writePreflightInput,
      characterIds: [],
    })).rejects.toThrow(/requiredCharacterIds.*完全一致|characterIds.*完全一致/u);

    const reviewPack = await buildNovelContextPack(shell.paths.root, {
      taskType: "review_chapter",
      targetChapterId: chapter11.chapterId,
      maxCharacters: 1024,
      maxSearchHits: 7,
    });
    if (!("writePreflightInput" in reviewPack)) throw new Error("预期 Context Pack 2.0。");
    expect(reviewPack.writePreflightInput).toBeNull();
  });

  it("硬正典与任务超过预算时失败关闭，不以裁正文为名静默丢规则", async () => {
    const { shell, chapter10, chapter11 } = await fixture();
    const seed = seedPayload(chapter10.chapterId, chapter11.chapterId);
    seed.hardCanon[0]!.text = "不可丢弃的硬正典".repeat(80);
    await executeIdempotentCommand(shell.paths.root, envelope("novel_seed_writing_state", seed), { novelWriteActor: "human_ui" });
    await expect(buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      characterIds: ["character-yihang"],
      maxCharacters: 256,
    })).rejects.toThrow(/预算不足.*禁止静默丢失/u);
  });

  it("人工修改已commit正文保持兼容，但会使依赖它的下游状态preflight明确stale", async () => {
    const { shell, chapter10, chapter11 } = await fixture();
    await executeIdempotentCommand(shell.paths.root, envelope(
      "novel_seed_writing_state",
      seedPayload(chapter10.chapterId, chapter11.chapterId),
    ), { novelWriteActor: "human_ui" });
    await executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
      chapterId: chapter10.chapterId,
      content: "上一章经人工修订，未携带AI preflight。",
      expectedRevision: chapter10.revision,
      expectedSha256: chapter10.sha256,
    }), { novelWriteActor: "human_ui" });
    const pack = await buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      characterIds: ["character-yihang"],
      maxCharacters: 1024,
    });
    const blocked = await preflightNovelChapterWrite(shell.paths.root, {
      targetChapterId: chapter11.chapterId,
      contextPackFingerprint: pack.fingerprint,
      characterIds: ["character-yihang"],
      maxCharacters: 1024,
    });
    expect(blocked).toMatchObject({
      ready: false,
      blockers: [expect.objectContaining({ code: "state_commit_required", chapterId: chapter10.chapterId })],
    });
  });

  it("AI保存绑定preflight/pack，写后未commit状态会阻断下一章", async () => {
    const { shell, repository, chapter10, chapter11 } = await fixture();
    await executeIdempotentCommand(shell.paths.root, envelope(
      "novel_seed_writing_state",
      seedPayload(chapter10.chapterId, chapter11.chapterId),
    ), { novelWriteActor: "human_ui" });
    const doctor = await doctorNovelAgent(shell.paths.root, { targetChapterId: chapter11.chapterId });
    expect(doctor).toMatchObject({
      readyForPrepare: true,
      targetChapter: { chapterId: chapter11.chapterId },
      requiredCharacterIds: ["character-yihang"],
      blockers: [],
      nextTools: [expect.objectContaining({ tool: "prepare_novel_chapter_write" })],
    });
    const prepared = await prepareNovelChapterWrite(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      characterIds: ["character-yihang"],
      maxCharacters: 1024,
      attribution: testAttribution,
    });
    if (!prepared.ready) throw new Error("预期 prepare ready");
    if (!("selectionTrace" in prepared.pack)) throw new Error("预期 Context Pack 2.0 selection trace");
    const receipt = prepared.lease.contextPackReceipt;
    expect(receipt).toMatchObject({
      kind: "novel-context-pack-receipt",
      targetChapter: { chapterId: chapter11.chapterId, revision: chapter11.revision, sha256: chapter11.sha256 },
      cutoffChapterId: chapter10.chapterId,
      contextPackFingerprint: prepared.pack.fingerprint,
      preflightId: prepared.preflight.preflightId,
      ready: true,
      selectionTrace: {
        targetChapterId: chapter11.chapterId,
        cutoffChapterId: chapter10.chapterId,
        requiredCharacterIds: ["character-yihang"],
        policies: {
          authorOnlyCanon: "excluded_without_receipt_entry",
          futureChapters: "excluded_after_cutoff",
          absolutePaths: "never_persisted",
          uiRecomputation: "forbidden",
        },
      },
    });
    expect(receipt?.selectionTrace.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: "hardCanon", itemId: "canon-pass-through", disposition: "included", protection: "protected" }),
      expect.objectContaining({ section: "taskBrief", itemId: chapter11.chapterId, disposition: "included", protection: "protected" }),
      expect.objectContaining({ section: "characterStates", itemId: "state-yihang", disposition: "included", protection: "protected" }),
      expect.objectContaining({ section: "timeline", itemId: "timeline-d4", disposition: "included", protection: "protected" }),
      expect.objectContaining({ section: "foreshadowing", itemId: "foreshadow-chain", disposition: "included", protection: "protected" }),
      expect.objectContaining({ section: "excerpts", itemId: chapter10.chapterId, disposition: "included", protection: "compressible" }),
    ]));
    const persistedReceipt = await readFile(path.join(
      shell.paths.root,
      ".aicanvas/novel/chapter-write-leases.json",
    ), "utf8");
    expect(persistedReceipt).toContain(receipt!.fingerprint);
    expect(persistedReceipt).not.toContain(shell.paths.root);
    expect(persistedReceipt).not.toContain("relativePath");
    expect(persistedReceipt).not.toContain("knowledge-future-chain-owner");
    const leasedDoctor = await doctorNovelAgent(shell.paths.root, { targetChapterId: chapter11.chapterId });
    expect(leasedDoctor).toMatchObject({
      readyForPrepare: false,
      lease: {
        held: true,
        leaseId: prepared.lease.leaseId,
        contextPackReceipt: { fingerprint: receipt!.fingerprint },
      },
      blockers: [expect.objectContaining({ code: "chapter_write_lease_conflict" })],
    });
    const pack = prepared.pack;
    const preflight = prepared.preflight;
    await expect(prepareNovelChapterWrite(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      characterIds: ["character-yihang"],
      maxCharacters: 1024,
      attribution: { ...testAttribution, actorId: "competing-writer", sessionId: "competing-session" },
    })).rejects.toMatchObject({ result: expect.objectContaining({ reason: "chapter_write_lease_conflict" }) });
    await expect(executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
      chapterId: chapter11.chapterId,
      content: "错误 token 不得落盘。",
      expectedRevision: chapter11.revision,
      expectedSha256: chapter11.sha256,
      aiWriteContext: prepared.aiWriteContext,
    }), {
      novelWriteLeaseToken: `novel-lease-token-${"A".repeat(43)}`,
      novelActorAttribution: testAttribution,
    })).rejects.toMatchObject({ result: expect.objectContaining({ reason: "chapter_write_lease_stale" }) });
    await expect(executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
      chapterId: chapter11.chapterId,
      content: "审稿 Agent 不得落盘。",
      expectedRevision: chapter11.revision,
      expectedSha256: chapter11.sha256,
      aiWriteContext: prepared.aiWriteContext,
    }), {
      novelWriteActor: "agent_reviewer",
      novelWriteLeaseToken: prepared.leaseToken,
      novelActorAttribution: testAttribution,
    })).rejects.toMatchObject({ result: expect.objectContaining({ reason: "actor_forbidden" }) });
    expect(await repository.readChapter(chapter11.chapterId)).toMatchObject({ status: "healthy", content: "" });
    const saved = await executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
      chapterId: chapter11.chapterId,
      content: "第011章隔离演练正文。",
      expectedRevision: chapter11.revision,
      expectedSha256: chapter11.sha256,
      aiWriteContext: prepared.aiWriteContext,
    }), {
      novelWriteLeaseToken: prepared.leaseToken,
      novelActorAttribution: testAttribution,
    });
    const savedChapter = (saved.result as { chapter: { chapterId: string; revision: number; sha256: string } }).chapter;
    expect(savedChapter).toMatchObject({ chapterId: chapter11.chapterId, revision: 2 });

    const snapshot = await repository.snapshot();
    const created12 = await executeIdempotentCommand(shell.paths.root, envelope("novel_create_chapter", {
      volumeId: snapshot.chapters!.volumes[0]!.volumeId,
      title: "第012章",
      content: "",
      expectedManifestRevision: snapshot.chapters!.revision,
    }));
    const chapter12 = (created12.result as { chapter: { chapterId: string } }).chapter;
    const pack12 = await buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter12.chapterId,
      characterIds: ["character-yihang"],
      workflowMode: "rehearsal",
      maxCharacters: 1024,
    });
    const blocked = await preflightNovelChapterWrite(shell.paths.root, {
      targetChapterId: chapter12.chapterId,
      contextPackFingerprint: pack12.fingerprint,
      characterIds: ["character-yihang"],
      workflowMode: "rehearsal",
      maxCharacters: 1024,
    });
    expect(blocked).toMatchObject({
      ready: false,
      blockers: [expect.objectContaining({ code: "state_commit_required", chapterId: chapter11.chapterId })],
    });

    await expect(executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
      chapterId: savedChapter.chapterId,
      content: "不应接受的旧上下文保存。",
      expectedRevision: savedChapter.revision,
      expectedSha256: savedChapter.sha256,
      aiWriteContext: {
        ...prepared.aiWriteContext,
      },
    }), {
      novelWriteLeaseToken: prepared.leaseToken,
      novelActorAttribution: testAttribution,
    })).rejects.toMatchObject({
      result: expect.objectContaining({ reason: "context_preflight_stale" }),
    });
  });

  it("候选经人工accepted后推进state commit；审稿票不改正文或状态", async () => {
    const { shell, repository, chapter10, chapter11 } = await fixture();
    await executeIdempotentCommand(shell.paths.root, envelope(
      "novel_seed_writing_state",
      seedPayload(chapter10.chapterId, chapter11.chapterId),
    ), { novelWriteActor: "human_ui" });
    const prepared = await prepareNovelChapterWrite(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapter11.chapterId,
      characterIds: ["character-yihang"],
      maxCharacters: 1024,
      attribution: testAttribution,
    });
    if (!prepared.ready) throw new Error("预期 prepare ready");
    const pack = prepared.pack;
    const preflight = prepared.preflight;
    const saved = await executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
      chapterId: chapter11.chapterId,
      content: "第011章隔离演练正文。",
      expectedRevision: 1,
      expectedSha256: chapter11.sha256,
      aiWriteContext: prepared.aiWriteContext,
    }), {
      novelWriteLeaseToken: prepared.leaseToken,
      novelActorAttribution: testAttribution,
    });
    const savedChapter = (saved.result as { chapter: { chapterId: string; revision: number; sha256: string } }).chapter;
    const beforeBody = await repository.readChapter(chapter11.chapterId);
    const beforeState = await getNovelWritingState(shell.paths.root, { targetChapterId: chapter11.chapterId, cutoff: "through" });

    const ticket = await executeIdempotentCommand(shell.paths.root, envelope("novel_attach_review_ticket", {
      chapterId: chapter11.chapterId,
      expectedChapterRevision: savedChapter.revision,
      expectedChapterSha256: savedChapter.sha256,
      startOffset: 0,
      endOffset: 5,
      evidenceExcerpt: "第011章",
      severity: "P1",
      impact: "开头仍可更具体",
      minimalFix: "补一个可见动作",
      confidence: 0.9,
      reviewer: "local-reviewer",
    }));
    expect(ticket.result).toMatchObject({ ticket: { severity: "P1", reviewer: "local-reviewer" } });
    expect(await repository.readChapter(chapter11.chapterId)).toEqual(beforeBody);
    expect((await getNovelWritingState(shell.paths.root, { targetChapterId: chapter11.chapterId, cutoff: "through" })).stateIdentity)
      .toEqual(beforeState.stateIdentity);

    const staged = await executeIdempotentCommand(shell.paths.root, envelope("novel_stage_chapter_state_candidate", {
      chapterId: chapter11.chapterId,
      expectedChapterRevision: savedChapter.revision,
      expectedChapterSha256: savedChapter.sha256,
      expectedWritingStateRevision: beforeState.stateIdentity.revision,
      expectedWritingStateFingerprint: beforeState.stateIdentity.fingerprint,
      summary: "011章末勾账",
      delta: {
        characterStates: [{
          stateId: "state-yihang",
          entityId: "character-yihang",
          fields: {
            body: "夜班透支",
            emotion: "冷静",
            known: ["担保链需要收指"],
            unknown: ["后台完整结构"],
            relationships: ["阿大：师友"],
            goals: ["先打账"],
            psychology: "不硬刚刀疤",
            unresolved: ["清晰版后果"],
          },
        }],
        knowledge: [],
        relationships: [],
        timeline: [],
        foreshadowing: [],
      },
      evidenceSpans: [{ evidenceId: "evidence-011-state", startOffset: 0, endOffset: 5, evidenceExcerpt: "第011章" }],
      changeEvidence: [{
        kind: "character_state",
        recordId: "state-yihang",
        reason: "正文明确形成先打账的章末目标",
        evidenceSpanIds: ["evidence-011-state"],
      }],
      auditScope: {
        checkedCharacterIds: ["character-yihang"],
        checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"],
      },
    }));
    const candidate = (staged.result as { candidate: { candidateId: string; fingerprint: string } }).candidate;
    const committed = await executeIdempotentCommand(shell.paths.root, envelope("novel_review_chapter_state_candidate", {
      candidateId: candidate.candidateId,
      expectedCandidateFingerprint: candidate.fingerprint,
      expectedWritingStateRevision: beforeState.stateIdentity.revision,
      expectedWritingStateFingerprint: beforeState.stateIdentity.fingerprint,
      decision: "accepted",
      reviewer: "human-owner",
      note: "隔离演练接受",
    }), { novelWriteActor: "human_ui" });
    expect(committed.result).toMatchObject({
      decision: { decision: "accepted" },
      state: { revision: beforeState.stateIdentity.revision + 1, currentThroughChapterId: chapter11.chapterId },
    });
    const after = await getNovelWritingState(shell.paths.root, { targetChapterId: chapter11.chapterId, cutoff: "through" });
    expect(after.temporal.characterStates[0]).toMatchObject({
      entityId: "character-yihang",
      throughChapterId: chapter11.chapterId,
      fields: { goals: ["先打账"] },
    });
    expect(after.stateIdentity.revision).toBe(beforeState.stateIdentity.revision + 1);
    const historyStatus = await getNovelStateRebuildStatus(shell.paths.root);
    expect(historyStatus).toMatchObject({
      healthy: true,
      recoveryRequired: false,
      publicHead: {
        headEventId: expect.stringMatching(/^novel-state-event-/u),
        checkpointId: expect.stringMatching(/^novel-state-checkpoint-/u),
        stateFingerprint: after.stateIdentity.fingerprint,
        coverageMode: "head_only",
      },
      activeRebuild: null,
    });
    const publicHead = historyStatus.publicHead!;
    const historyOperationsRoot = path.join(
      shell.paths.root,
      ".aicanvas/novel/state-history/operations",
    );
    expect(JSON.parse(await readFile(path.join(historyOperationsRoot, "layout.json"), "utf8")))
      .toMatchObject({ strategy: "pending-markers-v1" });
    expect(await readdir(path.join(historyOperationsRoot, "pending"))).toEqual([]);
    expect(await readdir(path.join(historyOperationsRoot, "completed-markers")))
      .toEqual([expect.stringMatching(/^[a-f0-9]{64}\.json$/u)]);
    const event = JSON.parse(await readFile(path.join(
      shell.paths.root,
      ".aicanvas/novel/state-history/events/sha256",
      `${publicHead.headEventId}.json`,
    ), "utf8")) as { operationKind: string; parentEventId: string | null; afterStateFingerprint: string; checkpointId: string };
    expect(event).toMatchObject({
      operationKind: "chapter_state_commit",
      parentEventId: null,
      afterStateFingerprint: after.stateIdentity.fingerprint,
      checkpointId: publicHead.checkpointId,
    });
    const checkpoint = JSON.parse(await readFile(path.join(
      shell.paths.root,
      ".aicanvas/novel/state-history/checkpoints/sha256",
      `${publicHead.checkpointId}.json`,
    ), "utf8")) as { state: { fingerprint: string } };
    expect(checkpoint.state.fingerprint).toBe(after.stateIdentity.fingerprint);
    const beforeRevision = await getNovelWritingState(shell.paths.root, {
      targetChapterId: chapter11.chapterId,
      cutoff: "before",
      characterIds: ["character-yihang"],
    });
    expect(beforeRevision.temporal.characterStates).toContainEqual(expect.objectContaining({
      stateId: "state-yihang",
      entityId: "character-yihang",
      throughChapterId: chapter10.chapterId,
      fields: expect.objectContaining({ goals: ["收指摸担保链"] }),
    }));

    await rm(path.join(historyOperationsRoot, "layout.json"));
    await rm(path.join(historyOperationsRoot, "pending"), { recursive: true, force: true });
    await rm(path.join(historyOperationsRoot, "completed-markers"), { recursive: true, force: true });
    const migrated = await executeIdempotentCommand(shell.paths.root, envelope(
      "novel_recover_writing_state",
      {},
    ));
    expect(migrated.result).toEqual({ recoveredOperations: 0 });
    expect(JSON.parse(await readFile(path.join(historyOperationsRoot, "layout.json"), "utf8")))
      .toMatchObject({ strategy: "pending-markers-v1", projectId: shell.project.id });
    expect(await getNovelStateRebuildStatus(shell.paths.root)).toMatchObject({
      healthy: true,
      recoveryRequired: false,
    });
  });

  it("状态 accepted 在 control 后中断可显式恢复，并用 durable proof 收敛原 unknown 命令", async () => {
    const { shell, chapter10, chapter11 } = await fixture();
    await executeIdempotentCommand(shell.paths.root, envelope(
      "novel_seed_writing_state",
      seedPayload(chapter10.chapterId, chapter11.chapterId),
    ), { novelWriteActor: "human_owner" });
    const saved = await executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
      chapterId: chapter11.chapterId,
      content: "故障恢复正文。",
      expectedRevision: chapter11.revision,
      expectedSha256: chapter11.sha256,
    }), { novelWriteActor: "human_ui" });
    const savedChapter = (saved.result as { chapter: { chapterId: string; revision: number; sha256: string } }).chapter;
    const before = await getNovelWritingState(shell.paths.root, { targetChapterId: chapter11.chapterId, cutoff: "through" });
    const staged = await executeIdempotentCommand(shell.paths.root, envelope("novel_stage_chapter_state_candidate", {
      chapterId: savedChapter.chapterId,
      expectedChapterRevision: savedChapter.revision,
      expectedChapterSha256: savedChapter.sha256,
      expectedWritingStateRevision: before.stateIdentity.revision,
      expectedWritingStateFingerprint: before.stateIdentity.fingerprint,
      summary: "完整审计后无状态变化",
      delta: { characterStates: [], knowledge: [], relationships: [], timeline: [], foreshadowing: [] },
      evidenceSpans: [{ evidenceId: "evidence-recovery", startOffset: 0, endOffset: 4, evidenceExcerpt: "故障恢复" }],
      changeEvidence: [],
      noStateChange: {
        reason: "逐项核对五类状态后确认无变化",
        evidenceSpanIds: ["evidence-recovery"],
        checkedCharacterIds: ["character-yihang"],
      },
      auditScope: {
        checkedCharacterIds: ["character-yihang"],
        checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"],
      },
    }));
    const candidate = (staged.result as { candidate: { candidateId: string; fingerprint: string } }).candidate;
    const reviewInput = envelope("novel_review_chapter_state_candidate", {
      candidateId: candidate.candidateId,
      expectedCandidateFingerprint: candidate.fingerprint,
      expectedWritingStateRevision: before.stateIdentity.revision,
      expectedWritingStateFingerprint: before.stateIdentity.fingerprint,
      decision: "accepted",
      reviewer: "human-owner",
    });
    process.env.AI_CANVAS_TEST_WRITING_STATE_HISTORY_INTERRUPT = "after-control";
    await expect(executeIdempotentCommand(shell.paths.root, reviewInput, { novelWriteActor: "human_owner" }))
      .rejects.toThrow(/writing-state history interruption/u);
    delete process.env.AI_CANVAS_TEST_WRITING_STATE_HISTORY_INTERRUPT;

    expect(await getNovelStateRebuildStatus(shell.paths.root)).toMatchObject({
      healthy: false,
      recoveryRequired: true,
      pendingOperations: [{ command: "novel_review_chapter_state_candidate" }],
    });
    expect(await doctorNovelAgent(shell.paths.root, { targetChapterId: chapter11.chapterId })).toMatchObject({
      readyForPrepare: false,
      blockers: [expect.objectContaining({
        code: "state_history_recovery_required",
        nextTools: [expect.objectContaining({
          tool: "execute_command",
          args: { request: { command: "novel_recover_writing_state", payload: {} } },
        })],
      })],
    });
    await expect(prepareNovelChapterWrite(shell.paths.root, {
      targetChapterId: chapter11.chapterId,
      workflowMode: "formal",
      maxCharacters: 1024,
      attribution: testAttribution,
    })).rejects.toMatchObject({
      result: expect.objectContaining({
        reason: "state_history_recovery_required",
        nextTools: [expect.objectContaining({
          args: { request: { command: "novel_recover_writing_state", payload: {} } },
        })],
      }),
    });
    const recovered = await executeIdempotentCommand(shell.paths.root, envelope(
      "novel_recover_writing_state",
      {},
    ));
    expect(recovered.result).toEqual({ recoveredOperations: 1 });
    expect(await getNovelStateRebuildStatus(shell.paths.root)).toMatchObject({
      healthy: true,
      recoveryRequired: false,
      activeRebuild: null,
    });
    expect((await getNovelWritingState(shell.paths.root, {
      targetChapterId: chapter11.chapterId,
      cutoff: "through",
    })).stateIdentity).toMatchObject({ currentThroughChapterId: chapter11.chapterId, revision: 2 });
    await expect(reconcileCommand(shell.paths.root, { idempotencyKey: reviewInput.idempotencyKey }))
      .resolves.toMatchObject({
        status: "succeeded",
        result: { reconciled: true, decision: { decision: "accepted" } },
      });
  });

  it.each(["after-intent", "after-state", "after-decision"] as const)(
    "状态 operation 在 %s 中断后可按同一 intent 收敛",
    async (phase) => {
      const value = await fixture();
      await executeIdempotentCommand(value.shell.paths.root, envelope(
        "novel_seed_writing_state",
        seedPayload(value.chapter10.chapterId, value.chapter11.chapterId),
      ), { novelWriteActor: "human_owner" });
      const { reviewInput } = await createNoChangeReviewInput(value, phase);
      process.env.AI_CANVAS_TEST_WRITING_STATE_HISTORY_INTERRUPT = phase;
      await expect(executeIdempotentCommand(
        value.shell.paths.root,
        reviewInput,
        { novelWriteActor: "human_owner" },
      )).rejects.toThrow(/writing-state history interruption/u);
      delete process.env.AI_CANVAS_TEST_WRITING_STATE_HISTORY_INTERRUPT;
      expect(await getNovelStateRebuildStatus(value.shell.paths.root)).toMatchObject({
        healthy: false,
        recoveryRequired: true,
        pendingOperations: [{ command: "novel_review_chapter_state_candidate" }],
      });
      const recovered = await executeIdempotentCommand(value.shell.paths.root, envelope(
        "novel_recover_writing_state",
        {},
      ));
      expect(recovered.result).toEqual({ recoveredOperations: 1 });
      expect(await getNovelStateRebuildStatus(value.shell.paths.root)).toMatchObject({
        healthy: true,
        recoveryRequired: false,
        verifiedEventCount: 1,
      });
    },
  );

  it("operation 出现额外节点或目标第三种 SHA 时恢复器零覆盖失败关闭", async () => {
    const value = await fixture();
    await executeIdempotentCommand(value.shell.paths.root, envelope(
      "novel_seed_writing_state",
      seedPayload(value.chapter10.chapterId, value.chapter11.chapterId),
    ), { novelWriteActor: "human_owner" });
    const { reviewInput } = await createNoChangeReviewInput(value, "fork-guard");
    process.env.AI_CANVAS_TEST_WRITING_STATE_HISTORY_INTERRUPT = "after-intent";
    await expect(executeIdempotentCommand(
      value.shell.paths.root,
      reviewInput,
      { novelWriteActor: "human_owner" },
    )).rejects.toThrow(/writing-state history interruption/u);
    delete process.env.AI_CANVAS_TEST_WRITING_STATE_HISTORY_INTERRUPT;
    const pending = await getNovelStateRebuildStatus(value.shell.paths.root);
    const requestHash = pending.pendingOperations[0]!.requestHash;
    const operationRoot = path.join(
      value.shell.paths.root,
      ".aicanvas/novel/state-history/operations",
      requestHash,
    );
    const unexpectedPath = path.join(operationRoot, "unexpected.json");
    await writeFile(unexpectedPath, "{}\n", { encoding: "utf8", flag: "wx" });
    await expect(executeIdempotentCommand(value.shell.paths.root, envelope(
      "novel_recover_writing_state",
      {},
    ))).rejects.toThrow(/未归属节点/u);
    await unlink(unexpectedPath);

    const statePath = path.join(value.shell.paths.root, "story-bible/writing-state.json");
    const originalState = await readFile(statePath);
    await writeFile(statePath, "{}\n", "utf8");
    await expect(executeIdempotentCommand(value.shell.paths.root, envelope(
      "novel_recover_writing_state",
      {},
    ))).rejects.toThrow(/第三方分叉/u);
    expect(await readFile(statePath, "utf8")).toBe("{}\n");
    await writeFile(statePath, originalState);
    const recovered = await executeIdempotentCommand(value.shell.paths.root, envelope(
      "novel_recover_writing_state",
      {},
    ));
    expect(recovered.result).toEqual({ recoveredOperations: 1 });
    expect(await getNovelStateRebuildStatus(value.shell.paths.root)).toMatchObject({
      healthy: true,
      recoveryRequired: false,
    });
  });

  it("event/checkpoint/control 任一被篡改时 doctor 与 prepare 均失败关闭", async () => {
    const { shell, chapter10, chapter11 } = await fixture();
    await executeIdempotentCommand(shell.paths.root, envelope(
      "novel_seed_writing_state",
      seedPayload(chapter10.chapterId, chapter11.chapterId),
    ), { novelWriteActor: "human_owner" });
    const saved = await executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
      chapterId: chapter11.chapterId,
      content: "完整性审计正文。",
      expectedRevision: chapter11.revision,
      expectedSha256: chapter11.sha256,
    }), { novelWriteActor: "human_ui" });
    const savedChapter = (saved.result as { chapter: { revision: number; sha256: string } }).chapter;
    const before = await getNovelWritingState(shell.paths.root, {
      targetChapterId: chapter11.chapterId,
      cutoff: "through",
    });
    const staged = await executeIdempotentCommand(shell.paths.root, envelope("novel_stage_chapter_state_candidate", {
      chapterId: chapter11.chapterId,
      expectedChapterRevision: savedChapter.revision,
      expectedChapterSha256: savedChapter.sha256,
      expectedWritingStateRevision: before.stateIdentity.revision,
      expectedWritingStateFingerprint: before.stateIdentity.fingerprint,
      summary: "完整审计后无状态变化",
      delta: { characterStates: [], knowledge: [], relationships: [], timeline: [], foreshadowing: [] },
      evidenceSpans: [{ evidenceId: "evidence-integrity", startOffset: 0, endOffset: 4, evidenceExcerpt: "完整性审" }],
      changeEvidence: [],
      noStateChange: {
        reason: "逐项核对五类状态后确认无变化",
        evidenceSpanIds: ["evidence-integrity"],
        checkedCharacterIds: ["character-yihang"],
      },
      auditScope: {
        checkedCharacterIds: ["character-yihang"],
        checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"],
      },
    }));
    const candidate = (staged.result as { candidate: { candidateId: string; fingerprint: string } }).candidate;
    await executeIdempotentCommand(shell.paths.root, envelope("novel_review_chapter_state_candidate", {
      candidateId: candidate.candidateId,
      expectedCandidateFingerprint: candidate.fingerprint,
      expectedWritingStateRevision: before.stateIdentity.revision,
      expectedWritingStateFingerprint: before.stateIdentity.fingerprint,
      decision: "accepted",
      reviewer: "human-owner",
    }), { novelWriteActor: "human_owner" });

    const healthy = await getNovelStateRebuildStatus(shell.paths.root);
    expect(healthy).toMatchObject({
      healthy: true,
      verificationMode: "full",
      verifiedEventCount: 1,
    });
    const head = healthy.publicHead!;
    const eventPath = path.join(
      shell.paths.root,
      ".aicanvas/novel/state-history/events/sha256",
      `${head.headEventId}.json`,
    );
    const checkpointPath = path.join(
      shell.paths.root,
      ".aicanvas/novel/state-history/checkpoints/sha256",
      `${head.checkpointId}.json`,
    );
    const controlPath = path.join(shell.paths.root, ".aicanvas/novel/state-history/control.json");
    const assertBlocked = async () => {
      expect(await doctorNovelAgent(shell.paths.root, { targetChapterId: chapter11.chapterId })).toMatchObject({
        readyForPrepare: false,
        blockers: [expect.objectContaining({ code: "state_history_integrity_mismatch" })],
      });
      await expect(prepareNovelChapterWrite(shell.paths.root, {
        targetChapterId: chapter11.chapterId,
        workflowMode: "formal",
        maxCharacters: 1024,
        attribution: testAttribution,
      })).rejects.toMatchObject({
        result: expect.objectContaining({ reason: "state_history_integrity_mismatch" }),
      });
    };

    for (const artifactPath of [eventPath, checkpointPath]) {
      const original = await readFile(artifactPath);
      const tampered = JSON.parse(original.toString("utf8")) as Record<string, unknown>;
      tampered.kind = "tampered-history-artifact";
      await writeFile(artifactPath, `${JSON.stringify(tampered)}\n`, "utf8");
      expect(await getNovelStateRebuildStatus(shell.paths.root)).toMatchObject({
        healthy: false,
        recoveryRequired: false,
        issue: expect.stringMatching(/结构无效|fingerprint/u),
      });
      await assertBlocked();
      await writeFile(artifactPath, original);
      expect(await getNovelStateRebuildStatus(shell.paths.root)).toMatchObject({ healthy: true });
    }

    const originalControl = await readFile(controlPath);
    const tamperedControl = JSON.parse(originalControl.toString("utf8")) as { revision: number };
    tamperedControl.revision += 1;
    await writeFile(controlPath, `${JSON.stringify(tamperedControl)}\n`, "utf8");
    await expect(getNovelStateRebuildStatus(shell.paths.root)).rejects.toThrow(/fingerprint/u);
    await assertBlocked();
  });
});
