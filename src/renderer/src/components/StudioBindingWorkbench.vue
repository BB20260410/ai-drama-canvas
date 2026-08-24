<template>
  <section
    class="binding-workbench"
    data-testid="studio-binding-workbench"
    :aria-busy="loadingUnits || loadingControl || Boolean(busyAction)">
    <header class="workbench-heading">
      <div>
        <span class="eyebrow">资产绑定</span>
        <h2>资产绑定与 15 秒时间线</h2>
      </div>
      <div class="next-action" aria-live="polite">
        <span>唯一下一步</span>
        <p data-testid="binding-next-action">{{ friendlyBindingText(control?.nextAction || pageNextAction || "—") }}</p>
      </div>
      <button type="button" class="quiet-button" :disabled="loadingUnits || Boolean(busyAction)" @click="refresh">
        <RefreshCw :size="15" :class="{ spinning: loadingUnits || loadingControl }" aria-hidden="true" />
        刷新
      </button>
    </header>

    <p v-if="error" class="feedback error" role="alert">
      <CircleAlert :size="15" aria-hidden="true" />
      <span>{{ error }}</span>
      <button type="button" @click="error = ''">关闭</button>
    </p>
    <p v-else-if="notice" class="feedback notice" role="status">{{ notice }}</p>

    <div class="workbench-columns">
      <aside class="scope-column" aria-labelledby="binding-scope-title">
        <header class="column-heading">
          <span>01</span>
          <div><h3 id="binding-scope-title">剧本位置</h3><p>季 / 集 / 15 秒单元</p></div>
        </header>

        <div class="scope-filters">
          <label>
            <span>季</span>
            <select v-model="seasonId" :disabled="loadingUnits || Boolean(busyAction)" @change="selectSeason">
              <option value="">全部季</option>
              <option v-for="season in seasons" :key="season.id" :value="season.id">{{ season.label }}</option>
            </select>
          </label>
          <label>
            <span>集</span>
            <select v-model="episodeId" :disabled="loadingUnits || Boolean(busyAction)" @change="selectEpisode">
              <option value="">全部集</option>
              <option v-for="episode in visibleEpisodes" :key="episode.id" :value="episode.id">{{ episode.label }}</option>
            </select>
          </label>
        </div>

        <div v-if="loadingUnits && !units.length" class="empty-line" role="status">
          <LoaderCircle :size="17" class="spinning" aria-hidden="true" />读取单元…
        </div>
        <div v-else-if="!units.length" class="empty-line">当前范围没有 15 秒单元。</div>
        <div
          v-else
          class="unit-list"
          role="listbox"
          aria-label="15 秒单元"
          @keydown.down.prevent="moveUnitSelection(1)"
          @keydown.up.prevent="moveUnitSelection(-1)">
          <button
            v-for="unit in units"
            :key="unit.id"
            type="button"
            class="unit-row"
            data-testid="binding-unit-entry"
            role="option"
            :aria-selected="selectedUnitId === unit.id"
            :class="{ active: selectedUnitId === unit.id }"
            :disabled="Boolean(busyAction)"
            @click="selectUnit(unit.id)">
            <span class="unit-path">{{ unit.seasonLabel }} · {{ unit.episodeLabel }}</span>
            <strong>{{ unit.label }}</strong>
            <small>{{ formatSeconds(unit.durationSeconds) }} · {{ unit.panelCount }} 格</small>
            <em class="status-chip" :class="`tone-${statusMeta(unit.status).tone}`">{{ statusMeta(unit.status).label }}</em>
          </button>
        </div>

        <nav v-if="units.length" class="page-controls" aria-label="15 秒单元分页">
          <button type="button" data-testid="binding-page-previous" :disabled="!canPrevious || loadingUnits || Boolean(busyAction)" @click="loadPreviousPage">
            <ChevronLeft :size="14" aria-hidden="true" />上一页
          </button>
          <span data-testid="binding-page-indicator">第 {{ pageNumber }} 页 · 本页 {{ units.length }}<template v-if="pageTotal !== undefined"> / {{ pageTotal }}</template></span>
          <button type="button" data-testid="binding-page-next" :disabled="!cursorState.nextCursor || loadingUnits || Boolean(busyAction)" @click="loadNextPage">
            下一页<ChevronRight :size="14" aria-hidden="true" />
          </button>
        </nav>
      </aside>

      <main class="timeline-column" aria-labelledby="binding-timeline-title">
        <header class="column-heading timeline-heading">
          <span>02</span>
          <div>
            <h3 id="binding-timeline-title">15 秒宫格时间线</h3>
            <p>{{ control ? `${control.unit.label} · ${control.panels.length} 格` : "选择一个单元查看绑定状态" }}</p>
          </div>
          <button
            type="button"
            class="primary-button"
            data-testid="binding-analyze"
            :disabled="!selectedPanel || !control?.revisionToken || Boolean(busyAction)"
            @click="analyzeSelectedUnit">
            <ScanSearch :size="15" aria-hidden="true" />
            {{ busyAction === "analyze" ? "解析中…" : "解析当前宫格" }}
          </button>
        </header>

        <div v-if="loadingControl && !control" class="timeline-empty" role="status">
          <LoaderCircle :size="19" class="spinning" aria-hidden="true" />读取绑定投影…
        </div>
        <div v-else-if="!control" class="timeline-empty">
          <Network :size="24" aria-hidden="true" />
          <p>尚未选择可查看的 15 秒单元。</p>
        </div>
        <template v-else>
          <div
            class="panel-timeline"
            data-testid="binding-panel-timeline"
            role="listbox"
            aria-label="2 至 6 格时间线"
            :style="{ '--panel-count': control.panels.length }"
            @keydown.right.prevent="movePanelSelection(1)"
            @keydown.left.prevent="movePanelSelection(-1)">
            <button
              v-for="panel in control.panels"
              :key="panel.id"
              type="button"
              class="timeline-panel"
              data-testid="binding-panel-entry"
              role="option"
              :aria-selected="selectedPanelId === panel.id"
              :class="[{ active: selectedPanelId === panel.id }, `tone-${statusMeta(panel.status).tone}`]"
              @click="selectedPanelId = panel.id">
              <span>{{ String(panel.ordinal).padStart(2, "0") }}</span>
              <strong>{{ panel.label }}</strong>
              <small>{{ formatRange(panel.startSeconds, panel.endSeconds) }}</small>
              <em>{{ statusMeta(panel.status).label }}</em>
            </button>
          </div>

          <div class="status-legend" aria-label="绑定状态图例">
            <span v-for="status in timelineStatuses" :key="status" :class="`tone-${statusMeta(status).tone}`">
              <i aria-hidden="true" />{{ statusMeta(status).label }}
            </span>
          </div>

          <section v-if="selectedPanel" class="panel-summary" aria-label="当前宫格摘要">
            <div>
              <span>当前宫格</span>
              <strong>{{ selectedPanel.label }}</strong>
            </div>
            <div>
              <span>来源片段</span>
              <strong>{{ selectedPanel.sourceExcerpts.length }}</strong>
            </div>
            <div>
              <span>实体提案</span>
              <strong>{{ selectedPanel.proposals.length }}</strong>
            </div>
            <div>
              <span>绑定状态</span>
              <strong>{{ statusMeta(selectedPanel.status).label }}</strong>
            </div>
          </section>
        </template>
      </main>

      <aside class="inspector-column" aria-labelledby="binding-inspector-title">
        <header class="column-heading">
          <span>03</span>
          <div><h3 id="binding-inspector-title">绑定审阅</h3><p>来源 → 提案 → 规范资产</p></div>
        </header>

        <div v-if="!selectedPanel" class="inspector-empty">
          <MousePointer2 :size="23" aria-hidden="true" />
          <p>选择一个宫格，查看来源片段、候选和阻塞项。</p>
        </div>
        <template v-else>
          <section class="inspector-section source-section">
            <div class="section-title"><h4>剧本原文</h4><span>{{ selectedPanel.sourceExcerpts.length }} 段</span></div>
            <blockquote v-for="excerpt in selectedPanel.sourceExcerpts" :key="excerpt.id" data-testid="binding-source-excerpt">
              <div v-if="excerpt.sections.length" class="source-section-path" aria-label="剧本章节与场景来源">
                <span
                  v-for="section in excerpt.sections"
                  :key="section.revisionId"
                  :data-testid="`binding-source-section-${section.kind}`">
                  {{ section.kind === "chapter" ? "章节" : "场景" }} · {{ section.title }} · r{{ section.revision }}
                </span>
              </div>
              <p>{{ excerptText(excerpt.text) }}</p>
              <footer>来源范围 {{ excerpt.startOffset }}–{{ excerpt.endOffset }}</footer>
            </blockquote>
            <p v-if="!selectedPanel.sourceExcerpts.length" class="inline-empty">尚未标注该宫格对应的剧本原文。</p>
          </section>

          <section class="inspector-section proposal-section">
            <div class="section-title"><h4>实体提案</h4><span>{{ selectedPanel.proposals.length }} 项</span></div>
            <article v-for="proposal in selectedPanel.proposals" :key="proposal.id" class="proposal" data-testid="binding-proposal">
              <header>
                <div>
                  <span>{{ categoryLabel(proposal.entityCategory) }}</span>
                  <strong>{{ proposal.entityText }}</strong>
                </div>
                <em :class="proposal.resolvedAssetId ? 'proposal-resolved' : `proposal-${proposal.status}`">
                  {{ proposal.resolvedAssetId ? "已确认" : proposalStatusLabel(proposal.status) }}
                </em>
              </header>

              <dl>
                <dt>匹配方式</dt><dd>{{ matchKindLabel(proposal.matchKind) }}</dd>
                <dt>画面要求</dt><dd>{{ presenceLabel(proposal.presence) }}</dd>
                <dt>用途</dt><dd>{{ proposal.role || "—" }}</dd>
              </dl>

              <ol v-if="visibleCandidates(proposal).length" class="candidate-list" aria-label="规范资产候选">
                <li v-for="candidate in visibleCandidates(proposal)" :key="candidate.assetId">
                  <span><b>{{ candidate.assetName }}</b><small>{{ categoryLabel(candidate.category) }} · {{ candidate.authorityLabel || "权威参考已核" }}</small></span>
                  <em>{{ matchKindLabel(candidate.matchKind) }}<template v-if="candidate.scoreLabel"> · {{ candidate.scoreLabel }}</template></em>
                </li>
              </ol>
              <p v-else class="inline-empty">没有候选资产。</p>
              <p v-if="proposal.resolvedAssetId" class="resolved-receipt">
                当前人工绑定：<b>{{ resolvedAssetLabel(proposal) }}</b>；变更后需要重新确认生成绑定。
              </p>

              <template v-if="proposal.status !== 'excluded'">
                <div class="resolution-fields">
                  <label>
                    <span>人工选择候选</span>
                    <select
                      v-model="draftFor(proposal).selectedAssetId"
                      :data-testid="`binding-candidate-select-${proposal.id}`"
                      :disabled="Boolean(busyAction)">
                      <option value="">请选择，不自动采用第一项</option>
                      <option v-for="candidate in visibleCandidates(proposal)" :key="candidate.assetId" :value="candidate.assetId">{{ candidate.assetName }}</option>
                    </select>
                  </label>
                  <label>
                    <span>画面要求</span>
                    <select v-model="draftFor(proposal).presence" :disabled="Boolean(busyAction)">
                      <option value="required">必须出现</option>
                      <option value="optional">可选出现</option>
                      <option value="forbidden">禁止出现</option>
                    </select>
                  </label>
                  <label class="role-field">
                    <span>画面用途</span>
                    <input v-model="draftFor(proposal).role" type="text" maxlength="120" :disabled="Boolean(busyAction)" placeholder="如：主角 / 前景道具" />
                  </label>
                </div>

                <div class="resolution-actions" aria-label="候选确认（Jellyfish linked/ignored）">
                  <button
                    v-if="proposal.status === 'matched'"
                    type="button"
                    :data-testid="`binding-accept-${proposal.id}`"
                    data-candidate-action="confirm"
                    :disabled="!proposal.matchedAssetId || Boolean(busyAction)"
                    @click="resolveProposal(proposal, 'accept')">
                    <Check :size="14" aria-hidden="true" />确认候选（明确匹配）
                  </button>
                  <button
                    type="button"
                    :data-testid="`binding-select-${proposal.id}`"
                    data-candidate-action="confirm"
                    class="binding-confirm-candidate"
                    :disabled="!draftFor(proposal).selectedAssetId || Boolean(busyAction)"
                    @click="resolveProposal(proposal, 'select')">
                    <ListChecks :size="14" aria-hidden="true" />确认候选（人工选择）
                  </button>
                  <button
                    type="button"
                    class="exclude-button binding-ignore-candidate"
                    :data-testid="`binding-exclude-${proposal.id}`"
                    data-candidate-action="ignore"
                    :disabled="Boolean(busyAction)"
                    @click="resolveProposal(proposal, 'exclude')">
                    <Ban :size="14" aria-hidden="true" />忽略候选
                  </button>
                </div>
              </template>
              <p v-else class="excluded-receipt"><Ban :size="13" aria-hidden="true" />已由人工排除；如需恢复，请重新解析当前宫格。</p>

              <ul v-if="proposal.blockerCodes.length" class="proposal-blockers" aria-label="提案阻塞码">
                <li v-for="code in proposal.blockerCodes" :key="code">{{ code }}</li>
              </ul>
            </article>
            <p v-if="!selectedPanel.proposals.length" class="inline-empty">当前原文没有识别出人物、场景或道具。</p>
          </section>

          <section v-if="emptyReviewVisible" class="inspector-section empty-review-section" data-testid="binding-empty-review">
            <div class="section-title">
              <h4>空镜确认</h4>
              <span :class="selectedPanel.emptyConfirmation?.currentness === 'current' ? 'empty-current' : 'empty-pending'">
                {{ selectedPanel.emptyConfirmation?.currentness === "current" ? "当前有效" : "待显式确认" }}
              </span>
            </div>
            <dl v-if="selectedPanel.emptyConfirmation" class="binding-receipt" data-testid="binding-empty-confirmation-status">
              <dt>确认人</dt><dd>{{ selectedPanel.emptyConfirmation.reviewer === "user" ? "人工" : "Codex" }}</dd>
              <dt>说明</dt><dd>{{ selectedPanel.emptyConfirmation.note }}</dd>
              <dt>时间</dt><dd>{{ selectedPanel.emptyConfirmation.confirmedAt }}</dd>
            </dl>
            <details v-if="selectedPanel.emptyConfirmation" class="binding-diagnostics"><summary data-testid="studio-binding-diagnostics">诊断详情</summary><code>{{ selectedPanel.emptyConfirmation.id }}</code></details>
            <p v-else class="empty-review-copy">零提案不等于已确认空。请阅读上方冻结剧本片段，并留下真实审阅说明。</p>
            <label class="empty-note-field">
              <span>审阅说明</span>
              <textarea
                v-model="emptyConfirmationNotes[selectedPanel.id]"
                data-testid="binding-empty-note"
                maxlength="4000"
                :disabled="!selectedPanel.confirmEmptyAllowed || Boolean(busyAction)"
                placeholder="例如：已核对该宫格全部 source spans，只有环境动作，无角色、场景、道具或风格身份需要绑定。" />
            </label>
            <button
              type="button"
              class="confirm-empty-button"
              data-testid="binding-confirm-empty"
              :disabled="confirmEmptyDisabled || Boolean(busyAction)"
              @click="confirmSelectedPanelEmpty">
              <Check :size="15" aria-hidden="true" />
              {{ busyAction === "confirm-empty" ? "确认中…" : "显式确认该宫格无可绑定实体" }}
            </button>
            <small>该操作会追加人工审阅收据；不会因“没有候选”而自动确认。</small>
          </section>

          <section class="inspector-section freeze-section">
            <div class="section-title"><h4>生成绑定</h4><span>{{ selectedPanel.bindingSet?.currentness === "current" ? "当前有效" : selectedPanel.bindingSet ? "需要更新" : "未冻结" }}</span></div>
            <dl v-if="selectedPanel.bindingSet" class="binding-receipt" data-testid="binding-set-status">
              <dt>状态</dt><dd>{{ selectedPanel.bindingSet.currentness === "current" ? "当前有效" : "需要更新" }}</dd>
              <dt>冻结时间</dt><dd>{{ selectedPanel.bindingSet.frozenAt }}</dd>
            </dl>
            <details v-if="selectedPanel.bindingSet" class="binding-diagnostics"><summary data-testid="studio-binding-diagnostics">诊断详情</summary><code>{{ selectedPanel.bindingSet.id }}</code><code>{{ selectedPanel.bindingSet.fingerprint }}</code></details>
            <ul v-if="selectedPanel.blockers.length" class="blocker-list" aria-label="冻结阻塞项">
              <li v-for="blocker in selectedPanel.blockers" :key="blocker.code" :class="blocker.severity">
                <CircleAlert :size="14" aria-hidden="true" />
                <span>{{ blocker.message }}</span>
              </li>
            </ul>
            <p v-else class="inline-empty">绑定检查已通过。</p>
            <button
              type="button"
              class="freeze-button"
              data-testid="binding-freeze"
              :disabled="freezeDisabled || Boolean(busyAction)"
              @click="freezeSelectedPanel">
              <Snowflake :size="15" aria-hidden="true" />
              {{ busyAction === "freeze" ? "冻结中…" : "冻结生成绑定" }}
            </button>
            <small>只有实体、权威参考和连续性均确认后才能冻结；界面不会自行放宽门禁。</small>
          </section>
        </template>
      </aside>
    </div>
  </section>
