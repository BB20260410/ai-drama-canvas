<template>
  <section class="review-studio">
    <header class="review-header">
      <div><span class="eyebrow">导演验收</span><h2>版本对照与视觉结论</h2><p>机械检查是门禁，视觉结论必须逐项确认并保留历史。</p></div>
      <div class="review-metrics"><div><span>待验收</span><b>{{ pendingCount }}</b></div><div><span>当前历史</span><b>{{ history.length }}</b></div><button class="ghost-button" type="button" :disabled="loading" @click="load"><RefreshCw :size="14" /> 刷新</button></div>
    </header>

    <div class="review-body">
      <aside class="review-queue">
        <div class="queue-filter"><select v-model="episode"><option value="all">全部分集</option><option v-for="value in episodes" :key="value" :value="String(value)">EP{{ pad(value) }}</option></select><label><input v-model="includeResolved" type="checkbox" /> 显示已处理</label></div>
        <div class="queue-list">
          <button v-for="entry in queue" :key="entry.item.id" type="button" :class="{ active: entry.item.id === activeId }" :data-item-id="entry.item.id" @click="select(entry.item.id)">
            <figure><img v-if="entry.item.thumbnailPath" :src="assetUrl(entry.item.thumbnailPath)" /><span v-else><ScanEye :size="17" /></span></figure>
            <div><span>EP{{ pad(entry.item.episode) }} · {{ entry.item.type === 'shot' ? `镜${entry.item.shot}` : `15s ${pad(entry.item.unit,3)}` }}</span><b>{{ entry.item.title }}</b><small>{{ entry.reviewType === 'video' ? '视频验收' : '画面验收' }} · {{ entry.item.status }}</small></div>
            <i :class="decisionClass(entry.latestReview?.decision)"></i>
          </button>
        </div>
        <footer>{{ queue.length }} 个验收节点</footer>
      </aside>

      <main class="review-stage">
        <div v-if="loading" class="review-empty"><RefreshCw class="spinning" :size="24" /><span>正在读取真实版本…</span></div>
        <div v-else-if="!active" class="review-empty"><ScanEye :size="30" /><span>当前筛选下没有待验收节点</span></div>
        <template v-else>
          <header class="review-item-heading"><div><span>{{ active.reviewType === 'video' ? '视频验收' : active.item.type === 'shot' ? '原镜头验收' : active.reviewRequirement ? `${active.reviewRequirement.panelCount} 格逐格验收` : '首尾帧验收' }}</span><h3>{{ active.item.title }}</h3><p>{{ active.item.nextAction }}</p></div><b :class="statusClass(active.item.status)">{{ active.item.status }}</b></header>
          <div v-if="active.reviewType === 'image' && active.item.type === 'unit'" class="frame-tabs">
            <template v-if="active.reviewRequirement">
              <button v-for="panel in active.reviewRequirement.panels" :key="panel.panelId" type="button" :class="{ active: focusedPanelId === panel.panelId, viewed: viewedPanelIds.has(panel.panelId) }" :data-panel-id="panel.panelId" @click="choosePanel(panel.panelId)"><span></span>宫格{{ pad(panel.panelIndex) }}</button>
              <em>{{ active.reviewRequirement.complete ? `视觉通过前必须查看全部 ${active.reviewRequirement.panelCount} 格` : active.reviewRequirement.issues.join('；') }}</em>
            </template>
            <template v-else>
              <button type="button" :class="{ active: focusedVariant === 'start', viewed: viewedVariants.has('start') }" @click="chooseVariant('start')"><span></span>首帧</button><button type="button" :class="{ active: focusedVariant === 'end', viewed: viewedVariants.has('end') }" @click="chooseVariant('end')"><span></span>尾帧</button><em>视觉通过前必须查看首帧与尾帧</em>
            </template>
          </div>
          <div class="compare-toolbar">
            <label><span>A</span><select v-model="artifactAId"><option v-for="artifact in mediaArtifacts" :key="artifact.id" :value="artifact.id">{{ artifactLabel(artifact) }}</option></select></label>
            <button type="button" @click="swap"><ArrowLeftRight :size="14" /> 交换</button>
            <label><span>B</span><select v-model="artifactBId"><option value="">不对照</option><option v-for="artifact in mediaArtifacts" :key="artifact.id" :value="artifact.id">{{ artifactLabel(artifact) }}</option></select></label>
          </div>
          <section class="compare-stage" :class="{ single: !artifactB }">
            <article v-for="(artifact, index) in displayedArtifacts" :key="artifact.id" class="media-pane">
              <header><span>{{ index === 0 ? 'A' : 'B' }}</span><b>{{ artifact.authoritative ? '当前权威' : artifact.versionLabel }}</b><em :class="{ ok: artifact.check.ok }">{{ artifact.check.ok ? '机械通过' : '机械异常' }}</em></header>
              <div class="media-frame">
                <div class="media-canvas" :style="mediaCanvasStyle(artifact)">
                  <video v-if="artifact.kind === 'video'" :ref="(element) => setReviewVideoElement(artifact.id, element)" controls preload="metadata" :src="reviewAssetUrl(artifact)" @play="annotationMode = false"></video>
                  <img v-else :src="reviewAssetUrl(artifact)" />
                  <button v-for="marker in annotationMarkers(artifact.id)" :key="marker.markerId" type="button" :class="['annotation-pin', `annotation-${marker.type}`, { draft: marker.draft }]" :style="{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }" :title="`${annotationTypeLabels[marker.type]}${marker.timeSeconds === undefined ? '' : ` · ${annotationTime(marker.timeSeconds)}`}：${marker.text || '待填写'}`" @click.stop="focusAnnotation(marker.markerId, marker.draft)">{{ marker.label }}</button>
                  <button v-if="annotationMode" type="button" class="annotation-capture" title="在画面上点击放置批注" @click.stop="placeAnnotation($event, artifact)"><MapPin :size="20" /><span>点击画面定位批注</span></button>
                </div>
              </div>
              <footer><div><span>{{ artifact.kind }} · {{ artifact.variant }}</span><small>{{ mediaFacts(artifact) }}</small><p>{{ artifact.path }}</p></div><div><button type="button" @click="reveal(artifact.path)"><FolderOpen :size="13" /> 文件</button><button v-if="!artifact.authoritative && !artifact.deprecated && artifact.check.ok" type="button" @click="setAuthority(artifact)"><Crown :size="13" /> 设为权威</button></div></footer>
            </article>
          </section>
        </template>
      </main>

      <aside class="review-inspector">
        <template v-if="active">
          <header><span class="eyebrow">逐项检查</span><b>{{ completedCriteria }}/{{ criteria.length }}</b></header>
          <div class="criteria-list">
            <article v-for="criterion in criteria" :key="criterion.key" :class="`criterion-${criterion.result || 'empty'}`">
              <div><b>{{ criterionLabels[criterion.key] }}</b><span>{{ criterionHints[criterion.key] }}</span></div>
              <div class="criterion-actions"><button type="button" :class="{ active: criterion.result === 'pass' }" @click="criterion.result = 'pass'"><Check :size="12" /></button><button type="button" :class="{ active: criterion.result === 'fail' }" @click="criterion.result = 'fail'"><X :size="12" /></button><button type="button" :class="{ active: criterion.result === 'na' }" @click="criterion.result = 'na'">N/A</button></div>
              <input v-if="criterion.result === 'fail'" v-model="criterion.note" placeholder="失败原因" />
            </article>
          </div>
          <section v-if="requiresVisualConstraintReview" class="visual-rule-review" data-testid="visual-constraint-review">
            <header>
              <div><span>P3 宫格人工视觉终审</span><small>{{ focusedPanelLabel }}</small></div>
              <b>{{ passedVisualRuleCount }}/{{ visualRuleDrafts.length }}</b>
            </header>
            <p class="visual-rule-disclaimer">结构化预筛不等于视觉验收。系统不宣称自动识别同脸、犬纹、OCR、水印或现代物；必须由人工逐格、逐条判定。</p>
            <article v-for="draft in focusedVisualRuleDrafts" :key="`${draft.panelId}:${draft.ruleId}`" :class="[`visual-rule-${draft.result || 'empty'}`]" :data-rule-id="draft.ruleId">
              <div class="visual-rule-title"><b>{{ draft.code }}</b><em>{{ visualRuleEnforcementLabel(draft.enforcement) }}</em></div>
              <p>{{ draft.instruction }}</p>
              <small v-if="draft.evidenceAssetIds.length">核对资产：{{ draft.evidenceAssetIds.join("、") }}</small>
              <small v-if="draft.warning" class="visual-warning-copy">{{ visualWarningDetectionLabel(draft.warning.detection) }} · {{ draft.warning.message }}</small>
              <div class="visual-rule-actions">
                <button type="button" :class="{ active: draft.result === 'pass' }" @click="draft.result = 'pass'; draft.note = ''"><Check :size="12" /> 已人工核验通过</button>
                <button type="button" :class="{ active: draft.result === 'fail' }" @click="draft.result = 'fail'"><X :size="12" /> 发现问题</button>
              </div>
              <textarea v-if="draft.result === 'fail'" v-model="draft.note" rows="2" maxlength="2000" placeholder="必填：说明这条规则的可见问题"></textarea>
            </article>
            <div v-if="!focusedVisualRuleDrafts.length" class="visual-rule-missing">当前宫格缺少已冻结的人工 Review 规则，不能视觉通过。</div>
            <footer>通过前还需 <b>{{ remainingVisualRuleCount }}</b> 条人工确认；切换上方宫格标签继续检查。</footer>
          </section>
          <section class="annotation-editor">
            <header><div><span>画面批注</span><b>{{ annotations.length }}</b></div><button type="button" :class="{ active: annotationMode }" :disabled="!artifactA" @click="annotationMode = !annotationMode"><MapPin :size="13" /> {{ annotationMode ? '点击画面落点' : '添加批注' }}</button></header>
            <p>坐标绑定具体素材版本；视频落点同时记录当前时间码。</p>
            <article v-for="(annotation, index) in annotations" :key="annotation.localId" :data-annotation-id="annotation.localId" tabindex="-1" :class="{ invalid: !annotation.text.trim() }">
              <i :class="`annotation-${annotation.type}`">{{ index + 1 }}</i>
              <div><span>{{ artifactName(annotation.artifactId) }}<em v-if="annotation.timeSeconds !== undefined">{{ annotationTime(annotation.timeSeconds) }}</em></span><small>X {{ annotation.x.toFixed(3) }} · Y {{ annotation.y.toFixed(3) }}</small><select v-model="annotation.type"><option v-for="type in annotationTypes" :key="type" :value="type">{{ annotationTypeLabels[type] }}</option></select><textarea v-model="annotation.text" rows="2" maxlength="2000" placeholder="描述问题、保留项或连续性要求"></textarea></div>
              <button type="button" title="移除批注" @click="removeAnnotation(annotation.localId)"><Trash2 :size="12" /></button>
            </article>
            <div v-if="!annotations.length" class="annotation-empty">暂停视频或选中图片后，点击“添加批注”并在画面落点。</div>
          </section>
          <label class="review-note"><span>总评 / 返工要求</span><textarea v-model="note" rows="4" placeholder="明确指出需要保留和需要修改的内容"></textarea></label>
          <div class="decision-actions"><button type="button" :disabled="submitting || !annotationsValid" @click="submit('pending')">待定</button><button type="button" class="rework" :disabled="submitting || !canRework" @click="submit('rework')">判定返工</button><button type="button" class="pass" :disabled="submitting || !canPass" @click="submit('pass')"><CheckCircle2 :size="14" /> 视觉通过</button></div>
          <section class="review-history"><div><span>验收历史</span><b>{{ history.length }}</b></div><article v-for="record in history" :key="record.id"><i :class="decisionClass(record.decision)"></i><div><b>{{ decisionLabel(record.decision) }} · {{ record.resultingStatus }}</b><span>{{ formatTime(record.createdAt) }} · {{ record.reviewer }}</span><p v-if="record.note">{{ record.note }}</p><ul v-if="record.visualConstraintAttestations?.length"><li v-for="attestation in record.visualConstraintAttestations" :key="`${attestation.panelId}:${attestation.ruleId}`"><b>{{ attestation.result === "pass" ? "P3 人工核验通过" : "P3 人工核验失败" }}</b><span>{{ attestation.panelId }} · {{ attestation.ruleId }}</span><p v-if="attestation.note">{{ attestation.note }}</p></li></ul><ul v-if="record.annotations?.length"><li v-for="annotation in record.annotations" :key="annotation.id"><b>{{ annotationTypeLabels[annotation.type] }}</b><span>{{ artifactName(annotation.artifactId) }}<template v-if="annotation.timeSeconds !== undefined"> · {{ annotationTime(annotation.timeSeconds) }}</template></span><p>{{ annotation.text }}</p></li></ul></div></article><p v-if="!history.length" class="no-history">尚无视觉验收记录</p></section>
        </template>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowLeftRight, Check, CheckCircle2, Crown, FolderOpen, MapPin, RefreshCw, ScanEye, Trash2, X } from "lucide-vue-next";
