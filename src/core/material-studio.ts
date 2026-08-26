import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, lstatSync } from "node:fs";
import { lstat, realpath, rename } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadSharpDefault } from "./sharp-lazy.js";
import { studioThumbnailDerivationGate } from "./studio-thumbnail-derivation-limit.js";
import {
  ensureConfinedDirectory as ensureSharedConfinedDirectory,
  importConfinedFileToSha256Cas,
  persistConfinedBytesNoReplace,
} from "./confined-project-storage.js";
import { RejectedCommandFailure } from "./command-outcome.js";
import {
  hasStudioRequestSchemaValidation,
  isStudioRequestSqliteValidationUnchanged,
  markStudioRequestSqliteValidationIfUnchanged,
  studioRequestSqliteValidationKey,
} from "./studio-request-schema-cache.js";

const SCHEMA_VERSION = 1;
const DATABASE_RELATIVE_PATH = ".aicanvas/material-studio.sqlite";
const OBJECTS_RELATIVE_ROOT = ".aicanvas/objects/sha256";
const THUMBNAIL_RELATIVE_ROOT = ".aicanvas/derived/thumb";
const THUMBNAIL_RECIPE = "material-studio-thumb:v1:autorotate:inside-512:no-enlarge:webp-q82";
import { STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS, studioSqliteBusyTimeoutMs } from "./studio-sqlite-busy.js";
const BUSY_TIMEOUT_MS = STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MANAGED_PRIVATE_CAS_PATH_PATTERN = /(?:^|[\\/])\.aicanvas[\\/](?:objects[\\/]sha256|studio-production[\\/]objects[\\/]sha256|studio-generation[\\/]objects[\\/]sha256|studio-video-package-source-closure[\\/]objects[\\/]sha256)(?:[\\/]|$)/u;

export type StudioMediaKind = "image" | "video" | "audio";
export type StudioDerivativeStatus = "ready" | "pending";
export type StudioCanonicalAssetCategory = "character" | "scene" | "prop" | "style";
export type StudioReviewStatus = "pending" | "approved" | "rejected";
export type StudioAssetRelationKind = "derived_from" | "variant_of" | "reference_of" | "composite_member";
export type StudioIdentityMatchKind = "id" | "formal-name" | "alias";

export interface StudioIdentityIndexEntry {
  id: string;
  normalizedKey: string;
  assetId: string;
  category: StudioCanonicalAssetCategory;
  canonicalName: string;
  matchKind: StudioIdentityMatchKind;
  matchedValue: string;
}

export interface StudioIdentityIndexQuery {
  /** 精确规范键；不允许 substring、LIKE、拼音或编辑距离。 */
  normalizedKeys?: string[];
  cursor?: string;
  limit?: number;
}

export interface StudioIdentityIndexSnapshot {
  schemaVersion: 1;
  kind: "studio-identity-index-snapshot";
  entries: StudioIdentityIndexEntry[];
  normalizedKeys: string[];
  fingerprint: string;
  nextCursor?: string;
}

/**
 * 适用时间段必须挂在明确的集或 15 秒单元上，避免只存一个无法解释的裸秒数。
 * `startSeconds` 为闭区间起点，`endSeconds` 为开区间终点。
 */
export interface StudioAssetApplicabilityTimeRange {
  scope: "episode" | "unit";
  scopeId: string;
  startSeconds: number;
  endSeconds: number;
  label?: string;
}

/**
 * 空的结构化范围表示当前受管工程全局适用；tags 只用于检索/分类，不参与门禁。
 * 非空的 projects/seasons/episodes/units 采用逐维 AND、维内 OR 的匹配语义。
 */
export interface StudioAssetApplicability {
  projects: string[];
  seasons: string[];
  episodes: string[];
  units: string[];
  timeRanges: StudioAssetApplicabilityTimeRange[];
  tags: string[];
}

export interface StudioAssetApplicabilityInput {
  projects?: string[];
  seasons?: string[];
  episodes?: string[];
  units?: string[];
  timeRanges?: StudioAssetApplicabilityTimeRange[];
  tags?: string[];
}

export interface StudioAssetApplicabilityTarget {
  projectId?: string;
  seasonId?: string;
  episodeId?: string;
  unitId?: string;
  /** 当前 15 秒单元内的闭开区间；仅供 scope=unit 的范围判断。 */
  unitLocalStartSeconds?: number;
  unitLocalEndSeconds?: number;
  /** 当前集内的绝对闭开区间；仅供 scope=episode 的范围判断。 */
  episodeAbsoluteStartSeconds?: number;
  episodeAbsoluteEndSeconds?: number;
}

export interface StudioAssetApplicabilityEvaluation {
  applicable: boolean;
  reasons: string[];
  matchedTimeRange?: StudioAssetApplicabilityTimeRange;
}

export interface StudioAssetRelationEndpointSnapshot {
  assetId: string;
  category: StudioCanonicalAssetCategory;
  assetRevision: number;
  definitionVersionId: string;
  authorityVersionId?: string;
  authorityMediaSha256?: string;
}

/**
 * 关系方向固定：subject 是派生物/变体/引用方/组合成员，object 是来源/母版/被引用资产/组合资产。
 */
export interface StudioAssetRelation {
  id: string;
  /** 同一条逻辑关系的稳定系列 ID；v1 历史以首条关系 id 原位升级。 */
  seriesId: string;
  revision: number;
  supersedesRelationId?: string;
  supersededByRelationId?: string;
  head: boolean;
  status: "current" | "stale" | "superseded";
  kind: StudioAssetRelationKind;
  subject: StudioAssetRelationEndpointSnapshot;
  object: StudioAssetRelationEndpointSnapshot;
  ordinal?: number;
  role: string;
  note: string;
  fingerprint: string;
  createdAt: string;
}

export interface AppendStudioAssetRelationInput {
  id?: string;
  /** 显式提供当前 head 才允许追加同语义的新快照；历史行永不修改或删除。 */
  supersedesRelationId?: string;
  kind: StudioAssetRelationKind;
  subjectAssetId: string;
  objectAssetId: string;
  expectedSubjectRevision: number;
  expectedObjectRevision: number;
  /** composite_member 必填且在同一组合资产内唯一；其他关系禁止提供。 */
  ordinal?: number;
  role?: string;
  note?: string;
}

export interface StudioAssetRelationListQuery {
  assetId?: string;
  subjectAssetId?: string;
  objectAssetId?: string;
  kind?: StudioAssetRelationKind;
  cursor?: string;
  limit?: number;
}

export interface StudioAssetRelationPage {
  items: StudioAssetRelation[];
  nextCursor?: string;
}

export interface StudioAssetRelationEndpointCurrentness {
  snapshot: StudioAssetRelationEndpointSnapshot;
  current: StudioAssetRelationEndpointSnapshot;
  revisionCurrent: boolean;
  definitionCurrent: boolean;
  authorityCurrent: boolean;
  semanticCurrent: boolean;
}

export interface StudioAssetRelationCurrentness {
  relation: StudioAssetRelation;
  head: boolean;
  semanticCurrent: boolean;
  current: boolean;
  subject: StudioAssetRelationEndpointCurrentness;
  object: StudioAssetRelationEndpointCurrentness;
}

export interface StudioCanonicalAssetKnowledgeSnapshot {
  assetId: string;
  category: StudioCanonicalAssetCategory;
  assetRevision: number;
  definitionVersionId: string;
  authorityVersionId?: string;
  authorityMediaSha256?: string;
  applicability: StudioAssetApplicability;
  applicabilityEvaluation?: StudioAssetApplicabilityEvaluation;
  relations: StudioAssetRelationCurrentness[];
  fingerprint: string;
}

export interface MaterialStudioState {
  schemaVersion: 1;
  databasePath: string;
  objectRoot: string;
  thumbnailRoot: string;
  pragmas: {
    journalMode: "wal";
    foreignKeys: true;
    busyTimeoutMs: number;
  };
  counts: {
    media: number;
    mediaImports: number;
    canonicalAssets: number;
    characters: number;
    scenes: number;
    props: number;
    styles: number;
    assetVersions: number;
    assetDefinitions: number;
    primaryAuthorities: number;
    authorityEvents: number;
    versionReviews: number;
    assetRelations: number;
  };
}

export interface MaterialStudioProjectCenterCounts {
  canonicalAssets: number;
  pendingVersions: number;
  primaryAuthorities: number;
}

export interface StudioMediaMetadata {
  sha256: string;
  kind: StudioMediaKind;
  sizeBytes: number;
  mimeType: string;
  sourceBasename: string;
  objectPath: string;
  derivativeStatus: StudioDerivativeStatus;
  thumbnail?: {
    recipe: typeof THUMBNAIL_RECIPE;
    recipeKey: string;
    path: string;
    width: number;
    height: number;
    format: "webp";
  };
  createdAt: string;
}

export interface StudioMediaImportOrigin {
  id: string;
  mediaSha256: string;
  source:
    | { scope: "project"; projectRelativePath: string }
    | { scope: "external"; absolutePath: string };
  sourceBasename: string;
  sourceSizeBytes: number;
  expectedSha256?: string;
  importedAt: string;
}

export interface StudioMediaImportOriginListQuery {
  cursor?: string;
  limit?: number;
}

export interface StudioMediaImportOriginPage {
  items: StudioMediaImportOrigin[];
  nextCursor?: string;
}

export interface ImportStudioMediaInput {
  sourcePath: string;
  kind?: StudioMediaKind;
  expectedSha256?: string;
}

export interface StudioGlobalResourceReuseProvenance {
  id: string;
  sourceProjectId: string;
  sourceProjectName: string;
  sourceManifestFingerprint: string;
  sourceMediaSha256: string;
  targetMediaSha256: string;
  mediaKind: StudioMediaKind;
  sourceMediaSizeBytes: number;
  sourceMimeType: string;
  sourceBasename: string;
  commandRequestHash: string;
  importedAt: string;
}

export interface ImportStudioGlobalResourceMediaInput {
  sourceObjectPath: string;
  kind: StudioMediaKind;
  mimeType: string;
  sourceBasename: string;
  expectedSha256: string;
  expectedSizeBytes: number;
  provenance: {
    sourceProjectId: string;
    sourceProjectName: string;
    sourceManifestFingerprint: string;
    commandRequestHash: string;
  };
}

export interface ImportStudioGlobalResourceMediaResult {
  media: StudioMediaMetadata;
  provenance: StudioGlobalResourceReuseProvenance;
  disposition: "imported" | "already-present";
}

export interface StudioMediaListQuery {
  search?: string;
  kind?: StudioMediaKind;
  cursor?: string;
  limit?: number;
}

export interface StudioMediaPage {
  items: StudioMediaMetadata[];
  nextCursor?: string;
}

export interface StudioCanonicalAssetSummary {
  id: string;
  category: StudioCanonicalAssetCategory;
  name: string;
  description: string;
  aliases: string[];
  applicability: StudioAssetApplicability;
  revision: number;
  versionCount: number;
  primaryAuthority?: {
    versionId: string;
    mediaSha256: string;
    thumbnailRecipeKey?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface StudioAssetVersion {
  id: string;
  assetId: string;
  ordinal: number;
  mediaSha256: string;
  thumbnailRecipeKey?: string;
  reviewStatus: StudioReviewStatus;
  sourceNote: string;
  createdAt: string;
}

export interface StudioCanonicalAssetDetail extends StudioCanonicalAssetSummary {
  versions: StudioAssetVersion[];
  currentDefinitionVersionId: string;
  definitionVersions: StudioAssetDefinitionVersion[];
  identityFeatures: string[];
  positiveLocks: string[];
  negativeLocks: string[];
  defaultPrompt: string;
  authorityHistory: StudioAuthorityEvent[];
  reviewHistory: StudioVersionReview[];
  relations: StudioAssetRelation[];
}

export interface StudioAssetDefinitionVersion {
  id: string;
  assetId: string;
  ordinal: number;
  assetRevision: number;
  category: StudioCanonicalAssetCategory;
  name: string;
  description: string;
  aliases: string[];
  identityFeatures: string[];
  positiveLocks: string[];
  negativeLocks: string[];
  defaultPrompt: string;
  applicability: StudioAssetApplicability;
  createdAt: string;
}

export interface StudioAuthorityEvent {
  id: string;
  assetId: string;
  versionId: string;
  previousVersionId?: string;
  assetRevision: number;
  note: string;
  createdAt: string;
}

export interface StudioVersionReview {
  id: string;
  assetId: string;
  versionId: string;
  fromStatus: StudioReviewStatus;
  toStatus: StudioReviewStatus;
  assetRevision: number;
  note: string;
  createdAt: string;
}

export interface CreateStudioCanonicalAssetInput {
  id?: string;
  category: StudioCanonicalAssetCategory;
  name: string;
  description?: string;
  aliases?: string[];
  identityFeatures?: string[];
  positiveLocks?: string[];
  negativeLocks?: string[];
  defaultPrompt?: string;
  applicability?: StudioAssetApplicabilityInput;
  /** 创建是 revision 0 到 revision 1 的 CAS。 */
  expectedRevision: 0;
}

export interface UpdateStudioCanonicalAssetInput {
  assetId: string;
  expectedRevision: number;
  category?: StudioCanonicalAssetCategory;
  name?: string;
  description?: string;
  /** alias 只追加，不删除；同名 alias 可属于多个资产。 */
  aliases?: string[];
  identityFeatures?: string[];
  positiveLocks?: string[];
  negativeLocks?: string[];
  defaultPrompt?: string;
  applicability?: StudioAssetApplicabilityInput;
}

export interface AppendStudioAssetVersionInput {
  assetId: string;
  mediaSha256: string;
  /** 新版本只能从 pending 开始；批准/驳回必须走独立的不可变审核记录。 */
  reviewStatus: "pending";
  sourceNote?: string;
  expectedRevision: number;
}

export interface AppendStudioAssetVersionResult {
  version: StudioAssetVersion;
  assetRevision: number;
}

export interface SetStudioPrimaryAuthorityInput {
  assetId: string;
  versionId: string;
  expectedRevision: number;
  note?: string;
}

export interface ReviewStudioAssetVersionInput {
  assetId: string;
  versionId: string;
  decision: "approved" | "rejected";
  expectedRevision: number;
  note: string;
}

export interface StudioCanonicalAssetListQuery {
  search?: string;
  category?: StudioCanonicalAssetCategory;
  cursor?: string;
  limit?: number;
}

export interface StudioCanonicalAssetPage {
  items: StudioCanonicalAssetSummary[];
  nextCursor?: string;
}

export class MaterialStudioConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`素材资产修订冲突：期望 ${expectedRevision}，当前 ${actualRevision}。请重新读取后再修改。`);
    this.name = "MaterialStudioConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

interface MediaRow {
  sha256: string;
  kind: StudioMediaKind;
  size_bytes: number;
  mime_type: string;
  source_basename: string;
  object_relpath: string;
  derivative_status: StudioDerivativeStatus;
  thumbnail_recipe_key: string | null;
  thumbnail_relpath: string | null;
  thumbnail_width: number | null;
  thumbnail_height: number | null;
  created_at: string;
}

interface MediaImportRow {
  id: string;
  media_sha256: string;
  source_path: string;
  source_basename: string;
  source_size_bytes: number;
  expected_sha256: string | null;
  imported_at: string;
}

interface GlobalResourceReuseProvenanceRow {
  id: string;
  source_project_id: string;
  source_project_name: string;
  source_manifest_fingerprint: string;
  source_media_sha256: string;
  target_media_sha256: string;
  media_kind: StudioMediaKind;
  source_media_size_bytes: number;
  source_mime_type: string;
  source_basename: string;
  command_request_hash: string;
  imported_at: string;
}

interface AssetRow {
  id: string;
  category: StudioCanonicalAssetCategory;
  name: string;
  description: string;
  applicability_json: string;
  revision: number;
  primary_version_id: string | null;
  primary_media_sha256: string | null;
  primary_thumbnail_recipe_key: string | null;
  version_count: number;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  asset_id: string;
  ordinal: number;
  media_sha256: string;
  thumbnail_recipe_key?: string | null;
  review_status: StudioReviewStatus;
  effective_review_status?: StudioReviewStatus;
  source_note: string;
  created_at: string;
}

interface DefinitionRow {
  id: string;
  asset_id: string;
  ordinal: number;
  asset_revision: number;
  category: StudioCanonicalAssetCategory;
  name: string;
  description: string;
  aliases_json: string;
  identity_features_json: string;
  positive_locks_json: string;
  negative_locks_json: string;
  default_prompt: string;
  applicability_json: string;
  created_at: string;
}

interface AssetRelationRow {
  id: string;
  relation_series_id: string;
  relation_revision: number;
  supersedes_relation_id: string | null;
  superseded_by_relation_id: string | null;
  is_head: number;
  kind: StudioAssetRelationKind;
  subject_asset_id: string;
  object_asset_id: string;
  subject_category: StudioCanonicalAssetCategory;
  object_category: StudioCanonicalAssetCategory;
  subject_asset_revision: number;
  object_asset_revision: number;
  subject_definition_version_id: string;
  object_definition_version_id: string;
  subject_authority_version_id: string | null;
  object_authority_version_id: string | null;
  subject_authority_media_sha256: string | null;
  object_authority_media_sha256: string | null;
  ordinal: number | null;
  role: string;
  note: string;
  fingerprint: string;
  created_at: string;
}

interface AuthorityEventRow {
  id: string;
  asset_id: string;
  version_id: string;
  previous_version_id: string | null;
  asset_revision: number;
  note: string;
  created_at: string;
}

interface VersionReviewRow {
  id: string;
  asset_id: string;
  version_id: string;
  from_status: StudioReviewStatus;
  to_status: "approved" | "rejected";
  asset_revision: number;
  note: string;
  created_at: string;
}

function resolveProjectRoot(projectRoot: string): string {
  if (!projectRoot.trim()) throw new Error("projectRoot 不能为空。");
  return path.resolve(projectRoot);
}

function studioPaths(projectRoot: string) {
  const root = resolveProjectRoot(projectRoot);
  return {
    root,
    sidecar: path.join(root, ".aicanvas"),
    database: path.join(root, DATABASE_RELATIVE_PATH),
    objectRoot: path.join(root, OBJECTS_RELATIVE_ROOT),
    temporaryRoot: path.join(root, OBJECTS_RELATIVE_ROOT, ".tmp"),
    thumbnailRoot: path.join(root, THUMBNAIL_RELATIVE_ROOT),
  };
}

/**
 * 受管素材私有目录逐级建立并复验：任何一级是符号链接、非目录或 realpath
 * 逃出工程根都立即失败。Node 没有跨平台 openat，这里同时在每个写入点前复验，
 * 把可持久构造的恶意工程树完全拒绝，并缩短并发换链窗口。
 */
async function ensureConfinedDirectory(projectRoot: string, targetDirectory: string): Promise<void> {
  await ensureSharedConfinedDirectory(path.resolve(projectRoot), path.resolve(targetDirectory));
}

function relativeToProject(projectRoot: string, absolutePath: string): string {
  const relative = path.relative(projectRoot, absolutePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("素材存储路径逃逸工程目录。");
  }
  return relative.split(path.sep).join("/");
}

function fromProjectRelative(projectRoot: string, relativePath: string): string {
  const absolute = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("素材索引包含越界路径。");
  }
  return absolute;
}

async function ensureStudioDirectories(projectRoot: string): Promise<ReturnType<typeof studioPaths>> {
  const paths = studioPaths(projectRoot);
  await ensureConfinedDirectory(paths.root, paths.sidecar);
  await ensureConfinedDirectory(paths.root, paths.objectRoot);
  await ensureConfinedDirectory(paths.root, paths.temporaryRoot);
  await ensureConfinedDirectory(paths.root, paths.thumbnailRoot);
  return paths;
}

function createStudioCanonicalAssetsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE studio_canonical_assets (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK(category IN ('character', 'scene', 'prop', 'style')),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      applicability_json TEXT NOT NULL DEFAULT '{"projects":[],"seasons":[],"episodes":[],"units":[],"timeRanges":[],"tags":[]}',
      revision INTEGER NOT NULL CHECK(revision >= 1),
      primary_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(primary_version_id) REFERENCES studio_asset_versions(id)
    ) STRICT;
  `);
}

function createStudioIdentityKeysTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE studio_asset_identity_keys (
      id TEXT PRIMARY KEY CHECK(length(id) = 64),
      normalized_key TEXT NOT NULL CHECK(length(normalized_key) > 0),
      asset_id TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('character', 'scene', 'prop', 'style')),
      canonical_name TEXT NOT NULL,
      match_kind TEXT NOT NULL CHECK(match_kind IN ('id', 'formal-name', 'alias')),
      matched_value TEXT NOT NULL,
      UNIQUE(asset_id, match_kind, normalized_key),
      FOREIGN KEY(asset_id) REFERENCES studio_canonical_assets(id) ON DELETE CASCADE
    ) STRICT;
  `);
}

function createStudioAssetDefinitionsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE studio_asset_definitions (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
      asset_revision INTEGER NOT NULL CHECK(asset_revision >= 1),
      category TEXT NOT NULL CHECK(category IN ('character', 'scene', 'prop', 'style')),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      aliases_json TEXT NOT NULL,
      identity_features_json TEXT NOT NULL,
      positive_locks_json TEXT NOT NULL,
      negative_locks_json TEXT NOT NULL,
      default_prompt TEXT NOT NULL DEFAULT '',
      applicability_json TEXT NOT NULL DEFAULT '{"projects":[],"seasons":[],"episodes":[],"units":[],"timeRanges":[],"tags":[]}',
      created_at TEXT NOT NULL,
      UNIQUE(asset_id, ordinal),
      FOREIGN KEY(asset_id) REFERENCES studio_canonical_assets(id) ON DELETE RESTRICT
    ) STRICT;
  `);
}

function createAssetRelationV2Table(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE studio_asset_relations (
      id TEXT PRIMARY KEY,
      relation_series_id TEXT NOT NULL,
      relation_revision INTEGER NOT NULL CHECK(relation_revision >= 1),
      supersedes_relation_id TEXT UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('derived_from', 'variant_of', 'reference_of', 'composite_member')),
      subject_asset_id TEXT NOT NULL,
      object_asset_id TEXT NOT NULL,
      subject_category TEXT NOT NULL CHECK(subject_category IN ('character', 'scene', 'prop', 'style')),
      object_category TEXT NOT NULL CHECK(object_category IN ('character', 'scene', 'prop', 'style')),
      subject_asset_revision INTEGER NOT NULL CHECK(subject_asset_revision >= 1),
      object_asset_revision INTEGER NOT NULL CHECK(object_asset_revision >= 1),
      subject_definition_version_id TEXT NOT NULL,
      object_definition_version_id TEXT NOT NULL,
      subject_authority_version_id TEXT,
      object_authority_version_id TEXT,
      subject_authority_media_sha256 TEXT CHECK(subject_authority_media_sha256 IS NULL OR length(subject_authority_media_sha256) = 64),
      object_authority_media_sha256 TEXT CHECK(object_authority_media_sha256 IS NULL OR length(object_authority_media_sha256) = 64),
      ordinal INTEGER CHECK(ordinal IS NULL OR ordinal >= 1),
      role TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE(relation_series_id, relation_revision),
      CHECK(subject_asset_id <> object_asset_id),
      CHECK(
        (relation_revision = 1 AND supersedes_relation_id IS NULL AND relation_series_id = id)
        OR (relation_revision > 1 AND supersedes_relation_id IS NOT NULL)
      ),
      CHECK((kind = 'composite_member' AND ordinal IS NOT NULL) OR (kind <> 'composite_member' AND ordinal IS NULL)),
      CHECK((subject_authority_version_id IS NULL) = (subject_authority_media_sha256 IS NULL)),
      CHECK((object_authority_version_id IS NULL) = (object_authority_media_sha256 IS NULL)),
      FOREIGN KEY(subject_asset_id) REFERENCES studio_canonical_assets(id) ON DELETE RESTRICT,
      FOREIGN KEY(object_asset_id) REFERENCES studio_canonical_assets(id) ON DELETE RESTRICT,
      FOREIGN KEY(subject_definition_version_id) REFERENCES studio_asset_definitions(id) ON DELETE RESTRICT,
      FOREIGN KEY(object_definition_version_id) REFERENCES studio_asset_definitions(id) ON DELETE RESTRICT,
      FOREIGN KEY(subject_authority_version_id) REFERENCES studio_asset_versions(id) ON DELETE RESTRICT,
      FOREIGN KEY(object_authority_version_id) REFERENCES studio_asset_versions(id) ON DELETE RESTRICT,
      FOREIGN KEY(subject_authority_media_sha256) REFERENCES studio_media(sha256) ON DELETE RESTRICT,
      FOREIGN KEY(object_authority_media_sha256) REFERENCES studio_media(sha256) ON DELETE RESTRICT,
      FOREIGN KEY(supersedes_relation_id) REFERENCES studio_asset_relations(id) ON DELETE RESTRICT
    ) STRICT;
  `);
}

