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
  CHARACTER_BACK_REFERENCE_LIMIT,
  PROP_BACK_REFERENCE_LIMIT,
  SCENE_BACK_REFERENCE_LIMIT,
  formatCharacterBackReferences,
  formatPropBackReferences,
  formatSceneBackReferences,
  type CharacterBackReference,
  type PropBackReference,
  type SceneBackReference,
} from "./studio-scene-backrefs.js";

export {
  CHARACTER_BACK_REFERENCE_LIMIT,
  PROP_BACK_REFERENCE_LIMIT,
  SCENE_BACK_REFERENCE_LIMIT,
  formatCharacterBackReferences,
  formatPropBackReferences,
  formatSceneBackReferences,
  type CharacterBackReference,
  type PropBackReference,
  type SceneBackReference,
} from "./studio-scene-backrefs.js";

export const SCRIPT_LIBRARY_PROJECTION_SCHEMA_VERSION = 1 as const;

/** 只读 LRU peek。未评估 ≠ 无法检查。不跑像素、不自动 Review PASS。 */
export type SpanMediaConsistencyPeek = {
  status: "cached" | "unevaluated";
  verdict?: "consistent" | "needs-review" | "drifted" | "not-checkable";
};

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
  startSeconds?: number;
  endSeconds?: number;
  durationSeconds?: number;
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

export type PanelShotTypeFields = {
  panelIndex?: number;
  shotType?: string;
};

/** 锁版本格原镜/扩写；不是 BindingSet，不能当 generation-ready。 */
export function formatPanelShotTypeLine(
  panel: PanelShotTypeFields | null | undefined,
): string {
  if (!panel) return "没有宫格可查镜头类型";
  const index = Number(panel.panelIndex);
  const prefix = Number.isFinite(index) ? `G${index} ` : "";
  const shotType = panel.shotType === "extension"
    ? "extension"
    : panel.shotType === "original"
      ? "original"
      : "";
  if (shotType === "extension") {
    return `扩写格：${prefix}必须与前一格连续，禁止重新起镜，禁止锚定原文。不是 BindingSet，不能当 generation-ready。`;
  }
  if (shotType === "original") {
    return `原镜：${prefix}必须锚定原文。不是 BindingSet，不能当 generation-ready。`;
  }
  return "锁版未记镜头类型。不是 BindingSet，不能当 generation-ready。";
}

export const UNIT_BEAT_SECONDS = 15;
export const UNIT_BEAT_PANEL_MIN = 2;
export const UNIT_BEAT_PANEL_MAX = 6;
export const UNIT_BEAT_PANEL_MIN_SECONDS = 1;

export type PanelBeatFields = {
  panelIndex?: number;
  startSeconds?: number;
  endSeconds?: number;
  durationSeconds?: number;
};

function normalizeBeatSeconds(value: unknown): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.round(seconds * 10) / 10 : 0;
}

/** 锁版本格 15s 节拍；不是 BindingSet，不能当 generation-ready。 */
export function formatPanelBeatLine(
  panel: PanelBeatFields | null | undefined,
): string {
  if (!panel) return "没有宫格可查 15s 节拍";
  const index = Number(panel.panelIndex);
  const prefix = Number.isFinite(index) ? `G${index} ` : "";
  const start = normalizeBeatSeconds(panel.startSeconds);
  const end = normalizeBeatSeconds(panel.endSeconds);
  let duration = normalizeBeatSeconds(panel.durationSeconds);
  if (duration <= 0 && end > start) duration = normalizeBeatSeconds(end - start);
  if (duration <= 0) {
    return "锁版未记 15s 节拍。不是 BindingSet，不能当 generation-ready。";
  }
  const gaps: string[] = [];
  if (duration < UNIT_BEAT_PANEL_MIN_SECONDS) gaps.push("单格不足 1.0s");
  if (duration > UNIT_BEAT_SECONDS) gaps.push("单格超过 15.0s");
  const gapText = gaps.length ? `缺口：${gaps.join("、")}。` : "";
  return `15s 节拍：${prefix}${start}–${end}s（${duration}s）。${gapText}本单元须 ${UNIT_BEAT_PANEL_MIN}–${UNIT_BEAT_PANEL_MAX} 格合计 ${UNIT_BEAT_SECONDS.toFixed(1)}s。不是 BindingSet，不能当 generation-ready。`;
}

