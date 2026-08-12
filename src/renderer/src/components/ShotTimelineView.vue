<template>
  <section class="timeline-workspace">
    <header class="timeline-header">
      <div>
        <span class="eyebrow">镜头时间线</span>
        <h2>15 秒参考板编排</h2>
        <p>一个单元最多 6 镜，累计不超过 15 秒。顺序与时长写入项目侧车，不改动原素材。</p>
      </div>
      <div class="timeline-header-actions">
        <span v-if="active" :class="['timeline-verdict', { invalid: !localValid }]">
          {{ active.shots.length }} 镜 · {{ totalDuration.toFixed(2) }} 秒
        </span>
        <button class="ghost-button" type="button" :disabled="!active || saving" @click="saveTimeline">
          <Save :size="15" /> {{ saving ? "保存中" : "保存编排" }}
        </button>
        <button class="ghost-button" type="button" :disabled="!active?.shots.length || !localValid || queuing" @click="enqueueShots">
          <ListPlus :size="15" /> {{ queuing ? "加入中" : "加入图片队列" }}
        </button>
        <button class="primary-button" type="button" :disabled="!active?.shots.length || !localValid || creating" @click="createPack">
          <PackagePlus :size="15" /> {{ creating ? "创建中" : "创建原镜头任务包" }}
        </button>
      </div>
    </header>

    <div class="timeline-body">
      <aside class="unit-rail">
        <div class="unit-filter">
          <select v-model="episodeFilter">
            <option value="all">全部分集</option>
            <option v-for="episode in episodes" :key="episode" :value="String(episode)">EP{{ pad(episode) }}</option>
          </select>
          <label><input v-model="onlyWithShots" type="checkbox" /> 仅有原镜头</label>
        </div>
        <div class="unit-list">
          <button
            v-for="timeline in filteredTimelines"
            :key="timeline.unitId"
            type="button"
            :class="{ active: timeline.unitId === activeUnitId, invalid: !timeline.valid }"
            @click="selectUnit(timeline.unitId)">
            <span>EP{{ pad(timeline.episode) }} · U{{ pad(timeline.unit, 3) }}</span>
            <b>{{ timeline.title }}</b>
            <small>{{ timeline.shots.length }} 镜 · {{ timeline.totalDurationSeconds.toFixed(2) }}s</small>
          </button>
        </div>
      </aside>

      <main class="timeline-stage">
        <div v-if="loading" class="timeline-empty"><LoaderCircle class="spinning" :size="24" /><span>正在建立原镜头父子关系…</span></div>
        <div v-else-if="!active" class="timeline-empty"><Rows3 :size="28" /><span>当前筛选下没有 15 秒单元</span></div>
        <template v-else>
          <header class="unit-heading">
            <div><span>EP{{ pad(active.episode) }} · 15s {{ pad(active.unit, 3) }}</span><h3>{{ active.title }}</h3></div>
            <div class="constraint-strip">
              <span :class="{ fail: active.shots.length > 6 }">镜头 {{ active.shots.length }}/6</span>
              <span :class="{ fail: totalDuration > 15.001 }">时长 {{ totalDuration.toFixed(2) }}/15s</span>
            </div>
          </header>

          <div v-if="localIssues.length" class="timeline-issues"><CircleAlert :size="14" /> {{ localIssues.join("；") }}</div>
          <div v-else class="timeline-ready"><CircleCheck :size="14" /> 编排满足 15 秒参考板约束，可创建同单元任务包</div>

          <div class="filmstrip" :style="filmstripColumns">
            <article
              v-for="(entry, index) in active.shots"
              :key="entry.item.id"
              :class="['shot-clip', { selected: entry.item.id === selectedShotId }]"
              @click="selectedShotId = entry.item.id">
              <figure>
                <img v-if="entry.item.thumbnailPath" loading="lazy" decoding="async" :src="assetUrl(entry.item.thumbnailPath)" :alt="`${entry.item.title} 镜头缩略图`" />
                <span v-else><ImageOff :size="20" /> 暂无画面</span>
                <em>{{ index + 1 }}</em>
              </figure>
              <div class="clip-copy">
                <span>原镜头 {{ entry.item.shot ?? index + 1 }}</span>
                <b>{{ entry.item.title }}</b>
                <small :class="statusClass(entry.item.status)">{{ entry.item.status }}</small>
              </div>
              <footer>
                <label><input v-model.number="entry.timing.durationSeconds" type="number" min="0.1" max="15" step="0.1" @click.stop /> 秒</label>
                <div>
                  <button type="button" title="向前移动" :disabled="index === 0" @click.stop="move(index, -1)"><ChevronLeft :size="14" /></button>
                  <button type="button" title="向后移动" :disabled="index === active.shots.length - 1" @click.stop="move(index, 1)"><ChevronRight :size="14" /></button>
                </div>
              </footer>
            </article>
          </div>

          <div v-if="!active.shots.length" class="timeline-empty embedded"><Rows3 :size="24" /><span>该单元尚未扫描到原镜头子目录</span></div>

          <section v-if="selectedShot" class="shot-inspector">
            <div class="shot-inspector-title">
              <span>当前原镜头</span><h3>{{ selectedShot.item.title }}</h3><p>{{ selectedShot.item.nextAction }}</p>
            </div>
            <div class="shot-facts">
              <div><span>父单元</span><b>{{ selectedShot.item.parentId }}</b></div>
              <div><span>状态</span><b>{{ selectedShot.item.status }}</b></div>
              <div><span>素材版本</span><b>{{ selectedShot.item.artifactIds.length }}</b></div>
            </div>
            <p class="shot-excerpt">{{ selectedShot.item.infoExcerpt || "该镜头暂无可读说明，仍可从真实文件路径继续制作。" }}</p>
            <div class="shot-path">{{ selectedShot.item.infoPath || selectedShot.item.sourcePaths[0] || "未发现制作文档" }}</div>
            <div class="shot-inspector-actions">
              <button v-if="selectedShot.item.infoPath" type="button" @click="openPath(selectedShot.item.infoPath)"><FileText :size="14" /> 打开提示词</button>
              <button v-if="selectedShot.item.sourcePaths[0]" type="button" @click="reveal(selectedShot.item.sourcePaths[0])"><FolderOpen :size="14" /> 定位文件</button>
            </div>
          </section>
        </template>
      </main>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, FileText, FolderOpen, ImageOff, ListPlus, LoaderCircle, PackagePlus, Rows3, Save } from "lucide-vue-next";
