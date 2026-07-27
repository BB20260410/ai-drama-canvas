import { DatabaseSync } from "node:sqlite";
import type { Artifact, CanvasPosition, ProjectIndex, WorkItem } from "./types.js";
import { getSidecarPaths } from "./sidecar.js";

export class ProjectCache {
  private readonly db: DatabaseSync;

  constructor(projectRoot: string) {
    this.db = new DatabaseSync(getSidecarPaths(projectRoot).cache, { timeout: 5_000 });
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL");
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
