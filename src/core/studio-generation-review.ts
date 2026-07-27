/**
 * Managed Studio 生成结果 Review 账本。
 *
 * 这里只追加 observation/correction 与 CAS Head，绝不修改生成结果、
 * CanonicalAsset、BindingSet、剧本或冻结包。账本与 generation pack/result 共用
 * `.aicanvas/studio-generation-ledger.sqlite`，避免再建一套 Review 事实源。
 */
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspectManagedProject, inspectManagedProjectReadOnly } from "./managed-project.js";
import {
  assertSafeSqliteSidecars,
  assertSqliteSourceBindingIdentity,
  openSqliteReadOnlySnapshot,
  type SqliteReadOnlySnapshot,
  type SqliteSourceBindingIdentity,
} from "./sqlite-readonly-snapshot.js";
import { assertSqliteSchemaContract } from "./sqlite-schema-contract.js";
import {
  initializeStudioGenerationLedger,
  readStudioGenerationFrozenPack,
  readStudioGenerationResult,
  readStudioUnitGridGenerationFrozenPack,
  type StudioGenerationResultRecord,
} from "./studio-generation-ledger.js";

const DATABASE_RELATIVE_PATH = ".aicanvas/studio-generation-ledger.sqlite";
const REVIEW_SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const MAX_JSON_BYTES = 512 * 1024;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;

export type StudioGenerationReviewKind = "observation" | "correction";
export type StudioGenerationReviewDecision = "pass" | "rework" | "reject";
export type StudioGenerationReviewCriterionStatus = "pass" | "fail" | "not-applicable";

export type StudioGenerationReviewErrorCode =
  | "unmanaged-project"
  | "invalid-input"
  | "storage-invalid"
  | "result-not-found"
  | "result-pair-invalid"
  | "review-conflict"
  | "review-not-found"
  | "operation-conflict"
  | "invalid-cursor";

export class StudioGenerationReviewError extends Error {
  readonly code: StudioGenerationReviewErrorCode;
  readonly details: string[];

  constructor(code: StudioGenerationReviewErrorCode, message: string, details: string[] = [], options?: ErrorOptions) {
    super(message, options);
    this.name = "StudioGenerationReviewError";
    this.code = code;
    this.details = details;
  }
}

export interface StudioGenerationReviewCriterionInput {
  code: string;
  status: StudioGenerationReviewCriterionStatus;
  note?: string;
}

export interface StudioGenerationReviewCriterion {
  code: string;
  status: StudioGenerationReviewCriterionStatus;
  note: string;
}

/** P22 批注 v2：七类问题分类（脸/发型/服装/犬纹/黄金面具/场景/道具）。 */
export const STUDIO_GENERATION_REVIEW_ANNOTATION_CATEGORIES = [
  "face",
  "hair",
  "costume",
  "marking",
  "golden-mask",
  "scene",
  "prop",
] as const;
export type StudioGenerationReviewAnnotationCategory = (typeof STUDIO_GENERATION_REVIEW_ANNOTATION_CATEGORIES)[number];
export type StudioGenerationReviewAnnotationKind = "rect" | "point";

/** 提交载荷批注：id/kind 必填（提交方派生，Core 仅校验不改写），category 可选。 */
export interface StudioGenerationReviewAnnotationInput {
  id: string;
  kind: StudioGenerationReviewAnnotationKind;
  category?: StudioGenerationReviewAnnotationCategory;
  x: number;
  y: number;
  width: number;
  height: number;
  note: string;
}

/** 读路径批注（投影/历史/control）：id/kind/category 全可选（P22 前旧行缺省 kind=rect）。 */
export interface StudioGenerationReviewStoredAnnotation {
  id?: string;
  kind?: StudioGenerationReviewAnnotationKind;
  category?: StudioGenerationReviewAnnotationCategory;
  x: number;
  y: number;
  width: number;
  height: number;
  note: string;
}

export interface SubmitStudioGenerationReviewInput {
  /** 业务事务内回执键；同键异载荷必须拒绝。 */
  operationId: string;
  generationRunId: string;
  kind: StudioGenerationReviewKind;
  expectedHeadRevision: number;
  supersedesReviewId?: string;
  rawResultId: string;
  rawSha256: string;
  labeledResultId: string;
  labeledSha256: string;
  expectedPackFingerprint: string;
  /** 由 P7 continuity Core 生成的当前逐格快照指纹。 */
  continuityFingerprint: string;
  decision: StudioGenerationReviewDecision;
  criteria: StudioGenerationReviewCriterionInput[];
  annotations?: StudioGenerationReviewAnnotationInput[];
  reviewer: string;
  note: string;
}

export interface StudioGenerationReviewRecord {
  sequence: number;
  reviewId: string;
  generationRunId: string;
  kind: StudioGenerationReviewKind;
  baseHeadRevision: number;
  headRevision?: number;
  supersedesReviewId?: string;
  rawResultId: string;
  rawSha256: string;
  labeledResultId: string;
  labeledSha256: string;
  packId: string;
  packFingerprint: string;
  continuityFingerprint: string;
  decision: StudioGenerationReviewDecision;
  criteria: StudioGenerationReviewCriterion[];
  annotations: StudioGenerationReviewStoredAnnotation[];
  reviewer: string;
  note: string;
  currentAtSubmission: boolean;
  advancesHead: boolean;
  staleReasons: string[];
  fingerprint: string;
  createdAt: string;
}

export interface StudioGenerationReviewProjection extends StudioGenerationReviewRecord {
  head: boolean;
  current: boolean;
  approvedRawEligible: boolean;
  currentStaleReasons: string[];
}

export interface StudioGenerationReviewControl {
  schemaVersion: 1;
  kind: "studio-generation-review-control";
  generationRunId: string;
  headRevision: number;
  head?: StudioGenerationReviewProjection;
  status: "unreviewed" | "pass" | "rework" | "reject" | "stale";
  blockers: string[];
  nextAction: "submit-observation" | "submit-correction" | "approved-raw-ready";
  fingerprint: string;
}

export interface StudioGenerationReviewHistoryQuery {
  generationRunId: string;
  cursor?: string;
  limit?: number;
}

