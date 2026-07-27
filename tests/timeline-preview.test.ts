import { describe, expect, it, vi } from "vitest";
import type { EditClip } from "../src/core/types.js";
import { clipPreviewVolume, clipSourceTime, syncTimelineMedia, type TimelineMediaElement } from "../src/renderer/src/timeline-preview.js";

function makeClip(patch: Partial<EditClip> = {}): EditClip {
  return {
    id: "clip-1",
    trackId: "track-1",
    kind: "video",
    name: "测试片段",
    sourcePath: "/tmp/source.mp4",
    startSeconds: 10,
    durationSeconds: 5,
    trimStartSeconds: 3,
    playbackRate: 1.5,
    volume: 0.6,
    opacity: 1,
    muted: false,
    ...patch,
  };
}

function makeMedia(): TimelineMediaElement & { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> } {
  const media = {
    currentTime: 0,
    playbackRate: 1,
    muted: false,
    volume: 1,
    paused: true,
    play: vi.fn(() => { media.paused = false; return Promise.resolve(); }),
    pause: vi.fn(() => { media.paused = true; }),
  };
  return media;
}

describe("时间线媒体预览同步", () => {
  it("按裁切起点、时间线偏移和播放速率计算源时间", () => {
    expect(clipSourceTime(makeClip(), 12)).toBe(6);
  });

  it("播放区间内同步 currentTime、playbackRate、muted、volume 并启动播放", () => {
    const media = makeMedia();
    const clip = makeClip();
    syncTimelineMedia({ clip, media, playhead: 12, playing: true });
    expect(media.currentTime).toBe(6);
    expect(media.playbackRate).toBe(1.5);
    expect(media.muted).toBe(false);
    expect(media.volume).toBe(0.6);
    expect(media.play).toHaveBeenCalledOnce();
  });

  it("暂停和移出片段区间时停止媒体，且轨道静音优先", () => {
    const media = makeMedia();
    media.paused = false;
    syncTimelineMedia({ clip: makeClip(), media, playhead: 12, playing: false, trackMuted: true });
    expect(media.pause).toHaveBeenCalledOnce();
    expect(media.muted).toBe(true);

    media.pause.mockClear();
    media.paused = false;
    syncTimelineMedia({ clip: makeClip(), media, playhead: 16, playing: true });
    expect(media.pause).toHaveBeenCalledOnce();
    expect(media.play).not.toHaveBeenCalled();
  });

  it("音频预览应用淡入淡出包络并把浏览器音量限制在有效范围", () => {
    const clip = makeClip({ kind: "audio", volume: 2, fadeInSeconds: 2, fadeOutSeconds: 2 });
    expect(clipPreviewVolume(clip, 10.5)).toBe(0.5);
    expect(clipPreviewVolume(clip, 12.5)).toBe(1);
    expect(clipPreviewVolume(clip, 14.5)).toBe(0.5);
  });

  it("漂移在容差内时不反复回写 currentTime", () => {
    const media = makeMedia();
    media.currentTime = 6.05;
    syncTimelineMedia({ clip: makeClip(), media, playhead: 12, playing: false, driftToleranceSeconds: 0.1 });
    expect(media.currentTime).toBe(6.05);
  });
});
