/**
 * P9-R 媒体规模：10k 真实 CAS 对象 + 1k 可解码缩略图 + 真视频/音频派生。
 *
 * 该脚本只建立 /tmp 隔离工程。所有 studio_media 记录都必须有真实 object、
 * size/SHA 匹配；性能探针必须调用 listStudioMedia 的 SQL keyset，而不是资产空页。
 */
import { createHash } from "node:crypto";
import { readFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  getMaterialStudioState,
  getMaterialStudioThumbnailRecipe,
  importStudioMedia,
  listStudioMedia,
  type StudioMediaMetadata,
} from "../src/core/material-studio.js";
import { materializeStudioMediaDerivatives } from "../src/core/studio-media-derivatives.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspace, "docs", "evidence");
const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
const outputPath = path.resolve(
  process.argv[2] || path.join(evidenceRoot, `p9-media-scale-${stamp}.json`),
);

const MEDIA = Number(process.env.P9_MEDIA_COUNT || 10_000);
const THUMBS = Number(process.env.P9_THUMB_COUNT || 1_000);
const REAL_VIDEO = Number(process.env.P9_REAL_VIDEO || 2);
const REAL_AUDIO = Number(process.env.P9_REAL_AUDIO || 2);
const IMAGE_COUNT = MEDIA - REAL_VIDEO - REAL_AUDIO;

if (![MEDIA, THUMBS, REAL_VIDEO, REAL_AUDIO].every(Number.isSafeInteger)
  || MEDIA < 1 || THUMBS < 0 || REAL_VIDEO < 0 || REAL_AUDIO < 0
  || IMAGE_COUNT < THUMBS || IMAGE_COUNT < 0) {
  throw new Error("P9 媒体规模参数无效：总数必须覆盖缩略图、真实视频与真实音频。 ");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function thumbnailRecipeKey(mediaSha256: string): string {
  return createHash("sha256")
    .update(`${getMaterialStudioThumbnailRecipe()}\0${mediaSha256}`, "utf8")
    .digest("hex");
}

async function inBatches<T>(
  items: T[],
  batchSize: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += batchSize) {
    await Promise.all(items.slice(offset, offset + batchSize).map(worker));
  }
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (chunk) => { err += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0
      ? resolve()
      : reject(new Error(`${bin} 失败(${code ?? "signal"})：${err.slice(0, 500)}`))));
  });
}

interface ImageFixture {
  index: number;
  sha256: string;
  bytes: Buffer;
  objectPath: string;
  objectRelpath: string;
  sourceBasename: string;
  thumbnailRecipeKey?: string;
  thumbnailPath?: string;
  thumbnailRelpath?: string;
}