import type { ProjectIndex, UnitTimeline } from "@core/types";
import { assetUrl, statusClass } from "../utils";

const props = defineProps<{ projectRoot: string; index: ProjectIndex }>();
const emit = defineEmits<{ taskCreated: [taskId: string]; queued: [count: number]; changed: [message: string]; failed: [message: string] }>();
const timelines = ref<UnitTimeline[]>([]);
const activeUnitId = ref("");
const selectedShotId = ref("");
const episodeFilter = ref("all");
const onlyWithShots = ref(true);
const loading = ref(true);
const saving = ref(false);
const creating = ref(false);
const queuing = ref(false);

const episodes = computed(() => [...new Set(timelines.value.map((timeline) => timeline.episode))].sort((a, b) => a - b));
const filteredTimelines = computed(() => timelines.value.filter((timeline) =>
  (episodeFilter.value === "all" || timeline.episode === Number(episodeFilter.value)) && (!onlyWithShots.value || timeline.shots.length > 0),
));
const active = computed(() => timelines.value.find((timeline) => timeline.unitId === activeUnitId.value) ?? null);
const selectedShot = computed(() => active.value?.shots.find((entry) => entry.item.id === selectedShotId.value) ?? active.value?.shots[0] ?? null);
const totalDuration = computed(() => Math.round((active.value?.shots.reduce((sum, entry) => sum + Number(entry.timing.durationSeconds || 0), 0) ?? 0) * 100) / 100);
const localIssues = computed(() => {
  if (!active.value) return [];
  const issues: string[] = [];
  if (active.value.shots.length > 6) issues.push(`镜头数 ${active.value.shots.length} 超过上限 6`);
  if (totalDuration.value > 15.001) issues.push(`累计时长 ${totalDuration.value.toFixed(2)} 秒超过 15 秒`);
  if (active.value.shots.some((entry) => !Number.isFinite(Number(entry.timing.durationSeconds)) || Number(entry.timing.durationSeconds) <= 0)) issues.push("存在无效镜头时长");
  return issues;
});
const localValid = computed(() => localIssues.value.length === 0);
const filmstripColumns = computed(() => ({ gridTemplateColumns: `repeat(${Math.max(1, active.value?.shots.length ?? 1)}, minmax(176px, 1fr))` }));

watch(filteredTimelines, (values) => {
  if (!values.some((timeline) => timeline.unitId === activeUnitId.value)) selectUnit(values[0]?.unitId ?? "");
});
watch(() => props.index.scannedAt, () => void load());
onMounted(() => void load());

