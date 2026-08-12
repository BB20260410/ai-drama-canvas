/**
 * P9：增量命令账本存储。
 * 以 SQLite 单行 upsert 替代 command-ledger.json 全数组 O(n) 重写。
 * 首次打开时从 legacy JSON 迁移；之后 JSON 仅作只读兼容旁路（不再全量写回）。
 */
import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getSidecarPaths } from "./sidecar.js";
import { ensureConfinedDirectory } from "./confined-project-storage.js";
import { assertSqliteSchemaContract } from "./sqlite-schema-contract.js";
import {
  assertSafeSqliteSidecars,
  assertSqliteSourceBindingIdentity,
  inspectSqliteSourceBindingIdentity,
  openSqliteReadOnlySnapshot,
  type SqliteSourceBindingIdentity,
} from "./sqlite-readonly-snapshot.js";

export interface CommandLedgerEntry {
  schemaVersion: 1;
  requestId: string;
  idempotencyKey: string;
  command: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  replayed: boolean;
  requestHash: string;
  startedAt: string;
  executedAt?: string;
  result?: unknown;
  error?: unknown;
  execution?: unknown;
  durableReconciliation?: unknown;
  storageRoot?: string;
  [key: string]: unknown;
}

export interface CommandLedgerSnapshot {
  schemaVersion: 1;
  entries: CommandLedgerEntry[];
  updatedAt: string;
  backend: "sqlite" | "json-legacy";
}

import { STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS, studioSqliteBusyTimeoutMs } from "./studio-sqlite-busy.js";
const BUSY_TIMEOUT_MS = STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS;
const COMMAND_LEDGER_SCHEMA_VERSION = 1;

let beforeCommandLedgerWritableOpenHookForTests:
  | ((input: { databasePath: string; sourceIdentity: SqliteSourceBindingIdentity | null }) => void | Promise<void>)
  | null = null;

/** 仅供 Vitest 确定性注入 read-only preflight → writable open 竞态。 */
export function __setBeforeCommandLedgerWritableOpenHookForTests(
  hook: typeof beforeCommandLedgerWritableOpenHookForTests,
): void {
  if (process.env.NODE_ENV !== "test") throw new Error("command ledger writable-open hook 仅允许测试环境。");
  beforeCommandLedgerWritableOpenHookForTests = hook;
}

function ledgerSqlitePath(projectRoot: string): string {
  return path.join(getSidecarPaths(projectRoot).root, "command-ledger.sqlite");
}

interface SchemaColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

const EXPECTED_ENTRY_COLUMNS: SchemaColumn[] = [
  { name: "idempotency_key", type: "TEXT", notnull: 0, pk: 1 },
  { name: "request_id", type: "TEXT", notnull: 1, pk: 0 },
  { name: "command", type: "TEXT", notnull: 1, pk: 0 },
  { name: "status", type: "TEXT", notnull: 1, pk: 0 },
  { name: "request_hash", type: "TEXT", notnull: 1, pk: 0 },
  { name: "started_at", type: "TEXT", notnull: 1, pk: 0 },
  { name: "executed_at", type: "TEXT", notnull: 0, pk: 0 },
  { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
  { name: "payload_json", type: "TEXT", notnull: 1, pk: 0 },
];

const EXPECTED_META_COLUMNS: SchemaColumn[] = [
  { name: "key", type: "TEXT", notnull: 0, pk: 1 },
  { name: "value", type: "TEXT", notnull: 1, pk: 0 },
];

function tableColumns(db: DatabaseSync, table: string): SchemaColumn[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<SchemaColumn & { cid: number }>)
    .map(({ name, type, notnull, pk }) => ({ name, type: type.toUpperCase(), notnull, pk }));
}

const REQUEST_HASH_INDEX = "idx_command_ledger_request_hash_started_at";