export interface StudioGenerationReviewHistoryPage {
  items: StudioGenerationReviewProjection[];
  nextCursor?: string;
}

interface ReviewRow {
  sequence: number;
  review_id: string;
  generation_run_id: string;
  review_kind: StudioGenerationReviewKind;
  base_head_revision: number;
  head_revision: number | null;
  supersedes_review_id: string | null;
  raw_result_id: string;
  raw_sha256: string;
  labeled_result_id: string;
  labeled_sha256: string;
  pack_id: string;
  pack_fingerprint: string;
  continuity_fingerprint: string;
  decision: StudioGenerationReviewDecision;
  criteria_json: string;
  annotations_json: string;
  reviewer: string;
  note: string;
  current_at_submission: number;
  advances_head: number;
  stale_reasons_json: string;
  fingerprint: string;
  created_at: string;
}

interface ReviewHeadRow {
  generation_run_id: string;
  revision: number;
  review_id: string;
  review_fingerprint: string;
  updated_at: string;
}

interface OperationRow {
  operation_id: string;
  input_fingerprint: string;
  review_id: string;
}

function fail(code: StudioGenerationReviewErrorCode, message: string, details: string[] = []): never {
  throw new StudioGenerationReviewError(code, message, details);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function requiredText(value: unknown, label: string, maximum = 8_000): string {
  if (typeof value !== "string") fail("invalid-input", `${label} 必须是字符串。`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) fail("invalid-input", `${label} 必须是 1-${maximum} 个字符。`);
  return normalized;
}

function normalizedId(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 255);
  if (!ID_PATTERN.test(normalized)) fail("invalid-input", `${label} 不是稳定 ID。`);
  return normalized;
}

function normalizedSha(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 64);
  if (!SHA256_PATTERN.test(normalized)) fail("invalid-input", `${label} 必须是 64 位小写 SHA-256。`);
  return normalized;
}

function normalizedCriteria(input: StudioGenerationReviewCriterionInput[]): StudioGenerationReviewCriterion[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) {
    fail("invalid-input", "criteria 必须包含 1-100 项。");
  }
  const criteria = input.map((entry, index) => {
    if (!entry || typeof entry !== "object") fail("invalid-input", `criteria[${index}] 结构无效。`);
    if (entry.status !== "pass" && entry.status !== "fail" && entry.status !== "not-applicable") {
      fail("invalid-input", `criteria[${index}].status 无效。`);
    }
    return {
      code: normalizedId(entry.code, `criteria[${index}].code`),
      status: entry.status,
      note: entry.note?.trim() ?? "",
    };
  });
  const sorted = criteria.sort((left, right) => left.code.localeCompare(right.code, "en"));
  if (new Set(sorted.map((entry) => entry.code)).size !== sorted.length) fail("invalid-input", "criteria.code 不能重复。");
  return sorted;
}

function normalizeAnnotationCategory(value: unknown, index: number): StudioGenerationReviewAnnotationCategory | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string"
    && (STUDIO_GENERATION_REVIEW_ANNOTATION_CATEGORIES as readonly string[]).includes(value)) {
    return value as StudioGenerationReviewAnnotationCategory;
  }
  fail("invalid-input", `annotations[${index}].category 必须是七类之一：${STUDIO_GENERATION_REVIEW_ANNOTATION_CATEGORIES.join("/")}。`);
}

function normalizedAnnotations(input: StudioGenerationReviewAnnotationInput[] | undefined): StudioGenerationReviewAnnotationInput[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 100) fail("invalid-input", "annotations 最多 100 项。");
  const ids = new Set<string>();
  return input.map((entry, index) => {
    if (!entry || typeof entry !== "object") fail("invalid-input", `annotations[${index}] 结构无效。`);
    // P22 v2：id/kind 必填（提交方派生，Core 仅校验格式+唯一，绝不改写）。
    const id = normalizedId(entry.id, `annotations[${index}].id`);
    if (!/^ann-[a-z0-9-]+$/u.test(id)) fail("invalid-input", `annotations[${index}].id 必须是 ann- 前缀的小写稳定标识。`);
    if (ids.has(id)) fail("invalid-input", `annotations[${index}].id 重复：${id}。`);
    ids.add(id);
    const kind = entry.kind;
    if (kind !== "rect" && kind !== "point") fail("invalid-input", `annotations[${index}].kind 必须是 rect 或 point。`);
    for (const [key, value] of Object.entries({ x: entry.x, y: entry.y, width: entry.width, height: entry.height })) {
      if (!Number.isFinite(value) || value < 0 || value > 1) fail("invalid-input", `annotations[${index}].${key} 必须在 0..1。`);
    }
    if (kind === "rect" && (entry.width <= 0 || entry.height <= 0)) {
      fail("invalid-input", `annotations[${index}]（rect）width/height 必须大于 0。`);
    }
    if (kind === "point" && (entry.width !== 0 || entry.height !== 0)) {
      fail("invalid-input", `annotations[${index}]（point）必须 width=height=0。`);
    }
    if (entry.x + entry.width > 1 || entry.y + entry.height > 1) {
      fail("invalid-input", `annotations[${index}] 越界。`);
    }
    const category = normalizeAnnotationCategory(entry.category, index);
    return {
      id,
      kind,
      ...(category ? { category } : {}),
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
      note: requiredText(entry.note, `annotations[${index}].note`, 4_000),
    };
  });
}

function assertJsonSize(value: unknown, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_JSON_BYTES) fail("invalid-input", `${label} 超过 ${MAX_JSON_BYTES} 字节。`);
}

interface ReviewDatabaseContext {
  databasePath: string;
  readonly sourceIdentity: SqliteSourceBindingIdentity;
}

