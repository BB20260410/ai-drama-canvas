/**
 * P7 连续性状态账本。
 *
 * 只在现有 studio-generation-ledger.sqlite 内追加连续性表；本模块不连接生成、命令总线、MCP 或 UI。
 */
import { DatabaseSync } from "node:sqlite";
import {
  createStudioContinuityConflictDraft,
  createStudioContinuityReadiness,
  normalizeStudioContinuityEntryDraft,
  normalizeStudioContinuityField,
  normalizeStudioContinuityScope,
  normalizeStudioContinuityScopeAnchor,
  normalizeStudioContinuityStableId,
  studioContinuityDigest,
  studioContinuityEntriesConflict,
  studioContinuityStatesEqual,
  type StudioContinuityConflict,
  type StudioContinuityEntry,
  type StudioContinuityField,
  type StudioContinuityFieldStateInput,
  type StudioContinuityHead,
  type StudioContinuityReadiness,
  type StudioContinuityScope,
  type StudioContinuityScopeAnchor,
  type StudioContinuityScopeAnchorInput,
  type StudioContinuityScopeInput,
  type StudioContinuityTimeline,
} from "./studio-continuity.js";
import { initializeStudioGenerationLedger } from "./studio-generation-ledger.js";
import {
  hasStudioRequestSchemaValidation,
  isStudioRequestSqliteValidationUnchanged,
  markStudioRequestSqliteValidationIfUnchanged,
  studioRequestSqliteValidationKey,
} from "./studio-request-schema-cache.js";

const CONTINUITY_SCHEMA_VERSION = 1 as const;
const CONTINUITY_SCHEMA_MARKER = "studio_continuity_schema_version";
const BUSY_TIMEOUT_MILLISECONDS = 5_000;

const CONTINUITY_TABLES = [
  "studio_continuity_entries",
  "studio_continuity_heads",
  "studio_continuity_conflicts",
  "studio_continuity_conflict_heads",
  "studio_continuity_conflict_resolutions",
  "studio_continuity_operation_receipts",
] as const;

const CONTINUITY_IMMUTABLE_TABLES = [
  "studio_continuity_entries",
  "studio_continuity_conflicts",
  "studio_continuity_conflict_resolutions",
  "studio_continuity_operation_receipts",
] as const;

export type StudioContinuityLedgerErrorCode =
  | "invalid-input"
  | "operation-conflict"
  | "head-conflict"
  | "conflict-not-found"
  | "conflict-state-conflict"
  | "storage-invalid";

export class StudioContinuityLedgerError extends Error {
  readonly code: StudioContinuityLedgerErrorCode;
  readonly details: string[];

  constructor(code: StudioContinuityLedgerErrorCode, message: string, details: string[] = [], options?: ErrorOptions) {
    super(message, options);
    this.name = "StudioContinuityLedgerError";
    this.code = code;
    this.details = details;
  }
}

export class StudioContinuityHeadConflictError extends StudioContinuityLedgerError {
  readonly headKey: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(headKey: string, expectedRevision: number, actualRevision: number) {
    super(
      "head-conflict",
      `continuity head ${headKey} 已变化：期望 revision=${expectedRevision}，实际 revision=${actualRevision}。`,
    );
    this.name = "StudioContinuityHeadConflictError";
    this.headKey = headKey;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export interface StudioContinuityLedgerState {
  schemaVersion: 1;
  databasePath: string;
  generationLedgerReused: true;
  counts: {
    entries: number;
    heads: number;
    conflicts: number;
    openConflicts: number;
    conflictResolutions: number;
    operationReceipts: number;
  };
}

export interface AppendStudioContinuityObservationInput {
  operationId: string;
  expectedHeadRevision: number;
  scope: StudioContinuityScopeInput;
  subjectId: string;
  field: StudioContinuityField;
  state: StudioContinuityFieldStateInput;
}

export interface StudioContinuityExpectedConflictRevision {
  conflictId: string;
  expectedRevision: number;
}

export interface AppendStudioContinuityCorrectionInput {
  operationId: string;
  expectedHeadRevision: number;
  scope: StudioContinuityScopeInput;
  subjectId: string;
  field: StudioContinuityField;
  state: StudioContinuityFieldStateInput;
  supersedesEntryId: string;
  resolvesConflicts?: StudioContinuityExpectedConflictRevision[];
}

export interface StudioContinuityWriteResult {
  schemaVersion: 1;
  kind: "studio-continuity-write-result";
  command: "append-observation" | "append-correction";
  operationId: string;
  receiptId: string;
  requestFingerprint: string;
  applied: true;
  replayed: boolean;
  entry: StudioContinuityEntry;
  head: StudioContinuityHead;
  createdConflicts: StudioContinuityConflict[];
  resolvedConflictIds: string[];
  fingerprint: string;
}

export interface QueryStudioContinuityTimelineInput {
  scopeAnchor: StudioContinuityScopeAnchorInput;
  subjectId?: string;
  field?: StudioContinuityField;
}

export interface QueryStudioContinuityTimelinePageInput extends QueryStudioContinuityTimelineInput {
  /** 稳定键集分页；单页最多 100 个 current head。 */
  cursor?: string;
  limit?: number;
}

export interface StudioContinuityTimelinePage {
  schemaVersion: 1;
  kind: "studio-continuity-timeline-page";
  scopeAnchor: StudioContinuityScopeAnchor;
  subjectId?: string;
  field?: StudioContinuityField;
  total: number;
  items: StudioContinuityTimeline["items"];
  nextCursor?: string;
  fingerprint: string;
}

export interface ListStudioContinuityConflictsInput {
  scopeAnchor?: StudioContinuityScopeAnchorInput;
  scope?: StudioContinuityScopeInput;
  subjectId?: string;
  field?: StudioContinuityField;
  /** 有界分页：缺省返回全部匹配项（调用方应用 limit）。 */
  limit?: number;
  offset?: number;
}

export interface ListStudioContinuityConflictPageInput
  extends Omit<ListStudioContinuityConflictsInput, "limit" | "offset"> {
  /** 稳定 conflict_id 键集 cursor；与过滤条件绑定。 */
  cursor?: string;
  limit?: number;
}

export interface StudioContinuityConflictPage {
  schemaVersion: 1;
  kind: "studio-continuity-conflict-page";
  total: number;
  items: StudioContinuityConflict[];
  nextCursor?: string;
  fingerprint: string;
}

export interface GetStudioContinuityReadinessInput {
  scope: StudioContinuityScopeInput;
  subjectId: string;
  requiredFields: StudioContinuityField[];
}

interface EntryRow {
  sequence: number;
  entry_id: string;
  fingerprint: string;
  entry_kind: "observation" | "correction";
  head_key: string;
  scope_kind: "panel" | "source-shot";
  scope_id: string;
  unit_id: string;
  unit_revision: number;
  start_ms: number;
  end_ms: number;
  subject_id: string;
  field: StudioContinuityField;
  state_status: "resolved" | "unresolved" | "not-applicable";
  state_value: string | null;
  state_reason: string | null;
  state_fingerprint: string;
  provenance_json: string;
  supersedes_entry_id: string | null;
  resolves_conflict_ids_json: string;
  created_at: string;
}

interface HeadRow {
  head_key: string;
  revision: number;
  entry_id: string;
  updated_at: string;
}

interface ConflictRow {
  sequence: number;
  conflict_id: string;
  fingerprint: string;
  scope_kind: "panel" | "source-shot";
  scope_id: string;
  unit_id: string;
  unit_revision: number;
  subject_id: string;
  field: StudioContinuityField;
  overlap_start_ms: number;
  overlap_end_ms: number;
  left_entry_id: string;
  right_entry_id: string;
  created_at: string;
}

interface ConflictHeadRow {
  conflict_id: string;
  revision: number;
  status: "open" | "resolved";
  resolution_id: string | null;
  updated_at: string;
}

interface ConflictResolutionRow {
  sequence: number;
  resolution_id: string;
  fingerprint: string;
  conflict_id: string;
  correction_entry_id: string;
  expected_conflict_revision: number;
  created_at: string;
}

interface OperationOutcome {
  schemaVersion: 1;
  kind: "studio-continuity-operation-outcome";
  command: StudioContinuityWriteResult["command"];
  entryId: string;
  headKey: string;
  headRevision: number;
  headEntryId: string;
  headUpdatedAt: string;
  createdConflictIds: string[];
  resolvedConflictIds: string[];
}

interface OperationReceiptRow {
  sequence: number;
  operation_id: string;
  receipt_id: string;
  command: StudioContinuityWriteResult["command"];
  request_fingerprint: string;
  entry_id: string;
  outcome_json: string;
  fingerprint: string;
  created_at: string;
}

function fail(code: StudioContinuityLedgerErrorCode, message: string, details: string[] = []): never {
  throw new StudioContinuityLedgerError(code, message, details);
}

function asInvalidInput<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    if (error instanceof StudioContinuityLedgerError) throw error;
    throw new StudioContinuityLedgerError(
      "invalid-input",
      error instanceof Error ? error.message : String(error),
      [],
      { cause: error },
    );
  }
}

function parseStoredJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new StudioContinuityLedgerError("storage-invalid", `${label} JSON 无法解析。`, [], { cause: error });
  }
}

function requiredNonNegativeRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail("invalid-input", `${label} 必须是非负安全整数。`);
  return Number(value);
}

function requiredPositiveRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail("invalid-input", `${label} 必须是正安全整数。`);
  return Number(value);
}

function normalizeOperationId(value: unknown): string {
  return asInvalidInput(() => normalizeStudioContinuityStableId(value, "operationId"));
}

