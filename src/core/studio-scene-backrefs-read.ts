/**
 * 跨单元场景回指：只读打开已有生产库，按 scene asset_id 查更早宫格。
 * 走 studio_production_asset_timeline_idx，不扫整集 snapshot，不 ensure / 不建库。
 * 快照提及，不是 BindingSet，不能当 generation-ready。
 */
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  SCENE_BACK_REFERENCE_LIMIT,
  formatSceneBackReferences,
  type SceneBackReference,
} from "./studio-scene-backrefs.js";

const DATABASE_RELATIVE_PATH = ".aicanvas/studio-production.sqlite";
const REQUIRED_TABLES = [
  "studio_production_units",
  "studio_production_panels",
  "studio_production_panel_assets",
] as const;
const CURRENT_SCENE_MENTION_CAP = 8;

export type StudioSceneBackrefReadQuery = {
  unitId: string;
  unitRevision: number;
  sequence: number;
  panelId: string;
  panelIndex: number;
  season: string;
  episode: string;
  limit?: number;
};

export type StudioSceneBackrefReadResult = {
  sceneMentions: Array<{ assetId: string; role: string }>;
  sceneBackReferences: SceneBackReference[];
  sceneBackReferenceNote: string;
};

function emptySceneBackrefResult(): StudioSceneBackrefReadResult {
  return {
    sceneMentions: [],
    sceneBackReferences: [],
    sceneBackReferenceNote: formatSceneBackReferences(0, []),
  };
}

function productionDatabasePath(projectRoot: string): string {
  if (!projectRoot.trim()) throw new Error("projectRoot 不能为空。");
  return path.join(path.resolve(projectRoot), DATABASE_RELATIVE_PATH);
}

/**
 * 只读打开已有生产库。缺库/缺表返回 null，不建库、不迁移、不改 WAL。
 */
function openStudioSceneBackrefsDatabase(databasePath: string): DatabaseSync | null {
  if (!existsSync(databasePath)) return null;
  const metadata = lstatSync(databasePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("生产知识库数据库必须是无符号链接的普通文件。");
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    const found = db.prepare(`
      SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map(() => "?").join(", ")})
    `).get(...REQUIRED_TABLES) as { n?: number } | undefined;
    if (Number(found?.n) < REQUIRED_TABLES.length) {
      db.close();
      return null;
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function readCurrentSceneMentions(
  db: DatabaseSync,
  query: StudioSceneBackrefReadQuery,
): Array<{ assetId: string; role: string }> {
  const rows = db.prepare(`
    SELECT asset_id, role
    FROM studio_production_panel_assets
    WHERE unit_id = ?
      AND unit_revision = ?
      AND panel_index = ?
      AND category = 'scene'
    ORDER BY asset_id
    LIMIT ?
  `).all(
    query.unitId,
    query.unitRevision,
    query.panelIndex,
    CURRENT_SCENE_MENTION_CAP,
  ) as Array<{ asset_id: string; role: string }>;
  const seen = new Set<string>();
  const mentions: Array<{ assetId: string; role: string }> = [];
  for (const row of rows) {
    const assetId = String(row.asset_id ?? "").trim();
    if (!assetId || seen.has(assetId)) continue;
    seen.add(assetId);
    mentions.push({ assetId, role: String(row.role ?? "").trim() });
  }
  return mentions;
}

function readEarlierSceneMentions(
  db: DatabaseSync,
  query: StudioSceneBackrefReadQuery,
  sceneIds: readonly string[],
): SceneBackReference[] {
  if (sceneIds.length === 0) return [];
  const limit = Math.max(1, Math.min(query.limit ?? SCENE_BACK_REFERENCE_LIMIT, SCENE_BACK_REFERENCE_LIMIT));
  const placeholders = sceneIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT pa.asset_id, pa.role, pa.unit_id, pa.unit_sequence, pa.panel_index, p.panel_id
    FROM studio_production_panel_assets pa
    JOIN studio_production_units u
      ON u.id = pa.unit_id AND u.revision = pa.unit_revision
    JOIN studio_production_panels p
      ON p.unit_id = pa.unit_id
     AND p.unit_revision = pa.unit_revision
     AND p.panel_index = pa.panel_index
    WHERE pa.category = 'scene'
      AND pa.asset_id IN (${placeholders})
      AND u.season = ?
      AND u.episode = ?
      AND (
        pa.unit_sequence < ?
        OR (pa.unit_sequence = ? AND pa.panel_index < ?)
      )
      AND NOT (pa.unit_id = ? AND p.panel_id = ?)
    ORDER BY pa.unit_sequence DESC, pa.panel_index DESC
    LIMIT ?
  `).all(
    ...sceneIds,
    query.season,
    query.episode,
    query.sequence,
    query.sequence,
    query.panelIndex,
    query.unitId,
    query.panelId,
    limit,
  ) as Array<{
    asset_id: string;
    role: string;
    unit_id: string;
    unit_sequence: number;
    panel_index: number;
    panel_id: string;
  }>;
  const seen = new Set<string>();
  const refs: SceneBackReference[] = [];
  for (const row of rows) {
    const assetId = String(row.asset_id ?? "").trim();
    const unitId = String(row.unit_id ?? "").trim();
    const panelId = String(row.panel_id ?? "").trim();
    if (!assetId || !unitId || !panelId) continue;
    const key = `${unitId}:${panelId}:${assetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      assetId,
      role: String(row.role ?? "").trim(),
      unitId,
      sequence: Number(row.unit_sequence),
      panelIndex: Number(row.panel_index),
      panelId,
    });
  }
  return refs;
}

/**
 * 当前宫格快照场景提及 + 同季同集更早同场景宫格。
 * 缺库/缺表返回空结果，不建库。不是 BindingSet。
 */
export function readStudioSceneBackReferences(
  projectRoot: string,
  query: StudioSceneBackrefReadQuery,
): StudioSceneBackrefReadResult {
  const db = openStudioSceneBackrefsDatabase(productionDatabasePath(projectRoot));
  if (!db) return emptySceneBackrefResult();
  try {
    const sceneMentions = readCurrentSceneMentions(db, query);
    const sceneBackReferences = readEarlierSceneMentions(
      db,
      query,
      sceneMentions.map((mention) => mention.assetId),
    );
    return {
      sceneMentions,
      sceneBackReferences,
      sceneBackReferenceNote: formatSceneBackReferences(sceneMentions.length, sceneBackReferences),
    };
  } finally {
    db.close();
  }
}
