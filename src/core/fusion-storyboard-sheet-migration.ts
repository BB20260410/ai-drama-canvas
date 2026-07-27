import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { RejectedCommandFailure } from "./command-outcome.js";
import { withProjectLock } from "./locks.js";
import { getSidecarPaths, loadIndex, writeJsonAtomic } from "./sidecar.js";
import {
  buildFusionStoryboardSheetLegacyRecord,
  fusionStoryboardSheetLegacyRecordMatches,
  loadFusionStoryboardSheetStore,
  type FusionStoryboardSheetArtifactRole,
  type FusionStoryboardSheetLegacyRecord,
  type FusionStoryboardSheetLegacyRecordInput,
  type FusionStoryboardSheetStore,
} from "./fusion-storyboard-sheet-store.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const RECEIPT_PATTERNS = ["**/*中文分镜故事板*.json", "**/*中文分镜板*.json"];

export interface FusionStoryboardSheetMigrationScope {
  /** 空数组代表整个工程；非空数组是排序、去重后的明确 item scope。 */
  itemIds: string[];
}

export interface FusionStoryboardSheetMigrationArtifactSummary {
  role: FusionStoryboardSheetArtifactRole;
  path: string;
  pageIndex?: number;
  pageCount: number;
  sha256: string;
  bytes: number;
}

export interface FusionStoryboardSheetMigrationCandidateSummary {
  sheetId: string;
  receiptPath: string;
  itemId: string;
  status: "stale" | "legacy-invalid";
  contractId?: string;
  requirementId?: string;
  reviewId?: string;
  artifacts: FusionStoryboardSheetMigrationArtifactSummary[];
  reason: string;
  pending: boolean;
}

export interface FusionStoryboardSheetMigrationPreview {
  schemaVersion: 1;
  kind: "fusion-storyboard-sheet-migration-preview";
  storeRevision: number;
  scope: FusionStoryboardSheetMigrationScope;
  candidateFingerprint: string;
  candidateCount: number;
  pendingCount: number;
  blockers: string[];
  canMigrate: boolean;
  candidates: FusionStoryboardSheetMigrationCandidateSummary[];
}

export interface FusionStoryboardSheetMigrationResult {
  schemaVersion: 1;
  kind: "fusion-storyboard-sheet-migration-result";
  applied: boolean;
  replayed: boolean;
  previousRevision: number;
  storeRevision: number;
  candidateFingerprint: string;
  candidateCount: number;
  pendingCount: number;
  created: number;
  unchanged: number;
  byStatus: { stale: number; legacyInvalid: number };
  sheetIds: string[];
}

interface LegacyReceiptArtifact {
  path: string;
  sha256: string;
  bytes: number;
}

interface LegacyReceiptV1 {
  schemaVersion: 1;
  kind: "fusion-storyboard-sheet-production-receipt";
  projectId: string;
  itemId: string;
  contractId: string;
  sourceFingerprint: string;
  productionFingerprint?: string;
  reviewId?: string;
  requirementId?: string;
  png: LegacyReceiptArtifact;
  svg: LegacyReceiptArtifact;
  width: number;
  height: number;
  panelCount: number;
  durationSeconds: number;
  renderPurpose: string;
  formalProductionEligible: boolean;
}

interface SafeFileEvidence {
  path: string;
  sha256: string;
  bytes: number;
}

interface SafeFileSnapshot extends SafeFileEvidence {
  content: Buffer;
}

interface CandidateInternal {
  summary: FusionStoryboardSheetMigrationCandidateSummary;
  input: FusionStoryboardSheetLegacyRecordInput;
  record: FusionStoryboardSheetLegacyRecord;
  fingerprintEvidence: {
    receipt: SafeFileEvidence;
    referencedOutputs: Array<SafeFileEvidence & { role: "png" | "svg" }>;
  };
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
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 不能为空。`);
  return value;
}

function sha256(value: unknown, label: string): string {
  const normalized = nonEmpty(value, label);
  if (!SHA256.test(normalized)) throw new Error(`${label} 必须是小写完整 SHA-256。`);
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${label} 必须是正整数。`);
  return value as number;
}

