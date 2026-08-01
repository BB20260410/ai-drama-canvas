import { createHash } from "node:crypto";
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
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  importStudioMedia,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
  type StudioCanonicalAssetCategory,
} from "../src/core/material-studio.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  __getGlobalStudioAssetCatalogCacheMetricsForTests,
  __resetGlobalStudioAssetCatalogCacheForTests,
  getGlobalStudioAssetResourceImage,
  getGlobalStudioMediaResource,
  listGlobalStudioAssetCatalog,
  listGlobalStudioAssetResourceImages,
  listGlobalStudioMediaResources,
} from "../src/core/studio-global-asset-catalog.js";
import {
  getGlobalStudioImageResource,
  listGlobalStudioImageResources,
} from "../src/core/studio-global-image-resource-catalog.js";
import { registerProject } from "../src/core/sidecar.js";

type ManagedShell = Awaited<ReturnType<typeof createManagedProject>>;

interface FileIdentity {
  sha256: string;
  size: string;
  mtimeNs: string;
}

let temporaryRoot = "";
let projectsRoot = "";
let registryPath = "";
let activeProjectPath = "";
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

async function fileIdentities(filePaths: readonly string[]): Promise<FileIdentity[]> {
  return Promise.all(filePaths.map((filePath) => fileIdentity(filePath)));
}

async function createRegisteredProject(name: string, slug: string): Promise<ManagedShell> {
  const shell = await createManagedProject({ parentRoot: projectsRoot, name, slug });
  await registerProject(shell.project);
  return shell;
}

async function createAsset(
  projectRoot: string,
  input: {
    id: string;
    category: StudioCanonicalAssetCategory;
    name: string;
    description?: string;
    aliases?: string[];
  },
) {
  return createStudioCanonicalAsset(projectRoot, {
    id: input.id,
    category: input.category,
    name: input.name,
    expectedRevision: 0,
    ...(input.description ? { description: input.description } : {}),
    ...(input.aliases ? { aliases: input.aliases } : {}),
  });
}

async function importImage(
  projectRoot: string,
  filename: string,
  background: string,
) {
  const sourcePath = path.join(projectRoot, filename);
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await sharp({
    create: {
      width: 24,
      height: 24,
      channels: 3,
      background,
    },
  }).png().toFile(sourcePath);
  return importStudioMedia(projectRoot, { sourcePath, kind: "image" });
}

async function importMedia(
  projectRoot: string,
  filename: string,
  kind: "audio" | "video",
  content: string,
) {
  const sourcePath = path.join(projectRoot, filename);
  await writeFile(sourcePath, content, "utf8");
  return importStudioMedia(projectRoot, { sourcePath, kind });
}

async function writeIsolatedActiveProject(projectRoot: string): Promise<void> {
  await mkdir(path.dirname(activeProjectPath), { recursive: true });
  await writeFile(activeProjectPath, `${JSON.stringify({
    schemaVersion: 2,
    primaryRoot: projectRoot,
    activationId: "12345678-1234-4234-8234-123456789abc",
    activatedAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  }, null, 2)}\n`, "utf8");
}

beforeEach(async () => {
  temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-global-assets-")));
  projectsRoot = path.join(temporaryRoot, "projects");
  registryPath = path.join(temporaryRoot, "runtime", "projects.json");
  activeProjectPath = path.join(path.dirname(registryPath), "active-project.json");
  await mkdir(projectsRoot, { recursive: true });
  priorRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  __resetGlobalStudioAssetCatalogCacheForTests();
});

