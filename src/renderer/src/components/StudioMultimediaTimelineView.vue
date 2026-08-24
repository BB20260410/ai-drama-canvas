<template>
  <section
    class="multimedia-timeline"
    data-testid="studio-multimedia-timeline-view"
    :aria-busy="unitsLoading || timelineLoading || bindBusy">
    <header class="timeline-header">
      <div>
        <span class="eyebrow">四媒体时间线</span>
        <h2>剧本、图片、视频与音频</h2>
        <p>只读取当前选中单元；所有轨道均来自正式投影，缺失内容会明确标出。</p>
      </div>
      <button
        type="button"
        class="refresh-button"
        data-testid="multimedia-refresh"
        :disabled="unitsLoading || timelineLoading || bindBusy || !projectRoot"
        :title="bindBusy ? bindBusyTitle : undefined"
        @click="refresh">
        {{ bindBusy ? (bindStage === "import" ? "导入中" : bindStage === "attach" ? "绑定中" : "处理中") : unitsLoading || timelineLoading ? "读取中" : "刷新" }}
      </button>
    </header>

    <form
      class="scope-bar"
      data-testid="multimedia-scope-filter"
      @submit.prevent="applyScope">
      <label>
        <span>季</span>
        <input
          v-model.trim="draftSeason"
          data-testid="multimedia-season-filter"
          autocomplete="off"
          placeholder="全部季" />
      </label>
      <label>
        <span>集</span>
        <input
          v-model.trim="draftEpisode"
          data-testid="multimedia-episode-filter"
          autocomplete="off"
          placeholder="全部集" />
      </label>
      <label class="unit-search">
        <span>当前页单元筛选</span>
        <input
          v-model.trim="unitFilter"
          data-testid="multimedia-unit-filter"
          autocomplete="off"
          placeholder="单元 ID 或标题" />
      </label>
      <button type="submit" :disabled="unitsLoading || bindBusy || !projectRoot" :title="bindBusy ? bindBusyTitle : undefined">应用范围</button>
      <button
        type="button"
        class="quiet-button"
        :disabled="unitsLoading || bindBusy || (!draftSeason && !draftEpisode && !unitFilter)"
        :title="bindBusy ? bindBusyTitle : undefined"
        @click="clearScope">
        清除
      </button>
    </form>

    <p
      v-if="unitsError"
      class="error-banner"
      data-testid="multimedia-units-error"
      role="alert">
      {{ unitsError }}
    </p>

    <div class="timeline-layout">
      <aside class="unit-rail" aria-label="15 秒单元">
        <header>
          <div>
            <strong>15 秒单元</strong>
            <small>每页最多 {{ PAGE_LIMIT }} 个</small>
          </div>
          <span>{{ pagePositionLabel }}</span>
        </header>

        <div
          v-if="unitsLoading"
          class="rail-state"
          data-testid="multimedia-units-loading">
          正在读取单元…
        </div>
        <ul
          v-else
          class="unit-list"
          data-testid="multimedia-unit-list">
          <li v-for="unit in filteredUnits" :key="unit.id">
            <button
              type="button"
              :class="{ active: unit.id === selectedUnitId }"
              :data-unit-id="unit.id"
              :disabled="bindBusy"
              :title="bindBusy ? bindBusyTitle : undefined"
              @click="selectUnit(unit.id)">
              <span>{{ unit.season }} / {{ unit.episode }} · U{{ pad(unit.sequence, 3) }}</span>
              <strong>{{ unit.title }}</strong>
              <small>
                {{ formatTime(unit.episodeStartSeconds) }}–{{ formatTime(unit.episodeEndSeconds) }}
                · {{ unit.panelCount }} 格
              </small>
            </button>
          </li>
          <li v-if="!filteredUnits.length" class="rail-empty" data-testid="multimedia-units-empty">
            {{ unitFilter ? "当前页没有匹配单元" : "当前范围没有生产单元" }}
          </li>
        </ul>

        <footer class="pager" data-testid="multimedia-unit-pager">
          <button type="button" :disabled="!cursorHistory.length || unitsLoading || bindBusy" :title="bindBusy ? bindBusyTitle : undefined" @click="previousPage">
            上一页
          </button>
          <button type="button" :disabled="!unitPage?.nextCursor || unitsLoading || bindBusy" :title="bindBusy ? bindBusyTitle : undefined" @click="nextPage">
            下一页
          </button>
        </footer>
      </aside>

      <main class="timeline-stage">
        <div
          v-if="timelineLoading"
          class="stage-state"
          data-testid="multimedia-timeline-loading">
          <span class="loading-mark" aria-hidden="true"></span>
          <strong>正在核验当前单元四轨投影</strong>
          <small>只读取这一个单元，不批量拉取媒体。</small>
        </div>

        <p
          v-else-if="timelineError"
          class="stage-state error"
          data-testid="multimedia-timeline-error"
          role="alert">
          {{ timelineError }}
        </p>

        <div
          v-else-if="!selectedUnitId"
          class="stage-state"
          data-testid="multimedia-no-selection">
          <strong>请选择一个单元</strong>
          <small>选中后才会读取对应剧本与媒体轨。</small>
        </div>

        <div
          v-else-if="!timeline"
          class="stage-state"
          data-testid="multimedia-projection-empty">
          <strong>该单元没有可用时间线投影</strong>
          <small>界面不会用候选媒体或推测数据补位。</small>
        </div>

        <template v-else>
          <header class="unit-heading" data-testid="multimedia-unit-heading">
            <div>
              <span>{{ timeline.unit.season }} / {{ timeline.unit.episode }} · U{{ pad(timeline.unit.sequence, 3) }}</span>
              <h3>{{ timeline.unit.title }}</h3>
              <p>
                单元 {{ formatTime(0) }}–{{ formatTime(timeline.unit.durationSeconds) }}
                · 分集 {{ formatTime(timeline.unit.episodeStartSeconds) }}–{{ formatTime(timeline.unit.episodeEndSeconds) }}
                · revision {{ timeline.unit.revision }}
              </p>
            </div>
            <div class="availability" data-testid="multimedia-availability">
              <span class="ready">剧本 {{ availabilityLabel(timeline.availability.script) }}</span>
              <span :class="availabilityClass(timeline.availability.storyboard)">
                图片 {{ availabilityLabel(timeline.availability.storyboard) }}
              </span>
              <span :class="availabilityClass(timeline.availability.video)">
                视频 {{ availabilityLabel(timeline.availability.video) }}
              </span>
              <span :class="availabilityClass(timeline.availability.audio)">
                音频 {{ availabilityLabel(timeline.availability.audio) }}
              </span>
            </div>
          </header>

          <section class="playback-deck" data-testid="multimedia-playback-deck">
            <header>
              <div>
                <strong>当前单元轻量播放</strong>
                <small>只加载你主动选择的一条正式视频或音频；切换单元立即卸载。</small>
              </div>
              <label v-if="playableEntries.length">
                <span>播放素材</span>
                <select v-model="selectedPlaybackId" data-testid="multimedia-playback-select">
                  <option value="" disabled>请选择正式媒体</option>
                  <option v-for="entry in playableEntries" :key="entry.id" :value="entry.id">
                    {{ entry.label }} · {{ formatRange(entry.startSeconds, entry.endSeconds) }}
                  </option>
                </select>
              </label>
            </header>
            <video
              v-if="selectedPlaybackEntry?.media.mimeType.startsWith('video/')"
              :key="selectedPlaybackEntry.id"
              :src="studioMediaUrl(selectedPlaybackEntry.media.sha256)"
              controls
              preload="metadata"
              data-testid="multimedia-video-player">
              当前桌面运行时不支持该视频格式。
            </video>
            <audio
              v-else-if="selectedPlaybackEntry?.media.mimeType.startsWith('audio/')"
              ref="timelineAudioEl"
              :key="selectedPlaybackEntry.id"
              :class="{ 'audio-blocked': bindBusy }"
              :src="studioMediaUrl(selectedPlaybackEntry.media.sha256)"
              controls
              preload="metadata"
              data-testid="multimedia-audio-player"
              @play="onTimelineAudioPlay">
              当前桌面运行时不支持该音频格式。
            </audio>
            <p v-else class="playback-empty" data-testid="multimedia-playback-empty">
              {{ playableEntries.length
                ? "请选择一条正式视频或音频后播放；未选择时不会加载原媒体。"
                : "当前单元没有正式绑定的视频或音频；不会用候选媒体代替。" }}
            </p>
          </section>

          <section class="media-bind-deck" data-testid="multimedia-media-bind-deck">
            <header>
              <div>
                <strong>导入并绑定正式媒体</strong>
                <small>文件先进入当前工程 CAS，再按单元、区间与轨道角色写入时间线；不会直接引用外部路径。</small>
              </div>
              <button
                type="button"
                data-testid="multimedia-pick-media"
                :disabled="bindBusy || !apiCanBind"
                @click="pickAndImportMedia">
                {{ bindBusy && bindStage === "import" ? "导入中…" : "选择视频或音频" }}
              </button>
            </header>
            <p v-if="!apiCanBind" class="bind-hint">
              当前桌面适配层只提供只读时间线；请更新源码运行时后再导入。
            </p>
            <form
              v-else-if="importedMedia"
              class="media-bind-form"
              data-testid="multimedia-media-bind-form"
              @submit.prevent="attachImportedMedia">
              <div class="imported-media">
                <strong>{{ importedMedia.sourceBasename }}</strong>
                <small>
                  {{ importedMedia.mimeType }} · {{ formatBytes(importedMedia.sizeBytes) }}
                  · SHA {{ shortSha(importedMedia.sha256) }}
                </small>
              </div>
              <label>
                <span>轨道角色</span>
                <select v-model="bindRole" data-testid="multimedia-bind-role">
                  <option v-if="importedMedia.kind === 'video'" value="video">视频</option>
                  <template v-else>
                    <option value="dialogue">对白</option>
                    <option value="music">音乐</option>
                    <option value="sfx">音效</option>
                  </template>
                </select>
              </label>
              <label>
                <span>锚定宫格</span>
                <select v-model.number="bindPanelIndex" data-testid="multimedia-bind-panel">
                  <option :value="0">全单元</option>
                  <option v-for="panel in timeline.panels" :key="panel.id" :value="panel.index">
                    G{{ panel.index }} · {{ panel.title }}
                  </option>
                </select>
              </label>
              <label>
                <span>开始（秒）</span>
                <input
                  v-model.number="bindStartSeconds"
                  data-testid="multimedia-bind-start"
                  type="number"
                  min="0"
                  :max="timeline.unit.durationSeconds"
                  step="0.001" />
              </label>
              <label>
                <span>结束（秒）</span>
                <input
                  v-model.number="bindEndSeconds"
                  data-testid="multimedia-bind-end"
                  type="number"
                  min="0.001"
                  :max="timeline.unit.durationSeconds"
                  step="0.001" />
              </label>
              <label>
                <span>槽位 ID</span>
                <input
                  v-model.trim="bindSlotId"
                  data-testid="multimedia-bind-slot"
                  maxlength="120"
                  autocomplete="off" />
              </label>
              <label class="bind-note">
                <span>备注</span>
                <input
                  v-model.trim="bindNote"
                  data-testid="multimedia-bind-note"
                  maxlength="4000"
                  autocomplete="off"
                  placeholder="可选：来源、台词或审阅说明" />
              </label>
              <button
                type="submit"
                class="bind-submit"
                data-testid="multimedia-attach-media"
                :disabled="bindBusy || !bindFormValid">
                {{ bindBusy && bindStage === "attach" ? "绑定中…" : "绑定到当前单元" }}
              </button>
            </form>
            <p
              v-if="bindMessage"
              class="bind-message"
              :class="{ error: bindFailed }"
              data-testid="multimedia-bind-message"
              :role="bindFailed ? 'alert' : 'status'">
              {{ bindMessage }}
            </p>
          </section>

          <div class="ruler" data-testid="multimedia-time-ruler" aria-label="单元时间尺">
            <span
              v-for="tick in timelineTicks"
              :key="tick"
              :style="{ left: `${percentAt(tick)}%` }">
              {{ formatTime(tick) }}
            </span>
          </div>

          <div class="track-stack">
            <section class="track script-track" data-testid="multimedia-script-track">
              <header>
                <div><span class="track-mark">文</span><strong>剧本</strong></div>
                <small>{{ timeline.panels.length }} 个 panel · {{ shortSha(timeline.script.sha256) }}</small>
              </header>
              <div class="track-entries">
                <article
                  v-for="entry in scriptEntries"
                  :key="entry.id"
                  class="track-entry">
                  <div class="segment-field" aria-hidden="true">
                    <span class="segment script-segment" :style="segmentStyle(entry.startSeconds, entry.endSeconds)">
                      G{{ entry.panelIndex }}
                    </span>
                  </div>
                  <div class="entry-copy">
                    <div class="entry-title">
                      <strong>G{{ entry.panelIndex }} · {{ entry.title }}</strong>
                      <time>{{ formatRange(entry.startSeconds, entry.endSeconds) }}</time>
                    </div>
                    <p>{{ entry.text || entry.visualAction || "该 panel 没有可展示的剧本文本。" }}</p>
                    <small>
                      panel {{ entry.panelId }} · 来源
                      {{ entry.sourceSha256 ? shortSha(entry.sourceSha256) : "缺失" }}
                    </small>
                  </div>
                </article>
                <div v-if="!scriptEntries.length" class="track-empty">
                  当前投影没有 panel；未伪造剧本片段。
                </div>
                <details class="script-source" data-testid="multimedia-script-source">
                  <summary data-testid="multimedia-script-source-summary">查看本单元剧本原文与来源</summary>
                  <p>{{ timeline.script.body }}</p>
                  <small>
                    {{ timeline.script.source }} · {{ timeline.script.sourceVersion }}
                    · {{ shortSha(timeline.script.sha256) }}
                  </small>
                </details>
              </div>
            </section>

            <section class="track image-track" data-testid="multimedia-image-track">
              <header>
                <div><span class="track-mark">图</span><strong>图片</strong></div>
                <small>PASS raw / labeled / storyboard</small>
              </header>
              <div class="track-entries">
                <article
                  v-for="entry in imageEntries"
                  :key="entry.id"
                  class="track-entry">
                  <div class="segment-field" aria-hidden="true">
                    <span class="segment image-segment" :style="segmentStyle(entry.startSeconds, entry.endSeconds)">
                      {{ entry.shortLabel }}
                    </span>
                  </div>
                  <MediaEntryDetails :entry="entry" />
                </article>
                <div v-if="!imageEntries.length" class="track-empty" data-testid="multimedia-image-missing">
                  正式图片缺失：{{ storyboardIssueText }}
                </div>
                <ul v-if="timeline.approvedStoryboard.issues.length" class="inline-issues">
                  <li v-for="issue in timeline.approvedStoryboard.issues" :key="issue">{{ issue }}</li>
                </ul>
              </div>
            </section>

            <section class="track video-track" data-testid="multimedia-video-track">
              <header>
                <div><span class="track-mark">视</span><strong>视频</strong></div>
                <small>{{ videoEntries.length }} 个已绑定片段</small>
              </header>
              <div class="track-entries">
                <article
                  v-for="entry in videoEntries"
                  :key="entry.id"
                  class="track-entry">
                  <div class="segment-field" aria-hidden="true">
                    <span class="segment video-segment" :style="segmentStyle(entry.startSeconds, entry.endSeconds)">
                      VIDEO
                    </span>
                  </div>
                  <MediaEntryDetails :entry="entry" />
                </article>
                <div v-if="!videoEntries.length" class="track-empty" data-testid="multimedia-video-missing">
                  当前 unit revision 未绑定视频。
                </div>
              </div>
            </section>

            <section class="track audio-track" data-testid="multimedia-audio-track">
              <header>
                <div><span class="track-mark">声</span><strong>音频</strong></div>
                <small>{{ audioEntries.length }} 个 dialogue / music / sfx 片段</small>
              </header>
              <div class="track-entries">
                <article
                  v-for="entry in audioEntries"
                  :key="entry.id"
                  class="track-entry">
                  <div class="segment-field" aria-hidden="true">
                    <span
                      class="segment audio-segment"
                      :class="`role-${entry.role}`"
                      :style="segmentStyle(entry.startSeconds, entry.endSeconds)">
                      {{ roleLabel(entry.role) }}
                    </span>
                  </div>
                  <MediaEntryDetails :entry="entry" />
                </article>
                <div v-if="!audioEntries.length" class="track-empty" data-testid="multimedia-audio-missing">
                  当前 unit revision 未绑定对白、音乐或音效。
                </div>
              </div>
            </section>
          </div>

          <section class="gap-register" data-testid="multimedia-gap-register">
            <header>
              <strong>缺失项与派生物状态</strong>
              <small>{{ timeline.gaps.length ? `${timeline.gaps.length} 项` : "无已知缺失" }}</small>
            </header>
            <ul v-if="timeline.gaps.length">
              <li v-for="gap in timeline.gaps" :key="gap.code" :class="{ required: gap.required }">
                <span>{{ gap.required ? "必须" : "可选" }} · {{ gap.media }}</span>
                <p>{{ gap.reason }}</p>
                <code>{{ gap.code }}</code>
              </li>
            </ul>
            <p v-else>Core 未报告正式故事板、视频、音频或派生物缺口。</p>
          </section>
        </template>
      </main>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref, watch, type PropType } from "vue";
