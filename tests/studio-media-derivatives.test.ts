import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, createReadStream } from "node:fs";
import { mkdtemp, open, readFile, readdir, realpath, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  getMachineMediaRuntimeConfig,
  MEDIA_WEIGHTS,
  mediaStageTimeout,
  readMachineMediaRuntimeSnapshot,
  runMediaProcess,
} from "../src/core/media-runtime.js";
import { importStudioMedia, listStudioMedia } from "../src/core/material-studio.js";
import {
  getStudioMediaDerivatives,
  materializeStudioMediaDerivatives,
  studioMediaDerivativeRecipeKey,
  StudioMediaDerivativeError,
} from "../src/core/studio-media-derivatives.js";
import {
  openStudioMediaStream,
  resolveStudioMediaRequest,
  StudioMediaProtocolError,
} from "../src/core/studio-media-protocol.js";

const roots: string[] = [];
const ORIGINAL_FFMPEG = process.env.AI_CANVAS_FFMPEG;
const ORIGINAL_FFPROBE = process.env.AI_CANVAS_FFPROBE;
const ORIGINAL_RUNTIME = process.env.AI_CANVAS_MEDIA_RUNTIME_DIR;

function executable(name: "ffmpeg" | "ffprobe"): string | undefined {
  const configured = name === "ffmpeg" ? ORIGINAL_FFMPEG : ORIGINAL_FFPROBE;
  const candidates = [
    configured,
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, name)),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of [...new Set(candidates)]) {
    try { accessSync(candidate, fsConstants.X_OK); return candidate; }
    catch { /* 继续寻找。 */ }
  }
  return undefined;
}

const FFMPEG = executable("ffmpeg");
const FFPROBE = executable("ffprobe");

afterEach(async () => {
  if (ORIGINAL_FFMPEG === undefined) delete process.env.AI_CANVAS_FFMPEG;
  else process.env.AI_CANVAS_FFMPEG = ORIGINAL_FFMPEG;
  if (ORIGINAL_FFPROBE === undefined) delete process.env.AI_CANVAS_FFPROBE;
  else process.env.AI_CANVAS_FFPROBE = ORIGINAL_FFPROBE;
  if (ORIGINAL_RUNTIME === undefined) delete process.env.AI_CANVAS_MEDIA_RUNTIME_DIR;
  else process.env.AI_CANVAS_MEDIA_RUNTIME_DIR = ORIGINAL_RUNTIME;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function managedProject(label: string): Promise<{ parent: string; root: string }> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), `ai-canvas-${label}-`)));
  roots.push(parent);
  process.env.AI_CANVAS_MEDIA_RUNTIME_DIR = path.join(parent, "media-runtime");
  const root = (await createManagedProject({ parentRoot: parent, name: label })).paths.root;
  return { parent, root };
}

async function runFixture(ffmpegPath: string, outputPath: string, args: string[]): Promise<void> {
  const result = await runMediaProcess(ffmpegPath, [...args, "-y", outputPath], {
    tool: "ffmpeg",
    stage: "studio-derivative-test-fixture",
    weight: MEDIA_WEIGHTS.foreground,
    timeoutMs: mediaStageTimeout("ffmpeg", 60_000),
    maxOutputBytes: 64 * 1_024,
  });
  if (result.status !== "succeeded") throw new Error(result.output || "FFmpeg fixture failed");
}

async function realVideo(ffmpegPath: string, target: string): Promise<void> {
  await runFixture(ffmpegPath, target, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "1", "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
  ]);
}

async function realAudio(ffmpegPath: string, target: string): Promise<void> {
  await runFixture(ffmpegPath, target, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=44100",
    "-t", "1", "-c:a", "pcm_s16le",
  ]);
}

function database(root: string): DatabaseSync {
  return new DatabaseSync(path.join(root, ".aicanvas", "material-studio.sqlite"));
}

function absoluteDerivative(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

async function streamBody(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const raw of stream) chunks.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
  return Buffer.concat(chunks);
}

async function hashFile(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const raw of createReadStream(filePath)) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    hash.update(chunk);
    sizeBytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

function expectProtocolError(error: unknown, code: string): boolean {
  expect(error).toBeInstanceOf(StudioMediaProtocolError);
  expect((error as StudioMediaProtocolError).code).toBe(code);
  return true;
}

