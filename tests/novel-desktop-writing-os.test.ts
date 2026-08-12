import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeIdempotentCommand, type IdempotentCommandInput } from "../src/core/command-bus.js";
import {
  getNovelDesktopWritingDashboard,
  reviewNovelDesktopStateCandidate,
} from "../src/core/novel-desktop-writing-os.js";
import { prepareNovelChapterWrite } from "../src/core/novel-agent-service.js";
import { createManagedProject } from "../src/core/managed-project.js";

const roots: string[] = [];
let sequence = 0;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function envelope(command: string, payload: Record<string, unknown>): IdempotentCommandInput {
  sequence += 1;
  return {
    requestId: `desktop-writing-os-${sequence}-${randomUUID()}`,
    idempotencyKey: `desktop-writing-os-key-${sequence}-${randomUUID()}`,
    request: { command, payload },
  } as IdempotentCommandInput;
}

async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "novel-desktop-writing-os-")));
  roots.push(parent);
  const shell = await createManagedProject({ parentRoot: parent, name: "桌面 Writing OS 夹具", workspaceMode: "novel" });
  const initialized = await executeIdempotentCommand(shell.paths.root, envelope("novel_initialize_manuscript", {
    sourceMode: "managed_markdown",
  }));
  let manifest = (initialized.result as {
    chapters: { revision: number; volumes: Array<{ volumeId: string }> };
  }).chapters;
  const volumeId = manifest.volumes[0]!.volumeId;
  const chapters: Array<{ chapterId: string; revision: number; sha256: string }> = [];
  for (const [title, content] of [["第010章", "易航确认担保短信存在。"], ["第011章", ""]] as const) {
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
  const chapter10 = chapters[0]!;
  const chapter11 = chapters[1]!;
  const seeded = await executeIdempotentCommand(shell.paths.root, envelope("novel_seed_writing_state", {
    baselineStatus: "locked",
    sourceTreeAggregateSha256: createHash("sha256").update("desktop-source-tree").digest("hex"),
    currentThroughChapterId: chapter10.chapterId,
    sourceDocuments: [{ sourceId: "canon", displayPath: "正典/锁版.md", content: "易航证据优先。作者暗线不得外泄。" }],
    entities: [{
      entityId: "character-yihang",
      name: "易航",
      aliases: [],
      level: "L1",
      baseSummary: "冷静，证据优先。",
      sourceIds: ["canon"],
    }],
    hardCanon: [
      {
        ruleId: "canon-evidence-first",
        text: "易航证据优先。",
        priority: 100,
        canonStatus: "canon",
        visibility: "writer",
        sourceIds: ["canon"],
      },
      {
        ruleId: "canon-author-secret",
        text: "禁用词：账本；绝密后台身份：不可交给 writer。",
        priority: 200,
        canonStatus: "canon",
        visibility: "author_only",
        sourceIds: ["canon"],
      },
    ],
    characterStates: [{
      stateId: "state-yihang",
      entityId: "character-yihang",
      throughChapterId: chapter10.chapterId,
      fields: {
        body: "疲惫",
        emotion: "克制",
        known: ["担保短信存在"],
        unknown: ["后台身份"],
        relationships: [],
        goals: ["完成对账"],
        psychology: "先固定证据",
        unresolved: ["担保链去向"],
      },
      sourceIds: ["canon"],
    }],
    knowledge: [],
    relationships: [],
    timeline: [],
    foreshadowing: [],
    chapterBriefs: [{
      chapterId: chapter11.chapterId,
      summary: "易航固定账本证据。",
      mustDo: ["完成对账"],
      mustNotDo: ["泄露后台身份"],
      requiredCharacterIds: ["character-yihang"],
      sourceIds: ["canon"],
    }],
    characterProfiles: [{
      entityId: "character-yihang",
      valuePriorities: ["证据优先"],
      coreDesire: "固定责任链",
      coreFear: "证据被抹去",
      secret: "旧案创伤",
      boundaries: ["不伤无辜"],
      forbiddenPhrases: ["一切尽在掌握"],
      vocabulary: ["对账", "证据"],
      sentencePatterns: ["短句"],
      relationshipVoices: [],
      sampleLines: ["先对账。"],
      sourceIds: ["canon"],
    }],
    characterAppearances: [{
      entityId: "character-yihang",
      summary: "清瘦青年，右眉尾有浅疤。",
      locks: [{
        lockId: "appearance-yihang-brow-scar",
        category: "distinctive_mark",
        canonicalDescription: "右眉尾有一道浅疤",
        allowedVariants: ["右眉尾淡疤"],
        contradictionPhrases: ["眉尾无疤"],
        mutability: "immutable",
        enforcement: "block",
      }],
      sourceIds: ["canon"],
    }],
    completedChapterIds: [chapter10.chapterId],
  }), { novelWriteActor: "human_ui" });
  const initialState = (seeded.result as { state: { revision: number; fingerprint: string } }).state;
  const content = "易航按住账本，先对账。";
  const saved = await executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
    chapterId: chapter11.chapterId,
    content,
    expectedRevision: chapter11.revision,
    expectedSha256: chapter11.sha256,
  }), { novelWriteActor: "human_ui" });
  const savedChapter = (saved.result as { chapter: { chapterId: string; revision: number; sha256: string } }).chapter;
  const staged = await executeIdempotentCommand(shell.paths.root, envelope("novel_stage_chapter_state_candidate", {
    chapterId: chapter11.chapterId,
    expectedChapterRevision: savedChapter.revision,
    expectedChapterSha256: savedChapter.sha256,
    expectedWritingStateRevision: initialState.revision,
    expectedWritingStateFingerprint: initialState.fingerprint,
    summary: "易航完成账本证据固定，疲惫加重。",
    delta: {
      characterStates: [{
        stateId: "state-yihang",
        entityId: "character-yihang",
        fields: {
          body: "通宵后明显疲惫",
          emotion: "克制但警觉",
          known: ["担保短信存在", "账本可作证"],
          unknown: ["后台身份"],
          relationships: [],
          goals: ["追查责任链"],
          psychology: "证据已固定，开始追人",
          unresolved: ["担保链去向"],
        },
      }],
      knowledge: [],
      relationships: [],
      timeline: [],
      foreshadowing: [],
    },
    evidenceSpans: [{ evidenceId: "evidence-body", startOffset: 0, endOffset: content.length, evidenceExcerpt: content }],
    changeEvidence: [{
      kind: "character_state",
      recordId: "state-yihang",
      reason: "动作与对白证明本章完成证据固定。",
      evidenceSpanIds: ["evidence-body"],
    }],
    auditScope: {
      checkedCharacterIds: ["character-yihang"],
      checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"],
    },
  }));
  const candidate = (staged.result as { candidate: { candidateId: string; fingerprint: string } }).candidate;
  return { shell, chapter10, chapter11: savedChapter, candidate };
}