</template>

<script lang="ts">
import { computed, defineComponent, onBeforeUnmount, reactive, ref, watch, type PropType } from "vue";
import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ListChecks,
  LoaderCircle,
  MousePointer2,
  Network,
  RefreshCw,
  ScanSearch,
  Snowflake,
} from "lucide-vue-next";
import {
  STUDIO_BINDING_PAGE_LIMIT,
  assertStudioBindingPanelCount,
  boundedStudioBindingCandidates,
  boundedStudioBindingSourceExcerpt,
  boundedStudioBindingUnits,
  buildStudioBindingResolveInput,
  commitStudioBindingFirstPage,
  commitStudioBindingNextPage,
  commitStudioBindingPreviousPage,
  createStudioBindingCursorState,
  createStudioBindingRequestGate,
  createStudioBindingResolutionDraft,
  resetStudioBindingCursorState,
  studioBindingFreezeDisabled,
  studioBindingStatusPresentation,
  type StudioBindingControlSnapshot,
  type StudioBindingEpisodeOption,
  type StudioBindingPanel,
  type StudioBindingProposal,
  type StudioBindingProposalStatus,
  type StudioBindingResolutionDecision,
  type StudioBindingResolutionDraft,
  type StudioBindingTimelineStatus,
  type StudioBindingUnitPage,
  type StudioBindingUnitSummary,
  type StudioBindingWorkbenchApi,
} from "../studio-binding-pagination";
import {
  planStudioBindingCandidateConfirm,
  planStudioBindingCandidateIgnore,
} from "@core/studio-binding-candidate-decision";

