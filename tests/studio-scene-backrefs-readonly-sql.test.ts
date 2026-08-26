/**
 * 跨单元场景回指：Linux 手工 sqlite 只读旁路。
 * 不调用 createManagedProject / P7 fixture（需 Darwin dirfd）。
 * 不是 BindingSet，不是安装版 T23，不是 GUI 探针。
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readStudioSceneBackReferences } from "../src/core/studio-scene-backrefs-read.js";
import { formatSceneBackReferences } from "../src/core/studio-scene-backrefs.js";
import { SCENE_BACK_REFERENCE_TOOL_NOTE } from "../src/core/studio-panel-standing.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const SEASON = "S1";
const EPISODE = "S1E1";

let tempRoot: string | undefined;

afterEach(async () => {
  if (!tempRoot) return;
  await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

async function seedSceneBackrefDatabase(): Promise<string> {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "scene-backrefs-"));
  const sidecar = path.join(tempRoot, ".aicanvas");
  await mkdir(sidecar, { recursive: true });
  const databasePath = path.join(sidecar, "studio-production.sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE studio_production_units (
        id TEXT PRIMARY KEY,
        season TEXT NOT NULL,
        episode TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        title TEXT NOT NULL,
        revision INTEGER NOT NULL,
        panel_count INTEGER NOT NULL
      );
      CREATE TABLE studio_production_panels (
        unit_id TEXT NOT NULL,
        unit_revision INTEGER NOT NULL,
        panel_index INTEGER NOT NULL,
        panel_id TEXT NOT NULL
      );
      CREATE TABLE studio_production_panel_assets (
        unit_id TEXT NOT NULL,
        unit_revision INTEGER NOT NULL,
        unit_sequence INTEGER NOT NULL,
        panel_index INTEGER NOT NULL,
        asset_id TEXT NOT NULL,
        category TEXT NOT NULL,
        presence TEXT NOT NULL,
        role TEXT NOT NULL,
        continuity_state TEXT NOT NULL
      );
      CREATE INDEX studio_production_asset_timeline_idx
        ON studio_production_panel_assets(asset_id, unit_sequence, unit_id, panel_index, unit_revision);
    `);
    const insertUnit = db.prepare(`
      INSERT INTO studio_production_units(id, season, episode, sequence, title, revision, panel_count)
      VALUES(?, ?, ?, ?, ?, 1, ?)
    `);
    const insertPanel = db.prepare(`
      INSERT INTO studio_production_panels(unit_id, unit_revision, panel_index, panel_id)
      VALUES(?, 1, ?, ?)
    `);
    const insertAsset = db.prepare(`
      INSERT INTO studio_production_panel_assets(
        unit_id, unit_revision, unit_sequence, panel_index, asset_id, category, presence, role, continuity_state
      ) VALUES(?, 1, ?, ?, ?, ?, 'required', ?, 'locked')
    `);
    insertUnit.run("u1", SEASON, EPISODE, 1, "unit-1", 2);
    insertUnit.run("u2", SEASON, EPISODE, 2, "unit-2", 2);
    insertUnit.run("u3", SEASON, EPISODE, 3, "unit-3", 1);
    insertUnit.run("u-other", "S1", "S1E2", 1, "other-ep", 1);
    insertPanel.run("u1", 1, "u1p1");
    insertPanel.run("u1", 2, "u1p2");
    insertPanel.run("u2", 1, "u2p1");
    insertPanel.run("u2", 2, "u2p2");
    insertPanel.run("u3", 1, "u3p1");
    insertPanel.run("u-other", 1, "uEp2p1");
    insertAsset.run("u1", 1, 1, "scene-stone", "scene", "石室");
    insertAsset.run("u1", 1, 1, "char-dou", "character", "豆姐");
    insertAsset.run("u1", 1, 2, "scene-stone", "scene", "石室夜");
    insertAsset.run("u2", 2, 1, "scene-stone", "scene", "石室");
    insertAsset.run("u2", 2, 2, "scene-stone", "scene", "石室续");
    insertAsset.run("u3", 3, 1, "scene-stone", "scene", "石室后");
    insertAsset.run("u-other", 1, 1, "scene-stone", "scene", "他集石室");
  } finally {
    db.close();
  }
  return tempRoot;
}

describe("studio scene backrefs readonly sql", () => {
  it("缺库失败关闭为空，不建生产库", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scene-backrefs-missing-"));
    const result = readStudioSceneBackReferences(tempRoot, {
      unitId: "u2",
      unitRevision: 1,
      sequence: 2,
      panelId: "u2p2",
      panelIndex: 2,
      season: SEASON,
      episode: EPISODE,
    });
    expect(result.sceneMentions).toEqual([]);
    expect(result.sceneBackReferences).toEqual([]);
    expect(result.sceneBackReferenceNote).toBe(formatSceneBackReferences(0, []));
    expect(existsSync(path.join(tempRoot, ".aicanvas", "studio-production.sqlite"))).toBe(false);
  });

  it("空库缺表失败关闭为空，不建表", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scene-backrefs-empty-"));
    const sidecar = path.join(tempRoot, ".aicanvas");
    await mkdir(sidecar, { recursive: true });
    const db = new DatabaseSync(path.join(sidecar, "studio-production.sqlite"));
    db.close();
    const result = readStudioSceneBackReferences(tempRoot, {
      unitId: "u2",
      unitRevision: 1,
      sequence: 2,
      panelId: "u2p2",
      panelIndex: 2,
      season: SEASON,
      episode: EPISODE,
    });
    expect(result.sceneMentions).toEqual([]);
    expect(result.sceneBackReferences).toEqual([]);
  });

  it("只收更早同场景快照提及；忽略角色、更晚单元与他集", async () => {
    const root = await seedSceneBackrefDatabase();
    const current = readStudioSceneBackReferences(root, {
      unitId: "u2",
      unitRevision: 1,
      sequence: 2,
      panelId: "u2p2",
      panelIndex: 2,
      season: SEASON,
      episode: EPISODE,
    });
    expect(current.sceneMentions).toEqual([{ assetId: "scene-stone", role: "石室续" }]);
    expect(current.sceneBackReferences).toEqual([
      {
        assetId: "scene-stone",
        role: "石室",
        unitId: "u2",
        sequence: 2,
        panelIndex: 1,
        panelId: "u2p1",
      },
      {
        assetId: "scene-stone",
        role: "石室夜",
        unitId: "u1",
        sequence: 1,
        panelIndex: 2,
        panelId: "u1p2",
      },
      {
        assetId: "scene-stone",
        role: "石室",
        unitId: "u1",
        sequence: 1,
        panelIndex: 1,
        panelId: "u1p1",
      },
    ]);
    expect(current.sceneBackReferenceNote).toContain("U2 G1 石室");
    expect(current.sceneBackReferenceNote).toContain("不是 BindingSet");
    expect(current.sceneBackReferences.map((row) => row.unitId)).not.toContain("u3");
    expect(current.sceneBackReferences.map((row) => row.unitId)).not.toContain("u-other");

    const firstPanel = readStudioSceneBackReferences(root, {
      unitId: "u1",
      unitRevision: 1,
      sequence: 1,
      panelId: "u1p1",
      panelIndex: 1,
      season: SEASON,
      episode: EPISODE,
    });
    expect(firstPanel.sceneMentions).toEqual([{ assetId: "scene-stone", role: "石室" }]);
    expect(firstPanel.sceneBackReferences).toEqual([]);
    expect(firstPanel.sceneBackReferenceNote).toContain("没有同场景快照提及");
  });

  it("上限 4；本格角色提及不算场景", async () => {
    const root = await seedSceneBackrefDatabase();
    const db = new DatabaseSync(path.join(root, ".aicanvas", "studio-production.sqlite"));
    try {
      const insertUnit = db.prepare(`
        INSERT INTO studio_production_units(id, season, episode, sequence, title, revision, panel_count)
        VALUES(?, ?, ?, ?, ?, 1, 1)
      `);
      const insertPanel = db.prepare(`
        INSERT INTO studio_production_panels(unit_id, unit_revision, panel_index, panel_id)
        VALUES(?, 1, 1, ?)
      `);
      const insertAsset = db.prepare(`
        INSERT INTO studio_production_panel_assets(
          unit_id, unit_revision, unit_sequence, panel_index, asset_id, category, presence, role, continuity_state
        ) VALUES(?, 1, ?, 1, 'scene-stone', 'scene', 'required', '石室', 'locked')
      `);
      for (const sequence of [4, 5, 6]) {
        const unitId = `u${sequence}`;
        insertUnit.run(unitId, SEASON, EPISODE, sequence, `unit-${sequence}`);
        insertPanel.run(unitId, `${unitId}p1`);
        insertAsset.run(unitId, sequence);
      }
    } finally {
      db.close();
    }
    const limited = readStudioSceneBackReferences(root, {
      unitId: "u6",
      unitRevision: 1,
      sequence: 6,
      panelId: "u6p1",
      panelIndex: 1,
      season: SEASON,
      episode: EPISODE,
    });
    expect(limited.sceneBackReferences).toHaveLength(4);
    expect(limited.sceneBackReferences[0]?.unitId).toBe("u5");
    expect(limited.sceneBackReferences.map((row) => row.unitId)).not.toContain("u1");
  });

  it("session-snapshot / brief / MCP 接到只读回指，不读 head、不调 Binding", () => {
    const snapshot = source("src/core/studio-generation-session-snapshot.ts");
    expect(snapshot).toContain("readStudioSceneBackReferences");
    expect(snapshot).toContain("sceneBackReferences");
    expect(snapshot).toContain("sceneBackReferenceNote");
    expect(snapshot).toContain("不读 unit head");
    expect(snapshot).not.toContain("getStudioProductionUnitSnapshot");
    expect(snapshot).not.toContain("getCurrentStudioPanelAssetBindingSet");
    expect(snapshot).not.toContain("evaluateStudioConsistency");
    expect(snapshot).not.toContain("getStudioBindingControl");
    const reader = source("src/core/studio-scene-backrefs-read.ts");
    expect(reader).toContain("PRAGMA query_only = ON");
    expect(reader).toContain("readOnly: true");
    expect(reader).toContain("category = 'scene'");
    expect(reader).not.toContain("ensureProductionDirectories");
    expect(reader).not.toContain("evaluateStudioConsistency");
    const mcp = source("src/mcp/server.ts");
    expect(mcp).toContain("sceneBackReferences");
    expect(mcp).toContain("sceneBackReferenceNote");
    expect(mcp).toContain("不是 BindingSet");
    const generation = source("src/core/studio-generation.ts");
    expect(generation).toContain("SCENE_BACK_REFERENCE_TOOL_NOTE");
    const brief = source("src/core/codex.ts");
    expect(brief).toContain("SCENE_BACK_REFERENCE_TOOL_NOTE");
    expect(SCENE_BACK_REFERENCE_TOOL_NOTE).toContain("session-snapshot");
    expect(SCENE_BACK_REFERENCE_TOOL_NOTE).toContain("不是 BindingSet");
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("getStudioSceneBackReferences");
    expect(canvas).toContain("applyInspectorSceneBackrefs");
    expect(canvas).not.toContain("studio-scene-backrefs-read");
    expect(canvas).not.toContain("evaluateStudioConsistency(");
    const main = source("src/main/index.ts");
    const handlerStart = main.indexOf("canvas:get-studio-scene-backrefs");
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = main.slice(handlerStart, handlerStart + 700);
    expect(handler).toContain("requireManagedStudioProjectReadOnly(projectRoot)");
    expect(handler).toContain("readStudioSceneBackReferences");
    expect(handler).not.toContain("getStudioProductionUnitSnapshot");
    const preload = source("src/preload/index.ts");
    expect(preload).toContain('invoke("canvas:get-studio-scene-backrefs", projectRoot, query)');
    const trace = source("src/core/studio-trace.ts");
    expect(trace).not.toContain("readStudioSceneBackReferences");
    expect(trace).not.toContain("studio-scene-backrefs-read");
  });
});
