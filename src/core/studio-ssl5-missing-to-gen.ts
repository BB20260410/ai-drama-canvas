/**
 * SSL-5 · 缺图 → earliest/生图下一步（只读计划）
 *
 * 从 script-media-align / missing-media 投影出「应对哪一 unit 走 freeze 链」；
 * 不自动 dispatch、不抢写租约。
 */
import { getStudioEpisodeEarliest } from "./studio-episode-earliest.js";
import { getStudioScriptMediaAlignBoard, type ScriptMediaAlignRow } from "./studio-script-media-align.js";

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
}

export interface Ssl5MissingToGenPlan {
  schemaVersion: typeof SSL5_PLAN_SCHEMA_VERSION;
  kind: "studio-ssl5-missing-to-gen-plan";
  projectRoot: string;
  season: string;
  episode: string;
  earliestUnitId: string | null;
  focusUnitId: string | null;
  missingAllCount: number;
  partialCount: number;
  items: Ssl5MissingToGenPlanItem[];
  builtAt: string;
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
  const earliest = await getStudioEpisodeEarliest(projectRoot, {
    season: query.season,
    episode: query.episode,
    ...(query.evidenceDir ? { evidenceDir: query.evidenceDir } : {}),
  });

  const items: Ssl5MissingToGenPlanItem[] = board.rows
    .filter((r) => r.status !== "covered" || r.unitId === earliest.earliestUnitId)
    .map((r) => {
      let priority: Ssl5MissingToGenPlanItem["priority"] = "covered";
      if (r.unitId === earliest.earliestUnitId) priority = "earliest";
      else if (r.status === "missing-all") priority = "missing-all";
      else if (r.status === "partial") priority = "partial";
      return {
        unitId: r.unitId,
        sequence: r.sequence,
        title: r.title,
        status: r.status,
        priority,
        recommendedPath: [
          "binding-ready?",
          "readiness",
          "freeze",
          "dispatch",
          "prepare",
          "gen",
          "commit",
          "review",
        ],
        packId: r.packId,
        generationRunId: r.generationRunId,
      };
    })
    .sort((a, b) => {
      const rank = { earliest: 0, "missing-all": 1, partial: 2, covered: 3 } as const;
      return rank[a.priority] - rank[b.priority] || a.sequence - b.sequence;
    });

  const focus =
    items.find((i) => i.priority === "earliest")
    ?? items.find((i) => i.priority === "missing-all")
    ?? items.find((i) => i.priority === "partial")
    ?? null;

  return {
    schemaVersion: SSL5_PLAN_SCHEMA_VERSION,
    kind: "studio-ssl5-missing-to-gen-plan",
    projectRoot,
    season: query.season,
    episode: query.episode,
    earliestUnitId: earliest.earliestUnitId,
    focusUnitId: focus?.unitId ?? null,
    missingAllCount: board.missingAllCount,
    partialCount: board.partialCount,
    items,
    builtAt: new Date().toISOString(),
  };
}