export default defineComponent({
  name: "StudioBindingWorkbench",
  components: {
    Ban,
    Check,
    ChevronLeft,
    ChevronRight,
    CircleAlert,
    ListChecks,
    LoaderCircle,
    MousePointer2,
    Network,
    RefreshCw,
    ScanSearch,
    Snowflake,
  },
  props: {
    projectRoot: { type: String, required: true },
    api: { type: Object as PropType<StudioBindingWorkbenchApi>, required: true },
    initialSeasonId: { type: String, default: "" },
    initialEpisodeId: { type: String, default: "" },
    initialUnitId: { type: String, default: "" },
    initialPanelId: { type: String, default: "" },
  },
  emits: {
    changed: (_message: string) => true,
    failed: (_message: string) => true,
    unitSelected: (_unitId: string) => true,
    panelSelected: (_panelId: string) => true,
  },
  setup(props, { emit, expose }) {
    const timelineStatuses: StudioBindingTimelineStatus[] = ["pending", "unchecked", "ambiguous", "unmatched", "bound", "stale", "generation-ready"];
    const gate = createStudioBindingRequestGate();
    const cursorState = reactive(createStudioBindingCursorState());
    const units = ref<StudioBindingUnitSummary[]>([]);
    const seasons = ref<StudioBindingUnitPage["seasons"]>([]);
    const episodes = ref<StudioBindingEpisodeOption[]>([]);
    const pageTotal = ref<number>();
    const pageNextAction = ref("");
    const seasonId = ref(props.initialSeasonId);
    const episodeId = ref(props.initialEpisodeId);
    const selectedUnitId = ref(props.initialUnitId);
    const selectedPanelId = ref(props.initialPanelId);
    const control = ref<StudioBindingControlSnapshot | null>(null);
    const resolutionDrafts = reactive<Record<string, StudioBindingResolutionDraft>>({});
    const emptyConfirmationNotes = reactive<Record<string, string>>({});
    const loadingUnits = ref(false);
    const loadingControl = ref(false);
    const busyAction = ref("");
    const error = ref("");
    const notice = ref("");
    let disposed = false;

    const visibleEpisodes = computed(() => seasonId.value ? episodes.value.filter((episode) => episode.seasonId === seasonId.value) : episodes.value);
    const canPrevious = computed(() => cursorState.previousCursors.length > 0);
    const pageNumber = computed(() => cursorState.previousCursors.length + 1);
    const selectedPanel = computed<StudioBindingPanel | null>(() => control.value?.panels.find((panel) => panel.id === selectedPanelId.value) ?? null);
    const freezeDisabled = computed(() => selectedPanel.value ? studioBindingFreezeDisabled(selectedPanel.value) : true);
    const emptyReviewVisible = computed(() => Boolean(
      selectedPanel.value
      && selectedPanel.value.proposals.length === 0
      && (selectedPanel.value.confirmEmptyAllowed
        || selectedPanel.value.emptyConfirmation
        || selectedPanel.value.blockers.some((blocker) => blocker.code === "empty-confirmation-required")),
    ));
    const confirmEmptyDisabled = computed(() => {
      const panel = selectedPanel.value;
      return !panel?.confirmEmptyAllowed || !(emptyConfirmationNotes[panel.id] ?? "").trim();
    });

    watch([() => props.projectRoot, () => props.api], () => {
      resetWorkspace();
      void loadFirstPage();
    }, { immediate: true });

    watch(() => [props.initialUnitId, props.initialPanelId] as const, ([unitId, panelId]) => {
      if (unitId && unitId !== selectedUnitId.value) {
        selectUnit(unitId);
      }
      if (panelId) selectedPanelId.value = panelId;
    });

    watch(selectedPanelId, (panelId) => {
      if (panelId) emit("panelSelected", panelId);
    });

    onBeforeUnmount(() => {
      disposed = true;
      gate.invalidateAll();
    });

    expose({ refresh });

    function resetWorkspace(): void {
      gate.invalidateAll();
      units.value = [];
      seasons.value = [];
      episodes.value = [];
      pageTotal.value = undefined;
      pageNextAction.value = "";
      seasonId.value = props.initialSeasonId;
      episodeId.value = props.initialEpisodeId;
      selectedUnitId.value = props.initialUnitId;
      selectedPanelId.value = props.initialPanelId;
      control.value = null;
      clearResolutionDrafts();
      clearEmptyConfirmationNotes();
      resetStudioBindingCursorState(cursorState);
      loadingUnits.value = false;
      loadingControl.value = false;
      busyAction.value = "";
      error.value = "";
      notice.value = "";
    }

    async function refresh(): Promise<void> {
      await loadCurrentPage(selectedUnitId.value);
    }

    async function loadFirstPage(preferredUnitId = selectedUnitId.value): Promise<void> {
      resetStudioBindingCursorState(cursorState);
      await loadUnitPage(undefined, "first", preferredUnitId);
    }

    async function loadCurrentPage(preferredUnitId = selectedUnitId.value): Promise<void> {
      await loadUnitPage(cursorState.currentCursor, "current", preferredUnitId);
    }

    async function loadNextPage(): Promise<void> {
      const cursor = cursorState.nextCursor;
      if (!cursor || loadingUnits.value) return;
      await loadUnitPage(cursor, "next");
    }

    async function loadPreviousPage(): Promise<void> {
      if (!cursorState.previousCursors.length || loadingUnits.value) return;
      await loadUnitPage(cursorState.previousCursors.at(-1), "previous");
    }

    async function loadUnitPage(
      cursor: string | undefined,
      mode: "first" | "current" | "next" | "previous",
      preferredUnitId = "",
    ): Promise<void> {
      const token = gate.issue("unit-page");
      const root = props.projectRoot;
      loadingUnits.value = true;
      error.value = "";
      try {
        const page = await props.api.listUnits(root, {
          ...(seasonId.value ? { seasonId: seasonId.value } : {}),
          ...(episodeId.value ? { episodeId: episodeId.value } : {}),
          ...(cursor ? { cursor } : {}),
          limit: STUDIO_BINDING_PAGE_LIMIT,
        });
        if (!responseIsCurrent(token, root)) return;
        const bounded = boundedStudioBindingUnits(page.items);
        if (mode === "first") commitStudioBindingFirstPage(cursorState, page.nextCursor);
        if (mode === "next" && cursor) commitStudioBindingNextPage(cursorState, cursor, page.nextCursor);
        if (mode === "previous") commitStudioBindingPreviousPage(cursorState, cursor, page.nextCursor);
        if (mode === "current") cursorState.nextCursor = page.nextCursor;
        units.value = bounded;
        seasons.value = page.seasons;
        episodes.value = page.episodes;
        pageTotal.value = page.total;
        pageNextAction.value = page.nextAction ?? "";
        const nextUnit = bounded.find((unit) => unit.id === preferredUnitId) ?? bounded[0];
        if (!nextUnit) {
          selectedUnitId.value = "";
          selectedPanelId.value = "";
          control.value = null;
          clearResolutionDrafts();
          return;
        }
        selectedUnitId.value = nextUnit.id;
        emit("unitSelected", nextUnit.id);
        await loadControl(nextUnit.id);
      } catch (reason) {
        if (responseIsCurrent(token, root)) fail(reason);
      } finally {
        if (gate.isCurrent(token)) loadingUnits.value = false;
      }
    }

    async function loadControl(unitId: string): Promise<void> {
      const token = gate.issue("control");
      const root = props.projectRoot;
      loadingControl.value = true;
      error.value = "";
      try {
        const snapshot = await props.api.getControl(root, { unitId });
        if (!responseIsCurrent(token, root) || selectedUnitId.value !== unitId) return;
        assertStudioBindingPanelCount(snapshot.panels);
        control.value = snapshot;
        const requestedPanelId = selectedPanelId.value;
        selectedPanelId.value = snapshot.panels.some((panel) => panel.id === requestedPanelId)
          ? requestedPanelId
          : snapshot.panels.some((panel) => panel.id === snapshot.selectedPanelId)
            ? snapshot.selectedPanelId ?? ""
            : snapshot.panels[0]?.id ?? "";
        syncResolutionDrafts(snapshot);
      } catch (reason) {
        if (responseIsCurrent(token, root)) {
          control.value = null;
          selectedPanelId.value = "";
          clearResolutionDrafts();
          fail(reason);
        }
      } finally {
        if (gate.isCurrent(token)) loadingControl.value = false;
      }
    }

    function selectSeason(): void {
      episodeId.value = "";
      control.value = null;
      selectedPanelId.value = "";
      void loadFirstPage("");
    }

    function selectEpisode(): void {
      control.value = null;
      selectedPanelId.value = "";
      void loadFirstPage("");
    }

    function selectUnit(unitId: string): void {
      if (unitId === selectedUnitId.value && control.value) return;
      selectedUnitId.value = unitId;
      selectedPanelId.value = "";
      control.value = null;
      clearResolutionDrafts();
      emit("unitSelected", unitId);
      void loadControl(unitId);
    }

    function moveUnitSelection(direction: -1 | 1): void {
      if (!units.value.length) return;
      const currentIndex = units.value.findIndex((unit) => unit.id === selectedUnitId.value);
      const nextIndex = currentIndex < 0 ? 0 : Math.min(units.value.length - 1, Math.max(0, currentIndex + direction));
      const next = units.value[nextIndex];
      if (next) selectUnit(next.id);
    }

    function movePanelSelection(direction: -1 | 1): void {
      if (!control.value?.panels.length) return;
      const panels = control.value.panels;
      const currentIndex = panels.findIndex((panel) => panel.id === selectedPanelId.value);
      const nextIndex = currentIndex < 0 ? 0 : Math.min(panels.length - 1, Math.max(0, currentIndex + direction));
      selectedPanelId.value = panels[nextIndex]?.id ?? selectedPanelId.value;
    }

    async function analyzeSelectedUnit(): Promise<void> {
      const snapshot = control.value;
      const panel = selectedPanel.value;
      if (!snapshot || !panel) return;
      await runMutation("analyze", async () => props.api.analyze(props.projectRoot, {
        unitId: snapshot.unit.id,
        panelId: panel.id,
        expectedRevisionToken: snapshot.revisionToken,
      }));
    }

    async function resolveProposal(proposal: StudioBindingProposal, decision: StudioBindingResolutionDecision): Promise<void> {
      const snapshot = control.value;
      const panel = selectedPanel.value;
      if (!snapshot || !panel) return;
      // Jellyfish 语义：confirm/ignore 先过 plan 合同再 resolve
      let resolvedDecision = decision;
      if (decision === "exclude") {
        const plan = planStudioBindingCandidateIgnore(proposal.id);
        if (!plan.ok) {
          fail(plan.reason);
          return;
        }
        resolvedDecision = plan.decision;
      } else if (decision === "select" || decision === "accept") {
        const plan = planStudioBindingCandidateConfirm({
          proposalId: proposal.id,
          selectedAssetId: draftFor(proposal).selectedAssetId || undefined,
          matchedAssetId: proposal.matchedAssetId,
          preferAcceptWhenMatched: decision === "accept",
        });
        if (!plan.ok) {
          fail(plan.reason);
          return;
        }
        resolvedDecision = plan.decision;
        if (plan.selectedAssetId && decision === "select") {
          draftFor(proposal).selectedAssetId = plan.selectedAssetId;
        }
      }
      let input;
      try {
        input = buildStudioBindingResolveInput(snapshot, panel, proposal, draftFor(proposal), resolvedDecision);
      } catch (reason) {
        fail(reason);
        return;
      }
      await runMutation(`resolve:${proposal.id}`, async () => props.api.resolve(props.projectRoot, input));
    }

    async function freezeSelectedPanel(): Promise<void> {
      const snapshot = control.value;
      const panel = selectedPanel.value;
      if (!snapshot || !panel || studioBindingFreezeDisabled(panel)) return;
      await runMutation("freeze", async () => props.api.freeze(props.projectRoot, {
        unitId: snapshot.unit.id,
        panelId: panel.id,
        expectedRevisionToken: snapshot.revisionToken,
      }));
    }

    async function confirmSelectedPanelEmpty(): Promise<void> {
      const snapshot = control.value;
      const panel = selectedPanel.value;
      const note = panel ? (emptyConfirmationNotes[panel.id] ?? "").trim() : "";
      if (!snapshot || !panel || !panel.confirmEmptyAllowed || !note) return;
      await runMutation("confirm-empty", async () => {
        const result = await props.api.confirmEmpty(props.projectRoot, {
          unitId: snapshot.unit.id,
          panelId: panel.id,
          expectedRevisionToken: snapshot.revisionToken,
          reviewer: "user",
          note,
        });
        delete emptyConfirmationNotes[panel.id];
        return result;
      });
    }

    async function runMutation(kind: string, operation: () => ReturnType<StudioBindingWorkbenchApi["analyze"]>): Promise<void> {
      if (busyAction.value) return;
      const token = gate.issue("mutation");
      const root = props.projectRoot;
      busyAction.value = kind;
      error.value = "";
      notice.value = "";
      try {
        const result = await operation();
        if (!responseIsCurrent(token, root)) return;
        notice.value = friendlyBindingText(result.message || "系统已记录操作，正在刷新状态。");
        emit("changed", notice.value);
        const unitId = selectedUnitId.value;
        await loadCurrentPage(unitId);
      } catch (reason) {
        if (responseIsCurrent(token, root)) fail(reason);
      } finally {
        if (gate.isCurrent(token)) busyAction.value = "";
      }
    }

    function responseIsCurrent(token: Parameters<typeof gate.isCurrent>[0], root: string): boolean {
      return !disposed && root === props.projectRoot && gate.isCurrent(token);
    }

    function syncResolutionDrafts(snapshot: StudioBindingControlSnapshot): void {
      clearResolutionDrafts();
      for (const panel of snapshot.panels) {
        for (const proposal of panel.proposals) resolutionDrafts[proposal.id] = createStudioBindingResolutionDraft(proposal);
      }
    }

    function clearResolutionDrafts(): void {
      for (const key of Object.keys(resolutionDrafts)) delete resolutionDrafts[key];
    }

    function clearEmptyConfirmationNotes(): void {
      for (const key of Object.keys(emptyConfirmationNotes)) delete emptyConfirmationNotes[key];
    }

    function draftFor(proposal: StudioBindingProposal): StudioBindingResolutionDraft {
      return resolutionDrafts[proposal.id] ??= createStudioBindingResolutionDraft(proposal);
    }

    function visibleCandidates(proposal: StudioBindingProposal) {
      return boundedStudioBindingCandidates(proposal.candidates);
    }

    function resolvedAssetLabel(proposal: StudioBindingProposal): string {
      return proposal.candidates.find((candidate) => candidate.assetId === proposal.resolvedAssetId)?.assetName
        ?? proposal.entityText;
    }

    function friendlyBindingText(value: string): string {
      return value
        .replaceAll("current AssetBindingSet", "当前有效的生成绑定")
        .replaceAll("AssetBindingSet", "生成绑定")
        .replaceAll("generation-ready", "可以生图")
        .replaceAll("source spans", "剧本原文范围")
        .replaceAll("source span", "剧本原文范围")
        .replaceAll("Core", "系统")
        .replaceAll("current", "当前有效");
    }

    function matchKindLabel(matchKind: string): string {
      return ({
        id: "资产编号精确匹配",
        "formal-name": "规范名称精确匹配",
        alias: "别名精确匹配",
        model: "Agent 建议候选",
        "exact-alias": "别名精确匹配",
        none: "尚未匹配",
      } as Record<string, string>)[matchKind] ?? (matchKind || "—");
    }

    function statusMeta(status: StudioBindingTimelineStatus) {
      return studioBindingStatusPresentation(status);
    }

    function excerptText(text: string): string {
      return boundedStudioBindingSourceExcerpt(text);
    }

    function formatSeconds(seconds: number): string {
      return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
    }

    function formatRange(start: number, end: number): string {
      return `${formatSeconds(start)}–${formatSeconds(end)}`;
    }

    function categoryLabel(category: StudioBindingProposal["entityCategory"]): string {
      return ({ character: "角色", scene: "场景", prop: "道具", style: "风格" })[category];
    }

    function proposalStatusLabel(status: StudioBindingProposalStatus): string {
      return ({ matched: "已匹配", ambiguous: "歧义", unmatched: "未匹配", excluded: "已排除" })[status];
    }

    function presenceLabel(presence: StudioBindingProposal["presence"]): string {
      return ({ required: "必须出现", optional: "可选出现", forbidden: "禁止出现" })[presence];
    }

    function fail(reason: unknown): void {
      error.value = reason instanceof Error ? reason.message : String(reason);
      emit("failed", error.value);
    }

    return {
      busyAction,
      canPrevious,
      categoryLabel,
      control,
      confirmEmptyDisabled,
      confirmSelectedPanelEmpty,
      cursorState,
      draftFor,
      episodeId,
      error,
      emptyConfirmationNotes,
      emptyReviewVisible,
      excerptText,
      freezeDisabled,
      freezeSelectedPanel,
      friendlyBindingText,
      formatRange,
      formatSeconds,
      loadNextPage,
      loadPreviousPage,
      loadingControl,
      loadingUnits,
      movePanelSelection,
      moveUnitSelection,
      matchKindLabel,
      notice,
      pageNextAction,
      pageNumber,
      pageTotal,
      presenceLabel,
      proposalStatusLabel,
      resolvedAssetLabel,
      refresh,
      resolveProposal,
      seasonId,
      seasons,
      selectEpisode,
      selectSeason,
      selectUnit,
      selectedPanel,
      selectedPanelId,
      selectedUnitId,
      statusMeta,
      timelineStatuses,
      units,
      visibleCandidates,
      visibleEpisodes,
      analyzeSelectedUnit,
    };
  },
});
</script>

