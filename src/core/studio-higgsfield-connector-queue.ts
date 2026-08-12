/**
 * Canvas -> Codex host -> Higgsfield connector request queue.
 *
 * This owner never invokes the connector.  It only persists a bounded, append-only
 * request state in the existing studio-generation ledger.  The Electron renderer
 * may enqueue.  Claim/preflight/authorize/record are intentionally unavailable on
 * the public command surface until a trusted local connector adapter exists.
 * Raw claim/nonces are returned once and only their hashes are kept.
 */
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { studioSqliteBusyTimeoutMs } from "./studio-sqlite-busy.js";
import { ConfirmedCommandFailure } from "./command-outcome.js";
import { initializeStudioGenerationLedger } from "./studio-generation-ledger.js";
import { inspectManagedProjectReadOnly } from "./managed-project.js";
import {
  evaluateHiggsfieldUnlimitedCapability,
  sanitizeHiggsfieldRemoteObservation,
  type HiggsfieldConnectorCapabilityObservation,
} from "./studio-higgsfield-connector-contract.js";
import { readStudioGenerationResultBundle, readStudioGenerationRunEventHistory } from "./studio-generation-ledger.js";
import {
  assertStudioHiggsfieldFormalRunAuthorizable,
  isStudioHiggsfieldConnectorFormalRunBoundStatus,
} from "./studio-higgsfield-connector-sql-guard.js";
import { getStudioVideoPackageControl } from "./studio-video-package.js";
import { readStudioVideoPackageSourceClosure } from "./studio-video-package-source-closure.js";

const BUSY_TIMEOUT_MS = 5_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/u;
const CONTEXT_TOKEN = /^studioctx-v1-[a-f0-9]{64}$/u;
const DIRECT_OBSERVATION_TTL_MS = 5 * 60_000;
const CLAIM_LEASE_TTL_MS = 5 * 60_000;
const SUBMISSION_NONCE_TTL_MS = 5 * 60_000;
const SAFE_MODEL_VALUE = /^[A-Za-z0-9_.:-]{1,100}$/u;
const SAFE_RESOLUTION_VALUE = /^[A-Za-z0-9x:. -]{1,30}$/u;
const FORBIDDEN_OBSERVATION_TEXT = /(?:https?:\/\/|\b(?:token|cookie|authorization|bearer|password)\b|@)/iu;
const LEGACY_UNTRUSTED_FINGERPRINT = "0".repeat(64);

export type StudioHiggsfieldConnectorRequestKind = "image" | "video";
export type StudioHiggsfieldConnectorRequestStatus =
  | "queued"
  | "blocked_by_provider"
  | "claimed"
  | "authorized"
  | "submitted"
  | "submission_unknown"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface HiggsfieldDirectUnlimitedObservation extends HiggsfieldConnectorCapabilityObservation {
  /** 每次 connector 预检必须绑定当前 durable request，而不是泛化的网页/账户观察。 */
  requestBindingFingerprint: string;
  targetProfileFingerprint: string;
  /** 只存 workspace 主体的不可逆摘要，绝不存账号、cookie 或 URL。 */
  workspaceSubjectHash: string;
  /** Connector 的本次 estimate/cost 观察，不接受公共 attestation 代替。 */
  billingMode: "unlimited";
  zeroCredits: boolean;
}

export interface StudioHiggsfieldConnectorRequest {
  schemaVersion: 1;
  kind: "studio-higgsfield-connector-request";
  requestId: string;
  requestKind: StudioHiggsfieldConnectorRequestKind;
  targetKey: string;
  requestBindingFingerprint: string;
  targetProfileFingerprint: string;
  /** image 必须绑定既有 formal imagegen run；video 绑定已验证视频包 intent。 */
  imageGenerationRunId: string | null;
  intentId: string | null;
  executionAdapter: "higgsfield-connector";
  status: StudioHiggsfieldConnectorRequestStatus;
  revision: number;
  claimantId: string | null;
  blockers: string[];
  remoteJobId: string | null;
  remoteStatus: string | null;
  reconciliationEvidenceFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
}

export interface StudioHiggsfieldConnectorPublicRequest extends StudioHiggsfieldConnectorRequest {
  /** Historical post-queue states were supplied by an untrusted command caller. */
  evidenceTrust: "not_applicable" | "legacy_untrusted";
  /** No historical public command result can prove that Higgsfield charged zero credits. */
  zeroCreditVerified: false;
}

export interface EnqueueStudioHiggsfieldConnectorRequestInput {
  kind: StudioHiggsfieldConnectorRequestKind;
  /** Image is intentionally a bridge to the existing formal imagegen owner. */
  imageGenerationRunId?: string;
  /** Video is intentionally a bridge to the existing verified video-package owner. */
  intentId?: string;
}

export interface ClaimedStudioHiggsfieldConnectorRequest extends StudioHiggsfieldConnectorRequest {
  claimToken: string;
}

export interface PreflightStudioHiggsfieldConnectorRequestResult extends StudioHiggsfieldConnectorRequest {
  preflight: { callAllowed: boolean; blockers: string[] };
}

export interface AuthorizedStudioHiggsfieldConnectorRequest extends StudioHiggsfieldConnectorRequest {
  /** Single-use value for the immediately adjacent connector call; never persisted. */
  submissionNonce: string;
}

export interface HiggsfieldZeroCreditReceipt {
  requestBindingFingerprint: string;
  workspaceSubjectHash: string;
  billingMode: "unlimited";
  estimatedCredits: 0;
  receiptFingerprint: string;
}

function zeroCreditReceiptFingerprint(receipt: Omit<HiggsfieldZeroCreditReceipt, "receiptFingerprint">): string {
  return digest({
    schemaVersion: 1,
    requestBindingFingerprint: receipt.requestBindingFingerprint,
    workspaceSubjectHash: receipt.workspaceSubjectHash,
    billingMode: receipt.billingMode,
    estimatedCredits: receipt.estimatedCredits,
  });
}