import { claimCanvasAudioPlayback, releaseCanvasAudioPlayback } from "../canvas-audio-mutex";
import type {
  StudioMultimediaMediaProjection,
  StudioMultimediaTimelineProjection,
  StudioMultimediaTimelineRole,
} from "@core/studio-multimedia-timeline";
import type {
  StudioProductionUnitListQuery,
  StudioProductionUnitPage,
} from "@core/studio-production";
import {
  findSelectedStudioMultimediaPlaybackEntry,
  retainStudioMultimediaPlaybackSelection,
} from "../studio-multimedia-playback-selection";

const PAGE_LIMIT = 36;

interface StudioMultimediaTimelineApi {
  listUnits(
    projectRoot: string,
    query: StudioProductionUnitListQuery,
  ): Promise<StudioProductionUnitPage>;
  getTimeline(
    projectRoot: string,
    query: { unitId: string },
  ): Promise<StudioMultimediaTimelineProjection | null>;
  pickAndImportMedia?(
    projectRoot: string,
  ): Promise<{
    imported: boolean;
    media?: ImportedTimelineMedia;
  }>;
  attachMedia?(
    projectRoot: string,
    payload: {
      unitId: string;
      unitRevision: number;
      expectedUnitFingerprint: string;
      slotId: string;
      expectedHeadRevision: number;
      panelIndex?: number;
      startSeconds: number;
      endSeconds: number;
      role: StudioMultimediaTimelineRole;
      mediaSha256: string;
      note?: string;
    },
  ): Promise<unknown>;
}

