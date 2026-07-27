<template>
  <section class="production-workspace">
    <header class="module-header">
      <div>
        <span class="eyebrow">{{ eyebrow }}</span>
        <h2>{{ title }}</h2>
        <p>{{ subtitle }}</p>
      </div>
      <div class="module-actions">
        <span v-if="selectedIds.size" class="selection-count">已选 {{ selectedIds.size }}</span>
        <button v-if="mode !== 'assets'" class="primary-button" type="button" :disabled="creating" @click="createPack">
          <PackagePlus :size="16" /> {{ creating ? "创建中" : `创建${mode === 'videos' ? '视频' : '图片'}任务包` }}
        </button>
      </div>
    </header>

    <div class="module-toolbar">
      <label class="module-search"><Search :size="15" /><input v-model="search" placeholder="搜索标题、说明或路径" /></label>
      <select v-if="mode !== 'assets'" v-model="episode">
        <option value="all">全部分集</option>
        <option v-for="value in episodes" :key="value" :value="String(value)">EP{{ String(value).padStart(2, "0") }}</option>
      </select>
      <div v-else class="asset-tabs">
        <button v-for="entry in assetCategories" :key="entry.id" type="button" :class="{ active: assetCategory === entry.id }" @click="assetCategory = entry.id">{{ entry.label }}</button>
      </div>
      <span>{{ filteredItems.length }} 项</span>
      <button v-if="mode !== 'assets'" type="button" @click="toggleVisibleSelection">{{ allVisibleSelected ? "取消全选" : "选择当前" }}</button>
    </div>

    <div v-if="mode === 'shots'" class="shot-table">
      <div class="table-head"><span></span><span>镜头单元</span><span>首帧</span><span>尾帧</span><span>状态 / 下一动作</span><span>文件</span></div>
      <button v-for="item in filteredItems" :key="item.id" type="button" class="shot-row" :class="{ selected: selectedIds.has(item.id) }" @click="$emit('select', item.id)">
        <span class="check-cell" @click.stop="toggle(item.id)"><i :class="{ checked: selectedIds.has(item.id) }"></i></span>
        <span class="shot-title"><b>EP{{ pad(item.episode) }} · 15s {{ pad(item.unit, 3) }}</b><small>{{ item.title }}</small></span>
        <span class="thumb-cell"><img v-if="imageFor(item, 'start')" loading="lazy" :src="assetUrl(imageFor(item, 'start')?.path)" /><em v-else>缺</em></span>
        <span class="thumb-cell"><img v-if="imageFor(item, 'end')" loading="lazy" :src="assetUrl(imageFor(item, 'end')?.path)" /><em v-else>缺</em></span>
        <span class="state-cell"><b :class="statusClass(item.status)"><i></i>{{ item.status }}</b><small>{{ item.nextAction }}</small></span>
        <span class="file-count">{{ artifactsFor(item).length }}</span>
      </button>
    </div>

    <div v-else-if="mode === 'assets'" class="asset-grid">
      <article v-for="item in filteredItems" :key="item.id" class="asset-card">
        <button class="asset-main" type="button" @click="$emit('select', item.id)">
          <figure><img v-if="item.thumbnailPath" loading="lazy" :src="assetUrl(item.thumbnailPath)" /><span v-else>无预览</span></figure>
          <div><span>{{ assetGroup(item) }}<template v-if="item.hardLockIds.length"> · 硬锁</template></span><b>{{ item.title }}</b><small>{{ item.sourcePaths[0] }}</small></div>
        </button>
        <footer><button type="button" @click="revealArtifact(item.sourcePaths[0]!)">定位文件</button><button v-if="!item.hardLockIds.length" type="button" @click="promoteAsset(item)">提升为硬锁</button><b v-else><LockKeyhole :size="12" /> 权威参考</b></footer>
      </article>
    </div>

    <template v-else>
      <section v-if="selectedVideoItem" class="video-preview-stage">
        <div class="video-player">
          <video v-if="videoFor(selectedVideoItem)" controls preload="metadata" :poster="assetUrl(imageFor(selectedVideoItem, 'start')?.path)" :src="assetUrl(videoFor(selectedVideoItem)?.path)"></video>
          <div v-else class="video-player-empty"><Film :size="28" /><span>该单元尚无视频结果</span><small>首尾帧已进入候选，可创建视频任务包或加入生成队列。</small></div>
        </div>
        <div class="video-inspection">
          <span class="eyebrow">视频验收</span><h3>{{ selectedVideoItem.title }}</h3><p>{{ selectedVideoItem.nextAction }}</p>
          <div class="video-version-list">
            <article v-for="artifact in videoVersions(selectedVideoItem)" :key="artifact.id" :class="{ authoritative: artifact.authoritative, deprecated: artifact.deprecated }">
              <div><b>{{ artifact.authoritative ? '权威版本' : artifact.versionLabel }}</b><small>{{ durationLabel(artifact) }} · {{ artifact.check.width ?? 0 }}×{{ artifact.check.height ?? 0 }} · {{ formatBytes(artifact.check.size) }}</small><em>{{ artifact.path }}</em></div>
              <span :class="{ ok: artifact.check.ok }">{{ artifact.deprecated ? '不计入' : artifact.check.ok ? '机械通过' : artifact.check.issues.join('；') }}</span>
              <button type="button" @click="revealArtifact(artifact.path)">文件</button>
              <button v-if="!artifact.authoritative && !artifact.deprecated && artifact.check.ok" type="button" @click="setVideoAuthority(artifact)">设为权威</button>
            </article>
          </div>
        </div>
      </section>
      <div class="video-grid">
      <button v-for="item in filteredItems" :key="item.id" type="button" class="video-card" :class="{ selected: selectedIds.has(item.id) || selectedVideoId === item.id }" @click="selectVideo(item)">
        <div class="video-frames">
          <img v-if="imageFor(item, 'start')" loading="lazy" :src="assetUrl(imageFor(item, 'start')?.path)" />
          <span v-else>首帧</span>
          <img v-if="imageFor(item, 'end')" loading="lazy" :src="assetUrl(imageFor(item, 'end')?.path)" />
          <span v-else>尾帧</span>
          <div v-if="videoFor(item)" class="video-badge"><Film :size="13" /> 已落盘</div>
        </div>
        <div class="video-copy">
          <span class="check-cell" @click.stop="toggle(item.id)"><i :class="{ checked: selectedIds.has(item.id) }"></i></span>
          <div><b>EP{{ pad(item.episode) }} · 15s {{ pad(item.unit, 3) }}</b><small>{{ item.status }} · {{ item.nextAction }}</small></div>
        </div>
      </button>
      </div>
    </template>

    <div v-if="!filteredItems.length" class="module-empty"><Film :size="26" /><span>当前筛选下没有项目</span></div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Film, LockKeyhole, PackagePlus, Search } from "lucide-vue-next";