type Row = {
  request_id: string;
  request_kind: StudioHiggsfieldConnectorRequestKind;
  target_key: string;
  request_binding_fingerprint: string;
  target_profile_fingerprint: string;
  image_generation_run_id: string | null;
  intent_id: string | null;
  execution_adapter: string;
  revision: number;
  status: StudioHiggsfieldConnectorRequestStatus;
  claimant_id: string | null;
  claim_token_hash: string | null;
  preflight_json: string;
  preflight_observation_json: string | null;
  blockers_json: string;
  submission_nonce_hash: string | null;
  remote_job_id: string | null;
  remote_status: string | null;
  reconciliation_evidence_fingerprint: string | null;
  created_at: string;
  fingerprint: string;
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
let currentTimeMs = (): number => Date.now();
let beforeAuthorizeTransactionHookForTests:
  | (() => void | Promise<void>)
  | null = null;
function now(): string { return new Date(currentTimeMs()).toISOString(); }

/** 仅供确定性租约测试；生产默认始终使用真实时钟。 */
export function setStudioHiggsfieldConnectorNowForTests(provider?: () => number): void {
  currentTimeMs = provider ?? (() => Date.now());
}

/** 仅供 Vitest 确定性注入 formal owner 预检与 authorize 写事务之间的竞态。 */
export function __setBeforeStudioHiggsfieldAuthorizeTransactionHookForTests(
  hook: typeof beforeAuthorizeTransactionHookForTests,
): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Higgsfield authorize 事务 hook 仅允许测试环境。");
  beforeAuthorizeTransactionHookForTests = hook;
}
function assertId(value: string, field: string): string {
  if (!ID.test(value)) throw new Error(`${field} 格式无效。`);
  return value;
}
function dbFor(databasePath: string): DatabaseSync {
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(BUSY_TIMEOUT_MS);
  const db = new DatabaseSync(databasePath, { timeout: busyTimeoutMs });
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS studio_higgsfield_connector_request_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      request_kind TEXT NOT NULL CHECK(request_kind IN ('image','video')),
      target_key TEXT NOT NULL,
      request_binding_fingerprint TEXT NOT NULL CHECK(length(request_binding_fingerprint)=64),
      target_profile_fingerprint TEXT NOT NULL CHECK(length(target_profile_fingerprint)=64),
      image_generation_run_id TEXT,
      intent_id TEXT,
      execution_adapter TEXT NOT NULL CHECK(execution_adapter='higgsfield-connector'),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      status TEXT NOT NULL CHECK(status IN ('queued','blocked_by_provider','claimed','authorized','submitted','submission_unknown','succeeded','failed','cancelled')),
      claimant_id TEXT,
      claim_token_hash TEXT,
      preflight_json TEXT NOT NULL,
      preflight_observation_json TEXT,
      blockers_json TEXT NOT NULL,
      submission_nonce_hash TEXT,
      remote_job_id TEXT,
      remote_status TEXT,
      reconciliation_evidence_fingerprint TEXT,
      created_at TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint)=64),
      UNIQUE(request_id, revision),
      CHECK((request_kind='video' AND intent_id IS NOT NULL AND image_generation_run_id IS NULL)
        OR (request_kind='image' AND image_generation_run_id IS NOT NULL AND intent_id IS NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS studio_higgsfield_connector_request_status_idx
      ON studio_higgsfield_connector_request_events(status, sequence);
    CREATE TRIGGER IF NOT EXISTS studio_higgsfield_connector_request_events_no_update
      BEFORE UPDATE ON studio_higgsfield_connector_request_events BEGIN SELECT RAISE(ABORT, 'higgsfield connector requests are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_higgsfield_connector_request_events_no_delete
    BEFORE DELETE ON studio_higgsfield_connector_request_events BEGIN SELECT RAISE(ABORT, 'higgsfield connector requests are append-only'); END;`);
  const columns = new Set((db.prepare("PRAGMA table_info(studio_higgsfield_connector_request_events)").all() as Array<{ name: string }>).map((row) => row.name));
  // 允许已安装旧候选平滑升级；旧事件没有可信绑定，故永远不能被 authorize。
  if (!columns.has("request_binding_fingerprint")) db.exec("ALTER TABLE studio_higgsfield_connector_request_events ADD COLUMN request_binding_fingerprint TEXT NOT NULL DEFAULT '';");
  if (!columns.has("target_profile_fingerprint")) db.exec("ALTER TABLE studio_higgsfield_connector_request_events ADD COLUMN target_profile_fingerprint TEXT NOT NULL DEFAULT '';");
  if (!columns.has("preflight_observation_json")) db.exec("ALTER TABLE studio_higgsfield_connector_request_events ADD COLUMN preflight_observation_json TEXT;");
  if (!columns.has("reconciliation_evidence_fingerprint")) db.exec("ALTER TABLE studio_higgsfield_connector_request_events ADD COLUMN reconciliation_evidence_fingerprint TEXT;");
  const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='studio_higgsfield_connector_request_events'").get() as { sql?: string } | undefined)?.sql ?? "";
  if (!tableSql.includes("'succeeded'")) {
    // 旧候选的 CHECK 约束无法 ALTER；保持全部 append-only 事件后原子换表。
    db.exec(`BEGIN IMMEDIATE;
      DROP TRIGGER IF EXISTS studio_higgsfield_connector_request_events_no_update;
      DROP TRIGGER IF EXISTS studio_higgsfield_connector_request_events_no_delete;
      DROP INDEX IF EXISTS studio_higgsfield_connector_request_status_idx;
      ALTER TABLE studio_higgsfield_connector_request_events RENAME TO studio_higgsfield_connector_request_events_v1;
      CREATE TABLE studio_higgsfield_connector_request_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        request_kind TEXT NOT NULL CHECK(request_kind IN ('image','video')),
        target_key TEXT NOT NULL,
        request_binding_fingerprint TEXT NOT NULL CHECK(length(request_binding_fingerprint)=64),
        target_profile_fingerprint TEXT NOT NULL CHECK(length(target_profile_fingerprint)=64),
        image_generation_run_id TEXT,
        intent_id TEXT,
        execution_adapter TEXT NOT NULL CHECK(execution_adapter='higgsfield-connector'),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        status TEXT NOT NULL CHECK(status IN ('queued','blocked_by_provider','claimed','authorized','submitted','submission_unknown','succeeded','failed','cancelled')),
        claimant_id TEXT,
        claim_token_hash TEXT,
        preflight_json TEXT NOT NULL,
        preflight_observation_json TEXT,
        blockers_json TEXT NOT NULL,
        submission_nonce_hash TEXT,
        remote_job_id TEXT,
        remote_status TEXT,
        reconciliation_evidence_fingerprint TEXT,
        created_at TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint)=64),
        UNIQUE(request_id, revision),
        CHECK((request_kind='video' AND intent_id IS NOT NULL AND image_generation_run_id IS NULL)
          OR (request_kind='image' AND image_generation_run_id IS NOT NULL AND intent_id IS NULL))
      ) STRICT;
      INSERT INTO studio_higgsfield_connector_request_events(
        sequence,request_id,request_kind,target_key,request_binding_fingerprint,target_profile_fingerprint,image_generation_run_id,intent_id,
        execution_adapter,revision,status,claimant_id,claim_token_hash,preflight_json,preflight_observation_json,blockers_json,
        submission_nonce_hash,remote_job_id,remote_status,reconciliation_evidence_fingerprint,created_at,fingerprint
      ) SELECT sequence,request_id,request_kind,target_key,
        CASE WHEN length(request_binding_fingerprint)=64 THEN request_binding_fingerprint ELSE '${LEGACY_UNTRUSTED_FINGERPRINT}' END,
        CASE WHEN length(target_profile_fingerprint)=64 THEN target_profile_fingerprint ELSE '${LEGACY_UNTRUSTED_FINGERPRINT}' END,
        image_generation_run_id,intent_id,
        execution_adapter,revision,status,claimant_id,claim_token_hash,preflight_json,preflight_observation_json,blockers_json,
        submission_nonce_hash,remote_job_id,remote_status,reconciliation_evidence_fingerprint,created_at,fingerprint
        FROM studio_higgsfield_connector_request_events_v1;
      DROP TABLE studio_higgsfield_connector_request_events_v1;
      CREATE INDEX studio_higgsfield_connector_request_status_idx ON studio_higgsfield_connector_request_events(status, sequence);
      CREATE TRIGGER studio_higgsfield_connector_request_events_no_update
        BEFORE UPDATE ON studio_higgsfield_connector_request_events BEGIN SELECT RAISE(ABORT, 'higgsfield connector requests are append-only'); END;
      CREATE TRIGGER studio_higgsfield_connector_request_events_no_delete
        BEFORE DELETE ON studio_higgsfield_connector_request_events BEGIN SELECT RAISE(ABORT, 'higgsfield connector requests are append-only'); END;
      COMMIT;`);
  }
  return db;
}
function rowToRequest(row: Row, createdAt = row.created_at): StudioHiggsfieldConnectorRequest {
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-higgsfield-connector-request" as const,
    requestId: row.request_id,
    requestKind: row.request_kind,
    targetKey: row.target_key,
    requestBindingFingerprint: row.request_binding_fingerprint,
    targetProfileFingerprint: row.target_profile_fingerprint,
    imageGenerationRunId: row.image_generation_run_id,
    intentId: row.intent_id,
    executionAdapter: "higgsfield-connector" as const,
    status: row.status,
    revision: Number(row.revision),
    claimantId: row.claimant_id,
    blockers: JSON.parse(row.blockers_json) as string[],
    remoteJobId: row.remote_job_id,
    remoteStatus: row.remote_status,
    reconciliationEvidenceFingerprint: row.reconciliation_evidence_fingerprint,
    createdAt,
    updatedAt: row.created_at,
  };
  return { ...semantic, fingerprint: row.fingerprint };
}

const LEGACY_UNTRUSTED_EXECUTION_STATUSES = new Set<StudioHiggsfieldConnectorRequestStatus>([
  "claimed",
  "authorized",
  "submitted",
  "submission_unknown",
  "succeeded",
  "failed",
  "cancelled",
]);
const TRUSTED_CONNECTOR_EVIDENCE_BLOCKER = "trusted-connector-evidence-unavailable";

function projectRequestForPublicRead(request: StudioHiggsfieldConnectorRequest): StudioHiggsfieldConnectorPublicRequest {
  const legacyUntrusted = LEGACY_UNTRUSTED_EXECUTION_STATUSES.has(request.status);
  return {
    ...request,
    blockers: legacyUntrusted
      ? [...new Set([...request.blockers, TRUSTED_CONNECTOR_EVIDENCE_BLOCKER])]
      : [...request.blockers],
    evidenceTrust: legacyUntrusted ? "legacy_untrusted" : "not_applicable",
    zeroCreditVerified: false,
  };
}
function getRequest(db: DatabaseSync, requestId: string): StudioHiggsfieldConnectorRequest | null {
  const row = db.prepare("SELECT * FROM studio_higgsfield_connector_request_events WHERE request_id=? ORDER BY revision DESC LIMIT 1").get(requestId) as Row | undefined;
  if (!row) return null;
  const first = db.prepare("SELECT created_at FROM studio_higgsfield_connector_request_events WHERE request_id=? ORDER BY revision ASC LIMIT 1").get(requestId) as { created_at: string };
  return rowToRequest(row, first.created_at);
}
function append(db: DatabaseSync, request: Omit<StudioHiggsfieldConnectorRequest, "schemaVersion" | "kind" | "createdAt" | "updatedAt" | "fingerprint" | "reconciliationEvidenceFingerprint"> & {
  claimTokenHash?: string | null;
  preflight?: { callAllowed: boolean; blockers: string[] };
  preflightObservation?: HiggsfieldDirectUnlimitedObservation | null;
  submissionNonceHash?: string | null;
  reconciliationEvidenceFingerprint?: string | null;
  updatedAt: string;
}): StudioHiggsfieldConnectorRequest {
  const preflight = request.preflight ?? { callAllowed: false, blockers: [] };
  const semantic = {
    requestId: request.requestId, requestKind: request.requestKind, targetKey: request.targetKey,
    requestBindingFingerprint: request.requestBindingFingerprint, targetProfileFingerprint: request.targetProfileFingerprint,
    imageGenerationRunId: request.imageGenerationRunId, intentId: request.intentId,
    executionAdapter: request.executionAdapter, revision: request.revision, status: request.status,
    claimantId: request.claimantId, claimTokenHash: request.claimTokenHash ?? null,
    preflight, blockers: request.blockers, submissionNonceHash: request.submissionNonceHash ?? null,
    remoteJobId: request.remoteJobId, remoteStatus: request.remoteStatus,
    reconciliationEvidenceFingerprint: request.reconciliationEvidenceFingerprint ?? null,
    createdAt: request.updatedAt,
  };
  const fingerprint = digest(semantic);
  db.prepare(`INSERT INTO studio_higgsfield_connector_request_events(
    request_id,request_kind,target_key,request_binding_fingerprint,target_profile_fingerprint,image_generation_run_id,intent_id,execution_adapter,revision,status,
    claimant_id,claim_token_hash,preflight_json,preflight_observation_json,blockers_json,submission_nonce_hash,remote_job_id,remote_status,reconciliation_evidence_fingerprint,created_at,fingerprint
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    request.requestId, request.requestKind, request.targetKey, request.requestBindingFingerprint, request.targetProfileFingerprint, request.imageGenerationRunId, request.intentId,
    request.executionAdapter, request.revision, request.status, request.claimantId,
    request.claimTokenHash ?? null, JSON.stringify(preflight), request.preflightObservation ? JSON.stringify(request.preflightObservation) : null, JSON.stringify(request.blockers),
    request.submissionNonceHash ?? null, request.remoteJobId, request.remoteStatus,
    request.reconciliationEvidenceFingerprint ?? null, request.updatedAt, fingerprint,
  );
  return { ...request, reconciliationEvidenceFingerprint: request.reconciliationEvidenceFingerprint ?? null,
    schemaVersion: 1, kind: "studio-higgsfield-connector-request", createdAt: request.updatedAt, updatedAt: request.updatedAt, fingerprint };
}
function latestSecretRow(db: DatabaseSync, requestId: string): {
  claim_token_hash: string | null;
  submission_nonce_hash: string | null;
  created_at: string;
} | null {
  return db.prepare("SELECT claim_token_hash,submission_nonce_hash,created_at FROM studio_higgsfield_connector_request_events WHERE request_id=? ORDER BY revision DESC LIMIT 1")
    .get(requestId) as { claim_token_hash: string | null; submission_nonce_hash: string | null; created_at: string } | undefined ?? null;
}

