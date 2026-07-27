import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  getStudioCanonicalAsset,
  getStudioMedia,
  importStudioMedia,
  listStudioMediaImportOrigins,
  type StudioCanonicalAssetCategory,
  type StudioMediaImportOrigin,
  type StudioReviewStatus,
} from "./material-studio.js";
import { previewLocalCreativeProductionUnits } from "./local-creative-production-unit-preview.js";

const DEFAULT_MANIFEST_RELATIVE_PATH = "01_视觉资产锁/00_允许参考资产.json";
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_ASSETS = 1_000;
const MAX_FORBIDDEN_MARKERS = 256;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MANIFEST_ID_PATTERN = /^(?:CHAR|PROP|SCENE|STYLE|VFX)_[A-Z0-9_]+$/u;
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);

export type LocalCreativeApprovedReferenceCategory =
  | StudioCanonicalAssetCategory
  | "category-blocked";

export interface LocalCreativeApprovedReferenceManifestAsset {
  id: string;
  role: string;
  sourcePath: string;
  sourceBasename: string;
  declaredSha256: string;
  actualSha256: string;
  sizeBytes: number;
  usageCount: number;
  category: LocalCreativeApprovedReferenceCategory;
  categoryReason: string;
  canonicalAssetId?: string;
}

export interface LocalCreativeApprovedReferenceManifestProjection {
  schemaVersion: 1;
  kind: "local-creative-approved-reference-manifest";
  status: "verified";
  projectRoot: string;
  sourceRoot: string;
  sourceFingerprint: string;
  manifestPath: string;
  manifestSha256: string;
  manifestSchemaVersion: "1.0";
  manifestProject: string;
  policy: string;
  forbiddenReferenceMarkers: string[];
  unitCount: number;
  panelCount: number;
  declaredReferenceCount: number;
  assets: LocalCreativeApprovedReferenceManifestAsset[];
  fingerprint: string;
  builtAt: string;
}

export interface InspectLocalCreativeApprovedReferenceManifestInput {
  manifestRelativePath?: string;
  expectedSourceFingerprint?: string;
}

export interface StageLocalCreativeApprovedReferenceManifestInput
  extends InspectLocalCreativeApprovedReferenceManifestInput {
  /** UI/命令总线先 inspect 后执行时，必须带回用户实际核对过的清单 SHA。 */
  expectedManifestSha256?: string;
}

export interface LocalCreativeApprovedReferenceStagingAsset {
  id: string;
  role: string;
  sourcePath: string;
  mediaSha256: string;
  mediaStatus: "imported" | "origin-recorded" | "already-staged";
  category: LocalCreativeApprovedReferenceCategory;
  categoryStatus: "category-blocked" | "pending" | "already-reviewed";
  categoryReason: string;
  canonicalAssetId?: string;
  versionId?: string;
  reviewStatus?: StudioReviewStatus;
}

export interface LocalCreativeApprovedReferenceStagingResult {
  schemaVersion: 1;
  kind: "local-creative-approved-reference-staging-result";
  projectRoot: string;
  sourceFingerprint: string;
  manifestSha256: string;
  manifestProject: string;
  candidateCount: number;
  mediaCount: number;
  canonicalAssetCount: number;
  pendingVersionCount: number;
  blockedVfxCount: number;
  reviewedExistingCount: number;
  primaryAuthorityChanges: 0;
  assets: LocalCreativeApprovedReferenceStagingAsset[];
  fingerprint: string;
  stagedAt: string;
}

interface ParsedManifestAsset {
  id: string;
  role: string;
  sourcePath: string;
  declaredSha256: string;
}

interface ParsedManifest {
  schemaVersion: "1.0";
  project: string;
  policy: string;
  assets: ParsedManifestAsset[];
  forbiddenReferenceMarkers: string[];
}