function timestampIsValid(value: string): boolean {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function runTransaction<T>(db: DatabaseSync, callback: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function schemaObjectExists(db: DatabaseSync, name: string, type?: "table" | "index" | "trigger"): boolean {
  const row = type
    ? db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = ? AND name = ?").get(type, name)
    : db.prepare("SELECT 1 AS found FROM sqlite_master WHERE name = ?").get(name);
  return Boolean(row);
}

function count(db: DatabaseSync, sql: string): number {
  return Number((db.prepare(sql).get() as { count: number }).count);
}

function createContinuitySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE studio_continuity_entries (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      entry_kind TEXT NOT NULL CHECK(entry_kind IN ('observation', 'correction')),
      head_key TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('panel', 'source-shot')),
      scope_id TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
      start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
      end_ms INTEGER NOT NULL CHECK(end_ms > start_ms AND end_ms <= 15000),
      subject_id TEXT NOT NULL,
      field TEXT NOT NULL CHECK(field IN (
        'costume', 'injury', 'heldObject', 'position', 'facing', 'emotion', 'layout', 'lighting', 'referenceSha256'
      )),
      state_status TEXT NOT NULL CHECK(state_status IN ('resolved', 'unresolved', 'not-applicable')),
      state_value TEXT,
      state_reason TEXT,
      state_fingerprint TEXT NOT NULL CHECK(length(state_fingerprint) = 64),
      provenance_json TEXT NOT NULL,
      supersedes_entry_id TEXT,
      resolves_conflict_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK(
        (state_status = 'resolved' AND state_value IS NOT NULL AND state_reason IS NULL)
        OR (state_status IN ('unresolved', 'not-applicable') AND state_value IS NULL AND state_reason IS NOT NULL)
      ),
      CHECK(
        (entry_kind = 'observation' AND supersedes_entry_id IS NULL AND resolves_conflict_ids_json = '[]')
        OR (entry_kind = 'correction' AND supersedes_entry_id IS NOT NULL)
      ),
      FOREIGN KEY(supersedes_entry_id) REFERENCES studio_continuity_entries(entry_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE studio_continuity_heads (
      head_key TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      entry_id TEXT NOT NULL UNIQUE,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(entry_id) REFERENCES studio_continuity_entries(entry_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE studio_continuity_conflicts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      conflict_id TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('panel', 'source-shot')),
      scope_id TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
      subject_id TEXT NOT NULL,
      field TEXT NOT NULL CHECK(field IN (
        'costume', 'injury', 'heldObject', 'position', 'facing', 'emotion', 'layout', 'lighting', 'referenceSha256'
      )),
      overlap_start_ms INTEGER NOT NULL CHECK(overlap_start_ms >= 0),
      overlap_end_ms INTEGER NOT NULL CHECK(overlap_end_ms > overlap_start_ms AND overlap_end_ms <= 15000),
      left_entry_id TEXT NOT NULL,
      right_entry_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK(left_entry_id < right_entry_id),
      UNIQUE(left_entry_id, right_entry_id),
      FOREIGN KEY(left_entry_id) REFERENCES studio_continuity_entries(entry_id) ON DELETE RESTRICT,
      FOREIGN KEY(right_entry_id) REFERENCES studio_continuity_entries(entry_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE studio_continuity_conflict_resolutions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      resolution_id TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      conflict_id TEXT NOT NULL UNIQUE,
      correction_entry_id TEXT NOT NULL,
      expected_conflict_revision INTEGER NOT NULL CHECK(expected_conflict_revision >= 1),
      created_at TEXT NOT NULL,
      FOREIGN KEY(conflict_id) REFERENCES studio_continuity_conflicts(conflict_id) ON DELETE RESTRICT,
      FOREIGN KEY(correction_entry_id) REFERENCES studio_continuity_entries(entry_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE studio_continuity_conflict_heads (
      conflict_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      status TEXT NOT NULL CHECK(status IN ('open', 'resolved')),
      resolution_id TEXT,
      updated_at TEXT NOT NULL,
      CHECK(
        (status = 'open' AND resolution_id IS NULL)
        OR (status = 'resolved' AND resolution_id IS NOT NULL)
      ),
      FOREIGN KEY(conflict_id) REFERENCES studio_continuity_conflicts(conflict_id) ON DELETE RESTRICT,
      FOREIGN KEY(resolution_id) REFERENCES studio_continuity_conflict_resolutions(resolution_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE studio_continuity_operation_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL UNIQUE,
      receipt_id TEXT NOT NULL UNIQUE,
      command TEXT NOT NULL CHECK(command IN ('append-observation', 'append-correction')),
      request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64),
      entry_id TEXT NOT NULL,
      outcome_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      FOREIGN KEY(entry_id) REFERENCES studio_continuity_entries(entry_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX studio_continuity_entry_anchor_idx
      ON studio_continuity_entries(scope_kind, scope_id, unit_id, unit_revision, subject_id, field, start_ms, end_ms);
    CREATE INDEX studio_continuity_entry_head_idx ON studio_continuity_entries(head_key, sequence);
    CREATE INDEX studio_continuity_conflict_anchor_idx
      ON studio_continuity_conflicts(scope_kind, scope_id, unit_id, unit_revision, subject_id, field, overlap_start_ms, overlap_end_ms);

    CREATE TRIGGER studio_continuity_entries_no_update
      BEFORE UPDATE ON studio_continuity_entries BEGIN SELECT RAISE(ABORT, 'continuity entries are append-only'); END;
    CREATE TRIGGER studio_continuity_entries_no_delete
      BEFORE DELETE ON studio_continuity_entries BEGIN SELECT RAISE(ABORT, 'continuity entries are append-only'); END;
    CREATE TRIGGER studio_continuity_conflicts_no_update
      BEFORE UPDATE ON studio_continuity_conflicts BEGIN SELECT RAISE(ABORT, 'continuity conflicts are append-only'); END;
    CREATE TRIGGER studio_continuity_conflicts_no_delete
      BEFORE DELETE ON studio_continuity_conflicts BEGIN SELECT RAISE(ABORT, 'continuity conflicts are append-only'); END;
    CREATE TRIGGER studio_continuity_conflict_resolutions_no_update
      BEFORE UPDATE ON studio_continuity_conflict_resolutions BEGIN SELECT RAISE(ABORT, 'continuity resolutions are append-only'); END;
    CREATE TRIGGER studio_continuity_conflict_resolutions_no_delete
      BEFORE DELETE ON studio_continuity_conflict_resolutions BEGIN SELECT RAISE(ABORT, 'continuity resolutions are append-only'); END;
    CREATE TRIGGER studio_continuity_operation_receipts_no_update
      BEFORE UPDATE ON studio_continuity_operation_receipts BEGIN SELECT RAISE(ABORT, 'continuity receipts are append-only'); END;
    CREATE TRIGGER studio_continuity_operation_receipts_no_delete
      BEFORE DELETE ON studio_continuity_operation_receipts BEGIN SELECT RAISE(ABORT, 'continuity receipts are append-only'); END;
    CREATE TRIGGER studio_continuity_heads_guard_update
      BEFORE UPDATE ON studio_continuity_heads
      WHEN NEW.head_key <> OLD.head_key OR NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'continuity head requires monotonic CAS'); END;
    CREATE TRIGGER studio_continuity_heads_no_delete
      BEFORE DELETE ON studio_continuity_heads BEGIN SELECT RAISE(ABORT, 'continuity heads cannot be deleted'); END;
    CREATE TRIGGER studio_continuity_conflict_heads_guard_update
      BEFORE UPDATE ON studio_continuity_conflict_heads
      WHEN NEW.conflict_id <> OLD.conflict_id
        OR NEW.revision <> OLD.revision + 1
        OR OLD.status <> 'open'
        OR NEW.status <> 'resolved'
        OR NEW.resolution_id IS NULL
      BEGIN SELECT RAISE(ABORT, 'continuity conflict head requires open-to-resolved CAS'); END;
    CREATE TRIGGER studio_continuity_conflict_heads_no_delete
      BEFORE DELETE ON studio_continuity_conflict_heads BEGIN SELECT RAISE(ABORT, 'continuity conflict heads cannot be deleted'); END;
  `);
}

const EXPECTED_COLUMNS: Record<(typeof CONTINUITY_TABLES)[number], string[]> = {
  studio_continuity_entries: [
    "sequence", "entry_id", "fingerprint", "entry_kind", "head_key", "scope_kind", "scope_id", "unit_id",
    "unit_revision", "start_ms", "end_ms", "subject_id", "field", "state_status", "state_value", "state_reason",
    "state_fingerprint", "provenance_json", "supersedes_entry_id", "resolves_conflict_ids_json", "created_at",
  ],
  studio_continuity_heads: ["head_key", "revision", "entry_id", "updated_at"],
  studio_continuity_conflicts: [
    "sequence", "conflict_id", "fingerprint", "scope_kind", "scope_id", "unit_id", "unit_revision", "subject_id",
    "field", "overlap_start_ms", "overlap_end_ms", "left_entry_id", "right_entry_id", "created_at",
  ],
  studio_continuity_conflict_heads: ["conflict_id", "revision", "status", "resolution_id", "updated_at"],
  studio_continuity_conflict_resolutions: [
    "sequence", "resolution_id", "fingerprint", "conflict_id", "correction_entry_id",
    "expected_conflict_revision", "created_at",
  ],
  studio_continuity_operation_receipts: [
    "sequence", "operation_id", "receipt_id", "command", "request_fingerprint", "entry_id", "outcome_json",
    "fingerprint", "created_at",
  ],
};

const REQUIRED_TRIGGERS = [
  ...CONTINUITY_IMMUTABLE_TABLES.flatMap((table) => [`${table}_no_update`, `${table}_no_delete`]),
  "studio_continuity_heads_guard_update",
  "studio_continuity_heads_no_delete",
  "studio_continuity_conflict_heads_guard_update",
  "studio_continuity_conflict_heads_no_delete",
] as const;

const REQUIRED_INDEXES = [
  "studio_continuity_entry_anchor_idx",
  "studio_continuity_entry_head_idx",
  "studio_continuity_conflict_anchor_idx",
] as const;

function ensureContinuitySchema(db: DatabaseSync): void {
  runTransaction(db, () => {
    const marker = db.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key = ?")
      .get(CONTINUITY_SCHEMA_MARKER) as { value?: string } | undefined;
    if (marker) {
      if (marker.value !== String(CONTINUITY_SCHEMA_VERSION)) {
        fail("storage-invalid", `不支持的 continuity schema marker：${marker.value ?? "缺失"}。`);
      }
      return;
    }
    const existing = db.prepare(
      "SELECT type, name FROM sqlite_master WHERE name GLOB 'studio_continuity_*' ORDER BY type, name",
    ).all() as unknown as Array<{ type: string; name: string }>;
    if (existing.length > 0) {
      fail(
        "storage-invalid",
        "continuity marker 缺失但已有连续性 schema 对象，禁止猜测或静默修复。",
        existing.map((item) => `${item.type}:${item.name}`),
      );
    }
    createContinuitySchema(db);
    db.prepare("INSERT INTO studio_generation_ledger_meta(key, value) VALUES(?, ?)")
      .run(CONTINUITY_SCHEMA_MARKER, String(CONTINUITY_SCHEMA_VERSION));
  });
}

function assertContinuitySchema(db: DatabaseSync): void {
  const marker = db.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key = ?")
    .get(CONTINUITY_SCHEMA_MARKER) as { value?: string } | undefined;
  if (marker?.value !== String(CONTINUITY_SCHEMA_VERSION)) {
    fail("storage-invalid", `continuity schema marker 无效：${marker?.value ?? "缺失"}。`);
  }
  const actualTables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'studio_continuity_*' ORDER BY name",
  ).all() as unknown as Array<{ name: string }>).map((row) => row.name);
  const expectedTables = [...CONTINUITY_TABLES].sort((left, right) => left.localeCompare(right, "en"));
  if (actualTables.length !== expectedTables.length
    || expectedTables.some((table, index) => actualTables[index] !== table)) {
    fail("storage-invalid", "continuity tables 与 schema v1 不一致。", [
      `expected=${expectedTables.join(",")}`,
      `actual=${actualTables.join(",")}`,
    ]);
  }
  for (const table of CONTINUITY_TABLES) {
    const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>)
      .map((column) => column.name);
    const expected = EXPECTED_COLUMNS[table];
    if (actual.length !== expected.length || expected.some((column, index) => actual[index] !== column)) {
      fail("storage-invalid", `continuity table ${table} 列定义与 schema v1 不一致。`);
    }
  }
  for (const trigger of REQUIRED_TRIGGERS) {
    if (!schemaObjectExists(db, trigger, "trigger")) fail("storage-invalid", `continuity trigger ${trigger} 缺失。`);
  }
  for (const index of REQUIRED_INDEXES) {
    if (!schemaObjectExists(db, index, "index")) fail("storage-invalid", `continuity index ${index} 缺失。`);
  }
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) fail("storage-invalid", "continuity ledger 存在外键孤儿。 ");
  const integrity = db.prepare("PRAGMA integrity_check").all() as unknown as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    fail("storage-invalid", "continuity ledger SQLite integrity_check 失败。", integrity.map((item) => item.integrity_check));
  }
}

function openContinuityDatabase(databasePath: string, initialize: boolean): DatabaseSync {
  const db = new DatabaseSync(databasePath, { timeout: BUSY_TIMEOUT_MILLISECONDS });
  try {
    db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MILLISECONDS}; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;`);
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    if (journal?.journal_mode?.toLowerCase() !== "wal") {
      fail("storage-invalid", "continuity 必须复用 WAL 模式的 studio generation ledger。 ");
    }
    if (!tableExists(db, "studio_generation_ledger_meta")) {
      fail("storage-invalid", "studio generation ledger meta 缺失，禁止建立独立 continuity 存储。 ");
    }
    const schemaCacheKey = studioRequestSqliteValidationKey(
      `studio-continuity-schema-v${CONTINUITY_SCHEMA_VERSION}`,
      databasePath,
    );
    if (hasStudioRequestSchemaValidation(schemaCacheKey)) {
      const marker = db.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key = ?")
        .get(CONTINUITY_SCHEMA_MARKER) as { value?: string } | undefined;
      const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
      if (marker?.value !== String(CONTINUITY_SCHEMA_VERSION)) {
        fail("storage-invalid", `continuity schema marker 已漂移：${marker?.value ?? "缺失"}。`);
      }
      if (foreignKeys?.foreign_keys !== 1) {
        fail("storage-invalid", "continuity foreign_keys 已漂移。");
      }
      if (!isStudioRequestSqliteValidationUnchanged(
        schemaCacheKey,
        `studio-continuity-schema-v${CONTINUITY_SCHEMA_VERSION}`,
        databasePath,
      )) {
        fail("storage-invalid", "continuity ledger 在 schema cache-hit 复核期间发生 SQLite 身份漂移。");
      }
      return db;
    }
    if (initialize) ensureContinuitySchema(db);
    const stableValidationKey = studioRequestSqliteValidationKey(
      `studio-continuity-schema-v${CONTINUITY_SCHEMA_VERSION}`,
      databasePath,
    );
    assertContinuitySchema(db);
    if (!markStudioRequestSqliteValidationIfUnchanged(
      stableValidationKey,
      `studio-continuity-schema-v${CONTINUITY_SCHEMA_VERSION}`,
      databasePath,
    )) {
      fail("storage-invalid", "continuity ledger 在最终 schema 深验期间发生 SQLite 身份漂移。");
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function entryRowById(db: DatabaseSync, entryId: string): EntryRow | undefined {
  return db.prepare("SELECT * FROM studio_continuity_entries WHERE entry_id = ?")
    .get(entryId) as unknown as EntryRow | undefined;
}

function headRowByKey(db: DatabaseSync, headKey: string): HeadRow | undefined {
  return db.prepare("SELECT * FROM studio_continuity_heads WHERE head_key = ?")
    .get(headKey) as unknown as HeadRow | undefined;
}

function conflictRowById(db: DatabaseSync, conflictId: string): ConflictRow | undefined {
  return db.prepare("SELECT * FROM studio_continuity_conflicts WHERE conflict_id = ?")
    .get(conflictId) as unknown as ConflictRow | undefined;
}

function conflictHeadRowById(db: DatabaseSync, conflictId: string): ConflictHeadRow | undefined {
  return db.prepare("SELECT * FROM studio_continuity_conflict_heads WHERE conflict_id = ?")
    .get(conflictId) as unknown as ConflictHeadRow | undefined;
}

function operationReceiptRow(db: DatabaseSync, operationId: string): OperationReceiptRow | undefined {
  return db.prepare("SELECT * FROM studio_continuity_operation_receipts WHERE operation_id = ?")
    .get(operationId) as unknown as OperationReceiptRow | undefined;
}

function entryFromRowUnchecked(row: EntryRow): StudioContinuityEntry {
  const provenance = parseStoredJson(row.provenance_json, `continuity entry ${row.entry_id} provenance`);
  const resolvesConflictIds = parseStoredJson(
    row.resolves_conflict_ids_json,
    `continuity entry ${row.entry_id} resolvesConflictIds`,
  );
  if (!Array.isArray(provenance) || !Array.isArray(resolvesConflictIds)) {
    fail("storage-invalid", `continuity entry ${row.entry_id} 的 JSON 数组字段无效。`);
  }
  const state = row.state_status === "resolved"
    ? { status: row.state_status, value: row.state_value, provenance }
    : { status: row.state_status, reason: row.state_reason, provenance };
  const draft = normalizeStudioContinuityEntryDraft({
    entryKind: row.entry_kind,
    scope: {
      kind: row.scope_kind,
      scopeId: row.scope_id,
      unitId: row.unit_id,
      unitRevision: Number(row.unit_revision),
      startMilliseconds: Number(row.start_ms),
      endMilliseconds: Number(row.end_ms),
    },
    subjectId: row.subject_id,
    field: row.field,
    state: state as StudioContinuityFieldStateInput,
    ...(row.supersedes_entry_id === null ? {} : { supersedesEntryId: row.supersedes_entry_id }),
    resolvesConflictIds: resolvesConflictIds as string[],
  });
  if (draft.id !== row.entry_id
    || draft.fingerprint !== row.fingerprint
    || draft.headKey !== row.head_key
    || draft.state.fingerprint !== row.state_fingerprint
    || !Number.isSafeInteger(Number(row.sequence))
    || Number(row.sequence) < 1
    || !timestampIsValid(row.created_at)) {
    fail("storage-invalid", `continuity entry ${row.entry_id} 内容地址或元数据无效。`);
  }
  return { ...draft, sequence: Number(row.sequence), createdAt: row.created_at };
}

function entryFromRow(row: EntryRow): StudioContinuityEntry {
  try {
    return entryFromRowUnchecked(row);
  } catch (error) {
    if (error instanceof StudioContinuityLedgerError && error.code === "storage-invalid") throw error;
    throw new StudioContinuityLedgerError(
      "storage-invalid",
      `continuity entry ${row.entry_id} 无法重建。`,
      [error instanceof Error ? error.message : String(error)],
      { cause: error },
    );
  }
}

function requiredEntry(db: DatabaseSync, entryId: string): StudioContinuityEntry {
  const row = entryRowById(db, entryId);
  if (!row) fail("storage-invalid", `continuity entry ${entryId} 缺失。`);
  return entryFromRow(row);
}

function headFromStoredEntry(row: HeadRow, entry: StudioContinuityEntry): StudioContinuityHead {
  if (entry.headKey !== row.head_key
    || !Number.isSafeInteger(Number(row.revision))
    || Number(row.revision) < 1
    || !timestampIsValid(row.updated_at)) {
    fail("storage-invalid", `continuity head ${row.head_key} 投影无效。`);
  }
  return {
    headKey: row.head_key,
    revision: Number(row.revision),
    entry,
    updatedAt: row.updated_at,
  };
}

function headFromRow(db: DatabaseSync, row: HeadRow): StudioContinuityHead {
  return headFromStoredEntry(row, requiredEntry(db, row.entry_id));
}

function requiredHead(db: DatabaseSync, headKey: string): StudioContinuityHead {
  const row = headRowByKey(db, headKey);
  if (!row) fail("storage-invalid", `continuity head ${headKey} 缺失。`);
  return headFromRow(db, row);
}

function conflictResolutionIdentity(input: {
  conflictId: string;
  correctionEntryId: string;
  expectedConflictRevision: number;
}): { id: string; fingerprint: string } {
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-continuity-conflict-resolution" as const,
    ...input,
  };
  const fingerprint = studioContinuityDigest(semantic);
  return {
    id: `studio-continuity-resolution-${fingerprint.slice(0, 40)}`,
    fingerprint,
  };
}

function conflictFromRows(
  db: DatabaseSync,
  row: ConflictRow,
  headRow: ConflictHeadRow,
): StudioContinuityConflict {
  const leftEntry = requiredEntry(db, row.left_entry_id);
  const rightEntry = requiredEntry(db, row.right_entry_id);
  let draft;
  try {
    draft = createStudioContinuityConflictDraft(leftEntry, rightEntry);
  } catch (error) {
    throw new StudioContinuityLedgerError(
      "storage-invalid",
      `continuity conflict ${row.conflict_id} 不再代表重叠异值。`,
      [error instanceof Error ? error.message : String(error)],
      { cause: error },
    );
  }
  if (draft.id !== row.conflict_id
    || draft.fingerprint !== row.fingerprint
    || draft.scopeAnchor.kind !== row.scope_kind
    || draft.scopeAnchor.scopeId !== row.scope_id
    || draft.scopeAnchor.unitId !== row.unit_id
    || draft.scopeAnchor.unitRevision !== Number(row.unit_revision)
    || draft.subjectId !== row.subject_id
    || draft.field !== row.field
    || draft.overlapStartMilliseconds !== Number(row.overlap_start_ms)
    || draft.overlapEndMilliseconds !== Number(row.overlap_end_ms)
    || draft.leftEntryId !== row.left_entry_id
    || draft.rightEntryId !== row.right_entry_id
    || headRow.conflict_id !== row.conflict_id
    || !Number.isSafeInteger(Number(row.sequence))
    || Number(row.sequence) < 1
    || !timestampIsValid(row.created_at)
    || !timestampIsValid(headRow.updated_at)) {
    fail("storage-invalid", `continuity conflict ${row.conflict_id} 内容地址或投影无效。`);
  }
  if (headRow.status === "open") {
    if (Number(headRow.revision) !== 1 || headRow.resolution_id !== null) {
      fail("storage-invalid", `open continuity conflict ${row.conflict_id} revision 无效。`);
    }
  } else if (headRow.status === "resolved") {
    if (Number(headRow.revision) !== 2 || !headRow.resolution_id) {
      fail("storage-invalid", `resolved continuity conflict ${row.conflict_id} revision 无效。`);
    }
    const resolution = db.prepare("SELECT * FROM studio_continuity_conflict_resolutions WHERE resolution_id = ?")
      .get(headRow.resolution_id) as unknown as ConflictResolutionRow | undefined;
    if (!resolution || resolution.conflict_id !== row.conflict_id || !timestampIsValid(resolution.created_at)) {
      fail("storage-invalid", `continuity conflict ${row.conflict_id} resolution 证据缺失。`);
    }
    const identity = conflictResolutionIdentity({
      conflictId: resolution.conflict_id,
      correctionEntryId: resolution.correction_entry_id,
      expectedConflictRevision: Number(resolution.expected_conflict_revision),
    });
    const correction = requiredEntry(db, resolution.correction_entry_id);
    if (identity.id !== resolution.resolution_id
      || identity.fingerprint !== resolution.fingerprint
      || correction.entryKind !== "correction"
      || !correction.resolvesConflictIds.includes(row.conflict_id)) {
      fail("storage-invalid", `continuity conflict ${row.conflict_id} resolution 内容地址无效。`);
    }
  } else {
    fail("storage-invalid", `continuity conflict ${row.conflict_id} status 无效。`);
  }
  return {
    schemaVersion: 1,
    kind: "studio-continuity-conflict",
    id: draft.id,
    fingerprint: draft.fingerprint,
    revision: Number(headRow.revision),
    status: headRow.status,
    scopeAnchor: draft.scopeAnchor,
    subjectId: draft.subjectId,
    field: draft.field,
    overlapStartMilliseconds: draft.overlapStartMilliseconds,
    overlapEndMilliseconds: draft.overlapEndMilliseconds,
    leftEntry,
    rightEntry,
    ...(headRow.resolution_id === null ? {} : { resolutionId: headRow.resolution_id }),
    createdAt: row.created_at,
    updatedAt: headRow.updated_at,
  };
}

function conflictFromRow(db: DatabaseSync, row: ConflictRow): StudioContinuityConflict {
  const head = conflictHeadRowById(db, row.conflict_id);
  if (!head) fail("storage-invalid", `continuity conflict ${row.conflict_id} head 缺失。`);
  return conflictFromRows(db, row, head);
}

function conflictAtCreation(db: DatabaseSync, row: ConflictRow): StudioContinuityConflict {
  const current = conflictFromRow(db, row);
  return {
    ...current,
    revision: 1,
    status: "open",
    resolutionId: undefined,
    updatedAt: current.createdAt,
  };
}

function insertEntry(
  db: DatabaseSync,
  draft: ReturnType<typeof normalizeStudioContinuityEntryDraft>,
  createdAt: string,
): StudioContinuityEntry {
  const existing = entryRowById(db, draft.id);
  if (existing) {
    const entry = entryFromRow(existing);
    if (entry.fingerprint !== draft.fingerprint) {
      fail("storage-invalid", `continuity entry id ${draft.id} 发生内容地址碰撞。`);
    }
    return entry;
  }
  try {
    db.prepare(`
      INSERT INTO studio_continuity_entries(
        entry_id, fingerprint, entry_kind, head_key,
        scope_kind, scope_id, unit_id, unit_revision, start_ms, end_ms,
        subject_id, field, state_status, state_value, state_reason, state_fingerprint,
        provenance_json, supersedes_entry_id, resolves_conflict_ids_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      draft.id,
      draft.fingerprint,
      draft.entryKind,
      draft.headKey,
      draft.scope.kind,
      draft.scope.scopeId,
      draft.scope.unitId,
      draft.scope.unitRevision,
      draft.scope.startMilliseconds,
      draft.scope.endMilliseconds,
      draft.subjectId,
      draft.field,
      draft.state.status,
      draft.state.status === "resolved" ? draft.state.value : null,
      draft.state.status === "resolved" ? null : draft.state.reason,
      draft.state.fingerprint,
      JSON.stringify(draft.state.provenance),
      draft.supersedesEntryId ?? null,
      JSON.stringify(draft.resolvesConflictIds),
      createdAt,
    );
  } catch (error) {
    throw new StudioContinuityLedgerError(
      "storage-invalid",
      `continuity entry ${draft.id} 无法追加。`,
      [error instanceof Error ? error.message : String(error)],
      { cause: error },
    );
  }
  return requiredEntry(db, draft.id);
}

function insertConflict(
  db: DatabaseSync,
  left: StudioContinuityEntry,
  right: StudioContinuityEntry,
  createdAt: string,
): { conflict: StudioContinuityConflict; created: boolean } {
  const draft = createStudioContinuityConflictDraft(left, right);
  const existing = conflictRowById(db, draft.id);
  if (existing) {
    const conflict = conflictFromRow(db, existing);
    if (conflict.status !== "open") {
      fail("storage-invalid", `已解决 conflict ${conflict.id} 的同一对 entry 再次成为当前异值。`);
    }
    return { conflict, created: false };
  }
  db.prepare(`
    INSERT INTO studio_continuity_conflicts(
      conflict_id, fingerprint, scope_kind, scope_id, unit_id, unit_revision,
      subject_id, field, overlap_start_ms, overlap_end_ms, left_entry_id, right_entry_id, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    draft.id,
    draft.fingerprint,
    draft.scopeAnchor.kind,
    draft.scopeAnchor.scopeId,
    draft.scopeAnchor.unitId,
    draft.scopeAnchor.unitRevision,
    draft.subjectId,
    draft.field,
    draft.overlapStartMilliseconds,
    draft.overlapEndMilliseconds,
    draft.leftEntryId,
    draft.rightEntryId,
    createdAt,
  );
  db.prepare(`
    INSERT INTO studio_continuity_conflict_heads(conflict_id, revision, status, resolution_id, updated_at)
    VALUES(?, 1, 'open', NULL, ?)
  `).run(draft.id, createdAt);
  return { conflict: conflictFromRow(db, conflictRowById(db, draft.id)!), created: true };
}

function detectAndPersistConflicts(
  db: DatabaseSync,
  entry: StudioContinuityEntry,
  createdAt: string,
): StudioContinuityConflict[] {
  const created: StudioContinuityConflict[] = [];
  const candidateRows = db.prepare(`
    SELECT e.*
    FROM studio_continuity_entries e
    JOIN studio_continuity_heads h ON h.entry_id = e.entry_id
    WHERE e.scope_kind = ?
      AND e.scope_id = ?
      AND e.unit_id = ?
      AND e.unit_revision = ?
      AND e.subject_id = ?
      AND e.field = ?
      AND e.start_ms < ?
      AND ? < e.end_ms
      AND e.entry_id <> ?
    ORDER BY e.head_key
  `).all(
    entry.scope.kind,
    entry.scope.scopeId,
    entry.scope.unitId,
    entry.scope.unitRevision,
    entry.subjectId,
    entry.field,
    entry.scope.endMilliseconds,
    entry.scope.startMilliseconds,
    entry.id,
  ) as unknown as EntryRow[];
  for (const row of candidateRows) {
    const candidate = entryFromRow(row);
    if (!studioContinuityEntriesConflict(entry, candidate)) continue;
    const inserted = insertConflict(db, entry, candidate, createdAt);
    if (inserted.created) created.push(inserted.conflict);
  }
  return created.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function openConflictRowsForHead(db: DatabaseSync, headKey: string): ConflictRow[] {
  return db.prepare(`
    SELECT DISTINCT c.*
    FROM studio_continuity_conflicts c
    JOIN studio_continuity_conflict_heads ch ON ch.conflict_id = c.conflict_id
    JOIN studio_continuity_entries le ON le.entry_id = c.left_entry_id
    JOIN studio_continuity_entries re ON re.entry_id = c.right_entry_id
    WHERE ch.status = 'open' AND (le.head_key = ? OR re.head_key = ?)
    ORDER BY c.conflict_id
  `).all(headKey, headKey) as unknown as ConflictRow[];
}

function normalizeConflictExpectations(
  input: StudioContinuityExpectedConflictRevision[] | undefined,
): StudioContinuityExpectedConflictRevision[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 1_000) {
    fail("invalid-input", "resolvesConflicts 最多 1000 项。 ");
  }
  const normalized = input.map((item, index) => {
    if (!item || typeof item !== "object") fail("invalid-input", `resolvesConflicts[${index}] 结构无效。`);
    return {
      conflictId: asInvalidInput(() => normalizeStudioContinuityStableId(item.conflictId, `resolvesConflicts[${index}].conflictId`)),
      expectedRevision: requiredPositiveRevision(item.expectedRevision, `resolvesConflicts[${index}].expectedRevision`),
    };
  }).sort((left, right) => left.conflictId.localeCompare(right.conflictId, "en"));
  if (new Set(normalized.map((item) => item.conflictId)).size !== normalized.length) {
    fail("invalid-input", "resolvesConflicts 不能重复。 ");
  }
  return normalized;
}

function resolveConflicts(
  db: DatabaseSync,
  correction: StudioContinuityEntry,
  expectations: StudioContinuityExpectedConflictRevision[],
  createdAt: string,
): string[] {
  const resolved: string[] = [];
  for (const expectation of expectations) {
    const conflictRow = conflictRowById(db, expectation.conflictId);
    const conflictHead = conflictHeadRowById(db, expectation.conflictId);
    if (!conflictRow || !conflictHead) {
      fail("conflict-not-found", `continuity conflict ${expectation.conflictId} 不存在。`);
    }
    conflictFromRows(db, conflictRow, conflictHead);
    if (conflictHead.status !== "open" || Number(conflictHead.revision) !== expectation.expectedRevision) {
      throw new StudioContinuityLedgerError(
        "conflict-state-conflict",
        `continuity conflict ${expectation.conflictId} 已变化：期望 open revision=${expectation.expectedRevision}，实际 ${conflictHead.status} revision=${conflictHead.revision}。`,
      );
    }
    const identity = conflictResolutionIdentity({
      conflictId: expectation.conflictId,
      correctionEntryId: correction.id,
      expectedConflictRevision: expectation.expectedRevision,
    });
    db.prepare(`
      INSERT INTO studio_continuity_conflict_resolutions(
        resolution_id, fingerprint, conflict_id, correction_entry_id, expected_conflict_revision, created_at
      ) VALUES(?, ?, ?, ?, ?, ?)
    `).run(
      identity.id,
      identity.fingerprint,
      expectation.conflictId,
      correction.id,
      expectation.expectedRevision,
      createdAt,
    );
    const update = db.prepare(`
      UPDATE studio_continuity_conflict_heads
      SET revision = revision + 1, status = 'resolved', resolution_id = ?, updated_at = ?
      WHERE conflict_id = ? AND revision = ? AND status = 'open'
    `).run(identity.id, createdAt, expectation.conflictId, expectation.expectedRevision);
    if (Number(update.changes) !== 1) {
      throw new StudioContinuityLedgerError(
        "conflict-state-conflict",
        `continuity conflict ${expectation.conflictId} 的 CAS 失败。`,
      );
    }
    resolved.push(expectation.conflictId);
  }
  return resolved;
}

function receiptIdentity(input: {
  operationId: string;
  command: StudioContinuityWriteResult["command"];
  requestFingerprint: string;
  entryId: string;
  outcome: OperationOutcome;
}): { id: string; fingerprint: string } {
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-continuity-operation-receipt" as const,
    ...input,
  };
  const fingerprint = studioContinuityDigest(semantic);
  return { id: `studio-continuity-receipt-${fingerprint.slice(0, 40)}`, fingerprint };
}

function normalizeStoredOutcome(value: unknown, row: OperationReceiptRow): OperationOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("storage-invalid", `continuity receipt ${row.receipt_id} outcome 结构无效。`);
  }
  const raw = value as Record<string, unknown>;
  const createdConflictIds = raw.createdConflictIds;
  const resolvedConflictIds = raw.resolvedConflictIds;
  if (raw.schemaVersion !== 1
    || raw.kind !== "studio-continuity-operation-outcome"
    || raw.command !== row.command
    || !Array.isArray(createdConflictIds)
    || !Array.isArray(resolvedConflictIds)
    || !Number.isSafeInteger(raw.headRevision)
    || Number(raw.headRevision) < 1
    || !timestampIsValid(String(raw.headUpdatedAt))) {
    fail("storage-invalid", `continuity receipt ${row.receipt_id} outcome 字段无效。`);
  }
  let normalized: OperationOutcome;
  try {
    normalized = {
      schemaVersion: 1,
      kind: "studio-continuity-operation-outcome",
      command: row.command,
      entryId: normalizeStudioContinuityStableId(raw.entryId, "outcome.entryId"),
      headKey: normalizeStudioContinuityStableId(raw.headKey, "outcome.headKey"),
      headRevision: Number(raw.headRevision),
      headEntryId: normalizeStudioContinuityStableId(raw.headEntryId, "outcome.headEntryId"),
      headUpdatedAt: String(raw.headUpdatedAt),
      createdConflictIds: (createdConflictIds as unknown[])
        .map((item) => normalizeStudioContinuityStableId(item, "outcome.createdConflictId")),
      resolvedConflictIds: (resolvedConflictIds as unknown[])
        .map((item) => normalizeStudioContinuityStableId(item, "outcome.resolvedConflictId")),
    };
  } catch (error) {
    throw new StudioContinuityLedgerError(
      "storage-invalid",
      `continuity receipt ${row.receipt_id} outcome ID 无效。`,
      [error instanceof Error ? error.message : String(error)],
      { cause: error },
    );
  }
  for (const ids of [normalized.createdConflictIds, normalized.resolvedConflictIds]) {
    if (new Set(ids).size !== ids.length
      || [...ids].sort((left, right) => left.localeCompare(right, "en")).some((id, index) => id !== ids[index])) {
      fail("storage-invalid", `continuity receipt ${row.receipt_id} outcome conflict IDs 无效。`);
    }
  }
  return normalized;
}

function resultFingerprint(input: {
  command: StudioContinuityWriteResult["command"];
  operationId: string;
  receiptId: string;
  requestFingerprint: string;
  outcome: OperationOutcome;
}): string {
  return studioContinuityDigest({
    schemaVersion: 1,
    kind: "studio-continuity-write-result",
    ...input,
  });
}

function resultFromReceipt(db: DatabaseSync, row: OperationReceiptRow, replayed: boolean): StudioContinuityWriteResult {
  const outcome = normalizeStoredOutcome(parseStoredJson(row.outcome_json, `continuity receipt ${row.receipt_id} outcome`), row);
  const entry = requiredEntry(db, row.entry_id);
  const headEntry = requiredEntry(db, outcome.headEntryId);
  const createdConflicts = outcome.createdConflictIds.map((conflictId) => {
    const conflictRow = conflictRowById(db, conflictId);
    if (!conflictRow) fail("storage-invalid", `continuity receipt ${row.receipt_id} 引用的 conflict ${conflictId} 缺失。`);
    return conflictAtCreation(db, conflictRow);
  });
  for (const conflictId of outcome.resolvedConflictIds) {
    const conflict = conflictRowById(db, conflictId);
    const head = conflictHeadRowById(db, conflictId);
    if (!conflict || !head || conflictFromRows(db, conflict, head).status !== "resolved") {
      fail("storage-invalid", `continuity receipt ${row.receipt_id} 的已解决 conflict ${conflictId} 无效。`);
    }
  }
  if (outcome.entryId !== row.entry_id
    || entry.id !== row.entry_id
    || outcome.headKey !== headEntry.headKey
    || !Number.isSafeInteger(Number(row.sequence))
    || Number(row.sequence) < 1
    || !timestampIsValid(row.created_at)) {
    fail("storage-invalid", `continuity receipt ${row.receipt_id} outcome 与 entry/head 不一致。`);
  }
  let operationId: string;
  try {
    operationId = normalizeStudioContinuityStableId(row.operation_id, "stored operationId");
  } catch (error) {
    throw new StudioContinuityLedgerError(
      "storage-invalid",
      `continuity receipt ${row.receipt_id} operationId 无效。`,
      [error instanceof Error ? error.message : String(error)],
      { cause: error },
    );
  }
  const identity = receiptIdentity({
    operationId,
    command: row.command,
    requestFingerprint: row.request_fingerprint,
    entryId: row.entry_id,
    outcome,
  });
  if (identity.id !== row.receipt_id
    || identity.fingerprint !== row.fingerprint
    || !/^[a-f0-9]{64}$/u.test(row.request_fingerprint)) {
    fail("storage-invalid", `continuity receipt ${row.receipt_id} 内容地址无效。`);
  }
  return {
    schemaVersion: 1,
    kind: "studio-continuity-write-result",
    command: row.command,
    operationId,
    receiptId: row.receipt_id,
    requestFingerprint: row.request_fingerprint,
    applied: true,
    replayed,
    entry,
    head: {
      headKey: outcome.headKey,
      revision: outcome.headRevision,
      entry: headEntry,
      updatedAt: outcome.headUpdatedAt,
    },
    createdConflicts,
    resolvedConflictIds: outcome.resolvedConflictIds,
    fingerprint: resultFingerprint({
      command: row.command,
      operationId,
      receiptId: row.receipt_id,
      requestFingerprint: row.request_fingerprint,
      outcome,
    }),
  };
}

function validateStoredReceiptFromIndexes(
  row: OperationReceiptRow,
  entryById: Map<string, StudioContinuityEntry>,
  conflictById: Map<string, StudioContinuityConflict>,
): void {
  const outcome = normalizeStoredOutcome(
    parseStoredJson(row.outcome_json, `continuity receipt ${row.receipt_id} outcome`),
    row,
  );
  const entry = entryById.get(row.entry_id);
  const headEntry = entryById.get(outcome.headEntryId);
  if (!entry) fail("storage-invalid", `continuity receipt ${row.receipt_id} 引用的 entry ${row.entry_id} 缺失。`);
  if (!headEntry) {
    fail("storage-invalid", `continuity receipt ${row.receipt_id} 引用的 head entry ${outcome.headEntryId} 缺失。`);
  }
  for (const conflictId of outcome.createdConflictIds) {
    if (!conflictById.has(conflictId)) {
      fail("storage-invalid", `continuity receipt ${row.receipt_id} 引用的 conflict ${conflictId} 缺失。`);
    }
  }
  for (const conflictId of outcome.resolvedConflictIds) {
    const conflict = conflictById.get(conflictId);
    if (!conflict || conflict.status !== "resolved") {
      fail("storage-invalid", `continuity receipt ${row.receipt_id} 的已解决 conflict ${conflictId} 无效。`);
    }
  }
  if (outcome.entryId !== row.entry_id
    || entry.id !== row.entry_id
    || outcome.headKey !== headEntry.headKey
    || !Number.isSafeInteger(Number(row.sequence))
    || Number(row.sequence) < 1
    || !timestampIsValid(row.created_at)) {
    fail("storage-invalid", `continuity receipt ${row.receipt_id} outcome 与 entry/head 不一致。`);
  }
  let operationId: string;
  try {
    operationId = normalizeStudioContinuityStableId(row.operation_id, "stored operationId");
  } catch (error) {
    throw new StudioContinuityLedgerError(
      "storage-invalid",
      `continuity receipt ${row.receipt_id} operationId 无效。`,
      [error instanceof Error ? error.message : String(error)],
      { cause: error },
    );
  }
  const identity = receiptIdentity({
    operationId,
    command: row.command,
    requestFingerprint: row.request_fingerprint,
    entryId: row.entry_id,
    outcome,
  });
  if (identity.id !== row.receipt_id
    || identity.fingerprint !== row.fingerprint
    || !/^[a-f0-9]{64}$/u.test(row.request_fingerprint)) {
    fail("storage-invalid", `continuity receipt ${row.receipt_id} 内容地址无效。`);
  }
}

function insertReceipt(
  db: DatabaseSync,
  input: {
    operationId: string;
    command: StudioContinuityWriteResult["command"];
    requestFingerprint: string;
    entryId: string;
    outcome: OperationOutcome;
    createdAt: string;
  },
): StudioContinuityWriteResult {
  const identity = receiptIdentity({
    operationId: input.operationId,
    command: input.command,
    requestFingerprint: input.requestFingerprint,
    entryId: input.entryId,
    outcome: input.outcome,
  });
  db.prepare(`
    INSERT INTO studio_continuity_operation_receipts(
      operation_id, receipt_id, command, request_fingerprint, entry_id, outcome_json, fingerprint, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.operationId,
    identity.id,
    input.command,
    input.requestFingerprint,
    input.entryId,
    JSON.stringify(input.outcome),
    identity.fingerprint,
    input.createdAt,
  );
  return resultFromReceipt(db, operationReceiptRow(db, input.operationId)!, false);
}

function replayOrConflict(
  db: DatabaseSync,
  operationId: string,
  command: StudioContinuityWriteResult["command"],
  requestFingerprint: string,
): StudioContinuityWriteResult | undefined {
  const existing = operationReceiptRow(db, operationId);
  if (!existing) return undefined;
  if (existing.command !== command || existing.request_fingerprint !== requestFingerprint) {
    throw new StudioContinuityLedgerError(
      "operation-conflict",
      `operationId=${operationId} 已绑定其他 continuity 请求，禁止同键换载荷。`,
      [
        `existingCommand=${existing.command}`,
        `existingRequestFingerprint=${existing.request_fingerprint}`,
        `requestedCommand=${command}`,
        `requestedFingerprint=${requestFingerprint}`,
      ],
    );
  }
  return resultFromReceipt(db, existing, true);
}

function requestFingerprint(input: {
  command: StudioContinuityWriteResult["command"];
  expectedHeadRevision: number;
  entryFingerprint: string;
  conflictExpectations?: StudioContinuityExpectedConflictRevision[];
}): string {
  return studioContinuityDigest({ schemaVersion: 1, kind: "studio-continuity-request", ...input });
}

function assertHeadRevision(actual: HeadRow | undefined, headKey: string, expectedRevision: number): void {
  const actualRevision = actual ? Number(actual.revision) : 0;
  if (actualRevision !== expectedRevision) {
    throw new StudioContinuityHeadConflictError(headKey, expectedRevision, actualRevision);
  }
}

async function databaseForProject(projectRoot: string): Promise<{ databasePath: string; db: DatabaseSync }> {
  const state = await initializeStudioContinuityLedger(projectRoot);
  return { databasePath: state.databasePath, db: openContinuityDatabase(state.databasePath, false) };
}

interface PreparedStudioContinuityObservation {
  operationId: string;
  expectedHeadRevision: number;
  draft: ReturnType<typeof normalizeStudioContinuityEntryDraft>;
  requestFingerprint: string;
}

function prepareStudioContinuityObservation(input: AppendStudioContinuityObservationInput): PreparedStudioContinuityObservation {
  const operationId = normalizeOperationId(input.operationId);
  const expectedHeadRevision = requiredNonNegativeRevision(input.expectedHeadRevision, "expectedHeadRevision");
  const draft = asInvalidInput(() => normalizeStudioContinuityEntryDraft({
    entryKind: "observation",
    scope: input.scope,
    subjectId: input.subjectId,
    field: input.field,
    state: input.state,
  }));
  const request = requestFingerprint({
    command: "append-observation",
    expectedHeadRevision,
    entryFingerprint: draft.fingerprint,
  });
  return { operationId, expectedHeadRevision, draft, requestFingerprint: request };
}

function appendPreparedStudioContinuityObservation(
  db: DatabaseSync,
  prepared: PreparedStudioContinuityObservation,
): StudioContinuityWriteResult {
  const { operationId, expectedHeadRevision, draft, requestFingerprint: fingerprint } = prepared;
  const replay = replayOrConflict(db, operationId, "append-observation", fingerprint);
  if (replay) return replay;
  const existingHeadRow = headRowByKey(db, draft.headKey);
  assertHeadRevision(existingHeadRow, draft.headKey, expectedHeadRevision);
  const createdAt = new Date().toISOString();
  const entry = insertEntry(db, draft, createdAt);
  if (!existingHeadRow) {
    db.prepare(`
      INSERT INTO studio_continuity_heads(head_key, revision, entry_id, updated_at)
      VALUES(?, 1, ?, ?)
    `).run(draft.headKey, entry.id, createdAt);
  } else {
    const current = headFromRow(db, existingHeadRow);
    if (current.entry.id !== entry.id && studioContinuityStatesEqual(current.entry.state, entry.state)) {
      const update = db.prepare(`
        UPDATE studio_continuity_heads
        SET revision = revision + 1, entry_id = ?, updated_at = ?
        WHERE head_key = ? AND revision = ? AND entry_id = ?
      `).run(entry.id, createdAt, draft.headKey, expectedHeadRevision, current.entry.id);
      if (Number(update.changes) !== 1) {
        throw new StudioContinuityHeadConflictError(draft.headKey, expectedHeadRevision, Number(existingHeadRow.revision));
      }
    }
  }
  const createdConflicts = detectAndPersistConflicts(db, entry, createdAt);
  const head = requiredHead(db, draft.headKey);
  const outcome: OperationOutcome = {
    schemaVersion: 1,
    kind: "studio-continuity-operation-outcome",
    command: "append-observation",
    entryId: entry.id,
    headKey: head.headKey,
    headRevision: head.revision,
    headEntryId: head.entry.id,
    headUpdatedAt: head.updatedAt,
    createdConflictIds: createdConflicts.map((conflict) => conflict.id),
    resolvedConflictIds: [],
  };
  return insertReceipt(db, {
    operationId,
    command: "append-observation",
    requestFingerprint: fingerprint,
    entryId: entry.id,
    outcome,
    createdAt,
  });
}

/**
 * 同一 generation-ledger SQLite 内的原子批量追加；每项仍保留独立 operation receipt、
 * expected head CAS 与冲突检测。任一项失败会回滚整个批次，禁止部分成功。
 */
export async function appendStudioContinuityObservations(
  projectRoot: string,
  inputs: AppendStudioContinuityObservationInput[],
): Promise<StudioContinuityWriteResult[]> {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 500) {
    throw new StudioContinuityLedgerError("invalid-input", "continuity observation 批次必须为 1–500 项。 ");
  }
  const prepared = inputs.map(prepareStudioContinuityObservation);
  const operationIds = prepared.map((item) => item.operationId);
  if (new Set(operationIds).size !== operationIds.length) {
    throw new StudioContinuityLedgerError("invalid-input", "continuity observation 批次内 operationId 不能重复。 ");
  }
  const { db } = await databaseForProject(projectRoot);
  try {
    return runTransaction(db, () => prepared.map((item) => appendPreparedStudioContinuityObservation(db, item)));
  } finally {
    db.close();
  }
}

export async function appendStudioContinuityObservation(
  projectRoot: string,
  input: AppendStudioContinuityObservationInput,
): Promise<StudioContinuityWriteResult> {
  return (await appendStudioContinuityObservations(projectRoot, [input]))[0]!;
}

export async function appendStudioContinuityCorrection(
  projectRoot: string,
  input: AppendStudioContinuityCorrectionInput,
): Promise<StudioContinuityWriteResult> {
  const operationId = normalizeOperationId(input.operationId);
  const expectedHeadRevision = requiredPositiveRevision(input.expectedHeadRevision, "expectedHeadRevision");
  const expectations = normalizeConflictExpectations(input.resolvesConflicts);
  const supersedesEntryId = asInvalidInput(() => normalizeStudioContinuityStableId(
    input.supersedesEntryId,
    "supersedesEntryId",
  ));
  const draft = asInvalidInput(() => normalizeStudioContinuityEntryDraft({
    entryKind: "correction",
    scope: input.scope,
    subjectId: input.subjectId,
    field: input.field,
    state: input.state,
    supersedesEntryId,
    resolvesConflictIds: expectations.map((item) => item.conflictId),
  }));
  const fingerprint = requestFingerprint({
    command: "append-correction",
    expectedHeadRevision,
    entryFingerprint: draft.fingerprint,
    conflictExpectations: expectations,
  });
  const { db } = await databaseForProject(projectRoot);
  try {
    return runTransaction(db, () => {
      const replay = replayOrConflict(db, operationId, "append-correction", fingerprint);
      if (replay) return replay;
      const existingHeadRow = headRowByKey(db, draft.headKey);
      assertHeadRevision(existingHeadRow, draft.headKey, expectedHeadRevision);
      if (!existingHeadRow) fail("invalid-input", `correction 对应的 continuity head ${draft.headKey} 不存在。`);
      const current = headFromRow(db, existingHeadRow);
      if (current.entry.id !== supersedesEntryId) {
        throw new StudioContinuityHeadConflictError(draft.headKey, expectedHeadRevision, current.revision);
      }
      const requiredConflictRows = openConflictRowsForHead(db, draft.headKey);
      const requiredIds = requiredConflictRows.map((row) => row.conflict_id);
      const suppliedIds = expectations.map((item) => item.conflictId);
      if (requiredIds.length !== suppliedIds.length
        || requiredIds.some((id, index) => suppliedIds[index] !== id)) {
        throw new StudioContinuityLedgerError(
          "conflict-state-conflict",
          `correction 必须精确解决 head ${draft.headKey} 的全部 open conflicts。`,
          [`required=${requiredIds.join(",")}`, `supplied=${suppliedIds.join(",")}`],
        );
      }
      const createdAt = new Date().toISOString();
      const correction = insertEntry(db, draft, createdAt);
      const update = db.prepare(`
        UPDATE studio_continuity_heads
        SET revision = revision + 1, entry_id = ?, updated_at = ?
        WHERE head_key = ? AND revision = ? AND entry_id = ?
      `).run(correction.id, createdAt, draft.headKey, expectedHeadRevision, current.entry.id);
      if (Number(update.changes) !== 1) {
        throw new StudioContinuityHeadConflictError(draft.headKey, expectedHeadRevision, current.revision);
      }
      const resolvedConflictIds = resolveConflicts(db, correction, expectations, createdAt);
      const createdConflicts = detectAndPersistConflicts(db, correction, createdAt);
      const head = requiredHead(db, draft.headKey);
      const outcome: OperationOutcome = {
        schemaVersion: 1,
        kind: "studio-continuity-operation-outcome",
        command: "append-correction",
        entryId: correction.id,
        headKey: head.headKey,
        headRevision: head.revision,
        headEntryId: head.entry.id,
        headUpdatedAt: head.updatedAt,
        createdConflictIds: createdConflicts.map((conflict) => conflict.id),
        resolvedConflictIds,
      };
      return insertReceipt(db, {
        operationId,
        command: "append-correction",
        requestFingerprint: fingerprint,
        entryId: correction.id,
        outcome,
        createdAt,
      });
    });
  } finally {
    db.close();
  }
}

function validateStoredContents(db: DatabaseSync): void {
  const entryRows = db.prepare("SELECT * FROM studio_continuity_entries ORDER BY sequence")
    .all() as unknown as EntryRow[];
  const entries = entryRows.map(entryFromRow);
  const entryById = new Map(entries.map((entry) => [entry.id, entry] as const));
  for (const entry of entries) {
    if (entry.entryKind !== "correction") continue;
    const superseded = entryById.get(entry.supersedesEntryId!);
    if (!superseded
      || superseded.headKey !== entry.headKey
      || superseded.sequence >= entry.sequence) {
      fail("storage-invalid", `continuity correction ${entry.id} 的 supersedes 链无效。`);
    }
    for (const conflictId of entry.resolvesConflictIds) {
      const resolution = db.prepare(`
        SELECT * FROM studio_continuity_conflict_resolutions
        WHERE conflict_id = ? AND correction_entry_id = ?
      `).get(conflictId, entry.id) as unknown as ConflictResolutionRow | undefined;
      if (!resolution) {
        fail("storage-invalid", `continuity correction ${entry.id} 缺少 conflict ${conflictId} resolution receipt。`);
      }
    }
  }

  const headRows = db.prepare("SELECT * FROM studio_continuity_heads ORDER BY head_key")
    .all() as unknown as HeadRow[];
  const heads = headRows.map((row) => {
    const entry = entryById.get(row.entry_id);
    if (!entry) fail("storage-invalid", `continuity head ${row.head_key} 引用的 entry ${row.entry_id} 缺失。`);
    return headFromStoredEntry(row, entry);
  });
  const conflictRows = db.prepare("SELECT * FROM studio_continuity_conflicts ORDER BY sequence")
    .all() as unknown as ConflictRow[];
  const conflictHeadRows = db.prepare("SELECT * FROM studio_continuity_conflict_heads ORDER BY conflict_id")
    .all() as unknown as ConflictHeadRow[];
  if (conflictRows.length !== conflictHeadRows.length) {
    fail("storage-invalid", "continuity conflicts 与 conflict heads 数量不一致。 ");
  }
  const conflictHeadById = new Map(conflictHeadRows.map((row) => [row.conflict_id, row] as const));
  const conflicts = conflictRows.map((row) => {
    const head = conflictHeadById.get(row.conflict_id);
    if (!head) fail("storage-invalid", `continuity conflict ${row.conflict_id} 缺少 head。`);
    return conflictFromRows(db, row, head);
  });
  const conflictById = new Map(conflicts.map((conflict) => [conflict.id, conflict] as const));
  const resolutionRows = db.prepare("SELECT * FROM studio_continuity_conflict_resolutions ORDER BY sequence")
    .all() as unknown as ConflictResolutionRow[];
  if (resolutionRows.length !== conflicts.filter((conflict) => conflict.status === "resolved").length) {
    fail("storage-invalid", "continuity conflict resolutions 与 resolved heads 数量不一致。 ");
  }

  const openConflictById = new Map(
    conflicts.filter((conflict) => conflict.status === "open").map((conflict) => [conflict.id, conflict] as const),
  );
  const headsByConflictDomain = new Map<string, StudioContinuityHead[]>();
  for (const head of heads) {
    const entry = head.entry;
    const domainKey = JSON.stringify([
      entry.scope.kind,
      entry.scope.scopeId,
      entry.scope.unitId,
      entry.scope.unitRevision,
      entry.subjectId,
      entry.field,
    ]);
    const domain = headsByConflictDomain.get(domainKey) ?? [];
    domain.push(head);
    headsByConflictDomain.set(domainKey, domain);
  }
  for (const domain of headsByConflictDomain.values()) {
    for (let leftIndex = 0; leftIndex < domain.length; leftIndex += 1) {
      const left = domain[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < domain.length; rightIndex += 1) {
        const right = domain[rightIndex]!;
        if (!studioContinuityEntriesConflict(left.entry, right.entry)) continue;
        const draft = createStudioContinuityConflictDraft(left.entry, right.entry);
        if (!openConflictById.has(draft.id)) {
          fail("storage-invalid", `当前连续性异值 ${left.entry.id}/${right.entry.id} 缺少 open conflict。`);
        }
      }
    }
  }

  const receiptRows = db.prepare("SELECT * FROM studio_continuity_operation_receipts ORDER BY sequence")
    .all() as unknown as OperationReceiptRow[];
  for (const row of receiptRows) validateStoredReceiptFromIndexes(row, entryById, conflictById);
}

function stateFromDatabase(databasePath: string, db: DatabaseSync): StudioContinuityLedgerState {
  return {
    schemaVersion: 1,
    databasePath,
    generationLedgerReused: true,
    counts: {
      entries: count(db, "SELECT COUNT(*) AS count FROM studio_continuity_entries"),
      heads: count(db, "SELECT COUNT(*) AS count FROM studio_continuity_heads"),
      conflicts: count(db, "SELECT COUNT(*) AS count FROM studio_continuity_conflicts"),
      openConflicts: count(db, "SELECT COUNT(*) AS count FROM studio_continuity_conflict_heads WHERE status = 'open'"),
      conflictResolutions: count(db, "SELECT COUNT(*) AS count FROM studio_continuity_conflict_resolutions"),
      operationReceipts: count(db, "SELECT COUNT(*) AS count FROM studio_continuity_operation_receipts"),
    },
  };
}

export async function initializeStudioContinuityLedger(projectRoot: string): Promise<StudioContinuityLedgerState> {
  const generation = await initializeStudioGenerationLedger(projectRoot);
  const db = openContinuityDatabase(generation.databasePath, true);
  try {
    const contentCacheKey = studioRequestSqliteValidationKey(
      `studio-continuity-content-v${CONTINUITY_SCHEMA_VERSION}`,
      generation.databasePath,
    );
    const contentAlreadyValidated = hasStudioRequestSchemaValidation(contentCacheKey);
    if (!contentAlreadyValidated) {
      validateStoredContents(db);
      if (!markStudioRequestSqliteValidationIfUnchanged(
        contentCacheKey,
        `studio-continuity-content-v${CONTINUITY_SCHEMA_VERSION}`,
        generation.databasePath,
      )) {
        fail("storage-invalid", "continuity ledger 在内容深验期间发生 SQLite 身份漂移。");
      }
    }
    const state = stateFromDatabase(generation.databasePath, db);
    if (contentAlreadyValidated && !isStudioRequestSqliteValidationUnchanged(
      contentCacheKey,
      `studio-continuity-content-v${CONTINUITY_SCHEMA_VERSION}`,
      generation.databasePath,
    )) {
      fail("storage-invalid", "continuity ledger 在内容 cache-hit 复核期间发生 SQLite 身份漂移。");
    }
    return state;
  } finally {
    db.close();
  }
}

export async function getStudioContinuityLedgerState(projectRoot: string): Promise<StudioContinuityLedgerState> {
  return initializeStudioContinuityLedger(projectRoot);
}

/**
 * 按不可变 entry ID 读取一条已校验的连续性事实。
 * 驾驶舱只用它把冻结门禁指出的 P0 精确定位回实际宫格；不提供任何写入能力。
 */
export async function readStudioContinuityEntry(
  projectRoot: string,
  entryIdInput: string,
): Promise<StudioContinuityEntry | null> {
  const entryId = asInvalidInput(() => normalizeStudioContinuityStableId(entryIdInput, "entryId"));
  const { db } = await databaseForProject(projectRoot);
  try {
    const row = entryRowById(db, entryId);
    return row ? entryFromRow(row) : null;
  } finally {
    db.close();
  }
}

function normalizeOptionalSubjectId(value: string | undefined): string | undefined {
  return value === undefined
    ? undefined
    : asInvalidInput(() => normalizeStudioContinuityStableId(value, "subjectId"));
}

function normalizeOptionalField(value: StudioContinuityField | undefined): StudioContinuityField | undefined {
  return value === undefined ? undefined : asInvalidInput(() => normalizeStudioContinuityField(value));
}

interface NormalizedConflictQuery {
  scopeAnchor?: StudioContinuityScopeAnchor;
  scope?: StudioContinuityScope;
  subjectId?: string;
  field?: StudioContinuityField;
}

function normalizeConflictQuery(input: Omit<ListStudioContinuityConflictsInput, "limit" | "offset">): NormalizedConflictQuery {
  const scopeAnchor = input.scopeAnchor === undefined
    ? undefined
    : asInvalidInput(() => normalizeStudioContinuityScopeAnchor(input.scopeAnchor!));
  const scope = input.scope === undefined
    ? undefined
    : asInvalidInput(() => normalizeStudioContinuityScope(input.scope!));
  if (scopeAnchor && scope && scopeAnchor.fingerprint !== normalizeStudioContinuityScopeAnchor(scope).fingerprint) {
    fail("invalid-input", "scopeAnchor 与 scope 不属于同一 continuity anchor。 ");
  }
  return {
    ...(scopeAnchor ? { scopeAnchor } : {}),
    ...(scope ? { scope } : {}),
    ...(input.subjectId === undefined ? {} : { subjectId: normalizeOptionalSubjectId(input.subjectId)! }),
    ...(input.field === undefined ? {} : { field: normalizeOptionalField(input.field)! }),
  };
}

function conflictWhere(input: NormalizedConflictQuery, afterId?: string): { sql: string; params: Array<string | number> } {
  const conditions = ["ch.status = 'open'"];
  const params: Array<string | number> = [];
  const anchor = input.scope ?? input.scopeAnchor;
  if (anchor) {
    conditions.push("c.scope_kind = ?", "c.scope_id = ?", "c.unit_id = ?", "c.unit_revision = ?");
    params.push(anchor.kind, anchor.scopeId, anchor.unitId, anchor.unitRevision);
  }
  if (input.scope) {
    conditions.push("c.overlap_start_ms < ?", "? < c.overlap_end_ms");
    params.push(input.scope.endMilliseconds, input.scope.startMilliseconds);
  }
  if (input.subjectId !== undefined) {
    conditions.push("c.subject_id = ?");
    params.push(input.subjectId);
  }
  if (input.field !== undefined) {
    conditions.push("c.field = ?");
    params.push(input.field);
  }
  if (afterId !== undefined) {
    conditions.push("c.conflict_id > ?");
    params.push(afterId);
  }
  return { sql: conditions.join(" AND "), params };
}

function selectOpenConflictRows(
  db: DatabaseSync,
  input: NormalizedConflictQuery,
  page: { limit?: number; offset?: number; afterId?: string } = {},
): ConflictRow[] {
  const where = conflictWhere(input, page.afterId);
  const limitSql = page.limit === undefined ? "" : " LIMIT ? OFFSET ?";
  const params = [...where.params];
  if (page.limit !== undefined) params.push(page.limit, page.offset ?? 0);
  return db.prepare(`
    SELECT c.*
    FROM studio_continuity_conflicts c
    JOIN studio_continuity_conflict_heads ch ON ch.conflict_id = c.conflict_id
    WHERE ${where.sql}
    ORDER BY c.conflict_id ASC${limitSql}
  `).all(...params) as unknown as ConflictRow[];
}

function countOpenConflicts(db: DatabaseSync, input: NormalizedConflictQuery): number {
  const where = conflictWhere(input);
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM studio_continuity_conflicts c
    JOIN studio_continuity_conflict_heads ch ON ch.conflict_id = c.conflict_id
    WHERE ${where.sql}
  `).get(...where.params) as { count: number };
  return Number(row.count);
}

function conflictQueryScope(input: NormalizedConflictQuery): string {
  return `continuity-conflicts:${studioContinuityDigest({
    schemaVersion: 1,
    kind: "studio-continuity-conflict-query",
    ...(input.scopeAnchor ? { scopeAnchor: input.scopeAnchor } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    ...(input.field ? { field: input.field } : {}),
  }).slice(0, 24)}`;
}

function encodeConflictCursor(scope: string, afterId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, afterId }), "utf8").toString("base64url");
}

function decodeConflictCursor(cursor: string | undefined, scope: string): string | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      scope?: unknown;
      afterId?: unknown;
    };
    if (value.v !== 1 || value.scope !== scope || typeof value.afterId !== "string") throw new Error("invalid");
    return normalizeStudioContinuityStableId(value.afterId, "cursor.afterId");
  } catch {
    fail("invalid-input", "连续性 conflict 分页 cursor 无效或不属于当前过滤条件。");
  }
}

