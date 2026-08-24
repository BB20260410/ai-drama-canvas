<template>
  <section
    class="production-dashboard"
    data-testid="studio-production-dashboard-view"
    :aria-busy="loading">
    <header class="dashboard-header">
      <div class="identity">
        <span class="eyebrow">生产总览</span>
        <h2>{{ overview?.projectName || projectName || "生产驾驶舱" }}</h2>
        <p>查看全剧进度、异常和当前唯一下一步</p>
      </div>
      <div class="next-action" data-testid="dashboard-next-action" :class="nextActionClass">
        <span>唯一下一步</span>
        <strong>{{ currentNextAction?.label || "加载中…" }}</strong>
        <p>{{ friendlyDashboardText(currentNextAction?.reason || "") }}</p>
        <details v-if="currentNextAction?.command || currentNextAction?.locator" class="diagnostic-details">
          <summary data-testid="studio-dashboard-next-action-diagnostics">诊断详情</summary>
          <code v-if="currentNextAction?.command">命令：{{ currentNextAction.command }}</code>
          <code v-if="currentNextAction?.locator?.unitId">单元：{{ currentNextAction.locator.unitId }}</code>
          <code v-if="currentNextAction?.locator?.panelId">宫格：{{ currentNextAction.locator.panelId }}</code>
          <code v-if="currentNextAction?.locator?.assetId">资产：{{ currentNextAction.locator.assetId }}</code>
        </details>
      </div>
      <button type="button" class="quiet-action" :disabled="loading" @click="refreshAll">
        刷新
      </button>
    </header>

    <div v-if="errorMessage" class="error-banner" data-testid="dashboard-error">{{ errorMessage }}</div>

    <div class="dashboard-body">
      <aside class="left-rail" aria-label="单元与队列">
        <div class="rail-block">
          <div class="rail-heading">
            <span>季 / 集 / 单元</span>
            <small>{{ unitsPage?.page.total ?? unitsPage?.page.items.length ?? 0 }}</small>
          </div>
          <div class="facet-row">
            <select v-model="seasonFilter" data-testid="dashboard-season-filter" @change="reloadUnits">
              <option value="">全部季</option>
              <option v-for="season in unitsPage?.seasons ?? []" :key="season.id" :value="season.id">
                {{ season.label }}
              </option>
            </select>
            <select v-model="episodeFilter" data-testid="dashboard-episode-filter" @change="reloadUnits">
              <option value="">全部集</option>
              <option
                v-for="episode in filteredEpisodes"
                :key="`${episode.seasonId}:${episode.id}`"
                :value="episode.id">
                {{ episode.label }}
              </option>
            </select>
          </div>
          <ul class="unit-list" data-testid="dashboard-unit-list">
            <li v-for="unit in unitsPage?.page.items ?? []" :key="unit.id">
              <button
                type="button"
                class="unit-entry"
                :class="{ active: selectedUnitId === unit.id }"
                :data-unit-id="unit.id"
                @click="selectUnit(unit.id)">
                <strong>{{ unit.label }}</strong>
                <span>{{ unit.episodeId }} · {{ unit.panelCount }} 格 · {{ bindingStatusLabel(unit.status) }}</span>
              </button>
            </li>
          </ul>
          <div class="pager">
            <button type="button" :disabled="!unitsCursorStack.length || isStreamBusy('units')" @click="unitsPrev">上一页</button>
            <button type="button" :disabled="!unitsPage?.page.nextCursor || isStreamBusy('units')" @click="unitsNext">下一页</button>
          </div>
        </div>

        <div class="rail-block">
          <div class="rail-heading"><span>异常队列</span></div>
          <div class="queue-tabs" role="tablist">
            <button
              v-for="queue in queueKinds"
              :key="queue"
              type="button"
              role="tab"
              :class="{ active: activeQueue === queue }"
              :data-queue="queue"
              @click="selectQueue(queue)">
              {{ queueLabel(queue) }}
              <small v-if="overview">{{ formatQueueTotal(overview.queueTotals[queue]) }}</small>
            </button>
          </div>
          <ul class="queue-list" data-testid="dashboard-queue-list">
            <li v-for="item in queuePage?.page.items ?? []" :key="item.id">
              <button type="button" class="queue-entry" @click="jumpLocator(item.locator)">
                <strong>{{ item.title }}</strong>
                <span>{{ item.reason }}</span>
              </button>
            </li>
            <li v-if="!(queuePage?.page.items.length)" class="empty">队列为空</li>
          </ul>
          <div class="pager" data-testid="dashboard-queue-pager">
            <button type="button" :disabled="!queueCursorStack.length || isStreamBusy('queue')" @click="queuePrev">上一页</button>
            <button type="button" :disabled="!queuePage?.page.nextCursor || isStreamBusy('queue')" @click="queueNext">下一页</button>
          </div>
        </div>
      </aside>

      <main class="center-stage" aria-label="当前单元宫格">
        <div
          v-if="!unitDetail"
          class="empty-stage empty-stage-guided"
          data-testid="dashboard-empty-unit-guide">
          <strong>还没有选中单元</strong>
          <p>从左侧选一个 15 秒单元，可看 2–6 宫格进度与绑定状态。</p>
          <ol class="empty-guide-steps">
            <li>看上方「唯一下一步」</li>
            <li>点左侧单元（或从异常队列跳入）</li>
            <li>在画布打开本单元继续生成/审片</li>
          </ol>
          <p v-if="currentNextAction?.label" class="empty-guide-next">
            当前建议：{{ currentNextAction.label }}
          </p>
        </div>
        <template v-else>
          <div class="unit-meta">
            <h3>{{ unitDetail.unit.label }}</h3>
            <span>{{ unitDetail.unit.seasonId }} / {{ unitDetail.unit.episodeId }} · {{ unitDetail.unit.durationSeconds }} 秒</span>
            <button type="button" class="open-canvas-link" data-testid="dashboard-open-canvas-unit" @click="openCanvasForUnit">
              在画布中打开本单元
            </button>
          </div>
          <div class="panel-grid" data-testid="dashboard-panel-grid">
            <article
              v-for="panel in unitDetail.panels"
              :key="panel.id"
              class="panel-card"
              :class="{ active: selectedPanelId === panel.id }"
              :data-panel-id="panel.id">
              <button
                type="button"
                class="panel-select"
                :aria-pressed="selectedPanelId === panel.id"
                @click="selectPanel(panel.id)">
                <span class="panel-card-heading">
                  <strong>{{ panel.ordinal }}. {{ panel.label }}</strong>
                  <span>{{ panel.startSeconds }}–{{ panel.endSeconds }} 秒</span>
                </span>
                <span class="panel-card-description">{{ panel.visualAction || panel.statusReason || bindingStatusLabel(panel.status) }}</span>
                <span class="panel-card-footer">
                  <span>{{ currentnessLabel(panel.bindingCurrentness) }}</span>
                  <span>{{ panel.assetIds.length }} 资产</span>
                </span>
              </button>
              <button
                type="button"
                class="open-canvas-link panel-canvas-action"
                data-testid="dashboard-open-canvas"
                @click="openCanvasForPanel(panel.id)">
                在画布中打开
              </button>
            </article>
          </div>
          <p class="hard-cap-note">为保持流畅，单元和资产按页加载；画布内容不会一次全部塞进界面。</p>
        </template>
      </main>

      <aside class="right-rail" aria-label="宫格控制面">
        <div
          v-if="!unitDetail?.selectedPanel"
          class="empty-stage empty-stage-guided"
          data-testid="dashboard-empty-panel-guide">
          <strong>还没有选中宫格</strong>
          <p>点中间某一格，查看准备清单、生成预览与审片状态。</p>
          <p v-if="currentNextAction?.locator?.panelId" class="empty-guide-next">
            建议宫格：{{ currentNextAction.locator.panelId }}
          </p>
        </div>
        <template v-else>
          <section class="detail-block" data-testid="dashboard-preparation-checklist">
            <h4>生成前准备清单</h4>
            <p class="prep-summary" data-testid="dashboard-prep-ready">
              {{ preparationChecklist?.readyForGeneration ? "可进入生成门禁" : `待处理 ${preparationChecklist?.pendingCount ?? 0} 项` }}
            </p>
            <ul class="prep-list">
              <li
                v-for="item in preparationChecklist?.items ?? []"
                :key="item.id"
                :data-check-id="item.id"
                :class="{ ready: item.ready, blocked: !item.ready }">
                <strong>{{ item.ready ? "✓" : "·" }} {{ item.label }}</strong>
                <span>{{ displayReasonText(item.reason) }}</span>
                <details v-if="isTechnicalReasonText(item.reason)" class="diagnostic-details"><summary data-testid="studio-dashboard-prep-diagnostics">诊断详情</summary><code>{{ item.reason }}</code></details>
              </li>
            </ul>
          </section>
          <section v-if="generationPreflight" class="detail-block" data-testid="dashboard-generation-preflight">
            <h4>生成前预览</h4>
            <p class="prep-summary" data-testid="dashboard-preflight-dispatch">
              {{ generationPreflight.canDispatch ? `可交给 ${providerLabel(generationPreflight.provider)} 生图` : "暂不可派发" }}
            </p>
            <ul class="prep-list">
              <li v-for="(reason, idx) in generationPreflight.reasons" :key="idx" class="blocked">
                <span>{{ displayReasonText(reason) }}</span>
                <details v-if="isTechnicalReasonText(reason)" class="diagnostic-details"><summary data-testid="studio-dashboard-preflight-diagnostics">诊断详情</summary><code>{{ reason }}</code></details>
              </li>
              <li v-if="!generationPreflight.reasons.length" class="ready">
                <span>准备项与冻结包已通过。</span>
              </li>
            </ul>
            <p class="ledger-status">
              正式供应方：{{ providerLabel(generationPreflight.provider) }} · {{ generationPreflight.queueInFlightKnown ? `队列进行中 ${generationPreflight.queueInFlight}` : "进行中数量由受管账本决定" }}
            </p>
          </section>
          <section class="detail-block">
            <h4>控制资产</h4>
            <ul data-testid="dashboard-control-assets">
              <li v-for="(asset, assetIndex) in unitDetail.selectedPanel.controlAssets" :key="asset.assetId">
                <button type="button" @click="openAsset(asset.assetId)">
                  {{ categoryLabel(asset.category) }} {{ assetIndex + 1 }} · {{ asset.assetName }}
                  <small>{{ asset.role || "查看规范资产及全部出场" }}</small>
                </button>
                <details class="diagnostic-details"><summary data-testid="studio-dashboard-asset-diagnostics">诊断详情</summary><code>{{ asset.assetId }}</code></details>
              </li>
              <li v-if="!unitDetail.selectedPanel.controlAssets.length" class="empty">无控制资产</li>
            </ul>
          </section>
          <section class="detail-block">
            <h4>资产绑定</h4>
            <p>{{ currentnessLabel(unitDetail.selectedPanel.panel.bindingCurrentness) }}</p>
            <details v-if="unitDetail.selectedPanel.panel.bindingFingerprint" class="diagnostic-details">
              <summary data-testid="studio-dashboard-binding-diagnostics">诊断详情</summary>
              <code>Binding 指纹：{{ shortHash(unitDetail.selectedPanel.panel.bindingFingerprint) }}</code>
            </details>
          </section>
          <section class="detail-block">
            <h4>生成包</h4>
            <p>{{ generationStatusLabel(unitDetail.selectedPanel.generation.status) }}</p>
            <p v-if="unitDetail.selectedPanel.generation.message">{{ friendlyDashboardText(unitDetail.selectedPanel.generation.message) }}</p>
          </section>
          <section class="detail-block">
            <h4>一致性与审片</h4>
            <p v-if="unitDetail.selectedPanel.continuityReview">
              {{ unitDetail.selectedPanel.continuityReview.nextAction.label }}
            </p>
            <button
              v-else-if="unitDetail.selectedPanel.generation.code === 'continuity-opaque'"
              type="button"
              class="open-review-action"
              data-testid="dashboard-open-continuity-review"
              @click="openContinuityReview">
              补齐真实连续性状态
            </button>
            <p v-else>未加载连续性投影</p>
          </section>
          <details class="detail-block diagnostic-details legacy-diagnostics">
            <summary data-testid="studio-dashboard-unit-diagnostics">诊断详情</summary>
            <ul>
              <li>原镜：{{ unitDetail.selectedPanel.legacy.sourceShot }}</li>
              <li>中文板：{{ unitDetail.selectedPanel.legacy.fusionStoryboardSheet }}</li>
              <li>视觉约束：{{ unitDetail.selectedPanel.legacy.p3VisualConstraints }}</li>
              <li>发布记录：{{ unitDetail.selectedPanel.legacy.publication }}</li>
            </ul>
          </details>
          <section v-if="appearancesPage" class="detail-block">
            <h4>资产出场</h4>
            <ul data-testid="dashboard-appearances">
              <li v-for="item in appearancesPage.page.items" :key="`${item.unitId}:${item.panelId}`">
                <button type="button" @click="jumpLocator(item.locator)">
                  {{ item.episode }} · {{ item.unitTitle }} · {{ item.panelTitle }}
                </button>
              </li>
            </ul>
            <div class="pager" data-testid="dashboard-appearances-pager">
              <button type="button" :disabled="!appearancesCursorStack.length || isStreamBusy('appearances')" @click="appearancesPrev">上一页</button>
              <button type="button" :disabled="!appearancesPage.page.nextCursor || isStreamBusy('appearances')" @click="appearancesNext">下一页</button>
            </div>
          </section>
        </template>
      </aside>
    </div>

    <footer class="dashboard-footer" data-testid="dashboard-counts">
      <span v-if="overview">单元 {{ overview.counts.units }} · 资产 {{ overview.counts.canonicalAssets }} · 媒体 {{ overview.counts.media }}</span>
      <details v-if="overview" class="diagnostic-details"><summary data-testid="studio-dashboard-overview-diagnostics">诊断详情</summary><code>状态指纹：{{ shortHash(overview.fingerprint) }}</code></details>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type {
  StudioDashboardAppearancesPage,
  StudioDashboardOverview,
  StudioDashboardQueueKind,
  StudioDashboardQueuePage,
  StudioDashboardUnitDetail,
  StudioDashboardUnitsPage,
  StudioDashboardLocator,
  StudioDashboardNextAction,
} from "@core/studio-production-dashboard";
import type { StudioContinuityReviewFocus } from "../studio-continuity-review-store";
import {
  createDashboardLoadController,
  type DashboardStreamKey,
  type StudioProductionDashboardUiApi,
} from "../studio-production-dashboard-store";
import {
  shouldPreferFocusOverDefaultUnit,
  studioDashboardUnitQueryForFocus,
} from "@core/studio-dashboard-focus";
import {
  buildStudioPanelPreparationChecklist,
  preparationInputFromUnitDetail,
} from "@core/studio-panel-preparation-checklist";
import { buildStudioGenerationPreflightPreview } from "@core/studio-generation-queue-view";

