import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  StudioProductionConflictError,
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  createStudioProductionUnit,
  createStudioProductionContractProfile,
  createStudioPromptDocument,
  createStudioScriptDocument,
  getStudioCanonicalPredecessorUnitIds,
  getStudioCanonicalSuccessorUnitIds,
  getStudioProductionState,
  getStudioProductionContractProfile,
  getStudioProductionPanelTimeContext,
  getStudioProductionUnitSnapshot,
  getStudioTextRevision,
  initializeStudioProduction,
  listStudioProductionUnitRevisions,
  listStudioProductionUnits,
  listStudioTextDocuments,
  listStudioTextRevisions,
  queryStudioAssetTimeline,
  readStudioProductionUnitSnapshotForCodex,
  reviseStudioProductionUnit,
  STUDIO_PRODUCTION_LEGACY_SEASON_ID,
  type StudioProductionPanelInput,
} from "../src/core/studio-production.js";
import { STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS } from "../src/core/studio-sqlite-busy.js";

const roots: string[] = [];

const SCRIPT_BODY = "阿航带着完整黄金面具走入石室。";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await chmod(path.join(root, "unreadable"), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-studio-production-"));
  roots.push(root);
  return root;
}

async function textFixture(root: string) {
  const script = await createStudioScriptDocument(root, {
    id: "script-main",
    title: "EP01 剧本",
    expectedRevision: 0,
  });
  const scriptRevision = await appendStudioScriptRevision(root, {
    documentId: script.id,
    expectedRevision: 0,
    body: SCRIPT_BODY,
    source: "scripts/EP01.md",
    sourceVersion: "git:script-v1",
  });
  const prompt = await createStudioPromptDocument(root, {
    id: "prompt-main",
    title: "EP01 电影写实提示词",
    expectedRevision: 0,
  });
  const promptRevision = await appendStudioPromptRevision(root, {
    documentId: prompt.id,
    expectedRevision: 0,
    body: "电影写实，阿航与完整黄金面具连续一致。",
    source: "prompts/EP01.txt",
    sourceVersion: "prompt-v1",
  });
  return {
    script,
    scriptRevision: scriptRevision.revision,
    prompt,
    promptRevision: promptRevision.revision,
  };
}