async function load() {
  loading.value = true;
  try {
    timelines.value = await window.canvasApi.getUnitTimelines(props.projectRoot);
    if (!activeUnitId.value || !timelines.value.some((timeline) => timeline.unitId === activeUnitId.value)) {
      activeUnitId.value = timelines.value.find((timeline) => timeline.shots.length)?.unitId ?? timelines.value[0]?.unitId ?? "";
    }
    selectUnit(activeUnitId.value);
  } catch (error) { emit("failed", message(error)); }
  finally { loading.value = false; }
}
function selectUnit(unitId: string) {
  activeUnitId.value = unitId;
  selectedShotId.value = timelines.value.find((timeline) => timeline.unitId === unitId)?.shots[0]?.item.id ?? "";
}
function move(index: number, offset: number) {
  if (!active.value) return;
  const target = index + offset;
  if (target < 0 || target >= active.value.shots.length) return;
  const [entry] = active.value.shots.splice(index, 1);
  if (entry) active.value.shots.splice(target, 0, entry);
}
async function saveTimeline() {
  if (!active.value || !localValid.value) return false;
  saving.value = true;
  try {
    const saved = await window.canvasApi.saveUnitTimeline(props.projectRoot, active.value.unitId, active.value.shots.map((entry, order) => ({ ...entry.timing, shotId: entry.item.id, order })));
    timelines.value.splice(timelines.value.findIndex((timeline) => timeline.unitId === saved.unitId), 1, saved);
    emit("changed", "镜头顺序与时长已写入项目侧车");
    return true;
  } catch (error) { emit("failed", message(error)); return false; }
  finally { saving.value = false; }
}
async function createPack() {
  if (!active.value || !localValid.value) return;
  creating.value = true;
  try {
    if (!await saveTimeline()) return;
    const pack = await window.canvasApi.createShotTaskPack(props.projectRoot, active.value.unitId, "autopilot");
    emit("taskCreated", pack.task.id);
  } catch (error) { emit("failed", message(error)); }
  finally { creating.value = false; }
}
async function enqueueShots() {
  if (!active.value || !localValid.value) return;
  queuing.value = true;
  try {
    if (!await saveTimeline()) return;
    const jobs = await window.canvasApi.enqueueGeneration(props.projectRoot, { itemIds: active.value.shots.map((entry) => entry.item.id), kind: "image" });
    emit("queued", jobs.length);
  } catch (error) { emit("failed", message(error)); }
  finally { queuing.value = false; }
}
function pad(value: number, length = 2) { return String(value).padStart(length, "0"); }
function openPath(path: string) { void window.canvasApi.openPath(path); }
function reveal(path: string) { void window.canvasApi.showInFolder(path); }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
</script>

