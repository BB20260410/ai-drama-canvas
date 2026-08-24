import { readFileSync } from "node:fs";
import path from "node:path";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const componentPath = path.join(
  process.cwd(),
  "src/renderer/src/components/StudioMultimediaTimelineView.vue",
);
const source = () => readFileSync(componentPath, "utf8");

describe("StudioMultimediaTimelineView 源码合同", () => {
  it("SFC 的 script 与 template 可解析编译", () => {
    const parsed = parse(source(), { filename: "StudioMultimediaTimelineView.vue" });
    expect(parsed.errors).toEqual([]);
    const id = "studio-multimedia-timeline-view";
    const script = compileScript(parsed.descriptor, { id });
    expect(script.content).toContain("listUnits");
    const template = compileTemplate({
      id,
      filename: "StudioMultimediaTimelineView.vue",
      source: parsed.descriptor.template?.content ?? "",
      scoped: true,
    });
    expect(template.errors).toEqual([]);
  });

  it("从 Core 投影展示剧本、图片、视频、音频四轨与真实缺失项", () => {
    const vue = source();
    for (const marker of [
      'data-testid="multimedia-script-track"',
      'data-testid="multimedia-image-track"',
      'data-testid="multimedia-video-track"',
      'data-testid="multimedia-audio-track"',
      'data-testid="multimedia-gap-register"',
      'timeline.approvedStoryboard',
      'timeline.gaps',
      'track.binding.startSeconds',
      'track.binding.endSeconds',
      'track.binding.panelIndex',
      'track.binding.panelId',
      'shortSha(entry.media.sha256)',
      'entry.media.derivatives',
      'entry.media.derivativeGaps',
    ]) {
      expect(vue).toContain(marker);
    }
    expect(vue).not.toMatch(/\b(mock|fakeMedia|placeholderMedia)\b/u);
    expect(vue).toContain('if (value === "source-only") return "来源图未审"');
  });

  it("剧本原文 summary 含 testid，details 仍 multimedia-script-source", () => {
    const vue = source();
    expect(vue).toContain('class="script-source"');
    expect(vue).toContain('data-testid="multimedia-script-source"');
    expect(vue).toContain('data-testid="multimedia-script-source-summary"');
    expect(vue).toContain('<summary data-testid="multimedia-script-source-summary">查看本单元剧本原文与来源</summary>');
    expect(vue).toContain("{{ timeline.script.body }}");
    expect(vue).not.toContain("multimedia-script-source-summary-");
    expect(vue).not.toContain('script-source" role="dialog"');
    expect(vue).toContain('data-testid="multimedia-script-track"');
  });

  it("季集查询走分页 API，单元筛选只作用当前页且时间线只读选中单元", () => {
    const vue = source();
    for (const marker of [
      'data-testid="multimedia-season-filter"',
      'data-testid="multimedia-episode-filter"',
      'data-testid="multimedia-unit-filter"',
      'data-testid="multimedia-unit-pager"',
      "limit: PAGE_LIMIT",
      "cursor: currentCursor.value",
      "season: appliedSeason.value || undefined",
      "episode: appliedEpisode.value || undefined",
      "unitPage.value?.items ?? []",
      "props.api.getTimeline(projectRoot, { unitId })",
    ]) {
      expect(vue).toContain(marker);
    }
    expect(vue).not.toMatch(/Promise\.all\([^)]*getTimeline/su);
    expect(vue).not.toMatch(/page\.items\.map\([^)]*getTimeline/su);
    expect(vue).not.toContain("window.canvasApi");
  });

  it("公开加载、错误、空态与派生物状态测试锚点", () => {
    const vue = source();
    for (const testId of [
      "studio-multimedia-timeline-view",
      "multimedia-units-loading",
      "multimedia-units-error",
      "multimedia-units-empty",
      "multimedia-timeline-loading",
      "multimedia-timeline-error",
      "multimedia-no-selection",
      "multimedia-projection-empty",
      "multimedia-time-ruler",
      "multimedia-availability",
      "multimedia-image-missing",
      "multimedia-video-missing",
      "multimedia-audio-missing",
    ]) {
      expect(vue).toContain(`data-testid="${testId}"`);
    }
    expect(vue).toContain('"data-testid": "multimedia-derivative-status"');
  });

  it("显示毫秒精度、分集绝对时间、panel 锚点和 SHA 短码", () => {
    const vue = source();
    expect(vue).toContain("seconds.toFixed(3)");
    expect(vue).toContain("timeline.unit.episodeStartSeconds");
    expect(vue).toContain("timeline.unit.episodeEndSeconds");
    expect(vue).toContain("value.slice(0, 12)");
    expect(vue).toContain("entry.panelIndex");
    expect(vue).toContain("entry.panelId");
  });

  it("只对当前单元正式绑定的视频或音频提供按需原生播放", () => {
    const vue = source();
    for (const marker of [
      'data-testid="multimedia-playback-deck"',
      'data-testid="multimedia-playback-select"',
      'data-testid="multimedia-video-player"',
      'data-testid="multimedia-audio-player"',
      'preload="metadata"',
      "playableEntries.value",
      "aicanvas-studio://media/",
      "selectedPlaybackId.value = \"\"",
      'value="" disabled',
      "请选择一条正式视频或音频后播放",
      "findSelectedStudioMultimediaPlaybackEntry",
      "retainStudioMultimediaPlaybackSelection",
    ]) {
      expect(vue).toContain(marker);
    }
    expect(vue).not.toContain('preload="auto"');
    expect(vue).not.toMatch(/autoplay(?:=|\\s|>)/u);
    expect(vue).not.toContain("?? playableEntries.value[0]");
    expect(vue).not.toContain("selectedPlaybackId.value = entries[0]?.id");
  });

  it("提供导入 CAS、选择角色与区间、再经正式命令绑定的最小写入闭环", () => {
    const vue = source();
    for (const marker of [
      'data-testid="multimedia-media-bind-deck"',
      'data-testid="multimedia-pick-media"',
      'data-testid="multimedia-media-bind-form"',
      'data-testid="multimedia-bind-role"',
      'data-testid="multimedia-bind-panel"',
      'data-testid="multimedia-bind-start"',
      'data-testid="multimedia-bind-end"',
      'data-testid="multimedia-bind-slot"',
      'data-testid="multimedia-attach-media"',
      "props.api.pickAndImportMedia(projectRoot)",
      "props.api.attachMedia(projectRoot",
      "expectedUnitFingerprint: current.unit.fingerprint",
      "expectedHeadRevision: currentHead?.revision ?? 0",
      "await selectUnit(current.unit.id, true)",
    ]) {
      expect(vue).toContain(marker);
    }
    expect(vue).not.toContain("sourcePath:");
    expect(vue).not.toContain("window.canvasApi");
  });

  it("绑定进行中 fail-closed：unit/refresh/scope 禁用并给出原因，连点不会边绑定边换单元", () => {
    const vue = source();
    expect(vue).toContain(':disabled="unitsLoading || timelineLoading || bindBusy || !projectRoot"');
    expect(vue).toContain(':disabled="unitsLoading || bindBusy || !projectRoot"');
    expect(vue).toContain(':disabled="unitsLoading || bindBusy || (!draftSeason && !draftEpisode && !unitFilter)"');
    expect(vue).toContain(':disabled="bindBusy"');
    expect(vue).toContain(':disabled="!cursorHistory.length || unitsLoading || bindBusy"');
    expect(vue).toContain(':disabled="!unitPage?.nextCursor || unitsLoading || bindBusy"');
    expect(vue).toContain(':title="bindBusy ? bindBusyTitle : undefined"');
    expect(vue).toContain("正在导入媒体，不能换单元、刷新或改范围");
    expect(vue).toContain("正在绑定媒体，不能换单元、刷新或改范围");
    expect(vue).toContain("正在处理媒体，不能换单元、刷新或改范围");

    const refreshStart = vue.indexOf("async function refresh()");
    const refreshEnd = vue.indexOf("\nasync function applyScope()", refreshStart);
    expect(refreshStart).toBeGreaterThan(-1);
    expect(refreshEnd).toBeGreaterThan(refreshStart);
    const refreshSource = vue.slice(refreshStart, refreshEnd);
    expect(refreshSource).toContain("if (bindBusy.value) return;");
    expect(refreshSource.indexOf("if (bindBusy.value) return;")).toBeLessThan(refreshSource.indexOf("await loadUnits"));

    const applyStart = vue.indexOf("async function applyScope()");
    const applyEnd = vue.indexOf("\nasync function clearScope()", applyStart);
    expect(applyStart).toBeGreaterThan(-1);
    expect(applyEnd).toBeGreaterThan(applyStart);
    expect(vue.slice(applyStart, applyEnd)).toContain("if (bindBusy.value) return;");

    const clearStart = vue.indexOf("async function clearScope()");
    const clearEnd = vue.indexOf("\nasync function loadUnits(", clearStart);
    expect(clearStart).toBeGreaterThan(-1);
    expect(clearEnd).toBeGreaterThan(clearStart);
    expect(vue.slice(clearStart, clearEnd)).toContain("if (bindBusy.value) return;");

    const selectStart = vue.indexOf("async function selectUnit(");
    const selectEnd = vue.indexOf("\nasync function nextPage()", selectStart);
    expect(selectStart).toBeGreaterThan(-1);
    expect(selectEnd).toBeGreaterThan(selectStart);
    const selectSource = vue.slice(selectStart, selectEnd);
    expect(selectSource).toContain("if (bindBusy.value && !force) return;");
    expect(selectSource.indexOf("if (bindBusy.value && !force) return;")).toBeLessThan(
      selectSource.indexOf("selectedUnitId.value = unitId"),
    );

    const nextStart = vue.indexOf("async function nextPage()");
    const nextEnd = vue.indexOf("\nasync function previousPage()", nextStart);
    expect(nextStart).toBeGreaterThan(-1);
    expect(nextEnd).toBeGreaterThan(nextStart);
    expect(vue.slice(nextStart, nextEnd)).toContain("bindBusy.value) return;");

    const prevStart = vue.indexOf("async function previousPage()");
    const prevEnd = vue.indexOf("\nfunction resetPagination()", prevStart);
    expect(prevStart).toBeGreaterThan(-1);
    expect(prevEnd).toBeGreaterThan(prevStart);
    expect(vue.slice(prevStart, prevEnd)).toContain("bindBusy.value) return;");

    const importStart = vue.indexOf("async function pickAndImportMedia()");
    const importEnd = vue.indexOf("\nasync function attachImportedMedia()", importStart);
    expect(importStart).toBeGreaterThan(-1);
    expect(importEnd).toBeGreaterThan(importStart);
    const importSource = vue.slice(importStart, importEnd);
    expect(importSource).toContain("bindBusy.value) return;");
    expect(importSource.indexOf("bindBusy.value = true")).toBeGreaterThan(-1);
    expect(importSource.indexOf("bindBusy.value = true")).toBeLessThan(
      importSource.indexOf("await props.api.pickAndImportMedia"),
    );

    const attachStart = vue.indexOf("async function attachImportedMedia()");
    const attachEnd = vue.indexOf("\nfunction resetBindDraft()", attachStart);
    expect(attachStart).toBeGreaterThan(-1);
    expect(attachEnd).toBeGreaterThan(attachStart);
    const attachSource = vue.slice(attachStart, attachEnd);
    expect(attachSource).toContain("bindBusy.value) return;");
    expect(attachSource.indexOf("bindBusy.value = true")).toBeGreaterThan(-1);
    expect(attachSource.indexOf("bindBusy.value = true")).toBeLessThan(
      attachSource.indexOf("await props.api.attachMedia"),
    );
    expect(attachSource).toContain("await selectUnit(current.unit.id, true)");
  });
});

