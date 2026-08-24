<template>
  <section class="studio-generation-control" data-testid="studio-generation-control" :aria-busy="loading">
    <header class="generation-header">
      <div>
        <span>正式生成</span>
        <h2>Agent 生图派发</h2>
        <p>这里只显示当前受管工程的冻结包、派发和原始图/标注图结果；不会调用网页或旧供应商队列。</p>
      </div>
      <button type="button" :disabled="loading" data-testid="studio-generation-refresh" @click="refresh">刷新</button>
    </header>

    <div v-if="errorMessage" class="generation-error" role="alert" data-testid="studio-generation-error">{{ errorMessage }}</div>

    <div class="generation-counts" aria-label="正式生图账本统计">
      <article><strong>{{ ledger?.counts.packs ?? 0 }}</strong><span>冻结包</span></article>
      <article><strong>{{ ledger?.counts.dispatches ?? 0 }}</strong><span>待 Agent / 已派发</span></article>
      <article><strong>{{ ledger?.counts.results ?? 0 }}</strong><span>结果文件</span></article>
      <article :class="{ warn: (ledger?.counts.pendingResults ?? 0) > 0 }"><strong>{{ ledger?.counts.pendingResults ?? 0 }}</strong><span>待审片</span></article>
    </div>

    <section class="generation-plans" aria-label="生成计划与任务" data-testid="studio-generation-plans">
      <header>
        <b>生成计划与任务</b>
        <span v-if="progress">进行中 {{ progress.counts.active }} · 完成 {{ progress.counts.done }} · 失败/取消 {{ progress.counts.failed }}</span>
      </header>
      <div v-if="!progress || progress.nodes.length === 0" class="plans-empty" data-testid="generation-plan-empty-guide">
        <strong>尚无生成计划</strong>
        <p>步骤：① 绑定就绪 → ② 冻结/建计划 → ③ 派发生图 → ④ 回写 → ⑤ 审片。在画布选中宫格点「开始」，或由 Agent 经 MCP 建立计划；进度只来自本地账本。</p>
      </div>
      <article v-for="(group, groupIndex) in planGroups" :key="group.planId" class="plan-group" :data-plan-id="group.planId">
        <header>
          <small>第 {{ groupIndex + 1 }} 批 · {{ group.nodes.length }} 个任务<template v-if="group.lastActivityAt"> · 最近活动 {{ group.lastActivityAt }}</template></small>
          <button
            v-if="group.retriable"
            type="button"
            :disabled="loading || !generationProjectionCurrent || Boolean(actionBusy) || isUnknownBlockedGroup(group.nodes)"
            :title="actionBusy ? '正在处理，不能再重拍节点' : undefined"
            @click="retryPlan(group.planId)">重拍失败/取消节点</button>
        </header>
        <details class="plan-id-diagnostics"><summary data-testid="studio-generation-plan-id-diagnostics">诊断</summary><small>计划 ID {{ group.planId }}</small></details>
        <div v-for="node in group.nodes" :key="`${group.planId}-${node.nodeIndex}`" class="plan-node" :data-node-status="node.status">
          <span class="node-status" :class="node.status">{{ planNodeStatusLabel(node.status) }}</span>
          <div class="node-main">
            <strong>{{ node.targetKind === "unit-grid" ? `整板 · ${node.unitId}` : node.panelId }}</strong>
            <small>
              第 {{ node.attempt }} 次尝试<template v-if="node.adopted">（接管上一次任务）</template><template v-if="node.packStale"> · 生成包已变化</template><template v-if="node.lastEventAt"> · {{ node.lastEventAt }}</template>
            </small>
            <small v-if="node.errorClass" class="node-error">{{ node.errorClass }}<template v-if="node.errorDetail">：{{ node.errorDetail }}</template></small>
          </div>
          <div class="node-actions">
            <button v-if="node.status === 'dispatched'" type="button" :disabled="loading || !generationProjectionCurrent || Boolean(actionBusy) || isUnknownBlockedNode(node)" :title="actionBusy ? '正在处理，不能再取消该任务' : undefined" @click="cancelNode(node)">取消</button>
            <button v-if="node.status === 'dispatched'" type="button" :disabled="loading || higgsfieldQueueBusy || !generationProjectionCurrent || generationActionsBlocked || isUnknownBlockedNode(node)" :title="(higgsfieldQueueBusy || generationActionsBlocked) ? '正在处理，不能再用 Higgsfield 排队' : undefined" @click="queueHiggsfieldImage(node)">用 Higgsfield 排队</button>
            <button v-if="node.status === 'failed' || node.status === 'cancelled'" type="button" :disabled="loading || !generationProjectionCurrent || Boolean(actionBusy) || isUnknownBlockedNode(node)" :title="actionBusy ? '正在处理，不能再重拍节点' : undefined" @click="retryPlan(group.planId, node.nodeIndex)">重拍</button>
            <button v-if="node.status === 'succeeded' && node.resultId" type="button" :disabled="!generationProjectionCurrent" @click="locateNode(node)">定位结果</button>
          </div>
        </div>
      </article>
    </section>

    <div class="generation-layout">
      <aside class="unit-rail" aria-label="生产单元">
        <header><b>生产单元</b><small>{{ units?.page.total ?? units?.page.items.length ?? 0 }}</small></header>
        <button
          v-for="unit in units?.page.items ?? []"
          :key="unit.id"
          type="button"
          :class="{ active: selectedUnitId === unit.id }"
          :data-unit-id="unit.id"
          @click="selectUnit(unit.id)">
          <strong>{{ unit.label }}</strong>
          <span>{{ unit.episodeId }} · {{ unit.durationSeconds }} 秒 · {{ unit.panelCount }} 格</span>
        </button>
        <div class="pager">
          <button type="button" :disabled="!unitCursorStack.length || loading" @click="previousUnits">上一页</button>
          <button type="button" :disabled="!units?.page.nextCursor || loading" @click="nextUnits">下一页</button>
        </div>
      </aside>

      <main class="panel-stage">
        <div v-if="!detail" class="empty-state">当前工程还没有可显示的生产单元。</div>
        <template v-else>
          <header>
            <div><b>{{ detail.unit.label }}</b><span>{{ detail.unit.durationSeconds }} 秒 · {{ detail.panels.length }} 宫格</span></div>
            <button type="button" data-testid="studio-generation-open-canvas" @click="openCanvas">回到画布</button>
          </header>
          <div class="panel-list" data-testid="studio-generation-panels">
            <button
              v-for="panel in detail.panels"
              :key="panel.id"
              type="button"
              :class="{ active: selectedPanelId === panel.id }"
              :data-panel-id="panel.id"
              @click="selectPanel(panel.id)">
              <span>{{ panel.ordinal }}</span>
              <div><strong>{{ panel.label }}</strong><small>{{ panel.startSeconds }}–{{ panel.endSeconds }} 秒 · {{ productionStatusLabel(panel.status) }}</small></div>
            </button>
          </div>
        </template>
      </main>

      <aside class="generation-detail" aria-label="当前生产目标正式生图状态">
        <div v-if="!detail?.selectedPanel" class="empty-state">选择一个宫格查看冻结与写回状态。</div>
        <template v-else>
          <header>
            <span>{{ historyTargetKind === "unit-grid" ? "当前整板" : "当前宫格" }}</span>
            <h3>{{ historyTargetKind === "unit-grid" ? detail.unit.label : `${detail.selectedPanel.panel.ordinal}. ${detail.selectedPanel.panel.label}` }}</h3>
          </header>
          <section
            v-if="historyTargetKind === 'unit-grid' && generationUnknownBlocked"
            class="generation-unknown-block"
            data-testid="studio-generation-unknown-block"
            role="alert">
            <b>防重锁定 · generation_unknown</b>
            <strong>禁止再次派发、重试或生图</strong>
            <p>发现 {{ detachedUnknownControl?.observations.length ?? 0 }} 条旧调用/候选不明观察。唯一下一动作：只核对既有调用、候选、raw/labeled 与迟到回执；状态未关闭前不得创建新 run。</p>
          </section>
          <section>
            <b>冻结包</b>
            <strong v-if="historyTargetKind === 'unit-grid'" :class="{ ready: Boolean(selectedPackId) && !generationUnknownBlocked }">{{ selectedPackId ? (generationUnknownBlocked ? "整板冻结包存在，但已被防重锁定" : "整板冻结包可用") : "尚无整板计划或结果" }}</strong>
            <strong v-else :class="detail.selectedPanel.generation.status">{{ generationStatusLabel(detail.selectedPanel.generation.status) }}</strong>
            <p v-if="historyTargetKind === 'unit-grid'">整板身份来自 unit-grid 计划或正式结果绑定的不可变生成包；不会借用第一格作为整板身份。</p>
            <p v-else>{{ generationMessageText(detail.selectedPanel.generation) }}</p>
            <details v-if="historyTargetKind === 'panel' && isTechnicalGenerationMessage(detail.selectedPanel.generation.message)" class="technical-diagnostics">
              <summary data-testid="studio-generation-message-diagnostics">诊断详情</summary>
              <p><code>{{ detail.selectedPanel.generation.message }}</code></p>
            </details>
            <details v-if="selectedPackId" class="technical-diagnostics pack-identity" data-testid="studio-pack-identity">
              <summary data-testid="studio-pack-identity-summary">冻结包身份（生成时版本）</summary>
              <p v-if="frozenPackLoading" role="status">正在读取冻结包身份…</p>
              <p v-else-if="frozenPackError" class="error-text" role="alert">{{ frozenPackError }}</p>
              <dl v-else-if="frozenPackIdentity">
                <div><dt>packId</dt><dd><code>{{ frozenPackIdentity.packId }}</code></dd></div>
                <div><dt>包指纹</dt><dd><code>{{ shortHash(frozenPackIdentity.fingerprint) }}</code></dd></div>
                <div v-if="frozenPackIdentity.targetKind === 'unit-grid'"><dt>目标</dt><dd>整板 · {{ frozenPackIdentity.panelCount }} 格</dd></div>
                <template v-else>
                  <div><dt>剧本修订</dt><dd><code>{{ frozenPackIdentity.scriptRevisionId }}</code> · {{ shortHash(frozenPackIdentity.scriptSha256) }}</dd></div>
                  <div><dt>提示词修订</dt><dd><code>{{ frozenPackIdentity.promptRevisionId }}</code> · {{ shortHash(frozenPackIdentity.promptSha256) }}</dd></div>
                  <div><dt>BindingSet</dt><dd><code>{{ frozenPackIdentity.bindingSetId }}</code></dd></div>
                </template>
                <div><dt>连续性指纹</dt><dd><code>{{ shortHash(frozenPackIdentity.continuityFingerprint) }}</code></dd></div>
                <div><dt>单元快照指纹</dt><dd><code>{{ shortHash(frozenPackIdentity.unitSnapshotFingerprint) }}</code></dd></div>
              </dl>
            </details>
          </section>
          <section>
            <b>正式结果</b>
            <p v-if="!history.length">尚无原始图或标注图写回；派发只表示本地已登记意图，图片尚未生成。</p>
            <article v-for="item in history" :key="item.resultId" class="result-row">
              <div><strong>{{ item.variant === 'raw' ? '原始图' : '标注图' }}</strong><small>{{ providerLabel(item.provider) }} · {{ reviewStatusLabel(item.status) }}</small></div>
              <span :class="{ ready: item.pairComplete && item.inputCurrent }">{{ item.pairComplete ? "已成对" : "缺少配对" }} · {{ item.inputCurrent ? "输入当前" : "输入已漂移" }}</span>
              <details class="technical-diagnostics result-identity" :data-testid="`studio-result-identity-${item.resultId}`" @toggle="onResultIdentityToggle(item.packId)">
                <summary data-testid="studio-result-identity-summary">生成时身份</summary>
                <p><code>{{ item.packId }}</code> · 包指纹 {{ shortHash(item.packFingerprint) }}</p>
                <template v-if="packCurrentness[item.packId]">
                  <p v-if="packCurrentness[item.packId]!.status === 'loading'" role="status">正在判定变化分类…</p>
                  <p v-else-if="packCurrentness[item.packId]!.status === 'error'" class="error-text" role="alert">{{ packCurrentness[item.packId]!.message }}</p>
                  <p v-else>
                    {{ changeClassificationLabel(packCurrentness[item.packId]!.changeClassification) }}
                    <template v-if="packCurrentness[item.packId]!.unexpectedReasons.length">（非预期：{{ packCurrentness[item.packId]!.unexpectedReasons.join("、") }}）</template>
                    <template v-else-if="packCurrentness[item.packId]!.expectedReasons.length">（预期：{{ packCurrentness[item.packId]!.expectedReasons.join("、") }}）</template>
                  </p>
                </template>
              </details>
            </article>
            <div class="pager">
              <button type="button" :disabled="!historyCursorStack.length || historyLoading" @click="previousHistory">上一页</button>
              <button type="button" :disabled="!historyNextCursor || historyLoading" @click="nextHistory">下一页</button>
            </div>
          </section>
          <section v-if="historyTargetKind === 'unit-grid'" data-testid="studio-video-package-control">
            <b>图生视频静态提交包</b>
            <p v-if="videoControlLoading" role="status">正在只读核对视频包账本…</p>
            <p v-else-if="videoControlError" class="error-text" role="alert">{{ videoControlError }}</p>
            <template v-else-if="videoControl">
              <strong :class="{ ready: videoControl.status === 'resolved' && videoControl.control?.status === 'mechanically-verified' }">{{ videoControlStatusLabel(videoControl) }}</strong>
              <p>{{ videoControlNextActionLabel(videoControl) }}</p>
              <p v-if="videoControl.control" data-testid="studio-video-package-authority-head">{{ videoAuthorityHeadLabel(videoControl) }}</p>
              <p v-if="videoControl.control">静态输入：{{ videoControl.control.i2vStaticStatus }} · 机械核验：{{ videoMechanicalStatusLabel(videoControl.control.mechanicalStatus) }} · 动态视频模型：未运行</p>
              <p v-if="videoControl.control" class="video-package-boundary">仅机械状态：不代表人工视觉验收或真实视频模型验证。</p>
            </template>
            <p v-else>尚无可核对的 unit-grid 生成包；不会自动准备、构建、发布或调用视频模型。</p>
          </section>
          <HiggsfieldSeedanceVideoStep v-if="historyTargetKind === 'unit-grid'" :control="higgsfieldVideoControl" :busy="higgsfieldQueueBusy" @queue-video="queueHiggsfieldVideo" />
          <footer>
            <button type="button" @click="openBinding">检查绑定</button>
            <button type="button" :disabled="!latestReviewPair || generationActionsBlocked" data-testid="studio-generation-open-review" @click="openReview">进入审片</button>
          </footer>
        </template>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { polishUserFacingText } from "../user-facing-error";
