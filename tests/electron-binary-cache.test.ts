import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { seedVerifiedElectronCache } from "../scripts/lib/electron-binary-cache.js";

describe("verified Electron cache seed", () => {
  it("只把 checksums.json 匹配的官方缓存归档复制到隔离缓存", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aic-electron-cache-seed-"));
    const electronPackageRoot = path.join(root, "package");
    const sourceCacheRoot = path.join(root, "source-cache");
    const sourceArchive = path.join(sourceCacheRoot, "hashed-url", "electron-v43.1.0-darwin-arm64.zip");
    const targetCacheRoot = path.join(root, "target-cache");
    const bytes = Buffer.from("verified-electron-archive");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await Promise.all([
      mkdir(electronPackageRoot, { recursive: true }),
      mkdir(path.dirname(sourceArchive), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(electronPackageRoot, "checksums.json"), JSON.stringify({
        "electron-v43.1.0-darwin-arm64.zip": sha256,
      })),
      writeFile(sourceArchive, bytes),
    ]);
    try {
      const result = await seedVerifiedElectronCache({
        electronPackageRoot,
        archiveName: "electron-v43.1.0-darwin-arm64.zip",
        sourceCacheRoots: [sourceCacheRoot],
        targetCacheRoot,
      });
      expect(result).toMatchObject({ seeded: true, sourceSha256: sha256, targetSha256: sha256 });
      expect(await readFile(path.join(targetCacheRoot, "hashed-url", "electron-v43.1.0-darwin-arm64.zip")))
        .toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("缓存摘要不匹配时不复制并保留联网下载退路", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aic-electron-cache-reject-"));
    const electronPackageRoot = path.join(root, "package");
    const sourceCacheRoot = path.join(root, "source-cache");
    const archiveName = "electron-v43.1.0-darwin-arm64.zip";
    await Promise.all([
      mkdir(electronPackageRoot, { recursive: true }),
      mkdir(sourceCacheRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(electronPackageRoot, "checksums.json"), JSON.stringify({
        [archiveName]: "a".repeat(64),
      })),
      writeFile(path.join(sourceCacheRoot, archiveName), "corrupt"),
    ]);
    try {
      await expect(seedVerifiedElectronCache({
        electronPackageRoot,
        archiveName,
        sourceCacheRoots: [sourceCacheRoot],
        targetCacheRoot: path.join(root, "target-cache"),
      })).resolves.toMatchObject({ seeded: false, expectedSha256: "a".repeat(64) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
