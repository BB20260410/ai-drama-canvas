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
    ]) {
      expect(vue).toContain(marker);
    }
    expect(vue).not.toContain('preload="auto"');
    expect(vue).not.toMatch(/autoplay(?:=|\\s|>)/u);
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
});
