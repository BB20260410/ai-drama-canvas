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
import {
  SCENE_BACK_REFERENCE_LIMIT,
  formatSceneBackReferences,
  type SceneBackReference,
} from "./studio-scene-backrefs.js";

export {
  SCENE_BACK_REFERENCE_LIMIT,
  formatSceneBackReferences,
  type SceneBackReference,
} from "./studio-scene-backrefs.js";

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
  /** 锁版构图/动作只读投影；不推导 nextAction。 */
  shotComposition: string;
  visualAction: string;
  filmingMethod: string;
  sceneLighting: string;
  costumeState: string;
  shotType: "original" | "extension" | "";
  assetMentions: PanelAssetMentionLite[];
  previousHandoff: PanelStandingHandoff | null;
}

export interface PanelAssetMentionLite {
  assetId: string;
  category: string;
  role: string;
}

export interface PanelStandingHandoff {
  panelIndex: number;
  panelId: string;
  shotComposition: string;
  visualAction: string;
  filmingMethod: string;
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

export interface PackMediaPick {
  packId: string | null;
  packFingerprint: string | null;
  rawSha256: string | null;
  labeledSha256: string | null;
  generationRunId: string | null;
}

export const EMPTY_PACK_MEDIA: PackMediaPick = {
  packId: null,
  packFingerprint: null,
  rawSha256: null,
  labeledSha256: null,
  generationRunId: null,
};

export type PackIndexLite = {
  targetKind: string;
  panelId: string;
  sequence: number;
  packId: string;
  fingerprint?: string;
};

/** 只认 targetKind=panel 且 panelId 对齐的冻结包；unit-grid 不得摊到宫格。 */
export function listPanelPacksNewestFirst<T extends PackIndexLite>(
  packs: T[],
  panelId: string,
): T[] {
  return [...packs]
    .filter((pack) => pack.targetKind === "panel" && pack.panelId === panelId)
    .sort((a, b) => b.sequence - a.sequence);
}

export function selectLatestPanelPack<T extends PackIndexLite>(
  packs: T[],
  panelId: string,
): T | undefined {
  return listPanelPacksNewestFirst(packs, panelId)[0];
}

export function summarizePanelAssetMentions(assets: unknown): PanelAssetMentionLite[] {
  if (!Array.isArray(assets)) return [];
  const out: PanelAssetMentionLite[] = [];
  for (const asset of assets) {
    if (!asset || typeof asset !== "object") continue;
    const assetId = String((asset as { assetId?: unknown }).assetId ?? "").trim();
    if (!assetId) continue;
    out.push({
      assetId,
      category: String((asset as { category?: unknown }).category ?? ""),
      role: String((asset as { role?: unknown }).role ?? ""),
    });
    if (out.length >= 6) break;
  }
  return out;
}

export function attachPanelStandingHandoffs<T extends UnitPanelMediaEntry>(panels: T[]): T[] {
  const ordered = [...panels].sort((left, right) => left.panelIndex - right.panelIndex);
  return ordered.map((panel, index) => {
    const previous = index > 0 ? ordered[index - 1] : undefined;
    return {
      ...panel,
      previousHandoff: previous
        ? {
          panelIndex: previous.panelIndex,
          panelId: previous.panelId,
          shotComposition: previous.shotComposition,
          visualAction: previous.visualAction,
          filmingMethod: previous.filmingMethod,
        }
        : null,
    };
  });
}

export function formatPanelStandingHandoff(handoff: PanelStandingHandoff | null | undefined): string {
  if (!handoff) return "首格无前镜";
  return `G${handoff.panelIndex} ${handoff.shotComposition || "构图未记"} · ${handoff.visualAction || "动作未记"} · ${handoff.filmingMethod || "运镜未记"}`;
}

export type PanelStandingFields = {
  shotComposition?: string;
  visualAction?: string;
  filmingMethod?: string;
  previousHandoff?: PanelStandingHandoff | null;
};

/** 锁版站位缺口；不是 BindingSet，不能当 generation-ready。 */
export function listPanelStandingGaps(panel: PanelStandingFields | null | undefined): string[] {
  if (!panel) return [];
  const gaps: string[] = [];
  if (!String(panel.shotComposition || "").trim()) gaps.push("缺构图");
  if (!String(panel.visualAction || "").trim()) gaps.push("缺动作");
  if (!String(panel.filmingMethod || "").trim()) gaps.push("缺运镜");
  return gaps;
}

export function formatPanelStandingGaps(panel: PanelStandingFields | null | undefined): string {
  if (!panel) return "没有宫格可查站位缺口";
  const gaps = listPanelStandingGaps(panel);
  const handoff = formatPanelStandingHandoff(panel.previousHandoff);
  if (!gaps.length) return `锁版站位已记 · ${handoff}`;
  return `锁版站位缺口：${gaps.join("、")} · ${handoff}。不是 BindingSet，不能当 generation-ready。`;
}

export type PanelLightingCostumeFields = {
  panelIndex?: number;
  sceneLighting?: string;
  costumeState?: string;
};

/** 锁版本格光线/服化；不是 BindingSet，不能当 generation-ready。 */
export function formatPanelLightingCostumeLine(
  panel: PanelLightingCostumeFields | null | undefined,
): string {
  if (!panel) return "没有宫格可查光线/服化";
  const lighting = String(panel.sceneLighting || "").trim();
  const costume = String(panel.costumeState || "").trim();
  const index = Number(panel.panelIndex);
  const prefix = Number.isFinite(index) ? `G${index} ` : "";
  const parts = [
    lighting ? `锁版光线：${prefix}${lighting}` : "锁版未记光线",
    costume ? `锁版服装：${prefix}${costume}` : "锁版未记服装",
  ];
  return `${parts.join(" · ")}。不是 BindingSet，不能当 generation-ready。`;
}

export function listSceneAssetMentions(
  mentions: ReadonlyArray<{ assetId?: string; category?: string; role?: string }> | null | undefined,
): PanelAssetMentionLite[] {
  if (!mentions) return [];
  return mentions.flatMap((mention) => {
    const assetId = String(mention.assetId ?? "").trim();
    const category = String(mention.category ?? "").trim();
    if (!assetId || category !== "scene") return [];
    return [{ assetId, category, role: String(mention.role ?? "").trim() }];
  });
}

function isEarlierPanel(
  sequence: number,
  panelIndex: number,
  currentSequence: number,
  currentPanelIndex: number,
): boolean {
  if (sequence < currentSequence) return true;
  return sequence === currentSequence && panelIndex < currentPanelIndex;
}

/**
 * 跨单元场景回指：只扫已加载对照/episode 快照提及。
 * 不是 BindingSet，不能当 generation-ready。不读 head、不拆冻结包。
 */
export function listSceneBackReferences(input: {
  currentUnitId: string;
  currentSequence: number;
  currentPanelIndex: number;
  currentPanelId: string;
  sceneMentions: ReadonlyArray<{ assetId: string; role?: string }>;
  units: ReadonlyArray<{
    unitId: string;
    sequence: number;
    panels: ReadonlyArray<{
      panelId: string;
      panelIndex: number;
      assetMentions: ReadonlyArray<{ assetId: string; category: string; role?: string }>;
    }>;
  }>;
  limit?: number;
}): SceneBackReference[] {
  const sceneIds = new Set(
    input.sceneMentions.map((mention) => mention.assetId.trim()).filter(Boolean),
  );
  if (!sceneIds.size) return [];
  const limit = Math.max(1, Math.min(input.limit ?? SCENE_BACK_REFERENCE_LIMIT, SCENE_BACK_REFERENCE_LIMIT));
  const rows: SceneBackReference[] = [];
  const seen = new Set<string>();
  for (const unit of input.units) {
    for (const panel of unit.panels) {
      if (panel.panelId === input.currentPanelId && unit.unitId === input.currentUnitId) continue;
      if (!isEarlierPanel(unit.sequence, panel.panelIndex, input.currentSequence, input.currentPanelIndex)) {
        continue;
      }
      for (const mention of listSceneAssetMentions(panel.assetMentions)) {
        if (!sceneIds.has(mention.assetId)) continue;
        const key = `${unit.unitId}:${panel.panelId}:${mention.assetId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          assetId: mention.assetId,
          role: mention.role,
          unitId: unit.unitId,
          sequence: unit.sequence,
          panelIndex: panel.panelIndex,
          panelId: panel.panelId,
        });
      }
    }
  }
  return rows
    .sort((left, right) => right.sequence - left.sequence || right.panelIndex - left.panelIndex)
    .slice(0, limit);
}

export const WIZARD_SCENE_BACKREF_UNLOADED_NOTE =
  "对照板未加载，无法查场景回指。不是 BindingSet，不能当 generation-ready。";

const WIZARD_DRAFT_UNIT_ID = "wizard-draft";

/** 建议资产只在已加载对照板里出现过 category=scene 才算场景提及。 */
export function wizardSceneMentionsFromSuggestedIds(
  suggestedAssetIds: ReadonlyArray<string> | null | undefined,
  units: ReadonlyArray<{
    panels: ReadonlyArray<{
      assetMentions: ReadonlyArray<{ assetId: string; category: string; role?: string }>;
    }>;
  }>,
): PanelAssetMentionLite[] {
  const suggested = new Set(
    (suggestedAssetIds ?? []).map((assetId) => assetId.trim()).filter(Boolean),
  );
  if (!suggested.size) return [];
  const sceneById = new Map<string, string>();
  for (const unit of units) {
    for (const panel of unit.panels) {
      for (const mention of listSceneAssetMentions(panel.assetMentions)) {
        if (!suggested.has(mention.assetId) || sceneById.has(mention.assetId)) continue;
        sceneById.set(mention.assetId, mention.role);
      }
    }
  }
  return [...sceneById.entries()].map(([assetId, role]) => ({ assetId, category: "scene", role }));
}

/** 15s 向导：只扫已加载对照板。不写冻结提示词，不是 BindingSet。 */
export function formatWizardSceneBackReferenceLine(input: {
  boardLoaded: boolean;
  currentSequence: number;
  currentPanelIndex: number;
  suggestedAssetIds?: ReadonlyArray<string> | null;
  units: ReadonlyArray<{
    unitId: string;
    sequence: number;
    panels: ReadonlyArray<{
      panelId: string;
      panelIndex: number;
      assetMentions: ReadonlyArray<{ assetId: string; category: string; role?: string }>;
    }>;
  }>;
}): string {
  if (!input.boardLoaded) return WIZARD_SCENE_BACKREF_UNLOADED_NOTE;
  const mentions = wizardSceneMentionsFromSuggestedIds(input.suggestedAssetIds, input.units);
  return formatSceneBackReferences(
    mentions.length,
    listSceneBackReferences({
      currentUnitId: WIZARD_DRAFT_UNIT_ID,
      currentSequence: input.currentSequence,
      currentPanelIndex: input.currentPanelIndex,
      currentPanelId: `wizard-g${input.currentPanelIndex}`,
      sceneMentions: mentions,
      units: input.units,
    }),
  );
}

export function formatSceneBackReferenceLineFromBoard(input: {
  currentUnitId: string;
  currentSequence: number;
  currentPanelIndex: number;
  currentPanelId: string;
  currentMentions: ReadonlyArray<{ assetId?: string; category?: string; role?: string }> | null | undefined;
  units: ReadonlyArray<{
    unitId: string;
    sequence: number;
    panels: ReadonlyArray<{
      panelId: string;
      panelIndex: number;
      assetMentions: ReadonlyArray<{ assetId: string; category: string; role?: string }>;
    }>;
  }>;
}): string {
  const mentions = listSceneAssetMentions(input.currentMentions);
  return formatSceneBackReferences(mentions.length, listSceneBackReferences({
    currentUnitId: input.currentUnitId,
    currentSequence: input.currentSequence,
    currentPanelIndex: input.currentPanelIndex,
    currentPanelId: input.currentPanelId,
    sceneMentions: mentions,
    units: input.units,
  }));
}

export function applyPackMediaToPanels(
  panels: Array<{
    index: number;
    id: string;
    title?: string;
    sourceSpans?: unknown;
    shotComposition?: string;
    visualAction?: string;
    filmingMethod?: string;
    sceneLighting?: string;
    costumeState?: string;
    shotType?: string;
    assets?: unknown;
  }>,
  mediaByPanelId: ReadonlyMap<string, PackMediaPick>,
): UnitPanelMediaEntry[] {
  const entries = panels.map((panel) => {
    const media = mediaByPanelId.get(String(panel.id)) ?? EMPTY_PACK_MEDIA;
    const shotType = panel.shotType === "extension" ? "extension" as const : panel.shotType === "original" ? "original" as const : "" as const;
    return {
      panelIndex: Number(panel.index),
      panelId: String(panel.id),
      title: String(panel.title || ""),
      sourceSpans: normalizeSourceSpans(panel.sourceSpans),
      packId: media.packId,
      packFingerprint: media.packFingerprint,
      rawSha256: media.rawSha256,
      labeledSha256: media.labeledSha256,
      generationRunId: media.generationRunId,
      hasMedia: Boolean(media.rawSha256 || media.labeledSha256),
      shotComposition: String(panel.shotComposition || ""),
      visualAction: String(panel.visualAction || ""),
      filmingMethod: String(panel.filmingMethod || ""),
      sceneLighting: String(panel.sceneLighting || ""),
      costumeState: String(panel.costumeState || ""),
      shotType,
      assetMentions: summarizePanelAssetMentions(panel.assets),
      previousHandoff: null,
    };
  });
  return attachPanelStandingHandoffs(entries);
}

/** 单元行预览：优先第一张已出图的宫格，不把缺图格当成整单元有图。 */
export function pickFirstCoveredPanel<T extends UnitPanelMediaEntry>(panels: T[]): T | undefined {
  return panels.find((panel) => panel.hasMedia) ?? panels[0];
}

/** 生图下一步：第一张缺图宫格。全覆盖则无。 */
export function pickFirstMissingPanel<T extends { panelId: string; panelIndex: number; hasMedia: boolean }>(
  panels: T[],
): T | undefined {
  return [...panels]
    .filter((panel) => !panel.hasMedia)
    .sort((a, b) => a.panelIndex - b.panelIndex)[0];
}

/** 导演面宫格覆盖标记。不推导 nextAction。 */
export function formatPanelCoverageMarks(
  panels: Array<{ panelIndex: number; hasMedia: boolean }>,
): string {
  return [...panels]
    .sort((a, b) => a.panelIndex - b.panelIndex)
    .map((panel) => `G${panel.panelIndex}${panel.hasMedia ? "有" : "缺"}`)
    .join(" ");
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
  /** 锁版构图/动作/运镜只读投影；不推导 nextAction。 */
  shotComposition: string;
  visualAction: string;
  filmingMethod: string;
  previousHandoff: PanelStandingHandoff | null;
  sceneLighting: string;
  costumeState: string;
  sceneBackReferenceLine: string;
  sceneBackReferences: SceneBackReference[];
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
        shotComposition: panel.shotComposition,
        visualAction: panel.visualAction,
        filmingMethod: panel.filmingMethod,
        previousHandoff: panel.previousHandoff,
        sceneLighting: panel.sceneLighting,
        costumeState: panel.costumeState,
        sceneBackReferenceLine: formatSceneBackReferenceLineFromBoard({
          currentUnitId: unit.unitId,
          currentSequence: unit.sequence,
          currentPanelIndex: panel.panelIndex,
          currentPanelId: panel.panelId,
          currentMentions: panel.assetMentions,
          units: map.units,
        }),
        sceneBackReferences: listSceneBackReferences({
          currentUnitId: unit.unitId,
          currentSequence: unit.sequence,
          currentPanelIndex: panel.panelIndex,
          currentPanelId: panel.panelId,
          sceneMentions: listSceneAssetMentions(panel.assetMentions),
          units: map.units,
        }),
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

/** 纯：有任一宫格出图的单元数。 */
export function countCoveredUnits(
  units: Array<{ panels: Array<{ hasMedia: boolean }> }>,
): number {
  return units.filter((unit) => unit.panels.some((panel) => panel.hasMedia)).length;
}

async function summarizeScriptRevisionUnits(
  projectRoot: string,
  scriptRevisionId: string,
): Promise<{ linkedUnitCount: number; coveredMediaCount: number }> {
  // 经 list units 扫描头修订（有界页）；SSL-0 可接受 O(n) 投影
  let cursor: string | undefined;
  let linkedUnitCount = 0;
  let coveredMediaCount = 0;
  for (let page = 0; page < 50; page++) {
    const batch = await listStudioProductionUnits(projectRoot, { limit: 100, cursor });
    for (const u of batch.items) {
      try {
        const snap = await getStudioProductionUnitSnapshot(projectRoot, u.id);
        if (snap?.scriptRevision?.id !== scriptRevisionId) continue;
        linkedUnitCount += 1;
        let covered = false;
        for (const panel of snap.panels || []) {
          const media = await latestPackMedia(projectRoot, u.id, String(panel.id));
          if (media.rawSha256 || media.labeledSha256) {
            covered = true;
            break;
          }
        }
        if (covered) coveredMediaCount += 1;
      } catch {
        /* skip */
      }
    }
    if (!batch.nextCursor) break;
    cursor = batch.nextCursor;
  }
  return { linkedUnitCount, coveredMediaCount };
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
      const summary = await summarizeScriptRevisionUnits(projectRoot, headRevId);
      linkedUnitCount = summary.linkedUnitCount;
      coveredMediaCount = summary.coveredMediaCount;
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
  panelId: string,
): Promise<PackMediaPick> {
  const packs = await listStudioGenerationPacksByUnit(projectRoot, { unitId, panelId, limit: 20 });
  const ordered = listPanelPacksNewestFirst(packs.items, panelId);
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
 * 集级 unit→span→media 投影（只读）。每个宫格只读自己的 panel pack；unit-grid 不摊派。
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
      const mediaByPanelId = new Map<string, PackMediaPick>();
      for (const panel of snap.panels || []) {
        const panelId = String(panel.id);
        mediaByPanelId.set(panelId, await latestPackMedia(projectRoot, u.id, panelId));
      }
      const panels = applyPackMediaToPanels(snap.panels || [], mediaByPanelId);
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