function normalizeScope(itemIds: readonly string[] | undefined): FusionStoryboardSheetMigrationScope {
  const normalized = [...new Set((itemIds ?? []).map((itemId) => nonEmpty(itemId, "migration itemId")))].sort((a, b) => a.localeCompare(b, "en"));
  for (const itemId of normalized) {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,199}$/u.test(itemId) || itemId === "." || itemId === "..") {
      throw new Error(`migration itemId 非法：${itemId}`);
    }
  }
  return { itemIds: normalized };
}

function inScope(scope: FusionStoryboardSheetMigrationScope, itemId: string): boolean {
  return scope.itemIds.length === 0 || scope.itemIds.includes(itemId);
}

async function safeFileEvidence(projectRoot: string, filePath: string, label: string): Promise<SafeFileSnapshot> {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} 必须是绝对路径。`);
  const root = path.resolve(projectRoot);
  const normalized = path.resolve(filePath);
  const relative = path.relative(root, normalized);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} 越出当前工程：${normalized}`);
  const [rootReal, fileReal, before] = await Promise.all([realpath(root), realpath(normalized), lstat(normalized)]);
  const expectedReal = path.resolve(rootReal, relative);
  if (fileReal !== expectedReal || before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} 必须是工程内非符号链接普通文件：${normalized}`);
  }
  const content = await readFile(normalized);
  const after = await lstat(normalized);
  if (!after.isFile() || after.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    || content.length !== before.size) {
    throw new Error(`${label} 在读取证据期间发生变化：${normalized}`);
  }
  return { path: normalized, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length, content };
}

function evidenceIdentity(snapshot: SafeFileSnapshot): SafeFileEvidence {
  return { path: snapshot.path, sha256: snapshot.sha256, bytes: snapshot.bytes };
}

function parseOutput(value: unknown, label: string): LegacyReceiptArtifact {
  if (!isRecord(value)) throw new Error(`${label} 结构无效。`);
  return {
    path: nonEmpty(value.path, `${label}.path`),
    sha256: sha256(value.sha256, `${label}.sha256`),
    bytes: positiveInteger(value.bytes, `${label}.bytes`),
  };
}

function parseReceipt(value: unknown): LegacyReceiptV1 {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "fusion-storyboard-sheet-production-receipt") {
    throw new Error("只接受 fusion-storyboard-sheet-production-receipt schema-v1。 ");
  }
  const receipt: LegacyReceiptV1 = {
    schemaVersion: 1,
    kind: "fusion-storyboard-sheet-production-receipt",
    projectId: nonEmpty(value.projectId, "projectId"),
    itemId: nonEmpty(value.itemId, "itemId"),
    contractId: nonEmpty(value.contractId, "contractId"),
    sourceFingerprint: sha256(value.sourceFingerprint, "sourceFingerprint"),
    ...(value.productionFingerprint === undefined ? {} : { productionFingerprint: sha256(value.productionFingerprint, "productionFingerprint") }),
    ...(value.reviewId === undefined ? {} : { reviewId: nonEmpty(value.reviewId, "reviewId") }),
    ...(value.requirementId === undefined ? {} : { requirementId: nonEmpty(value.requirementId, "requirementId") }),
    png: parseOutput(value.png, "png"),
    svg: parseOutput(value.svg, "svg"),
    width: positiveInteger(value.width, "width"),
    height: positiveInteger(value.height, "height"),
    panelCount: positiveInteger(value.panelCount, "panelCount"),
    durationSeconds: positiveInteger(value.durationSeconds, "durationSeconds"),
    renderPurpose: nonEmpty(value.renderPurpose, "renderPurpose"),
    formalProductionEligible: value.formalProductionEligible === true,
  };
  if (receipt.panelCount < 2 || receipt.panelCount > 6 || receipt.durationSeconds !== 15
    || receipt.renderPurpose !== "formal" || receipt.formalProductionEligible !== true) {
    throw new Error("v1 receipt 不是可识别的 2–6 格、15 秒正式历史故事板。 ");
  }
  return receipt;
}

function fileBlocker(filePath: string, error: unknown): string {
  return `${filePath}：${error instanceof Error ? error.message : String(error)}`;
}

async function discoverCandidates(
  projectRoot: string,
  scope: FusionStoryboardSheetMigrationScope,
): Promise<{ candidates: CandidateInternal[]; blockers: string[] }> {
  let index: Awaited<ReturnType<typeof loadIndex>>;
  try { index = await loadIndex(projectRoot); }
  catch (error) { return { candidates: [], blockers: [fileBlocker(getSidecarPaths(projectRoot).index, error)] }; }
  if (!index) return { candidates: [], blockers: [`${getSidecarPaths(projectRoot).index}：缺少当前权威扫描索引，拒绝迁移历史 receipt。`] };
  const receiptPaths = (await fg(RECEIPT_PATTERNS, {
    cwd: projectRoot,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    unique: true,
    ignore: [".aicanvas/**"],
  })).map((entry) => path.resolve(entry)).sort((a, b) => a.localeCompare(b, "en"));
  const candidates: CandidateInternal[] = [];
  const blockers: string[] = [];
  for (const receiptPath of receiptPaths) {
    try {
      const receiptFile = await safeFileEvidence(projectRoot, receiptPath, "legacy receipt");
      let raw: unknown;
      try { raw = JSON.parse(receiptFile.content.toString("utf8")); }
      catch { throw new Error("v1 receipt JSON 无法解析。 "); }
      const rawItemId = isRecord(raw) && typeof raw.itemId === "string" ? raw.itemId : undefined;
      if (rawItemId && !inScope(scope, rawItemId)) continue;
      const receipt = parseReceipt(raw);
      if (!inScope(scope, receipt.itemId)) continue;
      if (receipt.projectId !== index.project.id) {
        throw new Error(`receipt.projectId ${receipt.projectId} 与当前工程 ${index.project.id} 不一致。`);
      }
      const currentItem = index.items.find((item) => item.id === receipt.itemId);
      if (!currentItem || currentItem.type !== "unit") {
        throw new Error(`receipt.itemId 不是当前扫描索引中的 unit：${receipt.itemId}`);
      }
      const outputEvidence = await Promise.all((["png", "svg"] as const).map(async (role) => {
        const declared = receipt[role];
        const observed = await safeFileEvidence(projectRoot, declared.path, `legacy ${role.toUpperCase()} 输出`);
        if (observed.sha256 !== declared.sha256 || observed.bytes !== declared.bytes) {
          throw new Error(`legacy ${role.toUpperCase()} 输出 SHA/size 已漂移：${observed.path}`);
        }
        return { ...evidenceIdentity(observed), role };
      }));
      const hasReviewClosure = Boolean(receipt.reviewId && receipt.requirementId);
      const status = hasReviewClosure ? "stale" as const : "legacy-invalid" as const;
      const reason = hasReviewClosure
        ? "schema-v1 历史板绑定旧 Review/requirement，但未冻结 P4 当前完整证据，只能登记为 stale"
        : "schema-v1 历史 receipt 未同时绑定 Review/requirement，只登记 receipt 且永久 legacy-invalid";
      const claimedArtifacts: FusionStoryboardSheetMigrationArtifactSummary[] = [
        ...(hasReviewClosure ? outputEvidence.map((artifact) => ({
          role: artifact.role,
          path: artifact.path,
          pageIndex: 1,
          pageCount: 1,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
        })) : []),
        { role: "receipt", path: receiptFile.path, pageCount: 1, sha256: receiptFile.sha256, bytes: receiptFile.bytes },
      ];
      const input: FusionStoryboardSheetLegacyRecordInput = {
        itemId: receipt.itemId,
        status,
        contractId: receipt.contractId,
        ...(receipt.requirementId ? { requirementId: receipt.requirementId } : {}),
        ...(receipt.reviewId ? { reviewId: receipt.reviewId } : {}),
        receiptPath,
        artifacts: claimedArtifacts.map((artifact) => ({ ...artifact })),
        reason,
      };
      const record = buildFusionStoryboardSheetLegacyRecord(input, new Date(0).toISOString());
      candidates.push({
        input,
        record,
        summary: {
          sheetId: record.sheetId,
          receiptPath,
          itemId: receipt.itemId,
          status,
          contractId: receipt.contractId,
          ...(receipt.requirementId ? { requirementId: receipt.requirementId } : {}),
          ...(receipt.reviewId ? { reviewId: receipt.reviewId } : {}),
          artifacts: claimedArtifacts,
          reason,
          pending: true,
        },
        fingerprintEvidence: { receipt: evidenceIdentity(receiptFile), referencedOutputs: outputEvidence },
      });
    } catch (error) {
      blockers.push(fileBlocker(receiptPath, error));
    }
  }
  return { candidates, blockers };
}

function registeredPaths(store: FusionStoryboardSheetStore): Map<string, string> {
  const owners = new Map<string, string>();
  for (const record of Object.values(store.records)) {
    owners.set(path.resolve(record.receiptPath), record.sheetId);
    for (const artifact of record.outputs) owners.set(path.resolve(artifact.path), record.sheetId);
  }
  for (const record of Object.values(store.legacyRecords)) {
    for (const artifact of record.artifacts) owners.set(path.resolve(artifact.path), record.sheetId);
  }
  return owners;
}

async function buildPreview(
  projectRoot: string,
  scope: FusionStoryboardSheetMigrationScope,
  store: FusionStoryboardSheetStore,
): Promise<{ preview: FusionStoryboardSheetMigrationPreview; candidates: CandidateInternal[] }> {
  const discovered = await discoverCandidates(projectRoot, scope);
  const blockers = [...discovered.blockers];
  const owners = registeredPaths(store);
  const candidateOwners = new Map<string, string>();
  for (const candidate of discovered.candidates) {
    const existing = store.legacyRecords[candidate.record.sheetId];
    if (existing) {
      if (!fusionStoryboardSheetLegacyRecordMatches(existing, candidate.record)) {
        blockers.push(`legacy sheetId 已登记为不同历史身份：${candidate.record.sheetId}`);
      } else candidate.summary.pending = false;
    }
    for (const artifact of candidate.summary.artifacts) {
      const artifactPath = path.resolve(artifact.path);
      const existingOwner = owners.get(artifactPath);
      if (existingOwner && existingOwner !== candidate.record.sheetId) {
        blockers.push(`历史 Artifact 路径已被 ${existingOwner} 占用：${artifactPath}`);
      }
      const candidateOwner = candidateOwners.get(artifactPath);
      if (candidateOwner && candidateOwner !== candidate.record.sheetId) {
        blockers.push(`同批历史候选共享 Artifact 路径：${artifactPath}`);
      } else candidateOwners.set(artifactPath, candidate.record.sheetId);
    }
  }
  const candidates = discovered.candidates.sort((left, right) => left.summary.receiptPath.localeCompare(right.summary.receiptPath, "en"));
  const uniqueBlockers = [...new Set(blockers)].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const candidateFingerprint = digest({
    schemaVersion: 1,
    algorithm: "fusion-storyboard-sheet-v1-migration-candidates-v1",
    scope,
    candidates: candidates.map((candidate) => ({
      input: candidate.input,
      receipt: candidate.fingerprintEvidence.receipt,
      referencedOutputs: candidate.fingerprintEvidence.referencedOutputs,
    })),
    discoveryBlockers: discovered.blockers.slice().sort((a, b) => a.localeCompare(b, "zh-CN")),
  });
  const pendingCount = candidates.filter((candidate) => candidate.summary.pending).length;
  return {
    preview: {
      schemaVersion: 1,
      kind: "fusion-storyboard-sheet-migration-preview",
      storeRevision: store.revision,
      scope,
      candidateFingerprint,
      candidateCount: candidates.length,
      pendingCount,
      blockers: uniqueBlockers,
      canMigrate: uniqueBlockers.length === 0 && pendingCount > 0,
      candidates: candidates.map((candidate) => structuredClone(candidate.summary)),
    },
    candidates,
  };
}

export async function previewFusionStoryboardSheetMigration(
  projectRoot: string,
  input: { itemIds?: string[] } = {},
  options: { store?: FusionStoryboardSheetStore } = {},
): Promise<FusionStoryboardSheetMigrationPreview> {
  const scope = normalizeScope(input.itemIds);
  const store = options.store ?? await loadFusionStoryboardSheetStore(projectRoot);
  return (await buildPreview(projectRoot, scope, store)).preview;
}

function rejectMigration(
  message: string,
  reason: string,
  input: { expectedStoreRevision: number; expectedCandidateFingerprint: string },
  preview: FusionStoryboardSheetMigrationPreview,
): never {
  throw new RejectedCommandFailure(message, {
    schemaVersion: 1,
    applied: false,
    reason,
    expectedRevision: input.expectedStoreRevision,
    currentRevision: preview.storeRevision,
    expectedCandidateFingerprint: input.expectedCandidateFingerprint,
    currentCandidateFingerprint: preview.candidateFingerprint,
    blockers: preview.blockers,
  });
}

export async function migrateFusionStoryboardSheets(projectRoot: string, input: {
  itemIds?: string[];
  expectedStoreRevision: number;
  expectedCandidateFingerprint: string;
}): Promise<FusionStoryboardSheetMigrationResult> {
  const scope = normalizeScope(input.itemIds);
  if (!Number.isInteger(input.expectedStoreRevision) || input.expectedStoreRevision < 0 || !SHA256.test(input.expectedCandidateFingerprint)) {
    throw new RejectedCommandFailure("P4 migration 必须提供非负 expectedStoreRevision 与小写完整候选指纹。", {
      schemaVersion: 1,
      applied: false,
      reason: "invalid_precondition",
      expectedRevision: input.expectedStoreRevision,
      expectedCandidateFingerprint: input.expectedCandidateFingerprint,
    });
  }
  return withProjectLock(projectRoot, "storyboard-sheet-index", async () => {
    const store = await loadFusionStoryboardSheetStore(projectRoot);
    const { preview, candidates } = await buildPreview(projectRoot, scope, store);
    if (preview.candidateFingerprint !== input.expectedCandidateFingerprint) {
      rejectMigration("P4 migration 候选内容已漂移，请重新预览后重试。", "candidate_drift", input, preview);
    }
    if (preview.blockers.length) {
      rejectMigration("P4 migration 存在不安全或冲突候选，已零写入拒绝。", "unsafe_candidates", input, preview);
    }
    const pending = candidates.filter((candidate) => candidate.summary.pending);
    const byStatus = {
      stale: candidates.filter((candidate) => candidate.summary.status === "stale").length,
      legacyInvalid: candidates.filter((candidate) => candidate.summary.status === "legacy-invalid").length,
    };
    const resultBase = {
      schemaVersion: 1 as const,
      kind: "fusion-storyboard-sheet-migration-result" as const,
      previousRevision: store.revision,
      candidateFingerprint: preview.candidateFingerprint,
      candidateCount: preview.candidateCount,
      pendingCount: preview.pendingCount,
      byStatus,
      sheetIds: candidates.map((candidate) => candidate.record.sheetId).sort((a, b) => a.localeCompare(b, "en")),
    };
    if (pending.length === 0) {
      return { ...resultBase, applied: false, replayed: true, storeRevision: store.revision, created: 0, unchanged: candidates.length };
    }
    if (store.revision !== input.expectedStoreRevision) {
      rejectMigration("P4 migration store revision 已变化，请重新预览后重试。", "revision_conflict", input, preview);
    }
    const registeredAt = new Date().toISOString();
    for (const candidate of pending) {
      const record = buildFusionStoryboardSheetLegacyRecord(candidate.input, registeredAt);
      store.legacyRecords[record.sheetId] = record;
    }
    store.revision += 1;
    store.updatedAt = registeredAt;
    await writeJsonAtomic(getSidecarPaths(projectRoot).storyboardSheetIndex, store);
    return {
      ...resultBase,
      applied: true,
      replayed: false,
      storeRevision: store.revision,
      created: pending.length,
      unchanged: candidates.length - pending.length,
    };
  });
}
