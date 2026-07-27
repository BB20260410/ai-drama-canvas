import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function identifier(value: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) throw new Error(`SQLite schema identifier 无效：${value}`);
  return value;
}

function normalizedSql(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value).trim().replace(/\s+/gu, " ");
}

function normalizedRows(rows: unknown[]): unknown[] {
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    return Object.fromEntries(Object.entries(row as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, value]) => [key, key === "sql" ? normalizedSql(value) : value]));
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
}

function captureContract(
  db: DatabaseSync,
  objectNames: readonly string[],
  tableNames: readonly string[],
  ownedObjectPrefixes: readonly string[],
  rejectAllViews: boolean,
): Record<string, unknown> {
  const requiredObjects = normalizedRows(objectNames.map((name) => {
    const row = db.prepare(`
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_master
      WHERE name = ?
    `).get(name) as Record<string, unknown> | undefined;
    return row ?? { missing: name };
  }));
  const tableSet = new Set(tableNames);
  const allObjects = db.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
  `).all() as Array<{ type: string; name: string; tableName: string; sql: string | null }>;
  const ownedObjects = normalizedRows(allObjects.filter((row) => {
    if (rejectAllViews && row.type === "view") return true;
    if (tableSet.has(row.name) || tableSet.has(row.tableName)) return true;
    if (ownedObjectPrefixes.some((prefix) => row.name.startsWith(prefix))) return true;
    const sql = row.sql;
    if (row.type !== "view" || !sql) return false;
    return tableNames.some((table) => new RegExp(`\\b${table}\\b`, "iu").test(sql));
  }));
  const tables = Object.fromEntries([...tableNames]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((name) => {
      const safeName = identifier(name);
      const columns = normalizedRows(db.prepare(`PRAGMA table_xinfo(${safeName})`).all() as unknown[]);
      const foreignKeys = normalizedRows(db.prepare(`PRAGMA foreign_key_list(${safeName})`).all() as unknown[]);
      const indexList = normalizedRows(db.prepare(`PRAGMA index_list(${safeName})`).all() as unknown[]);
      const indexDetails = Object.fromEntries((indexList as Array<Record<string, unknown>>)
        .map((entry) => String(entry.name ?? ""))
        .filter((indexName) => IDENTIFIER_PATTERN.test(indexName))
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((indexName) => [
          indexName,
          normalizedRows(db.prepare(`PRAGMA index_xinfo(${identifier(indexName)})`).all() as unknown[]),
        ]));
      return [name, { columns, foreignKeys, indexList, indexDetails }];
    }));
  return { requiredObjects, ownedObjects, tables };
}

export function assertSqliteSchemaContract(input: {
  actual: DatabaseSync;
  expected: DatabaseSync;
  objectNames: readonly string[];
  tableNames: readonly string[];
  /** 模块拥有的对象名前缀；用于拒绝额外 table/index/trigger/view。 */
  ownedObjectPrefixes?: readonly string[];
  /** 当前 owner 不声明任何 view；出现任意 view 都拒绝，未来必须显式升版。 */
  rejectAllViews?: boolean;
  label: string;
}): void {
  const prefixes = input.ownedObjectPrefixes ?? [];
  const rejectAllViews = input.rejectAllViews ?? false;
  const actual = JSON.stringify(captureContract(input.actual, input.objectNames, input.tableNames, prefixes, rejectAllViews));
  const expected = JSON.stringify(captureContract(input.expected, input.objectNames, input.tableNames, prefixes, rejectAllViews));
  if (actual === expected) return;
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  throw new Error(`${input.label} 完整 schema 合同不一致：actual=${digest(actual)} expected=${digest(expected)}`);
}
