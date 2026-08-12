import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RejectedCommandFailure } from "./command-outcome.js";
import type {
  FusionMaterializationReceipt,
  FusionProductionAssetCatalog,
  MaterializedAuthorityReference,
} from "./fusion-production.js";
import type {
  AssetGenerationContract,
  ProductionAssetCategory,
  ProductionAssetDefinition,
} from "./fusion-package.js";
import { withProjectLock } from "./locks.js";
import type { PublicationReceipt, PublicationStore } from "./publication.js";
import { getSidecarPaths, writeJsonAtomic } from "./sidecar.js";
import type {
  Artifact,
  ProjectConfig,
  ProjectIndex,
  ReviewArtifactEvidence,
  ReviewRecord,
  ReviewStore,
} from "./types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTENT_ADDRESS_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const EPOCH = new Date(0).toISOString();
const MIGRATION_ALGORITHM = "canonical-assets-fusion-v1";

export type CanonicalAssetCategory = ProductionAssetCategory;
export type CanonicalAssetAuthorityFilter = "any" | "with-authority" | "without-authority";
export type CanonicalAssetVersionRepresentation = "production-output" | "primary-reference" | "supporting-reference";

export interface CanonicalAssetDefinitionSnapshot extends Omit<ProductionAssetDefinition, "generationStatus" | "hardLockStatus"> {}

export interface CanonicalAssetDefinitionVersion {
  id: string;
  assetId: string;
  definition: CanonicalAssetDefinitionSnapshot;
  fingerprint: string;
}

export interface CanonicalAssetContractVersion {
  id: string;
  assetId: string;
  contract: AssetGenerationContract;
  fingerprint: string;
}

export interface CanonicalAssetIdentityFeature {
  id: string;
  key: "canonical-name" | "declared-usage";
  value: string;
  sourceDefinitionVersionId: string;
}

export interface CanonicalAssetLockRule {
  id: string;
  polarity: "positive" | "negative";
  instruction: string;
  sourceKind: "legacy-authority" | "reviewed-hard-lock";
  sourceId: string;
}

export interface CanonicalAssetSource {
  kind: "fusion-production-asset";
  workItemId: string;
  directoryPath: string;
  infoPath: string;
  outputDirectory: string;
}

export interface CanonicalAsset {
  id: string;
  projectId: string;
  category: CanonicalAssetCategory;
  canonicalName: string;
  source: CanonicalAssetSource;
  identityFeatures: CanonicalAssetIdentityFeature[];
  positiveLocks: CanonicalAssetLockRule[];
  negativeLocks: CanonicalAssetLockRule[];
  currentDefinitionVersionId: string;
  currentContractVersionId: string;
  primaryAuthorityId?: string;
  /**
   * 当前仅供人工复核的 supporting Authority head。旧 schema v1 store
   * 没有该字段时，读路径会从当时唯一的 supporting Authority 兼容推导。
   */
  currentSupportingAuthorityIds?: string[];
  revision: number;
  fingerprint: string;
}

export interface CanonicalAssetAlias {
  id: string;
  assetId: string;
  kind: "formal-id" | "formal-name" | "formal-name-subject" | "explicit-parenthetical-name" | "explicit-same-asset-name";
  status: "confirmed";
  value: string;
  normalizedValue: string;
  scope: { projectId: string; crossProject: false };
  source?: {
    kind: "definition-id" | "definition-name" | "definition-source-section";
    definitionVersionId: string;
    evidence: string;
  };
  fingerprint: string;
}

export interface CanonicalAssetMediaReference {
  kind: "image";
  role: "raw" | "labeled";
  path: string;
  rootSlot: string;
  relativePath: string;
  bytes: number;
  sha256: string;
  artifactId?: string;
  publicationIntentId?: string;
  publicationReceiptId?: string;
  provenance: "authority-snapshot" | "review-evidence";
}

export interface CanonicalAssetVersion {
  id: string;
  assetId: string;
  definitionVersionId: string;
  contractVersionId: string;
  representation: CanonicalAssetVersionRepresentation;
  media: CanonicalAssetMediaReference[];
  reviewIds: string[];
  generationJobId?: string;
  createdAt: string;
  fingerprint: string;
}

export interface CanonicalAssetAuthorityScope {
  projectId: string;
  usage: "generation-reference" | "human-review-only";
  crossProject: false;
}

export interface CanonicalAssetLegacyAuthoritySource {
  kind: "legacy-authority";
  legacyAuthorityId: string;
  name: string;
  sourcePath: string;
  sourceSha256: string;
  snapshotPath: string;
  snapshotSha256: string;
  exposeToGeneration: boolean;
}

export interface CanonicalAssetReviewedHardLockSource {
  kind: "reviewed-hard-lock";
  legacyHardLockId: string;
  name: string;
  path: string;
  note?: string;
}

export interface CanonicalAssetAuthority {
  id: string;
  assetId: string;
  assetVersionId: string;
  kind: "user-provided" | "reviewed-hard-lock";
  role: "primary-identity" | "production-hard-lock" | "supporting-identity";
  exposure: "allowed" | "forbidden";
  scope: CanonicalAssetAuthorityScope;
  reviewId?: string;
  positiveLocks: CanonicalAssetLockRule[];
  negativeLocks: CanonicalAssetLockRule[];
  source: CanonicalAssetLegacyAuthoritySource | CanonicalAssetReviewedHardLockSource;
  createdAt: string;
  fingerprint: string;
}

export interface CanonicalAssetRelationEndpoint {
  kind: "asset" | "version";
  id: string;
}

export interface CanonicalAssetRelation {
  id: string;
  kind: "derived_from" | "variant_of" | "reference_of" | "supersedes";
  from: CanonicalAssetRelationEndpoint;
  to: CanonicalAssetRelationEndpoint;
  evidenceSource: string;
  fingerprint: string;
}

export interface CanonicalAssetMigrationAnomaly {
  id: string;
  code: "definition-source-section-overrun" | "uniform-contract-aspect-ratio";
  severity: "warning";
  assetId?: string;
  message: string;
  sourceVersionId?: string;
  fingerprint: string;
}

export interface CanonicalAssetSourceFileSnapshot {
  role: "production-assets" | "materialization" | "index" | "reviews" | "publications" | "project";
  path: string;
  bytes: number;
  sha256: string;
  semanticSha256: string;
}

export interface CanonicalAssetSourceMediaSnapshot {
  path: string;
  bytes: number;
  sha256: string;
}

export interface CanonicalAssetSourceSnapshot {
  algorithm: typeof MIGRATION_ALGORITHM;
  files: CanonicalAssetSourceFileSnapshot[];
  media: CanonicalAssetSourceMediaSnapshot[];
}

export interface CanonicalAssetStore {
  schemaVersion: 1;
  kind: "canonical-asset-store";
  revision: number;
  projectId: string;
  sourceContentAddress: `sha256:${string}`;
  assets: CanonicalAsset[];
  aliases: CanonicalAssetAlias[];
  definitionVersions: CanonicalAssetDefinitionVersion[];
  contractVersions: CanonicalAssetContractVersion[];
  versions: CanonicalAssetVersion[];
  authorities: CanonicalAssetAuthority[];
  relations: CanonicalAssetRelation[];
  migrationAnomalies: CanonicalAssetMigrationAnomaly[];
  sourceSnapshot: CanonicalAssetSourceSnapshot;
  candidateFingerprint: string;
  storeFingerprint: string;
  updatedAt: string;
}

export interface CanonicalAssetCounts {
  assets: number;
  aliases: number;
  definitionVersions: number;
  contractVersions: number;
  versions: number;
  authorities: number;
  relations: number;
  media: number;
  assetsWithVersions: number;
  assetsWithoutVersions: number;
  primaryAuthorities: number;
  supportingAuthorities: number;
  byCategory: Record<CanonicalAssetCategory, number>;
}

export interface CanonicalAssetMigrationPreview {
  schemaVersion: 1;
  kind: "canonical-asset-migration-preview";
  storeRevision: number;
  candidateFingerprint: string;
  candidateStoreFingerprint?: string;
  sourceSnapshot?: CanonicalAssetSourceSnapshot;
  counts?: CanonicalAssetCounts;
  blockers: string[];
  canMigrate: boolean;
  pending: boolean;
}

export interface CanonicalAssetMigrationResult {
  schemaVersion: 1;
  kind: "canonical-asset-migration-result";
  applied: boolean;
  replayed: boolean;
  previousRevision: number;
  storeRevision: number;
  candidateFingerprint: string;
  storeFingerprint: string;
  counts: CanonicalAssetCounts;
}

export interface CanonicalAssetCatalogState {
  available: boolean;
  current: boolean;
  storeRevision?: number;
  storeFingerprint?: string;
  projectId?: string;
  sourceContentAddress?: string;
  updatedAt?: string;
  counts?: CanonicalAssetCounts;
  driftedInputs: string[];
}

export interface CanonicalAssetListQuery {
  text?: string;
  search?: string;
  category?: CanonicalAssetCategory | "any";
  authority?: CanonicalAssetAuthorityFilter;
  offset?: number;
  limit?: number;
}

export interface CanonicalAssetSummary {
  id: string;
  category: CanonicalAssetCategory;
  canonicalName: string;
  aliases: CanonicalAssetAlias[];
  primaryAuthorityId?: string;
  primaryVersionId?: string;
  thumbnail?: Pick<CanonicalAssetMediaReference, "path" | "sha256" | "role"> & { versionId: string };
  hasAuthority: boolean;
  hasPrimaryAuthority: boolean;
  hasSupportingAuthority: boolean;
  versionCount: number;
  authorityCount: number;
  migrationAnomalies: CanonicalAssetMigrationAnomaly[];
}

export interface CanonicalAssetPage {
  available: boolean;
  storeRevision?: number;
  storeFingerprint?: string;
  queryFingerprint?: string;
  total: number;
  offset: number;
  limit: number;
  items: CanonicalAssetSummary[];
}

export interface CanonicalAssetDetail {
  asset: CanonicalAsset;
  aliases: CanonicalAssetAlias[];
  definitionVersions: CanonicalAssetDefinitionVersion[];
  contractVersions: CanonicalAssetContractVersion[];
  versions: CanonicalAssetVersion[];
  authorities: CanonicalAssetAuthority[];
  relations: CanonicalAssetRelation[];
  migrationAnomalies: CanonicalAssetMigrationAnomaly[];
  storeRevision: number;
  storeFingerprint: string;
}

export interface CanonicalAssetStoreCurrentness {
  available: boolean;
  current: boolean;
  checkedAt: string;
  storeRevision?: number;
  storeFingerprint?: string;
  currentCandidateFingerprint?: string;
  driftedInputs: string[];
  issues: string[];
}

export interface CanonicalAssetPrimaryAuthoritySnapshot {
  assetId: string;
  workItemId: string;
  category: CanonicalAssetCategory;
  canonicalName: string;
  authorityId: string;
  authority: "user-authority" | "reviewed-hard-lock";
  versionId: string;
  definitionVersionId: string;
  contractVersionId: string;
  path: string;
  sha256: string;
  artifactId?: string;
  labeledPath?: string;
  labeledSha256?: string;
  labeledArtifactId?: string;
  reviewId?: string;
}

export interface CanonicalAssetAuthorityProjection {
  storeRevision: number;
  storeFingerprint: string;
  candidateFingerprint: string;
  assets: CanonicalAssetPrimaryAuthoritySnapshot[];
}

interface SafeFileSnapshot {
  path: string;
  bytes: number;
  sha256: string;
  content: Buffer;
}

interface MigrationInputs {
  catalog: FusionProductionAssetCatalog;
  materialization: FusionMaterializationReceipt;
  index: ProjectIndex;
  reviews: ReviewStore;
  publications: PublicationStore;
  project: ProjectConfig;
  files: Array<SafeFileSnapshot & { role: CanonicalAssetSourceFileSnapshot["role"]; semanticSha256: string }>;
}

interface CandidateBuild {
  store: CanonicalAssetStore | null;
  blockers: string[];
  sourceSnapshot?: CanonicalAssetSourceSnapshot;
  candidateFingerprint: string;
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

function contentId(prefix: string, fingerprint: string): string {
  return `${prefix}-${fingerprint.slice(0, 32)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 不能为空。`);
  return value;
}

function assertSha256(value: unknown, label: string): string {
  const normalized = requiredString(value, label);
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${label} 必须是小写完整 SHA-256。`);
  return normalized;
}

function assertContentAddress(value: unknown, label: string): `sha256:${string}` {
  const normalized = requiredString(value, label);
  if (!CONTENT_ADDRESS_PATTERN.test(normalized)) throw new Error(`${label} 必须是 sha256 内容地址。`);
  return normalized as `sha256:${string}`;
}

function normalizeAlias(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

function sameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function compareById<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id, "en");
}

function uniqueById<T extends { id: string }>(values: readonly T[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    requiredString(value.id, `${label}.id`);
    if (seen.has(value.id)) throw new Error(`${label} 出现重复 ID：${value.id}`);
    seen.add(value.id);
  }
}

function stableEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

/**
 * 追加型记录不允许以相同 ID 覆盖不同证据。Map(last-write-wins) 会使
 * 内容地址冲突或被篡改的历史在迁移时静默消失，因此必须深比较。
 */
function mergeAppendOnlyById<T extends { id: string }>(
  historical: readonly T[],
  current: readonly T[],
  label: string,
): T[] {
  const merged = new Map<string, T>();
  for (const entry of [...historical, ...current]) {
    const existing = merged.get(entry.id);
    if (existing && !stableEqual(existing, entry)) {
      throw new Error(`${label} 出现相同 ID 但内容证据不同，禁止静默覆盖：${entry.id}`);
    }
    if (!existing) merged.set(entry.id, structuredClone(entry));
  }
  return [...merged.values()].sort(compareById);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function canonicalProjectRoot(projectRoot: string): Promise<{ root: string; real: string }> {
  const root = path.resolve(projectRoot);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`工程根必须是非符号链接目录：${root}`);
  return { root, real: await realpath(root) };
}

async function safeFileSnapshot(
  root: { root: string; real: string },
  filePath: string,
  label: string,
): Promise<SafeFileSnapshot> {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} 必须是绝对路径：${filePath}`);
  const normalized = path.resolve(filePath);
  const relative = path.relative(root.root, normalized);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} 越出当前工程：${normalized}`);
  }
  const before = await lstat(normalized);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} 必须是工程内非符号链接普通文件：${normalized}`);
  const fileReal = await realpath(normalized);
  if (fileReal !== path.resolve(root.real, relative)) throw new Error(`${label} realpath 越界或穿过符号链接：${normalized}`);
  const content = await readFile(normalized);
  const after = await lstat(normalized);
  if (!after.isFile() || after.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    || content.byteLength !== before.size) {
    throw new Error(`${label} 在读取期间发生变化：${normalized}`);
  }
  return {
    path: normalized,
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    content,
  };
}