import type { Artifact, ProjectIndex, WorkItem } from "@core/types";
import { assetUrl, authoritativeArtifacts, formatBytes, statusClass } from "../utils";

const props = defineProps<{ index: ProjectIndex; mode: "shots" | "assets" | "videos"; projectRoot: string }>();
const emit = defineEmits<{ select: [itemId: string]; taskCreated: [taskId: string]; updated: [message: string]; failed: [message: string] }>();
const search = ref("");
const episode = ref("all");
const assetCategory = ref<"all" | "locked" | "role" | "scene" | "prop">("all");
const assetCategories = [
  { id: "all" as const, label: "全部" },
  { id: "locked" as const, label: "硬锁" },
  { id: "role" as const, label: "角色" },
  { id: "scene" as const, label: "场景" },
  { id: "prop" as const, label: "道具 / 其他" },
];
const creating = ref(false);
const selectedIds = ref(new Set<string>());
const selectedVideoId = ref("");

const copy = computed(() => ({
  shots: ["镜头清单", "15 秒生产单元", "逐项检查首尾帧配对、状态与真实文件。"],
  assets: ["资产库", "角色、场景与道具参考", "从项目本地三视图和显式硬锁中自动发现。"],
  videos: ["视频工作台", "图生视频队列", "只领取首尾帧完成后的单元，不跨集创建批次。"],
}[props.mode]));
const eyebrow = computed(() => copy.value[0]);
const title = computed(() => copy.value[1]);
const subtitle = computed(() => copy.value[2]);
const artifacts = computed(() => new Map(props.index.artifacts.map((artifact) => [artifact.id, artifact])));
const episodes = computed(() => [...new Set(props.index.items.filter((item) => item.type === "unit" && item.episode).map((item) => item.episode as number))].sort((a, b) => a - b));
const filteredItems = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return props.index.items.filter((item) => {
    if (props.mode === "assets" && item.type !== "asset") return false;
    if (props.mode !== "assets" && item.type !== "unit") return false;
    if (props.mode === "videos") {
      const hasVideo = item.artifactIds.some((id) => artifacts.value.get(id)?.kind === "video" && !artifacts.value.get(id)?.deprecated);
      if (!hasVideo && !["待视频", "视频生成中", "待视频验收", "已完成", "返工"].includes(item.status)) return false;
    }
    if (props.mode !== "assets" && episode.value !== "all" && item.episode !== Number(episode.value)) return false;
    if (props.mode === "assets" && assetCategory.value !== "all") {
      if (assetCategory.value === "locked" && !item.hardLockIds.length) return false;
      if (assetCategory.value !== "locked" && assetGroupId(item) !== assetCategory.value) return false;
    }
    return !needle || `${item.title} ${item.infoExcerpt ?? ""} ${item.sourcePaths.join(" ")}`.toLowerCase().includes(needle);
  }).sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0) || (a.unit ?? 0) - (b.unit ?? 0) || a.title.localeCompare(b.title));
});
const allVisibleSelected = computed(() => filteredItems.value.length > 0 && filteredItems.value.every((item) => selectedIds.value.has(item.id)));
const selectedVideoItem = computed(() => filteredItems.value.find((item) => item.id === selectedVideoId.value) ?? null);

