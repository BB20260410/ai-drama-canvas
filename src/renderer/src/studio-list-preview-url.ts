/**
 * Wave 5-A：列表 / 审片并排默认只绑缩略图。
 * 禁止 thumbnail 缺失时回退 mediaUrl（aicanvas-studio://media/<sha> 全尺寸原图）。
 * 原图仅 showOriginal=true（用户显式打开）时返回。
 */

export function listOrWorkbenchPreviewUrl(input: {
  thumbnailUrl?: string | null;
  mediaUrl?: string | null;
  showOriginal?: boolean;
}): string {
  const original = typeof input.mediaUrl === "string" ? input.mediaUrl.trim() : "";
  const thumbnail = typeof input.thumbnailUrl === "string" ? input.thumbnailUrl.trim() : "";
  if (input.showOriginal) return original;
  return thumbnail;
}

export function reviewMediaDisplayUrls(
  media: { mediaUrl?: string | null; thumbnail?: { url?: string | null } | null } | null | undefined,
): { thumbnailUrl: string; originalUrl: string } {
  return {
    thumbnailUrl: listOrWorkbenchPreviewUrl({
      thumbnailUrl: media?.thumbnail?.url,
      mediaUrl: media?.mediaUrl,
    }),
    originalUrl: listOrWorkbenchPreviewUrl({
      thumbnailUrl: media?.thumbnail?.url,
      mediaUrl: media?.mediaUrl,
      showOriginal: true,
    }),
  };
}