function normalizedForDigest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedForDigest);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, normalizedForDigest(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalizedForDigest(value)), "utf8").digest("hex");
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 必须是非空字符串。`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${label} 超过 ${maxLength} 字符上限。`);
  }
  return normalized;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const normalizedExpected = [...expected].sort((left, right) => left.localeCompare(right, "en"));
  if (actual.length !== normalizedExpected.length
    || actual.some((key, index) => key !== normalizedExpected[index])) {
    throw new Error(`${label} 字段必须严格为：${normalizedExpected.join(", ")}。`);
  }
}

function assertStableIdentity(before: BigIntStats, after: BigIntStats, label: string): void {
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error(`${label} 在核验期间发生漂移。`);
  }
}

async function assertRegularNoSymlink(
  requestedPath: string,
  label: string,
): Promise<{ realPath: string; stats: BigIntStats }> {
  const absolutePath = path.resolve(requestedPath);
  const metadata = await lstat(absolutePath, { bigint: true });
  if (metadata.isSymbolicLink()) throw new Error(`${label} 禁止符号链接：${absolutePath}`);
  if (!metadata.isFile()) throw new Error(`${label} 必须是普通文件：${absolutePath}`);
  const canonicalPath = path.normalize(await realpath(absolutePath));
  if (canonicalPath !== path.normalize(absolutePath)) {
    throw new Error(`${label} 路径包含符号链接或非规范跳转：${absolutePath}`);
  }
  return { realPath: canonicalPath, stats: metadata };
}

async function hashStableRegularFile(
  requestedPath: string,
  label: string,
): Promise<{ realPath: string; sha256: string; sizeBytes: number }> {
  const before = await assertRegularNoSymlink(requestedPath, label);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(before.realPath);
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(chunk);
      sizeBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    });
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  const after = await lstat(before.realPath, { bigint: true });
  assertStableIdentity(before.stats, after, label);
  if (BigInt(sizeBytes) !== after.size) throw new Error(`${label} 读取字节数与文件大小不一致。`);
  return { realPath: before.realPath, sha256: hash.digest("hex"), sizeBytes };
}

function isStrictChildPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function categoryForManifestId(id: string): {
  category: LocalCreativeApprovedReferenceCategory;
  categoryReason: string;
} {
  if (id.startsWith("CHAR_")) {
    return { category: "character", categoryReason: "显式 CHAR_ 前缀映射为 character。" };
  }
  if (id.startsWith("SCENE_")) {
    return { category: "scene", categoryReason: "显式 SCENE_ 前缀映射为 scene。" };
  }
  if (id.startsWith("PROP_")) {
    return { category: "prop", categoryReason: "显式 PROP_ 前缀映射为 prop。" };
  }
  if (id.startsWith("STYLE_")) {
    return { category: "style", categoryReason: "显式 STYLE_ 前缀映射为 style。" };
  }
  if (id.startsWith("VFX_")) {
    return {
      category: "category-blocked",
      categoryReason: "VFX 没有受管规范分类；仅导入媒体，禁止映射为 character 或 style。",
    };
  }
  throw new Error(`允许参考资产 ID 缺少受支持的显式分类前缀：${id}`);
}

function canonicalAssetIdForManifestId(id: string): string {
  return `allowed-ref:${id.toLocaleLowerCase("en-US").replaceAll("_", "-")}`;
}