describe("Novel desktop Writing OS dashboard", () => {
  it("只投影已随活动租约落盘的 Context Pack 回执，不在桌面重建选择逻辑", async () => {
    const { shell, chapter11 } = await fixture();
    const prepared = await prepareNovelChapterWrite(shell.paths.root, {
      taskType: "revise_chapter",
      targetChapterId: chapter11.chapterId,
      characterIds: ["character-yihang"],
      maxCharacters: 2_048,
      attribution: {
        actorId: "desktop-receipt-test",
        provider: "openai",
        model: "fixture-model",
        sessionId: "desktop-receipt-session",
        transport: "internal",
      },
    });
    if (!prepared.ready) throw new Error("预期桌面回执夹具 prepare ready");
    const dashboard = await getNovelDesktopWritingDashboard(shell.paths.root, {
      selectedChapterId: chapter11.chapterId,
      workflowMode: "formal",
    });
    expect(dashboard.writeReadiness.lease).toMatchObject({
      held: true,
      leaseId: prepared.lease.leaseId,
      contextPackReceipt: {
        fingerprint: prepared.lease.contextPackReceipt?.fingerprint,
        targetChapter: { chapterId: chapter11.chapterId },
        ready: true,
        selectionTrace: {
          policies: { uiRecomputation: "forbidden" },
          entries: expect.arrayContaining([
            expect.objectContaining({ section: "hardCanon", itemId: "canon-evidence-first" }),
            expect.objectContaining({ section: "taskBrief", itemId: chapter11.chapterId }),
          ]),
        },
      },
    });
    const serialized = JSON.stringify(dashboard.writeReadiness.lease.contextPackReceipt);
    expect(serialized).not.toContain(shell.paths.root);
    expect(serialized).not.toContain("绝密后台身份");
    expect(serialized).not.toContain("canon-author-secret");
    expect(serialized).not.toContain("objectRelativePath");
  });

  it("把正文保存后的状态债、探针冲突和八项状态 Diff 聚合为无路径桌面投影，并可接受推进", async () => {
    const { shell, chapter11, candidate } = await fixture();
    const dashboard = await getNovelDesktopWritingDashboard(shell.paths.root, {
      selectedChapterId: chapter11.chapterId,
      workflowMode: "formal",
    });
    expect(dashboard).toMatchObject({
      kind: "novel-desktop-writing-dashboard",
      writeReadiness: { readyForPrepare: true, targetChapter: { chapterId: chapter11.chapterId } },
      selectedChapter: {
        completion: { status: "missing", stateDebt: true },
        probe: { status: "machine_conflict" },
      },
      pendingCandidateCount: 1,
      pendingCandidates: [{
        candidateId: candidate.candidateId,
        reviewStatus: "ready",
        allowedDecisions: ["accepted", "rejected"],
        changes: [{ kind: "character_state", title: "易航 · 人物动态八项" }],
      }],
    });
    expect(dashboard.selectedChapter?.probe?.machineConflicts.map((entry) => entry.code)).toContain("state_commit_missing");
    expect(dashboard.pendingCandidates[0]!.changes[0]!.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "body", before: "疲惫", after: "通宵后明显疲惫", changed: true }),
      expect.objectContaining({ field: "known", changed: true }),
    ]));
    const serialized = JSON.stringify(dashboard);
    expect(serialized).not.toContain(shell.paths.root);
    expect(serialized).not.toContain("绝密后台身份");
    expect(serialized).not.toContain("canon-author-secret");
    expect(serialized).not.toContain("objectRelativePath");

    const state = dashboard.writingState!;
    const reviewed = await reviewNovelDesktopStateCandidate(shell.paths.root, {
      candidateId: candidate.candidateId,
      expectedCandidateFingerprint: candidate.fingerprint,
      expectedWritingStateRevision: state.revision,
      expectedWritingStateFingerprint: state.fingerprint,
      decision: "accepted",
      note: "桌面人工核对正文证据后接受",
    });
    expect(reviewed).toMatchObject({
      status: "succeeded",
      decision: { decision: "accepted", reviewer: "desktop-human-owner" },
      writingState: { currentThroughChapterId: chapter11.chapterId },
    });
    const refreshed = await getNovelDesktopWritingDashboard(shell.paths.root, {
      selectedChapterId: chapter11.chapterId,
      workflowMode: "formal",
    });
    expect(refreshed.selectedChapter?.completion).toMatchObject({ status: "committed", stateDebt: false });
    expect(refreshed.pendingCandidateCount).toBe(0);
    expect(refreshed.selectedChapter?.probe?.machineConflicts.map((entry) => entry.code)).not.toContain("state_commit_missing");
  });

  it("拒绝候选时只落人类裁决，不推进 Writing State，也不把候选留在待审列表", async () => {
    const { shell, chapter10, chapter11, candidate } = await fixture();
    const dashboard = await getNovelDesktopWritingDashboard(shell.paths.root, { selectedChapterId: chapter11.chapterId });
    const state = dashboard.writingState!;
    const reviewed = await reviewNovelDesktopStateCandidate(shell.paths.root, {
      candidateId: candidate.candidateId,
      expectedCandidateFingerprint: candidate.fingerprint,
      expectedWritingStateRevision: state.revision,
      expectedWritingStateFingerprint: state.fingerprint,
      decision: "rejected",
      note: "人物心理变化证据不足",
    });
    expect(reviewed).toMatchObject({
      decision: { decision: "rejected", reviewer: "desktop-human-owner" },
      writingState: { revision: state.revision, currentThroughChapterId: chapter10.chapterId },
    });
    const refreshed = await getNovelDesktopWritingDashboard(shell.paths.root, { selectedChapterId: chapter11.chapterId });
    expect(refreshed.pendingCandidateCount).toBe(0);
    expect(refreshed.selectedChapter?.completion).toMatchObject({ status: "missing", stateDebt: true });
  });
});
