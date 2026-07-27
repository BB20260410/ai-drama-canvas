import type { EditClip } from "../../core/types.js";

export interface TimelineMediaElement {
  currentTime: number;
  playbackRate: number;
  muted: boolean;
  volume: number;
  paused: boolean;
  play: () => Promise<void> | void;
  pause: () => void;
}

export interface TimelineMediaSyncOptions {
  clip: EditClip;
  media: TimelineMediaElement;
  playhead: number;
  playing: boolean;
  trackMuted?: boolean;
  driftToleranceSeconds?: number;
}

export function clipContainsPlayhead(clip: EditClip, playhead: number): boolean {
  return playhead >= clip.startSeconds && playhead < clip.startSeconds + clip.durationSeconds;
}

export function clipSourceTime(clip: EditClip, playhead: number): number {
  const localTime = Math.max(0, Math.min(clip.durationSeconds, playhead - clip.startSeconds));
  return Math.max(0, clip.trimStartSeconds + localTime * clip.playbackRate);
}

export function clipPreviewVolume(clip: EditClip, playhead: number): number {
  let envelope = 1;
  if (clip.kind === "audio") {
    const localTime = Math.max(0, Math.min(clip.durationSeconds, playhead - clip.startSeconds));
    const fadeIn = Math.min(clip.durationSeconds, Math.max(0, clip.fadeInSeconds ?? 0));
    const fadeOut = Math.min(clip.durationSeconds, Math.max(0, clip.fadeOutSeconds ?? 0));
    if (fadeIn > 0) envelope = Math.min(envelope, localTime / fadeIn);
    if (fadeOut > 0) envelope = Math.min(envelope, (clip.durationSeconds - localTime) / fadeOut);
  }
  // HTMLMediaElement.volume 的有效范围是 0–1；高于 1 的导出增益在浏览器预览中封顶。
  return Math.max(0, Math.min(1, clip.volume * Math.max(0, envelope)));
}

export function syncTimelineMedia(options: TimelineMediaSyncOptions): void {
  const { clip, media, playhead, playing, trackMuted = false, driftToleranceSeconds = 0.05 } = options;
  const active = clipContainsPlayhead(clip, playhead);
  media.playbackRate = Math.max(0.1, Math.min(8, clip.playbackRate || 1));
  media.muted = Boolean(trackMuted || clip.muted);
  media.volume = clipPreviewVolume(clip, playhead);

  if (!active) {
    media.pause();
    return;
  }

  const sourceTime = clipSourceTime(clip, playhead);
  if (Math.abs(media.currentTime - sourceTime) > driftToleranceSeconds) {
    try { media.currentTime = sourceTime; } catch { /* 元数据尚未就绪时由 loadedmetadata 再同步。 */ }
  }

  if (!playing) {
    media.pause();
    return;
  }
  if (media.paused) {
    try {
      const started = media.play();
      if (started && typeof started.catch === "function") void started.catch(() => undefined);
    } catch { /* 浏览器自动播放策略拒绝时保持播放头运行，下一次用户操作会重试。 */ }
  }
}