import type { Artifact, FusionVisualReviewRuleAttestation, FusionVisualReviewRuleSnapshot, FusionVisualWarningSnapshot, ProjectIndex, ReviewAnnotation, ReviewAnnotationInput, ReviewAnnotationType, ReviewCriterionKey, ReviewDecision, ReviewQueueEntry, ReviewRecord, ReviewResult } from "@core/types";
import { assetUrl, formatBytes, statusClass } from "../utils";

const props = defineProps<{ projectRoot: string; index: ProjectIndex }>();
const emit = defineEmits<{ updated: [message: string]; failed: [message: string] }>();
const queue = ref<ReviewQueueEntry[]>([]);
const history = ref<ReviewRecord[]>([]);
const activeId = ref("");
const episode = ref("all");
const includeResolved = ref(false);
const artifactAId = ref("");
const artifactBId = ref("");
const note = ref("");
type AnnotationDraft = ReviewAnnotationInput & { localId: string };
type AnnotationMarker = ReviewAnnotation & { markerId: string; draft: false; label: string } | AnnotationDraft & { markerId: string; draft: true; label: string; createdBy: "user"; createdAt: string; id: string };
const annotations = ref<AnnotationDraft[]>([]);
const annotationMode = ref(false);
const reviewVideoElements = new Map<string, HTMLVideoElement>();
const loading = ref(true);
const submitting = ref(false);
let loadRevision = 0;
const focusedVariant = ref<"start" | "end" | "generic" | "video">("start");
const focusedPanelId = ref("");
const viewedVariants = ref(new Set<string>());
const viewedPanelIds = ref(new Set<string>());
type CriterionDraft = { key: ReviewCriterionKey; result: ReviewResult | ""; note: string };
const criteria = ref<CriterionDraft[]>([]);
type VisualRuleDraft = Omit<FusionVisualReviewRuleAttestation, "result" | "note"> & FusionVisualReviewRuleSnapshot & {
  panelIndex: number;
  result: "pass" | "fail" | "";
  note: string;
  warning?: FusionVisualWarningSnapshot;
};
const visualRuleDrafts = ref<VisualRuleDraft[]>([]);
const annotationTypes: ReviewAnnotationType[] = ["issue", "keep", "question", "continuity"];
const annotationTypeLabels: Record<ReviewAnnotationType, string> = { issue: "问题", keep: "保留", question: "疑问", continuity: "连续性" };

