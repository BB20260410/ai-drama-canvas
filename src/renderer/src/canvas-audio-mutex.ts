let current: HTMLAudioElement | null = null;

export function claimCanvasAudioPlayback(el: HTMLAudioElement | null | undefined): void {
  if (!el) return;
  if (current && current !== el) current.pause();
  current = el;
}

export function releaseCanvasAudioPlayback(el: HTMLAudioElement | null | undefined): void {
  if (!el || current !== el) return;
  current = null;
}
