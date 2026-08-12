<template>
  <section class="continuity-view" data-testid="continuity-timeline-view">
    <header class="continuity-header">
      <div>
        <span class="eyebrow">连续性时间线</span>
        <h2>角色、场景与道具出场轨道</h2>
        <p>按物化侧车只读浏览；点击任一出场段可回到对应 15 秒单元。</p>
      </div>
      <div class="continuity-metrics">
        <div><span>轨道</span><b>{{ trackPage?.total ?? 0 }}</b></div>
        <div><span>当前出场段</span><b>{{ spanPage?.total ?? 0 }}</b></div>
        <div><span>渲染上限</span><b>{{ TRACK_LIMIT }} / {{ SPAN_LIMIT }}</b></div>
      </div>
    </header>

    <div class="continuity-toolbar">
      <label class="continuity-search"><Search :size="14" /><input v-model="search" placeholder="资产 ID 或名称" /></label>
      <select v-model="category">
        <option value="all">全部资产</option>
        <option value="character">角色</option>
        <option value="scene">场景</option>
        <option value="prop">道具</option>
      </select>
      <select v-model="episode">
        <option value="all">全季</option>
        <option v-for="value in episodes" :key="value" :value="String(value)">EP{{ pad(value) }}</option>
      </select>
      <span v-if="trackPage?.available" class="store-identity">{{ trackPage.sourceContentAddress?.slice(0, 20) }}…</span>
      <span v-else class="store-identity unavailable">当前项目没有融合连续性侧车</span>
    </div>

    <div class="continuity-body">
      <aside class="track-rail">
        <div v-if="loadingTracks" class="continuity-empty compact"><LoaderCircle class="spinning" :size="19" />读取轨道摘要…</div>
        <div v-else-if="!trackPage?.available" class="continuity-empty compact"><GitBranch :size="22" />物化融合工程后可浏览连续性</div>
        <div v-else-if="!trackPage.items.length" class="continuity-empty compact"><SearchX :size="21" />当前筛选没有资产轨道</div>
        <div v-else class="track-list">
          <button
            v-for="track in trackPage.items"
            :key="track.assetId"
            type="button"
            :class="{ active: selectedAssetId === track.assetId }"
            @click="selectTrack(track.assetId)">
            <figure>
              <img v-if="assetItem(track.workItemId)?.thumbnailPath" loading="lazy" decoding="async" :src="assetUrl(assetItem(track.workItemId)!.thumbnailPath!)" :alt="`${track.assetId} 连续性缩略图`" />
              <span v-else>{{ track.assetId }}</span>
            </figure>
            <div>
              <span>{{ categoryLabel(track.category) }} · {{ track.assetId }}</span>
              <b>{{ track.assetName }}</b>
              <small>{{ track.unitCount }} 单元 · {{ track.spanCount }} 段</small>
            </div>
            <em :class="{ locked: Boolean(assetItem(track.workItemId)?.hardLockIds.length) }">{{ assetItem(track.workItemId)?.hardLockIds.length ? "硬锁" : assetItem(track.workItemId)?.status ?? "未扫描" }}</em>
          </button>
        </div>
        <footer v-if="trackPage?.available && trackPage.total > TRACK_LIMIT" class="pager">
          <button type="button" :disabled="trackPage.offset === 0 || loadingTracks" @click="moveTrackPage(-1)"><ChevronLeft :size="14" />上一页</button>
          <span>{{ pageLabel(trackPage.offset, trackPage.limit, trackPage.total) }}</span>
          <button type="button" :disabled="trackPage.offset + trackPage.limit >= trackPage.total || loadingTracks" @click="moveTrackPage(1)">下一页<ChevronRight :size="14" /></button>
        </footer>
      </aside>

      <main class="track-detail">
        <div v-if="loadingSpans" class="continuity-empty"><LoaderCircle class="spinning" :size="24" />读取出场跨度…</div>
        <div v-else-if="!selectedTrack" class="continuity-empty"><MousePointer2 :size="25" />选择一条资产轨道</div>
        <template v-else>
          <header class="track-heading">
            <div>
              <span>{{ categoryLabel(selectedTrack.category) }} · {{ selectedTrack.assetId }}</span>
              <h3>{{ selectedTrack.assetName }}</h3>
              <p>{{ selectedTrack.unitCount }} 个单元，{{ selectedTrack.spanCount }} 个连续性跨度 · {{ appearanceRange(selectedTrack) }}</p>
            </div>
            <div class="track-state">
              <b>{{ selectedAssetItem?.status ?? "未扫描" }}</b>
              <small>{{ selectedAssetItem?.hardLockIds.length ? `硬锁 ${selectedAssetItem.hardLockIds.length}` : "尚未硬锁" }}</small>
            </div>
          </header>

          <section class="episode-density" aria-label="分集出场密度">
            <button type="button" :class="{ active: episode === 'all' }" @click="episode = 'all'"><span>全季</span><b>{{ selectedTrack.spanCount }}</b></button>
            <button
              v-for="value in episodes"
              :key="value"
              type="button"
              :class="{ active: episode === String(value), occupied: episodeCount(value) > 0 }"
              :title="`EP${pad(value)}：${episodeCount(value)} 个出场段`"
              @click="episode = String(value)">
              <span>{{ pad(value) }}</span>
              <i :style="densityStyle(episodeCount(value))"></i>
              <b>{{ episodeCount(value) || '·' }}</b>
            </button>
          </section>

          <section class="span-table">
            <header><span>分集 / 单元</span><span>秒段与原镜</span><span>同场资产</span><span>状态 / 参考版本</span><span></span></header>
            <button v-for="entry in spanPage?.items ?? []" :key="entry.id" type="button" class="span-row" @click="openUnit(entry)">
              <span class="unit-cell"><b>{{ entry.episode }} · U{{ pad(entry.unitSequence, 3) }}</b><small>{{ entry.unitId }}</small></span>
              <span class="time-cell"><b>{{ entry.startSeconds.toFixed(1) }}–{{ entry.endSeconds.toFixed(1) }}s</b><small>{{ entry.sourceShots.length ? `原镜 ${entry.sourceShots.map((shot) => pad(shot)).join(' / ')}` : '扩写段' }} · 行 {{ entry.scheduleRowIndexes.map((row) => row + 1).join(' / ') }}</small></span>
              <span class="assets-cell"><small v-if="entry.characterAssetIds.length">人 {{ entry.characterAssetIds.join(' · ') }}</small><small v-if="entry.sceneAssetIds.length">景 {{ entry.sceneAssetIds.join(' · ') }}</small><small v-if="entry.propAssetIds.length">物 {{ entry.propAssetIds.join(' · ') }}</small></span>
              <span class="version-cell"><b>{{ entry.state || entry.costume || '基线状态' }}</b><small>{{ shortVersion(entry.referenceVersion) }}</small></span>
              <span class="open-cell">打开单元<ArrowUpRight :size="13" /></span>
            </button>
            <div v-if="spanPage?.available && !spanPage.items.length" class="continuity-empty embedded">当前分集没有出场段</div>
          </section>

          <footer v-if="spanPage && spanPage.total > SPAN_LIMIT" class="pager span-pager">
            <button type="button" :disabled="spanPage.offset === 0 || loadingSpans" @click="moveSpanPage(-1)"><ChevronLeft :size="14" />上一页</button>
            <span>{{ pageLabel(spanPage.offset, spanPage.limit, spanPage.total) }}</span>
            <button type="button" :disabled="spanPage.offset + spanPage.limit >= spanPage.total || loadingSpans" @click="moveSpanPage(1)">下一页<ChevronRight :size="14" /></button>
          </footer>
        </template>
      </main>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowUpRight, ChevronLeft, ChevronRight, GitBranch, LoaderCircle, MousePointer2, Search, SearchX } from "lucide-vue-next";
