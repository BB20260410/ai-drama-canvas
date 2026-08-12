import { describe, expect, it } from "vitest";
import { LatestBoundedTaskQueue } from "../src/renderer/src/bounded-task-queue.js";

describe("LatestBoundedTaskQueue", () => {
  it("限制并发并保持每项只执行一次", async () => {
    const queue = new LatestBoundedTaskQueue(2);
    let active = 0;
    let maximum = 0;
    const calls = new Map<number, number>();
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => queue.schedule(async () => {
      calls.set(index, (calls.get(index) ?? 0) + 1);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return index;
    })));
    expect(maximum).toBe(2);
    expect([...calls.values()]).toEqual(Array(12).fill(1));
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
  });

  it("invalidate 取消未开始任务并丢弃旧完成，不会启动第二轮重试", async () => {
    const queue = new LatestBoundedTaskQueue(1);
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const first = queue.schedule(async () => { calls += 1; await blocker; return 1; });
    const queued = queue.schedule(async () => { calls += 1; return 2; });
    queue.invalidate();
    release();
    expect(await first).toEqual({ status: "cancelled" });
    expect(await queued).toEqual({ status: "cancelled" });
    expect(calls).toBe(1);
  });
});