const criterionLabels: Record<ReviewCriterionKey, string> = { character_identity: "角色身份", hard_lock: "硬锁设定", prop_costume: "道具与服装", scene_continuity: "场景连续性", composition: "构图与机位", image_quality: "画面质量", raw_labeled_pair: "raw/labeled 配对", motion_continuity: "动作连续性", duration_audio: "时长与声音" };
const criterionHints: Record<ReviewCriterionKey, string> = { character_identity: "脸型、年龄、体态一致", hard_lock: "面具与权威参考不变", prop_costume: "服装、器物、佩戴关系", scene_continuity: "光线、空间、天气衔接", composition: "景别、视线、主体关系", image_quality: "解剖、文字、水印、伪影", raw_labeled_pair: "同版本、同画面、可定位", motion_continuity: "起止动作、速度、方向", duration_audio: "时长、节奏、对白与环境声" };
const imageKeys: ReviewCriterionKey[] = ["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"];
const videoKeys: ReviewCriterionKey[] = ["character_identity", "hard_lock", "prop_costume", "scene_continuity", "motion_continuity", "duration_audio", "image_quality"];

const active = computed(() => queue.value.find((entry) => entry.item.id === activeId.value) ?? null);
const episodes = computed(() => [...new Set(props.index.items.map((item) => item.episode).filter((value): value is number => Boolean(value)))].sort((a,b)=>a-b));
const mediaArtifacts = computed(() => (active.value?.artifacts ?? []).filter((artifact) => !artifact.deprecated && (active.value?.reviewType === "video" ? artifact.kind === "video" : ["raw-image","labeled-image"].includes(artifact.kind))).sort((a,b)=>Number(b.authoritative)-Number(a.authoritative) || b.modifiedAt.localeCompare(a.modifiedAt)));
const artifactA = computed(() => mediaArtifacts.value.find((artifact) => artifact.id === artifactAId.value));
const artifactB = computed(() => mediaArtifacts.value.find((artifact) => artifact.id === artifactBId.value));
const displayedArtifacts = computed(() => [artifactA.value, artifactB.value].filter((artifact): artifact is Artifact => Boolean(artifact)));
const completedCriteria = computed(() => criteria.value.filter((criterion) => criterion.result).length);
const variantsViewed = computed(() => {
  if (!active.value || active.value.reviewType === "video" || active.value.item.type === "shot") return true;
  if (active.value.reviewRequirement) return active.value.reviewRequirement.panels.every((panel) => viewedPanelIds.value.has(panel.panelId));
  return ["start","end"].every((variant) => viewedVariants.value.has(variant));
});
const annotationsValid = computed(() => annotations.value.every((annotation) => Boolean(annotation.text.trim())));
const hasBlockingAnnotation = computed(() => annotations.value.some((annotation) => ["issue", "question"].includes(annotation.type)));
const requiresVisualConstraintReview = computed(() => Boolean(active.value?.reviewRequirement?.panels.some((panel) => panel.panelVisualConstraintEvidenceVersion === 1)));
const focusedVisualRuleDrafts = computed(() => visualRuleDrafts.value.filter((draft) => draft.panelId === focusedPanelId.value));
const passedVisualRuleCount = computed(() => visualRuleDrafts.value.filter((draft) => draft.result === "pass").length);
const remainingVisualRuleCount = computed(() => visualRuleDrafts.value.filter((draft) => draft.result !== "pass").length);
const visualRulesValid = computed(() => visualRuleDrafts.value.every((draft) => draft.result !== "fail" || Boolean(draft.note.trim())));
const visualRulesPass = computed(() => !requiresVisualConstraintReview.value || (visualRuleDrafts.value.length > 0
  && active.value?.reviewRequirement?.panels.every((panel) => panel.panelVisualConstraintEvidenceVersion === 1
    && Boolean(panel.panelVisualConstraintId)
    && Boolean(panel.panelVisualReviewRulesFingerprint)
    && Boolean(panel.visualReviewRules?.length))
  && visualRuleDrafts.value.every((draft) => draft.result === "pass")));
