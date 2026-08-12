import { describe, expect, it } from "vitest";
import { createStudioProjectionAssetReader } from "../src/core/studio-projection-asset-reader.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Studio projection request-scoped asset reader", () => {
  it("同一 assetId 的并发读取只调用 loader 一次并复用同一个 Promise", async () => {
    const pending = deferred<{ id: string }>();
    let calls = 0;
    const read = createStudioProjectionAssetReader(async (assetId: string) => {
      calls += 1;
      expect(assetId).toBe("asset-a");
      return pending.promise;
    });
    const first = read("asset-a");
    const second = read("asset-a");
    expect(calls).toBe(1);
    pending.resolve({ id: "asset-a" });
    await expect(Promise.all([first, second])).resolves.toEqual([{ id: "asset-a" }, { id: "asset-a" }]);
  });

  it("最多并发四个唯一读取，且调用方仍按各 panel 的 assetIds 顺序投影", async () => {
    let active = 0;
    let peak = 0;
    const releases = new Map<string, ReturnType<typeof deferred<string>>>();
    const read = createStudioProjectionAssetReader(async (assetId: string) => {
      active += 1;
      peak = Math.max(peak, active);
      const pending = deferred<string>();
      releases.set(assetId, pending);
      const value = await pending.promise;
      active -= 1;
      return value;
    }, 4);

    const ids = Array.from({ length: 8 }, (_, index) => `asset-${index}`);
    const values = Promise.all(ids.map((id) => read(id)));
    await Promise.resolve();
    expect([...releases.keys()]).toEqual(ids.slice(0, 4));
    for (const id of ids.slice(0, 4)) releases.get(id)!.resolve(id);
    await Promise.resolve();
    await Promise.resolve();
    expect([...releases.keys()]).toEqual(ids);
    for (const id of ids.slice(4)) releases.get(id)!.resolve(id);
    await expect(values).resolves.toEqual(ids);
    expect(peak).toBe(4);
  });

  it("同一 assetId 的 loader 拒绝只发生一次，并原样传给所有等待者", async () => {
    const sentinel = new Error("sentinel-asset-read");
    let calls = 0;
    const read = createStudioProjectionAssetReader(async () => {
      calls += 1;
      throw sentinel;
    });
    const results = await Promise.allSettled([read("asset-a"), read("asset-a")]);
    expect(calls).toBe(1);
    expect(results).toEqual([
      { status: "rejected", reason: sentinel },
      { status: "rejected", reason: sentinel },
    ]);
  });
});