const props = defineProps<{
  projectRoot: string;
  projectName?: string;
  api: StudioProductionDashboardUiApi;
  /** Material Studio 会话内的显式选择；只用于预览，正式身份仍由 dispatch ledger 决定。 */
  generationProvider: "codex" | "grok";
  /** A3：从画布返回时的 focus */
  focus?: import("@core/studio-canvas-locator").StudioCanvasFocusLocator | null;
}>();

const emit = defineEmits<{
  failed: [message: string];
  openCanvas: [focus: import("@core/studio-canvas-locator").StudioCanvasFocusLocator];
  openReview: [focus: StudioContinuityReviewFocus];
}>();

const controller = createDashboardLoadController();
const queryBusyTokens = new Map<string, DashboardStreamKey>();
const queryBusyRevision = ref(0);
const loading = computed(() => {
  queryBusyRevision.value;
  return queryBusyTokens.size > 0;
});
const errorMessage = ref("");
const overview = ref<StudioDashboardOverview | null>(null);
const unitsPage = ref<StudioDashboardUnitsPage | null>(null);
const unitDetail = ref<StudioDashboardUnitDetail | null>(null);
const queuePage = ref<StudioDashboardQueuePage | null>(null);
const appearancesPage = ref<StudioDashboardAppearancesPage | null>(null);
const selectedUnitId = ref<string | undefined>();
const selectedPanelId = ref<string | undefined>();
const seasonFilter = ref("");
const episodeFilter = ref("");
const unitsCursorStack = ref<string[]>([]);
const unitsCursor = ref<string | undefined>();
const activeQueue = ref<StudioDashboardQueueKind>("ambiguity");
const queueCursorStack = ref<string[]>([]);
const queueCursor = ref<string | undefined>();
const appearancesAssetId = ref<string | undefined>();
const appearancesCursorStack = ref<string[]>([]);
const appearancesCursor = ref<string | undefined>();
const queueKinds: StudioDashboardQueueKind[] = ["ambiguity", "missing", "stale", "conflict", "rework"];

