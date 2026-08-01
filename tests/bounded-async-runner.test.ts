import { describe, expect, it } from "vitest";
import { runBoundedAsyncTasks } from "../src/renderer/src/bounded-async-runner.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushWorkerHandoff(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("runBoundedAsyncTasks", () => {
  it("限制最大在途任务数并保持结果顺序", async () => {
    const gates = Array.from({ length: 7 }, () => deferred<number>());
    let active = 0;
    let maximumActive = 0;
    const started: number[] = [];
    const run = runBoundedAsyncTasks(
      gates.map((gate, index) => async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        started.push(index);
        const result = await gate.promise;
        active -= 1;
        return result;
      }),
      3,
    );

    await flushWorkerHandoff();
    expect(started).toEqual([0, 1, 2]);
    gates[1]!.resolve(101);
    await flushWorkerHandoff();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[0]!.resolve(100);
    gates[2]!.resolve(102);
    await flushWorkerHandoff();
    gates[3]!.resolve(103);
    await flushWorkerHandoff();
    gates[4]!.resolve(104);
    gates[5]!.resolve(105);
    await flushWorkerHandoff();
    gates[6]!.resolve(106);

    await expect(run).resolves.toEqual([100, 101, 102, 103, 104, 105, 106]);
    expect(maximumActive).toBe(3);
  });

  it("空任务直接返回，非法并发上限失败关闭", async () => {
    await expect(runBoundedAsyncTasks([], 4)).resolves.toEqual([]);
    await expect(runBoundedAsyncTasks([], 0)).rejects.toThrow("concurrency");
    await expect(runBoundedAsyncTasks([], 1.5)).rejects.toThrow("concurrency");
  });
});