describe("四媒体时间线单元列表视口剔除", () => {
  it("unit-list 行使用 content-visibility，离屏单元跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="unit in filteredUnits"');
    expect(vue).toContain(".unit-list { margin: 0; padding: 0; overflow: auto; list-style: none; }");
    expect(vue).toContain("content-visibility: auto;");
    expect(vue).toContain("contain-intrinsic-size: auto 56px;");
    expect(vue).not.toMatch(/\.unit-list li > button \{[^}]*content-visibility:\s*hidden/);
  });

  it("track-entry 使用 content-visibility，离屏四轨条目跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="entry in scriptEntries"');
    expect(vue).toContain('class="track-entry"');
    expect(vue).toContain(".timeline-stage { min-width: 0; min-height: 0; overflow: auto; padding: 0 22px 36px; }");
    expect(vue).toContain(".track-entry {\n  display: grid;\n  grid-template-columns: minmax(280px, 1fr) 370px;\n  min-height: 82px;\n  border-bottom: 1px solid color-mix(in srgb, var(--ui-line) 72%, transparent);\n  animation: entry-in 150ms ease both;\n  content-visibility: auto;\n  contain-intrinsic-size: auto 82px;\n}");
    expect(vue).not.toMatch(/\.track-entry \{[^}]*content-visibility:\s*hidden/);
    expect(vue).not.toMatch(/\.track-entry:last-of-type \{[^}]*content-visibility/);
  });

  it("时间线原生音频 play 加入画布互斥，不拉 VideoEditor Map", () => {
    const vue = source();
    expect(vue).toContain('data-testid="multimedia-audio-player"');
    expect(vue).toContain('@play="onTimelineAudioPlay"');
    expect(vue).toContain("claimCanvasAudioPlayback(timelineAudioEl.value)");
    expect(vue).toContain("releaseCanvasAudioPlayback(timelineAudioEl.value)");
    expect(vue).toContain("timelineAudioEl.value?.pause()");
    expect(vue).not.toContain("wavesurfer");
    expect(vue).not.toContain("audioElements");
  });

  it("bindBusy 时点原生 play 立即 pause，不认领互斥", () => {
    const vue = source();
    const play = vue.slice(
      vue.indexOf("function onTimelineAudioPlay()"),
      vue.indexOf("onBeforeUnmount(() => {\n  timelineAudioEl.value?.pause();"),
    );
    expect(play).toContain("if (bindBusy.value) {");
    expect(play).toContain("timelineAudioEl.value?.pause();");
    expect(play.indexOf("if (bindBusy.value)")).toBeLessThan(play.indexOf("claimCanvasAudioPlayback(timelineAudioEl.value)"));
  });

  it("bindBusy 时禁用原生音频 pointer-events", () => {
    const vue = source();
    expect(vue).toContain(':class="{ \'audio-blocked\': bindBusy }"');
    expect(vue).toContain(".playback-deck audio.audio-blocked { pointer-events: none; }");
  });
});
