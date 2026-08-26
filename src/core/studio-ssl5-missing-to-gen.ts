/**
 * SSL-5 · 缺图 → earliest/生图下一步（只读计划）
 *
 * 从 script-media-align / missing-media 投影出「应对哪一 unit 走 freeze 链」；
 * 不自动 dispatch、不抢写租约。
 */
import {
  formatAlignCheckpointLine,
  getStudioScriptMediaAlignBoard,
  type AlignCheckpointGate,
  type AlignConsistencyPeek,
  type ScriptMediaAlignBoard,
  type ScriptMediaAlignRow,
} from "./studio-script-media-align.js";
import {
  formatPanelBeatLine,
  formatPanelLightingCostumeLine,
  formatPanelShotTypeLine,
  formatPanelStandingGaps,
  formatStyleLockLine,
  formatUnitBeatLine,
  formatCharacterBackReferenceLineFromBoard,
  formatPropBackReferenceLineFromBoard,
  formatSceneBackReferenceLineFromBoard,
  listCharacterAssetMentions,
  listCharacterBackReferences,
  listPropAssetMentions,
  listPropBackReferences,
  listSceneAssetMentions,
  listSceneBackReferences,
  pickFirstMissingPanel,
} from "./studio-script-library-projection.js";
import {
  formatWizardLockPreviousCostumeLine,
  formatWizardLockPreviousLightingLine,
  wizardPreviousCostumeForPanel,
  wizardPreviousLightingForPanel,
} from "./studio-panel-standing.js";
import type { CharacterBackReference, PropBackReference, SceneBackReference } from "./studio-scene-backrefs.js";
import {
  composeSsl5GenerationPlanDraft,
  unitGridNextActionBlockingKind,
  type PersistedPlanNodeStatus,
  type Ssl5GenerationPlanDraft,
} from "./studio-generation-plan-draft.js";
import {
  generationLedgerSidecarPath,
  readPersistedPanelPlanState,
} from "./studio-unit-grid-persisted-plan-read.js";

export const SSL5_PLAN_SCHEMA_VERSION = 1 as const;
export {
  composeSsl5GenerationPlanDraft,
  composeStudioGenerationPlanDraft,
  SSL5_GENERATION_PLAN_COMMAND,
  STUDIO_GENERATION_PLAN_COMMAND,
  type Ssl5GenerationPlanDraft,
  type Ssl5GenerationPlanDraftNode,
  type StudioGenerationPlanDraft,
  type StudioGenerationPlanDraftNode,
} from "./studio-generation-plan-draft.js";

export interface Ssl5MissingToGenPlanItem {
  unitId: string;
  sequence: number;
  title: string;
  status: ScriptMediaAlignRow["status"];
  priority: "earliest" | "missing-all" | "partial" | "covered";
  recommendedPath: string[];
  packId: string | null;
  /** 焦点缺图宫格自己的冻结包；不是同行已出图 preview pack。 */
  focusPackId: string | null;
  generationPlanDraft: Ssl5GenerationPlanDraft;
  generationRunId: string | null;
  focusPanelId: string | null;
  focusPanelIndex: number | null;
  previousPanelIndex: number | null;
  previousShotComposition: string | null;
  previousVisualAction: string | null;
  previousFilmingMethod: string | null;
  standingGapLine: string;
  lightingCostumeLine: string;
  previousLightingLine: string | null;
  previousCostumeLine: string | null;
  shotType?: "original" | "extension";
  shotTypeLine: string;
  styleLockLine: string;
  beatLine: string;
  unitBeatLine: string;
  sceneBackReferenceLine: string;
  sceneBackReferences: SceneBackReference[];
  propBackReferenceLine: string;
  propBackReferences: PropBackReference[];
  characterBackReferenceLine: string;
  characterBackReferences: CharacterBackReference[];
  /** 复用对照板焦点格/行已有 peek。零额外评估。未评估 ≠ 无法检查。 */
  consistencyPeek: AlignConsistencyPeek;
}