import type {
  StudioDashboardUnitDetail,
  StudioDashboardUnitsPage,
} from "@core/studio-production-dashboard";
import type {
  StudioGenerationLedgerState,
  StudioGenerationResultRecord,
} from "@core/studio-generation-ledger";
import type {
  StudioGenerationPlanProgress,
  StudioGenerationPlanProgressNode,
} from "@core/studio-generation-plan-progress";
import type { StudioVideoPackagePublicControlLookup } from "@core/studio-video-package";
import type { StudioHiggsfieldVideoControl } from "@core/studio-higgsfield-video-generation";
import { createStudioCommandEnvelope } from "../studio-command-envelope";
import type { StudioPublicCommandRequest } from "@core/studio-command-runtime";
import type { StudioProductionDashboardUiApi } from "../studio-production-dashboard-store";
import type { StudioContinuityReviewFocus } from "../studio-continuity-review-store";
import { createProjectScopedActionGate } from "../project-scoped-action-gate";
import HiggsfieldSeedanceVideoStep from "./HiggsfieldSeedanceVideoStep.vue";
import {
  createDebouncedDirtyRefreshLoop,
  createLatestRequestGate,
  loadDetachedUnknownNodeStates,
} from "../studio-generation-refresh-controller";

const props = defineProps<{
  projectRoot: string;
  api: StudioProductionDashboardUiApi;
  unitId?: string;
  panelId?: string;
}>();