<style scoped>
.binding-workbench {
  --binding-ink: var(--ui-text);
  --binding-muted: var(--ui-text-2);
  --binding-line: var(--ui-line);
  --binding-surface: var(--ui-surface);
  --binding-accent: var(--ui-accent);
  min-width: 0;
  color: var(--binding-ink);
  background: var(--ui-surface);
  border: 1px solid var(--binding-line);
  border-radius: var(--ui-radius-panel);
  overflow: hidden;
}

button,
select,
input,
textarea {
  font: inherit;
}

button:focus-visible,
select:focus-visible,
input:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--ui-accent-strong);
  outline-offset: 2px;
}

.workbench-heading {
  min-height: 78px;
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(280px, 1.3fr) auto;
  gap: 24px;
  align-items: center;
  padding: 18px 22px;
  border-bottom: 1px solid var(--binding-line);
}

.eyebrow {
  color: var(--binding-accent);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .15em;
}

.workbench-heading h2 {
  margin: 4px 0 0;
  font-size: 20px;
  letter-spacing: -.02em;
}

.next-action {
  padding-left: 20px;
  border-left: 1px solid var(--binding-line);
}

.next-action span,
.column-heading p,
.section-title span {
  color: var(--binding-muted);
  font-size: 11px;
}

.next-action p {
  margin: 3px 0 0;
  font-size: 13px;
  line-height: 1.45;
}

