import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBoundedKeyedCache } from "../src/renderer/src/use-bounded-keyed-cache.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("Wave 2-F 冻结参考缩略图缓存 LRU（同工程有界）", () => {
  it("硬顶淘汰最旧键；get 刷新新近；delete 后可再写入", () => {
    const cache = createBoundedKeyedCache<Promise<{ status: string }>>(3);
    const a = Promise.resolve({ status: "ready" });
    const b = Promise.resolve({ status: "ready" });
    const c = Promise.resolve({ status: "ready" });
    const d = Promise.resolve({ status: "deriving" });
    cache.set("k1", a);
    cache.set("k2", b);
    cache.set("k3", c);
    expect(cache.size()).toBe(3);
    expect(cache.peekOrder()).toEqual(["k1", "k2", "k3"]);
    expect(cache.get("k1")).toBe(a);
    expect(cache.peekOrder()).toEqual(["k2", "k3", "k1"]);
    cache.set("k4", d);
    expect(cache.size()).toBe(3);
    expect(cache.get("k2")).toBeUndefined();
    expect(cache.get("k3")).toBe(c);
    expect(cache.get("k1")).toBe(a);
    expect(cache.get("k4")).toBe(d);
    expect(cache.delete("k1")).toBe(true);
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it("只持 Promise/状态引用，源码不缓存媒体字节", () => {
    const helper = source("src/renderer/src/use-bounded-keyed-cache.ts");
    expect(helper).toContain("不持媒体二进制");
    expect(helper).not.toMatch(/ArrayBuffer|Uint8Array|Buffer\.from|readFileSync|blob:/);
  });

  it("画布冻结参考缓存改用 96 硬顶 LRU，切工程仍 clear", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("createBoundedKeyedCache<Promise<FrozenReferenceThumbnailResult>>(96)");
    expect(canvas).not.toContain("const frozenReferenceThumbnailCache = new Map<string, Promise<FrozenReferenceThumbnailResult>>()");
    expect(canvas).toContain("frozenReferenceThumbnailCache.clear()");
    expect(canvas).toContain("thumbnailLru.clear()");
  });
});
