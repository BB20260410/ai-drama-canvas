import { describe, expect, it } from "vitest";
import {
  closeRetriableWatcherHandles,
  createAsyncExclusiveQueue,
  retryWatcherCloseOnce,
} from "../src/main/watcher-owner-coordinator.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("watcher owner 串行与可重试关闭", () => {
  it("并发 start 按提交顺序串行，后一个不能越过前一个关闭阶段", async () => {
    const queue = createAsyncExclusiveQueue();
    const firstGate = deferred<void>();
    const events: string[] = [];
    const first = queue.run(async () => {
      events.push("A:start");
      await firstGate.promise;
      events.push("A:publish");
    });
    const second = queue.run(async () => {
      events.push("B:start");
      events.push("B:publish");
    });

    await Promise.resolve();
    expect(events).toEqual(["A:start"]);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["A:start", "A:publish", "B:start", "B:publish"]);
  });

  it("重复 close 复用同一 promise；失败保留 state 并允许下一次物理重试", async () => {
    const closeGate = deferred<void>();
    let calls = 0;
    const state = { closePromise: null as Promise<void> | null };
    const handle = {
      label: "legacy",
      async close() {
        calls += 1;
        if (calls === 1) {
          await closeGate.promise;
          throw new Error("first close failed");
        }
      },
    };
    const first = closeRetriableWatcherHandles(state, [handle]);
    const concurrent = closeRetriableWatcherHandles(state, [handle]);
    closeGate.resolve();
    const failure = await Promise.all([first, concurrent]).catch((error) => error as AggregateError);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("预期 watcher close 返回 AggregateError。");
    expect(failure.message).toMatch(/watcher owner 关闭失败/u);
    expect((failure.errors[0] as Error).message).toMatch(/first close failed/u);
    expect(calls).toBe(1);
    expect(state.closePromise).toBeNull();
    await expect(closeRetriableWatcherHandles(state, [handle])).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("退出关闭首次失败会即时重试一次并成功收口", async () => {
    let calls = 0;
    await expect(retryWatcherCloseOnce(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient close failure");
    })).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("退出关闭连续两次失败会交给上层取消退出", async () => {
    let calls = 0;
    const failure = await retryWatcherCloseOnce(async () => {
      calls += 1;
      throw new Error(`close failure ${calls}`);
    }).catch((error) => error as AggregateError);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("预期 watcher 退出重试返回 AggregateError。");
    expect(failure.message).toMatch(/重试仍失败/u);
    expect(calls).toBe(2);
  });
});
