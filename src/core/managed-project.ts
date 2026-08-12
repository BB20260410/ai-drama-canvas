import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { recordManagedProjectShellInspection } from "./runtime-storage-observability.js";
import {
  measureStudioUnitsReadPhase,
  recordStudioUnitsReadCounter,
} from "./studio-units-read-phase-timeline.js";
import {
  PROJECT_CACHE_V2_FILE,
  ProjectCache,
  createLegacyProjectCacheWriterFence,
  inspectLegacyProjectCacheWriterFence,
} from "./cache.js";
import { ensureSidecar, getSidecarPaths, saveIndex, writeJsonAtomic } from "./sidecar.js";
import type {
  AttachNovelManifestInput,
  ProgressSummary,
  ProjectConfig,
  ProjectIndex,
  WorkItemStatus,
} from "./types.js";
import { WORK_ITEM_STATUSES } from "./types.js";
import { initializeMaterialStudio } from "./material-studio.js";
import { initializeStudioProduction } from "./studio-production.js";
import { withProjectLock } from "./locks.js";
import {
  createManagedProjectWriterFence,
  inspectManagedProjectWriterFence,
} from "./managed-writer-fence.js";
import {
  inspectExistingConfinedDirectory,
  readConfinedRegularFileWithIdentity,
  replaceConfinedBytesCas,
} from "./confined-project-storage.js";
import {
  MANAGED_PROJECT_WRITER_SCHEMA_VERSION,
  NOVEL_CHAPTER_MANIFEST_RELATIVE_PATH,
  NOVEL_MANIFEST_RELATIVE_PATH,
  isNovelSourceMode,
  isWorkspaceMode,
  type NovelWorkspaceManifest,
  type NovelWorkspaceDeclaration,
  type WorkspaceMode,
} from "./novel-types.js";

export type { NovelWorkspaceDeclaration, WorkspaceMode } from "./novel-types.js";

interface AttachNovelManifestTestHooks {
  beforeManagedManifestReplace?: (input: {
    projectRoot: string;
    manifestPath: string;
  }) => void | Promise<void>;
}

let attachNovelManifestTestHooks: AttachNovelManifestTestHooks = {};

/** 仅供确定性 TOCTOU 测试；产品环境不可启用。 */
export function __setAttachNovelManifestTestHooksForTests(
  hooks: AttachNovelManifestTestHooks,
): () => void {
  if (process.env.NODE_ENV !== "test") throw new Error("attach novel manifest 测试 hook 只允许测试环境启用。");
  const previous = attachNovelManifestTestHooks;
  attachNovelManifestTestHooks = hooks;
  return () => { attachNovelManifestTestHooks = previous; };
}

const MANAGED_MANIFEST_FILE = "managed-project.json";
const MANAGED_BOOTSTRAP_CLAIM_RELATIVE_PATH = ".aicanvas/managed-bootstrap-claim.json";
const MANAGED_BOOTSTRAP_QUARANTINE_DIRECTORY = ".aicanvas-managed-bootstrap-quarantine";
const MANAGED_BOOTSTRAP_RECOVERY_NAMESPACE_PATTERN = /^owner-[a-f0-9]{64}$/u;
const MANAGED_BOOTSTRAP_RECOVERY_RECORD_PATTERN = /^recovery-[a-f0-9]{64}\.json$/u;
const MAX_BOOTSTRAP_RECOVERY_RECORD_BYTES = 1024 * 1024;
const MAX_BOOTSTRAP_RECOVERY_ATTEMPTS = 64;
const MAX_BOOTSTRAP_CLAIM_BYTES = 64 * 1024;
const MAX_NOVEL_WORKSPACE_MANIFEST_BYTES = 1024 * 1024;
const MANAGED_NEXT_ACTION = "导入剧本，并建立角色、场景、道具、风格的权威资产与一致性锁定。";

export interface CreateManagedProjectOptions {
  parentRoot: string;
  name: string;
  slug?: string;
  workspaceMode?: WorkspaceMode;
  /**
   * 可选的创建前不可变归属声明。owner 在任何 sidecar/DB 初始化之前写入固定路径，
   * 供上层在进程崩溃后精确识别完整 orphan；不参与项目注册或活动指针。
   */
  bootstrapClaim?: { purpose: string; payload: Record<string, unknown> };
}

export interface ManagedProjectBootstrapClaim {
  schemaVersion: 3;
  kind: "managed-project-bootstrap-claim";
  claimId: string;
  projectRoot: string;
  workspaceMode: WorkspaceMode;
  minimumWriterSchemaVersion: 1 | typeof MANAGED_PROJECT_WRITER_SCHEMA_VERSION;
  purpose: string;
  payload: Record<string, unknown>;
  createdAt: string;
  fingerprint: string;
}

export interface ManagedProjectBootstrapRecoveryAttempt {
  recoveryId: string;
  priorClaimFingerprint: string;
  quarantinedProjectRoot: string;
  preparedAt: string;
  replacementClaimFingerprint?: string;
  replacementClaimedAt?: string;
  rebuiltProjectId?: string;
  completedAt?: string;
  reconciledProjectId?: string;
  reconciledClaimFingerprint?: string;
  reconciledAt?: string;
}

export interface ManagedProjectBootstrapRecoveryRecord {
  schemaVersion: 2;
  kind: "managed-project-bootstrap-recovery";
  originalProjectRoot: string;
  workspaceMode: WorkspaceMode;
  minimumWriterSchemaVersion: 1 | typeof MANAGED_PROJECT_WRITER_SCHEMA_VERSION;
  bootstrapPurpose: string;
  bootstrapPayload: Record<string, unknown>;
  attempts: ManagedProjectBootstrapRecoveryAttempt[];
  updatedAt: string;
  fingerprint: string;
}

interface ManagedProjectManifestBase {
  kind: "ai-canvas-managed-project";
  projectId: string;
  projectName: string;
  rootRealpath: string;
  storageMode: "managed";
  startupPolicy: "no-filesystem-scan";
  mediaMode: "project-local-cas";
  legacyRoots: [];
  projectConfigSha256: string;
  bootstrapIndexSha256: string;
  bootstrapScanId: string;
  relativePaths: {
    config: ".aicanvas/project.json";
    index: ".aicanvas/index.json";
    cache: ".aicanvas/cache.sqlite" | `.aicanvas/${typeof PROJECT_CACHE_V2_FILE}`;
    materialDatabase: ".aicanvas/material-studio.sqlite";
    productionDatabase?: ".aicanvas/studio-production.sqlite";
    textCas?: ".aicanvas/studio-production/objects/sha256";
    generationDatabase?: ".aicanvas/studio-generation-ledger.sqlite";
    generationPackCas?: ".aicanvas/studio-generation/objects/sha256";
    mediaCas: ".aicanvas/objects/sha256";
    mediaPreviews: ".aicanvas/derived/thumb";
    mediaProxies: ".aicanvas/derived/proxy";
    mediaWaveforms: ".aicanvas/derived/waveform";
  };
  createdAt: string;
  fingerprint: string;
}

export interface ManagedProjectManifestV1 extends ManagedProjectManifestBase {
  schemaVersion: 1;
  workspaceMode?: never;
  minimumWriterSchemaVersion?: never;
  novelManifest?: never;
}

export interface ManagedProjectManifestV2 extends ManagedProjectManifestBase, NovelWorkspaceDeclaration {
  schemaVersion: 2;
  workspaceMode: Exclude<WorkspaceMode, "drama">;
  minimumWriterSchemaVersion: typeof MANAGED_PROJECT_WRITER_SCHEMA_VERSION;
  novelManifest?: typeof NOVEL_MANIFEST_RELATIVE_PATH;
}

export type ManagedProjectManifest = ManagedProjectManifestV1 | ManagedProjectManifestV2;

export interface ManagedProjectPaths {
  root: string;
  sidecar: string;
  config: string;
  index: string;
  cache: string;
  manifest: string;
  materialDatabase: string;
  productionDatabase: string;
  textCas: string;
  generationDatabase: string;
  generationPackCas: string;
  progressMarkdown: string;
  mediaCas: string;
  mediaPreviews: string;
  mediaProxies: string;
  mediaWaveforms: string;
}

export interface ProjectShell {
  project: ProjectConfig;
  workspaceMode: WorkspaceMode;
  counts: {
    total: number;
    items: number;
    artifacts: number;
    images: number;
    videos: number;
    audio: number;
  };
  nextAction: string;
  manifestFingerprint: string;
  manifest: Pick<ManagedProjectManifestBase, "storageMode" | "startupPolicy" | "mediaMode" | "legacyRoots" | "fingerprint"> & {
    schemaVersion: ManagedProjectManifest["schemaVersion"];
    workspaceMode: WorkspaceMode;
    minimumWriterSchemaVersion?: typeof MANAGED_PROJECT_WRITER_SCHEMA_VERSION;
    novelManifest?: typeof NOVEL_MANIFEST_RELATIVE_PATH;
  };
  paths: ManagedProjectPaths;
}

interface CreatedDirectoryIdentity {
  dev: number;
  ino: number;
  realpath: string;
}

const generationLedgerInitializationContext = new AsyncLocalStorage<ReadonlySet<string>>();
const generationLedgerInitializations = new Map<string, Promise<void>>();

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

type ManagedProjectManifestPayload =
  | Omit<ManagedProjectManifestV1, "fingerprint">
  | Omit<ManagedProjectManifestV2, "fingerprint">;

function manifestFingerprint(manifest: ManagedProjectManifestPayload): string {
  return sha256(JSON.stringify(stableValue(manifest)));
}

function novelWorkspaceManifestFingerprint(
  manifest: Omit<NovelWorkspaceManifest, "fingerprint">,
): string {
  return sha256(JSON.stringify(stableValue(manifest)));
}

function normalizeWorkspaceMode(value: unknown): WorkspaceMode {
  if (value === undefined) return "drama";
  if (!isWorkspaceMode(value)) throw new Error(`受管项目 workspaceMode 无效：${String(value)}`);
  return value;
}

function minimumWriterSchemaVersionForWorkspace(
  workspaceMode: WorkspaceMode,
): 1 | typeof MANAGED_PROJECT_WRITER_SCHEMA_VERSION {
  return workspaceMode === "drama" ? 1 : MANAGED_PROJECT_WRITER_SCHEMA_VERSION;
}

function requireBootstrapRecoveryCompatibleWorkspaceMode(
  options: Pick<CreateManagedProjectOptions, "workspaceMode" | "bootstrapClaim">,
): WorkspaceMode {
  return normalizeWorkspaceMode(options.workspaceMode);
}

function normalizeBootstrapPurpose(value: string): string {
  const purpose = typeof value === "string" ? value.normalize("NFC").trim() : "";
  if (!/^[a-z][a-z0-9-]{2,63}$/u.test(purpose)) throw new Error("bootstrapClaim.purpose 格式无效。");
  return purpose;
}

function bootstrapClaimFingerprint(value: Omit<ManagedProjectBootstrapClaim, "fingerprint">): string {
  return sha256(JSON.stringify(stableValue(value)));
}