const parent = await realpath(await mkdtemp(path.join("/tmp", "p9-media-scale-")));
const started = performance.now();
try {
  const project = await createManagedProject({ parentRoot: parent, name: "P9-R 媒体规模", slug: "p9-media-scale" });
  const state = await getMaterialStudioState(project.paths.root);
  const basePng = await sharp({
    create: { width: 64, height: 96, channels: 3, background: { r: 40, g: 60, b: 80 } },
  }).png().toBuffer();
  const thumbnailBytes = await sharp(basePng, { failOn: "error" }).webp({ quality: 82 }).toBuffer();

  await Promise.all(Array.from({ length: 256 }, (_, value) => (
    mkdir(path.join(state.objectRoot, value.toString(16).padStart(2, "0")), { recursive: true })
  )));
  await mkdir(state.thumbnailRoot, { recursive: true });

  const images: ImageFixture[] = [];
  for (let index = 0; index < IMAGE_COUNT; index += 1) {
    // PNG IEND 后的唯一审计尾标不会影响解码，但确保每个 CAS 对象内容身份独立。
    const bytes = Buffer.concat([
      basePng,
      Buffer.from(`\np9-media-scale:${String(index).padStart(8, "0")}`, "utf8"),
    ]);
    const digest = sha256(bytes);
    const recipeKey = index < THUMBS ? thumbnailRecipeKey(digest) : undefined;
    images.push({
      index,
      sha256: digest,
      bytes,
      objectPath: path.join(state.objectRoot, digest.slice(0, 2), digest),
      objectRelpath: `.aicanvas/objects/sha256/${digest.slice(0, 2)}/${digest}`,
      sourceBasename: `media-${String(index).padStart(5, "0")}.png`,
      ...(recipeKey ? {
        thumbnailRecipeKey: recipeKey,
        thumbnailPath: path.join(state.thumbnailRoot, `${recipeKey}.webp`),
        thumbnailRelpath: `.aicanvas/derived/thumb/${recipeKey}.webp`,
      } : {}),
    });
  }

  await inBatches(images, 128, async (fixture) => {
    await writeFile(fixture.objectPath, fixture.bytes, { flag: "wx", mode: 0o600 });
  });
  const thumbnailFixtures = images.slice(0, THUMBS);
  await inBatches(thumbnailFixtures, 128, async (fixture) => {
    await writeFile(fixture.thumbnailPath!, thumbnailBytes, { flag: "wx", mode: 0o600 });
  });

  const db = new DatabaseSync(state.databasePath);
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const insert = db.prepare(`
      INSERT INTO studio_media(
        sha256, kind, size_bytes, mime_type, source_basename, object_relpath,
        derivative_status, thumbnail_recipe_key, thumbnail_relpath,
        thumbnail_width, thumbnail_height, created_at
      ) VALUES(?, 'image', ?, 'image/png', ?, ?, 'ready', ?, ?, 64, 96, ?)
    `);
    const now = new Date().toISOString();
    for (const fixture of images) {
      insert.run(
        fixture.sha256,
        fixture.bytes.length,
        fixture.sourceBasename,
        fixture.objectRelpath,
        fixture.thumbnailRecipeKey ?? thumbnailRecipeKey(fixture.sha256),
        fixture.thumbnailRelpath ?? `.aicanvas/derived/thumb/${thumbnailRecipeKey(fixture.sha256)}.webp`,
        now,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
    throw error;
  } finally {
    db.close();
  }

  // 非前 1000 图片也必须满足 schema 的 ready thumbnail 字段，因此落盘共享的可解码缩略图字节。
  // 每个路径和 recipe key 独立，列表仍只加载元数据，不读取这些文件。
  await inBatches(images.slice(THUMBS), 128, async (fixture) => {
    const recipeKey = thumbnailRecipeKey(fixture.sha256);
    await writeFile(path.join(state.thumbnailRoot, `${recipeKey}.webp`), thumbnailBytes, { flag: "wx", mode: 0o600 });
  });

  let videoDerivativesReady = 0;
  let audioDerivativesReady = 0;
  const inputs = path.join(project.paths.root, "media-inputs");
  await mkdir(inputs, { recursive: true });
  for (let index = 0; index < REAL_VIDEO; index += 1) {
    const videoPath = path.join(inputs, `real-${index}.mp4`);
    await run("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=0x334455:s=320x180:d=1",
      "-f", "lavfi", "-i", `sine=frequency=${440 + index}:duration=1`,
      "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-movflags", "+faststart", videoPath,
    ]);
    const media = await importStudioMedia(project.paths.root, { sourcePath: videoPath, kind: "video" });
    const derived = await materializeStudioMediaDerivatives(project.paths.root, { mediaSha256: media.sha256 });
    if (derived.status !== "ready"
      || derived.derivatives.length !== 2
      || derived.derivatives.some((item) => item.status !== "ready")) {
      throw new Error(`真实视频 ${index} 派生未 ready，证据失败关闭。`);
    }
    videoDerivativesReady += derived.derivatives.length;
  }
  for (let index = 0; index < REAL_AUDIO; index += 1) {
    const audioPath = path.join(inputs, `real-${index}.wav`);
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", `sine=frequency=${520 + index}:duration=1`, "-c:a", "pcm_s16le", audioPath]);
    const media = await importStudioMedia(project.paths.root, { sourcePath: audioPath, kind: "audio" });
    const derived = await materializeStudioMediaDerivatives(project.paths.root, { mediaSha256: media.sha256 });
    if (derived.status !== "ready"
      || derived.derivatives.length !== 1
      || derived.derivatives.some((item) => item.status !== "ready")) {
      throw new Error(`真实音频 ${index} 派生未 ready，证据失败关闭。`);
    }
    audioDerivativesReady += derived.derivatives.length;
  }
  const coldCreateAndIndexMs = Math.round(performance.now() - started);

  const mediaPageStarted = performance.now();
  const firstPage = await listStudioMedia(project.paths.root, { limit: 100 });
  const secondPage = firstPage.nextCursor
    ? await listStudioMedia(project.paths.root, { cursor: firstPage.nextCursor, limit: 100 })
    : { items: [] };
  const searched = await listStudioMedia(project.paths.root, {
    search: `media-${String(Math.max(0, IMAGE_COUNT - 1)).padStart(5, "0")}.png`,
    limit: 10,
  });
  const firstTwoMediaPagesMs = Math.round(performance.now() - mediaPageStarted);

  const fullScanStarted = performance.now();
  const indexed: StudioMediaMetadata[] = [];
  let cursor: string | undefined;
  let mediaPages = 0;
  do {
    const page = await listStudioMedia(project.paths.root, { cursor, limit: 100 });
    indexed.push(...page.items);
    cursor = page.nextCursor;
    mediaPages += 1;
  } while (cursor);
  const fullMediaIndexScanMs = Math.round(performance.now() - fullScanStarted);

  let casObjectsVerified = 0;
  let casObjectBytes = 0;
  await inBatches(indexed, 128, async (media) => {
    const bytes = await readFile(media.objectPath);
    if (bytes.length !== media.sizeBytes || sha256(bytes) !== media.sha256) {
      throw new Error(`CAS 对象与索引不一致：${media.sha256}`);
    }
    casObjectsVerified += 1;
    casObjectBytes += bytes.length;
  });

  let decodableThumbnails = 0;
  await inBatches(thumbnailFixtures, 32, async (fixture) => {
    const metadata = await sharp(fixture.thumbnailPath!, { failOn: "error" }).metadata();
    if (metadata.format !== "webp" || metadata.width !== 64 || metadata.height !== 96) {
      throw new Error(`缩略图不可解码或尺寸错误：${fixture.thumbnailRecipeKey}`);
    }
    decodableThumbnails += 1;
  });

  const material = await getMaterialStudioState(project.paths.root);
  const uniqueShaCount = new Set(indexed.map((item) => item.sha256)).size;
  const uniqueObjectPathCount = new Set(indexed.map((item) => item.objectPath)).size;
  const gates = {
    exactMediaCount: material.counts.media === MEDIA && indexed.length === MEDIA,
    allCasObjectsVerified: casObjectsVerified === MEDIA,
    uniqueContentAddresses: uniqueShaCount === MEDIA && uniqueObjectPathCount === MEDIA,
    decodableThumbnailFloor: decodableThumbnails >= THUMBS,
    realVideoDerivatives: videoDerivativesReady === REAL_VIDEO * 2,
    realAudioDerivatives: audioDerivativesReady === REAL_AUDIO,
    realMediaKeysetPages: firstPage.items.length === Math.min(100, MEDIA)
      && secondPage.items.length === Math.min(100, Math.max(0, MEDIA - 100))
      && new Set([...firstPage.items, ...secondPage.items].map((item) => item.sha256)).size
        === firstPage.items.length + secondPage.items.length,
    realMediaSearch: searched.items.length === 1,
  };
  const status = Object.values(gates).every(Boolean) ? "pass" : "partial";
  const evidence = {
    schemaVersion: 3,
    kind: "p9-media-scale-evidence",
    status,
    createdAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    counts: {
      mediaIndexed: material.counts.media,
      requestedMedia: MEDIA,
      imageObjects: IMAGE_COUNT,
      realVideoImports: REAL_VIDEO,
      realAudioImports: REAL_AUDIO,
      casObjectsVerified,
      casObjectBytes,
      uniqueShaCount,
      uniqueObjectPathCount,
      realDecodableThumbFiles: decodableThumbnails,
      videoDerivativesReady,
      audioDerivativesReady,
    },
    performance: {
      coldCreateAndIndexMs,
      firstTwoMediaPagesMs,
      firstMediaPageSize: firstPage.items.length,
      secondMediaPageSize: secondPage.items.length,
      fullMediaIndexScanMs,
      mediaPages,
      listOwner: "listStudioMedia",
      keyset: true,
    },
    mediaQuality: {
      allIndexedObjectsLanded: casObjectsVerified === MEDIA,
      allIndexedObjectsShaAndSizeMatch: casObjectsVerified === MEDIA,
      thumbnailFormat: "webp",
      thumbnailWidth: 64,
      thumbnailHeight: 96,
      avDerivativeFailureClosesEvidence: true,
    },
    gates,
    boundaries: {
      formalStudioUntouched: true,
      formalImageGenerationCalls: 0,
      fixtureRootRemovedAfterRun: true,
    },
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: status === "pass",
    outputPath,
    ...evidence.counts,
    ...evidence.performance,
    durationMs: evidence.durationMs,
  }, null, 2));
  if (status !== "pass") process.exitCode = 1;
} finally {
  await rm(parent, { recursive: true, force: true });
}