function parseJsonSnapshot(snapshot: SafeFileSnapshot, label: string): unknown {
  try {
    return JSON.parse(snapshot.content.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} JSON 无法解析：${snapshot.path}`, { cause: error });
  }
}

function parseProductionAssetDefinition(value: unknown, label: string): ProductionAssetDefinition {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || !["character", "scene", "prop"].includes(String(value.category))
    || typeof value.name !== "string"
    || typeof value.declaredUsage !== "string"
    || !Array.isArray(value.generationPrompts)
    || !value.generationPrompts.every((entry) => isRecord(entry) && typeof entry.label === "string" && typeof entry.prompt === "string")
    || typeof value.sourceMarkdownPath !== "string"
    || !Number.isInteger(value.sourceHeadingLine)
    || typeof value.sourceSectionSha256 !== "string"
    || !SHA256_PATTERN.test(value.sourceSectionSha256)
    || typeof value.sourceSection !== "string") {
    throw new Error(`${label} definition 结构无效。`);
  }
  return value as unknown as ProductionAssetDefinition;
}

function parseAssetContract(value: unknown, label: string): AssetGenerationContract {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "asset-generation-contract"
    || typeof value.contractId !== "string"
    || typeof value.assetId !== "string"
    || !["character", "scene", "prop"].includes(String(value.assetCategory))
    || typeof value.prompt !== "string"
    || typeof value.aspectRatio !== "string"
    || !Array.isArray(value.authorityReferences)
    || !Array.isArray(value.acceptanceRequirements)) {
    throw new Error(`${label} contract 结构无效。`);
  }
  return value as unknown as AssetGenerationContract;
}

function parseAuthority(value: unknown, label: string): MaterializedAuthorityReference {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || (value.assetId !== undefined && typeof value.assetId !== "string")
    || typeof value.name !== "string"
    || typeof value.sourcePath !== "string"
    || typeof value.snapshotPath !== "string"
    || typeof value.sourceSha256 !== "string" || !SHA256_PATTERN.test(value.sourceSha256)
    || typeof value.snapshotSha256 !== "string" || !SHA256_PATTERN.test(value.snapshotSha256)
    || !Array.isArray(value.rules) || !value.rules.every((entry) => typeof entry === "string")
    || typeof value.exposeToGeneration !== "boolean") {
    throw new Error(`${label} authority 结构无效。`);
  }
  return value as unknown as MaterializedAuthorityReference;
}

function parseCatalog(value: unknown): FusionProductionAssetCatalog {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "fusion-production-assets"
    || !Number.isInteger(value.revision)
    || typeof value.projectId !== "string"
    || typeof value.sourceContentAddress !== "string"
    || !CONTENT_ADDRESS_PATTERN.test(value.sourceContentAddress)
    || !Array.isArray(value.assets)) {
    throw new Error("production-assets 结构无效。 ");
  }
  for (const [index, entry] of value.assets.entries()) {
    if (!isRecord(entry)
      || typeof entry.workItemId !== "string"
      || typeof entry.directoryPath !== "string"
      || typeof entry.infoPath !== "string"
      || typeof entry.outputDirectory !== "string") {
      throw new Error(`production-assets.assets[${index}] 结构无效。`);
    }
    parseProductionAssetDefinition(entry.definition, `production-assets.assets[${index}]`);
    parseAssetContract(entry.contract, `production-assets.assets[${index}]`);
    if (entry.authority !== undefined) parseAuthority(entry.authority, `production-assets.assets[${index}]`);
  }
  return value as unknown as FusionProductionAssetCatalog;
}

function parseMaterialization(value: unknown): FusionMaterializationReceipt {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "fusion-production-materialization"
    || typeof value.receiptId !== "string"
    || typeof value.createdAt !== "string"
    || typeof value.targetRoot !== "string"
    || typeof value.sourceContentAddress !== "string"
    || !CONTENT_ADDRESS_PATTERN.test(value.sourceContentAddress)
    || !Array.isArray(value.authorities)
    || !isRecord(value.counts)) {
    throw new Error("fusion-production-materialization 结构无效。 ");
  }
  value.authorities.forEach((authority, index) => parseAuthority(authority, `materialization.authorities[${index}]`));
  return value as unknown as FusionMaterializationReceipt;
}

function parseIndex(value: unknown): ProjectIndex {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !isRecord(value.project)
    || typeof value.project.id !== "string"
    || !Array.isArray(value.items)
    || !Array.isArray(value.artifacts)) {
    throw new Error("index 结构无效。 ");
  }
  for (const [index, artifact] of value.artifacts.entries()) {
    if (!isRecord(artifact)
      || typeof artifact.id !== "string"
      || typeof artifact.itemId !== "string"
      || typeof artifact.path !== "string"
      || typeof artifact.rootSlot !== "string"
      || typeof artifact.relativePath !== "string"
      || typeof artifact.kind !== "string"
      || typeof artifact.variant !== "string"
      || typeof artifact.authoritative !== "boolean"
      || typeof artifact.deprecated !== "boolean"
      || !isRecord(artifact.check)) {
      throw new Error(`index.artifacts[${index}] 结构无效。`);
    }
  }
  return value as unknown as ProjectIndex;
}

function parseReviewStore(value: unknown): ReviewStore {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.records)) {
    throw new Error("reviews 结构无效。 ");
  }
  for (const [index, record] of value.records.entries()) {
    if (!isRecord(record)
      || typeof record.id !== "string"
      || typeof record.itemId !== "string"
      || typeof record.reviewType !== "string"
      || !Array.isArray(record.artifactIds)
      || typeof record.decision !== "string"
      || typeof record.createdAt !== "string") {
      throw new Error(`reviews.records[${index}] 结构无效。`);
    }
  }
  return value as unknown as ReviewStore;
}

function parsePublicationStore(value: unknown): PublicationStore {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !Number.isInteger(value.revision)
    || !Array.isArray(value.intents)
    || !Array.isArray(value.receipts)) {
    throw new Error("publications 结构无效。 ");
  }
  return value as unknown as PublicationStore;
}

function parseProject(value: unknown): ProjectConfig {
  if (!isRecord(value)
    || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || typeof value.id !== "string"
    || !Array.isArray(value.hardLocks)) {
    throw new Error("project 结构无效。 ");
  }
  if ((value.schemaVersion === 1 && ("workspaceMode" in value || "minimumWriterSchemaVersion" in value))
    || (value.schemaVersion === 2
      && ((value.workspaceMode !== "novel" && value.workspaceMode !== "hybrid")
        || value.minimumWriterSchemaVersion !== 2))) {
    throw new Error("project writer 声明无效。 ");
  }
  for (const [index, hardLock] of value.hardLocks.entries()) {
    if (!isRecord(hardLock)
      || typeof hardLock.id !== "string"
      || typeof hardLock.name !== "string"
      || typeof hardLock.path !== "string") {
      throw new Error(`project.hardLocks[${index}] 结构无效。`);
    }
  }
  return value as unknown as ProjectConfig;
}

function semanticIndex(index: ProjectIndex, workItemIds: Set<string>): unknown {
  return {
    projectId: index.project.id,
    items: index.items
      .filter((item) => workItemIds.has(item.id))
      .map((item) => ({ id: item.id, type: item.type, artifactIds: item.artifactIds, hardLockIds: item.hardLockIds }))
      .sort((left, right) => left.id.localeCompare(right.id, "en")),
    artifacts: index.artifacts
      .filter((artifact) => workItemIds.has(artifact.itemId))
      .map((artifact) => ({
        id: artifact.id,
        itemId: artifact.itemId,
        path: artifact.path,
        rootSlot: artifact.rootSlot,
        relativePath: artifact.relativePath,
        kind: artifact.kind,
        variant: artifact.variant,
        deprecated: artifact.deprecated,
        authoritative: artifact.authoritative,
        check: {
          ok: artifact.check.ok,
          exists: artifact.check.exists,
          decodable: artifact.check.decodable,
          width: artifact.check.width,
          height: artifact.check.height,
          size: artifact.check.size,
          sha256: artifact.check.sha256,
          issues: artifact.check.issues,
        },
      }))
      .sort((left, right) => left.id.localeCompare(right.id, "en")),
  };
}

function normalizeIndexReferenceOrder(index: ProjectIndex): ProjectIndex {
  return {
    ...index,
    items: index.items.map((item) => ({
      ...item,
      artifactIds: [...new Set(item.artifactIds)].sort((left, right) => left.localeCompare(right, "en")),
    })),
  };
}

function loadRecoveryIndexFromSignedCache(projectRoot: string, projectId: string): ProjectIndex {
  const cachePath = getSidecarPaths(projectRoot).cache;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(cachePath, { readOnly: true });
    const items = (database.prepare("SELECT payload FROM items").all() as Array<{ payload?: unknown }>).map((row, index) => {
      if (typeof row.payload !== "string") throw new Error(`cache.items[${index}] 缺少 payload。`);
      return JSON.parse(row.payload) as ProjectIndex["items"][number];
    });
    const artifacts = (database.prepare("SELECT payload FROM artifacts").all() as Array<{ payload?: unknown }>).map((row, index) => {
      if (typeof row.payload !== "string") throw new Error(`cache.artifacts[${index}] 缺少 payload。`);
      return JSON.parse(row.payload) as Artifact;
    });
    return { project: { id: projectId } as ProjectIndex["project"], items, artifacts } as ProjectIndex;
  } catch (error) {
    throw new Error(`Scanner 恢复无法读取已提交 SQLite 缓存：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    database?.close();
  }
}

function semanticReviews(reviews: ReviewStore, workItemIds: Set<string>): unknown {
  return reviews.records.filter((record) => workItemIds.has(record.itemId)).sort(compareById);
}

function semanticPublications(store: PublicationStore, workItemIds: Set<string>): unknown {
  const receipts = store.receipts.filter((receipt) => Boolean(receipt.context.itemId && workItemIds.has(receipt.context.itemId))).sort(compareById);
  const intentIds = new Set(receipts.map((receipt) => receipt.intentId));
  return {
    intents: store.intents.filter((intent) => intentIds.has(intent.id)).sort(compareById),
    receipts,
  };
}

function deduplicateEquivalentIndexArtifacts(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.items) || !Array.isArray(value.artifacts)) return value;
  const clone = structuredClone(value) as Record<string, unknown> & { items: unknown[]; artifacts: unknown[] };
  const artifactsById = new Map<string, unknown[]>();
  for (const artifact of clone.artifacts) {
    if (!isRecord(artifact) || typeof artifact.id !== "string") continue;
    artifactsById.set(artifact.id, [...(artifactsById.get(artifact.id) ?? []), artifact]);
  }
  for (const [artifactId, entries] of artifactsById) {
    if (entries.length <= 1) continue;
    if (new Set(entries.map((entry) => digest(isRecord(entry) ? { ...entry, authoritative: undefined } : entry))).size !== 1) {
      throw new Error(`重复 Artifact ${artifactId} 的成员内容不一致，禁止自动去重。`);
    }
  }
  clone.artifacts = [...artifactsById.values()].map((entries) => entries.find((entry) => isRecord(entry) && entry.authoritative === true) ?? entries[0]!);
  clone.items = clone.items.map((item) => isRecord(item) && Array.isArray(item.artifactIds)
    ? { ...item, artifactIds: [...new Set(item.artifactIds)] }
    : item);
  return clone;
}