async function databaseContextFor(projectRoot: string): Promise<ReviewDatabaseContext> {
  await initializeStudioGenerationLedger(projectRoot);
  let shell: Awaited<ReturnType<typeof inspectManagedProject>>;
  try {
    shell = await inspectManagedProject(projectRoot);
  } catch (error) {
    throw new StudioGenerationReviewError("unmanaged-project", "Review 只允许写入受管 Studio 项目。", [], { cause: error });
  }
  const databasePath = path.join(shell.paths.root, DATABASE_RELATIVE_PATH);
  await ensureReviewSchema(databasePath);
  let snapshot: Awaited<ReturnType<typeof openSqliteReadOnlySnapshot>> | null = null;
  try {
    snapshot = await openSqliteReadOnlySnapshot(databasePath, "generation review ledger operation");
    assertBaseSchema(snapshot.database);
    assertSchema(snapshot.database);
    return { databasePath, sourceIdentity: snapshot.sourceIdentity };
  } finally {
    await snapshot?.close();
  }
}

function missingFile(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Review 控制面纯查询必须保持物理只读：
 * - 不调用 initializeStudioGenerationLedger / ensureReviewSchema；
 * - live DB 从不经 SQLite 打开，只读取稳定临时快照；
 * - DB 或 Review schema 尚未创建时返回 null，由调用方投影为未审/空结果；
 * - marker 缺失但存在残留业务对象时仍失败关闭，禁止把弱 schema 当成空状态。
 */
async function openReviewReadSnapshot(
  projectRoot: string,
  label: string,
): Promise<SqliteReadOnlySnapshot | null> {
  let shell: Awaited<ReturnType<typeof inspectManagedProjectReadOnly>>;
  try {
    shell = await inspectManagedProjectReadOnly(projectRoot);
  } catch (error) {
    throw new StudioGenerationReviewError(
      "unmanaged-project",
      "Review 只允许读取受管 Studio 项目。",
      [],
      { cause: error },
    );
  }
  const databasePath = path.join(shell.paths.root, DATABASE_RELATIVE_PATH);
  try {
    const metadata = await lstat(databasePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail("storage-invalid", "Review 账本不是安全普通文件。");
    }
  } catch (error) {
    if (missingFile(error)) return null;
    throw error;
  }

  const snapshot = await openSqliteReadOnlySnapshot(databasePath, label);
  try {
    assertBaseSchema(snapshot.database);
    const marker = snapshot.database.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key='p7_review_schema_version'",
    ).get() as { value?: string } | undefined;
    if (!marker) {
      const residual = reviewSchemaObjects(snapshot.database);
      if (residual.length > 0) {
        fail(
          "storage-invalid",
          "Review schema marker 缺失但存在残留对象，禁止把残留结构当作可读账本。",
          residual.map((item) => `${item.type}:${item.name}`),
        );
      }
      await snapshot.close();
      return null;
    }
    assertSchema(snapshot.database);
    return snapshot;
  } catch (error) {
    await snapshot.close();
    throw error;
  }
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE studio_generation_review_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id TEXT NOT NULL UNIQUE,
      generation_run_id TEXT NOT NULL,
      review_kind TEXT NOT NULL CHECK(review_kind IN ('observation', 'correction')),
      base_head_revision INTEGER NOT NULL CHECK(base_head_revision >= 0),
      head_revision INTEGER CHECK(head_revision IS NULL OR head_revision >= 1),
      supersedes_review_id TEXT,
      raw_result_id TEXT NOT NULL,
      raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256) = 64),
      labeled_result_id TEXT NOT NULL,
      labeled_sha256 TEXT NOT NULL CHECK(length(labeled_sha256) = 64),
      pack_id TEXT NOT NULL,
      pack_fingerprint TEXT NOT NULL CHECK(length(pack_fingerprint) = 64),
      continuity_fingerprint TEXT NOT NULL CHECK(length(continuity_fingerprint) = 64),
      decision TEXT NOT NULL CHECK(decision IN ('pass', 'rework', 'reject')),
      criteria_json TEXT NOT NULL,
      annotations_json TEXT NOT NULL,
      reviewer TEXT NOT NULL,
      note TEXT NOT NULL,
      current_at_submission INTEGER NOT NULL CHECK(current_at_submission IN (0, 1)),
      advances_head INTEGER NOT NULL CHECK(advances_head IN (0, 1)),
      stale_reasons_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      CHECK((advances_head = 1 AND head_revision = base_head_revision + 1) OR (advances_head = 0 AND head_revision IS NULL)),
      CHECK((review_kind = 'observation' AND supersedes_review_id IS NULL) OR (review_kind = 'correction' AND supersedes_review_id IS NOT NULL)),
      FOREIGN KEY(raw_result_id) REFERENCES studio_generation_results(result_id) ON DELETE RESTRICT,
      FOREIGN KEY(labeled_result_id) REFERENCES studio_generation_results(result_id) ON DELETE RESTRICT,
      FOREIGN KEY(supersedes_review_id) REFERENCES studio_generation_review_events(review_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE studio_generation_review_heads (
      generation_run_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      review_id TEXT NOT NULL UNIQUE,
      review_fingerprint TEXT NOT NULL CHECK(length(review_fingerprint) = 64),
      updated_at TEXT NOT NULL,
      FOREIGN KEY(review_id) REFERENCES studio_generation_review_events(review_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE studio_generation_review_operation_receipts (
      operation_id TEXT PRIMARY KEY,
      input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint) = 64),
      review_id TEXT NOT NULL,
      outcome_fingerprint TEXT NOT NULL CHECK(length(outcome_fingerprint) = 64),
      created_at TEXT NOT NULL,
      FOREIGN KEY(review_id) REFERENCES studio_generation_review_events(review_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX studio_generation_review_run_sequence_idx
      ON studio_generation_review_events(generation_run_id, sequence);
    CREATE INDEX studio_generation_review_pair_idx
      ON studio_generation_review_events(raw_result_id, labeled_result_id);

    CREATE TRIGGER studio_generation_review_events_no_update
      BEFORE UPDATE ON studio_generation_review_events BEGIN SELECT RAISE(ABORT, 'generation review events are append-only'); END;
    CREATE TRIGGER studio_generation_review_events_no_delete
      BEFORE DELETE ON studio_generation_review_events BEGIN SELECT RAISE(ABORT, 'generation review events are append-only'); END;
    CREATE TRIGGER studio_generation_review_receipts_no_update
      BEFORE UPDATE ON studio_generation_review_operation_receipts BEGIN SELECT RAISE(ABORT, 'generation review receipts are append-only'); END;
    CREATE TRIGGER studio_generation_review_receipts_no_delete
      BEFORE DELETE ON studio_generation_review_operation_receipts BEGIN SELECT RAISE(ABORT, 'generation review receipts are append-only'); END;
  `);
}

const REVIEW_TABLE_COLUMNS: Record<string, string[]> = {
  studio_generation_review_events: [
    "sequence", "review_id", "generation_run_id", "review_kind", "base_head_revision", "head_revision",
    "supersedes_review_id", "raw_result_id", "raw_sha256", "labeled_result_id", "labeled_sha256", "pack_id",
    "pack_fingerprint", "continuity_fingerprint", "decision", "criteria_json", "annotations_json", "reviewer",
    "note", "current_at_submission", "advances_head", "stale_reasons_json", "fingerprint", "created_at",
  ],
  studio_generation_review_heads: [
    "generation_run_id", "revision", "review_id", "review_fingerprint", "updated_at",
  ],
  studio_generation_review_operation_receipts: [
    "operation_id", "input_fingerprint", "review_id", "outcome_fingerprint", "created_at",
  ],
};
const REVIEW_INDEXES = ["studio_generation_review_run_sequence_idx", "studio_generation_review_pair_idx"] as const;
const REVIEW_TRIGGERS = [
  "studio_generation_review_events_no_update",
  "studio_generation_review_events_no_delete",
  "studio_generation_review_receipts_no_update",
  "studio_generation_review_receipts_no_delete",
] as const;

function schemaObjectExists(db: DatabaseSync, name: string, type: "index" | "trigger"): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type=? AND name=?").get(type, name));
}

function assertSchema(db: DatabaseSync): void {
  const marker = db.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='p7_review_schema_version'")
    .get() as { value?: string } | undefined;
  if (marker?.value !== String(REVIEW_SCHEMA_VERSION)) {
    fail("storage-invalid", `Review schema marker 无效：${marker?.value ?? "缺失"}。`);
  }
  const actualTables = (db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name GLOB 'studio_generation_review_*'
    ORDER BY name
  `).all() as Array<{ name: string }>).map((row) => row.name);
  const expectedTables = Object.keys(REVIEW_TABLE_COLUMNS).sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    fail("storage-invalid", "Review tables 与声明 schema 不一致。");
  }
  for (const [table, expected] of Object.entries(REVIEW_TABLE_COLUMNS)) {
    const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail("storage-invalid", `Review table ${table} 列定义与声明 schema 不一致。`);
    }
  }
  for (const index of REVIEW_INDEXES) if (!schemaObjectExists(db, index, "index")) fail("storage-invalid", `Review index ${index} 缺失。`);
  for (const trigger of REVIEW_TRIGGERS) if (!schemaObjectExists(db, trigger, "trigger")) fail("storage-invalid", `Review trigger ${trigger} 缺失。`);
  const expected = new DatabaseSync(":memory:");
  try {
    createSchema(expected);
    assertSqliteSchemaContract({
      actual: db,
      expected,
      objectNames: [...Object.keys(REVIEW_TABLE_COLUMNS), ...REVIEW_INDEXES, ...REVIEW_TRIGGERS],
      tableNames: Object.keys(REVIEW_TABLE_COLUMNS),
      ownedObjectPrefixes: ["studio_generation_review_"],
      rejectAllViews: true,
      label: "Review",
    });
  } catch (error) {
    if (error instanceof StudioGenerationReviewError) throw error;
    fail("storage-invalid", error instanceof Error ? error.message : "Review 完整 schema 合同不一致。");
  } finally {
    expected.close();
  }
  if ((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length > 0) fail("storage-invalid", "Review 账本存在外键孤儿。");
}