const emit = defineEmits<{
  failed: [message: string];
  openCanvas: [focus: { unitId?: string; panelId?: string }];
  openBinding: [focus: { unitId?: string; panelId?: string }];
  openReview: [focus: StudioContinuityReviewFocus];
}>();

const ledger = ref<StudioGenerationLedgerState | null>(null);
const progress = ref<StudioGenerationPlanProgress | null>(null);
const progressOwnerRoot = ref("");
const generationProjectionCurrent = computed(() => (
  Boolean(progressOwnerRoot.value)
  && progressOwnerRoot.value === props.projectRoot
));
const actionBusy = ref("");
const planActionGate = createProjectScopedActionGate();
const progressLoadGate = createProjectScopedActionGate();
const units = ref<StudioDashboardUnitsPage | null>(null);
const detail = ref<StudioDashboardUnitDetail | null>(null);
const selectedUnitId = ref("");
const selectedPanelId = ref("");
const unitCursor = ref<string>();
const unitCursorStack = ref<string[]>([]);
const history = ref<StudioGenerationResultRecord[]>([]);
const historyCursor = ref<string>();
const historyNextCursor = ref<string>();
const historyCursorStack = ref<string[]>([]);
const loading = ref(false);
const historyLoading = ref(false);
const errorMessage = ref("");
let requestToken = 0;
const ledgerLoadGate = createLatestRequestGate();
const historyLoadGate = createLatestRequestGate();
let reviewToken = 0;
let disposed = false;
let unsubscribeProgress: (() => void) | undefined;

// P24 U1：冻结包身份（"生成时版本"，经 getStudioFrozenPack 按需读取单包）。
type FrozenPackIdentityView = {
  packId: string;
  fingerprint: string;
  unitSnapshotFingerprint: string;
  continuityFingerprint: string;
} & ({
  targetKind: "unit-grid";
  panelCount: number;
} | {
  targetKind: "panel";
  panelCount: 1;
  scriptRevisionId: string;
  scriptSha256: string;
  promptRevisionId: string;
  promptSha256: string;
  bindingSetId: string;
});
const frozenPackIdentity = ref<FrozenPackIdentityView | null>(null);
const frozenPackLoading = ref(false);
const frozenPackError = ref("");
let frozenPackToken = 0;

// P24 U2：结果行变化分类（经 getStudioPackCurrentness 按 packId 懒加载+缓存，页 ≤100 有界）。
interface PackCurrentnessView {
  status: "loading" | "ready" | "error";
  changeClassification: "" | "current" | "expected" | "unexpected";
  expectedReasons: string[];
  unexpectedReasons: string[];
  message: string;
}
const packCurrentness = ref<Record<string, PackCurrentnessView>>({});
const historyTargetKind = ref<"panel" | "unit-grid">("panel");
const duduProject = ref<boolean | null>(null);
let duduDetectionRoot = "";
const unitGridReadinessPackId = ref("");
interface DetachedUnknownControlView {
  operation: "detached-unknown";
  status: "ready";
  unitId: string;
  observations: Array<{
    observationId: string;
    sourceTaskId: string;
    candidateSha256: string | null;
    note: string;
  }>;
  generationBlocked: boolean;
  nextAction: "reconcile-external-unknown-only" | "follow-core-readiness";
}
const detachedUnknownControl = ref<DetachedUnknownControlView | null>(null);
type DetachedUnknownNodeState = "loading" | "clear" | "blocked" | "error";
const detachedUnknownNodeStates = ref<Record<string, DetachedUnknownNodeState>>({});
let detachedUnknownNodeToken = 0;
const generationUnknownBlocked = computed(() => (
  historyTargetKind.value === "unit-grid"
  && detachedUnknownControl.value?.unitId === selectedUnitId.value
  && detachedUnknownControl.value.generationBlocked
));
const generationActionsBlocked = computed(() => (
  historyTargetKind.value === "unit-grid"
  && detachedUnknownNodeStates.value[selectedUnitId.value] !== "clear"
));
const videoControl = ref<StudioVideoPackagePublicControlLookup | null>(null);
const higgsfieldVideoControl = ref<StudioHiggsfieldVideoControl | null>(null);
const videoControlLoading = ref(false);
const videoControlError = ref("");
let videoControlToken = 0;
const higgsfieldQueueBusy = ref(false);

const selectedPackId = computed(() => {
  if (historyTargetKind.value === "unit-grid") {
    return history.value[0]?.packId
      ?? (progress.value?.nodes ?? []).find((node) => (
        node.targetKind === "unit-grid" && node.unitId === selectedUnitId.value
      ))?.packId
      ?? unitGridReadinessPackId.value
      ?? "";
  }
  const generation = detail.value?.selectedPanel?.generation;
  return generation?.status === "ready" ? generation.packId : "";
});

// P24 R5-F2：watch 源含 projectRoot——复制工程同 packId 切换时也重新加载身份。
watch([selectedPackId, () => props.projectRoot], async () => {
  const packId = selectedPackId.value;
  const token = ++frozenPackToken;
  frozenPackIdentity.value = null;
  frozenPackError.value = "";
  if (!packId) return;
  frozenPackLoading.value = true;
  try {
    const pack = await window.canvasApi.getStudioFrozenPack(props.projectRoot, packId);
    if (token !== frozenPackToken) return;
    frozenPackIdentity.value = pack
      ? pack.schemaVersion === 5
        ? {
          targetKind: "unit-grid",
          packId: pack.id,
          fingerprint: pack.fingerprint,
          unitSnapshotFingerprint: pack.unitSnapshotFingerprint,
          panelCount: pack.panels.length,
          continuityFingerprint: pack.continuityFingerprint,
        }
        : {
        targetKind: "panel",
        packId: pack.id,
        fingerprint: pack.fingerprint,
        unitSnapshotFingerprint: pack.unitSnapshotFingerprint,
        panelCount: 1,
        scriptRevisionId: pack.scriptRevision.id,
        scriptSha256: pack.scriptRevision.bodySha256,
        promptRevisionId: pack.promptRevision.id,
        promptSha256: pack.promptRevision.bodySha256,
        bindingSetId: pack.assetBinding.bindingSet.id,
        continuityFingerprint: pack.continuity.fingerprint,
      }
      : null;
    if (!pack) frozenPackError.value = "冻结包不存在或已损坏。";
  } catch (reason) {
    if (token !== frozenPackToken) return;
    frozenPackError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    if (token === frozenPackToken) frozenPackLoading.value = false;
  }
});