function assertSchema(db: DatabaseSync, allowUnmarkedLegacy: boolean): {
  markerPresent: boolean;
  requestHashIndexPresent: boolean;
} {
  const tables = db.prepare(`
    SELECT name, type FROM sqlite_master
    WHERE name IN ('command_ledger_entries', 'command_ledger_meta')
    ORDER BY name
  `).all() as Array<{ name: string; type: string }>;
  if (JSON.stringify(tables) !== JSON.stringify([
    { name: "command_ledger_entries", type: "table" },
    { name: "command_ledger_meta", type: "table" },
  ])) {
    throw new Error("命令账本 schema 缺表或同名对象类型无效，禁止猜测修复。");
  }
  if (JSON.stringify(tableColumns(db, "command_ledger_entries")) !== JSON.stringify(EXPECTED_ENTRY_COLUMNS)
    || JSON.stringify(tableColumns(db, "command_ledger_meta")) !== JSON.stringify(EXPECTED_META_COLUMNS)) {
    throw new Error("命令账本 schema 列合同无效，禁止猜测修复。");
  }
  const indexes = db.prepare("PRAGMA index_list(command_ledger_entries)").all() as Array<{
    name: string;
    unique: number;
  }>;
  for (const expected of ["idx_command_ledger_request_id", "idx_command_ledger_started_at"]) {
    if (!indexes.some((entry) => entry.name === expected && entry.unique === 0)) {
      throw new Error(`命令账本 schema 缺少索引：${expected}。`);
    }
  }
  const requestHashIndexPresent = indexes.some((entry) => entry.name === REQUEST_HASH_INDEX && entry.unique === 0);
  const expectedSchema = new DatabaseSync(":memory:");
  try {
    createSchema(expectedSchema, requestHashIndexPresent);
    assertSqliteSchemaContract({
      actual: db,
      expected: expectedSchema,
      objectNames: [
        "command_ledger_entries",
        "command_ledger_meta",
        "idx_command_ledger_request_id",
        "idx_command_ledger_started_at",
        ...(requestHashIndexPresent ? [REQUEST_HASH_INDEX] : []),
      ],
      tableNames: ["command_ledger_entries", "command_ledger_meta"],
      ownedObjectPrefixes: ["command_ledger_", "idx_command_ledger_"],
      rejectAllViews: true,
      label: "Command ledger",
    });
  } finally {
    expectedSchema.close();
  }
  const marker = db.prepare(
    "SELECT value FROM command_ledger_meta WHERE key='schema_version'",
  ).get() as { value?: string } | undefined;
  if (!marker) {
    if (!allowUnmarkedLegacy) throw new Error("命令账本 schema_version 缺失。");
    return { markerPresent: false, requestHashIndexPresent };
  }
  if (marker.value !== String(COMMAND_LEDGER_SCHEMA_VERSION)) {
    throw new Error(`不支持的命令账本 schema_version：${marker.value}。`);
  }
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) throw new Error("命令账本存在外键孤儿。");
  return { markerPresent: true, requestHashIndexPresent };
}

function createSchema(db: DatabaseSync, includeRequestHashIndex = true): void {
  db.exec(`
    CREATE TABLE command_ledger_entries (
      idempotency_key TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      command TEXT NOT NULL,
      status TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      started_at TEXT NOT NULL,
      executed_at TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX idx_command_ledger_request_id ON command_ledger_entries(request_id);
    CREATE INDEX idx_command_ledger_started_at ON command_ledger_entries(started_at DESC);
    ${includeRequestHashIndex ? `CREATE INDEX ${REQUEST_HASH_INDEX}
      ON command_ledger_entries(request_hash, started_at ASC, idempotency_key ASC);` : ""}
    CREATE TABLE command_ledger_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO command_ledger_meta(key, value) VALUES('schema_version', '${COMMAND_LEDGER_SCHEMA_VERSION}');
  `);
}

async function preflightExistingDatabase(filePath: string): Promise<{
  markerPresent: boolean;
  requestHashIndexPresent: boolean;
  sourceIdentity: SqliteSourceBindingIdentity;
}> {
  let snapshot: Awaited<ReturnType<typeof openSqliteReadOnlySnapshot>> | null = null;
  try {
    snapshot = await openSqliteReadOnlySnapshot(filePath, "command ledger");
    return { ...assertSchema(snapshot.database, true), sourceIdentity: snapshot.sourceIdentity };
  } finally {
    await snapshot?.close();
  }
}

