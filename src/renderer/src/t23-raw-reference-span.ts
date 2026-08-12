/**
 * T23 raw/reference renderer 内部时刻。
 *
 * 这是性能探针的纯协调器，不参与任何生产状态裁决：调用者仍必须在写入当前
 * Map、安排/flush 图重建后，才调用对应 marker。spanId 模块级单调递增，避免
 * 刷新/切工程后的迟到 worker 与当前批次混淆。
 */

let nextRawReferenceSpanId = 0;

export interface T23RawReferenceSpanTrackerOptions {
  now?: () => number;
  mark: (milestone: string, atMs: number) => void;
}

export interface T23RawReferenceSpanInput {
  projectRoot: string;
  flightSequence: number;
  isCurrent: () => boolean;
}

export interface T23RawReferenceSpan {
  readonly spanId: number;
  readonly projectRoot: string;
  readonly flightSequence: number;
  setExpectedPassUnitIds(unitIds: readonly string[]): boolean;
  markFirstRaw(unitId: string): boolean;
  recordPassReference(unitId: string): boolean;
  complete(): boolean;
  invalidate(): boolean;
}

export interface T23RawReferenceSpanTracker {
  begin(input: T23RawReferenceSpanInput): T23RawReferenceSpan;
  invalidateCurrent(): boolean;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export function createT23RawReferenceSpanTracker(
  options: T23RawReferenceSpanTrackerOptions,
): T23RawReferenceSpanTracker {
  const now = options.now ?? (() => performance.now());
  let current: T23RawReferenceSpan | undefined;

  const begin = (input: T23RawReferenceSpanInput): T23RawReferenceSpan => {
    current?.invalidate();
    const spanId = ++nextRawReferenceSpanId;
    let invalidated = false;
    let firstRawMarked = false;
    let completed = false;
    let expectedPassUnitIds = new Set<string>();
    const passReferenceUnitIds = new Set<string>();
    const mark = (event: string): void => options.mark(`${event}:${spanId}`, now());
    const isUsable = (): boolean => {
      if (invalidated) return false;
      if (input.isCurrent()) return true;
      span.invalidate();
      return false;
    };
    const span: T23RawReferenceSpan = {
      spanId,
      projectRoot: input.projectRoot,
      flightSequence: input.flightSequence,
      setExpectedPassUnitIds(unitIds) {
        if (!isUsable() || completed) return false;
        expectedPassUnitIds = new Set(unitIds);
        for (const unitId of passReferenceUnitIds) {
          if (!expectedPassUnitIds.has(unitId)) passReferenceUnitIds.delete(unitId);
        }
        return true;
      },
      markFirstRaw(unitId) {
        if (!isUsable() || completed || firstRawMarked) return false;
        firstRawMarked = true;
        options.mark(`canvas-first-raw-unit:${spanId}:${unitId}`, now());
        mark("canvas-first-raw-ready");
        return true;
      },
      recordPassReference(unitId) {
        if (!isUsable() || completed || !expectedPassUnitIds.has(unitId)) return false;
        passReferenceUnitIds.add(unitId);
        return true;
      },
      complete() {
        if (!isUsable() || completed || !firstRawMarked
          || !expectedPassUnitIds.size
          || !sameSet(expectedPassUnitIds, passReferenceUnitIds)) return false;
        for (const unitId of [...expectedPassUnitIds].sort((left, right) => left.localeCompare(right))) {
          options.mark(`canvas-all-pass-reference-unit:${spanId}:${unitId}`, now());
        }
        mark("canvas-all-pass-references-ready");
        completed = true;
        mark("canvas-raw-span-complete");
        return true;
      },
      invalidate() {
        if (invalidated) return false;
        invalidated = true;
        mark("canvas-raw-span-invalidated");
        return true;
      },
    };
    current = span;
    mark("canvas-raw-span-start");
    return span;
  };

  return {
    begin,
    invalidateCurrent: () => current?.invalidate() ?? false,
  };
}
