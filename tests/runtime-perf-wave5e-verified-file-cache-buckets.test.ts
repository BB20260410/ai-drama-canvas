import { mkdtempSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { evictVerifiedFileCacheAfterLeavingProject } from "../src/core/studio-media-protocol.js";
import {
  VERIFIED_FILE_CACHE_LIMIT,
  evictVerifiedFileCacheForProject,
  rememberVerifiedFile,
  resetVerifiedFileCacheForTests,
  verifiedFileCacheBucketCount,
  verifiedFileCacheSize,
  verifiedFileLeaveGeneration,
} from "../src/core/studio-verified-file-cache.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

afterEach(() => {
  resetVerifiedFileCacheForTests();
});

function seed(canonicalRoot: string, index: number): void {
  rememberVerifiedFile({
    bindingKey: `${canonicalRoot}:${index}`,
    lookupKey: `${canonicalRoot}:lookup:${index}`,
    canonicalRoot,
    inspected: { index },
    expectedSha256: "a".repeat(64),
    expectedSize: 1,
  });
}

describe("Wave 5-E verifiedFileCache 按工程分桶", () => {
  it("全局上限仍是 2048，同工程超额淘汰本桶最旧项", () => {
    expect(VERIFIED_FILE_CACHE_LIMIT).toBe(2_048);
    for (let index = 0; index < VERIFIED_FILE_CACHE_LIMIT; index += 1) seed("/tmp/project-a", index);
    expect(verifiedFileCacheSize()).toBe(2_048);
    expect(verifiedFileCacheBucketCount()).toBe(1);
    seed("/tmp/project-a", VERIFIED_FILE_CACHE_LIMIT);
    expect(verifiedFileCacheSize()).toBe(2_048);
    expect(verifiedFileCacheBucketCount()).toBe(1);
  });

  it("新工程插入时优先淘汰其他工程，不扩大上限", () => {
    for (let index = 0; index < VERIFIED_FILE_CACHE_LIMIT; index += 1) seed("/tmp/project-a", index);
    seed("/tmp/project-b", 0);
    expect(verifiedFileCacheSize()).toBe(2_048);
    expect(verifiedFileCacheBucketCount()).toBe(2);
    expect(evictVerifiedFileCacheForProject("/tmp/project-b")).toBe(1);
    expect(verifiedFileCacheSize()).toBe(2_047);
    expect(verifiedFileCacheBucketCount()).toBe(1);
    expect(evictVerifiedFileCacheForProject("/tmp/project-a")).toBe(2_047);
    expect(verifiedFileCacheSize()).toBe(0);
  });

  it("协议仍用分桶缓存且未把 2048 加大", () => {
    const protocol = readFileSync(path.join(root, "src/core/studio-media-protocol.ts"), "utf8");
    expect(protocol).toContain("from \"./studio-verified-file-cache.js\"");
    expect(protocol).toContain("rememberVerifiedFile");
    expect(protocol).toContain("getVerifiedFileLookup");
    expect(protocol).toContain("evictVerifiedFileCacheForProject");
    expect(protocol).toContain("export async function evictVerifiedFileCacheAfterLeavingProject");
    expect(protocol).not.toMatch(/VERIFIED_FILE_CACHE_LIMIT\s*=\s*4_?096/u);
    expect(protocol).toContain("material-studio-thumb:v1:autorotate:inside-512:no-enlarge:webp-q82");
  });

  it("离开工程淘汰该工程桶，保留其他工程，空根不做事", async () => {
    expect(await evictVerifiedFileCacheAfterLeavingProject(null)).toBe(0);
    expect(await evictVerifiedFileCacheAfterLeavingProject("")).toBe(0);
    const dir = mkdtempSync(path.join(os.tmpdir(), "w5e-leave-"));
    const resolved = path.resolve(dir);
    const canonical = await realpath(resolved);
    seed("/tmp/keep-other", 0);
    seed(resolved, 0);
    if (canonical !== resolved) seed(canonical, 1);
    const removed = await evictVerifiedFileCacheAfterLeavingProject(dir);
    expect(removed).toBeGreaterThan(0);
    expect(verifiedFileCacheSize()).toBe(1);
    expect(verifiedFileCacheBucketCount()).toBe(1);
  });

  it("Main 切工程关闭账本 watcher 时淘汰旧工程缓存；画布不假接线", () => {
    const main = readFileSync(path.join(root, "src/main/index.ts"), "utf8");
    const canvas = readFileSync(path.join(root, "src/renderer/src/components/ManagedStudioCanvasView.vue"), "utf8");
    expect(main).toContain("evictVerifiedFileCacheAfterLeavingProject");
    expect(main).toContain("async function evictVerifiedFileCacheForClosedProject");
    expect(main).toContain("previousRoot !== targetRoot");
    expect(main).toContain("await evictVerifiedFileCacheForClosedProject(previousRoot)");
    expect(main).toContain("await evictVerifiedFileCacheForClosedProject(closingRoot)");
    expect(canvas).toContain("thumbnailLru.clear()");
    expect(canvas).not.toContain("evictVerifiedFileCache");
  });

  it("离开后过期的 remember 不得写回；未带 generation 的测试写入仍可重建", () => {
    seed("/tmp/stale-root", 0);
    const started = verifiedFileLeaveGeneration();
    expect(evictVerifiedFileCacheForProject("/tmp/stale-root")).toBe(1);
    expect(rememberVerifiedFile({
      bindingKey: "/tmp/stale-root:stale",
      lookupKey: "/tmp/stale-root:lookup:stale",
      canonicalRoot: "/tmp/stale-root",
      inspected: { stale: true },
      expectedSha256: "b".repeat(64),
      expectedSize: 1,
    }, started)).toBe(0);
    expect(verifiedFileCacheSize()).toBe(0);
    seed("/tmp/stale-root", 1);
    expect(verifiedFileCacheSize()).toBe(1);
  });

  it("媒体请求换工程时淘汰上一工程；inspect 写回带 leave generation", () => {
    const protocol = readFileSync(path.join(root, "src/core/studio-media-protocol.ts"), "utf8");
    expect(protocol).toContain("lastServedCanonicalRoot");
    expect(protocol).toContain("await evictVerifiedFileCacheAfterLeavingProject(lastServedCanonicalRoot)");
    expect(protocol).toContain("dropInFlightFileInspectionsForRoots");
    expect(protocol).toContain("const startedAtLeaveGeneration = verifiedFileLeaveGeneration()");
    expect(protocol).toContain("}, startedAtLeaveGeneration)");
  });
});