function ensurePackCurrentness(packId: string): void {
  if (!packId || packCurrentness.value[packId]) return;
  packCurrentness.value = {
    ...packCurrentness.value,
    [packId]: { status: "loading", changeClassification: "", expectedReasons: [], unexpectedReasons: [], message: "" },
  };
  // P24 R5-F1：在途响应防陈旧——切工程后迟到的写回不得复活已清缓存。
  // R5-N1：同工程 refresh 窗口的在途写回同样丢弃（requestToken 参与，与 refresh ++requestToken 互斥）。
  const root = props.projectRoot;
  const token = requestToken;
  window.canvasApi.getStudioPackCurrentness(root, packId)
    .then((result) => {
      if (root !== props.projectRoot || token !== requestToken) return;
      packCurrentness.value = {
        ...packCurrentness.value,
        [packId]: {
          status: "ready",
          changeClassification: result.changeClassification,
          expectedReasons: result.expectedReasons,
          unexpectedReasons: result.unexpectedReasons,
          message: "",
        },
      };
    })
    .catch((reason: unknown) => {
      if (root !== props.projectRoot || token !== requestToken) return;
      packCurrentness.value = {
        ...packCurrentness.value,
        [packId]: {
          status: "error",
          changeClassification: "",
          expectedReasons: [],
          unexpectedReasons: [],
          message: reason instanceof Error ? reason.message : String(reason),
        },
      };
    });
}

// P24 R3-F1：懒加载语义——首次展开诊断块才取分类（不再页级 eager 扇出）；R3-F6：错误条目可经再次展开重试。
function onResultIdentityToggle(packId: string): void {
  if (packCurrentness.value[packId]?.status === "error") {
    const next = { ...packCurrentness.value };
    delete next[packId];
    packCurrentness.value = next;
  }
  ensurePackCurrentness(packId);
}

function shortHash(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function changeClassificationLabel(value: string): string {
  if (value === "current") return "输入当前";
  if (value === "expected") return "预期变化（修订被有意推进，旧结果可预期漂移）";
  if (value === "unexpected") return "非预期变化（需人工复核）";
  return "判定中…";
}

const planGroups = computed(() => {
  const groups = new Map<string, { planId: string; nodes: StudioGenerationPlanProgressNode[]; retriable: boolean; lastActivityAt: string }>();
  for (const node of progress.value?.nodes ?? []) {
    const group = groups.get(node.planId) ?? { planId: node.planId, nodes: [], retriable: false, lastActivityAt: "" };
    group.nodes.push(node);
    if (node.status === "failed" || node.status === "cancelled") group.retriable = true;
    if (node.lastEventAt && node.lastEventAt > group.lastActivityAt) group.lastActivityAt = node.lastEventAt;
    groups.set(node.planId, group);
  }
  return [...groups.values()];
});

const latestReviewPair = computed(() => {
  // history 首屏显式 newest-first；保持服务端顺序，不能 reverse 后把旧 run 当最新。
  const runIds = [...new Set(history.value.map((item) => item.generationRunId))];
  for (const generationRunId of runIds) {
    const items = history.value.filter((item) => item.generationRunId === generationRunId);
    const raw = items.find((item) => item.variant === "raw");
    const labeled = items.find((item) => item.variant === "labeled");
    if (raw && labeled && raw.pairComplete && labeled.pairComplete
      && raw.targetKind === labeled.targetKind && raw.targetKey === labeled.targetKey
      && raw.packId === labeled.packId && raw.packFingerprint === labeled.packFingerprint) {
      return { generationRunId, raw, labeled };
    }
  }
  return null;
});

function fail(reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason);
  errorMessage.value = message;
  emit("failed", message);
}

function generationStatusLabel(status: StudioDashboardUnitDetail["selectedPanel"] extends infer T
  ? T extends { generation: { status: infer S } } ? S : never
  : never): string {
  return ({ ready: "冻结包可用", blocked: "被门禁阻断", missing: "尚未冻结", "not-applicable": "无需生成" } as const)[status];
}

/** P29-E02：含技术 ID/内部字段的生成消息判定（匹配在翻译前原文上做，P26 教训）。 */
function isTechnicalGenerationMessage(message?: string): boolean {
  if (!message) return false;
  return /sha256|revision|packId|panel\s|\b(?:character|scene|prop)-[a-z0-9-]+|九字段|fingerprint|未 ready|CAS|BindingSet/i.test(message);
}

/** 冻结包状态主文案：人话优先；技术原文只进诊断详情（合同 §5）。 */
function generationMessageText(generation: { status: string; message?: string }): string {
  const raw = (generation.message ?? "").trim();
  if (isTechnicalGenerationMessage(raw)) {
    if (generation.status === "blocked") {
      return "暂时不能继续：角色、场景、道具、剧本或提示词在开始前发生了变化，请检查绑定后重试。";
    }
    return polishUserFacingText(raw);
  }
  return raw || "冻结包由画布开始按钮建立；Agent 再从 MCP 领取。";
}

function productionStatusLabel(status: string): string {
  if (status === "generation-ready") return "可以生图";
  if (status === "current" || status === "bound") return "绑定有效";
  if (status === "stale") return "需要更新绑定";
  if (status === "ambiguous") return "需要确认资产";
  if (status === "unmatched") return "缺少匹配资产";
  if (status === "unchecked") return "等待检查";
  if (status === "missing") return "信息不完整";
  if (status === "blocked") return "暂时不能继续";
  return status;
}

function providerLabel(provider: string): string {
  return provider === "codex" ? "Codex" : provider === "grok" ? "Grok" : provider;
}

function reviewStatusLabel(status: string): string {
  return status === "approved" ? "已通过" : status === "rejected" ? "需返工" : status === "pending" ? "待审片" : status;
}

function videoControlStatusLabel(control: StudioVideoPackagePublicControlLookup): string {
  if (control.status === "not-prepared") return "尚未建立视频包意图";
  if (control.status === "conflict") return "视频包换代链冲突";
  if (control.control?.status === "mechanically-verified") return "视频包已机械核验";
  if (control.control?.status === "stale") return "视频包输入已漂移";
  return "视频包已准备，尚未机械核验";
}

function videoControlNextActionLabel(control: StudioVideoPackagePublicControlLookup): string {
  if (control.nextAction === "prepare-via-authorized-core-orchestration") return "等待受授权 Core 建立 intent；本界面不直接执行构建。";
  if (control.nextAction === "resolve-video-package-ledger-conflict") return "必须先人工处理账本冲突，禁止选择第一个或覆盖旧包。";
  if (control.control?.nextAction === "package-ready-dynamic-model-not-tested") return "静态提交包可用；真实视频模型仍未运行。";
  if (control.control?.nextAction === "complete-i2v-static-input") return "需先补齐独立首尾帧或 Review 静态输入。";
  if (control.control?.nextAction === "repair-input") return "需先修复输入漂移，再重新核验。";
  return "等待受授权 Core 构建或采用并机械核验。";
}

/** authority head 只呈现 Core 已解析的受控身份；不推导、不选择候选。 */
function videoAuthorityHeadLabel(control: StudioVideoPackagePublicControlLookup): string {
  const intent = control.control?.intent;
  if (!intent) return "";
  const authority = intent.authorityKind === "historical-import"
    ? `历史导入包 ${intent.authorityId}`
    : `Studio Review ${intent.authorityId}`;
  const head = control.selectedIsDestinationHead === false ? " · 非目的地头" : "";
  return `权威头：${authority}${head}`;
}

function videoMechanicalStatusLabel(status: "not-run" | "verified" | "stale"): string {
  return status === "verified" ? "已通过" : status === "stale" ? "已漂移" : "未运行";
}

