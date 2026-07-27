export type DetachedUnknownTerminalState = "clear" | "blocked" | "error";

export const STUDIO_GENERATION_MAX_PROGRESS_NODES = 216;
export const DETACHED_UNKNOWN_QUERY_BATCH_SIZE = 24;

export interface LatestRequestGate {
  begin(): number;
  isCurrent(token: number): boolean;
  invalidate(): void;
}

export function createLatestRequestGate(): LatestRequestGate {
  let sequence = 0;
  return {
    begin(): number {
      sequence += 1;
      return sequence;
    },
    isCurrent(token: number): boolean {
      return token === sequence;
    },
    invalidate(): void {
      sequence += 1;
    },
  };
}

export async function loadDetachedUnknownNodeStates(input: {
  unitIds: readonly string[];
  queryBatch: (
    unitIds: readonly string[],
  ) => Promise<Readonly<Record<string, "clear" | "blocked">>>;
  isCurrent: () => boolean;
  onBatch?: (states: Readonly<Record<string, DetachedUnknownTerminalState>>) => void;
}): Promise<Record<string, DetachedUnknownTerminalState>> {
  const unitIds = [...new Set(input.unitIds.map((unitId) => unitId.trim()).filter(Boolean))];
  if (unitIds.length > STUDIO_GENERATION_MAX_PROGRESS_NODES) {
    throw new Error(`unit-grid generation_unknown 批量查询超过 ${STUDIO_GENERATION_MAX_PROGRESS_NODES} 项上限。`);
  }
  const resolved: Record<string, DetachedUnknownTerminalState> = {};
  if (!unitIds.length || !input.isCurrent()) return resolved;
  try {
    const states = await input.queryBatch(unitIds);
    if (!input.isCurrent()) return resolved;
    for (const unitId of unitIds) {
      const state = states[unitId];
      resolved[unitId] = state === "clear" || state === "blocked" ? state : "error";
    }
  } catch {
    if (!input.isCurrent()) return resolved;
    for (const unitId of unitIds) resolved[unitId] = "error";
  }
  input.onBatch?.(resolved);
  return resolved;
}

export interface DebouncedDirtyRefreshLoop {
  markDirty(): void;
  flush(): Promise<void>;
  reset(): void;
  dispose(): void;
}

/**
 * 事件只标记 dirty：同一 debounce 窗口合并；刷新在途时的新事件只追加一次后继刷新。
 * 任意时刻至多一个 run()，错误统一交给 onError，拒绝产生未处理 Promise。
 */
export function createDebouncedDirtyRefreshLoop(input: {
  run: () => Promise<void>;
  onError: (reason: unknown) => void;
  debounceMs?: number;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): DebouncedDirtyRefreshLoop {
  const debounceMs = Math.max(0, Math.floor(input.debounceMs ?? 120));
  const setTimer = input.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearTimer = input.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let timer: unknown;
  let dirty = false;
  let running = false;
  let disposed = false;
  let drainPromise: Promise<void> | null = null;

  const clearPendingTimer = (): void => {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  };

  const drain = async (): Promise<void> => {
    if (running || disposed) return;
    running = true;
    try {
      while (!disposed && dirty) {
        dirty = false;
        try {
          await input.run();
        } catch (reason) {
          input.onError(reason);
        }
      }
    } finally {
      running = false;
      drainPromise = null;
    }
  };

  const startDrain = (): Promise<void> => {
    if (!drainPromise) drainPromise = drain();
    return drainPromise;
  };

  return {
    markDirty(): void {
      if (disposed) return;
      dirty = true;
      if (running) return;
      clearPendingTimer();
      timer = setTimer(() => {
        timer = undefined;
        void startDrain();
      }, debounceMs);
    },
    async flush(): Promise<void> {
      if (disposed) return;
      dirty = true;
      clearPendingTimer();
      await startDrain();
    },
    reset(): void {
      dirty = false;
      clearPendingTimer();
    },
    dispose(): void {
      disposed = true;
      dirty = false;
      clearPendingTimer();
    },
  };
}