const focusedPanelLabel = computed(() => {
  const panel = active.value?.reviewRequirement?.panels.find((entry) => entry.panelId === focusedPanelId.value);
  return panel ? `宫格 ${pad(panel.panelIndex)} / ${pad(panel.panelCount)}` : "未选择宫格";
});
const canPass = computed(() => criteria.value.length > 0 && criteria.value.every((criterion) => criterion.result && criterion.result !== "fail") && Boolean(artifactA.value) && variantsViewed.value && (active.value?.reviewRequirement?.complete ?? true) && annotationsValid.value && !hasBlockingAnnotation.value && visualRulesValid.value && visualRulesPass.value);
const canRework = computed(() => annotationsValid.value && visualRulesValid.value && (criteria.value.some((criterion) => criterion.result === "fail") || Boolean(note.value.trim()) || annotations.value.some((annotation) => annotation.type === "issue") || visualRuleDrafts.value.some((draft) => draft.result === "fail")));
const pendingCount = computed(() => queue.value.filter((entry) => ["待视觉验收","待视频验收","返工"].includes(entry.item.status)).length);

watch([episode, includeResolved], () => void load());
watch(() => props.index.scannedAt, () => void load());
onMounted(() => void load());
onBeforeUnmount(() => reviewVideoElements.clear());

