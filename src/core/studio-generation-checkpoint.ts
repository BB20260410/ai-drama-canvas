/**
 * Managed Studio 每六张生产图的一致性停检。
 *
 * raw + labeled 同 generationRunId 只形成一个完整结果；同 unitId + panelId
 * 永远属于同一生产槽位。checkpoint 与 attestation 只追加不可变事件，当前指针
 * 通过独立 CAS Head 推进，并与 operation receipt 在同一 SQLite 事务提交。
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspectManagedProject } from "./managed-project.js";
import {
  assertSafeSqliteSidecars,
  assertSqliteSourceBindingIdentity,
  openSqliteReadOnlySnapshot,
  type SqliteSourceBindingIdentity,
} from "./sqlite-readonly-snapshot.js";
import { assertSqliteSchemaContract } from "./sqlite-schema-contract.js";
import {
  initializeStudioGenerationLedger,
  isStudioGenerationUnknownOwnerAbandonDetail,
  readStudioGenerationFrozenPack,
  readStudioUnitGridGenerationFrozenPack,
  StudioGenerationLedgerError,
} from "./studio-generation-ledger.js";
import {
  getStudioGenerationReviewControl,
  readStudioGenerationReview,
  type StudioGenerationReviewDecision,
  type StudioGenerationReviewProjection,
} from "./studio-generation-review.js";

const DATABASE_RELATIVE_PATH = ".aicanvas/studio-generation-ledger.sqlite";
const CHECKPOINT_SCHEMA_VERSION = 1;
const CHECKPOINT_MEMBER_COUNT = 6;
const BUSY_TIMEOUT_MS = 5_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;

export type StudioGenerationCheckpointErrorCode =
  | "unmanaged-project"
  | "invalid-input"
  | "storage-invalid"
  | "checkpoint-not-found"
  | "checkpoint-not-ready"
  | "checkpoint-conflict"
  | "attestation-conflict"
  | "operation-conflict"
  | "checkpoint-required";

export class StudioGenerationCheckpointError extends Error {
  readonly code: StudioGenerationCheckpointErrorCode;
  readonly details: string[];

  constructor(
    code: StudioGenerationCheckpointErrorCode,
    message: string,
    details: string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StudioGenerationCheckpointError";
    this.code = code;
    this.details = details;
  }
}

export interface StudioGenerationCheckpointMember {
  slotOrdinal: number;
  slotKey: string;
  unitId: string;
  panelId: string;
  /** 旧 panel checkpoint 缺省；unit-grid 新成员显式写入，panelId 此时等于 targetKey 而非兼容锚点。 */
  targetKind?: "unit-grid";
  targetKey?: string;
  generationRunId: string;
  rawResultId: string;
  rawSha256: string;
  labeledResultId: string;
  labeledSha256: string;
  packId: string;
  packFingerprint: string;
  reviewHeadRevision: number;
  reviewId: string;
  reviewFingerprint: string;
  reviewDecision: StudioGenerationReviewDecision;
  reviewCurrent: boolean;
  reviewStaleReasons: string[];
  continuityFingerprint: string;
  fingerprint: string;
}

export interface StudioGenerationCheckpointCandidate {
  schemaVersion: 1;
  kind: "studio-generation-checkpoint";
  checkpointId: string;
  batchNumber: number;
  members: StudioGenerationCheckpointMember[];
  eligibleForPass: boolean;
  blockers: string[];
  fingerprint: string;
}

export interface StudioGenerationCheckpointRecord extends StudioGenerationCheckpointCandidate {
  sequence: number;
  createdAt: string;
}

export interface StudioGenerationCheckpointProjection extends StudioGenerationCheckpointRecord {
  head: boolean;
  headRevision: number;
  current: boolean;
  currentStaleReasons: string[];
}

export type StudioGenerationCheckpointAttestationDecision = "pass" | "rework";

export interface StudioGenerationCheckpointAttestationRecord {
  sequence: number;
  attestationId: string;
  batchNumber: number;
  checkpointId: string;
  checkpointFingerprint: string;
  decision: StudioGenerationCheckpointAttestationDecision;
  baseHeadRevision: number;
  headRevision: number;
  reviewer: string;
  note: string;
  fingerprint: string;
  createdAt: string;
}

export interface StudioGenerationCheckpointAttestationProjection
  extends StudioGenerationCheckpointAttestationRecord {
  head: boolean;
  current: boolean;
  currentStaleReasons: string[];
}

export type StudioGenerationCheckpointBatchStatus =
  | "review-blocked"
  | "refresh-required"
  | "attestation-required"
  | "passed";

export interface StudioGenerationCheckpointBatchControl {
  batchNumber: number;
  slotOrdinals: number[];
  status: StudioGenerationCheckpointBatchStatus;
  blockers: string[];
  checkpointHeadRevision: number;
  attestationHeadRevision: number;
  liveCheckpoint?: StudioGenerationCheckpointCandidate;
  checkpoint?: StudioGenerationCheckpointProjection;
  attestation?: StudioGenerationCheckpointAttestationProjection;
}

export interface StudioGenerationCheckpointControl {
  schemaVersion: 1;
  kind: "studio-generation-checkpoint-control";
  completedSlotCount: number;
  fullBatchCount: number;
  collectingSlotCount: number;
  batches: StudioGenerationCheckpointBatchControl[];
  blockingBatchNumber?: number;
  newSlotDispatchAllowed: boolean;
  fingerprint: string;
}

/**
 * 驾驶舱首屏只需要知道“能否安全显示新槽派发入口”。
 * 它不重算历史批次的 raw/labeled/review/pack 深校验：
 * - 账本 checkpoint/attestation/Review head 闭合时，可以显示当前停检状态；
 * - 不把账本闭合误表述为媒体、冻结参考或视觉质量已重新深核验；
 * - 正式 dispatch 仍走完整的 assertStudioGenerationCheckpointDispatchAllowed，
 *   因而此投影绝不扩大派发权限。
 */
export interface StudioGenerationCheckpointDashboardGate {
  schemaVersion: 1;
  kind: "studio-generation-checkpoint-dashboard-gate";
  completedSlotCount: number;
  fullBatchCount: number;
  collectingSlotCount: number;
  evaluatedBatchCount: number;
  blockingBatchNumber?: number;
  newSlotDispatchAllowed: boolean;
  /**
   * 首屏不读取 raw/labeled/pack 的全量深校验。即使账本当前，正式
   * dispatch 仍必须由完整 dispatch gate 重新复核。
   */
  verification: "verified" | "unverified-history";
  fingerprint: string;
}

/**
 * 画布时间线使用的轻量“停检存证”投影。
 *
 * 它只证明 SQLite 账本中的 immutable checkpoint / attestation / 当前槽位 /
 * Review head 相互闭合，不读取媒体 CAS、也不重新打开每个冻结包。后两项仍由
 * 正式 dispatch gate 和画布的逐项深核验负责；因此这里绝不将 ledger 验证表述为
 * 媒体或参考图已重新验真。
 */
export interface StudioGenerationCheckpointCanvasUnitGridProjection {
  unitId: string;
  generationRunId: string;
  /** 当前 raw/labeled 所属 immutable dispatch 的实际执行来源。 */
  provider: "codex" | "grok";
  packId: string;
  packFingerprint: string;
  rawMediaSha256: string;
  labeledMediaSha256: string;
  reviewId: string;
  continuityFingerprint: string;
  checkpointBatchNumber: number;
  checkpointId: string;
  checkpointFingerprint: string;
  attestationId: string;
  attestationFingerprint: string;
}

export interface StudioGenerationCheckpointCanvasProjection {
  schemaVersion: 1;
  kind: "studio-generation-checkpoint-canvas-projection";
  completedSlotCount: number;
  fullBatchCount: number;
  collectingSlotCount: number;
  /** 通过账本闭合验证的 unit-grid 整板；媒体及冻结参考仍待按需深核验。 */
  attestedUnitGrid: StudioGenerationCheckpointCanvasUnitGridProjection[];
  /** false 时必须关闭派发，并且不得把本投影中的 raw 当正式素材。 */
  ledgerCurrent: boolean;
  blockers: string[];
  fingerprint: string;
}

export interface RefreshStudioGenerationCheckpointInput {
  operationId: string;
  batchNumber: number;
  expectedHeadRevision: number;
}

export interface AttestStudioGenerationCheckpointInput {
  operationId: string;
  batchNumber: number;
  checkpointId: string;
  checkpointFingerprint: string;
  expectedHeadRevision: number;
  decision: StudioGenerationCheckpointAttestationDecision;
  reviewer: string;
  note: string;
}

export type StudioGenerationCheckpointDispatchInput =
  | { targetKind?: "panel"; unitId: string; panelId: string; excludeRunId?: string }
  | { targetKind: "unit-grid"; unitId: string; excludeRunId?: string };

export interface StudioGenerationCheckpointDispatchGate {
  allowed: true;
  reason: "existing-slot-rework" | "checkpoint-not-yet-due" | "checkpoint-pass-current";
  completedSlotCount: number;
  blockingBatchNumber?: number;
}

interface StudioGenerationCheckpointOperationReceiptBase {
  schemaVersion: 1;
  kind: "studio-generation-checkpoint-operation-receipt";
  operationId: string;
  inputFingerprint: string;
  outcomeId: string;
  outcomeFingerprint: string;
  createdAt: string;
}

export type StudioGenerationCheckpointOperationReceipt =
  | StudioGenerationCheckpointOperationReceiptBase & {
    operationKind: "refresh";
    outcomeKind: "checkpoint";
    outcome: StudioGenerationCheckpointProjection;
  }
  | StudioGenerationCheckpointOperationReceiptBase & {
    operationKind: "attest";
    outcomeKind: "attestation";
    outcome: StudioGenerationCheckpointAttestationProjection;
  };

interface GenerationResultRow {
  sequence: number;
  result_id: string;
  generation_run_id: string;
  variant: "raw" | "labeled";
  media_sha256: string;
  pack_id: string;
  pack_fingerprint: string;
  unit_id: string;
  panel_id: string;
  target_kind: "panel" | "unit-grid";
  target_key: string;
}

interface CompletePair {
  generationRunId: string;
  firstSequence: number;
  lastSequence: number;
  unitId: string;
  panelId: string;
  targetKind: "panel" | "unit-grid";
  targetKey: string;
  rawResultId: string;
  rawSha256: string;
  labeledResultId: string;
  labeledSha256: string;
  packId: string;
  packFingerprint: string;
}

interface ProductionSlot {
  slotOrdinal: number;
  slotKey: string;
  firstSequence: number;
  unitId: string;
  panelId: string;
  targetKind: "panel" | "unit-grid";
  targetKey: string;
  currentPair: CompletePair;
}

interface ReviewHeadRow {
  generation_run_id: string;
  revision: number;
  review_id: string;
  review_fingerprint: string;
  review_sequence: number;
}

interface DispatchProviderRow {
  generation_run_id: string;
  executor_provider: "codex" | "grok";
}

interface CheckpointRow {
  sequence: number;
  checkpoint_id: string;
  batch_number: number;
  members_json: string;
  eligible_for_pass: number;
  blockers_json: string;
  fingerprint: string;
  created_at: string;
}

interface CheckpointHeadRow {
  batch_number: number;
  revision: number;
  checkpoint_id: string;
  checkpoint_fingerprint: string;
  updated_at: string;
}

interface AttestationRow {
  sequence: number;
  attestation_id: string;
  batch_number: number;
  checkpoint_id: string;
  checkpoint_fingerprint: string;
  decision: StudioGenerationCheckpointAttestationDecision;
  base_head_revision: number;
  head_revision: number;
  reviewer: string;
  note: string;
  fingerprint: string;
  created_at: string;
}

interface AttestationHeadRow {
  batch_number: number;
  revision: number;
  attestation_id: string;
  attestation_fingerprint: string;
  updated_at: string;
}