.quiet-button,
.primary-button,
.confirm-empty-button,
.freeze-button,
.resolution-actions button,
.page-controls button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  border: 1px solid var(--binding-line);
  border-radius: 8px;
  background: white;
  color: var(--binding-ink);
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease, color 140ms ease, transform 140ms ease;
}

.quiet-button {
  padding: 0 12px;
}

.primary-button,
.confirm-empty-button,
.freeze-button {
  color: white;
  border-color: var(--binding-accent);
  background: var(--binding-accent);
  padding: 0 13px;
}

button:not(:disabled):hover {
  border-color: var(--ui-text-3);
  transform: translateY(-1px);
}

button:disabled {
  opacity: .46;
  cursor: not-allowed;
}

.feedback {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 9px 22px;
  border-bottom: 1px solid var(--binding-line);
  font-size: 12px;
}

.feedback.error {
  color: var(--ui-danger);
  background: color-mix(in srgb, var(--ui-danger) 8%, var(--ui-surface));
}

.feedback.notice {
  color: var(--ui-accent-strong);
  background: var(--ui-accent-soft);
}

.feedback button {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.workbench-columns {
  display: grid;
  grid-template-columns: minmax(220px, .72fr) minmax(380px, 1.2fr) minmax(330px, 1fr);
  min-height: 650px;
}

.scope-column,
.timeline-column,
.inspector-column {
  min-width: 0;
}

.scope-column,
.timeline-column {
  border-right: 1px solid var(--binding-line);
}

.column-heading {
  min-height: 62px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--binding-line);
}