<style scoped>
.timeline-workspace { height: 100%; display: grid; grid-template-rows: 94px minmax(0,1fr); background: #11120f; color: #e8e6df; }
.timeline-header { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 0 26px; border-bottom: 1px solid #30322c; background: #151613; }
.timeline-header h2 { margin: 6px 0 3px; font-size: 19px; }.timeline-header p { margin: 0; color: #83867b; font-size: 10px; }.timeline-header-actions { display: flex; align-items: center; gap: 10px; }.timeline-header-actions button { white-space: nowrap; }
.timeline-verdict { padding: 7px 9px; border: 1px solid #3d4938; color: #8eb17c; font: 9px Menlo,monospace; }.timeline-verdict.invalid { border-color: #5b3730; color: #d07865; }
.timeline-body { min-height: 0; display: grid; grid-template-columns: 232px minmax(0,1fr); }.unit-rail { min-height: 0; border-right: 1px solid #30322c; background: #151613; }.unit-filter { height: 72px; display: grid; align-content: center; gap: 8px; padding: 0 13px; border-bottom: 1px solid #292b25; }.unit-filter select { height: 30px; border: 1px solid #35372f; background: #1c1d19; color: #ddd; }.unit-filter label { color: #777a70; font-size: 9px; }.unit-list { height: calc(100% - 72px); overflow: auto; }.unit-list button { width: 100%; padding: 12px 13px; border: 0; border-bottom: 1px solid #282a24; border-left: 2px solid transparent; background: transparent; color: #d8d6cf; text-align: left; cursor: pointer; }.unit-list button:hover { background: #191a17; }.unit-list button.active { border-left-color: #d7af55; background: #1e1f1b; }.unit-list button.invalid { box-shadow: inset -2px 0 #9c5144; }.unit-list span,.unit-list b,.unit-list small { display: block; }.unit-list span { color: #d7af55; font-size: 8px; letter-spacing: .05em; }.unit-list b { margin-top: 5px; overflow: hidden; color: #c8c6bf; font-size: 9px; white-space: nowrap; text-overflow: ellipsis; }.unit-list small { margin-top: 6px; color: #64675e; font-size: 8px; }
.timeline-stage { min-width: 0; overflow: auto; padding: 24px 26px 70px; background: radial-gradient(circle at 45% 0%,#1a1b17 0,#11120f 52%); }.unit-heading { display: flex; align-items: end; justify-content: space-between; min-width: 700px; padding-bottom: 15px; border-bottom: 1px solid #30322c; }.unit-heading span { color: #d7af55; font-size: 8px; letter-spacing: .08em; }.unit-heading h3 { max-width: 800px; margin: 6px 0 0; font-size: 17px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.constraint-strip { display: flex; gap: 8px; }.constraint-strip span { padding: 6px 8px; border: 1px solid #3c4436; color: #8fab7d; font: 8px Menlo,monospace; }.constraint-strip span.fail { border-color: #5b3730; color: #d07865; }
.timeline-issues,.timeline-ready { min-width: 700px; height: 36px; display: flex; align-items: center; gap: 7px; font-size: 9px; }.timeline-issues { color: #d07865; }.timeline-ready { color: #769b67; }
.filmstrip { min-width: 700px; display: grid; gap: 1px; padding: 8px 8px 13px; overflow: auto; background: repeating-linear-gradient(90deg,#080906 0 12px,#252720 12px 20px); border-top: 8px solid #0a0b08; border-bottom: 8px solid #0a0b08; }.shot-clip { min-width: 176px; border: 1px solid #34362e; background: #171815; cursor: pointer; }.shot-clip.selected { border-color: #d7af55; box-shadow: 0 0 0 1px #d7af55; }.shot-clip figure { position: relative; height: 156px; margin: 0; overflow: hidden; background: #0c0d0b; }.shot-clip figure img { width: 100%; height: 100%; object-fit: cover; }.shot-clip figure > span { height: 100%; display: grid; place-content: center; justify-items: center; gap: 6px; color: #55584f; font-size: 8px; }.shot-clip figure em { position: absolute; top: 7px; left: 7px; width: 20px; height: 20px; display: grid; place-items: center; background: #d7af55; color: #17130a; font: bold 9px Menlo,monospace; }.clip-copy { height: 70px; padding: 10px; }.clip-copy span,.clip-copy b,.clip-copy small { display: block; }.clip-copy span { color: #d7af55; font-size: 7px; }.clip-copy b { margin-top: 6px; overflow: hidden; font-size: 9px; white-space: nowrap; text-overflow: ellipsis; }.clip-copy small { margin-top: 7px; color: #7b7e74; font-size: 8px; }.shot-clip footer { height: 38px; display: flex; align-items: center; justify-content: space-between; padding: 0 7px 0 10px; border-top: 1px solid #2c2e28; }.shot-clip footer label { color: #74776d; font-size: 8px; }.shot-clip footer input { width: 48px; border: 0; border-bottom: 1px solid #4a4d42; outline: 0; background: transparent; color: #e4e1d8; font: 9px Menlo,monospace; }.shot-clip footer div { display: flex; }.shot-clip footer button { width: 25px; height: 24px; display: grid; place-items: center; border: 0; background: transparent; color: #8b8e83; cursor: pointer; }.shot-clip footer button:disabled { color: #35372f; cursor: default; }
.shot-inspector { min-width: 700px; margin-top: 20px; display: grid; grid-template-columns: minmax(240px,.8fr) minmax(320px,1.2fr) auto; gap: 22px; padding: 19px 0; border-top: 1px solid #34362e; border-bottom: 1px solid #292b25; }.shot-inspector-title > span { color: #d7af55; font-size: 8px; }.shot-inspector-title h3 { margin: 6px 0; font-size: 13px; }.shot-inspector-title p { margin: 0; color: #777a70; font-size: 8px; }.shot-facts { display: grid; grid-template-columns: repeat(3,1fr); gap: 1px; background: #2b2d27; }.shot-facts div { min-width: 0; padding: 10px; background: #171815; }.shot-facts span,.shot-facts b { display: block; }.shot-facts span { color: #696c63; font-size: 7px; }.shot-facts b { margin-top: 6px; overflow: hidden; font-size: 8px; white-space: nowrap; text-overflow: ellipsis; }.shot-excerpt { grid-column: 1/3; margin: 0; color: #9b9d94; font-size: 9px; line-height: 1.6; white-space: pre-line; }.shot-path { grid-column: 1/3; overflow: hidden; color: #5f6259; font: 8px Menlo,monospace; white-space: nowrap; text-overflow: ellipsis; }.shot-inspector-actions { grid-row: 1/4; grid-column: 3; display: grid; align-content: start; gap: 7px; }.shot-inspector-actions button { height: 30px; display: flex; align-items: center; gap: 7px; padding: 0 10px; border: 1px solid #3b3d35; background: transparent; color: #aaa; font-size: 8px; cursor: pointer; }
.timeline-empty { height: 100%; display: grid; place-content: center; justify-items: center; gap: 10px; color: #60635a; font-size: 10px; }.timeline-empty.embedded { height: 240px; min-width: 700px; }.spinning { animation: spin .8s linear infinite; }
@media (max-width: 1280px) { .timeline-header p { display: none; }.timeline-header-actions .timeline-verdict { display: none; } }
.unit-list button { content-visibility: auto; contain-intrinsic-size: auto 70px; }
</style>