async function assertLegacyAssetRelationsEmpty(
  root: { root: string; real: string },
  filePath: string,
): Promise<void> {
  let snapshot: SafeFileSnapshot;
  try {
    snapshot = await safeFileSnapshot(root, filePath, "legacy asset-relations");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const value = parseJsonSnapshot(snapshot, "legacy asset-relations");
  if (!isRecord(value) || !Array.isArray(value.relations)) {
    throw new Error("legacy asset-relations.json 结构无效，无法证明其为空。");
  }
  if (value.relations.length > 0) {
    throw new Error(`legacy asset-relations.json 存在 ${value.relations.length} 条关系，当前迁移器不能无损转换，禁止静默生成空 relations。`);
  }
}

async function loadMigrationInputs(
  projectRoot: string,
  options: { deduplicateEquivalentIndexArtifacts?: boolean } = {},
): Promise<MigrationInputs> {
  const root = await canonicalProjectRoot(projectRoot);
  const paths = getSidecarPaths(root.root);
  await assertLegacyAssetRelationsEmpty(root, paths.assetRelations);
  const requested: Array<{ role: CanonicalAssetSourceFileSnapshot["role"]; path: string; label: string }> = [
    { role: "production-assets", path: paths.productionAssets, label: "production-assets" },
    { role: "materialization", path: path.join(root.root, "fusion-production-materialization.json"), label: "fusion-production-materialization" },
    { role: "index", path: paths.index, label: "index" },
    { role: "reviews", path: paths.reviews, label: "reviews" },
    { role: "publications", path: paths.publications, label: "publications" },
    { role: "project", path: paths.config, label: "project" },
  ];
  const snapshots = await Promise.all(requested.map(async (entry) => ({
    ...await safeFileSnapshot(root, entry.path, entry.label),
    role: entry.role,
    semanticSha256: "",
  })));
  const byRole = new Map(snapshots.map((snapshot) => [snapshot.role, snapshot]));
  const catalog = parseCatalog(parseJsonSnapshot(byRole.get("production-assets")!, "production-assets"));
  const materialization = parseMaterialization(parseJsonSnapshot(byRole.get("materialization")!, "materialization"));
  const rawIndex = parseJsonSnapshot(byRole.get("index")!, "index");
  const index = parseIndex(options.deduplicateEquivalentIndexArtifacts ? deduplicateEquivalentIndexArtifacts(rawIndex) : rawIndex);
  const reviews = parseReviewStore(parseJsonSnapshot(byRole.get("reviews")!, "reviews"));
  const publications = parsePublicationStore(parseJsonSnapshot(byRole.get("publications")!, "publications"));
  const project = parseProject(parseJsonSnapshot(byRole.get("project")!, "project"));
  const workItemIds = new Set(catalog.assets.map((entry) => entry.workItemId));
  const semantic: Record<CanonicalAssetSourceFileSnapshot["role"], unknown> = {
    "production-assets": {
      schemaVersion: catalog.schemaVersion,
      kind: catalog.kind,
      revision: catalog.revision,
      projectId: catalog.projectId,
      sourceContentAddress: catalog.sourceContentAddress,
      assets: catalog.assets,
    },
    materialization: {
      schemaVersion: materialization.schemaVersion,
      kind: materialization.kind,
      receiptId: materialization.receiptId,
      sourceContentAddress: materialization.sourceContentAddress,
      targetRoot: materialization.targetRoot,
      authorities: materialization.authorities,
      counts: materialization.counts,
    },
    index: semanticIndex(index, workItemIds),
    reviews: semanticReviews(reviews, workItemIds),
    publications: semanticPublications(publications, workItemIds),
    project: { id: project.id, hardLocks: project.hardLocks },
  };
  for (const snapshot of snapshots) snapshot.semanticSha256 = digest(semantic[snapshot.role]);
  return { catalog, materialization, index, reviews, publications, project, files: snapshots };
}

function definitionSnapshot(definition: ProductionAssetDefinition): CanonicalAssetDefinitionSnapshot {
  const { generationStatus: _generationStatus, hardLockStatus: _hardLockStatus, ...snapshot } = definition;
  return structuredClone(snapshot);
}

function buildDefinitionVersion(definition: ProductionAssetDefinition): CanonicalAssetDefinitionVersion {
  const snapshot = definitionSnapshot(definition);
  const fingerprint = digest({ schemaVersion: 1, kind: "canonical-asset-definition-version", assetId: definition.id, definition: snapshot });
  return {
    id: contentId(`asset-definition-${definition.id}`, fingerprint),
    assetId: definition.id,
    definition: snapshot,
    fingerprint,
  };
}

function buildContractVersion(assetId: string, contract: AssetGenerationContract): CanonicalAssetContractVersion {
  const snapshot = structuredClone(contract);
  const fingerprint = digest({ schemaVersion: 1, kind: "canonical-asset-contract-version", assetId, contract: snapshot });
  return {
    id: contentId(`asset-contract-${assetId}`, fingerprint),
    assetId,
    contract: snapshot,
    fingerprint,
  };
}

function buildIdentityFeature(
  assetId: string,
  key: CanonicalAssetIdentityFeature["key"],
  value: string,
  sourceDefinitionVersionId: string,
): CanonicalAssetIdentityFeature {
  const fingerprint = digest({ assetId, key, value, sourceDefinitionVersionId });
  return { id: contentId(`asset-feature-${assetId}`, fingerprint), key, value, sourceDefinitionVersionId };
}

function buildLockRule(input: Omit<CanonicalAssetLockRule, "id"> & { assetId: string }): CanonicalAssetLockRule {
  const fingerprint = digest(input);
  return {
    id: contentId(`asset-lock-${input.assetId}`, fingerprint),
    polarity: input.polarity,
    instruction: input.instruction,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
  };
}

function negativeRule(instruction: string): boolean {
  return /(?:禁止|不得|不可|绝无|永不|不允许|不得露出|不露)/u.test(instruction);
}

function authorityRules(assetId: string, authority: MaterializedAuthorityReference): {
  positive: CanonicalAssetLockRule[];
  negative: CanonicalAssetLockRule[];
} {
  const rules = authority.rules.map((instruction) => buildLockRule({
    assetId,
    polarity: negativeRule(instruction) ? "negative" : "positive",
    instruction,
    sourceKind: "legacy-authority",
    sourceId: `legacy-authority:${authority.id}`,
  }));
  return {
    positive: rules.filter((rule) => rule.polarity === "positive"),
    negative: rules.filter((rule) => rule.polarity === "negative"),
  };
}

function reviewedHardLockRules(assetId: string, reviewId: string): {
  positive: CanonicalAssetLockRule[];
  negative: CanonicalAssetLockRule[];
} {
  return {
    positive: [buildLockRule({
      assetId,
      polarity: "positive",
      instruction: "使用该 Review 冻结的 raw/labeled 原子媒体组合。",
      sourceKind: "reviewed-hard-lock",
      sourceId: `review:${reviewId}`,
    })],
    negative: [buildLockRule({
      assetId,
      polarity: "negative",
      instruction: "未创建新的已验收 Authority 前，禁止替换任一媒体成员。",
      sourceKind: "reviewed-hard-lock",
      sourceId: `review:${reviewId}`,
    })],
  };
}

function buildAlias(
  projectId: string,
  assetId: string,
  kind: CanonicalAssetAlias["kind"],
  value: string,
  source?: CanonicalAssetAlias["source"],
): CanonicalAssetAlias {
  const normalizedValue = normalizeAlias(value);
  if (!normalizedValue) throw new Error(`资产 ${assetId} 的 ${kind} alias 归一化后为空。`);
  const payload = {
    assetId,
    kind,
    status: "confirmed" as const,
    value,
    normalizedValue,
    scope: { projectId, crossProject: false as const },
    ...(source ? { source: structuredClone(source) } : {}),
  };
  const fingerprint = digest({ schemaVersion: 1, recordKind: "canonical-asset-alias", payload });
  return { id: contentId(`asset-alias-${assetId}`, fingerprint), ...payload, fingerprint };
}

function explicitDefinitionAliases(
  projectId: string,
  definitionVersion: CanonicalAssetDefinitionVersion,
  otherCanonicalNames: ReadonlySet<string>,
): CanonicalAssetAlias[] {
  const { assetId, definition } = definitionVersion;
  const source = (kind: "definition-name" | "definition-source-section", evidence: string): CanonicalAssetAlias["source"] => ({
    kind,
    definitionVersionId: definitionVersion.id,
    evidence,
  });
  const aliases: CanonicalAssetAlias[] = [];
  const suffixMatch = definition.name.match(/^(.*?)\s*[\uff08(]([^\uff08\uff09()]*)[\uff09)]\s*$/u);
  if (suffixMatch) {
    const subject = suffixMatch[1]!.trim();
    const parenthetical = suffixMatch[2]!.trim();
    if (subject) aliases.push(buildAlias(projectId, assetId, "formal-name-subject", subject, source("definition-name", definition.name)));

    // 括号中的制作规格、年龄/时期或场景范围不是同义称呼。只接受
    // 简短名词性名称，或显式以“又称/别称/正文称”声明的称呼。
    const explicitlyMarked = parenthetical.match(/^(?:又称|别称|正文称)[「『“"]?([^」』”"]+)[」』”"]?$/u)?.[1]?.trim();
    const descriptorPattern = /(?:正面|侧面|全身|奔跑|视图|群像|群演|资产|通用|当代|童年|成年|婴儿|年长|中年|含|阶段|主场景|神魔层|周原|蜀道|彩蛋|专用|旧物|变体|记录|物证|声源|残口|雨|火堆|坍塌|枚|版|图|\+|\/|\d|[\u4e00二三四五六七八九十]枚)/u;
    const sharesExplicitIdentitySuffix = definition.category === "prop"
      || (definition.category === "scene" && subject.endsWith("村") && parenthetical.endsWith("村"))
      || (definition.category === "character" && subject.endsWith("长者") && parenthetical.endsWith("长者"));
    const plainName = parenthetical.length >= 2 && parenthetical.length <= 16
      && !descriptorPattern.test(parenthetical)
      && !otherCanonicalNames.has(normalizeAlias(parenthetical))
      && sharesExplicitIdentitySuffix
      ? parenthetical
      : undefined;
    const parentheticalName = explicitlyMarked ?? plainName;
    if (parentheticalName) {
      aliases.push(buildAlias(projectId, assetId, "explicit-parenthetical-name", parentheticalName, source("definition-name", definition.name)));
    }
  }

  const sameAssetPattern = /(?:正文称|文中称)[「『“"]([^」』”"\n]{1,80})[」』”"][^。；;\n]{0,120}与本资产为同一/gu;
  for (const match of definition.sourceSection.matchAll(sameAssetPattern)) {
    const value = match[1]!.trim();
    if (!value) continue;
    aliases.push(buildAlias(projectId, assetId, "explicit-same-asset-name", value, source("definition-source-section", match[0])));
  }
  return mergeAppendOnlyById([], aliases, `CanonicalAssetAlias ${assetId}`);
}

function legacyMediaContentIdentity(media: readonly CanonicalAssetMediaReference[]): unknown {
  return media.map((entry) => ({ kind: entry.kind, role: entry.role, bytes: entry.bytes, sha256: entry.sha256 }));
}

function normalizeVersionInput(
  input: Omit<CanonicalAssetVersion, "id" | "fingerprint">,
): Omit<CanonicalAssetVersion, "id" | "fingerprint"> {
  return {
    ...structuredClone(input),
    media: input.media.slice().sort((left, right) => (left.role === right.role
      ? left.path.localeCompare(right.path, "en")
      : left.role === "raw" ? -1 : 1)),
    reviewIds: [...new Set(input.reviewIds)].sort((left, right) => left.localeCompare(right, "en")),
  };
}

function legacyVersionFingerprint(input: Omit<CanonicalAssetVersion, "id" | "fingerprint">): string {
  const normalized = normalizeVersionInput(input);
  return digest({
    schemaVersion: 1,
    kind: "canonical-asset-version",
    assetId: normalized.assetId,
    definitionVersionId: normalized.definitionVersionId,
    contractVersionId: normalized.contractVersionId,
    representation: normalized.representation,
    media: legacyMediaContentIdentity(normalized.media),
  });
}

function buildVersion(input: Omit<CanonicalAssetVersion, "id" | "fingerprint">): CanonicalAssetVersion {
  const normalized = normalizeVersionInput(input);
  const fingerprint = digest({
    schemaVersion: 1,
    recordKind: "canonical-asset-version",
    fingerprintVersion: 2,
    payload: normalized,
  });
  return {
    ...normalized,
    id: contentId(`asset-version-${normalized.assetId}`, fingerprint),
    fingerprint,
  };
}

function buildOrReuseVersion(
  input: Omit<CanonicalAssetVersion, "id" | "fingerprint">,
  historical: readonly CanonicalAssetVersion[],
): CanonicalAssetVersion {
  const normalized = normalizeVersionInput(input);
  const equivalent = historical.find((version) => {
    const { id: _id, fingerprint: _fingerprint, ...storedInput } = version;
    return stableEqual(normalizeVersionInput(storedInput), normalized);
  });
  return equivalent ? structuredClone(equivalent) : buildVersion(normalized);
}

function legacyAuthorityFingerprintPayload(authority: Omit<CanonicalAssetAuthority, "id" | "fingerprint">): unknown {
  const { createdAt: _createdAt, ...semantic } = authority;
  return { schemaVersion: 1, recordKind: "canonical-asset-authority", payload: semantic };
}

function buildAuthority(input: Omit<CanonicalAssetAuthority, "id" | "fingerprint">): CanonicalAssetAuthority {
  const fingerprint = digest({
    schemaVersion: 1,
    recordKind: "canonical-asset-authority",
    fingerprintVersion: 2,
    payload: input,
  });
  return { ...input, id: contentId(`asset-authority-${input.assetId}`, fingerprint), fingerprint };
}

function buildOrReuseAuthority(
  input: Omit<CanonicalAssetAuthority, "id" | "fingerprint">,
  historical: readonly CanonicalAssetAuthority[],
): CanonicalAssetAuthority {
  const equivalent = historical.find((authority) => {
    const { id: _id, fingerprint: _fingerprint, ...storedInput } = authority;
    return stableEqual(storedInput, input);
  });
  return equivalent ? structuredClone(equivalent) : buildAuthority(input);
}

function buildRelation(input: Omit<CanonicalAssetRelation, "id" | "fingerprint">): CanonicalAssetRelation {
  const payload = {
    kind: input.kind,
    from: input.from,
    to: input.to,
    evidenceSource: input.evidenceSource,
  };
  const fingerprint = digest({ schemaVersion: 1, recordKind: "canonical-asset-relation", payload });
  return { ...input, id: contentId("asset-relation", fingerprint), fingerprint };
}

function authorityLineageKey(authority: CanonicalAssetAuthority): string {
  const sourceId = authority.source.kind === "legacy-authority"
    ? `legacy-authority:${authority.source.legacyAuthorityId}`
    : `reviewed-hard-lock:${authority.source.legacyHardLockId}`;
  return `${authority.assetId}:${authority.role}:${sourceId}`;
}

function buildAnomaly(input: Omit<CanonicalAssetMigrationAnomaly, "id" | "fingerprint">): CanonicalAssetMigrationAnomaly {
  const fingerprint = digest({ schemaVersion: 1, kind: "canonical-asset-migration-anomaly", ...input });
  return { ...input, id: contentId("asset-migration-anomaly", fingerprint), fingerprint };
}

function pairStem(filePath: string, role: "raw" | "labeled"): string | null {
  const parsed = path.parse(filePath);
  const suffix = `_${role}`;
  if (!parsed.name.endsWith(suffix)) return null;
  return path.join(parsed.dir, `${parsed.name.slice(0, -suffix.length)}${parsed.ext}`);
}

function assertAtomicPair(raw: Artifact, labeled: Artifact, assetId: string): void {
  const rawStem = pairStem(raw.path, "raw");
  const labeledStem = pairStem(labeled.path, "labeled");
  if (!rawStem || !labeledStem || rawStem !== labeledStem) {
    throw new Error(`资产 ${assetId} 的 raw/labeled 不是同一原子 pair：${raw.path} / ${labeled.path}`);
  }
}

function assertArtifactEvidence(
  evidence: ReviewArtifactEvidence,
  artifact: Artifact,
  label: string,
): void {
  if (evidence.artifactId !== artifact.id
    || path.resolve(evidence.path) !== path.resolve(artifact.path)
    || evidence.rootSlot !== artifact.rootSlot
    || evidence.relativePath !== artifact.relativePath
    || evidence.kind !== artifact.kind
    || evidence.variant !== artifact.variant
    || evidence.size !== artifact.check.size
    || evidence.sha256 !== artifact.check.sha256) {
    throw new Error(`${label} 与当前 Artifact 内容身份不一致：${artifact.id}`);
  }
}

function selectReview(records: ReviewRecord[], itemId: string, raw: Artifact, labeled: Artifact): ReviewRecord {
  const artifactIds = new Set([raw.id, labeled.id]);
  const candidates = records
    .filter((record) => record.itemId === itemId
      && record.reviewType === "image"
      && record.artifactEvidence?.some((entry) => artifactIds.has(entry.artifactId)))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt, "en") || right.id.localeCompare(left.id, "en"));
  const selected = candidates[0];
  if (!selected) throw new Error(`${itemId} 缺少覆盖当前 raw/labeled 的 Review 证据。`);
  if (selected.decision !== "pass" || selected.resultingStatus !== "已完成") {
    throw new Error(`${itemId} 的最新当前 Review 不是 pass/已完成：${selected.id}`);
  }
  const selectedIds = [...selected.artifactIds].sort();
  if (selectedIds.length !== 2 || selectedIds[0] !== [...artifactIds].sort()[0] || selectedIds[1] !== [...artifactIds].sort()[1]) {
    throw new Error(`${itemId} Review 未精确冻结 raw/labeled 两个 Artifact：${selected.id}`);
  }
  const evidence = selected.artifactEvidence ?? [];
  if (evidence.length !== 2) throw new Error(`${itemId} Review evidence 必须恰好包含 raw/labeled 两项：${selected.id}`);
  const rawEvidence = evidence.find((entry) => entry.artifactId === raw.id);
  const labeledEvidence = evidence.find((entry) => entry.artifactId === labeled.id);
  if (!rawEvidence || !labeledEvidence) throw new Error(`${itemId} Review evidence 悬空：${selected.id}`);
  assertArtifactEvidence(rawEvidence, raw, `${itemId} raw Review`);
  assertArtifactEvidence(labeledEvidence, labeled, `${itemId} labeled Review`);
  return selected;
}

