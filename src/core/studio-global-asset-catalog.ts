import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { inspectManagedProjectReadOnly } from "./managed-project.js";
import type { StudioCanonicalAssetCategory } from "./material-studio.js";
import {
  getProjectRegistryPath,
  listRegisteredProjects,
} from "./sidecar.js";
import {
  buildGlobalStudioImageResourceProjectItems,
  finalizeGlobalStudioImageResourceSnapshotProjection,
  getGlobalStudioImageResourceFromSnapshot,
  globalStudioImageResourceTablesExist,
  listGlobalStudioImageResourcesFromSnapshot,
  type GlobalStudioImageResourceItem,
  type GlobalStudioImageResourcePage,
  type GlobalStudioImageResourceQuery,
  type GlobalStudioImageResourceSnapshotItem,
  type GlobalStudioImageResourceSnapshotProjection,
} from "./studio-global-image-resource-projection.js";

const DEFAULT_PAGE_LIMIT = 36;
const MAX_PAGE_LIMIT = 36;
const MAX_REGISTERED_PROJECTS = 200;
const MAX_CATALOG_SNAPSHOT_BUILD_ATTEMPTS = 3;
const DATABASE_RELATIVE_PATH = ".aicanvas/material-studio.sqlite";

export interface GlobalStudioAssetCatalogCounts {
  total: number;
  character: number;
  scene: number;
  prop: number;
  style: number;
}

export interface GlobalStudioAssetImageCoverage {
  totalImages: number;
  assetVersionImages: number;
  ordinaryImages: number;
}

export interface GlobalStudioAssetCatalogProject {
  id: string;
  name: string;
  primaryRoot: string;
  updatedAt: string;
}

