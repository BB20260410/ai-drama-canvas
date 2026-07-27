import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { loadFusionProductionAssets, loadFusionProjectManifest, type FusionMaterializationReceipt, type FusionProductionAssetCatalog, type FusionProductionAssetEntry } from "./fusion-production.js";
import { reviewCoversArtifacts } from "./review-evidence.js";
import { getSidecarPaths, loadIndex, loadOverrides, loadProjectConfig, readJson, writeJsonAtomic } from "./sidecar.js";
import { getPublicationReceipt } from "./publication.js";
import type { Artifact, GenerationJob, ProjectIndex, ReviewRecord, ReviewStore } from "./types.js";
import { withProjectLock } from "./locks.js";

export const FUSION_ASSET_CONSISTENCY_BATCH_SIZE = 6 as const;
export const FUSION_ASSET_PRODUCTION_ORDER_VERSION = "hidden-mask-first-then-first-appearance-v1" as const;
export const FUSION_ASSET_CONSISTENCY_BOARD_RENDER_VERSION = "visible-tiles-v2" as const;

export const FUSION_ASSET_CONSISTENCY_CRITERIA = [
  "character_identity",
  "era_visual_style",
  "scene_layout_lighting",
  "scale_compatibility",
  "prop_structure",
  "clean_frame",
  "hidden_mask_rule",
] as const;

export type FusionAssetConsistencyCriterionKey = (typeof FUSION_ASSET_CONSISTENCY_CRITERIA)[number];
export type FusionAssetConsistencyCriterionResult = "pass" | "fail" | "na";
export type FusionAssetConsistencyBatchStatus = "collecting" | "generating" | "awaiting_item_reviews" | "awaiting_batch_review" | "passed" | "rework" | "invalidated";

export interface FusionAssetConsistencyMember {
  order: number;
  itemId: string;
  assetId: string;
  contractId: string;
  sourceSectionSha256: string;
  attemptJobIds: string[];
  currentJobId: string;
}

export interface FusionAssetConsistencyEvidence {
  itemId: string;
  assetId: string;
  jobId: string;
  publicationReceiptId: string;
  individualReviewId: string;
  raw: { artifactId: string; path: string; sha256: string; size: number };
  labeled: { artifactId: string; path: string; sha256: string; size: number };
}

export interface FusionAssetConsistencyReviewBoard {
  path: string;
  metadataPath: string;
  sha256: string;
  width: number;
  height: number;
  snapshotHash: string;
  renderVersion: typeof FUSION_ASSET_CONSISTENCY_BOARD_RENDER_VERSION;
}

export interface FusionAssetConsistencyReview {
  id: string;
  decision: "pass" | "rework";
  storeRevision: number;
  snapshotHash: string;
  evidence: FusionAssetConsistencyEvidence[];
  authorityHashes: Array<{ id: string; name: string; snapshotPath: string; sha256: string }>;
  board: FusionAssetConsistencyReviewBoard;
  criteria: Array<{ key: FusionAssetConsistencyCriterionKey; result: FusionAssetConsistencyCriterionResult; note?: string }>;
  reworkItemIds?: string[];
  note?: string;
  reviewer: "user" | "codex";
  createdAt: string;
}

export interface FusionAssetConsistencyBatch {
  id: string;
  sequence: number;
  revision: number;
  sealed: boolean;
  sealedReason?: "batch_size_reached" | "final_partial";
  members: FusionAssetConsistencyMember[];
  reviews: FusionAssetConsistencyReview[];
  createdAt: string;
  sealedAt?: string;
  updatedAt: string;
}

export interface FusionAssetConsistencyStore {
  schemaVersion: 1;
  kind: "fusion-asset-consistency";
  projectId: string;
  sourceContentAddress: `sha256:${string}`;
  batchSize: typeof FUSION_ASSET_CONSISTENCY_BATCH_SIZE;
  revision: number;
  batches: FusionAssetConsistencyBatch[];
  updatedAt: string;
}

export interface FusionAssetConsistencyMemberState extends FusionAssetConsistencyMember {
  assetName: string;
  category: FusionProductionAssetEntry["definition"]["category"];
  jobStatus?: GenerationJob["status"];
  ready: boolean;
  issues: string[];
  evidence?: FusionAssetConsistencyEvidence;
  hardLocked: boolean;
}

export interface FusionAssetConsistencyBatchState {
  id: string;
  sequence: number;
  revision: number;
  status: FusionAssetConsistencyBatchStatus;
  sealed: boolean;
  sealedReason?: FusionAssetConsistencyBatch["sealedReason"];
  members: FusionAssetConsistencyMemberState[];
  memberCount: number;
  readyCount: number;
  hardLockCount: number;
  includesHiddenMaskAsset: boolean;
  requiredCriteria: FusionAssetConsistencyCriterionKey[];
  currentSnapshotHash?: string;
  authorityHashes: Array<{ id: string; name: string; snapshotPath: string; sha256: string }>;
  authorityIssues: string[];
  review?: FusionAssetConsistencyReview;
  reviewValid: boolean;
  canPrepareReview: boolean;
  canStartNextBatch: boolean;
  blockingIssues: string[];
}

export interface FusionAssetConsistencyState {
  schemaVersion: 1;
  kind: "fusion-asset-consistency-state";
  projectId: string;
  sourceContentAddress: `sha256:${string}`;
  storeRevision: number;
  persisted: boolean;
  batchSize: typeof FUSION_ASSET_CONSISTENCY_BATCH_SIZE;
  batches: FusionAssetConsistencyBatchState[];
  openBatchId?: string;
  canEnqueueNewAsset: boolean;
  productionOrder: {
    version: typeof FUSION_ASSET_PRODUCTION_ORDER_VERSION;
    totalAssets: number;
    reservedAssets: number;
    nextAssetId?: string;
    nextBatchAssetIds: string[];
  };
  blockingIssues: string[];
  updatedAt: string;
}

export interface SubmitFusionAssetConsistencyReviewInput {
  batchId: string;
  expectedRevision: number;
  expectedSnapshotHash: string;
  decision: "pass" | "rework";
  criteria: Array<{ key: FusionAssetConsistencyCriterionKey; result: FusionAssetConsistencyCriterionResult; note?: string }>;
  reworkItemIds?: string[];
  note?: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stableValue(entry)]));
  return value;
}

