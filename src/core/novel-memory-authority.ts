import { withAdaptation } from "./adaptation-lazy.js";
import type { NovelWorkspaceSnapshot } from "./novel-manuscript.js";
import {
  loadNovelWritingState,
  projectNovelWritingState,
} from "./novel-writing-state.js";

export const NOVEL_MEMORY_AUTHORITY = "writing_os_story_bible" as const;

export type NovelMemoryProjectionKind =
  | "entity"
  | "hard_canon"
  | "character_state"
  | "knowledge"
  | "relationship"
  | "timeline"
  | "foreshadowing"
  | "character_profile"
  | "character_appearance"
  | "continuity_issue"
  | "chapter_brief";

export interface NovelMemoryProjectionItem {
  schemaVersion: 1;
  authority: typeof NOVEL_MEMORY_AUTHORITY;
  id: string;
  kind: NovelMemoryProjectionKind;
  statement: string;
  entityIds: string[];
  chapterIds: string[];
  sourceIds: string[];
  revision: number;
  updatedAt: string;
}

export interface NovelMemoryAuthorityProjection {
  schemaVersion: 1;
  authority: typeof NOVEL_MEMORY_AUTHORITY;
  writableVia: "novel_stage_story_bible_candidate_then_owner_review";
  targetChapterId: string | null;
  cutoff: "through";
  writingState: null | {
    revision: number;
    fingerprint: string;
    baselineStatus: "provisional" | "locked";
    currentThroughChapterId: string;
  };
  legacyAdaptation: {
    status: "read_only_excluded_from_writing_context";
    factCount: number;
  };
  items: NovelMemoryProjectionItem[];
}

function compact(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right, "en"));
}

function item(
  stateUpdatedAt: string,
  value: Omit<NovelMemoryProjectionItem, "schemaVersion" | "authority" | "updatedAt">,
): NovelMemoryProjectionItem {
  return {
    schemaVersion: 1,
    authority: NOVEL_MEMORY_AUTHORITY,
    ...value,
    entityIds: compact(value.entityIds),
    chapterIds: compact(value.chapterIds),
    sourceIds: compact(value.sourceIds),
    updatedAt: stateUpdatedAt,
  };
}

/**
 * Managed novel/hybrid 的唯一桌面记忆投影。
 *
 * adaptation.json 仅统计为 legacy read-only 数据，绝不与 Writing OS 正典合并，
 * 从而避免同一事实拥有两个可独立写入的真相。所有正式变更必须走
 * Story Bible candidate -> human owner review。
 */
