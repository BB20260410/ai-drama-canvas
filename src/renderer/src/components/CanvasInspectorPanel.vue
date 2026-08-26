<template>
  <aside class="canvas-inspector" aria-label="画布节点详情">
    <button type="button" class="inspector-close" data-testid="managed-canvas-inspector-close" aria-label="关闭详情" @click="emit('close')">×</button>
    <template v-if="selection.kind === 'asset'">
      <span class="inspector-kind">{{ assetCategoryLabel(selection.asset.category) }}</span><h3>{{ selection.asset.name }}</h3>
      <div v-if="authorityThumbUrl(selection.asset.authorityThumbnailRecipeKey)" class="inspector-thumb" data-testid="managed-canvas-inspector-thumb"><img :src="authorityThumbUrl(selection.asset.authorityThumbnailRecipeKey)" :alt="selection.asset.name" loading="lazy" decoding="async" /></div>
      <p data-testid="managed-canvas-character-description">{{ selection.asset.description || "尚未填写说明" }}</p>
      <dl>
        <dt>参考图</dt>
        <dd>{{ selection.asset.hasPrimaryAuthority ? "已锁定" : "待补" }}</dd>
        <dt>角色音频</dt>
        <dd data-testid="managed-canvas-character-audio">
          {{ characterAudioLabel }}
          <audio
            v-if="characterAudioPlaybackUrl"
            ref="characterAudioEl"
            class="audio-player inspector-audio-player"
            :class="{ 'audio-blocked': characterAudioBlocked }"
            controls
            preload="metadata"
            :src="characterAudioPlaybackUrl"
            data-testid="managed-canvas-character-audio-player"
            @play="onCharacterAudioPlay">
            当前桌面运行时不支持该音频格式。
          </audio>
        </dd>
        <dt>别名</dt>
        <dd data-testid="managed-canvas-character-aliases">{{ characterAliasLabel }}</dd>
        <dt>多视图</dt>
        <dd data-testid="managed-canvas-character-views">{{ characterViewLabel }}</dd>
      </dl>
      <details class="technical-diagnostics inspector-diagnostics"><summary data-testid="managed-canvas-inspector-diagnostics">诊断详情</summary><dl><dt>资产 ID</dt><dd>{{ selection.asset.id }}</dd><dt>当前修订</dt><dd>r{{ selection.asset.revision }}</dd></dl></details>
      <h4>出场时间线</h4><ul ref="appearanceListElement" class="appearance-list" data-testid="managed-canvas-appearances"><li v-for="(item, index) in appearancesPage?.page.items ?? []" :key="`${item.unitId}:${item.panelId}`"><button type="button" :tabindex="appearanceListActiveIndex === index ? 0 : -1" @focus="appearanceListRovingIndex = index" @click="emit('focusAppearance', item.unitId, item.panelId)"><b>{{ item.episode }} · {{ item.unitTitle }}</b><span>{{ item.panelTitle }} · {{ item.startSeconds }}–{{ item.endSeconds }} 秒</span></button></li><li v-if="!appearancesPage?.page.items.length">暂无出场记录</li></ul>
      <div class="pager appearance-pager">
        <button type="button" data-testid="managed-canvas-appearances-prev" :disabled="!appearanceCursorStackLength || loading" @click="emit('appearancesPrevious')">上一页</button>
        <button type="button" data-testid="managed-canvas-appearances-next" :disabled="!appearancesPage?.page.nextCursor || loading" @click="emit('appearancesNext')">下一页</button>
      </div>
    </template>
    <template v-else-if="selection.kind === 'unit'">
      <span class="inspector-kind">15 秒单元</span><h3>{{ selection.unit.label }}</h3><dl><dt>集数</dt><dd>{{ selection.unit.episodeId }}</dd><dt>宫格</dt><dd>{{ selection.unit.panelCount }}</dd><dt>状态</dt><dd>{{ productionStatusLabel(selection.unit.status) }}</dd></dl><p>宫格已经展开；点击任一宫格可查看动作、对白和控制资产。</p>
    </template>
    <template v-else-if="selection.kind === 'script' || selection.kind === 'prompt'">
      <span class="inspector-kind">{{ selection.kind === "script" ? "剧本" : "提示词" }}</span><h3>{{ selection.doc.title || "未命名文稿" }}</h3><p class="inspector-body" data-testid="managed-canvas-text-body">{{ selection.doc.bodyPreview || "（正文预览待加载）" }}</p><details class="technical-diagnostics inspector-diagnostics"><summary data-testid="managed-canvas-inspector-diagnostics">诊断详情</summary><dl><dt>文档 ID</dt><dd>{{ selection.doc.id }}</dd><dt>修订</dt><dd>r{{ selection.doc.revision }}</dd></dl></details>
    </template>
    <template v-else-if="selection.kind === 'panel'">
      <span class="inspector-kind">宫格 {{ selection.panel.ordinal }}</span><h3>{{ selection.panel.label }}</h3><p>{{ selection.panel.visualAction || selection.panel.statusReason || "尚无动作说明" }}</p><dl><dt>时间</dt><dd>{{ selection.panel.startSeconds }}–{{ selection.panel.endSeconds }} 秒</dd><dt>构图</dt><dd data-testid="managed-canvas-inspector-composition">{{ selection.panel.shotComposition || "构图未记" }}</dd><dt>前镜</dt><dd data-testid="managed-canvas-inspector-previous-standing">{{ panelPreviousStandingLine || "首格或尚未冻结前镜" }}</dd><dt>光线</dt><dd data-testid="managed-canvas-inspector-lighting">{{ panelFrozenLightingLine || (panelLightingCostumeSource === "unit-lock" ? "锁版未记光线" : "尚未冻结宫格光线") }}</dd><dt>服装</dt><dd data-testid="managed-canvas-inspector-costume">{{ panelFrozenCostumeLine || (panelLightingCostumeSource === "unit-lock" ? "锁版未记服装" : "尚未冻结宫格服装") }}</dd><dt>镜头类型</dt><dd data-testid="managed-canvas-inspector-shot-type">{{ panelShotTypeLine || (panelLightingCostumeSource === "unit-lock" ? "锁版未记镜头类型" : "尚未冻结镜头类型") }}</dd><dt>15s 节拍</dt><dd data-testid="managed-canvas-inspector-beat">{{ panelBeatLine || (panelLightingCostumeSource === "unit-lock" ? "锁版未记 15s 节拍" : "尚未冻结 15s 节拍") }}</dd><dt>场景回指</dt><dd data-testid="managed-canvas-inspector-scene-backrefs"><p>{{ panelSceneBackReferenceNote || "尚未查询场景回指" }}</p><button v-for="ref in panelSceneBackReferences" :key="`${ref.unitId}:${ref.panelId}:${ref.assetId}`" type="button" :data-testid="`managed-canvas-inspector-scene-backref-${ref.unitId}-${ref.panelId}`" @click="emit('revealSceneBackRef', ref)">U{{ ref.sequence }} G{{ ref.panelIndex }} {{ ref.role || ref.assetId }}</button></dd><dt>道具回指</dt><dd data-testid="managed-canvas-inspector-prop-backrefs"><p>{{ panelPropBackReferenceNote || "尚未查询道具回指" }}</p><button v-for="ref in panelPropBackReferences" :key="`prop:${ref.unitId}:${ref.panelId}:${ref.assetId}`" type="button" :data-testid="`managed-canvas-inspector-prop-backref-${ref.unitId}-${ref.panelId}`" @click="emit('revealSceneBackRef', ref)">U{{ ref.sequence }} G{{ ref.panelIndex }} {{ ref.role || ref.assetId }}</button></dd><dt>角色回指</dt><dd data-testid="managed-canvas-inspector-character-backrefs"><p>{{ panelCharacterBackReferenceNote || "尚未查询角色回指" }}</p><button v-for="ref in panelCharacterBackReferences" :key="`char:${ref.unitId}:${ref.panelId}:${ref.assetId}`" type="button" :data-testid="`managed-canvas-inspector-character-backref-${ref.unitId}-${ref.panelId}`" @click="emit('revealSceneBackRef', ref)">U{{ ref.sequence }} G{{ ref.panelIndex }} {{ ref.role || ref.assetId }}</button></dd><dt>绑定状态</dt><dd>{{ currentnessLabel(selection.panel.bindingCurrentness) }}</dd><dt>控制资产</dt><dd>{{ selection.panel.assetIds.length }}</dd></dl><p v-if="panelPreviousStandingLine" class="inspector-standing-note" data-testid="managed-canvas-inspector-standing-source">{{ panelPreviousStandingSource === "frozen-rendered-prompt" ? "冻结提示词约束。不是 BindingSet。" : "当前单元锁版。不是 BindingSet，不能当 generation-ready。" }}</p><p v-if="panelFrozenLightingLine || panelFrozenCostumeLine" class="inspector-standing-note" data-testid="managed-canvas-inspector-lighting-source">{{ panelLightingCostumeSource === "frozen-rendered-prompt" ? "冻结提示词约束。不是 BindingSet。" : "当前单元锁版。不是 BindingSet，不能当 generation-ready。" }}</p><p v-if="panelShotTypeLine" class="inspector-standing-note" data-testid="managed-canvas-inspector-shot-type-source">{{ panelLightingCostumeSource === "frozen-rendered-prompt" ? "冻结提示词约束。不是 BindingSet。" : "当前单元锁版。不是 BindingSet，不能当 generation-ready。" }}</p><p v-if="panelBeatLine" class="inspector-standing-note" data-testid="managed-canvas-inspector-beat-source">{{ panelLightingCostumeSource === "frozen-rendered-prompt" ? "冻结提示词约束。不是 BindingSet。" : "当前单元锁版。不是 BindingSet，不能当 generation-ready。" }}</p><blockquote v-if="selection.panel.dialogue">{{ selection.panel.dialogue }}</blockquote>
    </template>
    <section v-if="nodeActionPanel" class="node-action-panel" data-testid="managed-canvas-node-action-panel" aria-label="节点操作"><header><b>下一步</b><span v-if="selectedNodeBusy" class="busy-tag" data-testid="managed-canvas-node-busy">{{ selectedNodeBusy.message }}</span></header><div class="node-action-buttons"><button v-for="(action, index) in nodeActionPanel.actions" :key="action.code" type="button" :data-testid="`managed-canvas-action-${action.code}`" :disabled="!action.enabled" :tabindex="action.enabled && nodeActionActiveIndex === index ? 0 : -1" :title="action.reason || action.label" @focus="nodeActionRovingIndex = index" @click="emit('runNodeAction', action.code)">{{ action.label }}<small v-if="action.reason" :data-testid="`managed-canvas-action-reason-${action.code}`">{{ action.reason }}</small></button></div></section>
  </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { claimCanvasAudioPlayback, releaseCanvasAudioPlayback } from "../canvas-audio-mutex";
