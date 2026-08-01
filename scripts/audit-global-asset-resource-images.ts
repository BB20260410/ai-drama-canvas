import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listGlobalStudioAssetResourceImages,
  type GlobalStudioAssetCatalogCounts,
  type GlobalStudioAssetResourceAssociation,
  type GlobalStudioAssetResourceImageItem,
} from "../src/core/studio-global-asset-catalog.js";
import { getProjectRegistryPath, listRegisteredProjects } from "../src/core/sidecar.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.resolve(
  process.argv[2] || path.join(
    workspace,
    "docs",
    "evidence",
    "global-asset-resource-images-live-20260728.json",
  ),
);
const evidenceRoot = path.join(workspace, "docs", "evidence");
const relativeOutput = path.relative(evidenceRoot, outputPath);
if (relativeOutput === ".."
  || relativeOutput.startsWith(`..${path.sep}`)
  || path.isAbsolute(relativeOutput)) {
  throw new Error(`逐图资源实库证据必须写入 docs/evidence：${outputPath}`);
}
await access(outputPath).then(
  () => { throw new Error(`逐图资源实库证据已存在，拒绝覆盖：${outputPath}`); },
  () => undefined,
);
await mkdir(evidenceRoot, { recursive: true });

interface FileIdentity {
  sha256: string;
  sizeBytes: number;
  mtimeNs: string;
}

async function identity(filePath: string): Promise<FileIdentity> {
  const [bytes, metadata] = await Promise.all([
    readFile(filePath),
    stat(filePath, { bigint: true }),
  ]);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: Number(metadata.size),
    mtimeNs: metadata.mtimeNs.toString(),
  };
}