export async function listOpenStudioContinuityConflicts(
  projectRoot: string,
  input: ListStudioContinuityConflictsInput = {},
): Promise<StudioContinuityConflict[]> {
  const normalized = normalizeConflictQuery(input);
  const offset = input.offset === undefined ? 0 : input.offset;
  const limit = input.limit;
  if (!Number.isSafeInteger(offset) || offset < 0) fail("invalid-input", "offset 必须是非负整数。");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) {
    fail("invalid-input", "limit 必须是 1-500 的整数。");
  }
  const { db } = await databaseForProject(projectRoot);
  try {
    return selectOpenConflictRows(db, normalized, { limit, offset }).map((row) => conflictFromRow(db, row));
  } finally {
    db.close();
  }
}

export async function listOpenStudioContinuityConflictPage(
  projectRoot: string,
  input: ListStudioContinuityConflictPageInput = {},
): Promise<StudioContinuityConflictPage> {
  const normalized = normalizeConflictQuery(input);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    fail("invalid-input", "limit 必须是 1-100 的整数。");
  }
  const scope = conflictQueryScope(normalized);
  const afterId = decodeConflictCursor(input.cursor, scope);
  const { db } = await databaseForProject(projectRoot);
  try {
    const rows = selectOpenConflictRows(db, normalized, { limit: limit + 1, afterId });
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = selected.map((row) => conflictFromRow(db, row));
    const total = countOpenConflicts(db, normalized);
    const body = {
      schemaVersion: 1 as const,
      kind: "studio-continuity-conflict-page" as const,
      total,
      items,
      ...(hasMore && items.length > 0
        ? { nextCursor: encodeConflictCursor(scope, items[items.length - 1]!.id) }
        : {}),
    };
    return { ...body, fingerprint: studioContinuityDigest(body) };
  } finally {
    db.close();
  }
}