function parseManifest(value: unknown): ParsedManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("允许参考资产清单必须是 JSON 对象。");
  }
  const manifest = value as Record<string, unknown>;
  assertExactKeys(
    manifest,
    ["schema_version", "project", "policy", "assets", "forbidden_reference_markers"],
    "允许参考资产清单",
  );
  if (manifest.schema_version !== "1.0") {
    throw new Error("允许参考资产清单 schema_version 必须严格为 1.0。");
  }
  const project = requiredString(manifest.project, "project", 256);
  const policy = requiredString(manifest.policy, "policy", 4_000);
  if (!Array.isArray(manifest.assets) || !manifest.assets.length) {
    throw new Error("允许参考资产清单 assets 必须是非空数组。");
  }
  if (manifest.assets.length > MAX_ASSETS) {
    throw new Error(`允许参考资产清单 assets 超过 ${MAX_ASSETS} 项上限。`);
  }
  const assets = manifest.assets.map((raw, index): ParsedManifestAsset => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`assets[${index}] 必须是对象。`);
    }
    const asset = raw as Record<string, unknown>;
    assertExactKeys(asset, ["id", "role", "path", "sha256"], `assets[${index}]`);
    const id = requiredString(asset.id, `assets[${index}].id`, 128);
    if (!MANIFEST_ID_PATTERN.test(id)) {
      throw new Error(`assets[${index}].id 格式或显式分类前缀无效：${id}`);
    }
    const sourcePath = requiredString(asset.path, `assets[${index}].path`, 4_096);
    if (!path.isAbsolute(sourcePath)) {
      throw new Error(`assets[${index}].path 必须是绝对路径。`);
    }
    const declaredSha256 = requiredString(asset.sha256, `assets[${index}].sha256`, 64);
    if (!SHA256_PATTERN.test(declaredSha256)) {
      throw new Error(`assets[${index}].sha256 必须是小写 SHA-256。`);
    }
    return {
      id,
      role: requiredString(asset.role, `assets[${index}].role`, 512),
      sourcePath: path.normalize(path.resolve(sourcePath)),
      declaredSha256,
    };
  });
  const ids = new Set<string>();
  const paths = new Set<string>();
  const hashes = new Set<string>();
  for (const asset of assets) {
    if (ids.has(asset.id)) throw new Error(`允许参考资产 ID 重复：${asset.id}`);
    if (paths.has(asset.sourcePath)) throw new Error(`允许参考资产 path 重复：${asset.sourcePath}`);
    if (hashes.has(asset.declaredSha256)) {
      throw new Error(`允许参考资产 SHA-256 重复：${asset.declaredSha256}`);
    }
    ids.add(asset.id);
    paths.add(asset.sourcePath);
    hashes.add(asset.declaredSha256);
  }
  if (!Array.isArray(manifest.forbidden_reference_markers)) {
    throw new Error("forbidden_reference_markers 必须是数组。");
  }
  if (manifest.forbidden_reference_markers.length > MAX_FORBIDDEN_MARKERS) {
    throw new Error(`forbidden_reference_markers 超过 ${MAX_FORBIDDEN_MARKERS} 项上限。`);
  }
  const forbiddenReferenceMarkers = manifest.forbidden_reference_markers.map((raw, index) => (
    requiredString(raw, `forbidden_reference_markers[${index}]`, 256)
  ));
  const normalizedMarkers = forbiddenReferenceMarkers.map((marker) => marker.toLocaleLowerCase("en-US"));
  if (new Set(normalizedMarkers).size !== normalizedMarkers.length) {
    throw new Error("forbidden_reference_markers 含大小写等价重复项。");
  }
  return {
    schemaVersion: "1.0",
    project,
    policy,
    assets,
    forbiddenReferenceMarkers,
  };
}

function assertReferenceSetEquality(
  manifestPaths: readonly string[],
  declaredPaths: readonly string[],
): void {
  const manifestSet = new Set(manifestPaths);
  const declaredSet = new Set(declaredPaths);
  const missingFromManifest = [...declaredSet]
    .filter((entry) => !manifestSet.has(entry))
    .sort((left, right) => left.localeCompare(right, "en"));
  const unusedManifestEntries = [...manifestSet]
    .filter((entry) => !declaredSet.has(entry))
    .sort((left, right) => left.localeCompare(right, "en"));
  if (missingFromManifest.length || unusedManifestEntries.length) {
    throw new Error([
      "允许参考资产清单与生产单元 declared refs 集合不相等。",
      `清单缺失：${missingFromManifest.join(", ") || "无"}`,
      `单元未引用：${unusedManifestEntries.join(", ") || "无"}`,
    ].join(" "));
  }
}