export interface Ssl5MissingToGenPlan {
  schemaVersion: typeof SSL5_PLAN_SCHEMA_VERSION;
  kind: "studio-ssl5-missing-to-gen-plan";
  projectRoot: string;
  season: string;
  episode: string;
  earliestUnitId: string | null;
  earliestCode: string | null;
  earliestLabel: string | null;
  earliestStatusLine: string | null;
  earliestReason: string | null;
  checkpoint: AlignCheckpointGate | null;
  checkpointLine: string;
  focusUnitId: string | null;
  focusPanelId: string | null;
  focusPanelIndex: number | null;
  /** 焦点缺图宫格自己的冻结包；不是同行已出图 preview pack。 */
  focusPackId: string | null;
  generationPlanDraft: Ssl5GenerationPlanDraft;
  previousPanelIndex: number | null;
  previousShotComposition: string | null;
  previousVisualAction: string | null;
  previousFilmingMethod: string | null;
  standingGapLine: string;
  lightingCostumeLine: string;
  previousLightingLine: string | null;
  previousCostumeLine: string | null;
  shotType?: "original" | "extension";
  shotTypeLine: string;
  styleLockLine: string;
  beatLine: string;
  unitBeatLine: string;
  sceneBackReferenceLine: string;
  sceneBackReferences: SceneBackReference[];
  propBackReferenceLine: string;
  propBackReferences: PropBackReference[];
  characterBackReferenceLine: string;
  characterBackReferences: CharacterBackReference[];
  /** 复用对照板焦点格/行已有 peek。零额外评估。未评估 ≠ 无法检查。 */
  consistencyPeek: AlignConsistencyPeek;
  missingAllCount: number;
  partialCount: number;
  items: Ssl5MissingToGenPlanItem[];
  builtAt: string;
}

const SSL5_RECOMMENDED_PATH = [
  "binding-ready?",
  "readiness",
  "freeze",
  "create-plan",
  "dispatch",
  "prepare",
  "gen",
  "commit",
  "review",
] as const;

function reuseBoardConsistencyPeek(
  missingPanel: ScriptMediaAlignRow["panels"][number] | undefined,
  row: ScriptMediaAlignRow,
): AlignConsistencyPeek {
  if (missingPanel) return missingPanel.consistencyPeek ?? { status: "unevaluated" };
  return row.consistencyPeek ?? { status: "unevaluated" };
}