async function loadUnits(): Promise<void> {
  const root = props.projectRoot;
  const token = ++requestToken;
  const next = await props.api.getDashboard(root, {
    operation: "units",
    ...(unitCursor.value ? { cursor: unitCursor.value } : {}),
    limit: 36,
  }) as StudioDashboardUnitsPage;
  if (disposed || token !== requestToken || root !== props.projectRoot) return;
  units.value = next;
  const requested = props.unitId?.trim();
  const fallback = next.page.items[0]?.id ?? "";
  const target = requested && next.page.items.some((item) => item.id === requested) ? requested : fallback;
  if (target) await selectUnit(target, props.panelId);
  else {
    selectedUnitId.value = "";
    selectedPanelId.value = "";
    detail.value = null;
  }
}

async function loadLedger(root: string, token: number): Promise<void> {
  const loadSequence = ledgerLoadGate.begin();
  const next = await window.canvasApi.getStudioGenerationLedgerState(root);
  if (!disposed
    && ledgerLoadGate.isCurrent(loadSequence)
    && token === requestToken
    && root === props.projectRoot) ledger.value = next;
}

async function loadProgress(root: string, token: number): Promise<void> {
  if (disposed || token !== requestToken || root !== props.projectRoot) return;
  const actionId = "generation-progress";
  const loadScope = progressLoadGate.begin(root, actionId);
  const isCurrent = () => (
    !disposed
    && token === requestToken
    && root === props.projectRoot
    && progressLoadGate.isCurrent(loadScope, props.projectRoot, actionId)
  );
  // 每次真实刷新先撤销旧 owner；只有本次最新请求成功才能重新开放任务按钮。
  progressOwnerRoot.value = "";
  const next = await window.canvasApi.getStudioGenerationPlanProgress(root);
  if (!isCurrent()) return;
  progress.value = next;
  progressOwnerRoot.value = root;
  const unitIds = [...new Set(next.nodes
    .filter((node) => node.targetKind === "unit-grid")
    .map((node) => node.unitId))]
    .sort((left, right) => left.localeCompare(right, "en"));
  detachedUnknownNodeStates.value = Object.fromEntries(unitIds.map((unitId) => [unitId, "loading" as const]));
  const unknownToken = ++detachedUnknownNodeToken;
  const unknownIsCurrent = () => isCurrent() && unknownToken === detachedUnknownNodeToken;
  await loadDetachedUnknownNodeStates({
    unitIds,
    isCurrent: unknownIsCurrent,
    queryBatch: async (unitIds) => (
      window.canvasApi.getStudioDetachedUnknownUnitStates(root, unitIds)
    ),
    onBatch: (states) => {
      if (!unknownIsCurrent()) return;
      detachedUnknownNodeStates.value = {
        ...detachedUnknownNodeStates.value,
        ...states,
      };
    },
  });
}

function planNodeStatusLabel(status: StudioGenerationPlanProgressNode["status"]): string {
  return ({
    planned: "待派发",
    dispatched: "已派发，等待 Agent",
    succeeded: "已出图",
    failed: "失败",
    cancelled: "已取消",
    "retry-superseded": "已被重试取代",
  } as const)[status];
}

function isUnknownBlockedNode(node: StudioGenerationPlanProgressNode): boolean {
  return node.targetKind === "unit-grid"
    && detachedUnknownNodeStates.value[node.unitId] !== "clear";
}

function isUnknownBlockedGroup(nodes: readonly StudioGenerationPlanProgressNode[]): boolean {
  return nodes.some((node) => isUnknownBlockedNode(node));
}

type PlanActionRequest = Extract<StudioPublicCommandRequest, {
  command: "cancel_studio_generation_run" | "retry_studio_generation_plan_nodes";
}>;

async function runPlanAction(
  request: PlanActionRequest,
  confirmText: string,
): Promise<void> {
  if (actionBusy.value) return;
  if (!window.confirm(confirmText)) return;
  const root = props.projectRoot;
  if (progressOwnerRoot.value !== root) {
    fail(new Error("当前工程的生成计划仍在加载，旧工程任务已失效。"));
    return;
  }
  const actionTarget = request.command === "cancel_studio_generation_run"
    ? `run:${request.payload.generationRunId}`
    : `plan:${request.payload.planId}`;
  const scope = planActionGate.begin(root, actionTarget);
  const isCurrent = () => planActionGate.isCurrent(scope, props.projectRoot, actionTarget);
  actionBusy.value = request.command;
  try {
    // 语义哈希信封：响应丢失后的同语义重按回放同一 durable outcome，不重复执行。
    const envelope = await createStudioCommandEnvelope(request);
    if (!isCurrent()) return;
    await window.canvasApi.executeStudioCommand(root, envelope);
    if (!isCurrent()) return;
    const token = requestToken;
    await Promise.all([loadProgress(root, token), loadLedger(root, token)]);
  } catch (reason) {
    if (isCurrent()) fail(reason);
  } finally {
    if (isCurrent()) actionBusy.value = "";
  }
}

function cancelNode(node: StudioGenerationPlanProgressNode): void {
  if (isUnknownBlockedNode(node)) return;
  void runPlanAction(
    { command: "cancel_studio_generation_run", payload: { generationRunId: node.generationRunId, reason: "用户在生成控制面板取消" } },
    "仅停止账本跟踪，不撤回已派发意图；已出图结果不会被删除。确定取消该任务？",
  );
}

function retryPlan(planId: string, nodeIndex?: number): void {
  const group = planGroups.value.find((entry) => entry.planId === planId);
  const targetedNodes = nodeIndex === undefined
    ? group?.nodes ?? []
    : group?.nodes.filter((node) => node.nodeIndex === nodeIndex) ?? [];
  if (isUnknownBlockedGroup(targetedNodes)) return;
  void runPlanAction(
    { command: "retry_studio_generation_plan_nodes", payload: { planId, ...(nodeIndex === undefined ? {} : { nodeIndexes: [nodeIndex] }) } },
    "将创建新 attempt，旧结果保留不动。确定重试？",
  );
}

function locateNode(node: StudioGenerationPlanProgressNode): void {
  emit("openCanvas", node.targetKind === "unit-grid"
    ? { unitId: node.unitId }
    : { unitId: node.unitId, panelId: node.panelId });
}

async function refresh(): Promise<void> {
  const root = props.projectRoot;
  const token = ++requestToken;
  loading.value = true;
  errorMessage.value = "";
  unitCursor.value = undefined;
  unitCursorStack.value = [];
  // P24 R3-N2：刷新即失效分类缓存——同工程并发推进修订后旧分类不得残留（下次展开重取）。
  packCurrentness.value = {};
  try {
    await Promise.all([
      loadLedger(root, token),
      loadProgress(root, token),
      (async () => {
        const next = await props.api.getDashboard(root, { operation: "units", limit: 36 }) as StudioDashboardUnitsPage;
        if (disposed || token !== requestToken || root !== props.projectRoot) return;
        units.value = next;
        const requested = props.unitId?.trim();
        const target = requested && next.page.items.some((item) => item.id === requested)
          ? requested
          : next.page.items[0]?.id;
        if (target) await selectUnit(target, props.panelId, token);
        else detail.value = null;
      })(),
    ]);
  } catch (reason) {
    if (token === requestToken && root === props.projectRoot) fail(reason);
  } finally {
    if (token === requestToken) loading.value = false;
  }
}

