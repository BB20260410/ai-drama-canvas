/**
 * P6.5 跨工程资产复用。
 *
 * 合同：
 * - 导出是源工程只读、内容寻址、冻结包；不写源 SQLite/CAS。
 * - 导入只把媒体和定义复制到目标工程，版本一律 pending。
 * - 不跨库直读、不建立外键、不自动 Review/Primary、不做活体同步。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  getStudioCanonicalAsset,
  getStudioCanonicalAssetKnowledgeSnapshot,
  getStudioMedia,
  importStudioMedia,
  MaterialStudioConflictError,
  type StudioAssetApplicability,
  type StudioCanonicalAssetCategory,
  type StudioCanonicalAssetDetail,
} from "./material-studio.js";
import { inspectManagedProjectReadOnly } from "./managed-project.js";

export const CROSS_PROJECT_ASSET_REUSE_SCHEMA_VERSION = 1 as const;
export const CROSS_PROJECT_ASSET_REUSE_MANIFEST_NAME = "manifest.json" as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export interface CrossProjectAssetDefinitionSnapshot {
  category: StudioCanonicalAssetCategory;
  name: string;
  description: string;
  aliases: string[];
  identityFeatures: string[];
  positiveLocks: string[];
  negativeLocks: string[];
  defaultPrompt: string;
  applicability: StudioAssetApplicability;
}

export interface CrossProjectAssetExportItem {
  assetId: string;
  assetCategory: StudioCanonicalAssetCategory;
  versionId: string;
  versionOrdinal: number;
  mediaSha256: string;
  reviewStatus: "approved";
  isPrimaryAtExport: true;
  sourceReviewId: string;
  sourceAuthorityEventId: string;
  sourceAssetRevision: number;
  knowledgeSnapshotFingerprint: string;
  definitionSnapshot: CrossProjectAssetDefinitionSnapshot;
}

export interface CrossProjectAssetExportObject {
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  kind: "image";
  relativePath: string;
}

export interface CrossProjectAssetExportManifest {
  schemaVersion: typeof CROSS_PROJECT_ASSET_REUSE_SCHEMA_VERSION;
  kind: "cross-project-asset-export-manifest";
  exportId: string;
  exportedAt: string;
  sourceProjectId: string;
  sourceManifestFingerprint: string;
  items: CrossProjectAssetExportItem[];
  objects: CrossProjectAssetExportObject[];
  fingerprint: string;
}

export interface ExportStudioCrossProjectAssetPackageInput {
  items: Array<{ assetId: string; expectedRevision: number }>;
  outputPackageRoot: string;
}

export interface ExportStudioCrossProjectAssetPackageResult {
  schemaVersion: 1;
  kind: "cross-project-asset-export-result";
  packageRoot: string;
  manifest: CrossProjectAssetExportManifest;
  itemCount: number;
  objectCount: number;
  sealedReadOnly: true;
}

export interface ImportStudioCrossProjectAssetPackageInput {
  packageRoot: string;
  expectedPackageFingerprint: string;
  expectedSourceProjectId: string;
  sourceAssetId: string;
  sourceVersionId: string;
  targetAssetId?: string;
  targetExpectedRevision: number;
  targetCategory?: StudioCanonicalAssetCategory;
  targetName?: string;
}

export interface ImportStudioCrossProjectAssetPackageResult {
  schemaVersion: 1;
  kind: "cross-project-asset-import-result";
  packageFingerprint: string;
  sourceProjectId: string;
  sourceAssetId: string;
  sourceVersionId: string;
  targetAssetId: string;
  targetAssetRevision: number;
  targetVersionId: string;
  mediaSha256: string;
  reviewStatus: "pending" | "approved" | "rejected";
  disposition: "imported-pending" | "already-imported";
  reviewRequired: true;
  primaryPromotionRequired: true;
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
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function pathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function requireAbsolutePath(value: string, field: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${field} 必须是绝对路径。`);
  }
  return path.resolve(value);
}

function requireSha256(value: string, field: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${field} 必须是小写 SHA-256。`);
  return value;
}

function requireStableId(value: string, field: string): string {
  if (!STABLE_ID_PATTERN.test(value)) throw new Error(`${field} 格式无效。`);
  return value;
}

async function sha256File(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const before = await lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error(`复用包对象必须是单链接普通文件：${filePath}`);
  }
  const bytes = await readFile(filePath);
  const after = await lstat(filePath, { bigint: true });
  if (before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
    || BigInt(bytes.byteLength) !== before.size) {
    throw new Error(`复用包对象读取期间发生漂移：${filePath}`);
  }
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

function manifestSemantic(
  manifest: Omit<CrossProjectAssetExportManifest, "fingerprint">,
): Omit<CrossProjectAssetExportManifest, "fingerprint"> {
  return manifest;
}

function sourceManifestFingerprint(items: CrossProjectAssetExportItem[]): string {
  return digest(items.map((item) => ({
    assetId: item.assetId,
    versionId: item.versionId,
    mediaSha256: item.mediaSha256,
    sourceAssetRevision: item.sourceAssetRevision,
    knowledgeSnapshotFingerprint: item.knowledgeSnapshotFingerprint,
  })));
}

function assertDefinitionSnapshot(value: unknown): asserts value is CrossProjectAssetDefinitionSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("复用包 definitionSnapshot 缺失。");
  }
  const item = value as Partial<CrossProjectAssetDefinitionSnapshot>;
  if (!["character", "scene", "prop", "style"].includes(String(item.category))
    || typeof item.name !== "string"
    || typeof item.description !== "string"
    || !Array.isArray(item.aliases)
    || !Array.isArray(item.identityFeatures)
    || !Array.isArray(item.positiveLocks)
    || !Array.isArray(item.negativeLocks)
    || typeof item.defaultPrompt !== "string"
    || !item.applicability
    || typeof item.applicability !== "object") {
    throw new Error("复用包 definitionSnapshot 字段非法。");
  }
}

export function assertCrossProjectAssetExportManifest(
  raw: unknown,
): CrossProjectAssetExportManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("复用包 manifest 不是对象。");
  }
  const value = raw as Partial<CrossProjectAssetExportManifest>;
  if (value.schemaVersion !== 1
    || value.kind !== "cross-project-asset-export-manifest"
    || typeof value.exportId !== "string"
    || typeof value.exportedAt !== "string"
    || typeof value.sourceProjectId !== "string"
    || typeof value.sourceManifestFingerprint !== "string"
    || !Array.isArray(value.items)
    || !Array.isArray(value.objects)
    || typeof value.fingerprint !== "string") {
    throw new Error("复用包 manifest 字段不完整。");
  }
  requireStableId(value.exportId, "manifest.exportId");
  requireStableId(value.sourceProjectId, "manifest.sourceProjectId");
  requireSha256(value.sourceManifestFingerprint, "manifest.sourceManifestFingerprint");
  requireSha256(value.fingerprint, "manifest.fingerprint");
  if (value.items.length < 1 || value.items.length > 100) {
    throw new Error("复用包 items 必须为 1–100 项。");
  }
  if (value.objects.length < 1 || value.objects.length > 100) {
    throw new Error("复用包 objects 必须为 1–100 项。");
  }
  const itemKeys = new Set<string>();
  for (const item of value.items) {
    if (!item || typeof item !== "object") throw new Error("复用包 item 非法。");
    requireStableId(item.assetId, "manifest.item.assetId");
    requireStableId(item.versionId, "manifest.item.versionId");
    requireStableId(item.sourceReviewId, "manifest.item.sourceReviewId");
    requireStableId(item.sourceAuthorityEventId, "manifest.item.sourceAuthorityEventId");
    requireSha256(item.mediaSha256, "manifest.item.mediaSha256");
    requireSha256(item.knowledgeSnapshotFingerprint, "manifest.item.knowledgeSnapshotFingerprint");
    if (!["character", "scene", "prop", "style"].includes(item.assetCategory)
      || item.reviewStatus !== "approved"
      || item.isPrimaryAtExport !== true
      || !Number.isSafeInteger(item.versionOrdinal)
      || item.versionOrdinal < 1
      || !Number.isSafeInteger(item.sourceAssetRevision)
      || item.sourceAssetRevision < 1) {
      throw new Error(`复用包 item 状态非法：${item.assetId}`);
    }
    assertDefinitionSnapshot(item.definitionSnapshot);
    const key = `${item.assetId}\u0000${item.versionId}`;
    if (itemKeys.has(key)) throw new Error(`复用包 item 重复：${item.assetId}/${item.versionId}`);
    itemKeys.add(key);
  }
  const objectHashes = new Set<string>();
  for (const object of value.objects) {
    requireSha256(object.sha256, "manifest.object.sha256");
    if (object.kind !== "image"
      || typeof object.mimeType !== "string"
      || !Number.isSafeInteger(object.sizeBytes)
      || object.sizeBytes < 1
      || object.relativePath !== `objects/sha256/${object.sha256.slice(0, 2)}/${object.sha256}`) {
      throw new Error(`复用包 object 字段非法：${object.sha256}`);
    }
    if (objectHashes.has(object.sha256)) throw new Error(`复用包 object 重复：${object.sha256}`);
    objectHashes.add(object.sha256);
  }
  for (const item of value.items) {
    if (!objectHashes.has(item.mediaSha256)) {
      throw new Error(`复用包 item 缺少对象：${item.mediaSha256}`);
    }
  }
  if (sourceManifestFingerprint(value.items) !== value.sourceManifestFingerprint) {
    throw new Error("复用包 sourceManifestFingerprint 漂移。");
  }
  const { fingerprint, ...semantic } = value as CrossProjectAssetExportManifest;
  if (digest(manifestSemantic(semantic)) !== fingerprint) {
    throw new Error("复用包 manifest fingerprint 漂移。");
  }
  return value as CrossProjectAssetExportManifest;
}

async function readManifest(packageRoot: string): Promise<CrossProjectAssetExportManifest> {
  const resolved = requireAbsolutePath(packageRoot, "packageRoot");
  const rootStat = await lstat(resolved);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(resolved) !== resolved) {
    throw new Error("复用包根必须是规范真实目录，禁止符号链接。");
  }
  const manifestPath = path.join(resolved, CROSS_PROJECT_ASSET_REUSE_MANIFEST_NAME);
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 4 * 1024 * 1024) {
    throw new Error("复用包 manifest 必须是有界普通文件。");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error("复用包 manifest 无法解析。", { cause: error });
  }
  return assertCrossProjectAssetExportManifest(raw);
}

/** UI/MCP 导入前只读盘点；逐对象重算 SHA/size，不写任何工程。 */
export async function inspectStudioCrossProjectAssetPackage(
  packageRoot: string,
): Promise<{ packageRoot: string; manifest: CrossProjectAssetExportManifest }> {
  const resolved = requireAbsolutePath(packageRoot, "packageRoot");
  const manifest = await readManifest(resolved);
  for (const object of manifest.objects) {
    const objectPath = path.join(resolved, ...object.relativePath.split("/"));
    if (!pathInside(objectPath, resolved) || await realpath(objectPath) !== objectPath) {
      throw new Error(`复用包 object 路径非法或为符号链接：${object.sha256}`);
    }
    const verified = await sha256File(objectPath);
    if (verified.sha256 !== object.sha256 || verified.sizeBytes !== object.sizeBytes) {
      throw new Error(`复用包对象 SHA/size 漂移：${object.sha256}`);
    }
  }
  return { packageRoot: resolved, manifest };
}