export function buildSsl5PlanFromBoard(
  projectRoot: string,
  query: { season: string; episode: string },
  board: Pick<ScriptMediaAlignBoard, "rows" | "earliestUnitId" | "missingAllCount" | "partialCount"> & {
    earliestCode?: string | null;
    earliestLabel?: string | null;
    earliestStatusLine?: string | null;
    earliestReason?: string | null;
    checkpoint?: AlignCheckpointGate | null;
    checkpointLine?: string | null;
  },
  builtAt = new Date().toISOString(),
): Ssl5MissingToGenPlan {
  const items: Ssl5MissingToGenPlanItem[] = board.rows
    .filter((row) => row.status !== "covered" || row.unitId === board.earliestUnitId)
    .map((row) => {
      let priority: Ssl5MissingToGenPlanItem["priority"] = "covered";
      if (row.unitId === board.earliestUnitId) priority = "earliest";
      else if (row.status === "missing-all") priority = "missing-all";
      else if (row.status === "partial") priority = "partial";
      const missingPanel = pickFirstMissingPanel(row.panels ?? []);
      const handoff = missingPanel?.previousHandoff ?? null;
      const sceneMentions = listSceneAssetMentions(missingPanel?.assetMentions);
      const sceneBackReferences = missingPanel
        ? listSceneBackReferences({
            currentUnitId: row.unitId,
            currentSequence: row.sequence,
            currentPanelIndex: missingPanel.panelIndex,
            currentPanelId: missingPanel.panelId,
            sceneMentions,
            units: board.rows,
          })
        : [];
      const propMentions = listPropAssetMentions(missingPanel?.assetMentions);
      const propBackReferences = missingPanel
        ? listPropBackReferences({
            currentUnitId: row.unitId,
            currentSequence: row.sequence,
            currentPanelIndex: missingPanel.panelIndex,
            currentPanelId: missingPanel.panelId,
            propMentions,
            units: board.rows,
          })
        : [];
      const characterMentions = listCharacterAssetMentions(missingPanel?.assetMentions);
      const characterBackReferences = missingPanel
        ? listCharacterBackReferences({
            currentUnitId: row.unitId,
            currentSequence: row.sequence,
            currentPanelIndex: missingPanel.panelIndex,
            currentPanelId: missingPanel.panelId,
            characterMentions,
            units: board.rows,
          })
        : [];
      const previousLighting = missingPanel
        ? wizardPreviousLightingForPanel(row.panels ?? [], missingPanel.panelIndex)
        : null;
      const previousCostume = missingPanel
        ? wizardPreviousCostumeForPanel(row.panels ?? [], missingPanel.panelIndex)
        : null;
      const focusPanelId = missingPanel?.panelId ?? null;
      const focusPackId = missingPanel?.packId ?? null;
      return {
        unitId: row.unitId,
        sequence: row.sequence,
        title: row.title,
        status: row.status,
        priority,
        recommendedPath: [...SSL5_RECOMMENDED_PATH],
        packId: row.packId,
        focusPackId,
        generationPlanDraft: composeSsl5GenerationPlanDraft({
          focusUnitId: row.unitId,
          focusPanelId,
          focusPackId,
        }),
        generationRunId: row.generationRunId,
        focusPanelId,
        focusPanelIndex: missingPanel?.panelIndex ?? null,
        previousPanelIndex: handoff?.panelIndex ?? null,
        previousShotComposition: handoff?.shotComposition ?? null,
        previousVisualAction: handoff?.visualAction ?? null,
        previousFilmingMethod: handoff?.filmingMethod ?? null,
        standingGapLine: formatPanelStandingGaps(missingPanel ?? null),
        lightingCostumeLine: formatPanelLightingCostumeLine(missingPanel ?? null),
        previousLightingLine: formatWizardLockPreviousLightingLine(previousLighting),
        previousCostumeLine: formatWizardLockPreviousCostumeLine(previousCostume),
        shotType: missingPanel?.shotType === "extension" || missingPanel?.shotType === "original"
          ? missingPanel.shotType
          : undefined,
        shotTypeLine: formatPanelShotTypeLine(missingPanel ?? null),
        styleLockLine: formatStyleLockLine(missingPanel?.assetMentions ?? null),
        beatLine: formatPanelBeatLine(missingPanel ?? null),
        unitBeatLine: formatUnitBeatLine(row.panels ?? []),
        sceneBackReferenceLine: missingPanel
          ? formatSceneBackReferenceLineFromBoard({
              currentUnitId: row.unitId,
              currentSequence: row.sequence,
              currentPanelIndex: missingPanel.panelIndex,
              currentPanelId: missingPanel.panelId,
              currentMentions: missingPanel.assetMentions,
              units: board.rows,
            })
          : "没有宫格可查场景回指",
        sceneBackReferences,
        propBackReferenceLine: missingPanel
          ? formatPropBackReferenceLineFromBoard({
              currentUnitId: row.unitId,
              currentSequence: row.sequence,
              currentPanelIndex: missingPanel.panelIndex,
              currentPanelId: missingPanel.panelId,
              currentMentions: missingPanel.assetMentions,
              units: board.rows,
            })
          : "没有宫格可查道具回指",
        propBackReferences,
        characterBackReferenceLine: missingPanel
          ? formatCharacterBackReferenceLineFromBoard({
              currentUnitId: row.unitId,
              currentSequence: row.sequence,
              currentPanelIndex: missingPanel.panelIndex,
              currentPanelId: missingPanel.panelId,
              currentMentions: missingPanel.assetMentions,
              units: board.rows,
            })
          : "没有宫格可查角色回指",
        characterBackReferences,
        consistencyPeek: reuseBoardConsistencyPeek(missingPanel, row),
      };
    })
    .sort((left, right) => {
      const rank = { earliest: 0, "missing-all": 1, partial: 2, covered: 3 } as const;
      return rank[left.priority] - rank[right.priority] || left.sequence - right.sequence;
    });

  const focus =
    items.find((item) => item.priority === "earliest")
    ?? items.find((item) => item.priority === "missing-all")
    ?? items.find((item) => item.priority === "partial")
    ?? null;

  const plan: Ssl5MissingToGenPlan = {
    schemaVersion: SSL5_PLAN_SCHEMA_VERSION,
    kind: "studio-ssl5-missing-to-gen-plan",
    projectRoot,
    season: query.season,
    episode: query.episode,
    earliestUnitId: board.earliestUnitId,
    earliestCode: board.earliestCode ?? null,
    earliestLabel: board.earliestLabel ?? null,
    earliestStatusLine: board.earliestStatusLine ?? null,
    earliestReason: board.earliestReason ?? null,
    checkpoint: board.checkpoint ?? null,
    checkpointLine: board.checkpointLine ?? formatAlignCheckpointLine(board.checkpoint ?? null),
    focusUnitId: focus?.unitId ?? null,
    focusPanelId: focus?.focusPanelId ?? null,
    focusPanelIndex: focus?.focusPanelIndex ?? null,
    focusPackId: focus?.focusPackId ?? null,
    generationPlanDraft: composeSsl5GenerationPlanDraft({
      focusUnitId: focus?.unitId ?? null,
      focusPanelId: focus?.focusPanelId ?? null,
      focusPackId: focus?.focusPackId ?? null,
    }),
    previousPanelIndex: focus?.previousPanelIndex ?? null,
    previousShotComposition: focus?.previousShotComposition ?? null,
    previousVisualAction: focus?.previousVisualAction ?? null,
    previousFilmingMethod: focus?.previousFilmingMethod ?? null,
    standingGapLine: focus?.standingGapLine ?? "没有宫格可查站位缺口",
    lightingCostumeLine: focus?.lightingCostumeLine ?? "没有宫格可查光线/服化",
    previousLightingLine: focus?.previousLightingLine ?? null,
    previousCostumeLine: focus?.previousCostumeLine ?? null,
    shotType: focus?.shotType,
    shotTypeLine: focus?.shotTypeLine ?? "没有宫格可查镜头类型",
    styleLockLine: focus?.styleLockLine ?? "没有宫格可查风格锁",
    beatLine: focus?.beatLine ?? "没有宫格可查 15s 节拍",
    unitBeatLine: focus?.unitBeatLine ?? "没有宫格可查 15s 节拍",
    sceneBackReferenceLine: focus?.sceneBackReferenceLine ?? "没有宫格可查场景回指",
    sceneBackReferences: focus?.sceneBackReferences ?? [],
    propBackReferenceLine: focus?.propBackReferenceLine ?? "没有宫格可查道具回指",
    propBackReferences: focus?.propBackReferences ?? [],
    characterBackReferenceLine: focus?.characterBackReferenceLine ?? "没有宫格可查角色回指",
    characterBackReferences: focus?.characterBackReferences ?? [],
    consistencyPeek: focus?.consistencyPeek ?? { status: "unevaluated" },
    missingAllCount: board.missingAllCount,
    partialCount: board.partialCount,
    items,
    builtAt,
  };
  return refineSsl5FocusIfCheckpointBlocking(refineSsl5FocusIfEarliestBlocking(plan));
}