function expireConnectorLeases(db: DatabaseSync, timestampMs: number): void {
  const rows = db.prepare(`SELECT * FROM studio_higgsfield_connector_request_events WHERE sequence IN (
    SELECT MAX(sequence) FROM studio_higgsfield_connector_request_events GROUP BY request_id
  ) AND status IN ('claimed','authorized')`).all() as Row[];
  for (const row of rows) {
    const updatedMs = Date.parse(row.created_at);
    const ttl = row.status === "claimed" ? CLAIM_LEASE_TTL_MS : SUBMISSION_NONCE_TTL_MS;
    if (!Number.isFinite(updatedMs) || timestampMs - updatedMs <= ttl) continue;
    const current = rowToRequest(row, (db.prepare("SELECT created_at FROM studio_higgsfield_connector_request_events WHERE request_id=? ORDER BY revision ASC LIMIT 1").get(row.request_id) as { created_at: string }).created_at);
    if (row.status === "claimed") {
      append(db, { ...current, status: "queued", revision: current.revision + 1, claimantId: null,
        blockers: [], remoteJobId: null, remoteStatus: null, reconciliationEvidenceFingerprint: null,
        updatedAt: new Date(timestampMs).toISOString(), claimTokenHash: null, submissionNonceHash: null });
    } else {
      append(db, { ...current, status: "submission_unknown", revision: current.revision + 1,
        blockers: ["submission-window-expired-reconciliation-required"], updatedAt: new Date(timestampMs).toISOString(),
        claimTokenHash: row.claim_token_hash, submissionNonceHash: row.submission_nonce_hash });
    }
  }
}
function directGate(request: StudioHiggsfieldConnectorRequest, observation: HiggsfieldDirectUnlimitedObservation): { callAllowed: boolean; blockers: string[] } {
  const blockers = request.requestKind === "video"
    ? [...evaluateHiggsfieldUnlimitedCapability(observation).blockers]
    : [];
  const profile = targetProfile(request.requestKind);
  const observedAt = Date.parse(observation.observedAt);
  if (!Number.isFinite(observedAt) || Math.abs(currentTimeMs() - observedAt) > DIRECT_OBSERVATION_TTL_MS) blockers.push("provider-observation-not-direct-or-stale");
  if (request.requestBindingFingerprint === LEGACY_UNTRUSTED_FINGERPRINT
    || request.targetProfileFingerprint === LEGACY_UNTRUSTED_FINGERPRINT) blockers.push("legacy-request-binding-untrusted");
  if (observation.source !== "higgsfield-connector") blockers.push("connector-source-invalid");
  if (observation.unlimAvailable !== true) blockers.push("unlim-unavailable");
  if (observation.supportsUnlim !== true) blockers.push("model-does-not-support-unlim");
  if (observation.billingMode !== "unlimited") blockers.push("provider-billing-not-unlimited");
  if (observation.zeroCredits !== true) blockers.push("provider-cost-not-zero");
  if (observation.model !== profile.model || observation.mode !== profile.mode || observation.durationSeconds !== profile.durationSeconds || observation.resolution !== profile.resolution) blockers.push("provider-target-parameters-mismatch");
  if (observation.adjustments.length) blockers.push("provider-adjustments-present");
  if (!SHA256.test(observation.workspaceSubjectHash)) blockers.push("provider-workspace-subject-invalid");
  if (observation.requestBindingFingerprint !== request.requestBindingFingerprint) blockers.push("provider-request-binding-mismatch");
  if (observation.targetProfileFingerprint !== request.targetProfileFingerprint) blockers.push("provider-target-profile-mismatch");
  return { callAllowed: blockers.length === 0, blockers: [...new Set(blockers)] };
}
function rowClaimHash(db: DatabaseSync, requestId: string): string | null {
  return (db.prepare("SELECT claim_token_hash FROM studio_higgsfield_connector_request_events WHERE request_id=? ORDER BY revision DESC LIMIT 1").get(requestId) as { claim_token_hash: string | null } | undefined)?.claim_token_hash ?? null;
}