export async function inspectLocalCreativeApprovedReferenceManifest(
  projectRoot: string,
  input: InspectLocalCreativeApprovedReferenceManifestInput = {},
): Promise<LocalCreativeApprovedReferenceManifestProjection> {
  const preview = await previewLocalCreativeProductionUnits(projectRoot, {
    expectedSourceFingerprint: input.expectedSourceFingerprint,
  });
  if (preview.applicability !== "eligible" || !preview.sourceRoot || !preview.sourceFingerprint) {
    throw new Error(`当前项目没有可核验的本机剧情生产单元：${preview.reasonCode ?? preview.applicability}`);
  }
  const sourceRoot = path.normalize(await realpath(preview.sourceRoot));
  const manifestRelativePath = input.manifestRelativePath?.trim() || DEFAULT_MANIFEST_RELATIVE_PATH;
  if (path.isAbsolute(manifestRelativePath)) {
    throw new Error("manifestRelativePath 必须是来源目录内的相对路径。");
  }
  const requestedManifestPath = path.resolve(sourceRoot, manifestRelativePath);
  if (!isStrictChildPath(sourceRoot, requestedManifestPath)) {
    throw new Error("允许参考资产清单路径越界。");
  }
  const manifestFile = await assertRegularNoSymlink(requestedManifestPath, "允许参考资产清单");
  if (manifestFile.stats.size > BigInt(MAX_MANIFEST_BYTES)) {
    throw new Error(`允许参考资产清单超过 ${MAX_MANIFEST_BYTES} 字节上限。`);
  }
  const manifestBytes = await readFile(manifestFile.realPath);
  const afterManifestRead = await lstat(manifestFile.realPath, { bigint: true });
  assertStableIdentity(manifestFile.stats, afterManifestRead, "允许参考资产清单");
  let decoded: unknown;
  try {
    decoded = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("允许参考资产清单不是有效 JSON。", { cause: error });
  }
  const parsed = parseManifest(decoded);
  const normalizedMarkers = parsed.forbiddenReferenceMarkers
    .map((marker) => marker.toLocaleLowerCase("en-US"));
  const declaredUsage = new Map<string, number>();
  for (const unit of preview.units) {
    for (const panel of unit.panels) {
      for (const rawReferencePath of panel.sourceDeclaredReferencePaths) {
        if (!path.isAbsolute(rawReferencePath)) {
          throw new Error(`${unit.sourceUnitId}/${panel.sourcePanelId} declared ref 必须是绝对路径。`);
        }
        const referencePath = path.normalize(path.resolve(rawReferencePath));
        declaredUsage.set(referencePath, (declaredUsage.get(referencePath) ?? 0) + 1);
      }
    }
  }
  assertReferenceSetEquality(
    parsed.assets.map((asset) => asset.sourcePath),
    [...declaredUsage.keys()],
  );
  const assets: LocalCreativeApprovedReferenceManifestAsset[] = [];
  for (const asset of parsed.assets) {
    const forbiddenSurface = `${asset.id}\n${asset.role}\n${asset.sourcePath}`.toLocaleLowerCase("en-US");
    const matchedMarker = normalizedMarkers.find((marker) => forbiddenSurface.includes(marker));
    if (matchedMarker) {
      throw new Error(`允许参考资产命中禁止标记 ${matchedMarker}：${asset.sourcePath}`);
    }
    const extension = path.extname(asset.sourcePath).toLocaleLowerCase("en-US");
    if (!IMAGE_EXTENSIONS.has(extension)) {
      throw new Error(`允许参考资产必须是受支持的图片文件：${asset.sourcePath}`);
    }
    const verified = await hashStableRegularFile(asset.sourcePath, `允许参考资产 ${asset.id}`);
    if (verified.realPath !== asset.sourcePath) {
      throw new Error(`允许参考资产 ${asset.id} 路径包含符号链接或非规范跳转。`);
    }
    if (verified.sha256 !== asset.declaredSha256) {
      throw new Error(
        `允许参考资产 ${asset.id} SHA-256 不匹配：期望 ${asset.declaredSha256}，实际 ${verified.sha256}。`,
      );
    }
    const category = categoryForManifestId(asset.id);
    assets.push({
      id: asset.id,
      role: asset.role,
      sourcePath: verified.realPath,
      sourceBasename: path.basename(verified.realPath),
      declaredSha256: asset.declaredSha256,
      actualSha256: verified.sha256,
      sizeBytes: verified.sizeBytes,
      usageCount: declaredUsage.get(asset.sourcePath) ?? 0,
      category: category.category,
      categoryReason: category.categoryReason,
      ...(category.category !== "category-blocked"
        ? { canonicalAssetId: canonicalAssetIdForManifestId(asset.id) }
        : {}),
    });
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "local-creative-approved-reference-manifest" as const,
    status: "verified" as const,
    projectRoot: path.normalize(await realpath(projectRoot)),
    sourceRoot,
    sourceFingerprint: preview.sourceFingerprint,
    manifestPath: manifestFile.realPath,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    manifestSchemaVersion: parsed.schemaVersion,
    manifestProject: parsed.project,
    policy: parsed.policy,
    forbiddenReferenceMarkers: parsed.forbiddenReferenceMarkers,
    unitCount: preview.unitCount,
    panelCount: preview.panelCount,
    declaredReferenceCount: declaredUsage.size,
    assets,
  };
  return {
    ...body,
    fingerprint: digest(body),
    builtAt: new Date().toISOString(),
  };
}

