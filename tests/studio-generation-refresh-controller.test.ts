import { describe, expect, it, vi } from "vitest";
import {
  STUDIO_GENERATION_MAX_PROGRESS_NODES,
  createDebouncedDirtyRefreshLoop,
  createLatestRequestGate,
  loadDetachedUnknownNodeStates,
} from "../src/renderer/src/studio-generation-refresh-controller.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

describe("生成控制页刷新编排", () => {
  it("ledger/history latest gate 丢弃晚到的旧响应", async () => {
    const ledgerGate = createLatestRequestGate();
    const historyGate = createLatestRequestGate();
    const oldLedger = deferred<string>();
    const oldHistory = deferred<string>();
    let ledger = "";
    let history = "";
    const load = async (
      gate: ReturnType<typeof createLatestRequestGate>,
      response: Promise<string>,
      commit: (value: string) => void,
    ) => {
      const token = gate.begin();
      const value = await response;
      if (gate.isCurrent(token)) commit(value);
    };

    const oldLedgerLoad = load(ledgerGate, oldLedger.promise, (value) => { ledger = value; });
    const oldHistoryLoad = load(historyGate, oldHistory.promise, (value) => { history = value; });
    await load(ledgerGate, Promise.resolve("ledger-new"), (value) => { ledger = value; });
    await load(historyGate, Promise.resolve("history-new"), (value) => { history = value; });
    oldLedger.resolve("ledger-old");
    oldHistory.resolve("history-old");
    await Promise.all([oldLedgerLoad, oldHistoryLoad]);

    expect(ledger).toBe("ledger-new");
    expect(history).toBe("history-new");
  });

  it("216 个 unit-grid 通过一次有界 Core 批量查询完成 generation_unknown 核验", async () => {
    const unitIds = Array.from(
      { length: STUDIO_GENERATION_MAX_PROGRESS_NODES },
      (_, index) => `unit-${String(index + 1).padStart(3, "0")}`,
    );
    const queries: string[][] = [];
    const projected: Record<string, string> = {};
    const result = await loadDetachedUnknownNodeStates({
      unitIds,
      isCurrent: () => true,
      queryBatch: async (requestedUnitIds) => {
        queries.push([...requestedUnitIds]);
        return Object.fromEntries(requestedUnitIds.map((unitId) => [
          unitId,
          Number(unitId.slice(-3)) % 17 === 0 ? "blocked" : "clear",
        ]));
      },
      onBatch: (states) => Object.assign(projected, states),
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]).toEqual(unitIds);
    expect(Object.keys(result)).toHaveLength(STUDIO_GENERATION_MAX_PROGRESS_NODES);
    expect(Object.keys(projected)).toHaveLength(STUDIO_GENERATION_MAX_PROGRESS_NODES);
    expect(Object.values(result).every((state) => state === "clear" || state === "blocked" || state === "error")).toBe(true);
  });

  it("同一 debounce 窗口的事件只安排一次刷新", async () => {
    let scheduled: (() => void) | undefined;
    const run = vi.fn(async () => undefined);
    const loop = createDebouncedDirtyRefreshLoop({
      run,
      onError: () => undefined,
      setTimer: (callback) => {
        scheduled = callback;
        return "timer";
      },
      clearTimer: () => undefined,
    });

    loop.markDirty();
    loop.markDirty();
    loop.markDirty();
    expect(run).not.toHaveBeenCalled();
    scheduled?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    loop.dispose();
  });

  it("刷新在途时的多次事件只追加一次后继刷新，错误被捕获且不会并发", async () => {
    const first = deferred();
    let active = 0;
    let maximumActive = 0;
    let runCount = 0;
    const onError = vi.fn();
    const loop = createDebouncedDirtyRefreshLoop({
      run: async () => {
        runCount += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (runCount === 1) {
            await first.promise;
            throw new Error("first refresh failed");
          }
        } finally {
          active -= 1;
        }
      },
      onError,
    });

    const completed = loop.flush();
    await Promise.resolve();
    expect(runCount).toBe(1);
    loop.markDirty();
    loop.markDirty();
    loop.markDirty();
    first.resolve();
    await completed;

    expect(runCount).toBe(2);
    expect(maximumActive).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: "first refresh failed" });
    loop.dispose();
  });
});
