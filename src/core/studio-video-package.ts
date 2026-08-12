/**
 * P30 Studio 视频提交包导出账本。
 *
 * 导出意图与 verify 回执复用 generation ledger SQLite；外部 Python builder
 * 只负责确定性派生文件，不拥有 Review、result、pack 或 nextAction 真相。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { studioSqliteBusyTimeoutMs } from "./studio-sqlite-busy.js";
import sharp, { type Metadata } from "sharp";
import {
  canonicalizeStudioJsonValue as stableValue,
  digestStudioCanonicalJson as digest,
  serializeStudioCanonicalJsonPretty,
} from "./studio-canonical-json.js";
import { getStudioMedia, verifyStudioMediaObject } from "./material-studio.js";
import { inspectManagedProject, inspectManagedProjectReadOnly, type ProjectShell } from "./managed-project.js";
import {
  initializeStudioGenerationLedger,
  readStudioImagegenCallIntentByRun,
  readStudioGenerationResult,
  readStudioHistoricalGenerationEvidenceByPack,
  readStudioUnitGridGenerationFrozenPack,
} from "./studio-generation-ledger.js";
import { readStudioGenerationReview } from "./studio-generation-review.js";
import { getStudioProductionUnitSnapshot } from "./studio-production.js";
import { assertStudioUnitGridGenerationFreezePackCurrent } from "./studio-unit-grid-generation.js";
import type { StudioUnitGridGenerationFreezePack } from "./studio-unit-grid-generation.js";
import type { StudioFormalImagegenProvider } from "./studio-imagegen-providers.js";
import {
  managedEvidenceVideoPackageSourceAdapter,
  type ManagedEvidenceVideoPackageSourceInput,
  type ManagedEvidenceVideoPackageSourceSpec,
} from "./studio-video-package-source-adapter.js";
import {
  bindStudioVideoPackageSourceClosure,
  freezeStudioVideoPackageSourceClosure,
  readStudioVideoPackageSourceClosure,
  readStudioVideoPackageSourceClosureBinding,
  verifyStudioVideoPackageSourceClosure,
  type ReadStudioVideoPackageSourceClosure,
  type StudioVideoPackageSourceClosureJson,
} from "./studio-video-package-source-closure.js";
import {
  getActiveDuduReadonlyProjectIdentity,
  getActiveDuduReadonlyProjectIdentityReadOnly,
  type DuduReadonlyActiveProjectIdentity,
} from "./dudu-readonly-import.js";
import {
  readDuduFrozenVisualExecutionUnit,
  type DuduParsedPanel,
} from "./dudu-readonly-source.js";
import { withProjectLock } from "./locks.js";
import { getOperationContext } from "./operation-context.js";
import { openSqliteReadOnlySnapshot, type SqliteReadOnlySnapshot } from "./sqlite-readonly-snapshot.js";

const VIDEO_PACKAGE_SCHEMA_VERSION = 5 as const;
const PREVIOUS_VIDEO_PACKAGE_SCHEMA_VERSION = 4 as const;
const LEGACY_VIDEO_PACKAGE_SCHEMA_VERSION = 3 as const;
const VIDEO_PACKAGE_SCHEMA_MARKER = "studio_video_package_schema_version";
const BUSY_TIMEOUT_MILLISECONDS = 5_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const BUILDER_RELATIVE_PATH = "tools/build_video_submission_pack.py";
const OUTPUT_ROOT_RELATIVE_PATH = "06_图生视频提交包/S1E1";
const SOURCE_SPEC_ROOT_RELATIVE_PATH = "05_提示词";
const MANAGED_CORE_BUILDER_RELATIVE_PATH = ".aicanvas/studio-video-package-runtime/core-managed-video-package-v1";
const MANAGED_OUTPUT_ROOT_RELATIVE_PATH = ".aicanvas/studio-video-package-projection/packages";
const MANAGED_SOURCE_SPEC_ROOT_RELATIVE_PATH = ".aicanvas/studio-video-package-projection/specs";
const MANAGED_RAW_ROOT_RELATIVE_PATH = ".aicanvas/studio-video-package-projection/raw";
const MANAGED_CORE_BUILDER_BYTES = Buffer.from(
  "AI Canvas core-managed video package builder v1\n",
  "utf8",
);
const INSTALL_CLAIM_FILE = ".studio-video-package-install-claim.json";
const EXECUTION_TIMEOUT_MS = 120_000;
const SAFE_RENAME_PYTHON = "/usr/bin/python3";
const MAX_VIDEO_PACKAGE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_VIDEO_PACKAGE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_VIDEO_MARKDOWN_BYTES = 2 * 1024 * 1024;
const MAX_VIDEO_IMAGE_PIXELS = 40_000_000;
const VIDEO_BUILDER_PYTHON_CANDIDATES = [
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/usr/bin/python3",
] as const;
const VIDEO_BUILDER_MAGICK_CANDIDATES = [
  "/opt/homebrew/bin/magick",
  "/usr/local/bin/magick",
] as const;
const VIDEO_BUILDER_FONT_PATH = "/System/Library/Fonts/STHeiti Medium.ttc";
function isolatedSubprocessEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    ...extra,
  };
}
const SAFE_RENAME_SCRIPT = String.raw`
import ctypes, errno, fcntl, os, sys

RENAME_EXCL = 0x00000004
RENAME_NOFOLLOW_ANY = 0x00000010
F_GETPATH = 50

def open_exact_directory(expected, expected_dev, expected_ino):
    fd = os.open(expected, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    current = os.fstat(fd)
    actual = fcntl.fcntl(fd, F_GETPATH, b"\0" * 1024).split(b"\0", 1)[0].decode("utf-8")
    if actual != expected or str(current.st_dev) != expected_dev or str(current.st_ino) != expected_ino:
        os.close(fd)
        raise RuntimeError(f"directory identity mismatch: expected={expected} actual={actual}")
    return fd

(
    source_parent, source_name, destination_parent, destination_name,
    source_parent_dev, source_parent_ino, destination_parent_dev, destination_parent_ino,
) = sys.argv[1:]
if os.path.basename(source_name) != source_name or os.path.basename(destination_name) != destination_name:
    raise RuntimeError("rename names must be basenames")
source_fd = open_exact_directory(source_parent, source_parent_dev, source_parent_ino)
destination_fd = open_exact_directory(destination_parent, destination_parent_dev, destination_parent_ino)
try:
    libc = ctypes.CDLL(None, use_errno=True)
    renameatx_np = libc.renameatx_np
    renameatx_np.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameatx_np.restype = ctypes.c_int
    result = renameatx_np(
        source_fd,
        os.fsencode(source_name),
        destination_fd,
        os.fsencode(destination_name),
        RENAME_EXCL | RENAME_NOFOLLOW_ANY,
    )
    if result != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
finally:
    os.close(source_fd)
    os.close(destination_fd)
`;
const SAFE_INSTALL_FILE_SCRIPT = String.raw`
import fcntl, hashlib, os, stat, sys

F_GETPATH = 50

def open_exact_directory(expected, expected_dev, expected_ino):
    fd = os.open(expected, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    current = os.fstat(fd)
    actual = fcntl.fcntl(fd, F_GETPATH, b"\0" * 1024).split(b"\0", 1)[0].decode("utf-8")
    if actual != expected or str(current.st_dev) != expected_dev or str(current.st_ino) != expected_ino:
        os.close(fd)
        raise RuntimeError(f"directory identity mismatch: expected={expected} actual={actual}")
    return fd

def hash_open_file(fd):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_size < 1:
        raise RuntimeError("source/destination is not a non-empty regular file")
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    after = os.fstat(fd)
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
        after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns
    ):
        raise RuntimeError("file changed while hashing")
    return digest.hexdigest(), before

(
    source_parent, source_name, destination_parent, destination_name, expected_sha,
    source_parent_dev, source_parent_ino, destination_parent_dev, destination_parent_ino,
    repair_mismatched_existing, fault_mode,
) = sys.argv[1:]
if os.path.basename(source_name) != source_name or os.path.basename(destination_name) != destination_name:
    raise RuntimeError("install names must be basenames")

source_directory_fd = open_exact_directory(source_parent, source_parent_dev, source_parent_ino)
destination_directory_fd = open_exact_directory(
    destination_parent, destination_parent_dev, destination_parent_ino
)
source_fd = None
destination_fd = None
created = False
try:
    source_fd = os.open(source_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=source_directory_fd)
    source_hash, source_before = hash_open_file(source_fd)
    if source_hash != expected_sha:
        raise RuntimeError("source hash mismatch")
    try:
        destination_fd = os.open(
            destination_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=destination_directory_fd,
        )
        created = True
    except FileExistsError:
        existing_fd = None
        existing_matches = False
        try:
            existing_fd = os.open(destination_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=destination_directory_fd)
            existing_hash, _ = hash_open_file(existing_fd)
            existing_matches = existing_hash == expected_sha
        except (OSError, RuntimeError):
            existing_matches = False
        finally:
            if existing_fd is not None:
                os.close(existing_fd)
        if existing_matches:
            os.fsync(destination_directory_fd)
            raise SystemExit(0)
        existing_metadata = os.stat(destination_name, dir_fd=destination_directory_fd, follow_symlinks=False)
        if repair_mismatched_existing != "1" or not stat.S_ISREG(existing_metadata.st_mode):
            raise RuntimeError("existing destination hash mismatch")
        os.unlink(destination_name, dir_fd=destination_directory_fd)
        os.fsync(destination_directory_fd)
        destination_fd = os.open(
            destination_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=destination_directory_fd,
        )
        created = True

    os.lseek(source_fd, 0, os.SEEK_SET)
    copied_hash = hashlib.sha256()
    copied_size = 0
    while True:
        chunk = os.read(source_fd, 1024 * 1024)
        if not chunk:
            break
        if fault_mode == "partial-file" and copied_size == 0:
            partial = chunk[:max(1, len(chunk) // 2)]
            os.write(destination_fd, partial)
            os.fsync(destination_fd)
            os.fsync(destination_directory_fd)
            os._exit(91)
        copied_hash.update(chunk)
        copied_size += len(chunk)
        view = memoryview(chunk)
        while view:
            written = os.write(destination_fd, view)
            view = view[written:]
    source_after = os.fstat(source_fd)
    if (source_before.st_dev, source_before.st_ino, source_before.st_size, source_before.st_mtime_ns) != (
        source_after.st_dev, source_after.st_ino, source_after.st_size, source_after.st_mtime_ns
    ) or copied_size != source_before.st_size or copied_hash.hexdigest() != expected_sha:
        raise RuntimeError("source changed while copying")
    os.fsync(destination_fd)
    os.close(destination_fd)
    destination_fd = None
    landed_fd = os.open(destination_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=destination_directory_fd)
    try:
        landed_hash, _ = hash_open_file(landed_fd)
        if landed_hash != expected_sha:
            raise RuntimeError("landed destination hash mismatch")
    finally:
        os.close(landed_fd)
    os.fsync(destination_directory_fd)
except BaseException:
    if destination_fd is not None:
        os.close(destination_fd)
        destination_fd = None
    if created:
        try:
            os.unlink(destination_name, dir_fd=destination_directory_fd)
            os.fsync(destination_directory_fd)
        except FileNotFoundError:
            pass
    raise
finally:
    if source_fd is not None:
        os.close(source_fd)
    if destination_fd is not None:
        os.close(destination_fd)
    os.close(source_directory_fd)
    os.close(destination_directory_fd)
`;

export type StudioVideoPackageAuthorityInput =
  | { kind: "studio-review"; reviewId: string }
  | { kind: "historical-import"; packId: string };

export interface StudioVideoPackageExpectedManagedSource {
  adapterKind: "managed-evidence-v1";
  reviewId: string;
  expectedSourceFingerprint: string;
  expectedReviewFingerprint: string;
  expectedPackFingerprint: string;
  expectedUnitSnapshotFingerprint: string;
  expectedObservationControlFingerprint: string;
  expectedObservationHeadRevision: number;
  expectedObservationStatus: "missing" | "current" | "stale";
  expectedObservationHeadId: string | null;
  expectedObservationHeadFingerprint: string | null;
  expectedObservationEvidenceSha256: string | null;
}

export interface PrepareStudioVideoPackageExportInput {
  operationId: string;
  authority: StudioVideoPackageAuthorityInput;
  /**
   * studio-review 必须显式绑定调用方刚读取的 managed-evidence CAS。
   * historical-import 不得携带该字段，且实际连续状态一律保守为 unknown。
   */
  expectedManagedSource?: StudioVideoPackageExpectedManagedSource;
  /** command-bus CAS；Core 兼容调用可省略。 */
  expectedRevision?: number;
}

/**
 * 通用受管证据的只读 source-spec 入口。
 *
 * 三层 expected 指纹均为必填，避免调用方基于旧 Review、旧冻结包或旧 Unit
 * 继续导出。本入口不写视频包账本、不创建文件，也不调用 Dudu 专属 builder。
 */
export interface PrepareStudioVideoPackageSourceInput extends ManagedEvidenceVideoPackageSourceInput {
  adapterKind: "managed-evidence-v1";
}

export type PreparedStudioVideoPackageSource = ManagedEvidenceVideoPackageSourceSpec;

export interface BuildAndVerifyStudioVideoPackageOptions {
  /** command-bus CAS；Core 兼容调用可省略。 */
  expectedRevision?: number;
  /** P30 软件回放必须只写受管证据，绝不安装到外部生产根。 */
  destinationPolicy?: "automatic" | "managed-evidence-only";
  /** command-bus requestHash；把 durable proof 绑定到精确 build CAS 请求。 */
  commandRequestHash?: string;
}

export interface PrepareStudioVideoPackagePublicationInput {
  operationId: string;
  successorIntentId: string;
}

export interface StudioVideoPackageExportIntent {
  /** v3 仅供历史只读；v4 兼容旧 live-source build；所有新 intent 均写 v5 source closure。 */
  schemaVersion: 3 | 4 | 5;
  kind: "studio-video-package-export-intent";
  sequence: number;
  intentId: string;
  operationId: string;
  inputFingerprint: string;
  projectId: string;
  authorityKind: "studio-review" | "historical-import";
  authorityId: string;
  authorityFingerprint: string;
  packId: string;
  packFingerprint: string;
  targetKind: "unit-grid";
  targetKey: string;
  unitId: string;
  unitRevision: number;
  generationRunId: string | null;
  rawResultId: string;
  rawSha256: string;
  labeledResultId: string;
  labeledSha256: string;
  duduImportReceiptFingerprint: string;
  duduRegistrationFingerprint: string;
  sourceManifestFingerprint: string;
  productionScopeFingerprint: string;
  contractSha256: string;
  productionRoot: string;
  builderRelativePath: string;
  builderSha256: string;
  sourceSpecRelativePath: string;
  sourceSpecSha256: string;
  outputRootRelativePath: string;
  packageRelativePath: string;
  supersedesIntentId: string | null;
  createdAt: string;
  /** 仅 v4 studio-review 存在；旧 v3 intent 与 historical-import 均省略。 */
  managedSourceFingerprint?: string;
  managedSourceUnitSnapshotFingerprint?: string;
  observationControlFingerprint?: string;
  observationControlStatus?: "missing" | "current" | "stale";
  observationHeadRevision?: number;
  observationId?: string | null;
  observationHeadFingerprint?: string | null;
  observationEvidenceContractVersion?: number | null;
  observationEvidenceKind?: string | null;
  observationEvidenceSha256?: string | null;
  observationEvidenceLineageFingerprint?: string | null;
  /** 仅 v5 存在；inputFingerprint 与 intent 内容地址均显式绑定该不可变闭包。 */
  sourceClosureFingerprint?: string;
  fingerprint: string;
}

export interface StudioVideoPackageManifestFile {
  path: string;
  sha256: string;
}

export interface StudioVideoPackageVerifyReceipt {
  schemaVersion: 3;
  kind: "studio-video-package-verify-receipt";
  sequence: number;
  receiptId: string;
  intentId: string;
  storageKind: "managed-evidence" | "external-production";
  storageRelativePath: string;
  manifestRelativePath: string;
  manifestSha256: string;
  manifestFingerprint: string;
  files: StudioVideoPackageManifestFile[];
  specSchemaVersion: "1.0" | "2.0";
  packageStatus: string;
  i2vReadiness: string;
  mechanicalStatus: "verified";
  i2vStaticStatus: "legacy-audit-required" | "needs-independent-frame-or-review" | "ready";
  dynamicModelStatus: "not-run";
  verifiedAt: string;
  fingerprint: string;
}

export interface StudioVideoPackagePublicationIntent {
  schemaVersion: 1;
  kind: "studio-video-package-publication-intent";
  sequence: number;
  publicationId: string;
  operationId: string;
  successorIntentId: string;
  successorReceiptId: string;
  priorExternalIntentId: string;
  priorExternalReceiptId: string;
  productionRoot: string;
  packageRelativePath: string;
  archiveRelativePath: string;
  createdAt: string;
  fingerprint: string;
}

export interface StudioVideoPackagePublicationReceipt {
  schemaVersion: 1;
  kind: "studio-video-package-publication-receipt";
  sequence: number;
  publicationReceiptId: string;
  publicationId: string;
  archivedManifestSha256: string;
  archivedManifestFingerprint: string;
  publishedManifestSha256: string;
  publishedManifestFingerprint: string;
  completedAt: string;
  fingerprint: string;
}

export interface StudioVideoPackageExportControl {
  schemaVersion: 3;
  kind: "studio-video-package-export-control";
  intent: StudioVideoPackageExportIntent;
  receipt: StudioVideoPackageVerifyReceipt | null;
  status: "prepared" | "mechanically-verified" | "stale";
  mechanicalStatus: "not-run" | "verified" | "stale";
  i2vStaticStatus: "not-assessed" | "legacy-audit-required" | "needs-independent-frame-or-review" | "ready";
  dynamicModelStatus: "not-run";
  blockers: string[];
  nextAction:
    | "build-or-adopt-and-verify"
    | "complete-i2v-static-input"
    | "resolve-external-production-conflict"
    | "package-ready-dynamic-model-not-tested"
    | "repair-input";
  fingerprint: string;
}

export type StudioVideoPackageControlQuery =
  | { by: "intent"; intentId: string }
  | { by: "authority-latest"; authority: StudioVideoPackageAuthorityInput };

export interface StudioVideoPackageControlLookup {
  schemaVersion: 1;
  kind: "studio-video-package-control-lookup";
  query: StudioVideoPackageControlQuery;
  status: "not-prepared" | "resolved" | "conflict";
  selectedIntentId: string | null;
  selectedIsDestinationHead: boolean | null;
  control: StudioVideoPackageExportControl | null;
  blockers: Array<"authority-destination-conflict" | "authority-supersession-chain-conflict">;
  nextAction:
    | "prepare-via-authorized-core-orchestration"
    | "use-resolved-control"
    | "resolve-video-package-ledger-conflict";
  readOnly: true;
  fingerprint: string;
}

export interface StudioVideoPackageLedgerState {
  schemaVersion: 1;
  databasePath: string;
  generationLedgerReused: true;
  counts: { intents: number; verifyReceipts: number; operationAliases: number; publicationIntents: number; publicationReceipts: number };
}

export type StudioVideoPackageErrorCode =
  | "invalid-input"
  | "unmanaged-project"
  | "storage-invalid"
  | "operation-conflict"
  | "destination-conflict"
  | "authority-not-ready"
  | "input-drift"
  | "builder-failed"
  | "verify-failed"
  | "intent-not-found";

export class StudioVideoPackageError extends Error {
  readonly code: StudioVideoPackageErrorCode;
  readonly details: string[];

  constructor(code: StudioVideoPackageErrorCode, message: string, details: string[] = [], options?: ErrorOptions) {
    super(message, options);
    this.name = "StudioVideoPackageError";
    this.code = code;
    this.details = details;
  }
}

interface IntentRow {
  sequence: number;
  intent_id: string;
  operation_id: string;
  input_fingerprint: string;
  project_id: string;
  authority_kind: "studio-review" | "historical-import";
  authority_id: string;
  authority_fingerprint: string;
  pack_id: string;
  pack_fingerprint: string;
  target_kind: "unit-grid";
  target_key: string;
  unit_id: string;
  unit_revision: number;
  generation_run_id: string | null;
  raw_result_id: string;
  raw_sha256: string;
  labeled_result_id: string;
  labeled_sha256: string;
  dudu_import_receipt_fingerprint: string;
  dudu_registration_fingerprint: string;
  source_manifest_fingerprint: string;
  production_scope_fingerprint: string;
  contract_sha256: string;
  production_root: string;
  builder_relative_path: string;
  builder_sha256: string;
  source_spec_relative_path: string;
  source_spec_sha256: string;
  output_root_relative_path: string;
  package_relative_path: string;
  supersedes_intent_id: string | null;
  created_at: string;
  fingerprint: string;
  /** v3 账本读取时这些列不存在；v4 迁移后旧行以 schema=3 + NULL 保留。 */
  intent_schema_version?: number;
  managed_source_fingerprint?: string | null;
  managed_source_unit_snapshot_fingerprint?: string | null;
  observation_control_fingerprint?: string | null;
  observation_control_status?: "missing" | "current" | "stale" | null;
  observation_head_revision?: number | null;
  observation_id?: string | null;
  observation_head_fingerprint?: string | null;
  observation_evidence_contract_version?: number | null;
  observation_evidence_kind?: string | null;
  observation_evidence_sha256?: string | null;
  observation_evidence_lineage_fingerprint?: string | null;
  /** v5 采用追加 shadow contract，避免破坏旧 CHECK(intent_schema_version IN (3,4))。 */
  intent_contract_version?: number | null;
  source_closure_fingerprint?: string | null;
}

interface ReceiptRow {
  sequence: number;
  receipt_id: string;
  intent_id: string;
  storage_kind: "managed-evidence" | "external-production";
  storage_relative_path: string;
  manifest_relative_path: string;
  manifest_sha256: string;
  manifest_fingerprint: string;
  files_json: string;
  spec_schema_version: "1.0" | "2.0";
  package_status: string;
  i2v_readiness: string;
  mechanical_status: "verified";
  i2v_static_status: "legacy-audit-required" | "needs-independent-frame-or-review" | "ready";
  dynamic_model_status: "not-run";
  verified_at: string;
  fingerprint: string;
}

interface OperationAliasRow {
  sequence: number;
  operation_id: string;
  input_fingerprint: string;
  intent_id: string;
  created_at: string;
  fingerprint: string;
}

interface PublicationIntentRow {
  sequence: number;
  publication_id: string;
  operation_id: string;
  successor_intent_id: string;
  successor_receipt_id: string;
  prior_external_intent_id: string;
  prior_external_receipt_id: string;
  production_root: string;
  package_relative_path: string;
  archive_relative_path: string;
  created_at: string;
  fingerprint: string;
}

interface PublicationReceiptRow {
  sequence: number;
  publication_receipt_id: string;
  publication_id: string;
  archived_manifest_sha256: string;
  archived_manifest_fingerprint: string;
  published_manifest_sha256: string;
  published_manifest_fingerprint: string;
  completed_at: string;
  fingerprint: string;
}

interface ResolvedAuthority {
  pack: StudioUnitGridGenerationFreezePack;
  projectId: string;
  authorityKind: StudioVideoPackageExportIntent["authorityKind"];
  authorityId: string;
  authorityFingerprint: string;
  packId: string;
  packFingerprint: string;
  targetKey: string;
  unitId: string;
  unitRevision: number;
  /** Studio Review 产物的真实派发供应方；历史零调用导入没有 provider。 */
  provider: StudioFormalImagegenProvider | null;
  generationRunId: string | null;
  rawResultId: string;
  rawSha256: string;
  labeledResultId: string;
  labeledSha256: string;
}

type VideoPackageDuduIdentity = Pick<
  DuduReadonlyActiveProjectIdentity,
  | "projectId"
  | "projectRoot"
  | "sourceProductionRoot"
  | "sourceLockedScriptPath"
  | "sourceManifestFingerprint"
  | "productionScopeFingerprint"
  | "contractSha256"
  | "importReceiptFingerprint"
  | "registrationFingerprint"
>;

interface ResolvedExternalInput {
  sourceKind: "dudu-readonly" | "managed-project";
  projectionMode: "frozen-historical" | "studio-review-derived";
  /**
   * v3-v5 SQLite 列与 source-closure 字段沿用历史名称。managed-project
   * 只在这些列中保存通用来源内容地址，不表示或伪装为 Dudu 导入。
   */
  duduIdentity: VideoPackageDuduIdentity;
  productionRoot: string;
  builderRelativePath: string;
  builderPath: string;
  builderSha256: string;
  pythonPath: string;
  pythonSha256: string;
  magickPath: string;
  magickSha256: string;
  fontPath: string;
  fontSha256: string;
  sourceSpecRelativePath: string;
  sourceSpecPath: string;
  sourceSpecSha256: string;
  sourceSpec: Record<string, unknown>;
  outputRootRelativePath: string;
  outputRootPath: string;
  packageRelativePath: string;
  packagePath: string;
  builderSnapshot: StableFileSnapshot;
  fontSnapshot: StableFileSnapshot;
  sourceSpecSnapshot: StableFileSnapshot;
  rawSnapshot: StableFileSnapshot;
  labeledSnapshot: StableFileSnapshot;
  rawRelativePath: string;
  dependencies: Array<{ relativePath: string; snapshot: StableFileSnapshot }>;
  managedSource?: ManagedEvidenceVideoPackageSourceSpec;
  sourceClosureFingerprint?: string;
}

type ManifestValidationAuthority = Pick<
  ResolvedAuthority,
  "pack" | "unitId" | "rawSha256" | "labeledSha256"
>;

type ManifestValidationExternal = Pick<
  ResolvedExternalInput,
  | "sourceKind"
  | "duduIdentity"
  | "managedSource"
  | "packagePath"
  | "packageRelativePath"
  | "rawRelativePath"
  | "rawSnapshot"
  | "sourceSpec"
  | "sourceSpecRelativePath"
  | "sourceSpecSha256"
>;

type PublicationPriorExternal = ManifestValidationExternal & Pick<
  ResolvedExternalInput,
  "productionRoot"
>;

async function resolveVideoBuilderPython(): Promise<{ path: string; sha256: string }> {
  const failures: string[] = [];
  for (const candidate of VIDEO_BUILDER_PYTHON_CANDIDATES) {
    try {
      const canonical = await realpath(candidate);
      if (!path.isAbsolute(canonical)) throw new Error("canonical path is not absolute");
      const snapshot = await readStableFile(canonical);
      await runExecutable(canonical, [
        "-I",
        "-S",
        "-c",
        "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 2)",
      ], "build", isolatedSubprocessEnvironment());
      return { path: canonical, sha256: snapshot.sha256 };
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new StudioVideoPackageError(
    "builder-failed",
    "视频包需要可验证的绝对 Python 3.10+ 解释器。",
    failures,
  );
}

async function resolveVideoBuilderMagick(): Promise<{ path: string; sha256: string }> {
  const failures: string[] = [];
  for (const candidate of VIDEO_BUILDER_MAGICK_CANDIDATES) {
    try {
      const canonical = await realpath(candidate);
      if (!path.isAbsolute(canonical)) throw new Error("canonical path is not absolute");
      const snapshot = await readStableFile(canonical);
      await runExecutable(canonical, ["-version"], "build", isolatedSubprocessEnvironment());
      return { path: canonical, sha256: snapshot.sha256 };
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new StudioVideoPackageError(
    "builder-failed",
    "视频包需要可验证的绝对 ImageMagick 7 可执行文件。",
    failures,
  );
}

async function resolveVideoBuilderFont(): Promise<{ path: string; sha256: string; snapshot: StableFileSnapshot }> {
  const canonical = await realpath(VIDEO_BUILDER_FONT_PATH).catch((error: unknown) => {
    throw new StudioVideoPackageError("builder-failed", "视频包固定中文字体不存在。", [], { cause: error });
  });
  if (canonical !== VIDEO_BUILDER_FONT_PATH) fail("builder-failed", "视频包固定中文字体不得经符号链接解析。 ");
  const snapshot = await readStableFile(canonical);
  return { path: canonical, sha256: snapshot.sha256, snapshot };
}

function videoBuilderEnvironment(external: ResolvedExternalInput, builderPath: string): NodeJS.ProcessEnv {
  const environment = isolatedSubprocessEnvironment({
    PATH: `${path.dirname(external.magickPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: path.dirname(path.dirname(builderPath)),
  });
  if (process.env.NODE_ENV === "test") {
    if (process.env.P30_TEST_BUILDER_COUNTER) environment.P30_TEST_BUILDER_COUNTER = process.env.P30_TEST_BUILDER_COUNTER;
    if (process.env.P30_TEST_BUILDER_FAULT) environment.P30_TEST_BUILDER_FAULT = process.env.P30_TEST_BUILDER_FAULT;
  }
  return environment;
}

function fail(code: StudioVideoPackageErrorCode, message: string, details: string[] = []): never {
  throw new StudioVideoPackageError(code, message, details);
}

/**
 * 以既有视频包模块作为稳定 facade，建立可供后续通用 builder 消费的 source spec。
 *
 * 当前只接入 managed-evidence-v1。它保留声音未指定与实际末态未观测的真实状态；
 * 完整文件包仍由 legacy Dudu 路径构建，禁止用项目专属目录或占位音频硬适配。
 */
export async function prepareStudioVideoPackageSource(
  projectRoot: string,
  rawInput: PrepareStudioVideoPackageSourceInput,
): Promise<PreparedStudioVideoPackageSource> {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    fail("invalid-input", "视频包 source input 结构无效。");
  }
  const allowedFields = new Set([
    "adapterKind",
    "reviewId",
    "expectedReviewFingerprint",
    "expectedPackFingerprint",
    "expectedUnitSnapshotFingerprint",
    "expectedObservationControlFingerprint",
    "expectedObservationHeadRevision",
    "expectedObservationStatus",
    "expectedObservationHeadId",
    "expectedObservationHeadFingerprint",
    "expectedObservationEvidenceSha256",
  ]);
  const unexpectedFields = Object.keys(rawInput).filter((field) => !allowedFields.has(field));
  if (unexpectedFields.length > 0) {
    fail("invalid-input", "视频包 source input 含未授权字段。", unexpectedFields.sort());
  }
  if (rawInput.adapterKind !== "managed-evidence-v1") {
    fail("invalid-input", `不支持的视频包 source adapter：${String(rawInput.adapterKind)}`);
  }
  return managedEvidenceVideoPackageSourceAdapter.build(projectRoot, {
    reviewId: rawInput.reviewId,
    expectedReviewFingerprint: rawInput.expectedReviewFingerprint,
    expectedPackFingerprint: rawInput.expectedPackFingerprint,
    expectedUnitSnapshotFingerprint: rawInput.expectedUnitSnapshotFingerprint,
    expectedObservationControlFingerprint: rawInput.expectedObservationControlFingerprint,
    expectedObservationHeadRevision: rawInput.expectedObservationHeadRevision,
    expectedObservationStatus: rawInput.expectedObservationStatus,
    expectedObservationHeadId: rawInput.expectedObservationHeadId,
    expectedObservationHeadFingerprint: rawInput.expectedObservationHeadFingerprint,
    expectedObservationEvidenceSha256: rawInput.expectedObservationEvidenceSha256,
  });
}

async function sha256File(filePath: string): Promise<string> {
  return (await readStableFile(filePath)).sha256;
}

interface StableFileSnapshot {
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
}

interface DecodedPngSnapshot {
  data: Buffer;
  width: number;
  height: number;
}

async function readStableFile(filePath: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<StableFileSnapshot> {
  const absolute = path.resolve(filePath);
  let pathBefore;
  let handle;
  try {
    pathBefore = await lstat(absolute, { bigint: true });
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()
      || pathBefore.size < 1n || pathBefore.size > BigInt(maxBytes)
      || await realpath(absolute) !== absolute) {
      fail("input-drift", `文件类型、大小或命名路径无效：${absolute}`);
    }
    handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof StudioVideoPackageError) throw error;
    throw new StudioVideoPackageError("input-drift", `文件无法安全打开：${absolute}`, [], { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes)
      || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino) {
      fail("input-drift", `文件打开前命名路径发生替换：${absolute}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(absolute, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || BigInt(bytes.byteLength) !== before.size
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino
      || pathAfter.size !== before.size || pathAfter.mtimeNs !== before.mtimeNs
      || !pathAfter.isFile() || pathAfter.isSymbolicLink()
      || await realpath(absolute) !== absolute) {
      fail("input-drift", `文件读取期间命名路径或内容发生变化：${absolute}`);
    }
    return {
      bytes,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

function decodeUtf8Strict(snapshot: StableFileSnapshot, label: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
  } catch (error) {
    throw new StudioVideoPackageError("verify-failed", `${label} 不是合法 UTF-8 文本。`, [], { cause: error });
  }
  if (!text.trim() || text.includes("\0")) fail("verify-failed", `${label} 为空或含 NUL。`);
  return text;
}

async function decodePngSnapshot(snapshot: StableFileSnapshot, label: string): Promise<DecodedPngSnapshot> {
  try {
    const options = { failOn: "error" as const, limitInputPixels: MAX_VIDEO_IMAGE_PIXELS };
    const metadata = await sharp(snapshot.bytes, options).metadata();
    if (metadata.format !== "png" || !metadata.width || !metadata.height
      || metadata.width > 16_384 || metadata.height > 16_384) {
      fail("verify-failed", `${label} 必须是尺寸受限的可解码 PNG。`);
    }
    const decoded = await sharp(snapshot.bytes, options)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== metadata.width || decoded.info.height !== metadata.height
      || decoded.info.channels !== 4 || decoded.data.byteLength !== metadata.width * metadata.height * 4) {
      fail("verify-failed", `${label} PNG 完整解码尺寸无效。`);
    }
    return { data: decoded.data, width: metadata.width, height: metadata.height };
  } catch (error) {
    if (error instanceof StudioVideoPackageError) throw error;
    throw new StudioVideoPackageError("verify-failed", `${label} PNG 无法完整解码。`, [], { cause: error });
  }
}

function normalizeId(value: unknown, field: string): string {
  if (typeof value !== "string") fail("invalid-input", `${field} 必须是字符串。`);
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized)) fail("invalid-input", `${field} 格式无效。`);
  return normalized;
}

function normalizeSha(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value.trim().toLowerCase())) {
    fail("input-drift", `${field} 必须是 64 位 SHA-256。`);
  }
  return value.trim().toLowerCase();
}

function normalizeRelative(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail("invalid-input", `${field} 不能为空。`);
  const normalized = value.normalize("NFC").trim();
  if (normalized.includes("\\") || path.posix.isAbsolute(normalized)
    || path.posix.normalize(normalized) !== normalized
    || normalized === ".." || normalized.startsWith("../")) {
    fail("invalid-input", `${field} 必须是规范化、不可逃逸的 POSIX 相对路径。`);
  }
  return normalized;
}

function pathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalDirectory(directory: string, field: string): Promise<string> {
  if (!path.isAbsolute(directory)) fail("invalid-input", `${field} 必须是绝对路径。`);
  const resolved = path.resolve(directory);
  let metadata;
  try {
    metadata = await lstat(resolved);
  } catch (error) {
    throw new StudioVideoPackageError("invalid-input", `${field} 不存在：${resolved}`, [], { cause: error });
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("invalid-input", `${field} 必须是真实目录且不能是符号链接。`);
  const canonical = await realpath(resolved);
  if (canonical !== resolved) fail("invalid-input", `${field} 不能经符号链接解析。`);
  return canonical;
}

async function assertSafeRelativeChain(root: string, relative: string, finalType: "file" | "directory-or-missing"): Promise<string> {
  const target = path.join(root, ...relative.split("/"));
  if (!pathInside(target, root)) fail("invalid-input", `相对路径逃逸生产根：${relative}`);
  const parts = relative.split("/");
  let cursor = root;
  let missing = false;
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    if (missing) continue;
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) fail("invalid-input", `路径包含符号链接：${relative}`);
      const last = index === parts.length - 1;
      if (!last && !metadata.isDirectory()) fail("invalid-input", `路径父级不是目录：${relative}`);
      if (last && finalType === "file" && !metadata.isFile()) fail("invalid-input", `文件不存在：${relative}`);
      if (last && finalType === "directory-or-missing" && !metadata.isDirectory()) {
        fail("invalid-input", `输出路径已存在但不是目录：${relative}`);
      }
    } catch (error) {
      if (error instanceof StudioVideoPackageError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (finalType === "file") fail("invalid-input", `文件不存在：${relative}`);
      missing = true;
    }
  }
  if (finalType === "file") {
    const canonical = await realpath(target);
    if (!pathInside(canonical, root) || canonical !== target) fail("invalid-input", `文件不能经符号链接解析：${relative}`);
  }
  return target;
}

async function readJsonObject(filePath: string, label: string): Promise<Record<string, unknown>> {
  return (await readJsonSnapshot(filePath, label)).value;
}

async function readJsonSnapshot(filePath: string, label: string): Promise<{
  value: Record<string, unknown>;
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
}> {
  const snapshot = await readStableFile(filePath, MAX_JSON_BYTES);
  return {
    ...parseJsonSnapshot(snapshot, label),
    bytes: snapshot.bytes,
    sha256: snapshot.sha256,
    sizeBytes: snapshot.sizeBytes,
  };
}

function parseJsonSnapshot(snapshot: StableFileSnapshot, label: string): { value: Record<string, unknown> } {
  const bytes = snapshot.bytes;
  if (bytes.byteLength < 2) fail("input-drift", `${label} 大小无效。`);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new StudioVideoPackageError("input-drift", `${label} JSON 无法解析。`, [], { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("input-drift", `${label} 顶层必须是对象。`);
  return { value: value as Record<string, unknown> };
}

async function generationDatabasePath(projectRoot: string): Promise<string> {
  try {
    return (await initializeStudioGenerationLedger(projectRoot)).databasePath;
  } catch (error) {
    if (error instanceof StudioVideoPackageError) throw error;
    throw new StudioVideoPackageError(
      "unmanaged-project",
      "视频包账本只允许复用通过验证的 Studio generation ledger。",
      [error instanceof Error ? error.message : String(error)],
      { cause: error },
    );
  }
}

async function generationDatabasePathReadOnly(projectRoot: string): Promise<string> {
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const databasePath = shell.paths.generationDatabase;
  const metadata = await lstat(databasePath).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || await realpath(databasePath) !== databasePath) {
    fail("storage-invalid", "视频包只读控制面找不到安全的既有 generation ledger。 ");
  }
  return databasePath;
}

function openDatabase(databasePath: string, initialize: boolean): DatabaseSync {
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(BUSY_TIMEOUT_MILLISECONDS);
  const db = new DatabaseSync(databasePath, { timeout: busyTimeoutMs, readOnly: !initialize });
  try {
    db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;`);
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    if (journal?.journal_mode?.toLowerCase() !== "wal") fail("storage-invalid", "视频包账本必须复用 WAL generation ledger。");
    if (initialize) ensureSchema(db);
    assertSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function ensureSchema(db: DatabaseSync): void {
  runTransaction(db, () => {
    // 在 BEGIN IMMEDIATE 之后重读 marker，关闭两个进程并发首次初始化时的
    // check-then-insert 窗口。已声明账本只校验，绝不以 IF NOT EXISTS 静默修补。
    const existingMarker = db.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key = ?")
      .get(VIDEO_PACKAGE_SCHEMA_MARKER) as { value?: string } | undefined;
    if (existingMarker
      && existingMarker.value !== String(VIDEO_PACKAGE_SCHEMA_VERSION)
      && existingMarker.value !== String(PREVIOUS_VIDEO_PACKAGE_SCHEMA_VERSION)
      && existingMarker.value !== String(LEGACY_VIDEO_PACKAGE_SCHEMA_VERSION)) {
      fail("storage-invalid", `不支持的视频包账本 schema：${existingMarker.value}`);
    }
    if (existingMarker) {
      let schemaVersion = Number(existingMarker.value);
      if (existingMarker.value === String(LEGACY_VIDEO_PACKAGE_SCHEMA_VERSION)) {
        // v3 intent 没有 managed source / Observation 身份，只允许原样保留为只读历史。
        // 迁移只追加 nullable 列和逐行 schema 标志，绝不改写旧 intent 内容或指纹。
        assertSchema(db);
        db.exec(`
          ALTER TABLE studio_video_package_export_intents
            ADD COLUMN intent_schema_version INTEGER NOT NULL DEFAULT 3
              CHECK(intent_schema_version IN (3, 4));
          ALTER TABLE studio_video_package_export_intents
            ADD COLUMN managed_source_fingerprint TEXT
              CHECK(managed_source_fingerprint IS NULL OR length(managed_source_fingerprint) = 64);
          ALTER TABLE studio_video_package_export_intents
            ADD COLUMN managed_source_unit_snapshot_fingerprint TEXT
              CHECK(
                managed_source_unit_snapshot_fingerprint IS NULL
                OR length(managed_source_unit_snapshot_fingerprint) = 64
              );
          ALTER TABLE studio_video_package_export_intents
            ADD COLUMN observation_control_fingerprint TEXT
              CHECK(observation_control_fingerprint IS NULL OR length(observation_control_fingerprint) = 64);
          ALTER TABLE studio_video_package_export_intents
            ADD COLUMN observation_control_status TEXT
              CHECK(observation_control_status IS NULL OR observation_control_status IN ('missing', 'current', 'stale'));
          ALTER TABLE studio_video_package_export_intents
            ADD COLUMN observation_head_revision INTEGER
              CHECK(observation_head_revision IS NULL OR observation_head_revision >= 0);
          ALTER TABLE studio_video_package_export_intents ADD COLUMN observation_id TEXT;
          ALTER TABLE studio_video_package_export_intents
            ADD COLUMN observation_head_fingerprint TEXT
              CHECK(observation_head_fingerprint IS NULL OR length(observation_head_fingerprint) = 64);
          ALTER TABLE studio_video_package_export_intents
            ADD COLUMN observation_evidence_contract_version INTEGER
              CHECK(observation_evidence_contract_version IS NULL OR observation_evidence_contract_version >= 1);
          ALTER TABLE studio_video_package_export_intents ADD COLUMN observation_evidence_kind TEXT;
          ALTER TABLE studio_video_package_export_intents
            ADD COLUMN observation_evidence_sha256 TEXT
              CHECK(observation_evidence_sha256 IS NULL OR length(observation_evidence_sha256) = 64);
          ALTER TABLE studio_video_package_export_intents
            ADD COLUMN observation_evidence_lineage_fingerprint TEXT
              CHECK(observation_evidence_lineage_fingerprint IS NULL OR length(observation_evidence_lineage_fingerprint) = 64);
        `);
        db.prepare("UPDATE studio_generation_ledger_meta SET value=? WHERE key=?")
          .run(String(PREVIOUS_VIDEO_PACKAGE_SCHEMA_VERSION), VIDEO_PACKAGE_SCHEMA_MARKER);
        schemaVersion = PREVIOUS_VIDEO_PACKAGE_SCHEMA_VERSION;
      }
      if (schemaVersion === PREVIOUS_VIDEO_PACKAGE_SCHEMA_VERSION) {
        // v5 用 nullable shadow contract 追加 source closure；旧 v3/v4 行保持
        // intent_schema_version、id、fingerprint 与全部外键不变，不重建被多表引用的 owner。
        assertSchema(db);
        db.exec(`
          ALTER TABLE studio_video_package_export_intents
            ADD COLUMN intent_contract_version INTEGER
              CHECK(intent_contract_version IS NULL OR intent_contract_version = 5);
          ALTER TABLE studio_video_package_export_intents
            ADD COLUMN source_closure_fingerprint TEXT
              CHECK(
                (intent_contract_version IS NULL AND source_closure_fingerprint IS NULL)
                OR (
                  intent_contract_version = 5
                  AND intent_schema_version = 4
                  AND source_closure_fingerprint IS NOT NULL
                  AND length(source_closure_fingerprint) = 64
                )
              );
        `);
        db.prepare("UPDATE studio_generation_ledger_meta SET value=? WHERE key=?")
          .run(String(VIDEO_PACKAGE_SCHEMA_VERSION), VIDEO_PACKAGE_SCHEMA_MARKER);
      }
      assertSchema(db);
      return;
    }
    const residualObjects = db.prepare(`SELECT type, name FROM sqlite_master
      WHERE (type='table' OR type='trigger') AND name LIKE 'studio_video_package_%'
      ORDER BY type, name`).all() as Array<{ type: string; name: string }>;
    if (residualObjects.length > 0) {
      fail("storage-invalid", "视频包 schema marker 缺失但已存在业务对象，拒绝静默接管。", [
        ...residualObjects.map((item) => `${item.type}:${item.name}`),
      ]);
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS studio_video_package_export_intents (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_id TEXT NOT NULL UNIQUE,
      operation_id TEXT NOT NULL UNIQUE,
      input_fingerprint TEXT NOT NULL UNIQUE CHECK(length(input_fingerprint) = 64),
      project_id TEXT NOT NULL,
      authority_kind TEXT NOT NULL CHECK(authority_kind IN ('studio-review', 'historical-import')),
      authority_id TEXT NOT NULL,
      authority_fingerprint TEXT NOT NULL CHECK(length(authority_fingerprint) = 64),
      pack_id TEXT NOT NULL,
      pack_fingerprint TEXT NOT NULL CHECK(length(pack_fingerprint) = 64),
      target_kind TEXT NOT NULL CHECK(target_kind = 'unit-grid'),
      target_key TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
      generation_run_id TEXT,
      raw_result_id TEXT NOT NULL,
      raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256) = 64),
      labeled_result_id TEXT NOT NULL,
      labeled_sha256 TEXT NOT NULL CHECK(length(labeled_sha256) = 64),
      dudu_import_receipt_fingerprint TEXT NOT NULL CHECK(length(dudu_import_receipt_fingerprint) = 64),
      dudu_registration_fingerprint TEXT NOT NULL CHECK(length(dudu_registration_fingerprint) = 64),
      source_manifest_fingerprint TEXT NOT NULL CHECK(length(source_manifest_fingerprint) = 64),
      production_scope_fingerprint TEXT NOT NULL CHECK(length(production_scope_fingerprint) = 64),
      contract_sha256 TEXT NOT NULL CHECK(length(contract_sha256) = 64),
      production_root TEXT NOT NULL,
      builder_relative_path TEXT NOT NULL,
      builder_sha256 TEXT NOT NULL CHECK(length(builder_sha256) = 64),
      source_spec_relative_path TEXT NOT NULL,
      source_spec_sha256 TEXT NOT NULL CHECK(length(source_spec_sha256) = 64),
      output_root_relative_path TEXT NOT NULL,
      package_relative_path TEXT NOT NULL,
      supersedes_intent_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      intent_schema_version INTEGER NOT NULL DEFAULT 3 CHECK(intent_schema_version IN (3, 4)),
      managed_source_fingerprint TEXT CHECK(managed_source_fingerprint IS NULL OR length(managed_source_fingerprint) = 64),
      managed_source_unit_snapshot_fingerprint TEXT CHECK(
        managed_source_unit_snapshot_fingerprint IS NULL OR length(managed_source_unit_snapshot_fingerprint) = 64
      ),
      observation_control_fingerprint TEXT CHECK(observation_control_fingerprint IS NULL OR length(observation_control_fingerprint) = 64),
      observation_control_status TEXT CHECK(observation_control_status IS NULL OR observation_control_status IN ('missing', 'current', 'stale')),
      observation_head_revision INTEGER CHECK(observation_head_revision IS NULL OR observation_head_revision >= 0),
      observation_id TEXT,
      observation_head_fingerprint TEXT CHECK(observation_head_fingerprint IS NULL OR length(observation_head_fingerprint) = 64),
      observation_evidence_contract_version INTEGER CHECK(
        observation_evidence_contract_version IS NULL OR observation_evidence_contract_version >= 1
      ),
      observation_evidence_kind TEXT,
      observation_evidence_sha256 TEXT CHECK(observation_evidence_sha256 IS NULL OR length(observation_evidence_sha256) = 64),
      observation_evidence_lineage_fingerprint TEXT CHECK(
        observation_evidence_lineage_fingerprint IS NULL OR length(observation_evidence_lineage_fingerprint) = 64
      ),
      intent_contract_version INTEGER CHECK(intent_contract_version IS NULL OR intent_contract_version = 5),
      source_closure_fingerprint TEXT CHECK(
        (intent_contract_version IS NULL AND source_closure_fingerprint IS NULL)
        OR (
          intent_contract_version = 5
          AND intent_schema_version = 4
          AND source_closure_fingerprint IS NOT NULL
          AND length(source_closure_fingerprint) = 64
        )
      ),
      UNIQUE(intent_id, input_fingerprint),
      FOREIGN KEY(pack_id, pack_fingerprint)
        REFERENCES studio_generation_packs(pack_id, fingerprint) ON DELETE RESTRICT,
      FOREIGN KEY(supersedes_intent_id)
        REFERENCES studio_video_package_export_intents(intent_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS studio_video_package_intents_destination
      ON studio_video_package_export_intents(production_root, package_relative_path, sequence);

    CREATE TABLE IF NOT EXISTS studio_video_package_verify_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id TEXT NOT NULL UNIQUE,
      intent_id TEXT NOT NULL UNIQUE,
      storage_kind TEXT NOT NULL CHECK(storage_kind IN ('managed-evidence', 'external-production')),
      storage_relative_path TEXT NOT NULL,
      manifest_relative_path TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64),
      manifest_fingerprint TEXT NOT NULL CHECK(length(manifest_fingerprint) = 64),
      files_json TEXT NOT NULL,
      spec_schema_version TEXT NOT NULL CHECK(spec_schema_version IN ('1.0', '2.0')),
      package_status TEXT NOT NULL,
      i2v_readiness TEXT NOT NULL,
      mechanical_status TEXT NOT NULL CHECK(mechanical_status = 'verified'),
      i2v_static_status TEXT NOT NULL CHECK(i2v_static_status IN (
        'legacy-audit-required', 'needs-independent-frame-or-review', 'ready'
      )),
      dynamic_model_status TEXT NOT NULL CHECK(dynamic_model_status = 'not-run'),
      verified_at TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      FOREIGN KEY(intent_id) REFERENCES studio_video_package_export_intents(intent_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_video_package_operation_aliases (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL UNIQUE,
      input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint) = 64),
      intent_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      FOREIGN KEY(intent_id, input_fingerprint)
        REFERENCES studio_video_package_export_intents(intent_id, input_fingerprint) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_video_package_publication_intents (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      publication_id TEXT NOT NULL UNIQUE,
      operation_id TEXT NOT NULL UNIQUE,
      successor_intent_id TEXT NOT NULL UNIQUE,
      successor_receipt_id TEXT NOT NULL UNIQUE,
      prior_external_intent_id TEXT NOT NULL,
      prior_external_receipt_id TEXT NOT NULL UNIQUE,
      production_root TEXT NOT NULL,
      package_relative_path TEXT NOT NULL,
      archive_relative_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      FOREIGN KEY(successor_intent_id) REFERENCES studio_video_package_export_intents(intent_id) ON DELETE RESTRICT,
      FOREIGN KEY(successor_receipt_id) REFERENCES studio_video_package_verify_receipts(receipt_id) ON DELETE RESTRICT,
      FOREIGN KEY(prior_external_intent_id) REFERENCES studio_video_package_export_intents(intent_id) ON DELETE RESTRICT,
      FOREIGN KEY(prior_external_receipt_id) REFERENCES studio_video_package_verify_receipts(receipt_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_video_package_publication_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      publication_receipt_id TEXT NOT NULL UNIQUE,
      publication_id TEXT NOT NULL UNIQUE,
      archived_manifest_sha256 TEXT NOT NULL CHECK(length(archived_manifest_sha256) = 64),
      archived_manifest_fingerprint TEXT NOT NULL CHECK(length(archived_manifest_fingerprint) = 64),
      published_manifest_sha256 TEXT NOT NULL CHECK(length(published_manifest_sha256) = 64),
      published_manifest_fingerprint TEXT NOT NULL CHECK(length(published_manifest_fingerprint) = 64),
      completed_at TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      FOREIGN KEY(publication_id) REFERENCES studio_video_package_publication_intents(publication_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS studio_video_package_intents_no_update
      BEFORE UPDATE ON studio_video_package_export_intents BEGIN SELECT RAISE(ABORT, 'video package intents are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_video_package_intents_no_delete
      BEFORE DELETE ON studio_video_package_export_intents BEGIN SELECT RAISE(ABORT, 'video package intents are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_video_package_receipts_no_update
      BEFORE UPDATE ON studio_video_package_verify_receipts BEGIN SELECT RAISE(ABORT, 'video package receipts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_video_package_receipts_no_delete
      BEFORE DELETE ON studio_video_package_verify_receipts BEGIN SELECT RAISE(ABORT, 'video package receipts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_video_package_aliases_no_update
      BEFORE UPDATE ON studio_video_package_operation_aliases BEGIN SELECT RAISE(ABORT, 'video package aliases are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_video_package_aliases_no_delete
      BEFORE DELETE ON studio_video_package_operation_aliases BEGIN SELECT RAISE(ABORT, 'video package aliases are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_video_package_publication_intents_no_update
      BEFORE UPDATE ON studio_video_package_publication_intents BEGIN SELECT RAISE(ABORT, 'video package publication intents are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_video_package_publication_intents_no_delete
      BEFORE DELETE ON studio_video_package_publication_intents BEGIN SELECT RAISE(ABORT, 'video package publication intents are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_video_package_publication_receipts_no_update
      BEFORE UPDATE ON studio_video_package_publication_receipts BEGIN SELECT RAISE(ABORT, 'video package publication receipts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_video_package_publication_receipts_no_delete
      BEFORE DELETE ON studio_video_package_publication_receipts BEGIN SELECT RAISE(ABORT, 'video package publication receipts are append-only'); END;
    `);
    db.prepare("INSERT INTO studio_generation_ledger_meta(key, value) VALUES(?, ?)")
      .run(VIDEO_PACKAGE_SCHEMA_MARKER, String(VIDEO_PACKAGE_SCHEMA_VERSION));
    assertSchema(db);
  });
}

function assertSchema(db: DatabaseSync): void {
  const marker = db.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key = ?")
    .get(VIDEO_PACKAGE_SCHEMA_MARKER) as { value?: string } | undefined;
  const schemaVersion = Number(marker?.value);
  if (schemaVersion !== VIDEO_PACKAGE_SCHEMA_VERSION
    && schemaVersion !== PREVIOUS_VIDEO_PACKAGE_SCHEMA_VERSION
    && schemaVersion !== LEGACY_VIDEO_PACKAGE_SCHEMA_VERSION) {
    fail("storage-invalid", "视频包账本 schema marker 缺失或无效。");
  }
  const v4IntentColumns = [
    "intent_schema_version", "managed_source_fingerprint",
    "managed_source_unit_snapshot_fingerprint", "observation_control_fingerprint",
    "observation_control_status", "observation_head_revision", "observation_id",
    "observation_head_fingerprint", "observation_evidence_contract_version",
    "observation_evidence_kind", "observation_evidence_sha256",
    "observation_evidence_lineage_fingerprint",
  ];
  const v5IntentColumns = [
    "intent_contract_version", "source_closure_fingerprint",
  ];
  const columns: Record<string, string[]> = {
    studio_video_package_export_intents: [
      "sequence", "intent_id", "operation_id", "input_fingerprint", "project_id",
      "authority_kind", "authority_id", "authority_fingerprint", "pack_id", "pack_fingerprint",
      "target_kind", "target_key", "unit_id", "unit_revision", "generation_run_id",
      "raw_result_id", "raw_sha256", "labeled_result_id", "labeled_sha256",
      "dudu_import_receipt_fingerprint", "dudu_registration_fingerprint", "source_manifest_fingerprint",
      "production_scope_fingerprint", "contract_sha256", "production_root", "builder_relative_path",
      "builder_sha256", "source_spec_relative_path", "source_spec_sha256", "output_root_relative_path",
      "package_relative_path", "supersedes_intent_id", "created_at", "fingerprint",
      ...(schemaVersion >= PREVIOUS_VIDEO_PACKAGE_SCHEMA_VERSION ? v4IntentColumns : []),
      ...(schemaVersion === VIDEO_PACKAGE_SCHEMA_VERSION ? v5IntentColumns : []),
    ],
    studio_video_package_verify_receipts: [
      "sequence", "receipt_id", "intent_id", "storage_kind", "storage_relative_path", "manifest_relative_path", "manifest_sha256",
      "manifest_fingerprint", "files_json", "spec_schema_version", "package_status", "i2v_readiness",
      "mechanical_status", "i2v_static_status", "dynamic_model_status", "verified_at", "fingerprint",
    ],
    studio_video_package_operation_aliases: [
      "sequence", "operation_id", "input_fingerprint", "intent_id", "created_at", "fingerprint",
    ],
    studio_video_package_publication_intents: [
      "sequence", "publication_id", "operation_id", "successor_intent_id", "successor_receipt_id",
      "prior_external_intent_id", "prior_external_receipt_id", "production_root", "package_relative_path",
      "archive_relative_path", "created_at", "fingerprint",
    ],
    studio_video_package_publication_receipts: [
      "sequence", "publication_receipt_id", "publication_id", "archived_manifest_sha256",
      "archived_manifest_fingerprint", "published_manifest_sha256", "published_manifest_fingerprint",
      "completed_at", "fingerprint",
    ],
  };
  const requiredTableSqlFragments: Record<string, string[]> = {
    studio_video_package_export_intents: [
      "operation_id text not null unique",
      "input_fingerprint text not null unique check(length(input_fingerprint) = 64)",
      "raw_sha256 text not null check(length(raw_sha256) = 64)",
      "labeled_sha256 text not null check(length(labeled_sha256) = 64)",
      "target_kind text not null check(target_kind = 'unit-grid')",
      "supersedes_intent_id text unique",
      "unique(intent_id, input_fingerprint)",
      "foreign key(pack_id, pack_fingerprint) references studio_generation_packs(pack_id, fingerprint) on delete restrict",
      "foreign key(supersedes_intent_id) references studio_video_package_export_intents(intent_id) on delete restrict",
      ...(schemaVersion >= PREVIOUS_VIDEO_PACKAGE_SCHEMA_VERSION
        ? [
            "intent_schema_version integer not null default 3 check(intent_schema_version in (3, 4))",
            "managed_source_fingerprint text check(managed_source_fingerprint is null or length(managed_source_fingerprint) = 64)",
            "managed_source_unit_snapshot_fingerprint text check( managed_source_unit_snapshot_fingerprint is null or length(managed_source_unit_snapshot_fingerprint) = 64 )",
            "observation_control_fingerprint text check(observation_control_fingerprint is null or length(observation_control_fingerprint) = 64)",
            "observation_control_status text check(observation_control_status is null or observation_control_status in ('missing', 'current', 'stale'))",
            "observation_head_revision integer check(observation_head_revision is null or observation_head_revision >= 0)",
            "observation_head_fingerprint text check(observation_head_fingerprint is null or length(observation_head_fingerprint) = 64)",
            "observation_evidence_contract_version integer check( observation_evidence_contract_version is null or observation_evidence_contract_version >= 1 )",
            "observation_evidence_sha256 text check(observation_evidence_sha256 is null or length(observation_evidence_sha256) = 64)",
            "observation_evidence_lineage_fingerprint text check( observation_evidence_lineage_fingerprint is null or length(observation_evidence_lineage_fingerprint) = 64 )",
          ]
        : []),
      ...(schemaVersion === VIDEO_PACKAGE_SCHEMA_VERSION
        ? [
            "intent_contract_version integer check(intent_contract_version is null or intent_contract_version = 5)",
            "source_closure_fingerprint text check( (intent_contract_version is null and source_closure_fingerprint is null) or ( intent_contract_version = 5 and intent_schema_version = 4 and source_closure_fingerprint is not null and length(source_closure_fingerprint) = 64 ) )",
          ]
        : []),
    ],
    studio_video_package_verify_receipts: [
      "intent_id text not null unique",
      "storage_kind text not null check(storage_kind in ('managed-evidence', 'external-production'))",
      "mechanical_status text not null check(mechanical_status = 'verified')",
      "i2v_static_status text not null check(i2v_static_status in ( 'legacy-audit-required', 'needs-independent-frame-or-review', 'ready' ))",
      "dynamic_model_status text not null check(dynamic_model_status = 'not-run')",
      "foreign key(intent_id) references studio_video_package_export_intents(intent_id) on delete restrict",
    ],
    studio_video_package_operation_aliases: [
      "operation_id text not null unique",
      "input_fingerprint text not null check(length(input_fingerprint) = 64)",
      "foreign key(intent_id, input_fingerprint) references studio_video_package_export_intents(intent_id, input_fingerprint) on delete restrict",
    ],
    studio_video_package_publication_intents: [
      "successor_intent_id text not null unique",
      "successor_receipt_id text not null unique",
      "prior_external_receipt_id text not null unique",
      "archive_relative_path text not null unique",
      "foreign key(successor_intent_id) references studio_video_package_export_intents(intent_id) on delete restrict",
      "foreign key(successor_receipt_id) references studio_video_package_verify_receipts(receipt_id) on delete restrict",
      "foreign key(prior_external_intent_id) references studio_video_package_export_intents(intent_id) on delete restrict",
      "foreign key(prior_external_receipt_id) references studio_video_package_verify_receipts(receipt_id) on delete restrict",
    ],
    studio_video_package_publication_receipts: [
      "publication_id text not null unique",
      "archived_manifest_sha256 text not null check(length(archived_manifest_sha256) = 64)",
      "published_manifest_sha256 text not null check(length(published_manifest_sha256) = 64)",
      "foreign key(publication_id) references studio_video_package_publication_intents(publication_id) on delete restrict",
    ],
  };
  for (const [table, expected] of Object.entries(columns)) {
    const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
    const sql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql?: string } | undefined)?.sql ?? "")
      .toLowerCase().replace(/\s+/gu, " ").trim();
    const compactSql = sql.replace(/\s+/gu, "");
    const missingFragments = requiredTableSqlFragments[table]!.filter(
      (fragment) => !compactSql.includes(fragment.replace(/\s+/gu, "")),
    );
    if (JSON.stringify(actual) !== JSON.stringify(expected) || !sql.endsWith(") strict")
      || missingFragments.length > 0) {
      fail("storage-invalid", `视频包账本 ${table} 结构不是精确 STRICT v${schemaVersion}。`, [
        ...(JSON.stringify(actual) === JSON.stringify(expected)
          ? []
          : [`expectedColumns=${expected.join(",")}`, `actualColumns=${actual.join(",")}`]),
        ...(!sql.endsWith(") strict") ? ["strictSuffix=missing"] : []),
        ...missingFragments.map((fragment) => `missingSqlFragment=${fragment}`),
      ]);
    }
  }
  const triggerContracts = [
    ["studio_video_package_intents_no_update", "studio_video_package_export_intents", "before update"],
    ["studio_video_package_intents_no_delete", "studio_video_package_export_intents", "before delete"],
    ["studio_video_package_receipts_no_update", "studio_video_package_verify_receipts", "before update"],
    ["studio_video_package_receipts_no_delete", "studio_video_package_verify_receipts", "before delete"],
    ["studio_video_package_aliases_no_update", "studio_video_package_operation_aliases", "before update"],
    ["studio_video_package_aliases_no_delete", "studio_video_package_operation_aliases", "before delete"],
    ["studio_video_package_publication_intents_no_update", "studio_video_package_publication_intents", "before update"],
    ["studio_video_package_publication_intents_no_delete", "studio_video_package_publication_intents", "before delete"],
    ["studio_video_package_publication_receipts_no_update", "studio_video_package_publication_receipts", "before update"],
    ["studio_video_package_publication_receipts_no_delete", "studio_video_package_publication_receipts", "before delete"],
  ] as const;
  for (const [name, table, event] of triggerContracts) {
    const sql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=? AND tbl_name=?")
      .get(name, table) as { sql?: string } | undefined)?.sql ?? "").toLowerCase().replace(/\s+/gu, " ").trim();
    const exact = new RegExp(`^create trigger(?: if not exists)? ${name} ${event} on ${table} begin select raise\\(abort, '[^']+'\\); end$`, "u");
    if (!exact.test(sql)) fail("storage-invalid", `视频包账本 trigger ${name} 无效。`);
  }
  const destinationIndexSql = String((db.prepare(`SELECT sql FROM sqlite_master
    WHERE type='index' AND name='studio_video_package_intents_destination'`).get() as { sql?: string } | undefined)?.sql ?? "")
    .toLowerCase().replace(/\s+/gu, " ").trim();
  if (!/^create index(?: if not exists)? studio_video_package_intents_destination on studio_video_package_export_intents\(production_root, package_relative_path, sequence\)$/u
    .test(destinationIndexSql)) {
    fail("storage-invalid", "视频包账本 destination index 无效。 ");
  }
  const uniqueDestinationIndexes = (db.prepare("PRAGMA index_list(studio_video_package_export_intents)").all() as Array<{
    name: string; unique: number;
  }>).filter((row) => Number(row.unique) === 1).filter((row) => {
    const names = (db.prepare(`PRAGMA index_info(${JSON.stringify(row.name)})`).all() as Array<{ name: string }>)
      .map((item) => item.name);
    return names.includes("production_root") && names.includes("package_relative_path");
  });
  if (uniqueDestinationIndexes.length > 0) {
    fail("storage-invalid", "视频包账本仍含会阻断托管证据换代的 destination UNIQUE。 ");
  }
  const receiptFk = db.prepare("PRAGMA foreign_key_list(studio_video_package_verify_receipts)").all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  const intentFk = db.prepare("PRAGMA foreign_key_list(studio_video_package_export_intents)").all() as Array<{
    id: number; seq: number; table: string; from: string; to: string; on_delete: string;
  }>;
  const intentFkPairs = intentFk
    .sort((left, right) => left.id - right.id || left.seq - right.seq)
    .map((row) => `${row.table}:${row.from}->${row.to}`);
  if (receiptFk.length !== 1 || receiptFk[0]!.table !== "studio_video_package_export_intents"
    || receiptFk[0]!.from !== "intent_id" || receiptFk[0]!.to !== "intent_id" || receiptFk[0]!.on_delete !== "RESTRICT"
    || intentFk.length !== 3
    || !intentFk.every((row) => row.on_delete === "RESTRICT")
    || JSON.stringify(intentFkPairs) !== JSON.stringify([
      "studio_video_package_export_intents:supersedes_intent_id->intent_id",
      "studio_generation_packs:pack_id->pack_id",
      "studio_generation_packs:pack_fingerprint->fingerprint",
    ])) {
    fail("storage-invalid", "视频包账本 foreign key 合同无效。 ");
  }
  const exactFkRows = (table: string, expected: string[]) => {
    const actual = (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      table: string; from: string; to: string; on_delete: string;
    }>).map((row) => `${row.table}:${row.from}->${row.to}:${row.on_delete}`).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
      fail("storage-invalid", `视频包账本 ${table} foreign key 合同无效。`);
    }
  };
  exactFkRows("studio_video_package_operation_aliases", [
    "studio_video_package_export_intents:intent_id->intent_id:RESTRICT",
    "studio_video_package_export_intents:input_fingerprint->input_fingerprint:RESTRICT",
  ]);
  exactFkRows("studio_video_package_publication_intents", [
    "studio_video_package_export_intents:successor_intent_id->intent_id:RESTRICT",
    "studio_video_package_verify_receipts:successor_receipt_id->receipt_id:RESTRICT",
    "studio_video_package_export_intents:prior_external_intent_id->intent_id:RESTRICT",
    "studio_video_package_verify_receipts:prior_external_receipt_id->receipt_id:RESTRICT",
  ]);
  exactFkRows("studio_video_package_publication_receipts", [
    "studio_video_package_publication_intents:publication_id->publication_id:RESTRICT",
  ]);
  if ((db.prepare("PRAGMA foreign_key_check").all()).length > 0) fail("storage-invalid", "视频包账本存在外键孤儿。");
}

function runTransaction<T>(db: DatabaseSync, callback: () => T): T {
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

function intentSemantic(row: IntentRow): Omit<StudioVideoPackageExportIntent, "sequence" | "fingerprint"> {
  const storedSchemaVersion = Number(row.intent_schema_version ?? LEGACY_VIDEO_PACKAGE_SCHEMA_VERSION);
  if (storedSchemaVersion !== LEGACY_VIDEO_PACKAGE_SCHEMA_VERSION
    && storedSchemaVersion !== PREVIOUS_VIDEO_PACKAGE_SCHEMA_VERSION) {
    fail("storage-invalid", `视频包 intent ${row.intent_id} schemaVersion 无效。`);
  }
  const contractVersion = row.intent_contract_version === null
    || row.intent_contract_version === undefined
    ? null
    : Number(row.intent_contract_version);
  if (contractVersion !== null
    && (contractVersion !== VIDEO_PACKAGE_SCHEMA_VERSION
      || storedSchemaVersion !== PREVIOUS_VIDEO_PACKAGE_SCHEMA_VERSION)) {
    fail("storage-invalid", `视频包 intent ${row.intent_id} shadow contract version 无效。`);
  }
  const schemaVersion = contractVersion ?? storedSchemaVersion;
  const base = {
    schemaVersion,
    kind: "studio-video-package-export-intent" as const,
    intentId: row.intent_id,
    operationId: row.operation_id,
    inputFingerprint: row.input_fingerprint,
    projectId: row.project_id,
    authorityKind: row.authority_kind,
    authorityId: row.authority_id,
    authorityFingerprint: row.authority_fingerprint,
    packId: row.pack_id,
    packFingerprint: row.pack_fingerprint,
    targetKind: row.target_kind,
    targetKey: row.target_key,
    unitId: row.unit_id,
    unitRevision: Number(row.unit_revision),
    generationRunId: row.generation_run_id,
    rawResultId: row.raw_result_id,
    rawSha256: row.raw_sha256,
    labeledResultId: row.labeled_result_id,
    labeledSha256: row.labeled_sha256,
    duduImportReceiptFingerprint: row.dudu_import_receipt_fingerprint,
    duduRegistrationFingerprint: row.dudu_registration_fingerprint,
    sourceManifestFingerprint: row.source_manifest_fingerprint,
    productionScopeFingerprint: row.production_scope_fingerprint,
    contractSha256: row.contract_sha256,
    productionRoot: row.production_root,
    builderRelativePath: row.builder_relative_path,
    builderSha256: row.builder_sha256,
    sourceSpecRelativePath: row.source_spec_relative_path,
    sourceSpecSha256: row.source_spec_sha256,
    outputRootRelativePath: row.output_root_relative_path,
    packageRelativePath: row.package_relative_path,
    supersedesIntentId: row.supersedes_intent_id,
    createdAt: row.created_at,
  };
  if (schemaVersion === LEGACY_VIDEO_PACKAGE_SCHEMA_VERSION) return base;
  const managedSource = row.managed_source_fingerprint
      ? {
        managedSourceFingerprint: row.managed_source_fingerprint,
        managedSourceUnitSnapshotFingerprint:
          row.managed_source_unit_snapshot_fingerprint ?? undefined,
        observationControlFingerprint: row.observation_control_fingerprint ?? undefined,
        observationControlStatus: row.observation_control_status ?? undefined,
        observationHeadRevision: row.observation_head_revision === null
          || row.observation_head_revision === undefined
          ? undefined
          : Number(row.observation_head_revision),
        observationId: row.observation_id ?? null,
        observationHeadFingerprint: row.observation_head_fingerprint ?? null,
        observationEvidenceContractVersion: row.observation_evidence_contract_version === null
          || row.observation_evidence_contract_version === undefined
          ? null
          : Number(row.observation_evidence_contract_version),
        observationEvidenceKind: row.observation_evidence_kind ?? null,
        observationEvidenceSha256: row.observation_evidence_sha256 ?? null,
        observationEvidenceLineageFingerprint: row.observation_evidence_lineage_fingerprint ?? null,
      }
    : {};
  const sourceClosure = schemaVersion === VIDEO_PACKAGE_SCHEMA_VERSION
    ? { sourceClosureFingerprint: row.source_closure_fingerprint ?? undefined }
    : {};
  return { ...base, ...managedSource, ...sourceClosure };
}

function intentFromRow(row: IntentRow): StudioVideoPackageExportIntent {
  const semantic = intentSemantic(row);
  // v3 的内容地址在 schemaVersion 字段进入持久化合同之前已经冻结。
  // 迁移只给旧行补 DEFAULT 3 列，绝不能把这个新列反向加入旧 intent 的
  // id/fingerprint 重算；v4 则必须把 schemaVersion 与 managed-source 字段
  // 一并纳入内容地址。
  const addressSemantic = semantic.schemaVersion === LEGACY_VIDEO_PACKAGE_SCHEMA_VERSION
    ? (({ schemaVersion: _legacySchemaVersion, ...legacy }) => legacy)(semantic)
    : semantic;
  const { intentId: _intentId, ...identityInput } = addressSemantic;
  const identity = `studio-video-package-intent-${digest(identityInput).slice(0, 40)}`;
  const fingerprint = digest(addressSemantic);
  if (identity !== row.intent_id || fingerprint !== row.fingerprint
    || !Number.isSafeInteger(Number(row.sequence)) || Number(row.sequence) < 1
    || !SHA256_PATTERN.test(row.input_fingerprint)) {
    fail("storage-invalid", `视频包 intent ${row.intent_id} 内容地址无效。`);
  }
  if (semantic.schemaVersion === PREVIOUS_VIDEO_PACKAGE_SCHEMA_VERSION
    || semantic.schemaVersion === VIDEO_PACKAGE_SCHEMA_VERSION) {
    if (semantic.authorityKind === "studio-review") {
      if (!semantic.managedSourceFingerprint
        || !semantic.managedSourceUnitSnapshotFingerprint
        || !semantic.observationControlFingerprint
        || !semantic.observationControlStatus
        || semantic.observationHeadRevision === undefined
        || !Number.isSafeInteger(semantic.observationHeadRevision)
        || semantic.observationHeadRevision < 0
        || !SHA256_PATTERN.test(semantic.managedSourceFingerprint)
        || !SHA256_PATTERN.test(semantic.managedSourceUnitSnapshotFingerprint)
        || !SHA256_PATTERN.test(semantic.observationControlFingerprint)
        || (semantic.observationHeadFingerprint !== null
          && semantic.observationHeadFingerprint !== undefined
          && !SHA256_PATTERN.test(semantic.observationHeadFingerprint))
        || (semantic.observationEvidenceSha256 !== null
          && semantic.observationEvidenceSha256 !== undefined
          && !SHA256_PATTERN.test(semantic.observationEvidenceSha256))
        || (semantic.observationEvidenceLineageFingerprint !== null
          && semantic.observationEvidenceLineageFingerprint !== undefined
          && !SHA256_PATTERN.test(semantic.observationEvidenceLineageFingerprint))) {
        fail("storage-invalid", `视频包 v${semantic.schemaVersion} intent ${row.intent_id} 缺少 managed source 身份。`);
      }
      const headPresent = semantic.observationId !== null
        && semantic.observationId !== undefined
        && semantic.observationHeadFingerprint !== null
        && semantic.observationHeadFingerprint !== undefined;
      if ((semantic.observationHeadRevision === 0 && headPresent)
        || (semantic.observationHeadRevision > 0 && !headPresent)) {
        fail("storage-invalid", `视频包 v${semantic.schemaVersion} intent ${row.intent_id} 的 Observation Head 身份不闭合。`);
      }
    } else if (semantic.managedSourceFingerprint !== undefined
      || semantic.observationControlFingerprint !== undefined) {
      fail("storage-invalid", `历史导入 intent ${row.intent_id} 不得伪造 managed source。`);
    }
  }
  if (semantic.schemaVersion === VIDEO_PACKAGE_SCHEMA_VERSION) {
    if (!semantic.sourceClosureFingerprint
      || !SHA256_PATTERN.test(semantic.sourceClosureFingerprint)) {
      fail("storage-invalid", `视频包 v5 intent ${row.intent_id} 缺少 source closure。`);
    }
  } else if (semantic.sourceClosureFingerprint !== undefined
    || row.intent_contract_version !== null && row.intent_contract_version !== undefined
    || row.source_closure_fingerprint !== null && row.source_closure_fingerprint !== undefined) {
    fail("storage-invalid", `视频包旧 intent ${row.intent_id} 不得伪造 source closure。`);
  }
  return { ...semantic, sequence: Number(row.sequence), fingerprint };
}

function receiptFromRow(row: ReceiptRow): StudioVideoPackageVerifyReceipt {
  let files: unknown;
  try {
    files = JSON.parse(row.files_json);
  } catch (error) {
    throw new StudioVideoPackageError("storage-invalid", `视频包 receipt ${row.receipt_id} files JSON 无效。`, [], { cause: error });
  }
  if (!Array.isArray(files) || files.some((item) => !item || typeof item !== "object"
    || typeof (item as Record<string, unknown>).path !== "string"
    || path.basename((item as Record<string, unknown>).path as string) !== (item as Record<string, unknown>).path
    || typeof (item as Record<string, unknown>).sha256 !== "string"
    || !SHA256_PATTERN.test((item as Record<string, unknown>).sha256 as string))
    || new Set(files.map((item) => (item as Record<string, unknown>).path)).size !== files.length) {
    fail("storage-invalid", `视频包 receipt ${row.receipt_id} files 无效。`);
  }
  const storageRelativePath = typeof row.storage_relative_path === "string"
    ? row.storage_relative_path.normalize("NFC").trim()
    : "";
  if (!Number.isSafeInteger(Number(row.sequence)) || Number(row.sequence) < 1
    || (row.storage_kind !== "managed-evidence" && row.storage_kind !== "external-production")
    || !storageRelativePath || storageRelativePath.includes("\\") || path.posix.isAbsolute(storageRelativePath)
    || path.posix.normalize(storageRelativePath) !== storageRelativePath
    || storageRelativePath === ".." || storageRelativePath.startsWith("../")
    || row.manifest_relative_path !== `${storageRelativePath}/manifest.json`
    || !SHA256_PATTERN.test(row.manifest_sha256) || !SHA256_PATTERN.test(row.manifest_fingerprint)
    || !SHA256_PATTERN.test(row.fingerprint)
    || (row.spec_schema_version !== "1.0" && row.spec_schema_version !== "2.0")
    || row.mechanical_status !== "verified" || row.dynamic_model_status !== "not-run"
    || !["legacy-audit-required", "needs-independent-frame-or-review", "ready"].includes(row.i2v_static_status)
    || !Number.isFinite(Date.parse(row.verified_at))) {
    fail("storage-invalid", `视频包 receipt ${row.receipt_id} 标量身份无效。`);
  }
  const semantic = {
    schemaVersion: 3 as const,
    kind: "studio-video-package-verify-receipt" as const,
    receiptId: row.receipt_id,
    intentId: row.intent_id,
    storageKind: row.storage_kind,
    storageRelativePath,
    manifestRelativePath: row.manifest_relative_path,
    manifestSha256: row.manifest_sha256,
    manifestFingerprint: row.manifest_fingerprint,
    files: files as StudioVideoPackageManifestFile[],
    specSchemaVersion: row.spec_schema_version,
    packageStatus: row.package_status,
    i2vReadiness: row.i2v_readiness,
    mechanicalStatus: row.mechanical_status,
    i2vStaticStatus: row.i2v_static_status,
    dynamicModelStatus: row.dynamic_model_status,
    verifiedAt: row.verified_at,
  };
  const { receiptId: _receiptId, ...identityInput } = semantic;
  const identity = `studio-video-package-receipt-${digest(identityInput).slice(0, 40)}`;
  const fingerprint = digest(semantic);
  if (identity !== row.receipt_id || fingerprint !== row.fingerprint) {
    fail("storage-invalid", `视频包 receipt ${row.receipt_id} 内容地址无效。`);
  }
  return { ...semantic, sequence: Number(row.sequence), fingerprint };
}

function operationAliasFromRow(row: OperationAliasRow): OperationAliasRow {
  const semantic = {
    operationId: row.operation_id,
    inputFingerprint: row.input_fingerprint,
    intentId: row.intent_id,
    createdAt: row.created_at,
  };
  if (!Number.isSafeInteger(Number(row.sequence)) || Number(row.sequence) < 1
    || !ID_PATTERN.test(row.operation_id) || !SHA256_PATTERN.test(row.input_fingerprint)
    || !ID_PATTERN.test(row.intent_id) || !Number.isFinite(Date.parse(row.created_at))
    || digest(semantic) !== row.fingerprint) {
    fail("storage-invalid", `视频包 operation alias ${row.operation_id} 身份无效。`);
  }
  return row;
}

function publicationIntentFromRow(row: PublicationIntentRow): StudioVideoPackagePublicationIntent {
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-video-package-publication-intent" as const,
    publicationId: row.publication_id,
    operationId: row.operation_id,
    successorIntentId: row.successor_intent_id,
    successorReceiptId: row.successor_receipt_id,
    priorExternalIntentId: row.prior_external_intent_id,
    priorExternalReceiptId: row.prior_external_receipt_id,
    productionRoot: row.production_root,
    packageRelativePath: row.package_relative_path,
    archiveRelativePath: row.archive_relative_path,
    createdAt: row.created_at,
  };
  const { publicationId: _publicationId, ...identityInput } = semantic;
  const publicationId = `studio-video-publication-${digest(identityInput).slice(0, 40)}`;
  const fingerprint = digest(semantic);
  if (!Number.isSafeInteger(Number(row.sequence)) || Number(row.sequence) < 1
    || publicationId !== row.publication_id || fingerprint !== row.fingerprint
    || !ID_PATTERN.test(row.operation_id) || !ID_PATTERN.test(row.successor_intent_id)
    || !ID_PATTERN.test(row.successor_receipt_id) || !ID_PATTERN.test(row.prior_external_intent_id)
    || !ID_PATTERN.test(row.prior_external_receipt_id) || !path.isAbsolute(row.production_root)
    || normalizeRelative(row.package_relative_path, "publication.packageRelativePath") !== row.package_relative_path
    || normalizeRelative(row.archive_relative_path, "publication.archiveRelativePath") !== row.archive_relative_path
    || !Number.isFinite(Date.parse(row.created_at))) {
    fail("storage-invalid", `视频包 publication intent ${row.publication_id} 身份无效。`);
  }
  return { ...semantic, sequence: Number(row.sequence), fingerprint };
}

function publicationReceiptFromRow(row: PublicationReceiptRow): StudioVideoPackagePublicationReceipt {
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-video-package-publication-receipt" as const,
    publicationReceiptId: row.publication_receipt_id,
    publicationId: row.publication_id,
    archivedManifestSha256: row.archived_manifest_sha256,
    archivedManifestFingerprint: row.archived_manifest_fingerprint,
    publishedManifestSha256: row.published_manifest_sha256,
    publishedManifestFingerprint: row.published_manifest_fingerprint,
    completedAt: row.completed_at,
  };
  const { publicationReceiptId: _receiptId, ...identityInput } = semantic;
  const receiptId = `studio-video-publication-receipt-${digest(identityInput).slice(0, 40)}`;
  const fingerprint = digest(semantic);
  if (!Number.isSafeInteger(Number(row.sequence)) || Number(row.sequence) < 1
    || receiptId !== row.publication_receipt_id || fingerprint !== row.fingerprint
    || !ID_PATTERN.test(row.publication_id)
    || !SHA256_PATTERN.test(row.archived_manifest_sha256)
    || !SHA256_PATTERN.test(row.archived_manifest_fingerprint)
    || !SHA256_PATTERN.test(row.published_manifest_sha256)
    || !SHA256_PATTERN.test(row.published_manifest_fingerprint)
    || !Number.isFinite(Date.parse(row.completed_at))) {
    fail("storage-invalid", `视频包 publication receipt ${row.publication_receipt_id} 身份无效。`);
  }
  return { ...semantic, sequence: Number(row.sequence), fingerprint };
}

function intentRowById(db: DatabaseSync, intentId: string): IntentRow | undefined {
  return db.prepare("SELECT * FROM studio_video_package_export_intents WHERE intent_id=?")
    .get(intentId) as unknown as IntentRow | undefined;
}

function videoPackageSchemaPresentReadOnly(db: DatabaseSync): boolean {
  const marker = db.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key=?")
    .get(VIDEO_PACKAGE_SCHEMA_MARKER) as { value?: string } | undefined;
  const residualObjects = db.prepare(`SELECT type, name FROM sqlite_master
    WHERE (type='table' OR type='trigger') AND name LIKE 'studio_video_package_%'
    ORDER BY type, name`).all() as Array<{ type: string; name: string }>;
  if (!marker) {
    if (residualObjects.length > 0) {
      fail("storage-invalid", "视频包 schema marker 缺失但已存在业务对象，拒绝只读猜测。", [
        ...residualObjects.map((item) => `${item.type}:${item.name}`),
      ]);
    }
    return false;
  }
  if (marker.value !== String(VIDEO_PACKAGE_SCHEMA_VERSION)
    && marker.value !== String(PREVIOUS_VIDEO_PACKAGE_SCHEMA_VERSION)
    && marker.value !== String(LEGACY_VIDEO_PACKAGE_SCHEMA_VERSION)) {
    fail("storage-invalid", `不支持的视频包账本 schema：${marker.value}`);
  }
  assertSchema(db);
  return true;
}

type StudioVideoPackageAuthorityLatestResolution =
  | { status: "not-prepared"; intentId: null; isDestinationHead: null; blockers: [] }
  | { status: "resolved"; intentId: string; isDestinationHead: boolean; blockers: [] }
  | {
      status: "conflict";
      intentId: null;
      isDestinationHead: null;
      blockers: StudioVideoPackageControlLookup["blockers"];
    };

async function resolveStudioVideoPackageAuthorityLatestReadOnly(
  projectRoot: string,
  authorityValue: StudioVideoPackageAuthorityInput,
): Promise<StudioVideoPackageAuthorityLatestResolution> {
  const authority: StudioVideoPackageAuthorityInput = authorityValue.kind === "historical-import"
    ? { kind: "historical-import", packId: normalizeId(authorityValue.packId, "packId") }
    : { kind: "studio-review", reviewId: normalizeId(authorityValue.reviewId, "reviewId") };
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const databasePath = await generationDatabasePathReadOnly(shell.paths.root);
  const snapshot = await openSqliteReadOnlySnapshot(databasePath, "video package authority lookup");
  try {
    const db = snapshot.database;
    if (!videoPackageSchemaPresentReadOnly(db)) {
      return { status: "not-prepared", intentId: null, isDestinationHead: null, blockers: [] };
    }
    const rows = (authority.kind === "historical-import"
      ? db.prepare(`SELECT * FROM studio_video_package_export_intents
          WHERE authority_kind='historical-import' AND pack_id=? ORDER BY sequence ASC`).all(authority.packId)
      : db.prepare(`SELECT * FROM studio_video_package_export_intents
          WHERE authority_kind='studio-review' AND authority_id=? ORDER BY sequence ASC`).all(authority.reviewId)) as unknown as IntentRow[];
    if (rows.length === 0) {
      return { status: "not-prepared", intentId: null, isDestinationHead: null, blockers: [] };
    }
    const intents = rows.map(intentFromRow);
    if (intents.some((intent) => intent.projectId !== shell.project.id
      || (authority.kind === "historical-import"
        ? intent.authorityKind !== "historical-import" || intent.packId !== authority.packId
        : intent.authorityKind !== "studio-review" || intent.authorityId !== authority.reviewId))) {
      fail("storage-invalid", "视频包 authority 索引与 intent 身份不一致。");
    }
    const destinations = new Set(intents.map((intent) => `${intent.productionRoot}\0${intent.packageRelativePath}`));
    if (destinations.size !== 1) {
      return {
        status: "conflict",
        intentId: null,
        isDestinationHead: null,
        blockers: ["authority-destination-conflict"],
      };
    }
    const selected = intents.at(-1)!;
    const destinationRows = db.prepare(`SELECT * FROM studio_video_package_export_intents
      WHERE production_root=? AND package_relative_path=? ORDER BY sequence ASC`)
      .all(selected.productionRoot, selected.packageRelativePath) as unknown as IntentRow[];
    const destinationIntents = destinationRows.map(intentFromRow);
    let predecessor: string | null = null;
    for (const intent of destinationIntents) {
      if (intent.supersedesIntentId !== predecessor) {
        return {
          status: "conflict",
          intentId: null,
          isDestinationHead: null,
          blockers: ["authority-supersession-chain-conflict"],
        };
      }
      predecessor = intent.intentId;
    }
    const destinationIds = new Set(destinationIntents.map((intent) => intent.intentId));
    if (intents.some((intent) => !destinationIds.has(intent.intentId))) {
      return {
        status: "conflict",
        intentId: null,
        isDestinationHead: null,
        blockers: ["authority-supersession-chain-conflict"],
      };
    }
    return {
      status: "resolved",
      intentId: selected.intentId,
      isDestinationHead: destinationIntents.at(-1)?.intentId === selected.intentId,
      blockers: [],
    };
  } finally {
    await snapshot.close();
  }
}

function receiptRowByIntent(db: DatabaseSync, intentId: string): ReceiptRow | undefined {
  return db.prepare("SELECT * FROM studio_video_package_verify_receipts WHERE intent_id=?")
    .get(intentId) as unknown as ReceiptRow | undefined;
}

function publicationIntentRowById(db: DatabaseSync, publicationId: string): PublicationIntentRow | undefined {
  return db.prepare("SELECT * FROM studio_video_package_publication_intents WHERE publication_id=?")
    .get(publicationId) as unknown as PublicationIntentRow | undefined;
}

function publicationReceiptRowByPublication(db: DatabaseSync, publicationId: string): PublicationReceiptRow | undefined {
  return db.prepare("SELECT * FROM studio_video_package_publication_receipts WHERE publication_id=?")
    .get(publicationId) as unknown as PublicationReceiptRow | undefined;
}

function priorExternalDestinationReceipt(
  db: DatabaseSync,
  intent: StudioVideoPackageExportIntent,
): { intent: StudioVideoPackageExportIntent; receipt: StudioVideoPackageVerifyReceipt } | null {
  const owner = db.prepare(`
    SELECT prior.intent_id AS intent_id
    FROM studio_video_package_export_intents prior
    JOIN studio_video_package_verify_receipts receipt ON receipt.intent_id = prior.intent_id
    WHERE prior.production_root = ? AND prior.package_relative_path = ?
      AND prior.sequence < ?
      AND (
        receipt.storage_kind = 'external-production'
        OR EXISTS (
          SELECT 1 FROM studio_video_package_publication_intents publication
          JOIN studio_video_package_publication_receipts completed
            ON completed.publication_id = publication.publication_id
          WHERE publication.successor_intent_id = prior.intent_id
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM studio_video_package_publication_intents archived
        JOIN studio_video_package_publication_receipts archived_completed
          ON archived_completed.publication_id = archived.publication_id
        WHERE archived.prior_external_intent_id = prior.intent_id
      )
    ORDER BY prior.sequence DESC LIMIT 1
  `).get(intent.productionRoot, intent.packageRelativePath, intent.sequence) as { intent_id?: string } | undefined;
  if (!owner?.intent_id) return null;
  const intentRow = intentRowById(db, owner.intent_id);
  const receiptRow = receiptRowByIntent(db, owner.intent_id);
  if (!intentRow || !receiptRow) fail("storage-invalid", "视频包正式外部目标 owner 索引不闭合。 ");
  const priorIntent = intentFromRow(intentRow);
  const receipt = receiptFromRow(receiptRow);
  const directExternal = receipt.storageKind === "external-production"
    && receipt.storageRelativePath === priorIntent.packageRelativePath
    && receipt.manifestRelativePath === `${priorIntent.packageRelativePath}/manifest.json`;
  const published = db.prepare(`SELECT 1 AS found
    FROM studio_video_package_publication_intents publication
    JOIN studio_video_package_publication_receipts completed ON completed.publication_id=publication.publication_id
    WHERE publication.successor_intent_id=? AND publication.successor_receipt_id=? LIMIT 1`)
    .get(priorIntent.intentId, receipt.receiptId);
  if (!directExternal && !published) {
    fail("storage-invalid", `视频包正式外部 receipt ${receipt.receiptId} 身份无效。`);
  }
  return { intent: priorIntent, receipt };
}

function numeric(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("input-drift", `${field} 必须是有限数值。`);
  return value;
}

function timelineSeconds(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^\d{2}:\d{2}(?:\.\d+)?$/u.test(value)) {
    fail("input-drift", `${field} 必须是 MM:SS(.sss) 时码。`);
  }
  const [minutes, seconds] = value.split(":").map(Number);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds! >= 60) {
    fail("input-drift", `${field} 时码无效。`);
  }
  return minutes! * 60 + seconds!;
}

function equalSeconds(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-6;
}

/** 外部视频规格必须与 Studio unit-grid 冻结顺序和真实时码逐格闭合。 */
function assertSourceSpecMatchesPack(
  sourceSpec: Record<string, unknown>,
  pack: StudioUnitGridGenerationFreezePack,
  lockedScriptPath: string,
  sourceKind: ResolvedExternalInput["sourceKind"] = "dudu-readonly",
  managedSourceId?: string,
): void {
  if (sourceSpec.schema_version !== "1.0" && sourceSpec.schema_version !== "2.0") {
    fail("input-drift", "视频规格 schema_version 只支持 1.0/2.0。 ");
  }
  if (!equalSeconds(numeric(sourceSpec.unit_duration_sec, "视频规格 unit_duration_sec"), pack.target.durationSeconds)) {
    fail("input-drift", "视频规格总时长与 Studio unit-grid 不一致。 ");
  }
  const layout = sourceSpec.layout;
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
    fail("input-drift", "视频规格 layout 结构无效。 ");
  }
  const layoutRow = layout as Record<string, unknown>;
  const columns = numeric(layoutRow.columns, "视频规格 layout.columns");
  const rows = numeric(layoutRow.rows, "视频规格 layout.rows");
  if (!Number.isSafeInteger(columns) || columns < 1 || !Number.isSafeInteger(rows) || rows < 1
    || columns * rows !== pack.target.panelCount
    || typeof layoutRow.reading_order !== "string" || !layoutRow.reading_order.trim()) {
    fail("input-drift", "视频规格 layout 必须以合法行列完整覆盖 Studio 的 2–6 格顺序。 ");
  }
  const panels = sourceSpec.panels;
  const shots = sourceSpec.shots;
  if (!Array.isArray(panels) || !Array.isArray(shots)
    || panels.length !== pack.panels.length || shots.length !== pack.panels.length) {
    fail("input-drift", "视频规格 panels/shots 数量与 Studio unit-grid 不一致。 ");
  }
  for (const [offset, frozen] of pack.panels.entries()) {
    const expectedId = `G${offset + 1}`;
    const panel = panels[offset];
    const shot = shots[offset];
    if (!panel || typeof panel !== "object" || Array.isArray(panel)
      || !shot || typeof shot !== "object" || Array.isArray(shot)
      || (panel as Record<string, unknown>).id !== expectedId
      || (shot as Record<string, unknown>).id !== expectedId) {
      fail("input-drift", `视频规格第 ${offset + 1} 格身份或顺序与 Studio 不一致。`);
    }
    const rect = (panel as Record<string, unknown>).rect;
    if (!rect || typeof rect !== "object" || Array.isArray(rect)) {
      fail("input-drift", `视频规格第 ${offset + 1} 格 rect 无效。`);
    }
    const rectRow = rect as Record<string, unknown>;
    for (const field of ["x", "y", "width", "height"] as const) {
      const value = numeric(rectRow[field], `panels[${offset}].rect.${field}`);
      if (!Number.isSafeInteger(value) || value < 0 || ((field === "width" || field === "height") && value < 1)) {
        fail("input-drift", `视频规格第 ${offset + 1} 格 rect.${field} 无效。`);
      }
    }
    const shotRow = shot as Record<string, unknown>;
    const start = timelineSeconds(shotRow.timeline_start, `shots[${offset}].timeline_start`);
    const end = timelineSeconds(shotRow.timeline_end, `shots[${offset}].timeline_end`);
    const duration = numeric(shotRow.duration_sec, `shots[${offset}].duration_sec`);
    if (!equalSeconds(start, frozen.startSeconds)
      || !equalSeconds(end, frozen.endSeconds)
      || !equalSeconds(duration, frozen.durationSeconds)
      || !equalSeconds(end - start, duration)) {
      fail("input-drift", `视频规格第 ${offset + 1} 格时码与 Studio 冻结包不一致。`);
    }
  }
  const sourceScript = sourceSpec.source_script;
  if (typeof sourceScript === "string" && sourceScript.trim()) {
    if (sourceKind === "managed-project") {
      const expected = managedSourceId ? `managed-source:${managedSourceId}` : "";
      if (!expected || sourceScript.trim() !== expected) {
        fail("input-drift", "通用受管视频规格 source_script 未绑定 managed source 内容地址。 ");
      }
    } else {
      const frozenSources = new Set(pack.panels.map((panel) => panel.panelPack.scriptRevision.source));
      if (!frozenSources.has(sourceScript.trim()) || path.resolve(sourceScript.trim()) !== path.resolve(lockedScriptPath)) {
        fail("input-drift", "视频规格 source_script 不属于 Studio 冻结剧本来源。 ");
      }
    }
  } else if (sourceSpec.schema_version === "2.0") {
    fail("input-drift", "v2 视频规格必须绑定唯一锁版剧本 source_script。 ");
  }
}

async function resolveAuthority(projectRoot: string, input: StudioVideoPackageAuthorityInput): Promise<ResolvedAuthority> {
  const shell = await inspectManagedProject(projectRoot);
  if (!input || typeof input !== "object") fail("invalid-input", "authority 结构无效。");
  if (input.kind === "studio-review") {
    const reviewId = normalizeId(input.reviewId, "authority.reviewId");
    const review = await readStudioGenerationReview(shell.paths.root, reviewId);
    if (!review || !review.head || !review.current || !review.approvedRawEligible || review.decision !== "pass") {
      fail("authority-not-ready", `Studio Review ${reviewId} 不是当前可导出的 PASS head。`, review?.currentStaleReasons ?? []);
    }
    const [raw, labeled, pack, callIntent] = await Promise.all([
      readStudioGenerationResult(shell.paths.root, review.rawResultId),
      readStudioGenerationResult(shell.paths.root, review.labeledResultId),
      readStudioUnitGridGenerationFrozenPack(shell.paths.root, review.packId),
      readStudioImagegenCallIntentByRun(shell.paths.root, review.generationRunId),
    ]);
    if (!raw || !labeled || !pack || raw.variant !== "raw" || labeled.variant !== "labeled"
      || raw.targetKind !== "unit-grid" || labeled.targetKind !== "unit-grid"
      || raw.generationRunId !== review.generationRunId || labeled.generationRunId !== review.generationRunId
      || raw.packFingerprint !== review.packFingerprint || labeled.packFingerprint !== review.packFingerprint
      || raw.mediaSha256 !== review.rawSha256 || labeled.mediaSha256 !== review.labeledSha256
      || raw.provider !== labeled.provider
      || !raw.promotionEligible || !labeled.promotionEligible
      || !callIntent || callIntent.status !== "result-committed" || callIntent.provider !== raw.provider
      || callIntent.packId !== review.packId || callIntent.packFingerprint !== review.packFingerprint
      || callIntent.generationRunId !== review.generationRunId
      || callIntent.targetKind !== "unit-grid" || callIntent.targetKey !== raw.targetKey) {
      fail("authority-not-ready", `Studio Review ${reviewId} 的 unit-grid result 闭包无效。`);
    }
    await assertStudioUnitGridGenerationFreezePackCurrent(shell.paths.root, pack);
    return {
      pack,
      projectId: shell.project.id,
      authorityKind: "studio-review",
      authorityId: review.reviewId,
      authorityFingerprint: review.fingerprint,
      packId: review.packId,
      packFingerprint: review.packFingerprint,
      targetKey: raw.targetKey,
      unitId: raw.unitId,
      unitRevision: raw.unitRevision,
      provider: raw.provider,
      generationRunId: review.generationRunId,
      rawResultId: raw.resultId,
      rawSha256: raw.mediaSha256,
      labeledResultId: labeled.resultId,
      labeledSha256: labeled.mediaSha256,
    };
  }
  if (input.kind !== "historical-import") fail("invalid-input", "authority.kind 仅支持 studio-review 或 historical-import。");
  const packId = normalizeId(input.packId, "authority.packId");
  const [evidence, pack] = await Promise.all([
    readStudioHistoricalGenerationEvidenceByPack(shell.paths.root, packId),
    readStudioUnitGridGenerationFrozenPack(shell.paths.root, packId),
  ]);
  if (!evidence || !pack || evidence.review.decision !== "pass" || evidence.generationCallCount !== 0
    || evidence.targetKind !== "unit-grid" || evidence.packFingerprint !== pack.fingerprint) {
    fail("authority-not-ready", `历史导入 ${packId} 不是可验证的 unit-grid PASS 证据。`);
  }
  await assertStudioUnitGridGenerationFreezePackCurrent(shell.paths.root, pack);
  return {
    pack,
    projectId: shell.project.id,
    authorityKind: "historical-import",
    authorityId: evidence.importId,
    authorityFingerprint: evidence.fingerprint,
    packId: evidence.packId,
    packFingerprint: evidence.packFingerprint,
    targetKey: evidence.targetKey,
    unitId: evidence.unitId,
    unitRevision: evidence.unitRevision,
    provider: null,
    generationRunId: null,
    rawResultId: evidence.raw.resultId,
    rawSha256: evidence.raw.mediaSha256,
    labeledResultId: evidence.labeled.resultId,
    labeledSha256: evidence.labeled.mediaSha256,
  };
}

async function resolveExpectedManagedSource(
  projectRoot: string,
  authority: ResolvedAuthority,
  expected: StudioVideoPackageExpectedManagedSource | undefined,
): Promise<ManagedEvidenceVideoPackageSourceSpec | undefined> {
  if (authority.authorityKind === "historical-import") {
    if (expected !== undefined) {
      fail("invalid-input", "historical-import 不得携带 expectedManagedSource。");
    }
    return undefined;
  }
  if (!expected) fail("invalid-input", "studio-review 导出必须携带 expectedManagedSource。");
  if (expected.adapterKind !== "managed-evidence-v1"
    || expected.reviewId !== authority.authorityId
    || expected.expectedReviewFingerprint !== authority.authorityFingerprint
    || expected.expectedPackFingerprint !== authority.packFingerprint) {
    fail("input-drift", "expectedManagedSource 与 Review/pack authority 不一致。");
  }
  const source = await prepareStudioVideoPackageSource(projectRoot, {
    adapterKind: "managed-evidence-v1",
    reviewId: expected.reviewId,
    expectedReviewFingerprint: expected.expectedReviewFingerprint,
    expectedPackFingerprint: expected.expectedPackFingerprint,
    expectedUnitSnapshotFingerprint: expected.expectedUnitSnapshotFingerprint,
    expectedObservationControlFingerprint: expected.expectedObservationControlFingerprint,
    expectedObservationHeadRevision: expected.expectedObservationHeadRevision,
    expectedObservationStatus: expected.expectedObservationStatus,
    expectedObservationHeadId: expected.expectedObservationHeadId,
    expectedObservationHeadFingerprint: expected.expectedObservationHeadFingerprint,
    expectedObservationEvidenceSha256: expected.expectedObservationEvidenceSha256,
  });
  const observation = source.evidence.observationControl;
  if (source.fingerprint !== normalizeSha(expected.expectedSourceFingerprint, "expectedSourceFingerprint")
    || source.evidence.reviewId !== authority.authorityId
    || source.evidence.reviewFingerprint !== authority.authorityFingerprint
    || source.evidence.packId !== authority.packId
    || source.evidence.packFingerprint !== authority.packFingerprint
    || source.evidence.rawResultId !== authority.rawResultId
    || source.evidence.rawSha256 !== authority.rawSha256
    || source.evidence.labeledResultId !== authority.labeledResultId
    || source.evidence.labeledSha256 !== authority.labeledSha256
    || source.unit.unitId !== authority.unitId
    || source.unit.unitRevision !== authority.unitRevision
    || source.unit.unitSnapshotFingerprint !== expected.expectedUnitSnapshotFingerprint
    || observation.fingerprint !== expected.expectedObservationControlFingerprint
    || observation.status !== expected.expectedObservationStatus
    || observation.headRevision !== expected.expectedObservationHeadRevision
    || observation.headId !== expected.expectedObservationHeadId
    || observation.headFingerprint !== expected.expectedObservationHeadFingerprint
    || observation.evidenceSha256 !== expected.expectedObservationEvidenceSha256) {
    fail("input-drift", "managed-evidence source 与 export expected 身份不一致。");
  }
  return source;
}

function sourceIdentityFor(
  identity: DuduReadonlyActiveProjectIdentity,
  relativePath: string,
): DuduReadonlyActiveProjectIdentity["sourceFiles"][number] {
  const rows = identity.sourceFiles.filter((file) => file.scope === "production-root" && file.relativePath === relativePath);
  if (rows.length !== 1) fail("input-drift", `Dudu source manifest 未唯一冻结：${relativePath}`);
  return rows[0]!;
}

function assertSnapshotMatchesSourceIdentity(
  snapshot: StableFileSnapshot,
  identity: DuduReadonlyActiveProjectIdentity["sourceFiles"][number],
  label: string,
): void {
  if (snapshot.sha256 !== identity.sha256 || snapshot.sizeBytes !== identity.sizeBytes) {
    fail("input-drift", `${label} 与 Dudu source manifest 身份不一致。`);
  }
}

function productionFileRelative(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value.trim())) {
    fail("input-drift", `${field} 必须是 productionRoot 内的相对路径。`);
  }
  return normalizeRelative(value, field);
}

async function safeProjectionFilePath(root: string, relative: string, label: string): Promise<string> {
  const normalized = normalizeRelative(relative, label);
  const target = path.join(root, ...normalized.split("/"));
  if (!pathInside(target, root)) fail("invalid-input", `${label} 逃逸生产根。`);
  const parentRelative = path.posix.dirname(normalized);
  if (parentRelative !== ".") {
    await assertSafeRelativeChain(root, parentRelative, "directory-or-missing");
    const parent = path.dirname(target);
    const parentMetadata = await lstat(parent).catch(() => null);
    if (parentMetadata && (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()
      || await realpath(parent) !== parent)) {
      fail("invalid-input", `${label} 父目录不是安全真实目录。`);
    }
  }
  const metadata = await lstat(target).catch(() => null);
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(target) !== target)) {
    fail("input-drift", `${label} 已存在但不是安全普通文件。`);
  }
  return target;
}

function duduField(panel: DuduParsedPanel, key: string, fallback = "无"): string {
  const value = panel.fields[key]?.trim();
  return value && value !== "—" ? value : fallback;
}

function timecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) fail("storage-invalid", `无法格式化非法时码：${seconds}`);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  const wholeSeconds = Math.floor(remainder);
  const fraction = Number.isInteger(remainder)
    ? ""
    : remainder.toFixed(3).replace(/0+$/u, "").split(".")[1] ?? "";
  const secondText = `${String(wholeSeconds).padStart(2, "0")}${fraction ? `.${fraction}` : ""}`;
  return `${String(minutes).padStart(2, "0")}:${secondText}`;
}

function studioProjectionRawRelativePath(authority: ResolvedAuthority): string {
  return `03_15秒宫格故事板/S1E1/${authority.unitId}_${authority.pack.target.panelCount}格_raw.png`;
}

async function frozenStoryboardCropStartFramePolicy(
  productionRoot: string,
  identity: DuduReadonlyActiveProjectIdentity,
  unitId: string,
): Promise<boolean> {
  const relativePath = `${SOURCE_SPEC_ROOT_RELATIVE_PATH}/${unitId}_视频规格.json`;
  const frozen = identity.sourceFiles.filter((file) => file.scope === "production-root" && file.relativePath === relativePath);
  if (frozen.length === 0) return false;
  if (frozen.length !== 1) fail("input-drift", `${unitId} 冻结视频规格身份不唯一。`);
  const filePath = await assertSafeRelativeChain(productionRoot, relativePath, "file");
  const snapshot = await readJsonSnapshot(filePath, `${unitId} 冻结视频规格`);
  assertSnapshotMatchesSourceIdentity(
    { bytes: snapshot.bytes, sha256: snapshot.sha256, sizeBytes: snapshot.bytes.byteLength },
    frozen[0]!,
    `${unitId} 冻结视频规格`,
  );
  const gate = snapshot.value.target_video_model_gate;
  const shots = snapshot.value.shots;
  if (!gate || typeof gate !== "object" || Array.isArray(gate)
    || (gate as Record<string, unknown>).sample_status !== "NOT_TESTED"
    || !Array.isArray(shots) || shots.length < 1) return false;
  return shots.every((shot) => {
    if (!shot || typeof shot !== "object" || Array.isArray(shot)) return false;
    const row = shot as Record<string, unknown>;
    const plan = row.i2v_input;
    return row.input_frame_role === "shot_start"
      && plan && typeof plan === "object" && !Array.isArray(plan)
      && (plan as Record<string, unknown>).can_use_as_start_frame === true;
  });
}

async function buildStudioReviewSourceSpec(input: {
  authority: ResolvedAuthority;
  identity?: DuduReadonlyActiveProjectIdentity;
  managedSource: ManagedEvidenceVideoPackageSourceSpec;
  rawSnapshot: StableFileSnapshot;
  storyboardCropAcceptedAsStartFrame: boolean;
  sourceScriptIdentity?: string;
  rawRelativePath?: string;
}): Promise<{ value: Record<string, unknown>; snapshot: StableFileSnapshot; rawRelativePath: string }> {
  if (!input.authority.provider) {
    fail("authority-not-ready", "Studio Review 派生视频规格缺少真实生图 provider。 ");
  }
  const visual = input.identity
    ? await readDuduFrozenVisualExecutionUnit({
        productionRoot: input.identity.sourceProductionRoot,
        sourceFiles: input.identity.sourceFiles,
        unitId: input.authority.unitId,
      })
    : null;
  const pack = input.authority.pack;
  const managed = input.managedSource;
  if (managed.projectId !== input.authority.projectId
    || managed.unit.unitId !== input.authority.unitId
    || managed.unit.unitRevision !== input.authority.unitRevision
    || managed.unit.panelCount !== pack.target.panelCount
    || managed.evidence.reviewId !== input.authority.authorityId
    || managed.evidence.reviewFingerprint !== input.authority.authorityFingerprint
    || managed.evidence.packId !== input.authority.packId
    || managed.evidence.packFingerprint !== input.authority.packFingerprint
    || managed.evidence.rawResultId !== input.authority.rawResultId
    || managed.evidence.rawSha256 !== input.authority.rawSha256
    || managed.evidence.labeledResultId !== input.authority.labeledResultId
    || managed.evidence.labeledSha256 !== input.authority.labeledSha256
    || managed.continuity.planned.fingerprint !== pack.continuityFingerprint
    || managed.panels.length !== pack.panels.length) {
    fail("input-drift", `${input.authority.unitId} 的 managed-evidence source 与导出 authority 不一致。`);
  }
  if (visual && (visual.sequence !== pack.target.unitSequence || visual.panelCount !== pack.target.panelCount
    || Math.abs(visual.durationSeconds - pack.target.durationSeconds) > 1e-6
    || visual.panels.length !== pack.panels.length)) {
    fail("input-drift", `${input.authority.unitId} 的冻结视觉执行与 Studio unit-grid 不一致。`);
  }
  let metadata: Metadata;
  try {
    metadata = await sharp(input.rawSnapshot.bytes, { failOn: "error", limitInputPixels: 100_000_000 }).metadata();
  } catch (error) {
    throw new StudioVideoPackageError("input-drift", "Studio raw 无法为视频包解析尺寸。", [], { cause: error });
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 64 || height < 64 || height <= width) fail("input-drift", `Studio raw 尺寸无效：${width}x${height}`);
  const rawRelativePath = input.rawRelativePath ?? studioProjectionRawRelativePath(input.authority);
  const panels = pack.panels.map((frozen, offset) => {
    const source = visual?.panels[offset];
    const managedPanel = managed.panels[offset]!;
    if ((source && (source.id !== `${input.authority.unitId}-G${offset + 1}`
      || Math.abs(source.startSeconds - frozen.startSeconds) > 1e-6
      || Math.abs(source.endSeconds - frozen.endSeconds) > 1e-6))
      || managedPanel.panelId !== frozen.panelId
      || managedPanel.panelIndex !== frozen.panelIndex
      || Math.abs(managedPanel.timecode.unitStartSeconds - frozen.startSeconds) > 1e-6
      || Math.abs(managedPanel.timecode.unitEndSeconds - frozen.endSeconds) > 1e-6) {
      fail("input-drift", `${input.authority.unitId}-G${offset + 1} 视觉执行时码与冻结包不一致。`);
    }
    const y = Math.floor(height * offset / pack.target.panelCount);
    const nextY = Math.floor(height * (offset + 1) / pack.target.panelCount);
    return { id: `G${offset + 1}`, rect: { x: 0, y, width, height: nextY - y } };
  });
  const actualStateText = (
    value: typeof managed.continuity.previousActual | typeof managed.continuity.observed,
  ): string => {
    if (value.status !== "current") return "unknown";
    const entries = Object.entries(value.endState)
      .filter(([field]) => field !== "referenceSha256")
      .map(([field, fieldValue]) => `${field}=${fieldValue}`);
    return entries.length > 0 ? `observed｜${entries.join("｜")}` : "unknown";
  };
  const previousActualText = actualStateText(managed.continuity.previousActual);
  const currentObservedText = actualStateText(managed.continuity.observed);
  const shots = pack.panels.map((frozen, offset) => {
    const source = visual?.panels[offset];
    const managedPanel = managed.panels[offset]!;
    const instruction = frozen.instruction;
    const action = managedPanel.visualAction;
    const composition = managedPanel.shotComposition;
    const sourceField = (key: string, fallback: string): string =>
      source ? duduField(source, key, fallback) : fallback;
    const continuity = sourceField("连续性", "保持当前冻结 BindingSet 与相邻格状态");
    const expression = [sourceField("表情", "克制自然"), sourceField("表情细节", "微表情连续")].join("；");
    const sound = managedPanel.sound.sourceSoundAndText ?? "unknown";
    const dialogue = managedPanel.dialogue ?? "无";
    const voiceover = "无";
    const duration = frozen.durationSeconds;
    const midpoint = Number((duration / 2).toFixed(6));
    const immutable = frozen.panelPack.assets.map((asset) =>
      `${asset.definition.name}：${asset.definition.identityFeatures.join("、") || asset.role}`).join("；")
      || "当前冻结场景拓扑、角色身份和道具状态";
    const negative = [
      managedPanel.negativePrompt ?? instruction.negativePrompt,
      ...frozen.panelPack.request.safetyConstraints.flatMap((item) => item.negativeLocks),
    ]
      .map((item) => item.trim()).filter(Boolean).join("；");
    const shotSize = sourceField("景别", instruction.shotComposition);
    const cameraAngle = sourceField("机位", "平视");
    const cameraMove = managedPanel.cameraMovement;
    const emotion = sourceField("情绪", "克制连续");
    return {
      id: `G${offset + 1}`,
      timeline_start: timecode(frozen.startSeconds),
      timeline_end: timecode(frozen.endSeconds),
      duration_sec: duration,
      shot_size: shotSize,
      camera_angle: cameraAngle,
      storyboard_frame_role: "representative",
      input_frame_role: "shot_start",
      axis_180: continuity,
      action_axis: composition,
      camera_side: cameraAngle,
      geographic_direction: continuity,
      screen_direction: composition,
      composition,
      character_state: `${expression}；${continuity}`,
      action,
      dialogue,
      voiceover,
      sound,
      lighting: `${managedPanel.sceneLighting ?? instruction.sceneLighting}；${sourceField("色彩", "保持冻结色彩")}`,
      scene_anchor: continuity,
      previous_end_state: offset === 0
        ? previousActualText
        : `planned｜${managed.panels[offset - 1]!.visualAction}`,
      next_start_state: offset === pack.panels.length - 1
        ? currentObservedText
        : `planned｜${managed.panels[offset + 1]!.visualAction}`,
      continuity_evidence: {
        planned: {
          status: managedPanel.planned.status,
          panel_pack_fingerprint: managedPanel.planned.panelPackFingerprint,
          continuity_fingerprint: managedPanel.planned.continuityFingerprint,
        },
        previous_actual: offset === 0
          ? managed.continuity.previousActual
          : { status: "unknown", reason: "within-unit-transition-is-planned-not-observed" },
        current_actual: offset === pack.panels.length - 1
          ? managed.continuity.observed
          : managedPanel.observed,
      },
      caption_lines: [
        `G${offset + 1}｜${timecode(frozen.startSeconds)}—${timecode(frozen.endSeconds)}｜${duration}秒｜${shotSize}／${cameraAngle}`,
        `运镜：${cameraMove}`,
        `画面：${composition}｜动作：${action}`,
        `声音：对白${dialogue}｜旁白${voiceover}｜${sound}`,
      ],
      camera_score: {
        narrative_intent: emotion,
        baseline: `${cameraAngle}；${composition}`,
        axis_180: continuity,
        action_axis: composition,
        camera_side: cameraAngle,
        geographic_direction: continuity,
        screen_direction: composition,
        start_frame: "当前 Studio Review PASS 宫格锚帧",
        end_frame: `完成本格动作并衔接：${action}`,
        movement_type: cameraMove,
        path: cameraMove,
        distance_or_angle: "按冻结运镜克制执行，不擅自扩幅",
        framing_change: "仅按冻结运镜描述",
        speed_curve: "缓入—主体动作—缓停",
        holds: "起点短暂稳定，末端留剪辑停顿",
        parallax_layers: "保持主体、场景与前后景层次稳定",
        focus: "主体身份与关键接触点清楚",
        depth_of_field: "电影写实景深，不得呼吸变形",
        subject_camera_relation: "摄影机服务动作和情绪，不抢主体",
        exit: offset === pack.panels.length - 1 ? "衔接下一单元" : `硬切 G${offset + 2}`,
        stability: "禁止非冻结抖动、镜像、跳轴和无因拉焦",
      },
      performance_score: {
        thought_before: `承接前态：${continuity}`,
        trigger: action,
        thought_after: emotion,
        intensity: "按冻结情绪强度克制执行",
        eyeline_target: composition,
        ears: expression,
        eyes: expression,
        mouth_nose_throat: dialogue === "无" ? "闭口，无台词口型" : "只按锁版对白克制表演",
        tail: "只按画面可见与冻结动作执行",
        breathing: "自然微呼吸，不改变体型",
        weight: "重心与接触物理连续",
        contact_points: action,
        end_hold: "末端短暂停住",
        forbid_anthropomorphic: "禁止人手化、人类表情和未冻结肢体动作",
      },
      temporal_score: [
        {
          start_sec: 0,
          end_sec: midpoint,
          action_goal: "从当前宫格锚点建立主体状态并启动后续动作",
          subject_state: expression,
          camera_state: cameraMove,
          sound_trigger: sound,
        },
        {
          start_sec: midpoint,
          end_sec: duration,
          action_goal: action,
          subject_state: continuity,
          camera_state: `${cameraMove}并在末端稳定`,
          sound_trigger: sound,
        },
      ],
      sound_score: {
        dialogue,
        voiceover,
        ambience: sound,
        foley: sound,
        accent: "只在冻结动作节点使用",
        music: sound,
        silence: "无额外填充",
        prelap: "无未授权预叠",
        postlap: "无未授权后叠",
        cut_bridge: "按相邻格状态自然衔接",
      },
      i2v_input: {
        storyboard_crop_path: "待构建器写入",
        storyboard_crop_sha256: "待构建器写入",
        can_use_as_start_frame: true,
        start_frame_path: "待构建器写入",
        start_frame_sha256: "待构建器写入",
        end_frame_path: null,
        end_frame_sha256: null,
        immutable_regions: immutable,
        motion_regions: action,
        occlusion_risks: negative || "禁止身份漂移、错肢、穿插、文字、镜像和场景呼吸",
        usage_mode: input.storyboardCropAcceptedAsStartFrame
          ? "storyboard_crop_accepted_start_frame"
          : "storyboard_crop_anchor_followup",
        is_locked_script_zero_sec: input.storyboardCropAcceptedAsStartFrame,
        claim_limit: input.storyboardCropAcceptedAsStartFrame
          ? "沿用该单元冻结 v2 合同：宫格裁图可作为 shot_start；未运行真实视频模型。"
          : "当前宫格仅作为已批准动作锚点向后续演；不声称等于锁版真正0秒。",
      },
      video_prompt: input.storyboardCropAcceptedAsStartFrame
        ? `${duration}秒电影级东方奇幻写实CG。以 Studio Review PASS 宫格裁图作为冻结合同已接受的 shot_start：${action}。构图与运镜：${composition}；${cameraMove}。保持：${immutable}。`
        : `${duration}秒电影级东方奇幻写实CG。以上传的 Studio Review PASS 宫格裁图作为当前动作锚点，只从画面现状向后续演：${action}。构图与运镜：${composition}；${cameraMove}。保持：${immutable}。不宣称还原锁版真正0秒。`,
      negative_prompt: negative || "禁止身份漂移、错肢、多余角色、文字、字幕、水印、UI、镜像、跳轴、穿插和场景呼吸变形。",
    };
  });
  const value: Record<string, unknown> = {
    schema_version: "2.0",
    unit_id: input.authority.unitId,
    status: "PASS",
    unit_duration_sec: pack.target.durationSeconds,
    layout: { columns: 1, rows: pack.target.panelCount, reading_order: "上→下" },
    raw_path: rawRelativePath,
    raw_sha256: input.authority.rawSha256,
    source_script: input.sourceScriptIdentity ?? input.identity?.sourceLockedScriptPath,
    generation: {
      provider: input.authority.provider,
      generation_run_id: input.authority.generationRunId,
      review_id: input.authority.authorityId,
      review_fingerprint: input.authority.authorityFingerprint,
      claim: "Studio Review PASS；模型后端未额外报告的字段不推断。",
    },
    managed_source: {
      adapter_kind: managed.adapterKind,
      source_id: managed.id,
      source_fingerprint: managed.fingerprint,
      unit_snapshot_fingerprint: managed.unit.unitSnapshotFingerprint,
      review_fingerprint: managed.evidence.reviewFingerprint,
      pack_fingerprint: managed.evidence.packFingerprint,
      observation_control: managed.evidence.observationControl,
    },
    continuity_contract: {
      planned: managed.continuity.planned,
      previous_actual: managed.continuity.previousActual,
      current_actual: managed.continuity.observed,
    },
    caption_height: 220,
    target_video_model_gate: {
      target_model: null,
      sample_status: input.storyboardCropAcceptedAsStartFrame ? "NOT_TESTED" : "STORYBOARD_CROP_ANCHOR_FOLLOWUP_ONLY",
      claim_limit: input.storyboardCropAcceptedAsStartFrame
        ? "静态 shot_start 输入和提交包可机械验证；真实动态模型未调用。"
        : "提交包结构、逐格裁图和锚点后续指令可机械验证；未补独立0秒首帧，也未运行真实视频模型。",
    },
    panels,
    shots,
  };
  const bytes = Buffer.from(serializeStudioCanonicalJsonPretty(value), "utf8");
  return {
    value,
    snapshot: { bytes, sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") },
    rawRelativePath,
  };
}

async function resolveFrozenDependency(
  productionRoot: string,
  identity: DuduReadonlyActiveProjectIdentity,
  value: unknown,
  expectedSha: unknown,
  field: string,
): Promise<{ relativePath: string; snapshot: StableFileSnapshot }> {
  const relativePath = productionFileRelative(value, field);
  const filePath = await assertSafeRelativeChain(productionRoot, relativePath, "file");
  const snapshot = await readStableFile(filePath);
  const manifestIdentity = sourceIdentityFor(identity, relativePath);
  assertSnapshotMatchesSourceIdentity(snapshot, manifestIdentity, field);
  if (snapshot.sha256 !== normalizeSha(expectedSha, `${field}.sha256`)) {
    fail("input-drift", `${field} 内容哈希与视频规格不一致。`);
  }
  return { relativePath, snapshot };
}

async function resolveManagedProjectExternalInput(
  projectRoot: string,
  authority: ResolvedAuthority,
  managedSource: ManagedEvidenceVideoPackageSourceSpec,
  packageRelativePathOverride?: string,
): Promise<ResolvedExternalInput> {
  const shell = await inspectManagedProject(projectRoot);
  const managedRoot = path.resolve(shell.paths.root);
  if (shell.project.id !== authority.projectId || managedSource.projectId !== authority.projectId) {
    fail("authority-not-ready", "视频包 authority 与当前通用受管工程身份不一致。");
  }
  const builderRelativePath = MANAGED_CORE_BUILDER_RELATIVE_PATH;
  const outputRootRelativePath = MANAGED_OUTPUT_ROOT_RELATIVE_PATH;
  const expectedPackageRelativePath = `${outputRootRelativePath}/${authority.unitId}`;
  const packageRelativePath = packageRelativePathOverride === undefined
    ? expectedPackageRelativePath
    : normalizeRelative(packageRelativePathOverride, "packageRelativePath");
  if (packageRelativePath !== expectedPackageRelativePath) {
    fail("input-drift", `通用受管视频包只能绑定固定目标：${expectedPackageRelativePath}`);
  }
  const sourceSpecRelativePath =
    `${MANAGED_SOURCE_SPEC_ROOT_RELATIVE_PATH}/${authority.unitId}/${managedSource.fingerprint}.json`;
  const rawRelativePath =
    `${MANAGED_RAW_ROOT_RELATIVE_PATH}/${authority.unitId}/${authority.rawSha256}.png`;
  const [python, magick, font, rawMedia, labeledMedia] = await Promise.all([
    resolveVideoBuilderPython(),
    resolveVideoBuilderMagick(),
    resolveVideoBuilderFont(),
    getStudioMedia(projectRoot, authority.rawSha256),
    getStudioMedia(projectRoot, authority.labeledSha256),
  ]);
  if (!rawMedia || !labeledMedia || rawMedia.kind !== "image" || labeledMedia.kind !== "image") {
    fail("authority-not-ready", "通用受管视频包 authority 缺少 Studio raw/labeled 媒体。");
  }
  const [rawSnapshot, labeledSnapshot] = await Promise.all([
    readStableFile(rawMedia.objectPath),
    readStableFile(labeledMedia.objectPath),
  ]);
  if (rawSnapshot.sha256 !== authority.rawSha256 || labeledSnapshot.sha256 !== authority.labeledSha256) {
    fail("authority-not-ready", "通用受管视频包的 Studio raw/labeled CAS SHA 漂移。");
  }
  const projected = await buildStudioReviewSourceSpec({
    authority,
    managedSource,
    rawSnapshot,
    storyboardCropAcceptedAsStartFrame: false,
    sourceScriptIdentity: `managed-source:${managedSource.id}`,
    rawRelativePath,
  });
  assertSourceSpecMatchesPack(
    projected.value,
    authority.pack,
    managedRoot,
    "managed-project",
    managedSource.id,
  );
  const builderSnapshot: StableFileSnapshot = {
    bytes: MANAGED_CORE_BUILDER_BYTES,
    sizeBytes: MANAGED_CORE_BUILDER_BYTES.byteLength,
    sha256: createHash("sha256").update(MANAGED_CORE_BUILDER_BYTES).digest("hex"),
  };
  const sourceIdentitySeed = {
    kind: "managed-project-video-source" as const,
    projectId: authority.projectId,
    projectRoot: managedRoot,
    managedSourceFingerprint: managedSource.fingerprint,
    unitSnapshotFingerprint: managedSource.unit.unitSnapshotFingerprint,
    packFingerprint: authority.packFingerprint,
  };
  const sourceManifestFingerprint = digest(sourceIdentitySeed);
  const compatibilityIdentity: VideoPackageDuduIdentity = {
    projectId: authority.projectId,
    projectRoot: managedRoot,
    sourceProductionRoot: managedRoot,
    sourceLockedScriptPath: managedRoot,
    sourceManifestFingerprint,
    productionScopeFingerprint: managedSource.unit.unitSnapshotFingerprint,
    contractSha256: authority.packFingerprint,
    importReceiptFingerprint: managedSource.fingerprint,
    registrationFingerprint: digest({
      kind: "managed-project-registration",
      projectId: authority.projectId,
      projectRoot: managedRoot,
    }),
  };
  return {
    sourceKind: "managed-project",
    projectionMode: "studio-review-derived",
    duduIdentity: compatibilityIdentity,
    productionRoot: managedRoot,
    builderRelativePath,
    builderPath: path.join(managedRoot, ...builderRelativePath.split("/")),
    builderSha256: builderSnapshot.sha256,
    pythonPath: python.path,
    pythonSha256: python.sha256,
    magickPath: magick.path,
    magickSha256: magick.sha256,
    fontPath: font.path,
    fontSha256: font.sha256,
    sourceSpecRelativePath,
    sourceSpecPath: path.join(managedRoot, ...sourceSpecRelativePath.split("/")),
    sourceSpecSha256: projected.snapshot.sha256,
    sourceSpec: projected.value,
    outputRootRelativePath,
    outputRootPath: path.join(managedRoot, ...outputRootRelativePath.split("/")),
    packageRelativePath,
    packagePath: path.join(managedRoot, ...packageRelativePath.split("/")),
    builderSnapshot,
    fontSnapshot: font.snapshot,
    sourceSpecSnapshot: projected.snapshot,
    rawSnapshot,
    labeledSnapshot,
    rawRelativePath,
    dependencies: [{ relativePath: rawRelativePath, snapshot: rawSnapshot }],
    managedSource,
  };
}

async function resolveExternalInput(
  projectRoot: string,
  authority: ResolvedAuthority,
  packageRelativePathOverride?: string,
  managedSource?: ManagedEvidenceVideoPackageSourceSpec,
): Promise<ResolvedExternalInput> {
  let duduIdentity: DuduReadonlyActiveProjectIdentity;
  try {
    duduIdentity = await getActiveDuduReadonlyProjectIdentity(projectRoot);
  } catch (error) {
    if (authority.authorityKind === "studio-review" && managedSource) {
      return resolveManagedProjectExternalInput(
        projectRoot,
        authority,
        managedSource,
        packageRelativePathOverride,
      );
    }
    throw new StudioVideoPackageError(
      "authority-not-ready",
      "视频包导出只允许当前精确激活且完整闭包的 Dudu 隔离受管工程。",
      [error instanceof Error ? error.message : String(error)],
      { cause: error },
    );
  }
  const managedRoot = path.resolve((await inspectManagedProject(projectRoot)).paths.root);
  if (path.resolve(duduIdentity.projectRoot) !== managedRoot || duduIdentity.projectId !== authority.projectId) {
    fail("authority-not-ready", "视频包 authority 与当前 Dudu 活动工程身份不一致。");
  }
  const productionRoot = await canonicalDirectory(duduIdentity.sourceProductionRoot, "Dudu sourceProductionRoot");
  const builderRelativePath = BUILDER_RELATIVE_PATH;
  let sourceSpecRelativePath = `${SOURCE_SPEC_ROOT_RELATIVE_PATH}/${authority.unitId}_视频规格.json`;
  const outputRootRelativePath = OUTPUT_ROOT_RELATIVE_PATH;
  const expectedPackageRelativePath = `${outputRootRelativePath}/${authority.unitId}`;
  const packageRelativePath = packageRelativePathOverride === undefined
    ? expectedPackageRelativePath
    : normalizeRelative(packageRelativePathOverride, "packageRelativePath");
  if (packageRelativePath !== expectedPackageRelativePath) {
    fail("input-drift", `视频包只能写入固定单层目标：${expectedPackageRelativePath}`);
  }
  const builderPath = await assertSafeRelativeChain(productionRoot, builderRelativePath, "file");
  const outputRootPath = await assertSafeRelativeChain(productionRoot, outputRootRelativePath, "directory-or-missing");
  const [builderSnapshot, python, magick, font, rawMedia, labeledMedia] = await Promise.all([
    readStableFile(builderPath),
    resolveVideoBuilderPython(),
    resolveVideoBuilderMagick(),
    resolveVideoBuilderFont(),
    getStudioMedia(projectRoot, authority.rawSha256),
    getStudioMedia(projectRoot, authority.labeledSha256),
  ]);
  assertSnapshotMatchesSourceIdentity(builderSnapshot, sourceIdentityFor(duduIdentity, builderRelativePath), "视频包 builder");
  if (!rawMedia || !labeledMedia || rawMedia.kind !== "image" || labeledMedia.kind !== "image") {
    fail("authority-not-ready", "视频包 authority 缺少 Studio raw/labeled 媒体。 ");
  }
  const [rawMediaSnapshot, labeledSnapshot] = await Promise.all([
    readStableFile(rawMedia.objectPath),
    readStableFile(labeledMedia.objectPath),
  ]);
  if (rawMediaSnapshot.sha256 !== authority.rawSha256 || labeledSnapshot.sha256 !== authority.labeledSha256) {
    fail("authority-not-ready", "视频包 authority 的 Studio raw/labeled CAS SHA 漂移。 ");
  }

  let projectionMode: ResolvedExternalInput["projectionMode"];
  let sourceSpecPath: string;
  let sourceSpecSnapshot: StableFileSnapshot;
  let sourceSpec: Record<string, unknown>;
  let rawDependency: { relativePath: string; snapshot: StableFileSnapshot };
  if (authority.authorityKind === "historical-import") {
    if (managedSource !== undefined) {
      fail("input-drift", "historical-import 不得消费 managed-evidence source。");
    }
    projectionMode = "frozen-historical";
    sourceSpecPath = await assertSafeRelativeChain(productionRoot, sourceSpecRelativePath, "file");
    const specJson = await readJsonSnapshot(sourceSpecPath, "视频规格");
    sourceSpecSnapshot = {
      bytes: specJson.bytes,
      sha256: specJson.sha256,
      sizeBytes: specJson.bytes.byteLength,
    };
    assertSnapshotMatchesSourceIdentity(sourceSpecSnapshot, sourceIdentityFor(duduIdentity, sourceSpecRelativePath), "视频规格");
    sourceSpec = specJson.value;
    rawDependency = await resolveFrozenDependency(
      productionRoot,
      duduIdentity,
      sourceSpec.raw_path,
      sourceSpec.raw_sha256,
      "视频规格 raw_path",
    );
  } else {
    if (!managedSource) {
      fail("authority-not-ready", "studio-review 视频包缺少 managed-evidence source。");
    }
    projectionMode = "studio-review-derived";
    const storyboardCropAcceptedAsStartFrame = await frozenStoryboardCropStartFramePolicy(
      productionRoot,
      duduIdentity,
      authority.unitId,
    );
    const projected = await buildStudioReviewSourceSpec({
      authority,
      identity: duduIdentity,
      managedSource,
      rawSnapshot: rawMediaSnapshot,
      storyboardCropAcceptedAsStartFrame,
    });
    sourceSpecRelativePath = `${SOURCE_SPEC_ROOT_RELATIVE_PATH}/.studio-video-specs/${authority.unitId}/${projected.snapshot.sha256}.json`;
    sourceSpecPath = await safeProjectionFilePath(productionRoot, sourceSpecRelativePath, "Studio 派生视频规格");
    sourceSpecSnapshot = projected.snapshot;
    sourceSpec = projected.value;
    rawDependency = { relativePath: projected.rawRelativePath, snapshot: rawMediaSnapshot };
    const existingSpec = await lstat(sourceSpecPath).catch(() => null);
    if (existingSpec) {
      const snapshot = await readStableFile(sourceSpecPath);
      if (snapshot.sha256 !== sourceSpecSnapshot.sha256 || snapshot.sizeBytes !== sourceSpecSnapshot.sizeBytes) {
        fail("destination-conflict", `Studio 派生视频规格已存在且内容不同：${sourceSpecRelativePath}`);
      }
    }
    const projectedRawPath = await safeProjectionFilePath(productionRoot, rawDependency.relativePath, "Studio 派生 raw");
    const existingRaw = await lstat(projectedRawPath).catch(() => null);
    if (existingRaw) {
      const snapshot = await readStableFile(projectedRawPath);
      if (snapshot.sha256 !== rawDependency.snapshot.sha256 || snapshot.sizeBytes !== rawDependency.snapshot.sizeBytes) {
        fail("destination-conflict", `Studio 派生 raw 已存在且内容不同：${rawDependency.relativePath}`);
      }
    }
  }
  if (sourceSpec.unit_id !== authority.unitId) fail("input-drift", "视频规格 unit_id 与 Studio target 不一致。");
  if (normalizeSha(sourceSpec.raw_sha256, "视频规格 raw_sha256") !== authority.rawSha256) {
    fail("input-drift", "视频规格 raw_sha256 与 Review/历史 PASS raw 不一致。");
  }
  assertSourceSpecMatchesPack(
    sourceSpec,
    authority.pack,
    duduIdentity.sourceLockedScriptPath,
    "dudu-readonly",
  );
  if (rawDependency.snapshot.sha256 !== authority.rawSha256) {
    fail("input-drift", "视频规格引用的 raw 与 Studio authority 不一致。");
  }
  const dependencies = new Map<string, { relativePath: string; snapshot: StableFileSnapshot }>();
  dependencies.set(rawDependency.relativePath, rawDependency);
  if (sourceSpec.schema_version === "2.0") {
    for (const [offset, shot] of (sourceSpec.shots as unknown[]).entries()) {
      if (!shot || typeof shot !== "object" || Array.isArray(shot)) fail("input-drift", `shots[${offset}] 无效。`);
      const inputPlan = (shot as Record<string, unknown>).i2v_input;
      if (!inputPlan || typeof inputPlan !== "object" || Array.isArray(inputPlan)) {
        fail("input-drift", `shots[${offset}].i2v_input 无效。`);
      }
      const plan = inputPlan as Record<string, unknown>;
      if (typeof plan.can_use_as_start_frame !== "boolean") {
        fail("input-drift", `shots[${offset}].i2v_input.can_use_as_start_frame 必须是布尔值。`);
      }
      if (!plan.can_use_as_start_frame) {
        if (projectionMode === "studio-review-derived") {
          fail("authority-not-ready", `Studio 派生视频规格 shots[${offset}] 需要尚未进入本切片的独立 I2V 首帧。`);
        }
        const start = await resolveFrozenDependency(
          productionRoot,
          duduIdentity,
          plan.start_frame_path,
          plan.start_frame_sha256,
          `shots[${offset}].i2v_input.start_frame_path`,
        );
        dependencies.set(start.relativePath, start);
      }
      if (plan.end_frame_path !== null && plan.end_frame_path !== undefined && plan.end_frame_path !== "") {
        if (projectionMode === "studio-review-derived") {
          fail("authority-not-ready", `Studio 派生视频规格 shots[${offset}] 引用了未进入冻结投影的独立尾帧。`);
        }
        const end = await resolveFrozenDependency(
          productionRoot,
          duduIdentity,
          plan.end_frame_path,
          plan.end_frame_sha256,
          `shots[${offset}].i2v_input.end_frame_path`,
        );
        dependencies.set(end.relativePath, end);
      } else if (plan.end_frame_sha256 !== null && plan.end_frame_sha256 !== undefined && plan.end_frame_sha256 !== "") {
        fail("input-drift", `shots[${offset}].i2v_input 尾帧路径为空但哈希非空。`);
      }
    }
  }
  return {
    sourceKind: "dudu-readonly",
    projectionMode,
    duduIdentity,
    productionRoot,
    builderRelativePath,
    builderPath,
    builderSha256: builderSnapshot.sha256,
    pythonPath: python.path,
    pythonSha256: python.sha256,
    magickPath: magick.path,
    magickSha256: magick.sha256,
    fontPath: font.path,
    fontSha256: font.sha256,
    sourceSpecRelativePath,
    sourceSpecPath,
    sourceSpecSha256: sourceSpecSnapshot.sha256,
    sourceSpec,
    outputRootRelativePath,
    outputRootPath,
    packageRelativePath,
    packagePath: path.join(productionRoot, ...packageRelativePath.split("/")),
    builderSnapshot,
    fontSnapshot: font.snapshot,
    sourceSpecSnapshot,
    rawSnapshot: rawDependency.snapshot,
    labeledSnapshot,
    rawRelativePath: rawDependency.relativePath,
    dependencies: [...dependencies.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en")),
    ...(managedSource ? { managedSource } : {}),
  };
}

async function assertMediaClosure(projectRoot: string, authority: ResolvedAuthority): Promise<void> {
  const [raw, labeled, rawValid, labeledValid] = await Promise.all([
    getStudioMedia(projectRoot, authority.rawSha256),
    getStudioMedia(projectRoot, authority.labeledSha256),
    verifyStudioMediaObject(projectRoot, authority.rawSha256),
    verifyStudioMediaObject(projectRoot, authority.labeledSha256),
  ]);
  if (!raw || !labeled || raw.kind !== "image" || labeled.kind !== "image" || !rawValid || !labeledValid) {
    fail("authority-not-ready", "视频包 authority 的 raw/labeled CAS 闭包无效。");
  }
}

function inputSemantic(authority: ResolvedAuthority, external: ResolvedExternalInput) {
  const observation = external.managedSource?.evidence.observationControl;
  const { pack: _pack, provider: _provider, ...authorityIdentity } = authority;
  return {
    ...authorityIdentity,
    targetKind: "unit-grid" as const,
    managedEvidence: external.managedSource
      ? {
          status: "bound" as const,
          adapterKind: external.managedSource.adapterKind,
          sourceFingerprint: external.managedSource.fingerprint,
          unitSnapshotFingerprint: external.managedSource.unit.unitSnapshotFingerprint,
          reviewFingerprint: external.managedSource.evidence.reviewFingerprint,
          packFingerprint: external.managedSource.evidence.packFingerprint,
          observationControl: observation,
        }
      : {
          status: "historical-observation-unknown" as const,
        },
    sourceIdentityKind: external.sourceKind,
    duduImportReceiptFingerprint: external.duduIdentity.importReceiptFingerprint,
    duduRegistrationFingerprint: external.duduIdentity.registrationFingerprint,
    sourceManifestFingerprint: external.duduIdentity.sourceManifestFingerprint,
    productionScopeFingerprint: external.duduIdentity.productionScopeFingerprint,
    contractSha256: external.duduIdentity.contractSha256,
    productionRoot: external.productionRoot,
    builderRelativePath: external.builderRelativePath,
    builderSha256: external.builderSha256,
    pythonPath: external.pythonPath,
    pythonSha256: external.pythonSha256,
    magickPath: external.magickPath,
    magickSha256: external.magickSha256,
    fontPath: external.fontPath,
    fontSha256: external.fontSha256,
    sourceSpecRelativePath: external.sourceSpecRelativePath,
    sourceSpecSha256: external.sourceSpecSha256,
    outputRootRelativePath: external.outputRootRelativePath,
  };
}

function sourceClosureDuduIdentity(
  identity: VideoPackageDuduIdentity,
): Record<string, StudioVideoPackageSourceClosureJson> {
  return {
    projectId: identity.projectId,
    projectRoot: identity.projectRoot,
    sourceProductionRoot: identity.sourceProductionRoot,
    sourceLockedScriptPath: identity.sourceLockedScriptPath,
    sourceManifestFingerprint: identity.sourceManifestFingerprint,
    productionScopeFingerprint: identity.productionScopeFingerprint,
    contractSha256: identity.contractSha256,
    importReceiptFingerprint: identity.importReceiptFingerprint,
    registrationFingerprint: identity.registrationFingerprint,
  };
}

async function freezeResolvedExternalInputSourceClosure(
  projectRoot: string,
  authority: ResolvedAuthority,
  external: ResolvedExternalInput,
): Promise<string> {
  const rawDependency = external.dependencies.find(
    (entry) => entry.relativePath === external.rawRelativePath,
  );
  if (!rawDependency
    || rawDependency.snapshot.sha256 !== external.rawSnapshot.sha256
    || rawDependency.snapshot.sizeBytes !== external.rawSnapshot.sizeBytes) {
    fail("storage-invalid", "视频包 raw 未闭合进冻结依赖。");
  }
  const entries = [
    {
      role: "builder",
      logicalPath: external.builderRelativePath,
      bytes: external.builderSnapshot.bytes,
      expectedSha256: external.builderSnapshot.sha256,
    },
    {
      role: "font",
      logicalPath: `toolchain/font/${external.fontSnapshot.sha256}-${path.basename(external.fontPath)}`,
      bytes: external.fontSnapshot.bytes,
      expectedSha256: external.fontSnapshot.sha256,
    },
    {
      role: "source-spec",
      logicalPath: external.sourceSpecRelativePath,
      bytes: external.sourceSpecSnapshot.bytes,
      expectedSha256: external.sourceSpecSnapshot.sha256,
    },
    {
      role: "raw",
      logicalPath: external.rawRelativePath,
      bytes: external.rawSnapshot.bytes,
      expectedSha256: external.rawSnapshot.sha256,
    },
    {
      role: "labeled",
      logicalPath: `authority/${authority.unitId}/${authority.labeledSha256}.png`,
      bytes: external.labeledSnapshot.bytes,
      expectedSha256: external.labeledSnapshot.sha256,
    },
    ...external.dependencies
      .filter((entry) => entry.relativePath !== external.rawRelativePath)
      .map((entry) => ({
        role: "dependency",
        logicalPath: entry.relativePath,
        bytes: entry.snapshot.bytes,
        expectedSha256: entry.snapshot.sha256,
      })),
  ];
  const frozen = await freezeStudioVideoPackageSourceClosure(projectRoot, {
    entries,
    metadata: {
      schemaVersion: 1,
      kind: "studio-video-package-resolved-external-input",
      sourceKind: external.sourceKind,
      projectionMode: external.projectionMode,
      duduIdentity: sourceClosureDuduIdentity(external.duduIdentity),
      productionRoot: external.productionRoot,
      builderRelativePath: external.builderRelativePath,
      pythonPath: external.pythonPath,
      pythonSha256: external.pythonSha256,
      magickPath: external.magickPath,
      magickSha256: external.magickSha256,
      fontPath: external.fontPath,
      fontSha256: external.fontSha256,
      sourceSpecRelativePath: external.sourceSpecRelativePath,
      outputRootRelativePath: external.outputRootRelativePath,
      packageRelativePath: external.packageRelativePath,
      rawRelativePath: external.rawRelativePath,
    },
  });
  return frozen.closure.fingerprint;
}

function closureMetadataRecord(
  value: StudioVideoPackageSourceClosureJson | undefined,
  field: string,
): { [key: string]: StudioVideoPackageSourceClosureJson } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("storage-invalid", `source closure ${field} 必须是对象。`);
  }
  return value;
}

function closureMetadataString(
  record: { [key: string]: StudioVideoPackageSourceClosureJson },
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || !value) {
    fail("storage-invalid", `source closure ${field} 必须是非空字符串。`);
  }
  return value;
}

function absoluteClosurePath(
  record: { [key: string]: StudioVideoPackageSourceClosureJson },
  field: string,
): string {
  const value = closureMetadataString(record, field);
  if (!path.isAbsolute(value) || path.resolve(value) !== value) {
    fail("storage-invalid", `source closure ${field} 必须是规范绝对路径。`);
  }
  return value;
}

function closureFileByRole(
  closure: ReadStudioVideoPackageSourceClosure,
  role: string,
) {
  const matches = closure.files.filter((file) => file.role === role);
  if (matches.length !== 1) {
    fail("storage-invalid", `source closure 必须唯一包含 ${role}。`);
  }
  return matches[0]!;
}

async function resolvedExternalInputFromSourceClosure(
  projectRoot: string,
  intent: StudioVideoPackageExportIntent,
  authority: ResolvedAuthority,
  managedSource: ManagedEvidenceVideoPackageSourceSpec | undefined,
): Promise<ResolvedExternalInput> {
  if (intent.schemaVersion !== VIDEO_PACKAGE_SCHEMA_VERSION
    || !intent.sourceClosureFingerprint) {
    fail("input-drift", `视频包 intent ${intent.intentId} 未绑定 v5 source closure。`);
  }
  const binding = await readStudioVideoPackageSourceClosureBinding(
    projectRoot,
    intent.inputFingerprint,
  ).catch((error: unknown) => {
    throw new StudioVideoPackageError(
      "input-drift",
      `视频包 intent ${intent.intentId} 的 source closure binding 不可读。`,
      [],
      { cause: error },
    );
  });
  if (!binding
    || binding.sourceClosureFingerprint !== intent.sourceClosureFingerprint) {
    fail("input-drift", `视频包 intent ${intent.intentId} 的 source closure binding 不闭合。`);
  }
  const closure = await readStudioVideoPackageSourceClosure(
    projectRoot,
    intent.sourceClosureFingerprint,
    { roles: ["builder", "font", "source-spec", "raw", "labeled", "dependency"] },
  ).catch((error: unknown) => {
    throw new StudioVideoPackageError(
      "input-drift",
      `视频包 intent ${intent.intentId} 的 source closure 不可读。`,
      [],
      { cause: error },
    );
  });
  const metadata = closure.closure.metadata;
  if (metadata.schemaVersion !== 1
    || metadata.kind !== "studio-video-package-resolved-external-input") {
    fail("storage-invalid", "视频包 source closure metadata 合同无效。");
  }
  const projectionMode = metadata.projectionMode;
  if (projectionMode !== "frozen-historical"
    && projectionMode !== "studio-review-derived") {
    fail("storage-invalid", "视频包 source closure projectionMode 无效。");
  }
  const sourceKindValue = metadata.sourceKind;
  const sourceKind: ResolvedExternalInput["sourceKind"] = sourceKindValue === undefined
    ? "dudu-readonly"
    : sourceKindValue === "dudu-readonly" || sourceKindValue === "managed-project"
      ? sourceKindValue
      : fail("storage-invalid", "视频包 source closure sourceKind 无效。");
  const dudu = closureMetadataRecord(metadata.duduIdentity, "duduIdentity");
  const duduIdentity: VideoPackageDuduIdentity = {
    projectId: closureMetadataString(dudu, "projectId"),
    projectRoot: absoluteClosurePath(dudu, "projectRoot"),
    sourceProductionRoot: absoluteClosurePath(dudu, "sourceProductionRoot"),
    sourceLockedScriptPath: absoluteClosurePath(dudu, "sourceLockedScriptPath"),
    sourceManifestFingerprint: normalizeSha(
      closureMetadataString(dudu, "sourceManifestFingerprint"),
      "closure.duduIdentity.sourceManifestFingerprint",
    ),
    productionScopeFingerprint: normalizeSha(
      closureMetadataString(dudu, "productionScopeFingerprint"),
      "closure.duduIdentity.productionScopeFingerprint",
    ),
    contractSha256: normalizeSha(
      closureMetadataString(dudu, "contractSha256"),
      "closure.duduIdentity.contractSha256",
    ),
    importReceiptFingerprint: normalizeSha(
      closureMetadataString(dudu, "importReceiptFingerprint"),
      "closure.duduIdentity.importReceiptFingerprint",
    ),
    registrationFingerprint: normalizeSha(
      closureMetadataString(dudu, "registrationFingerprint"),
      "closure.duduIdentity.registrationFingerprint",
    ),
  };
  const productionRoot = absoluteClosurePath(metadata, "productionRoot");
  const builderRelativePath = normalizeRelative(
    closureMetadataString(metadata, "builderRelativePath"),
    "closure.builderRelativePath",
  );
  const sourceSpecRelativePath = normalizeRelative(
    closureMetadataString(metadata, "sourceSpecRelativePath"),
    "closure.sourceSpecRelativePath",
  );
  const outputRootRelativePath = normalizeRelative(
    closureMetadataString(metadata, "outputRootRelativePath"),
    "closure.outputRootRelativePath",
  );
  const packageRelativePath = normalizeRelative(
    closureMetadataString(metadata, "packageRelativePath"),
    "closure.packageRelativePath",
  );
  const rawRelativePath = normalizeRelative(
    closureMetadataString(metadata, "rawRelativePath"),
    "closure.rawRelativePath",
  );
  const builderFile = closureFileByRole(closure, "builder");
  const fontFile = closureFileByRole(closure, "font");
  const sourceSpecFile = closureFileByRole(closure, "source-spec");
  const rawFile = closureFileByRole(closure, "raw");
  const labeledFile = closureFileByRole(closure, "labeled");
  const unexpectedRoles = closure.closure.entries
    .filter((file) => !["builder", "font", "source-spec", "raw", "labeled", "dependency"].includes(file.role));
  if (unexpectedRoles.length > 0
    || builderFile.logicalPath !== builderRelativePath
    || builderFile.sha256 !== intent.builderSha256
    || sourceSpecFile.logicalPath !== sourceSpecRelativePath
    || sourceSpecFile.sha256 !== intent.sourceSpecSha256
    || rawFile.logicalPath !== rawRelativePath
    || rawFile.sha256 !== authority.rawSha256
    || labeledFile.sha256 !== authority.labeledSha256) {
    fail("input-drift", `视频包 intent ${intent.intentId} 的 source closure 文件身份漂移。`);
  }
  const pythonPath = absoluteClosurePath(metadata, "pythonPath");
  const pythonSha256 = normalizeSha(
    closureMetadataString(metadata, "pythonSha256"),
    "closure.pythonSha256",
  );
  const magickPath = absoluteClosurePath(metadata, "magickPath");
  const magickSha256 = normalizeSha(
    closureMetadataString(metadata, "magickSha256"),
    "closure.magickSha256",
  );
  const fontPath = absoluteClosurePath(metadata, "fontPath");
  const fontSha256 = normalizeSha(
    closureMetadataString(metadata, "fontSha256"),
    "closure.fontSha256",
  );
  if (fontFile.sha256 !== fontSha256
    || duduIdentity.projectId !== intent.projectId
    || duduIdentity.projectRoot !== projectRoot
    || duduIdentity.sourceProductionRoot !== productionRoot
    || duduIdentity.importReceiptFingerprint !== intent.duduImportReceiptFingerprint
    || duduIdentity.registrationFingerprint !== intent.duduRegistrationFingerprint
    || duduIdentity.sourceManifestFingerprint !== intent.sourceManifestFingerprint
    || duduIdentity.productionScopeFingerprint !== intent.productionScopeFingerprint
    || duduIdentity.contractSha256 !== intent.contractSha256
    || productionRoot !== intent.productionRoot
    || builderRelativePath !== intent.builderRelativePath
    || sourceSpecRelativePath !== intent.sourceSpecRelativePath
    || outputRootRelativePath !== intent.outputRootRelativePath
    || packageRelativePath !== intent.packageRelativePath) {
    fail("input-drift", `视频包 intent ${intent.intentId} 的 source closure metadata 漂移。`);
  }
  const sourceSpecSnapshot: StableFileSnapshot = {
    bytes: sourceSpecFile.bytes,
    sha256: sourceSpecFile.sha256,
    sizeBytes: sourceSpecFile.sizeBytes,
  };
  const sourceSpec = parseJsonSnapshot(sourceSpecSnapshot, "source closure 视频规格").value;
  const dependencies = [
    {
      relativePath: rawRelativePath,
      snapshot: {
        bytes: rawFile.bytes,
        sha256: rawFile.sha256,
        sizeBytes: rawFile.sizeBytes,
      },
    },
    ...closure.files
      .filter((file) => file.role === "dependency")
      .map((file) => ({
        relativePath: file.logicalPath,
        snapshot: {
          bytes: file.bytes,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
        },
      })),
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  if (new Set(dependencies.map((entry) => entry.relativePath)).size !== dependencies.length) {
    fail("storage-invalid", "source closure dependencies 含重复路径。");
  }
  return {
    sourceKind,
    projectionMode,
    duduIdentity,
    productionRoot,
    builderRelativePath,
    builderPath: path.join(productionRoot, ...builderRelativePath.split("/")),
    builderSha256: builderFile.sha256,
    pythonPath,
    pythonSha256,
    magickPath,
    magickSha256,
    fontPath,
    fontSha256,
    sourceSpecRelativePath,
    sourceSpecPath: path.join(productionRoot, ...sourceSpecRelativePath.split("/")),
    sourceSpecSha256: sourceSpecFile.sha256,
    sourceSpec,
    outputRootRelativePath,
    outputRootPath: path.join(productionRoot, ...outputRootRelativePath.split("/")),
    packageRelativePath,
    packagePath: path.join(productionRoot, ...packageRelativePath.split("/")),
    builderSnapshot: {
      bytes: builderFile.bytes,
      sha256: builderFile.sha256,
      sizeBytes: builderFile.sizeBytes,
    },
    fontSnapshot: {
      bytes: fontFile.bytes,
      sha256: fontFile.sha256,
      sizeBytes: fontFile.sizeBytes,
    },
    sourceSpecSnapshot,
    rawSnapshot: {
      bytes: rawFile.bytes,
      sha256: rawFile.sha256,
      sizeBytes: rawFile.sizeBytes,
    },
    labeledSnapshot: {
      bytes: labeledFile.bytes,
      sha256: labeledFile.sha256,
      sizeBytes: labeledFile.sizeBytes,
    },
    rawRelativePath,
    dependencies,
    ...(managedSource ? { managedSource } : {}),
    sourceClosureFingerprint: closure.closure.fingerprint,
  };
}

export async function initializeStudioVideoPackageLedger(projectRoot: string): Promise<StudioVideoPackageLedgerState> {
  const databasePath = await generationDatabasePath(projectRoot);
  const db = openDatabase(databasePath, true);
  try {
    return {
      schemaVersion: 1,
      databasePath,
      generationLedgerReused: true,
      counts: {
        intents: Number((db.prepare("SELECT COUNT(*) AS count FROM studio_video_package_export_intents").get() as { count: number }).count),
        verifyReceipts: Number((db.prepare("SELECT COUNT(*) AS count FROM studio_video_package_verify_receipts").get() as { count: number }).count),
        operationAliases: Number((db.prepare("SELECT COUNT(*) AS count FROM studio_video_package_operation_aliases").get() as { count: number }).count),
        publicationIntents: Number((db.prepare("SELECT COUNT(*) AS count FROM studio_video_package_publication_intents").get() as { count: number }).count),
        publicationReceipts: Number((db.prepare("SELECT COUNT(*) AS count FROM studio_video_package_publication_receipts").get() as { count: number }).count),
      },
    };
  } finally {
    db.close();
  }
}

/** command-bus durable reconciliation 专用，只读解析 operationId→intent/alias。 */
export async function readStudioVideoPackageExportIntentByOperationId(
  projectRoot: string,
  operationIdValue: string,
): Promise<StudioVideoPackageExportIntent | null> {
  const operationId = normalizeId(operationIdValue, "operationId");
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const databasePath = await generationDatabasePathReadOnly(shell.paths.root);
  const snapshot = await openSqliteReadOnlySnapshot(databasePath, "video package operation ledger");
  try {
    assertSchema(snapshot.database);
    const aliasRow = snapshot.database.prepare("SELECT * FROM studio_video_package_operation_aliases WHERE operation_id=?")
      .get(operationId) as unknown as OperationAliasRow | undefined;
    const operationRow = snapshot.database.prepare("SELECT * FROM studio_video_package_export_intents WHERE operation_id=?")
      .get(operationId) as unknown as IntentRow | undefined;
    if (aliasRow && operationRow) fail("storage-invalid", `operationId=${operationId} 同时占用 intent 与 alias。`);
    if (operationRow) return intentFromRow(operationRow);
    if (!aliasRow) return null;
    const alias = operationAliasFromRow(aliasRow);
    const intentRow = intentRowById(snapshot.database, alias.intent_id);
    if (!intentRow) fail("storage-invalid", `operationId=${operationId} alias 指向不存在的 intent。`);
    const intent = intentFromRow(intentRow);
    if (alias.input_fingerprint !== intent.inputFingerprint) {
      fail("storage-invalid", `operationId=${operationId} alias 输入指纹与 intent 不一致。`);
    }
    return intent;
  } finally {
    await snapshot.close();
  }
}

export async function prepareStudioVideoPackageExport(
  projectRoot: string,
  input: PrepareStudioVideoPackageExportInput,
): Promise<{ intent: StudioVideoPackageExportIntent; replayed: boolean }> {
  const operationId = normalizeId(input.operationId, "operationId");
  const authority = await resolveAuthority(projectRoot, input.authority);
  if (input.expectedRevision !== undefined
    && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || authority.unitRevision !== input.expectedRevision)) {
    fail(
      "operation-conflict",
      `视频包 authority unit revision ${authority.unitRevision} 与 expectedRevision ${String(input.expectedRevision)} 不一致。`,
    );
  }
  await assertMediaClosure(projectRoot, authority);
  const managedSource = await resolveExpectedManagedSource(
    projectRoot,
    authority,
    input.expectedManagedSource,
  );
  const baseExternal = await resolveExternalInput(
    projectRoot,
    authority,
    undefined,
    managedSource,
  );
  // managed-evidence adapter 自身已在长耗时读取尾部复读 Review Head 与
  // Observation control；这里不得再完整构建第二份 source，否则真实 4 格
  // 工程会稳定越过 MCP 60 秒边界并把已知未落盘请求变成 command unknown。
  // resolveExternalInput 只消费该不可变 source 与 Studio CAS，随后立即冻结闭包。
  const sourceClosureFingerprint = await freezeResolvedExternalInputSourceClosure(
    projectRoot,
    authority,
    baseExternal,
  );
  const semanticInput = {
    ...inputSemantic(authority, baseExternal),
    sourceClosureFingerprint,
  };
  const inputFingerprint = digest({
    schemaVersion: VIDEO_PACKAGE_SCHEMA_VERSION,
    kind: "studio-video-package-export-input" as const,
    ...semanticInput,
  });
  await bindStudioVideoPackageSourceClosure(
    projectRoot,
    inputFingerprint,
    sourceClosureFingerprint,
  ).catch((error: unknown) => {
    throw new StudioVideoPackageError(
      "storage-invalid",
      "视频包 source closure 无法绑定 prepare 输入。",
      [],
      { cause: error },
    );
  });
  const databasePath = await generationDatabasePath(projectRoot);
  const db = openDatabase(databasePath, true);
  try {
    return runTransaction(db, () => {
      const aliasRow = db.prepare("SELECT * FROM studio_video_package_operation_aliases WHERE operation_id=?")
        .get(operationId) as unknown as OperationAliasRow | undefined;
      const operationRow = db.prepare("SELECT * FROM studio_video_package_export_intents WHERE operation_id=?")
        .get(operationId) as unknown as IntentRow | undefined;
      if (aliasRow && operationRow) fail("storage-invalid", `operationId=${operationId} 同时占用 intent 与 alias。`);
      if (aliasRow) {
        const alias = operationAliasFromRow(aliasRow);
        if (alias.input_fingerprint !== inputFingerprint) {
          fail("operation-conflict", `operationId=${operationId} 已绑定其他视频包输入。`);
        }
        const aliasedIntent = intentRowById(db, alias.intent_id);
        if (!aliasedIntent) fail("storage-invalid", `operationId=${operationId} alias 指向不存在的 intent。`);
        return { intent: intentFromRow(aliasedIntent), replayed: true };
      }
      if (operationRow) {
        const existing = intentFromRow(operationRow);
        if (existing.inputFingerprint !== inputFingerprint) {
          fail("operation-conflict", `operationId=${operationId} 已绑定其他视频包输入。`);
        }
        return { intent: existing, replayed: true };
      }
      const inputRow = db.prepare("SELECT * FROM studio_video_package_export_intents WHERE input_fingerprint=?")
        .get(inputFingerprint) as unknown as IntentRow | undefined;
      if (inputRow) {
        const existing = intentFromRow(inputRow);
        const createdAt = new Date().toISOString();
        const aliasSemantic = {
          operationId,
          inputFingerprint,
          intentId: existing.intentId,
          createdAt,
        };
        db.prepare(`INSERT INTO studio_video_package_operation_aliases(
          operation_id, input_fingerprint, intent_id, created_at, fingerprint
        ) VALUES(?, ?, ?, ?, ?)`).run(
          operationId,
          inputFingerprint,
          existing.intentId,
          createdAt,
          digest(aliasSemantic),
        );
        return { intent: existing, replayed: true };
      }

      const external = baseExternal;
      const packageRelativePath = external.packageRelativePath;
      const pendingPublicationRow = db.prepare(`
        SELECT publication.*
        FROM studio_video_package_publication_intents publication
        LEFT JOIN studio_video_package_publication_receipts receipt
          ON receipt.publication_id=publication.publication_id
        WHERE publication.production_root=?
          AND publication.package_relative_path=?
          AND receipt.publication_id IS NULL
        ORDER BY publication.sequence ASC
        LIMIT 1
      `).get(
        external.productionRoot,
        external.packageRelativePath,
      ) as unknown as PublicationIntentRow | undefined;
      if (pendingPublicationRow) {
        const pending = publicationIntentFromRow(pendingPublicationRow);
        fail(
          "destination-conflict",
          `视频包目标存在未完成 publication，禁止创建新的 export successor：${pending.publicationId}`,
        );
      }
      const destinationRows = db.prepare(`
        SELECT * FROM studio_video_package_export_intents
        WHERE production_root=? AND package_relative_path=?
        ORDER BY sequence ASC
      `).all(external.productionRoot, external.packageRelativePath) as unknown as IntentRow[];
      let supersedesIntentId: string | null = null;
      for (const [destinationIndex, destinationRow] of destinationRows.entries()) {
        const existing = intentFromRow(destinationRow);
        if (existing.supersedesIntentId !== supersedesIntentId) {
          fail(
            "storage-invalid",
            `视频包目标 ${external.packageRelativePath} 的 intent 换代链不连续。`,
            [`intentId=${existing.intentId}`, `expectedSupersedes=${supersedesIntentId ?? "null"}`],
          );
        }
        const existingReceiptRow = receiptRowByIntent(db, existing.intentId);
        if (!existingReceiptRow) {
          const alreadySuperseded = destinationIndex < destinationRows.length - 1;
          const sameImmutableAuthority = existing.projectId === authority.projectId
            && existing.authorityKind === authority.authorityKind
            && existing.authorityId === authority.authorityId
            && existing.authorityFingerprint === authority.authorityFingerprint
            && existing.packId === authority.packId
            && existing.packFingerprint === authority.packFingerprint
            && existing.targetKey === authority.targetKey
            && existing.unitId === authority.unitId
            && existing.unitRevision === authority.unitRevision
            && existing.generationRunId === authority.generationRunId
            && existing.rawResultId === authority.rawResultId
            && existing.rawSha256 === authority.rawSha256
            && existing.labeledResultId === authority.labeledResultId
            && existing.labeledSha256 === authority.labeledSha256
            && existing.duduImportReceiptFingerprint === external.duduIdentity.importReceiptFingerprint
            && existing.duduRegistrationFingerprint === external.duduIdentity.registrationFingerprint
            && existing.sourceManifestFingerprint === external.duduIdentity.sourceManifestFingerprint
            && existing.productionScopeFingerprint === external.duduIdentity.productionScopeFingerprint
            && existing.contractSha256 === external.duduIdentity.contractSha256
            && existing.productionRoot === external.productionRoot
            && existing.builderRelativePath === external.builderRelativePath
            && existing.builderSha256 === external.builderSha256
            && existing.outputRootRelativePath === external.outputRootRelativePath
            && existing.packageRelativePath === external.packageRelativePath
            && (existing.schemaVersion !== VIDEO_PACKAGE_SCHEMA_VERSION
              || existing.managedSourceUnitSnapshotFingerprint === managedSource?.unit.unitSnapshotFingerprint);
          const legacySchemaUpgrade = existing.schemaVersion !== VIDEO_PACKAGE_SCHEMA_VERSION;
          const managedEvidenceChanged = Boolean(
            existing.schemaVersion >= PREVIOUS_VIDEO_PACKAGE_SCHEMA_VERSION
            && existing.authorityKind === "studio-review"
            && authority.authorityKind === "studio-review"
            && managedSource
            && existing.managedSourceFingerprint
            && existing.managedSourceFingerprint !== managedSource.fingerprint,
          );
          const sourceClosureChanged = Boolean(
            existing.schemaVersion === VIDEO_PACKAGE_SCHEMA_VERSION
            && existing.sourceClosureFingerprint
            && existing.sourceClosureFingerprint !== sourceClosureFingerprint,
          );
          if (!alreadySuperseded
            && !(sameImmutableAuthority
              && (legacySchemaUpgrade || managedEvidenceChanged || sourceClosureChanged))) {
            fail(
              "destination-conflict",
              `视频包目标 ${external.packageRelativePath} 已有未完成 intent，禁止静默换代。`,
              [
                `blockingIntentId=${existing.intentId}`,
                `sameImmutableAuthority=${sameImmutableAuthority}`,
                `legacySchemaUpgrade=${legacySchemaUpgrade}`,
                `managedEvidenceChanged=${managedEvidenceChanged}`,
                `sourceClosureChanged=${sourceClosureChanged}`,
              ],
            );
          }
          // 已有后继的未完成祖先只参与链连续性验证；当前未完成 Head 只有在
          // Review/raw/pack/目标均未变化、且 managed evidence 已漂移时才允许
          // 产生新的 successor。这样 prepare/build 间 Observation 漂移可恢复，
          // 其他未完成操作仍保持 fail-closed。
          supersedesIntentId = existing.intentId;
          continue;
        }
        const existingReceipt = receiptFromRow(existingReceiptRow);
        const expectedReceiptPath = existingReceipt.storageKind === "managed-evidence"
          ? managedEvidenceRelativePath(existing)
          : existing.packageRelativePath;
        if (existingReceipt.storageRelativePath !== expectedReceiptPath
          || existingReceipt.manifestRelativePath !== `${expectedReceiptPath}/manifest.json`) {
          fail("storage-invalid", `视频包 intent ${existing.intentId} 的 receipt 路径无效。`);
        }
        supersedesIntentId = existing.intentId;
      }
      const createdAt = new Date().toISOString();
      // Python 身份已完整折叠进 inputFingerprint；intent 行保持既有 schema，避免
      // 建立第二份可漂移字段。intent 内容地址通过 inputFingerprint 间接绑定解释器。
      const {
        managedEvidence: _managedEvidence,
        pythonPath: _pythonPath,
        pythonSha256: _pythonSha256,
        magickPath: _magickPath,
        magickSha256: _magickSha256,
        fontPath: _fontPath,
        fontSha256: _fontSha256,
        sourceIdentityKind: _sourceIdentityKind,
        sourceClosureFingerprint: _inputSourceClosureFingerprint,
        ...persistedSemanticInput
      } = semanticInput;
      const observation = managedSource?.evidence.observationControl;
      const managedIntentIdentity = managedSource && observation
        ? {
            managedSourceFingerprint: managedSource.fingerprint,
            managedSourceUnitSnapshotFingerprint: managedSource.unit.unitSnapshotFingerprint,
            observationControlFingerprint: observation.fingerprint,
            observationControlStatus: observation.status,
            observationHeadRevision: observation.headRevision,
            observationId: observation.headId,
            observationHeadFingerprint: observation.headFingerprint,
            observationEvidenceContractVersion: observation.evidenceContractVersion,
            observationEvidenceKind: observation.evidenceKind,
            observationEvidenceSha256: observation.evidenceSha256,
            observationEvidenceLineageFingerprint: observation.evidenceLineageFingerprint,
          }
        : {};
      const identityInput = {
        schemaVersion: VIDEO_PACKAGE_SCHEMA_VERSION,
        kind: "studio-video-package-export-intent" as const,
        operationId,
        inputFingerprint,
        ...persistedSemanticInput,
        ...managedIntentIdentity,
        sourceClosureFingerprint,
        packageRelativePath,
        supersedesIntentId,
        createdAt,
      };
      const intentId = `studio-video-package-intent-${digest(identityInput).slice(0, 40)}`;
      const record = { ...identityInput, intentId };
      const fingerprint = digest(record);
      db.prepare(`
        INSERT INTO studio_video_package_export_intents(
          intent_id, operation_id, input_fingerprint, project_id,
          authority_kind, authority_id, authority_fingerprint,
          pack_id, pack_fingerprint, target_kind, target_key, unit_id, unit_revision, generation_run_id,
          raw_result_id, raw_sha256, labeled_result_id, labeled_sha256,
          dudu_import_receipt_fingerprint, dudu_registration_fingerprint, source_manifest_fingerprint,
          production_scope_fingerprint, contract_sha256,
          production_root, builder_relative_path, builder_sha256,
          source_spec_relative_path, source_spec_sha256, output_root_relative_path, package_relative_path,
          supersedes_intent_id, created_at, fingerprint,
          intent_schema_version, managed_source_fingerprint,
          managed_source_unit_snapshot_fingerprint, observation_control_fingerprint,
          observation_control_status, observation_head_revision, observation_id,
          observation_head_fingerprint, observation_evidence_contract_version,
          observation_evidence_kind, observation_evidence_sha256,
          observation_evidence_lineage_fingerprint,
          intent_contract_version, source_closure_fingerprint
        ) VALUES(
          ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unit-grid', ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          4, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 5, ?
        )
      `).run(
        intentId, operationId, inputFingerprint, authority.projectId,
        authority.authorityKind, authority.authorityId, authority.authorityFingerprint,
        authority.packId, authority.packFingerprint, authority.targetKey, authority.unitId, authority.unitRevision,
        authority.generationRunId, authority.rawResultId, authority.rawSha256, authority.labeledResultId,
        authority.labeledSha256,
        external.duduIdentity.importReceiptFingerprint, external.duduIdentity.registrationFingerprint,
        external.duduIdentity.sourceManifestFingerprint, external.duduIdentity.productionScopeFingerprint,
        external.duduIdentity.contractSha256,
        external.productionRoot, external.builderRelativePath, external.builderSha256,
        external.sourceSpecRelativePath, external.sourceSpecSha256, external.outputRootRelativePath,
        external.packageRelativePath, supersedesIntentId, createdAt, fingerprint,
        managedSource?.fingerprint ?? null,
        managedSource?.unit.unitSnapshotFingerprint ?? null,
        observation?.fingerprint ?? null,
        observation?.status ?? null,
        observation?.headRevision ?? null,
        observation?.headId ?? null,
        observation?.headFingerprint ?? null,
        observation?.evidenceContractVersion ?? null,
        observation?.evidenceKind ?? null,
        observation?.evidenceSha256 ?? null,
        observation?.evidenceLineageFingerprint ?? null,
        sourceClosureFingerprint,
      );
      const inserted = intentRowById(db, intentId);
      if (!inserted) fail("storage-invalid", `视频包 intent ${intentId} 未落盘。`);
      return { intent: intentFromRow(inserted), replayed: false };
    });
  } finally {
    db.close();
  }
}

async function authorityFromIntent(projectRoot: string, intent: StudioVideoPackageExportIntent): Promise<ResolvedAuthority> {
  if (intent.schemaVersion === LEGACY_VIDEO_PACKAGE_SCHEMA_VERSION) {
    fail("input-drift", `视频包 intent ${intent.intentId} 是旧 v3 只读记录，必须重新 prepare 后才能 build。`);
  }
  const authority = await resolveAuthority(projectRoot, intent.authorityKind === "studio-review"
    ? { kind: "studio-review", reviewId: intent.authorityId }
    : { kind: "historical-import", packId: intent.packId });
  // provider 已被 Studio result/call 与派生 sourceSpec SHA 绑定；旧 intent schema
  // 没有独立 provider 列，不能为此建立第二个身份字段。
  const { pack: _pack, provider: _provider, ...expected } = authority;
  const actual = {
    projectId: intent.projectId,
    authorityKind: intent.authorityKind,
    authorityId: intent.authorityId,
    authorityFingerprint: intent.authorityFingerprint,
    packId: intent.packId,
    packFingerprint: intent.packFingerprint,
    targetKey: intent.targetKey,
    unitId: intent.unitId,
    unitRevision: intent.unitRevision,
    generationRunId: intent.generationRunId,
    rawResultId: intent.rawResultId,
    rawSha256: intent.rawSha256,
    labeledResultId: intent.labeledResultId,
    labeledSha256: intent.labeledSha256,
  };
  if (digest(expected) !== digest(actual)) fail("input-drift", `视频包 intent ${intent.intentId} authority 已漂移。`);
  return authority;
}

function expectedManagedSourceFromIntent(
  intent: StudioVideoPackageExportIntent,
): StudioVideoPackageExpectedManagedSource | undefined {
  if (intent.authorityKind === "historical-import") return undefined;
  if (intent.schemaVersion === LEGACY_VIDEO_PACKAGE_SCHEMA_VERSION
    || !intent.managedSourceFingerprint
    || !intent.managedSourceUnitSnapshotFingerprint
    || !intent.observationControlFingerprint
    || !intent.observationControlStatus
    || intent.observationHeadRevision === undefined) {
    fail("input-drift", `视频包 intent ${intent.intentId} 缺少 managed-evidence source 身份。`);
  }
  return {
    adapterKind: "managed-evidence-v1",
    reviewId: intent.authorityId,
    expectedSourceFingerprint: intent.managedSourceFingerprint,
    expectedReviewFingerprint: intent.authorityFingerprint,
    expectedPackFingerprint: intent.packFingerprint,
    expectedUnitSnapshotFingerprint: intent.managedSourceUnitSnapshotFingerprint,
    expectedObservationControlFingerprint: intent.observationControlFingerprint,
    expectedObservationHeadRevision: intent.observationHeadRevision,
    expectedObservationStatus: intent.observationControlStatus,
    expectedObservationHeadId: intent.observationId ?? null,
    expectedObservationHeadFingerprint: intent.observationHeadFingerprint ?? null,
    expectedObservationEvidenceSha256: intent.observationEvidenceSha256 ?? null,
  };
}

function managedSourceIdentityFromIntent(
  intent: StudioVideoPackageExportIntent,
  sourceSpec: Record<string, unknown>,
): ManagedEvidenceVideoPackageSourceSpec {
  const managed = sourceSpec.managed_source;
  if (!managed || typeof managed !== "object" || Array.isArray(managed)) {
    fail("input-drift", `视频包 intent ${intent.intentId} 的冻结 source spec 缺少 managed_source。`);
  }
  const row = managed as Record<string, unknown>;
  if (row.adapter_kind !== "managed-evidence-v1"
    || typeof row.source_id !== "string" || !row.source_id
    || row.source_fingerprint !== intent.managedSourceFingerprint
    || row.unit_snapshot_fingerprint !== intent.managedSourceUnitSnapshotFingerprint
    || row.review_fingerprint !== intent.authorityFingerprint
    || row.pack_fingerprint !== intent.packFingerprint) {
    fail("input-drift", `视频包 intent ${intent.intentId} 的冻结 managed_source 身份漂移。`);
  }
  const observationControl = {
    fingerprint: intent.observationControlFingerprint!,
    status: intent.observationControlStatus!,
    headRevision: intent.observationHeadRevision!,
    headId: intent.observationId ?? null,
    headFingerprint: intent.observationHeadFingerprint ?? null,
    evidenceContractVersion: intent.observationEvidenceContractVersion ?? null,
    evidenceKind: intent.observationEvidenceKind as ManagedEvidenceVideoPackageSourceSpec["evidence"]["observationControl"]["evidenceKind"],
    evidenceSha256: intent.observationEvidenceSha256 ?? null,
    evidenceLineageFingerprint: intent.observationEvidenceLineageFingerprint ?? null,
  };
  // v5 build 只需要闭包中已经冻结的 managed-source 身份投影；完整 panels、
  // references 与 continuity 已逐字进入 sourceSpec，不在 build 阶段重新发明。
  return {
    adapterKind: "managed-evidence-v1",
    id: row.source_id,
    fingerprint: intent.managedSourceFingerprint!,
    projectId: intent.projectId,
    unit: {
      unitId: intent.unitId,
      unitRevision: intent.unitRevision,
      unitSnapshotFingerprint: intent.managedSourceUnitSnapshotFingerprint!,
    },
    evidence: {
      reviewFingerprint: intent.authorityFingerprint,
      packFingerprint: intent.packFingerprint,
      observationControl,
    },
  } as ManagedEvidenceVideoPackageSourceSpec;
}

async function externalFromIntent(
  projectRoot: string,
  intent: StudioVideoPackageExportIntent,
  authority: ResolvedAuthority,
): Promise<ResolvedExternalInput> {
  if (intent.schemaVersion === LEGACY_VIDEO_PACKAGE_SCHEMA_VERSION) {
    fail("input-drift", `视频包 intent ${intent.intentId} 是旧 v3 只读记录。`);
  }
  const basePackageRelativePath = `${intent.outputRootRelativePath}/${authority.unitId}`;
  const duduFixedPath = intent.outputRootRelativePath === OUTPUT_ROOT_RELATIVE_PATH
    && intent.builderRelativePath === BUILDER_RELATIVE_PATH;
  const managedFixedPath = intent.schemaVersion === VIDEO_PACKAGE_SCHEMA_VERSION
    && intent.outputRootRelativePath === MANAGED_OUTPUT_ROOT_RELATIVE_PATH
    && intent.builderRelativePath === MANAGED_CORE_BUILDER_RELATIVE_PATH;
  if ((!duduFixedPath && !managedFixedPath) || intent.packageRelativePath !== basePackageRelativePath) {
    fail("input-drift", `视频包 intent ${intent.intentId} 的固定单层目录身份无效。`);
  }
  const expectedManagedSource = expectedManagedSourceFromIntent(intent);
  let managedSource: ManagedEvidenceVideoPackageSourceSpec | undefined;
  let external: ResolvedExternalInput;
  if (intent.schemaVersion === VIDEO_PACKAGE_SCHEMA_VERSION) {
    external = await resolvedExternalInputFromSourceClosure(
      projectRoot,
      intent,
      authority,
      undefined,
    );
    if (intent.authorityKind === "studio-review") {
      managedSource = managedSourceIdentityFromIntent(intent, external.sourceSpec);
      external = { ...external, managedSource };
      await assertIntentManagedSourceCurrent(
        projectRoot,
        intent,
        authority,
        intent.managedSourceFingerprint,
      );
    }
  } else {
    managedSource = await resolveExpectedManagedSource(
      projectRoot,
      authority,
      expectedManagedSource,
    );
    external = await resolveExternalInput(
      projectRoot,
      authority,
      intent.packageRelativePath,
      managedSource,
    );
  }
  if (external.builderSha256 !== intent.builderSha256 || external.sourceSpecSha256 !== intent.sourceSpecSha256
    || external.packageRelativePath !== intent.packageRelativePath
    || external.productionRoot !== intent.productionRoot
    || external.builderRelativePath !== intent.builderRelativePath
    || external.sourceSpecRelativePath !== intent.sourceSpecRelativePath
    || external.duduIdentity.importReceiptFingerprint !== intent.duduImportReceiptFingerprint
    || external.duduIdentity.registrationFingerprint !== intent.duduRegistrationFingerprint
    || external.duduIdentity.sourceManifestFingerprint !== intent.sourceManifestFingerprint
    || external.duduIdentity.productionScopeFingerprint !== intent.productionScopeFingerprint
    || external.duduIdentity.contractSha256 !== intent.contractSha256) {
    fail("input-drift", `视频包 intent ${intent.intentId} 的 builder/spec/path 已漂移。`);
  }
  const expectedFingerprint = digest({
    schemaVersion: intent.schemaVersion,
    kind: "studio-video-package-export-input" as const,
    ...inputSemantic(authority, external),
    ...(intent.schemaVersion === VIDEO_PACKAGE_SCHEMA_VERSION
      ? { sourceClosureFingerprint: intent.sourceClosureFingerprint }
      : {}),
  });
  if (expectedFingerprint !== intent.inputFingerprint) {
    fail("input-drift", `视频包 intent ${intent.intentId} 的完整输入指纹已漂移。`);
  }
  if (intent.schemaVersion !== VIDEO_PACKAGE_SCHEMA_VERSION) {
    const revalidatedManagedSource = await resolveExpectedManagedSource(
      projectRoot,
      authority,
      expectedManagedSource,
    );
    if (revalidatedManagedSource?.fingerprint !== managedSource?.fingerprint) {
      fail("input-drift", `视频包 intent ${intent.intentId} 验证期间 managed source 已漂移。`);
    }
  }
  return external;
}

async function legacyPublicationPriorContext(
  projectRoot: string,
  intent: StudioVideoPackageExportIntent,
): Promise<{
  authority: ManifestValidationAuthority;
  external: PublicationPriorExternal;
}> {
  if (intent.schemaVersion !== LEGACY_VIDEO_PACKAGE_SCHEMA_VERSION) {
    fail("storage-invalid", `legacy publication prior ${intent.intentId} 不是 v3。`);
  }
  const shell = await inspectManagedProject(projectRoot);
  const duduIdentity = await getActiveDuduReadonlyProjectIdentity(shell.paths.root);
  const managedRoot = path.resolve(shell.paths.root);
  const productionRoot = await canonicalDirectory(
    duduIdentity.sourceProductionRoot,
    "legacy publication sourceProductionRoot",
  );
  if (path.resolve(duduIdentity.projectRoot) !== managedRoot
    || duduIdentity.projectId !== intent.projectId
    || productionRoot !== intent.productionRoot
    || duduIdentity.importReceiptFingerprint !== intent.duduImportReceiptFingerprint
    || duduIdentity.registrationFingerprint !== intent.duduRegistrationFingerprint
    || duduIdentity.sourceManifestFingerprint !== intent.sourceManifestFingerprint
    || duduIdentity.productionScopeFingerprint !== intent.productionScopeFingerprint
    || duduIdentity.contractSha256 !== intent.contractSha256) {
    fail("input-drift", `旧 v3 prior ${intent.intentId} 的活动 Dudu 身份已漂移。`);
  }
  const expectedPackageRelativePath = `${OUTPUT_ROOT_RELATIVE_PATH}/${intent.unitId}`;
  if (intent.builderRelativePath !== BUILDER_RELATIVE_PATH
    || intent.outputRootRelativePath !== OUTPUT_ROOT_RELATIVE_PATH
    || intent.packageRelativePath !== expectedPackageRelativePath) {
    fail("input-drift", `旧 v3 prior ${intent.intentId} 的固定生产路径无效。`);
  }
  const [builderPath, sourceSpecPath, pack] = await Promise.all([
    assertSafeRelativeChain(productionRoot, intent.builderRelativePath, "file"),
    assertSafeRelativeChain(productionRoot, intent.sourceSpecRelativePath, "file"),
    readStudioUnitGridGenerationFrozenPack(shell.paths.root, intent.packId),
  ]);
  if (!pack || pack.fingerprint !== intent.packFingerprint
    || pack.target.targetKind !== "unit-grid"
    || `unit-grid:${pack.target.unitId}` !== intent.targetKey
    || pack.target.unitId !== intent.unitId
    || pack.target.unitRevision !== intent.unitRevision) {
    fail("input-drift", `旧 v3 prior ${intent.intentId} 的冻结包身份已漂移。`);
  }
  await assertStudioUnitGridGenerationFreezePackCurrent(shell.paths.root, pack);
  const [builderSnapshot, sourceSpecSnapshot] = await Promise.all([
    readStableFile(builderPath),
    readJsonSnapshot(sourceSpecPath, "旧 v3 prior 视频规格"),
  ]);
  if (builderSnapshot.sha256 !== intent.builderSha256
    || sourceSpecSnapshot.sha256 !== intent.sourceSpecSha256) {
    fail("input-drift", `旧 v3 prior ${intent.intentId} 的 builder/spec 内容已漂移。`);
  }
  const sourceSpec = sourceSpecSnapshot.value;
  if (sourceSpec.unit_id !== intent.unitId
    || normalizeSha(sourceSpec.raw_sha256, "legacyPublication.raw_sha256") !== intent.rawSha256) {
    fail("input-drift", `旧 v3 prior ${intent.intentId} 的视频规格未绑定冻结 raw。`);
  }
  const rawRelativePath = productionFileRelative(
    sourceSpec.raw_path,
    "legacyPublication.raw_path",
  );
  const rawPath = await assertSafeRelativeChain(productionRoot, rawRelativePath, "file");
  const rawSnapshot = await readStableFile(rawPath);
  if (rawSnapshot.sha256 !== intent.rawSha256) {
    fail("input-drift", `旧 v3 prior ${intent.intentId} 的 raw 内容已漂移。`);
  }
  const packagePath = path.join(productionRoot, ...intent.packageRelativePath.split("/"));
  if (!pathInside(packagePath, productionRoot)) {
    fail("storage-invalid", `旧 v3 prior ${intent.intentId} 的视频包目录逃逸生产根。`);
  }
  return {
    authority: {
      pack,
      unitId: intent.unitId,
      rawSha256: intent.rawSha256,
      labeledSha256: intent.labeledSha256,
    },
    external: {
      sourceKind: "dudu-readonly",
      duduIdentity,
      productionRoot,
      packagePath,
      packageRelativePath: intent.packageRelativePath,
      rawRelativePath,
      rawSnapshot,
      sourceSpec,
      sourceSpecRelativePath: intent.sourceSpecRelativePath,
      sourceSpecSha256: intent.sourceSpecSha256,
    },
  };
}

async function assertIntentManagedSourceCurrent(
  projectRoot: string,
  intent: StudioVideoPackageExportIntent,
  authority: ResolvedAuthority | undefined,
  expectedFingerprint: string | undefined,
): Promise<void> {
  if (intent.schemaVersion === VIDEO_PACKAGE_SCHEMA_VERSION
    && intent.authorityKind === "studio-review") {
    try {
      const [unit] = await Promise.all([
        getStudioProductionUnitSnapshot(projectRoot, intent.unitId),
        (async () => {
          // Review/result/Observation 与视频包 intent/receipt 共用同一 generation
          // ledger。直接在一个 query-only SQLite 快照里复核 Head CAS，既比
          // 递归调用完整 Review + Observation 控制面更强地绑定同一时点，
          // 也避免 Observation 为验证裁图 lineage 再反向重验视频包的循环。
          const databasePath = await generationDatabasePathReadOnly(projectRoot);
          const ledger = await openSqliteReadOnlySnapshot(databasePath, "managed video source currentness");
          try {
            assertReceiptAuthorityCurrentInTransaction(ledger.database, intent);
          } finally {
            await ledger.close();
          }
        })(),
      ]);
      if (!unit
        || unit.fingerprint !== intent.managedSourceUnitSnapshotFingerprint
        || (authority !== undefined
          && (authority.pack.unitSnapshotFingerprint !== intent.managedSourceUnitSnapshotFingerprint
            || authority.pack.fingerprint !== intent.packFingerprint))
        || expectedFingerprint !== intent.managedSourceFingerprint) {
        fail("input-drift", `视频包 intent ${intent.intentId} 的 managed source CAS 在构建期间漂移。`);
      }
      return;
    } catch (error) {
      if (error instanceof StudioVideoPackageError) throw error;
      throw new StudioVideoPackageError(
        "input-drift",
        `视频包 intent ${intent.intentId} 的 managed source CAS 在构建期间不可复核。`,
        [],
        { cause: error },
      );
    }
  }
  if (!authority) {
    fail("input-drift", `视频包 intent ${intent.intentId} 的旧 managed source 缺少 authority。`);
  }
  let source: ManagedEvidenceVideoPackageSourceSpec | undefined;
  try {
    source = await resolveExpectedManagedSource(
      projectRoot,
      authority,
      expectedManagedSourceFromIntent(intent),
    );
  } catch (error) {
    if (error instanceof StudioVideoPackageError) throw error;
    throw new StudioVideoPackageError(
      "input-drift",
      `视频包 intent ${intent.intentId} 的 managed source 在构建期间漂移。`,
      [],
      { cause: error },
    );
  }
  if (source?.fingerprint !== expectedFingerprint) {
    fail("input-drift", `视频包 intent ${intent.intentId} 的 managed source 在构建期间漂移。`);
  }
}

async function assertIntentInputClosureCurrent(
  projectRoot: string,
  intent: StudioVideoPackageExportIntent,
  authority: ResolvedAuthority,
): Promise<void> {
  try {
    // externalFromIntent 会从当前文件系统重新绑定 Dudu 身份、冻结依赖、
    // builder/spec、工具链以及 Studio raw/labeled CAS，并重新计算完整
    // inputFingerprint；不能用构建开始时保存的 ResolvedExternalInput 代替。
    await externalFromIntent(projectRoot, intent, authority);
  } catch (error) {
    if (error instanceof StudioVideoPackageError && error.code === "input-drift") throw error;
    throw new StudioVideoPackageError(
      "input-drift",
      `视频包 intent ${intent.intentId} 的完整输入闭包在构建期间漂移。`,
      error instanceof Error ? [error.message] : [],
      { cause: error },
    );
  }
}

async function waitForManagedSourceCasTestBarrier(
  managedRoot: string,
  intent: StudioVideoPackageExportIntent,
  environmentName:
    | "P30_TEST_VIDEO_PACKAGE_FINAL_CAS_BARRIER"
    | "P30_TEST_VIDEO_PACKAGE_RECEIPT_CAS_BARRIER"
    | "P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER",
  label: string,
): Promise<void> {
  const barrierBaseValue = process.env[environmentName];
  if (process.env.NODE_ENV !== "test" || !barrierBaseValue) return;
  const barrierBase = path.resolve(barrierBaseValue);
  if (path.dirname(barrierBase) !== managedRoot || !pathInside(barrierBase, managedRoot)) {
    fail("storage-invalid", `视频包测试 ${label} barrier 必须位于受管项目根目录。`);
  }
  const reachedPath = `${barrierBase}.reached`;
  const releasePath = `${barrierBase}.release`;
  await writeFile(
    reachedPath,
    `${JSON.stringify({ intentId: intent.intentId, fingerprint: intent.fingerprint })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const deadline = Date.now() + 30_000;
  while (!(await lstat(releasePath).catch(() => null))) {
    if (Date.now() >= deadline) fail("builder-failed", `视频包测试 ${label} barrier 等待 release 超时。`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForFinalManagedSourceCasTestBarrier(
  managedRoot: string,
  intent: StudioVideoPackageExportIntent,
): Promise<void> {
  await waitForManagedSourceCasTestBarrier(
    managedRoot,
    intent,
    "P30_TEST_VIDEO_PACKAGE_FINAL_CAS_BARRIER",
    "final CAS",
  );
}

async function waitForReceiptManagedSourceCasTestBarrier(
  managedRoot: string,
  intent: StudioVideoPackageExportIntent,
): Promise<void> {
  await waitForManagedSourceCasTestBarrier(
    managedRoot,
    intent,
    "P30_TEST_VIDEO_PACKAGE_RECEIPT_CAS_BARRIER",
    "receipt CAS",
  );
}

async function waitForReceiptPostCasBeforeTransactionTestBarrier(
  managedRoot: string,
  intent: StudioVideoPackageExportIntent,
): Promise<void> {
  await waitForManagedSourceCasTestBarrier(
    managedRoot,
    intent,
    "P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER",
    "receipt post-CAS/pre-transaction",
  );
}

function runExecutable(
  executable: string,
  args: string[],
  phase: "build" | "verify" | "install",
  environment: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: environment,
    });
    const maxBytes = 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let outputOverflow = false;
    let timedOut = false;
    let settled = false;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    };
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
      outputOverflow = true;
      killGroup("SIGTERM");
      hardKill ??= setTimeout(() => killGroup("SIGKILL"), 1_000);
      hardKill.unref();
      return next.slice(0, maxBytes);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timeout = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      hardKill ??= setTimeout(() => killGroup("SIGKILL"), 1_000);
      hardKill.unref();
    }, EXECUTION_TIMEOUT_MS);
    timeout.unref();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      reject(new StudioVideoPackageError(
        phase === "verify" ? "verify-failed" : phase === "install" ? "destination-conflict" : "builder-failed",
        `视频包 ${phase} 进程无法启动。`,
        [error.message],
        { cause: error },
      ));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      if (timedOut || outputOverflow || code !== 0) {
        reject(new StudioVideoPackageError(
          phase === "verify" ? "verify-failed" : phase === "install" ? "destination-conflict" : "builder-failed",
          `视频包 ${phase} 进程失败。`,
          [
            timedOut ? `timeout=${EXECUTION_TIMEOUT_MS}ms` : "",
            outputOverflow ? `output-limit=${maxBytes}` : "",
            `exit=${String(code)} signal=${String(signal)}`,
            stderr.trim(),
          ].filter(Boolean),
        ));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function assertVideoBuilderToolchainIdentity(
  external: ResolvedExternalInput,
  builderPath: string,
): Promise<void> {
  const [pythonCanonical, magickCanonical, python, magick, builder] = await Promise.all([
    realpath(external.pythonPath),
    realpath(external.magickPath),
    readStableFile(external.pythonPath),
    readStableFile(external.magickPath),
    readStableFile(builderPath),
  ]).catch((error: unknown) => {
    throw new StudioVideoPackageError("input-drift", "视频包 builder 工具链无法重新绑定。", [], { cause: error });
  });
  if (pythonCanonical !== external.pythonPath || magickCanonical !== external.magickPath
    || python.sha256 !== external.pythonSha256
    || magick.sha256 !== external.magickSha256
    || builder.sha256 !== external.builderSha256
    || external.fontSnapshot.sha256 !== external.fontSha256
    || createHash("sha256").update(external.fontSnapshot.bytes).digest("hex") !== external.fontSha256) {
    fail("input-drift", "视频包 builder/Python/ImageMagick/字体在执行边界发生漂移。 ");
  }
  if (!external.sourceClosureFingerprint) {
    const [fontCanonical, font] = await Promise.all([
      realpath(external.fontPath),
      readStableFile(external.fontPath),
    ]).catch((error: unknown) => {
      throw new StudioVideoPackageError("input-drift", "视频包字体无法重新绑定。", [], { cause: error });
    });
    if (fontCanonical !== external.fontPath || font.sha256 !== external.fontSha256) {
      fail("input-drift", "视频包字体在执行边界发生漂移。 ");
    }
  }
}

async function runVideoBuilderExecutable(
  external: ResolvedExternalInput,
  builderPath: string,
  args: string[],
  phase: "build" | "verify",
): Promise<{ stdout: string; stderr: string }> {
  await assertVideoBuilderToolchainIdentity(external, builderPath);
  try {
    return await runExecutable(
      external.pythonPath,
      ["-I", "-S", builderPath, ...args],
      phase,
      videoBuilderEnvironment(external, builderPath),
    );
  } finally {
    await assertVideoBuilderToolchainIdentity(external, builderPath);
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function writeCoreManagedVideoPackage(
  external: ResolvedExternalInput,
  authority: ResolvedAuthority,
  runtime: SnapshotRuntime,
): Promise<void> {
  const rawPath = runtime.dependencyPaths.get(external.rawRelativePath);
  if (!rawPath) fail("storage-invalid", "通用受管视频包 runtime 缺少 raw 快照。");
  const spec = JSON.parse(JSON.stringify(external.sourceSpec)) as Record<string, unknown>;
  const panels = spec.panels;
  const shots = spec.shots;
  if (!Array.isArray(panels) || !Array.isArray(shots) || panels.length !== shots.length) {
    fail("builder-failed", "通用受管视频规格 panels/shots 无效。");
  }
  const packagePath = path.join(runtime.outputRoot, authority.unitId);
  await mkdir(packagePath, { mode: 0o700 });
  if ((await readdir(packagePath)).length > 0) {
    fail("builder-failed", "通用受管视频包隔离目标不是空目录。");
  }
  const generated: Array<{ path: string; sha256: string }> = [];
  const writeGenerated = async (name: string, bytes: Buffer): Promise<string> => {
    if (path.basename(name) !== name) fail("builder-failed", `通用受管视频包文件名无效：${name}`);
    const target = path.join(packagePath, name);
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    const snapshot = await readStableFile(target);
    generated.push({ path: name, sha256: snapshot.sha256 });
    return snapshot.sha256;
  };
  for (const [offset, panelValue] of panels.entries()) {
    const panel = panelValue as Record<string, unknown>;
    const shot = shots[offset] as Record<string, unknown>;
    const rect = panel.rect as Record<string, unknown>;
    const panelId = String(panel.id);
    const width = Number(rect.width);
    const height = Number(rect.height);
    const cropName = `${authority.unitId}-${panelId}_raw.png`;
    const cropBytes = await sharp(external.rawSnapshot.bytes, {
      failOn: "error",
      limitInputPixels: MAX_VIDEO_IMAGE_PIXELS,
    })
      .extract({
        left: Number(rect.x),
        top: Number(rect.y),
        width,
        height,
      })
      .ensureAlpha()
      .png({ compressionLevel: 9 })
      .toBuffer();
    const cropSha256 = await writeGenerated(cropName, cropBytes);
    const inputPlan = shot.i2v_input as Record<string, unknown>;
    inputPlan.storyboard_crop_path = cropName;
    inputPlan.storyboard_crop_sha256 = cropSha256;
    inputPlan.start_frame_path = cropName;
    inputPlan.start_frame_sha256 = cropSha256;
    inputPlan.end_frame_path = null;
    inputPlan.end_frame_sha256 = null;

    const captionLines = Array.isArray(shot.caption_lines)
      ? shot.caption_lines.map((line) => String(line))
      : [];
    const captionHeight = Math.max(120, Math.min(512, Number(spec.caption_height) || 220));
    const fontSize = width >= 800 ? 25 : 19;
    const text = captionLines.slice(0, 4).map((line, lineIndex) =>
      `<text x="20" y="${36 + lineIndex * (fontSize + 12)}">${escapeXml(line)}</text>`).join("");
    const captionSvg = Buffer.from(
      `<svg width="${width}" height="${captionHeight}" xmlns="http://www.w3.org/2000/svg">`
      + `<rect width="100%" height="100%" fill="#101820"/>`
      + `<g fill="#F3F6F8" font-family="STHeiti, PingFang SC, sans-serif" font-size="${fontSize}">${text}</g>`
      + "</svg>",
      "utf8",
    );
    const captionBytes = await sharp(captionSvg).png({ compressionLevel: 9 }).toBuffer();
    const labeledBytes = await sharp({
      create: {
        width,
        height: height + captionHeight,
        channels: 4,
        background: { r: 16, g: 24, b: 32, alpha: 1 },
      },
    }).composite([
      { input: cropBytes, left: 0, top: 0 },
      { input: captionBytes, left: 0, top: height },
    ]).png({ compressionLevel: 9 }).toBuffer();
    await writeGenerated(`${authority.unitId}-${panelId}_labeled.png`, labeledBytes);

    const duration = Number(shot.duration_sec);
    const markdown = [
      `# ${authority.unitId}-${panelId} 图生视频指令`,
      "",
      `- 时码：\`${String(shot.timeline_start)}—${String(shot.timeline_end)}\`；时长：\`${duration}s\``,
      "",
      "## 图生视频中文提示词",
      "",
      String(shot.video_prompt),
      "",
      "## 固定禁止项",
      "",
      String(shot.negative_prompt),
      "",
    ].join("\n");
    await writeGenerated(
      `${authority.unitId}-${panelId}_video.md`,
      Buffer.from(markdown, "utf8"),
    );
  }
  await writeGenerated(`${authority.unitId}_labeled.png`, external.labeledSnapshot.bytes);
  const videoJsonBytes = Buffer.from(serializeStudioCanonicalJsonPretty(spec), "utf8");
  await writeGenerated(`${authority.unitId}_video.json`, videoJsonBytes);
  const manifest = {
    manifest_version: "2.0",
    spec_schema_version: spec.schema_version,
    builder: "core-managed-video-package-v1",
    unit_id: authority.unitId,
    status: spec.status,
    i2v_readiness: (spec.target_video_model_gate as Record<string, unknown>).sample_status,
    source_spec: {
      path: external.sourceSpecRelativePath,
      sha256: external.sourceSpecSha256,
    },
    raw: {
      path: external.rawRelativePath,
      sha256: authority.rawSha256,
    },
    files: generated,
  };
  await writeFile(
    path.join(packagePath, "manifest.json"),
    serializeStudioCanonicalJsonPretty(manifest),
    { flag: "wx", mode: 0o600 },
  );
}

async function buildVideoPackageInRuntime(
  external: ResolvedExternalInput,
  authority: ResolvedAuthority,
  runtime: SnapshotRuntime,
): Promise<void> {
  if (external.sourceKind === "managed-project") {
    await writeCoreManagedVideoPackage(external, authority, runtime);
    return;
  }
  await runVideoBuilderExecutable(external, runtime.builderPath, [
    "build",
    "--spec",
    runtime.sourceSpecPath,
    "--output-root",
    runtime.outputRoot,
    "--font",
    runtime.fontPath,
  ], "build");
}

async function renameDirectoryNoReplace(source: string, destination: string): Promise<void> {
  const sourceParent = path.dirname(source);
  const destinationParent = path.dirname(destination);
  if (path.basename(source) === source || path.basename(destination) === destination) {
    fail("storage-invalid", "视频包 no-replace rename 必须使用绝对路径。 ");
  }
  for (const [directory, field] of [[sourceParent, "sourceParent"], [destinationParent, "destinationParent"]] as const) {
    const canonical = await canonicalDirectory(directory, `no-replace.${field}`);
    if (canonical !== directory) fail("storage-invalid", `视频包 no-replace ${field} 身份不稳定。`);
  }
  const [sourceParentIdentity, destinationParentIdentity] = await Promise.all([
    lstat(sourceParent, { bigint: true }),
    lstat(destinationParent, { bigint: true }),
  ]);
  await runExecutable(SAFE_RENAME_PYTHON, [
    "-I",
    "-S",
    "-c",
    SAFE_RENAME_SCRIPT,
    sourceParent,
    path.basename(source),
    destinationParent,
    path.basename(destination),
    sourceParentIdentity.dev.toString(),
    sourceParentIdentity.ino.toString(),
    destinationParentIdentity.dev.toString(),
    destinationParentIdentity.ino.toString(),
  ], "install", isolatedSubprocessEnvironment());
}

function videoPackageFileMaxBytes(name: string): number {
  if (name.endsWith(".png")) return MAX_VIDEO_PACKAGE_FILE_BYTES;
  if (name.endsWith(".md")) return MAX_VIDEO_MARKDOWN_BYTES;
  if (name.endsWith(".json")) return MAX_JSON_BYTES;
  return 0;
}

async function assertVideoPackageSnapshotsCurrent(
  packagePath: string,
  manifestSnapshot: StableFileSnapshot,
  fileSnapshots: ReadonlyMap<string, StableFileSnapshot>,
  expectedNames: readonly string[],
): Promise<void> {
  const currentManifest = await readStableFile(path.join(packagePath, "manifest.json"), MAX_JSON_BYTES);
  if (currentManifest.sha256 !== manifestSnapshot.sha256
    || currentManifest.sizeBytes !== manifestSnapshot.sizeBytes) {
    fail("verify-failed", "视频包 manifest 在机械验收期间发生替换。 ");
  }
  for (const [name, expected] of fileSnapshots) {
    const maxBytes = videoPackageFileMaxBytes(name);
    const current = await readStableFile(path.join(packagePath, name), maxBytes);
    if (current.sha256 !== expected.sha256 || current.sizeBytes !== expected.sizeBytes) {
      fail("verify-failed", `视频包文件在机械验收期间发生替换：${name}`);
    }
  }
  const actualEntries = await readdir(packagePath, { withFileTypes: true });
  const actualNames: string[] = [];
  for (const entry of actualEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) fail("verify-failed", `视频包含非普通文件：${entry.name}`);
    actualNames.push(entry.name);
  }
  actualNames.sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    fail("verify-failed", "视频包文件集在机械验收期间发生变化。", [
      `expected=${expectedNames.join(",")}`,
      `actual=${actualNames.join(",")}`,
    ]);
  }
}

async function validateManifest(
  external: ManifestValidationExternal,
  authority: ManifestValidationAuthority,
  packagePath = external.packagePath,
  manifestBaseRelativePath = external.packageRelativePath,
): Promise<{
  manifestRelativePath: string;
  manifestSha256: string;
  manifestFingerprint: string;
  files: StudioVideoPackageManifestFile[];
  specSchemaVersion: "1.0" | "2.0";
  packageStatus: string;
  i2vReadiness: string;
  mechanicalStatus: "verified";
  i2vStaticStatus: "legacy-audit-required" | "needs-independent-frame-or-review" | "ready";
  dynamicModelStatus: "not-run";
}> {
  const normalizedManifestBase = normalizeRelative(manifestBaseRelativePath, "manifestBaseRelativePath");
  const resolvedPackagePath = path.resolve(packagePath);
  const packageMetadata = await lstat(resolvedPackagePath, { bigint: true }).catch(() => null);
  if (!packageMetadata?.isDirectory() || packageMetadata.isSymbolicLink()
    || resolvedPackagePath !== packagePath || await realpath(resolvedPackagePath) !== resolvedPackagePath) {
    fail("verify-failed", `视频包目录不是安全真实目录：${normalizedManifestBase}`);
  }
  const manifestPath = path.join(packagePath, "manifest.json");
  const manifestSnapshot = await readJsonSnapshot(manifestPath, "视频包 manifest");
  const manifest = manifestSnapshot.value;
  const expectedBuilder = external.sourceKind === "managed-project"
    ? "core-managed-video-package-v1"
    : "tools/build_video_submission_pack.py";
  if (manifest.manifest_version !== "2.0" || manifest.builder !== expectedBuilder
    || manifest.unit_id !== authority.unitId) {
    fail("verify-failed", "视频包 manifest 版本、builder 或 unit_id 无效。");
  }
  const specSchemaVersion = manifest.spec_schema_version;
  const packageStatus = manifest.status;
  const i2vReadiness = manifest.i2v_readiness;
  if ((specSchemaVersion !== "1.0" && specSchemaVersion !== "2.0")
    || specSchemaVersion !== external.sourceSpec.schema_version
    || (packageStatus !== "PASS" && packageStatus !== "LEGACY_PASS")
    || packageStatus !== external.sourceSpec.status
    || typeof i2vReadiness !== "string" || !i2vReadiness.trim()) {
    fail("verify-failed", "视频包 manifest 的 spec/status/i2v_readiness 无效或与来源规格不一致。");
  }
  const raw = manifest.raw;
  const sourceSpec = manifest.source_spec;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || (raw as Record<string, unknown>).path !== external.rawRelativePath
    || normalizeSha((raw as Record<string, unknown>).sha256, "manifest.raw.sha256") !== authority.rawSha256
    || !sourceSpec || typeof sourceSpec !== "object" || Array.isArray(sourceSpec)
    || (sourceSpec as Record<string, unknown>).path !== external.sourceSpecRelativePath
    || normalizeSha((sourceSpec as Record<string, unknown>).sha256, "manifest.source_spec.sha256") !== external.sourceSpecSha256) {
    fail("verify-failed", "视频包 manifest 未绑定当前 raw/source spec。 ");
  }
  const rows = manifest.files;
  if (!Array.isArray(rows) || rows.length < 1) fail("verify-failed", "视频包 manifest.files 为空。 ");
  const files: StudioVideoPackageManifestFile[] = [];
  const fileSnapshots = new Map<string, StableFileSnapshot>();
  const decodedPngs = new Map<string, DecodedPngSnapshot>();
  const names = new Set<string>();
  let packageSizeBytes = manifestSnapshot.bytes.byteLength;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) fail("verify-failed", "manifest.files 条目无效。 ");
    const name = (row as Record<string, unknown>).path;
    const expectedSha = normalizeSha((row as Record<string, unknown>).sha256, "manifest.files[].sha256");
    if (typeof name !== "string" || path.basename(name) !== name || names.has(name)) {
      fail("verify-failed", `manifest 文件名非法或重复：${String(name)}`);
    }
    const maxBytes = videoPackageFileMaxBytes(name);
    if (!maxBytes) fail("verify-failed", `视频包含不受支持的文件类型：${name}`);
    const filePath = path.join(packagePath, name);
    const snapshot = await readStableFile(filePath, maxBytes).catch(() => null);
    if (!snapshot || snapshot.sha256 !== expectedSha) {
      fail("verify-failed", `视频包文件缺失、符号链接或哈希不匹配：${name}`);
    }
    packageSizeBytes += snapshot.sizeBytes;
    if (packageSizeBytes > MAX_VIDEO_PACKAGE_TOTAL_BYTES) fail("verify-failed", "视频包总大小超过机械验收上限。 ");
    fileSnapshots.set(name, snapshot);
    names.add(name);
    files.push({ path: name, sha256: expectedSha });
  }
  const actualEntries = await readdir(packagePath, { withFileTypes: true });
  const actualNames: string[] = [];
  for (const entry of actualEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) fail("verify-failed", `视频包含非普通文件：${entry.name}`);
    actualNames.push(entry.name);
  }
  const expectedNames = [...names, "manifest.json"].sort((left, right) => left.localeCompare(right, "en"));
  actualNames.sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    fail("verify-failed", "视频包实际文件集与 manifest.files 不完全一致。", [
      `expected=${expectedNames.join(",")}`,
      `actual=${actualNames.join(",")}`,
    ]);
  }
  for (const [name, snapshot] of fileSnapshots) {
    if (name.endsWith(".png")) decodedPngs.set(name, await decodePngSnapshot(snapshot, `视频包 ${name}`));
    if (name.endsWith(".md")) decodeUtf8Strict(snapshot, `视频包 ${name}`);
  }
  const sourcePanels = Array.isArray(external.sourceSpec.panels) ? external.sourceSpec.panels : [];
  const sourceShots = Array.isArray(external.sourceSpec.shots) ? external.sourceSpec.shots : [];
  const panelCount = sourcePanels.length;
  const requiredNames = [
    `${authority.unitId}_labeled.png`,
    `${authority.unitId}_video.json`,
    ...Array.from({ length: panelCount }, (_, offset) => [
      `${authority.unitId}-G${offset + 1}_raw.png`,
      `${authority.unitId}-G${offset + 1}_labeled.png`,
      `${authority.unitId}-G${offset + 1}_video.md`,
    ]).flat(),
  ];
  if (panelCount < 2 || panelCount > 6 || requiredNames.some((name) => !names.has(name))) {
    fail("verify-failed", "视频包缺少 2–6 格必需 raw/labeled/video.md 或总 labeled/video.json。 ");
  }
  const fileByName = new Map(files.map((file) => [file.path, file.sha256]));
  if (fileByName.get(`${authority.unitId}_labeled.png`) !== authority.labeledSha256) {
    fail("verify-failed", "视频包总 labeled 未绑定 Studio Review/历史 PASS 的权威 labeled SHA。 ");
  }
  const videoJsonName = `${authority.unitId}_video.json`;
  const videoJsonSnapshot = fileSnapshots.get(videoJsonName);
  if (!videoJsonSnapshot) fail("verify-failed", "视频包 video.json 快照缺失。 ");
  const videoJson = parseJsonSnapshot(videoJsonSnapshot, "视频包 video.json").value;
  if (videoJson.unit_id !== authority.unitId || videoJson.schema_version !== specSchemaVersion
    || videoJson.status !== packageStatus || videoJson.raw_sha256 !== authority.rawSha256) {
    fail("verify-failed", "视频包 video.json 与 manifest/authority 不一致。 ");
  }
  assertSourceSpecMatchesPack(
    videoJson,
    authority.pack,
    external.duduIdentity.sourceLockedScriptPath,
    external.sourceKind,
    external.managedSource?.id,
  );
  const sourceRawMetadata = await sharp(external.rawSnapshot.bytes, {
    failOn: "error",
    limitInputPixels: MAX_VIDEO_IMAGE_PIXELS,
  }).metadata().catch((error: unknown) => {
    throw new StudioVideoPackageError("verify-failed", "视频包来源 raw 无法解码以复核裁区。", [], { cause: error });
  });
  if (!sourceRawMetadata.width || !sourceRawMetadata.height) fail("verify-failed", "视频包来源 raw 尺寸无效。 ");
  for (const [offset, panelValue] of sourcePanels.entries()) {
    const panel = panelValue as Record<string, unknown>;
    const shot = sourceShots[offset] as Record<string, unknown> | undefined;
    const rect = panel.rect as Record<string, unknown> | undefined;
    const panelId = `G${offset + 1}`;
    if (!shot || !rect || panel.id !== panelId || shot.id !== panelId) {
      fail("verify-failed", `视频包 ${panelId} 来源规格身份无效。`);
    }
    const left = Number(rect.x);
    const top = Number(rect.y);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (![left, top, width, height].every(Number.isSafeInteger)
      || left < 0 || top < 0 || width < 1 || height < 1
      || left + width > sourceRawMetadata.width || top + height > sourceRawMetadata.height) {
      fail("verify-failed", `视频包 ${panelId} 裁区越出来源 raw。`);
    }
    const cropName = `${authority.unitId}-${panelId}_raw.png`;
    const labeledName = `${authority.unitId}-${panelId}_labeled.png`;
    const markdownName = `${authority.unitId}-${panelId}_video.md`;
    const crop = decodedPngs.get(cropName);
    const labeled = decodedPngs.get(labeledName);
    const markdownSnapshot = fileSnapshots.get(markdownName);
    if (!crop || !labeled || !markdownSnapshot
      || crop.width !== width || crop.height !== height
      || labeled.width !== width || labeled.height < height || labeled.height > height + 2_048) {
      fail("verify-failed", `视频包 ${panelId} raw/labeled 尺寸与冻结裁区不一致。`);
    }
    const expectedCrop = await sharp(external.rawSnapshot.bytes, {
      failOn: "error",
      limitInputPixels: MAX_VIDEO_IMAGE_PIXELS,
    }).extract({ left, top, width, height }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (expectedCrop.info.width !== width || expectedCrop.info.height !== height
      || !crop.data.equals(expectedCrop.data)
      || !labeled.data.subarray(0, crop.data.byteLength).equals(crop.data)) {
      fail("verify-failed", `视频包 ${panelId} raw 像素不是来源 raw 的冻结裁区，或 labeled 顶部未绑定该裁图。`);
    }
    const markdown = decodeUtf8Strict(markdownSnapshot, `视频包 ${markdownName}`);
    const timelineStart = shot.timeline_start;
    const timelineEnd = shot.timeline_end;
    const duration = shot.duration_sec;
    const videoPrompt = shot.video_prompt;
    const negativePrompt = shot.negative_prompt;
    const timingLine = markdown.split(/\r?\n/u).find((line) => line.startsWith("- 时码："));
    const timingPrefix = typeof timelineStart === "string" && typeof timelineEnd === "string"
      ? `- 时码：\`${timelineStart}—${timelineEnd}\`；时长：\``
      : "";
    const timingPayload = timingLine?.startsWith(timingPrefix) ? timingLine.slice(timingPrefix.length) : "";
    const markdownDuration = timingPayload.endsWith("s`") ? Number(timingPayload.slice(0, -2)) : Number.NaN;
    if (typeof timelineStart !== "string" || typeof timelineEnd !== "string"
      || typeof duration !== "number" || typeof videoPrompt !== "string" || !videoPrompt.trim()
      || typeof negativePrompt !== "string" || !negativePrompt.trim()
      || !markdown.startsWith(`# ${authority.unitId}-${panelId} 图生视频指令\n`)
      || !Number.isFinite(markdownDuration) || !equalSeconds(markdownDuration, duration)
      || !markdown.endsWith(`## 图生视频中文提示词\n\n${videoPrompt}\n\n## 固定禁止项\n\n${negativePrompt}\n`)) {
      fail("verify-failed", `视频包 ${panelId} video.md 未逐字绑定冻结时码、提示词与禁止项。`);
    }
  }
  let v2StaticInputContractReady = false;
  if (specSchemaVersion === "1.0") {
    if (i2vReadiness !== "LEGACY_FRAME_ROLE_AUDIT_REQUIRED" || !names.has("LEGACY_I2V_AUDIT_REQUIRED.md")) {
      fail("verify-failed", "legacy 视频包缺少明确 I2V 审计门。 ");
    }
  } else {
    const gate = videoJson.target_video_model_gate;
    if (!gate || typeof gate !== "object" || Array.isArray(gate)
      || (gate as Record<string, unknown>).sample_status !== i2vReadiness) {
      fail("verify-failed", "v2 视频包 I2V 状态与 target_video_model_gate 不一致。 ");
    }
    const gateRow = gate as Record<string, unknown>;
    if (!new Set([
      "NOT_TESTED",
      "PACKAGE_READY_DYNAMIC_MODEL_NOT_TESTED",
      "STORYBOARD_CROP_ANCHOR_FOLLOWUP_ONLY",
    ]).has(i2vReadiness)
      || typeof gateRow.claim_limit !== "string" || !gateRow.claim_limit.trim()) {
      fail("verify-failed", `v2 视频包 I2V sample_status 不受支持或缺少 claim_limit：${i2vReadiness}`);
    }
    const shots = videoJson.shots;
    if (!Array.isArray(shots) || shots.length !== panelCount) fail("verify-failed", "v2 video.json shots 数量无效。 ");
    for (const [offset, shot] of shots.entries()) {
      if (!shot || typeof shot !== "object" || Array.isArray(shot)) fail("verify-failed", `video.json shots[${offset}] 无效。`);
      const plan = (shot as Record<string, unknown>).i2v_input;
      if (!plan || typeof plan !== "object" || Array.isArray(plan)) fail("verify-failed", `video.json shots[${offset}].i2v_input 无效。`);
      const input = plan as Record<string, unknown>;
      for (const [pathField, shaField, required] of [
        ["storyboard_crop_path", "storyboard_crop_sha256", true],
        ["start_frame_path", "start_frame_sha256", true],
        ["end_frame_path", "end_frame_sha256", false],
      ] as const) {
        const name = input[pathField];
        const sha = input[shaField];
        if (!required && (name === null || name === undefined || name === "")) {
          if (sha !== null && sha !== undefined && sha !== "") fail("verify-failed", `${pathField} 为空但 ${shaField} 非空。`);
          continue;
        }
        if (typeof name !== "string" || path.basename(name) !== name || !fileByName.has(name)
          || fileByName.get(name) !== normalizeSha(sha, `video.json.${shaField}`)) {
          fail("verify-failed", `video.json ${pathField} 未绑定包内 manifest 文件。`);
        }
        const frame = decodedPngs.get(name);
        const panelRect = (sourcePanels[offset] as Record<string, unknown>).rect as Record<string, unknown>;
        if (!frame || frame.width !== Number(panelRect.width) || frame.height !== Number(panelRect.height)) {
          fail("verify-failed", `video.json ${pathField} 尺寸不等于对应冻结宫格。`);
        }
      }
    }
    const allStartFramesExplicitlyAccepted = shots.every((shot) => {
      const row = shot as Record<string, unknown>;
      const input = row.i2v_input as Record<string, unknown>;
      return input.can_use_as_start_frame === true
        && row.input_frame_role === "shot_start"
        && (row.storyboard_frame_role === "shot_start" || row.storyboard_frame_role === "representative");
    });
    v2StaticInputContractReady = i2vReadiness === "PACKAGE_READY_DYNAMIC_MODEL_NOT_TESTED"
      || (i2vReadiness === "NOT_TESTED" && allStartFramesExplicitlyAccepted);
  }
  const i2vStaticStatus: StudioVideoPackageVerifyReceipt["i2vStaticStatus"] = specSchemaVersion === "1.0"
    ? "legacy-audit-required"
    : v2StaticInputContractReady
      ? "ready"
      : "needs-independent-frame-or-review";
  // 语义验收仅消费上方已哈希的快照；返回回执身份前再绑定一次完整文件集，
  // 防止验收期间 pathname 被替换后留下 A 哈希/B 语义的混合结论。
  await assertVideoPackageSnapshotsCurrent(packagePath, manifestSnapshot, fileSnapshots, expectedNames);
  const packageAfter = await lstat(resolvedPackagePath, { bigint: true });
  if (packageAfter.dev !== packageMetadata.dev || packageAfter.ino !== packageMetadata.ino
    || !packageAfter.isDirectory() || packageAfter.isSymbolicLink()
    || await realpath(resolvedPackagePath) !== resolvedPackagePath) {
    fail("verify-failed", `视频包目录在机械验收期间发生替换：${normalizedManifestBase}`);
  }
  return {
    manifestRelativePath: `${normalizedManifestBase}/manifest.json`,
    manifestSha256: manifestSnapshot.sha256,
    manifestFingerprint: digest(manifest),
    files,
    specSchemaVersion,
    packageStatus,
    i2vReadiness,
    mechanicalStatus: "verified",
    i2vStaticStatus,
    dynamicModelStatus: "not-run",
  };
}

async function verifyPackageWithBuilder(
  external: ResolvedExternalInput,
  authority: ResolvedAuthority,
  packagePath = external.packagePath,
  builderPath = external.builderPath,
) {
  if (external.sourceKind === "dudu-readonly") {
    await runVideoBuilderExecutable(external, builderPath, ["verify", "--package-dir", packagePath], "verify");
  }
  return validateManifest(external, authority, packagePath);
}

function assertReceiptMatchesManifest(
  receipt: StudioVideoPackageVerifyReceipt,
  manifest: Awaited<ReturnType<typeof validateManifest>>,
  packageRelativePath: string,
  relocated = false,
): void {
  if ((!relocated && receipt.manifestRelativePath !== manifest.manifestRelativePath)
    || receipt.manifestSha256 !== manifest.manifestSha256
    || receipt.manifestFingerprint !== manifest.manifestFingerprint
    || digest(receipt.files) !== digest(manifest.files)
    || receipt.specSchemaVersion !== manifest.specSchemaVersion
    || receipt.packageStatus !== manifest.packageStatus
    || receipt.i2vReadiness !== manifest.i2vReadiness
    || receipt.mechanicalStatus !== manifest.mechanicalStatus
    || receipt.i2vStaticStatus !== manifest.i2vStaticStatus
    || receipt.dynamicModelStatus !== manifest.dynamicModelStatus) {
    fail("destination-conflict", `视频包 ${packageRelativePath} 已有 receipt 但产物身份变化。`);
  }
}

function assertManifestIdentityEqual(
  expected: Awaited<ReturnType<typeof validateManifest>>,
  actual: Awaited<ReturnType<typeof validateManifest>>,
  message: string,
): void {
  const { manifestRelativePath: _expectedPath, ...expectedIdentity } = expected;
  const { manifestRelativePath: _actualPath, ...actualIdentity } = actual;
  if (digest(expectedIdentity) !== digest(actualIdentity)) fail("destination-conflict", message, [
    `expectedManifestSha256=${expected.manifestSha256}`,
    `actualManifestSha256=${actual.manifestSha256}`,
  ]);
}

interface StudioVideoPackageReceiptStorage {
  storageKind: StudioVideoPackageVerifyReceipt["storageKind"];
  storageRelativePath: string;
}

function managedEvidenceRelativePath(intent: StudioVideoPackageExportIntent): string {
  return `.aicanvas/studio-video-package-evidence/${intent.intentId}/${intent.unitId}`;
}

function unreceiptedArchiveRelativePath(intent: StudioVideoPackageExportIntent): string {
  return `${OUTPUT_ROOT_RELATIVE_PATH}/.studio-video-package-unreceipted/${intent.intentId}/${intent.unitId}`;
}

function unreceiptedAncestorIntents(
  db: DatabaseSync,
  intent: StudioVideoPackageExportIntent,
): StudioVideoPackageExportIntent[] {
  const ancestors: StudioVideoPackageExportIntent[] = [];
  const visited = new Set<string>();
  let parentId = intent.supersedesIntentId;
  while (parentId) {
    if (visited.has(parentId)) fail("storage-invalid", "视频包 intent 换代链存在环。");
    visited.add(parentId);
    const row = intentRowById(db, parentId);
    if (!row) fail("storage-invalid", "视频包 intent 换代链存在缺口。");
    const parent = intentFromRow(row);
    if (parent.productionRoot !== intent.productionRoot
      || parent.packageRelativePath !== intent.packageRelativePath
      || parent.unitId !== intent.unitId) {
      fail("storage-invalid", "视频包 intent 换代链跨越了固定目标。");
    }
    if (!receiptRowByIntent(db, parent.intentId)) ancestors.push(parent);
    parentId = parent.supersedesIntentId;
  }
  return ancestors;
}

async function packageMatchesUnreceiptedIntent(
  packagePath: string,
  intent: StudioVideoPackageExportIntent,
): Promise<boolean> {
  try {
    const before = await lstat(packagePath, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(packagePath) !== packagePath) return false;
    const manifestSnapshot = await readJsonSnapshot(path.join(packagePath, "manifest.json"), "未回执视频包 manifest");
    const manifest = manifestSnapshot.value;
    const raw = manifest.raw;
    const sourceSpec = manifest.source_spec;
    if (manifest.manifest_version !== "2.0"
      || manifest.unit_id !== intent.unitId
      || !raw || typeof raw !== "object" || Array.isArray(raw)
      || normalizeSha((raw as Record<string, unknown>).sha256, "unreceipted.raw.sha256") !== intent.rawSha256
      || !sourceSpec || typeof sourceSpec !== "object" || Array.isArray(sourceSpec)
      || (sourceSpec as Record<string, unknown>).path !== intent.sourceSpecRelativePath
      || normalizeSha(
        (sourceSpec as Record<string, unknown>).sha256,
        "unreceipted.source_spec.sha256",
      ) !== intent.sourceSpecSha256
      || !Array.isArray(manifest.files)) {
      return false;
    }
    const expectedNames = new Set<string>(["manifest.json"]);
    let labeledMatches = 0;
    let packageBytes = manifestSnapshot.bytes.byteLength;
    for (const entry of manifest.files) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const name = (entry as Record<string, unknown>).path;
      const sha = normalizeSha((entry as Record<string, unknown>).sha256, "unreceipted.files.sha256");
      if (typeof name !== "string" || path.basename(name) !== name || expectedNames.has(name)
        || !videoPackageFileMaxBytes(name)) return false;
      const snapshot = await readStableFile(path.join(packagePath, name), videoPackageFileMaxBytes(name));
      if (snapshot.sha256 !== sha) return false;
      packageBytes += snapshot.sizeBytes;
      if (packageBytes > MAX_VIDEO_PACKAGE_TOTAL_BYTES) return false;
      expectedNames.add(name);
      if (name === `${intent.unitId}_labeled.png` && sha === intent.labeledSha256) labeledMatches += 1;
    }
    if (labeledMatches !== 1) return false;
    const actual = (await readdir(packagePath, { withFileTypes: true }))
      .map((entry) => {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("non-file");
        return entry.name;
      })
      .sort((left, right) => left.localeCompare(right, "en"));
    const expected = [...expectedNames].sort((left, right) => left.localeCompare(right, "en"));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
    const manifestAfter = await readStableFile(path.join(packagePath, "manifest.json"), MAX_JSON_BYTES);
    const after = await lstat(packagePath, { bigint: true });
    return manifestAfter.sha256 === manifestSnapshot.sha256
      && before.dev === after.dev
      && before.ino === after.ino
      && after.isDirectory()
      && !after.isSymbolicLink()
      && await realpath(packagePath) === packagePath;
  } catch {
    return false;
  }
}

async function archiveUnreceiptedAncestorPackage(
  databasePath: string,
  currentIntent: StudioVideoPackageExportIntent,
  ancestors: readonly StudioVideoPackageExportIntent[],
  packagePath: string,
  assertCurrentBeforeMutation: () => Promise<void>,
): Promise<StudioVideoPackageExportIntent | null> {
  const matches: StudioVideoPackageExportIntent[] = [];
  for (const ancestor of ancestors) {
    if (await packageMatchesUnreceiptedIntent(packagePath, ancestor)) matches.push(ancestor);
  }
  if (matches.length === 0) return null;
  if (matches.length !== 1) fail("storage-invalid", "无回执生产目录同时匹配多个 ancestor intent。");
  const owner = matches[0]!;
  const ledger = openDatabase(databasePath, false);
  try {
    if (receiptRowByIntent(ledger, owner.intentId)) {
      fail("storage-invalid", `无回执目录归档前 ancestor ${owner.intentId} 已出现 receipt。`);
    }
  } finally {
    ledger.close();
  }
  // 内容匹配和只读账本复核可能耗时；任何恢复目录创建之前重新绑定
  // 当前 successor 的 managed-source/Observation。
  await assertCurrentBeforeMutation();
  const archiveRelativePath = unreceiptedArchiveRelativePath(owner);
  const archiveParent = await prepareInstallParent(
    currentIntent.productionRoot,
    path.posix.dirname(archiveRelativePath),
    "视频包无回执恢复目录",
  );
  const archivePath = path.join(currentIntent.productionRoot, ...archiveRelativePath.split("/"));
  if (path.dirname(archivePath) !== archiveParent || !pathInside(archivePath, currentIntent.productionRoot)) {
    fail("storage-invalid", "视频包无回执恢复目录逃逸生产根。");
  }
  if (await lstat(archivePath).catch(() => null)) {
    fail("destination-conflict", `视频包无回执恢复目标已存在：${archiveRelativePath}`);
  }
  // prepareInstallParent 本身会创建目录，因此在真正移动生产目标前再做一次
  // CAS，防止目录准备窗口内 source 发生变化。
  await assertCurrentBeforeMutation();
  await renameDirectoryNoReplace(packagePath, archivePath);
  for (const directory of new Set([path.dirname(packagePath), archiveParent])) {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  if (!(await packageMatchesUnreceiptedIntent(archivePath, owner))) {
    fail("destination-conflict", `视频包无回执目录归档后身份漂移：${archiveRelativePath}`);
  }
  return owner;
}

function assertReceiptStorageContract(
  intent: StudioVideoPackageExportIntent,
  storage: StudioVideoPackageReceiptStorage,
  manifest: Awaited<ReturnType<typeof validateManifest>>,
): StudioVideoPackageReceiptStorage {
  const storageRelativePath = normalizeRelative(storage.storageRelativePath, "receipt.storageRelativePath");
  const expectedRelativePath = storage.storageKind === "external-production"
    ? intent.packageRelativePath
    : managedEvidenceRelativePath(intent);
  if (storageRelativePath !== expectedRelativePath
    || manifest.manifestRelativePath !== `${storageRelativePath}/manifest.json`) {
    fail("storage-invalid", `视频包 ${intent.intentId} 的 receipt 存储身份无效。`, [
      `storageKind=${storage.storageKind}`,
      `expectedRelativePath=${expectedRelativePath}`,
      `actualRelativePath=${storageRelativePath}`,
      `manifestRelativePath=${manifest.manifestRelativePath}`,
    ]);
  }
  return { storageKind: storage.storageKind, storageRelativePath };
}

function sqliteTableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function emptyJsonArray(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

function storedObservationEvidenceIdentity(
  observedStateJson: string,
): {
  contractVersion: number;
  kind: string | null;
  sha256: string | null;
  lineageFingerprint: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(observedStateJson);
  } catch {
    fail("storage-invalid", "视频包 receipt 事务读取到损坏的 Observation observed_state_json。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("storage-invalid", "视频包 receipt 事务读取到无效的 Observation observed_state_json。");
  }
  const source = parsed as Record<string, unknown>;
  if (source.schemaVersion !== 2 && source.schemaVersion !== 3) {
    return { contractVersion: 1, kind: null, sha256: null, lineageFingerprint: null };
  }
  if (!source.evidence || typeof source.evidence !== "object" || Array.isArray(source.evidence)) {
    fail("storage-invalid", "视频包 receipt 事务读取到缺少 evidence 的 Observation 事件。");
  }
  const evidence = source.evidence as Record<string, unknown>;
  if (typeof evidence.kind !== "string"
    || typeof evidence.sha256 !== "string"
    || !SHA256_PATTERN.test(evidence.sha256)) {
    fail("storage-invalid", "视频包 receipt 事务读取到无效的 Observation evidence 身份。");
  }
  return {
    contractVersion: source.schemaVersion,
    kind: evidence.kind,
    sha256: evidence.sha256,
    lineageFingerprint: evidence.lineage === undefined ? null : digest(evidence.lineage),
  };
}

/**
 * receipt 与 Review/result/Observation 共用 generation ledger。该检查必须在
 * 写事务取得 RESERVED lock 后同步执行，才能把 Head CAS 与 receipt INSERT
 * 置于同一线性化点；事务外的异步 source 复核只负责文件与其他数据库闭包。
 */
function assertReceiptAuthorityCurrentInTransaction(
  db: DatabaseSync,
  intent: StudioVideoPackageExportIntent,
): void {
  if (intent.authorityKind !== "studio-review") return;
  if (intent.schemaVersion === LEGACY_VIDEO_PACKAGE_SCHEMA_VERSION || !intent.generationRunId) {
    fail("input-drift", `视频包 intent ${intent.intentId} 缺少可事务复核的 Review 身份。`);
  }
  for (const table of [
    "studio_generation_review_events",
    "studio_generation_review_heads",
    "studio_generation_results",
  ]) {
    if (!sqliteTableExists(db, table)) {
      fail("storage-invalid", `视频包 receipt 事务缺少 owner 表：${table}`);
    }
  }
  const review = db.prepare(`
    SELECT generation_run_id,raw_result_id,raw_sha256,labeled_result_id,labeled_sha256,
           pack_id,pack_fingerprint,decision,current_at_submission,advances_head,fingerprint
    FROM studio_generation_review_events WHERE review_id=?
  `).get(intent.authorityId) as {
    generation_run_id: string;
    raw_result_id: string;
    raw_sha256: string;
    labeled_result_id: string;
    labeled_sha256: string;
    pack_id: string;
    pack_fingerprint: string;
    decision: string;
    current_at_submission: number;
    advances_head: number;
    fingerprint: string;
  } | undefined;
  const reviewHead = db.prepare(`
    SELECT review_id,review_fingerprint
    FROM studio_generation_review_heads WHERE generation_run_id=?
  `).get(intent.generationRunId) as {
    review_id: string;
    review_fingerprint: string;
  } | undefined;
  const resultRows = db.prepare(`
    SELECT result_id,generation_run_id,variant,media_sha256,input_current,promotion_eligible,
           stale_reasons_json,pack_id,pack_fingerprint
    FROM studio_generation_results WHERE result_id IN (?, ?)
  `).all(intent.rawResultId, intent.labeledResultId) as Array<{
    result_id: string;
    generation_run_id: string;
    variant: string;
    media_sha256: string;
    input_current: number;
    promotion_eligible: number;
    stale_reasons_json: string;
    pack_id: string;
    pack_fingerprint: string;
  }>;
  const raw = resultRows.find((row) => row.variant === "raw");
  const labeled = resultRows.find((row) => row.variant === "labeled");
  if (!review || !reviewHead || resultRows.length !== 2 || !raw || !labeled
    || review.generation_run_id !== intent.generationRunId
    || review.raw_result_id !== intent.rawResultId
    || review.raw_sha256 !== intent.rawSha256
    || review.labeled_result_id !== intent.labeledResultId
    || review.labeled_sha256 !== intent.labeledSha256
    || review.pack_id !== intent.packId
    || review.pack_fingerprint !== intent.packFingerprint
    || review.decision !== "pass"
    || Number(review.current_at_submission) !== 1
    || Number(review.advances_head) !== 1
    || review.fingerprint !== intent.authorityFingerprint
    || reviewHead.review_id !== intent.authorityId
    || reviewHead.review_fingerprint !== intent.authorityFingerprint
    || raw.result_id !== intent.rawResultId
    || raw.media_sha256 !== intent.rawSha256
    || labeled.result_id !== intent.labeledResultId
    || labeled.media_sha256 !== intent.labeledSha256
    || [raw, labeled].some((row) =>
      row.generation_run_id !== intent.generationRunId
      || Number(row.input_current) !== 1
      || Number(row.promotion_eligible) !== 1
      || !emptyJsonArray(row.stale_reasons_json)
      || row.pack_id !== intent.packId
      || row.pack_fingerprint !== intent.packFingerprint)) {
    fail("input-drift", `视频包 intent ${intent.intentId} 的 Review/result 在 receipt 事务内漂移。`);
  }

  const expectedObservationRevision = intent.observationHeadRevision;
  if (expectedObservationRevision === undefined) {
    fail("input-drift", `视频包 intent ${intent.intentId} 缺少 Observation Head revision。`);
  }
  const hasObservationEvents = sqliteTableExists(db, "studio_post_result_observation_events");
  const hasObservationHeads = sqliteTableExists(db, "studio_post_result_observation_heads");
  if (hasObservationEvents !== hasObservationHeads) {
    fail("storage-invalid", "视频包 receipt 事务读取到不完整的 Observation owner schema。");
  }
  if (!hasObservationEvents) {
    if (expectedObservationRevision !== 0
      || intent.observationControlStatus !== "missing"
      || (intent.observationId ?? null) !== null
      || (intent.observationHeadFingerprint ?? null) !== null
      || (intent.observationEvidenceContractVersion ?? null) !== null
      || (intent.observationEvidenceKind ?? null) !== null
      || (intent.observationEvidenceSha256 ?? null) !== null
      || (intent.observationEvidenceLineageFingerprint ?? null) !== null) {
      fail("input-drift", `视频包 intent ${intent.intentId} 的 Observation owner schema 已漂移。`);
    }
    return;
  }
  const observationHead = db.prepare(`
    SELECT revision,observation_id,observation_fingerprint
    FROM studio_post_result_observation_heads WHERE generation_run_id=?
  `).get(intent.generationRunId) as {
    revision: number;
    observation_id: string;
    observation_fingerprint: string;
  } | undefined;
  if (expectedObservationRevision === 0) {
    if (observationHead
      || intent.observationControlStatus !== "missing"
      || (intent.observationId ?? null) !== null
      || (intent.observationHeadFingerprint ?? null) !== null) {
      fail("input-drift", `视频包 intent ${intent.intentId} 的 Observation Head 在 receipt 事务内漂移。`);
    }
    return;
  }
  if (!observationHead
    || Number(observationHead.revision) !== expectedObservationRevision
    || observationHead.observation_id !== intent.observationId
    || observationHead.observation_fingerprint !== intent.observationHeadFingerprint) {
    fail("input-drift", `视频包 intent ${intent.intentId} 的 Observation Head 在 receipt 事务内漂移。`);
  }
  const observation = db.prepare(`
    SELECT observation_id,generation_run_id,head_revision,review_id,review_fingerprint,
           raw_result_id,raw_sha256,labeled_result_id,labeled_sha256,pack_id,pack_fingerprint,
           observed_state_json,fingerprint
    FROM studio_post_result_observation_events WHERE observation_id=?
  `).get(intent.observationId) as {
    observation_id: string;
    generation_run_id: string;
    head_revision: number;
    review_id: string;
    review_fingerprint: string;
    raw_result_id: string;
    raw_sha256: string;
    labeled_result_id: string;
    labeled_sha256: string;
    pack_id: string;
    pack_fingerprint: string;
    observed_state_json: string;
    fingerprint: string;
  } | undefined;
  if (!observation
    || observation.observation_id !== intent.observationId
    || observation.generation_run_id !== intent.generationRunId
    || Number(observation.head_revision) !== expectedObservationRevision
    || (intent.observationControlStatus === "current"
      && (observation.review_id !== intent.authorityId
        || observation.review_fingerprint !== intent.authorityFingerprint))
    || observation.raw_result_id !== intent.rawResultId
    || observation.raw_sha256 !== intent.rawSha256
    || observation.labeled_result_id !== intent.labeledResultId
    || observation.labeled_sha256 !== intent.labeledSha256
    || observation.pack_id !== intent.packId
    || observation.pack_fingerprint !== intent.packFingerprint
    || observation.fingerprint !== intent.observationHeadFingerprint) {
    fail("input-drift", `视频包 intent ${intent.intentId} 的 Observation event 在 receipt 事务内漂移。`);
  }
  const evidence = storedObservationEvidenceIdentity(observation.observed_state_json);
  if (evidence.contractVersion !== intent.observationEvidenceContractVersion
    || evidence.kind !== (intent.observationEvidenceKind ?? null)
    || evidence.sha256 !== (intent.observationEvidenceSha256 ?? null)
    || evidence.lineageFingerprint !== (intent.observationEvidenceLineageFingerprint ?? null)) {
    fail("input-drift", `视频包 intent ${intent.intentId} 的 Observation evidence 在 receipt 事务内漂移。`);
  }
}

async function insertReceipt(
  databasePath: string,
  managedRoot: string,
  intent: StudioVideoPackageExportIntent,
  manifest: Awaited<ReturnType<typeof validateManifest>>,
  storageInput: StudioVideoPackageReceiptStorage,
  external: ResolvedExternalInput,
  authority: ResolvedAuthority,
  packagePath: string,
  assertCurrentBeforeCommit: () => Promise<void>,
): Promise<{ receipt: StudioVideoPackageVerifyReceipt; replayed: boolean }> {
  // 回执事务前重新完成一次 Core 文件集/语义绑定；此 await 之后到 SQLite
  // COMMIT 全程同步，不再把较早的路径快照直接登记为机械验收事实。
  const reboundManifest = await validateManifest(
    external,
    authority,
    packagePath,
    storageInput.storageRelativePath,
  );
  assertManifestIdentityEqual(manifest, reboundManifest, `视频包 ${intent.intentId} 在 receipt 提交前发生变化。`);
  const storage = assertReceiptStorageContract(intent, storageInput, reboundManifest);
  // rebound manifest 验证本身包含异步文件读取；先复核 managed-source/
  // Observation，再用精确 barrier 证明最后一次完整输入闭包复核的位置。
  await assertCurrentBeforeCommit();
  // 精确测试窗口：异步 CAS 已返回，但 receipt 写事务尚未 BEGIN。任何在这里
  // 提交的 Review/Observation 变更必须被下面同一 BEGIN IMMEDIATE 内复核拒绝；
  // Canonical Unit、managed source 或外部冻结文件变化则由 barrier 后的最终完整
  // source CAS 拒绝。该 CAS 位于 project-scoped studio-mutation fence 内，正常
  // Studio 写者不能在它返回后、receipt COMMIT 前改变跨库受管事实。
  await waitForReceiptPostCasBeforeTransactionTestBarrier(managedRoot, intent);
  await assertIntentInputClosureCurrent(managedRoot, intent, authority);
  const db = openDatabase(databasePath, true);
  try {
    return runTransaction(db, () => {
      assertReceiptAuthorityCurrentInTransaction(db, intent);
      const existing = receiptRowByIntent(db, intent.intentId);
      if (existing) {
        const receipt = receiptFromRow(existing);
        if (receipt.storageKind !== storage.storageKind
          || receipt.storageRelativePath !== storage.storageRelativePath) {
          fail("destination-conflict", `视频包 ${intent.intentId} 已有其他存储回执。`);
        }
        assertReceiptMatchesManifest(receipt, reboundManifest, intent.packageRelativePath);
        return { receipt, replayed: true };
      }
      const verifiedAt = new Date().toISOString();
      const identityInput = {
        schemaVersion: 3 as const,
        kind: "studio-video-package-verify-receipt" as const,
        intentId: intent.intentId,
        ...storage,
        ...reboundManifest,
        verifiedAt,
      };
      const receiptId = `studio-video-package-receipt-${digest(identityInput).slice(0, 40)}`;
      const semantic = { ...identityInput, receiptId };
      const fingerprint = digest(semantic);
      db.prepare(`
        INSERT INTO studio_video_package_verify_receipts(
          receipt_id, intent_id, storage_kind, storage_relative_path, manifest_relative_path, manifest_sha256,
          manifest_fingerprint, files_json, spec_schema_version, package_status, i2v_readiness,
          mechanical_status, i2v_static_status, dynamic_model_status, verified_at, fingerprint
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receiptId,
        intent.intentId,
        storage.storageKind,
        storage.storageRelativePath,
        reboundManifest.manifestRelativePath,
        reboundManifest.manifestSha256,
        reboundManifest.manifestFingerprint,
        JSON.stringify(reboundManifest.files),
        reboundManifest.specSchemaVersion,
        reboundManifest.packageStatus,
        reboundManifest.i2vReadiness,
        reboundManifest.mechanicalStatus,
        reboundManifest.i2vStaticStatus,
        reboundManifest.dynamicModelStatus,
        verifiedAt,
        fingerprint,
      );
      const row = receiptRowByIntent(db, intent.intentId);
      if (!row) fail("storage-invalid", `视频包 receipt ${receiptId} 未落盘。`);
      return { receipt: receiptFromRow(row), replayed: false };
    });
  } finally {
    db.close();
  }
}

interface SnapshotRuntime {
  root: string;
  builderPath: string;
  sourceSpecPath: string;
  fontPath: string;
  dependencyPaths: Map<string, string>;
  outputRoot: string;
}

async function writeRuntimeSnapshot(
  runtimeRoot: string,
  relativePath: string,
  snapshot: StableFileSnapshot,
): Promise<string> {
  const normalized = normalizeRelative(relativePath, "runtime snapshot relativePath");
  const target = path.join(runtimeRoot, ...normalized.split("/"));
  if (!pathInside(target, runtimeRoot)) fail("storage-invalid", `runtime snapshot 逃逸：${normalized}`);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, snapshot.bytes, { flag: "wx", mode: 0o600 });
  const landed = await readStableFile(target);
  if (landed.sha256 !== snapshot.sha256 || landed.sizeBytes !== snapshot.sizeBytes) {
    fail("storage-invalid", `runtime snapshot 落盘漂移：${normalized}`);
  }
  return target;
}

async function withSnapshotRuntime<T>(
  managedRoot: string,
  intent: StudioVideoPackageExportIntent,
  external: ResolvedExternalInput,
  work: (runtime: SnapshotRuntime) => Promise<T>,
): Promise<T> {
  const runtimeBase = path.join(managedRoot, ".aicanvas", "studio-video-package-runtime");
  await mkdir(runtimeBase, { recursive: true, mode: 0o700 });
  const runtimeMetadata = await lstat(runtimeBase);
  if (!runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink() || await realpath(runtimeBase) !== runtimeBase) {
    fail("storage-invalid", "视频包隔离运行根不是安全真实目录。 ");
  }
  const runtimeRoot = await mkdtemp(path.join(runtimeBase, `${intent.intentId}-`));
  try {
    const builderPath = await writeRuntimeSnapshot(runtimeRoot, external.builderRelativePath, external.builderSnapshot);
    const sourceSpecPath = await writeRuntimeSnapshot(runtimeRoot, external.sourceSpecRelativePath, external.sourceSpecSnapshot);
    const fontPath = await writeRuntimeSnapshot(
      runtimeRoot,
      `toolchain/font/${external.fontSnapshot.sha256}-${path.basename(external.fontPath)}`,
      external.fontSnapshot,
    );
    const dependencyPaths = new Map<string, string>();
    for (const dependency of external.dependencies) {
      dependencyPaths.set(
        dependency.relativePath,
        await writeRuntimeSnapshot(runtimeRoot, dependency.relativePath, dependency.snapshot),
      );
    }
    const outputRoot = path.join(runtimeRoot, "output");
    await mkdir(outputRoot, { mode: 0o700 });
    return await work({ root: runtimeRoot, builderPath, sourceSpecPath, fontPath, dependencyPaths, outputRoot });
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

interface StudioVideoPackageInstallClaim {
  schemaVersion: 1;
  kind: "studio-video-package-install-claim";
  intentId: string;
  inputFingerprint: string;
  packageRelativePath: string;
  manifestSha256: string;
  fingerprint: string;
}

function createInstallClaim(
  intent: StudioVideoPackageExportIntent,
  manifestSha256: string,
  packageRelativePath = intent.packageRelativePath,
): StudioVideoPackageInstallClaim {
  const normalizedPackageRelativePath = normalizeRelative(packageRelativePath, "installClaim.packageRelativePath");
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-video-package-install-claim" as const,
    intentId: intent.intentId,
    inputFingerprint: intent.inputFingerprint,
    packageRelativePath: normalizedPackageRelativePath,
    manifestSha256,
  };
  return { ...semantic, fingerprint: digest(semantic) };
}

async function readInstallClaim(claimPath: string): Promise<StudioVideoPackageInstallClaim | null> {
  const metadata = await lstat(claimPath).catch(() => null);
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail("destination-conflict", "视频包 install claim 不是安全普通文件。 ");
  const value = (await readJsonSnapshot(claimPath, "视频包 install claim")).value;
  const semantic = {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    intentId: value.intentId,
    inputFingerprint: value.inputFingerprint,
    packageRelativePath: value.packageRelativePath,
    manifestSha256: value.manifestSha256,
  };
  if (value.schemaVersion !== 1 || value.kind !== "studio-video-package-install-claim"
    || typeof value.fingerprint !== "string" || value.fingerprint !== digest(semantic)) {
    fail("destination-conflict", "视频包 install claim 内容地址无效。 ");
  }
  return { ...semantic, fingerprint: value.fingerprint } as StudioVideoPackageInstallClaim;
}

async function writeInstallClaim(claimPath: string, claim: StudioVideoPackageInstallClaim): Promise<void> {
  const handle = await open(claimPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(stableValue(claim))}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncExactDirectory(path.dirname(claimPath), "installClaim.parent");
  const landed = await readInstallClaim(claimPath);
  if (!landed || digest(landed) !== digest(claim)) fail("destination-conflict", "视频包 install claim 落盘漂移。 ");
}

async function syncExactDirectory(directory: string, field: string): Promise<void> {
  const canonical = await canonicalDirectory(directory, field);
  const pathBefore = await lstat(canonical, { bigint: true });
  let handle;
  try {
    handle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== pathBefore.dev || opened.ino !== pathBefore.ino) {
      fail("destination-conflict", `${field} 在同步前发生替换。`);
    }
    await handle.sync();
    const pathAfter = await lstat(canonical, { bigint: true });
    if (pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino
      || !pathAfter.isDirectory() || pathAfter.isSymbolicLink()
      || await realpath(canonical) !== canonical) {
      fail("destination-conflict", `${field} 在同步期间发生替换。`);
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function installFileNoClobber(
  source: string,
  destination: string,
  expectedSha: string,
  options: { repairMismatchedExisting?: boolean } = {},
): Promise<void> {
  const sourceParent = path.dirname(source);
  const destinationParent = path.dirname(destination);
  if (!path.isAbsolute(source) || !path.isAbsolute(destination)
    || path.basename(source) === source || path.basename(destination) === destination) {
    fail("storage-invalid", "视频包逐文件安装必须使用绝对父目录与 basename。 ");
  }
  await Promise.all([
    canonicalDirectory(sourceParent, "installFile.sourceParent"),
    canonicalDirectory(destinationParent, "installFile.destinationParent"),
  ]);
  const [sourceParentIdentity, destinationParentIdentity] = await Promise.all([
    lstat(sourceParent, { bigint: true }),
    lstat(destinationParent, { bigint: true }),
  ]);
  await runExecutable(SAFE_RENAME_PYTHON, [
    "-I",
    "-S",
    "-c",
    SAFE_INSTALL_FILE_SCRIPT,
    sourceParent,
    path.basename(source),
    destinationParent,
    path.basename(destination),
    expectedSha,
    sourceParentIdentity.dev.toString(),
    sourceParentIdentity.ino.toString(),
    destinationParentIdentity.dev.toString(),
    destinationParentIdentity.ino.toString(),
    options.repairMismatchedExisting ? "1" : "0",
    process.env.NODE_ENV === "test" && process.env.P30_TEST_INSTALL_FAULT === "partial-file"
      ? "partial-file"
      : "",
  ], "install", isolatedSubprocessEnvironment());
  const landed = await readStableFile(destination);
  if (landed.sha256 !== expectedSha) fail("destination-conflict", `视频包目标文件落盘漂移：${path.basename(destination)}`);
}

async function bindStagedAuthorityLabeled(
  external: ResolvedExternalInput,
  authority: ResolvedAuthority,
  stagedPackage: string,
): Promise<void> {
  const labeledPath = path.join(stagedPackage, `${authority.unitId}_labeled.png`);
  const current = await readStableFile(labeledPath);
  if (current.sha256 === authority.labeledSha256) return;
  await writeFile(labeledPath, external.labeledSnapshot.bytes, { flag: "w", mode: 0o600 });
  const landed = await readStableFile(labeledPath);
  if (landed.sha256 !== authority.labeledSha256) fail("verify-failed", "staged 视频包权威 labeled 替换后 SHA 漂移。 ");
  const manifestPath = path.join(stagedPackage, "manifest.json");
  const manifest = (await readJsonSnapshot(manifestPath, "staged 视频包 manifest")).value;
  if (!Array.isArray(manifest.files)) fail("verify-failed", "staged 视频包 manifest.files 无效。 ");
  let matched = 0;
  manifest.files = manifest.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || (entry as Record<string, unknown>).path !== `${authority.unitId}_labeled.png`) return entry;
    matched += 1;
    return { ...(entry as Record<string, unknown>), sha256: authority.labeledSha256 };
  });
  if (matched !== 1) fail("verify-failed", "staged 视频包 manifest 未唯一列出总 labeled。 ");
  await writeFile(manifestPath, serializeStudioCanonicalJsonPretty(manifest), { flag: "w", mode: 0o600 });
}

async function installStudioReviewProjectionInputs(
  external: ResolvedExternalInput,
  runtime: SnapshotRuntime,
): Promise<void> {
  if (external.projectionMode !== "studio-review-derived") return;
  const rawSource = runtime.dependencyPaths.get(external.rawRelativePath);
  if (!rawSource) fail("storage-invalid", "Studio 派生 raw 未进入隔离运行快照。 ");
  const rawDependency = external.dependencies.find((item) => item.relativePath === external.rawRelativePath);
  if (!rawDependency) fail("storage-invalid", "Studio 派生 raw 未进入冻结依赖闭包。 ");
  const entries = [
    {
      relativePath: external.rawRelativePath,
      source: rawSource,
      destination: path.join(external.productionRoot, ...external.rawRelativePath.split("/")),
      sha256: rawDependency.snapshot.sha256,
    },
    {
      relativePath: external.sourceSpecRelativePath,
      source: runtime.sourceSpecPath,
      destination: external.sourceSpecPath,
      sha256: external.sourceSpecSha256,
    },
  ];
  for (const entry of entries) {
    const parentRelative = path.posix.dirname(entry.relativePath);
    if (parentRelative !== ".") {
      await assertSafeRelativeChain(external.productionRoot, parentRelative, "directory-or-missing");
    }
    const parent = path.dirname(entry.destination);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (parentRelative !== ".") {
      await assertSafeRelativeChain(external.productionRoot, parentRelative, "directory-or-missing");
    }
    const metadata = await lstat(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(parent) !== parent
      || !pathInside(entry.destination, external.productionRoot)) {
      fail("destination-conflict", "Studio 派生视频输入父目录不是安全真实目录。 ");
    }
    await installFileNoClobber(entry.source, entry.destination, entry.sha256);
  }
}

interface StudioVideoPackageInstallDestination extends StudioVideoPackageReceiptStorage {
  parentPath: string;
  packagePath: string;
}

async function prepareInstallParent(
  root: string,
  parentRelativePath: string,
  label: string,
): Promise<string> {
  const normalized = normalizeRelative(parentRelativePath, `${label}.parentRelativePath`);
  await assertSafeRelativeChain(root, normalized, "directory-or-missing");
  const parentPath = path.join(root, ...normalized.split("/"));
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  await assertSafeRelativeChain(root, normalized, "directory-or-missing");
  const canonical = await canonicalDirectory(parentPath, label);
  if (!pathInside(canonical, root)) fail("storage-invalid", `${label} 逃逸根目录。`);
  return canonical;
}

async function externalInstallDestination(
  external: ResolvedExternalInput,
  intent: StudioVideoPackageExportIntent,
): Promise<StudioVideoPackageInstallDestination> {
  const parentPath = await prepareInstallParent(
    external.productionRoot,
    external.outputRootRelativePath,
    "视频包正式外部目录",
  );
  const packagePath = path.join(external.productionRoot, ...intent.packageRelativePath.split("/"));
  if (parentPath !== external.outputRootPath || packagePath !== external.packagePath
    || path.dirname(packagePath) !== parentPath || !pathInside(packagePath, external.productionRoot)) {
    fail("storage-invalid", "视频包正式外部安装目标身份无效。 ");
  }
  return {
    storageKind: "external-production",
    storageRelativePath: intent.packageRelativePath,
    parentPath,
    packagePath,
  };
}

async function managedEvidenceInstallDestination(
  managedRoot: string,
  intent: StudioVideoPackageExportIntent,
): Promise<StudioVideoPackageInstallDestination> {
  const storageRelativePath = managedEvidenceRelativePath(intent);
  const parentRelativePath = path.posix.dirname(storageRelativePath);
  const parentPath = await prepareInstallParent(managedRoot, parentRelativePath, "视频包 Studio 托管证据目录");
  const packagePath = path.join(managedRoot, ...storageRelativePath.split("/"));
  if (path.dirname(packagePath) !== parentPath || !pathInside(packagePath, managedRoot)) {
    fail("storage-invalid", "视频包 Studio 托管证据目标身份无效。 ");
  }
  return {
    storageKind: "managed-evidence",
    storageRelativePath,
    parentPath,
    packagePath,
  };
}

async function receiptPackagePath(
  databasePath: string,
  managedRoot: string,
  external: Pick<ResolvedExternalInput, "productionRoot" | "packagePath">,
  intent: StudioVideoPackageExportIntent,
  receipt: StudioVideoPackageVerifyReceipt,
  projectionDatabase?: DatabaseSync,
): Promise<{ packagePath: string; storageRelativePath: string; relocated: boolean }> {
  let expectedRelativePath = receipt.storageKind === "external-production"
    ? intent.packageRelativePath
    : managedEvidenceRelativePath(intent);
  let root = receipt.storageKind === "external-production" ? external.productionRoot : managedRoot;
  let relocated = false;
  const ownedDb = projectionDatabase ? null : openDatabase(databasePath, false);
  const db = projectionDatabase ?? ownedDb!;
  try {
    const archivedRow = db.prepare(`SELECT publication.*
      FROM studio_video_package_publication_intents publication
      JOIN studio_video_package_publication_receipts completed ON completed.publication_id=publication.publication_id
      WHERE publication.prior_external_intent_id=? AND publication.prior_external_receipt_id=? LIMIT 1`)
      .get(intent.intentId, receipt.receiptId) as unknown as PublicationIntentRow | undefined;
    const publishedRow = db.prepare(`SELECT publication.*
      FROM studio_video_package_publication_intents publication
      JOIN studio_video_package_publication_receipts completed ON completed.publication_id=publication.publication_id
      WHERE publication.successor_intent_id=? AND publication.successor_receipt_id=? LIMIT 1`)
      .get(intent.intentId, receipt.receiptId) as unknown as PublicationIntentRow | undefined;
    if (archivedRow) {
      const publication = publicationIntentFromRow(archivedRow);
      expectedRelativePath = publication.archiveRelativePath;
      root = external.productionRoot;
      relocated = true;
    } else if (publishedRow) {
      const publication = publicationIntentFromRow(publishedRow);
      expectedRelativePath = publication.packageRelativePath;
      root = external.productionRoot;
      relocated = true;
    }
  } finally {
    ownedDb?.close();
  }
  if (receipt.storageRelativePath !== expectedRelativePath
    && !relocated) {
    fail("storage-invalid", `视频包 receipt ${receipt.receiptId} 的存储投影无效。`);
  }
  if (!relocated && receipt.manifestRelativePath !== `${expectedRelativePath}/manifest.json`) {
    fail("storage-invalid", `视频包 receipt ${receipt.receiptId} 的 manifest 投影无效。`);
  }
  const packagePath = path.join(root, ...expectedRelativePath.split("/"));
  if (!pathInside(packagePath, root)
    || (!relocated && receipt.storageKind === "external-production" && packagePath !== external.packagePath)) {
    fail("storage-invalid", `视频包 receipt ${receipt.receiptId} 的目录身份逃逸。`);
  }
  const metadata = await lstat(packagePath).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink() || await realpath(packagePath) !== packagePath) {
    fail("destination-conflict", `视频包 receipt ${receipt.receiptId} 的落盘目录缺失或不安全。`);
  }
  return { packagePath, storageRelativePath: expectedRelativePath, relocated };
}

async function installStagedPackage(
  intent: StudioVideoPackageExportIntent,
  external: ResolvedExternalInput,
  authority: ResolvedAuthority,
  stagedPackage: string,
  stagedManifest: Awaited<ReturnType<typeof validateManifest>>,
  destination: StudioVideoPackageInstallDestination,
  assertCurrentBeforePublish: () => Promise<void>,
): Promise<Awaited<ReturnType<typeof validateManifest>>> {
  const expectedClaim = createInstallClaim(intent, stagedManifest.manifestSha256, destination.storageRelativePath);
  const existingTarget = await lstat(destination.packagePath).catch(() => null);
  if (existingTarget) fail("destination-conflict", `视频包目标已存在，禁止安装期覆盖：${destination.storageRelativePath}`);
  const installingPath = path.join(
    destination.parentPath,
    `.${authority.unitId}.${intent.intentId}.installing`,
  );
  if (!pathInside(installingPath, destination.parentPath)) fail("storage-invalid", "视频包 installing 路径逃逸。 ");
  let installingMetadata = await lstat(installingPath).catch(() => null);
  if (!installingMetadata) {
    await mkdir(installingPath, { mode: 0o700 });
    await syncExactDirectory(destination.parentPath, "install.parentAfterMkdir");
    installingMetadata = await lstat(installingPath);
  }
  if (!installingMetadata.isDirectory() || installingMetadata.isSymbolicLink()
    || await realpath(installingPath) !== installingPath) {
    fail("destination-conflict", "视频包隐藏安装目录不是安全真实目录。 ");
  }
  const claimPath = path.join(installingPath, INSTALL_CLAIM_FILE);
  const existingClaim = await readInstallClaim(claimPath);
  if (!existingClaim) {
    const existingNames = await readdir(installingPath);
    if (existingNames.length > 0) {
      // claim 已移除只可能表示完整安装在原子 rename 前崩溃；必须以 staged 身份完整证明。
      const completed = await validateManifest(external, authority, installingPath, destination.storageRelativePath);
      assertManifestIdentityEqual(stagedManifest, completed, "无 claim 的隐藏安装目录不等于当前 staged 包。 ");
      if (await lstat(destination.packagePath).catch(() => null)) {
        fail("destination-conflict", `视频包目标在恢复期间出现：${destination.storageRelativePath}`);
      }
      await assertCurrentBeforePublish();
      await renameDirectoryNoReplace(installingPath, destination.packagePath);
      await syncExactDirectory(destination.parentPath, "install.parentAfterRecoveryRename");
      return validateManifest(external, authority, destination.packagePath, destination.storageRelativePath);
    }
    await writeInstallClaim(claimPath, expectedClaim);
  } else if (digest(existingClaim) !== digest(expectedClaim)) {
    fail("destination-conflict", `视频包 ${destination.storageRelativePath} 的 install claim 属于其他输入。`);
  }
  const stagedNames = await readdir(stagedPackage);
  for (const name of stagedNames.sort((left, right) => left.localeCompare(right, "en"))) {
    if (path.basename(name) !== name || name === INSTALL_CLAIM_FILE) fail("verify-failed", `staged 视频包文件名无效：${name}`);
    const source = path.join(stagedPackage, name);
    const sourceSnapshot = await readStableFile(source);
    await installFileNoClobber(
      source,
      path.join(installingPath, name),
      sourceSnapshot.sha256,
      { repairMismatchedExisting: true },
    );
  }
  const targetNames = (await readdir(installingPath)).sort((left, right) => left.localeCompare(right, "en"));
  const expectedNames = [...stagedNames, INSTALL_CLAIM_FILE].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(targetNames) !== JSON.stringify(expectedNames)) {
    fail("destination-conflict", "视频包隐藏安装目录包含 staged 集合之外的文件。 ");
  }
  // 每个文件已由 dirfd 安装器 fsync；先同步完整目录，再移除 claim。此后若掉电，
  // 无 claim 目录必然已具备可由 validateManifest 重验的完整耐久文件集。
  await syncExactDirectory(installingPath, "install.installingComplete");
  await unlink(claimPath);
  await syncExactDirectory(installingPath, "install.installingClaimRemoved");
  const completed = await validateManifest(external, authority, installingPath, destination.storageRelativePath);
  assertManifestIdentityEqual(stagedManifest, completed, "视频包隐藏安装完成后身份与 staged 包不一致。 ");
  if (await lstat(destination.packagePath).catch(() => null)) {
    fail("destination-conflict", `视频包目标在原子发布前出现：${destination.storageRelativePath}`);
  }
  // 隐藏目录准备可以在最后一次 source 读取之后耗时较久。原子 rename
  // 才是正式可见发布边界，因此必须在该系统调用前再次执行完整 CAS。
  await assertCurrentBeforePublish();
  await renameDirectoryNoReplace(installingPath, destination.packagePath);
  await syncExactDirectory(destination.parentPath, "install.parentAfterRename");
  const manifest = await validateManifest(external, authority, destination.packagePath, destination.storageRelativePath);
  assertManifestIdentityEqual(stagedManifest, manifest, "视频包原子发布后身份与 staged 包不一致。 ");
  return manifest;
}

async function bindBuildCommandOperation(
  databasePath: string,
  operationIdValue: string,
  intent: StudioVideoPackageExportIntent,
  receipt: StudioVideoPackageVerifyReceipt,
): Promise<void> {
  const operationId = normalizeId(operationIdValue, "commandRequestHash");
  if (!SHA256_PATTERN.test(operationId)) fail("operation-conflict", "build commandRequestHash 必须是 SHA-256。");
  const db = openDatabase(databasePath, true);
  try {
    runTransaction(db, () => {
      const intentRow = intentRowById(db, intent.intentId);
      const receiptRow = receiptRowByIntent(db, intent.intentId);
      if (!intentRow || intentFromRow(intentRow).fingerprint !== intent.fingerprint
        || !receiptRow || receiptFromRow(receiptRow).fingerprint !== receipt.fingerprint
        || receiptRow.receipt_id !== receipt.receiptId) {
        fail("storage-invalid", "build command operation 绑定前 intent/receipt 身份未闭合。");
      }
      const directIntent = db.prepare("SELECT * FROM studio_video_package_export_intents WHERE operation_id=?")
        .get(operationId) as unknown as IntentRow | undefined;
      if (directIntent) {
        fail("operation-conflict", `build commandRequestHash 已被 prepare intent 占用：${operationId}`);
      }
      const existingRow = db.prepare("SELECT * FROM studio_video_package_operation_aliases WHERE operation_id=?")
        .get(operationId) as unknown as OperationAliasRow | undefined;
      if (existingRow) {
        const existing = operationAliasFromRow(existingRow);
        if (existing.intent_id !== intent.intentId || existing.input_fingerprint !== intent.inputFingerprint) {
          fail("operation-conflict", `build commandRequestHash 已绑定其他 intent：${operationId}`);
        }
        return;
      }
      const createdAt = new Date().toISOString();
      const semantic = {
        operationId,
        inputFingerprint: intent.inputFingerprint,
        intentId: intent.intentId,
        createdAt,
      };
      db.prepare(`INSERT INTO studio_video_package_operation_aliases(
        operation_id, input_fingerprint, intent_id, created_at, fingerprint
      ) VALUES(?, ?, ?, ?, ?)`).run(
        operationId,
        intent.inputFingerprint,
        intent.intentId,
        createdAt,
        digest(semantic),
      );
      const inserted = db.prepare("SELECT * FROM studio_video_package_operation_aliases WHERE operation_id=?")
        .get(operationId) as unknown as OperationAliasRow | undefined;
      if (!inserted || operationAliasFromRow(inserted).intent_id !== intent.intentId) {
        fail("storage-invalid", "build command operation alias 未落盘。");
      }
    });
  } finally {
    db.close();
  }
}

export async function buildAndVerifyStudioVideoPackage(
  projectRoot: string,
  intentIdValue: string,
  options: BuildAndVerifyStudioVideoPackageOptions = {},
): Promise<{ intent: StudioVideoPackageExportIntent; receipt: StudioVideoPackageVerifyReceipt; replayed: boolean; adoptedExisting: boolean }> {
  const intentId = normalizeId(intentIdValue, "intentId");
  const databasePath = await generationDatabasePath(projectRoot);
  const db = openDatabase(databasePath, true);
  let intent: StudioVideoPackageExportIntent;
  let priorExternal: ReturnType<typeof priorExternalDestinationReceipt>;
  let unreceiptedAncestors: StudioVideoPackageExportIntent[];
  try {
    const row = intentRowById(db, intentId);
    if (!row) fail("intent-not-found", `视频包 intent 不存在：${intentId}`);
    intent = intentFromRow(row);
    if (options.expectedRevision !== undefined
      && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1
        || intent.unitRevision !== options.expectedRevision)) {
      fail(
        "operation-conflict",
        `视频包 intent unit revision ${intent.unitRevision} 与 expectedRevision ${String(options.expectedRevision)} 不一致。`,
      );
    }
    priorExternal = priorExternalDestinationReceipt(db, intent);
    unreceiptedAncestors = unreceiptedAncestorIntents(db, intent);
  } finally {
    db.close();
  }
  const shell = await inspectManagedProject(projectRoot);
  const runBuild = () => withProjectLock(
      shell.paths.root,
      `studio-video-package-${intent.unitId}`,
      async () => {
      const authority = await authorityFromIntent(shell.paths.root, intent);
      await assertMediaClosure(shell.paths.root, authority);
      const external = await externalFromIntent(shell.paths.root, intent, authority);

      const receiptDb = openDatabase(databasePath, true);
      let existingReceipt: StudioVideoPackageVerifyReceipt | null = null;
      try {
        const row = receiptRowByIntent(receiptDb, intent.intentId);
        existingReceipt = row ? receiptFromRow(row) : null;
      } finally {
        receiptDb.close();
      }
      if (existingReceipt) {
        if (options.destinationPolicy === "managed-evidence-only"
          && existingReceipt.storageKind !== "managed-evidence") {
          fail("operation-conflict", "managed-evidence-only 命令拒绝重放外部生产根 receipt。 ");
        }
        // receipt replay 永远只做 Core 内容寻址复核，不再次执行外部 Python。
        const storage = await receiptPackagePath(databasePath, shell.paths.root, external, intent, existingReceipt);
        const manifest = await validateManifest(
          external,
          authority,
          storage.packagePath,
          storage.storageRelativePath,
        );
        assertReceiptMatchesManifest(existingReceipt, manifest, intent.packageRelativePath, storage.relocated);
        await assertIntentManagedSourceCurrent(
          shell.paths.root,
          intent,
          authority,
          external.managedSource?.fingerprint,
        );
        return { intent, receipt: existingReceipt, replayed: true, adoptedExisting: false };
      }

      let existingTarget = await lstat(external.packagePath).catch(() => null);
      if (existingTarget) {
        if (!existingTarget.isDirectory() || existingTarget.isSymbolicLink()
          || await realpath(external.packagePath) !== external.packagePath) {
          fail("destination-conflict", `视频包目标已存在但不是安全目录：${external.packageRelativePath}`);
        }
      }
      if (existingTarget && !priorExternal && options.destinationPolicy !== "managed-evidence-only") {
        const existingClaim = await readInstallClaim(path.join(external.packagePath, INSTALL_CLAIM_FILE));
        if (!existingClaim) {
          try {
            const coreManifest = await validateManifest(external, authority);
            const verified = await withSnapshotRuntime(shell.paths.root, intent, external, async (runtime) => {
              await buildVideoPackageInRuntime(external, authority, runtime);
              const rebuiltPackage = path.join(runtime.outputRoot, authority.unitId);
              await bindStagedAuthorityLabeled(external, authority, rebuiltPackage);
              const rebuilt = await verifyPackageWithBuilder(
                external,
                authority,
                rebuiltPackage,
                runtime.builderPath,
              );
              const existing = await verifyPackageWithBuilder(
                external,
                authority,
                external.packagePath,
                runtime.builderPath,
              );
              assertManifestIdentityEqual(
                coreManifest,
                existing,
                `既有视频包 ${external.packageRelativePath} 的 builder/Core 验证结果不一致。`,
              );
              assertManifestIdentityEqual(
                rebuilt,
                existing,
                `既有视频包 ${external.packageRelativePath} 不是当前冻结 builder/spec 的确定性重建结果。`,
              );
              return existing;
            });
            if (intent.authorityKind === "studio-review" && verified.i2vStaticStatus !== "ready") {
              fail(
                "destination-conflict",
                `既有视频包 ${external.packageRelativePath} 的静态输入未就绪，不能采纳为新 Studio 正式外部产物。`,
              );
            }
            await assertIntentManagedSourceCurrent(
              shell.paths.root,
              intent,
              authority,
              external.managedSource?.fingerprint,
            );
            const inserted = await insertReceipt(databasePath, shell.paths.root, intent, verified, {
              storageKind: "external-production",
              storageRelativePath: intent.packageRelativePath,
            }, external, authority, external.packagePath, async () => {
              await waitForReceiptManagedSourceCasTestBarrier(shell.paths.root, intent);
              await assertIntentManagedSourceCurrent(
                shell.paths.root,
                intent,
                authority,
                external.managedSource?.fingerprint,
              );
            });
            return { intent, receipt: inserted.receipt, replayed: inserted.replayed, adoptedExisting: true };
          } catch (error) {
            const names = await readdir(external.packagePath).catch(() => [] as string[]);
            if (names.length > 0) {
              await assertIntentManagedSourceCurrent(
                shell.paths.root,
                intent,
                authority,
                external.managedSource?.fingerprint,
              );
              const archivedOwner = await archiveUnreceiptedAncestorPackage(
                databasePath,
                intent,
                unreceiptedAncestors,
                external.packagePath,
                () => assertIntentManagedSourceCurrent(
                  shell.paths.root,
                  intent,
                  authority,
                  external.managedSource?.fingerprint,
                ),
              );
              if (archivedOwner) {
                existingTarget = null;
                // 旧目录已按 ancestor intent 内容地址无损归档；当前 successor
                // 继续走隔离重建与最终 CAS，不采纳旧包，也不覆盖任何文件。
              } else if (error instanceof StudioVideoPackageError) {
                throw new StudioVideoPackageError(
                  "destination-conflict",
                  `既有视频包 ${external.packageRelativePath} 无法证明属于当前 intent，禁止覆盖。`,
                  [error.message, ...error.details],
                  { cause: error },
                );
              } else {
                throw error;
              }
            }
            // mkdir 后、claim 前崩溃只会留下安全空目录；同 intent 锁内允许继续写 claim。
          }
        }
      }

      return withSnapshotRuntime(shell.paths.root, intent, external, async (runtime) => {
        await buildVideoPackageInRuntime(external, authority, runtime);
        const stagedPackage = path.join(runtime.outputRoot, authority.unitId);
        await bindStagedAuthorityLabeled(external, authority, stagedPackage);
        const stagedManifest = await verifyPackageWithBuilder(
          external,
          authority,
          stagedPackage,
          runtime.builderPath,
        );
        // builder、裁格与机械验收只发生在隔离 runtime。任何受管证据目录或
        // production root 写入之前，必须在最终安装边界重新读取完整
        // managed-source/Observation CAS；测试 barrier 用于证明漂移发生时
        // 目标路径仍未被创建。
        await waitForFinalManagedSourceCasTestBarrier(shell.paths.root, intent);
        const destination = external.sourceKind === "dudu-readonly"
          && options.destinationPolicy !== "managed-evidence-only"
          && stagedManifest.i2vStaticStatus === "ready" && !priorExternal && !existingTarget
          ? await externalInstallDestination(external, intent)
          : await managedEvidenceInstallDestination(shell.paths.root, intent);
        if (destination.storageKind === "external-production") {
          await installStudioReviewProjectionInputs(external, runtime);
          // 投影文件使用内容地址且 no-clobber；正式包隐藏 staging/rename 前再次
          // 绑定 source，缩小投影与目录发布之间的漂移窗口。
          await assertIntentManagedSourceCurrent(
            shell.paths.root,
            intent,
            authority,
            external.managedSource?.fingerprint,
          );
        }
        const destinationExisting = await lstat(destination.packagePath).catch(() => null);
        let installedManifest: Awaited<ReturnType<typeof validateManifest>>;
        let adoptedExisting = false;
        if (destinationExisting) {
          if (!destinationExisting.isDirectory() || destinationExisting.isSymbolicLink()
            || await realpath(destination.packagePath) !== destination.packagePath) {
            fail("destination-conflict", `视频包恢复目标不是安全目录：${destination.storageRelativePath}`);
          }
          installedManifest = await validateManifest(
            external,
            authority,
            destination.packagePath,
            destination.storageRelativePath,
          );
          assertManifestIdentityEqual(
            stagedManifest,
            installedManifest,
            `视频包恢复目标 ${destination.storageRelativePath} 不等于当前确定性重建结果。`,
          );
          adoptedExisting = true;
        } else {
          installedManifest = await installStagedPackage(
            intent,
            external,
            authority,
            stagedPackage,
            stagedManifest,
            destination,
            () => assertIntentManagedSourceCurrent(
              shell.paths.root,
              intent,
              authority,
              external.managedSource?.fingerprint,
            ),
          );
          if (process.env.NODE_ENV === "test"
            && process.env.P30_TEST_INSTALL_FAULT === "after-rename-before-receipt") {
            fail(
              "builder-failed",
              "视频包测试故障：目标 rename 已完成、receipt 尚未写入。",
            );
          }
        }
        const inserted = await insertReceipt(
          databasePath,
          shell.paths.root,
          intent,
          installedManifest,
          destination,
          external,
          authority,
          destination.packagePath,
          async () => {
            await waitForReceiptManagedSourceCasTestBarrier(shell.paths.root, intent);
            await assertIntentManagedSourceCurrent(
              shell.paths.root,
              intent,
              authority,
              external.managedSource?.fingerprint,
            );
          },
        );
        return { intent, receipt: inserted.receipt, replayed: inserted.replayed, adoptedExisting };
      });
    },
      { timeoutMs: 15_000, staleMs: EXECUTION_TIMEOUT_MS * 2 },
    );
  // command-bus 已以 studio-mutation → unit package lock 的固定顺序调用本函数。
  // 直接 Core 调用也必须取得同一项目级 fence，既补齐测试/恢复调用的线性化边界，
  // 又避免在 command-bus 已持锁时递归获取非重入文件锁。
  const operationContext = getOperationContext();
  const result = operationContext?.command === "build_studio_video_package"
    ? await runBuild()
    : await withProjectLock(
      shell.paths.root,
      "studio-mutation",
      runBuild,
      { timeoutMs: 15_000, staleMs: EXECUTION_TIMEOUT_MS * 2 },
    );
  if (options.commandRequestHash) {
    await bindBuildCommandOperation(
      databasePath,
      options.commandRequestHash,
      result.intent,
      result.receipt,
    );
  }
  return result;
}

function publicationArchiveRelativePath(
  priorReceipt: StudioVideoPackageVerifyReceipt,
  unitId: string,
): string {
  return `${OUTPUT_ROOT_RELATIVE_PATH}/.studio-video-package-history/${priorReceipt.receiptId}/${unitId}`;
}

export async function prepareStudioVideoPackagePublication(
  projectRoot: string,
  input: PrepareStudioVideoPackagePublicationInput,
): Promise<{ publication: StudioVideoPackagePublicationIntent; replayed: boolean }> {
  const operationId = normalizeId(input.operationId, "operationId");
  const successorIntentId = normalizeId(input.successorIntentId, "successorIntentId");
  const databasePath = await generationDatabasePath(projectRoot);
  const db = openDatabase(databasePath, true);
  try {
    return runTransaction(db, () => {
      const operationRow = db.prepare("SELECT * FROM studio_video_package_publication_intents WHERE operation_id=?")
        .get(operationId) as unknown as PublicationIntentRow | undefined;
      if (operationRow) {
        const existing = publicationIntentFromRow(operationRow);
        if (existing.successorIntentId !== successorIntentId) {
          fail("operation-conflict", `operationId=${operationId} 已绑定其他视频包 publication。`);
        }
        return { publication: existing, replayed: true };
      }
      const successorPublicationRow = db.prepare(
        "SELECT * FROM studio_video_package_publication_intents WHERE successor_intent_id=?",
      ).get(successorIntentId) as unknown as PublicationIntentRow | undefined;
      if (successorPublicationRow) {
        const existing = publicationIntentFromRow(successorPublicationRow);
        fail("operation-conflict", `successorIntentId=${successorIntentId} 已由其他 operation 准备 publication。`, [
          `existingOperationId=${existing.operationId}`,
        ]);
      }
      const successorRow = intentRowById(db, successorIntentId);
      const successorReceiptRow = receiptRowByIntent(db, successorIntentId);
      if (!successorRow || !successorReceiptRow) {
        fail("authority-not-ready", `视频包 successor ${successorIntentId} 尚未完成机械 verify。`);
      }
      const successor = intentFromRow(successorRow);
      const successorReceipt = receiptFromRow(successorReceiptRow);
      if (successorReceipt.storageKind !== "managed-evidence" || successorReceipt.i2vStaticStatus !== "ready") {
        fail("authority-not-ready", `视频包 successor ${successorIntentId} 不是 ready managed evidence。`);
      }
      const destinationHeadRow = db.prepare(`SELECT * FROM studio_video_package_export_intents
        WHERE production_root=? AND package_relative_path=?
        ORDER BY sequence DESC LIMIT 1`)
        .get(successor.productionRoot, successor.packageRelativePath) as unknown as IntentRow | undefined;
      if (!destinationHeadRow || intentFromRow(destinationHeadRow).intentId !== successor.intentId) {
        fail(
          "destination-conflict",
          `视频包 successor ${successorIntentId} 不是目标当前 Head，禁止冻结 publication。`,
        );
      }
      const pendingPublicationRow = db.prepare(`
        SELECT publication.*
        FROM studio_video_package_publication_intents publication
        LEFT JOIN studio_video_package_publication_receipts receipt
          ON receipt.publication_id=publication.publication_id
        WHERE publication.production_root=?
          AND publication.package_relative_path=?
          AND receipt.publication_id IS NULL
        ORDER BY publication.sequence ASC
        LIMIT 1
      `).get(
        successor.productionRoot,
        successor.packageRelativePath,
      ) as unknown as PublicationIntentRow | undefined;
      if (pendingPublicationRow) {
        const pending = publicationIntentFromRow(pendingPublicationRow);
        fail(
          "destination-conflict",
          `视频包目标已有未完成 publication，必须先重放或对账：${pending.publicationId}`,
        );
      }
      const prior = priorExternalDestinationReceipt(db, successor);
      if (!prior) fail("authority-not-ready", `视频包 successor ${successorIntentId} 没有可换代的当前外部版本。`);
      let cursor: StudioVideoPackageExportIntent | null = successor;
      let priorIsAncestor = false;
      const visited = new Set<string>();
      while (cursor?.supersedesIntentId) {
        if (visited.has(cursor.intentId)) fail("storage-invalid", "视频包 intent 换代链存在环。 ");
        visited.add(cursor.intentId);
        if (cursor.supersedesIntentId === prior.intent.intentId) {
          priorIsAncestor = true;
          break;
        }
        const parentRow = intentRowById(db, cursor.supersedesIntentId);
        if (!parentRow) fail("storage-invalid", "视频包 intent 换代链存在缺口。 ");
        cursor = intentFromRow(parentRow);
      }
      if (!priorIsAncestor || prior.intent.productionRoot !== successor.productionRoot
        || prior.intent.packageRelativePath !== successor.packageRelativePath) {
        fail("storage-invalid", "视频包 publication 的当前外部版本不在 successor 祖先链。 ");
      }
      const archiveRelativePath = publicationArchiveRelativePath(prior.receipt, successor.unitId);
      const createdAt = new Date().toISOString();
      const identityInput = {
        schemaVersion: 1 as const,
        kind: "studio-video-package-publication-intent" as const,
        operationId,
        successorIntentId: successor.intentId,
        successorReceiptId: successorReceipt.receiptId,
        priorExternalIntentId: prior.intent.intentId,
        priorExternalReceiptId: prior.receipt.receiptId,
        productionRoot: successor.productionRoot,
        packageRelativePath: successor.packageRelativePath,
        archiveRelativePath,
        createdAt,
      };
      const publicationId = `studio-video-publication-${digest(identityInput).slice(0, 40)}`;
      const semantic = { ...identityInput, publicationId };
      const fingerprint = digest(semantic);
      db.prepare(`INSERT INTO studio_video_package_publication_intents(
        publication_id, operation_id, successor_intent_id, successor_receipt_id,
        prior_external_intent_id, prior_external_receipt_id, production_root,
        package_relative_path, archive_relative_path, created_at, fingerprint
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        publicationId,
        operationId,
        successor.intentId,
        successorReceipt.receiptId,
        prior.intent.intentId,
        prior.receipt.receiptId,
        successor.productionRoot,
        successor.packageRelativePath,
        archiveRelativePath,
        createdAt,
        fingerprint,
      );
      const inserted = publicationIntentRowById(db, publicationId);
      if (!inserted) fail("storage-invalid", `视频包 publication ${publicationId} 未落盘。`);
      return { publication: publicationIntentFromRow(inserted), replayed: false };
    });
  } finally {
    db.close();
  }
}

export async function publishStudioVideoPackageReplacement(
  projectRoot: string,
  publicationIdValue: string,
): Promise<{
  publication: StudioVideoPackagePublicationIntent;
  receipt: StudioVideoPackagePublicationReceipt;
  replayed: boolean;
}> {
  const publicationId = normalizeId(publicationIdValue, "publicationId");
  const databasePath = await generationDatabasePath(projectRoot);
  const initialDb = openDatabase(databasePath, true);
  let publication: StudioVideoPackagePublicationIntent;
  let successor: StudioVideoPackageExportIntent;
  let successorReceipt: StudioVideoPackageVerifyReceipt;
  let prior: StudioVideoPackageExportIntent;
  let priorReceipt: StudioVideoPackageVerifyReceipt;
  try {
    const publicationRow = publicationIntentRowById(initialDb, publicationId);
    if (!publicationRow) fail("intent-not-found", `视频包 publication 不存在：${publicationId}`);
    publication = publicationIntentFromRow(publicationRow);
    const successorRow = intentRowById(initialDb, publication.successorIntentId);
    const successorReceiptRow = receiptRowByIntent(initialDb, publication.successorIntentId);
    const priorRow = intentRowById(initialDb, publication.priorExternalIntentId);
    const priorReceiptRow = receiptRowByIntent(initialDb, publication.priorExternalIntentId);
    if (!successorRow || !successorReceiptRow || !priorRow || !priorReceiptRow) {
      fail("storage-invalid", `视频包 publication ${publicationId} 的 intent/receipt FK 投影不闭合。`);
    }
    successor = intentFromRow(successorRow);
    successorReceipt = receiptFromRow(successorReceiptRow);
    prior = intentFromRow(priorRow);
    priorReceipt = receiptFromRow(priorReceiptRow);
    if (successorReceipt.receiptId !== publication.successorReceiptId
      || priorReceipt.receiptId !== publication.priorExternalReceiptId
      || successor.productionRoot !== publication.productionRoot
      || successor.packageRelativePath !== publication.packageRelativePath
      || publication.archiveRelativePath !== publicationArchiveRelativePath(priorReceipt, successor.unitId)) {
      fail("storage-invalid", `视频包 publication ${publicationId} 的冻结身份无效。`);
    }
  } finally {
    initialDb.close();
  }
  const shell = await inspectManagedProject(projectRoot);
  return withProjectLock(shell.paths.root, `studio-video-package-${successor.unitId}`, async () => {
    let completed: StudioVideoPackagePublicationReceipt | null = null;
    const lockedDb = openDatabase(databasePath, true);
    try {
      const lockedPublicationRow = publicationIntentRowById(lockedDb, publication.publicationId);
      if (!lockedPublicationRow) {
        fail("storage-invalid", `视频包 publication ${publication.publicationId} 在执行锁内消失。`);
      }
      const lockedPublication = publicationIntentFromRow(lockedPublicationRow);
      if (lockedPublication.fingerprint !== publication.fingerprint) {
        fail("storage-invalid", `视频包 publication ${publication.publicationId} 在执行锁内漂移。`);
      }
      publication = lockedPublication;
      const successorRow = intentRowById(lockedDb, publication.successorIntentId);
      const successorReceiptRow = receiptRowByIntent(lockedDb, publication.successorIntentId);
      const priorRow = intentRowById(lockedDb, publication.priorExternalIntentId);
      const priorReceiptRow = receiptRowByIntent(lockedDb, publication.priorExternalIntentId);
      if (!successorRow || !successorReceiptRow || !priorRow || !priorReceiptRow) {
        fail("storage-invalid", `视频包 publication ${publication.publicationId} 在执行锁内 FK 不闭合。`);
      }
      successor = intentFromRow(successorRow);
      successorReceipt = receiptFromRow(successorReceiptRow);
      prior = intentFromRow(priorRow);
      priorReceipt = receiptFromRow(priorReceiptRow);
      if (successorReceipt.receiptId !== publication.successorReceiptId
        || priorReceipt.receiptId !== publication.priorExternalReceiptId
        || successor.productionRoot !== publication.productionRoot
        || successor.packageRelativePath !== publication.packageRelativePath
        || publication.archiveRelativePath !== publicationArchiveRelativePath(priorReceipt, successor.unitId)) {
        fail("storage-invalid", `视频包 publication ${publication.publicationId} 锁内冻结身份无效。`);
      }
      const completedRow = publicationReceiptRowByPublication(lockedDb, publication.publicationId);
      completed = completedRow ? publicationReceiptFromRow(completedRow) : null;
      if (!completed) {
        const destinationHeadRow = lockedDb.prepare(`SELECT * FROM studio_video_package_export_intents
          WHERE production_root=? AND package_relative_path=?
          ORDER BY sequence DESC LIMIT 1`)
          .get(successor.productionRoot, successor.packageRelativePath) as unknown as IntentRow | undefined;
        if (!destinationHeadRow || intentFromRow(destinationHeadRow).intentId !== successor.intentId) {
          fail(
            "destination-conflict",
            `视频包 publication ${publication.publicationId} 的 successor 已不是目标 Head。`,
          );
        }
        const pendingRows = lockedDb.prepare(`
          SELECT publication.*
          FROM studio_video_package_publication_intents publication
          LEFT JOIN studio_video_package_publication_receipts receipt
            ON receipt.publication_id=publication.publication_id
          WHERE publication.production_root=?
            AND publication.package_relative_path=?
            AND receipt.publication_id IS NULL
          ORDER BY publication.sequence ASC
        `).all(
          successor.productionRoot,
          successor.packageRelativePath,
        ) as unknown as PublicationIntentRow[];
        if (pendingRows.length !== 1
          || publicationIntentFromRow(pendingRows[0]!).publicationId !== publication.publicationId) {
          fail(
            "destination-conflict",
            `视频包目标存在多个或错误的未完成 publication，禁止继续发布。`,
          );
        }
      }
    } finally {
      lockedDb.close();
    }
    const successorAuthority = await authorityFromIntent(shell.paths.root, successor);
    const successorExternal = await externalFromIntent(
      shell.paths.root,
      successor,
      successorAuthority,
    );
    const priorContext = prior.schemaVersion === LEGACY_VIDEO_PACKAGE_SCHEMA_VERSION
      ? await legacyPublicationPriorContext(shell.paths.root, prior)
      : await (async () => {
        const authority = await authorityFromIntent(shell.paths.root, prior);
        return {
          authority,
          external: await externalFromIntent(shell.paths.root, prior, authority),
        };
      })();
    const priorAuthority = priorContext.authority;
    const priorExternal = priorContext.external;
    if (completed) {
      const [archivedStorage, publishedStorage] = await Promise.all([
        receiptPackagePath(databasePath, shell.paths.root, priorExternal, prior, priorReceipt),
        receiptPackagePath(databasePath, shell.paths.root, successorExternal, successor, successorReceipt),
      ]);
      const [archived, published] = await Promise.all([
        validateManifest(priorExternal, priorAuthority, archivedStorage.packagePath, archivedStorage.storageRelativePath),
        validateManifest(successorExternal, successorAuthority, publishedStorage.packagePath, publishedStorage.storageRelativePath),
      ]);
      assertReceiptMatchesManifest(priorReceipt, archived, prior.packageRelativePath, true);
      assertReceiptMatchesManifest(successorReceipt, published, successor.packageRelativePath, true);
      if (completed.archivedManifestSha256 !== archived.manifestSha256
        || completed.archivedManifestFingerprint !== archived.manifestFingerprint
        || completed.publishedManifestSha256 !== published.manifestSha256
        || completed.publishedManifestFingerprint !== published.manifestFingerprint) {
        fail("destination-conflict", `视频包 publication ${publication.publicationId} receipt 与当前目录漂移。`);
      }
      return { publication, receipt: completed, replayed: true };
    }

    const successorStorage = await receiptPackagePath(
      databasePath,
      shell.paths.root,
      successorExternal,
      successor,
      successorReceipt,
    );
    const successorManifest = await validateManifest(
      successorExternal,
      successorAuthority,
      successorStorage.packagePath,
      successorStorage.storageRelativePath,
    );
    assertReceiptMatchesManifest(successorReceipt, successorManifest, successor.packageRelativePath, successorStorage.relocated);

    // publication intent 是生产根变更的耐久 journal。归档旧版本这一首次外部
    // mutation 前，必须再次证明 successor 的 managed-source/Observation
    // 仍为当前；若漂移，production root 保持原样。
    await assertIntentManagedSourceCurrent(
      shell.paths.root,
      successor,
      successorAuthority,
      successorExternal.managedSource?.fingerprint,
    );
    const archiveParentRelativePath = path.posix.dirname(publication.archiveRelativePath);
    const archiveParent = await prepareInstallParent(
      publication.productionRoot,
      archiveParentRelativePath,
      "视频包历史外部证据目录",
    );
    const archivePath = path.join(publication.productionRoot, ...publication.archiveRelativePath.split("/"));
    if (path.dirname(archivePath) !== archiveParent || !pathInside(archivePath, publication.productionRoot)) {
      fail("storage-invalid", "视频包 publication archive 路径逃逸。 ");
    }
    let archivedManifest: Awaited<ReturnType<typeof validateManifest>>;
    const archiveMetadata = await lstat(archivePath).catch(() => null);
    if (archiveMetadata) {
      if (!archiveMetadata.isDirectory() || archiveMetadata.isSymbolicLink() || await realpath(archivePath) !== archivePath) {
        fail("destination-conflict", "视频包 publication archive 不是安全目录。 ");
      }
      archivedManifest = await validateManifest(
        priorExternal,
        priorAuthority,
        archivePath,
        publication.archiveRelativePath,
      );
      assertReceiptMatchesManifest(priorReceipt, archivedManifest, prior.packageRelativePath, true);
    } else {
      const currentManifest = await validateManifest(
        priorExternal,
        priorAuthority,
        priorExternal.packagePath,
        prior.packageRelativePath,
      );
      assertReceiptMatchesManifest(priorReceipt, currentManifest, prior.packageRelativePath, true);
      await assertIntentManagedSourceCurrent(
        shell.paths.root,
        successor,
        successorAuthority,
        successorExternal.managedSource?.fingerprint,
      );
      await renameDirectoryNoReplace(priorExternal.packagePath, archivePath);
      for (const directory of new Set([path.dirname(priorExternal.packagePath), archiveParent])) {
        const handle = await open(directory, "r");
        try { await handle.sync(); } finally { await handle.close(); }
      }
      archivedManifest = await validateManifest(
        priorExternal,
        priorAuthority,
        archivePath,
        publication.archiveRelativePath,
      );
      assertManifestIdentityEqual(currentManifest, archivedManifest, "视频包旧外部版本归档后身份漂移。 ");
    }

    let publishedManifest: Awaited<ReturnType<typeof validateManifest>> | null = null;
    const publishedMetadata = await lstat(successorExternal.packagePath).catch(() => null);
    if (publishedMetadata) {
      if (!publishedMetadata.isDirectory() || publishedMetadata.isSymbolicLink()
        || await realpath(successorExternal.packagePath) !== successorExternal.packagePath) {
        fail("destination-conflict", "视频包 publication 正式目标不是安全目录。 ");
      }
      publishedManifest = await validateManifest(
        successorExternal,
        successorAuthority,
        successorExternal.packagePath,
        successor.packageRelativePath,
      );
      assertManifestIdentityEqual(
        successorManifest,
        publishedManifest,
        "视频包 publication 正式目标不是 successor。 ",
      );
    }
    if (!publishedMetadata) {
      await assertIntentManagedSourceCurrent(
        shell.paths.root,
        successor,
        successorAuthority,
        successorExternal.managedSource?.fingerprint,
      );
      await withSnapshotRuntime(shell.paths.root, successor, successorExternal, async (runtime) => {
        await installStudioReviewProjectionInputs(successorExternal, runtime);
      });
      await assertIntentManagedSourceCurrent(
        shell.paths.root,
        successor,
        successorAuthority,
        successorExternal.managedSource?.fingerprint,
      );
      const destination = await externalInstallDestination(successorExternal, successor);
      publishedManifest = await installStagedPackage(
        successor,
        successorExternal,
        successorAuthority,
        successorStorage.packagePath,
        successorManifest,
        destination,
        () => assertIntentManagedSourceCurrent(
          shell.paths.root,
          successor,
          successorAuthority,
          successorExternal.managedSource?.fingerprint,
        ),
      );
    }
    if (!publishedManifest) {
      fail("storage-invalid", `视频包 publication ${publication.publicationId} 未形成正式 manifest。`);
    }
    assertReceiptMatchesManifest(successorReceipt, publishedManifest, successor.packageRelativePath, true);
    await assertIntentManagedSourceCurrent(
      shell.paths.root,
      successor,
      successorAuthority,
      successorExternal.managedSource?.fingerprint,
    );

    const receiptDb = openDatabase(databasePath, true);
    try {
      return runTransaction(receiptDb, () => {
        const existingRow = publicationReceiptRowByPublication(receiptDb, publication.publicationId);
        if (existingRow) return { publication, receipt: publicationReceiptFromRow(existingRow), replayed: true };
        const completedAt = new Date().toISOString();
        const identityInput = {
          schemaVersion: 1 as const,
          kind: "studio-video-package-publication-receipt" as const,
          publicationId: publication.publicationId,
          archivedManifestSha256: archivedManifest.manifestSha256,
          archivedManifestFingerprint: archivedManifest.manifestFingerprint,
          publishedManifestSha256: publishedManifest.manifestSha256,
          publishedManifestFingerprint: publishedManifest.manifestFingerprint,
          completedAt,
        };
        const publicationReceiptId = `studio-video-publication-receipt-${digest(identityInput).slice(0, 40)}`;
        const semantic = { ...identityInput, publicationReceiptId };
        const fingerprint = digest(semantic);
        receiptDb.prepare(`INSERT INTO studio_video_package_publication_receipts(
          publication_receipt_id, publication_id, archived_manifest_sha256,
          archived_manifest_fingerprint, published_manifest_sha256,
          published_manifest_fingerprint, completed_at, fingerprint
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
          publicationReceiptId,
          publication.publicationId,
          archivedManifest.manifestSha256,
          archivedManifest.manifestFingerprint,
          publishedManifest.manifestSha256,
          publishedManifest.manifestFingerprint,
          completedAt,
          fingerprint,
        );
        const inserted = publicationReceiptRowByPublication(receiptDb, publication.publicationId);
        if (!inserted) fail("storage-invalid", `视频包 publication ${publication.publicationId} receipt 未落盘。`);
        return { publication, receipt: publicationReceiptFromRow(inserted), replayed: false };
      });
    } finally {
      receiptDb.close();
    }
  }, { timeoutMs: 15_000, staleMs: EXECUTION_TIMEOUT_MS * 2 });
}

async function openCoreDatabaseReadOnly(databasePath: string, label: string): Promise<SqliteReadOnlySnapshot> {
  let snapshot: SqliteReadOnlySnapshot | null = null;
  try {
    snapshot = await openSqliteReadOnlySnapshot(databasePath, label);
    if ((snapshot.database.prepare("PRAGMA foreign_key_check").all() as unknown[]).length > 0) {
      fail("storage-invalid", `${label} 存在 foreign key 孤儿。`);
    }
    return snapshot;
  } catch (error) {
    await snapshot?.close();
    throw error;
  }
}

async function verifyIntentMediaReadOnly(shell: ProjectShell, intent: StudioVideoPackageExportIntent): Promise<void> {
  const metadata = await lstat(shell.paths.materialDatabase);
  if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(shell.paths.materialDatabase) !== shell.paths.materialDatabase) {
    fail("storage-invalid", "视频包只读控制面 material DB 不安全。 ");
  }
  const snapshot = await openCoreDatabaseReadOnly(shell.paths.materialDatabase, "material DB");
  const db = snapshot.database;
  try {
    for (const [variant, sha] of [["raw", intent.rawSha256], ["labeled", intent.labeledSha256]] as const) {
      const row = db.prepare("SELECT kind, object_relpath FROM studio_media WHERE sha256=?").get(sha) as {
        kind: string; object_relpath: string;
      } | undefined;
      if (!row || row.kind !== "image") fail("authority-not-ready", `视频包 ${variant} CAS 索引缺失。`);
      const relative = normalizeRelative(row.object_relpath, `material.${variant}.object_relpath`);
      const objectPath = path.join(shell.paths.root, ...relative.split("/"));
      if (!pathInside(objectPath, shell.paths.root) || (await readStableFile(objectPath)).sha256 !== sha) {
        fail("authority-not-ready", `视频包 ${variant} CAS 内容漂移。`);
      }
    }
  } finally {
    await snapshot.close();
  }
}

async function verifyIntentAuthorityLedgerReadOnly(
  shell: ProjectShell,
  intent: StudioVideoPackageExportIntent,
): Promise<void> {
  const snapshot = await openCoreDatabaseReadOnly(shell.paths.generationDatabase, "generation DB");
  const db = snapshot.database;
  try {
    const schema = db.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='schema_version'").get() as {
      value?: string;
    } | undefined;
    const pack = db.prepare(`SELECT project_id, unit_id, unit_revision FROM studio_generation_packs
      WHERE pack_id=? AND fingerprint=?`).get(intent.packId, intent.packFingerprint) as {
        project_id: string; unit_id: string; unit_revision: number;
      } | undefined;
    const target = db.prepare(`SELECT target_kind, target_key, unit_id, unit_revision FROM studio_generation_pack_targets
      WHERE pack_id=? AND pack_fingerprint=?`).get(intent.packId, intent.packFingerprint) as {
        target_kind: string; target_key: string; unit_id: string; unit_revision: number;
      } | undefined;
    // Generation ledger schema v6 adds append-only detached-unknown dispositions；
    // v7 在 call intent 上追加 callerAgentId 审计字段。视频包只读投影必须
    // 跟随当前 owner schema，否则合法的 v7 正式工程会被误报 input-drift。
    // Unit-grid pack payloads themselves remain schemaVersion 5, but the owner
    // database must now be the current v6 schema or the read-only authority
    // projection would incorrectly mark every prepared package as drifted.
    if (schema?.value !== "7" || !pack || !target || pack.project_id !== intent.projectId
      || pack.unit_id !== intent.unitId || Number(pack.unit_revision) !== intent.unitRevision
      || target.target_kind !== "unit-grid" || target.target_key !== intent.targetKey
      || target.unit_id !== intent.unitId || Number(target.unit_revision) !== intent.unitRevision) {
      fail("input-drift", `视频包 intent ${intent.intentId} 的 pack/target 只读投影漂移。`);
    }
    if (intent.authorityKind === "historical-import") {
      const historical = db.prepare(`SELECT import_id, fingerprint, raw_media_sha256, labeled_media_sha256,
          pack_fingerprint, unit_id, unit_revision
        FROM studio_generation_historical_imports WHERE pack_id=?`).get(intent.packId) as {
          import_id: string; fingerprint: string; raw_media_sha256: string; labeled_media_sha256: string;
          pack_fingerprint: string; unit_id: string; unit_revision: number;
        } | undefined;
      if (!historical || historical.import_id !== intent.authorityId
        || historical.fingerprint !== intent.authorityFingerprint
        || historical.raw_media_sha256 !== intent.rawSha256
        || historical.labeled_media_sha256 !== intent.labeledSha256
        || historical.pack_fingerprint !== intent.packFingerprint
        || historical.unit_id !== intent.unitId || Number(historical.unit_revision) !== intent.unitRevision
        || intent.generationRunId !== null) {
        fail("input-drift", `视频包 intent ${intent.intentId} 的 historical authority 漂移。`);
      }
      return;
    }
    const reviewSchema = db.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='p7_review_schema_version'")
      .get() as { value?: string } | undefined;
    const review = db.prepare(`SELECT generation_run_id, raw_result_id, raw_sha256, labeled_result_id,
        labeled_sha256, pack_id, pack_fingerprint, decision, advances_head, fingerprint
      FROM studio_generation_review_events WHERE review_id=?`).get(intent.authorityId) as {
        generation_run_id: string; raw_result_id: string; raw_sha256: string; labeled_result_id: string;
        labeled_sha256: string; pack_id: string; pack_fingerprint: string; decision: string;
        advances_head: number; fingerprint: string;
      } | undefined;
    const head = db.prepare(`SELECT review_id, review_fingerprint FROM studio_generation_review_heads
      WHERE generation_run_id=?`).get(intent.generationRunId) as { review_id: string; review_fingerprint: string } | undefined;
    const results = db.prepare(`SELECT result_id, variant, media_sha256, input_current, promotion_eligible,
        pack_id, pack_fingerprint, generation_run_id
      FROM studio_generation_results WHERE result_id IN (?, ?) ORDER BY variant`)
      .all(intent.rawResultId, intent.labeledResultId) as Array<{
        result_id: string; variant: string; media_sha256: string; input_current: number; promotion_eligible: number;
        pack_id: string; pack_fingerprint: string; generation_run_id: string;
      }>;
    const raw = results.find((row) => row.variant === "raw");
    const labeled = results.find((row) => row.variant === "labeled");
    if (reviewSchema?.value !== "1" || !review || !head || !raw || !labeled
      || review.generation_run_id !== intent.generationRunId || review.raw_result_id !== intent.rawResultId
      || review.raw_sha256 !== intent.rawSha256 || review.labeled_result_id !== intent.labeledResultId
      || review.labeled_sha256 !== intent.labeledSha256 || review.pack_id !== intent.packId
      || review.pack_fingerprint !== intent.packFingerprint || review.decision !== "pass"
      || Number(review.advances_head) !== 1 || review.fingerprint !== intent.authorityFingerprint
      || head.review_id !== intent.authorityId || head.review_fingerprint !== intent.authorityFingerprint
      || raw.result_id !== intent.rawResultId || raw.media_sha256 !== intent.rawSha256
      || labeled.result_id !== intent.labeledResultId || labeled.media_sha256 !== intent.labeledSha256
      || [raw, labeled].some((row) => Number(row.input_current) !== 1 || Number(row.promotion_eligible) !== 1
        || row.pack_id !== intent.packId || row.pack_fingerprint !== intent.packFingerprint
        || row.generation_run_id !== intent.generationRunId)) {
      fail("input-drift", `视频包 intent ${intent.intentId} 的 Review/result authority 漂移。`);
    }
  } finally {
    await snapshot.close();
  }
}

async function validateReceiptPackageReadOnly(
  packagePath: string,
  storageRelativePath: string,
  receipt: StudioVideoPackageVerifyReceipt,
  relocated: boolean,
): Promise<void> {
  const metadata = await lstat(packagePath).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink() || await realpath(packagePath) !== packagePath) {
    fail("destination-conflict", `视频包只读 receipt 目录缺失或不安全：${storageRelativePath}`);
  }
  const names = (await readdir(packagePath)).sort((left, right) => left.localeCompare(right, "en"));
  const expectedNames = [...receipt.files.map((file) => file.path), "manifest.json"]
    .sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    fail("destination-conflict", `视频包只读 receipt 文件集合漂移：${storageRelativePath}`);
  }
  const manifest = await readJsonSnapshot(path.join(packagePath, "manifest.json"), "视频包只读 manifest");
  if (manifest.sha256 !== receipt.manifestSha256 || digest(manifest.value) !== receipt.manifestFingerprint
    || (!relocated && receipt.manifestRelativePath !== `${storageRelativePath}/manifest.json`)) {
    fail("destination-conflict", `视频包只读 manifest 身份漂移：${storageRelativePath}`);
  }
  await Promise.all(receipt.files.map(async (file) => {
    if ((await readStableFile(path.join(packagePath, file.path))).sha256 !== file.sha256) {
      fail("destination-conflict", `视频包只读文件 SHA 漂移：${storageRelativePath}/${file.path}`);
    }
  }));
}

export interface StudioVideoPackageTerminalCropReceiptLineageInput {
  intentId: string;
  intentFingerprint: string;
  receiptId: string;
  receiptFingerprint: string;
  manifestSha256: string;
  manifestFingerprint: string;
  filePath: string;
  fileSha256: string;
  reviewId: string;
  reviewFingerprint: string;
  generationRunId: string;
  rawResultId: string;
  rawSha256: string;
  labeledResultId: string;
  labeledSha256: string;
  packId: string;
  packFingerprint: string;
  terminalPanelId: string;
  evidenceSha256: string;
}

export interface StudioVideoPackageTerminalCropReceiptLineageDiscoveryInput {
  reviewId: string;
  reviewFingerprint: string;
  generationRunId: string;
  rawResultId: string;
  rawSha256: string;
  labeledResultId: string;
  labeledSha256: string;
  packId: string;
  packFingerprint: string;
  terminalPanelId: string;
  evidenceSha256: string;
}

export interface StudioVideoPackageTerminalCropReceiptLineage {
  kind: "studio-video-package-terminal-crop";
  intentId: string;
  intentFingerprint: string;
  receiptId: string;
  receiptFingerprint: string;
  manifestSha256: string;
  manifestFingerprint: string;
  filePath: string;
  fileSha256: string;
}

export type StudioVideoPackageTerminalCropReceiptLineageDiscovery =
  | {
      status: "missing";
      candidateCount: 0;
    }
  | {
      status: "resolved";
      candidateCount: 1;
      lineage: StudioVideoPackageTerminalCropReceiptLineage;
    }
  | {
      status: "conflict";
      candidateCount: number;
      candidateIntentIds: string[];
    };

/**
 * 只证明 immutable 视频包回执中的末格裁图来自当前 PASS raw/pack。
 *
 * 该证明故意不消费 managed-source / observation-control currentness：
 * observation 必须在裁图回执之后才可建立；若把后写入的 observation Head
 * 反向作为旧回执的 currentness 条件，会形成自我失效环。正式导出是否需要
 * successor intent 仍由 getStudioVideoPackageControl 独立裁决。
 */
export async function verifyStudioVideoPackageTerminalCropReceiptLineage(
  projectRoot: string,
  rawInput: StudioVideoPackageTerminalCropReceiptLineageInput,
): Promise<boolean> {
  const input = {
    intentId: normalizeId(rawInput.intentId, "intentId"),
    intentFingerprint: normalizeSha(rawInput.intentFingerprint, "intentFingerprint"),
    receiptId: normalizeId(rawInput.receiptId, "receiptId"),
    receiptFingerprint: normalizeSha(rawInput.receiptFingerprint, "receiptFingerprint"),
    manifestSha256: normalizeSha(rawInput.manifestSha256, "manifestSha256"),
    manifestFingerprint: normalizeSha(rawInput.manifestFingerprint, "manifestFingerprint"),
    filePath: normalizeRelative(rawInput.filePath, "filePath"),
    fileSha256: normalizeSha(rawInput.fileSha256, "fileSha256"),
    reviewId: normalizeId(rawInput.reviewId, "reviewId"),
    reviewFingerprint: normalizeSha(rawInput.reviewFingerprint, "reviewFingerprint"),
    generationRunId: normalizeId(rawInput.generationRunId, "generationRunId"),
    rawResultId: normalizeId(rawInput.rawResultId, "rawResultId"),
    rawSha256: normalizeSha(rawInput.rawSha256, "rawSha256"),
    labeledResultId: normalizeId(rawInput.labeledResultId, "labeledResultId"),
    labeledSha256: normalizeSha(rawInput.labeledSha256, "labeledSha256"),
    packId: normalizeId(rawInput.packId, "packId"),
    packFingerprint: normalizeSha(rawInput.packFingerprint, "packFingerprint"),
    terminalPanelId: normalizeId(rawInput.terminalPanelId, "terminalPanelId"),
    evidenceSha256: normalizeSha(rawInput.evidenceSha256, "evidenceSha256"),
  };
  if (path.basename(input.filePath) !== input.filePath
    || input.fileSha256 !== input.evidenceSha256) return false;
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const databasePath = await generationDatabasePathReadOnly(shell.paths.root);
  const ledger = await openSqliteReadOnlySnapshot(databasePath, "video terminal crop receipt lineage");
  let intent: StudioVideoPackageExportIntent;
  let receipt: StudioVideoPackageVerifyReceipt;
  try {
    assertSchema(ledger.database);
    const intentRow = intentRowById(ledger.database, input.intentId);
    const receiptRow = receiptRowByIntent(ledger.database, input.intentId);
    if (!intentRow || !receiptRow) return false;
    intent = intentFromRow(intentRow);
    receipt = receiptFromRow(receiptRow);
  } finally {
    await ledger.close();
  }
  if (intent.fingerprint !== input.intentFingerprint
    || receipt.receiptId !== input.receiptId
    || receipt.fingerprint !== input.receiptFingerprint
    || receipt.manifestSha256 !== input.manifestSha256
    || receipt.manifestFingerprint !== input.manifestFingerprint
    || receipt.intentId !== intent.intentId
    || receipt.mechanicalStatus !== "verified"
    || intent.projectId !== shell.project.id
    || intent.authorityKind !== "studio-review"
    || intent.authorityId !== input.reviewId
    || intent.authorityFingerprint !== input.reviewFingerprint
    || intent.generationRunId !== input.generationRunId
    || intent.rawResultId !== input.rawResultId
    || intent.rawSha256 !== input.rawSha256
    || intent.labeledResultId !== input.labeledResultId
    || intent.labeledSha256 !== input.labeledSha256
    || intent.packId !== input.packId
    || intent.packFingerprint !== input.packFingerprint
    || intent.targetKind !== "unit-grid") {
    return false;
  }
  await verifyIntentAuthorityLedgerReadOnly(shell, intent);
  await verifyIntentMediaReadOnly(shell, intent);
  const pack = await readStudioUnitGridGenerationFrozenPack(shell.paths.root, input.packId);
  if (!pack || pack.fingerprint !== input.packFingerprint
    || pack.target.unitId !== intent.unitId
    || intent.targetKey !== `unit-grid:${pack.target.unitId}`
    || pack.target.unitRevision !== intent.unitRevision) return false;
  await assertStudioUnitGridGenerationFreezePackCurrent(shell.paths.root, pack);
  const terminal = [...pack.panels].sort((left, right) =>
    left.endSeconds - right.endSeconds
    || left.order - right.order
    || left.panelId.localeCompare(right.panelId, "en")).at(-1);
  const panelOffset = pack.panels.findIndex((panel) => panel.panelId === input.terminalPanelId);
  const expectedFilePath = panelOffset < 0
    ? ""
    : `${intent.unitId}-G${panelOffset + 1}_raw.png`;
  if (!terminal
    || terminal.panelId !== input.terminalPanelId
    || input.filePath !== expectedFilePath) return false;
  const files = receipt.files.filter((file) => file.path === input.filePath);
  if (files.length !== 1 || files[0]!.sha256 !== input.evidenceSha256) return false;

  const packagePath = path.join(intent.productionRoot, ...intent.packageRelativePath.split("/"));
  const externalIdentity = { productionRoot: intent.productionRoot, packagePath } as ResolvedExternalInput;
  const publication = await openSqliteReadOnlySnapshot(databasePath, "video terminal crop publication ledger");
  let storage: Awaited<ReturnType<typeof receiptPackagePath>>;
  try {
    storage = await receiptPackagePath(
      databasePath,
      shell.paths.root,
      externalIdentity,
      intent,
      receipt,
      publication.database,
    );
  } finally {
    await publication.close();
  }
  await validateReceiptPackageReadOnly(
    storage.packagePath,
    storage.storageRelativePath,
    receipt,
    storage.relocated,
  );
  return true;
}

/**
 * 首次 Observation 捕获使用的 immutable receipt 发现入口。
 *
 * 它只按当前 Review/raw/labeled/pack 身份查找已经 mechanically-verified 的
 * 末格裁图回执，再逐个调用 immutable lineage verifier。它故意不读取导出
 * control 的 owner-currentness，也不消费 managed-source/Observation currentness，
 * 从而避免“先有 Observation 才能证明用于建立 Observation 的裁图”这一循环。
 *
 * 0 个可信候选返回 missing；1 个返回 resolved；多于 1 个绝不猜测 latest，
 * 返回 conflict，交由调用方阻止 continuation 放行。
 */
export async function discoverStudioVideoPackageTerminalCropReceiptLineage(
  projectRoot: string,
  rawInput: StudioVideoPackageTerminalCropReceiptLineageDiscoveryInput,
): Promise<StudioVideoPackageTerminalCropReceiptLineageDiscovery> {
  const input = {
    reviewId: normalizeId(rawInput.reviewId, "reviewId"),
    reviewFingerprint: normalizeSha(rawInput.reviewFingerprint, "reviewFingerprint"),
    generationRunId: normalizeId(rawInput.generationRunId, "generationRunId"),
    rawResultId: normalizeId(rawInput.rawResultId, "rawResultId"),
    rawSha256: normalizeSha(rawInput.rawSha256, "rawSha256"),
    labeledResultId: normalizeId(rawInput.labeledResultId, "labeledResultId"),
    labeledSha256: normalizeSha(rawInput.labeledSha256, "labeledSha256"),
    packId: normalizeId(rawInput.packId, "packId"),
    packFingerprint: normalizeSha(rawInput.packFingerprint, "packFingerprint"),
    terminalPanelId: normalizeId(rawInput.terminalPanelId, "terminalPanelId"),
    evidenceSha256: normalizeSha(rawInput.evidenceSha256, "evidenceSha256"),
  };
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const pack = await readStudioUnitGridGenerationFrozenPack(shell.paths.root, input.packId);
  if (!pack
    || pack.fingerprint !== input.packFingerprint
    || pack.target.unitId.length < 1) {
    return { status: "missing", candidateCount: 0 };
  }
  await assertStudioUnitGridGenerationFreezePackCurrent(shell.paths.root, pack);
  const terminal = [...pack.panels].sort((left, right) =>
    left.endSeconds - right.endSeconds
    || left.order - right.order
    || left.panelId.localeCompare(right.panelId, "en")).at(-1);
  const panelOffset = pack.panels.findIndex((panel) => panel.panelId === input.terminalPanelId);
  if (!terminal
    || terminal.panelId !== input.terminalPanelId
    || panelOffset < 0) {
    return { status: "missing", candidateCount: 0 };
  }
  const filePath = `${pack.target.unitId}-G${panelOffset + 1}_raw.png`;
  const databasePath = await generationDatabasePathReadOnly(shell.paths.root);
  const ledger = await openSqliteReadOnlySnapshot(databasePath, "video terminal crop receipt discovery");
  const candidates: Array<{
    intent: StudioVideoPackageExportIntent;
    receipt: StudioVideoPackageVerifyReceipt;
  }> = [];
  try {
    assertSchema(ledger.database);
    const rows = ledger.database.prepare(`
      SELECT i.intent_id
      FROM studio_video_package_export_intents i
      JOIN studio_video_package_verify_receipts r ON r.intent_id=i.intent_id
      WHERE i.project_id=?
        AND i.authority_kind='studio-review'
        AND i.authority_id=?
        AND i.authority_fingerprint=?
        AND i.generation_run_id=?
        AND i.raw_result_id=?
        AND i.raw_sha256=?
        AND i.labeled_result_id=?
        AND i.labeled_sha256=?
        AND i.pack_id=?
        AND i.pack_fingerprint=?
        AND i.target_kind='unit-grid'
        AND i.target_key=?
        AND i.unit_id=?
        AND i.unit_revision=?
        AND r.mechanical_status='verified'
      ORDER BY i.sequence ASC
    `).all(
      shell.project.id,
      input.reviewId,
      input.reviewFingerprint,
      input.generationRunId,
      input.rawResultId,
      input.rawSha256,
      input.labeledResultId,
      input.labeledSha256,
      input.packId,
      input.packFingerprint,
      `unit-grid:${pack.target.unitId}`,
      pack.target.unitId,
      pack.target.unitRevision,
    ) as Array<{ intent_id: string }>;
    for (const row of rows) {
      const intentRow = intentRowById(ledger.database, row.intent_id);
      const receiptRow = receiptRowByIntent(ledger.database, row.intent_id);
      if (!intentRow || !receiptRow) continue;
      const intent = intentFromRow(intentRow);
      const receipt = receiptFromRow(receiptRow);
      const matchingFiles = receipt.files.filter((file) =>
        file.path === filePath && file.sha256 === input.evidenceSha256);
      if (matchingFiles.length === 1) candidates.push({ intent, receipt });
    }
  } finally {
    await ledger.close();
  }

  const verified: StudioVideoPackageTerminalCropReceiptLineage[] = [];
  for (const candidate of candidates) {
    const lineage: StudioVideoPackageTerminalCropReceiptLineage = {
      kind: "studio-video-package-terminal-crop",
      intentId: candidate.intent.intentId,
      intentFingerprint: candidate.intent.fingerprint,
      receiptId: candidate.receipt.receiptId,
      receiptFingerprint: candidate.receipt.fingerprint,
      manifestSha256: candidate.receipt.manifestSha256,
      manifestFingerprint: candidate.receipt.manifestFingerprint,
      filePath,
      fileSha256: input.evidenceSha256,
    };
    const trusted = await verifyStudioVideoPackageTerminalCropReceiptLineage(
      shell.paths.root,
      {
        ...lineage,
        reviewId: input.reviewId,
        reviewFingerprint: input.reviewFingerprint,
        generationRunId: input.generationRunId,
        rawResultId: input.rawResultId,
        rawSha256: input.rawSha256,
        labeledResultId: input.labeledResultId,
        labeledSha256: input.labeledSha256,
        packId: input.packId,
        packFingerprint: input.packFingerprint,
        terminalPanelId: input.terminalPanelId,
        evidenceSha256: input.evidenceSha256,
      },
    );
    if (trusted) verified.push(lineage);
  }
  if (verified.length === 0) return { status: "missing", candidateCount: 0 };
  if (verified.length === 1) {
    return { status: "resolved", candidateCount: 1, lineage: verified[0]! };
  }
  return {
    status: "conflict",
    candidateCount: verified.length,
    candidateIntentIds: verified.map((lineage) => lineage.intentId),
  };
}

export async function getStudioVideoPackageExportControl(
  projectRoot: string,
  intentIdValue: string,
): Promise<StudioVideoPackageExportControl> {
  const intentId = normalizeId(intentIdValue, "intentId");
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const databasePath = await generationDatabasePathReadOnly(shell.paths.root);
  const packageSnapshot = await openSqliteReadOnlySnapshot(databasePath, "video package ledger");
  const db = packageSnapshot.database;
  let intent: StudioVideoPackageExportIntent;
  let receipt: StudioVideoPackageVerifyReceipt | null;
  let priorExternal: ReturnType<typeof priorExternalDestinationReceipt>;
  try {
    assertSchema(db);
    const row = intentRowById(db, intentId);
    if (!row) fail("intent-not-found", `视频包 intent 不存在：${intentId}`);
    intent = intentFromRow(row);
    priorExternal = priorExternalDestinationReceipt(db, intent);
    const receiptRow = receiptRowByIntent(db, intentId);
    receipt = receiptRow ? receiptFromRow(receiptRow) : null;
  } finally {
    await packageSnapshot.close();
  }
  const blockers: string[] = [];
  let externalPublicationBlocker: "external-production-occupied" | "external-production-not-published" | null = null;
  let publicationCompleted = false;
  try {
    if (intent.schemaVersion === LEGACY_VIDEO_PACKAGE_SCHEMA_VERSION) {
      fail("input-drift", `视频包 intent ${intent.intentId} 是旧 v3 只读记录，需重新 prepare。`);
    }
    if (intent.schemaVersion === VIDEO_PACKAGE_SCHEMA_VERSION) {
      const binding = await readStudioVideoPackageSourceClosureBinding(
        shell.paths.root,
        intent.inputFingerprint,
      );
      if (!binding
        || binding.sourceClosureFingerprint !== intent.sourceClosureFingerprint) {
        fail("input-drift", `视频包 intent ${intent.intentId} 的 source closure binding 漂移。`);
      }
      await verifyStudioVideoPackageSourceClosure(
        shell.paths.root,
        binding.sourceClosureFingerprint,
      );
    } else {
      const duduIdentity = await getActiveDuduReadonlyProjectIdentityReadOnly(shell.paths.root);
      if (duduIdentity.projectId !== intent.projectId || duduIdentity.projectRoot !== shell.paths.root
        || duduIdentity.importReceiptFingerprint !== intent.duduImportReceiptFingerprint
        || duduIdentity.registrationFingerprint !== intent.duduRegistrationFingerprint
        || duduIdentity.sourceManifestFingerprint !== intent.sourceManifestFingerprint
        || duduIdentity.productionScopeFingerprint !== intent.productionScopeFingerprint
        || duduIdentity.contractSha256 !== intent.contractSha256
        || duduIdentity.sourceProductionRoot !== intent.productionRoot) {
        fail("input-drift", `视频包 intent ${intent.intentId} 的 Dudu 活动身份漂移。`);
      }
      const builderIdentity = sourceIdentityFor(duduIdentity, intent.builderRelativePath);
      if (builderIdentity.sha256 !== intent.builderSha256) {
        fail("input-drift", `视频包 intent ${intent.intentId} 的 builder 身份漂移。`);
      }
      if (intent.authorityKind === "historical-import"
        && sourceIdentityFor(duduIdentity, intent.sourceSpecRelativePath).sha256 !== intent.sourceSpecSha256) {
        fail("input-drift", `视频包 intent ${intent.intentId} 的历史视频规格漂移。`);
      }
    }
    await verifyIntentAuthorityLedgerReadOnly(shell, intent);
    await verifyIntentMediaReadOnly(shell, intent);
    if (intent.authorityKind === "studio-review") {
      await assertIntentManagedSourceCurrent(
        shell.paths.root,
        intent,
        undefined,
        intent.managedSourceFingerprint,
      );
    }
    const packagePath = path.join(intent.productionRoot, ...intent.packageRelativePath.split("/"));
    const externalIdentity = { productionRoot: intent.productionRoot, packagePath } as ResolvedExternalInput;
    if (receipt) {
      // 控制面只读 query-only SQLite、source/CAS 与 receipt 文件 SHA；不会初始化 owner、
      // 迁移 schema、创建 lock/WAL/SHM，也不会启动 builder。
      const publicationSnapshot = await openSqliteReadOnlySnapshot(databasePath, "video publication ledger");
      let storage: Awaited<ReturnType<typeof receiptPackagePath>>;
      try {
        storage = await receiptPackagePath(
          databasePath,
          shell.paths.root,
          externalIdentity,
          intent,
          receipt,
          publicationSnapshot.database,
        );
      } finally {
        await publicationSnapshot.close();
      }
      publicationCompleted = storage.relocated && storage.storageRelativePath === intent.packageRelativePath;
      await validateReceiptPackageReadOnly(
        storage.packagePath,
        storage.storageRelativePath,
        receipt,
        storage.relocated,
      );
      if (intent.authorityKind === "studio-review") {
        const projectedSpecPath = path.join(intent.productionRoot, ...intent.sourceSpecRelativePath.split("/"));
        const projectedSpec = await lstat(projectedSpecPath).catch(() => null);
        if (projectedSpec && (await readStableFile(projectedSpecPath)).sha256 !== intent.sourceSpecSha256) {
          fail("input-drift", `视频包 intent ${intent.intentId} 的派生视频规格漂移。`);
        }
        if ((receipt.storageKind === "external-production" || publicationCompleted) && !projectedSpec) {
          fail("input-drift", `视频包 intent ${intent.intentId} 的已发布派生视频规格缺失。`);
        }
      }
      if (receipt.storageKind === "managed-evidence" && receipt.i2vStaticStatus === "ready" && !storage.relocated) {
        externalPublicationBlocker = priorExternal || await lstat(packagePath).catch(() => null)
          ? "external-production-occupied"
          : "external-production-not-published";
      }
    }
  } catch (error) {
    blockers.push(error instanceof StudioVideoPackageError ? error.code : "input-drift");
  }
  const status: StudioVideoPackageExportControl["status"] = blockers.length > 0
    ? "stale"
    : receipt ? "mechanically-verified" : "prepared";
  const mechanicalStatus: StudioVideoPackageExportControl["mechanicalStatus"] = blockers.length > 0
    ? "stale"
    : receipt ? "verified" : "not-run";
  const i2vStaticStatus: StudioVideoPackageExportControl["i2vStaticStatus"] = receipt
    ? receipt.i2vStaticStatus
    : "not-assessed";
  const nextAction: StudioVideoPackageExportControl["nextAction"] = status === "stale" ? "repair-input"
    : status === "prepared" ? "build-or-adopt-and-verify"
      : receipt?.storageKind === "managed-evidence" && i2vStaticStatus === "ready" && !publicationCompleted
        ? "resolve-external-production-conflict"
      : i2vStaticStatus === "ready"
        ? "package-ready-dynamic-model-not-tested"
        : "complete-i2v-static-input";
  const readinessBlockers = status === "mechanically-verified"
    ? i2vStaticStatus === "legacy-audit-required"
      ? ["legacy-i2v-audit-required"]
      : i2vStaticStatus === "needs-independent-frame-or-review"
        ? ["i2v-static-input-incomplete"]
        : externalPublicationBlocker ? [externalPublicationBlocker] : []
    : [];
  const semantic = {
    schemaVersion: 3 as const,
    kind: "studio-video-package-export-control" as const,
    intent,
    receipt,
    status,
    mechanicalStatus,
    i2vStaticStatus,
    dynamicModelStatus: "not-run" as const,
    blockers: [...new Set([...blockers, ...readinessBlockers])].sort((left, right) => left.localeCompare(right, "en")),
    nextAction,
  };
  return { ...semantic, fingerprint: digest(semantic) };
}

/**
 * P30 重启恢复用只读选择器。intent 精确读取保持兼容；authority-latest 只在
 * query-only 快照中解析既有 append-only 换代链，未准备时不初始化 schema，
 * 冲突时不猜测。解析前后双读可关闭“查询后新 intent 落盘”的旧选择窗口。
 */
export async function getStudioVideoPackageControl(
  projectRoot: string,
  queryValue: StudioVideoPackageControlQuery,
): Promise<StudioVideoPackageControlLookup> {
  if (!queryValue || typeof queryValue !== "object") fail("invalid-input", "视频包 control query 无效。");
  if (queryValue.by === "intent") {
    const query = { by: "intent" as const, intentId: normalizeId(queryValue.intentId, "intentId") };
    const control = await getStudioVideoPackageExportControl(projectRoot, query.intentId);
    const semantic = {
      schemaVersion: 1 as const,
      kind: "studio-video-package-control-lookup" as const,
      query,
      status: "resolved" as const,
      selectedIntentId: control.intent.intentId,
      selectedIsDestinationHead: null,
      control,
      blockers: [] as StudioVideoPackageControlLookup["blockers"],
      nextAction: "use-resolved-control" as const,
      readOnly: true as const,
    };
    return { ...semantic, fingerprint: digest(semantic) };
  }
  if (queryValue.by !== "authority-latest") fail("invalid-input", "视频包 control query.by 无效。");
  const authority: StudioVideoPackageAuthorityInput = queryValue.authority?.kind === "historical-import"
    ? { kind: "historical-import", packId: normalizeId(queryValue.authority.packId, "packId") }
    : queryValue.authority?.kind === "studio-review"
      ? { kind: "studio-review", reviewId: normalizeId(queryValue.authority.reviewId, "reviewId") }
      : fail("invalid-input", "视频包 authority-latest authority 无效。");
  const query = { by: "authority-latest" as const, authority };
  const first = await resolveStudioVideoPackageAuthorityLatestReadOnly(projectRoot, authority);
  let control: StudioVideoPackageExportControl | null = null;
  if (first.status === "resolved") {
    control = await getStudioVideoPackageExportControl(projectRoot, first.intentId);
  }
  const second = await resolveStudioVideoPackageAuthorityLatestReadOnly(projectRoot, authority);
  if (digest(first) !== digest(second)) {
    fail("input-drift", "视频包 authority-latest 在只读解析期间发生变化，请重新查询。");
  }
  const status: StudioVideoPackageControlLookup["status"] = first.status;
  const nextAction: StudioVideoPackageControlLookup["nextAction"] = status === "not-prepared"
    ? "prepare-via-authorized-core-orchestration"
    : status === "conflict" ? "resolve-video-package-ledger-conflict" : "use-resolved-control";
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-video-package-control-lookup" as const,
    query,
    status,
    selectedIntentId: first.intentId,
    selectedIsDestinationHead: first.isDestinationHead,
    control,
    blockers: first.blockers,
    nextAction,
    readOnly: true as const,
  };
  return { ...semantic, fingerprint: digest(semantic) };
}

/**
 * IPC/公开面投影：剔除 productionRoot 绝对路径与全部来源/构建/目的地相对路径，
 * 只保留身份、状态、指纹与计数。renderer 不得接触外部生产根布局或受管存储路径；
 * MCP 执行面另经 sanitizeManagedStudioValue 清洗，不消费本投影。
 */
export type StudioVideoPackagePublicIntent = Omit<StudioVideoPackageExportIntent,
  "productionRoot" | "builderRelativePath" | "sourceSpecRelativePath" | "outputRootRelativePath" | "packageRelativePath">;

export type StudioVideoPackagePublicVerifyReceipt = Omit<StudioVideoPackageVerifyReceipt,
  "storageRelativePath" | "manifestRelativePath" | "files"> & { fileCount: number };

export type StudioVideoPackagePublicExportControl = Omit<StudioVideoPackageExportControl, "intent" | "receipt"> & {
  intent: StudioVideoPackagePublicIntent;
  receipt: StudioVideoPackagePublicVerifyReceipt | null;
};

export type StudioVideoPackagePublicControlLookup = Omit<StudioVideoPackageControlLookup, "control"> & {
  control: StudioVideoPackagePublicExportControl | null;
};

export function toStudioVideoPackagePublicControlLookup(
  lookup: StudioVideoPackageControlLookup,
): StudioVideoPackagePublicControlLookup {
  if (!lookup.control) return { ...lookup, control: null };
  const {
    productionRoot: _productionRoot,
    builderRelativePath: _builderRelativePath,
    sourceSpecRelativePath: _sourceSpecRelativePath,
    outputRootRelativePath: _outputRootRelativePath,
    packageRelativePath: _packageRelativePath,
    ...publicIntent
  } = lookup.control.intent;
  const receipt = lookup.control.receipt;
  return {
    ...lookup,
    control: {
      ...lookup.control,
      intent: publicIntent,
      receipt: receipt
        ? (() => {
          const {
            storageRelativePath: _storageRelativePath,
            manifestRelativePath: _manifestRelativePath,
            files,
            ...publicReceipt
          } = receipt;
          return { ...publicReceipt, fileCount: files.length };
        })()
        : null,
    },
  };
}