const CONTINUITY_FIELD_RANK_SQL = `CASE e.field
  WHEN 'costume' THEN 0
  WHEN 'injury' THEN 1
  WHEN 'heldObject' THEN 2
  WHEN 'position' THEN 3
  WHEN 'facing' THEN 4
  WHEN 'emotion' THEN 5
  WHEN 'layout' THEN 6
  WHEN 'lighting' THEN 7
  WHEN 'referenceSha256' THEN 8
  ELSE 99 END`;

interface TimelineCursorKey {
  startMilliseconds: number;
  endMilliseconds: number;
  subjectId: string;
  fieldRank: number;
  entryId: string;
}

function timelineQueryScope(
  scopeAnchor: StudioContinuityScopeAnchor,
  subjectId?: string,
  field?: StudioContinuityField,
): string {
  return `continuity-timeline:${studioContinuityDigest({
    schemaVersion: 1,
    kind: "studio-continuity-timeline-query",
    scopeAnchor,
    ...(subjectId ? { subjectId } : {}),
    ...(field ? { field } : {}),
  }).slice(0, 24)}`;
}

function encodeTimelineCursor(scope: string, key: TimelineCursorKey): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, key }), "utf8").toString("base64url");
}

function decodeTimelineCursor(cursor: string | undefined, scope: string): TimelineCursorKey | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      scope?: unknown;
      key?: Partial<TimelineCursorKey>;
    };
    const key = value.key;
    if (value.v !== 1 || value.scope !== scope || !key
      || !Number.isSafeInteger(key.startMilliseconds) || Number(key.startMilliseconds) < 0
      || !Number.isSafeInteger(key.endMilliseconds) || Number(key.endMilliseconds) <= Number(key.startMilliseconds)
      || typeof key.subjectId !== "string" || typeof key.entryId !== "string"
      || !Number.isSafeInteger(key.fieldRank) || Number(key.fieldRank) < 0 || Number(key.fieldRank) > 8) {
      throw new Error("invalid");
    }
    return {
      startMilliseconds: Number(key.startMilliseconds),
      endMilliseconds: Number(key.endMilliseconds),
      subjectId: normalizeStudioContinuityStableId(key.subjectId, "cursor.subjectId"),
      fieldRank: Number(key.fieldRank),
      entryId: normalizeStudioContinuityStableId(key.entryId, "cursor.entryId"),
    };
  } catch {
    fail("invalid-input", "连续性 timeline 分页 cursor 无效或不属于当前过滤条件。");
  }
}

