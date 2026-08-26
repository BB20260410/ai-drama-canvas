/**
 * SSL-5 · 缺图 → earliest/生图下一步（只读计划）
 *
 * 从 script-media-align / missing-media 投影出「应对哪一 unit 走 freeze 链」；
 * 不自动 dispatch、不抢写租约。
 */
import {
  getStudioScriptMediaAlignBoard,
  type ScriptMediaAlignBoard,
  type ScriptMediaAlignRow,
} from "./studio-script-media-align.js";
import {
  formatPanelLightingCostumeLine,
  formatPanelStandingGaps,
  formatPropBackReferenceLineFromBoard,
  formatSceneBackReferenceLineFromBoard,
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
import type { PropBackReference, SceneBackReference } from "./studio-scene-backrefs.js";

export const SSL5_PLAN_SCHEMA_VERSION = 1 as const;

export interface Ssl5MissingToGenPlanItem {
  unitId: string;
  sequence: number;
  title: string;
  status: ScriptMediaAlignRow["status"];
  priority: "earliest" | "missing-all" | "partial" | "covered";
  recommendedPath: string[];
  packId: string | null;
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
  sceneBackReferenceLine: string;
  sceneBackReferences: SceneBackReference[];
  propBackReferenceLine: string;
  propBackReferences: PropBackReference[];
}

export interface Ssl5MissingToGenPlan {
  schemaVersion: typeof SSL5_PLAN_SCHEMA_VERSION;
  kind: "studio-ssl5-missing-to-gen-plan";
  projectRoot: string;
  season: string;
  episode: string;
  earliestUnitId: string | null;
  focusUnitId: string | null;
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
  sceneBackReferenceLine: string;
  sceneBackReferences: SceneBackReference[];
  propBackReferenceLine: string;
  propBackReferences: PropBackReference[];
  missingAllCount: number;
  partialCount: number;
  items: Ssl5MissingToGenPlanItem[];
  builtAt: string;
}

const SSL5_RECOMMENDED_PATH = [
  "binding-ready?",
  "readiness",
  "freeze",
  "dispatch",
  "prepare",
  "gen",
  "commit",
  "review",
] as const;

export function buildSsl5PlanFromBoard(
  projectRoot: string,
  query: { season: string; episode: string },
  board: Pick<ScriptMediaAlignBoard, "rows" | "earliestUnitId" | "missingAllCount" | "partialCount">,
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
      const previousLighting = missingPanel
        ? wizardPreviousLightingForPanel(row.panels ?? [], missingPanel.panelIndex)
        : null;
      const previousCostume = missingPanel
        ? wizardPreviousCostumeForPanel(row.panels ?? [], missingPanel.panelIndex)
        : null;
      return {
        unitId: row.unitId,
        sequence: row.sequence,
        title: row.title,
        status: row.status,
        priority,
        recommendedPath: [...SSL5_RECOMMENDED_PATH],
        packId: row.packId,
        generationRunId: row.generationRunId,
        focusPanelId: missingPanel?.panelId ?? null,
        focusPanelIndex: missingPanel?.panelIndex ?? null,
        previousPanelIndex: handoff?.panelIndex ?? null,
        previousShotComposition: handoff?.shotComposition ?? null,
        previousVisualAction: handoff?.visualAction ?? null,
        previousFilmingMethod: handoff?.filmingMethod ?? null,
        standingGapLine: formatPanelStandingGaps(missingPanel ?? null),
        lightingCostumeLine: formatPanelLightingCostumeLine(missingPanel ?? null),
        previousLightingLine: formatWizardLockPreviousLightingLine(previousLighting),
        previousCostumeLine: formatWizardLockPreviousCostumeLine(previousCostume),
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

  return {
    schemaVersion: SSL5_PLAN_SCHEMA_VERSION,
    kind: "studio-ssl5-missing-to-gen-plan",
    projectRoot,
    season: query.season,
    episode: query.episode,
    earliestUnitId: board.earliestUnitId,
    focusUnitId: focus?.unitId ?? null,
    focusPanelId: focus?.focusPanelId ?? null,
    focusPanelIndex: focus?.focusPanelIndex ?? null,
    previousPanelIndex: focus?.previousPanelIndex ?? null,
    previousShotComposition: focus?.previousShotComposition ?? null,
    previousVisualAction: focus?.previousVisualAction ?? null,
    previousFilmingMethod: focus?.previousFilmingMethod ?? null,
    standingGapLine: focus?.standingGapLine ?? "没有宫格可查站位缺口",
    lightingCostumeLine: focus?.lightingCostumeLine ?? "没有宫格可查光线/服化",
    previousLightingLine: focus?.previousLightingLine ?? null,
    previousCostumeLine: focus?.previousCostumeLine ?? null,
    sceneBackReferenceLine: focus?.sceneBackReferenceLine ?? "没有宫格可查场景回指",
    sceneBackReferences: focus?.sceneBackReferences ?? [],
    propBackReferenceLine: focus?.propBackReferenceLine ?? "没有宫格可查道具回指",
    propBackReferences: focus?.propBackReferences ?? [],
    missingAllCount: board.missingAllCount,
    partialCount: board.partialCount,
    items,
    builtAt,
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
  return buildSsl5PlanFromBoard(projectRoot, query, board);
}
