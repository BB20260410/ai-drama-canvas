/** 全项目图片总资源的纯内存投影；本模块不读取 registry，也不持有目录快照。 */
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION,
  classifyStudioGlobalImage,
  type StudioGlobalImageClassification,
  type StudioGlobalImageContentTag,
  type StudioGlobalImagePrimaryCategory,
  type StudioGlobalImageResourceRole,
} from "./studio-global-image-classification.js";

const DEFAULT_PAGE_LIMIT = 36;
const MAX_PAGE_LIMIT = 36;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type GlobalStudioImageResourceCategory =
  | "all"
  | StudioGlobalImagePrimaryCategory;

export interface GlobalStudioImageResourceCounts {
  total: number;
  uniqueContent: number;
  character: number;
  scene: number;
  prop: number;
  style: number;
  storyboard: number;
  reference: number;
  other: number;
}

export interface GlobalStudioImageResourceRoleCounts {
  "asset-reference": number;
  raw: number;
  labeled: number;
  "source-original": number;
  "storyboard-grid": number;
  "shot-frame": number;
  "poster-cover": number;
  reference: number;
  other: number;
}

export interface GlobalStudioImageClassificationStateCounts {
  canonical: number;
  "metadata-high": number;
  "metadata-ambiguous": number;
  "visual-pending": number;
  manual: number;
}

export interface GlobalStudioAssetCatalogProject {
  id: string;
  name: string;
  primaryRoot: string;
  updatedAt: string;
}

export interface GlobalStudioAssetResourceAssociation {
  assetId: string;
  category: StudioGlobalImageContentTag;
  name: string;
  description: string;
  assetRevision: number;
  versionId: string;
  versionOrdinal: number;
  reviewStatus: "pending" | "approved" | "rejected";
  isPrimary: boolean;
  sourceNote: string;
  createdAt: string;
}

export interface GlobalStudioImageResourceItem {
  sourceProject: GlobalStudioAssetCatalogProject;
  mediaSha256: string;
  displayName: string;
  sourceBasename: string;
  /** 同一工程、同一 SHA 的全部不同来源文件名；卡片不丢来源命名。 */
  sourceNames: string[];
  originCount: number;
  mimeType: string;
  sizeBytes: number;
  thumbnailRecipeKey: string;
  classification: StudioGlobalImageClassification;
  /** 多来源图片可能兼具 raw/labeled 等角色，主 role 之外完整保留。 */
  originRoles: StudioGlobalImageResourceRole[];
  associations: GlobalStudioAssetResourceAssociation[];
  createdAt: string;
  updatedAt: string;
}

