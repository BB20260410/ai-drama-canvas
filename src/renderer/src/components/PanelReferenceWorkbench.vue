<template>
  <section class="reference-workbench" data-testid="panel-reference-workbench">
    <header class="workbench-header">
      <div>
        <span class="kicker">P2 · READ ONLY</span>
        <h2>逐分镜引用闭包</h2>
        <p>核对每个 15 秒宫格的语义资产、时间线依据与最多六项供应商引用槽。</p>
      </div>
      <div class="header-actions">
        <span
          v-if="storeIdentity"
          class="store-mark current"
          data-testid="panel-reference-currentness"
          :title="storeIdentity.checkedAt">
          CURRENT · r{{ storeIdentity.storeRevision }} · {{ shortHash(storeIdentity.storeFingerprint) }}
        </span>
        <button type="button" :disabled="loading" @click="loadAll">
          <RefreshCw :size="14" :class="{ spinning: loading }" />{{ loading ? "读取中" : "刷新证据" }}
        </button>
      </div>
    </header>

    <div v-if="error" class="empty-state" data-testid="panel-reference-unavailable">
      <ShieldAlert :size="28" />
      <strong>引用闭包尚不可读取</strong>
      <p>{{ error }}</p>
      <small>此页面不会自动物化、修复或改写生产侧车。</small>
    </div>

    <template v-else-if="audit">
      <section class="audit-strip" :class="{ passed: audit.closurePassed }" data-testid="panel-reference-audit">
        <div class="audit-verdict">
          <span>{{ audit.closurePassed ? "闭包通过" : "闭包未通过" }}</span>
          <strong>{{ formatNumber(audit.currentContracts) }} <small>单元</small> / {{ formatNumber(audit.panels) }} <small>宫格</small></strong>
          <p>审计指纹 {{ shortHash(audit.auditFingerprint, 16) }}</p>
        </div>
        <dl class="production-counts">
          <div><dt>可进入生成</dt><dd>{{ formatNumber(audit.generationReadyPanels) }}</dd></div>
          <div><dt>待硬锁</dt><dd>{{ formatNumber(audit.pendingHardLockPanels) }}</dd><small>{{ formatNumber(audit.pendingHardLockReferences) }} 项引用</small></div>
          <div><dt>待组合图</dt><dd>{{ formatNumber(audit.pendingDerivedArtifactPanels) }}</dd><small>{{ formatNumber(audit.derivedDefinitions) }} 个定义</small></div>
        </dl>
        <dl class="closure-errors" aria-label="四项闭包错误">
          <div :class="{ clear: audit.unresolvedPanels === 0 }"><dt>未解析面板</dt><dd>{{ audit.unresolvedPanels }}</dd></div>
          <div :class="{ clear: audit.knownAssetMissingBindingPanels === 0 }"><dt>已知资产缺绑定</dt><dd>{{ audit.knownAssetMissingBindingPanels }}</dd></div>
          <div :class="{ clear: audit.unhandledOverflowPanels === 0 }"><dt>未处理超限</dt><dd>{{ audit.unhandledOverflowPanels }}</dd></div>
          <div :class="{ clear: audit.timeSpanContinuityMismatchPanels === 0 }"><dt>时间段不一致</dt><dd>{{ audit.timeSpanContinuityMismatchPanels }}</dd></div>
        </dl>
      </section>

      <section class="filter-bar" aria-label="引用解析筛选">
        <label><span>集数</span><select v-model="episodeFilter"><option value="all">全季</option><option v-for="episode in episodes" :key="episode" :value="String(episode)">EP{{ pad(episode, 2) }}</option></select></label>
        <label><span>闭包状态</span><select v-model="closureFilter"><option value="all">全部</option><option value="resolved">已解析</option><option value="confirmed-empty">确认无引用</option><option value="unresolved">未解析</option></select></label>
        <label><span>生成状态</span><select v-model="readinessFilter"><option value="all">全部</option><option value="ready">可生成</option><option value="blocked">暂不可生成</option></select></label>
        <label class="check-filter"><input v-model="overflowOnly" type="checkbox" /><span>仅看超出六项</span></label>
        <span class="result-count">{{ formatNumber(page?.total ?? 0) }} 个面板</span>
      </section>

      <div class="workbench-body">
        <section class="resolution-list" aria-label="宫格引用解析列表">
          <header class="list-head"><span>单元 / 宫格</span><span>时间</span><span>语义资产</span><span>引用槽</span><span>生产门禁</span></header>
          <div v-if="pageLoading" class="list-loading"><span></span>读取当前筛选…</div>
          <button
            v-for="resolution in page?.items ?? []"
            v-else
            :key="resolution.resolutionId"
            type="button"
            class="resolution-row"
            :data-contract-id="resolution.gridContractId"
            :data-panel-id="resolution.panelId"
            :class="{ selected: selected?.resolutionId === resolution.resolutionId }"
            @click="selectResolution(resolution)">
            <span class="unit-cell"><b>{{ unitLabel(resolution.unitItemId) }}</b><small>宫格 {{ resolution.panelIndex }} / {{ resolution.panelCount }}</small></span>
            <span class="time-cell">{{ seconds(resolution.startSeconds) }}–{{ seconds(resolution.endSeconds) }}</span>
            <span><b>{{ resolution.semanticAssets.length }}</b><small>{{ assetNames(resolution) }}</small></span>
            <span><b>{{ resolution.referenceSlots.length }} / 6</b><small>{{ resolution.detectedOverflow ? "组合资产承接超限" : "直接引用" }}</small></span>
            <span class="gate-cell" :class="resolution.generationReady ? 'ready' : 'blocked'"><i></i><b>{{ resolution.generationReady ? "可生成" : blockerLabel(resolution) }}</b><small>{{ closureLabel(resolution.closureStatus) }}</small></span>
          </button>
          <div v-if="!pageLoading && page && page.items.length === 0" class="no-results">当前筛选没有面板。</div>
          <footer class="pager">
            <button type="button" :disabled="pageOffset === 0 || pageLoading" @click="previousPage"><ChevronLeft :size="14" />上一页</button>
            <span>第 {{ pageNumber }} / {{ pageCount }} 页</span>
            <button type="button" :disabled="!page || pageOffset + pageSize >= page.total || pageLoading" @click="nextPage">下一页<ChevronRight :size="14" /></button>
          </footer>
        </section>

        <aside class="evidence-pane" data-testid="panel-reference-evidence">
          <div v-if="detailLoading" class="detail-loading"><span></span></div>
          <template v-else-if="selected">
            <header class="evidence-header">
              <span class="kicker">RESOLUTION EVIDENCE</span>
              <h3>{{ unitLabel(selected.unitItemId) }} · 宫格 {{ selected.panelIndex }}</h3>
              <p>{{ selected.startSeconds }}s–{{ selected.endSeconds }}s · 原镜 {{ selected.sourceShotNumbers.join("、") || "无" }}</p>
            </header>
            <section class="identity-block">
              <label>Resolution</label><code>{{ selected.resolutionId }}</code>
              <label>Fingerprint</label><code>{{ selected.resolutionFingerprint }}</code>
            </section>
            <section class="evidence-section">
              <header><h4>语义资产</h4><span>{{ selected.semanticAssets.length }}</span></header>
              <article v-for="asset in selected.semanticAssets" :key="asset.bindingId" class="asset-evidence">
                <div><b>{{ asset.assetId }} · {{ asset.assetName }}</b><em>{{ asset.category }}</em></div>
                <p>{{ asset.provenance.map((entry) => provenanceLabel(entry.kind)).join(" + ") }}</p>
                <small v-if="asset.hardLock">硬锁 {{ asset.hardLock.referenceVersion }} · SHA {{ shortHash(asset.hardLock.sha256, 12) }}</small>
                <small v-else class="warning-copy">尚无可用硬锁快照</small>
              </article>
              <p v-if="selected.semanticAssets.length === 0" class="muted-copy">此宫格已经明确确认无语义资产。</p>
            </section>
            <section class="evidence-section">
              <header><h4>供应商引用槽</h4><span>{{ selected.referenceSlots.length }} / 6</span></header>
              <article v-for="slot in selected.referenceSlots" :key="slot.id" class="slot-evidence">
                <div><b>{{ slot.kind === "derived-composite" ? "派生组合" : slot.assetId }}</b><em :class="slot.readiness">{{ readinessLabel(slot.readiness) }}</em></div>
                <p>覆盖 {{ slot.coveredAssetIds.join("、") }}</p>
                <small v-if="slot.sha256">SHA {{ shortHash(slot.sha256, 16) }}{{ slot.reviewId ? ` · Review ${slot.reviewId}` : "" }}</small>
              </article>
            </section>
            <section class="evidence-section" data-testid="panel-reference-exclusions">
              <header><h4>已排除资产</h4><span>{{ selected.excludedAssets.length }}</span></header>
              <article v-for="asset in selected.excludedAssets" :key="`${asset.assetId}-${asset.source}-${asset.overrideId ?? ''}`" class="excluded-evidence">
                <div><b>{{ asset.assetId }}</b><em>{{ exclusionSourceLabel(asset.source) }}</em></div>
                <p>{{ asset.reason }}</p>
                <small v-if="asset.overrideId">人工覆盖 {{ asset.overrideId }}</small>
              </article>
              <p v-if="selected.excludedAssets.length === 0" class="muted-copy">没有被排除的资产。</p>
            </section>
            <section class="evidence-section" data-testid="panel-reference-issues">
              <header><h4>问题与阻断</h4><span>{{ selected.issues.length }}</span></header>
              <article v-for="issue in selected.issues" :key="issue" class="issue-evidence">
                <ShieldAlert :size="12" /><p>{{ issue }}</p>
              </article>
              <p v-if="selected.issues.length === 0" class="muted-copy">当前解析未记录问题。</p>
            </section>
            <section class="evidence-section" data-testid="panel-reference-reconciliations">
              <header><h4>时间线调和</h4><span>{{ selected.timelineReconciliations.length }}</span></header>
              <article v-for="entry in selected.timelineReconciliations" :key="`${entry.assetId}-${entry.difference}`" class="reconciliation">
                <b>{{ entry.assetId }} · {{ reconciliationLabel(entry.difference) }}</b><p>{{ entry.note }}</p>
              </article>
              <p v-if="selected.timelineReconciliations.length === 0" class="muted-copy">分镜行与连续性时间段无差异。</p>
            </section>
            <section class="evidence-section visual-constraint-section" data-testid="panel-visual-constraints">
              <header>
                <h4>P3 剧情与视觉硬锁</h4>
                <span v-if="visualConstraintIdentity" data-testid="panel-visual-currentness">CURRENT · r{{ visualConstraintIdentity.storeRevision }}</span>
                <span v-else>{{ visualConstraintLoading ? "读取中" : "未可用" }}</span>
              </header>
              <div v-if="visualConstraintLoading" class="visual-constraint-loading"><span></span>正在校验当前 P3 约束…</div>
              <article v-else-if="visualConstraintError" class="visual-constraint-unavailable" data-testid="panel-visual-unavailable">
                <ShieldAlert :size="13" />
                <div><b>P3 约束未混入当前详情</b><p>{{ visualConstraintError }}</p><small>上方 P2 引用证据仍为只读展示；普通项目不会被自动物化。</small></div>
              </article>
              <template v-else-if="visualConstraint">
                <div class="visual-constraint-verdict" :class="visualConstraint.generationGate.status">
                  <div><b>{{ visualConstraint.generationGate.status === "ready" ? "P3 生成门禁就绪" : "P3 生成门禁阻断" }}</b><small>{{ visualConstraint.generationGate.blockerCodes.join("、") || "无结构化阻断" }}</small></div>
                  <em>{{ hiddenMaskLabel(visualConstraint.hiddenMaskPolicy.status) }}</em>
                </div>
                <dl class="visual-constraint-identity">
                  <div><dt>Constraint</dt><dd>{{ visualConstraint.constraintId }}</dd></div>
                  <div><dt>Model FP</dt><dd>{{ visualConstraint.modelFingerprint }}</dd></div>
                  <div><dt>Review FP</dt><dd>{{ visualConstraint.reviewRulesFingerprint }}</dd></div>
                </dl>
                <div class="unresolved-summary" data-testid="panel-visual-unresolved">
                  <span>身份未锁 <b>{{ unresolvedIdentityCount }}</b></span>
                  <span>空间未知 <b>{{ unresolvedSpatialCount }}</b></span>
                  <span>连续性未知 <b>{{ unresolvedContinuityCount }}</b></span>
                </div>

                <section class="constraint-group" data-testid="panel-visual-must-appear">
                  <header><b>Must appear</b><span>{{ visualConstraint.mustAppear.length }}</span></header>
                  <article v-for="entry in visualConstraint.mustAppear" :key="entry.referenceBindingId">
                    <div><b>{{ entry.assetId }} · {{ entry.assetName }}</b><em>{{ entry.category }}</em></div><p>{{ entry.modelInstruction }}</p>
                  </article>
                  <p v-if="visualConstraint.mustAppear.length === 0" class="muted-copy">当前宫格没有强制出镜资产。</p>
                </section>
                <section class="constraint-group" data-testid="panel-visual-must-not-appear">
                  <header><b>Must not appear</b><span>{{ visualConstraint.mustNotAppear.length }}</span></header>
                  <article v-for="entry in visualConstraint.mustNotAppear" :key="entry.id">
                    <div><b>{{ entry.warningCode }}</b><em>{{ entry.subject }}</em></div><p>{{ entry.modelInstruction }}</p>
                  </article>
                </section>
                <section class="constraint-group" data-testid="panel-visual-identity-locks">
                  <header><b>身份硬锁</b><span>{{ visualConstraint.identityLocks.length }}</span></header>
                  <article v-for="lock in visualConstraint.identityLocks" :key="lock.bindingId" :class="{ unresolved: lock.status === 'unresolved' }">
                    <div><b>{{ lock.assetId }} · {{ lock.assetName }}</b><em>{{ lock.status === "locked" ? "已锁" : "UNRESOLVED" }}</em></div>
                    <p>{{ lock.requirements.join("；") }}</p><small>{{ presenceLabel(lock.presence) }}<template v-if="lock.referenceSha256"> · {{ lock.referenceVersion }} · {{ shortHash(lock.referenceSha256, 16) }}</template></small>
                  </article>
                </section>
                <section class="constraint-group" data-testid="panel-visual-spatial-locks">
                  <header><b>空间与机位锁</b><span>{{ visualConstraint.spatialLocks.length }}</span></header>
                  <article v-for="lock in visualConstraint.spatialLocks" :key="lock.field" :class="{ unresolved: lock.status === 'unresolved' }">
                    <div><b>{{ spatialFieldLabel(lock.field) }}</b><em>{{ lock.status === "resolved" ? "已解析" : "UNRESOLVED" }}</em></div>
                    <p>{{ lock.values.join("、") || lock.reason || "无来源值" }}</p><small>{{ lock.evidence.length }} 条分镜行证据</small>
                  </article>
                </section>
                <section class="constraint-group" data-testid="panel-visual-continuity-locks">
                  <header><b>连续性锁</b><span>{{ visualConstraint.continuityLocks.length }}</span></header>
                  <article v-for="lock in visualConstraint.continuityLocks" :key="lock.assetId" :class="{ unresolved: lock.status === 'unresolved' }">
                    <div><b>{{ lock.assetId }} · {{ lock.assetName }}</b><em>{{ lock.status === "resolved" ? "已解析" : "UNRESOLVED" }}</em></div>
                    <p>{{ continuitySummary(lock) }}</p><small>{{ presenceLabel(lock.presence) }} · {{ lock.spanIds.length }} 个 span</small>
                  </article>
                </section>
                <section class="constraint-group model-payload" data-testid="panel-visual-model-payload">
                  <header><b>模型安全载荷</b><span>与 Review 规则分离</span></header>
                  <p class="separation-note">仅展示已通过 Core 验证的模型提示；下方人工规则不发送给模型。</p>
                  <label>正向提示</label><pre>{{ visualConstraint.modelPrompt }}</pre>
                  <label>负向提示</label><pre>{{ visualConstraint.modelNegativePrompt }}</pre>
                </section>
                <section class="constraint-group review-rules" data-testid="panel-visual-review-rules">
                  <header><b>本地人工视觉规则</b><span>{{ visualConstraint.reviewRules.length }}</span></header>
                  <p class="separation-note">这些是人工终审清单；系统不宣称已自动识别同脸、犬纹、OCR、水印或现代物。</p>
                  <article v-for="rule in visualConstraint.reviewRules" :key="rule.id">
                    <div><b>{{ rule.code }}</b><em>{{ enforcementLabel(rule.enforcement) }}</em></div><p>{{ rule.instruction }}</p><small>{{ rule.evidenceAssetIds.join("、") || "无指定资产" }}</small>
                  </article>
                </section>
                <section class="constraint-group warnings" data-testid="panel-visual-warnings">
                  <header><b>预警</b><span>{{ visualConstraint.warnings.length }}</span></header>
                  <article v-for="warning in visualConstraint.warnings" :key="warning.code">
                    <div><b>{{ warning.code }}</b><em>{{ warning.severity }} · {{ detectionLabel(warning.detection) }}</em></div><p>{{ warning.message }}</p>
                  </article>
                </section>
              </template>
            </section>
          </template>
          <div v-else class="detail-placeholder"><MousePointer2 :size="22" /><span>选择一个宫格查看引用证据</span></div>

          <section class="derived-section">
            <header><div><span class="kicker">DERIVED REFERENCES</span><h4>派生组合资产</h4></div><strong>{{ derivedPage?.total ?? 0 }}</strong></header>
            <button
              v-for="asset in derivedPage?.items ?? []"
              :key="asset.id"
              type="button"
              class="derived-card"
              :class="{ selected: selectedDerived?.id === asset.id }"
              :data-derived-id="asset.id"
              @click="selectedDerived = asset">
              <div><b>{{ asset.name }}</b><em :class="asset.status">{{ derivedStatusLabel(asset.status) }}</em></div>
              <p>{{ asset.memberAssetIds.join("、") }}</p>
              <small>{{ asset.kind }} · {{ shortHash(asset.definitionFingerprint, 14) }}</small>
              <template v-if="asset.visualArtifact">
                <small class="artifact-path">Path {{ asset.visualArtifact.path }}</small>
                <small class="artifact-sha">SHA {{ asset.visualArtifact.sha256 }}</small>
                <small>Reviewer {{ asset.visualArtifact.reviewer }}</small>
                <small>Review {{ asset.visualArtifact.reviewId }} · {{ asset.visualArtifact.reviewNote }}</small>
              </template>
              <small v-else class="warning-copy">未登记视觉产物</small>
            </button>
            <p v-if="derivedPage && derivedPage.items.length === 0" class="muted-copy">当前没有派生组合资产定义。</p>
            <footer class="pager derived-pager" data-testid="derived-reference-pager">
              <button type="button" :disabled="derivedOffset === 0 || derivedLoading" @click="previousDerivedPage"><ChevronLeft :size="14" />上一页</button>
              <span>第 {{ derivedPageNumber }} / {{ derivedPageCount }} 页</span>
              <button type="button" :disabled="!derivedPage || derivedOffset + derivedPageSize >= derivedPage.total || derivedLoading" @click="nextDerivedPage">下一页<ChevronRight :size="14" /></button>
            </footer>
            <section v-if="selectedDerived" class="derived-detail" data-testid="derived-reference-detail">
              <header><span class="kicker">DERIVED DETAIL</span><h4>{{ selectedDerived.name }}</h4><em :class="selectedDerived.status">{{ derivedStatusLabel(selectedDerived.status) }}</em></header>
              <dl>
                <div><dt>ID / 状态</dt><dd>{{ selectedDerived.id }} · {{ selectedDerived.status }}</dd></div>
                <div><dt>定义审核</dt><dd>{{ selectedDerived.definitionReview.id }} · {{ selectedDerived.definitionReview.reviewedBy }}</dd></div>
                <div><dt>成员</dt><dd>{{ selectedDerived.memberAssetIds.join("、") }}</dd></div>
                <template v-if="selectedDerived.visualArtifact">
                  <div><dt>Path</dt><dd>{{ selectedDerived.visualArtifact.path }}</dd></div>
                  <div><dt>SHA-256</dt><dd>{{ selectedDerived.visualArtifact.sha256 }}</dd></div>
                  <div><dt>Reviewer</dt><dd>{{ selectedDerived.visualArtifact.reviewer }}</dd></div>
                  <div><dt>Review ID</dt><dd>{{ selectedDerived.visualArtifact.reviewId }}</dd></div>
                  <div><dt>Review Note</dt><dd>{{ selectedDerived.visualArtifact.reviewNote }}</dd></div>
                </template>
                <div v-else><dt>视觉产物</dt><dd>未登记；当前不得作为已就绪参考板。</dd></div>
              </dl>
            </section>
          </section>
        </aside>
      </div>
    </template>

    <div v-else class="empty-state"><span class="loader"></span><strong>正在读取引用闭包</strong></div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ChevronLeft, ChevronRight, MousePointer2, RefreshCw, ShieldAlert } from "lucide-vue-next";