async function load() {
  const revision = ++loadRevision;
  loading.value = true;
  try {
    const nextQueue = await window.canvasApi.getReviewQueue(props.projectRoot, { episode: episode.value === "all" ? undefined : Number(episode.value), includeResolved: includeResolved.value });
    if (revision !== loadRevision) return;
    queue.value = nextQueue;
    if (!queue.value.some((entry) => entry.item.id === activeId.value)) activeId.value = queue.value[0]?.item.id ?? "";
    await resetActive();
  } catch (error) { emit("failed", message(error)); }
  finally { if (revision === loadRevision) loading.value = false; }
}
async function select(id: string) { activeId.value = id; await resetActive(); }
async function resetActive() {
  const entry = active.value;
  const artifacts = entry?.artifacts.filter((artifact) => !artifact.deprecated && (entry.reviewType === "video" ? artifact.kind === "video" : ["raw-image","labeled-image"].includes(artifact.kind))).sort((a,b)=>Number(b.authoritative)-Number(a.authoritative) || b.modifiedAt.localeCompare(a.modifiedAt)) ?? [];
  viewedVariants.value = new Set();
  viewedPanelIds.value = new Set();
  focusedPanelId.value = "";
  if (entry?.reviewType === "video") {
    focusedVariant.value = "video";
    artifactAId.value = artifacts[0]?.id ?? "";
    artifactBId.value = artifacts.find((artifact) => artifact.id !== artifactAId.value)?.id ?? "";
    viewedVariants.value = new Set(["video"]);
  } else if (entry?.item.type === "shot") chooseVariant("generic", artifacts);
  else if (entry?.reviewRequirement?.panels.length) choosePanel(entry.reviewRequirement.panels[0]!.panelId, artifacts);
  else chooseVariant("start", artifacts);
  const keys = entry?.reviewType === "video" ? videoKeys : imageKeys;
  criteria.value = keys.map((key) => ({ key, result: key === "hard_lock" && !entry?.item.hardLockIds.length && !entry?.reviewRequirement ? "na" : "", note: "" }));
  visualRuleDrafts.value = (entry?.reviewRequirement?.panels ?? []).flatMap((panel) => {
    if (panel.panelVisualConstraintEvidenceVersion !== 1 || !panel.panelVisualConstraintId || !panel.panelVisualReviewRulesFingerprint) return [];
    const warnings = new Map((panel.visualWarnings ?? []).map((warning) => [warning.code, warning]));
    return (panel.visualReviewRules ?? []).map((rule): VisualRuleDraft => ({
      ...rule,
      panelId: panel.panelId,
      panelIndex: panel.panelIndex,
      constraintId: panel.panelVisualConstraintId!,
      reviewRulesFingerprint: panel.panelVisualReviewRulesFingerprint!,
      ruleId: rule.id,
      result: "",
      note: "",
      warning: warnings.get(rule.code),
    }));
  });
  note.value = "";
  annotations.value = [];
  annotationMode.value = false;
  history.value = entry ? await window.canvasApi.listReviewRecords(props.projectRoot, { itemId: entry.item.id, limit: 50 }) : [];
}
function chooseVariant(variant: "start" | "end" | "generic", source = mediaArtifacts.value) {
  focusedVariant.value = variant;
  const candidates = source.filter((artifact) => artifact.variant === variant || (variant === "generic" && artifact.variant === "start"));
  const raw = candidates.find((artifact) => artifact.kind === "raw-image" && artifact.authoritative) ?? candidates.find((artifact) => artifact.kind === "raw-image") ?? candidates[0];
  const labeled = candidates.find((artifact) => artifact.kind === "labeled-image" && artifact.authoritative) ?? candidates.find((artifact) => artifact.kind === "labeled-image");
  artifactAId.value = raw?.id ?? "";
  artifactBId.value = labeled?.id ?? candidates.find((artifact) => artifact.id !== raw?.id)?.id ?? "";
  viewedVariants.value = new Set([...viewedVariants.value, variant]);
}
function choosePanel(panelId: string, source = mediaArtifacts.value) {
  focusedPanelId.value = panelId;
  const requirement = active.value?.reviewRequirement;
  const candidates = source.filter((artifact) => artifact.fusionStoryboardPanel?.panelId === panelId
    && (!requirement
      || (artifact.fusionStoryboardPanel.contractId === requirement.contractId
        && artifact.fusionStoryboardPanel.sourceFingerprint === requirement.sourceFingerprint
        && artifact.fusionStoryboardPanel.productionFingerprint === requirement.productionFingerprint)));
  const raw = candidates.find((artifact) => artifact.kind === "raw-image" && artifact.authoritative) ?? candidates.find((artifact) => artifact.kind === "raw-image") ?? candidates[0];
  const labeled = candidates.find((artifact) => artifact.kind === "labeled-image" && artifact.authoritative) ?? candidates.find((artifact) => artifact.kind === "labeled-image");
  artifactAId.value = raw?.id ?? "";
  artifactBId.value = labeled?.id ?? candidates.find((artifact) => artifact.id !== raw?.id)?.id ?? "";
  viewedPanelIds.value = new Set([...viewedPanelIds.value, panelId]);
}
function swap() { const current = artifactAId.value; artifactAId.value = artifactBId.value; artifactBId.value = current; }
async function setAuthority(artifact: Artifact) { if (!active.value) return; try { await window.canvasApi.setAuthoritativeArtifact(props.projectRoot, active.value.item.id, artifact.id, "在导演验收台选择权威版本"); await load(); emit("updated", "权威版本已更新，验收内容快照已刷新"); } catch(error){ emit("failed",message(error)); } }
async function submit(decision: ReviewDecision) {
  if (!active.value || !artifactA.value) return;
  submitting.value = true;
  try {
    const baseArtifactIds = decision === "pass"
      ? active.value.reviewRequirement?.artifactIds ?? mediaArtifacts.value.filter((artifact) => artifact.authoritative).map((artifact) => artifact.id)
      : [...new Set([artifactAId.value, artifactBId.value].filter(Boolean))];
    const artifactIds = [...new Set([...baseArtifactIds, ...annotations.value.map((annotation) => annotation.artifactId)])];
    const expectedArtifactHashes = Object.fromEntries(artifactIds.map((artifactId) => [artifactId, active.value!.reviewSnapshot.artifactHashes[artifactId]]));
    if (Object.values(expectedArtifactHashes).some((sha256) => !/^[a-f0-9]{64}$/.test(sha256 ?? ""))) throw new Error("当前验收素材缺少内容哈希，已停止提交；请刷新队列后重试。");
    const annotationPayload = annotations.value.map(({ localId: _localId, ...annotation }) => annotation);
    const visualConstraintAttestations = visualRuleDrafts.value.filter((draft) => draft.result).map((draft): FusionVisualReviewRuleAttestation => ({ panelId: draft.panelId, constraintId: draft.constraintId, reviewRulesFingerprint: draft.reviewRulesFingerprint, ruleId: draft.ruleId, result: draft.result as "pass" | "fail", note: draft.note.trim() || undefined }));
    const failedVisualRules = visualRuleDrafts.value.filter((draft) => draft.result === "fail");
    const submissionNote = note.value.trim() || (decision === "rework" && failedVisualRules.length
      ? `P3 人工视觉规则未通过：${failedVisualRules.map((draft) => `${draft.panelId}/${draft.code}：${draft.note.trim()}`).join("；")}`
      : undefined);
    const result = await window.canvasApi.submitReview(props.projectRoot, { itemId: active.value.item.id, reviewType: active.value.reviewType, artifactIds, expectedScanId: active.value.reviewSnapshot.scanId, expectedArtifactHashes, expectedRequirementId: active.value.reviewRequirement?.id, visualConstraintAttestations: visualConstraintAttestations.length ? visualConstraintAttestations : undefined, decision, criteria: criteria.value.filter((criterion) => criterion.result).map((criterion) => ({ key: criterion.key, result: criterion.result as ReviewResult, note: criterion.note || undefined })), annotations: annotationPayload, note: submissionNote });
    activeId.value = result.item.id;
    includeResolved.value = true;
    await load();
    emit("updated", `${decisionLabel(decision)}，状态已更新为 ${result.item.status}`);
  } catch(error){ const failure = message(error); if (/快照|内容.*变化|重新读取/.test(failure)) await load(); emit("failed",failure); }
  finally { submitting.value=false; }
}
function reviewAssetUrl(artifact: Artifact) { return `${assetUrl(artifact.path)}&sha256=${encodeURIComponent(artifact.check.sha256 ?? artifact.modifiedAt)}`; }
function mediaCanvasStyle(artifact: Artifact) {
  const width = artifact.check.width ?? 16;
  const height = artifact.check.height ?? 9;
  return { "--media-aspect": String(Math.max(.01, width / Math.max(1, height))) };
}
function setReviewVideoElement(artifactId: string, element: unknown) {
  if (element instanceof HTMLVideoElement) reviewVideoElements.set(artifactId, element);
  else reviewVideoElements.delete(artifactId);
}
function placeAnnotation(event: MouseEvent, artifact: Artifact) {
  if (!annotationMode.value) return;
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
  const videoTime = artifact.kind === "video" ? reviewVideoElements.get(artifact.id)?.currentTime ?? 0 : undefined;
  const duration = artifact.check.duration;
  annotations.value.push({
    localId: `draft-${crypto.randomUUID()}`,
    artifactId: artifact.id,
    type: "issue",
    timeSeconds: videoTime === undefined ? undefined : Math.round(Math.min(videoTime, duration ?? videoTime) * 1_000) / 1_000,
    x: Math.round(x * 1_000_000) / 1_000_000,
    y: Math.round(y * 1_000_000) / 1_000_000,
    text: "",
  });
  annotationMode.value = false;
}
function removeAnnotation(localId: string) { annotations.value = annotations.value.filter((annotation) => annotation.localId !== localId); }
function annotationMarkers(artifactId: string): AnnotationMarker[] {
  const historical = history.value.flatMap((record) => record.annotations ?? []).filter((annotation) => annotation.artifactId === artifactId).map((annotation) => ({ ...annotation, markerId: annotation.id, draft: false as const, label: "·" }));
  const drafts = annotations.value.filter((annotation) => annotation.artifactId === artifactId).map((annotation, index) => ({ ...annotation, id: annotation.localId, markerId: annotation.localId, draft: true as const, label: String(index + 1), createdBy: "user" as const, createdAt: "" }));
  return [...historical, ...drafts];
}
function focusAnnotation(markerId: string, draft: boolean) {
  if (!draft) return;
  document.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(markerId)}"]`)?.focus();
}
function artifactName(artifactId: string) {
  const artifact = active.value?.artifacts.find((entry) => entry.id === artifactId);
  return artifact ? `${artifact.variant} · ${artifact.versionLabel}` : artifactId.slice(0, 12);
}
function annotationTime(seconds: number) { const minutes = Math.floor(seconds / 60); return `${String(minutes).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}.${String(Math.floor((seconds % 1) * 1_000)).padStart(3, "0")}`; }
function artifactLabel(artifact: Artifact) { const panel=artifact.fusionStoryboardPanel; return `${artifact.authoritative ? '权威 · ' : ''}${panel ? `宫格${pad(panel.panelIndex)} · ` : ''}${artifact.variant} · ${artifact.kind} · ${artifact.versionLabel}`; }
function mediaFacts(artifact: Artifact) { const size = `${artifact.check.width ?? 0}×${artifact.check.height ?? 0}`; return `${artifact.check.duration ? `${artifact.check.duration.toFixed(2)}s · ` : ''}${size} · ${formatBytes(artifact.check.size)}`; }
function reveal(path: string) { void window.canvasApi.showInFolder(path); }
function pad(value?: number,length=2){return String(value??0).padStart(length,"0");}
function decisionClass(value?: ReviewDecision){return value ? `decision-${value}` : "decision-none";}
function decisionLabel(value: ReviewDecision){return ({pending:"待定",pass:"视觉通过",rework:"返工"})[value];}
function visualRuleEnforcementLabel(value: FusionVisualReviewRuleSnapshot["enforcement"]){return value === "human-visual-final" ? "仅人工终审" : "结构化输入预筛 + 人工终审";}
function visualWarningDetectionLabel(value: FusionVisualWarningSnapshot["detection"]){return value === "human-visual" ? "人工视觉" : "结构化输入预筛 + 人工视觉";}
function formatTime(value:string){return new Date(value).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});}
function message(error:unknown){return error instanceof Error?error.message:String(error);}
</script>