afterEach(async () => {
  __resetGlobalStudioAssetCatalogCacheForTests();
  if (priorRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistryPath;
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe.sequential("全剧本规范素材只读聚合", () => {
  it("聚合多个受管工程的人物/场景/道具，并隔离坏库和旧非 managed 登记", async () => {
    const first = await createRegisteredProject("第一剧本", "global-assets-first");
    const second = await createRegisteredProject("第二剧本", "global-assets-second");

    const ahang = await createAsset(first.paths.root, {
      id: "character-ahang",
      category: "character",
      name: "阿航",
      aliases: ["青年阿航"],
    });
    await createAsset(first.paths.root, {
      id: "scene-bronze-temple",
      category: "scene",
      name: "青铜神殿",
    });
    await createAsset(second.paths.root, {
      id: "character-daji",
      category: "character",
      name: "妲己",
    });
    const mask = await createAsset(second.paths.root, {
      id: "prop-golden-mask",
      category: "prop",
      name: "完整黄金面具",
    });

    const firstLinked = await importImage(first.paths.root, "ahang-authority.png", "#6f4b3e");
    await importImage(first.paths.root, "first-ordinary-a.png", "#355b74");
    await importImage(first.paths.root, "first-ordinary-b.png", "#6a7f3a");
    await appendStudioAssetVersion(first.paths.root, {
      assetId: ahang.id,
      mediaSha256: firstLinked.sha256,
      reviewStatus: "pending",
      expectedRevision: ahang.revision,
    });

    const secondLinked = await importImage(second.paths.root, "mask-authority.png", "#b38b2e");
    await importImage(second.paths.root, "second-ordinary.png", "#8e5a65");
    await appendStudioAssetVersion(second.paths.root, {
      assetId: mask.id,
      mediaSha256: secondLinked.sha256,
      reviewStatus: "pending",
      expectedRevision: mask.revision,
    });

    // 旧工程保留一套真实可读 Material Studio 数据，但移除 managed manifest。
    // 若 catalog 绕过 managed owner，这条人物和图片会错误污染全局统计。
    const legacy = await createRegisteredProject("旧非受管工程", "global-assets-legacy");
    const legacyAsset = await createAsset(legacy.paths.root, {
      id: "character-legacy-must-not-leak",
      category: "character",
      name: "旧库污染项",
    });
    const legacyMedia = await importImage(legacy.paths.root, "legacy.png", "#442f55");
    await appendStudioAssetVersion(legacy.paths.root, {
      assetId: legacyAsset.id,
      mediaSha256: legacyMedia.sha256,
      reviewStatus: "pending",
      expectedRevision: legacyAsset.revision,
    });
    await rm(legacy.paths.manifest);

    // 仍是 managed 的登记根，但 Material Studio 本体损坏；该工程必须整体失败关闭。
    const broken = await createRegisteredProject("坏素材库工程", "global-assets-broken");
    await createAsset(broken.paths.root, {
      id: "character-broken-must-not-leak",
      category: "character",
      name: "坏库污染项",
    });
    await rm(`${broken.paths.materialDatabase}-wal`, { force: true });
    await rm(`${broken.paths.materialDatabase}-shm`, { force: true });
    await writeFile(broken.paths.materialDatabase, "not-a-sqlite-database", "utf8");

    await writeIsolatedActiveProject(first.paths.root);
    const databasePaths = [
      first.paths.materialDatabase,
      second.paths.materialDatabase,
      legacy.paths.materialDatabase,
      broken.paths.materialDatabase,
    ];
    const databasesBefore = await fileIdentities(databasePaths);
    const registryBefore = await fileIdentity(registryPath);
    const activeBefore = await fileIdentity(activeProjectPath);

    const characters = await listGlobalStudioAssetCatalog({
      category: "character",
      limit: 36,
    });
    const scenes = await listGlobalStudioAssetCatalog({
      category: "scene",
      limit: 36,
    });
    const props = await listGlobalStudioAssetCatalog({
      category: "prop",
      limit: 36,
    });

    expect(characters).toMatchObject({
      total: 2,
      counts: {
        total: 4,
        character: 2,
        scene: 1,
        prop: 1,
        style: 0,
      },
      imageCoverage: {
        totalImages: 5,
        assetVersionImages: 2,
        ordinaryImages: 3,
      },
      registeredProjectCount: 4,
      readableProjectCount: 2,
    });
    expect(characters.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assetId: "character-ahang",
        category: "character",
        name: "阿航",
        sourceProject: expect.objectContaining({
          id: first.project.id,
          name: first.project.name,
          primaryRoot: first.paths.root,
        }),
      }),
      expect.objectContaining({
        assetId: "character-daji",
        category: "character",
        name: "妲己",
        sourceProject: expect.objectContaining({
          id: second.project.id,
          name: second.project.name,
          primaryRoot: second.paths.root,
        }),
      }),
    ]));
    expect(scenes).toMatchObject({
      total: 1,
      items: [expect.objectContaining({
        assetId: "scene-bronze-temple",
        category: "scene",
        name: "青铜神殿",
        sourceProject: expect.objectContaining({ id: first.project.id }),
      })],
    });
    expect(props).toMatchObject({
      total: 1,
      items: [expect.objectContaining({
        assetId: "prop-golden-mask",
        category: "prop",
        name: "完整黄金面具",
        sourceProject: expect.objectContaining({ id: second.project.id }),
      })],
    });
    expect([...characters.items, ...scenes.items, ...props.items]
      .every((item) => item.name.trim().length > 0)).toBe(true);
    expect(characters.unavailableProjects).toEqual(expect.arrayContaining([
      {
        id: legacy.project.id,
        name: legacy.project.name,
        reason: "not-managed",
      },
      {
        id: broken.project.id,
        name: broken.project.name,
        reason: "material-database-invalid",
      },
    ]));
    expect(characters.unavailableProjects).toHaveLength(2);
    expect(scenes.registryFingerprint).toBe(characters.registryFingerprint);
    expect(props.registryFingerprint).toBe(characters.registryFingerprint);
    expect(__getGlobalStudioAssetCatalogCacheMetricsForTests()).toMatchObject({
      snapshotBuilds: 1,
      projectSqliteScans: 3,
    });

    expect(await fileIdentities(databasePaths)).toEqual(databasesBefore);
    expect(await fileIdentity(registryPath)).toEqual(registryBefore);
    expect(await fileIdentity(activeProjectPath)).toEqual(activeBefore);
  }, 120_000);

  it("单页最多 36 项，复读 cursor 稳定且跨工程续页无重复，search total 为全局命中数", async () => {
    const first = await createRegisteredProject("分页剧本甲", "global-assets-page-a");
    const second = await createRegisteredProject("分页剧本乙", "global-assets-page-b");

    for (let index = 0; index < 20; index += 1) {
      await createAsset(first.paths.root, {
        id: `character-${String(index).padStart(2, "0")}`,
        category: "character",
        name: index === 0 ? "联搜角色甲" : `甲方角色 ${index}`,
        ...(index === 1 ? { aliases: ["联搜别名"] } : {}),
      });
      await createAsset(second.paths.root, {
        id: `character-${String(index).padStart(2, "0")}`,
        category: "character",
        name: `乙方角色 ${index}`,
        ...(index === 2 ? { description: "联搜描述命中" } : {}),
      });
    }
    await writeIsolatedActiveProject(first.paths.root);

    const [firstPage, replayedFirstPage] = await Promise.all([
      listGlobalStudioAssetCatalog({
        category: "character",
        limit: 36,
      }),
      listGlobalStudioAssetCatalog({
        category: "character",
        limit: 36,
      }),
    ]);
    expect(firstPage.items).toHaveLength(36);
    expect(firstPage.items.length).toBeLessThanOrEqual(36);
    expect(firstPage.total).toBe(40);
    expect(firstPage.counts).toMatchObject({ total: 40, character: 40 });
    expect(firstPage.nextCursor).toBeTruthy();
    expect(replayedFirstPage.items).toEqual(firstPage.items);
    expect(replayedFirstPage.nextCursor).toBe(firstPage.nextCursor);
    expect(replayedFirstPage.registryFingerprint).toBe(firstPage.registryFingerprint);
    expect(__getGlobalStudioAssetCatalogCacheMetricsForTests()).toMatchObject({
      cacheMisses: 1,
      singleflightJoins: 1,
      snapshotBuilds: 1,
      projectSqliteScans: 2,
    });

    const secondPage = await listGlobalStudioAssetCatalog({
      category: "character",
      cursor: firstPage.nextCursor,
      limit: 36,
    });
    expect(secondPage.items).toHaveLength(4);
    expect(secondPage.total).toBe(40);
    expect(secondPage.nextCursor).toBeUndefined();

    const allItems = [...firstPage.items, ...secondPage.items];
    const locators = allItems.map((item) => `${item.sourceProject.id}:${item.assetId}`);
    expect(new Set(locators).size).toBe(40);
    expect(new Set(allItems.map((item) => item.sourceProject.id))).toEqual(new Set([
      first.project.id,
      second.project.id,
    ]));
    expect(allItems.every((item) => item.name.trim().length > 0)).toBe(true);

    const searched = await listGlobalStudioAssetCatalog({
      category: "character",
      search: "  联搜  ",
      limit: 36,
    });
    expect(searched.total).toBe(3);
    expect(searched.items).toHaveLength(3);
    expect(new Set(searched.items.map((item) => `${item.sourceProject.id}:${item.assetId}`))).toEqual(new Set([
      `${first.project.id}:character-00`,
      `${first.project.id}:character-01`,
      `${second.project.id}:character-02`,
    ]));
    expect(searched.counts).toMatchObject({ total: 40, character: 40 });

    await expect(listGlobalStudioAssetCatalog({
      category: "character",
      limit: 37,
    })).rejects.toThrow(/1-36/u);
    expect(__getGlobalStudioAssetCatalogCacheMetricsForTests()).toMatchObject({
      snapshotBuilds: 1,
      projectSqliteScans: 2,
    });
  }, 120_000);

  it("逐张列出版本图片、合并同工程重复 SHA，并保留每条名称/版本/Review/Primary 关联", async () => {
    const first = await createRegisteredProject("图片剧本甲", "global-resource-images-a");
    const second = await createRegisteredProject("图片剧本乙", "global-resource-images-b");
    let sharedMedia: Awaited<ReturnType<typeof importImage>> | undefined;
    let sharedPrimaryVersionId = "";

    for (let index = 0; index < 20; index += 1) {
      const asset = await createAsset(first.paths.root, {
        id: `character-a-${String(index).padStart(2, "0")}`,
        category: "character",
        name: index === 0 ? "共享图主名称" : `甲方图片角色 ${index}`,
      });
      const media = await importImage(
        first.paths.root,
        `character-a-${String(index).padStart(2, "0")}.png`,
        `#${(index + 1).toString(16).padStart(6, "0")}`,
      );
      const appended = await appendStudioAssetVersion(first.paths.root, {
        assetId: asset.id,
        mediaSha256: media.sha256,
        reviewStatus: "pending",
        sourceNote: `甲方版本 ${index}`,
        expectedRevision: asset.revision,
      });
      if (index === 0) {
        const reviewed = await reviewStudioAssetVersion(first.paths.root, {
          assetId: asset.id,
          versionId: appended.version.id,
          decision: "approved",
          expectedRevision: appended.assetRevision,
          note: "共享图主名称已审核。",
        });
        await setStudioPrimaryAuthority(first.paths.root, {
          assetId: asset.id,
          versionId: appended.version.id,
          expectedRevision: reviewed.revision,
          note: "共享图 Primary。",
        });
        sharedMedia = media;
        sharedPrimaryVersionId = appended.version.id;
      }
    }

    for (let index = 0; index < 20; index += 1) {
      const asset = await createAsset(second.paths.root, {
        id: `character-b-${String(index).padStart(2, "0")}`,
        category: "character",
        name: `乙方图片角色 ${index}`,
      });
      const media = await importImage(
        second.paths.root,
        `character-b-${String(index).padStart(2, "0")}.png`,
        `#${(index + 101).toString(16).padStart(6, "0")}`,
      );
      await appendStudioAssetVersion(second.paths.root, {
        assetId: asset.id,
        mediaSha256: media.sha256,
        reviewStatus: "pending",
        sourceNote: `乙方版本 ${index}`,
        expectedRevision: asset.revision,
      });
    }

    expect(sharedMedia).toBeDefined();
    const sharedAlias = await createAsset(first.paths.root, {
      id: "character-shared-secondary-name",
      category: "character",
      name: "共享图第二名称",
    });
    const sharedPending = await appendStudioAssetVersion(first.paths.root, {
      assetId: sharedAlias.id,
      mediaSha256: sharedMedia!.sha256,
      reviewStatus: "pending",
      sourceNote: "同一图片用于第二个明确名称。",
      expectedRevision: sharedAlias.revision,
    });

    await writeIsolatedActiveProject(first.paths.root);
    const databasePaths = [first.paths.materialDatabase, second.paths.materialDatabase];
    const databasesBefore = await fileIdentities(databasePaths);
    const registryBefore = await fileIdentity(registryPath);
    const activeBefore = await fileIdentity(activeProjectPath);

    const [firstPage, replayed] = await Promise.all([
      listGlobalStudioAssetResourceImages({
        category: "character",
        limit: 36,
      }),
      listGlobalStudioAssetResourceImages({
        category: "character",
        limit: 36,
      }),
    ]);
    expect(firstPage.items).toHaveLength(36);
    expect(firstPage.total).toBe(40);
    expect(firstPage.assetCounts).toMatchObject({ total: 41, character: 41 });
    expect(firstPage.resourceCounts).toMatchObject({ total: 40, character: 40 });
    expect(firstPage.imageCoverage).toMatchObject({
      totalImages: 40,
      assetVersionImages: 40,
      ordinaryImages: 0,
    });
    expect(firstPage.nextCursor).toBeTruthy();
    expect(replayed.items).toEqual(firstPage.items);
    expect(replayed.nextCursor).toBe(firstPage.nextCursor);
    expect(__getGlobalStudioAssetCatalogCacheMetricsForTests()).toMatchObject({
      cacheMisses: 1,
      singleflightJoins: 1,
      snapshotBuilds: 1,
      projectSqliteScans: 2,
    });

    const secondPage = await listGlobalStudioAssetResourceImages({
      category: "character",
      cursor: firstPage.nextCursor,
      limit: 36,
    });
    expect(secondPage.items).toHaveLength(4);
    expect(secondPage.nextCursor).toBeUndefined();
    const allImages = [...firstPage.items, ...secondPage.items];
    expect(new Set(allImages.map((image) => `${image.sourceProject.id}:${image.mediaSha256}`)).size).toBe(40);

    const shared = allImages.find((image) => (
      image.sourceProject.id === first.project.id
      && image.mediaSha256 === sharedMedia!.sha256
    ));
    expect(shared?.associations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "共享图主名称",
        versionId: sharedPrimaryVersionId,
        reviewStatus: "approved",
        isPrimary: true,
      }),
      expect.objectContaining({
        name: "共享图第二名称",
        versionId: sharedPending.version.id,
        reviewStatus: "pending",
        isPrimary: false,
      }),
    ]));
    expect(shared?.associations).toHaveLength(2);

    const searched = await listGlobalStudioAssetResourceImages({
      category: "character",
      search: "共享图第二名称",
      limit: 36,
    });
    expect(searched.total).toBe(1);
    expect(searched.items[0]?.mediaSha256).toBe(sharedMedia!.sha256);
    expect(searched.items[0]?.associations.map((association) => association.name)).toEqual([
      "共享图主名称",
      "共享图第二名称",
    ]);

    const detail = await getGlobalStudioAssetResourceImage(first.paths.root, sharedMedia!.sha256);
    expect(detail?.associations).toEqual(shared?.associations);
    expect(detail?.thumbnailRecipeKey).toBeTruthy();
    expect(__getGlobalStudioAssetCatalogCacheMetricsForTests()).toMatchObject({
      snapshotBuilds: 1,
      projectSqliteScans: 2,
    });

    await expect(listGlobalStudioAssetResourceImages({
      category: "character",
      limit: 37,
    })).rejects.toThrow(/1-36/u);
    expect(await fileIdentities(databasePaths)).toEqual(databasesBefore);
    expect(await fileIdentity(registryPath)).toEqual(registryBefore);
    expect(await fileIdentity(activeProjectPath)).toEqual(activeBefore);
  }, 120_000);

  it("7 个总资源入口共用一次冷扫，详情首调也建统一快照且后续分类/搜索/翻页零新增扫描", async () => {
    const first = await createRegisteredProject("统一快照剧本甲", "global-unified-snapshot-a");
    const second = await createRegisteredProject("统一快照剧本乙", "global-unified-snapshot-b");
    const firstAsset = await createAsset(first.paths.root, {
      id: "character-unified-a",
      category: "character",
      name: "统一角色甲",
      aliases: ["统一别名甲"],
    });
    const firstImage = await importImage(
      first.paths.root,
      "assets/characters/统一角色甲.png",
      "#304f70",
    );
    const firstVersion = await appendStudioAssetVersion(first.paths.root, {
      assetId: firstAsset.id,
      mediaSha256: firstImage.sha256,
      reviewStatus: "pending",
      sourceNote: "统一快照 Review/Primary 样本",
      expectedRevision: firstAsset.revision,
    });
    const reviewed = await reviewStudioAssetVersion(first.paths.root, {
      assetId: firstAsset.id,
      versionId: firstVersion.version.id,
      decision: "approved",
      expectedRevision: firstVersion.assetRevision,
      note: "统一快照测试审核通过。",
    });
    await setStudioPrimaryAuthority(first.paths.root, {
      assetId: firstAsset.id,
      versionId: firstVersion.version.id,
      expectedRevision: reviewed.revision,
      note: "统一快照测试锁定 Primary。",
    });

    const secondAsset = await createAsset(second.paths.root, {
      id: "character-unified-b",
      category: "character",
      name: "统一角色乙",
    });
    const secondImage = await importImage(
      second.paths.root,
      "assets/characters/统一角色乙.png",
      "#704f30",
    );
    await appendStudioAssetVersion(second.paths.root, {
      assetId: secondAsset.id,
      mediaSha256: secondImage.sha256,
      reviewStatus: "pending",
      sourceNote: "统一快照第二条版本",
      expectedRevision: secondAsset.revision,
    });
    const ordinaryScene = await importImage(
      first.paths.root,
      "assets/scenes/统一场景普通图.png",
      "#355f48",
    );
    const firstAudio = await importMedia(
      first.paths.root,
      "统一旁白甲.wav",
      "audio",
      "RIFF-unified-audio-a",
    );
    await importMedia(
      second.paths.root,
      "统一旁白乙.wav",
      "audio",
      "RIFF-unified-audio-b",
    );

    __resetGlobalStudioAssetCatalogCacheForTests();
    const [assetImageDetail, imageDetail, mediaDetail] = await Promise.all([
      getGlobalStudioAssetResourceImage(first.paths.root, firstImage.sha256),
      getGlobalStudioImageResource(first.paths.root, ordinaryScene.sha256),
      getGlobalStudioMediaResource(first.paths.root, firstAudio.sha256),
    ]);
    expect(assetImageDetail?.associations).toContainEqual(expect.objectContaining({
      name: "统一角色甲",
      reviewStatus: "approved",
      isPrimary: true,
    }));
    expect(imageDetail).toMatchObject({
      mediaSha256: ordinaryScene.sha256,
      classification: { primaryCategory: "scene" },
    });
    expect(mediaDetail).toMatchObject({
      mediaSha256: firstAudio.sha256,
      kind: "audio",
    });
    const afterDetailColdRead = __getGlobalStudioAssetCatalogCacheMetricsForTests();
    expect(afterDetailColdRead).toMatchObject({
      cacheMisses: 1,
      snapshotBuilds: 1,
      projectSqliteScans: 2,
      directedProjectSqliteScans: 0,
      directedReadRetries: 0,
    });

    const [assets, versionImages, allImages, audio] = await Promise.all([
      listGlobalStudioAssetCatalog({ category: "character", limit: 1 }),
      listGlobalStudioAssetResourceImages({ category: "character", limit: 1 }),
      listGlobalStudioImageResources({ category: "all", limit: 1 }),
      listGlobalStudioMediaResources({ kind: "audio", limit: 1 }),
    ]);
    expect(assets.nextCursor).toBeTruthy();
    expect(versionImages.nextCursor).toBeTruthy();
    expect(allImages.nextCursor).toBeTruthy();
    expect(audio.nextCursor).toBeTruthy();
    await Promise.all([
      listGlobalStudioAssetCatalog({
        category: "character",
        cursor: assets.nextCursor,
        limit: 1,
      }),
      listGlobalStudioAssetResourceImages({
        category: "character",
        search: "统一角色甲",
        limit: 1,
      }),
      listGlobalStudioImageResources({
        category: "scene",
        search: "统一场景普通图",
        limit: 1,
      }),
      listGlobalStudioMediaResources({
        kind: "audio",
        cursor: audio.nextCursor,
        limit: 1,
      }),
      getGlobalStudioAssetResourceImage(first.paths.root, firstImage.sha256),
      getGlobalStudioImageResource(first.paths.root, ordinaryScene.sha256),
      getGlobalStudioMediaResource(first.paths.root, firstAudio.sha256),
    ]);
    expect(__getGlobalStudioAssetCatalogCacheMetricsForTests()).toMatchObject({
      snapshotBuilds: 1,
      projectSqliteScans: 2,
      directedProjectSqliteScans: 0,
      directedReadRetries: 0,
    });
  }, 120_000);

  it("任一 Material DB 内容变化都会使四类旧 cursor 失效并仅重建一次", async () => {
    const project = await createRegisteredProject("统一游标剧本", "global-unified-cursor");
    for (let index = 0; index < 2; index += 1) {
      const asset = await createAsset(project.paths.root, {
        id: `character-cursor-${index}`,
        category: "character",
        name: `游标角色 ${index}`,
      });
      const image = await importImage(
        project.paths.root,
        `assets/characters/游标角色_${index}.png`,
        index ? "#642f42" : "#2f4264",
      );
      await appendStudioAssetVersion(project.paths.root, {
        assetId: asset.id,
        mediaSha256: image.sha256,
        reviewStatus: "pending",
        expectedRevision: asset.revision,
      });
      await importMedia(
        project.paths.root,
        `游标旁白_${index}.wav`,
        "audio",
        `RIFF-cursor-audio-${index}`,
      );
    }

    const [assets, versionImages, allImages, audio] = await Promise.all([
      listGlobalStudioAssetCatalog({ category: "character", limit: 1 }),
      listGlobalStudioAssetResourceImages({ category: "character", limit: 1 }),
      listGlobalStudioImageResources({ category: "all", limit: 1 }),
      listGlobalStudioMediaResources({ kind: "audio", limit: 1 }),
    ]);
    expect([
      assets.nextCursor,
      versionImages.nextCursor,
      allImages.nextCursor,
      audio.nextCursor,
    ].every(Boolean)).toBe(true);
    expect(__getGlobalStudioAssetCatalogCacheMetricsForTests()).toMatchObject({
      snapshotBuilds: 1,
      projectSqliteScans: 1,
    });

    await importImage(
      project.paths.root,
      "assets/scenes/游标变化新增场景.png",
      "#49613c",
    );
    const results = await Promise.allSettled([
      listGlobalStudioAssetCatalog({
        category: "character",
        cursor: assets.nextCursor,
        limit: 1,
      }),
      listGlobalStudioAssetResourceImages({
        category: "character",
        cursor: versionImages.nextCursor,
        limit: 1,
      }),
      listGlobalStudioImageResources({
        category: "all",
        cursor: allImages.nextCursor,
        limit: 1,
      }),
      listGlobalStudioMediaResources({
        kind: "audio",
        cursor: audio.nextCursor,
        limit: 1,
      }),
    ]);
    expect(results.every((result) => (
      result.status === "rejected" && /游标已过期/u.test(String(result.reason))
    ))).toBe(true);
    expect(__getGlobalStudioAssetCatalogCacheMetricsForTests()).toMatchObject({
      cacheInvalidations: 1,
      snapshotBuilds: 2,
      projectSqliteScans: 2,
      directedProjectSqliteScans: 0,
    });
  }, 120_000);

  it("工程素材或 registry 变化后并发读只重建一次，随后分类/图片/音视频继续零扫描热读", async () => {
    const first = await createRegisteredProject("失效剧本甲", "global-assets-invalidation-a");
    const second = await createRegisteredProject("失效剧本乙", "global-assets-invalidation-b");
    await createAsset(first.paths.root, {
      id: "character-invalidation-a",
      category: "character",
      name: "失效测试角色甲",
    });

    const [coldAssets, coldImages, coldAllImages] = await Promise.all([
      listGlobalStudioAssetCatalog({ category: "character", limit: 36 }),
      listGlobalStudioAssetResourceImages({ category: "character", limit: 36 }),
      listGlobalStudioImageResources({ category: "all", limit: 36 }),
    ]);
    expect(coldAssets.total).toBe(1);
    expect(coldImages.total).toBe(0);
    expect(coldAllImages.total).toBe(0);
    expect(__getGlobalStudioAssetCatalogCacheMetricsForTests()).toMatchObject({
      cacheMisses: 1,
      singleflightJoins: 2,
      snapshotBuilds: 1,
      projectSqliteScans: 2,
    });

    await createAsset(second.paths.root, {
      id: "character-invalidation-b",
      category: "character",
      name: "失效测试角色乙",
    });
    const [refreshedAssets, refreshedImages, refreshedAllImages, refreshedAudio] = await Promise.all([
      listGlobalStudioAssetCatalog({ category: "character", limit: 36 }),
      listGlobalStudioAssetResourceImages({ category: "character", limit: 36 }),
      listGlobalStudioImageResources({ category: "all", limit: 36 }),
      listGlobalStudioMediaResources({ kind: "audio", limit: 36 }),
    ]);
    expect(refreshedAssets.total).toBe(2);
    expect(refreshedImages.total).toBe(0);
    expect(refreshedAllImages.total).toBe(0);
    expect(refreshedAudio.total).toBe(0);
    expect(__getGlobalStudioAssetCatalogCacheMetricsForTests()).toMatchObject({
      cacheInvalidations: 1,
      validationFailures: 4,
      snapshotBuilds: 2,
      projectSqliteScans: 4,
    });

    const third = await createRegisteredProject("新增登记剧本", "global-assets-invalidation-c");
    const [registryAssets, registryImages, registryAllImages, registryVideo] = await Promise.all([
      listGlobalStudioAssetCatalog({ category: "character", limit: 36 }),
      listGlobalStudioAssetResourceImages({ category: "character", limit: 36 }),
      listGlobalStudioImageResources({ category: "all", limit: 36 }),
      listGlobalStudioMediaResources({ kind: "video", limit: 36 }),
    ]);
    expect(registryAssets.registeredProjectCount).toBe(3);
    expect(registryImages.registeredProjectCount).toBe(3);
    expect(registryAllImages.registeredProjectCount).toBe(3);
    expect(registryVideo.registeredProjectCount).toBe(3);
    expect(registryAssets.items.some((item) => (
      item.sourceProject.id === third.project.id
    ))).toBe(false);
    expect(__getGlobalStudioAssetCatalogCacheMetricsForTests()).toMatchObject({
      cacheInvalidations: 2,
      snapshotBuilds: 3,
      projectSqliteScans: 7,
    });

    await Promise.all([
      listGlobalStudioAssetCatalog({
        category: "character",
        search: "失效测试",
        limit: 1,
      }),
      listGlobalStudioAssetResourceImages({
        category: "character",
        limit: 1,
      }),
      listGlobalStudioImageResources({ category: "all", limit: 1 }),
      listGlobalStudioMediaResources({ kind: "audio", limit: 1 }),
    ]);
    expect(__getGlobalStudioAssetCatalogCacheMetricsForTests()).toMatchObject({
      snapshotBuilds: 3,
      projectSqliteScans: 7,
    });
  }, 120_000);
});
