<template>
  <div
    class="msc-node"
    :class="[
      `kind-${data.kind}`,
      data.locked ? 'locked' : '',
      data.missing ? 'missing' : '',
      data.busy ? 'busy' : '',
      exportArmed ? 'export-armed' : '',
    ]"
    data-testid="managed-studio-canvas-node"
    :data-node-kind="data.kind"
    :data-unit-id="data.unitId || undefined"
    :data-media-sha256="data.mediaSha256 || undefined"
  >
    <Handle
      v-if="data.connectable"
      id="left"
      type="target"
      :position="Position.Left"
      class="connection-handle left-handle"
      role="button"
      tabindex="0"
      aria-label="左侧连接点"
      title="点击后，再点击另一个节点的加号进行连线"
      data-testid="managed-canvas-node-left-plus"
      @click.stop.prevent="data.onConnectPoint?.('left')"
      @keydown.enter.stop.prevent="data.onConnectPoint?.('left')"
      @keydown.space.stop.prevent="data.onConnectPoint?.('left')"
    >
      <span aria-hidden="true">＋</span>
      <i v-if="data.kind === 'panel'" data-testid="managed-canvas-panel-target" aria-hidden="true"></i>
    </Handle>
    <div
      v-if="displayThumbnailUrl"
      class="thumb-wrap"
      :class="{ 'exportable': canExportMedia, 'export-armed': exportArmed }"
      :title="exportTitle"
      data-testid="managed-canvas-node-thumb-wrap"
      @pointerdown="onThumbPointerDown"
      @pointerup="onThumbPointerUp"
      @pointercancel="onThumbPointerUp"
      @pointerleave="onThumbPointerLeave"
      @dragstart="onThumbDragStart"
      @click.stop>
      <img
        class="thumb"
        :src="displayThumbnailUrl"
        :alt="data.title"
        loading="lazy"
        decoding="async"
        :draggable="exportArmed"
        data-testid="managed-canvas-node-thumb"
        @error="recoverThumbnail"
      />
      <span v-if="canExportMedia" class="export-hint" aria-hidden="true">{{ exportArmed ? "拖到桌面" : "长按拖出" }}</span>
    </div>
    <div v-else class="thumb-placeholder" aria-hidden="true">
      <span>{{ kindMark }}</span>
    </div>
    <span v-if="data.locked" class="node-badge" role="img" aria-label="参考图已锁定" title="参考图已锁定"><Lock :size="11" aria-hidden="true" /></span>
    <div class="body">
      <span class="kind-label">{{ data.kindLabel }}</span>
      <strong class="title">{{ data.title }}</strong>
      <p v-if="data.subtitle" class="subtitle">{{ data.subtitle }}</p>
      <p v-if="data.excerpt" class="excerpt">{{ data.excerpt }}</p>
      <p
        v-if="data.mediaSha256"
        class="media-sha"
        :title="`完整 SHA-256：${data.mediaSha256}`"
        :aria-label="`内容 SHA-256：${data.mediaSha256}`"
        :data-media-sha256="data.mediaSha256"
        :data-unit-id="data.unitId || undefined"
        :data-node-kind="data.kind"
        data-testid="managed-canvas-media-sha"
      >
        SHA {{ shortMediaSha256 }}
      </p>
    </div>
    <Handle
      v-if="data.connectable"
      id="right"
      type="source"
      :position="Position.Right"
      class="connection-handle right-handle"
      role="button"
      tabindex="0"
      aria-label="右侧连接点"
      title="点击后，再点击另一个节点的加号进行连线"
      data-testid="managed-canvas-node-right-plus"
      @click.stop.prevent="data.onConnectPoint?.('right')"
      @keydown.enter.stop.prevent="data.onConnectPoint?.('right')"
      @keydown.space.stop.prevent="data.onConnectPoint?.('right')"
    >
      <span aria-hidden="true">＋</span>
      <i v-if="data.kind === 'asset' || data.kind === 'script' || data.kind === 'prompt'" data-testid="managed-canvas-input-source" aria-hidden="true"></i>
    </Handle>
    <div v-if="data.busy" class="managed-node-status-overlay" role="status" aria-live="polite">
      {{ data.busyMessage || "处理中…" }}
    </div>
    <div v-if="exportError" class="export-error" role="alert">{{ exportError }}</div>
  </div>
</template>

