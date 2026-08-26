/**
 * 当前单元锁版光线/服化：只读打开已有生产库，按 unit head revision 读本格覆盖。
 * 不扫 snapshot / prompt CAS，不 ensure / 不建库，不改 dashboard 投影。
 * 锁版字段，不是 BindingSet，不能当 generation-ready。
 */
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATABASE_RELATIVE_PATH = ".aicanvas/studio-production.sqlite";
const REQUIRED_TABLES = [
  "studio_production_units",
  "studio_production_panels",
] as const;
const REQUIRED_PANEL_COLUMNS = ["panel_id", "panel_index", "scene_lighting", "costume_state"] as const;
/** 与驾驶舱宫格上限一致；不 import dashboard，避免检查器旁路拉驾驶舱图。 */
export const UNIT_LOCK_OVERLAY_PANEL_LIMIT = 6 as const;

export type StudioUnitLockOverlay = {
  panelId: string;
  panelIndex: number;
  sceneLighting: string;
  costumeState: string;
  /** 可选列；缺列则为空，不让整次锁版光线/服化失败关闭。 */
  shotType: "original" | "extension" | "";
};

export type StudioUnitLockOverlayQuery = {
  unitId: string;
  unitRevision: number;
};

export type StudioUnitLockOverlayReadResult = {
  overlays: StudioUnitLockOverlay[];
};

function emptyLockOverlayResult(): StudioUnitLockOverlayReadResult {
  return { overlays: [] };
}

function productionDatabasePath(projectRoot: string): string {
  if (!projectRoot.trim()) throw new Error("projectRoot 不能为空。");
  return path.join(path.resolve(projectRoot), DATABASE_RELATIVE_PATH);
}

/**
 * 只读打开已有生产库。缺库/缺表/缺列返回 null，不建库、不迁移、不改 WAL。
 */
function openStudioUnitLockOverlayDatabase(databasePath: string): DatabaseSync | null {
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
    const columns = new Set(
      (db.prepare("PRAGMA table_info(studio_production_panels)").all() as Array<{ name?: string }>)
        .map((row) => String(row.name ?? "")),
    );
    if (REQUIRED_PANEL_COLUMNS.some((column) => !columns.has(column))) {
      db.close();
      return null;
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function normalizeUnitLockOverlayQuery(query: StudioUnitLockOverlayQuery): StudioUnitLockOverlayQuery | null {
  const unitId = query.unitId?.trim() ?? "";
  const unitRevision = Number(query.unitRevision);
  if (!unitId || !Number.isInteger(unitRevision) || unitRevision < 1) return null;
  return { unitId, unitRevision };
}

/**
 * 当前单元 head 宫格的锁版光线/服化。缺库/缺表/缺列/修订对不上返回空，不建库。
 * 不是 BindingSet。
 */
export function readStudioUnitLockOverlays(
  projectRoot: string,
  query: StudioUnitLockOverlayQuery,
): StudioUnitLockOverlayReadResult {
  const normalized = normalizeUnitLockOverlayQuery(query);
  if (!normalized) return emptyLockOverlayResult();
  const db = openStudioUnitLockOverlayDatabase(productionDatabasePath(projectRoot));
  if (!db) return emptyLockOverlayResult();
  try {
    const hasShotType = new Set(
      (db.prepare("PRAGMA table_info(studio_production_panels)").all() as Array<{ name?: string }>)
        .map((row) => String(row.name ?? "")),
    ).has("shot_type");
    const rows = db.prepare(`
      SELECT p.panel_id, p.panel_index, p.scene_lighting, p.costume_state${hasShotType ? ", p.shot_type" : ""}
      FROM studio_production_panels p
      JOIN studio_production_units u
        ON u.id = p.unit_id AND u.revision = p.unit_revision
      WHERE p.unit_id = ?
        AND u.revision = ?
      ORDER BY p.panel_index ASC
      LIMIT ?
    `).all(
      normalized.unitId,
      normalized.unitRevision,
      UNIT_LOCK_OVERLAY_PANEL_LIMIT,
    ) as Array<{
      panel_id: string;
      panel_index: number;
      scene_lighting: string;
      costume_state: string;
      shot_type?: string;
    }>;
    const seen = new Set<string>();
    const overlays: StudioUnitLockOverlay[] = [];
    for (const row of rows) {
      const panelId = String(row.panel_id ?? "").trim();
      const panelIndex = Number(row.panel_index);
      if (!panelId || !Number.isFinite(panelIndex) || seen.has(panelId)) continue;
      seen.add(panelId);
      const rawShotType = String(row.shot_type ?? "").trim();
      overlays.push({
        panelId,
        panelIndex,
        sceneLighting: String(row.scene_lighting ?? "").trim(),
        costumeState: String(row.costume_state ?? "").trim(),
        shotType: rawShotType === "extension" ? "extension" : rawShotType === "original" ? "original" : "",
      });
    }
    return { overlays };
  } finally {
    db.close();
  }
}