function selectTimelineHeadRows(
  db: DatabaseSync,
  input: {
    scopeAnchor: StudioContinuityScopeAnchor;
    subjectId?: string;
    field?: StudioContinuityField;
    after?: TimelineCursorKey;
    limit?: number;
  },
): HeadRow[] {
  const conditions = [
    "e.scope_kind = ?",
    "e.scope_id = ?",
    "e.unit_id = ?",
    "e.unit_revision = ?",
  ];
  const params: Array<string | number> = [
    input.scopeAnchor.kind,
    input.scopeAnchor.scopeId,
    input.scopeAnchor.unitId,
    input.scopeAnchor.unitRevision,
  ];
  if (input.subjectId !== undefined) {
    conditions.push("e.subject_id = ?");
    params.push(input.subjectId);
  }
  if (input.field !== undefined) {
    conditions.push("e.field = ?");
    params.push(input.field);
  }
  if (input.after) {
    conditions.push(`(e.start_ms, e.end_ms, e.subject_id, ${CONTINUITY_FIELD_RANK_SQL}, e.entry_id) > (?, ?, ?, ?, ?)`);
    params.push(
      input.after.startMilliseconds,
      input.after.endMilliseconds,
      input.after.subjectId,
      input.after.fieldRank,
      input.after.entryId,
    );
  }
  const limitSql = input.limit === undefined ? "" : " LIMIT ?";
  if (input.limit !== undefined) params.push(input.limit);
  return db.prepare(`
    SELECT h.*
    FROM studio_continuity_heads h
    JOIN studio_continuity_entries e ON e.entry_id = h.entry_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY e.start_ms ASC, e.end_ms ASC, e.subject_id ASC, ${CONTINUITY_FIELD_RANK_SQL} ASC, e.entry_id ASC${limitSql}
  `).all(...params) as unknown as HeadRow[];
}

