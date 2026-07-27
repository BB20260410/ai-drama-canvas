import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  MaterialStudioConflictError,
  appendStudioAssetRelation,
  createStudioCanonicalAsset,
  evaluateStudioAssetApplicability,
  getMaterialStudioState,
  getStudioAssetRelationCurrentness,
  getStudioCanonicalAssetKnowledgeSnapshot,
  getStudioCanonicalAsset,
  initializeMaterialStudio,
  listStudioAssetRelations,
  updateStudioCanonicalAsset,
} from "../src/core/material-studio.js";
import { executeIdempotentCommand, type StudioCommandRequest } from "../src/core/command-bus.js";
import { createManagedProject } from "../src/core/managed-project.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(prefix = "ai-canvas-asset-knowledge-"): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function managedProject(): Promise<string> {
  const parent = await project("ai-canvas-asset-knowledge-managed-");
  return (await createManagedProject({ parentRoot: parent, name: "规范资产范围关系测试" })).paths.root;
}

function commandEnvelope(index: number, request: StudioCommandRequest) {
  return {
    requestId: `asset-knowledge-request-${String(index).padStart(4, "0")}`,
    idempotencyKey: `asset-knowledge-key-${String(index).padStart(4, "0")}`,
    request,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("规范资产适用范围", () => {
  it("以不可变定义版本追加范围历史，并可对项目/季/集/单元/秒段做失败关闭判断", async () => {
    const root = await project();
    const created = await createStudioCanonicalAsset(root, {
      id: "character-ahang",
      expectedRevision: 0,
      category: "character",
      name: "阿航",
      applicability: {
        projects: ["project-s3"],
        seasons: ["S03"],
        episodes: ["EP01"],
        units: ["EP01_15s_001"],
        timeRanges: [{ scope: "unit", scopeId: "EP01_15s_001", startSeconds: 0, endSeconds: 8, label: "前半段" }],
        tags: ["主角", "古蜀"],
      },
    });
    expect(created.applicability).toEqual({
      projects: ["project-s3"],
      seasons: ["S03"],
      episodes: ["EP01"],
      units: ["EP01_15s_001"],
      timeRanges: [{ scope: "unit", scopeId: "EP01_15s_001", startSeconds: 0, endSeconds: 8, label: "前半段" }],
      tags: ["主角", "古蜀"],
    });
    expect(evaluateStudioAssetApplicability(created.applicability, {
      projectId: "PROJECT-S3",
      seasonId: "s03",
      episodeId: "ep01",
      unitId: "EP01_15s_001",
      unitLocalStartSeconds: 1,
      unitLocalEndSeconds: 7,
    })).toMatchObject({ applicable: true, reasons: [], matchedTimeRange: { label: "前半段" } });
    expect(evaluateStudioAssetApplicability(created.applicability, {
      projectId: "project-s3",
      seasonId: "S03",
      episodeId: "EP02",
      unitId: "EP01_15s_001",
      unitLocalStartSeconds: 1,
      unitLocalEndSeconds: 7,
    })).toMatchObject({ applicable: false, reasons: ["episode-mismatch"] });
    expect(evaluateStudioAssetApplicability(created.applicability, {
      projectId: "project-s3",
      seasonId: "S03",
      episodeId: "EP01",
      unitId: "EP01_15s_001",
    })).toMatchObject({ applicable: false, reasons: ["unit-time-context-missing"] });
    const episodeScoped = {
      projects: [],
      seasons: ["S03"],
      episodes: ["EP01"],
      units: [],
      timeRanges: [{ scope: "episode" as const, scopeId: "EP01", startSeconds: 15, endSeconds: 22 }],
      tags: [],
    };
    expect(evaluateStudioAssetApplicability(episodeScoped, {
      seasonId: "S03",
      episodeId: "EP01",
      unitId: "EP01_15s_002",
      unitLocalStartSeconds: 0,
      unitLocalEndSeconds: 7,
    })).toMatchObject({ applicable: false, reasons: ["episode-time-context-missing"] });
    expect(evaluateStudioAssetApplicability(episodeScoped, {
      seasonId: "S03",
      episodeId: "EP01",
      unitId: "EP01_15s_002",
      unitLocalStartSeconds: 0,
      unitLocalEndSeconds: 7,
      episodeAbsoluteStartSeconds: 15,
      episodeAbsoluteEndSeconds: 22,
    })).toMatchObject({ applicable: true, reasons: [], matchedTimeRange: { scope: "episode" } });
    await expect(createStudioCanonicalAsset(root, {
      id: "invalid-unit-range",
      expectedRevision: 0,
      category: "scene",
      name: "无效单元范围",
      applicability: { timeRanges: [{ scope: "unit", scopeId: "u1", startSeconds: 0, endSeconds: 16 }] },
    })).rejects.toThrow("<= 15");

    const updated = await updateStudioCanonicalAsset(root, {
      assetId: created.id,
      expectedRevision: created.revision,
      applicability: {
        projects: ["project-s3"],
        seasons: ["S03"],
        episodes: ["EP01", "EP02"],
        tags: ["古蜀", "主角", "硬锁"],
      },
    });
    expect(updated).toMatchObject({ revision: 2, applicability: { episodes: ["EP01", "EP02"], timeRanges: [] } });
    expect(updated.definitionVersions).toHaveLength(2);
    expect(updated.definitionVersions[0]!.applicability.timeRanges).toEqual(created.applicability.timeRanges);
    expect(updated.definitionVersions[1]!.applicability.tags).toEqual(["主角", "古蜀", "硬锁"]);
    await expect(updateStudioCanonicalAsset(root, {
      assetId: created.id,
      expectedRevision: created.revision,
      applicability: { episodes: ["EP03"] },
    })).rejects.toBeInstanceOf(MaterialStudioConflictError);
    await expect(updateStudioCanonicalAsset(root, {
      assetId: created.id,
      expectedRevision: updated.revision,
      applicability: {
        timeRanges: [{ scope: "unit", scopeId: "EP01_15s_001", startSeconds: 9, endSeconds: 8 }],
      },
    })).rejects.toThrow("0 <= startSeconds < endSeconds");
    expect((await getStudioCanonicalAsset(root, created.id))?.revision).toBe(updated.revision);
  });

  it("旧 v1 数据库在同一 material-studio.sqlite 内原位补齐范围与关系能力", async () => {
    const root = await project();
    const sidecar = path.join(root, ".aicanvas");
    await mkdir(sidecar, { recursive: true });
    const databasePath = path.join(sidecar, "material-studio.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE studio_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO studio_meta(key, value) VALUES('schema_version', '1');
      CREATE TABLE studio_canonical_assets(
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL,
        primary_version_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE studio_asset_definitions(
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        asset_revision INTEGER NOT NULL,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        aliases_json TEXT NOT NULL,
        identity_features_json TEXT NOT NULL,
        positive_locks_json TEXT NOT NULL,
        negative_locks_json TEXT NOT NULL,
        default_prompt TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(asset_id, ordinal)
      ) STRICT;
      INSERT INTO studio_canonical_assets VALUES(
        'legacy-prop', 'prop', '旧道具', '', 1, NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO studio_asset_definitions VALUES(
        'definition-legacy-prop', 'legacy-prop', 1, 1, 'prop', '旧道具', '',
        '["旧道具"]', '[]', '[]', '[]', '', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO studio_canonical_assets VALUES(
        'legacy-scene', 'scene', '旧场景', '', 1, NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO studio_asset_definitions VALUES(
        'definition-legacy-scene', 'legacy-scene', 1, 1, 'scene', '旧场景', '',
        '["旧场景"]', '[]', '[]', '[]', '', '2026-01-01T00:00:00.000Z'
      );
      CREATE TABLE studio_asset_relations(
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject_asset_id TEXT NOT NULL,
        object_asset_id TEXT NOT NULL,
        subject_category TEXT NOT NULL,
        object_category TEXT NOT NULL,
        subject_asset_revision INTEGER NOT NULL,
        object_asset_revision INTEGER NOT NULL,
        subject_definition_version_id TEXT NOT NULL,
        object_definition_version_id TEXT NOT NULL,
        subject_authority_version_id TEXT,
        object_authority_version_id TEXT,
        subject_authority_media_sha256 TEXT,
        object_authority_media_sha256 TEXT,
        ordinal INTEGER,
        role TEXT NOT NULL,
        note TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(subject_asset_id, object_asset_id)
      ) STRICT;
    `);
    const legacySubject = {
      assetId: "legacy-prop",
      category: "prop",
      assetRevision: 1,
      definitionVersionId: "definition-legacy-prop",
    };
    const legacyObject = {
      assetId: "legacy-scene",
      category: "scene",
      assetRevision: 1,
      definitionVersionId: "definition-legacy-scene",
    };
    const legacyFingerprint = createHash("sha256").update(stableJson({
      kind: "reference_of",
      subjectAssetId: "legacy-prop",
      objectAssetId: "legacy-scene",
      ordinal: null,
      role: "",
      note: "",
      subject: legacySubject,
      object: legacyObject,
    }), "utf8").digest("hex");
    db.prepare(`
      INSERT INTO studio_asset_relations VALUES(
        'legacy-relation', 'reference_of', 'legacy-prop', 'legacy-scene', 'prop', 'scene',
        1, 1, 'definition-legacy-prop', 'definition-legacy-scene', NULL, NULL, NULL, NULL,
        NULL, '', '', ?, '2026-01-01T00:00:00.000Z'
      )
    `).run(legacyFingerprint);
    db.close();

    const state = await initializeMaterialStudio(root);
    expect(state).toMatchObject({ schemaVersion: 1, counts: { canonicalAssets: 2, assetRelations: 1 } });
    const upgraded = new DatabaseSync(databasePath);
    const assetColumns = upgraded.prepare("PRAGMA table_info(studio_canonical_assets)").all() as Array<{ name: string }>;
    const definitionColumns = upgraded.prepare("PRAGMA table_info(studio_asset_definitions)").all() as Array<{ name: string }>;
    const capability = upgraded.prepare("SELECT value FROM studio_meta WHERE key = 'asset_scope_relation_schema'").get() as { value: string };
    const relationTable = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'studio_asset_relations'").get();
    upgraded.close();
    expect(assetColumns.map((column) => column.name)).toContain("applicability_json");
    expect(definitionColumns.map((column) => column.name)).toContain("applicability_json");
    expect(capability.value).toBe("2");
    expect(relationTable).toBeTruthy();
    expect((await getStudioCanonicalAsset(root, "legacy-prop"))?.applicability).toEqual({
      projects: [], seasons: [], episodes: [], units: [], timeRanges: [], tags: [],
    });
    expect(await getStudioAssetRelationCurrentness(root, "legacy-relation")).toMatchObject({
      head: true,
      current: true,
      semanticCurrent: true,
      relation: {
        id: "legacy-relation",
        seriesId: "legacy-relation",
        revision: 1,
        head: true,
        status: "current",
        fingerprint: legacyFingerprint,
      },
    });
  });
});

describe("追加式规范资产关系", () => {
  it("跨类别组合成员可追溯、精确重放幂等，端点语义变化会让关系过期", async () => {
    const root = await project();
    const member = await createStudioCanonicalAsset(root, {
      id: "character-ahang",
      expectedRevision: 0,
      category: "character",
      name: "阿航",
    });
    const composite = await createStudioCanonicalAsset(root, {
      id: "scene-team-reference",
      expectedRevision: 0,
      category: "scene",
      name: "阿航与嘟嘟组合参考",
    });
    const relationInput = {
      id: "relation-ahang-team",
      kind: "composite_member" as const,
      subjectAssetId: member.id,
      objectAssetId: composite.id,
      expectedSubjectRevision: member.revision,
      expectedObjectRevision: composite.revision,
      ordinal: 1,
      role: "左侧主角",
      note: "组合参考第一个成员",
    };
    const relation = await appendStudioAssetRelation(root, relationInput);
    expect(relation).toMatchObject({
      id: relationInput.id,
      kind: "composite_member",
      ordinal: 1,
      subject: { assetId: member.id, category: "character", assetRevision: 2, definitionVersionId: member.currentDefinitionVersionId },
      object: { assetId: composite.id, category: "scene", assetRevision: 2, definitionVersionId: composite.currentDefinitionVersionId },
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await appendStudioAssetRelation(root, relationInput)).toEqual(relation);
    expect((await getMaterialStudioState(root)).counts.assetRelations).toBe(1);
    await expect(appendStudioAssetRelation(root, { ...relationInput, role: "不同语义" })).rejects.toThrow("语义不一致");

    const secondMember = await createStudioCanonicalAsset(root, {
      id: "prop-cloth-bag",
      expectedRevision: 0,
      category: "prop",
      name: "布囊",
    });
    await appendStudioAssetRelation(root, {
      id: "relation-bag-team",
      kind: "composite_member",
      subjectAssetId: secondMember.id,
      objectAssetId: composite.id,
      expectedSubjectRevision: secondMember.revision,
      expectedObjectRevision: 2,
      ordinal: 2,
      role: "手持道具",
    });
    const beforeDefinitionChange = await getStudioAssetRelationCurrentness(root, relation.id);
    expect(beforeDefinitionChange).toMatchObject({
      current: true,
      subject: { revisionCurrent: true, definitionCurrent: true, semanticCurrent: true },
      object: { revisionCurrent: false, definitionCurrent: true, semanticCurrent: true },
    });
    const freezeSnapshot = await getStudioCanonicalAssetKnowledgeSnapshot(root, member.id, {
      seasonId: "S03",
      episodeId: "EP01",
      unitId: "EP01_15s_001",
    });
    expect(freezeSnapshot).toMatchObject({
      assetId: member.id,
      definitionVersionId: member.currentDefinitionVersionId,
      applicabilityEvaluation: { applicable: true, reasons: [] },
      relations: [{ relation: { id: relation.id, fingerprint: relation.fingerprint }, current: true }],
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const memberAfterRelation = await getStudioCanonicalAsset(root, member.id);
    const changedMember = await updateStudioCanonicalAsset(root, {
      assetId: member.id,
      expectedRevision: memberAfterRelation!.revision,
      applicability: { seasons: ["S03"], tags: ["主角"] },
    });
    expect(changedMember.currentDefinitionVersionId).not.toBe(member.currentDefinitionVersionId);
    expect(await getStudioAssetRelationCurrentness(root, relation.id)).toMatchObject({
      current: false,
      subject: { revisionCurrent: false, definitionCurrent: false, semanticCurrent: false },
      object: { definitionCurrent: true },
    });
    const changedFreezeSnapshot = await getStudioCanonicalAssetKnowledgeSnapshot(root, member.id, {
      seasonId: "S03",
      episodeId: "EP01",
      unitId: "EP01_15s_001",
    });
    expect(changedFreezeSnapshot?.fingerprint).not.toBe(freezeSnapshot?.fingerprint);
    expect(changedFreezeSnapshot).toMatchObject({
      applicabilityEvaluation: { applicable: true },
      relations: [{ current: false }],
    });
    expect(await listStudioAssetRelations(root, { assetId: composite.id })).toMatchObject({
      items: [{ id: "relation-ahang-team" }, { id: "relation-bag-team" }],
    });
    expect((await getStudioCanonicalAsset(root, composite.id))?.relations.map((item) => item.id)).toEqual([
      "relation-ahang-team",
      "relation-bag-team",
    ]);
  });

  it("过期 head 只能用双 revision CAS 追加同语义修订，重放幂等且历史完整可查", async () => {
    const root = await project();
    const member = await createStudioCanonicalAsset(root, {
      id: "character-rebase-member", expectedRevision: 0, category: "character", name: "重建成员",
    });
    const composite = await createStudioCanonicalAsset(root, {
      id: "scene-rebase-composite", expectedRevision: 0, category: "scene", name: "重建组合",
    });
    const first = await appendStudioAssetRelation(root, {
      id: "relation-rebase-v1",
      kind: "composite_member",
      subjectAssetId: member.id,
      objectAssetId: composite.id,
      expectedSubjectRevision: member.revision,
      expectedObjectRevision: composite.revision,
      ordinal: 1,
      role: "左侧主角",
      note: "固定组合语义",
    });
    const memberAfterRelation = await getStudioCanonicalAsset(root, member.id);
    const changedMember = await updateStudioCanonicalAsset(root, {
      assetId: member.id,
      expectedRevision: memberAfterRelation!.revision,
      positiveLocks: ["新增脸部硬锁"],
    });
    expect(await getStudioAssetRelationCurrentness(root, first.id)).toMatchObject({
      head: true,
      semanticCurrent: false,
      current: false,
      relation: { status: "stale" },
    });

    await expect(appendStudioAssetRelation(root, {
      supersedesRelationId: first.id,
      kind: first.kind,
      subjectAssetId: first.subject.assetId,
      objectAssetId: first.object.assetId,
      expectedSubjectRevision: changedMember.revision - 1,
      expectedObjectRevision: 2,
      ordinal: first.ordinal,
      role: first.role,
      note: first.note,
    })).rejects.toBeInstanceOf(MaterialStudioConflictError);
    await expect(appendStudioAssetRelation(root, {
      supersedesRelationId: first.id,
      kind: first.kind,
      subjectAssetId: first.subject.assetId,
      objectAssetId: first.object.assetId,
      expectedSubjectRevision: changedMember.revision,
      expectedObjectRevision: 2,
      ordinal: first.ordinal,
      role: "改变语义",
      note: first.note,
    })).rejects.toThrow("重建语义不一致");

    const rebaseInput = {
      supersedesRelationId: first.id,
      kind: first.kind,
      subjectAssetId: first.subject.assetId,
      objectAssetId: first.object.assetId,
      expectedSubjectRevision: changedMember.revision,
      expectedObjectRevision: 2,
      ordinal: first.ordinal,
      role: first.role,
      note: first.note,
    } as const;
    const second = await appendStudioAssetRelation(root, rebaseInput);
    expect(second).toMatchObject({
      seriesId: first.id,
      revision: 2,
      supersedesRelationId: first.id,
      head: true,
      status: "current",
      subject: { assetRevision: changedMember.revision + 1 },
      object: { assetRevision: 3 },
    });
    expect(await appendStudioAssetRelation(root, rebaseInput)).toEqual(second);
    expect(await getStudioAssetRelationCurrentness(root, first.id)).toMatchObject({
      head: false,
      current: false,
      relation: { status: "superseded", supersededByRelationId: second.id },
    });
    expect((await listStudioAssetRelations(root, { assetId: member.id })).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, status: "superseded", supersededByRelationId: second.id }),
      expect.objectContaining({ id: second.id, status: "current", supersedesRelationId: first.id }),
    ]));
    expect((await getStudioCanonicalAsset(root, composite.id))?.relations).toMatchObject([
      { id: first.id, status: "superseded" },
      { id: second.id, status: "current" },
    ]);

    const db = new DatabaseSync(path.join(root, ".aicanvas", "material-studio.sqlite"));
    expect((db.prepare("SELECT COUNT(*) AS count FROM studio_asset_relations").get() as { count: number }).count).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS count FROM studio_asset_relation_heads").get() as { count: number }).count).toBe(1);
    expect(() => db.prepare("UPDATE studio_asset_relations SET note = '禁止覆盖历史' WHERE id = ?").run(first.id)).toThrow("append-only");
    expect(() => db.prepare("DELETE FROM studio_asset_relations WHERE id = ?").run(second.id)).toThrow("append-only");
    db.close();

    const compositeAfterRebase = await getStudioCanonicalAsset(root, composite.id);
    await updateStudioCanonicalAsset(root, {
      assetId: composite.id,
      expectedRevision: compositeAfterRebase!.revision,
      description: "端点再次漂移",
    });
    expect(await getStudioAssetRelationCurrentness(root, second.id)).toMatchObject({
      head: true,
      current: false,
      relation: { status: "stale" },
    });
  });

  it("缺失端点、自环、过期 CAS、重复端点、组合序号与循环均失败关闭", async () => {
    const root = await project();
    const a = await createStudioCanonicalAsset(root, { id: "asset-a", expectedRevision: 0, category: "character", name: "A" });
    const b = await createStudioCanonicalAsset(root, { id: "asset-b", expectedRevision: 0, category: "scene", name: "B" });
    const c = await createStudioCanonicalAsset(root, { id: "asset-c", expectedRevision: 0, category: "prop", name: "C" });
    await expect(appendStudioAssetRelation(root, {
      kind: "reference_of", subjectAssetId: "missing", objectAssetId: b.id,
      expectedSubjectRevision: 1, expectedObjectRevision: 1,
    })).rejects.toThrow("subject 资产不存在");
    await expect(appendStudioAssetRelation(root, {
      kind: "reference_of", subjectAssetId: a.id, objectAssetId: a.id,
      expectedSubjectRevision: 1, expectedObjectRevision: 1,
    })).rejects.toThrow("禁止自环");
    await expect(appendStudioAssetRelation(root, {
      kind: "composite_member", subjectAssetId: a.id, objectAssetId: b.id,
      expectedSubjectRevision: 1, expectedObjectRevision: 1, ordinal: 0,
    })).rejects.toThrow("1-10000");

    const first = await appendStudioAssetRelation(root, {
      id: "relation-a-b",
      kind: "derived_from",
      subjectAssetId: a.id,
      objectAssetId: b.id,
      expectedSubjectRevision: 1,
      expectedObjectRevision: 1,
    });
    await expect(appendStudioAssetRelation(root, {
      id: "relation-a-b-other-kind",
      kind: "reference_of",
      subjectAssetId: a.id,
      objectAssetId: b.id,
      expectedSubjectRevision: 2,
      expectedObjectRevision: 2,
    })).rejects.toThrow("语义不一致");
    await expect(appendStudioAssetRelation(root, {
      kind: "reference_of",
      subjectAssetId: c.id,
      objectAssetId: b.id,
      expectedSubjectRevision: 1,
      expectedObjectRevision: 1,
    })).rejects.toBeInstanceOf(MaterialStudioConflictError);
    await expect(appendStudioAssetRelation(root, {
      kind: "variant_of",
      subjectAssetId: b.id,
      objectAssetId: a.id,
      expectedSubjectRevision: 2,
      expectedObjectRevision: 2,
    })).rejects.toThrow("形成循环");
    expect((await listStudioAssetRelations(root)).items).toEqual([first]);

    const composite = await createStudioCanonicalAsset(root, { id: "asset-composite", expectedRevision: 0, category: "scene", name: "组合" });
    await appendStudioAssetRelation(root, {
      kind: "composite_member", subjectAssetId: c.id, objectAssetId: composite.id,
      expectedSubjectRevision: 1, expectedObjectRevision: 1, ordinal: 1,
    });
    const d = await createStudioCanonicalAsset(root, { id: "asset-d", expectedRevision: 0, category: "character", name: "D" });
    await expect(appendStudioAssetRelation(root, {
      kind: "composite_member", subjectAssetId: d.id, objectAssetId: composite.id,
      expectedSubjectRevision: 1, expectedObjectRevision: 2, ordinal: 1,
    })).rejects.toThrow("成员序号 1 已由");
  });

  it("SQLite 层禁止覆盖或删除追加历史，指纹漂移也拒绝读取", async () => {
    const root = await project();
    const a = await createStudioCanonicalAsset(root, { id: "asset-a", expectedRevision: 0, category: "character", name: "A" });
    const b = await createStudioCanonicalAsset(root, { id: "asset-b", expectedRevision: 0, category: "scene", name: "B" });
    const relation = await appendStudioAssetRelation(root, {
      id: "relation-immutable",
      kind: "reference_of",
      subjectAssetId: a.id,
      objectAssetId: b.id,
      expectedSubjectRevision: 1,
      expectedObjectRevision: 1,
    });
    const databasePath = path.join(root, ".aicanvas", "material-studio.sqlite");
    const db = new DatabaseSync(databasePath);
    expect(() => db.prepare("UPDATE studio_asset_relations SET note = '覆盖' WHERE id = ?").run(relation.id)).toThrow("append-only");
    expect(() => db.prepare("DELETE FROM studio_asset_relations WHERE id = ?").run(relation.id)).toThrow("append-only");
    db.exec("DROP TRIGGER studio_asset_relations_no_update");
    db.prepare("UPDATE studio_asset_relations SET fingerprint = ? WHERE id = ?").run("0".repeat(64), relation.id);
    db.close();
    await expect(listStudioAssetRelations(root)).rejects.toThrow("指纹漂移");
  });
});

describe("命令总线范围与关系接入", () => {
  it("受管工程经统一幂等账本追加关系，非受管目录在落账前失败关闭", async () => {
    const root = await managedProject();
    const subject = await executeIdempotentCommand(root, commandEnvelope(1, {
      command: "create_studio_asset",
      payload: {
        id: "character-dudu",
        expectedRevision: 0,
        category: "character",
        name: "嘟嘟",
        applicability: { seasons: ["S03"], episodes: ["EP01"], tags: ["犬类主角"] },
      },
    }));
    const object = await executeIdempotentCommand(root, commandEnvelope(2, {
      command: "create_studio_asset",
      payload: { id: "scene-reference-board", expectedRevision: 0, category: "scene", name: "角色组合参考板" },
    }));
    const relationCommand = commandEnvelope(3, {
      command: "append_studio_asset_relation",
      payload: {
        id: "relation-dudu-board",
        kind: "composite_member",
        subjectAssetId: (subject.result as { id: string }).id,
        objectAssetId: (object.result as { id: string }).id,
        expectedSubjectRevision: 1,
        expectedObjectRevision: 1,
        ordinal: 1,
        role: "右侧犬角色",
      },
    });
    const relation = await executeIdempotentCommand(root, relationCommand);
    const replay = await executeIdempotentCommand(root, { ...relationCommand, requestId: "asset-knowledge-request-replay-0003" });
    const domainReplay = await executeIdempotentCommand(root, commandEnvelope(4, relationCommand.request));
    expect(relation).toMatchObject({ status: "succeeded", replayed: false, result: { id: "relation-dudu-board" } });
    expect(replay).toMatchObject({ status: "succeeded", replayed: true, result: relation.result });
    expect(domainReplay).toMatchObject({ status: "succeeded", replayed: false, result: relation.result });

    const unmanaged = await project("ai-canvas-asset-knowledge-unmanaged-");
    await expect(executeIdempotentCommand(unmanaged, commandEnvelope(5, {
      command: "append_studio_asset_relation",
      payload: {
        kind: "reference_of",
        subjectAssetId: "asset-a",
        objectAssetId: "asset-b",
        expectedSubjectRevision: 1,
        expectedObjectRevision: 1,
      },
    }))).rejects.toThrow("受管项目");
    await expect(access(path.join(unmanaged, ".aicanvas"))).rejects.toThrow();
  });
});
