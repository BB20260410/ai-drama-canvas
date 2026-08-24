/**
 * 《嘟嘟》S1E1 只读来源 → 隔离 managed Studio 的 staging-first 适配器。
 *
 * 真相仍由既有 managed-project、Material Studio/CAS、production、continuity 与
 * generation ledger owner 持有。本文件只做可恢复编排和不可变导入收据；在完整
 * 验证前绝不登记或激活项目，也不回写外部锁版源/生产根。
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, opendir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  evaluateStudioAssetApplicability,
  getMaterialStudioState,
  getStudioCanonicalAsset,
  getStudioCanonicalAssetKnowledgeSnapshot,
  getStudioMedia,
  importStudioMedia,
  listStudioMediaImportOrigins,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
  verifyStudioMediaObject,
  type StudioCanonicalAssetDetail,
  type StudioMediaMetadata,
} from "./material-studio.js";
import {
  createManagedProject,
  inspectManagedProject,
  inspectManagedProjectReadOnly,
  readManagedProjectBootstrapClaim,
  resumeManagedProjectBootstrap,
  type ManagedProjectBootstrapClaim,
  type ProjectShell,
} from "./managed-project.js";
import {
  activateProject,
  ensureManagedProjectCreatedEvent,
} from "./service.js";
import {
  getActiveProjectState,
  getActiveProjectStateReadOnly,
  listRegisteredProjects,
  registerProjectGuarded,
} from "./sidecar.js";
import {
  analyzeStudioPanelAssetMentions,
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  createStudioProductionContractProfile,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  confirmStudioPanelEntityClosureEmpty,
  freezeStudioPanelAssetBindingSet,
  getStudioAssetBindingSet,
  getCurrentStudioPanelAssetBindingSet,
  getStudioProductionContractProfile,
  getStudioProductionState,
  getStudioProductionUnitSnapshot,
  getStudioTextDocument,
  getStudioTextRevision,
  listStudioProductionUnits,
  listStudioTextRevisions,
  recordStudioMentionDecision,
  type StudioAssetBindingSourceSnapshot,
  type StudioProductionPanelInput,
  type StudioTextRevision,
} from "./studio-production.js";
import {
  STUDIO_CONTINUITY_FIELDS,
  createStudioContinuityReadiness,
  type StudioContinuityField,
} from "./studio-continuity.js";
import { appendStudioContinuityObservations, queryStudioContinuityTimelines } from "./studio-continuity-ledger.js";
import {
  freezeAndPersistStudioUnitGridGenerationPack,
  getStudioGenerationLedgerState,
  importStudioHistoricalGenerationEvidence,
  listStudioDetachedGenerationUnknownObservations,
  registerStudioVerifiedHistoricalImportContinuationWaiver,
  readStudioUnitGridGenerationFrozenPack,
  readStudioHistoricalGenerationEvidenceByPack,
  recordStudioDetachedGenerationUnknownObservation,
  type StudioDetachedGenerationUnknownObservation,
} from "./studio-generation-ledger.js";
import { queryStudioUnitGridGenerationFreeze } from "./studio-unit-grid-generation.js";
import { withFileLock, withProjectLock } from "./locks.js";
import { openSqliteReadOnlySnapshot, type SqliteReadOnlySnapshot } from "./sqlite-readonly-snapshot.js";
import {
  assertDuduPromptTextPathFree,
  duduFindSemanticTokenRange,
  duduForbiddenRelationAnchorRanges,
  duduReferencePresenceForPanel,
  duduReferenceSemanticTokens,
  duduTextIncludesSemanticToken,
  inspectDuduReadonlySources,
  readDuduCurrentMachineProjection,
  type DuduParsedPanel,
  type DuduCurrentMachineProjection,
  type DuduReadonlySourceInput,
  type DuduReadonlySourceInspection,
  type DuduReadonlyUnitSource,
  type DuduReferenceAsset,
  type DuduSourceFileIdentity,
} from "./dudu-readonly-source.js";

const INTENT_RELATIVE_PATH = ".aicanvas/dudu-readonly-import-intent.json";
const RECEIPT_RELATIVE_PATH = ".aicanvas/dudu-readonly-import.json";
const REGISTRATION_RELATIVE_PATH = ".aicanvas/dudu-readonly-registration.json";
const ACTIVATION_RECEIPT_RELATIVE_ROOT = ".aicanvas/dudu-readonly-activations";
const COMMAND_OPERATION_RECEIPT_RELATIVE_ROOT = ".aicanvas/dudu-readonly-command-operations";
const PROJECT_NAME = "《嘟嘟》S1E1 隔离受管工程";
const PROJECT_SLUG = "dudu-s1e1";
const BOOTSTRAP_PURPOSE = "dudu-readonly-import";
const DUDU_SOURCE_IDENTITY_VERIFY_CONCURRENCY = 4;

async function duduReadonlyContinuationWaiver(
  projectRoot: string,
  unit: Pick<DuduReadonlyUnitSource, "unitId" | "sequence">,
  sourceManifestFingerprint: string,
  mode: "initial-import" | "incremental-reconcile" = "initial-import",
) {
  if (unit.sequence <= 1) return undefined;
  const snapshot = await getStudioProductionUnitSnapshot(projectRoot, unit.unitId);
  if (!snapshot) throw new Error(`只读历史豁免目标单元不存在：${unit.unitId}`);
  const receipt = await registerStudioVerifiedHistoricalImportContinuationWaiver(projectRoot, {
    unitId: unit.unitId,
    expectedUnitRevision: snapshot.unit.revision,
    sourceManifestFingerprint,
    authorizationEvidenceReference: `dudu-readonly-${mode}:${sourceManifestFingerprint}:${unit.unitId}`,
    mode,
  });
  return {
    receiptId: receipt.receiptId,
    receiptFingerprint: receipt.fingerprint,
  };
}
/**
 * 初始只读导入完成后才在外部锁版工程中验收通过的单元。它们只能由下方的
 * 受管增量回填入口接收；U30 及以后仍必须走正式生图/Review 链，不能借此转正。
 */
const INCREMENTAL_HISTORICAL_PASS_UNIT_IDS = new Set(["S1E01-U28", "S1E01-U29"]);
const MAX_DUDU_DISCOVERY_DIRECTORIES = 256;

export interface DuduDetachedUnknownImportInput {
  unitId: string;
  sourceTaskId: string;
  evidenceReference: string;
  evidenceFingerprint: string;
  candidateSha256?: string;
  candidateSizeBytes?: number;
  candidateWidth?: number;
  candidateHeight?: number;
  note?: string;
}

export interface DuduDetachedUnknownContract {
  unitId: string;
  sourceTaskId: string;
  evidenceReference: string;
  evidenceFingerprint: string;
  candidateSha256: string | null;
  candidateSizeBytes: number | null;
  candidateWidth: number | null;
  candidateHeight: number | null;
  note: string;
}

export interface StageDuduReadonlyManagedProjectInput {
  projectsRoot: string;
  source: DuduReadonlySourceInput;
  detachedUnknownObservations?: DuduDetachedUnknownImportInput[];
}

export interface DuduReadonlyCommandExecutionOptions {
  /** command-bus requestHash；仅用于把崩溃恢复证明绑定到精确 CAS 请求。 */
  commandRequestHash?: string;
  /** stage 命令在 owner 锁内必须重验的发现集指纹，关闭预检到动手间的 TOCTOU。 */
  expectedDiscoveryFingerprint?: string;
}

export class DuduReadonlyControlConflictError extends Error {
  readonly expectedFingerprint?: string;
  readonly currentFingerprint?: string;

  constructor(message: string, input: { expectedFingerprint?: string; currentFingerprint?: string } = {}) {
    super(message);
    this.name = "DuduReadonlyControlConflictError";
    this.expectedFingerprint = input.expectedFingerprint;
    this.currentFingerprint = input.currentFingerprint;
  }
}

export interface DuduReadonlyCommandOperationReceipt {
  schemaVersion: 1;
  kind: "dudu-readonly-command-operation-receipt";
  command: "stage_dudu_readonly_managed_project" | "finalize_dudu_readonly_managed_project";
  commandRequestHash: string;
  projectId: string;
  projectRoot: string;
  importFingerprint: string;
  registrationFingerprint: string | null;
  activationId: string | null;
  activationFingerprint: string | null;
  createdAt: string;
  fingerprint: string;
}

export interface DuduReadonlyStageCommandOutcome {
  schemaVersion: 1;
  kind: "dudu-readonly-stage-command-outcome";
  directoryName: string;
  projectId: string;
  managedManifestFingerprint: string;
  importFingerprint: string;
  sourceManifestFingerprint: string;
  productionScopeFingerprint: string;
  contractSha256: string;
  counts: DuduReadonlyImportReceipt["counts"];
  replayed: boolean;
}

export interface DuduReadonlyImportIntent {
  schemaVersion: 3;
  kind: "dudu-readonly-import-intent";
  projectId: string;
  projectRoot: string;
  sourceProductionRoot: string;
  sourceLockedScriptPath: string;
  managedManifestFingerprint: string;
  sourceManifestFingerprint: string;
  productionScopeFingerprint: string;
  contractSha256: string;
  lockedScriptSha256: string;
  bootstrapClaimFingerprint: string;
  detachedUnknownObservations: DuduDetachedUnknownContract[];
  fingerprint: string;
  createdAt: string;
}

export interface DuduReadonlyImportUnitReceipt {
  unitId: string;
  sequence: number;
  durationSeconds: number;
  episodeStartSeconds: number;
  episodeEndSeconds: number;
  panelCount: number;
  bindingFormat: "legacy" | "v2" | null;
  bindingSha256: string | null;
  referenceAssetIds: string[];
  packId: string | null;
  packFingerprint: string | null;
  historicalImportId: string | null;
  historicalManifestSha256: string | null;
  videoPackStatus: string;
  i2vReadiness: string | null;
  machinePreparationStatus: string;
  machineStoryboardStatus: string;
  machineToolInvocationCount: number;
  machineVisualCandidateCount: number;
  historicalApprovedRawRelativePath: string | null;
  historicalApprovedRawSha256: string | null;
}

export interface DuduReadonlyImportReceipt {
  schemaVersion: 3;
  kind: "dudu-readonly-managed-import";
  projectId: string;
  projectRoot: string;
  projectName: string;
  managedManifestFingerprint: string;
  sourceProductionRoot: string;
  sourceLockedScriptPath: string;
  sourceManifestFingerprint: string;
  productionScopeFingerprint: string;
  contractSha256: string;
  lockedScriptSha256: string;
  bootstrapClaimFingerprint: string;
  importIntentFingerprint: string;
  detachedUnknownContractFingerprint: string;
  visualCanonRevisionSha256: string;
  visualExecutionSha256: string;
  visualConflictDecisionSha256: string;
  meteorVfxRuleSha256: string;
  sourceFiles: DuduSourceFileIdentity[];
  /** 导入时身份仍冻结，但后续受控生产允许原位演进的投影文件。 */
  mutableProjectionRelativePaths: string[];
  sourceFileCount: number;
  sourceByteCount: number;
  ownerBaselineCounts: {
    material: {
      media: number; mediaImports: number; canonicalAssets: number; characters: number; scenes: number; props: number;
      assetVersions: number; assetDefinitions: number; primaryAuthorities: number; authorityEvents: number;
      versionReviews: number; assetRelations: number;
    };
    production: {
      textDocuments: number; scriptDocuments: number; promptDocuments: number; textRevisions: number;
      units: number; panels: number; unitRevisions: number; unitTimings: number; contractProfiles: number;
      scriptSectionRevisions: number; mentionAnalyses: number; mentionProposals: number; mentionDecisions: number;
      panelEntityClosureConfirmations: number; assetBindingSets: number;
    };
  };
  assetMappings: Array<{
    assetId: string;
    sourceType: string;
    studioCategory: "character" | "scene" | "prop";
    referenceRole: string;
    sourceRelativePath: string;
    sourceSha256: string;
  }>;
  units: DuduReadonlyImportUnitReceipt[];
  conflicts: DuduReadonlySourceInspection["conflicts"];
  detachedUnknownObservationIds: string[];
  counts: {
    units: 33;
    panels: 112;
    durationSeconds: 492;
    bindingSets: number;
    unitGridPacks: 30;
    historicalImports: 28;
    videoManifests: 28;
    generationDispatches: 0;
    generationResults: 0;
    generationCallIntents: 0;
    generationCallEvents: 0;
    generationPlans: 0;
    generationRunEvents: 0;
  };
  registered: false;
  active: false;
  fingerprint: string;
  createdAt: string;
}

export interface StageDuduReadonlyManagedProjectResult {
  shell: ProjectShell;
  inspection: DuduReadonlySourceInspection;
  receipt: DuduReadonlyImportReceipt;
  replayed: boolean;
}

export interface DuduReadonlyRegistrationReceipt {
  schemaVersion: 2;
  kind: "dudu-readonly-managed-registration";
  projectId: string;
  projectRoot: string;
  importFingerprint: string;
  registered: true;
  fingerprint: string;
  createdAt: string;
}

export interface DuduReadonlyActivationReceipt {
  schemaVersion: 1;
  kind: "dudu-readonly-managed-activation";
  projectId: string;
  projectRoot: string;
  importFingerprint: string;
  registrationFingerprint: string;
  active: true;
  activationId: string;
  fingerprint: string;
  createdAt: string;
}

export interface DuduReadonlyFinalizationResult {
  schemaVersion: 1;
  kind: "dudu-readonly-managed-finalization";
  projectId: string;
  projectRoot: string;
  importFingerprint: string;
  registered: true;
  active: true;
  activationId: string;
  registration: DuduReadonlyRegistrationReceipt;
  activation: DuduReadonlyActivationReceipt;
  replayedRegistration: boolean;
  replayedActivation: boolean;
}

export interface DuduReadonlyActiveProjectIdentity {
  projectId: string;
  projectRoot: string;
  sourceProductionRoot: string;
  sourceLockedScriptPath: string;
  sourceManifestFingerprint: string;
  productionScopeFingerprint: string;
  contractSha256: string;
  lockedScriptSha256: string;
  bootstrapClaimFingerprint: string;
  importIntentFingerprint: string;
  importReceiptFingerprint: string;
  detachedUnknownContractFingerprint: string;
  registrationFingerprint: string;
  activationId: string;
  activationFingerprint: string;
  currentMachineProjectionFingerprint: string;
  /** 当前 claim→intent→receipt 重新验得的冻结来源清单；调用方不得自行扫描外部根补项。 */
  sourceFiles: DuduSourceFileIdentity[];
}

/**
 * P30 工程中心只读投影。它只暴露阶段、计数与内容指纹，不返回外部来源路径，
 * 也不执行 stage/finalize、registry 修复、数据库初始化或迁移。
 */
export interface DuduReadonlyImportControl {
  schemaVersion: 1;
  kind: "dudu-readonly-import-control";
  projectId: string;
  status:
    | "staging-incomplete"
    | "staging-verified"
    | "registration-incomplete"
    | "registered-not-active"
    | "activation-incomplete"
    | "active";
  identity: {
    managedManifestFingerprint: string;
    bootstrapClaimFingerprint: string;
    importIntentFingerprint: string | null;
    importReceiptFingerprint: string | null;
    sourceManifestFingerprint: string | null;
    productionScopeFingerprint: string | null;
    contractSha256: string | null;
    currentMachineProjectionFingerprint: string | null;
  };
  counts: {
    units: number;
    panels: number;
    durationSeconds: number;
    bindingSets: number;
    unitGridPacks: number;
    historicalImports: number;
    videoManifests: number;
    sourceFiles: number;
    sourceBytes: number;
    generationDispatches: number;
    generationResults: number;
    generationCallIntents: number;
  } | null;
  registration: { registered: boolean; receiptFingerprint: string | null };
  activation: { active: boolean; activationId: string | null; receiptFingerprint: string | null };
  blockers: string[];
  nextAction:
    | "resume-staging-via-authorized-core-orchestration"
    | "finalize-registration-and-activation-via-authorized-core-orchestration"
    | "resume-finalization-via-authorized-core-orchestration"
    | "ready";
  readOnly: true;
  fingerprint: string;
}

export interface DuduReadonlyHistoricalPassReconciliationResult {
  schemaVersion: 1;
  kind: "dudu-readonly-historical-pass-reconciliation";
  projectId: string;
  projectRoot: string;
  imported: Array<{
    unitId: "S1E01-U28" | "S1E01-U29";
    packId: string;
    packFingerprint: string;
    importId: string;
    rawSha256: string;
    labeledSha256: string;
  }>;
  sourceMachineProjectionFingerprint: string;
}

export interface DuduReadonlyImportDiscoveryCandidate {
  /** 仅 IPC/Core 使用；MCP 公共投影必须移除此字段。 */
  projectRoot: string;
  directoryName: string;
  projectId: string | null;
  bootstrapClaimFingerprint: string;
  controlStatus: DuduReadonlyImportControl["status"] | "unreadable";
  control: DuduReadonlyImportControl | null;
  fingerprint: string;
}

export interface DuduReadonlyImportDiscovery {
  schemaVersion: 1;
  kind: "dudu-readonly-import-discovery";
  /** 仅 IPC/Core 使用；MCP 公共投影必须移除此字段。 */
  projectsRoot: string;
  status: "none" | "single" | "conflict";
  candidateCount: number;
  candidates: DuduReadonlyImportDiscoveryCandidate[];
  blockers: Array<"multiple-dudu-staging-candidates" | "invalid-dudu-staging-candidate">;
  nextAction:
    | "stage-new-via-authorized-core-orchestration"
    | "inspect-single-staging"
    | "resolve-staging-conflict";
  readOnly: true;
  fingerprint: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertFingerprintRecord<T extends { fingerprint: string }>(
  record: T,
  identity: (semantic: Omit<T, "fingerprint">) => string,
  field: string,
): T {
  const { fingerprint, ...semantic } = record;
  if (identity(semantic as Omit<T, "fingerprint">) !== fingerprint) throw new Error(`${field} fingerprint 无效。`);
  return record;
}

function normalizeDetachedUnknownObservations(
  values: DuduDetachedUnknownImportInput[] | DuduDetachedUnknownContract[] | undefined,
): DuduDetachedUnknownContract[] {
  if (values !== undefined && !Array.isArray(values)) throw new Error("detachedUnknownObservations 必须是数组。 ");
  const normalized = (values ?? []).map((value, index): DuduDetachedUnknownContract => {
    const unitId = typeof value.unitId === "string" ? value.unitId.trim() : "";
    const sourceTaskId = typeof value.sourceTaskId === "string" ? value.sourceTaskId.trim() : "";
    const evidenceReference = typeof value.evidenceReference === "string" ? value.evidenceReference.trim() : "";
    const evidenceFingerprint = typeof value.evidenceFingerprint === "string" ? value.evidenceFingerprint.trim().toLowerCase() : "";
    const candidateSha256 = typeof value.candidateSha256 === "string" && value.candidateSha256.trim()
      ? value.candidateSha256.trim().toLowerCase()
      : null;
    const candidateSizeBytes = value.candidateSizeBytes ?? null;
    const candidateWidth = value.candidateWidth ?? null;
    const candidateHeight = value.candidateHeight ?? null;
    const note = typeof value.note === "string" ? value.note.normalize("NFC").trim() : "";
    if (!/^S1E01-U(?:0[0-9]|[12][0-9]|3[0-2])$/u.test(unitId)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(sourceTaskId)
      || !evidenceReference || evidenceReference.length > 2_000
      || !/^[a-f0-9]{64}$/u.test(evidenceFingerprint)
      || (candidateSha256 !== null && !/^[a-f0-9]{64}$/u.test(candidateSha256))
      || note.length > 2_000) {
      throw new Error(`detachedUnknownObservations[${index}] 身份字段无效。`);
    }
    const metrics = [candidateSizeBytes, candidateWidth, candidateHeight];
    if (metrics.some((entry) => entry !== null && (!Number.isSafeInteger(entry) || entry! < 1))
      || (candidateSha256 === null && metrics.some((entry) => entry !== null))) {
      throw new Error(`detachedUnknownObservations[${index}] candidate 元数据不成组。`);
    }
    return {
      unitId,
      sourceTaskId,
      evidenceReference,
      evidenceFingerprint,
      candidateSha256,
      candidateSizeBytes,
      candidateWidth,
      candidateHeight,
      note,
    };
  }).sort((left, right) => `${left.unitId}:${left.sourceTaskId}:${left.evidenceFingerprint}`
    .localeCompare(`${right.unitId}:${right.sourceTaskId}:${right.evidenceFingerprint}`, "en"));
  const identities = normalized.map((item) => `${item.unitId}:${item.sourceTaskId}`);
  if (new Set(identities).size !== identities.length) throw new Error("detached unknown 含重复 unit/task 身份。 ");
  return normalized;
}

function detachedUnknownContractFingerprint(values: DuduDetachedUnknownContract[]): string {
  return digest({ schemaVersion: 1, kind: "dudu-detached-unknown-contract", observations: values });
}

function pathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalProjectsRoot(projectsRoot: string): Promise<string> {
  const resolved = path.resolve(projectsRoot);
  const metadata = await lstat(resolved);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("projectsRoot 必须是无符号链接的真实目录。 ");
  const canonical = await realpath(resolved);
  if (canonical !== resolved) throw new Error("projectsRoot 不得经符号链接访问。 ");
  return canonical;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  const absolute = path.resolve(filePath);
  let handle;
  try {
    const metadata = await lstat(absolute, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2n || metadata.size > BigInt(16 * 1024 * 1024)
      || await realpath(absolute) !== absolute) {
      throw new Error(`Dudu JSON 不是安全普通文件：${absolute}`);
    }
    handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || metadata.dev !== before.dev || metadata.ino !== before.ino) {
      throw new Error(`Dudu JSON 打开前命名路径发生替换：${absolute}`);
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
      throw new Error(`Dudu JSON 读取期间发生替换：${absolute}`);
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as T;
    return parsed;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeImmutableJson(projectRoot: string, relativePath: string, value: unknown): Promise<void> {
  const target = path.resolve(projectRoot, relativePath);
  if (!pathInside(target, projectRoot) || target === projectRoot) throw new Error(`不可变收据路径逃逸工程：${relativePath}`);
  const content = `${JSON.stringify(stableValue(value), null, 2)}\n`;
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || await realpath(parent) !== parent) {
    throw new Error(`不可变收据父目录不是安全真实目录：${relativePath}`);
  }
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) throw error;
    const existing = await readJsonFile<unknown>(target);
    if (`${JSON.stringify(stableValue(existing), null, 2)}\n` !== content) {
      throw new Error(`不可变收据已存在但内容冲突：${relativePath}`);
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const parentHandle = await open(parent, "r");
  try { await parentHandle.sync(); } finally { await parentHandle.close(); }
}

function normalizeCommandRequestHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error("Dudu commandRequestHash 必须是 SHA-256。 ");
  return normalized;
}

function commandOperationReceiptRelativePath(
  command: DuduReadonlyCommandOperationReceipt["command"],
  commandRequestHash: string,
): string {
  return path.posix.join(
    COMMAND_OPERATION_RECEIPT_RELATIVE_ROOT,
    command,
    `${normalizeCommandRequestHash(commandRequestHash)}.json`,
  );
}

function commandOperationReceiptFingerprint(
  value: Omit<DuduReadonlyCommandOperationReceipt, "fingerprint">,
): string {
  return digest(value);
}

function validateCommandOperationReceipt(value: DuduReadonlyCommandOperationReceipt): DuduReadonlyCommandOperationReceipt {
  if (!value || value.schemaVersion !== 1 || value.kind !== "dudu-readonly-command-operation-receipt"
    || (value.command !== "stage_dudu_readonly_managed_project"
      && value.command !== "finalize_dudu_readonly_managed_project")
    || normalizeCommandRequestHash(value.commandRequestHash) !== value.commandRequestHash
    || typeof value.createdAt !== "string" || !value.createdAt
    || !/^[a-f0-9]{64}$/u.test(value.importFingerprint)
    || (value.registrationFingerprint !== null && !/^[a-f0-9]{64}$/u.test(value.registrationFingerprint))
    || (value.activationFingerprint !== null && !/^[a-f0-9]{64}$/u.test(value.activationFingerprint))
    || (value.activationId !== null && !/^[a-f0-9-]{16,64}$/u.test(value.activationId))) {
    throw new Error("Dudu command operation receipt 格式无效。 ");
  }
  if (value.command === "stage_dudu_readonly_managed_project"
    && (value.registrationFingerprint !== null || value.activationId !== null || value.activationFingerprint !== null)) {
    throw new Error("Dudu stage command operation receipt 不得携带 finalize 身份。 ");
  }
  if (value.command === "finalize_dudu_readonly_managed_project"
    && (value.registrationFingerprint === null || value.activationId === null || value.activationFingerprint === null)) {
    throw new Error("Dudu finalize command operation receipt 缺少登记/激活身份。 ");
  }
  return assertFingerprintRecord(value, commandOperationReceiptFingerprint, "Dudu command operation receipt");
}

async function ensureCommandOperationReceipt(
  projectRoot: string,
  input: Omit<DuduReadonlyCommandOperationReceipt, "schemaVersion" | "kind" | "createdAt" | "fingerprint">,
): Promise<DuduReadonlyCommandOperationReceipt> {
  const commandRequestHash = normalizeCommandRequestHash(input.commandRequestHash);
  const relativePath = commandOperationReceiptRelativePath(input.command, commandRequestHash);
  const existing = await readJsonFile<DuduReadonlyCommandOperationReceipt>(path.join(projectRoot, relativePath));
  if (existing) {
    const receipt = validateCommandOperationReceipt(existing);
    const { createdAt: _existingCreatedAt, fingerprint: _existingFingerprint, schemaVersion: _schemaVersion, kind: _kind, ...identity } = receipt;
    if (stableJson(identity) !== stableJson({ ...input, commandRequestHash })) {
      throw new Error(`Dudu command operation receipt 身份冲突：${commandRequestHash}`);
    }
    return receipt;
  }
  const createdAt = new Date().toISOString();
  const semantic: Omit<DuduReadonlyCommandOperationReceipt, "fingerprint"> = {
    schemaVersion: 1,
    kind: "dudu-readonly-command-operation-receipt",
    ...input,
    commandRequestHash,
    createdAt,
  };
  const receipt: DuduReadonlyCommandOperationReceipt = {
    ...semantic,
    fingerprint: commandOperationReceiptFingerprint(semantic),
  };
  await writeImmutableJson(projectRoot, relativePath, receipt);
  const landed = await readJsonFile<DuduReadonlyCommandOperationReceipt>(path.join(projectRoot, relativePath));
  if (!landed) throw new Error("Dudu command operation receipt 未落盘。 ");
  return validateCommandOperationReceipt(landed);
}

async function readCommandOperationReceipt(
  projectRoot: string,
  command: DuduReadonlyCommandOperationReceipt["command"],
  commandRequestHash: string,
): Promise<DuduReadonlyCommandOperationReceipt | null> {
  const normalized = normalizeCommandRequestHash(commandRequestHash);
  const value = await readJsonFile<DuduReadonlyCommandOperationReceipt>(path.join(
    projectRoot,
    commandOperationReceiptRelativePath(command, normalized),
  ));
  if (!value) return null;
  const receipt = validateCommandOperationReceipt(value);
  if (receipt.command !== command || receipt.commandRequestHash !== normalized
    || receipt.projectRoot !== path.resolve(projectRoot)) return null;
  return receipt;
}

function intentSemantic(input: Omit<DuduReadonlyImportIntent, "fingerprint" | "createdAt">) {
  return input;
}

function validateIntent(value: DuduReadonlyImportIntent): DuduReadonlyImportIntent {
  if (!value || value.schemaVersion !== 3 || value.kind !== "dudu-readonly-import-intent") throw new Error("Dudu import intent 格式无效。 ");
  const detachedUnknownObservations = normalizeDetachedUnknownObservations(value.detachedUnknownObservations);
  if (stableJson(detachedUnknownObservations) !== stableJson(value.detachedUnknownObservations)) {
    throw new Error("Dudu import intent detached unknown 未规范化。 ");
  }
  const expected = digest(intentSemantic({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    projectId: value.projectId,
    projectRoot: value.projectRoot,
    sourceProductionRoot: value.sourceProductionRoot,
    sourceLockedScriptPath: value.sourceLockedScriptPath,
    managedManifestFingerprint: value.managedManifestFingerprint,
    sourceManifestFingerprint: value.sourceManifestFingerprint,
    productionScopeFingerprint: value.productionScopeFingerprint,
    contractSha256: value.contractSha256,
    lockedScriptSha256: value.lockedScriptSha256,
    bootstrapClaimFingerprint: value.bootstrapClaimFingerprint,
    detachedUnknownObservations,
  }));
  if (value.fingerprint !== expected) throw new Error("Dudu import intent fingerprint 无效。 ");
  return value;
}

function duduBootstrapPayload(
  inspection: DuduReadonlySourceInspection,
  detachedUnknownObservations: DuduDetachedUnknownContract[],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "dudu-readonly-bootstrap",
    projectName: PROJECT_NAME,
    projectSlug: PROJECT_SLUG,
    sourceProductionRoot: inspection.productionRoot,
    sourceLockedScriptPath: inspection.lockedScriptPath,
    sourceManifestFingerprint: inspection.sourceManifestFingerprint,
    productionScopeFingerprint: inspection.productionScopeFingerprint,
    contractSha256: inspection.contract.sha256,
    lockedScriptSha256: inspection.lockedScript.sha256,
    detachedUnknownContractFingerprint: detachedUnknownContractFingerprint(detachedUnknownObservations),
  };
}