function findPublicationReceipt(
  store: PublicationStore,
  artifact: Artifact,
  required: boolean,
): { receipt?: PublicationReceipt; intentId?: string; generationJobId?: string } {
  const matches = store.receipts.filter((receipt) => receipt.context.itemId === artifact.itemId
    && path.resolve(receipt.targetPath) === path.resolve(artifact.path)
    && receipt.kind === artifact.kind
    && receipt.variant === artifact.variant);
  if (matches.length > 1) throw new Error(`${artifact.id} 对应多个 Publication receipt。`);
  const receipt = matches[0];
  if (!receipt) {
    if (required) throw new Error(`${artifact.id} 缺少必须的 Publication receipt。`);
    return {};
  }
  if (receipt.check.sha256 !== artifact.check.sha256 || receipt.check.size !== artifact.check.size || !receipt.check.ok) {
    throw new Error(`${artifact.id} Publication receipt 与当前 Artifact SHA/size 不一致。`);
  }
  const intent = store.intents.find((candidate) => candidate.id === receipt.intentId);
  if (!intent || intent.status !== "registered" || intent.receiptId !== receipt.id
    || path.resolve(intent.targetPath) !== path.resolve(receipt.targetPath)) {
    throw new Error(`${artifact.id} Publication receipt 的 intent 悬空或未注册：${receipt.id}`);
  }
  return { receipt, intentId: intent.id, generationJobId: receipt.context.jobId };
}

function assertArtifactMechanicalIdentity(artifact: Artifact, snapshot: SafeFileSnapshot, label: string): void {
  if (!artifact.authoritative || artifact.deprecated
    || artifact.check.ok !== true || artifact.check.exists !== true
    || !artifact.check.sha256 || !SHA256_PATTERN.test(artifact.check.sha256)
    || artifact.check.sha256 !== snapshot.sha256
    || artifact.check.size !== snapshot.bytes) {
    throw new Error(`${label} 不是当前机械有效且 SHA/size 一致的权威 Artifact：${artifact.id}`);
  }
}

function mediaReference(
  projectRoot: string,
  artifact: Artifact | undefined,
  snapshot: SafeFileSnapshot,
  input: {
    role: "raw" | "labeled";
    provenance: CanonicalAssetMediaReference["provenance"];
    publicationIntentId?: string;
    publicationReceiptId?: string;
  },
): CanonicalAssetMediaReference {
  const relativePath = artifact?.relativePath ?? path.relative(projectRoot, snapshot.path).split(path.sep).join("/");
  return {
    kind: "image",
    role: input.role,
    path: snapshot.path,
    rootSlot: artifact?.rootSlot ?? "main",
    relativePath,
    bytes: snapshot.bytes,
    sha256: snapshot.sha256,
    ...(artifact ? { artifactId: artifact.id } : {}),
    ...(input.publicationIntentId ? { publicationIntentId: input.publicationIntentId } : {}),
    ...(input.publicationReceiptId ? { publicationReceiptId: input.publicationReceiptId } : {}),
    provenance: input.provenance,
  };
}

function sameAuthority(left: MaterializedAuthorityReference, right: MaterializedAuthorityReference): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function storeFingerprintPayload(store: Omit<CanonicalAssetStore, "storeFingerprint">): unknown {
  const { updatedAt: _updatedAt, ...semantic } = store;
  return semantic;
}

function fingerprintStore(store: Omit<CanonicalAssetStore, "storeFingerprint">): string {
  return digest(storeFingerprintPayload(store));
}

function supportingAuthorityIdsFor(
  store: Pick<CanonicalAssetStore, "authorities">,
  asset: CanonicalAsset,
): string[] {
  if (Array.isArray(asset.currentSupportingAuthorityIds)) {
    return [...new Set(asset.currentSupportingAuthorityIds)].sort((left, right) => left.localeCompare(right, "en"));
  }
  // 向后兼容首版 schema v1：当时 Authority 尚未保留历史，所有
  // supporting-identity 都是当前 head。新 store 始终显式写入 head ID。
  return store.authorities
    .filter((authority) => authority.assetId === asset.id && authority.role === "supporting-identity")
    .map((authority) => authority.id)
    .sort((left, right) => left.localeCompare(right, "en"));
}

function currentAuthorityIdsFor(
  store: Pick<CanonicalAssetStore, "authorities">,
  asset: CanonicalAsset,
): string[] {
  return [asset.primaryAuthorityId, ...supportingAuthorityIdsFor(store, asset)]
    .filter((value): value is string => Boolean(value));
}

function countsFor(store: Pick<CanonicalAssetStore,
  "assets" | "aliases" | "definitionVersions" | "contractVersions" | "versions" | "authorities" | "relations">): CanonicalAssetCounts {
  const versionAssetIds = new Set(store.versions.map((version) => version.assetId));
  return {
    assets: store.assets.length,
    aliases: store.aliases.length,
    definitionVersions: store.definitionVersions.length,
    contractVersions: store.contractVersions.length,
    versions: store.versions.length,
    authorities: store.authorities.length,
    relations: store.relations.length,
    media: store.versions.reduce((total, version) => total + version.media.length, 0),
    assetsWithVersions: versionAssetIds.size,
    assetsWithoutVersions: store.assets.length - versionAssetIds.size,
    primaryAuthorities: store.assets.filter((asset) => Boolean(asset.primaryAuthorityId)).length,
    supportingAuthorities: store.assets.reduce((total, asset) => total + supportingAuthorityIdsFor(store, asset).length, 0),
    byCategory: {
      character: store.assets.filter((asset) => asset.category === "character").length,
      scene: store.assets.filter((asset) => asset.category === "scene").length,
      prop: store.assets.filter((asset) => asset.category === "prop").length,
    },
  };
}