async function sealReadOnly(root: string, objectPaths: string[]): Promise<void> {
  await chmod(path.join(root, CROSS_PROJECT_ASSET_REUSE_MANIFEST_NAME), 0o444);
  for (const objectPath of objectPaths) await chmod(objectPath, 0o444);
  const shardDirectories = [...new Set(objectPaths.map((objectPath) => path.dirname(objectPath)))];
  for (const directory of shardDirectories) await chmod(directory, 0o555);
  await chmod(path.join(root, "objects", "sha256"), 0o555);
  await chmod(path.join(root, "objects"), 0o555);
  await chmod(root, 0o555);
}

function definitionFromAsset(asset: StudioCanonicalAssetDetail): CrossProjectAssetDefinitionSnapshot {
  return {
    category: asset.category,
    name: asset.name,
    description: asset.description,
    aliases: [...asset.aliases],
    identityFeatures: [...asset.identityFeatures],
    positiveLocks: [...asset.positiveLocks],
    negativeLocks: [...asset.negativeLocks],
    defaultPrompt: asset.defaultPrompt,
    applicability: {
      projects: [...asset.applicability.projects],
      seasons: [...asset.applicability.seasons],
      episodes: [...asset.applicability.episodes],
      units: [...asset.applicability.units],
      timeRanges: asset.applicability.timeRanges.map((entry) => ({ ...entry })),
      tags: [...asset.applicability.tags],
    },
  };
}