import type { ContinuitySpanPage, ContinuityTrackPage, ContinuityTrackSummary } from "@core/continuity";
import type { MaterializedContinuitySpan } from "@core/fusion-production";
import type { ProductionAssetCategory } from "@core/fusion-package";
import type { ProjectIndex, WorkItem } from "@core/types";
import { assetUrl } from "../utils";

const TRACK_LIMIT = 30;
const SPAN_LIMIT = 80;

const props = defineProps<{ projectRoot: string; index: ProjectIndex }>();
const emit = defineEmits<{
  openUnit: [payload: { unitItemId: string; episode: number }];
  failed: [message: string];
}>();

const trackPage = ref<ContinuityTrackPage | null>(null);
const spanPage = ref<ContinuitySpanPage | null>(null);
const selectedAssetId = ref("");
const search = ref("");
const category = ref<"all" | ProductionAssetCategory>("all");
const episode = ref("all");
const trackOffset = ref(0);
const spanOffset = ref(0);
const loadingTracks = ref(false);
const loadingSpans = ref(false);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let trackRequest = 0;
let spanRequest = 0;

const episodes = computed(() => [...new Set(props.index.items.filter((item) => item.type === "unit" && item.episode).map((item) => item.episode as number))].sort((a, b) => a - b));
const itemMap = computed(() => new Map(props.index.items.map((item) => [item.id, item])));
const selectedTrack = computed(() => spanPage.value?.track ?? trackPage.value?.items.find((track) => track.assetId === selectedAssetId.value));
const selectedAssetItem = computed(() => selectedTrack.value ? assetItem(selectedTrack.value.workItemId) : undefined);
const maximumEpisodeCount = computed(() => Math.max(1, ...Object.values(selectedTrack.value?.episodeSpanCounts ?? {})));