watch(() => props.mode, () => selectedIds.value = new Set());
watch(filteredItems, (items) => {
  if (props.mode !== "videos" || items.some((item) => item.id === selectedVideoId.value)) return;
  selectedVideoId.value = items.find((item) => videoFor(item))?.id ?? items[0]?.id ?? "";
}, { immediate: true });

function artifactsFor(item: WorkItem): Artifact[] {
  return authoritativeArtifacts(item.artifactIds.map((id) => artifacts.value.get(id)).filter((value): value is Artifact => Boolean(value)));
}
function imageFor(item: WorkItem, variant: "start" | "end"): Artifact | undefined {
  const images = artifactsFor(item).filter((artifact) => artifact.kind === "raw-image");
  return images.find((artifact) => artifact.variant === variant) ?? (variant === "start" ? images.find((artifact) => artifact.variant === "generic") : undefined);
}
function videoFor(item: WorkItem): Artifact | undefined { return artifactsFor(item).find((artifact) => artifact.kind === "video"); }
function videoVersions(item: WorkItem): Artifact[] { return item.artifactIds.map((id) => artifacts.value.get(id)).filter((artifact): artifact is Artifact => Boolean(artifact) && artifact?.kind === "video").sort((a, b) => Number(b.authoritative) - Number(a.authoritative) || b.modifiedAt.localeCompare(a.modifiedAt)); }
function durationLabel(artifact: Artifact): string { return artifact.check.duration ? `${artifact.check.duration.toFixed(2)} 秒` : "时长未知"; }
function selectVideo(item: WorkItem) { selectedVideoId.value = item.id; emit("select", item.id); }
function revealArtifact(filePath: string) { void window.canvasApi.showInFolder(filePath); }
const actionBusy = ref("");
function actionErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function setVideoAuthority(artifact: Artifact) {
  if (!selectedVideoItem.value || actionBusy.value) return;
  actionBusy.value = "authority";
  try {
    await window.canvasApi.setAuthoritativeArtifact(props.projectRoot, selectedVideoItem.value.id, artifact.id, "在视频工作台人工选择权威版本");
    emit("updated", "视频权威版本已更新");
  } catch (error) { emit("failed", actionErrorMessage(error)); }
  finally { actionBusy.value = ""; }
}
function pad(value?: number, length = 2): string { return String(value ?? 0).padStart(length, "0"); }
function assetGroup(item: WorkItem): string {
  if (item.assetCategory === "character") return "角色";
  if (item.assetCategory === "scene") return "场景";
  if (item.assetCategory === "prop") return "道具";
  return "未分类参考";
}
function assetGroupId(item: WorkItem): "role" | "scene" | "prop" | "unclassified" {
  if (item.assetCategory === "character") return "role";
  if (item.assetCategory === "scene") return "scene";
  if (item.assetCategory === "prop") return "prop";
  return "unclassified";
}
async function promoteAsset(item: WorkItem) {
  if (actionBusy.value) return;
  actionBusy.value = `promote-${item.id}`;
  try {
    await window.canvasApi.promoteAssetToHardLock(props.projectRoot, item.id, "在资产库人工确认并提升为权威硬锁");
    emit("updated", `${item.title} 已提升为显式硬锁`);
  } catch (error) { emit("failed", actionErrorMessage(error)); }
  finally { actionBusy.value = ""; }
}
function toggle(id: string) { const next = new Set(selectedIds.value); next.has(id) ? next.delete(id) : next.add(id); selectedIds.value = next; }
function toggleVisibleSelection() { const next = new Set(selectedIds.value); if (allVisibleSelected.value) filteredItems.value.forEach((item) => next.delete(item.id)); else filteredItems.value.forEach((item) => next.add(item.id)); selectedIds.value = next; }
async function createPack() {
  if (creating.value) return;
  // FE-08：无选择且范围为全部集时禁用（与"不跨集创建批次"文案一致，防误触整集建包）。
  if (!selectedIds.value.size && episode.value === "all") {
    emit("failed", "请先勾选要建包的单元（不跨集创建批次）。");
    return;
  }
  creating.value = true;
  try {
    const result = await window.canvasApi.createTaskPack(props.projectRoot, {
      itemIds: selectedIds.value.size ? [...selectedIds.value] : undefined,
      episode: episode.value === "all" ? undefined : Number(episode.value),
      mode: "autopilot",
      kind: props.mode === "videos" ? "video" : "image",
    });
    selectedIds.value = new Set();
    emit("taskCreated", result.task.id);
  } catch (error) { emit("failed", actionErrorMessage(error)); }
  finally { creating.value = false; }
}
</script>