<style scoped>
.visual-rule-review{padding:12px 15px;border-top:1px solid #43534d;border-bottom:1px solid #30322c;background:#141915}.visual-rule-review>header{display:flex;align-items:center;justify-content:space-between;gap:8px}.visual-rule-review>header span,.visual-rule-review>header small{display:block}.visual-rule-review>header span{color:#9db7ad;font-size:8px;font-weight:700}.visual-rule-review>header small{margin-top:4px;color:#66746d;font:7px Menlo,monospace}.visual-rule-review>header b{color:#79bdb5;font:9px Menlo,monospace}.visual-rule-disclaimer{margin:9px 0 2px;padding:8px;border-left:2px solid #70b8b0;background:#19211d;color:#91a49b;font-size:7px;line-height:1.55}.visual-rule-review>article{padding:10px 0;border-bottom:1px solid #29302b}.visual-rule-review>article.visual-rule-pass{box-shadow:inset 2px 0 #70b8b0;padding-left:7px}.visual-rule-review>article.visual-rule-fail{box-shadow:inset 2px 0 #d36b59;padding-left:7px}.visual-rule-title{display:flex;align-items:flex-start;justify-content:space-between;gap:7px}.visual-rule-title b{color:#c5cbc4;font-size:8px}.visual-rule-title em{max-width:150px;color:#718078;font-size:6px;font-style:normal;text-align:right;line-height:1.4}.visual-rule-review article>p{margin:6px 0 0;color:#939a92;font-size:7px;line-height:1.55}.visual-rule-review article>small{display:block;margin-top:5px;color:#666e67;font-size:6px;line-height:1.45}.visual-rule-review article>.visual-warning-copy{color:#a98566}.visual-rule-actions{display:grid;grid-template-columns:1.35fr .8fr;gap:4px;margin-top:8px}.visual-rule-actions button{min-height:25px;display:flex;align-items:center;justify-content:center;gap:4px;border:1px solid #3a403a;background:transparent;color:#747d75;font-size:6px;cursor:pointer}.visual-rule-actions button:first-child.active{border-color:#5c8478;background:#1a2a24;color:#8bcec3}.visual-rule-actions button:last-child.active{border-color:#7c493e;background:#2b1c18;color:#dc7c69}.visual-rule-review article>textarea{width:100%;margin-top:6px;padding:6px;resize:vertical;border:1px solid #6b3d34;background:#1c1513;color:#d9b0a8;font-size:7px;line-height:1.5}.visual-rule-missing{margin-top:9px;padding:9px;border:1px solid #5d3831;background:#241814;color:#cc7a68;font-size:7px;line-height:1.5}.visual-rule-review>footer{padding-top:10px;color:#667069;font-size:7px}.visual-rule-review>footer b{color:#d49b66}
.frame-tabs{height:34px;display:flex;align-items:center;gap:2px;padding:0 18px;overflow-x:auto;border-bottom:1px solid #282a24;background:#10110e}.frame-tabs button{height:24px;display:flex;flex:0 0 auto;align-items:center;gap:6px;padding:0 9px;border:0;background:transparent;color:#777a70;font-size:8px;cursor:pointer}.frame-tabs button span{width:6px;height:6px;border:1px solid #565950;border-radius:50%}.frame-tabs button.viewed span{border-color:#83aa72;background:#83aa72}.frame-tabs button.active{color:#d7af55;background:#242219}.frame-tabs em{margin-left:auto;overflow:hidden;color:#5e6158;font-size:7px;font-style:normal;white-space:nowrap;text-overflow:ellipsis}
.frame-tabs~.compare-toolbar+.compare-stage .media-frame{height:min(50vh,530px)}
.review-studio{height:100%;display:grid;grid-template-rows:90px minmax(0,1fr);background:#0d0e0c}.review-header{display:flex;align-items:center;justify-content:space-between;padding:0 24px;border-bottom:1px solid #30322c;background:#151613}.review-header h2{margin:6px 0 3px;font-size:19px}.review-header p{margin:0;color:#7d8076;font-size:9px}.review-metrics{display:flex;align-items:center;gap:18px}.review-metrics>div{padding-left:17px;border-left:1px solid #34362f}.review-metrics span,.review-metrics b{display:block}.review-metrics span{color:#686b62;font-size:8px}.review-metrics b{margin-top:4px;font-size:13px}.review-body{min-height:0;display:grid;grid-template-columns:230px minmax(0,1fr) 330px}.review-queue{min-height:0;display:flex;flex-direction:column;border-right:1px solid #30322c;background:#151613}.queue-filter{padding:11px 12px;border-bottom:1px solid #30322c}.queue-filter select{width:100%;height:29px;border:1px solid #35372f;background:#1b1c18;color:#ccc}.queue-filter label{display:flex;align-items:center;gap:6px;margin-top:8px;color:#74776d;font-size:8px}.queue-filter input{accent-color:#d7af55}.queue-list{flex:1;overflow:auto}.queue-list button{position:relative;width:100%;display:grid;grid-template-columns:52px minmax(0,1fr);gap:10px;padding:10px 11px;border:0;border-bottom:1px solid #292b25;border-left:2px solid transparent;background:transparent;color:#c4c6bc;text-align:left;cursor:pointer}.queue-list button:hover{background:#1b1c18}.queue-list button.active{border-left-color:#d7af55;background:#202019}.queue-list figure{width:52px;height:66px;margin:0;display:grid;place-items:center;overflow:hidden;background:#10110e;color:#55584f}.queue-list img{width:100%;height:100%;object-fit:cover}.queue-list div{min-width:0}.queue-list span,.queue-list b,.queue-list small{display:block}.queue-list span{color:#d7af55;font-size:7px}.queue-list b{margin-top:5px;overflow:hidden;font-size:9px;white-space:nowrap;text-overflow:ellipsis}.queue-list small{margin-top:7px;color:#6e7168;font-size:7px}.queue-list i{position:absolute;right:8px;top:9px;width:6px;height:6px;border-radius:50%;background:#595c53}.queue-list i.decision-pass{background:#83aa72}.queue-list i.decision-rework{background:#d36b59}.queue-list i.decision-pending{background:#d7af55}.review-queue>footer{height:34px;display:flex;align-items:center;padding:0 12px;border-top:1px solid #30322c;color:#676a61;font-size:8px}.review-stage{min-width:0;overflow:auto;background:#0d0e0c}.review-item-heading{height:77px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid #282a24;background:#121310}.review-item-heading span{color:#d7af55;font-size:7px}.review-item-heading h3{margin:5px 0 3px;max-width:720px;overflow:hidden;font-size:14px;white-space:nowrap;text-overflow:ellipsis}.review-item-heading p{margin:0;color:#71746b;font-size:8px}.review-item-heading>b{font-size:8px;color:#999c92}.compare-toolbar{height:48px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;padding:0 18px;border-bottom:1px solid #282a24;background:#151613}.compare-toolbar label{display:grid;grid-template-columns:22px 1fr;align-items:center}.compare-toolbar label span{color:#d7af55;font:bold 9px Menlo,monospace}.compare-toolbar select{min-width:0;height:29px;border:1px solid #35372f;background:#10110f;color:#bbb;font-size:8px}.compare-toolbar button{height:27px;display:flex;align-items:center;gap:5px;border:0;background:transparent;color:#777a70;font-size:7px;cursor:pointer}.compare-stage{display:grid;grid-template-columns:1fr 1fr;gap:1px;min-width:720px;background:#30322c}.compare-stage.single{grid-template-columns:1fr}.media-pane{min-width:0;background:#11120f}.media-pane>header{height:34px;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid #292b25}.media-pane>header span{width:19px;height:19px;display:grid;place-items:center;background:#d7af55;color:#17130a;font:bold 8px Menlo,monospace}.media-pane>header b{font-size:8px}.media-pane>header em{margin-left:auto;color:#d07865;font-size:7px;font-style:normal}.media-pane>header em.ok{color:#83aa72}.media-frame{height:min(53vh,560px);display:grid;place-items:center;overflow:hidden;background:#070806}.media-frame img,.media-frame video{width:100%;height:100%;object-fit:contain}.media-pane>footer{min-height:76px;display:flex;justify-content:space-between;gap:12px;padding:10px;border-top:1px solid #292b25}.media-pane>footer>div:first-child{min-width:0}.media-pane>footer span,.media-pane>footer small,.media-pane>footer p{display:block}.media-pane>footer span{color:#b7b9af;font-size:7px}.media-pane>footer small{margin-top:4px;color:#74776d;font-size:7px}.media-pane>footer p{margin:5px 0 0;overflow:hidden;color:#565950;font:6px Menlo,monospace;white-space:nowrap;text-overflow:ellipsis}.media-pane>footer>div:last-child{display:flex;align-items:start;gap:5px}.media-pane>footer button{height:25px;display:flex;align-items:center;gap:4px;border:1px solid #393b33;background:transparent;color:#999c92;font-size:7px;cursor:pointer}.review-inspector{min-height:0;overflow:auto;border-left:1px solid #30322c;background:#171815}.review-inspector>header{height:58px;display:flex;align-items:center;justify-content:space-between;padding:0 15px;border-bottom:1px solid #30322c}.review-inspector>header b{color:#8d9085;font:9px Menlo,monospace}.criteria-list{padding:4px 15px}.criteria-list article{padding:10px 0;border-bottom:1px solid #2b2d27}.criteria-list article>div:first-child{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.criteria-list article b{font-size:9px}.criteria-list article span{color:#65685f;font-size:7px}.criterion-actions{display:flex;gap:4px;margin-top:7px}.criterion-actions button{height:23px;min-width:28px;display:grid;place-items:center;border:1px solid #383a33;background:transparent;color:#71746b;font-size:7px;cursor:pointer}.criterion-pass .criterion-actions button:first-child.active{border-color:#5e7a53;color:#83aa72;background:#1b2518}.criterion-fail .criterion-actions button:nth-child(2).active{border-color:#7a443a;color:#d36b59;background:#281a17}.criterion-na .criterion-actions button:last-child.active{border-color:#575a51;color:#bbb}.criteria-list input{width:100%;height:26px;margin-top:7px;border:1px solid #5a3831;background:#1c1513;color:#d9b0a8;padding:0 7px;font-size:8px}.review-note{display:block;padding:12px 15px;border-top:1px solid #30322c}.review-note span{display:block;margin-bottom:7px;color:#777a70;font-size:8px}.review-note textarea{width:100%;resize:vertical;border:1px solid #35372f;background:#11120f;color:#ddd;padding:8px;font-size:8px;line-height:1.5}.decision-actions{display:grid;grid-template-columns:.7fr 1fr 1.15fr;gap:5px;padding:0 15px 14px}.decision-actions button{height:32px;border:1px solid #3a3c34;background:transparent;color:#999c92;font-size:8px;cursor:pointer}.decision-actions button:disabled{opacity:.35;cursor:default}.decision-actions .rework{border-color:#5d3831;color:#d36b59}.decision-actions .pass{display:flex;align-items:center;justify-content:center;gap:5px;border-color:#d7af55;background:#d7af55;color:#17130a;font-weight:700}.review-history{padding:13px 15px 40px;border-top:1px solid #30322c}.review-history>div{display:flex;justify-content:space-between;color:#85887d;font-size:8px}.review-history article{display:flex;gap:8px;padding:10px 0;border-bottom:1px solid #292b25}.review-history i{flex:0 0 auto;width:7px;height:7px;margin-top:2px;border-radius:50%;background:#777970}.review-history i.decision-pass{background:#83aa72}.review-history i.decision-rework{background:#d36b59}.review-history i.decision-pending{background:#d7af55}.review-history article b,.review-history article span,.review-history article p{display:block}.review-history article b{font-size:8px}.review-history article span{margin-top:4px;color:#62655c;font-size:7px}.review-history article p{margin:5px 0 0;color:#8b8e83;font-size:7px;line-height:1.45}.no-history{color:#5e6158;font-size:8px}.review-empty{height:100%;display:grid;place-content:center;justify-items:center;gap:10px;color:#5f6259;font-size:9px}
.media-frame{container-type:size}.media-canvas{position:relative;width:min(100cqw,calc(100cqh * var(--media-aspect)));height:min(100cqh,calc(100cqw / var(--media-aspect)));background:#050604}.media-canvas>img,.media-canvas>video{width:100%;height:100%;display:block;object-fit:contain}.annotation-capture{position:absolute;inset:0;z-index:5;display:grid;place-content:center;justify-items:center;gap:7px;border:1px solid #d7af55;background:#17130a26;color:#f0cf76;cursor:crosshair}.annotation-capture span{padding:5px 7px;background:#15120ce8;font-size:7px}.annotation-pin{position:absolute;z-index:7;width:23px;height:23px;display:grid;place-items:center;transform:translate(-50%,-50%);border:2px solid #111;border-radius:50%;color:#111;font:bold 8px Menlo,monospace;box-shadow:0 2px 9px #000c;cursor:pointer}.annotation-pin.draft{box-shadow:0 0 0 2px #fff9,0 3px 12px #000}.annotation-issue{background:#d36b59}.annotation-keep{background:#83aa72}.annotation-question{background:#d7af55}.annotation-continuity{background:#70a7c5}
.annotation-editor{padding:12px 15px;border-top:1px solid #30322c}.annotation-editor>header{display:flex;align-items:center;justify-content:space-between}.annotation-editor>header>div{display:flex;align-items:center;gap:7px}.annotation-editor>header span{color:#999c92;font-size:8px}.annotation-editor>header b{color:#d7af55;font:8px Menlo,monospace}.annotation-editor>header button{height:27px;display:flex;align-items:center;gap:5px;border:1px solid #46483f;background:transparent;color:#999c92;font-size:7px}.annotation-editor>header button.active{border-color:#d7af55;background:#2a2619;color:#f0cf76}.annotation-editor>header button:disabled{opacity:.35}.annotation-editor>p{margin:7px 0 10px;color:#5f6259;font-size:7px;line-height:1.45}.annotation-editor>article{display:grid;grid-template-columns:23px minmax(0,1fr) 22px;gap:7px;padding:9px 0;border-top:1px solid #292b25;outline:none}.annotation-editor>article:focus{background:#201f19}.annotation-editor>article.invalid textarea{border-color:#6b3d34}.annotation-editor>article>i{width:21px;height:21px;display:grid;place-items:center;border-radius:50%;color:#111;font:bold 7px Menlo,monospace;font-style:normal}.annotation-editor>article>div{min-width:0}.annotation-editor>article span{display:flex;justify-content:space-between;gap:5px;overflow:hidden;color:#8e9187;font-size:7px;white-space:nowrap;text-overflow:ellipsis}.annotation-editor>article span em{color:#d7af55;font:6px Menlo,monospace;font-style:normal}.annotation-editor>article small{display:block;margin:4px 0 6px;color:#55584f;font:6px Menlo,monospace}.annotation-editor select,.annotation-editor textarea{width:100%;border:1px solid #35372f;background:#11120f;color:#ccc;font-size:7px}.annotation-editor select{height:25px;padding:0 6px}.annotation-editor textarea{margin-top:5px;padding:6px;resize:vertical;line-height:1.45}.annotation-editor>article>button{width:22px;height:22px;border:0;background:transparent;color:#8a5b52}.annotation-empty{padding:12px 0 2px;color:#55584f;font-size:7px;line-height:1.5}.review-history ul{margin:8px 0 0;padding:0;list-style:none}.review-history li{padding:7px;border-left:2px solid #4d4f46;background:#121310}.review-history li+li{margin-top:4px}.review-history li b{color:#d7af55}.review-history li span{margin-top:3px!important;font:6px Menlo,monospace}.review-history li p{margin-top:4px!important}
</style>