interface OperationReceiptRow {
  operation_id: string;
  operation_kind: "refresh" | "attest";
  input_fingerprint: string;
  outcome_kind: "checkpoint" | "attestation";
  outcome_id: string;
  outcome_fingerprint: string;
  created_at: string;
}

interface LedgerSnapshot {
  slots: ProductionSlot[];
  dispatchProviders: Map<string, "codex" | "grok">;
  reviewHeads: Map<string, ReviewHeadRow>;
  checkpointRows: Map<string, CheckpointRow>;
  checkpointHeads: Map<number, CheckpointHeadRow>;
  attestationRows: Map<string, AttestationRow>;
  attestationHeads: Map<number, AttestationHeadRow>;
}

interface LiveBatch {
  batchNumber: number;
  slots: ProductionSlot[];
  candidate?: StudioGenerationCheckpointCandidate;
  blockers: string[];
}

function fail(
  code: StudioGenerationCheckpointErrorCode,
  message: string,
  details: string[] = [],
): never {
  throw new StudioGenerationCheckpointError(code, message, details);
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
  if (typeof value !== "string") fail("invalid-input", label + " 必须是字符串。");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    fail("invalid-input", label + " 必须是 1-" + maximum + " 个字符。");
  }
  return normalized;
}

function normalizedId(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 255);
  if (!ID_PATTERN.test(normalized)) fail("invalid-input", label + " 不是稳定 ID。");
  return normalized;
}

function normalizedSha(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 64);
  if (!SHA256_PATTERN.test(normalized)) fail("invalid-input", label + " 必须是 64 位小写 SHA-256。");
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail("invalid-input", label + " 必须是正整数。");
  return Number(value);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail("invalid-input", label + " 必须是非负整数。");
  return Number(value);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "en"));
}

function parsedJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new StudioGenerationCheckpointError(
      "storage-invalid",
      label + " JSON 已损坏。",
      [],
      { cause: error },
    );
  }
}

interface CheckpointDatabaseContext {
  databasePath: string;
  readonly sourceIdentity: SqliteSourceBindingIdentity;
}

async function databaseContextFor(projectRoot: string): Promise<CheckpointDatabaseContext> {
  try {
    await initializeStudioGenerationLedger(projectRoot);
    const shell = await inspectManagedProject(projectRoot);
    const databasePath = path.join(shell.paths.root, DATABASE_RELATIVE_PATH);
    await ensureCheckpointSchema(databasePath);
    let snapshot: Awaited<ReturnType<typeof openSqliteReadOnlySnapshot>> | null = null;
    try {
      snapshot = await openSqliteReadOnlySnapshot(databasePath, "generation checkpoint ledger operation");
      assertBaseSchema(snapshot.database);
      assertSchema(snapshot.database);
      return { databasePath, sourceIdentity: snapshot.sourceIdentity };
    } finally {
      await snapshot?.close();
    }
  } catch (error) {
    if (error instanceof StudioGenerationCheckpointError) throw error;
    const dependencyCode = error instanceof StudioGenerationLedgerError ? error.code : undefined;
    throw new StudioGenerationCheckpointError(
      dependencyCode === "unmanaged-project" ? "unmanaged-project"
        : dependencyCode === "invalid-input" ? "invalid-input"
          : "storage-invalid",
      dependencyCode === "unmanaged-project"
        ? "六图停检只允许读取或写入受管 Studio 项目。"
        : "六图停检无法初始化共享 generation ledger。",
      error instanceof StudioGenerationLedgerError ? error.details : [],
      { cause: error },
    );
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE studio_generation_checkpoint_snapshots (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      checkpoint_id TEXT NOT NULL UNIQUE,
      batch_number INTEGER NOT NULL CHECK(batch_number >= 1),
      members_json TEXT NOT NULL,
      eligible_for_pass INTEGER NOT NULL CHECK(eligible_for_pass IN (0, 1)),
      blockers_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE(checkpoint_id, fingerprint)
    ) STRICT;

    CREATE TABLE studio_generation_checkpoint_heads (
      batch_number INTEGER PRIMARY KEY CHECK(batch_number >= 1),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      checkpoint_id TEXT NOT NULL,
      checkpoint_fingerprint TEXT NOT NULL CHECK(length(checkpoint_fingerprint) = 64),
      updated_at TEXT NOT NULL,
      FOREIGN KEY(checkpoint_id, checkpoint_fingerprint)
        REFERENCES studio_generation_checkpoint_snapshots(checkpoint_id, fingerprint) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE studio_generation_checkpoint_attestations (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      attestation_id TEXT NOT NULL UNIQUE,
      batch_number INTEGER NOT NULL CHECK(batch_number >= 1),
      checkpoint_id TEXT NOT NULL,
      checkpoint_fingerprint TEXT NOT NULL CHECK(length(checkpoint_fingerprint) = 64),
      decision TEXT NOT NULL CHECK(decision IN ('pass', 'rework')),
      base_head_revision INTEGER NOT NULL CHECK(base_head_revision >= 0),
      head_revision INTEGER NOT NULL CHECK(head_revision = base_head_revision + 1),
      reviewer TEXT NOT NULL,
      note TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE(attestation_id, fingerprint),
      FOREIGN KEY(checkpoint_id, checkpoint_fingerprint)
        REFERENCES studio_generation_checkpoint_snapshots(checkpoint_id, fingerprint) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE studio_generation_checkpoint_attestation_heads (
      batch_number INTEGER PRIMARY KEY CHECK(batch_number >= 1),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      attestation_id TEXT NOT NULL,
      attestation_fingerprint TEXT NOT NULL CHECK(length(attestation_fingerprint) = 64),
      updated_at TEXT NOT NULL,
      FOREIGN KEY(attestation_id, attestation_fingerprint)
        REFERENCES studio_generation_checkpoint_attestations(attestation_id, fingerprint) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE studio_generation_checkpoint_operation_receipts (
      operation_id TEXT PRIMARY KEY,
      operation_kind TEXT NOT NULL CHECK(operation_kind IN ('refresh', 'attest')),
      input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint) = 64),
      outcome_kind TEXT NOT NULL CHECK(outcome_kind IN ('checkpoint', 'attestation')),
      outcome_id TEXT NOT NULL,
      outcome_fingerprint TEXT NOT NULL CHECK(length(outcome_fingerprint) = 64),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX studio_generation_checkpoint_snapshot_batch_idx
      ON studio_generation_checkpoint_snapshots(batch_number, sequence);
    CREATE INDEX studio_generation_checkpoint_attestation_batch_idx
      ON studio_generation_checkpoint_attestations(batch_number, sequence);

    CREATE TRIGGER studio_generation_checkpoint_snapshots_no_update
      BEFORE UPDATE ON studio_generation_checkpoint_snapshots
      BEGIN SELECT RAISE(ABORT, 'generation checkpoint snapshots are append-only'); END;
    CREATE TRIGGER studio_generation_checkpoint_snapshots_no_delete
      BEFORE DELETE ON studio_generation_checkpoint_snapshots
      BEGIN SELECT RAISE(ABORT, 'generation checkpoint snapshots are append-only'); END;
    CREATE TRIGGER studio_generation_checkpoint_attestations_no_update
      BEFORE UPDATE ON studio_generation_checkpoint_attestations
      BEGIN SELECT RAISE(ABORT, 'generation checkpoint attestations are append-only'); END;
    CREATE TRIGGER studio_generation_checkpoint_attestations_no_delete
      BEFORE DELETE ON studio_generation_checkpoint_attestations
      BEGIN SELECT RAISE(ABORT, 'generation checkpoint attestations are append-only'); END;
    CREATE TRIGGER studio_generation_checkpoint_receipts_no_update
      BEFORE UPDATE ON studio_generation_checkpoint_operation_receipts
      BEGIN SELECT RAISE(ABORT, 'generation checkpoint receipts are append-only'); END;
    CREATE TRIGGER studio_generation_checkpoint_receipts_no_delete
      BEFORE DELETE ON studio_generation_checkpoint_operation_receipts
      BEGIN SELECT RAISE(ABORT, 'generation checkpoint receipts are append-only'); END;
    CREATE TRIGGER studio_generation_checkpoint_heads_no_delete
      BEFORE DELETE ON studio_generation_checkpoint_heads
      BEGIN SELECT RAISE(ABORT, 'generation checkpoint heads cannot be deleted'); END;
    CREATE TRIGGER studio_generation_checkpoint_attestation_heads_no_delete
      BEFORE DELETE ON studio_generation_checkpoint_attestation_heads
      BEGIN SELECT RAISE(ABORT, 'generation checkpoint attestation heads cannot be deleted'); END;
  `);
}

const CHECKPOINT_TABLE_COLUMNS: Record<string, string[]> = {
  studio_generation_checkpoint_snapshots: [
    "sequence", "checkpoint_id", "batch_number", "members_json", "eligible_for_pass", "blockers_json",
    "fingerprint", "created_at",
  ],
  studio_generation_checkpoint_heads: [
    "batch_number", "revision", "checkpoint_id", "checkpoint_fingerprint", "updated_at",
  ],
  studio_generation_checkpoint_attestations: [
    "sequence", "attestation_id", "batch_number", "checkpoint_id", "checkpoint_fingerprint", "decision",
    "base_head_revision", "head_revision", "reviewer", "note", "fingerprint", "created_at",
  ],
  studio_generation_checkpoint_attestation_heads: [
    "batch_number", "revision", "attestation_id", "attestation_fingerprint", "updated_at",
  ],
  studio_generation_checkpoint_operation_receipts: [
    "operation_id", "operation_kind", "input_fingerprint", "outcome_kind", "outcome_id", "outcome_fingerprint", "created_at",
  ],
};
const CHECKPOINT_INDEXES = [
  "studio_generation_checkpoint_snapshot_batch_idx",
  "studio_generation_checkpoint_attestation_batch_idx",
] as const;
const CHECKPOINT_TRIGGERS = [
  "studio_generation_checkpoint_snapshots_no_update",
  "studio_generation_checkpoint_snapshots_no_delete",
  "studio_generation_checkpoint_attestations_no_update",
  "studio_generation_checkpoint_attestations_no_delete",
  "studio_generation_checkpoint_receipts_no_update",
  "studio_generation_checkpoint_receipts_no_delete",
  "studio_generation_checkpoint_heads_no_delete",
  "studio_generation_checkpoint_attestation_heads_no_delete",
] as const;

function schemaObjectExists(db: DatabaseSync, name: string, type: "index" | "trigger"): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type=? AND name=?").get(type, name));
}

function assertSchema(db: DatabaseSync): void {
  const marker = db.prepare(
    "SELECT value FROM studio_generation_ledger_meta WHERE key='p7_checkpoint_schema_version'",
  ).get() as { value?: string } | undefined;
  if (marker?.value !== String(CHECKPOINT_SCHEMA_VERSION)) {
    fail("storage-invalid", "六图停检 schema marker 无效：" + (marker?.value ?? "缺失") + "。");
  }
  const actualTables = (db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name GLOB 'studio_generation_checkpoint_*'
    ORDER BY name
  `).all() as Array<{ name: string }>).map((row) => row.name);
  const expectedTables = Object.keys(CHECKPOINT_TABLE_COLUMNS).sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    fail("storage-invalid", "六图停检 tables 与声明 schema 不一致。");
  }
  for (const [table, expected] of Object.entries(CHECKPOINT_TABLE_COLUMNS)) {
    const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail("storage-invalid", `六图停检 table ${table} 列定义与声明 schema 不一致。`);
    }
  }
  for (const index of CHECKPOINT_INDEXES) if (!schemaObjectExists(db, index, "index")) fail("storage-invalid", `六图停检 index ${index} 缺失。`);
  for (const trigger of CHECKPOINT_TRIGGERS) if (!schemaObjectExists(db, trigger, "trigger")) fail("storage-invalid", `六图停检 trigger ${trigger} 缺失。`);
  const expected = new DatabaseSync(":memory:");
  try {
    createSchema(expected);
    assertSqliteSchemaContract({
      actual: db,
      expected,
      objectNames: [...Object.keys(CHECKPOINT_TABLE_COLUMNS), ...CHECKPOINT_INDEXES, ...CHECKPOINT_TRIGGERS],
      tableNames: Object.keys(CHECKPOINT_TABLE_COLUMNS),
      ownedObjectPrefixes: ["studio_generation_checkpoint_"],
      rejectAllViews: true,
      label: "Checkpoint",
    });
  } catch (error) {
    if (error instanceof StudioGenerationCheckpointError) throw error;
    fail("storage-invalid", error instanceof Error ? error.message : "Checkpoint 完整 schema 合同不一致。");
  } finally {
    expected.close();
  }
  if ((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length > 0) {
    fail("storage-invalid", "六图停检账本存在外键孤儿。");
  }
}