const filteredEpisodes = computed(() => {
  const episodes = unitsPage.value?.episodes ?? [];
  if (!seasonFilter.value) return episodes;
  return episodes.filter((episode) => episode.seasonId === seasonFilter.value);
});

/**
 * 当前单元的安全停机结论必须压过概览的普通导航提示：
 * 概览未逐单元读取 generation ledger，若仍显示“可以冻结”，会诱导重复派发。
 * 只提升 Core 已明确标注的硬停机码，不在前端推导新的业务状态。
 */
function isHardSafetyNextAction(action: StudioDashboardNextAction | undefined): boolean {
  return action?.code === "generation-projection-degraded"
    || action?.code === "continuity-opaque";
}

const currentNextAction = computed<StudioDashboardNextAction | undefined>(() => {
  const unitAction = unitDetail.value?.nextAction;
  if (isHardSafetyNextAction(unitAction)) return unitAction;
  const queueAction = queuePage.value?.nextAction;
  if (isHardSafetyNextAction(queueAction)) return queueAction;
  // 其余情况仍以 Core 概览的全局唯一下一步为准。
  return overview.value?.nextAction
    ?? queueAction
    ?? unitAction
    ?? unitsPage.value?.nextAction;
});

const preparationChecklist = computed(() => {
  if (!unitDetail.value?.selectedPanel) return null;
  const input = preparationInputFromUnitDetail(unitDetail.value);
  if (!input) return null;
  return buildStudioPanelPreparationChecklist(input);
});

