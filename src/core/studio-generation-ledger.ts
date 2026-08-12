/**
 * Studio generation 本地持久账本。本模块只冻结、校验和登记，永不调用 imagegen 或任何外部服务。
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp, { type OutputInfo } from "sharp";
import {
  canonicalizeStudioJsonValue as stableValue,
  digestStudioCanonicalJson as stableDigest,
  serializeStudioCanonicalJsonPretty,
} from "./studio-canonical-json.js";
import {
  StudioGenerationLedgerError,
  StudioGenerationResultConflictError,
  type StudioGenerationLedgerErrorCode,
  type StudioGenerationLedgerState,
  type StudioGenerationResultVariant,
} from "./studio-generation-ledger-contract.js";
export {
  StudioGenerationLedgerError,
  StudioGenerationResultConflictError,
  type StudioGenerationLedgerErrorCode,
  type StudioGenerationLedgerState,
  type StudioGenerationResultVariant,
} from "./studio-generation-ledger-contract.js";
import { getStudioMedia, verifyStudioMediaObject } from "./material-studio.js";
import {
  ensureConfinedDirectory,
  inspectExistingConfinedDirectory,
  persistConfinedBytesNoReplace,
  readConfinedRegularFileWithIdentity,
  revalidateConfinedDirectory,
} from "./confined-project-storage.js";
import {
  assertStudioGenerationFreezePackCurrent,
  buildStudioGenerationFreezePack,
  StudioGenerationFreezeError,
  type StudioCodexGenerationRequest,
  type StudioGenerationFreezePack,
  type StudioGenerationQueryInput,
} from "./studio-generation.js";
import {
  assertStudioUnitGridGenerationFreezePackIntegrity,
  assertStudioUnitGridGenerationFreezePackCurrent,
  buildStudioUnitGridGenerationFreezePack,
  type StudioUnitGridContinuationWaiverReference,
  type StudioUnitGridContinuationWaiverSnapshot,
  type StudioUnitGridActualTailContinuationSourceSnapshot,
  type StudioUnitGridGenerationFreezePack,
  type StudioUnitGridGenerationQueryInput,
} from "./studio-unit-grid-generation.js";
import {
  isStudioFormalImagegenProvider,
  normalizeStudioFormalImagegenProvider,
  type StudioFormalImagegenProvider,
} from "./studio-imagegen-providers.js";
import {
  getStudioAssetBindingSet,
  getStudioProductionUnitSnapshot,
  listStudioProductionUnits,
} from "./studio-production.js";
import { appendCanvasProjectionEvent } from "./studio-canvas-projection-outbox.js";
import {
  assertNoActiveStudioHiggsfieldConnectorReservationInTransaction,
  StudioHiggsfieldConnectorSqlGuardError,
} from "./studio-higgsfield-connector-sql-guard.js";
import {
  detachedUnknownDispositionRecord,
  detachedUnknownDispositionSemantic,
  detachedUnknownRecord,
  detachedUnknownSemantic,
  dispatchIdentity,
  managedLedgerPaths,
  openDatabase,
  runTransaction,
  tableExists,
  type DetachedUnknownDispositionRow,
  type DetachedUnknownObservationRow,
  type LedgerPaths,
} from "./studio-generation-ledger-storage.js";
export {
  __setBeforeGenerationWritableOpenHookForTests,
  getStudioGenerationLedgerState,
  initializeStudioGenerationLedger,
} from "./studio-generation-ledger-storage.js";
import { withStudioRequestSchemaCache } from "./studio-request-schema-cache.js";

const IMAGEGEN_QUARANTINE_RELATIVE_ROOT = ".aicanvas/studio-generation/quarantine";
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_PACK_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

let beforeImagegenIntentTransactionHookForTests:
  | (() => void | Promise<void>)
  | null = null;

/** 仅供 Vitest 确定性注入 final currentness → call-intent 事务竞态。 */
export function __setBeforeImagegenIntentTransactionHookForTests(
  hook: typeof beforeImagegenIntentTransactionHookForTests,
): void {
  if (process.env.NODE_ENV !== "test") throw new Error("imagegen intent 事务 hook 仅允许测试环境。");
  beforeImagegenIntentTransactionHookForTests = hook;
}

export type StudioGenerationResultStatus = "pending" | "approved" | "rejected";
export type StudioGenerationDispatchProvenance = "local-dispatch-intent" | "legacy-registration";
export type StudioGenerationTargetKind = "panel" | "unit-grid";
export type StudioGenerationCallEventKind = "result-committed" | "not-invoked" | "unknown-observation";
export type AnyStudioGenerationFreezePack = StudioGenerationFreezePack | StudioUnitGridGenerationFreezePack;

/** 轻量索引投影，故意不暴露冻结包 CAS 路径或媒体 objectPath。 */
export interface StudioGenerationPackRecord {
  sequence: number;
  packId: string;
  fingerprint: string;
  contentSha256: string;
  contentSizeBytes: number;
  projectId: string;
  unitId: string;
  unitRevision: number;
  panelId: string;
  panelIndex: number;
  createdAt: string;
}

export interface FreezeAndPersistStudioGenerationPackResult extends StudioGenerationPackRecord {
  persisted: true;
  pack: StudioGenerationFreezePack;
}

export interface RegisterStudioGenerationResultInput {
  packId: string;
  packFingerprint: string;
  generationRunId: string;
  variant: StudioGenerationResultVariant;
  mediaSha256: string;
  /** 若提供，必须与 dispatch 时声明的 provider 一致。 */
  provider?: StudioFormalImagegenProvider;
}

/**
 * v4 Agent 写回合同：provider 必填，raw/labeled 只能以同一事务成对追加。
 * 历史单项 register 仅保留读取/兼容面，新 Agent 不应再用它组装结果对。
 */
export interface RegisterStudioGenerationResultBundleInput {
  packId: string;
  packFingerprint: string;
  generationRunId: string;
  provider: StudioFormalImagegenProvider;
  rawMediaSha256: string;
  labeledMediaSha256: string;
  /** protocol v2（unit-grid）必须与调用前 intent 精确匹配。 */
  callId?: string;
}

export interface StudioGenerationResultBundleRecord {
  schemaVersion: 4 | 5;
  kind: "studio-generation-result-bundle";
  generationRunId: string;
  packId: string;
  packFingerprint: string;
  provider: StudioFormalImagegenProvider;
  status: "pending-review";
  pairComplete: true;
  inputCurrent: boolean;
  raw: StudioGenerationResultRecord;
  labeled: StudioGenerationResultRecord;
  createdAt: string;
  fingerprint: string;
}

export interface FreezeAndPersistStudioUnitGridGenerationPackResult {
  persisted: true;
  targetKind: "unit-grid";
  targetKey: string;
  packId: string;
  fingerprint: string;
  contentSha256: string;
  contentSizeBytes: number;
  projectId: string;
  unitId: string;
  unitRevision: number;
  panelCount: number;
  createdAt: string;
  pack: StudioUnitGridGenerationFreezePack;
}

export interface PrepareStudioImagegenCallInput {
  packId: string;
  packFingerprint: string;
  generationRunId: string;
  provider: StudioFormalImagegenProvider;
  projectContextToken: string;
  commandRequestId: string;
  /** 调用发起代理/会话的稳定审计身份；旧客户端可省略，历史行保持 null。 */
  callerAgentId?: string;
  expectedRevision: 0;
}

export interface AuthorizeStudioUnitGridContinuationWaiverInput {
  unitId: string;
  expectedUnitRevision: number;
  projectContextToken: string;
  authorizationEvidenceReference: string;
  authorizationText: string;
  authorizationTextSha256: string;
  reason: string;
  acknowledgePreviousActualTailUnavailable: true;
  acknowledgeCanonicalRestartMayBreakContinuity: true;
  acknowledgeIdentityAndSceneLocksRemainMandatory: true;
}

export interface RegisterStudioVerifiedHistoricalImportContinuationWaiverInput {
  unitId: string;
  expectedUnitRevision: number;
  sourceManifestFingerprint: string;
  authorizationEvidenceReference: string;
  mode: "initial-import" | "incremental-reconcile" | "test-fixture";
}

export interface ResolveStudioUnitGridContinuationWaiverReceiptOptions {
  currentUnitId: string;
  expectedAuthorityKind: StudioUnitGridContinuationWaiverSnapshot["authorityKind"];
  /**
   * 仅供已经原子落下 paid-call intent 的迟到结果恢复使用。
   * receipt、工程、前后单元与内容地址仍须完全一致；只不再要求授权时的
   * active build/context 仍是当前 head，且绝不能用于 freeze/dispatch/pre-call。
   */
  validationPhase?: "freeze-or-paid-call" | "post-paid-call-intent";
}

export interface StudioGenerationCallIntentRecord {
  schemaVersion: 1;
  kind: "studio-generation-call-intent";
  callId: string;
  generationRunId: string;
  dispatchId: string;
  packId: string;
  packFingerprint: string;
  provider: StudioFormalImagegenProvider;
  targetKind: StudioGenerationTargetKind;
  targetKey: string;
  inputFingerprint: string;
  contextTokenHash: string;
  commandRequestId: string;
  callerAgentId: string | null;
  quarantine: {
    schemaVersion: 1;
    kind: "studio-imagegen-quarantine-grant";
    rootPath: string;
    candidatePath: string;
    receiptPath: string;
  };
  status: "generation_unknown" | "not-invoked" | "result-committed" | "owner-abandoned";
  callAllowed: boolean;
  idempotentReplay: boolean;
  createdAt: string;
}

export interface ReconcileStudioImagegenCallInput {
  callId: string;
  projectContextToken: string;
  result: "not-invoked" | "unknown-observation";
  evidenceReference: string;
  evidenceFingerprint: string;
  note?: string;
}

export interface AbandonStudioGenerationUnknownInput {
  callId: string;
  generationRunId: string;
  projectContextToken: string;
  evidenceReference: string;
  evidenceFingerprint: string;
  reason: string;
  acknowledgeRemoteMayExist: true;
  acknowledgeLateResultWillBeRejected: true;
}

export interface RebindStudioImagegenCallContextInput {
  callId: string;
  generationRunId: string;
  packId: string;
  packFingerprint: string;
  inputFingerprint: string;
  candidateSha256: string;
  receiptSha256: string;
  projectContextToken: string;
  evidenceReference: string;
  evidenceFingerprint: string;
  reason: string;
  acknowledgeBuildChangedAfterInvocation: true;
  acknowledgeNoSecondModelCall: true;
}

export interface StudioImagegenCallContextRebindDetail {
  schemaVersion: 1;
  kind: "studio-imagegen-call-context-rebind";
  callId: string;
  generationRunId: string;
  dispatchId: string;
  packId: string;
  packFingerprint: string;
  provider: StudioFormalImagegenProvider;
  inputFingerprint: string;
  fromContextTokenHash: string;
  toContextTokenHash: string;
  candidateSha256: string;
  receiptSha256: string;
  executionReceiptFingerprint: string;
  evidenceReference: string;
  evidenceFingerprint: string;
  reason: string;
  acknowledgeBuildChangedAfterInvocation: true;
  acknowledgeNoSecondModelCall: true;
}

export interface StudioImagegenCallContextRebindRecord extends StudioImagegenCallContextRebindDetail {
  eventId: string;
  createdAt: string;
  callAllowed: false;
  idempotentReplay: boolean;
}

export interface StudioGenerationUnknownOwnerAbandonDetail {
  disposition: "owner-abandoned-generation-unknown";
  remoteInvocation: "unknown-may-exist";
  lateResultPolicy: "quarantine-and-reject";
  publicationPolicy: "forbidden";
  acknowledgeRemoteMayExist: true;
  acknowledgeLateResultWillBeRejected: true;
  evidenceReference: string;
  evidenceFingerprint: string;
  reason: string;
}

export interface StudioGenerationCallEventRecord {
  eventId: string;
  callId: string;
  generationRunId: string;
  kind: StudioGenerationCallEventKind;
  evidenceReference: string;
  evidenceFingerprint: string;
  note: string;
  createdAt: string;
}

export interface ImportStudioHistoricalGenerationEvidenceInput {
  packId: string;
  packFingerprint: string;
  rawMediaSha256: string;
  labeledMediaSha256: string;
  sourceRawSha256: string;
  sourceLabeledSha256: string;
  sourceManifestFingerprint: string;
  qcEvidenceReference: string;
  qcEvidenceSha256: string;
  externalStoryboardStatus: string;
}

/**
 * 历史 PASS 的零生图投影。它与 pack/media 同属 Studio ledger，
 * 但明确没有 generationRunId/provider/callId，不伪造历史模型调用事实。
 */
export interface StudioHistoricalGenerationEvidenceRecord {
  schemaVersion: 1;
  kind: "studio-historical-generation-evidence";
  provenance: "historical-import";
  importId: string;
  packId: string;
  packFingerprint: string;
  targetKind: "unit-grid";
  targetKey: string;
  unitId: string;
  unitRevision: number;
  generationRunId: null;
  provider: null;
  callId: null;
  generationCallCount: 0;
  raw: { resultId: string; mediaSha256: string; sourceSha256: string; status: "approved" };
  labeled: { resultId: string; mediaSha256: string; sourceSha256: string; status: "approved" };
  review: {
    provenance: "external-qc-import";
    decision: "pass";
    evidenceReference: string;
    evidenceSha256: string;
    externalStoryboardStatus: string;
  };
  sourceManifestFingerprint: string;
  createdAt: string;
  fingerprint: string;
}

export interface RecordStudioDetachedGenerationUnknownInput {
  unitId: string;
  unitRevision: number;
  unitFingerprint: string;
  sourceTaskId: string;
  evidenceReference: string;
  evidenceFingerprint: string;
  candidateSha256?: string;
  candidateSizeBytes?: number;
  candidateWidth?: number;
  candidateHeight?: number;
  note?: string;
}

/**
 * 无法绑定到当前 Studio pack/run/call 的迟到调用观察。它只形成 fail-closed blocker，
 * 不导入候选媒体、不伪造 provider/run/call，也不能被当作 generation result。
 */
export interface StudioDetachedGenerationUnknownObservation {
  schemaVersion: 1;
  kind: "studio-detached-generation-observation";
  observationId: string;
  targetKind: "unit-grid";
  targetKey: string;
  unitId: string;
  unitRevision: number;
  unitFingerprint: string;
  sourceTaskId: string;
  status: "generation_unknown";
  evidenceReference: string;
  evidenceFingerprint: string;
  candidateSha256: string | null;
  candidateSizeBytes: number | null;
  candidateWidth: number | null;
  candidateHeight: number | null;
  note: string;
  callAllowed: false;
  fingerprint: string;
  createdAt: string;
}

export interface AbandonStudioDetachedGenerationUnknownInput {
  observationId: string;
  expectedObservationFingerprint: string;
  projectContextToken: string;
  authorizationEvidenceReference: string;
  authorizationText: string;
  authorizationTextSha256: string;
  reason: string;
  acknowledgeRemoteGenerationMayExist: true;
  acknowledgeDetachedCandidateWillNeverBeImportedOrReused: true;
  acknowledgeFreshFormalRunMayDuplicateRemoteGeneration: true;
  activeContext: {
    projectId: string;
    manifestFingerprint: string;
    buildId: string;
    sourceDigest: string;
  };
}

export interface StudioDetachedGenerationUnknownDisposition {
  schemaVersion: 1;
  kind: "studio-detached-generation-unknown-disposition";
  dispositionId: string;
  observationId: string;
  observationFingerprint: string;
  targetKind: "unit-grid";
  targetKey: string;
  unitId: string;
  unitRevision: number;
  unitFingerprint: string;
  sourceTaskId: string;
  status: "owner-abandoned";
  remoteInvocation: "unknown-may-exist";
  detachedCandidatePolicy: "never-import-or-reuse";
  nextRunPolicy: "fresh-formal-run-only";
  authorizationEvidenceReference: string;
  authorizationTextSha256: string;
  reason: string;
  acknowledgeRemoteGenerationMayExist: true;
  acknowledgeDetachedCandidateWillNeverBeImportedOrReused: true;
  acknowledgeFreshFormalRunMayDuplicateRemoteGeneration: true;
  projectContext: {
    projectId: string;
    manifestFingerprint: string;
    contextTokenHash: string;
    buildId: string;
    sourceDigest: string;
  };
  callAllowed: false;
  fingerprint: string;
  createdAt: string;
  idempotentReplay: boolean;
}

export interface DispatchStudioGenerationPackInput {
  packId: string;
  packFingerprint: string;
  generationRunId: string;
  /** 本次由哪家正式 Agent 执行生图：codex 或 grok。 */
  provider: StudioFormalImagegenProvider;
}

/**
 * local-dispatch-intent 仅表示本地执行面已追加一次不可变提交意图，
 * 不伪造任何远程供应商已收到请求的事实。
 */
export interface StudioGenerationDispatchRecord {
  sequence: number;
  dispatchId: string;
  generationRunId: string;
  packId: string;
  packFingerprint: string;
  provider: StudioFormalImagegenProvider;
  dispatchProvenance: StudioGenerationDispatchProvenance;
  dispatchedAt: string;
}

/** 普通查询投影公共字段：只返回媒体 SHA，不返回本地媒体路径。 */
interface StudioGenerationResultRecordBase {
  sequence: number;
  resultId: string;
  generationRunId: string;
  variant: StudioGenerationResultVariant;
  status: StudioGenerationResultStatus;
  mediaSha256: string;
  dispatchId: string;
  provider: StudioFormalImagegenProvider;
  dispatchProvenance: StudioGenerationDispatchProvenance;
  dispatchedAt: string;
  packId: string;
  packFingerprint: string;
  unitId: string;
  unitRevision: number;
  pairComplete: boolean;
  inputCurrent: boolean;
  promotionEligible: boolean;
  staleReasons: string[];
  createdAt: string;
}

/**
 * 结果目标公开身份。unit-grid 的 SQLite panel_id/panel_index 只是内部兼容锚点，
 * 对外必须物理省略，不能用 targetKey 或第一格伪造 panel 身份。
 */
export type StudioGenerationResultRecord = StudioGenerationResultRecordBase & (
  | {
      targetKind: "panel";
      targetKey: string;
      panelId: string;
      panelIndex: number;
    }
  | {
      targetKind: "unit-grid";
      targetKey: string;
    }
);

export interface StudioGenerationPanelHistoryQuery {
  unitId: string;
  panelId: string;
  cursor?: string;
  limit?: number;
  /** 默认保持历史兼容的正序；画布结果节点必须显式请求 newest-first。 */
  order?: "oldest-first" | "newest-first";
}

export interface StudioGenerationPanelHistoryPage {
  items: StudioGenerationResultRecord[];
  nextCursor?: string;
}

/** P30 unit-grid 目标历史；不接受或投影 SQLite 的兼容 panel 锚点。 */
export interface StudioGenerationUnitGridHistoryQuery {
  unitId: string;
  cursor?: string;
  limit?: number;
  /** 默认保持旧 history 的正序；画布结果节点应显式请求 newest-first。 */
  order?: "oldest-first" | "newest-first";
}

interface PackRow {
  sequence: number;
  pack_id: string;
  fingerprint: string;
  content_sha256: string;
  content_relpath: string;
  content_size_bytes: number;
  project_id: string;
  unit_id: string;
  unit_revision: number;
  panel_id: string;
  panel_index: number;
  created_at: string;
}

interface PackTargetRow {
  pack_id: string;
  pack_fingerprint: string;
  target_kind: "unit-grid";
  target_key: string;
  target_fingerprint: string;
  unit_id: string;
  unit_revision: number;
  compatibility_panel_id: string;
  compatibility_panel_index: number;
  panel_count: number;
  created_at: string;
}

interface DispatchRow {
  sequence: number;
  dispatch_id: string;
  generation_run_id: string;
  pack_id: string;
  pack_fingerprint: string;
  executor_provider: string;
  provenance: StudioGenerationDispatchProvenance;
  dispatched_at: string;
}

interface DispatchProtocolRow {
  dispatch_id: string;
  generation_run_id: string;
  protocol_version: number;
  requires_call_intent: number;
  created_at: string;
}

interface CallIntentRow {
  call_id: string;
  generation_run_id: string;
  dispatch_id: string;
  pack_id: string;
  pack_fingerprint: string;
  executor_provider: string;
  target_kind: StudioGenerationTargetKind;
  target_key: string;
  input_fingerprint: string;
  context_token_hash: string;
  command_request_id: string;
  created_at: string;
  caller_agent_id: string | null;
}

interface CallEventRow {
  sequence: number;
  event_id: string;
  call_id: string;
  generation_run_id: string;
  kind: StudioGenerationCallEventKind;
  evidence_reference: string;
  evidence_fingerprint: string;
  note: string;
  created_at: string;
}

interface ContinuationWaiverReceiptRow {
  sequence: number;
  receipt_id: string;
  authority_kind: "user-authorization" | "verified-historical-import";
  project_id: string;
  current_unit_id: string;
  current_unit_revision: number;
  current_unit_fingerprint: string;
  previous_unit_id: string;
  previous_unit_revision: number;
  previous_unit_fingerprint: string;
  authorization_evidence_reference: string;
  authorization_text_sha256: string;
  reason: string;
  acknowledge_previous_actual_tail_unavailable: number;
  acknowledge_canonical_restart_may_break_continuity: number;
  acknowledge_identity_and_scene_locks_remain_mandatory: number;
  manifest_fingerprint: string | null;
  context_token_hash: string | null;
  build_id: string | null;
  source_digest: string | null;
  source_manifest_fingerprint: string | null;
  fingerprint: string;
  created_at: string;
}

interface HistoricalImportRow {
  sequence: number;
  import_id: string;
  pack_id: string;
  pack_fingerprint: string;
  target_kind: "unit-grid";
  target_key: string;
  unit_id: string;
  unit_revision: number;
  raw_media_sha256: string;
  labeled_media_sha256: string;
  source_raw_sha256: string;
  source_labeled_sha256: string;
  source_manifest_fingerprint: string;
  qc_evidence_reference: string;
  qc_evidence_sha256: string;
  external_storyboard_status: string;
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

function assertNoActiveConnectorReservation(
  db: DatabaseSync,
  generationRunId: string,
): void {
  try {
    assertNoActiveStudioHiggsfieldConnectorReservationInTransaction(db, generationRunId);
  } catch (error) {
    if (error instanceof StudioHiggsfieldConnectorSqlGuardError) {
      fail("run-terminal", error.message);
    }
    throw error;
  }
}

function serializePack(pack: AnyStudioGenerationFreezePack): Buffer {
  return Buffer.from(serializeStudioCanonicalJsonPretty(pack), "utf8");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeId(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail("invalid-input", `${field} 不能为空。`);
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(normalized)) fail("invalid-input", `${field} 格式无效。`);
  return normalized;
}

function normalizeSha256(value: string, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value.trim().toLowerCase())) {
    fail("invalid-input", `${field} 必须是 64 位 SHA-256。`);
  }
  return value.trim().toLowerCase();
}

function normalizeVariant(value: string): StudioGenerationResultVariant {
  if (value !== "raw" && value !== "labeled") fail("invalid-input", "variant 必须是 raw 或 labeled。");
  return value;
}

function normalizeDispatchProvider(value: unknown): StudioFormalImagegenProvider {
  try {
    return normalizeStudioFormalImagegenProvider(value, "provider");
  } catch (error) {
    fail("invalid-input", error instanceof Error ? error.message : String(error));
  }
}

function relativeToProject(projectRoot: string, absolutePath: string): string {
  const relative = path.relative(projectRoot, absolutePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("storage-invalid", "generation pack CAS 路径逃逸受管项目。");
  }
  return relative.split(path.sep).join("/");
}

function fromProjectRelative(projectRoot: string, relativePath: string): string {
  const absolute = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("pack-cas-drift", "generation pack 索引包含越界 CAS 路径。");
  }
  return absolute;
}

async function verifyFile(filePath: string, expectedSha256: string, expectedSize: number): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    throw new StudioGenerationLedgerError("pack-cas-drift", `generation pack CAS 无法读取：${filePath}`, [], { cause: error });
  }
  if (bytes.byteLength !== expectedSize || sha256(bytes) !== expectedSha256) {
    fail("pack-cas-drift", `generation pack CAS 字节与索引 SHA 不一致：${expectedSha256}`);
  }
  return bytes;
}

async function materializePackCas(paths: LedgerPaths, bytes: Buffer): Promise<{
  contentSha256: string;
  contentSizeBytes: number;
  relativePath: string;
}> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PACK_BYTES) {
    fail("storage-invalid", `generation pack JSON 必须为 1-${MAX_PACK_BYTES} 字节。`);
  }
  const contentSha256 = sha256(bytes);
  const directory = path.join(paths.packCasRoot, contentSha256.slice(0, 2));
  const targetPath = path.join(directory, `${contentSha256}.json`);
  const directoryIdentity = await ensureConfinedDirectory(paths.root, directory);
  const persisted = await persistConfinedBytesNoReplace(
    directoryIdentity,
    `${contentSha256}.json`,
    bytes,
  );
  if (persisted.sha256 !== contentSha256 || persisted.size !== bytes.byteLength) {
    fail("pack-cas-drift", `generation pack CAS dirfd 回执与 SHA 索引不一致：${contentSha256}`);
  }
  return {
    contentSha256,
    contentSizeBytes: bytes.byteLength,
    relativePath: relativeToProject(paths.root, targetPath),
  };
}

function packRowById(db: DatabaseSync, packId: string): PackRow | undefined {
  return db.prepare("SELECT * FROM studio_generation_packs WHERE pack_id = ?").get(packId) as unknown as PackRow | undefined;
}

function packTargetRowById(db: DatabaseSync, packId: string): PackTargetRow | undefined {
  return db.prepare("SELECT * FROM studio_generation_pack_targets WHERE pack_id = ?")
    .get(packId) as unknown as PackTargetRow | undefined;
}

function dispatchProtocolRowByRun(db: DatabaseSync, generationRunId: string): DispatchProtocolRow | undefined {
  return db.prepare("SELECT * FROM studio_generation_dispatch_protocols WHERE generation_run_id = ?")
    .get(generationRunId) as unknown as DispatchProtocolRow | undefined;
}

function callIntentRowByRun(db: DatabaseSync, generationRunId: string): CallIntentRow | undefined {
  return db.prepare("SELECT * FROM studio_generation_call_intents WHERE generation_run_id = ?")
    .get(generationRunId) as unknown as CallIntentRow | undefined;
}

function callIntentRowById(db: DatabaseSync, callId: string): CallIntentRow | undefined {
  return db.prepare("SELECT * FROM studio_generation_call_intents WHERE call_id = ?")
    .get(callId) as unknown as CallIntentRow | undefined;
}

function callEventsById(db: DatabaseSync, callId: string): CallEventRow[] {
  return db.prepare("SELECT * FROM studio_generation_call_events WHERE call_id = ? ORDER BY sequence")
    .all(callId) as unknown as CallEventRow[];
}

function packRecord(row: PackRow): StudioGenerationPackRecord {
  return {
    sequence: Number(row.sequence),
    packId: row.pack_id,
    fingerprint: row.fingerprint,
    contentSha256: row.content_sha256,
    contentSizeBytes: Number(row.content_size_bytes),
    projectId: row.project_id,
    unitId: row.unit_id,
    unitRevision: Number(row.unit_revision),
    panelId: row.panel_id,
    panelIndex: Number(row.panel_index),
    createdAt: row.created_at,
  };
}

function assertDispatchRowIntegrity(row: DispatchRow): void {
  if (!isStudioFormalImagegenProvider(row.executor_provider)) {
    fail("storage-invalid", `generation dispatch ${row.dispatch_id} 的 executor_provider 无效。`);
  }
  const expectedId = dispatchIdentity({
    generationRunId: row.generation_run_id,
    packId: row.pack_id,
    packFingerprint: row.pack_fingerprint,
    provenance: row.provenance,
    provider: row.executor_provider,
  });
  // v2 迁移行：dispatch_id 仍按旧 schema 内容地址，provider 固定 codex；允许旧 id 保留。
  const legacyId = `studio-generation-dispatch-${stableDigest({
    schemaVersion: 2,
    generationRunId: row.generation_run_id,
    packId: row.pack_id,
    packFingerprint: row.pack_fingerprint,
    provenance: row.provenance,
  }).slice(0, 40)}`;
  if (row.dispatch_id !== expectedId && !(row.executor_provider === "codex" && row.dispatch_id === legacyId)) {
    fail("storage-invalid", `generation dispatch ${row.dispatch_id} 的内容地址无效。`);
  }
}

function dispatchRecord(row: DispatchRow): StudioGenerationDispatchRecord {
  assertDispatchRowIntegrity(row);
  return {
    sequence: Number(row.sequence),
    dispatchId: row.dispatch_id,
    generationRunId: row.generation_run_id,
    packId: row.pack_id,
    packFingerprint: row.pack_fingerprint,
    provider: row.executor_provider as StudioFormalImagegenProvider,
    dispatchProvenance: row.provenance,
    dispatchedAt: row.dispatched_at,
  };
}

function parseStoredResultCurrentness(row: ResultRow): {
  inputCurrent: boolean;
  promotionEligible: boolean;
  staleReasons: string[];
} {
  if ((row.input_current !== 0 && row.input_current !== 1)
    || (row.promotion_eligible !== 0 && row.promotion_eligible !== 1)) {
    fail("storage-invalid", `generation result ${row.result_id} 的 currentness 布尔值无效。`);
  }
  let staleReasons: unknown;
  try {
    staleReasons = JSON.parse(row.stale_reasons_json);
  } catch (error) {
    throw new StudioGenerationLedgerError(
      "storage-invalid",
      `generation result ${row.result_id} 的 staleReasons JSON 无法解析。`,
      [],
      { cause: error },
    );
  }
  if (!Array.isArray(staleReasons)
    || staleReasons.some((reason) => typeof reason !== "string" || !reason.trim())
    || new Set(staleReasons).size !== staleReasons.length
    || (row.input_current === 1 && staleReasons.length > 0)
    || (row.input_current === 0 && staleReasons.length === 0)
    || (row.input_current === 0 && row.promotion_eligible !== 0)) {
    fail("storage-invalid", `generation result ${row.result_id} 的 currentness/staleReasons 组合无效。`);
  }
  return {
    inputCurrent: row.input_current === 1,
    promotionEligible: row.promotion_eligible === 1,
    staleReasons: [...staleReasons] as string[],
  };
}

function mergeReasons(...collections: string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const reason of collections.flat()) {
    const normalized = reason.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged;
}

function currentnessReasons(error: StudioGenerationFreezeError): string[] {
  // FreezeError.details 可能包含本地 CAS 绝对路径；普通历史查询只序列化稳定 code/message。
  return [`${error.code}: ${error.message}`];
}

async function observePackInputCurrentness(
  projectRoot: string,
  pack: AnyStudioGenerationFreezePack,
): Promise<{ inputCurrent: true; staleReasons: [] } | { inputCurrent: false; staleReasons: string[] }> {
  try {
    await assertAnyPackCurrent(projectRoot, pack);
    return { inputCurrent: true, staleReasons: [] };
  } catch (error) {
    if (!(error instanceof StudioGenerationFreezeError)
      || error.code === "storage-invalid"
      || error.code === "unmanaged-project") throw error;
    return { inputCurrent: false, staleReasons: currentnessReasons(error) };
  }
}

async function verifyResultMedia(paths: LedgerPaths, row: ResultRow): Promise<void> {
  const media = await getStudioMedia(paths.root, row.media_sha256);
  if (!media) fail("result-media-missing", `结果图 ${row.media_sha256} 已从 material CAS 索引中消失。`);
  if (media.kind !== "image" || media.derivativeStatus !== "ready") {
    fail("result-media-invalid", `结果媒体 ${row.media_sha256} 不再是 ready image。`);
  }
  if (!await verifyStudioMediaObject(paths.root, row.media_sha256)) {
    fail("result-media-drift", `结果图 ${row.media_sha256} 的 material CAS 实测 SHA 失败。`);
  }
}

interface ResultProjectionContext {
  dispatch: DispatchRow;
  pack: PackRow;
  target?: PackTargetRow;
  siblings: ResultRow[];
  pairComplete: boolean;
}

function collectResultProjectionContexts(
  db: DatabaseSync,
  rows: ResultRow[],
): Map<string, ResultProjectionContext> {
  const contexts = new Map<string, ResultProjectionContext>();
  for (const row of rows) {
    const dispatch = db.prepare("SELECT * FROM studio_generation_dispatches WHERE dispatch_id = ?")
      .get(row.dispatch_id) as unknown as DispatchRow | undefined;
    if (!dispatch
      || dispatch.generation_run_id !== row.generation_run_id
      || dispatch.pack_id !== row.pack_id
      || dispatch.pack_fingerprint !== row.pack_fingerprint) {
      fail("storage-invalid", `generation result ${row.result_id} 缺少一致 dispatch 证据。`);
    }
    assertDispatchRowIntegrity(dispatch);
    const siblings = db.prepare(
      "SELECT * FROM studio_generation_results WHERE generation_run_id = ? ORDER BY sequence",
    ).all(row.generation_run_id) as unknown as ResultRow[];
    if (siblings.length > 2
      || siblings.some((sibling) => sibling.dispatch_id !== dispatch.dispatch_id
        || sibling.pack_id !== dispatch.pack_id
        || sibling.pack_fingerprint !== dispatch.pack_fingerprint)
      || new Set(siblings.map((sibling) => sibling.variant)).size !== siblings.length) {
      fail("storage-invalid", `generationRunId=${row.generation_run_id} 的 raw/labeled 配对证据无效。`);
    }
    const variants = new Set(siblings.map((sibling) => sibling.variant));
    const pack = packRowById(db, row.pack_id);
    if (!pack || pack.fingerprint !== row.pack_fingerprint) {
      fail("pack-index-conflict", `generation result ${row.result_id} 的 pack 索引不一致。`);
    }
    contexts.set(row.result_id, {
      dispatch,
      pack,
      target: packTargetRowById(db, row.pack_id),
      siblings,
      pairComplete: variants.size === 2 && variants.has("raw") && variants.has("labeled"),
    });
  }
  return contexts;
}

async function projectResultRecords(
  paths: LedgerPaths,
  rows: ResultRow[],
  contexts: Map<string, ResultProjectionContext>,
): Promise<StudioGenerationResultRecord[]> {
  const packObservations = new Map<string, Promise<{
    inputCurrent: boolean;
    staleReasons: string[];
  }>>();
  const mediaChecks = new Map<string, Promise<void>>();
  const tasks = rows.map(async (row) => {
    const context = contexts.get(row.result_id);
    if (!context) fail("storage-invalid", `generation result ${row.result_id} 缺少投影上下文。`);
    let observation = packObservations.get(row.pack_id);
    if (!observation) {
      observation = readAnyPackFromRow(paths, context.pack)
        .then((pack) => observePackInputCurrentness(paths.root, pack));
      packObservations.set(row.pack_id, observation);
    }
    const live = await observation;
    for (const sibling of context.siblings) {
      let mediaCheck = mediaChecks.get(sibling.media_sha256);
      if (!mediaCheck) {
        mediaCheck = verifyResultMedia(paths, sibling);
        mediaChecks.set(sibling.media_sha256, mediaCheck);
      }
      await mediaCheck;
    }
    const siblingCurrentness = context.siblings.map(parseStoredResultCurrentness);
    const inputCurrent = siblingCurrentness.every((stored) => stored.inputCurrent) && live.inputCurrent;
    const staleReasons = mergeReasons(
      ...siblingCurrentness.map((stored) => stored.staleReasons),
      live.staleReasons,
    );
    const promotionEligible = context.siblings.every((sibling, index) => sibling.status === "pending"
        && siblingCurrentness[index]!.promotionEligible)
      && inputCurrent
      && context.pairComplete;
    const target = targetIdentityFromRows(context.pack, context.target);
    const targetProjection = target.targetKind === "panel"
      ? {
          targetKind: "panel" as const,
          targetKey: target.targetKey,
          panelId: row.panel_id,
          panelIndex: Number(row.panel_index),
        }
      : {
          targetKind: "unit-grid" as const,
          targetKey: target.targetKey,
        };
    return {
      sequence: Number(row.sequence),
      resultId: row.result_id,
      generationRunId: row.generation_run_id,
      variant: row.variant,
      status: row.status,
      mediaSha256: row.media_sha256,
      dispatchId: context.dispatch.dispatch_id,
      provider: context.dispatch.executor_provider as StudioFormalImagegenProvider,
      dispatchProvenance: context.dispatch.provenance,
      dispatchedAt: context.dispatch.dispatched_at,
      packId: row.pack_id,
      packFingerprint: row.pack_fingerprint,
      unitId: row.unit_id,
      unitRevision: Number(row.unit_revision),
      ...targetProjection,
      pairComplete: context.pairComplete,
      inputCurrent,
      promotionEligible,
      staleReasons,
      createdAt: row.created_at,
    };
  });
  // Promise.all 在首个拒绝后不会取消其他校验；等全部收敛后再按查询顺序抛错，
  // 避免调用方清理临时工程时仍有后台 SQLite/CAS 读取。
  const settled = await Promise.allSettled(tasks);
  for (const result of settled) {
    if (result.status === "rejected") throw result.reason;
  }
  return settled.map((result) => (result as PromiseFulfilledResult<StudioGenerationResultRecord>).value);
}

async function projectResultRowsWithFreshDatabase(
  paths: LedgerPaths,
  rows: ResultRow[],
): Promise<StudioGenerationResultRecord[]> {
  const db = openDatabase(paths);
  let contexts: Map<string, ResultProjectionContext>;
  try {
    contexts = collectResultProjectionContexts(db, rows);
  } finally {
    db.close();
  }
  return projectResultRecords(paths, rows, contexts);
}

function requestFingerprint(request: StudioCodexGenerationRequest): string {
  const { id: _id, fingerprint: _fingerprint, ...semantic } = request;
  return stableDigest(semantic);
}

function assertPackSelfIntegrity(pack: StudioGenerationFreezePack): void {
  if (!pack || pack.kind !== "studio-generation-freeze-pack") {
    fail("pack-cas-drift", "generation pack CAS JSON 类型无效。");
  }
  const packSchemaVersion = Number(pack.schemaVersion);
  const requestSchemaVersion = Number(pack.request?.schemaVersion);
  if ((packSchemaVersion !== 3 && packSchemaVersion !== 4)
    || requestSchemaVersion !== packSchemaVersion
    || pack.provenance !== "asset-binding-set"
    || pack.request?.provenance !== "asset-binding-set") {
    fail(
      "pack-schema-unsupported",
      "generation ledger 只读取 schema v3/v4 且 pack/request 同版的 asset-binding-set 冻结包；历史版本不会自动提升。",
    );
  }
  const { id: _id, fingerprint: _fingerprint, ...semantic } = pack;
  const fingerprint = stableDigest(semantic);
  if (pack.fingerprint !== fingerprint || pack.id !== `studio-generation-freeze-${fingerprint.slice(0, 32)}`) {
    fail("pack-cas-drift", "generation pack 内容与 packId/fingerprint 不一致。");
  }
  const nestedFingerprint = requestFingerprint(pack.request);
  if (pack.request.fingerprint !== nestedFingerprint
    || pack.request.id !== `studio-codex-request-${nestedFingerprint.slice(0, 32)}`) {
    fail("pack-cas-drift", "generation pack 内的 Codex request 内容地址无效。");
  }
  const binding = pack.assetBinding;
  if (!binding || binding.bindingSet.id !== pack.request.assetBinding.bindingSetId
    || binding.bindingSet.fingerprint !== pack.request.assetBinding.bindingSetFingerprint
    || binding.analysis.id !== pack.request.assetBinding.analysisId
    || binding.analysis.fingerprint !== pack.request.assetBinding.analysisFingerprint
    || binding.fingerprint !== pack.request.assetBinding.provenanceFingerprint
    || !pack.panelReferenceResolution
    || !SHA256_PATTERN.test(pack.panelReferenceResolution.fingerprint)
    || pack.panelReferenceResolution.fingerprint !== pack.request.assetBinding.referenceResolutionFingerprint) {
    fail("pack-cas-drift", "generation pack 的 BindingSet/analysis/panel reference resolution provenance 不一致。");
  }
  const { fingerprint: _bindingFingerprint, ...bindingSemantic } = binding;
  if (binding.fingerprint !== stableDigest(bindingSemantic)
    || !binding.currentness.head || !binding.currentness.current || !binding.currentness.ready
    || binding.currentness.staleReasons.length > 0 || binding.currentness.blockers.length > 0) {
    fail("pack-cas-drift", "generation pack 的 BindingSet currentness 证据无效。");
  }
  const forbiddenIds = new Set(pack.request.modelPayload.forbiddenAssets.map((asset) => asset.assetId));
  const safetyIds = new Set(pack.request.safetyConstraints.map((constraint) => constraint.assetId));
  if (pack.request.controlReferences.some((reference) => forbiddenIds.has(reference.assetId))
    || forbiddenIds.size !== safetyIds.size
    || [...forbiddenIds].some((assetId) => !safetyIds.has(assetId))) {
    fail("pack-cas-drift", "generation pack 的 forbidden 资产泄漏到上传引用或缺少安全控制约束。");
  }
}

function assertPackDispatchable(pack: StudioGenerationFreezePack): void {
  if (Number(pack.schemaVersion) !== 4 || Number(pack.request?.schemaVersion) !== 4) {
    fail(
      "pack-schema-unsupported",
      "schema v3 generation pack 仅供历史读取；dispatch/register/promotion 必须重新冻结为 schema v4，禁止迁移或改写旧 pack CAS。",
    );
  }
}

function isUnitGridFreezePack(pack: AnyStudioGenerationFreezePack): pack is StudioUnitGridGenerationFreezePack {
  return Number(pack?.schemaVersion) === 5
    || (pack as StudioUnitGridGenerationFreezePack | undefined)?.provenance === "unit-grid-binding-sets";
}

function assertUnitGridPackSelfIntegrity(pack: StudioUnitGridGenerationFreezePack): void {
  try {
    assertStudioUnitGridGenerationFreezePackIntegrity(pack);
  } catch (error) {
    if (error instanceof StudioGenerationFreezeError) {
      fail("pack-cas-drift", `unit-grid generation pack 自身完整性失败：${error.message}`, [...error.details]);
    }
    throw error;
  }
  for (const panel of pack.panels) {
    assertPackSelfIntegrity(panel.panelPack);
    assertPackDispatchable(panel.panelPack);
    if (panel.panelPack.target.panelId !== panel.panelId
      || panel.panelPack.target.panelIndex !== panel.panelIndex) {
      fail("pack-cas-drift", `unit-grid 第 ${panel.order} 格的嵌套 panel pack 与目标不一致。`);
    }
  }
}

function assertAnyPackSelfIntegrity(pack: AnyStudioGenerationFreezePack): void {
  if (isUnitGridFreezePack(pack)) assertUnitGridPackSelfIntegrity(pack);
  else assertPackSelfIntegrity(pack);
}

function assertAnyPackDispatchable(pack: AnyStudioGenerationFreezePack): void {
  if (isUnitGridFreezePack(pack)) {
    if (Number(pack.schemaVersion) !== 5 || Number(pack.request?.schemaVersion) !== 5) {
      fail("pack-schema-unsupported", "unit-grid dispatch 只接受 schema v5 冻结包。");
    }
    return;
  }
  assertPackDispatchable(pack);
}

async function assertAnyPackCurrent(
  projectRoot: string,
  pack: AnyStudioGenerationFreezePack,
  options: { afterPaidCallIntent?: true } = {},
): Promise<AnyStudioGenerationFreezePack> {
  if (isUnitGridFreezePack(pack)) {
    await assertStudioUnitGridGenerationFreezePackCurrent(projectRoot, pack, options);
  } else {
    await assertStudioGenerationFreezePackCurrent(projectRoot, pack);
  }
  return pack;
}

function targetFingerprintForPack(pack: AnyStudioGenerationFreezePack): string {
  return stableDigest(pack.target);
}

async function readAnyPackFromRow(paths: LedgerPaths, row: PackRow): Promise<AnyStudioGenerationFreezePack> {
  const bytes = await verifyFile(
    fromProjectRelative(paths.root, row.content_relpath),
    row.content_sha256,
    Number(row.content_size_bytes),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new StudioGenerationLedgerError("pack-cas-drift", "generation pack CAS JSON 无法解析。", [], { cause: error });
  }
  const pack = parsed as AnyStudioGenerationFreezePack;
  assertAnyPackSelfIntegrity(pack);
  const db = openDatabase(paths);
  let targetRow: PackTargetRow | undefined;
  try {
    targetRow = packTargetRowById(db, row.pack_id);
  } finally {
    db.close();
  }
  if (pack.id !== row.pack_id
    || pack.fingerprint !== row.fingerprint
    || pack.projectId !== row.project_id) {
    fail("pack-cas-drift", `generation pack CAS 与 SQLite 轻量索引不一致：${row.pack_id}`);
  }
  if (isUnitGridFreezePack(pack)) {
    const firstPanel = pack.panels[0];
    if (!targetRow) {
      fail("target-extension-invalid", `unit-grid pack ${row.pack_id} 缺少同账本 target extension。`);
    }
    if (!firstPanel
      || targetRow.pack_fingerprint !== pack.fingerprint
      || targetRow.target_kind !== "unit-grid"
      || targetRow.target_key !== `unit-grid:${pack.target.unitId}`
      || targetRow.target_fingerprint !== targetFingerprintForPack(pack)
      || targetRow.unit_id !== pack.target.unitId
      || Number(targetRow.unit_revision) !== pack.target.unitRevision
      || targetRow.compatibility_panel_id !== firstPanel.panelId
      || Number(targetRow.compatibility_panel_index) !== firstPanel.panelIndex
      || Number(targetRow.panel_count) !== pack.target.panelCount
      || row.unit_id !== pack.target.unitId
      || Number(row.unit_revision) !== pack.target.unitRevision
      || row.panel_id !== firstPanel.panelId
      || Number(row.panel_index) !== firstPanel.panelIndex) {
      fail("target-extension-invalid", `unit-grid pack ${row.pack_id} 的 target extension/兼容索引不一致。`);
    }
  } else {
    if (targetRow) {
      fail("target-extension-invalid", `panel pack ${row.pack_id} 不应存在 unit-grid target extension。`);
    }
    if (pack.target.unitId !== row.unit_id
      || pack.target.unitRevision !== Number(row.unit_revision)
      || pack.target.panelId !== row.panel_id
      || pack.target.panelIndex !== Number(row.panel_index)) {
      fail("pack-cas-drift", `generation pack CAS 与 SQLite panel 索引不一致：${row.pack_id}`);
    }
  }
  return pack;
}

async function readPackFromRow(paths: LedgerPaths, row: PackRow): Promise<StudioGenerationFreezePack> {
  const pack = await readAnyPackFromRow(paths, row);
  if (isUnitGridFreezePack(pack)) {
    fail("pack-schema-unsupported", `pack ${row.pack_id} 是 unit-grid；必须使用 unit-grid 读取入口。`);
  }
  return pack;
}

export async function freezeAndPersistStudioGenerationPack(
  projectRoot: string,
  input: StudioGenerationQueryInput,
): Promise<FreezeAndPersistStudioGenerationPackResult> {
  const { paths, projectId } = await managedLedgerPaths(projectRoot);
  const pack = await buildStudioGenerationFreezePack(paths.root, input);
  // 共生环：正式 pack 必须满足最小执行纪律（非空 controlReferences 等）。
  // P20：confirmed-empty 裁决闭合的格（extension 扩写格 / 零资产格）合法没有
  // 控制参考。豁免只认账本事实——按 pack 锚定的 BindingSet 身份重读账本记录，
  // 核对指纹、目标归属与 confirmed-empty 闭合字段；不信入参或 pack 自述。
  const { assertStudioFormalGenerationPackDiscipline } = await import("./studio-generation-execution-gate.js");
  const gateBindingSet = await getStudioAssetBindingSet(paths.root, pack.assetBinding.bindingSet.id);
  const confirmedEmptyClosure = gateBindingSet !== null
    && gateBindingSet.fingerprint === pack.assetBinding.bindingSet.fingerprint
    && gateBindingSet.unitId === pack.target.unitId
    && gateBindingSet.panelIndex === pack.target.panelIndex
    && gateBindingSet.confirmedEmpty
    && typeof gateBindingSet.emptyConfirmationId === "string"
    && gateBindingSet.emptyConfirmationId.length > 0
    && typeof gateBindingSet.emptyConfirmationFingerprint === "string"
    && gateBindingSet.emptyConfirmationFingerprint.length > 0
    && gateBindingSet.bindings.length === 0;
  assertStudioFormalGenerationPackDiscipline(pack as { request?: { controlReferences?: unknown[] }; layout?: string }, { confirmedEmptyClosure });
  assertPackDispatchable(pack);
  await assertStudioGenerationFreezePackCurrent(paths.root, pack);
  if (pack.projectId !== projectId) fail("pack-index-conflict", "generation pack 不属于当前受管项目。");
  const content = await materializePackCas(paths, serializePack(pack));
  await assertStudioGenerationFreezePackCurrent(paths.root, pack);
  const db = openDatabase(paths);
  let row: PackRow;
  try {
    row = runTransaction(db, () => {
      const existing = packRowById(db, pack.id);
      if (existing) {
        if (packTargetRowById(db, pack.id)) {
          fail("pack-index-conflict", `panel packId ${pack.id} 已绑定 unit-grid target extension。`);
        }
        if (existing.fingerprint !== pack.fingerprint
          || existing.content_sha256 !== content.contentSha256
          || existing.content_relpath !== content.relativePath
          || Number(existing.content_size_bytes) !== content.contentSizeBytes
          || existing.project_id !== pack.projectId
          || existing.unit_id !== pack.target.unitId
          || Number(existing.unit_revision) !== pack.target.unitRevision
          || existing.panel_id !== pack.target.panelId
          || Number(existing.panel_index) !== pack.target.panelIndex) {
          fail("pack-index-conflict", `packId ${pack.id} 已绑定不同索引内容。`);
        }
        return existing;
      }
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO studio_generation_packs(
          pack_id, fingerprint, content_sha256, content_relpath, content_size_bytes,
          project_id, unit_id, unit_revision, panel_id, panel_index, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pack.id,
        pack.fingerprint,
        content.contentSha256,
        content.relativePath,
        content.contentSizeBytes,
        pack.projectId,
        pack.target.unitId,
        pack.target.unitRevision,
        pack.target.panelId,
        pack.target.panelIndex,
        now,
      );
      return packRowById(db, pack.id)!;
    });
  } finally {
    db.close();
  }
  await verifyFile(fromProjectRelative(paths.root, row.content_relpath), row.content_sha256, Number(row.content_size_bytes));
  return { ...packRecord(row), persisted: true, pack };
}

/**
 * P30 unit-grid 冻结持久化：旧表只保存第一格作为非公开兼容锚点；权威目标与
 * pack 行在同一事务写入 target extension，任何读取都必须同时验证两者。
 */
export async function freezeAndPersistStudioUnitGridGenerationPack(
  projectRoot: string,
  input: StudioUnitGridGenerationQueryInput,
): Promise<FreezeAndPersistStudioUnitGridGenerationPackResult> {
  return withStudioRequestSchemaCache(
    () => freezeAndPersistStudioUnitGridGenerationPackInternal(projectRoot, input),
  );
}

async function freezeAndPersistStudioUnitGridGenerationPackInternal(
  projectRoot: string,
  input: StudioUnitGridGenerationQueryInput,
): Promise<FreezeAndPersistStudioUnitGridGenerationPackResult> {
  const { paths, projectId } = await managedLedgerPaths(projectRoot);
  const pack = await buildStudioUnitGridGenerationFreezePack(paths.root, input);
  const { assertStudioFormalGenerationPackDiscipline } = await import("./studio-generation-execution-gate.js");
  assertStudioFormalGenerationPackDiscipline({
    request: {
      controlReferences: (pack as { controlReferences?: unknown[] }).controlReferences
        ?? (pack as { request?: { controlReferences?: unknown[] } }).request?.controlReferences,
      exactlyOneImage: true,
    },
    layout: "9:16-vertical-ordered-grid",
  });
  assertAnyPackDispatchable(pack);
  if (pack.projectId !== projectId) fail("pack-index-conflict", "unit-grid generation pack 不属于当前受管项目。");
  const firstPanel = pack.panels[0];
  if (!firstPanel || firstPanel.panelIndex !== 1) {
    fail("target-extension-invalid", "unit-grid generation pack 缺少合法第一格兼容锚点。");
  }
  const content = await materializePackCas(paths, serializePack(pack));
  await assertStudioUnitGridGenerationFreezePackCurrent(paths.root, pack);
  const targetKey = `unit-grid:${pack.target.unitId}`;
  const targetFingerprint = targetFingerprintForPack(pack);
  const db = openDatabase(paths);
  let row: PackRow;
  try {
    row = runTransaction(db, () => {
      const existing = packRowById(db, pack.id);
      const existingTarget = packTargetRowById(db, pack.id);
      if (existing) {
        if (existing.fingerprint !== pack.fingerprint
          || existing.content_sha256 !== content.contentSha256
          || existing.content_relpath !== content.relativePath
          || Number(existing.content_size_bytes) !== content.contentSizeBytes
          || existing.project_id !== pack.projectId
          || existing.unit_id !== pack.target.unitId
          || Number(existing.unit_revision) !== pack.target.unitRevision
          || existing.panel_id !== firstPanel.panelId
          || Number(existing.panel_index) !== firstPanel.panelIndex
          || !existingTarget
          || existingTarget.pack_fingerprint !== pack.fingerprint
          || existingTarget.target_key !== targetKey
          || existingTarget.target_fingerprint !== targetFingerprint
          || existingTarget.unit_id !== pack.target.unitId
          || Number(existingTarget.unit_revision) !== pack.target.unitRevision
          || existingTarget.compatibility_panel_id !== firstPanel.panelId
          || Number(existingTarget.compatibility_panel_index) !== firstPanel.panelIndex
          || Number(existingTarget.panel_count) !== pack.target.panelCount) {
          fail("pack-index-conflict", `unit-grid packId ${pack.id} 已绑定不同索引内容。`);
        }
        return existing;
      }
      if (existingTarget) {
        fail("pack-index-conflict", `unit-grid target extension ${pack.id} 存在孤立索引。`);
      }
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO studio_generation_packs(
          pack_id, fingerprint, content_sha256, content_relpath, content_size_bytes,
          project_id, unit_id, unit_revision, panel_id, panel_index, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pack.id,
        pack.fingerprint,
        content.contentSha256,
        content.relativePath,
        content.contentSizeBytes,
        pack.projectId,
        pack.target.unitId,
        pack.target.unitRevision,
        firstPanel.panelId,
        firstPanel.panelIndex,
        now,
      );
      db.prepare(`
        INSERT INTO studio_generation_pack_targets(
          pack_id, pack_fingerprint, target_kind, target_key, target_fingerprint,
          unit_id, unit_revision, compatibility_panel_id, compatibility_panel_index, panel_count, created_at
        ) VALUES(?, ?, 'unit-grid', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pack.id,
        pack.fingerprint,
        targetKey,
        targetFingerprint,
        pack.target.unitId,
        pack.target.unitRevision,
        firstPanel.panelId,
        firstPanel.panelIndex,
        pack.target.panelCount,
        now,
      );
      return packRowById(db, pack.id)!;
    });
  } finally {
    db.close();
  }
  await readAnyPackFromRow(paths, row);
  return {
    persisted: true,
    targetKind: "unit-grid",
    targetKey,
    packId: row.pack_id,
    fingerprint: row.fingerprint,
    contentSha256: row.content_sha256,
    contentSizeBytes: Number(row.content_size_bytes),
    projectId: row.project_id,
    unitId: row.unit_id,
    unitRevision: Number(row.unit_revision),
    panelCount: pack.target.panelCount,
    createdAt: row.created_at,
    pack,
  };
}

export async function readStudioGenerationFrozenPack(
  projectRoot: string,
  packId: string,
): Promise<StudioGenerationFreezePack | null> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const normalizedPackId = normalizeId(packId, "packId");
  const db = openDatabase(paths);
  let row: PackRow | undefined;
  try {
    row = packRowById(db, normalizedPackId);
  } finally {
    db.close();
  }
  return row ? readPackFromRow(paths, row) : null;
}

export async function readStudioUnitGridGenerationFrozenPack(
  projectRoot: string,
  packId: string,
): Promise<StudioUnitGridGenerationFreezePack | null> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const normalizedPackId = normalizeId(packId, "packId");
  const db = openDatabase(paths);
  let row: PackRow | undefined;
  try {
    row = packRowById(db, normalizedPackId);
  } finally {
    db.close();
  }
  if (!row) return null;
  const pack = await readAnyPackFromRow(paths, row);
  if (!isUnitGridFreezePack(pack)) {
    fail("pack-schema-unsupported", `pack ${normalizedPackId} 是 panel；必须使用 panel 读取入口。`);
  }
  return pack;
}

/**
 * target-aware 通用读取入口。调用方需要同时处理 panel 与 unit-grid 时必须使用本入口，
 * 避免把 unit-grid 在旧表中的兼容 panel 列误当成正式目标。
 */
export async function readAnyStudioGenerationFrozenPack(
  projectRoot: string,
  packId: string,
): Promise<AnyStudioGenerationFreezePack | null> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const normalizedPackId = normalizeId(packId, "packId");
  const db = openDatabase(paths);
  let row: PackRow | undefined;
  try {
    row = packRowById(db, normalizedPackId);
  } finally {
    db.close();
  }
  return row ? readAnyPackFromRow(paths, row) : null;
}

function normalizedHistoricalText(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) fail("invalid-input", `${field} 不能为空。`);
  const normalized = value.normalize("NFC").trim();
  if (normalized.length > maxLength || /\p{Cc}/u.test(normalized)) fail("invalid-input", `${field} 格式无效。`);
  return normalized;
}

function historicalEvidenceSemantic(input: {
  packId: string;
  packFingerprint: string;
  targetKey: string;
  unitId: string;
  unitRevision: number;
  rawMediaSha256: string;
  labeledMediaSha256: string;
  sourceRawSha256: string;
  sourceLabeledSha256: string;
  sourceManifestFingerprint: string;
  qcEvidenceReference: string;
  qcEvidenceSha256: string;
  externalStoryboardStatus: string;
}) {
  return {
    schemaVersion: 1 as const,
    provenance: "historical-import" as const,
    ...input,
    review: {
      provenance: "external-qc-import" as const,
      decision: "pass" as const,
      evidenceReference: input.qcEvidenceReference,
      evidenceSha256: input.qcEvidenceSha256,
      externalStoryboardStatus: input.externalStoryboardStatus,
    },
    generationCallCount: 0 as const,
  };
}

function historicalEvidenceRecord(row: HistoricalImportRow): StudioHistoricalGenerationEvidenceRecord {
  const semantic = historicalEvidenceSemantic({
    packId: row.pack_id,
    packFingerprint: row.pack_fingerprint,
    targetKey: row.target_key,
    unitId: row.unit_id,
    unitRevision: Number(row.unit_revision),
    rawMediaSha256: row.raw_media_sha256,
    labeledMediaSha256: row.labeled_media_sha256,
    sourceRawSha256: row.source_raw_sha256,
    sourceLabeledSha256: row.source_labeled_sha256,
    sourceManifestFingerprint: row.source_manifest_fingerprint,
    qcEvidenceReference: row.qc_evidence_reference,
    qcEvidenceSha256: row.qc_evidence_sha256,
    externalStoryboardStatus: row.external_storyboard_status,
  });
  const fingerprint = stableDigest(semantic);
  const importId = `studio-historical-import-${fingerprint.slice(0, 40)}`;
  if (row.target_kind !== "unit-grid" || row.fingerprint !== fingerprint || row.import_id !== importId) {
    fail("storage-invalid", `historical import 身份漂移：${row.import_id}`);
  }
  return {
    schemaVersion: 1,
    kind: "studio-historical-generation-evidence",
    provenance: "historical-import",
    importId,
    packId: row.pack_id,
    packFingerprint: row.pack_fingerprint,
    targetKind: "unit-grid",
    targetKey: row.target_key,
    unitId: row.unit_id,
    unitRevision: Number(row.unit_revision),
    generationRunId: null,
    provider: null,
    callId: null,
    generationCallCount: 0,
    raw: {
      resultId: `${importId}:raw`,
      mediaSha256: row.raw_media_sha256,
      sourceSha256: row.source_raw_sha256,
      status: "approved",
    },
    labeled: {
      resultId: `${importId}:labeled`,
      mediaSha256: row.labeled_media_sha256,
      sourceSha256: row.source_labeled_sha256,
      status: "approved",
    },
    review: semantic.review,
    sourceManifestFingerprint: row.source_manifest_fingerprint,
    createdAt: row.created_at,
    fingerprint,
  };
}

export async function importStudioHistoricalGenerationEvidence(
  projectRoot: string,
  input: ImportStudioHistoricalGenerationEvidenceInput,
): Promise<StudioHistoricalGenerationEvidenceRecord> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const packId = normalizeId(input.packId, "packId");
  const packFingerprint = normalizeSha256(input.packFingerprint, "packFingerprint");
  const rawMediaSha256 = normalizeSha256(input.rawMediaSha256, "rawMediaSha256");
  const labeledMediaSha256 = normalizeSha256(input.labeledMediaSha256, "labeledMediaSha256");
  const sourceRawSha256 = normalizeSha256(input.sourceRawSha256, "sourceRawSha256");
  const sourceLabeledSha256 = normalizeSha256(input.sourceLabeledSha256, "sourceLabeledSha256");
  const sourceManifestFingerprint = normalizeSha256(input.sourceManifestFingerprint, "sourceManifestFingerprint");
  const qcEvidenceSha256 = normalizeSha256(input.qcEvidenceSha256, "qcEvidenceSha256");
  const qcEvidenceReference = normalizedHistoricalText(input.qcEvidenceReference, "qcEvidenceReference", 4_096);
  const externalStoryboardStatus = normalizedHistoricalText(input.externalStoryboardStatus, "externalStoryboardStatus", 100);
  if (!/^PASS(?:_WITH_P2)?$/u.test(externalStoryboardStatus)) {
    fail("invalid-input", "historical import 只接受外部机械状态中的 PASS/PASS_WITH_P2。 ");
  }
  if (rawMediaSha256 !== sourceRawSha256 || labeledMediaSha256 !== sourceLabeledSha256) {
    fail("historical-import-conflict", "historical import 必须保留源 raw/labeled 原字节 SHA，禁止转码后冒充原证据。 ");
  }
  const pack = await readAnyStudioGenerationFrozenPack(paths.root, packId);
  if (!pack || !isUnitGridFreezePack(pack) || pack.fingerprint !== packFingerprint) {
    fail("historical-import-conflict", `historical import 只能绑定精确 unit-grid pack：${packId}`);
  }
  await assertAnyPackCurrent(paths.root, pack);
  const mediaValid = await Promise.all([
    getStudioMedia(paths.root, rawMediaSha256),
    getStudioMedia(paths.root, labeledMediaSha256),
    verifyStudioMediaObject(paths.root, rawMediaSha256),
    verifyStudioMediaObject(paths.root, labeledMediaSha256),
  ]);
  if (!mediaValid[0] || !mediaValid[1] || !mediaValid[2] || !mediaValid[3]) {
    fail("result-media-invalid", "historical import 的 raw/labeled 未进入当前受管工程 CAS 或字节已漂移。 ");
  }
  const targetKey = `unit-grid:${pack.target.unitId}`;
  const semantic = historicalEvidenceSemantic({
    packId,
    packFingerprint,
    targetKey,
    unitId: pack.target.unitId,
    unitRevision: pack.target.unitRevision,
    rawMediaSha256,
    labeledMediaSha256,
    sourceRawSha256,
    sourceLabeledSha256,
    sourceManifestFingerprint,
    qcEvidenceReference,
    qcEvidenceSha256,
    externalStoryboardStatus,
  });
  const fingerprint = stableDigest(semantic);
  const importId = `studio-historical-import-${fingerprint.slice(0, 40)}`;
  const db = openDatabase(paths);
  try {
    return runTransaction(db, () => {
      assertDetachedCandidateShaNotReused(db, rawMediaSha256);
      assertDetachedCandidateShaNotReused(db, labeledMediaSha256);
      const existingByPack = db.prepare(`SELECT * FROM studio_generation_historical_imports
        WHERE pack_id = ? AND pack_fingerprint = ?`).get(packId, packFingerprint) as unknown as HistoricalImportRow | undefined;
      const existingById = db.prepare("SELECT * FROM studio_generation_historical_imports WHERE import_id = ?")
        .get(importId) as unknown as HistoricalImportRow | undefined;
      if (existingByPack || existingById) {
        const existing = historicalEvidenceRecord(existingByPack ?? existingById!);
        if (existing.importId !== importId || existing.fingerprint !== fingerprint) {
          fail("historical-import-conflict", `unit-grid pack ${packId} 已绑定其他历史证据，禁止覆盖。`);
        }
        return existing;
      }
      const existingDispatch = db.prepare(`SELECT generation_run_id AS generationRunId
        FROM studio_generation_dispatches
        WHERE pack_id = ? AND pack_fingerprint = ?
        ORDER BY sequence LIMIT 1`).get(packId, packFingerprint) as { generationRunId?: string } | undefined;
      if (existingDispatch?.generationRunId) {
        fail(
          "historical-import-conflict",
          `unit-grid pack ${packId} 已存在真实 dispatch ${existingDispatch.generationRunId}，禁止伪装成零调用历史证据。`,
        );
      }
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO studio_generation_historical_imports(
        import_id, pack_id, pack_fingerprint, target_kind, target_key, unit_id, unit_revision,
        raw_media_sha256, labeled_media_sha256, source_raw_sha256, source_labeled_sha256,
        source_manifest_fingerprint, qc_evidence_reference, qc_evidence_sha256,
        external_storyboard_status, fingerprint, created_at
      ) VALUES(?, ?, ?, 'unit-grid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        importId, packId, packFingerprint, targetKey, pack.target.unitId, pack.target.unitRevision,
        rawMediaSha256, labeledMediaSha256, sourceRawSha256, sourceLabeledSha256,
        sourceManifestFingerprint, qcEvidenceReference, qcEvidenceSha256,
        externalStoryboardStatus, fingerprint, now,
      );
      return historicalEvidenceRecord(db.prepare("SELECT * FROM studio_generation_historical_imports WHERE import_id = ?")
        .get(importId) as unknown as HistoricalImportRow);
    });
  } finally {
    db.close();
  }
}

export async function readStudioHistoricalGenerationEvidenceByPack(
  projectRoot: string,
  packId: string,
): Promise<StudioHistoricalGenerationEvidenceRecord | null> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const normalizedPackId = normalizeId(packId, "packId");
  const db = openDatabase(paths);
  try {
    const row = db.prepare("SELECT * FROM studio_generation_historical_imports WHERE pack_id = ?")
      .get(normalizedPackId) as unknown as HistoricalImportRow | undefined;
    if (!row) return null;
    const record = historicalEvidenceRecord(row);
    if (!await verifyStudioMediaObject(paths.root, record.raw.mediaSha256)
      || !await verifyStudioMediaObject(paths.root, record.labeled.mediaSha256)) {
      fail("result-media-drift", `historical import ${record.importId} 的媒体 CAS 已漂移。`);
    }
    return record;
  } finally {
    db.close();
  }
}

/**
 * 按 unit-grid owner 读取最新一份历史 PASS。用于画布时间线只读投影；
 * 不把零调用历史证据伪装成 generation result，也不返回任何本地路径。
 */
export async function readStudioHistoricalGenerationEvidenceByUnit(
  projectRoot: string,
  unitId: string,
): Promise<StudioHistoricalGenerationEvidenceRecord | null> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const normalizedUnitId = normalizeId(unitId, "unitId");
  const targetKey = `unit-grid:${normalizedUnitId}`;
  const db = openDatabase(paths);
  try {
    const row = db.prepare(`SELECT * FROM studio_generation_historical_imports
      WHERE target_kind = 'unit-grid' AND target_key = ? AND unit_id = ?
      ORDER BY sequence DESC LIMIT 1`)
      .get(targetKey, normalizedUnitId) as unknown as HistoricalImportRow | undefined;
    if (!row) return null;
    const record = historicalEvidenceRecord(row);
    if (!await verifyStudioMediaObject(paths.root, record.raw.mediaSha256)
      || !await verifyStudioMediaObject(paths.root, record.labeled.mediaSha256)) {
      fail("result-media-drift", `historical import ${record.importId} 的媒体 CAS 已漂移。`);
    }
    return record;
  } finally {
    db.close();
  }
}

export async function recordStudioDetachedGenerationUnknownObservation(
  projectRoot: string,
  input: RecordStudioDetachedGenerationUnknownInput,
): Promise<StudioDetachedGenerationUnknownObservation> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const unitId = normalizeId(input.unitId, "unitId");
  if (!Number.isSafeInteger(input.unitRevision) || input.unitRevision < 1) {
    fail("invalid-input", "unitRevision 必须是正整数。");
  }
  const unitFingerprint = normalizeSha256(input.unitFingerprint, "unitFingerprint");
  const sourceTaskId = normalizeId(input.sourceTaskId, "sourceTaskId");
  const evidenceReference = normalizeEvidenceReference(input.evidenceReference, "evidenceReference");
  const evidenceFingerprint = normalizeSha256(input.evidenceFingerprint, "evidenceFingerprint");
  const candidateSha256 = input.candidateSha256 === undefined
    ? null
    : normalizeSha256(input.candidateSha256, "candidateSha256");
  const candidateNumbers = [input.candidateSizeBytes, input.candidateWidth, input.candidateHeight];
  if ((candidateSha256 === null) !== candidateNumbers.every((value) => value === undefined)) {
    fail("invalid-input", "候选 SHA、字节数、宽和高必须同时提供或同时省略。");
  }
  const normalizedNumbers = candidateNumbers.map((value, index) => {
    if (value === undefined) return null;
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail("invalid-input", ["candidateSizeBytes", "candidateWidth", "candidateHeight"][index] + " 必须是正整数。");
    }
    return value;
  }) as [number | null, number | null, number | null];
  const [candidateSizeBytes, candidateWidth, candidateHeight] = normalizedNumbers;
  const note = input.note === undefined ? "" : input.note.normalize("NFC").trim();
  if (note.length > 4_000 || /\p{Cc}/u.test(note)) fail("invalid-input", "note 格式无效。");
  const snapshot = await getStudioProductionUnitSnapshot(paths.root, unitId);
  if (!snapshot || snapshot.unit.revision !== input.unitRevision || snapshot.fingerprint !== unitFingerprint) {
    fail("generation-unknown", `detached observation 的 unit 身份与当前 Studio 不一致：${unitId}`);
  }
  const targetKey = `unit-grid:${unitId}`;
  const semantic = detachedUnknownSemantic({
    targetKey,
    unitId,
    unitRevision: input.unitRevision,
    unitFingerprint,
    sourceTaskId,
    evidenceReference,
    evidenceFingerprint,
    candidateSha256,
    candidateSizeBytes,
    candidateWidth,
    candidateHeight,
    note,
  });
  const fingerprint = stableDigest(semantic);
  const observationId = `studio-detached-unknown-${fingerprint.slice(0, 40)}`;
  const db = openDatabase(paths);
  try {
    return runTransaction(db, () => {
      const existing = db.prepare(`SELECT * FROM studio_generation_detached_unknown_observations
        WHERE observation_id = ? OR (target_kind = 'unit-grid' AND target_key = ? AND source_task_id = ?)
        ORDER BY sequence LIMIT 1`).get(observationId, targetKey, sourceTaskId) as unknown as DetachedUnknownObservationRow | undefined;
      if (existing) {
        const record = detachedUnknownRecord(existing);
        if (record.observationId !== observationId || record.fingerprint !== fingerprint) {
          fail("generation-unknown", `sourceTaskId=${sourceTaskId} 已绑定不同 detached unknown observation，禁止覆盖。`);
        }
        return record;
      }
      const createdAt = new Date().toISOString();
      db.prepare(`INSERT INTO studio_generation_detached_unknown_observations(
        observation_id, target_kind, target_key, unit_id, unit_revision, unit_fingerprint,
        source_task_id, status, evidence_reference, evidence_fingerprint,
        candidate_sha256, candidate_size_bytes, candidate_width, candidate_height,
        note, fingerprint, created_at
      ) VALUES(?, 'unit-grid', ?, ?, ?, ?, ?, 'generation_unknown', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        observationId, targetKey, unitId, input.unitRevision, unitFingerprint,
        sourceTaskId, evidenceReference, evidenceFingerprint,
        candidateSha256, candidateSizeBytes, candidateWidth, candidateHeight,
        note, fingerprint, createdAt,
      );
      return detachedUnknownRecord(db.prepare(`SELECT * FROM studio_generation_detached_unknown_observations
        WHERE observation_id = ?`).get(observationId) as unknown as DetachedUnknownObservationRow);
    });
  } finally {
    db.close();
  }
}

export async function listStudioDetachedGenerationUnknownObservations(
  projectRoot: string,
  query: { unitId?: string } = {},
): Promise<StudioDetachedGenerationUnknownObservation[]> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const unitId = query.unitId === undefined ? undefined : normalizeId(query.unitId, "unitId");
  const db = openDatabase(paths);
  try {
    const rows = (unitId === undefined
      ? db.prepare("SELECT * FROM studio_generation_detached_unknown_observations ORDER BY sequence LIMIT 101").all()
      : db.prepare(`SELECT * FROM studio_generation_detached_unknown_observations
          WHERE unit_id = ? ORDER BY sequence LIMIT 101`).all(unitId)) as unknown as DetachedUnknownObservationRow[];
    if (rows.length > 100) fail("storage-invalid", "detached unknown observations 超过有界读取上限 100，必须先增加分页合同。");
    return rows.map(detachedUnknownRecord);
  } finally {
    db.close();
  }
}

export async function readStudioDetachedGenerationUnknownDisposition(
  projectRoot: string,
  observationIdValue: string,
): Promise<StudioDetachedGenerationUnknownDisposition | null> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const observationId = normalizeId(observationIdValue, "observationId");
  const db = openDatabase(paths);
  try {
    const observationRow = db.prepare(`
      SELECT * FROM studio_generation_detached_unknown_observations WHERE observation_id = ?
    `).get(observationId) as unknown as DetachedUnknownObservationRow | undefined;
    if (!observationRow) return null;
    const dispositionRow = db.prepare(`
      SELECT * FROM studio_generation_detached_unknown_dispositions WHERE observation_id = ?
    `).get(observationId) as unknown as DetachedUnknownDispositionRow | undefined;
    return dispositionRow
      ? detachedUnknownDispositionRecord(dispositionRow, detachedUnknownRecord(observationRow), true)
      : null;
  } finally {
    db.close();
  }
}

export async function listStudioDetachedGenerationUnknownDispositions(
  projectRoot: string,
  query: { unitId?: string } = {},
): Promise<StudioDetachedGenerationUnknownDisposition[]> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const unitId = query.unitId === undefined ? undefined : normalizeId(query.unitId, "unitId");
  const db = openDatabase(paths);
  try {
    const rows = (unitId === undefined
      ? db.prepare(`SELECT * FROM studio_generation_detached_unknown_dispositions
          ORDER BY sequence LIMIT 101`).all()
      : db.prepare(`SELECT * FROM studio_generation_detached_unknown_dispositions
          WHERE unit_id = ? ORDER BY sequence LIMIT 101`).all(unitId)) as unknown as DetachedUnknownDispositionRow[];
    if (rows.length > 100) fail("storage-invalid", "detached dispositions 超过有界读取上限 100。");
    return rows.map((row) => {
      const observationRow = db.prepare(`
        SELECT * FROM studio_generation_detached_unknown_observations WHERE observation_id = ?
      `).get(row.observation_id) as unknown as DetachedUnknownObservationRow | undefined;
      if (!observationRow) fail("storage-invalid", `detached disposition observation 缺失：${row.disposition_id}`);
      return detachedUnknownDispositionRecord(row, detachedUnknownRecord(observationRow), true);
    });
  } finally {
    db.close();
  }
}

export async function listStudioActiveDetachedGenerationUnknownObservations(
  projectRoot: string,
  query: { unitId?: string } = {},
): Promise<StudioDetachedGenerationUnknownObservation[]> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const unitId = query.unitId === undefined ? undefined : normalizeId(query.unitId, "unitId");
  const db = openDatabase(paths);
  try {
    const rows = (unitId === undefined
      ? db.prepare(`
          SELECT observation.* FROM studio_generation_detached_unknown_observations observation
          LEFT JOIN studio_generation_detached_unknown_dispositions disposition
            ON disposition.observation_id = observation.observation_id
          WHERE disposition.observation_id IS NULL
          ORDER BY observation.sequence LIMIT 101
        `).all()
      : db.prepare(`
          SELECT observation.* FROM studio_generation_detached_unknown_observations observation
          LEFT JOIN studio_generation_detached_unknown_dispositions disposition
            ON disposition.observation_id = observation.observation_id
          WHERE observation.unit_id = ? AND disposition.observation_id IS NULL
          ORDER BY observation.sequence LIMIT 101
        `).all(unitId)) as unknown as DetachedUnknownObservationRow[];
    if (rows.length > 100) fail("storage-invalid", "active detached unknown observations 超过有界读取上限 100。");
    return rows.map(detachedUnknownRecord);
  } finally {
    db.close();
  }
}

const MAX_DETACHED_UNKNOWN_UNIT_STATE_BATCH = 216;

/**
 * 画布/控制页的有界批量阻断投影。只返回每个单元是否仍有未处置观察，
 * 单次打开 ledger DB，避免 216 个单元退化为 216 IPC + 432 次 DB open。
 */
export async function getStudioDetachedGenerationUnknownUnitStates(
  projectRoot: string,
  query: { unitIds: readonly string[] },
): Promise<Record<string, "clear" | "blocked">> {
  const unitIds = [...new Set(query.unitIds.map((unitId) => normalizeId(unitId, "unitId")))]
    .sort((left, right) => left.localeCompare(right, "en"));
  if (unitIds.length > MAX_DETACHED_UNKNOWN_UNIT_STATE_BATCH) {
    fail(
      "invalid-input",
      `detached unknown unit states 超过有界读取上限 ${MAX_DETACHED_UNKNOWN_UNIT_STATE_BATCH}。`,
    );
  }
  if (!unitIds.length) return {};
  const { paths } = await managedLedgerPaths(projectRoot);
  const placeholders = unitIds.map(() => "?").join(", ");
  const db = openDatabase(paths);
  try {
    const rows = db.prepare(`
      SELECT DISTINCT observation.unit_id AS unit_id
      FROM studio_generation_detached_unknown_observations observation
      LEFT JOIN studio_generation_detached_unknown_dispositions disposition
        ON disposition.observation_id = observation.observation_id
      WHERE disposition.observation_id IS NULL
        AND observation.unit_id IN (${placeholders})
    `).all(...unitIds) as unknown as Array<{ unit_id: string }>;
    const blocked = new Set(rows.map((row) => row.unit_id));
    return Object.fromEntries(unitIds.map((unitId) => [
      unitId,
      blocked.has(unitId) ? "blocked" as const : "clear" as const,
    ]));
  } finally {
    db.close();
  }
}

export async function abandonStudioDetachedGenerationUnknown(
  projectRoot: string,
  input: AbandonStudioDetachedGenerationUnknownInput,
): Promise<StudioDetachedGenerationUnknownDisposition> {
  const { paths, projectId } = await managedLedgerPaths(projectRoot);
  const observationId = normalizeId(input.observationId, "observationId");
  const expectedObservationFingerprint = normalizeSha256(
    input.expectedObservationFingerprint,
    "expectedObservationFingerprint",
  );
  const projectContextToken = normalizeEvidenceReference(input.projectContextToken, "projectContextToken");
  if (!/^studioctx-v1-[a-f0-9]{64}$/u.test(projectContextToken)) {
    fail("invalid-input", "projectContextToken 格式无效。");
  }
  const authorizationEvidenceReference = normalizeEvidenceReference(
    input.authorizationEvidenceReference,
    "authorizationEvidenceReference",
  );
  const authorizationText = typeof input.authorizationText === "string" ? input.authorizationText : "";
  if (authorizationText.length < 8 || authorizationText.length > 4_000 || /\p{Cc}/u.test(authorizationText)) {
    fail("invalid-input", "authorizationText 必须是 8-4000 字符的用户原文且不含控制字符。");
  }
  const authorizationTextSha256 = normalizeSha256(
    input.authorizationTextSha256,
    "authorizationTextSha256",
  );
  if (authorizationTextSha256 !== createHash("sha256").update(authorizationText, "utf8").digest("hex")) {
    fail("invalid-input", "authorizationTextSha256 与用户授权原文不匹配。");
  }
  const reason = typeof input.reason === "string" ? input.reason.normalize("NFC").trim() : "";
  if (reason.length < 8 || reason.length > 500 || /\p{Cc}/u.test(reason)) {
    fail("invalid-input", "reason 必须是 8-500 字符且不含控制字符。");
  }
  if (input.acknowledgeRemoteGenerationMayExist !== true
    || input.acknowledgeDetachedCandidateWillNeverBeImportedOrReused !== true
    || input.acknowledgeFreshFormalRunMayDuplicateRemoteGeneration !== true) {
    fail(
      "invalid-input",
      "放弃 detached generation_unknown 必须确认远端可能已生成、旧候选永不复用且新正式 run 可能重复调用。",
    );
  }
  const activeProjectId = normalizeId(input.activeContext.projectId, "activeContext.projectId");
  const manifestFingerprint = normalizeSha256(
    input.activeContext.manifestFingerprint,
    "activeContext.manifestFingerprint",
  );
  const buildId = normalizeId(input.activeContext.buildId, "activeContext.buildId");
  const sourceDigest = normalizeSha256(input.activeContext.sourceDigest, "activeContext.sourceDigest");
  if (activeProjectId !== projectId) {
    fail("generation-unknown", "detached disposition 的活动工程身份与受管工程不一致。");
  }

  const writeDb = openDatabase(paths);
  try {
    return runTransaction(writeDb, () => {
      const observationRow = writeDb.prepare(`
        SELECT * FROM studio_generation_detached_unknown_observations WHERE observation_id = ?
      `).get(observationId) as unknown as DetachedUnknownObservationRow | undefined;
      if (!observationRow) fail("generation-unknown", `detached observation 不存在：${observationId}`);
      const observation = detachedUnknownRecord(observationRow);
      if (observation.fingerprint !== expectedObservationFingerprint) {
        fail("generation-unknown", `detached observation fingerprint 已漂移：${observationId}`);
      }
      const semantic = detachedUnknownDispositionSemantic({
        observation,
        authorizationEvidenceReference,
        authorizationTextSha256,
        reason,
        projectContext: {
          projectId: activeProjectId,
          manifestFingerprint,
          contextTokenHash: studioImagegenContextTokenHash(projectContextToken),
          buildId,
          sourceDigest,
        },
      });
      const fingerprint = stableDigest(semantic);
      const dispositionId = `studio-detached-disposition-${fingerprint.slice(0, 40)}`;
      const existing = writeDb.prepare(`
        SELECT * FROM studio_generation_detached_unknown_dispositions WHERE observation_id = ?
      `).get(observationId) as unknown as DetachedUnknownDispositionRow | undefined;
      if (existing) {
        const record = detachedUnknownDispositionRecord(existing, observation, true);
        if (record.fingerprint !== fingerprint) {
          fail("generation-unknown", `detached observation ${observationId} 已用其他授权处置，禁止改写。`);
        }
        return record;
      }
      const activeRuns = writeDb.prepare(`
        SELECT dispatch.generation_run_id AS generationRunId
        FROM studio_generation_dispatches dispatch
        JOIN studio_generation_pack_targets target
          ON target.pack_id = dispatch.pack_id AND target.pack_fingerprint = dispatch.pack_fingerprint
        WHERE target.target_key = ?
        ORDER BY dispatch.sequence
      `).all(observation.targetKey) as Array<{ generationRunId: string }>;
      const nonterminal = activeRuns.find((entry) => runTerminalState(writeDb, entry.generationRunId) === null);
      if (nonterminal) {
        fail(
          "generation-unknown",
          "detached observation 与既有非终态正式 run 并存，必须先对账，禁止 owner-abandon。",
          [`generationRunId=${nonterminal.generationRunId}`],
        );
      }
      const createdAt = new Date().toISOString();
      writeDb.prepare(`
        INSERT INTO studio_generation_detached_unknown_dispositions(
          disposition_id, observation_id, observation_fingerprint,
          target_kind, target_key, unit_id, unit_revision, unit_fingerprint, source_task_id,
          status, remote_invocation, detached_candidate_policy, next_run_policy,
          authorization_evidence_reference, authorization_text_sha256, reason,
          project_id, manifest_fingerprint, context_token_hash, build_id, source_digest,
          fingerprint, created_at
        ) VALUES(
          ?, ?, ?,
          'unit-grid', ?, ?, ?, ?, ?,
          'owner-abandoned', 'unknown-may-exist', 'never-import-or-reuse', 'fresh-formal-run-only',
          ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?
        )
      `).run(
        dispositionId, observation.observationId, observation.fingerprint,
        observation.targetKey, observation.unitId, observation.unitRevision,
        observation.unitFingerprint, observation.sourceTaskId,
        authorizationEvidenceReference, authorizationTextSha256, reason,
        activeProjectId, manifestFingerprint, studioImagegenContextTokenHash(projectContextToken),
        buildId, sourceDigest,
        fingerprint, createdAt,
      );
      const inserted = writeDb.prepare(`
        SELECT * FROM studio_generation_detached_unknown_dispositions WHERE disposition_id = ?
      `).get(dispositionId) as unknown as DetachedUnknownDispositionRow;
      return detachedUnknownDispositionRecord(inserted, observation, false);
    });
  } finally {
    writeDb.close();
  }
}

/** 同义读取入口，便于适配层表达“已持久冻结包”。 */
export async function readPersistedStudioGenerationPack(
  projectRoot: string,
  packId: string,
): Promise<StudioGenerationFreezePack | null> {
  return readStudioGenerationFrozenPack(projectRoot, packId);
}

function dispatchRowByRun(db: DatabaseSync, generationRunId: string): DispatchRow | undefined {
  return db.prepare("SELECT * FROM studio_generation_dispatches WHERE generation_run_id = ?")
    .get(generationRunId) as unknown as DispatchRow | undefined;
}

interface PlanRow {
  sequence: number;
  plan_id: string;
  project_id: string;
  source_command_request_id: string;
  node_count: number;
  created_at: string;
}

interface PlanNodeRow {
  sequence: number;
  plan_id: string;
  node_index: number;
  unit_id: string;
  panel_id: string;
  pack_id: string;
  pack_fingerprint: string;
  created_at: string;
}

interface PlanNodeTargetRow {
  plan_id: string;
  node_index: number;
  target_kind: "unit-grid";
  target_key: string;
  target_fingerprint: string;
  unit_id: string;
  unit_revision: number;
  created_at: string;
}

export type StudioGenerationRunEventKind = "dispatched" | "failed" | "cancel-requested" | "cancelled" | "retry-superseded";

interface RunEventRow {
  sequence: number;
  event_id: string;
  generation_run_id: string;
  plan_id: string | null;
  node_index: number | null;
  kind: StudioGenerationRunEventKind;
  attempt: number;
  supersedes_run_id: string | null;
  detail_json: string;
  created_at: string;
}

/** plan 推导 runId：`<planId64hex>:node:<nodeIndex>:attempt:<n>`。 */
const PLAN_RUN_ID_PATTERN = /^([a-f0-9]{64}):node:([0-9]+):attempt:([0-9]+)$/u;

function planRunIdFor(planId: string, nodeIndex: number, attempt: number): string {
  return `${planId}:node:${nodeIndex}:attempt:${attempt}`;
}

function parsePlanRunId(generationRunId: string): { planId: string; nodeIndex: number; attempt: number } | null {
  const match = PLAN_RUN_ID_PATTERN.exec(generationRunId);
  if (!match) return null;
  return { planId: match[1]!, nodeIndex: Number(match[2]), attempt: Number(match[3]) };
}

function planRowById(db: DatabaseSync, planId: string): PlanRow | undefined {
  return db.prepare("SELECT * FROM studio_generation_plans WHERE plan_id = ?")
    .get(planId) as unknown as PlanRow | undefined;
}

function planNodesByPlan(db: DatabaseSync, planId: string): PlanNodeRow[] {
  return db.prepare("SELECT * FROM studio_generation_plan_nodes WHERE plan_id = ? ORDER BY node_index")
    .all(planId) as unknown as PlanNodeRow[];
}

function planNodesByPack(db: DatabaseSync, packId: string, packFingerprint: string): PlanNodeRow[] {
  return db.prepare(`SELECT * FROM studio_generation_plan_nodes
    WHERE pack_id = ? AND pack_fingerprint = ? ORDER BY sequence`)
    .all(packId, packFingerprint) as unknown as PlanNodeRow[];
}

function planNodeTargetRow(
  db: DatabaseSync,
  planId: string,
  nodeIndex: number,
): PlanNodeTargetRow | undefined {
  return db.prepare(`SELECT * FROM studio_generation_plan_node_targets
    WHERE plan_id = ? AND node_index = ?`)
    .get(planId, nodeIndex) as unknown as PlanNodeTargetRow | undefined;
}

function latestRunEvent(db: DatabaseSync, generationRunId: string): RunEventRow | undefined {
  return db.prepare(`SELECT * FROM studio_generation_run_events
    WHERE generation_run_id = ? ORDER BY sequence DESC LIMIT 1`)
    .get(generationRunId) as unknown as RunEventRow | undefined;
}

/** 节点当前应派发的 attempt：该 (plan,node) dispatched 事件的最大 attempt，无则 1。 */
function planNodeExpectedAttempt(db: DatabaseSync, planId: string, nodeIndex: number): number {
  const row = db.prepare(`SELECT MAX(attempt) AS maxAttempt FROM studio_generation_run_events
    WHERE plan_id = ? AND node_index = ? AND kind = 'dispatched'`)
    .get(planId, nodeIndex) as { maxAttempt: number | null } | undefined;
  return row?.maxAttempt ? Number(row.maxAttempt) : 1;
}

function insertRunEvent(db: DatabaseSync, input: {
  generationRunId: string;
  planId: string | null;
  nodeIndex: number | null;
  kind: StudioGenerationRunEventKind;
  attempt: number;
  supersedesRunId?: string | null;
  detail: unknown;
  now: string;
}): RunEventRow {
  const eventId = `studio-generation-run-event-${stableDigest({
    schemaVersion: 1,
    generationRunId: input.generationRunId,
    kind: input.kind,
    attempt: input.attempt,
    supersedesRunId: input.supersedesRunId ?? null,
    detail: input.detail,
  }).slice(0, 40)}`;
  db.prepare(`
    INSERT INTO studio_generation_run_events(
      event_id, generation_run_id, plan_id, node_index, kind, attempt, supersedes_run_id, detail_json, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    input.generationRunId,
    input.planId,
    input.nodeIndex,
    input.kind,
    input.attempt,
    input.supersedesRunId ?? null,
    JSON.stringify(input.detail ?? {}),
    input.now,
  );
  return db.prepare("SELECT * FROM studio_generation_run_events WHERE event_id = ?")
    .get(eventId) as unknown as RunEventRow;
}

/** run 终态：succeeded（raw+labeled 成对）/failed/cancelled/retry-superseded；在途返回 null。
 * raw 单边结果不视为终态：否则 Agent 在 raw 与 labeled 之间死亡会把 run 永久锁死
 * （投影 dispatched 但取消/失败/重试全封死，属合同禁止的幽灵态）。 */
function runTerminalState(db: DatabaseSync, generationRunId: string): "succeeded" | "failed" | "cancelled" | "retry-superseded" | null {
  const raw = resultRowByRunVariant(db, generationRunId, "raw");
  const labeled = resultRowByRunVariant(db, generationRunId, "labeled");
  if (raw && labeled) return "succeeded";
  const latest = latestRunEvent(db, generationRunId);
  if (!latest || latest.kind === "dispatched" || latest.kind === "cancel-requested") return null;
  return latest.kind;
}

/**
 * 结果写入终态闸。精确的既有结果幂等重放由调用方在本函数之前返回；除此之外，
 * failed / cancelled / retry-superseded 都是不可逆事实，晚到结果不得把旧 attempt 复活。
 */
function assertRunAcceptsNewResult(db: DatabaseSync, generationRunId: string): void {
  const cancelled = db.prepare(`SELECT 1 AS found FROM studio_generation_run_events
    WHERE generation_run_id = ? AND kind = 'cancelled' LIMIT 1`).get(generationRunId);
  if (cancelled) {
    fail("run-cancelled", `generationRunId=${generationRunId} 已取消，拒绝登记新结果；请以新 generationRunId 重新派发。`);
  }
  const terminal = db.prepare(`SELECT kind FROM studio_generation_run_events
    WHERE generation_run_id = ? AND kind IN ('failed', 'retry-superseded')
    ORDER BY sequence DESC LIMIT 1`).get(generationRunId) as { kind?: "failed" | "retry-superseded" } | undefined;
  if (terminal?.kind) {
    fail("run-terminal", `generationRunId=${generationRunId} 已进入 ${terminal.kind} 终态，拒绝登记晚到结果；请使用当前 attempt。`);
  }
}

/** panel 互斥闸：同 (unitId,panelId) 存在非终态 run 时拒绝，detail 含 blocking runId/status。 */
function assertPanelNotInFlight(db: DatabaseSync, input: { unitId: string; panelId: string; excludeRunId: string }): void {
  const rows = db.prepare(`
    SELECT d.generation_run_id AS generationRunId FROM studio_generation_dispatches d
    JOIN studio_generation_packs p ON p.pack_id = d.pack_id AND p.fingerprint = d.pack_fingerprint
    LEFT JOIN studio_generation_pack_targets t
      ON t.pack_id = p.pack_id AND t.pack_fingerprint = p.fingerprint
    WHERE t.pack_id IS NULL AND p.unit_id = ? AND p.panel_id = ? AND d.generation_run_id != ?
    ORDER BY d.sequence
  `).all(input.unitId, input.panelId, input.excludeRunId) as Array<{ generationRunId: string }>;
  for (const row of rows) {
    if (runTerminalState(db, row.generationRunId) !== null) continue;
    fail(
      "panel-run-in-flight",
      `(unitId=${input.unitId}, panelId=${input.panelId}) 已存在非终态 generation run，禁止重复派发；可取消后重试。`,
      [`blockingGenerationRunId=${row.generationRunId}`, "blockingStatus=dispatched"],
    );
  }
}

/** unit-grid 互斥闸：兼容 panel 锚点不得参与目标判定。 */
function assertUnitGridNotInFlight(db: DatabaseSync, input: { targetKey: string; excludeRunId: string }): void {
  const rows = db.prepare(`
    SELECT d.generation_run_id AS generationRunId FROM studio_generation_dispatches d
    JOIN studio_generation_pack_targets t
      ON t.pack_id = d.pack_id AND t.pack_fingerprint = d.pack_fingerprint
    WHERE t.target_kind = 'unit-grid' AND t.target_key = ? AND d.generation_run_id != ?
    ORDER BY d.sequence
  `).all(input.targetKey, input.excludeRunId) as Array<{ generationRunId: string }>;
  for (const row of rows) {
    if (runTerminalState(db, row.generationRunId) !== null) continue;
    fail(
      "panel-run-in-flight",
      `target=${input.targetKey} 已存在非终态 generation run，禁止重复派发；状态不明时必须先对账。`,
      [`targetKind=unit-grid`, `targetKey=${input.targetKey}`, `blockingGenerationRunId=${row.generationRunId}`, "blockingStatus=dispatched"],
    );
  }
}

/** plan 节点 runId 强制校验：命中 plan 节点的 pack 必须用推导 runId（期望集合，多 plan 共享取并集）。 */
function assertPlanNodeRunId(db: DatabaseSync, input: {
  packId: string;
  packFingerprint: string;
  generationRunId: string;
  extraAllowedRunIds?: ReadonlySet<string>;
}): void {
  if (input.extraAllowedRunIds?.has(input.generationRunId)) return;
  const nodes = planNodesByPack(db, input.packId, input.packFingerprint);
  if (nodes.length === 0) return;
  const expected = new Set(nodes.map((node) => planRunIdFor(node.plan_id, node.node_index, planNodeExpectedAttempt(db, node.plan_id, node.node_index))));
  if (expected.has(input.generationRunId)) return;
  fail(
    "plan-node-run-id-mismatch",
    `(packId=${input.packId}) 已纳入生成计划，generationRunId 必须使用计划推导值。`,
    [...expected].sort().map((runId) => `expectedGenerationRunId=${runId}`),
  );
}

/**
 * dispatch 同步事务内核心（P21）：pack 行重查 → 幂等重放 → plan 节点 runId 校验 →
 * panel 互斥 → 插 dispatches 行 + 同事务插 dispatched 事件。异步闸（checkpoint/currentness）
 * 由调用方前置执行；retry 与公开 dispatch 共用同一连接同一事务。
 */
function dispatchSyncCore(writeDb: DatabaseSync, input: {
  packRow: PackRow;
  packId: string;
  packFingerprint: string;
  generationRunId: string;
  provider: StudioFormalImagegenProvider;
  supersedesRunId?: string | null;
  extraAllowedRunIds?: ReadonlySet<string>;
}): StudioGenerationDispatchRecord {
  const latestPack = packRowById(writeDb, input.packId);
  if (!latestPack
    || latestPack.fingerprint !== input.packFingerprint
    || latestPack.content_sha256 !== input.packRow.content_sha256) {
    fail("pack-index-conflict", `冻结包 ${input.packId} 的账本索引在 dispatch 期间漂移。`);
  }
  const historicalImport = writeDb.prepare(`SELECT import_id AS importId
    FROM studio_generation_historical_imports
    WHERE pack_id = ? AND pack_fingerprint = ?
    LIMIT 1`).get(input.packId, input.packFingerprint) as { importId?: string } | undefined;
  if (historicalImport?.importId) {
    fail(
      "historical-import-conflict",
      `冻结包 ${input.packId} 已由 ${historicalImport.importId} 证明为历史 PASS，禁止追加真实 dispatch。`,
    );
  }
  const latestTarget = packTargetRowById(writeDb, input.packId);
  if (latestTarget) {
    const activeDetachedUnknown = writeDb.prepare(`
      SELECT observation.observation_id AS observationId, observation.source_task_id AS sourceTaskId
      FROM studio_generation_detached_unknown_observations observation
      LEFT JOIN studio_generation_detached_unknown_dispositions disposition
        ON disposition.observation_id = observation.observation_id
      WHERE observation.target_kind = 'unit-grid'
        AND observation.target_key = ?
        AND disposition.observation_id IS NULL
      ORDER BY observation.sequence LIMIT 1
    `).get(latestTarget.target_key) as { observationId?: string; sourceTaskId?: string } | undefined;
    if (activeDetachedUnknown) {
      fail(
        "generation-unknown",
        `target=${latestTarget.target_key} 存在未处置的 detached generation_unknown，禁止新派发或重放。`,
        [
          `observationId=${activeDetachedUnknown.observationId}`,
          `sourceTaskId=${activeDetachedUnknown.sourceTaskId ?? "unknown"}`,
        ],
      );
    }
  }
  const dispatchId = dispatchIdentity({
    generationRunId: input.generationRunId,
    packId: input.packId,
    packFingerprint: input.packFingerprint,
    provenance: "local-dispatch-intent",
    provider: input.provider,
  });
  const concurrent = dispatchRowByRun(writeDb, input.generationRunId);
  if (concurrent) {
    if (dispatchMatches(concurrent, { packId: input.packId, packFingerprint: input.packFingerprint, dispatchId })
      && concurrent.executor_provider === input.provider) {
      const protocol = dispatchProtocolRowByRun(writeDb, input.generationRunId);
      if (latestTarget) {
        if (!protocol || protocol.dispatch_id !== concurrent.dispatch_id
          || Number(protocol.protocol_version) !== 2 || Number(protocol.requires_call_intent) !== 1) {
          fail("storage-invalid", `unit-grid dispatch ${concurrent.dispatch_id} 缺少 protocol v2。`);
        }
      } else if (protocol
        && (protocol.dispatch_id !== concurrent.dispatch_id
          || Number(protocol.protocol_version) !== 2
          || Number(protocol.requires_call_intent) !== 1)) {
        fail("storage-invalid", `panel dispatch ${concurrent.dispatch_id} 的可选 protocol v2 无效。`);
      }
      return dispatchRecord(concurrent);
    }
    fail(
      "dispatch-conflict",
      `generationRunId=${input.generationRunId} 已绑定其他不可变 dispatch。`,
      [
        `existingPackId=${concurrent.pack_id}`,
        `requestedPackId=${input.packId}`,
        `existingProvider=${concurrent.executor_provider}`,
        `requestedProvider=${input.provider}`,
      ],
    );
  }
  assertPlanNodeRunId(writeDb, {
    packId: input.packId,
    packFingerprint: input.packFingerprint,
    generationRunId: input.generationRunId,
    extraAllowedRunIds: input.extraAllowedRunIds,
  });
  if (latestTarget) {
    assertUnitGridNotInFlight(writeDb, {
      targetKey: latestTarget.target_key,
      excludeRunId: input.generationRunId,
    });
  } else {
    assertPanelNotInFlight(writeDb, {
      unitId: latestPack!.unit_id,
      panelId: latestPack!.panel_id,
      excludeRunId: input.generationRunId,
    });
  }
  const now = new Date().toISOString();
  writeDb.prepare(`
    INSERT INTO studio_generation_dispatches(
      dispatch_id, generation_run_id, pack_id, pack_fingerprint, executor_provider, provenance, dispatched_at
    ) VALUES(?, ?, ?, ?, ?, 'local-dispatch-intent', ?)
  `).run(dispatchId, input.generationRunId, input.packId, input.packFingerprint, input.provider, now);
  if (latestTarget) {
    writeDb.prepare(`
      INSERT INTO studio_generation_dispatch_protocols(
        dispatch_id, generation_run_id, protocol_version, requires_call_intent, created_at
      ) VALUES(?, ?, 2, 1, ?)
    `).run(dispatchId, input.generationRunId, now);
  }
  const parsed = parsePlanRunId(input.generationRunId);
  if (parsed) {
    // 防伪：plan 形态 runId 必须指向存在的 plan 且该节点 (packId,packFingerprint) 与本次一致，
    // 否则事件会错挂他 plan 或污染其 attempt 推导。
    const nodeMatches = Boolean(planRowById(writeDb, parsed.planId))
      && planNodesByPlan(writeDb, parsed.planId).some((node) => Number(node.node_index) === parsed.nodeIndex
        && node.pack_id === input.packId
        && node.pack_fingerprint === input.packFingerprint);
    if (!nodeMatches) {
      fail("invalid-input", `generationRunId=${input.generationRunId} 指向不存在或不匹配的 plan 节点，禁止伪造计划归属。`);
    }
  }
  insertRunEvent(writeDb, {
    generationRunId: input.generationRunId,
    planId: parsed?.planId ?? null,
    nodeIndex: parsed?.nodeIndex ?? null,
    kind: "dispatched",
    attempt: parsed?.attempt ?? 1,
    supersedesRunId: input.supersedesRunId ?? null,
    detail: {
      packId: input.packId,
      packFingerprint: input.packFingerprint,
      provider: input.provider,
      targetKind: latestTarget ? "unit-grid" : "panel",
      targetKey: latestTarget?.target_key ?? `panel:${latestPack!.unit_id}:${latestPack!.panel_id}`,
    },
    now,
  });
  return dispatchRecord(dispatchRowByRun(writeDb, input.generationRunId)!);
}

function dispatchMatches(
  row: DispatchRow,
  input: { packId: string; packFingerprint: string; dispatchId: string },
): boolean {
  assertDispatchRowIntegrity(row);
  return row.dispatch_id === input.dispatchId
    && row.pack_id === input.packId
    && row.pack_fingerprint === input.packFingerprint
    && row.provenance === "local-dispatch-intent";
}

async function assertDispatchGatesCurrent(
  projectRoot: string,
  pack: AnyStudioGenerationFreezePack,
  options: { excludeRunId?: string } = {},
): Promise<void> {
  const { assertStudioGenerationCheckpointDispatchAllowed } = await import("./studio-generation-checkpoint.js");
  if (isUnitGridFreezePack(pack)) {
    await assertStudioGenerationCheckpointDispatchAllowed(projectRoot, {
      targetKind: "unit-grid",
      unitId: pack.target.unitId,
      ...(options.excludeRunId === undefined ? {} : { excludeRunId: options.excludeRunId }),
    });
  } else {
    await assertStudioGenerationCheckpointDispatchAllowed(projectRoot, {
      unitId: pack.target.unitId,
      panelId: pack.target.panelId,
      ...(options.excludeRunId === undefined ? {} : { excludeRunId: options.excludeRunId }),
    });
  }
  await assertAnyPackCurrent(projectRoot, pack);
}

/**
 * 追加本地 dispatch intent：它是“允许执行面使用该冻结包”的前置证据，
 * 不是远程服务收到请求的 receipt。首次写入前必须仍为 current。
 */
export async function dispatchStudioGenerationPack(
  projectRoot: string,
  input: DispatchStudioGenerationPackInput,
): Promise<StudioGenerationDispatchRecord> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const packId = normalizeId(input.packId, "packId");
  const packFingerprint = normalizeSha256(input.packFingerprint, "packFingerprint");
  const generationRunId = normalizeId(input.generationRunId, "generationRunId");
  const provider = normalizeDispatchProvider(input.provider);
  const dispatchId = dispatchIdentity({
    generationRunId,
    packId,
    packFingerprint,
    provenance: "local-dispatch-intent",
    provider,
  });
  const readDb = openDatabase(paths);
  let packRow: PackRow | undefined;
  let existing: DispatchRow | undefined;
  try {
    packRow = packRowById(readDb, packId);
    existing = dispatchRowByRun(readDb, generationRunId);
    // plan 节点 runId 是输入校验，必须先于下方 checkpoint 占槽门禁报出，
    // 否则错误 runId 会被“尚待人工验收”掩盖（P21 §4-3 回归）。
    // 幂等重放/冲突由 dispatchSyncCore 在事务内复查，此处只服务首次 dispatch。
    if (packRow && packRow.fingerprint === packFingerprint && !existing) {
      assertPlanNodeRunId(readDb, { packId, packFingerprint, generationRunId });
    }
  } finally {
    readDb.close();
  }
  if (!packRow) fail("pack-not-found", `持久冻结包不存在：${packId}`);
  if (packRow.fingerprint !== packFingerprint) {
    fail("pack-index-conflict", `packId ${packId} 与 packFingerprint 不匹配。`);
  }
  const pack = await readAnyPackFromRow(paths, packRow);
  assertAnyPackDispatchable(pack);
  if (!pack.request.allowedProviders.includes(provider)) {
    fail(
      "invalid-input",
      `provider=${provider} 不在冻结包 allowedProviders 内：${pack.request.allowedProviders.join(",")}`,
    );
  }
  if (existing) {
    if (dispatchMatches(existing, { packId, packFingerprint, dispatchId })
      && existing.executor_provider === provider) {
      const replayDb = openDatabase(paths);
      try {
        return runTransaction(replayDb, () => dispatchSyncCore(replayDb, {
          packRow: packRow!,
          packId,
          packFingerprint,
          generationRunId,
          provider,
        }));
      } finally {
        replayDb.close();
      }
    }
    fail(
      "dispatch-conflict",
      `generationRunId=${generationRunId} 已绑定其他不可变 dispatch。`,
      [
        `existingPackId=${existing.pack_id}`,
        `requestedPackId=${packId}`,
        `existingProvider=${existing.executor_provider}`,
        `requestedProvider=${provider}`,
      ],
    );
  }
  // P7 六图停检是实际执行面的强制门禁，不允许调用方只绕过 helper 直接
  // 追加 dispatch。动态导入避免 checkpoint 读取层对本 ledger 的静态循环。
  await assertDispatchGatesCurrent(paths.root, pack);
  const writeDb = openDatabase(paths);
  try {
    return runTransaction(writeDb, () => dispatchSyncCore(writeDb, {
      packRow: packRow!,
      packId,
      packFingerprint,
      generationRunId,
      provider,
    }));
  } finally {
    writeDb.close();
  }
}

export async function readStudioGenerationDispatch(
  projectRoot: string,
  generationRunId: string,
): Promise<StudioGenerationDispatchRecord | null> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const normalizedRunId = normalizeId(generationRunId, "generationRunId");
  const db = openDatabase(paths);
  let row: DispatchRow | undefined;
  let pack: PackRow | undefined;
  try {
    row = dispatchRowByRun(db, normalizedRunId);
    if (row) pack = packRowById(db, row.pack_id);
  } finally {
    db.close();
  }
  if (!row) return null;
  if (!pack || pack.fingerprint !== row.pack_fingerprint) {
    fail("storage-invalid", `dispatch ${row.dispatch_id} 存在孤立 pack 引用。`);
  }
  await readAnyPackFromRow(paths, pack);
  return dispatchRecord(row);
}

function targetIdentityFromRows(pack: PackRow, target: PackTargetRow | undefined): {
  targetKind: StudioGenerationTargetKind;
  targetKey: string;
  targetFingerprint: string;
} {
  return target
    ? {
        targetKind: "unit-grid",
        targetKey: target.target_key,
        targetFingerprint: target.target_fingerprint,
      }
    : {
        targetKind: "panel",
        targetKey: `panel:${pack.unit_id}:${pack.panel_id}`,
        targetFingerprint: stableDigest({
          targetKind: "panel",
          unitId: pack.unit_id,
          unitRevision: Number(pack.unit_revision),
          panelId: pack.panel_id,
          panelIndex: Number(pack.panel_index),
        }),
  };
}

const OWNER_ABANDON_DETAIL_KEYS = [
  "acknowledgeLateResultWillBeRejected",
  "acknowledgeRemoteMayExist",
  "disposition",
  "evidenceFingerprint",
  "evidenceReference",
  "lateResultPolicy",
  "publicationPolicy",
  "reason",
  "remoteInvocation",
] as const;

export function studioGenerationUnknownOwnerAbandonDetail(
  input: Pick<AbandonStudioGenerationUnknownInput, "evidenceReference" | "evidenceFingerprint" | "reason">,
): StudioGenerationUnknownOwnerAbandonDetail {
  return {
    disposition: "owner-abandoned-generation-unknown",
    remoteInvocation: "unknown-may-exist",
    lateResultPolicy: "quarantine-and-reject",
    publicationPolicy: "forbidden",
    acknowledgeRemoteMayExist: true,
    acknowledgeLateResultWillBeRejected: true,
    evidenceReference: input.evidenceReference,
    evidenceFingerprint: input.evidenceFingerprint,
    reason: input.reason,
  };
}

export function isStudioGenerationUnknownOwnerAbandonDetail(
  value: unknown,
): value is StudioGenerationUnknownOwnerAbandonDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const detail = value as Record<string, unknown>;
  const keys = Object.keys(detail).sort((left, right) => left.localeCompare(right, "en"));
  if (keys.length !== OWNER_ABANDON_DETAIL_KEYS.length
    || keys.some((key, index) => key !== OWNER_ABANDON_DETAIL_KEYS[index])) return false;
  return detail.disposition === "owner-abandoned-generation-unknown"
    && detail.remoteInvocation === "unknown-may-exist"
    && detail.lateResultPolicy === "quarantine-and-reject"
    && detail.publicationPolicy === "forbidden"
    && detail.acknowledgeRemoteMayExist === true
    && detail.acknowledgeLateResultWillBeRejected === true
    && typeof detail.evidenceReference === "string"
    && typeof detail.evidenceFingerprint === "string"
    && SHA256_PATTERN.test(detail.evidenceFingerprint)
    && typeof detail.reason === "string";
}

export function sameStudioGenerationUnknownOwnerAbandonDetail(
  value: unknown,
  input: Pick<AbandonStudioGenerationUnknownInput, "evidenceReference" | "evidenceFingerprint" | "reason">,
): value is StudioGenerationUnknownOwnerAbandonDetail {
  if (!isStudioGenerationUnknownOwnerAbandonDetail(value)) return false;
  const expected = studioGenerationUnknownOwnerAbandonDetail(input);
  return OWNER_ABANDON_DETAIL_KEYS.every((key) => value[key] === expected[key]);
}

function ownerAbandonCancelledEvents(db: DatabaseSync, generationRunId: string): RunEventRow[] {
  const rows = db.prepare(`SELECT * FROM studio_generation_run_events
    WHERE generation_run_id = ? AND kind = 'cancelled' ORDER BY sequence`)
    .all(generationRunId) as unknown as RunEventRow[];
  return rows.filter((row) => isStudioGenerationUnknownOwnerAbandonDetail(runEventRecord(row).detail));
}

const STUDIO_IMAGEGEN_CONTEXT_REBIND_NOTE_PREFIX = "studio-imagegen-context-rebind-v1:";
const STUDIO_IMAGEGEN_CONTEXT_REBIND_DETAIL_KEYS = [
  "acknowledgeBuildChangedAfterInvocation",
  "acknowledgeNoSecondModelCall",
  "callId",
  "candidateSha256",
  "dispatchId",
  "evidenceFingerprint",
  "evidenceReference",
  "executionReceiptFingerprint",
  "fromContextTokenHash",
  "generationRunId",
  "inputFingerprint",
  "kind",
  "packFingerprint",
  "packId",
  "provider",
  "reason",
  "receiptSha256",
  "schemaVersion",
  "toContextTokenHash",
] as const;

function isStudioImagegenCallContextRebindDetail(
  value: unknown,
): value is StudioImagegenCallContextRebindDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const detail = value as Record<string, unknown>;
  const keys = Object.keys(detail).sort((left, right) => left.localeCompare(right, "en"));
  if (keys.length !== STUDIO_IMAGEGEN_CONTEXT_REBIND_DETAIL_KEYS.length
    || keys.some((key, index) => key !== STUDIO_IMAGEGEN_CONTEXT_REBIND_DETAIL_KEYS[index])) return false;
  return detail.schemaVersion === 1
    && detail.kind === "studio-imagegen-call-context-rebind"
    && typeof detail.callId === "string"
    && typeof detail.generationRunId === "string"
    && typeof detail.dispatchId === "string"
    && typeof detail.packId === "string"
    && typeof detail.packFingerprint === "string" && SHA256_PATTERN.test(detail.packFingerprint)
    && isStudioFormalImagegenProvider(detail.provider)
    && typeof detail.inputFingerprint === "string" && SHA256_PATTERN.test(detail.inputFingerprint)
    && typeof detail.fromContextTokenHash === "string" && SHA256_PATTERN.test(detail.fromContextTokenHash)
    && typeof detail.toContextTokenHash === "string" && SHA256_PATTERN.test(detail.toContextTokenHash)
    && typeof detail.candidateSha256 === "string" && SHA256_PATTERN.test(detail.candidateSha256)
    && typeof detail.receiptSha256 === "string" && SHA256_PATTERN.test(detail.receiptSha256)
    && typeof detail.executionReceiptFingerprint === "string" && SHA256_PATTERN.test(detail.executionReceiptFingerprint)
    && typeof detail.evidenceReference === "string" && detail.evidenceReference.length > 0
    && typeof detail.evidenceFingerprint === "string" && SHA256_PATTERN.test(detail.evidenceFingerprint)
    && typeof detail.reason === "string" && detail.reason.length >= 8
    && detail.acknowledgeBuildChangedAfterInvocation === true
    && detail.acknowledgeNoSecondModelCall === true;
}

function serializeStudioImagegenCallContextRebindDetail(
  detail: StudioImagegenCallContextRebindDetail,
): string {
  return `${STUDIO_IMAGEGEN_CONTEXT_REBIND_NOTE_PREFIX}${JSON.stringify(stableValue(detail))}`;
}

function parseStudioImagegenCallContextRebindDetail(
  note: string,
): StudioImagegenCallContextRebindDetail | null {
  if (!note.startsWith(STUDIO_IMAGEGEN_CONTEXT_REBIND_NOTE_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(note.slice(STUDIO_IMAGEGEN_CONTEXT_REBIND_NOTE_PREFIX.length));
  } catch {
    fail("storage-invalid", "imagegen context rebind 事件不是有效 JSON。");
  }
  if (!isStudioImagegenCallContextRebindDetail(parsed)
    || serializeStudioImagegenCallContextRebindDetail(parsed) !== note) {
    fail("storage-invalid", "imagegen context rebind 事件结构或规范序列化无效。");
  }
  return parsed;
}

function contextRebindEvents(db: DatabaseSync, call: CallIntentRow): Array<{
  row: CallEventRow;
  detail: StudioImagegenCallContextRebindDetail;
}> {
  const matches: Array<{ row: CallEventRow; detail: StudioImagegenCallContextRebindDetail }> = [];
  for (const row of callEventsById(db, call.call_id)) {
    const detail = parseStudioImagegenCallContextRebindDetail(row.note);
    if (!detail) continue;
    if (row.kind !== "unknown-observation"
      || row.call_id !== call.call_id
      || row.generation_run_id !== call.generation_run_id
      || row.evidence_reference !== detail.evidenceReference
      || row.evidence_fingerprint !== detail.evidenceFingerprint
      || detail.callId !== call.call_id
      || detail.generationRunId !== call.generation_run_id) {
      fail("storage-invalid", `imagegen call ${call.call_id} 的 context rebind 事件身份不闭合。`);
    }
    matches.push({ row, detail });
  }
  // callEventsById 已严格按不可变自增 sequence 返回。链顺序只能服从 ledger
  // 提交顺序；created_at 是可回拨墙钟，不能参与 from/to 权威链排序。
  if (matches.length > 8) {
    fail("storage-invalid", `imagegen call ${call.call_id} 的 context rebind 链过长（>${8}）。`);
  }
  if (matches.length > 0) {
    let expectedFrom = call.context_token_hash;
    for (const match of matches) {
      if (match.detail.fromContextTokenHash !== expectedFrom) {
        fail("storage-invalid", `imagegen call ${call.call_id} 的 context rebind 链 from/to 不连续。`);
      }
      expectedFrom = match.detail.toContextTokenHash;
    }
  }
  return matches;
}

function contextRebindRecord(
  value: { row: CallEventRow; detail: StudioImagegenCallContextRebindDetail },
  idempotentReplay: boolean,
): StudioImagegenCallContextRebindRecord {
  return {
    ...value.detail,
    eventId: value.row.event_id,
    createdAt: value.row.created_at,
    callAllowed: false,
    idempotentReplay,
  };
}

function isStudioImagegenContextTokenAuthorized(
  db: DatabaseSync,
  call: CallIntentRow,
  contextTokenHash: string,
): boolean {
  const rebinds = contextRebindEvents(db, call);
  if (rebinds.length === 0) return call.context_token_hash === contextTokenHash;
  // 仅最新一环的 toContextTokenHash 授权当前提交；历史环保留审计。
  const latest = rebinds[rebinds.length - 1]!.detail;
  return latest.toContextTokenHash === contextTokenHash;
}

function callIntentStatus(db: DatabaseSync, row: CallIntentRow): StudioGenerationCallIntentRecord["status"] {
  const events = callEventsById(db, row.call_id);
  const resultCommitted = events.filter((event) => event.kind === "result-committed");
  const notInvoked = events.filter((event) => event.kind === "not-invoked");
  const ownerAbandoned = ownerAbandonCancelledEvents(db, row.generation_run_id);
  if (resultCommitted.length > 1 || notInvoked.length > 1 || ownerAbandoned.length > 1
    || (resultCommitted.length > 0 && notInvoked.length > 0)
    || (ownerAbandoned.length > 0 && (resultCommitted.length > 0 || notInvoked.length > 0))) {
    fail("storage-invalid", `imagegen call ${row.call_id} 的终态事件互相冲突。`);
  }
  if (resultCommitted.length === 1) return "result-committed";
  if (notInvoked.length === 1) return "not-invoked";
  if (ownerAbandoned.length === 1) return "owner-abandoned";
  return "generation_unknown";
}

function callIntentRecord(
  projectRoot: string,
  db: DatabaseSync,
  row: CallIntentRow,
  options: { callAllowed: boolean; idempotentReplay: boolean },
): StudioGenerationCallIntentRecord {
  const dispatch = dispatchRowByRun(db, row.generation_run_id);
  const pack = packRowById(db, row.pack_id);
  const target = packTargetRowById(db, row.pack_id);
  const protocol = dispatchProtocolRowByRun(db, row.generation_run_id);
  if (!dispatch || !pack || !protocol
    || dispatch.dispatch_id !== row.dispatch_id
    || dispatch.pack_id !== row.pack_id
    || dispatch.pack_fingerprint !== row.pack_fingerprint
    || dispatch.executor_provider !== row.executor_provider
    || protocol.dispatch_id !== row.dispatch_id
    || Number(protocol.protocol_version) !== 2
    || Number(protocol.requires_call_intent) !== 1) {
    fail("storage-invalid", `imagegen call intent ${row.call_id} 缺少一致的 dispatch/protocol/pack。`);
  }
  const identity = targetIdentityFromRows(pack, target);
  if (row.target_kind !== identity.targetKind || row.target_key !== identity.targetKey) {
    fail("storage-invalid", `imagegen call intent ${row.call_id} 的 target 与 pack 不一致。`);
  }
  if (!isStudioFormalImagegenProvider(row.executor_provider)
    || !SHA256_PATTERN.test(row.input_fingerprint)
    || !SHA256_PATTERN.test(row.context_token_hash)) {
    fail("storage-invalid", `imagegen call intent ${row.call_id} 的不可变字段无效。`);
  }
  const quarantine = imagegenCallQuarantineGrant(projectRoot, row.input_fingerprint);
  return {
    schemaVersion: 1,
    kind: "studio-generation-call-intent",
    callId: row.call_id,
    generationRunId: row.generation_run_id,
    dispatchId: row.dispatch_id,
    packId: row.pack_id,
    packFingerprint: row.pack_fingerprint,
    provider: row.executor_provider,
    targetKind: row.target_kind,
    targetKey: row.target_key,
    inputFingerprint: row.input_fingerprint,
    contextTokenHash: row.context_token_hash,
    commandRequestId: row.command_request_id,
    callerAgentId: row.caller_agent_id,
    quarantine,
    status: callIntentStatus(db, row),
    callAllowed: options.callAllowed,
    idempotentReplay: options.idempotentReplay,
    createdAt: row.created_at,
  };
}

function normalizeEvidenceReference(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    fail("invalid-input", `${field} 不能为空或包含 NUL。`);
  }
  return value.trim().slice(0, 500);
}

/** 与 pre-call intent 持久字段共用的唯一 context token 摘要算法。 */
export function studioImagegenContextTokenHash(value: string): string {
  const projectContextToken = normalizeEvidenceReference(value, "projectContextToken");
  return stableDigest({ schemaVersion: 1, projectContextToken });
}

function continuationWaiverReceiptSemantic(input: {
  authorityKind: StudioUnitGridContinuationWaiverSnapshot["authorityKind"];
  projectId: string;
  currentUnitId: string;
  currentUnitRevision: number;
  currentUnitFingerprint: string;
  previousUnitId: string;
  previousUnitRevision: number;
  previousUnitFingerprint: string;
  authorizationEvidenceReference: string;
  authorizationTextSha256: string;
  reason: string;
  activeContext?: StudioUnitGridContinuationWaiverSnapshot["activeContext"];
  sourceManifestFingerprint?: string;
}): Omit<StudioUnitGridContinuationWaiverSnapshot, "receiptId" | "fingerprint"> {
  return {
    schemaVersion: 2,
    kind: "studio-unit-grid-continuation-waiver",
    authorityKind: input.authorityKind,
    projectId: input.projectId,
    currentUnitId: input.currentUnitId,
    currentUnitRevision: input.currentUnitRevision,
    currentUnitFingerprint: input.currentUnitFingerprint,
    previousUnitId: input.previousUnitId,
    previousUnitRevision: input.previousUnitRevision,
    previousUnitFingerprint: input.previousUnitFingerprint,
    authorizationEvidenceReference: input.authorizationEvidenceReference,
    authorizationTextSha256: input.authorizationTextSha256,
    reason: input.reason,
    acknowledgePreviousActualTailUnavailable: true,
    acknowledgeCanonicalRestartMayBreakContinuity: true,
    acknowledgeIdentityAndSceneLocksRemainMandatory: true,
    ...(input.activeContext ? { activeContext: input.activeContext } : {}),
    ...(input.sourceManifestFingerprint
      ? { sourceManifestFingerprint: input.sourceManifestFingerprint }
      : {}),
  };
}

function continuationWaiverReceiptRecord(
  row: ContinuationWaiverReceiptRow,
): StudioUnitGridContinuationWaiverSnapshot {
  const activeContext = row.authority_kind === "user-authorization"
    ? {
        manifestFingerprint: row.manifest_fingerprint!,
        contextTokenHash: row.context_token_hash!,
        buildId: row.build_id!,
        sourceDigest: row.source_digest!,
      }
    : undefined;
  const semantic = continuationWaiverReceiptSemantic({
    authorityKind: row.authority_kind,
    projectId: row.project_id,
    currentUnitId: row.current_unit_id,
    currentUnitRevision: Number(row.current_unit_revision),
    currentUnitFingerprint: row.current_unit_fingerprint,
    previousUnitId: row.previous_unit_id,
    previousUnitRevision: Number(row.previous_unit_revision),
    previousUnitFingerprint: row.previous_unit_fingerprint,
    authorizationEvidenceReference: row.authorization_evidence_reference,
    authorizationTextSha256: row.authorization_text_sha256,
    reason: row.reason,
    ...(activeContext ? { activeContext } : {}),
    ...(row.source_manifest_fingerprint
      ? { sourceManifestFingerprint: row.source_manifest_fingerprint }
      : {}),
  });
  const fingerprint = stableDigest(semantic);
  const receiptId = `studio-continuation-waiver-${fingerprint.slice(0, 40)}`;
  if (row.receipt_id !== receiptId
    || row.fingerprint !== fingerprint
    || Number(row.acknowledge_previous_actual_tail_unavailable) !== 1
    || Number(row.acknowledge_canonical_restart_may_break_continuity) !== 1
    || Number(row.acknowledge_identity_and_scene_locks_remain_mandatory) !== 1
    || !SHA256_PATTERN.test(row.current_unit_fingerprint)
    || !SHA256_PATTERN.test(row.previous_unit_fingerprint)
    || !SHA256_PATTERN.test(row.authorization_text_sha256)
    || (row.authority_kind === "user-authorization"
      && (!row.manifest_fingerprint
        || !row.context_token_hash
        || !row.build_id
        || !row.source_digest
        || row.source_manifest_fingerprint !== null))
    || (row.authority_kind === "verified-historical-import"
      && (!row.source_manifest_fingerprint
        || row.manifest_fingerprint !== null
        || row.context_token_hash !== null
        || row.build_id !== null
        || row.source_digest !== null))) {
    fail("storage-invalid", `continuation waiver receipt 身份漂移：${row.receipt_id}`);
  }
  return { ...semantic, receiptId, fingerprint };
}

async function previousStudioUnitSnapshot(
  projectRoot: string,
  current: NonNullable<Awaited<ReturnType<typeof getStudioProductionUnitSnapshot>>>,
) {
  if (current.unit.sequence <= 1) {
    fail("invalid-input", "首单元没有上一镜，不允许创建 continuation waiver receipt。");
  }
  let cursor: string | undefined;
  do {
    const page = await listStudioProductionUnits(projectRoot, {
      season: current.unit.season,
      episode: current.unit.episode,
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
    const previous = page.items.find((unit) => unit.sequence === current.unit.sequence - 1);
    if (previous) {
      const snapshot = await getStudioProductionUnitSnapshot(projectRoot, previous.id);
      if (!snapshot) fail("invalid-input", `上一单元快照不存在：${previous.id}`);
      return snapshot;
    }
    cursor = page.nextCursor;
  } while (cursor);
  fail(
    "invalid-input",
    `单元 ${current.unit.id} 缺少同集 sequence=${current.unit.sequence - 1} 的上一单元。`,
  );
}

function insertContinuationWaiverReceipt(
  db: DatabaseSync,
  receipt: StudioUnitGridContinuationWaiverSnapshot,
): StudioUnitGridContinuationWaiverSnapshot {
  const existing = db.prepare(`
    SELECT * FROM studio_generation_continuation_waiver_receipts
    WHERE receipt_id = ? OR fingerprint = ?
    ORDER BY sequence LIMIT 1
  `).get(receipt.receiptId, receipt.fingerprint) as unknown as ContinuationWaiverReceiptRow | undefined;
  if (existing) {
    const record = continuationWaiverReceiptRecord(existing);
    if (record.receiptId !== receipt.receiptId || record.fingerprint !== receipt.fingerprint) {
      fail("call-intent-conflict", "continuation waiver receipt 内容地址已绑定不同授权。");
    }
    return record;
  }
  const active = receipt.activeContext;
  db.prepare(`
    INSERT INTO studio_generation_continuation_waiver_receipts(
      receipt_id, authority_kind, project_id,
      current_unit_id, current_unit_revision, current_unit_fingerprint,
      previous_unit_id, previous_unit_revision, previous_unit_fingerprint,
      authorization_evidence_reference, authorization_text_sha256, reason,
      acknowledge_previous_actual_tail_unavailable,
      acknowledge_canonical_restart_may_break_continuity,
      acknowledge_identity_and_scene_locks_remain_mandatory,
      manifest_fingerprint, context_token_hash, build_id, source_digest,
      source_manifest_fingerprint, fingerprint, created_at
    ) VALUES(
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      1, 1, 1,
      ?, ?, ?, ?,
      ?, ?, ?
    )
  `).run(
    receipt.receiptId,
    receipt.authorityKind,
    receipt.projectId,
    receipt.currentUnitId,
    receipt.currentUnitRevision,
    receipt.currentUnitFingerprint,
    receipt.previousUnitId,
    receipt.previousUnitRevision,
    receipt.previousUnitFingerprint,
    receipt.authorizationEvidenceReference,
    receipt.authorizationTextSha256,
    receipt.reason,
    active?.manifestFingerprint ?? null,
    active?.contextTokenHash ?? null,
    active?.buildId ?? null,
    active?.sourceDigest ?? null,
    receipt.sourceManifestFingerprint ?? null,
    receipt.fingerprint,
    new Date().toISOString(),
  );
  const inserted = db.prepare(`
    SELECT * FROM studio_generation_continuation_waiver_receipts WHERE receipt_id = ?
  `).get(receipt.receiptId) as unknown as ContinuationWaiverReceiptRow;
  return continuationWaiverReceiptRecord(inserted);
}

export async function authorizeStudioUnitGridContinuationWaiver(
  projectRoot: string,
  input: AuthorizeStudioUnitGridContinuationWaiverInput,
): Promise<StudioUnitGridContinuationWaiverSnapshot> {
  const { paths, projectId } = await managedLedgerPaths(projectRoot);
  const unitId = normalizeId(input.unitId, "unitId");
  if (!Number.isSafeInteger(input.expectedUnitRevision) || input.expectedUnitRevision < 1) {
    fail("invalid-input", "expectedUnitRevision 必须是正整数。");
  }
  const projectContextToken = normalizeEvidenceReference(
    input.projectContextToken,
    "projectContextToken",
  );
  if (!/^studioctx-v1-[a-f0-9]{64}$/u.test(projectContextToken)) {
    fail("invalid-input", "projectContextToken 格式无效。");
  }
  const authorizationEvidenceReference = normalizeEvidenceReference(
    input.authorizationEvidenceReference,
    "authorizationEvidenceReference",
  );
  const authorizationText = typeof input.authorizationText === "string"
    ? input.authorizationText
    : "";
  if (authorizationText.length < 8
    || authorizationText.length > 4_000
    || /\p{Cc}/u.test(authorizationText)) {
    fail("invalid-input", "authorizationText 必须是 8-4000 字符用户原文且不含控制字符。");
  }
  const authorizationTextSha256 = normalizeSha256(
    input.authorizationTextSha256,
    "authorizationTextSha256",
  );
  if (authorizationTextSha256 !== sha256(Buffer.from(authorizationText, "utf8"))) {
    fail("invalid-input", "authorizationTextSha256 与用户授权原文不匹配。");
  }
  const reason = typeof input.reason === "string" ? input.reason.normalize("NFC").trim() : "";
  if (reason.length < 8 || reason.length > 500 || /\p{Cc}/u.test(reason)) {
    fail("invalid-input", "reason 必须是 8-500 字符且不含控制字符。");
  }
  if (input.acknowledgePreviousActualTailUnavailable !== true
    || input.acknowledgeCanonicalRestartMayBreakContinuity !== true
    || input.acknowledgeIdentityAndSceneLocksRemainMandatory !== true) {
    fail(
      "invalid-input",
      "创建 continuation waiver 必须确认 actual-tail 缺失、重启连续性风险及身份/场景锁仍强制生效。",
    );
  }
  const { assertActiveManagedStudioContextToken } = await import(
    "./active-managed-studio-context.js"
  );
  const active = await assertActiveManagedStudioContextToken(paths.root, projectContextToken);
  if (active.projectId !== projectId) {
    fail("call-intent-conflict", "continuation waiver 的活动工程与受管工程不一致。");
  }
  const current = await getStudioProductionUnitSnapshot(paths.root, unitId);
  if (!current || current.unit.revision !== input.expectedUnitRevision) {
    fail("invalid-input", `continuation waiver 当前单元 revision 已漂移：${unitId}`);
  }
  const previous = await previousStudioUnitSnapshot(paths.root, current);
  const semantic = continuationWaiverReceiptSemantic({
    authorityKind: "user-authorization",
    projectId,
    currentUnitId: current.unit.id,
    currentUnitRevision: current.unit.revision,
    currentUnitFingerprint: current.fingerprint,
    previousUnitId: previous.unit.id,
    previousUnitRevision: previous.unit.revision,
    previousUnitFingerprint: previous.fingerprint,
    authorizationEvidenceReference,
    authorizationTextSha256,
    reason,
    activeContext: {
      manifestFingerprint: active.manifestFingerprint,
      contextTokenHash: studioImagegenContextTokenHash(projectContextToken),
      buildId: active.build.buildId,
      sourceDigest: active.build.sourceDigest,
    },
  });
  const fingerprint = stableDigest(semantic);
  const receipt: StudioUnitGridContinuationWaiverSnapshot = {
    ...semantic,
    receiptId: `studio-continuation-waiver-${fingerprint.slice(0, 40)}`,
    fingerprint,
  };
  const db = openDatabase(paths);
  try {
    return runTransaction(db, () => insertContinuationWaiverReceipt(db, receipt));
  } finally {
    db.close();
  }
}

/**
 * 只读历史适配器专用入口。它不接受用户授权字段，也不绑定/产生可泛化的普通 waiver；
 * 公开 command schema 不暴露此函数。
 */
export async function registerStudioVerifiedHistoricalImportContinuationWaiver(
  projectRoot: string,
  input: RegisterStudioVerifiedHistoricalImportContinuationWaiverInput,
): Promise<StudioUnitGridContinuationWaiverSnapshot> {
  const { paths, projectId } = await managedLedgerPaths(projectRoot);
  const unitId = normalizeId(input.unitId, "unitId");
  if (!Number.isSafeInteger(input.expectedUnitRevision) || input.expectedUnitRevision < 1) {
    fail("invalid-input", "expectedUnitRevision 必须是正整数。");
  }
  const sourceManifestFingerprint = normalizeSha256(
    input.sourceManifestFingerprint,
    "sourceManifestFingerprint",
  );
  const authorizationEvidenceReference = normalizeEvidenceReference(
    input.authorizationEvidenceReference,
    "authorizationEvidenceReference",
  );
  const current = await getStudioProductionUnitSnapshot(paths.root, unitId);
  if (!current || current.unit.revision !== input.expectedUnitRevision) {
    fail("invalid-input", `verified historical import 当前单元 revision 已漂移：${unitId}`);
  }
  const previous = await previousStudioUnitSnapshot(paths.root, current);
  const reason = input.mode === "incremental-reconcile"
    ? "受管只读历史增量回填没有 actual-tail Observation；只允许本次历史证据导入重新起拍。"
    : input.mode === "initial-import"
      ? "受管只读历史初始导入没有 actual-tail Observation；只允许本次历史证据导入重新起拍。"
      : "确定性测试夹具没有 actual-tail Observation；只验证非连续性能力并从锁定参考重新起拍。";
  const authorizationTextSha256 = sha256(Buffer.from([
    "verified-historical-import",
    input.mode,
    projectId,
    current.unit.id,
    current.fingerprint,
    previous.unit.id,
    previous.fingerprint,
    sourceManifestFingerprint,
    authorizationEvidenceReference,
  ].join("\0"), "utf8"));
  const semantic = continuationWaiverReceiptSemantic({
    authorityKind: "verified-historical-import",
    projectId,
    currentUnitId: current.unit.id,
    currentUnitRevision: current.unit.revision,
    currentUnitFingerprint: current.fingerprint,
    previousUnitId: previous.unit.id,
    previousUnitRevision: previous.unit.revision,
    previousUnitFingerprint: previous.fingerprint,
    authorizationEvidenceReference,
    authorizationTextSha256,
    reason,
    sourceManifestFingerprint,
  });
  const fingerprint = stableDigest(semantic);
  const receipt: StudioUnitGridContinuationWaiverSnapshot = {
    ...semantic,
    receiptId: `studio-continuation-waiver-${fingerprint.slice(0, 40)}`,
    fingerprint,
  };
  const db = openDatabase(paths);
  try {
    return runTransaction(db, () => insertContinuationWaiverReceipt(db, receipt));
  } finally {
    db.close();
  }
}

export async function resolveStudioUnitGridContinuationWaiverReceiptForFreeze(
  projectRoot: string,
  reference: StudioUnitGridContinuationWaiverReference,
  options: ResolveStudioUnitGridContinuationWaiverReceiptOptions,
): Promise<StudioUnitGridContinuationWaiverSnapshot> {
  const { paths, projectId } = await managedLedgerPaths(projectRoot);
  const receiptId = normalizeId(reference.receiptId, "continuationWaiver.receiptId");
  const receiptFingerprint = normalizeSha256(
    reference.receiptFingerprint,
    "continuationWaiver.receiptFingerprint",
  );
  const currentUnitId = normalizeId(options.currentUnitId, "currentUnitId");
  const db = openDatabase(paths);
  let receipt: StudioUnitGridContinuationWaiverSnapshot;
  try {
    const row = db.prepare(`
      SELECT * FROM studio_generation_continuation_waiver_receipts WHERE receipt_id = ?
    `).get(receiptId) as unknown as ContinuationWaiverReceiptRow | undefined;
    if (!row) fail("call-intent-conflict", `continuation waiver receipt 不存在：${receiptId}`);
    receipt = continuationWaiverReceiptRecord(row);
  } finally {
    db.close();
  }
  if (receipt.fingerprint !== receiptFingerprint
    || receipt.projectId !== projectId
    || receipt.currentUnitId !== currentUnitId
    || receipt.authorityKind !== options.expectedAuthorityKind) {
    fail("call-intent-conflict", "continuation waiver receipt 引用、工程、单元或授权类型不匹配。");
  }
  const current = await getStudioProductionUnitSnapshot(paths.root, receipt.currentUnitId);
  const previous = await getStudioProductionUnitSnapshot(paths.root, receipt.previousUnitId);
  if (!current
    || current.unit.revision !== receipt.currentUnitRevision
    || current.fingerprint !== receipt.currentUnitFingerprint
    || !previous
    || previous.unit.revision !== receipt.previousUnitRevision
    || previous.fingerprint !== receipt.previousUnitFingerprint
    || current.unit.season !== previous.unit.season
    || current.unit.episode !== previous.unit.episode
    || current.unit.sequence !== previous.unit.sequence + 1) {
    fail("call-intent-conflict", "continuation waiver receipt 绑定的前后单元身份已漂移。");
  }
  if (receipt.authorityKind === "user-authorization"
    && options.validationPhase !== "post-paid-call-intent") {
    const { getActiveManagedStudioContext } = await import("./active-managed-studio-context.js");
    const active = await getActiveManagedStudioContext();
    if (!receipt.activeContext
      || active.projectId !== receipt.projectId
      || active.manifestFingerprint !== receipt.activeContext.manifestFingerprint
      || studioImagegenContextTokenHash(active.projectContextToken)
        !== receipt.activeContext.contextTokenHash
      || active.build.buildId !== receipt.activeContext.buildId
      || active.build.sourceDigest !== receipt.activeContext.sourceDigest) {
      fail("call-intent-conflict", "continuation waiver receipt 绑定的活动工程/构建上下文已漂移。");
    }
  }
  return receipt;
}

function callEventRecord(row: CallEventRow): StudioGenerationCallEventRecord {
  return {
    eventId: row.event_id,
    callId: row.call_id,
    generationRunId: row.generation_run_id,
    kind: row.kind,
    evidenceReference: row.evidence_reference,
    evidenceFingerprint: row.evidence_fingerprint,
    note: row.note,
    createdAt: row.created_at,
  };
}

function insertCallEvent(db: DatabaseSync, input: {
  call: CallIntentRow;
  kind: StudioGenerationCallEventKind;
  evidenceReference: string;
  evidenceFingerprint: string;
  note: string;
  now: string;
}): CallEventRow {
  const eventId = `studio-generation-call-event-${stableDigest({
    schemaVersion: 1,
    callId: input.call.call_id,
    generationRunId: input.call.generation_run_id,
    kind: input.kind,
    evidenceReference: input.evidenceReference,
    evidenceFingerprint: input.evidenceFingerprint,
    note: input.note,
  }).slice(0, 40)}`;
  const existing = db.prepare("SELECT * FROM studio_generation_call_events WHERE event_id = ?")
    .get(eventId) as unknown as CallEventRow | undefined;
  if (existing) return existing;
  db.prepare(`
    INSERT INTO studio_generation_call_events(
      event_id, call_id, generation_run_id, kind, evidence_reference, evidence_fingerprint, note, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    input.call.call_id,
    input.call.generation_run_id,
    input.kind,
    input.evidenceReference,
    input.evidenceFingerprint,
    input.note,
    input.now,
  );
  return db.prepare("SELECT * FROM studio_generation_call_events WHERE event_id = ?")
    .get(eventId) as unknown as CallEventRow;
}

function imagegenCallInputFingerprint(input: {
  pack: AnyStudioGenerationFreezePack;
  dispatch: DispatchRow;
  targetKind: StudioGenerationTargetKind;
  targetKey: string;
  targetFingerprint: string;
}): string {
  return stableDigest({
    schemaVersion: 1,
    projectId: input.pack.projectId,
    generationRunId: input.dispatch.generation_run_id,
    dispatchId: input.dispatch.dispatch_id,
    packId: input.pack.id,
    packFingerprint: input.pack.fingerprint,
    requestId: input.pack.request.id,
    requestFingerprint: input.pack.request.fingerprint,
    provider: input.dispatch.executor_provider,
    targetKind: input.targetKind,
    targetKey: input.targetKey,
    targetFingerprint: input.targetFingerprint,
    controlReferences: input.pack.request.controlReferences.map((reference) => ({
      mediaSha256: reference.mediaSha256,
      referenceFingerprint: stableDigest(reference),
    })),
  });
}

function imagegenCallQuarantineGrant(
  projectRoot: string,
  inputFingerprint: string,
): StudioGenerationCallIntentRecord["quarantine"] {
  const callId = `studio-imagegen-call-${inputFingerprint.slice(0, 40)}`;
  const rootPath = path.join(projectRoot, IMAGEGEN_QUARANTINE_RELATIVE_ROOT, callId);
  return {
    schemaVersion: 1,
    kind: "studio-imagegen-quarantine-grant",
    rootPath,
    candidatePath: path.join(rootPath, "candidate.png"),
    receiptPath: path.join(rootPath, "execution-receipt.json"),
  };
}

interface StudioImagegenQuarantineEvidence {
  candidateSha256: string;
  receiptSha256: string;
  executionReceiptFingerprint: string;
}

async function inspectStudioImagegenQuarantineEvidence(input: {
  projectRoot: string;
  call: CallIntentRow;
  dispatch: DispatchRow;
  layout: "9:16-vertical" | "cinematic-wide";
}): Promise<StudioImagegenQuarantineEvidence> {
  const grant = imagegenCallQuarantineGrant(input.projectRoot, input.call.input_fingerprint);
  if (path.basename(grant.rootPath) !== input.call.call_id) {
    fail("storage-invalid", `imagegen call ${input.call.call_id} 与 inputFingerprint 推导的 quarantine 不一致。`);
  }
  let candidate: Awaited<ReturnType<typeof readConfinedRegularFileWithIdentity>>;
  let receipt: Awaited<ReturnType<typeof readConfinedRegularFileWithIdentity>>;
  try {
    const directory = await inspectExistingConfinedDirectory(input.projectRoot, grant.rootPath);
    candidate = await readConfinedRegularFileWithIdentity(directory, path.basename(grant.candidatePath), 100 * 1024 * 1024);
    receipt = await readConfinedRegularFileWithIdentity(directory, path.basename(grant.receiptPath), 64 * 1024);
  } catch (error) {
    fail("call-intent-conflict", `imagegen call ${input.call.call_id} 缺少可验证的 quarantine candidate/receipt。`, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  if (candidate.nlink !== 1 || candidate.bytes.byteLength < 20_000) {
    fail("call-intent-conflict", `imagegen call ${input.call.call_id} 的 quarantine candidate 无效或过小。`);
  }
  if (receipt.nlink !== 1 || receipt.bytes.byteLength < 2) {
    fail("call-intent-conflict", `imagegen call ${input.call.call_id} 的 execution receipt 无效。`);
  }
  const candidateSha256 = sha256(candidate.bytes);
  const receiptSha256 = sha256(receipt.bytes);
  let candidateInfo: OutputInfo;
  try {
    const decoded = await sharp(candidate.bytes, { failOn: "warning", limitInputPixels: 25_000_000 })
      .rotate()
      .raw()
      .toBuffer({ resolveWithObject: true });
    candidateInfo = decoded.info;
  } catch (error) {
    fail("call-intent-conflict", `imagegen call ${input.call.call_id} 的 quarantine candidate 无法完整解码。`, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  const candidateWidth = candidateInfo.width ?? 0;
  const candidateHeight = candidateInfo.height ?? 0;
  const candidateAspectRatio = candidateWidth / candidateHeight;
  const aspectValid = input.layout === "cinematic-wide"
    ? candidateWidth > candidateHeight
      && Math.abs(candidateAspectRatio - 2.39) <= 0.18
    : candidateHeight > candidateWidth
      && Math.abs(candidateAspectRatio - 9 / 16) <= 0.025;
  if (candidateWidth < 64 || candidateHeight < 64 || !aspectValid) {
    fail(
      "call-intent-conflict",
      `imagegen call ${input.call.call_id} 的 quarantine candidate 必须符合 ${input.layout}，实际 ${candidateWidth}x${candidateHeight}。`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receipt.bytes)) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("receipt 必须是 JSON object");
    parsed = decoded as Record<string, unknown>;
  } catch (error) {
    fail("call-intent-conflict", `imagegen call ${input.call.call_id} 的 execution receipt 不是有效 UTF-8 JSON。`, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  const expectedSource = input.dispatch.executor_provider === "codex" ? "codex-imagegen" : "grok-build-imagine";
  const startedAt = typeof parsed.startedAt === "string" ? new Date(parsed.startedAt) : new Date(Number.NaN);
  const generatedAt = typeof parsed.generatedAt === "string" ? new Date(parsed.generatedAt) : new Date(Number.NaN);
  const intentCreatedAt = new Date(input.call.created_at);
  if (parsed.schemaVersion !== 1
    || parsed.kind !== "agent-imagegen-execution-receipt"
    || parsed.provider !== input.dispatch.executor_provider
    || parsed.source !== expectedSource
    || parsed.attestationLevel !== "agent-session-direct"
    || parsed.cryptographicProviderReceipt !== false
    || parsed.callId !== input.call.call_id
    || typeof parsed.model !== "string" || !parsed.model.trim() || parsed.model.length > 200
    || typeof parsed.agentSessionId !== "string" || !parsed.agentSessionId.trim()
    || (parsed.toolCallId !== undefined && (typeof parsed.toolCallId !== "string" || !parsed.toolCallId.trim()))
    || parsed.toolName !== "image_gen" && parsed.toolName !== "image_edit"
    || parsed.toolInvocationCount !== 1
    || parsed.inputFingerprint !== input.call.input_fingerprint
    || parsed.candidateSha256 !== candidateSha256
    || Number.isNaN(startedAt.getTime()) || startedAt.toISOString() !== parsed.startedAt
    || Number.isNaN(generatedAt.getTime()) || generatedAt.toISOString() !== parsed.generatedAt
    || Number.isNaN(intentCreatedAt.getTime()) || intentCreatedAt.toISOString() !== input.call.created_at
    || startedAt.getTime() < intentCreatedAt.getTime()
    || startedAt.getTime() > generatedAt.getTime()) {
    fail(
      "call-intent-conflict",
      `imagegen call ${input.call.call_id} 的 execution receipt 与 dispatch/call/inputFingerprint/candidate 不一致。`,
    );
  }
  if (input.dispatch.executor_provider === "grok"
    && (typeof parsed.toolCallId !== "string" || !parsed.toolCallId.trim())) {
    fail("call-intent-conflict", `imagegen call ${input.call.call_id} 的 Grok receipt 缺少 toolCallId。`);
  }
  const executionReceiptBase = {
    schemaVersion: 1,
    kind: "agent-imagegen-execution-receipt",
    provider: input.dispatch.executor_provider,
    source: expectedSource,
    attestationLevel: "agent-session-direct",
    cryptographicProviderReceipt: false,
    callId: input.call.call_id,
    model: (parsed.model as string).trim(),
    generatedAt: parsed.generatedAt,
  };
  const executionReceiptFingerprint = stableDigest(input.dispatch.executor_provider === "grok"
    ? {
        ...executionReceiptBase,
        agentSessionId: normalizeId(parsed.agentSessionId as string, "executionReceipt.agentSessionId"),
        toolCallId: normalizeId(parsed.toolCallId as string, "executionReceipt.toolCallId"),
        toolName: parsed.toolName,
        toolInvocationCount: 1,
        inputFingerprint: input.call.input_fingerprint,
        candidateSha256,
        startedAt: parsed.startedAt,
      }
    : executionReceiptBase);
  return { candidateSha256, receiptSha256, executionReceiptFingerprint };
}

async function prepareEmptyImagegenQuarantine(projectRoot: string, inputFingerprint: string): Promise<void> {
  const grant = imagegenCallQuarantineGrant(projectRoot, inputFingerprint);
  try {
    const directory = await ensureConfinedDirectory(projectRoot, grant.rootPath);
    await revalidateConfinedDirectory(directory);
    const entries = await readdir(directory.directory);
    await revalidateConfinedDirectory(directory);
    if (entries.length > 0) {
      fail(
        "call-intent-conflict",
        `imagegen quarantine 在首次授权前不是空目录：${grant.rootPath}`,
        entries.slice(0, 20),
      );
    }
  } catch (error) {
    if (error instanceof StudioGenerationLedgerError) throw error;
    fail(
      "storage-invalid",
      `无法建立受管 imagegen quarantine：${grant.rootPath}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

function parsedObservationEvidenceForContinuation(
  row: Record<string, unknown>,
  source: StudioUnitGridActualTailContinuationSourceSnapshot,
): {
  evidence: Record<string, unknown>;
  actualState: Record<string, string>;
} {
  let stored: unknown;
  try {
    stored = JSON.parse(String(row.observed_state_json ?? ""));
  } catch {
    fail("call-intent-conflict", "actual-tail Observation 存储 JSON 已损坏，禁止 imagegen 调用。");
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    fail("call-intent-conflict", "actual-tail Observation 存储结构无效，禁止 imagegen 调用。");
  }
  const wrapper = stored as Record<string, unknown>;
  if (wrapper.schemaVersion !== source.observationEvidenceContractVersion
    || !wrapper.evidence || typeof wrapper.evidence !== "object" || Array.isArray(wrapper.evidence)
    || !wrapper.observedState || typeof wrapper.observedState !== "object" || Array.isArray(wrapper.observedState)
    || !wrapper.observedAvailability
    || typeof wrapper.observedAvailability !== "object"
    || Array.isArray(wrapper.observedAvailability)) {
    fail("call-intent-conflict", "actual-tail Observation 不是与冻结源匹配的显式证据合同，禁止 imagegen 调用。");
  }
  const evidence = wrapper.evidence as Record<string, unknown>;
  const observedState = wrapper.observedState as Record<string, unknown>;
  const availability = wrapper.observedAvailability as Record<string, unknown>;
  if (evidence.kind !== source.evidenceKind
    || evidence.sha256 !== source.evidenceSha256
    || evidence.terminalPanelId !== source.terminalPanelId
    || !evidence.lineage
    || typeof evidence.lineage !== "object"
    || Array.isArray(evidence.lineage)
    || stableDigest(evidence.lineage) !== stableDigest(source.evidenceLineage)) {
    fail("call-intent-conflict", "actual-tail Observation 证据身份已漂移，禁止 imagegen 调用。");
  }
  const observedFields = [
    "costume",
    "injury",
    "heldObject",
    "position",
    "facing",
    "emotion",
    "layout",
    "lighting",
    "motionVector",
    "cameraPhase",
    "focusState",
    "audioPhase",
  ] as const;
  const actualState = Object.fromEntries(observedFields
    .filter((field) => availability[field] === "observed")
    .map((field) => [field, String(observedState[field] ?? "")]));
  if (observedState.referenceSha256 !== source.evidenceSha256
    || stableDigest(actualState) !== stableDigest(source.actualState)) {
    fail("call-intent-conflict", "actual-tail Observation 实际末态已漂移，禁止 imagegen 调用。");
  }
  if (source.schemaVersion === 3
    && stableDigest(wrapper.continuitySnapshot) !== stableDigest(source.continuitySnapshot)) {
    fail("call-intent-conflict", "actual-tail Observation 结构化连续性快照已漂移，禁止 imagegen 调用。");
  }
  return { evidence, actualState };
}

/**
 * paid-call 最后一跳 CAS：必须与 call-intent INSERT 在同一 BEGIN IMMEDIATE 中执行。
 * 异步 currentness 预检之后发生的 Review correction / Observation replacement
 * 会在这里被 head/event 双身份再次拦截，不留下 callAllowed=true。
 */
function assertUnitGridContinuationCurrentInIntentTransaction(
  db: DatabaseSync,
  pack: StudioUnitGridGenerationFreezePack,
  contextTokenHash: string,
): void {
  if (pack.target.unitSequence <= 1) return;
  if (pack.continuationWaiver) {
    const row = db.prepare(`
      SELECT * FROM studio_generation_continuation_waiver_receipts WHERE receipt_id = ?
    `).get(pack.continuationWaiver.receiptId) as unknown as ContinuationWaiverReceiptRow | undefined;
    if (!row) {
      fail("call-intent-conflict", "paid-call 事务内 continuation waiver receipt 不存在。");
    }
    const currentReceipt = continuationWaiverReceiptRecord(row);
    if (stableDigest(currentReceipt) !== stableDigest(pack.continuationWaiver)
      || currentReceipt.fingerprint !== pack.continuationWaiver.fingerprint
      || currentReceipt.projectId !== pack.projectId
      || currentReceipt.currentUnitId !== pack.target.unitId
      || currentReceipt.currentUnitRevision !== pack.target.unitRevision
      || (currentReceipt.authorityKind === "user-authorization"
        && currentReceipt.activeContext?.contextTokenHash !== contextTokenHash)) {
      fail("call-intent-conflict", "paid-call 事务内 continuation waiver receipt 或活动上下文已漂移。");
    }
    return;
  }
  const source = pack.continuationSource;
  if (!source || source.schemaVersion === 1) {
    fail(
      "call-intent-conflict",
      "sequence > 1 的 unit-grid pack 缺少 actual-tail 或显式豁免，禁止 imagegen 调用。",
    );
  }
  if (!tableExists(db, "studio_generation_review_events")
    || !tableExists(db, "studio_generation_review_heads")
    || !tableExists(db, "studio_post_result_observation_events")
    || !tableExists(db, "studio_post_result_observation_heads")) {
    fail("call-intent-conflict", "Review/Observation 账本未初始化，禁止 imagegen 调用。");
  }
  const reviewHead = db.prepare(`
    SELECT review_id,review_fingerprint
    FROM studio_generation_review_heads
    WHERE generation_run_id=?
  `).get(source.generationRunId) as Record<string, unknown> | undefined;
  if (!reviewHead
    || reviewHead.review_id !== source.reviewId
    || reviewHead.review_fingerprint !== source.reviewFingerprint) {
    fail("call-intent-conflict", "paid-call 事务内上一单元 Review Head 已漂移。");
  }
  const review = db.prepare(`
    SELECT generation_run_id,raw_result_id,raw_sha256,labeled_result_id,labeled_sha256,
           pack_id,pack_fingerprint,decision,current_at_submission,advances_head,fingerprint
    FROM studio_generation_review_events
    WHERE review_id=?
  `).get(source.reviewId) as Record<string, unknown> | undefined;
  if (!review
    || review.generation_run_id !== source.generationRunId
    || review.raw_result_id !== source.authorityRawResultId
    || review.raw_sha256 !== source.authorityRawMediaSha256
    || review.labeled_result_id !== source.authorityLabeledResultId
    || review.labeled_sha256 !== source.authorityLabeledMediaSha256
    || review.pack_id !== source.sourcePackId
    || review.pack_fingerprint !== source.sourcePackFingerprint
    || review.decision !== "pass"
    || Number(review.current_at_submission) !== 1
    || Number(review.advances_head) !== 1
    || review.fingerprint !== source.reviewFingerprint) {
    fail("call-intent-conflict", "paid-call 事务内上一单元 PASS Review 事件身份已漂移。");
  }
  const observationHead = db.prepare(`
    SELECT revision,observation_id,observation_fingerprint
    FROM studio_post_result_observation_heads
    WHERE generation_run_id=?
  `).get(source.generationRunId) as Record<string, unknown> | undefined;
  if (!observationHead
    || Number(observationHead.revision) !== source.observationRevision
    || observationHead.observation_id !== source.observationId
    || observationHead.observation_fingerprint !== source.observationFingerprint) {
    fail("call-intent-conflict", "paid-call 事务内上一单元 Observation Head 已漂移。");
  }
  const observation = db.prepare(`
    SELECT generation_run_id,head_revision,review_id,review_fingerprint,
           raw_result_id,raw_sha256,labeled_result_id,labeled_sha256,
           pack_id,pack_fingerprint,observed_state_json,fingerprint
    FROM studio_post_result_observation_events
    WHERE observation_id=?
  `).get(source.observationId) as Record<string, unknown> | undefined;
  if (!observation
    || observation.generation_run_id !== source.generationRunId
    || Number(observation.head_revision) !== source.observationRevision
    || observation.review_id !== source.reviewId
    || observation.review_fingerprint !== source.reviewFingerprint
    || observation.raw_result_id !== source.authorityRawResultId
    || observation.raw_sha256 !== source.authorityRawMediaSha256
    || observation.labeled_result_id !== source.authorityLabeledResultId
    || observation.labeled_sha256 !== source.authorityLabeledMediaSha256
    || observation.pack_id !== source.sourcePackId
    || observation.pack_fingerprint !== source.sourcePackFingerprint
    || observation.fingerprint !== source.observationFingerprint) {
    fail("call-intent-conflict", "paid-call 事务内上一单元 Observation 事件身份已漂移。");
  }
  parsedObservationEvidenceForContinuation(observation, source);
}

/**
 * 外部 imagegen 调用前的唯一防重闸：首次成功追加 intent 时 callAllowed=true；
 * 任意重放都只返回既有 callId 且 callAllowed=false。intent 一落盘即按
 * generation_unknown 处理，直到结果与 call event 原子提交或显式 not-invoked 对账。
 */
export async function prepareStudioImagegenCall(
  projectRoot: string,
  input: PrepareStudioImagegenCallInput,
): Promise<StudioGenerationCallIntentRecord> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const packId = normalizeId(input.packId, "packId");
  const packFingerprint = normalizeSha256(input.packFingerprint, "packFingerprint");
  const generationRunId = normalizeId(input.generationRunId, "generationRunId");
  const provider = normalizeDispatchProvider(input.provider);
  const projectContextToken = normalizeEvidenceReference(input.projectContextToken, "projectContextToken");
  const commandRequestId = normalizeId(input.commandRequestId, "commandRequestId");
  const callerAgentId = input.callerAgentId === undefined
    ? null
    : normalizeId(input.callerAgentId, "callerAgentId");
  if (input.expectedRevision !== 0) fail("invalid-input", "prepare imagegen call 的 expectedRevision 必须为 0。");

  const readDb = openDatabase(paths);
  let packRow: PackRow | undefined;
  let targetRow: PackTargetRow | undefined;
  let dispatch: DispatchRow | undefined;
  let protocol: DispatchProtocolRow | undefined;
  let existingIntent: CallIntentRow | undefined;
  try {
    packRow = packRowById(readDb, packId);
    targetRow = packTargetRowById(readDb, packId);
    dispatch = dispatchRowByRun(readDb, generationRunId);
    protocol = dispatchProtocolRowByRun(readDb, generationRunId);
    existingIntent = callIntentRowByRun(readDb, generationRunId);
  } finally {
    readDb.close();
  }
  if (!packRow) fail("pack-not-found", `持久冻结包不存在：${packId}`);
  if (packRow.fingerprint !== packFingerprint) fail("pack-index-conflict", `packId ${packId} 与 packFingerprint 不匹配。`);
  if (!dispatch) fail("dispatch-not-found", `generationRunId=${generationRunId} 尚无 dispatch intent。`);
  assertDispatchRowIntegrity(dispatch);
  if (dispatch.pack_id !== packId || dispatch.pack_fingerprint !== packFingerprint || dispatch.executor_provider !== provider) {
    fail("dispatch-conflict", `generationRunId=${generationRunId} 与请求 pack/provider 不一致。`);
  }
  const pack = await readAnyPackFromRow(paths, packRow);
  const unitGrid = isUnitGridFreezePack(pack);
  if (unitGrid && !targetRow) fail("target-extension-invalid", `unit-grid pack ${packId} 缺少 target extension。`);
  if (!unitGrid && targetRow) fail("target-extension-invalid", `panel pack ${packId} 不应存在 unit-grid target extension。`);
  if (protocol && (protocol.dispatch_id !== dispatch.dispatch_id
    || Number(protocol.protocol_version) !== 2 || Number(protocol.requires_call_intent) !== 1)) {
    fail("call-intent-required", `generationRunId=${generationRunId} 的 protocol v2 call-intent 合同无效。`);
  }
  if (unitGrid && !protocol) {
    fail("call-intent-required", `unit-grid generationRunId=${generationRunId} 缺少 protocol v2 call-intent 合同。`);
  }
  assertAnyPackDispatchable(pack);
  const target = targetIdentityFromRows(packRow, targetRow);
  const inputFingerprint = imagegenCallInputFingerprint({
    pack,
    dispatch,
    targetKind: target.targetKind,
    targetKey: target.targetKey,
    targetFingerprint: target.targetFingerprint,
  });
  const callId = `studio-imagegen-call-${inputFingerprint.slice(0, 40)}`;
  if (existingIntent) {
    if (existingIntent.call_id !== callId || existingIntent.input_fingerprint !== inputFingerprint) {
      fail("call-intent-conflict", `generationRunId=${generationRunId} 已绑定不同 imagegen call intent。`);
    }
    if (callerAgentId !== null && existingIntent.caller_agent_id !== callerAgentId) {
      fail("call-intent-conflict", `generationRunId=${generationRunId} 已由不同 callerAgentId 建立 imagegen call intent。`);
    }
    const replayDb = openDatabase(paths);
    try {
      return callIntentRecord(paths.root, replayDb, callIntentRowById(replayDb, callId)!, {
        callAllowed: false,
        idempotentReplay: true,
      });
    } finally {
      replayDb.close();
    }
  }

  // 被验 run 自己就是槽位最新 dispatch：门禁须排除自身，否则 firstPrepare 会被
  // “尚待人工验收”误伤（P30 回归）。槽位上更旧的占用 run 仍照常投影判定。
  await assertDispatchGatesCurrent(paths.root, pack, { excludeRunId: generationRunId });
  await prepareEmptyImagegenQuarantine(paths.root, inputFingerprint);
  const beforeIntentTransactionHook = beforeImagegenIntentTransactionHookForTests;
  beforeImagegenIntentTransactionHookForTests = null;
  await beforeIntentTransactionHook?.();
  const contextTokenHash = studioImagegenContextTokenHash(projectContextToken);
  const writeDb = openDatabase(paths);
  try {
    return runTransaction(writeDb, () => {
      assertNoActiveConnectorReservation(writeDb, generationRunId);
      const currentDispatch = dispatchRowByRun(writeDb, generationRunId);
      let currentProtocol = dispatchProtocolRowByRun(writeDb, generationRunId);
      const concurrent = callIntentRowByRun(writeDb, generationRunId);
      if (concurrent) {
        if (concurrent.call_id !== callId || concurrent.input_fingerprint !== inputFingerprint) {
          fail("call-intent-conflict", `generationRunId=${generationRunId} 并发绑定了不同 imagegen call intent。`);
        }
        if (callerAgentId !== null && concurrent.caller_agent_id !== callerAgentId) {
          fail("call-intent-conflict", `generationRunId=${generationRunId} 并发绑定了不同 callerAgentId。`);
        }
        return callIntentRecord(paths.root, writeDb, concurrent, { callAllowed: false, idempotentReplay: true });
      }
      if (!currentDispatch || currentDispatch.dispatch_id !== dispatch!.dispatch_id) {
        fail("dispatch-conflict", `generationRunId=${generationRunId} 的 dispatch 在 prepare 期间漂移。`);
      }
      if (!currentProtocol) {
        if (unitGrid) fail("dispatch-conflict", `unit-grid generationRunId=${generationRunId} 的 protocol 在 prepare 期间丢失。`);
        const now = new Date().toISOString();
        writeDb.prepare(`
          INSERT INTO studio_generation_dispatch_protocols(
            dispatch_id, generation_run_id, protocol_version, requires_call_intent, created_at
          ) VALUES(?, ?, 2, 1, ?)
        `).run(currentDispatch.dispatch_id, generationRunId, now);
        currentProtocol = dispatchProtocolRowByRun(writeDb, generationRunId);
      }
      if (!currentProtocol || currentProtocol.dispatch_id !== dispatch!.dispatch_id
        || Number(currentProtocol.protocol_version) !== 2
        || Number(currentProtocol.requires_call_intent) !== 1) {
        fail("dispatch-conflict", `generationRunId=${generationRunId} 的 protocol 在 prepare 期间漂移。`);
      }
      if (runTerminalState(writeDb, generationRunId) !== null) {
        fail("run-terminal", `generationRunId=${generationRunId} 已终态，禁止准备 imagegen 调用。`);
      }
      if (unitGrid) assertUnitGridContinuationCurrentInIntentTransaction(writeDb, pack, contextTokenHash);
      const now = new Date().toISOString();
      writeDb.prepare(`
        INSERT INTO studio_generation_call_intents(
          call_id, generation_run_id, dispatch_id, pack_id, pack_fingerprint, executor_provider,
          target_kind, target_key, input_fingerprint, context_token_hash, command_request_id,
          created_at, caller_agent_id
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        callId,
        generationRunId,
        dispatch!.dispatch_id,
        packId,
        packFingerprint,
        provider,
        target.targetKind,
        target.targetKey,
        inputFingerprint,
        contextTokenHash,
        commandRequestId,
        now,
        callerAgentId,
      );
      return callIntentRecord(paths.root, writeDb, callIntentRowById(writeDb, callId)!, {
        callAllowed: true,
        idempotentReplay: false,
      });
    });
  } finally {
    writeDb.close();
  }
}

/**
 * L31：sourceDigest / activation 变化后 projectContextToken 会变，
 * 旧 pre-call 的 context_token_hash 与当前活动令牌不再相等。
 * 仅允许在 generation_unknown 上用显式 note 前缀做 not-invoked 孤儿恢复；
 * 禁止 unknown-observation / 结果提交走此旁路，也不重新授予 callAllowed。
 */
export const STUDIO_IMAGEGEN_CONTEXT_TOKEN_EXPIRED_RECOVERY_NOTE_PREFIX =
  "context-token-expired-recovery:";

export async function reconcileStudioImagegenCall(
  projectRoot: string,
  input: ReconcileStudioImagegenCallInput,
): Promise<StudioGenerationCallEventRecord> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const callId = normalizeId(input.callId, "callId");
  const contextTokenHash = studioImagegenContextTokenHash(input.projectContextToken);
  if (input.result !== "not-invoked" && input.result !== "unknown-observation") {
    fail("invalid-input", "reconcile result 必须是 not-invoked 或 unknown-observation。");
  }
  const evidenceReference = normalizeEvidenceReference(input.evidenceReference, "evidenceReference");
  const evidenceFingerprint = normalizeSha256(input.evidenceFingerprint, "evidenceFingerprint");
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : "";
  if (note.startsWith(STUDIO_IMAGEGEN_CONTEXT_REBIND_NOTE_PREFIX)) {
    fail("invalid-input", "context rebind 事件前缀仅允许由专用 rebind 命令写入。");
  }
  const writeDb = openDatabase(paths);
  try {
    return runTransaction(writeDb, () => {
      const call = callIntentRowById(writeDb, callId);
      if (!call) fail("call-intent-required", `imagegen call intent 不存在：${callId}`);
      const status = callIntentStatus(writeDb, call);
      const tokenMatches = call.context_token_hash === contextTokenHash;
      const expiredRecoveryRequested = note.startsWith(STUDIO_IMAGEGEN_CONTEXT_TOKEN_EXPIRED_RECOVERY_NOTE_PREFIX);
      if (!tokenMatches) {
        // 孤儿恢复：仅 not-invoked + generation_unknown + 显式 note 前缀。
        // projectRoot 已由 command-bus 绑定活动工程；此处不再要求旧 token 复现。
        if (!(input.result === "not-invoked" && status === "generation_unknown" && expiredRecoveryRequested)) {
          fail(
            "call-intent-conflict",
            `imagegen call ${callId} 不属于当前 projectContextToken，禁止跨工程或跨活动上下文对账。`
              + "若因构建身份/激活令牌轮换导致 generation_unknown 悬挂，"
              + `可在 note 以 ${STUDIO_IMAGEGEN_CONTEXT_TOKEN_EXPIRED_RECOVERY_NOTE_PREFIX} 开头后仅标记 not-invoked。`,
          );
        }
      }
      const eventKind: StudioGenerationCallEventKind = input.result;
      const expectedEventId = `studio-generation-call-event-${stableDigest({
        schemaVersion: 1,
        callId,
        generationRunId: call.generation_run_id,
        kind: eventKind,
        evidenceReference,
        evidenceFingerprint,
        note,
      }).slice(0, 40)}`;
      const replay = writeDb.prepare("SELECT * FROM studio_generation_call_events WHERE event_id = ?")
        .get(expectedEventId) as unknown as CallEventRow | undefined;
      if (replay) return callEventRecord(replay);
      if (status === "result-committed") {
        fail("call-intent-conflict", `imagegen call ${callId} 已原子提交结果，禁止追加 ${eventKind}。`);
      }
      if (status === "not-invoked") {
        fail("call-intent-conflict", `imagegen call ${callId} 已有不同 not-invoked 证据，禁止改写。`);
      }
      if (status === "owner-abandoned") {
        fail(
          "call-intent-conflict",
          `imagegen call ${callId} 已由 owner 永久封存；远端仍可能存在，禁止追加对账事件或接纳迟到结果。`,
        );
      }
      if (eventKind === "not-invoked" && contextRebindEvents(writeDb, call).length > 0) {
        fail(
          "call-intent-conflict",
          `imagegen call ${callId} 已有 candidate/receipt context rebind 事实，禁止伪造 not-invoked。`,
        );
      }
      if (eventKind === "not-invoked") {
        const resultCount = Number((writeDb.prepare(
          "SELECT COUNT(*) AS count FROM studio_generation_results WHERE generation_run_id = ?",
        ).get(call.generation_run_id) as { count: number }).count);
        if (resultCount > 0) fail("call-intent-conflict", `imagegen call ${callId} 已有结果行，禁止标记 not-invoked。`);
        assertNoActiveConnectorReservation(writeDb, call.generation_run_id);
      }
      return callEventRecord(insertCallEvent(writeDb, {
        call,
        kind: eventKind,
        evidenceReference,
        evidenceFingerprint,
        note,
        now: new Date().toISOString(),
      }));
    });
  } finally {
    writeDb.close();
  }
}

/**
 * 仅为“模型调用已完成、候选与执行审计回执均在原 quarantine 中，但活动构建令牌随后变化”
 * 追加一次上下文授权。原 call intent 与 context_token_hash 永不更新；本命令也永不重新授予模型调用。
 */
export async function rebindStudioImagegenCallContext(
  projectRoot: string,
  input: RebindStudioImagegenCallContextInput,
): Promise<StudioImagegenCallContextRebindRecord> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const callId = normalizeId(input.callId, "callId");
  const generationRunId = normalizeId(input.generationRunId, "generationRunId");
  const packId = normalizeId(input.packId, "packId");
  const packFingerprint = normalizeSha256(input.packFingerprint, "packFingerprint");
  const inputFingerprint = normalizeSha256(input.inputFingerprint, "inputFingerprint");
  const candidateSha256 = normalizeSha256(input.candidateSha256, "candidateSha256");
  const receiptSha256 = normalizeSha256(input.receiptSha256, "receiptSha256");
  const projectContextToken = normalizeEvidenceReference(input.projectContextToken, "projectContextToken");
  if (!/^studioctx-v1-[a-f0-9]{64}$/u.test(projectContextToken)) {
    fail("invalid-input", "projectContextToken 格式无效。");
  }
  const toContextTokenHash = studioImagegenContextTokenHash(projectContextToken);
  const evidenceReference = normalizeEvidenceReference(input.evidenceReference, "evidenceReference");
  const evidenceFingerprint = normalizeSha256(input.evidenceFingerprint, "evidenceFingerprint");
  const reason = typeof input.reason === "string" ? input.reason.normalize("NFC").trim() : "";
  if (reason.length < 8 || reason.length > 500 || /\p{Cc}/u.test(reason)) {
    fail("invalid-input", "reason 必须是 8-500 字符且不含控制字符。");
  }
  if (input.acknowledgeBuildChangedAfterInvocation !== true || input.acknowledgeNoSecondModelCall !== true) {
    fail("invalid-input", "context rebind 必须确认构建在调用后变化，且不会执行第二次模型调用。");
  }

  const readDb = openDatabase(paths);
  let call: CallIntentRow | undefined;
  let dispatch: DispatchRow | undefined;
  let packRow: PackRow | undefined;
  let target: PackTargetRow | undefined;
  let preexistingRebind: StudioImagegenCallContextRebindRecord | null = null;
  try {
    call = callIntentRowById(readDb, callId);
    if (!call) fail("call-intent-required", `imagegen call intent 不存在：${callId}`);
    dispatch = dispatchRowByRun(readDb, generationRunId);
    packRow = packRowById(readDb, packId);
    target = packRow ? packTargetRowById(readDb, packId) : undefined;
    const targetIdentity = packRow ? targetIdentityFromRows(packRow, target) : undefined;
    if (call.generation_run_id !== generationRunId
      || call.pack_id !== packId
      || call.pack_fingerprint !== packFingerprint
      || call.input_fingerprint !== inputFingerprint
      || (call.target_kind !== "unit-grid" && call.target_kind !== "panel")
      || !dispatch
      || dispatch.dispatch_id !== call.dispatch_id
      || dispatch.pack_id !== packId
      || dispatch.pack_fingerprint !== packFingerprint
      || dispatch.executor_provider !== call.executor_provider
      || !packRow
      || packRow.fingerprint !== packFingerprint
      || !targetIdentity
      || targetIdentity.targetKind !== call.target_kind
      || targetIdentity.targetKey !== call.target_key) {
      fail("call-intent-conflict", `imagegen call ${callId} 的 call/run/dispatch/pack/target/inputFingerprint 不一致。`);
    }
    if (call.context_token_hash === toContextTokenHash) {
      fail("call-intent-conflict", `imagegen call ${callId} 已属于当前 projectContextToken，无需 rebind。`);
    }
    const existing = contextRebindEvents(readDb, call);
    const status = callIntentStatus(readDb, call);
    if (existing.length >= 1) {
      const latest = existing[existing.length - 1]!;
      const record = contextRebindRecord(latest, true);
      // 幂等：完全相同命令重放
      if ((status === "generation_unknown" || status === "result-committed")
        && record.packId === packId
        && record.packFingerprint === packFingerprint
        && record.inputFingerprint === inputFingerprint
        && record.fromContextTokenHash === (existing.length === 1 ? call.context_token_hash : existing[existing.length - 2]!.detail.toContextTokenHash)
        && record.toContextTokenHash === toContextTokenHash
        && record.candidateSha256 === candidateSha256
        && record.receiptSha256 === receiptSha256
        && record.evidenceReference === evidenceReference
        && record.evidenceFingerprint === evidenceFingerprint
        && record.reason === reason) {
        preexistingRebind = record;
      } else if (status === "generation_unknown"
        && record.packId === packId
        && record.packFingerprint === packFingerprint
        && record.inputFingerprint === inputFingerprint
        && record.candidateSha256 === candidateSha256
        && (record.toContextTokenHash !== toContextTokenHash
          || record.receiptSha256 !== receiptSha256)) {
        // 链式 rebind：同一 candidate 仍密封。
        // - token 再轮换 → 换 toContextTokenHash
        // - 同 token 下 audit receipt 重写 → 更新 receiptSha（仍禁止二次模型调用）
        if (inputFingerprint !== call.input_fingerprint) {
          fail("call-intent-conflict", `imagegen call ${callId} 链式 rebind 的 inputFingerprint 不一致。`);
        }
        // fall through to append after quarantine re-verify (preexistingRebind stays null)
      } else {
        fail("call-intent-conflict", `imagegen call ${callId} 已用其他事实 rebind，禁止改写。`);
      }
    } else {
      if (status !== "generation_unknown") {
        fail("call-intent-conflict", `imagegen call ${callId} 不是 generation_unknown，禁止 context rebind。`);
      }
      const resultCount = Number((readDb.prepare(
        "SELECT COUNT(*) AS count FROM studio_generation_results WHERE generation_run_id = ?",
      ).get(generationRunId) as { count: number }).count);
      assertRunAcceptsNewResult(readDb, generationRunId);
      if (resultCount !== 0 || runTerminalState(readDb, generationRunId) !== null) {
        fail("call-intent-conflict", `generationRunId=${generationRunId} 已有结果或终态，禁止 context rebind。`);
      }
    }
  } finally {
    readDb.close();
  }
  if (preexistingRebind) return preexistingRebind;

  const pack = await readAnyPackFromRow(paths, packRow!);
  assertAnyPackDispatchable(pack);
  await assertAnyPackCurrent(paths.root, pack, { afterPaidCallIntent: true });
  const provider = normalizeStudioFormalImagegenProvider(dispatch!.executor_provider);
  const identity = targetIdentityFromRows(packRow!, target);
  const recomputedInputFingerprint = imagegenCallInputFingerprint({
    pack,
    dispatch: dispatch!,
    targetKind: identity.targetKind,
    targetKey: identity.targetKey,
    targetFingerprint: identity.targetFingerprint,
  });
  if (recomputedInputFingerprint !== call!.input_fingerprint || recomputedInputFingerprint !== inputFingerprint) {
    fail("call-intent-conflict", `imagegen call ${callId} 的冻结输入指纹已漂移。`);
  }
  const quarantineEvidence = await inspectStudioImagegenQuarantineEvidence({
    projectRoot: paths.root,
    call: call!,
    dispatch: dispatch!,
    layout: isUnitGridFreezePack(pack)
      ? "9:16-vertical"
      : pack.request.modelPayload.layout ?? "9:16-vertical",
  });
  if (quarantineEvidence.candidateSha256 !== candidateSha256
    || quarantineEvidence.receiptSha256 !== receiptSha256) {
    fail("call-intent-conflict", `imagegen call ${callId} 的 candidate/receipt SHA 与命令声明不一致。`);
  }

  // 链式 rebind 的 from 是上一环 to；首环 from 是 call 原始 token hash
  const priorRebinds = (() => {
    const readDb2 = openDatabase(paths);
    try {
      return contextRebindEvents(readDb2, call!);
    } finally {
      readDb2.close();
    }
  })();
  const fromContextTokenHash = priorRebinds.length > 0
    ? priorRebinds[priorRebinds.length - 1]!.detail.toContextTokenHash
    : call!.context_token_hash;
  const expectedDetail: StudioImagegenCallContextRebindDetail = {
    schemaVersion: 1,
    kind: "studio-imagegen-call-context-rebind",
    callId,
    generationRunId,
    dispatchId: dispatch!.dispatch_id,
    packId,
    packFingerprint,
    provider,
    inputFingerprint,
    fromContextTokenHash,
    toContextTokenHash,
    candidateSha256,
    receiptSha256,
    executionReceiptFingerprint: quarantineEvidence.executionReceiptFingerprint,
    evidenceReference,
    evidenceFingerprint,
    reason,
    acknowledgeBuildChangedAfterInvocation: true,
    acknowledgeNoSecondModelCall: true,
  };
  const note = serializeStudioImagegenCallContextRebindDetail(expectedDetail);
  const writeDb = openDatabase(paths);
  try {
    return runTransaction(writeDb, () => {
      const currentCall = callIntentRowById(writeDb, callId);
      const currentDispatch = dispatchRowByRun(writeDb, generationRunId);
      const currentPack = packRowById(writeDb, packId);
      const currentTarget = currentPack ? packTargetRowById(writeDb, packId) : undefined;
      const currentIdentity = currentPack
        ? targetIdentityFromRows(currentPack, currentTarget)
        : undefined;
      const existing = currentCall ? contextRebindEvents(writeDb, currentCall) : [];
      const expectedFrom = existing.length > 0
        ? existing[existing.length - 1]!.detail.toContextTokenHash
        : currentCall?.context_token_hash;
      if (!currentCall
        || currentCall.generation_run_id !== generationRunId
        || currentCall.dispatch_id !== expectedDetail.dispatchId
        || currentCall.pack_id !== packId
        || currentCall.pack_fingerprint !== packFingerprint
        || currentCall.input_fingerprint !== inputFingerprint
        || expectedFrom !== expectedDetail.fromContextTokenHash
        || !currentDispatch
        || currentDispatch.dispatch_id !== expectedDetail.dispatchId
        || currentDispatch.executor_provider !== expectedDetail.provider
        || !currentPack
        || currentPack.fingerprint !== packFingerprint
        || !currentIdentity
        || currentIdentity.targetKind !== currentCall.target_kind
        || currentIdentity.targetKey !== currentCall.target_key) {
        fail("call-intent-conflict", `imagegen call ${callId} 在 context rebind 期间发生身份漂移。`);
      }
      // 幂等：完全相同的最新 rebind 命令
      if (existing.length >= 1) {
        const latest = existing[existing.length - 1]!;
        if (serializeStudioImagegenCallContextRebindDetail(latest.detail) === note) {
          return contextRebindRecord(latest, true);
        }
        // 链式：candidate 仍密封时可追加（token 变 或 同 token 下 receipt 审计刷新）
        if (latest.detail.candidateSha256 !== expectedDetail.candidateSha256
          || latest.detail.packId !== expectedDetail.packId
          || latest.detail.inputFingerprint !== expectedDetail.inputFingerprint
          || (latest.detail.toContextTokenHash === expectedDetail.toContextTokenHash
            && latest.detail.receiptSha256 === expectedDetail.receiptSha256)) {
          fail("call-intent-conflict", `imagegen call ${callId} 已用其他事实 rebind，禁止改写。`);
        }
      }
      if (callIntentStatus(writeDb, currentCall) !== "generation_unknown") {
        fail("call-intent-conflict", `imagegen call ${callId} 已终态，禁止 context rebind。`);
      }
      const resultCount = Number((writeDb.prepare(
        "SELECT COUNT(*) AS count FROM studio_generation_results WHERE generation_run_id = ?",
      ).get(generationRunId) as { count: number }).count);
      assertRunAcceptsNewResult(writeDb, generationRunId);
      if (resultCount !== 0 || runTerminalState(writeDb, generationRunId) !== null) {
        fail("call-intent-conflict", `generationRunId=${generationRunId} 已有结果或终态，禁止 context rebind。`);
      }
      const row = insertCallEvent(writeDb, {
        call: currentCall,
        kind: "unknown-observation",
        evidenceReference,
        evidenceFingerprint,
        note,
        now: new Date().toISOString(),
      });
      return contextRebindRecord({ row, detail: expectedDetail }, false);
    });
  } finally {
    writeDb.close();
  }
}

export async function readStudioImagegenCallContextRebindByRun(
  projectRoot: string,
  generationRunIdValue: string,
): Promise<StudioImagegenCallContextRebindRecord | null> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const generationRunId = normalizeId(generationRunIdValue, "generationRunId");
  const db = openDatabase(paths);
  try {
    const call = callIntentRowByRun(db, generationRunId);
    if (!call) return null;
    const matches = contextRebindEvents(db, call);
    return matches.length >= 1 ? contextRebindRecord(matches[matches.length - 1]!, true) : null;
  } finally {
    db.close();
  }
}

/**
 * 提交/崩溃恢复前重新读取同一 quarantine 的 candidate 与完整审计回执；事件本身不是文件仍存在的替代证据。
 */
export async function verifyStudioImagegenCallContextRebindEvidence(
  projectRoot: string,
  generationRunIdValue: string,
): Promise<StudioImagegenCallContextRebindRecord | null> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const generationRunId = normalizeId(generationRunIdValue, "generationRunId");
  const db = openDatabase(paths);
  let call: CallIntentRow | undefined;
  let dispatch: DispatchRow | undefined;
  let packRow: PackRow | undefined;
  let rebind: StudioImagegenCallContextRebindRecord | null = null;
  try {
    call = callIntentRowByRun(db, generationRunId);
    if (!call) return null;
    dispatch = dispatchRowByRun(db, generationRunId);
    packRow = packRowById(db, call.pack_id);
    const matches = contextRebindEvents(db, call);
    if (matches.length === 0) return null;
    // 链式 rebind：复核最新一环（quarantine 与最新 token 授权）
    rebind = contextRebindRecord(matches[matches.length - 1]!, true);
    if (!dispatch
      || dispatch.dispatch_id !== call.dispatch_id
      || rebind.dispatchId !== dispatch.dispatch_id
      || rebind.packId !== call.pack_id
      || rebind.packFingerprint !== call.pack_fingerprint
      || rebind.provider !== dispatch.executor_provider
      || rebind.inputFingerprint !== call.input_fingerprint
      || !packRow
      || packRow.fingerprint !== call.pack_fingerprint) {
      fail("storage-invalid", `imagegen call ${call.call_id} 的 context rebind 与 call/dispatch 不一致。`);
    }
    // 首环 from 必须是原始 token；后续环由 contextRebindEvents 链校验
    if (matches[0]!.detail.fromContextTokenHash !== call.context_token_hash) {
      fail("storage-invalid", `imagegen call ${call.call_id} 的 context rebind 起点不是原始 token hash。`);
    }
  } finally {
    db.close();
  }
  const pack = await readAnyPackFromRow(paths, packRow!);
  const observed = await inspectStudioImagegenQuarantineEvidence({
    projectRoot: paths.root,
    call: call!,
    dispatch: dispatch!,
    layout: isUnitGridFreezePack(pack)
      ? "9:16-vertical"
      : pack.request.modelPayload.layout ?? "9:16-vertical",
  });
  if (observed.candidateSha256 !== rebind!.candidateSha256
    || observed.receiptSha256 !== rebind!.receiptSha256
    || observed.executionReceiptFingerprint !== rebind!.executionReceiptFingerprint) {
    fail(
      "call-intent-conflict",
      `imagegen call ${call!.call_id} 的 quarantine candidate/receipt 已偏离 context rebind 事件。`,
      [
        `expectedCandidateSha256=${rebind!.candidateSha256}`,
        `actualCandidateSha256=${observed.candidateSha256}`,
        `expectedReceiptSha256=${rebind!.receiptSha256}`,
        `actualReceiptSha256=${observed.receiptSha256}`,
      ],
    );
  }
  return rebind;
}

export async function isStudioImagegenCallContextAuthorized(
  projectRoot: string,
  generationRunIdValue: string,
  projectContextToken: string,
): Promise<boolean> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const generationRunId = normalizeId(generationRunIdValue, "generationRunId");
  const contextTokenHash = studioImagegenContextTokenHash(projectContextToken);
  const db = openDatabase(paths);
  try {
    const call = callIntentRowByRun(db, generationRunId);
    return call ? isStudioImagegenContextTokenAuthorized(db, call, contextTokenHash) : false;
  } finally {
    db.close();
  }
}

/**
 * 只读恢复投影：读取已经落盘的 pre-call intent 时永远不重新授予模型调用。
 * command bus 可据此在“业务写入成功、命令收据未落盘”的崩溃窗内安全对账。
 */
export async function readStudioImagegenCallIntentByRun(
  projectRoot: string,
  generationRunIdValue: string,
): Promise<StudioGenerationCallIntentRecord | null> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const generationRunId = normalizeId(generationRunIdValue, "generationRunId");
  const db = openDatabase(paths);
  try {
    const row = callIntentRowByRun(db, generationRunId);
    return row ? callIntentRecord(paths.root, db, row, { callAllowed: false, idempotentReplay: true }) : null;
  } finally {
    db.close();
  }
}

/** 只读返回一个 call 的不可变事件链；不暴露 SQLite 行或兼容锚点。 */
export async function readStudioImagegenCallEventHistory(
  projectRoot: string,
  callIdValue: string,
): Promise<StudioGenerationCallEventRecord[]> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const callId = normalizeId(callIdValue, "callId");
  const db = openDatabase(paths);
  try {
    const intent = callIntentRowById(db, callId);
    if (!intent) return [];
    return callEventsById(db, callId).map(callEventRecord);
  } finally {
    db.close();
  }
}

function assertRunNotGenerationUnknown(db: DatabaseSync, generationRunId: string): void {
  const call = callIntentRowByRun(db, generationRunId);
  if (call && callIntentStatus(db, call) === "generation_unknown") {
    fail(
      "generation-unknown",
      `generationRunId=${generationRunId} 已存在 pre-call intent 但无结果或 not-invoked 终态证据，禁止失败、取消、重试或重复派发。`,
      [`callId=${call.call_id}`, `targetKind=${call.target_kind}`, `targetKey=${call.target_key}`],
    );
  }
}

function resultRowByRunVariant(
  db: DatabaseSync,
  generationRunId: string,
  variant: StudioGenerationResultVariant,
): ResultRow | undefined {
  return db.prepare("SELECT * FROM studio_generation_results WHERE generation_run_id = ? AND variant = ?")
    .get(generationRunId, variant) as unknown as ResultRow | undefined;
}

function sameRegisteredResult(
  row: ResultRow,
  input: {
    dispatchId: string;
    packId: string;
    packFingerprint: string;
    mediaSha256: string;
    resultId: string;
  },
): boolean {
  return row.result_id === input.resultId
    && row.dispatch_id === input.dispatchId
    && row.pack_id === input.packId
    && row.pack_fingerprint === input.packFingerprint
    && row.media_sha256 === input.mediaSha256
    && row.status === "pending";
}

function assertDetachedCandidateShaNotReused(
  db: DatabaseSync,
  rawMediaSha256: string,
): void {
  const detached = db.prepare(`
    SELECT observation_id AS observationId, source_task_id AS sourceTaskId
    FROM studio_generation_detached_unknown_observations
    WHERE candidate_sha256 = ?
    ORDER BY sequence LIMIT 1
  `).get(rawMediaSha256) as { observationId?: string; sourceTaskId?: string } | undefined;
  if (detached?.observationId) {
    fail(
      "generation-unknown",
      "detached generation_unknown 的隔离候选永久禁止导入、复用或登记为新 run 的 raw。",
      [
        `observationId=${detached.observationId}`,
        `sourceTaskId=${detached.sourceTaskId ?? "unknown"}`,
        `candidateSha256=${rawMediaSha256}`,
      ],
    );
  }
}

export async function assertStudioGenerationRawNotDetachedCandidate(
  projectRoot: string,
  input: { packId: string; packFingerprint: string; rawMediaSha256: string },
): Promise<void> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const packId = normalizeId(input.packId, "packId");
  const packFingerprint = normalizeSha256(input.packFingerprint, "packFingerprint");
  const rawMediaSha256 = normalizeSha256(input.rawMediaSha256, "rawMediaSha256");
  const db = openDatabase(paths);
  try {
    const pack = packRowById(db, packId);
    if (!pack) fail("pack-not-found", `持久冻结包不存在：${packId}`);
    if (pack.fingerprint !== packFingerprint) {
      fail("pack-index-conflict", `packId ${packId} 与 packFingerprint 不匹配。`);
    }
    assertDetachedCandidateShaNotReused(db, rawMediaSha256);
  } finally {
    db.close();
  }
}

export async function registerStudioGenerationResult(
  projectRoot: string,
  input: RegisterStudioGenerationResultInput,
): Promise<StudioGenerationResultRecord> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const packId = normalizeId(input.packId, "packId");
  const packFingerprint = normalizeSha256(input.packFingerprint, "packFingerprint");
  const generationRunId = normalizeId(input.generationRunId, "generationRunId");
  const variant = normalizeVariant(input.variant);
  const mediaSha256 = normalizeSha256(input.mediaSha256, "mediaSha256");

  const db = openDatabase(paths);
  let packRow: PackRow | undefined;
  let dispatchRow: DispatchRow | undefined;
  let dispatchProtocol: DispatchProtocolRow | undefined;
  try {
    packRow = packRowById(db, packId);
    dispatchRow = dispatchRowByRun(db, generationRunId);
    dispatchProtocol = dispatchProtocolRowByRun(db, generationRunId);
  } finally {
    db.close();
  }
  if (!packRow) fail("pack-not-found", `持久冻结包不存在：${packId}`);
  if (packRow.fingerprint !== packFingerprint) fail("pack-index-conflict", `packId ${packId} 与 packFingerprint 不匹配。`);
  if (dispatchProtocol) {
    fail(
      "call-intent-requires-bundle",
      `generationRunId=${generationRunId} 使用 protocol v2；必须携带 callId 通过原子 raw/labeled bundle 写回。`,
    );
  }
  const pack = await readPackFromRow(paths, packRow);
  assertPackDispatchable(pack);
  if (!dispatchRow) {
    fail("dispatch-not-found", `generationRunId=${generationRunId} 未追加 local dispatch intent，禁止登记结果。`);
  }
  assertDispatchRowIntegrity(dispatchRow);
  if (dispatchRow.pack_id !== packId || dispatchRow.pack_fingerprint !== packFingerprint) {
    fail(
      "dispatch-conflict",
      `generationRunId=${generationRunId} 的 dispatch 不属于请求冻结包。`,
      [`dispatchPackId=${dispatchRow.pack_id}`, `requestedPackId=${packId}`],
    );
  }
  if (input.provider !== undefined) {
    const provider = normalizeDispatchProvider(input.provider);
    if (provider !== dispatchRow.executor_provider) {
      fail(
        "invalid-input",
        `register provider=${provider} 与 dispatch provider=${dispatchRow.executor_provider} 不一致。`,
      );
    }
  }
  const media = await getStudioMedia(paths.root, mediaSha256);
  if (!media) fail("result-media-missing", `结果图 ${mediaSha256} 尚未导入 material CAS。`);
  if (media.kind !== "image" || media.derivativeStatus !== "ready") {
    fail("result-media-invalid", `结果媒体 ${mediaSha256} 不是 ready image。`);
  }
  if (!await verifyStudioMediaObject(paths.root, mediaSha256)) {
    fail("result-media-drift", `结果图 ${mediaSha256} 的 material CAS 实测 SHA 失败。`);
  }
  const currentness = await observePackInputCurrentness(paths.root, pack);

  const resultIdentity = {
    packId,
    packFingerprint,
    generationRunId,
    variant,
    mediaSha256,
    status: "pending" as const,
  };
  const resultId = `studio-generation-result-${stableDigest(resultIdentity).slice(0, 40)}`;
  const writeDb = openDatabase(paths);
  let written: ResultRow;
  try {
    written = runTransaction(writeDb, () => {
      const latestPack = packRowById(writeDb, packId);
      if (!latestPack || latestPack.fingerprint !== packFingerprint || latestPack.content_sha256 !== packRow!.content_sha256) {
        fail("pack-index-conflict", `冻结包 ${packId} 的账本索引在登记期间漂移。`);
      }
      const latestDispatch = dispatchRowByRun(writeDb, generationRunId);
      if (latestDispatch) assertDispatchRowIntegrity(latestDispatch);
      if (!latestDispatch
        || latestDispatch.dispatch_id !== dispatchRow!.dispatch_id
        || latestDispatch.pack_id !== packId
        || latestDispatch.pack_fingerprint !== packFingerprint) {
        fail("dispatch-conflict", `generationRunId=${generationRunId} 的 dispatch 在登记期间漂移。`);
      }
      assertNoActiveConnectorReservation(writeDb, generationRunId);
      assertDetachedCandidateShaNotReused(writeDb, mediaSha256);
      const existing = resultRowByRunVariant(writeDb, generationRunId, variant);
      if (existing) {
        if (sameRegisteredResult(existing, {
          dispatchId: dispatchRow!.dispatch_id,
          packId,
          packFingerprint,
          mediaSha256,
          resultId,
        })) return existing;
        throw new StudioGenerationResultConflictError(
          generationRunId,
          variant,
          existing.result_id,
          [
            `existingPackId=${existing.pack_id}`,
            `existingMediaSha256=${existing.media_sha256}`,
            `requestedPackId=${packId}`,
            `requestedMediaSha256=${mediaSha256}`,
          ],
        );
      }
      assertRunAcceptsNewResult(writeDb, generationRunId);
      const now = new Date().toISOString();
      writeDb.prepare(`
        INSERT INTO studio_generation_results(
          result_id, dispatch_id, generation_run_id, variant, status, media_sha256,
          input_current, promotion_eligible, stale_reasons_json,
          pack_id, pack_fingerprint, unit_id, unit_revision, panel_id, panel_index, created_at
        ) VALUES(
          ?, ?, ?, ?, 'pending', ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        resultId,
        dispatchRow!.dispatch_id,
        generationRunId,
        variant,
        mediaSha256,
        currentness.inputCurrent ? 1 : 0,
        currentness.inputCurrent ? 1 : 0,
        JSON.stringify(currentness.staleReasons),
        packId,
        packFingerprint,
        pack.target.unitId,
        pack.target.unitRevision,
        pack.target.panelId,
        pack.target.panelIndex,
        now,
      );
      // T11：结果行与画布投影事件在同一 SQLite 事务内原子提交；
      // 上面的 existing 幂等返回分支不重复追加（事件已在首次入账时写入）。
      appendCanvasProjectionEvent(writeDb, {
        kind: "result-committed",
        unitId: pack.target.unitId,
        panelId: pack.target.panelId,
        generationRunId,
        payload: {
          resultId,
          variant,
          mediaSha256,
          packId,
          packFingerprint,
        },
      });
      return resultRowByRunVariant(writeDb, generationRunId, variant)!;
    });
  } finally {
    writeDb.close();
  }
  return (await projectResultRowsWithFreshDatabase(paths, [written]))[0]!;
}

function bundleRecord(
  raw: StudioGenerationResultRecord,
  labeled: StudioGenerationResultRecord,
): StudioGenerationResultBundleRecord {
  if (raw.generationRunId !== labeled.generationRunId
    || raw.packId !== labeled.packId
    || raw.packFingerprint !== labeled.packFingerprint
    || raw.dispatchId !== labeled.dispatchId
    || raw.provider !== labeled.provider
    || raw.targetKind !== labeled.targetKind
    || raw.targetKey !== labeled.targetKey
    || raw.variant !== "raw"
    || labeled.variant !== "labeled"
    || !raw.pairComplete
    || !labeled.pairComplete) {
    fail("storage-invalid", `generationRunId=${raw.generationRunId} 的 raw/labeled bundle 投影不一致。`);
  }
  const immutable = {
    schemaVersion: (raw.targetKind === "unit-grid" ? 5 : 4) as 4 | 5,
    kind: "studio-generation-result-bundle" as const,
    generationRunId: raw.generationRunId,
    packId: raw.packId,
    packFingerprint: raw.packFingerprint,
    provider: raw.provider,
    status: "pending-review" as const,
    pairComplete: true as const,
    inputCurrent: raw.inputCurrent && labeled.inputCurrent,
    raw,
    labeled,
    createdAt: raw.createdAt <= labeled.createdAt ? raw.createdAt : labeled.createdAt,
  };
  return { ...immutable, fingerprint: stableDigest(immutable) };
}

/**
 * 新 Agent 结果的唯一成对登记面。两张图先在 material owner 完成导入/实测，
 * 然后本函数在 generation ledger 的一个 SQLite transaction 中追加两行。
 * 任一冲突都不会留下新的单边 result；成功后仍为 pending，不触发 Review。
 */
export async function registerStudioGenerationResultBundle(
  projectRoot: string,
  input: RegisterStudioGenerationResultBundleInput,
): Promise<StudioGenerationResultBundleRecord> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const packId = normalizeId(input.packId, "packId");
  const packFingerprint = normalizeSha256(input.packFingerprint, "packFingerprint");
  const generationRunId = normalizeId(input.generationRunId, "generationRunId");
  const provider = normalizeDispatchProvider(input.provider);
  const rawMediaSha256 = normalizeSha256(input.rawMediaSha256, "rawMediaSha256");
  const labeledMediaSha256 = normalizeSha256(input.labeledMediaSha256, "labeledMediaSha256");
  if (rawMediaSha256 === labeledMediaSha256) {
    fail("invalid-input", "raw/labeled 必须是不同内容，禁止以同一 SHA 冒充成对结果。");
  }

  const readDb = openDatabase(paths);
  let packRow: PackRow | undefined;
  let targetRow: PackTargetRow | undefined;
  let dispatchRow: DispatchRow | undefined;
  let dispatchProtocol: DispatchProtocolRow | undefined;
  let callIntent: CallIntentRow | undefined;
  let hasContextRebind = false;
  try {
    packRow = packRowById(readDb, packId);
    targetRow = packTargetRowById(readDb, packId);
    dispatchRow = dispatchRowByRun(readDb, generationRunId);
    dispatchProtocol = dispatchProtocolRowByRun(readDb, generationRunId);
    callIntent = callIntentRowByRun(readDb, generationRunId);
    hasContextRebind = callIntent ? contextRebindEvents(readDb, callIntent).length > 0 : false;
  } finally {
    readDb.close();
  }
  if (!packRow) fail("pack-not-found", `持久冻结包不存在：${packId}`);
  if (packRow.fingerprint !== packFingerprint) {
    fail("pack-index-conflict", `packId ${packId} 与 packFingerprint 不匹配。`);
  }
  const pack = await readAnyPackFromRow(paths, packRow);
  assertAnyPackDispatchable(pack);
  if (!dispatchRow) {
    fail("dispatch-not-found", `generationRunId=${generationRunId} 未追加 local dispatch intent，禁止登记 bundle。`);
  }
  assertDispatchRowIntegrity(dispatchRow);
  if (dispatchRow.pack_id !== packId || dispatchRow.pack_fingerprint !== packFingerprint) {
    fail(
      "dispatch-conflict",
      `generationRunId=${generationRunId} 的 dispatch 不属于请求冻结包。`,
      [`dispatchPackId=${dispatchRow.pack_id}`, `requestedPackId=${packId}`],
    );
  }
  if (dispatchRow.executor_provider !== provider) {
    fail(
      "invalid-input",
      `bundle provider=${provider} 与 dispatch provider=${dispatchRow.executor_provider} 不一致。`,
    );
  }
  const protocolV2 = Boolean(dispatchProtocol);
  let callId: string | undefined;
  if (protocolV2) {
    if (!dispatchProtocol || dispatchProtocol.dispatch_id !== dispatchRow.dispatch_id
      || Number(dispatchProtocol.protocol_version) !== 2 || Number(dispatchProtocol.requires_call_intent) !== 1) {
      fail("call-intent-required", `generationRunId=${generationRunId} 缺少有效 protocol v2。`);
    }
    if (input.callId === undefined) {
      fail("call-intent-required", `generationRunId=${generationRunId} 写回必须携带 pre-call callId。`);
    }
    callId = normalizeId(input.callId, "callId");
    if (!callIntent || callIntent.call_id !== callId
      || callIntent.dispatch_id !== dispatchRow.dispatch_id
      || callIntent.pack_id !== packId
      || callIntent.pack_fingerprint !== packFingerprint
      || callIntent.executor_provider !== provider
      || callIntent.target_kind !== (targetRow ? "unit-grid" : "panel")) {
      fail("call-intent-conflict", `callId=${callId} 与 generationRunId=${generationRunId} 的 intent 不一致。`);
    }
    await assertStudioGenerationRawNotDetachedCandidate(paths.root, {
      packId,
      packFingerprint,
      rawMediaSha256,
    });
  } else {
    if (dispatchProtocol || callIntent) {
      fail("storage-invalid", `legacy panel generationRunId=${generationRunId} 不应存在孤立 call intent。`);
    }
    if (input.callId !== undefined) fail("invalid-input", "legacy panel v4 bundle 不接受 callId。 ");
  }

  for (const [variant, mediaSha256] of [["raw", rawMediaSha256], ["labeled", labeledMediaSha256]] as const) {
    const media = await getStudioMedia(paths.root, mediaSha256);
    if (!media) fail("result-media-missing", `${variant} 结果图 ${mediaSha256} 尚未导入 material CAS。`);
    if (media.kind !== "image" || media.derivativeStatus !== "ready") {
      fail("result-media-invalid", `${variant} 结果媒体 ${mediaSha256} 不是 ready image。`);
    }
    if (!await verifyStudioMediaObject(paths.root, mediaSha256)) {
      fail("result-media-drift", `${variant} 结果图 ${mediaSha256} 的 material CAS 实测 SHA 失败。`);
    }
  }

  // 新 bundle 不接受“晚到但已过期”；输入一变即必须重新 freeze/dispatch。
  await assertAnyPackCurrent(
    paths.root,
    pack,
    protocolV2 && hasContextRebind ? { afterPaidCallIntent: true } : {},
  );

  const now = new Date().toISOString();
  const identities = {
    raw: {
      packId,
      packFingerprint,
      generationRunId,
      variant: "raw" as const,
      mediaSha256: rawMediaSha256,
      status: "pending" as const,
    },
    labeled: {
      packId,
      packFingerprint,
      generationRunId,
      variant: "labeled" as const,
      mediaSha256: labeledMediaSha256,
      status: "pending" as const,
    },
  };
  const resultIds = {
    raw: `studio-generation-result-${stableDigest(identities.raw).slice(0, 40)}`,
    labeled: `studio-generation-result-${stableDigest(identities.labeled).slice(0, 40)}`,
  };

  const writeDb = openDatabase(paths);
  let written: [ResultRow, ResultRow];
  try {
    written = runTransaction(writeDb, () => {
      const latestPack = packRowById(writeDb, packId);
      if (!latestPack || latestPack.fingerprint !== packFingerprint || latestPack.content_sha256 !== packRow!.content_sha256) {
        fail("pack-index-conflict", `冻结包 ${packId} 的账本索引在 bundle 登记期间漂移。`);
      }
      const latestDispatch = dispatchRowByRun(writeDb, generationRunId);
      const latestTarget = packTargetRowById(writeDb, packId);
      const latestProtocol = dispatchProtocolRowByRun(writeDb, generationRunId);
      const latestCall = callIntentRowByRun(writeDb, generationRunId);
      if (latestDispatch) assertDispatchRowIntegrity(latestDispatch);
      if (!latestDispatch
        || latestDispatch.dispatch_id !== dispatchRow!.dispatch_id
        || latestDispatch.pack_id !== packId
        || latestDispatch.pack_fingerprint !== packFingerprint
        || latestDispatch.executor_provider !== provider) {
        fail("dispatch-conflict", `generationRunId=${generationRunId} 的 dispatch 在 bundle 登记期间漂移。`);
      }
      if (protocolV2) {
        if (!latestProtocol || !latestCall
          || latestProtocol.dispatch_id !== latestDispatch.dispatch_id
          || latestCall.call_id !== callId
          || latestCall.dispatch_id !== latestDispatch.dispatch_id
          || latestCall.target_kind !== (latestTarget ? "unit-grid" : "panel")) {
          fail("call-intent-conflict", `generationRunId=${generationRunId} 的 protocol/call intent 在 bundle 登记期间漂移。`);
        }
        assertDetachedCandidateShaNotReused(writeDb, rawMediaSha256);
      } else if (latestTarget || latestProtocol || latestCall) {
        fail("storage-invalid", `panel generationRunId=${generationRunId} 在登记期间出现 unit-grid extension。`);
      }
      assertNoActiveConnectorReservation(writeDb, generationRunId);
      const existingRaw = resultRowByRunVariant(writeDb, generationRunId, "raw");
      const existingLabeled = resultRowByRunVariant(writeDb, generationRunId, "labeled");
      if (existingRaw || existingLabeled) {
        if (existingRaw && existingLabeled
          && sameRegisteredResult(existingRaw, {
            dispatchId: dispatchRow!.dispatch_id,
            packId,
            packFingerprint,
            mediaSha256: rawMediaSha256,
            resultId: resultIds.raw,
          })
          && sameRegisteredResult(existingLabeled, {
            dispatchId: dispatchRow!.dispatch_id,
            packId,
            packFingerprint,
            mediaSha256: labeledMediaSha256,
            resultId: resultIds.labeled,
          })) {
          if (protocolV2 && callIntentStatus(writeDb, latestCall!) !== "result-committed") {
            fail("storage-invalid", `generationRunId=${generationRunId} 已有结果但缺少原子 result-committed call event。`);
          }
          return [existingRaw, existingLabeled];
        }
        const conflict = existingRaw && (!existingLabeled || existingRaw.media_sha256 !== rawMediaSha256)
          ? existingRaw
          : existingLabeled!;
        throw new StudioGenerationResultConflictError(
          generationRunId,
          conflict.variant,
          conflict.result_id,
          [
            `existingRawSha256=${existingRaw?.media_sha256 ?? "missing"}`,
            `existingLabeledSha256=${existingLabeled?.media_sha256 ?? "missing"}`,
            `requestedRawSha256=${rawMediaSha256}`,
            `requestedLabeledSha256=${labeledMediaSha256}`,
            "v4 bundle 禁止在历史单边结果上静默补边。",
          ],
        );
      }
      assertRunAcceptsNewResult(writeDb, generationRunId);
      if (protocolV2 && callIntentStatus(writeDb, latestCall!) !== "generation_unknown") {
        fail("call-intent-conflict", `callId=${callId} 已终态，禁止登记新的 bundle。`);
      }

      const insert = writeDb.prepare(`
        INSERT INTO studio_generation_results(
          result_id, dispatch_id, generation_run_id, variant, status, media_sha256,
          input_current, promotion_eligible, stale_reasons_json,
          pack_id, pack_fingerprint, unit_id, unit_revision, panel_id, panel_index, created_at
        ) VALUES(
          ?, ?, ?, ?, 'pending', ?,
          1, 1, '[]',
          ?, ?, ?, ?, ?, ?, ?
        )
      `);
      insert.run(
        resultIds.raw,
        dispatchRow!.dispatch_id,
        generationRunId,
        "raw",
        rawMediaSha256,
        packId,
        packFingerprint,
        packRow!.unit_id,
        Number(packRow!.unit_revision),
        packRow!.panel_id,
        Number(packRow!.panel_index),
        now,
      );
      insert.run(
        resultIds.labeled,
        dispatchRow!.dispatch_id,
        generationRunId,
        "labeled",
        labeledMediaSha256,
        packId,
        packFingerprint,
        packRow!.unit_id,
        Number(packRow!.unit_revision),
        packRow!.panel_id,
        Number(packRow!.panel_index),
        now,
      );
      if (protocolV2) {
        insertCallEvent(writeDb, {
          call: latestCall!,
          kind: "result-committed",
          evidenceReference: `result-bundle:${generationRunId}`,
          evidenceFingerprint: stableDigest({
            schemaVersion: 1,
            generationRunId,
            rawResultId: resultIds.raw,
            rawMediaSha256,
            labeledResultId: resultIds.labeled,
            labeledMediaSha256,
          }),
          note: "raw/labeled bundle 与 call 终态在同一 ledger transaction 原子提交。",
          now,
        });
      }
      // T11：raw/labeled 两行、call 终态与画布投影事件在同一 SQLite 事务内
      // 原子提交；上面的 existing 幂等返回分支不重复追加。
      appendCanvasProjectionEvent(writeDb, {
        kind: "result-committed",
        unitId: packRow!.unit_id,
        panelId: packRow!.panel_id,
        generationRunId,
        payload: {
          packId,
          packFingerprint,
          rawResultId: resultIds.raw,
          rawMediaSha256,
          labeledResultId: resultIds.labeled,
          labeledMediaSha256,
          targetKind: latestTarget ? "unit-grid" : "panel",
        },
      });
      return [
        resultRowByRunVariant(writeDb, generationRunId, "raw")!,
        resultRowByRunVariant(writeDb, generationRunId, "labeled")!,
      ];
    });
  } finally {
    writeDb.close();
  }
  const projected = await projectResultRowsWithFreshDatabase(paths, written);
  return bundleRecord(
    projected.find((item) => item.variant === "raw")!,
    projected.find((item) => item.variant === "labeled")!,
  );
}

/** 不写入地读取已成对的 v4 投影；历史单边结果返回 null。 */
export async function readStudioGenerationResultBundle(
  projectRoot: string,
  generationRunId: string,
): Promise<StudioGenerationResultBundleRecord | null> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const normalizedRunId = normalizeId(generationRunId, "generationRunId");
  const db = openDatabase(paths);
  let rows: ResultRow[];
  try {
    rows = db.prepare("SELECT * FROM studio_generation_results WHERE generation_run_id = ? ORDER BY sequence")
      .all(normalizedRunId) as unknown as ResultRow[];
  } finally {
    db.close();
  }
  if (rows.length === 0) return null;
  if (rows.length !== 2 || !rows.some((row) => row.variant === "raw") || !rows.some((row) => row.variant === "labeled")) {
    return null;
  }
  const projected = await projectResultRowsWithFreshDatabase(paths, rows);
  return bundleRecord(
    projected.find((item) => item.variant === "raw")!,
    projected.find((item) => item.variant === "labeled")!,
  );
}

export async function readStudioGenerationResult(
  projectRoot: string,
  resultId: string,
): Promise<StudioGenerationResultRecord | null> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const normalizedResultId = normalizeId(resultId, "resultId");
  const db = openDatabase(paths);
  let row: ResultRow | undefined;
  try {
    row = db.prepare("SELECT * FROM studio_generation_results WHERE result_id = ?")
      .get(normalizedResultId) as unknown as ResultRow | undefined;
  } finally {
    db.close();
  }
  if (!row) return null;
  return (await projectResultRowsWithFreshDatabase(paths, [row]))[0]!;
}

/** Review/promote 写入面的单一强制门禁：输入过期、文件漂移或缺少 raw/labeled 任一项都拒绝。 */
export async function assertStudioGenerationResultPromotionEligible(
  projectRoot: string,
  resultId: string,
): Promise<StudioGenerationResultRecord> {
  const result = await readStudioGenerationResult(projectRoot, resultId);
  if (!result) fail("result-not-found", `generation result 不存在：${resultId}`);
  const { paths } = await managedLedgerPaths(projectRoot);
  const db = openDatabase(paths);
  let row: PackRow | undefined;
  try {
    row = packRowById(db, result.packId);
  } finally {
    db.close();
  }
  if (!row) fail("pack-not-found", `generation result ${result.resultId} 的冻结包不存在：${result.packId}`);
  const pack = await readAnyPackFromRow(paths, row);
  assertAnyPackDispatchable(pack);
  if (!result.promotionEligible) {
    fail(
      "result-promotion-ineligible",
      `generation result ${result.resultId} 不允许 review/promote。`,
      [
        `pairComplete=${result.pairComplete}`,
        `inputCurrent=${result.inputCurrent}`,
        ...result.staleReasons,
      ],
    );
  }
  return result;
}

function normalizeLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    fail("invalid-input", `limit 必须是 1-${MAX_PAGE_LIMIT} 的整数。`);
  }
  return value;
}

function cursorScope(unitId: string, panelId: string, order: "oldest-first" | "newest-first"): string {
  const legacyCompatibleScope = order === "oldest-first"
    ? `${unitId}\u0000${panelId}`
    : `${unitId}\u0000${panelId}\u0000newest-first`;
  return createHash("sha256").update(legacyCompatibleScope, "utf8").digest("hex").slice(0, 24);
}

function encodeCursor(scope: string, sequence: number): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, sequence }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined, scope: string): number | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      scope?: unknown;
      sequence?: unknown;
    };
    if (parsed.v !== 1
      || parsed.scope !== scope
      || !Number.isSafeInteger(parsed.sequence)
      || Number(parsed.sequence) < 1) throw new Error("invalid");
    return Number(parsed.sequence);
  } catch {
    fail("invalid-cursor", "分页 cursor 无效或不属于当前查询。");
  }
}

export async function listStudioGenerationPanelHistory(
  projectRoot: string,
  query: StudioGenerationPanelHistoryQuery,
): Promise<StudioGenerationPanelHistoryPage> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const unitId = normalizeId(query.unitId, "unitId");
  const panelId = normalizeId(query.panelId, "panelId");
  const limit = normalizeLimit(query.limit);
  const order = query.order ?? "oldest-first";
  if (order !== "oldest-first" && order !== "newest-first") {
    fail("invalid-input", `order 非法：${String(order)}`);
  }
  const scope = cursorScope(unitId, panelId, order);
  const after = decodeCursor(query.cursor, scope);
  const db = openDatabase(paths);
  let selected: ResultRow[];
  let nextCursor: string | undefined;
  try {
    const rows = (order === "newest-first"
      ? (after === undefined
        ? db.prepare(`
            SELECT * FROM studio_generation_results
            WHERE unit_id = ? AND panel_id = ?
              AND NOT EXISTS (SELECT 1 FROM studio_generation_pack_targets t
                WHERE t.pack_id = studio_generation_results.pack_id
                  AND t.pack_fingerprint = studio_generation_results.pack_fingerprint)
            ORDER BY sequence DESC LIMIT ?
          `).all(unitId, panelId, limit + 1)
        : db.prepare(`
            SELECT * FROM studio_generation_results
            WHERE unit_id = ? AND panel_id = ? AND sequence < ?
              AND NOT EXISTS (SELECT 1 FROM studio_generation_pack_targets t
                WHERE t.pack_id = studio_generation_results.pack_id
                  AND t.pack_fingerprint = studio_generation_results.pack_fingerprint)
            ORDER BY sequence DESC LIMIT ?
          `).all(unitId, panelId, after, limit + 1))
      : (after === undefined
        ? db.prepare(`
            SELECT * FROM studio_generation_results
            WHERE unit_id = ? AND panel_id = ?
              AND NOT EXISTS (SELECT 1 FROM studio_generation_pack_targets t
                WHERE t.pack_id = studio_generation_results.pack_id
                  AND t.pack_fingerprint = studio_generation_results.pack_fingerprint)
            ORDER BY sequence LIMIT ?
          `).all(unitId, panelId, limit + 1)
        : db.prepare(`
            SELECT * FROM studio_generation_results
            WHERE unit_id = ? AND panel_id = ? AND sequence > ?
              AND NOT EXISTS (SELECT 1 FROM studio_generation_pack_targets t
                WHERE t.pack_id = studio_generation_results.pack_id
                  AND t.pack_fingerprint = studio_generation_results.pack_fingerprint)
            ORDER BY sequence LIMIT ?
          `).all(unitId, panelId, after, limit + 1))) as unknown as ResultRow[];
    selected = rows.slice(0, limit);
    nextCursor = rows.length > limit
      ? encodeCursor(scope, Number(selected[selected.length - 1]!.sequence))
      : undefined;
  } finally {
    db.close();
  }
  return {
    items: await projectResultRowsWithFreshDatabase(paths, selected),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function unitGridHistoryCursorScope(unitId: string, order: "oldest-first" | "newest-first"): string {
  return createHash("sha256")
    .update(`unit-grid-history\u0000${unitId}\u0000${order}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

/**
 * P30：按正式 unit-grid target 列结果历史。查询只依赖 pack target owner，
 * 不把 packs/results 中为旧表兼容保留的 panel_id 当成目标身份。
 */
export async function listStudioGenerationUnitGridHistory(
  projectRoot: string,
  query: StudioGenerationUnitGridHistoryQuery,
): Promise<StudioGenerationPanelHistoryPage> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const unitId = normalizeId(query.unitId, "unitId");
  const targetKey = `unit-grid:${unitId}`;
  const limit = normalizeLimit(query.limit);
  const order = query.order ?? "oldest-first";
  if (order !== "oldest-first" && order !== "newest-first") {
    fail("invalid-input", `order 非法：${String(order)}`);
  }
  const scope = unitGridHistoryCursorScope(unitId, order);
  const after = decodeCursor(query.cursor, scope);
  const db = openDatabase(paths);
  let selected: ResultRow[];
  let nextCursor: string | undefined;
  try {
    const rows = (order === "newest-first"
      ? (after === undefined
        ? db.prepare(`
            SELECT result.* FROM studio_generation_results result
            JOIN studio_generation_pack_targets target
              ON target.pack_id = result.pack_id AND target.pack_fingerprint = result.pack_fingerprint
            WHERE target.target_kind = 'unit-grid' AND target.target_key = ? AND target.unit_id = ?
            ORDER BY result.sequence DESC LIMIT ?
          `).all(targetKey, unitId, limit + 1)
        : db.prepare(`
            SELECT result.* FROM studio_generation_results result
            JOIN studio_generation_pack_targets target
              ON target.pack_id = result.pack_id AND target.pack_fingerprint = result.pack_fingerprint
            WHERE target.target_kind = 'unit-grid' AND target.target_key = ? AND target.unit_id = ?
              AND result.sequence < ?
            ORDER BY result.sequence DESC LIMIT ?
          `).all(targetKey, unitId, after, limit + 1))
      : (after === undefined
        ? db.prepare(`
            SELECT result.* FROM studio_generation_results result
            JOIN studio_generation_pack_targets target
              ON target.pack_id = result.pack_id AND target.pack_fingerprint = result.pack_fingerprint
            WHERE target.target_kind = 'unit-grid' AND target.target_key = ? AND target.unit_id = ?
            ORDER BY result.sequence LIMIT ?
          `).all(targetKey, unitId, limit + 1)
        : db.prepare(`
            SELECT result.* FROM studio_generation_results result
            JOIN studio_generation_pack_targets target
              ON target.pack_id = result.pack_id AND target.pack_fingerprint = result.pack_fingerprint
            WHERE target.target_kind = 'unit-grid' AND target.target_key = ? AND target.unit_id = ?
              AND result.sequence > ?
            ORDER BY result.sequence LIMIT ?
          `).all(targetKey, unitId, after, limit + 1))) as unknown as ResultRow[];
    selected = rows.slice(0, limit);
    nextCursor = rows.length > limit
      ? encodeCursor(scope, Number(selected[selected.length - 1]!.sequence))
      : undefined;
  } finally {
    db.close();
  }
  return {
    items: await projectResultRowsWithFreshDatabase(paths, selected),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

/* ------------------------------------------------------------------------ */
/* P21：生成计划 / 运行事件 / 取消 / 失败 / 幂等重试 / 逐节点投影            */
/* ------------------------------------------------------------------------ */

export type StudioGenerationPlanTargetIdentity =
  | { targetKind: "panel"; targetKey: string; unitId: string; panelId: string }
  | { targetKind: "unit-grid"; targetKey: string; unitId: string };

export type StudioGenerationPlanRecordNode = StudioGenerationPlanTargetIdentity & {
  nodeIndex: number;
  packId: string;
  packFingerprint: string;
};

export interface StudioGenerationPlanRecord {
  planId: string;
  projectId: string;
  sourceCommandRequestId: string;
  nodeCount: number;
  createdAt: string;
  idempotentReplay: boolean;
  nodes: StudioGenerationPlanRecordNode[];
}

export interface StudioGenerationRunEventRecord {
  eventId: string;
  generationRunId: string;
  planId: string | null;
  nodeIndex: number | null;
  kind: StudioGenerationRunEventKind;
  attempt: number;
  supersedesRunId: string | null;
  detail: unknown;
  createdAt: string;
}

export type StudioGenerationPlanNodeStatus = "planned" | "dispatched" | "succeeded" | "failed" | "cancelled" | "retry-superseded";

export type StudioGenerationPlanNodeProjection = StudioGenerationPlanTargetIdentity & {
  nodeIndex: number;
  packId: string;
  packFingerprint: string;
  packStale: boolean;
  generationRunId: string;
  attempt: number;
  adopted: boolean;
  status: StudioGenerationPlanNodeStatus;
  lastEventAt: string | null;
  resultId: string | null;
  errorClass: string | null;
  errorDetail: string | null;
};

export interface StudioGenerationPlanProjection {
  planId: string;
  projectId: string;
  sourceCommandRequestId: string;
  nodeCount: number;
  createdAt: string;
  nodes: StudioGenerationPlanNodeProjection[];
}

function planRecord(db: DatabaseSync, row: PlanRow, idempotentReplay: boolean): StudioGenerationPlanRecord {
  return {
    planId: row.plan_id,
    projectId: row.project_id,
    sourceCommandRequestId: row.source_command_request_id,
    nodeCount: Number(row.node_count),
    createdAt: row.created_at,
    idempotentReplay,
    nodes: planNodesByPlan(db, row.plan_id).map((node) => {
      const target = planNodeTargetRow(db, node.plan_id, Number(node.node_index));
      const common = {
        nodeIndex: Number(node.node_index),
        packId: node.pack_id,
        packFingerprint: node.pack_fingerprint,
      };
      return target
        ? {
            ...common,
            targetKind: "unit-grid" as const,
            targetKey: target.target_key,
            unitId: node.unit_id,
          }
        : {
            ...common,
            targetKind: "panel" as const,
            targetKey: `panel:${node.unit_id}:${node.panel_id}`,
            unitId: node.unit_id,
            panelId: node.panel_id,
          };
    }),
  };
}

function runEventRecord(row: RunEventRow): StudioGenerationRunEventRecord {
  let detail: unknown = {};
  try {
    detail = JSON.parse(row.detail_json);
  } catch {
    fail("storage-invalid", `run event ${row.event_id} 的 detail_json 损坏。`);
  }
  return {
    eventId: row.event_id,
    generationRunId: row.generation_run_id,
    planId: row.plan_id,
    nodeIndex: row.node_index === null ? null : Number(row.node_index),
    kind: row.kind,
    attempt: Number(row.attempt),
    supersedesRunId: row.supersedes_run_id,
    detail,
    createdAt: row.created_at,
  };
}

function latestDispatchByPack(db: DatabaseSync, packId: string, packFingerprint: string): DispatchRow | undefined {
  return db.prepare(`SELECT * FROM studio_generation_dispatches
    WHERE pack_id = ? AND pack_fingerprint = ? ORDER BY sequence DESC LIMIT 1`)
    .get(packId, packFingerprint) as unknown as DispatchRow | undefined;
}

function newestPackFingerprintForPanel(db: DatabaseSync, unitId: string, panelId: string): string | null {
  const row = db.prepare(`SELECT p.fingerprint FROM studio_generation_packs p
    LEFT JOIN studio_generation_pack_targets target
      ON target.pack_id = p.pack_id AND target.pack_fingerprint = p.fingerprint
    WHERE target.pack_id IS NULL AND p.unit_id = ? AND p.panel_id = ?
    ORDER BY p.sequence DESC LIMIT 1`)
    .get(unitId, panelId) as { fingerprint?: string } | undefined;
  return row?.fingerprint ?? null;
}

function newestPackFingerprintForUnitGrid(db: DatabaseSync, targetKey: string): string | null {
  const row = db.prepare(`SELECT p.fingerprint FROM studio_generation_packs p
    JOIN studio_generation_pack_targets target
      ON target.pack_id = p.pack_id AND target.pack_fingerprint = p.fingerprint
    WHERE target.target_kind = 'unit-grid' AND target.target_key = ?
    ORDER BY p.sequence DESC LIMIT 1`)
    .get(targetKey) as { fingerprint?: string } | undefined;
  return row?.fingerprint ?? null;
}

export type StudioGenerationPlanNodeInput =
  | { targetKind?: "panel"; unitId: string; panelId: string }
  | { targetKind: "unit-grid"; unitId: string };

type NormalizedPlanNode =
  | { targetKind: "panel"; targetKey: string; unitId: string; panelId: string }
  | { targetKind: "unit-grid"; targetKey: string; unitId: string };

function normalizePlanNodeList(input: unknown): NormalizedPlanNode[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 36) {
    fail("invalid-input", "nodes 必须是 1-36 项数组。");
  }
  const seen = new Set<string>();
  return input.map((entry, offset) => {
    const candidate = entry as { targetKind?: unknown; unitId?: unknown; panelId?: unknown };
    const unitId = normalizeId(candidate?.unitId as string, `nodes[${offset}].unitId`);
    const targetKind = candidate?.targetKind ?? "panel";
    if (targetKind === "unit-grid") {
      if (candidate.panelId !== undefined) {
        fail("invalid-input", `nodes[${offset}] unit-grid 不得携带 panelId 兼容锚点。`);
      }
      const targetKey = `unit-grid:${unitId}`;
      if (seen.has(targetKey)) fail("invalid-input", `nodes 含重复 target：${targetKey}。`);
      seen.add(targetKey);
      return { targetKind: "unit-grid", targetKey, unitId };
    }
    if (targetKind !== "panel") fail("invalid-input", `nodes[${offset}].targetKind 只能是 panel 或 unit-grid。`);
    const panelId = normalizeId(candidate.panelId as string, `nodes[${offset}].panelId`);
    const targetKey = `panel:${unitId}:${panelId}`;
    if (seen.has(targetKey)) fail("invalid-input", `nodes 含重复 target：${targetKey}。`);
    seen.add(targetKey);
    return { targetKind: "panel", targetKey, unitId, panelId };
  });
}

/**
 * 创建生成计划（内容寻址幂等）：逐节点要求 pack 已冻结且 current；
 * 事务内只建 plan+nodes——不派发（dispatches 行数不变），节点初始状态 planned。
 */
export async function createStudioGenerationPlan(
  projectRoot: string,
  input: { nodes: StudioGenerationPlanNodeInput[]; sourceCommandRequestId: string },
): Promise<StudioGenerationPlanRecord> {
  const { paths, projectId } = await managedLedgerPaths(projectRoot);
  const nodes = normalizePlanNodeList(input.nodes);
  const sourceCommandRequestId = normalizeId(input.sourceCommandRequestId, "sourceCommandRequestId");
  const readDb = openDatabase(paths);
  const selected: Array<{ packRow: PackRow; targetRow?: PackTargetRow }> = [];
  try {
    for (const node of nodes) {
      const row = (node.targetKind === "unit-grid"
        ? readDb.prepare(`SELECT p.* FROM studio_generation_packs p
            JOIN studio_generation_pack_targets target
              ON target.pack_id = p.pack_id AND target.pack_fingerprint = p.fingerprint
            WHERE target.target_kind = 'unit-grid' AND target.target_key = ?
            ORDER BY p.sequence DESC LIMIT 1`).get(node.targetKey)
        : readDb.prepare(`SELECT p.* FROM studio_generation_packs p
            LEFT JOIN studio_generation_pack_targets target
              ON target.pack_id = p.pack_id AND target.pack_fingerprint = p.fingerprint
            WHERE target.pack_id IS NULL AND p.unit_id = ? AND p.panel_id = ?
            ORDER BY p.sequence DESC LIMIT 1`).get(node.unitId, node.panelId)) as unknown as PackRow | undefined;
      if (!row) {
        fail(
          "pack-not-found",
          `target=${node.targetKey} 尚无已冻结 generation pack；freeze 是显式前置步骤。`,
        );
      }
      selected.push({ packRow: row, targetRow: packTargetRowById(readDb, row.pack_id) });
    }
  } finally {
    readDb.close();
  }
  // 逐节点 currentness 预检（与公开 dispatch 同门禁）。
  for (const item of selected) {
    const pack = await readAnyPackFromRow(paths, item.packRow);
    assertAnyPackDispatchable(pack);
    await assertAnyPackCurrent(paths.root, pack);
  }
  const nodeSpecs = nodes.map((node, offset) => ({
    nodeIndex: offset + 1,
    targetKind: node.targetKind,
    targetKey: node.targetKey,
    targetFingerprint: targetIdentityFromRows(selected[offset]!.packRow, selected[offset]!.targetRow).targetFingerprint,
    unitId: node.unitId,
    unitRevision: Number(selected[offset]!.packRow.unit_revision),
    // 旧列仅作存储兼容；unit-grid 对外投影永不返回此 anchor。
    panelId: node.targetKind === "panel" ? node.panelId : selected[offset]!.packRow.panel_id,
    packId: selected[offset]!.packRow.pack_id,
    packFingerprint: selected[offset]!.packRow.fingerprint,
  }));
  const allPanel = nodeSpecs.every((node) => node.targetKind === "panel");
  const planIdentityNodes = allPanel
    ? nodeSpecs.map(({ nodeIndex, unitId, panelId, packId, packFingerprint }) => ({
        nodeIndex, unitId, panelId, packId, packFingerprint,
      }))
    : nodeSpecs.map((node) => ({
        nodeIndex: node.nodeIndex,
        targetKind: node.targetKind,
        targetKey: node.targetKey,
        targetFingerprint: node.targetFingerprint,
        unitId: node.unitId,
        unitRevision: node.unitRevision,
        ...(node.targetKind === "panel" ? { panelId: node.panelId } : {}),
        packId: node.packId,
        packFingerprint: node.packFingerprint,
      }));
  const planId = stableDigest({ schemaVersion: allPanel ? 1 : 2, projectId, nodes: planIdentityNodes });
  const writeDb = openDatabase(paths);
  try {
    return runTransaction(writeDb, () => {
      const existing = planRowById(writeDb, planId);
      if (existing) return planRecord(writeDb, existing, true);
      // 逐节点 panel 互斥闸（规范 §2.3-1）：in-flight 宫格拒绝建 plan，detail 含 blocking runId 引导先取消。
      for (const spec of nodeSpecs) {
        const currentPack = packRowById(writeDb, spec.packId);
        const currentTarget = packTargetRowById(writeDb, spec.packId);
        if (!currentPack || currentPack.fingerprint !== spec.packFingerprint
          || (spec.targetKind === "unit-grid"
            ? !currentTarget || currentTarget.target_key !== spec.targetKey
            : Boolean(currentTarget))) {
          fail("pack-index-conflict", `plan target=${spec.targetKey} 的 pack/target 在建计划期间漂移。`);
        }
        if (spec.targetKind === "unit-grid") {
          assertUnitGridNotInFlight(writeDb, { targetKey: spec.targetKey, excludeRunId: "" });
        } else {
          assertPanelNotInFlight(writeDb, { unitId: spec.unitId, panelId: spec.panelId, excludeRunId: "" });
        }
      }
      const now = new Date().toISOString();
      writeDb.prepare(`
        INSERT INTO studio_generation_plans(plan_id, project_id, source_command_request_id, node_count, created_at)
        VALUES(?, ?, ?, ?, ?)
      `).run(planId, projectId, sourceCommandRequestId, nodeSpecs.length, now);
      const insertNode = writeDb.prepare(`
        INSERT INTO studio_generation_plan_nodes(plan_id, node_index, unit_id, panel_id, pack_id, pack_fingerprint, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `);
      const insertTarget = writeDb.prepare(`
        INSERT INTO studio_generation_plan_node_targets(
          plan_id, node_index, target_kind, target_key, target_fingerprint, unit_id, unit_revision, created_at
        ) VALUES(?, ?, 'unit-grid', ?, ?, ?, ?, ?)
      `);
      for (const spec of nodeSpecs) {
        insertNode.run(planId, spec.nodeIndex, spec.unitId, spec.panelId, spec.packId, spec.packFingerprint, now);
        if (spec.targetKind === "unit-grid") {
          insertTarget.run(
            planId,
            spec.nodeIndex,
            spec.targetKey,
            spec.targetFingerprint,
            spec.unitId,
            spec.unitRevision,
            now,
          );
        }
      }
      return planRecord(writeDb, planRowById(writeDb, planId)!, false);
    });
  } finally {
    writeDb.close();
  }
}

function runEventPlanLinkage(db: DatabaseSync, generationRunId: string): { planId: string | null; nodeIndex: number | null; attempt: number } {
  const parsed = parsePlanRunId(generationRunId);
  if (parsed && planRowById(db, parsed.planId)) {
    return { planId: parsed.planId, nodeIndex: parsed.nodeIndex, attempt: parsed.attempt };
  }
  return { planId: null, nodeIndex: null, attempt: 1 };
}

/**
 * Owner 显式封存无法再证明远端状态的 generation_unknown。
 *
 * 该动作只终止本地账本 run，不声称远端未调用，也不删除 quarantine。旧 run 的
 * cancelled EXISTS 事实会永久拒绝迟到结果；新 attempt 必须由既有 retry 命令另行创建。
 */
export async function abandonStudioGenerationUnknown(
  projectRoot: string,
  input: AbandonStudioGenerationUnknownInput,
): Promise<StudioGenerationRunEventRecord> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const callId = normalizeId(input.callId, "callId");
  const generationRunId = normalizeId(input.generationRunId, "generationRunId");
  const projectContextToken = normalizeEvidenceReference(input.projectContextToken, "projectContextToken");
  if (!/^studioctx-v1-[a-f0-9]{64}$/u.test(projectContextToken)) {
    fail("invalid-input", "projectContextToken 格式无效。");
  }
  const evidenceReference = normalizeEvidenceReference(input.evidenceReference, "evidenceReference");
  const evidenceFingerprint = normalizeSha256(input.evidenceFingerprint, "evidenceFingerprint");
  const reason = typeof input.reason === "string" ? input.reason.normalize("NFC").trim() : "";
  if (reason.length < 8 || reason.length > 500 || /\p{Cc}/u.test(reason)) {
    fail("invalid-input", "reason 必须是 8-500 字符且不含控制字符。");
  }
  if (input.acknowledgeRemoteMayExist !== true || input.acknowledgeLateResultWillBeRejected !== true) {
    fail(
      "invalid-input",
      "封存 generation_unknown 必须明确确认远端调用可能存在，且迟到结果将被永久拒收。",
    );
  }
  const expectedDetail = studioGenerationUnknownOwnerAbandonDetail({
    evidenceReference,
    evidenceFingerprint,
    reason,
  });
  const writeDb = openDatabase(paths);
  try {
    return runTransaction(writeDb, () => {
      const call = callIntentRowById(writeDb, callId);
      if (!call) fail("call-intent-required", `imagegen call intent 不存在：${callId}`);
      if (call.generation_run_id !== generationRunId) {
        fail(
          "call-intent-conflict",
          `callId=${callId} 不属于 generationRunId=${generationRunId}，禁止封存其他 run。`,
        );
      }
      if (call.target_kind !== "unit-grid") {
        fail("call-intent-conflict", `owner abandon 仅允许 unit-grid call：${callId}`);
      }
      const dispatch = dispatchRowByRun(writeDb, generationRunId);
      if (!dispatch || dispatch.dispatch_id !== call.dispatch_id) {
        fail("dispatch-not-found", `generationRunId=${generationRunId} 缺少与 call 一致的 dispatch intent。`);
      }
      assertNoActiveConnectorReservation(writeDb, generationRunId);

      const existingOwnerEvents = ownerAbandonCancelledEvents(writeDb, generationRunId);
      if (existingOwnerEvents.length > 1) {
        fail("storage-invalid", `generationRunId=${generationRunId} 存在多个 owner abandon 终态。`);
      }
      if (existingOwnerEvents.length === 1) {
        const existing = runEventRecord(existingOwnerEvents[0]!);
        if (!sameStudioGenerationUnknownOwnerAbandonDetail(existing.detail, expectedDetail)) {
          fail(
            "call-intent-conflict",
            `imagegen call ${callId} 已用其他证据封存，禁止改写 owner abandon 事实。`,
          );
        }
        const matchingRequests = (writeDb.prepare(`SELECT * FROM studio_generation_run_events
          WHERE generation_run_id = ? AND kind = 'cancel-requested' ORDER BY sequence`)
          .all(generationRunId) as unknown as RunEventRow[])
          .filter((row) => sameStudioGenerationUnknownOwnerAbandonDetail(runEventRecord(row).detail, expectedDetail));
        if (matchingRequests.length !== 1) {
          fail("storage-invalid", `generationRunId=${generationRunId} 的 owner abandon 请求/终态不成对。`);
        }
        return existing;
      }

      if (contextRebindEvents(writeDb, call).length > 0) {
        fail(
          "call-intent-conflict",
          `imagegen call ${callId} 已用既有 candidate/receipt rebind 到当前上下文，禁止 owner abandon 后重试。`,
        );
      }

      const status = callIntentStatus(writeDb, call);
      if (status !== "generation_unknown") {
        fail("call-intent-conflict", `imagegen call ${callId} 当前状态为 ${status}，只能封存 generation_unknown。`);
      }
      const resultCount = Number((writeDb.prepare(
        "SELECT COUNT(*) AS count FROM studio_generation_results WHERE generation_run_id = ?",
      ).get(generationRunId) as { count: number }).count);
      if (resultCount > 0) {
        fail("call-intent-conflict", `generationRunId=${generationRunId} 已有结果行，禁止 owner abandon。`);
      }
      const terminal = runTerminalState(writeDb, generationRunId);
      if (terminal) {
        fail("run-terminal", `generationRunId=${generationRunId} 已是终态 ${terminal}，禁止 owner abandon。`);
      }
      if (latestRunEvent(writeDb, generationRunId)?.kind === "cancel-requested") {
        fail("storage-invalid", `generationRunId=${generationRunId} 存在未闭合的 cancel-requested。`);
      }

      const linkage = runEventPlanLinkage(writeDb, generationRunId);
      const now = new Date().toISOString();
      insertRunEvent(writeDb, {
        generationRunId,
        planId: linkage.planId,
        nodeIndex: linkage.nodeIndex,
        kind: "cancel-requested",
        attempt: linkage.attempt,
        detail: expectedDetail,
        now,
      });
      return runEventRecord(insertRunEvent(writeDb, {
        generationRunId,
        planId: linkage.planId,
        nodeIndex: linkage.nodeIndex,
        kind: "cancelled",
        attempt: linkage.attempt,
        detail: expectedDetail,
        now,
      }));
    });
  } finally {
    writeDb.close();
  }
}

/** 登记失败（P21）：仅无 result 且无终态事件；同内容重复幂等，异内容冲突。 */
export async function failStudioGenerationRun(
  projectRoot: string,
  input: { generationRunId: string; errorClass: string; detail?: string },
): Promise<StudioGenerationRunEventRecord> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const generationRunId = normalizeId(input.generationRunId, "generationRunId");
  const errorClass = normalizeId(input.errorClass, "errorClass");
  const detail = typeof input.detail === "string" ? input.detail.slice(0, 500) : "";
  const writeDb = openDatabase(paths);
  try {
    return runTransaction(writeDb, () => {
      const dispatchRow = dispatchRowByRun(writeDb, generationRunId);
      if (!dispatchRow) {
        fail("dispatch-not-found", `generationRunId=${generationRunId} 未追加 local dispatch intent，禁止登记失败。`);
      }
      assertNoActiveConnectorReservation(writeDb, generationRunId);
      assertRunNotGenerationUnknown(writeDb, generationRunId);
      const terminal = runTerminalState(writeDb, generationRunId);
      if (terminal === "succeeded") {
        fail("run-terminal", `generationRunId=${generationRunId} 已存在结果，禁止登记失败。`);
      }
      const latest = latestRunEvent(writeDb, generationRunId);
      if (latest?.kind === "failed") {
        const existing = runEventRecord(latest);
        const existingDetail = existing.detail as { errorClass?: unknown; detail?: unknown };
        if (existingDetail.errorClass === errorClass && (existingDetail.detail ?? "") === detail) {
          return existing;
        }
        fail("run-terminal", `generationRunId=${generationRunId} 已有不同内容的 failed 事件，禁止改写失败事实。`);
      }
      if (terminal) fail("run-terminal", `generationRunId=${generationRunId} 已是终态 ${terminal}，禁止登记失败。`);
      const linkage = runEventPlanLinkage(writeDb, generationRunId);
      return runEventRecord(insertRunEvent(writeDb, {
        generationRunId,
        planId: linkage.planId,
        nodeIndex: linkage.nodeIndex,
        kind: "failed",
        attempt: linkage.attempt,
        detail: { errorClass, detail },
        now: new Date().toISOString(),
      }));
    });
  } finally {
    writeDb.close();
  }
}

/** 取消（P21）：仅停止账本跟踪，不撤回已派发意图；同事务写 cancel-requested+cancelled。 */
export async function cancelStudioGenerationRun(
  projectRoot: string,
  input: { generationRunId: string; reason?: string },
): Promise<StudioGenerationRunEventRecord> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const generationRunId = normalizeId(input.generationRunId, "generationRunId");
  const reason = typeof input.reason === "string" ? input.reason.slice(0, 200) : "";
  const writeDb = openDatabase(paths);
  try {
    return runTransaction(writeDb, () => {
      const dispatchRow = dispatchRowByRun(writeDb, generationRunId);
      if (!dispatchRow) {
        fail("dispatch-not-found", `generationRunId=${generationRunId} 未追加 local dispatch intent，禁止取消。`);
      }
      assertNoActiveConnectorReservation(writeDb, generationRunId);
      assertRunNotGenerationUnknown(writeDb, generationRunId);
      const terminal = runTerminalState(writeDb, generationRunId);
      if (terminal === "succeeded") {
        fail("run-terminal", `generationRunId=${generationRunId} 已存在结果，禁止取消（run-already-has-result）。`);
      }
      const latest = latestRunEvent(writeDb, generationRunId);
      if (latest?.kind === "cancelled") return runEventRecord(latest);
      if (terminal) fail("run-terminal", `generationRunId=${generationRunId} 已是终态 ${terminal}，禁止取消。`);
      const linkage = runEventPlanLinkage(writeDb, generationRunId);
      const now = new Date().toISOString();
      insertRunEvent(writeDb, {
        generationRunId,
        planId: linkage.planId,
        nodeIndex: linkage.nodeIndex,
        kind: "cancel-requested",
        attempt: linkage.attempt,
        detail: { reason },
        now,
      });
      return runEventRecord(insertRunEvent(writeDb, {
        generationRunId,
        planId: linkage.planId,
        nodeIndex: linkage.nodeIndex,
        kind: "cancelled",
        attempt: linkage.attempt,
        detail: { reason },
        now,
      }));
    });
  } finally {
    writeDb.close();
  }
}

export interface StudioGenerationPlanRetryOutcome {
  planId: string;
  retried: Array<{
    nodeIndex: number;
    generationRunId: string;
    attempt: number;
    supersedesRunId: string;
    idempotentReplay: boolean;
  }>;
  skipped: Array<{ nodeIndex: number; reason: string }>;
}

interface CurrentReworkReviewRetryAuthority {
  reviewId: string;
  reviewFingerprint: string;
  rawResultId: string;
  rawSha256: string;
  labeledResultId: string;
  labeledSha256: string;
}

/**
 * succeeded run 只在“当前 Review Head 对应当前 raw/labeled 结果对且明确 REWORK”时可重试。
 *
 * Review 与 generation 共用同一 SQLite；这里直接核对只读事实，避免 ledger 反向 import
 * studio-generation-review 形成循环依赖。无 Review、PASS/REJECT、非 Head 的旧 REWORK、
 * 错配结果对或静态 stale 标记一律返回 null。
 */
function currentReworkReviewRetryAuthority(
  db: DatabaseSync,
  generationRunId: string,
): CurrentReworkReviewRetryAuthority | null {
  const reviewSchema = db.prepare(
    "SELECT value FROM studio_generation_ledger_meta WHERE key='p7_review_schema_version'",
  ).get() as { value?: string } | undefined;
  if (!reviewSchema) return null;
  if (reviewSchema.value !== "1"
    || !tableExists(db, "studio_generation_review_events")
    || !tableExists(db, "studio_generation_review_heads")) {
    fail("storage-invalid", "generation retry 读取到不完整或不受支持的 Review schema。");
  }
  const raw = resultRowByRunVariant(db, generationRunId, "raw");
  const labeled = resultRowByRunVariant(db, generationRunId, "labeled");
  if (!raw || !labeled) return null;
  const row = db.prepare(`
    SELECT
      head.review_id AS reviewId,
      head.review_fingerprint AS reviewFingerprint,
      review.raw_result_id AS rawResultId,
      review.raw_sha256 AS rawSha256,
      review.labeled_result_id AS labeledResultId,
      review.labeled_sha256 AS labeledSha256,
      review.pack_id AS packId,
      review.pack_fingerprint AS packFingerprint,
      review.decision AS decision,
      review.current_at_submission AS currentAtSubmission,
      review.advances_head AS advancesHead,
      review.fingerprint AS fingerprint
    FROM studio_generation_review_heads head
    JOIN studio_generation_review_events review
      ON review.review_id = head.review_id
     AND review.generation_run_id = head.generation_run_id
    WHERE head.generation_run_id = ?
  `).get(generationRunId) as {
    reviewId: string;
    reviewFingerprint: string;
    rawResultId: string;
    rawSha256: string;
    labeledResultId: string;
    labeledSha256: string;
    packId: string;
    packFingerprint: string;
    decision: string;
    currentAtSubmission: number;
    advancesHead: number;
    fingerprint: string;
  } | undefined;
  if (!row
    || row.decision !== "rework"
    || Number(row.currentAtSubmission) !== 1
    || Number(row.advancesHead) !== 1
    || row.reviewFingerprint !== row.fingerprint
    || row.rawResultId !== raw.result_id
    || row.rawSha256 !== raw.media_sha256
    || row.labeledResultId !== labeled.result_id
    || row.labeledSha256 !== labeled.media_sha256
    || row.packId !== raw.pack_id
    || row.packFingerprint !== raw.pack_fingerprint
    || labeled.pack_id !== raw.pack_id
    || labeled.pack_fingerprint !== raw.pack_fingerprint
    || raw.status !== "pending"
    || labeled.status !== "pending"
    || Number(raw.input_current) !== 1
    || Number(labeled.input_current) !== 1
    || Number(raw.promotion_eligible) !== 1
    || Number(labeled.promotion_eligible) !== 1) {
    return null;
  }
  return {
    reviewId: row.reviewId,
    reviewFingerprint: row.reviewFingerprint,
    rawResultId: row.rawResultId,
    rawSha256: row.rawSha256,
    labeledResultId: row.labeledResultId,
    labeledSha256: row.labeledSha256,
  };
}

/** 节点重试的下一 attempt：dispatched 事件 max+1，无则 1（adopted legacy 从 1 起）。 */
function planNodeNextRetryAttempt(db: DatabaseSync, planId: string, nodeIndex: number): number {
  const row = db.prepare(`SELECT MAX(attempt) AS maxAttempt FROM studio_generation_run_events
    WHERE plan_id = ? AND node_index = ? AND kind = 'dispatched'`)
    .get(planId, nodeIndex) as { maxAttempt: number | null } | undefined;
  return row?.maxAttempt ? Number(row.maxAttempt) + 1 : 1;
}

/**
 * 幂等重试（P21）：异步预检（currentness/checkpoint/provider 继承）前置；
 * 单一事务内逐节点先写 retry-superseded 再调 dispatch 同步核心——崩溃整体回滚，
 * 旧结果不动，目标 runId 已存在返回既有映射。
 */
export async function retryStudioGenerationPlanNodes(
  projectRoot: string,
  input: { planId: string; nodeIndexes?: number[] },
): Promise<StudioGenerationPlanRetryOutcome> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const planId = normalizeId(input.planId, "planId");
  const readDb = openDatabase(paths);
  let plan: PlanRow | undefined;
  let nodes: PlanNodeRow[] = [];
  try {
    plan = planRowById(readDb, planId);
    if (plan) nodes = planNodesByPlan(readDb, planId);
  } finally {
    readDb.close();
  }
  if (!plan) fail("plan-not-found", `generation plan 不存在：${planId}`);
  let targets = nodes;
  if (input.nodeIndexes !== undefined) {
    if (!Array.isArray(input.nodeIndexes) || input.nodeIndexes.some((value) => !Number.isSafeInteger(value) || value < 1)) {
      fail("invalid-input", "nodeIndexes 必须是正整数数组。");
    }
    const byIndex = new Map(nodes.map((node) => [Number(node.node_index), node]));
    targets = input.nodeIndexes.map((index) => {
      const node = byIndex.get(index);
      if (!node) fail("invalid-input", `nodeIndex=${index} 不在 plan ${planId} 内。`);
      return node;
    });
  }
  // 预检：逐节点解析当前 run 与状态、归属、provider，并做异步门禁。
  const prepared: Array<{
    node: PlanNodeRow;
    packRow: PackRow;
    currentRun: DispatchRow;
    provider: StudioFormalImagegenProvider;
    reworkAuthority: CurrentReworkReviewRetryAuthority | null;
    /** 本节点 retry 将派发的新 attempt runId（与事务内 planNodeNextRetryAttempt 同一推导）。 */
    retryRunId: string;
  }> = [];
  const skipped: Array<{ nodeIndex: number; reason: string }> = [];
  const preDb = openDatabase(paths);
  try {
    for (const node of targets) {
      const nodeIndex = Number(node.node_index);
      const currentRun = latestDispatchByPack(preDb, node.pack_id, node.pack_fingerprint);
      if (!currentRun) {
        skipped.push({ nodeIndex, reason: "planned（尚无 dispatch，直接派发即可，无需重试）" });
        continue;
      }
      assertRunNotGenerationUnknown(preDb, currentRun.generation_run_id);
      const terminal = runTerminalState(preDb, currentRun.generation_run_id);
      const reworkAuthority = terminal === "succeeded"
        ? currentReworkReviewRetryAuthority(preDb, currentRun.generation_run_id)
        : null;
      if (terminal !== "failed" && terminal !== "cancelled" && !reworkAuthority) {
        skipped.push({
          nodeIndex,
          reason: `当前状态 ${terminal ?? "dispatched"} 不可重试（仅 failed/cancelled 或当前结果对的 Review Head=REWORK）`,
        });
        continue;
      }
      const packRow = packRowById(preDb, node.pack_id)!;
      prepared.push({
        node,
        packRow,
        currentRun,
        provider: normalizeDispatchProvider(currentRun.executor_provider),
        reworkAuthority,
        retryRunId: planRunIdFor(planId, nodeIndex, planNodeNextRetryAttempt(preDb, planId, nodeIndex)),
      });
    }
  } finally {
    preDb.close();
  }
  for (const item of prepared) {
    const pack = await readAnyPackFromRow(paths, item.packRow);
    assertAnyPackDispatchable(pack);
    // 排除本节点新 attempt runId：并发 retry 已抢先落地时，门禁不应把在途新 attempt
    // 误判为“占槽未验收”，事务内幂等重放路径负责返回既有映射。
    await assertDispatchGatesCurrent(paths.root, pack, { excludeRunId: item.retryRunId });
  }
  const writeDb = openDatabase(paths);
  try {
    return runTransaction(writeDb, () => {
      const outcome: StudioGenerationPlanRetryOutcome = { planId, retried: [], skipped: [...skipped] };
      for (const item of prepared) {
        const nodeIndex = Number(item.node.node_index);
        // 事务内重推导状态（并发安全）。
        const currentRun = latestDispatchByPack(writeDb, item.node.pack_id, item.node.pack_fingerprint);
        if (!currentRun || currentRun.generation_run_id !== item.currentRun.generation_run_id) {
          // 并发 retry 已抢先：旧 run 上有 retry-superseded 事件则返回既有映射（真幂等重放）。
          const supersedeEvent = writeDb.prepare(`SELECT * FROM studio_generation_run_events
            WHERE generation_run_id = ? AND kind = 'retry-superseded' ORDER BY sequence DESC LIMIT 1`)
            .get(item.currentRun.generation_run_id) as unknown as RunEventRow | undefined;
          const supersedeDetail = supersedeEvent
            ? (JSON.parse(supersedeEvent.detail_json) as { newRunId?: string; nodeIndex?: number })
            : undefined;
          if (supersedeDetail?.newRunId) {
            const replayRun = dispatchRowByRun(writeDb, supersedeDetail.newRunId);
            const replayParsed = parsePlanRunId(supersedeDetail.newRunId);
            if (replayRun && replayParsed) {
              outcome.retried.push({
                nodeIndex,
                generationRunId: supersedeDetail.newRunId,
                attempt: replayParsed.attempt,
                supersedesRunId: item.currentRun.generation_run_id,
                idempotentReplay: true,
              });
              continue;
            }
          }
          outcome.skipped.push({ nodeIndex, reason: "并发期间当前 run 已变化，未重试" });
          continue;
        }
        const terminal = runTerminalState(writeDb, currentRun.generation_run_id);
        assertRunNotGenerationUnknown(writeDb, currentRun.generation_run_id);
        const reworkAuthority = terminal === "succeeded"
          ? currentReworkReviewRetryAuthority(writeDb, currentRun.generation_run_id)
          : null;
        if (terminal !== "failed" && terminal !== "cancelled"
          && (!reworkAuthority
            || !item.reworkAuthority
            || reworkAuthority.reviewId !== item.reworkAuthority.reviewId
            || reworkAuthority.reviewFingerprint !== item.reworkAuthority.reviewFingerprint
            || reworkAuthority.rawResultId !== item.reworkAuthority.rawResultId
            || reworkAuthority.rawSha256 !== item.reworkAuthority.rawSha256
            || reworkAuthority.labeledResultId !== item.reworkAuthority.labeledResultId
            || reworkAuthority.labeledSha256 !== item.reworkAuthority.labeledSha256)) {
          outcome.skipped.push({ nodeIndex, reason: `并发期间状态变为 ${terminal ?? "dispatched"}，未重试` });
          continue;
        }
        assertNoActiveConnectorReservation(writeDb, currentRun.generation_run_id);
        const newAttempt = planNodeNextRetryAttempt(writeDb, planId, nodeIndex);
        const newRunId = planRunIdFor(planId, nodeIndex, newAttempt);
        const existing = dispatchRowByRun(writeDb, newRunId);
        if (existing) {
          outcome.retried.push({
            nodeIndex,
            generationRunId: newRunId,
            attempt: newAttempt,
            supersedesRunId: currentRun.generation_run_id,
            idempotentReplay: true,
          });
          continue;
        }
        const now = new Date().toISOString();
        const oldLinkage = runEventPlanLinkage(writeDb, currentRun.generation_run_id);
        insertRunEvent(writeDb, {
          generationRunId: currentRun.generation_run_id,
          planId: oldLinkage.planId,
          nodeIndex: oldLinkage.nodeIndex,
          kind: "retry-superseded",
          attempt: oldLinkage.attempt,
          supersedesRunId: newRunId,
          detail: { newRunId, planId, nodeIndex },
          now,
        });
        dispatchSyncCore(writeDb, {
          packRow: item.packRow,
          packId: item.node.pack_id,
          packFingerprint: item.node.pack_fingerprint,
          generationRunId: newRunId,
          provider: item.provider,
          supersedesRunId: currentRun.generation_run_id,
          extraAllowedRunIds: new Set([newRunId]),
        });
        outcome.retried.push({
          nodeIndex,
          generationRunId: newRunId,
          attempt: newAttempt,
          supersedesRunId: currentRun.generation_run_id,
          idempotentReplay: false,
        });
      }
      return outcome;
    });
  } finally {
    writeDb.close();
  }
}

/* ------------------------------ 逐节点投影 ------------------------------ */

function projectPlanNode(db: DatabaseSync, node: PlanNodeRow): StudioGenerationPlanNodeProjection {
  const nodeIndex = Number(node.node_index);
  const target = planNodeTargetRow(db, node.plan_id, nodeIndex);
  const targetKey = target?.target_key ?? `panel:${node.unit_id}:${node.panel_id}`;
  const packStale = (target
    ? newestPackFingerprintForUnitGrid(db, targetKey)
    : newestPackFingerprintForPanel(db, node.unit_id, node.panel_id)) !== node.pack_fingerprint;
  const targetIdentity: StudioGenerationPlanTargetIdentity = target
    ? { targetKind: "unit-grid", targetKey, unitId: node.unit_id }
    : { targetKind: "panel", targetKey, unitId: node.unit_id, panelId: node.panel_id };
  const base = {
    ...targetIdentity,
    nodeIndex,
    packId: node.pack_id,
    packFingerprint: node.pack_fingerprint,
    packStale,
  };
  const currentRun = latestDispatchByPack(db, node.pack_id, node.pack_fingerprint);
  if (!currentRun) {
    const attempt = planNodeExpectedAttempt(db, node.plan_id, nodeIndex);
    return {
      ...base,
      generationRunId: planRunIdFor(node.plan_id, nodeIndex, attempt),
      attempt,
      adopted: false,
      status: "planned" as const,
      lastEventAt: null,
      resultId: null,
      errorClass: null,
      errorDetail: null,
    };
  }
  const runId = currentRun.generation_run_id;
  const parsed = parsePlanRunId(runId);
  const adopted = !parsed || parsed.planId !== node.plan_id;
  const raw = resultRowByRunVariant(db, runId, "raw");
  const labeled = resultRowByRunVariant(db, runId, "labeled");
  const latest = latestRunEvent(db, runId);
  let status: StudioGenerationPlanNodeStatus = "dispatched";
  if (raw && labeled) status = "succeeded";
  else if (latest?.kind === "failed") status = "failed";
  else if (latest?.kind === "cancelled") status = "cancelled";
  else if (latest?.kind === "retry-superseded") status = "retry-superseded";
  let errorClass: string | null = null;
  let errorDetail: string | null = null;
  if (latest?.kind === "failed") {
    try {
      const detail = JSON.parse(latest.detail_json) as { errorClass?: string; detail?: string };
      errorClass = detail.errorClass ?? null;
      errorDetail = detail.detail ?? null;
    } catch {
      fail("storage-invalid", `run event ${latest.event_id} 的 detail_json 损坏。`);
    }
  }
  return {
    ...base,
    generationRunId: runId,
    attempt: adopted ? 1 : parsed!.attempt,
    adopted,
    status,
    lastEventAt: latest?.created_at ?? currentRun.dispatched_at,
    resultId: raw?.result_id ?? labeled?.result_id ?? null,
    errorClass,
    errorDetail,
  };
}

function projectPlan(db: DatabaseSync, row: PlanRow): StudioGenerationPlanProjection {
  return {
    planId: row.plan_id,
    projectId: row.project_id,
    sourceCommandRequestId: row.source_command_request_id,
    nodeCount: Number(row.node_count),
    createdAt: row.created_at,
    nodes: planNodesByPlan(db, row.plan_id).map((node) => projectPlanNode(db, node)),
  };
}

/** plan operation 读取面：按 planId 投影（含逐节点状态）。 */
export async function getStudioGenerationPlanProjection(
  projectRoot: string,
  planId: string,
): Promise<StudioGenerationPlanProjection | null> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const normalizedPlanId = normalizeId(planId, "planId");
  const db = openDatabase(paths);
  try {
    const row = planRowById(db, normalizedPlanId);
    return row ? projectPlan(db, row) : null;
  } finally {
    db.close();
  }
}

/** 最新包含目标宫格的 plan（按 plans.sequence 倒序）。 */
export async function getStudioGenerationLatestPlanForPanel(
  projectRoot: string,
  unitId: string,
  panelId: string,
): Promise<StudioGenerationPlanProjection | null> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const normalizedUnitId = normalizeId(unitId, "unitId");
  const normalizedPanelId = normalizeId(panelId, "panelId");
  const db = openDatabase(paths);
  try {
    const row = db.prepare(`
      SELECT p.* FROM studio_generation_plans p
      JOIN studio_generation_plan_nodes n ON n.plan_id = p.plan_id
      LEFT JOIN studio_generation_plan_node_targets target
        ON target.plan_id = n.plan_id AND target.node_index = n.node_index
      WHERE target.plan_id IS NULL AND n.unit_id = ? AND n.panel_id = ?
      ORDER BY p.sequence DESC LIMIT 1
    `).get(normalizedUnitId, normalizedPanelId) as unknown as PlanRow | undefined;
    return row ? projectPlan(db, row) : null;
  } finally {
    db.close();
  }
}

/** 最新包含 unit-grid 目标的 plan；不暴露 plan_nodes 的兼容 panel 锚点。 */
export async function getStudioGenerationLatestPlanForUnitGrid(
  projectRoot: string,
  unitId: string,
): Promise<StudioGenerationPlanProjection | null> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const normalizedUnitId = normalizeId(unitId, "unitId");
  const targetKey = `unit-grid:${normalizedUnitId}`;
  const db = openDatabase(paths);
  try {
    const row = db.prepare(`
      SELECT p.* FROM studio_generation_plans p
      JOIN studio_generation_plan_node_targets target ON target.plan_id = p.plan_id
      WHERE target.target_kind = 'unit-grid' AND target.target_key = ?
      ORDER BY p.sequence DESC LIMIT 1
    `).get(targetKey) as unknown as PlanRow | undefined;
    return row ? projectPlan(db, row) : null;
  } finally {
    db.close();
  }
}

/** 计划列表投影（newest-first，limit ≤36 硬上限）。 */
export async function listStudioGenerationPlanProjections(
  projectRoot: string,
  input?: { limit?: number },
): Promise<StudioGenerationPlanProjection[]> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const limit = input?.limit ?? 36;
  if (!Number.isInteger(limit) || limit < 1 || limit > 36) {
    fail("invalid-input", "limit 必须是 1-36 的整数。");
  }
  const db = openDatabase(paths);
  try {
    const rows = db.prepare("SELECT * FROM studio_generation_plans ORDER BY sequence DESC LIMIT ?")
      .all(limit) as unknown as PlanRow[];
    return rows.map((row) => projectPlan(db, row));
  } finally {
    db.close();
  }
}

/** run 事件历史只读导出（durable 对账证明与调试用，按 sequence 升序）。 */
export async function readStudioGenerationRunEventHistory(
  projectRoot: string,
  generationRunId: string,
): Promise<StudioGenerationRunEventRecord[]> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const normalizedRunId = normalizeId(generationRunId, "generationRunId");
  const db = openDatabase(paths);
  try {
    const rows = db.prepare("SELECT * FROM studio_generation_run_events WHERE generation_run_id = ? ORDER BY sequence")
      .all(normalizedRunId) as unknown as RunEventRow[];
    return rows.map((row) => runEventRecord(row));
  } finally {
    db.close();
  }
}

/** (plan,node) 事件历史只读导出（durable 对账证明用，按 sequence 升序）。 */
export async function readStudioGenerationPlanNodeEventHistory(
  projectRoot: string,
  planId: string,
  nodeIndex: number,
): Promise<StudioGenerationRunEventRecord[]> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const normalizedPlanId = normalizeId(planId, "planId");
  if (!Number.isSafeInteger(nodeIndex) || nodeIndex < 1) fail("invalid-input", "nodeIndex 必须是正整数。");
  const db = openDatabase(paths);
  try {
    const rows = db.prepare(`SELECT * FROM studio_generation_run_events
      WHERE plan_id = ? AND node_index = ? ORDER BY sequence`)
      .all(normalizedPlanId, nodeIndex) as unknown as RunEventRow[];
    return rows.map((row) => runEventRecord(row));
  } finally {
    db.close();
  }
}

/** pack 当前 run（(pack_id,pack_fingerprint) 上 sequence 最大 dispatches 行）的最新事件（runner 终态重放判定用）。 */
export async function readStudioGenerationPackCurrentRunLatestEvent(
  projectRoot: string,
  packId: string,
  packFingerprint: string,
): Promise<StudioGenerationRunEventRecord | null> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const normalizedPackId = normalizeId(packId, "packId");
  const normalizedFingerprint = normalizeSha256(packFingerprint, "packFingerprint");
  const db = openDatabase(paths);
  try {
    const currentRun = latestDispatchByPack(db, normalizedPackId, normalizedFingerprint);
    if (!currentRun) return null;
    const latest = latestRunEvent(db, currentRun.generation_run_id);
    return latest ? runEventRecord(latest) : null;
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------------ */
/* P24：追溯查询只读导出（纯 SELECT 追加，规范 §2.4 逃生门；不动写路径）      */
/* ------------------------------------------------------------------------ */

function p24CursorScope(kind: string, id: string): string {
  return createHash("sha256").update(`p24-${kind}${id}`, "utf8").digest("hex").slice(0, 24);
}

/** 按 pack 列全部派发 run（dispatches (pack_id,sequence) 索引；追溯组合查询用）。 */
export async function listStudioGenerationRunsByPack(
  projectRoot: string,
  query: { packId: string; limit?: number; cursor?: string },
): Promise<{ items: StudioGenerationDispatchRecord[]; nextCursor?: string }> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const packId = normalizeId(query.packId, "packId");
  const limit = normalizeLimit(query.limit);
  const scope = p24CursorScope("runs-by-pack", packId);
  const after = decodeCursor(query.cursor, scope);
  const db = openDatabase(paths);
  try {
    const rows = (after === undefined
      ? db.prepare("SELECT * FROM studio_generation_dispatches WHERE pack_id = ? ORDER BY sequence LIMIT ?").all(packId, limit + 1)
      : db.prepare("SELECT * FROM studio_generation_dispatches WHERE pack_id = ? AND sequence > ? ORDER BY sequence LIMIT ?").all(packId, after, limit + 1)) as unknown as DispatchRow[];
    const selected = rows.slice(0, limit);
    return {
      items: selected.map((row) => dispatchRecord(row)),
      nextCursor: rows.length > limit ? encodeCursor(scope, Number(selected[selected.length - 1]!.sequence)) : undefined,
    };
  } finally {
    db.close();
  }
}

/** 按 pack 列全部结果（results (pack_id,sequence) 索引；追溯组合查询用）。 */
export async function listStudioGenerationResultsByPack(
  projectRoot: string,
  query: { packId: string; limit?: number; cursor?: string },
): Promise<{ items: StudioGenerationResultRecord[]; nextCursor?: string }> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const packId = normalizeId(query.packId, "packId");
  const limit = normalizeLimit(query.limit);
  const scope = p24CursorScope("results-by-pack", packId);
  const after = decodeCursor(query.cursor, scope);
  const db = openDatabase(paths);
  let selected: ResultRow[];
  let nextCursor: string | undefined;
  try {
    const rows = (after === undefined
      ? db.prepare("SELECT * FROM studio_generation_results WHERE pack_id = ? ORDER BY sequence LIMIT ?").all(packId, limit + 1)
      : db.prepare("SELECT * FROM studio_generation_results WHERE pack_id = ? AND sequence > ? ORDER BY sequence LIMIT ?").all(packId, after, limit + 1)) as unknown as ResultRow[];
    selected = rows.slice(0, limit);
    nextCursor = rows.length > limit ? encodeCursor(scope, Number(selected[selected.length - 1]!.sequence)) : undefined;
  } finally {
    db.close();
  }
  return {
    items: await projectResultRowsWithFreshDatabase(paths, selected),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

/** pack 轻量索引记录（按单元列举用；不读 CAS 内容，追溯正向单包读取走 readStudioGenerationFrozenPack）。 */
export interface StudioGenerationPackIndexRecord {
  sequence: number;
  packId: string;
  fingerprint: string;
  contentSha256: string;
  unitId: string;
  unitRevision: number;
  targetKind: StudioGenerationTargetKind;
  targetKey: string;
  /** unit-grid 返回 targetKey/0，绝不泄漏 SQLite 兼容 panel 锚点。 */
  panelId: string;
  panelIndex: number;
  createdAt: string;
}

function packIndexRecord(row: PackRow, target: PackTargetRow | undefined): StudioGenerationPackIndexRecord {
  const targetKind: StudioGenerationTargetKind = target ? "unit-grid" : "panel";
  const targetKey = target?.target_key ?? `panel:${row.unit_id}:${row.panel_id}`;
  return {
    sequence: Number(row.sequence),
    packId: row.pack_id,
    fingerprint: row.fingerprint,
    contentSha256: row.content_sha256,
    unitId: row.unit_id,
    unitRevision: Number(row.unit_revision),
    targetKind,
    targetKey,
    panelId: target ? targetKey : row.panel_id,
    panelIndex: target ? 0 : Number(row.panel_index),
    createdAt: row.created_at,
  };
}

/** 按单元（可选宫格/单元修订）列全部冻结包（packs (unit_id,panel_id,sequence) 索引；含未派发 pack，消除反向影响盲区）。 */
export async function listStudioGenerationPacksByUnit(
  projectRoot: string,
  query: { unitId: string; panelId?: string; unitRevision?: number; limit?: number; cursor?: string },
): Promise<{ items: StudioGenerationPackIndexRecord[]; nextCursor?: string }> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const unitId = normalizeId(query.unitId, "unitId");
  const panelId = query.panelId === undefined ? undefined : normalizeId(query.panelId, "panelId");
  if (query.unitRevision !== undefined
    && (!Number.isSafeInteger(query.unitRevision) || query.unitRevision < 1)) {
    fail("invalid-input", "unitRevision 必须是正整数。");
  }
  const limit = normalizeLimit(query.limit);
  // 分隔符取 id 字符集外的 "#"（R2 F-R2-05：panelId/unitRevision 拼串必须无碰撞）。
  const scope = p24CursorScope("packs-by-unit", `${unitId}#${panelId ?? ""}#${query.unitRevision ?? ""}`);
  const after = decodeCursor(query.cursor, scope);
  const db = openDatabase(paths);
  try {
    // 过滤条件全部下推 SQL（F-R1-01/F-R2-01：修订过滤不得发生在 LIMIT 之后，否则目标修订 pack 可能被挤出而谎报"从未冻结"）。
    const where = ["unit_id = ?"];
    const params: Array<string | number> = [unitId];
    if (panelId !== undefined) {
      where.push("panel_id = ?");
      where.push(`NOT EXISTS (
        SELECT 1 FROM studio_generation_pack_targets target
        WHERE target.pack_id = studio_generation_packs.pack_id
          AND target.pack_fingerprint = studio_generation_packs.fingerprint
      )`);
      params.push(panelId);
    }
    if (query.unitRevision !== undefined) {
      where.push("unit_revision = ?");
      params.push(query.unitRevision);
    }
    if (after !== undefined) {
      where.push("sequence > ?");
      params.push(after);
    }
    const rows = db.prepare(`SELECT * FROM studio_generation_packs WHERE ${where.join(" AND ")} ORDER BY sequence LIMIT ?`)
      .all(...params, limit + 1) as unknown as PackRow[];
    const selected = rows.slice(0, limit);
    return {
      items: selected.map((row) => packIndexRecord(row, packTargetRowById(db, row.pack_id))),
      nextCursor: rows.length > limit ? encodeCursor(scope, Number(selected[selected.length - 1]!.sequence)) : undefined,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// T4 活动 run 可发现、可恢复：单次快照返回指定单元/宫格所有 run 的完整状态投影。
// ---------------------------------------------------------------------------

/** 单个 run 的公开状态投影（Agent 丢失本地 state 后仅凭此即可找回完整调用身份）。 */
export interface StudioGenerationActiveRunProjection {
  generationRunId: string;
  packId: string;
  provider: string;
  dispatchedAt: string;
  /** 最新 run 事件 kind；无事件为 null（legacy 纯 dispatch 行）。 */
  latestEventKind: string | null;
  /** 是否处于终态（failed/cancelled/retry-superseded/succeeded）。 */
  terminal: boolean;
  /** 是否存在 call intent（prepare 已执行）。 */
  hasCallIntent: boolean;
  callId: string | null;
  /** call intent 状态（generation_unknown/result-committed/not-invoked/owner-abandoned 等）。 */
  callStatus: string | null;
  /** 是否已有完整 raw+labeled 结果对。 */
  hasResultPair: boolean;
  /** Review 状态：unreviewed/pass/rework/stale。 */
  reviewStatus: string;
  /** 恢复动作建议。 */
  nextAction: string;
}

export interface StudioGenerationActiveRunsResult {
  targetKind: "panel" | "unit-grid";
  unitId: string;
  panelId?: string;
  runs: StudioGenerationActiveRunProjection[];
  /** 当前阻断生产的 run 摘要（非终态或 generation_unknown 的 run）。 */
  blockingRuns: Array<{ generationRunId: string; reason: string; recoveryAction: string }>;
}

/** 终态判定与 nextAction 推导（单项版与批量版共用，口径与 trace 对齐；改动必须两处同步验证）。 */
function deriveActiveRunTerminalAndNextAction(input: {
  hasResultPair: boolean;
  reviewStatus: string;
  callStatus: string | null;
  latestEventKind: string | null;
  hasCallIntent: boolean;
}): { terminal: boolean; nextAction: string } {
  const { hasResultPair, reviewStatus, callStatus, latestEventKind, hasCallIntent } = input;
  // 终态判定（与 trace 口径对齐）
  const terminal = hasResultPair
    || latestEventKind === "failed"
    || latestEventKind === "cancelled"
    || latestEventKind === "retry-superseded";
  // nextAction 推导
  let nextAction: string;
  if (hasResultPair && reviewStatus === "unreviewed") {
    nextAction = "submit-review";
  } else if (hasResultPair && reviewStatus === "pass") {
    nextAction = "complete";
  } else if (hasResultPair && reviewStatus === "rework") {
    nextAction = "retry-after-rework";
  } else if (callStatus === "generation_unknown") {
    nextAction = "reconcile-or-abandon-call";
  } else if (latestEventKind === "failed" || latestEventKind === "cancelled") {
    nextAction = "retry-or-new-attempt";
  } else if (latestEventKind === "retry-superseded") {
    nextAction = "superseded-no-action";
  } else if (!terminal) {
    nextAction = hasCallIntent ? "await-result-or-reconcile" : "prepare-call-or-await";
  } else {
    nextAction = "no-action";
  }
  return { terminal, nextAction };
}

export async function listStudioGenerationActiveRuns(
  projectRoot: string,
  query: { unitId: string; targetKind?: "panel" | "unit-grid"; panelId?: string },
): Promise<StudioGenerationActiveRunsResult> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const unitId = normalizeId(query.unitId, "unitId");
  const targetKind = query.targetKind ?? "panel";
  const panelId = targetKind === "panel" ? normalizeId(query.panelId ?? "", "panelId") : undefined;
  const db = openDatabase(paths);
  try {
    // 查询该槽位所有 dispatch（按 sequence 降序，最新在前）。
    let dispatchRows: DispatchRow[];
    if (targetKind === "unit-grid") {
      const targetKey = `unit-grid:${unitId}`;
      dispatchRows = db.prepare(`
        SELECT d.* FROM studio_generation_dispatches d
        JOIN studio_generation_pack_targets t
          ON t.pack_id=d.pack_id AND t.pack_fingerprint=d.pack_fingerprint
        WHERE t.target_kind='unit-grid' AND t.target_key=?
        ORDER BY d.sequence DESC
      `).all(targetKey) as unknown as DispatchRow[];
    } else {
      dispatchRows = db.prepare(`
        SELECT d.* FROM studio_generation_dispatches d
        JOIN studio_generation_packs p
          ON p.pack_id=d.pack_id AND p.fingerprint=d.pack_fingerprint
        LEFT JOIN studio_generation_pack_targets t
          ON t.pack_id=p.pack_id AND t.pack_fingerprint=p.fingerprint
        WHERE t.pack_id IS NULL AND p.unit_id=? AND p.panel_id=?
        ORDER BY d.sequence DESC
      `).all(unitId, panelId!) as unknown as DispatchRow[];
    }

    const runs: StudioGenerationActiveRunProjection[] = [];
    const blockingRuns: Array<{ generationRunId: string; reason: string; recoveryAction: string }> = [];

    for (const dispatch of dispatchRows) {
      const runId = dispatch.generation_run_id;
      // 最新事件
      let latestEventKind: string | null = null;
      if (tableExists(db, "studio_generation_run_events")) {
        const eventRow = db.prepare(`
          SELECT kind FROM studio_generation_run_events
          WHERE generation_run_id=? ORDER BY sequence DESC LIMIT 1
        `).get(runId) as { kind?: string } | undefined;
        latestEventKind = eventRow?.kind ?? null;
      }
      // 结果对
      let hasResultPair = false;
      if (tableExists(db, "studio_generation_results")) {
        const variants = db.prepare(`
          SELECT DISTINCT variant FROM studio_generation_results
          WHERE generation_run_id=? AND variant IN ('raw','labeled')
        `).all(runId) as Array<{ variant: string }>;
        const variantSet = new Set(variants.map((r) => r.variant));
        hasResultPair = variantSet.has("raw") && variantSet.has("labeled");
      }
      // call intent 与状态（status 由 call_events 派生，不是表列）
      let hasCallIntent = false;
      let callId: string | null = null;
      let callStatus: string | null = null;
      if (tableExists(db, "studio_generation_call_intents")) {
        const intentRow = db.prepare(`
          SELECT call_id FROM studio_generation_call_intents
          WHERE generation_run_id=? LIMIT 1
        `).get(runId) as { call_id?: string } | undefined;
        if (intentRow?.call_id) {
          hasCallIntent = true;
          callId = intentRow.call_id;
          // 从 call_events 派生状态（与 callIntentStatus 口径对齐）
          callStatus = "generation_unknown";
          if (tableExists(db, "studio_generation_call_events")) {
            const terminalEvent = db.prepare(`
              SELECT kind FROM studio_generation_call_events
              WHERE call_id=? AND kind IN ('result-committed','not-invoked') LIMIT 1
            `).get(intentRow.call_id) as { kind?: string } | undefined;
            if (terminalEvent?.kind) {
              callStatus = terminalEvent.kind;
            } else {
              // owner-abandoned 经 run_events 的 cancelled 事件 detail 识别
              const abandoned = tableExists(db, "studio_generation_run_events")
                && Boolean(db.prepare(`
                  SELECT 1 AS found FROM studio_generation_run_events
                  WHERE generation_run_id=? AND kind='cancelled'
                  AND detail_json LIKE '%owner-abandoned%' LIMIT 1
                `).get(runId));
              if (abandoned) callStatus = "owner-abandoned";
            }
          }
        }
      }
      // Review 状态
      let reviewStatus = "unreviewed";
      if (tableExists(db, "studio_generation_review_heads")) {
        const headRow = db.prepare(`
          SELECT review_id FROM studio_generation_review_heads WHERE generation_run_id=?
        `).get(runId) as { review_id?: string } | undefined;
        if (headRow?.review_id && tableExists(db, "studio_generation_review_events")) {
          const reviewRow = db.prepare(`
            SELECT decision FROM studio_generation_review_events WHERE review_id=?
          `).get(headRow.review_id) as { decision?: string } | undefined;
          reviewStatus = reviewRow?.decision ?? "unreviewed";
        }
      }
      // 终态判定与 nextAction 推导（共用纯函数，批量版同一口径）
      const { terminal, nextAction } = deriveActiveRunTerminalAndNextAction({
        hasResultPair,
        reviewStatus,
        callStatus,
        latestEventKind,
        hasCallIntent,
      });
      runs.push({
        generationRunId: runId,
        packId: dispatch.pack_id,
        provider: dispatch.executor_provider,
        dispatchedAt: dispatch.dispatched_at,
        latestEventKind,
        terminal,
        hasCallIntent,
        callId,
        callStatus,
        hasResultPair,
        reviewStatus,
        nextAction,
      });
      // 阻断判定：非终态或 generation_unknown 的 run 会阻断同槽新 dispatch
      if (!terminal) {
        blockingRuns.push({
          generationRunId: runId,
          reason: "非终态 run 占用槽位（in-flight）",
          recoveryAction: "cancel_studio_generation_run 或等待结果登记",
        });
      } else if (callStatus === "generation_unknown") {
        blockingRuns.push({
          generationRunId: runId,
          reason: "generation_unknown 调用未对账",
          recoveryAction: "reconcile_studio_imagegen_call 或 abandon_studio_generation_unknown",
        });
      } else if (hasResultPair && reviewStatus === "unreviewed") {
        blockingRuns.push({
          generationRunId: runId,
          reason: "成对结果未审片",
          recoveryAction: "submit_studio_generation_review",
        });
      }
    }
    return {
      targetKind,
      unitId,
      ...(panelId ? { panelId } : {}),
      runs,
      blockingRuns,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// T9 批量：单次只读连接取齐全部 unit-grid 目标的最新 run。
// 修复批量投影内部 N+1 串行（每单元一次 openDatabase + 多条点查）。
// 返回的 latestRun 字段语义与 listStudioGenerationActiveRuns 单项版 runs[0] 一致；
// 单项版行为不变（codex.ts active-runs 仍在用）。
// ---------------------------------------------------------------------------

/** 同一账本快照内闭合的当前 PASS 结果身份。 */
export interface StudioGenerationApprovedResultIdentity {
  generationRunId: string;
  provider: StudioFormalImagegenProvider;
  packId: string;
  packFingerprint: string;
  reviewId: string;
  reviewFingerprint: string;
  continuityFingerprint: string;
  /** 当前快照是否存在实际末态 observation head；false 时消费端无需发起昂贵点查。 */
  postResultObservationHeadPresent: boolean;
  rawResultId: string;
  rawMediaSha256: string;
  labeledResultId: string;
  labeledMediaSha256: string;
}

/** 单个 unit-grid 目标的最新 run 批量投影条目。 */
export interface StudioGenerationLatestUnitGridRun {
  unitId: string;
  /** 最新 run 投影（该目标从未派发为 null）；字段语义同单项版 runs[0]。 */
  latestRun: StudioGenerationActiveRunProjection | null;
  /** 最新 run 成对结果的 raw 媒体 SHA（无成对结果为 null，绝不返回占位符）。 */
  rawMediaSha256: string | null;
  /** 最新 run 成对结果的 labeled 媒体 SHA（无成对结果为 null，绝不返回占位符）。 */
  labeledMediaSha256: string | null;
  /**
   * 当前 Review Head 对最新结果对的完整 PASS 身份。
   * 只在同一 SQLite 只读事务快照内核对 run/pack/result/currentness/晋升资格/
   * Review Head 全部一致时返回；任一错配均为 null，调用方不得自行补猜。
   */
  approvedResultIdentity: StudioGenerationApprovedResultIdentity | null;
}

/** 批量查询用的最新 dispatch 行（只取投影所需列）。 */
interface UnitGridLatestDispatchRow {
  target_key: string;
  generation_run_id: string;
  pack_id: string;
  pack_fingerprint: string;
  executor_provider: string;
  dispatched_at: string;
}

interface UnitGridResultIdentityRow {
  generation_run_id: string;
  result_id: string;
  variant: "raw" | "labeled";
  status: string;
  media_sha256: string;
  input_current: number;
  promotion_eligible: number;
  pack_id: string;
  pack_fingerprint: string;
}

interface UnitGridReviewIdentityRow {
  generation_run_id: string;
  review_id: string;
  review_fingerprint: string;
  event_fingerprint: string;
  raw_result_id: string;
  raw_sha256: string;
  labeled_result_id: string;
  labeled_sha256: string;
  pack_id: string;
  pack_fingerprint: string;
  continuity_fingerprint: string;
  decision: string;
  current_at_submission: number;
  advances_head: number;
}

/** IN (...) 分批（避免变量数触顶；541 单元单次即可覆盖）。 */
const BATCH_QUERY_CHUNK_SIZE = 500;

function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * 批量获取一组单元的 unit-grid 目标最新 run（含成对结果 SHA）。
 * 单次 openDatabase；逐表一条批量 SQL（窗口函数取每组最新），替代逐单元多次点查。
 * 未派发的单元同样出现在结果中（latestRun=null），便于调用方对齐输入顺序。
 */
export async function listStudioGenerationLatestUnitGridRuns(
  projectRoot: string,
  unitIds: string[],
): Promise<StudioGenerationLatestUnitGridRun[]> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const normalizedUnitIds = unitIds.map((unitId) => normalizeId(unitId, "unitId"));
  if (normalizedUnitIds.length === 0) return [];
  const db = openDatabase(paths);
  let readTransactionOpen = false;
  try {
    // 所有批量事实必须来自同一个 WAL 快照，否则 Review Head 在逐表查询之间变化时
    // 可能拼出从未同时成立的执行身份。只读 DEFERRED 事务不阻塞 WAL writer。
    db.exec("BEGIN");
    readTransactionOpen = true;
    // 与单项版相同的表存在性预检（老库可能缺后续扩展表）。
    const hasRunEvents = tableExists(db, "studio_generation_run_events");
    const hasResults = tableExists(db, "studio_generation_results");
    const hasCallIntents = tableExists(db, "studio_generation_call_intents");
    const hasCallEvents = tableExists(db, "studio_generation_call_events");
    const hasReviewHeads = tableExists(db, "studio_generation_review_heads");
    const hasReviewEvents = tableExists(db, "studio_generation_review_events");
    const hasPostResultObservationHeads = tableExists(db, "studio_post_result_observation_heads");

    // 1. 每个 target_key 的最新 dispatch（ROW_NUMBER 窗口取 sequence 最大者，同单项版 ORDER BY sequence DESC 首行）。
    const latestDispatchByTarget = new Map<string, UnitGridLatestDispatchRow>();
    for (let offset = 0; offset < normalizedUnitIds.length; offset += BATCH_QUERY_CHUNK_SIZE) {
      const chunk = normalizedUnitIds.slice(offset, offset + BATCH_QUERY_CHUNK_SIZE);
      const targetKeys = chunk.map((unitId) => `unit-grid:${unitId}`);
      const rows = db.prepare(`
        SELECT target_key, generation_run_id, pack_id, pack_fingerprint, executor_provider, dispatched_at
        FROM (
          SELECT t.target_key AS target_key, d.generation_run_id, d.pack_id, d.pack_fingerprint,
            d.executor_provider, d.dispatched_at,
            ROW_NUMBER() OVER (PARTITION BY t.target_key ORDER BY d.sequence DESC) AS rn
          FROM studio_generation_pack_targets t
          JOIN studio_generation_dispatches d
            ON d.pack_id = t.pack_id AND d.pack_fingerprint = t.pack_fingerprint
          WHERE t.target_kind = 'unit-grid' AND t.target_key IN (${sqlPlaceholders(targetKeys.length)})
        ) WHERE rn = 1
      `).all(...targetKeys) as unknown as UnitGridLatestDispatchRow[];
      for (const row of rows) latestDispatchByTarget.set(row.target_key, row);
    }

    const runIds = [...new Set([...latestDispatchByTarget.values()].map((row) => row.generation_run_id))];
    /** 分批执行 IN 查询的本地工具。 */
    const queryByRunIdChunks = <T>(sql: (placeholders: string) => string): T[] => {
      const out: T[] = [];
      for (let offset = 0; offset < runIds.length; offset += BATCH_QUERY_CHUNK_SIZE) {
        const chunk = runIds.slice(offset, offset + BATCH_QUERY_CHUNK_SIZE);
        out.push(...(db.prepare(sql(sqlPlaceholders(chunk.length))).all(...chunk) as unknown as T[]));
      }
      return out;
    };

    // 2. 每个 run 的最新事件 kind。
    const latestEventByRun = new Map<string, string>();
    if (hasRunEvents && runIds.length > 0) {
      for (const row of queryByRunIdChunks<{ generation_run_id: string; kind: string }>((ph) => `
        SELECT generation_run_id, kind FROM (
          SELECT generation_run_id, kind,
            ROW_NUMBER() OVER (PARTITION BY generation_run_id ORDER BY sequence DESC) AS rn
          FROM studio_generation_run_events
          WHERE generation_run_id IN (${ph})
        ) WHERE rn = 1
      `)) {
        latestEventByRun.set(row.generation_run_id, row.kind);
      }
    }

    // 3. 每个 run 的 raw/labeled 结果与媒体 SHA（一并解决 T9 投影正式 SHA 占位符问题）。
    const resultByRun = new Map<string, { raw?: UnitGridResultIdentityRow; labeled?: UnitGridResultIdentityRow }>();
    if (hasResults && runIds.length > 0) {
      for (const row of queryByRunIdChunks<UnitGridResultIdentityRow>((ph) => `
        SELECT generation_run_id, result_id, variant, status, media_sha256,
          input_current, promotion_eligible, pack_id, pack_fingerprint
        FROM studio_generation_results
        WHERE generation_run_id IN (${ph}) AND variant IN ('raw', 'labeled')
      `)) {
        const entry = resultByRun.get(row.generation_run_id) ?? {};
        if (row.variant === "raw") entry.raw = row;
        else if (row.variant === "labeled") entry.labeled = row;
        resultByRun.set(row.generation_run_id, entry);
      }
    }

    // 4. 每个 run 的 call intent（单项版 LIMIT 1；批量按 rowid 取首行，实践中每 run 至多一条）。
    const callIdByRun = new Map<string, string>();
    if (hasCallIntents && runIds.length > 0) {
      for (const row of queryByRunIdChunks<{ generation_run_id: string; call_id: string }>((ph) => `
        SELECT generation_run_id, call_id FROM (
          SELECT generation_run_id, call_id,
            ROW_NUMBER() OVER (PARTITION BY generation_run_id ORDER BY rowid) AS rn
          FROM studio_generation_call_intents
          WHERE generation_run_id IN (${ph})
        ) WHERE rn = 1
      `)) {
        callIdByRun.set(row.generation_run_id, row.call_id);
      }
    }

    // 5. call 终态事件（result-committed/not-invoked）。
    const callIds = [...new Set(callIdByRun.values())];
    const callTerminalByCallId = new Map<string, string>();
    if (hasCallEvents && callIds.length > 0) {
      for (let offset = 0; offset < callIds.length; offset += BATCH_QUERY_CHUNK_SIZE) {
        const chunk = callIds.slice(offset, offset + BATCH_QUERY_CHUNK_SIZE);
        const rows = db.prepare(`
          SELECT call_id, kind FROM (
            SELECT call_id, kind,
              ROW_NUMBER() OVER (PARTITION BY call_id ORDER BY rowid) AS rn
            FROM studio_generation_call_events
            WHERE call_id IN (${sqlPlaceholders(chunk.length)}) AND kind IN ('result-committed', 'not-invoked')
          ) WHERE rn = 1
        `).all(...chunk) as unknown as Array<{ call_id: string; kind: string }>;
        for (const row of rows) callTerminalByCallId.set(row.call_id, row.kind);
      }
    }

    // 6. owner-abandoned 判定（经 cancelled 事件 detail 识别，同单项版）。
    const abandonedRunIds = new Set<string>();
    if (hasRunEvents && runIds.length > 0) {
      for (const row of queryByRunIdChunks<{ generation_run_id: string }>((ph) => `
        SELECT DISTINCT generation_run_id FROM studio_generation_run_events
        WHERE generation_run_id IN (${ph}) AND kind = 'cancelled' AND detail_json LIKE '%owner-abandoned%'
      `)) {
        abandonedRunIds.add(row.generation_run_id);
      }
    }

    // 7. Review head 与 decision（先出现者优先，同单项版 .get() 首行语义）。
    const reviewIdByRun = new Map<string, string>();
    if (hasReviewHeads && runIds.length > 0) {
      for (const row of queryByRunIdChunks<{ generation_run_id: string; review_id: string }>((ph) => `
        SELECT generation_run_id, review_id FROM studio_generation_review_heads
        WHERE generation_run_id IN (${ph})
      `)) {
        if (!reviewIdByRun.has(row.generation_run_id)) reviewIdByRun.set(row.generation_run_id, row.review_id);
      }
    }
    const reviewIdentityByRun = new Map<string, UnitGridReviewIdentityRow>();
    if (hasReviewHeads && hasReviewEvents && runIds.length > 0) {
      for (const row of queryByRunIdChunks<UnitGridReviewIdentityRow>((ph) => `
        SELECT
          h.generation_run_id,
          h.review_id,
          h.review_fingerprint,
          e.fingerprint AS event_fingerprint,
          e.raw_result_id,
          e.raw_sha256,
          e.labeled_result_id,
          e.labeled_sha256,
          e.pack_id,
          e.pack_fingerprint,
          e.continuity_fingerprint,
          e.decision,
          e.current_at_submission,
          e.advances_head
        FROM studio_generation_review_heads h
        JOIN studio_generation_review_events e
          ON e.review_id = h.review_id
         AND e.generation_run_id = h.generation_run_id
        WHERE h.generation_run_id IN (${ph})
      `)) {
        reviewIdentityByRun.set(row.generation_run_id, row);
      }
    }
    const reviewIds = [...new Set(reviewIdByRun.values())];
    const reviewDecisionById = new Map<string, string>();
    if (hasReviewEvents && reviewIds.length > 0) {
      for (let offset = 0; offset < reviewIds.length; offset += BATCH_QUERY_CHUNK_SIZE) {
        const chunk = reviewIds.slice(offset, offset + BATCH_QUERY_CHUNK_SIZE);
        const rows = db.prepare(`
          SELECT review_id, decision FROM studio_generation_review_events
          WHERE review_id IN (${sqlPlaceholders(chunk.length)})
        `).all(...chunk) as unknown as Array<{ review_id: string; decision: string }>;
        for (const row of rows) {
          if (!reviewDecisionById.has(row.review_id)) reviewDecisionById.set(row.review_id, row.decision);
        }
      }
    }
    const observationHeadRunIds = new Set<string>();
    if (hasPostResultObservationHeads && runIds.length > 0) {
      for (const row of queryByRunIdChunks<{ generation_run_id: string }>((ph) => `
        SELECT generation_run_id
        FROM studio_post_result_observation_heads
        WHERE generation_run_id IN (${ph})
      `)) {
        observationHeadRunIds.add(row.generation_run_id);
      }
    }

    // 8. 逐单元装配（推导口径与单项版一致）。
    const results: StudioGenerationLatestUnitGridRun[] = [];
    for (const unitId of normalizedUnitIds) {
      const dispatch = latestDispatchByTarget.get(`unit-grid:${unitId}`);
      if (!dispatch) {
        results.push({
          unitId,
          latestRun: null,
          rawMediaSha256: null,
          labeledMediaSha256: null,
          approvedResultIdentity: null,
        });
        continue;
      }
      const runId = dispatch.generation_run_id;
      const latestEventKind = latestEventByRun.get(runId) ?? null;
      const resultPair = resultByRun.get(runId);
      const hasResultPair = Boolean(resultPair?.raw && resultPair?.labeled);
      const callId = callIdByRun.get(runId) ?? null;
      const hasCallIntent = callId !== null;
      let callStatus: string | null = null;
      if (callId) {
        callStatus = "generation_unknown";
        if (hasCallEvents) {
          const terminalEvent = callTerminalByCallId.get(callId);
          if (terminalEvent) {
            callStatus = terminalEvent;
          } else if (hasRunEvents && abandonedRunIds.has(runId)) {
            callStatus = "owner-abandoned";
          }
        }
      }
      let reviewStatus = "unreviewed";
      const reviewId = reviewIdByRun.get(runId);
      if (reviewId && hasReviewEvents) {
        reviewStatus = reviewDecisionById.get(reviewId) ?? "unreviewed";
      }
      const { terminal, nextAction } = deriveActiveRunTerminalAndNextAction({
        hasResultPair,
        reviewStatus,
        callStatus,
        latestEventKind,
        hasCallIntent,
      });
      const reviewIdentity = reviewIdentityByRun.get(runId);
      const raw = resultPair?.raw;
      const labeled = resultPair?.labeled;
      const approvedResultIdentity: StudioGenerationApprovedResultIdentity | null = (
        reviewIdentity
        && raw
        && labeled
        && reviewIdentity.decision === "pass"
        && Number(reviewIdentity.current_at_submission) === 1
        && Number(reviewIdentity.advances_head) === 1
        && reviewIdentity.review_fingerprint === reviewIdentity.event_fingerprint
        && reviewIdentity.raw_result_id === raw.result_id
        && reviewIdentity.raw_sha256 === raw.media_sha256
        && reviewIdentity.labeled_result_id === labeled.result_id
        && reviewIdentity.labeled_sha256 === labeled.media_sha256
        && reviewIdentity.pack_id === dispatch.pack_id
        && reviewIdentity.pack_fingerprint === dispatch.pack_fingerprint
        && raw.pack_id === dispatch.pack_id
        && raw.pack_fingerprint === dispatch.pack_fingerprint
        && labeled.pack_id === dispatch.pack_id
        && labeled.pack_fingerprint === dispatch.pack_fingerprint
        && raw.status === "pending"
        && labeled.status === "pending"
        && Number(raw.input_current) === 1
        && Number(labeled.input_current) === 1
        && Number(raw.promotion_eligible) === 1
        && Number(labeled.promotion_eligible) === 1
      ) ? {
          generationRunId: runId,
          provider: dispatch.executor_provider as StudioFormalImagegenProvider,
          packId: dispatch.pack_id,
          packFingerprint: dispatch.pack_fingerprint,
          reviewId: reviewIdentity.review_id,
          reviewFingerprint: reviewIdentity.review_fingerprint,
          continuityFingerprint: reviewIdentity.continuity_fingerprint,
          postResultObservationHeadPresent: observationHeadRunIds.has(runId),
          rawResultId: raw.result_id,
          rawMediaSha256: raw.media_sha256,
          labeledResultId: labeled.result_id,
          labeledMediaSha256: labeled.media_sha256,
        } : null;
      results.push({
        unitId,
        latestRun: {
          generationRunId: runId,
          packId: dispatch.pack_id,
          provider: dispatch.executor_provider,
          dispatchedAt: dispatch.dispatched_at,
          latestEventKind,
          terminal,
          hasCallIntent,
          callId,
          callStatus,
          hasResultPair,
          reviewStatus,
          nextAction,
        },
        rawMediaSha256: raw?.media_sha256 ?? null,
        labeledMediaSha256: labeled?.media_sha256 ?? null,
        approvedResultIdentity,
      });
    }
    db.exec("COMMIT");
    readTransactionOpen = false;
    return results;
  } finally {
    if (readTransactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 原始只读错误优先；close 仍会释放快照。
      }
    }
    db.close();
  }
}


// ---------------------------------------------------------------------------
// T14/T19 统一口径：集级 unit-grid 生产 rollup。
// 诊断（getStudioProductionDiagnostics）与连续状态（getContinuousGenerationState）
// 必须复用本聚合：PASS 数、completedUnits、raw 节点数同源；
// 失败/待审/拒绝/未知分别统计；owner-abandoned 已闭合不可复用，不计入
// generation_unknown。调用方负责用 projectRoot+season+episode 解析 unitIds
// （ledger 表不存 season/episode，单元清单归 production owner）。
// ---------------------------------------------------------------------------

/** 单单元当前状态桶（按最新 run 判定；PASS 完成口径见 rollup.pass）。 */
export type StudioUnitGridRollupBucket =
  | "not-started"
  | "in-flight"
  | "generation-unknown"
  | "owner-abandoned"
  | "pending-review"
  | "pass"
  | "rework"
  | "rejected"
  | "failed"
  | "cancelled";

export interface StudioUnitGridEpisodeRollupUnit {
  unitId: string;
  /** 是否有任何 unit-grid dispatch。 */
  dispatched: boolean;
  rawResultCount: number;
  labeledResultCount: number;
  /** 合并历史 PASS：append-only review 事件中任一 decision='pass' 或当前 head=pass。 */
  pass: boolean;
  /** 当前状态桶（按最新 run）。 */
  currentBucket: StudioUnitGridRollupBucket;
  latestRunId: string | null;
}

export interface StudioUnitGridEpisodeRollup {
  /** 输入单元总数（本集单元清单口径）。 */
  totalUnits: number;
  dispatchedUnits: number;
  /** 全集 unit-grid raw/labeled 结果节点数（与画布 raw 节点同口径）。 */
  rawResultCount: number;
  labeledResultCount: number;
  /** 完成单元（=== passUnitIds，口径一致锚点）。 */
  completedUnitIds: string[];
  passUnitIds: string[];
  pendingReviewUnitIds: string[];
  reworkUnitIds: string[];
  rejectedUnitIds: string[];
  failedUnitIds: string[];
  /** 未闭合 generation_unknown（owner-abandoned 明确不计入）。 */
  generationUnknownUnitIds: string[];
  /** owner 已封存：终态闭合、候选永不复用，不得计入 generation_unknown。 */
  ownerAbandonedUnitIds: string[];
  units: StudioUnitGridEpisodeRollupUnit[];
}

/**
 * 批量聚合一组单元的 unit-grid 生成 rollup（单次 openDatabase，逐表一条批量 SQL）。
 * unitIds 为空时直接返回零口径。老库缺 review/run/call 表时按无事实处理（fail-safe 不猜）。
 */
export async function getStudioUnitGridEpisodeRollup(
  projectRoot: string,
  unitIds: readonly string[],
): Promise<StudioUnitGridEpisodeRollup> {
  const { paths } = await managedLedgerPaths(projectRoot);
  const normalizedUnitIds = [...new Set(unitIds.map((unitId, index) => normalizeId(unitId, `unitIds[${index}]`)))];
  const empty: StudioUnitGridEpisodeRollup = {
    totalUnits: normalizedUnitIds.length,
    dispatchedUnits: 0,
    rawResultCount: 0,
    labeledResultCount: 0,
    completedUnitIds: [],
    passUnitIds: [],
    pendingReviewUnitIds: [],
    reworkUnitIds: [],
    rejectedUnitIds: [],
    failedUnitIds: [],
    generationUnknownUnitIds: [],
    ownerAbandonedUnitIds: [],
    units: normalizedUnitIds.map((unitId) => ({
      unitId,
      dispatched: false,
      rawResultCount: 0,
      labeledResultCount: 0,
      pass: false,
      currentBucket: "not-started",
      latestRunId: null,
    })),
  };
  if (normalizedUnitIds.length === 0) return empty;

  const db = openDatabase(paths);
  try {
    interface DispatchFactRow {
      unit_id: string;
      generation_run_id: string;
      dispatch_sequence: number;
    }
    const dispatchRows: DispatchFactRow[] = [];
    const resultCountRows: Array<{ unit_id: string; variant: string; n: number }> = [];
    for (let offset = 0; offset < normalizedUnitIds.length; offset += BATCH_QUERY_CHUNK_SIZE) {
      const chunk = normalizedUnitIds.slice(offset, offset + BATCH_QUERY_CHUNK_SIZE);
      const placeholders = sqlPlaceholders(chunk.length);
      dispatchRows.push(...(db.prepare(`
        SELECT t.unit_id AS unit_id, d.generation_run_id AS generation_run_id, d.sequence AS dispatch_sequence
        FROM studio_generation_pack_targets t
        JOIN studio_generation_dispatches d
          ON d.pack_id = t.pack_id AND d.pack_fingerprint = t.pack_fingerprint
        WHERE t.target_kind = 'unit-grid' AND t.unit_id IN (${placeholders})
        ORDER BY d.sequence ASC
      `).all(...chunk) as unknown as DispatchFactRow[]));
      resultCountRows.push(...(db.prepare(`
        SELECT t.unit_id AS unit_id, r.variant AS variant, COUNT(*) AS n
        FROM studio_generation_results r
        JOIN studio_generation_pack_targets t
          ON t.pack_id = r.pack_id AND t.pack_fingerprint = r.pack_fingerprint
        WHERE t.target_kind = 'unit-grid' AND t.unit_id IN (${placeholders})
        GROUP BY t.unit_id, r.variant
      `).all(...chunk) as unknown as Array<{ unit_id: string; variant: string; n: number }>));
    }

    const runIds = [...new Set(dispatchRows.map((row) => row.generation_run_id))];
    const latestEventKindByRun = new Map<string, string>();
    const resultPairByRun = new Map<string, boolean>();
    const rawCountByUnit = new Map<string, number>();
    const labeledCountByUnit = new Map<string, number>();
    const callIdByRun = new Map<string, string>();
    const callTerminalByRun = new Map<string, string>();
    const ownerAbandonedByRun = new Set<string>();
    const headDecisionByRun = new Map<string, string>();
    const everPassByRun = new Set<string>();

    for (const row of resultCountRows) {
      const target = row.variant === "raw" ? rawCountByUnit : row.variant === "labeled" ? labeledCountByUnit : null;
      if (target) target.set(row.unit_id, (target.get(row.unit_id) ?? 0) + Number(row.n));
    }

    const hasRunEvents = tableExists(db, "studio_generation_run_events");
    const hasCallIntents = tableExists(db, "studio_generation_call_intents");
    const hasCallEvents = tableExists(db, "studio_generation_call_events");
    const hasReviewHeads = tableExists(db, "studio_generation_review_heads");
    const hasReviewEvents = tableExists(db, "studio_generation_review_events");

    for (let offset = 0; offset < runIds.length; offset += BATCH_QUERY_CHUNK_SIZE) {
      const chunk = runIds.slice(offset, offset + BATCH_QUERY_CHUNK_SIZE);
      const placeholders = sqlPlaceholders(chunk.length);
      resultPairByRun.clear();
      if (hasRunEvents) {
        const eventRows = db.prepare(`
          SELECT generation_run_id, kind FROM (
            SELECT generation_run_id, kind,
                   ROW_NUMBER() OVER (PARTITION BY generation_run_id ORDER BY sequence DESC) AS rn
            FROM studio_generation_run_events
            WHERE generation_run_id IN (${placeholders})
          ) WHERE rn = 1
        `).all(...chunk) as Array<{ generation_run_id: string; kind: string }>;
        for (const row of eventRows) latestEventKindByRun.set(row.generation_run_id, row.kind);
        const abandonedRows = db.prepare(`
          SELECT DISTINCT generation_run_id FROM studio_generation_run_events
          WHERE generation_run_id IN (${placeholders})
            AND kind = 'cancelled' AND detail_json LIKE '%owner-abandoned%'
        `).all(...chunk) as Array<{ generation_run_id: string }>;
        for (const row of abandonedRows) ownerAbandonedByRun.add(row.generation_run_id);
      }
      const pairRows = db.prepare(`
        SELECT generation_run_id, COUNT(DISTINCT variant) AS variants
        FROM studio_generation_results
        WHERE generation_run_id IN (${placeholders}) AND variant IN ('raw','labeled')
        GROUP BY generation_run_id
      `).all(...chunk) as Array<{ generation_run_id: string; variants: number }>;
      for (const row of pairRows) resultPairByRun.set(row.generation_run_id, Number(row.variants) === 2);
      if (hasCallIntents) {
        const intentRows = db.prepare(`
          SELECT call_id, generation_run_id FROM studio_generation_call_intents
          WHERE generation_run_id IN (${placeholders})
        `).all(...chunk) as Array<{ call_id: string; generation_run_id: string }>;
        for (const row of intentRows) callIdByRun.set(row.generation_run_id, row.call_id);
        const callIds = intentRows.map((row) => row.call_id);
        if (hasCallEvents && callIds.length > 0) {
          const callPlaceholders = sqlPlaceholders(callIds.length);
          const terminalRows = db.prepare(`
            SELECT call_id, kind FROM studio_generation_call_events
            WHERE call_id IN (${callPlaceholders}) AND kind IN ('result-committed','not-invoked')
          `).all(...callIds) as Array<{ call_id: string; kind: string }>;
          const runByCall = new Map(intentRows.map((row) => [row.call_id, row.generation_run_id] as const));
          for (const row of terminalRows) {
            const runId = runByCall.get(row.call_id);
            if (runId) callTerminalByRun.set(runId, row.kind);
          }
        }
      }
      if (hasReviewHeads && hasReviewEvents) {
        const headRows = db.prepare(`
          SELECT h.generation_run_id AS generationRunId, e.decision AS decision
          FROM studio_generation_review_heads h
          JOIN studio_generation_review_events e ON e.review_id = h.review_id
          WHERE h.generation_run_id IN (${placeholders})
        `).all(...chunk) as Array<{ generationRunId: string; decision: string }>;
        for (const row of headRows) headDecisionByRun.set(row.generationRunId, row.decision);
        const passRows = db.prepare(`
          SELECT DISTINCT generation_run_id FROM studio_generation_review_events
          WHERE generation_run_id IN (${placeholders}) AND decision = 'pass'
        `).all(...chunk) as Array<{ generation_run_id: string }>;
        for (const row of passRows) everPassByRun.add(row.generation_run_id);
      }
    }

    /** 与 listStudioGenerationActiveRuns 相同的 callStatus 派生口径。 */
    const callStatusOf = (runId: string): string | null => {
      if (!callIdByRun.has(runId)) return null;
      const terminal = callTerminalByRun.get(runId);
      if (terminal) return terminal;
      if (ownerAbandonedByRun.has(runId)) return "owner-abandoned";
      return "generation_unknown";
    };

    // 按 unit 分组 run（dispatch sequence 升序，最新在尾）。
    const runsByUnit = new Map<string, DispatchFactRow[]>();
    for (const row of dispatchRows) {
      const list = runsByUnit.get(row.unit_id) ?? [];
      list.push(row);
      runsByUnit.set(row.unit_id, list);
    }

    const units: StudioUnitGridEpisodeRollupUnit[] = normalizedUnitIds.map((unitId) => {
      const unitRuns = runsByUnit.get(unitId) ?? [];
      const latest = unitRuns[unitRuns.length - 1];
      const rawResultCount = rawCountByUnit.get(unitId) ?? 0;
      const labeledResultCount = labeledCountByUnit.get(unitId) ?? 0;
      if (!latest) {
        return {
          unitId,
          dispatched: false,
          rawResultCount,
          labeledResultCount,
          pass: false,
          currentBucket: "not-started" as const,
          latestRunId: null,
        };
      }
      const runId = latest.generation_run_id;
      const hasResultPair = resultPairByRun.get(runId) === true;
      const headDecision = headDecisionByRun.get(runId);
      const callStatus = callStatusOf(runId);
      const latestEventKind = latestEventKindByRun.get(runId) ?? null;
      // 合并历史 PASS：本单元任一 run 曾被 decision='pass'（append-only 事件）或当前 head=pass。
      const pass = unitRuns.some((row) => everPassByRun.has(row.generation_run_id))
        || unitRuns.some((row) => headDecisionByRun.get(row.generation_run_id) === "pass");
      let currentBucket: StudioUnitGridRollupBucket;
      if (callStatus === "owner-abandoned") currentBucket = "owner-abandoned";
      else if (callStatus === "generation_unknown") currentBucket = "generation-unknown";
      else if (hasResultPair && headDecision === "pass") currentBucket = "pass";
      else if (hasResultPair && headDecision === "rework") currentBucket = "rework";
      else if (hasResultPair && headDecision === "reject") currentBucket = "rejected";
      else if (hasResultPair) currentBucket = "pending-review";
      else if (latestEventKind === "failed") currentBucket = "failed";
      else if (latestEventKind === "cancelled") currentBucket = "cancelled";
      else currentBucket = "in-flight";
      return {
        unitId,
        dispatched: true,
        rawResultCount,
        labeledResultCount,
        pass,
        currentBucket,
        latestRunId: runId,
      };
    });

    const byBucket = (bucket: StudioUnitGridRollupBucket) => units
      .filter((unit) => unit.currentBucket === bucket)
      .map((unit) => unit.unitId);
    const passUnitIds = units.filter((unit) => unit.pass).map((unit) => unit.unitId);
    return {
      totalUnits: normalizedUnitIds.length,
      dispatchedUnits: units.filter((unit) => unit.dispatched).length,
      rawResultCount: units.reduce((sum, unit) => sum + unit.rawResultCount, 0),
      labeledResultCount: units.reduce((sum, unit) => sum + unit.labeledResultCount, 0),
      completedUnitIds: passUnitIds,
      passUnitIds,
      pendingReviewUnitIds: byBucket("pending-review"),
      reworkUnitIds: byBucket("rework"),
      rejectedUnitIds: byBucket("rejected"),
      failedUnitIds: byBucket("failed"),
      generationUnknownUnitIds: byBucket("generation-unknown"),
      ownerAbandonedUnitIds: byBucket("owner-abandoned"),
      units,
    };
  } finally {
    db.close();
  }
}
