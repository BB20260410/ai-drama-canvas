/**
 * SSL-3 · 一键剧本↔图对照投影（只读）
 *
 * 合并：earliest 槽位 + unit media map + 可选大纲标题锚定。
 * 不返回媒体二进制；提供 packId/runId/mediaSha 供 trace/缩略代理点穿。
 */
import { getStudioEpisodeEarliest } from "./studio-episode-earliest.js";
import {
  getStudioEpisodeUnitMediaMap,
  buildMissingMediaReport,
  pickFirstCoveredPanel,
  type UnitPanelMediaEntry,
  type UnitSpanMediaMapEntry,
} from "./studio-script-library-projection.js";
import { getStudioScriptReaderView, type ScriptOutlineHeading } from "./studio-script-library-reader.js";
import type { ConsistencyVerdict } from "./studio-consistency-evaluator.js";

export const SCRIPT_MEDIA_ALIGN_SCHEMA_VERSION = 1 as const;

export interface ScriptMediaAlignRow {
  unitId: string;
  sequence: number;
  title: string;
  formalCommitted: boolean;
  isEarliest: boolean;
  reviewDecision: string | null;
  scriptRevisionId: string | null;
  panelCount: number;
  coveredPanelCount: number;
  missingPanelCount: number;
  status: "covered" | "partial" | "missing-all";
  rawSha256: string | null;
  labeledSha256: string | null;
  packId: string | null;
  packFingerprint: string | null;
  generationRunId: string | null;
  /** 可点穿：get_studio_trace by-pack / by-run */
  trace: {
    byPack: { operation: "by-pack"; packId: string } | null;
    byRun: { operation: "by-run"; runId: string } | null;
  };
  sourceSpans: Array<{ startOffsetUtf16: number; endOffsetUtf16: number }>;
  outlineAnchors: Array<{ title: string; level: number; startOffsetUtf16: number }>;
  /** 只读缓存 peek。未评估 ≠ 无法检查。机器不自动 Review PASS。 */
  consistencyPeek: AlignConsistencyPeek;
  /** 宫格级媒体真相；unit-grid 不摊派。 */
  panels: UnitPanelMediaEntry[];
}

export interface AlignConsistencyPeek {
  status: "cached" | "unevaluated";
  verdict?: ConsistencyVerdict;
}

export interface ScriptMediaAlignBoard {
  schemaVersion: typeof SCRIPT_MEDIA_ALIGN_SCHEMA_VERSION;
  kind: "studio-script-media-align-board";
  projectRoot: string;
  season: string;
  episode: string;
  documentId: string | null;
  documentTitle: string | null;
  revisionId: string | null;
  earliestUnitId: string | null;
  earliestStatusLine: string | null;
  unitCount: number;
  coveredCount: number;
  partialCount: number;
  missingAllCount: number;
  rows: ScriptMediaAlignRow[];
  missingReport: ReturnType<typeof buildMissingMediaReport>;
  builtAt: string;
}

/** 纯：从大纲标题解析 unitId（如 S1E2-U01）。 */
export function matchOutlineAnchorsForUnit(
  unitId: string,
  outline: ScriptOutlineHeading[],
): Array<{ title: string; level: number; startOffsetUtf16: number }> {
  const id = unitId.toUpperCase();
  const short = id.replace(/^S1E2-/i, "");
  return outline
    .filter((h) => {
      const t = h.title.toUpperCase();
      return t.includes(id) || (short.startsWith("U") && new RegExp(`\\b${short}\\b`, "i").test(h.title));
    })
    .map((h) => ({
      title: h.title,
      level: h.level,
      startOffsetUtf16: h.startOffsetUtf16,
    }))
    .slice(0, 12);
}

export function attachAlignRowConsistencyPeeks(
  rows: ScriptMediaAlignRow[],
  verdictByRunId: ReadonlyMap<string, ConsistencyVerdict>,
): ScriptMediaAlignRow[] {
  return rows.map((row) => {
    const verdict = row.generationRunId ? verdictByRunId.get(row.generationRunId) : undefined;
    return {
      ...row,
      consistencyPeek: verdict
        ? { status: "cached", verdict }
        : { status: "unevaluated" },
    };
  });
}

async function loadAlignConsistencyPeeks(rows: ScriptMediaAlignRow[]): Promise<Map<string, ConsistencyVerdict>> {
  const runIds = [...new Set(rows.map((row) => row.generationRunId).filter((id): id is string => Boolean(id)))];
  if (runIds.length === 0) return new Map();
  const { peekStudioConsistencyVerdictByRunId } = await import("./studio-consistency-evaluator.js");
  const out = new Map<string, ConsistencyVerdict>();
  for (const runId of runIds) {
    const verdict = peekStudioConsistencyVerdictByRunId(runId);
    if (verdict) out.set(runId, verdict);
  }
  return out;
}