export function earliestBlockingPath(
  earliestCode: string | null | undefined,
): "wait" | "retry" | "review" | "reconcile" | null {
  return unitGridNextActionBlockingKind(earliestCode);
}

/**
 * 焦点就是 earliest 且整板下一步是 wait/retry/Review/对账时，
 * 禁止再建议 create-plan / dispatch。只精炼焦点；不执行、不派发。
 */
export function refineSsl5FocusIfEarliestBlocking(plan: Ssl5MissingToGenPlan): Ssl5MissingToGenPlan {
  const kind = earliestBlockingPath(plan.earliestCode);
  if (!kind || !plan.focusUnitId || plan.focusUnitId !== plan.earliestUnitId) return plan;
  const recommendedPath = [kind === "reconcile" ? "wait" : kind];
  const blockedReason = plan.earliestLabel
    || (kind === "wait"
      ? "earliest 计划节点进行中，等待结果或对账（不派发）"
      : kind === "retry"
        ? "earliest 计划节点已失败/已取消，下一步是 retry（不重试、不派发）"
        : kind === "review"
          ? "earliest 计划节点已有结果，下一步是 Review（不派发）"
          : "earliest 未知生图 call，先对账（禁止重派）");
  const draft = {
    ...plan.generationPlanDraft,
    ready: false,
    dispatch: false as const,
    blockedReason,
    note: "earliest 已占用下一步。不执行、不派发、不重试。",
  };
  return {
    ...plan,
    generationPlanDraft: draft,
    items: plan.items.map((item) => (
      item.unitId === plan.focusUnitId && item.focusPanelId === plan.focusPanelId
        ? { ...item, generationPlanDraft: draft, recommendedPath }
        : item
    )),
  };
}

