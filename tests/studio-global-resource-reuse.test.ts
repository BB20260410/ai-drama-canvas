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
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  type StudioCommandRequest,
} from "../src/core/command-bus.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  getMaterialStudioState,
  getStudioCanonicalAsset,
  getStudioMedia,
  importStudioMedia,
  listStudioGlobalResourceReuseProvenance,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
  verifyStudioMediaObject,
} from "../src/core/material-studio.js";
import { registerProject } from "../src/core/sidecar.js";

type ManagedShell = Awaited<ReturnType<typeof createManagedProject>>;

interface FileIdentity {
  sha256: string;
  sizeBytes: string;
  mtimeNs: string;
}

let temporaryRoot = "";
let projectsRoot = "";
let registryPath = "";
let previousRegistryPath: string | undefined;

async function fileIdentity(filePath: string): Promise<FileIdentity> {
  const [bytes, metadata] = await Promise.all([
    readFile(filePath),
    stat(filePath, { bigint: true }),
  ]);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: metadata.size.toString(),
    mtimeNs: metadata.mtimeNs.toString(),
  };
}

function checkpointDatabase(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function publicCommandRequestHash(projectRoot: string, request: StudioCommandRequest): string {
  return createHash("sha256")
    .update(stable({ projectRoot: path.resolve(projectRoot), request }))
    .digest("hex");
}

function countRows(databasePath: string, table: string): number {
  if (!/^[a-z_]+$/u.test(table)) throw new Error("测试表名无效。");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  } finally {
    db.close();
  }
}

function sqliteObjectExists(databasePath: string, name: string): boolean {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Boolean(db.prepare(`
      SELECT 1 AS found
      FROM sqlite_master
      WHERE name = ?
      LIMIT 1
    `).get(name));
  } finally {
    db.close();
  }
}

function envelope(index: number, request: StudioCommandRequest) {
  const suffix = String(index).padStart(4, "0");
  return {
    requestId: `global-resource-reuse-request-${suffix}`,
    idempotencyKey: `global-resource-reuse-key-${suffix}`,
    request,
  };
}

async function executeReuse(
  targetRoot: string,
  index: number,
  request: StudioCommandRequest,
): Promise<Record<string, any>> {
  const command = await executeIdempotentCommand(targetRoot, envelope(index, request));
  expect(command.status).toBe("succeeded");
  expect(command.replayed).toBe(false);
  return command.result as Record<string, any>;
}

async function registeredPair(label: string): Promise<{
  source: ManagedShell;
  target: ManagedShell;
}> {
  const source = await createManagedProject({
    parentRoot: projectsRoot,
    name: `${label}来源`,
    slug: `${label}-source`,
  });
  const target = await createManagedProject({
    parentRoot: projectsRoot,
    name: `${label}目标`,
    slug: `${label}-target`,
  });
  await registerProject(source.project);
  await registerProject(target.project);
  return { source, target };
}

beforeEach(async () => {
  temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-global-resource-reuse-")));
  projectsRoot = path.join(temporaryRoot, "projects");
  registryPath = path.join(temporaryRoot, "runtime", "projects.json");
  await mkdir(projectsRoot, { recursive: true });
  previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
});