function assertCounts(
  label: string,
  actual: GlobalStudioAssetCatalogCounts,
  expected: GlobalStudioAssetCatalogCounts,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} 不符：${JSON.stringify(actual)}`);
  }
}

const registryPath = getProjectRegistryPath();
const registeredProjects = await listRegisteredProjects();
const databasePaths = registeredProjects.map((project) => (
  path.join(project.primaryRoot, ".aicanvas", "material-studio.sqlite")
));
const existingDatabasePaths: string[] = [];
for (const databasePath of databasePaths) {
  if (await access(databasePath).then(() => true, () => false)) existingDatabasePaths.push(databasePath);
}
const guardedPaths = [registryPath, ...existingDatabasePaths];
const before = await Promise.all(guardedPaths.map(identity));

const categories = ["character", "scene", "prop", "style"] as const;
const imageByKey = new Map<string, GlobalStudioAssetResourceImageItem>();
const associationByKey = new Map<string, GlobalStudioAssetResourceAssociation & { sourceProjectId: string }>();
const categoryTotals: Record<(typeof categories)[number], number> = {
  character: 0,
  scene: 0,
  prop: 0,
  style: 0,
};
const pageCounts: Record<(typeof categories)[number], number> = {
  character: 0,
  scene: 0,
  prop: 0,
  style: 0,
};
let canonicalAssetCounts: GlobalStudioAssetCatalogCounts | undefined;
let resourceCounts: GlobalStudioAssetCatalogCounts | undefined;
let imageCoverage: {
  totalImages: number;
  assetVersionImages: number;
  ordinaryImages: number;
} | undefined;
let registryFingerprint = "";
let readableProjectCount = 0;
let unavailableProjects: Array<{ id: string; name: string; reason: string }> = [];

for (const category of categories) {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await listGlobalStudioAssetResourceImages({
      category,
      limit: 36,
      ...(cursor ? { cursor } : {}),
    });
    pageCounts[category] += 1;
    categoryTotals[category] = page.total;
    canonicalAssetCounts ??= page.assetCounts;
    resourceCounts ??= page.resourceCounts;
    imageCoverage ??= page.imageCoverage;
    registryFingerprint ||= page.registryFingerprint;
    readableProjectCount = page.readableProjectCount;
    unavailableProjects = page.unavailableProjects;
    if (JSON.stringify(page.assetCounts) !== JSON.stringify(canonicalAssetCounts)
      || JSON.stringify(page.resourceCounts) !== JSON.stringify(resourceCounts)
      || JSON.stringify(page.imageCoverage) !== JSON.stringify(imageCoverage)
      || page.registryFingerprint !== registryFingerprint) {
      throw new Error("逐图资源跨分类/分页的全局摘要不稳定。");
    }
    if (page.items.length > 36) throw new Error(`逐图资源单页超过 36：${page.items.length}`);
    for (const item of page.items) {
      if (!/^[a-f0-9]{64}$/u.test(item.mediaSha256)) throw new Error("逐图资源含无效 SHA。");
      if (!item.thumbnailRecipeKey.trim()) throw new Error("逐图资源缺少缩略图 recipe。");
      if (!item.associations.length) throw new Error("逐图资源缺少名称/版本关联。");
      const imageKey = `${item.sourceProject.id}:${item.mediaSha256}`;
      imageByKey.set(imageKey, item);
      for (const association of item.associations) {
        if (!association.name.trim()) throw new Error(`逐图资源关联名称为空：${association.versionId}`);
        const associationKey = `${item.sourceProject.id}:${association.assetId}:${association.versionId}`;
        associationByKey.set(associationKey, {
          ...association,
          sourceProjectId: item.sourceProject.id,
        });
      }
    }
    const next = page.nextCursor;
    if (next && seenCursors.has(next)) throw new Error("逐图资源分页游标循环。");
    if (next) seenCursors.add(next);
    cursor = next;
  } while (cursor);
}

const after = await Promise.all(guardedPaths.map(identity));
if (JSON.stringify(after) !== JSON.stringify(before)) {
  throw new Error("逐图资源只读审计改写了工程数据库或注册表。");
}

const expectedAssetCounts = {
  total: 457,
  character: 338,
  scene: 65,
  prop: 51,
  style: 3,
};
const expectedResourceCounts = {
  total: 549,
  character: 396,
  scene: 100,
  prop: 50,
  style: 3,
};
assertCounts("资产实体统计", canonicalAssetCounts!, expectedAssetCounts);
assertCounts("逐图资源统计", resourceCounts!, expectedResourceCounts);
for (const category of categories) {
  if (categoryTotals[category] !== expectedResourceCounts[category]) {
    throw new Error(`${category} 逐图 total 不符：${categoryTotals[category]}`);
  }
}
if (imageByKey.size !== 549) throw new Error(`逐图资源实得 ${imageByKey.size}，预期 549。`);
if (associationByKey.size !== 552) throw new Error(`版本关联实得 ${associationByKey.size}，预期 552。`);

const reviewCounts = { pending: 0, approved: 0, rejected: 0 };
let primaryAssociations = 0;
for (const association of associationByKey.values()) {
  reviewCounts[association.reviewStatus] += 1;
  if (association.isPrimary) primaryAssociations += 1;
}
if (JSON.stringify(reviewCounts) !== JSON.stringify({ pending: 310, approved: 242, rejected: 0 })) {
  throw new Error(`Review 关联统计不符：${JSON.stringify(reviewCounts)}`);
}
if (primaryAssociations !== 148) {
  throw new Error(`Primary 关联统计不符：${primaryAssociations}`);
}

const evidence = {
  schemaVersion: 1,
  kind: "global-asset-resource-images-live-audit",
  status: "PASS",
  checkedAt: new Date().toISOString(),
  checks: {
    registeredProjects: registeredProjects.length,
    readableProjects: readableProjectCount,
    unavailableProjects,
    canonicalAssetCounts,
    resourceCounts,
    categoryQueryTotals: categoryTotals,
    uniqueProjectImageResources: imageByKey.size,
    versionAssociations: associationByKey.size,
    reviewAssociations: reviewCounts,
    primaryAssociations,
    imageCoverage,
    pageSizeLimit: 36,
    pagesRead: pageCounts,
    allNamesNonBlank: true,
    allSha256Valid: true,
    allThumbnailRecipesPresent: true,
    registryAndDatabasesUnchanged: true,
  },
  registryFingerprint,
  guardedFileCount: guardedPaths.length,
};
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify(evidence, null, 2));