type DashboardGenerationPreflight = Omit<ReturnType<typeof buildStudioGenerationPreflightPreview>, "queueInFlight"> & {
  queueInFlight: number | null;
  queueInFlightKnown: boolean;
};

/** Dashboard schema v1 尚未暴露正式生成队列 in-flight 数，禁止拿 checkpoint 槽位或异常队列冒充。 */
function generationQueueInFlightFromFormalProjection(): number | null {
  return null;
}

const generationPreflight = computed<DashboardGenerationPreflight | null>(() => {
  const checklist = preparationChecklist.value;
  if (!checklist || !unitDetail.value?.selectedPanel) return null;
  const gen = unitDetail.value.selectedPanel.generation?.status;
  const freezeReady = gen === "ready" || gen === "not-applicable";
  const queueInFlight = generationQueueInFlightFromFormalProjection();
  if (queueInFlight !== null) {
    return {
      ...buildStudioGenerationPreflightPreview({
        unitId: checklist.unitId,
        panelId: checklist.panelId,
        preparationReady: checklist.readyForGeneration,
        preparationPendingCount: checklist.pendingCount,
        queueInFlight,
        freezeReady,
        provider: props.generationProvider,
      }),
      queueInFlightKnown: true,
    };
  }
  const reasons: string[] = [];
  if (!checklist.readyForGeneration) reasons.push(`准备清单未闭环（待 ${checklist.pendingCount} 项）`);
  if (!freezeReady) reasons.push("冻结包尚未就绪");
  return {
    schemaVersion: 1,
    kind: "studio-generation-preflight-preview",
    unitId: checklist.unitId,
    panelId: checklist.panelId,
    preparationPendingCount: checklist.pendingCount,
    canDispatch: checklist.readyForGeneration && freezeReady,
    queueInFlight: null,
    queueInFlightKnown: false,
    reasons,
    provider: props.generationProvider,
  };
});