function rowPreflightObservation(db: DatabaseSync, requestId: string): HiggsfieldDirectUnlimitedObservation | null {
  const row = db.prepare("SELECT preflight_observation_json FROM studio_higgsfield_connector_request_events WHERE request_id=? ORDER BY revision DESC LIMIT 1")
    .get(requestId) as { preflight_observation_json: string | null } | undefined;
  if (!row?.preflight_observation_json) return null;
  try {
    const parsed = JSON.parse(row.preflight_observation_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as HiggsfieldDirectUnlimitedObservation : null;
  } catch { return null; }
}

function targetProfileFingerprint(kind: StudioHiggsfieldConnectorRequestKind): string {
  // 图片不新增第二个 image owner：仅把既有 Codex formal dispatch 交给 connector adapter。
  return digest(kind === "video"
    ? { adapter: "higgsfield-connector", kind, model: "seedance_2_5", mode: "omni_reference", durationSeconds: 20, resolution: "720p", audio: true, useUnlim: true }
    : { adapter: "higgsfield-connector", kind, source: "existing-codex-formal-dispatch", model: "gpt_image_2", mode: "image_generation", resolution: "1k", quality: "low", count: 1, useUnlim: true });
}

function targetProfile(kind: StudioHiggsfieldConnectorRequestKind): { model: string; mode: string; durationSeconds: number; resolution: string } {
  return kind === "video"
    ? { model: "seedance_2_5", mode: "omni_reference", durationSeconds: 20, resolution: "720p" }
    : { model: "gpt_image_2", mode: "image_generation", durationSeconds: 1, resolution: "1k" };
}

function normalizeDirectObservation(value: HiggsfieldDirectUnlimitedObservation): HiggsfieldDirectUnlimitedObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Higgsfield direct observation 无效。 ");
  const allowed = new Set(["source", "observedAt", "unlimAvailable", "supportsUnlim", "billingMode", "zeroCredits", "model", "mode", "durationSeconds", "resolution", "adjustments", "requestBindingFingerprint", "targetProfileFingerprint", "workspaceSubjectHash"]);
  if (Object.keys(value as unknown as Record<string, unknown>).some((key) => !allowed.has(key))) throw new Error("Higgsfield direct observation 含未允许字段。 ");
  const strings = [value.model, value.mode, value.resolution, value.requestBindingFingerprint, value.targetProfileFingerprint, value.workspaceSubjectHash, ...value.adjustments];
  if (strings.some((entry) => typeof entry !== "string" || FORBIDDEN_OBSERVATION_TEXT.test(entry))) throw new Error("Higgsfield direct observation 不得含路径、URL、账号或凭据。 ");
  if (!SAFE_MODEL_VALUE.test(value.model) || !SAFE_MODEL_VALUE.test(value.mode) || !SAFE_RESOLUTION_VALUE.test(value.resolution)
    || !SHA256.test(value.requestBindingFingerprint) || !SHA256.test(value.targetProfileFingerprint) || !SHA256.test(value.workspaceSubjectHash)
    || !Array.isArray(value.adjustments) || value.adjustments.length > 20 || value.adjustments.some((entry) => entry.length > 300)
    || !Number.isInteger(value.durationSeconds) || value.durationSeconds < 1 || value.durationSeconds > 120
    || value.source !== "higgsfield-connector" || value.billingMode !== "unlimited" || typeof value.unlimAvailable !== "boolean" || typeof value.supportsUnlim !== "boolean" || typeof value.zeroCredits !== "boolean") {
    throw new Error("Higgsfield direct observation 格式无效。 ");
  }
  if (!Number.isFinite(Date.parse(value.observedAt))) throw new Error("Higgsfield direct observation 时间无效。 ");
  return { source: value.source, observedAt: value.observedAt, unlimAvailable: value.unlimAvailable, supportsUnlim: value.supportsUnlim,
    billingMode: value.billingMode, zeroCredits: value.zeroCredits, model: value.model, mode: value.mode, durationSeconds: value.durationSeconds,
    resolution: value.resolution, adjustments: [...value.adjustments], requestBindingFingerprint: value.requestBindingFingerprint,
    targetProfileFingerprint: value.targetProfileFingerprint, workspaceSubjectHash: value.workspaceSubjectHash };
}