<script setup lang="ts">
import { Handle, Position } from "@vue-flow/core";
import { Lock } from "lucide-vue-next";
import { computed, onBeforeUnmount, ref, watch } from "vue";

export interface ManagedStudioCanvasNodeData {
  kind: "asset" | "reference" | "unit" | "panel" | "script" | "prompt" | "raw" | "labeled" | "review" | "video" | "continuity";
  kindLabel: string;
  title: string;
  subtitle?: string;
  excerpt?: string;
  thumbnailUrl?: string;
  locked?: boolean;
  missing?: boolean;
  busy?: boolean;
  busyMessage?: string;
  connectable?: boolean;
  onConnectPoint?: (side: "left" | "right") => void;
  id?: string;
  panelId?: string;
  unitId?: string;
  assetIds?: string[];
  referenceType?: "character" | "scene" | "prop" | "style" | "vfx" | "mixed";
  /** 当前节点实际展示/冻结的媒体身份；完整值由 title 与辅助技术读取保留。 */
  mediaSha256?: string;
  /** 可拖出的受管媒体 SHA（图/视频） */
  exportMediaSha256?: string;
  exportFileName?: string;
  projectRoot?: string;
}

const LONG_PRESS_MS = 320;

const props = defineProps<{ data: ManagedStudioCanvasNodeData }>();

const exportArmed = ref(false);
const exportError = ref("");
const preparedExportPath = ref<string | null>(null);
const thumbnailRepairing = ref(false);
const thumbnailFailed = ref(false);
const thumbnailRetryNonce = ref(0);
const thumbnailRepairAttempts = ref(0);
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let armExpireTimer: ReturnType<typeof setTimeout> | null = null;
let preparing = false;

const canExportMedia = computed(() => Boolean(
  props.data.exportMediaSha256
  && props.data.projectRoot
  && props.data.thumbnailUrl
  && !props.data.missing,
));

const displayThumbnailUrl = computed(() => {
  const url = props.data.thumbnailUrl;
  if (!url || thumbnailRepairing.value || thumbnailFailed.value) return undefined;
  if (!thumbnailRetryNonce.value) return url;
  return `${url}${url.includes("?") ? "&" : "?"}thumbnailRetry=${thumbnailRetryNonce.value}`;
});

const exportTitle = computed(() => {
  if (!canExportMedia.value) return undefined;
  return exportArmed.value
    ? "已就绪：拖到桌面或其他软件"
    : "长按缩略图，再拖出图片/视频到桌面或其他软件";
});

const kindMark = computed(() => {
  switch (props.data.kind) {
    case "asset": return "资";
    case "reference": return "参";
    case "unit": return "单";
    case "panel": return "格";
    case "script": return "剧";
    case "prompt": return "词";
    case "raw": return "原";
    case "labeled": return "标";
    case "review": return "审";
    case "video": return "视";
    case "continuity": return "续";
    default: return "·";
  }
});

const shortMediaSha256 = computed(() => {
  const sha = props.data.mediaSha256?.trim() ?? "";
  return sha.length > 16 ? `${sha.slice(0, 12)}…${sha.slice(-4)}` : sha;
});

async function recoverThumbnail(): Promise<void> {
  const projectRoot = props.data.projectRoot;
  const mediaSha256 = props.data.mediaSha256;
  const sourceUrl = props.data.thumbnailUrl;
  if (!projectRoot || !mediaSha256 || !sourceUrl || thumbnailRepairing.value) {
    thumbnailFailed.value = true;
    return;
  }
  if (thumbnailRepairAttempts.value >= 2) {
    thumbnailFailed.value = true;
    return;
  }
  const identity = `${projectRoot}\u0000${mediaSha256}\u0000${sourceUrl}`;
  thumbnailRepairAttempts.value += 1;
  thumbnailRepairing.value = true;
  thumbnailFailed.value = false;
  try {
    await window.canvasApi.ensureStudioImageThumbnail(projectRoot, mediaSha256);
    const currentIdentity = `${props.data.projectRoot ?? ""}\u0000${props.data.mediaSha256 ?? ""}\u0000${props.data.thumbnailUrl ?? ""}`;
    if (currentIdentity !== identity) return;
    thumbnailRetryNonce.value += 1;
  } catch {
    thumbnailFailed.value = true;
  } finally {
    thumbnailRepairing.value = false;
  }
}

