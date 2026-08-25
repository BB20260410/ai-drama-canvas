import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { loadSharpDefault } from "./sharp-lazy.js";

/**
 * 旧生产画布节点缩略图（P18）。
 *
 * 受管素材中心已有 512px WebP 配方（materializeThumbnail）；旧画布节点此前直接解码原始大图
 * （P18 实测：可见节点全部请求 3840×2160 原图，平移换入新节点时出现 58.5ms 帧尖峰）。
 *
 * 设计约束：
 * - 缓存在应用 userData 下，不写入工程目录（遵守工程目录只读红线）；
 * - 键为 绝对路径+mtime+大小 的 SHA-256，源文件变更自动失效；
 * - 只在协议请求到达时懒生成，不预扫全库（canvas-scale-performance 反模式）。
 */

const LEGACY_THUMBNAIL_MAX_EDGE = 512;
const LEGACY_THUMBNAIL_WEBP_QUALITY = 82;
/** 1×1 透明 WebP。thumb=1 失败时占位，禁止把 4K 原图 bytes 回退给 <img>。 */
export const LEGACY_THUMBNAIL_PLACEHOLDER_WEBP = Buffer.from(
  "UklGRkAAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAQAFZQOCAYAAAAMAEAnQEqAQABAAzAziWkAANwAP7sZwAA",
  "base64",
);
/** F-10（main 审查）：缓存总量上限——超出时按 mtime 最旧先淘汰（保守方向：多淘汰不漏可用项，漏网项会懒重生成）。 */
const LEGACY_THUMBNAIL_CACHE_MAX_ENTRIES = 2_000;

/** 缓存容量维护：条目超限时按修改时间最旧先删（含临时文件孤儿）。 */
async function pruneLegacyThumbnailCache(cacheRoot: string): Promise<void> {
  try {
    const entries = await readdir(cacheRoot, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    if (files.length <= LEGACY_THUMBNAIL_CACHE_MAX_ENTRIES) return;
    const withStats = await Promise.all(files.map(async (name) => {
      const filePath = path.join(cacheRoot, name);
      const metadata = await stat(filePath).catch(() => null);
      return metadata ? { filePath, mtimeMs: metadata.mtimeMs } : null;
    }));
    const sorted = withStats.filter((entry): entry is { filePath: string; mtimeMs: number } => Boolean(entry)).sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of sorted.slice(0, files.length - LEGACY_THUMBNAIL_CACHE_MAX_ENTRIES)) {
      await rm(entry.filePath, { force: true }).catch(() => undefined);
    }
  } catch {
    // 容量维护失败不阻断缩略图服务。
  }
}

export interface LegacyThumbnailResult {
  path: string;
  width: number;
  height: number;
}

function legacyThumbnailKey(absolutePath: string, mtimeMs: number, size: number): string {
  return createHash("sha256").update(`${absolutePath}\0${mtimeMs}\0${size}`, "utf8").digest("hex");
}

function legacyThumbnailBytesKey(sourceIdentity: string, bytes: Buffer): string {
  return createHash("sha256")
    .update(`${sourceIdentity}\0${bytes.byteLength}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

async function existingThumbnail(target: string): Promise<LegacyThumbnailResult | null> {
  try {
    const existing = await lstat(target);
    if (existing.isFile() && !existing.isSymbolicLink()) {
      const metadata = await (await loadSharpDefault())(target, { failOn: "error" }).metadata();
      if (metadata.width && metadata.height && metadata.format === "webp") {
        return { path: target, width: metadata.width, height: metadata.height };
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") await rm(target, { force: true }).catch(() => undefined);
  }
  return null;
}

/** 协议安全路径：只从调用方已用同一文件句柄验证过的字节派生，不重新解析源路径。 */
export async function resolveLegacyThumbnailFromBytes(
  cacheRoot: string,
  sourceIdentity: string,
  bytes: Buffer,
): Promise<LegacyThumbnailResult | null> {
  const key = legacyThumbnailBytesKey(sourceIdentity, bytes);
  const target = path.join(cacheRoot, `${key}.webp`);
  const existing = await existingThumbnail(target);
  if (existing) return existing;
  try {
    await mkdir(cacheRoot, { recursive: true });
    const temporary = path.join(cacheRoot, `.${key}.${randomUUID()}.tmp.webp`);
    try {
      const result = await (await loadSharpDefault())(bytes, { failOn: "error" })
        .rotate()
        .resize({ width: LEGACY_THUMBNAIL_MAX_EDGE, height: LEGACY_THUMBNAIL_MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .webp({ quality: LEGACY_THUMBNAIL_WEBP_QUALITY })
        .toFile(temporary);
      if (!result.width || !result.height || Math.max(result.width, result.height) > LEGACY_THUMBNAIL_MAX_EDGE) return null;
      await rename(temporary, target);
      await pruneLegacyThumbnailCache(cacheRoot);
      return { path: target, width: result.width, height: result.height };
    } catch {
      return null;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  } catch {
    return null;
  }
}

/** 返回可用缩略图；源不可读、非普通文件、不可解码或缓存目录不可写时返回 null（调用方占位，不回退原图 bytes）。 */
export async function resolveLegacyThumbnail(cacheRoot: string, absolutePath: string): Promise<LegacyThumbnailResult | null> {
  let sourceStats: Awaited<ReturnType<typeof stat>>;
  try {
    sourceStats = await stat(absolutePath);
  } catch {
    return null;
  }
  if (!sourceStats.isFile()) return null;
  const key = legacyThumbnailKey(absolutePath, sourceStats.mtimeMs, sourceStats.size);
  const target = path.join(cacheRoot, `${key}.webp`);
  const existing = await existingThumbnail(target);
  if (existing) return existing;
  try {
    // mkdir 必须在 try 内：缓存目录不可写时返回 null，由协议回占位 WebP，绝不回退 4K 原图 bytes。
    await mkdir(cacheRoot, { recursive: true });
    const temporary = path.join(cacheRoot, `.${key}.${randomUUID()}.tmp.webp`);
    try {
      const result = await (await loadSharpDefault())(absolutePath, { failOn: "error" })
        .rotate()
        .resize({ width: LEGACY_THUMBNAIL_MAX_EDGE, height: LEGACY_THUMBNAIL_MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .webp({ quality: LEGACY_THUMBNAIL_WEBP_QUALITY })
        .toFile(temporary);
      if (!result.width || !result.height || Math.max(result.width, result.height) > LEGACY_THUMBNAIL_MAX_EDGE) return null;
      await rename(temporary, target);
      await pruneLegacyThumbnailCache(cacheRoot);
      return { path: target, width: result.width, height: result.height };
    } catch {
      return null;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  } catch {
    return null;
  }
}