function countTimelineHeads(
  db: DatabaseSync,
  input: { scopeAnchor: StudioContinuityScopeAnchor; subjectId?: string; field?: StudioContinuityField },
): number {
  const conditions = [
    "e.scope_kind = ?",
    "e.scope_id = ?",
    "e.unit_id = ?",
    "e.unit_revision = ?",
  ];
  const params: Array<string | number> = [
    input.scopeAnchor.kind,
    input.scopeAnchor.scopeId,
    input.scopeAnchor.unitId,
    input.scopeAnchor.unitRevision,
  ];
  if (input.subjectId !== undefined) {
    conditions.push("e.subject_id = ?");
    params.push(input.subjectId);
  }
  if (input.field !== undefined) {
    conditions.push("e.field = ?");
    params.push(input.field);
  }
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM studio_continuity_heads h
    JOIN studio_continuity_entries e ON e.entry_id = h.entry_id
    WHERE ${conditions.join(" AND ")}
  `).get(...params) as { count: number };
  return Number(row.count);
}

function openConflictIdsForHeads(db: DatabaseSync, headKeys: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>(headKeys.map((headKey) => [headKey, []]));
  if (headKeys.length === 0) return result;
  const placeholders = headKeys.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT c.conflict_id, le.head_key AS left_head_key, re.head_key AS right_head_key
    FROM studio_continuity_conflicts c
    JOIN studio_continuity_conflict_heads ch ON ch.conflict_id = c.conflict_id
    JOIN studio_continuity_entries le ON le.entry_id = c.left_entry_id
    JOIN studio_continuity_entries re ON re.entry_id = c.right_entry_id
    WHERE ch.status = 'open'
      AND (le.head_key IN (${placeholders}) OR re.head_key IN (${placeholders}))
    ORDER BY c.conflict_id ASC
  `).all(...headKeys, ...headKeys) as unknown as Array<{
    conflict_id: string;
    left_head_key: string;
    right_head_key: string;
  }>;
  for (const row of rows) {
    result.get(row.left_head_key)?.push(row.conflict_id);
    if (row.right_head_key !== row.left_head_key) result.get(row.right_head_key)?.push(row.conflict_id);
  }
  return result;
}

