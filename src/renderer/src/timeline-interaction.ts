export interface TimelineSnapResult {
  value: number;
  snappedTo?: number;
}

export interface TimelineTrimPatch {
  startSeconds: number;
  durationSeconds: number;
  trimStartSeconds: number;
  snappedTo?: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function roundTime(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function validFrameRate(value: number | undefined): value is number {
  return Number.isFinite(value) && (value ?? 0) > 0;
}

export function timelineFrameRate(project: { fps: number; timebase?: { rateNumerator: number; rateDenominator: number } }): number {
  const timebase = project.timebase;
  if (timebase && Number.isInteger(timebase.rateNumerator) && Number.isInteger(timebase.rateDenominator) && timebase.rateNumerator > 0 && timebase.rateDenominator > 0) {
    const rationalRate = timebase.rateNumerator / timebase.rateDenominator;
    if (Math.abs(project.fps - rationalRate) < .0015) return rationalRate;
  }
  return project.fps;
}

export function timelineFrameForSeconds(seconds: number, frameRate: number): number {
  if (!validFrameRate(frameRate)) return Math.max(0, Math.round(seconds * 1_000));
  return Math.max(0, Math.round(seconds * frameRate));
}

export function timelineSecondsForFrame(frame: number, frameRate: number): number {
  if (!validFrameRate(frameRate)) return roundTime(Math.max(0, frame) / 1_000);
  return roundTime(Math.max(0, Math.round(frame)) / frameRate);
}

export function quantizeTimelineTime(seconds: number, frameRate?: number, minimum = 0, maximum = Number.POSITIVE_INFINITY): number {
  const clamped = clamp(seconds, minimum, maximum);
  if (!validFrameRate(frameRate)) return roundTime(clamped);
  const minimumFrame = Math.max(0, Math.ceil(minimum * frameRate - 1e-7));
  const maximumFrame = Number.isFinite(maximum) ? Math.max(minimumFrame, Math.floor(maximum * frameRate + 1e-7)) : Number.MAX_SAFE_INTEGER;
  const frame = clamp(Math.round(clamped * frameRate), minimumFrame, maximumFrame);
  return timelineSecondsForFrame(frame, frameRate);
}

export function snapTimelineTime(candidate: number, targets: number[], thresholdSeconds: number, minimum = 0, maximum = Number.POSITIVE_INFINITY, frameRate?: number): TimelineSnapResult {
  const clamped = clamp(candidate, minimum, maximum);
  let snappedTo: number | undefined;
  let distance = Math.max(0, thresholdSeconds);
  for (const target of targets) {
    if (!Number.isFinite(target) || target < minimum || target > maximum) continue;
    const nextDistance = Math.abs(target - clamped);
    if (nextDistance <= distance) {
      distance = nextDistance;
      snappedTo = target;
    }
  }
  return {
    value: quantizeTimelineTime(snappedTo ?? clamped, frameRate, minimum, maximum),
    snappedTo: snappedTo === undefined ? undefined : quantizeTimelineTime(snappedTo, frameRate, minimum, maximum),
  };
}

export function calculateTimelineMove(options: {
  initialStart: number;
  deltaSeconds: number;
  durationSeconds: number;
  totalDuration: number;
  snapTargets: number[];
  snapThresholdSeconds: number;
  frameRate?: number;
}): TimelineSnapResult {
  const maximum = Math.max(0, options.totalDuration - options.durationSeconds);
  return snapTimelineTime(options.initialStart + options.deltaSeconds, options.snapTargets, options.snapThresholdSeconds, 0, maximum, options.frameRate);
}

export function calculateTimelineTrimStart(options: {
  initialStart: number;
  initialDuration: number;
  initialTrimStart: number;
  playbackRate: number;
  deltaSeconds: number;
  mediaCanTrim: boolean;
  snapTargets: number[];
  snapThresholdSeconds: number;
  minimumDuration?: number;
  frameRate?: number;
}): TimelineTrimPatch {
  const minimumDuration = validFrameRate(options.frameRate)
    ? timelineSecondsForFrame(Math.max(1, Math.ceil((options.minimumDuration ?? 0.1) * options.frameRate - 1e-7)), options.frameRate)
    : Math.max(0.01, options.minimumDuration ?? 0.1);
  const playbackRate = Math.max(0.1, options.playbackRate || 1);
  const end = options.initialStart + options.initialDuration;
  const minimumStart = options.mediaCanTrim
    ? Math.max(0, options.initialStart - options.initialTrimStart / playbackRate)
    : 0;
  const maximumStart = Math.max(minimumStart, end - minimumDuration);
  const snapped = snapTimelineTime(options.initialStart + options.deltaSeconds, options.snapTargets, options.snapThresholdSeconds, minimumStart, maximumStart, options.frameRate);
  const appliedDelta = snapped.value - options.initialStart;
  return {
    startSeconds: snapped.value,
    durationSeconds: quantizeTimelineTime(Math.max(minimumDuration, options.initialDuration - appliedDelta), options.frameRate, minimumDuration),
    trimStartSeconds: options.mediaCanTrim ? quantizeTimelineTime(Math.max(0, options.initialTrimStart + appliedDelta * playbackRate), options.frameRate) : options.initialTrimStart,
    snappedTo: snapped.snappedTo,
  };
}

export function calculateTimelineTrimEnd(options: {
  initialStart: number;
  initialDuration: number;
  deltaSeconds: number;
  maximumEnd: number;
  snapTargets: number[];
  snapThresholdSeconds: number;
  minimumDuration?: number;
  frameRate?: number;
}): { durationSeconds: number; snappedTo?: number } {
  const minimumDuration = validFrameRate(options.frameRate)
    ? timelineSecondsForFrame(Math.max(1, Math.ceil((options.minimumDuration ?? 0.1) * options.frameRate - 1e-7)), options.frameRate)
    : Math.max(0.01, options.minimumDuration ?? 0.1);
  const minimumEnd = options.initialStart + minimumDuration;
  const maximumEnd = Math.max(minimumEnd, options.maximumEnd);
  const candidateEnd = options.initialStart + options.initialDuration + options.deltaSeconds;
  const snapped = snapTimelineTime(candidateEnd, options.snapTargets, options.snapThresholdSeconds, minimumEnd, maximumEnd, options.frameRate);
  return { durationSeconds: quantizeTimelineTime(Math.max(minimumDuration, snapped.value - options.initialStart), options.frameRate, minimumDuration), snappedTo: snapped.snappedTo };
}

export function timelineReorderIndex(peers: Array<{ startSeconds: number; durationSeconds: number }>, draggedCenterSeconds: number): number {
  const index = peers.findIndex((peer) => draggedCenterSeconds < peer.startSeconds + peer.durationSeconds / 2);
  return index < 0 ? peers.length : index;
}