async function openWritableDb(projectRoot: string): Promise<DatabaseSync> {
  const filePath = ledgerSqlitePath(projectRoot);
  await ensureConfinedDirectory(projectRoot, getSidecarPaths(projectRoot).root);
  const existed = existsSync(filePath);
  const preflight = existed ? await preflightExistingDatabase(filePath) : null;
  const hook = beforeCommandLedgerWritableOpenHookForTests;
  beforeCommandLedgerWritableOpenHookForTests = null;
  await hook?.({ databasePath: filePath, sourceIdentity: preflight?.sourceIdentity ?? null });
  assertSafeSqliteSidecars(filePath, "command ledger");
  if (preflight) {
    assertSqliteSourceBindingIdentity(filePath, preflight.sourceIdentity, "command ledger");
  } else if (existsSync(filePath)) {
    throw new Error("命令账本在空库预检后被并发创建，禁止写打开。");
  }
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(BUSY_TIMEOUT_MS);
  const db = new DatabaseSync(filePath, { timeout: busyTimeoutMs });
  try {
    assertSafeSqliteSidecars(filePath, "command ledger");
    if (preflight) {
      assertSqliteSourceBindingIdentity(filePath, preflight.sourceIdentity, "command ledger");
    } else {
      inspectSqliteSourceBindingIdentity(filePath, "command ledger");
    }
    // 连接级 PRAGMA 不落盘；schema 只在隔离快照预检与 inode 复验后处理。
    db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON;`);
    if (!existed) {
      db.exec("BEGIN IMMEDIATE");
      try {
        createSchema(db);
        assertSchema(db, false);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } else {
      const current = assertSchema(db, true);
      if (current.markerPresent !== preflight?.markerPresent
        || current.requestHashIndexPresent !== preflight?.requestHashIndexPresent) {
        throw new Error("命令账本在预检后发生身份漂移，禁止写入。");
      }
      if (!current.markerPresent || !current.requestHashIndexPresent) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const beforeMigration = assertSchema(db, true);
          if (!beforeMigration.markerPresent) {
            db.prepare("INSERT INTO command_ledger_meta(key, value) VALUES('schema_version', ?)")
              .run(String(COMMAND_LEDGER_SCHEMA_VERSION));
          }
          if (!beforeMigration.requestHashIndexPresent) {
            db.exec(`CREATE INDEX ${REQUEST_HASH_INDEX}
              ON command_ledger_entries(request_hash, started_at ASC, idempotency_key ASC)`);
          }
          const migrated = assertSchema(db, false);
          if (!migrated.requestHashIndexPresent) throw new Error("命令账本 requestHash 索引迁移失败。");
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
    }
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    if (journal?.journal_mode?.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode=WAL");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function emptySnapshot(): CommandLedgerSnapshot {
  return { schemaVersion: 1, entries: [], updatedAt: new Date(0).toISOString(), backend: "sqlite" };
}

function parseEntry(payloadJson: string): CommandLedgerEntry {
  const value = JSON.parse(payloadJson) as CommandLedgerEntry;
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) {
    throw new Error("命令账本 SQLite 记录 payload 无效。");
  }
  return value;
}

function assertLegacyLedger(value: unknown, filePath: string): asserts value is {
  schemaVersion: 1;
  entries: CommandLedgerEntry[];
  updatedAt: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`命令账本 JSON 结构无效：${filePath}`);
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.entries) || typeof candidate.updatedAt !== "string") {
    throw new Error(`命令账本 JSON 结构无效：${filePath}`);
  }
  for (const entry of candidate.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`命令账本包含无效记录：${filePath}`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.requestId !== "string"
      || typeof record.idempotencyKey !== "string"
      || typeof record.command !== "string"
      || !["running", "succeeded", "failed", "cancelled", "unknown"].includes(String(record.status))
      || typeof record.requestHash !== "string"
      || typeof record.startedAt !== "string") {
      throw new Error(`命令账本包含无效记录：${filePath}`);
    }
  }
}

async function readLegacySnapshot(projectRoot: string): Promise<CommandLedgerSnapshot | null> {
  const filePath = getSidecarPaths(projectRoot).commandLedger;
  const present = await access(filePath).then(() => true, () => false);
  if (!present) return null;
  const raw = await readFile(filePath, "utf8");
  let legacy: unknown;
  try {
    legacy = JSON.parse(raw);
  } catch (error) {
    throw new Error(`命令账本 JSON 结构无效：${filePath}`, { cause: error });
  }
  assertLegacyLedger(legacy, filePath);
  return {
    schemaVersion: 1,
    entries: legacy.entries,
    updatedAt: legacy.updatedAt,
    backend: "json-legacy",
  };
}

async function readSqlite<T>(
  projectRoot: string,
  callback: (db: DatabaseSync) => T,
): Promise<{ databasePresent: false } | { databasePresent: true; value: T }> {
  const filePath = ledgerSqlitePath(projectRoot);
  if (!existsSync(filePath)) return { databasePresent: false };
  let snapshot: Awaited<ReturnType<typeof openSqliteReadOnlySnapshot>> | null = null;
  try {
    snapshot = await openSqliteReadOnlySnapshot(filePath, "command ledger");
    assertSchema(snapshot.database, true);
    return { databasePresent: true, value: callback(snapshot.database) };
  } finally {
    await snapshot?.close();
  }
}

async function migrateFromJsonIfNeeded(projectRoot: string, db: DatabaseSync): Promise<void> {
  const count = Number((db.prepare("SELECT COUNT(*) AS c FROM command_ledger_entries").get() as { c: number }).c);
  if (count > 0) return;
  const jsonPath = getSidecarPaths(projectRoot).commandLedger;
  const exists = await access(jsonPath).then(() => true, () => false);
  if (!exists) return;
  const raw = await readFile(jsonPath, "utf8");
  let legacy: unknown;
  try {
    legacy = JSON.parse(raw);
  } catch (error) {
    throw new Error(`命令账本 JSON 结构无效：${jsonPath}`, { cause: error });
  }
  assertLegacyLedger(legacy, jsonPath);
  if (!legacy.entries.length) return;
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO command_ledger_entries(
      idempotency_key, request_id, command, status, request_hash, started_at, executed_at, updated_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec("BEGIN");
  try {
    for (const entry of legacy.entries) {
      insert.run(
        entry.idempotencyKey,
        entry.requestId,
        entry.command,
        entry.status,
        entry.requestHash,
        entry.startedAt,
        entry.executedAt ?? null,
        entry.executedAt ?? entry.startedAt ?? now,
        JSON.stringify(entry),
      );
    }
    db.prepare("INSERT OR REPLACE INTO command_ledger_meta(key, value) VALUES('updatedAt', ?)").run(legacy.updatedAt ?? now);
    db.prepare("INSERT OR REPLACE INTO command_ledger_meta(key, value) VALUES('migratedFromJsonAt', ?)").run(now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function loadCommandLedger(projectRoot: string): Promise<CommandLedgerSnapshot> {
  const root = path.resolve(projectRoot);
  const sqlite = await readSqlite(root, (db) => {
    const rows = db.prepare(`
      SELECT payload_json FROM command_ledger_entries
      ORDER BY started_at DESC, idempotency_key DESC
    `).all() as Array<{ payload_json: string }>;
    const meta = db.prepare("SELECT value FROM command_ledger_meta WHERE key='updatedAt'").get() as { value?: string } | undefined;
    return {
      schemaVersion: 1 as const,
      entries: rows.map((row) => parseEntry(row.payload_json)),
      updatedAt: meta?.value ?? new Date(0).toISOString(),
      backend: "sqlite" as const,
    };
  });
  if (sqlite.databasePresent) return sqlite.value;
  return await readLegacySnapshot(root) ?? emptySnapshot();
}

export async function upsertCommandLedgerEntry(
  projectRoot: string,
  entry: CommandLedgerEntry,
  updatedAt = new Date().toISOString(),
): Promise<void> {
  const root = path.resolve(projectRoot);
  const db = await openWritableDb(root);
  try {
    await migrateFromJsonIfNeeded(root, db);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
      INSERT INTO command_ledger_entries(
        idempotency_key, request_id, command, status, request_hash, started_at, executed_at, updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        request_id=excluded.request_id,
        command=excluded.command,
        status=excluded.status,
        request_hash=excluded.request_hash,
        started_at=excluded.started_at,
        executed_at=excluded.executed_at,
        updated_at=excluded.updated_at,
        payload_json=excluded.payload_json
      `).run(
        entry.idempotencyKey,
        entry.requestId,
        entry.command,
        entry.status,
        entry.requestHash,
        entry.startedAt,
        entry.executedAt ?? null,
        updatedAt,
        JSON.stringify(entry),
      );
      db.prepare("INSERT OR REPLACE INTO command_ledger_meta(key, value) VALUES('updatedAt', ?)").run(updatedAt);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "命令账本 entry/meta 事务与回滚均失败。");
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

