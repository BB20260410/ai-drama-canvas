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
import { pickFirstMissingPanel } from "./studio-script-library-projection.js";

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
