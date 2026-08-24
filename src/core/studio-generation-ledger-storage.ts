/**
 * Studio generation ledger 的 schema/bootstrap/storage owner。
 * 只负责同一 v7 SQLite 与冻结包 CAS 的安全打开，不包含 generation business 行为。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digestStudioCanonicalJson as stableDigest } from "./studio-canonical-json.js";
import {
  StudioGenerationLedgerError,
  type StudioGenerationLedgerErrorCode,
  type StudioGenerationLedgerState,
  type StudioGenerationResultVariant,
} from "./studio-generation-ledger-contract.js";
import {
  ensureConfinedDirectory,
  type ConfinedDirectoryIdentity,
} from "./confined-project-storage.js";
import { inspectManagedProjectReadOnly } from "./managed-project.js";
import {
  assertSafeSqliteSidecars,
  assertSqliteSourceBindingIdentity,
  inspectSqliteSourceBindingIdentity,
  openSqliteReadOnlySnapshot,
  type SqliteSourceBindingIdentity,
} from "./sqlite-readonly-snapshot.js";
import { ensureCanvasProjectionOutboxSchema } from "./studio-canvas-projection-outbox.js";
import {
  hasStudioRequestSchemaValidation,
  isStudioRequestSqliteValidationUnchanged,
  markStudioRequestSqliteValidationIfUnchanged,
  studioRequestSqliteValidationKey,
} from "./studio-request-schema-cache.js";
import { STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS, studioSqliteBusyTimeoutMs } from "./studio-sqlite-busy.js";
import type { StudioFormalImagegenProvider } from "./studio-imagegen-providers.js";

const SCHEMA_VERSION = 7;
const V6_SCHEMA_VERSION = 6;
const V5_SCHEMA_VERSION = 5;
const V4_SCHEMA_VERSION = 4;
const V3_SCHEMA_VERSION = 3;
const V2_SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const DATABASE_RELATIVE_PATH = ".aicanvas/studio-generation-ledger.sqlite";
const PACK_CAS_RELATIVE_ROOT = ".aicanvas/studio-generation/objects/sha256";
const PACK_CAS_TEMP_RELATIVE_ROOT = ".aicanvas/studio-generation/objects/.tmp";
const BUSY_TIMEOUT_MS = STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS;
const MAX_PACK_BYTES = 4 * 1024 * 1024;

type StudioGenerationDispatchProvenance = "local-dispatch-intent" | "legacy-registration";
type StudioGenerationResultStatus = "pending" | "approved" | "rejected";

export interface LedgerPaths {
  root: string;
  database: string;
  /** 本次 managedLedgerPaths 调用独占的只读预检令牌；禁止跨操作共享。 */
  readonly databasePreflightIdentity: SqliteSourceBindingIdentity | null;
  packCasRoot: string;
  packCasTempRoot: string;
  storageIdentities: {
    packCasRoot: ConfinedDirectoryIdentity;
    packCasTempRoot: ConfinedDirectoryIdentity;
  };
}

export interface DetachedUnknownObservationRow {
  sequence: number;
  observation_id: string;
  target_kind: "unit-grid";
  target_key: string;
  unit_id: string;
  unit_revision: number;
  unit_fingerprint: string;
  source_task_id: string;
  status: "generation_unknown";
  evidence_reference: string;
  evidence_fingerprint: string;
  candidate_sha256: string | null;
  candidate_size_bytes: number | null;
  candidate_width: number | null;
  candidate_height: number | null;
  note: string;
  fingerprint: string;
  created_at: string;
}

export interface DetachedUnknownDispositionRow {
  sequence: number;
  disposition_id: string;
  observation_id: string;
  observation_fingerprint: string;
  target_kind: "unit-grid";
  target_key: string;
  unit_id: string;
  unit_revision: number;
  unit_fingerprint: string;
  source_task_id: string;
  status: "owner-abandoned";
  remote_invocation: "unknown-may-exist";
  detached_candidate_policy: "never-import-or-reuse";
  next_run_policy: "fresh-formal-run-only";
  authorization_evidence_reference: string;
  authorization_text_sha256: string;
  reason: string;
  project_id: string;
  manifest_fingerprint: string;
  context_token_hash: string;
  build_id: string;
  source_digest: string;
  fingerprint: string;
  created_at: string;
}

interface ResultRow {
  sequence: number;
  result_id: string;
  dispatch_id: string;
  generation_run_id: string;
  variant: StudioGenerationResultVariant;
  status: StudioGenerationResultStatus;
  media_sha256: string;
  input_current: number;
  promotion_eligible: number;
  stale_reasons_json: string;
  pack_id: string;
  pack_fingerprint: string;
  unit_id: string;
  unit_revision: number;
  panel_id: string;
  panel_index: number;
  created_at: string;
}

function fail(code: StudioGenerationLedgerErrorCode, message: string, details: string[] = []): never {
  throw new StudioGenerationLedgerError(code, message, details);
}

export function detachedUnknownSemantic(input: {
  targetKey: string;
  unitId: string;
  unitRevision: number;
  unitFingerprint: string;
  sourceTaskId: string;
  evidenceReference: string;
  evidenceFingerprint: string;
  candidateSha256: string | null;
  candidateSizeBytes: number | null;
  candidateWidth: number | null;
  candidateHeight: number | null;
  note: string;
}) {
  return {
    schemaVersion: 1 as const,
    kind: "studio-detached-generation-observation" as const,
    targetKind: "unit-grid" as const,
    ...input,
    status: "generation_unknown" as const,
  };
}

export function detachedUnknownRecord(row: DetachedUnknownObservationRow) {
  const semantic = detachedUnknownSemantic({
    targetKey: row.target_key,
    unitId: row.unit_id,
    unitRevision: Number(row.unit_revision),
    unitFingerprint: row.unit_fingerprint,
    sourceTaskId: row.source_task_id,
    evidenceReference: row.evidence_reference,
    evidenceFingerprint: row.evidence_fingerprint,
    candidateSha256: row.candidate_sha256,
    candidateSizeBytes: row.candidate_size_bytes === null ? null : Number(row.candidate_size_bytes),
    candidateWidth: row.candidate_width === null ? null : Number(row.candidate_width),
    candidateHeight: row.candidate_height === null ? null : Number(row.candidate_height),
    note: row.note,
  });
  const fingerprint = stableDigest(semantic);
  const observationId = `studio-detached-unknown-${fingerprint.slice(0, 40)}`;
  if (row.target_kind !== "unit-grid" || row.status !== "generation_unknown"
    || row.target_key !== `unit-grid:${row.unit_id}`
    || row.fingerprint !== fingerprint || row.observation_id !== observationId) {
    fail("storage-invalid", `detached generation observation 身份漂移：${row.observation_id}`);
  }
  return {
    ...semantic,
    observationId,
    callAllowed: false as const,
    fingerprint,
    createdAt: row.created_at,
  };
}

export function detachedUnknownDispositionSemantic(input: {
  observation: ReturnType<typeof detachedUnknownRecord>;
  authorizationEvidenceReference: string;
  authorizationTextSha256: string;
  reason: string;
  projectContext: {
    projectId: string;
    manifestFingerprint: string;
    contextTokenHash: string;
    buildId: string;
    sourceDigest: string;
  };
}) {
  return {
    schemaVersion: 1 as const,
    kind: "studio-detached-generation-unknown-disposition" as const,
    observationId: input.observation.observationId,
    observationFingerprint: input.observation.fingerprint,
    targetKind: "unit-grid" as const,
    targetKey: input.observation.targetKey,
    unitId: input.observation.unitId,
    unitRevision: input.observation.unitRevision,
    unitFingerprint: input.observation.unitFingerprint,
    sourceTaskId: input.observation.sourceTaskId,
    status: "owner-abandoned" as const,
    remoteInvocation: "unknown-may-exist" as const,
    detachedCandidatePolicy: "never-import-or-reuse" as const,
    nextRunPolicy: "fresh-formal-run-only" as const,
    authorizationEvidenceReference: input.authorizationEvidenceReference,
    authorizationTextSha256: input.authorizationTextSha256,
    reason: input.reason,
    acknowledgeRemoteGenerationMayExist: true as const,
    acknowledgeDetachedCandidateWillNeverBeImportedOrReused: true as const,
    acknowledgeFreshFormalRunMayDuplicateRemoteGeneration: true as const,
    projectContext: input.projectContext,
    callAllowed: false as const,
  };
}

export function detachedUnknownDispositionRecord(
  row: DetachedUnknownDispositionRow,
  observation: ReturnType<typeof detachedUnknownRecord>,
  idempotentReplay: boolean,
) {
  const semantic = detachedUnknownDispositionSemantic({
    observation,
    authorizationEvidenceReference: row.authorization_evidence_reference,
    authorizationTextSha256: row.authorization_text_sha256,
    reason: row.reason,
    projectContext: {
      projectId: row.project_id,
      manifestFingerprint: row.manifest_fingerprint,
      contextTokenHash: row.context_token_hash,
      buildId: row.build_id,
      sourceDigest: row.source_digest,
    },
  });
  const fingerprint = stableDigest(semantic);
  const dispositionId = `studio-detached-disposition-${fingerprint.slice(0, 40)}`;
  if (row.disposition_id !== dispositionId
    || row.fingerprint !== fingerprint
    || row.observation_id !== observation.observationId
    || row.observation_fingerprint !== observation.fingerprint
    || row.target_kind !== observation.targetKind
    || row.target_key !== observation.targetKey
    || row.unit_id !== observation.unitId
    || Number(row.unit_revision) !== observation.unitRevision
    || row.unit_fingerprint !== observation.unitFingerprint
    || row.source_task_id !== observation.sourceTaskId
    || row.status !== "owner-abandoned"
    || row.remote_invocation !== "unknown-may-exist"
    || row.detached_candidate_policy !== "never-import-or-reuse"
    || row.next_run_policy !== "fresh-formal-run-only") {
    fail("storage-invalid", `detached disposition 身份漂移：${row.disposition_id}`);
  }
  return {
    ...semantic,
    dispositionId,
    fingerprint,
    createdAt: row.created_at,
    idempotentReplay,
  };
}

let beforeGenerationWritableOpenHookForTests:
  | ((input: { databasePath: string; sourceIdentity: SqliteSourceBindingIdentity | null }) => void | Promise<void>)
  | null = null;

/** 仅供 Vitest 确定性注入 read-only preflight → writable open 竞态。 */
export function __setBeforeGenerationWritableOpenHookForTests(
  hook: typeof beforeGenerationWritableOpenHookForTests,
): void {
  if (process.env.NODE_ENV !== "test") throw new Error("generation writable-open hook 仅允许测试环境。");
  beforeGenerationWritableOpenHookForTests = hook;
}

export async function managedLedgerPaths(projectRoot: string): Promise<{ paths: LedgerPaths; projectId: string }> {
  let shell: Awaited<ReturnType<typeof inspectManagedProjectReadOnly>>;
  try {
    shell = await inspectManagedProjectReadOnly(projectRoot);
  } catch (error) {
    // inspectManagedProject 会幂等初始化本账本；迁移/存储失败必须保留原始 ledger code，
    // 不得被误包装成“非受管项目”。
    if (error instanceof StudioGenerationLedgerError) throw error;
    throw new StudioGenerationLedgerError(
      "unmanaged-project",
      "Studio generation 账本只允许写入通过验证的受管项目。",
      [error instanceof Error ? error.message : String(error)],
      { cause: error },
    );
  }
  const basePaths = {
    root: shell.paths.root,
    database: path.join(shell.paths.root, DATABASE_RELATIVE_PATH),
    packCasRoot: path.join(shell.paths.root, PACK_CAS_RELATIVE_ROOT),
    packCasTempRoot: path.join(shell.paths.root, PACK_CAS_TEMP_RELATIVE_ROOT),
  };
  const preflightCacheKey = studioRequestSqliteValidationKey(
    `studio-generation-preflight-v${SCHEMA_VERSION}`,
    basePaths.database,
  );
  let sourceIdentity: SqliteSourceBindingIdentity | null;
  if (hasStudioRequestSchemaValidation(preflightCacheKey) && existsSync(basePaths.database)) {
    assertSafeSqliteSidecars(basePaths.database, "generation ledger");
    const probe = new DatabaseSync(basePaths.database, { readOnly: true });
    try {
      const version = probe.prepare(
        "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
      ).get() as { value?: string } | undefined;
      if (version?.value !== String(SCHEMA_VERSION)) {
        fail("storage-invalid", `generation ledger schema_version 已漂移：${version?.value ?? "缺失"}。`);
      }
    } finally {
      probe.close();
    }
    sourceIdentity = inspectSqliteSourceBindingIdentity(basePaths.database, "generation ledger");
    if (!isStudioRequestSqliteValidationUnchanged(
      preflightCacheKey,
      `studio-generation-preflight-v${SCHEMA_VERSION}`,
      basePaths.database,
    )) {
      fail("storage-invalid", "generation ledger 在只读 preflight cache-hit 复核期间发生 SQLite 身份漂移。");
    }
  } else {
    sourceIdentity = await preflightGenerationDatabase(basePaths.database);
    if (!markStudioRequestSqliteValidationIfUnchanged(
      preflightCacheKey,
      `studio-generation-preflight-v${SCHEMA_VERSION}`,
      basePaths.database,
    )) {
      fail("storage-invalid", "generation ledger 在只读快照深验期间发生 SQLite 身份漂移。");
    }
  }
  const packCasRoot = await ensureConfinedDirectory(basePaths.root, basePaths.packCasRoot);
  const packCasTempRoot = await ensureConfinedDirectory(basePaths.root, basePaths.packCasTempRoot);
  const paths: LedgerPaths = {
    ...basePaths,
    databasePreflightIdentity: sourceIdentity,
    storageIdentities: { packCasRoot, packCasTempRoot },
  };
  const hook = beforeGenerationWritableOpenHookForTests;
  beforeGenerationWritableOpenHookForTests = null;
  await hook?.({ databasePath: basePaths.database, sourceIdentity });
  return { paths, projectId: shell.project.id };
}

/**
 * Generation recovery/diagnostic 的严格只读入口：只在系统临时目录打开同一份
 * schema-v7 快照，不调用 managedLedgerPaths、ensureConfinedDirectory 或写库 hook。
 */
export async function withStudioGenerationLedgerReadOnlySnapshot<T>(
  projectRoot: string,
  label: string,
  read: (database: DatabaseSync, context: { projectRoot: string; projectId: string }) => T | Promise<T>,
): Promise<T> {
  let shell: Awaited<ReturnType<typeof inspectManagedProjectReadOnly>>;
  try {
    shell = await inspectManagedProjectReadOnly(projectRoot);
  } catch (error) {
    throw new StudioGenerationLedgerError(
      "unmanaged-project",
      "Studio generation 只读 proof 只允许读取受管项目。",
      [error instanceof Error ? error.message : String(error)],
      { cause: error },
    );
  }
  const databasePath = path.join(shell.paths.root, DATABASE_RELATIVE_PATH);
  let snapshot: Awaited<ReturnType<typeof openSqliteReadOnlySnapshot>> | null = null;
  try {
    snapshot = await openSqliteReadOnlySnapshot(databasePath, label);
    const version = snapshot.database.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
    ).get() as { value?: string } | undefined;
    if (version?.value !== String(SCHEMA_VERSION)) {
      fail("storage-invalid", `generation 只读 proof 要求 schema v${SCHEMA_VERSION}。`);
    }
    assertCurrentSchema(snapshot.database);
    return await read(snapshot.database, { projectRoot: shell.paths.root, projectId: shell.project.id });
  } catch (error) {
    if (error instanceof StudioGenerationLedgerError) throw error;
    throw new StudioGenerationLedgerError(
      "storage-invalid",
      "generation ledger 严格只读 proof 失败。",
      [error instanceof Error ? error.message : String(error)],
      { cause: error },
    );
  } finally {
    await snapshot?.close();
  }
}

function createCurrentSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_generation_ledger_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_generation_packs (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      pack_id TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      content_sha256 TEXT NOT NULL UNIQUE CHECK(length(content_sha256) = 64),
      content_relpath TEXT NOT NULL UNIQUE,
      content_size_bytes INTEGER NOT NULL CHECK(content_size_bytes > 0 AND content_size_bytes <= ${MAX_PACK_BYTES}),
      project_id TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
      panel_id TEXT NOT NULL,
      panel_index INTEGER NOT NULL CHECK(panel_index BETWEEN 1 AND 6),
      created_at TEXT NOT NULL,
      UNIQUE(pack_id, fingerprint)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_generation_dispatches (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      dispatch_id TEXT NOT NULL UNIQUE,
      generation_run_id TEXT NOT NULL UNIQUE,
      pack_id TEXT NOT NULL,
      pack_fingerprint TEXT NOT NULL CHECK(length(pack_fingerprint) = 64),
      executor_provider TEXT NOT NULL CHECK(executor_provider IN ('codex', 'grok')),
      provenance TEXT NOT NULL CHECK(provenance IN ('local-dispatch-intent', 'legacy-registration')),
      dispatched_at TEXT NOT NULL,
      UNIQUE(dispatch_id, generation_run_id, pack_id, pack_fingerprint),
      FOREIGN KEY(pack_id, pack_fingerprint)
        REFERENCES studio_generation_packs(pack_id, fingerprint) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_generation_results (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      result_id TEXT NOT NULL UNIQUE,
      dispatch_id TEXT NOT NULL,
      generation_run_id TEXT NOT NULL,
      variant TEXT NOT NULL CHECK(variant IN ('raw', 'labeled')),
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
      media_sha256 TEXT NOT NULL CHECK(length(media_sha256) = 64),
      input_current INTEGER NOT NULL CHECK(input_current IN (0, 1)),
      promotion_eligible INTEGER NOT NULL CHECK(promotion_eligible IN (0, 1)),
      stale_reasons_json TEXT NOT NULL,
      pack_id TEXT NOT NULL,
      pack_fingerprint TEXT NOT NULL CHECK(length(pack_fingerprint) = 64),
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
      panel_id TEXT NOT NULL,
      panel_index INTEGER NOT NULL CHECK(panel_index BETWEEN 1 AND 6),
      created_at TEXT NOT NULL,
      UNIQUE(generation_run_id, variant),
      FOREIGN KEY(pack_id, pack_fingerprint)
        REFERENCES studio_generation_packs(pack_id, fingerprint) ON DELETE RESTRICT,
      FOREIGN KEY(dispatch_id, generation_run_id, pack_id, pack_fingerprint)
        REFERENCES studio_generation_dispatches(dispatch_id, generation_run_id, pack_id, pack_fingerprint)
        ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS studio_generation_pack_panel_sequence_idx
      ON studio_generation_packs(unit_id, panel_id, sequence);
    CREATE INDEX IF NOT EXISTS studio_generation_result_panel_sequence_idx
      ON studio_generation_results(unit_id, panel_id, sequence);
    CREATE INDEX IF NOT EXISTS studio_generation_result_pack_idx
      ON studio_generation_results(pack_id, sequence);
    CREATE INDEX IF NOT EXISTS studio_generation_dispatch_pack_idx
      ON studio_generation_dispatches(pack_id, sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS studio_generation_dispatch_call_identity_idx
      ON studio_generation_dispatches(dispatch_id, generation_run_id);

    CREATE TRIGGER IF NOT EXISTS studio_generation_packs_no_update
      BEFORE UPDATE ON studio_generation_packs BEGIN SELECT RAISE(ABORT, 'generation packs are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_packs_no_delete
      BEFORE DELETE ON studio_generation_packs BEGIN SELECT RAISE(ABORT, 'generation packs are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_dispatches_no_update
      BEFORE UPDATE ON studio_generation_dispatches BEGIN SELECT RAISE(ABORT, 'generation dispatches are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_dispatches_no_delete
      BEFORE DELETE ON studio_generation_dispatches BEGIN SELECT RAISE(ABORT, 'generation dispatches are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_results_no_update
      BEFORE UPDATE ON studio_generation_results BEGIN SELECT RAISE(ABORT, 'generation results are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_results_no_delete
      BEFORE DELETE ON studio_generation_results BEGIN SELECT RAISE(ABORT, 'generation results are append-only'); END;

    -- P30 v5：旧 packs/results 的 panel NOT NULL 列保持原样。unit-grid 的权威
    -- target、调用前协议和 call intent 均由同一 ledger 的纯增 extension 表表达。
    CREATE TABLE IF NOT EXISTS studio_generation_pack_targets (
      pack_id TEXT NOT NULL,
      pack_fingerprint TEXT NOT NULL CHECK(length(pack_fingerprint) = 64),
      target_kind TEXT NOT NULL CHECK(target_kind = 'unit-grid'),
      target_key TEXT NOT NULL,
      target_fingerprint TEXT NOT NULL CHECK(length(target_fingerprint) = 64),
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
      compatibility_panel_id TEXT NOT NULL,
      compatibility_panel_index INTEGER NOT NULL CHECK(compatibility_panel_index = 1),
      panel_count INTEGER NOT NULL CHECK(panel_count BETWEEN 2 AND 6),
      created_at TEXT NOT NULL,
      PRIMARY KEY(pack_id, pack_fingerprint),
      FOREIGN KEY(pack_id, pack_fingerprint)
        REFERENCES studio_generation_packs(pack_id, fingerprint) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_generation_dispatch_protocols (
      dispatch_id TEXT PRIMARY KEY,
      generation_run_id TEXT NOT NULL UNIQUE,
      protocol_version INTEGER NOT NULL CHECK(protocol_version = 2),
      requires_call_intent INTEGER NOT NULL CHECK(requires_call_intent = 1),
      created_at TEXT NOT NULL,
      UNIQUE(dispatch_id, generation_run_id),
      FOREIGN KEY(dispatch_id, generation_run_id)
        REFERENCES studio_generation_dispatches(dispatch_id, generation_run_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_generation_call_intents (
      call_id TEXT PRIMARY KEY,
      generation_run_id TEXT NOT NULL UNIQUE,
      dispatch_id TEXT NOT NULL UNIQUE,
      pack_id TEXT NOT NULL,
      pack_fingerprint TEXT NOT NULL CHECK(length(pack_fingerprint) = 64),
      executor_provider TEXT NOT NULL CHECK(executor_provider IN ('codex', 'grok')),
      target_kind TEXT NOT NULL CHECK(target_kind IN ('panel', 'unit-grid')),
      target_key TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL UNIQUE CHECK(length(input_fingerprint) = 64),
      context_token_hash TEXT NOT NULL CHECK(length(context_token_hash) = 64),
      command_request_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      caller_agent_id TEXT,
      UNIQUE(call_id, generation_run_id),
      FOREIGN KEY(dispatch_id, generation_run_id, pack_id, pack_fingerprint)
        REFERENCES studio_generation_dispatches(dispatch_id, generation_run_id, pack_id, pack_fingerprint)
        ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_generation_call_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      call_id TEXT NOT NULL,
      generation_run_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('result-committed', 'not-invoked', 'unknown-observation')),
      evidence_reference TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL CHECK(length(evidence_fingerprint) = 64),
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(call_id, generation_run_id)
        REFERENCES studio_generation_call_intents(call_id, generation_run_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_generation_historical_imports (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id TEXT NOT NULL UNIQUE,
      pack_id TEXT NOT NULL,
      pack_fingerprint TEXT NOT NULL CHECK(length(pack_fingerprint) = 64),
      target_kind TEXT NOT NULL CHECK(target_kind = 'unit-grid'),
      target_key TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
      raw_media_sha256 TEXT NOT NULL CHECK(length(raw_media_sha256) = 64),
      labeled_media_sha256 TEXT NOT NULL CHECK(length(labeled_media_sha256) = 64),
      source_raw_sha256 TEXT NOT NULL CHECK(length(source_raw_sha256) = 64),
      source_labeled_sha256 TEXT NOT NULL CHECK(length(source_labeled_sha256) = 64),
      source_manifest_fingerprint TEXT NOT NULL CHECK(length(source_manifest_fingerprint) = 64),
      qc_evidence_reference TEXT NOT NULL,
      qc_evidence_sha256 TEXT NOT NULL CHECK(length(qc_evidence_sha256) = 64),
      external_storyboard_status TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE(pack_id, pack_fingerprint),
      FOREIGN KEY(pack_id, pack_fingerprint)
        REFERENCES studio_generation_packs(pack_id, fingerprint) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_generation_detached_unknown_observations (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id TEXT NOT NULL UNIQUE,
      target_kind TEXT NOT NULL CHECK(target_kind = 'unit-grid'),
      target_key TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
      unit_fingerprint TEXT NOT NULL CHECK(length(unit_fingerprint) = 64),
      source_task_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status = 'generation_unknown'),
      evidence_reference TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL CHECK(length(evidence_fingerprint) = 64),
      candidate_sha256 TEXT CHECK(candidate_sha256 IS NULL OR length(candidate_sha256) = 64),
      candidate_size_bytes INTEGER CHECK(candidate_size_bytes IS NULL OR candidate_size_bytes > 0),
      candidate_width INTEGER CHECK(candidate_width IS NULL OR candidate_width > 0),
      candidate_height INTEGER CHECK(candidate_height IS NULL OR candidate_height > 0),
      note TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE(target_kind, target_key, source_task_id),
      CHECK((candidate_sha256 IS NULL) = (candidate_size_bytes IS NULL)),
      CHECK((candidate_sha256 IS NULL) = (candidate_width IS NULL)),
      CHECK((candidate_sha256 IS NULL) = (candidate_height IS NULL))
    ) STRICT;

    -- v6：detached observation 永久保留；owner 处置以独立 append-only 行关闭防重锁。
    CREATE TABLE IF NOT EXISTS studio_generation_detached_unknown_dispositions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      disposition_id TEXT NOT NULL UNIQUE,
      observation_id TEXT NOT NULL UNIQUE,
      observation_fingerprint TEXT NOT NULL CHECK(length(observation_fingerprint) = 64),
      target_kind TEXT NOT NULL CHECK(target_kind = 'unit-grid'),
      target_key TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
      unit_fingerprint TEXT NOT NULL CHECK(length(unit_fingerprint) = 64),
      source_task_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status = 'owner-abandoned'),
      remote_invocation TEXT NOT NULL CHECK(remote_invocation = 'unknown-may-exist'),
      detached_candidate_policy TEXT NOT NULL CHECK(detached_candidate_policy = 'never-import-or-reuse'),
      next_run_policy TEXT NOT NULL CHECK(next_run_policy = 'fresh-formal-run-only'),
      authorization_evidence_reference TEXT NOT NULL,
      authorization_text_sha256 TEXT NOT NULL CHECK(length(authorization_text_sha256) = 64),
      reason TEXT NOT NULL CHECK(length(reason) BETWEEN 8 AND 500),
      project_id TEXT NOT NULL,
      manifest_fingerprint TEXT NOT NULL CHECK(length(manifest_fingerprint) = 64),
      context_token_hash TEXT NOT NULL CHECK(length(context_token_hash) = 64),
      build_id TEXT NOT NULL,
      source_digest TEXT NOT NULL CHECK(length(source_digest) = 64),
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      FOREIGN KEY(observation_id)
        REFERENCES studio_generation_detached_unknown_observations(observation_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS studio_generation_pack_targets_key_idx
      ON studio_generation_pack_targets(target_kind, target_key, created_at, pack_id);
    CREATE INDEX IF NOT EXISTS studio_generation_call_events_call_idx
      ON studio_generation_call_events(call_id, sequence);
    CREATE INDEX IF NOT EXISTS studio_generation_historical_import_target_idx
      ON studio_generation_historical_imports(target_kind, target_key, sequence);
    CREATE INDEX IF NOT EXISTS studio_generation_detached_unknown_target_idx
      ON studio_generation_detached_unknown_observations(target_kind, target_key, sequence);
    CREATE INDEX IF NOT EXISTS studio_generation_detached_disposition_target_idx
      ON studio_generation_detached_unknown_dispositions(target_kind, target_key, sequence);
    CREATE TRIGGER IF NOT EXISTS studio_generation_pack_targets_no_update
      BEFORE UPDATE ON studio_generation_pack_targets BEGIN SELECT RAISE(ABORT, 'generation pack targets are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_pack_targets_no_delete
      BEFORE DELETE ON studio_generation_pack_targets BEGIN SELECT RAISE(ABORT, 'generation pack targets are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_dispatch_protocols_no_update
      BEFORE UPDATE ON studio_generation_dispatch_protocols BEGIN SELECT RAISE(ABORT, 'generation dispatch protocols are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_dispatch_protocols_no_delete
      BEFORE DELETE ON studio_generation_dispatch_protocols BEGIN SELECT RAISE(ABORT, 'generation dispatch protocols are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_call_intents_no_update
      BEFORE UPDATE ON studio_generation_call_intents BEGIN SELECT RAISE(ABORT, 'generation call intents are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_call_intents_no_delete
      BEFORE DELETE ON studio_generation_call_intents BEGIN SELECT RAISE(ABORT, 'generation call intents are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_call_events_no_update
      BEFORE UPDATE ON studio_generation_call_events BEGIN SELECT RAISE(ABORT, 'generation call events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_call_events_no_delete
      BEFORE DELETE ON studio_generation_call_events BEGIN SELECT RAISE(ABORT, 'generation call events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_historical_imports_no_update
      BEFORE UPDATE ON studio_generation_historical_imports BEGIN SELECT RAISE(ABORT, 'historical generation imports are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_historical_imports_no_delete
      BEFORE DELETE ON studio_generation_historical_imports BEGIN SELECT RAISE(ABORT, 'historical generation imports are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_detached_unknown_no_update
      BEFORE UPDATE ON studio_generation_detached_unknown_observations BEGIN SELECT RAISE(ABORT, 'detached generation observations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_detached_unknown_no_delete
      BEFORE DELETE ON studio_generation_detached_unknown_observations BEGIN SELECT RAISE(ABORT, 'detached generation observations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_detached_disposition_no_update
      BEFORE UPDATE ON studio_generation_detached_unknown_dispositions BEGIN SELECT RAISE(ABORT, 'detached generation dispositions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_detached_disposition_no_delete
      BEFORE DELETE ON studio_generation_detached_unknown_dispositions BEGIN SELECT RAISE(ABORT, 'detached generation dispositions are append-only'); END;

    -- P21 v4：生成计划/节点/运行事件（纯增；状态永不改行，事件即事实）。
    CREATE TABLE IF NOT EXISTS studio_generation_plans (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      source_command_request_id TEXT NOT NULL,
      node_count INTEGER NOT NULL CHECK(node_count BETWEEN 1 AND 36),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_generation_plan_nodes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT NOT NULL REFERENCES studio_generation_plans(plan_id) ON DELETE RESTRICT,
      node_index INTEGER NOT NULL,
      unit_id TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      pack_id TEXT NOT NULL,
      pack_fingerprint TEXT NOT NULL CHECK(length(pack_fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE(plan_id, node_index),
      UNIQUE(plan_id, unit_id, panel_id),
      FOREIGN KEY(pack_id, pack_fingerprint)
        REFERENCES studio_generation_packs(pack_id, fingerprint) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_generation_plan_node_targets (
      plan_id TEXT NOT NULL,
      node_index INTEGER NOT NULL,
      target_kind TEXT NOT NULL CHECK(target_kind = 'unit-grid'),
      target_key TEXT NOT NULL,
      target_fingerprint TEXT NOT NULL CHECK(length(target_fingerprint) = 64),
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
      created_at TEXT NOT NULL,
      PRIMARY KEY(plan_id, node_index),
      FOREIGN KEY(plan_id, node_index)
        REFERENCES studio_generation_plan_nodes(plan_id, node_index) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_generation_run_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      generation_run_id TEXT NOT NULL,
      plan_id TEXT REFERENCES studio_generation_plans(plan_id) ON DELETE RESTRICT,
      node_index INTEGER,
      kind TEXT NOT NULL CHECK(kind IN ('dispatched', 'failed', 'cancel-requested', 'cancelled', 'retry-superseded')),
      attempt INTEGER NOT NULL CHECK(attempt >= 1),
      supersedes_run_id TEXT,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS studio_generation_plan_nodes_pack_idx
      ON studio_generation_plan_nodes(pack_id, pack_fingerprint, sequence);
    CREATE INDEX IF NOT EXISTS studio_generation_plan_node_targets_key_idx
      ON studio_generation_plan_node_targets(target_kind, target_key, plan_id, node_index);
    CREATE INDEX IF NOT EXISTS studio_generation_run_events_run_idx
      ON studio_generation_run_events(generation_run_id, sequence);
    CREATE INDEX IF NOT EXISTS studio_generation_run_events_plan_node_idx
      ON studio_generation_run_events(plan_id, node_index, sequence);

    CREATE TRIGGER IF NOT EXISTS studio_generation_plans_no_update
      BEFORE UPDATE ON studio_generation_plans BEGIN SELECT RAISE(ABORT, 'generation plans are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_plans_no_delete
      BEFORE DELETE ON studio_generation_plans BEGIN SELECT RAISE(ABORT, 'generation plans are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_plan_nodes_no_update
      BEFORE UPDATE ON studio_generation_plan_nodes BEGIN SELECT RAISE(ABORT, 'generation plan nodes are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_plan_nodes_no_delete
      BEFORE DELETE ON studio_generation_plan_nodes BEGIN SELECT RAISE(ABORT, 'generation plan nodes are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_plan_node_targets_no_update
      BEFORE UPDATE ON studio_generation_plan_node_targets BEGIN SELECT RAISE(ABORT, 'generation plan node targets are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_plan_node_targets_no_delete
      BEFORE DELETE ON studio_generation_plan_node_targets BEGIN SELECT RAISE(ABORT, 'generation plan node targets are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_run_events_no_update
      BEFORE UPDATE ON studio_generation_run_events BEGIN SELECT RAISE(ABORT, 'generation run events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_run_events_no_delete
      BEFORE DELETE ON studio_generation_run_events BEGIN SELECT RAISE(ABORT, 'generation run events are append-only'); END;
  `);
}

/** v3→v4 只能创建本版本的纯增对象；不得借当前全量 schema 提前落下 v5。 */
function createV4SchemaExtensions(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE studio_generation_plans (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      source_command_request_id TEXT NOT NULL,
      node_count INTEGER NOT NULL CHECK(node_count BETWEEN 1 AND 36),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE studio_generation_plan_nodes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT NOT NULL REFERENCES studio_generation_plans(plan_id) ON DELETE RESTRICT,
      node_index INTEGER NOT NULL,
      unit_id TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      pack_id TEXT NOT NULL,
      pack_fingerprint TEXT NOT NULL CHECK(length(pack_fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE(plan_id, node_index),
      UNIQUE(plan_id, unit_id, panel_id),
      FOREIGN KEY(pack_id, pack_fingerprint)
        REFERENCES studio_generation_packs(pack_id, fingerprint) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE studio_generation_run_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      generation_run_id TEXT NOT NULL,
      plan_id TEXT REFERENCES studio_generation_plans(plan_id) ON DELETE RESTRICT,
      node_index INTEGER,
      kind TEXT NOT NULL CHECK(kind IN ('dispatched', 'failed', 'cancel-requested', 'cancelled', 'retry-superseded')),
      attempt INTEGER NOT NULL CHECK(attempt >= 1),
      supersedes_run_id TEXT,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX studio_generation_plan_nodes_pack_idx
      ON studio_generation_plan_nodes(pack_id, pack_fingerprint, sequence);
    CREATE INDEX studio_generation_run_events_run_idx
      ON studio_generation_run_events(generation_run_id, sequence);
    CREATE INDEX studio_generation_run_events_plan_node_idx
      ON studio_generation_run_events(plan_id, node_index, sequence);

    CREATE TRIGGER studio_generation_plans_no_update
      BEFORE UPDATE ON studio_generation_plans BEGIN SELECT RAISE(ABORT, 'generation plans are append-only'); END;
    CREATE TRIGGER studio_generation_plans_no_delete
      BEFORE DELETE ON studio_generation_plans BEGIN SELECT RAISE(ABORT, 'generation plans are append-only'); END;
    CREATE TRIGGER studio_generation_plan_nodes_no_update
      BEFORE UPDATE ON studio_generation_plan_nodes BEGIN SELECT RAISE(ABORT, 'generation plan nodes are append-only'); END;
    CREATE TRIGGER studio_generation_plan_nodes_no_delete
      BEFORE DELETE ON studio_generation_plan_nodes BEGIN SELECT RAISE(ABORT, 'generation plan nodes are append-only'); END;
    CREATE TRIGGER studio_generation_run_events_no_update
      BEFORE UPDATE ON studio_generation_run_events BEGIN SELECT RAISE(ABORT, 'generation run events are append-only'); END;
    CREATE TRIGGER studio_generation_run_events_no_delete
      BEFORE DELETE ON studio_generation_run_events BEGIN SELECT RAISE(ABORT, 'generation run events are append-only'); END;
  `);
}

const V4_EXTENSION_OBJECT_NAMES = [
  "studio_generation_plans",
  "studio_generation_plan_nodes",
  "studio_generation_run_events",
  "studio_generation_plan_nodes_pack_idx",
  "studio_generation_run_events_run_idx",
  "studio_generation_run_events_plan_node_idx",
  "studio_generation_plans_no_update",
  "studio_generation_plans_no_delete",
  "studio_generation_plan_nodes_no_update",
  "studio_generation_plan_nodes_no_delete",
  "studio_generation_run_events_no_update",
  "studio_generation_run_events_no_delete",
] as const;

const V5_EXTENSION_OBJECT_NAMES = [
  "studio_generation_pack_targets",
  "studio_generation_dispatch_protocols",
  "studio_generation_call_intents",
  "studio_generation_call_events",
  "studio_generation_historical_imports",
  "studio_generation_detached_unknown_observations",
  "studio_generation_plan_node_targets",
  "studio_generation_dispatch_call_identity_idx",
  "studio_generation_pack_targets_key_idx",
  "studio_generation_call_events_call_idx",
  "studio_generation_historical_import_target_idx",
  "studio_generation_detached_unknown_target_idx",
  "studio_generation_plan_node_targets_key_idx",
  "studio_generation_pack_targets_no_update",
  "studio_generation_pack_targets_no_delete",
  "studio_generation_dispatch_protocols_no_update",
  "studio_generation_dispatch_protocols_no_delete",
  "studio_generation_call_intents_no_update",
  "studio_generation_call_intents_no_delete",
  "studio_generation_call_events_no_update",
  "studio_generation_call_events_no_delete",
  "studio_generation_historical_imports_no_update",
  "studio_generation_historical_imports_no_delete",
  "studio_generation_detached_unknown_no_update",
  "studio_generation_detached_unknown_no_delete",
  "studio_generation_plan_node_targets_no_update",
  "studio_generation_plan_node_targets_no_delete",
] as const;

const V6_EXTENSION_OBJECT_NAMES = [
  "studio_generation_detached_unknown_dispositions",
  "studio_generation_detached_disposition_target_idx",
  "studio_generation_detached_disposition_no_update",
  "studio_generation_detached_disposition_no_delete",
] as const;

function createV6SchemaExtensions(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE studio_generation_detached_unknown_dispositions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      disposition_id TEXT NOT NULL UNIQUE,
      observation_id TEXT NOT NULL UNIQUE,
      observation_fingerprint TEXT NOT NULL CHECK(length(observation_fingerprint) = 64),
      target_kind TEXT NOT NULL CHECK(target_kind = 'unit-grid'),
      target_key TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
      unit_fingerprint TEXT NOT NULL CHECK(length(unit_fingerprint) = 64),
      source_task_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status = 'owner-abandoned'),
      remote_invocation TEXT NOT NULL CHECK(remote_invocation = 'unknown-may-exist'),
      detached_candidate_policy TEXT NOT NULL CHECK(detached_candidate_policy = 'never-import-or-reuse'),
      next_run_policy TEXT NOT NULL CHECK(next_run_policy = 'fresh-formal-run-only'),
      authorization_evidence_reference TEXT NOT NULL,
      authorization_text_sha256 TEXT NOT NULL CHECK(length(authorization_text_sha256) = 64),
      reason TEXT NOT NULL CHECK(length(reason) BETWEEN 8 AND 500),
      project_id TEXT NOT NULL,
      manifest_fingerprint TEXT NOT NULL CHECK(length(manifest_fingerprint) = 64),
      context_token_hash TEXT NOT NULL CHECK(length(context_token_hash) = 64),
      build_id TEXT NOT NULL,
      source_digest TEXT NOT NULL CHECK(length(source_digest) = 64),
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      FOREIGN KEY(observation_id)
        REFERENCES studio_generation_detached_unknown_observations(observation_id) ON DELETE RESTRICT
    ) STRICT;
    CREATE INDEX studio_generation_detached_disposition_target_idx
      ON studio_generation_detached_unknown_dispositions(target_kind, target_key, sequence);
    CREATE TRIGGER studio_generation_detached_disposition_no_update
      BEFORE UPDATE ON studio_generation_detached_unknown_dispositions BEGIN SELECT RAISE(ABORT, 'detached generation dispositions are append-only'); END;
    CREATE TRIGGER studio_generation_detached_disposition_no_delete
      BEFORE DELETE ON studio_generation_detached_unknown_dispositions BEGIN SELECT RAISE(ABORT, 'detached generation dispositions are append-only'); END;
  `);
}

function assertSchemaObjectsAbsent(db: DatabaseSync, names: readonly string[], label: string): void {
  const placeholders = names.map(() => "?").join(",");
  const row = db.prepare(`
    SELECT type, name FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view') AND name IN (${placeholders})
    LIMIT 1
  `).get(...names) as { type?: string; name?: string } | undefined;
  if (row?.name) fail("storage-invalid", `${label} 含迁移后 ${row.type ?? "schema"} 残留：${row.name}`);
}

export function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/**
 * continuation waiver receipt 是 v6 上的 append-only 安全扩展；不改写既有 core
 * schema_version，避免真实生产账本因新增授权能力被重建。
 */
function ensureContinuationWaiverReceiptSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_generation_continuation_waiver_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id TEXT NOT NULL UNIQUE,
      authority_kind TEXT NOT NULL CHECK(authority_kind IN ('user-authorization', 'verified-historical-import')),
      project_id TEXT NOT NULL,
      current_unit_id TEXT NOT NULL,
      current_unit_revision INTEGER NOT NULL CHECK(current_unit_revision >= 1),
      current_unit_fingerprint TEXT NOT NULL CHECK(length(current_unit_fingerprint) = 64),
      previous_unit_id TEXT NOT NULL,
      previous_unit_revision INTEGER NOT NULL CHECK(previous_unit_revision >= 1),
      previous_unit_fingerprint TEXT NOT NULL CHECK(length(previous_unit_fingerprint) = 64),
      authorization_evidence_reference TEXT NOT NULL,
      authorization_text_sha256 TEXT NOT NULL CHECK(length(authorization_text_sha256) = 64),
      reason TEXT NOT NULL CHECK(length(reason) BETWEEN 8 AND 500),
      acknowledge_previous_actual_tail_unavailable INTEGER NOT NULL CHECK(acknowledge_previous_actual_tail_unavailable = 1),
      acknowledge_canonical_restart_may_break_continuity INTEGER NOT NULL CHECK(acknowledge_canonical_restart_may_break_continuity = 1),
      acknowledge_identity_and_scene_locks_remain_mandatory INTEGER NOT NULL CHECK(acknowledge_identity_and_scene_locks_remain_mandatory = 1),
      manifest_fingerprint TEXT CHECK(manifest_fingerprint IS NULL OR length(manifest_fingerprint) = 64),
      context_token_hash TEXT CHECK(context_token_hash IS NULL OR length(context_token_hash) = 64),
      build_id TEXT,
      source_digest TEXT CHECK(source_digest IS NULL OR length(source_digest) = 64),
      source_manifest_fingerprint TEXT CHECK(source_manifest_fingerprint IS NULL OR length(source_manifest_fingerprint) = 64),
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      CHECK(
        (authority_kind = 'user-authorization'
          AND manifest_fingerprint IS NOT NULL
          AND context_token_hash IS NOT NULL
          AND build_id IS NOT NULL
          AND source_digest IS NOT NULL
          AND source_manifest_fingerprint IS NULL)
        OR
        (authority_kind = 'verified-historical-import'
          AND manifest_fingerprint IS NULL
          AND context_token_hash IS NULL
          AND build_id IS NULL
          AND source_digest IS NULL
          AND source_manifest_fingerprint IS NOT NULL)
      )
    ) STRICT;
    CREATE INDEX IF NOT EXISTS studio_generation_continuation_waiver_current_unit_idx
      ON studio_generation_continuation_waiver_receipts(current_unit_id, sequence);
    CREATE TRIGGER IF NOT EXISTS studio_generation_continuation_waiver_no_update
      BEFORE UPDATE ON studio_generation_continuation_waiver_receipts
      BEGIN SELECT RAISE(ABORT, 'continuation waiver receipts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_continuation_waiver_no_delete
      BEFORE DELETE ON studio_generation_continuation_waiver_receipts
      BEGIN SELECT RAISE(ABORT, 'continuation waiver receipts are append-only'); END;
  `);
  const expectedColumns = [
    "sequence", "receipt_id", "authority_kind", "project_id",
    "current_unit_id", "current_unit_revision", "current_unit_fingerprint",
    "previous_unit_id", "previous_unit_revision", "previous_unit_fingerprint",
    "authorization_evidence_reference", "authorization_text_sha256", "reason",
    "acknowledge_previous_actual_tail_unavailable",
    "acknowledge_canonical_restart_may_break_continuity",
    "acknowledge_identity_and_scene_locks_remain_mandatory",
    "manifest_fingerprint", "context_token_hash", "build_id", "source_digest",
    "source_manifest_fingerprint", "fingerprint", "created_at",
  ];
  const columns = (db.prepare(
    "PRAGMA table_info(studio_generation_continuation_waiver_receipts)",
  ).all() as Array<{ name: string }>).map((column) => column.name);
  if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) {
    fail("storage-invalid", "continuation waiver receipt 扩展 schema 已漂移。");
  }
  for (const triggerName of [
    "studio_generation_continuation_waiver_no_update",
    "studio_generation_continuation_waiver_no_delete",
  ]) {
    const trigger = db.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type='trigger' AND name=?",
    ).get(triggerName) as { found?: number } | undefined;
    if (trigger?.found !== 1) fail("storage-invalid", `continuation waiver receipt 缺少 ${triggerName}。`);
  }
}

/**
 * retry command 的原子 operation receipt 是 v7 上的 append-only 扩展；由唯一
 * generation writer 在与 run events 同一事务中写入，不提升 core schema 版本。
 */
function ensureGenerationRetryOperationReceiptSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_generation_retry_operation_receipts (
      operation_id TEXT PRIMARY KEY CHECK(length(operation_id) = 64),
      request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64),
      plan_id TEXT NOT NULL,
      outcome_json TEXT NOT NULL CHECK(length(outcome_json) BETWEEN 2 AND 32768),
      outcome_fingerprint TEXT NOT NULL CHECK(length(outcome_fingerprint) = 64),
      receipt_fingerprint TEXT NOT NULL UNIQUE CHECK(length(receipt_fingerprint) = 64),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS studio_generation_retry_operation_receipts_no_update
      BEFORE UPDATE ON studio_generation_retry_operation_receipts
      BEGIN SELECT RAISE(ABORT, 'generation retry operation receipts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_generation_retry_operation_receipts_no_delete
      BEFORE DELETE ON studio_generation_retry_operation_receipts
      BEGIN SELECT RAISE(ABORT, 'generation retry operation receipts are append-only'); END;
  `);
  assertGenerationRetryOperationReceiptSchema(db);
}

export function assertGenerationRetryOperationReceiptSchema(db: DatabaseSync): void {
  const table = "studio_generation_retry_operation_receipts";
  const expected = [
    { name: "operation_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "request_fingerprint", type: "TEXT", notnull: 1, pk: 0 },
    { name: "plan_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "outcome_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "outcome_fingerprint", type: "TEXT", notnull: 1, pk: 0 },
    { name: "receipt_fingerprint", type: "TEXT", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
  ];
  const columns = db.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
    hidden: number;
  }>;
  if (columns.length !== expected.length || columns.some((column, index) => {
    const wanted = expected[index];
    return !wanted || column.name !== wanted.name || column.type.toUpperCase() !== wanted.type
      || Number(column.notnull) !== wanted.notnull || Number(column.pk) !== wanted.pk
      || Number(column.hidden) !== 0;
  })) {
    fail("storage-invalid", "generation retry operation receipt 7 列合同漂移。");
  }
  const tableSql = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table) as { sql?: string } | undefined)?.sql ?? "";
  const normalizedTableSql = tableSql.replace(/\s+/gu, " ").trim().toLowerCase()
    .replace(/if not exists /gu, "");
  const requiredTableClauses = [
    "create table studio_generation_retry_operation_receipts",
    "operation_id text primary key check(length(operation_id) = 64)",
    "request_fingerprint text not null check(length(request_fingerprint) = 64)",
    "outcome_json text not null check(length(outcome_json) between 2 and 32768)",
    "outcome_fingerprint text not null check(length(outcome_fingerprint) = 64)",
    "receipt_fingerprint text not null unique check(length(receipt_fingerprint) = 64)",
    ") strict",
  ];
  if (requiredTableClauses.some((clause) => !normalizedTableSql.includes(clause))) {
    fail("storage-invalid", "generation retry operation receipt STRICT/CHECK 合同漂移。");
  }
  for (const event of ["update", "delete"] as const) {
    const name = `studio_generation_retry_operation_receipts_no_${event}`;
    const sql = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
    ).get(name) as { sql?: string } | undefined)?.sql ?? "";
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase()
      .replace(/if not exists /gu, "");
    const expected = `create trigger ${name} before ${event} on ${table} begin select raise(abort, 'generation retry operation receipts are append-only'); end`;
    const exact = new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u");
    if (!exact.test(normalized)) {
      fail("storage-invalid", `generation retry operation receipt no_${event} trigger 漂移。`);
    }
  }
}

export function dispatchIdentity(input: {
  generationRunId: string;
  packId: string;
  packFingerprint: string;
  provenance: StudioGenerationDispatchProvenance;
  provider: StudioFormalImagegenProvider;
}): string {
  return `studio-generation-dispatch-${stableDigest({ schemaVersion: 3, ...input }).slice(0, 40)}`;
}

interface LegacyResultRow {
  sequence: number;
  result_id: string;
  generation_run_id: string;
  variant: StudioGenerationResultVariant;
  status: StudioGenerationResultStatus;
  media_sha256: string;
  pack_id: string;
  pack_fingerprint: string;
  unit_id: string;
  unit_revision: number;
  panel_id: string;
  panel_index: number;
  created_at: string;
}

/**
 * v1 没有 dispatch 表。迁移只把“旧版结果曾通过登记前置校验”记为
 * legacy-registration，绝不据此声称远程提交曾发生。
 */
/**
 * v2 → v3：dispatch 补 executor_provider。历史正式面只有 codex，迁移默认 codex。
 */
function migrateV2ToV3(db: DatabaseSync): void {
  runTransaction(db, () => {
    const currentVersion = db.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
    ).get() as { value?: string } | undefined;
    if (currentVersion?.value === String(V3_SCHEMA_VERSION)) return;
    if (currentVersion?.value !== String(V2_SCHEMA_VERSION)) {
      fail("storage-invalid", `v2→v3 迁移期望 schema ${V2_SCHEMA_VERSION}，实际 ${currentVersion?.value ?? "缺失"}。`);
    }
    if (!tableExists(db, "studio_generation_dispatches")) {
      fail("storage-invalid", "generation ledger v2 缺少 dispatches 表。");
    }
    const columns = (db.prepare("PRAGMA table_info(studio_generation_dispatches)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    if (columns.includes("executor_provider")) {
      db.prepare("UPDATE studio_generation_ledger_meta SET value = ? WHERE key = 'schema_version'")
        .run(String(V3_SCHEMA_VERSION));
      return;
    }
    type V2Dispatch = {
      sequence: number;
      dispatch_id: string;
      generation_run_id: string;
      pack_id: string;
      pack_fingerprint: string;
      provenance: StudioGenerationDispatchProvenance;
      dispatched_at: string;
    };
    const rows = db.prepare("SELECT * FROM studio_generation_dispatches ORDER BY sequence")
      .all() as unknown as V2Dispatch[];
    db.exec(`
      DROP TRIGGER IF EXISTS studio_generation_dispatches_no_update;
      DROP TRIGGER IF EXISTS studio_generation_dispatches_no_delete;
      DROP TRIGGER IF EXISTS studio_generation_results_no_update;
      DROP TRIGGER IF EXISTS studio_generation_results_no_delete;
      DROP INDEX IF EXISTS studio_generation_dispatch_pack_idx;
      DROP INDEX IF EXISTS studio_generation_result_panel_sequence_idx;
      DROP INDEX IF EXISTS studio_generation_result_pack_idx;
      ALTER TABLE studio_generation_results RENAME TO studio_generation_results_v2_migration;
      ALTER TABLE studio_generation_dispatches RENAME TO studio_generation_dispatches_v2_migration;
    `);
    // packs 保留；仅重建 dispatches/results
    db.exec(`
      CREATE TABLE studio_generation_dispatches (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        dispatch_id TEXT NOT NULL UNIQUE,
        generation_run_id TEXT NOT NULL UNIQUE,
        pack_id TEXT NOT NULL,
        pack_fingerprint TEXT NOT NULL CHECK(length(pack_fingerprint) = 64),
        executor_provider TEXT NOT NULL CHECK(executor_provider IN ('codex', 'grok')),
        provenance TEXT NOT NULL CHECK(provenance IN ('local-dispatch-intent', 'legacy-registration')),
        dispatched_at TEXT NOT NULL,
        UNIQUE(dispatch_id, generation_run_id, pack_id, pack_fingerprint),
        FOREIGN KEY(pack_id, pack_fingerprint)
          REFERENCES studio_generation_packs(pack_id, fingerprint) ON DELETE RESTRICT
      ) STRICT;
      CREATE TABLE studio_generation_results (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        result_id TEXT NOT NULL UNIQUE,
        dispatch_id TEXT NOT NULL,
        generation_run_id TEXT NOT NULL,
        variant TEXT NOT NULL CHECK(variant IN ('raw', 'labeled')),
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
        media_sha256 TEXT NOT NULL CHECK(length(media_sha256) = 64),
        input_current INTEGER NOT NULL CHECK(input_current IN (0, 1)),
        promotion_eligible INTEGER NOT NULL CHECK(promotion_eligible IN (0, 1)),
        stale_reasons_json TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        pack_fingerprint TEXT NOT NULL CHECK(length(pack_fingerprint) = 64),
        unit_id TEXT NOT NULL,
        unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
        panel_id TEXT NOT NULL,
        panel_index INTEGER NOT NULL CHECK(panel_index BETWEEN 1 AND 6),
        created_at TEXT NOT NULL,
        UNIQUE(generation_run_id, variant),
        FOREIGN KEY(pack_id, pack_fingerprint)
          REFERENCES studio_generation_packs(pack_id, fingerprint) ON DELETE RESTRICT,
        FOREIGN KEY(dispatch_id, generation_run_id, pack_id, pack_fingerprint)
          REFERENCES studio_generation_dispatches(dispatch_id, generation_run_id, pack_id, pack_fingerprint)
          ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX studio_generation_result_panel_sequence_idx
        ON studio_generation_results(unit_id, panel_id, sequence);
      CREATE INDEX studio_generation_result_pack_idx
        ON studio_generation_results(pack_id, sequence);
      CREATE INDEX studio_generation_dispatch_pack_idx
        ON studio_generation_dispatches(pack_id, sequence);
      CREATE TRIGGER studio_generation_dispatches_no_update
        BEFORE UPDATE ON studio_generation_dispatches BEGIN SELECT RAISE(ABORT, 'generation dispatches are append-only'); END;
      CREATE TRIGGER studio_generation_dispatches_no_delete
        BEFORE DELETE ON studio_generation_dispatches BEGIN SELECT RAISE(ABORT, 'generation dispatches are append-only'); END;
      CREATE TRIGGER studio_generation_results_no_update
        BEFORE UPDATE ON studio_generation_results BEGIN SELECT RAISE(ABORT, 'generation results are append-only'); END;
      CREATE TRIGGER studio_generation_results_no_delete
        BEFORE DELETE ON studio_generation_results BEGIN SELECT RAISE(ABORT, 'generation results are append-only'); END;
    `);
    const insertDispatch = db.prepare(`
      INSERT INTO studio_generation_dispatches(
        sequence, dispatch_id, generation_run_id, pack_id, pack_fingerprint, executor_provider, provenance, dispatched_at
      ) VALUES(?, ?, ?, ?, ?, 'codex', ?, ?)
    `);
    for (const row of rows) {
      insertDispatch.run(
        row.sequence,
        row.dispatch_id,
        row.generation_run_id,
        row.pack_id,
        row.pack_fingerprint,
        row.provenance,
        row.dispatched_at,
      );
    }
    const resultRows = db.prepare("SELECT * FROM studio_generation_results_v2_migration ORDER BY sequence")
      .all() as unknown as ResultRow[];
    const insertResult = db.prepare(`
      INSERT INTO studio_generation_results(
        sequence, result_id, dispatch_id, generation_run_id, variant, status, media_sha256,
        input_current, promotion_eligible, stale_reasons_json,
        pack_id, pack_fingerprint, unit_id, unit_revision, panel_id, panel_index, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of resultRows) {
      insertResult.run(
        row.sequence,
        row.result_id,
        row.dispatch_id,
        row.generation_run_id,
        row.variant,
        row.status,
        row.media_sha256,
        row.input_current,
        row.promotion_eligible,
        row.stale_reasons_json,
        row.pack_id,
        row.pack_fingerprint,
        row.unit_id,
        row.unit_revision,
        row.panel_id,
        row.panel_index,
        row.created_at,
      );
    }
    db.exec(`
      DROP TABLE studio_generation_results_v2_migration;
      DROP TABLE studio_generation_dispatches_v2_migration;
    `);
    db.prepare("UPDATE studio_generation_ledger_meta SET value = ? WHERE key = 'schema_version'")
      .run(String(V3_SCHEMA_VERSION));
  });
}

/** v3 → v4：纯增 plans/plan_nodes/run_events 三表与触发器，不重建旧表，既有数据零影响。 */
function migrateV3ToV4(db: DatabaseSync): void {
  runTransaction(db, () => {
    const currentVersion = db.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
    ).get() as { value?: string } | undefined;
    if (currentVersion?.value === String(V4_SCHEMA_VERSION)
      || currentVersion?.value === String(V5_SCHEMA_VERSION)
      || currentVersion?.value === String(V6_SCHEMA_VERSION)
      || currentVersion?.value === String(SCHEMA_VERSION)) return;
    if (currentVersion?.value !== String(V3_SCHEMA_VERSION)) {
      fail("storage-invalid", `v3→v4 迁移期望 schema ${V3_SCHEMA_VERSION}，实际 ${currentVersion?.value ?? "缺失"}。`);
    }
    // 真实 v3 不得含任何 v4/v5 残留；仅创建 v4 自身的纯增对象。
    assertSchemaObjectsAbsent(
      db,
      [...V4_EXTENSION_OBJECT_NAMES, ...V5_EXTENSION_OBJECT_NAMES, ...V6_EXTENSION_OBJECT_NAMES],
      "generation ledger v3",
    );
    createV4SchemaExtensions(db);
    db.prepare("UPDATE studio_generation_ledger_meta SET value = ? WHERE key = 'schema_version'")
      .run(String(V4_SCHEMA_VERSION));
    // 同一事务内证明 base v3 + 新 v4 完整闭合；失败即回滚所有 DDL/marker。
    assertV4Schema(db);
  });
}

/** v4 → current：旧 v4 尚无 call intent 表，可直接创建当前 extension。 */
function migrateV4ToCurrent(db: DatabaseSync): void {
  runTransaction(db, () => {
    const currentVersion = db.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
    ).get() as { value?: string } | undefined;
    if (currentVersion?.value === String(SCHEMA_VERSION)) return;
    if (currentVersion?.value !== String(V4_SCHEMA_VERSION)) {
      fail("storage-invalid", `v4→v7 迁移期望 schema ${V4_SCHEMA_VERSION}，实际 ${currentVersion?.value ?? "缺失"}。`);
    }
    // 必须先证明这是一个完整且仅含 v4 对象的旧账本。若先执行 IF NOT EXISTS，
    // 缺失的旧对象会被静默补齐，残留的 v5 对象也可能被误当成可继续迁移。
    assertV4Schema(db);
    createCurrentSchema(db);
    // 先在同一事务内证明新扩展的结构、约束、触发器、外键与数据闭包；
    // 任一失败均回滚全部 DDL，schema marker 保持 v4。
    assertCurrentSchema(db);
    db.prepare("UPDATE studio_generation_ledger_meta SET value = ? WHERE key = 'schema_version'")
      .run(String(SCHEMA_VERSION));
    const promoted = db.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
    ).get() as { value?: string } | undefined;
    if (promoted?.value !== String(SCHEMA_VERSION)) {
      fail("storage-invalid", "v4→v7 migration marker 未在事务内闭合。 ");
    }
  });
}

/** v5 → v6：只追加 detached owner disposition 表；观察行与候选证据零修改。 */
function migrateV5ToV6(db: DatabaseSync): void {
  runTransaction(db, () => {
    const currentVersion = db.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
    ).get() as { value?: string } | undefined;
    if (currentVersion?.value === String(V6_SCHEMA_VERSION)
      || currentVersion?.value === String(SCHEMA_VERSION)) return;
    if (currentVersion?.value !== String(V5_SCHEMA_VERSION)) {
      fail("storage-invalid", `v5→v6 迁移期望 schema ${V5_SCHEMA_VERSION}，实际 ${currentVersion?.value ?? "缺失"}。`);
    }
    assertV5Schema(db);
    assertSchemaObjectsAbsent(db, V6_EXTENSION_OBJECT_NAMES, "generation ledger v5");
    createV6SchemaExtensions(db);
    assertV6Schema(db);
    db.prepare("UPDATE studio_generation_ledger_meta SET value = ? WHERE key = 'schema_version'")
      .run(String(V6_SCHEMA_VERSION));
    const promoted = db.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
    ).get() as { value?: string } | undefined;
    if (promoted?.value !== String(V6_SCHEMA_VERSION)) {
      fail("storage-invalid", "v5→v6 migration marker 未在事务内闭合。 ");
    }
  });
}

/** v6 → v7：为 append-only call intent 增加可空调用代理审计身份。 */
function migrateV6ToV7(db: DatabaseSync): void {
  runTransaction(db, () => {
    const currentVersion = db.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
    ).get() as { value?: string } | undefined;
    if (currentVersion?.value === String(SCHEMA_VERSION)) return;
    if (currentVersion?.value !== String(V6_SCHEMA_VERSION)) {
      fail("storage-invalid", `v6→v7 迁移期望 schema ${V6_SCHEMA_VERSION}，实际 ${currentVersion?.value ?? "缺失"}。`);
    }
    // 先证明是真实完整 v6，禁止把弱表通过 ADD COLUMN 冒充当前账本。
    assertV6Schema(db);
    db.exec("ALTER TABLE studio_generation_call_intents ADD COLUMN caller_agent_id TEXT");
    assertCurrentSchema(db);
    db.prepare("UPDATE studio_generation_ledger_meta SET value = ? WHERE key = 'schema_version'")
      .run(String(SCHEMA_VERSION));
    const promoted = db.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
    ).get() as { value?: string } | undefined;
    if (promoted?.value !== String(SCHEMA_VERSION)) {
      fail("storage-invalid", "v6→v7 migration marker 未在事务内闭合。 ");
    }
  });
}

function migrateLegacySchema(db: DatabaseSync): void {
  runTransaction(db, () => {
    const currentVersion = db.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
    ).get() as { value?: string } | undefined;
    if (currentVersion?.value === String(SCHEMA_VERSION)
      || currentVersion?.value === String(V6_SCHEMA_VERSION)
      || currentVersion?.value === String(V5_SCHEMA_VERSION)
      || currentVersion?.value === String(V4_SCHEMA_VERSION)
      || currentVersion?.value === String(V3_SCHEMA_VERSION)
      || currentVersion?.value === String(V2_SCHEMA_VERSION)) {
      return;
    }
    if (currentVersion?.value !== String(LEGACY_SCHEMA_VERSION)) {
      fail("storage-invalid", `不支持的 generation ledger schema_version：${currentVersion?.value ?? "缺失"}。`);
    }
    if (!tableExists(db, "studio_generation_packs") || !tableExists(db, "studio_generation_results")) {
      fail("storage-invalid", "generation ledger v1 缺少 packs/results 表，禁止猜测迁移。");
    }
    const legacyRows = db.prepare("SELECT * FROM studio_generation_results ORDER BY sequence")
      .all() as unknown as LegacyResultRow[];
    const dispatchGroups = new Map<string, {
      generationRunId: string;
      packId: string;
      packFingerprint: string;
      dispatchedAt: string;
      firstSequence: number;
    }>();
    for (const row of legacyRows) {
      const existing = dispatchGroups.get(row.generation_run_id);
      if (existing && (existing.packId !== row.pack_id || existing.packFingerprint !== row.pack_fingerprint)) {
        fail(
          "storage-invalid",
          `generation ledger v1 的 run ${row.generation_run_id} 将 raw/labeled 绑到不同 pack，禁止静默迁移。`,
          [
            `existingPackId=${existing.packId}`,
            `conflictingPackId=${row.pack_id}`,
          ],
        );
      }
      if (!existing) {
        dispatchGroups.set(row.generation_run_id, {
          generationRunId: row.generation_run_id,
          packId: row.pack_id,
          packFingerprint: row.pack_fingerprint,
          dispatchedAt: row.created_at,
          firstSequence: Number(row.sequence),
        });
      } else if (row.created_at < existing.dispatchedAt) {
        existing.dispatchedAt = row.created_at;
      }
    }

    db.exec(`
      DROP TRIGGER IF EXISTS studio_generation_results_no_update;
      DROP TRIGGER IF EXISTS studio_generation_results_no_delete;
      DROP INDEX IF EXISTS studio_generation_result_panel_sequence_idx;
      DROP INDEX IF EXISTS studio_generation_result_pack_idx;
      ALTER TABLE studio_generation_results RENAME TO studio_generation_results_v1_migration;
    `);
    createCurrentSchema(db);
    const insertDispatch = db.prepare(`
      INSERT INTO studio_generation_dispatches(
        dispatch_id, generation_run_id, pack_id, pack_fingerprint, executor_provider, provenance, dispatched_at
      ) VALUES(?, ?, ?, ?, 'codex', 'legacy-registration', ?)
    `);
    const dispatchIdByRun = new Map<string, string>();
    for (const group of [...dispatchGroups.values()].sort((left, right) => left.firstSequence - right.firstSequence)) {
      const dispatchId = dispatchIdentity({
        generationRunId: group.generationRunId,
        packId: group.packId,
        packFingerprint: group.packFingerprint,
        provenance: "legacy-registration",
        provider: "codex",
      });
      insertDispatch.run(
        dispatchId,
        group.generationRunId,
        group.packId,
        group.packFingerprint,
        group.dispatchedAt,
      );
      dispatchIdByRun.set(group.generationRunId, dispatchId);
    }
    const insertResult = db.prepare(`
      INSERT INTO studio_generation_results(
        sequence, result_id, dispatch_id, generation_run_id, variant, status, media_sha256,
        input_current, promotion_eligible, stale_reasons_json,
        pack_id, pack_fingerprint, unit_id, unit_revision, panel_id, panel_index, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 1, 1, '[]', ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of legacyRows) {
      insertResult.run(
        row.sequence,
        row.result_id,
        dispatchIdByRun.get(row.generation_run_id)!,
        row.generation_run_id,
        row.variant,
        row.status,
        row.media_sha256,
        row.pack_id,
        row.pack_fingerprint,
        row.unit_id,
        row.unit_revision,
        row.panel_id,
        row.panel_index,
        row.created_at,
      );
    }
    db.exec("DROP TABLE studio_generation_results_v1_migration");
    // v1 迁移直接落到当前版本（含 executor_provider 与 v4 三表）。
    db.prepare("UPDATE studio_generation_ledger_meta SET value = ? WHERE key = 'schema_version'")
      .run(String(SCHEMA_VERSION));
  });
}

function normalizeSchemaSql(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

/** v4→v5 的迁移前断言：旧 owner 有任何缺损、漂移或 v5 残留都保持现场并失败关闭。 */
function assertV4Schema(db: DatabaseSync): void {
  const expectedObjectNames: Record<"table" | "index" | "trigger", string[]> = {
    table: [
      "studio_generation_ledger_meta",
      "studio_generation_packs",
      "studio_generation_dispatches",
      "studio_generation_results",
      "studio_generation_plans",
      "studio_generation_plan_nodes",
      "studio_generation_run_events",
    ],
    index: [
      "studio_generation_pack_panel_sequence_idx",
      "studio_generation_result_panel_sequence_idx",
      "studio_generation_result_pack_idx",
      "studio_generation_dispatch_pack_idx",
      "studio_generation_plan_nodes_pack_idx",
      "studio_generation_run_events_run_idx",
      "studio_generation_run_events_plan_node_idx",
    ],
    trigger: [
      "studio_generation_packs_no_update",
      "studio_generation_packs_no_delete",
      "studio_generation_dispatches_no_update",
      "studio_generation_dispatches_no_delete",
      "studio_generation_results_no_update",
      "studio_generation_results_no_delete",
      "studio_generation_plans_no_update",
      "studio_generation_plans_no_delete",
      "studio_generation_plan_nodes_no_update",
      "studio_generation_plan_nodes_no_delete",
      "studio_generation_run_events_no_update",
      "studio_generation_run_events_no_delete",
    ],
  };
  const v5OnlyObjectNames = new Set<string>([...V5_EXTENSION_OBJECT_NAMES, ...V6_EXTENSION_OBJECT_NAMES]);
  const schemaRows = db.prepare(`
    SELECT type, name FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all() as Array<{ type: string; name: string }>;
  const actualByType = new Map<string, string[]>();
  for (const row of schemaRows) actualByType.set(row.type, [...(actualByType.get(row.type) ?? []), row.name]);
  const residual = schemaRows.find((row) => v5OnlyObjectNames.has(row.name));
  if (residual) {
    fail("storage-invalid", `generation ledger v4 含 v5-only ${residual.type} 残留：${residual.name}`);
  }
  for (const type of ["table", "index", "trigger"] as const) {
    const actual = [...(actualByType.get(type) ?? [])].sort((left, right) => left.localeCompare(right, "en"));
    const expected = [...expectedObjectNames[type]].sort((left, right) => left.localeCompare(right, "en"));
    const missing = expected.filter((name) => !actual.includes(name));
    if (missing.length > 0) {
      fail("storage-invalid", `generation ledger v4 缺少 ${type} 对象：${missing.join(",")}`, [
        `expected=${expected.join(",")}`,
        `actual=${actual.join(",")}`,
      ]);
    }
  }

  const requiredColumns: Record<string, string[]> = {
    studio_generation_ledger_meta: ["key", "value"],
    studio_generation_packs: [
      "sequence", "pack_id", "fingerprint", "content_sha256", "content_relpath", "content_size_bytes",
      "project_id", "unit_id", "unit_revision", "panel_id", "panel_index", "created_at",
    ],
    studio_generation_dispatches: [
      "sequence", "dispatch_id", "generation_run_id", "pack_id", "pack_fingerprint", "executor_provider",
      "provenance", "dispatched_at",
    ],
    studio_generation_results: [
      "sequence", "result_id", "dispatch_id", "generation_run_id", "variant", "status", "media_sha256",
      "input_current", "promotion_eligible", "stale_reasons_json", "pack_id", "pack_fingerprint", "unit_id",
      "unit_revision", "panel_id", "panel_index", "created_at",
    ],
    studio_generation_plans: [
      "sequence", "plan_id", "project_id", "source_command_request_id", "node_count", "created_at",
    ],
    studio_generation_plan_nodes: [
      "sequence", "plan_id", "node_index", "unit_id", "panel_id", "pack_id", "pack_fingerprint", "created_at",
    ],
    studio_generation_run_events: [
      "sequence", "event_id", "generation_run_id", "plan_id", "node_index", "kind", "attempt",
      "supersedes_run_id", "detail_json", "created_at",
    ],
  };
  const tableSnippets: Record<string, string[]> = {
    studio_generation_ledger_meta: ["key text primary key", "value text not null", ") strict"],
    studio_generation_packs: [
      "sequence integer primary key autoincrement", "pack_id text not null unique",
      "fingerprint text not null unique check(length(fingerprint) = 64)",
      "content_sha256 text not null unique check(length(content_sha256) = 64)",
      "content_relpath text not null unique", "check(content_size_bytes > 0 and content_size_bytes <=",
      "check(unit_revision >= 1)", "check(panel_index between 1 and 6)",
      "unique(pack_id, fingerprint)", ") strict",
    ],
    studio_generation_dispatches: [
      "dispatch_id text not null unique", "generation_run_id text not null unique",
      "check(length(pack_fingerprint) = 64)", "check(executor_provider in ('codex', 'grok'))",
      "check(provenance in ('local-dispatch-intent', 'legacy-registration'))",
      "unique(dispatch_id, generation_run_id, pack_id, pack_fingerprint)",
      "foreign key(pack_id, pack_fingerprint) references studio_generation_packs(pack_id, fingerprint) on delete restrict",
      ") strict",
    ],
    studio_generation_results: [
      "result_id text not null unique", "check(variant in ('raw', 'labeled'))",
      "check(status in ('pending', 'approved', 'rejected'))", "check(length(media_sha256) = 64)",
      "check(input_current in (0, 1))", "check(promotion_eligible in (0, 1))",
      "check(length(pack_fingerprint) = 64)", "check(unit_revision >= 1)",
      "check(panel_index between 1 and 6)", "unique(generation_run_id, variant)",
      "foreign key(pack_id, pack_fingerprint) references studio_generation_packs(pack_id, fingerprint) on delete restrict",
      "foreign key(dispatch_id, generation_run_id, pack_id, pack_fingerprint) references studio_generation_dispatches(dispatch_id, generation_run_id, pack_id, pack_fingerprint) on delete restrict",
      ") strict",
    ],
    studio_generation_plans: [
      "plan_id text not null unique", "check(node_count between 1 and 36)", ") strict",
    ],
    studio_generation_plan_nodes: [
      "plan_id text not null references studio_generation_plans(plan_id) on delete restrict",
      "check(length(pack_fingerprint) = 64)", "unique(plan_id, node_index)",
      "unique(plan_id, unit_id, panel_id)",
      "foreign key(pack_id, pack_fingerprint) references studio_generation_packs(pack_id, fingerprint) on delete restrict",
      ") strict",
    ],
    studio_generation_run_events: [
      "event_id text not null unique", "plan_id text references studio_generation_plans(plan_id) on delete restrict",
      "check(kind in ('dispatched', 'failed', 'cancel-requested', 'cancelled', 'retry-superseded'))",
      "check(attempt >= 1)", ") strict",
    ],
  };
  for (const [table, expectedColumns] of Object.entries(requiredColumns)) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
    const sqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) as { sql?: string } | undefined;
    const sql = normalizeSchemaSql(sqlRow?.sql ?? "");
    if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)
      || (tableSnippets[table] ?? []).some((snippet) => !sql.includes(snippet))) {
      fail("storage-invalid", `generation ledger ${table} 不符合完整 v4 结构/约束合同。`);
    }
  }

  const foreignKeyContracts: Record<string, string[]> = {
    studio_generation_ledger_meta: [],
    studio_generation_packs: [],
    studio_generation_dispatches: [
      "studio_generation_packs|pack_id>pack_id,pack_fingerprint>fingerprint|NO ACTION|RESTRICT",
    ],
    studio_generation_results: [
      "studio_generation_dispatches|dispatch_id>dispatch_id,generation_run_id>generation_run_id,pack_id>pack_id,pack_fingerprint>pack_fingerprint|NO ACTION|RESTRICT",
      "studio_generation_packs|pack_id>pack_id,pack_fingerprint>fingerprint|NO ACTION|RESTRICT",
    ],
    studio_generation_plans: [],
    studio_generation_plan_nodes: [
      "studio_generation_packs|pack_id>pack_id,pack_fingerprint>fingerprint|NO ACTION|RESTRICT",
      "studio_generation_plans|plan_id>plan_id|NO ACTION|RESTRICT",
    ],
    studio_generation_run_events: [
      "studio_generation_plans|plan_id>plan_id|NO ACTION|RESTRICT",
    ],
  };
  for (const [table, expected] of Object.entries(foreignKeyContracts)) {
    const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      id: number; seq: number; table: string; from: string; to: string; on_update: string; on_delete: string;
    }>;
    const groups = new Map<number, typeof rows>();
    for (const row of rows) groups.set(row.id, [...(groups.get(row.id) ?? []), row]);
    const actual = [...groups.values()].map((group) => {
      const ordered = [...group].sort((left, right) => left.seq - right.seq);
      const head = ordered[0]!;
      return `${head.table}|${ordered.map((row) => `${row.from}>${row.to}`).join(",")}|${head.on_update}|${head.on_delete}`;
    }).sort((left, right) => left.localeCompare(right, "en"));
    const wanted = [...expected].sort((left, right) => left.localeCompare(right, "en"));
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      fail("storage-invalid", `generation ledger ${table} v4 foreign key 合同无效。`);
    }
  }

  const indexContracts: Record<string, { table: string; columns: string[] }> = {
    studio_generation_pack_panel_sequence_idx: { table: "studio_generation_packs", columns: ["unit_id", "panel_id", "sequence"] },
    studio_generation_result_panel_sequence_idx: { table: "studio_generation_results", columns: ["unit_id", "panel_id", "sequence"] },
    studio_generation_result_pack_idx: { table: "studio_generation_results", columns: ["pack_id", "sequence"] },
    studio_generation_dispatch_pack_idx: { table: "studio_generation_dispatches", columns: ["pack_id", "sequence"] },
    studio_generation_plan_nodes_pack_idx: { table: "studio_generation_plan_nodes", columns: ["pack_id", "pack_fingerprint", "sequence"] },
    studio_generation_run_events_run_idx: { table: "studio_generation_run_events", columns: ["generation_run_id", "sequence"] },
    studio_generation_run_events_plan_node_idx: { table: "studio_generation_run_events", columns: ["plan_id", "node_index", "sequence"] },
  };
  for (const [index, contract] of Object.entries(indexContracts)) {
    const row = (db.prepare(`PRAGMA index_list(${contract.table})`).all() as Array<{
      name: string; unique: number; partial: number;
    }>).find((candidate) => candidate.name === index);
    const columns = (db.prepare(`PRAGMA index_info(${index})`).all() as Array<{ seqno: number; name: string }>)
      .sort((left, right) => left.seqno - right.seqno).map((candidate) => candidate.name);
    if (!row || Number(row.unique) !== 0 || Number(row.partial) !== 0
      || JSON.stringify(columns) !== JSON.stringify(contract.columns)) {
      fail("storage-invalid", `generation ledger v4 index ${index} 定义无效。`);
    }
  }

  const appendOnlyTables = [
    "studio_generation_packs", "studio_generation_dispatches", "studio_generation_results",
    "studio_generation_plans", "studio_generation_plan_nodes", "studio_generation_run_events",
  ];
  for (const table of appendOnlyTables) {
    for (const suffix of ["no_update", "no_delete"] as const) {
      const triggerName = `${table}_${suffix}`;
      const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=? AND tbl_name=?")
        .get(triggerName, table) as { sql?: string } | undefined;
      const event = suffix === "no_update" ? "before update" : "before delete";
      const triggerSql = normalizeSchemaSql(trigger?.sql ?? "");
      const exactTrigger = new RegExp(
        `^create trigger(?: if not exists)? ${triggerName} ${event} on ${table} begin select raise\\(abort, '[^']+'\\); end$`,
        "u",
      );
      if (!exactTrigger.test(triggerSql)) {
        fail("storage-invalid", `generation ledger ${table} 缺少 v4 append-only ${suffix} trigger。`);
      }
    }
  }

  const markerRows = db.prepare("SELECT key, value FROM studio_generation_ledger_meta WHERE key='schema_version'")
    .all() as Array<{ key: string; value: string }>;
  if (markerRows.length !== 1 || markerRows[0]?.value !== String(V4_SCHEMA_VERSION)) {
    fail("storage-invalid", "generation ledger v4 schema marker 无效。 ");
  }
  const invalidPlanNode = db.prepare(`
    SELECT node.plan_id FROM studio_generation_plan_nodes node
    JOIN studio_generation_packs pack ON pack.pack_id = node.pack_id AND pack.fingerprint = node.pack_fingerprint
    WHERE node.unit_id <> pack.unit_id OR node.panel_id <> pack.panel_id
    LIMIT 1
  `).get() as { plan_id?: string } | undefined;
  if (invalidPlanNode) fail("storage-invalid", `generation ledger v4 plan node 与 pack 身份不一致：${invalidPlanNode.plan_id}`);
  const invalidPlanCount = db.prepare(`
    SELECT plan.plan_id FROM studio_generation_plans plan
    LEFT JOIN studio_generation_plan_nodes node ON node.plan_id = plan.plan_id
    GROUP BY plan.plan_id, plan.node_count
    HAVING COUNT(node.sequence) <> plan.node_count
    LIMIT 1
  `).get() as { plan_id?: string } | undefined;
  if (invalidPlanCount) fail("storage-invalid", `generation ledger v4 plan node_count 不闭合：${invalidPlanCount.plan_id}`);
  const invalidRunEvent = db.prepare(`
    SELECT event.event_id FROM studio_generation_run_events event
    LEFT JOIN studio_generation_plan_nodes node
      ON node.plan_id = event.plan_id AND node.node_index = event.node_index
    WHERE (event.plan_id IS NULL) <> (event.node_index IS NULL)
       OR (event.plan_id IS NOT NULL AND node.plan_id IS NULL)
    LIMIT 1
  `).get() as { event_id?: string } | undefined;
  if (invalidRunEvent) fail("storage-invalid", `generation ledger v4 run event 的 plan/node 身份不闭合：${invalidRunEvent.event_id}`);
  if (db.prepare("PRAGMA foreign_key_check").all().length > 0) {
    fail("storage-invalid", "generation ledger v4 存在外键孤儿。 ");
  }
}

/** P30 新表不得由“同名同列但无约束”的弱结构冒充。 */
function assertP30V5SchemaObjects(db: DatabaseSync): void {
  const tableSnippets: Record<string, string[]> = {
    studio_generation_pack_targets: [
      ") strict", "check(target_kind = 'unit-grid')", "check(compatibility_panel_index = 1)",
      "check(panel_count between 2 and 6)", "primary key(pack_id, pack_fingerprint)",
    ],
    studio_generation_dispatch_protocols: [
      ") strict", "check(protocol_version = 2)", "check(requires_call_intent = 1)",
      "generation_run_id text not null unique", "unique(dispatch_id, generation_run_id)",
    ],
    studio_generation_call_intents: [
      ") strict", "generation_run_id text not null unique", "dispatch_id text not null unique",
      "check(executor_provider in ('codex', 'grok'))", "check(target_kind in ('panel', 'unit-grid'))",
      "check(length(context_token_hash) = 64)", "unique(call_id, generation_run_id)",
    ],
    studio_generation_call_events: [
      ") strict", "check(kind in ('result-committed', 'not-invoked', 'unknown-observation'))",
      "check(length(evidence_fingerprint) = 64)",
    ],
    studio_generation_historical_imports: [
      ") strict", "check(target_kind = 'unit-grid')", "unique(pack_id, pack_fingerprint)",
      "check(length(source_manifest_fingerprint) = 64)",
    ],
    studio_generation_detached_unknown_observations: [
      ") strict", "check(target_kind = 'unit-grid')", "check(status = 'generation_unknown')",
      "unique(target_kind, target_key, source_task_id)",
      "check((candidate_sha256 is null) = (candidate_size_bytes is null))",
    ],
    studio_generation_plan_node_targets: [
      ") strict", "check(target_kind = 'unit-grid')", "primary key(plan_id, node_index)",
      "check(length(target_fingerprint) = 64)",
    ],
  };
  for (const [table, snippets] of Object.entries(tableSnippets)) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) as { sql?: string } | undefined;
    const sql = normalizeSchemaSql(row?.sql ?? "");
    if (!sql || snippets.some((snippet) => !sql.includes(snippet))) {
      fail("storage-invalid", `generation ledger ${table} 缺少 v5 STRICT/CHECK/UNIQUE 合同。`);
    }
    for (const suffix of ["no_update", "no_delete"] as const) {
      const triggerName = table === "studio_generation_detached_unknown_observations"
        ? `studio_generation_detached_unknown_${suffix}`
        : `${table}_${suffix}`;
      const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=? AND tbl_name=?")
        .get(triggerName, table) as { sql?: string } | undefined;
      const triggerSql = normalizeSchemaSql(trigger?.sql ?? "");
      const event = suffix === "no_update" ? "before update" : "before delete";
      const exactTrigger = new RegExp(
        `^create trigger(?: if not exists)? ${triggerName} ${event} on ${table} begin select raise\\(abort, '[^']+'\\); end$`,
        "u",
      );
      if (!exactTrigger.test(triggerSql)) {
        fail("storage-invalid", `generation ledger ${table} 缺少 append-only ${suffix} trigger。`);
      }
    }
  }

  const foreignKeyContracts: Record<string, string[]> = {
    studio_generation_pack_targets: [
      "studio_generation_packs|pack_id>pack_id,pack_fingerprint>fingerprint|NO ACTION|RESTRICT",
    ],
    studio_generation_dispatch_protocols: [
      "studio_generation_dispatches|dispatch_id>dispatch_id,generation_run_id>generation_run_id|NO ACTION|RESTRICT",
    ],
    studio_generation_call_intents: [
      "studio_generation_dispatches|dispatch_id>dispatch_id,generation_run_id>generation_run_id,pack_id>pack_id,pack_fingerprint>pack_fingerprint|NO ACTION|RESTRICT",
    ],
    studio_generation_call_events: [
      "studio_generation_call_intents|call_id>call_id,generation_run_id>generation_run_id|NO ACTION|RESTRICT",
    ],
    studio_generation_historical_imports: [
      "studio_generation_packs|pack_id>pack_id,pack_fingerprint>fingerprint|NO ACTION|RESTRICT",
    ],
    studio_generation_detached_unknown_observations: [],
    studio_generation_plan_node_targets: [
      "studio_generation_plan_nodes|plan_id>plan_id,node_index>node_index|NO ACTION|RESTRICT",
    ],
  };
  for (const [table, expected] of Object.entries(foreignKeyContracts)) {
    const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      id: number; seq: number; table: string; from: string; to: string; on_update: string; on_delete: string;
    }>;
    const groups = new Map<number, typeof rows>();
    for (const row of rows) groups.set(row.id, [...(groups.get(row.id) ?? []), row]);
    const actual = [...groups.values()].map((group) => {
      const ordered = [...group].sort((left, right) => left.seq - right.seq);
      const head = ordered[0]!;
      return `${head.table}|${ordered.map((row) => `${row.from}>${row.to}`).join(",")}|${head.on_update}|${head.on_delete}`;
    }).sort((left, right) => left.localeCompare(right, "en"));
    const wanted = [...expected].sort((left, right) => left.localeCompare(right, "en"));
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      fail("storage-invalid", `generation ledger ${table} foreign key 合同无效。`);
    }
  }
  const indexContracts: Record<string, { table: string; columns: string[]; unique?: true }> = {
    studio_generation_dispatch_call_identity_idx: {
      table: "studio_generation_dispatches", columns: ["dispatch_id", "generation_run_id"], unique: true,
    },
    studio_generation_pack_targets_key_idx: {
      table: "studio_generation_pack_targets", columns: ["target_kind", "target_key", "created_at", "pack_id"],
    },
    studio_generation_call_events_call_idx: {
      table: "studio_generation_call_events", columns: ["call_id", "sequence"],
    },
    studio_generation_historical_import_target_idx: {
      table: "studio_generation_historical_imports", columns: ["target_kind", "target_key", "sequence"],
    },
    studio_generation_detached_unknown_target_idx: {
      table: "studio_generation_detached_unknown_observations", columns: ["target_kind", "target_key", "sequence"],
    },
    studio_generation_plan_node_targets_key_idx: {
      table: "studio_generation_plan_node_targets", columns: ["target_kind", "target_key", "plan_id", "node_index"],
    },
  };
  for (const [index, contract] of Object.entries(indexContracts)) {
    const indexRow = (db.prepare(`PRAGMA index_list(${contract.table})`).all() as Array<{
      name: string; unique: number; partial: number;
    }>).find((row) => row.name === index);
    const columns = (db.prepare(`PRAGMA index_info(${index})`).all() as Array<{ seqno: number; name: string }>)
      .sort((left, right) => left.seqno - right.seqno)
      .map((row) => row.name);
    if (!indexRow || Number(indexRow.unique) !== (contract.unique ? 1 : 0) || Number(indexRow.partial) !== 0
      || JSON.stringify(columns) !== JSON.stringify(contract.columns)) {
      fail("storage-invalid", `generation ledger v5 index ${index} 定义无效。`);
    }
  }
}

function assertV6SchemaObjects(db: DatabaseSync): void {
  const table = "studio_generation_detached_unknown_dispositions";
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql?: string } | undefined;
  const sql = normalizeSchemaSql(row?.sql ?? "");
  const required = [
    ") strict",
    "observation_id text not null unique",
    "check(target_kind = 'unit-grid')",
    "check(status = 'owner-abandoned')",
    "check(remote_invocation = 'unknown-may-exist')",
    "check(detached_candidate_policy = 'never-import-or-reuse')",
    "check(next_run_policy = 'fresh-formal-run-only')",
    "foreign key(observation_id) references studio_generation_detached_unknown_observations(observation_id) on delete restrict",
  ];
  if (!sql || required.some((snippet) => !sql.includes(snippet))) {
    fail("storage-invalid", "generation ledger detached disposition 缺少 v6 STRICT/CHECK/FK 合同。");
  }
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    table: string; from: string; to: string; on_update: string; on_delete: string;
  }>;
  if (foreignKeys.length !== 1
    || foreignKeys[0]?.table !== "studio_generation_detached_unknown_observations"
    || foreignKeys[0]?.from !== "observation_id"
    || foreignKeys[0]?.to !== "observation_id"
    || foreignKeys[0]?.on_update !== "NO ACTION"
    || foreignKeys[0]?.on_delete !== "RESTRICT") {
    fail("storage-invalid", "generation ledger detached disposition FK 合同无效。");
  }
  const index = (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
    name: string; unique: number; partial: number;
  }>).find((candidate) => candidate.name === "studio_generation_detached_disposition_target_idx");
  const columns = (db.prepare("PRAGMA index_info(studio_generation_detached_disposition_target_idx)")
    .all() as Array<{ seqno: number; name: string }>)
    .sort((left, right) => left.seqno - right.seqno)
    .map((candidate) => candidate.name);
  if (!index || index.unique !== 0 || index.partial !== 0
    || JSON.stringify(columns) !== JSON.stringify(["target_kind", "target_key", "sequence"])) {
    fail("storage-invalid", "generation ledger detached disposition target index 无效。");
  }
  for (const suffix of ["no_update", "no_delete"] as const) {
    const triggerName = `studio_generation_detached_disposition_${suffix}`;
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=? AND tbl_name=?")
      .get(triggerName, table) as { sql?: string } | undefined;
    const event = suffix === "no_update" ? "before update" : "before delete";
    const exact = new RegExp(
      `^create trigger(?: if not exists)? ${triggerName} ${event} on ${table} begin select raise\\(abort, '[^']+'\\); end$`,
      "u",
    );
    if (!exact.test(normalizeSchemaSql(trigger?.sql ?? ""))) {
      fail("storage-invalid", `generation ledger detached disposition 缺少 append-only ${suffix} trigger。`);
    }
  }
}

function assertGenerationSchema(
  db: DatabaseSync,
  includeV6: boolean,
  includeCallerAgentId: boolean,
): void {
  const requiredColumns: Record<string, string[]> = {
    studio_generation_dispatches: [
      "sequence", "dispatch_id", "generation_run_id", "pack_id", "pack_fingerprint", "executor_provider", "provenance", "dispatched_at",
    ],
    studio_generation_results: [
      "sequence", "result_id", "dispatch_id", "generation_run_id", "variant", "status", "media_sha256",
      "input_current", "promotion_eligible", "stale_reasons_json", "pack_id", "pack_fingerprint", "unit_id",
      "unit_revision", "panel_id", "panel_index", "created_at",
    ],
    studio_generation_pack_targets: [
      "pack_id", "pack_fingerprint", "target_kind", "target_key", "target_fingerprint",
      "unit_id", "unit_revision", "compatibility_panel_id", "compatibility_panel_index", "panel_count", "created_at",
    ],
    studio_generation_dispatch_protocols: [
      "dispatch_id", "generation_run_id", "protocol_version", "requires_call_intent", "created_at",
    ],
    studio_generation_call_intents: [
      "call_id", "generation_run_id", "dispatch_id", "pack_id", "pack_fingerprint", "executor_provider",
      "target_kind", "target_key", "input_fingerprint", "context_token_hash", "command_request_id", "created_at",
      ...(includeCallerAgentId ? ["caller_agent_id"] : []),
    ],
    studio_generation_call_events: [
      "sequence", "event_id", "call_id", "generation_run_id", "kind", "evidence_reference",
      "evidence_fingerprint", "note", "created_at",
    ],
    studio_generation_historical_imports: [
      "sequence", "import_id", "pack_id", "pack_fingerprint", "target_kind", "target_key", "unit_id",
      "unit_revision", "raw_media_sha256", "labeled_media_sha256", "source_raw_sha256",
      "source_labeled_sha256", "source_manifest_fingerprint", "qc_evidence_reference", "qc_evidence_sha256",
      "external_storyboard_status", "fingerprint", "created_at",
    ],
    studio_generation_detached_unknown_observations: [
      "sequence", "observation_id", "target_kind", "target_key", "unit_id", "unit_revision",
      "unit_fingerprint", "source_task_id", "status", "evidence_reference", "evidence_fingerprint",
      "candidate_sha256", "candidate_size_bytes", "candidate_width", "candidate_height", "note",
      "fingerprint", "created_at",
    ],
    studio_generation_plan_node_targets: [
      "plan_id", "node_index", "target_kind", "target_key", "target_fingerprint",
      "unit_id", "unit_revision", "created_at",
    ],
  };
  if (includeV6) {
    requiredColumns.studio_generation_detached_unknown_dispositions = [
      "sequence", "disposition_id", "observation_id", "observation_fingerprint", "target_kind",
      "target_key", "unit_id", "unit_revision", "unit_fingerprint", "source_task_id", "status",
      "remote_invocation", "detached_candidate_policy", "next_run_policy",
      "authorization_evidence_reference", "authorization_text_sha256", "reason", "project_id",
      "manifest_fingerprint", "context_token_hash", "build_id", "source_digest", "fingerprint", "created_at",
    ];
  }
  for (const [table, expected] of Object.entries(requiredColumns)) {
    const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
    if (actual.length !== expected.length || expected.some((column, index) => actual[index] !== column)) {
      const expectedVersion = includeCallerAgentId
        ? SCHEMA_VERSION
        : includeV6
          ? V6_SCHEMA_VERSION
          : V5_SCHEMA_VERSION;
      fail("storage-invalid", `generation ledger ${table} schema 与 v${expectedVersion} 不一致。`);
    }
  }
  for (const table of ["studio_generation_plans", "studio_generation_plan_nodes", "studio_generation_run_events"]) {
    if (!tableExists(db, table)) fail("storage-invalid", `generation ledger 缺少 v4 表 ${table}。`);
  }
  const expectedSchema = new DatabaseSync(":memory:");
  try {
    createCurrentSchema(expectedSchema);
    if (!includeV6) {
      expectedSchema.exec(`
        DROP TRIGGER studio_generation_detached_disposition_no_update;
        DROP TRIGGER studio_generation_detached_disposition_no_delete;
        DROP INDEX studio_generation_detached_disposition_target_idx;
        DROP TABLE studio_generation_detached_unknown_dispositions;
      `);
    }
    const expectedTables = (expectedSchema.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
    `).all() as Array<{ name: string }>).map((row) => row.name);
    const placeholders = expectedTables.map(() => "?").join(",");
    const objectSql = `
      SELECT type, name, tbl_name AS tableName
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
        AND ((type='table' AND name IN (${placeholders}))
          OR (type IN ('index','trigger') AND tbl_name IN (${placeholders})))
      ORDER BY type, name, tbl_name
    `;
    const expectedObjects = expectedSchema.prepare(objectSql).all(...expectedTables, ...expectedTables);
    const actualObjects = db.prepare(objectSql).all(...expectedTables, ...expectedTables);
    const unexpectedView = db.prepare("SELECT name FROM sqlite_master WHERE type='view' LIMIT 1")
      .get() as { name?: string } | undefined;
    if (unexpectedView || JSON.stringify(actualObjects) !== JSON.stringify(expectedObjects)) {
      fail(
        "storage-invalid",
        unexpectedView
          ? `generation ledger 不允许未声明 view：${unexpectedView.name}`
          : "generation ledger core-owned schema 对象集合不一致。",
      );
    }
  } finally {
    expectedSchema.close();
  }
  assertP30V5SchemaObjects(db);
  if (includeV6) assertV6SchemaObjects(db);
  const invalidTarget = db.prepare(`
    SELECT t.pack_id FROM studio_generation_pack_targets t
    JOIN studio_generation_packs p ON p.pack_id = t.pack_id AND p.fingerprint = t.pack_fingerprint
    WHERE t.target_kind <> 'unit-grid'
       OR t.target_key <> 'unit-grid:' || t.unit_id
       OR t.unit_id <> p.unit_id
       OR t.unit_revision <> p.unit_revision
       OR t.compatibility_panel_id <> p.panel_id
       OR t.compatibility_panel_index <> p.panel_index
    LIMIT 1
  `).get() as { pack_id?: string } | undefined;
  if (invalidTarget) fail("storage-invalid", `generation ledger target extension 与兼容索引不一致：${invalidTarget.pack_id}`);
  const invalidIntent = db.prepare(`
    SELECT i.call_id FROM studio_generation_call_intents i
    LEFT JOIN studio_generation_dispatches d
      ON d.dispatch_id = i.dispatch_id AND d.generation_run_id = i.generation_run_id
    LEFT JOIN studio_generation_dispatch_protocols protocol
      ON protocol.dispatch_id = d.dispatch_id AND protocol.generation_run_id = d.generation_run_id
    LEFT JOIN studio_generation_packs p
      ON p.pack_id = i.pack_id AND p.fingerprint = i.pack_fingerprint
    LEFT JOIN studio_generation_pack_targets target
      ON target.pack_id = i.pack_id AND target.pack_fingerprint = i.pack_fingerprint
    WHERE d.dispatch_id IS NULL OR p.pack_id IS NULL OR protocol.dispatch_id IS NULL
       OR protocol.protocol_version <> 2 OR protocol.requires_call_intent <> 1
       OR i.pack_id <> d.pack_id OR i.pack_fingerprint <> d.pack_fingerprint
       OR i.executor_provider <> d.executor_provider
       OR (target.pack_id IS NOT NULL AND (i.target_kind <> target.target_kind OR i.target_key <> target.target_key))
       OR (target.pack_id IS NULL AND (
            i.target_kind <> 'panel'
            OR i.target_key <> 'panel:' || p.unit_id || ':' || p.panel_id
          ))
    LIMIT 1
  `).get() as { call_id?: string } | undefined;
  if (invalidIntent) fail("storage-invalid", `generation call intent 与 dispatch 不一致：${invalidIntent.call_id}`);
  const invalidProtocol = db.prepare(`
    SELECT d.dispatch_id FROM studio_generation_dispatches d
    LEFT JOIN studio_generation_pack_targets target
      ON target.pack_id = d.pack_id AND target.pack_fingerprint = d.pack_fingerprint
    LEFT JOIN studio_generation_dispatch_protocols protocol
      ON protocol.dispatch_id = d.dispatch_id AND protocol.generation_run_id = d.generation_run_id
    WHERE (target.pack_id IS NOT NULL AND protocol.dispatch_id IS NULL)
       OR (protocol.dispatch_id IS NOT NULL
          AND (protocol.protocol_version <> 2 OR protocol.requires_call_intent <> 1))
    LIMIT 1
  `).get() as { dispatch_id?: string } | undefined;
  if (invalidProtocol) fail("storage-invalid", `generation dispatch protocol 与 target 类型不一致：${invalidProtocol.dispatch_id}`);
  const conflictingCallTerminal = db.prepare(`
    SELECT call_id FROM studio_generation_call_events
    WHERE kind IN ('result-committed', 'not-invoked')
    GROUP BY call_id
    HAVING COUNT(*) > 1
    LIMIT 1
  `).get() as { call_id?: string } | undefined;
  if (conflictingCallTerminal) {
    fail("storage-invalid", `generation call 存在多个互斥终态事件：${conflictingCallTerminal.call_id}`);
  }
  const invalidCallEventRun = db.prepare(`
    SELECT event.event_id FROM studio_generation_call_events event
    LEFT JOIN studio_generation_call_intents intent ON intent.call_id = event.call_id
    WHERE intent.call_id IS NULL OR event.generation_run_id <> intent.generation_run_id
    LIMIT 1
  `).get() as { event_id?: string } | undefined;
  if (invalidCallEventRun) {
    fail("storage-invalid", `generation call event 与 intent run 不一致：${invalidCallEventRun.event_id}`);
  }
  const invalidCallResultClosure = db.prepare(`
    SELECT i.call_id FROM studio_generation_call_intents i
    LEFT JOIN (
      SELECT generation_run_id, COUNT(*) AS result_count
      FROM studio_generation_results GROUP BY generation_run_id
    ) result_count ON result_count.generation_run_id = i.generation_run_id
    LEFT JOIN (
      SELECT call_id,
        SUM(CASE WHEN kind = 'result-committed' THEN 1 ELSE 0 END) AS committed_count,
        SUM(CASE WHEN kind = 'not-invoked' THEN 1 ELSE 0 END) AS not_invoked_count
      FROM studio_generation_call_events GROUP BY call_id
    ) event_count ON event_count.call_id = i.call_id
    WHERE (COALESCE(result_count.result_count, 0) > 0 AND (
            COALESCE(result_count.result_count, 0) <> 2 OR COALESCE(event_count.committed_count, 0) <> 1
          ))
       OR (COALESCE(event_count.committed_count, 0) > 0 AND COALESCE(result_count.result_count, 0) <> 2)
       OR (COALESCE(event_count.not_invoked_count, 0) > 0 AND COALESCE(result_count.result_count, 0) > 0)
    LIMIT 1
  `).get() as { call_id?: string } | undefined;
  if (invalidCallResultClosure) {
    fail("storage-invalid", `generation call/result 原子闭包无效：${invalidCallResultClosure.call_id}`);
  }
  const invalidHistoricalImport = db.prepare(`
    SELECT history.import_id FROM studio_generation_historical_imports history
    LEFT JOIN studio_generation_pack_targets target
      ON target.pack_id = history.pack_id AND target.pack_fingerprint = history.pack_fingerprint
    WHERE target.pack_id IS NULL
       OR history.target_kind <> target.target_kind
       OR history.target_key <> target.target_key
       OR history.unit_id <> target.unit_id
       OR history.unit_revision <> target.unit_revision
    LIMIT 1
  `).get() as { import_id?: string } | undefined;
  if (invalidHistoricalImport) {
    fail("storage-invalid", `historical import 与 unit-grid target 不一致：${invalidHistoricalImport.import_id}`);
  }
  const historicalImportWithDispatch = db.prepare(`
    SELECT history.import_id FROM studio_generation_historical_imports history
    JOIN studio_generation_dispatches dispatch
      ON dispatch.pack_id = history.pack_id AND dispatch.pack_fingerprint = history.pack_fingerprint
    LIMIT 1
  `).get() as { import_id?: string } | undefined;
  if (historicalImportWithDispatch) {
    fail("storage-invalid", `historical import 不得与真实 dispatch 共存：${historicalImportWithDispatch.import_id}`);
  }
  const invalidDetachedUnknown = db.prepare(`
    SELECT observation_id FROM studio_generation_detached_unknown_observations
    WHERE target_kind <> 'unit-grid'
       OR target_key <> 'unit-grid:' || unit_id
       OR status <> 'generation_unknown'
    LIMIT 1
  `).get() as { observation_id?: string } | undefined;
  if (invalidDetachedUnknown) {
    fail("storage-invalid", `detached generation unknown observation 目标无效：${invalidDetachedUnknown.observation_id}`);
  }
  const reusedDetachedCandidate = db.prepare(`
    SELECT observation.observation_id AS observationId, result.generation_run_id AS generationRunId
    FROM studio_generation_detached_unknown_observations observation
    JOIN studio_generation_results result ON result.media_sha256 = observation.candidate_sha256
    WHERE observation.candidate_sha256 IS NOT NULL
    LIMIT 1
  `).get() as { observationId?: string; generationRunId?: string } | undefined;
  if (reusedDetachedCandidate?.observationId) {
    fail(
      "storage-invalid",
      `detached candidate 已被登记为 generation result：${reusedDetachedCandidate.observationId}`,
      [`generationRunId=${reusedDetachedCandidate.generationRunId ?? "unknown"}`],
    );
  }
  const historicallyReusedDetachedCandidate = db.prepare(`
    SELECT observation.observation_id AS observationId, history.import_id AS importId
    FROM studio_generation_detached_unknown_observations observation
    JOIN studio_generation_historical_imports history
      ON history.raw_media_sha256 = observation.candidate_sha256
      OR history.labeled_media_sha256 = observation.candidate_sha256
    WHERE observation.candidate_sha256 IS NOT NULL
    LIMIT 1
  `).get() as { observationId?: string; importId?: string } | undefined;
  if (historicallyReusedDetachedCandidate?.observationId) {
    fail(
      "storage-invalid",
      `detached candidate 已被登记为 historical import：${historicallyReusedDetachedCandidate.observationId}`,
      [`importId=${historicallyReusedDetachedCandidate.importId ?? "unknown"}`],
    );
  }
  if (includeV6) {
    const invalidDisposition = db.prepare(`
      SELECT disposition.disposition_id AS dispositionId
      FROM studio_generation_detached_unknown_dispositions disposition
      LEFT JOIN studio_generation_detached_unknown_observations observation
        ON observation.observation_id = disposition.observation_id
      WHERE observation.observation_id IS NULL
         OR disposition.observation_fingerprint <> observation.fingerprint
         OR disposition.target_kind <> observation.target_kind
         OR disposition.target_key <> observation.target_key
         OR disposition.unit_id <> observation.unit_id
         OR disposition.unit_revision <> observation.unit_revision
         OR disposition.unit_fingerprint <> observation.unit_fingerprint
         OR disposition.source_task_id <> observation.source_task_id
         OR disposition.status <> 'owner-abandoned'
         OR disposition.remote_invocation <> 'unknown-may-exist'
         OR disposition.detached_candidate_policy <> 'never-import-or-reuse'
         OR disposition.next_run_policy <> 'fresh-formal-run-only'
      LIMIT 1
    `).get() as { dispositionId?: string } | undefined;
    if (invalidDisposition?.dispositionId) {
      fail("storage-invalid", `detached disposition 与 observation 不一致：${invalidDisposition.dispositionId}`);
    }
    const dispositionRows = db.prepare(`
      SELECT * FROM studio_generation_detached_unknown_dispositions ORDER BY sequence LIMIT 101
    `).all() as unknown as DetachedUnknownDispositionRow[];
    if (dispositionRows.length > 100) {
      fail("storage-invalid", "detached dispositions 超过有界验证上限 100，必须先增加分页合同。");
    }
    for (const disposition of dispositionRows) {
      const observationRow = db.prepare(`
        SELECT * FROM studio_generation_detached_unknown_observations WHERE observation_id = ?
      `).get(disposition.observation_id) as unknown as DetachedUnknownObservationRow | undefined;
      if (!observationRow) fail("storage-invalid", `detached disposition observation 缺失：${disposition.disposition_id}`);
      detachedUnknownDispositionRecord(disposition, detachedUnknownRecord(observationRow), true);
    }
  }
  const invalidPlanTarget = db.prepare(`
    SELECT nt.plan_id FROM studio_generation_plan_node_targets nt
    JOIN studio_generation_plan_nodes n
      ON n.plan_id = nt.plan_id AND n.node_index = nt.node_index
    JOIN studio_generation_pack_targets target
      ON target.pack_id = n.pack_id AND target.pack_fingerprint = n.pack_fingerprint
    WHERE nt.target_kind <> target.target_kind
       OR nt.target_key <> target.target_key
       OR nt.target_fingerprint <> target.target_fingerprint
       OR nt.unit_id <> target.unit_id
       OR nt.unit_revision <> target.unit_revision
    LIMIT 1
  `).get() as { plan_id?: string } | undefined;
  if (invalidPlanTarget) fail("storage-invalid", `generation plan target 与 pack target 不一致：${invalidPlanTarget.plan_id}`);
  const missingPlanTarget = db.prepare(`
    SELECT n.plan_id FROM studio_generation_plan_nodes n
    LEFT JOIN studio_generation_plan_node_targets nt
      ON nt.plan_id = n.plan_id AND nt.node_index = n.node_index
    LEFT JOIN studio_generation_pack_targets target
      ON target.pack_id = n.pack_id AND target.pack_fingerprint = n.pack_fingerprint
    WHERE (target.pack_id IS NOT NULL AND nt.plan_id IS NULL)
       OR (target.pack_id IS NULL AND nt.plan_id IS NOT NULL)
    LIMIT 1
  `).get() as { plan_id?: string } | undefined;
  if (missingPlanTarget) fail("storage-invalid", `generation plan node target extension 缺失或多余：${missingPlanTarget.plan_id}`);
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) fail("storage-invalid", "generation ledger 存在外键孤儿。");
}

function assertV5Schema(db: DatabaseSync): void {
  assertGenerationSchema(db, false, false);
}

function assertV6Schema(db: DatabaseSync): void {
  assertGenerationSchema(db, true, false);
}

function assertCurrentSchema(db: DatabaseSync): void {
  assertGenerationSchema(db, true, true);
}

async function preflightGenerationDatabase(databasePath: string): Promise<SqliteSourceBindingIdentity | null> {
  if (!existsSync(databasePath)) return null;
  let snapshot: Awaited<ReturnType<typeof openSqliteReadOnlySnapshot>> | null = null;
  try {
    snapshot = await openSqliteReadOnlySnapshot(databasePath, "generation ledger");
    const probe = snapshot.database;
    const hasMeta = tableExists(probe, "studio_generation_ledger_meta");
    const hasBusinessTables = (probe.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      LIMIT 1
    `).get() as { present?: number } | undefined)?.present === 1;
    if (!hasMeta) {
      if (hasBusinessTables) fail("storage-invalid", "generation ledger 存在无 schema_version 的业务表，禁止猜测修复。");
      return snapshot.sourceIdentity;
    }
    const version = probe.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
    ).get() as { value?: string } | undefined;
    if (!version || ![
      LEGACY_SCHEMA_VERSION,
      V2_SCHEMA_VERSION,
      V3_SCHEMA_VERSION,
      V4_SCHEMA_VERSION,
      V5_SCHEMA_VERSION,
      V6_SCHEMA_VERSION,
      SCHEMA_VERSION,
    ].some((candidate) => String(candidate) === version.value)) {
      fail("storage-invalid", `不支持的 generation ledger schema_version：${version?.value ?? "缺失"}。`);
    }
    if (version.value === String(SCHEMA_VERSION)) {
      // 当前版本必须在隔离只读副本上先通过完整结构与数据合同；禁止把弱 v5
      // 交给 writable connection 打开后再发现。
      assertCurrentSchema(probe);
    } else if (version.value === String(V6_SCHEMA_VERSION)) {
      assertV6Schema(probe);
    } else if (version.value === String(V5_SCHEMA_VERSION)) {
      assertV5Schema(probe);
    }
    return snapshot.sourceIdentity;
  } catch (error) {
    if (error instanceof StudioGenerationLedgerError) throw error;
    throw new StudioGenerationLedgerError(
      "storage-invalid",
      "generation ledger 隔离快照预检失败，禁止打开写库。",
      [error instanceof Error ? error.message : String(error)],
      { cause: error },
    );
  } finally {
    await snapshot?.close();
  }
}

export function openDatabase(paths: LedgerPaths): DatabaseSync {
  const databasePath = paths.database;
  const expectedIdentity = paths.databasePreflightIdentity;
  assertSafeSqliteSidecars(databasePath, "generation ledger");
  if (expectedIdentity) {
    try {
      assertSqliteSourceBindingIdentity(databasePath, expectedIdentity, "generation ledger");
    } catch (error) {
      fail("storage-invalid", error instanceof Error ? error.message : "generation ledger 身份已漂移。");
    }
  } else if (existsSync(databasePath)) {
    fail("storage-invalid", "generation ledger 在空库预检后被并发创建，禁止写打开。");
  }
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(BUSY_TIMEOUT_MS);
  const db = new DatabaseSync(databasePath, { timeout: busyTimeoutMs });
  try {
    assertSafeSqliteSidecars(databasePath, "generation ledger");
    if (expectedIdentity) {
      assertSqliteSourceBindingIdentity(databasePath, expectedIdentity, "generation ledger");
    } else {
      inspectSqliteSourceBindingIdentity(databasePath, "generation ledger");
    }
    // 连接级 PRAGMA 不落盘；版本与 schema 验证/迁移完成前不得切 journal mode。
    db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON;`);
    const hasMeta = tableExists(db, "studio_generation_ledger_meta");
    if (!hasMeta) {
      runTransaction(db, () => {
        const hasMetaInsideTransaction = tableExists(db, "studio_generation_ledger_meta");
        if (hasMetaInsideTransaction) return;
        const hasBusinessTables = (db.prepare(`
          SELECT 1 AS present FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          LIMIT 1
        `).get() as { present?: number } | undefined)?.present === 1;
        if (hasBusinessTables) {
          fail("storage-invalid", "generation ledger 存在无 schema_version 的业务表，禁止猜测修复。");
        }
        createCurrentSchema(db);
        db.prepare("INSERT INTO studio_generation_ledger_meta(key, value) VALUES('schema_version', ?)")
          .run(String(SCHEMA_VERSION));
        assertCurrentSchema(db);
      });
    }
    const version = db.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
    ).get() as { value?: string } | undefined;
    const schemaCacheKey = studioRequestSqliteValidationKey(
      `studio-generation-schema-v${SCHEMA_VERSION}`,
      databasePath,
    );
    const schemaAlreadyValidated = version?.value === String(SCHEMA_VERSION)
      && hasStudioRequestSchemaValidation(schemaCacheKey);
    if (!version) {
      fail("storage-invalid", "generation ledger schema_version 缺失，禁止猜测修复。");
    } else if (version.value === String(LEGACY_SCHEMA_VERSION)) {
      migrateLegacySchema(db);
    } else if (version.value === String(V2_SCHEMA_VERSION)) {
      migrateV2ToV3(db);
      migrateV3ToV4(db);
      migrateV4ToCurrent(db);
    } else if (version.value === String(V3_SCHEMA_VERSION)) {
      migrateV3ToV4(db);
      migrateV4ToCurrent(db);
    } else if (version.value === String(V4_SCHEMA_VERSION)) {
      migrateV4ToCurrent(db);
    } else if (version.value === String(V5_SCHEMA_VERSION)) {
      migrateV5ToV6(db);
      migrateV6ToV7(db);
    } else if (version.value === String(V6_SCHEMA_VERSION)) {
      migrateV6ToV7(db);
    } else if (version.value === String(SCHEMA_VERSION)) {
      // 已声明当前版本的账本只做严格验证，绝不以 IF NOT EXISTS 静默补表或补触发器。
    } else {
      fail("storage-invalid", `不支持的 generation ledger schema_version：${version.value}。`);
    }
    if (!schemaAlreadyValidated) {
      assertCurrentSchema(db);
      // T11 outbox：画布投影事件表独立于 core-owned schema_version 断言集（同
      // review/continuity 扩展表模式），老库迁移后在此处幂等补表。
      ensureCanvasProjectionOutboxSchema(db);
      ensureContinuationWaiverReceiptSchema(db);
      ensureGenerationRetryOperationReceiptSchema(db);
    }
    const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
    if (foreignKeys?.foreign_keys !== 1) fail("storage-invalid", "generation ledger foreign_keys 未启用。");
    db.exec("PRAGMA synchronous=NORMAL");
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    if (journal?.journal_mode?.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode=WAL");
    if (schemaAlreadyValidated) {
      if (!isStudioRequestSqliteValidationUnchanged(
        schemaCacheKey,
        `studio-generation-schema-v${SCHEMA_VERSION}`,
        databasePath,
      )) {
        fail("storage-invalid", "generation ledger 在 schema cache-hit 复核期间发生 SQLite 身份漂移。");
      }
    } else {
      // migrations/ensure* 允许在前一阶段幂等写入；缓存只覆盖其后这个完整且
      // 身份稳定的最终验证窗口。
      const stableValidationKey = studioRequestSqliteValidationKey(
        `studio-generation-schema-v${SCHEMA_VERSION}`,
        databasePath,
      );
      assertCurrentSchema(db);
      ensureCanvasProjectionOutboxSchema(db);
      ensureContinuationWaiverReceiptSchema(db);
      ensureGenerationRetryOperationReceiptSchema(db);
      const finalVersion = db.prepare(
        "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
      ).get() as { value?: string } | undefined;
      if (finalVersion?.value !== String(SCHEMA_VERSION)) {
        fail("storage-invalid", `generation ledger schema_version 已漂移：${finalVersion?.value ?? "缺失"}。`);
      }
      if (!markStudioRequestSqliteValidationIfUnchanged(
        stableValidationKey,
        `studio-generation-schema-v${SCHEMA_VERSION}`,
        databasePath,
      )) {
        fail("storage-invalid", "generation ledger 在最终 schema 深验期间发生 SQLite 身份漂移。");
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function runTransaction<T>(db: DatabaseSync, callback: () => T): T {
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

function count(db: DatabaseSync, sql: string): number {
  return Number((db.prepare(sql).get() as { count: number }).count);
}

function stateFromDatabase(paths: LedgerPaths, db: DatabaseSync): StudioGenerationLedgerState {
  const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  const busyTimeout = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  if (journal.journal_mode.toLowerCase() !== "wal" || foreignKeys.foreign_keys !== 1) {
    fail("storage-invalid", "generation ledger SQLite 安全配置无效。");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    databasePath: paths.database,
    packCasRoot: paths.packCasRoot,
    pragmas: {
      journalMode: "wal",
      foreignKeys: true,
      busyTimeoutMs: Number(busyTimeout.timeout),
    },
    counts: {
      packs: count(db, "SELECT COUNT(*) AS count FROM studio_generation_packs"),
      dispatches: count(db, "SELECT COUNT(*) AS count FROM studio_generation_dispatches"),
      results: count(db, "SELECT COUNT(*) AS count FROM studio_generation_results"),
      pendingResults: count(db, "SELECT COUNT(*) AS count FROM studio_generation_results WHERE status = 'pending'"),
      staleAtRegistrationResults: count(
        db,
        "SELECT COUNT(*) AS count FROM studio_generation_results WHERE input_current = 0 OR promotion_eligible = 0",
      ),
      plans: count(db, "SELECT COUNT(*) AS count FROM studio_generation_plans"),
      runEvents: count(db, "SELECT COUNT(*) AS count FROM studio_generation_run_events"),
      targetExtensions: count(db, "SELECT COUNT(*) AS count FROM studio_generation_pack_targets"),
      callIntents: count(db, "SELECT COUNT(*) AS count FROM studio_generation_call_intents"),
      callEvents: count(db, "SELECT COUNT(*) AS count FROM studio_generation_call_events"),
      historicalImports: count(db, "SELECT COUNT(*) AS count FROM studio_generation_historical_imports"),
      detachedUnknownObservations: count(db, "SELECT COUNT(*) AS count FROM studio_generation_detached_unknown_observations"),
      detachedUnknownDispositions: count(db, "SELECT COUNT(*) AS count FROM studio_generation_detached_unknown_dispositions"),
    },
  };
}

export async function initializeStudioGenerationLedger(projectRoot: string): Promise<StudioGenerationLedgerState> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const db = openDatabase(paths);
  try {
    return stateFromDatabase(paths, db);
  } finally {
    db.close();
  }
}

export async function getStudioGenerationLedgerState(projectRoot: string): Promise<StudioGenerationLedgerState> {
  return initializeStudioGenerationLedger(projectRoot);
}