function sha256Json(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} 不是有效 SHA-256。`);
}

function validateStore(value: unknown, filePath: string): FusionAssetConsistencyStore | null {
  if (value === null) return null;
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "fusion-asset-consistency"
    || typeof value.projectId !== "string"
    || typeof value.sourceContentAddress !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(value.sourceContentAddress)
    || value.batchSize !== FUSION_ASSET_CONSISTENCY_BATCH_SIZE
    || !Number.isInteger(value.revision) || Number(value.revision) < 1
    || typeof value.updatedAt !== "string"
    || !Array.isArray(value.batches)) {
    throw new Error(`六张一致性侧车结构无效，已停止写入：${filePath}`);
  }
  const seenBatchIds = new Set<string>();
  const seenItems = new Set<string>();
  const seenJobs = new Set<string>();
  let expectedSequence = 1;
  for (const rawBatch of value.batches) {
    if (!isRecord(rawBatch)
      || typeof rawBatch.id !== "string"
      || !Number.isInteger(rawBatch.sequence) || rawBatch.sequence !== expectedSequence
      || !Number.isInteger(rawBatch.revision) || Number(rawBatch.revision) < 1
      || typeof rawBatch.sealed !== "boolean"
      || (rawBatch.sealedReason !== undefined && !["batch_size_reached", "final_partial"].includes(String(rawBatch.sealedReason)))
      || !Array.isArray(rawBatch.members) || rawBatch.members.length > FUSION_ASSET_CONSISTENCY_BATCH_SIZE
      || !Array.isArray(rawBatch.reviews)
      || typeof rawBatch.createdAt !== "string" || typeof rawBatch.updatedAt !== "string") {
      throw new Error(`六张一致性批次 ${expectedSequence} 结构无效，已停止写入：${filePath}`);
    }
    if (seenBatchIds.has(rawBatch.id)) throw new Error(`六张一致性批次 ID 重复：${rawBatch.id}`);
    seenBatchIds.add(rawBatch.id);
    if (rawBatch.members.length === FUSION_ASSET_CONSISTENCY_BATCH_SIZE && (!rawBatch.sealed || rawBatch.sealedReason !== "batch_size_reached")) {
      throw new Error(`完整六张批次 ${rawBatch.id} 必须以 batch_size_reached 封存。`);
    }
    let expectedOrder = 1;
    for (const member of rawBatch.members) {
      if (!isRecord(member)
        || member.order !== expectedOrder
        || typeof member.itemId !== "string"
        || typeof member.assetId !== "string"
        || typeof member.contractId !== "string"
        || typeof member.sourceSectionSha256 !== "string"
        || !Array.isArray(member.attemptJobIds) || !member.attemptJobIds.length || !member.attemptJobIds.every((entry) => typeof entry === "string")
        || typeof member.currentJobId !== "string"
        || !member.attemptJobIds.includes(member.currentJobId)) {
        throw new Error(`六张一致性批次 ${rawBatch.id} 的第 ${expectedOrder} 项结构无效。`);
      }
      assertSha256(member.sourceSectionSha256, `${member.assetId} 来源段`);
      if (seenItems.has(member.itemId)) throw new Error(`资产 ${member.itemId} 被重复分配到多个一致性批次。`);
      seenItems.add(member.itemId);
      for (const jobId of member.attemptJobIds) {
        if (seenJobs.has(jobId)) throw new Error(`生成任务 ${jobId} 被重复分配到一致性批次。`);
        seenJobs.add(jobId);
      }
      expectedOrder += 1;
    }
    expectedSequence += 1;
  }
  return value as unknown as FusionAssetConsistencyStore;
}

async function loadStore(projectRoot: string): Promise<FusionAssetConsistencyStore | null> {
  const filePath = getSidecarPaths(projectRoot).assetConsistencyBatches;
  return validateStore(await readJson<unknown>(filePath, null), filePath);
}

async function fusionIdentity(projectRoot: string): Promise<{ manifest: NonNullable<Awaited<ReturnType<typeof loadFusionProjectManifest>>>; catalog: FusionProductionAssetCatalog }> {
  const [manifest, catalog] = await Promise.all([loadFusionProjectManifest(projectRoot), loadFusionProductionAssets(projectRoot)]);
  if (!manifest || !catalog) throw new Error("当前工程不是已物化的第三季融合工程，不能使用六张一致性门禁。");
  if (manifest.projectId !== catalog.projectId || manifest.contentAddress !== catalog.sourceContentAddress) throw new Error("融合 manifest 与资产目录身份冲突，六张一致性门禁已失败关闭。");
  return { manifest, catalog };
}

type FusionManifest = NonNullable<Awaited<ReturnType<typeof loadFusionProjectManifest>>>;

function orderedProductionAssets(manifest: FusionManifest, catalog: FusionProductionAssetCatalog): FusionProductionAssetEntry[] {
  const byId = new Map(catalog.assets.map((entry) => [entry.definition.id, entry]));
  const ordered: FusionProductionAssetEntry[] = [];
  const seen = new Set<string>();
  const add = (assetId: string, source: string): void => {
    if (seen.has(assetId)) return;
    const entry = byId.get(assetId);
    if (!entry) throw new Error(`${source} 引用了资产 ${assetId}，但冻结资产目录不存在该资产。`);
    seen.add(assetId);
    if (!entry.authority) ordered.push(entry);
  };
  if (byId.has("P01")) add("P01", "隐藏面具优先规则");
  for (const unit of [...manifest.units].sort((left, right) => left.episodeNumber - right.episodeNumber || left.sequence - right.sequence || left.id.localeCompare(right.id))) {
    for (const assetId of unit.assetIds) add(assetId, `${unit.episode} 15s-${String(unit.sequence).padStart(3, "0")}`);
  }
  for (const entry of [...catalog.assets].sort((left, right) => left.definition.id.localeCompare(right.definition.id))) add(entry.definition.id, "冻结资产目录补全");
  const expected = catalog.assets.filter((entry) => !entry.authority);
  if (ordered.length !== expected.length || new Set(ordered.map((entry) => entry.definition.id)).size !== expected.length) {
    throw new Error("冻结资产生产顺序没有完整且唯一覆盖全部非权威资产。 ");
  }
  return ordered;
}

function orderedStoreMembers(store: FusionAssetConsistencyStore): FusionAssetConsistencyMember[] {
  return [...store.batches]
    .sort((left, right) => left.sequence - right.sequence)
    .flatMap((batch) => [...batch.members].sort((left, right) => left.order - right.order));
}

function assertStoreProductionOrder(store: FusionAssetConsistencyStore, manifest: FusionManifest, catalog: FusionProductionAssetCatalog): FusionProductionAssetEntry[] {
  const order = orderedProductionAssets(manifest, catalog);
  const members = orderedStoreMembers(store);
  if (members.length > order.length) throw new Error("六张一致性侧车的资产数量超过冻结生产顺序。 ");
  for (const [index, member] of members.entries()) {
    const expected = order[index];
    if (!expected || member.assetId !== expected.definition.id || member.itemId !== expected.workItemId) {
      throw new Error(`资产首次出场顺序冲突：第 ${index + 1} 项必须是 ${expected?.definition.id ?? "<none>"}，实际为 ${member.assetId}。`);
    }
  }
  return order;
}

function emptyStore(projectId: string, sourceContentAddress: `sha256:${string}`, timestamp: string): FusionAssetConsistencyStore {
  return { schemaVersion: 1, kind: "fusion-asset-consistency", projectId, sourceContentAddress, batchSize: FUSION_ASSET_CONSISTENCY_BATCH_SIZE, revision: 1, batches: [], updatedAt: timestamp };
}

function assetEntryForJob(catalog: FusionProductionAssetCatalog, job: GenerationJob): FusionProductionAssetEntry {
  const entry = catalog.assets.find((candidate) => candidate.workItemId === job.itemId);
  if (!entry) throw new Error(`资产任务 ${job.id} 的节点 ${job.itemId} 不在冻结资产目录中。`);
  if (entry.authority) throw new Error(`资产 ${entry.definition.id} 已有用户权威参考，不能进入新资产生图批次。`);
  if (job.fusionAssetContract && (job.fusionAssetContract.assetId !== entry.definition.id || job.fusionAssetContract.contractId !== entry.contract.contractId || job.fusionAssetContract.sourceSectionSha256 !== entry.definition.sourceSectionSha256)) {
    throw new Error(`资产任务 ${job.id} 的冻结合同身份已偏离当前 CAS 资产目录。`);
  }
  return entry;
}

function hasPossibleRemoteSideEffect(job: GenerationJob): boolean {
  // codex-browser 在仅建立 plan_ready 本地操作计划时已有通用 submissionIntent，
  // 但尚未点击网页 Generate；只有浏览器专用提交意图或远端身份才算副作用。
  return Boolean(job.externalTaskId || job.browserCheckpoint?.submissionIntent)
    || ["submitting", "submission_unknown", "waiting_remote", "succeeded"].includes(job.status)
    || ["submission_unknown", "submitted", "processing", "downloaded", "verified"].includes(job.browserCheckpoint?.stage ?? "");
}

function bootstrapStore(catalog: FusionProductionAssetCatalog, jobs: GenerationJob[], timestamp: string): FusionAssetConsistencyStore {
  const store = emptyStore(catalog.projectId, catalog.sourceContentAddress, timestamp);
  const assetJobs = jobs.filter((job) => job.kind === "image" && job.purpose === "asset").sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  if (!assetJobs.length) return store;
  const byItem = new Map<string, GenerationJob[]>();
  for (const job of assetJobs) {
    const entry = assetEntryForJob(catalog, job);
    const attempts = byItem.get(job.itemId) ?? [];
    attempts.push(job);
    byItem.set(job.itemId, attempts);
    if (attempts.length > 1 || hasPossibleRemoteSideEffect(job)) {
      throw new Error(`资产任务 ${job.id} 已有远端副作用、成功结果或历史重试，不能在缺失批次侧车时猜测接管；已失败关闭。`);
    }
    if (job.status === "waiting_external" && job.browserCheckpoint?.stage !== "plan_ready") {
      throw new Error(`资产任务 ${job.id} 已越过 plan_ready，不能在缺失批次侧车时自动接管。`);
    }
    if (!["queued", "waiting_external"].includes(job.status)) throw new Error(`资产任务 ${job.id} 状态为 ${job.status}，不能安全自动接管。`);
    void entry;
  }
  const unique = [...byItem.values()].map((attempts) => attempts[0]!).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  for (let offset = 0; offset < unique.length; offset += FUSION_ASSET_CONSISTENCY_BATCH_SIZE) {
    const slice = unique.slice(offset, offset + FUSION_ASSET_CONSISTENCY_BATCH_SIZE);
    const sequence = store.batches.length + 1;
    const sealed = slice.length === FUSION_ASSET_CONSISTENCY_BATCH_SIZE;
    store.batches.push({
      id: `fusion-asset-batch-${String(sequence).padStart(3, "0")}`,
      sequence,
      revision: 1,
      sealed,
      sealedReason: sealed ? "batch_size_reached" : undefined,
      members: slice.map((job, index) => {
        const entry = assetEntryForJob(catalog, job);
        return { order: index + 1, itemId: job.itemId, assetId: entry.definition.id, contractId: entry.contract.contractId, sourceSectionSha256: entry.definition.sourceSectionSha256, attemptJobIds: [job.id], currentJobId: job.id };
      }),
      reviews: [],
      createdAt: slice[0]!.createdAt,
      sealedAt: sealed ? slice.at(-1)!.createdAt : undefined,
      updatedAt: slice.at(-1)!.updatedAt,
    });
  }
  store.updatedAt = timestamp;
  return store;
}

async function ensureStoreLocked(projectRoot: string, jobs: GenerationJob[]): Promise<FusionAssetConsistencyStore> {
  const { manifest, catalog } = await fusionIdentity(projectRoot);
  let store = await loadStore(projectRoot);
  if (!store) {
    store = bootstrapStore(catalog, jobs, new Date().toISOString());
    assertStoreProductionOrder(store, manifest, catalog);
    await writeJsonAtomic(getSidecarPaths(projectRoot).assetConsistencyBatches, store);
  }
  if (store.projectId !== manifest.projectId || store.sourceContentAddress !== manifest.contentAddress) throw new Error("六张一致性侧车与融合工程内容地址不一致，已失败关闭。");
  assertStoreProductionOrder(store, manifest, catalog);
  return store;
}

async function readJobs(projectRoot: string): Promise<GenerationJob[]> {
  return readJson<GenerationJob[]>(getSidecarPaths(projectRoot).generationJobs, []);
}

export async function initializeFusionAssetConsistency(projectRoot: string): Promise<FusionAssetConsistencyState> {
  await withProjectLock(projectRoot, "generation", async () => {
    const jobs = await readJobs(projectRoot);
    await withProjectLock(projectRoot, "asset-consistency", () => ensureStoreLocked(projectRoot, jobs));
  });
  return getFusionAssetConsistencyState(projectRoot);
}

async function digestCurrentFile(filePath: string): Promise<{ sha256: string; size: number }> {
  const before = await stat(filePath);
  if (!before.isFile() || before.size <= 0) throw new Error(`一致性证据文件不是可读取的非空常规文件：${filePath}`);
  const bytes = await readFile(filePath);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`一致性证据读取期间发生变化：${filePath}`);
  return { sha256: sha256(bytes), size: bytes.length };
}

function currentAssetPair(index: ProjectIndex, itemId: string): { raw?: Artifact; labeled?: Artifact } {
  const item = index.items.find((candidate) => candidate.id === itemId && candidate.type === "asset");
  if (!item) return {};
  const active = index.artifacts.filter((artifact) => artifact.itemId === itemId && item.artifactIds.includes(artifact.id) && artifact.authoritative && !artifact.deprecated && artifact.variant === "generic");
  return { raw: active.find((artifact) => artifact.kind === "raw-image"), labeled: active.find((artifact) => artifact.kind === "labeled-image") };
}

function currentIndividualReview(itemId: string, raw: Artifact, labeled: Artifact, reviews: ReviewStore, explicitReviewId?: string): ReviewRecord | undefined {
  const candidates = reviews.records.filter((record) => record.itemId === itemId && record.reviewType === "image" && record.decision === "pass" && record.resultingStatus === "已完成").sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (explicitReviewId) {
    const explicit = candidates.find((record) => record.id === explicitReviewId);
    return reviewCoversArtifacts(explicit, [raw, labeled]) ? explicit : undefined;
  }
  return candidates.find((record) => reviewCoversArtifacts(record, [raw, labeled]));
}

async function authoritySnapshot(projectRoot: string, sourceContentAddress: string): Promise<{ values: Array<{ id: string; name: string; snapshotPath: string; sha256: string }>; issues: string[] }> {
  const receipt = await readJson<FusionMaterializationReceipt | null>(path.join(projectRoot, "fusion-production-materialization.json"), null);
  if (!receipt || receipt.sourceContentAddress !== sourceContentAddress) return { values: [], issues: ["物化回执缺失或与当前内容地址不一致"] };
  const values: Array<{ id: string; name: string; snapshotPath: string; sha256: string }> = [];
  const issues: string[] = [];
  for (const authority of receipt.authorities) {
    try {
      const actual = await digestCurrentFile(authority.snapshotPath);
      if (actual.sha256 !== authority.snapshotSha256) issues.push(`权威参考 ${authority.id} 已漂移`);
      else values.push({ id: authority.id, name: authority.name, snapshotPath: authority.snapshotPath, sha256: actual.sha256 });
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  values.sort((left, right) => left.id.localeCompare(right.id));
  return { values, issues };
}

async function computeState(projectRoot: string, store: FusionAssetConsistencyStore, persisted: boolean, jobs: GenerationJob[], catalog: FusionProductionAssetCatalog, manifest: FusionManifest): Promise<FusionAssetConsistencyState> {
  const [index, overrides, reviews, config, authorities] = await Promise.all([
    loadIndex(projectRoot),
    loadOverrides(projectRoot),
    readJson<ReviewStore>(getSidecarPaths(projectRoot).reviews, { schemaVersion: 1, records: [] }),
    loadProjectConfig(projectRoot),
    authoritySnapshot(projectRoot, store.sourceContentAddress),
  ]);
  if (!index) throw new Error("六张一致性门禁要求已有真实扫描索引。");
  if (index.project.id !== store.projectId || path.resolve(index.project.primaryRoot) !== path.resolve(projectRoot)) throw new Error("扫描索引不属于当前六张一致性工程。");
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const hardLocksById = new Map(config.hardLocks.map((lock) => [lock.id, lock]));
  const batchStates: FusionAssetConsistencyBatchState[] = [];
  for (const batch of store.batches) {
    const members: FusionAssetConsistencyMemberState[] = [];
    for (const member of batch.members) {
      const entry = catalog.assets.find((candidate) => candidate.workItemId === member.itemId);
      const issues: string[] = [];
      if (!entry || entry.definition.id !== member.assetId || entry.contract.contractId !== member.contractId || entry.definition.sourceSectionSha256 !== member.sourceSectionSha256) issues.push("资产合同与冻结批次身份不一致");
      const job = jobsById.get(member.currentJobId);
      if (!job) issues.push(`当前生成任务不存在：${member.currentJobId}`);
      else {
        if (!member.attemptJobIds.includes(job.id)) issues.push("当前生成任务不在批次尝试列表中");
        if (job.itemId !== member.itemId || job.purpose !== "asset" || job.kind !== "image") issues.push("当前生成任务类型或归属错误");
        if (job.assetConsistencyBatchId && job.assetConsistencyBatchId !== batch.id) issues.push("生成任务记录了不同的一致性批次");
        if (job.fusionAssetContract && (job.fusionAssetContract.assetId !== member.assetId || job.fusionAssetContract.contractId !== member.contractId || job.fusionAssetContract.sourceSectionSha256 !== member.sourceSectionSha256)) issues.push("生成任务冻结合同与批次不一致");
        if (job.status !== "succeeded") issues.push(`当前生成任务尚未成功：${job.status}`);
      }
      const pair = currentAssetPair(index, member.itemId);
      if (!pair.raw?.check.ok || pair.raw.check.decodable === false || !pair.raw.check.sha256) issues.push("缺少机械验收通过且带 SHA 的权威 generic raw");
      if (!pair.labeled?.check.ok || pair.labeled.check.decodable === false || !pair.labeled.check.sha256) issues.push("缺少机械验收通过且带 SHA 的权威 generic labeled");
      let rawDigest: { sha256: string; size: number } | undefined;
      let labeledDigest: { sha256: string; size: number } | undefined;
      if (pair.raw?.check.sha256) {
        try {
          rawDigest = await digestCurrentFile(pair.raw.path);
          if (rawDigest.sha256 !== pair.raw.check.sha256 || rawDigest.size !== pair.raw.check.size) issues.push("权威 raw 已偏离扫描索引内容");
        } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
      }
      if (pair.labeled?.check.sha256) {
        try {
          labeledDigest = await digestCurrentFile(pair.labeled.path);
          if (labeledDigest.sha256 !== pair.labeled.check.sha256 || labeledDigest.size !== pair.labeled.check.size) issues.push("权威 labeled 已偏离扫描索引内容");
        } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
      }
      const individual = pair.raw && pair.labeled ? currentIndividualReview(member.itemId, pair.raw, pair.labeled, reviews, overrides.items[member.itemId]?.reviewEvidenceIds?.image) : undefined;
      if (!individual) issues.push("缺少绑定当前 raw/labeled 内容的单图视觉通过 Review");
      const receipt = job?.publicationReceiptId ? await getPublicationReceipt(projectRoot, job.publicationReceiptId) : undefined;
      if (!receipt) issues.push("缺少当前生成任务的 Publication 回执");
      else if (!pair.raw || path.resolve(receipt.targetPath) !== path.resolve(pair.raw.path) || receipt.check.sha256 !== pair.raw.check.sha256) issues.push("Publication 回执与当前权威 raw 不一致");
      if (job?.publicationBundleId) {
        const companionReceipt = job.companionPublicationReceiptId ? await getPublicationReceipt(projectRoot, job.companionPublicationReceiptId) : undefined;
        if (!companionReceipt) issues.push("缺少当前生成任务的 labeled Publication bundle 回执");
        else if (!pair.labeled
          || receipt?.bundleId !== job.publicationBundleId
          || receipt?.bundleMember !== "primary"
          || companionReceipt.bundleId !== job.publicationBundleId
          || companionReceipt.bundleMember !== "companion"
          || path.resolve(companionReceipt.targetPath) !== path.resolve(pair.labeled.path)
          || companionReceipt.check.sha256 !== pair.labeled.check.sha256) {
          issues.push("raw/labeled Publication bundle 与当前权威配对不一致");
        }
      }
      if (job && pair.raw && (job.resultPath && path.resolve(job.resultPath) !== path.resolve(pair.raw.path) || job.resultSha256 && job.resultSha256 !== pair.raw.check.sha256)) issues.push("生成任务结果身份与当前权威 raw 不一致");
      if (job && pair.labeled && job.companionPath && path.resolve(job.companionPath) !== path.resolve(pair.labeled.path)) issues.push("生成任务 labeled 路径与当前权威配对不一致");
      const evidence = !issues.length && job && receipt && individual && pair.raw?.check.sha256 && pair.labeled?.check.sha256 && rawDigest && labeledDigest
        ? {
            itemId: member.itemId,
            assetId: member.assetId,
            jobId: job.id,
            publicationReceiptId: receipt.id,
            individualReviewId: individual.id,
            raw: { artifactId: pair.raw.id, path: pair.raw.path, sha256: rawDigest.sha256, size: rawDigest.size },
            labeled: { artifactId: pair.labeled.id, path: pair.labeled.path, sha256: labeledDigest.sha256, size: labeledDigest.size },
          } satisfies FusionAssetConsistencyEvidence
        : undefined;
      const lock = hardLocksById.get(member.assetId);
      const hardLocked = Boolean(lock && pair.raw && path.resolve(lock.path) === path.resolve(pair.raw.path));
      members.push({ ...member, assetName: entry?.definition.name ?? member.assetId, category: entry?.definition.category ?? "prop", jobStatus: job?.status, ready: Boolean(evidence), issues, evidence, hardLocked });
    }
    const evidence = members.map((member) => member.evidence).filter((entry): entry is FusionAssetConsistencyEvidence => Boolean(entry));
    const currentSnapshotHash = evidence.length === members.length && batch.sealed && !authorities.issues.length
      ? sha256Json({ schemaVersion: 1, projectId: store.projectId, sourceContentAddress: store.sourceContentAddress, batchId: batch.id, members: evidence, authorities: authorities.values })
      : undefined;
    const review = batch.reviews.at(-1);
    const reviewValid = Boolean(review?.decision === "pass" && currentSnapshotHash && review.snapshotHash === currentSnapshotHash && review.evidence.length === evidence.length && review.authorityHashes.length === authorities.values.length);
    const includesHiddenMaskAsset = members.some((member) => member.assetId === "P01");
    let status: FusionAssetConsistencyBatchStatus;
    if (review?.decision === "pass") status = reviewValid ? "passed" : "invalidated";
    else if (review?.decision === "rework") status = "rework";
    else if (!batch.sealed) status = "collecting";
    else if (members.some((member) => member.jobStatus !== "succeeded")) status = "generating";
    else if (evidence.length !== members.length || authorities.issues.length) status = "awaiting_item_reviews";
    else status = "awaiting_batch_review";
    const hardLockCount = members.filter((member) => member.hardLocked).length;
    const canStartNextBatch = status === "passed" && hardLockCount === members.length && batch.sealed;
    const blockingIssues = [
      ...authorities.issues,
      ...members.flatMap((member) => member.issues.map((issue) => `${member.assetId}：${issue}`)),
      ...(status === "invalidated" ? ["旧六张一致性通过证据已被当前文件、Review、Publication 或权威版本漂移废止"] : []),
      ...(status === "passed" && hardLockCount !== members.length ? [`批次已通过，但仍有 ${members.length - hardLockCount} 项未提升为当前版本硬锁`] : []),
    ];
    batchStates.push({ id: batch.id, sequence: batch.sequence, revision: batch.revision, status, sealed: batch.sealed, sealedReason: batch.sealedReason, members, memberCount: members.length, readyCount: evidence.length, hardLockCount, includesHiddenMaskAsset, requiredCriteria: [...FUSION_ASSET_CONSISTENCY_CRITERIA], currentSnapshotHash, authorityHashes: authorities.values, authorityIssues: authorities.issues, review, reviewValid, canPrepareReview: status === "awaiting_batch_review" && Boolean(currentSnapshotHash), canStartNextBatch, blockingIssues });
  }
  const last = batchStates.at(-1);
  const canEnqueueNewAsset = !last || (!last.sealed && last.memberCount < FUSION_ASSET_CONSISTENCY_BATCH_SIZE) || last.canStartNextBatch;
  const productionAssets = assertStoreProductionOrder(store, manifest, catalog);
  const reservedAssets = orderedStoreMembers(store).length;
  const remainingBatchSlots = last && !last.sealed ? FUSION_ASSET_CONSISTENCY_BATCH_SIZE - last.memberCount : FUSION_ASSET_CONSISTENCY_BATCH_SIZE;
  const nextBatchAssetIds = productionAssets.slice(reservedAssets, reservedAssets + remainingBatchSlots).map((entry) => entry.definition.id);
  const blockingIssues = last && !canEnqueueNewAsset
    ? [`${last.id} 尚未完成内容绑定的六张一致性复核并将全部当前版本提升为硬锁。`, ...last.blockingIssues]
    : [];
  return { schemaVersion: 1, kind: "fusion-asset-consistency-state", projectId: store.projectId, sourceContentAddress: store.sourceContentAddress, storeRevision: store.revision, persisted, batchSize: FUSION_ASSET_CONSISTENCY_BATCH_SIZE, batches: batchStates, openBatchId: last?.id, canEnqueueNewAsset, productionOrder: { version: FUSION_ASSET_PRODUCTION_ORDER_VERSION, totalAssets: productionAssets.length, reservedAssets, nextAssetId: productionAssets[reservedAssets]?.definition.id, nextBatchAssetIds }, blockingIssues, updatedAt: store.updatedAt };
}

export async function getFusionAssetConsistencyState(projectRoot: string): Promise<FusionAssetConsistencyState> {
  const { manifest, catalog } = await fusionIdentity(projectRoot);
  const jobs = await readJobs(projectRoot);
  const stored = await loadStore(projectRoot);
  const store = stored ?? bootstrapStore(catalog, jobs, new Date().toISOString());
  if (store.projectId !== catalog.projectId || store.sourceContentAddress !== catalog.sourceContentAddress) throw new Error("六张一致性侧车与资产目录身份不一致。");
  assertStoreProductionOrder(store, manifest, catalog);
  return computeState(projectRoot, store, Boolean(stored), jobs, catalog, manifest);
}

export async function reserveFusionAssetConsistencyMembership(
  projectRoot: string,
  jobs: GenerationJob[],
  jobId: string,
  itemId: string,
): Promise<{ batchId: string; assetId: string; contractId: string; sourceSectionSha256: string }> {
  return withProjectLock(projectRoot, "asset-consistency", async () => {
    const { manifest, catalog } = await fusionIdentity(projectRoot);
    const store = await ensureStoreLocked(projectRoot, jobs);
    const entry = catalog.assets.find((candidate) => candidate.workItemId === itemId);
    if (!entry) throw new Error(`资产节点 ${itemId} 不在冻结资产目录中，不能创建新的资产生图任务。`);
    if (entry.authority) throw new Error(`资产 ${entry.definition.id} 已有用户授权权威参考，不能创建新的资产生图任务，也不允许进入六张新资产批次。`);
    const productionAssets = assertStoreProductionOrder(store, manifest, catalog);
    const existingBatch = store.batches.find((batch) => batch.members.some((member) => member.itemId === itemId));
    if (!existingBatch) {
      const reservedAssets = orderedStoreMembers(store).length;
      const expected = productionAssets[reservedAssets];
      if (!expected) throw new Error("全部非权威资产均已按首次出场顺序进入生产批次，拒绝新增资产成员。 ");
      if (entry.definition.id !== expected.definition.id) {
        throw new Error(`资产首次出场顺序门禁：下一项必须是 ${expected.definition.id}（${expected.definition.name}），不能先入队 ${entry.definition.id}。`);
      }
    }
    const now = new Date().toISOString();
    let batch = existingBatch;
    if (!batch) {
      const state = await computeState(projectRoot, store, true, jobs, catalog, manifest);
      const last = store.batches.at(-1);
      const lastState = last ? state.batches.find((candidate) => candidate.id === last.id) : undefined;
      if (!last || last.sealed) {
        if (last && !lastState?.canStartNextBatch) throw new Error(`第七个新资产被六张一致性门禁阻止：${last.id} 尚未通过且全部提升硬锁。`);
        const sequence = store.batches.length + 1;
        batch = { id: `fusion-asset-batch-${String(sequence).padStart(3, "0")}`, sequence, revision: 1, sealed: false, members: [], reviews: [], createdAt: now, updatedAt: now };
        store.batches.push(batch);
      } else batch = last;
      if (batch.members.length >= FUSION_ASSET_CONSISTENCY_BATCH_SIZE) throw new Error(`六张一致性批次 ${batch.id} 已满，拒绝加入第七项。`);
      batch.members.push({ order: batch.members.length + 1, itemId, assetId: entry.definition.id, contractId: entry.contract.contractId, sourceSectionSha256: entry.definition.sourceSectionSha256, attemptJobIds: [jobId], currentJobId: jobId });
      if (batch.members.length === FUSION_ASSET_CONSISTENCY_BATCH_SIZE) {
        batch.sealed = true;
        batch.sealedReason = "batch_size_reached";
        batch.sealedAt = now;
      }
    } else {
      const member = batch.members.find((candidate) => candidate.itemId === itemId)!;
      if (member.assetId !== entry.definition.id || member.contractId !== entry.contract.contractId || member.sourceSectionSha256 !== entry.definition.sourceSectionSha256) throw new Error(`资产 ${itemId} 的冻结合同与原批次不一致。`);
      if (member.attemptJobIds.includes(jobId)) throw new Error(`生成任务 ${jobId} 已在六张一致性批次中。`);
      member.attemptJobIds.push(jobId);
      member.currentJobId = jobId;
    }
    batch.revision += 1;
    batch.updatedAt = now;
    store.revision += 1;
    store.updatedAt = now;
    await writeJsonAtomic(getSidecarPaths(projectRoot).assetConsistencyBatches, store);
    return { batchId: batch.id, assetId: entry.definition.id, contractId: entry.contract.contractId, sourceSectionSha256: entry.definition.sourceSectionSha256 };
  });
}

export async function rollbackFusionAssetConsistencyReservation(projectRoot: string, jobId: string): Promise<void> {
  await withProjectLock(projectRoot, "asset-consistency", async () => {
    const store = await loadStore(projectRoot);
    if (!store) return;
    const batch = store.batches.find((candidate) => candidate.members.some((member) => member.attemptJobIds.includes(jobId)));
    if (!batch) return;
    const member = batch.members.find((candidate) => candidate.attemptJobIds.includes(jobId))!;
    if (member.currentJobId !== jobId) throw new Error(`不能回滚非当前资产尝试 ${jobId}。`);
    if (member.attemptJobIds.length === 1 && orderedStoreMembers(store).at(-1) !== member) {
      throw new Error(`不能回滚非末位资产 ${member.assetId}，否则会破坏冻结的首次出场生产顺序。`);
    }
    member.attemptJobIds = member.attemptJobIds.filter((candidate) => candidate !== jobId);
    if (member.attemptJobIds.length) member.currentJobId = member.attemptJobIds.at(-1)!;
    else {
      batch.members = batch.members.filter((candidate) => candidate !== member).map((candidate, index) => ({ ...candidate, order: index + 1 }));
      if (batch.sealedReason === "batch_size_reached") {
        batch.sealed = false;
        batch.sealedReason = undefined;
        batch.sealedAt = undefined;
      }
    }
    if (!batch.members.length && batch === store.batches.at(-1)) store.batches.pop();
    else {
      batch.revision += 1;
      batch.updatedAt = new Date().toISOString();
    }
    store.revision += 1;
    store.updatedAt = new Date().toISOString();
    await writeJsonAtomic(getSidecarPaths(projectRoot).assetConsistencyBatches, store);
  });
}

export async function assertFusionAssetJobMaySubmit(projectRoot: string, job: GenerationJob, jobs?: GenerationJob[]): Promise<void> {
  if (job.purpose !== "asset") return;
  const allJobs = jobs ?? await readJobs(projectRoot);
  const store = await withProjectLock(projectRoot, "asset-consistency", () => ensureStoreLocked(projectRoot, allJobs));
  const { manifest, catalog } = await fusionIdentity(projectRoot);
  const state = await computeState(projectRoot, store, true, allJobs, catalog, manifest);
  const batch = store.batches.find((candidate) => candidate.members.some((member) => member.attemptJobIds.includes(job.id)));
  if (!batch) throw new Error(`资产任务 ${job.id} 没有持久化六张一致性批次归属。`);
  const member = batch.members.find((candidate) => candidate.attemptJobIds.includes(job.id))!;
  if (member.currentJobId !== job.id) throw new Error(`资产任务 ${job.id} 已被同资产的新返工版本取代，禁止提交旧尝试。`);
  if (job.assetConsistencyBatchId && job.assetConsistencyBatchId !== batch.id) throw new Error(`资产任务 ${job.id} 的批次字段与侧车不一致。`);
  for (const previous of state.batches.filter((candidate) => candidate.sequence < batch.sequence)) {
    if (!previous.canStartNextBatch) throw new Error(`资产任务 ${job.id} 被上一六张批次 ${previous.id} 阻止：必须先通过复核并全部提升当前硬锁。`);
  }
}

export async function assertFusionAssetConsistencyApprovedForItem(projectRoot: string, itemId: string): Promise<void> {
  const { catalog } = await fusionIdentity(projectRoot);
  const entry = catalog.assets.find((candidate) => candidate.workItemId === itemId);
  if (!entry) throw new Error(`资产 ${itemId} 不在融合资产目录中。`);
  if (entry.authority) return;
  const state = await getFusionAssetConsistencyState(projectRoot);
  const batch = state.batches.find((candidate) => candidate.members.some((member) => member.itemId === itemId));
  if (!batch || batch.status !== "passed" || !batch.reviewValid) throw new Error(`资产 ${entry.definition.id} 尚未通过绑定当前六张内容的一致性复核，不能提升或用于分镜。`);
}

export async function assertFusionAssetConsistencyDownstreamReady(projectRoot: string): Promise<void> {
  const state = await getFusionAssetConsistencyState(projectRoot);
  const pending = state.batches.find((batch) => batch.memberCount > 0 && !batch.canStartNextBatch);
  if (pending) throw new Error(`分镜生图被六张资产一致性门禁阻止：${pending.id} 必须先通过复核并将全部当前版本提升硬锁。`);
}

function xml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

async function writeExclusiveVerified(filePath: string, content: Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try { await writeFile(filePath, content, { flag: "wx" }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) throw error;
    const existing = await readFile(filePath);
    if (!existing.equals(content)) throw new Error(`一致性复核板目标已存在但内容冲突，拒绝覆盖：${filePath}`);
  }
}

async function buildReviewBoard(projectRoot: string, batch: FusionAssetConsistencyBatchState): Promise<FusionAssetConsistencyReviewBoard> {
  if (!batch.currentSnapshotHash || !batch.canPrepareReview || batch.members.length < 1) throw new Error(`批次 ${batch.id} 尚未满足复核板证据条件。`);
  const width = 1920;
  const height = 2160;
  const gap = 24;
  const tileWidth = 608;
  const tileHeight = 1044;
  const imageHeight = 992;
  const images = await Promise.all(batch.members.map(async (member) => sharp(member.evidence!.raw.path, { failOn: "error" }).rotate().resize({ width: tileWidth, height: imageHeight, fit: "cover" }).png().toBuffer()));
  const composites: sharp.OverlayOptions[] = images.map((input, index) => ({ input, left: gap + (index % 3) * (tileWidth + gap), top: gap + Math.floor(index / 3) * (tileHeight + gap) }));
  const labels = batch.members.map((member, index) => {
    const left = gap + (index % 3) * (tileWidth + gap);
    const top = gap + Math.floor(index / 3) * (tileHeight + gap) + imageHeight;
    return `<rect x="${left}" y="${top}" width="${tileWidth}" height="52" fill="#091c3b"/><text x="${left + 18}" y="${top + 35}" fill="#ffffff" font-size="25" font-family="PingFang SC, Heiti SC, sans-serif">${xml(`${String(index + 1).padStart(2, "0")}｜${member.assetId} ${member.assetName}`)}</text>`;
  }).join("");
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${labels}<text x="24" y="2140" fill="#ffffff" font-size="22" font-family="PingFang SC, Heiti SC, sans-serif">复核专用｜不得作为正式资产或生图参考｜${xml(batch.id)}｜${batch.currentSnapshotHash.slice(0, 20)}</text></svg>`);
  composites.push({ input: svg, left: 0, top: 0 });
  const output = await sharp({ create: { width, height, channels: 3, background: "#06152f" } }).composite(composites).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  const outputSha = sha256(output);
  const directory = getSidecarPaths(projectRoot).assetConsistencyBoards;
  const basename = `${batch.id}-${FUSION_ASSET_CONSISTENCY_BOARD_RENDER_VERSION}-${batch.currentSnapshotHash.slice(0, 20)}`;
  const imagePath = path.join(directory, `${basename}.png`);
  const metadataPath = path.join(directory, `${basename}.json`);
  const metadata = Buffer.from(`${JSON.stringify({ schemaVersion: 1, kind: "fusion-asset-consistency-review-board", role: "review-only-not-generation-reference", renderVersion: FUSION_ASSET_CONSISTENCY_BOARD_RENDER_VERSION, batchId: batch.id, snapshotHash: batch.currentSnapshotHash, sha256: outputSha, width, height, members: batch.members.map((member) => ({ order: member.order, itemId: member.itemId, assetId: member.assetId, name: member.assetName, raw: member.evidence?.raw })), createdFromCurrentEvidence: true }, null, 2)}\n`);
  await writeExclusiveVerified(imagePath, output);
  await writeExclusiveVerified(metadataPath, metadata);
  return { path: imagePath, metadataPath, sha256: outputSha, width, height, snapshotHash: batch.currentSnapshotHash, renderVersion: FUSION_ASSET_CONSISTENCY_BOARD_RENDER_VERSION };
}