import type {
  StudioDashboardAppearancesPage,
  StudioDashboardAssetSummary,
  StudioDashboardPanelSummary,
  StudioDashboardUnitSummary,
} from "@core/studio-production-dashboard";
import type { StudioCanvasNodeActionCode } from "@core/studio-canvas-node-action-panel";
import type { SceneBackReference } from "@core/studio-scene-backrefs";

/** P26 拆分子组件：画布右侧检查器（纯展示+事件上行；全部 testid 原样保留）。 */
export type CanvasInspectorSelection =
  | { kind: "asset"; asset: StudioDashboardAssetSummary }
  | { kind: "unit"; unit: StudioDashboardUnitSummary }
  | { kind: "panel"; panel: StudioDashboardPanelSummary }
  | { kind: "script" | "prompt"; doc: { id: string; kind: "script" | "prompt"; title: string; bodyPreview: string; revision: number } };

const props = defineProps<{
  selection: CanvasInspectorSelection;
  appearancesPage: StudioDashboardAppearancesPage | null;
  appearanceCursorStackLength: number;
  loading: boolean;
  nodeActionPanel: { actions: Array<{ code: StudioCanvasNodeActionCode; label: string; enabled: boolean; reason?: string }> } | null;
  selectedNodeBusy: { message: string } | null;
  authorityThumbUrl: (recipeKey?: string) => string | undefined;
  assetCategoryLabel: (category: string) => string;
  productionStatusLabel: (status: string) => string;
  currentnessLabel: (currentness: string) => string;
  characterAudioCount?: number;
  characterAudioPlaybackUrl?: string;
  characterAudioBlocked?: boolean;
  characterViewSlots?: string[];
  panelPreviousStandingLine?: string | null;
  panelPreviousStandingSource?: "frozen-rendered-prompt" | "unit-lock" | null;
  panelFrozenLightingLine?: string | null;
  panelFrozenCostumeLine?: string | null;
  panelLightingCostumeSource?: "frozen-rendered-prompt" | "unit-lock" | null;
  panelShotTypeLine?: string | null;
  panelBeatLine?: string | null;
  panelSceneBackReferenceNote?: string | null;
  panelSceneBackReferences?: SceneBackReference[];
  panelPropBackReferenceNote?: string | null;
  panelPropBackReferences?: SceneBackReference[];
  panelCharacterBackReferenceNote?: string | null;
  panelCharacterBackReferences?: SceneBackReference[];
}>();
const characterAudioEl = ref<HTMLAudioElement | null>(null);
const appearanceListRovingIndex = ref(-1);
const appearanceListActiveIndex = computed(() => {
  const items = props.appearancesPage?.page.items ?? [];
  if (items.length <= 0) return 0;
  if (appearanceListRovingIndex.value >= 0 && appearanceListRovingIndex.value < items.length) {
    return appearanceListRovingIndex.value;
  }
  return 0;
});
watch(
  () => props.appearancesPage?.page.items,
  () => {
    appearanceListRovingIndex.value = -1;
  },
);
const nodeActionRovingIndex = ref(-1);
const nodeActionActiveIndex = computed(() => {
  const actions = props.nodeActionPanel?.actions ?? [];
  const enabled = actions.flatMap((action, index) => action.enabled ? [index] : []);
  if (!enabled.length) return -1;
  if (enabled.includes(nodeActionRovingIndex.value)) return nodeActionRovingIndex.value;
  return enabled[0] ?? -1;
});
watch(
  () => props.nodeActionPanel?.actions,
  () => {
    nodeActionRovingIndex.value = -1;
  },
);

