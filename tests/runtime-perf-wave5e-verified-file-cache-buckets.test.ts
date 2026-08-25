import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  VERIFIED_FILE_CACHE_LIMIT,
  evictVerifiedFileCacheForProject,
  rememberVerifiedFile,
  resetVerifiedFileCacheForTests,
  verifiedFileCacheBucketCount,
  verifiedFileCacheSize,
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
    expect(protocol).not.toMatch(/VERIFIED_FILE_CACHE_LIMIT\s*=\s*4_?096/u);
    expect(protocol).toContain("material-studio-thumb:v1:autorotate:inside-512:no-enlarge:webp-q82");
  });
});