function rowStatus(u: UnitSpanMediaMapEntry): ScriptMediaAlignRow["status"] {
  if (u.coveredPanelCount <= 0) return "missing-all";
  if (u.missingPanelCount > 0) return "partial";
  return "covered";
}

export async function getStudioScriptMediaAlignBoard(
  projectRoot: string,
  query: {
    season: string;
    episode: string;
    documentId?: string;
    revisionId?: string;
    evidenceDir?: string;
    includeOutline?: boolean;
  },
): Promise<ScriptMediaAlignBoard> {
  const season = query.season;
  const episode = query.episode;
  // 组合 earliest + media map；本函数不直接调用写版 inspect。

  const [map, earliest] = await Promise.all([
    getStudioEpisodeUnitMediaMap(projectRoot, { season, episode, limit: 200 }),
    getStudioEpisodeEarliest(projectRoot, {
      season,
      episode,
      ...(query.evidenceDir ? { evidenceDir: query.evidenceDir } : {}),
    }),
  ]);

  let outline: ScriptOutlineHeading[] = [];
  let documentId: string | null = null;
  let documentTitle: string | null = null;
  let revisionId: string | null = null;

  if (query.includeOutline !== false && (query.documentId || query.revisionId)) {
    try {
      const reader = await getStudioScriptReaderView(projectRoot, {
        ...(query.documentId ? { documentId: query.documentId } : {}),
        ...(query.revisionId ? { revisionId: query.revisionId } : {}),
        includeBody: false,
      });
      outline = reader.outline;
      documentId = reader.documentId;
      documentTitle = reader.documentTitle;
      revisionId = reader.revisionId;
    } catch {
      /* 无文档时仍可只出 unit 对照 */
    }
  }

  const slotById = new Map(earliest.slots.map((s) => [s.unitId, s]));
  const rows: ScriptMediaAlignRow[] = map.units.map((u) => {
    const slot = slotById.get(u.unitId);
    const preview = pickFirstCoveredPanel(u.panels);
    const rawSha256 = preview?.rawSha256 ?? null;
    const labeledSha256 = preview?.labeledSha256 ?? null;
    const packId = preview?.packId ?? null;
    const packFingerprint = preview?.packFingerprint ?? null;
    const generationRunId = preview?.generationRunId ?? null;
    const status = rowStatus(u);
    const spans = u.panels.flatMap((p) => p.sourceSpans);
    return {
      unitId: u.unitId,
      sequence: u.sequence,
      title: u.title,
      formalCommitted: slot?.formalCommitted === true,
      isEarliest: earliest.earliestUnitId === u.unitId,
      reviewDecision: slot?.reviewDecision ?? null,
      scriptRevisionId: u.scriptRevisionId,
      panelCount: u.panelCount,
      coveredPanelCount: u.coveredPanelCount,
      missingPanelCount: u.missingPanelCount,
      status,
      rawSha256,
      labeledSha256,
      packId,
      packFingerprint,
      generationRunId,
      trace: {
        byPack: packId ? { operation: "by-pack" as const, packId } : null,
        byRun: generationRunId ? { operation: "by-run" as const, runId: generationRunId } : null,
      },
      sourceSpans: spans,
      outlineAnchors: matchOutlineAnchorsForUnit(u.unitId, outline),
      consistencyPeek: { status: "unevaluated" },
      panels: u.panels,
    };
  });

  rows.sort((a, b) => a.sequence - b.sequence);
  const rowsWithPeek = attachAlignRowConsistencyPeeks(rows, await loadAlignConsistencyPeeks(rows));
  const missingReport = buildMissingMediaReport(map);

  return {
    schemaVersion: SCRIPT_MEDIA_ALIGN_SCHEMA_VERSION,
    kind: "studio-script-media-align-board",
    projectRoot,
    season,
    episode,
    documentId,
    documentTitle,
    revisionId,
    earliestUnitId: earliest.earliestUnitId,
    earliestStatusLine: earliest.statusLine,
    unitCount: rowsWithPeek.length,
    coveredCount: rowsWithPeek.filter((r) => r.status === "covered").length,
    partialCount: rowsWithPeek.filter((r) => r.status === "partial").length,
    missingAllCount: rowsWithPeek.filter((r) => r.status === "missing-all").length,
    rows: rowsWithPeek,
    missingReport,
    builtAt: new Date().toISOString(),
  };
}