async function seedLegacyV1ProductionDatabase(root: string, units: Array<{ id: string; episode: string; sequence: number }>): Promise<void> {
  await initializeStudioProduction(root);
  const databasePath = path.join(root, ".aicanvas", "studio-production.sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TABLE studio_production_unit_revisions;
      DROP TABLE studio_production_units;
      CREATE TABLE studio_production_units (
        id TEXT PRIMARY KEY,
        episode TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence >= 1),
        title TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        duration_ms INTEGER NOT NULL CHECK(duration_ms = 15000),
        panel_count INTEGER NOT NULL CHECK(panel_count BETWEEN 2 AND 6),
        script_revision_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE studio_production_unit_revisions (
        unit_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        episode TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence >= 1),
        title TEXT NOT NULL,
        duration_ms INTEGER NOT NULL CHECK(duration_ms = 15000),
        panel_count INTEGER NOT NULL CHECK(panel_count BETWEEN 2 AND 6),
        script_revision_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(unit_id, revision)
      ) STRICT;
      UPDATE studio_production_meta SET value = '1' WHERE key = 'schema_version';
    `);
    const now = "2026-07-18T00:00:00.000Z";
    const insertUnit = db.prepare(`
      INSERT INTO studio_production_units(
        id, episode, sequence, title, revision, duration_ms, panel_count,
        script_revision_id, created_at, updated_at
      ) VALUES(?, ?, ?, ?, 1, 15000, 2, 'legacy-script-revision', ?, ?)
    `);
    const insertRevision = db.prepare(`
      INSERT INTO studio_production_unit_revisions(
        unit_id, revision, episode, sequence, title, duration_ms, panel_count,
        script_revision_id, created_at
      ) VALUES(?, 1, ?, ?, ?, 15000, 2, 'legacy-script-revision', ?)
    `);
    for (const unit of units) {
      const title = `历史单元 ${unit.id}`;
      insertUnit.run(unit.id, unit.episode, unit.sequence, title, now, now);
      insertRevision.run(unit.id, unit.episode, unit.sequence, title, now);
    }
  } finally {
    db.close();
  }
}

function panels(promptRevisionId: string, count = 2, assetId = "character-ahang"): StudioProductionPanelInput[] {
  const durationMilliseconds = count === 2
    ? [7_000, 8_000]
    : [2_000, 2_000, 3_000, 3_000, 2_000, 3_000];
  let cursor = 0;
  return durationMilliseconds.map((duration, offset) => {
    const start = cursor;
    cursor += duration;
    return {
      id: `panel-${String(offset + 1).padStart(2, "0")}`,
      title: `镜头 ${offset + 1}`,
      visualAction: offset === 0 ? "阿航走入石室。" : "阿航按住胸前布囊。",
      shotComposition: offset % 2 === 0 ? "中景，主体居中，保留纵深。" : "特写，面具位于右下三分点。",
      filmingMethod: offset % 2 === 0 ? "低机位稳定器跟拍。" : "50mm 缓慢推近。",
      dialogue: offset === 0 ? "阿航：别出声。" : "",
      subtitle: offset === 0 ? "别出声" : "",
      startSeconds: start / 1_000,
      endSeconds: cursor / 1_000,
      durationSeconds: duration / 1_000,
      promptRevisionId,
      sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: SCRIPT_BODY.length }],
      assets: [{
        assetId,
        category: "character",
        presence: "required",
        role: "主体，固定脸、发型与服饰。",
        continuityState: `承接前一格站位，当前为第 ${offset + 1} 格。`,
        evidence: [{
          kind: "prompt-revision",
          reference: promptRevisionId,
          note: "提示词修订已冻结角色一致性。",
        }],
      }, {
        assetId: "scene-stone-room",
        category: "scene",
        presence: "required",
        role: "同一石室空间。",
        continuityState: "火把光从画面左侧入射。",
        evidence: [{ kind: "script-source", reference: "scripts/EP01.md", note: "剧本场景。" }],
      }, {
        assetId: "prop-complete-mask",
        category: "prop",
        presence: offset === 0 ? "forbidden" : "optional",
        role: offset === 0 ? "布囊内不可露出。" : "仅可在布囊缝隙中显示完整轮廓。",
        continuityState: "始终是完整黄金面具，禁止半面具。",
        evidence: [{ kind: "hard-lock", reference: "P04-complete-mask", note: "权威资产锁。" }],
      }],
    } satisfies StudioProductionPanelInput;
  });
}

function panelsWithDurations(promptRevisionId: string, durationsMilliseconds: number[]): StudioProductionPanelInput[] {
  const template = panels(promptRevisionId, durationsMilliseconds.length === 2 ? 2 : 6)
    .slice(0, durationsMilliseconds.length);
  let cursor = 0;
  return template.map((panel, index) => {
    const start = cursor;
    cursor += durationsMilliseconds[index]!;
    return {
      ...panel,
      startSeconds: start / 1_000,
      endSeconds: cursor / 1_000,
      durationSeconds: durationsMilliseconds[index]! / 1_000,
    };
  });
}

describe("受管 AI 短剧生产知识库", () => {
  it("未来 schema 在任何 PRAGMA/DDL 前失败关闭，数据库字节保持不变", async () => {
    const root = await project();
    const sidecar = path.join(root, ".aicanvas");
    await mkdir(sidecar, { recursive: true });
    const databasePath = path.join(sidecar, "studio-production.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE studio_production_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO studio_production_meta VALUES ('schema_version', '999');");
    db.close();
    const before = await readFile(databasePath);

    await expect(initializeStudioProduction(root)).rejects.toThrow("不支持的生产知识库 schema_version：999");
    expect(await readFile(databasePath)).toEqual(before);
  });

  it("空库初始化独立 WAL SQLite 与文本 CAS，不扫描工程目录", async () => {
    const root = await project();
    const unrelated = path.join(root, "unreadable", "deep");
    await mkdir(unrelated, { recursive: true });
    await writeFile(path.join(unrelated, "legacy-media.png"), "not-an-image", "utf8");
    await chmod(path.join(root, "unreadable"), 0o000);

    const state = await initializeStudioProduction(root);
    expect(state).toMatchObject({
      schemaVersion: 6,
      databasePath: path.join(root, ".aicanvas", "studio-production.sqlite"),
      textCasRoot: path.join(root, ".aicanvas", "studio-production", "objects", "sha256"),
      pragmas: { journalMode: "wal", foreignKeys: true, busyTimeoutMs: STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS },
      counts: {
        textDocuments: 0,
        scriptDocuments: 0,
        promptDocuments: 0,
        textRevisions: 0,
        units: 0,
        unitRevisions: 0,
      },
    });
    expect((await lstat(state.databasePath)).isFile()).toBe(true);
    expect((await lstat(state.textCasRoot)).isDirectory()).toBe(true);
  });

  it("文本 CAS 根、hash prefix 或临时目录为 symlink 时写前失败关闭", async () => {
    for (const target of ["root", "prefix", "temporary"] as const) {
      const root = await project();
      const outside = path.join(root, `outside-${target}`);
      await mkdir(outside);
      const body = `文本 CAS confinement ${target}`;
      const bodySha = createHash("sha256").update(body).digest("hex");
      const objects = path.join(root, ".aicanvas", "studio-production", "objects");
      const casRoot = path.join(objects, "sha256");
      const temporaryRoot = path.join(objects, ".tmp");

      if (target === "root") {
        await mkdir(objects, { recursive: true });
        await symlink(outside, casRoot, "dir");
        await expect(createStudioScriptDocument(root, {
          id: "script-confinement",
          title: "不得写入",
          expectedRevision: 0,
        })).rejects.toThrow(/符号链接|真实路径/u);
      } else {
        const script = await createStudioScriptDocument(root, {
          id: `script-confinement-${target}`,
          title: "CAS confinement",
          expectedRevision: 0,
        });
        const replaced = target === "prefix" ? path.join(casRoot, bodySha.slice(0, 2)) : temporaryRoot;
        await rm(replaced, { recursive: true, force: true });
        await symlink(outside, replaced, "dir");
        await expect(appendStudioScriptRevision(root, {
          documentId: script.id,
          expectedRevision: 0,
          body,
          source: "scripts/confinement.md",
          sourceVersion: "confinement-v1",
        })).rejects.toThrow(/符号链接|真实路径/u);
        const db = new DatabaseSync(path.join(root, ".aicanvas", "studio-production.sqlite"), { readOnly: true });
        try {
          expect(db.prepare("SELECT COUNT(*) AS count FROM studio_text_revisions").get()).toEqual({ count: 0 });
        } finally {
          db.close();
        }
      }
      expect(await readdir(outside)).toEqual([]);
    }
  });

  it("v1 数据库原位升级 season 列，并把历史数据显式标记为 legacy 季而非全局", async () => {
    const root = await project();
    await seedLegacyV1ProductionDatabase(root, [{ id: "legacy-unit-1", episode: "EP01", sequence: 1 }]);

    const state = await initializeStudioProduction(root);
    expect(state.schemaVersion).toBe(6);
    const page = await listStudioProductionUnits(root, { limit: 10 });
    expect(page.items).toEqual([
      expect.objectContaining({
        id: "legacy-unit-1",
        season: STUDIO_PRODUCTION_LEGACY_SEASON_ID,
        seasonOrigin: "legacy-migrated",
        episode: "EP01",
        sequence: 1,
      }),
    ]);
    const revisions = await listStudioProductionUnitRevisions(root, { unitId: "legacy-unit-1", limit: 10 });
    expect(revisions.items).toEqual([
      expect.objectContaining({ season: STUDIO_PRODUCTION_LEGACY_SEASON_ID, seasonOrigin: "legacy-migrated" }),
    ]);

    const db = new DatabaseSync(state.databasePath);
    expect((db.prepare("SELECT value FROM studio_production_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("6");
    expect((db.prepare("PRAGMA table_info(studio_production_units)").all() as Array<{ name: string }>).map((column) => column.name)).toContain("season");
    expect((db.prepare("PRAGMA table_info(studio_production_unit_revisions)").all() as Array<{ name: string }>).map((column) => column.name)).toContain("season");
    db.close();
  });

  it("v1 同集重复 sequence 的迁移失败关闭，不静默重排历史单元", async () => {
    const root = await project();
    await seedLegacyV1ProductionDatabase(root, [
      { id: "legacy-duplicate-a", episode: "EP01", sequence: 1 },
      { id: "legacy-duplicate-b", episode: "EP01", sequence: 1 },
    ]);

    await expect(initializeStudioProduction(root)).rejects.toThrow("禁止静默重排");
    const db = new DatabaseSync(path.join(root, ".aicanvas", "studio-production.sqlite"));
    expect((db.prepare("SELECT value FROM studio_production_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("1");
    expect((db.prepare("PRAGMA table_info(studio_production_units)").all() as Array<{ name: string }>).map((column) => column.name)).not.toContain("season");
    db.close();
  });

  it("v5 弱同名 timing 表在 schema 提升前失败关闭，不被 CREATE IF NOT EXISTS 静默接受", async () => {
    const root = await project();
    await initializeStudioProduction(root);
    const databasePath = path.join(root, ".aicanvas", "studio-production.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      DROP TRIGGER studio_production_unit_timings_no_update;
      DROP TRIGGER studio_production_unit_timings_no_delete;
      DROP TABLE studio_production_unit_timings;
      CREATE TABLE studio_production_unit_timings (
        unit_id TEXT,
        unit_revision INTEGER,
        duration_ms INTEGER,
        created_at TEXT
      );
      UPDATE studio_production_meta SET value = '5' WHERE key = 'schema_version';
    `);
    db.close();

    await expect(initializeStudioProduction(root)).rejects.toThrow("timing extension 结构无效");
    const after = new DatabaseSync(databasePath);
    expect((after.prepare("SELECT value FROM studio_production_meta WHERE key = 'schema_version'").get() as { value: string }).value)
      .toBe("5");
    expect(String((after.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='studio_production_unit_timings'").get() as { sql: string }).sql))
      .not.toContain("STRICT");
    after.close();
  });

  it("剧本与提示词修订只追加，冻结正文 SHA、来源与版本，列表全部分页", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    const second = await appendStudioScriptRevision(root, {
      documentId: fixture.script.id,
      expectedRevision: 1,
      body: "阿航带着完整黄金面具走入石室，嘴嘴跟在他身后。",
      source: "scripts/EP01.md",
      sourceVersion: "git:script-v2",
    });
    expect(second.revision).toMatchObject({
      ordinal: 2,
      source: "scripts/EP01.md",
      sourceVersion: "git:script-v2",
      body: "阿航带着完整黄金面具走入石室，嘴嘴跟在他身后。",
    });
    expect(second.revision.bodySha256).toBe(createHash("sha256").update(second.revision.body).digest("hex"));
    expect(await readFile(second.revision.bodyPath, "utf8")).toBe(second.revision.body);
    expect((await getStudioTextRevision(root, fixture.scriptRevision.id))?.body).toBe(fixture.scriptRevision.body);

    const firstPage = await listStudioTextDocuments(root, { limit: 1 });
    const secondPage = await listStudioTextDocuments(root, { cursor: firstPage.nextCursor, limit: 1 });
    expect([...firstPage.items, ...secondPage.items].map((item) => item.id).sort()).toEqual(["prompt-main", "script-main"]);
    const revisionsPage1 = await listStudioTextRevisions(root, { documentId: fixture.script.id, limit: 1 });
    const revisionsPage2 = await listStudioTextRevisions(root, {
      documentId: fixture.script.id,
      cursor: revisionsPage1.nextCursor,
      limit: 1,
    });
    expect([...revisionsPage1.items, ...revisionsPage2.items].map((item) => item.ordinal)).toEqual([1, 2]);
    await expect(listStudioTextDocuments(root, { limit: 101 })).rejects.toThrow("1-100");

    const db = new DatabaseSync(path.join(root, ".aicanvas", "studio-production.sqlite"));
    const columns = db.prepare("PRAGMA table_info(studio_text_revisions)").all() as Array<{ name: string; type: string }>;
    const stored = db.prepare("SELECT typeof(body_sha256) AS sha_type, typeof(body_relpath) AS path_type FROM studio_text_revisions LIMIT 1").get() as {
      sha_type: string;
      path_type: string;
    };
    expect(columns.map((column) => column.name)).not.toContain("body");
    expect(columns.some((column) => column.type.toUpperCase() === "BLOB")).toBe(false);
    expect(stored).toEqual({ sha_type: "text", path_type: "text" });
    expect(() => db.prepare("UPDATE studio_text_revisions SET source_version = 'mutated'").run()).toThrow("append-only");
    db.close();
  });

  it("2 宫格与 6 宫格均产生严格 15 秒完整快照", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    const two = await createStudioProductionUnit(root, {
      id: "unit-0001",
      expectedRevision: 0,
      season: "S03",
      episode: "EP01",
      sequence: 1,
      title: "石室入口",
      scriptRevisionId: fixture.scriptRevision.id,
      panels: panels(fixture.promptRevision.id, 2),
    });
    const six = await createStudioProductionUnit(root, {
      id: "unit-0002",
      expectedRevision: 0,
      season: "S03",
      episode: "EP01",
      sequence: 2,
      title: "石室深处",
      scriptRevisionId: fixture.scriptRevision.id,
      panels: panels(fixture.promptRevision.id, 6),
    });

    expect(two).toMatchObject({
      kind: "studio-production-unit-snapshot",
      unit: { season: "S03", seasonOrigin: "explicit", revision: 1, durationSeconds: 15, panelCount: 2 },
      scriptRevision: { id: fixture.scriptRevision.id, body: fixture.scriptRevision.body },
    });
    expect(two.panels[0]).toMatchObject({
      title: "镜头 1",
      visualAction: "阿航走入石室。",
      shotComposition: "中景，主体居中，保留纵深。",
      filmingMethod: "低机位稳定器跟拍。",
      dialogue: "阿航：别出声。",
      subtitle: "别出声",
      startSeconds: 0,
      endSeconds: 7,
      durationSeconds: 7,
      promptRevision: { id: fixture.promptRevision.id, body: fixture.promptRevision.body },
    });
    expect(two.panels[0]!.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: "character-ahang", category: "character", presence: "required" }),
      expect.objectContaining({ assetId: "prop-complete-mask", category: "prop", presence: "forbidden" }),
    ]));
    expect(six.panels).toHaveLength(6);
    expect(six.panels.reduce((sum, panel) => sum + panel.durationSeconds, 0)).toBe(15);
    expect(two.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect((await readStudioProductionUnitSnapshotForCodex(root, two.unit.id))?.fingerprint).toBe(two.fingerprint);

    const page1 = await listStudioProductionUnits(root, { limit: 1 });
    const page2 = await listStudioProductionUnits(root, { cursor: page1.nextCursor, limit: 1 });
    expect([...page1.items, ...page2.items].map((item) => item.id)).toEqual(["unit-0001", "unit-0002"]);
  });

  it("纯增 timing 保存 U00 真实 12 秒并由 Core 累计 U01/U32 集内偏移", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    for (let offset = 0; offset <= 32; offset += 1) {
      const unitId = `S1E01-U${String(offset).padStart(2, "0")}`;
      await createStudioProductionUnit(root, {
        id: unitId,
        expectedRevision: 0,
        season: "S1",
        episode: "S1E1",
        sequence: offset + 1,
        title: unitId,
        durationSeconds: offset === 0 ? 12 : undefined,
        scriptRevisionId: fixture.scriptRevision.id,
        panels: offset === 0
          ? panelsWithDurations(fixture.promptRevision.id, [3_000, 3_000, 6_000])
          : panels(fixture.promptRevision.id, 2),
      });
    }

    const u00 = await getStudioProductionUnitSnapshot(root, "S1E01-U00");
    const u01 = await getStudioProductionUnitSnapshot(root, "S1E01-U01");
    const u32 = await getStudioProductionUnitSnapshot(root, "S1E01-U32");
    expect(u00?.unit).toMatchObject({ durationSeconds: 12, episodeStartSeconds: 0, episodeEndSeconds: 12, panelCount: 3 });
    expect(u01?.unit).toMatchObject({ durationSeconds: 15, episodeStartSeconds: 12, episodeEndSeconds: 27 });
    expect(u32?.unit).toMatchObject({ durationSeconds: 15, episodeStartSeconds: 477, episodeEndSeconds: 492 });
    expect(getStudioProductionPanelTimeContext(u01!.unit, u01!.panels[0]!)).toMatchObject({
      episodeAbsoluteStartSeconds: 12,
      episodeAbsoluteEndSeconds: 19,
    });

    const timeline = await queryStudioAssetTimeline(root, { assetId: "character-ahang", limit: 100 });
    expect(timeline.items.find((item) => item.unitId === "S1E01-U01" && item.panelIndex === 1))
      .toMatchObject({ episodeAbsoluteStartSeconds: 12, episodeAbsoluteEndSeconds: 19 });

    const databasePath = path.join(root, ".aicanvas", "studio-production.sqlite");
    const db = new DatabaseSync(databasePath);
    expect((db.prepare("SELECT duration_ms FROM studio_production_units WHERE id = 'S1E01-U00'").get() as { duration_ms: number }).duration_ms).toBe(15_000);
    expect((db.prepare("SELECT duration_ms FROM studio_production_unit_timings WHERE unit_id = 'S1E01-U00' AND unit_revision = 1").get() as { duration_ms: number }).duration_ms).toBe(12_000);
    expect((db.prepare("SELECT COUNT(*) AS count FROM studio_production_unit_timings").get() as { count: number }).count).toBe(33);
    db.close();

    await initializeStudioProduction(root);
    expect((await getStudioProductionState(root)).counts.unitTimings).toBe(33);
  });

  it("生产合同 profile 按 season+episode 追加冻结并可把 Dudu 参考收紧为 1-5", async () => {
    const root = await project();
    const sourceFingerprint = createHash("sha256").update("dudu-contract-v2", "utf8").digest("hex");
    const input = {
      profileId: "dudu-s1e1-v2",
      expectedRevision: 0 as const,
      season: "S1",
      episode: "S1E1",
      minControlReferences: 1,
      maxControlReferences: 5,
      sourceFingerprint,
    };
    const created = await createStudioProductionContractProfile(root, input);
    const replay = await createStudioProductionContractProfile(root, input);
    expect(replay).toEqual(created);
    expect(await getStudioProductionContractProfile(root, { season: "S1", episode: "S1E1" }))
      .toEqual(created);
    await expect(createStudioProductionContractProfile(root, { ...input, maxControlReferences: 6 }))
      .rejects.toThrow("已冻结且内容不同");
    expect((await getStudioProductionState(root)).counts.contractProfiles).toBe(1);

    const db = new DatabaseSync(path.join(root, ".aicanvas", "studio-production.sqlite"));
    expect(() => db.prepare("UPDATE studio_production_contract_profiles SET max_control_references = 6").run())
      .toThrow("append-only");
    db.close();
  });

  it("12 秒单元 revise 省略 durationSeconds 时继承上一 revision 而不重置为 15 秒", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    const base = {
      season: "S1",
      episode: "S1E1",
      sequence: 1,
      scriptRevisionId: fixture.scriptRevision.id,
      panels: panelsWithDurations(fixture.promptRevision.id, [3_000, 3_000, 6_000]),
    };
    const created = await createStudioProductionUnit(root, {
      ...base,
      id: "S1E01-U00",
      expectedRevision: 0,
      title: "序章",
      durationSeconds: 12,
    });
    const revised = await reviseStudioProductionUnit(root, {
      ...base,
      unitId: created.unit.id,
      expectedRevision: 1,
      title: "序章锁版",
    });
    expect(revised.unit).toMatchObject({ revision: 2, durationSeconds: 12, episodeStartSeconds: 0, episodeEndSeconds: 12 });
    expect(revised.panels.reduce((sum, panel) => sum + panel.durationSeconds, 0)).toBe(12);
    expect((await listStudioProductionUnitRevisions(root, { unitId: created.unit.id })).items)
      .toEqual([
        expect.objectContaining({ revision: 1, durationSeconds: 12 }),
        expect.objectContaining({ revision: 2, durationSeconds: 12 }),
      ]);
  });

  it("sequence 在同一 season+episode 内唯一，不同季或集可复用且列表按季筛选", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    const create = (id: string, season: string, episode: string) => createStudioProductionUnit(root, {
      id,
      expectedRevision: 0,
      season,
      episode,
      sequence: 1,
      title: id,
      scriptRevisionId: fixture.scriptRevision.id,
      panels: panels(fixture.promptRevision.id, 2),
    });
    await create("s3-ep1-u1", "S03", "EP01");
    await expect(create("s3-ep1-duplicate", "S03", "EP01")).rejects.toThrow("同季同集内唯一");
    await create("s4-ep1-u1", "S04", "EP01");
    await create("s3-ep2-u1", "S03", "EP02");

    expect((await listStudioProductionUnits(root, { season: "S03", episode: "EP01" })).items.map((unit) => unit.id)).toEqual(["s3-ep1-u1"]);
    expect((await listStudioProductionUnits(root, { season: "S04" })).items.map((unit) => unit.id)).toEqual(["s4-ep1-u1"]);
    const uniqueIndex = new DatabaseSync(path.join(root, ".aicanvas", "studio-production.sqlite"));
    expect(() => uniqueIndex.prepare(`
      INSERT INTO studio_production_units(
        id, season, episode, sequence, title, revision, duration_ms, panel_count,
        script_revision_id, created_at, updated_at
      ) VALUES('raw-duplicate', 'S03', 'EP01', 1, 'raw', 1, 15000, 2, ?, 'now', 'now')
    `).run(fixture.scriptRevision.id)).toThrow();
    uniqueIndex.close();
  });

  it("canonical successor 只沿同季同集的 current sequence 前进", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    const create = (
      id: string,
      season: string,
      episode: string,
      sequence: number,
    ) => createStudioProductionUnit(root, {
      id,
      expectedRevision: 0,
      season,
      episode,
      sequence,
      title: id,
      scriptRevisionId: fixture.scriptRevision.id,
      panels: panels(fixture.promptRevision.id, 2),
    });
    await create("s3-ep1-u1", "S03", "EP01", 1);
    await create("s3-ep1-u3", "S03", "EP01", 3);
    await create("s3-ep2-u2", "S03", "EP02", 2);
    await create("s4-ep1-u2", "S04", "EP01", 2);

    await expect(getStudioCanonicalSuccessorUnitIds(root, [
      "s3-ep1-u1",
      "s3-ep1-u3",
      "s3-ep2-u2",
      "missing-unit",
    ])).resolves.toEqual({
      "s3-ep1-u1": "s3-ep1-u3",
      "s3-ep1-u3": null,
      "s3-ep2-u2": null,
      "missing-unit": null,
    });
    await expect(getStudioCanonicalPredecessorUnitIds(root, [
      "s3-ep1-u1",
      "s3-ep1-u3",
      "s3-ep2-u2",
      "missing-unit",
    ])).resolves.toEqual({
      "s3-ep1-u1": null,
      "s3-ep1-u3": "s3-ep1-u1",
      "s3-ep2-u2": null,
      "missing-unit": null,
    });
  });

  it("1/7 宫格、非 15 秒、时间空洞与重叠全部在事务前拒绝", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    const base = {
      expectedRevision: 0 as const,
      season: "S03",
      episode: "EP01",
      sequence: 1,
      title: "非法单元",
      scriptRevisionId: fixture.scriptRevision.id,
    };
    await expect(createStudioProductionUnit(root, {
      ...base,
      id: "bad-one",
      panels: panels(fixture.promptRevision.id, 2).slice(0, 1),
    })).rejects.toThrow("2-6");
    await expect(createStudioProductionUnit(root, {
      ...base,
      id: "bad-seven",
      panels: [...panels(fixture.promptRevision.id, 6), panels(fixture.promptRevision.id, 2)[0]!],
    })).rejects.toThrow("2-6");

    const short = panels(fixture.promptRevision.id, 2);
    short[1] = { ...short[1]!, endSeconds: 14, durationSeconds: 7 };
    await expect(createStudioProductionUnit(root, { ...base, id: "bad-short", panels: short })).rejects.toThrow("严格等于声明时长 15 秒");

    const gap = panels(fixture.promptRevision.id, 2);
    gap[1] = { ...gap[1]!, startSeconds: 7.5, endSeconds: 15.5 };
    await expect(createStudioProductionUnit(root, { ...base, id: "bad-gap", panels: gap })).rejects.toThrow("空洞");

    const overlap = panels(fixture.promptRevision.id, 2);
    overlap[1] = { ...overlap[1]!, startSeconds: 6.5, endSeconds: 14.5 };
    await expect(createStudioProductionUnit(root, { ...base, id: "bad-overlap", panels: overlap })).rejects.toThrow("重叠");
    expect((await getStudioProductionState(root)).counts.units).toBe(0);
  });

  it("按资产查询跨单元连续性时间线，键集分页不重不漏", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      await createStudioProductionUnit(root, {
        id: `unit-${sequence}`,
        expectedRevision: 0,
        season: "S03",
        episode: "EP01",
        sequence,
        title: `时间线 ${sequence}`,
        scriptRevisionId: fixture.scriptRevision.id,
        panels: panels(fixture.promptRevision.id, 2),
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await queryStudioAssetTimeline(root, { assetId: "character-ahang", cursor, limit: 2 });
      seen.push(...page.items.map((item) => `${item.unitId}:${item.panelIndex}`));
      for (const item of page.items) {
        expect(item).toMatchObject({
          assetId: "character-ahang",
          category: "character",
          presence: "required",
          season: "S03",
          seasonOrigin: "explicit",
        });
        expect(item.episodeAbsoluteStartSeconds).toBe((item.unitSequence - 1) * 15 + item.startSeconds);
        expect(item.episodeAbsoluteEndSeconds).toBe((item.unitSequence - 1) * 15 + item.endSeconds);
        expect(item.evidence[0]).toMatchObject({ kind: "prompt-revision", reference: fixture.promptRevision.id });
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([
      "unit-1:1",
      "unit-1:2",
      "unit-2:1",
      "unit-2:2",
      "unit-3:1",
      "unit-3:2",
    ]);
    expect(new Set(seen).size).toBe(6);
    await expect(queryStudioAssetTimeline(root, { assetId: "character-ahang", limit: 101 })).rejects.toThrow("1-100");
    const first = await queryStudioAssetTimeline(root, { assetId: "character-ahang", limit: 1 });
    await expect(queryStudioAssetTimeline(root, {
      assetId: "scene-stone-room",
      cursor: first.nextCursor,
      limit: 1,
    })).rejects.toThrow("cursor");
  });

  it("文本头与单元头都执行 revision CAS，单元历史保持追加", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    await expect(appendStudioScriptRevision(root, {
      documentId: fixture.script.id,
      expectedRevision: 0,
      body: "过期剧本写入。",
      source: "stale",
      sourceVersion: "stale-v0",
    })).rejects.toBeInstanceOf(StudioProductionConflictError);

    const created = await createStudioProductionUnit(root, {
      id: "unit-cas",
      expectedRevision: 0,
      season: "S03",
      episode: "EP01",
      sequence: 1,
      title: "CAS 单元",
      scriptRevisionId: fixture.scriptRevision.id,
      panels: panels(fixture.promptRevision.id, 2),
    });
    const revised = await reviseStudioProductionUnit(root, {
      unitId: created.unit.id,
      expectedRevision: created.unit.revision,
      season: "S04",
      episode: "EP01",
      sequence: 1,
      title: "CAS 单元 r2",
      scriptRevisionId: fixture.scriptRevision.id,
      panels: panels(fixture.promptRevision.id, 6),
    });
    expect(revised.unit).toMatchObject({ season: "S04", seasonOrigin: "explicit", revision: 2, title: "CAS 单元 r2", panelCount: 6 });
    await expect(reviseStudioProductionUnit(root, {
      unitId: created.unit.id,
      expectedRevision: 1,
      season: "S03",
      episode: "EP01",
      sequence: 1,
      title: "过期单元",
      scriptRevisionId: fixture.scriptRevision.id,
      panels: panels(fixture.promptRevision.id, 2),
    })).rejects.toBeInstanceOf(StudioProductionConflictError);
    const history = await listStudioProductionUnitRevisions(root, { unitId: created.unit.id, limit: 100 });
    expect(history.items.map((item) => ({ revision: item.revision, season: item.season, title: item.title, panelCount: item.panelCount }))).toEqual([
      { revision: 1, season: "S03", title: "CAS 单元", panelCount: 2 },
      { revision: 2, season: "S04", title: "CAS 单元 r2", panelCount: 6 },
    ]);
  });

  it("关闭连接后可从 SQLite 与 CAS 恢复完整单元", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    const before = await createStudioProductionUnit(root, {
      id: "unit-restart",
      expectedRevision: 0,
      season: "S03",
      episode: "EP02",
      sequence: 9,
      title: "重启恢复",
      scriptRevisionId: fixture.scriptRevision.id,
      panels: panels(fixture.promptRevision.id, 2),
    });

    const reopened = new DatabaseSync(path.join(root, ".aicanvas", "studio-production.sqlite"));
    expect((reopened.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    reopened.close();
    const state = await initializeStudioProduction(root);
    const after = await getStudioProductionUnitSnapshot(root, "unit-restart");
    expect(state.counts).toMatchObject({ textDocuments: 2, textRevisions: 2, units: 1, unitRevisions: 1 });
    expect(after).not.toBeNull();
    expect(after!.fingerprint).toBe(before.fingerprint);
    expect(after!.scriptRevision.body).toBe(fixture.scriptRevision.body);
    expect(after!.panels[0]!.promptRevision.body).toBe(fixture.promptRevision.body);
  });

  it("10000 个单元仍使用索引 + limit 键集查询，不全表装载", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    const databasePath = path.join(root, ".aicanvas", "studio-production.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const insertUnit = db.prepare(`
      INSERT INTO studio_production_units(
        id, season, episode, sequence, title, revision, duration_ms, panel_count,
        script_revision_id, created_at, updated_at
      ) VALUES(?, 'S03', 'EP-LARGE', ?, ?, 1, 15000, 2, ?, ?, ?)
    `);
    const insertRevision = db.prepare(`
      INSERT INTO studio_production_unit_revisions(
        unit_id, revision, season, episode, sequence, title, duration_ms, panel_count,
        script_revision_id, created_at
      ) VALUES(?, 1, 'S03', 'EP-LARGE', ?, ?, 15000, 2, ?, ?)
    `);
    const now = new Date().toISOString();
    for (let index = 0; index < 10_000; index += 1) {
      const id = `bulk-unit-${String(index).padStart(5, "0")}`;
      const sequence = index + 1;
      const title = `大型单元 ${String(index).padStart(5, "0")}`;
      insertUnit.run(id, sequence, title, fixture.scriptRevision.id, now, now);
      insertRevision.run(id, sequence, title, fixture.scriptRevision.id, now);
    }
    db.exec("COMMIT");
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM studio_production_units ORDER BY sequence, id LIMIT 101
    `).all() as Array<{ detail: string }>;
    db.close();
    expect(plan.map((row) => row.detail).join(" ")).toContain("studio_production_units_sequence_id_idx");

    const started = performance.now();
    const first = await listStudioProductionUnits(root, { limit: 100 });
    const second = await listStudioProductionUnits(root, { cursor: first.nextCursor, limit: 100 });
    const elapsed = performance.now() - started;
    expect(first.items).toHaveLength(100);
    expect(second.items).toHaveLength(100);
    expect(first.items[0]!.id).toBe("bulk-unit-00000");
    expect(second.items[0]!.id).toBe("bulk-unit-00100");
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(200);
    expect(elapsed).toBeLessThan(2_000);
    expect((await getStudioProductionState(root)).counts).toMatchObject({ units: 10_000, unitRevisions: 10_000 });
  });
});