watch(
  () => [props.data.projectRoot, props.data.mediaSha256, props.data.thumbnailUrl],
  () => {
    thumbnailRepairing.value = false;
    thumbnailFailed.value = false;
    thumbnailRetryNonce.value = 0;
    thumbnailRepairAttempts.value = 0;
  },
);

function clearPressTimer(): void {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
}

function clearArmExpireTimer(): void {
  if (armExpireTimer) {
    clearTimeout(armExpireTimer);
    armExpireTimer = null;
  }
}

function disarmExport(): void {
  clearPressTimer();
  clearArmExpireTimer();
  exportArmed.value = false;
  preparedExportPath.value = null;
  exportError.value = "";
}

async function armExport(): Promise<void> {
  if (!canExportMedia.value || preparing) return;
  const projectRoot = props.data.projectRoot!;
  const mediaSha256 = props.data.exportMediaSha256!;
  preparing = true;
  exportError.value = "";
  try {
    const prepared = await window.canvasApi.prepareStudioMediaExport(
      projectRoot,
      mediaSha256,
      props.data.exportFileName ?? props.data.title,
    );
    preparedExportPath.value = prepared.exportPath;
    exportArmed.value = true;
    clearArmExpireTimer();
    // 武装后 4s 未拖出则自动解除，避免一直锁住节点
    armExpireTimer = setTimeout(() => {
      if (exportArmed.value) disarmExport();
    }, 4_000);
  } catch (error) {
    exportError.value = error instanceof Error ? error.message : "准备拖出失败";
    exportArmed.value = false;
    preparedExportPath.value = null;
  } finally {
    preparing = false;
  }
}

function onThumbPointerDown(event: PointerEvent): void {
  if (!canExportMedia.value) return;
  if (event.button !== 0) return;
  // 阻止 Vue Flow 节点拖移，保留缩略图长按拖出语义
  event.stopPropagation();
  clearPressTimer();
  exportError.value = "";
  pressTimer = setTimeout(() => {
    void armExport();
  }, LONG_PRESS_MS);
}

function onThumbPointerUp(): void {
  clearPressTimer();
  // 松手且未开始原生拖时解除武装，避免误拖
  if (!preparing) {
    // 给 dragstart 留一帧；若用户在武装后立刻拖会走 dragstart
    window.setTimeout(() => {
      if (!preparing) {
        /* keep armed briefly while user starts drag */
      }
    }, 0);
  }
}

function onThumbPointerLeave(): void {
  // 指针离开缩略图且未在拖时取消长按计时；已武装保留以便拖出
  clearPressTimer();
}

function onThumbDragStart(event: DragEvent): void {
  if (!exportArmed.value || !preparedExportPath.value) {
    event.preventDefault();
    return;
  }
  event.stopPropagation();
  event.preventDefault();
  window.canvasApi.startNativeFileDrag(preparedExportPath.value);
  // 一次拖出后解除武装，下次需再长按
  window.setTimeout(() => disarmExport(), 50);
}

onBeforeUnmount(() => {
  clearPressTimer();
  clearArmExpireTimer();
});
</script>

