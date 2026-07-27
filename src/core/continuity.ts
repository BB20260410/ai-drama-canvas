import { loadFusionContinuityStore, type MaterializedContinuitySpan, type MaterializedContinuityTrack } from "./fusion-production.js";
import type { ProductionAssetCategory } from "./fusion-package.js";
import { getProjectIndex } from "./service.js";

const TRACK_PAGE_DEFAULT = 30;
const TRACK_PAGE_MAX = 100;
const SPAN_PAGE_DEFAULT = 80;
const SPAN_PAGE_MAX = 200;
const CATEGORY_ORDER: Record<ProductionAssetCategory, number> = { character: 0, scene: 1, prop: 2 };

export interface ContinuityAppearancePoint {
  episode: string;
  episodeNumber: number;
  unitId: string;
  unitSequence: number;
  unitItemId: string;
  startSeconds: number;
  endSeconds: number;
}

export interface ContinuityTrackSummary {
  assetId: string;
  assetName: string;
  category: ProductionAssetCategory;
  workItemId: string;
  episodeCodes: string[];
  unitCount: number;
  spanCount: number;
  episodeSpanCounts: Record<string, number>;
  firstAppearance?: ContinuityAppearancePoint;
  lastAppearance?: ContinuityAppearancePoint;
}

export interface ContinuityTrackQuery {
  category?: ProductionAssetCategory;
  assetId?: string;
  search?: string;
  episode?: number;
  offset?: number;
  limit?: number;
}

export interface ContinuitySpanQuery {
  episode?: number;
  offset?: number;
  limit?: number;
}

export interface ContinuityTrackPage {
  available: boolean;
  sourceContentAddress?: `sha256:${string}`;
  updatedAt?: string;
  total: number;
  offset: number;
  limit: number;
  items: ContinuityTrackSummary[];
}

export interface ContinuitySpanPage {
  available: boolean;
  sourceContentAddress?: `sha256:${string}`;
  updatedAt?: string;
  track?: ContinuityTrackSummary;
  total: number;
  offset: number;
  limit: number;
  items: MaterializedContinuitySpan[];
}

function pageInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < (label === "offset" ? 0 : 1) || normalized > maximum) {
    throw new Error(`${label} 必须是 ${label === "offset" ? `0..${maximum}` : `1..${maximum}`} 的整数。`);
  }
  return normalized;
}

function episodeNumber(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 999) throw new Error("episode 必须是 1..999 的整数。");
  return value;
}

function compareSpans(left: MaterializedContinuitySpan, right: MaterializedContinuitySpan): number {
  return left.episodeNumber - right.episodeNumber
    || left.unitSequence - right.unitSequence
    || left.startSeconds - right.startSeconds
    || left.endSeconds - right.endSeconds
    || left.id.localeCompare(right.id);
}

function appearance(span: MaterializedContinuitySpan | undefined): ContinuityAppearancePoint | undefined {
  if (!span) return undefined;
  return {
    episode: span.episode,
    episodeNumber: span.episodeNumber,
    unitId: span.unitId,
    unitSequence: span.unitSequence,
    unitItemId: span.unitItemId,
    startSeconds: span.startSeconds,
    endSeconds: span.endSeconds,
  };
}

function summarizeTrack(track: MaterializedContinuityTrack): ContinuityTrackSummary {
  const spans = [...track.spans].sort(compareSpans);
  const episodeSpanCounts: Record<string, number> = {};
  for (const span of spans) episodeSpanCounts[span.episode] = (episodeSpanCounts[span.episode] ?? 0) + 1;
  return {
    assetId: track.assetId,
    assetName: track.assetName,
    category: track.category,
    workItemId: track.workItemId,
    episodeCodes: [...new Set(spans.map((span) => span.episode))],
    unitCount: new Set(spans.map((span) => span.unitItemId)).size,
    spanCount: spans.length,
    episodeSpanCounts,
    firstAppearance: appearance(spans[0]),
    lastAppearance: appearance(spans.at(-1)),
  };
}

function validateTrack(track: MaterializedContinuityTrack): void {
  if (!/^[CSP]\d{2}[a-z]?$/u.test(track.assetId)) throw new Error(`连续性轨道资产 ID 无效：${track.assetId}`);
  if (!(["character", "scene", "prop"] as const).includes(track.category)) throw new Error(`连续性轨道分类无效：${track.assetId}`);
  if (!track.workItemId.trim()) throw new Error(`连续性轨道缺少工作项 ID：${track.assetId}`);
  if (!Array.isArray(track.spans)) throw new Error(`连续性轨道 spans 无效：${track.assetId}`);
  for (const span of track.spans) {
    if (span.assetId !== track.assetId) throw new Error(`连续性跨度资产归属冲突：${span.id}`);
    if (!span.unitItemId?.trim()) throw new Error(`连续性跨度缺少 unit 工作项：${span.id}`);
    if (!Number.isFinite(span.startSeconds) || !Number.isFinite(span.endSeconds) || span.startSeconds < 0 || span.endSeconds <= span.startSeconds || span.endSeconds > 15.001) {
      throw new Error(`连续性跨度秒段无效：${span.id}`);
    }
  }
}