function reviewSchemaObjects(db: DatabaseSync): Array<{ type: string; name: string }> {
  return db.prepare(`
    SELECT type, name FROM sqlite_master
    WHERE name GLOB 'studio_generation_review_*'
    ORDER BY type, name
  `).all() as Array<{ type: string; name: string }>;
}

function assertBaseSchema(db: DatabaseSync): void {
  const baseVersion = db.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='schema_version'")
    .get() as { value?: string } | undefined;
  if (!baseVersion?.value || !["2", "3", "4", "5", "6", "7"].includes(baseVersion.value)) {
    fail("storage-invalid", "Review 扩展要求已初始化的 generation ledger v2-v7。");
  }
}

async function ensureReviewSchema(databasePath: string): Promise<void> {
  let snapshot: Awaited<ReturnType<typeof openSqliteReadOnlySnapshot>> | null = null;
  let sourceIdentity: SqliteSourceBindingIdentity | null = null;
  let needsInitialization = false;
  try {
    snapshot = await openSqliteReadOnlySnapshot(databasePath, "generation review ledger");
    sourceIdentity = snapshot.sourceIdentity;
    assertBaseSchema(snapshot.database);
    const marker = snapshot.database.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key='p7_review_schema_version'",
    ).get() as { value?: string } | undefined;
    if (marker) {
      if (marker.value !== String(REVIEW_SCHEMA_VERSION)) {
        fail("storage-invalid", `不支持 Review schema ${marker.value}。`);
      }
      assertSchema(snapshot.database);
      return;
    }
    const residual = reviewSchemaObjects(snapshot.database);
    if (residual.length > 0) {
      fail("storage-invalid", "Review schema marker 缺失但已存在业务对象，禁止猜测或静默修复。", residual.map((item) => `${item.type}:${item.name}`));
    }
    needsInitialization = true;
  } finally {
    await snapshot?.close();
  }
  if (!needsInitialization) return;

  if (!sourceIdentity) fail("storage-invalid", "Review 首次初始化缺少只读预检身份。");
  assertSqliteSourceBindingIdentity(databasePath, sourceIdentity, "generation review ledger");
  assertSafeSqliteSidecars(databasePath, "generation review ledger");

  const db = new DatabaseSync(databasePath, { timeout: BUSY_TIMEOUT_MS });
  try {
    assertSafeSqliteSidecars(databasePath, "generation review ledger");
    assertSqliteSourceBindingIdentity(databasePath, sourceIdentity, "generation review ledger");
    db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;`);
    db.exec("BEGIN IMMEDIATE");
    try {
      assertBaseSchema(db);
      const marker = db.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='p7_review_schema_version'")
        .get() as { value?: string } | undefined;
      if (marker) {
        if (marker.value !== String(REVIEW_SCHEMA_VERSION)) fail("storage-invalid", `不支持 Review schema ${marker.value}。`);
        assertSchema(db);
      } else {
        const residual = reviewSchemaObjects(db);
        if (residual.length > 0) {
          fail("storage-invalid", "Review schema 首次初始化发现无 marker 残留对象。", residual.map((item) => `${item.type}:${item.name}`));
        }
        createSchema(db);
        db.prepare("INSERT INTO studio_generation_ledger_meta(key,value) VALUES('p7_review_schema_version', ?)")
          .run(String(REVIEW_SCHEMA_VERSION));
        assertSchema(db);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function openDatabase(context: ReviewDatabaseContext): DatabaseSync {
  assertSafeSqliteSidecars(context.databasePath, "generation review ledger");
  assertSqliteSourceBindingIdentity(context.databasePath, context.sourceIdentity, "generation review ledger");
  const db = new DatabaseSync(context.databasePath, { timeout: BUSY_TIMEOUT_MS });
  try {
    assertSafeSqliteSidecars(context.databasePath, "generation review ledger");
    assertSqliteSourceBindingIdentity(context.databasePath, context.sourceIdentity, "generation review ledger");
    db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;`);
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    if (journal?.journal_mode?.toLowerCase() !== "wal") fail("storage-invalid", "Review 必须复用 WAL generation ledger。");
    assertBaseSchema(db);
    assertSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function transaction<T>(db: DatabaseSync, callback: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = callback();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function reviewRow(db: DatabaseSync, reviewId: string): ReviewRow | undefined {
  return db.prepare("SELECT * FROM studio_generation_review_events WHERE review_id=?").get(reviewId) as unknown as ReviewRow | undefined;
}

function headRow(db: DatabaseSync, generationRunId: string): ReviewHeadRow | undefined {
  return db.prepare("SELECT * FROM studio_generation_review_heads WHERE generation_run_id=?").get(generationRunId) as unknown as ReviewHeadRow | undefined;
}

function operationRow(db: DatabaseSync, operationId: string): OperationRow | undefined {
  return db.prepare("SELECT operation_id,input_fingerprint,review_id FROM studio_generation_review_operation_receipts WHERE operation_id=?")
    .get(operationId) as unknown as OperationRow | undefined;
}

function parsedJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new StudioGenerationReviewError("storage-invalid", `${label} JSON 已损坏。`, [], { cause: error });
  }
}

