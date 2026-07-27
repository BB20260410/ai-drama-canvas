/**
 * T12/T13 前端投影加载 composable。
 *
 * 封装批量时间线投影、双编号显示、搜索功能。
 * Vue 组件可增量引入此 composable，无需大规模重构。
 *
 * 用法：
 * ```vue
 * import { useStudioTimelineProjection } from "../composables/useStudioTimelineProjection";
 * const { projection, loading, error, refresh, searchUnits } = useStudioTimelineProjection(projectRoot);
 * ```
 */
import { ref, computed, getCurrentScope, onScopeDispose, type Ref } from "vue";

/** 从 preload 桥接获取 API（避免直接 import core 模块到渲染进程）。 */
function getCanvasApi(): any {
  return (window as any).canvasApi;
}

export interface TimelineUnitDisplay {
  unitId: string;
  displaySequence: number;
  displayLabel: string;
  title: string;
  productionStatus: string;
  selectedRawSha256: string | null;
  /** 核心选中的 labeled SHA（与 selectedRawSha256 成对；fastMode 缺口时为 null）。 */
  selectedLabeledSha256?: string | null;
  /** 核心选中结果来源（核心增强字段，最终对齐；落地前为可选，消费端按 SHA 确定性回退）。 */
  selectedResultSource?: string | null;
  /** 历史导入 id（selectedResultSource=historical-import 时）。 */
  historicalImportId?: string | null;
  /** 正式 run id（selectedResultSource=generation-run 时）。 */
  selectedGenerationRunId?: string | null;
  /** 选中结果冻结包 fingerprint。 */
  selectedPackFingerprint?: string | null;
  /** 核心在同一 SQLite 快照内闭合的当前 PASS 执行身份。 */
  selectedRunExecutionIdentity?: {
    generationRunId: string;
    provider: "codex" | "grok";
    packId: string;
    packFingerprint: string;
    reviewId: string;
    reviewFingerprint: string;
    continuityFingerprint: string;
    postResultObservationHeadPresent: boolean;
    rawResultId: string;
    rawMediaSha256: string;
    labeledResultId: string;
    labeledMediaSha256: string;
  } | null;
  /** 核心参考闭包状态（核心增强字段，最终对齐；落地前为可选）。 */
  referenceClosureStatus?: string | null;
  latestRunId: string | null;
  reviewStatus: string | null;
  panelCount: number;
  candidateWarning: string | null;
  projectionError: string | null;
}

export interface TimelineSummary {
  pass: number;
  pendingReview: number;
  inProgress: number;
  failed: number;
  blocked: number;
}

export interface TimelineProjectionScopeUnit {
  seasonId: string;
  episodeId: string;
}

export interface TimelineProjectionScope {
  season: string;
  episode: string;
}

/**
 * 解析当前画布可安全查询的唯一季集。
 *
 * 明确选择了季和集时直接使用；否则只在当前单元页全部属于同一季集时推导。
 * 多季集混排时返回 null，禁止用 S1E1 默认值污染 S1E2 或其他集。
 */
export function resolveTimelineProjectionScope(input: {
  season?: string;
  episode?: string;
  units?: TimelineProjectionScopeUnit[];
}): TimelineProjectionScope | null {
  const season = input.season?.trim() ?? "";
  const episode = input.episode?.trim() ?? "";
  if (season && episode) return { season, episode };
  const scopes = new Map<string, TimelineProjectionScope>();
  for (const unit of input.units ?? []) {
    const unitSeason = unit.seasonId.trim();
    const unitEpisode = unit.episodeId.trim();
    if (!unitSeason || !unitEpisode) continue;
    scopes.set(`${unitSeason}\u0000${unitEpisode}`, { season: unitSeason, episode: unitEpisode });
  }
  return scopes.size === 1 ? [...scopes.values()][0]! : null;
}