<style scoped>
/* P25：全部颜色消费宿主画布的 --msc-* 主题 token（CSS 变量跨 scoped 经 DOM 继承），本组件无硬编码色。 */
.msc-node {
  position: relative;
  width: 188px;
  border: 1px solid var(--msc-kind-asset, var(--msc-line));
  border-radius: 10px;
  background: var(--msc-surface);
  color: var(--msc-text);
  /* Vue Flow 的连接点有一半位于卡片边缘外；不得裁掉，否则功能存在但用户无法点击。 */
  overflow: visible;
}
/* P29：锁定改为右上角角标（不再整卡变色），missing 统一虚线危险边。 */
.msc-node.kind-asset.locked { border-color: var(--msc-line); }
.msc-node.kind-reference { border-color: var(--msc-kind-asset); background: color-mix(in srgb, var(--msc-kind-asset) 8%, var(--msc-surface)); }
.msc-node.missing { border-style: dashed; border-color: var(--msc-danger); opacity: 0.85; }
.msc-node.export-armed {
  outline: 2px solid var(--msc-accent);
  outline-offset: 1px;
}
.node-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 3;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border: 1px solid var(--msc-line);
  border-radius: 50%;
  background: var(--msc-surface);
  color: var(--msc-text-2);
  pointer-events: none;
}
.msc-node.kind-unit { border-color: var(--msc-kind-unit); background: color-mix(in srgb, var(--msc-kind-unit) 9%, var(--msc-surface)); }
.msc-node.kind-panel { border-color: var(--msc-kind-panel); background: color-mix(in srgb, var(--msc-kind-panel) 9%, var(--msc-surface)); }
.msc-node.kind-script { border-color: var(--msc-kind-script); background: color-mix(in srgb, var(--msc-kind-script) 9%, var(--msc-surface)); }
.msc-node.kind-prompt { border-color: var(--msc-kind-prompt); background: color-mix(in srgb, var(--msc-kind-prompt) 9%, var(--msc-surface)); }
.msc-node.kind-raw { border-color: var(--msc-kind-raw); background: color-mix(in srgb, var(--msc-kind-raw) 9%, var(--msc-surface)); }
.msc-node.kind-labeled { border-color: var(--msc-kind-labeled); background: color-mix(in srgb, var(--msc-kind-labeled) 9%, var(--msc-surface)); }
.msc-node.kind-review { border-color: var(--msc-kind-review); background: color-mix(in srgb, var(--msc-kind-review) 9%, var(--msc-surface)); }
.msc-node.kind-video { border-color: var(--msc-kind-labeled); background: color-mix(in srgb, var(--msc-kind-labeled) 9%, var(--msc-surface)); }
.msc-node.kind-continuity { border-color: var(--msc-kind-unit); background: color-mix(in srgb, var(--msc-kind-unit) 9%, var(--msc-surface)); }
.msc-node.busy { outline: 1px solid var(--msc-accent); }
.connection-handle {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: 2px solid var(--msc-accent);
  border-radius: 50%;
  background: var(--msc-surface);
  color: var(--msc-accent-strong);
  font: 700 18px/1 system-ui, sans-serif;
  cursor: crosshair;
  box-shadow: 0 0 0 4px var(--msc-accent-soft), 0 4px 12px rgba(0, 0, 0, .18);
  z-index: 4;
}
.connection-handle > span {
  display: block;
  transform: translateY(-1px);
  pointer-events: none;
}
.connection-handle > i {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.connection-handle:hover,
.connection-handle:focus-visible {
  outline: none;
  background: var(--msc-accent);
  color: var(--msc-accent-ink);
  box-shadow: 0 0 0 5px var(--msc-accent-soft), 0 5px 14px rgba(0, 0, 0, .22);
}
.thumb-wrap {
  position: relative;
  height: 108px;
  background: var(--msc-surface-2);
  overflow: hidden;
  border-radius: 9px 9px 0 0;
}
.thumb-wrap.exportable {
  cursor: grab;
}
.thumb-wrap.export-armed {
  cursor: grabbing;
  box-shadow: inset 0 0 0 2px var(--msc-accent);
}
.thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  user-select: none;
  -webkit-user-drag: none;
}
.thumb-wrap.export-armed .thumb {
  -webkit-user-drag: element;
}
.export-hint {
  position: absolute;
  left: 6px;
  bottom: 6px;
  z-index: 2;
  padding: 2px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--msc-surface) 88%, transparent);
  color: var(--msc-text-2);
  font-size: 9px;
  letter-spacing: .02em;
  pointer-events: none;
}
.export-error {
  position: absolute;
  left: 6px;
  right: 6px;
  bottom: 6px;
  z-index: 5;
  padding: 4px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--msc-danger) 18%, var(--msc-surface));
  color: var(--msc-danger);
  font-size: 9px;
  pointer-events: none;
}
.thumb-placeholder {
  height: 108px;
  display: grid;
  place-items: center;
  background: var(--msc-surface-2);
  color: var(--msc-text-2);
  font-size: 22px;
  border-radius: 9px 9px 0 0;
}
.body {
  padding: 10px 12px 12px;
}
.kind-label {
  display: block;
  color: var(--msc-text-2);
  font-size: 9px;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.title {
  display: block;
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.25;
  word-break: break-word;
}
.subtitle {
  margin: 5px 0 0;
  color: var(--msc-text-2);
  font-size: 10px;
  line-height: 1.35;
}
.excerpt {
  margin: 6px 0 0;
  color: var(--msc-text-2);
  font-size: 10px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.media-sha {
  margin: 6px 0 0;
  color: var(--msc-text-2);
  font: 9px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .015em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.managed-node-status-overlay {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: color-mix(in srgb, var(--msc-surface) 72%, transparent);
  color: var(--msc-accent-strong);
  font-size: 11px;
  font-weight: 600;
  pointer-events: none;
}
</style>