async function selectUnit(unitId: string, panelId?: string, parentToken?: number): Promise<void> {
  const root = props.projectRoot;
  const token = parentToken ?? ++requestToken;
  const focusChanged = selectedUnitId.value !== unitId
    || Boolean(panelId?.trim() && selectedPanelId.value !== panelId.trim());
  if (focusChanged) resetHistoryPagination();
  selectedUnitId.value = unitId;
  const next = await props.api.getDashboard(root, {
    operation: "unit",
    unitId,
    ...(panelId?.trim() ? { panelId: panelId.trim() } : {}),
  }) as StudioDashboardUnitDetail;
  if (disposed || token !== requestToken || root !== props.projectRoot || selectedUnitId.value !== unitId) return;
  detail.value = next;
  selectedPanelId.value = next.selectedPanelId ?? next.panels[0]?.id ?? "";
  await loadHistory(token);
}

async function selectPanel(panelId: string): Promise<void> {
  if (!selectedUnitId.value) return;
  selectedPanelId.value = panelId;
  await selectUnit(selectedUnitId.value, panelId);
}

function resetHistoryPagination(): void {
  historyCursor.value = undefined;
  historyNextCursor.value = undefined;
  historyCursorStack.value = [];
}

async function isDuduManagedProject(root: string): Promise<boolean> {
  if (duduDetectionRoot === root && duduProject.value !== null) return duduProject.value;
  duduDetectionRoot = root;
  duduProject.value = null;
  try {
    const control = await window.canvasApi.getDuduReadonlyImportControl(root);
    if (duduDetectionRoot !== root || root !== props.projectRoot) return false;
    duduProject.value = control.kind === "dudu-readonly-import-control";
  } catch {
    if (duduDetectionRoot === root && root === props.projectRoot) duduProject.value = false;
  }
  return duduDetectionRoot === root && duduProject.value === true;
}

async function loadHistory(parentToken?: number): Promise<void> {
  const loadSequence = historyLoadGate.begin();
  if (!selectedUnitId.value) {
    history.value = [];
    detachedUnknownControl.value = null;
    videoControl.value = null;
    videoControlError.value = "";
    videoControlLoading.value = false;
    videoControlToken += 1;
    historyLoading.value = false;
    return;
  }
  const root = props.projectRoot;
  const token = parentToken ?? requestToken;
  const unitId = selectedUnitId.value;
  const isCurrent = () => (
    !disposed
    && historyLoadGate.isCurrent(loadSequence)
    && token === requestToken
    && root === props.projectRoot
    && selectedUnitId.value === unitId
  );
  historyLoading.value = true;
  try {
    const useUnitGrid = await isDuduManagedProject(root)
      || (progress.value?.nodes.some((node) => node.targetKind === "unit-grid" && node.unitId === unitId) ?? false);
    if (!isCurrent()) return;
    const desiredTargetKind = useUnitGrid ? "unit-grid" as const : "panel" as const;
    if (historyTargetKind.value !== desiredTargetKind) {
      resetHistoryPagination();
      historyTargetKind.value = desiredTargetKind;
    }
    unitGridReadinessPackId.value = "";
    detachedUnknownControl.value = null;
    const page = desiredTargetKind === "unit-grid"
      ? await Promise.all([
          window.canvasApi.getStudioGenerationControl(root, {
            operation: "history",
            targetKind: "unit-grid",
            unitId,
            ...(historyCursor.value ? { cursor: historyCursor.value } : {}),
            limit: 24,
            order: "newest-first",
          }),
          window.canvasApi.getStudioGenerationControl(root, {
            operation: "readiness",
            targetKind: "unit-grid",
            unitId,
          }),
          window.canvasApi.getStudioGenerationControl(root, {
            operation: "detached-unknown",
            unitId,
          }),
        ]).then(([historyResult, readinessResult, detachedUnknownResult]) => {
          if (historyResult.operation !== "history" || historyResult.status !== "ready") {
            throw new Error("unit-grid 生成历史投影不可用。");
          }
          if (detachedUnknownResult.operation !== "detached-unknown"
            || detachedUnknownResult.status !== "ready"
            || detachedUnknownResult.unitId !== unitId) {
            throw new Error("unit-grid generation_unknown 防重投影不可用。");
          }
          const readinessPackId = readinessResult.operation === "readiness"
            && readinessResult.status === "ready"
            ? readinessResult.candidate.packId
            : "";
          return {
            items: historyResult.items,
            nextCursor: historyResult.nextCursor,
            readinessPackId,
            detachedUnknownControl: detachedUnknownResult as DetachedUnknownControlView,
          };
        })
      : selectedPanelId.value
        ? await window.canvasApi.listStudioGenerationPanelHistory(root, {
            unitId,
            panelId: selectedPanelId.value,
            ...(historyCursor.value ? { cursor: historyCursor.value } : {}),
            limit: 24,
            order: "newest-first",
          }).then((result) => ({ ...result, readinessPackId: "", detachedUnknownControl: null }))
        : {
            items: [] as StudioGenerationResultRecord[],
            nextCursor: undefined,
            readinessPackId: "",
            detachedUnknownControl: null,
          };
    if (!isCurrent()) return;
    unitGridReadinessPackId.value = page.readinessPackId;
    detachedUnknownControl.value = page.detachedUnknownControl;
    if (page.detachedUnknownControl) {
      detachedUnknownNodeStates.value = {
        ...detachedUnknownNodeStates.value,
        [unitId]: page.detachedUnknownControl.generationBlocked ? "blocked" : "clear",
      };
    }
    history.value = page.items;
    historyNextCursor.value = page.nextCursor;
    await loadVideoPackageControl(root, token, page.items);
  } catch (reason) {
    if (isCurrent()) fail(reason);
  } finally {
    if (isCurrent()) historyLoading.value = false;
  }
}

async function loadVideoPackageControl(
  root: string,
  parentToken: number,
  items: StudioGenerationResultRecord[],
): Promise<void> {
  const token = ++videoControlToken;
  videoControl.value = null;
  higgsfieldVideoControl.value = null;
  videoControlError.value = "";
  videoControlLoading.value = false;
  if (historyTargetKind.value !== "unit-grid" || generationActionsBlocked.value) return;
  const newestResult = items[0];
  const packId = newestResult?.packId
    ?? (progress.value?.nodes ?? []).find((node) => (
      node.targetKind === "unit-grid" && node.unitId === selectedUnitId.value
    ))?.packId
    ?? unitGridReadinessPackId.value;
  if (!packId) return;
  videoControlLoading.value = true;
  try {
    const generationRunId = newestResult?.generationRunId;
    const review = generationRunId
      ? await window.canvasApi.getStudioGenerationReviewControl(root, generationRunId)
      : null;
    const query = review?.head?.reviewId && review.status === "pass"
      ? { by: "authority-latest" as const, authority: { kind: "studio-review" as const, reviewId: review.head.reviewId } }
      : { by: "authority-latest" as const, authority: { kind: "historical-import" as const, packId } };
    const control = await window.canvasApi.getStudioVideoPackageControl(root, query);
    if (disposed || token !== videoControlToken || parentToken !== requestToken || root !== props.projectRoot) return;
    videoControl.value = control;
    const intentId = control.selectedIntentId;
    if (intentId) {
      const higgsfield = await window.canvasApi.getStudioHiggsfieldVideoGenerationControl(root, intentId);
      if (disposed || token !== videoControlToken || parentToken !== requestToken || root !== props.projectRoot) return;
      higgsfieldVideoControl.value = higgsfield;
    }
  } catch (reason) {
    if (token === videoControlToken && parentToken === requestToken && root === props.projectRoot) {
      videoControlError.value = reason instanceof Error ? reason.message : String(reason);
    }
  } finally {
    if (token === videoControlToken) videoControlLoading.value = false;
  }
}

