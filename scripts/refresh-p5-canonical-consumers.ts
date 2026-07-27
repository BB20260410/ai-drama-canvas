import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import {
  inspectCanonicalAssetStoreCurrentness,
  loadCanonicalAssetStore,
  previewCanonicalAssetMigration,
} from "../src/core/canonical-assets.js";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import {
  inspectFusionPanelReferenceCurrentness,
  loadFusionPanelReferenceStore,
} from "../src/core/fusion-panel-references.js";
import {
  inspectFusionPanelVisualConstraintCurrentness,
  loadFusionPanelVisualConstraintStore,
} from "../src/core/fusion-visual-constraint-store.js";
import { getSidecarPaths, loadIndex, writeJsonAtomic } from "../src/core/sidecar.js";

const projectRoot = path.resolve(process.argv[2] ?? path.join(process.cwd(), "productions", "gushujuan-s3-f1a688020bfb7af6"));
const evidencePath = path.resolve(process.argv[3] ?? path.join(process.cwd(), "docs", "evidence", "p5-canonical-consumers-20260718-r2.json"));
const sourceRoot = path.resolve("/Users/hxx/Documents/古蜀卷第三季");
const startedAt = new Date();

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

interface InventorySummary { root: string; fileCount: number; totalBytes: number; digest: string }
async function inventory(root: string, contentHashes: boolean, excluded = new Set<string>()): Promise<InventorySummary> {
  const files = (await fg("**/*", { cwd: root, onlyFiles: true, dot: true, followSymbolicLinks: false, unique: true }))
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((entry) => !excluded.has(entry))
    .sort((left, right) => left.localeCompare(right, "en"));
  let totalBytes = 0;
  const rows: Array<Record<string, string | number>> = [];
  for (const relativePath of files) {
    const filePath = path.join(root, relativePath);
    const metadata = await stat(filePath, { bigint: true });
    const size = Number(metadata.size);
    totalBytes += size;
    rows.push({ path: relativePath, size, mtimeNs: metadata.mtimeNs.toString(), ...(contentHashes ? { sha256: sha(await readFile(filePath)) } : {}) });
  }
  return { root, fileCount: rows.length, totalBytes, digest: sha(stable(rows)) };
}

async function projectConfigSnapshot(filePath: string): Promise<{ rawSha256: string; semanticSha256: string; updatedAt?: string }> {
  const raw = await readFile(filePath);
  const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  const { updatedAt, ...semantic } = parsed;
  return {
    rawSha256: sha(raw),
    semanticSha256: sha(stable(semantic)),
    ...(typeof updatedAt === "string" ? { updatedAt } : {}),
  };
}

const paths = getSidecarPaths(projectRoot);
const allowedWrites = new Set([
  paths.index,
  paths.cache,
  `${paths.cache}-wal`,
  `${paths.cache}-shm`,
  paths.canonicalAssets,
  paths.panelReferenceResolutions,
  paths.panelVisualConstraints,
  paths.commandLedger,
  paths.events,
  paths.config,
  paths.progressMarkdown,
].map((entry) => path.relative(projectRoot, entry).split(path.sep).join("/")));

const [sourceBefore, projectBefore, projectConfigBefore, canonicalBefore, p2Before, p3Before] = await Promise.all([
  inventory(sourceRoot, true),
  inventory(projectRoot, false, allowedWrites),
  projectConfigSnapshot(paths.config),
  loadCanonicalAssetStore(projectRoot),
  loadFusionPanelReferenceStore(projectRoot),
  loadFusionPanelVisualConstraintStore(projectRoot),
]);
assert(canonicalBefore, "P5 消费者刷新前规范资产 store 不存在。 ");
const canonicalBeforeCurrentness = await inspectCanonicalAssetStoreCurrentness(projectRoot);
assert(canonicalBeforeCurrentness.current || (canonicalBeforeCurrentness.issues.length > 0
  && canonicalBeforeCurrentness.issues.every((issue) => /^catalog Artifact 出现重复 ID：/u.test(issue))), "P5 消费者刷新前规范资产 store 存在非 Scanner 重复 ID 漂移。 ");
assert(p2Before && p3Before, "P2/P3 正式 store 缺失。 ");

const scanCommand = await executeIdempotentCommand(projectRoot, {
  requestId: `p5-canonical-scan-signed-cache-recovery-v5-${canonicalBefore.storeFingerprint.slice(0, 16)}`,
  idempotencyKey: `p5-canonical-scan-signed-cache-recovery-v5-${canonicalBefore.storeFingerprint.slice(0, 16)}`,
  request: { command: "scan_project", payload: {} },
});
assert(scanCommand.status === "succeeded", "规范资产 Scanner 正式刷新失败。 ");