export function useStudioTimelineProjection(projectRoot: Ref<string> | string) {
  const projection = ref<TimelineUnitDisplay[] | null>(null);
  const summary = ref<TimelineSummary | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const lastUpdated = ref<string | null>(null);

  const root = computed(() => typeof projectRoot === "string" ? projectRoot : projectRoot.value);

  // 异步 token 绑定（对齐 studio-production-dashboard-store 的 root+seq 语义）：
  // 每条流（refresh / continuous）各自单调递增 seq；落地前校验“发起时 root === 当前
  // root 且 seq 最新”，切项目/卸载/显式失效后的旧响应一律丢弃，不写回投影。
  let refreshSeq = 0;
  let continuousSeq = 0;

  /** 使两条流的在途请求全部失效（切项目/卸载时调用）。 */
  function invalidate(): void {
    refreshSeq += 1;
    continuousSeq += 1;
  }

  /** 失效在途请求并清空投影/summary，供切项目时同步重置显示。 */
  function reset(): void {
    invalidate();
    projection.value = null;
    summary.value = null;
    error.value = null;
    lastUpdated.value = null;
    loading.value = false;
  }

  // 组件卸载时自动使在途请求失效（仅在 setup 作用域内使用时注册）。
  if (getCurrentScope()) onScopeDispose(invalidate);

  /** 刷新批量时间线投影（fastMode <1s）。 */
  async function refresh(season: string, episode: string) {
    const requestRoot = root.value;
    refreshSeq += 1;
    const seq = refreshSeq;
    const isCurrent = () => seq === refreshSeq && requestRoot === root.value;
    loading.value = true;
    error.value = null;
    try {
      const api = getCanvasApi();
      if (!api?.getApprovedTimelineProjection) {
        if (isCurrent()) error.value = "canvasApi.getApprovedTimelineProjection 不可用";
        return;
      }
      const result = await api.getApprovedTimelineProjection(requestRoot, {
        season,
        episode,
        fastMode: true,
      });
      // 旧响应（发起后 root 已切换、已有更新的 refresh、或已 invalidate）直接丢弃。
      if (!isCurrent()) return;
      projection.value = result.units;
      summary.value = result.summary;
      lastUpdated.value = result.builtAt;
    } catch (e) {
      if (isCurrent()) error.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (isCurrent()) loading.value = false;
    }
  }

  /** 搜索单元（支持 029、U28、S1E01-U28、unitId 多种形式）。 */
  function searchUnits(query: string): TimelineUnitDisplay[] {
    if (!projection.value || !query.trim()) return projection.value ?? [];
    const q = query.trim().toLowerCase();
    return projection.value.filter((unit) => {
      // 匹配序号 "029"
      if (String(unit.displaySequence).padStart(3, "0") === q) return true;
      // 匹配 unitId
      if (unit.unitId.toLowerCase().includes(q)) return true;
      // 匹配 displayLabel
      if (unit.displayLabel.toLowerCase().includes(q)) return true;
      // 匹配标题
      if (unit.title.toLowerCase().includes(q)) return true;
      return false;
    });
  }

  /** 按状态过滤。 */
  function filterByStatus(status: string): TimelineUnitDisplay[] {
    if (!projection.value) return [];
    if (!status || status === "all") return projection.value;
    return projection.value.filter((u) => u.productionStatus === status);
  }

  /** 获取持续生图状态机投影。 */
  async function getContinuousState(season: string, episode: string) {
    const api = getCanvasApi();
    if (!api?.getContinuousGenerationState) return null;
    const requestRoot = root.value;
    continuousSeq += 1;
    const seq = continuousSeq;
    const result = await api.getContinuousGenerationState(requestRoot, { season, episode });
    // 切项目/卸载或已有更新请求时，旧响应作废，不向调用方交付。
    if (seq !== continuousSeq || requestRoot !== root.value) return null;
    return result;
  }

  return {
    projection,
    summary,
    loading,
    error,
    lastUpdated,
    refresh,
    searchUnits,
    filterByStatus,
    getContinuousState,
    invalidate,
    reset,
  };
}