async function continuityTracks(projectRoot: string): Promise<{
  sourceContentAddress: `sha256:${string}`;
  updatedAt: string;
  tracks: MaterializedContinuityTrack[];
} | null> {
  const store = await loadFusionContinuityStore(projectRoot);
  if (!store) return null;
  if (store.schemaVersion !== 1 || store.kind !== "fusion-continuity-tracks" || !/^sha256:[a-f0-9]{64}$/u.test(store.sourceContentAddress)) {
    throw new Error("连续性时间线侧车合同无效。");
  }
  const ids = new Set<string>();
  for (const track of store.tracks) {
    validateTrack(track);
    if (ids.has(track.assetId)) throw new Error(`连续性时间线存在重复资产轨道：${track.assetId}`);
    ids.add(track.assetId);
  }
  return { sourceContentAddress: store.sourceContentAddress, updatedAt: store.updatedAt, tracks: store.tracks };
}

export async function listContinuityTracks(projectRoot: string, query: ContinuityTrackQuery = {}): Promise<ContinuityTrackPage> {
  const offset = pageInteger(query.offset, 0, Number.MAX_SAFE_INTEGER, "offset");
  const limit = pageInteger(query.limit, TRACK_PAGE_DEFAULT, TRACK_PAGE_MAX, "limit");
  const episode = episodeNumber(query.episode);
  if (query.category && !(["character", "scene", "prop"] as const).includes(query.category)) throw new Error("category 格式无效。");
  const needle = query.search?.normalize("NFKC").trim().toLocaleLowerCase("zh-CN") ?? "";
  if (needle.length > 200) throw new Error("search 最多 200 个字符。");
  const assetId = query.assetId?.trim();
  if (assetId && !/^[CSP]\d{2}[a-z]?$/u.test(assetId)) throw new Error("assetId 格式无效。");
  const store = await continuityTracks(projectRoot);
  if (!store) return { available: false, total: 0, offset, limit, items: [] };
  const items = store.tracks
    .filter((track) => !query.category || track.category === query.category)
    .filter((track) => !assetId || track.assetId === assetId)
    .filter((track) => episode === undefined || track.spans.some((span) => span.episodeNumber === episode))
    .filter((track) => !needle || `${track.assetId} ${track.assetName}`.normalize("NFKC").toLocaleLowerCase("zh-CN").includes(needle))
    .sort((left, right) => CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category] || left.assetId.localeCompare(right.assetId, "en", { numeric: true }))
    .map(summarizeTrack);
  return {
    available: true,
    sourceContentAddress: store.sourceContentAddress,
    updatedAt: store.updatedAt,
    total: items.length,
    offset,
    limit,
    items: items.slice(offset, offset + limit),
  };
}

export async function getContinuitySpans(projectRoot: string, assetId: string, query: ContinuitySpanQuery = {}): Promise<ContinuitySpanPage> {
  const normalizedAssetId = assetId.trim();
  if (!/^[CSP]\d{2}[a-z]?$/u.test(normalizedAssetId)) throw new Error("assetId 格式无效。");
  const offset = pageInteger(query.offset, 0, Number.MAX_SAFE_INTEGER, "offset");
  const limit = pageInteger(query.limit, SPAN_PAGE_DEFAULT, SPAN_PAGE_MAX, "limit");
  const episode = episodeNumber(query.episode);
  const store = await continuityTracks(projectRoot);
  if (!store) return { available: false, total: 0, offset, limit, items: [] };
  const track = store.tracks.find((candidate) => candidate.assetId === normalizedAssetId);
  if (!track) throw new Error(`找不到连续性资产轨道：${normalizedAssetId}`);
  const spans = [...track.spans]
    .filter((span) => episode === undefined || span.episodeNumber === episode)
    .sort(compareSpans);
  const items = spans.slice(offset, offset + limit);
  if (spans.length) {
    const index = await getProjectIndex(projectRoot);
    const unitIds = new Set(index.items.filter((item) => item.type === "unit").map((item) => item.id));
    const missing = [...new Set(spans.map((span) => span.unitItemId).filter((unitItemId) => !unitIds.has(unitItemId)))];
    if (missing.length) throw new Error(`连续性跨度引用不存在的 unit 工作项：${missing.join("、")}`);
  }
  return {
    available: true,
    sourceContentAddress: store.sourceContentAddress,
    updatedAt: store.updatedAt,
    track: summarizeTrack(track),
    total: spans.length,
    offset,
    limit,
    items,
  };
}
