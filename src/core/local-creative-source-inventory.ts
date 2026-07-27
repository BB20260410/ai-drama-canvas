import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  LocalCreativeProjectIngestPreview,
  LocalCreativeSourceLayerRole,
} from "./local-creative-project-ingest.js";

export interface LocalCreativeSourceInventoryLayer {
  role: string;
  rootPath: string;
  maxDepth?: number;
  excludeRelativePrefixes?: string[];
}

export interface LocalCreativeSourceInventorySnapshot {
  schemaVersion: 1;
  kind: "local-creative-source-inventory";
  totalFiles: number;
  totalBytes: number;
  maxMtimeMs: number;
  byMediaKind?: Record<"document" | "image" | "video" | "audio", number>;
  eligibleTextDocuments?: number;
  /** 新盘点为 sha256；旧进度未带内容摘要时可能为 metadata。 */
  contentIdentity?: "sha256" | "metadata";
  /** 含 mtime 的扫描诊断 token；不作为内容 currentness 身份。 */
  scanFingerprint?: string;
  layers: Array<{
    role: string;
    rootPath: string;
    totalFiles: number;
    totalBytes: number;
    maxMtimeMs: number;
  }>;
  fingerprint: string;
  scannedAt: string;
}

const SUPPORTED_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".docx", ".pdf",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".avif", ".svg",
  ".mp4", ".mov", ".webm", ".m4v", ".mkv", ".avi",
  ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg",
]);
const DOCUMENT_EXTENSIONS = new Set([".md", ".txt", ".json", ".docx", ".pdf"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".avif", ".svg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv", ".avi"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"]);
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git", ".aicanvas", "node_modules", "cache", "caches", "tmp", "temp", "__pycache__",
]);
const CACHE_TTL_MS = 5_000;
const MAX_CONCURRENT_INVENTORIES = 2;
let activeInventories = 0;
const inventoryWaiters: Array<{
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}> = [];
const inventoryCache = new Map<string, {
  expiresAt: number;
  promise: Promise<LocalCreativeSourceInventorySnapshot>;
}>();

function inventoryAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  const error = new Error(
    reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "来源内容盘点已取消。",
  );
  error.name = "AbortError";
  return error;
}

function throwIfInventoryAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw inventoryAbortError(signal);
}

function releaseNextInventoryWaiter(): void {
  while (inventoryWaiters.length) {
    const waiter = inventoryWaiters.shift()!;
    waiter.signal?.removeEventListener("abort", waiter.onAbort!);
    if (waiter.signal?.aborted) {
      waiter.reject(inventoryAbortError(waiter.signal));
      continue;
    }
    waiter.resolve();
    break;
  }
}

async function withInventoryPermit<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfInventoryAborted(signal);
  if (activeInventories >= MAX_CONCURRENT_INVENTORIES) {
    await new Promise<void>((resolve, reject) => {
      const waiter: (typeof inventoryWaiters)[number] = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = inventoryWaiters.indexOf(waiter);
        if (index >= 0) inventoryWaiters.splice(index, 1);
        signal?.removeEventListener("abort", waiter.onAbort!);
        reject(inventoryAbortError(signal));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      inventoryWaiters.push(waiter);
    });
  }
  throwIfInventoryAborted(signal);
  activeInventories += 1;
  try {
    return await work();
  } finally {
    activeInventories -= 1;
    releaseNextInventoryWaiter();
  }
}