export async function prepareFusionAssetConsistencyReview(projectRoot: string, batchId?: string): Promise<{ prepared: boolean; state: FusionAssetConsistencyState; board?: FusionAssetConsistencyReviewBoard }> {
  const initialized = await initializeFusionAssetConsistency(projectRoot);
  const batch = batchId ? initialized.batches.find((candidate) => candidate.id === batchId) : initialized.batches.at(-1);
  if (!batch) return { prepared: false, state: initialized };
  if (!batch.canPrepareReview) return { prepared: false, state: initialized };
  return { prepared: true, state: initialized, board: await buildReviewBoard(projectRoot, batch) };
}

function normalizedCriteria(input: SubmitFusionAssetConsistencyReviewInput["criteria"]): SubmitFusionAssetConsistencyReviewInput["criteria"] {
  const seen = new Map<FusionAssetConsistencyCriterionKey, { key: FusionAssetConsistencyCriterionKey; result: FusionAssetConsistencyCriterionResult; note?: string }>();
  for (const criterion of input) {
    if (!FUSION_ASSET_CONSISTENCY_CRITERIA.includes(criterion.key) || !["pass", "fail", "na"].includes(criterion.result)) throw new Error(`未知或无效的一致性标准：${criterion.key}`);
    if (seen.has(criterion.key)) throw new Error(`一致性标准重复：${criterion.key}`);
    seen.set(criterion.key, { key: criterion.key, result: criterion.result, note: criterion.note?.trim().slice(0, 2_000) || undefined });
  }
  const missing = FUSION_ASSET_CONSISTENCY_CRITERIA.filter((key) => !seen.has(key));
  if (missing.length) throw new Error(`六张一致性复核缺少标准：${missing.join("、")}`);
  return FUSION_ASSET_CONSISTENCY_CRITERIA.map((key) => seen.get(key)!);
}