let canonicalMigrationCommand: Awaited<ReturnType<typeof executeIdempotentCommand>> | undefined;
let canonicalCurrentness = await inspectCanonicalAssetStoreCurrentness(projectRoot);
if (!canonicalCurrentness.current) {
  const migrationPreview = await previewCanonicalAssetMigration(projectRoot);
  assert(migrationPreview.blockers.length === 0 && migrationPreview.canMigrate && migrationPreview.pending, `Scanner 后规范资产重基线预检失败：${migrationPreview.blockers.join("；")}`);
  const suffix = `${migrationPreview.candidateFingerprint.slice(0, 24)}-r${migrationPreview.storeRevision}`;
  canonicalMigrationCommand = await executeIdempotentCommand(projectRoot, {
    requestId: `p5-canonical-post-scan-${suffix}`,
    idempotencyKey: `p5-canonical-post-scan-${suffix}`,
    request: {
      command: "migrate_canonical_assets",
      payload: { expectedStoreRevision: migrationPreview.storeRevision, expectedCandidateFingerprint: migrationPreview.candidateFingerprint },
    },
  });
  assert(canonicalMigrationCommand.status === "succeeded", "Scanner 后规范资产重基线迁移失败。 ");
  canonicalCurrentness = await inspectCanonicalAssetStoreCurrentness(projectRoot);
}
assert(canonicalCurrentness.current, `Scanner 后规范资产 store 仍漂移：${canonicalCurrentness.driftedInputs.join("；")}`);

const canonical = await loadCanonicalAssetStore(projectRoot);
assert(canonical, "Scanner 后规范资产 store 缺失。 ");
const p2Command = await executeIdempotentCommand(projectRoot, {
  requestId: `p5-canonical-p2-${canonical.storeFingerprint.slice(0, 18)}-${p2Before.storeFingerprint.slice(0, 12)}`,
  idempotencyKey: `p5-canonical-p2-${canonical.storeFingerprint.slice(0, 18)}-${p2Before.storeFingerprint.slice(0, 12)}`,
  request: { command: "materialize_fusion_panel_references", payload: {} },
});
assert(p2Command.status === "succeeded", "P2 规范权威引用重基线失败。 ");
const [p2, p2Currentness] = await Promise.all([loadFusionPanelReferenceStore(projectRoot), inspectFusionPanelReferenceCurrentness(projectRoot)]);
assert(p2 && p2Currentness.current, `P2 重基线后仍漂移：${p2Currentness.driftedInputs.join("；")}`);

const p3CurrentStore = await loadFusionPanelVisualConstraintStore(projectRoot);
assert(p3CurrentStore, "P3 视觉约束 store 缺失。 ");
const p3Command = await executeIdempotentCommand(projectRoot, {
  requestId: `p5-canonical-p3-superseded-v2-${p2.storeFingerprint.slice(0, 18)}-r${p3CurrentStore.revision}`,
  idempotencyKey: `p5-canonical-p3-superseded-v2-${p2.storeFingerprint.slice(0, 18)}-r${p3CurrentStore.revision}`,
  request: { command: "materialize_fusion_visual_constraints", payload: { expectedStoreRevision: p3CurrentStore.revision } },
});
assert(p3Command.status === "succeeded", "P3 规范权威约束重基线失败。 ");
const [p3, p3Currentness, index, sourceAfter, projectAfter, projectConfigAfter] = await Promise.all([
  loadFusionPanelVisualConstraintStore(projectRoot),
  inspectFusionPanelVisualConstraintCurrentness(projectRoot),
  loadIndex(projectRoot),
  inventory(sourceRoot, true),
  inventory(projectRoot, false, allowedWrites),
  projectConfigSnapshot(paths.config),
]);
assert(p3 && p3Currentness.current, `P3 重基线后仍漂移：${p3Currentness.driftedInputs.join("；")}`);
assert(index, "Scanner 刷新后正式 index 缺失。 ");
assert(sourceAfter.digest === sourceBefore.digest, "P5 消费者刷新改变了第三季只读源。 ");
assert(projectAfter.digest === projectBefore.digest, "P5 消费者刷新修改了允许清单外的正式工程文件。 ");
assert(projectConfigAfter.semanticSha256 === projectConfigBefore.semanticSha256, "P5 Scanner 修改了 project.json 的业务语义。 ");

const assetItems = index.items.filter((item) => item.type === "asset");
const categoryCounts = {
  character: assetItems.filter((item) => item.assetCategory === "character").length,
  scene: assetItems.filter((item) => item.assetCategory === "scene").length,
  prop: assetItems.filter((item) => item.assetCategory === "prop").length,
  unclassified: assetItems.filter((item) => !item.assetCategory).length,
};
assert(assetItems.length === 77 && categoryCounts.character === 24 && categoryCounts.scene === 20 && categoryCounts.prop === 33 && categoryCounts.unclassified === 0, `Scanner 显式资产分类不符：${JSON.stringify(categoryCounts)}`);
assert(assetItems.filter((item) => item.hardLockIds.length > 0).length === 20, "Scanner 规范主权威资产数不是 20。 ");

