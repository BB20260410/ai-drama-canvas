import { createHash } from "node:crypto";
import {
  NovelRepository,
  orderedNovelChapters,
  type NovelWorkspaceSnapshot,
} from "./novel-manuscript.js";
import type {
  NovelChapterRecord,
  NovelWritingWorkflowMode,
} from "./novel-types.js";
import {
  loadNovelWritingState,
  NovelWritingStateRejectedError,
  projectNovelWritingState,
} from "./novel-writing-state.js";

export type NovelConsistencyProbeFindingCode =
  | "baseline_not_locked"
  | "chapter_external_change"
  | "state_commit_missing"
  | "required_cast_missing"
  | "character_profile_missing"
  | "character_appearance_missing"
  | "hard_canon_forbidden_lexeme"
  | "voice_forbidden_phrase"
  | "appearance_contradiction_phrase"
  | "knowledge_boundary_candidate"
  | "undeclared_cast_candidate"
  | "body_state_transition_candidate"
  | "relationship_transition_without_update"
  | "timeline_transition_without_update"
  | "foreshadow_payoff_without_update"
  | "open_continuity_issue";

export interface NovelConsistencyProbeEvidenceSpan {
  chapterId: string;
  chapterRevision: number;
  chapterSha256: string;
  startOffset: number;
  endOffset: number;
  excerpt: string;
}

export interface NovelConsistencyProbeFinding {
  code: NovelConsistencyProbeFindingCode;
  severity: "P0" | "P1" | "P2";
  message: string;
  recordIds: string[];
  entityIds: string[];
  evidence: NovelConsistencyProbeEvidenceSpan[];
  nextAction: string;
}

export interface ProbeNovelChapterConsistencyInput {
  targetChapterId: string;
  workflowMode?: NovelWritingWorkflowMode;
}

export interface NovelChapterConsistencyProbe {
  schemaVersion: 1;
  kind: "novel-chapter-consistency-probe";
  status: "pass" | "review_required" | "machine_conflict";
  projectId: string;
  targetChapter: Pick<NovelChapterRecord, "chapterId" | "revision" | "sha256" | "byteLength" | "charCount">;
  workflowMode: NovelWritingWorkflowMode;
  writingState: {
    revision: number;
    fingerprint: string;
    baselineStatus: "provisional" | "locked";
    currentThroughChapterId: string;
  };
  requiredCharacterIds: string[];
  checks: Array<{
    check: string;
    status: "pass" | "machine_conflict" | "review_required";
    findingCodes: NovelConsistencyProbeFindingCode[];
  }>;
  machineConflicts: NovelConsistencyProbeFinding[];
  reviewRequired: NovelConsistencyProbeFinding[];
  nextTools: Array<{
    tool: string;
    argsMode: "partial";
    args: Record<string, unknown>;
    requiredArgs: string[];
    purpose: string;
    requiresHumanOwner?: boolean;
  }>;
  limitations: string[];
  fingerprint: string;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stable(entry)]));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function compact(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right, "en"));
}

function evidenceFor(
  chapter: NovelChapterRecord,
  content: string,
  startOffset: number,
  endOffset: number,
): NovelConsistencyProbeEvidenceSpan {
  const contextStart = Math.max(0, startOffset - 40);
  const contextEnd = Math.min(content.length, endOffset + 40);
  return {
    chapterId: chapter.chapterId,
    chapterRevision: chapter.revision,
    chapterSha256: chapter.sha256,
    startOffset,
    endOffset,
    excerpt: content.slice(contextStart, contextEnd),
  };
}

function firstEvidence(
  chapter: NovelChapterRecord,
  content: string,
  needle: string,
): NovelConsistencyProbeEvidenceSpan[] {
  const start = needle ? content.indexOf(needle) : -1;
  return start < 0 ? [] : [evidenceFor(chapter, content, start, start + needle.length)];
}