import type {
  DerivedPanelReferenceAsset,
  FusionPanelReferenceAudit,
  FusionPanelReferenceCurrentness,
  PanelReferenceProvenanceKind,
  PanelReferenceResolution,
  PanelReferenceResolutionPage,
} from "@core/fusion-panel-references";
import type { FusionPanelVisualConstraintCurrentness } from "@core/fusion-visual-constraint-store";
import type { PanelVisualConstraint, PanelVisualContinuityLock, PanelVisualSpatialField } from "@core/fusion-visual-constraints";

const props = defineProps<{ projectRoot: string }>();
const emit = defineEmits<{ failed: [message: string] }>();

const pageSize = 50;
const derivedPageSize = 10;
const episodes = Array.from({ length: 32 }, (_, index) => index + 1);
const loading = ref(false);
const pageLoading = ref(false);
const derivedLoading = ref(false);
const detailLoading = ref(false);
const error = ref("");
const audit = ref<FusionPanelReferenceAudit | null>(null);
const page = ref<PanelReferenceResolutionPage | null>(null);
const derivedPage = ref<{ total: number; offset: number; limit: number; items: DerivedPanelReferenceAsset[]; storeRevision: number } | null>(null);
const storeIdentity = ref<FusionPanelReferenceCurrentness | null>(null);
const selected = ref<PanelReferenceResolution | null>(null);
const visualConstraint = ref<PanelVisualConstraint | null>(null);
const visualConstraintIdentity = ref<FusionPanelVisualConstraintCurrentness | null>(null);
const visualConstraintLoading = ref(false);
const visualConstraintError = ref("");
const selectedDerived = ref<DerivedPanelReferenceAsset | null>(null);
const episodeFilter = ref("all");
const closureFilter = ref("all");
const readinessFilter = ref("all");
const overflowOnly = ref(false);
const pageOffset = ref(0);
const derivedOffset = ref(0);
let pageRequest = 0;
let allRequest = 0;
let detailRequest = 0;
let derivedRequest = 0;
let visualConstraintRequest = 0;