async function writeManagedBootstrapClaim(
  projectRoot: string,
  input: NonNullable<CreateManagedProjectOptions["bootstrapClaim"]>,
  workspaceMode: WorkspaceMode,
): Promise<ManagedProjectBootstrapClaim> {
  if (!isRecord(input.payload)) throw new Error("bootstrapClaim.payload 必须是 JSON 对象。");
  const semantic: Omit<ManagedProjectBootstrapClaim, "fingerprint"> = {
    schemaVersion: 3,
    kind: "managed-project-bootstrap-claim",
    claimId: randomBytes(16).toString("hex"),
    projectRoot,
    workspaceMode,
    minimumWriterSchemaVersion: minimumWriterSchemaVersionForWorkspace(workspaceMode),
    purpose: normalizeBootstrapPurpose(input.purpose),
    payload: structuredClone(input.payload),
    createdAt: new Date().toISOString(),
  };
  const claim: ManagedProjectBootstrapClaim = { ...semantic, fingerprint: bootstrapClaimFingerprint(semantic) };
  const bytes = Buffer.from(`${JSON.stringify(stableValue(claim), null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_BOOTSTRAP_CLAIM_BYTES) throw new Error("bootstrapClaim 超过 64 KiB。 ");
  const claimPath = path.join(projectRoot, MANAGED_BOOTSTRAP_CLAIM_RELATIVE_PATH);
  const claimDirectory = path.dirname(claimPath);
  await mkdir(claimDirectory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(claimDirectory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || await realpath(claimDirectory) !== claimDirectory) {
    throw new Error("bootstrap claim 父目录不是安全真实目录。 ");
  }
  const temporary = path.join(claimDirectory, `.managed-bootstrap-claim.${claim.claimId}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, claimPath);
    const directoryHandle = await open(claimDirectory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return claim;
}

async function readManagedProjectBootstrapClaimFromLocation(
  claimLocationRoot: string,
  expectedProjectRoot: string,
): Promise<ManagedProjectBootstrapClaim | null> {
  const canonicalRoot = await assertRealDirectoryWithoutSymlink(claimLocationRoot, "bootstrap claim 工程根");
  const canonicalExpectedProjectRoot = path.resolve(expectedProjectRoot);
  const claimPath = path.join(canonicalRoot, MANAGED_BOOTSTRAP_CLAIM_RELATIVE_PATH);
  const metadata = await lstat(claimPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_BOOTSTRAP_CLAIM_BYTES) {
    throw new Error("managed bootstrap claim 类型或大小无效。 ");
  }
  if (await realpath(claimPath) !== claimPath) throw new Error("managed bootstrap claim 不得经符号链接访问。 ");
  const handle = await open(claimPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== metadata.dev || before.ino !== metadata.ino
      || before.size < 2 || before.size > MAX_BOOTSTRAP_CLAIM_BYTES) {
      throw new Error("managed bootstrap claim 文件身份无效。 ");
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || bytes.byteLength !== before.size || await realpath(claimPath) !== claimPath) {
      throw new Error("managed bootstrap claim 读取期间发生替换。 ");
    }
  } finally {
    await handle.close();
  }
  const parsed = parseJsonObject(bytes, claimPath);
  if (parsed.schemaVersion !== 3 || parsed.kind !== "managed-project-bootstrap-claim"
    || typeof parsed.claimId !== "string" || !/^[a-f0-9]{32}$/u.test(parsed.claimId)
    || parsed.projectRoot !== canonicalExpectedProjectRoot
    || !isWorkspaceMode(parsed.workspaceMode)
    || parsed.minimumWriterSchemaVersion !== minimumWriterSchemaVersionForWorkspace(parsed.workspaceMode)
    || typeof parsed.purpose !== "string" || !isRecord(parsed.payload)
    || typeof parsed.createdAt !== "string" || typeof parsed.fingerprint !== "string") {
    throw new Error("managed bootstrap claim 结构无效。 ");
  }
  const claim = parsed as unknown as ManagedProjectBootstrapClaim;
  const { fingerprint, ...semantic } = claim;
  if (bootstrapClaimFingerprint(semantic) !== fingerprint) throw new Error("managed bootstrap claim fingerprint 无效。 ");
  normalizeBootstrapPurpose(claim.purpose);
  return claim;
}

export async function readManagedProjectBootstrapClaim(
  projectRoot: string,
): Promise<ManagedProjectBootstrapClaim | null> {
  const canonicalRoot = await assertRealDirectoryWithoutSymlink(projectRoot, "bootstrap claim 工程根");
  return readManagedProjectBootstrapClaimFromLocation(canonicalRoot, canonicalRoot);
}

function managedPaths(projectRoot: string, workspaceMode: WorkspaceMode = "drama"): ManagedProjectPaths {
  const sidecar = getSidecarPaths(projectRoot);
  const derivedRoot = path.join(sidecar.root, "derived");
  return {
    root: projectRoot,
    sidecar: sidecar.root,
    config: sidecar.config,
    index: sidecar.index,
    cache: workspaceMode === "drama" ? sidecar.cache : path.join(sidecar.root, PROJECT_CACHE_V2_FILE),
    manifest: path.join(sidecar.root, MANAGED_MANIFEST_FILE),
    materialDatabase: path.join(sidecar.root, "material-studio.sqlite"),
    productionDatabase: path.join(sidecar.root, "studio-production.sqlite"),
    textCas: path.join(sidecar.root, "studio-production", "objects", "sha256"),
    generationDatabase: path.join(sidecar.root, "studio-generation-ledger.sqlite"),
    generationPackCas: path.join(sidecar.root, "studio-generation", "objects", "sha256"),
    progressMarkdown: sidecar.progressMarkdown,
    mediaCas: path.join(sidecar.root, "objects", "sha256"),
    mediaPreviews: path.join(derivedRoot, "thumb"),
    mediaProxies: path.join(derivedRoot, "proxy"),
    mediaWaveforms: path.join(derivedRoot, "waveform"),
  };
}

function normalizeProjectName(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new Error("受管项目名称不能为空。");
  if (normalized.length > 120) throw new Error("受管项目名称不得超过 120 个字符。");
  if (/\p{Cc}/u.test(normalized)) throw new Error("受管项目名称不得包含控制字符。");
  return normalized;
}

export function managedProjectSlug(value: string): string {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return normalized || "ai-drama";
}

function bootstrapRecoveryRecordFingerprint(
  value: Omit<ManagedProjectBootstrapRecoveryRecord, "fingerprint">,
): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function sameStableJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function managedBootstrapCandidateRootName(name: string, slug: string): boolean {
  if (name === slug) return true;
  if (!name.startsWith(`${slug}-`)) return false;
  return /^[a-f0-9]{8}$/u.test(name.slice(slug.length + 1));
}

function maybeInterruptManagedBootstrapForTests(
  phase:
    | "after-storage"
    | "after-quarantine-rename"
    | "after-quarantine-replacement-root"
    | "after-quarantine-replacement-claim",
): void {
  if (process.env.NODE_ENV === "test"
    && process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT === phase) {
    throw new Error(`test-only managed bootstrap interruption: ${phase}`);
  }
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function getManagedBootstrapQuarantineDirectory(
  parentRoot: string,
  create: boolean,
): Promise<string | null> {
  const quarantine = path.join(parentRoot, MANAGED_BOOTSTRAP_QUARANTINE_DIRECTORY);
  let metadata = await lstat(quarantine).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!metadata && create) {
    await mkdir(quarantine, { mode: 0o700 });
    metadata = await lstat(quarantine);
    await syncDirectory(parentRoot);
  }
  if (!metadata) return null;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || await realpath(quarantine) !== quarantine || !isWithin(quarantine, parentRoot)) {
    throw new Error(`managed bootstrap quarantine 不是父目录内安全真实目录：${quarantine}`);
  }
  return quarantine;
}

function bootstrapRecoveryNamespaceName(
  purpose: string,
  payload: Record<string, unknown>,
  workspaceMode: WorkspaceMode,
): string {
  return `owner-${sha256(JSON.stringify(stableValue({
    purpose: normalizeBootstrapPurpose(purpose),
    payload,
    workspaceMode,
    minimumWriterSchemaVersion: minimumWriterSchemaVersionForWorkspace(workspaceMode),
  })))}`;
}

async function getManagedBootstrapRecoveryNamespace(
  quarantine: string,
  purpose: string,
  payload: Record<string, unknown>,
  workspaceMode: WorkspaceMode,
  create: boolean,
): Promise<string | null> {
  const namespace = path.join(quarantine, bootstrapRecoveryNamespaceName(purpose, payload, workspaceMode));
  let metadata = await lstat(namespace).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!metadata && create) {
    await mkdir(namespace, { mode: 0o700 });
    metadata = await lstat(namespace);
    await syncDirectory(quarantine);
  }
  if (!metadata) return null;
  if (!MANAGED_BOOTSTRAP_RECOVERY_NAMESPACE_PATTERN.test(path.basename(namespace))
    || !metadata.isDirectory() || metadata.isSymbolicLink()
    || await realpath(namespace) !== namespace || !isWithin(namespace, quarantine)) {
    throw new Error(`managed bootstrap recovery namespace 不是 quarantine 内安全真实目录：${namespace}`);
  }
  return namespace;
}

function bootstrapRecoveryRecordPath(namespace: string, originalProjectRoot: string): string {
  return path.join(namespace, `recovery-${sha256(path.resolve(originalProjectRoot))}.json`);
}