export interface GlobalStudioAssetCatalogItem {
  sourceProject: GlobalStudioAssetCatalogProject;
  assetId: string;
  category: StudioCanonicalAssetCategory;
  name: string;
  description: string;
  aliases: string[];
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

export interface GlobalStudioAssetCatalogQuery {
  category: StudioCanonicalAssetCategory;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface GlobalStudioAssetCatalogPage {
  items: GlobalStudioAssetCatalogItem[];
  nextCursor?: string;
  total: number;
  counts: GlobalStudioAssetCatalogCounts;
  imageCoverage: GlobalStudioAssetImageCoverage;
  registeredProjectCount: number;
  readableProjectCount: number;
  unavailableProjects: Array<{
    id: string;
    name: string;
    reason: "not-managed" | "material-database-invalid";
  }>;
  registryFingerprint: string;
}

export type GlobalStudioAssetResourceReviewStatus = "pending" | "approved" | "rejected";

export interface GlobalStudioAssetResourceAssociation {
  assetId: string;
  category: StudioCanonicalAssetCategory;
  name: string;
  description: string;
  assetRevision: number;
  versionId: string;
  versionOrdinal: number;
  reviewStatus: GlobalStudioAssetResourceReviewStatus;
  isPrimary: boolean;
  sourceNote: string;
  createdAt: string;
}

/**
 * 一张实际图片在一个来源工程内只出现一次；若同一 SHA 被多个资产或多个版本引用，
 * associations 会完整保留所有名称、版本号、Review 与 Primary 关系。
 */
export interface GlobalStudioAssetResourceImageItem {
  sourceProject: GlobalStudioAssetCatalogProject;
  category: StudioCanonicalAssetCategory;
  mediaSha256: string;
  sourceBasename: string;
  mimeType: string;
  sizeBytes: number;
  thumbnailRecipeKey: string;
  associations: GlobalStudioAssetResourceAssociation[];
  createdAt: string;
  updatedAt: string;
}

export interface GlobalStudioAssetResourceImageQuery {
  category: StudioCanonicalAssetCategory;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface GlobalStudioAssetResourceImagePage {
  items: GlobalStudioAssetResourceImageItem[];
  nextCursor?: string;
  total: number;
  /** 规范资产实体数，保留上一层身份统计。 */
  assetCounts: GlobalStudioAssetCatalogCounts;
  /** 按“来源工程 + 图片 SHA”去重后的剧本资源图片数。 */
  resourceCounts: GlobalStudioAssetCatalogCounts;
  imageCoverage: GlobalStudioAssetImageCoverage;
  registeredProjectCount: number;
  readableProjectCount: number;
  unavailableProjects: GlobalStudioAssetCatalogPage["unavailableProjects"];
  registryFingerprint: string;
}

export type GlobalStudioMediaResourceKind = "audio" | "video";

export interface GlobalStudioMediaResourceCounts {
  total: number;
  audio: number;
  video: number;
}

export interface GlobalStudioMediaResourcePreviewCoverage {
  videoPosterReady: number;
  videoProxyReady: number;
  audioWaveformReady: number;
}

export interface GlobalStudioMediaResourceItem {
  sourceProject: GlobalStudioAssetCatalogProject;
  mediaSha256: string;
  kind: GlobalStudioMediaResourceKind;
  sourceBasename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  preview?: {
    kind: "video_poster" | "audio_waveform";
    recipeKey: string;
  };
  playback?: {
    kind: "video_proxy";
    recipeKey: string;
  };
}

export interface GlobalStudioMediaResourceQuery {
  kind: GlobalStudioMediaResourceKind;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface GlobalStudioMediaResourcePage {
  items: GlobalStudioMediaResourceItem[];
  nextCursor?: string;
  total: number;
  counts: GlobalStudioMediaResourceCounts;
  previewCoverage: GlobalStudioMediaResourcePreviewCoverage;
  registeredProjectCount: number;
  readableProjectCount: number;
  unavailableProjects: GlobalStudioAssetCatalogPage["unavailableProjects"];
  registryFingerprint: string;
}

interface CatalogCursor {
  v: 1;
  scope: string;
  projectKey: string;
  assetId: string;
}

interface ResourceCursor {
  v: 1;
  scope: string;
  projectKey: string;
  mediaSha256: string;
}

interface MediaResourceCursor {
  v: 1;
  scope: string;
  projectKey: string;
  mediaSha256: string;
}

interface CatalogAssetRow {
  id: string;
  category: StudioCanonicalAssetCategory;
  name: string;
  description: string;
  revision: number;
  primary_version_id: string | null;
  primary_media_sha256: string | null;
  primary_thumbnail_recipe_key: string | null;
  version_count: number;
  created_at: string;
  updated_at: string;
}

interface CatalogResourceImageRow {
  media_sha256: string;
  source_basename: string;
  mime_type: string;
  size_bytes: number | bigint;
  thumbnail_recipe_key: string;
  media_created_at: string;
  updated_at: string;
}

interface CatalogResourceAssociationRow {
  asset_id: string;
  category: StudioCanonicalAssetCategory;
  name: string;
  description: string;
  asset_revision: number | bigint;
  version_id: string;
  version_ordinal: number | bigint;
  review_status: GlobalStudioAssetResourceReviewStatus;
  is_primary: number | bigint;
  source_note: string;
  created_at: string;
}

interface CatalogMediaResourceRow {
  media_sha256: string;
  kind: GlobalStudioMediaResourceKind;
  source_basename: string;
  mime_type: string;
  size_bytes: number | bigint;
  created_at: string;
  video_poster_recipe_key: string | null;
  video_proxy_recipe_key: string | null;
  audio_waveform_recipe_key: string | null;
}

interface RegisteredProject {
  id: string;
  name: string;
  primaryRoot: string;
  updatedAt: string;
  projectKey: string;
}

interface AssetSnapshotItem extends GlobalStudioAssetCatalogItem {
  projectKey: string;
}

interface ResourceImageSnapshotItem extends GlobalStudioAssetResourceImageItem {
  projectKey: string;
  /** 仅供内存过滤；不通过 IPC 暴露。 */
  searchText: string;
}

interface MediaSnapshotItem extends GlobalStudioMediaResourceItem {
  projectKey: string;
}

interface MediaCatalogFileIdentity {
  path: string;
  kind: "absent" | "file" | "directory" | "symlink" | "other";
  dev?: string;
  ino?: string;
  mode?: string;
  nlink?: string;
  size?: string;
  mtimeNs?: string;
  ctimeNs?: string;
}

interface MediaProjectMaterialIdentity {
  projectKey: string;
  primaryRoot: string;
  database: MediaCatalogFileIdentity;
  wal: MediaCatalogFileIdentity;
  shm: MediaCatalogFileIdentity;
}

type CatalogProjectState =
  | "ready"
  | "empty"
  | "not-managed"
  | "material-database-invalid"
  | "schema-invalid";

interface CatalogProjectionAvailability {
  readableProjectRoots: Set<string>;
  projectStates: Map<string, CatalogProjectState>;
  readableProjectCount: number;
  unavailableProjects: GlobalStudioAssetCatalogPage["unavailableProjects"];
}

interface AssetCatalogSnapshotProjection extends CatalogProjectionAvailability {
  items: AssetSnapshotItem[];
  counts: GlobalStudioAssetCatalogCounts;
  imageCoverage: GlobalStudioAssetImageCoverage;
}

interface ResourceImageSnapshotProjection extends CatalogProjectionAvailability {
  items: ResourceImageSnapshotItem[];
  assetCounts: GlobalStudioAssetCatalogCounts;
  resourceCounts: GlobalStudioAssetCatalogCounts;
  imageCoverage: GlobalStudioAssetImageCoverage;
}

interface MediaResourceSnapshotProjection extends CatalogProjectionAvailability {
  items: MediaSnapshotItem[];
  counts: GlobalStudioMediaResourceCounts;
  previewCoverage: GlobalStudioMediaResourcePreviewCoverage;
}

interface GlobalStudioAssetCatalogSnapshot {
  registryPath: string;
  registryIdentity: MediaCatalogFileIdentity;
  projectMaterialIdentities: MediaProjectMaterialIdentity[];
  projects: RegisteredProject[];
  assets: AssetCatalogSnapshotProjection;
  resourceImages: ResourceImageSnapshotProjection;
  imageResources: GlobalStudioImageResourceSnapshotProjection;
  media: MediaResourceSnapshotProjection;
  registryFingerprint: string;
  contentFingerprint: string;
}

export interface GlobalStudioAssetCatalogCacheMetrics {
  cacheHits: number;
  cacheMisses: number;
  cacheInvalidations: number;
  validationPasses: number;
  validationFailures: number;
  singleflightJoins: number;
  snapshotBuilds: number;
  snapshotBuildAttempts: number;
  snapshotBuildRetries: number;
  snapshotBuildFailures: number;
  projectSqliteStabilizations: number;
  projectSqliteScans: number;
  /** 兼容旧图片目录指标；统一快照后必须恒为 0。 */
  directedProjectSqliteScans: number;
  /** 兼容旧图片目录指标；统一快照后必须恒为 0。 */
  directedReadRetries: number;
}

/** 兼容既有音视频测试/诊断导出。 */
export type GlobalStudioMediaResourceCatalogCacheMetrics =
  GlobalStudioAssetCatalogCacheMetrics;

let globalAssetCatalogSnapshot: GlobalStudioAssetCatalogSnapshot | undefined;
let globalAssetCatalogSnapshotSingleflight:
Promise<GlobalStudioAssetCatalogSnapshot> | undefined;
export type GlobalStudioAssetCatalogSnapshotProbe = (
  phase: "after-before-identities" | "before-after-identities",
  attempt: number,
) => Promise<void> | void;
let globalAssetCatalogSnapshotProbe: GlobalStudioAssetCatalogSnapshotProbe | undefined;
const globalAssetCatalogCacheMetrics: GlobalStudioAssetCatalogCacheMetrics = {
  cacheHits: 0,
  cacheMisses: 0,
  cacheInvalidations: 0,
  validationPasses: 0,
  validationFailures: 0,
  singleflightJoins: 0,
  snapshotBuilds: 0,
  snapshotBuildAttempts: 0,
  snapshotBuildRetries: 0,
  snapshotBuildFailures: 0,
  projectSqliteStabilizations: 0,
  projectSqliteScans: 0,
  directedProjectSqliteScans: 0,
  directedReadRetries: 0,
};

/** 仅供隔离测试重置总资源进程内投影；不触碰任何工程文件。 */
export function __resetGlobalStudioAssetCatalogCacheForTests(): void {
  globalAssetCatalogSnapshot = undefined;
  globalAssetCatalogSnapshotSingleflight = undefined;
  globalAssetCatalogSnapshotProbe = undefined;
  for (const key of Object.keys(
    globalAssetCatalogCacheMetrics,
  ) as Array<keyof GlobalStudioAssetCatalogCacheMetrics>) {
    globalAssetCatalogCacheMetrics[key] = 0;
  }
}

/** 仅用于隔离测试确定性制造构建前后 registry/DB 身份漂移。 */
export function __setGlobalStudioAssetCatalogSnapshotProbeForTests(
  probe: GlobalStudioAssetCatalogSnapshotProbe | undefined,
): void {
  globalAssetCatalogSnapshotProbe = probe;
}

export function __getGlobalStudioAssetCatalogCacheMetricsForTests():
GlobalStudioAssetCatalogCacheMetrics {
  return { ...globalAssetCatalogCacheMetrics };
}

/** 兼容既有音视频测试名称；两者现在共享同一份稳定快照。 */
export function __resetGlobalStudioMediaResourceCatalogCacheForTests(): void {
  __resetGlobalStudioAssetCatalogCacheForTests();
}

export function __getGlobalStudioMediaResourceCatalogCacheMetricsForTests():
GlobalStudioMediaResourceCatalogCacheMetrics {
  return __getGlobalStudioAssetCatalogCacheMetricsForTests();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new Error(`limit 必须是 1-${MAX_PAGE_LIMIT} 的整数。`);
  }
  return value;
}

function normalizeCategory(category: StudioCanonicalAssetCategory): StudioCanonicalAssetCategory {
  if (!["character", "scene", "prop", "style"].includes(category)) {
    throw new Error("全剧本素材分类无效。");
  }
  return category;
}

function normalizeMediaResourceKind(kind: GlobalStudioMediaResourceKind): GlobalStudioMediaResourceKind {
  if (kind !== "audio" && kind !== "video") {
    throw new Error("全局音视频资源类型无效。");
  }
  return kind;
}

function normalizeSearch(search: string | undefined): string {
  const value = search?.normalize("NFKC").trim().toLocaleLowerCase("zh-CN") ?? "";
  if (value.length > 256) throw new Error("search 不能超过 256 个字符。");
  return value;
}

function projectKey(project: Pick<RegisteredProject, "id" | "primaryRoot">): string {
  const rootHash = createHash("sha256").update(path.resolve(project.primaryRoot), "utf8").digest("hex").slice(0, 16);
  return `${project.id.normalize("NFKC").toLocaleLowerCase("zh-CN")}:${rootHash}`;
}

function normalizeRegisteredProjects(
  registered: Awaited<ReturnType<typeof listRegisteredProjects>>,
): RegisteredProject[] {
  return registered.map((project) => ({
    ...project,
    primaryRoot: path.resolve(project.primaryRoot),
    projectKey: projectKey(project),
  })).sort((left, right) => (
    left.projectKey.localeCompare(right.projectKey)
    || left.primaryRoot.localeCompare(right.primaryRoot)
  ));
}

async function mediaCatalogStableFileIdentity(
  filePath: string,
): Promise<MediaCatalogFileIdentity> {
  const absolutePath = path.resolve(filePath);
  try {
    const metadata = await lstat(absolutePath, { bigint: true });
    const kind = metadata.isSymbolicLink()
      ? "symlink" as const
      : metadata.isFile()
        ? "file" as const
        : metadata.isDirectory()
          ? "directory" as const
          : "other" as const;
    return {
      path: absolutePath,
      kind,
      dev: metadata.dev.toString(),
      ino: metadata.ino.toString(),
      mode: metadata.mode.toString(),
      nlink: metadata.nlink.toString(),
      size: metadata.size.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
      ctimeNs: metadata.ctimeNs.toString(),
    };
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : "";
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { path: absolutePath, kind: "absent" };
    }
    throw error;
  }
}

async function captureMediaProjectMaterialIdentity(
  project: RegisteredProject,
): Promise<MediaProjectMaterialIdentity> {
  const databasePath = path.join(project.primaryRoot, DATABASE_RELATIVE_PATH);
  const [database, wal, volatileShm] = await Promise.all([
    mediaCatalogStableFileIdentity(databasePath),
    mediaCatalogStableFileIdentity(`${databasePath}-wal`),
    mediaCatalogStableFileIdentity(`${databasePath}-shm`),
  ]);
  // 只读 SQLite 连接也会触碰 SHM reader-lock 时戳；排除这两项瞬态字段。
  // inode/size 仍跟踪 SHM 身份，真实业务写入同时由 WAL/主库身份捕获。
  const { mtimeNs: _mtimeNs, ctimeNs: _ctimeNs, ...shm } = volatileShm;
  return {
    projectKey: project.projectKey,
    primaryRoot: project.primaryRoot,
    database,
    wal,
    shm,
  };
}

async function captureMediaProjectMaterialIdentities(
  projects: RegisteredProject[],
): Promise<MediaProjectMaterialIdentity[]> {
  return Promise.all(projects.map(captureMediaProjectMaterialIdentity));
}

async function stabilizeMediaProjectMaterialReadState(
  projects: RegisteredProject[],
): Promise<void> {
  for (const project of projects) {
    const databasePath = path.join(project.primaryRoot, DATABASE_RELATIVE_PATH);
    const metadata = await lstat(databasePath).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(databasePath, { readOnly: true });
      globalAssetCatalogCacheMetrics.projectSqliteStabilizations += 1;
      db.exec("PRAGMA query_only = ON");
      db.prepare("SELECT name FROM sqlite_master ORDER BY name LIMIT 1").get();
    } catch {
      // 正式扫描继续沿用 material-database-invalid 语义。
    } finally {
      db?.close();
    }
  }
}

function sameMediaCatalogIdentity(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function registryFingerprint(projects: readonly RegisteredProject[]): string {
  return createHash("sha256").update(stableJson(projects.map((project) => ({
    id: project.id,
    name: project.name,
    primaryRoot: path.resolve(project.primaryRoot),
    updatedAt: project.updatedAt,
    projectKey: project.projectKey,
  }))), "utf8").digest("hex");
}

function catalogContentFingerprint(
  registryDigest: string,
  projectMaterialIdentities: readonly MediaProjectMaterialIdentity[],
): string {
  return createHash("sha256").update(stableJson({
    kind: "global-studio-catalog-content",
    registryFingerprint: registryDigest,
    projectMaterialIdentities,
  }), "utf8").digest("hex");
}

function cursorScope(
  category: StudioCanonicalAssetCategory,
  search: string,
  fingerprint: string,
): string {
  return createHash("sha256").update(stableJson({
    kind: "global-studio-asset-catalog",
    category,
    search,
    registryFingerprint: fingerprint,
  }), "utf8").digest("hex");
}

function encodeCursor(cursor: CatalogCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined, scope: string): CatalogCursor | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("全剧本素材分页游标无效。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("全剧本素材分页游标无效。");
  }
  const cursor = parsed as Partial<CatalogCursor>;
  if (cursor.v !== 1
    || cursor.scope !== scope
    || typeof cursor.projectKey !== "string"
    || typeof cursor.assetId !== "string"
    || !cursor.projectKey
    || !cursor.assetId) {
    throw new Error("全剧本素材分页游标已过期，请从第一页重新读取。");
  }
  return cursor as CatalogCursor;
}

function resourceCursorScope(
  category: StudioCanonicalAssetCategory,
  search: string,
  fingerprint: string,
): string {
  return createHash("sha256").update(stableJson({
    kind: "global-studio-asset-resource-images",
    category,
    search,
    registryFingerprint: fingerprint,
  }), "utf8").digest("hex");
}

function encodeResourceCursor(cursor: ResourceCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeResourceCursor(value: string | undefined, scope: string): ResourceCursor | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("全剧本图片资源分页游标无效。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("全剧本图片资源分页游标无效。");
  }
  const cursor = parsed as Partial<ResourceCursor>;
  if (cursor.v !== 1
    || cursor.scope !== scope
    || typeof cursor.projectKey !== "string"
    || typeof cursor.mediaSha256 !== "string"
    || !cursor.projectKey
    || !/^[a-f0-9]{64}$/u.test(cursor.mediaSha256)) {
    throw new Error("全剧本图片资源分页游标已过期，请从第一页重新读取。");
  }
  return cursor as ResourceCursor;
}

function mediaResourceCursorScope(
  kind: GlobalStudioMediaResourceKind,
  search: string,
  fingerprint: string,
): string {
  return createHash("sha256").update(stableJson({
    kind: "global-studio-media-resources",
    mediaKind: kind,
    search,
    registryFingerprint: fingerprint,
  }), "utf8").digest("hex");
}

function encodeMediaResourceCursor(cursor: MediaResourceCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeMediaResourceCursor(
  value: string | undefined,
  scope: string,
): MediaResourceCursor | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("全局音视频资源分页游标无效。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("全局音视频资源分页游标无效。");
  }
  const cursor = parsed as Partial<MediaResourceCursor>;
  if (cursor.v !== 1
    || cursor.scope !== scope
    || typeof cursor.projectKey !== "string"
    || typeof cursor.mediaSha256 !== "string"
    || !cursor.projectKey
    || !/^[a-f0-9]{64}$/u.test(cursor.mediaSha256)) {
    throw new Error("全局音视频资源分页游标已过期，请从第一页重新读取。");
  }
  return cursor as MediaResourceCursor;
}

function emptyCounts(): GlobalStudioAssetCatalogCounts {
  return { total: 0, character: 0, scene: 0, prop: 0, style: 0 };
}

function emptyCoverage(): GlobalStudioAssetImageCoverage {
  return { totalImages: 0, assetVersionImages: 0, ordinaryImages: 0 };
}

function emptyMediaResourceCounts(): GlobalStudioMediaResourceCounts {
  return { total: 0, audio: 0, video: 0 };
}

function emptyMediaResourcePreviewCoverage(): GlobalStudioMediaResourcePreviewCoverage {
  return { videoPosterReady: 0, videoProxyReady: 0, audioWaveformReady: 0 };
}

function countValue(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): number {
  const row = db.prepare(sql).get(...params) as { count?: number | bigint } | undefined;
  const value = Number(row?.count ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("全剧本素材统计无效。");
  return value;
}

function requiredTablesExist(db: DatabaseSync): boolean {
  const required = new Set([
    "studio_canonical_assets",
    "studio_asset_aliases",
    "studio_asset_versions",
    "studio_media",
  ]);
  const rows = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('studio_canonical_assets', 'studio_asset_aliases', 'studio_asset_versions', 'studio_media')
  `).all() as Array<{ name: string }>;
  for (const row of rows) required.delete(row.name);
  return required.size === 0;
}

function resourceTablesExist(db: DatabaseSync): boolean {
  if (!requiredTablesExist(db)) return false;
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'table' AND name = 'studio_version_reviews'
  `).get() as { count?: number | bigint } | undefined;
  return Number(row?.count ?? 0) === 1;
}

function mediaResourceTablesExist(db: DatabaseSync): boolean {
  const required = new Set(["studio_media", "studio_media_derivatives"]);
  const rows = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('studio_media', 'studio_media_derivatives')
  `).all() as Array<{ name: string }>;
  for (const row of rows) required.delete(row.name);
  return required.size === 0;
}

function addProjectCounts(
  db: DatabaseSync,
  counts: GlobalStudioAssetCatalogCounts,
  coverage: GlobalStudioAssetImageCoverage,
): void {
  const rows = db.prepare(`
    SELECT category, COUNT(*) AS count
    FROM studio_canonical_assets
    GROUP BY category
  `).all() as Array<{ category: StudioCanonicalAssetCategory; count: number | bigint }>;
  for (const row of rows) {
    if (!["character", "scene", "prop", "style"].includes(row.category)) continue;
    const value = Number(row.count);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("全剧本素材分类统计无效。");
    counts[row.category] += value;
    counts.total += value;
  }
  coverage.totalImages += countValue(db, "SELECT COUNT(*) AS count FROM studio_media WHERE kind = 'image'");
  coverage.assetVersionImages += countValue(db, `
    SELECT COUNT(DISTINCT version.media_sha256) AS count
    FROM studio_asset_versions version
    INNER JOIN studio_media media ON media.sha256 = version.media_sha256
    WHERE media.kind = 'image'
  `);
}

function addProjectResourceCounts(
  db: DatabaseSync,
  counts: GlobalStudioAssetCatalogCounts,
): void {
  counts.total += countValue(db, `
    SELECT COUNT(*) AS count
    FROM (
      SELECT version.media_sha256
      FROM studio_asset_versions version
      INNER JOIN studio_media media ON media.sha256 = version.media_sha256
      WHERE media.kind = 'image'
      GROUP BY version.media_sha256
    )
  `);
  for (const category of ["character", "scene", "prop", "style"] as const) {
    counts[category] += countValue(db, `
      SELECT COUNT(*) AS count
      FROM (
        SELECT version.media_sha256
        FROM studio_asset_versions version
        INNER JOIN studio_canonical_assets asset ON asset.id = version.asset_id
        INNER JOIN studio_media media ON media.sha256 = version.media_sha256
        WHERE media.kind = 'image' AND asset.category = ?
        GROUP BY version.media_sha256
      )
    `, category);
  }
}

function addProjectMediaResourceCounts(
  db: DatabaseSync,
  counts: GlobalStudioMediaResourceCounts,
  previewCoverage: GlobalStudioMediaResourcePreviewCoverage,
): void {
  const rows = db.prepare(`
    SELECT kind, COUNT(*) AS count
    FROM studio_media
    WHERE kind IN ('audio', 'video')
    GROUP BY kind
  `).all() as Array<{ kind: GlobalStudioMediaResourceKind; count: number | bigint }>;
  for (const row of rows) {
    if (row.kind !== "audio" && row.kind !== "video") continue;
    const value = Number(row.count);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("全局音视频资源分类统计无效。");
    counts[row.kind] += value;
    counts.total += value;
  }

  const derivativeRows = db.prepare(`
    SELECT derivative.kind, COUNT(*) AS count
    FROM studio_media_derivatives derivative
    INNER JOIN studio_media media ON media.sha256 = derivative.media_sha256
    WHERE derivative.status = 'ready'
      AND (
        (media.kind = 'video' AND derivative.kind IN ('video_poster', 'video_proxy'))
        OR (media.kind = 'audio' AND derivative.kind = 'audio_waveform')
      )
    GROUP BY derivative.kind
  `).all() as Array<{
    kind: "video_poster" | "video_proxy" | "audio_waveform";
    count: number | bigint;
  }>;
  for (const row of derivativeRows) {
    const value = Number(row.count);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("全局音视频资源预览统计无效。");
    if (row.kind === "video_poster") previewCoverage.videoPosterReady += value;
    else if (row.kind === "video_proxy") previewCoverage.videoProxyReady += value;
    else if (row.kind === "audio_waveform") previewCoverage.audioWaveformReady += value;
  }
}

function readyMediaRecipeKey(value: string | null, label: string): string | undefined {
  if (value === null) return undefined;
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`全局音视频资源 ${label} recipe key 无效。`);
  return value;
}

function mediaResourceFromRow(
  project: RegisteredProject,
  row: CatalogMediaResourceRow,
): GlobalStudioMediaResourceItem {
  if (!/^[a-f0-9]{64}$/u.test(row.media_sha256)
    || (row.kind !== "audio" && row.kind !== "video")
    || typeof row.source_basename !== "string"
    || !row.source_basename
    || path.basename(row.source_basename) !== row.source_basename
    || typeof row.mime_type !== "string"
    || !row.mime_type
    || typeof row.created_at !== "string"
    || !row.created_at) {
    throw new Error("全局音视频资源记录无效。");
  }
  const sizeBytes = Number(row.size_bytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error("全局音视频资源大小无效。");
  }
  const videoPosterRecipeKey = readyMediaRecipeKey(row.video_poster_recipe_key, "video poster");
  const videoProxyRecipeKey = readyMediaRecipeKey(row.video_proxy_recipe_key, "video proxy");
  const audioWaveformRecipeKey = readyMediaRecipeKey(row.audio_waveform_recipe_key, "audio waveform");
  return {
    sourceProject: {
      id: project.id,
      name: project.name,
      primaryRoot: path.resolve(project.primaryRoot),
      updatedAt: project.updatedAt,
    },
    mediaSha256: row.media_sha256,
    kind: row.kind,
    sourceBasename: row.source_basename,
    mimeType: row.mime_type,
    sizeBytes,
    createdAt: row.created_at,
    ...(row.kind === "video" && videoPosterRecipeKey ? {
      preview: { kind: "video_poster" as const, recipeKey: videoPosterRecipeKey },
    } : {}),
    ...(row.kind === "audio" && audioWaveformRecipeKey ? {
      preview: { kind: "audio_waveform" as const, recipeKey: audioWaveformRecipeKey },
    } : {}),
    ...(row.kind === "video" && videoProxyRecipeKey ? {
      playback: { kind: "video_proxy" as const, recipeKey: videoProxyRecipeKey },
    } : {}),
  };
}

function selectProjectMediaResources(
  db: DatabaseSync,
  project: RegisteredProject,
  kind: GlobalStudioMediaResourceKind,
  search: string,
  afterMediaSha256: string | undefined,
  limit: number,
): GlobalStudioMediaResourceItem[] {
  const like = `%${search.replace(/[\\%_]/gu, (value) => `\\${value}`)}%`;
  const rows = db.prepare(`
    SELECT
      media.sha256 AS media_sha256,
      media.kind,
      media.source_basename,
      media.mime_type,
      media.size_bytes,
      media.created_at,
      video_poster.recipe_key AS video_poster_recipe_key,
      video_proxy.recipe_key AS video_proxy_recipe_key,
      audio_waveform.recipe_key AS audio_waveform_recipe_key
    FROM studio_media media
    LEFT JOIN studio_media_derivatives video_poster
      ON video_poster.media_sha256 = media.sha256
      AND video_poster.kind = 'video_poster'
      AND video_poster.status = 'ready'
    LEFT JOIN studio_media_derivatives video_proxy
      ON video_proxy.media_sha256 = media.sha256
      AND video_proxy.kind = 'video_proxy'
      AND video_proxy.status = 'ready'
    LEFT JOIN studio_media_derivatives audio_waveform
      ON audio_waveform.media_sha256 = media.sha256
      AND audio_waveform.kind = 'audio_waveform'
      AND audio_waveform.status = 'ready'
    WHERE media.kind = ?
      AND (? IS NULL OR media.sha256 > ?)
      AND (
        ? = ''
        OR lower(media.source_basename) LIKE ? ESCAPE '\\'
        OR lower(media.mime_type) LIKE ? ESCAPE '\\'
        OR media.sha256 LIKE ? ESCAPE '\\'
      )
    ORDER BY media.sha256 ASC
    LIMIT ?
  `).all(
    kind,
    afterMediaSha256 ?? null,
    afterMediaSha256 ?? null,
    search,
    like,
    like,
    like,
    limit,
  ) as unknown as CatalogMediaResourceRow[];
  return rows.map((row) => mediaResourceFromRow(project, row));
}

function cloneMediaResourceItem(
  item: MediaSnapshotItem,
): GlobalStudioMediaResourceItem {
  return {
    sourceProject: { ...item.sourceProject },
    mediaSha256: item.mediaSha256,
    kind: item.kind,
    sourceBasename: item.sourceBasename,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    createdAt: item.createdAt,
    ...(item.preview ? { preview: { ...item.preview } } : {}),
    ...(item.playback ? { playback: { ...item.playback } } : {}),
  };
}

function sqliteAsciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

function mediaSnapshotMatchesSearch(
  item: MediaSnapshotItem,
  search: string,
): boolean {
  if (!search) return true;
  const normalizedProject = `${item.sourceProject.name} ${item.sourceProject.id}`
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN");
  if (normalizedProject.includes(search)) return true;
  return [
    item.sourceBasename,
    item.mimeType,
    item.mediaSha256,
  ].some((value) => sqliteAsciiLower(value).includes(search));
}

function emptyCatalogProjectionAvailability(): CatalogProjectionAvailability {
  return {
    readableProjectRoots: new Set(),
    projectStates: new Map(),
    readableProjectCount: 0,
    unavailableProjects: [],
  };
}

function markProjectionReadable(
  projection: CatalogProjectionAvailability,
  project: RegisteredProject,
  state: "ready" | "empty",
): void {
  projection.readableProjectCount += 1;
  projection.readableProjectRoots.add(project.primaryRoot);
  projection.projectStates.set(project.primaryRoot, state);
}

function markProjectionUnavailable(
  projection: CatalogProjectionAvailability,
  project: RegisteredProject,
  state: Exclude<CatalogProjectState, "ready" | "empty">,
  reason: "not-managed" | "material-database-invalid",
): void {
  projection.projectStates.set(project.primaryRoot, state);
  projection.unavailableProjects.push({
    id: project.id,
    name: project.name,
    reason,
  });
}

function addAssetCounts(
  target: GlobalStudioAssetCatalogCounts,
  source: GlobalStudioAssetCatalogCounts,
): void {
  target.total += source.total;
  target.character += source.character;
  target.scene += source.scene;
  target.prop += source.prop;
  target.style += source.style;
}

function addImageCoverage(
  target: GlobalStudioAssetImageCoverage,
  source: GlobalStudioAssetImageCoverage,
): void {
  target.totalImages += source.totalImages;
  target.assetVersionImages += source.assetVersionImages;
}

async function scanGlobalAssetCatalogProjects(
  projects: RegisteredProject[],
): Promise<Pick<
GlobalStudioAssetCatalogSnapshot,
"assets" | "resourceImages" | "imageResources" | "media"
>> {
  const assets: AssetCatalogSnapshotProjection = {
    ...emptyCatalogProjectionAvailability(),
    items: [],
    counts: emptyCounts(),
    imageCoverage: emptyCoverage(),
  };
  const resourceImages: ResourceImageSnapshotProjection = {
    ...emptyCatalogProjectionAvailability(),
    items: [],
    assetCounts: emptyCounts(),
    resourceCounts: emptyCounts(),
    imageCoverage: emptyCoverage(),
  };
  const media: MediaResourceSnapshotProjection = {
    ...emptyCatalogProjectionAvailability(),
    items: [],
    counts: emptyMediaResourceCounts(),
    previewCoverage: emptyMediaResourcePreviewCoverage(),
  };
  const imageResourceItems: GlobalStudioImageResourceSnapshotItem[] = [];
  const imageResourceReadableProjectRoots = new Set<string>();
  const imageResourceProjectStates = new Map<
  string,
  "ready" | "empty" | "not-managed" | "material-database-invalid"
  >();
  const imageResourceUnavailableProjects:
  GlobalStudioImageResourcePage["unavailableProjects"] = [];
  let imageResourceReadableProjectCount = 0;
  const projections = [assets, resourceImages, media] as const;
  const categories = ["character", "scene", "prop", "style"] as const;

  for (const project of projects) {
    const databasePath = path.join(project.primaryRoot, DATABASE_RELATIVE_PATH);
    try {
      await inspectManagedProjectReadOnly(project.primaryRoot);
    } catch {
      for (const projection of projections) {
        markProjectionUnavailable(projection, project, "not-managed", "not-managed");
      }
      imageResourceProjectStates.set(project.primaryRoot, "not-managed");
      imageResourceUnavailableProjects.push({
        id: project.id,
        name: project.name,
        reason: "not-managed",
      });
      continue;
    }
    if (!existsSync(databasePath)) {
      for (const projection of projections) markProjectionReadable(projection, project, "empty");
      imageResourceProjectStates.set(project.primaryRoot, "empty");
      imageResourceReadableProjectRoots.add(project.primaryRoot);
      imageResourceReadableProjectCount += 1;
      continue;
    }
    const metadata = await lstat(databasePath).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) {
      for (const projection of projections) {
        markProjectionUnavailable(
          projection,
          project,
          "material-database-invalid",
          "material-database-invalid",
        );
      }
      imageResourceProjectStates.set(project.primaryRoot, "material-database-invalid");
      imageResourceUnavailableProjects.push({
        id: project.id,
        name: project.name,
        reason: "material-database-invalid",
      });
      continue;
    }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(databasePath, { readOnly: true });
      globalAssetCatalogCacheMetrics.projectSqliteScans += 1;
      db.exec("PRAGMA query_only = ON");

      if (requiredTablesExist(db)) {
        try {
          const projectCounts = emptyCounts();
          const projectCoverage = emptyCoverage();
          addProjectCounts(db, projectCounts, projectCoverage);
          const projectItems = categories.flatMap((category) => (
            selectProjectItems(
              db!,
              project,
              category,
              "",
              undefined,
              2_147_483_647,
            ).map((item): AssetSnapshotItem => ({
              ...item,
              projectKey: project.projectKey,
            }))
          ));
          addAssetCounts(assets.counts, projectCounts);
          addImageCoverage(assets.imageCoverage, projectCoverage);
          assets.items.push(...projectItems);
          markProjectionReadable(assets, project, "ready");
        } catch {
          markProjectionUnavailable(
            assets,
            project,
            "material-database-invalid",
            "material-database-invalid",
          );
        }
      } else {
        markProjectionUnavailable(
          assets,
          project,
          "schema-invalid",
          "material-database-invalid",
        );
      }

      if (resourceTablesExist(db)) {
        try {
          const projectAssetCounts = emptyCounts();
          const projectResourceCounts = emptyCounts();
          const projectCoverage = emptyCoverage();
          addProjectCounts(db, projectAssetCounts, projectCoverage);
          addProjectResourceCounts(db, projectResourceCounts);
          const aliases = normalizedAliasesByAssetId(db);
          const projectItems = categories.flatMap((category) => (
            selectProjectResourceImages(
              db!,
              project,
              category,
              "",
              undefined,
              2_147_483_647,
            ).map((item): ResourceImageSnapshotItem => ({
              ...item,
              projectKey: project.projectKey,
              searchText: resourceImageSearchText(item, aliases),
            }))
          ));
          addAssetCounts(resourceImages.assetCounts, projectAssetCounts);
          addAssetCounts(resourceImages.resourceCounts, projectResourceCounts);
          addImageCoverage(resourceImages.imageCoverage, projectCoverage);
          resourceImages.items.push(...projectItems);
          markProjectionReadable(resourceImages, project, "ready");
        } catch {
          markProjectionUnavailable(
            resourceImages,
            project,
            "material-database-invalid",
            "material-database-invalid",
          );
        }
      } else {
        markProjectionUnavailable(
          resourceImages,
          project,
          "schema-invalid",
          "material-database-invalid",
        );
      }

      if (mediaResourceTablesExist(db)) {
        try {
          const projectCounts = emptyMediaResourceCounts();
          const projectPreviewCoverage = emptyMediaResourcePreviewCoverage();
          addProjectMediaResourceCounts(db, projectCounts, projectPreviewCoverage);
          const projectItems = [
            ...selectProjectMediaResources(
              db,
              project,
              "audio",
              "",
              undefined,
              2_147_483_647,
            ),
            ...selectProjectMediaResources(
              db,
              project,
              "video",
              "",
              undefined,
              2_147_483_647,
            ),
          ].map((item): MediaSnapshotItem => ({
            ...item,
            projectKey: project.projectKey,
          }));
          media.counts.total += projectCounts.total;
          media.counts.audio += projectCounts.audio;
          media.counts.video += projectCounts.video;
          media.previewCoverage.videoPosterReady += projectPreviewCoverage.videoPosterReady;
          media.previewCoverage.videoProxyReady += projectPreviewCoverage.videoProxyReady;
          media.previewCoverage.audioWaveformReady += projectPreviewCoverage.audioWaveformReady;
          media.items.push(...projectItems);
          markProjectionReadable(media, project, "ready");
        } catch {
          markProjectionUnavailable(
            media,
            project,
            "material-database-invalid",
            "material-database-invalid",
          );
        }
      } else {
        markProjectionUnavailable(
          media,
          project,
          "schema-invalid",
          "material-database-invalid",
        );
      }

      if (globalStudioImageResourceTablesExist(db)) {
        try {
          imageResourceItems.push(
            ...buildGlobalStudioImageResourceProjectItems(db, project),
          );
          imageResourceProjectStates.set(project.primaryRoot, "ready");
          imageResourceReadableProjectRoots.add(project.primaryRoot);
          imageResourceReadableProjectCount += 1;
        } catch {
          imageResourceProjectStates.set(project.primaryRoot, "material-database-invalid");
          imageResourceUnavailableProjects.push({
            id: project.id,
            name: project.name,
            reason: "material-database-invalid",
          });
        }
      } else {
        imageResourceProjectStates.set(project.primaryRoot, "material-database-invalid");
        imageResourceUnavailableProjects.push({
          id: project.id,
          name: project.name,
          reason: "material-database-invalid",
        });
      }
    } catch {
      for (const projection of projections) {
        if (!projection.projectStates.has(project.primaryRoot)) {
          markProjectionUnavailable(
            projection,
            project,
            "material-database-invalid",
            "material-database-invalid",
          );
        }
      }
      if (!imageResourceProjectStates.has(project.primaryRoot)) {
        imageResourceProjectStates.set(project.primaryRoot, "material-database-invalid");
        imageResourceUnavailableProjects.push({
          id: project.id,
          name: project.name,
          reason: "material-database-invalid",
        });
      }
    } finally {
      db?.close();
    }
  }
  assets.items.sort((left, right) => (
    left.projectKey.localeCompare(right.projectKey)
    || left.assetId.localeCompare(right.assetId)
  ));
  resourceImages.items.sort((left, right) => (
    left.projectKey.localeCompare(right.projectKey)
    || left.mediaSha256.localeCompare(right.mediaSha256)
    || left.category.localeCompare(right.category)
  ));
  media.items.sort((left, right) => (
    left.projectKey.localeCompare(right.projectKey)
    || left.mediaSha256.localeCompare(right.mediaSha256)
  ));
  assets.imageCoverage.ordinaryImages = Math.max(
    0,
    assets.imageCoverage.totalImages - assets.imageCoverage.assetVersionImages,
  );
  resourceImages.imageCoverage.ordinaryImages = Math.max(
    0,
    resourceImages.imageCoverage.totalImages
      - resourceImages.imageCoverage.assetVersionImages,
  );
  const imageResources = finalizeGlobalStudioImageResourceSnapshotProjection({
    projects,
    items: imageResourceItems,
    readableProjectRoots: imageResourceReadableProjectRoots,
    readableProjectCount: imageResourceReadableProjectCount,
    unavailableProjects: imageResourceUnavailableProjects,
  });
  return { assets, resourceImages, imageResources, media };
}

async function buildStableGlobalAssetCatalogSnapshot():
Promise<GlobalStudioAssetCatalogSnapshot> {
  for (let attempt = 1; attempt <= MAX_CATALOG_SNAPSHOT_BUILD_ATTEMPTS; attempt += 1) {
    globalAssetCatalogCacheMetrics.snapshotBuildAttempts += 1;
    const registryPath = path.resolve(getProjectRegistryPath());
    const registryIdentityBefore = await mediaCatalogStableFileIdentity(registryPath);
    const registered = await listRegisteredProjects();
    if (registered.length > MAX_REGISTERED_PROJECTS) {
      throw new Error(`登记工程超过 ${MAX_REGISTERED_PROJECTS} 个；拒绝静默截断总资源目录。`);
    }
    const projects = normalizeRegisteredProjects(registered);
    await stabilizeMediaProjectMaterialReadState(projects);
    const projectMaterialIdentitiesBefore = await captureMediaProjectMaterialIdentities(projects);
    await globalAssetCatalogSnapshotProbe?.("after-before-identities", attempt);
    const scanned = await scanGlobalAssetCatalogProjects(projects);
    await globalAssetCatalogSnapshotProbe?.("before-after-identities", attempt);
    const [registryIdentityAfter, projectMaterialIdentitiesAfter] = await Promise.all([
      mediaCatalogStableFileIdentity(registryPath),
      captureMediaProjectMaterialIdentities(projects),
    ]);
    const stable = path.resolve(getProjectRegistryPath()) === registryPath
      && sameMediaCatalogIdentity(registryIdentityBefore, registryIdentityAfter)
      && sameMediaCatalogIdentity(
        projectMaterialIdentitiesBefore,
        projectMaterialIdentitiesAfter,
      );
    if (!stable) {
      globalAssetCatalogCacheMetrics.snapshotBuildRetries += 1;
      continue;
    }
    globalAssetCatalogCacheMetrics.snapshotBuilds += 1;
    const registryDigest = registryFingerprint(projects);
    return {
      registryPath,
      registryIdentity: registryIdentityAfter,
      projectMaterialIdentities: projectMaterialIdentitiesAfter,
      projects,
      ...scanned,
      registryFingerprint: registryDigest,
      contentFingerprint: catalogContentFingerprint(
        registryDigest,
        projectMaterialIdentitiesAfter,
      ),
    };
  }
  globalAssetCatalogCacheMetrics.snapshotBuildFailures += 1;
  throw new Error(
    `总资源目录在 ${MAX_CATALOG_SNAPSHOT_BUILD_ATTEMPTS} 次构建期间持续变化，请稍后重试。`,
  );
}

async function globalAssetCatalogSnapshotStillCurrent(
  snapshot: GlobalStudioAssetCatalogSnapshot,
): Promise<boolean> {
  try {
    if (path.resolve(getProjectRegistryPath()) !== snapshot.registryPath) return false;
    const registryIdentity = await mediaCatalogStableFileIdentity(snapshot.registryPath);
    if (!sameMediaCatalogIdentity(registryIdentity, snapshot.registryIdentity)) return false;
    const projectMaterialIdentities = await captureMediaProjectMaterialIdentities(
      snapshot.projects,
    );
    return sameMediaCatalogIdentity(
      projectMaterialIdentities,
      snapshot.projectMaterialIdentities,
    );
  } catch {
    return false;
  }
}

function invalidateGlobalAssetCatalogSnapshot(
  snapshot: GlobalStudioAssetCatalogSnapshot,
): void {
  if (globalAssetCatalogSnapshot !== snapshot) return;
  globalAssetCatalogSnapshot = undefined;
  globalAssetCatalogCacheMetrics.cacheInvalidations += 1;
}

async function reusableGlobalAssetCatalogSnapshot():
Promise<GlobalStudioAssetCatalogSnapshot | undefined> {
  const snapshot = globalAssetCatalogSnapshot;
  if (snapshot) {
    if (await globalAssetCatalogSnapshotStillCurrent(snapshot)) {
      globalAssetCatalogCacheMetrics.validationPasses += 1;
      globalAssetCatalogCacheMetrics.cacheHits += 1;
      return snapshot;
    }
    globalAssetCatalogCacheMetrics.validationFailures += 1;
    invalidateGlobalAssetCatalogSnapshot(snapshot);
  }
  if (globalAssetCatalogSnapshotSingleflight) {
    globalAssetCatalogCacheMetrics.singleflightJoins += 1;
    const joined = await globalAssetCatalogSnapshotSingleflight;
    globalAssetCatalogCacheMetrics.cacheHits += 1;
    return joined;
  }
  return undefined;
}

async function currentGlobalAssetCatalogSnapshot():
Promise<GlobalStudioAssetCatalogSnapshot> {
  const reusable = await reusableGlobalAssetCatalogSnapshot();
  if (reusable) return reusable;
  if (globalAssetCatalogSnapshotSingleflight) {
    globalAssetCatalogCacheMetrics.singleflightJoins += 1;
    return globalAssetCatalogSnapshotSingleflight;
  }
  globalAssetCatalogCacheMetrics.cacheMisses += 1;
  const flight = buildStableGlobalAssetCatalogSnapshot();
  globalAssetCatalogSnapshotSingleflight = flight;
  try {
    const snapshot = await flight;
    globalAssetCatalogSnapshot = snapshot;
    return snapshot;
  } finally {
    if (globalAssetCatalogSnapshotSingleflight === flight) {
      globalAssetCatalogSnapshotSingleflight = undefined;
    }
  }
}

function aliasesForAsset(db: DatabaseSync, assetId: string): string[] {
  return (db.prepare(`
    SELECT alias
    FROM studio_asset_aliases
    WHERE asset_id = ?
    ORDER BY normalized_alias, alias
  `).all(assetId) as Array<{ alias: string }>).map((row) => row.alias);
}

function selectProjectItems(
  db: DatabaseSync,
  project: RegisteredProject,
  category: StudioCanonicalAssetCategory,
  search: string,
  afterAssetId: string | undefined,
  limit: number,
): GlobalStudioAssetCatalogItem[] {
  const like = `%${search.replace(/[\\%_]/gu, (value) => `\\${value}`)}%`;
  const rows = db.prepare(`
    SELECT asset.*,
      primary_version.media_sha256 AS primary_media_sha256,
      primary_media.thumbnail_recipe_key AS primary_thumbnail_recipe_key,
      (SELECT COUNT(*) FROM studio_asset_versions version WHERE version.asset_id = asset.id) AS version_count
    FROM studio_canonical_assets asset
    LEFT JOIN studio_asset_versions primary_version ON primary_version.id = asset.primary_version_id
    LEFT JOIN studio_media primary_media ON primary_media.sha256 = primary_version.media_sha256
    WHERE asset.category = ?
      AND (? IS NULL OR asset.id > ?)
      AND (
        ? = ''
        OR lower(asset.name) LIKE ? ESCAPE '\\'
        OR lower(asset.description) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(primary_version.media_sha256, '')) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM studio_asset_aliases alias
          WHERE alias.asset_id = asset.id
            AND alias.normalized_alias LIKE ? ESCAPE '\\'
        )
      )
    ORDER BY asset.id ASC
    LIMIT ?
  `).all(
    category,
    afterAssetId ?? null,
    afterAssetId ?? null,
    search,
    like,
    like,
    like,
    like,
    limit,
  ) as unknown as CatalogAssetRow[];
  return rows.map((row) => ({
    sourceProject: {
      id: project.id,
      name: project.name,
      primaryRoot: path.resolve(project.primaryRoot),
      updatedAt: project.updatedAt,
    },
    assetId: row.id,
    category: row.category,
    name: row.name,
    description: row.description,
    aliases: aliasesForAsset(db, row.id),
    revision: Number(row.revision),
    versionCount: Number(row.version_count),
    ...(row.primary_version_id && row.primary_media_sha256 ? {
      primaryAuthority: {
        versionId: row.primary_version_id,
        mediaSha256: row.primary_media_sha256,
        ...(row.primary_thumbnail_recipe_key
          ? { thumbnailRecipeKey: row.primary_thumbnail_recipe_key }
          : {}),
      },
    } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function cloneAssetSnapshotItem(
  item: AssetSnapshotItem,
): GlobalStudioAssetCatalogItem {
  return {
    sourceProject: { ...item.sourceProject },
    assetId: item.assetId,
    category: item.category,
    name: item.name,
    description: item.description,
    aliases: [...item.aliases],
    revision: item.revision,
    versionCount: item.versionCount,
    ...(item.primaryAuthority ? {
      primaryAuthority: { ...item.primaryAuthority },
    } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function assetSnapshotMatchesSearch(
  item: AssetSnapshotItem,
  search: string,
): boolean {
  if (!search) return true;
  if ([
    item.name,
    item.description,
    item.primaryAuthority?.mediaSha256 ?? "",
  ].some((value) => sqliteAsciiLower(value).includes(search))) {
    return true;
  }
  return item.aliases.some((alias) => (
    alias.normalize("NFKC").toLocaleLowerCase("zh-CN").includes(search)
  ));
}

function resourceAssociationsForMedia(
  db: DatabaseSync,
  mediaSha256: string,
): GlobalStudioAssetResourceAssociation[] {
  const rows = db.prepare(`
    SELECT
      asset.id AS asset_id,
      asset.category,
      asset.name,
      asset.description,
      asset.revision AS asset_revision,
      version.id AS version_id,
      version.ordinal AS version_ordinal,
      COALESCE(review.to_status, version.review_status) AS review_status,
      CASE WHEN asset.primary_version_id = version.id THEN 1 ELSE 0 END AS is_primary,
      version.source_note,
      version.created_at
    FROM studio_asset_versions version
    INNER JOIN studio_canonical_assets asset ON asset.id = version.asset_id
    LEFT JOIN studio_version_reviews review ON review.version_id = version.id
    WHERE version.media_sha256 = ?
    ORDER BY asset.category, lower(asset.name), asset.id, version.ordinal, version.id
  `).all(mediaSha256) as unknown as CatalogResourceAssociationRow[];
  return rows.map((row) => ({
    assetId: row.asset_id,
    category: row.category,
    name: row.name,
    description: row.description,
    assetRevision: Number(row.asset_revision),
    versionId: row.version_id,
    versionOrdinal: Number(row.version_ordinal),
    reviewStatus: row.review_status,
    isPrimary: Number(row.is_primary) === 1,
    sourceNote: row.source_note,
    createdAt: row.created_at,
  }));
}

function selectProjectResourceImages(
  db: DatabaseSync,
  project: RegisteredProject,
  category: StudioCanonicalAssetCategory,
  search: string,
  afterMediaSha256: string | undefined,
  limit: number,
): GlobalStudioAssetResourceImageItem[] {
  const like = `%${search.replace(/[\\%_]/gu, (value) => `\\${value}`)}%`;
  const rows = db.prepare(`
    SELECT
      media.sha256 AS media_sha256,
      media.source_basename,
      media.mime_type,
      media.size_bytes,
      media.thumbnail_recipe_key,
      media.created_at AS media_created_at,
      MAX(version.created_at) AS updated_at
    FROM studio_asset_versions version
    INNER JOIN studio_canonical_assets asset ON asset.id = version.asset_id
    INNER JOIN studio_media media ON media.sha256 = version.media_sha256
    WHERE asset.category = ?
      AND media.kind = 'image'
      AND (? IS NULL OR media.sha256 > ?)
      AND (
        ? = ''
        OR lower(asset.name) LIKE ? ESCAPE '\\'
        OR lower(asset.description) LIKE ? ESCAPE '\\'
        OR lower(version.source_note) LIKE ? ESCAPE '\\'
        OR lower(version.id) LIKE ? ESCAPE '\\'
        OR lower(version.media_sha256) LIKE ? ESCAPE '\\'
        OR lower(media.source_basename) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM studio_asset_aliases alias
          WHERE alias.asset_id = asset.id
            AND alias.normalized_alias LIKE ? ESCAPE '\\'
        )
      )
    GROUP BY
      media.sha256,
      media.source_basename,
      media.mime_type,
      media.size_bytes,
      media.thumbnail_recipe_key,
      media.created_at
    ORDER BY media.sha256 ASC
    LIMIT ?
  `).all(
    category,
    afterMediaSha256 ?? null,
    afterMediaSha256 ?? null,
    search,
    like,
    like,
    like,
    like,
    like,
    like,
    like,
    limit,
  ) as unknown as CatalogResourceImageRow[];
  return rows.map((row) => {
    const associations = resourceAssociationsForMedia(db, row.media_sha256);
    if (!associations.length) throw new Error("全剧本图片资源缺少资产版本关联。");
    return {
      sourceProject: {
        id: project.id,
        name: project.name,
        primaryRoot: path.resolve(project.primaryRoot),
        updatedAt: project.updatedAt,
      },
      category,
      mediaSha256: row.media_sha256,
      sourceBasename: row.source_basename,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      thumbnailRecipeKey: row.thumbnail_recipe_key,
      associations,
      createdAt: row.media_created_at,
      updatedAt: row.updated_at,
    };
  });
}

function normalizedAliasesByAssetId(db: DatabaseSync): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  const rows = db.prepare(`
    SELECT asset_id, normalized_alias
    FROM studio_asset_aliases
    ORDER BY asset_id, normalized_alias
  `).all() as Array<{ asset_id: string; normalized_alias: string }>;
  for (const row of rows) {
    const current = aliases.get(row.asset_id) ?? [];
    current.push(row.normalized_alias);
    aliases.set(row.asset_id, current);
  }
  return aliases;
}

function resourceImageSearchText(
  item: GlobalStudioAssetResourceImageItem,
  aliases: ReadonlyMap<string, readonly string[]>,
): string {
  const values = [
    item.sourceBasename,
    item.mediaSha256,
  ];
  for (const association of item.associations) {
    if (association.category !== item.category) continue;
    values.push(
      association.name,
      association.description,
      association.sourceNote,
      association.versionId,
      ...(aliases.get(association.assetId) ?? []),
    );
  }
  return values.map(sqliteAsciiLower).join("\0");
}

function cloneResourceImageSnapshotItem(
  item: ResourceImageSnapshotItem,
): GlobalStudioAssetResourceImageItem {
  return {
    sourceProject: { ...item.sourceProject },
    category: item.category,
    mediaSha256: item.mediaSha256,
    sourceBasename: item.sourceBasename,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    thumbnailRecipeKey: item.thumbnailRecipeKey,
    associations: item.associations.map((association) => ({ ...association })),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function resourceImageSnapshotMatchesSearch(
  item: ResourceImageSnapshotItem,
  search: string,
): boolean {
  if (!search) return true;
  const normalizedProject = `${item.sourceProject.name} ${item.sourceProject.id}`
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN");
  return normalizedProject.includes(search) || item.searchText.includes(search);
}

/**
 * “全部图片 + 自动分类”与规范资产、版本图片、音视频共用同一个跨项目快照。
 * 兼容入口保留在 studio-global-image-resource-catalog.ts，但不得再自行打开 SQLite。
 */
export async function listGlobalStudioImageResourcesFromUnifiedCatalog(
  query: GlobalStudioImageResourceQuery,
): Promise<GlobalStudioImageResourcePage> {
  const snapshot = await currentGlobalAssetCatalogSnapshot();
  return listGlobalStudioImageResourcesFromSnapshot(
    snapshot.projects,
    snapshot.imageResources,
    query,
  );
}

export async function getGlobalStudioImageResourceFromUnifiedCatalog(
  projectRoot: string,
  mediaSha256: string,
): Promise<GlobalStudioImageResourceItem | null> {
  const snapshot = await currentGlobalAssetCatalogSnapshot();
  return getGlobalStudioImageResourceFromSnapshot(
    snapshot.projects,
    snapshot.imageResources,
    projectRoot,
    mediaSha256,
  );
}

/**
 * 跨剧本素材只读聚合投影。
 *
 * 事实仍留在每个受管工程自己的 Material Studio SQLite/CAS 中；这里不建第二数据库、
 * 不扫描原媒体目录、也不自动改变 Review/Primary。翻页按 registry project + asset id
 * 做 keyset，单页最多 36 项。
 */
export async function listGlobalStudioAssetCatalog(
  query: GlobalStudioAssetCatalogQuery,
): Promise<GlobalStudioAssetCatalogPage> {
  const category = normalizeCategory(query.category);
  const search = normalizeSearch(query.search);
  const limit = normalizeLimit(query.limit);
  const snapshot = await currentGlobalAssetCatalogSnapshot();
  const projection = snapshot.assets;
  const fingerprint = snapshot.registryFingerprint;
  const scope = cursorScope(category, search, snapshot.contentFingerprint);
  const cursor = decodeCursor(query.cursor, scope);
  const matching = projection.items.filter((item) => (
    item.category === category && assetSnapshotMatchesSearch(item, search)
  ));
  const remaining = matching.filter((item) => (
    !cursor
    || item.projectKey > cursor.projectKey
    || (
      item.projectKey === cursor.projectKey
      && item.assetId > cursor.assetId
    )
  ));
  const selected = remaining.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected.map(cloneAssetSnapshotItem),
    ...(remaining.length > limit && last ? {
      nextCursor: encodeCursor({
        v: 1,
        scope,
        projectKey: last.projectKey,
        assetId: last.assetId,
      }),
    } : {}),
    total: matching.length,
    counts: { ...projection.counts },
    imageCoverage: { ...projection.imageCoverage },
    registeredProjectCount: snapshot.projects.length,
    readableProjectCount: projection.readableProjectCount,
    unavailableProjects: projection.unavailableProjects.map((project) => ({ ...project })),
    registryFingerprint: fingerprint,
  };
}

/**
 * 把已经进入规范资产版本的图片逐张投影到“剧本资源”。
 *
 * 图片身份是“来源工程 + media SHA”；同一工程内复用同一图的多个版本/资产不会
 * 复制二进制或重复成多张卡，而是完整收进 associations。事实仍只来自各工程
 * Material Studio/CAS，本查询全程 readOnly + query_only。
 */
export async function listGlobalStudioAssetResourceImages(
  query: GlobalStudioAssetResourceImageQuery,
): Promise<GlobalStudioAssetResourceImagePage> {
  const category = normalizeCategory(query.category);
  const search = normalizeSearch(query.search);
  const limit = normalizeLimit(query.limit);
  const snapshot = await currentGlobalAssetCatalogSnapshot();
  const projection = snapshot.resourceImages;
  const fingerprint = snapshot.registryFingerprint;
  const scope = resourceCursorScope(category, search, snapshot.contentFingerprint);
  const cursor = decodeResourceCursor(query.cursor, scope);
  const matching = projection.items.filter((item) => (
    item.category === category && resourceImageSnapshotMatchesSearch(item, search)
  ));
  const remaining = matching.filter((item) => (
    !cursor
    || item.projectKey > cursor.projectKey
    || (
      item.projectKey === cursor.projectKey
      && item.mediaSha256 > cursor.mediaSha256
    )
  ));
  const selected = remaining.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected.map(cloneResourceImageSnapshotItem),
    ...(remaining.length > limit && last ? {
      nextCursor: encodeResourceCursor({
        v: 1,
        scope,
        projectKey: last.projectKey,
        mediaSha256: last.mediaSha256,
      }),
    } : {}),
    total: matching.length,
    assetCounts: { ...projection.assetCounts },
    resourceCounts: { ...projection.resourceCounts },
    imageCoverage: { ...projection.imageCoverage },
    registeredProjectCount: snapshot.projects.length,
    readableProjectCount: projection.readableProjectCount,
    unavailableProjects: projection.unavailableProjects.map((project) => ({ ...project })),
    registryFingerprint: fingerprint,
  };
}

export async function getGlobalStudioAssetResourceImage(
  projectRoot: string,
  mediaSha256: string,
): Promise<GlobalStudioAssetResourceImageItem | null> {
  const resolvedRoot = path.resolve(projectRoot);
  if (!/^[a-f0-9]{64}$/u.test(mediaSha256)) throw new Error("全剧本图片资源 SHA 无效。");
  const snapshot = await currentGlobalAssetCatalogSnapshot();
  const registration = snapshot.projects.find((project) => (
    project.primaryRoot === resolvedRoot
  ));
  if (!registration) throw new Error("全剧本图片资源来源工程未登记。");
  const state = snapshot.resourceImages.projectStates.get(resolvedRoot);
  if (state === "not-managed") {
    throw new Error("全剧本图片资源来源工程不是受管工程。");
  }
  if (state === "schema-invalid") {
    throw new Error("全剧本图片资源来源数据库结构无效。");
  }
  if (state !== "ready") {
    throw new Error("全剧本图片资源来源数据库无效。");
  }
  const item = snapshot.resourceImages.items.find((entry) => (
    entry.sourceProject.primaryRoot === resolvedRoot
    && entry.mediaSha256 === mediaSha256
  ));
  return item ? cloneResourceImageSnapshotItem(item) : null;
}

/**
 * 跨已登记受管工程聚合音频/视频媒体。
 *
 * 事实仍保留在各来源工程自己的 Material Studio SQLite/CAS 中；本投影不建全局库、
 * 不扫描媒体目录、不生成 poster/waveform/proxy，也不返回对象或派生文件路径。
 */
export async function listGlobalStudioMediaResources(
  query: GlobalStudioMediaResourceQuery,
): Promise<GlobalStudioMediaResourcePage> {
  const kind = normalizeMediaResourceKind(query.kind);
  const search = normalizeSearch(query.search);
  const limit = normalizeLimit(query.limit);
  const snapshot = await currentGlobalAssetCatalogSnapshot();
  const projection = snapshot.media;
  const fingerprint = snapshot.registryFingerprint;
  const scope = mediaResourceCursorScope(kind, search, snapshot.contentFingerprint);
  const cursor = decodeMediaResourceCursor(query.cursor, scope);
  const matching = projection.items.filter((item) => (
    item.kind === kind && mediaSnapshotMatchesSearch(item, search)
  ));
  const remaining = matching.filter((item) => (
    !cursor
    || item.projectKey > cursor.projectKey
    || (
      item.projectKey === cursor.projectKey
      && item.mediaSha256 > cursor.mediaSha256
    )
  ));
  const selected = remaining.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected.map(cloneMediaResourceItem),
    ...(remaining.length > limit && last ? {
      nextCursor: encodeMediaResourceCursor({
        v: 1,
        scope,
        projectKey: last.projectKey,
        mediaSha256: last.mediaSha256,
      }),
    } : {}),
    total: matching.length,
    counts: { ...projection.counts },
    previewCoverage: { ...projection.previewCoverage },
    registeredProjectCount: snapshot.projects.length,
    readableProjectCount: projection.readableProjectCount,
    unavailableProjects: projection.unavailableProjects.map((project) => ({ ...project })),
    registryFingerprint: fingerprint,
  };
}

export async function getGlobalStudioMediaResource(
  projectRoot: string,
  mediaSha256: string,
): Promise<GlobalStudioMediaResourceItem | null> {
  const resolvedRoot = path.resolve(projectRoot);
  if (!/^[a-f0-9]{64}$/u.test(mediaSha256)) throw new Error("全局音视频资源 SHA 无效。");
  const snapshot = await currentGlobalAssetCatalogSnapshot();
  const registration = snapshot.projects.find((project) => (
    project.primaryRoot === resolvedRoot
  ));
  if (!registration) throw new Error("全局音视频资源来源工程未登记。");
  const state = snapshot.media.projectStates.get(resolvedRoot);
  if (state === "not-managed") {
    throw new Error("全局音视频资源来源工程不是受管工程。");
  }
  if (state === "schema-invalid") {
    throw new Error("全局音视频资源来源数据库结构无效。");
  }
  if (state !== "ready" && state !== "empty") {
    throw new Error("全局音视频资源来源数据库无效。");
  }
  const item = snapshot.media.items.find((entry) => (
    entry.sourceProject.primaryRoot === resolvedRoot
    && entry.mediaSha256 === mediaSha256
  ));
  return item ? cloneMediaResourceItem(item) : null;
}
