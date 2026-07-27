import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { resolveLegacyThumbnail } from "../src/core/legacy-thumbnails.js";

const temporaryRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "p18-legacy-thumbnails-"));
  temporaryRoots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("P18 旧画布缩略图管线", () => {
  it("从大图生成 512 内 WebP，二次调用命中同一缓存路径", async () => {
    const root = await makeTempRoot();
    const cacheRoot = path.join(root, "cache");
    const sourcePath = path.join(root, "big.png");
    await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#314653" } }).png().toFile(sourcePath);

    const first = await resolveLegacyThumbnail(cacheRoot, sourcePath);
    expect(first).not.toBeNull();
    const metadata = await sharp(first!.path).metadata();
    expect(metadata.format).toBe("webp");
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(512);

    const second = await resolveLegacyThumbnail(cacheRoot, sourcePath);
    expect(second?.path).toBe(first!.path);
  });

  it("源文件变更后按新键重新生成，不返回旧缓存", async () => {
    const root = await makeTempRoot();
    const cacheRoot = path.join(root, "cache");
    const sourcePath = path.join(root, "big.png");
    await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#314653" } }).png().toFile(sourcePath);
    const first = await resolveLegacyThumbnail(cacheRoot, sourcePath);
    expect(first).not.toBeNull();

    await sharp({ create: { width: 800, height: 600, channels: 3, background: "#533131" } }).png().toFile(sourcePath);
    const future = new Date(Date.now() + 10_000);
    await utimes(sourcePath, future, future);
    const second = await resolveLegacyThumbnail(cacheRoot, sourcePath);
    expect(second).not.toBeNull();
    expect(second!.path).not.toBe(first!.path);
  });

  it("缺失或不可解码源返回 null，由调用方回退原图", async () => {
    const root = await makeTempRoot();
    const cacheRoot = path.join(root, "cache");
    expect(await resolveLegacyThumbnail(cacheRoot, path.join(root, "missing.png"))).toBeNull();
    const corruptPath = path.join(root, "corrupt.png");
    await writeFile(corruptPath, "not an image", "utf8");
    expect(await resolveLegacyThumbnail(cacheRoot, corruptPath)).toBeNull();
  });

  it("不写入工程目录：缓存只落在调用方指定的 cacheRoot", async () => {
    const root = await makeTempRoot();
    const projectRoot = path.join(root, "project");
    const cacheRoot = path.join(root, "userdata-cache");
    await mkdir(projectRoot, { recursive: true });
    const sourcePath = path.join(projectRoot, "frame.png");
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#314653" } }).png().toFile(sourcePath);
    const result = await resolveLegacyThumbnail(cacheRoot, sourcePath);
    expect(result).not.toBeNull();
    expect(result!.path.startsWith(cacheRoot)).toBe(true);
    const entries = await readdir(projectRoot);
    expect(entries.filter((entry) => entry.endsWith(".webp"))).toEqual([]);
  });

  it("合同：协议入口与节点组件均接入缩略图链路", () => {
    const main = readFileSync(path.join(process.cwd(), "src/main/index.ts"), "utf8");
    expect(main).toContain("resolveLegacyThumbnail");
    expect(main).toContain('url.searchParams.get("thumb") === "1"');
    const node = readFileSync(path.join(process.cwd(), "src/renderer/src/components/ProductionNode.vue"), "utf8");
    expect(node).toContain("assetThumbnailUrl");
    expect(node).not.toContain("assetUrl(");
    const utils = readFileSync(path.join(process.cwd(), "src/renderer/src/utils.ts"), "utf8");
    expect(utils).toContain("&thumb=1");
  });
});
