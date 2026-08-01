import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  importStudioMedia,
  type StudioMediaMetadata,
} from "../src/core/material-studio.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  __getGlobalStudioMediaResourceCatalogCacheMetricsForTests,
  __resetGlobalStudioMediaResourceCatalogCacheForTests,
  getGlobalStudioMediaResource,
  listGlobalStudioMediaResources,
} from "../src/core/studio-global-asset-catalog.js";
import { registerProject } from "../src/core/sidecar.js";

type ManagedShell = Awaited<ReturnType<typeof createManagedProject>>;

interface FileIdentity {
  sha256: string;
  size: string;
  mtimeNs: string;
}

const DERIVATIVE_RECIPES = {
  video_poster: "studio-video-poster:v1:first-frame:max-1280x720:webp-q82",
  video_proxy: "studio-video-proxy:v1:max-1280x720:h264-crf28-aac128k-faststart",
  audio_waveform: "studio-audio-waveform:v1:1200x160:mono:webp-q82",
} as const;

let temporaryRoot = "";
let projectsRoot = "";
let registryPath = "";
let priorRegistryPath: string | undefined;

async function fileIdentity(filePath: string): Promise<FileIdentity> {
  const [bytes, metadata] = await Promise.all([
    readFile(filePath),
    stat(filePath, { bigint: true }),
  ]);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: metadata.size.toString(),
    mtimeNs: metadata.mtimeNs.toString(),
  };
}

async function createRegisteredProject(name: string, slug: string): Promise<ManagedShell> {
  const shell = await createManagedProject({ parentRoot: projectsRoot, name, slug });
  await registerProject(shell.project);
  return shell;
}

async function importMedia(
  projectRoot: string,
  filename: string,
  content: string,
  kind: "audio" | "video",
): Promise<StudioMediaMetadata> {
  const sourcePath = path.join(projectRoot, filename);
  await writeFile(sourcePath, content, "utf8");
  return importStudioMedia(projectRoot, { sourcePath, kind });
}

function derivativeRecipeKey(
  kind: keyof typeof DERIVATIVE_RECIPES,
  mediaSha256: string,
): string {
  return createHash("sha256")
    .update(`${DERIVATIVE_RECIPES[kind]}\0${mediaSha256}`, "utf8")
    .digest("hex");
}