function timelineItemsFromRows(db: DatabaseSync, rows: HeadRow[]): StudioContinuityTimeline["items"] {
  const heads = rows.map((row) => headFromRow(db, row));
  const conflicts = openConflictIdsForHeads(db, heads.map((head) => head.headKey));
  return heads.map((head) => ({
    headKey: head.headKey,
    headRevision: head.revision,
    entry: head.entry,
    openConflictIds: conflicts.get(head.headKey) ?? [],
  }));
}

export async function queryStudioContinuityTimelinePage(
  projectRoot: string,
  input: QueryStudioContinuityTimelinePageInput,
): Promise<StudioContinuityTimelinePage> {
  const scopeAnchor = asInvalidInput(() => normalizeStudioContinuityScopeAnchor(input.scopeAnchor));
  const subjectId = normalizeOptionalSubjectId(input.subjectId);
  const field = normalizeOptionalField(input.field);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    fail("invalid-input", "limit 必须是 1-100 的整数。");
  }
  const cursorScope = timelineQueryScope(scopeAnchor, subjectId, field);
  const after = decodeTimelineCursor(input.cursor, cursorScope);
  const { db } = await databaseForProject(projectRoot);
  try {
    const rows = selectTimelineHeadRows(db, { scopeAnchor, subjectId, field, after, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = timelineItemsFromRows(db, selected);
    const last = items.at(-1)?.entry;
    const body = {
      schemaVersion: 1 as const,
      kind: "studio-continuity-timeline-page" as const,
      scopeAnchor,
      ...(subjectId === undefined ? {} : { subjectId }),
      ...(field === undefined ? {} : { field }),
      total: countTimelineHeads(db, { scopeAnchor, subjectId, field }),
      items,
      ...(hasMore && last ? {
        nextCursor: encodeTimelineCursor(cursorScope, {
          startMilliseconds: last.scope.startMilliseconds,
          endMilliseconds: last.scope.endMilliseconds,
          subjectId: last.subjectId,
          fieldRank: ["costume", "injury", "heldObject", "position", "facing", "emotion", "layout", "lighting", "referenceSha256"]
            .indexOf(last.field),
          entryId: last.id,
        }),
      } : {}),
    };
    return { ...body, fingerprint: studioContinuityDigest(body) };
  } finally {
    db.close();
  }
}

export async function queryStudioContinuityTimeline(
  projectRoot: string,
  input: QueryStudioContinuityTimelineInput,
): Promise<StudioContinuityTimeline> {
  return (await queryStudioContinuityTimelines(projectRoot, [input]))[0]!;
}

/**
 * 一次完整验库后读取多个 timeline；每个返回值仍保持与单条 API 相同的内容地址语义。
 * 用于同一 panel/unit 冻结多个资产，避免规模场景反复扫描同一份 append-only 账本。
 */
export async function queryStudioContinuityTimelines(
  projectRoot: string,
  inputs: QueryStudioContinuityTimelineInput[],
): Promise<StudioContinuityTimeline[]> {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 500) {
    fail("invalid-input", "continuity timeline 批次必须为 1–500 项。");
  }
  const normalized = inputs.map((input) => ({
    scopeAnchor: asInvalidInput(() => normalizeStudioContinuityScopeAnchor(input.scopeAnchor)),
    subjectId: normalizeOptionalSubjectId(input.subjectId),
    field: normalizeOptionalField(input.field),
  }));
  const { db } = await databaseForProject(projectRoot);
  try {
    return normalized.map(({ scopeAnchor, subjectId, field }) => {
      const rows = selectTimelineHeadRows(db, { scopeAnchor, subjectId, field });
      const items = timelineItemsFromRows(db, rows);
      const openConflicts = selectOpenConflictRows(db, { scopeAnchor, subjectId, field })
        .map((row) => conflictFromRow(db, row));
      const semantic = {
        schemaVersion: 1 as const,
        kind: "studio-continuity-timeline" as const,
        scopeAnchor,
        ...(subjectId === undefined ? {} : { subjectId }),
        ...(field === undefined ? {} : { field }),
        items,
        openConflicts,
      };
      return { ...semantic, fingerprint: studioContinuityDigest(semantic) };
    });
  } finally {
    db.close();
  }
}