export async function getNovelMemoryAuthorityProjection(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
): Promise<NovelMemoryAuthorityProjection> {
  const [state, legacy] = await Promise.all([
    loadNovelWritingState(projectRoot, snapshot.workspace.projectId),
    withAdaptation((adaptation) => adaptation.loadAdaptationStore(projectRoot)),
  ]);
  if (!state) {
    return {
      schemaVersion: 1,
      authority: NOVEL_MEMORY_AUTHORITY,
      writableVia: "novel_stage_story_bible_candidate_then_owner_review",
      targetChapterId: null,
      cutoff: "through",
      writingState: null,
      legacyAdaptation: {
        status: "read_only_excluded_from_writing_context",
        factCount: legacy.facts.length,
      },
      items: [],
    };
  }

  const projection = projectNovelWritingState(snapshot, state, {
    targetChapterId: state.currentThroughChapterId,
    cutoff: "through",
  });
  const temporal = projection.temporal;
  const entityNames = new Map(temporal.entities.map((entry) => [entry.entityId, entry.name]));
  const nameOf = (entityId: string): string => entityNames.get(entityId) ?? entityId;
  const items: NovelMemoryProjectionItem[] = [];

  for (const entry of temporal.entities) {
    items.push(item(state.updatedAt, {
      id: `entity:${entry.entityId}`,
      kind: "entity",
      statement: `${entry.name}：${entry.baseSummary}`,
      entityIds: [entry.entityId],
      chapterIds: entry.effectiveFromChapterId ? [entry.effectiveFromChapterId] : [],
      sourceIds: entry.sourceIds,
      revision: entry.revision,
    }));
  }
  for (const entry of temporal.hardCanon) {
    items.push(item(state.updatedAt, {
      id: `hard_canon:${entry.ruleId}`,
      kind: "hard_canon",
      statement: entry.text,
      entityIds: [],
      chapterIds: entry.effectiveFromChapterId ? [entry.effectiveFromChapterId] : [],
      sourceIds: entry.sourceIds,
      revision: entry.revision,
    }));
  }
  for (const entry of temporal.characterStates) {
    const fields = entry.fields;
    items.push(item(state.updatedAt, {
      id: `character_state:${entry.entityId}`,
      kind: "character_state",
      statement: `${nameOf(entry.entityId)}：身体=${fields.body}；情绪=${fields.emotion}；目标=${fields.goals.join("、") || "无"}；未决=${fields.unresolved.join("、") || "无"}`,
      entityIds: [entry.entityId],
      chapterIds: [entry.throughChapterId],
      sourceIds: entry.sourceIds,
      revision: entry.revision,
    }));
  }
  for (const entry of temporal.knowledge) {
    items.push(item(state.updatedAt, {
      id: `knowledge:${entry.knowledgeId}`,
      kind: "knowledge",
      statement: `${nameOf(entry.entityId)}：${entry.fact}（${entry.status}）`,
      entityIds: [entry.entityId],
      chapterIds: compact([entry.effectiveFromChapterId ?? "", entry.effectiveUntilChapterId ?? ""]),
      sourceIds: entry.sourceIds,
      revision: entry.revision,
    }));
  }
  for (const entry of temporal.relationships) {
    items.push(item(state.updatedAt, {
      id: `relationship:${entry.relationshipId}`,
      kind: "relationship",
      statement: `${nameOf(entry.fromEntityId)} → ${nameOf(entry.toEntityId)}：${entry.relation}；${entry.state}`,
      entityIds: [entry.fromEntityId, entry.toEntityId],
      chapterIds: [entry.throughChapterId],
      sourceIds: entry.sourceIds,
      revision: entry.revision,
    }));
  }
  for (const entry of temporal.timeline) {
    items.push(item(state.updatedAt, {
      id: `timeline:${entry.timelineId}`,
      kind: "timeline",
      statement: `${entry.storyTime}：${entry.summary}`,
      entityIds: [],
      chapterIds: compact([entry.startChapterId ?? "", entry.endChapterId ?? "", entry.disclosureChapterId ?? ""]),
      sourceIds: entry.sourceIds,
      revision: entry.revision,
    }));
  }
  for (const entry of temporal.foreshadowing) {
    items.push(item(state.updatedAt, {
      id: `foreshadowing:${entry.foreshadowingId}`,
      kind: "foreshadowing",
      statement: `${entry.summary}（${entry.status}）`,
      entityIds: [],
      chapterIds: compact([entry.setupChapterId ?? "", ...entry.maintenanceChapterIds, entry.payoffChapterId ?? ""]),
      sourceIds: entry.sourceIds,
      revision: entry.revision,
    }));
  }
  for (const entry of temporal.characterProfiles) {
    items.push(item(state.updatedAt, {
      id: `character_profile:${entry.entityId}`,
      kind: "character_profile",
      statement: `${nameOf(entry.entityId)}声口：欲望=${entry.coreDesire}；恐惧=${entry.coreFear}；底线=${entry.boundaries.join("、") || "未声明"}`,
      entityIds: [entry.entityId, ...entry.relationshipVoices.map((voice) => voice.targetEntityId)],
      chapterIds: entry.effectiveFromChapterId ? [entry.effectiveFromChapterId] : [],
      sourceIds: entry.sourceIds,
      revision: entry.revision,
    }));
  }
  for (const entry of temporal.characterAppearances) {
    items.push(item(state.updatedAt, {
      id: `character_appearance:${entry.entityId}`,
      kind: "character_appearance",
      statement: `${nameOf(entry.entityId)}外形：${entry.summary}；锁定=${entry.locks.map((lock) => lock.canonicalDescription).join("、")}`,
      entityIds: [entry.entityId],
      chapterIds: entry.effectiveFromChapterId ? [entry.effectiveFromChapterId] : [],
      sourceIds: entry.sourceIds,
      revision: entry.revision,
    }));
  }
  for (const entry of temporal.continuityIssues) {
    items.push(item(state.updatedAt, {
      id: `continuity_issue:${entry.issueId}`,
      kind: "continuity_issue",
      statement: `[${entry.severity}/${entry.status}] ${entry.summary}`,
      entityIds: entry.entityIds,
      chapterIds: entry.chapterIds,
      sourceIds: entry.sourceIds,
      revision: entry.revision,
    }));
  }
  if (temporal.chapterBrief) {
    const entry = temporal.chapterBrief;
    items.push(item(state.updatedAt, {
      id: `chapter_brief:${entry.chapterId}`,
      kind: "chapter_brief",
      statement: entry.summary,
      entityIds: entry.requiredCharacterIds ?? [],
      chapterIds: [entry.chapterId],
      sourceIds: entry.sourceIds,
      revision: entry.revision,
    }));
  }

  return {
    schemaVersion: 1,
    authority: NOVEL_MEMORY_AUTHORITY,
    writableVia: "novel_stage_story_bible_candidate_then_owner_review",
    targetChapterId: state.currentThroughChapterId,
    cutoff: "through",
    writingState: {
      revision: state.revision,
      fingerprint: state.fingerprint,
      baselineStatus: state.baselineStatus,
      currentThroughChapterId: state.currentThroughChapterId,
    },
    legacyAdaptation: {
      status: "read_only_excluded_from_writing_context",
      factCount: legacy.facts.length,
    },
    items: items.sort((left, right) => left.kind.localeCompare(right.kind, "en") || left.id.localeCompare(right.id, "en")),
  };
}
