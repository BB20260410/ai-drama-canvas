import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { chmod, lstat, open, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Artifact, CanvasPosition, ProjectIndex, WorkItem } from "./types.js";
import { getSidecarPaths } from "./sidecar.js";
import { studioSqliteBusyTimeoutMs } from "./studio-sqlite-busy.js";

export const PROJECT_CACHE_V2_FILE = "cache-v2.sqlite";

interface ProjectCacheOptions {
  writerSchemaVersion?: 1 | 2;
}

interface LegacyProjectCacheWriterFence {
  schemaVersion: 1;
  kind: "ai-canvas-legacy-cache-writer-fence";
  projectId: string;
  rootRealpath: string;
  minimumWriterSchemaVersion: 2;
  replacementDatabase: `.aicanvas/${typeof PROJECT_CACHE_V2_FILE}`;
  fingerprint: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function projectCachePath(projectRootValue: string, options: ProjectCacheOptions): string {
  const projectRoot = path.resolve(projectRootValue);
  const sidecar = getSidecarPaths(projectRoot);
  if (options.writerSchemaVersion === 2) return path.join(sidecar.root, PROJECT_CACHE_V2_FILE);
  if (options.writerSchemaVersion === 1) return sidecar.cache;
  const manifestPath = path.join(sidecar.root, "managed-project.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return sidecar.cache;
    }
    throw new Error(`无法判定项目缓存 writer schema：${manifestPath}`, { cause: error });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`受管项目 manifest 无效，拒绝选择缓存数据库：${manifestPath}`);
  }
  const manifest = raw as Record<string, unknown>;
  const { fingerprint: storedFingerprint, ...semantic } = manifest;
  if (manifest.kind !== "ai-canvas-managed-project"
    || manifest.rootRealpath !== projectRoot
    || typeof storedFingerprint !== "string"
    || fingerprint(semantic) !== storedFingerprint) {
    throw new Error(`受管项目 manifest 身份无效，拒绝选择缓存数据库：${manifestPath}`);
  }
  if (manifest.schemaVersion === 1
    && !("workspaceMode" in manifest)
    && !("minimumWriterSchemaVersion" in manifest)) return sidecar.cache;
  if (manifest.schemaVersion === 2
    && (manifest.workspaceMode === "novel" || manifest.workspaceMode === "hybrid")
    && manifest.minimumWriterSchemaVersion === 2
    && manifest.relativePaths
    && typeof manifest.relativePaths === "object"
    && !Array.isArray(manifest.relativePaths)
    && (manifest.relativePaths as Record<string, unknown>).cache === `.aicanvas/${PROJECT_CACHE_V2_FILE}`
    && typeof manifest.projectId === "string"
    && manifest.projectId) {
    inspectLegacyProjectCacheWriterFenceSync(projectRoot, manifest.projectId);
    return path.join(sidecar.root, PROJECT_CACHE_V2_FILE);
  }
  throw new Error(`受管项目缓存 writer schema 不受支持：${manifestPath}`);
}

function legacyCacheFenceSemantic(
  projectRoot: string,
  projectId: string,
): Omit<LegacyProjectCacheWriterFence, "fingerprint"> {
  return {
    schemaVersion: 1,
    kind: "ai-canvas-legacy-cache-writer-fence",
    projectId,
    rootRealpath: projectRoot,
    minimumWriterSchemaVersion: 2,
    replacementDatabase: `.aicanvas/${PROJECT_CACHE_V2_FILE}`,
  };
}

function inspectLegacyProjectCacheWriterFenceSync(projectRoot: string, projectId: string): void {
  const cachePath = getSidecarPaths(projectRoot).cache;
  const metadata = lstatSync(cachePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.size <= 0 || metadata.size > 16 * 1024 || (metadata.mode & 0o222) !== 0) {
    throw new Error("旧缓存 writer fence 不是只读单链接普通文件。");
  }
  const raw = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("旧缓存 writer fence payload 无效。");
  const value = raw as Record<string, unknown>;
  const { fingerprint: storedFingerprint, ...semantic } = value;
  const expected = legacyCacheFenceSemantic(projectRoot, projectId);
  if (storedFingerprint !== fingerprint(semantic)
    || JSON.stringify(stableValue(semantic)) !== JSON.stringify(stableValue(expected))) {
    throw new Error("旧缓存 writer fence 身份或 fingerprint 无效。");
  }
}

/**
 * v2 项目把真实布局缓存移到 cache-v2.sqlite，并把旧 writer 固定打开的
 * cache.sqlite 变成只读非 SQLite fence。即使权限被复制工具意外放宽，旧
 * ProjectCache 也会在任何 schema/layout 写入前因“非数据库”失败。
 */