async function assembleCandidateStore(
  projectRoot: string,
  inputs: MigrationInputs,
  revision: number,
  previous: CanonicalAssetStore | null = null,
): Promise<CanonicalAssetStore> {
  const root = await canonicalProjectRoot(projectRoot);
  const { catalog, materialization, index, reviews, publications, project } = inputs;
  if (catalog.projectId !== project.id || index.project.id !== project.id) {
    throw new Error(`projectId 不一致：catalog=${catalog.projectId} / index=${index.project.id} / project=${project.id}`);
  }
  if (catalog.sourceContentAddress !== materialization.sourceContentAddress) {
    throw new Error("production-assets 与 materialization 的 sourceContentAddress 不一致。 ");
  }
  if (path.resolve(materialization.targetRoot) !== root.root) {
    throw new Error(`materialization.targetRoot 与当前工程不一致：${materialization.targetRoot}`);
  }
  const targetReal = await realpath(materialization.targetRoot);
  if (targetReal !== root.real) throw new Error("materialization.targetRoot realpath 与当前工程不一致。 ");
  if (catalog.assets.length === 0) throw new Error("production-assets 为空，不能建立规范资产库。 ");

  const assetEntries = catalog.assets.slice().sort((left, right) => left.definition.id.localeCompare(right.definition.id, "en"));
  uniqueById(assetEntries.map((entry) => ({ id: entry.definition.id })), "production asset");
  uniqueById(assetEntries.map((entry) => ({ id: entry.workItemId })), "production work item");
  const entryByAssetId = new Map(assetEntries.map((entry) => [entry.definition.id, entry]));
  const entryByWorkItemId = new Map(assetEntries.map((entry) => [entry.workItemId, entry]));

  for (const entry of assetEntries) {
    const { definition, contract } = entry;
    if (contract.assetId !== definition.id || contract.assetCategory !== definition.category) {
      throw new Error(`资产 ${definition.id} 的 contract ID/category 与显式 definition 不一致。`);
    }
    if (createHash("sha256").update(definition.sourceSection).digest("hex") !== definition.sourceSectionSha256) {
      throw new Error(`资产 ${definition.id} sourceSectionSha256 与原文不一致。`);
    }
    for (const [label, candidate] of [["directoryPath", entry.directoryPath], ["infoPath", entry.infoPath], ["outputDirectory", entry.outputDirectory]] as const) {
      if (!path.isAbsolute(candidate) || !sameOrInside(path.resolve(candidate), root.root)) {
        throw new Error(`资产 ${definition.id} ${label} 越出当前工程：${candidate}`);
      }
    }
  }

  const categoryCounts = {
    character: assetEntries.filter((entry) => entry.definition.category === "character").length,
    scene: assetEntries.filter((entry) => entry.definition.category === "scene").length,
    prop: assetEntries.filter((entry) => entry.definition.category === "prop").length,
  };
  const expectedCounts = materialization.counts;
  if (expectedCounts.assets !== assetEntries.length
    || expectedCounts.characters !== categoryCounts.character
    || expectedCounts.scenes !== categoryCounts.scene
    || expectedCounts.props !== categoryCounts.prop) {
    throw new Error(`materialization 资产计数与显式类别不一致：实际 ${assetEntries.length}=${categoryCounts.character}/${categoryCounts.scene}/${categoryCounts.prop}`);
  }

  const indexItems = new Map(index.items.map((item) => [item.id, item]));
  for (const entry of assetEntries) {
    const item = indexItems.get(entry.workItemId);
    if (!item || item.type !== "asset") throw new Error(`规范资产 ${entry.definition.id} 缺少当前 index asset item：${entry.workItemId}`);
  }
  const catalogWorkItemIds = new Set(entryByWorkItemId.keys());
  const catalogArtifacts = index.artifacts.filter((artifact) => catalogWorkItemIds.has(artifact.itemId));
  uniqueById(catalogArtifacts, "catalog Artifact");
  for (const artifact of index.artifacts.filter((candidate) => candidate.itemId.startsWith("asset-") && !entryByWorkItemId.has(candidate.itemId))) {
    if (artifact.authoritative && !artifact.deprecated) throw new Error(`index 存在不属于 catalog 的活动资产 Artifact：${artifact.id}`);
  }

  const currentDefinitionVersions = assetEntries.map((entry) => buildDefinitionVersion(entry.definition)).sort(compareById);
  const definitionByAsset = new Map(currentDefinitionVersions.map((version) => [version.assetId, version]));
  const definitionVersions = mergeAppendOnlyById(previous?.definitionVersions ?? [], currentDefinitionVersions, "CanonicalAssetDefinitionVersion");
  const currentContractVersions = assetEntries.map((entry) => buildContractVersion(entry.definition.id, entry.contract)).sort(compareById);
  const contractByAsset = new Map(currentContractVersions.map((version) => [version.assetId, version]));
  const contractVersions = mergeAppendOnlyById(previous?.contractVersions ?? [], currentContractVersions, "CanonicalAssetContractVersion");
  const canonicalNames = new Set(assetEntries.map((entry) => normalizeAlias(entry.definition.name)));
  const aliases = assetEntries.flatMap((entry) => {
    const definitionVersion = definitionByAsset.get(entry.definition.id)!;
    return [
      buildAlias(project.id, entry.definition.id, "formal-id", entry.definition.id, {
        kind: "definition-id",
        definitionVersionId: definitionVersion.id,
        evidence: entry.definition.id,
      }),
      buildAlias(project.id, entry.definition.id, "formal-name", entry.definition.name, {
        kind: "definition-name",
        definitionVersionId: definitionVersion.id,
        evidence: entry.definition.name,
      }),
      ...explicitDefinitionAliases(project.id, definitionVersion, canonicalNames),
    ];
  }).sort(compareById);
  const aliasOwner = new Map<string, string>();
  for (const alias of aliases) {
    const existing = aliasOwner.get(alias.normalizedValue);
    if (existing && existing !== alias.assetId) {
      throw new Error(`confirmed alias 归一化冲突：${alias.value} 同时指向 ${existing} 与 ${alias.assetId}`);
    }
    aliasOwner.set(alias.normalizedValue, alias.assetId);
  }

  const migrationAnomalies: CanonicalAssetMigrationAnomaly[] = [];
  for (const definitionVersion of currentDefinitionVersions) {
    const sourceTail = definitionVersion.definition.sourceSection.replace(/^###[^\n]*(?:\n|$)/u, "");
    if (/^##\s+/mu.test(sourceTail)) {
      migrationAnomalies.push(buildAnomaly({
        code: "definition-source-section-overrun",
        severity: "warning",
        assetId: definitionVersion.assetId,
        message: `${definitionVersion.assetId} 的旧 sourceSection 越过资产小节并包含后续二级章节；已原样冻结，未静默裁切。`,
        sourceVersionId: definitionVersion.id,
      }));
    }
  }
  const aspectRatios = [...new Set(currentContractVersions.map((version) => version.contract.aspectRatio))].sort();
  if (assetEntries.length > 1 && aspectRatios.length === 1 && Object.values(categoryCounts).filter((count) => count > 0).length > 1) {
    migrationAnomalies.push(buildAnomaly({
      code: "uniform-contract-aspect-ratio",
      severity: "warning",
      message: `${assetEntries.length} 份旧合同跨显式类别统一冻结为 ${aspectRatios[0]}；迁移未按源比例表修正旧合同。`,
    }));
  }
  migrationAnomalies.sort(compareById);

  const authorityInputs = materialization.authorities.slice().sort((left, right) => left.id.localeCompare(right.id, "en"));
  uniqueById(authorityInputs, "materialization authority");
  const authorityInputById = new Map(authorityInputs.map((authority) => [authority.id, authority]));
  for (const entry of assetEntries) {
    if (!entry.authority) continue;
    const receiptAuthority = authorityInputById.get(entry.authority.id);
    if (!receiptAuthority || !sameAuthority(entry.authority, receiptAuthority)) {
      throw new Error(`资产 ${entry.definition.id} 的 catalog authority 与 materialization 不一致。`);
    }
  }

  const currentVersions: CanonicalAssetVersion[] = [];
  const currentAuthorities: CanonicalAssetAuthority[] = [];
  const primaryAuthorityByAsset = new Map<string, string>();
  const supportingAuthorityIdsByAsset = new Map<string, string[]>();
  const positiveLocksByAsset = new Map<string, CanonicalAssetLockRule[]>();
  const negativeLocksByAsset = new Map<string, CanonicalAssetLockRule[]>();
  const consumedArtifactIds = new Set<string>();
  const consumedReceiptIds = new Set<string>();
  const mediaSnapshotByPath = new Map<string, SafeFileSnapshot>();

  const snapshotMedia = async (filePath: string, label: string): Promise<SafeFileSnapshot> => {
    const normalized = path.resolve(filePath);
    const cached = mediaSnapshotByPath.get(normalized);
    if (cached) return cached;
    const snapshot = await safeFileSnapshot(root, normalized, label);
    mediaSnapshotByPath.set(normalized, snapshot);
    return snapshot;
  };
  const appendLocks = (assetId: string, positive: CanonicalAssetLockRule[], negative: CanonicalAssetLockRule[]): void => {
    positiveLocksByAsset.set(assetId, [...(positiveLocksByAsset.get(assetId) ?? []), ...positive]);
    negativeLocksByAsset.set(assetId, [...(negativeLocksByAsset.get(assetId) ?? []), ...negative]);
  };
  const setPrimary = (assetId: string, authorityId: string): void => {
    const existing = primaryAuthorityByAsset.get(assetId);
    if (existing) throw new Error(`资产 ${assetId} 出现多个主 Authority：${existing} / ${authorityId}`);
    primaryAuthorityByAsset.set(assetId, authorityId);
  };
  const addSupporting = (assetId: string, authorityId: string): void => {
    supportingAuthorityIdsByAsset.set(assetId, [
      ...(supportingAuthorityIdsByAsset.get(assetId) ?? []),
      authorityId,
    ]);
  };

  for (const legacy of authorityInputs) {
    let assetId = legacy.assetId;
    let supporting = false;
    if (!assetId) {
      if (legacy.id !== "golden-mask" || !entryByAssetId.has("P01")) {
        throw new Error(`未绑定且没有显式一次性迁移映射的 authority：${legacy.id}`);
      }
      if (legacy.exposeToGeneration !== false) throw new Error("golden-mask legacy authority 必须保持 exposeToGeneration=false。 ");
      assetId = "P01";
      supporting = true;
    }
    const entry = entryByAssetId.get(assetId);
    if (!entry) throw new Error(`authority ${legacy.id} 指向不存在的规范资产：${assetId}`);
    if (!supporting) {
      if (!entry.authority || !sameAuthority(entry.authority, legacy)) {
        throw new Error(`authority ${legacy.id} 没有与 catalog 资产 ${assetId} 双向绑定。`);
      }
      if (!legacy.exposeToGeneration) throw new Error(`主 user authority ${legacy.id} 不允许静默设为禁止暴露。`);
      const reference = entry.contract.authorityReferences.find((candidate) => path.resolve(candidate.path) === path.resolve(legacy.snapshotPath));
      if (!reference || reference.sha256 !== legacy.snapshotSha256 || reference.role !== "authority") {
        throw new Error(`资产 ${assetId} contract 没有冻结对应 user authority SHA。`);
      }
    }
    if (legacy.sourceSha256 !== legacy.snapshotSha256) {
      throw new Error(`authority ${legacy.id} source/snapshot SHA 不一致。`);
    }
    const snapshot = await snapshotMedia(legacy.snapshotPath, `authority ${legacy.id} snapshot`);
    if (snapshot.sha256 !== legacy.snapshotSha256) throw new Error(`authority ${legacy.id} snapshot SHA 已漂移。`);

    let artifact: Artifact | undefined;
    if (!supporting) {
      const matches = catalogArtifacts.filter((candidate) => candidate.itemId === entry.workItemId
        && path.resolve(candidate.path) === path.resolve(legacy.snapshotPath)
        && candidate.kind === "raw-image" && candidate.variant === "generic"
        && candidate.authoritative && !candidate.deprecated);
      if (matches.length !== 1) throw new Error(`authority ${legacy.id} 必须唯一映射一个当前 raw Artifact。`);
      artifact = matches[0]!;
      assertArtifactMechanicalIdentity(artifact, snapshot, `authority ${legacy.id}`);
      consumedArtifactIds.add(artifact.id);
    }

    const media = mediaReference(root.root, artifact, snapshot, { role: "raw", provenance: "authority-snapshot" });
    const version = buildOrReuseVersion({
      assetId,
      definitionVersionId: definitionByAsset.get(assetId)!.id,
      contractVersionId: contractByAsset.get(assetId)!.id,
      representation: supporting ? "supporting-reference" : "primary-reference",
      media: [media],
      reviewIds: [],
      createdAt: materialization.createdAt,
    }, previous?.versions ?? []);
    currentVersions.push(version);
    const rules = authorityRules(assetId, legacy);
    const authority = buildOrReuseAuthority({
      assetId,
      assetVersionId: version.id,
      kind: "user-provided",
      role: supporting ? "supporting-identity" : "primary-identity",
      exposure: supporting ? "forbidden" : "allowed",
      scope: {
        projectId: project.id,
        usage: supporting ? "human-review-only" : "generation-reference",
        crossProject: false,
      },
      positiveLocks: rules.positive,
      negativeLocks: rules.negative,
      source: {
        kind: "legacy-authority",
        legacyAuthorityId: legacy.id,
        name: legacy.name,
        sourcePath: legacy.sourcePath,
        sourceSha256: legacy.sourceSha256,
        snapshotPath: legacy.snapshotPath,
        snapshotSha256: legacy.snapshotSha256,
        exposeToGeneration: legacy.exposeToGeneration,
      },
      createdAt: materialization.createdAt,
    }, previous?.authorities ?? []);
    currentAuthorities.push(authority);
    appendLocks(assetId, rules.positive, rules.negative);
    if (supporting) addSupporting(assetId, authority.id);
    else setPrimary(assetId, authority.id);
  }

  const hardLocks = project.hardLocks.slice().sort((left, right) => left.id.localeCompare(right.id, "en"));
  uniqueById(hardLocks, "project hardLock");
  for (const hardLock of hardLocks) {
    const entry = entryByAssetId.get(hardLock.id);
    if (!entry) throw new Error(`project hardLock 指向不存在的规范资产：${hardLock.id}`);
    const active = catalogArtifacts.filter((artifact) => artifact.itemId === entry.workItemId && artifact.authoritative && !artifact.deprecated);
    const rawMatches = active.filter((artifact) => artifact.kind === "raw-image" && artifact.variant === "generic");
    const labeledMatches = active.filter((artifact) => artifact.kind === "labeled-image" && artifact.variant === "generic");
    if (rawMatches.length !== 1 || labeledMatches.length !== 1) {
      throw new Error(`reviewed hardLock ${hardLock.id} 必须唯一对应一个 raw/labeled pair。`);
    }
    const raw = rawMatches[0]!;
    const labeled = labeledMatches[0]!;
    if (path.resolve(hardLock.path) !== path.resolve(raw.path)) {
      throw new Error(`hardLock ${hardLock.id} 路径未指向当前 raw Artifact。`);
    }
    assertAtomicPair(raw, labeled, hardLock.id);
    const [rawSnapshot, labeledSnapshot] = await Promise.all([
      snapshotMedia(raw.path, `${hardLock.id} raw`),
      snapshotMedia(labeled.path, `${hardLock.id} labeled`),
    ]);
    assertArtifactMechanicalIdentity(raw, rawSnapshot, `${hardLock.id} raw`);
    assertArtifactMechanicalIdentity(labeled, labeledSnapshot, `${hardLock.id} labeled`);
    const review = selectReview(reviews.records, entry.workItemId, raw, labeled);
    const rawPublication = findPublicationReceipt(publications, raw, true);
    const labeledPublication = findPublicationReceipt(publications, labeled, false);
    if (rawPublication.receipt) consumedReceiptIds.add(rawPublication.receipt.id);
    if (labeledPublication.receipt) consumedReceiptIds.add(labeledPublication.receipt.id);
    const version = buildOrReuseVersion({
      assetId: hardLock.id,
      definitionVersionId: definitionByAsset.get(hardLock.id)!.id,
      contractVersionId: contractByAsset.get(hardLock.id)!.id,
      representation: "production-output",
      media: [
        mediaReference(root.root, raw, rawSnapshot, {
          role: "raw",
          provenance: "review-evidence",
          publicationIntentId: rawPublication.intentId,
          publicationReceiptId: rawPublication.receipt?.id,
        }),
        mediaReference(root.root, labeled, labeledSnapshot, {
          role: "labeled",
          provenance: "review-evidence",
          publicationIntentId: labeledPublication.intentId,
          publicationReceiptId: labeledPublication.receipt?.id,
        }),
      ],
      reviewIds: [review.id],
      ...(rawPublication.generationJobId ? { generationJobId: rawPublication.generationJobId } : {}),
      createdAt: review.createdAt,
    }, previous?.versions ?? []);
    currentVersions.push(version);
    const rules = reviewedHardLockRules(hardLock.id, review.id);
    const authority = buildOrReuseAuthority({
      assetId: hardLock.id,
      assetVersionId: version.id,
      kind: "reviewed-hard-lock",
      role: "production-hard-lock",
      exposure: "allowed",
      scope: { projectId: project.id, usage: "generation-reference", crossProject: false },
      reviewId: review.id,
      positiveLocks: rules.positive,
      negativeLocks: rules.negative,
      source: {
        kind: "reviewed-hard-lock",
        legacyHardLockId: hardLock.id,
        name: hardLock.name,
        path: hardLock.path,
        ...(hardLock.note ? { note: hardLock.note } : {}),
      },
      createdAt: review.createdAt,
    }, previous?.authorities ?? []);
    currentAuthorities.push(authority);
    appendLocks(hardLock.id, rules.positive, rules.negative);
    setPrimary(hardLock.id, authority.id);
    consumedArtifactIds.add(raw.id);
    consumedArtifactIds.add(labeled.id);
  }

  for (const artifact of catalogArtifacts.filter((candidate) => candidate.authoritative && !candidate.deprecated)) {
    if (!consumedArtifactIds.has(artifact.id)) throw new Error(`活动权威 Artifact 没有进入任何规范版本：${artifact.id}`);
  }
  for (const review of reviews.records.filter((candidate) => catalogWorkItemIds.has(candidate.itemId))) {
    if (!review.artifactEvidence?.length) throw new Error(`资产 Review 缺少不可变 artifactEvidence：${review.id}`);
    for (const artifactId of review.artifactIds) {
      const artifact = catalogArtifacts.find((candidate) => candidate.id === artifactId);
      if (!artifact) throw new Error(`资产 Review 引用悬空 Artifact：${review.id} -> ${artifactId}`);
      if (!consumedArtifactIds.has(artifactId)) throw new Error(`资产 Review 对应的版本未迁移：${review.id} -> ${artifactId}`);
      const evidence = review.artifactEvidence.find((candidate) => candidate.artifactId === artifactId);
      if (!evidence) throw new Error(`资产 Review artifactEvidence 悬空：${review.id} -> ${artifactId}`);
      assertArtifactEvidence(evidence, artifact, `Review ${review.id}`);
    }
  }
  for (const receipt of publications.receipts.filter((candidate) => Boolean(candidate.context.itemId && catalogWorkItemIds.has(candidate.context.itemId)))) {
    if (!consumedReceiptIds.has(receipt.id)) throw new Error(`资产 Publication receipt 未进入规范版本：${receipt.id}`);
  }

  currentVersions.sort(compareById);
  currentAuthorities.sort(compareById);
  uniqueById(currentVersions, "current canonical AssetVersion");
  uniqueById(currentAuthorities, "current canonical Authority");
  const versions = mergeAppendOnlyById(previous?.versions ?? [], currentVersions, "CanonicalAssetVersion");
  const authorities = mergeAppendOnlyById(previous?.authorities ?? [], currentAuthorities, "CanonicalAssetAuthority");
  const versionById = new Map(versions.map((version) => [version.id, version]));
  for (const authority of authorities) {
    const version = versionById.get(authority.assetVersionId);
    if (!version || version.assetId !== authority.assetId) throw new Error(`Authority 版本悬空：${authority.id}`);
  }

  const assets = assetEntries.map((entry): CanonicalAsset => {
    const definitionVersion = definitionByAsset.get(entry.definition.id)!;
    const contractVersion = contractByAsset.get(entry.definition.id)!;
    const previousAsset = previous?.assets.find((asset) => asset.id === entry.definition.id);
    const identityFeatures = [
      buildIdentityFeature(entry.definition.id, "canonical-name", entry.definition.name, definitionVersion.id),
      ...(entry.definition.declaredUsage.trim()
        ? [buildIdentityFeature(entry.definition.id, "declared-usage", entry.definition.declaredUsage, definitionVersion.id)]
        : []),
    ].sort(compareById);
    const positiveLocks = (positiveLocksByAsset.get(entry.definition.id) ?? []).sort(compareById);
    const negativeLocks = (negativeLocksByAsset.get(entry.definition.id) ?? []).sort(compareById);
    const currentSupportingAuthorityIds = [...new Set(supportingAuthorityIdsByAsset.get(entry.definition.id) ?? [])]
      .sort((left, right) => left.localeCompare(right, "en"));
    const currentHead = {
      currentDefinitionVersionId: definitionVersion.id,
      currentContractVersionId: contractVersion.id,
      primaryAuthorityId: primaryAuthorityByAsset.get(entry.definition.id),
      currentSupportingAuthorityIds,
      positiveLocks,
      negativeLocks,
    };
    const previousHead = previous && previousAsset ? {
      currentDefinitionVersionId: previousAsset.currentDefinitionVersionId,
      currentContractVersionId: previousAsset.currentContractVersionId,
      primaryAuthorityId: previousAsset.primaryAuthorityId,
      currentSupportingAuthorityIds: supportingAuthorityIdsFor(previous, previousAsset),
      positiveLocks: previousAsset.positiveLocks,
      negativeLocks: previousAsset.negativeLocks,
    } : null;
    const assetRevision = previousAsset
      ? previousAsset.revision + (stableEqual(previousHead, currentHead) ? 0 : 1)
      : 1;
    const payload = {
      id: entry.definition.id,
      projectId: project.id,
      category: entry.definition.category,
      canonicalName: entry.definition.name,
      source: {
        kind: "fusion-production-asset" as const,
        workItemId: entry.workItemId,
        directoryPath: entry.directoryPath,
        infoPath: entry.infoPath,
        outputDirectory: entry.outputDirectory,
      },
      identityFeatures,
      positiveLocks,
      negativeLocks,
      currentDefinitionVersionId: definitionVersion.id,
      currentContractVersionId: contractVersion.id,
      ...(primaryAuthorityByAsset.get(entry.definition.id) ? { primaryAuthorityId: primaryAuthorityByAsset.get(entry.definition.id)! } : {}),
      // 新 store 必须显式写空数组：缺字段仅代表旧 v1 store。若省略，
      // supporting head 被移除后会把历史 Authority 错误兼容成当前 head。
      currentSupportingAuthorityIds,
      revision: assetRevision,
    };
    return { ...payload, fingerprint: digest({ schemaVersion: 1, kind: "canonical-asset", ...payload }) };
  }).sort(compareById);

  const sourceSnapshot: CanonicalAssetSourceSnapshot = {
    algorithm: MIGRATION_ALGORITHM,
    files: inputs.files.map((snapshot) => ({
      role: snapshot.role,
      path: snapshot.path,
      bytes: snapshot.bytes,
      sha256: snapshot.sha256,
      semanticSha256: snapshot.semanticSha256,
    })).sort((left, right) => left.role.localeCompare(right.role, "en")),
    media: [...mediaSnapshotByPath.values()].map((snapshot) => ({
      path: snapshot.path,
      bytes: snapshot.bytes,
      sha256: snapshot.sha256,
    })).sort((left, right) => left.path.localeCompare(right.path, "en")),
  };
  const lineageRelations: CanonicalAssetRelation[] = [];
  if (previous) {
    const previousAuthoritiesById = new Map(previous.authorities.map((authority) => [authority.id, authority]));
    const previousCurrentByLineage = new Map<string, CanonicalAssetAuthority>();
    for (const previousAsset of previous.assets) {
      for (const authorityId of currentAuthorityIdsFor(previous, previousAsset)) {
        const authority = previousAuthoritiesById.get(authorityId);
        if (authority) previousCurrentByLineage.set(authorityLineageKey(authority), authority);
      }
    }
    for (const authority of currentAuthorities) {
      const superseded = previousCurrentByLineage.get(authorityLineageKey(authority));
      if (!superseded || superseded.assetVersionId === authority.assetVersionId) continue;
      lineageRelations.push(buildRelation({
        kind: "supersedes",
        from: { kind: "version", id: authority.assetVersionId },
        to: { kind: "version", id: superseded.assetVersionId },
        evidenceSource: `canonical-asset-remigration:${authorityLineageKey(authority)}`,
      }));
    }
  }
  const relations = mergeAppendOnlyById(previous?.relations ?? [], lineageRelations, "CanonicalAssetRelation");
  const candidateFingerprint = digest({
    schemaVersion: 1,
    algorithm: MIGRATION_ALGORITHM,
    projectId: project.id,
    sourceContentAddress: catalog.sourceContentAddress,
    semanticInputs: sourceSnapshot.files.map(({ role, semanticSha256 }) => ({ role, semanticSha256 })),
    media: sourceSnapshot.media,
    assets,
    aliases,
    definitionVersions,
    contractVersions,
    versions,
    authorities,
    relations,
    migrationAnomalies,
  });
  const pending: Omit<CanonicalAssetStore, "storeFingerprint"> = {
    schemaVersion: 1,
    kind: "canonical-asset-store",
    revision,
    projectId: project.id,
    sourceContentAddress: catalog.sourceContentAddress,
    assets,
    aliases,
    definitionVersions,
    contractVersions,
    versions,
    authorities,
    relations,
    migrationAnomalies,
    sourceSnapshot,
    candidateFingerprint,
    updatedAt: EPOCH,
  };
  return { ...pending, storeFingerprint: fingerprintStore(pending) };
}

function candidateFingerprintFor(store: Pick<CanonicalAssetStore,
  "projectId" | "sourceContentAddress" | "sourceSnapshot" | "assets" | "aliases" | "definitionVersions" | "contractVersions" | "versions" | "authorities" | "relations" | "migrationAnomalies">): string {
  return digest({
    schemaVersion: 1,
    algorithm: MIGRATION_ALGORITHM,
    projectId: store.projectId,
    sourceContentAddress: store.sourceContentAddress,
    semanticInputs: store.sourceSnapshot.files.map(({ role, semanticSha256 }) => ({ role, semanticSha256 })),
    media: store.sourceSnapshot.media,
    assets: store.assets,
    aliases: store.aliases,
    definitionVersions: store.definitionVersions,
    contractVersions: store.contractVersions,
    versions: store.versions,
    authorities: store.authorities,
    relations: store.relations,
    migrationAnomalies: store.migrationAnomalies,
  });
}

function assertCanonicalOrdering<T>(values: readonly T[], sorted: readonly T[], label: string): void {
  if (JSON.stringify(values) !== JSON.stringify(sorted)) throw new Error(`${label} 未按稳定顺序存储。`);
}

function validateCanonicalAssetStore(projectRoot: string, store: CanonicalAssetStore): void {
  if (store.schemaVersion !== 1 || store.kind !== "canonical-asset-store") throw new Error("canonical-assets schema/kind 不受支持。 ");
  if (!Number.isInteger(store.revision) || store.revision < 1) throw new Error("canonical-assets revision 必须是正整数。 ");
  requiredString(store.projectId, "canonical-assets projectId");
  assertContentAddress(store.sourceContentAddress, "canonical-assets sourceContentAddress");
  assertSha256(store.candidateFingerprint, "canonical-assets candidateFingerprint");
  assertSha256(store.storeFingerprint, "canonical-assets storeFingerprint");
  requiredString(store.updatedAt, "canonical-assets updatedAt");
  if (!Array.isArray(store.assets)
    || !Array.isArray(store.aliases)
    || !Array.isArray(store.definitionVersions)
    || !Array.isArray(store.contractVersions)
    || !Array.isArray(store.versions)
    || !Array.isArray(store.authorities)
    || !Array.isArray(store.relations)
    || !Array.isArray(store.migrationAnomalies)
    || !isRecord(store.sourceSnapshot)
    || store.sourceSnapshot.algorithm !== MIGRATION_ALGORITHM
    || !Array.isArray(store.sourceSnapshot.files)
    || !Array.isArray(store.sourceSnapshot.media)) {
    throw new Error("canonical-assets 结构不完整。 ");
  }
  const root = path.resolve(projectRoot);
  const arrays: Array<[readonly { id: string }[], string]> = [
    [store.assets, "CanonicalAsset"],
    [store.aliases, "CanonicalAssetAlias"],
    [store.definitionVersions, "CanonicalAssetDefinitionVersion"],
    [store.contractVersions, "CanonicalAssetContractVersion"],
    [store.versions, "CanonicalAssetVersion"],
    [store.authorities, "CanonicalAssetAuthority"],
    [store.relations, "CanonicalAssetRelation"],
    [store.migrationAnomalies, "migrationAnomaly"],
  ];
  for (const [values, label] of arrays) {
    uniqueById(values, label);
    assertCanonicalOrdering(values, values.slice().sort(compareById), label);
  }
  const assetById = new Map(store.assets.map((asset) => [asset.id, asset]));
  const definitionById = new Map(store.definitionVersions.map((version) => [version.id, version]));
  const contractById = new Map(store.contractVersions.map((version) => [version.id, version]));
  const versionById = new Map(store.versions.map((version) => [version.id, version]));
  const authorityById = new Map(store.authorities.map((authority) => [authority.id, authority]));

  for (const definitionVersion of store.definitionVersions) {
    if (!assetById.has(definitionVersion.assetId)) throw new Error(`definitionVersion 资产悬空：${definitionVersion.id}`);
    if ("generationStatus" in definitionVersion.definition || "hardLockStatus" in definitionVersion.definition) {
      throw new Error(`definitionVersion 不得保存旧生成/硬锁状态：${definitionVersion.id}`);
    }
    const fingerprint = digest({ schemaVersion: 1, kind: "canonical-asset-definition-version", assetId: definitionVersion.assetId, definition: definitionVersion.definition });
    if (fingerprint !== definitionVersion.fingerprint || contentId(`asset-definition-${definitionVersion.assetId}`, fingerprint) !== definitionVersion.id) {
      throw new Error(`definitionVersion 内容指纹不匹配：${definitionVersion.id}`);
    }
  }
  for (const contractVersion of store.contractVersions) {
    if (!assetById.has(contractVersion.assetId)) throw new Error(`contractVersion 资产悬空：${contractVersion.id}`);
    const fingerprint = digest({ schemaVersion: 1, kind: "canonical-asset-contract-version", assetId: contractVersion.assetId, contract: contractVersion.contract });
    if (fingerprint !== contractVersion.fingerprint || contentId(`asset-contract-${contractVersion.assetId}`, fingerprint) !== contractVersion.id) {
      throw new Error(`contractVersion 内容指纹不匹配：${contractVersion.id}`);
    }
  }

  const aliasOwner = new Map<string, string>();
  for (const alias of store.aliases) {
    const asset = assetById.get(alias.assetId);
    if (!asset) throw new Error(`Alias 资产悬空：${alias.id}`);
    if (alias.status !== "confirmed"
      || !(<CanonicalAssetAlias["kind"][]>["formal-id", "formal-name", "formal-name-subject", "explicit-parenthetical-name", "explicit-same-asset-name"]).includes(alias.kind)
      || alias.scope.projectId !== store.projectId || alias.scope.crossProject !== false
      || normalizeAlias(alias.value) !== alias.normalizedValue) {
      throw new Error(`Alias 结构或归一化值无效：${alias.id}`);
    }
    if (alias.source) {
      const definitionVersion = definitionById.get(alias.source.definitionVersionId);
      if (!definitionVersion || definitionVersion.assetId !== alias.assetId
        || !["definition-id", "definition-name", "definition-source-section"].includes(alias.source.kind)
        || !alias.source.evidence.trim()) {
        throw new Error(`Alias 来源证据悬空或无效：${alias.id}`);
      }
    }
    const rebuilt = buildAlias(store.projectId, alias.assetId, alias.kind, alias.value, alias.source);
    if (rebuilt.id !== alias.id || rebuilt.fingerprint !== alias.fingerprint) throw new Error(`Alias 内容指纹不匹配：${alias.id}`);
    const owner = aliasOwner.get(alias.normalizedValue);
    if (owner && owner !== alias.assetId) throw new Error(`Alias 歧义冲突：${alias.normalizedValue}`);
    aliasOwner.set(alias.normalizedValue, alias.assetId);
  }

  const mediaPaths = new Map<string, { sha256: string; versionIds: Set<string> }>();
  for (const version of store.versions) {
    if (!assetById.has(version.assetId)) throw new Error(`AssetVersion 资产悬空：${version.id}`);
    const definition = definitionById.get(version.definitionVersionId);
    const contract = contractById.get(version.contractVersionId);
    if (!definition || definition.assetId !== version.assetId || !contract || contract.assetId !== version.assetId) {
      throw new Error(`AssetVersion definition/contract 版本悬空或错链：${version.id}`);
    }
    if (!Array.isArray(version.media) || version.media.length === 0) throw new Error(`AssetVersion 没有媒体：${version.id}`);
    const roles = version.media.map((media) => media.role).sort();
    if (version.representation === "production-output" && JSON.stringify(roles) !== JSON.stringify(["labeled", "raw"])) {
      throw new Error(`production-output 必须原子保存 raw/labeled：${version.id}`);
    }
    if (version.representation !== "production-output" && JSON.stringify(roles) !== JSON.stringify(["raw"])) {
      throw new Error(`reference version 必须恰好保存一张 raw：${version.id}`);
    }
    for (const media of version.media) {
      assertSha256(media.sha256, `AssetVersion ${version.id} media.sha256`);
      if (!Number.isInteger(media.bytes) || media.bytes < 1 || !path.isAbsolute(media.path) || !sameOrInside(path.resolve(media.path), root)) {
        throw new Error(`AssetVersion 媒体路径/尺寸无效：${version.id} -> ${media.path}`);
      }
      const normalizedPath = path.resolve(media.path);
      const existingMedia = mediaPaths.get(normalizedPath);
      if (existingMedia && existingMedia.sha256 !== media.sha256) {
        throw new Error(`历史 AssetVersion 复用同一媒体路径但 SHA 不同，必须改用 CAS 路径：${media.path}`);
      }
      if (existingMedia) existingMedia.versionIds.add(version.id);
      else mediaPaths.set(normalizedPath, { sha256: media.sha256, versionIds: new Set([version.id]) });
    }
    const { id: _id, fingerprint: _fingerprint, ...input } = version;
    const normalizedInput = normalizeVersionInput(input);
    const rebuilt = buildVersion(input);
    const legacyFingerprint = legacyVersionFingerprint(input);
    const legacyId = contentId(`asset-version-${version.assetId}`, legacyFingerprint);
    const fingerprintMatches = (rebuilt.id === version.id && rebuilt.fingerprint === version.fingerprint)
      || (legacyId === version.id && legacyFingerprint === version.fingerprint);
    if (!fingerprintMatches
      || JSON.stringify(normalizedInput.media) !== JSON.stringify(version.media)
      || JSON.stringify(normalizedInput.reviewIds) !== JSON.stringify(version.reviewIds)) {
      throw new Error(`AssetVersion 内容指纹或媒体顺序不匹配：${version.id}`);
    }
  }

  for (const authority of store.authorities) {
    const asset = assetById.get(authority.assetId);
    const version = versionById.get(authority.assetVersionId);
    if (!asset || !version || version.assetId !== authority.assetId) throw new Error(`Authority 资产或版本悬空：${authority.id}`);
    if (authority.scope.projectId !== store.projectId || authority.scope.crossProject !== false) throw new Error(`Authority scope 无效：${authority.id}`);
    if (authority.kind === "reviewed-hard-lock" && (!authority.reviewId || authority.role !== "production-hard-lock" || authority.exposure !== "allowed")) {
      throw new Error(`reviewed hard lock Authority 证据结构无效：${authority.id}`);
    }
    if (authority.role === "supporting-identity" && (authority.exposure !== "forbidden" || authority.scope.usage !== "human-review-only")) {
      throw new Error(`supporting identity Authority 必须禁止暴露且仅供人工复核：${authority.id}`);
    }
    const { id: _id, fingerprint: _fingerprint, ...input } = authority;
    const rebuilt = buildAuthority(input);
    const legacyFingerprint = digest(legacyAuthorityFingerprintPayload(input));
    const legacyId = contentId(`asset-authority-${authority.assetId}`, legacyFingerprint);
    if (!((rebuilt.id === authority.id && rebuilt.fingerprint === authority.fingerprint)
      || (legacyId === authority.id && legacyFingerprint === authority.fingerprint))) {
      throw new Error(`Authority 内容指纹不匹配：${authority.id}`);
    }
  }

  for (const asset of store.assets) {
    if (asset.projectId !== store.projectId || !["character", "scene", "prop"].includes(asset.category)) throw new Error(`CanonicalAsset project/category 无效：${asset.id}`);
    if (!Number.isInteger(asset.revision) || asset.revision < 1) throw new Error(`CanonicalAsset revision 无效：${asset.id}`);
    const definition = definitionById.get(asset.currentDefinitionVersionId);
    const contract = contractById.get(asset.currentContractVersionId);
    if (!definition || definition.assetId !== asset.id || !contract || contract.assetId !== asset.id) {
      throw new Error(`CanonicalAsset 当前 definition/contract 版本悬空：${asset.id}`);
    }
    if (definition.definition.category !== asset.category || definition.definition.name !== asset.canonicalName) {
      throw new Error(`CanonicalAsset 与当前 definition 内容不一致：${asset.id}`);
    }
    if (asset.primaryAuthorityId) {
      const authority = authorityById.get(asset.primaryAuthorityId);
      if (!authority || authority.assetId !== asset.id || authority.role === "supporting-identity") throw new Error(`CanonicalAsset 主 Authority 悬空：${asset.id}`);
      if (authority.exposure !== "allowed" || authority.scope.usage !== "generation-reference") {
        throw new Error(`CanonicalAsset 当前主 Authority 不允许进入生成投影：${asset.id}`);
      }
    }
    const supportingIds = supportingAuthorityIdsFor(store, asset);
    if (asset.currentSupportingAuthorityIds
      && JSON.stringify(asset.currentSupportingAuthorityIds) !== JSON.stringify(supportingIds)) {
      throw new Error(`CanonicalAsset supporting Authority head 未去重排序：${asset.id}`);
    }
    for (const authorityId of supportingIds) {
      const authority = authorityById.get(authorityId);
      if (!authority || authority.assetId !== asset.id || authority.role !== "supporting-identity"
        || authority.exposure !== "forbidden" || authority.scope.usage !== "human-review-only") {
        throw new Error(`CanonicalAsset 当前 supporting Authority 悬空或暴露策略无效：${asset.id} -> ${authorityId}`);
      }
    }
    const { fingerprint: _fingerprint, ...payload } = asset;
    if (digest({ schemaVersion: 1, kind: "canonical-asset", ...payload }) !== asset.fingerprint) throw new Error(`CanonicalAsset 内容指纹不匹配：${asset.id}`);
  }
  for (const relation of store.relations) {
    if (!(<CanonicalAssetRelation["kind"][]>["derived_from", "variant_of", "reference_of", "supersedes"]).includes(relation.kind)) {
      throw new Error(`CanonicalAssetRelation kind 无效：${relation.id}`);
    }
    const endpointExists = (endpoint: CanonicalAssetRelationEndpoint): boolean => endpoint.kind === "asset" ? assetById.has(endpoint.id) : versionById.has(endpoint.id);
    if (!endpointExists(relation.from) || !endpointExists(relation.to) || (relation.from.kind === relation.to.kind && relation.from.id === relation.to.id)) {
      throw new Error(`CanonicalAssetRelation 端点悬空或自环：${relation.id}`);
    }
    const rebuilt = buildRelation({ kind: relation.kind, from: relation.from, to: relation.to, evidenceSource: relation.evidenceSource });
    if (relation.fingerprint !== rebuilt.fingerprint || relation.id !== rebuilt.id) throw new Error(`CanonicalAssetRelation 指纹不匹配：${relation.id}`);
  }
  for (const anomaly of store.migrationAnomalies) {
    const { id: _id, fingerprint: _fingerprint, ...input } = anomaly;
    const rebuilt = buildAnomaly(input);
    if (rebuilt.id !== anomaly.id || rebuilt.fingerprint !== anomaly.fingerprint) throw new Error(`migrationAnomaly 指纹不匹配：${anomaly.id}`);
    if (anomaly.assetId && !assetById.has(anomaly.assetId)) throw new Error(`migrationAnomaly 资产悬空：${anomaly.id}`);
  }

  const sourceRoles = store.sourceSnapshot.files.map((file) => file.role).sort();
  if (JSON.stringify(sourceRoles) !== JSON.stringify(["index", "materialization", "production-assets", "project", "publications", "reviews"])) {
    throw new Error("sourceSnapshot 必须唯一包含六类迁移输入。 ");
  }
  for (const file of store.sourceSnapshot.files) {
    assertSha256(file.sha256, `sourceSnapshot ${file.role}.sha256`);
    assertSha256(file.semanticSha256, `sourceSnapshot ${file.role}.semanticSha256`);
    if (!Number.isInteger(file.bytes) || file.bytes < 1 || !path.isAbsolute(file.path) || !sameOrInside(path.resolve(file.path), root)) {
      throw new Error(`sourceSnapshot 文件路径/尺寸无效：${file.role}`);
    }
  }
  for (const media of store.sourceSnapshot.media) {
    assertSha256(media.sha256, "sourceSnapshot media.sha256");
    const referenced = mediaPaths.get(path.resolve(media.path));
    if (!Number.isInteger(media.bytes) || media.bytes < 1 || !referenced || referenced.sha256 !== media.sha256) {
      throw new Error(`sourceSnapshot 媒体没有规范版本引用：${media.path}`);
    }
  }
  if (candidateFingerprintFor(store) !== store.candidateFingerprint) throw new Error("canonical-assets candidateFingerprint 与内容不一致。 ");
  const { storeFingerprint: _storeFingerprint, ...pending } = store;
  if (fingerprintStore(pending) !== store.storeFingerprint) throw new Error("canonical-assets storeFingerprint 与内容不一致。 ");
}

async function buildCandidate(projectRoot: string, revision: number, previous: CanonicalAssetStore | null = null): Promise<CandidateBuild> {
  try {
    const inputs = await loadMigrationInputs(projectRoot);
    const store = await assembleCandidateStore(projectRoot, inputs, revision, previous);
    validateCanonicalAssetStore(projectRoot, store);
    return {
      store,
      blockers: [],
      sourceSnapshot: store.sourceSnapshot,
      candidateFingerprint: store.candidateFingerprint,
    };
  } catch (error) {
    const blocker = errorMessage(error);
    return {
      store: null,
      blockers: [blocker],
      candidateFingerprint: digest({ schemaVersion: 1, algorithm: MIGRATION_ALGORITHM, blockers: [blocker] }),
    };
  }
}

export async function loadCanonicalAssetStore(projectRoot: string): Promise<CanonicalAssetStore | null> {
  const filePath = getSidecarPaths(projectRoot).canonicalAssets;
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`canonical-assets 必须是非符号链接普通文件：${filePath}`);
  const root = await canonicalProjectRoot(projectRoot);
  const snapshot = await safeFileSnapshot(root, path.resolve(filePath), "canonical-assets store");
  const value = parseJsonSnapshot(snapshot, "canonical-assets");
  if (!isRecord(value)) throw new Error("canonical-assets 根结构无效。 ");
  const store = value as unknown as CanonicalAssetStore;
  validateCanonicalAssetStore(root.root, store);
  return store;
}