afterEach(async () => {
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe.sequential("总资源跨项目调用", () => {
  it("只读导出来源 approved Primary，并在目标建立 pending 候选且重复调用不追加版本", async () => {
    const { source, target } = await registeredPair("asset-reuse");
    const imagePath = path.join(temporaryRoot, "source-character.png");
    await sharp({
      create: {
        width: 64,
        height: 96,
        channels: 3,
        background: { r: 66, g: 45, b: 35 },
      },
    }).png().toFile(imagePath);
    const media = await importStudioMedia(source.paths.root, {
      sourcePath: imagePath,
      kind: "image",
    });
    const created = await createStudioCanonicalAsset(source.paths.root, {
      id: "character-global-resource-source",
      category: "character",
      name: "总资源阿航",
      aliases: ["阿航"],
      identityFeatures: ["青年脸型"],
      positiveLocks: ["黑色猎装"],
      negativeLocks: ["禁止换脸"],
      defaultPrompt: "电影写实",
      expectedRevision: 0,
    });
    const appended = await appendStudioAssetVersion(source.paths.root, {
      assetId: created.id,
      mediaSha256: media.sha256,
      reviewStatus: "pending",
      sourceNote: "总资源复用权威源",
      expectedRevision: created.revision,
    });
    const reviewed = await reviewStudioAssetVersion(source.paths.root, {
      assetId: created.id,
      versionId: appended.version.id,
      decision: "approved",
      note: "来源工程人工视觉审核通过",
      expectedRevision: appended.assetRevision,
    });
    const primary = await setStudioPrimaryAuthority(source.paths.root, {
      assetId: created.id,
      versionId: appended.version.id,
      note: "来源工程 Primary",
      expectedRevision: reviewed.revision,
    });
    checkpointDatabase(source.paths.materialDatabase);
    expect(sqliteObjectExists(
      source.paths.materialDatabase,
      "studio_global_resource_reuse_provenance",
    )).toBe(false);
    const [databaseBefore, registryBefore, sourceCountsBefore] = await Promise.all([
      fileIdentity(source.paths.materialDatabase),
      fileIdentity(registryPath),
      getMaterialStudioState(source.paths.root),
    ]);

    const request: StudioCommandRequest = {
      command: "reuse_studio_global_resource",
      payload: {
        resourceKind: "asset",
        sourceProjectRoot: source.paths.root,
        expectedSourceProjectId: source.project.id,
        sourceAssetId: created.id,
        sourceVersionId: appended.version.id,
        expectedSourceAssetRevision: primary.revision,
        targetExpectedRevision: 0,
      },
    };
    const imported = await executeReuse(target.paths.root, 1, request);
    expect(imported).toMatchObject({
      schemaVersion: 1,
      kind: "studio-global-resource-reuse-result",
      resourceKind: "asset",
      disposition: "imported-pending",
      sourceProjectId: source.project.id,
      sourceAssetId: created.id,
      sourceVersionId: appended.version.id,
      mediaSha256: media.sha256,
      reviewStatus: "pending",
      reviewRequired: true,
      primaryPromotionRequired: true,
    });
    const targetAsset = await getStudioCanonicalAsset(target.paths.root, imported.targetAssetId);
    expect(targetAsset?.primaryAuthority).toBeUndefined();
    expect(targetAsset?.versions).toHaveLength(1);
    expect(targetAsset?.versions[0]).toMatchObject({
      id: imported.targetVersionId,
      mediaSha256: media.sha256,
      reviewStatus: "pending",
    });

    const repeated = await executeReuse(target.paths.root, 2, request);
    expect(repeated).toMatchObject({
      disposition: "already-imported",
      targetAssetId: imported.targetAssetId,
      targetVersionId: imported.targetVersionId,
      reviewStatus: "pending",
    });
    expect((await getStudioCanonicalAsset(target.paths.root, imported.targetAssetId))?.versions)
      .toHaveLength(1);
    expect((await getMaterialStudioState(source.paths.root)).counts)
      .toEqual(sourceCountsBefore.counts);
    expect(await fileIdentity(source.paths.materialDatabase)).toEqual(databaseBefore);
    expect(await fileIdentity(registryPath)).toEqual(registryBefore);
    expect(sqliteObjectExists(
      source.paths.materialDatabase,
      "studio_global_resource_reuse_provenance",
    )).toBe(false);
  });

  it("复制 audio/video CAS 并在同一目标库登记结构化来源，重复精确请求不产生第二条业务写入", async () => {
    const { source, target } = await registeredPair("media-reuse");
    const sourceFixtures = [
      { resourceKind: "audio" as const, name: "voice.wav", bytes: Buffer.from("RIFF-global-audio-resource") },
      { resourceKind: "video" as const, name: "trailer.mp4", bytes: Buffer.from("ftyp-global-video-resource") },
    ];
    const sourceMedia = [];
    for (const fixture of sourceFixtures) {
      const sourcePath = path.join(temporaryRoot, fixture.name);
      await writeFile(sourcePath, fixture.bytes);
      sourceMedia.push({
        fixture,
        media: await importStudioMedia(source.paths.root, {
          sourcePath,
          kind: fixture.resourceKind,
        }),
      });
    }
    checkpointDatabase(source.paths.materialDatabase);
    expect(sqliteObjectExists(
      source.paths.materialDatabase,
      "studio_global_resource_reuse_provenance",
    )).toBe(false);
    const [databaseBefore, registryBefore, sourceCountsBefore] = await Promise.all([
      fileIdentity(source.paths.materialDatabase),
      fileIdentity(registryPath),
      getMaterialStudioState(source.paths.root),
    ]);

    for (const [index, entry] of sourceMedia.entries()) {
      const request: StudioCommandRequest = {
        command: "reuse_studio_global_resource",
        payload: {
          resourceKind: entry.fixture.resourceKind,
          sourceProjectRoot: source.paths.root,
          expectedSourceProjectId: source.project.id,
          sourceMediaSha256: entry.media.sha256,
          expectedSourceMediaSizeBytes: entry.media.sizeBytes,
          targetExpectedRevision: 0,
        },
      };
      const imported = await executeReuse(target.paths.root, 10 + index * 2, request);
      expect(imported).toMatchObject({
        schemaVersion: 1,
        kind: "studio-global-resource-reuse-result",
        resourceKind: entry.fixture.resourceKind,
        disposition: "imported",
        sourceProjectId: source.project.id,
        sourceMediaSha256: entry.media.sha256,
        targetMediaSha256: entry.media.sha256,
        sizeBytes: entry.media.sizeBytes,
        mimeType: entry.media.mimeType,
        sourceBasename: entry.media.sourceBasename,
      });
      const targetMedia = await getStudioMedia(target.paths.root, entry.media.sha256);
      expect(targetMedia).toMatchObject({
        sha256: entry.media.sha256,
        kind: entry.fixture.resourceKind,
        sizeBytes: entry.media.sizeBytes,
        mimeType: entry.media.mimeType,
      });
      expect(targetMedia?.objectPath.startsWith(target.paths.mediaCas)).toBe(true);
      expect(await verifyStudioMediaObject(target.paths.root, entry.media.sha256)).toBe(true);
      const provenance = await listStudioGlobalResourceReuseProvenance(
        target.paths.root,
        entry.media.sha256,
      );
      expect(provenance).toHaveLength(1);
      expect(provenance[0]).toMatchObject({
        id: imported.provenanceId,
        sourceProjectId: source.project.id,
        sourceProjectName: source.project.name,
        sourceManifestFingerprint: source.manifestFingerprint,
        sourceMediaSha256: entry.media.sha256,
        targetMediaSha256: entry.media.sha256,
        mediaKind: entry.fixture.resourceKind,
        sourceMediaSizeBytes: entry.media.sizeBytes,
        sourceMimeType: entry.media.mimeType,
        sourceBasename: entry.media.sourceBasename,
      });

      const firstCommandRequestHash = publicCommandRequestHash(target.paths.root, request);
      expect(provenance[0]?.commandRequestHash).toBe(firstCommandRequestHash);
      const repeatedRequest: StudioCommandRequest = {
        ...request,
        payload: {
          ...request.payload,
          // 同一受管根的等价绝对写法会产生不同 commandRequestHash；业务身份仍相同。
          sourceProjectRoot: `${source.paths.root}/`,
        },
      };
      expect(publicCommandRequestHash(target.paths.root, repeatedRequest))
        .not.toBe(firstCommandRequestHash);
      const businessCountsBeforeRepeat = {
        media: countRows(target.paths.materialDatabase, "studio_media"),
        provenance: countRows(
          target.paths.materialDatabase,
          "studio_global_resource_reuse_provenance",
        ),
        ordinaryImports: countRows(target.paths.materialDatabase, "studio_media_imports"),
      };
      const [targetDatabaseBeforeRepeat, targetCasBeforeRepeat] = await Promise.all([
        fileIdentity(target.paths.materialDatabase),
        fileIdentity(targetMedia!.objectPath),
      ]);
      const repeated = await executeReuse(
        target.paths.root,
        11 + index * 2,
        repeatedRequest,
      );
      expect(repeated).toMatchObject({
        disposition: "already-present",
        provenanceId: imported.provenanceId,
        targetMediaSha256: entry.media.sha256,
      });
      expect({
        media: countRows(target.paths.materialDatabase, "studio_media"),
        provenance: countRows(
          target.paths.materialDatabase,
          "studio_global_resource_reuse_provenance",
        ),
        ordinaryImports: countRows(target.paths.materialDatabase, "studio_media_imports"),
      }).toEqual(businessCountsBeforeRepeat);
      expect(await fileIdentity(target.paths.materialDatabase))
        .toEqual(targetDatabaseBeforeRepeat);
      expect(await fileIdentity(targetMedia!.objectPath)).toEqual(targetCasBeforeRepeat);
      expect((await listStudioGlobalResourceReuseProvenance(
        target.paths.root,
        entry.media.sha256,
      ))[0]?.commandRequestHash).toBe(firstCommandRequestHash);
    }

    expect(countRows(target.paths.materialDatabase, "studio_media")).toBe(2);
    expect(countRows(target.paths.materialDatabase, "studio_global_resource_reuse_provenance")).toBe(2);
    expect(countRows(target.paths.materialDatabase, "studio_media_imports")).toBe(0);
    expect((await getMaterialStudioState(source.paths.root)).counts)
      .toEqual(sourceCountsBefore.counts);
    expect(await fileIdentity(source.paths.materialDatabase)).toEqual(databaseBefore);
    expect(await fileIdentity(registryPath)).toEqual(registryBefore);
    expect(sqliteObjectExists(
      source.paths.materialDatabase,
      "studio_global_resource_reuse_provenance",
    )).toBe(false);
  });

  it("复制普通图片到目标 CAS、生成 ready 缩略图并只登记独立 append-only 来源", async () => {
    const { source, target } = await registeredPair("image-reuse");
    const imagePath = path.join(temporaryRoot, "ordinary-shot.png");
    await sharp({
      create: {
        width: 640,
        height: 360,
        channels: 3,
        background: { r: 37, g: 68, b: 92 },
      },
    }).png().toFile(imagePath);
    const sourceMedia = await importStudioMedia(source.paths.root, {
      sourcePath: imagePath,
      kind: "image",
    });
    const sourceCountsBefore = (await getMaterialStudioState(source.paths.root)).counts;
    checkpointDatabase(source.paths.materialDatabase);
    const [databaseBefore, registryBefore] = await Promise.all([
      fileIdentity(source.paths.materialDatabase),
      fileIdentity(registryPath),
    ]);
    expect(sqliteObjectExists(
      source.paths.materialDatabase,
      "studio_global_image_resource_reuse_provenance",
    )).toBe(false);

    const request: StudioCommandRequest = {
      command: "reuse_studio_global_resource",
      payload: {
        resourceKind: "image",
        sourceProjectRoot: source.paths.root,
        expectedSourceProjectId: source.project.id,
        sourceMediaSha256: sourceMedia.sha256,
        expectedSourceMediaSizeBytes: sourceMedia.sizeBytes,
        targetExpectedRevision: 0,
      },
    };
    const imported = await executeReuse(target.paths.root, 20, request);
    expect(imported).toMatchObject({
      schemaVersion: 1,
      kind: "studio-global-resource-reuse-result",
      resourceKind: "image",
      disposition: "imported",
      sourceProjectId: source.project.id,
      sourceMediaSha256: sourceMedia.sha256,
      targetMediaSha256: sourceMedia.sha256,
      sizeBytes: sourceMedia.sizeBytes,
      mimeType: "image/png",
      sourceBasename: "ordinary-shot.png",
    });

    const targetMedia = await getStudioMedia(target.paths.root, sourceMedia.sha256);
    expect(targetMedia).toMatchObject({
      sha256: sourceMedia.sha256,
      kind: "image",
      derivativeStatus: "ready",
      sizeBytes: sourceMedia.sizeBytes,
    });
    expect(targetMedia?.objectPath.startsWith(target.paths.mediaCas)).toBe(true);
    expect(targetMedia?.thumbnail?.path.startsWith(target.paths.mediaPreviews)).toBe(true);
    expect(await verifyStudioMediaObject(target.paths.root, sourceMedia.sha256)).toBe(true);
    const thumbnailMetadata = await sharp(targetMedia!.thumbnail!.path, {
      failOn: "error",
    }).metadata();
    expect(thumbnailMetadata).toMatchObject({
      format: "webp",
      width: 512,
      height: 288,
    });
    expect(countRows(target.paths.materialDatabase, "studio_media_imports")).toBe(0);
    expect((await getMaterialStudioState(target.paths.root)).counts).toMatchObject({
      canonicalAssets: 0,
      assetVersions: 0,
      primaryAuthorities: 0,
      versionReviews: 0,
    });

    const provenance = await listStudioGlobalResourceReuseProvenance(
      target.paths.root,
      sourceMedia.sha256,
    );
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toMatchObject({
      id: imported.provenanceId,
      sourceProjectId: source.project.id,
      sourceProjectName: source.project.name,
      sourceManifestFingerprint: source.manifestFingerprint,
      sourceMediaSha256: sourceMedia.sha256,
      targetMediaSha256: sourceMedia.sha256,
      mediaKind: "image",
      sourceMediaSizeBytes: sourceMedia.sizeBytes,
      sourceMimeType: "image/png",
      sourceBasename: "ordinary-shot.png",
      commandRequestHash: publicCommandRequestHash(target.paths.root, request),
    });
    expect(sqliteObjectExists(
      target.paths.materialDatabase,
      "studio_global_image_resource_reuse_provenance_no_update",
    )).toBe(true);
    expect(sqliteObjectExists(
      target.paths.materialDatabase,
      "studio_global_image_resource_reuse_provenance_no_delete",
    )).toBe(true);

    const businessCountsBeforeRepeat = {
      media: countRows(target.paths.materialDatabase, "studio_media"),
      provenance: countRows(
        target.paths.materialDatabase,
        "studio_global_image_resource_reuse_provenance",
      ),
      imports: countRows(target.paths.materialDatabase, "studio_media_imports"),
    };
    const [targetDatabaseBeforeRepeat, targetCasBeforeRepeat, targetThumbBeforeRepeat] =
      await Promise.all([
        fileIdentity(target.paths.materialDatabase),
        fileIdentity(targetMedia!.objectPath),
        fileIdentity(targetMedia!.thumbnail!.path),
      ]);
    const repeated = await executeReuse(target.paths.root, 21, {
      ...request,
      payload: { ...request.payload, sourceProjectRoot: `${source.paths.root}/` },
    });
    expect(repeated).toMatchObject({
      disposition: "already-present",
      provenanceId: imported.provenanceId,
      targetMediaSha256: sourceMedia.sha256,
    });
    expect({
      media: countRows(target.paths.materialDatabase, "studio_media"),
      provenance: countRows(
        target.paths.materialDatabase,
        "studio_global_image_resource_reuse_provenance",
      ),
      imports: countRows(target.paths.materialDatabase, "studio_media_imports"),
    }).toEqual(businessCountsBeforeRepeat);
    expect(await fileIdentity(target.paths.materialDatabase)).toEqual(targetDatabaseBeforeRepeat);
    expect(await fileIdentity(targetMedia!.objectPath)).toEqual(targetCasBeforeRepeat);
    expect(await fileIdentity(targetMedia!.thumbnail!.path)).toEqual(targetThumbBeforeRepeat);

    const appendOnlyDb = new DatabaseSync(target.paths.materialDatabase);
    try {
      expect(() => appendOnlyDb.prepare(`
        UPDATE studio_global_image_resource_reuse_provenance
        SET source_project_name = '禁止改写'
        WHERE id = ?
      `).run(imported.provenanceId)).toThrow(/append-only/u);
      expect(() => appendOnlyDb.prepare(`
        DELETE FROM studio_global_image_resource_reuse_provenance
        WHERE id = ?
      `).run(imported.provenanceId)).toThrow(/append-only/u);
    } finally {
      appendOnlyDb.close();
    }

    expect((await getMaterialStudioState(source.paths.root)).counts).toEqual(sourceCountsBefore);
    expect(await fileIdentity(source.paths.materialDatabase)).toEqual(databaseBefore);
    expect(await fileIdentity(registryPath)).toEqual(registryBefore);
    expect(sqliteObjectExists(
      source.paths.materialDatabase,
      "studio_global_image_resource_reuse_provenance",
    )).toBe(false);
  });

  it("目标已存在同 SHA 图片时仍补记来源，但不增加媒体、普通导入或规范资产", async () => {
    const { source, target } = await registeredPair("image-existing");
    const firstPath = path.join(temporaryRoot, "existing-source.png");
    const secondPath = path.join(temporaryRoot, "existing-target.png");
    const imageBytes = await sharp({
      create: {
        width: 120,
        height: 160,
        channels: 4,
        background: { r: 113, g: 71, b: 42, alpha: 1 },
      },
    }).png().toBuffer();
    await Promise.all([
      writeFile(firstPath, imageBytes),
      writeFile(secondPath, imageBytes),
    ]);
    const [sourceMedia, targetMediaBefore] = await Promise.all([
      importStudioMedia(source.paths.root, { sourcePath: firstPath, kind: "image" }),
      importStudioMedia(target.paths.root, { sourcePath: secondPath, kind: "image" }),
    ]);
    expect(targetMediaBefore.sha256).toBe(sourceMedia.sha256);
    const targetCountsBefore = (await getMaterialStudioState(target.paths.root)).counts;
    const ordinaryImportsBefore = countRows(target.paths.materialDatabase, "studio_media_imports");

    const imported = await executeReuse(target.paths.root, 22, {
      command: "reuse_studio_global_resource",
      payload: {
        resourceKind: "image",
        sourceProjectRoot: source.paths.root,
        expectedSourceProjectId: source.project.id,
        sourceMediaSha256: sourceMedia.sha256,
        expectedSourceMediaSizeBytes: sourceMedia.sizeBytes,
        targetExpectedRevision: 0,
      },
    });
    expect(imported).toMatchObject({
      resourceKind: "image",
      disposition: "already-present",
      sourceMediaSha256: sourceMedia.sha256,
      targetMediaSha256: sourceMedia.sha256,
    });
    expect(countRows(target.paths.materialDatabase, "studio_media")).toBe(1);
    expect(countRows(target.paths.materialDatabase, "studio_media_imports"))
      .toBe(ordinaryImportsBefore);
    expect((await getMaterialStudioState(target.paths.root)).counts).toEqual(targetCountsBefore);
    expect(await listStudioGlobalResourceReuseProvenance(
      target.paths.root,
      sourceMedia.sha256,
    )).toMatchObject([{
      id: imported.provenanceId,
      mediaKind: "image",
      sourceProjectId: source.project.id,
    }]);
  });

  it("registry 必须按 projectId + root 精确匹配，拒绝把同 ID/不同根或同根/不同 ID 猜成来源", async () => {
    const { source, target } = await registeredPair("registry-identity");
    const targetBefore = (await getMaterialStudioState(target.paths.root)).counts;
    await expect(executeIdempotentCommand(target.paths.root, envelope(30, {
      command: "reuse_studio_global_resource",
      payload: {
        resourceKind: "audio",
        sourceProjectRoot: source.paths.root,
        expectedSourceProjectId: target.project.id,
        sourceMediaSha256: "a".repeat(64),
        expectedSourceMediaSizeBytes: 1,
        targetExpectedRevision: 0,
      },
    }))).rejects.toThrow(/projectId \+ projectRoot|registry/u);
    await expect(executeIdempotentCommand(target.paths.root, envelope(31, {
      command: "reuse_studio_global_resource",
      payload: {
        resourceKind: "video",
        sourceProjectRoot: target.paths.root,
        expectedSourceProjectId: target.project.id,
        sourceMediaSha256: "b".repeat(64),
        expectedSourceMediaSizeBytes: 1,
        targetExpectedRevision: 0,
      },
    }))).rejects.toThrow(/同一 projectId|当前工程内/u);
    expect((await getMaterialStudioState(target.paths.root)).counts).toEqual(targetBefore);
  });
});
