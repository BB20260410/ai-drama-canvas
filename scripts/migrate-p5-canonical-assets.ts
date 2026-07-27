import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import {
  getCanonicalAsset,
  getCanonicalAssetCatalogState,
  inspectCanonicalAssetStoreCurrentness,
  listCanonicalAssets,
  loadCanonicalAssetStore,
  migrateCanonicalAssets,
  previewCanonicalAssetMigration,
} from "../src/core/canonical-assets.js";
import { executeIdempotentCommand, listCommandLedger } from "../src/core/command-bus.js";
import { getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";

const positionalArguments = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
const projectRoot = path.resolve(path.join(process.cwd(), "productions", "gushujuan-s3-f1a688020bfb7af6"));
const evidencePath = path.resolve(positionalArguments[0] ?? path.join(process.cwd(), "docs", "evidence", "p5-canonical-migration-20260718-r3.json"));
const sourceRoot = path.resolve("/Users/hxx/Documents/古蜀卷第三季");
const execute = process.argv.includes("--execute");
const startedAt = new Date();

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function shaFile(filePath: string): Promise<string> {
  return sha(await readFile(filePath));
}

interface InventorySummary {
  root: string;
  fileCount: number;
  totalBytes: number;
  digest: string;
}

async function inventory(root: string, options: { contentHashes: boolean; excluded?: Set<string> }): Promise<InventorySummary> {
  const relativePaths = (await fg("**/*", { cwd: root, onlyFiles: true, dot: true, followSymbolicLinks: false, unique: true }))
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((entry) => !options.excluded?.has(entry))
    .sort((left, right) => left.localeCompare(right, "en"));
  let totalBytes = 0;
  const rows: Array<Record<string, string | number>> = [];
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(root, relativePath);
    const metadata = await stat(absolutePath, { bigint: true });
    const size = Number(metadata.size);
    totalBytes += size;
    rows.push({
      path: relativePath,
      size,
      mtimeNs: metadata.mtimeNs.toString(),
      ...(options.contentHashes ? { sha256: await shaFile(absolutePath) } : {}),
    });
  }
  return { root, fileCount: rows.length, totalBytes, digest: sha(stable(rows)) };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertEvidencePathAvailable(filePath: string): Promise<void> {
  try {
    await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`P5 迁移证据路径已存在，拒绝覆盖：${filePath}`);
}

const paths = getSidecarPaths(projectRoot);
const allowedProjectWrites = new Set([
  path.relative(projectRoot, paths.canonicalAssets).split(path.sep).join("/"),
  path.relative(projectRoot, paths.commandLedger).split(path.sep).join("/"),
  path.relative(projectRoot, paths.events).split(path.sep).join("/"),
]);

const sourceBefore = await inventory(sourceRoot, { contentHashes: true });
const projectBefore = await inventory(projectRoot, { contentHashes: true, excluded: allowedProjectWrites });
const preview = await previewCanonicalAssetMigration(projectRoot);

assert(preview.blockers.length === 0, `P5 正式迁移预检存在 blocker：${preview.blockers.join("；")}`);
assert(preview.canMigrate || !preview.pending, "P5 正式迁移预检既不可迁移也不是已物化 current 状态。 ");
assert(preview.counts?.assets === 77, `正式资产数不是 77：${preview.counts?.assets}`);
assert(preview.counts.byCategory.character === 24 && preview.counts.byCategory.scene === 20 && preview.counts.byCategory.prop === 33, "正式资产显式类别计数不是 24/20/33。 ");
assert(preview.counts.aliases > 154, `正式别名未包含新增显式别名：${preview.counts.aliases}`);
assert(preview.counts.definitionVersions === 77 && preview.counts.contractVersions === 77, "正式定义/合同版本计数不是 77/77。 ");
assert(preview.counts.versions === 21 && preview.counts.authorities === 21 && preview.counts.relations === 0 && preview.counts.media === 39, "正式版本/权威/关系/媒体计数不是 21/21/0/39。 ");
assert(preview.counts.assetsWithVersions === 20 && preview.counts.assetsWithoutVersions === 57, "正式有版本/无版本资产计数不是 20/57。 ");
assert(preview.counts.primaryAuthorities === 20 && preview.counts.supportingAuthorities === 1, "正式当前主权威/辅助权威计数不是 20/1。 ");

if (!execute) {
  process.stdout.write(`${JSON.stringify({
    mode: "preview",
    projectRoot,
    evidencePath,
    sourceBefore,
    projectBefore,
    preview: {
      storeRevision: preview.storeRevision,
      candidateFingerprint: preview.candidateFingerprint,
      candidateStoreFingerprint: preview.candidateStoreFingerprint,
      counts: preview.counts,
      blockers: preview.blockers,
      canMigrate: preview.canMigrate,
      pending: preview.pending,
      sourceFiles: preview.sourceSnapshot?.files.length ?? 0,
      sourceMedia: preview.sourceSnapshot?.media.length ?? 0,
    },
  }, null, 2)}\n`);
  process.exit(0);
}

await assertEvidencePathAvailable(evidencePath);

const keySuffix = `${preview.candidateFingerprint.slice(0, 24)}-r${preview.storeRevision}`;
const first = await executeIdempotentCommand(projectRoot, {
  requestId: `p5-canonical-apply-${keySuffix}`,
  idempotencyKey: `p5-canonical-apply-${keySuffix}`,
  request: {
    command: "migrate_canonical_assets",
    payload: {
      expectedStoreRevision: preview.storeRevision,
      expectedCandidateFingerprint: preview.candidateFingerprint,
    },
  },
});
assert(first.status === "succeeded", "规范资产正式迁移命令未成功。 ");

const storeAfterFirst = await readFile(paths.canonicalAssets);
const storeStatAfterFirst = await stat(paths.canonicalAssets, { bigint: true });
const businessReplay = await executeIdempotentCommand(projectRoot, {
  requestId: `p5-canonical-business-replay-${keySuffix}`,
  idempotencyKey: `p5-canonical-business-replay-${keySuffix}`,
  request: {
    command: "migrate_canonical_assets",
    payload: {
      // 核心迁移允许同一 candidate 以原始 revision 进行内容幂等重放。
      expectedStoreRevision: preview.storeRevision,
      expectedCandidateFingerprint: preview.candidateFingerprint,
    },
  },
});
const businessResult = businessReplay.result as Awaited<ReturnType<typeof migrateCanonicalAssets>>;
assert(businessReplay.status === "succeeded" && businessResult.applied === false && businessResult.replayed === true, "第二个命令未证明业务层零写重放。 ");
const storeStatAfterReplay = await stat(paths.canonicalAssets, { bigint: true });
assert((await readFile(paths.canonicalAssets)).equals(storeAfterFirst), "业务重放改写了规范资产 store 字节。 ");
assert(storeStatAfterReplay.mtimeNs === storeStatAfterFirst.mtimeNs, "业务重放改变了规范资产 store mtime。 ");

const ledgerReplay = await executeIdempotentCommand(projectRoot, {
  requestId: `p5-canonical-ledger-replay-${keySuffix}`,
  idempotencyKey: `p5-canonical-business-replay-${keySuffix}`,
  request: {
    command: "migrate_canonical_assets",
    payload: {
      expectedStoreRevision: preview.storeRevision,
      expectedCandidateFingerprint: preview.candidateFingerprint,
    },
  },
});
assert(ledgerReplay.status === "succeeded" && ledgerReplay.replayed, "命令账本没有幂等重放既有终态。 ");

const [store, state, currentness, p01, halfBiSearch, soulJadeSearch, oldCopperFishSearch, sourceAfter, projectAfter] = await Promise.all([
  loadCanonicalAssetStore(projectRoot),
  getCanonicalAssetCatalogState(projectRoot),
  inspectCanonicalAssetStoreCurrentness(projectRoot),
  getCanonicalAsset(projectRoot, "P01"),
  listCanonicalAssets(projectRoot, { search: "半璧", limit: 200 }),
  listCanonicalAssets(projectRoot, { search: "随魂素玉", limit: 200 }),
  listCanonicalAssets(projectRoot, { search: "旧铜鱼挂坠", limit: 200 }),
  inventory(sourceRoot, { contentHashes: true }),
  inventory(projectRoot, { contentHashes: true, excluded: allowedProjectWrites }),
]);
assert(store, "迁移后规范资产 store 缺失。 ");
assert(state.available && state.current && currentness.current, `迁移后规范资产库不是 current：${currentness.driftedInputs.join("；")}`);
assert(state.counts && stable(state.counts) === stable(preview.counts), "迁移后规范资产计数与已签名预检候选不一致。 ");
assert(sourceAfter.digest === sourceBefore.digest, "第三季只读源在 P5 迁移前后发生变化。 ");
assert(projectAfter.digest === projectBefore.digest, "P5 迁移修改了允许清单之外的正式工程文件。 ");
assert(store.assets.length === 77 && store.aliases.length === preview.counts.aliases && store.aliases.length > 154 && store.definitionVersions.length === 77 && store.contractVersions.length === 77, "正式规范资产/别名/定义/合同数量不符。 ");
assert(store.versions.length === 21 && store.authorities.length === 21 && store.relations.length === 0, "正式版本/权威/关系数量不符。 ");
assert(store.versions.reduce((sum, version) => sum + version.media.length, 0) === 39, "正式规范资产媒体引用数量不是 39。 ");
assert(state.counts?.primaryAuthorities === 20 && state.counts.supportingAuthorities === 1, "迁移后当前主权威/辅助权威计数不是 20/1。 ");

const primaryHeads = store.assets.filter((asset) => Boolean(asset.primaryAuthorityId));
const supportingHeads = store.assets.flatMap((asset) => {
  assert(Object.prototype.hasOwnProperty.call(asset, "currentSupportingAuthorityIds"), `${asset.id} 缺少显式 currentSupportingAuthorityIds 字段。`);
  assert(Array.isArray(asset.currentSupportingAuthorityIds), `${asset.id} 的 currentSupportingAuthorityIds 不是数组。`);
  assert(new Set(asset.currentSupportingAuthorityIds).size === asset.currentSupportingAuthorityIds.length, `${asset.id} 的 currentSupportingAuthorityIds 存在重复项。`);
  const expectedCount = asset.id === "P01" ? 1 : 0;
  assert(asset.currentSupportingAuthorityIds.length === expectedCount, `${asset.id} 的当前辅助权威数量不是 ${expectedCount}。`);
  return asset.currentSupportingAuthorityIds.map((authorityId) => ({ assetId: asset.id, authorityId }));
});
assert(primaryHeads.length === 20 && supportingHeads.length === 1 && supportingHeads[0]?.assetId === "P01", "当前 Authority head 摘要不是 20 个主权威及 P01 唯一辅助权威。 ");
for (const asset of primaryHeads) {
  const authority = store.authorities.find((entry) => entry.id === asset.primaryAuthorityId);
  assert(authority?.assetId === asset.id && authority.exposure === "allowed" && authority.scope.usage === "generation-reference", `${asset.id} 当前主权威无效或不可用于生成。`);
}
for (const head of supportingHeads) {
  const authority = store.authorities.find((entry) => entry.id === head.authorityId);
  assert(authority?.assetId === head.assetId && authority.role === "supporting-identity", `${head.assetId} 当前辅助权威引用无效。`);
}

assert(halfBiSearch.available && halfBiSearch.items.some((asset) => asset.id === "P03"), "别名“半璧”未能检索到 P03。 ");
assert(soulJadeSearch.available && soulJadeSearch.items.some((asset) => asset.id === "P03"), "别名“随魂素玉”未能检索到 P03。 ");
assert(oldCopperFishSearch.available && oldCopperFishSearch.items.some((asset) => asset.id === "P04"), "别名“旧铜鱼挂坠”未能检索到 P04。 ");

const aliasKindCounts = Object.fromEntries([...new Set(store.aliases.map((alias) => alias.kind))]
  .sort((left, right) => left.localeCompare(right, "en"))
  .map((kind) => [kind, store.aliases.filter((alias) => alias.kind === kind).length]));
assert(Object.values(aliasKindCounts).reduce((sum, count) => sum + count, 0) === store.aliases.length, "别名分类计数与总量不一致。 ");
const overrunAssetIds = store.migrationAnomalies.filter((entry) => entry.code === "definition-source-section-overrun").map((entry) => entry.assetId).sort();
assert(JSON.stringify(overrunAssetIds) === JSON.stringify(["C21", "P33", "S20"]), `正式 sourceSection 越界异常集合不符：${overrunAssetIds.join(",")}`);
assert(store.migrationAnomalies.filter((entry) => entry.code === "uniform-contract-aspect-ratio").length === 1, "正式旧合同统一 9:16 异常不是唯一一条。 ");
const p01SupportingAuthorityId = p01.asset.currentSupportingAuthorityIds?.[0];
assert(p01SupportingAuthorityId && p01.authorities.some((authority) => authority.id === p01SupportingAuthorityId && authority.role === "supporting-identity" && authority.exposure === "forbidden" && authority.scope.usage === "human-review-only"), "P01 未保留当前禁止暴露的黄金面具辅助身份权威。 ");
assert(!p01.asset.primaryAuthorityId || p01.authorities.find((authority) => authority.id === p01.asset.primaryAuthorityId)?.role !== "supporting-identity", "黄金面具辅助身份被错误提升为 P01 主权威。 ");

const finishedAt = new Date();
const initialApplyRecord = (await listCommandLedger(projectRoot, 500)).find((record) => {
  const result = record.result as { kind?: string; applied?: boolean; candidateFingerprint?: string } | undefined;
  return record.command === "migrate_canonical_assets"
    && record.status === "succeeded"
    && result?.kind === "canonical-asset-migration-result"
    && result.applied === true
    && result.candidateFingerprint === preview.candidateFingerprint;
});
assert(initialApplyRecord, "命令账本缺少首次 applied=true 的规范资产迁移终态。 ");
const evidence = {
  schemaVersion: 1,
  kind: "p5-canonical-asset-migration-evidence",
  projectRoot,
  sourceRoot,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  durationMs: finishedAt.getTime() - startedAt.getTime(),
  preview,
  initialApplyCommand: { requestId: initialApplyRecord.requestId, idempotencyKey: initialApplyRecord.idempotencyKey, status: initialApplyRecord.status, replayed: initialApplyRecord.replayed, result: initialApplyRecord.result },
  firstCommand: { requestId: first.requestId, idempotencyKey: first.idempotencyKey, status: first.status, replayed: first.replayed, result: first.result },
  businessReplay: { requestId: businessReplay.requestId, idempotencyKey: businessReplay.idempotencyKey, status: businessReplay.status, replayed: businessReplay.replayed, result: businessReplay.result },
  ledgerReplay: { requestId: ledgerReplay.requestId, idempotencyKey: ledgerReplay.idempotencyKey, status: ledgerReplay.status, replayed: ledgerReplay.replayed },
  store: {
    revision: store.revision,
    candidateFingerprint: store.candidateFingerprint,
    storeFingerprint: store.storeFingerprint,
    fileSha256: sha(storeAfterFirst),
    counts: state.counts,
    aliases: store.aliases.length,
    aliasKindCounts,
    definitionVersions: store.definitionVersions.length,
    contractVersions: store.contractVersions.length,
    anomalies: store.migrationAnomalies.map((entry) => ({ code: entry.code, assetId: entry.assetId })),
  },
  aliasSearches: {
    halfBi: { query: "半璧", expectedAssetId: "P03", total: halfBiSearch.total, matchedAssetIds: halfBiSearch.items.map((asset) => asset.id) },
    soulJade: { query: "随魂素玉", expectedAssetId: "P03", total: soulJadeSearch.total, matchedAssetIds: soulJadeSearch.items.map((asset) => asset.id) },
    oldCopperFishPendant: { query: "旧铜鱼挂坠", expectedAssetId: "P04", total: oldCopperFishSearch.total, matchedAssetIds: oldCopperFishSearch.items.map((asset) => asset.id) },
  },
  currentHeads: {
    primaryAuthorityCount: primaryHeads.length,
    supportingAuthorityCount: supportingHeads.length,
    primaryAssetIds: primaryHeads.map((asset) => asset.id).sort((left, right) => left.localeCompare(right, "en")),
    supportingByAsset: supportingHeads,
  },
  p01: {
    versions: p01.versions.length,
    authorities: p01.authorities.map((authority) => ({ id: authority.id, role: authority.role, exposure: authority.exposure, usage: authority.scope.usage, versionId: authority.assetVersionId })),
  },
  currentness,
  sourceBefore,
  sourceAfter,
  protectedProjectBefore: projectBefore,
  protectedProjectAfter: projectAfter,
  allowedProjectWrites: [...allowedProjectWrites].sort(),
  assertions: {
    exactCounts: true,
    zeroWriteBusinessReplay: true,
    ledgerReplay: true,
    currentAfterMigration: true,
    sourceUnchanged: true,
    unrelatedProjectFilesUnchanged: true,
    hiddenGoldenMaskNonExposed: true,
    explicitSupportingAuthorityHeads: true,
    explicitAliasSearches: true,
  },
};
await writeJsonAtomic(evidencePath, evidence);
process.stdout.write(`${JSON.stringify({ evidencePath, storeRevision: store.revision, storeFingerprint: store.storeFingerprint, counts: state.counts, sourceDigest: sourceAfter.digest, assertions: evidence.assertions }, null, 2)}\n`);