onMounted(() => void loadTracks());
onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });

watch([category, episode], () => {
  trackOffset.value = 0;
  spanOffset.value = 0;
  void loadTracks();
});
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    trackOffset.value = 0;
    spanOffset.value = 0;
    void loadTracks();
  }, 180);
});
watch(() => props.index.scannedAt, () => void loadTracks());

async function loadTracks() {
  const request = ++trackRequest;
  loadingTracks.value = true;
  try {
    const page = await window.canvasApi.listContinuityTracks(props.projectRoot, {
      category: category.value === "all" ? undefined : category.value,
      search: search.value || undefined,
      episode: episode.value === "all" ? undefined : Number(episode.value),
      offset: trackOffset.value,
      limit: TRACK_LIMIT,
    });
    if (request !== trackRequest) return;
    trackPage.value = page;
    if (!page.available || !page.items.length) {
      selectedAssetId.value = "";
      spanPage.value = null;
      return;
    }
    if (!page.items.some((track) => track.assetId === selectedAssetId.value)) selectedAssetId.value = page.items[0]!.assetId;
    await loadSpans();
  } catch (error) {
    if (request === trackRequest) emit("failed", message(error));
  } finally {
    if (request === trackRequest) loadingTracks.value = false;
  }
}

async function loadSpans() {
  if (!selectedAssetId.value) { spanPage.value = null; return; }
  const request = ++spanRequest;
  loadingSpans.value = true;
  try {
    const page = await window.canvasApi.getContinuitySpans(props.projectRoot, selectedAssetId.value, {
      episode: episode.value === "all" ? undefined : Number(episode.value),
      offset: spanOffset.value,
      limit: SPAN_LIMIT,
    });
    if (request === spanRequest) spanPage.value = page;
  } catch (error) {
    if (request === spanRequest) emit("failed", message(error));
  } finally {
    if (request === spanRequest) loadingSpans.value = false;
  }
}

function selectTrack(assetId: string) {
  if (selectedAssetId.value === assetId) return;
  selectedAssetId.value = assetId;
  spanOffset.value = 0;
  spanPage.value = null;
  void loadSpans();
}

function moveTrackPage(direction: -1 | 1) {
  trackOffset.value = Math.max(0, trackOffset.value + direction * TRACK_LIMIT);
  spanOffset.value = 0;
  void loadTracks();
}

function moveSpanPage(direction: -1 | 1) {
  spanOffset.value = Math.max(0, spanOffset.value + direction * SPAN_LIMIT);
  void loadSpans();
}

function openUnit(entry: MaterializedContinuitySpan) {
  const item = itemMap.value.get(entry.unitItemId);
  if (!item || item.type !== "unit") {
    emit("failed", `连续性跨度引用的单元不存在：${entry.unitItemId}`);
    return;
  }
  emit("openUnit", { unitItemId: entry.unitItemId, episode: entry.episodeNumber });
}