function insertReadyDerivative(
  databasePath: string,
  mediaSha256: string,
  kind: keyof typeof DERIVATIVE_RECIPES,
): string {
  const recipeKey = derivativeRecipeKey(kind, mediaSha256);
  const outputSha256 = createHash("sha256")
    .update(`test-output:${kind}:${mediaSha256}`, "utf8")
    .digest("hex");
  const relativePath = kind === "video_poster"
    ? `.aicanvas/derived/thumb/${recipeKey}.webp`
    : kind === "video_proxy"
      ? `.aicanvas/derived/proxy/${recipeKey}.mp4`
      : `.aicanvas/derived/waveform/${recipeKey}.webp`;
  const mimeType = kind === "video_proxy" ? "video/mp4" : "image/webp";
  const now = new Date().toISOString();
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(`
      INSERT INTO studio_media_derivatives(
        recipe_key, media_sha256, kind, status, recipe, output_sha256,
        size_bytes, mime_type, relative_path, error_code, created_at, updated_at
      ) VALUES(?, ?, ?, 'ready', ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      recipeKey,
      mediaSha256,
      kind,
      DERIVATIVE_RECIPES[kind],
      outputSha256,
      128,
      mimeType,
      relativePath,
      now,
      now,
    );
  } finally {
    db.close();
  }
  return recipeKey;
}

beforeEach(async () => {
  temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-global-media-resources-")));
  projectsRoot = path.join(temporaryRoot, "projects");
  registryPath = path.join(temporaryRoot, "runtime", "projects.json");
  await mkdir(projectsRoot, { recursive: true });
  priorRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  __resetGlobalStudioMediaResourceCatalogCacheForTests();
});

afterEach(async () => {
  __resetGlobalStudioMediaResourceCatalogCacheForTests();
  if (priorRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistryPath;
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe.sequential("全局音视频资源只读目录", () => {
  it("跨工程按 projectKey+SHA 分页，支持搜索，并只投影已存在的 ready 派生 recipe", async () => {
    const first = await createRegisteredProject("第一音视频剧本", "global-media-first");
    const second = await createRegisteredProject("第二音视频剧本", "global-media-second");
    const firstVideos: StudioMediaMetadata[] = [];
    const secondVideos: StudioMediaMetadata[] = [];
    for (let index = 0; index < 20; index += 1) {
      firstVideos.push(await importMedia(
        first.paths.root,
        index === 0 ? "needle-feature.mp4" : `first-video-${String(index).padStart(2, "0")}.mp4`,
        `first-video-content-${index}`,
        "video",
      ));
      secondVideos.push(await importMedia(
        second.paths.root,
        `second-video-${String(index).padStart(2, "0")}.mp4`,
        `second-video-content-${index}`,
        "video",
      ));
    }
    const audio = await importMedia(
      first.paths.root,
      "narration-master.wav",
      "audio-content",
      "audio",
    );

    const posterRecipeKey = insertReadyDerivative(
      first.paths.materialDatabase,
      firstVideos[0]!.sha256,
      "video_poster",
    );
    const proxyRecipeKey = insertReadyDerivative(
      first.paths.materialDatabase,
      firstVideos[0]!.sha256,
      "video_proxy",
    );
    const waveformRecipeKey = insertReadyDerivative(
      first.paths.materialDatabase,
      audio.sha256,
      "audio_waveform",
    );

    const broken = await createRegisteredProject("坏素材库工程", "global-media-broken");
    await rm(`${broken.paths.materialDatabase}-wal`, { force: true });
    await rm(`${broken.paths.materialDatabase}-shm`, { force: true });
    await writeFile(broken.paths.materialDatabase, "not-a-sqlite-database", "utf8");

    const databaseBefore = await Promise.all([
      fileIdentity(first.paths.materialDatabase),
      fileIdentity(second.paths.materialDatabase),
    ]);
    const registryBefore = await fileIdentity(registryPath);

    const [firstPage, replayedFirstPage] = await Promise.all([
      listGlobalStudioMediaResources({ kind: "video", limit: 36 }),
      listGlobalStudioMediaResources({ kind: "video", limit: 36 }),
    ]);
    expect(firstPage).toMatchObject({
      total: 40,
      counts: { total: 41, audio: 1, video: 40 },
      previewCoverage: {
        videoPosterReady: 1,
        videoProxyReady: 1,
        audioWaveformReady: 1,
      },
      registeredProjectCount: 3,
      readableProjectCount: 2,
    });
    expect(firstPage.items).toHaveLength(36);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(replayedFirstPage.items).toEqual(firstPage.items);
    expect(replayedFirstPage.nextCursor).toBe(firstPage.nextCursor);
    expect(__getGlobalStudioMediaResourceCatalogCacheMetricsForTests()).toMatchObject({
      cacheMisses: 1,
      singleflightJoins: 1,
      snapshotBuilds: 1,
      snapshotBuildAttempts: 1,
      snapshotBuildRetries: 0,
    });
    expect(firstPage.unavailableProjects).toContainEqual({
      id: broken.project.id,
      name: broken.project.name,
      reason: "material-database-invalid",
    });

    const secondPage = await listGlobalStudioMediaResources({
      kind: "video",
      cursor: firstPage.nextCursor,
      limit: 36,
    });
    expect(secondPage.items).toHaveLength(4);
    expect(secondPage.nextCursor).toBeUndefined();
    const videos = [...firstPage.items, ...secondPage.items];
    expect(new Set(videos.map((item) => (
      `${item.sourceProject.primaryRoot}\0${item.mediaSha256}`
    ))).size).toBe(40);

    const filenameSearch = await listGlobalStudioMediaResources({
      kind: "video",
      search: "needle-feature",
      limit: 36,
    });
    expect(filenameSearch.total).toBe(1);
    expect(filenameSearch.items[0]).toMatchObject({
      mediaSha256: firstVideos[0]!.sha256,
      sourceBasename: "needle-feature.mp4",
      mimeType: "video/mp4",
      preview: { kind: "video_poster", recipeKey: posterRecipeKey },
      playback: { kind: "video_proxy", recipeKey: proxyRecipeKey },
    });

    const mimeSearch = await listGlobalStudioMediaResources({
      kind: "video",
      search: "video/mp4",
      limit: 36,
    });
    expect(mimeSearch.total).toBe(40);
    const shaSearch = await listGlobalStudioMediaResources({
      kind: "video",
      search: secondVideos[0]!.sha256.slice(0, 20),
      limit: 36,
    });
    expect(shaSearch.items).toHaveLength(1);
    expect(shaSearch.items[0]!.mediaSha256).toBe(secondVideos[0]!.sha256);
    const projectSearch = await listGlobalStudioMediaResources({
      kind: "video",
      search: second.project.name,
      limit: 36,
    });
    expect(projectSearch.total).toBe(20);
    expect(projectSearch.items.every((item) => item.sourceProject.id === second.project.id)).toBe(true);

    const audioPage = await listGlobalStudioMediaResources({ kind: "audio", limit: 36 });
    expect(audioPage.total).toBe(1);
    expect(audioPage.items[0]).toMatchObject({
      mediaSha256: audio.sha256,
      kind: "audio",
      sourceBasename: "narration-master.wav",
      preview: { kind: "audio_waveform", recipeKey: waveformRecipeKey },
    });
    expect(audioPage.items[0]!.playback).toBeUndefined();
    await expect(listGlobalStudioMediaResources({
      kind: "audio",
      cursor: firstPage.nextCursor,
      limit: 36,
    })).rejects.toThrow(/游标已过期/u);
    await expect(listGlobalStudioMediaResources({
      kind: "video",
      limit: 37,
    })).rejects.toThrow(/1-36/u);

    const directVideo = await getGlobalStudioMediaResource(
      first.paths.root,
      firstVideos[0]!.sha256,
    );
    expect(directVideo).toMatchObject({
      mediaSha256: firstVideos[0]!.sha256,
      preview: { recipeKey: posterRecipeKey },
      playback: { recipeKey: proxyRecipeKey },
    });
    expect(JSON.stringify(directVideo)).not.toMatch(/object_relpath|relative_path|objectPath/u);
    expect(await getGlobalStudioMediaResource(first.paths.root, "0".repeat(64))).toBeNull();

    expect(await Promise.all([
      fileIdentity(first.paths.materialDatabase),
      fileIdentity(second.paths.materialDatabase),
    ])).toEqual(databaseBefore);
    expect(await fileIdentity(registryPath)).toEqual(registryBefore);

    const reusedMetrics = __getGlobalStudioMediaResourceCatalogCacheMetricsForTests();
    expect(reusedMetrics.snapshotBuilds).toBe(1);
    expect(reusedMetrics.projectSqliteScans).toBeGreaterThanOrEqual(2);
    expect(reusedMetrics.cacheHits).toBeGreaterThanOrEqual(7);

    await importMedia(
      second.paths.root,
      "second-dialogue.wav",
      "second-audio-content",
      "audio",
    );
    const refreshedAudio = await listGlobalStudioMediaResources({
      kind: "audio",
      limit: 36,
    });
    expect(refreshedAudio.total).toBe(2);
    expect(refreshedAudio.registryFingerprint).toBe(firstPage.registryFingerprint);
    const refreshedMetrics = __getGlobalStudioMediaResourceCatalogCacheMetricsForTests();
    expect(refreshedMetrics).toMatchObject({
      cacheInvalidations: 1,
      validationFailures: 1,
      snapshotBuilds: 2,
      snapshotBuildAttempts: 2,
    });
    expect(refreshedMetrics.projectSqliteScans)
      .toBe(reusedMetrics.projectSqliteScans * 2);
  }, 120_000);
});