/** 整单元 15s 节拍合计；不是 BindingSet，不能当 generation-ready。 */
export function formatUnitBeatLine(
  panels: ReadonlyArray<PanelBeatFields> | null | undefined,
): string {
  if (!panels?.length) return "没有宫格可查 15s 节拍";
  const count = panels.length;
  const durations = panels.map((panel) => {
    let duration = normalizeBeatSeconds(panel.durationSeconds);
    const start = normalizeBeatSeconds(panel.startSeconds);
    const end = normalizeBeatSeconds(panel.endSeconds);
    if (duration <= 0 && end > start) duration = normalizeBeatSeconds(end - start);
    return duration;
  });
  const marks = panels.map((panel, offset) => {
    const index = Number(panel.panelIndex);
    const prefix = Number.isFinite(index) ? `G${index}` : "G?";
    return `${prefix} ${durations[offset]}s`;
  });
  const rounded = normalizeBeatSeconds(durations.reduce((total, seconds) => total + seconds, 0));
  const gaps: string[] = [];
  if (count < UNIT_BEAT_PANEL_MIN || count > UNIT_BEAT_PANEL_MAX) {
    gaps.push(`格数 ${count}（须 ${UNIT_BEAT_PANEL_MIN}–${UNIT_BEAT_PANEL_MAX}）`);
  }
  if (Math.abs(rounded - UNIT_BEAT_SECONDS) > 0.05) {
    gaps.push(`合计 ${rounded}s（须 ${UNIT_BEAT_SECONDS.toFixed(1)}s）`);
  }
  if (gaps.length) {
    return `15s 节拍缺口：${gaps.join("、")} · ${marks.join(" · ")}。不是 BindingSet，不能当 generation-ready。`;
  }
  return `15s 节拍：${count} 格合计 ${rounded.toFixed(1)}s · ${marks.join(" · ")}。不是 BindingSet，不能当 generation-ready。`;
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

export function listPropAssetMentions(
  mentions: ReadonlyArray<{ assetId?: string; category?: string; role?: string }> | null | undefined,
): PanelAssetMentionLite[] {
  if (!mentions) return [];
  return mentions.flatMap((mention) => {
    const assetId = String(mention.assetId ?? "").trim();
    const category = String(mention.category ?? "").trim();
    if (!assetId || category !== "prop") return [];
    return [{ assetId, category, role: String(mention.role ?? "").trim() }];
  });
}

export function listCharacterAssetMentions(
  mentions: ReadonlyArray<{ assetId?: string; category?: string; role?: string }> | null | undefined,
): PanelAssetMentionLite[] {
  if (!mentions) return [];
  return mentions.flatMap((mention) => {
    const assetId = String(mention.assetId ?? "").trim();
    const category = String(mention.category ?? "").trim();
    if (!assetId || category !== "character") return [];
    return [{ assetId, category, role: String(mention.role ?? "").trim() }];
  });
}

export function listStyleAssetMentions(
  mentions: ReadonlyArray<{ assetId?: string; category?: string; role?: string }> | null | undefined,
): PanelAssetMentionLite[] {
  if (!mentions) return [];
  return mentions.flatMap((mention) => {
    const assetId = String(mention.assetId ?? "").trim();
    const category = String(mention.category ?? "").trim();
    if (!assetId || category !== "style") return [];
    return [{ assetId, category, role: String(mention.role ?? "").trim() }];
  });
}

/** 锁版本格风格控制参考；不是 BindingSet，不能当 generation-ready。不开 category=style 回指。 */
export function formatStyleLockLine(
  mentions: ReadonlyArray<{ assetId?: string; category?: string; role?: string }> | null | undefined,
): string {
  if (mentions == null) return "没有宫格可查风格锁";
  const style = listStyleAssetMentions(mentions);
  if (!style.length) {
    return "锁版未记风格控制参考。不是 BindingSet，不能当 generation-ready。";
  }
  const parts = style.map((mention) => {
    const role = mention.role.trim();
    return role ? `${mention.assetId} ${role}` : mention.assetId;
  });
  return `风格锁：${parts.join(" · ")}。跟随风格控制参考，禁止另起画风。不是 BindingSet，不能当 generation-ready。`;
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

/**
 * 跨单元道具回指：只扫已加载对照/episode 快照提及。
 * 不是 BindingSet，不能当 generation-ready。不读 head、不拆冻结包。
 */
export function listPropBackReferences(input: {
  currentUnitId: string;
  currentSequence: number;
  currentPanelIndex: number;
  currentPanelId: string;
  propMentions: ReadonlyArray<{ assetId: string; role?: string }>;
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
}): PropBackReference[] {
  const propIds = new Set(
    input.propMentions.map((mention) => mention.assetId.trim()).filter(Boolean),
  );
  if (!propIds.size) return [];
  const limit = Math.max(1, Math.min(input.limit ?? PROP_BACK_REFERENCE_LIMIT, PROP_BACK_REFERENCE_LIMIT));
  const rows: PropBackReference[] = [];
  const seen = new Set<string>();
  for (const unit of input.units) {
    for (const panel of unit.panels) {
      if (panel.panelId === input.currentPanelId && unit.unitId === input.currentUnitId) continue;
      if (!isEarlierPanel(unit.sequence, panel.panelIndex, input.currentSequence, input.currentPanelIndex)) {
        continue;
      }
      for (const mention of listPropAssetMentions(panel.assetMentions)) {
        if (!propIds.has(mention.assetId)) continue;
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

/**
 * 跨单元角色回指：只扫已加载对照/episode 快照提及。
 * 不是 BindingSet，不能当 generation-ready。不读 head、不拆冻结包。
 */
export function listCharacterBackReferences(input: {
  currentUnitId: string;
  currentSequence: number;
  currentPanelIndex: number;
  currentPanelId: string;
  characterMentions: ReadonlyArray<{ assetId: string; role?: string }>;
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
}): CharacterBackReference[] {
  const characterIds = new Set(
    input.characterMentions.map((mention) => mention.assetId.trim()).filter(Boolean),
  );
  if (!characterIds.size) return [];
  const limit = Math.max(1, Math.min(input.limit ?? CHARACTER_BACK_REFERENCE_LIMIT, CHARACTER_BACK_REFERENCE_LIMIT));
  const rows: CharacterBackReference[] = [];
  const seen = new Set<string>();
  for (const unit of input.units) {
    for (const panel of unit.panels) {
      if (panel.panelId === input.currentPanelId && unit.unitId === input.currentUnitId) continue;
      if (!isEarlierPanel(unit.sequence, panel.panelIndex, input.currentSequence, input.currentPanelIndex)) {
        continue;
      }
      for (const mention of listCharacterAssetMentions(panel.assetMentions)) {
        if (!characterIds.has(mention.assetId)) continue;
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

export const WIZARD_PROP_BACKREF_UNLOADED_NOTE =
  "对照板未加载，无法查道具回指。不是 BindingSet，不能当 generation-ready。";

export const WIZARD_CHARACTER_BACKREF_UNLOADED_NOTE =
  "对照板未加载，无法查角色回指。不是 BindingSet，不能当 generation-ready。";

export const WIZARD_STYLE_LOCK_UNLOADED_NOTE =
  "对照板未加载，不能查风格锁。不是 BindingSet，不能当 generation-ready。";

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

/** 建议资产只在已加载对照板里出现过 category=prop 才算道具提及。 */
export function wizardPropMentionsFromSuggestedIds(
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
  const propById = new Map<string, string>();
  for (const unit of units) {
    for (const panel of unit.panels) {
      for (const mention of listPropAssetMentions(panel.assetMentions)) {
        if (!suggested.has(mention.assetId) || propById.has(mention.assetId)) continue;
        propById.set(mention.assetId, mention.role);
      }
    }
  }
  return [...propById.entries()].map(([assetId, role]) => ({ assetId, category: "prop", role }));
}

/** 15s 向导：只扫已加载对照板。不写冻结提示词，不是 BindingSet。 */
export function formatWizardPropBackReferenceLine(input: {
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
  if (!input.boardLoaded) return WIZARD_PROP_BACKREF_UNLOADED_NOTE;
  const mentions = wizardPropMentionsFromSuggestedIds(input.suggestedAssetIds, input.units);
  return formatPropBackReferences(
    mentions.length,
    listPropBackReferences({
      currentUnitId: WIZARD_DRAFT_UNIT_ID,
      currentSequence: input.currentSequence,
      currentPanelIndex: input.currentPanelIndex,
      currentPanelId: `wizard-g${input.currentPanelIndex}`,
      propMentions: mentions,
      units: input.units,
    }),
  );
}

export function formatPropBackReferenceLineFromBoard(input: {
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
  const mentions = listPropAssetMentions(input.currentMentions);
  return formatPropBackReferences(mentions.length, listPropBackReferences({
    currentUnitId: input.currentUnitId,
    currentSequence: input.currentSequence,
    currentPanelIndex: input.currentPanelIndex,
    currentPanelId: input.currentPanelId,
    propMentions: mentions,
    units: input.units,
  }));
}

/** 建议资产只在已加载对照板里出现过 category=character 才算角色提及。 */
export function wizardCharacterMentionsFromSuggestedIds(
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
  const characterById = new Map<string, string>();
  for (const unit of units) {
    for (const panel of unit.panels) {
      for (const mention of listCharacterAssetMentions(panel.assetMentions)) {
        if (!suggested.has(mention.assetId) || characterById.has(mention.assetId)) continue;
        characterById.set(mention.assetId, mention.role);
      }
    }
  }
  return [...characterById.entries()].map(([assetId, role]) => ({ assetId, category: "character", role }));
}

/** 15s 向导：只扫已加载对照板。不写冻结提示词，不是 BindingSet。 */
export function formatWizardCharacterBackReferenceLine(input: {
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
  if (!input.boardLoaded) return WIZARD_CHARACTER_BACKREF_UNLOADED_NOTE;
  const mentions = wizardCharacterMentionsFromSuggestedIds(input.suggestedAssetIds, input.units);
  return formatCharacterBackReferences(
    mentions.length,
    listCharacterBackReferences({
      currentUnitId: WIZARD_DRAFT_UNIT_ID,
      currentSequence: input.currentSequence,
      currentPanelIndex: input.currentPanelIndex,
      currentPanelId: `wizard-g${input.currentPanelIndex}`,
      characterMentions: mentions,
      units: input.units,
    }),
  );
}

/** 建议资产只在已加载对照板里出现过 category=style 才算风格提及。不开 style 回指。 */
export function wizardStyleMentionsFromSuggestedIds(
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
  const styleById = new Map<string, string>();
  for (const unit of units) {
    for (const panel of unit.panels) {
      for (const mention of listStyleAssetMentions(panel.assetMentions)) {
        if (!suggested.has(mention.assetId) || styleById.has(mention.assetId)) continue;
        styleById.set(mention.assetId, mention.role);
      }
    }
  }
  return [...styleById.entries()].map(([assetId, role]) => ({ assetId, category: "style", role }));
}

/** 15s 向导：只扫已加载对照板。不写冻结提示词，不是 BindingSet。 */
export function formatWizardStyleLockLine(input: {
  boardLoaded: boolean;
  suggestedAssetIds?: ReadonlyArray<string> | null;
  units: ReadonlyArray<{
    panels: ReadonlyArray<{
      assetMentions: ReadonlyArray<{ assetId: string; category: string; role?: string }>;
    }>;
  }>;
}): string {
  if (!input.boardLoaded) return WIZARD_STYLE_LOCK_UNLOADED_NOTE;
  return formatStyleLockLine(wizardStyleMentionsFromSuggestedIds(input.suggestedAssetIds, input.units));
}

export function formatCharacterBackReferenceLineFromBoard(input: {
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
  const mentions = listCharacterAssetMentions(input.currentMentions);
  return formatCharacterBackReferences(mentions.length, listCharacterBackReferences({
    currentUnitId: input.currentUnitId,
    currentSequence: input.currentSequence,
    currentPanelIndex: input.currentPanelIndex,
    currentPanelId: input.currentPanelId,
    characterMentions: mentions,
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
    startSeconds?: number;
    endSeconds?: number;
    durationSeconds?: number;
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
      startSeconds: normalizeBeatSeconds(panel.startSeconds),
      endSeconds: normalizeBeatSeconds(panel.endSeconds),
      durationSeconds: (() => {
        const duration = normalizeBeatSeconds(panel.durationSeconds);
        if (duration > 0) return duration;
        const start = normalizeBeatSeconds(panel.startSeconds);
        const end = normalizeBeatSeconds(panel.endSeconds);
        return end > start ? normalizeBeatSeconds(end - start) : 0;
      })(),
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
  shotType?: "original" | "extension";
  shotTypeLine: string;
  styleLockLine: string;
  startSeconds?: number;
  endSeconds?: number;
  durationSeconds?: number;
  beatLine: string;
  sceneBackReferenceLine: string;
  sceneBackReferences: SceneBackReference[];
  propBackReferenceLine: string;
  propBackReferences: PropBackReference[];
  characterBackReferenceLine: string;
  characterBackReferences: CharacterBackReference[];
  /** 只读 LRU peek。未评估 ≠ 无法检查。机器不自动 Review PASS。 */
  consistencyPeek: SpanMediaConsistencyPeek;
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
        shotType: panel.shotType === "extension" || panel.shotType === "original" ? panel.shotType : undefined,
        shotTypeLine: formatPanelShotTypeLine(panel),
        styleLockLine: formatStyleLockLine(panel.assetMentions),
        startSeconds: panel.startSeconds,
        endSeconds: panel.endSeconds,
        durationSeconds: panel.durationSeconds,
        beatLine: formatPanelBeatLine(panel),
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
        propBackReferenceLine: formatPropBackReferenceLineFromBoard({
          currentUnitId: unit.unitId,
          currentSequence: unit.sequence,
          currentPanelIndex: panel.panelIndex,
          currentPanelId: panel.panelId,
          currentMentions: panel.assetMentions,
          units: map.units,
        }),
        propBackReferences: listPropBackReferences({
          currentUnitId: unit.unitId,
          currentSequence: unit.sequence,
          currentPanelIndex: panel.panelIndex,
          currentPanelId: panel.panelId,
          propMentions: listPropAssetMentions(panel.assetMentions),
          units: map.units,
        }),
        characterBackReferenceLine: formatCharacterBackReferenceLineFromBoard({
          currentUnitId: unit.unitId,
          currentSequence: unit.sequence,
          currentPanelIndex: panel.panelIndex,
          currentPanelId: panel.panelId,
          currentMentions: panel.assetMentions,
          units: map.units,
        }),
        characterBackReferences: listCharacterBackReferences({
          currentUnitId: unit.unitId,
          currentSequence: unit.sequence,
          currentPanelIndex: panel.panelIndex,
          currentPanelId: panel.panelId,
          characterMentions: listCharacterAssetMentions(panel.assetMentions),
          units: map.units,
        }),
        consistencyPeek: { status: "unevaluated" },
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

export function attachSpanMediaConsistencyPeeks(
  map: ScriptSpanMediaMap,
  verdictByRunId: ReadonlyMap<string, SpanMediaConsistencyPeek["verdict"]>,
): ScriptSpanMediaMap {
  return {
    ...map,
    hits: map.hits.map((hit) => {
      const verdict = hit.generationRunId ? verdictByRunId.get(hit.generationRunId) : undefined;
      return {
        ...hit,
        consistencyPeek: verdict
          ? { status: "cached", verdict }
          : { status: "unevaluated" },
      };
    }),
  };
}

async function loadSpanMediaConsistencyPeeks(
  map: ScriptSpanMediaMap,
): Promise<Map<string, NonNullable<SpanMediaConsistencyPeek["verdict"]>>> {
  const runIds = [...new Set(
    map.hits.map((hit) => hit.generationRunId).filter((id): id is string => Boolean(id)),
  )];
  if (runIds.length === 0) return new Map();
  const { peekStudioConsistencyVerdictByRunId } = await import("./studio-consistency-evaluator.js");
  const out = new Map<string, NonNullable<SpanMediaConsistencyPeek["verdict"]>>();
  for (const runId of runIds) {
    const verdict = peekStudioConsistencyVerdictByRunId(runId);
    if (verdict) out.set(runId, verdict);
  }
  return out;
}

/** 只读 LRU 挂 peek。无 run / 未入缓存 → unevaluated。不跑像素。 */
export async function withSpanMediaConsistencyPeeks(
  map: ScriptSpanMediaMap,
): Promise<ScriptSpanMediaMap> {
  return attachSpanMediaConsistencyPeeks(map, await loadSpanMediaConsistencyPeeks(map));
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
  return withSpanMediaConsistencyPeeks(resolveScriptSpanMediaMap(map, {
    startOffsetUtf16: query.startOffsetUtf16,
    endOffsetUtf16: query.endOffsetUtf16,
  }));
}

export async function getStudioEpisodeMissingMediaReport(
  projectRoot: string,
  query: { season: string; episode: string; limit?: number },
): Promise<MissingMediaReport> {
  const map = await getStudioEpisodeUnitMediaMap(projectRoot, query);
  return buildMissingMediaReport(map);
}