export async function submitFusionAssetConsistencyReview(projectRoot: string, input: SubmitFusionAssetConsistencyReviewInput, reviewer: "user" | "codex" = "codex"): Promise<FusionAssetConsistencyState> {
  await initializeFusionAssetConsistency(projectRoot);
  return withProjectLock(projectRoot, "asset-consistency", async () => {
    const store = await loadStore(projectRoot);
    if (!store) throw new Error("六张一致性侧车尚未初始化。");
    if (input.expectedRevision !== store.revision) throw new Error(`六张一致性修订冲突：期望 ${input.expectedRevision}，当前 ${store.revision}。`);
    const { manifest, catalog } = await fusionIdentity(projectRoot);
    const jobs = await readJobs(projectRoot);
    const state = await computeState(projectRoot, store, true, jobs, catalog, manifest);
    const batchState = state.batches.find((candidate) => candidate.id === input.batchId);
    const batch = store.batches.find((candidate) => candidate.id === input.batchId);
    if (!batch || !batchState) throw new Error(`找不到六张一致性批次：${input.batchId}`);
    if (!batchState.canPrepareReview || !batchState.currentSnapshotHash) throw new Error(`批次 ${input.batchId} 尚未完成六项 Publication、raw/labeled、机械验收与单图 Review。`);
    if (input.expectedSnapshotHash !== batchState.currentSnapshotHash) throw new Error("六张一致性证据快照已变化，请重新读取并准备复核板。");
    const criteria = normalizedCriteria(input.criteria);
    const hiddenMask = criteria.find((criterion) => criterion.key === "hidden_mask_rule")!;
    const note = input.note?.trim().slice(0, 4_000) || undefined;
    const reworkItemIds = [...new Set(input.reworkItemIds ?? [])];
    if (input.decision === "pass") {
      const failed = criteria.filter((criterion) => criterion.result !== "pass" && !(criterion.key === "hidden_mask_rule" && !batchState.includesHiddenMaskAsset && criterion.result === "na"));
      if (failed.length) throw new Error(`整体通过要求所有适用标准显式通过；仅不含 P01 时隐藏面具标准可选不适用。当前未通过：${failed.map((criterion) => criterion.key).join("、")}`);
      if (reworkItemIds.length) throw new Error("整体通过不能同时登记返工资产。");
    } else {
      if (!criteria.some((criterion) => criterion.result === "fail")) throw new Error("返工决定至少需要一项标准明确失败。");
      if (!reworkItemIds.length || reworkItemIds.some((itemId) => !batch.members.some((member) => member.itemId === itemId))) throw new Error("返工决定必须指定本批次中的至少一个资产节点。");
      if (!note) throw new Error("返工决定必须填写可执行说明。");
    }
    if (batchState.includesHiddenMaskAsset && hiddenMask.result !== "pass" && input.decision === "pass") throw new Error("包含 P01 的批次必须明确通过黄金面具完全不可见铁律。");
    const board = await buildReviewBoard(projectRoot, batchState);
    const now = new Date().toISOString();
    batch.reviews.push({ id: `fusion-asset-review-${randomUUID()}`, decision: input.decision, storeRevision: store.revision, snapshotHash: batchState.currentSnapshotHash, evidence: batchState.members.map((member) => member.evidence!), authorityHashes: batchState.authorityHashes, board, criteria, reworkItemIds: input.decision === "rework" ? reworkItemIds : undefined, note, reviewer, createdAt: now });
    batch.revision += 1;
    batch.updatedAt = now;
    store.revision += 1;
    store.updatedAt = now;
    await writeJsonAtomic(getSidecarPaths(projectRoot).assetConsistencyBatches, store);
    return computeState(projectRoot, store, true, jobs, catalog, manifest);
  });
}