function assertDuduBootstrapClaim(
  claim: ManagedProjectBootstrapClaim,
  inspection: DuduReadonlySourceInspection,
  projectRoot: string,
  detachedUnknownObservations: DuduDetachedUnknownContract[],
): void {
  if (claim.projectRoot !== projectRoot || claim.purpose !== BOOTSTRAP_PURPOSE
    || stableJson(claim.payload) !== stableJson(duduBootstrapPayload(inspection, detachedUnknownObservations))) {
    throw new Error(`Dudu bootstrap claim 与当前唯一来源合同不一致，禁止接管或另建：${projectRoot}`);
  }
}

function buildImportIntent(
  shell: ProjectShell,
  inspection: DuduReadonlySourceInspection,
  claim: ManagedProjectBootstrapClaim,
  detachedUnknownObservations: DuduDetachedUnknownContract[],
): DuduReadonlyImportIntent {
  const semantic = intentSemantic({
    schemaVersion: 3,
    kind: "dudu-readonly-import-intent",
    projectId: shell.project.id,
    projectRoot: shell.paths.root,
    sourceProductionRoot: inspection.productionRoot,
    sourceLockedScriptPath: inspection.lockedScriptPath,
    managedManifestFingerprint: shell.manifestFingerprint,
    sourceManifestFingerprint: inspection.sourceManifestFingerprint,
    productionScopeFingerprint: inspection.productionScopeFingerprint,
    contractSha256: inspection.contract.sha256,
    lockedScriptSha256: inspection.lockedScript.sha256,
    bootstrapClaimFingerprint: claim.fingerprint,
    detachedUnknownObservations,
  });
  return {
    ...semantic,
    fingerprint: digest(semantic),
    createdAt: new Date().toISOString(),
  };
}

function allNumericCountsZero(value: Record<string, number>): boolean {
  return Object.values(value).every((entry) => Number.isSafeInteger(entry) && entry === 0);
}

async function assertPristineDuduBootstrapOrphan(
  shell: ProjectShell,
  inspection: DuduReadonlySourceInspection,
  detachedUnknownObservations: DuduDetachedUnknownContract[],
): Promise<void> {
  if (shell.project.name !== PROJECT_NAME
    || shell.project.sourceRoots.length !== 0
    || shell.project.outputRoots.length !== 1
    || path.resolve(shell.project.outputRoots[0]!) !== shell.paths.root
    || Object.values(shell.counts).some((count) => count !== 0)) {
    throw new Error(`Dudu bootstrap orphan 已含非空 project/index 状态，禁止接管：${shell.paths.root}`);
  }
  const [importReceipt, registrationReceipt, activationReceipts, registry, active, material, production, generation] = await Promise.all([
    readJsonFile<unknown>(path.join(shell.paths.root, RECEIPT_RELATIVE_PATH)),
    readJsonFile<unknown>(path.join(shell.paths.root, REGISTRATION_RELATIVE_PATH)),
    readdir(path.join(shell.paths.root, ACTIVATION_RECEIPT_RELATIVE_ROOT)).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
      throw error;
    }),
    listRegisteredProjects(),
    getActiveProjectState(),
    getMaterialStudioState(shell.paths.root),
    getStudioProductionState(shell.paths.root),
    getStudioGenerationLedgerState(shell.paths.root),
  ]);
  const sameRoot = registry.filter((project) => path.resolve(project.primaryRoot) === shell.paths.root);
  const sameId = registry.filter((project) => project.id === shell.project.id);
  if (importReceipt || registrationReceipt || activationReceipts.length > 0
    || sameRoot.length !== 0 || sameId.length !== 0
    || (active && path.resolve(active.primaryRoot) === shell.paths.root)
    || !allNumericCountsZero(material.counts)
    || !allNumericCountsZero(production.counts)
    || !allNumericCountsZero(generation.counts)) {
    throw new Error(`Dudu bootstrap orphan 不再是未登记、未激活、零业务状态，禁止补写 intent：${shell.paths.root}`);
  }
  const claim = await readManagedProjectBootstrapClaim(shell.paths.root);
  if (!claim) throw new Error(`Dudu bootstrap orphan 缺少不可变 claim：${shell.paths.root}`);
  assertDuduBootstrapClaim(claim, inspection, shell.paths.root, detachedUnknownObservations);
}

function importReceiptFingerprint(receipt: Omit<DuduReadonlyImportReceipt, "fingerprint">): string {
  return digest(receipt);
}

function validateImportReceipt(value: DuduReadonlyImportReceipt): DuduReadonlyImportReceipt {
  if (!value || value.schemaVersion !== 3 || value.kind !== "dudu-readonly-managed-import") throw new Error("Dudu import receipt 格式无效。 ");
  return assertFingerprintRecord(value, importReceiptFingerprint, "Dudu import receipt");
}

async function discoverOrCreateStagingProject(
  projectsRoot: string,
  source: DuduReadonlySourceInput,
  inspection: DuduReadonlySourceInspection,
  detachedUnknownObservations: DuduDetachedUnknownContract[],
): Promise<{ shell: ProjectShell; intent: DuduReadonlyImportIntent; created: boolean }> {
  const entries = await readdir(projectsRoot, { withFileTypes: true });
  const candidates: Array<{ shell: ProjectShell; intent: DuduReadonlyImportIntent }> = [];
  const unclaimedRoots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || (!entry.name.startsWith(`${PROJECT_SLUG}-`) && entry.name !== PROJECT_SLUG)) continue;
    const candidateRoot = path.join(projectsRoot, entry.name);
    const [intentValue, initialClaim] = await Promise.all([
      readJsonFile<DuduReadonlyImportIntent>(path.join(candidateRoot, INTENT_RELATIVE_PATH)),
      readManagedProjectBootstrapClaim(candidateRoot),
    ]);
    if (!intentValue) {
      let claim = initialClaim;
      if (!claim) {
        try {
          await resumeManagedProjectBootstrap(candidateRoot, {
            name: PROJECT_NAME,
            bootstrapClaim: {
              purpose: BOOTSTRAP_PURPOSE,
              payload: duduBootstrapPayload(inspection, detachedUnknownObservations),
            },
          });
          claim = await readManagedProjectBootstrapClaim(candidateRoot);
        } catch {
          unclaimedRoots.push(candidateRoot);
          continue;
        }
      }
      if (!claim) throw new Error(`Dudu bootstrap orphan 恢复后仍缺少 claim：${candidateRoot}`);
      assertDuduBootstrapClaim(claim, inspection, candidateRoot, detachedUnknownObservations);
      const shell = await inspectManagedProject(candidateRoot).catch(async () => resumeManagedProjectBootstrap(candidateRoot, {
        name: PROJECT_NAME,
        bootstrapClaim: {
          purpose: BOOTSTRAP_PURPOSE,
          payload: duduBootstrapPayload(inspection, detachedUnknownObservations),
        },
      }));
      await assertPristineDuduBootstrapOrphan(shell, inspection, detachedUnknownObservations);
      await ensureManagedProjectCreatedEvent(shell);
      await verifySourceUnchanged(source, inspection);
      const intent = buildImportIntent(shell, inspection, claim, detachedUnknownObservations);
      await writeImmutableJson(shell.paths.root, INTENT_RELATIVE_PATH, intent);
      candidates.push({ shell, intent });
      continue;
    }
    const claim = initialClaim;
    if (!claim) throw new Error(`Dudu staging intent 缺少创建前 bootstrap claim，禁止继续：${candidateRoot}`);
    assertDuduBootstrapClaim(claim, inspection, candidateRoot, detachedUnknownObservations);
    const intent = validateIntent(intentValue);
    const shell = await inspectManagedProject(candidateRoot);
    if (shell.project.id !== intent.projectId || shell.paths.root !== intent.projectRoot
      || shell.manifestFingerprint !== intent.managedManifestFingerprint) {
      throw new Error(`Dudu staging intent 与 managed project 身份冲突：${candidateRoot}`);
    }
    if (intent.bootstrapClaimFingerprint !== claim.fingerprint
      || detachedUnknownContractFingerprint(intent.detachedUnknownObservations)
        !== claim.payload.detachedUnknownContractFingerprint) {
      throw new Error(`Dudu staging intent 未绑定当前 bootstrap claim：${candidateRoot}`);
    }
    candidates.push({ shell, intent });
  }
  if (unclaimedRoots.length > 0) {
    throw new Error(`发现缺少 bootstrap claim/import intent 的 Dudu 专用根，禁止猜测或另建：${unclaimedRoots.join(",")}`);
  }
  if (candidates.length > 1) throw new Error(`发现多个 Dudu staging 工程，禁止选择第一个：${candidates.map((item) => item.shell.paths.root).join(",")}`);
  if (candidates.length === 1) {
    const candidate = candidates[0]!;
    if (candidate.intent.sourceManifestFingerprint !== inspection.sourceManifestFingerprint
      || candidate.intent.productionScopeFingerprint !== inspection.productionScopeFingerprint
      || candidate.intent.contractSha256 !== inspection.contract.sha256
      || candidate.intent.lockedScriptSha256 !== inspection.lockedScript.sha256
      || candidate.intent.sourceProductionRoot !== inspection.productionRoot
      || candidate.intent.sourceLockedScriptPath !== inspection.lockedScriptPath) {
      throw new Error("现有 Dudu staging 已绑定不同 source manifest/范围，源漂移后禁止建立第二工程。 ");
    }
    return { ...candidate, created: false };
  }
  const shell = await createManagedProject({
    parentRoot: projectsRoot,
    name: PROJECT_NAME,
    slug: PROJECT_SLUG,
    bootstrapClaim: {
      purpose: BOOTSTRAP_PURPOSE,
      payload: duduBootstrapPayload(inspection, detachedUnknownObservations),
    },
  });
  await ensureManagedProjectCreatedEvent(shell);
  const claim = await readManagedProjectBootstrapClaim(shell.paths.root);
  if (!claim) throw new Error(`新建 Dudu staging 未落盘 bootstrap claim：${shell.paths.root}`);
  assertDuduBootstrapClaim(claim, inspection, shell.paths.root, detachedUnknownObservations);
  await verifySourceUnchanged(source, inspection);
  const intent = buildImportIntent(shell, inspection, claim, detachedUnknownObservations);
  await writeImmutableJson(shell.paths.root, INTENT_RELATIVE_PATH, intent);
  return { shell, intent, created: true };
}

async function ensureSingleTextRevision(input: {
  projectRoot: string;
  kind: "script" | "prompt";
  documentId: string;
  title: string;
  body: string;
  source: string;
  sourceVersion: string;
}): Promise<StudioTextRevision> {
  let document = await getStudioTextDocument(input.projectRoot, input.documentId);
  if (!document) {
    document = input.kind === "script"
      ? await createStudioScriptDocument(input.projectRoot, { id: input.documentId, title: input.title, expectedRevision: 0 })
      : await createStudioPromptDocument(input.projectRoot, { id: input.documentId, title: input.title, expectedRevision: 0 });
  }
  if (document.revision === 0) {
    const appended = input.kind === "script"
      ? await appendStudioScriptRevision(input.projectRoot, {
          documentId: input.documentId,
          expectedRevision: 0,
          body: input.body,
          source: input.source,
          sourceVersion: input.sourceVersion,
        })
      : await appendStudioPromptRevision(input.projectRoot, {
          documentId: input.documentId,
          expectedRevision: 0,
          body: input.body,
          source: input.source,
          sourceVersion: input.sourceVersion,
        });
    return appended.revision;
  }
  if (document.revision !== 1) throw new Error(`只读导入文档 ${input.documentId} 出现额外修订，禁止覆盖。`);
  const revisions = await listStudioTextRevisions(input.projectRoot, { documentId: input.documentId, limit: 2 });
  if (revisions.items.length !== 1 || revisions.nextCursor) throw new Error(`只读导入文档 ${input.documentId} 修订历史无效。`);
  const revision = await getStudioTextRevision(input.projectRoot, revisions.items[0]!.id);
  if (!revision || revision.bodySha256 !== sha256Text(input.body) || revision.body !== input.body
    || revision.source !== input.source || revision.sourceVersion !== input.sourceVersion) {
    throw new Error(`只读导入文档 ${input.documentId} 与来源内容冲突。`);
  }
  return revision;
}

function assetDescription(asset: DuduReferenceAsset): string {
  return [
    "《嘟嘟》只读来源的批准视觉参考。",
    `sourceType=${asset.sourceType}`,
    `referenceRole=${asset.referenceRole}`,
    `sourceRelativePath=${asset.relativePath}`,
    `sourceSha256=${asset.sha256}`,
  ].join("\n");
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length
    && [...left].sort((a, b) => a.localeCompare(b, "en"))
      .every((value, index) => value === [...right].sort((a, b) => a.localeCompare(b, "en"))[index]);
}