function recordFromRow(row: ReviewRow): StudioGenerationReviewRecord {
  const record: StudioGenerationReviewRecord = {
    sequence: Number(row.sequence),
    reviewId: row.review_id,
    generationRunId: row.generation_run_id,
    kind: row.review_kind,
    baseHeadRevision: Number(row.base_head_revision),
    ...(row.head_revision === null ? {} : { headRevision: Number(row.head_revision) }),
    ...(row.supersedes_review_id ? { supersedesReviewId: row.supersedes_review_id } : {}),
    rawResultId: row.raw_result_id,
    rawSha256: row.raw_sha256,
    labeledResultId: row.labeled_result_id,
    labeledSha256: row.labeled_sha256,
    packId: row.pack_id,
    packFingerprint: row.pack_fingerprint,
    continuityFingerprint: row.continuity_fingerprint,
    decision: row.decision,
    criteria: parsedJson<StudioGenerationReviewCriterion[]>(row.criteria_json, "criteria"),
    annotations: parsedJson<StudioGenerationReviewAnnotationInput[]>(row.annotations_json, "annotations"),
    reviewer: row.reviewer,
    note: row.note,
    currentAtSubmission: row.current_at_submission === 1,
    advancesHead: row.advances_head === 1,
    staleReasons: parsedJson<string[]>(row.stale_reasons_json, "staleReasons"),
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
  };
  const semantic = {
    schemaVersion: 1,
    kind: "studio-generation-review",
    generationRunId: record.generationRunId,
    reviewKind: record.kind,
    baseHeadRevision: record.baseHeadRevision,
    ...(record.headRevision === undefined ? {} : { headRevision: record.headRevision }),
    ...(record.supersedesReviewId ? { supersedesReviewId: record.supersedesReviewId } : {}),
    rawResultId: record.rawResultId,
    rawSha256: record.rawSha256,
    labeledResultId: record.labeledResultId,
    labeledSha256: record.labeledSha256,
    packId: record.packId,
    packFingerprint: record.packFingerprint,
    continuityFingerprint: record.continuityFingerprint,
    decision: record.decision,
    criteria: record.criteria,
    annotations: record.annotations,
    reviewer: record.reviewer,
    note: record.note,
    currentAtSubmission: record.currentAtSubmission,
    advancesHead: record.advancesHead,
    staleReasons: record.staleReasons,
  };
  const fingerprint = digest(semantic);
  if (fingerprint !== record.fingerprint || record.reviewId !== `studio-generation-review-${fingerprint.slice(0, 40)}`) {
    fail("storage-invalid", `Review ${record.reviewId} 内容地址已损坏。`);
  }
  return record;
}