function onCharacterAudioPlay() {
  if (props.characterAudioBlocked) {
    characterAudioEl.value?.pause();
    return;
  }
  claimCanvasAudioPlayback(characterAudioEl.value);
}

watch(
  () => props.characterAudioBlocked,
  (blocked) => {
    if (blocked) characterAudioEl.value?.pause();
  },
);

watch(
  () => props.characterAudioPlaybackUrl,
  () => {
    characterAudioEl.value?.pause();
  },
);

onBeforeUnmount(() => {
  characterAudioEl.value?.pause();
  releaseCanvasAudioPlayback(characterAudioEl.value);
});

const characterAudioLabel = computed(() => {
  if (props.selection.kind !== "asset" || props.selection.asset.category !== "character") return "不适用";
  const count = props.characterAudioCount ?? 0;
  return count > 0 ? `${count} 条已绑定，放到画布时会自动带出` : "未绑定";
});

const characterAliasLabel = computed(() => {
  if (props.selection.kind !== "asset") return "未填写";
  const aliases = props.selection.asset.aliases ?? [];
  return aliases.length ? aliases.join("、") : "未填写";
});

const characterViewLabel = computed(() => {
  if (props.selection.kind !== "asset" || props.selection.asset.category !== "character") return "不适用";
  const slots = props.characterViewSlots ?? [];
  const names = ["正", ...slots.map((slot) => (slot === "side" ? "侧" : slot === "back" ? "背" : slot))];
  return names.join("、");
});

