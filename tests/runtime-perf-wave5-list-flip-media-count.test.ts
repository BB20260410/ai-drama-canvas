import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createThumbnailLru } from "../src/renderer/src/use-thumbnail-lru.js";
import { listOrWorkbenchPreviewUrl } from "../src/renderer/src/studio-list-preview-url.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

function pageItems(page: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    thumbnailUrl: `aicanvas-studio://thumbnail/p${page}-${index}?projectRoot=%2Ftmp`,
    mediaUrl: `aicanvas-studio://media/p${page}-${index}?projectRoot=%2Ftmp`,
  }));
}

function countStudioMediaProtocol(urls: readonly string[]): number {
  return urls.filter((url) => url.includes("aicanvas-studio://media/")).length;
}

function sliceBetween(haystack: string, startMarker: string, endMarker: string): string {
  const start = haystack.indexOf(startMarker);
  const end = haystack.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return haystack.slice(start, end);
}

describe("Wave 5 列表翻页原图次数源码合同（非 GUI 探针）", () => {
  it("源码合同：用 helper 合成 2 页×36，默认预览 media 协议次数为 0（不是安装版翻页探针）", () => {
    // 防伪：下列 72 条是 listOrWorkbenchPreviewUrl 合成数据，不是 Electron/Playwright
    // 停留+翻页，也不计数协议层实际请求。不得据此勾 Wave 5 父项或写「列表原图次数已测为 0」。
    const pages = [pageItems(1, 36), pageItems(2, 36)];
    const defaultSrcs = pages.flatMap((page) => page.map((item) => listOrWorkbenchPreviewUrl(item)));
    expect(defaultSrcs).toHaveLength(72);
    expect(countStudioMediaProtocol(defaultSrcs)).toBe(0);
    expect(defaultSrcs.every((src) => src.startsWith("aicanvas-studio://thumbnail/"))).toBe(true);

    const missingThumb = pages.flatMap((page) =>
      page.map((item) => listOrWorkbenchPreviewUrl({ mediaUrl: item.mediaUrl })),
    );
    expect(countStudioMediaProtocol(missingThumb)).toBe(0);
    expect(missingThumb.every((src) => src === "")).toBe(true);

    const explicit = pages.flatMap((page) =>
      page.map((item) => listOrWorkbenchPreviewUrl({ ...item, showOriginal: true })),
    );
    expect(countStudioMediaProtocol(explicit)).toBe(72);
  });

  it("缩略图 LRU 只缓存 URL 字符串，不持媒体二进制", () => {
    const lru = createThumbnailLru(4);
    const url = "aicanvas-studio://thumbnail/recipe-1?projectRoot=%2Ftmp";
    lru.set("k1", url);
    expect(lru.get("k1")).toBe(url);
    expect(typeof lru.get("k1")).toBe("string");
    lru.set("k2", "aicanvas-studio://thumbnail/recipe-2?projectRoot=%2Ftmp");
    lru.set("k3", "aicanvas-studio://thumbnail/recipe-3?projectRoot=%2Ftmp");
    lru.set("k4", "aicanvas-studio://thumbnail/recipe-4?projectRoot=%2Ftmp");
    lru.set("k5", "aicanvas-studio://thumbnail/recipe-5?projectRoot=%2Ftmp");
    expect(lru.size()).toBe(4);
    expect(lru.get("k1")).toBeUndefined();
    const helper = source("src/renderer/src/use-thumbnail-lru.ts");
    expect(helper).toContain("只缓存 URL 字符串，不持媒体二进制");
    expect(helper).toContain("const map = new Map<string, string>()");
    expect(helper).not.toMatch(/ArrayBuffer|Uint8Array|Buffer\.from|readFileSync|blob:/);
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("createThumbnailLru(96)");
    expect(canvas).toContain("aicanvas-studio://thumbnail/${recipeKey.trim()}");
    expect(canvas).toContain("thumbnailLru.clear()");
  });

  it("素材库 / 画布库 / 总资源列表视口默认不绑 media 协议", () => {
    const material = source("src/renderer/src/components/MaterialStudioView.vue");
    const entryList = sliceBetween(material, 'class="entry-collection"', 'class="page-navigation"');
    expect(entryList).toContain(':src="entry.thumbnailUrl"');
    expect(entryList).not.toContain("aicanvas-studio://media/");
    expect(entryList).not.toContain(":src=\"entry.mediaUrl\"");
    expect(entryList).not.toContain(":src=\"version.mediaUrl\"");

    const versionList = sliceBetween(material, 'class="detail-section versions-section"', "version-preview-backdrop");
    expect(versionList).toContain(':src="version.thumbnailUrl"');
    expect(versionList).not.toContain(':src="version.mediaUrl"');

    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const assetList = sliceBetween(
      canvas,
      'data-testid="managed-canvas-assets-virtual-viewport"',
      'data-testid="managed-canvas-assets-prev"',
    );
    expect(assetList).toContain("authorityThumbUrl(asset.authorityThumbnailRecipeKey)");
    expect(assetList).not.toContain("aicanvas-studio://media/");
    const mediaList = sliceBetween(
      canvas,
      'data-testid="managed-canvas-media-library"',
      'data-testid="managed-canvas-media-prev"',
    );
    expect(mediaList).toContain("media.thumbnail.url");
    expect(mediaList).not.toContain("aicanvas-studio://media/");
    const globalList = sliceBetween(
      canvas,
      'data-testid="managed-canvas-global-resource-viewport"',
      'data-testid="managed-canvas-global-resources-prev"',
    );
    expect(globalList).toContain(':src="entry.thumbnailUrl"');
    expect(globalList).not.toContain("aicanvas-studio://media/");

    const resources = source("src/renderer/src/components/GlobalResourceCenterView.vue");
    expect(resources).toContain("aicanvas-studio://thumbnail/${item.thumbnailRecipeKey}");
    expect(resources).toContain("aicanvas-studio://derivative/${item.preview.recipeKey}");
    expect(resources).not.toContain("aicanvas-studio://media/${");
  });

  it("对照表未选中行不绑图；审片并排默认不绑 mediaUrl", () => {
    const align = source("src/renderer/src/components/ScriptMediaAlignView.vue");
    const table = sliceBetween(align, 'data-testid="align-table"', 'data-testid="align-media-preview"');
    expect(table).not.toContain("<img");
    expect(table).not.toContain("aicanvas-studio://media/");
    const review = source("src/renderer/src/components/StudioContinuityReviewView.vue");
    expect(review).toContain("reviewMediaDisplayUrls");
    const loaders = sliceBetween(review, "review-decode-loaders", 'aria-label="原尺寸图片查看"');
    expect(loaders).toContain(':src="rawImageUrl"');
    expect(loaders).toContain(':src="labeledImageUrl"');
    expect(loaders).not.toContain("rawOriginalUrl");
    expect(loaders).not.toContain("labeledOriginalUrl");
    expect(review).not.toContain(':src="raw?.mediaUrl');
    expect(review).not.toContain(':src="labeled?.mediaUrl');
  });
});