async function queueHiggsfieldVideo(intentId: string): Promise<void> {
  if (!intentId || higgsfieldQueueBusy.value || generationActionsBlocked.value) return;
  const root = props.projectRoot;
  higgsfieldQueueBusy.value = true;
  try {
    const envelope = await createStudioCommandEnvelope({
      command: "enqueue_studio_higgsfield_connector_request",
      payload: { kind: "video", intentId },
    });
    if (root !== props.projectRoot || disposed) return;
    await window.canvasApi.executeStudioCommand(root, envelope);
    if (root !== props.projectRoot || disposed) return;
    await loadVideoPackageControl(root, requestToken, history.value);
  } catch (reason) {
    if (root === props.projectRoot && !disposed) fail(reason);
  } finally {
    if (root === props.projectRoot) higgsfieldQueueBusy.value = false;
  }
}

async function queueHiggsfieldImage(node: StudioGenerationPlanProgressNode): Promise<void> {
  if (higgsfieldQueueBusy.value || generationActionsBlocked.value || node.status !== "dispatched" || isUnknownBlockedNode(node)) return;
  const root = props.projectRoot;
  higgsfieldQueueBusy.value = true;
  try {
    const envelope = await createStudioCommandEnvelope({
      command: "enqueue_studio_higgsfield_connector_request",
      payload: { kind: "image", imageGenerationRunId: node.generationRunId, executionAdapter: "higgsfield-connector" },
    });
    if (root !== props.projectRoot || disposed) return;
    await window.canvasApi.executeStudioCommand(root, envelope);
    if (root !== props.projectRoot || disposed) return;
    await loadProgress(root, requestToken);
  } catch (reason) {
    if (root === props.projectRoot && !disposed) fail(reason);
  } finally {
    if (root === props.projectRoot) higgsfieldQueueBusy.value = false;
  }
}

async function nextUnits(): Promise<void> {
  const cursor = units.value?.page.nextCursor;
  if (!cursor) return;
  unitCursorStack.value.push(unitCursor.value ?? "");
  unitCursor.value = cursor;
  try { await loadUnits(); } catch (reason) { fail(reason); }
}

async function previousUnits(): Promise<void> {
  if (!unitCursorStack.value.length) return;
  unitCursor.value = unitCursorStack.value.pop() || undefined;
  try { await loadUnits(); } catch (reason) { fail(reason); }
}

async function nextHistory(): Promise<void> {
  if (!historyNextCursor.value) return;
  historyCursorStack.value.push(historyCursor.value ?? "");
  historyCursor.value = historyNextCursor.value;
  await loadHistory();
}

async function previousHistory(): Promise<void> {
  if (!historyCursorStack.value.length) return;
  historyCursor.value = historyCursorStack.value.pop() || undefined;
  await loadHistory();
}

function currentFocus(): { unitId?: string; panelId?: string } {
  return {
    ...(selectedUnitId.value ? { unitId: selectedUnitId.value } : {}),
    ...(selectedPanelId.value ? { panelId: selectedPanelId.value } : {}),
  };
}

function openCanvas(): void { emit("openCanvas", currentFocus()); }
function openBinding(): void { emit("openBinding", currentFocus()); }
function openReview(): void {
  const continuity = detail.value?.selectedPanel?.continuityReview;
  const pair = latestReviewPair.value;
  if (!pair || !continuity || generationActionsBlocked.value) return;
  const scope = continuity.scope;
  const generationTarget = pair.raw.targetKind === "unit-grid"
    ? { targetKind: "unit-grid" as const, targetKey: pair.raw.targetKey }
    : {
        targetKind: "panel" as const,
        targetKey: pair.raw.targetKey,
        panelId: pair.raw.panelId,
      };
  emit("openReview", {
    token: ++reviewToken,
    unitId: scope.unitId,
    unitRevision: scope.unitRevision,
    panelId: scope.scopeId,
    startMilliseconds: scope.startMilliseconds,
    endMilliseconds: scope.endMilliseconds,
    assetIds: detail.value?.selectedPanel?.controlAssets.map((asset) => asset.assetId) ?? [],
    generationRunId: pair.generationRunId,
    rawResultId: pair.raw.resultId,
    rawSha256: pair.raw.mediaSha256,
    labeledResultId: pair.labeled.resultId,
    labeledSha256: pair.labeled.mediaSha256,
    packId: pair.raw.packId,
    generationTarget,
  });
}

let generationEventRefreshRoot = "";
let generationEventRefreshToken = 0;
const generationEventRefreshLoop = createDebouncedDirtyRefreshLoop({
  debounceMs: 120,
  run: async () => {
    const root = props.projectRoot;
    const token = requestToken;
    generationEventRefreshRoot = root;
    generationEventRefreshToken = token;
    if (disposed || !root) return;
    await Promise.all([
      loadProgress(root, token),
      loadLedger(root, token),
    ]);
    if (disposed || token !== requestToken || root !== props.projectRoot) return;
    await loadHistory(token);
  },
  onError: (reason) => {
    if (!disposed
      && generationEventRefreshRoot === props.projectRoot
      && generationEventRefreshToken === requestToken) fail(reason);
  },
});

watch(() => props.projectRoot, () => {
  requestToken += 1;
  ledgerLoadGate.invalidate();
  historyLoadGate.invalidate();
  generationEventRefreshLoop.reset();
  planActionGate.invalidate();
  progressLoadGate.invalidate();
  actionBusy.value = "";
  progressOwnerRoot.value = "";
  ledger.value = null;
  progress.value = null;
  units.value = null;
  detail.value = null;
  history.value = [];
  selectedUnitId.value = "";
  selectedPanelId.value = "";
  loading.value = true;
  historyLoading.value = false;
  // P24 R3-F2/F3：切工程必须清 U1/U2 身份与分类缓存（分类随各工程 binding head 状态实时重算，跨工程不可复用）。
  packCurrentness.value = {};
  frozenPackIdentity.value = null;
  frozenPackError.value = "";
  duduDetectionRoot = "";
  duduProject.value = null;
  detachedUnknownControl.value = null;
  detachedUnknownNodeStates.value = {};
  detachedUnknownNodeToken += 1;
  detachedUnknownControl.value = null;
  videoControl.value = null;
  videoControlError.value = "";
  videoControlLoading.value = false;
  videoControlToken += 1;
  historyTargetKind.value = "panel";
  resetHistoryPagination();
  void refresh();
});
watch(() => [props.unitId, props.panelId], () => {
  if (props.unitId && props.unitId !== selectedUnitId.value) void refresh();
  else if (props.panelId && props.panelId !== selectedPanelId.value) void selectPanel(props.panelId);
});
onMounted(() => {
  void refresh();
  // P21：进度事件仅作失效信号；收到后重新拉取全量投影与账本计数。
  unsubscribeProgress = window.canvasApi.onStudioGenerationProgress((payload) => {
    if (disposed) return;
    const currentProjectId = detail.value?.projectId ?? units.value?.projectId;
    if (!currentProjectId || payload.projectId !== currentProjectId) return;
    generationEventRefreshLoop.markDirty();
  });
});
onBeforeUnmount(() => {
  disposed = true;
  generationEventRefreshLoop.dispose();
  planActionGate.dispose();
  progressLoadGate.dispose();
  requestToken += 1;
  ledgerLoadGate.invalidate();
  historyLoadGate.invalidate();
  unsubscribeProgress?.();
});
</script>