async function readPair(projectRoot: string, input: SubmitStudioGenerationReviewInput): Promise<{
  raw: StudioGenerationResultRecord;
  labeled: StudioGenerationResultRecord;
  currentAtSubmission: boolean;
  staleReasons: string[];
}> {
  const [raw, labeled] = await Promise.all([
    readStudioGenerationResult(projectRoot, input.rawResultId),
    readStudioGenerationResult(projectRoot, input.labeledResultId),
  ]);
  if (!raw || !labeled) fail("result-not-found", "Review 引用的 raw/labeled 结果不存在。");
  if (raw.variant !== "raw" || labeled.variant !== "labeled"
    || raw.generationRunId !== input.generationRunId || labeled.generationRunId !== input.generationRunId
    || raw.packId !== labeled.packId || raw.packFingerprint !== labeled.packFingerprint
    || raw.targetKind !== labeled.targetKind || raw.targetKey !== labeled.targetKey
    || raw.mediaSha256 !== input.rawSha256 || labeled.mediaSha256 !== input.labeledSha256
    || raw.packFingerprint !== input.expectedPackFingerprint) {
    fail("result-pair-invalid", "Review 的 raw/labeled/run/pack/SHA 不是同一不可变结果对。");
  }
  let observedPackFingerprint: string | undefined;
  let continuityFingerprint: string | undefined;
  if (raw.targetKind === "unit-grid") {
    const pack = await readStudioUnitGridGenerationFrozenPack(projectRoot, raw.packId);
    observedPackFingerprint = pack?.fingerprint;
    continuityFingerprint = pack?.continuityFingerprint;
  } else {
    const pack = await readStudioGenerationFrozenPack(projectRoot, raw.packId);
    observedPackFingerprint = pack?.fingerprint;
    continuityFingerprint = pack?.continuity.fingerprint;
  }
  if (observedPackFingerprint !== raw.packFingerprint
    || !continuityFingerprint
    || continuityFingerprint !== input.continuityFingerprint) {
    fail(
      "result-pair-invalid",
      "Review continuityFingerprint 必须与该结果对所属冻结包的真实连续性快照一致。",
    );
  }
  const staleReasons = [...new Set([
    ...raw.staleReasons.map((reason) => `raw:${reason}`),
    ...labeled.staleReasons.map((reason) => `labeled:${reason}`),
    ...(!raw.pairComplete || !labeled.pairComplete ? ["raw-labeled-pair-incomplete"] : []),
    ...(!raw.inputCurrent || !labeled.inputCurrent ? ["generation-input-stale"] : []),
  ])].sort((left, right) => left.localeCompare(right, "en"));
  return { raw, labeled, currentAtSubmission: raw.promotionEligible && labeled.promotionEligible, staleReasons };
}

function normalizedInput(input: SubmitStudioGenerationReviewInput) {
  if (input.kind !== "observation" && input.kind !== "correction") fail("invalid-input", "Review kind 必须是 observation/correction。");
  if (input.decision !== "pass" && input.decision !== "rework" && input.decision !== "reject") fail("invalid-input", "Review decision 无效。");
  if (!Number.isSafeInteger(input.expectedHeadRevision) || input.expectedHeadRevision < 0) fail("invalid-input", "expectedHeadRevision 必须为非负整数。");
  const supersedesReviewId = input.supersedesReviewId === undefined ? undefined : normalizedId(input.supersedesReviewId, "supersedesReviewId");
  if (input.kind === "observation" && supersedesReviewId) fail("invalid-input", "observation 不能 supersede Review。");
  if (input.kind === "correction" && !supersedesReviewId) fail("invalid-input", "correction 必须显式 supersede 当前 Review。");
  const criteria = normalizedCriteria(input.criteria);
  const annotations = normalizedAnnotations(input.annotations);
  assertJsonSize(criteria, "criteria");
  assertJsonSize(annotations, "annotations");
  return {
    operationId: normalizedId(input.operationId, "operationId"),
    generationRunId: normalizedId(input.generationRunId, "generationRunId"),
    kind: input.kind,
    expectedHeadRevision: input.expectedHeadRevision,
    ...(supersedesReviewId ? { supersedesReviewId } : {}),
    rawResultId: normalizedId(input.rawResultId, "rawResultId"),
    rawSha256: normalizedSha(input.rawSha256, "rawSha256"),
    labeledResultId: normalizedId(input.labeledResultId, "labeledResultId"),
    labeledSha256: normalizedSha(input.labeledSha256, "labeledSha256"),
    expectedPackFingerprint: normalizedSha(input.expectedPackFingerprint, "expectedPackFingerprint"),
    continuityFingerprint: normalizedSha(input.continuityFingerprint, "continuityFingerprint"),
    decision: input.decision,
    criteria,
    annotations,
    reviewer: requiredText(input.reviewer, "reviewer", 500),
    note: requiredText(input.note, "note", 8_000),
  };
}

function ensureHeadCas(head: ReviewHeadRow | undefined, expected: number, kind: StudioGenerationReviewKind, supersedes?: string): void {
  const actual = head?.revision ?? 0;
  if (actual !== expected) fail("review-conflict", `Review Head CAS 冲突：期望 ${expected}，当前 ${actual}。`);
  if (kind === "observation" && actual !== 0) fail("review-conflict", "已存在 Review Head，后续必须追加 correction。");
  if (kind === "correction" && (!head || head.review_id !== supersedes)) {
    fail("review-conflict", "correction supersedesReviewId 不是当前 Review Head。");
  }
}

