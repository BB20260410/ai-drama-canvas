import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { getStudioMedia } from "./material-studio.js";
import { resolveStudioMediaRequest } from "./studio-media-protocol.js";

export type StudioNativeMediaDragKind = "image" | "video" | "audio";

export interface PrepareStudioNativeMediaDragInput {
  projectRoot: string;
  mediaSha256: string;
  exportRoot: string;
  suggestedName?: string;
}

export interface PreparedStudioNativeMediaDragCopy {
  exportPath: string;
  temporaryDirectory: string;
  fileName: string;
  kind: StudioNativeMediaDragKind;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
}

const MEDIA_MIME_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/tiff": ".tif",
  "image/bmp": ".bmp",
  "image/heic": ".heic",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/x-m4v": ".m4v",
  "video/x-msvideo": ".avi",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/ogg": ".ogg",
});

function normalizeSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error("mediaSha256 无效。");
  }
  return normalized;
}

function safeExtension(mimeType: string, kind: StudioNativeMediaDragKind): string {
  return MEDIA_MIME_EXTENSION[mimeType.toLowerCase()]
    ?? (kind === "image" ? ".png" : kind === "video" ? ".mp4" : ".wav");
}

export function sanitizeStudioNativeMediaDragBasename(
  value: string | undefined,
  fallback: string,
): string {
  const raw = (value ?? "").trim() || fallback;
  const withoutPath = raw.replaceAll("\\", "/").split("/").at(-1) || fallback;
  const parsed = path.parse(withoutPath);
  return (parsed.name || fallback)
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^[_\s.]+|[_\s.]+$/gu, "")
    .slice(0, 96) || fallback;
}

async function hashStableRegularFile(filePath: string): Promise<{
  sha256: string;
  sizeBytes: number;
}> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const pathBefore = await lstat(filePath, { bigint: true });
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
      throw new Error("拖出复制体不是普通文件。");
    }
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const descriptorBefore = await handle.stat({ bigint: true });
    if (!descriptorBefore.isFile()
      || descriptorBefore.dev !== pathBefore.dev
      || descriptorBefore.ino !== pathBefore.ino) {
      throw new Error("拖出复制体在打开前发生替换。");
    }
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false, start: 0 });
    for await (const rawChunk of stream) {
      hash.update(Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk));
    }
    const [descriptorAfter, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(filePath, { bigint: true }),
    ]);
    if (pathAfter.isSymbolicLink()
      || descriptorAfter.dev !== descriptorBefore.dev
      || descriptorAfter.ino !== descriptorBefore.ino
      || descriptorAfter.size !== descriptorBefore.size
      || descriptorAfter.mtimeNs !== descriptorBefore.mtimeNs
      || pathAfter.dev !== descriptorBefore.dev
      || pathAfter.ino !== descriptorBefore.ino) {
      throw new Error("拖出复制体在校验期间发生漂移。");
    }
    if (descriptorAfter.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("拖出复制体过大。");
    }
    return {
      sha256: hash.digest("hex"),
      sizeBytes: Number(descriptorAfter.size),
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function preparePrivateExportDirectory(exportRoot: string): Promise<string> {
  const resolvedRoot = path.resolve(exportRoot);
  await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(resolvedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("拖出临时目录无效。");
  }
  const canonicalRoot = await realpath(resolvedRoot);
  const temporaryDirectory = await mkdtemp(path.join(canonicalRoot, "drag-"));
  try {
    await chmod(temporaryDirectory, 0o700);
    return temporaryDirectory;
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 将受管 CAS 媒体复验后复制到独立临时目录。
 *
 * renderer 永远不接触 CAS objectPath；调用方只应把返回路径留在 Electron 主进程，
 * 再通过绑定 webContents 的短期一次性 token 触发 startDrag。
 */
export async function prepareStudioNativeMediaDragCopy(
  input: PrepareStudioNativeMediaDragInput,
): Promise<PreparedStudioNativeMediaDragCopy> {
  const mediaSha256 = normalizeSha256(input.mediaSha256);
  const media = await getStudioMedia(input.projectRoot, mediaSha256);
  if (!media) throw new Error("媒体不存在。");
  if (media.kind !== "image" && media.kind !== "video" && media.kind !== "audio") {
    throw new Error("仅支持拖出图片、视频或音频。");
  }

  const resolvedBefore = await resolveStudioMediaRequest(input.projectRoot, {
    mediaSha256,
  });
  if (resolvedBefore.status === 416
    || resolvedBefore.mediaSha256 !== mediaSha256
    || resolvedBefore.totalSize !== media.sizeBytes) {
    throw new Error("媒体身份复验失败。");
  }

  const temporaryDirectory = await preparePrivateExportDirectory(input.exportRoot);
  const extension = safeExtension(media.mimeType, media.kind);
  const fallback = mediaSha256.slice(0, 12);
  const basename = sanitizeStudioNativeMediaDragBasename(
    input.suggestedName ?? media.sourceBasename,
    fallback,
  );
  const fileName = `${basename}${extension}`;
  const exportPath = path.join(temporaryDirectory, fileName);
  const partialPath = path.join(temporaryDirectory, `.${fileName}.partial`);
  try {
    await copyFile(resolvedBefore.filePath, partialPath);
    const copied = await hashStableRegularFile(partialPath);
    if (copied.sha256 !== mediaSha256 || copied.sizeBytes !== media.sizeBytes) {
      throw new Error("拖出复制体与受管媒体身份不一致。");
    }

    // 再次走媒体协议的路径身份与 SHA 校验，拒绝源 CAS 在复制期间被替换。
    const resolvedAfter = await resolveStudioMediaRequest(input.projectRoot, {
      mediaSha256,
    });
    if (resolvedAfter.status === 416
      || resolvedAfter.filePath !== resolvedBefore.filePath
      || resolvedAfter.totalSize !== resolvedBefore.totalSize) {
      throw new Error("源媒体在复制期间发生漂移。");
    }

    await rename(partialPath, exportPath);
    await chmod(exportPath, 0o600);
    const finalized = await hashStableRegularFile(exportPath);
    if (finalized.sha256 !== mediaSha256 || finalized.sizeBytes !== media.sizeBytes) {
      throw new Error("拖出复制体落盘校验失败。");
    }
    return {
      exportPath,
      temporaryDirectory,
      fileName,
      kind: media.kind,
      mimeType: media.mimeType,
      sha256: mediaSha256,
      sizeBytes: media.sizeBytes,
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