function assetItem(workItemId: string): WorkItem | undefined { return itemMap.value.get(workItemId); }
function categoryLabel(value: ProductionAssetCategory): string { return ({ character: "角色", scene: "场景", prop: "道具" } as const)[value]; }
function pad(value: number, length = 2): string { return String(value).padStart(length, "0"); }
function episodeCount(value: number): number { return selectedTrack.value?.episodeSpanCounts[`EP${pad(value)}`] ?? 0; }
function densityStyle(count: number): Record<string, string> { return { transform: `scaleY(${count ? Math.max(.18, count / maximumEpisodeCount.value) : .04})` }; }
function appearanceRange(track: ContinuityTrackSummary): string {
  if (!track.firstAppearance || !track.lastAppearance) return "暂无出场";
  return `${track.firstAppearance.episode} U${pad(track.firstAppearance.unitSequence, 3)} → ${track.lastAppearance.episode} U${pad(track.lastAppearance.unitSequence, 3)}`;
}
function shortVersion(value: string): string { return value.length > 28 ? `${value.slice(0, 25)}…` : value; }
function pageLabel(offset: number, limit: number, total: number): string { return `${Math.floor(offset / limit) + 1} / ${Math.max(1, Math.ceil(total / limit))}`; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
</script>

<style scoped>
.continuity-view { height: 100%; min-width: 0; display: grid; grid-template-rows: 92px 54px minmax(0,1fr); overflow: hidden; background: #11120f; color: #e8e6df; }
.continuity-header { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 0 26px; border-bottom: 1px solid #30322c; background: #151613; }
.continuity-header h2 { margin: 6px 0 3px; font-size: 19px; }.continuity-header p { margin: 0; color: #83867b; font-size: 10px; }
.continuity-metrics { display: flex; align-items: center; }.continuity-metrics div { min-width: 92px; padding-left: 18px; border-left: 1px solid #30322c; }.continuity-metrics span,.continuity-metrics b { display: block; }.continuity-metrics span { color: #6f7269; font-size: 8px; }.continuity-metrics b { margin-top: 5px; font: 12px Menlo,monospace; }
.continuity-toolbar { display: flex; align-items: center; gap: 9px; padding: 0 26px; border-bottom: 1px solid #2b2d27; background: #131410; }.continuity-toolbar select { height: 31px; min-width: 112px; border: 1px solid #35372f; background: #1b1c18; color: #c5c6bd; padding: 0 8px; }
.continuity-search { width: min(320px,34vw); height: 31px; display: flex; align-items: center; gap: 8px; padding: 0 9px; border: 1px solid #35372f; color: #73766d; background: #1b1c18; }.continuity-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: #eee; font-size: 9px; }
.store-identity { margin-left: auto; color: #697467; font: 8px Menlo,monospace; }.store-identity.unavailable { color: #9a6b5d; }
.continuity-body { min-height: 0; display: grid; grid-template-columns: 310px minmax(0,1fr); }.track-rail { min-height: 0; display: flex; flex-direction: column; border-right: 1px solid #30322c; background: #151613; }.track-list { min-height: 0; flex: 1; overflow: auto; }
.track-list > button { width: 100%; min-height: 72px; display: grid; grid-template-columns: 42px minmax(0,1fr) auto; align-items: center; gap: 10px; padding: 9px 12px; border: 0; border-bottom: 1px solid #292b25; border-left: 2px solid transparent; background: transparent; text-align: left; cursor: pointer; }.track-list > button:hover { background: #191a17; }.track-list > button.active { border-left-color: #d7af55; background: #1d1e1a; }
.track-list figure { width: 42px; height: 52px; margin: 0; display: grid; place-items: center; overflow: hidden; background: #10110e; color: #77704f; font: 8px Menlo,monospace; }.track-list img { width: 100%; height: 100%; object-fit: cover; }.track-list div { min-width: 0; }.track-list div span,.track-list div b,.track-list div small { display: block; }.track-list div span { color: #d7af55; font-size: 7px; }.track-list div b { margin-top: 5px; overflow: hidden; font-size: 10px; white-space: nowrap; text-overflow: ellipsis; }.track-list div small { margin-top: 6px; color: #6c6f66; font-size: 8px; }.track-list em { color: #827d70; font-size: 7px; font-style: normal; }.track-list em.locked { color: #d7af55; }
.track-detail { min-width: 0; min-height: 0; position: relative; overflow: auto; padding: 0 26px 70px; background: #11120f; }.track-heading { position: sticky; top: 0; z-index: 5; min-width: 760px; min-height: 90px; display: flex; align-items: center; justify-content: space-between; gap: 20px; border-bottom: 1px solid #30322c; background: rgba(17,18,15,.97); backdrop-filter: blur(10px); }.track-heading span { color: #d7af55; font-size: 8px; letter-spacing: .08em; }.track-heading h3 { margin: 6px 0 4px; font-size: 17px; }.track-heading p { margin: 0; color: #777a70; font-size: 8px; }.track-state { padding-left: 16px; border-left: 1px solid #30322c; text-align: right; }.track-state b,.track-state small { display: block; }.track-state b { font-size: 9px; }.track-state small { margin-top: 6px; color: #8d805d; font-size: 7px; }
.episode-density { min-width: 920px; height: 70px; display: grid; grid-template-columns: 54px repeat(32,minmax(25px,1fr)); gap: 1px; padding: 10px 0; border-bottom: 1px solid #2b2d27; }.episode-density button { min-width: 0; position: relative; display: grid; grid-template-rows: auto 1fr auto; justify-items: center; gap: 3px; padding: 4px 2px; overflow: hidden; border: 0; background: #161713; color: #575a51; cursor: pointer; }.episode-density button:hover,.episode-density button.active { background: #27251d; color: #d7af55; }.episode-density button.occupied { color: #a79a73; }.episode-density span { font: 6px Menlo,monospace; }.episode-density b { font: 7px Menlo,monospace; }.episode-density i { width: 60%; height: 100%; transform-origin: bottom; background: #d7af55; opacity: .62; }
.span-table { min-width: 760px; }.span-table > header,.span-row { display: grid; grid-template-columns: minmax(145px,.8fr) minmax(150px,.9fr) minmax(220px,1.35fr) minmax(150px,.8fr) 84px; align-items: center; gap: 14px; }.span-table > header { height: 36px; color: #5f6259; font-size: 7px; border-bottom: 1px solid #30322c; }.span-row { width: 100%; min-height: 72px; padding: 8px 0; border: 0; border-bottom: 1px solid #292b25; background: transparent; color: #d8d7d0; text-align: left; cursor: pointer; }.span-row:hover { background: #181916; }.span-row b,.span-row small { display: block; }.span-row b { font-size: 9px; }.span-row small { margin-top: 5px; color: #74776e; font-size: 7px; line-height: 1.45; }.assets-cell small:first-child { margin-top: 0; }.version-cell small { font-family: Menlo,monospace; }.open-cell { display: flex; align-items: center; justify-content: flex-end; gap: 5px; color: #d7af55; font-size: 8px; }
.pager { flex: 0 0 38px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 10px; border-top: 1px solid #30322c; background: #151613; }.pager button { min-width: 72px; height: 25px; display: flex; align-items: center; justify-content: center; gap: 4px; border: 1px solid #383a33; background: transparent; color: #aaa; font-size: 7px; cursor: pointer; }.pager button:disabled { color: #41443c; cursor: default; }.pager span { color: #777a70; font: 7px Menlo,monospace; }.span-pager { position: sticky; bottom: 0; margin: 0 -26px; padding: 0 26px; }
.continuity-empty { min-height: 260px; display: grid; place-content: center; justify-items: center; gap: 10px; color: #62655c; font-size: 9px; }.continuity-empty.compact { flex: 1; min-height: 160px; padding: 20px; text-align: center; }.continuity-empty.embedded { min-height: 180px; }.spinning { animation: spin .85s linear infinite; }
@media (max-width: 1280px) { .continuity-header p,.continuity-metrics div:last-child { display: none; }.continuity-body { grid-template-columns: 270px minmax(0,1fr); }.track-list > button { grid-template-columns: 36px minmax(0,1fr); }.track-list figure { width: 36px; height: 46px; }.track-list em { display: none; } }
</style>
