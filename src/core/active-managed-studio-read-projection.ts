import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { ProjectShell } from "./managed-project.js";

export interface ActiveManagedStudioReadProjection {
  counts: {
    units: number;
    panels: number;
    canonicalAssets: number;
    characters: number;
    scenes: number;
    props: number;
    styles: number;
    media: number;
    bindingSets: number;
  };
  lockedAssetSample: Array<{
    assetId: string;
    name: string;
    category: "character" | "scene" | "prop" | "style";
    revision: number;
    currentness: "current";
  }>;
}

function zeroProjection(): ActiveManagedStudioReadProjection {
  return {
    counts: {
      units: 0,
      panels: 0,
      canonicalAssets: 0,
      characters: 0,
      scenes: 0,
      props: 0,
      styles: 0,
      media: 0,
      bindingSets: 0,
    },
    lockedAssetSample: [],
  };
}

interface SqliteSourceIdentity {
  main: string;
  wal: string | null;
}

interface ImmutableReadOnlyDatabase {
  database: DatabaseSync;
  assertSourceUnchanged(): void;
}

function regularFileIdentity(filePath: string, label: string): string | null {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label}必须是无符号链接的普通文件。`);
  }
  return [
    metadata.dev,
    metadata.ino,
    metadata.size,
    metadata.mtimeNs,
    metadata.ctimeNs,
  ].join(":");
}

function sqliteSourceIdentity(databasePath: string, label: string): SqliteSourceIdentity | null {
  const main = regularFileIdentity(databasePath, label);
  if (!main) return null;
  const walPath = `${databasePath}-wal`;
  const wal = regularFileIdentity(walPath, `${label} WAL`);
  if (wal) {
    const walMetadata = lstatSync(walPath, { bigint: true });
    // immutable 连接不会创建 WAL/SHM，但也不会读取未 checkpoint 的 WAL。为了不把
    // 旧主库冒充成当前事实，有未结算 WAL 时诚实降级，而不是返回可能过期的计数。
    if (walMetadata.size > 0n) throw new Error(`${label}存在未结算 WAL；物理零写投影暂时降级。`);
  }
  return { main, wal };
}

function openExistingReadOnlyDatabase(databasePath: string, label: string): ImmutableReadOnlyDatabase | null {
  const before = sqliteSourceIdentity(databasePath, label);
  if (!before) return null;
  const immutableUrl = pathToFileURL(databasePath);
  immutableUrl.searchParams.set("immutable", "1");
  const database = new DatabaseSync(immutableUrl, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON");
    return {
      database,
      assertSourceUnchanged() {
        const after = sqliteSourceIdentity(databasePath, label);
        if (!after || after.main !== before.main || after.wal !== before.wal) {
          throw new Error(`${label} changed while building physical read-only projection`);
        }
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

function count(database: DatabaseSync, sql: string, ...parameters: Array<string | number>): number {
  const row = database.prepare(sql).get(...parameters) as { count?: number | bigint } | undefined;
  const value = Number(row?.count ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Studio 只读计数投影返回非法结果。");
  return value;
}

function hasTables(database: DatabaseSync, required: readonly string[]): boolean {
  const placeholders = required.map(() => "?").join(",");
  const rows = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type='table' AND name IN (${placeholders})
  `).all(...required) as Array<{ name: string }>;
  const found = new Set(rows.map((row) => row.name));
  return required.every((name) => found.has(name));
}

/**
 * 活动上下文专用的物理零写投影。
 *
 * 只打开已存在的素材库/生产库，且连接固定为 readOnly + query_only：
 * - 不建目录、数据库、表、索引、锁文件；
 * - 不迁移 schema，不接触 generation ledger；
 * - 不复制 SQLite 到临时目录，不创建 WAL/SHM。
 *
 * generation ledger 的 nextAction/queue 由调用方诚实标记为 degraded；这里仅返回
 * 两个事实库可精确回答的计数和已设主权威资产样本。
 */
export function readActiveManagedStudioProjection(
  shell: Pick<ProjectShell, "paths">,
): ActiveManagedStudioReadProjection {
  const result = zeroProjection();
  let materialSource: ImmutableReadOnlyDatabase | null = null;
  let productionSource: ImmutableReadOnlyDatabase | null = null;
  try {
    materialSource = openExistingReadOnlyDatabase(shell.paths.materialDatabase, "素材库数据库");
    productionSource = openExistingReadOnlyDatabase(shell.paths.productionDatabase, "生产知识库数据库");
    const material = materialSource?.database ?? null;
    const production = productionSource?.database ?? null;
    if (material && hasTables(material, ["studio_media", "studio_canonical_assets", "studio_asset_versions"])) {
      result.counts.media = count(material, "SELECT COUNT(*) AS count FROM studio_media");
      result.counts.canonicalAssets = count(material, "SELECT COUNT(*) AS count FROM studio_canonical_assets");
      result.counts.characters = count(
        material,
        "SELECT COUNT(*) AS count FROM studio_canonical_assets WHERE category='character'",
      );
      result.counts.scenes = count(
        material,
        "SELECT COUNT(*) AS count FROM studio_canonical_assets WHERE category='scene'",
      );
      result.counts.props = count(
        material,
        "SELECT COUNT(*) AS count FROM studio_canonical_assets WHERE category='prop'",
      );
      result.counts.styles = count(
        material,
        "SELECT COUNT(*) AS count FROM studio_canonical_assets WHERE category='style'",
      );
      result.lockedAssetSample = (material.prepare(`
        SELECT a.id, a.name, a.category, a.revision
        FROM studio_canonical_assets a
        WHERE a.primary_version_id IS NOT NULL
        ORDER BY a.id
        LIMIT 6
      `).all() as Array<{
        id: string;
        name: string;
        category: "character" | "scene" | "prop" | "style";
        revision: number | bigint;
      }>).map((row) => ({
        assetId: row.id,
        name: row.name,
        category: row.category,
        revision: Number(row.revision),
        currentness: "current" as const,
      }));
    }
    if (production && hasTables(production, ["studio_production_units", "studio_asset_binding_sets"])) {
      result.counts.units = count(production, "SELECT COUNT(*) AS count FROM studio_production_units");
      result.counts.panels = count(
        production,
        "SELECT COALESCE(SUM(panel_count), 0) AS count FROM studio_production_units",
      );
      result.counts.bindingSets = count(production, "SELECT COUNT(*) AS count FROM studio_asset_binding_sets");
    }
    materialSource?.assertSourceUnchanged();
    productionSource?.assertSourceUnchanged();
    return result;
  } finally {
    productionSource?.database.close();
    materialSource?.database.close();
  }
}