.column-heading > span {
  color: var(--binding-accent);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .08em;
}

.column-heading h3,
.section-title h4 {
  margin: 0;
  font-size: 13px;
}

.column-heading p {
  margin: 2px 0 0;
}

.timeline-heading .primary-button {
  margin-left: auto;
  white-space: nowrap;
}

.scope-filters {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--binding-line);
}

.scope-filters label,
.resolution-fields label,
.empty-note-field {
  display: grid;
  gap: 5px;
  color: var(--binding-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .03em;
}

select,
input,
textarea {
  width: 100%;
  min-width: 0;
  height: 34px;
  box-sizing: border-box;
  border: 1px solid var(--binding-line);
  border-radius: 7px;
  padding: 0 8px;
  color: var(--binding-ink);
  background: white;
  font-size: 12px;
}

textarea {
  min-height: 88px;
  padding: 8px;
  resize: vertical;
  line-height: 1.5;
}

.unit-list {
  max-height: 515px;
  overflow: auto;
  scrollbar-gutter: stable;
}

.unit-row {
  position: relative;
  width: 100%;
  display: grid;
  gap: 3px;
  padding: 12px 74px 12px 14px;
  text-align: left;
  border: 0;
  border-bottom: 1px solid var(--ui-line);
  background: transparent;
  color: var(--binding-ink);
  cursor: pointer;
  content-visibility: auto;
  contain-intrinsic-size: auto 56px;
}

.unit-row.active {
  background: var(--ui-accent-soft);
  box-shadow: inset 3px 0 var(--binding-accent);
}

.unit-path,
.unit-row small {
  color: var(--binding-muted);
  font-size: 10px;
}

.unit-row strong {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-chip {
  position: absolute;
  top: 50%;
  right: 10px;
  transform: translateY(-50%);
  padding: 3px 6px;
  border-radius: 999px;
  font-size: 9px;
  font-style: normal;
  font-weight: 700;
}

.page-controls {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 7px;
  align-items: center;
  padding: 10px 12px;
  border-top: 1px solid var(--binding-line);
}

.page-controls button {
  min-height: 30px;
  padding: 0 8px;
  font-size: 10px;
}

.page-controls span {
  color: var(--binding-muted);
  font-size: 9px;
  text-align: center;
}

.empty-line,
.timeline-empty,
.inspector-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 180px;
  padding: 24px;
  color: var(--binding-muted);
  font-size: 12px;
  text-align: center;
}

.timeline-empty,
.inspector-empty {
  flex-direction: column;
  min-height: 360px;
}

.panel-timeline {
  --panel-count: 2;
  display: grid;
  grid-template-columns: repeat(var(--panel-count), minmax(96px, 1fr));
  gap: 1px;
  padding: 16px;
  background: var(--binding-line);
}

.timeline-panel {
  position: relative;
  min-height: 164px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-end;
  gap: 5px;
  padding: 13px;
  overflow: hidden;
  border: 0;
  background: var(--ui-surface);
  color: var(--binding-ink);
  text-align: left;
  cursor: pointer;
}

.timeline-panel::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 4px;
  background: var(--ui-text-3);
}