interface ImportedTimelineMedia {
  sha256: string;
  kind: "video" | "audio";
  mimeType: string;
  sizeBytes: number;
  sourceBasename: string;
}

interface MediaEntry {
  id: string;
  shortLabel: string;
  label: string;
  role: StudioMultimediaTimelineRole | "approved-raw" | "approved-labeled";
  panelIndex?: number;
  panelId?: string;
  startSeconds: number;
  endSeconds: number;
  media: StudioMultimediaMediaProjection;
  note: string;
}

const props = withDefaults(defineProps<{
  projectRoot: string;
  api: StudioMultimediaTimelineApi;
  initialSeason?: string;
  initialEpisode?: string;
  initialUnitId?: string;
}>(), {
  initialSeason: "",
  initialEpisode: "",
  initialUnitId: "",
});

const unitPage = ref<StudioProductionUnitPage | null>(null);
const selectedUnitId = ref("");
const timeline = ref<StudioMultimediaTimelineProjection | null>(null);
const appliedSeason = ref(props.initialSeason);
const appliedEpisode = ref(props.initialEpisode);
const draftSeason = ref(props.initialSeason);
const draftEpisode = ref(props.initialEpisode);
const unitFilter = ref("");
const currentCursor = ref<string | undefined>();
const cursorHistory = ref<Array<string | undefined>>([]);
const unitsLoading = ref(false);
const timelineLoading = ref(false);
const unitsError = ref("");
const timelineError = ref("");
const selectedPlaybackId = ref("");
const importedMedia = ref<ImportedTimelineMedia | null>(null);
const bindRole = ref<Exclude<StudioMultimediaTimelineRole, "storyboard">>("video");
const bindPanelIndex = ref(0);
const bindStartSeconds = ref(0);
const bindEndSeconds = ref(0);
const bindSlotId = ref("video-main");
const bindNote = ref("");
const bindBusy = ref(false);
const bindStage = ref<"import" | "attach" | "">("");
const bindMessage = ref("");
const bindFailed = ref(false);
let unitRequest = 0;
let timelineRequest = 0;