function validateBootstrapRecoveryRecord(
  raw: Record<string, unknown>,
  recordPath: string,
  parentRoot: string,
  namespace: string,
): ManagedProjectBootstrapRecoveryRecord {
  if (raw.schemaVersion !== 2 || raw.kind !== "managed-project-bootstrap-recovery"
    || typeof raw.originalProjectRoot !== "string"
    || !isWorkspaceMode(raw.workspaceMode)
    || raw.minimumWriterSchemaVersion !== minimumWriterSchemaVersionForWorkspace(raw.workspaceMode)
    || typeof raw.bootstrapPurpose !== "string"
    || !isRecord(raw.bootstrapPayload)
    || !Array.isArray(raw.attempts)
    || raw.attempts.length < 1
    || raw.attempts.length > MAX_BOOTSTRAP_RECOVERY_ATTEMPTS
    || typeof raw.updatedAt !== "string"
    || typeof raw.fingerprint !== "string") {
    throw new Error(`managed bootstrap recovery 结构无效：${recordPath}`);
  }
  const record = raw as unknown as ManagedProjectBootstrapRecoveryRecord;
  if (path.resolve(record.originalProjectRoot) !== record.originalProjectRoot
    || path.dirname(record.originalProjectRoot) !== parentRoot
    || bootstrapRecoveryRecordPath(namespace, record.originalProjectRoot) !== recordPath) {
    throw new Error(`managed bootstrap recovery 原路径越界或身份不一致：${recordPath}`);
  }
  normalizeBootstrapPurpose(record.bootstrapPurpose);
  if (path.basename(namespace) !== bootstrapRecoveryNamespaceName(
    record.bootstrapPurpose,
    record.bootstrapPayload,
    record.workspaceMode,
  )) {
    throw new Error(`managed bootstrap recovery owner namespace 与工作区身份不一致：${recordPath}`);
  }
  const seenRecoveryIds = new Set<string>();
  const seenQuarantinedRoots = new Set<string>();
  for (const attempt of record.attempts) {
    const reconciledFieldCount = [
      attempt?.reconciledProjectId,
      attempt?.reconciledClaimFingerprint,
      attempt?.reconciledAt,
    ].filter((value) => value !== undefined).length;
    if (!attempt || typeof attempt !== "object"
      || !/^[a-f0-9]{32}$/u.test(attempt.recoveryId)
      || !/^[a-f0-9]{64}$/u.test(attempt.priorClaimFingerprint)
      || typeof attempt.quarantinedProjectRoot !== "string"
      || typeof attempt.preparedAt !== "string"
      || (attempt.replacementClaimFingerprint !== undefined
        && !/^[a-f0-9]{64}$/u.test(attempt.replacementClaimFingerprint))
      || (attempt.replacementClaimedAt !== undefined && typeof attempt.replacementClaimedAt !== "string")
      || (attempt.rebuiltProjectId !== undefined && typeof attempt.rebuiltProjectId !== "string")
      || (attempt.completedAt !== undefined && typeof attempt.completedAt !== "string")
      || (attempt.reconciledProjectId !== undefined && typeof attempt.reconciledProjectId !== "string")
      || (attempt.reconciledClaimFingerprint !== undefined
        && !/^[a-f0-9]{64}$/u.test(attempt.reconciledClaimFingerprint))
      || (attempt.reconciledAt !== undefined && typeof attempt.reconciledAt !== "string")
      || (reconciledFieldCount !== 0 && reconciledFieldCount !== 3)) {
      throw new Error(`managed bootstrap recovery attempt 无效：${recordPath}`);
    }
    const quarantinedRoot = path.resolve(attempt.quarantinedProjectRoot);
    if (quarantinedRoot !== attempt.quarantinedProjectRoot
      || !isWithin(quarantinedRoot, namespace)
      || path.basename(quarantinedRoot) !== "project-root"
      || path.dirname(path.dirname(quarantinedRoot)) !== namespace
      || seenRecoveryIds.has(attempt.recoveryId)
      || seenQuarantinedRoots.has(quarantinedRoot)) {
      throw new Error(`managed bootstrap recovery attempt 路径越界或重复：${recordPath}`);
    }
    seenRecoveryIds.add(attempt.recoveryId);
    seenQuarantinedRoots.add(quarantinedRoot);
  }
  const { fingerprint, ...semantic } = record;
  if (bootstrapRecoveryRecordFingerprint(semantic) !== fingerprint) {
    throw new Error(`managed bootstrap recovery fingerprint 无效：${recordPath}`);
  }
  return record;
}

async function readBootstrapRecoveryRecord(
  recordPath: string,
  parentRoot: string,
  namespace: string,
): Promise<ManagedProjectBootstrapRecoveryRecord | null> {
  const metadata = await lstat(recordPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || metadata.size < 2 || metadata.size > MAX_BOOTSTRAP_RECOVERY_RECORD_BYTES
    || await realpath(recordPath) !== recordPath) {
    throw new Error(`managed bootstrap recovery 文件身份无效：${recordPath}`);
  }
  return validateBootstrapRecoveryRecord(
    parseJsonObject(await readFile(recordPath), recordPath),
    recordPath,
    parentRoot,
    namespace,
  );
}

async function writeBootstrapRecoveryRecord(
  recordPath: string,
  semantic: Omit<ManagedProjectBootstrapRecoveryRecord, "fingerprint">,
): Promise<ManagedProjectBootstrapRecoveryRecord> {
  const record: ManagedProjectBootstrapRecoveryRecord = {
    ...semantic,
    fingerprint: bootstrapRecoveryRecordFingerprint(semantic),
  };
  await writeJsonAtomic(recordPath, record);
  return record;
}

async function assertRealDirectoryWithoutSymlink(input: string, label: string): Promise<string> {
  const absolute = path.resolve(input);
  const metadata = await lstat(absolute).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label}不存在：${absolute}`);
    }
    throw error;
  });
  if (metadata.isSymbolicLink()) throw new Error(`${label}禁止使用符号链接：${absolute}`);
  if (!metadata.isDirectory()) throw new Error(`${label}必须是目录：${absolute}`);
  const canonical = await realpath(absolute);
  if (canonical !== absolute) throw new Error(`${label}的真实路径与输入不一致，禁止通过符号链接或路径别名访问：${absolute}`);
  return canonical;
}

async function allocateProjectRoot(parentRoot: string, slug: string): Promise<{ root: string; identity: CreatedDirectoryIdentity }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = randomBytes(4).toString("hex");
    const candidate = path.join(parentRoot, `${slug}-${suffix}`);
    try {
      await mkdir(candidate, { mode: 0o700 });
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const metadata = await lstat(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`新项目根目录创建后类型异常，已停止：${candidate}`);
    }
    const canonical = await realpath(candidate);
    if (!isWithin(canonical, parentRoot) || canonical !== candidate) {
      throw new Error(`新项目根目录 realpath 越出受权父目录，已停止：${canonical}`);
    }
    return { root: canonical, identity: { dev: metadata.dev, ino: metadata.ino, realpath: canonical } };
  }
  throw new Error("连续 8 次遇到同名项目目录，为避免接管既有目录已停止创建。");
}

async function rollbackCreatedRoot(projectRoot: string, identity: CreatedDirectoryIdentity): Promise<void> {
  try {
    const metadata = await lstat(projectRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.dev !== identity.dev || metadata.ino !== identity.ino) return;
    if (await realpath(projectRoot) !== identity.realpath) return;
    await rm(projectRoot, { recursive: true, force: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function ensureSidecarWithoutGlobalRegistration(projectRoot: string): Promise<ProjectConfig> {
  return ensureSidecar(projectRoot, { register: false });
}

function emptySummary(): ProgressSummary {
  const byStatus = Object.fromEntries(WORK_ITEM_STATUSES.map((status) => [status, 0])) as Record<WorkItemStatus, number>;
  return {
    total: 0,
    active: 0,
    completed: 0,
    deprecated: 0,
    blocked: 0,
    byStatus,
    byEpisode: {},
    rawImages: 0,
    labeledImages: 0,
    videos: 0,
    mechanicalFailures: 0,
  };
}

function buildEmptyIndex(project: ProjectConfig, createdAt: string, suffix: string): ProjectIndex {
  return {
    schemaVersion: 1,
    project,
    scanId: `managed-bootstrap-${suffix}`,
    scannedAt: createdAt,
    scanDurationMs: 0,
    scanStats: {
      discoveredFiles: 0,
      candidateFiles: 0,
      reservedPublicationFilesSkipped: 0,
      referenceAssets: 0,
      productionAssets: 0,
      inspectedChecks: 0,
      reusedChecks: 0,
      textFilesRead: 0,
      includeHashes: false,
      inspectionConcurrency: 0,
    },
    warnings: [],
    summary: emptySummary(),
    items: [],
    artifacts: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(content: Buffer, filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(content.toString("utf8")); }
  catch (error) { throw new Error(`受管项目 JSON 已损坏：${filePath}`, { cause: error }); }
  if (!isRecord(parsed)) throw new Error(`受管项目 JSON 根节点必须是对象：${filePath}`);
  return parsed;
}

function isCanonicalUtcIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validateNovelWorkspaceManifestForAttachment(
  value: Record<string, unknown>,
  filePath: string,
): NovelWorkspaceManifest {
  if (value.schemaVersion !== 1
    || value.kind !== "novel-workspace-manifest"
    || typeof value.projectId !== "string" || value.projectId.length === 0
    || !isNovelSourceMode(value.sourceMode)
    || (value.sourceMode === "managed_markdown"
      ? value.chapterManifest !== NOVEL_CHAPTER_MANIFEST_RELATIVE_PATH
      : value.chapterManifest !== undefined)
    || !Array.isArray(value.sourceReceiptIds)
    || !value.sourceReceiptIds.every((entry) => typeof entry === "string" && entry.length > 0)
    || new Set(value.sourceReceiptIds).size !== value.sourceReceiptIds.length
    || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !isCanonicalUtcIsoDate(value.createdAt)
    || !isCanonicalUtcIsoDate(value.updatedAt)
    || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(value.fingerprint)) {
    throw new Error(`novel workspace manifest 结构无效：${filePath}`);
  }
  const manifest = value as unknown as NovelWorkspaceManifest;
  const { fingerprint, ...semantic } = manifest;
  if (novelWorkspaceManifestFingerprint(semantic) !== fingerprint) {
    throw new Error(`novel workspace manifest fingerprint 无效：${filePath}`);
  }
  return manifest;
}

async function readNovelWorkspaceManifestForAttachment(
  projectRoot: string,
): Promise<NovelWorkspaceManifest> {
  const manifestPath = path.join(projectRoot, NOVEL_MANIFEST_RELATIVE_PATH);
  if (path.relative(projectRoot, manifestPath) !== NOVEL_MANIFEST_RELATIVE_PATH) {
    throw new Error("novel workspace manifest locator 不是固定受管路径。 ");
  }
  const manifestDirectory = path.dirname(manifestPath);
  const directoryMetadata = await lstat(manifestDirectory).catch(() => null);
  if (!directoryMetadata || !directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()
    || await realpath(manifestDirectory) !== manifestDirectory
    || !isWithin(manifestDirectory, projectRoot)) {
    throw new Error(`novel workspace manifest 父目录不是项目内安全真实目录：${manifestDirectory}`);
  }
  const metadata = await lstat(manifestPath).catch(() => null);
  if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.size < 2 || metadata.size > MAX_NOVEL_WORKSPACE_MANIFEST_BYTES
    || await realpath(manifestPath) !== manifestPath) {
    throw new Error(`novel workspace manifest 不是安全普通文件：${manifestPath}`);
  }
  const handle = await open(manifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1
      || before.dev !== metadata.dev || before.ino !== metadata.ino
      || before.size < 2 || before.size > MAX_NOVEL_WORKSPACE_MANIFEST_BYTES) {
      throw new Error(`novel workspace manifest 文件身份无效：${manifestPath}`);
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(manifestPath);
    if (!after.isFile() || after.nlink !== 1 || !pathAfter.isFile() || pathAfter.isSymbolicLink()
      || pathAfter.nlink !== 1
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino
      || pathAfter.size !== before.size || pathAfter.mtimeMs !== before.mtimeMs
      || pathAfter.ctimeMs !== before.ctimeMs
      || bytes.byteLength !== before.size || await realpath(manifestPath) !== manifestPath) {
      throw new Error(`novel workspace manifest 读取期间发生替换：${manifestPath}`);
    }
  } finally {
    await handle.close();
  }
  return validateNovelWorkspaceManifestForAttachment(parseJsonObject(bytes, manifestPath), manifestPath);
}

function validateProjectConfig(value: Record<string, unknown>, filePath: string): ProjectConfig {
  if (typeof value.schemaVersion === "number"
    && Number.isSafeInteger(value.schemaVersion)
    && value.schemaVersion > MANAGED_PROJECT_WRITER_SCHEMA_VERSION) {
    throw new Error(
      `受管项目配置最低 writer v${value.schemaVersion} 高于当前 writer v${MANAGED_PROJECT_WRITER_SCHEMA_VERSION}，已在任何侧车或账本写入前停止：${filePath}`,
    );
  }
  if ((value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || typeof value.id !== "string"
    || typeof value.name !== "string"
    || typeof value.primaryRoot !== "string"
    || !Array.isArray(value.sourceRoots) || !value.sourceRoots.every((entry) => typeof entry === "string")
    || !Array.isArray(value.outputRoots) || !value.outputRoots.every((entry) => typeof entry === "string")) {
    throw new Error(`受管项目配置结构无效：${filePath}`);
  }
  if (value.schemaVersion === 1) {
    if ("workspaceMode" in value || "minimumWriterSchemaVersion" in value) {
      throw new Error(`schema v1 受管项目配置不得夹带 v2 writer 字段：${filePath}`);
    }
  } else if ((value.workspaceMode !== "novel" && value.workspaceMode !== "hybrid")
    || value.minimumWriterSchemaVersion !== MANAGED_PROJECT_WRITER_SCHEMA_VERSION) {
    throw new Error(`schema v2 受管项目配置 writer 声明无效：${filePath}`);
  }
  return value as unknown as ProjectConfig;
}

function validateIndex(value: Record<string, unknown>, filePath: string): ProjectIndex {
  if (value.schemaVersion !== 1
    || !isRecord(value.project)
    || !Array.isArray(value.items)
    || !Array.isArray(value.artifacts)
    || !isRecord(value.summary)
    || typeof value.summary.total !== "number") {
    throw new Error(`受管项目索引结构无效：${filePath}`);
  }
  return value as unknown as ProjectIndex;
}

function validateManifest(value: Record<string, unknown>, filePath: string): ManagedProjectManifest {
  if (typeof value.schemaVersion === "number"
    && Number.isSafeInteger(value.schemaVersion)
    && value.schemaVersion > MANAGED_PROJECT_WRITER_SCHEMA_VERSION) {
    throw new Error(
      `受管项目 schema v${value.schemaVersion} 高于当前 writer v${MANAGED_PROJECT_WRITER_SCHEMA_VERSION}，已在任何侧车或账本写入前停止：${filePath}`,
    );
  }
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    throw new Error(`受管项目 schemaVersion 不受支持：${filePath}`);
  }
  if (value.schemaVersion === 2
    && typeof value.minimumWriterSchemaVersion === "number"
    && Number.isSafeInteger(value.minimumWriterSchemaVersion)
    && value.minimumWriterSchemaVersion > MANAGED_PROJECT_WRITER_SCHEMA_VERSION) {
    throw new Error(
      `受管项目最低 writer v${value.minimumWriterSchemaVersion} 高于当前 writer v${MANAGED_PROJECT_WRITER_SCHEMA_VERSION}，已在任何侧车或账本写入前停止：${filePath}`,
    );
  }
  const relativePaths = value.relativePaths;
  if (value.kind !== "ai-canvas-managed-project"
    || typeof value.projectId !== "string"
    || typeof value.projectName !== "string"
    || typeof value.rootRealpath !== "string"
    || value.storageMode !== "managed"
    || value.startupPolicy !== "no-filesystem-scan"
    || value.mediaMode !== "project-local-cas"
    || !Array.isArray(value.legacyRoots) || value.legacyRoots.length !== 0
    || typeof value.projectConfigSha256 !== "string"
    || typeof value.bootstrapIndexSha256 !== "string"
    || typeof value.bootstrapScanId !== "string"
    || typeof value.createdAt !== "string"
    || typeof value.fingerprint !== "string"
    || !isRecord(relativePaths)
    || relativePaths.config !== ".aicanvas/project.json"
    || relativePaths.index !== ".aicanvas/index.json"
    || relativePaths.materialDatabase !== ".aicanvas/material-studio.sqlite"
    || (relativePaths.productionDatabase !== undefined && relativePaths.productionDatabase !== ".aicanvas/studio-production.sqlite")
    || (relativePaths.textCas !== undefined && relativePaths.textCas !== ".aicanvas/studio-production/objects/sha256")
    || (relativePaths.generationDatabase !== undefined && relativePaths.generationDatabase !== ".aicanvas/studio-generation-ledger.sqlite")
    || (relativePaths.generationPackCas !== undefined && relativePaths.generationPackCas !== ".aicanvas/studio-generation/objects/sha256")
    || relativePaths.mediaCas !== ".aicanvas/objects/sha256"
    || relativePaths.mediaPreviews !== ".aicanvas/derived/thumb"
    || relativePaths.mediaProxies !== ".aicanvas/derived/proxy"
    || relativePaths.mediaWaveforms !== ".aicanvas/derived/waveform") {
    throw new Error(`受管项目 manifest 结构或隔离策略无效：${filePath}`);
  }

  if (value.schemaVersion === 1) {
    if (relativePaths.cache !== ".aicanvas/cache.sqlite"
      || "workspaceMode" in value || "minimumWriterSchemaVersion" in value || "novelManifest" in value) {
      throw new Error(`schema v1 manifest 不得夹带 v2 工作区字段：${filePath}`);
    }
  } else {
    if (relativePaths.cache !== `.aicanvas/${PROJECT_CACHE_V2_FILE}`
      || (value.workspaceMode !== "novel" && value.workspaceMode !== "hybrid")
      || value.minimumWriterSchemaVersion !== MANAGED_PROJECT_WRITER_SCHEMA_VERSION
      || (value.novelManifest !== undefined && value.novelManifest !== NOVEL_MANIFEST_RELATIVE_PATH)) {
      throw new Error(`schema v2 manifest 的工作区声明无效：${filePath}`);
    }
  }
  return value as unknown as ManagedProjectManifest;
}

async function assertManagedDirectory(directory: string, projectRoot: string, label: string): Promise<void> {
  const metadata = await lstat(directory).catch(() => null);
  if (!metadata || !metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label}不存在或已被替换：${directory}`);
  const canonical = await realpath(directory);
  if (!isWithin(canonical, projectRoot)) throw new Error(`${label} realpath 越出项目根：${canonical}`);
}

