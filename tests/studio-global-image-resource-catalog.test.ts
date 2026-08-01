import { createHash } from "node:crypto";
import {
  copyFile,
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
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  importStudioMedia,
} from "../src/core/material-studio.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  __getGlobalStudioImageResourceCatalogCacheMetricsForTests,
  __resetGlobalStudioImageResourceCatalogCacheForTests,
  __setGlobalStudioImageResourceCatalogSnapshotProbeForTests,
  getGlobalStudioImageResource,
  listGlobalStudioImageResources,
} from "../src/core/studio-global-image-resource-catalog.js";
import { registerProject } from "../src/core/sidecar.js";

type ManagedShell = Awaited<ReturnType<typeof createManagedProject>>;

let temporaryRoot = "";
let projectsRoot = "";
let registryPath = "";
let priorRegistryPath: string | undefined;

async function identity(filePath: string): Promise<{
  sha256: string;
  size: string;
  mtimeNs: string;
}> {
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

async function importImage(
  projectRoot: string,
  relativePath: string,
  index: number,
) {
  const sourcePath = path.join(projectRoot, relativePath);
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await sharp({
    create: {
      width: 20 + (index % 3),
      height: 24 + (index % 5),
      channels: 3,
      background: {
        r: (index * 31) % 255,
        g: (index * 67) % 255,
        b: (index * 97) % 255,
      },
    },
  }).png().toFile(sourcePath);
  return {
    sourcePath,
    media: await importStudioMedia(projectRoot, { sourcePath, kind: "image" }),
  };
}

beforeEach(async () => {
  temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-global-images-")));
  projectsRoot = path.join(temporaryRoot, "projects");
  registryPath = path.join(temporaryRoot, "runtime", "projects.json");
  await mkdir(projectsRoot, { recursive: true });
  priorRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  __resetGlobalStudioImageResourceCatalogCacheForTests();
});

afterEach(async () => {
  __resetGlobalStudioImageResourceCatalogCacheForTests();
  if (priorRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistryPath;
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe.sequential("全项目图片总资源只读目录", () => {
  it("逐图聚合、自动分类、保留名称、36 张分页，并让新导入自动使旧游标过期", async () => {
    const characterProject = await createRegisteredProject("人物资产工程", "global-images-character");
    const storyboardProject = await createRegisteredProject("分镜生产工程", "global-images-storyboard");
    const characterMedia: Array<Awaited<ReturnType<typeof importImage>>> = [];
    const storyboardMedia: Array<Awaited<ReturnType<typeof importImage>>> = [];
    for (let index = 0; index < 20; index += 1) {
      characterMedia.push(await importImage(
        characterProject.paths.root,
        `assets/characters/人物_${String(index).padStart(2, "0")}.png`,
        index,
      ));
      storyboardMedia.push(await importImage(
        storyboardProject.paths.root,
        `episodes/EP01/storyboards/镜头_${String(index).padStart(2, "0")}_raw.png`,
        100 + index,
      ));
    }
    const aliasPath = path.join(
      characterProject.paths.root,
      "imports",
      "阿航同图别名.png",
    );
    await mkdir(path.dirname(aliasPath), { recursive: true });
    await copyFile(characterMedia[0]!.sourcePath, aliasPath);
    const aliasImport = await importStudioMedia(characterProject.paths.root, {
      sourcePath: aliasPath,
      kind: "image",
    });
    expect(aliasImport.sha256).toBe(characterMedia[0]!.media.sha256);

    const asset = await createStudioCanonicalAsset(characterProject.paths.root, {
      id: "character-ahang",
      category: "character",
      name: "阿航",
      expectedRevision: 0,
    });
    await appendStudioAssetVersion(characterProject.paths.root, {
      assetId: asset.id,
      mediaSha256: characterMedia[0]!.media.sha256,
      reviewStatus: "pending",
      sourceNote: "分类目录测试规范关联",
      expectedRevision: asset.revision,
    });

    const databasesBefore = await Promise.all([
      identity(characterProject.paths.materialDatabase),
      identity(storyboardProject.paths.materialDatabase),
    ]);
    const registryBefore = await identity(registryPath);
    const [firstPage, replayed] = await Promise.all([
      listGlobalStudioImageResources({ category: "all", limit: 36 }),
      listGlobalStudioImageResources({ category: "all", limit: 36 }),
    ]);
    expect(firstPage).toMatchObject({
      total: 40,
      counts: {
        total: 40,
        uniqueContent: 40,
        character: 20,
        storyboard: 20,
        scene: 0,
        prop: 0,
        style: 0,
        reference: 0,
        other: 0,
      },
      projectImageEntries: 40,
      uniqueContentSha256: 40,
      canonicalImageEntries: 1,
      ordinaryImageEntries: 39,
      registeredProjectCount: 2,
      readableProjectCount: 2,
      unavailableProjects: [],
    });
    expect(firstPage.items).toHaveLength(36);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(replayed.items).toEqual(firstPage.items);
    expect(replayed.nextCursor).toBe(firstPage.nextCursor);
    expect(replayed.catalogFingerprint).toBe(firstPage.catalogFingerprint);
    expect(__getGlobalStudioImageResourceCatalogCacheMetricsForTests()).toMatchObject({
      cacheMisses: 1,
      singleflightJoins: 1,
      snapshotBuilds: 1,
      snapshotBuildAttempts: 1,
      snapshotBuildRetries: 0,
      projectSqliteScans: 2,
    });

    const secondPage = await listGlobalStudioImageResources({
      category: "all",
      cursor: firstPage.nextCursor,
      limit: 36,
    });
    expect(secondPage.items).toHaveLength(4);
    expect(secondPage.nextCursor).toBeUndefined();
    const all = [...firstPage.items, ...secondPage.items];
    expect(new Set(all.map((item) => (
      `${item.sourceProject.primaryRoot}\0${item.mediaSha256}`
    ))).size).toBe(40);
    expect(all.every((item) => item.displayName.trim().length > 0)).toBe(true);
    const aliased = all.find((item) => (
      item.sourceProject.id === characterProject.project.id
      && item.mediaSha256 === characterMedia[0]!.media.sha256
    ));
    expect(aliased).toMatchObject({
      displayName: "阿航",
      originCount: 2,
      classification: {
        primaryCategory: "character",
        classificationState: "canonical",
      },
    });
    expect(aliased?.sourceNames).toEqual(expect.arrayContaining([
      "人物_00.png",
      "阿航同图别名.png",
    ]));
    expect(aliased?.associations).toHaveLength(1);

    const storyboard = await listGlobalStudioImageResources({
      category: "storyboard",
      limit: 36,
    });
    expect(storyboard.total).toBe(20);
    expect(storyboard.items.every((item) => (
      item.classification.primaryCategory === "storyboard"
      && item.classification.resourceRole === "raw"
    ))).toBe(true);
    const projectSearch = await listGlobalStudioImageResources({
      category: "all",
      search: storyboardProject.project.name,
      limit: 36,
    });
    expect(projectSearch.total).toBe(20);
    expect(projectSearch.items.every((item) => (
      item.sourceProject.id === storyboardProject.project.id
    ))).toBe(true);
    const nameSearch = await listGlobalStudioImageResources({
      category: "all",
      search: "阿航同图别名",
      limit: 36,
    });
    expect(nameSearch.items).toHaveLength(1);
    expect(nameSearch.items[0]!.mediaSha256).toBe(characterMedia[0]!.media.sha256);

    const direct = await getGlobalStudioImageResource(
      characterProject.paths.root,
      characterMedia[0]!.media.sha256,
    );
    expect(direct).toMatchObject({
      mediaSha256: characterMedia[0]!.media.sha256,
      displayName: "阿航",
      thumbnailRecipeKey: characterMedia[0]!.media.thumbnail?.recipeKey,
    });
    expect(JSON.stringify(direct)).not.toMatch(/object_relpath|thumbnail_relpath|sourcePath/u);
    expect(await getGlobalStudioImageResource(
      characterProject.paths.root,
      "0".repeat(64),
    )).toBeNull();
    const cachedMetrics = __getGlobalStudioImageResourceCatalogCacheMetricsForTests();
    expect(cachedMetrics.snapshotBuilds).toBe(1);
    expect(cachedMetrics.projectSqliteScans).toBe(2);
    expect(cachedMetrics.directedProjectSqliteScans).toBe(0);
    expect(cachedMetrics.cacheHits).toBeGreaterThanOrEqual(6);
    await expect(listGlobalStudioImageResources({
      category: "all",
      limit: 37,
    })).rejects.toThrow(/1-36/u);
    expect(await Promise.all([
      identity(characterProject.paths.materialDatabase),
      identity(storyboardProject.paths.materialDatabase),
    ])).toEqual(databasesBefore);
    expect(await identity(registryPath)).toEqual(registryBefore);

    await importImage(
      storyboardProject.paths.root,
      "episodes/EP01/storyboards/镜头_20_raw.png",
      220,
    );
    await expect(listGlobalStudioImageResources({
      category: "all",
      cursor: firstPage.nextCursor,
      limit: 36,
    })).rejects.toThrow(/游标已过期/u);
    const refreshed = await listGlobalStudioImageResources({ category: "all", limit: 1 });
    expect(refreshed.projectImageEntries).toBe(41);
    expect(refreshed.counts.storyboard).toBe(21);
    expect(__getGlobalStudioImageResourceCatalogCacheMetricsForTests()).toMatchObject({
      cacheInvalidations: 1,
      validationFailures: 1,
      snapshotBuilds: 2,
      projectSqliteScans: 4,
    });
  }, 120_000);

  it("registry 与 material SQLite/WAL/SHM 身份变化都会失效缓存", async () => {
    const project = await createRegisteredProject("缓存身份工程", "global-images-cache-identity");
    await importImage(project.paths.root, "assets/characters/缓存人物.png", 501);
    const first = await listGlobalStudioImageResources({ category: "all", limit: 36 });
    const databaseBefore = await identity(project.paths.materialDatabase);

    const audioPath = path.join(project.paths.root, "cache-identity-probe.wav");
    await writeFile(audioPath, Buffer.from("RIFF-cache-identity-probe", "utf8"));
    await importStudioMedia(project.paths.root, { sourcePath: audioPath, kind: "audio" });
    expect(await identity(project.paths.materialDatabase)).not.toEqual(databaseBefore);

    const refreshed = await listGlobalStudioImageResources({ category: "all", limit: 36 });
    expect(refreshed.items).toEqual(first.items);
    expect(refreshed.catalogFingerprint).toBe(first.catalogFingerprint);
    expect(__getGlobalStudioImageResourceCatalogCacheMetricsForTests()).toMatchObject({
      cacheInvalidations: 1,
      validationFailures: 1,
      snapshotBuilds: 2,
      snapshotBuildAttempts: 2,
      projectSqliteScans: 2,
    });

    await createRegisteredProject("新增空工程", "global-images-cache-registry-change");
    const registryRefreshed = await listGlobalStudioImageResources({
      category: "all",
      limit: 36,
    });
    expect(registryRefreshed.registeredProjectCount).toBe(2);
    expect(registryRefreshed.catalogFingerprint).not.toBe(refreshed.catalogFingerprint);
    expect(__getGlobalStudioImageResourceCatalogCacheMetricsForTests()).toMatchObject({
      cacheInvalidations: 2,
      validationFailures: 2,
      snapshotBuilds: 3,
      snapshotBuildAttempts: 3,
    });
  });

  it("构建前后身份漂移会丢弃移动快照并在有界次数内重建", async () => {
    const project = await createRegisteredProject("移动快照工程", "global-images-moving-snapshot");
    await importImage(project.paths.root, "assets/characters/稳定人物.png", 601);
    let mutated = false;
    __setGlobalStudioImageResourceCatalogSnapshotProbeForTests(async (phase, attempt) => {
      if (phase !== "before-after-identities" || attempt !== 1 || mutated) return;
      mutated = true;
      const audioPath = path.join(project.paths.root, "moving-snapshot-probe.wav");
      await writeFile(audioPath, Buffer.from("RIFF-moving-snapshot-probe", "utf8"));
      await importStudioMedia(project.paths.root, { sourcePath: audioPath, kind: "audio" });
    });

    const page = await listGlobalStudioImageResources({ category: "all", limit: 36 });
    expect(page.total).toBe(1);
    expect(mutated).toBe(true);
    expect(__getGlobalStudioImageResourceCatalogCacheMetricsForTests()).toMatchObject({
      snapshotBuilds: 1,
      snapshotBuildAttempts: 2,
      snapshotBuildRetries: 1,
      snapshotBuildFailures: 0,
      projectSqliteScans: 2,
    });
  });
});