<style scoped>
.studio-generation-control{height:100%;min-height:640px;display:grid;grid-template-rows:auto auto auto minmax(0,1fr);overflow:hidden;background:var(--ui-surface);color:var(--ui-text);font-family:Inter,"PingFang SC",sans-serif}.generation-header{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--ui-line);background:var(--ui-bg)}.generation-header span{color:var(--ui-accent);font:700 9px ui-monospace,monospace;letter-spacing:.12em}.generation-header h2{margin:6px 0 3px;font-size:20px}.generation-header p{margin:0;color:var(--ui-text-3);font-size:10px}.generation-header button,.pager button,.panel-stage header button,.generation-detail footer button{height:30px;padding:0 10px;border:1px solid var(--ui-accent);background:transparent;color:var(--ui-accent);cursor:pointer}.generation-header button:disabled,.pager button:disabled,.generation-detail footer button:disabled{opacity:.4;cursor:not-allowed}.generation-error{padding:9px 18px;border-bottom:1px solid var(--ui-danger);background:color-mix(in srgb, var(--ui-danger) 10%, var(--ui-surface));color:var(--ui-danger);font-size:10px}.generation-counts{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid var(--ui-line)}.generation-counts article{padding:12px 18px;border-right:1px solid var(--ui-line)}.generation-counts strong,.generation-counts span{display:block}.generation-counts strong{font:600 19px ui-monospace,monospace}.generation-counts span{margin-top:4px;color:var(--ui-text-3);font-size:9px}.generation-counts .warn strong{color:var(--ui-accent)}.generation-layout{min-height:0;display:grid;grid-template-columns:230px minmax(300px,1fr) 360px}.unit-rail,.generation-detail{min-height:0;overflow:auto;background:var(--ui-surface)}.unit-rail{border-right:1px solid var(--ui-line)}.unit-rail>header{height:42px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid var(--ui-line)}.unit-rail>header b{font-size:10px}.unit-rail>header small{color:var(--ui-text-3)}.unit-rail>button{width:100%;display:grid;gap:5px;padding:11px 14px;border:0;border-bottom:1px solid var(--ui-line);background:transparent;color:var(--ui-text-2);text-align:left;cursor:pointer;content-visibility:auto;contain-intrinsic-size:auto 56px}.unit-rail>button.active{box-shadow:inset 2px 0 var(--ui-accent);background:var(--ui-surface-2);color:var(--ui-accent)}.unit-rail>button strong{font-size:10px}.unit-rail>button span{color:var(--ui-text-3);font-size:8px}.pager{display:flex;justify-content:center;gap:8px;padding:10px}.panel-stage{min-width:0;min-height:0;overflow:auto;background:var(--ui-surface)}.panel-stage>header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--ui-line)}.panel-stage>header b,.panel-stage>header span{display:block}.panel-stage>header b{font-size:13px}.panel-stage>header span{margin-top:4px;color:var(--ui-text-3);font-size:9px}.panel-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));align-content:start}.panel-list>button{min-height:96px;display:grid;grid-template-columns:30px 1fr;align-items:start;gap:9px;padding:14px;border:0;border-right:1px solid var(--ui-line);border-bottom:1px solid var(--ui-line);background:var(--ui-bg);color:var(--ui-text-2);text-align:left;cursor:pointer;content-visibility:auto;contain-intrinsic-size:auto 96px}.panel-list>button.active{background:var(--ui-accent-soft);color:var(--ui-accent)}.panel-list>button>span{display:grid;place-items:center;width:26px;height:26px;border:1px solid var(--ui-line);border-radius:50%;font:600 9px ui-monospace,monospace}.panel-list strong,.panel-list small{display:block}.panel-list strong{font-size:10px;line-height:1.4}.panel-list small{margin-top:7px;color:var(--ui-text-3);font-size:8px}.generation-detail{border-left:1px solid var(--ui-line)}.generation-detail>header,.generation-detail>section{padding:15px 17px;border-bottom:1px solid var(--ui-line)}.generation-detail>header span{color:var(--ui-accent);font-size:8px}.generation-detail h3{margin:6px 0 0;font-size:15px}.generation-detail>section>b{display:block;margin-bottom:8px;color:var(--ui-text-2);font-size:9px}.generation-detail>section>strong{display:inline-block;padding:4px 7px;border:1px solid var(--ui-line);color:var(--ui-text-2);font-size:8px}.generation-detail>section>strong.ready{border-color:var(--ui-accent);color:var(--ui-accent)}.generation-detail p{margin:8px 0 0;color:var(--ui-text-3);font-size:9px;line-height:1.55}.result-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 0;border-top:1px solid var(--ui-line)}.result-row strong,.result-row small{display:block}.result-row strong{font-size:9px}.result-row small{margin-top:3px;color:var(--ui-text-3);font-size:7px}.result-row>span{color:var(--ui-danger);font-size:8px}.result-row>span.ready{color:var(--ui-accent-strong)}.generation-detail>footer{display:flex;gap:8px;padding:14px 17px}.empty-state{height:100%;display:grid;place-items:center;padding:30px;color:var(--ui-text-3);font-size:10px;text-align:center}@media(max-width:1000px){.generation-layout{grid-template-columns:190px 1fr}.generation-detail{grid-column:1/-1;max-height:330px;border-top:1px solid var(--ui-line)}.generation-counts{grid-template-columns:repeat(2,1fr)}}
</style>
<style scoped>
.generation-plans{border-bottom:1px solid var(--ui-line);background:var(--ui-surface);max-height:220px;overflow:auto}.generation-plans>header{display:flex;align-items:center;justify-content:space-between;padding:8px 18px;border-bottom:1px solid var(--ui-line)}.generation-plans>header b{font-size:10px;color:var(--ui-accent)}.generation-plans>header span{color:var(--ui-text-3);font-size:9px}.plans-empty{padding:10px 18px;color:var(--ui-text-3);font-size:10px}.plan-group{border-bottom:1px solid var(--ui-line)}.plan-group>header{display:flex;align-items:center;justify-content:space-between;padding:6px 18px}.plan-group>header small{color:var(--ui-text-3);font-size:9px}.plan-group>header button{height:22px;padding:0 8px;border:1px solid var(--ui-accent);background:transparent;color:var(--ui-accent);cursor:pointer;font-size:9px}.plan-node{display:grid;grid-template-columns:110px minmax(0,1fr) auto;gap:10px;align-items:center;padding:5px 18px;content-visibility:auto;contain-intrinsic-size:auto 32px}.node-status{font-size:9px;padding:2px 6px;border:1px solid var(--ui-line);text-align:center;color:var(--ui-text-2)}.node-status.dispatched,.node-status.planned{color:var(--ui-accent);border-color:var(--ui-accent)}.node-status.succeeded{color:var(--ui-ok);border-color:var(--ui-ok)}.node-status.failed,.node-status.cancelled{color:var(--ui-danger);border-color:var(--ui-danger)}.node-main{display:grid;gap:2px;min-width:0}.node-main strong{font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.node-main small{color:var(--ui-text-3);font-size:9px}.node-main .node-error{color:var(--ui-danger)}.node-actions{display:flex;gap:6px}.node-actions button{height:22px;padding:0 8px;border:1px solid var(--ui-accent);background:transparent;color:var(--ui-accent);cursor:pointer;font-size:9px}.node-actions button:disabled{opacity:.4;cursor:not-allowed}
</style>
<style scoped>
.plan-id-diagnostics { margin: 0 0 6px; color: var(--msc-text-3, var(--ui-text-3)); font-size: 10px; }
.plan-id-diagnostics > summary { cursor: pointer; }
.generation-unknown-block{background:color-mix(in srgb,var(--ui-danger) 12%,var(--ui-surface));border-bottom-color:var(--ui-danger)!important}.generation-unknown-block>b,.generation-unknown-block>strong{display:block;color:var(--ui-danger)}.generation-unknown-block>strong{margin-top:6px;font-size:11px}.generation-unknown-block>p{color:var(--ui-text-2)}
</style>