const apiCanBind = computed(() =>
  typeof props.api.pickAndImportMedia === "function"
  && typeof props.api.attachMedia === "function");

const bindBusyTitle = computed(() => {
  if (!bindBusy.value) return "";
  if (bindStage.value === "import") return "正在导入媒体，不能换单元、刷新或改范围";
  if (bindStage.value === "attach") return "正在绑定媒体，不能换单元、刷新或改范围";
  return "正在处理媒体，不能换单元、刷新或改范围";
});

const bindFormValid = computed(() => Boolean(
  timeline.value
  && importedMedia.value
  && bindSlotId.value.trim()
  && Number.isFinite(bindStartSeconds.value)
  && Number.isFinite(bindEndSeconds.value)
  && bindStartSeconds.value >= 0
  && bindEndSeconds.value > bindStartSeconds.value
  && bindEndSeconds.value <= timeline.value.unit.durationSeconds
  && (importedMedia.value.kind === "video"
    ? bindRole.value === "video"
    : ["dialogue", "music", "sfx"].includes(bindRole.value)),
));

const filteredUnits = computed(() => {
  const query = unitFilter.value.toLocaleLowerCase("zh-CN");
  if (!query) return unitPage.value?.items ?? [];
  return (unitPage.value?.items ?? []).filter((unit) =>
    unit.id.toLocaleLowerCase("zh-CN").includes(query)
    || unit.title.toLocaleLowerCase("zh-CN").includes(query)
    || `${unit.season}/${unit.episode}/u${pad(unit.sequence, 3)}`.toLocaleLowerCase("zh-CN").includes(query));
});

const pagePositionLabel = computed(() => `第 ${cursorHistory.value.length + 1} 页`);

const scriptEntries = computed(() => timeline.value?.panels.map((panel) => {
  const firstSurface = panel.sourceSurfaces[0];
  return {
    id: panel.id,
    panelId: panel.id,
    panelIndex: panel.index,
    title: panel.title,
    startSeconds: panel.startSeconds,
    endSeconds: panel.endSeconds,
    text: panel.sourceSurfaces.map((surface) => surface.text).filter(Boolean).join("\n"),
    sourceSha256: firstSurface?.sha256,
    visualAction: panel.visualAction,
  };
}) ?? []);

const imageEntries = computed<MediaEntry[]>(() => {
  if (!timeline.value) return [];
  const entries: MediaEntry[] = [];
  const approved = timeline.value.approvedStoryboard;
  if (approved.raw) {
    entries.push(mediaEntryFromApproved(
      "approved-raw",
      "正式 raw",
      "RAW",
      approved.raw,
      timeline.value.unit.durationSeconds,
    ));
  }
  if (approved.labeled) {
    entries.push(mediaEntryFromApproved(
      "approved-labeled",
      "正式 labeled",
      "LABELED",
      approved.labeled,
      timeline.value.unit.durationSeconds,
    ));
  }
  entries.push(...timeline.value.tracks
    .filter((track) => track.binding.role === "storyboard")
    .map((track) => mediaEntryFromTrack(track, "STORYBOARD")));
  return entries;
});

const videoEntries = computed<MediaEntry[]>(() =>
  timeline.value?.tracks
    .filter((track) => track.binding.role === "video")
    .map((track) => mediaEntryFromTrack(track, "VIDEO")) ?? []);

const audioEntries = computed<MediaEntry[]>(() =>
  timeline.value?.tracks
    .filter((track) => ["dialogue", "music", "sfx"].includes(track.binding.role))
    .map((track) => mediaEntryFromTrack(track, roleLabel(track.binding.role))) ?? []);

const playableEntries = computed<MediaEntry[]>(() => [
  ...videoEntries.value,
  ...audioEntries.value,
]);

const selectedPlaybackEntry = computed(() =>
  findSelectedStudioMultimediaPlaybackEntry(
    playableEntries.value,
    selectedPlaybackId.value,
  ));

const timelineAudioEl = ref<HTMLAudioElement | null>(null);
function onTimelineAudioPlay(): void {
  if (bindBusy.value) {
    timelineAudioEl.value?.pause();
    return;
  }
  claimCanvasAudioPlayback(timelineAudioEl.value);
}
onBeforeUnmount(() => {
  timelineAudioEl.value?.pause();
  releaseCanvasAudioPlayback(timelineAudioEl.value);
});

watch(playableEntries, (entries) => {
  selectedPlaybackId.value = retainStudioMultimediaPlaybackSelection(
    entries,
    selectedPlaybackId.value,
  );
}, { immediate: true });

const timelineTicks = computed(() => {
  const duration = timeline.value?.unit.durationSeconds ?? 0;
  if (duration <= 0) return [0];
  const step = duration <= 15 ? 3 : Math.max(1, Math.ceil(duration / 5));
  const ticks = [0];
  for (let value = step; value < duration; value += step) ticks.push(value);
  ticks.push(duration);
  return ticks;
});

const storyboardIssueText = computed(() => {
  const approved = timeline.value?.approvedStoryboard;
  if (!approved) return "尚未读取投影。";
  return approved.issues.join("；") || `正式故事板状态为 ${availabilityLabel(approved.status)}。`;
});