export async function getStudioContinuityCurrentProjection(
  projectRoot: string,
  input: QueryStudioContinuityTimelineInput,
): Promise<StudioContinuityTimeline> {
  return queryStudioContinuityTimeline(projectRoot, input);
}

export async function getStudioContinuityReadiness(
  projectRoot: string,
  input: GetStudioContinuityReadinessInput,
): Promise<StudioContinuityReadiness> {
  const scope = asInvalidInput(() => normalizeStudioContinuityScope(input.scope));
  const subjectId = asInvalidInput(() => normalizeStudioContinuityStableId(input.subjectId, "subjectId"));
  const timeline = await queryStudioContinuityTimeline(projectRoot, {
    scopeAnchor: scope,
    subjectId,
  });
  return asInvalidInput(() => createStudioContinuityReadiness({
    scope,
    subjectId,
    requiredFields: input.requiredFields,
    currentEntries: timeline.items.map((item) => item.entry),
    openConflicts: timeline.openConflicts,
  }));
}

export async function readStudioContinuityOperationReceipt(
  projectRoot: string,
  operationIdInput: string,
): Promise<StudioContinuityWriteResult | null> {
  const operationId = normalizeOperationId(operationIdInput);
  const { db } = await databaseForProject(projectRoot);
  try {
    const row = operationReceiptRow(db, operationId);
    return row ? resultFromReceipt(db, row, true) : null;
  } finally {
    db.close();
  }
}
