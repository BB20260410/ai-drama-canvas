/**
 * SSL-0 · 剧本库只读投影（ScriptLibraryIndex + Unit/Span→Media Map）
 *
 * 事实源：text documents / production units / generation packs / results。
 * 不新建平行库；不写账本；UI 不推导 nextAction。
 */
import { listStudioTextDocuments, listStudioTextRevisions, listStudioProductionUnits, getStudioProductionUnitSnapshot } from "./studio-production.js";
import {
  listStudioGenerationPacksByUnit,
  listStudioGenerationResultsByPack,
} from "./studio-generation-ledger.js";

export const SCRIPT_LIBRARY_PROJECTION_SCHEMA_VERSION = 1 as const;

export type ScriptLibraryDocumentKind = "script" | "prompt" | string;

export interface ScriptLibraryIndexItem {
  documentId: string;
  kind: ScriptLibraryDocumentKind;
  title: string;
  headRevision: number;
  revisionCount: number;
  linkedUnitCount: number;
  coveredMediaCount: number;
  updatedAt: string;
}

export interface ScriptLibraryIndex {
  schemaVersion: typeof SCRIPT_LIBRARY_PROJECTION_SCHEMA_VERSION;
  kind: "studio-script-library-index";
  projectRoot: string;
  documentCount: number;
  items: ScriptLibraryIndexItem[];
  truncated: boolean;
  builtAt: string;
}

export interface ScriptSpanRef {
  startOffsetUtf16: number;
  endOffsetUtf16: number;
}

export interface UnitPanelMediaEntry {
  panelIndex: number;
  panelId: string;
  title: string;
  sourceSpans: ScriptSpanRef[];
  packId: string | null;
  packFingerprint: string | null;
  rawSha256: string | null;
  labeledSha256: string | null;
  generationRunId: string | null;
  hasMedia: boolean;
}

export interface UnitSpanMediaMapEntry {
  unitId: string;
  unitRevision: number;
  season: string;
  episode: string;
  sequence: number;
  title: string;
  scriptRevisionId: string | null;
  scriptDocumentId: string | null;
  durationSeconds: number;
  panelCount: number;
  panels: UnitPanelMediaEntry[];
  coveredPanelCount: number;
  missingPanelCount: number;
}

export interface EpisodeUnitMediaMap {
  schemaVersion: typeof SCRIPT_LIBRARY_PROJECTION_SCHEMA_VERSION;
  kind: "studio-episode-unit-media-map";
  projectRoot: string;
  season: string;
  episode: string;
  unitCount: number;
  withAnyMedia: number;
  missingAllMedia: number;
  units: UnitSpanMediaMapEntry[];
  truncated: boolean;
  builtAt: string;
}

/** 纯函数：从结果列表抽取 raw/labeled SHA（单测用）。 */
export function pickRawLabeledFromResults(
  results: Array<{ variant?: string; mediaSha256?: string; generationRunId?: string }>,
): { rawSha256: string | null; labeledSha256: string | null; generationRunId: string | null } {
  let rawSha256: string | null = null;
  let labeledSha256: string | null = null;
  let generationRunId: string | null = null;
  for (const r of results) {
    const v = String(r.variant || "").toLowerCase();
    if (v === "raw" && r.mediaSha256) {
      rawSha256 = r.mediaSha256;
      generationRunId = r.generationRunId ?? generationRunId;
    }
    if (v === "labeled" && r.mediaSha256) {
      labeledSha256 = r.mediaSha256;
      generationRunId = r.generationRunId ?? generationRunId;
    }
  }
  if (!rawSha256) {
    const first = results.find((r) => r.mediaSha256);
    if (first?.mediaSha256) {
      rawSha256 = first.mediaSha256;
      generationRunId = first.generationRunId ?? generationRunId;
    }
  }
  return { rawSha256, labeledSha256, generationRunId };
}

/** 半开区间 [start, end) 是否相交。空区间不相交。 */
export function spansOverlap(left: ScriptSpanRef, right: ScriptSpanRef): boolean {
  return left.startOffsetUtf16 < left.endOffsetUtf16
    && right.startOffsetUtf16 < right.endOffsetUtf16
    && left.startOffsetUtf16 < right.endOffsetUtf16
    && right.startOffsetUtf16 < left.endOffsetUtf16;
}