const pageNumber = computed(() => Math.floor(pageOffset.value / pageSize) + 1);
const pageCount = computed(() => Math.max(1, Math.ceil((page.value?.total ?? 0) / pageSize)));
const derivedPageNumber = computed(() => Math.floor(derivedOffset.value / derivedPageSize) + 1);
const derivedPageCount = computed(() => Math.max(1, Math.ceil((derivedPage.value?.total ?? 0) / derivedPageSize)));
const unresolvedIdentityCount = computed(() => visualConstraint.value?.identityLocks.filter((lock) => lock.status === "unresolved").length ?? 0);
const unresolvedSpatialCount = computed(() => visualConstraint.value?.spatialLocks.filter((lock) => lock.status === "unresolved").length ?? 0);
const unresolvedContinuityCount = computed(() => visualConstraint.value?.continuityLocks.filter((lock) => lock.status === "unresolved").length ?? 0);

onMounted(loadAll);
watch(() => props.projectRoot, () => {
  pageOffset.value = 0;
  derivedOffset.value = 0;
  clearSelections();
  void loadAll();
});
watch([episodeFilter, closureFilter, readinessFilter, overflowOnly], () => {
  pageOffset.value = 0;
  selected.value = null;
  void loadPage();
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clearSelections(): void {
  selected.value = null;
  selectedDerived.value = null;
  visualConstraintRequest += 1;
  visualConstraint.value = null;
  visualConstraintIdentity.value = null;
  visualConstraintLoading.value = false;
  visualConstraintError.value = "";
}

function resolutionQuery(): Parameters<typeof window.canvasApi.listFusionPanelReferenceResolutions>[1] {
  return {
    episode: episodeFilter.value === "all" ? undefined : Number(episodeFilter.value),
    closureStatus: closureFilter.value === "all" ? undefined : closureFilter.value as PanelReferenceResolution["closureStatus"],
    generationReady: readinessFilter.value === "all" ? undefined : readinessFilter.value === "ready",
    overflowOnly: overflowOnly.value || undefined,
    offset: pageOffset.value,
    limit: pageSize,
  };
}

function assertCurrent(identity: FusionPanelReferenceCurrentness, phase: string): void {
  if (!identity.current) {
    throw new Error(`${phase}：P2 输入已漂移（${identity.driftedInputs.join("、") || "未知输入"}），拒绝混合读取。`);
  }
  if (!Number.isInteger(identity.storeRevision) || identity.storeRevision < 1 || !identity.storeFingerprint) {
    throw new Error(`${phase}：P2 store 身份不完整，拒绝显示。`);
  }
}

function sameIdentity(left: Pick<FusionPanelReferenceCurrentness, "storeRevision" | "storeFingerprint">, right: Pick<FusionPanelReferenceCurrentness, "storeRevision" | "storeFingerprint">): boolean {
  return left.storeRevision === right.storeRevision && left.storeFingerprint === right.storeFingerprint;
}

function assertSameIdentity(expected: Pick<FusionPanelReferenceCurrentness, "storeRevision" | "storeFingerprint">, actual: FusionPanelReferenceCurrentness, phase: string): void {
  assertCurrent(actual, phase);
  if (!sameIdentity(expected, actual)) {
    throw new Error(`${phase}：读取期间 store 从 r${expected.storeRevision}/${shortHash(expected.storeFingerprint)} 变为 r${actual.storeRevision}/${shortHash(actual.storeFingerprint)}，页面已失效。`);
  }
}

function assertPageIdentity(expected: FusionPanelReferenceCurrentness, next: PanelReferenceResolutionPage, phase: string): void {
  if (next.storeRevision !== expected.storeRevision || next.storeFingerprint !== expected.storeFingerprint) {
    throw new Error(`${phase}：分页返回的 store 身份与 currentness 不一致。`);
  }
}

function failClosed(cause: unknown): void {
  allRequest += 1;
  pageRequest += 1;
  detailRequest += 1;
  derivedRequest += 1;
  visualConstraintRequest += 1;
  audit.value = null;
  page.value = null;
  derivedPage.value = null;
  storeIdentity.value = null;
  clearSelections();
  loading.value = false;
  pageLoading.value = false;
  derivedLoading.value = false;
  detailLoading.value = false;
  error.value = message(cause);
  emit("failed", error.value);
}

async function loadAll(): Promise<void> {
  if (!props.projectRoot) return;
  const request = ++allRequest;
  const pageGuard = ++pageRequest;
  const detailGuard = ++detailRequest;
  const derivedGuard = ++derivedRequest;
  const projectRoot = props.projectRoot;
  clearSelections();
  derivedOffset.value = 0;
  loading.value = true;
  pageLoading.value = true;
  derivedLoading.value = true;
  detailLoading.value = false;
  error.value = "";
  try {
    const before = await window.canvasApi.inspectFusionPanelReferenceCurrentness(projectRoot);
    assertCurrent(before, "整页读取前校验");
    const [nextPage, nextDerived] = await Promise.all([
      window.canvasApi.listFusionPanelReferenceResolutions(projectRoot, resolutionQuery()),
      window.canvasApi.listDerivedPanelReferenceAssets(projectRoot, { offset: 0, limit: derivedPageSize }),
    ]);
    const after = await window.canvasApi.inspectFusionPanelReferenceCurrentness(projectRoot);
    assertSameIdentity(before, after, "整页读取后校验");
    assertPageIdentity(after, nextPage, "整页分页");
    if (nextDerived.storeRevision !== after.storeRevision) throw new Error("派生资产分页与当前 store 修订不一致。");
    if (request !== allRequest || pageGuard !== pageRequest || detailGuard !== detailRequest || derivedGuard !== derivedRequest || projectRoot !== props.projectRoot) return;
    storeIdentity.value = after;
    audit.value = nextPage.audit;
    page.value = nextPage;
    derivedPage.value = nextDerived;
  } catch (cause) {
    if (request !== allRequest || projectRoot !== props.projectRoot) return;
    failClosed(cause);
  } finally {
    if (request === allRequest) {
      loading.value = false;
      if (pageGuard === pageRequest) pageLoading.value = false;
      if (derivedGuard === derivedRequest) derivedLoading.value = false;
    }
  }
}

async function loadPage(): Promise<void> {
  if (!props.projectRoot || !audit.value || !storeIdentity.value) return;
  const request = ++pageRequest;
  const projectRoot = props.projectRoot;
  const expected = { ...storeIdentity.value };
  selected.value = null;
  pageLoading.value = true;
  try {
    const before = await window.canvasApi.inspectFusionPanelReferenceCurrentness(projectRoot);
    assertSameIdentity(expected, before, "分页读取前校验");
    const next = await window.canvasApi.listFusionPanelReferenceResolutions(projectRoot, resolutionQuery());
    const after = await window.canvasApi.inspectFusionPanelReferenceCurrentness(projectRoot);
    assertSameIdentity(expected, after, "分页读取后校验");
    assertPageIdentity(after, next, "宫格分页");
    if (request === pageRequest && projectRoot === props.projectRoot) {
      page.value = next;
      audit.value = next.audit;
      storeIdentity.value = after;
    }
  } catch (cause) {
    if (request === pageRequest && projectRoot === props.projectRoot) failClosed(cause);
  } finally {
    if (request === pageRequest) pageLoading.value = false;
  }
}

async function loadDerivedPage(): Promise<void> {
  if (!props.projectRoot || !audit.value || !storeIdentity.value) return;
  const request = ++derivedRequest;
  const projectRoot = props.projectRoot;
  const expected = { ...storeIdentity.value };
  selectedDerived.value = null;
  derivedLoading.value = true;
  try {
    const before = await window.canvasApi.inspectFusionPanelReferenceCurrentness(projectRoot);
    assertSameIdentity(expected, before, "派生分页读取前校验");
    const next = await window.canvasApi.listDerivedPanelReferenceAssets(projectRoot, { offset: derivedOffset.value, limit: derivedPageSize });
    const after = await window.canvasApi.inspectFusionPanelReferenceCurrentness(projectRoot);
    assertSameIdentity(expected, after, "派生分页读取后校验");
    if (next.storeRevision !== after.storeRevision) throw new Error("派生资产分页与当前 store 修订不一致。");
    if (request === derivedRequest && projectRoot === props.projectRoot) {
      derivedPage.value = next;
      storeIdentity.value = after;
    }
  } catch (cause) {
    if (request === derivedRequest && projectRoot === props.projectRoot) failClosed(cause);
  } finally {
    if (request === derivedRequest) derivedLoading.value = false;
  }
}

async function selectResolution(resolution: PanelReferenceResolution): Promise<void> {
  if (!storeIdentity.value) return;
  const request = ++detailRequest;
  const projectRoot = props.projectRoot;
  const expected = { ...storeIdentity.value };
  selected.value = null;
  visualConstraintRequest += 1;
  visualConstraint.value = null;
  visualConstraintIdentity.value = null;
  visualConstraintError.value = "";
  visualConstraintLoading.value = false;
  detailLoading.value = true;
  try {
    const before = await window.canvasApi.inspectFusionPanelReferenceCurrentness(projectRoot);
    assertSameIdentity(expected, before, "详情读取前校验");
    const next = await window.canvasApi.getFusionPanelReferenceResolution(
      projectRoot,
      resolution.gridContractId,
      resolution.panelId,
    );
    const after = await window.canvasApi.inspectFusionPanelReferenceCurrentness(projectRoot);
    assertSameIdentity(expected, after, "详情读取后校验");
    if (next.resolutionId !== resolution.resolutionId
      || next.resolutionFingerprint !== resolution.resolutionFingerprint
      || next.gridContractId !== resolution.gridContractId
      || next.panelId !== resolution.panelId) {
      throw new Error("详情返回的 resolution 与当前分页行不一致，拒绝混合展示。");
    }
    if (request === detailRequest && projectRoot === props.projectRoot) {
      selected.value = next;
      storeIdentity.value = after;
      void loadVisualConstraint(next);
    }
  } catch (cause) {
    if (request === detailRequest && projectRoot === props.projectRoot) failClosed(cause);
  } finally {
    if (request === detailRequest) detailLoading.value = false;
  }
}

async function loadVisualConstraint(resolution: PanelReferenceResolution): Promise<void> {
  const request = ++visualConstraintRequest;
  const projectRoot = props.projectRoot;
  visualConstraint.value = null;
  visualConstraintIdentity.value = null;
  visualConstraintError.value = "";
  visualConstraintLoading.value = true;
  try {
    const before = await window.canvasApi.inspectFusionPanelVisualConstraintCurrentness(projectRoot);
    assertVisualConstraintCurrent(before, "P3 详情读取前校验");
    const constraint = await window.canvasApi.getFusionPanelVisualConstraint(projectRoot, resolution.gridContractId, resolution.panelId);
    const after = await window.canvasApi.inspectFusionPanelVisualConstraintCurrentness(projectRoot);
    assertVisualConstraintCurrent(after, "P3 详情读取后校验");
    if (before.storeRevision !== after.storeRevision || before.storeFingerprint !== after.storeFingerprint) {
      throw new Error("P3 约束仓在详情读取期间已变化。");
    }
    if (constraint.gridContractId !== resolution.gridContractId
      || constraint.panelId !== resolution.panelId
      || constraint.inputSnapshot.resolutionId !== resolution.resolutionId
      || constraint.inputSnapshot.resolutionFingerprint !== resolution.resolutionFingerprint) {
      throw new Error("P3 约束与当前 P2 resolution 身份不一致。");
    }
    if (request !== visualConstraintRequest || projectRoot !== props.projectRoot || selected.value?.resolutionId !== resolution.resolutionId) return;
    visualConstraint.value = constraint;
    visualConstraintIdentity.value = after;
  } catch (cause) {
    if (request !== visualConstraintRequest || projectRoot !== props.projectRoot || selected.value?.resolutionId !== resolution.resolutionId) return;
    visualConstraintError.value = message(cause);
  } finally {
    if (request === visualConstraintRequest) visualConstraintLoading.value = false;
  }
}

function assertVisualConstraintCurrent(identity: FusionPanelVisualConstraintCurrentness, phase: string): void {
  if (!identity.current) throw new Error(`${phase}：P3 输入已漂移（${identity.driftedInputs.join("、") || "未知输入"}）。`);
  if (!Number.isInteger(identity.storeRevision) || identity.storeRevision < 1 || !identity.storeFingerprint) {
    throw new Error(`${phase}：P3 store 身份不完整。`);
  }
}

function previousPage(): void {
  pageOffset.value = Math.max(0, pageOffset.value - pageSize);
  selected.value = null;
  void loadPage();
}

function nextPage(): void {
  pageOffset.value += pageSize;
  selected.value = null;
  void loadPage();
}

function previousDerivedPage(): void {
  derivedOffset.value = Math.max(0, derivedOffset.value - derivedPageSize);
  selectedDerived.value = null;
  void loadDerivedPage();
}

function nextDerivedPage(): void {
  derivedOffset.value += derivedPageSize;
  selectedDerived.value = null;
  void loadDerivedPage();
}

function shortHash(value?: string, length = 10): string {
  if (!value) return "—";
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

function formatNumber(value: number): string { return new Intl.NumberFormat("zh-CN").format(value); }
function pad(value: number, length: number): string { return String(value).padStart(length, "0"); }
function seconds(value: number): string { return `${Number.isInteger(value) ? value : value.toFixed(1)}s`; }
function unitLabel(itemId: string): string {
  const episode = itemId.match(/-ep(\d{2})-/iu)?.[1];
  const unit = itemId.match(/(?:15s|unit)[-_]?(\d{3,4})/iu)?.[1] ?? itemId.match(/-(\d{3,4})$/u)?.[1];
  return episode && unit ? `EP${episode} · ${unit}` : itemId;
}
function assetNames(resolution: PanelReferenceResolution): string {
  const names = resolution.semanticAssets.map((asset) => asset.assetId);
  return names.length ? `${names.slice(0, 3).join("、")}${names.length > 3 ? ` +${names.length - 3}` : ""}` : "确认无引用";
}
function blockerLabel(resolution: PanelReferenceResolution): string {
  if (resolution.closureStatus === "unresolved") return "闭包阻断";
  if (resolution.blockerCodes.includes("pending-derived-artifact")) return "待组合图";
  if (resolution.blockerCodes.includes("pending-hard-lock")) return "待硬锁";
  if (resolution.blockerCodes.includes("stale-derived-artifact")) return "组合图已漂移";
  return "暂不可生成";
}
function closureLabel(status: PanelReferenceResolution["closureStatus"]): string {
  return ({ resolved: "引用已解析", "confirmed-empty": "确认无引用", unresolved: "引用未闭包" })[status];
}
function provenanceLabel(kind: PanelReferenceProvenanceKind): string {
  return ({ "storyboard-row": "分镜行", "source-shot-schedule": "原镜排期", "continuity-span": "连续性时间段", "panel-continuity-reference": "宫格显式连续性参考", "manual-include": "人工补入" })[kind];
}
function readinessLabel(readiness: PanelReferenceResolution["referenceSlots"][number]["readiness"]): string {
  return ({ ready: "就绪", "pending-hard-lock": "待硬锁", "pending-derived-artifact": "待视觉组合图", stale: "已漂移" })[readiness];
}
function reconciliationLabel(difference: PanelReferenceResolution["timelineReconciliations"][number]["difference"]): string {
  return ({ "storyboard-only": "仅分镜行", "continuity-only": "仅连续性时间段", "panel-continuity-only": "仅宫格显式连续性参考", "parser-artifact": "解析器伪命中" })[difference];
}
function exclusionSourceLabel(source: PanelReferenceResolution["excludedAssets"][number]["source"]): string {
  return ({ "manual-override": "人工覆盖", "parser-reconciliation": "解析器调和" })[source];
}
function derivedStatusLabel(status: DerivedPanelReferenceAsset["status"]): string {
  return ({ "definition-approved": "定义已审", "visual-ready": "视觉就绪", stale: "已漂移" })[status];
}
function presenceLabel(presence: PanelVisualConstraint["assetPresence"][number]["presence"]): string {
  return ({ "on-screen": "强制出镜", "continuity-only": "仅连续性参考", "optional-offscreen": "可选画外" })[presence];
}
function hiddenMaskLabel(status: PanelVisualConstraint["hiddenMaskPolicy"]["status"]): string {
  return ({ "not-applicable": "隐藏面具政策：不适用", concealed: "隐藏面具政策：严格隐藏", "reveal-authorized": "隐藏面具政策：当前格已授权" })[status];
}
function spatialFieldLabel(field: PanelVisualSpatialField): string {
  return ({ shotSize: "景别", cameraMovement: "镜头运动", cameraAngle: "机位角度", lens: "镜头/焦段", composition: "构图", staging: "调度", eyeline: "视线", screenDirection: "画面方向", axisSide: "轴线侧" })[field];
}
function continuitySummary(lock: PanelVisualContinuityLock): string {
  const parts = [
    lock.costumeValues.length ? `服装：${lock.costumeValues.join("、")}` : "",
    lock.stateValues.length ? `状态：${lock.stateValues.join("、")}` : "",
    lock.referenceVersions.length ? `参考：${lock.referenceVersions.join("、")}` : "",
    lock.reason ?? "",
  ].filter(Boolean);
  return parts.join("；") || "无来源值";
}
function enforcementLabel(value: PanelVisualConstraint["reviewRules"][number]["enforcement"]): string {
  return value === "human-visual-final" ? "仅人工终审" : "输入预筛 + 人工终审";
}
function detectionLabel(value: PanelVisualConstraint["warnings"][number]["detection"]): string {
  return value === "human-visual" ? "人工视觉" : "结构化输入预筛 + 人工视觉";
}
</script>

<style scoped>
.reference-workbench { height: 100%; min-width: 0; display: flex; flex-direction: column; overflow: hidden; background: #111310; color: #e9ebe5; }
.workbench-header { min-height: 86px; display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 18px 24px 16px; border-bottom: 1px solid #30332d; background: #161815; }
.kicker { color: #70b8b0; font: 700 9px/1 Inter, sans-serif; letter-spacing: .14em; }
.workbench-header h2 { margin: 6px 0 3px; font-size: 20px; line-height: 1.1; }
.workbench-header p { margin: 0; color: #858a82; font-size: 11px; }
.header-actions { display: flex; align-items: center; gap: 12px; }
.header-actions button, .pager button { min-height: 34px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; border: 1px solid #343a34; background: #1b1e1a; color: #d8dbd4; padding: 0 12px; cursor: pointer; }
.header-actions button:hover, .pager button:hover:not(:disabled) { border-color: #51736d; color: #91d0c8; }
.header-actions button:disabled, .pager button:disabled { opacity: .38; cursor: default; }
.store-mark { color: #737970; font: 10px/1.4 "SFMono-Regular", Menlo, monospace; }
.store-mark.current { color: #79bdb5; }
.spinning { animation: spin .85s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.audit-strip { min-height: 114px; display: grid; grid-template-columns: minmax(230px, .85fr) minmax(390px, 1.25fr) minmax(470px, 1.7fr); border-bottom: 1px solid #30332d; background: #151714; }
.audit-strip > * { padding: 17px 22px; }
.audit-strip > * + * { border-left: 1px solid #30332d; }
.audit-verdict { box-shadow: inset 3px 0 #c36e5c; }
.audit-strip.passed .audit-verdict { box-shadow: inset 3px 0 #70b8b0; }
.audit-verdict > span { color: #d38776; font-size: 10px; font-weight: 700; }
.audit-strip.passed .audit-verdict > span { color: #82c9c0; }
.audit-verdict strong { display: block; margin-top: 8px; font-size: 22px; }
.audit-verdict strong small { color: #8b9088; font-size: 10px; font-weight: 500; }
.audit-verdict p { margin: 7px 0 0; color: #666c64; font: 9px/1.4 "SFMono-Regular", Menlo, monospace; }
.production-counts, .closure-errors { margin: 0; display: grid; align-items: center; }
.production-counts { grid-template-columns: repeat(3, 1fr); }
.production-counts div + div { border-left: 1px solid #2a2d28; padding-left: 19px; }
.production-counts dt, .closure-errors dt { color: #898f86; font-size: 10px; }
.production-counts dd { margin: 7px 0 0; font-size: 24px; font-weight: 650; }
.production-counts small { color: #666c64; font-size: 9px; }
.closure-errors { grid-template-columns: repeat(4, minmax(90px, 1fr)); gap: 1px; background: #292c27; padding: 0 !important; }
.closure-errors div { height: 100%; display: flex; flex-direction: column; justify-content: center; padding: 14px 15px; background: #181a17; }
.closure-errors dd { margin: 8px 0 0; color: #db8e7c; font-size: 20px; font-weight: 650; }
.closure-errors div.clear dd { color: #78beb5; }
.filter-bar { min-height: 55px; display: flex; align-items: center; gap: 12px; padding: 9px 18px; border-bottom: 1px solid #30332d; background: #141613; }
.filter-bar label { display: flex; align-items: center; gap: 7px; color: #7f857c; font-size: 9px; }
.filter-bar select { height: 32px; min-width: 112px; padding: 0 26px 0 9px; border: 1px solid #323630; outline: 0; background: #1c1f1b; color: #daddd6; font-size: 10px; }
.check-filter { min-height: 32px; padding: 0 8px; border-left: 1px solid #30332d; }
.check-filter input { accent-color: #70b8b0; }
.result-count { margin-left: auto; color: #747a72; font-size: 10px; }
.workbench-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(720px, 1fr) 390px; }
.resolution-list { min-width: 0; display: flex; flex-direction: column; border-right: 1px solid #30332d; }
.list-head, .resolution-row { display: grid; grid-template-columns: minmax(170px, 1.35fr) 82px minmax(150px, 1fr) 110px 135px; align-items: center; gap: 10px; }
.list-head { min-height: 32px; padding: 0 14px; border-bottom: 1px solid #2b2e29; color: #656b63; font-size: 8px; letter-spacing: .06em; }
.resolution-row { width: 100%; min-height: 61px; padding: 8px 14px; border: 0; border-bottom: 1px solid #272a26; background: transparent; color: #d8dbd4; text-align: left; cursor: pointer; transition: background .14s ease, box-shadow .14s ease; content-visibility: auto; contain-intrinsic-size: auto 61px; }
.resolution-row:hover { background: #191c18; }
.resolution-row.selected { background: #1a211d; box-shadow: inset 3px 0 #70b8b0; }
.resolution-row span { min-width: 0; }
.resolution-row b, .resolution-row small { display: block; }
.resolution-row b { overflow: hidden; color: #d8dbd4; font-size: 10px; font-weight: 620; text-overflow: ellipsis; white-space: nowrap; }
.resolution-row small { margin-top: 4px; overflow: hidden; color: #676d65; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
.time-cell { color: #9fa49c; font: 10px/1.4 "SFMono-Regular", Menlo, monospace; }
.gate-cell { position: relative; padding-left: 14px; }
.gate-cell i { position: absolute; left: 0; top: 3px; width: 6px; height: 6px; border-radius: 50%; background: #ca7664; box-shadow: 0 0 0 3px rgba(202,118,100,.1); }
.gate-cell.ready i { background: #70b8b0; box-shadow: 0 0 0 3px rgba(112,184,176,.1); }
.gate-cell.ready b { color: #86c9c1; }
.list-loading, .no-results { flex: 1; display: grid; place-content: center; justify-items: center; color: #747a72; font-size: 10px; }
.list-loading span, .loader, .detail-loading span { width: 23px; height: 23px; margin-bottom: 9px; border: 2px solid #343832; border-top-color: #70b8b0; border-radius: 50%; animation: spin .85s linear infinite; }
.pager { min-height: 44px; display: flex; align-items: center; justify-content: center; gap: 14px; margin-top: auto; border-top: 1px solid #30332d; background: #151714; }
.pager button { min-height: 28px; padding: 0 9px; font-size: 9px; }
.pager span { color: #71776e; font-size: 9px; }
.evidence-pane { min-width: 0; overflow-y: auto; background: #171916; }
.evidence-header, .identity-block, .evidence-section, .derived-section { padding: 17px 18px; border-bottom: 1px solid #2d302b; }
.evidence-header h3 { margin: 7px 0 4px; font-size: 15px; }
.evidence-header p { margin: 0; color: #777d74; font-size: 9px; }
.identity-block { display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 6px 9px; }
.identity-block label { color: #686e66; font-size: 8px; }
.identity-block code { overflow: hidden; color: #a5aaa2; font: 8px/1.4 "SFMono-Regular", Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
.evidence-section > header, .derived-section > header, .asset-evidence > div, .slot-evidence > div, .excluded-evidence > div, .derived-card > div { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.evidence-section h4, .derived-section h4 { margin: 0; color: #afb4ac; font-size: 10px; }
.evidence-section > header > span, .derived-section > header > strong { color: #70b8b0; font-size: 10px; }
.asset-evidence, .slot-evidence, .reconciliation, .excluded-evidence { padding: 10px 0; border-bottom: 1px solid #252824; }
.asset-evidence:last-child, .slot-evidence:last-child, .reconciliation:last-child, .excluded-evidence:last-child { border-bottom: 0; }
.asset-evidence b, .slot-evidence b, .reconciliation b, .excluded-evidence b, .derived-card b { color: #cfd2cb; font-size: 9px; font-weight: 620; }
.asset-evidence em, .slot-evidence em, .excluded-evidence em, .derived-card em { flex: 0 0 auto; color: #7f857c; font-size: 8px; font-style: normal; }
.asset-evidence p, .slot-evidence p, .reconciliation p, .excluded-evidence p, .derived-card p { margin: 5px 0 0; color: #777d75; font-size: 8px; line-height: 1.5; }
.asset-evidence small, .slot-evidence small, .excluded-evidence small, .derived-card small { display: block; margin-top: 5px; color: #626860; font: 8px/1.4 "SFMono-Regular", Menlo, monospace; }
.issue-evidence { display: flex; align-items: flex-start; gap: 7px; padding: 9px 0; border-bottom: 1px solid #252824; color: #d47d6b; }
.issue-evidence p { margin: 0; color: #b87c70; font-size: 8px; line-height: 1.55; }
.visual-constraint-section { background: #141815; }
.visual-constraint-loading { min-height: 80px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; color: #747a72; font-size: 8px; }
.visual-constraint-loading span { width: 18px; height: 18px; border: 2px solid #343832; border-top-color: #70b8b0; border-radius: 50%; animation: spin .85s linear infinite; }
.visual-constraint-unavailable { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; padding: 10px; border: 1px solid #4d332e; background: #241915; color: #d47d6b; }
.visual-constraint-unavailable b, .visual-constraint-unavailable small { display: block; }
.visual-constraint-unavailable b { color: #dca092; font-size: 9px; }
.visual-constraint-unavailable p { margin: 5px 0; color: #b87c70; font-size: 8px; line-height: 1.5; overflow-wrap: anywhere; }
.visual-constraint-unavailable small { color: #75615c; font-size: 7px; line-height: 1.5; }
.visual-constraint-verdict { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; padding: 10px; border-left: 2px solid #c36e5c; background: #1e1916; }
.visual-constraint-verdict.ready { border-left-color: #70b8b0; background: #17201c; }
.visual-constraint-verdict b, .visual-constraint-verdict small { display: block; }
.visual-constraint-verdict b { color: #d5d8d1; font-size: 9px; }
.visual-constraint-verdict small { margin-top: 4px; color: #6b7169; font: 7px/1.4 "SFMono-Regular", Menlo, monospace; }
.visual-constraint-verdict em { color: #d2a06f; font-size: 7px; font-style: normal; text-align: right; }
.visual-constraint-identity { margin: 10px 0 0; }
.visual-constraint-identity div { padding: 7px 0; border-top: 1px solid #252a25; }
.visual-constraint-identity dt { color: #676d65; font-size: 7px; }
.visual-constraint-identity dd { margin: 4px 0 0; overflow-wrap: anywhere; color: #9da39b; font: 7px/1.45 "SFMono-Regular", Menlo, monospace; }
.unresolved-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; margin: 10px 0; background: #30332d; }
.unresolved-summary span { padding: 8px 6px; background: #1a1d19; color: #777d75; font-size: 7px; text-align: center; }
.unresolved-summary b { display: block; margin-top: 4px; color: #d69a6d; font-size: 12px; }
.constraint-group { margin-top: 14px; padding-top: 12px; border-top: 1px solid #30342e; }
.constraint-group > header, .constraint-group article > div { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.constraint-group > header > b { color: #b8bdb5; font-size: 9px; }
.constraint-group > header > span { color: #70b8b0; font-size: 8px; }
.constraint-group article { padding: 9px 0; border-bottom: 1px solid #252a25; }
.constraint-group article.unresolved { box-shadow: inset 2px 0 #c6785e; padding-left: 8px; }
.constraint-group article b { color: #c9cdc5; font-size: 8px; }
.constraint-group article em { color: #798078; font-size: 7px; font-style: normal; text-align: right; }
.constraint-group article.unresolved em { color: #dc8a73; }
.constraint-group article p, .separation-note { margin: 5px 0 0; color: #7b8179; font-size: 8px; line-height: 1.55; }
.constraint-group article small { display: block; margin-top: 5px; color: #626860; font: 7px/1.4 "SFMono-Regular", Menlo, monospace; }
.model-payload label { display: block; margin-top: 10px; color: #81877f; font-size: 7px; }
.model-payload pre { max-height: 190px; margin: 5px 0 0; padding: 9px; overflow: auto; border: 1px solid #2c312b; background: #0e110e; color: #adb3aa; font: 7px/1.6 "SFMono-Regular", Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.review-rules { border-top-color: #50655e; }
.review-rules .separation-note { padding: 8px; border-left: 2px solid #70b8b0; background: #17201c; color: #91a39b; }
.warnings article em { color: #d19a6b; }
.warning-copy, .pending-hard-lock, .pending-derived-artifact, .definition-approved { color: #d49b66 !important; }
.ready, .visual-ready { color: #70b8b0 !important; }
.stale { color: #d47d6b !important; }
.muted-copy { margin: 10px 0 0; color: #656b63; font-size: 9px; }
.derived-section { background: #151714; }
.derived-section > header h4 { margin-top: 5px; }
.derived-card { width: 100%; display: block; padding: 10px 0; overflow: hidden; border: 0; border-bottom: 1px solid #252824; background: transparent; color: inherit; text-align: left; cursor: pointer; content-visibility: auto; contain-intrinsic-size: auto 56px; }
.derived-card:hover, .derived-card.selected { background: #1a1f1b; box-shadow: inset 2px 0 #70b8b0; }
.derived-card .artifact-path, .derived-card .artifact-sha { overflow-wrap: anywhere; white-space: normal; }
.derived-pager { min-height: 38px; margin: 8px -18px -17px; }
.derived-detail { margin: 17px -18px -17px; padding: 15px 18px; border-top: 1px solid #30332d; background: #111310; }
.derived-detail header { position: relative; padding-right: 74px; }
.derived-detail header h4 { margin-top: 6px; font-size: 11px; }
.derived-detail header em { position: absolute; right: 0; top: 0; font-size: 8px; font-style: normal; }
.derived-detail dl { margin: 12px 0 0; }
.derived-detail dl div { padding: 8px 0; border-top: 1px solid #252824; }
.derived-detail dt { color: #686e66; font-size: 8px; }
.derived-detail dd { margin: 5px 0 0; overflow-wrap: anywhere; color: #a5aaa2; font: 8px/1.55 "SFMono-Regular", Menlo, monospace; }
.detail-placeholder { min-height: 190px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; border-bottom: 1px solid #2d302b; color: #626860; font-size: 9px; }
.detail-loading { min-height: 190px; display: grid; place-items: center; border-bottom: 1px solid #2d302b; }
.empty-state { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #858b82; }
.empty-state strong { margin-top: 13px; color: #bdc1ba; font-size: 13px; }
.empty-state p { max-width: 620px; margin: 8px 24px 0; color: #a8796e; font-size: 10px; line-height: 1.6; text-align: center; }
.empty-state small { margin-top: 7px; color: #626860; font-size: 9px; }
@media (max-width: 1450px) {
  .audit-strip { grid-template-columns: 220px minmax(330px, 1fr) minmax(400px, 1.35fr); }
  .workbench-body { grid-template-columns: minmax(650px, 1fr) 340px; }
  .list-head, .resolution-row { grid-template-columns: minmax(150px, 1.2fr) 72px minmax(125px, 1fr) 96px 118px; gap: 8px; }
}
</style>
