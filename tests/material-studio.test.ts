import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  MaterialStudioConflictError,
  appendStudioAssetRelation,
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  getMaterialStudioState,
  getMaterialStudioThumbnailRecipe,
  ensureStudioImageThumbnail,
  getStudioIdentityIndexSnapshot,
  getStudioCanonicalAsset,
  importStudioMedia,
  initializeMaterialStudio,
  listStudioAssetRelations,
  listStudioCanonicalAssets,
  listStudioMedia,
  listStudioMediaImportOrigins,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
  updateStudioCanonicalAsset,
  verifyStudioMediaObject,
} from "../src/core/material-studio.js";
import { STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS } from "../src/core/studio-sqlite-busy.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await chmod(path.join(root, "unreadable"), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-material-studio-"));
  roots.push(root);
  return root;
}

async function writeImage(root: string, name: string, color = "#315a68", width = 900, height = 1_600): Promise<string> {
  const target = path.join(root, name);
  await sharp({ create: { width, height, channels: 3, background: color } }).png().toFile(target);
  return target;
}

async function writeMedia(root: string, name: string, content: string): Promise<string> {
  const target = path.join(root, name);
  await writeFile(target, content, "utf8");
  return target;
}

describe("受管素材库 v1", () => {
  it("未来 schema 只读探测后失败关闭，不改写数据库字节", async () => {
    const root = await project();
    const sidecar = path.join(root, ".aicanvas");
    await mkdir(sidecar, { recursive: true });
    const databasePath = path.join(sidecar, "material-studio.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE studio_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO studio_meta VALUES ('schema_version', '999');");
    db.close();
    const before = await readFile(databasePath);

    await expect(initializeMaterialStudio(root)).rejects.toThrow("不支持的素材库 schema_version：999");
    expect(await readFile(databasePath)).toEqual(before);
  });

  it("CAS 私有目录为符号链接时拒绝初始化，不把对象写到工程外", async () => {
    const root = await project();
    const outside = await project();
    await mkdir(path.join(root, ".aicanvas"), { recursive: true });
    await symlink(outside, path.join(root, ".aicanvas", "objects"));

    await expect(initializeMaterialStudio(root)).rejects.toThrow(/符号链接|私有目录/u);
    expect(await readdir(outside)).toEqual([]);
  });

  it("初始化专用 WAL 数据库，不扫描工程内容", async () => {
    const root = await project();
    const unrelated = path.join(root, "unreadable", "deep");
    await mkdir(unrelated, { recursive: true });
    await writeFile(path.join(unrelated, "legacy-should-not-be-scanned.png"), "not-an-image", "utf8");
    await chmod(path.join(root, "unreadable"), 0o000);

    const state = await initializeMaterialStudio(root);
    expect(state).toMatchObject({
      schemaVersion: 1,
      databasePath: path.join(root, ".aicanvas", "material-studio.sqlite"),
      pragmas: { journalMode: "wal", foreignKeys: true, busyTimeoutMs: STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS },
      counts: {
        media: 0,
        mediaImports: 0,
        canonicalAssets: 0,
        characters: 0,
        scenes: 0,
        props: 0,
        styles: 0,
        assetVersions: 0,
        assetDefinitions: 0,
        primaryAuthorities: 0,
        authorityEvents: 0,
        versionReviews: 0,
      },
    });
    expect((await lstat(state.databasePath)).isFile()).toBe(true);
    expect((await readdir(path.join(root, ".aicanvas"))).sort()).toEqual(expect.arrayContaining(["derived", "material-studio.sqlite", "objects"]));
    expect((await getMaterialStudioState(root)).counts).toEqual(state.counts);
  });

  it("初始器会为旧库原位补齐历史表不可变守卫", async () => {
    const root = await project();
    const state = await initializeMaterialStudio(root);
    const historicalGuards = [
      "studio_asset_versions_no_update",
      "studio_asset_versions_no_delete",
      "studio_asset_definitions_no_update",
      "studio_asset_definitions_no_delete",
      "studio_asset_aliases_no_update",
      "studio_asset_aliases_no_delete",
      "studio_authority_events_no_update",
      "studio_authority_events_no_delete",
      "studio_media_identity_no_update",
      "studio_media_no_delete",
      "studio_media_imports_no_update",
      "studio_media_imports_no_delete",
    ];
    const before = new DatabaseSync(state.databasePath);
    for (const trigger of historicalGuards) before.exec(`DROP TRIGGER ${trigger}`);
    before.close();

    await initializeMaterialStudio(root);
    const upgraded = new DatabaseSync(state.databasePath, { readOnly: true });
    const installed = upgraded.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name IN (${historicalGuards.map(() => "?").join(", ")})
      ORDER BY name
    `).all(...historicalGuards) as Array<{ name: string }>;
    upgraded.close();
    expect(installed.map((row) => row.name)).toEqual([...historicalGuards].sort());
  });

  it("大文件以流式 SHA 导入工程 CAS，重复 SHA 不产生第二份 blob，图片生成冻结配方缩略图", async () => {
    const root = await project();
    const firstPath = await writeImage(root, "authoritative.png", "#67452d", 1_200, 900);
    const expectedSha256 = createHash("sha256").update(await readFile(firstPath)).digest("hex");
    const first = await importStudioMedia(root, { sourcePath: firstPath, expectedSha256 });
    expect(first).toMatchObject({
      sha256: expectedSha256,
      kind: "image",
      derivativeStatus: "ready",
      thumbnail: { recipe: getMaterialStudioThumbnailRecipe(), format: "webp" },
    });
    expect(first.objectPath).toBe(path.join(root, ".aicanvas", "objects", "sha256", expectedSha256.slice(0, 2), expectedSha256));
    expect(Math.max(first.thumbnail!.width, first.thumbnail!.height)).toBe(512);
    expect(await sharp(first.thumbnail!.path).metadata()).toMatchObject({ format: "webp", width: 512, height: 384 });

    const duplicateSource = path.join(root, "same-bytes-renamed.png");
    await writeFile(duplicateSource, await readFile(firstPath));
    const duplicate = await importStudioMedia(root, { sourcePath: duplicateSource });
    expect(duplicate.objectPath).toBe(first.objectPath);
    expect((await listStudioMedia(root)).items).toHaveLength(1);
    const origins = await listStudioMediaImportOrigins(root, expectedSha256, { limit: 1 });
    expect(origins.items).toHaveLength(1);
    expect(origins.nextCursor).toBeTruthy();
    const remainingOrigins = await listStudioMediaImportOrigins(root, expectedSha256, { cursor: origins.nextCursor, limit: 1 });
    const allOrigins = [...origins.items, ...remainingOrigins.items];
    expect(allOrigins).toHaveLength(2);
    expect(allOrigins.map((origin) => origin.sourceBasename).sort()).toEqual(["authoritative.png", "same-bytes-renamed.png"]);
    expect(allOrigins.every((origin) => origin.mediaSha256 === expectedSha256 && origin.source.scope === "project")).toBe(true);
    expect(allOrigins.find((origin) => origin.sourceBasename === "authoritative.png")?.expectedSha256).toBe(expectedSha256);
    expect(allOrigins.find((origin) => origin.sourceBasename === "same-bytes-renamed.png")?.expectedSha256).toBeUndefined();
    expect((await getMaterialStudioState(root)).counts).toMatchObject({ media: 1, mediaImports: 2 });
    expect((await listStudioMediaImportOrigins(root, expectedSha256)).items).toEqual(allOrigins);
    expect(await readdir(path.dirname(first.objectPath))).toEqual([expectedSha256]);
    expect(await verifyStudioMediaObject(root, expectedSha256)).toBe(true);

    const db = new DatabaseSync(path.join(root, ".aicanvas", "material-studio.sqlite"));
    const stored = db.prepare("SELECT typeof(object_relpath) AS object_type, length(object_relpath) AS object_length FROM studio_media").get() as { object_type: string; object_length: number };
    db.close();
    expect(stored.object_type).toBe("text");
    expect(stored.object_length).toBeLessThan(200);
  });

  it("图片缩略图缺失或损坏时可恢复，损坏派生先隔离且不覆盖媒体 CAS", async () => {
    const root = await project();
    const sourcePath = await writeImage(root, "recoverable.png", "#355b74", 960, 540);
    const media = await importStudioMedia(root, { sourcePath });
    const objectBytes = await readFile(media.objectPath);
    const thumbnailPath = media.thumbnail!.path;

    await rm(thumbnailPath);
    const restoredMissing = await ensureStudioImageThumbnail(root, media.sha256);
    expect(restoredMissing.thumbnail?.path).toBe(thumbnailPath);
    expect(await sharp(thumbnailPath, { failOn: "error" }).metadata()).toMatchObject({ format: "webp" });

    await writeFile(thumbnailPath, "corrupt-thumbnail", "utf8");
    const restoredCorrupt = await ensureStudioImageThumbnail(root, media.sha256);
    expect(restoredCorrupt.thumbnail?.path).toBe(thumbnailPath);
    expect(await sharp(thumbnailPath, { failOn: "error" }).metadata()).toMatchObject({ format: "webp" });
    expect(await readdir(path.join(root, ".aicanvas", "quarantine", "thumbnails")))
      .toHaveLength(1);
    expect(await readFile(media.objectPath)).toEqual(objectBytes);
  });

  it("视频和音频只登记 pending 派生，不调用转码器", async () => {
    const root = await project();
    const video = await importStudioMedia(root, { sourcePath: await writeMedia(root, "clip.mp4", "fixture-video") });
    const audio = await importStudioMedia(root, { sourcePath: await writeMedia(root, "voice.wav", "fixture-audio") });
    expect(video).toMatchObject({ kind: "video", derivativeStatus: "pending" });
    expect(audio).toMatchObject({ kind: "audio", derivativeStatus: "pending" });
    expect(video.thumbnail).toBeUndefined();
    expect(audio.thumbnail).toBeUndefined();
    expect((await readdir(path.join(root, ".aicanvas", "derived", "thumb")))).toEqual([]);

    const asset = await createStudioCanonicalAsset(root, {
      id: "character-video-must-not-be-authority",
      expectedRevision: 0,
      category: "character",
      name: "视频不能替代角色权威图",
    });
    await expect(appendStudioAssetVersion(root, {
      assetId: asset.id,
      mediaSha256: video.sha256,
      reviewStatus: "pending",
      expectedRevision: asset.revision,
      sourceNote: "仅用于验证媒体边界",
    })).rejects.toThrow("只接受 image");
    expect((await getStudioCanonicalAsset(root, asset.id))?.revision).toBe(asset.revision);
  });

  it("拒绝 expected SHA 不符、符号链接以及流式读取期间的源漂移", async () => {
    const root = await project();
    await initializeMaterialStudio(root);
    const source = await writeMedia(root, "voice.wav", "stable");
    await expect(importStudioMedia(root, { sourcePath: source, expectedSha256: "0".repeat(64) })).rejects.toThrow("SHA-256 不匹配");
    const linked = path.join(root, "linked.wav");
    await symlink(source, linked);
    await expect(importStudioMedia(root, { sourcePath: linked, kind: "audio" })).rejects.toThrow("符号链接");

    const drifting = path.join(root, "drifting.wav");
    await writeFile(drifting, "");
    await truncate(drifting, 64 * 1024 * 1024);
    let stop = false;
    let tick = 1;
    const churn = (async () => {
      while (!stop) {
        const stamp = new Date(Date.now() + tick++ * 1_000);
        await utimes(drifting, stamp, stamp);
        await delay(1);
      }
    })();
    try {
      await expect(importStudioMedia(root, { sourcePath: drifting, kind: "audio" })).rejects.toThrow("漂移");
    } finally {
      stop = true;
      await churn;
    }
    expect((await getMaterialStudioState(root)).counts.media).toBe(0);
  });

  it("媒体列表使用不重复的键集分页，并强制单页不超过 100", async () => {
    const root = await project();
    for (let index = 0; index < 7; index += 1) {
      await importStudioMedia(root, { sourcePath: await writeMedia(root, `voice-${index}.mp3`, `audio-${index}`) });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listStudioMedia(root, { cursor, limit: 2 });
      seen.push(...page.items.map((item) => item.sha256));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual([...seen].sort());
    await expect(listStudioMedia(root, { limit: 101 })).rejects.toThrow("1-100");
    await expect(listStudioMedia(root, { cursor: "not-a-cursor" })).rejects.toThrow("cursor");
  });

  it("类别必须显式，alias 可同名并返回歧义候选", async () => {
    const root = await project();
    await expect(createStudioCanonicalAsset(root, {
      expectedRevision: 0,
      category: "person" as never,
      name: "错误类别",
    })).rejects.toThrow("character、scene、prop 或 style");
    const a = await createStudioCanonicalAsset(root, {
      id: "character-ahang-young",
      expectedRevision: 0,
      category: "character",
      name: "青年阿航",
      description: "固定脸与发型",
      aliases: ["阿航", "男主"],
    });
    const b = await createStudioCanonicalAsset(root, {
      id: "character-ahang-child",
      expectedRevision: 0,
      category: "character",
      name: "童年阿航",
      aliases: ["阿航"],
    });
    expect(a.revision).toBe(1);
    expect(b.revision).toBe(1);
    const ambiguous = await listStudioCanonicalAssets(root, { search: "阿航", category: "character" });
    expect(ambiguous.items.map((item) => item.id)).toEqual(["character-ahang-child", "character-ahang-young"]);
    expect(ambiguous.items.every((item) => item.aliases.includes("阿航"))).toBe(true);
  });

  it("style 是可检索、可授权、可关联且可更新的一等规范资产", async () => {
    const root = await project();
    const styleMedia = await importStudioMedia(root, {
      sourcePath: await writeImage(root, "style-authority.png", "#193743"),
    });
    const style = await createStudioCanonicalAsset(root, {
      id: "style-dudu-cinematic",
      expectedRevision: 0,
      category: "style",
      name: "嘟嘟电影写实风格",
      aliases: ["青铜神话电影风格"],
      identityFeatures: ["电影写实", "古蜀青铜质感"],
      positiveLocks: ["统一冷暖对比"],
      negativeLocks: ["禁止卡通扁平化"],
      defaultPrompt: "保持电影写实和古蜀青铜质感。",
    });
    const prop = await createStudioCanonicalAsset(root, {
      id: "prop-style-target",
      expectedRevision: 0,
      category: "prop",
      name: "风格关联道具",
    });
    const appended = await appendStudioAssetVersion(root, {
      assetId: style.id,
      mediaSha256: styleMedia.sha256,
      reviewStatus: "pending",
      expectedRevision: style.revision,
      sourceNote: "用户批准的风格母图",
    });
    const reviewed = await reviewStudioAssetVersion(root, {
      assetId: style.id,
      versionId: appended.version.id,
      decision: "approved",
      expectedRevision: appended.assetRevision,
      note: "风格、色彩和材质验收通过",
    });
    const authoritative = await setStudioPrimaryAuthority(root, {
      assetId: style.id,
      versionId: appended.version.id,
      expectedRevision: reviewed.revision,
      note: "风格一等资产主权威",
    });
    const updated = await updateStudioCanonicalAsset(root, {
      assetId: style.id,
      expectedRevision: authoritative.revision,
      description: "S1 全季统一风格来源",
      aliases: ["S1风格锁"],
    });
    const relation = await appendStudioAssetRelation(root, {
      id: "relation-style-reference-prop",
      kind: "reference_of",
      subjectAssetId: updated.id,
      objectAssetId: prop.id,
      expectedSubjectRevision: updated.revision,
      expectedObjectRevision: prop.revision,
      role: "visual-style-reference",
    });

    expect(relation).toMatchObject({
      subject: { assetId: style.id, category: "style", authorityMediaSha256: styleMedia.sha256 },
      object: { assetId: prop.id, category: "prop" },
    });
    expect((await listStudioCanonicalAssets(root, {
      category: "style",
      search: "S1风格锁",
    })).items).toMatchObject([{
      id: style.id,
      category: "style",
      primaryAuthority: { mediaSha256: styleMedia.sha256 },
    }]);
    expect((await getStudioIdentityIndexSnapshot(root, ["青铜神话电影风格"])).entries)
      .toMatchObject([{ assetId: style.id, category: "style", matchKind: "alias" }]);
    expect((await listStudioAssetRelations(root, { assetId: style.id })).items)
      .toMatchObject([{ id: relation.id, subject: { category: "style" } }]);
    expect((await getMaterialStudioState(root)).counts).toMatchObject({
      canonicalAssets: 2,
      styles: 1,
      props: 1,
      primaryAuthorities: 1,
      assetRelations: 1,
    });
  });

  it("旧库类别 CHECK 原位迁移为 style v2，并完整保留权威、身份索引和关系历史", async () => {
    const root = await project();
    const media = await importStudioMedia(root, {
      sourcePath: await writeImage(root, "legacy-character-authority.png", "#49372d"),
    });
    const character = await createStudioCanonicalAsset(root, {
      id: "character-legacy-category",
      expectedRevision: 0,
      category: "character",
      name: "旧库角色",
      aliases: ["旧库身份别名"],
    });
    const prop = await createStudioCanonicalAsset(root, {
      id: "prop-legacy-category",
      expectedRevision: 0,
      category: "prop",
      name: "旧库道具",
    });
    const appended = await appendStudioAssetVersion(root, {
      assetId: character.id,
      mediaSha256: media.sha256,
      reviewStatus: "pending",
      expectedRevision: character.revision,
    });
    const reviewed = await reviewStudioAssetVersion(root, {
      assetId: character.id,
      versionId: appended.version.id,
      decision: "approved",
      expectedRevision: appended.assetRevision,
      note: "旧库权威验收",
    });
    const authoritative = await setStudioPrimaryAuthority(root, {
      assetId: character.id,
      versionId: appended.version.id,
      expectedRevision: reviewed.revision,
    });
    const relation = await appendStudioAssetRelation(root, {
      id: "relation-legacy-category",
      kind: "reference_of",
      subjectAssetId: prop.id,
      objectAssetId: authoritative.id,
      expectedSubjectRevision: prop.revision,
      expectedObjectRevision: authoritative.revision,
      role: "legacy-preservation",
    });

    const databasePath = path.join(root, ".aicanvas", "material-studio.sqlite");
    const legacy = new DatabaseSync(databasePath);
    // 仅在临时测试库关闭 defensive，以构造真实 v1 CHECK；产品迁移路径从不放宽该保护。
    // Node 22.22.2 的 node:sqlite 无 enableDefensive 且 defensive 默认关闭
    //（writable_schema 直接可用）；feature-detect 以兼容未来提供该 API 的版本。
    const legacyDefensive = (legacy as DatabaseSync & { enableDefensive?: (enabled: boolean) => void }).enableDefensive;
    if (typeof legacyDefensive === "function") legacyDefensive.call(legacy, false);
    const schemaVersion = Number((legacy.prepare("PRAGMA schema_version").get() as { schema_version: number }).schema_version);
    legacy.exec(`
      PRAGMA writable_schema=ON;
      UPDATE sqlite_schema
      SET sql = replace(sql, ', ''style''', '')
      WHERE type = 'table'
        AND name IN (
          'studio_canonical_assets',
          'studio_asset_identity_keys',
          'studio_asset_definitions',
          'studio_asset_relations'
        );
      UPDATE studio_meta SET value = '1' WHERE key = 'asset_category_schema';
      PRAGMA schema_version=${schemaVersion + 1};
      PRAGMA writable_schema=OFF;
    `);
    legacy.close();

    const legacyProbe = new DatabaseSync(databasePath, { readOnly: true });
    const legacySql = legacyProbe.prepare(`
      SELECT group_concat(sql, ' ') AS sql
      FROM sqlite_schema
      WHERE type = 'table'
        AND name IN (
          'studio_canonical_assets',
          'studio_asset_identity_keys',
          'studio_asset_definitions',
          'studio_asset_relations'
        )
    `).get() as { sql: string };
    legacyProbe.close();
    expect(legacySql.sql).not.toContain("'style'");

    const migrated = await initializeMaterialStudio(root);
    expect(migrated.counts).toMatchObject({
      canonicalAssets: 2,
      characters: 1,
      props: 1,
      styles: 0,
      primaryAuthorities: 1,
      assetRelations: 1,
    });
    expect(await getStudioCanonicalAsset(root, character.id)).toMatchObject({
      revision: relation.object.assetRevision,
      primaryAuthority: { versionId: appended.version.id, mediaSha256: media.sha256 },
      authorityHistory: [{ versionId: appended.version.id }],
    });
    expect((await getStudioIdentityIndexSnapshot(root, ["旧库身份别名"])).entries)
      .toMatchObject([{ assetId: character.id, category: "character", matchKind: "alias" }]);
    expect((await listStudioAssetRelations(root, { assetId: character.id })).items)
      .toMatchObject([{ id: relation.id, role: "legacy-preservation" }]);

    const migratedDb = new DatabaseSync(databasePath, { readOnly: true });
    const categoryCapability = migratedDb.prepare("SELECT value FROM studio_meta WHERE key = 'asset_category_schema'")
      .get() as { value: string };
    const migratedSql = migratedDb.prepare(`
      SELECT group_concat(sql, ' ') AS sql
      FROM sqlite_schema
      WHERE type = 'table'
        AND name IN (
          'studio_canonical_assets',
          'studio_asset_identity_keys',
          'studio_asset_definitions',
          'studio_asset_relations'
        )
    `).get() as { sql: string };
    const foreignKeyFailures = migratedDb.prepare("PRAGMA foreign_key_check").all();
    const integrity = migratedDb.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    migratedDb.close();
    expect(categoryCapability.value).toBe("2");
    expect((migratedSql.sql.match(/'style'/gu) ?? [])).toHaveLength(5);
    expect(foreignKeyFailures).toEqual([]);
    expect(integrity.integrity_check).toBe("ok");

    const style = await createStudioCanonicalAsset(root, {
      id: "style-after-legacy-migration",
      expectedRevision: 0,
      category: "style",
      name: "迁移后风格锁",
    });
    expect(style.category).toBe("style");
    expect((await getMaterialStudioState(root)).counts.styles).toBe(1);
  });

  it("资产版本恒以 pending 追加，只有留下不可变批准收据后才可经 CAS 提升为主权威", async () => {
    const root = await project();
    const pendingMedia = await importStudioMedia(root, { sourcePath: await writeImage(root, "pending.png", "#222222") });
    const approvedMedia = await importStudioMedia(root, { sourcePath: await writeImage(root, "approved.png", "#553311") });
    const created = await createStudioCanonicalAsset(root, {
      id: "prop-mask",
      expectedRevision: 0,
      category: "prop",
      name: "完整黄金面具",
      aliases: ["黄金面具"],
      identityFeatures: ["完整结构"],
      positiveLocks: ["古蜀黄金质感"],
      negativeLocks: ["禁止半面具", "禁止裂面具"],
      defaultPrompt: "完整黄金面具只作为身份来源，不得擅自改变结构。",
    });
    expect(created).toMatchObject({
      currentDefinitionVersionId: expect.stringMatching(/^definition-/),
      identityFeatures: ["完整结构"],
      positiveLocks: ["古蜀黄金质感"],
      negativeLocks: ["禁止半面具", "禁止裂面具"],
      definitionVersions: [{ ordinal: 1, assetRevision: 1 }],
    });
    for (const forbiddenStatus of ["approved", "rejected"] as const) {
      await expect(appendStudioAssetVersion(root, {
        assetId: created.id,
        mediaSha256: pendingMedia.sha256,
        reviewStatus: forbiddenStatus,
        expectedRevision: created.revision,
      } as never)).rejects.toThrow("只能创建为 pending");
    }
    expect((await getStudioCanonicalAsset(root, created.id))?.revision).toBe(created.revision);
    const pending = await appendStudioAssetVersion(root, created.id, pendingMedia.sha256, "pending", created.revision);
    expect(pending).toMatchObject({ assetRevision: 2, version: { ordinal: 1, reviewStatus: "pending" } });
    expect((await getStudioCanonicalAsset(root, created.id))?.versions).toMatchObject([{
      id: pending.version.id,
      mediaSha256: pendingMedia.sha256,
      thumbnailRecipeKey: pendingMedia.thumbnail?.recipeKey,
      reviewStatus: "pending",
    }]);
    await expect(setStudioPrimaryAuthority(root, created.id, pending.version.id, pending.assetRevision)).rejects.toThrow("approved");

    const reviewed = await reviewStudioAssetVersion(root, {
      assetId: created.id,
      versionId: pending.version.id,
      decision: "rejected",
      expectedRevision: pending.assetRevision,
      note: "结构漂移",
    });
    expect(reviewed).toMatchObject({
      revision: 3,
      versions: [{ id: pending.version.id, reviewStatus: "rejected" }],
      reviewHistory: [{ versionId: pending.version.id, toStatus: "rejected", note: "结构漂移" }],
    });

    const approvalCandidate = await appendStudioAssetVersion(root, {
      assetId: created.id,
      mediaSha256: approvedMedia.sha256,
      reviewStatus: "pending",
      sourceNote: "完整面具三视图权威来源",
      expectedRevision: reviewed.revision,
    });
    expect(approvalCandidate).toMatchObject({
      assetRevision: 4,
      version: { ordinal: 2, reviewStatus: "pending", sourceNote: "完整面具三视图权威来源" },
    });
    await expect(setStudioPrimaryAuthority(root, created.id, approvalCandidate.version.id, 3)).rejects.toBeInstanceOf(MaterialStudioConflictError);
    const approvalReview = await reviewStudioAssetVersion(root, {
      assetId: created.id,
      versionId: approvalCandidate.version.id,
      decision: "approved",
      expectedRevision: approvalCandidate.assetRevision,
      note: "完整结构、材质与三视图验收通过",
    });
    expect(approvalReview.versions.find((version) => version.id === approvalCandidate.version.id)?.reviewStatus).toBe("approved");
    const authoritative = await setStudioPrimaryAuthority(root, {
      assetId: created.id,
      versionId: approvalCandidate.version.id,
      expectedRevision: approvalReview.revision,
    });
    expect(authoritative).toMatchObject({
      revision: 6,
      versionCount: 2,
      primaryAuthority: { versionId: approvalCandidate.version.id, mediaSha256: approvedMedia.sha256 },
      authorityHistory: [{ versionId: approvalCandidate.version.id, assetRevision: 6 }],
    });
    const byAuthoritySha = await listStudioCanonicalAssets(root, { search: approvedMedia.sha256.slice(0, 20) });
    expect(byAuthoritySha.items).toMatchObject([{
      id: created.id,
      primaryAuthority: { mediaSha256: approvedMedia.sha256 },
    }]);
    await expect(updateStudioCanonicalAsset(root, created.id, { expectedRevision: 4, description: "过期写入" })).rejects.toBeInstanceOf(MaterialStudioConflictError);
    const updated = await updateStudioCanonicalAsset(root, {
      assetId: created.id,
      expectedRevision: authoritative.revision,
      description: "固定完整结构，禁止半面具",
      aliases: ["P01身份来源"],
    });
    expect(updated).toMatchObject({ revision: 7, versionCount: 2, description: "固定完整结构，禁止半面具" });
    expect(updated.aliases).toEqual(expect.arrayContaining(["完整黄金面具", "黄金面具", "P01身份来源"]));
    expect(updated.versions.map((version) => ({ id: version.id, sourceNote: version.sourceNote }))).toEqual([
      { id: pending.version.id, sourceNote: "" },
      { id: approvalCandidate.version.id, sourceNote: "完整面具三视图权威来源" },
    ]);
    expect(updated.definitionVersions).toHaveLength(2);
    expect(updated.definitionVersions[1]).toMatchObject({ assetRevision: 7, negativeLocks: ["禁止半面具", "禁止裂面具"] });

    const db = new DatabaseSync(path.join(root, ".aicanvas", "material-studio.sqlite"));
    expect(() => db.prepare("UPDATE studio_version_reviews SET note = 'tampered' WHERE version_id = ?").run(approvalCandidate.version.id))
      .toThrow("append-only");
    expect(() => db.prepare("DELETE FROM studio_version_reviews WHERE version_id = ?").run(approvalCandidate.version.id))
      .toThrow("append-only");

    const immutableCases = [
      {
        update: "UPDATE studio_asset_versions SET source_note = 'tampered' WHERE id = ?",
        remove: "DELETE FROM studio_asset_versions WHERE id = ?",
        id: approvalCandidate.version.id,
        message: "studio_asset_versions is append-only",
      },
      {
        update: "UPDATE studio_asset_definitions SET description = 'tampered' WHERE id = ?",
        remove: "DELETE FROM studio_asset_definitions WHERE id = ?",
        id: updated.currentDefinitionVersionId,
        message: "studio_asset_definitions is append-only",
      },
      {
        update: "UPDATE studio_asset_aliases SET alias = 'tampered' WHERE asset_id = ? AND normalized_alias = '黄金面具'",
        remove: "DELETE FROM studio_asset_aliases WHERE asset_id = ? AND normalized_alias = '黄金面具'",
        id: created.id,
        message: "studio_asset_aliases is append-only",
      },
      {
        update: "UPDATE studio_authority_events SET note = 'tampered' WHERE id = ?",
        remove: "DELETE FROM studio_authority_events WHERE id = ?",
        id: authoritative.authorityHistory[0]!.id,
        message: "studio_authority_events is append-only",
      },
    ];
    for (const immutable of immutableCases) {
      expect(() => db.prepare(immutable.update).run(immutable.id)).toThrow(immutable.message);
      expect(() => db.prepare(immutable.remove).run(immutable.id)).toThrow(immutable.message);
    }
    expect(() => db.prepare("UPDATE studio_media SET mime_type = 'image/jpeg' WHERE sha256 = ?").run(approvedMedia.sha256))
      .toThrow("content identity and source metadata are immutable");
    expect(() => db.prepare("DELETE FROM studio_media WHERE sha256 = ?").run(approvedMedia.sha256))
      .toThrow("studio_media content records are append-only");
    const importOrigin = db.prepare("SELECT id FROM studio_media_imports WHERE media_sha256 = ? ORDER BY imported_at, id LIMIT 1")
      .get(approvedMedia.sha256) as { id: string };
    expect(() => db.prepare("UPDATE studio_media_imports SET source_basename = 'tampered.png' WHERE id = ?").run(importOrigin.id))
      .toThrow("studio_media_imports is append-only");
    expect(() => db.prepare("DELETE FROM studio_media_imports WHERE id = ?").run(importOrigin.id))
      .toThrow("studio_media_imports is append-only");

    const derivativeKey = "f".repeat(64);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO studio_media_derivatives(
        recipe_key, media_sha256, kind, status, recipe, output_sha256,
        size_bytes, mime_type, relative_path, error_code, created_at, updated_at
      ) VALUES(?, ?, 'video_proxy', 'blocked', 'test-recipe', NULL, NULL, NULL, NULL, 'engine-missing', ?, ?)
    `).run(derivativeKey, approvedMedia.sha256, now, now);
    expect(db.prepare(`
      UPDATE studio_media_derivatives
      SET status = 'failed', error_code = 'retry-failed', updated_at = ?
      WHERE recipe_key = ?
    `).run(new Date().toISOString(), derivativeKey).changes).toBe(1);
    db.close();
  });

  it("历史版本禁止伪造 UPDATE，直接插入 approved 但没有审核收据也不能提升", async () => {
    const root = await project();
    const media = await importStudioMedia(root, { sourcePath: await writeImage(root, "forged-approved.png", "#4b3a21") });
    const asset = await createStudioCanonicalAsset(root, {
      id: "character-forged-review",
      expectedRevision: 0,
      category: "character",
      name: "伪造审核角色",
    });
    const pending = await appendStudioAssetVersion(root, {
      assetId: asset.id,
      mediaSha256: media.sha256,
      reviewStatus: "pending",
      expectedRevision: asset.revision,
    });
    const db = new DatabaseSync(path.join(root, ".aicanvas", "material-studio.sqlite"));
    expect(() => db.prepare("UPDATE studio_asset_versions SET review_status = 'approved' WHERE id = ?").run(pending.version.id))
      .toThrow("studio_asset_versions is append-only");
    const forgedVersionId = "version-forged-approved-without-receipt";
    db.prepare(`
      INSERT INTO studio_asset_versions(
        id, asset_id, ordinal, media_sha256, review_status, source_note, created_at
      ) VALUES(?, ?, 2, ?, 'approved', 'direct-db-forgery', ?)
    `).run(forgedVersionId, asset.id, media.sha256, new Date().toISOString());
    db.close();

    await expect(setStudioPrimaryAuthority(root, {
      assetId: asset.id,
      versionId: forgedVersionId,
      expectedRevision: pending.assetRevision,
    })).rejects.toThrow("缺少 pending→approved 不可变审核记录");
    const unchanged = await getStudioCanonicalAsset(root, asset.id);
    expect(unchanged).toMatchObject({
      revision: pending.assetRevision,
      reviewHistory: [],
    });
    expect(unchanged?.primaryAuthority).toBeUndefined();
  });

  it("10000 条资产元数据仍走 limit/keyset 查询，并可在重启后恢复", async () => {
    const root = await project();
    await initializeMaterialStudio(root);
    const databasePath = path.join(root, ".aicanvas", "material-studio.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const insertAsset = db.prepare(`
      INSERT INTO studio_canonical_assets(id, category, name, description, revision, primary_version_id, created_at, updated_at)
      VALUES(?, ?, ?, '', 1, NULL, ?, ?)
    `);
    const insertAlias = db.prepare("INSERT INTO studio_asset_aliases(asset_id, alias, normalized_alias, created_at) VALUES(?, ?, ?, ?)");
    const insertDefinition = db.prepare(`
      INSERT INTO studio_asset_definitions(
        id, asset_id, ordinal, asset_revision, category, name, description,
        aliases_json, identity_features_json, positive_locks_json, negative_locks_json,
        default_prompt, created_at
      ) VALUES(?, ?, 1, 1, ?, ?, '', ?, '[]', '[]', '[]', '', ?)
    `);
    const now = new Date().toISOString();
    for (let index = 0; index < 10_000; index += 1) {
      const id = `asset-${String(index).padStart(5, "0")}`;
      const name = `素材${String(index).padStart(5, "0")}`;
      const category = index % 3 === 0 ? "character" : index % 3 === 1 ? "scene" : "prop";
      insertAsset.run(id, category, name, now, now);
      insertAlias.run(id, name, name, now);
      insertDefinition.run(`definition-${id}`, id, category, name, JSON.stringify([name]), now);
    }
    db.exec("COMMIT");
    db.close();

    const started = performance.now();
    const exact = await listStudioCanonicalAssets(root, { search: "素材09999", category: "character", limit: 10 });
    const elapsed = performance.now() - started;
    expect(exact.items.map((item) => item.id)).toEqual(["asset-09999"]);
    expect(elapsed).toBeLessThan(2_000);

    const first = await listStudioCanonicalAssets(root, { limit: 100 });
    const second = await listStudioCanonicalAssets(root, { cursor: first.nextCursor, limit: 100 });
    expect(first.items).toHaveLength(100);
    expect(second.items).toHaveLength(100);
    expect(second.items[0]!.id).toBe("asset-00100");
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(200);

    const restarted = await getMaterialStudioState(root);
    expect(restarted.counts.canonicalAssets).toBe(10_000);
    expect((await getStudioCanonicalAsset(root, "asset-09999"))?.name).toBe("素材09999");
  });

  it("10000 条图片视频音频元数据分页时只返回轻量索引，不读取媒体本体", async () => {
    const root = await project();
    await initializeMaterialStudio(root);
    const databasePath = path.join(root, ".aicanvas", "material-studio.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const insert = db.prepare(`
      INSERT INTO studio_media(
        sha256, kind, size_bytes, mime_type, source_basename, object_relpath,
        derivative_status, thumbnail_recipe_key, thumbnail_relpath,
        thumbnail_width, thumbnail_height, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const recipe = getMaterialStudioThumbnailRecipe();
    const now = new Date().toISOString();
    for (let index = 0; index < 10_000; index += 1) {
      const sha256 = index.toString(16).padStart(64, "0");
      const kind = index % 3 === 0 ? "image" : index % 3 === 1 ? "video" : "audio";
      const basename = `素材-${String(index).padStart(5, "0")}.${kind === "image" ? "png" : kind === "video" ? "mp4" : "wav"}`;
      const recipeKey = kind === "image"
        ? createHash("sha256").update(`${recipe}\0${sha256}`, "utf8").digest("hex")
        : null;
      insert.run(
        sha256,
        kind,
        4_000_000 + index,
        kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/wav",
        basename,
        `.aicanvas/objects/sha256/${sha256.slice(0, 2)}/${sha256}`,
        kind === "image" ? "ready" : "pending",
        recipeKey,
        recipeKey ? `.aicanvas/derived/thumb/${recipeKey}.webp` : null,
        recipeKey ? 288 : null,
        recipeKey ? 512 : null,
        now,
      );
    }
    db.exec("COMMIT");
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM studio_media WHERE kind = 'video' AND sha256 > ? ORDER BY sha256 LIMIT 101
    `).all("0".repeat(64)) as Array<{ detail: string }>;
    db.close();
    expect(plan.map((row) => row.detail).join(" ")).toContain("studio_media_kind_sha_idx");

    const started = performance.now();
    const first = await listStudioMedia(root, { kind: "video", limit: 100 });
    const second = await listStudioMedia(root, { kind: "video", cursor: first.nextCursor, limit: 100 });
    const searched = await listStudioMedia(root, { search: "素材-09998", limit: 10 });
    const elapsed = performance.now() - started;
    expect(first.items).toHaveLength(100);
    expect(second.items).toHaveLength(100);
    expect(new Set([...first.items, ...second.items].map((item) => item.sha256)).size).toBe(200);
    expect(first.items.every((item) => item.kind === "video" && item.thumbnail === undefined)).toBe(true);
    expect(searched.items).toHaveLength(1);
    expect(searched.items[0]).toMatchObject({ kind: "audio", sourceBasename: "素材-09998.wav" });
    expect(elapsed).toBeLessThan(2_000);
    expect((await getMaterialStudioState(root)).counts.media).toBe(10_000);
  });
});