export interface ScriptSpanMediaHit {
  unitId: string;
  sequence: number;
  title: string;
  panelId: string;
  panelIndex: number;
  sourceSpans: ScriptSpanRef[];
  packId: string | null;
  generationRunId: string | null;
  rawSha256: string | null;
  labeledSha256: string | null;
  hasMedia: boolean;
}

export interface ScriptSpanMediaMap {
  schemaVersion: typeof SCRIPT_LIBRARY_PROJECTION_SCHEMA_VERSION;
  kind: "studio-script-span-media-map";
  projectRoot: string;
  season: string;
  episode: string;
  query: ScriptSpanRef;
  matchCount: number;
  missingCount: number;
  hits: ScriptSpanMediaHit[];
}

/** 纯函数：点选剧本 span → 相交宫格/图。不扫盘、不写账本。 */
export function resolveScriptSpanMediaMap(
  map: Pick<EpisodeUnitMediaMap, "projectRoot" | "season" | "episode" | "units">,
  query: ScriptSpanRef,
): ScriptSpanMediaMap {
  if (
    !Number.isFinite(query.startOffsetUtf16)
    || !Number.isFinite(query.endOffsetUtf16)
    || query.endOffsetUtf16 < query.startOffsetUtf16
  ) {
    throw new Error("script-span-media-map 需要有效的 startOffsetUtf16 ≤ endOffsetUtf16。");
  }
  const hits: ScriptSpanMediaHit[] = [];
  for (const unit of map.units) {
    for (const panel of unit.panels) {
      if (!panel.sourceSpans.some((span) => spansOverlap(span, query))) continue;
      hits.push({
        unitId: unit.unitId,
        sequence: unit.sequence,
        title: unit.title,
        panelId: panel.panelId,
        panelIndex: panel.panelIndex,
        sourceSpans: panel.sourceSpans,
        packId: panel.packId,
        generationRunId: panel.generationRunId,
        rawSha256: panel.rawSha256,
        labeledSha256: panel.labeledSha256,
        hasMedia: panel.hasMedia,
      });
    }
  }
  hits.sort((left, right) => left.sequence - right.sequence || left.panelIndex - right.panelIndex);
  return {
    schemaVersion: SCRIPT_LIBRARY_PROJECTION_SCHEMA_VERSION,
    kind: "studio-script-span-media-map",
    projectRoot: map.projectRoot,
    season: map.season,
    episode: map.episode,
    query,
    matchCount: hits.length,
    missingCount: hits.filter((hit) => !hit.hasMedia).length,
    hits,
  };
}

/** 纯函数：span 归一。 */
export function normalizeSourceSpans(spans: unknown): ScriptSpanRef[] {
  if (!Array.isArray(spans)) return [];
  const out: ScriptSpanRef[] = [];
  for (const s of spans) {
    if (!s || typeof s !== "object") continue;
    const start = Number((s as { startOffsetUtf16?: number }).startOffsetUtf16);
    const end = Number((s as { endOffsetUtf16?: number }).endOffsetUtf16);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    out.push({ startOffsetUtf16: start, endOffsetUtf16: end });
  }
  return out;
}

async function countUnitsForScriptRevision(projectRoot: string, scriptRevisionId: string): Promise<number> {
  // 经 list units 扫描头修订（有界页）；SSL-0 可接受 O(n) 投影
  let cursor: string | undefined;
  let n = 0;
  for (let page = 0; page < 50; page++) {
    const batch = await listStudioProductionUnits(projectRoot, { limit: 100, cursor });
    for (const u of batch.items) {
      try {
        const snap = await getStudioProductionUnitSnapshot(projectRoot, u.id);
        if (snap?.scriptRevision?.id === scriptRevisionId) n += 1;
      } catch {
        /* skip */
      }
    }
    if (!batch.nextCursor) break;
    cursor = batch.nextCursor;
  }
  return n;
}

/**
 * 剧本库索引（只读）。默认列出 script 类文档；limit 有界。
 */