function normalizedRelative(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function normalizedLayer(layer: LocalCreativeSourceInventoryLayer): LocalCreativeSourceInventoryLayer {
  return {
    role: layer.role.normalize("NFC").trim(),
    rootPath: path.resolve(layer.rootPath),
    ...(layer.maxDepth === undefined ? {} : { maxDepth: layer.maxDepth }),
    ...(!layer.excludeRelativePrefixes?.length ? {} : {
      excludeRelativePrefixes: [...new Set(layer.excludeRelativePrefixes
        .map((entry) => normalizedRelative(entry.normalize("NFC").trim()).replace(/^\.\/+/u, "").replace(/\/+$/u, ""))
        .filter(Boolean))].sort((left, right) => left.localeCompare(right, "en")),
    }),
  };
}

function cacheKey(layers: LocalCreativeSourceInventoryLayer[]): string {
  return digest(layers.map(normalizedLayer));
}

function finalizeSnapshot(
  layers: LocalCreativeSourceInventorySnapshot["layers"],
  files: Array<{
    role: string;
    rootPath: string;
    relativePath: string;
    sizeBytes: number;
    mtimeMs: number;
    sha256?: string;
  }>,
): LocalCreativeSourceInventorySnapshot {
  const orderedFiles = [...files].sort((left, right) => (
    left.role.localeCompare(right.role, "en")
    || left.rootPath.localeCompare(right.rootPath, "en")
    || left.relativePath.localeCompare(right.relativePath, "en")
  ));
  const body = {
    schemaVersion: 1 as const,
    kind: "local-creative-source-inventory" as const,
    totalFiles: orderedFiles.length,
    totalBytes: orderedFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
    maxMtimeMs: orderedFiles.reduce((maximum, file) => Math.max(maximum, file.mtimeMs), 0),
    byMediaKind: orderedFiles.reduce((counts, file) => {
      const extension = path.extname(file.relativePath).toLocaleLowerCase("en-US");
      if (DOCUMENT_EXTENSIONS.has(extension)) counts.document += 1;
      else if (IMAGE_EXTENSIONS.has(extension)) counts.image += 1;
      else if (VIDEO_EXTENSIONS.has(extension)) counts.video += 1;
      else if (AUDIO_EXTENSIONS.has(extension)) counts.audio += 1;
      return counts;
    }, { document: 0, image: 0, video: 0, audio: 0 }),
    eligibleTextDocuments: orderedFiles.filter((file) => {
      const extension = path.extname(file.relativePath).toLocaleLowerCase("en-US");
      return extension === ".md" || extension === ".txt";
    }).length,
    contentIdentity: orderedFiles.every((file) => typeof file.sha256 === "string")
      ? "sha256" as const
      : "metadata" as const,
    layers: [...layers].sort((left, right) => (
      left.role.localeCompare(right.role, "en") || left.rootPath.localeCompare(right.rootPath, "en")
    )),
  };
  const contentAddressed = body.contentIdentity === "sha256";
  const contentFingerprint = digest({
    layers: body.layers.map((layer) => ({
      role: layer.role,
      rootPath: layer.rootPath,
      totalFiles: layer.totalFiles,
      totalBytes: layer.totalBytes,
      ...(!contentAddressed ? { maxMtimeMs: layer.maxMtimeMs } : {}),
    })),
    files: orderedFiles.map((file) => ({
      role: file.role,
      rootPath: file.rootPath,
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      ...(!file.sha256 ? { mtimeMs: file.mtimeMs } : {}),
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
    })),
  });
  const scanFingerprint = digest({
    layers: body.layers,
    files: orderedFiles.map((file) => ({
      role: file.role,
      rootPath: file.rootPath,
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      mtimeMs: file.mtimeMs,
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
    })),
  });
  return {
    ...body,
    fingerprint: contentFingerprint,
    scanFingerprint,
    scannedAt: new Date().toISOString(),
  };
}

export function localCreativeSourceInventoryFromPreview(
  preview: LocalCreativeProjectIngestPreview,
): LocalCreativeSourceInventorySnapshot {
  const files = preview.files.map((file) => ({
    role: file.sourceLayer.role,
    rootPath: file.sourceLayer.rootPath,
    relativePath: file.relativePath,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    ...(file.sha256 ? { sha256: file.sha256 } : {}),
  }));
  const layers = preview.sourceLayers.map((layer) => {
    const layerFiles = files.filter((file) => (
      file.role === layer.role && file.rootPath === layer.rootPath
    ));
    return {
      role: layer.role,
      rootPath: layer.rootPath,
      totalFiles: layerFiles.length,
      totalBytes: layerFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
      maxMtimeMs: layerFiles.reduce((maximum, file) => Math.max(maximum, file.mtimeMs), 0),
    };
  });
  return finalizeSnapshot(layers, files);
}

async function inspectLayer(
  input: LocalCreativeSourceInventoryLayer,
  hashContents: boolean,
  signal?: AbortSignal,
): Promise<{
  layer: LocalCreativeSourceInventorySnapshot["layers"][number];
  files: Array<{
    role: string;
    rootPath: string;
    relativePath: string;
    sizeBytes: number;
    mtimeMs: number;
    sha256?: string;
  }>;
}> {
  throwIfInventoryAborted(signal);
  const normalized = normalizedLayer(input);
  const rootMetadata = await lstat(normalized.rootPath);
  throwIfInventoryAborted(signal);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`source layer 必须是非符号链接真实目录：${normalized.rootPath}`);
  }
  const rootPath = await realpath(normalized.rootPath);
  if (rootPath !== normalized.rootPath) throw new Error(`source layer realpath 已漂移：${normalized.rootPath}`);
  const excludedPrefixes = normalized.excludeRelativePrefixes ?? [];
  const isExcluded = (relativePath: string): boolean => excludedPrefixes.some((prefix) => (
    relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  ));
  const files: Array<{
    role: string;
    rootPath: string;
    relativePath: string;
    sizeBytes: number;
    mtimeMs: number;
    sha256?: string;
  }> = [];

  const walk = async (directory: string, directoryDepth: number): Promise<void> => {
    throwIfInventoryAborted(signal);
    const entries = await readdir(directory, { withFileTypes: true });
    throwIfInventoryAborted(signal);
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      throwIfInventoryAborted(signal);
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizedRelative(path.relative(rootPath, absolutePath));
      if (isExcluded(relativePath)) continue;
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        const nextDepth = directoryDepth + 1;
        if (!IGNORED_DIRECTORY_NAMES.has(entry.name.toLocaleLowerCase("en-US"))
          && (normalized.maxDepth === undefined || nextDepth < normalized.maxDepth)) {
          await walk(absolutePath, nextDepth);
        }
        continue;
      }
      if (!metadata.isFile() || !SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLocaleLowerCase("en-US"))) continue;
      let sha256: string | undefined;
      if (hashContents) {
        const hash = createHash("sha256");
        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(absolutePath, { signal });
          stream.on("data", (chunk) => hash.update(chunk));
          stream.on("error", reject);
          stream.on("end", resolve);
        });
        throwIfInventoryAborted(signal);
        const after = await lstat(absolutePath);
        if (!after.isFile() || after.isSymbolicLink()
          || after.size !== metadata.size
          || Math.trunc(after.mtimeMs) !== Math.trunc(metadata.mtimeMs)) {
          throw new Error(`SOURCE_RACE_DETECTED：来源文件在内容盘点期间变化：${absolutePath}`);
        }
        sha256 = hash.digest("hex");
      }
      files.push({
        role: normalized.role,
        rootPath,
        relativePath,
        sizeBytes: metadata.size,
        mtimeMs: Math.trunc(metadata.mtimeMs),
        ...(sha256 ? { sha256 } : {}),
      });
    }
  };
  await walk(rootPath, 0);
  return {
    layer: {
      role: normalized.role,
      rootPath,
      totalFiles: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      maxMtimeMs: files.reduce((maximum, file) => Math.max(maximum, file.mtimeMs), 0),
    },
    files,
  };
}