const MediaEntryDetails = defineComponent({
  name: "StudioMultimediaTimelineMediaEntryDetails",
  props: {
    entry: {
      type: Object as PropType<MediaEntry>,
      required: true,
    },
  },
  setup(componentProps) {
    return () => {
      const entry = componentProps.entry;
      const derivativeNodes = entry.media.derivatives.map((derivative) =>
        h("span", {
          class: "derivative ready",
          "data-derivative-kind": derivative.kind,
        }, `${derivativeLabel(derivative.kind)} ready`));
      const gapNodes = entry.media.derivativeGaps.map((gap) =>
        h("span", {
          class: "derivative missing",
          "data-derivative-kind": gap.kind,
          title: gap.reason,
        }, `${derivativeLabel(gap.kind)} 缺失`));
      return h("div", { class: "entry-copy" }, [
        h("div", { class: "entry-title" }, [
          h("strong", entry.label),
          h("time", formatRange(entry.startSeconds, entry.endSeconds)),
        ]),
        h("p", [
          `${entry.media.sourceBasename} · ${entry.media.mimeType} · ${formatBytes(entry.media.sizeBytes)}`,
        ]),
        h("small", [
          entry.panelIndex ? `G${entry.panelIndex} / ${entry.panelId ?? "panel 未锚定"}` : "全单元",
          ` · SHA ${shortSha(entry.media.sha256)} · CAS ${entry.media.casVerified ? "已核验" : "未核验"}`,
        ]),
        entry.note ? h("small", { class: "entry-note" }, entry.note) : null,
        h("div", { class: "derivatives", "data-testid": "multimedia-derivative-status" }, [
          ...derivativeNodes,
          ...gapNodes,
          ...(derivativeNodes.length || gapNodes.length
            ? []
            : [h("span", { class: "derivative neutral" }, "无派生物记录")]),
        ]),
      ]);
    };
  },
});

watch(() => props.projectRoot, () => {
  appliedSeason.value = props.initialSeason;
  appliedEpisode.value = props.initialEpisode;
  draftSeason.value = props.initialSeason;
  draftEpisode.value = props.initialEpisode;
  selectedUnitId.value = "";
  selectedPlaybackId.value = "";
  timeline.value = null;
  resetBindDraft();
  resetPagination();
  void loadUnits(props.initialUnitId);
});

watch(() => props.api, () => {
  selectedUnitId.value = "";
  selectedPlaybackId.value = "";
  timeline.value = null;
  resetBindDraft();
  resetPagination();
  void loadUnits(props.initialUnitId);
});

onMounted(() => void loadUnits(props.initialUnitId));

async function refresh() {
  if (bindBusy.value) return;
  await loadUnits(selectedUnitId.value);
}

async function applyScope() {
  if (bindBusy.value) return;
  appliedSeason.value = draftSeason.value;
  appliedEpisode.value = draftEpisode.value;
  selectedUnitId.value = "";
  timeline.value = null;
  resetPagination();
  await loadUnits();
}

async function clearScope() {
  if (bindBusy.value) return;
  draftSeason.value = "";
  draftEpisode.value = "";
  unitFilter.value = "";
  await applyScope();
}

async function loadUnits(preferredUnitId = "") {
  const projectRoot = props.projectRoot.trim();
  const request = ++unitRequest;
  unitsError.value = "";
  if (!projectRoot) {
    unitPage.value = null;
    selectedUnitId.value = "";
    timeline.value = null;
    return;
  }
  unitsLoading.value = true;
  try {
    const query: StudioProductionUnitListQuery = {
      limit: PAGE_LIMIT,
      cursor: currentCursor.value,
      season: appliedSeason.value || undefined,
      episode: appliedEpisode.value || undefined,
    };
    const page = await props.api.listUnits(projectRoot, query);
    if (request !== unitRequest || projectRoot !== props.projectRoot.trim()) return;
    unitPage.value = page;
    const availableIds = new Set(page.items.map((unit) => unit.id));
    const nextSelected = preferredUnitId && (availableIds.has(preferredUnitId) || preferredUnitId === props.initialUnitId)
      ? preferredUnitId
      : availableIds.has(selectedUnitId.value)
        ? selectedUnitId.value
        : page.items[0]?.id ?? "";
    if (!nextSelected) {
      selectedUnitId.value = "";
      timeline.value = null;
      timelineError.value = "";
      return;
    }
    await selectUnit(nextSelected, true);
  } catch (error) {
    if (request === unitRequest) {
      unitPage.value = null;
      unitsError.value = errorMessage(error);
    }
  } finally {
    if (request === unitRequest) unitsLoading.value = false;
  }
}

async function pickAndImportMedia() {
  const projectRoot = props.projectRoot.trim();
  if (!projectRoot || !props.api.pickAndImportMedia || bindBusy.value) return;
  bindBusy.value = true;
  bindStage.value = "import";
  bindMessage.value = "";
  bindFailed.value = false;
  try {
    const result = await props.api.pickAndImportMedia(projectRoot);
    if (!result.imported || !result.media) {
      bindMessage.value = "未选择媒体，时间线未发生变化。";
      return;
    }
    importedMedia.value = result.media;
    bindRole.value = result.media.kind === "video" ? "video" : "dialogue";
    bindSlotId.value = `${bindRole.value}-main`;
    bindPanelIndex.value = 0;
    bindStartSeconds.value = 0;
    bindEndSeconds.value = timeline.value?.unit.durationSeconds ?? 0;
    bindMessage.value = "媒体已进入当前工程 CAS；确认区间与角色后再绑定。";
  } catch (error) {
    bindFailed.value = true;
    bindMessage.value = errorMessage(error);
  } finally {
    bindBusy.value = false;
    bindStage.value = "";
  }
}

async function attachImportedMedia() {
  const projectRoot = props.projectRoot.trim();
  const current = timeline.value;
  const media = importedMedia.value;
  if (!projectRoot || !current || !media || !props.api.attachMedia || !bindFormValid.value || bindBusy.value) return;
  bindBusy.value = true;
  bindStage.value = "attach";
  bindMessage.value = "";
  bindFailed.value = false;
  try {
    const slotId = bindSlotId.value.trim();
    const currentHead = current.tracks.find((track) => track.binding.slotId === slotId)?.binding;
    await props.api.attachMedia(projectRoot, {
      unitId: current.unit.id,
      unitRevision: current.unit.revision,
      expectedUnitFingerprint: current.unit.fingerprint,
      slotId,
      expectedHeadRevision: currentHead?.revision ?? 0,
      ...(bindPanelIndex.value > 0 ? { panelIndex: bindPanelIndex.value } : {}),
      startSeconds: bindStartSeconds.value,
      endSeconds: bindEndSeconds.value,
      role: bindRole.value,
      mediaSha256: media.sha256,
      ...(bindNote.value ? { note: bindNote.value } : {}),
    });
    bindMessage.value = "已绑定到当前单元；正式投影与轻量播放器已刷新。";
    await selectUnit(current.unit.id, true);
  } catch (error) {
    bindFailed.value = true;
    bindMessage.value = errorMessage(error);
  } finally {
    bindBusy.value = false;
    bindStage.value = "";
  }
}