const authorityById = new Map(canonical.authorities.map((authority) => [authority.id, authority]));
const currentPrimaryAuthorities = canonical.assets.flatMap((asset) => {
  if (!asset.primaryAuthorityId) return [];
  const authority = authorityById.get(asset.primaryAuthorityId);
  assert(authority, `规范资产 ${asset.id} 的 primaryAuthorityId 悬空：${asset.primaryAuthorityId}`);
  assert(authority.assetId === asset.id && authority.exposure === "allowed" && authority.scope.usage === "generation-reference", `规范资产 ${asset.id} 当前主权威不可用于生成。`);
  return [authority];
});
assert(currentPrimaryAuthorities.length === 20, `当前规范主权威不是 20：${currentPrimaryAuthorities.length}`);
const currentAllowedVersionIds = new Set(currentPrimaryAuthorities.map((authority) => authority.assetVersionId));
assert(currentAllowedVersionIds.size === 20, `当前规范主权威版本不是 20：${currentAllowedVersionIds.size}`);
const allVersionIds = new Set(canonical.versions.map((version) => version.id));
const disallowedVersionIds = new Set([...allVersionIds].filter((versionId) => !currentAllowedVersionIds.has(versionId)));
const forbiddenVersionIds = new Set(canonical.authorities.filter((authority) => authority.exposure === "forbidden").map((authority) => authority.assetVersionId));
const p2Locks = Object.values(p2.resolutions).flatMap((resolution) => resolution.semanticAssets.flatMap((asset) => asset.hardLock ? [asset.hardLock] : []));
assert(p2Locks.length === 5_481, `P2 已锁绑定数不是 5481：${p2Locks.length}`);
const p2ReferenceVersionIds = new Set(p2Locks.map((lock) => lock.referenceVersion));
assert(JSON.stringify([...p2ReferenceVersionIds].sort()) === JSON.stringify([...currentAllowedVersionIds].sort()), "P2 当前引用版本集合不等于 20 个规范主权威 head。 ");
assert([...p2ReferenceVersionIds].every((versionId) => !disallowedVersionIds.has(versionId) && !forbiddenVersionIds.has(versionId)), "P2 泄漏了历史或 forbidden AssetVersion。 ");
const p3Locks = Object.values(p3.constraints).flatMap((constraint) => constraint.identityLocks.filter((lock) => lock.status === "locked"));
assert(p3Locks.length === 5_481, `P3 已锁身份数不是 5481：${p3Locks.length}`);
const p3ReferenceVersionIds = new Set(p3Locks.flatMap((lock) => lock.referenceVersion ? [lock.referenceVersion] : []));
assert(JSON.stringify([...p3ReferenceVersionIds].sort()) === JSON.stringify([...currentAllowedVersionIds].sort()), "P3 当前引用版本集合不等于 20 个规范主权威 head。 ");
assert([...p3ReferenceVersionIds].every((versionId) => !disallowedVersionIds.has(versionId) && !forbiddenVersionIds.has(versionId)), "P3 泄漏了历史或 forbidden AssetVersion。 ");
const p2p3Serialized = JSON.stringify({ p2, p3 });
const versionById = new Map(canonical.versions.map((version) => [version.id, version]));
const disallowedPathLeaks = canonical.authorities
  .filter((authority) => !currentPrimaryAuthorities.some((current) => current.id === authority.id))
  .flatMap((authority) => {
    const version = versionById.get(authority.assetVersionId);
    const sourcePaths = authority.source.kind === "legacy-authority"
      ? [authority.source.sourcePath, authority.source.snapshotPath]
      : [authority.source.path];
    return [...sourcePaths, ...(version?.media.map((media) => media.path) ?? [])];
  })
  .filter((candidate, index, values) => candidate && values.indexOf(candidate) === index)
  .filter((candidate) => p2p3Serialized.includes(candidate));
assert(disallowedPathLeaks.length === 0, `P2/P3 模型事实泄漏历史或 forbidden 权威路径：${disallowedPathLeaks.join("、")}`);
const legacyDispositionCounts = Object.values(p3.legacyGenerationJobEvidence).reduce<Record<string, number>>((counts, entry) => {
  counts[entry.disposition] = (counts[entry.disposition] ?? 0) + 1;
  return counts;
}, {});
assert(legacyDispositionCounts["superseded-constraint-readonly"] === 10
  && legacyDispositionCounts["obsolete-terminal-readonly"] === 1
  && Object.keys(legacyDispositionCounts).length === 2, `P3 历史 Job 重基线裁决不符：${JSON.stringify(legacyDispositionCounts)}`);