export async function sealFinalFusionAssetConsistencyBatch(projectRoot: string, input: { batchId: string; expectedRevision: number }): Promise<FusionAssetConsistencyState> {
  await initializeFusionAssetConsistency(projectRoot);
  return withProjectLock(projectRoot, "asset-consistency", async () => {
    const store = await loadStore(projectRoot);
    if (!store) throw new Error("六张一致性侧车尚未初始化。");
    if (input.expectedRevision !== store.revision) throw new Error(`六张一致性修订冲突：期望 ${input.expectedRevision}，当前 ${store.revision}。`);
    const { manifest, catalog } = await fusionIdentity(projectRoot);
    const batch = store.batches.at(-1);
    if (!batch || batch.id !== input.batchId) throw new Error("只能封存当前最后一个一致性批次。");
    if (batch.sealed || !batch.members.length || batch.members.length >= FUSION_ASSET_CONSISTENCY_BATCH_SIZE) throw new Error("只有 1–5 项且尚未封存的最终批次可以 final_partial 封存。");
    const assigned = new Set(store.batches.flatMap((candidate) => candidate.members.map((member) => member.itemId)));
    const remaining = catalog.assets.filter((entry) => !entry.authority && !assigned.has(entry.workItemId));
    if (remaining.length) throw new Error(`仍有 ${remaining.length} 项未生成资产没有进入批次，不能把当前批次冒充全季最终批次。`);
    const now = new Date().toISOString();
    batch.sealed = true;
    batch.sealedReason = "final_partial";
    batch.sealedAt = now;
    batch.revision += 1;
    batch.updatedAt = now;
    store.revision += 1;
    store.updatedAt = now;
    await writeJsonAtomic(getSidecarPaths(projectRoot).assetConsistencyBatches, store);
    return computeState(projectRoot, store, true, await readJobs(projectRoot), catalog, manifest);
  });
}