const nextActionClass = computed(() => (
  currentNextAction.value?.requiresWrite ? "pending" : "ready"
));

function shortHash(value: string): string {
  return value.slice(0, 12);
}

function bindingStatusLabel(status: string | undefined): string {
  return ({
    pending: "待解析",
    unchecked: "待核验",
    ambiguous: "有歧义",
    unmatched: "未匹配",
    bound: "已绑定",
    stale: "需要更新",
    "generation-ready": "可以生图",
  } as Record<string, string>)[status ?? ""] ?? (status || "待处理");
}

function currentnessLabel(status: string | undefined): string {
  return ({ current: "当前有效", stale: "需要更新", missing: "尚未建立", "not-applicable": "无需绑定" } as Record<string, string>)[status ?? ""]
    ?? (status || "待核验");
}

function generationStatusLabel(status: string | undefined): string {
  return ({ ready: "冻结包已就绪", blocked: "被门禁阻断", missing: "尚未冻结", "not-applicable": "无需生成" } as Record<string, string>)[status ?? ""]
    ?? (status || "待处理");
}

function providerLabel(provider: "codex" | "grok"): string {
  return provider === "grok" ? "Grok" : "Codex";
}

function categoryLabel(category: "character" | "scene" | "prop" | "style" | undefined): string {
  return category ? ({ character: "角色", scene: "场景", prop: "道具", style: "风格" } as const)[category] : "资产";
}

function friendlyDashboardText(value: string): string {
  return value
    .replaceAll("generation-ready", "可以生图")
    .replaceAll("agent-imagegen", "Codex")
    .replaceAll("visualAction", "镜头动作")
    .replaceAll("dialogue", "对白")
    .replaceAll("Binding", "资产绑定")
    .replaceAll("Dashboard", "驾驶舱")
    .replaceAll("Core", "系统")
    .replaceAll("current", "当前有效")
    .replaceAll("ready", "就绪")
    .replaceAll("unchecked", "待核验");
}

/** P29-E02：含技术 ID/内部字段的原因文本判定（匹配在翻译前原文上做）。 */
function isTechnicalReasonText(value: string): boolean {
  return /sha256|revision|packId|panel\s|\b(?:character|scene|prop|style)-[a-z0-9-]+|九字段|fingerprint|未 ready|CAS|BindingSet/i.test(value);
}

/** 准备清单/预览原因主文案：技术原文不直接上屏，先给人话（原文入诊断详情）。 */
function displayReasonText(value: string): string {
  if (isTechnicalReasonText(value)) return "有内容在开始前发生了变化，需要重新核对绑定。";
  return friendlyDashboardText(value);
}

function queueLabel(queue: StudioDashboardQueueKind): string {
  switch (queue) {
    case "ambiguity": return "歧义";
    case "missing": return "缺失";
    case "stale": return "过期";
    case "conflict": return "冲突";
    case "rework": return "返工";
  }
}

function formatQueueTotal(value: number | "bounded-partial" | undefined): string {
  if (value === undefined) return "–";
  if (value === "bounded-partial") return "≥";
  return String(value);
}

function markQueryBusy(token: string, stream: DashboardStreamKey): void {
  queryBusyTokens.set(token, stream);
  queryBusyRevision.value += 1;
}

function clearQueryBusy(token: string): void {
  if (!queryBusyTokens.delete(token)) return;
  queryBusyRevision.value += 1;
}

function resetQueryBusy(): void {
  if (!queryBusyTokens.size) return;
  queryBusyTokens.clear();
  queryBusyRevision.value += 1;
}

function isStreamBusy(stream: DashboardStreamKey): boolean {
  queryBusyRevision.value;
  return [...queryBusyTokens.values()].includes(stream);
}

async function runQuery<T>(
  query: Parameters<StudioProductionDashboardUiApi["getDashboard"]>[1],
  apply: (data: T) => void,
): Promise<void> {
  const token = controller.begin(props.projectRoot, query);
  markQueryBusy(token, query.operation);
  errorMessage.value = "";
  try {
    const data = await props.api.getDashboard(props.projectRoot, query) as T;
    // 按 operation 独立判定当前流，避免 overview/units 互相取消
    if (!controller.isCurrent(token, query)) return;
    apply(data);
  } catch (error) {
    if (!controller.isCurrent(token, query)) return;
    const message = error instanceof Error ? error.message : String(error);
    errorMessage.value = message;
    emit("failed", message);
  } finally {
    // busy 与 currentness 分离：旧流完成只清自己的 token，不能误清其他仍在执行的查询。
    clearQueryBusy(token);
  }
}

async function loadOverview(): Promise<void> {
  await runQuery({ operation: "overview" }, (data: StudioDashboardOverview) => {
    overview.value = data;
  });
}