function resetBindDraft() {
  importedMedia.value = null;
  bindRole.value = "video";
  bindPanelIndex.value = 0;
  bindStartSeconds.value = 0;
  bindEndSeconds.value = 0;
  bindSlotId.value = "video-main";
  bindNote.value = "";
  bindMessage.value = "";
  bindFailed.value = false;
}

async function selectUnit(unitId: string, force = false) {
  if (bindBusy.value && !force) return;
  if (!force && selectedUnitId.value === unitId && timeline.value) return;
  if (selectedUnitId.value !== unitId) resetBindDraft();
  selectedUnitId.value = unitId;
  selectedPlaybackId.value = "";
  timeline.value = null;
  timelineError.value = "";
  const projectRoot = props.projectRoot.trim();
  const request = ++timelineRequest;
  if (!projectRoot || !unitId) return;
  timelineLoading.value = true;
  try {
    const projection = await props.api.getTimeline(projectRoot, { unitId });
    if (request !== timelineRequest
      || projectRoot !== props.projectRoot.trim()
      || unitId !== selectedUnitId.value) return;
    timeline.value = projection;
  } catch (error) {
    if (request === timelineRequest) timelineError.value = errorMessage(error);
  } finally {
    if (request === timelineRequest) timelineLoading.value = false;
  }
}

async function nextPage() {
  const nextCursor = unitPage.value?.nextCursor;
  if (!nextCursor || unitsLoading.value || bindBusy.value) return;
  cursorHistory.value.push(currentCursor.value);
  currentCursor.value = nextCursor;
  selectedUnitId.value = "";
  timeline.value = null;
  await loadUnits();
}

async function previousPage() {
  if (!cursorHistory.value.length || unitsLoading.value || bindBusy.value) return;
  currentCursor.value = cursorHistory.value.pop();
  selectedUnitId.value = "";
  timeline.value = null;
  await loadUnits();
}

function resetPagination() {
  currentCursor.value = undefined;
  cursorHistory.value = [];
}

function studioMediaUrl(sha256: string): string {
  return `aicanvas-studio://media/${sha256}?projectRoot=${encodeURIComponent(props.projectRoot)}`;
}

function mediaEntryFromApproved(
  role: "approved-raw" | "approved-labeled",
  label: string,
  shortLabel: string,
  media: StudioMultimediaMediaProjection,
  durationSeconds: number,
): MediaEntry {
  return {
    id: `${role}:${media.sha256}`,
    role,
    label,
    shortLabel,
    startSeconds: 0,
    endSeconds: durationSeconds,
    media,
    note: "来自当前 unit head 的正式 PASS 选择。",
  };
}

function mediaEntryFromTrack(
  track: StudioMultimediaTimelineProjection["tracks"][number],
  shortLabel: string,
): MediaEntry {
  return {
    id: track.binding.recordId,
    role: track.binding.role,
    label: `${roleLabel(track.binding.role)} · ${track.binding.slotId}`,
    shortLabel,
    panelIndex: track.binding.panelIndex,
    panelId: track.binding.panelId,
    startSeconds: track.binding.startSeconds,
    endSeconds: track.binding.endSeconds,
    media: track.media,
    note: track.binding.note,
  };
}

function segmentStyle(startSeconds: number, endSeconds: number) {
  const duration = timeline.value?.unit.durationSeconds ?? 0;
  if (duration <= 0) return { left: "0%", width: "100%" };
  const clampedStart = Math.min(duration, Math.max(0, startSeconds));
  const clampedEnd = Math.min(duration, Math.max(clampedStart, endSeconds));
  const left = clampedStart / duration * 100;
  const width = Math.max(0.9, (clampedEnd - clampedStart) / duration * 100);
  return {
    left: `${left}%`,
    width: `${Math.min(100 - left, width)}%`,
  };
}

function percentAt(seconds: number) {
  const duration = timeline.value?.unit.durationSeconds ?? 0;
  return duration > 0 ? seconds / duration * 100 : 0;
}

function availabilityLabel(value: string) {
  if (value === "available") return "可用";
  if (value === "source-only") return "来源图未审";
  if (value === "missing") return "缺失";
  if (value === "invalid") return "无效";
  if (value === "not-applicable") return "不适用";
  return value;
}

function availabilityClass(value: string) {
  return value === "available" ? "ready" : value === "missing" ? "missing" : "warning";
}

function roleLabel(role: MediaEntry["role"]) {
  return {
    storyboard: "故事板",
    video: "视频",
    dialogue: "对白",
    music: "音乐",
    sfx: "音效",
    "approved-raw": "正式 raw",
    "approved-labeled": "正式 labeled",
  }[role];
}

function derivativeLabel(kind: string) {
  return {
    thumbnail: "缩略图",
    video_poster: "视频海报",
    video_proxy: "视频代理",
    audio_waveform: "音频波形",
  }[kind] ?? kind;
}

function formatTime(seconds: number) {
  return `${seconds.toFixed(3)}s`;
}

function formatRange(startSeconds: number, endSeconds: number) {
  return `${formatTime(startSeconds)}–${formatTime(endSeconds)}`;
}

function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1_024) return `${sizeBytes} B`;
  if (sizeBytes < 1_048_576) return `${(sizeBytes / 1_024).toFixed(1)} KB`;
  return `${(sizeBytes / 1_048_576).toFixed(1)} MB`;
}

function shortSha(value: string) {
  return value.slice(0, 12);
}