.timeline-panel.active {
  z-index: 1;
  box-shadow: inset 0 0 0 2px var(--binding-accent);
  background: white;
}

.timeline-panel > span {
  position: absolute;
  top: 13px;
  left: 13px;
  color: var(--ui-text-3);
  font-size: 22px;
  font-weight: 800;
}

.timeline-panel strong {
  font-size: 12px;
}

.timeline-panel small,
.timeline-panel em {
  color: var(--binding-muted);
  font-size: 10px;
  font-style: normal;
}

.timeline-panel em {
  font-weight: 700;
}

.timeline-panel.tone-warning::before,
.tone-warning i {
  background: var(--ui-accent-strong);
}

.timeline-panel.tone-danger::before,
.tone-danger i {
  background: var(--ui-danger);
}

.timeline-panel.tone-success::before,
.tone-success i {
  background: var(--ui-accent-strong);
}

.timeline-panel.tone-stale::before,
.tone-stale i {
  background: var(--ui-stale);
}

.status-chip.tone-warning,
.status-legend .tone-warning { color: var(--ui-accent-strong); background: var(--ui-accent-soft); }
.status-chip.tone-danger,
.status-legend .tone-danger { color: var(--ui-danger); background: color-mix(in srgb, var(--ui-danger) 8%, var(--ui-surface)); }
.status-chip.tone-success,
.status-legend .tone-success { color: var(--ui-accent-strong); background: var(--ui-accent-soft); }
.status-chip.tone-stale,
.status-legend .tone-stale { color: var(--ui-stale); background: color-mix(in srgb, var(--ui-stale) 14%, var(--ui-surface)); }
.status-chip.tone-quiet,
.status-legend .tone-quiet { color: var(--ui-text-2); background: var(--ui-surface-2); }

.status-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 16px 14px;
}

.status-legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 6px;
  border-radius: 999px;
  font-size: 9px;
}

.status-legend i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

.panel-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  margin: 0 16px 16px;
  border-top: 1px solid var(--binding-line);
  border-bottom: 1px solid var(--binding-line);
}

.panel-summary div {
  display: grid;
  gap: 4px;
  padding: 13px 10px;
  border-right: 1px solid var(--binding-line);
}