export async function assertStudioHiggsfieldConnectorOwnerCurrent(projectRoot: string, input: EnqueueStudioHiggsfieldConnectorRequestInput): Promise<void> {
  if (input.kind === "image") {
    const runId = assertId(input.imageGenerationRunId ?? "", "imageGenerationRunId");
    const history = await readStudioGenerationRunEventHistory(projectRoot, runId);
    const dispatch = history.find((event) => event.kind === "dispatched")?.detail as { provider?: unknown; packId?: unknown } | undefined;
    if (!dispatch || dispatch.provider !== "codex" || typeof dispatch.packId !== "string") {
      throw new Error("Higgsfield 图片请求必须绑定既有 Codex formal generationRunId/pack。 ");
    }
    if (history.at(-1)?.kind !== "dispatched") throw new Error("Higgsfield 图片请求的 formal run 已非 dispatched，禁止创建第二个 owner。 ");
    if (await readStudioGenerationResultBundle(projectRoot, runId)) {
      throw new Error("Higgsfield 图片请求的 formal run 已有 raw+labeled 成功结果，禁止重复生成。 ");
    }
    return;
  }
  const intentId = assertId(input.intentId ?? "", "intentId");
  const lookup = await getStudioVideoPackageControl(projectRoot, { by: "intent", intentId });
  const control = lookup.status === "resolved" ? lookup.control : null;
  if (!control || control.status !== "mechanically-verified" || !control.intent.sourceClosureFingerprint) {
    throw new Error("Higgsfield 视频请求必须绑定已机械验证且带 source closure 的视频包。 ");
  }
  // 重新读取受控 closure manifest，避免只相信旧控制面上的字符串。
  await readStudioVideoPackageSourceClosure(projectRoot, control.intent.sourceClosureFingerprint, { roles: ["source-spec"] });
  const generation = await initializeStudioGenerationLedger(projectRoot);
  const db = dbFor(generation.databasePath);
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='studio_higgsfield_video_generation_events'").get();
    if (table) {
      const row = db.prepare("SELECT status FROM studio_higgsfield_video_generation_events WHERE intent_id=? ORDER BY sequence DESC LIMIT 1").get(intentId) as { status?: string } | undefined;
      if (row && !["committed", "failed", "cancelled"].includes(row.status ?? "")) throw new Error("Higgsfield 视频已有非终态 owner，禁止重复排队。 ");
    }
  } finally { db.close(); }
}