describe("受管大媒体显式懒派生", () => {
  it.skipIf(!FFMPEG || !FFPROBE)("真实短视频/音频在受控容量内生成内容寻址派生，重复与并发请求幂等", async () => {
    const { root } = await managedProject("studio-derivative-real");
    process.env.AI_CANVAS_FFMPEG = FFMPEG!;
    process.env.AI_CANVAS_FFPROBE = FFPROBE!;
    const videoSource = path.join(root, "source-video.mp4");
    const audioSource = path.join(root, "source-audio.wav");
    await realVideo(FFMPEG!, videoSource);
    await realAudio(FFMPEG!, audioSource);
    const video = await importStudioMedia(root, { sourcePath: videoSource });
    const audio = await importStudioMedia(root, { sourcePath: audioSource });
    const baseline = await readMachineMediaRuntimeSnapshot();

    const concurrent = await Promise.all([
      materializeStudioMediaDerivatives(root, { mediaSha256: video.sha256 }),
      materializeStudioMediaDerivatives(root, { mediaSha256: video.sha256 }),
    ]);
    expect(concurrent.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(concurrent[0]).toMatchObject({ status: "ready", mediaKind: "video" });
    expect(concurrent[0]!.derivatives.map((entry) => entry.kind).sort()).toEqual(["video_poster", "video_proxy"]);
    const afterVideo = await readMachineMediaRuntimeSnapshot();
    expect(afterVideo.metrics.granted - baseline.metrics.granted).toBe(4);

    const audioResult = await materializeStudioMediaDerivatives(root, { mediaSha256: audio.sha256 });
    expect(audioResult).toMatchObject({ status: "ready", replayed: false, mediaKind: "audio", derivatives: [{ kind: "audio_waveform" }] });
    const afterAudio = await readMachineMediaRuntimeSnapshot();
    expect(afterAudio.metrics.granted - afterVideo.metrics.granted).toBe(2);

    const replay = await materializeStudioMediaDerivatives(root, { mediaSha256: audio.sha256 });
    expect(replay).toMatchObject({ status: "ready", replayed: true });
    expect((await readMachineMediaRuntimeSnapshot()).metrics.granted).toBe(afterAudio.metrics.granted);
    expect(await getStudioMediaDerivatives(root, video.sha256)).toEqual(concurrent.find((entry) => !entry.replayed)!.derivatives);

    const all = [...concurrent[0]!.derivatives, ...audioResult.derivatives];
    for (const derivative of all) {
      expect(derivative).toMatchObject({ status: "ready", outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), sizeBytes: expect.any(Number) });
      expect(derivative.relativePath).toMatch(/^\.aicanvas\/derived\/(?:thumb|proxy|waveform)\/[a-f0-9]{64}\.(?:webp|mp4)$/u);
      expect((await hashFile(absoluteDerivative(root, derivative.relativePath!))).sha256).toBe(derivative.outputSha256);
    }
    const poster = concurrent[0]!.derivatives.find((entry) => entry.kind === "video_poster")!;
    const proxy = concurrent[0]!.derivatives.find((entry) => entry.kind === "video_proxy")!;
    const waveform = audioResult.derivatives[0]!;
    expect(poster.mimeType).toBe("image/webp");
    expect(proxy.mimeType).toBe("video/mp4");
    expect(waveform.mimeType).toBe("image/webp");

    const proxyRange = await resolveStudioMediaRequest(root, { derivativeRecipeKey: proxy.recipeKey, rangeHeader: "bytes=0-11" });
    expect(proxyRange).toMatchObject({ target: "derivative", status: 206, mediaSha256: video.sha256, mimeType: "video/mp4", length: 12 });
    expect((await streamBody(await openStudioMediaStream(proxyRange))).subarray(4, 8).toString("ascii")).toBe("ftyp");
    const posterResolved = await resolveStudioMediaRequest(root, { derivativeRecipeKey: poster.recipeKey });
    expect(posterResolved.etag).toBe(`"derivative-sha256-${poster.outputSha256}"`);

    const db = database(root);
    const storageTypes = db.prepare(`
      SELECT typeof(recipe_key) AS recipe_type, typeof(output_sha256) AS sha_type,
             typeof(size_bytes) AS size_type, typeof(mime_type) AS mime_type,
             typeof(relative_path) AS path_type, max(length(relative_path)) AS max_path
      FROM studio_media_derivatives WHERE status = 'ready'
    `).get() as Record<string, unknown>;
    db.close();
    expect(storageTypes).toMatchObject({ recipe_type: "text", sha_type: "text", size_type: "integer", mime_type: "text", path_type: "text" });
    expect(Number(storageTypes.max_path)).toBeLessThan(160);

    await writeFile(absoluteDerivative(root, waveform.relativePath!), "corrupted-waveform");
    const grantsBeforeDrift = (await readMachineMediaRuntimeSnapshot()).metrics.granted;
    await expect(materializeStudioMediaDerivatives(root, { mediaSha256: audio.sha256 }))
      .rejects.toMatchObject({ name: "StudioMediaDerivativeError", code: "derivative_drift" });
    expect((await readMachineMediaRuntimeSnapshot()).metrics.granted).toBe(grantsBeforeDrift);

    const dbEscape = database(root);
    dbEscape.prepare("UPDATE studio_media_derivatives SET relative_path = '../outside.mp4' WHERE recipe_key = ?").run(proxy.recipeKey);
    dbEscape.close();
    await expect(resolveStudioMediaRequest(root, { derivativeRecipeKey: proxy.recipeKey }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION"));
  }, 60_000);

  it("无 ffmpeg/ffprobe 时明确 blocked，不创建伪输出或启动媒体进程", async () => {
    const { root } = await managedProject("studio-derivative-blocked");
    process.env.AI_CANVAS_FFMPEG = "";
    process.env.AI_CANVAS_FFPROBE = "";
    const source = path.join(root, "voice.wav");
    await writeFile(source, "not-decoded-because-engine-is-blocked");
    const audio = await importStudioMedia(root, { sourcePath: source });
    const before = await readMachineMediaRuntimeSnapshot();
    const first = await materializeStudioMediaDerivatives(root, { mediaSha256: audio.sha256 });
    const second = await materializeStudioMediaDerivatives(root, { mediaSha256: audio.sha256 });
    expect(first).toMatchObject({ status: "blocked", replayed: false, derivatives: [{ status: "blocked", errorCode: "ffmpeg_ffprobe_unavailable" }] });
    expect(second).toMatchObject({ status: "blocked", replayed: true });
    const after = await readMachineMediaRuntimeSnapshot();
    expect(after.metrics.granted).toBe(before.metrics.granted);
    expect(await readdir(path.join(root, ".aicanvas", "derived", "waveform"))).toEqual([]);
    const db = database(root);
    const row = db.prepare("SELECT status, output_sha256, size_bytes, mime_type, relative_path, error_code FROM studio_media_derivatives").get();
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'studio_media_derivatives'").get() as { sql: string };
    db.close();
    expect(row).toEqual({ status: "blocked", output_sha256: null, size_bytes: null, mime_type: null, relative_path: null, error_code: "ffmpeg_ffprobe_unavailable" });
    expect(schema.sql).not.toMatch(/\b(?:JSON|BLOB)\b/iu);
    await expect(resolveStudioMediaRequest(root, { derivativeRecipeKey: first.derivatives[0]!.recipeKey }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "DERIVATIVE_NOT_READY"));

    const dbDrift = database(root);
    dbDrift.prepare("UPDATE studio_media_derivatives SET recipe = 'tampered-recipe' WHERE recipe_key = ?").run(first.derivatives[0]!.recipeKey);
    dbDrift.close();
    await expect(resolveStudioMediaRequest(root, { derivativeRecipeKey: first.derivatives[0]!.recipeKey }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INTEGRITY_VIOLATION"));

    const wrongKindKey = studioMediaDerivativeRecipeKey("video_poster", audio.sha256);
    const now = new Date().toISOString();
    const dbWrongKind = database(root);
    dbWrongKind.prepare("DELETE FROM studio_media_derivatives WHERE media_sha256 = ?").run(audio.sha256);
    dbWrongKind.prepare(`
      INSERT INTO studio_media_derivatives(
        recipe_key, media_sha256, kind, status, recipe, output_sha256, size_bytes,
        mime_type, relative_path, error_code, created_at, updated_at
      ) VALUES(?, ?, 'video_poster', 'blocked', ?, NULL, NULL, NULL, NULL, 'ffmpeg_unavailable', ?, ?)
    `).run(wrongKindKey, audio.sha256, "studio-video-poster:v1:first-frame:max-1280x720:webp-q82", now, now);
    dbWrongKind.close();
    await expect(materializeStudioMediaDerivatives(root, { mediaSha256: audio.sha256 }))
      .rejects.toMatchObject({ name: "StudioMediaDerivativeError", code: "database_drift" });
    expect((await readMachineMediaRuntimeSnapshot()).metrics.granted).toBe(before.metrics.granted);
  });

  it("源 CAS 漂移和非法 recipe key 在任何媒体进程前失败关闭", async () => {
    const { root } = await managedProject("studio-derivative-source-drift");
    const source = path.join(root, "voice.wav");
    await writeFile(source, "stable-source-bytes");
    const audio = await importStudioMedia(root, { sourcePath: source });
    await writeFile(audio.objectPath, "tampered-source---");
    const before = await readMachineMediaRuntimeSnapshot();
    await expect(materializeStudioMediaDerivatives(root, { mediaSha256: audio.sha256 }))
      .rejects.toMatchObject({ name: "StudioMediaDerivativeError", code: "source_drift" });
    expect((await readMachineMediaRuntimeSnapshot()).metrics.granted).toBe(before.metrics.granted);
    await expect(resolveStudioMediaRequest(root, { derivativeRecipeKey: "0".repeat(64) }))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "MEDIA_NOT_FOUND"));
    await expect(resolveStudioMediaRequest(root, { derivativeRecipeKey: "../outside" } as never))
      .rejects.toSatisfy((error: unknown) => expectProtocolError(error, "INVALID_REQUEST"));
  });

  it("64 MiB 派生只做流式 SHA 与 Range 读取，不整体载入内存", async () => {
    const { root } = await managedProject("studio-derivative-large-stream");
    const source = path.join(root, "large.wav");
    await writeFile(source, "");
    await truncate(source, 64 * 1_024 * 1_024);
    const audio = await importStudioMedia(root, { sourcePath: source });
    const recipeKey = studioMediaDerivativeRecipeKey("audio_waveform", audio.sha256);
    const relativePath = `.aicanvas/derived/waveform/${recipeKey}.webp`;
    const derivativePath = absoluteDerivative(root, relativePath);
    const handle = await open(derivativePath, "w", 0o600);
    try {
      await handle.write(Buffer.from("RIFF\0\0\0\0WEBP", "binary"), 0, 12, 0);
      await handle.truncate(64 * 1_024 * 1_024);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const identity = await hashFile(derivativePath);
    const db = database(root);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO studio_media_derivatives(
        recipe_key, media_sha256, kind, status, recipe, output_sha256, size_bytes,
        mime_type, relative_path, error_code, created_at, updated_at
      ) VALUES(?, ?, 'audio_waveform', 'ready', ?, ?, ?, 'image/webp', ?, NULL, ?, ?)
    `).run(recipeKey, audio.sha256, "studio-audio-waveform:v1:1200x160:mono:webp-q82", identity.sha256, identity.sizeBytes, relativePath, now, now);
    db.close();

    const resolution = await resolveStudioMediaRequest(root, { derivativeRecipeKey: recipeKey, rangeHeader: "bytes=33554432-33554447" });
    expect(resolution).toMatchObject({ target: "derivative", status: 206, start: 33_554_432, end: 33_554_447, length: 16, totalSize: 64 * 1_024 * 1_024 });
    expect(await streamBody(await openStudioMediaStream(resolution))).toEqual(Buffer.alloc(16));
    const implementation = `${await readFile(path.join(process.cwd(), "src/core/studio-media-derivatives.ts"), "utf8")}\n${await readFile(path.join(process.cwd(), "src/core/studio-media-protocol.ts"), "utf8")}`;
    expect(implementation).not.toMatch(/\breadFile\s*\(/u);
  }, 30_000);

  it("100 视频 + 100 音频只分页读轻量元数据，不创建派生或启动进程", async () => {
    const { root } = await managedProject("studio-derivative-pagination");
    const before = await readMachineMediaRuntimeSnapshot();
    for (let index = 0; index < 100; index += 1) {
      const videoPath = path.join(root, `video-${String(index).padStart(3, "0")}.mp4`);
      const audioPath = path.join(root, `audio-${String(index).padStart(3, "0")}.wav`);
      await writeFile(videoPath, `video-metadata-${index}`);
      await writeFile(audioPath, `audio-metadata-${index}`);
      await importStudioMedia(root, { sourcePath: videoPath });
      await importStudioMedia(root, { sourcePath: audioPath });
    }
    const videoFirst = await listStudioMedia(root, { kind: "video", limit: 60 });
    const videoSecond = await listStudioMedia(root, { kind: "video", cursor: videoFirst.nextCursor, limit: 60 });
    const audioFirst = await listStudioMedia(root, { kind: "audio", limit: 100 });
    expect(videoFirst.items).toHaveLength(60);
    expect(videoSecond.items).toHaveLength(40);
    expect(audioFirst.items).toHaveLength(100);
    expect([...videoFirst.items, ...videoSecond.items, ...audioFirst.items].every((item) => item.derivativeStatus === "pending" && item.thumbnail === undefined)).toBe(true);
    const after = await readMachineMediaRuntimeSnapshot();
    expect(after.metrics.granted).toBe(before.metrics.granted);
    expect(after.active).toEqual([]);
    expect(after.queueDepth).toBe(0);
    const db = database(root);
    const count = db.prepare("SELECT COUNT(*) AS count FROM studio_media_derivatives").get() as { count: number };
    db.close();
    expect(count.count).toBe(0);
    expect(getMachineMediaRuntimeConfig().runtimeDirectory).toBe(path.join(path.dirname(root), "media-runtime"));
  }, 30_000);
});