export async function getStudioScriptLibraryIndex(
  projectRoot: string,
  query: { limit?: number; kind?: "script" | "prompt" } = {},
): Promise<ScriptLibraryIndex> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const page = await listStudioTextDocuments(projectRoot, {
    kind: query.kind ?? "script",
    limit,
  });
  const items: ScriptLibraryIndexItem[] = [];
  for (const doc of page.items) {
    const revs = await listStudioTextRevisions(projectRoot, { documentId: doc.id, limit: 100 });
    const head = revs.items[revs.items.length - 1] ?? revs.items[0];
    const headRevId = head?.id;
    let linkedUnitCount = 0;
    let coveredMediaCount = 0;
    if (headRevId) {
      linkedUnitCount = await countUnitsForScriptRevision(projectRoot, headRevId);
      // coveredMedia：粗估 — 有任一 unit pack 结果则 +1（按 unit，非 panel）
      // 完整 panel 覆盖见 getStudioEpisodeUnitMediaMap
      if (linkedUnitCount > 0) {
        // 轻量：不二次扫 pack；coveredMediaCount 在 episode map 更准
        coveredMediaCount = 0;
      }
    }
    items.push({
      documentId: doc.id,
      kind: doc.kind,
      title: doc.title,
      headRevision: Number(doc.revision ?? head?.ordinal ?? 0),
      revisionCount: revs.items.length,
      linkedUnitCount,
      coveredMediaCount,
      updatedAt: String(doc.updatedAt ?? doc.createdAt ?? ""),
    });
  }
  return {
    schemaVersion: SCRIPT_LIBRARY_PROJECTION_SCHEMA_VERSION,
    kind: "studio-script-library-index",
    projectRoot,
    documentCount: items.length,
    items,
    truncated: Boolean(page.nextCursor),
    builtAt: new Date().toISOString(),
  };
}

async function latestPackMedia(
  projectRoot: string,
  unitId: string,
): Promise<{
  packId: string | null;
  packFingerprint: string | null;
  rawSha256: string | null;
  labeledSha256: string | null;
  generationRunId: string | null;
}> {
  const packs = await listStudioGenerationPacksByUnit(projectRoot, { unitId, limit: 20 });
  // 取最新 sequence 的 pack 中有结果的
  const ordered = [...packs.items].sort((a, b) => b.sequence - a.sequence);
  for (const p of ordered) {
    const results = await listStudioGenerationResultsByPack(projectRoot, { packId: p.packId, limit: 20 });
    const picked = pickRawLabeledFromResults(
      results.items.map((r) => ({
        variant: (r as { variant?: string }).variant,
        mediaSha256: (r as { mediaSha256?: string }).mediaSha256,
        generationRunId: (r as { generationRunId?: string }).generationRunId,
      })),
    );
    if (picked.rawSha256 || picked.labeledSha256) {
      return {
        packId: p.packId,
        packFingerprint: p.fingerprint,
        ...picked,
      };
    }
  }
  return {
    packId: ordered[0]?.packId ?? null,
    packFingerprint: ordered[0]?.fingerprint ?? null,
    rawSha256: null,
    labeledSha256: null,
    generationRunId: null,
  };
}

/**
 * 集级 unit→span→media 投影（只读）。panel 级 media 目前与 unit-grid 共享同一结果图。
 */
export async function getStudioEpisodeUnitMediaMap(
  projectRoot: string,
  query: { season: string; episode: string; limit?: number },
): Promise<EpisodeUnitMediaMap> {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
  let cursor: string | undefined;
  const units: UnitSpanMediaMapEntry[] = [];
  let truncated = false;

  for (let page = 0; page < 30 && units.length < limit; page++) {
    const batch = await listStudioProductionUnits(projectRoot, {
      season: query.season,
      episode: query.episode,
      limit: Math.min(50, limit - units.length + 1),
      cursor,
    });
    for (const u of batch.items) {
      if (units.length >= limit) {
        truncated = true;
        break;
      }
      const snap = await getStudioProductionUnitSnapshot(projectRoot, u.id);
      if (!snap) continue;
      const media = await latestPackMedia(projectRoot, u.id);
      const panels: UnitPanelMediaEntry[] = (snap.panels || []).map((panel) => {
        const spans = normalizeSourceSpans((panel as { sourceSpans?: unknown }).sourceSpans);
        const hasMedia = Boolean(media.rawSha256 || media.labeledSha256);
        return {
          panelIndex: Number(panel.index),
          panelId: String(panel.id),
          title: String(panel.title || ""),
          sourceSpans: spans,
          packId: media.packId,
          packFingerprint: media.packFingerprint,
          rawSha256: media.rawSha256,
          labeledSha256: media.labeledSha256,
          generationRunId: media.generationRunId,
          hasMedia,
        };
      });
      const coveredPanelCount = panels.filter((p) => p.hasMedia).length;
      units.push({
        unitId: snap.unit.id,
        unitRevision: Number(snap.unit.revision),
        season: snap.unit.season,
        episode: snap.unit.episode,
        sequence: Number(snap.unit.sequence),
        title: snap.unit.title,
        scriptRevisionId: snap.scriptRevision?.id ?? null,
        scriptDocumentId: (snap.scriptRevision as { documentId?: string } | undefined)?.documentId ?? null,
        durationSeconds: Number(snap.unit.durationSeconds ?? 15),
        panelCount: panels.length,
        panels,
        coveredPanelCount,
        missingPanelCount: panels.length - coveredPanelCount,
      });
    }
    if (!batch.nextCursor || units.length >= limit) {
      if (batch.nextCursor && units.length >= limit) truncated = true;
      break;
    }
    cursor = batch.nextCursor;
  }

  units.sort((a, b) => a.sequence - b.sequence || a.unitId.localeCompare(b.unitId));
  const withAnyMedia = units.filter((u) => u.coveredPanelCount > 0).length;
  return {
    schemaVersion: SCRIPT_LIBRARY_PROJECTION_SCHEMA_VERSION,
    kind: "studio-episode-unit-media-map",
    projectRoot,
    season: query.season,
    episode: query.episode,
    unitCount: units.length,
    withAnyMedia,
    missingAllMedia: units.length - withAnyMedia,
    units,
    truncated,
    builtAt: new Date().toISOString(),
  };
}