async function reloadUnits(): Promise<void> {
  unitsCursorStack.value = [];
  unitsCursor.value = undefined;
  await loadUnits();
}

async function loadUnits(): Promise<void> {
  await runQuery({
    operation: "units",
    ...(seasonFilter.value ? { season: seasonFilter.value } : {}),
    ...(episodeFilter.value ? { episode: episodeFilter.value } : {}),
    ...(unitsCursor.value ? { cursor: unitsCursor.value } : {}),
    limit: 36,
  }, (data: StudioDashboardUnitsPage) => {
    // 翻页替换，不累积历史 DOM
    unitsPage.value = data;
    // A3 回程：已有 focus.unitId 时禁止默认选第一项抢焦点
    if (shouldPreferFocusOverDefaultUnit(props.focus)) {
      void selectUnit(props.focus!.unitId!, props.focus!.panelId);
      return;
    }
    if (!selectedUnitId.value && data.page.items[0]) {
      void selectUnit(data.page.items[0].id);
    }
  });
}

async function unitsNext(): Promise<void> {
  const next = unitsPage.value?.page.nextCursor;
  if (!next) return;
  if (unitsCursor.value) unitsCursorStack.value.push(unitsCursor.value);
  else unitsCursorStack.value.push("");
  unitsCursor.value = next;
  await loadUnits();
}

async function unitsPrev(): Promise<void> {
  const previous = unitsCursorStack.value.pop();
  unitsCursor.value = previous || undefined;
  await loadUnits();
}

async function selectUnit(unitId: string, panelId?: string): Promise<void> {
  // 强制与 studioDashboardUnitQueryForFocus 同一查询形状（A3 回程可测）
  const query = studioDashboardUnitQueryForFocus({ unitId, panelId });
  if (!query) return;
  selectedUnitId.value = query.unitId;
  selectedPanelId.value = query.panelId;
  await runQuery(query, (data: StudioDashboardUnitDetail) => {
    unitDetail.value = data;
    selectedPanelId.value = data.selectedPanelId ?? data.selectedPanel?.panel.id ?? query.panelId;
  });
  // Jellyfish residual：缺 selectedPanel 对象时带 panelId 二次拉取，保证准备清单 DOM 可达
  const { resolveUnitPanelFetchPlan } = await import("@core/studio-dashboard-unit-selection");
  const plan = resolveUnitPanelFetchPlan(unitId, unitDetail.value, panelId);
  if (plan.needsRefetchWithPanel && plan.panelId) {
    const withPanel = studioDashboardUnitQueryForFocus({ unitId: plan.unitId, panelId: plan.panelId });
    if (withPanel) {
      selectedPanelId.value = plan.panelId;
      await runQuery(withPanel, (data: StudioDashboardUnitDetail) => {
        unitDetail.value = data;
        selectedPanelId.value = data.selectedPanelId ?? data.selectedPanel?.panel.id ?? plan.panelId;
      });
    }
  }
}

async function selectPanel(panelId: string): Promise<void> {
  if (!selectedUnitId.value) return;
  selectedPanelId.value = panelId;
  await selectUnit(selectedUnitId.value, panelId);
}

async function selectQueue(queue: StudioDashboardQueueKind): Promise<void> {
  activeQueue.value = queue;
  queueCursorStack.value = [];
  queueCursor.value = undefined;
  await loadQueue();
}

async function loadQueue(): Promise<void> {
  await runQuery({
    operation: "queue",
    queue: activeQueue.value,
    ...(queueCursor.value ? { cursor: queueCursor.value } : {}),
    limit: 36,
  }, (data: StudioDashboardQueuePage) => {
    queuePage.value = data;
  });
}

async function queueNext(): Promise<void> {
  const next = queuePage.value?.page.nextCursor;
  if (!next) return;
  queueCursorStack.value.push(queueCursor.value ?? "");
  queueCursor.value = next;
  await loadQueue();
}

async function queuePrev(): Promise<void> {
  const previous = queueCursorStack.value.pop();
  queueCursor.value = previous || undefined;
  await loadQueue();
}

async function openAsset(assetId: string): Promise<void> {
  appearancesAssetId.value = assetId;
  appearancesCursorStack.value = [];
  appearancesCursor.value = undefined;
  await loadAppearances();
}

async function loadAppearances(): Promise<void> {
  if (!appearancesAssetId.value) return;
  await runQuery({
    operation: "appearances",
    assetId: appearancesAssetId.value,
    ...(appearancesCursor.value ? { cursor: appearancesCursor.value } : {}),
    limit: 36,
  }, (data: StudioDashboardAppearancesPage) => {
    appearancesPage.value = data;
  });
}

async function appearancesNext(): Promise<void> {
  const next = appearancesPage.value?.page.nextCursor;
  if (!next) return;
  appearancesCursorStack.value.push(appearancesCursor.value ?? "");
  appearancesCursor.value = next;
  await loadAppearances();
}

async function appearancesPrev(): Promise<void> {
  const previous = appearancesCursorStack.value.pop();
  appearancesCursor.value = previous || undefined;
  await loadAppearances();
}