export async function enqueueStudioHiggsfieldConnectorRequest(projectRoot: string, input: EnqueueStudioHiggsfieldConnectorRequestInput): Promise<StudioHiggsfieldConnectorRequest> {
  if (input.kind !== "image" && input.kind !== "video") throw new Error("Higgsfield request kind 无效。 ");
  const imageGenerationRunId = input.kind === "image" ? assertId(input.imageGenerationRunId ?? "", "imageGenerationRunId") : null;
  const intentId = input.kind === "video" ? assertId(input.intentId ?? "", "intentId") : null;
  if ((input.kind === "image" && input.intentId !== undefined) || (input.kind === "video" && input.imageGenerationRunId !== undefined)) throw new Error("Higgsfield 请求必须只绑定一种既有 owner。 ");
  await assertStudioHiggsfieldConnectorOwnerCurrent(projectRoot, input);
  const targetKey = imageGenerationRunId ? `image:${imageGenerationRunId}` : `video:${intentId}`;
  const profileFingerprint = targetProfileFingerprint(input.kind);
  const requestBindingFingerprint = digest({ schemaVersion: 1, targetKey, adapter: "higgsfield-connector", profileFingerprint });
  const requestId = `higgsreq-${requestBindingFingerprint.slice(0, 40)}`;
  const generation = await initializeStudioGenerationLedger(projectRoot);
  const db = dbFor(generation.databasePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    const existing = getRequest(db, requestId);
    if (existing) {
      if (!["blocked_by_provider", "cancelled", "failed"].includes(existing.status)) { db.exec("COMMIT"); return existing; }
      const requeued = append(db, { ...existing, status: "queued", revision: existing.revision + 1, claimantId: null, blockers: [], remoteJobId: null, remoteStatus: null, updatedAt: now() });
      db.exec("COMMIT");
      return requeued;
    }
    const timestamp = now();
    const request = append(db, {
      requestId, requestKind: input.kind, targetKey, requestBindingFingerprint, targetProfileFingerprint: profileFingerprint, imageGenerationRunId, intentId,
      executionAdapter: "higgsfield-connector", status: "queued", revision: 1, claimantId: null,
      blockers: [], remoteJobId: null, remoteStatus: null, updatedAt: timestamp,
    });
    db.exec("COMMIT");
    return request;
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; } finally { db.close(); }
}

export async function claimStudioHiggsfieldConnectorRequest(projectRoot: string, input: { requestId: string; claimantId: string; expectedRevision: number }): Promise<ClaimedStudioHiggsfieldConnectorRequest> {
  const generation = await initializeStudioGenerationLedger(projectRoot);
  const db = dbFor(generation.databasePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    expireConnectorLeases(db, currentTimeMs());
    const current = getRequest(db, assertId(input.requestId, "requestId"));
    if (!current || current.revision !== input.expectedRevision || current.status !== "queued") throw new Error("Higgsfield 请求不可领取或 revision 已变化。 ");
    const occupied = db.prepare(`SELECT request_id FROM studio_higgsfield_connector_request_events WHERE status IN ('claimed','authorized','submitted','submission_unknown')
      AND sequence IN (SELECT MAX(sequence) FROM studio_higgsfield_connector_request_events GROUP BY request_id) LIMIT 1`).get() as { request_id?: string } | undefined;
    if (occupied && occupied.request_id !== current.requestId) throw new Error("Higgsfield connector 并发上限为 1，已有请求正在占用。 ");
    const claimToken = `higgsclaim-${randomUUID().replace(/-/gu, "")}`;
    const next = append(db, { ...current, status: "claimed", revision: current.revision + 1, claimantId: assertId(input.claimantId, "claimantId"), blockers: [], updatedAt: now(), claimTokenHash: digest(claimToken) });
    db.exec("COMMIT");
    return { ...next, claimToken };
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; } finally { db.close(); }
}

export async function preflightStudioHiggsfieldConnectorRequest(projectRoot: string, input: { requestId: string; claimToken: string; expectedRevision: number; observation: HiggsfieldDirectUnlimitedObservation }): Promise<PreflightStudioHiggsfieldConnectorRequestResult> {
  const generation = await initializeStudioGenerationLedger(projectRoot); const db = dbFor(generation.databasePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    const current = getRequest(db, assertId(input.requestId, "requestId"));
    if (!current || current.revision !== input.expectedRevision) throw new Error("Higgsfield 请求不存在或 revision 已变化。 ");
    if (current.status === "submission_unknown") throw new Error("Higgsfield 请求为 submission_unknown，禁止重新预检或重提。 ");
    if (current.status !== "claimed" || rowClaimHash(db, current.requestId) !== digest(input.claimToken)) throw new Error("Higgsfield claim 无效或请求未被领取。 ");
    const observation = normalizeDirectObservation(input.observation);
    const preflight = directGate(current, observation);
    const next = append(db, { ...current, status: preflight.callAllowed ? "claimed" : "blocked_by_provider", revision: current.revision + 1,
      blockers: preflight.blockers, updatedAt: now(), claimTokenHash: digest(input.claimToken), preflight, preflightObservation: observation });
    db.exec("COMMIT"); return { ...next, preflight };
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; } finally { db.close(); }
}