/** 兼容旧接口：写入完整快照（事务替换），仅迁移/测试使用。 */
export async function replaceCommandLedger(
  projectRoot: string,
  ledger: { entries: CommandLedgerEntry[]; updatedAt: string },
): Promise<void> {
  const root = path.resolve(projectRoot);
  const db = await openWritableDb(root);
  try {
    db.exec("BEGIN");
    db.prepare("DELETE FROM command_ledger_entries").run();
    const insert = db.prepare(`
      INSERT INTO command_ledger_entries(
        idempotency_key, request_id, command, status, request_hash, started_at, executed_at, updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of ledger.entries) {
      insert.run(
        entry.idempotencyKey,
        entry.requestId,
        entry.command,
        entry.status,
        entry.requestHash,
        entry.startedAt,
        entry.executedAt ?? null,
        entry.executedAt ?? entry.startedAt,
        JSON.stringify(entry),
      );
    }
    db.prepare("INSERT OR REPLACE INTO command_ledger_meta(key, value) VALUES('updatedAt', ?)").run(ledger.updatedAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

/** 按幂等键 O(1) 读取单条命令（热路径禁止 loadCommandLedger 全表）。 */
export async function getCommandLedgerEntryByIdempotencyKey(
  projectRoot: string,
  idempotencyKey: string,
): Promise<CommandLedgerEntry | null> {
  const root = path.resolve(projectRoot);
  const sqlite = await readSqlite(root, (db) => {
    const row = db.prepare(`
      SELECT payload_json FROM command_ledger_entries WHERE idempotency_key = ?
    `).get(idempotencyKey) as { payload_json: string } | undefined;
    return row ? parseEntry(row.payload_json) : null;
  });
  if (sqlite.databasePresent) return sqlite.value;
  return (await readLegacySnapshot(root))?.entries.find((entry) => entry.idempotencyKey === idempotencyKey) ?? null;
}

/** 按 requestId 索引读取（可能 0–1 条；索引 idx_command_ledger_request_id）。 */
export async function getCommandLedgerEntryByRequestId(
  projectRoot: string,
  requestId: string,
): Promise<CommandLedgerEntry | null> {
  const root = path.resolve(projectRoot);
  const sqlite = await readSqlite(root, (db) => {
    const row = db.prepare(`
      SELECT payload_json FROM command_ledger_entries WHERE request_id = ? LIMIT 1
    `).get(requestId) as { payload_json: string } | undefined;
    return row ? parseEntry(row.payload_json) : null;
  });
  if (sqlite.databasePresent) return sqlite.value;
  return (await readLegacySnapshot(root))?.entries.find((entry) => entry.requestId === requestId) ?? null;
}

/** 按稳定请求身份读取全部账本别名；小说导入用它跨 idempotencyKey 复用首次结果锚点。 */
export async function getCommandLedgerEntriesByRequestHash(
  projectRoot: string,
  requestHash: string,
): Promise<CommandLedgerEntry[]> {
  const root = path.resolve(projectRoot);
  const sqlite = await readSqlite(root, (db) => {
    const rows = db.prepare(`
      SELECT payload_json FROM command_ledger_entries
      WHERE request_hash = ?
      ORDER BY started_at ASC, idempotency_key ASC
    `).all(requestHash) as Array<{ payload_json: string }>;
    return rows.map((row) => parseEntry(row.payload_json));
  });
  if (sqlite.databasePresent) return sqlite.value;
  return (await readLegacySnapshot(root))?.entries.filter((entry) => entry.requestHash === requestHash) ?? [];
}

export async function listCommandLedgerEntries(
  projectRoot: string,
  limit = 100,
): Promise<CommandLedgerEntry[]> {
  const root = path.resolve(projectRoot);
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const sqlite = await readSqlite(root, (db) => {
    const rows = db.prepare(`
      SELECT payload_json FROM command_ledger_entries
      ORDER BY started_at DESC, idempotency_key DESC
      LIMIT ?
    `).all(safeLimit) as Array<{ payload_json: string }>;
    return rows.map((row) => parseEntry(row.payload_json));
  });
  if (sqlite.databasePresent) return sqlite.value;
  return (await readLegacySnapshot(root))?.entries.slice(0, safeLimit) ?? [];
}

export function commandLedgerSqlitePathFor(projectRoot: string): string {
  return ledgerSqlitePath(path.resolve(projectRoot));
}