async function assertManagedFile(filePath: string, projectRoot: string, label: string): Promise<void> {
  const metadata = await lstat(filePath).catch(() => null);
  if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label}不存在或已被替换：${filePath}`);
  const canonical = await realpath(filePath);
  if (!isWithin(canonical, projectRoot)) throw new Error(`${label} realpath 越出项目根：${canonical}`);
}

async function assertOptionalManagedPath(
  targetPath: string,
  projectRoot: string,
  label: string,
  kind: "directory" | "file",
): Promise<void> {
  const metadata = await lstat(targetPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return;
  if (metadata.isSymbolicLink() || (kind === "directory" ? !metadata.isDirectory() : !metadata.isFile())) {
    throw new Error(`${label}类型无效或是符号链接：${targetPath}`);
  }
  const canonical = await realpath(targetPath);
  if (!isWithin(canonical, projectRoot)) throw new Error(`${label} realpath 越出项目根：${canonical}`);
}

async function materializeManagedStorage(paths: ManagedProjectPaths): Promise<void> {
  await Promise.all([
    paths.mediaCas,
    paths.mediaPreviews,
    paths.mediaProxies,
    paths.mediaWaveforms,
  ].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  await Promise.all([initializeMaterialStudio(paths.root), initializeStudioProduction(paths.root)]);
}

async function writeManagedManifest(
  paths: ManagedProjectPaths,
  project: ProjectConfig,
  index: ProjectIndex,
  createdAt: string,
  workspaceMode: WorkspaceMode,
): Promise<void> {
  const [configContent, indexContent] = await Promise.all([readFile(paths.config), readFile(paths.index)]);
  const relativePaths: ManagedProjectManifestBase["relativePaths"] = {
    config: ".aicanvas/project.json",
    index: ".aicanvas/index.json",
    cache: workspaceMode === "drama" ? ".aicanvas/cache.sqlite" : `.aicanvas/${PROJECT_CACHE_V2_FILE}`,
    materialDatabase: ".aicanvas/material-studio.sqlite",
    productionDatabase: ".aicanvas/studio-production.sqlite",
    textCas: ".aicanvas/studio-production/objects/sha256",
    generationDatabase: ".aicanvas/studio-generation-ledger.sqlite",
    generationPackCas: ".aicanvas/studio-generation/objects/sha256",
    mediaCas: ".aicanvas/objects/sha256",
    mediaPreviews: ".aicanvas/derived/thumb",
    mediaProxies: ".aicanvas/derived/proxy",
    mediaWaveforms: ".aicanvas/derived/waveform",
  };
  if (workspaceMode === "drama") {
    // schema v1 是已发布的 drama 合同；字段与顺序保持原样，不能落盘 v2 投影字段。
    const manifestPayload: Omit<ManagedProjectManifestV1, "fingerprint"> = {
      schemaVersion: 1,
      kind: "ai-canvas-managed-project",
      projectId: project.id,
      projectName: project.name,
      rootRealpath: paths.root,
      storageMode: "managed",
      startupPolicy: "no-filesystem-scan",
      mediaMode: "project-local-cas",
      legacyRoots: [],
      projectConfigSha256: sha256(configContent),
      bootstrapIndexSha256: sha256(indexContent),
      bootstrapScanId: index.scanId,
      relativePaths,
      createdAt,
    };
    await writeJsonAtomic(paths.manifest, {
      ...manifestPayload,
      fingerprint: manifestFingerprint(manifestPayload),
    } satisfies ManagedProjectManifestV1);
    return;
  }

  const manifestPayload: Omit<ManagedProjectManifestV2, "fingerprint"> = {
    schemaVersion: 2,
    kind: "ai-canvas-managed-project",
    projectId: project.id,
    projectName: project.name,
    rootRealpath: paths.root,
    storageMode: "managed",
    startupPolicy: "no-filesystem-scan",
    mediaMode: "project-local-cas",
    legacyRoots: [],
    projectConfigSha256: sha256(configContent),
    bootstrapIndexSha256: sha256(indexContent),
    bootstrapScanId: index.scanId,
    relativePaths,
    workspaceMode,
    minimumWriterSchemaVersion: MANAGED_PROJECT_WRITER_SCHEMA_VERSION,
    createdAt,
  };
  await writeJsonAtomic(paths.manifest, {
    ...manifestPayload,
    fingerprint: manifestFingerprint(manifestPayload),
  } satisfies ManagedProjectManifestV2);
}

async function materializeManagedProjectRoot(
  projectRoot: string,
  name: string,
  createdAt: string,
  workspaceMode: WorkspaceMode = "drama",
): Promise<ProjectShell> {
  const paths = managedPaths(projectRoot, workspaceMode);
  const ensured = await ensureSidecarWithoutGlobalRegistration(projectRoot);
  const commonProject: ProjectConfig = {
    ...ensured,
    name,
    primaryRoot: projectRoot,
    sourceRoots: [],
    outputRoots: [projectRoot],
    updatedAt: createdAt,
    automation: { ...ensured.automation, allowOverwriteAuthoritative: false },
  };
  const project: ProjectConfig = workspaceMode === "drama"
    ? commonProject
    : {
      ...commonProject,
      schemaVersion: 2,
      workspaceMode,
      minimumWriterSchemaVersion: MANAGED_PROJECT_WRITER_SCHEMA_VERSION,
    };
  await writeJsonAtomic(paths.config, project);
  const suffix = path.basename(projectRoot).split("-").at(-1) ?? randomBytes(4).toString("hex");
  const index = buildEmptyIndex(project, createdAt, suffix);
  await saveIndex(index);
  const cache = new ProjectCache(projectRoot, {
    writerSchemaVersion: workspaceMode === "drama" ? 1 : MANAGED_PROJECT_WRITER_SCHEMA_VERSION,
  });
  try { cache.replaceIndex(index); }
  finally { cache.close(); }
  await materializeManagedStorage(paths);
  maybeInterruptManagedBootstrapForTests("after-storage");
  if (workspaceMode !== "drama") {
    await createLegacyProjectCacheWriterFence(paths.root, project.id);
    await createManagedProjectWriterFence(paths.root, project.id);
  }
  await writeManagedManifest(paths, project, index, createdAt, workspaceMode);
  return inspectManagedProject(projectRoot);
}

async function assertRecoverableUnclaimedBootstrapRoot(projectRoot: string): Promise<void> {
  const rootEntries = await readdir(projectRoot, { withFileTypes: true });
  if (rootEntries.length === 0) return;
  if (rootEntries.length !== 1 || rootEntries[0]!.name !== ".aicanvas" || !rootEntries[0]!.isDirectory()
    || rootEntries[0]!.isSymbolicLink()) {
    throw new Error(`无 claim 的项目根并非可证明空 bootstrap orphan：${projectRoot}`);
  }
  const sidecar = path.join(projectRoot, ".aicanvas");
  if (await realpath(sidecar) !== sidecar) throw new Error(`bootstrap orphan sidecar 经符号链接：${projectRoot}`);
  const entries = await readdir(sidecar, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()
      || !/^\.managed-bootstrap-claim\.[a-f0-9]{32}\.tmp$/u.test(entry.name)) {
      throw new Error(`无 claim 的 bootstrap orphan 含非临时内容：${path.join(sidecar, entry.name)}`);
    }
  }
  for (const entry of entries) await unlink(path.join(sidecar, entry.name));
}

async function assertRecoverableClaimOnlyBootstrapRoot(
  projectRoot: string,
  claim: ManagedProjectBootstrapClaim,
): Promise<void> {
  const rootEntries = await readdir(projectRoot, { withFileTypes: true });
  if (rootEntries.length !== 1 || rootEntries[0]!.name !== ".aicanvas" || !rootEntries[0]!.isDirectory()
    || rootEntries[0]!.isSymbolicLink()) {
    throw new Error(`已有 claim 的项目根含 bootstrap owner 之外的内容：${projectRoot}`);
  }
  const sidecar = path.join(projectRoot, ".aicanvas");
  if (await realpath(sidecar) !== sidecar) throw new Error(`bootstrap claim sidecar 经符号链接：${projectRoot}`);
  const entries = await readdir(sidecar, { withFileTypes: true });
  const temporaryName = `.managed-bootstrap-claim.${claim.claimId}.tmp`;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()
      || (entry.name !== "managed-bootstrap-claim.json" && entry.name !== temporaryName)) {
      throw new Error(`已有 claim 的 bootstrap 根含不可恢复内容：${path.join(sidecar, entry.name)}`);
    }
  }
  if (!entries.some((entry) => entry.name === "managed-bootstrap-claim.json")) {
    throw new Error(`已有 claim 的 bootstrap 根缺少固定 claim 文件：${projectRoot}`);
  }
  const temporaryPath = path.join(sidecar, temporaryName);
  if (entries.some((entry) => entry.name === temporaryName)) await unlink(temporaryPath);
}

async function assertRecoverableClaimedPartialBootstrapRoot(projectRoot: string): Promise<void> {
  const paths = managedPaths(projectRoot);
  const disqualifyingPaths = [
    paths.manifest,
    paths.generationDatabase,
    path.join(paths.sidecar, "local-creative-project-ingest.json"),
  ];
  for (const candidate of disqualifyingPaths) {
    const metadata = await lstat(candidate).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (metadata) {
      throw new Error(`已有 claim 的根含完成后证据，不属于可隔离 bootstrap 半成品：${candidate}`);
    }
  }
  const eventsPath = path.join(paths.sidecar, "events.jsonl");
  const eventsMetadata = await lstat(eventsPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (eventsMetadata && (!eventsMetadata.isFile() || eventsMetadata.isSymbolicLink() || eventsMetadata.size > 0)) {
    throw new Error(`已有 claim 的根含非空或异常事件账本，不属于可隔离 bootstrap 半成品：${eventsPath}`);
  }
}

async function updateBootstrapRecoveryAttempt(
  recordPath: string,
  parentRoot: string,
  namespace: string,
  recoveryId: string,
  update: (attempt: ManagedProjectBootstrapRecoveryAttempt) => ManagedProjectBootstrapRecoveryAttempt,
): Promise<ManagedProjectBootstrapRecoveryRecord> {
  const current = await readBootstrapRecoveryRecord(recordPath, parentRoot, namespace);
  if (!current) throw new Error(`managed bootstrap recovery 记录消失：${recordPath}`);
  const index = current.attempts.findIndex((attempt) => attempt.recoveryId === recoveryId);
  if (index < 0) throw new Error(`managed bootstrap recovery attempt 不存在：${recoveryId}`);
  const attempts = current.attempts.map((attempt, offset) => offset === index ? update({ ...attempt }) : { ...attempt });
  const { fingerprint: _fingerprint, ...semantic } = current;
  return writeBootstrapRecoveryRecord(recordPath, {
    ...semantic,
    attempts,
    updatedAt: new Date().toISOString(),
  });
}

async function prepareClaimedBootstrapQuarantine(
  projectRoot: string,
  claim: ManagedProjectBootstrapClaim,
): Promise<{
  parentRoot: string;
  quarantine: string;
  namespace: string;
  recordPath: string;
  record: ManagedProjectBootstrapRecoveryRecord;
  attempt: ManagedProjectBootstrapRecoveryAttempt;
}> {
  await assertRecoverableClaimedPartialBootstrapRoot(projectRoot);
  const parentRoot = await assertRealDirectoryWithoutSymlink(path.dirname(projectRoot), "managed bootstrap 父目录");
  if (!isWithin(projectRoot, parentRoot)) {
    throw new Error(`managed bootstrap 根不在其真实父目录内：${projectRoot}`);
  }
  const quarantine = (await getManagedBootstrapQuarantineDirectory(parentRoot, true))!;
  const namespace = (await getManagedBootstrapRecoveryNamespace(
    quarantine,
    claim.purpose,
    claim.payload,
    claim.workspaceMode,
    true,
  ))!;
  const recordPath = bootstrapRecoveryRecordPath(namespace, projectRoot);
  const existing = await readBootstrapRecoveryRecord(recordPath, parentRoot, namespace);
  if (existing && (existing.originalProjectRoot !== projectRoot
    || existing.workspaceMode !== claim.workspaceMode
    || existing.minimumWriterSchemaVersion !== claim.minimumWriterSchemaVersion
    || existing.bootstrapPurpose !== claim.purpose
    || !sameStableJson(existing.bootstrapPayload, claim.payload))) {
    throw new Error(`managed bootstrap recovery 记录与当前 claim 不一致：${recordPath}`);
  }
  if ((existing?.attempts.length ?? 0) >= MAX_BOOTSTRAP_RECOVERY_ATTEMPTS) {
    throw new Error(`managed bootstrap recovery 已达到 ${MAX_BOOTSTRAP_RECOVERY_ATTEMPTS} 次安全上限：${projectRoot}`);
  }

  const recoveryId = randomBytes(16).toString("hex");
  const caseDirectory = path.join(namespace, `case-${recoveryId}`);
  await mkdir(caseDirectory, { mode: 0o700 });
  const caseMetadata = await lstat(caseDirectory);
  if (!caseMetadata.isDirectory() || caseMetadata.isSymbolicLink()
    || await realpath(caseDirectory) !== caseDirectory || !isWithin(caseDirectory, namespace)) {
    throw new Error(`managed bootstrap quarantine case 目录身份无效：${caseDirectory}`);
  }
  const attempt: ManagedProjectBootstrapRecoveryAttempt = {
    recoveryId,
    priorClaimFingerprint: claim.fingerprint,
    quarantinedProjectRoot: path.join(caseDirectory, "project-root"),
    preparedAt: new Date().toISOString(),
  };
  const semantic: Omit<ManagedProjectBootstrapRecoveryRecord, "fingerprint"> = {
    schemaVersion: 2,
    kind: "managed-project-bootstrap-recovery",
    originalProjectRoot: projectRoot,
    workspaceMode: claim.workspaceMode,
    minimumWriterSchemaVersion: claim.minimumWriterSchemaVersion,
    bootstrapPurpose: claim.purpose,
    bootstrapPayload: structuredClone(claim.payload),
    attempts: [...(existing?.attempts ?? []), attempt],
    updatedAt: attempt.preparedAt,
  };
  const record = await writeBootstrapRecoveryRecord(recordPath, semantic);
  await syncDirectory(namespace);

  const rootMetadata = await lstat(projectRoot);
  const liveClaim = await readManagedProjectBootstrapClaim(projectRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
    || await realpath(projectRoot) !== projectRoot
    || !liveClaim || liveClaim.fingerprint !== claim.fingerprint) {
    throw new Error(`managed bootstrap 根或 claim 在隔离前发生替换：${projectRoot}`);
  }
  await assertRecoverableClaimedPartialBootstrapRoot(projectRoot);
  const confirmedMetadata = await lstat(projectRoot);
  if (confirmedMetadata.dev !== rootMetadata.dev || confirmedMetadata.ino !== rootMetadata.ino) {
    throw new Error(`managed bootstrap 根在隔离前发生身份漂移：${projectRoot}`);
  }
  await rename(projectRoot, attempt.quarantinedProjectRoot);
  await Promise.all([syncDirectory(parentRoot), syncDirectory(caseDirectory)]);
  return { parentRoot, quarantine, namespace, recordPath, record, attempt };
}

async function rebuildManagedBootstrapFromQuarantine(
  recovery: {
    parentRoot: string;
    quarantine: string;
    namespace: string;
    recordPath: string;
    record: ManagedProjectBootstrapRecoveryRecord;
    attempt: ManagedProjectBootstrapRecoveryAttempt;
  },
  options: Pick<CreateManagedProjectOptions, "name" | "workspaceMode" | "bootstrapClaim">,
): Promise<ProjectShell> {
  if (!options.bootstrapClaim) throw new Error("恢复 managed bootstrap 必须提供 bootstrapClaim。 ");
  const workspaceMode = requireBootstrapRecoveryCompatibleWorkspaceMode(options);
  const { parentRoot, namespace, recordPath, record, attempt } = recovery;
  const originalProjectRoot = record.originalProjectRoot;
  if (path.dirname(originalProjectRoot) !== parentRoot) {
    throw new Error(`managed bootstrap recovery 原路径越出父目录：${originalProjectRoot}`);
  }
  const existingOriginal = await lstat(originalProjectRoot).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existingOriginal) {
    throw new Error(`managed bootstrap recovery 原路径已被占用，拒绝覆盖：${originalProjectRoot}`);
  }
  const quarantinedClaim = await readManagedProjectBootstrapClaimFromLocation(
    attempt.quarantinedProjectRoot,
    originalProjectRoot,
  );
  if (!quarantinedClaim
    || quarantinedClaim.fingerprint !== attempt.priorClaimFingerprint
    || quarantinedClaim.workspaceMode !== record.workspaceMode
    || quarantinedClaim.minimumWriterSchemaVersion !== record.minimumWriterSchemaVersion
    || quarantinedClaim.purpose !== record.bootstrapPurpose
    || !sameStableJson(quarantinedClaim.payload, record.bootstrapPayload)) {
    throw new Error(`managed bootstrap quarantine 中的 claim 与恢复记录不一致：${attempt.quarantinedProjectRoot}`);
  }
  const expectedPurpose = normalizeBootstrapPurpose(options.bootstrapClaim.purpose);
  if (record.workspaceMode !== workspaceMode
    || record.minimumWriterSchemaVersion !== minimumWriterSchemaVersionForWorkspace(workspaceMode)) {
    throw new Error(`managed bootstrap quarantine 工作区身份与恢复请求不一致：${recordPath}`);
  }
  if (record.bootstrapPurpose !== expectedPurpose
    || !sameStableJson(record.bootstrapPayload, options.bootstrapClaim.payload)) {
    throw new Error(`managed bootstrap quarantine 与恢复请求不一致：${recordPath}`);
  }

  await mkdir(originalProjectRoot, { mode: 0o700 });
  maybeInterruptManagedBootstrapForTests("after-quarantine-replacement-root");
  const replacementClaim = await writeManagedBootstrapClaim(
    originalProjectRoot,
    options.bootstrapClaim,
    workspaceMode,
  );
  maybeInterruptManagedBootstrapForTests("after-quarantine-replacement-claim");
  await updateBootstrapRecoveryAttempt(
    recordPath,
    parentRoot,
    namespace,
    attempt.recoveryId,
    (current) => ({
      ...current,
      replacementClaimFingerprint: replacementClaim.fingerprint,
      replacementClaimedAt: new Date().toISOString(),
    }),
  );
  const shell = await materializeManagedProjectRoot(
    originalProjectRoot,
    normalizeProjectName(options.name),
    replacementClaim.createdAt,
    workspaceMode,
  );
  await updateBootstrapRecoveryAttempt(
    recordPath,
    parentRoot,
    namespace,
    attempt.recoveryId,
    (current) => ({
      ...current,
      rebuiltProjectId: shell.project.id,
      completedAt: new Date().toISOString(),
    }),
  );
  return shell;
}

async function listBootstrapRecoveryRecordsForOwner(
  parentRoot: string,
  purpose: string,
  payload: Record<string, unknown>,
  workspaceMode: WorkspaceMode,
): Promise<Array<{ recordPath: string; record: ManagedProjectBootstrapRecoveryRecord }>> {
  const quarantine = await getManagedBootstrapQuarantineDirectory(parentRoot, false);
  if (!quarantine) return [];
  const namespace = await getManagedBootstrapRecoveryNamespace(
    quarantine,
    purpose,
    payload,
    workspaceMode,
    false,
  );
  if (!namespace) return [];
  const entries = await readdir(namespace, { withFileTypes: true });
  const records: Array<{ recordPath: string; record: ManagedProjectBootstrapRecoveryRecord }> = [];
  for (const entry of entries) {
    if (MANAGED_BOOTSTRAP_RECOVERY_RECORD_PATTERN.test(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`managed bootstrap recovery 记录不是安全普通文件：${path.join(namespace, entry.name)}`);
      }
      const recordPath = path.join(namespace, entry.name);
      const record = await readBootstrapRecoveryRecord(recordPath, parentRoot, namespace);
      if (!record) throw new Error(`managed bootstrap recovery 记录枚举后消失：${recordPath}`);
      records.push({ recordPath, record });
      continue;
    }
    if (/^case-[a-f0-9]{32}$/u.test(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`managed bootstrap quarantine case 不是安全目录：${path.join(namespace, entry.name)}`);
      }
      continue;
    }
    if (/^recovery-[a-f0-9]{64}\.json\.\d+\.[A-Za-z0-9-]+\.tmp$/u.test(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`managed bootstrap recovery 临时记录类型异常：${path.join(namespace, entry.name)}`);
      }
      continue;
    }
    throw new Error(`managed bootstrap recovery namespace 含未知内容，已停止该 owner 恢复：${path.join(namespace, entry.name)}`);
  }
  return records;
}

/**
 * 普通候选路径可能在 replacement root/claim 已建立、recovery journal 尚未更新时
 * 接管并完成 bootstrap。完成工程一旦成为当前事实，必须把同路径 pending attempt
 * 终结为 reconciled；否则以后原路径缺失时会被陈旧 journal 错当成可恢复现场。
 */
export async function reconcileManagedProjectBootstrapRecovery(
  projectRootValue: string,
): Promise<{ reconciled: boolean; recordPath: string | null }> {
  const projectRoot = await assertRealDirectoryWithoutSymlink(projectRootValue, "待对账 managed bootstrap 根");
  const [shell, claim] = await Promise.all([
    inspectManagedProjectReadOnly(projectRoot),
    readManagedProjectBootstrapClaim(projectRoot),
  ]);
  if (!claim) return { reconciled: false, recordPath: null };
  if (claim.workspaceMode !== shell.workspaceMode
    || claim.minimumWriterSchemaVersion !== minimumWriterSchemaVersionForWorkspace(shell.workspaceMode)) {
    throw new Error("managed bootstrap claim 与已完成工程的工作区身份不一致。 ");
  }
  const parentRoot = await assertRealDirectoryWithoutSymlink(path.dirname(projectRoot), "managed bootstrap 父目录");
  const quarantine = await getManagedBootstrapQuarantineDirectory(parentRoot, false);
  if (!quarantine) return { reconciled: false, recordPath: null };
  const namespace = await getManagedBootstrapRecoveryNamespace(
    quarantine,
    claim.purpose,
    claim.payload,
    claim.workspaceMode,
    false,
  );
  if (!namespace) return { reconciled: false, recordPath: null };
  const recordPath = bootstrapRecoveryRecordPath(namespace, projectRoot);
  const record = await readBootstrapRecoveryRecord(recordPath, parentRoot, namespace);
  if (!record) return { reconciled: false, recordPath: null };
  if (record.originalProjectRoot !== projectRoot
    || record.workspaceMode !== claim.workspaceMode
    || record.minimumWriterSchemaVersion !== claim.minimumWriterSchemaVersion
    || record.bootstrapPurpose !== claim.purpose
    || !sameStableJson(record.bootstrapPayload, claim.payload)) {
    throw new Error(`managed bootstrap recovery 与当前完成工程身份不一致：${recordPath}`);
  }
  const attempt = record.attempts.at(-1)!;
  if (attempt.completedAt) {
    if (attempt.rebuiltProjectId !== shell.project.id) {
      throw new Error(`managed bootstrap recovery 完成记录与当前工程 ID 不一致：${recordPath}`);
    }
    return { reconciled: false, recordPath };
  }
  if (attempt.reconciledAt) {
    if (attempt.reconciledProjectId !== shell.project.id
      || attempt.reconciledClaimFingerprint !== claim.fingerprint) {
      throw new Error(`managed bootstrap recovery 对账记录与当前工程身份不一致：${recordPath}`);
    }
    return { reconciled: false, recordPath };
  }
  if (attempt.replacementClaimFingerprint !== undefined
    && attempt.replacementClaimFingerprint !== claim.fingerprint) {
    throw new Error(`managed bootstrap recovery replacement claim 与当前工程 claim 不一致：${recordPath}`);
  }
  await updateBootstrapRecoveryAttempt(
    recordPath,
    parentRoot,
    namespace,
    attempt.recoveryId,
    (current) => ({
      ...current,
      reconciledProjectId: shell.project.id,
      reconciledClaimFingerprint: claim.fingerprint,
      reconciledAt: new Date().toISOString(),
    }),
  );
  return { reconciled: true, recordPath };
}

/**
 * 当 SIGKILL 恰好发生在“旧半成品已原子隔离、原路径尚未重建”窗口时，
 * 由父目录内持久恢复记录继续同一原路径；不会扫描或接管普通候选目录。
 */
export async function resumeManagedProjectBootstrapFromQuarantine(
  parentRootValue: string,
  options: Pick<CreateManagedProjectOptions, "name" | "workspaceMode" | "bootstrapClaim"> & { slug: string },
): Promise<ProjectShell | null> {
  if (!options.bootstrapClaim) throw new Error("恢复 managed bootstrap 必须提供 bootstrapClaim。 ");
  const workspaceMode = requireBootstrapRecoveryCompatibleWorkspaceMode(options);
  const parentRoot = await assertRealDirectoryWithoutSymlink(parentRootValue, "managed bootstrap 父目录");
  const slug = managedProjectSlug(options.slug);
  const expectedPurpose = normalizeBootstrapPurpose(options.bootstrapClaim.purpose);
  const matching: Array<{
    parentRoot: string;
    quarantine: string;
    namespace: string;
    recordPath: string;
    record: ManagedProjectBootstrapRecoveryRecord;
    attempt: ManagedProjectBootstrapRecoveryAttempt;
  }> = [];
  const quarantine = await getManagedBootstrapQuarantineDirectory(parentRoot, false);
  if (!quarantine) return null;
  const namespace = await getManagedBootstrapRecoveryNamespace(
    quarantine,
    expectedPurpose,
    options.bootstrapClaim.payload,
    workspaceMode,
    false,
  );
  if (!namespace) return null;
  for (const entry of await listBootstrapRecoveryRecordsForOwner(
    parentRoot,
    expectedPurpose,
    options.bootstrapClaim.payload,
    workspaceMode,
  )) {
    if (!managedBootstrapCandidateRootName(path.basename(entry.record.originalProjectRoot), slug)) continue;
    if (entry.record.workspaceMode !== workspaceMode
      || entry.record.minimumWriterSchemaVersion !== minimumWriterSchemaVersionForWorkspace(workspaceMode)
      || entry.record.bootstrapPurpose !== expectedPurpose
      || !sameStableJson(entry.record.bootstrapPayload, options.bootstrapClaim.payload)) {
      throw new Error(`同一 project slug 的 quarantine claim 与恢复请求不一致：${entry.recordPath}`);
    }
    const originalExists = await lstat(entry.record.originalProjectRoot).then(() => true).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    if (originalExists) continue;
    const attempt = entry.record.attempts.at(-1)!;
    if (attempt.replacementClaimFingerprint || attempt.completedAt || attempt.reconciledAt) {
      throw new Error(`managed bootstrap recovery 记录显示原路径已重建，但路径现已消失，拒绝猜测：${entry.recordPath}`);
    }
    matching.push({
      parentRoot,
      quarantine,
      namespace,
      recordPath: entry.recordPath,
      record: entry.record,
      attempt,
    });
  }
  if (matching.length > 1) {
    throw new Error(`同一 project slug 存在多个待恢复 quarantine，禁止猜测：${matching.map((entry) => entry.recordPath).join(", ")}`);
  }
  if (matching.length === 0) return null;
  return rebuildManagedBootstrapFromQuarantine(matching[0]!, options);
}

/**
 * 仅恢复 createManagedProject 在 root/claim/sidecar/DB/manifest 之间崩溃留下的专用根。
 * 无 claim 时只接受真正空根或唯一的原子 claim 临时文件；不会接管其他目录内容。
 */
export async function resumeManagedProjectBootstrap(
  projectRootValue: string,
  options: Pick<CreateManagedProjectOptions, "name" | "workspaceMode" | "bootstrapClaim">,
): Promise<ProjectShell> {
  if (!options.bootstrapClaim) throw new Error("恢复 managed bootstrap 必须提供 bootstrapClaim。 ");
  const workspaceMode = requireBootstrapRecoveryCompatibleWorkspaceMode(options);
  const projectRoot = await assertRealDirectoryWithoutSymlink(projectRootValue, "待恢复 managed bootstrap 根");
  const name = normalizeProjectName(options.name);
  let claim = await readManagedProjectBootstrapClaim(projectRoot);
  if (!claim) {
    await assertRecoverableUnclaimedBootstrapRoot(projectRoot);
    claim = await writeManagedBootstrapClaim(projectRoot, options.bootstrapClaim, workspaceMode);
  } else if (claim.workspaceMode !== workspaceMode
    || claim.minimumWriterSchemaVersion !== minimumWriterSchemaVersionForWorkspace(workspaceMode)
    || claim.purpose !== normalizeBootstrapPurpose(options.bootstrapClaim.purpose)
    || JSON.stringify(stableValue(claim.payload)) !== JSON.stringify(stableValue(options.bootstrapClaim.payload))) {
    throw new Error(`managed bootstrap claim 与恢复请求不一致：${projectRoot}`);
  }
  const existing = await inspectManagedProjectReadOnly(projectRoot).catch(() => null);
  if (existing) {
    if (existing.project.name !== name || existing.workspaceMode !== workspaceMode) {
      throw new Error(`managed bootstrap 已完成工程名称与恢复请求不一致：${projectRoot}`);
    }
    return existing;
  }

  let claimOnly = false;
  try {
    await assertRecoverableClaimOnlyBootstrapRoot(projectRoot, claim);
    claimOnly = true;
  } catch {
    claimOnly = false;
  }
  if (claimOnly) {
    return materializeManagedProjectRoot(projectRoot, name, claim.createdAt, workspaceMode);
  }

  const recovery = await prepareClaimedBootstrapQuarantine(projectRoot, claim).catch((qualificationError) => {
    const detail = qualificationError instanceof Error ? qualificationError.message : String(qualificationError);
    throw new Error(
      `已有 claim 的 managed bootstrap 不是可证明安全的 bootstrap 半成品：${projectRoot}；${detail}`,
      { cause: qualificationError },
    );
  });
  maybeInterruptManagedBootstrapForTests("after-quarantine-rename");
  return rebuildManagedBootstrapFromQuarantine(recovery, options);
}

function countArtifacts(index: ProjectIndex): ProjectShell["counts"] {
  const extensions = index.artifacts.map((artifact) => path.extname(artifact.path).toLowerCase());
  return {
    total: index.summary.total,
    items: index.items.length,
    artifacts: index.artifacts.length,
    images: extensions.filter((extension) => [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"].includes(extension)).length,
    videos: extensions.filter((extension) => [".mp4", ".mov", ".m4v", ".webm", ".mkv"].includes(extension)).length,
    audio: extensions.filter((extension) => [".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"].includes(extension)).length,
  };
}

export async function createManagedProject(options: CreateManagedProjectOptions): Promise<ProjectShell> {
  const workspaceMode = requireBootstrapRecoveryCompatibleWorkspaceMode(options);
  const parentRoot = await assertRealDirectoryWithoutSymlink(options.parentRoot, "受管项目父目录");
  const name = normalizeProjectName(options.name);
  const slug = managedProjectSlug(options.slug?.trim() || name);
  const allocated = await allocateProjectRoot(parentRoot, slug);

  try {
    const claim = options.bootstrapClaim
      ? await writeManagedBootstrapClaim(allocated.root, options.bootstrapClaim, workspaceMode)
      : null;
    return await materializeManagedProjectRoot(
      allocated.root,
      name,
      claim?.createdAt ?? new Date().toISOString(),
      workspaceMode,
    );
  } catch (error) {
    await rollbackCreatedRoot(allocated.root, allocated.identity);
    throw error;
  }
}

/**
 * 只接管已经由本应用建立、且仍然完全为空的隔离工程。不会删除、迁移或扫描
 * 任何旧素材；一旦索引含有单元/产物或配置引用外部根就失败关闭。
 */
export async function upgradeEmptyProjectToManaged(projectRoot: string): Promise<ProjectShell> {
  const canonicalRoot = await assertRealDirectoryWithoutSymlink(projectRoot, "待升级项目根目录");
  const paths = managedPaths(canonicalRoot);
  const existingManifest = await lstat(paths.manifest).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existingManifest) {
    // 先做无写校验；future/v2 非 drama 不能先创建项目锁或补任何账本。
    const current = await inspectManagedProjectReadOnly(canonicalRoot);
    if (current.workspaceMode !== "drama") {
      throw new Error("novel/hybrid 工程不得进入旧空工程升级写路径。 ");
    }
    return inspectManagedProject(canonicalRoot);
  }

  return withProjectLock(canonicalRoot, "managed-project-upgrade", async () => {
    const racedManifest = await lstat(paths.manifest).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (racedManifest) {
      const current = await inspectManagedProjectReadOnly(canonicalRoot);
      if (current.workspaceMode !== "drama") {
        throw new Error("novel/hybrid 工程不得进入旧空工程升级写路径。 ");
      }
      return inspectManagedProject(canonicalRoot);
    }

    const [configContent, indexContent] = await Promise.all([readFile(paths.config), readFile(paths.index)]).catch((error: unknown) => {
      throw new Error(`待升级工程缺少必要侧车文件：${canonicalRoot}`, { cause: error });
    });
    const project = validateProjectConfig(parseJsonObject(configContent, paths.config), paths.config);
    const index = validateIndex(parseJsonObject(indexContent, paths.index), paths.index);
    if (path.resolve(project.primaryRoot) !== canonicalRoot
      || project.sourceRoots.length !== 0
      || project.outputRoots.length !== 1
      || path.resolve(project.outputRoots[0] ?? "") !== canonicalRoot) {
      throw new Error("只有 sourceRoots 为空且 outputRoots 仅指向自身的隔离工程可以升级为受管项目。");
    }
    if (index.project.id !== project.id || index.items.length !== 0 || index.artifacts.length !== 0 || index.summary.total !== 0) {
      throw new Error("只有尚未导入任何单元或产物的空工程可以原地升级；现有内容不会被接管或覆盖。");
    }
    await materializeManagedStorage(paths);
    await writeManagedManifest(paths, project, index, project.createdAt || new Date().toISOString(), "drama");
    return inspectManagedProject(canonicalRoot);
  });
}

export async function isManagedProject(projectRoot: string): Promise<boolean> {
  const manifestPath = managedPaths(path.resolve(projectRoot)).manifest;
  try {
    const metadata = await lstat(manifestPath);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function inspectManagedProjectShell(projectRoot: string): Promise<ProjectShell> {
  recordManagedProjectShellInspection();
  const canonicalRoot = await assertRealDirectoryWithoutSymlink(projectRoot, "受管项目根目录");
  const paths = managedPaths(canonicalRoot);
  const [configContent, indexContent, manifestContent] = await Promise.all([
    readFile(paths.config),
    readFile(paths.index),
    readFile(paths.manifest),
  ]).catch((error: unknown) => {
    throw new Error(`受管项目缺少必要侧车文件，已停止打开：${canonicalRoot}`, { cause: error });
  });

  const project = validateProjectConfig(parseJsonObject(configContent, paths.config), paths.config);
  const index = validateIndex(parseJsonObject(indexContent, paths.index), paths.index);
  const manifest = validateManifest(parseJsonObject(manifestContent, paths.manifest), paths.manifest);
  const { fingerprint, ...manifestPayload } = manifest;
  const workspaceMode: WorkspaceMode = manifest.schemaVersion === 1 ? "drama" : manifest.workspaceMode;
  const effectivePaths = managedPaths(canonicalRoot, workspaceMode);

  if (manifest.schemaVersion === 1) {
    if (project.schemaVersion !== 1) throw new Error("schema v1 受管项目必须使用 schema v1 项目配置。");
  } else if (project.schemaVersion !== 2
    || project.workspaceMode !== manifest.workspaceMode
    || project.minimumWriterSchemaVersion !== manifest.minimumWriterSchemaVersion) {
    throw new Error("schema v2 受管项目的项目配置与 manifest writer 声明不一致。");
  }

  if (manifestFingerprint(manifestPayload) !== fingerprint) throw new Error("受管项目 manifest fingerprint 不匹配，已停止打开。");
  if (sha256(configContent) !== manifest.projectConfigSha256) throw new Error("受管项目配置 SHA-256 不匹配，已停止打开。");
  if (index.scanId === manifest.bootstrapScanId && sha256(indexContent) !== manifest.bootstrapIndexSha256) {
    throw new Error("受管项目 bootstrap 索引 SHA-256 不匹配，已停止打开。");
  }
  if (manifest.rootRealpath !== canonicalRoot || path.resolve(project.primaryRoot) !== canonicalRoot) throw new Error("受管项目根 realpath 与配置或 manifest 不一致。");
  if (manifest.projectId !== project.id || manifest.projectName !== project.name) throw new Error("受管项目身份与 manifest 不一致。");
  if (project.sourceRoots.length !== 0) throw new Error("受管项目禁止配置外部 sourceRoots。");
  if (project.outputRoots.length !== 1 || path.resolve(project.outputRoots[0] ?? "") !== canonicalRoot) {
    throw new Error("受管项目 outputRoots 必须且只能指向项目根。");
  }
  const indexedProject = validateProjectConfig(index.project as unknown as Record<string, unknown>, paths.index);
  if (indexedProject.id !== project.id
    || indexedProject.schemaVersion !== project.schemaVersion
    || indexedProject.workspaceMode !== project.workspaceMode
    || indexedProject.minimumWriterSchemaVersion !== project.minimumWriterSchemaVersion
    || path.resolve(indexedProject.primaryRoot) !== canonicalRoot
    || indexedProject.sourceRoots.length !== 0
    || indexedProject.outputRoots.length !== 1
    || path.resolve(indexedProject.outputRoots[0] ?? "") !== canonicalRoot) {
    throw new Error("受管项目索引中的项目隔离契约已漂移。");
  }
  const storageChecks: Array<Promise<void>> = [
    assertManagedFile(effectivePaths.cache, canonicalRoot, "项目缓存数据库"),
    assertManagedDirectory(paths.mediaCas, canonicalRoot, "项目本地 CAS 目录"),
    assertManagedDirectory(paths.mediaPreviews, canonicalRoot, "项目预览目录"),
    assertManagedDirectory(paths.mediaProxies, canonicalRoot, "项目代理媒体目录"),
    assertManagedDirectory(paths.mediaWaveforms, canonicalRoot, "项目音频波形目录"),
    assertManagedFile(paths.materialDatabase, canonicalRoot, "素材库数据库"),
  ];
  if (manifest.relativePaths.productionDatabase && manifest.relativePaths.textCas) {
    storageChecks.push(
      assertManagedDirectory(paths.textCas, canonicalRoot, "项目文本 CAS 目录"),
      assertManagedFile(paths.productionDatabase, canonicalRoot, "生产知识库数据库"),
    );
  }
  await Promise.all(storageChecks);

  if (manifest.schemaVersion === 2) {
    await inspectLegacyProjectCacheWriterFence(canonicalRoot, manifest.projectId);
    const fence = await inspectManagedProjectWriterFence(canonicalRoot);
    if (fence.projectId !== manifest.projectId) {
      throw new Error("受管项目 writer fence 与 manifest 项目身份不一致。");
    }
  }

  return {
    project,
    workspaceMode,
    counts: countArtifacts(index),
    nextAction: index.items.find((item) => !["已完成", "弃用"].includes(item.status))?.nextAction || MANAGED_NEXT_ACTION,
    manifestFingerprint: manifest.fingerprint,
    manifest: {
      schemaVersion: manifest.schemaVersion,
      workspaceMode,
      storageMode: manifest.storageMode,
      startupPolicy: manifest.startupPolicy,
      mediaMode: manifest.mediaMode,
      legacyRoots: manifest.legacyRoots,
      fingerprint: manifest.fingerprint,
      ...(manifest.schemaVersion === 2
        ? {
          minimumWriterSchemaVersion: manifest.minimumWriterSchemaVersion,
          ...(manifest.novelManifest ? { novelManifest: manifest.novelManifest } : {}),
        }
        : {}),
    },
    paths: effectivePaths,
  };
}

/**
 * 纯只读受管工程身份检查：不初始化 generation ledger，也不补目录、表或 marker。
 * 供轮询/控制面在缺失或损坏状态下保持零修复副作用。
 */
export async function inspectManagedProjectReadOnly(projectRoot: string): Promise<ProjectShell> {
  return inspectManagedProjectShell(projectRoot);
}

/**
 * managed-project owner 绑定小说 workspace manifest 的唯一写入口。NovelRepository
 * 必须先把已签名 manifest 落到固定 locator；本函数只使用 managed
 * fingerprint CAS 补上引用，不创建或改写小说 manifest。
 */
export async function attachNovelManifest(
  projectRootValue: string,
  input: AttachNovelManifestInput,
): Promise<ProjectShell> {
  const expectedManagedFingerprint = input?.expectedManagedFingerprint;
  if (typeof expectedManagedFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(expectedManagedFingerprint)) {
    throw new Error("attachNovelManifest.expectedManagedFingerprint 必须是 64 位 SHA-256。 ");
  }
  const initial = await inspectManagedProjectReadOnly(projectRootValue);
  if (initial.workspaceMode === "drama" || initial.manifest.schemaVersion !== 2) {
    throw new Error("drama/schema v1 受管项目不能绑定 novel workspace manifest。 ");
  }
  if (initial.manifestFingerprint !== expectedManagedFingerprint) {
    throw new Error("managed project manifest fingerprint CAS 失败，拒绝绑定 novel manifest。 ");
  }

  return withProjectLock(initial.paths.root, "novel-manifest-attach", async () => {
    const shell = await inspectManagedProjectReadOnly(initial.paths.root);
    if (shell.workspaceMode === "drama" || shell.manifest.schemaVersion !== 2) {
      throw new Error("drama/schema v1 受管项目不能绑定 novel workspace manifest。 ");
    }
    if (shell.manifestFingerprint !== expectedManagedFingerprint) {
      throw new Error("managed project manifest fingerprint CAS 失败，拒绝绑定 novel manifest。 ");
    }

    const managedManifestDirectory = await inspectExistingConfinedDirectory(
      shell.paths.root,
      path.dirname(shell.paths.manifest),
    );
    const managedManifestRead = await readConfinedRegularFileWithIdentity(
      managedManifestDirectory,
      path.basename(shell.paths.manifest),
      256 * 1024,
    );
    if (managedManifestRead.nlink !== 1) throw new Error("受管项目 manifest 必须是单链接普通文件。 ");
    const managedManifestBytes = managedManifestRead.bytes;
    const managedManifest = validateManifest(
      parseJsonObject(managedManifestBytes, shell.paths.manifest),
      shell.paths.manifest,
    );
    if (managedManifest.schemaVersion !== 2
      || managedManifest.fingerprint !== expectedManagedFingerprint
      || managedManifest.workspaceMode !== shell.workspaceMode) {
      throw new Error("managed project manifest 在 novel manifest 绑定前发生身份漂移。 ");
    }

    const novelManifest = await readNovelWorkspaceManifestForAttachment(shell.paths.root);
    if (novelManifest.projectId !== shell.project.id) {
      throw new Error("novel workspace manifest projectId 与受管项目不一致。 ");
    }
    if (managedManifest.novelManifest === NOVEL_MANIFEST_RELATIVE_PATH) return shell;

    const { fingerprint: _fingerprint, ...currentPayload } = managedManifest;
    const updatedPayload: Omit<ManagedProjectManifestV2, "fingerprint"> = {
      ...currentPayload,
      novelManifest: NOVEL_MANIFEST_RELATIVE_PATH,
    };
    const updatedManifest = {
      ...updatedPayload,
      fingerprint: manifestFingerprint(updatedPayload),
    } satisfies ManagedProjectManifestV2;
    const updatedManifestBytes = Buffer.from(`${JSON.stringify(updatedManifest, null, 2)}\n`, "utf8");
    await attachNovelManifestTestHooks.beforeManagedManifestReplace?.({
      projectRoot: shell.paths.root,
      manifestPath: shell.paths.manifest,
    });
    await replaceConfinedBytesCas(
      managedManifestRead.identity,
      sha256(managedManifestBytes),
      managedManifestBytes.byteLength,
      updatedManifestBytes,
      0o600,
    );

    const attached = await inspectManagedProjectReadOnly(shell.paths.root);
    if (attached.manifest.novelManifest !== NOVEL_MANIFEST_RELATIVE_PATH
      || attached.manifestFingerprint === expectedManagedFingerprint) {
      throw new Error("novel workspace manifest 绑定后复验失败。 ");
    }
    return attached;
  });
}

async function ensureManagedGenerationLedger(shell: ProjectShell): Promise<void> {
  const projectRoot = shell.paths.root;
  if (generationLedgerInitializationContext.getStore()?.has(projectRoot)) return;
  recordStudioUnitsReadCounter("generationLedgerEnsureCalls");

  let pending = generationLedgerInitializations.get(projectRoot);
  if (!pending) {
    recordStudioUnitsReadCounter("generationLedgerInitializationStarts");
    const roots = new Set(generationLedgerInitializationContext.getStore() ?? []);
    roots.add(projectRoot);
    pending = generationLedgerInitializationContext.run(roots, async () => {
      const generationObjects = path.dirname(shell.paths.generationPackCas);
      const generationRoot = path.dirname(generationObjects);
      const generationTemporary = path.join(generationObjects, ".tmp");
      await Promise.all([
        assertOptionalManagedPath(shell.paths.generationDatabase, projectRoot, "Studio generation 账本数据库", "file"),
        assertOptionalManagedPath(generationRoot, projectRoot, "Studio generation 账本目录", "directory"),
        assertOptionalManagedPath(generationObjects, projectRoot, "Studio generation 对象目录", "directory"),
        assertOptionalManagedPath(shell.paths.generationPackCas, projectRoot, "Studio generation pack CAS", "directory"),
        assertOptionalManagedPath(generationTemporary, projectRoot, "Studio generation 临时目录", "directory"),
      ]);
      // 延迟加载可避免 generation ledger 反向验证 managed project 时形成模块初始化环。
      // 直指 storage 定义处（而非经 studio-generation-ledger 的再导出），
      // 避免巨型模块图在循环求值序下再导出绑定读成 undefined。
      const { initializeStudioGenerationLedger } = await import("./studio-generation-ledger-storage.js");
      const state = await initializeStudioGenerationLedger(projectRoot);
      if (path.resolve(state.databasePath) !== shell.paths.generationDatabase
        || path.resolve(state.packCasRoot) !== shell.paths.generationPackCas) {
        throw new Error("Studio generation 账本路径越出受管项目约定。 ");
      }
      await Promise.all([
        assertManagedFile(shell.paths.generationDatabase, projectRoot, "Studio generation 账本数据库"),
        assertManagedDirectory(generationRoot, projectRoot, "Studio generation 账本目录"),
        assertManagedDirectory(generationObjects, projectRoot, "Studio generation 对象目录"),
        assertManagedDirectory(shell.paths.generationPackCas, projectRoot, "Studio generation pack CAS"),
        assertManagedDirectory(generationTemporary, projectRoot, "Studio generation 临时目录"),
      ]);
    });
    generationLedgerInitializations.set(projectRoot, pending);
  } else {
    recordStudioUnitsReadCounter("generationLedgerInitializationJoins");
  }
  try {
    await pending;
  } finally {
    if (generationLedgerInitializations.get(projectRoot) === pending) {
      generationLedgerInitializations.delete(projectRoot);
    }
  }
}

/**
 * 打开受管项目时只校验固定侧车并幂等初始化本地 generation 账本；不会扫描媒体或旧根。
 */
export async function inspectManagedProject(projectRoot: string): Promise<ProjectShell> {
  const shell = await measureStudioUnitsReadPhase(
    "managed-inspect-shell",
    () => inspectManagedProjectShell(projectRoot),
  );
  await measureStudioUnitsReadPhase(
    "managed-generation-ledger",
    () => ensureManagedGenerationLedger(shell),
  );
  return shell;
}