export async function authorizeStudioHiggsfieldConnectorRequest(projectRoot: string, input: { requestId: string; claimToken: string; expectedRevision: number; projectContextToken: string }): Promise<AuthorizedStudioHiggsfieldConnectorRequest> {
  if (!CONTEXT_TOKEN.test(input.projectContextToken)) throw new Error("projectContextToken 无效。 ");
  const before = await getStudioHiggsfieldConnectorRequest(projectRoot, input.requestId);
  if (!before) throw new Error("Higgsfield 请求不存在。 ");
  await assertStudioHiggsfieldConnectorOwnerCurrent(projectRoot, before.requestKind === "image"
    ? { kind: "image", imageGenerationRunId: before.imageGenerationRunId ?? "" }
    : { kind: "video", intentId: before.intentId ?? "" });
  const beforeTransactionHook = beforeAuthorizeTransactionHookForTests;
  try {
    await beforeTransactionHook?.();
  } finally {
    beforeAuthorizeTransactionHookForTests = null;
  }
  const generation = await initializeStudioGenerationLedger(projectRoot); const db = dbFor(generation.databasePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    const current = getRequest(db, assertId(input.requestId, "requestId"));
    if (!current || current.revision !== input.expectedRevision) throw new Error("Higgsfield 请求不存在或 revision 已变化。 ");
    if (current.status === "authorized" || current.status === "submitted" || current.status === "submission_unknown") {
      throw new Error("Higgsfield 请求已经消费过一次授权，禁止再次授权或重提。 ");
    }
    if (current.status !== "claimed") throw new Error("Higgsfield 请求不可授权；必须先处于 claimed。 ");
    if (rowClaimHash(db, current.requestId) !== digest(input.claimToken)) throw new Error("Higgsfield claim token 无效。 ");
    const observation = rowPreflightObservation(db, current.requestId);
    const preflight = observation ? directGate(current, observation) : { callAllowed: false, blockers: ["provider-request-bound-preflight-missing"] };
    if (!preflight.callAllowed) {
      const blocked = append(db, { ...current, status: "blocked_by_provider", revision: current.revision + 1, blockers: preflight.blockers, updatedAt: now(), claimTokenHash: digest(input.claimToken), preflight });
      db.exec("COMMIT");
      throw new ConfirmedCommandFailure(`Higgsfield provider 未确认零成本 Unlimited：${blocked.blockers.join(",")}`, {
        ...blocked,
        callAllowed: false,
      });
    }
    if (current.requestKind === "image") {
      assertStudioHiggsfieldFormalRunAuthorizable(db, current.imageGenerationRunId!);
    }
    const submissionNonce = `higgsnonce-${randomUUID().replace(/-/gu, "")}`;
    const next = append(db, { ...current, status: "authorized", revision: current.revision + 1, blockers: [], updatedAt: now(), claimTokenHash: digest(input.claimToken), submissionNonceHash: digest(submissionNonce), preflight, preflightObservation: observation });
    db.exec("COMMIT"); return { ...next, submissionNonce };
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; } finally { db.close(); }
}

export async function recordStudioHiggsfieldConnectorSubmission(projectRoot: string, input: { requestId: string; claimToken: string; expectedRevision: number; submissionNonce: string; remoteJobId: string | null; zeroCreditReceipt?: HiggsfieldZeroCreditReceipt; remoteStatus?: string }): Promise<StudioHiggsfieldConnectorRequest> {
  const generation = await initializeStudioGenerationLedger(projectRoot); const db = dbFor(generation.databasePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    const current = getRequest(db, assertId(input.requestId, "requestId"));
    if (!current || current.revision !== input.expectedRevision || current.status !== "authorized") throw new Error("Higgsfield 请求不在可登记提交状态。 ");
    const row = latestSecretRow(db, current.requestId);
    if (!row || row.claim_token_hash !== digest(input.claimToken) || row.submission_nonce_hash !== digest(input.submissionNonce)) throw new Error("Higgsfield 提交 nonce 无效。 ");
    const remoteJobId = input.remoteJobId === null ? null : assertId(input.remoteJobId, "remoteJobId");
    const observation = rowPreflightObservation(db, current.requestId);
    const receipt = input.zeroCreditReceipt;
    const receiptValid = Boolean(receipt
      && SHA256.test(receipt.receiptFingerprint)
      && receipt.billingMode === "unlimited"
      && receipt.estimatedCredits === 0
      && receipt.requestBindingFingerprint === current.requestBindingFingerprint
      && receipt.workspaceSubjectHash === observation?.workspaceSubjectHash
      && receipt.receiptFingerprint === zeroCreditReceiptFingerprint(receipt));
    const nonceExpired = !row?.created_at || !Number.isFinite(Date.parse(row.created_at)) || currentTimeMs() - Date.parse(row.created_at) > SUBMISSION_NONCE_TTL_MS;
    const blockers = [
      ...(remoteJobId ? [] : ["remote-job-id-missing-reconcile-required"]),
      ...(receiptValid ? [] : ["zero-credit-receipt-missing-or-mismatch-reconcile-required"]),
      ...(nonceExpired ? ["submission-nonce-expired-reconcile-required"] : []),
    ];
    const next = append(db, { ...current, status: blockers.length === 0 ? "submitted" : "submission_unknown", revision: current.revision + 1,
      // 即便 receipt 缺失而进入 unknown，也必须保留已经确认收到的远端 ID，
      // 以便人工对账；unknown 仍禁止重新授权或重提。
      blockers, remoteJobId,
      remoteStatus: sanitizeHiggsfieldRemoteObservation(input.remoteStatus),
      updatedAt: now(), claimTokenHash: row.claim_token_hash, submissionNonceHash: row.submission_nonce_hash });
    db.exec("COMMIT"); return next;
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; } finally { db.close(); }
}

export type ReconcileStudioHiggsfieldConnectorResolution =
  | "remote_running"
  | "remote_succeeded"
  | "remote_failed"
  | "remote_cancelled"
  | "not_submitted";

/**
 * Codex host crash-recovery boundary.  It never authorizes a second generate:
 * unknown can only be bound to an observed remote job or explicitly closed after
 * confirming that no remote submission exists.
 */
export async function reconcileStudioHiggsfieldConnectorRequest(projectRoot: string, input: {
  requestId: string;
  expectedRevision: number;
  resolution: ReconcileStudioHiggsfieldConnectorResolution;
  remoteJobId?: string;
  remoteStatus?: string;
  evidenceFingerprint: string;
  confirmNoRemoteSubmission?: boolean;
}): Promise<StudioHiggsfieldConnectorRequest> {
  if (!SHA256.test(input.evidenceFingerprint)) throw new Error("Higgsfield 对账 evidenceFingerprint 无效。 ");
  const generation = await initializeStudioGenerationLedger(projectRoot);
  const db = dbFor(generation.databasePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    const current = getRequest(db, assertId(input.requestId, "requestId"));
    if (!current || current.revision !== input.expectedRevision) throw new Error("Higgsfield 对账请求不存在或 revision 已变化。 ");
    if (!["authorized", "submitted", "submission_unknown"].includes(current.status)) {
      throw new Error("Higgsfield 请求不在可对账状态。 ");
    }
    const secret = latestSecretRow(db, current.requestId);
    if (input.resolution === "not_submitted") {
      if (input.confirmNoRemoteSubmission !== true || current.status === "submitted" || current.remoteJobId) {
        throw new Error("只有明确证明远端未创建任务后，才能关闭 unknown/authorized。 ");
      }
      const next = append(db, { ...current, status: "cancelled", revision: current.revision + 1,
        blockers: ["reconciled-not-submitted"], remoteStatus: "not-submitted", reconciliationEvidenceFingerprint: input.evidenceFingerprint,
        updatedAt: now(), claimTokenHash: secret?.claim_token_hash, submissionNonceHash: secret?.submission_nonce_hash });
      db.exec("COMMIT");
      return next;
    }
    const remoteJobId = assertId(input.remoteJobId ?? current.remoteJobId ?? "", "remoteJobId");
    if (current.remoteJobId && current.remoteJobId !== remoteJobId) throw new Error("Higgsfield 对账 remoteJobId 与既有回执冲突。 ");
    const status: StudioHiggsfieldConnectorRequestStatus = input.resolution === "remote_running"
      ? "submitted"
      : input.resolution === "remote_succeeded"
        ? "succeeded"
        : input.resolution === "remote_failed"
          ? "failed"
          : "cancelled";
    const next = append(db, { ...current, status, revision: current.revision + 1, blockers: [], remoteJobId,
      remoteStatus: sanitizeHiggsfieldRemoteObservation(input.remoteStatus ?? input.resolution.replace(/^remote_/u, "")),
      reconciliationEvidenceFingerprint: input.evidenceFingerprint, updatedAt: now(),
      claimTokenHash: secret?.claim_token_hash, submissionNonceHash: secret?.submission_nonce_hash });
    db.exec("COMMIT");
    return next;
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; } finally { db.close(); }
}