/**
 * 对照板已投影六图闸且未放行新槽时，禁止再建议 create-plan / dispatch。
 * 复用已加载 board.checkpoint，不二次读闸。earliest wait/retry/Review 文案更具体时保留。
 * 不执行停检、不派发。
 */
export function refineSsl5FocusIfCheckpointBlocking(plan: Ssl5MissingToGenPlan): Ssl5MissingToGenPlan {
  if (plan.checkpoint?.newSlotDispatchAllowed !== false) return plan;
  if (earliestBlockingPath(plan.earliestCode)) return plan;
  const blockedReason = plan.checkpointLine
    || formatAlignCheckpointLine(plan.checkpoint);
  const draft = {
    ...plan.generationPlanDraft,
    ready: false,
    dispatch: false as const,
    blockedReason,
    note: "六图闸已占用下一步。不执行、不派发。",
  };
  return {
    ...plan,
    generationPlanDraft: draft,
    items: plan.items.map((item) => ({
      ...item,
      generationPlanDraft: draft,
      recommendedPath: ["wait"],
    })),
  };
}

export type Ssl5PersistedPlanHint = boolean | {
  hasPlan: boolean;
  status?: PersistedPlanNodeStatus;
};

function normalizeSsl5PersistedPlanHint(hint: Ssl5PersistedPlanHint): {
  hasPlan: boolean;
  status?: PersistedPlanNodeStatus;
} {
  return typeof hint === "boolean" ? { hasPlan: hint } : hint;
}

function recommendedPathForPersistedPlanStatus(status?: PersistedPlanNodeStatus): string[] {
  if (status === "dispatched") return ["wait"];
  if (status === "failed" || status === "cancelled") return ["retry"];
  if (status === "succeeded") return ["review"];
  return ["dispatch", "prepare", "gen", "commit", "review"];
}

/**
 * 焦点缺图格已有单镜计划时，草稿不再 ready 建计划。
 * 只精炼焦点（及同格 item）；不扫其它行、不执行、不派发。
 * 未传 status 时下一步仍写 dispatch（兼容只传 boolean）。
 */
export function refineSsl5FocusPlanDraftIfPersisted(
  plan: Ssl5MissingToGenPlan,
  persisted: Ssl5PersistedPlanHint,
): Ssl5MissingToGenPlan {
  const hint = normalizeSsl5PersistedPlanHint(persisted);
  if (!hint.hasPlan || !plan.focusUnitId || !plan.focusPanelId || !plan.focusPackId) {
    return plan;
  }
  const draft = composeSsl5GenerationPlanDraft({
    focusUnitId: plan.focusUnitId,
    focusPanelId: plan.focusPanelId,
    focusPackId: plan.focusPackId,
    hasPersistedPlan: true,
    persistedPlanStatus: hint.status,
  });
  const recommendedPath = recommendedPathForPersistedPlanStatus(hint.status);
  return {
    ...plan,
    generationPlanDraft: draft,
    items: plan.items.map((item) => (
      item.unitId === plan.focusUnitId && item.focusPanelId === plan.focusPanelId
        ? { ...item, generationPlanDraft: draft, recommendedPath }
        : item
    )),
  };
}

export async function planSsl5MissingToGen(
  projectRoot: string,
  query: { season: string; episode: string; evidenceDir?: string; documentId?: string },
): Promise<Ssl5MissingToGenPlan> {
  const board = await getStudioScriptMediaAlignBoard(projectRoot, {
    season: query.season,
    episode: query.episode,
    ...(query.documentId ? { documentId: query.documentId } : {}),
    ...(query.evidenceDir ? { evidenceDir: query.evidenceDir } : {}),
  });
  // earliest 已由 align-board 算过；禁止二次 getStudioEpisodeEarliest。
  const plan = buildSsl5PlanFromBoard(projectRoot, query, board);
  if (!plan.focusUnitId || !plan.focusPanelId || !plan.focusPackId) return plan;
  const persisted = readPersistedPanelPlanState(
    generationLedgerSidecarPath(projectRoot),
    plan.focusUnitId,
    plan.focusPanelId,
  );
  return refineSsl5FocusIfCheckpointBlocking(refineSsl5FocusIfEarliestBlocking(refineSsl5FocusPlanDraftIfPersisted(plan, {
    hasPlan: persisted.hasPlan,
    status: persisted.status ?? undefined,
  })));
}