export async function exportStudioCrossProjectAssetPackage(
  projectRoot: string,
  input: ExportStudioCrossProjectAssetPackageInput,
): Promise<ExportStudioCrossProjectAssetPackageResult> {
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const outputPackageRoot = requireAbsolutePath(input.outputPackageRoot, "outputPackageRoot");
  if (pathInside(outputPackageRoot, shell.paths.root)) {
    throw new Error("复用导出包不得写入源工程内部。");
  }
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) {
    throw new Error("items 必须是 1–100 项。");
  }
  const uniqueAssetIds = new Set(input.items.map((item) => item.assetId));
  if (uniqueAssetIds.size !== input.items.length) throw new Error("items.assetId 不得重复。");

  const parent = path.dirname(outputPackageRoot);
  await mkdir(parent, { recursive: true });
  const parentReal = await realpath(parent);
  if (path.dirname(outputPackageRoot) !== parentReal) {
    throw new Error("outputPackageRoot 父目录必须是规范真实路径。");
  }
  try {
    await lstat(outputPackageRoot);
    throw new Error(`复用导出目标已存在，拒绝覆盖：${outputPackageRoot}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw error;
    }
  }

  const stage = `${outputPackageRoot}.staging-${process.pid}-${randomUUID().slice(0, 8)}`;
  const exportItems: CrossProjectAssetExportItem[] = [];
  const objectSources = new Map<string, { sourcePath: string; object: CrossProjectAssetExportObject }>();
  try {
    await mkdir(path.join(stage, "objects", "sha256"), { recursive: true, mode: 0o700 });
    for (const requested of input.items) {
      requireStableId(requested.assetId, "items.assetId");
      if (!Number.isSafeInteger(requested.expectedRevision) || requested.expectedRevision < 1) {
        throw new Error(`expectedRevision 非法：${requested.assetId}`);
      }
      const [asset, knowledge] = await Promise.all([
        getStudioCanonicalAsset(shell.paths.root, requested.assetId),
        getStudioCanonicalAssetKnowledgeSnapshot(shell.paths.root, requested.assetId),
      ]);
      if (!asset || !knowledge) throw new Error(`源资产不存在：${requested.assetId}`);
      if (asset.revision !== requested.expectedRevision || knowledge.assetRevision !== requested.expectedRevision) {
        throw new MaterialStudioConflictError(requested.expectedRevision, asset.revision);
      }
      const primary = asset.primaryAuthority;
      if (!primary || knowledge.authorityVersionId !== primary.versionId
        || knowledge.authorityMediaSha256 !== primary.mediaSha256) {
        throw new Error(`源资产缺少 current Primary：${asset.id}`);
      }
      const version = asset.versions.find((entry) => entry.id === primary.versionId);
      if (!version || version.reviewStatus !== "approved") {
        throw new Error(`源资产 Primary 未经 approved Review：${asset.id}`);
      }
      const review = [...asset.reviewHistory].reverse()
        .find((entry) => entry.versionId === version.id && entry.toStatus === "approved");
      const authority = [...asset.authorityHistory].reverse()
        .find((entry) => entry.versionId === version.id);
      if (!review || !authority) {
        throw new Error(`源资产 Primary 缺少 Review/Authority 纸面链：${asset.id}`);
      }
      const media = await getStudioMedia(shell.paths.root, version.mediaSha256);
      if (!media || media.kind !== "image") throw new Error(`源资产媒体不存在或不是 image：${asset.id}`);
      const verified = await sha256File(media.objectPath);
      if (verified.sha256 !== media.sha256 || verified.sizeBytes !== media.sizeBytes) {
        throw new Error(`源资产媒体 CAS 漂移：${asset.id}`);
      }
      const relativePath = `objects/sha256/${media.sha256.slice(0, 2)}/${media.sha256}`;
      objectSources.set(media.sha256, {
        sourcePath: media.objectPath,
        object: {
          sha256: media.sha256,
          sizeBytes: media.sizeBytes,
          mimeType: media.mimeType,
          kind: "image",
          relativePath,
        },
      });
      exportItems.push({
        assetId: asset.id,
        assetCategory: asset.category,
        versionId: version.id,
        versionOrdinal: version.ordinal,
        mediaSha256: version.mediaSha256,
        reviewStatus: "approved",
        isPrimaryAtExport: true,
        sourceReviewId: review.id,
        sourceAuthorityEventId: authority.id,
        sourceAssetRevision: asset.revision,
        knowledgeSnapshotFingerprint: knowledge.fingerprint,
        definitionSnapshot: definitionFromAsset(asset),
      });
    }
    exportItems.sort((left, right) => left.assetId.localeCompare(right.assetId, "en"));
    const objects = [...objectSources.values()].map((entry) => entry.object)
      .sort((left, right) => left.sha256.localeCompare(right.sha256, "en"));
    const exportedAt = new Date().toISOString();
    const sourceFingerprint = sourceManifestFingerprint(exportItems);
    const exportId = `asset-export-${sourceFingerprint.slice(0, 32)}`;
    const semantic: Omit<CrossProjectAssetExportManifest, "fingerprint"> = {
      schemaVersion: 1,
      kind: "cross-project-asset-export-manifest",
      exportId,
      exportedAt,
      sourceProjectId: shell.project.id,
      sourceManifestFingerprint: sourceFingerprint,
      items: exportItems,
      objects,
    };
    const manifest: CrossProjectAssetExportManifest = {
      ...semantic,
      fingerprint: digest(manifestSemantic(semantic)),
    };
    const writtenObjects: string[] = [];
    for (const entry of objectSources.values()) {
      const destination = path.join(stage, ...entry.object.relativePath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(entry.sourcePath, destination);
      const verified = await sha256File(destination);
      if (verified.sha256 !== entry.object.sha256 || verified.sizeBytes !== entry.object.sizeBytes) {
        throw new Error(`导出对象复制后漂移：${entry.object.sha256}`);
      }
      writtenObjects.push(destination);
    }
    await writeFile(
      path.join(stage, CROSS_PROJECT_ASSET_REUSE_MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    assertCrossProjectAssetExportManifest(JSON.parse(
      await readFile(path.join(stage, CROSS_PROJECT_ASSET_REUSE_MANIFEST_NAME), "utf8"),
    ));
    await sealReadOnly(stage, writtenObjects);
    await rename(stage, outputPackageRoot);
    return {
      schemaVersion: 1,
      kind: "cross-project-asset-export-result",
      packageRoot: outputPackageRoot,
      manifest,
      itemCount: exportItems.length,
      objectCount: objects.length,
      sealedReadOnly: true,
    };
  } catch (error) {
    await chmod(stage, 0o700).catch(() => undefined);
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function importedTargetId(item: CrossProjectAssetExportItem, manifest: CrossProjectAssetExportManifest): string {
  const semantic = digest({
    sourceProjectId: manifest.sourceProjectId,
    sourceAssetId: item.assetId,
    sourceVersionId: item.versionId,
    mediaSha256: item.mediaSha256,
  });
  return `reuse-${item.assetCategory}-${semantic.slice(0, 32)}`;
}

function definitionMatches(
  asset: StudioCanonicalAssetDetail,
  definition: CrossProjectAssetDefinitionSnapshot,
  targetCategory: StudioCanonicalAssetCategory,
  targetName: string,
): boolean {
  const expectedAliases = [...new Set([targetName, ...definition.aliases])];
  return asset.category === targetCategory
    && asset.name === targetName
    && asset.description === definition.description
    && digest(asset.aliases) === digest(expectedAliases)
    && digest(asset.identityFeatures) === digest(definition.identityFeatures)
    && digest(asset.positiveLocks) === digest(definition.positiveLocks)
    && digest(asset.negativeLocks) === digest(definition.negativeLocks)
    && asset.defaultPrompt === definition.defaultPrompt;
}

export async function importStudioCrossProjectAssetPackage(
  projectRoot: string,
  input: ImportStudioCrossProjectAssetPackageInput,
): Promise<ImportStudioCrossProjectAssetPackageResult> {
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const packageRoot = requireAbsolutePath(input.packageRoot, "packageRoot");
  if (pathInside(packageRoot, shell.paths.root)) {
    throw new Error("复用导入包不得位于目标工程内部。");
  }
  const manifest = await readManifest(packageRoot);
  if (manifest.fingerprint !== requireSha256(input.expectedPackageFingerprint, "expectedPackageFingerprint")) {
    throw new Error("复用包 fingerprint 与调用预期不一致（input-drift）。");
  }
  if (manifest.sourceProjectId !== requireStableId(input.expectedSourceProjectId, "expectedSourceProjectId")) {
    throw new Error("复用包 sourceProjectId 与调用预期不一致（input-drift）。");
  }
  if (manifest.sourceProjectId === shell.project.id) {
    throw new Error("跨工程复用拒绝导回同一 projectId；当前工程内请直接追加版本。");
  }
  const sourceAssetId = requireStableId(input.sourceAssetId, "sourceAssetId");
  const sourceVersionId = requireStableId(input.sourceVersionId, "sourceVersionId");
  const item = manifest.items.find((candidate) =>
    candidate.assetId === sourceAssetId && candidate.versionId === sourceVersionId
  );
  if (!item) throw new Error(`复用包中不存在指定条目：${sourceAssetId}/${sourceVersionId}`);
  const object = manifest.objects.find((candidate) => candidate.sha256 === item.mediaSha256);
  if (!object) throw new Error(`复用包缺少媒体对象：${item.mediaSha256}`);
  const objectPath = path.join(packageRoot, ...object.relativePath.split("/"));
  if (!pathInside(objectPath, packageRoot)) throw new Error("复用包 object 路径逃逸。");
  const objectReal = await realpath(objectPath);
  if (objectReal !== objectPath) throw new Error("复用包 object 禁止符号链接。");
  const verified = await sha256File(objectPath);
  if (verified.sha256 !== object.sha256 || verified.sizeBytes !== object.sizeBytes) {
    throw new Error(`复用包对象 SHA/size 漂移：${object.sha256}`);
  }

  if (!Number.isSafeInteger(input.targetExpectedRevision) || input.targetExpectedRevision < 0) {
    throw new Error("targetExpectedRevision 必须是非负整数。");
  }
  const targetCategory = input.targetCategory ?? item.definitionSnapshot.category;
  const targetName = input.targetName?.trim() || item.definitionSnapshot.name;
  const targetAssetId = input.targetAssetId
    ? requireStableId(input.targetAssetId, "targetAssetId")
    : importedTargetId(item, manifest);
  let target = await getStudioCanonicalAsset(shell.paths.root, targetAssetId);
  if (target) {
    const existingVersion = target.versions.find((version) => version.mediaSha256 === item.mediaSha256);
    if (existingVersion) {
      return {
        schemaVersion: 1,
        kind: "cross-project-asset-import-result",
        packageFingerprint: manifest.fingerprint,
        sourceProjectId: manifest.sourceProjectId,
        sourceAssetId,
        sourceVersionId,
        targetAssetId,
        targetAssetRevision: target.revision,
        targetVersionId: existingVersion.id,
        mediaSha256: existingVersion.mediaSha256,
        reviewStatus: existingVersion.reviewStatus,
        disposition: "already-imported",
        reviewRequired: true,
        primaryPromotionRequired: true,
      };
    }
    const recoverableNewAsset = input.targetExpectedRevision === 0
      && target.revision === 1
      && target.versions.length === 0
      && definitionMatches(target, item.definitionSnapshot, targetCategory, targetName);
    if (!recoverableNewAsset && target.revision !== input.targetExpectedRevision) {
      throw new MaterialStudioConflictError(input.targetExpectedRevision, target.revision);
    }
    if (!definitionMatches(target, item.definitionSnapshot, targetCategory, targetName)) {
      throw new Error(`目标资产定义与复用包不一致，拒绝静默合并：${targetAssetId}`);
    }
  } else {
    if (input.targetExpectedRevision !== 0) {
      throw new MaterialStudioConflictError(input.targetExpectedRevision, 0);
    }
    target = await createStudioCanonicalAsset(shell.paths.root, {
      id: targetAssetId,
      category: targetCategory,
      name: targetName,
      description: item.definitionSnapshot.description,
      aliases: item.definitionSnapshot.aliases,
      identityFeatures: item.definitionSnapshot.identityFeatures,
      positiveLocks: item.definitionSnapshot.positiveLocks,
      negativeLocks: item.definitionSnapshot.negativeLocks,
      defaultPrompt: item.definitionSnapshot.defaultPrompt,
      applicability: item.definitionSnapshot.applicability,
      expectedRevision: 0,
    });
  }

  const media = await importStudioMedia(shell.paths.root, {
    sourcePath: objectPath,
    kind: "image",
    expectedSha256: item.mediaSha256,
  });
  const sourceNote = [
    "cross-project-asset-reuse-v1",
    `exportId=${manifest.exportId}`,
    `sourceProjectId=${manifest.sourceProjectId}`,
    `sourceAssetId=${item.assetId}`,
    `sourceVersionId=${item.versionId}`,
    `sourceReviewId=${item.sourceReviewId}`,
    `sourceAuthorityEventId=${item.sourceAuthorityEventId}`,
    `packageFingerprint=${manifest.fingerprint}`,
    "targetReviewRequired=true",
  ].join(";");
  const appended = await appendStudioAssetVersion(shell.paths.root, {
    assetId: targetAssetId,
    mediaSha256: media.sha256,
    reviewStatus: "pending",
    sourceNote,
    expectedRevision: target.revision,
  });
  return {
    schemaVersion: 1,
    kind: "cross-project-asset-import-result",
    packageFingerprint: manifest.fingerprint,
    sourceProjectId: manifest.sourceProjectId,
    sourceAssetId,
    sourceVersionId,
    targetAssetId,
    targetAssetRevision: appended.assetRevision,
    targetVersionId: appended.version.id,
    mediaSha256: appended.version.mediaSha256,
    reviewStatus: "pending",
    disposition: "imported-pending",
    reviewRequired: true,
    primaryPromotionRequired: true,
  };
}