function normalizedOriginSource(
  origin: StudioMediaImportOrigin,
  projectRoot: string,
): string {
  return origin.source.scope === "external"
    ? path.normalize(origin.source.absolutePath)
    : path.normalize(path.resolve(projectRoot, origin.source.projectRelativePath));
}

async function hasBoundImportOrigin(
  projectRoot: string,
  mediaSha256: string,
  sourcePath: string,
): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const page = await listStudioMediaImportOrigins(projectRoot, mediaSha256, {
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
    if (page.items.some((origin) => (
      normalizedOriginSource(origin, projectRoot) === sourcePath
      && origin.expectedSha256 === mediaSha256
    ))) {
      return true;
    }
    cursor = page.nextCursor;
  } while (cursor);
  return false;
}

async function stageMedia(
  projectRoot: string,
  asset: LocalCreativeApprovedReferenceManifestAsset,
): Promise<"imported" | "origin-recorded" | "already-staged"> {
  const existing = await getStudioMedia(projectRoot, asset.actualSha256);
  if (existing && await hasBoundImportOrigin(
    projectRoot,
    asset.actualSha256,
    asset.sourcePath,
  )) {
    return "already-staged";
  }
  const imported = await importStudioMedia(projectRoot, {
    sourcePath: asset.sourcePath,
    kind: "image",
    expectedSha256: asset.declaredSha256,
  });
  if (imported.sha256 !== asset.actualSha256 || imported.kind !== "image") {
    throw new Error(`允许参考资产 ${asset.id} 受管媒体登记结果不一致。`);
  }
  return existing ? "origin-recorded" : "imported";
}

async function stageCanonicalAsset(
  projectRoot: string,
  manifestProject: string,
  asset: LocalCreativeApprovedReferenceManifestAsset,
): Promise<{
  canonicalAssetId: string;
  versionId: string;
  reviewStatus: StudioReviewStatus;
  categoryStatus: "pending" | "already-reviewed";
}> {
  if (asset.category === "category-blocked" || !asset.canonicalAssetId) {
    throw new Error(`VFX 或未分类候选不得创建规范资产：${asset.id}`);
  }
  let canonical = await getStudioCanonicalAsset(projectRoot, asset.canonicalAssetId);
  if (!canonical) {
    canonical = await createStudioCanonicalAsset(projectRoot, {
      id: asset.canonicalAssetId,
      category: asset.category,
      name: asset.role,
      description: [
        `来自显式允许参考清单 ${manifestProject}/${asset.id}。`,
        "当前仅为待人工视觉审核候选；本暂存流程不会批准或提升主权威。",
      ].join(""),
      aliases: [asset.id],
      applicability: {
        tags: ["allowed-reference-manifest", "pending-visual-review"],
      },
      expectedRevision: 0,
    });
  }
  if (canonical.category !== asset.category || !canonical.aliases.includes(asset.id)) {
    throw new Error(`规范资产 ID 冲突，拒绝复用：${asset.canonicalAssetId}`);
  }
  const matching = canonical.versions.find((version) => version.mediaSha256 === asset.actualSha256);
  if (matching) {
    return {
      canonicalAssetId: canonical.id,
      versionId: matching.id,
      reviewStatus: matching.reviewStatus,
      categoryStatus: matching.reviewStatus === "pending" ? "pending" : "already-reviewed",
    };
  }
  if (canonical.versions.length || canonical.primaryAuthority) {
    throw new Error(`规范资产 ${canonical.id} 已有其他媒体版本，拒绝自动追加清单候选。`);
  }
  const appended = await appendStudioAssetVersion(projectRoot, {
    assetId: canonical.id,
    mediaSha256: asset.actualSha256,
    reviewStatus: "pending",
    sourceNote: `显式允许参考清单 ${manifestProject}/${asset.id}；SHA 已核验，仅暂存待人工视觉审核。`,
    expectedRevision: canonical.revision,
  });
  return {
    canonicalAssetId: canonical.id,
    versionId: appended.version.id,
    reviewStatus: appended.version.reviewStatus,
    categoryStatus: "pending",
  };
}

