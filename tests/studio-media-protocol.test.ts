import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  __setAfterManagedPathFinalLstatHookForTests,
  getStudioMediaVerificationCacheDiagnostics,
  openStudioMediaStream,
  resolveStudioMediaRequest,
  StudioMediaProtocolError,
  streamStudioMediaRequest,
  type StudioMediaResolution,
} from "../src/core/studio-media-protocol.js";
import { importStudioMedia, initializeMaterialStudio } from "../src/core/material-studio.js";

const roots: string[] = [];
const VIDEO_PROXY_RECIPE = "studio-video-proxy:v1:max-1280x720:h264-crf28-aac128k-faststart";

afterEach(async () => {
  __setAfterManagedPathFinalLstatHookForTests(undefined);
  await Promise.all(roots.splice(0).map(async (root) => {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-studio-media-protocol-"));
  roots.push(root);
  return root;
}

async function mediaFile(root: string, name: string, bytes: Buffer | string): Promise<string> {
  const filePath = path.join(root, name);
  await writeFile(filePath, bytes);
  return filePath;
}

async function imageFile(root: string, name: string): Promise<string> {
  const filePath = path.join(root, name);
  await sharp({ create: { width: 48, height: 32, channels: 3, background: "#315a68" } }).png().toFile(filePath);
  return filePath;
}

async function body(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const rawChunk of stream) chunks.push(Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk));
  return Buffer.concat(chunks);
}

function database(root: string): DatabaseSync {
  return new DatabaseSync(path.join(root, ".aicanvas", "material-studio.sqlite"));
}

async function hashFile(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const rawChunk of createReadStream(filePath)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    hash.update(chunk);
    sizeBytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

function fakeMp4Prefix(marker = 0): Buffer {
  const prefix = Buffer.alloc(16, marker);
  prefix.writeUInt32BE(16, 0);
  prefix.write("ftyp", 4, "ascii");
  prefix.write("isom", 8, "ascii");
  return prefix;
}

async function writeFakeMp4(filePath: string, sizeBytes: number, marker = 0): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, "w", 0o600);
  try {
    await handle.write(fakeMp4Prefix(marker), 0, 16, 0);
    await handle.truncate(sizeBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readyVideoProxy(root: string, sizeBytes: number): Promise<{
  recipeKey: string;
  mediaSha256: string;
  derivativePath: string;
  outputSha256: string;
}> {
  const imported = await importStudioMedia(root, {
    sourcePath: await mediaFile(root, "proxy-source.mp4", "same-source-video-bytes"),
  });
  const recipeKey = createHash("sha256").update(`${VIDEO_PROXY_RECIPE}\0${imported.sha256}`, "utf8").digest("hex");
  const relativePath = `.aicanvas/derived/proxy/${recipeKey}.mp4`;
  const derivativePath = path.join(root, ...relativePath.split("/"));
  await writeFakeMp4(derivativePath, sizeBytes);
  const output = await hashFile(derivativePath);
  const db = database(root);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO studio_media_derivatives(
      recipe_key, media_sha256, kind, status, recipe, output_sha256, size_bytes,
      mime_type, relative_path, error_code, created_at, updated_at
    ) VALUES(?, ?, 'video_proxy', 'ready', ?, ?, ?, 'video/mp4', ?, NULL, ?, ?)
  `).run(recipeKey, imported.sha256, VIDEO_PROXY_RECIPE, output.sha256, output.sizeBytes, relativePath, now, now);
  db.close();
  return { recipeKey, mediaSha256: imported.sha256, derivativePath, outputSha256: output.sha256 };
}

function expectProtocolError(error: unknown, code: string, message?: string): boolean {
  expect(error).toBeInstanceOf(StudioMediaProtocolError);
  expect((error as StudioMediaProtocolError).code).toBe(code);
  if (message !== undefined) expect((error as StudioMediaProtocolError).message).toBe(message);
  return true;
}

describe("素材库安全媒体读取协议", () => {
  it("用完整 SHA 返回可流式读取的 200 元数据、MIME、不可变 ETag 与精确长度", async () => {
    const root = await project();
    const bytes = Buffer.from("0123456789abcdef", "utf8");
    const imported = await importStudioMedia(root, { sourcePath: await mediaFile(root, "clip.mp4", bytes) });

    const resolved = await resolveStudioMediaRequest({ projectRoot: root, mediaSha256: imported.sha256 });
    expect(resolved).toMatchObject({
      target: "media",
      key: imported.sha256,
      mediaSha256: imported.sha256,
      status: 200,
      filePath: await realpath(imported.objectPath),
      start: 0,
      end: bytes.length - 1,
      length: bytes.length,
      totalSize: bytes.length,
      mimeType: "video/mp4",
      etag: `"sha256-${imported.sha256}"`,
      headers: {
        "accept-ranges": "bytes",
        "cache-control": "public, max-age=31536000, immutable",
        "content-length": String(bytes.length),
        "content-type": "video/mp4",
        etag: `"sha256-${imported.sha256}"`,
        "x-content-type-options": "nosniff",
      },
    });
    expect(resolved.headers["content-range"]).toBeUndefined();
    expect(await body(await openStudioMediaStream(resolved))).toEqual(bytes);

    const streamed = await streamStudioMediaRequest(root, { mediaSha256: imported.sha256 });
    expect(streamed.resolution.status).toBe(200);
    expect(await body(streamed.stream!)).toEqual(bytes);
  });

  it("实现首段、中段、开放尾段和 suffix 的单范围 206 语义", async () => {
    const root = await project();
    const bytes = Buffer.from("0123456789abcdef", "utf8");
    const imported = await importStudioMedia(root, { sourcePath: await mediaFile(root, "voice.wav", bytes) });
    const cases = [
      { rangeHeader: "bytes=0-3", start: 0, end: 3, text: "0123" },
      { rangeHeader: "bytes=4-7", start: 4, end: 7, text: "4567" },
      { rangeHeader: "bytes=12-15", start: 12, end: 15, text: "cdef" },
      { rangeHeader: "bytes=12-", start: 12, end: 15, text: "cdef" },
      { rangeHeader: "bytes=-4", start: 12, end: 15, text: "cdef" },
      { rangeHeader: "bytes=14-999", start: 14, end: 15, text: "ef" },
      { rangeHeader: "bytes=-999", start: 0, end: 15, text: "0123456789abcdef" },
    ];

    for (const entry of cases) {
      const resolved = await resolveStudioMediaRequest(root, { mediaSha256: imported.sha256, rangeHeader: entry.rangeHeader });
      expect(resolved).toMatchObject({
        status: 206,
        start: entry.start,
        end: entry.end,
        length: entry.end - entry.start + 1,
        headers: {
          "accept-ranges": "bytes",
          "content-length": String(entry.end - entry.start + 1),
          "content-range": `bytes ${entry.start}-${entry.end}/${bytes.length}`,
        },
      });
      expect((await body(await openStudioMediaStream(resolved))).toString("utf8")).toBe(entry.text);
    }
  });

  it("非法多范围、倒置/越界/空 suffix 均返回无流的 416", async () => {
    const root = await project();
    const bytes = Buffer.from("0123456789abcdef", "utf8");
    const imported = await importStudioMedia(root, { sourcePath: await mediaFile(root, "voice.mp3", bytes) });

    for (const rangeHeader of ["bytes=0-1,4-5", "bytes=8-2", "bytes=99-100", "bytes=-0", "items=0-1", "bytes=-"]) {
      const resolved = await resolveStudioMediaRequest(root, { mediaSha256: imported.sha256, rangeHeader });
      expect(resolved).toMatchObject({
        status: 416,
        length: 0,
        totalSize: bytes.length,
        headers: {
          "accept-ranges": "bytes",
          "content-length": "0",
          "content-range": `bytes */${bytes.length}`,
        },
      });
      expect("filePath" in resolved).toBe(false);
      await expect(openStudioMediaStream(resolved)).rejects.toSatisfy((error: unknown) => expectProtocolError(error, "RANGE_NOT_SATISFIABLE"));
    }
  });

  it("只允许规范 CAS 相对路径，数据库路径逃逸会失败关闭", async () => {
    const root = await project();
    const imported = await importStudioMedia(root, { sourcePath: await mediaFile(root, "clip.webm", "path-escape") });
    const outside = await mediaFile(root, "outside.webm", "path-escape");
    const db = database(root);
    db.exec("DROP TRIGGER studio_media_identity_no_update");
    db.prepare("UPDATE studio_media SET object_relpath = ? WHERE sha256 = ?").run(`../${path.basename(outside)}`, imported.sha256);
    db.close();

    await expect(resolveStudioMediaRequest(root, { mediaSha256: imported.sha256 }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION"));
  });

  it("拒绝 CAS 文件或工程根本身的符号链接", async () => {
    const root = await project();
    const imported = await importStudioMedia(root, { sourcePath: await mediaFile(root, "voice.flac", "no-links") });
    const outside = await mediaFile(root, "outside.flac", "no-links");
    await rm(imported.objectPath);
    await symlink(outside, imported.objectPath);
    await expect(resolveStudioMediaRequest(root, { mediaSha256: imported.sha256 }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION"));

    const realRoot = await project();
    await initializeMaterialStudio(realRoot);
    const linkedRoot = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-link`);
    roots.push(linkedRoot);
    await symlink(realRoot, linkedRoot);
    await expect(resolveStudioMediaRequest(linkedRoot, { mediaSha256: "0".repeat(64) }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION"));
  });

  it("并发缩略图读取容忍 SQLite WAL/SHM 合法消失，同时仍拒绝伴随文件符号链接", async () => {
    const root = await project();
    const imported = await importStudioMedia(root, { sourcePath: await imageFile(root, "parallel-thumbnail.png") });
    const expected = await readFile(imported.thumbnail!.path);
    const results = await Promise.all(Array.from({ length: 64 }, async () => {
      const streamed = await streamStudioMediaRequest(root, { thumbnailRecipeKey: imported.thumbnail!.recipeKey });
      return body(streamed.stream!);
    }));
    expect(results).toHaveLength(64);
    expect(results.every((bytes) => bytes.equals(expected))).toBe(true);

    const companion = path.join(root, ".aicanvas", "material-studio.sqlite-shm");
    await rm(companion, { force: true });
    await symlink(await mediaFile(root, "forbidden-shm", "not-a-sqlite-sidecar"), companion);
    await expect(resolveStudioMediaRequest(root, { thumbnailRecipeKey: imported.thumbnail!.recipeKey }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION"));
  });

  it("WAL/SHM 可在 final lstat 后正常变动；消失允许，链接/目录/主库替换仍拒绝", async () => {
    const root = await project();
    const imported = await importStudioMedia(root, { sourcePath: await imageFile(root, "toctou-thumbnail.png") });
    const canonicalRoot = await realpath(root);
    const databasePath = path.join(canonicalRoot, ".aicanvas", "material-studio.sqlite");
    const companion = path.join(canonicalRoot, ".aicanvas", "material-studio.sqlite-wal");
    const walWriter = new DatabaseSync(databasePath);
    walWriter.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=41;");
    let mutableWalHookHit = false;
    __setAfterManagedPathFinalLstatHookForTests(async ({ candidate, label }) => {
      if (candidate !== companion || label !== "素材库伴随文件") return false;
      mutableWalHookHit = true;
      // 真实 SQLite writer 在同一 lstat→realpath 窗口追加 WAL；这不是替换攻击。
      walWriter.exec("PRAGMA user_version=42;");
      return true;
    });
    try {
      await expect(resolveStudioMediaRequest(root, { thumbnailRecipeKey: imported.thumbnail!.recipeKey }))
        .resolves.toMatchObject({ status: 200, target: "thumbnail" });
      expect(mutableWalHookHit).toBe(true);
    } finally {
      walWriter.close();
    }

    await writeFile(companion, "transient-wal");
    __setAfterManagedPathFinalLstatHookForTests(async ({ candidate, label }) => {
      if (candidate !== companion || label !== "素材库伴随文件") return false;
      await rm(companion);
      return true;
    });
    await expect(resolveStudioMediaRequest(root, { thumbnailRecipeKey: imported.thumbnail!.recipeKey }))
      .resolves.toMatchObject({ status: 200, target: "thumbnail" });

    const danglingTarget = path.join(canonicalRoot, ".aicanvas", "missing-database-target");
    __setAfterManagedPathFinalLstatHookForTests(async ({ candidate, label }) => {
      if (candidate !== databasePath || label !== "素材库数据库") return false;
      await rm(databasePath);
      await symlink(danglingTarget, databasePath);
      return true;
    });
    await expect(resolveStudioMediaRequest(root, { thumbnailRecipeKey: imported.thumbnail!.recipeKey }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION", "素材库数据库 不能是符号链接。"));

    const directoryRoot = await project();
    const directoryImported = await importStudioMedia(directoryRoot, { sourcePath: await imageFile(directoryRoot, "toctou-directory-thumbnail.png") });
    const directoryDatabase = path.join(await realpath(directoryRoot), ".aicanvas", "material-studio.sqlite");
    __setAfterManagedPathFinalLstatHookForTests(async ({ candidate, label }) => {
      if (candidate !== directoryDatabase || label !== "素材库数据库") return false;
      await rm(directoryDatabase);
      await mkdir(directoryDatabase);
      return true;
    });
    await expect(resolveStudioMediaRequest(directoryRoot, { thumbnailRecipeKey: directoryImported.thumbnail!.recipeKey }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION", "素材库数据库 必须是普通文件。"));

    const replacementRoot = await project();
    const replacementImported = await importStudioMedia(replacementRoot, { sourcePath: await imageFile(replacementRoot, "toctou-replacement-thumbnail.png") });
    const replacementDatabase = path.join(await realpath(replacementRoot), ".aicanvas", "material-studio.sqlite");
    __setAfterManagedPathFinalLstatHookForTests(async ({ candidate, label }) => {
      if (candidate !== replacementDatabase || label !== "素材库数据库") return false;
      await rm(replacementDatabase);
      await writeFile(replacementDatabase, "replacement-not-the-verified-sqlite");
      return true;
    });
    await expect(resolveStudioMediaRequest(replacementRoot, { thumbnailRecipeKey: replacementImported.thumbnail!.recipeKey }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION", "素材库数据库 在安全解析期间发生变化。"));
  });

  it("未知 SHA 与伪造绝对路径描述都不能成为文件读取入口", async () => {
    const root = await project();
    await initializeMaterialStudio(root);
    await expect(resolveStudioMediaRequest(root, { mediaSha256: "f".repeat(64) }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "MEDIA_NOT_FOUND"));
    await expect(resolveStudioMediaRequest(root, { mediaSha256: "f".repeat(64), path: "/etc/passwd" } as never))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INVALID_REQUEST"));

    const forged = {
      target: "media",
      key: "f".repeat(64),
      mediaSha256: "f".repeat(64),
      status: 200,
      filePath: "/etc/passwd",
      start: 0,
      end: 0,
      length: 1,
      totalSize: 1,
      mimeType: "audio/mpeg",
      etag: `"sha256-${"f".repeat(64)}"`,
      headers: {},
    } as StudioMediaResolution;
    await expect(openStudioMediaStream(forged))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INVALID_REQUEST"));
  });

  it("缩略图只能由 ready 冻结记录的完整 recipe key 解析", async () => {
    const root = await project();
    const imported = await importStudioMedia(root, { sourcePath: await imageFile(root, "still.png") });
    const recipeKey = imported.thumbnail!.recipeKey;
    const thumbnailBytes = await readFile(imported.thumbnail!.path);
    const thumbnailSha = createHash("sha256").update(thumbnailBytes).digest("hex");
    const resolved = await resolveStudioMediaRequest(root, { thumbnailRecipeKey: recipeKey });
    expect(resolved).toMatchObject({
      target: "thumbnail",
      key: recipeKey,
      mediaSha256: imported.sha256,
      status: 200,
      filePath: await realpath(imported.thumbnail!.path),
      length: thumbnailBytes.length,
      totalSize: thumbnailBytes.length,
      mimeType: "image/webp",
      etag: `"thumbnail-sha256-${thumbnailSha}"`,
    });
    expect(await body(await openStudioMediaStream(resolved))).toEqual(thumbnailBytes);

    await expect(resolveStudioMediaRequest(root, { thumbnailRecipeKey: "0".repeat(64) }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "MEDIA_NOT_FOUND"));

    const mismatchedKey = "f".repeat(64);
    const db = database(root);
    db.prepare("UPDATE studio_media SET thumbnail_recipe_key = ? WHERE sha256 = ?").run(mismatchedKey, imported.sha256);
    db.close();
    await expect(resolveStudioMediaRequest(root, { thumbnailRecipeKey: mismatchedKey }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION"));
  });

  it("数据库大小/MIME 漂移和同尺寸内容 SHA 漂移均失败关闭", async () => {
    const root = await project();
    const imported = await importStudioMedia(root, { sourcePath: await mediaFile(root, "clip.m4v", "abcdefgh") });
    await writeFile(imported.objectPath, "ABCDEFGH");
    await expect(resolveStudioMediaRequest(root, { mediaSha256: imported.sha256 }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION"));

    const secondRoot = await project();
    const second = await importStudioMedia(secondRoot, { sourcePath: await mediaFile(secondRoot, "voice.aac", "metadata") });
    const db = database(secondRoot);
    db.exec("DROP TRIGGER studio_media_identity_no_update");
    db.prepare("UPDATE studio_media SET mime_type = 'text/html' WHERE sha256 = ?").run(second.sha256);
    db.close();
    await expect(resolveStudioMediaRequest(secondRoot, { mediaSha256: second.sha256 }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION"));
  });

  it("64 MiB 原件保持流式校验与区间读取，不使用整文件 readFile", async () => {
    const root = await project();
    const largePath = path.join(root, "large.wav");
    await writeFile(largePath, "");
    await truncate(largePath, 64 * 1024 * 1024);
    const imported = await importStudioMedia(root, { sourcePath: largePath });

    const resolved = await resolveStudioMediaRequest(root, { mediaSha256: imported.sha256, range: "bytes=33554432-33554447" });
    expect(resolved).toMatchObject({
      status: 206,
      start: 33_554_432,
      end: 33_554_447,
      length: 16,
      totalSize: 64 * 1024 * 1024,
    });
    expect(await body(await openStudioMediaStream(resolved))).toEqual(Buffer.alloc(16));

    const implementation = await readFile(path.join(process.cwd(), "src/core/studio-media-protocol.ts"), "utf8");
    expect(implementation).not.toMatch(/\breadFile\s*\(/u);
  });

  it("32 MiB ready 视频代理的连续 Range 只在首次计算整文件 SHA", async () => {
    const root = await project();
    const proxy = await readyVideoProxy(root, 32 * 1_024 * 1_024);
    const before = getStudioMediaVerificationCacheDiagnostics();
    const ranges = ["bytes=0-11", "bytes=1048576-1048591", "bytes=16777216-16777231", "bytes=-16"];

    for (const rangeHeader of ranges) {
      const resolution = await resolveStudioMediaRequest(root, { derivativeRecipeKey: proxy.recipeKey, rangeHeader });
      expect(resolution).toMatchObject({ target: "derivative", status: 206, mediaSha256: proxy.mediaSha256 });
      expect((await body(await openStudioMediaStream(resolution))).length).toBe(rangeHeader === "bytes=0-11" ? 12 : 16);
    }

    const after = getStudioMediaVerificationCacheDiagnostics();
    expect(after.fullHashVerifications.derivative - before.fullHashVerifications.derivative).toBe(1);
    expect(after.cacheMisses.derivative - before.cacheMisses.derivative).toBe(1);
    expect(after.cacheHits.derivative - before.cacheHits.derivative).toBe(3);
    expect(after.fullHashVerifications.media - before.fullHashVerifications.media).toBe(1);
    expect(after.cacheHits.media - before.cacheHits.media).toBe(3);
    expect(after.size).toBeLessThanOrEqual(after.limit);
    expect(after.inFlight).toBe(0);
  }, 30_000);

  it("ready 缩略图的 Range 命中身份缓存，同尺寸内容漂移会重算 SHA 并失败关闭", async () => {
    const root = await project();
    const imported = await importStudioMedia(root, { sourcePath: await imageFile(root, "cached-still.png") });
    const before = getStudioMediaVerificationCacheDiagnostics();
    for (const rangeHeader of ["bytes=0-7", "bytes=8-15", "bytes=-8"]) {
      const resolution = await resolveStudioMediaRequest(root, {
        thumbnailRecipeKey: imported.thumbnail!.recipeKey,
        rangeHeader,
      });
      expect(resolution.status).toBe(206);
      expect((await body(await openStudioMediaStream(resolution))).length).toBe(8);
    }
    const cached = getStudioMediaVerificationCacheDiagnostics();
    expect(cached.fullHashVerifications.thumbnail - before.fullHashVerifications.thumbnail).toBe(1);
    expect(cached.cacheHits.thumbnail - before.cacheHits.thumbnail).toBe(2);

    const thumbnailBytes = await readFile(imported.thumbnail!.path);
    thumbnailBytes[thumbnailBytes.length - 1] = thumbnailBytes[thumbnailBytes.length - 1]! ^ 0xff;
    await writeFile(imported.thumbnail!.path, thumbnailBytes);
    await expect(resolveStudioMediaRequest(root, { thumbnailRecipeKey: imported.thumbnail!.recipeKey }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION"));
    const drifted = getStudioMediaVerificationCacheDiagnostics();
    expect(drifted.fullHashVerifications.thumbnail - before.fullHashVerifications.thumbnail).toBe(2);
  });

  it("ready 派生的原地变更、原子替换和符号链接都会让身份缓存失效", async () => {
    const root = await project();
    const sizeBytes = 4_096;
    const proxy = await readyVideoProxy(root, sizeBytes);
    const before = getStudioMediaVerificationCacheDiagnostics();
    await resolveStudioMediaRequest(root, { derivativeRecipeKey: proxy.recipeKey, rangeHeader: "bytes=0-15" });

    const driftedRecord = database(root);
    driftedRecord.prepare("UPDATE studio_media_derivatives SET output_sha256 = ? WHERE recipe_key = ?")
      .run("f".repeat(64), proxy.recipeKey);
    driftedRecord.close();
    await expect(resolveStudioMediaRequest(root, { derivativeRecipeKey: proxy.recipeKey }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION"));
    const restoredRecord = database(root);
    restoredRecord.prepare("UPDATE studio_media_derivatives SET output_sha256 = ? WHERE recipe_key = ?")
      .run(proxy.outputSha256, proxy.recipeKey);
    restoredRecord.close();

    await writeFakeMp4(proxy.derivativePath, sizeBytes, 0x31);
    await expect(resolveStudioMediaRequest(root, { derivativeRecipeKey: proxy.recipeKey }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION"));

    await writeFakeMp4(proxy.derivativePath, sizeBytes);
    await expect(resolveStudioMediaRequest(root, { derivativeRecipeKey: proxy.recipeKey }))
      .resolves.toMatchObject({ status: 200, etag: `"derivative-sha256-${proxy.outputSha256}"` });

    const replacement = path.join(root, "replacement.mp4");
    await writeFakeMp4(replacement, sizeBytes, 0x42);
    await rename(replacement, proxy.derivativePath);
    await expect(resolveStudioMediaRequest(root, { derivativeRecipeKey: proxy.recipeKey }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION"));

    const symlinkTarget = path.join(root, "symlink-target.mp4");
    await writeFakeMp4(symlinkTarget, sizeBytes);
    await rm(proxy.derivativePath);
    await symlink(symlinkTarget, proxy.derivativePath);
    await expect(resolveStudioMediaRequest(root, { derivativeRecipeKey: proxy.recipeKey }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION"));

    const after = getStudioMediaVerificationCacheDiagnostics();
    expect(after.fullHashVerifications.derivative - before.fullHashVerifications.derivative).toBe(4);
  });

  it("相同 recipe、SHA 和字节数在不同工程仍分别做首次完整校验", async () => {
    const firstRoot = await project();
    const secondRoot = await project();
    const first = await readyVideoProxy(firstRoot, 4_096);
    const second = await readyVideoProxy(secondRoot, 4_096);
    expect(second.recipeKey).toBe(first.recipeKey);
    expect(second.outputSha256).toBe(first.outputSha256);
    const before = getStudioMediaVerificationCacheDiagnostics();

    const firstResolution = await resolveStudioMediaRequest(firstRoot, { derivativeRecipeKey: first.recipeKey, rangeHeader: "bytes=0-15" });
    const secondResolution = await resolveStudioMediaRequest(secondRoot, { derivativeRecipeKey: second.recipeKey, rangeHeader: "bytes=0-15" });
    expect(firstResolution.etag).toBe(secondResolution.etag);
    expect(await body(await openStudioMediaStream(firstResolution))).toEqual(await body(await openStudioMediaStream(secondResolution)));

    const after = getStudioMediaVerificationCacheDiagnostics();
    expect(after.fullHashVerifications.derivative - before.fullHashVerifications.derivative).toBe(2);
    expect(after.fullHashVerifications.media - before.fullHashVerifications.media).toBe(2);
  });
});