<style scoped>
.production-workspace { height: 100%; min-width: 0; overflow: auto; background: #121310; }
.module-header { position: sticky; top: 0; z-index: 8; height: 92px; display: flex; align-items: center; justify-content: space-between; padding: 0 26px; border-bottom: 1px solid #30322c; background: rgba(18,19,16,.96); backdrop-filter: blur(12px); }
.module-header h2 { margin: 6px 0 3px; font-size: 19px; }.module-header p { margin: 0; color: #83867b; font-size: 10px; }.module-actions { display: flex; align-items: center; gap: 12px; }.selection-count { color: #d7af55; font-size: 10px; }
.module-toolbar { position: sticky; top: 92px; z-index: 7; display: flex; align-items: center; gap: 10px; height: 54px; padding: 0 26px; border-bottom: 1px solid #292b25; background: #151613; color: #797c72; font-size: 10px; }
.module-toolbar select { height: 32px; min-width: 130px; padding: 0 8px; border: 1px solid #33352e; background: #1c1d19; color: #ddd; }.module-toolbar > button { margin-left: auto; border: 0; background: transparent; color: #d7af55; cursor: pointer; }
.module-search { width: min(360px, 40%); height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 9px; border: 1px solid #33352e; background: #1c1d19; }.module-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: #eee; }
.shot-table { min-width: 820px; padding: 0 26px 70px; }.table-head,.shot-row { display: grid; grid-template-columns: 38px minmax(230px,1.5fr) 94px 94px minmax(180px,1fr) 48px; align-items: center; gap: 10px; }.table-head { height: 38px; color: #65685f; font-size: 9px; border-bottom: 1px solid #30322c; }.shot-row { width: 100%; min-height: 76px; padding: 7px 0; border: 0; border-bottom: 1px solid #292b25; background: transparent; text-align: left; cursor: pointer; }.shot-row:hover,.shot-row.selected { background: #191a17; }.check-cell { display: grid; place-items: center; }.check-cell i { width: 15px; height: 15px; border: 1px solid #44473d; }.check-cell i.checked { border-color: #d7af55; background: #d7af55; box-shadow: inset 0 0 0 3px #171815; }.shot-title b,.shot-title small,.state-cell b,.state-cell small { display: block; }.shot-title b { font-size: 10px; }.shot-title small { margin-top: 5px; color: #85887e; font-size: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.thumb-cell { width: 84px; height: 56px; display: grid; place-items: center; background: #1c1d19; color: #55584f; }.thumb-cell img { width: 100%; height: 100%; object-fit: cover; }.thumb-cell em { font-style: normal; font-size: 9px; }.state-cell b { color: #aaa; font-size: 9px; }.state-cell b i { display: inline-block; width: 6px; height: 6px; margin-right: 7px; border-radius: 50%; background: #d7af55; }.state-cell b.status-complete i { background: #83aa72; }.state-cell b.status-video i { background: #70a7c5; }.state-cell b.status-review i { background: #b98fdf; }.state-cell b.status-danger i { background: #d36b59; }.state-cell small { margin-top: 6px; color: #71746b; font-size: 9px; }.file-count { color: #777a70; text-align: center; font-size: 10px; }
.asset-tabs { display: flex; gap: 2px; }.asset-tabs button { height: 27px; border: 0; background: transparent; color: #777a70; font-size: 8px; cursor: pointer; }.asset-tabs button.active { color: #d7af55; box-shadow: inset 0 -1px #d7af55; }.asset-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(210px,1fr)); gap: 1px; padding: 1px 1px 70px; background: #2b2d27; }.asset-card { min-width: 0; background: #171815; }.asset-card:hover { background: #1d1f1b; }.asset-main { width: 100%; min-width: 0; padding: 0; border: 0; background: transparent; text-align: left; cursor: pointer; }.asset-card figure { height: 180px; margin: 0; display: grid; place-items: center; overflow: hidden; background: #11120f; color: #565950; }.asset-card img { width: 100%; height: 100%; object-fit: cover; }.asset-main > div { padding: 12px; }.asset-card span,.asset-card b,.asset-card small { display: block; }.asset-card span { color: #d7af55; font-size: 8px; letter-spacing: .08em; }.asset-card b { margin-top: 6px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.asset-card small { margin-top: 6px; color: #666960; font-size: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.asset-card footer { height: 34px; display: flex; align-items: center; gap: 6px; padding: 0 10px; border-top: 1px solid #2b2d27; }.asset-card footer button { border: 0; background: transparent; color: #8b8e83; font-size: 7px; cursor: pointer; }.asset-card footer button:last-of-type { margin-left: auto; color: #d7af55; }.asset-card footer b { margin: 0 0 0 auto; display: flex; align-items: center; gap: 5px; color: #d7af55; font-size: 7px; font-weight: 500; }
.video-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(300px,1fr)); gap: 12px; padding: 18px 26px 70px; }.video-card { min-width: 0; padding: 0; border: 1px solid #30322c; background: #181916; text-align: left; cursor: pointer; }.video-card:hover,.video-card.selected { border-color: #5d5132; }.video-frames { height: 154px; display: grid; grid-template-columns: 1fr 1fr; gap: 1px; position: relative; overflow: hidden; background: #30322c; }.video-frames img { width: 100%; height: 100%; object-fit: cover; }.video-frames > span { display: grid; place-items: center; background: #1c1d19; color: #575a51; font-size: 9px; }.video-badge { position: absolute; right: 8px; bottom: 8px; display: flex; align-items: center; gap: 5px; padding: 5px 7px; background: rgba(10,11,9,.86); color: #85b6ce; font-size: 8px; }.video-copy { height: 54px; display: flex; align-items: center; gap: 10px; padding: 0 12px; }.video-copy b,.video-copy small { display: block; }.video-copy b { font-size: 10px; }.video-copy small { margin-top: 5px; color: #777a70; font-size: 8px; }
.video-preview-stage { display: grid; grid-template-columns: minmax(420px,1.25fr) minmax(340px,1fr); min-height: 360px; border-bottom: 1px solid #30322c; background: #10110f; }.video-player { min-height: 360px; display: grid; place-items: center; border-right: 1px solid #30322c; background: #080907; }.video-player video { width: 100%; height: 360px; object-fit: contain; background: #080907; }.video-player-empty { display: grid; place-content: center; justify-items: center; gap: 10px; color: #62655c; }.video-player-empty span { color: #a7a99f; font-size: 11px; }.video-player-empty small { max-width: 280px; text-align: center; font-size: 8px; line-height: 1.5; }.video-inspection { min-width: 0; padding: 24px; }.video-inspection h3 { margin: 8px 0 5px; font-size: 15px; }.video-inspection > p { margin: 0 0 18px; color: #85887e; font-size: 9px; }.video-version-list article { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 7px 12px; padding: 11px 0; border-top: 1px solid #2d2f29; }.video-version-list article.authoritative { box-shadow: inset 2px 0 #d7af55; padding-left: 10px; }.video-version-list article.deprecated { opacity: .55; }.video-version-list b,.video-version-list small,.video-version-list em { display: block; }.video-version-list b { font-size: 9px; }.video-version-list small { margin-top: 5px; color: #85887e; font-size: 8px; }.video-version-list em { margin-top: 5px; color: #5e6158; font: 7px/1.35 Menlo,monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.video-version-list span { color: #d07865; font-size: 8px; }.video-version-list span.ok { color: #83aa72; }.video-version-list button { height: 24px; border: 1px solid #3a3c34; background: transparent; color: #aaa; font-size: 7px; cursor: pointer; }
.module-empty { height: 260px; display: grid; place-content: center; justify-items: center; gap: 11px; color: #5f6259; font-size: 10px; }
</style>
