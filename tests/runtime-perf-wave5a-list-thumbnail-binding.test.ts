import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";
import {
  listOrWorkbenchPreviewUrl,
  reviewMediaDisplayUrls,
} from "../src/renderer/src/studio-list-preview-url.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("Wave 5-A 列表/审片默认只绑 thumbnail", () => {
  it("纯函数：默认不回退 mediaUrl，显式打开才返回原图", () => {
    const thumb = "aicanvas-studio://thumbnail/abc?projectRoot=%2Ftmp";
    const original = "aicanvas-studio://media/abc?projectRoot=%2Ftmp";
    expect(listOrWorkbenchPreviewUrl({ thumbnailUrl: thumb, mediaUrl: original })).toBe(thumb);
    expect(listOrWorkbenchPreviewUrl({ thumbnailUrl: thumb, mediaUrl: original, showOriginal: true })).toBe(original);
    expect(listOrWorkbenchPreviewUrl({ mediaUrl: original })).toBe("");
    expect(listOrWorkbenchPreviewUrl({ mediaUrl: original, showOriginal: true })).toBe(original);
    expect(listOrWorkbenchPreviewUrl({})).toBe("");
    expect(reviewMediaDisplayUrls({ mediaUrl: original, thumbnail: { url: thumb } })).toEqual({
      thumbnailUrl: thumb,
      originalUrl: original,
    });
    expect(reviewMediaDisplayUrls({ mediaUrl: original })).toEqual({
      thumbnailUrl: "",
      originalUrl: original,
    });
  });

  it("对照网格未选中行不绑图；选中预览默认 thumbnail，原图显式打开", () => {
    const vue = source("src/renderer/src/components/ScriptMediaAlignView.vue");
    expect(parse(vue, { filename: "ScriptMediaAlignView.vue" }).errors).toEqual([]);
    expect(vue).toContain("listOrWorkbenchPreviewUrl");
    expect(vue).toContain('data-testid="align-open-original"');
    expect(vue).toContain("alignShowOriginal");
    expect(vue).not.toContain("thumbnailUrl || selectedMediaPreview.mediaUrl");
    expect(vue).not.toContain("thumbnailUrl || mediaUrl");
    const tableStart = vue.indexOf('data-testid="align-table"');
    const previewStart = vue.indexOf('data-testid="align-media-preview"');
    expect(tableStart).toBeGreaterThan(-1);
    expect(previewStart).toBeGreaterThan(tableStart);
    const table = vue.slice(tableStart, previewStart);
    expect(table).not.toContain("<img");
    expect(table).not.toContain("mediaUrl");
    expect(table).not.toContain("thumbnailUrl");
  });

  it("审片并排/解码器只绑 thumbnail；原图只进 original-preview；差分仍可读原图字节", () => {
    const vue = source("src/renderer/src/components/StudioContinuityReviewView.vue");
    expect(parse(vue, { filename: "StudioContinuityReviewView.vue" }).errors).toEqual([]);
    expect(vue).toContain("reviewMediaDisplayUrls");
    expect(vue).toContain("rawOriginalUrl");
    expect(vue).toContain("labeledOriginalUrl");
    expect(vue).toContain("originalUrlOf(originalPreview)");
    expect(vue).toContain("onOriginalPreviewLoad");
    expect(vue).not.toContain("raw?.mediaUrl ?? raw?.thumbnail");
    expect(vue).not.toContain("labeled?.mediaUrl ?? labeled?.thumbnail");
    expect(vue).not.toContain("已按原尺寸解码");
    expect(vue).toContain("审片缩略图已加载并可圈选提交");
    expect(vue).toContain("readStudioMediaBytes");
    expect(vue).toContain("MAX_DIFFERENCE_LONG_EDGE");
    const loaderAt = vue.indexOf("review-decode-loaders");
    const originalAt = vue.indexOf('aria-label="原尺寸图片查看"');
    expect(loaderAt).toBeGreaterThan(-1);
    expect(originalAt).toBeGreaterThan(loaderAt);
    const loaders = vue.slice(loaderAt, originalAt);
    expect(loaders).toContain(":src=\"rawImageUrl\"");
    expect(loaders).toContain(":src=\"labeledImageUrl\"");
    expect(loaders).not.toContain("rawOriginalUrl");
    expect(loaders).not.toContain("labeledOriginalUrl");
  });
});
