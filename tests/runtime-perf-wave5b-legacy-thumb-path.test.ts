import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEGACY_THUMBNAIL_PLACEHOLDER_WEBP } from "../src/core/legacy-thumbnails.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("Wave 5-B legacy thumb=1 走磁盘路径，失败占位", () => {
  it("占位图是小 WebP，不是 4K 回退通道", () => {
    expect(LEGACY_THUMBNAIL_PLACEHOLDER_WEBP.byteLength).toBeLessThan(256);
    expect(LEGACY_THUMBNAIL_PLACEHOLDER_WEBP.subarray(0, 4).toString("ascii")).toBe("RIFF");
  });

  it("协议 thumb=1 先 sharp(path)，失败不回退 asset.bytes", () => {
    const main = source("src/main/index.ts");
    expect(main).toContain("hashResolvedLegacyAssetFile");
    expect(main).toContain("resolveLegacyThumbnail(");
    expect(main).toContain("LEGACY_THUMBNAIL_PLACEHOLDER_WEBP");
    expect(main).not.toContain("resolveLegacyThumbnailFromBytes");
    const handlerStart = main.indexOf('protocol.handle("aicanvas-asset"');
    const handlerEnd = main.indexOf("registerIpc()", handlerStart);
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handler = main.slice(handlerStart, handlerEnd);
    const thumbAt = handler.indexOf('url.searchParams.get("thumb") === "1"');
    const readBytesAt = handler.indexOf("readLegacyAssetBytes");
    expect(thumbAt).toBeGreaterThan(-1);
    expect(readBytesAt).toBeGreaterThan(thumbAt);
    expect(handler).not.toContain("回退原图");
    expect(handler).not.toMatch(/thumb" === "1"[\s\S]{0,900}asset\.bytes/u);
  });

  it("未改 legacy 512 WebP 参数，且 sharp 首次仍走路径而不是整文件 Buffer", () => {
    const thumbs = source("src/core/legacy-thumbnails.ts");
    expect(thumbs).toContain("const LEGACY_THUMBNAIL_MAX_EDGE = 512");
    expect(thumbs).toContain("const LEGACY_THUMBNAIL_WEBP_QUALITY = 82");
    expect(thumbs).toContain('loadSharpDefault())(absolutePath, { failOn: "error" })');
    expect(thumbs).toContain("调用方占位，不回退原图 bytes");
  });
});