export async function inspectLocalCreativeSourceInventory(
  layers: LocalCreativeSourceInventoryLayer[],
  options: { cache?: boolean; hashContents?: boolean; signal?: AbortSignal } = {},
): Promise<LocalCreativeSourceInventorySnapshot> {
  throwIfInventoryAborted(options.signal);
  const normalized = layers.map(normalizedLayer);
  const hashContents = options.hashContents !== false;
  const key = `${cacheKey(normalized)}:${hashContents ? "sha256" : "metadata"}`;
  // 带 signal 的调用必须拥有可真正取消的独立扫描，不能把一个调用方的
  // abort 传播给其他共享同一 cache promise 的读取者。
  const useCache = options.cache !== false && options.signal === undefined;
  if (useCache) {
    const cached = inventoryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
  }
  const promise = withInventoryPermit(async () => {
    const inspected = [];
    // 单工程内部顺序盘点，避免多个大来源树同时争抢磁盘。
    for (const layer of normalized) {
      throwIfInventoryAborted(options.signal);
      inspected.push(await inspectLayer(layer, hashContents, options.signal));
    }
    return finalizeSnapshot(
      inspected.map((entry) => entry.layer),
      inspected.flatMap((entry) => entry.files),
    );
  }, options.signal);
  // 在途扫描永不过期：大型来源树可能超过 TTL，仍必须让并发调用复用同一 Promise。
  // TTL 从完成时开始计算，不能从开始时计算后允许第二次全盘 SHA 抢占磁盘。
  if (useCache) inventoryCache.set(key, { expiresAt: Number.POSITIVE_INFINITY, promise });
  try {
    const result = await promise;
    if (useCache) {
      const cached = inventoryCache.get(key);
      if (cached?.promise === promise) cached.expiresAt = Date.now() + CACHE_TTL_MS;
    }
    return result;
  } catch (error) {
    if (useCache && inventoryCache.get(key)?.promise === promise) inventoryCache.delete(key);
    throw error;
  }
}

export function isLocalCreativeSourceLayerRole(value: string): value is LocalCreativeSourceLayerRole {
  return [
    "PRIMARY_AUTHORITY",
    "ACTIVE_PRODUCTION",
    "UPSTREAM_SCRIPT",
    "LEGACY_HISTORY",
    "EXPORT",
    "UNASSIGNED_INBOX",
  ].includes(value);
}