.panel-summary div:last-child { border-right: 0; }
.panel-summary span { color: var(--binding-muted); font-size: 9px; }
.panel-summary strong { font-size: 12px; }

.inspector-column {
  max-height: 712px;
  overflow: auto;
  scrollbar-gutter: stable;
}

.inspector-column > .column-heading {
  position: sticky;
  top: 0;
  z-index: 4;
  background: var(--ui-surface);
}

.inspector-section {
  padding: 14px 16px;
  border-bottom: 1px solid var(--binding-line);
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

blockquote {
  margin: 0 0 8px;
  padding: 10px 0 10px 12px;
  border-left: 2px solid var(--ui-text-3);
  background: var(--ui-surface-2);
}

.source-section-path {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 8px;
}

.source-section-path span {
  padding: 3px 7px;
  border: 1px solid var(--ui-line);
  border-radius: 999px;
  color: var(--ui-accent-strong);
  background: var(--ui-accent-soft);
  font-size: 10px;
  font-weight: 700;
}

blockquote p {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}

blockquote footer {
  margin-top: 6px;
  color: var(--binding-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
}

.proposal {
  padding: 12px 0;
  border-top: 1px solid var(--ui-line);
}

.proposal:first-of-type { border-top: 0; }

.proposal > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.proposal > header div {
  display: grid;
  gap: 3px;
}

.proposal > header span {
  color: var(--binding-muted);
  font-size: 9px;
}

.proposal > header strong { font-size: 13px; }

.proposal > header em {
  padding: 3px 6px;
  border-radius: 999px;
  font-size: 9px;
  font-style: normal;
  font-weight: 700;
  white-space: nowrap;
}

.proposal-matched { color: var(--ui-accent-strong); background: var(--ui-accent-soft); }
.proposal-ambiguous { color: var(--ui-accent-strong); background: var(--ui-accent-soft); }
.proposal-unmatched { color: var(--ui-danger); background: color-mix(in srgb, var(--ui-danger) 8%, var(--ui-surface)); }
.proposal-excluded { color: var(--ui-text-2); background: var(--ui-surface-2); }
.proposal-resolved { color: var(--ui-accent-strong); background: var(--ui-accent-soft); }

.proposal dl,
.binding-receipt {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 8px;
  margin: 9px 0;
  font-size: 10px;
}

.proposal dt,
.binding-receipt dt { color: var(--binding-muted); }
.proposal dd,
.binding-receipt dd { margin: 0; overflow-wrap: anywhere; }
.binding-diagnostics{margin:8px 0;padding-top:7px;border-top:1px dashed var(--ui-line);color:var(--binding-muted);font-size:9px}.binding-diagnostics summary{cursor:pointer}.binding-diagnostics code{display:block;margin-top:5px;overflow-wrap:anywhere;font:8px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}

.candidate-list {
  margin: 8px 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--ui-line);
}

.candidate-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid var(--ui-line);
}

.candidate-list span { display: grid; gap: 2px; }
.candidate-list b { font-size: 11px; }
.candidate-list small,
.candidate-list em { color: var(--binding-muted); font-size: 9px; font-style: normal; }

.resolution-fields {
  display: grid;
  grid-template-columns: 1.2fr .8fr;
  gap: 8px;
  margin-top: 10px;
}

.role-field { grid-column: 1 / -1; }

.resolution-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 9px;
}

.resolution-actions button {
  min-height: 30px;
  padding: 0 8px;
  font-size: 10px;
}

.resolution-actions .exclude-button { color: var(--ui-danger); }

.proposal-blockers,
.blocker-list {
  margin: 9px 0 0;
  padding: 0;
  list-style: none;
}

.proposal-blockers {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.proposal-blockers li {
  padding: 2px 5px;
  border-radius: 4px;
  color: var(--ui-danger);
  background: color-mix(in srgb, var(--ui-danger) 8%, var(--ui-surface));
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 8px;
}

.blocker-list li {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 7px 0;
  border-top: 1px solid var(--ui-line);
  font-size: 10px;
}

.blocker-list li.blocking { color: var(--ui-danger); }
.blocker-list span { display: grid; gap: 2px; }

.empty-review-section {
  background: var(--ui-surface);
}

.empty-review-copy {
  margin: 0 0 10px;
  color: var(--binding-muted);
  font-size: 10px;
  line-height: 1.55;
}

.empty-current { color: var(--ui-accent-strong) !important; }
.empty-pending { color: var(--ui-accent-strong) !important; }

.confirm-empty-button {
  width: 100%;
  margin-top: 10px;
}

.empty-review-section > small {
  display: block;
  margin-top: 7px;
  color: var(--binding-muted);
  font-size: 9px;
  line-height: 1.5;
}

.freeze-button {
  width: 100%;
  margin-top: 12px;
}

.freeze-section > small {
  display: block;
  margin-top: 7px;
  color: var(--binding-muted);
  font-size: 9px;
  line-height: 1.5;
}

.inline-empty,
.excluded-receipt,
.resolved-receipt {
  margin: 8px 0;
  color: var(--binding-muted);
  font-size: 10px;
  line-height: 1.5;
}

.excluded-receipt {
  display: flex;
  align-items: center;
  gap: 5px;
}

.spinning { animation: binding-spin 800ms linear infinite; }

@keyframes binding-spin { to { transform: rotate(360deg); } }

@media (max-width: 1120px) {
  .workbench-columns { grid-template-columns: 230px minmax(360px, 1fr); }
  .inspector-column { grid-column: 1 / -1; max-height: none; border-top: 1px solid var(--binding-line); }
  .inspector-column > .column-heading { position: static; }
  .scope-column { border-right: 1px solid var(--binding-line); }
  .timeline-column { border-right: 0; }
}

@media (max-width: 760px) {
  .workbench-heading { grid-template-columns: 1fr auto; }
  .next-action { grid-column: 1 / -1; grid-row: 2; padding: 10px 0 0; border: 0; border-top: 1px solid var(--binding-line); }
  .workbench-columns { display: block; }
  .scope-column,
  .timeline-column { border-right: 0; border-bottom: 1px solid var(--binding-line); }
  .unit-list { max-height: 340px; }
  .panel-timeline { grid-template-columns: repeat(2, minmax(110px, 1fr)); }
  .panel-summary { grid-template-columns: repeat(2, 1fr); }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    transition: none !important;
    animation-duration: .001ms !important;
    animation-iteration-count: 1 !important;
  }

  button:not(:disabled):hover { transform: none; }
}
</style>