const emit = defineEmits<{
  close: [];
  focusAppearance: [unitId: string, panelId: string];
  appearancesPrevious: [];
  appearancesNext: [];
  runNodeAction: [code: StudioCanvasNodeActionCode];
  revealSceneBackRef: [ref: SceneBackReference];
}>();

// 父组件需要滚动出场时间线（节点动作 focus-appearances 时）。
const appearanceListElement = ref<HTMLElement | null>(null);
defineExpose({ appearanceListElement });
</script>

<style scoped>
.canvas-inspector { position: relative; border-left: 1px solid var(--msc-line); padding: 16px; }
.inspector-close { position: absolute; top: 10px; right: 10px; width: 28px; height: 28px; border: 0; border-radius: 8px; background: var(--msc-surface-2); cursor: pointer; }
.canvas-inspector h3 { margin: 5px 30px 10px 0; font-size: 15px; }
.canvas-inspector h4 { margin: 18px 0 8px; color: var(--msc-accent-strong); font-size: 12px; }
.canvas-inspector p { color: var(--msc-text-2); font-size: 12px; line-height: 1.6; }
.inspector-standing-note { margin: 8px 0 0; color: var(--msc-text-3); font-size: 10px; line-height: 1.5; }
.inspector-kind { color: var(--msc-accent); font-size: 10px; font-weight: 700; letter-spacing: .12em; }
.inspector-thumb { margin: 8px 0 10px; overflow: hidden; border: 1px solid var(--msc-line); border-radius: 9px; aspect-ratio: 16/10; background: var(--msc-bg); }
.inspector-thumb img { width: 100%; height: 100%; display: block; object-fit: cover; }
.inspector-body { max-height: 260px; overflow: auto; padding: 10px; border: 1px solid var(--msc-line); border-radius: 8px; background: var(--msc-bg); white-space: pre-wrap; }
.canvas-inspector dl { display: grid; grid-template-columns: 70px 1fr; gap: 6px; font-size: 11px; }
.canvas-inspector dt { color: var(--msc-text-3); }
.canvas-inspector dd { margin: 0; word-break: break-word; }
.canvas-inspector dd button { display: block; margin: 4px 0 0; border: 1px solid var(--msc-line); border-radius: 6px; background: var(--msc-bg); padding: 4px 6px; color: var(--msc-text); font-size: 10px; cursor: pointer; }
.appearance-list { list-style: none; margin: 0; padding: 0; }
.appearance-list li { margin-bottom: 5px; }
.appearance-list button { width: 100%; border: 1px solid var(--msc-line); border-radius: 7px; background: var(--msc-bg); padding: 8px; color: var(--msc-text); text-align: left; cursor: pointer; content-visibility: auto; contain-intrinsic-size: auto 40px; }
.appearance-list button:hover { background: var(--msc-surface-2); }
.appearance-list b, .appearance-list span { display: block; }
.appearance-list span { margin-top: 3px; color: var(--msc-text-3); font-size: 10px; }
.canvas-inspector blockquote { margin: 11px 0; padding: 9px; border-left: 2px solid var(--msc-accent); background: var(--msc-surface-2); font-size: 12px; }
.node-action-panel { margin-top: 14px; padding: 10px; border: 1px solid var(--msc-line); border-radius: 8px; background: var(--msc-bg); }
.node-action-panel header { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 12px; }
.busy-tag { color: var(--msc-accent); font-size: 10px; }
.node-action-buttons { display: grid; gap: 6px; }
.node-action-buttons button { display: grid; gap: 3px; border: 0; border-radius: 7px; background: var(--msc-surface-2); padding: 8px; text-align: left; cursor: pointer; }
.node-action-buttons button small { color: var(--msc-text-3); font-size: 10px; line-height: 1.4; }
.node-action-buttons button:disabled { opacity: .4; cursor: default; }
.inspector-diagnostics { margin-top: 10px; border: 1px solid var(--msc-line); border-radius: 7px; background: var(--msc-bg); }
.inspector-diagnostics > summary { padding: 7px; color: var(--msc-text-3); font-size: 10px; cursor: pointer; }
.inspector-diagnostics > dl { padding: 0 7px 7px; }
.pager { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.pager button { border: 0; border-radius: 8px; background: var(--msc-surface-2); padding: 7px 10px; cursor: pointer; }
.pager button:disabled { opacity: .35; cursor: default; }
.inspector-audio-player { display: block; width: 100%; height: 38px; margin-top: 4px; background: transparent; }
.inspector-audio-player.audio-blocked { pointer-events: none; }
</style>