export async function previewCanonicalAssetMigration(projectRoot: string): Promise<CanonicalAssetMigrationPreview> {
  const existing = await loadCanonicalAssetStore(projectRoot);
  const candidate = await buildCandidate(projectRoot, existing?.revision ?? 1, existing);
  const pending = Boolean(candidate.store && (!existing || existing.candidateFingerprint !== candidate.store.candidateFingerprint));
  return {
    schemaVersion: 1,
    kind: "canonical-asset-migration-preview",
    storeRevision: existing?.revision ?? 0,
    candidateFingerprint: candidate.candidateFingerprint,
    ...(candidate.store ? { candidateStoreFingerprint: candidate.store.storeFingerprint, counts: countsFor(candidate.store) } : {}),
    ...(candidate.sourceSnapshot ? { sourceSnapshot: candidate.sourceSnapshot } : {}),
    blockers: candidate.blockers,
    canMigrate: candidate.blockers.length === 0 && pending,
    pending,
  };
}

function rejectMigration(
  message: string,
  reason: string,
  input: { expectedStoreRevision: number; expectedCandidateFingerprint: string },
  preview: CanonicalAssetMigrationPreview,
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

export async function migrateCanonicalAssets(projectRoot: string, input: {
  expectedStoreRevision: number;
  expectedCandidateFingerprint: string;
}): Promise<CanonicalAssetMigrationResult> {
  if (!Number.isInteger(input.expectedStoreRevision) || input.expectedStoreRevision < 0 || !SHA256_PATTERN.test(input.expectedCandidateFingerprint)) {
    throw new RejectedCommandFailure("规范资产迁移必须提供非负 expectedStoreRevision 与小写完整 candidate fingerprint。", {
      schemaVersion: 1,
      applied: false,
      reason: "invalid_precondition",
      expectedRevision: input.expectedStoreRevision,
      expectedCandidateFingerprint: input.expectedCandidateFingerprint,
    });
  }
  return withProjectLock(projectRoot, "canonical-assets", async () => {
    const existing = await loadCanonicalAssetStore(projectRoot);
    const candidate = await buildCandidate(projectRoot, existing?.revision ?? 1, existing);
    const preview: CanonicalAssetMigrationPreview = {
      schemaVersion: 1,
      kind: "canonical-asset-migration-preview",
      storeRevision: existing?.revision ?? 0,
      candidateFingerprint: candidate.candidateFingerprint,
      ...(candidate.store ? { candidateStoreFingerprint: candidate.store.storeFingerprint, counts: countsFor(candidate.store) } : {}),
      ...(candidate.sourceSnapshot ? { sourceSnapshot: candidate.sourceSnapshot } : {}),
      blockers: candidate.blockers,
      canMigrate: Boolean(candidate.store && (!existing || existing.candidateFingerprint !== candidate.store.candidateFingerprint)),
      pending: Boolean(candidate.store && (!existing || existing.candidateFingerprint !== candidate.store.candidateFingerprint)),
    };
    if (preview.candidateFingerprint !== input.expectedCandidateFingerprint) {
      rejectMigration("规范资产迁移候选已漂移，请重新预览。", "candidate_drift", input, preview);
    }
    if (preview.blockers.length || !candidate.store) {
      rejectMigration("规范资产迁移存在不安全输入，已零写入拒绝。", "unsafe_candidates", input, preview);
    }
    if (existing?.candidateFingerprint === candidate.store.candidateFingerprint) {
      return {
        schemaVersion: 1,
        kind: "canonical-asset-migration-result",
        applied: false,
        replayed: true,
        previousRevision: existing.revision,
        storeRevision: existing.revision,
        candidateFingerprint: existing.candidateFingerprint,
        storeFingerprint: existing.storeFingerprint,
        counts: countsFor(existing),
      };
    }
    if ((existing?.revision ?? 0) !== input.expectedStoreRevision) {
      rejectMigration("规范资产 store revision 已变化，请重新预览。", "revision_conflict", input, preview);
    }
    const previousRevision = existing?.revision ?? 0;
    const { storeFingerprint: _candidateStoreFingerprint, ...candidatePending } = candidate.store;
    const nextPending: Omit<CanonicalAssetStore, "storeFingerprint"> = {
      ...candidatePending,
      revision: previousRevision + 1,
      updatedAt: new Date().toISOString(),
    };
    const next: CanonicalAssetStore = { ...nextPending, storeFingerprint: fingerprintStore(nextPending) };
    validateCanonicalAssetStore(projectRoot, next);
    await writeJsonAtomic(getSidecarPaths(projectRoot).canonicalAssets, next);
    return {
      schemaVersion: 1,
      kind: "canonical-asset-migration-result",
      applied: true,
      replayed: false,
      previousRevision,
      storeRevision: next.revision,
      candidateFingerprint: next.candidateFingerprint,
      storeFingerprint: next.storeFingerprint,
      counts: countsFor(next),
    };
  });
}

export async function inspectCanonicalAssetStoreCurrentness(projectRoot: string): Promise<CanonicalAssetStoreCurrentness> {
  const checkedAt = new Date().toISOString();
  let store: CanonicalAssetStore | null;
  try {
    store = await loadCanonicalAssetStore(projectRoot);
  } catch (error) {
    return {
      available: true,
      current: false,
      checkedAt,
      driftedInputs: ["canonical-asset-store"],
      issues: [errorMessage(error)],
    };
  }
  if (!store) {
    return {
      available: false,
      current: false,
      checkedAt,
      driftedInputs: ["canonical-asset-store-missing"],
      issues: ["规范资产库尚未物化。"],
    };
  }
  const candidate = await buildCandidate(projectRoot, store.revision, store);
  const drifted = new Set<string>();
  if (candidate.blockers.length) drifted.add("migration-inputs");
  if (!candidate.store || candidate.candidateFingerprint !== store.candidateFingerprint) drifted.add("candidate-fingerprint");
  if (candidate.store && (candidate.store.projectId !== store.projectId || candidate.store.sourceContentAddress !== store.sourceContentAddress)) {
    drifted.add("project-or-source-content-address");
  }
  return {
    available: true,
    current: drifted.size === 0,
    checkedAt,
    storeRevision: store.revision,
    storeFingerprint: store.storeFingerprint,
    currentCandidateFingerprint: candidate.candidateFingerprint,
    driftedInputs: [...drifted].sort((left, right) => left.localeCompare(right, "en")),
    issues: candidate.blockers,
  };
}

export async function getCanonicalAssetCatalogState(projectRoot: string): Promise<CanonicalAssetCatalogState> {
  const store = await loadCanonicalAssetStore(projectRoot);
  if (!store) return { available: false, current: false, driftedInputs: ["canonical-asset-store-missing"] };
  const currentness = await inspectCanonicalAssetStoreCurrentness(projectRoot);
  return {
    available: true,
    current: currentness.current,
    storeRevision: store.revision,
    storeFingerprint: store.storeFingerprint,
    projectId: store.projectId,
    sourceContentAddress: store.sourceContentAddress,
    updatedAt: store.updatedAt,
    counts: countsFor(store),
    driftedInputs: currentness.driftedInputs,
  };
}

/**
 * 下游生产消费者的唯一权威投影。只要规范 store 已存在，就必须先证明它
 * 与迁移输入仍一致；漂移时失败关闭，绝不静默退回旧 config/路径猜测。
 */
export async function loadCurrentCanonicalAssetAuthorityProjection(
  projectRoot: string,
): Promise<CanonicalAssetAuthorityProjection | null> {
  const store = await loadCanonicalAssetStore(projectRoot);
  if (!store) return null;
  const currentness = await inspectCanonicalAssetStoreCurrentness(projectRoot);
  if (!currentness.current) {
    const reasons = [...currentness.driftedInputs, ...currentness.issues].filter(Boolean).join("；");
    throw new Error(`规范资产库已与当前输入漂移，禁止回退旧权威算法：${reasons || "未知漂移"}`);
  }
  return authorityProjectionFromStore(store);
}

function authorityProjectionFromStore(store: CanonicalAssetStore): CanonicalAssetAuthorityProjection {
  const assets: CanonicalAssetPrimaryAuthoritySnapshot[] = [];
  for (const asset of store.assets) {
    if (!asset.primaryAuthorityId) continue;
    const authority = store.authorities.find((entry) => entry.id === asset.primaryAuthorityId);
    if (!authority || authority.assetId !== asset.id) throw new Error(`规范资产 ${asset.id} 主权威引用悬空。`);
    if (authority.exposure !== "allowed" || authority.scope.usage !== "generation-reference") {
      throw new Error(`规范资产 ${asset.id} 主权威不允许作为生成参考。`);
    }
    const version = store.versions.find((entry) => entry.id === authority.assetVersionId && entry.assetId === asset.id);
    if (!version) throw new Error(`规范资产 ${asset.id} 主权威版本悬空。`);
    const raw = version.media.find((media) => media.role === "raw");
    const labeled = version.media.find((media) => media.role === "labeled");
    if (!raw) throw new Error(`规范资产 ${asset.id} 主权威版本缺少 raw 媒体。`);
    assets.push({
      assetId: asset.id,
      workItemId: asset.source.workItemId,
      category: asset.category,
      canonicalName: asset.canonicalName,
      authorityId: authority.id,
      authority: authority.kind === "user-provided" ? "user-authority" : "reviewed-hard-lock",
      versionId: version.id,
      definitionVersionId: version.definitionVersionId,
      contractVersionId: version.contractVersionId,
      path: raw.path,
      sha256: raw.sha256,
      ...(raw.artifactId ? { artifactId: raw.artifactId } : {}),
      ...(labeled ? { labeledPath: labeled.path, labeledSha256: labeled.sha256 } : {}),
      ...(labeled?.artifactId ? { labeledArtifactId: labeled.artifactId } : {}),
      ...(authority.reviewId ? { reviewId: authority.reviewId } : {}),
    });
  }
  return {
    storeRevision: store.revision,
    storeFingerprint: store.storeFingerprint,
    candidateFingerprint: store.candidateFingerprint,
    assets: assets.sort((left, right) => left.assetId.localeCompare(right.assetId, "en")),
  };
}

/**
 * Scanner 专用的窄恢复入口。仅当上一轮 Scanner 自身写出了“完全相同成员
 * 的重复 Artifact ID”，且去重后的资产语义与已签名 index 精确一致、其余
 * 五类输入和 39 个媒体 SHA 全部未变时，允许使用既有规范权威重建 index。
 * 任何其他漂移仍严格失败关闭。
 */
export async function loadCanonicalAssetAuthorityProjectionForScanner(
  projectRoot: string,
): Promise<CanonicalAssetAuthorityProjection | null> {
  const store = await loadCanonicalAssetStore(projectRoot);
  if (!store) return null;
  const currentness = await inspectCanonicalAssetStoreCurrentness(projectRoot);
  if (currentness.current) return authorityProjectionFromStore(store);
  if (!currentness.issues.length || !currentness.issues.every((issue) => /^catalog Artifact 出现重复 ID：/u.test(issue))) {
    const reasons = [...currentness.driftedInputs, ...currentness.issues].filter(Boolean).join("；");
    throw new Error(`规范资产库已与当前输入漂移，Scanner 禁止恢复：${reasons || "未知漂移"}`);
  }

  const root = await canonicalProjectRoot(projectRoot);
  const indexSource = store.sourceSnapshot.files.find((file) => file.role === "index");
  if (!indexSource) throw new Error("规范资产 store 缺少已签名 index 输入。 ");
  const repairedInputs = await loadMigrationInputs(projectRoot, { deduplicateEquivalentIndexArtifacts: true });
  const workItemIds = new Set(repairedInputs.catalog.assets.map((entry) => entry.workItemId));
  const cachedIndex = loadRecoveryIndexFromSignedCache(root.root, store.projectId);
  const cachedSignedSemanticSha = digest(semanticIndex(cachedIndex, workItemIds));
  if (cachedSignedSemanticSha !== indexSource.semanticSha256) {
    throw new Error("Scanner 恢复缓存不能复现已签名 index 语义，禁止使用既有规范权威。");
  }
  const normalizedCachedSemanticSha = digest(semanticIndex(normalizeIndexReferenceOrder(cachedIndex), workItemIds));
  const normalizedRepairedSemanticSha = digest(semanticIndex(normalizeIndexReferenceOrder(repairedInputs.index), workItemIds));
  if (normalizedCachedSemanticSha !== normalizedRepairedSemanticSha) {
    throw new Error("Scanner 恢复期间 index 存在超出重复成员或引用顺序的语义漂移，禁止使用既有规范权威。");
  }
  for (const source of store.sourceSnapshot.files) {
    if (source.role === "index") continue;
    const current = repairedInputs.files.find((entry) => entry.role === source.role);
    if (!current || current.semanticSha256 !== source.semanticSha256) {
      throw new Error(`Scanner 恢复期间 ${source.role} 语义已漂移，禁止使用既有规范权威。`);
    }
  }
  await Promise.all(store.sourceSnapshot.media.map(async (source) => {
    const current = await safeFileSnapshot(root, source.path, "Scanner 恢复媒体");
    if (current.bytes !== source.bytes || current.sha256 !== source.sha256) {
      throw new Error(`Scanner 恢复媒体 SHA 已漂移：${source.path}`);
    }
  }));

  const currentIndexSnapshot = await safeFileSnapshot(root, indexSource.path, "Scanner 重复 index");
  const rawIndex = parseJsonSnapshot(currentIndexSnapshot, "Scanner 重复 index") as ProjectIndex;
  if (!rawIndex || !Array.isArray(rawIndex.items) || !Array.isArray(rawIndex.artifacts)) throw new Error("Scanner 重复 index 结构无效。 ");
  const artifactsById = new Map<string, Artifact[]>();
  for (const artifact of rawIndex.artifacts) artifactsById.set(artifact.id, [...(artifactsById.get(artifact.id) ?? []), artifact]);
  const duplicated = [...artifactsById.entries()].filter(([, entries]) => entries.length > 1);
  if (!duplicated.length) throw new Error("Scanner 恢复条件声明重复 Artifact，但 index 中没有重复项。 ");
  for (const [artifactId, entries] of duplicated) {
    const fingerprints = new Set(entries.map((entry) => digest({ ...entry, authoritative: undefined })));
    if (fingerprints.size !== 1) throw new Error(`重复 Artifact ${artifactId} 的成员内容不一致，禁止自动去重。`);
  }
  return authorityProjectionFromStore(store);
}

function normalizeListQuery(query: CanonicalAssetListQuery): Required<Pick<CanonicalAssetListQuery, "authority" | "offset" | "limit">> & {
  text: string;
  category: CanonicalAssetCategory | "any";
} {
  const authority = query.authority ?? "any";
  if (!(["any", "with-authority", "without-authority"] as const).includes(authority)) throw new Error(`authority 查询值无效：${authority}`);
  const category = query.category ?? "any";
  if (!(["any", "character", "scene", "prop"] as const).includes(category)) throw new Error(`category 查询值无效：${category}`);
  const offset = Math.max(0, Number.isInteger(query.offset) ? query.offset! : 0);
  const limit = Math.max(1, Math.min(Number.isInteger(query.limit) ? query.limit! : 50, 200));
  return { text: normalizeAlias(query.search ?? query.text ?? ""), category, authority, offset, limit };
}

function assetSummary(store: CanonicalAssetStore, asset: CanonicalAsset): CanonicalAssetSummary {
  const aliases = store.aliases.filter((alias) => alias.assetId === asset.id).sort(compareById);
  const versions = store.versions.filter((version) => version.assetId === asset.id);
  const authorities = store.authorities.filter((authority) => authority.assetId === asset.id);
  const currentAuthorityIds = new Set(currentAuthorityIdsFor(store, asset));
  const currentAuthorities = authorities.filter((authority) => currentAuthorityIds.has(authority.id));
  const primaryAuthority = asset.primaryAuthorityId ? authorities.find((authority) => authority.id === asset.primaryAuthorityId) : undefined;
  const primaryVersion = primaryAuthority ? versions.find((version) => version.id === primaryAuthority.assetVersionId) : undefined;
  const thumbnail = primaryVersion?.media.find((media) => media.role === "raw") ?? primaryVersion?.media[0];
  return {
    id: asset.id,
    category: asset.category,
    canonicalName: asset.canonicalName,
    aliases: structuredClone(aliases),
    ...(asset.primaryAuthorityId ? { primaryAuthorityId: asset.primaryAuthorityId } : {}),
    ...(primaryAuthority ? { primaryVersionId: primaryAuthority.assetVersionId } : {}),
    ...(thumbnail && primaryVersion ? { thumbnail: { path: thumbnail.path, sha256: thumbnail.sha256, role: thumbnail.role, versionId: primaryVersion.id } } : {}),
    hasAuthority: currentAuthorities.length > 0,
    hasPrimaryAuthority: Boolean(primaryAuthority),
    hasSupportingAuthority: currentAuthorities.some((authority) => authority.role === "supporting-identity"),
    versionCount: versions.length,
    authorityCount: authorities.length,
    migrationAnomalies: structuredClone(store.migrationAnomalies.filter((anomaly) => anomaly.assetId === asset.id)),
  };
}

export async function listCanonicalAssets(
  projectRoot: string,
  query: CanonicalAssetListQuery = {},
): Promise<CanonicalAssetPage> {
  const normalized = normalizeListQuery(query);
  const store = await loadCanonicalAssetStore(projectRoot);
  if (!store) {
    return {
      available: false,
      total: 0,
      offset: normalized.offset,
      limit: normalized.limit,
      items: [],
    };
  }
  const currentness = await inspectCanonicalAssetStoreCurrentness(projectRoot);
  if (!currentness.current) {
    const reasons = [...currentness.driftedInputs, ...currentness.issues].filter(Boolean).join("；");
    throw new Error(`规范资产库已与当前输入漂移，禁止读取资产列表：${reasons || "未知漂移"}`);
  }
  const aliasesByAsset = new Map<string, string[]>();
  for (const alias of store.aliases) aliasesByAsset.set(alias.assetId, [...(aliasesByAsset.get(alias.assetId) ?? []), alias.normalizedValue]);
  const authorityAssetIds = new Set(store.assets
    .filter((asset) => currentAuthorityIdsFor(store, asset).length > 0)
    .map((asset) => asset.id));
  const filtered = store.assets
    .filter((asset) => normalized.category === "any" || asset.category === normalized.category)
    .filter((asset) => normalized.authority === "any"
      || (normalized.authority === "with-authority" ? authorityAssetIds.has(asset.id) : !authorityAssetIds.has(asset.id)))
    .filter((asset) => !normalized.text || [normalizeAlias(asset.id), normalizeAlias(asset.canonicalName), ...(aliasesByAsset.get(asset.id) ?? [])]
      .some((value) => value.includes(normalized.text)))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  return {
    available: true,
    storeRevision: store.revision,
    storeFingerprint: store.storeFingerprint,
    queryFingerprint: digest({ schemaVersion: 1, storeFingerprint: store.storeFingerprint, query: normalized }),
    total: filtered.length,
    offset: normalized.offset,
    limit: normalized.limit,
    items: filtered.slice(normalized.offset, normalized.offset + normalized.limit).map((asset) => assetSummary(store, asset)),
  };
}

export async function getCanonicalAsset(projectRoot: string, assetId: string): Promise<CanonicalAssetDetail> {
  const normalizedId = requiredString(assetId, "assetId");
  const store = await loadCanonicalAssetStore(projectRoot);
  if (!store) throw new Error("规范资产库尚未物化，无法读取资产详情。 ");
  const currentness = await inspectCanonicalAssetStoreCurrentness(projectRoot);
  if (!currentness.current) {
    const reasons = [...currentness.driftedInputs, ...currentness.issues].filter(Boolean).join("；");
    throw new Error(`规范资产库已与当前输入漂移，禁止读取资产详情：${reasons || "未知漂移"}`);
  }
  const asset = store.assets.find((candidate) => candidate.id === normalizedId);
  if (!asset) throw new Error(`规范资产不存在：${normalizedId}`);
  const versionIds = new Set(store.versions.filter((version) => version.assetId === asset.id).map((version) => version.id));
  return {
    asset: structuredClone(asset),
    aliases: structuredClone(store.aliases.filter((alias) => alias.assetId === asset.id).sort(compareById)),
    definitionVersions: structuredClone(store.definitionVersions.filter((version) => version.assetId === asset.id).sort(compareById)),
    contractVersions: structuredClone(store.contractVersions.filter((version) => version.assetId === asset.id).sort(compareById)),
    versions: structuredClone(store.versions.filter((version) => version.assetId === asset.id).sort(compareById)),
    authorities: structuredClone(store.authorities.filter((authority) => authority.assetId === asset.id).sort(compareById)),
    relations: structuredClone(store.relations.filter((relation) => (relation.from.kind === "asset" && relation.from.id === asset.id)
      || (relation.to.kind === "asset" && relation.to.id === asset.id)
      || (relation.from.kind === "version" && versionIds.has(relation.from.id))
      || (relation.to.kind === "version" && versionIds.has(relation.to.id))).sort(compareById)),
    migrationAnomalies: structuredClone(store.migrationAnomalies.filter((anomaly) => anomaly.assetId === asset.id).sort(compareById)),
    storeRevision: store.revision,
    storeFingerprint: store.storeFingerprint,
  };
}