/** Formal image run 的 terminal writer 在写入前调用，避免越过 connector reservation。 */
export async function assertNoActiveStudioHiggsfieldConnectorReservation(projectRoot: string, generationRunId: string): Promise<void> {
  const request = await getStudioHiggsfieldConnectorRequestByTarget(projectRoot, { kind: "image", imageGenerationRunId: generationRunId });
  if (request && isStudioHiggsfieldConnectorFormalRunBoundStatus(request.status)) {
    throw new Error(`generationRunId=${generationRunId} 已被 Higgsfield connector 请求 ${request.requestId} 绑定（${request.status}）；formal owner 不得接管该 run。`);
  }
}

export async function getStudioHiggsfieldConnectorRequest(projectRoot: string, requestId: string): Promise<StudioHiggsfieldConnectorRequest | null> {
  const generation = await initializeStudioGenerationLedger(projectRoot); const db = dbFor(generation.databasePath);
  try { return getRequest(db, assertId(requestId, "requestId")); } finally { db.close(); }
}

/** Read-only public projection: never includes claim token, nonce, connector path or observation body. */
export async function getStudioHiggsfieldConnectorRequestByTarget(
  projectRoot: string,
  input: { kind: StudioHiggsfieldConnectorRequestKind; intentId?: string; imageGenerationRunId?: string },
): Promise<StudioHiggsfieldConnectorPublicRequest | null> {
  const targetKey = input.kind === "video"
    ? `video:${assertId(input.intentId ?? "", "intentId")}`
    : `image:${assertId(input.imageGenerationRunId ?? "", "imageGenerationRunId")}`;
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(BUSY_TIMEOUT_MS);
  const db = new DatabaseSync(shell.paths.generationDatabase, { timeout: busyTimeoutMs, readOnly: true });
  try {
    db.exec(`PRAGMA query_only=ON; PRAGMA busy_timeout=${busyTimeoutMs};`);
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='studio_higgsfield_connector_request_events'").get()) return null;
    const row = db.prepare(`SELECT request_id FROM studio_higgsfield_connector_request_events WHERE target_key=?
      ORDER BY sequence DESC LIMIT 1`).get(targetKey) as { request_id?: string } | undefined;
    const request = row?.request_id ? getRequest(db, row.request_id) : null;
    return request ? projectRequestForPublicRead(request) : null;
  } finally { db.close(); }
}

/** Codex host 的有界只读领取视图；不返回 nonce、claim token、路径或预检原文。 */
export async function getStudioHiggsfieldConnectorWorkQueue(
  projectRoot: string,
  input: { statuses?: StudioHiggsfieldConnectorRequestStatus[]; limit?: number } = {},
): Promise<{ schemaVersion: 1; kind: "studio-higgsfield-connector-work-queue"; items: StudioHiggsfieldConnectorPublicRequest[]; readOnly: true; fingerprint: string }> {
  const limit = input.limit ?? 12;
  if (!Number.isInteger(limit) || limit < 1 || limit > 36) throw new Error("Higgsfield 工作队列 limit 必须是 1–36。 ");
  const allowed = new Set<StudioHiggsfieldConnectorRequestStatus>(["queued", "blocked_by_provider", "claimed", "authorized", "submitted", "submission_unknown", "succeeded", "failed", "cancelled"]);
  const statuses: StudioHiggsfieldConnectorRequestStatus[] = input.statuses?.length ? [...new Set(input.statuses)] : ["queued", "claimed", "authorized", "submission_unknown"];
  if (statuses.some((status) => !allowed.has(status))) throw new Error("Higgsfield 工作队列 status 无效。 ");
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(BUSY_TIMEOUT_MS);
  const db = new DatabaseSync(shell.paths.generationDatabase, { timeout: busyTimeoutMs, readOnly: true });
  try {
    db.exec(`PRAGMA query_only=ON; PRAGMA busy_timeout=${busyTimeoutMs};`);
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='studio_higgsfield_connector_request_events'").get()) {
      const semantic = { schemaVersion: 1 as const, kind: "studio-higgsfield-connector-work-queue" as const, items: [], readOnly: true as const };
      return { ...semantic, fingerprint: digest(semantic) };
    }
    const marks = statuses.map(() => "?").join(",");
    const rows = db.prepare(`SELECT * FROM studio_higgsfield_connector_request_events WHERE sequence IN (
      SELECT MAX(sequence) FROM studio_higgsfield_connector_request_events GROUP BY request_id
    ) AND status IN (${marks}) ORDER BY sequence ASC LIMIT ?`).all(...statuses, limit) as Row[];
    const items = rows.map((row) => {
      const first = db.prepare("SELECT created_at FROM studio_higgsfield_connector_request_events WHERE request_id=? ORDER BY revision ASC LIMIT 1").get(row.request_id) as { created_at: string };
      return projectRequestForPublicRead(rowToRequest(row, first.created_at));
    });
    const semantic = { schemaVersion: 1 as const, kind: "studio-higgsfield-connector-work-queue" as const, items, readOnly: true as const };
    return { ...semantic, fingerprint: digest(semantic) };
  } finally { db.close(); }
}