export async function submitStudioGenerationReview(
  projectRoot: string,
  rawInput: SubmitStudioGenerationReviewInput,
): Promise<StudioGenerationReviewProjection> {
  const input = normalizedInput(rawInput);
  const databaseContext = await databaseContextFor(projectRoot);
  const inputFingerprint = digest({ schemaVersion: 1, command: "submit-studio-generation-review", ...input });
  const preflightDb = openDatabase(databaseContext);
  try {
    const receipt = operationRow(preflightDb, input.operationId);
    if (receipt) {
      if (receipt.input_fingerprint !== inputFingerprint) fail("operation-conflict", `operationId ${input.operationId} 已绑定不同载荷。`);
      const existing = reviewRow(preflightDb, receipt.review_id);
      if (!existing) fail("storage-invalid", `Review receipt ${input.operationId} 引用孤儿事件。`);
      return projectReview(projectRoot, recordFromRow(existing));
    }
  } finally {
    preflightDb.close();
  }

  const preflightPair = await readPair(projectRoot, input);
  if (process.env.AI_CANVAS_TEST_REVIEW_PREFLIGHT_DELAY_MS) {
    const delay = Math.max(0, Math.min(5_000, Number(process.env.AI_CANVAS_TEST_REVIEW_PREFLIGHT_DELAY_MS) || 0));
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
  // 不使用第一次读取直接推进 Head。公开写入还由 command-bus 的
  // project-level studio-mutation fence 串行；此处再读用于直接 Core 调用与故障注入。
  const pair = await readPair(projectRoot, input);
  if (preflightPair.raw.resultId !== pair.raw.resultId
    || preflightPair.labeled.resultId !== pair.labeled.resultId
    || preflightPair.raw.packFingerprint !== pair.raw.packFingerprint) {
    fail("result-pair-invalid", "Review 结果对在预检与提交间发生身份漂移。");
  }
  const advancesHead = pair.currentAtSubmission;
  const semantic = {
    schemaVersion: 1,
    kind: "studio-generation-review",
    generationRunId: input.generationRunId,
    reviewKind: input.kind,
    baseHeadRevision: input.expectedHeadRevision,
    ...(advancesHead ? { headRevision: input.expectedHeadRevision + 1 } : {}),
    ...(input.supersedesReviewId ? { supersedesReviewId: input.supersedesReviewId } : {}),
    rawResultId: input.rawResultId,
    rawSha256: input.rawSha256,
    labeledResultId: input.labeledResultId,
    labeledSha256: input.labeledSha256,
    packId: pair.raw.packId,
    packFingerprint: pair.raw.packFingerprint,
    continuityFingerprint: input.continuityFingerprint,
    decision: input.decision,
    criteria: input.criteria,
    annotations: input.annotations,
    reviewer: input.reviewer,
    note: input.note,
    currentAtSubmission: pair.currentAtSubmission,
    advancesHead,
    staleReasons: pair.staleReasons,
  };
  const fingerprint = digest(semantic);
  const reviewId = `studio-generation-review-${fingerprint.slice(0, 40)}`;
  const db = openDatabase(databaseContext);
  let written: ReviewRow;
  try {
    written = transaction(db, () => {
      const receipt = operationRow(db, input.operationId);
      if (receipt) {
        if (receipt.input_fingerprint !== inputFingerprint) fail("operation-conflict", `operationId ${input.operationId} 已绑定不同载荷。`);
        const replay = reviewRow(db, receipt.review_id);
        if (!replay) fail("storage-invalid", "Review operation receipt 引用孤儿事件。");
        return replay;
      }
      const head = headRow(db, input.generationRunId);
      ensureHeadCas(head, input.expectedHeadRevision, input.kind, input.supersedesReviewId);
      const exact = reviewRow(db, reviewId);
      const now = new Date().toISOString();
      if (!exact) {
        db.prepare(`
          INSERT INTO studio_generation_review_events(
            review_id,generation_run_id,review_kind,base_head_revision,head_revision,supersedes_review_id,
            raw_result_id,raw_sha256,labeled_result_id,labeled_sha256,pack_id,pack_fingerprint,
            continuity_fingerprint,decision,criteria_json,annotations_json,reviewer,note,
            current_at_submission,advances_head,stale_reasons_json,fingerprint,created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          reviewId, input.generationRunId, input.kind, input.expectedHeadRevision,
          advancesHead ? input.expectedHeadRevision + 1 : null, input.supersedesReviewId ?? null,
          input.rawResultId, input.rawSha256, input.labeledResultId, input.labeledSha256,
          pair.raw.packId, pair.raw.packFingerprint, input.continuityFingerprint, input.decision,
          JSON.stringify(input.criteria), JSON.stringify(input.annotations), input.reviewer, input.note,
          pair.currentAtSubmission ? 1 : 0, advancesHead ? 1 : 0, JSON.stringify(pair.staleReasons), fingerprint, now,
        );
      }
      if (advancesHead) {
        if (!head) {
          db.prepare("INSERT INTO studio_generation_review_heads(generation_run_id,revision,review_id,review_fingerprint,updated_at) VALUES(?,?,?,?,?)")
            .run(input.generationRunId, 1, reviewId, fingerprint, now);
        } else {
          const changed = db.prepare(`
            UPDATE studio_generation_review_heads
            SET revision=?,review_id=?,review_fingerprint=?,updated_at=?
            WHERE generation_run_id=? AND revision=? AND review_id=?
          `).run(head.revision + 1, reviewId, fingerprint, now, input.generationRunId, head.revision, head.review_id);
          if (Number(changed.changes) !== 1) fail("review-conflict", "Review Head 在事务内发生 CAS 漂移。");
        }
      }
      db.prepare(`
        INSERT INTO studio_generation_review_operation_receipts(
          operation_id,input_fingerprint,review_id,outcome_fingerprint,created_at
        ) VALUES(?,?,?,?,?)
      `).run(input.operationId, inputFingerprint, reviewId, fingerprint, now);
      const result = reviewRow(db, reviewId);
      if (!result) fail("storage-invalid", "Review 事件写入后无法读回。");
      return result;
    });
  } finally {
    db.close();
  }
  return projectReview(projectRoot, recordFromRow(written));
}

async function projectReview(projectRoot: string, record: StudioGenerationReviewRecord): Promise<StudioGenerationReviewProjection> {
  const snapshot = await openReviewReadSnapshot(projectRoot, "generation review projection");
  if (!snapshot) fail("storage-invalid", "Review 事件存在但 Review schema 不可读。");
  let head: ReviewHeadRow | undefined;
  try {
    head = headRow(snapshot.database, record.generationRunId);
  } finally {
    await snapshot.close();
  }
  const [raw, labeled] = await Promise.all([
    readStudioGenerationResult(projectRoot, record.rawResultId),
    readStudioGenerationResult(projectRoot, record.labeledResultId),
  ]);
  const headCurrent = Boolean(head && head.review_id === record.reviewId && head.review_fingerprint === record.fingerprint);
  const currentStaleReasons = [...new Set([
    ...(!headCurrent ? ["not-current-review-head"] : []),
    ...(!raw ? ["raw-result-missing"] : raw.staleReasons.map((reason) => `raw:${reason}`)),
    ...(!labeled ? ["labeled-result-missing"] : labeled.staleReasons.map((reason) => `labeled:${reason}`)),
    ...(raw && (raw.mediaSha256 !== record.rawSha256 || raw.packFingerprint !== record.packFingerprint) ? ["raw-identity-drift"] : []),
    ...(labeled && (labeled.mediaSha256 !== record.labeledSha256 || labeled.packFingerprint !== record.packFingerprint) ? ["labeled-identity-drift"] : []),
    ...(raw && !raw.promotionEligible ? ["raw-promotion-ineligible"] : []),
    ...(labeled && !labeled.promotionEligible ? ["labeled-promotion-ineligible"] : []),
  ])].sort((left, right) => left.localeCompare(right, "en"));
  const current = headCurrent && record.advancesHead && currentStaleReasons.length === 0;
  return {
    ...record,
    head: headCurrent,
    current,
    approvedRawEligible: current && record.decision === "pass",
    currentStaleReasons,
  };
}

export async function getStudioGenerationReviewControl(
  projectRoot: string,
  generationRunIdValue: string,
): Promise<StudioGenerationReviewControl> {
  const generationRunId = normalizedId(generationRunIdValue, "generationRunId");
  const snapshot = await openReviewReadSnapshot(projectRoot, "generation review control");
  let head: ReviewHeadRow | undefined;
  let row: ReviewRow | undefined;
  if (snapshot) {
    try {
      head = headRow(snapshot.database, generationRunId);
      if (head) {
        row = reviewRow(snapshot.database, head.review_id);
      } else {
        // 无 head 但有审片事件：通常是 advances_head=0 的 stale 观察（如 pack continuity-opaque）。
        // 仍投影最新事件为 non-current，使 status=stale，checkpoint 可走 existing-slot-rework，
        // 避免「永不 advances_head → 永久 review-missing」死锁。
        row = snapshot.database.prepare(`
          SELECT * FROM studio_generation_review_events
          WHERE generation_run_id=?
          ORDER BY sequence DESC LIMIT 1
        `).get(generationRunId) as unknown as ReviewRow | undefined;
      }
    } finally {
      await snapshot.close();
    }
  }
  const projection = row ? await projectReview(projectRoot, recordFromRow(row)) : undefined;
  const status: StudioGenerationReviewControl["status"] = !projection ? "unreviewed"
    : !projection.current ? "stale"
      : projection.decision;
  const blockers = !projection ? ["review-missing"]
    : !projection.current ? projection.currentStaleReasons
      : projection.decision === "pass" ? [] : [`review-${projection.decision}`];
  const nextAction: StudioGenerationReviewControl["nextAction"] = !projection ? "submit-observation"
    : projection.current && projection.decision === "pass" ? "approved-raw-ready"
      : "submit-correction";
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-generation-review-control" as const,
    generationRunId,
    headRevision: head?.revision ?? 0,
    ...(projection ? { head: projection } : {}),
    status,
    blockers,
    nextAction,
  };
  return { ...semantic, fingerprint: digest(semantic) };
}

export async function readStudioGenerationReview(
  projectRoot: string,
  reviewIdValue: string,
): Promise<StudioGenerationReviewProjection | null> {
  const reviewId = normalizedId(reviewIdValue, "reviewId");
  const snapshot = await openReviewReadSnapshot(projectRoot, "generation review read");
  if (!snapshot) return null;
  let row: ReviewRow | undefined;
  try {
    row = reviewRow(snapshot.database, reviewId);
  } finally {
    await snapshot.close();
  }
  return row ? projectReview(projectRoot, recordFromRow(row)) : null;
}

/**
 * 命令总线崩溃恢复只读业务事务内的不可变 receipt，绝不重放 Review。
 */
export async function readStudioGenerationReviewOperationOutcome(
  projectRoot: string,
  operationIdValue: string,
): Promise<StudioGenerationReviewProjection | null> {
  const operationId = normalizedId(operationIdValue, "operationId");
  const snapshot = await openReviewReadSnapshot(projectRoot, "generation review operation outcome read");
  if (!snapshot) return null;
  let receipt: OperationRow | undefined;
  let row: ReviewRow | undefined;
  try {
    receipt = operationRow(snapshot.database, operationId);
    if (receipt) row = reviewRow(snapshot.database, receipt.review_id);
  } finally {
    await snapshot.close();
  }
  if (!receipt) return null;
  if (!row) fail("storage-invalid", `Review operation ${operationId} 引用孤儿事件。`);
  return projectReview(projectRoot, recordFromRow(row));
}

function normalizedLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_HISTORY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) fail("invalid-input", `limit 必须是 1-${MAX_HISTORY_LIMIT}。`);
  return limit;
}

function cursorScope(generationRunId: string): string {
  return digest({ schemaVersion: 1, kind: "studio-generation-review-history", generationRunId }).slice(0, 24);
}

function decodeCursor(cursor: string | undefined, scope: string): number | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; scope?: unknown; sequence?: unknown };
    if (parsed.v !== 1 || parsed.scope !== scope || !Number.isSafeInteger(parsed.sequence) || Number(parsed.sequence) < 1) throw new Error("invalid");
    return Number(parsed.sequence);
  } catch {
    fail("invalid-cursor", "Review history cursor 无效或不属于当前 run。");
  }
}

function encodeCursor(scope: string, sequence: number): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, sequence }), "utf8").toString("base64url");
}

export async function listStudioGenerationReviewHistory(
  projectRoot: string,
  query: StudioGenerationReviewHistoryQuery,
): Promise<StudioGenerationReviewHistoryPage> {
  const generationRunId = normalizedId(query.generationRunId, "generationRunId");
  const limit = normalizedLimit(query.limit);
  const scope = cursorScope(generationRunId);
  const after = decodeCursor(query.cursor, scope);
  const snapshot = await openReviewReadSnapshot(projectRoot, "generation review history");
  if (!snapshot) return { items: [] };
  let rows: ReviewRow[];
  try {
    rows = snapshot.database.prepare(`
      SELECT * FROM studio_generation_review_events
      WHERE generation_run_id=? AND (? IS NULL OR sequence>?)
      ORDER BY sequence ASC LIMIT ?
    `).all(generationRunId, after ?? null, after ?? null, limit + 1) as unknown as ReviewRow[];
  } finally {
    await snapshot.close();
  }
  const pageRows = rows.slice(0, limit);
  return {
    items: await Promise.all(pageRows.map((row) => projectReview(projectRoot, recordFromRow(row)))),
    ...(rows.length > limit ? { nextCursor: encodeCursor(scope, Number(pageRows.at(-1)!.sequence)) } : {}),
  };
}