function forbiddenLexemes(text: string): string[] {
  const output: string[] = [];
  for (const match of text.matchAll(/(?:禁用词|禁止词|不得出现|禁止出现)\s*[：:]\s*([^。；;\n]+)/gu)) {
    output.push(...String(match[1] ?? "").split(/[，,、/|]/u));
  }
  for (const match of text.matchAll(/(?:不得出现|禁止使用|禁止写出)[“"]([^”"]+)[”"]/gu)) {
    output.push(String(match[1] ?? ""));
  }
  return compact(output.map((entry) => entry.trim()).filter((entry) => entry.length >= 1 && entry.length <= 200));
}

function allNames(entity: { name: string; aliases: string[] }): string[] {
  return compact([entity.name, ...entity.aliases].filter((entry) => entry.length >= 2));
}

function addFinding(
  target: NovelConsistencyProbeFinding[],
  finding: NovelConsistencyProbeFinding,
): void {
  const key = `${finding.code}:${finding.recordIds.join(",")}:${finding.entityIds.join(",")}:${finding.evidence[0]?.startOffset ?? -1}`;
  if (!target.some((entry) => `${entry.code}:${entry.recordIds.join(",")}:${entry.entityIds.join(",")}:${entry.evidence[0]?.startOffset ?? -1}` === key)) {
    target.push({
      ...finding,
      recordIds: compact(finding.recordIds),
      entityIds: compact(finding.entityIds),
    });
  }
}

function findingsFor(check: string, machine: NovelConsistencyProbeFinding[], review: NovelConsistencyProbeFinding[]) {
  const codeGroups: Record<string, NovelConsistencyProbeFindingCode[]> = {
    baseline: ["baseline_not_locked"],
    body_identity: ["chapter_external_change"],
    state_completion: ["state_commit_missing"],
    cast_and_profiles: ["required_cast_missing", "character_profile_missing", "character_appearance_missing", "undeclared_cast_candidate"],
    hard_canon_and_voice: ["hard_canon_forbidden_lexeme", "voice_forbidden_phrase"],
    appearance_authority: ["appearance_contradiction_phrase"],
    knowledge_boundary: ["knowledge_boundary_candidate"],
    body_state: ["body_state_transition_candidate"],
    relationship_lifecycle: ["relationship_transition_without_update"],
    timeline_lifecycle: ["timeline_transition_without_update"],
    foreshadow_lifecycle: ["foreshadow_payoff_without_update"],
    continuity_issues: ["open_continuity_issue"],
  };
  const group = codeGroups[check] ?? [];
  const machineCodes = compact(machine.filter((entry) => group.includes(entry.code)).map((entry) => entry.code)) as NovelConsistencyProbeFindingCode[];
  const reviewCodes = compact(review.filter((entry) => group.includes(entry.code)).map((entry) => entry.code)) as NovelConsistencyProbeFindingCode[];
  return {
    check,
    status: machineCodes.length ? "machine_conflict" as const : reviewCodes.length ? "review_required" as const : "pass" as const,
    findingCodes: [...machineCodes, ...reviewCodes],
  };
}

/**
 * 写后确定性探针。它只证明可机械检查的身份、状态提交、词面与生命周期候选，
 * 不把启发式命中冒充人物心理或文学质量裁决。
 */
export async function probeNovelChapterConsistencyCore(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
  input: ProbeNovelChapterConsistencyInput,
): Promise<NovelChapterConsistencyProbe> {
  if (!snapshot.chapters) throw new Error("一致性探针只支持 managed manuscript。");
  const ordered = orderedNovelChapters(snapshot.chapters);
  const targetIndex = ordered.findIndex((chapter) => chapter.chapterId === input.targetChapterId);
  if (targetIndex < 0) throw new Error(`目标章节不存在：${input.targetChapterId}`);
  const targetChapter = ordered[targetIndex]!;
  const workflowMode = input.workflowMode ?? "formal";
  const state = await loadNovelWritingState(projectRoot, snapshot.workspace.projectId);
  if (!state) {
    throw new NovelWritingStateRejectedError("一致性探针需要先初始化 Writing OS 状态。", {
      reason: "writing_state_missing",
      chapterId: input.targetChapterId,
      nextAction: "由 human owner 执行 novel_seed_writing_state",
    });
  }
  const repository = new NovelRepository(projectRoot);
  const read = await repository.readChapter(targetChapter.chapterId);
  if (read.status !== "healthy") {
    throw new NovelWritingStateRejectedError("目标章节正文已发生未纳管外部变化。", {
      reason: "content_conflict",
      chapterId: targetChapter.chapterId,
      expectedSha256: targetChapter.sha256,
      currentSha256: read.actual.sha256,
      nextAction: "先通过受管恢复或重新载入正文，再运行 probe",
    });
  }
  const content = read.content;
  const before = projectNovelWritingState(snapshot, state, {
    targetChapterId: targetChapter.chapterId,
    cutoff: "before",
  });
  const through = projectNovelWritingState(snapshot, state, {
    targetChapterId: targetChapter.chapterId,
    cutoff: "through",
  });
  const machineConflicts: NovelConsistencyProbeFinding[] = [];
  const reviewRequired: NovelConsistencyProbeFinding[] = [];
  const brief = before.temporal.chapterBrief;
  const requiredCharacterIds = [...(brief?.requiredCharacterIds ?? [])].sort((left, right) => left.localeCompare(right, "en"));

  if (workflowMode === "formal" && state.baselineStatus !== "locked") {
    addFinding(machineConflicts, {
      code: "baseline_not_locked",
      severity: "P0",
      message: "正式写后验收要求 baselineStatus=locked。",
      recordIds: [], entityIds: [], evidence: [],
      nextAction: "由正典 owner 锁定基线；否则明确标记 rehearsal，禁止同步正式正文",
    });
  }
  if (workflowMode === "formal" && (!brief || brief.requiredCharacterIds === undefined)) {
    addFinding(machineConflicts, {
      code: "required_cast_missing",
      severity: "P0",
      message: "目标章缺少受 owner 裁决的 required cast。",
      recordIds: brief ? [`chapter_brief:${brief.chapterId}`] : [], entityIds: [], evidence: [],
      nextAction: "提交 chapter_brief Story Bible 候选并由 owner 接受",
    });
  }
  const profileIds = new Set(before.temporal.characterProfiles.map((entry) => entry.entityId));
  const appearanceIds = new Set(before.temporal.characterAppearances.map((entry) => entry.entityId));
  for (const entityId of requiredCharacterIds) {
    if (workflowMode === "formal" && !profileIds.has(entityId)) {
      addFinding(machineConflicts, {
        code: "character_profile_missing",
        severity: "P0",
        message: "required cast 缺少结构化人物声口卡。",
        recordIds: [], entityIds: [entityId], evidence: [],
        nextAction: "提交 character_profile Story Bible 候选并由 owner 接受",
      });
    }
    if (workflowMode === "formal" && !appearanceIds.has(entityId)) {
      addFinding(machineConflicts, {
        code: "character_appearance_missing",
        severity: "P0",
        message: "required cast 缺少结构化人物外形卡。",
        recordIds: [], entityIds: [entityId], evidence: [],
        nextAction: "提交 character_appearance Story Bible 候选并由 owner 接受",
      });
    }
  }

  const completion = state.chapterCompletions.find((entry) => entry.chapterId === targetChapter.chapterId
    && entry.chapterRevision === targetChapter.revision
    && entry.chapterSha256 === targetChapter.sha256);
  if (!completion) {
    addFinding(machineConflicts, {
      code: "state_commit_missing",
      severity: "P0",
      message: "当前正文 revision/SHA 尚无 owner accepted 的章末状态提交。",
      recordIds: [], entityIds: requiredCharacterIds, evidence: [],
      nextAction: "stage 当前章状态候选（或显式 noStateChange）并由 human owner 接受",
    });
  }

  // writer-facing probe 与 Context Pack 使用同一可见性边界；author_only 规则
  // 不得通过 recordId、词面命中或证据侧信道泄漏给 Agent/renderer。
  for (const canon of state.hardCanon.filter((entry) => entry.visibility === "writer")) {
    for (const lexeme of forbiddenLexemes(canon.text)) {
      const evidence = firstEvidence(targetChapter, content, lexeme);
      if (!evidence.length) continue;
      addFinding(machineConflicts, {
        code: "hard_canon_forbidden_lexeme",
        severity: "P0",
        message: "正文命中硬正典声明的禁用词面。",
        recordIds: [`hard_canon:${canon.ruleId}`], entityIds: [], evidence,
        nextAction: "修改正文或由 human owner 裁决并版本化硬正典；不得由 writer 自行豁免",
      });
    }
  }
  for (const profile of before.temporal.characterProfiles.filter((entry) => requiredCharacterIds.includes(entry.entityId))) {
    for (const phrase of profile.forbiddenPhrases) {
      const evidence = firstEvidence(targetChapter, content, phrase);
      if (!evidence.length) continue;
      addFinding(machineConflicts, {
        code: "voice_forbidden_phrase",
        severity: "P1",
        message: "正文命中 required cast 声口卡中的禁语。",
        recordIds: [`character_profile:${profile.entityId}`], entityIds: [profile.entityId], evidence,
        nextAction: "修改对白/叙述，或提交可追溯的 profile 修订供 owner 裁决",
      });
    }
  }
  for (const appearance of before.temporal.characterAppearances.filter((entry) => requiredCharacterIds.includes(entry.entityId))) {
    for (const lock of appearance.locks) {
      for (const phrase of lock.contradictionPhrases) {
        const evidence = firstEvidence(targetChapter, content, phrase);
        if (!evidence.length) continue;
        addFinding(lock.enforcement === "block" ? machineConflicts : reviewRequired, {
          code: "appearance_contradiction_phrase",
          severity: lock.enforcement === "block" ? "P0" : "P1",
          message: `正文命中人物外形 Authority 的显式矛盾词面；锁定描述：${lock.canonicalDescription}`,
          recordIds: [`character_appearance:${appearance.entityId}:${lock.lockId}`],
          entityIds: [appearance.entityId],
          evidence,
          nextAction: lock.enforcement === "block"
            ? "修改正文，或提交可追溯的 appearance 修订供 owner 裁决"
            : "人工核对引述、梦境、伪装或时间变化；确认真实漂移则修改正文或版本化外形卡",
        });
      }
    }
  }

  const indices = new Map(ordered.map((chapter, index) => [chapter.chapterId, index]));
  for (const knowledge of state.knowledge) {
    const effectiveIndex = knowledge.effectiveFromChapterId === undefined
      ? undefined
      : indices.get(knowledge.effectiveFromChapterId);
    const unavailable = knowledge.status === "planned_later"
      || knowledge.status === "unknown"
      || knowledge.status === "forgotten"
      || (effectiveIndex !== undefined && effectiveIndex > targetIndex);
    if (!unavailable || knowledge.fact.length < 2) continue;
    const evidence = firstEvidence(targetChapter, content, knowledge.fact);
    if (!evidence.length) continue;
    addFinding(reviewRequired, {
      code: "knowledge_boundary_candidate",
      severity: "P1",
      message: "正文命中当前 cutoff 下不可知或未来知情记录；需人工判断是叙述、误信还是人物越界。",
      recordIds: [`knowledge:${knowledge.knowledgeId}`], entityIds: [knowledge.entityId], evidence,
      nextAction: "人工核对叙述视角与说话者；确认越界则改正文，合法披露则提交知情状态候选",
    });
  }

  const declared = new Set(requiredCharacterIds);
  for (const entity of before.temporal.entities) {
    if (declared.has(entity.entityId)) continue;
    const name = allNames(entity).find((candidate) => content.includes(candidate));
    if (!name) continue;
    addFinding(reviewRequired, {
      code: "undeclared_cast_candidate",
      severity: "P1",
      message: "正文疑似出现 chapter brief 未声明的角色。",
      recordIds: [`entity:${entity.entityId}`], entityIds: [entity.entityId],
      evidence: firstEvidence(targetChapter, content, name),
      nextAction: "人工确认是否同名词；若确为出场，修订 requiredCharacterIds 后重新 prepare/probe",
    });
  }

  const recoveryTerms = ["痊愈", "毫发无伤", "伤势全好", "行动自如"];
  for (const characterState of before.temporal.characterStates.filter((entry) => requiredCharacterIds.includes(entry.entityId))) {
    if (!/(重伤|骨折|昏迷|流血|受伤|虚弱|跛|断)/u.test(characterState.fields.body)) continue;
    const term = recoveryTerms.find((candidate) => content.includes(candidate));
    if (!term) continue;
    addFinding(reviewRequired, {
      code: "body_state_transition_candidate",
      severity: "P1",
      message: "正文出现疑似身体状态突变词面，需核对时间跨度、治疗证据与状态更新。",
      recordIds: [`character_state:${characterState.stateId}`], entityIds: [characterState.entityId],
      evidence: firstEvidence(targetChapter, content, term),
      nextAction: "人工核对恢复因果；必要时改正文或提交当前章 character_state 变更",
    });
  }

  const relationshipTerm = ["决裂", "反目", "背叛", "和解", "结盟", "分手"].find((candidate) => content.includes(candidate));
  if (relationshipTerm) {
    for (const relation of before.temporal.relationships) {
      const left = before.temporal.entities.find((entry) => entry.entityId === relation.fromEntityId);
      const right = before.temporal.entities.find((entry) => entry.entityId === relation.toEntityId);
      if (!left || !right || !allNames(left).some((name) => content.includes(name)) || !allNames(right).some((name) => content.includes(name))) continue;
      const updated = through.temporal.relationships.some((entry) => entry.relationshipId === relation.relationshipId
        && (entry.sourceChapter?.chapterId === targetChapter.chapterId || entry.throughChapterId === targetChapter.chapterId));
      if (updated) continue;
      addFinding(reviewRequired, {
        code: "relationship_transition_without_update",
        severity: "P1",
        message: "正文出现关系转折词面，但当前章未见对应关系状态更新。",
        recordIds: [`relationship:${relation.relationshipId}`], entityIds: [relation.fromEntityId, relation.toEntityId],
        evidence: firstEvidence(targetChapter, content, relationshipTerm),
        nextAction: "人工确认关系是否实质变化；若是，补 relationship delta 并重新接受状态候选",
      });
    }
  }

  const timeTerm = ["次日", "翌日", "三天后", "数日后", "一个月后", "多年后", "清晨", "午夜"].find((candidate) => content.includes(candidate));
  const timelineUpdated = through.temporal.timeline.some((entry) => entry.sourceChapter?.chapterId === targetChapter.chapterId
    || entry.startChapterId === targetChapter.chapterId
    || entry.endChapterId === targetChapter.chapterId
    || entry.disclosureChapterId === targetChapter.chapterId);
  if (timeTerm && !timelineUpdated) {
    addFinding(reviewRequired, {
      code: "timeline_transition_without_update",
      severity: "P1",
      message: "正文出现明确时间跃迁，但当前章未见时间线记录更新。",
      recordIds: [], entityIds: [], evidence: firstEvidence(targetChapter, content, timeTerm),
      nextAction: "人工核对日历；若确有推进，补 timeline delta 后重新接受状态候选",
    });
  }

  const payoffTerm = ["真相大白", "真相揭晓", "原来如此", "谜底", "揭开真相", "兑现"].find((candidate) => content.includes(candidate));
  if (payoffTerm) {
    for (const foreshadow of before.temporal.foreshadowing.filter((entry) => !["payoff", "abandoned"].includes(entry.status))) {
      const paid = through.temporal.foreshadowing.some((entry) => entry.foreshadowingId === foreshadow.foreshadowingId
        && entry.status === "payoff" && entry.payoffChapterId === targetChapter.chapterId);
      if (paid) continue;
      addFinding(reviewRequired, {
        code: "foreshadow_payoff_without_update",
        severity: "P1",
        message: "正文出现疑似揭晓/兑现词面，但活跃伏笔未记录本章 payoff。",
        recordIds: [`foreshadowing:${foreshadow.foreshadowingId}`], entityIds: [],
        evidence: firstEvidence(targetChapter, content, payoffTerm),
        nextAction: "人工确认是否真的收束该伏笔；若是，补 foreshadowing payoff delta",
      });
    }
  }

  for (const issue of through.temporal.continuityIssues.filter((entry) => entry.status === "open"
    && (entry.chapterIds.length === 0 || entry.chapterIds.includes(targetChapter.chapterId)))) {
    addFinding(reviewRequired, {
      code: "open_continuity_issue",
      severity: issue.severity,
      message: "目标章仍命中 owner 登记的开放连续性问题。",
      recordIds: [`continuity_issue:${issue.issueId}`], entityIds: issue.entityIds, evidence: [],
      nextAction: "人工复核 issue.evidence；解决、豁免或保留均须走 Story Bible 版本化裁决",
    });
  }

  machineConflicts.sort((left, right) => left.code.localeCompare(right.code, "en") || (left.evidence[0]?.startOffset ?? -1) - (right.evidence[0]?.startOffset ?? -1));
  reviewRequired.sort((left, right) => left.code.localeCompare(right.code, "en") || (left.evidence[0]?.startOffset ?? -1) - (right.evidence[0]?.startOffset ?? -1));
  const checkNames = [
    "baseline",
    "body_identity",
    "state_completion",
    "cast_and_profiles",
    "hard_canon_and_voice",
    "appearance_authority",
    "knowledge_boundary",
    "body_state",
    "relationship_lifecycle",
    "timeline_lifecycle",
    "foreshadow_lifecycle",
    "continuity_issues",
  ];
  const semantic = {
    schemaVersion: 1 as const,
    kind: "novel-chapter-consistency-probe" as const,
    status: machineConflicts.length ? "machine_conflict" as const : reviewRequired.length ? "review_required" as const : "pass" as const,
    projectId: snapshot.workspace.projectId,
    targetChapter: {
      chapterId: targetChapter.chapterId,
      revision: targetChapter.revision,
      sha256: targetChapter.sha256,
      byteLength: targetChapter.byteLength,
      charCount: targetChapter.charCount,
    },
    workflowMode,
    writingState: {
      revision: state.revision,
      fingerprint: state.fingerprint,
      baselineStatus: state.baselineStatus,
      currentThroughChapterId: state.currentThroughChapterId,
    },
    requiredCharacterIds,
    checks: checkNames.map((check) => findingsFor(check, machineConflicts, reviewRequired)),
    machineConflicts,
    reviewRequired,
    nextTools: machineConflicts.some((entry) => entry.code === "state_commit_missing")
      ? [{
        tool: "execute_command",
        argsMode: "partial" as const,
        args: { request: { command: "novel_stage_chapter_state_candidate", payload: { chapterId: targetChapter.chapterId } } },
        requiredArgs: ["projectRoot", "requestId", "idempotencyKey", "request.payload"],
        purpose: "提交带完整证据与五类审计范围的当前章状态候选",
      }]
      : machineConflicts.length || reviewRequired.length
        ? [{
          tool: "execute_command",
          argsMode: "partial" as const,
          args: { request: { command: "novel_attach_review_ticket", payload: { chapterId: targetChapter.chapterId } } },
          requiredArgs: ["projectRoot", "requestId", "idempotencyKey", "request.payload"],
          purpose: "把未消除的探针命中附着为可追溯人工审稿单",
          requiresHumanOwner: true,
        }]
        : [],
    limitations: [
      "精确词面命中只能证明可能冲突，不能自动理解反讽、引述、梦境或叙述视角。",
      "探针不证明人物魅力、心理真实、节奏、文风或文学质量；这些仍需人工或独立审稿模型。",
      "无命中只表示本版本机械规则未发现问题，不等于人物绝对一致。",
    ],
  };
  return { ...semantic, fingerprint: fingerprint(semantic) };
}
