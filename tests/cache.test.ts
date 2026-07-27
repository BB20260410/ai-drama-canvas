import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectCache } from "../src/core/cache.js";
import { ensureSidecar } from "../src/core/sidecar.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("SQLite 多实例缓存", () => {
  it("两个应用连接可以交替读取和写入同一布局缓存", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-cache-"));
    roots.push(root);
    await ensureSidecar(root);
    const first = new ProjectCache(root);
    const second = new ProjectCache(root);
    try {
      first.savePositions("main", { nodeA: { x: 10, y: 20 } });
      expect(second.loadPositions("main").nodeA).toEqual({ x: 10, y: 20 });
      second.savePositions("main", { nodeB: { x: 30, y: 40 } });
      expect(first.loadPositions("main").nodeB).toEqual({ x: 30, y: 40 });
    } finally {
      first.close();
      second.close();
    }
  });
});