export async function createLegacyProjectCacheWriterFence(
  projectRootValue: string,
  projectId: string,
): Promise<void> {
  const projectRoot = path.resolve(projectRootValue);
  const cachePath = getSidecarPaths(projectRoot).cache;
  const handle = await open(cachePath, "wx", 0o600);
  try {
    const semantic = legacyCacheFenceSemantic(projectRoot, projectId);
    const payload: LegacyProjectCacheWriterFence = { ...semantic, fingerprint: fingerprint(semantic) };
    try {
      await handle.writeFile(`${JSON.stringify(stableValue(payload), null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(cachePath, 0o400);
    const metadata = await lstat(cachePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o222) !== 0) {
      throw new Error("旧缓存 writer fence 未成为只读普通文件。");
    }
    await inspectLegacyProjectCacheWriterFence(projectRoot, projectId);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(cachePath, { force: true });
    throw error;
  }
}

export async function inspectLegacyProjectCacheWriterFence(
  projectRootValue: string,
  projectId: string,
): Promise<void> {
  const projectRoot = path.resolve(projectRootValue);
  inspectLegacyProjectCacheWriterFenceSync(projectRoot, projectId);
}

export class ProjectCache {
  private readonly db: DatabaseSync;

  constructor(projectRoot: string, options: ProjectCacheOptions = {}) {
    const busyTimeoutMs = studioSqliteBusyTimeoutMs(5_000);
    this.db = new DatabaseSync(projectCachePath(projectRoot, options), { timeout: busyTimeoutMs });
    this.db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA synchronous=NORMAL`);
    const journal = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    if (journal?.journal_mode?.toLowerCase() !== "wal") this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        episode INTEGER,
        unit INTEGER,
        title TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS layouts (
        view_key TEXT NOT NULL,
        node_id TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (view_key, node_id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS item_search USING fts5(id, title, excerpt, paths);
    `);
    const itemColumns = new Set((this.db.prepare("PRAGMA table_info(items)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!itemColumns.has("type")) this.db.exec("ALTER TABLE items ADD COLUMN type TEXT");
    if (!itemColumns.has("parent_id")) this.db.exec("ALTER TABLE items ADD COLUMN parent_id TEXT");
    if (!itemColumns.has("shot")) this.db.exec("ALTER TABLE items ADD COLUMN shot TEXT");
  }

  replaceIndex(index: ProjectIndex): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM items; DELETE FROM artifacts; DELETE FROM item_search;");
      const insertItem = this.db.prepare(
        "INSERT INTO items (id, status, episode, unit, type, parent_id, shot, title, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertArtifact = this.db.prepare(
        "INSERT INTO artifacts (id, item_id, path, kind, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const insertSearch = this.db.prepare("INSERT INTO item_search (id, title, excerpt, paths) VALUES (?, ?, ?, ?)");
      for (const item of index.items) {
        insertItem.run(item.id, item.status, item.episode ?? null, item.unit ?? null, item.type, item.parentId ?? null, item.shot ?? null, item.title, JSON.stringify(item), item.updatedAt);
        insertSearch.run(item.id, item.title, item.infoExcerpt ?? "", item.sourcePaths.join(" "));
      }
      for (const artifact of index.artifacts) {
        insertArtifact.run(artifact.id, artifact.itemId, artifact.path, artifact.kind, JSON.stringify(artifact), artifact.modifiedAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  savePositions(viewKey: string, positions: Record<string, CanvasPosition>): void {
    const statement = this.db.prepare(
      `INSERT INTO layouts (view_key, node_id, x, y, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(view_key, node_id) DO UPDATE SET x=excluded.x, y=excluded.y, updated_at=excluded.updated_at`,
    );
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [nodeId, position] of Object.entries(positions)) {
        statement.run(viewKey, nodeId, position.x, position.y, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  loadPositions(viewKey: string): Record<string, CanvasPosition> {
    const rows = this.db.prepare("SELECT node_id, x, y FROM layouts WHERE view_key = ?").all(viewKey) as Array<{
      node_id: string;
      x: number;
      y: number;
    }>;
    return Object.fromEntries(rows.map((row) => [row.node_id, { x: row.x, y: row.y }]));
  }

  search(query: string, limit = 30): WorkItem[] {
    if (!query.trim()) return [];
    const rows = this.db
      .prepare(
        `SELECT items.payload FROM item_search
         JOIN items ON items.id = item_search.id
         WHERE item_search MATCH ? LIMIT ?`,
      )
      .all(`${query.replace(/["']/g, "")}*`, limit) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as WorkItem);
  }

  getArtifact(id: string): Artifact | null {
    const row = this.db.prepare("SELECT payload FROM artifacts WHERE id = ?").get(id) as { payload?: string } | undefined;
    return row?.payload ? (JSON.parse(row.payload) as Artifact) : null;
  }

  close(): void {
    this.db.close();
  }
}