function pad(value: number, width: number) {
  return String(value).padStart(width, "0");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

defineExpose({ refresh });
</script>

<style scoped>
.multimedia-timeline {
  --track-script: #6f796f;
  --track-image: var(--ui-accent);
  --track-video: #4b7793;
  --track-audio: #89705a;
  height: 100%;
  min-height: 640px;
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr);
  overflow: hidden;
  background: var(--ui-bg);
  color: var(--ui-text);
  font-family: var(--ui-font-sans);
}
.timeline-header {
  min-height: 86px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 16px 22px;
  border-bottom: 1px solid var(--ui-line);
  background: var(--ui-surface);
}
.timeline-header h2 { margin: 5px 0 3px; font-size: 20px; }
.timeline-header p { margin: 0; color: var(--ui-text-2); font-size: 10px; }
.eyebrow { color: var(--ui-accent); font: 700 9px/1 ui-monospace, monospace; letter-spacing: .12em; }
button, input, select { font: inherit; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: none; box-shadow: var(--ui-focus-ring); }
.refresh-button, .scope-bar button, .pager button {
  min-height: 32px;
  border: 1px solid var(--ui-line);
  background: var(--ui-surface);
  color: var(--ui-text-2);
  cursor: pointer;
}
.refresh-button { min-width: 72px; }
.refresh-button:hover, .scope-bar button:hover, .pager button:hover { border-color: var(--ui-accent); color: var(--ui-accent); }
button:disabled { opacity: .42; cursor: not-allowed; }
.scope-bar {
  display: grid;
  grid-template-columns: 150px 150px minmax(220px, 1fr) auto auto;
  align-items: end;
  gap: 10px;
  padding: 11px 22px;
  border-bottom: 1px solid var(--ui-line);
  background: var(--ui-surface);
}
.scope-bar label { display: grid; gap: 5px; color: var(--ui-text-3); font-size: 8px; }
.scope-bar input {
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--ui-line);
  background: var(--ui-bg);
  color: var(--ui-text);
}
.scope-bar button { padding: 0 13px; }
.scope-bar button[type="submit"] { border-color: var(--ui-accent); color: var(--ui-accent); }
.scope-bar .quiet-button { border-color: transparent; background: transparent; }
.error-banner {
  margin: 0;
  padding: 9px 22px;
  border-bottom: 1px solid var(--ui-danger);
  background: color-mix(in srgb, var(--ui-danger) 9%, var(--ui-surface));
  color: var(--ui-danger);
  font-size: 10px;
}
.timeline-layout { min-height: 0; display: grid; grid-template-columns: 246px minmax(0, 1fr); }
.unit-rail {
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  border-right: 1px solid var(--ui-line);
  background: var(--ui-surface);
}
.unit-rail > header {
  min-height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 13px;
  border-bottom: 1px solid var(--ui-line);
}
.unit-rail > header strong, .unit-rail > header small { display: block; }
.unit-rail > header strong { font-size: 10px; }
.unit-rail > header small, .unit-rail > header span { margin-top: 3px; color: var(--ui-text-3); font-size: 8px; }
.unit-list { margin: 0; padding: 0; overflow: auto; list-style: none; }
.unit-list li > button {
  width: 100%;
  display: grid;
  gap: 5px;
  padding: 12px 14px;
  border: 0;
  border-bottom: 1px solid var(--ui-line);
  border-left: 2px solid transparent;
  background: transparent;
  color: var(--ui-text-2);
  text-align: left;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
  content-visibility: auto;
  contain-intrinsic-size: auto 56px;
}
.unit-list li > button:hover { background: var(--ui-surface-2); }
.unit-list li > button.active { border-left-color: var(--ui-accent); background: var(--ui-accent-soft); color: var(--ui-text); }
.unit-list span { color: var(--ui-accent); font: 700 8px/1.2 ui-monospace, monospace; }
.unit-list strong { overflow: hidden; font-size: 10px; white-space: nowrap; text-overflow: ellipsis; }
.unit-list small { color: var(--ui-text-3); font: 8px/1.2 ui-monospace, monospace; }
.rail-empty, .rail-state { padding: 24px 14px; color: var(--ui-text-3); font-size: 9px; text-align: center; }
.pager { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; padding: 9px; border-top: 1px solid var(--ui-line); }
.timeline-stage { min-width: 0; min-height: 0; overflow: auto; padding: 0 22px 36px; }
.stage-state {
  min-height: 360px;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 7px;
  color: var(--ui-text-2);
  text-align: center;
}
.stage-state strong { font-size: 12px; }
.stage-state small { color: var(--ui-text-3); font-size: 9px; }
.stage-state.error { color: var(--ui-danger); font-size: 10px; }
.loading-mark {
  width: 18px;
  height: 18px;
  border: 2px solid var(--ui-line);
  border-top-color: var(--ui-accent);
  border-radius: 50%;
  animation: timeline-spin .7s linear infinite;
}
.unit-heading {
  min-width: 740px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 19px 0 14px;
  border-bottom: 1px solid var(--ui-line);
}
.unit-heading > div:first-child > span { color: var(--ui-accent); font: 700 8px ui-monospace, monospace; }
.unit-heading h3 { margin: 6px 0 3px; font-size: 18px; }
.unit-heading p { margin: 0; color: var(--ui-text-3); font: 8px ui-monospace, monospace; }
.availability { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
.availability span, .derivative {
  padding: 4px 6px;
  border: 1px solid var(--ui-line);
  color: var(--ui-text-3);
  font-size: 7px;
  white-space: nowrap;
}
.availability .ready, .derivative.ready { border-color: color-mix(in srgb, var(--ui-accent) 50%, var(--ui-line)); color: var(--ui-accent); }
.availability .missing, .derivative.missing { border-color: color-mix(in srgb, var(--ui-danger) 50%, var(--ui-line)); color: var(--ui-danger); }
.availability .warning { color: var(--ui-text-2); }
.playback-deck {
  min-width: 740px;
  margin: 14px 0 4px 110px;
  padding: 12px;
  border: 1px solid var(--ui-line);
  background: var(--ui-surface);
}
.playback-deck > header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 10px;
}
.playback-deck strong, .playback-deck small { display: block; }
.playback-deck strong { font-size: 10px; }
.playback-deck small { margin-top: 4px; color: var(--ui-text-3); font-size: 8px; }
.playback-deck label { display: grid; min-width: 300px; gap: 4px; color: var(--ui-text-3); font-size: 8px; }
.playback-deck select {
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--ui-line);
  background: var(--ui-bg);
  color: var(--ui-text);
}
.playback-deck video { width: min(100%, 720px); max-height: 360px; background: #000; }
.playback-deck audio { width: min(100%, 720px); }
.playback-deck audio.audio-blocked { pointer-events: none; }
.playback-empty { margin: 0; color: var(--ui-text-3); font-size: 9px; }
.media-bind-deck {
  min-width: 740px;
  margin: 10px 0 4px 110px;
  padding: 12px;
  border: 1px solid var(--ui-line);
  background: color-mix(in srgb, var(--ui-surface) 82%, var(--ui-accent-soft));
}
.media-bind-deck > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}
.media-bind-deck > header strong,
.media-bind-deck > header small { display: block; }
.media-bind-deck > header strong { font-size: 10px; }
.media-bind-deck > header small { margin-top: 4px; color: var(--ui-text-3); font-size: 8px; }
.media-bind-deck button { min-height: 30px; padding: 0 11px; }
.bind-hint, .bind-message { margin: 10px 0 0; color: var(--ui-text-3); font-size: 8px; }
.bind-message { color: var(--ui-accent); }
.bind-message.error { color: var(--ui-danger); }
.media-bind-form {
  display: grid;
  grid-template-columns: minmax(190px, 1.4fr) repeat(4, minmax(100px, .7fr));
  gap: 8px;
  margin-top: 11px;
  padding-top: 11px;
  border-top: 1px solid var(--ui-line);
}
.media-bind-form label { display: grid; gap: 4px; color: var(--ui-text-3); font-size: 8px; }
.media-bind-form input, .media-bind-form select {
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--ui-line);
  background: var(--ui-bg);
  color: var(--ui-text);
}
.imported-media {
  min-width: 0;
  display: grid;
  align-content: center;
  gap: 4px;
}
.imported-media strong {
  overflow: hidden;
  font-size: 9px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.imported-media small { color: var(--ui-text-3); font: 7px ui-monospace, monospace; overflow-wrap: anywhere; }
.media-bind-form .bind-note { grid-column: 1 / span 4; }
.media-bind-form .bind-submit { align-self: end; border-color: var(--ui-accent); color: var(--ui-accent); }
.ruler {
  position: sticky;
  top: 0;
  z-index: 4;
  min-width: 740px;
  height: 34px;
  margin-left: 110px;
  border-bottom: 1px solid var(--ui-line);
  background: color-mix(in srgb, var(--ui-bg) 92%, transparent);
  backdrop-filter: blur(8px);
}
.ruler::after {
  position: absolute;
  inset: 23px 0 0;
  content: "";
  background: repeating-linear-gradient(90deg, var(--ui-line) 0 1px, transparent 1px 20%);
}
.ruler span {
  position: absolute;
  top: 7px;
  transform: translateX(-50%);
  color: var(--ui-text-3);
  font: 7px ui-monospace, monospace;
}
.ruler span:first-child { transform: none; }
.ruler span:last-child { transform: translateX(-100%); }
.track-stack { min-width: 850px; }
.track {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  border-bottom: 1px solid var(--ui-line);
}
.track > header { padding: 15px 12px 12px 0; }
.track > header div { display: flex; align-items: center; gap: 8px; }
.track-mark {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--ui-line);
  color: var(--ui-text-2);
  font-size: 9px;
}
.track > header strong { font-size: 10px; }
.track > header small { display: block; margin-top: 7px; color: var(--ui-text-3); font-size: 7px; line-height: 1.45; }
.track-entries { min-width: 0; padding: 8px 0; border-left: 1px solid var(--ui-line); }
.track-entry {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) 370px;
  min-height: 82px;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-line) 72%, transparent);
  animation: entry-in 150ms ease both;
  content-visibility: auto;
  contain-intrinsic-size: auto 82px;
}
.track-entry:last-of-type { border-bottom: 0; }
.segment-field {
  position: relative;
  min-width: 0;
  margin: 18px 14px;
  background: repeating-linear-gradient(90deg, color-mix(in srgb, var(--ui-line) 75%, transparent) 0 1px, transparent 1px 20%);
}
.segment {
  position: absolute;
  top: 0;
  height: 28px;
  display: flex;
  align-items: center;
  min-width: 10px;
  overflow: hidden;
  padding: 0 7px;
  border-left: 2px solid currentColor;
  background: var(--ui-surface-2);
  color: var(--ui-text-2);
  font: 700 7px ui-monospace, monospace;
  white-space: nowrap;
}
.script-segment { color: var(--track-script); }
.image-segment { color: var(--track-image); background: var(--ui-accent-soft); }
.video-segment { color: var(--track-video); }
.audio-segment { color: var(--track-audio); }
.audio-segment.role-dialogue { color: #7b6f91; }
.audio-segment.role-music { color: #89705a; }
.audio-segment.role-sfx { color: #7a7851; }
.entry-copy {
  min-width: 0;
  padding: 12px 0 12px 14px;
  border-left: 1px dashed var(--ui-line);
}
.entry-title { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.entry-title strong { overflow: hidden; font-size: 9px; white-space: nowrap; text-overflow: ellipsis; }
.entry-title time { color: var(--ui-text-3); font: 7px ui-monospace, monospace; white-space: nowrap; }
.entry-copy p {
  display: -webkit-box;
  margin: 7px 0 5px;
  overflow: hidden;
  color: var(--ui-text-2);
  font-size: 8px;
  line-height: 1.55;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.entry-copy small { display: block; color: var(--ui-text-3); font: 7px/1.45 ui-monospace, monospace; overflow-wrap: anywhere; }
.entry-copy .entry-note { margin-top: 4px; color: var(--ui-text-2); font-family: var(--ui-font-sans); }
.derivatives { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
.derivative { padding: 2px 5px; }
.derivative.neutral { color: var(--ui-text-3); }
.track-empty { min-height: 58px; display: grid; place-items: center; padding: 12px; color: var(--ui-text-3); font-size: 8px; text-align: center; }
.inline-issues { margin: 0; padding: 9px 14px 9px 30px; border-top: 1px dashed var(--ui-line); color: var(--ui-danger); font-size: 8px; line-height: 1.5; }
.script-source { margin: 7px 14px; color: var(--ui-text-3); font-size: 8px; }
.script-source summary { cursor: pointer; }
.script-source p { max-height: 180px; overflow: auto; padding: 9px; background: var(--ui-surface-2); color: var(--ui-text-2); white-space: pre-wrap; }
.script-source small { font: 7px ui-monospace, monospace; }
.gap-register { margin: 18px 0; border-top: 1px solid var(--ui-line); border-bottom: 1px solid var(--ui-line); }
.gap-register > header { display: flex; justify-content: space-between; padding: 11px 0; }
.gap-register > header strong { font-size: 10px; }
.gap-register > header small { color: var(--ui-text-3); font-size: 8px; }
.gap-register ul { margin: 0; padding: 0; list-style: none; }
.gap-register li {
  display: grid;
  grid-template-columns: 84px 1fr minmax(150px, auto);
  gap: 12px;
  padding: 9px 0;
  border-top: 1px solid var(--ui-line);
  color: var(--ui-text-2);
  font-size: 8px;
}
.gap-register li.required { color: var(--ui-danger); }
.gap-register li p { margin: 0; line-height: 1.45; }
.gap-register code { color: var(--ui-text-3); font: 7px ui-monospace, monospace; overflow-wrap: anywhere; }
.gap-register > p { margin: 0; padding: 12px 0; border-top: 1px solid var(--ui-line); color: var(--ui-text-3); font-size: 8px; }
@keyframes timeline-spin { to { transform: rotate(360deg); } }
@keyframes entry-in { from { opacity: 0; transform: translateY(3px); } }
@media (max-width: 1040px) {
  .scope-bar { grid-template-columns: 120px 120px minmax(170px, 1fr) auto auto; }
  .timeline-layout { grid-template-columns: 210px minmax(0, 1fr); }
  .track-entry { grid-template-columns: minmax(250px, 1fr) 310px; }
}
@media (prefers-reduced-motion: reduce) {
  .loading-mark, .track-entry { animation: none; }
  .unit-list li > button { transition: none; }
}
</style>
