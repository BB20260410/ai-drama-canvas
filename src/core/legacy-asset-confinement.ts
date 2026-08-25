/**
 * P27：aicanvas-asset（legacy）协议根限制（main 审查 F-01）。
 * path 必须落在某个已登记工程 primaryRoot/sourceRoots/outputRoots 的 realpath 之内。
 * 逻辑在 core 以便直接单测；main 的协议处理器只做薄壳调用。
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { getProjectRegistryRevision, listRegisteredProjects, loadProjectConfig } from "./sidecar.js";

/** 纯函数：realpath 后的目标是否位于任一 realpath 根内（含根自身）。 */
export function isPathInsideRoots(resolvedPath: string, roots: readonly string[]): boolean {
  return roots.some((root) => resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`));
}

/** 收集当前全部已登记工程的可服务根（realpath 后、排序去重）。 */
export async function collectLegacyAssetAllowedRoots(): Promise<string[]> {
  const roots = new Set<string>();
  const registered = await listRegisteredProjects().catch(() => []);
  for (const project of registered) {
    const candidates = [project.primaryRoot];
    try {
      const config = await loadProjectConfig(project.primaryRoot);
      candidates.push(...(config.sourceRoots ?? []), ...(config.outputRoots ?? []));
    } catch {
      // 配置不可读时仅按 primaryRoot 收敛，不放行。
    }
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || !candidate.trim()) continue;
      try {
        roots.add(await realpath(candidate));
      } catch {
        // 根不存在时不纳入白名单。
      }
    }
  }
  return [...roots].sort();
}

const ROOTS_CACHE_TTL_MS = 5_000;
let rootsCache: { roots: string[]; at: number; registryRevision: number } | null = null;

async function cachedAllowedRoots(): Promise<string[]> {
  const registryRevision = getProjectRegistryRevision();
  if (!rootsCache
    || rootsCache.registryRevision !== registryRevision
    || Date.now() - rootsCache.at >= ROOTS_CACHE_TTL_MS) {
    rootsCache = { roots: await collectLegacyAssetAllowedRoots(), at: Date.now(), registryRevision };
  }
  return rootsCache.roots;
}

const LEGACY_UNHASHED_MEDIA_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
  ".mp4", ".webm", ".mov", ".mp3", ".wav", ".m4a", ".aac",
]);

/** 未携带内容 SHA 的兼容请求只允许可直接展示的媒体扩展名。 */
export function isLegacyUnhashedMediaPathAllowed(canonicalPath: string): boolean {
  return LEGACY_UNHASHED_MEDIA_EXTENSIONS.has(path.extname(canonicalPath).toLowerCase());
}

/** 返回无符号链接、位于登记根内的规范普通文件路径；否则 null。 */
export async function resolveLegacyAssetPath(absolutePath: string): Promise<string | null> {
  if (!path.isAbsolute(absolutePath)) return null;
  try {
    const before = await lstat(absolutePath, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) return null;
    const resolved = await realpath(absolutePath);
    if (!isPathInsideRoots(resolved, await cachedAllowedRoots())) return null;
    const after = await lstat(resolved, { bigint: true });
    if (after.isSymbolicLink() || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino) return null;
    return resolved;
  } catch {
    return null;
  }
}

/**
 * 协议读取从同一个 no-follow 文件句柄完成，并在前后复验 inode/mtime/size；
 * 调用方可直接使用返回字节制缩略图，避免 check→read 或 check→sharp 再解析路径。
 */
export async function readLegacyAssetBytes(absolutePath: string): Promise<{
  canonicalPath: string;
  bytes: Buffer;
  sha256: string;
} | null> {
  const canonicalPath = await resolveLegacyAssetPath(absolutePath);
  if (!canonicalPath) return null;
  const pathBefore = await lstat(canonicalPath, { bigint: true });
  const handle = await open(canonicalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    if (!descriptorBefore.isFile()
      || descriptorBefore.dev !== pathBefore.dev
      || descriptorBefore.ino !== pathBefore.ino) return null;
    const bytes = await handle.readFile();
    const [descriptorAfter, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(canonicalPath, { bigint: true }),
    ]);
    if (pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || descriptorAfter.dev !== descriptorBefore.dev
      || descriptorAfter.ino !== descriptorBefore.ino
      || descriptorAfter.size !== descriptorBefore.size
      || descriptorAfter.mtimeNs !== descriptorBefore.mtimeNs
      || descriptorAfter.ctimeNs !== descriptorBefore.ctimeNs
      || pathAfter.dev !== descriptorBefore.dev
      || pathAfter.ino !== descriptorBefore.ino
      || pathAfter.size !== descriptorBefore.size
      || bytes.byteLength !== Number(descriptorBefore.size)) return null;
    return {
      canonicalPath,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Wave 5-B：校验内容 SHA 时只流式哈希，不把整文件留在内存。
 * 调用方必须先 `resolveLegacyAssetPath`；本函数不再重复根判定。
 */
export async function hashResolvedLegacyAssetFile(canonicalPath: string): Promise<string | null> {
  if (!path.isAbsolute(canonicalPath)) return null;
  try {
    const pathBefore = await lstat(canonicalPath, { bigint: true });
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) return null;
    const handle = await open(canonicalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const descriptorBefore = await handle.stat({ bigint: true });
      if (!descriptorBefore.isFile()
        || descriptorBefore.dev !== pathBefore.dev
        || descriptorBefore.ino !== pathBefore.ino) return null;
      const hash = createHash("sha256");
      const chunk = Buffer.alloc(64 * 1024);
      let remaining = Number(descriptorBefore.size);
      while (remaining > 0) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, remaining), null);
        if (bytesRead < 1) return null;
        hash.update(chunk.subarray(0, bytesRead));
        remaining -= bytesRead;
      }
      const [descriptorAfter, pathAfter] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(canonicalPath, { bigint: true }),
      ]);
      if (pathAfter.isSymbolicLink()
        || !pathAfter.isFile()
        || descriptorAfter.dev !== descriptorBefore.dev
        || descriptorAfter.ino !== descriptorBefore.ino
        || descriptorAfter.size !== descriptorBefore.size
        || descriptorAfter.mtimeNs !== descriptorBefore.mtimeNs
        || descriptorAfter.ctimeNs !== descriptorBefore.ctimeNs
        || pathAfter.dev !== descriptorBefore.dev
        || pathAfter.ino !== descriptorBefore.ino
        || pathAfter.size !== descriptorBefore.size) return null;
      return hash.digest("hex");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** 带 5s 缓存的判定（协议按图片逐请求调用，避免每次重读注册表）。 */
export async function isLegacyAssetPathAllowed(absolutePath: string): Promise<boolean> {
  return (await resolveLegacyAssetPath(absolutePath)) !== null;
}

/** 测试专用：清空根缓存。 */
export function resetLegacyAssetConfinementCacheForTests(): void {
  rootsCache = null;
}