function createAssetRelationV2Auxiliary(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_asset_relation_heads (
      relation_id TEXT PRIMARY KEY,
      subject_asset_id TEXT NOT NULL,
      object_asset_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('derived_from', 'variant_of', 'reference_of', 'composite_member')),
      ordinal INTEGER,
      UNIQUE(subject_asset_id, object_asset_id),
      CHECK((kind = 'composite_member' AND ordinal IS NOT NULL) OR (kind <> 'composite_member' AND ordinal IS NULL)),
      FOREIGN KEY(relation_id) REFERENCES studio_asset_relations(id) ON DELETE RESTRICT,
      FOREIGN KEY(subject_asset_id) REFERENCES studio_canonical_assets(id) ON DELETE RESTRICT,
      FOREIGN KEY(object_asset_id) REFERENCES studio_canonical_assets(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS studio_relation_subject_idx ON studio_asset_relations(subject_asset_id, id);
    CREATE INDEX IF NOT EXISTS studio_relation_object_idx ON studio_asset_relations(object_asset_id, id);
    CREATE INDEX IF NOT EXISTS studio_relation_kind_idx ON studio_asset_relations(kind, id);
    CREATE INDEX IF NOT EXISTS studio_relation_series_revision_idx ON studio_asset_relations(relation_series_id, relation_revision);
    CREATE INDEX IF NOT EXISTS studio_relation_supersedes_idx ON studio_asset_relations(supersedes_relation_id);
    CREATE UNIQUE INDEX IF NOT EXISTS studio_relation_head_endpoint_pair_idx
      ON studio_asset_relation_heads(subject_asset_id, object_asset_id);
    CREATE UNIQUE INDEX IF NOT EXISTS studio_relation_head_composite_ordinal_idx
      ON studio_asset_relation_heads(object_asset_id, ordinal)
      WHERE kind = 'composite_member';

    CREATE TRIGGER IF NOT EXISTS studio_asset_relations_no_update
    BEFORE UPDATE ON studio_asset_relations
    BEGIN
      SELECT RAISE(ABORT, 'studio_asset_relations is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS studio_asset_relations_no_delete
    BEFORE DELETE ON studio_asset_relations
    BEGIN
      SELECT RAISE(ABORT, 'studio_asset_relations is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS studio_asset_relation_lineage_guard
    BEFORE INSERT ON studio_asset_relations
    BEGIN
      SELECT CASE
        WHEN NEW.relation_revision = 1 AND EXISTS(
          SELECT 1 FROM studio_asset_relation_heads
          WHERE subject_asset_id = NEW.subject_asset_id AND object_asset_id = NEW.object_asset_id
        ) THEN RAISE(ABORT, 'asset relation current head already exists')
        WHEN NEW.relation_revision > 1 AND NOT EXISTS(
          SELECT 1
          FROM studio_asset_relations predecessor
          JOIN studio_asset_relation_heads head ON head.relation_id = predecessor.id
          WHERE predecessor.id = NEW.supersedes_relation_id
            AND predecessor.relation_series_id = NEW.relation_series_id
            AND predecessor.relation_revision + 1 = NEW.relation_revision
            AND predecessor.kind = NEW.kind
            AND predecessor.subject_asset_id = NEW.subject_asset_id
            AND predecessor.object_asset_id = NEW.object_asset_id
            AND predecessor.ordinal IS NEW.ordinal
            AND predecessor.role = NEW.role
            AND predecessor.note = NEW.note
        ) THEN RAISE(ABORT, 'asset relation supersede lineage or semantic mismatch')
      END;
    END;

    CREATE TRIGGER IF NOT EXISTS studio_asset_relation_heads_guard_insert
    BEFORE INSERT ON studio_asset_relation_heads
    BEGIN
      SELECT CASE WHEN NOT EXISTS(
        SELECT 1 FROM studio_asset_relations relation
        WHERE relation.id = NEW.relation_id
          AND relation.subject_asset_id = NEW.subject_asset_id
          AND relation.object_asset_id = NEW.object_asset_id
          AND relation.kind = NEW.kind
          AND relation.ordinal IS NEW.ordinal
          AND NOT EXISTS(SELECT 1 FROM studio_asset_relations child WHERE child.supersedes_relation_id = relation.id)
      ) THEN RAISE(ABORT, 'asset relation head projection mismatch') END;
    END;

    CREATE TRIGGER IF NOT EXISTS studio_asset_relation_heads_guard_update
    BEFORE UPDATE ON studio_asset_relation_heads
    BEGIN
      SELECT CASE WHEN NOT EXISTS(
        SELECT 1 FROM studio_asset_relations relation
        WHERE relation.id = NEW.relation_id
          AND relation.subject_asset_id = NEW.subject_asset_id
          AND relation.object_asset_id = NEW.object_asset_id
          AND relation.kind = NEW.kind
          AND relation.ordinal IS NEW.ordinal
          AND NOT EXISTS(SELECT 1 FROM studio_asset_relations child WHERE child.supersedes_relation_id = relation.id)
      ) THEN RAISE(ABORT, 'asset relation head projection mismatch') END;
    END;

    CREATE TRIGGER IF NOT EXISTS studio_asset_relation_heads_no_delete
    BEFORE DELETE ON studio_asset_relation_heads
    BEGIN
      SELECT RAISE(ABORT, 'studio_asset_relation_heads cannot be deleted');
    END;
  `);
}

/**
 * v1 的 endpoint UNIQUE 让过期关系无法恢复。这里在同一数据库事务内复制为 v2 历史链，
 * v1 行的 id、语义、端点快照、指纹和创建时间保持不变；可变的 head 只是一张严格投影表。
 */
function ensureAssetRelationSchemaV2(db: DatabaseSync): void {
  // P27（core 审查 F1）：版本判定必须在事务内重读——双进程首开同一旧库时，
  // 事务外读取会让后到者按过期 isV2=false 把已迁移的 v2 新表 RENAME 成 backup 并压平关系历史。
  db.exec("BEGIN IMMEDIATE");
  try {
    const capability = db.prepare("SELECT value FROM studio_meta WHERE key = 'asset_scope_relation_schema'").get() as { value?: string } | undefined;
    if (capability?.value !== undefined && capability.value !== "1" && capability.value !== "2") {
      throw new Error(`不支持的资产适用范围/关系 schema：${capability.value}。`);
    }
    const columns = db.prepare("PRAGMA table_info(studio_asset_relations)").all() as Array<{ name?: string }>;
    const isV2 = columns.some((column) => column.name === "relation_series_id")
      && columns.some((column) => column.name === "supersedes_relation_id");
    if (capability?.value === "2" && !isV2) {
      throw new Error("资产关系 capability 标记为 v2，但历史表仍是 v1；拒绝猜测性修复。");
    }
    if (!isV2) {
      db.exec(`
        DROP TRIGGER IF EXISTS studio_asset_relations_no_update;
        DROP TRIGGER IF EXISTS studio_asset_relations_no_delete;
        DROP INDEX IF EXISTS studio_relation_subject_idx;
        DROP INDEX IF EXISTS studio_relation_object_idx;
        DROP INDEX IF EXISTS studio_relation_kind_idx;
        DROP INDEX IF EXISTS studio_relation_endpoint_pair_idx;
        DROP INDEX IF EXISTS studio_composite_member_ordinal_idx;
        ALTER TABLE studio_asset_relations RENAME TO studio_asset_relations_v1_backup;
      `);
      createAssetRelationV2Table(db);
      db.exec(`
        INSERT INTO studio_asset_relations(
          id, relation_series_id, relation_revision, supersedes_relation_id,
          kind, subject_asset_id, object_asset_id, subject_category, object_category,
          subject_asset_revision, object_asset_revision,
          subject_definition_version_id, object_definition_version_id,
          subject_authority_version_id, object_authority_version_id,
          subject_authority_media_sha256, object_authority_media_sha256,
          ordinal, role, note, fingerprint, created_at
        )
        SELECT
          id, id, 1, NULL,
          kind, subject_asset_id, object_asset_id, subject_category, object_category,
          subject_asset_revision, object_asset_revision,
          subject_definition_version_id, object_definition_version_id,
          subject_authority_version_id, object_authority_version_id,
          subject_authority_media_sha256, object_authority_media_sha256,
          ordinal, role, note, fingerprint, created_at
        FROM studio_asset_relations_v1_backup;
        DROP TABLE studio_asset_relations_v1_backup;
      `);
    }
    createAssetRelationV2Auxiliary(db);
    db.exec(`
      INSERT OR IGNORE INTO studio_asset_relation_heads(relation_id, subject_asset_id, object_asset_id, kind, ordinal)
      SELECT relation.id, relation.subject_asset_id, relation.object_asset_id, relation.kind, relation.ordinal
      FROM studio_asset_relations relation
      WHERE NOT EXISTS(
        SELECT 1 FROM studio_asset_relations child WHERE child.supersedes_relation_id = relation.id
      );
    `);
    const invalidHead = db.prepare(`
      SELECT head.relation_id
      FROM studio_asset_relation_heads head
      LEFT JOIN studio_asset_relations relation ON relation.id = head.relation_id
      WHERE relation.id IS NULL
        OR relation.subject_asset_id <> head.subject_asset_id
        OR relation.object_asset_id <> head.object_asset_id
        OR relation.kind <> head.kind
        OR relation.ordinal IS NOT head.ordinal
        OR EXISTS(SELECT 1 FROM studio_asset_relations child WHERE child.supersedes_relation_id = head.relation_id)
      LIMIT 1
    `).get() as { relation_id?: string } | undefined;
    if (invalidHead) throw new Error(`资产关系 current head 投影损坏：${invalidHead.relation_id ?? "unknown"}`);
    const missingHead = db.prepare(`
      SELECT relation.id
      FROM studio_asset_relations relation
      WHERE NOT EXISTS(SELECT 1 FROM studio_asset_relations child WHERE child.supersedes_relation_id = relation.id)
        AND NOT EXISTS(SELECT 1 FROM studio_asset_relation_heads head WHERE head.relation_id = relation.id)
      LIMIT 1
    `).get() as { id?: string } | undefined;
    if (missingHead) throw new Error(`资产关系 current head 缺失或冲突：${missingHead.id ?? "unknown"}`);
    db.prepare(`
      INSERT INTO studio_meta(key, value) VALUES('asset_scope_relation_schema', '2')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function tableAllowsStyleCategory(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql?: string } | undefined;
  return typeof row?.sql === "string" && row.sql.includes("'style'");
}

/**
 * 素材类别 v2 把风格参考提升为与角色、场景、道具同级的规范资产。
 *
 * SQLite 不能原位修改 CHECK；旧库必须在单一写事务中重建四张类别快照表。
 * `legacy_alter_table=ON + foreign_keys=OFF` 仅覆盖本连接的迁移窗口，避免
 * RENAME 把其他历史表的外键永久改写到 backup 表名。提交前强制跑
 * foreign_key_check / integrity_check，任一异常都整体回滚。
 */
function ensureStudioAssetCategorySchemaV2(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN IMMEDIATE");
  try {
    const capability = db.prepare("SELECT value FROM studio_meta WHERE key = 'asset_category_schema'")
      .get() as { value?: string } | undefined;
    if (capability?.value !== undefined && capability.value !== "1" && capability.value !== "2") {
      throw new Error(`不支持的素材类别 schema：${capability.value}。`);
    }
    const support = {
      assets: tableAllowsStyleCategory(db, "studio_canonical_assets"),
      identities: tableAllowsStyleCategory(db, "studio_asset_identity_keys"),
      definitions: tableAllowsStyleCategory(db, "studio_asset_definitions"),
      relations: tableAllowsStyleCategory(db, "studio_asset_relations"),
    };
    const complete = Object.values(support).every(Boolean);
    if (capability?.value === "2" && !complete) {
      throw new Error("素材类别 capability 标记为 v2，但数据库 CHECK 尚未完整支持 style；拒绝猜测性修复。");
    }

    if (!complete) {
      if (!support.assets) {
        db.exec(`
          DROP INDEX IF EXISTS studio_asset_category_id_idx;
          DROP INDEX IF EXISTS studio_asset_name_idx;
          ALTER TABLE studio_canonical_assets RENAME TO studio_canonical_assets_category_v1_backup;
        `);
        createStudioCanonicalAssetsTable(db);
        db.exec(`
          INSERT INTO studio_canonical_assets(
            id, category, name, description, applicability_json, revision,
            primary_version_id, created_at, updated_at
          )
          SELECT
            id, category, name, description, applicability_json, revision,
            primary_version_id, created_at, updated_at
          FROM studio_canonical_assets_category_v1_backup;
        `);
      }
      if (!support.identities) {
        db.exec(`
          DROP INDEX IF EXISTS studio_identity_normalized_rank_asset_idx;
          DROP INDEX IF EXISTS studio_identity_asset_idx;
          ALTER TABLE studio_asset_identity_keys RENAME TO studio_asset_identity_keys_category_v1_backup;
        `);
        createStudioIdentityKeysTable(db);
        db.exec(`
          INSERT INTO studio_asset_identity_keys(
            id, normalized_key, asset_id, category, canonical_name, match_kind, matched_value
          )
          SELECT id, normalized_key, asset_id, category, canonical_name, match_kind, matched_value
          FROM studio_asset_identity_keys_category_v1_backup;
        `);
      }
      if (!support.definitions) {
        db.exec(`
          DROP TRIGGER IF EXISTS studio_asset_definitions_no_update;
          DROP TRIGGER IF EXISTS studio_asset_definitions_no_delete;
          DROP INDEX IF EXISTS studio_definition_asset_idx;
          ALTER TABLE studio_asset_definitions RENAME TO studio_asset_definitions_category_v1_backup;
        `);
        createStudioAssetDefinitionsTable(db);
        db.exec(`
          INSERT INTO studio_asset_definitions(
            id, asset_id, ordinal, asset_revision, category, name, description,
            aliases_json, identity_features_json, positive_locks_json, negative_locks_json,
            default_prompt, applicability_json, created_at
          )
          SELECT
            id, asset_id, ordinal, asset_revision, category, name, description,
            aliases_json, identity_features_json, positive_locks_json, negative_locks_json,
            default_prompt, applicability_json, created_at
          FROM studio_asset_definitions_category_v1_backup;
        `);
      }
      if (!support.relations) {
        db.exec(`
          DROP TRIGGER IF EXISTS studio_asset_relations_no_update;
          DROP TRIGGER IF EXISTS studio_asset_relations_no_delete;
          DROP TRIGGER IF EXISTS studio_asset_relation_lineage_guard;
          DROP INDEX IF EXISTS studio_relation_subject_idx;
          DROP INDEX IF EXISTS studio_relation_object_idx;
          DROP INDEX IF EXISTS studio_relation_kind_idx;
          DROP INDEX IF EXISTS studio_relation_series_revision_idx;
          DROP INDEX IF EXISTS studio_relation_supersedes_idx;
          ALTER TABLE studio_asset_relations RENAME TO studio_asset_relations_category_v1_backup;
        `);
        createAssetRelationV2Table(db);
        db.exec(`
          INSERT INTO studio_asset_relations(
            id, relation_series_id, relation_revision, supersedes_relation_id,
            kind, subject_asset_id, object_asset_id, subject_category, object_category,
            subject_asset_revision, object_asset_revision,
            subject_definition_version_id, object_definition_version_id,
            subject_authority_version_id, object_authority_version_id,
            subject_authority_media_sha256, object_authority_media_sha256,
            ordinal, role, note, fingerprint, created_at
          )
          SELECT
            id, relation_series_id, relation_revision, supersedes_relation_id,
            kind, subject_asset_id, object_asset_id, subject_category, object_category,
            subject_asset_revision, object_asset_revision,
            subject_definition_version_id, object_definition_version_id,
            subject_authority_version_id, object_authority_version_id,
            subject_authority_media_sha256, object_authority_media_sha256,
            ordinal, role, note, fingerprint, created_at
          FROM studio_asset_relations_category_v1_backup;
        `);
      }

      db.exec(`
        DROP TABLE IF EXISTS studio_asset_relations_category_v1_backup;
        DROP TABLE IF EXISTS studio_asset_identity_keys_category_v1_backup;
        DROP TABLE IF EXISTS studio_asset_definitions_category_v1_backup;
        DROP TABLE IF EXISTS studio_canonical_assets_category_v1_backup;

        CREATE INDEX IF NOT EXISTS studio_asset_category_id_idx ON studio_canonical_assets(category, id);
        CREATE INDEX IF NOT EXISTS studio_asset_name_idx ON studio_canonical_assets(name, id);
        CREATE INDEX IF NOT EXISTS studio_identity_normalized_rank_asset_idx
          ON studio_asset_identity_keys(normalized_key, match_kind, asset_id);
        CREATE INDEX IF NOT EXISTS studio_identity_asset_idx
          ON studio_asset_identity_keys(asset_id, id);
        CREATE INDEX IF NOT EXISTS studio_definition_asset_idx
          ON studio_asset_definitions(asset_id, ordinal);

        CREATE TRIGGER IF NOT EXISTS studio_asset_definitions_no_update
        BEFORE UPDATE ON studio_asset_definitions
        BEGIN
          SELECT RAISE(ABORT, 'studio_asset_definitions is append-only; append a definition snapshot instead');
        END;

        CREATE TRIGGER IF NOT EXISTS studio_asset_definitions_no_delete
        BEFORE DELETE ON studio_asset_definitions
        BEGIN
          SELECT RAISE(ABORT, 'studio_asset_definitions is append-only');
        END;
      `);
      createAssetRelationV2Auxiliary(db);
    }

    const foreignKeyFailures = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyFailures.length > 0) {
      throw new Error(`素材类别 v2 迁移后存在 ${foreignKeyFailures.length} 条外键异常。`);
    }
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`素材类别 v2 迁移后完整性检查失败：${integrity?.integrity_check ?? "unknown"}`);
    }
    db.prepare(`
      INSERT INTO studio_meta(key, value) VALUES('asset_category_schema', '2')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON");
  }
}

export function normalizeStudioIdentityKey(value: string): string {
  if (typeof value !== "string") throw new Error("身份键必须是字符串。");
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("zh-CN");
  if (!normalized || normalized.length > 1_000 || /\p{Cc}/u.test(normalized)) {
    throw new Error("身份键为空、过长或包含控制字符。");
  }
  return normalized;
}

function studioIdentityEntryId(input: {
  assetId: string;
  matchKind: StudioIdentityMatchKind;
  normalizedKey: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([input.assetId, input.matchKind, input.normalizedKey]), "utf8")
    .digest("hex");
}

function syncStudioIdentityIndexForAsset(db: DatabaseSync, assetId: string): void {
  const asset = db.prepare("SELECT id, category, name FROM studio_canonical_assets WHERE id = ?")
    .get(assetId) as { id: string; category: StudioCanonicalAssetCategory; name: string } | undefined;
  db.prepare("DELETE FROM studio_asset_identity_keys WHERE asset_id = ?").run(assetId);
  if (!asset) return;
  const aliases = db.prepare("SELECT alias FROM studio_asset_aliases WHERE asset_id = ? ORDER BY normalized_alias, alias")
    .all(assetId) as Array<{ alias: string }>;
  const values: Array<{ matchKind: StudioIdentityMatchKind; matchedValue: string }> = [
    { matchKind: "id", matchedValue: asset.id },
    { matchKind: "formal-name", matchedValue: asset.name },
    ...aliases.map((row) => ({ matchKind: "alias" as const, matchedValue: row.alias })),
  ];
  const insert = db.prepare(`
    INSERT INTO studio_asset_identity_keys(
      id, normalized_key, asset_id, category, canonical_name, match_kind, matched_value
    ) VALUES(?, ?, ?, ?, ?, ?, ?)
  `);
  const seen = new Set<string>();
  for (const value of values) {
    const normalizedKey = normalizeStudioIdentityKey(value.matchedValue);
    const uniquenessKey = `${value.matchKind}\0${normalizedKey}`;
    if (seen.has(uniquenessKey)) continue;
    seen.add(uniquenessKey);
    insert.run(
      studioIdentityEntryId({ assetId: asset.id, matchKind: value.matchKind, normalizedKey }),
      normalizedKey,
      asset.id,
      asset.category,
      asset.name,
      value.matchKind,
      value.matchedValue,
    );
  }
}

function ensureStudioIdentityIndexV1(db: DatabaseSync): void {
  const stored = db.prepare("SELECT value FROM studio_meta WHERE key = 'identity_index_schema'")
    .get() as { value?: string } | undefined;
  const expectedCount = Number((db.prepare(`
    SELECT COUNT(*) * 2 + (SELECT COUNT(*) FROM studio_asset_aliases) AS count
    FROM studio_canonical_assets
  `).get() as { count: number }).count);
  const actualCount = Number((db.prepare("SELECT COUNT(*) AS count FROM studio_asset_identity_keys").get() as { count: number }).count);
  if (stored?.value === "1" && actualCount === expectedCount) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM studio_asset_identity_keys");
    const assets = db.prepare("SELECT id FROM studio_canonical_assets ORDER BY id").all() as Array<{ id: string }>;
    for (const asset of assets) syncStudioIdentityIndexForAsset(db, asset.id);
    db.prepare(`
      INSERT INTO studio_meta(key, value) VALUES('identity_index_schema', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function globalResourceReuseSchemaReady(db: DatabaseSync): boolean {
  const marker = db.prepare("SELECT value FROM studio_meta WHERE key = 'global_resource_reuse_schema'")
    .get() as { value?: string } | undefined;
  if (marker?.value !== "1") return false;
  const rows = db.prepare(`
    SELECT type, name
    FROM sqlite_master
    WHERE (type = 'table' AND name = 'studio_global_resource_reuse_provenance')
       OR (type = 'trigger' AND name IN (
         'studio_global_resource_reuse_provenance_no_update',
         'studio_global_resource_reuse_provenance_no_delete'
       ))
  `).all() as Array<{ type: string; name: string }>;
  return rows.length === 3;
}

function ensureGlobalResourceReuseSchemaV1(db: DatabaseSync): void {
  const stored = db.prepare("SELECT value FROM studio_meta WHERE key = 'global_resource_reuse_schema'")
    .get() as { value?: string } | undefined;
  if (stored?.value !== undefined && stored.value !== "1") {
    throw new Error(`不支持的总资源复用来源 schema：${stored.value}。`);
  }
  if (globalResourceReuseSchemaReady(db)) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS studio_global_resource_reuse_provenance (
        id TEXT PRIMARY KEY,
        source_project_id TEXT NOT NULL CHECK(length(source_project_id) > 0),
        source_project_name TEXT NOT NULL CHECK(length(source_project_name) > 0),
        source_manifest_fingerprint TEXT NOT NULL CHECK(length(source_manifest_fingerprint) = 64),
        source_media_sha256 TEXT NOT NULL CHECK(length(source_media_sha256) = 64),
        target_media_sha256 TEXT NOT NULL CHECK(length(target_media_sha256) = 64),
        media_kind TEXT NOT NULL CHECK(media_kind IN ('audio', 'video')),
        source_media_size_bytes INTEGER NOT NULL CHECK(source_media_size_bytes > 0),
        source_mime_type TEXT NOT NULL CHECK(length(source_mime_type) > 0),
        source_basename TEXT NOT NULL CHECK(length(source_basename) > 0),
        command_request_hash TEXT NOT NULL CHECK(length(command_request_hash) = 64),
        imported_at TEXT NOT NULL,
        UNIQUE(
          source_project_id,
          source_manifest_fingerprint,
          source_media_sha256,
          target_media_sha256,
          media_kind
        ),
        FOREIGN KEY(target_media_sha256) REFERENCES studio_media(sha256) ON DELETE RESTRICT
      ) STRICT;

      CREATE TRIGGER IF NOT EXISTS studio_global_resource_reuse_provenance_no_update
      BEFORE UPDATE ON studio_global_resource_reuse_provenance
      BEGIN
        SELECT RAISE(ABORT, 'studio_global_resource_reuse_provenance is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS studio_global_resource_reuse_provenance_no_delete
      BEFORE DELETE ON studio_global_resource_reuse_provenance
      BEGIN
        SELECT RAISE(ABORT, 'studio_global_resource_reuse_provenance is append-only');
      END;

      INSERT OR IGNORE INTO studio_meta(key, value)
      VALUES('global_resource_reuse_schema', '1');
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (!globalResourceReuseSchemaReady(db)) {
    throw new Error("总资源复用来源 schema 未完整建立。");
  }
}

function globalImageResourceReuseSchemaReady(db: DatabaseSync): boolean {
  const marker = db.prepare(
    "SELECT value FROM studio_meta WHERE key = 'global_image_resource_reuse_schema'",
  ).get() as { value?: string } | undefined;
  if (marker?.value !== "1") return false;
  const rows = db.prepare(`
    SELECT type, name
    FROM sqlite_master
    WHERE (type = 'table' AND name = 'studio_global_image_resource_reuse_provenance')
       OR (type = 'trigger' AND name IN (
         'studio_global_image_resource_reuse_provenance_no_update',
         'studio_global_image_resource_reuse_provenance_no_delete'
       ))
  `).all() as Array<{ type: string; name: string }>;
  return rows.length === 3;
}

/**
 * 图片复用使用独立的增量 schema，避免重建已经落盘且仅允许 audio/video 的
 * v1 provenance 表。表只在目标工程首次实际调用图片资源时建立。
 */
function ensureGlobalImageResourceReuseSchemaV1(db: DatabaseSync): void {
  const stored = db.prepare(
    "SELECT value FROM studio_meta WHERE key = 'global_image_resource_reuse_schema'",
  ).get() as { value?: string } | undefined;
  if (stored?.value !== undefined && stored.value !== "1") {
    throw new Error(`不支持的总图片资源复用来源 schema：${stored.value}。`);
  }
  if (globalImageResourceReuseSchemaReady(db)) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS studio_global_image_resource_reuse_provenance (
        id TEXT PRIMARY KEY,
        source_project_id TEXT NOT NULL CHECK(length(source_project_id) > 0),
        source_project_name TEXT NOT NULL CHECK(length(source_project_name) > 0),
        source_manifest_fingerprint TEXT NOT NULL CHECK(length(source_manifest_fingerprint) = 64),
        source_media_sha256 TEXT NOT NULL CHECK(length(source_media_sha256) = 64),
        target_media_sha256 TEXT NOT NULL CHECK(length(target_media_sha256) = 64),
        media_kind TEXT NOT NULL CHECK(media_kind = 'image'),
        source_media_size_bytes INTEGER NOT NULL CHECK(source_media_size_bytes > 0),
        source_mime_type TEXT NOT NULL CHECK(length(source_mime_type) > 0),
        source_basename TEXT NOT NULL CHECK(length(source_basename) > 0),
        command_request_hash TEXT NOT NULL CHECK(length(command_request_hash) = 64),
        imported_at TEXT NOT NULL,
        UNIQUE(
          source_project_id,
          source_manifest_fingerprint,
          source_media_sha256,
          target_media_sha256,
          media_kind
        ),
        FOREIGN KEY(target_media_sha256) REFERENCES studio_media(sha256) ON DELETE RESTRICT
      ) STRICT;

      CREATE TRIGGER IF NOT EXISTS studio_global_image_resource_reuse_provenance_no_update
      BEFORE UPDATE ON studio_global_image_resource_reuse_provenance
      BEGIN
        SELECT RAISE(ABORT, 'studio_global_image_resource_reuse_provenance is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS studio_global_image_resource_reuse_provenance_no_delete
      BEFORE DELETE ON studio_global_image_resource_reuse_provenance
      BEGIN
        SELECT RAISE(ABORT, 'studio_global_image_resource_reuse_provenance is append-only');
      END;

      INSERT OR IGNORE INTO studio_meta(key, value)
      VALUES('global_image_resource_reuse_schema', '1');
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (!globalImageResourceReuseSchemaReady(db)) {
    throw new Error("总图片资源复用来源 schema 未完整建立。");
  }
}

function openDatabase(databasePath: string): DatabaseSync {
  // P28：未来 schema 必须在任何写式 PRAGMA/DDL 前只读拒绝；旧程序不得先改库再报不支持。
  if (existsSync(databasePath)) {
    const metadata = lstatSync(databasePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("素材库数据库必须是无符号链接的普通文件。");
    const probe = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const hasMeta = probe.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'studio_meta' LIMIT 1").get();
      if (hasMeta) {
        const version = probe.prepare("SELECT value FROM studio_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
        if (version?.value !== undefined && version.value !== String(SCHEMA_VERSION)) {
          throw new Error(`不支持的素材库 schema_version：${version.value}。`);
        }
        const categoryVersion = probe.prepare("SELECT value FROM studio_meta WHERE key = 'asset_category_schema'")
          .get() as { value?: string } | undefined;
        if (categoryVersion?.value !== undefined && categoryVersion.value !== "1" && categoryVersion.value !== "2") {
          throw new Error(`不支持的素材类别 schema：${categoryVersion.value}。`);
        }
        const globalReuseVersion = probe.prepare("SELECT value FROM studio_meta WHERE key = 'global_resource_reuse_schema'")
          .get() as { value?: string } | undefined;
        if (globalReuseVersion?.value !== undefined && globalReuseVersion.value !== "1") {
          throw new Error(`不支持的总资源复用来源 schema：${globalReuseVersion.value}。`);
        }
        const globalImageReuseVersion = probe.prepare(
          "SELECT value FROM studio_meta WHERE key = 'global_image_resource_reuse_schema'",
        ).get() as { value?: string } | undefined;
        if (globalImageReuseVersion?.value !== undefined && globalImageReuseVersion.value !== "1") {
          throw new Error(`不支持的总图片资源复用来源 schema：${globalImageReuseVersion.value}。`);
        }
      }
    } finally {
      probe.close();
    }
  }
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(BUSY_TIMEOUT_MS);
  const db = new DatabaseSync(databasePath, { timeout: busyTimeoutMs });
  db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;`);
  const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
  if (journal?.journal_mode?.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode=WAL");
  const requestSchemaKey = studioRequestSqliteValidationKey("material-studio-schema-v1", databasePath);
  if (hasStudioRequestSchemaValidation(requestSchemaKey)) {
    const version = db.prepare("SELECT value FROM studio_meta WHERE key = 'schema_version'")
      .get() as { value?: string } | undefined;
    const relationVersion = db.prepare("SELECT value FROM studio_meta WHERE key = 'asset_scope_relation_schema'")
      .get() as { value?: string } | undefined;
    const categoryVersion = db.prepare("SELECT value FROM studio_meta WHERE key = 'asset_category_schema'")
      .get() as { value?: string } | undefined;
    const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
    if (version?.value !== String(SCHEMA_VERSION)
      || relationVersion?.value !== "2"
      || categoryVersion?.value !== "2"
      || foreignKeys?.foreign_keys !== 1) {
      db.close();
      throw new Error("素材库 schema marker 或 foreign_keys 已漂移，拒绝继续。");
    }
    if (!isStudioRequestSqliteValidationUnchanged(
      requestSchemaKey,
      "material-studio-schema-v1",
      databasePath,
    )) {
      db.close();
      throw new Error("素材库在 schema cache-hit 复核期间发生 SQLite 身份漂移。");
    }
    return db;
  }
  // N-2（复查）：建表 DDL 失败时关库，防 fd 泄漏。
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS studio_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_media (
      sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64),
      kind TEXT NOT NULL CHECK(kind IN ('image', 'video', 'audio')),
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
      mime_type TEXT NOT NULL,
      source_basename TEXT NOT NULL,
      object_relpath TEXT NOT NULL UNIQUE,
      derivative_status TEXT NOT NULL CHECK(derivative_status IN ('ready', 'pending')),
      thumbnail_recipe_key TEXT,
      thumbnail_relpath TEXT,
      thumbnail_width INTEGER,
      thumbnail_height INTEGER,
      created_at TEXT NOT NULL,
      CHECK(
        (kind = 'image' AND derivative_status = 'ready' AND thumbnail_recipe_key IS NOT NULL AND thumbnail_relpath IS NOT NULL AND thumbnail_width IS NOT NULL AND thumbnail_height IS NOT NULL)
        OR (kind IN ('video', 'audio') AND derivative_status = 'pending' AND thumbnail_recipe_key IS NULL AND thumbnail_relpath IS NULL AND thumbnail_width IS NULL AND thumbnail_height IS NULL)
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_media_derivatives (
      recipe_key TEXT PRIMARY KEY CHECK(length(recipe_key) = 64),
      media_sha256 TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('video_poster', 'video_proxy', 'audio_waveform')),
      status TEXT NOT NULL CHECK(status IN ('ready', 'blocked', 'failed')),
      recipe TEXT NOT NULL,
      output_sha256 TEXT CHECK(output_sha256 IS NULL OR length(output_sha256) = 64),
      size_bytes INTEGER CHECK(size_bytes IS NULL OR size_bytes >= 0),
      mime_type TEXT,
      relative_path TEXT UNIQUE,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(media_sha256, kind),
      FOREIGN KEY(media_sha256) REFERENCES studio_media(sha256) ON DELETE RESTRICT,
      CHECK(
        (status = 'ready' AND output_sha256 IS NOT NULL AND size_bytes IS NOT NULL AND mime_type IS NOT NULL AND relative_path IS NOT NULL AND error_code IS NULL)
        OR (status IN ('blocked', 'failed') AND output_sha256 IS NULL AND size_bytes IS NULL AND mime_type IS NULL AND relative_path IS NULL AND error_code IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_media_imports (
      id TEXT PRIMARY KEY,
      media_sha256 TEXT NOT NULL,
      source_path TEXT NOT NULL CHECK(length(source_path) > 0),
      source_basename TEXT NOT NULL CHECK(length(source_basename) > 0),
      source_size_bytes INTEGER NOT NULL CHECK(source_size_bytes >= 0),
      expected_sha256 TEXT CHECK(expected_sha256 IS NULL OR length(expected_sha256) = 64),
      imported_at TEXT NOT NULL,
      FOREIGN KEY(media_sha256) REFERENCES studio_media(sha256) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_canonical_assets (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK(category IN ('character', 'scene', 'prop', 'style')),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      applicability_json TEXT NOT NULL DEFAULT '{"projects":[],"seasons":[],"episodes":[],"units":[],"timeRanges":[],"tags":[]}',
      revision INTEGER NOT NULL CHECK(revision >= 1),
      primary_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(primary_version_id) REFERENCES studio_asset_versions(id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_aliases (
      asset_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(asset_id, normalized_alias),
      FOREIGN KEY(asset_id) REFERENCES studio_canonical_assets(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_identity_keys (
      id TEXT PRIMARY KEY CHECK(length(id) = 64),
      normalized_key TEXT NOT NULL CHECK(length(normalized_key) > 0),
      asset_id TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('character', 'scene', 'prop', 'style')),
      canonical_name TEXT NOT NULL,
      match_kind TEXT NOT NULL CHECK(match_kind IN ('id', 'formal-name', 'alias')),
      matched_value TEXT NOT NULL,
      UNIQUE(asset_id, match_kind, normalized_key),
      FOREIGN KEY(asset_id) REFERENCES studio_canonical_assets(id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_versions (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
      media_sha256 TEXT NOT NULL,
      review_status TEXT NOT NULL CHECK(review_status IN ('pending', 'approved', 'rejected')),
      source_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(asset_id, ordinal),
      FOREIGN KEY(asset_id) REFERENCES studio_canonical_assets(id) ON DELETE RESTRICT,
      FOREIGN KEY(media_sha256) REFERENCES studio_media(sha256) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_definitions (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
      asset_revision INTEGER NOT NULL CHECK(asset_revision >= 1),
      category TEXT NOT NULL CHECK(category IN ('character', 'scene', 'prop', 'style')),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      aliases_json TEXT NOT NULL,
      identity_features_json TEXT NOT NULL,
      positive_locks_json TEXT NOT NULL,
      negative_locks_json TEXT NOT NULL,
      default_prompt TEXT NOT NULL DEFAULT '',
      applicability_json TEXT NOT NULL DEFAULT '{"projects":[],"seasons":[],"episodes":[],"units":[],"timeRanges":[],"tags":[]}',
      created_at TEXT NOT NULL,
      UNIQUE(asset_id, ordinal),
      FOREIGN KEY(asset_id) REFERENCES studio_canonical_assets(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_authority_events (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      previous_version_id TEXT,
      asset_revision INTEGER NOT NULL CHECK(asset_revision >= 1),
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY(asset_id) REFERENCES studio_canonical_assets(id) ON DELETE RESTRICT,
      FOREIGN KEY(version_id) REFERENCES studio_asset_versions(id) ON DELETE RESTRICT,
      FOREIGN KEY(previous_version_id) REFERENCES studio_asset_versions(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_version_reviews (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      from_status TEXT NOT NULL CHECK(from_status IN ('pending', 'approved', 'rejected')),
      to_status TEXT NOT NULL CHECK(to_status IN ('approved', 'rejected')),
      asset_revision INTEGER NOT NULL CHECK(asset_revision >= 1),
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(asset_id) REFERENCES studio_canonical_assets(id) ON DELETE RESTRICT,
      FOREIGN KEY(version_id) REFERENCES studio_asset_versions(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_relations (
      id TEXT PRIMARY KEY,
      relation_series_id TEXT NOT NULL,
      relation_revision INTEGER NOT NULL CHECK(relation_revision >= 1),
      supersedes_relation_id TEXT UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('derived_from', 'variant_of', 'reference_of', 'composite_member')),
      subject_asset_id TEXT NOT NULL,
      object_asset_id TEXT NOT NULL,
      subject_category TEXT NOT NULL CHECK(subject_category IN ('character', 'scene', 'prop', 'style')),
      object_category TEXT NOT NULL CHECK(object_category IN ('character', 'scene', 'prop', 'style')),
      subject_asset_revision INTEGER NOT NULL CHECK(subject_asset_revision >= 1),
      object_asset_revision INTEGER NOT NULL CHECK(object_asset_revision >= 1),
      subject_definition_version_id TEXT NOT NULL,
      object_definition_version_id TEXT NOT NULL,
      subject_authority_version_id TEXT,
      object_authority_version_id TEXT,
      subject_authority_media_sha256 TEXT CHECK(subject_authority_media_sha256 IS NULL OR length(subject_authority_media_sha256) = 64),
      object_authority_media_sha256 TEXT CHECK(object_authority_media_sha256 IS NULL OR length(object_authority_media_sha256) = 64),
      ordinal INTEGER CHECK(ordinal IS NULL OR ordinal >= 1),
      role TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE(relation_series_id, relation_revision),
      CHECK(subject_asset_id <> object_asset_id),
      CHECK(
        (relation_revision = 1 AND supersedes_relation_id IS NULL AND relation_series_id = id)
        OR (relation_revision > 1 AND supersedes_relation_id IS NOT NULL)
      ),
      CHECK((kind = 'composite_member' AND ordinal IS NOT NULL) OR (kind <> 'composite_member' AND ordinal IS NULL)),
      CHECK((subject_authority_version_id IS NULL) = (subject_authority_media_sha256 IS NULL)),
      CHECK((object_authority_version_id IS NULL) = (object_authority_media_sha256 IS NULL)),
      FOREIGN KEY(subject_asset_id) REFERENCES studio_canonical_assets(id) ON DELETE RESTRICT,
      FOREIGN KEY(object_asset_id) REFERENCES studio_canonical_assets(id) ON DELETE RESTRICT,
      FOREIGN KEY(subject_definition_version_id) REFERENCES studio_asset_definitions(id) ON DELETE RESTRICT,
      FOREIGN KEY(object_definition_version_id) REFERENCES studio_asset_definitions(id) ON DELETE RESTRICT,
      FOREIGN KEY(subject_authority_version_id) REFERENCES studio_asset_versions(id) ON DELETE RESTRICT,
      FOREIGN KEY(object_authority_version_id) REFERENCES studio_asset_versions(id) ON DELETE RESTRICT,
      FOREIGN KEY(subject_authority_media_sha256) REFERENCES studio_media(sha256) ON DELETE RESTRICT,
      FOREIGN KEY(object_authority_media_sha256) REFERENCES studio_media(sha256) ON DELETE RESTRICT,
      FOREIGN KEY(supersedes_relation_id) REFERENCES studio_asset_relations(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS studio_media_kind_sha_idx ON studio_media(kind, sha256);
    CREATE INDEX IF NOT EXISTS studio_media_import_media_time_idx ON studio_media_imports(media_sha256, imported_at, id);
    CREATE INDEX IF NOT EXISTS studio_derivative_media_kind_idx ON studio_media_derivatives(media_sha256, kind);
    CREATE INDEX IF NOT EXISTS studio_asset_category_id_idx ON studio_canonical_assets(category, id);
    CREATE INDEX IF NOT EXISTS studio_asset_name_idx ON studio_canonical_assets(name, id);
    CREATE INDEX IF NOT EXISTS studio_alias_normalized_idx ON studio_asset_aliases(normalized_alias, asset_id);
    CREATE INDEX IF NOT EXISTS studio_identity_normalized_rank_asset_idx
      ON studio_asset_identity_keys(normalized_key, match_kind, asset_id);
    CREATE INDEX IF NOT EXISTS studio_identity_asset_idx
      ON studio_asset_identity_keys(asset_id, id);
    CREATE INDEX IF NOT EXISTS studio_version_asset_idx ON studio_asset_versions(asset_id, ordinal);
    CREATE INDEX IF NOT EXISTS studio_definition_asset_idx ON studio_asset_definitions(asset_id, ordinal);
    CREATE INDEX IF NOT EXISTS studio_authority_asset_idx ON studio_authority_events(asset_id, asset_revision);
    CREATE INDEX IF NOT EXISTS studio_review_asset_idx ON studio_version_reviews(asset_id, asset_revision);
    CREATE UNIQUE INDEX IF NOT EXISTS studio_review_version_once_idx ON studio_version_reviews(version_id);

    CREATE TRIGGER IF NOT EXISTS studio_version_reviews_no_update
    BEFORE UPDATE ON studio_version_reviews
    BEGIN
      SELECT RAISE(ABORT, 'studio_version_reviews is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS studio_version_reviews_no_delete
    BEFORE DELETE ON studio_version_reviews
    BEGIN
      SELECT RAISE(ABORT, 'studio_version_reviews is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS studio_asset_versions_no_update
    BEFORE UPDATE ON studio_asset_versions
    BEGIN
      SELECT RAISE(ABORT, 'studio_asset_versions is append-only; append a review receipt instead');
    END;

    CREATE TRIGGER IF NOT EXISTS studio_asset_versions_no_delete
    BEFORE DELETE ON studio_asset_versions
    BEGIN
      SELECT RAISE(ABORT, 'studio_asset_versions is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS studio_asset_definitions_no_update
    BEFORE UPDATE ON studio_asset_definitions
    BEGIN
      SELECT RAISE(ABORT, 'studio_asset_definitions is append-only; append a definition snapshot instead');
    END;

    CREATE TRIGGER IF NOT EXISTS studio_asset_definitions_no_delete
    BEFORE DELETE ON studio_asset_definitions
    BEGIN
      SELECT RAISE(ABORT, 'studio_asset_definitions is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS studio_asset_aliases_no_update
    BEFORE UPDATE ON studio_asset_aliases
    BEGIN
      SELECT RAISE(ABORT, 'studio_asset_aliases is append-only; append a new alias instead');
    END;

    CREATE TRIGGER IF NOT EXISTS studio_asset_aliases_no_delete
    BEFORE DELETE ON studio_asset_aliases
    BEGIN
      SELECT RAISE(ABORT, 'studio_asset_aliases is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS studio_authority_events_no_update
    BEFORE UPDATE ON studio_authority_events
    BEGIN
      SELECT RAISE(ABORT, 'studio_authority_events is append-only; append a new authority event instead');
    END;

    CREATE TRIGGER IF NOT EXISTS studio_authority_events_no_delete
    BEFORE DELETE ON studio_authority_events
    BEGIN
      SELECT RAISE(ABORT, 'studio_authority_events is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS studio_media_identity_no_update
    BEFORE UPDATE OF sha256, kind, size_bytes, mime_type, source_basename, object_relpath, created_at ON studio_media
    BEGIN
      SELECT RAISE(ABORT, 'studio_media content identity and source metadata are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS studio_media_no_delete
    BEFORE DELETE ON studio_media
    BEGIN
      SELECT RAISE(ABORT, 'studio_media content records are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS studio_media_imports_no_update
    BEFORE UPDATE ON studio_media_imports
    BEGIN
      SELECT RAISE(ABORT, 'studio_media_imports is append-only; append a new import origin instead');
    END;

    CREATE TRIGGER IF NOT EXISTS studio_media_imports_no_delete
    BEFORE DELETE ON studio_media_imports
    BEGIN
      SELECT RAISE(ABORT, 'studio_media_imports is append-only');
    END;

  `);
  } catch (error) {
    db.close();
    throw error;
  }
  // P27（core 审查 F1 同类）：ADD COLUMN 迁移包事务（防双进程并发 duplicate column）。
  db.exec("BEGIN IMMEDIATE");
  try {
    const versionColumns = db.prepare("PRAGMA table_info(studio_asset_versions)").all() as Array<{ name?: string }>;
    if (!versionColumns.some((column) => column.name === "source_note")) {
      db.exec("ALTER TABLE studio_asset_versions ADD COLUMN source_note TEXT NOT NULL DEFAULT ''");
    }
    const assetColumns = db.prepare("PRAGMA table_info(studio_canonical_assets)").all() as Array<{ name?: string }>;
    if (!assetColumns.some((column) => column.name === "applicability_json")) {
      db.exec(`ALTER TABLE studio_canonical_assets ADD COLUMN applicability_json TEXT NOT NULL DEFAULT '{"projects":[],"seasons":[],"episodes":[],"units":[],"timeRanges":[],"tags":[]}'`);
    }
    const definitionColumns = db.prepare("PRAGMA table_info(studio_asset_definitions)").all() as Array<{ name?: string }>;
    if (!definitionColumns.some((column) => column.name === "applicability_json")) {
      db.exec(`ALTER TABLE studio_asset_definitions ADD COLUMN applicability_json TEXT NOT NULL DEFAULT '{"projects":[],"seasons":[],"episodes":[],"units":[],"timeRanges":[],"tags":[]}'`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  db.prepare("INSERT OR IGNORE INTO studio_meta(key, value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
  // F-13（盲审）：ensure 迁移抛错时关闭句柄，防 fd 泄漏。
  try {
    ensureAssetRelationSchemaV2(db);
    ensureStudioAssetCategorySchemaV2(db);
    ensureStudioIdentityIndexV1(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const stableValidationKey = studioRequestSqliteValidationKey("material-studio-schema-v1", databasePath);
  // 自身迁移写入已经结束；在稳定窗口内重新跑完整 owner ensure，只有这个窗口
  // 前后 SQLite 身份一致才允许缓存。
  try {
    ensureAssetRelationSchemaV2(db);
    ensureStudioAssetCategorySchemaV2(db);
    ensureStudioIdentityIndexV1(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const version = db.prepare("SELECT value FROM studio_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
  if (version?.value !== String(SCHEMA_VERSION)) {
    db.close();
    throw new Error(`不支持的素材库 schema_version：${version?.value ?? "缺失"}。`);
  }
  const assetScopeRelationVersion = db.prepare("SELECT value FROM studio_meta WHERE key = 'asset_scope_relation_schema'").get() as { value?: string } | undefined;
  if (assetScopeRelationVersion?.value !== "2") {
    db.close();
    throw new Error(`不支持的资产适用范围/关系 schema：${assetScopeRelationVersion?.value ?? "缺失"}。`);
  }
  const assetCategoryVersion = db.prepare("SELECT value FROM studio_meta WHERE key = 'asset_category_schema'").get() as { value?: string } | undefined;
  if (assetCategoryVersion?.value !== "2") {
    db.close();
    throw new Error(`不支持的素材类别 schema：${assetCategoryVersion?.value ?? "缺失"}。`);
  }
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
  if (foreignKeys?.foreign_keys !== 1) {
    db.close();
    throw new Error("素材库 foreign_keys 未启用，拒绝继续。");
  }
  if (!markStudioRequestSqliteValidationIfUnchanged(
    stableValidationKey,
    "material-studio-schema-v1",
    databasePath,
  )) {
    db.close();
    throw new Error("素材库在 schema 验证期间发生 SQLite 身份漂移，拒绝缓存验证结论。");
  }
  return db;
}

function runTransaction<T>(db: DatabaseSync, callback: () => T): T {
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

function getStateFromDatabase(projectRoot: string, db: DatabaseSync): MaterialStudioState {
  const paths = studioPaths(projectRoot);
  const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  const busyTimeout = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  if (journal.journal_mode.toLowerCase() !== "wal" || foreignKeys.foreign_keys !== 1) {
    throw new Error("素材库 SQLite 安全配置无效。");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    databasePath: paths.database,
    objectRoot: paths.objectRoot,
    thumbnailRoot: paths.thumbnailRoot,
    pragmas: {
      journalMode: "wal",
      foreignKeys: true,
      busyTimeoutMs: Number(busyTimeout.timeout),
    },
    counts: {
      media: count(db, "SELECT COUNT(*) AS count FROM studio_media"),
      mediaImports: count(db, "SELECT COUNT(*) AS count FROM studio_media_imports"),
      canonicalAssets: count(db, "SELECT COUNT(*) AS count FROM studio_canonical_assets"),
      characters: count(db, "SELECT COUNT(*) AS count FROM studio_canonical_assets WHERE category = 'character'"),
      scenes: count(db, "SELECT COUNT(*) AS count FROM studio_canonical_assets WHERE category = 'scene'"),
      props: count(db, "SELECT COUNT(*) AS count FROM studio_canonical_assets WHERE category = 'prop'"),
      styles: count(db, "SELECT COUNT(*) AS count FROM studio_canonical_assets WHERE category = 'style'"),
      assetVersions: count(db, "SELECT COUNT(*) AS count FROM studio_asset_versions"),
      assetDefinitions: count(db, "SELECT COUNT(*) AS count FROM studio_asset_definitions"),
      primaryAuthorities: count(db, "SELECT COUNT(*) AS count FROM studio_canonical_assets WHERE primary_version_id IS NOT NULL"),
      authorityEvents: count(db, "SELECT COUNT(*) AS count FROM studio_authority_events"),
      versionReviews: count(db, "SELECT COUNT(*) AS count FROM studio_version_reviews"),
      assetRelations: count(db, "SELECT COUNT(*) AS count FROM studio_asset_relations"),
    },
  };
}

export async function initializeMaterialStudio(projectRoot: string): Promise<MaterialStudioState> {
  const paths = await ensureStudioDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    return getStateFromDatabase(paths.root, db);
  } finally {
    db.close();
  }
}

export async function getMaterialStudioState(projectRoot: string): Promise<MaterialStudioState> {
  return initializeMaterialStudio(projectRoot);
}

/**
 * Project Center 只读轻投影：不建库、不迁移、不补索引，只读取已经存在的事务事实。
 * 这样普通项目列表可以展示真实 pending/authority 数量，而不会把“看一眼项目”
 * 变成隐式写操作。
 */
export async function readMaterialStudioProjectCenterCounts(
  projectRoot: string,
): Promise<MaterialStudioProjectCenterCounts | null> {
  const databasePath = studioPaths(projectRoot).database;
  if (!existsSync(databasePath)) return null;
  const metadata = lstatSync(databasePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("素材库数据库必须是无符号链接的普通文件。");
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    const tables = new Set((db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('studio_canonical_assets', 'studio_asset_versions')
    `).all() as Array<{ name: string }>).map((row) => row.name));
    if (!tables.has("studio_canonical_assets") || !tables.has("studio_asset_versions")) return null;
    return {
      canonicalAssets: count(db, "SELECT COUNT(*) AS count FROM studio_canonical_assets"),
      pendingVersions: count(db, "SELECT COUNT(*) AS count FROM studio_asset_versions WHERE review_status = 'pending'"),
      primaryAuthorities: count(db, "SELECT COUNT(*) AS count FROM studio_canonical_assets WHERE primary_version_id IS NOT NULL"),
    };
  } finally {
    db.close();
  }
}

function normalizeLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new Error(`limit 必须是 1-${MAX_PAGE_LIMIT} 的整数。`);
  }
  return value;
}

function encodeCursor(scope: string, key: string): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, key }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined, scope: string): string | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; scope?: unknown; key?: unknown };
    if (value.v !== 1 || value.scope !== scope || typeof value.key !== "string" || !value.key) throw new Error("invalid");
    return value.key;
  } catch {
    throw new Error("分页 cursor 无效或不属于当前列表。");
  }
}

function normalizeSha256(value: string, field = "sha256"): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(`${field} 必须是 64 位 SHA-256。`);
  return normalized;
}

function assertRegularSource(stats: BigIntStats, sourcePath: string): void {
  if (stats.isSymbolicLink()) throw new Error(`拒绝导入符号链接：${sourcePath}`);
  if (!stats.isFile()) throw new Error(`素材源必须是普通文件：${sourcePath}`);
}

const MEDIA_TYPES: Record<string, { kind: StudioMediaKind; mimeType: string }> = {
  ".png": { kind: "image", mimeType: "image/png" },
  ".jpg": { kind: "image", mimeType: "image/jpeg" },
  ".jpeg": { kind: "image", mimeType: "image/jpeg" },
  ".webp": { kind: "image", mimeType: "image/webp" },
  ".avif": { kind: "image", mimeType: "image/avif" },
  ".tif": { kind: "image", mimeType: "image/tiff" },
  ".tiff": { kind: "image", mimeType: "image/tiff" },
  ".gif": { kind: "image", mimeType: "image/gif" },
  ".bmp": { kind: "image", mimeType: "image/bmp" },
  ".heic": { kind: "image", mimeType: "image/heic" },
  ".svg": { kind: "image", mimeType: "image/svg+xml" },
  ".mp4": { kind: "video", mimeType: "video/mp4" },
  ".mov": { kind: "video", mimeType: "video/quicktime" },
  ".mkv": { kind: "video", mimeType: "video/x-matroska" },
  ".webm": { kind: "video", mimeType: "video/webm" },
  ".m4v": { kind: "video", mimeType: "video/x-m4v" },
  ".avi": { kind: "video", mimeType: "video/x-msvideo" },
  ".mp3": { kind: "audio", mimeType: "audio/mpeg" },
  ".wav": { kind: "audio", mimeType: "audio/wav" },
  ".m4a": { kind: "audio", mimeType: "audio/mp4" },
  ".aac": { kind: "audio", mimeType: "audio/aac" },
  ".flac": { kind: "audio", mimeType: "audio/flac" },
  ".ogg": { kind: "audio", mimeType: "audio/ogg" },
};

function resolveMediaType(sourcePath: string, explicitKind?: StudioMediaKind): { kind: StudioMediaKind; mimeType: string } {
  const known = MEDIA_TYPES[path.extname(sourcePath).toLowerCase()];
  if (!explicitKind && !known) throw new Error(`无法从扩展名推断素材类型，请显式提供 kind：${path.basename(sourcePath)}`);
  const kind = explicitKind ?? known!.kind;
  const mimeType = known?.kind === kind ? known.mimeType : `${kind}/octet-stream`;
  return { kind, mimeType };
}

async function sha256File(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(createReadStream(filePath), counter, new Transform({
    transform(_chunk, _encoding, callback) {
      callback();
    },
  }));
  return { sha256: hash.digest("hex"), sizeBytes };
}

function thumbnailRecipeKey(mediaSha256: string): string {
  return createHash("sha256").update(`${THUMBNAIL_RECIPE}\0${mediaSha256}`, "utf8").digest("hex");
}

async function materializeThumbnail(
  projectRoot: string,
  objectPath: string,
  mediaSha256: string,
): Promise<{ recipeKey: string; path: string; width: number; height: number }> {
  const paths = studioPaths(projectRoot);
  const thumbnailRoot = await ensureSharedConfinedDirectory(paths.root, paths.thumbnailRoot);
  const recipeKey = thumbnailRecipeKey(mediaSha256);
  const target = path.join(paths.thumbnailRoot, `${recipeKey}.webp`);
  try {
    const existingStats = await lstat(target);
    if (existingStats.isSymbolicLink() || !existingStats.isFile()) throw new Error(`缩略图目标不是普通文件：${target}`);
    const metadata = await (await loadSharpDefault())(target, { failOn: "error" }).metadata();
    if (!metadata.width || !metadata.height || metadata.format !== "webp") throw new Error(`缩略图不可解码：${target}`);
    return { recipeKey, path: target, width: metadata.width, height: metadata.height };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const rendered = await studioThumbnailDerivationGate.run(async () =>
    (await loadSharpDefault())(objectPath, { failOn: "error" })
      .rotate()
      .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true }));
  if (!rendered.info.width || !rendered.info.height || Math.max(rendered.info.width, rendered.info.height) > 512) {
    throw new Error("缩略图派生尺寸无效。");
  }
  await persistConfinedBytesNoReplace(thumbnailRoot, `${recipeKey}.webp`, rendered.data);
  return { recipeKey, path: target, width: rendered.info.width, height: rendered.info.height };
}

function mediaFromRow(projectRoot: string, row: MediaRow): StudioMediaMetadata {
  const item: StudioMediaMetadata = {
    sha256: row.sha256,
    kind: row.kind,
    sizeBytes: Number(row.size_bytes),
    mimeType: row.mime_type,
    sourceBasename: row.source_basename,
    objectPath: fromProjectRelative(projectRoot, row.object_relpath),
    derivativeStatus: row.derivative_status,
    createdAt: row.created_at,
  };
  if (row.thumbnail_recipe_key && row.thumbnail_relpath && row.thumbnail_width && row.thumbnail_height) {
    item.thumbnail = {
      recipe: THUMBNAIL_RECIPE,
      recipeKey: row.thumbnail_recipe_key,
      path: fromProjectRelative(projectRoot, row.thumbnail_relpath),
      width: Number(row.thumbnail_width),
      height: Number(row.thumbnail_height),
      format: "webp",
    };
  }
  return item;
}

function mediaImportOriginFromRow(projectRoot: string, row: MediaImportRow): StudioMediaImportOrigin {
  if (!path.isAbsolute(row.source_path) || path.normalize(row.source_path) !== row.source_path) {
    throw new Error(`素材来源记录不是规范绝对路径：${row.id}`);
  }
  if (path.basename(row.source_path) !== row.source_basename) {
    throw new Error(`素材来源文件名与路径不一致：${row.id}`);
  }
  if (MANAGED_PRIVATE_CAS_PATH_PATTERN.test(row.source_path)) {
    throw new Error(`素材来源记录指向受管私有 CAS，禁止暴露：${row.id}`);
  }
  const relative = path.relative(projectRoot, row.source_path);
  const projectLocal = Boolean(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
  return {
    id: row.id,
    mediaSha256: normalizeSha256(row.media_sha256, "media import sha256"),
    source: projectLocal
      ? { scope: "project", projectRelativePath: relative.split(path.sep).join("/") }
      : { scope: "external", absolutePath: row.source_path },
    sourceBasename: row.source_basename,
    sourceSizeBytes: Number(row.source_size_bytes),
    ...(row.expected_sha256 ? { expectedSha256: normalizeSha256(row.expected_sha256, "media import expectedSha256") } : {}),
    importedAt: row.imported_at,
  };
}

export async function importStudioMedia(projectRoot: string, input: ImportStudioMediaInput): Promise<StudioMediaMetadata> {
  const paths = await ensureStudioDirectories(projectRoot);
  const requestedSourcePath = path.resolve(input.sourcePath);
  assertRegularSource(await lstat(requestedSourcePath, { bigint: true }), requestedSourcePath);
  const sourcePath = path.normalize(await realpath(requestedSourcePath));
  if (MANAGED_PRIVATE_CAS_PATH_PATTERN.test(sourcePath)) {
    throw new Error("禁止将受管私有 CAS 路径作为新的显式素材来源。");
  }
  const { kind, mimeType } = resolveMediaType(sourcePath, input.kind);
  const expectedSha256 = input.expectedSha256 ? normalizeSha256(input.expectedSha256, "expectedSha256") : undefined;
  const objectRoot = await ensureSharedConfinedDirectory(paths.root, paths.objectRoot);
  let importedObject: Awaited<ReturnType<typeof importConfinedFileToSha256Cas>>;
  try {
    importedObject = await importConfinedFileToSha256Cas(objectRoot, sourcePath, expectedSha256);
  } catch (error) {
    const mismatch = /media source sha256 mismatch:([a-f0-9]{64})/u.exec(
      error instanceof Error ? error.message : String(error),
    );
    if (expectedSha256 && mismatch) {
      throw new Error(`素材 SHA-256 不匹配：期望 ${expectedSha256}，实际 ${mismatch[1]}。`, { cause: error });
    }
    if (/media source (?:identity changed|changed while importing)/u.test(
      error instanceof Error ? error.message : String(error),
    )) {
      throw new Error("素材源在流式读取期间发生漂移，拒绝导入。", { cause: error });
    }
    throw error;
  }
  const copied = { sha256: importedObject.sha256, sizeBytes: importedObject.size };
  const objectPath = importedObject.absolutePath;

  let derivativeStatus: StudioDerivativeStatus = "pending";
  let thumbnail: Awaited<ReturnType<typeof materializeThumbnail>> | undefined;
  if (kind === "image") {
    thumbnail = await materializeThumbnail(paths.root, objectPath, copied.sha256);
    derivativeStatus = "ready";
  }

  const db = openDatabase(paths.database);
  try {
    runTransaction(db, () => {
      const importedAt = new Date().toISOString();
      db.prepare(`
        INSERT OR IGNORE INTO studio_media(
          sha256, kind, size_bytes, mime_type, source_basename, object_relpath,
          derivative_status, thumbnail_recipe_key, thumbnail_relpath,
          thumbnail_width, thumbnail_height, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        copied.sha256,
        kind,
        copied.sizeBytes,
        mimeType,
        path.basename(sourcePath),
        relativeToProject(paths.root, objectPath),
        derivativeStatus,
        thumbnail?.recipeKey ?? null,
        thumbnail ? relativeToProject(paths.root, thumbnail.path) : null,
        thumbnail?.width ?? null,
        thumbnail?.height ?? null,
        importedAt,
      );
      const existing = db.prepare("SELECT kind, size_bytes, object_relpath FROM studio_media WHERE sha256 = ?").get(copied.sha256) as {
        kind: StudioMediaKind;
        size_bytes: number;
        object_relpath: string;
      };
      if (existing.kind !== kind || Number(existing.size_bytes) !== copied.sizeBytes || existing.object_relpath !== relativeToProject(paths.root, objectPath)) {
        throw new Error("同一 SHA 的素材元数据与既有记录冲突。");
      }
      db.prepare(`
        INSERT INTO studio_media_imports(
          id, media_sha256, source_path, source_basename, source_size_bytes, expected_sha256, imported_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(
        `media-import-${randomUUID()}`,
        copied.sha256,
        sourcePath,
        path.basename(sourcePath),
        copied.sizeBytes,
        expectedSha256 ?? null,
        importedAt,
      );
    });
    const row = db.prepare("SELECT * FROM studio_media WHERE sha256 = ?").get(copied.sha256) as unknown as MediaRow;
    return mediaFromRow(paths.root, row);
  } finally {
    db.close();
  }
}

function globalResourceReuseProvenanceFromRow(
  row: GlobalResourceReuseProvenanceRow,
): StudioGlobalResourceReuseProvenance {
  return {
    id: row.id,
    sourceProjectId: row.source_project_id,
    sourceProjectName: row.source_project_name,
    sourceManifestFingerprint: normalizeSha256(
      row.source_manifest_fingerprint,
      "sourceManifestFingerprint",
    ),
    sourceMediaSha256: normalizeSha256(row.source_media_sha256, "sourceMediaSha256"),
    targetMediaSha256: normalizeSha256(row.target_media_sha256, "targetMediaSha256"),
    mediaKind: row.media_kind,
    sourceMediaSizeBytes: Number(row.source_media_size_bytes),
    sourceMimeType: row.source_mime_type,
    sourceBasename: row.source_basename,
    commandRequestHash: normalizeSha256(row.command_request_hash, "commandRequestHash"),
    importedAt: row.imported_at,
  };
}

function normalizeGlobalResourceReuseText(
  value: string,
  field: string,
  maximumLength: number,
): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new Error(`${field} 必须是 1-${maximumLength} 个字符。`);
  }
  return normalized;
}

/**
 * 总资源图片、音频、视频进入目标工程的唯一低层 owner。
 *
 * `sourceObjectPath` 只允许由上层 registry + 只读来源库现场解析后传入本函数；
 * 它不会进入 studio_media_imports，也不会作为可复用来源持久化。媒体行与结构化
 * provenance 在同一个目标 SQLite 事务中提交，CAS 对象仍保持内容寻址幂等。
 * 图片在提交媒体行前生成确定性 ready WebP 缩略图；不会创建规范资产、Review
 * 或 Primary。
 */
export async function importStudioGlobalResourceMedia(
  projectRoot: string,
  input: ImportStudioGlobalResourceMediaInput,
): Promise<ImportStudioGlobalResourceMediaResult> {
  if (input.kind !== "image" && input.kind !== "audio" && input.kind !== "video") {
    throw new Error("总资源跨项目媒体只接受 image、audio 或 video。");
  }
  if (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes < 1) {
    throw new Error("expectedSizeBytes 必须是正安全整数。");
  }
  const expectedSha256 = normalizeSha256(input.expectedSha256, "expectedSha256");
  const sourceManifestFingerprint = normalizeSha256(
    input.provenance.sourceManifestFingerprint,
    "sourceManifestFingerprint",
  );
  const commandRequestHash = normalizeSha256(
    input.provenance.commandRequestHash,
    "commandRequestHash",
  );
  const sourceProjectId = normalizeGlobalResourceReuseText(
    input.provenance.sourceProjectId,
    "sourceProjectId",
    256,
  );
  const sourceProjectName = normalizeGlobalResourceReuseText(
    input.provenance.sourceProjectName,
    "sourceProjectName",
    512,
  );
  const sourceBasename = normalizeGlobalResourceReuseText(
    input.sourceBasename,
    "sourceBasename",
    1_024,
  );
  if (path.basename(sourceBasename) !== sourceBasename) {
    throw new Error("sourceBasename 必须是文件名，不能包含路径。");
  }
  const mimeType = normalizeGlobalResourceReuseText(input.mimeType, "mimeType", 256);
  if (!mimeType.toLocaleLowerCase("en-US").startsWith(`${input.kind}/`)) {
    throw new Error(`mimeType 与 ${input.kind} 不一致。`);
  }
  if (!path.isAbsolute(input.sourceObjectPath)) {
    throw new Error("sourceObjectPath 必须是绝对路径。");
  }
  const requestedSourcePath = path.resolve(input.sourceObjectPath);
  const sourceMetadata = await lstat(requestedSourcePath, { bigint: true });
  const sourceObjectPath = path.normalize(await realpath(requestedSourcePath));
  if (!sourceMetadata.isFile()
    || sourceMetadata.isSymbolicLink()
    || sourceMetadata.nlink !== 1n
    || sourceMetadata.size !== BigInt(input.expectedSizeBytes)
    || sourceObjectPath !== requestedSourcePath) {
    throw new Error("总资源来源 CAS 必须是身份稳定的单链接普通文件。");
  }
  const verifiedSource = await sha256File(sourceObjectPath);
  if (verifiedSource.sha256 !== expectedSha256
    || verifiedSource.sizeBytes !== input.expectedSizeBytes) {
    throw new Error("总资源来源 CAS 的 SHA/size 与调用预期不一致。");
  }

  const paths = await ensureStudioDirectories(projectRoot);
  const provenanceSemantic = {
    sourceProjectId,
    sourceManifestFingerprint,
    sourceMediaSha256: expectedSha256,
    targetMediaSha256: expectedSha256,
    mediaKind: input.kind,
  };
  const provenanceId = `${input.kind === "image"
    ? "global-image-resource-reuse"
    : "global-resource-reuse"}-${createHash("sha256")
    .update(stableJson(provenanceSemantic), "utf8")
    .digest("hex")}`;
  const provenanceTable = input.kind === "image"
    ? "studio_global_image_resource_reuse_provenance"
    : "studio_global_resource_reuse_provenance";

  let existingMedia: MediaRow | undefined;
  let existingProvenance: GlobalResourceReuseProvenanceRow | undefined;
  let db = openDatabase(paths.database);
  try {
    if (input.kind === "image") ensureGlobalImageResourceReuseSchemaV1(db);
    else ensureGlobalResourceReuseSchemaV1(db);
    existingMedia = db.prepare("SELECT * FROM studio_media WHERE sha256 = ?")
      .get(expectedSha256) as unknown as MediaRow | undefined;
    existingProvenance = db.prepare(`
      SELECT *
      FROM ${provenanceTable}
      WHERE id = ?
    `).get(provenanceId) as unknown as GlobalResourceReuseProvenanceRow | undefined;
  } finally {
    db.close();
  }

  if (existingMedia) {
    if (existingMedia.kind !== input.kind
      || Number(existingMedia.size_bytes) !== input.expectedSizeBytes
      || existingMedia.object_relpath !== relativeToProject(
        paths.root,
        path.join(paths.objectRoot, expectedSha256.slice(0, 2), expectedSha256),
      )) {
      throw new Error("目标工程同一 SHA 的媒体身份与总资源来源冲突。");
    }
    const verified = await sha256File(fromProjectRelative(paths.root, existingMedia.object_relpath));
    if (verified.sha256 !== expectedSha256 || verified.sizeBytes !== input.expectedSizeBytes) {
      throw new Error("目标工程既有媒体 CAS 已漂移，拒绝把它当作总资源复用结果。");
    }
  }

  let importedObject: Awaited<ReturnType<typeof importConfinedFileToSha256Cas>> | undefined;
  if (!existingMedia) {
    const objectRoot = await ensureSharedConfinedDirectory(paths.root, paths.objectRoot);
    importedObject = await importConfinedFileToSha256Cas(
      objectRoot,
      sourceObjectPath,
      expectedSha256,
    );
    if (importedObject.size !== input.expectedSizeBytes) {
      throw new Error("总资源来源 CAS 的 size 与调用预期不一致。");
    }
  }

  const targetObjectPath = importedObject?.absolutePath
    ?? fromProjectRelative(paths.root, existingMedia!.object_relpath);
  const thumbnail = input.kind === "image"
    ? await materializeThumbnail(paths.root, targetObjectPath, expectedSha256)
    : undefined;
  if (existingMedia && input.kind === "image") {
    if (existingMedia.derivative_status !== "ready"
      || existingMedia.thumbnail_recipe_key !== thumbnail!.recipeKey
      || existingMedia.thumbnail_relpath !== relativeToProject(paths.root, thumbnail!.path)
      || Number(existingMedia.thumbnail_width) !== thumbnail!.width
      || Number(existingMedia.thumbnail_height) !== thumbnail!.height) {
      throw new Error("目标工程既有图片的 ready 缩略图身份与确定性配方不一致。");
    }
  }
  if (existingMedia && existingProvenance) {
    return {
      media: mediaFromRow(paths.root, existingMedia),
      provenance: globalResourceReuseProvenanceFromRow(existingProvenance),
      disposition: "already-present",
    };
  }

  db = openDatabase(paths.database);
  try {
    const importedAt = new Date().toISOString();
    const outcome = runTransaction(db, () => {
      db.prepare(`
        INSERT OR IGNORE INTO studio_media(
          sha256, kind, size_bytes, mime_type, source_basename, object_relpath,
          derivative_status, thumbnail_recipe_key, thumbnail_relpath,
          thumbnail_width, thumbnail_height, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        expectedSha256,
        input.kind,
        input.expectedSizeBytes,
        mimeType,
        sourceBasename,
        relativeToProject(paths.root, targetObjectPath),
        input.kind === "image" ? "ready" : "pending",
        thumbnail?.recipeKey ?? null,
        thumbnail ? relativeToProject(paths.root, thumbnail.path) : null,
        thumbnail?.width ?? null,
        thumbnail?.height ?? null,
        importedAt,
      );
      const media = db.prepare("SELECT * FROM studio_media WHERE sha256 = ?")
        .get(expectedSha256) as unknown as MediaRow | undefined;
      if (!media
        || media.kind !== input.kind
        || Number(media.size_bytes) !== input.expectedSizeBytes
        || media.object_relpath !== relativeToProject(paths.root, targetObjectPath)
        || (input.kind === "image" && (
          media.derivative_status !== "ready"
          || media.thumbnail_recipe_key !== thumbnail!.recipeKey
          || media.thumbnail_relpath !== relativeToProject(paths.root, thumbnail!.path)
          || Number(media.thumbnail_width) !== thumbnail!.width
          || Number(media.thumbnail_height) !== thumbnail!.height
        ))) {
        throw new Error("目标工程同一 SHA 的媒体元数据与总资源来源冲突。");
      }
      db.prepare(`
        INSERT OR IGNORE INTO ${provenanceTable}(
          id,
          source_project_id,
          source_project_name,
          source_manifest_fingerprint,
          source_media_sha256,
          target_media_sha256,
          media_kind,
          source_media_size_bytes,
          source_mime_type,
          source_basename,
          command_request_hash,
          imported_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        provenanceId,
        sourceProjectId,
        sourceProjectName,
        sourceManifestFingerprint,
        expectedSha256,
        media.sha256,
        input.kind,
        input.expectedSizeBytes,
        mimeType,
        sourceBasename,
        commandRequestHash,
        importedAt,
      );
      const provenance = db.prepare(`
        SELECT *
        FROM ${provenanceTable}
        WHERE id = ?
      `).get(provenanceId) as unknown as GlobalResourceReuseProvenanceRow | undefined;
      if (!provenance) throw new Error("总资源复用来源记录未能原子落盘。");
      return { media, provenance };
    });
    return {
      media: mediaFromRow(paths.root, outcome.media),
      provenance: globalResourceReuseProvenanceFromRow(outcome.provenance),
      disposition: existingMedia ? "already-present" : "imported",
    };
  } finally {
    db.close();
  }
}

export async function listStudioGlobalResourceReuseProvenance(
  projectRoot: string,
  mediaSha256: string,
): Promise<StudioGlobalResourceReuseProvenance[]> {
  const paths = await ensureStudioDirectories(projectRoot);
  const normalizedSha256 = normalizeSha256(mediaSha256, "mediaSha256");
  const db = openDatabase(paths.database);
  try {
    const rows: GlobalResourceReuseProvenanceRow[] = [];
    if (globalResourceReuseSchemaReady(db)) {
      rows.push(...db.prepare(`
        SELECT *
        FROM studio_global_resource_reuse_provenance
        WHERE target_media_sha256 = ?
      `).all(normalizedSha256) as unknown as GlobalResourceReuseProvenanceRow[]);
    }
    if (globalImageResourceReuseSchemaReady(db)) {
      rows.push(...db.prepare(`
        SELECT *
        FROM studio_global_image_resource_reuse_provenance
        WHERE target_media_sha256 = ?
      `).all(normalizedSha256) as unknown as GlobalResourceReuseProvenanceRow[]);
    }
    return rows
      .sort((left, right) =>
        left.imported_at.localeCompare(right.imported_at) || left.id.localeCompare(right.id)
      )
      .slice(0, 100)
      .map(globalResourceReuseProvenanceFromRow);
  } finally {
    db.close();
  }
}

export async function listStudioMediaImportOrigins(
  projectRoot: string,
  mediaSha256: string,
  query: StudioMediaImportOriginListQuery = {},
): Promise<StudioMediaImportOriginPage> {
  const paths = await ensureStudioDirectories(projectRoot);
  const canonicalProjectRoot = path.normalize(await realpath(paths.root));
  const normalizedSha256 = normalizeSha256(mediaSha256, "mediaSha256");
  const limit = normalizeLimit(query.limit);
  const scope = `media-import-origins:${normalizedSha256}`;
  const cursor = decodeCursor(query.cursor, scope);
  let afterImportedAt: string | null = null;
  let afterId: string | null = null;
  if (cursor) {
    const separator = cursor.indexOf("\0");
    if (separator <= 0 || separator === cursor.length - 1 || cursor.indexOf("\0", separator + 1) !== -1) {
      throw new Error("素材来源分页 cursor 无效。");
    }
    afterImportedAt = cursor.slice(0, separator);
    afterId = cursor.slice(separator + 1);
  }
  const db = openDatabase(paths.database);
  try {
    const media = db.prepare("SELECT 1 AS present FROM studio_media WHERE sha256 = ?").get(normalizedSha256);
    if (!media) throw new Error(`素材媒体不存在：${normalizedSha256}`);
    const rows = db.prepare(`
      SELECT * FROM studio_media_imports
      WHERE media_sha256 = ?
        AND (
          ? IS NULL
          OR imported_at > ?
          OR (imported_at = ? AND id > ?)
        )
      ORDER BY imported_at ASC, id ASC
      LIMIT ?
    `).all(
      normalizedSha256,
      afterImportedAt,
      afterImportedAt,
      afterImportedAt,
      afterId,
      limit + 1,
    ) as unknown as MediaImportRow[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return {
      items: selected.map((row) => mediaImportOriginFromRow(canonicalProjectRoot, row)),
      ...(hasMore && last ? { nextCursor: encodeCursor(scope, `${last.imported_at}\0${last.id}`) } : {}),
    };
  } finally {
    db.close();
  }
}

export async function listStudioMedia(projectRoot: string, query: StudioMediaListQuery = {}): Promise<StudioMediaPage> {
  const paths = await ensureStudioDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    const limit = normalizeLimit(query.limit);
    const kind = query.kind === undefined ? undefined : normalizeMediaKind(query.kind);
    const search = query.search?.normalize("NFKC").trim().toLocaleLowerCase("zh-CN") ?? "";
    if (search.length > 256) throw new Error("search 不能超过 256 个字符。");
    const like = `%${search.replace(/[\\%_]/gu, (value) => `\\${value}`)}%`;
    const scope = `media:${kind ?? "*"}:${createHash("sha256").update(search, "utf8").digest("hex").slice(0, 16)}`;
    const after = decodeCursor(query.cursor, scope);
    const rows = db.prepare(`
      SELECT * FROM studio_media
      WHERE (? IS NULL OR sha256 > ?)
        AND (? IS NULL OR kind = ?)
        AND (
          ? = ''
          OR lower(source_basename) LIKE ? ESCAPE '\\'
          OR lower(mime_type) LIKE ? ESCAPE '\\'
          OR sha256 LIKE ? ESCAPE '\\'
        )
      ORDER BY sha256 ASC
      LIMIT ?
    `).all(after ?? null, after ?? null, kind ?? null, kind ?? null, search, like, like, like, limit + 1) as unknown as MediaRow[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    return {
      items: selected.map((row) => mediaFromRow(paths.root, row)),
      nextCursor: hasMore ? encodeCursor(scope, selected[selected.length - 1]!.sha256) : undefined,
    };
  } finally {
    db.close();
  }
}

/**
 * 画布 / IPC 按 SHA 读媒体元数据：只读打开已有素材库。
 * 不 ensure 目录、不走可写 openDatabase（P28 probe + WAL + 建表）。
 * 缺库/缺表视为没有该媒体（返回 null）。符号链接或不受支持的 schema 失败关闭。
 * 并发相同 (root, sha) 单飞，避免 4 路 worker 重复打开同一行。
 */
const studioMediaLookupFlights = new Map<string, Promise<StudioMediaMetadata | null>>();

function openMaterialStudioMediaReadOnly(databasePath: string): DatabaseSync | null {
  if (!existsSync(databasePath)) return null;
  const metadata = lstatSync(databasePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("素材库数据库必须是无符号链接的普通文件。");
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    const tables = new Set(
      (db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('studio_meta', 'studio_media')
      `).all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!tables.has("studio_meta") || !tables.has("studio_media")) {
      db.close();
      return null;
    }
    const version = db.prepare("SELECT value FROM studio_meta WHERE key = 'schema_version'")
      .get() as { value?: string } | undefined;
    if (version?.value !== undefined && version.value !== String(SCHEMA_VERSION)) {
      throw new Error(`不支持的素材库 schema_version：${version.value}。`);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function readStudioMediaMetadataReadOnly(
  paths: ReturnType<typeof studioPaths>,
  normalized: string,
): StudioMediaMetadata | null {
  const db = openMaterialStudioMediaReadOnly(paths.database);
  if (!db) return null;
  try {
    const row = db.prepare("SELECT * FROM studio_media WHERE sha256 = ?").get(normalized) as unknown as MediaRow | undefined;
    return row ? mediaFromRow(paths.root, row) : null;
  } finally {
    db.close();
  }
}

export async function getStudioMedia(projectRoot: string, sha256: string): Promise<StudioMediaMetadata | null> {
  const paths = studioPaths(projectRoot);
  const normalized = normalizeSha256(sha256);
  const key = `${paths.root}\u0000${normalized}`;
  const existing = studioMediaLookupFlights.get(key);
  if (existing) return existing;
  const pending = Promise.resolve().then(() => readStudioMediaMetadataReadOnly(paths, normalized));
  studioMediaLookupFlights.set(key, pending);
  try {
    return await pending;
  } finally {
    if (studioMediaLookupFlights.get(key) === pending) studioMediaLookupFlights.delete(key);
  }
}

const imageThumbnailRepairFlights = new Map<string, Promise<StudioMediaMetadata>>();

async function ensureStudioImageThumbnailInternal(
  projectRoot: string,
  sha256: string,
): Promise<StudioMediaMetadata> {
  const paths = await ensureStudioDirectories(projectRoot);
  const normalized = normalizeSha256(sha256);
  const media = await getStudioMedia(paths.root, normalized);
  if (!media || media.kind !== "image" || !media.thumbnail) {
    throw new Error("只能恢复已登记图片媒体的冻结缩略图。");
  }
  const target = media.thumbnail.path;
  let quarantinePath: string | undefined;
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("缩略图目标不是受管普通文件，已拒绝自动修复。");
    }
    const decoded = await (await loadSharpDefault())(target, { failOn: "error" }).metadata();
    if (!decoded.width || !decoded.height || decoded.format !== "webp") {
      throw new Error("缩略图不可解码。");
    }
    return media;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof Error && error.message.includes("不是受管普通文件")) throw error;
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error("缩略图目标不是受管普通文件，已拒绝自动修复。");
      }
      const quarantineRoot = path.join(paths.root, ".aicanvas", "quarantine", "thumbnails");
      await ensureSharedConfinedDirectory(paths.root, quarantineRoot);
      quarantinePath = path.join(
        quarantineRoot,
        `${media.thumbnail.recipeKey}-${Date.now()}-${randomUUID()}.corrupt.webp`,
      );
      await rename(target, quarantinePath);
    }
  }

  try {
    const objectIdentity = await sha256File(media.objectPath);
    if (objectIdentity.sha256 !== media.sha256 || objectIdentity.sizeBytes !== media.sizeBytes) {
      throw new Error("图片媒体 CAS 身份校验失败，禁止派生缩略图。");
    }
    const thumbnail = await materializeThumbnail(paths.root, media.objectPath, media.sha256);
    const db = openDatabase(paths.database);
    try {
      db.prepare(`
        UPDATE studio_media
        SET derivative_status = 'ready',
            thumbnail_recipe_key = ?,
            thumbnail_relpath = ?,
            thumbnail_width = ?,
            thumbnail_height = ?
        WHERE sha256 = ? AND kind = 'image'
      `).run(
        thumbnail.recipeKey,
        relativeToProject(paths.root, thumbnail.path),
        thumbnail.width,
        thumbnail.height,
        media.sha256,
      );
    } finally {
      db.close();
    }
    const restored = await getStudioMedia(paths.root, media.sha256);
    if (!restored?.thumbnail) throw new Error("图片缩略图恢复后索引不可读。");
    return restored;
  } catch (error) {
    if (quarantinePath) {
      try {
        await lstat(target);
      } catch (targetError) {
        if ((targetError as NodeJS.ErrnoException).code === "ENOENT") {
          await rename(quarantinePath, target).catch(() => undefined);
        }
      }
    }
    throw error;
  }
}

/**
 * 图片冻结缩略图的幂等恢复入口。缺失时重建；损坏时先移入工程内隔离区，
 * CAS 原图保持只读。并发请求按 projectRoot+SHA 单飞。
 */
export async function ensureStudioImageThumbnail(
  projectRoot: string,
  sha256: string,
): Promise<StudioMediaMetadata> {
  const key = `${resolveProjectRoot(projectRoot)}\u0000${normalizeSha256(sha256)}`;
  const existing = imageThumbnailRepairFlights.get(key);
  if (existing) return existing;
  const pending = ensureStudioImageThumbnailInternal(projectRoot, sha256);
  imageThumbnailRepairFlights.set(key, pending);
  try {
    return await pending;
  } finally {
    if (imageThumbnailRepairFlights.get(key) === pending) imageThumbnailRepairFlights.delete(key);
  }
}

function normalizeCategory(category: string): StudioCanonicalAssetCategory {
  if (category !== "character" && category !== "scene" && category !== "prop" && category !== "style") {
    throw new Error("资产 category 必须显式为 character、scene、prop 或 style。");
  }
  return category;
}

function normalizeMediaKind(kind: string): StudioMediaKind {
  if (kind !== "image" && kind !== "video" && kind !== "audio") {
    throw new Error("素材 kind 必须是 image、video 或 audio。");
  }
  return kind;
}

function requiredText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空。`);
  if (normalized.length > maxLength) throw new Error(`${field} 不能超过 ${maxLength} 个字符。`);
  return normalized;
}

function optionalText(value: string | undefined, field: string, maxLength: number): string {
  if (value === undefined) return "";
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${field} 不能超过 ${maxLength} 个字符。`);
  return normalized;
}

function normalizedTextList(values: string[] | undefined, field: string): string[] {
  if (!values) return [];
  if (values.length > 100) throw new Error(`${field} 最多 100 项。`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const display = requiredText(value, field, 1_000);
    const key = display.normalize("NFKC").toLocaleLowerCase("zh-CN");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(display);
  }
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedScopeList(values: string[] | undefined, field: string): string[] {
  if (!values) return [];
  if (values.length > 200) throw new Error(`${field} 最多 200 项。`);
  const byKey = new Map<string, string>();
  for (const raw of values) {
    const display = requiredText(raw, field, 256).normalize("NFKC");
    if (/\p{Cc}/u.test(display)) throw new Error(`${field} 不能包含控制字符。`);
    const key = display.toLocaleLowerCase("zh-CN");
    const existing = byKey.get(key);
    if (existing !== undefined && existing !== display) {
      throw new Error(`${field} 包含仅大小写不同的歧义范围：${existing} / ${display}`);
    }
    byKey.set(key, display);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, display]) => display);
}

function normalizeApplicability(input: StudioAssetApplicabilityInput | undefined): StudioAssetApplicability {
  const projects = normalizedScopeList(input?.projects, "applicability.projects");
  const seasons = normalizedScopeList(input?.seasons, "applicability.seasons");
  const episodes = normalizedScopeList(input?.episodes, "applicability.episodes");
  const units = normalizedScopeList(input?.units, "applicability.units");
  const tags = normalizedScopeList(input?.tags, "applicability.tags");
  const sourceRanges = input?.timeRanges ?? [];
  if (sourceRanges.length > 200) throw new Error("applicability.timeRanges 最多 200 项。");
  const byKey = new Map<string, StudioAssetApplicabilityTimeRange>();
  for (const source of sourceRanges) {
    if (!source || (source.scope !== "episode" && source.scope !== "unit")) {
      throw new Error("applicability.timeRanges.scope 必须是 episode 或 unit。");
    }
    const scopeId = requiredText(source.scopeId, "applicability.timeRanges.scopeId", 256).normalize("NFKC");
    const startSeconds = Number(source.startSeconds);
    const endSeconds = Number(source.endSeconds);
    const maximumEndSeconds = source.scope === "unit" ? 15 : 86_400;
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > maximumEndSeconds) {
      throw new Error(`applicability.timeRanges(${source.scope}) 必须满足 0 <= startSeconds < endSeconds <= ${maximumEndSeconds}。`);
    }
    const label = optionalText(source.label, "applicability.timeRanges.label", 256);
    const range: StudioAssetApplicabilityTimeRange = {
      scope: source.scope,
      scopeId,
      startSeconds,
      endSeconds,
      ...(label ? { label } : {}),
    };
    const key = `${source.scope}\0${scopeId.toLocaleLowerCase("zh-CN")}\0${startSeconds}\0${endSeconds}`;
    const existing = byKey.get(key);
    if (existing && stableJson(existing) !== stableJson(range)) {
      throw new Error("applicability.timeRanges 含相同范围但不同标签的歧义记录。");
    }
    byKey.set(key, range);
  }
  const timeRanges = [...byKey.values()].sort((left, right) => {
    if (left.scope !== right.scope) return left.scope < right.scope ? -1 : 1;
    const leftScopeId = left.scopeId.toLocaleLowerCase("zh-CN");
    const rightScopeId = right.scopeId.toLocaleLowerCase("zh-CN");
    if (leftScopeId !== rightScopeId) return leftScopeId < rightScopeId ? -1 : 1;
    if (left.startSeconds !== right.startSeconds) return left.startSeconds - right.startSeconds;
    return left.endSeconds - right.endSeconds;
  });
  for (let index = 1; index < timeRanges.length; index += 1) {
    const previous = timeRanges[index - 1]!;
    const current = timeRanges[index]!;
    if (previous.scope === current.scope
      && previous.scopeId.toLocaleLowerCase("zh-CN") === current.scopeId.toLocaleLowerCase("zh-CN")
      && current.startSeconds < previous.endSeconds) {
      throw new Error(`applicability.timeRanges 在 ${current.scope}:${current.scopeId} 上存在重叠歧义。`);
    }
  }
  return { projects, seasons, episodes, units, timeRanges, tags };
}

function parseStoredApplicability(value: string, field: string): StudioAssetApplicability {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch (error) { throw new Error(`素材库 ${field} JSON 已损坏。`, { cause: error }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`素材库 ${field} 结构无效。`);
  const candidate = parsed as Record<string, unknown>;
  const listFields = ["projects", "seasons", "episodes", "units", "tags"] as const;
  if (listFields.some((key) => !Array.isArray(candidate[key]) || !(candidate[key] as unknown[]).every((entry) => typeof entry === "string"))
    || !Array.isArray(candidate.timeRanges)) {
    throw new Error(`素材库 ${field} 结构无效。`);
  }
  return normalizeApplicability(candidate as unknown as StudioAssetApplicabilityInput);
}

function sameScopeValue(left: string | undefined, right: string): boolean {
  return left?.normalize("NFKC").toLocaleLowerCase("zh-CN") === right.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

export function evaluateStudioAssetApplicability(
  applicability: StudioAssetApplicability,
  target: StudioAssetApplicabilityTarget,
): StudioAssetApplicabilityEvaluation {
  const normalized = normalizeApplicability(applicability);
  const assertTimePair = (
    start: number | undefined,
    end: number | undefined,
    label: string,
    maximumEndSeconds: number,
  ): void => {
    if ((start === undefined) !== (end === undefined)) {
      throw new Error(`适用范围判断必须同时提供 ${label}StartSeconds 与 ${label}EndSeconds。`);
    }
    if (start !== undefined
      && (!Number.isFinite(start) || !Number.isFinite(end)
        || start < 0 || end! <= start || end! > maximumEndSeconds)) {
      throw new Error(`${label} 时间必须满足 0 <= startSeconds < endSeconds <= ${maximumEndSeconds}。`);
    }
  };
  assertTimePair(target.unitLocalStartSeconds, target.unitLocalEndSeconds, "unitLocal", 15);
  assertTimePair(target.episodeAbsoluteStartSeconds, target.episodeAbsoluteEndSeconds, "episodeAbsolute", 86_400);
  if (target.unitLocalStartSeconds !== undefined && !target.unitId) {
    throw new Error("提供 unitLocal 时间时必须同时提供 unitId。");
  }
  if (target.episodeAbsoluteStartSeconds !== undefined && !target.episodeId) {
    throw new Error("提供 episodeAbsolute 时间时必须同时提供 episodeId。");
  }
  const reasons: string[] = [];
  const dimensions: Array<[string, string[], string | undefined]> = [
    ["project-mismatch", normalized.projects, target.projectId],
    ["season-mismatch", normalized.seasons, target.seasonId],
    ["episode-mismatch", normalized.episodes, target.episodeId],
    ["unit-mismatch", normalized.units, target.unitId],
  ];
  for (const [reason, allowed, observed] of dimensions) {
    if (allowed.length > 0 && !allowed.some((entry) => sameScopeValue(observed, entry))) reasons.push(reason);
  }
  let matchedTimeRange: StudioAssetApplicabilityTimeRange | undefined;
  if (normalized.timeRanges.length > 0) {
    matchedTimeRange = normalized.timeRanges.find((range) => {
      if (range.scope === "unit") {
        return sameScopeValue(target.unitId, range.scopeId)
          && target.unitLocalStartSeconds !== undefined
          && target.unitLocalEndSeconds !== undefined
          && target.unitLocalStartSeconds >= range.startSeconds
          && target.unitLocalEndSeconds <= range.endSeconds;
      }
      return sameScopeValue(target.episodeId, range.scopeId)
        && target.episodeAbsoluteStartSeconds !== undefined
        && target.episodeAbsoluteEndSeconds !== undefined
        && target.episodeAbsoluteStartSeconds >= range.startSeconds
        && target.episodeAbsoluteEndSeconds <= range.endSeconds;
    });
    if (!matchedTimeRange) {
      const missingUnitContext = normalized.timeRanges.some((range) => range.scope === "unit")
        && (!target.unitId || target.unitLocalStartSeconds === undefined || target.unitLocalEndSeconds === undefined);
      const missingEpisodeContext = normalized.timeRanges.some((range) => range.scope === "episode")
        && (!target.episodeId || target.episodeAbsoluteStartSeconds === undefined || target.episodeAbsoluteEndSeconds === undefined);
      if (missingUnitContext) reasons.push("unit-time-context-missing");
      if (missingEpisodeContext) reasons.push("episode-time-context-missing");
      if (!missingUnitContext && !missingEpisodeContext) reasons.push("time-range-mismatch");
    }
  }
  return {
    applicable: reasons.length === 0,
    reasons,
    ...(matchedTimeRange ? { matchedTimeRange } : {}),
  };
}

function parseStoredTextList(value: string, field: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch (error) { throw new Error(`素材库 ${field} JSON 已损坏。`, { cause: error }); }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`素材库 ${field} 结构无效。`);
  }
  return parsed;
}

function normalizeAlias(alias: string): { display: string; normalized: string } {
  const display = requiredText(alias, "alias", 256);
  return { display, normalized: display.normalize("NFKC").toLocaleLowerCase("zh-CN") };
}

function normalizeAssetId(value: string | undefined): string {
  const id = value?.trim() || `asset-${randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) throw new Error("资产 id 格式无效。");
  return id;
}

function assertExpectedRevision(value: number, allowZero: boolean): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum) throw new Error(`expectedRevision 必须是不小于 ${minimum} 的整数。`);
}

function addAliases(db: DatabaseSync, assetId: string, aliases: string[], createdAt: string): void {
  const insert = db.prepare("INSERT OR IGNORE INTO studio_asset_aliases(asset_id, alias, normalized_alias, created_at) VALUES(?, ?, ?, ?)");
  for (const alias of aliases) {
    const normalized = normalizeAlias(alias);
    insert.run(assetId, normalized.display, normalized.normalized, createdAt);
  }
}

function aliasesForAsset(db: DatabaseSync, assetId: string): string[] {
  return (db.prepare("SELECT alias FROM studio_asset_aliases WHERE asset_id = ? ORDER BY normalized_alias, alias").all(assetId) as Array<{ alias: string }>).map((row) => row.alias);
}

function getAssetRow(db: DatabaseSync, assetId: string): AssetRow | undefined {
  return db.prepare(`
    SELECT a.*,
      pv.media_sha256 AS primary_media_sha256,
      pm.thumbnail_recipe_key AS primary_thumbnail_recipe_key,
      (SELECT COUNT(*) FROM studio_asset_versions v WHERE v.asset_id = a.id) AS version_count
    FROM studio_canonical_assets a
    LEFT JOIN studio_asset_versions pv ON pv.id = a.primary_version_id
    LEFT JOIN studio_media pm ON pm.sha256 = pv.media_sha256
    WHERE a.id = ?
  `).get(assetId) as unknown as AssetRow | undefined;
}

function summaryFromRow(db: DatabaseSync, row: AssetRow): StudioCanonicalAssetSummary {
  const item: StudioCanonicalAssetSummary = {
    id: row.id,
    category: row.category,
    name: row.name,
    description: row.description,
    aliases: aliasesForAsset(db, row.id),
    applicability: parseStoredApplicability(row.applicability_json, "assetApplicability"),
    revision: Number(row.revision),
    versionCount: Number(row.version_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.primary_version_id && row.primary_media_sha256) {
    item.primaryAuthority = {
      versionId: row.primary_version_id,
      mediaSha256: row.primary_media_sha256,
      ...(row.primary_thumbnail_recipe_key ? { thumbnailRecipeKey: row.primary_thumbnail_recipe_key } : {}),
    };
  }
  return item;
}

function versionFromRow(row: VersionRow): StudioAssetVersion {
  return {
    id: row.id,
    assetId: row.asset_id,
    ordinal: Number(row.ordinal),
    mediaSha256: row.media_sha256,
    ...(row.thumbnail_recipe_key ? { thumbnailRecipeKey: row.thumbnail_recipe_key } : {}),
    reviewStatus: row.effective_review_status ?? row.review_status,
    sourceNote: row.source_note,
    createdAt: row.created_at,
  };
}

function definitionFromRow(row: DefinitionRow): StudioAssetDefinitionVersion {
  return {
    id: row.id,
    assetId: row.asset_id,
    ordinal: Number(row.ordinal),
    assetRevision: Number(row.asset_revision),
    category: row.category,
    name: row.name,
    description: row.description,
    aliases: parseStoredTextList(row.aliases_json, "definitionAliases"),
    identityFeatures: parseStoredTextList(row.identity_features_json, "identityFeatures"),
    positiveLocks: parseStoredTextList(row.positive_locks_json, "positiveLocks"),
    negativeLocks: parseStoredTextList(row.negative_locks_json, "negativeLocks"),
    defaultPrompt: row.default_prompt,
    applicability: parseStoredApplicability(row.applicability_json, "definitionApplicability"),
    createdAt: row.created_at,
  };
}

function appendDefinitionSnapshot(
  db: DatabaseSync,
  input: {
    assetId: string;
    assetRevision: number;
    category: StudioCanonicalAssetCategory;
    name: string;
    description: string;
    aliases: string[];
    identityFeatures: string[];
    positiveLocks: string[];
    negativeLocks: string[];
    defaultPrompt: string;
    applicability: StudioAssetApplicability;
    createdAt: string;
  },
): StudioAssetDefinitionVersion {
  const ordinal = Number((db.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM studio_asset_definitions WHERE asset_id = ?")
    .get(input.assetId) as { ordinal: number }).ordinal);
  const id = `definition-${randomUUID()}`;
  db.prepare(`
    INSERT INTO studio_asset_definitions(
      id, asset_id, ordinal, asset_revision, category, name, description,
      aliases_json, identity_features_json, positive_locks_json, negative_locks_json,
      default_prompt, applicability_json, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.assetId,
    ordinal,
    input.assetRevision,
    input.category,
    input.name,
    input.description,
    JSON.stringify(input.aliases),
    JSON.stringify(input.identityFeatures),
    JSON.stringify(input.positiveLocks),
    JSON.stringify(input.negativeLocks),
    input.defaultPrompt,
    stableJson(input.applicability),
    input.createdAt,
  );
  return {
    id,
    assetId: input.assetId,
    ordinal,
    assetRevision: input.assetRevision,
    category: input.category,
    name: input.name,
    description: input.description,
    aliases: [...input.aliases],
    identityFeatures: [...input.identityFeatures],
    positiveLocks: [...input.positiveLocks],
    negativeLocks: [...input.negativeLocks],
    defaultPrompt: input.defaultPrompt,
    applicability: structuredClone(input.applicability),
    createdAt: input.createdAt,
  };
}

function detailFromDatabase(db: DatabaseSync, assetId: string): StudioCanonicalAssetDetail {
  const row = getAssetRow(db, assetId);
  if (!row) throw new Error(`素材资产不存在：${assetId}`);
  const versions = db.prepare(`
    SELECT version.*,
      media.thumbnail_recipe_key AS thumbnail_recipe_key,
      COALESCE(review.to_status, version.review_status) AS effective_review_status
    FROM studio_asset_versions version
    LEFT JOIN studio_media media ON media.sha256 = version.media_sha256
    LEFT JOIN studio_version_reviews review ON review.version_id = version.id
    WHERE version.asset_id = ?
    ORDER BY version.ordinal ASC
  `).all(assetId) as unknown as VersionRow[];
  const definitions = (db.prepare("SELECT * FROM studio_asset_definitions WHERE asset_id = ? ORDER BY ordinal ASC").all(assetId) as unknown as DefinitionRow[])
    .map(definitionFromRow);
  const currentDefinition = definitions.at(-1);
  if (!currentDefinition) throw new Error(`素材资产缺少不可变定义版本：${assetId}`);
  const authorityHistory = (db.prepare("SELECT * FROM studio_authority_events WHERE asset_id = ? ORDER BY asset_revision ASC, id ASC").all(assetId) as unknown as AuthorityEventRow[])
    .map((event): StudioAuthorityEvent => ({
      id: event.id,
      assetId: event.asset_id,
      versionId: event.version_id,
      ...(event.previous_version_id ? { previousVersionId: event.previous_version_id } : {}),
      assetRevision: Number(event.asset_revision),
      note: event.note,
      createdAt: event.created_at,
    }));
  const reviewHistory = (db.prepare("SELECT * FROM studio_version_reviews WHERE asset_id = ? ORDER BY asset_revision ASC, id ASC").all(assetId) as unknown as VersionReviewRow[])
    .map((review): StudioVersionReview => ({
      id: review.id,
      assetId: review.asset_id,
      versionId: review.version_id,
      fromStatus: review.from_status,
      toStatus: review.to_status,
      assetRevision: Number(review.asset_revision),
      note: review.note,
      createdAt: review.created_at,
    }));
  return {
    ...summaryFromRow(db, row),
    versions: versions.map(versionFromRow),
    currentDefinitionVersionId: currentDefinition.id,
    definitionVersions: definitions,
    identityFeatures: currentDefinition.identityFeatures,
    positiveLocks: currentDefinition.positiveLocks,
    negativeLocks: currentDefinition.negativeLocks,
    defaultPrompt: currentDefinition.defaultPrompt,
    applicability: currentDefinition.applicability,
    authorityHistory,
    reviewHistory,
    relations: relationsForAsset(db, assetId),
  };
}

export async function createStudioCanonicalAsset(projectRoot: string, input: CreateStudioCanonicalAssetInput): Promise<StudioCanonicalAssetDetail> {
  assertExpectedRevision(input.expectedRevision, true);
  if (input.expectedRevision !== 0) throw new Error("创建素材资产必须提供 expectedRevision=0。");
  const paths = await ensureStudioDirectories(projectRoot);
  const id = normalizeAssetId(input.id);
  const category = normalizeCategory(input.category);
  const name = requiredText(input.name, "name", 256);
  const description = optionalText(input.description, "description", 20_000);
  const aliases = normalizedTextList([name, ...(input.aliases ?? [])], "aliases");
  const identityFeatures = normalizedTextList(input.identityFeatures, "identityFeatures");
  const positiveLocks = normalizedTextList(input.positiveLocks, "positiveLocks");
  const negativeLocks = normalizedTextList(input.negativeLocks, "negativeLocks");
  const defaultPrompt = optionalText(input.defaultPrompt, "defaultPrompt", 40_000);
  const applicability = normalizeApplicability(input.applicability);
  const now = new Date().toISOString();
  const db = openDatabase(paths.database);
  try {
    runTransaction(db, () => {
      if (getAssetRow(db, id)) throw new MaterialStudioConflictError(0, getAssetRow(db, id)!.revision);
      db.prepare(`
        INSERT INTO studio_canonical_assets(id, category, name, description, applicability_json, revision, primary_version_id, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, 1, NULL, ?, ?)
      `).run(id, category, name, description, stableJson(applicability), now, now);
      addAliases(db, id, aliases, now);
      appendDefinitionSnapshot(db, {
        assetId: id,
        assetRevision: 1,
        category,
        name,
        description,
        aliases,
        identityFeatures,
        positiveLocks,
        negativeLocks,
        defaultPrompt,
        applicability,
        createdAt: now,
      });
      syncStudioIdentityIndexForAsset(db, id);
    });
    return detailFromDatabase(db, id);
  } finally {
    db.close();
  }
}

function normalizeUpdateArguments(
  assetIdOrInput: string | UpdateStudioCanonicalAssetInput,
  maybeInput?: Omit<UpdateStudioCanonicalAssetInput, "assetId">,
): UpdateStudioCanonicalAssetInput {
  if (typeof assetIdOrInput === "string") {
    if (!maybeInput) throw new Error("缺少资产更新参数。");
    return { assetId: assetIdOrInput, ...maybeInput };
  }
  return assetIdOrInput;
}

export function updateStudioCanonicalAsset(projectRoot: string, input: UpdateStudioCanonicalAssetInput): Promise<StudioCanonicalAssetDetail>;
export function updateStudioCanonicalAsset(projectRoot: string, assetId: string, input: Omit<UpdateStudioCanonicalAssetInput, "assetId">): Promise<StudioCanonicalAssetDetail>;
export async function updateStudioCanonicalAsset(
  projectRoot: string,
  assetIdOrInput: string | UpdateStudioCanonicalAssetInput,
  maybeInput?: Omit<UpdateStudioCanonicalAssetInput, "assetId">,
): Promise<StudioCanonicalAssetDetail> {
  const input = normalizeUpdateArguments(assetIdOrInput, maybeInput);
  assertExpectedRevision(input.expectedRevision, false);
  const paths = await ensureStudioDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    runTransaction(db, () => {
      const current = getAssetRow(db, input.assetId);
      if (!current) throw new Error(`素材资产不存在：${input.assetId}`);
      if (Number(current.revision) !== input.expectedRevision) throw new MaterialStudioConflictError(input.expectedRevision, Number(current.revision));
      const currentDefinitionRow = db.prepare("SELECT * FROM studio_asset_definitions WHERE asset_id = ? ORDER BY ordinal DESC LIMIT 1")
        .get(input.assetId) as unknown as DefinitionRow | undefined;
      if (!currentDefinitionRow) throw new Error(`素材资产缺少不可变定义版本：${input.assetId}`);
      const currentDefinition = definitionFromRow(currentDefinitionRow);
      const category = input.category === undefined ? current.category : normalizeCategory(input.category);
      const name = input.name === undefined ? current.name : requiredText(input.name, "name", 256);
      const description = input.description === undefined ? current.description : optionalText(input.description, "description", 20_000);
      const aliases = normalizedTextList([...aliasesForAsset(db, input.assetId), name, ...(input.aliases ?? [])], "aliases");
      const identityFeatures = input.identityFeatures === undefined
        ? currentDefinition.identityFeatures
        : normalizedTextList(input.identityFeatures, "identityFeatures");
      const positiveLocks = input.positiveLocks === undefined
        ? currentDefinition.positiveLocks
        : normalizedTextList(input.positiveLocks, "positiveLocks");
      const negativeLocks = input.negativeLocks === undefined
        ? currentDefinition.negativeLocks
        : normalizedTextList(input.negativeLocks, "negativeLocks");
      const defaultPrompt = input.defaultPrompt === undefined
        ? currentDefinition.defaultPrompt
        : optionalText(input.defaultPrompt, "defaultPrompt", 40_000);
      const applicability = input.applicability === undefined
        ? currentDefinition.applicability
        : normalizeApplicability(input.applicability);
      const now = new Date().toISOString();
      const result = db.prepare(`
        UPDATE studio_canonical_assets
        SET category = ?, name = ?, description = ?, applicability_json = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(category, name, description, stableJson(applicability), now, input.assetId, input.expectedRevision);
      if (Number(result.changes) !== 1) {
        const latest = getAssetRow(db, input.assetId);
        throw new MaterialStudioConflictError(input.expectedRevision, Number(latest?.revision ?? -1));
      }
      addAliases(db, input.assetId, aliases, now);
      appendDefinitionSnapshot(db, {
        assetId: input.assetId,
        assetRevision: input.expectedRevision + 1,
        category,
        name,
        description,
        aliases,
        identityFeatures,
        positiveLocks,
        negativeLocks,
        defaultPrompt,
        applicability,
        createdAt: now,
      });
      syncStudioIdentityIndexForAsset(db, input.assetId);
    });
    return detailFromDatabase(db, input.assetId);
  } finally {
    db.close();
  }
}

function normalizeAppendArguments(
  assetIdOrInput: string | AppendStudioAssetVersionInput,
  mediaSha256?: string,
  reviewStatus?: StudioReviewStatus,
  expectedRevision?: number,
): AppendStudioAssetVersionInput {
  if (typeof assetIdOrInput !== "string") {
    return {
      ...assetIdOrInput,
      reviewStatus: normalizeInitialReviewStatus((assetIdOrInput as { reviewStatus?: unknown }).reviewStatus),
    };
  }
  if (!mediaSha256 || !reviewStatus || expectedRevision === undefined) throw new Error("缺少版本媒体、审核状态或 expectedRevision。");
  return { assetId: assetIdOrInput, mediaSha256, reviewStatus: normalizeInitialReviewStatus(reviewStatus), expectedRevision };
}

function normalizeInitialReviewStatus(status: unknown): "pending" {
  if (status !== "pending") {
    throw new Error("新资产版本只能创建为 pending；approved/rejected 必须通过 review_studio_asset_version 生成不可变审核记录。");
  }
  return status;
}

export function appendStudioAssetVersion(projectRoot: string, input: AppendStudioAssetVersionInput): Promise<AppendStudioAssetVersionResult>;
export function appendStudioAssetVersion(projectRoot: string, assetId: string, mediaSha256: string, reviewStatus: "pending", expectedRevision: number): Promise<AppendStudioAssetVersionResult>;
export async function appendStudioAssetVersion(
  projectRoot: string,
  assetIdOrInput: string | AppendStudioAssetVersionInput,
  mediaSha256?: string,
  reviewStatus?: StudioReviewStatus,
  expectedRevision?: number,
): Promise<AppendStudioAssetVersionResult> {
  const input = normalizeAppendArguments(assetIdOrInput, mediaSha256, reviewStatus, expectedRevision);
  assertExpectedRevision(input.expectedRevision, false);
  const sha256 = normalizeSha256(input.mediaSha256, "mediaSha256");
  const status = normalizeInitialReviewStatus(input.reviewStatus);
  const sourceNote = optionalText(input.sourceNote, "version source note", 4_000);
  const paths = await ensureStudioDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    return runTransaction(db, () => {
      const asset = getAssetRow(db, input.assetId);
      if (!asset) throw new Error(`素材资产不存在：${input.assetId}`);
      if (Number(asset.revision) !== input.expectedRevision) {
        throw new MaterialStudioConflictError(input.expectedRevision, Number(asset.revision));
      }
      const media = db.prepare("SELECT kind FROM studio_media WHERE sha256 = ?").get(sha256) as { kind: StudioMediaKind } | undefined;
      if (!media) throw new Error(`素材媒体不存在：${sha256}`);
      if (media.kind !== "image") {
        throw new Error(`规范资产参考版本只接受 image；${media.kind} 可保存在媒体库，但不能成为人物、场景、道具或风格权威。`);
      }
      const ordinal = Number((db.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM studio_asset_versions WHERE asset_id = ?").get(input.assetId) as { ordinal: number }).ordinal);
      const now = new Date().toISOString();
      const id = `version-${randomUUID()}`;
      db.prepare(`
        INSERT INTO studio_asset_versions(id, asset_id, ordinal, media_sha256, review_status, source_note, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.assetId, ordinal, sha256, status, sourceNote, now);
      const updated = db.prepare("UPDATE studio_canonical_assets SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?")
        .run(now, input.assetId, input.expectedRevision);
      if (Number(updated.changes) !== 1) {
        const latest = getAssetRow(db, input.assetId);
        throw new MaterialStudioConflictError(input.expectedRevision, Number(latest?.revision ?? -1));
      }
      const revision = Number((db.prepare("SELECT revision FROM studio_canonical_assets WHERE id = ?").get(input.assetId) as { revision: number }).revision);
      return {
        version: { id, assetId: input.assetId, ordinal, mediaSha256: sha256, reviewStatus: status, sourceNote, createdAt: now },
        assetRevision: revision,
      };
    });
  } finally {
    db.close();
  }
}

export async function reviewStudioAssetVersion(
  projectRoot: string,
  input: ReviewStudioAssetVersionInput,
): Promise<StudioCanonicalAssetDetail> {
  assertExpectedRevision(input.expectedRevision, false);
  const note = requiredText(input.note, "review note", 4_000);
  if (input.decision !== "approved" && input.decision !== "rejected") {
    throw new Error("review decision 必须是 approved 或 rejected。");
  }
  const paths = await ensureStudioDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    runTransaction(db, () => {
      const asset = getAssetRow(db, input.assetId);
      if (!asset) throw new Error(`素材资产不存在：${input.assetId}`);
      if (Number(asset.revision) !== input.expectedRevision) {
        throw new MaterialStudioConflictError(input.expectedRevision, Number(asset.revision));
      }
      const version = db.prepare(`
        SELECT version.asset_id, version.review_status, review.to_status AS reviewed_status
        FROM studio_asset_versions version
        LEFT JOIN studio_version_reviews review ON review.version_id = version.id
        WHERE version.id = ?
      `).get(input.versionId) as {
        asset_id: string;
        review_status: StudioReviewStatus;
        reviewed_status: StudioReviewStatus | null;
      } | undefined;
      if (!version || version.asset_id !== input.assetId) throw new Error("审核版本不属于目标资产。");
      const currentStatus = version.reviewed_status ?? version.review_status;
      if (currentStatus !== "pending") throw new Error(`版本已处于 ${currentStatus}，审核决定不可覆盖。`);
      const now = new Date().toISOString();
      const nextRevision = input.expectedRevision + 1;
      const updated = db.prepare("UPDATE studio_canonical_assets SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?")
        .run(now, input.assetId, input.expectedRevision);
      if (Number(updated.changes) !== 1) {
        const latest = getAssetRow(db, input.assetId);
        throw new MaterialStudioConflictError(input.expectedRevision, Number(latest?.revision ?? -1));
      }
      db.prepare(`
        INSERT INTO studio_version_reviews(
          id, asset_id, version_id, from_status, to_status, asset_revision, note, created_at
        ) VALUES(?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(`review-${randomUUID()}`, input.assetId, input.versionId, input.decision, nextRevision, note, now);
    });
    return detailFromDatabase(db, input.assetId);
  } finally {
    db.close();
  }
}

function normalizeAuthorityArguments(
  assetIdOrInput: string | SetStudioPrimaryAuthorityInput,
  versionId?: string,
  expectedRevision?: number,
): SetStudioPrimaryAuthorityInput {
  if (typeof assetIdOrInput !== "string") return assetIdOrInput;
  if (!versionId || expectedRevision === undefined) throw new Error("缺少主权威版本或 expectedRevision。");
  return { assetId: assetIdOrInput, versionId, expectedRevision };
}

export function setStudioPrimaryAuthority(projectRoot: string, input: SetStudioPrimaryAuthorityInput): Promise<StudioCanonicalAssetDetail>;
export function setStudioPrimaryAuthority(projectRoot: string, assetId: string, versionId: string, expectedRevision: number): Promise<StudioCanonicalAssetDetail>;
export async function setStudioPrimaryAuthority(
  projectRoot: string,
  assetIdOrInput: string | SetStudioPrimaryAuthorityInput,
  versionId?: string,
  expectedRevision?: number,
): Promise<StudioCanonicalAssetDetail> {
  const input = normalizeAuthorityArguments(assetIdOrInput, versionId, expectedRevision);
  assertExpectedRevision(input.expectedRevision, false);
  const paths = await ensureStudioDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    runTransaction(db, () => {
      const asset = getAssetRow(db, input.assetId);
      // 纯前置拒绝走 RejectedCommandFailure：账本只落 failed、不毒化幂等键，
      // MCP 面按 reason 映射确定性错误码（而非 OUTCOME_UNKNOWN）。
      if (!asset) {
        throw new RejectedCommandFailure(`素材资产不存在：${input.assetId}`, {
          schemaVersion: 1, applied: false, reason: "not_found", assetId: input.assetId,
        });
      }
      if (Number(asset.revision) !== input.expectedRevision) throw new MaterialStudioConflictError(input.expectedRevision, Number(asset.revision));
      const version = db.prepare(`
        SELECT version.asset_id, version.review_status, review.to_status AS reviewed_status
        FROM studio_asset_versions version
        LEFT JOIN studio_version_reviews review ON review.version_id = version.id
        WHERE version.id = ?
      `).get(input.versionId) as {
        asset_id: string;
        review_status: StudioReviewStatus;
        reviewed_status: StudioReviewStatus | null;
      } | undefined;
      if (!version || version.asset_id !== input.assetId) {
        throw new RejectedCommandFailure("主权威版本不属于目标资产。", {
          schemaVersion: 1, applied: false, reason: "validation_failed",
          assetId: input.assetId, versionId: input.versionId,
        });
      }
      const currentStatus = version.reviewed_status ?? version.review_status;
      if (currentStatus !== "approved") {
        throw new RejectedCommandFailure("只有 approved 版本可以提升为主权威。", {
          schemaVersion: 1, applied: false, reason: "control_conflict",
          assetId: input.assetId, versionId: input.versionId, currentStatus,
        });
      }
      const approvalReceipt = db.prepare(`
        SELECT id
        FROM studio_version_reviews
        WHERE asset_id = ? AND version_id = ? AND from_status = 'pending' AND to_status = 'approved'
        LIMIT 1
      `).get(input.assetId, input.versionId) as { id: string } | undefined;
      if (!approvalReceipt) {
        throw new RejectedCommandFailure("approved 版本缺少 pending→approved 不可变审核记录，禁止提升为主权威。", {
          schemaVersion: 1, applied: false, reason: "control_conflict",
          assetId: input.assetId, versionId: input.versionId,
        });
      }
      const now = new Date().toISOString();
      const note = optionalText(input.note, "authority note", 4_000);
      const nextRevision = input.expectedRevision + 1;
      const result = db.prepare(`
        UPDATE studio_canonical_assets
        SET primary_version_id = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(input.versionId, now, input.assetId, input.expectedRevision);
      if (Number(result.changes) !== 1) {
        const latest = getAssetRow(db, input.assetId);
        throw new MaterialStudioConflictError(input.expectedRevision, Number(latest?.revision ?? -1));
      }
      db.prepare(`
        INSERT INTO studio_authority_events(
          id, asset_id, version_id, previous_version_id, asset_revision, note, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(
        `authority-${randomUUID()}`,
        input.assetId,
        input.versionId,
        asset.primary_version_id,
        nextRevision,
        note,
        now,
      );
    });
    return detailFromDatabase(db, input.assetId);
  } finally {
    db.close();
  }
}

export async function listStudioCanonicalAssets(projectRoot: string, query: StudioCanonicalAssetListQuery = {}): Promise<StudioCanonicalAssetPage> {
  const paths = await ensureStudioDirectories(projectRoot);
  const limit = normalizeLimit(query.limit);
  const category = query.category === undefined ? undefined : normalizeCategory(query.category);
  const search = query.search?.normalize("NFKC").trim().toLocaleLowerCase("zh-CN") ?? "";
  if (search.length > 256) throw new Error("search 不能超过 256 个字符。");
  const like = `%${search.replace(/[\\%_]/gu, (value) => `\\${value}`)}%`;
  const scope = `asset:${category ?? "*"}:${createHash("sha256").update(search, "utf8").digest("hex").slice(0, 16)}`;
  const after = decodeCursor(query.cursor, scope);
  const db = openDatabase(paths.database);
  try {
    const rows = db.prepare(`
      SELECT a.*,
        pv.media_sha256 AS primary_media_sha256,
        pm.thumbnail_recipe_key AS primary_thumbnail_recipe_key,
        (SELECT COUNT(*) FROM studio_asset_versions v WHERE v.asset_id = a.id) AS version_count
      FROM studio_canonical_assets a
      LEFT JOIN studio_asset_versions pv ON pv.id = a.primary_version_id
      LEFT JOIN studio_media pm ON pm.sha256 = pv.media_sha256
      WHERE (? IS NULL OR a.id > ?)
        AND (? IS NULL OR a.category = ?)
        AND (
          ? = ''
          OR lower(a.name) LIKE ? ESCAPE '\\'
          OR lower(a.description) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(pv.media_sha256, '')) LIKE ? ESCAPE '\\'
          OR EXISTS (
            SELECT 1 FROM studio_asset_aliases aa
            WHERE aa.asset_id = a.id AND aa.normalized_alias LIKE ? ESCAPE '\\'
          )
        )
      ORDER BY a.id ASC
      LIMIT ?
    `).all(
      after ?? null,
      after ?? null,
      category ?? null,
      category ?? null,
      search,
      like,
      like,
      like,
      like,
      limit + 1,
    ) as unknown as AssetRow[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    return {
      items: selected.map((row) => summaryFromRow(db, row)),
      nextCursor: hasMore ? encodeCursor(scope, selected[selected.length - 1]!.id) : undefined,
    };
  } finally {
    db.close();
  }
}

function studioIdentityEntryFromRow(row: {
  id: string;
  normalized_key: string;
  asset_id: string;
  category: StudioCanonicalAssetCategory;
  canonical_name: string;
  match_kind: StudioIdentityMatchKind;
  matched_value: string;
}): StudioIdentityIndexEntry {
  return {
    id: row.id,
    normalizedKey: row.normalized_key,
    assetId: row.asset_id,
    category: row.category,
    canonicalName: row.canonical_name,
    matchKind: row.match_kind,
    matchedValue: row.matched_value,
  };
}

function studioIdentitySnapshotFingerprint(normalizedKeys: string[], entries: StudioIdentityIndexEntry[]): string {
  return createHash("sha256").update(stableJson({
    schemaVersion: 1,
    normalizedKeys,
    entries: entries.map((entry) => ({
      id: entry.id,
      normalizedKey: entry.normalizedKey,
      assetId: entry.assetId,
      category: entry.category,
      canonicalName: entry.canonicalName,
      matchKind: entry.matchKind,
      matchedValue: entry.matchedValue,
    })),
  }), "utf8").digest("hex");
}

/**
 * 为剧本解析读取完整精确键快照。这里只执行等值查询；不会调用 LIKE、substring、
 * 拼音、编辑距离或文件系统扫描。返回的 fingerprint 仅受这些身份键的候选集影响。
 */
export async function getStudioIdentityIndexSnapshot(
  projectRoot: string,
  identityValues: readonly string[],
): Promise<StudioIdentityIndexSnapshot> {
  if (identityValues.length > 256) throw new Error("单次精确身份快照最多 256 个键。");
  const normalizedKeys = [...new Set(identityValues.map((value) => normalizeStudioIdentityKey(value)))]
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
  const paths = await ensureStudioDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    if (normalizedKeys.length === 0) {
      return {
        schemaVersion: 1,
        kind: "studio-identity-index-snapshot",
        entries: [],
        normalizedKeys,
        fingerprint: studioIdentitySnapshotFingerprint(normalizedKeys, []),
      };
    }
    const rows = db.prepare(`
      SELECT id, normalized_key, asset_id, category, canonical_name, match_kind, matched_value
      FROM studio_asset_identity_keys
      WHERE normalized_key IN (${normalizedKeys.map(() => "?").join(", ")})
      ORDER BY normalized_key,
        CASE match_kind WHEN 'id' THEN 0 WHEN 'formal-name' THEN 1 ELSE 2 END,
        asset_id, matched_value
      LIMIT 10001
    `).all(...normalizedKeys) as Array<{
      id: string;
      normalized_key: string;
      asset_id: string;
      category: StudioCanonicalAssetCategory;
      canonical_name: string;
      match_kind: StudioIdentityMatchKind;
      matched_value: string;
    }>;
    if (rows.length > 10_000) throw new Error("精确身份候选超过 10000 项，拒绝截断；请先消解别名冲突。");
    const entries = rows.map(studioIdentityEntryFromRow);
    return {
      schemaVersion: 1,
      kind: "studio-identity-index-snapshot",
      entries,
      normalizedKeys,
      fingerprint: studioIdentitySnapshotFingerprint(normalizedKeys, entries),
    };
  } finally {
    db.close();
  }
}

/** 用于自动发现的轻量 keyset 页面；分页条目本身不是候选裁决。 */
export async function listStudioIdentityIndex(
  projectRoot: string,
  query: StudioIdentityIndexQuery = {},
): Promise<StudioIdentityIndexSnapshot> {
  const paths = await ensureStudioDirectories(projectRoot);
  const limit = normalizeLimit(query.limit);
  const normalizedKeys = query.normalizedKeys === undefined
    ? []
    : [...new Set(query.normalizedKeys.map((value) => normalizeStudioIdentityKey(value)))]
      .sort((left, right) => left.localeCompare(right, "zh-CN"));
  if (normalizedKeys.length > 100) throw new Error("分页身份索引最多过滤 100 个精确键。");
  const scope = `identity-index:${createHash("sha256").update(stableJson(normalizedKeys), "utf8").digest("hex").slice(0, 24)}`;
  const after = decodeCursor(query.cursor, scope);
  const db = openDatabase(paths.database);
  try {
    const keyClause = normalizedKeys.length > 0
      ? `AND normalized_key IN (${normalizedKeys.map(() => "?").join(", ")})`
      : "";
    const rows = db.prepare(`
      SELECT id, normalized_key, asset_id, category, canonical_name, match_kind, matched_value
      FROM studio_asset_identity_keys
      WHERE (? IS NULL OR id > ?)
      ${keyClause}
      ORDER BY id
      LIMIT ?
    `).all(
      after ?? null,
      after ?? null,
      ...normalizedKeys,
      limit + 1,
    ) as Array<{
      id: string;
      normalized_key: string;
      asset_id: string;
      category: StudioCanonicalAssetCategory;
      canonical_name: string;
      match_kind: StudioIdentityMatchKind;
      matched_value: string;
    }>;
    const selected = rows.slice(0, limit);
    const entries = selected.map(studioIdentityEntryFromRow);
    return {
      schemaVersion: 1,
      kind: "studio-identity-index-snapshot",
      entries,
      normalizedKeys,
      fingerprint: studioIdentitySnapshotFingerprint(normalizedKeys, entries),
      ...(rows.length > limit && selected.length > 0
        ? { nextCursor: encodeCursor(scope, selected[selected.length - 1]!.id) }
        : {}),
    };
  } finally {
    db.close();
  }
}

/**
 * 解析器专用的单快照读取：一次 SQLite 查询读取当前精确身份索引，且硬限 100000 行。
 * 不接入 MCP/UI，避免 30k aliases 因 100 条 UI 页面造成 300 次开库查询。
 */
export async function loadStudioIdentityIndexForAnalysis(
  projectRoot: string,
): Promise<StudioIdentityIndexSnapshot> {
  const paths = await ensureStudioDirectories(projectRoot);
  const maxRows = 100_000;
  const db = openDatabase(paths.database);
  try {
    const rows = db.prepare(`
      SELECT id, normalized_key, asset_id, category, canonical_name, match_kind, matched_value
      FROM studio_asset_identity_keys
      ORDER BY id
      LIMIT ?
    `).all(maxRows + 1) as Array<{
      id: string;
      normalized_key: string;
      asset_id: string;
      category: StudioCanonicalAssetCategory;
      canonical_name: string;
      match_kind: StudioIdentityMatchKind;
      matched_value: string;
    }>;
    if (rows.length > maxRows) throw new Error(`身份索引超过 ${maxRows} 项解析上限，拒绝截断。`);
    const entries = rows.map(studioIdentityEntryFromRow);
    return {
      schemaVersion: 1,
      kind: "studio-identity-index-snapshot",
      entries,
      normalizedKeys: [],
      fingerprint: studioIdentitySnapshotFingerprint([], entries),
    };
  } finally {
    db.close();
  }
}

export async function getStudioCanonicalAsset(projectRoot: string, assetId: string): Promise<StudioCanonicalAssetDetail | null> {
  const paths = await ensureStudioDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    if (!getAssetRow(db, assetId)) return null;
    return detailFromDatabase(db, assetId);
  } finally {
    db.close();
  }
}

function normalizeRelationKind(kind: string): StudioAssetRelationKind {
  if (kind !== "derived_from" && kind !== "variant_of" && kind !== "reference_of" && kind !== "composite_member") {
    throw new Error("资产关系 kind 必须是 derived_from、variant_of、reference_of 或 composite_member。");
  }
  return kind;
}

function normalizeExistingAssetId(value: string, field: string): string {
  const id = requiredText(value, field, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) throw new Error(`${field} 格式无效。`);
  return id;
}

function normalizeRelationId(value: string | undefined): string {
  const id = value?.trim() || `relation-${randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(id)) throw new Error("资产关系 id 格式无效。");
  return id;
}

function normalizeExistingRelationId(value: string): string {
  if (!value.trim()) throw new Error("资产关系 id 不能为空。");
  return normalizeRelationId(value);
}

function endpointSnapshotFromRow(
  db: DatabaseSync,
  row: AssetRow,
  assetRevision = Number(row.revision),
): StudioAssetRelationEndpointSnapshot {
  const definition = db.prepare("SELECT id FROM studio_asset_definitions WHERE asset_id = ? ORDER BY ordinal DESC LIMIT 1")
    .get(row.id) as { id: string } | undefined;
  if (!definition) throw new Error(`素材资产缺少不可变定义版本：${row.id}`);
  if ((row.primary_version_id === null) !== (row.primary_media_sha256 === null)) {
    throw new Error(`素材资产 ${row.id} 的权威版本投影已损坏。`);
  }
  return {
    assetId: row.id,
    category: row.category,
    assetRevision,
    definitionVersionId: definition.id,
    ...(row.primary_version_id && row.primary_media_sha256 ? {
      authorityVersionId: row.primary_version_id,
      authorityMediaSha256: row.primary_media_sha256,
    } : {}),
  };
}

const RELATION_PROJECTION = `
  relation.*,
  CASE WHEN head.relation_id IS NULL THEN 0 ELSE 1 END AS is_head,
  child.id AS superseded_by_relation_id
`;

function relationRowById(db: DatabaseSync, relationId: string): AssetRelationRow | undefined {
  return db.prepare(`
    SELECT ${RELATION_PROJECTION}
    FROM studio_asset_relations relation
    LEFT JOIN studio_asset_relation_heads head ON head.relation_id = relation.id
    LEFT JOIN studio_asset_relations child ON child.supersedes_relation_id = relation.id
    WHERE relation.id = ?
  `).get(relationId) as unknown as AssetRelationRow | undefined;
}

function relationFromRow(db: DatabaseSync, row: AssetRelationRow): StudioAssetRelation {
  const subject: StudioAssetRelationEndpointSnapshot = {
    assetId: row.subject_asset_id,
    category: row.subject_category,
    assetRevision: Number(row.subject_asset_revision),
    definitionVersionId: row.subject_definition_version_id,
    ...(row.subject_authority_version_id && row.subject_authority_media_sha256 ? {
      authorityVersionId: row.subject_authority_version_id,
      authorityMediaSha256: row.subject_authority_media_sha256,
    } : {}),
  };
  const object: StudioAssetRelationEndpointSnapshot = {
    assetId: row.object_asset_id,
    category: row.object_category,
    assetRevision: Number(row.object_asset_revision),
    definitionVersionId: row.object_definition_version_id,
    ...(row.object_authority_version_id && row.object_authority_media_sha256 ? {
      authorityVersionId: row.object_authority_version_id,
      authorityMediaSha256: row.object_authority_media_sha256,
    } : {}),
  };
  const relation: StudioAssetRelation = {
    id: row.id,
    seriesId: row.relation_series_id,
    revision: Number(row.relation_revision),
    ...(row.supersedes_relation_id ? { supersedesRelationId: row.supersedes_relation_id } : {}),
    ...(row.superseded_by_relation_id ? { supersededByRelationId: row.superseded_by_relation_id } : {}),
    head: Number(row.is_head) === 1,
    status: "superseded",
    kind: row.kind,
    subject,
    object,
    ...(row.ordinal === null ? {} : { ordinal: Number(row.ordinal) }),
    role: row.role,
    note: row.note,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
  };
  const expectedFingerprint = createHash("sha256").update(stableJson({
    ...existingRelationSemantic(relation),
    subject,
    object,
  }), "utf8").digest("hex");
  if (expectedFingerprint !== row.fingerprint) {
    throw new Error(`资产关系 ${row.id} 指纹漂移，拒绝读取。`);
  }
  const currentness = relationEndpointSemanticCurrentness(db, relation);
  return {
    ...relation,
    status: relation.head ? (currentness.semanticCurrent ? "current" : "stale") : "superseded",
  };
}

function relationsForAsset(db: DatabaseSync, assetId: string): StudioAssetRelation[] {
  return (db.prepare(`
    SELECT ${RELATION_PROJECTION}
    FROM studio_asset_relations relation
    LEFT JOIN studio_asset_relation_heads head ON head.relation_id = relation.id
    LEFT JOIN studio_asset_relations child ON child.supersedes_relation_id = relation.id
    WHERE relation.subject_asset_id = ? OR relation.object_asset_id = ?
    ORDER BY relation.relation_series_id ASC, relation.relation_revision ASC
  `).all(assetId, assetId) as unknown as AssetRelationRow[]).map((row) => relationFromRow(db, row));
}

function requestedRelationSemantic(input: {
  kind: StudioAssetRelationKind;
  subjectAssetId: string;
  objectAssetId: string;
  ordinal?: number;
  role: string;
  note: string;
}): Record<string, unknown> {
  return {
    kind: input.kind,
    subjectAssetId: input.subjectAssetId,
    objectAssetId: input.objectAssetId,
    ordinal: input.ordinal ?? null,
    role: input.role,
    note: input.note,
  };
}

function existingRelationSemantic(relation: StudioAssetRelation): Record<string, unknown> {
  return requestedRelationSemantic({
    kind: relation.kind,
    subjectAssetId: relation.subject.assetId,
    objectAssetId: relation.object.assetId,
    ordinal: relation.ordinal,
    role: relation.role,
    note: relation.note,
  });
}

function wouldCreateRelationCycle(db: DatabaseSync, subjectAssetId: string, objectAssetId: string): boolean {
  const row = db.prepare(`
    WITH RECURSIVE reachable(asset_id) AS (
      SELECT relation.object_asset_id
      FROM studio_asset_relation_heads head
      JOIN studio_asset_relations relation ON relation.id = head.relation_id
      WHERE relation.subject_asset_id = ?
      UNION
      SELECT relation.object_asset_id
      FROM studio_asset_relation_heads head
      JOIN studio_asset_relations relation ON relation.id = head.relation_id
      JOIN reachable ON relation.subject_asset_id = reachable.asset_id
    )
    SELECT 1 AS found FROM reachable WHERE asset_id = ? LIMIT 1
  `).get(objectAssetId, subjectAssetId) as { found: number } | undefined;
  return row?.found === 1;
}

export async function appendStudioAssetRelation(
  projectRoot: string,
  input: AppendStudioAssetRelationInput,
): Promise<StudioAssetRelation> {
  assertExpectedRevision(input.expectedSubjectRevision, false);
  assertExpectedRevision(input.expectedObjectRevision, false);
  const kind = normalizeRelationKind(input.kind);
  const subjectAssetId = normalizeExistingAssetId(input.subjectAssetId, "subjectAssetId");
  const objectAssetId = normalizeExistingAssetId(input.objectAssetId, "objectAssetId");
  if (subjectAssetId === objectAssetId) throw new Error("资产关系禁止自环。");
  const id = normalizeRelationId(input.id);
  const supersedesRelationId = input.supersedesRelationId === undefined
    ? undefined
    : normalizeExistingRelationId(input.supersedesRelationId);
  const role = optionalText(input.role, "relation role", 256);
  const note = optionalText(input.note, "relation note", 4_000);
  let ordinal: number | undefined;
  if (kind === "composite_member") {
    if (!Number.isInteger(input.ordinal) || input.ordinal! < 1 || input.ordinal! > 10_000) {
      throw new Error("composite_member 必须提供 1-10000 的 ordinal。");
    }
    ordinal = input.ordinal;
  } else if (input.ordinal !== undefined) {
    throw new Error("只有 composite_member 可以提供 ordinal。");
  }
  const requestedSemantic = requestedRelationSemantic({ kind, subjectAssetId, objectAssetId, ordinal, role, note });
  const paths = await ensureStudioDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    return runTransaction(db, () => {
      const sameId = relationRowById(db, id);
      if (sameId) {
        const existing = relationFromRow(db, sameId);
        const exactSemanticReplay = stableJson(existingRelationSemantic(existing)) === stableJson(requestedSemantic);
        const lineageReplay = existing.supersedesRelationId === supersedesRelationId;
        if (exactSemanticReplay && lineageReplay) return existing;
        throw new Error(`资产关系重复但语义不一致：${existing.id}；拒绝产生歧义。`);
      }

      let predecessor: StudioAssetRelation | undefined;
      if (supersedesRelationId) {
        const replayChildRow = db.prepare(`
          SELECT ${RELATION_PROJECTION}
          FROM studio_asset_relations relation
          LEFT JOIN studio_asset_relation_heads head ON head.relation_id = relation.id
          LEFT JOIN studio_asset_relations child ON child.supersedes_relation_id = relation.id
          WHERE relation.supersedes_relation_id = ?
        `).get(supersedesRelationId) as unknown as AssetRelationRow | undefined;
        if (replayChildRow) {
          const replayChild = relationFromRow(db, replayChildRow);
          const exactReplay = stableJson(existingRelationSemantic(replayChild)) === stableJson(requestedSemantic);
          const idCompatible = input.id === undefined || replayChild.id === id;
          if (exactReplay && idCompatible) return replayChild;
          throw new Error(`资产关系 ${supersedesRelationId} 已被不同语义或不同 id 的历史修订替代。`);
        }
        const predecessorRow = relationRowById(db, supersedesRelationId);
        if (!predecessorRow) throw new Error(`待重建的资产关系不存在：${supersedesRelationId}`);
        predecessor = relationFromRow(db, predecessorRow);
        if (!predecessor.head) {
          throw new Error(`资产关系 ${supersedesRelationId} 已被 ${predecessor.supersededByRelationId ?? "后续修订"} 替代。`);
        }
        if (stableJson(existingRelationSemantic(predecessor)) !== stableJson(requestedSemantic)) {
          throw new Error(`资产关系 ${supersedesRelationId} 重建语义不一致；只能刷新同端点同语义快照。`);
        }
        if (predecessor.status !== "stale") {
          throw new Error(`资产关系 ${supersedesRelationId} 当前未过期，无需重建。`);
        }
      } else {
        const currentHeadRow = db.prepare(`
          SELECT ${RELATION_PROJECTION}
          FROM studio_asset_relation_heads endpoint_head
          JOIN studio_asset_relations relation ON relation.id = endpoint_head.relation_id
          LEFT JOIN studio_asset_relation_heads head ON head.relation_id = relation.id
          LEFT JOIN studio_asset_relations child ON child.supersedes_relation_id = relation.id
          WHERE endpoint_head.subject_asset_id = ? AND endpoint_head.object_asset_id = ?
        `).get(subjectAssetId, objectAssetId) as unknown as AssetRelationRow | undefined;
        if (currentHeadRow) {
          const existing = relationFromRow(db, currentHeadRow);
          const exactSemanticReplay = stableJson(existingRelationSemantic(existing)) === stableJson(requestedSemantic);
          const idCompatible = input.id === undefined || existing.id === id;
          if (exactSemanticReplay && idCompatible) return existing;
          throw new Error(`资产关系重复但语义不一致：${existing.id}；拒绝产生歧义。`);
        }
      }

      const subject = getAssetRow(db, subjectAssetId);
      const object = getAssetRow(db, objectAssetId);
      if (!subject) throw new Error(`关系 subject 资产不存在：${subjectAssetId}`);
      if (!object) throw new Error(`关系 object 资产不存在：${objectAssetId}`);
      if (Number(subject.revision) !== input.expectedSubjectRevision) {
        throw new MaterialStudioConflictError(input.expectedSubjectRevision, Number(subject.revision));
      }
      if (Number(object.revision) !== input.expectedObjectRevision) {
        throw new MaterialStudioConflictError(input.expectedObjectRevision, Number(object.revision));
      }
      if (kind === "composite_member") {
        const occupied = db.prepare(`
          SELECT relation_id AS id FROM studio_asset_relation_heads
          WHERE kind = 'composite_member' AND object_asset_id = ? AND ordinal = ?
        `).get(objectAssetId, ordinal!) as { id: string } | undefined;
        if (occupied && occupied.id !== supersedesRelationId) {
          throw new Error(`组合资产 ${objectAssetId} 的成员序号 ${ordinal} 已由 ${occupied.id} 占用。`);
        }
      }
      if (!predecessor && wouldCreateRelationCycle(db, subjectAssetId, objectAssetId)) {
        throw new Error("资产关系会形成循环，拒绝追加。 ");
      }
      const now = new Date().toISOString();
      const subjectRevision = input.expectedSubjectRevision + 1;
      const objectRevision = input.expectedObjectRevision + 1;
      const subjectUpdated = db.prepare(`
        UPDATE studio_canonical_assets SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(now, subjectAssetId, input.expectedSubjectRevision);
      const objectUpdated = db.prepare(`
        UPDATE studio_canonical_assets SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(now, objectAssetId, input.expectedObjectRevision);
      if (Number(subjectUpdated.changes) !== 1 || Number(objectUpdated.changes) !== 1) {
        throw new Error("资产关系端点 revision 在事务中漂移，拒绝追加。");
      }
      const subjectSnapshot = endpointSnapshotFromRow(db, getAssetRow(db, subjectAssetId)!, subjectRevision);
      const objectSnapshot = endpointSnapshotFromRow(db, getAssetRow(db, objectAssetId)!, objectRevision);
      const fingerprint = createHash("sha256").update(stableJson({
        ...requestedSemantic,
        subject: subjectSnapshot,
        object: objectSnapshot,
      }), "utf8").digest("hex");
      db.prepare(`
        INSERT INTO studio_asset_relations(
          id, relation_series_id, relation_revision, supersedes_relation_id,
          kind, subject_asset_id, object_asset_id, subject_category, object_category,
          subject_asset_revision, object_asset_revision,
          subject_definition_version_id, object_definition_version_id,
          subject_authority_version_id, object_authority_version_id,
          subject_authority_media_sha256, object_authority_media_sha256,
          ordinal, role, note, fingerprint, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        predecessor?.seriesId ?? id,
        predecessor ? predecessor.revision + 1 : 1,
        predecessor?.id ?? null,
        kind,
        subjectAssetId,
        objectAssetId,
        subjectSnapshot.category,
        objectSnapshot.category,
        subjectSnapshot.assetRevision,
        objectSnapshot.assetRevision,
        subjectSnapshot.definitionVersionId,
        objectSnapshot.definitionVersionId,
        subjectSnapshot.authorityVersionId ?? null,
        objectSnapshot.authorityVersionId ?? null,
        subjectSnapshot.authorityMediaSha256 ?? null,
        objectSnapshot.authorityMediaSha256 ?? null,
        ordinal ?? null,
        role,
        note,
        fingerprint,
        now,
      );
      if (predecessor) {
        const updated = db.prepare(`
          UPDATE studio_asset_relation_heads
          SET relation_id = ?, subject_asset_id = ?, object_asset_id = ?, kind = ?, ordinal = ?
          WHERE relation_id = ?
        `).run(id, subjectAssetId, objectAssetId, kind, ordinal ?? null, predecessor.id);
        if (Number(updated.changes) !== 1) throw new Error("资产关系 current head 在重建事务中漂移，拒绝追加。");
      } else {
        db.prepare(`
          INSERT INTO studio_asset_relation_heads(relation_id, subject_asset_id, object_asset_id, kind, ordinal)
          VALUES(?, ?, ?, ?, ?)
        `).run(id, subjectAssetId, objectAssetId, kind, ordinal ?? null);
      }
      return relationFromRow(db, relationRowById(db, id)!);
    });
  } finally {
    db.close();
  }
}

export async function listStudioAssetRelations(
  projectRoot: string,
  query: StudioAssetRelationListQuery = {},
): Promise<StudioAssetRelationPage> {
  const paths = await ensureStudioDirectories(projectRoot);
  const limit = normalizeLimit(query.limit);
  const kind = query.kind === undefined ? undefined : normalizeRelationKind(query.kind);
  const assetId = query.assetId === undefined ? undefined : normalizeExistingAssetId(query.assetId, "assetId");
  const subjectAssetId = query.subjectAssetId === undefined ? undefined : normalizeExistingAssetId(query.subjectAssetId, "subjectAssetId");
  const objectAssetId = query.objectAssetId === undefined ? undefined : normalizeExistingAssetId(query.objectAssetId, "objectAssetId");
  const scope = `asset-relation:${kind ?? "*"}:${assetId ?? "*"}:${subjectAssetId ?? "*"}:${objectAssetId ?? "*"}`;
  const after = decodeCursor(query.cursor, scope);
  const db = openDatabase(paths.database);
  try {
    const rows = db.prepare(`
      SELECT ${RELATION_PROJECTION}
      FROM studio_asset_relations relation
      LEFT JOIN studio_asset_relation_heads head ON head.relation_id = relation.id
      LEFT JOIN studio_asset_relations child ON child.supersedes_relation_id = relation.id
      WHERE (? IS NULL OR relation.id > ?)
        AND (? IS NULL OR relation.kind = ?)
        AND (? IS NULL OR relation.subject_asset_id = ? OR relation.object_asset_id = ?)
        AND (? IS NULL OR relation.subject_asset_id = ?)
        AND (? IS NULL OR relation.object_asset_id = ?)
      ORDER BY relation.id ASC
      LIMIT ?
    `).all(
      after ?? null, after ?? null,
      kind ?? null, kind ?? null,
      assetId ?? null, assetId ?? null, assetId ?? null,
      subjectAssetId ?? null, subjectAssetId ?? null,
      objectAssetId ?? null, objectAssetId ?? null,
      limit + 1,
    ) as unknown as AssetRelationRow[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    return {
      items: selected.map((row) => relationFromRow(db, row)),
      nextCursor: hasMore ? encodeCursor(scope, selected[selected.length - 1]!.id) : undefined,
    };
  } finally {
    db.close();
  }
}

function endpointCurrentness(
  snapshot: StudioAssetRelationEndpointSnapshot,
  current: StudioAssetRelationEndpointSnapshot,
): StudioAssetRelationEndpointCurrentness {
  const revisionCurrent = snapshot.assetRevision === current.assetRevision;
  const definitionCurrent = snapshot.category === current.category
    && snapshot.definitionVersionId === current.definitionVersionId;
  const authorityCurrent = snapshot.authorityVersionId === current.authorityVersionId
    && snapshot.authorityMediaSha256 === current.authorityMediaSha256;
  return {
    snapshot,
    current,
    revisionCurrent,
    definitionCurrent,
    authorityCurrent,
    semanticCurrent: definitionCurrent && authorityCurrent,
  };
}

function relationEndpointSemanticCurrentness(
  db: DatabaseSync,
  relation: StudioAssetRelation,
): { semanticCurrent: boolean; subject: StudioAssetRelationEndpointCurrentness; object: StudioAssetRelationEndpointCurrentness } {
  const currentSubjectRow = getAssetRow(db, relation.subject.assetId);
  const currentObjectRow = getAssetRow(db, relation.object.assetId);
  if (!currentSubjectRow || !currentObjectRow) throw new Error("资产关系端点不存在，素材库外键事实已损坏。");
  const subject = endpointCurrentness(relation.subject, endpointSnapshotFromRow(db, currentSubjectRow));
  const object = endpointCurrentness(relation.object, endpointSnapshotFromRow(db, currentObjectRow));
  return { semanticCurrent: subject.semanticCurrent && object.semanticCurrent, subject, object };
}

function relationCurrentnessFromDatabase(db: DatabaseSync, relation: StudioAssetRelation): StudioAssetRelationCurrentness {
  const { semanticCurrent, subject, object } = relationEndpointSemanticCurrentness(db, relation);
  return {
    relation,
    head: relation.head,
    semanticCurrent,
    current: relation.head && semanticCurrent,
    subject,
    object,
  };
}

export async function getStudioAssetRelationCurrentness(
  projectRoot: string,
  relationId: string,
): Promise<StudioAssetRelationCurrentness | null> {
  const id = normalizeExistingRelationId(relationId);
  const paths = await ensureStudioDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    const row = relationRowById(db, id);
    if (!row) return null;
    const relation = relationFromRow(db, row);
    return relationCurrentnessFromDatabase(db, relation);
  } finally {
    db.close();
  }
}

/**
 * 为 generation freeze 提供单个规范资产的完整、可哈希知识快照。
 * 快照包含适用范围判断、权威身份以及所有追加式关系的当时/当前语义身份。
 */
export async function getStudioCanonicalAssetKnowledgeSnapshot(
  projectRoot: string,
  assetId: string,
  target?: StudioAssetApplicabilityTarget,
): Promise<StudioCanonicalAssetKnowledgeSnapshot | null> {
  const normalizedAssetId = normalizeExistingAssetId(assetId, "assetId");
  const paths = await ensureStudioDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    // P2-1（core F4）：快照读取包读事务——多语句共享同一 SQLite 快照，
    // 防双进程下 revision 与 definition/relations 混入两个版本状态。
    db.exec("BEGIN");
    const row = getAssetRow(db, normalizedAssetId);
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    const definitionRow = db.prepare("SELECT * FROM studio_asset_definitions WHERE asset_id = ? ORDER BY ordinal DESC LIMIT 1")
      .get(normalizedAssetId) as unknown as DefinitionRow | undefined;
    if (!definitionRow) throw new Error(`素材资产缺少不可变定义版本：${normalizedAssetId}`);
    const definition = definitionFromRow(definitionRow);
    const endpoint = endpointSnapshotFromRow(db, row);
    const relations = relationsForAsset(db, normalizedAssetId).map((relation) => relationCurrentnessFromDatabase(db, relation));
    const applicabilityEvaluation = target === undefined
      ? undefined
      : evaluateStudioAssetApplicability(definition.applicability, target);
    const semantic = {
      assetId: normalizedAssetId,
      category: row.category,
      assetRevision: Number(row.revision),
      definitionVersionId: definition.id,
      authorityVersionId: endpoint.authorityVersionId ?? null,
      authorityMediaSha256: endpoint.authorityMediaSha256 ?? null,
      applicability: definition.applicability,
      applicabilityEvaluation: applicabilityEvaluation ?? null,
      relations: relations.map((entry) => ({
        id: entry.relation.id,
        fingerprint: entry.relation.fingerprint,
        current: entry.current,
        subjectSemanticCurrent: entry.subject.semanticCurrent,
        objectSemanticCurrent: entry.object.semanticCurrent,
      })),
    };
    const result = {
      assetId: normalizedAssetId,
      category: row.category,
      assetRevision: Number(row.revision),
      definitionVersionId: definition.id,
      ...(endpoint.authorityVersionId && endpoint.authorityMediaSha256 ? {
        authorityVersionId: endpoint.authorityVersionId,
        authorityMediaSha256: endpoint.authorityMediaSha256,
      } : {}),
      applicability: definition.applicability,
      ...(applicabilityEvaluation ? { applicabilityEvaluation } : {}),
      relations,
      fingerprint: createHash("sha256").update(stableJson(semantic), "utf8").digest("hex"),
    };
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 未在事务中时忽略。
    }
    throw error;
  } finally {
    db.close();
  }
}

/**
 * 仅供机械验收读取冻结缩略图配方；不包含任何媒体字节。
 */
export function getMaterialStudioThumbnailRecipe(): typeof THUMBNAIL_RECIPE {
  return THUMBNAIL_RECIPE;
}

/**
 * 用于崩溃恢复验收：确认记录指向的 CAS 文件仍是预期内容。普通列表不会执行该 I/O。
 */
export async function verifyStudioMediaObject(projectRoot: string, sha256: string): Promise<boolean> {
  const normalized = normalizeSha256(sha256);
  const paths = await ensureStudioDirectories(projectRoot);
  const db = openDatabase(paths.database);
  let row: { object_relpath: string; size_bytes: number } | undefined;
  try {
    row = db.prepare("SELECT object_relpath, size_bytes FROM studio_media WHERE sha256 = ?").get(normalized) as typeof row;
  } finally {
    db.close();
  }
  if (!row) return false;
  try {
    const actual = await sha256File(fromProjectRelative(paths.root, row.object_relpath));
    return actual.sha256 === normalized && actual.sizeBytes === Number(row.size_bytes);
  } catch {
    return false;
  }
}