async function ensureImportedMediaOrigin(
  projectRoot: string,
  source: { absolutePath: string; sha256: string; sizeBytes?: number },
): Promise<StudioMediaMetadata> {
  const canonicalSource = await realpath(source.absolutePath);
  if (canonicalSource !== path.resolve(source.absolutePath)) throw new Error(`媒体来源不得经符号链接导入：${source.absolutePath}`);
  const sourceMetadata = await lstat(canonicalSource);
  if (!sourceMetadata.isFile()) throw new Error(`媒体来源不是普通文件：${canonicalSource}`);
  const sizeBytes = source.sizeBytes ?? sourceMetadata.size;
  if (sourceMetadata.size !== sizeBytes) throw new Error(`媒体来源字节数漂移：${canonicalSource}`);
  const readOrigins = async () => {
    const items = [];
    let cursor: string | undefined;
    do {
      const page = await listStudioMediaImportOrigins(projectRoot, source.sha256, { ...(cursor ? { cursor } : {}), limit: 100 });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  };
  let media = await getStudioMedia(projectRoot, source.sha256);
  let origins = media ? await readOrigins() : [];
  const exactOrigins = () => origins.filter((origin) => origin.source.scope === "external"
    && path.resolve(origin.source.absolutePath) === canonicalSource
    && origin.sourceBasename === path.basename(canonicalSource)
    && origin.sourceSizeBytes === sizeBytes
    && origin.expectedSha256 === source.sha256);
  if (exactOrigins().length > 1) throw new Error(`媒体来源重复登记：${canonicalSource}`);
  if (!media || exactOrigins().length === 0) {
    media = await importStudioMedia(projectRoot, {
      sourcePath: canonicalSource,
      expectedSha256: source.sha256,
      kind: "image",
    });
    origins = await readOrigins();
  }
  if (!media || media.sha256 !== source.sha256 || media.kind !== "image" || media.sizeBytes !== sizeBytes
    || exactOrigins().length !== 1 || !(await verifyStudioMediaObject(projectRoot, source.sha256))) {
    throw new Error(`媒体/CAS/source origin 闭包无效：${canonicalSource}`);
  }
  return media;
}

async function verifyImportedMediaOrigin(
  projectRoot: string,
  source: { absolutePath: string; sha256: string; sizeBytes?: number },
): Promise<StudioMediaMetadata> {
  const canonicalSource = await realpath(source.absolutePath);
  if (canonicalSource !== path.resolve(source.absolutePath)) throw new Error(`媒体来源不得经符号链接访问：${source.absolutePath}`);
  const metadata = await lstat(canonicalSource);
  if (!metadata.isFile()) throw new Error(`媒体来源不是普通文件：${canonicalSource}`);
  const sizeBytes = source.sizeBytes ?? metadata.size;
  if (metadata.size !== sizeBytes) throw new Error(`媒体来源字节数漂移：${canonicalSource}`);
  const media = await getStudioMedia(projectRoot, source.sha256);
  const origins = [];
  let cursor: string | undefined;
  do {
    const page = await listStudioMediaImportOrigins(projectRoot, source.sha256, { ...(cursor ? { cursor } : {}), limit: 100 });
    origins.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  const exact = origins.filter((origin) => origin.source.scope === "external"
    && path.resolve(origin.source.absolutePath) === canonicalSource
    && origin.sourceBasename === path.basename(canonicalSource)
    && origin.sourceSizeBytes === sizeBytes
    && origin.expectedSha256 === source.sha256);
  if (!media || media.sha256 !== source.sha256 || media.kind !== "image" || media.sizeBytes !== sizeBytes
    || exact.length !== 1 || !(await verifyStudioMediaObject(projectRoot, source.sha256))) {
    throw new Error(`媒体/CAS/source origin 只读验证失败：${canonicalSource}`);
  }
  return media;
}

async function ensureReferenceAsset(
  projectRoot: string,
  projectId: string,
  asset: DuduReferenceAsset,
): Promise<StudioCanonicalAssetDetail> {
  const media = await ensureImportedMediaOrigin(projectRoot, asset);
  if (media.sha256 !== asset.sha256) throw new Error(`资产 ${asset.id} CAS SHA 漂移。`);
  let detail = await getStudioCanonicalAsset(projectRoot, asset.id);
  const description = assetDescription(asset);
  const identityFeatures = [asset.inherit];
  const positiveLocks = [asset.inherit, `权威媒体 SHA-256：${asset.sha256}`];
  const negativeLocks = [asset.forbid];
  const defaultPrompt = `严格使用批准参考 ${asset.id}，${asset.inherit}；${asset.forbid}`;
  const applicability = {
    projects: [projectId],
    seasons: ["S1"],
    episodes: ["S1E1"],
    units: [],
    timeRanges: [],
    tags: ["dudu-readonly-import", `sourceType:${asset.sourceType}`, `referenceRole:${asset.referenceRole}`]
      .sort((left, right) => left.localeCompare(right, "en")),
  };
  if (!detail) {
    detail = await createStudioCanonicalAsset(projectRoot, {
      id: asset.id,
      expectedRevision: 0,
      category: asset.category,
      name: asset.name,
      description,
      aliases: asset.aliases,
      identityFeatures,
      positiveLocks,
      negativeLocks,
      defaultPrompt,
      applicability,
    });
  }
  const definition = detail.definitionVersions.find((entry) => entry.id === detail!.currentDefinitionVersionId);
  if (!definition || detail.definitionVersions.length !== 1 || detail.category !== asset.category
    || detail.name !== asset.name || detail.description !== description || !sameStringSet(detail.aliases, asset.aliases)
    || !sameStringSet(definition.identityFeatures, identityFeatures) || !sameStringSet(definition.positiveLocks, positiveLocks)
    || !sameStringSet(definition.negativeLocks, negativeLocks) || definition.defaultPrompt !== defaultPrompt
    || stableJson(definition.applicability) !== stableJson(applicability)) {
    throw new Error(`资产 ${asset.id} 的 Studio 定义与只读映射冲突。`);
  }
  let version = detail.versions.find((entry) => entry.mediaSha256 === asset.sha256);
  if (!version) {
    if (detail.versions.length > 0) throw new Error(`资产 ${asset.id} 已含其他媒体版本，禁止追加掩盖。`);
    const appended = await appendStudioAssetVersion(projectRoot, {
      assetId: asset.id,
      mediaSha256: asset.sha256,
      reviewStatus: "pending",
      sourceNote: `historical-authority-import:${asset.relativePath}:${asset.sha256}`,
      expectedRevision: detail.revision,
    });
    detail = (await getStudioCanonicalAsset(projectRoot, asset.id))!;
    version = detail.versions.find((entry) => entry.id === appended.version.id)!;
  }
  if (version.reviewStatus === "pending") {
    detail = await reviewStudioAssetVersion(projectRoot, {
      assetId: asset.id,
      versionId: version.id,
      decision: "approved",
      expectedRevision: detail.revision,
      note: `外部 registry 状态 ${asset.status}；仅导入当前批准 SHA，不追认被拒候选。`,
    });
    version = detail.versions.find((entry) => entry.id === version!.id)!;
  }
  if (version.reviewStatus !== "approved") throw new Error(`资产 ${asset.id} 的来源版本不是 approved。`);
  if (detail.versions.length !== 1 || version.sourceNote !== `historical-authority-import:${asset.relativePath}:${asset.sha256}`) {
    throw new Error(`资产 ${asset.id} 的版本历史/sourceNote 不属于精确只读导入。`);
  }
  if (!detail.primaryAuthority) {
    detail = await setStudioPrimaryAuthority(projectRoot, {
      assetId: asset.id,
      versionId: version.id,
      expectedRevision: detail.revision,
      note: `《嘟嘟》只读 registry 权威：${asset.relativePath} / ${asset.sha256}`,
    });
  }
  if (detail.primaryAuthority?.versionId !== version.id || detail.primaryAuthority.mediaSha256 !== asset.sha256) {
    throw new Error(`资产 ${asset.id} 已提升其他主权威，禁止覆盖。`);
  }
  if (detail.authorityHistory.length !== 1) throw new Error(`资产 ${asset.id} 存在额外 authority 历史。`);
  return detail;
}

function field(panel: DuduParsedPanel, key: string, fallback = "无"): string {
  const value = panel.fields[key]?.trim();
  return value && value !== "—" ? value : fallback;
}

function visualCostumeState(panel: DuduParsedPanel): string {
  const meteorState = /meteor_vfx(?:_state)?[=:]`?([A-Z_]+)/u.exec(panel.sourceText)?.[1]
    ?? /meteor_vfx[=:]([A-Z_]+)/u.exec(field(panel, "连续性", ""))?.[1]
    ?? "OFF";
  const cue = /cue[=:]`?([a-z0-9:_-]+)/iu.exec(panel.sourceText)?.[1] ?? "none";
  return `身份仅按批准参考；临时VFX与身份分层；meteor_vfx=${meteorState}；cue=${cue}`;
}

function markdownSection(body: string, heading: RegExp): string {
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return "";
  const nextOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/u.test(line));
  const end = nextOffset < 0 ? lines.length : start + 1 + nextOffset;
  return lines.slice(start + 1, end).join("\n").trim();
}

function bindingPanelContext(unit: DuduReadonlyUnitSource, panelIndex: number): string {
  if (!unit.binding) return "";
  const lines = unit.binding.body.split(/\r?\n/u);
  const panelId = `${unit.unitId}-G${panelIndex}`;
  const headingIndex = lines.findIndex((line) => line.startsWith(`### ${panelId}`));
  const blocks: string[] = [];
  if (headingIndex >= 0) {
    const nextOffset = lines.slice(headingIndex + 1).findIndex((line) => /^#{2,3}\s+/u.test(line));
    const end = nextOffset < 0 ? lines.length : headingIndex + 1 + nextOffset;
    blocks.push(lines.slice(headingIndex, end).join("\n"));
  }
  const numbered = new RegExp(`^\\s*${panelIndex}[.、]\\s+`, "u");
  const tableCell = new RegExp(`\\|\\s*G${panelIndex}\\s*\\|`, "u");
  blocks.push(...lines.filter((line) => numbered.test(line) || tableCell.test(line)));
  return blocks.join("\n").trim();
}

function bindingVisualRules(unit: DuduReadonlyUnitSource, panelIndex: number): string {
  if (!unit.binding || unit.binding.format !== "v2") return "";
  const boundaryRules = markdownSection(unit.binding.body, /^##\s+A\.\s+/u)
    .split(/\r?\n/u)
    .filter((line) => {
      if (/锁版源|绝对路径|SHA-?256|版本|日期|状态|候选|正式路径|来源\s*[:：]|文件\s*[:：]|路径\s*[:：]/u.test(line)) return false;
      try {
        assertDuduPromptTextPathFree(line, "v2 A. 权威与边界规则");
        return true;
      } catch {
        return false;
      }
    })
    .join("\n")
    .trim();
  const identityRules = markdownSection(unit.binding.body, /^##\s+C\.\s+/u);
  const panelRules = bindingPanelContext(unit, panelIndex)
    .split(/\r?\n/u)
    .filter((line) => !/sound_score|对白|旁白|音色|配音|声音/u.test(line))
    .join("\n")
    .trim();
  const hardFailureLine = markdownSection(unit.binding.body, /^##\s+G\.\s+/u)
    .split(/\r?\n/u)
    .find((line) => /硬失败/u.test(line))
    ?.replace(/^[-*]\s*/u, "")
    .replace(/A1|A2|A3|代理|预算/gu, "")
    .trim() ?? "";
  return [boundaryRules, identityRules, panelRules, hardFailureLine].filter(Boolean).join("\n");
}

interface DuduPanelBindingItem {
  asset: DuduReferenceAsset;
  presence: "required" | "optional" | "forbidden";
  role: string;
}

function assetSemanticTokens(asset: DuduReferenceAsset): string[] {
  return duduReferenceSemanticTokens(asset);
}

function buildPanelPrompt(
  unit: DuduReadonlyUnitSource,
  panel: DuduParsedPanel,
  visualPanel: DuduParsedPanel,
  bindings: DuduPanelBindingItem[],
): string {
  const references = bindings.filter((item) => item.presence !== "forbidden").map((item) =>
    `- ${item.asset.id} / ${item.asset.referenceRole} / ${item.presence} / SHA ${item.asset.sha256}：${item.asset.inherit}；禁止：${item.asset.forbid}`).join("\n");
  const forbidden = bindings.filter((item) => item.presence === "forbidden").map((item) =>
    `- ${item.asset.id}：${item.role}；${item.asset.forbid}`).join("\n");
  const visualRules = bindingVisualRules(unit, panel.index);
  const prompt = [
    `用途：${unit.unitId} 的 unit-grid 第 ${panel.index}/${unit.panelCount} 格冻结语义；不得单独扩成额外格。`,
    `真实时码：${panel.startSeconds}–${panel.endSeconds} 秒；单元总时长 ${unit.durationSeconds} 秒。`,
    `景别：${field(visualPanel, "景别")}`,
    `机位：${field(visualPanel, "机位")}`,
    `运镜：${field(visualPanel, "运镜")}`,
    `构图：${field(visualPanel, "构图")}`,
    `动作：${field(visualPanel, "动作")}`,
    `表情：${field(visualPanel, "表情")}；${field(visualPanel, "表情细节")}`,
    `情绪：${field(visualPanel, "情绪")}`,
    `光线与色彩：${field(visualPanel, "光线")}；${field(visualPanel, "色彩")}`,
    `视觉连续性：${field(visualPanel, "连续性")}`,
    "对白、旁白、配音、音效只留在锁版剧本与视频包证据中，不进入 raw 视觉提示词。",
    "画面内禁止标题、格号、时长、对白文字、字幕、水印、UI、标识和任何伪文字。",
    references
      ? `本格当前 BindingSet 的批准图片参考闭包：\n${references}`
      : unit.binding
        ? "本格没有 required/optional 图片控制参考；不得自行补入角色、场景实体或道具。"
        : "当前单元没有冻结 BindingSet；这里只保存锁版视觉投影，禁止冻结或派发生成。",
    forbidden ? `本格结构化禁止出画资产（不得作为控制参考上传）：\n${forbidden}` : "",
    unit.binding?.rawGridPrompt
      ? `当前 v2 BindingSet 的 E. raw 宫格总合同（逐字冻结，适用于整张宫格）：\n${unit.binding.rawGridPrompt}`
      : "",
    visualRules ? `当前 v2 BindingSet 的逐格视觉规则（声音字段已剔除）：\n${visualRules}` : "",
  ].filter(Boolean).join("\n");
  assertDuduPromptTextPathFree(prompt, `${unit.unitId}-G${panel.index} 最终视觉提示词`);
  return prompt;
}

function panelAssetMatrix(unit: DuduReadonlyUnitSource): DuduPanelBindingItem[][] {
  const matrix = unit.visualExecutionPanels.map((panel, offset) => unit.references.flatMap((asset): DuduPanelBindingItem[] => {
    const presence = duduReferencePresenceForPanel(panel, asset);
    const lockedPanel = unit.panels[offset]!;
    const anchored = assetSemanticTokens(asset).some((token) => duduTextIncludesSemanticToken(lockedPanel.sourceText, token));
    if (presence === "forbidden" && !anchored) return [];
    return [{
      asset,
      presence,
      role: presence === "forbidden"
        ? `当前逐格语义声明为画外/不可见：${asset.forbid}`
        : `当前 BindingSet ${asset.referenceRole}：${asset.inherit}`,
    }];
  }).concat(unit.forbiddenReferences.flatMap((entry): DuduPanelBindingItem[] => {
    if (!entry.panelIndexes.includes(panel.index)) return [];
    return [{
      asset: entry.asset,
      presence: "forbidden",
      role: `当前 v2 A/D/E 合同明确声明为画外或禁止入画：${entry.asset.forbid}`,
    }];
  })));
  for (const asset of unit.references) {
    if (matrix.some((items) => items.some((item) => item.asset.id === asset.id))) continue;
    const tokens = assetSemanticTokens(asset);
    const supportedPanelIndex = unit.visualExecutionPanels.findIndex((panel) => {
      const context = bindingPanelContext(unit, panel.index);
      return tokens.some((token) => duduTextIncludesSemanticToken(context, token));
    });
    if (supportedPanelIndex < 0) {
      throw new Error(`${unit.unitId} 的当前视觉执行/BindingSet 未给参考 ${asset.id} 提供逐格可见或连续性证据。`);
    }
    const context = bindingPanelContext(unit, supportedPanelIndex + 1);
    const offscreen = /画外|不入画|不出现/u.test(context);
    const lockedPanel = unit.panels[supportedPanelIndex]!;
    if (!assetSemanticTokens(asset).some((token) => duduTextIncludesSemanticToken(lockedPanel.sourceText, token))) {
      throw new Error(`${unit.unitId}-G${supportedPanelIndex + 1} 缺少可解释、唯一的 UTF-16 语义片段绑定 ${asset.id}；外部 BindingSet 不能替代锁版 span。`);
    }
    matrix[supportedPanelIndex]!.push({
      asset,
      presence: offscreen ? "forbidden" : "required",
      role: offscreen
        ? `当前 BindingSet 显式声明的画外/禁止入画资产：${asset.forbid}`
        : `当前 BindingSet 显式声明的可见参考：${asset.inherit}`,
    });
  }
  const selectedIds = new Set(matrix.flatMap((items) => items.map((item) => item.asset.id)));
  const allowedIds = new Set(unit.references.map((asset) => asset.id));
  const classifiedIds = new Set([
    ...unit.references.map((asset) => asset.id),
    ...unit.forbiddenReferences.map((entry) => entry.asset.id),
  ]);
  if (unit.references.some((asset) => !selectedIds.has(asset.id))
    || unit.forbiddenReferences.some((entry) => entry.panelIndexes.some((panelIndex) =>
      !matrix[panelIndex - 1]?.some((item) => item.asset.id === entry.asset.id && item.presence === "forbidden")))
    || [...selectedIds].some((assetId) => !classifiedIds.has(assetId))) {
    throw new Error(`${unit.unitId} 逐格 BindingSet 的正向/禁止资产并集未闭合当前外部 BindingSet。`);
  }
  for (const items of matrix) {
    const ids = items.map((item) => item.asset.id);
    if (new Set(ids).size !== ids.length
      || items.some((item) => item.presence === "forbidden" && allowedIds.has(item.asset.id)
        && duduReferencePresenceForPanel(unit.visualExecutionPanels[matrix.indexOf(items)]!, item.asset) !== "forbidden")) {
      throw new Error(`${unit.unitId} 逐格 BindingSet 出现重复或无依据的 forbidden 投影。`);
    }
  }
  return matrix;
}

async function ensureUnitAndPrompts(
  projectRoot: string,
  scriptRevision: StudioTextRevision,
  unit: DuduReadonlyUnitSource,
  visualExecutionSource: { absolutePath: string; sha256: string },
): Promise<Awaited<ReturnType<typeof getStudioProductionUnitSnapshot>>> {
  const matrix = panelAssetMatrix(unit);
  const promptRevisions: StudioTextRevision[] = [];
  for (const [offset, panel] of unit.panels.entries()) {
    const promptId = `dudu-${unit.unitId.toLowerCase()}-g${panel.index}-prompt`;
    promptRevisions.push(await ensureSingleTextRevision({
      projectRoot,
      kind: "prompt",
      documentId: promptId,
      title: `${unit.unitId}-G${panel.index} 只读冻结提示词`,
      body: buildPanelPrompt(unit, panel, unit.visualExecutionPanels[offset]!, matrix[offset]!),
      source: unit.binding?.file.absolutePath ?? visualExecutionSource.absolutePath,
      sourceVersion: digest({
        visualExecutionSha256: visualExecutionSource.sha256,
        bindingSha256: unit.binding?.file.sha256 ?? null,
        panelId: panel.id,
      }),
    }));
  }
  const panels: StudioProductionPanelInput[] = unit.panels.map((panel, offset) => {
    const visualPanel = unit.visualExecutionPanels[offset]!;
    return {
      id: panel.id,
      title: `${unit.unitId}-G${panel.index}`,
      visualAction: field(visualPanel, "动作", field(visualPanel, "构图")),
      shotComposition: [field(visualPanel, "景别"), field(visualPanel, "机位"), field(visualPanel, "构图")].join("；"),
      filmingMethod: field(visualPanel, "运镜", "固定机位"),
      dialogue: "",
      subtitle: "",
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
      durationSeconds: panel.durationSeconds,
      promptRevisionId: promptRevisions[offset]!.id,
      sourceSpans: [{ startOffsetUtf16: panel.sourceStartOffsetUtf16, endOffsetUtf16: panel.sourceEndOffsetUtf16 }],
      // 资产真相只进入已冻结 BindingSet；production panel 不建立平行资产投影。
      assets: [],
      transition: "硬切；严格按锁版格序衔接。",
      costumeState: visualCostumeState(visualPanel),
      sceneLighting: `${field(visualPanel, "光线")}；${field(visualPanel, "色彩")}`,
      shotType: "original",
      negativePrompt: "文字、字幕、格号、水印、UI、伪文字、身份漂移、错肢、跨格、未冻结主体",
    };
  });
  let snapshot = await getStudioProductionUnitSnapshot(projectRoot, unit.unitId);
  if (!snapshot) {
    snapshot = await createStudioProductionUnit(projectRoot, {
      id: unit.unitId,
      expectedRevision: 0,
      season: "S1",
      episode: "S1E1",
      sequence: unit.sequence,
      title: unit.title,
      durationSeconds: unit.durationSeconds,
      scriptRevisionId: scriptRevision.id,
      panels,
    });
  }
  if (snapshot.unit.revision !== 1 || snapshot.unit.season !== "S1" || snapshot.unit.episode !== "S1E1"
    || snapshot.unit.sequence !== unit.sequence || snapshot.unit.title !== unit.title
    || snapshot.unit.durationSeconds !== unit.durationSeconds || snapshot.unit.episodeStartSeconds !== unit.episodeStartSeconds
    || snapshot.unit.episodeEndSeconds !== unit.episodeEndSeconds || snapshot.unit.panelCount !== unit.panelCount
    || snapshot.scriptRevision.id !== scriptRevision.id || snapshot.scriptRevision.bodySha256 !== scriptRevision.bodySha256) {
    throw new Error(`${unit.unitId} 的 Studio 单元身份与只读来源冲突。`);
  }
  for (const [offset, panel] of snapshot.panels.entries()) {
    const expected = panels[offset]!;
    if (panel.id !== expected.id || panel.startSeconds !== expected.startSeconds || panel.endSeconds !== expected.endSeconds
      || panel.durationSeconds !== expected.durationSeconds || panel.promptRevisionId !== expected.promptRevisionId
      || panel.sourceSpans.length !== 1
      || panel.sourceSpans[0]!.startOffsetUtf16 !== unit.panels[offset]!.sourceStartOffsetUtf16
      || panel.sourceSpans[0]!.endOffsetUtf16 !== unit.panels[offset]!.sourceEndOffsetUtf16
      || stableJson({
        visualAction: panel.visualAction,
        shotComposition: panel.shotComposition,
        filmingMethod: panel.filmingMethod,
        dialogue: panel.dialogue,
        subtitle: panel.subtitle,
        assets: panel.assets,
        transition: panel.transition,
        costumeState: panel.costumeState,
        sceneLighting: panel.sceneLighting,
        shotType: panel.shotType,
        negativePrompt: panel.negativePrompt,
      }) !== stableJson({
        visualAction: expected.visualAction,
        shotComposition: expected.shotComposition,
        filmingMethod: expected.filmingMethod,
        dialogue: expected.dialogue ?? "",
        subtitle: expected.subtitle ?? "",
        assets: expected.assets,
        transition: expected.transition ?? "",
        costumeState: expected.costumeState ?? "",
        sceneLighting: expected.sceneLighting ?? "",
        shotType: expected.shotType ?? "original",
        negativePrompt: expected.negativePrompt ?? "",
      })) {
      throw new Error(`${unit.unitId}-G${offset + 1} 的 Studio 投影与只读来源冲突。`);
    }
  }
  return snapshot;
}

function mentionRanges(panel: DuduParsedPanel, items: DuduPanelBindingItem[]): Map<string, { text: string; start: number; end: number }> {
  const ranges = new Map<string, { text: string; start: number; end: number }>();
  const usedKeys = new Set<string>();
  const usedRanges = new Set<string>();
  for (const item of items) {
    const asset = item.asset;
    const semanticFallbacks = asset.sourceType === "style"
      ? ["色彩", "光线", "构图", "景别", "机位"]
      : asset.category === "scene"
        ? ["构图", "光线", "色彩", "机位", "景别"]
        : [];
    const candidates = [...assetSemanticTokens(asset), ...semanticFallbacks].flatMap((text) => {
      const range = duduFindSemanticTokenRange(panel.sourceText, text);
      return range ? [{ text, local: range.start }] : [];
    }).concat(item.presence === "forbidden"
      ? duduForbiddenRelationAnchorRanges(panel.sourceText, asset).map((entry) => ({ text: entry.text, local: entry.start }))
      : []);
    const selected = candidates.find((item) => {
      const key = `${asset.category}:${item.text.trim().toLocaleLowerCase("zh-CN")}`;
      return !usedKeys.has(key) && !usedRanges.has(`${item.local}:${item.local + item.text.length}`);
    });
    if (!selected) throw new Error(`${panel.id} 缺少可解释、唯一的 UTF-16 语义片段绑定 ${asset.id}。`);
    usedRanges.add(`${selected.local}:${selected.local + selected.text.length}`);
    usedKeys.add(`${asset.category}:${selected.text.trim().toLocaleLowerCase("zh-CN")}`);
    const start = panel.sourceStartOffsetUtf16 + selected.local;
    ranges.set(asset.id, { text: selected.text, start, end: start + selected.text.length });
  }
  return ranges;
}

export interface DuduReadonlyUnitProjectionAudit {
  unitId: string;
  panelCount: number;
  bindingSetCount: number;
  confirmedEmptyPanelIds: string[];
  selectedAssetIds: string[];
  forbiddenAssetIdsByPanelId: Record<string, string[]>;
  /** 可直接作为 execute_command/analyze_studio_script_entities.extractedMentions 的只读计划。 */
  extractedMentionsByPanelId: Record<string, Array<{
    assetId: string;
    surfaceText: string;
    startOffsetUtf16: number;
    endOffsetUtf16: number;
    category: DuduReferenceAsset["category"];
    presence: "required" | "optional" | "forbidden";
    role: string;
    candidateAssetIds: [string];
  }>>;
  mentionCount: number;
  promptBodyByPanelId: Record<string, string>;
  promptSha256ByPanelId: Record<string, string>;
}

/** 纯函数诊断：不访问 Studio、不写 CAS，仅证明逐格资产选择、script span 与视觉提示词闭包。 */
export function auditDuduReadonlyUnitProjection(unit: DuduReadonlyUnitSource): DuduReadonlyUnitProjectionAudit {
  if (!unit.binding) {
    return {
      unitId: unit.unitId,
      panelCount: unit.panelCount,
      bindingSetCount: 0,
      confirmedEmptyPanelIds: [],
      selectedAssetIds: [],
      forbiddenAssetIdsByPanelId: {},
      extractedMentionsByPanelId: {},
      mentionCount: 0,
      promptBodyByPanelId: {},
      promptSha256ByPanelId: {},
    };
  }
  const matrix = panelAssetMatrix(unit);
  const forbiddenAssetIdsByPanelId: Record<string, string[]> = {};
  const extractedMentionsByPanelId: DuduReadonlyUnitProjectionAudit["extractedMentionsByPanelId"] = {};
  const promptBodyByPanelId: Record<string, string> = {};
  const promptSha256ByPanelId: Record<string, string> = {};
  let mentionCount = 0;
  for (const [offset, panel] of unit.panels.entries()) {
    const items = matrix[offset]!;
    const ranges = mentionRanges(panel, items);
    if (ranges.size !== items.length) throw new Error(`${panel.id} mention 语义锚未闭合。`);
    mentionCount += ranges.size;
    extractedMentionsByPanelId[panel.id] = items.map((item) => {
      const range = ranges.get(item.asset.id)!;
      return {
        assetId: item.asset.id,
        surfaceText: range.text,
        startOffsetUtf16: range.start,
        endOffsetUtf16: range.end,
        category: item.asset.category,
        presence: item.presence,
        role: item.role,
        candidateAssetIds: [item.asset.id],
      };
    });
    const prompt = buildPanelPrompt(unit, panel, unit.visualExecutionPanels[offset]!, items);
    for (const exactAudioText of [field(panel, "对话", ""), field(panel, "旁白", "")].filter((value) => value && value !== "无")) {
      if (prompt.includes(exactAudioText)) throw new Error(`${panel.id} raw 视觉提示词泄漏精确对白/旁白。`);
    }
    forbiddenAssetIdsByPanelId[panel.id] = items.filter((item) => item.presence === "forbidden")
      .map((item) => item.asset.id).sort((left, right) => left.localeCompare(right, "en"));
    promptBodyByPanelId[panel.id] = prompt;
    promptSha256ByPanelId[panel.id] = sha256Text(prompt);
  }
  return {
    unitId: unit.unitId,
    panelCount: unit.panelCount,
    bindingSetCount: unit.panelCount,
    confirmedEmptyPanelIds: unit.panels.filter((_, offset) => matrix[offset]!.length === 0).map((panel) => panel.id),
    selectedAssetIds: [...new Set(matrix.flatMap((items) => items.map((item) => item.asset.id)))]
      .sort((left, right) => left.localeCompare(right, "en")),
    forbiddenAssetIdsByPanelId,
    extractedMentionsByPanelId,
    mentionCount,
    promptBodyByPanelId,
    promptSha256ByPanelId,
  };
}

async function bindingSourceSnapshot(
  projectRoot: string,
  detail: StudioCanonicalAssetDetail,
  target: Parameters<typeof evaluateStudioAssetApplicability>[1],
): Promise<StudioAssetBindingSourceSnapshot> {
  const definition = detail.definitionVersions.find((entry) => entry.id === detail.currentDefinitionVersionId);
  const authority = detail.authorityHistory.at(-1);
  const version = detail.versions.find((entry) => entry.id === detail.primaryAuthority?.versionId);
  const knowledge = await getStudioCanonicalAssetKnowledgeSnapshot(projectRoot, detail.id, target);
  if (!definition || !authority || !version || !knowledge || version.reviewStatus !== "approved") {
    throw new Error(`资产 ${detail.id} 缺少当前 definition/authority/knowledge 闭包。`);
  }
  return {
    assetId: detail.id,
    category: detail.category,
    assetRevision: detail.revision,
    definitionVersionId: definition.id,
    authorityEventId: authority.id,
    authorityVersionId: authority.versionId,
    assetVersionId: version.id,
    mediaSha256: version.mediaSha256,
    knowledgeFingerprint: knowledge.fingerprint,
    applicabilityFingerprint: digest(evaluateStudioAssetApplicability(definition.applicability, target)),
  };
}

type DuduContinuityState =
  | { status: "resolved"; value: string }
  | { status: "not-applicable"; reason: string };

function continuityState(fieldName: StudioContinuityField, panel: DuduParsedPanel, asset: DuduReferenceAsset): DuduContinuityState {
  const resolved = (value: string): DuduContinuityState => ({ status: "resolved", value });
  const notApplicable = (reason: string): DuduContinuityState => ({ status: "not-applicable", reason });
  if (asset.sourceType === "style") {
    switch (fieldName) {
      case "layout": return resolved(`画风参考仅约束构图质感；${field(panel, "构图")}`);
      case "lighting": return resolved(`画风参考仅约束光色质感；${field(panel, "光线")}；${field(panel, "色彩")}`);
      case "referenceSha256": return resolved(asset.sha256);
      default: return notApplicable("STYLE_ONLY 参考不声明角色、道具或空间实体状态");
    }
  }
  if (asset.category === "scene") {
    switch (fieldName) {
      case "position": return resolved(field(panel, "构图"));
      case "layout": return resolved(`${field(panel, "构图")}；${field(panel, "连续性")}`);
      case "lighting": return resolved(`${field(panel, "光线")}；${field(panel, "色彩")}`);
      case "referenceSha256": return resolved(asset.sha256);
      default: return notApplicable("场景参考不声明角色服装、伤势、持物、朝向或情绪");
    }
  }
  if (asset.category === "prop") {
    switch (fieldName) {
      case "heldObject": return resolved(`道具关系只按当前可视动作：${field(panel, "动作")}`);
      case "position": return resolved(field(panel, "构图"));
      case "layout": return resolved(`${field(panel, "构图")}；${field(panel, "连续性")}`);
      case "lighting": return resolved(`${field(panel, "光线")}；${field(panel, "色彩")}`);
      case "referenceSha256": return resolved(asset.sha256);
      default: return notApplicable("道具参考不声明角色服装、伤势、朝向或情绪");
    }
  }
  switch (fieldName) {
    case "costume": return resolved(`${asset.inherit}；VFX与身份分层；${field(panel, "连续性")}`);
    case "injury": return resolved(`来源未声明新伤势；保持批准参考且不得臆造变化。${asset.forbid}`);
    case "heldObject": return resolved(`只按当前可视动作判断持物：${field(panel, "动作")}`);
    case "position": return resolved(`${field(panel, "构图")}；${field(panel, "连续性")}`);
    case "facing": return resolved(`${field(panel, "机位")}；${field(panel, "构图")}`);
    case "emotion": return resolved(`${field(panel, "情绪")}；${field(panel, "表情")}；${field(panel, "表情细节")}`);
    case "layout": return resolved(`${field(panel, "构图")}；${field(panel, "连续性")}`);
    case "lighting": return resolved(`${field(panel, "光线")}；${field(panel, "色彩")}`);
    case "referenceSha256": return resolved(asset.sha256);
  }
}

async function ensureUnitBindingsAndContinuity(input: {
  projectRoot: string;
  projectId: string;
  unit: DuduReadonlyUnitSource;
  snapshot: NonNullable<Awaited<ReturnType<typeof getStudioProductionUnitSnapshot>>>;
  assetDetails: Map<string, StudioCanonicalAssetDetail>;
}): Promise<number> {
  if (!input.unit.binding) return 0;
  const matrix = panelAssetMatrix(input.unit);
  const continuityInputs: Parameters<typeof appendStudioContinuityObservations>[1] = [];
  let count = 0;
  for (const [offset, panel] of input.snapshot.panels.entries()) {
    const expectedItems = matrix[offset]!;
    const lockedPanel = input.unit.panels[offset]!;
    const visualPanel = input.unit.visualExecutionPanels[offset]!;
    const applicabilityTarget = {
      projectId: input.projectId,
      seasonId: "S1",
      episodeId: "S1E1",
      unitId: input.unit.unitId,
      unitLocalStartSeconds: panel.startSeconds,
      unitLocalEndSeconds: panel.endSeconds,
      episodeAbsoluteStartSeconds: input.unit.episodeStartSeconds + panel.startSeconds,
      episodeAbsoluteEndSeconds: input.unit.episodeStartSeconds + panel.endSeconds,
    };
    const sources = await Promise.all(expectedItems.map((item) =>
      bindingSourceSnapshot(input.projectRoot, input.assetDetails.get(item.asset.id)!, applicabilityTarget)));
    const ranges = mentionRanges(lockedPanel, expectedItems);
    const analysis = await analyzeStudioPanelAssetMentions(input.projectRoot, {
      unitId: input.unit.unitId,
      unitRevision: input.snapshot.unit.revision,
      unitFingerprint: input.snapshot.fingerprint,
      panelIndex: panel.index,
      scriptRevisionId: input.snapshot.scriptRevision.id,
      scriptSha256: input.snapshot.scriptRevision.bodySha256,
      expectedHeadRevision: 0,
      resolverVersion: "dudu-readonly-binding-v2",
      mentions: expectedItems.map((item) => {
        const range = ranges.get(item.asset.id)!;
        return {
          id: `dudu-${input.unit.unitId.toLowerCase()}-g${panel.index}-${item.asset.id}`,
          surfaceText: range.text,
          startOffsetUtf16: range.start,
          endOffsetUtf16: range.end,
          category: item.asset.category,
          presence: item.presence,
          role: item.role,
          modelSuggestions: [{ assetId: item.asset.id, category: item.asset.category, confidence: 1 }],
        };
      }),
      assets: expectedItems.map((item) => {
        const detail = input.assetDetails.get(item.asset.id)!;
        return { assetId: detail.id, category: detail.category, formalName: detail.name, aliases: detail.aliases };
      }),
    });
    if (analysis.proposals.length !== expectedItems.length) {
      throw new Error(`${input.unit.unitId}-G${panel.index} 提及分析未精确闭合。`);
    }
    let bindingSet;
    if (expectedItems.length === 0) {
      const confirmation = await confirmStudioPanelEntityClosureEmpty(input.projectRoot, {
        analysisId: analysis.id,
        expectedAnalysisHeadRevision: analysis.revision,
        expectedConfirmationHeadRevision: 0,
        reviewer: "codex",
        note: `已读取非空锁版 span、视觉执行 v2.1 与外部 BindingSet ${input.unit.binding.file.relativePath}；本格为纯黑/无可绑定实体。`,
      });
      bindingSet = await freezeStudioPanelAssetBindingSet(input.projectRoot, {
        analysisId: analysis.id,
        expectedAnalysisHeadRevision: analysis.revision,
        expectedBindingHeadRevision: 0,
        decisionReceiptIds: [],
        assetSources: [],
        emptyConfirmationId: confirmation.id,
      });
    } else {
      const decisions = [];
      for (const item of expectedItems) {
        const proposal = analysis.proposals.find((entry) => entry.mentionId.endsWith(`-${item.asset.id}`));
        if (!proposal) throw new Error(`${input.unit.unitId}-G${panel.index} 缺少 ${item.asset.id} 提案。`);
        decisions.push(await recordStudioMentionDecision(input.projectRoot, {
          receiptId: `dudu-decision-${input.unit.unitId.toLowerCase()}-g${panel.index}-${item.asset.id}`,
          proposalId: proposal.id,
          expectedAnalysisHeadRevision: analysis.revision,
          expectedDecisionHeadRevision: 0,
          action: "select",
          selectedAssetId: item.asset.id,
          presence: item.presence,
          role: item.role,
          reviewer: "codex-dudu-readonly-adapter",
          note: `外部 BindingSet ${input.unit.binding.file.relativePath} / ${input.unit.binding.file.sha256} 的显式映射。`,
        }));
      }
      bindingSet = await freezeStudioPanelAssetBindingSet(input.projectRoot, {
        analysisId: analysis.id,
        expectedAnalysisHeadRevision: analysis.revision,
        expectedBindingHeadRevision: 0,
        decisionReceiptIds: decisions.map((decision) => decision.id),
        assetSources: sources,
      });
    }
    const actual = new Map(bindingSet.bindings.map((binding) => [binding.assetId, binding]));
    const expectedSources = new Map(sources.map((source) => [source.assetId, source]));
    const expectedDecisionReceiptIds = expectedItems.map((item) =>
      `dudu-decision-${input.unit.unitId.toLowerCase()}-g${panel.index}-${item.asset.id}`);
    if (bindingSet.analysisId !== analysis.id
      || bindingSet.unitRevision !== input.snapshot.unit.revision || bindingSet.unitFingerprint !== input.snapshot.fingerprint
      || bindingSet.scriptRevisionId !== input.snapshot.scriptRevision.id
      || bindingSet.scriptSha256 !== input.snapshot.scriptRevision.bodySha256
      || bindingSet.promptRevisionId !== panel.promptRevisionId
      || bindingSet.promptSha256 !== panel.promptRevision.bodySha256
      || bindingSet.bindings.length !== expectedItems.length
      || bindingSet.confirmedEmpty !== (expectedItems.length === 0)
      || (expectedItems.length === 0 && !bindingSet.emptyConfirmationId)
      || (expectedItems.length > 0 && bindingSet.emptyConfirmationId !== undefined)
      || !sameStringSet(bindingSet.decisionReceiptIds, expectedDecisionReceiptIds)
      || bindingSet.unresolvedOptionalMentionIds.length !== 0
      || Object.keys(bindingSet.identityKeyFingerprints).length !== expectedItems.length
      || expectedItems.some((item) => {
        const binding = actual.get(item.asset.id);
        const source = expectedSources.get(item.asset.id)!;
        const mentionId = `dudu-${input.unit.unitId.toLowerCase()}-g${panel.index}-${item.asset.id}`;
        return !binding || binding.category !== item.asset.category || binding.presence !== item.presence
          || binding.role !== item.role || !sameStringSet(binding.mentionIds, [mentionId])
          || binding.mediaSha256 !== item.asset.sha256
          || binding.assetRevision !== source.assetRevision
          || binding.definitionVersionId !== source.definitionVersionId
          || binding.authorityEventId !== source.authorityEventId
          || binding.authorityVersionId !== source.authorityVersionId
          || binding.assetVersionId !== source.assetVersionId
          || binding.knowledgeFingerprint !== source.knowledgeFingerprint
          || binding.applicabilityFingerprint !== source.applicabilityFingerprint;
      })) {
      throw new Error(`${input.unit.unitId}-G${panel.index} BindingSet 与只读来源不精确一致。`);
    }
    count += 1;

    // 即使 BindingSet 已在中断前冻结，也补齐同一 owner 的幂等连续性写入。
    for (const item of expectedItems) {
      if (item.presence === "forbidden") continue;
      const scope = {
        kind: "panel" as const,
        scopeId: panel.id,
        unitId: input.unit.unitId,
        unitRevision: input.snapshot.unit.revision,
        startMilliseconds: Math.round(panel.startSeconds * 1_000),
        endMilliseconds: Math.round(panel.endSeconds * 1_000),
      };
      for (const fieldName of STUDIO_CONTINUITY_FIELDS) {
        const state = continuityState(fieldName, visualPanel, item.asset);
        continuityInputs.push({
          operationId: `dudu-continuity-${input.unit.unitId.toLowerCase()}-g${panel.index}-${item.asset.id}-${fieldName}`,
          expectedHeadRevision: 0,
          scope,
          subjectId: item.asset.id,
          field: fieldName,
          state: {
            ...state,
            provenance: [{
              kind: "dudu-readonly-binding",
              reference: input.unit.binding.file.relativePath,
              sourceFingerprint: input.unit.binding.file.sha256,
              note: `锁版剧本 ${input.snapshot.scriptRevision.bodySha256}；参考 ${item.asset.sha256}`,
            }],
          },
        });
      }
    }
  }
  if (continuityInputs.length > 0) await appendStudioContinuityObservations(input.projectRoot, continuityInputs);
  return count;
}

async function verifySourceUnchanged(
  input: DuduReadonlySourceInput,
  expected: DuduReadonlySourceInspection,
): Promise<DuduReadonlySourceInspection> {
  const current = await inspectDuduReadonlySources(input);
  if (current.sourceManifestFingerprint !== expected.sourceManifestFingerprint
    || current.productionScopeFingerprint !== expected.productionScopeFingerprint
    || current.contract.sha256 !== expected.contract.sha256
    || current.lockedScript.sha256 !== expected.lockedScript.sha256) {
    throw new Error("《嘟嘟》只读来源在 staging 导入期间发生漂移；工程保持未登记，禁止继续。 ");
  }
  return current;
}

async function buildImportReceipt(input: {
  shell: ProjectShell;
  inspection: DuduReadonlySourceInspection;
  intent: DuduReadonlyImportIntent;
  units: DuduReadonlyImportUnitReceipt[];
  bindingSetCount: number;
  detachedUnknowns: StudioDetachedGenerationUnknownObservation[];
}): Promise<DuduReadonlyImportReceipt> {
  const expectedBindingSetCount = input.inspection.units
    .filter((unit) => unit.binding)
    .reduce((total, unit) => total + unit.panelCount, 0);
  const expectedVideoManifestCount = input.inspection.units.filter((unit) => unit.historicalPass?.manifest).length;
  const [material, production, generation, listedUnits] = await Promise.all([
    getMaterialStudioState(input.shell.paths.root),
    getStudioProductionState(input.shell.paths.root),
    getStudioGenerationLedgerState(input.shell.paths.root),
    listStudioProductionUnits(input.shell.paths.root, { season: "S1", episode: "S1E1", limit: 100 }),
  ]);
  if (listedUnits.items.length !== 33 || listedUnits.nextCursor || production.counts.units !== 33
    || material.counts.canonicalAssets !== input.inspection.referenceAssets.length
    || material.counts.primaryAuthorities !== input.inspection.referenceAssets.length
    || input.bindingSetCount !== expectedBindingSetCount
    || generation.counts.packs !== 30 || generation.counts.targetExtensions !== 30
    || generation.counts.historicalImports !== 28
    || generation.counts.dispatches !== 0 || generation.counts.results !== 0
    || generation.counts.callIntents !== 0 || generation.counts.callEvents !== 0
    || generation.counts.plans !== 0 || generation.counts.runEvents !== 0
    || generation.counts.detachedUnknownObservations !== input.detachedUnknowns.length) {
    throw new Error(`Dudu staging 完整性计数未闭合：${JSON.stringify({ material: material.counts, production: production.counts, generation: generation.counts, bindingSetCount: input.bindingSetCount })}`);
  }
  const detachedContract = normalizeDetachedUnknownObservations(input.detachedUnknowns.map((item) => ({
    unitId: item.unitId,
    sourceTaskId: item.sourceTaskId,
    evidenceReference: item.evidenceReference,
    evidenceFingerprint: item.evidenceFingerprint,
    candidateSha256: item.candidateSha256 ?? undefined,
    candidateSizeBytes: item.candidateSizeBytes ?? undefined,
    candidateWidth: item.candidateWidth ?? undefined,
    candidateHeight: item.candidateHeight ?? undefined,
    note: item.note,
  })));
  if (stableJson(detachedContract) !== stableJson(input.intent.detachedUnknownObservations)) {
    throw new Error("Dudu detached unknown owner 记录与 import intent 合同不一致。 ");
  }
  const semantic: Omit<DuduReadonlyImportReceipt, "fingerprint" | "createdAt"> = {
    schemaVersion: 3,
    kind: "dudu-readonly-managed-import",
    projectId: input.shell.project.id,
    projectRoot: input.shell.paths.root,
    projectName: input.shell.project.name,
    managedManifestFingerprint: input.shell.manifestFingerprint,
    sourceProductionRoot: input.inspection.productionRoot,
    sourceLockedScriptPath: input.inspection.lockedScriptPath,
    sourceManifestFingerprint: input.inspection.sourceManifestFingerprint,
    productionScopeFingerprint: input.inspection.productionScopeFingerprint,
    contractSha256: input.inspection.contract.sha256,
    lockedScriptSha256: input.inspection.lockedScript.sha256,
    bootstrapClaimFingerprint: input.intent.bootstrapClaimFingerprint,
    importIntentFingerprint: input.intent.fingerprint,
    detachedUnknownContractFingerprint: detachedUnknownContractFingerprint(input.intent.detachedUnknownObservations),
    visualCanonRevisionSha256: input.inspection.visualCanonRevision.sha256,
    visualExecutionSha256: input.inspection.visualExecution.sha256,
    visualConflictDecisionSha256: input.inspection.visualConflictDecision.sha256,
    meteorVfxRuleSha256: input.inspection.meteorVfxRule.sha256,
    sourceFiles: input.inspection.sourceFiles.map((file) => ({ ...file })),
    mutableProjectionRelativePaths: [input.inspection.machineStateFile.relativePath],
    sourceFileCount: input.inspection.sourceFiles.length,
    sourceByteCount: input.inspection.sourceFiles.reduce((total, file) => total + file.sizeBytes, 0),
    ownerBaselineCounts: {
      material: { ...material.counts },
      production: { ...production.counts },
    },
    assetMappings: input.inspection.referenceAssets.map((asset) => ({
      assetId: asset.id,
      sourceType: asset.sourceType,
      studioCategory: asset.category,
      referenceRole: asset.referenceRole,
      sourceRelativePath: asset.relativePath,
      sourceSha256: asset.sha256,
    })),
    units: input.units,
    conflicts: input.inspection.conflicts,
    detachedUnknownObservationIds: input.detachedUnknowns.map((item) => item.observationId).sort((a, b) => a.localeCompare(b, "en")),
    counts: {
      units: 33,
      panels: 112,
      durationSeconds: 492,
      bindingSets: expectedBindingSetCount,
      unitGridPacks: 30,
      historicalImports: 28,
      videoManifests: expectedVideoManifestCount as 28,
      generationDispatches: 0,
      generationResults: 0,
      generationCallIntents: 0,
      generationCallEvents: 0,
      generationPlans: 0,
      generationRunEvents: 0,
    },
    registered: false,
    active: false,
  };
  const createdAt = new Date().toISOString();
  return { ...semantic, fingerprint: importReceiptFingerprint({ ...semantic, createdAt }), createdAt };
}

async function verifyDuduReadonlyOwnerClosure(input: {
  shell: ProjectShell;
  inspection: DuduReadonlySourceInspection;
  intent: DuduReadonlyImportIntent;
  receipt: DuduReadonlyImportReceipt;
}): Promise<void> {
  const expectedBindingSetCount = input.inspection.units
    .filter((unit) => unit.binding)
    .reduce((total, unit) => total + unit.panelCount, 0);
  const expectedCounts = {
    units: 33 as const,
    panels: 112 as const,
    durationSeconds: 492 as const,
    bindingSets: expectedBindingSetCount,
    unitGridPacks: 30 as const,
    historicalImports: 28 as const,
    videoManifests: 28 as const,
    generationDispatches: 0 as const,
    generationResults: 0 as const,
    generationCallIntents: 0 as const,
    generationCallEvents: 0 as const,
    generationPlans: 0 as const,
    generationRunEvents: 0 as const,
  };
  if (stableJson(input.receipt.counts) !== stableJson(expectedCounts)
    || stableJson(input.receipt.conflicts) !== stableJson(input.inspection.conflicts)
    || input.receipt.detachedUnknownContractFingerprint
      !== detachedUnknownContractFingerprint(input.intent.detachedUnknownObservations)) {
    throw new Error("Dudu import receipt 的动态计数/冲突裁决与当前来源不一致。 ");
  }
  const expectedAssetMappings = input.inspection.referenceAssets.map((asset) => ({
    assetId: asset.id,
    sourceType: asset.sourceType,
    studioCategory: asset.category,
    referenceRole: asset.referenceRole,
    sourceRelativePath: asset.relativePath,
    sourceSha256: asset.sha256,
  }));
  if (stableJson(input.receipt.assetMappings) !== stableJson(expectedAssetMappings)) {
    throw new Error("Dudu import receipt 的资产映射与当前 registry 不一致。 ");
  }

  const [material, production, generation, listedUnits, detached] = await Promise.all([
    getMaterialStudioState(input.shell.paths.root),
    getStudioProductionState(input.shell.paths.root),
    getStudioGenerationLedgerState(input.shell.paths.root),
    listStudioProductionUnits(input.shell.paths.root, { season: "S1", episode: "S1E1", limit: 100 }),
    listStudioDetachedGenerationUnknownObservations(input.shell.paths.root),
  ]);
  const actualDetachedContract = normalizeDetachedUnknownObservations(detached.map((item) => ({
    unitId: item.unitId,
    sourceTaskId: item.sourceTaskId,
    evidenceReference: item.evidenceReference,
    evidenceFingerprint: item.evidenceFingerprint,
    candidateSha256: item.candidateSha256 ?? undefined,
    candidateSizeBytes: item.candidateSizeBytes ?? undefined,
    candidateWidth: item.candidateWidth ?? undefined,
    candidateHeight: item.candidateHeight ?? undefined,
    note: item.note,
  })));
  if (material.counts.canonicalAssets !== input.inspection.referenceAssets.length
    || material.counts.primaryAuthorities !== input.inspection.referenceAssets.length
    || production.counts.units !== 33 || production.counts.panels !== 112
    || production.counts.assetBindingSets !== expectedBindingSetCount
    || listedUnits.items.length !== 33 || listedUnits.nextCursor
    || generation.counts.packs !== 30 || generation.counts.targetExtensions !== 30
    || generation.counts.historicalImports !== 28
    || generation.counts.dispatches !== 0 || generation.counts.results !== 0
    || generation.counts.callIntents !== 0 || generation.counts.callEvents !== 0
    || generation.counts.plans !== 0 || generation.counts.runEvents !== 0
    || generation.counts.detachedUnknownObservations !== detached.length
    || !sameStringSet(detached.map((item) => item.observationId), input.receipt.detachedUnknownObservationIds)
    || stableJson(actualDetachedContract) !== stableJson(input.intent.detachedUnknownObservations)
    || stableJson(material.counts) !== stableJson(input.receipt.ownerBaselineCounts.material)
    || stableJson(production.counts) !== stableJson(input.receipt.ownerBaselineCounts.production)) {
    throw new Error(`Dudu owner 总计数/零调用闭包无效：${JSON.stringify({ material: material.counts, production: production.counts, generation: generation.counts })}`);
  }

  const assetDetails = new Map<string, StudioCanonicalAssetDetail>();
  for (const asset of input.inspection.referenceAssets) {
    const detail = await getStudioCanonicalAsset(input.shell.paths.root, asset.id);
    if (!detail) throw new Error(`Dudu 规范资产缺失：${asset.id}`);
    const description = assetDescription(asset);
    const definition = detail.definitionVersions.find((entry) => entry.id === detail.currentDefinitionVersionId);
    const version = detail.versions.find((entry) => entry.id === detail.primaryAuthority?.versionId);
    const applicability = {
      projects: [input.shell.project.id],
      seasons: ["S1"],
      episodes: ["S1E1"],
      units: [],
      timeRanges: [],
      tags: ["dudu-readonly-import", `sourceType:${asset.sourceType}`, `referenceRole:${asset.referenceRole}`]
        .sort((left, right) => left.localeCompare(right, "en")),
    };
    if (!definition || !version || detail.definitionVersions.length !== 1 || detail.versions.length !== 1
      || detail.authorityHistory.length !== 1 || detail.category !== asset.category || detail.name !== asset.name
      || detail.description !== description || !sameStringSet(detail.aliases, asset.aliases)
      || !sameStringSet(definition.identityFeatures, [asset.inherit])
      || !sameStringSet(definition.positiveLocks, [asset.inherit, `权威媒体 SHA-256：${asset.sha256}`])
      || !sameStringSet(definition.negativeLocks, [asset.forbid])
      || definition.defaultPrompt !== `严格使用批准参考 ${asset.id}，${asset.inherit}；${asset.forbid}`
      || stableJson(definition.applicability) !== stableJson(applicability)
      || version.mediaSha256 !== asset.sha256 || version.reviewStatus !== "approved"
      || version.sourceNote !== `historical-authority-import:${asset.relativePath}:${asset.sha256}`
      || detail.primaryAuthority?.mediaSha256 !== asset.sha256) {
      throw new Error(`Dudu 规范资产闭包漂移：${asset.id}`);
    }
    await verifyImportedMediaOrigin(input.shell.paths.root, asset);
    assetDetails.set(asset.id, detail);
  }

  const receiptByUnit = new Map(input.receipt.units.map((unit) => [unit.unitId, unit]));
  if (receiptByUnit.size !== input.inspection.units.length) throw new Error("Dudu import receipt 含重复/缺失单元。 ");
  let verifiedBindingSets = 0;
  let verifiedVideoManifests = 0;
  for (const expectedUnit of input.inspection.units) {
    const unitReceipt = receiptByUnit.get(expectedUnit.unitId);
    const snapshot = await getStudioProductionUnitSnapshot(input.shell.paths.root, expectedUnit.unitId);
    if (!unitReceipt || !snapshot) throw new Error(`${expectedUnit.unitId} 缺少 receipt/production snapshot。`);
    if (unitReceipt.sequence !== expectedUnit.sequence || unitReceipt.durationSeconds !== expectedUnit.durationSeconds
      || unitReceipt.episodeStartSeconds !== expectedUnit.episodeStartSeconds
      || unitReceipt.episodeEndSeconds !== expectedUnit.episodeEndSeconds || unitReceipt.panelCount !== expectedUnit.panelCount
      || unitReceipt.bindingFormat !== (expectedUnit.binding?.format ?? null)
      || unitReceipt.bindingSha256 !== (expectedUnit.binding?.file.sha256 ?? null)
      || !sameStringSet(unitReceipt.referenceAssetIds, expectedUnit.references.map((asset) => asset.id))
      || unitReceipt.machinePreparationStatus !== String(expectedUnit.machineState.preparation_status ?? "UNKNOWN")
      || unitReceipt.machineStoryboardStatus !== String(expectedUnit.machineState.storyboard_status ?? "UNKNOWN")
      || unitReceipt.machineToolInvocationCount !== Number(expectedUnit.machineState.tool_invocation_count)
      || unitReceipt.machineVisualCandidateCount !== Number(expectedUnit.machineState.visual_candidate_count)
      || unitReceipt.historicalApprovedRawRelativePath !== (expectedUnit.historicalPass?.raw.relativePath ?? null)
      || unitReceipt.historicalApprovedRawSha256 !== (expectedUnit.historicalPass?.raw.sha256 ?? null)
      || snapshot.unit.revision !== 1 || snapshot.unit.sequence !== expectedUnit.sequence
      || snapshot.unit.durationSeconds !== expectedUnit.durationSeconds
      || snapshot.unit.episodeStartSeconds !== expectedUnit.episodeStartSeconds
      || snapshot.unit.episodeEndSeconds !== expectedUnit.episodeEndSeconds
      || snapshot.unit.panelCount !== expectedUnit.panelCount || snapshot.panels.length !== expectedUnit.panelCount
      || snapshot.scriptRevision.bodySha256 !== input.inspection.lockedScript.sha256) {
      throw new Error(`${expectedUnit.unitId} 单元/receipt 身份漂移。`);
    }
    const matrix = panelAssetMatrix(expectedUnit);
    const continuityChecks = expectedUnit.binding ? snapshot.panels.flatMap((panel, offset) =>
      matrix[offset]!.filter((item) => item.presence !== "forbidden").map((item) => ({
        key: JSON.stringify([panel.index, item.asset.id]),
        scope: {
          kind: "panel" as const,
          scopeId: panel.id,
          unitId: expectedUnit.unitId,
          unitRevision: snapshot.unit.revision,
          startMilliseconds: Math.round(panel.startSeconds * 1_000),
          endMilliseconds: Math.round(panel.endSeconds * 1_000),
        },
        subjectId: item.asset.id,
      }))) : [];
    const continuityTimelines = continuityChecks.length === 0 ? [] : await queryStudioContinuityTimelines(
      input.shell.paths.root,
      continuityChecks.map((check) => ({ scopeAnchor: check.scope, subjectId: check.subjectId })),
    );
    const continuityTimelineByKey = new Map(continuityChecks.map((check, index) => [
      check.key,
      continuityTimelines[index]!,
    ] as const));
    for (const [offset, panel] of snapshot.panels.entries()) {
      const sourcePanel = expectedUnit.panels[offset]!;
      const visualPanel = expectedUnit.visualExecutionPanels[offset]!;
      const expectedItems = matrix[offset]!;
      const expectedPrompt = buildPanelPrompt(expectedUnit, sourcePanel, visualPanel, expectedItems);
      const expectedPromptSource = expectedUnit.binding?.file.absolutePath ?? input.inspection.visualExecution.absolutePath;
      const expectedPromptSourceVersion = digest({
        visualExecutionSha256: input.inspection.visualExecution.sha256,
        bindingSha256: expectedUnit.binding?.file.sha256 ?? null,
        panelId: sourcePanel.id,
      });
      if (panel.id !== sourcePanel.id || panel.startSeconds !== sourcePanel.startSeconds
        || panel.endSeconds !== sourcePanel.endSeconds || panel.durationSeconds !== sourcePanel.durationSeconds
        || panel.visualAction !== field(visualPanel, "动作", field(visualPanel, "构图"))
        || panel.shotComposition !== [field(visualPanel, "景别"), field(visualPanel, "机位"), field(visualPanel, "构图")].join("；")
        || panel.filmingMethod !== field(visualPanel, "运镜", "固定机位")
        || panel.dialogue !== "" || panel.subtitle !== "" || panel.assets.length !== 0
        || panel.transition !== "硬切；严格按锁版格序衔接。"
        || panel.costumeState !== visualCostumeState(visualPanel)
        || panel.sceneLighting !== `${field(visualPanel, "光线")}；${field(visualPanel, "色彩")}`
        || panel.shotType !== "original"
        || panel.negativePrompt !== "文字、字幕、格号、水印、UI、伪文字、身份漂移、错肢、跨格、未冻结主体"
        || panel.sourceSpans.length !== 1
        || panel.sourceSpans[0]!.startOffsetUtf16 !== sourcePanel.sourceStartOffsetUtf16
        || panel.sourceSpans[0]!.endOffsetUtf16 !== sourcePanel.sourceEndOffsetUtf16
        || panel.promptRevision.body !== expectedPrompt || panel.promptRevision.bodySha256 !== sha256Text(expectedPrompt)
        || panel.promptRevision.source !== expectedPromptSource
        || panel.promptRevision.sourceVersion !== expectedPromptSourceVersion) {
        throw new Error(`${expectedUnit.unitId}-G${panel.index} production/prompt 投影漂移。`);
      }
      const bindingSet = await getCurrentStudioPanelAssetBindingSet(input.shell.paths.root, expectedUnit.unitId, panel.index);
      if (!expectedUnit.binding) {
        if (bindingSet) throw new Error(`${expectedUnit.unitId}-G${panel.index} 无外部 Binding 却存在 Studio BindingSet。`);
        continue;
      }
      if (!bindingSet || bindingSet.bindings.length !== expectedItems.length
        || bindingSet.unitRevision !== snapshot.unit.revision || bindingSet.unitFingerprint !== snapshot.fingerprint
        || bindingSet.scriptRevisionId !== snapshot.scriptRevision.id
        || bindingSet.scriptSha256 !== snapshot.scriptRevision.bodySha256
        || bindingSet.promptRevisionId !== panel.promptRevisionId
        || bindingSet.promptSha256 !== panel.promptRevision.bodySha256
        || bindingSet.confirmedEmpty !== (expectedItems.length === 0)
        || (expectedItems.length === 0 && !bindingSet.emptyConfirmationId)
        || (expectedItems.length > 0 && bindingSet.emptyConfirmationId !== undefined)
        || bindingSet.unresolvedOptionalMentionIds.length !== 0
        || Object.keys(bindingSet.identityKeyFingerprints).length !== expectedItems.length
        || !sameStringSet(bindingSet.decisionReceiptIds, expectedItems.map((item) =>
          `dudu-decision-${expectedUnit.unitId.toLowerCase()}-g${panel.index}-${item.asset.id}`))) {
        throw new Error(`${expectedUnit.unitId}-G${panel.index} BindingSet 形态不闭合。`);
      }
      const actualBindings = new Map(bindingSet.bindings.map((binding) => [binding.assetId, binding]));
      for (const item of expectedItems) {
        const actual = actualBindings.get(item.asset.id);
        const mentionId = `dudu-${expectedUnit.unitId.toLowerCase()}-g${panel.index}-${item.asset.id}`;
        if (!actual || actual.category !== item.asset.category || actual.presence !== item.presence
          || actual.role !== item.role || !sameStringSet(actual.mentionIds, [mentionId])
          || actual.mediaSha256 !== item.asset.sha256) {
          throw new Error(`${expectedUnit.unitId}-G${panel.index} Binding ${item.asset.id} 漂移。`);
        }
        if (item.presence === "forbidden") continue;
        const scope = {
          kind: "panel" as const,
          scopeId: panel.id,
          unitId: expectedUnit.unitId,
          unitRevision: snapshot.unit.revision,
          startMilliseconds: Math.round(panel.startSeconds * 1_000),
          endMilliseconds: Math.round(panel.endSeconds * 1_000),
        };
        const timeline = continuityTimelineByKey.get(JSON.stringify([panel.index, item.asset.id]));
        if (!timeline) throw new Error(`${expectedUnit.unitId}-G${panel.index}/${item.asset.id} 缺少批量连续性投影。`);
        const readiness = createStudioContinuityReadiness({
          scope,
          subjectId: item.asset.id,
          requiredFields: [...STUDIO_CONTINUITY_FIELDS],
          currentEntries: timeline.items.map((timelineItem) => timelineItem.entry),
          openConflicts: timeline.openConflicts,
        });
        if (!readiness.ready || readiness.currentEntryIds.length !== STUDIO_CONTINUITY_FIELDS.length) {
          throw new Error(`${expectedUnit.unitId}-G${panel.index}/${item.asset.id} 九字段连续性未闭合：${readiness.blockers.map((blocker) => blocker.code).join(",")}`);
        }
      }
      verifiedBindingSets += 1;
    }

    if (expectedUnit.binding) {
      if (!unitReceipt.packId || !unitReceipt.packFingerprint) throw new Error(`${expectedUnit.unitId} 缺少 unit-grid pack receipt。`);
      const historicalContinuationWaiver = await duduReadonlyContinuationWaiver(
        input.shell.paths.root,
        expectedUnit,
        input.inspection.sourceManifestFingerprint,
      );
      const [persisted, queried] = await Promise.all([
        readStudioUnitGridGenerationFrozenPack(input.shell.paths.root, unitReceipt.packId),
        queryStudioUnitGridGenerationFreeze(input.shell.paths.root, {
          targetKind: "unit-grid",
          unitId: expectedUnit.unitId,
          ...(historicalContinuationWaiver
            ? { verifiedHistoricalImportContinuationWaiver: historicalContinuationWaiver }
            : {}),
        }),
      ]);
      if (!persisted || persisted.fingerprint !== unitReceipt.packFingerprint || queried.status !== "ready"
        || queried.packId !== unitReceipt.packId || queried.fingerprint !== unitReceipt.packFingerprint) {
        throw new Error(`${expectedUnit.unitId} persisted/current unit-grid pack 漂移。`);
      }
    } else if (unitReceipt.packId !== null || unitReceipt.packFingerprint !== null) {
      throw new Error(`${expectedUnit.unitId} 无 Binding 却登记了 generation pack。`);
    }

    if (expectedUnit.historicalPass) {
      verifiedVideoManifests += 1;
      if (!unitReceipt.historicalImportId || !unitReceipt.packId
        || unitReceipt.historicalManifestSha256 !== expectedUnit.historicalPass.manifest.sha256
        || unitReceipt.videoPackStatus !== expectedUnit.historicalPass.videoPackStatus
        || unitReceipt.i2vReadiness !== expectedUnit.historicalPass.i2vReadiness) {
        throw new Error(`${expectedUnit.unitId} 历史视频包 receipt 漂移。`);
      }
      const [raw, labeled, evidence] = await Promise.all([
        verifyImportedMediaOrigin(input.shell.paths.root, expectedUnit.historicalPass.raw),
        verifyImportedMediaOrigin(input.shell.paths.root, expectedUnit.historicalPass.labeled),
        readStudioHistoricalGenerationEvidenceByPack(input.shell.paths.root, unitReceipt.packId),
      ]);
      if (!evidence || evidence.importId !== unitReceipt.historicalImportId
        || evidence.packFingerprint !== unitReceipt.packFingerprint || evidence.unitId !== expectedUnit.unitId
        || evidence.generationCallCount !== 0 || evidence.generationRunId !== null || evidence.provider !== null || evidence.callId !== null
        || evidence.raw.mediaSha256 !== raw.sha256 || evidence.raw.sourceSha256 !== expectedUnit.historicalPass.raw.sha256
        || evidence.labeled.mediaSha256 !== labeled.sha256 || evidence.labeled.sourceSha256 !== expectedUnit.historicalPass.labeled.sha256
        || evidence.review.evidenceReference !== expectedUnit.historicalPass.qc.relativePath
        || evidence.review.evidenceSha256 !== expectedUnit.historicalPass.qc.sha256
        || evidence.review.externalStoryboardStatus !== expectedUnit.historicalPass.externalStoryboardStatus
        || evidence.sourceManifestFingerprint !== input.inspection.sourceManifestFingerprint) {
        throw new Error(`${expectedUnit.unitId} historical-import/CAS/QC 闭包漂移。`);
      }
    } else if (unitReceipt.historicalImportId !== null || unitReceipt.historicalManifestSha256 !== null
      || unitReceipt.i2vReadiness !== null || unitReceipt.videoPackStatus !== "NOT_AVAILABLE") {
      throw new Error(`${expectedUnit.unitId} 非历史 PASS 单元出现历史证据 receipt。`);
    }
  }
  if (verifiedBindingSets !== expectedBindingSetCount || verifiedVideoManifests !== 28) {
    throw new Error(`Dudu owner 逐项验证计数未闭合：bindings=${verifiedBindingSets}/${expectedBindingSetCount},video=${verifiedVideoManifests}/28`);
  }
}

async function verifyDuduReadonlyProjectClosure(
  projectRoot: string,
  source: DuduReadonlySourceInput,
  registrationPolicy: "must-be-unregistered" | "allow-exact-registration",
): Promise<{ receipt: DuduReadonlyImportReceipt; inspection: DuduReadonlySourceInspection }> {
  const shell = await inspectManagedProject(projectRoot);
  const [claim, intentValue, receiptValue] = await Promise.all([
    readManagedProjectBootstrapClaim(shell.paths.root),
    readJsonFile<DuduReadonlyImportIntent>(path.join(shell.paths.root, INTENT_RELATIVE_PATH)),
    readJsonFile<DuduReadonlyImportReceipt>(path.join(shell.paths.root, RECEIPT_RELATIVE_PATH)),
  ]);
  if (!claim || !intentValue) throw new Error("Dudu staging 缺少 bootstrap claim/import intent 完整身份链。 ");
  const intent = validateIntent(intentValue);
  if (!receiptValue) throw new Error("Dudu staging 尚无完整 import receipt。 ");
  const receipt = validateImportReceipt(receiptValue);
  const inspection = await inspectDuduReadonlySources(source);
  assertDuduBootstrapClaim(claim, inspection, shell.paths.root, intent.detachedUnknownObservations);
  if (intent.projectId !== shell.project.id || intent.projectRoot !== shell.paths.root
    || intent.managedManifestFingerprint !== shell.manifestFingerprint
    || intent.sourceProductionRoot !== inspection.productionRoot
    || intent.sourceLockedScriptPath !== inspection.lockedScriptPath
    || intent.sourceManifestFingerprint !== inspection.sourceManifestFingerprint
    || intent.productionScopeFingerprint !== inspection.productionScopeFingerprint
    || intent.contractSha256 !== inspection.contract.sha256
    || intent.lockedScriptSha256 !== inspection.lockedScript.sha256
    || intent.bootstrapClaimFingerprint !== claim.fingerprint
    || receipt.bootstrapClaimFingerprint !== claim.fingerprint
    || receipt.importIntentFingerprint !== intent.fingerprint
    || receipt.detachedUnknownContractFingerprint
      !== detachedUnknownContractFingerprint(intent.detachedUnknownObservations)
    || receipt.projectId !== shell.project.id || receipt.projectRoot !== shell.paths.root
    || receipt.managedManifestFingerprint !== shell.manifestFingerprint
    || receipt.sourceProductionRoot !== inspection.productionRoot
    || receipt.sourceLockedScriptPath !== inspection.lockedScriptPath
    || receipt.sourceManifestFingerprint !== inspection.sourceManifestFingerprint
    || receipt.productionScopeFingerprint !== inspection.productionScopeFingerprint
    || receipt.contractSha256 !== inspection.contract.sha256 || receipt.lockedScriptSha256 !== inspection.lockedScript.sha256
    || receipt.visualCanonRevisionSha256 !== inspection.visualCanonRevision.sha256
    || receipt.visualExecutionSha256 !== inspection.visualExecution.sha256
    || receipt.visualConflictDecisionSha256 !== inspection.visualConflictDecision.sha256
    || receipt.meteorVfxRuleSha256 !== inspection.meteorVfxRule.sha256
    || stableJson(receipt.sourceFiles) !== stableJson(inspection.sourceFiles)
    || stableJson(receipt.mutableProjectionRelativePaths) !== stableJson([inspection.machineStateFile.relativePath])
    || receipt.sourceFileCount !== inspection.sourceFiles.length
    || receipt.sourceByteCount !== inspection.sourceFiles.reduce((total, file) => total + file.sizeBytes, 0)
    || receipt.units.length !== inspection.units.length) {
    throw new Error("Dudu import receipt 与当前 managed/source 身份不一致。 ");
  }
  const registry = await listRegisteredProjects();
  const sameRoot = registry.filter((project) => path.resolve(project.primaryRoot) === shell.paths.root);
  const sameId = registry.filter((project) => project.id === shell.project.id);
  if (sameRoot.some((project) => project.id !== shell.project.id)
    || sameId.some((project) => path.resolve(project.primaryRoot) !== shell.paths.root)
    || sameRoot.length > 1 || sameId.length > 1) {
    throw new Error("Dudu managed project 与注册表存在 root/id 双向身份冲突。 ");
  }
  if (registrationPolicy === "must-be-unregistered" && (sameRoot.length !== 0 || sameId.length !== 0)) {
    throw new Error("staging 验证期工程已提前登记，违反最后一步激活合同。 ");
  }
  const [generation, detached] = await Promise.all([
    getStudioGenerationLedgerState(shell.paths.root),
    listStudioDetachedGenerationUnknownObservations(shell.paths.root),
  ]);
  if (generation.counts.packs !== 30 || generation.counts.historicalImports !== 28
    || generation.counts.dispatches !== 0 || generation.counts.results !== 0
    || generation.counts.callIntents !== 0 || generation.counts.callEvents !== 0
    || generation.counts.plans !== 0 || generation.counts.runEvents !== 0
    || detached.length !== receipt.detachedUnknownObservationIds.length) {
    throw new Error("Dudu staging generation 零调用闭包与 import receipt 不一致。 ");
  }
  for (const unit of receipt.units.filter((item) => item.historicalImportId)) {
    const evidence = await readStudioHistoricalGenerationEvidenceByPack(shell.paths.root, unit.packId!);
    if (!evidence || evidence.importId !== unit.historicalImportId || evidence.generationCallCount !== 0
      || evidence.generationRunId !== null || evidence.provider !== null || evidence.callId !== null) {
      throw new Error(`${unit.unitId} historical-import 零调用证据漂移。`);
    }
  }
  await verifyDuduReadonlyOwnerClosure({ shell, inspection, intent, receipt });
  return { receipt, inspection };
}

export async function verifyDuduReadonlyStagingProject(
  projectRoot: string,
  source: DuduReadonlySourceInput,
): Promise<{ receipt: DuduReadonlyImportReceipt; inspection: DuduReadonlySourceInspection }> {
  return verifyDuduReadonlyProjectClosure(projectRoot, source, "must-be-unregistered");
}

function isResumableDuduStageDiscovery(discovery: DuduReadonlyImportDiscovery): boolean {
  return discovery.status === "none"
    || (discovery.status === "single"
      && discovery.candidates.length === 1
      && (discovery.candidates[0]!.controlStatus === "staging-incomplete"
        || discovery.candidates[0]!.controlStatus === "staging-verified"));
}

async function assertDuduStageDiscoveryInsideOwnerLock(
  projectsRoot: string,
  expectedFingerprint: string | undefined,
): Promise<DuduReadonlyImportDiscovery | null> {
  if (!expectedFingerprint) return null;
  let discovery: DuduReadonlyImportDiscovery;
  try {
    discovery = await discoverDuduReadonlyImportProjects(projectsRoot);
  } catch (error) {
    throw new DuduReadonlyControlConflictError(
      `Dudu staging 在 owner 锁内重读发现集失败：${error instanceof Error ? error.message : String(error)}`,
      { expectedFingerprint },
    );
  }
  if (discovery.fingerprint !== expectedFingerprint || !isResumableDuduStageDiscovery(discovery)) {
    throw new DuduReadonlyControlConflictError(
      "Dudu staging 在 owner 锁内发现候选集或 owner 阶段已变化；禁止恢复 orphan、选择候选或继续写入。",
      { expectedFingerprint, currentFingerprint: discovery.fingerprint },
    );
  }
  return discovery;
}

export async function stageDuduReadonlyManagedProject(
  input: StageDuduReadonlyManagedProjectInput,
  options: DuduReadonlyCommandExecutionOptions = {},
): Promise<StageDuduReadonlyManagedProjectResult> {
  const projectsRoot = await canonicalProjectsRoot(input.projectsRoot);
  const detachedUnknownObservations = normalizeDetachedUnknownObservations(input.detachedUnknownObservations);
  // P30 只允许一个《嘟嘟》owner。固定 projectsRoot 级锁覆盖所有 source 身份，
  // 避免两个不同来源各自拿到 source-key lock 后并行创建两个受管真相源。
  return withFileLock(path.join(projectsRoot, ".aicanvas-dudu-stage-locks"), "dudu-owner-mutation", async () => {
  // 必须是 owner 锁内的第一个业务读；在它之前不读 source、不恢复 bootstrap、不初始化工程。
  const lockedDiscovery = await assertDuduStageDiscoveryInsideOwnerLock(
    projectsRoot,
    options.expectedDiscoveryFingerprint,
  );
  const inspection = await inspectDuduReadonlySources(input.source);
  const staged = await discoverOrCreateStagingProject(
    projectsRoot,
    input.source,
    inspection,
    detachedUnknownObservations,
  );
  const shell = staged.shell;
  const [registryBefore, activeBefore] = await Promise.all([listRegisteredProjects(), getActiveProjectState()]);
  const registeredRootBefore = registryBefore.filter((project) => path.resolve(project.primaryRoot) === shell.paths.root);
  const registeredIdBefore = registryBefore.filter((project) => project.id === shell.project.id);
  if (registeredRootBefore.length > 0 || registeredIdBefore.length > 0
    || (activeBefore && path.resolve(activeBefore.primaryRoot) === shell.paths.root)) {
    const currentDiscovery = await discoverDuduReadonlyImportProjects(projectsRoot).catch(() => null);
    throw new DuduReadonlyControlConflictError(
      "Dudu staging 在完整验证前已登记/激活或出现 projectId 复用，拒绝继续写入。",
      {
        expectedFingerprint: options.expectedDiscoveryFingerprint ?? lockedDiscovery?.fingerprint,
        ...(currentDiscovery ? { currentFingerprint: currentDiscovery.fingerprint } : {}),
      },
    );
  }
  const existingReceipt = await readJsonFile<DuduReadonlyImportReceipt>(path.join(shell.paths.root, RECEIPT_RELATIVE_PATH));
  if (existingReceipt) {
    const verified = await verifyDuduReadonlyStagingProject(shell.paths.root, input.source);
    if (options.commandRequestHash) {
      await ensureCommandOperationReceipt(shell.paths.root, {
        command: "stage_dudu_readonly_managed_project",
        commandRequestHash: options.commandRequestHash,
        projectId: shell.project.id,
        projectRoot: shell.paths.root,
        importFingerprint: verified.receipt.fingerprint,
        registrationFingerprint: null,
        activationId: null,
        activationFingerprint: null,
      });
    }
    return { shell, inspection: verified.inspection, receipt: verified.receipt, replayed: true };
  }

  const scriptRevision = await ensureSingleTextRevision({
    projectRoot: shell.paths.root,
    kind: "script",
    documentId: "dudu-s1e1-locked-script",
    title: "《嘟嘟》S1E1 锁版剧本",
    body: inspection.lockedScript.body,
    source: inspection.lockedScript.absolutePath,
    sourceVersion: inspection.lockedScript.sha256,
  });
  const profile = await getStudioProductionContractProfile(shell.paths.root, { season: "S1", episode: "S1E1" })
    ?? await createStudioProductionContractProfile(shell.paths.root, {
      profileId: "dudu-s1e1-reference-policy-v2",
      season: "S1",
      episode: "S1E1",
      minControlReferences: 1,
      maxControlReferences: 5,
      sourceFingerprint: inspection.contract.sha256,
      expectedRevision: 0,
    });
  if (profile.minControlReferences !== 1 || profile.maxControlReferences !== 5
    || profile.sourceFingerprint !== inspection.contract.sha256) {
    throw new Error("Dudu production contract profile 与唯一长期合同冲突。 ");
  }

  const assetDetails = new Map<string, StudioCanonicalAssetDetail>();
  for (const asset of inspection.referenceAssets) {
    assetDetails.set(asset.id, await ensureReferenceAsset(shell.paths.root, shell.project.id, asset));
  }

  const snapshots = new Map<string, NonNullable<Awaited<ReturnType<typeof getStudioProductionUnitSnapshot>>>>();
  for (const unit of inspection.units) {
    const snapshot = await ensureUnitAndPrompts(shell.paths.root, scriptRevision, unit, inspection.visualExecution);
    if (!snapshot) throw new Error(`${unit.unitId} Studio snapshot 未创建。`);
    snapshots.set(unit.unitId, snapshot);
  }
  let bindingSetCount = 0;
  for (const unit of inspection.units) {
    bindingSetCount += await ensureUnitBindingsAndContinuity({
      projectRoot: shell.paths.root,
      projectId: shell.project.id,
      unit,
      snapshot: snapshots.get(unit.unitId)!,
      assetDetails,
    });
  }

  const packByUnit = new Map<string, Awaited<ReturnType<typeof freezeAndPersistStudioUnitGridGenerationPack>>>();
  for (const unit of inspection.units.filter((item) => item.binding)) {
    const historicalContinuationWaiver = await duduReadonlyContinuationWaiver(
      shell.paths.root,
      unit,
      inspection.sourceManifestFingerprint,
    );
    packByUnit.set(unit.unitId, await freezeAndPersistStudioUnitGridGenerationPack(shell.paths.root, {
      targetKind: "unit-grid",
      unitId: unit.unitId,
      ...(historicalContinuationWaiver
        ? { verifiedHistoricalImportContinuationWaiver: historicalContinuationWaiver }
        : {}),
    }));
  }

  const unitReceipts: DuduReadonlyImportUnitReceipt[] = [];
  for (const unit of inspection.units) {
    const pack = packByUnit.get(unit.unitId);
    let historicalImportId: string | null = null;
    if (unit.historicalPass) {
      if (!pack) throw new Error(`${unit.unitId} 历史 PASS 缺少 unit-grid pack。`);
      const [raw, labeled] = await Promise.all([
        ensureImportedMediaOrigin(shell.paths.root, unit.historicalPass.raw),
        ensureImportedMediaOrigin(shell.paths.root, unit.historicalPass.labeled),
      ]);
      const historical = await importStudioHistoricalGenerationEvidence(shell.paths.root, {
        packId: pack.packId,
        packFingerprint: pack.fingerprint,
        rawMediaSha256: raw.sha256,
        labeledMediaSha256: labeled.sha256,
        sourceRawSha256: unit.historicalPass.raw.sha256,
        sourceLabeledSha256: unit.historicalPass.labeled.sha256,
        sourceManifestFingerprint: inspection.sourceManifestFingerprint,
        qcEvidenceReference: unit.historicalPass.qc.relativePath,
        qcEvidenceSha256: unit.historicalPass.qc.sha256,
        externalStoryboardStatus: unit.historicalPass.externalStoryboardStatus,
      });
      historicalImportId = historical.importId;
    }
    unitReceipts.push({
      unitId: unit.unitId,
      sequence: unit.sequence,
      durationSeconds: unit.durationSeconds,
      episodeStartSeconds: unit.episodeStartSeconds,
      episodeEndSeconds: unit.episodeEndSeconds,
      panelCount: unit.panelCount,
      bindingFormat: unit.binding?.format ?? null,
      bindingSha256: unit.binding?.file.sha256 ?? null,
      referenceAssetIds: unit.references.map((asset) => asset.id),
      packId: pack?.packId ?? null,
      packFingerprint: pack?.fingerprint ?? null,
      historicalImportId,
      historicalManifestSha256: unit.historicalPass?.manifest.sha256 ?? null,
      videoPackStatus: unit.historicalPass?.videoPackStatus ?? "NOT_AVAILABLE",
      i2vReadiness: unit.historicalPass?.i2vReadiness ?? null,
      machinePreparationStatus: String(unit.machineState.preparation_status ?? "UNKNOWN"),
      machineStoryboardStatus: String(unit.machineState.storyboard_status ?? "UNKNOWN"),
      machineToolInvocationCount: Number(unit.machineState.tool_invocation_count),
      machineVisualCandidateCount: Number(unit.machineState.visual_candidate_count),
      historicalApprovedRawRelativePath: unit.historicalPass?.raw.relativePath ?? null,
      historicalApprovedRawSha256: unit.historicalPass?.raw.sha256 ?? null,
    });
  }

  const detachedUnknowns: StudioDetachedGenerationUnknownObservation[] = [];
  for (const observation of detachedUnknownObservations) {
    const snapshot = snapshots.get(observation.unitId);
    if (!snapshot) throw new Error(`detached unknown observation 指向范围外单元：${observation.unitId}`);
    detachedUnknowns.push(await recordStudioDetachedGenerationUnknownObservation(shell.paths.root, {
      unitId: observation.unitId,
      sourceTaskId: observation.sourceTaskId,
      evidenceReference: observation.evidenceReference,
      evidenceFingerprint: observation.evidenceFingerprint,
      ...(observation.candidateSha256 ? { candidateSha256: observation.candidateSha256 } : {}),
      ...(observation.candidateSizeBytes ? { candidateSizeBytes: observation.candidateSizeBytes } : {}),
      ...(observation.candidateWidth ? { candidateWidth: observation.candidateWidth } : {}),
      ...(observation.candidateHeight ? { candidateHeight: observation.candidateHeight } : {}),
      ...(observation.note ? { note: observation.note } : {}),
      unitRevision: snapshot.unit.revision,
      unitFingerprint: snapshot.fingerprint,
    }));
  }

  const finalInspection = await verifySourceUnchanged(input.source, inspection);
  const receipt = await buildImportReceipt({
    shell,
    inspection: finalInspection,
    intent: staged.intent,
    units: unitReceipts,
    bindingSetCount,
    detachedUnknowns,
  });
  await writeImmutableJson(shell.paths.root, RECEIPT_RELATIVE_PATH, receipt);
  const verified = await verifyDuduReadonlyStagingProject(shell.paths.root, input.source);
  if (options.commandRequestHash) {
    await ensureCommandOperationReceipt(shell.paths.root, {
      command: "stage_dudu_readonly_managed_project",
      commandRequestHash: options.commandRequestHash,
      projectId: shell.project.id,
      projectRoot: shell.paths.root,
      importFingerprint: verified.receipt.fingerprint,
      registrationFingerprint: null,
      activationId: null,
      activationFingerprint: null,
    });
  }
  return { shell, inspection: verified.inspection, receipt: verified.receipt, replayed: false };
  }, { timeoutMs: 30_000, staleMs: 2 * 60 * 60 * 1_000, confinementRoot: projectsRoot });
}

/** bootstrap 写命令与普通工程 command ledger 分离，但仍由 execute_command 持有唯一幂等账本。 */
export async function resolveDuduReadonlyImportCommandRoot(projectsRoot: string): Promise<string> {
  return path.join(await canonicalProjectsRoot(projectsRoot), ".aicanvas-dudu-import-transactions");
}

function duduReadonlyStageOutcome(
  shell: ProjectShell,
  receipt: DuduReadonlyImportReceipt,
  replayed: boolean,
): DuduReadonlyStageCommandOutcome {
  return {
    schemaVersion: 1,
    kind: "dudu-readonly-stage-command-outcome",
    directoryName: path.basename(shell.paths.root),
    projectId: shell.project.id,
    managedManifestFingerprint: shell.manifestFingerprint,
    importFingerprint: receipt.fingerprint,
    sourceManifestFingerprint: receipt.sourceManifestFingerprint,
    productionScopeFingerprint: receipt.productionScopeFingerprint,
    contractSha256: receipt.contractSha256,
    counts: receipt.counts,
    replayed,
  };
}

export function summarizeDuduReadonlyStageResult(
  result: StageDuduReadonlyManagedProjectResult,
  replayed = result.replayed,
): DuduReadonlyStageCommandOutcome {
  return duduReadonlyStageOutcome(result.shell, result.receipt, replayed);
}

export function duduReadonlySourceRequestMatchesReceipt(
  inspection: DuduReadonlySourceInspection,
  receipt: DuduReadonlyImportReceipt,
): boolean {
  if (inspection.productionRoot !== receipt.sourceProductionRoot
    || inspection.lockedScriptPath !== receipt.sourceLockedScriptPath
    || inspection.lockedScript.sha256 !== receipt.lockedScriptSha256
    || inspection.contract.sha256 !== receipt.contractSha256
    || inspection.visualCanonRevision.sha256 !== receipt.visualCanonRevisionSha256
    || inspection.visualExecution.sha256 !== receipt.visualExecutionSha256
    || inspection.visualConflictDecision.sha256 !== receipt.visualConflictDecisionSha256
    || inspection.meteorVfxRule.sha256 !== receipt.meteorVfxRuleSha256
    || inspection.machineStateFile.relativePath !== receipt.mutableProjectionRelativePaths[0]) {
    return false;
  }
  const frozenByIdentity = new Map(receipt.sourceFiles.map((file) => [
    `${file.scope}\0${file.relativePath}`,
    file,
  ]));
  for (const file of [
    inspection.lockedScript,
    inspection.contract,
    inspection.visualCanonRevision,
    inspection.visualExecution,
    inspection.visualConflictDecision,
    inspection.meteorVfxRule,
    inspection.referenceRegistryFile,
  ]) {
    const frozen = frozenByIdentity.get(`${file.scope}\0${file.relativePath}`);
    if (!frozen || frozen.sha256 !== file.sha256 || frozen.sizeBytes !== file.sizeBytes) return false;
  }
  return true;
}

/**
 * command-bus 崩溃恢复只读证明：只接受唯一 claim 候选，并重新验证其
 * managed/claim/intent/receipt/owner/source 闭包；不续跑 staging、不登记或激活。
 */
export async function proveDuduReadonlyStageCommandOutcome(
  input: StageDuduReadonlyManagedProjectInput,
  commandRequestHash: string,
): Promise<DuduReadonlyStageCommandOutcome | null> {
  try {
    const discovery = await discoverDuduReadonlyImportProjects(input.projectsRoot);
    if (discovery.status !== "single" || discovery.candidates.length !== 1) return null;
    const candidate = discovery.candidates[0]!;
    const [verified, inspection] = await Promise.all([
      verifyDuduImmutableImportIdentity(candidate.projectRoot, true),
      inspectDuduReadonlySources(input.source),
    ]);
    const operationReceipt = await readCommandOperationReceipt(
      verified.shell.paths.root,
      "stage_dudu_readonly_managed_project",
      commandRequestHash,
    );
    const detachedUnknownObservations = normalizeDetachedUnknownObservations(input.detachedUnknownObservations);
    if (!operationReceipt
      || operationReceipt.projectId !== verified.shell.project.id
      || operationReceipt.importFingerprint !== verified.receipt.fingerprint
      || !duduReadonlySourceRequestMatchesReceipt(inspection, verified.receipt)
      || detachedUnknownContractFingerprint(verified.intent.detachedUnknownObservations)
        !== detachedUnknownContractFingerprint(detachedUnknownObservations)
      || verified.receipt.detachedUnknownContractFingerprint
        !== detachedUnknownContractFingerprint(detachedUnknownObservations)) {
      return null;
    }
    return duduReadonlyStageOutcome(verified.shell, verified.receipt, true);
  } catch {
    return null;
  }
}

/**
 * command-bus 终态 locator 恢复的纯读 owner。不接收 locator 中的工程路径或计数：
 * 只从 projectsRoot 直接子目录的唯一 operation receipt 候选，结合不可变
 * import receipt 重建完整结果。多候选或任一 owner 身份不闭合均失败关闭。
 */
export async function readDuduReadonlyStageOutcomeByOperationId(
  projectsRoot: string,
  commandRequestHash: string,
): Promise<DuduReadonlyStageCommandOutcome | null> {
  const discovery = await discoverDuduReadonlyImportProjects(projectsRoot);
  const matches: DuduReadonlyStageCommandOutcome[] = [];
  for (const candidate of discovery.candidates) {
    const operationReceipt = await readCommandOperationReceipt(
      candidate.projectRoot,
      "stage_dudu_readonly_managed_project",
      commandRequestHash,
    );
    if (!operationReceipt) continue;
    const verified = await verifyDuduImmutableImportIdentity(candidate.projectRoot, true);
    if (operationReceipt.projectId !== verified.shell.project.id
      || operationReceipt.projectRoot !== verified.shell.paths.root
      || operationReceipt.importFingerprint !== verified.receipt.fingerprint
      || candidate.directoryName !== path.basename(verified.shell.paths.root)
      || path.dirname(verified.shell.paths.root) !== path.resolve(discovery.projectsRoot)) {
      throw new Error("Dudu stage operation receipt 与不可变 import owner 身份不一致。");
    }
    matches.push(duduReadonlyStageOutcome(verified.shell, verified.receipt, true));
  }
  if (matches.length > 1) {
    throw new Error("Dudu stage operationId 命中多个 owner 候选，拒绝选择任意工程。");
  }
  return matches[0] ?? null;
}

function registrationFingerprint(value: Omit<DuduReadonlyRegistrationReceipt, "fingerprint">): string {
  return digest(value);
}

function validateRegistrationReceipt(value: DuduReadonlyRegistrationReceipt): DuduReadonlyRegistrationReceipt {
  if (!value || value.schemaVersion !== 2 || value.kind !== "dudu-readonly-managed-registration"
    || value.registered !== true || typeof value.createdAt !== "string") {
    throw new Error("Dudu registration receipt 格式无效或仍是会虚报 active 的旧 schema。 ");
  }
  return assertFingerprintRecord(value, registrationFingerprint, "Dudu registration receipt");
}

function activationFingerprint(value: Omit<DuduReadonlyActivationReceipt, "fingerprint">): string {
  return digest(value);
}

function validateActivationReceipt(value: DuduReadonlyActivationReceipt): DuduReadonlyActivationReceipt {
  if (!value || value.schemaVersion !== 1 || value.kind !== "dudu-readonly-managed-activation"
    || value.active !== true || typeof value.createdAt !== "string"
    || !/^[a-f0-9-]{16,64}$/u.test(value.activationId)) {
    throw new Error("Dudu activation receipt 格式无效。 ");
  }
  return assertFingerprintRecord(value, activationFingerprint, "Dudu activation receipt");
}

function activationReceiptRelativePath(activationId: string): string {
  if (!/^[a-f0-9-]{16,64}$/u.test(activationId)) throw new Error("Dudu activationId 格式无效。 ");
  return path.posix.join(ACTIVATION_RECEIPT_RELATIVE_ROOT, `${activationId}.json`);
}

async function assertNoRegisteredDuduSourceDuplicate(
  registry: Array<{ id: string; primaryRoot: string }>,
  shell: ProjectShell,
  _receipt: DuduReadonlyImportReceipt,
): Promise<void> {
  for (const project of registry) {
    const candidateRoot = path.resolve(project.primaryRoot);
    if (candidateRoot === shell.paths.root && project.id === shell.project.id) continue;
    const candidateValue = await readJsonFile<DuduReadonlyImportReceipt>(path.join(candidateRoot, RECEIPT_RELATIVE_PATH));
    if (!candidateValue) continue;
    validateImportReceipt(candidateValue);
    throw new Error(`已有另一 Dudu owner 登记到受管工程，禁止建立平行真相源：${candidateRoot}`);
  }
}

async function hasDuduPostRegistrationGenerationRecordsReadOnly(
  shell: ProjectShell,
): Promise<boolean> {
  const snapshot = await openSqliteReadOnlySnapshot(shell.paths.generationDatabase, "Dudu generation DB");
  try {
    const db = snapshot.database;
    const dynamicCounts = [
      "studio_generation_dispatches",
      "studio_generation_results",
      "studio_generation_call_intents",
      "studio_generation_call_events",
      "studio_generation_plans",
      "studio_generation_run_events",
    ].map((table) => Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count));
    const packCount = Number((db.prepare(
      "SELECT COUNT(*) AS count FROM studio_generation_packs",
    ).get() as { count: number }).count);
    const targetCount = Number((db.prepare(
      "SELECT COUNT(*) AS count FROM studio_generation_pack_targets",
    ).get() as { count: number }).count);
    return dynamicCounts.some((count) => count > 0) || packCount > 30 || targetCount > 30;
  } finally {
    await snapshot.close();
  }
}

/**
 * 已注册 owner 在正式生产后被切走再切回时，sidecar 会产生新的 activationId。
 * 该恢复路径只补当前 activationId 的不可变 receipt：不注册、不切换活动工程、
 * 不重跑 staging，也不使用导入期“generation 必须零调用”的断言。
 *
 * 返回 null 表示仍应走首次 finalize 路径；只要检测到已注册且已有动态 generation
 * 记录，任何 registry/active/source/import/registration 不闭合都会失败关闭。
 */
async function tryFinalizeDuduPostRegistrationReactivation(
  projectRoot: string,
  source: DuduReadonlySourceInput,
  options: DuduReadonlyCommandExecutionOptions,
): Promise<DuduReadonlyFinalizationResult | null> {
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const registrationValue = await readJsonFile<DuduReadonlyRegistrationReceipt>(path.join(
    shell.paths.root,
    REGISTRATION_RELATIVE_PATH,
  ));
  // 注册和当前活动指针已闭合但 activation receipt 丢失时，恢复只依赖冻结的
  // claim→intent→receipt 与实时机器投影；不能因外部生产根后续新增 PASS/raw
  // 而退回首次 staging 的整包 source manifest 校验。
  if (!registrationValue || !(await hasDuduPostRegistrationGenerationRecordsReadOnly(shell))) return null;

  const registration = validateRegistrationReceipt(registrationValue);
  const [registryBefore, activeBefore, inspection, verified] = await Promise.all([
    listRegisteredProjects(),
    getActiveProjectStateReadOnly(),
    inspectDuduReadonlySources(source),
    verifyDuduImmutableImportIdentity(shell.paths.root, true),
  ]);
  const sameRootBefore = registryBefore.filter((project) => path.resolve(project.primaryRoot) === shell.paths.root);
  const sameIdBefore = registryBefore.filter((project) => project.id === shell.project.id);
  if (sameRootBefore.length !== 1 || sameIdBefore.length !== 1
    || sameRootBefore[0]!.id !== shell.project.id
    || sameRootBefore[0]!.primaryRoot !== sameIdBefore[0]!.primaryRoot) {
    throw new Error("Dudu post-registration activation 恢复时 registry root/id 身份未精确闭合。 ");
  }
  if (!activeBefore || path.resolve(activeBefore.primaryRoot) !== shell.paths.root) {
    throw new Error("Dudu post-registration activation 恢复只允许当前活动指针已精确命中；禁止隐式切换工程。 ");
  }
  if (registration.projectId !== shell.project.id
    || registration.projectRoot !== shell.paths.root
    || registration.importFingerprint !== verified.receipt.fingerprint) {
    throw new Error("Dudu post-registration activation 恢复时 registration/import 身份不一致。 ");
  }
  // 身份级闸口：source 冻结身份（路径 + 冻结 SHA）必须与不可变 import receipt 逐项一致；
  // 即便文件内容相同，只要身份路径不同也失败关闭（不做整包 source manifest 校验）。
  if (!duduReadonlySourceRequestMatchesReceipt(inspection, verified.receipt)) {
    throw new Error("Dudu post-registration activation 恢复请求的 source 与不可变 import receipt 不一致。 ");
  }
  await assertNoRegisteredDuduSourceDuplicate(registryBefore, shell, verified.receipt);

  const activationRelativePath = activationReceiptRelativePath(activeBefore.activationId);
  const existingActivation = await readJsonFile<DuduReadonlyActivationReceipt>(path.join(
    shell.paths.root,
    activationRelativePath,
  ));
  let activation: DuduReadonlyActivationReceipt;
  let replayedActivation = Boolean(existingActivation);
  if (existingActivation) {
    activation = validateActivationReceipt(existingActivation);
  } else {
    // 写入前再读一次 registry/active/registration，关闭验证到落盘之间的身份切换。
    const [registryAtWrite, activeAtWrite, registrationAtWriteValue] = await Promise.all([
      listRegisteredProjects(),
      getActiveProjectStateReadOnly(),
      readJsonFile<DuduReadonlyRegistrationReceipt>(path.join(shell.paths.root, REGISTRATION_RELATIVE_PATH)),
    ]);
    const sameRootAtWrite = registryAtWrite.filter((project) => path.resolve(project.primaryRoot) === shell.paths.root);
    const sameIdAtWrite = registryAtWrite.filter((project) => project.id === shell.project.id);
    const registrationAtWrite = registrationAtWriteValue
      ? validateRegistrationReceipt(registrationAtWriteValue)
      : null;
    if (sameRootAtWrite.length !== 1 || sameIdAtWrite.length !== 1
      || sameRootAtWrite[0]!.id !== shell.project.id
      || !activeAtWrite || path.resolve(activeAtWrite.primaryRoot) !== shell.paths.root
      || activeAtWrite.activationId !== activeBefore.activationId
      || !registrationAtWrite || registrationAtWrite.fingerprint !== registration.fingerprint) {
      throw new Error("Dudu post-registration activation receipt 落盘前 registry/active/registration 身份发生变化。 ");
    }
    await assertNoRegisteredDuduSourceDuplicate(registryAtWrite, shell, verified.receipt);
    const semantic: Omit<DuduReadonlyActivationReceipt, "fingerprint" | "createdAt"> = {
      schemaVersion: 1,
      kind: "dudu-readonly-managed-activation",
      projectId: shell.project.id,
      projectRoot: shell.paths.root,
      importFingerprint: verified.receipt.fingerprint,
      registrationFingerprint: registration.fingerprint,
      active: true,
      activationId: activeBefore.activationId,
    };
    const createdAt = new Date().toISOString();
    const receipt: DuduReadonlyActivationReceipt = {
      ...semantic,
      fingerprint: activationFingerprint({ ...semantic, createdAt }),
      createdAt,
    };
    await writeImmutableJson(shell.paths.root, activationRelativePath, receipt);
    const landed = await readJsonFile<DuduReadonlyActivationReceipt>(path.join(
      shell.paths.root,
      activationRelativePath,
    ));
    if (!landed) throw new Error("Dudu post-registration activation receipt 未落盘。 ");
    activation = validateActivationReceipt(landed);
    replayedActivation = false;
  }

  if (activation.projectId !== shell.project.id || activation.projectRoot !== shell.paths.root
    || activation.importFingerprint !== verified.receipt.fingerprint
    || activation.registrationFingerprint !== registration.fingerprint
    || activation.activationId !== activeBefore.activationId) {
    throw new Error("Dudu post-registration activation receipt 与当前不可变身份不一致。 ");
  }

  const [registryAfter, activeAfter, registrationAfterValue, activationAfterValue] = await Promise.all([
    listRegisteredProjects(),
    getActiveProjectStateReadOnly(),
    readJsonFile<DuduReadonlyRegistrationReceipt>(path.join(shell.paths.root, REGISTRATION_RELATIVE_PATH)),
    readJsonFile<DuduReadonlyActivationReceipt>(path.join(shell.paths.root, activationRelativePath)),
  ]);
  const sameRootAfter = registryAfter.filter((project) => path.resolve(project.primaryRoot) === shell.paths.root);
  const sameIdAfter = registryAfter.filter((project) => project.id === shell.project.id);
  const registrationAfter = registrationAfterValue ? validateRegistrationReceipt(registrationAfterValue) : null;
  const activationAfter = activationAfterValue ? validateActivationReceipt(activationAfterValue) : null;
  if (sameRootAfter.length !== 1 || sameIdAfter.length !== 1 || sameRootAfter[0]!.id !== shell.project.id
    || !activeAfter || path.resolve(activeAfter.primaryRoot) !== shell.paths.root
    || activeAfter.activationId !== activation.activationId
    || !registrationAfter || registrationAfter.fingerprint !== registration.fingerprint
    || !activationAfter || activationAfter.fingerprint !== activation.fingerprint) {
    throw new Error("Dudu post-registration activation receipt 落盘后的实时闭包无效。 ");
  }
  await assertNoRegisteredDuduSourceDuplicate(registryAfter, shell, verified.receipt);

  const result: DuduReadonlyFinalizationResult = {
    schemaVersion: 1,
    kind: "dudu-readonly-managed-finalization",
    projectId: shell.project.id,
    projectRoot: shell.paths.root,
    importFingerprint: verified.receipt.fingerprint,
    registered: true,
    active: true,
    activationId: activation.activationId,
    registration,
    activation,
    replayedRegistration: true,
    replayedActivation,
  };
  if (options.commandRequestHash) {
    await ensureCommandOperationReceipt(shell.paths.root, {
      command: "finalize_dudu_readonly_managed_project",
      commandRequestHash: options.commandRequestHash,
      projectId: shell.project.id,
      projectRoot: shell.paths.root,
      importFingerprint: verified.receipt.fingerprint,
      registrationFingerprint: registration.fingerprint,
      activationId: activation.activationId,
      activationFingerprint: activation.fingerprint,
    });
  }
  return result;
}

/**
 * 只有 staging receipt 和实时 owner 状态全部通过后才允许调用。注册与激活是最后一步；
 * 本函数不参与默认 stage 流，防止半导入工程污染当前活动项目。
 */
export async function finalizeDuduReadonlyManagedProject(
  projectRoot: string,
  source: DuduReadonlySourceInput,
  options: DuduReadonlyCommandExecutionOptions = {},
): Promise<DuduReadonlyFinalizationResult> {
  const initialShell = await inspectManagedProjectReadOnly(projectRoot);
  const projectsRoot = await canonicalProjectsRoot(path.dirname(initialShell.paths.root));
  return withFileLock(path.join(projectsRoot, ".aicanvas-dudu-stage-locks"), "dudu-owner-mutation", async () => {
  const discovery = await discoverDuduReadonlyImportProjects(projectsRoot);
  if (discovery.status !== "single" || discovery.candidates.length !== 1
    || discovery.candidates[0]!.projectRoot !== initialShell.paths.root) {
    throw new Error("Dudu finalize 要求 projectsRoot 中恰有当前一个候选；冲突状态禁止选择第一个。 ");
  }
  return withProjectLock(initialShell.paths.root, "dudu-readonly-finalize", async () => {
  const reactivationRecovery = await tryFinalizeDuduPostRegistrationReactivation(
    initialShell.paths.root,
    source,
    options,
  );
  if (reactivationRecovery) return reactivationRecovery;
  const verified = await verifyDuduReadonlyProjectClosure(projectRoot, source, "allow-exact-registration");
  const shell = await inspectManagedProject(projectRoot);
  const existingRegistration = await readJsonFile<DuduReadonlyRegistrationReceipt>(path.join(shell.paths.root, REGISTRATION_RELATIVE_PATH));
  let registration = existingRegistration ? validateRegistrationReceipt(existingRegistration) : null;
  let replayedRegistration = Boolean(registration);
  if (registration && (registration.projectId !== shell.project.id
    || registration.projectRoot !== shell.paths.root
    || registration.importFingerprint !== verified.receipt.fingerprint)) {
    throw new Error("Dudu registration receipt 与当前 managed/import 身份不一致。 ");
  }

  let registry = await listRegisteredProjects();
  let sameRoot = registry.filter((project) => path.resolve(project.primaryRoot) === shell.paths.root);
  let sameId = registry.filter((project) => project.id === shell.project.id);
  if (sameRoot.some((project) => project.id !== shell.project.id)
    || sameId.some((project) => path.resolve(project.primaryRoot) !== shell.paths.root)
    || sameRoot.length > 1 || sameId.length > 1) {
    throw new Error("Dudu 工程注册 root/id 双向身份冲突。 ");
  }
  await assertNoRegisteredDuduSourceDuplicate(registry, shell, verified.receipt);
  if (sameRoot.length === 0 && sameId.length === 0) {
    await registerProjectGuarded(shell.project, async (current) => {
      const guardedSameRoot = current.filter((project) => path.resolve(project.primaryRoot) === shell.paths.root);
      const guardedSameId = current.filter((project) => project.id === shell.project.id);
      if (guardedSameRoot.length !== 0 || guardedSameId.length !== 0) {
        throw new Error("Dudu 工程在登记锁内出现 root/id 并发冲突。 ");
      }
      await assertNoRegisteredDuduSourceDuplicate(current, shell, verified.receipt);
    });
    registry = await listRegisteredProjects();
    sameRoot = registry.filter((project) => path.resolve(project.primaryRoot) === shell.paths.root);
    sameId = registry.filter((project) => project.id === shell.project.id);
  }
  await assertNoRegisteredDuduSourceDuplicate(registry, shell, verified.receipt);
  if (sameRoot.length !== 1 || sameId.length !== 1 || sameRoot[0]!.id !== shell.project.id) {
    throw new Error("Dudu 工程登记后身份未闭合。 ");
  }

  if (!registration) {
    const semantic: Omit<DuduReadonlyRegistrationReceipt, "fingerprint" | "createdAt"> = {
      schemaVersion: 2,
      kind: "dudu-readonly-managed-registration",
      projectId: shell.project.id,
      projectRoot: shell.paths.root,
      importFingerprint: verified.receipt.fingerprint,
      registered: true,
    };
    const createdAt = new Date().toISOString();
    const receipt: DuduReadonlyRegistrationReceipt = {
      ...semantic,
      fingerprint: registrationFingerprint({ ...semantic, createdAt }),
      createdAt,
    };
    await writeImmutableJson(shell.paths.root, REGISTRATION_RELATIVE_PATH, receipt);
    const landed = await readJsonFile<DuduReadonlyRegistrationReceipt>(path.join(shell.paths.root, REGISTRATION_RELATIVE_PATH));
    if (!landed) throw new Error("Dudu registration receipt 未落盘。 ");
    registration = validateRegistrationReceipt(landed);
    replayedRegistration = false;
  }

  let active = await getActiveProjectState();
  if (!active || path.resolve(active.primaryRoot) !== shell.paths.root) {
    await activateProject(shell.paths.root);
    active = await getActiveProjectState();
  }
  if (!active || path.resolve(active.primaryRoot) !== shell.paths.root) throw new Error("Dudu 工程激活后活动指针未闭合。 ");

  const activationRelativePath = activationReceiptRelativePath(active.activationId);
  const existingActivation = await readJsonFile<DuduReadonlyActivationReceipt>(path.join(shell.paths.root, activationRelativePath));
  let replayedActivation = Boolean(existingActivation);
  let activation: DuduReadonlyActivationReceipt;
  if (existingActivation) {
    activation = validateActivationReceipt(existingActivation);
  } else {
    const semantic: Omit<DuduReadonlyActivationReceipt, "fingerprint" | "createdAt"> = {
      schemaVersion: 1,
      kind: "dudu-readonly-managed-activation",
      projectId: shell.project.id,
      projectRoot: shell.paths.root,
      importFingerprint: verified.receipt.fingerprint,
      registrationFingerprint: registration.fingerprint,
      active: true,
      activationId: active.activationId,
    };
    const createdAt = new Date().toISOString();
    const receipt: DuduReadonlyActivationReceipt = {
      ...semantic,
      fingerprint: activationFingerprint({ ...semantic, createdAt }),
      createdAt,
    };
    await writeImmutableJson(shell.paths.root, activationRelativePath, receipt);
    const landed = await readJsonFile<DuduReadonlyActivationReceipt>(path.join(shell.paths.root, activationRelativePath));
    if (!landed) throw new Error("Dudu activation receipt 未落盘。 ");
    activation = validateActivationReceipt(landed);
    replayedActivation = false;
  }
  if (activation.projectId !== shell.project.id || activation.projectRoot !== shell.paths.root
    || activation.importFingerprint !== verified.receipt.fingerprint
    || activation.registrationFingerprint !== registration.fingerprint
    || activation.activationId !== active.activationId) {
    throw new Error("Dudu activation receipt 与当前 managed/import/registration 身份不一致。 ");
  }

  const landedRegistration = await readJsonFile<DuduReadonlyRegistrationReceipt>(path.join(shell.paths.root, REGISTRATION_RELATIVE_PATH));
  const landedActivation = await readJsonFile<DuduReadonlyActivationReceipt>(path.join(shell.paths.root, activationRelativePath));
  const currentActive = await getActiveProjectState();
  const currentRegistry = await listRegisteredProjects();
  const currentRoot = currentRegistry.filter((project) => path.resolve(project.primaryRoot) === shell.paths.root);
  const currentId = currentRegistry.filter((project) => project.id === shell.project.id);
  if (!landedRegistration || !landedActivation
    || validateRegistrationReceipt(landedRegistration).fingerprint !== registration.fingerprint
    || validateActivationReceipt(landedActivation).fingerprint !== activation.fingerprint
    || currentRoot.length !== 1 || currentId.length !== 1 || currentRoot[0]!.id !== shell.project.id
    || !currentActive || path.resolve(currentActive.primaryRoot) !== shell.paths.root
    || currentActive.activationId !== activation.activationId) {
    throw new Error("Dudu registration/activation receipts 落盘后的实时闭包无效。 ");
  }
  const result: DuduReadonlyFinalizationResult = {
    schemaVersion: 1,
    kind: "dudu-readonly-managed-finalization",
    projectId: shell.project.id,
    projectRoot: shell.paths.root,
    importFingerprint: verified.receipt.fingerprint,
    registered: true,
    active: true,
    activationId: currentActive.activationId,
    registration,
    activation,
    replayedRegistration,
    replayedActivation,
  };
  if (options.commandRequestHash) {
    await ensureCommandOperationReceipt(shell.paths.root, {
      command: "finalize_dudu_readonly_managed_project",
      commandRequestHash: options.commandRequestHash,
      projectId: shell.project.id,
      projectRoot: shell.paths.root,
      importFingerprint: verified.receipt.fingerprint,
      registrationFingerprint: registration.fingerprint,
      activationId: activation.activationId,
      activationFingerprint: activation.fingerprint,
    });
  }
  return result;
  }, { timeoutMs: 30_000, staleMs: 2 * 60 * 60 * 1_000 });
  }, { timeoutMs: 30_000, staleMs: 2 * 60 * 60 * 1_000, confinementRoot: projectsRoot });
}

function receiptSourceManifestFingerprint(sourceFiles: DuduSourceFileIdentity[]): string {
  return digest(sourceFiles.map((file) => ({
    scope: file.scope,
    relativePath: file.relativePath,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
  })).sort((left, right) => `${left.scope}:${left.relativePath}`.localeCompare(`${right.scope}:${right.relativePath}`, "en")));
}

async function verifyPersistedSourceIdentity(
  receipt: DuduReadonlyImportReceipt,
  file: DuduSourceFileIdentity,
  verifyContent: boolean,
): Promise<void> {
  const expectedPath = file.scope === "locked-source"
    ? receipt.sourceLockedScriptPath
    : path.join(receipt.sourceProductionRoot, ...file.relativePath.split("/"));
  if ((file.scope !== "locked-source" && file.scope !== "production-root")
    || !file.relativePath || path.posix.isAbsolute(file.relativePath)
    || path.posix.normalize(file.relativePath) !== file.relativePath
    || file.relativePath === ".." || file.relativePath.startsWith("../")
    || file.absolutePath !== expectedPath
    || !/^[a-f0-9]{64}$/u.test(file.sha256)
    || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1) {
    throw new Error(`Dudu receipt source file 身份无效：${file.relativePath}`);
  }
  const pathBefore = await lstat(expectedPath, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size < 1n
    || await realpath(expectedPath) !== expectedPath) {
    throw new Error(`Dudu 冻结来源文件类型/大小/路径漂移：${file.relativePath}`);
  }
  if (verifyContent && pathBefore.size !== BigInt(file.sizeBytes)) {
    throw new Error(`Dudu 冻结来源文件大小漂移：${file.relativePath}`);
  }
  const handle = await open(expectedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n
      || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino
      || pathBefore.size !== before.size || pathBefore.mtimeNs !== before.mtimeNs) {
      throw new Error(`Dudu 冻结来源文件打开前路径漂移：${file.relativePath}`);
    }
    let actualSha256: string | null = null;
    if (verifyContent) {
      const hash = createHash("sha256");
      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) hash.update(chunk as Buffer);
      actualSha256 = hash.digest("hex");
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(expectedPath, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino
      || pathAfter.size !== before.size || pathAfter.mtimeNs !== before.mtimeNs
      || !pathAfter.isFile() || pathAfter.isSymbolicLink()
      || (verifyContent && actualSha256 !== file.sha256)
      || await realpath(expectedPath) !== expectedPath) {
      throw new Error(`Dudu 冻结来源文件内容漂移：${file.relativePath}`);
    }
  } finally {
    await handle.close();
  }
}

async function verifyPersistedSourceIdentities(
  receipt: DuduReadonlyImportReceipt,
  sourceIdentities: DuduSourceFileIdentity[],
  mutable: ReadonlySet<string>,
): Promise<void> {
  let nextIndex = 0;
  let stopped = false;
  const failures: Array<{ index: number; error: unknown }> = [];
  const workerCount = Math.min(DUDU_SOURCE_IDENTITY_VERIFY_CONCURRENCY, sourceIdentities.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!stopped) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= sourceIdentities.length) return;
      const file = sourceIdentities[index]!;
      try {
        await verifyPersistedSourceIdentity(
          receipt,
          file,
          file.scope === "locked-source" || !mutable.has(file.relativePath),
        );
      } catch (error) {
        failures.push({ index, error });
        stopped = true;
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failures.length > 0) {
    failures.sort((left, right) => left.index - right.index);
    throw failures[0]!.error;
  }
}

function duduEvolvingProductionCountsValid(
  current: Record<string, number>,
  baseline: Record<string, number>,
): boolean {
  const stableHeadKeys = new Set([
    "textDocuments",
    "scriptDocuments",
    "promptDocuments",
    "units",
    "panels",
    "contractProfiles",
    "scriptSectionRevisions",
  ]);
  return Object.entries(baseline).every(([key, value]) => {
    const actual = current[key];
    return Number.isSafeInteger(actual)
      && (stableHeadKeys.has(key) ? actual === value : actual! >= value);
  });
}

async function verifyDuduEvolvingOwnerBaseline(input: {
  shell: ProjectShell;
  intent: DuduReadonlyImportIntent;
  receipt: DuduReadonlyImportReceipt;
}): Promise<void> {
  const [material, production, generation, units, detached] = await Promise.all([
    getMaterialStudioState(input.shell.paths.root),
    getStudioProductionState(input.shell.paths.root),
    getStudioGenerationLedgerState(input.shell.paths.root),
    listStudioProductionUnits(input.shell.paths.root, { season: "S1", episode: "S1E1", limit: 100 }),
    listStudioDetachedGenerationUnknownObservations(input.shell.paths.root),
  ]);
  const baselineMaterial = input.receipt.ownerBaselineCounts.material;
  const baselineProduction = input.receipt.ownerBaselineCounts.production;
  const immutableMaterialKeys = Object.keys(baselineMaterial).filter((key) => key !== "media" && key !== "mediaImports") as Array<keyof typeof baselineMaterial>;
  if (material.counts.media < baselineMaterial.media || material.counts.mediaImports < baselineMaterial.mediaImports
    || immutableMaterialKeys.some((key) => material.counts[key] !== baselineMaterial[key])
    || !duduEvolvingProductionCountsValid(production.counts, baselineProduction)
    || units.items.length !== 33 || units.nextCursor
    || generation.counts.packs < 30 || generation.counts.targetExtensions < 30
    || generation.counts.historicalImports < 28 || generation.counts.historicalImports > 30
    || generation.counts.detachedUnknownObservations !== input.intent.detachedUnknownObservations.length
    || detached.length !== input.intent.detachedUnknownObservations.length) {
    throw new Error("Dudu active owner baseline 被删除、替换或出现未授权 owner 漂移。 ");
  }
  const actualDetached = normalizeDetachedUnknownObservations(detached.map((item) => ({
    unitId: item.unitId,
    sourceTaskId: item.sourceTaskId,
    evidenceReference: item.evidenceReference,
    evidenceFingerprint: item.evidenceFingerprint,
    candidateSha256: item.candidateSha256 ?? undefined,
    candidateSizeBytes: item.candidateSizeBytes ?? undefined,
    candidateWidth: item.candidateWidth ?? undefined,
    candidateHeight: item.candidateHeight ?? undefined,
    note: item.note,
  })));
  if (stableJson(actualDetached) !== stableJson(input.intent.detachedUnknownObservations)
    || !sameStringSet(detached.map((item) => item.observationId), input.receipt.detachedUnknownObservationIds)) {
    throw new Error("Dudu active detached unknown 防重证据漂移。 ");
  }
  for (const unit of input.receipt.units.filter((item) => item.historicalImportId)) {
    const evidence = await readStudioHistoricalGenerationEvidenceByPack(input.shell.paths.root, unit.packId!);
    if (!evidence || evidence.importId !== unit.historicalImportId || evidence.generationCallCount !== 0
      || evidence.generationRunId !== null || evidence.provider !== null || evidence.callId !== null) {
      throw new Error(`${unit.unitId} active historical-import 基线漂移。`);
    }
  }
}

function readOnlyCount(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  return Number((db.prepare(sql).get(...params) as { count: number }).count);
}

async function verifyDuduEvolvingOwnerBaselineReadOnly(input: {
  shell: ProjectShell;
  intent: DuduReadonlyImportIntent;
  receipt: DuduReadonlyImportReceipt;
}): Promise<void> {
  const openedSnapshots: SqliteReadOnlySnapshot[] = [];
  try {
    openedSnapshots.push(await openSqliteReadOnlySnapshot(input.shell.paths.materialDatabase, "Dudu material DB"));
    openedSnapshots.push(await openSqliteReadOnlySnapshot(input.shell.paths.productionDatabase, "Dudu production DB"));
    openedSnapshots.push(await openSqliteReadOnlySnapshot(input.shell.paths.generationDatabase, "Dudu generation DB"));
  } catch (error) {
    await Promise.all(openedSnapshots.map((snapshot) => snapshot.close()));
    throw error;
  }
  const [materialSnapshot, productionSnapshot, generationSnapshot] = openedSnapshots as [
    SqliteReadOnlySnapshot,
    SqliteReadOnlySnapshot,
    SqliteReadOnlySnapshot,
  ];
  const materialDb = materialSnapshot.database;
  const productionDb = productionSnapshot.database;
  const generationDb = generationSnapshot.database;
  try {
    const material = {
      media: readOnlyCount(materialDb, "SELECT COUNT(*) AS count FROM studio_media"),
      mediaImports: readOnlyCount(materialDb, "SELECT COUNT(*) AS count FROM studio_media_imports"),
      canonicalAssets: readOnlyCount(materialDb, "SELECT COUNT(*) AS count FROM studio_canonical_assets"),
      characters: readOnlyCount(materialDb, "SELECT COUNT(*) AS count FROM studio_canonical_assets WHERE category='character'"),
      scenes: readOnlyCount(materialDb, "SELECT COUNT(*) AS count FROM studio_canonical_assets WHERE category='scene'"),
      props: readOnlyCount(materialDb, "SELECT COUNT(*) AS count FROM studio_canonical_assets WHERE category='prop'"),
      styles: readOnlyCount(materialDb, "SELECT COUNT(*) AS count FROM studio_canonical_assets WHERE category='style'"),
      assetVersions: readOnlyCount(materialDb, "SELECT COUNT(*) AS count FROM studio_asset_versions"),
      assetDefinitions: readOnlyCount(materialDb, "SELECT COUNT(*) AS count FROM studio_asset_definitions"),
      primaryAuthorities: readOnlyCount(materialDb, "SELECT COUNT(*) AS count FROM studio_canonical_assets WHERE primary_version_id IS NOT NULL"),
      authorityEvents: readOnlyCount(materialDb, "SELECT COUNT(*) AS count FROM studio_authority_events"),
      versionReviews: readOnlyCount(materialDb, "SELECT COUNT(*) AS count FROM studio_version_reviews"),
      assetRelations: readOnlyCount(materialDb, "SELECT COUNT(*) AS count FROM studio_asset_relations"),
    };
    const production = {
      textDocuments: readOnlyCount(productionDb, "SELECT COUNT(*) AS count FROM studio_text_documents"),
      scriptDocuments: readOnlyCount(productionDb, "SELECT COUNT(*) AS count FROM studio_text_documents WHERE kind='script'"),
      promptDocuments: readOnlyCount(productionDb, "SELECT COUNT(*) AS count FROM studio_text_documents WHERE kind='prompt'"),
      textRevisions: readOnlyCount(productionDb, "SELECT COUNT(*) AS count FROM studio_text_revisions"),
      units: readOnlyCount(productionDb, "SELECT COUNT(*) AS count FROM studio_production_units"),
      panels: readOnlyCount(productionDb, "SELECT COALESCE(SUM(panel_count),0) AS count FROM studio_production_units"),
      unitRevisions: readOnlyCount(productionDb, "SELECT COUNT(*) AS count FROM studio_production_unit_revisions"),
      unitTimings: readOnlyCount(productionDb, "SELECT COUNT(*) AS count FROM studio_production_unit_timings"),
      contractProfiles: readOnlyCount(productionDb, "SELECT COUNT(*) AS count FROM studio_production_contract_profiles"),
      scriptSectionRevisions: readOnlyCount(productionDb, "SELECT COUNT(*) AS count FROM studio_script_section_revisions"),
      mentionAnalyses: readOnlyCount(productionDb, "SELECT COUNT(*) AS count FROM studio_asset_mention_analyses"),
      mentionProposals: readOnlyCount(productionDb, "SELECT COUNT(*) AS count FROM studio_asset_mention_proposals"),
      mentionDecisions: readOnlyCount(productionDb, "SELECT COUNT(*) AS count FROM studio_asset_mention_decisions"),
      panelEntityClosureConfirmations: readOnlyCount(productionDb, "SELECT COUNT(*) AS count FROM studio_panel_entity_closure_confirmations"),
      assetBindingSets: readOnlyCount(productionDb, "SELECT COUNT(*) AS count FROM studio_asset_binding_sets"),
    };
    const baselineMaterial = input.receipt.ownerBaselineCounts.material;
    const baselineProduction = input.receipt.ownerBaselineCounts.production;
    const immutableMaterialKeys = Object.keys(baselineMaterial)
      .filter((key) => key !== "media" && key !== "mediaImports") as Array<keyof typeof baselineMaterial>;
    const packCount = readOnlyCount(generationDb, "SELECT COUNT(*) AS count FROM studio_generation_packs");
    const targetCount = readOnlyCount(generationDb, "SELECT COUNT(*) AS count FROM studio_generation_pack_targets");
    const historicalCount = readOnlyCount(generationDb, "SELECT COUNT(*) AS count FROM studio_generation_historical_imports");
    const detachedRows = generationDb.prepare(`SELECT observation_id FROM studio_generation_detached_unknown_observations
      ORDER BY observation_id`).all() as Array<{ observation_id: string }>;
    if (material.media < baselineMaterial.media || material.mediaImports < baselineMaterial.mediaImports
      || immutableMaterialKeys.some((key) => material[key] !== baselineMaterial[key])
      || !duduEvolvingProductionCountsValid(production, baselineProduction)
    || packCount < 30 || targetCount < 30 || historicalCount < 28 || historicalCount > 30
      || detachedRows.length !== input.intent.detachedUnknownObservations.length
      || !sameStringSet(detachedRows.map((row) => row.observation_id), input.receipt.detachedUnknownObservationIds)) {
      throw new Error("Dudu active 只读 owner baseline 被删除、替换或出现未授权漂移。 ");
    }
    for (const unit of input.receipt.units.filter((item) => item.historicalImportId)) {
      const historical = generationDb.prepare(`SELECT import_id, pack_fingerprint
        FROM studio_generation_historical_imports WHERE pack_id=?`).get(unit.packId!) as {
          import_id: string; pack_fingerprint: string;
        } | undefined;
      const dispatchCount = readOnlyCount(
        generationDb,
        "SELECT COUNT(*) AS count FROM studio_generation_dispatches WHERE pack_id=?",
        unit.packId!,
      );
      if (!historical || historical.import_id !== unit.historicalImportId
        || historical.pack_fingerprint !== unit.packFingerprint || dispatchCount !== 0) {
        throw new Error(`${unit.unitId} active historical-import 只读基线漂移。`);
      }
    }
  } finally {
    await Promise.all([
      materialSnapshot.close(),
      productionSnapshot.close(),
      generationSnapshot.close(),
    ]);
  }
}

/**
 * 将 U28/U29 已在锁版生产根完成原尺寸验收的 raw/labeled，以零模型调用方式
 * 追加为历史证据。此函数不改外部源、不复用候选，也不接收 U30+。
 */
export async function reconcileDuduReadonlyHistoricalPasses(
  projectRoot: string,
  source: DuduReadonlySourceInput,
): Promise<DuduReadonlyHistoricalPassReconciliationResult> {
  const shell = await inspectManagedProject(projectRoot);
  return withProjectLock(shell.paths.root, "dudu-historical-pass-reconciliation", async () => {
    const verified = await verifyDuduImmutableImportIdentity(shell.paths.root);
    const identity = await getActiveDuduReadonlyProjectIdentity(shell.paths.root);
    await verifyDuduEvolvingOwnerBaseline({ shell, intent: verified.intent, receipt: verified.receipt });
    const inspection = await inspectDuduReadonlySources(source);
    if (inspection.lockedScript.sha256 !== verified.receipt.lockedScriptSha256
      || inspection.contract.sha256 !== verified.receipt.contractSha256
      || inspection.productionRoot !== verified.receipt.sourceProductionRoot
      || inspection.lockedScriptPath !== verified.receipt.sourceLockedScriptPath) {
      throw new Error("Dudu 增量历史回填的锁版剧本、合同或源根身份漂移。 ");
    }

    const receiptByUnit = new Map(verified.receipt.units.map((unit) => [unit.unitId, unit]));
    const imported: DuduReadonlyHistoricalPassReconciliationResult["imported"] = [];
    for (const unitId of [...INCREMENTAL_HISTORICAL_PASS_UNIT_IDS].sort()) {
      const unit = inspection.units.find((entry) => entry.unitId === unitId);
      const receiptUnit = receiptByUnit.get(unitId);
      if (!unit || !receiptUnit || !unit.historicalPass || !unit.binding) {
        throw new Error(`${unitId} 尚未形成完整锁版 PASS/raw/labeled/BindingSet 闭包，拒绝回填。`);
      }
      if (unit.binding.file.sha256 !== receiptUnit.bindingSha256) {
        throw new Error(`${unitId} BindingSet 已偏离初始只读映射，拒绝把新源 raw 接入旧资产链。`);
      }
      const historicalContinuationWaiver = await duduReadonlyContinuationWaiver(
        shell.paths.root,
        unit,
        inspection.sourceManifestFingerprint,
        "incremental-reconcile",
      );
      const preview = await queryStudioUnitGridGenerationFreeze(shell.paths.root, {
        targetKind: "unit-grid",
        unitId,
        ...(historicalContinuationWaiver
          ? { verifiedHistoricalImportContinuationWaiver: historicalContinuationWaiver }
          : {}),
      });
      if (preview.status !== "ready") {
        throw new Error(`${unitId} 当前 unit-grid 冻结不可用：${preview.code}。`);
      }
      const existingPack = await readStudioUnitGridGenerationFrozenPack(shell.paths.root, preview.packId);
      const currentPack = existingPack && existingPack.fingerprint === preview.fingerprint
        ? { packId: preview.packId, fingerprint: preview.fingerprint }
        : await freezeAndPersistStudioUnitGridGenerationPack(shell.paths.root, {
          targetKind: "unit-grid",
          unitId,
          ...(historicalContinuationWaiver
            ? { verifiedHistoricalImportContinuationWaiver: historicalContinuationWaiver }
            : {}),
        });
      const [raw, labeled] = await Promise.all([
        ensureImportedMediaOrigin(shell.paths.root, unit.historicalPass.raw),
        ensureImportedMediaOrigin(shell.paths.root, unit.historicalPass.labeled),
      ]);
      const historical = await importStudioHistoricalGenerationEvidence(shell.paths.root, {
          packId: currentPack.packId,
          packFingerprint: currentPack.fingerprint,
          rawMediaSha256: raw.sha256,
          labeledMediaSha256: labeled.sha256,
          sourceRawSha256: unit.historicalPass.raw.sha256,
          sourceLabeledSha256: unit.historicalPass.labeled.sha256,
          sourceManifestFingerprint: inspection.sourceManifestFingerprint,
          qcEvidenceReference: unit.historicalPass.qc.relativePath,
          qcEvidenceSha256: unit.historicalPass.qc.sha256,
          externalStoryboardStatus: unit.historicalPass.externalStoryboardStatus,
        });
      imported.push({
        unitId: unitId as "S1E01-U28" | "S1E01-U29",
        packId: currentPack.packId,
        packFingerprint: currentPack.fingerprint,
        importId: historical.importId,
        rawSha256: raw.sha256,
        labeledSha256: labeled.sha256,
      });
    }
    const after = await getStudioGenerationLedgerState(shell.paths.root);
    if (after.counts.historicalImports !== 30) {
      throw new Error(`Dudu 增量历史回填后 historicalImports 应为30，实际 ${after.counts.historicalImports}。`);
    }
    return {
      schemaVersion: 1,
      kind: "dudu-readonly-historical-pass-reconciliation",
      projectId: identity.projectId,
      projectRoot: identity.projectRoot,
      imported,
      sourceMachineProjectionFingerprint: inspection.sourceManifestFingerprint,
    };
  }, { timeoutMs: 30_000, staleMs: 2 * 60 * 60 * 1_000 });
}

async function verifyDuduImmutableImportIdentity(projectRoot: string, readOnly = false): Promise<{
  shell: ProjectShell;
  claim: ManagedProjectBootstrapClaim;
  intent: DuduReadonlyImportIntent;
  receipt: DuduReadonlyImportReceipt;
  currentMachineProjection: DuduCurrentMachineProjection;
}> {
  const shell = readOnly
    ? await inspectManagedProjectReadOnly(projectRoot)
    : await inspectManagedProject(projectRoot);
  const [claim, intentValue, receiptValue] = await Promise.all([
    readManagedProjectBootstrapClaim(shell.paths.root),
    readJsonFile<DuduReadonlyImportIntent>(path.join(shell.paths.root, INTENT_RELATIVE_PATH)),
    readJsonFile<DuduReadonlyImportReceipt>(path.join(shell.paths.root, RECEIPT_RELATIVE_PATH)),
  ]);
  if (!claim || !intentValue || !receiptValue) throw new Error("Dudu active 工程缺少 claim→intent→receipt。 ");
  const intent = validateIntent(intentValue);
  const receipt = validateImportReceipt(receiptValue);
  const expectedClaimPayload = {
    schemaVersion: 1,
    kind: "dudu-readonly-bootstrap",
    projectName: PROJECT_NAME,
    projectSlug: PROJECT_SLUG,
    sourceProductionRoot: receipt.sourceProductionRoot,
    sourceLockedScriptPath: receipt.sourceLockedScriptPath,
    sourceManifestFingerprint: receipt.sourceManifestFingerprint,
    productionScopeFingerprint: receipt.productionScopeFingerprint,
    contractSha256: receipt.contractSha256,
    lockedScriptSha256: receipt.lockedScriptSha256,
    detachedUnknownContractFingerprint: detachedUnknownContractFingerprint(intent.detachedUnknownObservations),
  };
  const sourceIdentities = Array.isArray(receipt.sourceFiles) ? receipt.sourceFiles : [];
  const sourceKeys = sourceIdentities.map((file) => `${file.scope}:${file.relativePath}`);
  const mutable = new Set(receipt.mutableProjectionRelativePaths);
  if (claim.projectRoot !== shell.paths.root || claim.purpose !== BOOTSTRAP_PURPOSE
    || stableJson(claim.payload) !== stableJson(expectedClaimPayload)
    || intent.projectId !== shell.project.id || intent.projectRoot !== shell.paths.root
    || intent.managedManifestFingerprint !== shell.manifestFingerprint
    || intent.bootstrapClaimFingerprint !== claim.fingerprint
    || receipt.projectId !== shell.project.id || receipt.projectRoot !== shell.paths.root
    || receipt.managedManifestFingerprint !== shell.manifestFingerprint
    || receipt.bootstrapClaimFingerprint !== claim.fingerprint
    || receipt.importIntentFingerprint !== intent.fingerprint
    || receipt.detachedUnknownContractFingerprint !== detachedUnknownContractFingerprint(intent.detachedUnknownObservations)
    || sourceIdentities.length !== receipt.sourceFileCount
    || new Set(sourceKeys).size !== sourceKeys.length
    || sourceIdentities.reduce((total, file) => total + file.sizeBytes, 0) !== receipt.sourceByteCount
    || receiptSourceManifestFingerprint(sourceIdentities) !== receipt.sourceManifestFingerprint
    || mutable.size !== receipt.mutableProjectionRelativePaths.length
    || receipt.mutableProjectionRelativePaths.length !== 1
    || [...mutable].some((relativePath) => !sourceIdentities.some((file) => file.scope === "production-root" && file.relativePath === relativePath))) {
    throw new Error("Dudu active immutable import 身份链无效。 ");
  }
  await verifyPersistedSourceIdentities(receipt, sourceIdentities, mutable);
  const currentMachineProjection = await readDuduCurrentMachineProjection({
    productionRoot: receipt.sourceProductionRoot,
    machineStateRelativePath: receipt.mutableProjectionRelativePaths[0]!,
    expectedUnits: receipt.units.map((unit) => ({
      unitId: unit.unitId,
      sequence: unit.sequence,
      durationSeconds: unit.durationSeconds,
      panelCount: unit.panelCount,
      initialStoryboardStatus: unit.machineStoryboardStatus,
      initialToolInvocationCount: unit.machineToolInvocationCount,
      initialVisualCandidateCount: unit.machineVisualCandidateCount,
      historicalApprovedRawRelativePath: unit.historicalApprovedRawRelativePath,
      historicalApprovedRawSha256: unit.historicalApprovedRawSha256,
    })),
  });
  if (readOnly) await verifyDuduEvolvingOwnerBaselineReadOnly({ shell, intent, receipt });
  else await verifyDuduEvolvingOwnerBaseline({ shell, intent, receipt });
  return { shell, claim, intent, receipt, currentMachineProjection };
}

/**
 * 视频包/正式生产写面使用的只读身份门。它从 registry 与 active pointer 实时投影，
 * 并重新验证 claim→intent→import receipt→owner→source；不把 activation receipt 当
 * 成永久 active 真相。
 */
async function getActiveDuduReadonlyProjectIdentityInternal(
  projectRoot: string,
  readOnly: boolean,
): Promise<DuduReadonlyActiveProjectIdentity> {
  const readActive = readOnly ? getActiveProjectStateReadOnly : getActiveProjectState;
  const activeBefore = await readActive();
  const verified = await verifyDuduImmutableImportIdentity(projectRoot, readOnly);
  const shell = verified.shell;
  const registrationValue = await readJsonFile<DuduReadonlyRegistrationReceipt>(path.join(
    shell.paths.root,
    REGISTRATION_RELATIVE_PATH,
  ));
  if (!registrationValue) throw new Error("Dudu 工程尚未完成 registration。 ");
  const registration = validateRegistrationReceipt(registrationValue);
  const [registry, active] = await Promise.all([listRegisteredProjects(), readActive()]);
  const sameRoot = registry.filter((project) => path.resolve(project.primaryRoot) === shell.paths.root);
  const sameId = registry.filter((project) => project.id === shell.project.id);
  if (sameRoot.length !== 1 || sameId.length !== 1 || sameRoot[0]!.id !== shell.project.id
    || !activeBefore || path.resolve(activeBefore.primaryRoot) !== shell.paths.root
    || !active || path.resolve(active.primaryRoot) !== shell.paths.root
    || activeBefore.activationId !== active.activationId) {
    throw new Error("Dudu 工程不是当前精确登记的活动工程。 ");
  }
  const activationValue = await readJsonFile<DuduReadonlyActivationReceipt>(path.join(
    shell.paths.root,
    activationReceiptRelativePath(active.activationId),
  ));
  if (!activationValue) throw new Error("Dudu 当前 activation 尚无不可变收据。 ");
  const activation = validateActivationReceipt(activationValue);
  if (registration.projectId !== shell.project.id || registration.projectRoot !== shell.paths.root
    || registration.importFingerprint !== verified.receipt.fingerprint
    || activation.projectId !== shell.project.id || activation.projectRoot !== shell.paths.root
    || activation.importFingerprint !== verified.receipt.fingerprint
    || activation.registrationFingerprint !== registration.fingerprint
    || activation.activationId !== active.activationId) {
    throw new Error("Dudu import/registration/activation 身份链不一致。 ");
  }
  const [registryAfter, activeAfter] = await Promise.all([listRegisteredProjects(), readActive()]);
  const sameRootAfter = registryAfter.filter((project) => path.resolve(project.primaryRoot) === shell.paths.root);
  const sameIdAfter = registryAfter.filter((project) => project.id === shell.project.id);
  if (sameRootAfter.length !== 1 || sameIdAfter.length !== 1 || sameRootAfter[0]!.id !== shell.project.id
    || !activeAfter || path.resolve(activeAfter.primaryRoot) !== shell.paths.root
    || activeAfter.activationId !== activation.activationId) {
    throw new Error("Dudu active 身份在验证期间发生切换。 ");
  }
  return {
    projectId: shell.project.id,
    projectRoot: shell.paths.root,
    sourceProductionRoot: verified.receipt.sourceProductionRoot,
    sourceLockedScriptPath: verified.receipt.sourceLockedScriptPath,
    sourceManifestFingerprint: verified.receipt.sourceManifestFingerprint,
    productionScopeFingerprint: verified.receipt.productionScopeFingerprint,
    contractSha256: verified.receipt.contractSha256,
    lockedScriptSha256: verified.receipt.lockedScriptSha256,
    bootstrapClaimFingerprint: verified.receipt.bootstrapClaimFingerprint,
    importIntentFingerprint: verified.receipt.importIntentFingerprint,
    importReceiptFingerprint: verified.receipt.fingerprint,
    detachedUnknownContractFingerprint: verified.receipt.detachedUnknownContractFingerprint,
    registrationFingerprint: registration.fingerprint,
    activationId: activation.activationId,
    activationFingerprint: activation.fingerprint,
    currentMachineProjectionFingerprint: verified.currentMachineProjection.fingerprint,
    sourceFiles: verified.receipt.sourceFiles.map((file) => ({ ...file })),
  };
}

export async function getActiveDuduReadonlyProjectIdentity(
  projectRoot: string,
): Promise<DuduReadonlyActiveProjectIdentity> {
  return getActiveDuduReadonlyProjectIdentityInternal(projectRoot, false);
}

/**
 * 轮询/控制面专用：claim、注册、活动指针、三库计数、source 和机器状态全部只读；
 * 缺库或旧 schema 直接失败，不创建目录、锁、表、marker、WAL 或迁移。
 */
export async function getActiveDuduReadonlyProjectIdentityReadOnly(
  projectRoot: string,
): Promise<DuduReadonlyActiveProjectIdentity> {
  return getActiveDuduReadonlyProjectIdentityInternal(projectRoot, true);
}

/**
 * command-bus finalize 崩溃恢复证明。全程只读：除当前 active owner 闭包外，
 * 还必须重验原请求 source 解析到同一冻结角色与不可变文件，避免另一条正确
 * finalize 完成后把旧 wrong-source unknown 命令误判为成功。
 */
export async function proveDuduReadonlyFinalizationOutcome(
  projectRoot: string,
  source: DuduReadonlySourceInput,
  expectedImportFingerprint: string,
  commandRequestHash: string,
): Promise<DuduReadonlyFinalizationResult | null> {
  try {
    const [inspection, verified] = await Promise.all([
      inspectDuduReadonlySources(source),
      verifyDuduImmutableImportIdentity(projectRoot, true),
    ]);
    const receipt = verified.receipt;
    if (receipt.fingerprint !== expectedImportFingerprint
      || !duduReadonlySourceRequestMatchesReceipt(inspection, receipt)) return null;

    const activeIdentity = await getActiveDuduReadonlyProjectIdentityReadOnly(verified.shell.paths.root);
    if (activeIdentity.importReceiptFingerprint !== expectedImportFingerprint) return null;
    const [registrationValue, activationValue] = await Promise.all([
      readJsonFile<DuduReadonlyRegistrationReceipt>(path.join(
        verified.shell.paths.root,
        REGISTRATION_RELATIVE_PATH,
      )),
      readJsonFile<DuduReadonlyActivationReceipt>(path.join(
        verified.shell.paths.root,
        activationReceiptRelativePath(activeIdentity.activationId),
      )),
    ]);
    if (!registrationValue || !activationValue) return null;
    const registration = validateRegistrationReceipt(registrationValue);
    const activation = validateActivationReceipt(activationValue);
    const operationReceipt = await readCommandOperationReceipt(
      verified.shell.paths.root,
      "finalize_dudu_readonly_managed_project",
      commandRequestHash,
    );
    if (!operationReceipt
      || operationReceipt.projectId !== verified.shell.project.id
      || operationReceipt.importFingerprint !== expectedImportFingerprint
      || operationReceipt.registrationFingerprint !== registration.fingerprint
      || operationReceipt.activationId !== activation.activationId
      || operationReceipt.activationFingerprint !== activation.fingerprint
      || registration.fingerprint !== activeIdentity.registrationFingerprint
      || activation.fingerprint !== activeIdentity.activationFingerprint
      || registration.importFingerprint !== expectedImportFingerprint
      || activation.importFingerprint !== expectedImportFingerprint) {
      return null;
    }
    return {
      schemaVersion: 1,
      kind: "dudu-readonly-managed-finalization",
      projectId: verified.shell.project.id,
      projectRoot: verified.shell.paths.root,
      importFingerprint: expectedImportFingerprint,
      registered: true,
      active: true,
      activationId: activeIdentity.activationId,
      registration,
      activation,
      replayedRegistration: true,
      replayedActivation: true,
    };
  } catch {
    return null;
  }
}

export async function readDuduReadonlyFinalizationOutcomeByOperationId(
  projectRoot: string,
  commandRequestHash: string,
): Promise<DuduReadonlyFinalizationResult | null> {
  try {
    const verified = await verifyDuduImmutableImportIdentity(projectRoot, true);
    const activeIdentity = await getActiveDuduReadonlyProjectIdentityReadOnly(verified.shell.paths.root);
    const [registrationValue, activationValue, operationReceipt] = await Promise.all([
      readJsonFile<DuduReadonlyRegistrationReceipt>(path.join(verified.shell.paths.root, REGISTRATION_RELATIVE_PATH)),
      readJsonFile<DuduReadonlyActivationReceipt>(path.join(
        verified.shell.paths.root,
        activationReceiptRelativePath(activeIdentity.activationId),
      )),
      readCommandOperationReceipt(
        verified.shell.paths.root,
        "finalize_dudu_readonly_managed_project",
        commandRequestHash,
      ),
    ]);
    if (!registrationValue || !activationValue || !operationReceipt) return null;
    const registration = validateRegistrationReceipt(registrationValue);
    const activation = validateActivationReceipt(activationValue);
    if (operationReceipt.projectId !== verified.shell.project.id
      || operationReceipt.importFingerprint !== verified.receipt.fingerprint
      || operationReceipt.registrationFingerprint !== registration.fingerprint
      || operationReceipt.activationId !== activation.activationId
      || operationReceipt.activationFingerprint !== activation.fingerprint
      || registration.fingerprint !== activeIdentity.registrationFingerprint
      || activation.fingerprint !== activeIdentity.activationFingerprint) return null;
    return {
      schemaVersion: 1,
      kind: "dudu-readonly-managed-finalization",
      projectId: verified.shell.project.id,
      projectRoot: verified.shell.paths.root,
      importFingerprint: verified.receipt.fingerprint,
      registered: true,
      active: true,
      activationId: activeIdentity.activationId,
      registration,
      activation,
      replayedRegistration: true,
      replayedActivation: true,
    };
  } catch {
    return null;
  }
}

/**
 * P30：供 IPC/MCP/UI 轮询的纯只读 Dudu 导入阶段投影。任何不一致均失败关闭；
 * 本函数不会补写缺失收据、登记工程、切换活动指针或初始化三库。
 */
export async function getDuduReadonlyImportControl(
  projectRoot: string,
): Promise<DuduReadonlyImportControl> {
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const [claim, intentValue, receiptValue, registrationValue, registry, active] = await Promise.all([
    readManagedProjectBootstrapClaim(shell.paths.root),
    readJsonFile<DuduReadonlyImportIntent>(path.join(shell.paths.root, INTENT_RELATIVE_PATH)),
    readJsonFile<DuduReadonlyImportReceipt>(path.join(shell.paths.root, RECEIPT_RELATIVE_PATH)),
    readJsonFile<DuduReadonlyRegistrationReceipt>(path.join(shell.paths.root, REGISTRATION_RELATIVE_PATH)),
    listRegisteredProjects(),
    getActiveProjectStateReadOnly(),
  ]);
  if (!claim || claim.purpose !== BOOTSTRAP_PURPOSE || claim.projectRoot !== shell.paths.root) {
    throw new Error("该受管工程不是可识别的 Dudu staging owner。");
  }
  const intent = intentValue ? validateIntent(intentValue) : null;
  const receipt = receiptValue ? validateImportReceipt(receiptValue) : null;
  if (intent && (intent.projectId !== shell.project.id
    || intent.projectRoot !== shell.paths.root
    || intent.managedManifestFingerprint !== shell.manifestFingerprint
    || intent.bootstrapClaimFingerprint !== claim.fingerprint)) {
    throw new Error("Dudu staging intent 与当前 managed/bootstrap 身份不一致。");
  }
  if (receipt && (!intent
    || receipt.projectId !== shell.project.id
    || receipt.projectRoot !== shell.paths.root
    || receipt.managedManifestFingerprint !== shell.manifestFingerprint
    || receipt.bootstrapClaimFingerprint !== claim.fingerprint
    || receipt.importIntentFingerprint !== intent.fingerprint)) {
    throw new Error("Dudu import receipt 与当前 managed/intent 身份不一致。");
  }

  const sameRoot = registry.filter((project) => path.resolve(project.primaryRoot) === shell.paths.root);
  const sameId = registry.filter((project) => project.id === shell.project.id);
  if (sameRoot.some((project) => project.id !== shell.project.id)
    || sameId.some((project) => path.resolve(project.primaryRoot) !== shell.paths.root)
    || sameRoot.length > 1 || sameId.length > 1) {
    throw new Error("Dudu staging 与项目注册表存在 root/id 冲突。");
  }
  const registered = sameRoot.length === 1 && sameId.length === 1;
  const registration = registrationValue ? validateRegistrationReceipt(registrationValue) : null;
  if (registration && (!receipt
    || registration.projectId !== shell.project.id
    || registration.projectRoot !== shell.paths.root
    || registration.importFingerprint !== receipt.fingerprint)) {
    throw new Error("Dudu registration receipt 与当前 import 身份不一致。");
  }
  if (registration && !registered) {
    throw new Error("Dudu registration receipt 已存在但注册表未闭合。");
  }
  if (!receipt && registered) {
    throw new Error("Dudu staging 尚无完整 import receipt 却已进入注册表。");
  }

  const activeMatches = Boolean(active
    && path.resolve(active.primaryRoot) === shell.paths.root);
  if (activeMatches && (!receipt || !registered || !registration)) {
    throw new Error("Dudu 活动指针已命中，但 import/registration/registry 身份链未闭合。");
  }
  let activation: DuduReadonlyActivationReceipt | null = null;
  if (activeMatches) {
    activation = await readJsonFile<DuduReadonlyActivationReceipt>(path.join(
      shell.paths.root,
      activationReceiptRelativePath(active!.activationId),
    )).then((value) => value ? validateActivationReceipt(value) : null);
    if (activation && (!registration || !receipt
      || activation.projectId !== shell.project.id
      || activation.projectRoot !== shell.paths.root
      || activation.importFingerprint !== receipt.fingerprint
      || activation.registrationFingerprint !== registration.fingerprint
      || activation.activationId !== active!.activationId)) {
      throw new Error("Dudu activation receipt 与当前 import/registration/active 身份不一致。");
    }
  }

  let verified: Awaited<ReturnType<typeof verifyDuduImmutableImportIdentity>> | null = null;
  if (receipt) verified = await verifyDuduImmutableImportIdentity(shell.paths.root, true);
  let status: DuduReadonlyImportControl["status"];
  let blockers: string[];
  let nextAction: DuduReadonlyImportControl["nextAction"];
  if (!intent || !receipt) {
    status = "staging-incomplete";
    blockers = [
      ...(!intent ? ["import-intent-missing"] : []),
      ...(!receipt ? ["import-receipt-missing"] : []),
    ];
    nextAction = "resume-staging-via-authorized-core-orchestration";
  } else if (registered && !registration) {
    status = "registration-incomplete";
    blockers = ["registration-receipt-missing"];
    nextAction = "resume-finalization-via-authorized-core-orchestration";
  } else if (!registered) {
    status = "staging-verified";
    blockers = [];
    nextAction = "finalize-registration-and-activation-via-authorized-core-orchestration";
  } else if (!activeMatches) {
    status = "registered-not-active";
    blockers = ["active-project-mismatch"];
    nextAction = "resume-finalization-via-authorized-core-orchestration";
  } else if (!activation) {
    status = "activation-incomplete";
    blockers = ["activation-receipt-missing"];
    nextAction = "resume-finalization-via-authorized-core-orchestration";
  } else {
    // 完整 active 状态再走一次 registry/activation 前后双读门禁，避免把瞬时指针当真相。
    await getActiveDuduReadonlyProjectIdentityReadOnly(shell.paths.root);
    status = "active";
    blockers = [];
    nextAction = "ready";
  }

  const counts = receipt ? {
    units: receipt.counts.units,
    panels: receipt.counts.panels,
    durationSeconds: receipt.counts.durationSeconds,
    bindingSets: receipt.counts.bindingSets,
    unitGridPacks: receipt.counts.unitGridPacks,
    historicalImports: receipt.counts.historicalImports,
    videoManifests: receipt.counts.videoManifests,
    sourceFiles: receipt.sourceFileCount,
    sourceBytes: receipt.sourceByteCount,
    generationDispatches: receipt.counts.generationDispatches,
    generationResults: receipt.counts.generationResults,
    generationCallIntents: receipt.counts.generationCallIntents,
  } : null;
  const semantic = {
    schemaVersion: 1 as const,
    kind: "dudu-readonly-import-control" as const,
    projectId: shell.project.id,
    status,
    identity: {
      managedManifestFingerprint: shell.manifestFingerprint,
      bootstrapClaimFingerprint: claim.fingerprint,
      importIntentFingerprint: intent?.fingerprint ?? null,
      importReceiptFingerprint: receipt?.fingerprint ?? null,
      sourceManifestFingerprint: receipt?.sourceManifestFingerprint ?? intent?.sourceManifestFingerprint ?? null,
      productionScopeFingerprint: receipt?.productionScopeFingerprint ?? intent?.productionScopeFingerprint ?? null,
      contractSha256: receipt?.contractSha256 ?? intent?.contractSha256 ?? null,
      currentMachineProjectionFingerprint: verified?.currentMachineProjection.fingerprint ?? null,
    },
    counts,
    registration: { registered, receiptFingerprint: registration?.fingerprint ?? null },
    activation: {
      active: status === "active",
      activationId: activation?.activationId ?? null,
      receiptFingerprint: activation?.fingerprint ?? null,
    },
    blockers,
    nextAction,
    readOnly: true as const,
  };
  return { ...semantic, fingerprint: digest(semantic) };
}

/**
 * P30 工程中心重启恢复入口：只扫描 projectsRoot 的直接子目录，并仅凭既有
 * bootstrap claim 识别 Dudu owner。0/1/>1 分别返回 none/single/conflict；
 * conflict 永不选择第一个候选。扫描期间不恢复 bootstrap、不初始化 owner、
 * 不创建 registry/lock/WAL/SHM，也不写任何 receipt。
 */
export async function discoverDuduReadonlyImportProjects(
  projectsRootValue: string,
): Promise<DuduReadonlyImportDiscovery> {
  const requestedProjectsRoot = path.resolve(projectsRootValue);
  let projectsRoot: string;
  try {
    projectsRoot = await canonicalProjectsRoot(requestedProjectsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const publicSemantic = {
      schemaVersion: 1 as const,
      kind: "dudu-readonly-import-discovery" as const,
      status: "none" as const,
      candidateCount: 0,
      candidates: [],
      blockers: [],
      nextAction: "stage-new-via-authorized-core-orchestration" as const,
      readOnly: true as const,
    };
    return {
      ...publicSemantic,
      projectsRoot: requestedProjectsRoot,
      fingerprint: digest(publicSemantic),
    };
  }
  const before = await lstat(projectsRoot, { bigint: true });
  const entries = [];
  const directoryHandle = await opendir(projectsRoot);
  for await (const entry of directoryHandle) {
    if (entries.length >= MAX_DUDU_DISCOVERY_DIRECTORIES) {
      throw new Error(`projectsRoot 直接条目超过只读发现上限 ${MAX_DUDU_DISCOVERY_DIRECTORIES}，禁止不完整扫描。`);
    }
    entries.push(entry);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const matching = entries.filter((entry) => entry.name === PROJECT_SLUG || entry.name.startsWith(`${PROJECT_SLUG}-`));
  if (matching.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error("发现类型不安全的 Dudu 专用根，禁止忽略后另选候选。");
  }

  const candidates: DuduReadonlyImportDiscoveryCandidate[] = [];
  for (const entry of matching) {
    const candidateRoot = path.join(projectsRoot, entry.name);
    const metadata = await lstat(candidateRoot, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(candidateRoot) !== candidateRoot) {
      continue;
    }
    const claim = await readManagedProjectBootstrapClaim(candidateRoot);
    if (!claim || claim.purpose !== BOOTSTRAP_PURPOSE || claim.projectRoot !== candidateRoot) {
      throw new Error("发现缺少有效 bootstrap claim 的 Dudu 专用根，禁止忽略后另选候选。");
    }

    let control: DuduReadonlyImportControl | null = null;
    try {
      control = await getDuduReadonlyImportControl(candidateRoot);
    } catch {
      // claim-only orphan 或损坏的 managed shell 仍是必须显式处理的候选；
      // 发现面只给稳定 unreadable 状态，不把绝对路径/底层异常投进 MCP。
    }
    const publicCandidate = {
      directoryName: entry.name,
      projectId: control?.projectId ?? null,
      bootstrapClaimFingerprint: claim.fingerprint,
      controlStatus: control?.status ?? "unreadable" as const,
      control,
    };
    candidates.push({
      projectRoot: candidateRoot,
      ...publicCandidate,
      fingerprint: digest(publicCandidate),
    });
  }

  const after = await lstat(projectsRoot, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    || await realpath(projectsRoot) !== projectsRoot) {
    throw new Error("projectsRoot 在只读发现期间发生变化，禁止使用不稳定候选集。");
  }

  const invalidCandidate = candidates.some((candidate) => candidate.controlStatus === "unreadable");
  const status: DuduReadonlyImportDiscovery["status"] = candidates.length === 0
    ? "none"
    : candidates.length === 1 && !invalidCandidate ? "single" : "conflict";
  const blockers: DuduReadonlyImportDiscovery["blockers"] = [
    ...(candidates.length > 1 ? ["multiple-dudu-staging-candidates" as const] : []),
    ...(invalidCandidate ? ["invalid-dudu-staging-candidate" as const] : []),
  ];
  const nextAction: DuduReadonlyImportDiscovery["nextAction"] = status === "none"
    ? "stage-new-via-authorized-core-orchestration"
    : status === "single" ? "inspect-single-staging" : "resolve-staging-conflict";
  const publicSemantic = {
    schemaVersion: 1 as const,
    kind: "dudu-readonly-import-discovery" as const,
    status,
    candidateCount: candidates.length,
    candidates: candidates.map(({ projectRoot: _projectRoot, ...candidate }) => candidate),
    blockers,
    nextAction,
    readOnly: true as const,
  };
  return {
    ...publicSemantic,
    projectsRoot,
    candidates,
    fingerprint: digest(publicSemantic),
  };
}