export interface GlobalStudioImageResourceQuery {
  category: GlobalStudioImageResourceCategory;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface GlobalStudioImageResourcePage {
  items: GlobalStudioImageResourceItem[];
  nextCursor?: string;
  /** 当前筛选命中的“来源项目 + SHA”条目数。 */
  total: number;
  /** 全目录主分类统计；各分类之和严格等于 counts.total。 */
  counts: GlobalStudioImageResourceCounts;
  roleCounts: GlobalStudioImageResourceRoleCounts;
  classificationStateCounts: GlobalStudioImageClassificationStateCounts;
  projectImageEntries: number;
  uniqueContentSha256: number;
  canonicalImageEntries: number;
  ordinaryImageEntries: number;
  registeredProjectCount: number;
  readableProjectCount: number;
  unavailableProjects: Array<{
    id: string;
    name: string;
    reason: "not-managed" | "material-database-invalid";
  }>;
  catalogFingerprint: string;
  classifierVersion: typeof STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION;
}

interface CatalogCursor {
  v: 1;
  scope: string;
  projectKey: string;
  mediaSha256: string;
}

export interface GlobalStudioImageResourceProjectionProject {
  id: string;
  name: string;
  primaryRoot: string;
  updatedAt: string;
  projectKey: string;
}

interface ImageMediaJoinRow {
  media_sha256: string;
  source_basename: string;
  mime_type: string;
  size_bytes: number | bigint;
  thumbnail_recipe_key: string;
  media_created_at: string;
  origin_id: string | null;
  origin_source_path: string | null;
  origin_source_basename: string | null;
  origin_imported_at: string | null;
}

interface AssociationRow {
  media_sha256: string;
  asset_id: string;
  category: StudioGlobalImageContentTag;
  name: string;
  description: string;
  asset_revision: number | bigint;
  version_id: string;
  version_ordinal: number | bigint;
  review_status: "pending" | "approved" | "rejected";
  is_primary: number | bigint;
  source_note: string;
  created_at: string;
}

interface GroupedImageRow {
  mediaSha256: string;
  sourceBasename: string;
  mimeType: string;
  sizeBytes: number;
  thumbnailRecipeKey: string;
  createdAt: string;
  origins: Array<{
    id: string;
    sourcePath: string;
    sourceBasename: string;
    importedAt: string;
  }>;
}

export interface GlobalStudioImageResourceSnapshotItem extends GlobalStudioImageResourceItem {
  projectKey: string;
  fingerprintPayload: unknown;
}

export interface GlobalStudioImageResourceSnapshotProjection {
  readableProjectRoots: Set<string>;
  unavailableProjects: GlobalStudioImageResourcePage["unavailableProjects"];
  items: GlobalStudioImageResourceSnapshotItem[];
  counts: GlobalStudioImageResourceCounts;
  roleCounts: GlobalStudioImageResourceRoleCounts;
  classificationStateCounts: GlobalStudioImageClassificationStateCounts;
  readableProjectCount: number;
  catalogFingerprint: string;
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

function normalizeCategory(
  category: GlobalStudioImageResourceCategory,
): GlobalStudioImageResourceCategory {
  if (![
    "all",
    "character",
    "scene",
    "prop",
    "style",
    "storyboard",
    "reference",
    "other",
  ].includes(category)) {
    throw new Error("总资源图片分类无效。");
  }
  return category;
}

function normalizeSearch(search: string | undefined): string {
  const normalized = search?.normalize("NFKC").trim().toLocaleLowerCase("zh-CN") ?? "";
  if (normalized.length > 256) throw new Error("search 不能超过 256 个字符。");
  return normalized;
}

function cursorScope(
  category: GlobalStudioImageResourceCategory,
  search: string,
  fingerprint: string,
): string {
  return createHash("sha256").update(stableJson({
    kind: "global-studio-image-resource-catalog",
    category,
    search,
    catalogFingerprint: fingerprint,
    classifierVersion: STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION,
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
    throw new Error("总资源图片分页游标无效。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("总资源图片分页游标无效。");
  }
  const cursor = parsed as Partial<CatalogCursor>;
  if (cursor.v !== 1
    || cursor.scope !== scope
    || typeof cursor.projectKey !== "string"
    || !cursor.projectKey
    || typeof cursor.mediaSha256 !== "string"
    || !SHA256_PATTERN.test(cursor.mediaSha256)) {
    throw new Error("总资源图片分页游标已过期，请从第一页重新读取。");
  }
  return cursor as CatalogCursor;
}

export function globalStudioImageResourceTablesExist(db: DatabaseSync): boolean {
  const required = new Set([
    "studio_media",
    "studio_media_imports",
    "studio_canonical_assets",
    "studio_asset_versions",
    "studio_version_reviews",
  ]);
  const rows = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN (
        'studio_media',
        'studio_media_imports',
        'studio_canonical_assets',
        'studio_asset_versions',
        'studio_version_reviews'
      )
  `).all() as Array<{ name: string }>;
  for (const row of rows) required.delete(row.name);
  return required.size === 0;
}

function associationFromRow(row: AssociationRow): GlobalStudioAssetResourceAssociation {
  return {
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
  };
}

function loadAssociations(
  db: DatabaseSync,
): Map<string, GlobalStudioAssetResourceAssociation[]> {
  const rows = db.prepare(`
    SELECT
      version.media_sha256,
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
    INNER JOIN studio_media media ON media.sha256 = version.media_sha256
    LEFT JOIN studio_version_reviews review ON review.version_id = version.id
    WHERE media.kind = 'image'
    ORDER BY
      version.media_sha256,
      asset.category,
      lower(asset.name),
      asset.id,
      version.ordinal,
      version.id
  `).all() as unknown as AssociationRow[];
  const grouped = new Map<string, GlobalStudioAssetResourceAssociation[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.media_sha256) ?? [];
    bucket.push(associationFromRow(row));
    grouped.set(row.media_sha256, bucket);
  }
  return grouped;
}

function loadImages(db: DatabaseSync): GroupedImageRow[] {
  const rows = db.prepare(`
    SELECT
      media.sha256 AS media_sha256,
      media.source_basename,
      media.mime_type,
      media.size_bytes,
      media.thumbnail_recipe_key,
      media.created_at AS media_created_at,
      origin.id AS origin_id,
      origin.source_path AS origin_source_path,
      origin.source_basename AS origin_source_basename,
      origin.imported_at AS origin_imported_at
    FROM studio_media media
    LEFT JOIN studio_media_imports origin ON origin.media_sha256 = media.sha256
    WHERE media.kind = 'image'
    ORDER BY media.sha256, origin.imported_at, origin.id
  `).all() as unknown as ImageMediaJoinRow[];
  const grouped = new Map<string, GroupedImageRow>();
  for (const row of rows) {
    if (!SHA256_PATTERN.test(row.media_sha256)
      || typeof row.source_basename !== "string"
      || !row.source_basename
      || path.basename(row.source_basename) !== row.source_basename
      || typeof row.mime_type !== "string"
      || !row.mime_type.startsWith("image/")
      || typeof row.thumbnail_recipe_key !== "string"
      || !SHA256_PATTERN.test(row.thumbnail_recipe_key)) {
      throw new Error("总资源图片媒体记录无效。");
    }
    const sizeBytes = Number(row.size_bytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
      throw new Error("总资源图片大小无效。");
    }
    let item = grouped.get(row.media_sha256);
    if (!item) {
      item = {
        mediaSha256: row.media_sha256,
        sourceBasename: row.source_basename,
        mimeType: row.mime_type,
        sizeBytes,
        thumbnailRecipeKey: row.thumbnail_recipe_key,
        createdAt: row.media_created_at,
        origins: [],
      };
      grouped.set(row.media_sha256, item);
    } else if (item.sourceBasename !== row.source_basename
      || item.mimeType !== row.mime_type
      || item.sizeBytes !== sizeBytes
      || item.thumbnailRecipeKey !== row.thumbnail_recipe_key) {
      throw new Error(`总资源图片同 SHA 元数据冲突：${row.media_sha256}`);
    }
    if (row.origin_id !== null) {
      if (!row.origin_source_path
        || !path.isAbsolute(row.origin_source_path)
        || !row.origin_source_basename
        || path.basename(row.origin_source_path) !== row.origin_source_basename
        || !row.origin_imported_at) {
        throw new Error(`总资源图片来源记录无效：${row.origin_id}`);
      }
      item.origins.push({
        id: row.origin_id,
        sourcePath: path.normalize(row.origin_source_path),
        sourceBasename: row.origin_source_basename,
        importedAt: row.origin_imported_at,
      });
    }
  }
  return [...grouped.values()];
}

const ROLE_ORDER: readonly StudioGlobalImageResourceRole[] = [
  "storyboard-grid",
  "shot-frame",
  "labeled",
  "raw",
  "source-original",
  "poster-cover",
  "reference",
  "asset-reference",
  "other",
];

function orderedRoles(values: Iterable<StudioGlobalImageResourceRole>): StudioGlobalImageResourceRole[] {
  const available = new Set(values);
  return ROLE_ORDER.filter((role) => available.has(role));
}

function aggregateOriginClassifications(
  image: GroupedImageRow,
  projectRoot: string,
  associations: GlobalStudioAssetResourceAssociation[],
): { classification: StudioGlobalImageClassification; originRoles: StudioGlobalImageResourceRole[] } {
  const canonicalAssociations = associations.map((association) => ({
    category: association.category,
    assetId: association.assetId,
    versionId: association.versionId,
  }));
  const candidates = image.origins.length
    ? image.origins.map((origin) => {
        const relative = path.relative(projectRoot, origin.sourcePath);
        const projectRelativePath = relative
          && relative !== ".."
          && !relative.startsWith(`..${path.sep}`)
          && !path.isAbsolute(relative)
          ? relative.split(path.sep).join("/")
          : undefined;
        return classifyStudioGlobalImage({
          sourceBasename: origin.sourceBasename,
          ...(projectRelativePath
            ? { projectRelativePath }
            : { sourcePath: origin.sourcePath }),
          canonicalAssociations,
        });
      })
    : [classifyStudioGlobalImage({
        sourceBasename: image.sourceBasename,
        canonicalAssociations,
      })];
  const originRoles = orderedRoles(candidates.map((entry) => entry.resourceRole));
  if (canonicalAssociations.length || candidates.length === 1) {
    return { classification: candidates[0]!, originRoles };
  }

  const tags = [...new Set(candidates.flatMap((entry) => entry.contentTags))]
    .sort((left, right) => (
      ["character", "scene", "prop", "style"].indexOf(left)
      - ["character", "scene", "prop", "style"].indexOf(right)
    ));
  const nonOtherPrimary = new Set(candidates
    .map((entry) => entry.primaryCategory)
    .filter((category) => category !== "other"));
  const semanticPrimary = [...nonOtherPrimary].filter((category) => (
    category === "character"
    || category === "scene"
    || category === "prop"
    || category === "style"
  ));
  const storyboard = nonOtherPrimary.has("storyboard");
  const reference = nonOtherPrimary.has("reference");
  const primaryCategory: StudioGlobalImagePrimaryCategory = storyboard
    ? "storyboard"
    : semanticPrimary.length === 1
      ? semanticPrimary[0]!
      : semanticPrimary.length > 1
        ? "other"
        : reference
          ? "reference"
          : "other";
  const conflicting = semanticPrimary.length > 1
    || (storyboard && reference)
    || (semanticPrimary.length > 0 && reference);
  const best = [...candidates].sort((left, right) => right.confidence - left.confidence)[0]!;
  return {
    classification: {
      primaryCategory,
      contentTags: tags,
      resourceRole: originRoles[0] ?? best.resourceRole,
      classificationState: conflicting || tags.length > 1
        ? "metadata-ambiguous"
        : best.classificationState,
      confidence: conflicting || tags.length > 1
        ? Math.min(0.55, best.confidence)
        : best.confidence,
      evidence: [...new Set([
        ...candidates.flatMap((entry) => entry.evidence),
        `origin-aggregate:${candidates.length}`,
        ...(conflicting ? [`conflict:origins:${[...nonOtherPrimary].sort().join(",")}`] : []),
      ])],
      classifierVersion: STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION,
    },
    originRoles,
  };
}

function humanizeSourceName(value: string): string {
  const withoutExtension = value.replace(/\.[^.]+$/u, "");
  const withoutRole = withoutExtension.replace(/(?:[_\s.-]+)(?:raw|labeled)$/iu, "");
  const withoutDigest = withoutRole.replace(/(?:[_\s.-]+)[a-f0-9]{8,64}$/iu, "");
  return withoutDigest.trim() || withoutExtension;
}

function displayName(
  image: GroupedImageRow,
  associations: GlobalStudioAssetResourceAssociation[],
  sourceNames: string[],
): string {
  const assetNames = [...new Set(associations.map((entry) => entry.name).filter(Boolean))];
  if (assetNames.length) return assetNames.join(" / ");
  const candidates = [...new Set([image.sourceBasename, ...sourceNames])]
    .map(humanizeSourceName)
    .filter(Boolean)
    .sort((left, right) => (
      left.length - right.length
      || left.localeCompare(right, "zh-CN")
    ));
  return candidates[0] ?? image.sourceBasename;
}

function latestTimestamp(values: string[], fallback: string): string {
  return values.filter(Boolean).sort().at(-1) ?? fallback;
}

export function buildGlobalStudioImageResourceProjectItems(
  db: DatabaseSync,
  project: GlobalStudioImageResourceProjectionProject,
): GlobalStudioImageResourceSnapshotItem[] {
  const associations = loadAssociations(db);
  return loadImages(db).map((image) => {
    const imageAssociations = associations.get(image.mediaSha256) ?? [];
    const classified = aggregateOriginClassifications(
      image,
      path.resolve(project.primaryRoot),
      imageAssociations,
    );
    const sourceNames = [...new Set([
      image.sourceBasename,
      ...image.origins.map((origin) => origin.sourceBasename),
    ])].sort((left, right) => left.localeCompare(right, "zh-CN"));
    const updatedAt = latestTimestamp([
      image.createdAt,
      ...image.origins.map((origin) => origin.importedAt),
      ...imageAssociations.map((association) => association.createdAt),
    ], image.createdAt);
    const item: GlobalStudioImageResourceSnapshotItem = {
      sourceProject: {
        id: project.id,
        name: project.name,
        primaryRoot: path.resolve(project.primaryRoot),
        updatedAt: project.updatedAt,
      },
      projectKey: project.projectKey,
      mediaSha256: image.mediaSha256,
      displayName: displayName(image, imageAssociations, sourceNames),
      sourceBasename: image.sourceBasename,
      sourceNames,
      originCount: image.origins.length,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      thumbnailRecipeKey: image.thumbnailRecipeKey,
      classification: classified.classification,
      originRoles: classified.originRoles,
      associations: imageAssociations,
      createdAt: image.createdAt,
      updatedAt,
      fingerprintPayload: {
        projectKey: project.projectKey,
        mediaSha256: image.mediaSha256,
        sourceBasename: image.sourceBasename,
        sourceNames,
        origins: image.origins.map((origin) => ({
          id: origin.id,
          sourcePath: origin.sourcePath,
          importedAt: origin.importedAt,
        })),
        associations: imageAssociations,
        classification: classified.classification,
      },
    };
    return item;
  });
}

function emptyCounts(): GlobalStudioImageResourceCounts {
  return {
    total: 0,
    uniqueContent: 0,
    character: 0,
    scene: 0,
    prop: 0,
    style: 0,
    storyboard: 0,
    reference: 0,
    other: 0,
  };
}

function emptyRoleCounts(): GlobalStudioImageResourceRoleCounts {
  return {
    "asset-reference": 0,
    raw: 0,
    labeled: 0,
    "source-original": 0,
    "storyboard-grid": 0,
    "shot-frame": 0,
    "poster-cover": 0,
    reference: 0,
    other: 0,
  };
}

function emptyStateCounts(): GlobalStudioImageClassificationStateCounts {
  return {
    canonical: 0,
    "metadata-high": 0,
    "metadata-ambiguous": 0,
    "visual-pending": 0,
    manual: 0,
  };
}

function matchesSearch(item: GlobalStudioImageResourceItem, search: string): boolean {
  if (!search) return true;
  return [
    item.displayName,
    item.sourceBasename,
    ...item.sourceNames,
    item.mediaSha256,
    item.mimeType,
    item.sourceProject.id,
    item.sourceProject.name,
    ...item.associations.flatMap((association) => [
      association.name,
      association.description,
      association.sourceNote,
      association.assetId,
      association.versionId,
    ]),
  ].some((value) => value.normalize("NFKC").toLocaleLowerCase("zh-CN").includes(search));
}

function afterCursor(
  item: GlobalStudioImageResourceSnapshotItem,
  cursor: CatalogCursor | undefined,
): boolean {
  if (!cursor) return true;
  return item.projectKey > cursor.projectKey
    || (item.projectKey === cursor.projectKey && item.mediaSha256 > cursor.mediaSha256);
}

function clonePublicItem(
  item: GlobalStudioImageResourceSnapshotItem,
): GlobalStudioImageResourceItem {
  return {
    sourceProject: { ...item.sourceProject },
    mediaSha256: item.mediaSha256,
    displayName: item.displayName,
    sourceBasename: item.sourceBasename,
    sourceNames: [...item.sourceNames],
    originCount: item.originCount,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    thumbnailRecipeKey: item.thumbnailRecipeKey,
    classification: {
      ...item.classification,
      contentTags: [...item.classification.contentTags],
      evidence: [...item.classification.evidence],
    },
    originRoles: [...item.originRoles],
    associations: item.associations.map((association) => ({ ...association })),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function summarizeSnapshotItems(items: GlobalStudioImageResourceSnapshotItem[]): {
  counts: GlobalStudioImageResourceCounts;
  roleCounts: GlobalStudioImageResourceRoleCounts;
  classificationStateCounts: GlobalStudioImageClassificationStateCounts;
} {
  const counts = emptyCounts();
  const roleCounts = emptyRoleCounts();
  const classificationStateCounts = emptyStateCounts();
  const uniqueSha = new Set<string>();
  for (const item of items) {
    counts.total += 1;
    counts[item.classification.primaryCategory] += 1;
    roleCounts[item.classification.resourceRole] += 1;
    classificationStateCounts[item.classification.classificationState] += 1;
    uniqueSha.add(item.mediaSha256);
  }
  counts.uniqueContent = uniqueSha.size;
  return { counts, roleCounts, classificationStateCounts };
}

function fingerprintSnapshot(
  projects: GlobalStudioImageResourceProjectionProject[],
  items: GlobalStudioImageResourceSnapshotItem[],
): string {
  const catalogFingerprint = createHash("sha256");
  catalogFingerprint.update(stableJson(projects.map((project) => ({
    id: project.id,
    name: project.name,
    primaryRoot: project.primaryRoot,
    updatedAt: project.updatedAt,
    projectKey: project.projectKey,
  }))), "utf8");
  for (const item of items) {
    catalogFingerprint.update("\0", "utf8");
    catalogFingerprint.update(stableJson(item.fingerprintPayload), "utf8");
  }
  return catalogFingerprint.digest("hex");
}

export function finalizeGlobalStudioImageResourceSnapshotProjection(input: {
  projects: GlobalStudioImageResourceProjectionProject[];
  items: GlobalStudioImageResourceSnapshotItem[];
  readableProjectRoots: Set<string>;
  readableProjectCount: number;
  unavailableProjects: GlobalStudioImageResourcePage["unavailableProjects"];
}): GlobalStudioImageResourceSnapshotProjection {
  const items = [...input.items].sort((left, right) => (
    left.projectKey.localeCompare(right.projectKey)
    || left.mediaSha256.localeCompare(right.mediaSha256)
  ));
  return {
    items,
    readableProjectRoots: new Set(input.readableProjectRoots),
    readableProjectCount: input.readableProjectCount,
    unavailableProjects: input.unavailableProjects.map((project) => ({ ...project })),
    ...summarizeSnapshotItems(items),
    catalogFingerprint: fingerprintSnapshot(input.projects, items),
  };
}

export function listGlobalStudioImageResourcesFromSnapshot(
  projects: GlobalStudioImageResourceProjectionProject[],
  snapshot: GlobalStudioImageResourceSnapshotProjection,
  query: GlobalStudioImageResourceQuery,
): GlobalStudioImageResourcePage {
  const category = normalizeCategory(query.category);
  const search = normalizeSearch(query.search);
  const limit = normalizeLimit(query.limit);
  const fingerprint = snapshot.catalogFingerprint;
  const scope = cursorScope(category, search, fingerprint);
  const cursor = decodeCursor(query.cursor, scope);
  const matching = snapshot.items.filter((item) => (
    (category === "all" || item.classification.primaryCategory === category)
    && matchesSearch(item, search)
  ));
  const remaining = matching.filter((item) => afterCursor(item, cursor));
  const selected = remaining.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected.map(clonePublicItem),
    ...(remaining.length > limit && last ? {
      nextCursor: encodeCursor({
        v: 1,
        scope,
        projectKey: last.projectKey,
        mediaSha256: last.mediaSha256,
      }),
    } : {}),
    total: matching.length,
    counts: { ...snapshot.counts },
    roleCounts: { ...snapshot.roleCounts },
    classificationStateCounts: { ...snapshot.classificationStateCounts },
    projectImageEntries: snapshot.counts.total,
    uniqueContentSha256: snapshot.counts.uniqueContent,
    canonicalImageEntries: snapshot.classificationStateCounts.canonical,
    ordinaryImageEntries: snapshot.counts.total - snapshot.classificationStateCounts.canonical,
    registeredProjectCount: projects.length,
    readableProjectCount: snapshot.readableProjectCount,
    unavailableProjects: snapshot.unavailableProjects.map((project) => ({ ...project })),
    catalogFingerprint: fingerprint,
    classifierVersion: STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION,
  };
}

export function getGlobalStudioImageResourceFromSnapshot(
  projects: GlobalStudioImageResourceProjectionProject[],
  snapshot: GlobalStudioImageResourceSnapshotProjection,
  projectRoot: string,
  mediaSha256: string,
): GlobalStudioImageResourceItem | null {
  const resolvedRoot = path.resolve(projectRoot);
  if (!SHA256_PATTERN.test(mediaSha256)) throw new Error("总资源图片 SHA 无效。");
  const registration = projects.find((project) => project.primaryRoot === resolvedRoot);
  if (!registration) throw new Error("总资源图片来源工程未登记。");
  if (!snapshot.readableProjectRoots.has(resolvedRoot)) {
    const unavailable = snapshot.unavailableProjects.find((project) => (
      project.id === registration.id && project.name === registration.name
    ));
    if (unavailable?.reason === "not-managed") {
      throw new Error("总资源图片来源工程不是受管工程。");
    }
    throw new Error("总资源图片来源数据库无效。");
  }
  const item = snapshot.items.find((entry) => (
    entry.sourceProject.primaryRoot === resolvedRoot
    && entry.mediaSha256 === mediaSha256
  ));
  return item ? clonePublicItem(item) : null;
}