export async function stageLocalCreativeApprovedReferenceManifest(
  projectRoot: string,
  input: StageLocalCreativeApprovedReferenceManifestInput = {},
): Promise<LocalCreativeApprovedReferenceStagingResult> {
  const projection = await inspectLocalCreativeApprovedReferenceManifest(projectRoot, input);
  if (input.expectedManifestSha256 !== undefined) {
    const expectedManifestSha256 = input.expectedManifestSha256.trim();
    if (!SHA256_PATTERN.test(expectedManifestSha256)) {
      throw new Error("expectedManifestSha256 必须是 64 位小写 SHA-256。");
    }
    if (projection.manifestSha256 !== expectedManifestSha256) {
      throw new Error(
        `允许参考资产清单 SHA 已变化：期望 ${expectedManifestSha256}，实际 ${projection.manifestSha256}。`,
      );
    }
  }
  const assets: LocalCreativeApprovedReferenceStagingAsset[] = [];
  for (const candidate of projection.assets) {
    const mediaStatus = await stageMedia(projection.projectRoot, candidate);
    if (candidate.category === "category-blocked") {
      assets.push({
        id: candidate.id,
        role: candidate.role,
        sourcePath: candidate.sourcePath,
        mediaSha256: candidate.actualSha256,
        mediaStatus,
        category: candidate.category,
        categoryStatus: "category-blocked",
        categoryReason: candidate.categoryReason,
      });
      continue;
    }
    const canonical = await stageCanonicalAsset(
      projection.projectRoot,
      projection.manifestProject,
      candidate,
    );
    assets.push({
      id: candidate.id,
      role: candidate.role,
      sourcePath: candidate.sourcePath,
      mediaSha256: candidate.actualSha256,
      mediaStatus,
      category: candidate.category,
      categoryStatus: canonical.categoryStatus,
      categoryReason: candidate.categoryReason,
      canonicalAssetId: canonical.canonicalAssetId,
      versionId: canonical.versionId,
      reviewStatus: canonical.reviewStatus,
    });
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "local-creative-approved-reference-staging-result" as const,
    projectRoot: projection.projectRoot,
    sourceFingerprint: projection.sourceFingerprint,
    manifestSha256: projection.manifestSha256,
    manifestProject: projection.manifestProject,
    candidateCount: assets.length,
    mediaCount: assets.length,
    canonicalAssetCount: assets.filter((asset) => asset.canonicalAssetId).length,
    pendingVersionCount: assets.filter((asset) => asset.reviewStatus === "pending").length,
    blockedVfxCount: assets.filter((asset) => asset.category === "category-blocked").length,
    reviewedExistingCount: assets.filter((asset) => asset.categoryStatus === "already-reviewed").length,
    primaryAuthorityChanges: 0 as const,
    assets,
  };
  return {
    ...body,
    fingerprint: digest(body),
    stagedAt: new Date().toISOString(),
  };
}