export interface MissingMediaReportItem {
  unitId: string;
  sequence: number;
  title: string;
  scriptRevisionId: string | null;
  panelCount: number;
  coveredPanelCount: number;
  missingPanelCount: number;
  status: "missing-all" | "partial" | "covered";
}

export interface MissingMediaReport {
  schemaVersion: typeof SCRIPT_LIBRARY_PROJECTION_SCHEMA_VERSION;
  kind: "studio-episode-missing-media-report";
  projectRoot: string;
  season: string;
  episode: string;
  unitCount: number;
  missingAllCount: number;
  partialCount: number;
  coveredCount: number;
  items: MissingMediaReportItem[];
  builtAt: string;
}

/** 纯函数：从 episode map 导出缺图/部分覆盖报告（SSL-3 前置）。 */
export function buildMissingMediaReport(map: EpisodeUnitMediaMap): MissingMediaReport {
  const items: MissingMediaReportItem[] = map.units.map((u) => {
    let status: MissingMediaReportItem["status"] = "covered";
    if (u.coveredPanelCount <= 0) status = "missing-all";
    else if (u.missingPanelCount > 0) status = "partial";
    return {
      unitId: u.unitId,
      sequence: u.sequence,
      title: u.title,
      scriptRevisionId: u.scriptRevisionId,
      panelCount: u.panelCount,
      coveredPanelCount: u.coveredPanelCount,
      missingPanelCount: u.missingPanelCount,
      status,
    };
  });
  return {
    schemaVersion: SCRIPT_LIBRARY_PROJECTION_SCHEMA_VERSION,
    kind: "studio-episode-missing-media-report",
    projectRoot: map.projectRoot,
    season: map.season,
    episode: map.episode,
    unitCount: items.length,
    missingAllCount: items.filter((i) => i.status === "missing-all").length,
    partialCount: items.filter((i) => i.status === "partial").length,
    coveredCount: items.filter((i) => i.status === "covered").length,
    items,
    builtAt: new Date().toISOString(),
  };
}

export async function getStudioScriptSpanMediaMap(
  projectRoot: string,
  query: { season: string; episode: string; startOffsetUtf16: number; endOffsetUtf16: number; limit?: number },
): Promise<ScriptSpanMediaMap> {
  const map = await getStudioEpisodeUnitMediaMap(projectRoot, {
    season: query.season,
    episode: query.episode,
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
  });
  return resolveScriptSpanMediaMap(map, {
    startOffsetUtf16: query.startOffsetUtf16,
    endOffsetUtf16: query.endOffsetUtf16,
  });
}

export async function getStudioEpisodeMissingMediaReport(
  projectRoot: string,
  query: { season: string; episode: string; limit?: number },
): Promise<MissingMediaReport> {
  const map = await getStudioEpisodeUnitMediaMap(projectRoot, query);
  return buildMissingMediaReport(map);
}