function checkpointSchemaObjects(db: DatabaseSync): Array<{ type: string; name: string }> {
  return db.prepare(`
    SELECT type, name FROM sqlite_master
    WHERE name GLOB 'studio_generation_checkpoint_*'
    ORDER BY type, name
  `).all() as Array<{ type: string; name: string }>;
}

function assertBaseSchema(db: DatabaseSync): void {
  const baseVersion = db.prepare(
    "SELECT value FROM studio_generation_ledger_meta WHERE key='schema_version'",
  ).get() as { value?: string } | undefined;
  if (!baseVersion?.value || !["2", "3", "4", "5", "6", "7"].includes(baseVersion.value)) {
    fail("storage-invalid", "六图停检要求已初始化的 generation ledger v2-v7。");
  }
}

async function ensureCheckpointSchema(databasePath: string): Promise<void> {
  let snapshot: Awaited<ReturnType<typeof openSqliteReadOnlySnapshot>> | null = null;
  let sourceIdentity: SqliteSourceBindingIdentity | null = null;
  let needsInitialization = false;
  try {
    snapshot = await openSqliteReadOnlySnapshot(databasePath, "generation checkpoint ledger");
    sourceIdentity = snapshot.sourceIdentity;
    assertBaseSchema(snapshot.database);
    const marker = snapshot.database.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key='p7_checkpoint_schema_version'",
    ).get() as { value?: string } | undefined;
    if (marker) {
      if (marker.value !== String(CHECKPOINT_SCHEMA_VERSION)) {
        fail("storage-invalid", "不支持六图停检 schema " + marker.value + "。");
      }
      assertSchema(snapshot.database);
      return;
    }
    const residual = checkpointSchemaObjects(snapshot.database);
    if (residual.length > 0) {
      fail("storage-invalid", "六图停检 schema marker 缺失但已存在业务对象，禁止猜测或静默修复。", residual.map((item) => `${item.type}:${item.name}`));
    }
    needsInitialization = true;
  } finally {
    await snapshot?.close();
  }
  if (!needsInitialization) return;

  if (!sourceIdentity) fail("storage-invalid", "六图停检首次初始化缺少只读预检身份。");
  assertSqliteSourceBindingIdentity(databasePath, sourceIdentity, "generation checkpoint ledger");
  assertSafeSqliteSidecars(databasePath, "generation checkpoint ledger");

  const db = new DatabaseSync(databasePath, { timeout: BUSY_TIMEOUT_MS });
  try {
    assertSafeSqliteSidecars(databasePath, "generation checkpoint ledger");
    assertSqliteSourceBindingIdentity(databasePath, sourceIdentity, "generation checkpoint ledger");
    db.exec("PRAGMA busy_timeout=" + BUSY_TIMEOUT_MS + "; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;");
    db.exec("BEGIN IMMEDIATE");
    try {
      assertBaseSchema(db);
      const marker = db.prepare(
        "SELECT value FROM studio_generation_ledger_meta WHERE key='p7_checkpoint_schema_version'",
      ).get() as { value?: string } | undefined;
      if (marker) {
        if (marker.value !== String(CHECKPOINT_SCHEMA_VERSION)) fail("storage-invalid", "不支持六图停检 schema " + marker.value + "。");
        assertSchema(db);
      } else {
        const residual = checkpointSchemaObjects(db);
        if (residual.length > 0) {
          fail("storage-invalid", "六图停检 schema 首次初始化发现无 marker 残留对象。", residual.map((item) => `${item.type}:${item.name}`));
        }
        createSchema(db);
        db.prepare("INSERT INTO studio_generation_ledger_meta(key,value) VALUES('p7_checkpoint_schema_version', ?)")
          .run(String(CHECKPOINT_SCHEMA_VERSION));
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

function openDatabase(context: CheckpointDatabaseContext): DatabaseSync {
  assertSafeSqliteSidecars(context.databasePath, "generation checkpoint ledger");
  assertSqliteSourceBindingIdentity(context.databasePath, context.sourceIdentity, "generation checkpoint ledger");
  const db = new DatabaseSync(context.databasePath, { timeout: BUSY_TIMEOUT_MS });
  try {
    assertSafeSqliteSidecars(context.databasePath, "generation checkpoint ledger");
    assertSqliteSourceBindingIdentity(context.databasePath, context.sourceIdentity, "generation checkpoint ledger");
    db.exec("PRAGMA busy_timeout=" + BUSY_TIMEOUT_MS + "; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;");
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    if (journal?.journal_mode?.toLowerCase() !== "wal") fail("storage-invalid", "六图停检必须复用 WAL generation ledger。");
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

function slotIdentity(unitId: string, panelId: string): string {
  return "studio-production-slot-" + digest({ unitId, panelId }).slice(0, 40);
}

function loadPairedSlotsFromDatabase(db: DatabaseSync): ProductionSlot[] {
  const rows = db.prepare(`
    SELECT result.sequence,result.result_id,result.generation_run_id,result.variant,result.media_sha256,
           result.pack_id,result.pack_fingerprint,result.unit_id,
           CASE WHEN target.pack_id IS NULL THEN result.panel_id ELSE target.target_key END AS panel_id,
           CASE WHEN target.pack_id IS NULL THEN 'panel' ELSE 'unit-grid' END AS target_kind,
           CASE WHEN target.pack_id IS NULL
             THEN 'panel:' || result.unit_id || ':' || result.panel_id
             ELSE target.target_key END AS target_key
    FROM studio_generation_results result
    LEFT JOIN studio_generation_pack_targets target
      ON target.pack_id=result.pack_id AND target.pack_fingerprint=result.pack_fingerprint
    ORDER BY result.sequence ASC
  `).all() as unknown as GenerationResultRow[];
  const runs = new Map<string, GenerationResultRow[]>();
  for (const row of rows) {
    const values = runs.get(row.generation_run_id) ?? [];
    values.push(row);
    runs.set(row.generation_run_id, values);
  }
  const pairs: CompletePair[] = [];
  for (const [generationRunId, runRows] of runs) {
    if (runRows.length < 2) continue;
    if (runRows.length !== 2
      || new Set(runRows.map((row) => row.variant)).size !== 2
      || !runRows.some((row) => row.variant === "raw")
      || !runRows.some((row) => row.variant === "labeled")) {
      fail("storage-invalid", "generationRunId=" + generationRunId + " 的 raw/labeled 结果集合无效。");
    }
    const raw = runRows.find((row) => row.variant === "raw")!;
    const labeled = runRows.find((row) => row.variant === "labeled")!;
    if (raw.unit_id !== labeled.unit_id
      || raw.panel_id !== labeled.panel_id
      || raw.target_kind !== labeled.target_kind
      || raw.target_key !== labeled.target_key
      || raw.pack_id !== labeled.pack_id
      || raw.pack_fingerprint !== labeled.pack_fingerprint) {
      fail("storage-invalid", "generationRunId=" + generationRunId + " 的 raw/labeled 不属于同一生产槽位和 pack。");
    }
    pairs.push({
      generationRunId,
      firstSequence: Math.min(Number(raw.sequence), Number(labeled.sequence)),
      lastSequence: Math.max(Number(raw.sequence), Number(labeled.sequence)),
      unitId: raw.unit_id,
      panelId: raw.panel_id,
      targetKind: raw.target_kind,
      targetKey: raw.target_key,
      rawResultId: raw.result_id,
      rawSha256: raw.media_sha256,
      labeledResultId: labeled.result_id,
      labeledSha256: labeled.media_sha256,
      packId: raw.pack_id,
      packFingerprint: raw.pack_fingerprint,
    });
  }

  const slots = new Map<string, Omit<ProductionSlot, "slotOrdinal">>();
  // 槽位第一次“成为完整 raw+labeled 对”的时刻由第二条结果的 sequence 决定。
  // 不能按第一条结果排序，否则一个长期缺少 labeled 的旧 raw 会在补齐后倒插进
  // 已形成的六槽批次，破坏 checkpoint 成员稳定性。
  for (const pair of pairs.sort((left, right) => left.lastSequence - right.lastSequence
    || left.generationRunId.localeCompare(right.generationRunId, "en"))) {
    const slotKey = slotIdentity(pair.unitId, pair.panelId);
    const current = slots.get(slotKey);
    if (!current) {
      slots.set(slotKey, {
        slotKey,
        firstSequence: pair.lastSequence,
        unitId: pair.unitId,
        panelId: pair.panelId,
        targetKind: pair.targetKind,
        targetKey: pair.targetKey,
        currentPair: pair,
      });
      continue;
    }
    const newer = pair.lastSequence > current.currentPair.lastSequence
      || (pair.lastSequence === current.currentPair.lastSequence
        && pair.generationRunId.localeCompare(current.currentPair.generationRunId, "en") > 0);
    slots.set(slotKey, {
      ...current,
      firstSequence: Math.min(current.firstSequence, pair.lastSequence),
      ...(newer ? { currentPair: pair } : {}),
    });
  }
  return [...slots.values()]
    .sort((left, right) => left.firstSequence - right.firstSequence
      || left.unitId.localeCompare(right.unitId, "en")
      || left.panelId.localeCompare(right.panelId, "en"))
    .map((slot, index) => ({ ...slot, slotOrdinal: index + 1 }));
}

function loadReviewHeads(db: DatabaseSync): Map<string, ReviewHeadRow> {
  if (!tableExists(db, "studio_generation_review_heads")
    || !tableExists(db, "studio_generation_review_events")) return new Map();
  const rows = db.prepare(`
    SELECT h.generation_run_id,h.revision,h.review_id,h.review_fingerprint,
           e.sequence AS review_sequence
    FROM studio_generation_review_heads h
    JOIN studio_generation_review_events e ON e.review_id=h.review_id
    ORDER BY e.sequence ASC
  `).all() as unknown as ReviewHeadRow[];
  return new Map(rows.map((row) => [row.generation_run_id, row] as const));
}

function loadDispatchProviders(db: DatabaseSync): Map<string, "codex" | "grok"> {
  const rows = db.prepare(`
    SELECT generation_run_id,executor_provider
    FROM studio_generation_dispatches
    ORDER BY sequence ASC
  `).all() as unknown as DispatchProviderRow[];
  const providers = new Map<string, "codex" | "grok">();
  for (const row of rows) {
    if (row.executor_provider !== "codex" && row.executor_provider !== "grok") {
      fail("storage-invalid", `generationRunId=${row.generation_run_id} 的 executor_provider 非法。`);
    }
    providers.set(row.generation_run_id, row.executor_provider);
  }
  return providers;
}

function loadCheckpointRows(db: DatabaseSync): Map<string, CheckpointRow> {
  const rows = db.prepare(
    "SELECT * FROM studio_generation_checkpoint_snapshots ORDER BY sequence ASC",
  ).all() as unknown as CheckpointRow[];
  return new Map(rows.map((row) => [row.checkpoint_id, row] as const));
}

function loadCheckpointHeads(db: DatabaseSync): Map<number, CheckpointHeadRow> {
  const rows = db.prepare(
    "SELECT * FROM studio_generation_checkpoint_heads ORDER BY batch_number ASC",
  ).all() as unknown as CheckpointHeadRow[];
  return new Map(rows.map((row) => [Number(row.batch_number), row] as const));
}

function loadAttestationRows(db: DatabaseSync): Map<string, AttestationRow> {
  const rows = db.prepare(
    "SELECT * FROM studio_generation_checkpoint_attestations ORDER BY sequence ASC",
  ).all() as unknown as AttestationRow[];
  return new Map(rows.map((row) => [row.attestation_id, row] as const));
}

function loadAttestationHeads(db: DatabaseSync): Map<number, AttestationHeadRow> {
  const rows = db.prepare(
    "SELECT * FROM studio_generation_checkpoint_attestation_heads ORDER BY batch_number ASC",
  ).all() as unknown as AttestationHeadRow[];
  return new Map(rows.map((row) => [Number(row.batch_number), row] as const));
}

async function loadLedgerSnapshot(projectRoot: string): Promise<LedgerSnapshot> {
  const databaseContext = await databaseContextFor(projectRoot);
  const db = openDatabase(databaseContext);
  try {
    return {
      slots: loadPairedSlotsFromDatabase(db),
      dispatchProviders: loadDispatchProviders(db),
      reviewHeads: loadReviewHeads(db),
      checkpointRows: loadCheckpointRows(db),
      checkpointHeads: loadCheckpointHeads(db),
      attestationRows: loadAttestationRows(db),
      attestationHeads: loadAttestationHeads(db),
    };
  } finally {
    db.close();
  }
}

function memberSemantic(member: Omit<StudioGenerationCheckpointMember, "fingerprint">): unknown {
  return member;
}

function checkpointSemantic(
  checkpoint: Omit<StudioGenerationCheckpointCandidate, "checkpointId" | "fingerprint">,
): unknown {
  return checkpoint;
}

function attestationSemantic(
  attestation: Omit<
    StudioGenerationCheckpointAttestationRecord,
    "sequence" | "attestationId" | "fingerprint" | "createdAt"
  >,
): unknown {
  return {
    schemaVersion: 1,
    kind: "studio-generation-checkpoint-attestation",
    ...attestation,
  };
}

function checkpointRecordFromRow(row: CheckpointRow): StudioGenerationCheckpointRecord {
  const members = parsedJson<StudioGenerationCheckpointMember[]>(row.members_json, "checkpoint members");
  const blockers = parsedJson<string[]>(row.blockers_json, "checkpoint blockers");
  if (!Array.isArray(members) || members.length !== CHECKPOINT_MEMBER_COUNT) {
    fail("storage-invalid", "checkpoint " + row.checkpoint_id + " 必须精确包含六个槽位成员。");
  }
  for (const [index, member] of members.entries()) {
    if (!member || typeof member !== "object" || Array.isArray(member)) {
      fail("storage-invalid", "checkpoint member[" + index + "] 结构无效。");
    }
    const { fingerprint, ...semantic } = member;
    const expectedOrdinal = (Number(row.batch_number) - 1) * CHECKPOINT_MEMBER_COUNT + index + 1;
    const targetFieldsValid = member.targetKind === undefined
      ? member.targetKey === undefined
      : member.targetKind === "unit-grid"
        && member.targetKey === `unit-grid:${member.unitId}`
        && member.panelId === member.targetKey;
    if (member.slotOrdinal !== expectedOrdinal
      || member.slotKey !== slotIdentity(member.unitId, member.panelId)
      || !targetFieldsValid
      || !Array.isArray(member.reviewStaleReasons)
      || member.reviewStaleReasons.some((reason) => typeof reason !== "string")
      || JSON.stringify(member.reviewStaleReasons) !== JSON.stringify(uniqueSorted(member.reviewStaleReasons))
      || !SHA256_PATTERN.test(member.rawSha256)
      || !SHA256_PATTERN.test(member.labeledSha256)
      || !SHA256_PATTERN.test(member.packFingerprint)
      || !SHA256_PATTERN.test(member.reviewFingerprint)
      || !SHA256_PATTERN.test(member.continuityFingerprint)
      || fingerprint !== digest(memberSemantic(semantic))) {
      fail("storage-invalid", "checkpoint member[" + index + "] fingerprint 无效。");
    }
  }
  if (!Array.isArray(blockers) || blockers.some((entry) => typeof entry !== "string")) {
    fail("storage-invalid", "checkpoint blockers 无效。");
  }
  if (JSON.stringify(blockers) !== JSON.stringify(uniqueSorted(blockers))
    || (row.eligible_for_pass === 1) !== (blockers.length === 0)) {
    fail("storage-invalid", "checkpoint blockers 排序或 pass eligibility 无效。");
  }
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-generation-checkpoint" as const,
    batchNumber: Number(row.batch_number),
    members,
    eligibleForPass: row.eligible_for_pass === 1,
    blockers,
  };
  const fingerprint = digest(checkpointSemantic(semantic));
  if (row.fingerprint !== fingerprint
    || row.checkpoint_id !== "studio-generation-checkpoint-" + fingerprint.slice(0, 40)) {
    fail("storage-invalid", "checkpoint " + row.checkpoint_id + " 内容地址无效。");
  }
  return {
    ...semantic,
    sequence: Number(row.sequence),
    checkpointId: row.checkpoint_id,
    fingerprint,
    createdAt: row.created_at,
  };
}

function attestationRecordFromRow(
  row: AttestationRow,
): StudioGenerationCheckpointAttestationRecord {
  const semantic = {
    batchNumber: Number(row.batch_number),
    checkpointId: row.checkpoint_id,
    checkpointFingerprint: row.checkpoint_fingerprint,
    decision: row.decision,
    baseHeadRevision: Number(row.base_head_revision),
    headRevision: Number(row.head_revision),
    reviewer: row.reviewer,
    note: row.note,
  };
  const fingerprint = digest(attestationSemantic(semantic));
  if (row.fingerprint !== fingerprint
    || row.attestation_id !== "studio-generation-checkpoint-attestation-" + fingerprint.slice(0, 40)) {
    fail("storage-invalid", "checkpoint attestation " + row.attestation_id + " 内容地址无效。");
  }
  return {
    sequence: Number(row.sequence),
    attestationId: row.attestation_id,
    ...semantic,
    fingerprint,
    createdAt: row.created_at,
  };
}

function reviewMatchesPair(
  review: StudioGenerationReviewProjection,
  pair: CompletePair,
): boolean {
  return review.generationRunId === pair.generationRunId
    && review.rawResultId === pair.rawResultId
    && review.rawSha256 === pair.rawSha256
    && review.labeledResultId === pair.labeledResultId
    && review.labeledSha256 === pair.labeledSha256
    && review.packId === pair.packId
    && review.packFingerprint === pair.packFingerprint;
}

async function liveBatch(
  projectRoot: string,
  batchNumber: number,
  snapshot: Pick<LedgerSnapshot, "slots" | "reviewHeads">,
): Promise<LiveBatch> {
  const start = (batchNumber - 1) * CHECKPOINT_MEMBER_COUNT;
  const slots = snapshot.slots.slice(start, start + CHECKPOINT_MEMBER_COUNT);
  if (slots.length !== CHECKPOINT_MEMBER_COUNT) {
    return {
      batchNumber,
      slots,
      blockers: ["checkpoint-batch-incomplete:" + slots.length + "/" + CHECKPOINT_MEMBER_COUNT],
    };
  }
  const members: StudioGenerationCheckpointMember[] = [];
  const blockers: string[] = [];
  await Promise.all(slots.map(async (slot) => {
    const head = snapshot.reviewHeads.get(slot.currentPair.generationRunId);
    if (!head) {
      blockers.push("slot:" + slot.slotKey + ":review-missing");
      return;
    }
    const review = await readStudioGenerationReview(projectRoot, head.review_id);
    if (!review
      || review.reviewId !== head.review_id
      || review.fingerprint !== head.review_fingerprint
      || review.headRevision !== Number(head.revision)
      || !reviewMatchesPair(review, slot.currentPair)) {
      blockers.push("slot:" + slot.slotKey + ":review-head-or-result-mismatch");
      return;
    }
    let continuityFingerprint: string | undefined;
    try {
      if (slot.targetKind === "unit-grid") {
        const frozenPack = await readStudioUnitGridGenerationFrozenPack(projectRoot, slot.currentPair.packId);
        if (!frozenPack
          || Number(frozenPack.schemaVersion) !== 5
          || Number(frozenPack.request?.schemaVersion) !== 5
          || frozenPack.id !== slot.currentPair.packId
          || frozenPack.fingerprint !== slot.currentPair.packFingerprint
          || frozenPack.target.unitId !== slot.unitId
          || `unit-grid:${frozenPack.target.unitId}` !== slot.targetKey) {
          blockers.push("slot:" + slot.slotKey + ":frozen-pack-identity-mismatch");
          return;
        }
        continuityFingerprint = frozenPack.continuityFingerprint;
      } else {
        const frozenPack = await readStudioGenerationFrozenPack(projectRoot, slot.currentPair.packId);
        if (!frozenPack
          || Number(frozenPack.schemaVersion) !== 4
          || Number(frozenPack.request?.schemaVersion) !== 4
          || !frozenPack.continuity
          || !frozenPack.request?.continuity
          || frozenPack.id !== slot.currentPair.packId
          || frozenPack.fingerprint !== slot.currentPair.packFingerprint
          || frozenPack.target.unitId !== slot.unitId
          || frozenPack.target.panelId !== slot.panelId
          || frozenPack.request.continuity.fingerprint !== frozenPack.continuity.fingerprint) {
          blockers.push("slot:" + slot.slotKey + ":frozen-pack-identity-mismatch");
          return;
        }
        continuityFingerprint = frozenPack.continuity.fingerprint;
      }
    } catch {
      blockers.push("slot:" + slot.slotKey + ":frozen-pack-unverifiable");
      return;
    }
    if (!continuityFingerprint || review.continuityFingerprint !== continuityFingerprint) {
      blockers.push("slot:" + slot.slotKey + ":review-continuity-pack-mismatch");
      return;
    }
    const staleReasons = uniqueSorted(review.currentStaleReasons);
    const memberWithoutFingerprint = {
      slotOrdinal: slot.slotOrdinal,
      slotKey: slot.slotKey,
      unitId: slot.unitId,
      panelId: slot.panelId,
      ...(slot.targetKind === "unit-grid"
        ? { targetKind: "unit-grid" as const, targetKey: slot.targetKey }
        : {}),
      generationRunId: slot.currentPair.generationRunId,
      rawResultId: review.rawResultId,
      rawSha256: review.rawSha256,
      labeledResultId: review.labeledResultId,
      labeledSha256: review.labeledSha256,
      packId: review.packId,
      packFingerprint: review.packFingerprint,
      reviewHeadRevision: Number(head.revision),
      reviewId: review.reviewId,
      reviewFingerprint: review.fingerprint,
      reviewDecision: review.decision,
      reviewCurrent: review.current,
      reviewStaleReasons: staleReasons,
      // checkpoint 只接受已由 Review 声明且与冻结 pack 实际逐格闭包相等的指纹；
      // 成员事实值取自已验证 CAS pack，而不是盲信 Review 输入。
      continuityFingerprint,
    };
    members.push({
      ...memberWithoutFingerprint,
      fingerprint: digest(memberSemantic(memberWithoutFingerprint)),
    });
    if (!review.current) blockers.push("slot:" + slot.slotKey + ":review-stale");
    if (review.decision !== "pass") blockers.push("slot:" + slot.slotKey + ":review-" + review.decision);
    if (!review.approvedRawEligible) blockers.push("slot:" + slot.slotKey + ":approved-raw-ineligible");
  }));
  const normalizedBlockers = uniqueSorted(blockers);
  if (members.length !== CHECKPOINT_MEMBER_COUNT) {
    return { batchNumber, slots, blockers: normalizedBlockers };
  }
  members.sort((left, right) => left.slotOrdinal - right.slotOrdinal
    || left.slotKey.localeCompare(right.slotKey, "en"));
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-generation-checkpoint" as const,
    batchNumber,
    members,
    eligibleForPass: normalizedBlockers.length === 0,
    blockers: normalizedBlockers,
  };
  const fingerprint = digest(checkpointSemantic(semantic));
  return {
    batchNumber,
    slots,
    blockers: normalizedBlockers,
    candidate: {
      ...semantic,
      checkpointId: "studio-generation-checkpoint-" + fingerprint.slice(0, 40),
      fingerprint,
    },
  };
}

function checkpointProjection(
  record: StudioGenerationCheckpointRecord,
  head: CheckpointHeadRow | undefined,
  live: LiveBatch,
): StudioGenerationCheckpointProjection {
  const isHead = Boolean(head
    && head.checkpoint_id === record.checkpointId
    && head.checkpoint_fingerprint === record.fingerprint);
  const staleReasons = uniqueSorted([
    ...(!isHead ? ["not-current-checkpoint-head"] : []),
    ...(!live.candidate ? ["live-checkpoint-unavailable"] : []),
    ...(live.candidate && (live.candidate.checkpointId !== record.checkpointId
      || live.candidate.fingerprint !== record.fingerprint)
      ? ["live-checkpoint-changed"]
      : []),
    ...(!live.candidate ? live.blockers.map((blocker) => "live:" + blocker) : []),
  ]);
  return {
    ...record,
    head: isHead,
    headRevision: Number(head?.revision ?? 0),
    current: staleReasons.length === 0,
    currentStaleReasons: staleReasons,
  };
}

function attestationProjection(
  record: StudioGenerationCheckpointAttestationRecord,
  head: AttestationHeadRow | undefined,
  checkpoint: StudioGenerationCheckpointProjection | undefined,
): StudioGenerationCheckpointAttestationProjection {
  const isHead = Boolean(head
    && head.attestation_id === record.attestationId
    && head.attestation_fingerprint === record.fingerprint);
  const checkpointMatches = Boolean(checkpoint
    && checkpoint.checkpointId === record.checkpointId
    && checkpoint.fingerprint === record.checkpointFingerprint);
  const staleReasons = uniqueSorted([
    ...(!isHead ? ["not-current-attestation-head"] : []),
    ...(!checkpointMatches ? ["attested-checkpoint-not-current-head"] : []),
    ...(checkpointMatches && !checkpoint!.current
      ? checkpoint!.currentStaleReasons.map((reason) => "checkpoint:" + reason)
      : []),
    ...(record.decision === "pass" && checkpointMatches && !checkpoint!.eligibleForPass
      ? ["checkpoint-not-pass-eligible"]
      : []),
  ]);
  return {
    ...record,
    head: isHead,
    current: staleReasons.length === 0,
    currentStaleReasons: staleReasons,
  };
}

function currentCheckpointForBatch(
  snapshot: LedgerSnapshot,
  live: LiveBatch,
): StudioGenerationCheckpointProjection | undefined {
  const head = snapshot.checkpointHeads.get(live.batchNumber);
  if (!head) return undefined;
  const row = snapshot.checkpointRows.get(head.checkpoint_id);
  if (!row
    || Number(row.batch_number) !== live.batchNumber
    || row.fingerprint !== head.checkpoint_fingerprint) {
    fail("storage-invalid", "checkpoint Head 引用孤儿或指纹错配快照。");
  }
  return checkpointProjection(checkpointRecordFromRow(row), head, live);
}

function currentAttestationForBatch(
  snapshot: LedgerSnapshot,
  live: LiveBatch,
  checkpoint: StudioGenerationCheckpointProjection | undefined,
): StudioGenerationCheckpointAttestationProjection | undefined {
  const head = snapshot.attestationHeads.get(live.batchNumber);
  if (!head) return undefined;
  const row = snapshot.attestationRows.get(head.attestation_id);
  if (!row
    || Number(row.batch_number) !== live.batchNumber
    || row.fingerprint !== head.attestation_fingerprint) {
    fail("storage-invalid", "checkpoint attestation Head 引用孤儿或指纹错配事件。");
  }
  return attestationProjection(attestationRecordFromRow(row), head, checkpoint);
}

function controlForBatch(
  snapshot: LedgerSnapshot,
  live: LiveBatch,
): StudioGenerationCheckpointBatchControl {
  const checkpoint = currentCheckpointForBatch(snapshot, live);
  const attestation = currentAttestationForBatch(snapshot, live, checkpoint);
  let status: StudioGenerationCheckpointBatchStatus;
  let blockers: string[];
  if (!live.candidate || !live.candidate.eligibleForPass) {
    status = "review-blocked";
    blockers = uniqueSorted([
      ...live.blockers,
      ...(!live.candidate ? ["live-checkpoint-unavailable"] : []),
    ]);
  } else if (!checkpoint?.current) {
    status = "refresh-required";
    blockers = checkpoint
      ? checkpoint.currentStaleReasons
      : ["checkpoint-head-missing"];
  } else if (!attestation?.current || attestation.decision !== "pass") {
    status = "attestation-required";
    blockers = !attestation
      ? ["pass-attestation-missing"]
      : !attestation.current
        ? attestation.currentStaleReasons
        : ["pass-attestation-missing", "attestation-" + attestation.decision];
  } else {
    status = "passed";
    blockers = [];
  }
  return {
    batchNumber: live.batchNumber,
    slotOrdinals: live.slots.map((slot) => slot.slotOrdinal),
    status,
    blockers: uniqueSorted(blockers),
    checkpointHeadRevision: snapshot.checkpointHeads.get(live.batchNumber)?.revision ?? 0,
    attestationHeadRevision: snapshot.attestationHeads.get(live.batchNumber)?.revision ?? 0,
    ...(live.candidate ? { liveCheckpoint: live.candidate } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    ...(attestation ? { attestation } : {}),
  };
}

export async function getStudioGenerationCheckpointControl(
  projectRoot: string,
): Promise<StudioGenerationCheckpointControl> {
  const snapshot = await loadLedgerSnapshot(projectRoot);
  const completedSlotCount = snapshot.slots.length;
  const fullBatchCount = Math.floor(completedSlotCount / CHECKPOINT_MEMBER_COUNT);
  const collectingSlotCount = completedSlotCount % CHECKPOINT_MEMBER_COUNT;
  const lives = await Promise.all(Array.from(
    { length: fullBatchCount },
    (_, index) => liveBatch(projectRoot, index + 1, snapshot),
  ));
  const batches = lives.map((live) => controlForBatch(snapshot, live));
  const blockingBatchNumber = batches.find((batch) => batch.status !== "passed")?.batchNumber;
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-generation-checkpoint-control" as const,
    completedSlotCount,
    fullBatchCount,
    collectingSlotCount,
    batches,
    ...(blockingBatchNumber === undefined ? {} : { blockingBatchNumber }),
    newSlotDispatchAllowed: blockingBatchNumber === undefined,
  };
  return { ...semantic, fingerprint: digest(semantic) };
}

export async function getStudioGenerationCheckpointDashboardGate(
  projectRoot: string,
): Promise<StudioGenerationCheckpointDashboardGate> {
  const canvas = await getStudioGenerationCheckpointCanvasProjection(projectRoot);
  // 账本闭合验证可让首屏准确读回既有停检状态；媒体/冻结包的深校验仍留在
  // 正式 dispatch gate 中，不能用此轻量投影扩大实际派发权限。
  const blockingBatchNumber = canvas.ledgerCurrent ? undefined : 1;
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-generation-checkpoint-dashboard-gate" as const,
    completedSlotCount: canvas.completedSlotCount,
    fullBatchCount: canvas.fullBatchCount,
    collectingSlotCount: canvas.collectingSlotCount,
    evaluatedBatchCount: canvas.fullBatchCount,
    ...(blockingBatchNumber === undefined ? {} : { blockingBatchNumber }),
    newSlotDispatchAllowed: canvas.ledgerCurrent,
    verification: canvas.ledgerCurrent ? "verified" as const : "unverified-history" as const,
  };
  return { ...semantic, fingerprint: digest(semantic) };
}

function ledgerMemberMismatchReasons(
  member: StudioGenerationCheckpointMember,
  slot: ProductionSlot | undefined,
  reviewHead: ReviewHeadRow | undefined,
): string[] {
  const reasons: string[] = [];
  if (!slot) return ["slot-missing"];
  const memberIsUnitGrid = member.targetKind === "unit-grid";
  if (slot.targetKind === "unit-grid") {
    if (!memberIsUnitGrid || member.targetKey !== `unit-grid:${member.unitId}`
      || member.panelId !== member.targetKey) {
      reasons.push("unit-grid-target-invalid");
    }
  } else if (memberIsUnitGrid || member.targetKey !== undefined) {
    reasons.push("panel-target-invalid");
  }
  if (slot.unitId !== member.unitId || slot.panelId !== member.panelId
    || slot.slotKey !== member.slotKey || slot.slotOrdinal !== member.slotOrdinal) {
    reasons.push("slot-identity-changed");
  }
  const pair = slot.currentPair;
  if (pair.generationRunId !== member.generationRunId
    || pair.rawResultId !== member.rawResultId || pair.rawSha256 !== member.rawSha256
    || pair.labeledResultId !== member.labeledResultId || pair.labeledSha256 !== member.labeledSha256
    || pair.packId !== member.packId || pair.packFingerprint !== member.packFingerprint) {
    reasons.push("result-pair-changed");
  }
  if (!reviewHead || reviewHead.generation_run_id !== member.generationRunId
    || reviewHead.review_id !== member.reviewId
    || reviewHead.review_fingerprint !== member.reviewFingerprint
    || Number(reviewHead.revision) !== member.reviewHeadRevision) {
    reasons.push("review-head-changed");
  }
  if (member.reviewDecision !== "pass" || !member.reviewCurrent || member.reviewStaleReasons.length > 0) {
    reasons.push("checkpoint-member-not-pass-current");
  }
  return uniqueSorted(reasons);
}

/**
 * 供画布首屏一次读取“已停检存证”的正式整板 identity。
 *
 * 不能用这一投影直接派发：它刻意不碰媒体 CAS 和 pack 文件，以避免将 24 个
 * 历史单元的深校验串行塞入首屏。正式派发仍调用完整
 * `getStudioGenerationCheckpointControl` / dispatch gate；画布也会对实际展示的
 * raw 与冻结参考继续逐项验真。
 */
export async function getStudioGenerationCheckpointCanvasProjection(
  projectRoot: string,
): Promise<StudioGenerationCheckpointCanvasProjection> {
  const snapshot = await loadLedgerSnapshot(projectRoot);
  const completedSlotCount = snapshot.slots.length;
  const fullBatchCount = Math.floor(completedSlotCount / CHECKPOINT_MEMBER_COUNT);
  const collectingSlotCount = completedSlotCount % CHECKPOINT_MEMBER_COUNT;
  const blockers: string[] = [];
  const attestedUnitGrid: StudioGenerationCheckpointCanvasUnitGridProjection[] = [];

  for (let batchNumber = 1; batchNumber <= fullBatchCount; batchNumber += 1) {
    const checkpointHead = snapshot.checkpointHeads.get(batchNumber);
    const attestationHead = snapshot.attestationHeads.get(batchNumber);
    const checkpointRow = checkpointHead ? snapshot.checkpointRows.get(checkpointHead.checkpoint_id) : undefined;
    const attestationRow = attestationHead ? snapshot.attestationRows.get(attestationHead.attestation_id) : undefined;
    const prefix = `batch:${batchNumber}`;
    if (!checkpointHead || !checkpointRow
      || checkpointRow.fingerprint !== checkpointHead.checkpoint_fingerprint
      || Number(checkpointRow.batch_number) !== batchNumber) {
      blockers.push(`${prefix}:checkpoint-head-unavailable`);
      continue;
    }
    if (!attestationHead || !attestationRow
      || attestationRow.fingerprint !== attestationHead.attestation_fingerprint
      || Number(attestationRow.batch_number) !== batchNumber) {
      blockers.push(`${prefix}:attestation-head-unavailable`);
      continue;
    }
    const checkpoint = checkpointRecordFromRow(checkpointRow);
    const attestation = attestationRecordFromRow(attestationRow);
    if (!checkpoint.eligibleForPass || checkpoint.blockers.length > 0) {
      blockers.push(`${prefix}:checkpoint-not-pass-eligible`);
      continue;
    }
    if (attestation.decision !== "pass"
      || attestation.checkpointId !== checkpoint.checkpointId
      || attestation.checkpointFingerprint !== checkpoint.fingerprint) {
      blockers.push(`${prefix}:attestation-not-current-pass`);
      continue;
    }
    let batchValid = true;
    const batchEntries: StudioGenerationCheckpointCanvasUnitGridProjection[] = [];
    for (const member of checkpoint.members) {
      const reasons = ledgerMemberMismatchReasons(
        member,
        snapshot.slots[member.slotOrdinal - 1],
        snapshot.reviewHeads.get(member.generationRunId),
      );
      if (reasons.length > 0) {
        blockers.push(`${prefix}:slot:${member.slotOrdinal}:${reasons.join(",")}`);
        batchValid = false;
        continue;
      }
      if (member.targetKind === "unit-grid") {
        const provider = snapshot.dispatchProviders.get(member.generationRunId);
        if (!provider) {
          blockers.push(`${prefix}:slot:${member.slotOrdinal}:dispatch-provider-unavailable`);
          batchValid = false;
          continue;
        }
        batchEntries.push({
          unitId: member.unitId,
          generationRunId: member.generationRunId,
          provider,
          packId: member.packId,
          packFingerprint: member.packFingerprint,
          rawMediaSha256: member.rawSha256,
          labeledMediaSha256: member.labeledSha256,
          reviewId: member.reviewId,
          continuityFingerprint: member.continuityFingerprint,
          checkpointBatchNumber: batchNumber,
          checkpointId: checkpoint.checkpointId,
          checkpointFingerprint: checkpoint.fingerprint,
          attestationId: attestation.attestationId,
          attestationFingerprint: attestation.fingerprint,
        });
      }
    }
    if (batchValid) attestedUnitGrid.push(...batchEntries);
  }
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-generation-checkpoint-canvas-projection" as const,
    completedSlotCount,
    fullBatchCount,
    collectingSlotCount,
    attestedUnitGrid: attestedUnitGrid.sort((left, right) => left.unitId.localeCompare(right.unitId, "en")),
    ledgerCurrent: blockers.length === 0,
    blockers: uniqueSorted(blockers),
  };
  return { ...semantic, fingerprint: digest(semantic) };
}

function operationReceipt(db: DatabaseSync, operationId: string): OperationReceiptRow | undefined {
  return db.prepare(
    "SELECT operation_id,operation_kind,input_fingerprint,outcome_kind,outcome_id,outcome_fingerprint,created_at "
      + "FROM studio_generation_checkpoint_operation_receipts WHERE operation_id=?",
  ).get(operationId) as unknown as OperationReceiptRow | undefined;
}

function checkpointRow(db: DatabaseSync, checkpointId: string): CheckpointRow | undefined {
  return db.prepare(
    "SELECT * FROM studio_generation_checkpoint_snapshots WHERE checkpoint_id=?",
  ).get(checkpointId) as unknown as CheckpointRow | undefined;
}

function checkpointHeadRow(db: DatabaseSync, batchNumber: number): CheckpointHeadRow | undefined {
  return db.prepare(
    "SELECT * FROM studio_generation_checkpoint_heads WHERE batch_number=?",
  ).get(batchNumber) as unknown as CheckpointHeadRow | undefined;
}

function attestationRow(db: DatabaseSync, attestationId: string): AttestationRow | undefined {
  return db.prepare(
    "SELECT * FROM studio_generation_checkpoint_attestations WHERE attestation_id=?",
  ).get(attestationId) as unknown as AttestationRow | undefined;
}

function attestationHeadRow(db: DatabaseSync, batchNumber: number): AttestationHeadRow | undefined {
  return db.prepare(
    "SELECT * FROM studio_generation_checkpoint_attestation_heads WHERE batch_number=?",
  ).get(batchNumber) as unknown as AttestationHeadRow | undefined;
}

function assertReceipt(
  receipt: OperationReceiptRow,
  inputFingerprint: string,
  operationKind: OperationReceiptRow["operation_kind"],
  outcomeKind: OperationReceiptRow["outcome_kind"],
): void {
  if (receipt.input_fingerprint !== inputFingerprint
    || receipt.operation_kind !== operationKind
    || receipt.outcome_kind !== outcomeKind) {
    fail("operation-conflict", "operationId " + receipt.operation_id + " 已绑定不同载荷或操作类型。");
  }
}

function assertCandidateDatabaseIdentity(
  db: DatabaseSync,
  candidate: StudioGenerationCheckpointCandidate,
): void {
  const start = (candidate.batchNumber - 1) * CHECKPOINT_MEMBER_COUNT;
  const slots = loadPairedSlotsFromDatabase(db).slice(start, start + CHECKPOINT_MEMBER_COUNT);
  if (slots.length !== CHECKPOINT_MEMBER_COUNT) {
    fail("checkpoint-conflict", "checkpoint 批次在事务内不再完整。");
  }
  for (const member of candidate.members) {
    const slot = slots.find((entry) => entry.slotOrdinal === member.slotOrdinal
      && entry.slotKey === member.slotKey);
    if (!slot
      || slot.unitId !== member.unitId
      || slot.panelId !== member.panelId
      || slot.currentPair.generationRunId !== member.generationRunId
      || slot.currentPair.rawResultId !== member.rawResultId
      || slot.currentPair.rawSha256 !== member.rawSha256
      || slot.currentPair.labeledResultId !== member.labeledResultId
      || slot.currentPair.labeledSha256 !== member.labeledSha256
      || slot.currentPair.packId !== member.packId
      || slot.currentPair.packFingerprint !== member.packFingerprint) {
      fail("checkpoint-conflict", "checkpoint 成员结果对在事务内发生漂移。", [member.slotKey]);
    }
    const head = db.prepare(`
      SELECT generation_run_id,revision,review_id,review_fingerprint
      FROM studio_generation_review_heads WHERE generation_run_id=?
    `).get(member.generationRunId) as {
      generation_run_id?: string;
      revision?: number;
      review_id?: string;
      review_fingerprint?: string;
    } | undefined;
    if (!head
      || Number(head.revision) !== member.reviewHeadRevision
      || head.review_id !== member.reviewId
      || head.review_fingerprint !== member.reviewFingerprint) {
      fail("checkpoint-conflict", "checkpoint 成员 Review Head 在事务内发生漂移。", [member.slotKey]);
    }
    const review = db.prepare(`
      SELECT raw_result_id,raw_sha256,labeled_result_id,labeled_sha256,
             pack_id,pack_fingerprint,continuity_fingerprint,decision,fingerprint
      FROM studio_generation_review_events WHERE review_id=?
    `).get(member.reviewId) as {
      raw_result_id?: string;
      raw_sha256?: string;
      labeled_result_id?: string;
      labeled_sha256?: string;
      pack_id?: string;
      pack_fingerprint?: string;
      continuity_fingerprint?: string;
      decision?: string;
      fingerprint?: string;
    } | undefined;
    if (!review
      || review.raw_result_id !== member.rawResultId
      || review.raw_sha256 !== member.rawSha256
      || review.labeled_result_id !== member.labeledResultId
      || review.labeled_sha256 !== member.labeledSha256
      || review.pack_id !== member.packId
      || review.pack_fingerprint !== member.packFingerprint
      || review.continuity_fingerprint !== member.continuityFingerprint
      || review.decision !== member.reviewDecision
      || review.fingerprint !== member.reviewFingerprint) {
      fail("checkpoint-conflict", "checkpoint 成员 Review 内容在事务内发生漂移。", [member.slotKey]);
    }
  }
}

async function projectCheckpointById(
  projectRoot: string,
  checkpointId: string,
): Promise<StudioGenerationCheckpointProjection> {
  const snapshot = await loadLedgerSnapshot(projectRoot);
  const row = snapshot.checkpointRows.get(checkpointId);
  if (!row) fail("storage-invalid", "checkpoint operation receipt 引用孤儿快照。");
  const record = checkpointRecordFromRow(row);
  const live = await liveBatch(projectRoot, record.batchNumber, snapshot);
  return checkpointProjection(record, snapshot.checkpointHeads.get(record.batchNumber), live);
}

async function projectAttestationById(
  projectRoot: string,
  attestationId: string,
): Promise<StudioGenerationCheckpointAttestationProjection> {
  const snapshot = await loadLedgerSnapshot(projectRoot);
  const row = snapshot.attestationRows.get(attestationId);
  if (!row) fail("storage-invalid", "checkpoint operation receipt 引用孤儿 attestation。");
  const record = attestationRecordFromRow(row);
  const live = await liveBatch(projectRoot, record.batchNumber, snapshot);
  const checkpointRowValue = snapshot.checkpointRows.get(record.checkpointId);
  if (checkpointRowValue && Number(checkpointRowValue.batch_number) !== record.batchNumber) {
    fail("storage-invalid", "checkpoint attestation 跨批次引用快照。");
  }
  const checkpoint = checkpointRowValue
    ? checkpointProjection(
      checkpointRecordFromRow(checkpointRowValue),
      snapshot.checkpointHeads.get(record.batchNumber),
      live,
    )
    : undefined;
  return attestationProjection(record, snapshot.attestationHeads.get(record.batchNumber), checkpoint);
}

/**
 * Command recovery 的只读入口。回执身份来自与业务写入同事务提交的不可变行；
 * outcome 则按当前 Review/result/pack 状态重新投影，所以旧回执不会复活已 stale 的批准。
 */
export async function readStudioGenerationCheckpointOperationReceipt(
  projectRoot: string,
  operationIdValue: string,
): Promise<StudioGenerationCheckpointOperationReceipt | null> {
  const operationId = normalizedId(operationIdValue, "operationId");
  const databaseContext = await databaseContextFor(projectRoot);
  const db = openDatabase(databaseContext);
  let row: OperationReceiptRow | undefined;
  try {
    row = operationReceipt(db, operationId);
  } finally {
    db.close();
  }
  if (!row) return null;
  if (!SHA256_PATTERN.test(row.input_fingerprint)
    || !SHA256_PATTERN.test(row.outcome_fingerprint)) {
    fail("storage-invalid", "checkpoint operation receipt 指纹无效。");
  }
  const base = {
    schemaVersion: 1 as const,
    kind: "studio-generation-checkpoint-operation-receipt" as const,
    operationId: row.operation_id,
    inputFingerprint: row.input_fingerprint,
    outcomeId: row.outcome_id,
    outcomeFingerprint: row.outcome_fingerprint,
    createdAt: row.created_at,
  };
  if (row.operation_kind === "refresh" && row.outcome_kind === "checkpoint") {
    const outcome = await projectCheckpointById(projectRoot, row.outcome_id);
    if (outcome.fingerprint !== row.outcome_fingerprint) {
      fail("storage-invalid", "checkpoint operation receipt outcome 指纹错配。");
    }
    return {
      ...base,
      operationKind: "refresh",
      outcomeKind: "checkpoint",
      outcome,
    };
  }
  if (row.operation_kind === "attest" && row.outcome_kind === "attestation") {
    const outcome = await projectAttestationById(projectRoot, row.outcome_id);
    if (outcome.fingerprint !== row.outcome_fingerprint) {
      fail("storage-invalid", "checkpoint operation receipt outcome 指纹错配。");
    }
    return {
      ...base,
      operationKind: "attest",
      outcomeKind: "attestation",
      outcome,
    };
  }
  fail("storage-invalid", "checkpoint operation receipt 操作与 outcome 类型不一致。");
}

function normalizeRefreshInput(
  rawInput: RefreshStudioGenerationCheckpointInput,
): RefreshStudioGenerationCheckpointInput {
  return {
    operationId: normalizedId(rawInput?.operationId, "operationId"),
    batchNumber: positiveInteger(rawInput?.batchNumber, "batchNumber"),
    expectedHeadRevision: nonnegativeInteger(rawInput?.expectedHeadRevision, "expectedHeadRevision"),
  };
}

export async function refreshStudioGenerationCheckpoint(
  projectRoot: string,
  rawInput: RefreshStudioGenerationCheckpointInput,
): Promise<StudioGenerationCheckpointProjection> {
  const input = normalizeRefreshInput(rawInput);
  const inputFingerprint = digest({
    schemaVersion: 1,
    command: "refresh-studio-generation-checkpoint",
    ...input,
  });
  const databaseContext = await databaseContextFor(projectRoot);
  const preflightDb = openDatabase(databaseContext);
  try {
    const receipt = operationReceipt(preflightDb, input.operationId);
    if (receipt) {
      assertReceipt(receipt, inputFingerprint, "refresh", "checkpoint");
      const outcome = checkpointRow(preflightDb, receipt.outcome_id);
      if (!outcome || outcome.fingerprint !== receipt.outcome_fingerprint) {
        fail("storage-invalid", "checkpoint operation receipt 引用孤儿或指纹错配快照。");
      }
      return projectCheckpointById(projectRoot, receipt.outcome_id);
    }
  } finally {
    preflightDb.close();
  }

  const snapshot = await loadLedgerSnapshot(projectRoot);
  const live = await liveBatch(projectRoot, input.batchNumber, snapshot);
  if (!live.candidate) {
    fail("checkpoint-not-ready", "checkpoint 批次尚不能形成六成员内容快照。", live.blockers);
  }
  const candidate = live.candidate;
  const db = openDatabase(databaseContext);
  let writtenId: string;
  try {
    writtenId = transaction(db, () => {
      const receipt = operationReceipt(db, input.operationId);
      if (receipt) {
        assertReceipt(receipt, inputFingerprint, "refresh", "checkpoint");
        const outcome = checkpointRow(db, receipt.outcome_id);
        if (!outcome || outcome.fingerprint !== receipt.outcome_fingerprint) {
          fail("storage-invalid", "checkpoint operation receipt 引用孤儿或指纹错配快照。");
        }
        return receipt.outcome_id;
      }
      const head = checkpointHeadRow(db, input.batchNumber);
      const actualRevision = Number(head?.revision ?? 0);
      if (actualRevision !== input.expectedHeadRevision) {
        fail(
          "checkpoint-conflict",
          "checkpoint Head CAS 冲突：期望 " + input.expectedHeadRevision + "，当前 " + actualRevision + "。",
        );
      }
      assertCandidateDatabaseIdentity(db, candidate);
      const now = new Date().toISOString();
      let row = checkpointRow(db, candidate.checkpointId);
      if (row && row.fingerprint !== candidate.fingerprint) {
        fail("storage-invalid", "checkpoint 内容地址发生碰撞。");
      }
      if (!row) {
        db.prepare(`
          INSERT INTO studio_generation_checkpoint_snapshots(
            checkpoint_id,batch_number,members_json,eligible_for_pass,blockers_json,fingerprint,created_at
          ) VALUES(?,?,?,?,?,?,?)
        `).run(
          candidate.checkpointId,
          candidate.batchNumber,
          JSON.stringify(candidate.members),
          candidate.eligibleForPass ? 1 : 0,
          JSON.stringify(candidate.blockers),
          candidate.fingerprint,
          now,
        );
        row = checkpointRow(db, candidate.checkpointId);
      }
      if (!row) fail("storage-invalid", "checkpoint 快照写入后无法读回。");
      const alreadyHead = Boolean(head
        && head.checkpoint_id === candidate.checkpointId
        && head.checkpoint_fingerprint === candidate.fingerprint);
      if (!alreadyHead) {
        const nextRevision = actualRevision + 1;
        if (!head) {
          db.prepare(`
            INSERT INTO studio_generation_checkpoint_heads(
              batch_number,revision,checkpoint_id,checkpoint_fingerprint,updated_at
            ) VALUES(?,?,?,?,?)
          `).run(input.batchNumber, nextRevision, candidate.checkpointId, candidate.fingerprint, now);
        } else {
          const changed = db.prepare(`
            UPDATE studio_generation_checkpoint_heads
            SET revision=?,checkpoint_id=?,checkpoint_fingerprint=?,updated_at=?
            WHERE batch_number=? AND revision=? AND checkpoint_id=? AND checkpoint_fingerprint=?
          `).run(
            nextRevision,
            candidate.checkpointId,
            candidate.fingerprint,
            now,
            input.batchNumber,
            actualRevision,
            head.checkpoint_id,
            head.checkpoint_fingerprint,
          );
          if (Number(changed.changes) !== 1) {
            fail("checkpoint-conflict", "checkpoint Head 在事务内发生 CAS 漂移。");
          }
        }
      }
      db.prepare(`
        INSERT INTO studio_generation_checkpoint_operation_receipts(
          operation_id,operation_kind,input_fingerprint,outcome_kind,
          outcome_id,outcome_fingerprint,created_at
        ) VALUES(?,?,?,?,?,?,?)
      `).run(
        input.operationId,
        "refresh",
        inputFingerprint,
        "checkpoint",
        candidate.checkpointId,
        candidate.fingerprint,
        now,
      );
      return candidate.checkpointId;
    });
  } finally {
    db.close();
  }
  return projectCheckpointById(projectRoot, writtenId);
}

function normalizeAttestInput(
  rawInput: AttestStudioGenerationCheckpointInput,
): AttestStudioGenerationCheckpointInput {
  const decision = rawInput?.decision;
  if (decision !== "pass" && decision !== "rework") {
    fail("invalid-input", "decision 必须是 pass 或 rework。");
  }
  return {
    operationId: normalizedId(rawInput?.operationId, "operationId"),
    batchNumber: positiveInteger(rawInput?.batchNumber, "batchNumber"),
    checkpointId: normalizedId(rawInput?.checkpointId, "checkpointId"),
    checkpointFingerprint: normalizedSha(rawInput?.checkpointFingerprint, "checkpointFingerprint"),
    expectedHeadRevision: nonnegativeInteger(rawInput?.expectedHeadRevision, "expectedHeadRevision"),
    decision,
    reviewer: requiredText(rawInput?.reviewer, "reviewer", 500),
    note: requiredText(rawInput?.note, "note", 8_000),
  };
}

export async function attestStudioGenerationCheckpoint(
  projectRoot: string,
  rawInput: AttestStudioGenerationCheckpointInput,
): Promise<StudioGenerationCheckpointAttestationProjection> {
  const input = normalizeAttestInput(rawInput);
  const inputFingerprint = digest({
    schemaVersion: 1,
    command: "attest-studio-generation-checkpoint",
    ...input,
  });
  const databaseContext = await databaseContextFor(projectRoot);
  const preflightDb = openDatabase(databaseContext);
  try {
    const receipt = operationReceipt(preflightDb, input.operationId);
    if (receipt) {
      assertReceipt(receipt, inputFingerprint, "attest", "attestation");
      const outcome = attestationRow(preflightDb, receipt.outcome_id);
      if (!outcome || outcome.fingerprint !== receipt.outcome_fingerprint) {
        fail("storage-invalid", "checkpoint operation receipt 引用孤儿或指纹错配 attestation。");
      }
      return projectAttestationById(projectRoot, receipt.outcome_id);
    }
  } finally {
    preflightDb.close();
  }

  const control = await getStudioGenerationCheckpointControl(projectRoot);
  const batch = control.batches.find((entry) => entry.batchNumber === input.batchNumber);
  if (!batch?.checkpoint) {
    fail("checkpoint-not-found", "当前批次尚无 checkpoint Head。");
  }
  if (!batch.checkpoint.current
    || batch.checkpoint.checkpointId !== input.checkpointId
    || batch.checkpoint.fingerprint !== input.checkpointFingerprint) {
    fail("checkpoint-conflict", "attestation 只能绑定当前内容地址 checkpoint。", [
      ...batch.checkpoint.currentStaleReasons,
    ]);
  }
  if (input.decision === "pass" && !batch.checkpoint.eligibleForPass) {
    fail("checkpoint-not-ready", "存在 Review 或结果阻断，不能提交 pass attestation。", batch.blockers);
  }
  const candidate = batch.liveCheckpoint;
  if (!candidate) fail("checkpoint-not-ready", "当前 checkpoint 已无法从实时成员重建。");

  const db = openDatabase(databaseContext);
  let writtenId: string;
  try {
    writtenId = transaction(db, () => {
      const receipt = operationReceipt(db, input.operationId);
      if (receipt) {
        assertReceipt(receipt, inputFingerprint, "attest", "attestation");
        const outcome = attestationRow(db, receipt.outcome_id);
        if (!outcome || outcome.fingerprint !== receipt.outcome_fingerprint) {
          fail("storage-invalid", "checkpoint operation receipt 引用孤儿或指纹错配 attestation。");
        }
        return receipt.outcome_id;
      }
      const checkpointHead = checkpointHeadRow(db, input.batchNumber);
      if (!checkpointHead
        || checkpointHead.checkpoint_id !== input.checkpointId
        || checkpointHead.checkpoint_fingerprint !== input.checkpointFingerprint) {
        fail("checkpoint-conflict", "checkpoint Head 在 attestation 事务内发生漂移。");
      }
      assertCandidateDatabaseIdentity(db, candidate);
      if (candidate.checkpointId !== input.checkpointId
        || candidate.fingerprint !== input.checkpointFingerprint
        || (input.decision === "pass" && !candidate.eligibleForPass)) {
        fail("checkpoint-conflict", "实时 checkpoint 成员与 attestation 目标不一致。");
      }
      const head = attestationHeadRow(db, input.batchNumber);
      const actualRevision = Number(head?.revision ?? 0);
      if (actualRevision !== input.expectedHeadRevision) {
        fail(
          "attestation-conflict",
          "attestation Head CAS 冲突：期望 " + input.expectedHeadRevision + "，当前 " + actualRevision + "。",
        );
      }
      const semantic = {
        batchNumber: input.batchNumber,
        checkpointId: input.checkpointId,
        checkpointFingerprint: input.checkpointFingerprint,
        decision: input.decision,
        baseHeadRevision: actualRevision,
        headRevision: actualRevision + 1,
        reviewer: input.reviewer,
        note: input.note,
      };
      const fingerprint = digest(attestationSemantic(semantic));
      const attestationId = "studio-generation-checkpoint-attestation-" + fingerprint.slice(0, 40);
      const now = new Date().toISOString();
      let row = attestationRow(db, attestationId);
      if (row && row.fingerprint !== fingerprint) {
        fail("storage-invalid", "checkpoint attestation 内容地址发生碰撞。");
      }
      if (!row) {
        db.prepare(`
          INSERT INTO studio_generation_checkpoint_attestations(
            attestation_id,batch_number,checkpoint_id,checkpoint_fingerprint,
            decision,base_head_revision,head_revision,reviewer,note,fingerprint,created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          attestationId,
          input.batchNumber,
          input.checkpointId,
          input.checkpointFingerprint,
          input.decision,
          actualRevision,
          actualRevision + 1,
          input.reviewer,
          input.note,
          fingerprint,
          now,
        );
        row = attestationRow(db, attestationId);
      }
      if (!row) fail("storage-invalid", "checkpoint attestation 写入后无法读回。");
      if (!head) {
        db.prepare(`
          INSERT INTO studio_generation_checkpoint_attestation_heads(
            batch_number,revision,attestation_id,attestation_fingerprint,updated_at
          ) VALUES(?,?,?,?,?)
        `).run(input.batchNumber, 1, attestationId, fingerprint, now);
      } else {
        const changed = db.prepare(`
          UPDATE studio_generation_checkpoint_attestation_heads
          SET revision=?,attestation_id=?,attestation_fingerprint=?,updated_at=?
          WHERE batch_number=? AND revision=? AND attestation_id=? AND attestation_fingerprint=?
        `).run(
          actualRevision + 1,
          attestationId,
          fingerprint,
          now,
          input.batchNumber,
          actualRevision,
          head.attestation_id,
          head.attestation_fingerprint,
        );
        if (Number(changed.changes) !== 1) {
          fail("attestation-conflict", "attestation Head 在事务内发生 CAS 漂移。");
        }
      }
      db.prepare(`
        INSERT INTO studio_generation_checkpoint_operation_receipts(
          operation_id,operation_kind,input_fingerprint,outcome_kind,
          outcome_id,outcome_fingerprint,created_at
        ) VALUES(?,?,?,?,?,?,?)
      `).run(
        input.operationId,
        "attest",
        inputFingerprint,
        "attestation",
        attestationId,
        fingerprint,
        now,
      );
      return attestationId;
    });
  } finally {
    db.close();
  }
  return projectAttestationById(projectRoot, writtenId);
}

function latestDispatchedPanelRunId(
  db: DatabaseSync,
  unitId: string,
  panelId: string,
  excludeRunId?: string,
): string | undefined {
  const row = db.prepare(`
    SELECT dispatch.generation_run_id
    FROM studio_generation_dispatches dispatch
    JOIN studio_generation_packs pack
      ON pack.pack_id=dispatch.pack_id AND pack.fingerprint=dispatch.pack_fingerprint
    LEFT JOIN studio_generation_pack_targets target
      ON target.pack_id=pack.pack_id AND target.pack_fingerprint=pack.fingerprint
    WHERE target.pack_id IS NULL AND pack.unit_id=? AND pack.panel_id=?
      AND dispatch.generation_run_id != ?
    ORDER BY dispatch.sequence DESC
    LIMIT 1
  `).get(unitId, panelId, excludeRunId ?? "") as { generation_run_id?: string } | undefined;
  return row?.generation_run_id;
}

function latestDispatchedUnitGridRunId(db: DatabaseSync, targetKey: string, excludeRunId?: string): string | undefined {
  const row = db.prepare(`
    SELECT dispatch.generation_run_id
    FROM studio_generation_dispatches dispatch
    JOIN studio_generation_pack_targets target
      ON target.pack_id=dispatch.pack_id AND target.pack_fingerprint=dispatch.pack_fingerprint
    WHERE target.target_kind='unit-grid' AND target.target_key=?
      AND dispatch.generation_run_id != ?
    ORDER BY dispatch.sequence DESC
    LIMIT 1
  `).get(targetKey, excludeRunId ?? "") as { generation_run_id?: string } | undefined;
  return row?.generation_run_id;
}

/** 槽位占用 run 的只读状态投影：直接查 ledger 既有表，表缺失一律按"无事实"防御。 */
interface SlotOccupyingRunProjection {
  /** 最新 run 事件 kind；无事件或表缺失为 null（legacy 纯 dispatch 行）。 */
  latestEventKind: string | null;
  /** 是否已登记任何 raw/labeled 结果行。 */
  hasResults: boolean;
  /** 是否同时存在 raw 与 labeled 结果（完整对）。单边结果不触发 Review 闸。 */
  hasCompletePair: boolean;
  /** 是否存在仍未闭合的 generation_unknown call intent（未 reconcile 也未 owner abandon）。 */
  hasUnresolvedCallUnknown: boolean;
}

/** owner abandon 是不可逆封存事实：cancelled 事件 detail 经 ledger 导出的同一判定函数识别。 */
function slotRunSealedByOwnerAbandon(db: DatabaseSync, generationRunId: string): boolean {
  if (!tableExists(db, "studio_generation_run_events")) return false;
  const rows = db.prepare(`
    SELECT detail_json FROM studio_generation_run_events
    WHERE generation_run_id = ? AND kind = 'cancelled' ORDER BY sequence
  `).all(generationRunId) as Array<{ detail_json: string }>;
  return rows.some((row) => {
    try {
      return isStudioGenerationUnknownOwnerAbandonDetail(JSON.parse(row.detail_json));
    } catch {
      return false;
    }
  });
}

function projectSlotOccupyingRun(db: DatabaseSync, generationRunId: string): SlotOccupyingRunProjection {
  let latestEventKind: string | null = null;
  if (tableExists(db, "studio_generation_run_events")) {
    const row = db.prepare(`
      SELECT kind FROM studio_generation_run_events
      WHERE generation_run_id = ? ORDER BY sequence DESC LIMIT 1
    `).get(generationRunId) as { kind?: string } | undefined;
    latestEventKind = row?.kind ?? null;
  }
  let hasResults = false;
  let hasCompletePair = false;
  if (tableExists(db, "studio_generation_results")) {
    // 分别检查 raw 与 labeled 是否各至少存在一行，以区分完整对与单边结果。
    const variants = db.prepare(`
      SELECT DISTINCT variant FROM studio_generation_results
      WHERE generation_run_id = ? AND variant IN ('raw','labeled')
    `).all(generationRunId) as Array<{ variant: string }>;
    const variantSet = new Set(variants.map((r) => r.variant));
    hasResults = variantSet.size > 0;
    hasCompletePair = variantSet.has("raw") && variantSet.has("labeled");
  }
  let hasUnresolvedCallUnknown = false;
  if (tableExists(db, "studio_generation_call_intents")) {
    const intent = db.prepare(`
      SELECT call_id FROM studio_generation_call_intents WHERE generation_run_id = ? LIMIT 1
    `).get(generationRunId) as { call_id?: string } | undefined;
    if (intent?.call_id) {
      const reconciled = tableExists(db, "studio_generation_call_events")
        && Boolean(db.prepare(`
          SELECT 1 AS found FROM studio_generation_call_events
          WHERE call_id = ? AND kind IN ('result-committed','not-invoked') LIMIT 1
        `).get(intent.call_id));
      hasUnresolvedCallUnknown = !reconciled && !slotRunSealedByOwnerAbandon(db, generationRunId);
    }
  }
  return { latestEventKind, hasResults, hasCompletePair, hasUnresolvedCallUnknown };
}

export async function assertStudioGenerationCheckpointDispatchAllowed(
  projectRoot: string,
  rawInput: StudioGenerationCheckpointDispatchInput,
): Promise<StudioGenerationCheckpointDispatchGate> {
  const unitId = normalizedId(rawInput?.unitId, "unitId");
  const targetKind = rawInput?.targetKind ?? "panel";
  if (targetKind !== "panel" && targetKind !== "unit-grid") {
    fail("invalid-input", "targetKind 必须是 panel 或 unit-grid。");
  }
  const panelId = targetKind === "panel"
    ? normalizedId((rawInput as { panelId?: unknown }).panelId, "panelId")
    : undefined;
  const targetKey = targetKind === "unit-grid" ? `unit-grid:${unitId}` : undefined;
  const excludeRunId = rawInput?.excludeRunId === undefined
    ? undefined
    : normalizedId(rawInput.excludeRunId, "excludeRunId");
  const slotLabel = targetKind === "unit-grid" ? targetKey! : `${unitId}/${panelId}`;
  const databaseContext = await databaseContextFor(projectRoot);
  const db = openDatabase(databaseContext);
  let existingRunId: string | undefined;
  let occupancy: SlotOccupyingRunProjection | undefined;
  try {
    // excludeRunId 用于“被验 run 即最新 dispatch”的受管路径（prepare/retry 新 attempt）：
    // 排除自身后再看槽位是否被其他 run 占用。generationRunId 均非空，缺省用 "" 恒真。
    existingRunId = targetKind === "unit-grid"
      ? latestDispatchedUnitGridRunId(db, targetKey!, excludeRunId)
      : latestDispatchedPanelRunId(db, unitId, panelId!, excludeRunId);
    if (existingRunId) occupancy = projectSlotOccupyingRun(db, existingRunId);
  } finally {
    db.close();
  }
  // 终态失败/取消/被取代、无未闭合 generation_unknown 的 run 不再占槽：
  // - 无结果：旧 run 证据与 lineage 不动，按"无占用"路径允许受管新 attempt。
  // - 单边结果（仅 raw 或仅 labeled，非完整对）+ 终态：不占槽放行；
  //   晚到结果由 run-cancelled/run-terminal 闸兜底拒绝，不会造成重复扣费。
  // - 完整 raw+labeled 对：维持 Review 闸（有成果需人工验收或返工通道）。
  // retry-superseded 同为终态：该 run 已被 successor attempt 取代，lineage 由
  // 事件链保留；若仍带未闭合 unknown 则落入下方对账闸，不会误放行。
  const terminalState = occupancy !== undefined
    && (occupancy.latestEventKind === "failed" || occupancy.latestEventKind === "cancelled"
      || occupancy.latestEventKind === "retry-superseded");
  const occupancyFreed = terminalState
    && !occupancy!.hasUnresolvedCallUnknown
    && !occupancy!.hasCompletePair;
  if (existingRunId && occupancy && !occupancyFreed) {
    // 同 generationRunId 的 dispatch replay 在 ledger 层先幂等返回；此处只约束
    // “同槽位另开一次新生图”。
    if (!occupancy.hasResults && occupancy.hasUnresolvedCallUnknown) {
      // 调用未知的 run 无论事件状态都必须先走 reconcile/abandon 受管路径闭合，
      // 禁止绕开对账直接另开 generationRunId。
      fail(
        "checkpoint-required",
        `生产槽 ${slotLabel} 的 generationRunId=${existingRunId} 存在调用未知（generation_unknown）的 imagegen call，必须先经 reconcile/abandon 受管路径闭合，禁止另开 generationRunId。`,
        ["generation-unknown", `generationRunId=${existingRunId}`],
      );
    }
    // 有结果行或在途（dispatched/cancel-requested，保守）：没有审片结论时禁止重派，
    // 避免 PENDING 候选造成重复扣费或绕过原尺寸人工验收。已形成 Review 后维持既有返工通道。
    const review = await getStudioGenerationReviewControl(projectRoot, existingRunId);
    if (review.status === "unreviewed") {
      fail(
        "checkpoint-required",
        `生产槽 ${slotLabel} 尚待人工验收，禁止另开 generationRunId。`,
        ["review-missing", `generationRunId=${existingRunId}`],
      );
    }
    const control = await getStudioGenerationCheckpointControl(projectRoot);
    return {
      allowed: true,
      reason: "existing-slot-rework",
      completedSlotCount: control.completedSlotCount,
      ...(control.blockingBatchNumber === undefined
        ? {}
        : { blockingBatchNumber: control.blockingBatchNumber }),
    };
  }
  const control = await getStudioGenerationCheckpointControl(projectRoot);
  if (!control.newSlotDispatchAllowed) {
    const batch = control.batches.find((entry) => entry.batchNumber === control.blockingBatchNumber);
    fail(
      "checkpoint-required",
      "新增生产槽位 dispatch 被第 " + control.blockingBatchNumber + " 批六图停检阻断。",
      batch?.blockers ?? [],
    );
  }
  return {
    allowed: true,
    reason: control.fullBatchCount > 0 && control.collectingSlotCount === 0
      ? "checkpoint-pass-current"
      : "checkpoint-not-yet-due",
    completedSlotCount: control.completedSlotCount,
  };
}
