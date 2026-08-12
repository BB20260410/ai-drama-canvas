export type StudioProjectionPhaseName =
  | "main-managed-project-preflight"
  | "current-dashboard-binding"
  | "panel-fanout"
  | "timeline-approved-neighbors"
  | "observation-review"
  | "adjacent-pack-video"
  | "frozen-reference-media"
  | "assemble-digest"
  | "core-total";

export interface StudioProjectionPhaseTiming {
  phase: StudioProjectionPhaseName;
  durationMs: number;
  panelCount?: number;
  controlAssetCount?: number;
  canonicalAssetReadCount?: number;
  neighborCount?: number;
  frozenReferenceCount?: number;
}

export interface StudioProjectionPhaseInstrumentation {
  now?: () => number;
  onPhase: (timing: StudioProjectionPhaseTiming) => void;
}

function phaseNow(instrumentation: StudioProjectionPhaseInstrumentation): number {
  return instrumentation.now?.() ?? performance.now();
}

export function beginStudioProjectionPhase(
  instrumentation?: StudioProjectionPhaseInstrumentation,
): number | undefined {
  return instrumentation ? phaseNow(instrumentation) : undefined;
}

export function finishStudioProjectionPhase(
  instrumentation: StudioProjectionPhaseInstrumentation | undefined,
  startedAt: number | undefined,
  phase: StudioProjectionPhaseName,
  counts: Omit<StudioProjectionPhaseTiming, "phase" | "durationMs"> = {},
): void {
  if (!instrumentation || startedAt === undefined) return;
  const timing: StudioProjectionPhaseTiming = {
    phase,
    durationMs: Math.max(0, phaseNow(instrumentation) - startedAt),
    ...counts,
  };
  // 诊断探针永远不能改变正式只读投影的成功/失败语义。
  try { instrumentation.onPhase(timing); } catch { /* diagnostic observer only */ }
}

export async function measureStudioProjectionPhase<T>(
  instrumentation: StudioProjectionPhaseInstrumentation | undefined,
  phase: StudioProjectionPhaseName,
  work: () => Promise<T>,
  counts?: () => Omit<StudioProjectionPhaseTiming, "phase" | "durationMs">,
): Promise<T> {
  if (!instrumentation) return work();
  const startedAt = beginStudioProjectionPhase(instrumentation);
  try {
    return await work();
  } finally {
    finishStudioProjectionPhase(instrumentation, startedAt, phase, counts?.());
  }
}