assert(p2.audit.closurePassed && p2.audit.panels === 4_330 && p2.audit.semanticAssetBindings === 13_812 && p2.audit.unresolvedReferences === 0 && p2.audit.unhandledOverflowPanels === 0, "P2 规范重基线闭包审计失败。 ");
assert(p3.audit.closurePassed && p3.audit.constraints === 4_330 && p3.audit.invalidConstraints === 0 && p3.audit.modelPromptLeakPanels === 0 && p3.audit.modelPathLeakPanels === 0, "P3 规范重基线闭包审计失败。 ");

const finishedAt = new Date();
const evidence = {
  schemaVersion: 1,
  kind: "p5-canonical-consumer-refresh-evidence",
  projectRoot,
  sourceRoot,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  durationMs: finishedAt.getTime() - startedAt.getTime(),
  commands: {
    scan: { requestId: scanCommand.requestId, idempotencyKey: scanCommand.idempotencyKey, status: scanCommand.status, replayed: scanCommand.replayed, result: scanCommand.result },
    canonicalRemigration: canonicalMigrationCommand ? { requestId: canonicalMigrationCommand.requestId, idempotencyKey: canonicalMigrationCommand.idempotencyKey, status: canonicalMigrationCommand.status, replayed: canonicalMigrationCommand.replayed, result: canonicalMigrationCommand.result } : null,
    p2: { requestId: p2Command.requestId, idempotencyKey: p2Command.idempotencyKey, status: p2Command.status, replayed: p2Command.replayed, result: p2Command.result },
    p3: { requestId: p3Command.requestId, idempotencyKey: p3Command.idempotencyKey, status: p3Command.status, replayed: p3Command.replayed, result: p3Command.result },
  },
  canonical: {
    revision: canonical.revision,
    storeFingerprint: canonical.storeFingerprint,
    beforeCurrentness: canonicalBeforeCurrentness,
    currentness: canonicalCurrentness,
    versionIds: allVersionIds.size,
    currentAllowedVersionIds: [...currentAllowedVersionIds].sort(),
    disallowedVersionIds: [...disallowedVersionIds].sort(),
    forbiddenVersionIds: [...forbiddenVersionIds].sort(),
    disallowedPathLeaks,
  },
  scanner: { scanId: index.scanId, assets: assetItems.length, categories: categoryCounts, primaryAuthorityAssets: assetItems.filter((item) => item.hardLockIds.length > 0).length },
  p2: { beforeRevision: p2Before.revision, revision: p2.revision, storeFingerprint: p2.storeFingerprint, currentness: p2Currentness, audit: p2.audit, canonicalLockedBindings: p2Locks.length, canonicalReferenceVersions: [...p2ReferenceVersionIds].sort() },
  p3: { beforeRevision: p3Before.revision, revision: p3.revision, storeFingerprint: p3.storeFingerprint, currentness: p3Currentness, audit: p3.audit, canonicalLockedIdentities: p3Locks.length, canonicalReferenceVersions: [...p3ReferenceVersionIds].sort(), legacyDispositionCounts },
  sourceBefore,
  sourceAfter,
  protectedProjectBefore: projectBefore,
  protectedProjectAfter: projectAfter,
  projectConfigBefore,
  projectConfigAfter,
  allowedWrites: [...allowedWrites].sort(),
  assertions: {
    canonicalCurrent: true,
    explicitCategories24_20_33: true,
    scannerPrimaryAuthorities20: true,
    p2CanonicalVersionBindings5481: true,
    p3CanonicalVersionLocks5481: true,
    p2P3UseOnlyCurrentAllowedHeads: true,
    forbiddenAndHistoricalPathLeaksZero: true,
    p3HistoricalJobsPreservedAsSuperseded10Obsolete1: true,
    projectConfigSemanticUnchanged: true,
    p2Closure: true,
    p3Closure: true,
    sourceUnchanged: true,
    unrelatedProjectFilesUnchanged: true,
  },
};
await writeJsonAtomic(evidencePath, evidence);
process.stdout.write(`${JSON.stringify({ evidencePath, canonical: evidence.canonical, scanner: evidence.scanner, p2: { revision: p2.revision, canonicalLockedBindings: p2Locks.length, closurePassed: p2.audit.closurePassed }, p3: { revision: p3.revision, canonicalLockedIdentities: p3Locks.length, closurePassed: p3.audit.closurePassed }, sourceDigest: sourceAfter.digest, assertions: evidence.assertions }, null, 2)}\n`);