async function jumpLocator(locator: StudioDashboardLocator): Promise<void> {
  if (locator.unitId) {
    await selectUnit(locator.unitId, locator.panelId);
  }
  if (locator.assetId) {
    await openAsset(locator.assetId);
  }
}

function openCanvasForPanel(panelId: string): void {
  emit("openCanvas", {
    unitId: selectedUnitId.value,
    panelId,
    fromMode: "dashboard",
  });
}

function openCanvasForUnit(): void {
  if (!selectedUnitId.value) return;
  emit("openCanvas", {
    unitId: selectedUnitId.value,
    ...(selectedPanelId.value ? { panelId: selectedPanelId.value } : {}),
    fromMode: "dashboard",
  });
}

/** 连续性 P0 的入口不能因附属只读证据慢而卡住；超时只隐藏证据，绝不解除门禁。 */
async function readContinuityEvidenceWithin<T>(read: Promise<T> | null, timeoutMilliseconds = 1_500): Promise<T | null> {
  if (!read) return null;
  let timer: number | undefined;
  try {
    const safeRead = read.catch(() => null);
    const timeout = new Promise<null>((resolve) => {
      timer = window.setTimeout(() => resolve(null), timeoutMilliseconds);
    });
    return await Promise.race([safeRead, timeout]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

/** P0：明确的 continuity-opaque 必须直接交给人工画面校正面，不能要求重找 raw 节点。 */
async function openContinuityReview(): Promise<void> {
  const detail = unitDetail.value;
  const panel = detail?.selectedPanel?.panel;
  if (!detail || !panel || detail.selectedPanel?.generation.code !== "continuity-opaque") return;
  // 只读证据只用于人工观察。优先使用画布同源的已停检账本投影，且有严格等待上限。
  const checkpoint = await readContinuityEvidenceWithin(
    props.api.getCheckpointCanvasProjection?.(props.projectRoot) ?? null,
  );
  const attested = checkpoint?.ledgerCurrent
    ? checkpoint.attestedUnitGrid.find((item) => item.unitId === detail.unit.id)
    : undefined;
  const readOnlyMedia = attested
    ? {
      packId: attested.packId,
      rawSha256: attested.rawMediaSha256,
      labeledSha256: attested.labeledMediaSha256,
      reviewWriteAllowed: false,
      evidenceSource: "checkpoint-attested" as const,
    }
    : {};
  emit("openReview", {
    token: Date.now(),
    unitId: detail.unit.id,
    unitRevision: detail.unit.revision,
    panelId: panel.id,
    startMilliseconds: Math.round(panel.startSeconds * 1_000),
    endMilliseconds: Math.round(panel.endSeconds * 1_000),
    assetIds: panel.assetIds,
    generationTarget: { targetKind: "unit-grid", targetKey: `unit-grid:${detail.unit.id}` },
    ...readOnlyMedia,
  });
}

async function applyExternalFocus(): Promise<void> {
  const focus = props.focus;
  if (!focus?.unitId) return;
  await selectUnit(focus.unitId, focus.panelId);
}

// immediate：v-if 切到 dashboard 时 focus 往往已就位，无 immediate 会丢回程
watch(() => props.focus, async (focus) => {
  if (!focus?.unitId) return;
  await selectUnit(focus.unitId, focus.panelId);
}, { deep: true, immediate: true });

async function refreshAll(): Promise<void> {
  controller.invalidate();
  resetQueryBusy();
  await loadOverview();
  await reloadUnits();
  await selectQueue(activeQueue.value);
  // units 加载后再次应用 focus，覆盖默认第一项与竞态
  await applyExternalFocus();
}

watch(() => props.projectRoot, () => {
  controller.invalidate();
  resetQueryBusy();
  overview.value = null;
  unitsPage.value = null;
  unitDetail.value = null;
  queuePage.value = null;
  appearancesPage.value = null;
  queueCursorStack.value = [];
  queueCursor.value = undefined;
  appearancesAssetId.value = undefined;
  appearancesCursorStack.value = [];
  appearancesCursor.value = undefined;
  selectedUnitId.value = undefined;
  selectedPanelId.value = undefined;
  void refreshAll();
});

onMounted(() => {
  void refreshAll();
});
</script>

<style scoped>
.production-dashboard {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  gap: 12px;
  color: var(--ui-text);
}
.dashboard-header {
  display: grid;
  grid-template-columns: 1.2fr 1.6fr auto;
  gap: 12px;
  align-items: start;
  padding: 12px 14px;
  border: 1px solid var(--ui-line);
  border-radius: 14px;
  background: var(--ui-bg);
}
.eyebrow {
  display: block;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--ui-accent);
}
.identity h2 {
  margin: 4px 0;
  font-size: 20px;
}
.identity p,
.next-action p,
.unit-meta span,
.hard-cap-note,
.detail-block p,
.detail-block li,
.unit-entry span,
.queue-entry span {
  color: var(--ui-text-2);
  font-size: 12px;
}
.next-action {
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--ui-surface);
}
.next-action.pending {
  border: 1px solid var(--ui-accent-strong);
}
.next-action.ready {
  border: 1px solid var(--ui-ok);
}
.next-action strong {
  display: block;
  margin: 4px 0;
}
.next-action code {
  font-size: 11px;
  color: var(--ui-accent);
}
.quiet-action {
  border: 1px solid var(--ui-line);
  background: transparent;
  color: inherit;
  border-radius: 10px;
  padding: 8px 12px;
  cursor: pointer;
}
.error-banner {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--ui-danger);
  color: var(--ui-danger);
}
.dashboard-body {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr) 300px;
  gap: 12px;
  min-height: 0;
  flex: 1;
}
.left-rail,
.right-rail,
.center-stage {
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--ui-line);
  border-radius: 14px;
  background: var(--ui-surface);
  padding: 12px;
}
.rail-block + .rail-block {
  margin-top: 16px;
}
.rail-heading,
.unit-meta,
.detail-block h4 {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 8px;
}
.facet-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-bottom: 8px;
}
.facet-row select,
.unit-entry,
.queue-entry,
.panel-card,
.detail-block button,
.queue-tabs button {
  width: 100%;
  text-align: left;
  border: 1px solid var(--ui-line);
  background: var(--ui-surface);
  color: inherit;
  border-radius: 10px;
  padding: 8px 10px;
  cursor: pointer;
}
.unit-entry,
.queue-entry {
  content-visibility: auto;
  contain-intrinsic-size: auto 52px;
}
[data-testid="dashboard-appearances"] button {
  content-visibility: auto;
  contain-intrinsic-size: auto 40px;
}
.panel-card {
  padding: 0;
  overflow: hidden;
  cursor: default;
}
.unit-list,
.queue-list,
.detail-block ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.unit-entry.active,
.panel-card.active,
.queue-tabs button.active {
  border-color: var(--ui-accent);
  box-shadow: inset 0 0 0 1px var(--ui-accent-soft);
}
.pager {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-top: 8px;
}
.pager button {
  min-height: 30px;
  border: 1px solid var(--ui-line);
  border-radius: 8px;
  background: var(--ui-surface);
  color: inherit;
  cursor: pointer;
}
.pager button:disabled,
.quiet-action:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.queue-tabs {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 4px;
  margin-bottom: 8px;
}
.queue-tabs button {
  font-size: 11px;
  padding: 6px 4px;
}
.panel-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}
.panel-select {
  width: 100%;
  padding: 10px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.panel-select:focus-visible,
.panel-canvas-action:focus-visible {
  outline: 2px solid var(--ui-accent-strong);
  outline-offset: -2px;
}
.panel-card-heading,
.panel-card-footer {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}
.panel-card-description {
  display: block;
  min-height: 36px;
  margin: 12px 0;
  font-size: 12px;
  color: var(--ui-text-2);
}
.panel-canvas-action,
.open-canvas-link {
  min-height: 30px;
  border: 1px solid var(--ui-accent-soft);
  border-radius: 8px;
  background: var(--ui-accent-soft);
  color: var(--ui-text);
  cursor: pointer;
}
.panel-canvas-action {
  width: calc(100% - 20px);
  margin: 0 10px 10px;
}
.hard-cap-note,
.empty-stage-guided {
  display: grid;
  gap: 8px;
  justify-items: start;
  text-align: left;
  max-width: 28rem;
}
.empty-stage-guided strong {
  font-size: 13px;
  color: var(--ui-text);
}
.empty-stage-guided p {
  margin: 0;
  color: var(--ui-text-2);
  font-size: 11px;
  line-height: 1.5;
}
.empty-guide-steps {
  margin: 0;
  padding-left: 1.2rem;
  color: var(--ui-text-2);
  font-size: 11px;
  line-height: 1.55;
}
.empty-guide-next {
  padding: 6px 8px;
  border-left: 3px solid var(--ui-accent);
  background: var(--ui-accent-soft);
  color: var(--ui-accent-strong) !important;
  font-size: 11px !important;
}
.empty-stage,
.empty {
  color: var(--ui-text-3);
  font-size: 12px;
}
.detail-block + .detail-block {
  margin-top: 14px;
}
.prep-summary {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--ui-text-2);
}
.prep-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.prep-list li {
  border: 1px solid var(--ui-line);
  border-radius: 6px;
  padding: 6px 8px;
  background: var(--ui-bg);
}
.prep-list li.ready {
  border-color: var(--ui-ok);
}
.prep-list li.blocked {
  border-color: var(--ui-danger);
}
.prep-list li strong {
  display: block;
  font-size: 11px;
  color: var(--ui-text);
}
.prep-list li span {
  display: block;
  margin-top: 2px;
  font-size: 10px;
  color: var(--ui-text-2);
}
.ledger-status {
  margin: 8px 0 0;
  color: var(--ui-text);
}
.diagnostic-details {
  margin-top: 6px;
  color: var(--ui-text-3);
  font-size: 11px;
}
.diagnostic-details summary {
  cursor: pointer;
}
.diagnostic-details code {
  display: block;
  margin-top: 5px;
  overflow-wrap: anywhere;
  color: var(--ui-accent);
}
.dashboard-footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--ui-text-3);
  padding: 0 4px 4px;
}
</style>
