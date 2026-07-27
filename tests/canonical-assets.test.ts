import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getCanonicalAsset,
  getCanonicalAssetCatalogState,
  inspectCanonicalAssetStoreCurrentness,
  listCanonicalAssets,
  loadCurrentCanonicalAssetAuthorityProjection,
  loadCanonicalAssetStore,
  migrateCanonicalAssets,
  previewCanonicalAssetMigration,
  type CanonicalAssetStore,
} from "../src/core/canonical-assets.js";
import { executeIdempotentCommand, reconcileCommand } from "../src/core/command-bus.js";
import { isRejectedCommandFailure } from "../src/core/command-outcome.js";
import { listAssetRelations, upsertAssetRelation } from "../src/core/asset-registry.js";
import { ProjectCache } from "../src/core/cache.js";
import { getReviewQueue, submitReview } from "../src/core/reviews.js";
import { getSidecarPaths } from "../src/core/sidecar.js";
import { scanProject } from "../src/core/scanner.js";
import { resolvePanelHardLockSnapshots } from "../src/core/fusion-panel-references.js";
import { promoteAssetToHardLock, setAuthoritativeArtifact, updateStatus } from "../src/core/service.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT;
  delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function stableDigest(value: unknown): string {
  return sha(JSON.stringify(stableValue(value)));
}

function contentId(prefix: string, fingerprint: string): string {
  return `${prefix}-${fingerprint.slice(0, 32)}`;
}

function legacyFingerprintStore(input: CanonicalAssetStore): CanonicalAssetStore {
  const store = structuredClone(input);
  const versionIds = new Map<string, string>();
  store.versions = store.versions.map((version) => {
    const fingerprint = stableDigest({
      schemaVersion: 1,
      kind: "canonical-asset-version",
      assetId: version.assetId,
      definitionVersionId: version.definitionVersionId,
      contractVersionId: version.contractVersionId,
      representation: version.representation,
      media: version.media.map((media) => ({ kind: media.kind, role: media.role, bytes: media.bytes, sha256: media.sha256 })),
    });
    const id = contentId(`asset-version-${version.assetId}`, fingerprint);
    versionIds.set(version.id, id);
    return { ...version, id, fingerprint };
  }).sort((left, right) => left.id.localeCompare(right.id, "en"));

  const authorityIds = new Map<string, string>();
  store.authorities = store.authorities.map((authority) => {
    const withLegacyVersion = { ...authority, assetVersionId: versionIds.get(authority.assetVersionId)! };
    const { id: oldId, fingerprint: _fingerprint, createdAt: _createdAt, ...semantic } = withLegacyVersion;
    const fingerprint = stableDigest({ schemaVersion: 1, recordKind: "canonical-asset-authority", payload: semantic });
    const id = contentId(`asset-authority-${authority.assetId}`, fingerprint);
    authorityIds.set(oldId, id);
    return { ...withLegacyVersion, id, fingerprint };
  }).sort((left, right) => left.id.localeCompare(right.id, "en"));

  store.assets = store.assets.map((asset) => {
    const { fingerprint: _fingerprint, currentSupportingAuthorityIds: _currentSupportingAuthorityIds, ...legacyAsset } = asset;
    const payload = {
      ...legacyAsset,
      ...(asset.primaryAuthorityId ? { primaryAuthorityId: authorityIds.get(asset.primaryAuthorityId)! } : {}),
    };
    return {
      ...payload,
      fingerprint: stableDigest({ schemaVersion: 1, kind: "canonical-asset", ...payload }),
    };
  }).sort((left, right) => left.id.localeCompare(right.id, "en"));

  store.aliases = store.aliases
    .filter((alias) => alias.kind === "formal-id" || alias.kind === "formal-name")
    .map((alias) => {
      const payload = {
        assetId: alias.assetId,
        kind: alias.kind,
        status: alias.status,
        value: alias.value,
        normalizedValue: alias.normalizedValue,
        scope: alias.scope,
      };
      const fingerprint = stableDigest({ schemaVersion: 1, recordKind: "canonical-asset-alias", payload });
      return { ...payload, id: contentId(`asset-alias-${alias.assetId}`, fingerprint), fingerprint };
    })
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  store.relations = [];
  store.candidateFingerprint = stableDigest({
    schemaVersion: 1,
    algorithm: "canonical-assets-fusion-v1",
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
  const { storeFingerprint: _storeFingerprint, updatedAt: _updatedAt, ...semanticStore } = store;
  store.storeFingerprint = stableDigest(semanticStore);
  return store;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function legacyDefinition(
  id: string,
  category: "character" | "scene" | "prop",
  name: string,
  options: { overrun?: boolean } = {},
): Record<string, unknown> {
  const sourceSection = `### ${id} ${name}\n\n- **用途**：测试。${options.overrun ? "\n\n## 后续比例策略\n\n此段属于后续章节，不应被迁移器静默裁切。" : ""}`;
  return {
    id,
    category,
    name,
    declaredUsage: id === "C02" ? "测试季" : "",
    generationPrompts: [{ label: "AI 出图提示词", prompt: `${name} 原始提示词` }],
    sourceMarkdownPath: "05_提示词/00_全季资产库.md",
    sourceHeadingLine: 1,
    sourceSectionSha256: sha(sourceSection),
    sourceSection,
    generationStatus: "not-generated",
    hardLockStatus: "unlocked",
  };
}

function legacyContract(
  id: string,
  category: "character" | "scene" | "prop",
  authorityReferences: Array<{ path: string; sha256: string; role: "authority" }> = [],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "asset-generation-contract",
    contractId: `contract-${id}`,
    assetId: id,
    assetCategory: category,
    prompt: `${id} 原始合同提示词`,
    provider: "artlist",
    model: "GPT Image 2",
    aspectRatio: "9:16",
    quality: "Medium",
    imageCount: 1,
    concurrency: 1,
    authorityReferences,
    referencePolicy: { acceptedAssetsOnly: true, contentHashesRequired: true, maximumReferences: 6 },
    acceptanceRequirements: ["raw/labeled 可追溯配对"],
    hardLockPromotion: { automatic: false, visualReviewRequired: true },
  };
}

interface FixtureOptions {
  mismatchedPair?: boolean;
  aliasConflict?: boolean;
  danglingReceipt?: boolean;
  reviewShaMismatch?: boolean;
  includeAliasAssets?: boolean;
}

interface FixtureResult {
  root: string;
  catalogPath: string;
  authorityPath: string;
  goldenPath: string;
  rawPath: string;
  labeledPath: string;
}

async function fixture(options: FixtureOptions = {}): Promise<FixtureResult> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-canonical-assets-"));
  roots.push(root);
  const paths = getSidecarPaths(root);
  await mkdir(paths.root, { recursive: true });

  const c99Directory = path.join(root, "assets", "01_人物路径关键词_但显式为场景");
  const c02Directory = path.join(root, "assets", "P_道具路径关键词_但显式为角色");
  const p01Directory = path.join(root, "assets", "P01_布囊");
  const outputDirectory = path.join(p01Directory, "AI画布生成");
  const authorityPath = path.join(root, "authorities", "scene", "C99_reference.png");
  const goldenPath = path.join(root, "authorities", "golden-mask", "golden.png");
  const rawPath = path.join(outputDirectory, "P01_asset_raw.png");
  const labeledPath = path.join(outputDirectory, options.mismatchedPair ? "P01_other_labeled.png" : "P01_asset_labeled.png");
  await Promise.all([
    mkdir(path.dirname(authorityPath), { recursive: true }),
    mkdir(path.dirname(goldenPath), { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
  ]);
  const authorityBytes = Buffer.from("scene-authority-image-v1");
  const goldenBytes = Buffer.from("hidden-golden-mask-image-v1");
  const rawBytes = Buffer.from("reviewed-raw-image-v1");
  const labeledBytes = Buffer.from("reviewed-labeled-image-v1");
  await Promise.all([
    writeFile(authorityPath, authorityBytes),
    writeFile(goldenPath, goldenBytes),
    writeFile(rawPath, rawBytes),
    writeFile(labeledPath, labeledBytes),
  ]);

  const sceneAuthority = {
    id: "scene-authority",
    assetId: "C99",
    name: "显式场景权威参考",
    sourcePath: "/not-scanned/external/C99_reference.png",
    sourceSha256: sha(authorityBytes),
    snapshotPath: authorityPath,
    snapshotSha256: sha(authorityBytes),
    rules: ["布局固定", "禁止换成角色肖像"],
    exposeToGeneration: true,
  };
  const goldenAuthority = {
    id: "golden-mask",
    name: "完整黄金面具",
    sourcePath: "/not-scanned/external/golden.png",
    sourceSha256: sha(goldenBytes),
    snapshotPath: goldenPath,
    snapshotSha256: sha(goldenBytes),
    rules: ["完整结构", "EP32 前不得露出实体", "仅作为 P01 内部身份来源"],
    exposeToGeneration: false,
  };
  const c99Definition = legacyDefinition("C99", "scene", "显式场景");
  const c02Definition = legacyDefinition("C02", "character", options.aliasConflict ? "显式场景" : "空资产", { overrun: true });
  const p01Definition = legacyDefinition("P01", "prop", "胸前布囊");
  const p03Definition = legacyDefinition("P03", "prop", "半璧（随魂素玉）");
  const p04Definition = legacyDefinition("P04", "prop", "小鱼铜片（小满旧物）");
  p04Definition.sourceSection = "### P04 小鱼铜片（小满旧物）\n\n- **重要区分**：EP12 正文称「旧铜鱼挂坠」（置于记名匣）与本资产为同一信物，投产统一引用本编号。";
  p04Definition.sourceSectionSha256 = sha(String(p04Definition.sourceSection));
  const sourceContentAddress = `sha256:${sha("fixture-source")}`;
  const aliasAssetEntries = options.includeAliasAssets ? [
    {
      workItemId: "asset-P03",
      definition: p03Definition,
      contract: legacyContract("P03", "prop"),
      directoryPath: path.join(root, "assets", "P03_半璧"),
      infoPath: path.join(root, "assets", "P03_半璧", "00_信息.md"),
      outputDirectory: path.join(root, "assets", "P03_半璧", "AI画布生成"),
    },
    {
      workItemId: "asset-P04",
      definition: p04Definition,
      contract: legacyContract("P04", "prop"),
      directoryPath: path.join(root, "assets", "P04_小鱼铜片"),
      infoPath: path.join(root, "assets", "P04_小鱼铜片", "00_信息.md"),
      outputDirectory: path.join(root, "assets", "P04_小鱼铜片", "AI画布生成"),
    },
  ] : [];
  const catalog = {
    schemaVersion: 1,
    kind: "fusion-production-assets",
    revision: 1,
    projectId: "project-canonical-fixture",
    sourceContentAddress,
    assets: [
      {
        workItemId: "asset-C99",
        definition: c99Definition,
        contract: legacyContract("C99", "scene", [{ path: authorityPath, sha256: sha(authorityBytes), role: "authority" }]),
        directoryPath: c99Directory,
        infoPath: path.join(c99Directory, "00_信息.md"),
        outputDirectory: path.join(c99Directory, "AI画布生成"),
        authority: sceneAuthority,
      },
      {
        workItemId: "asset-C02",
        definition: c02Definition,
        contract: legacyContract("C02", "character"),
        directoryPath: c02Directory,
        infoPath: path.join(c02Directory, "00_信息.md"),
        outputDirectory: path.join(c02Directory, "AI画布生成"),
      },
      {
        workItemId: "asset-P01",
        definition: p01Definition,
        contract: legacyContract("P01", "prop"),
        directoryPath: p01Directory,
        infoPath: path.join(p01Directory, "00_信息.md"),
        outputDirectory,
      },
      ...aliasAssetEntries,
    ],
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
  const catalogPath = paths.productionAssets;
  await writeJson(catalogPath, catalog);
  await writeJson(path.join(root, "fusion-production-materialization.json"), {
    schemaVersion: 1,
    kind: "fusion-production-materialization",
    receiptId: "materialization-fixture",
    createdAt: "2026-07-17T00:00:00.000Z",
    sourceContentAddress,
    targetRoot: root,
    authorities: [sceneAuthority, goldenAuthority],
    counts: {
      episodes: 1,
      units: 1,
      sourceShots: 1,
      scheduleRows: 1,
      assets: options.includeAliasAssets ? 5 : 3,
      characters: 1,
      scenes: 1,
      props: options.includeAliasAssets ? 3 : 1,
      standardDurationSeconds: 15,
      promptReferencedAssets: 3,
      indexReferencedAssets: 3,
    },
  });
  const projectConfig = {
    schemaVersion: 1,
    id: "project-canonical-fixture",
    name: "fixture",
    primaryRoot: root,
    sourceRoots: [],
    outputRoots: [],
    ignoreSegments: [".aicanvas", "node_modules", ".git"],
    namingRules: { patterns: [], manualMappings: [] },
    hardLocks: [{ id: "P01", name: "P01 胸前布囊", path: rawPath, note: "reviewed fixture" }],
    automation: { imageBatchSize: 6, videoBatchSize: 1, pauseAfterVisualBatch: true, allowOverwriteAuthoritative: false },
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
  await writeJson(paths.config, projectConfig);

  const artifact = (
    id: string,
    itemId: string,
    filePath: string,
    kind: "raw-image" | "labeled-image",
    bytes: Buffer,
  ) => ({
    id,
    uri: `file://${filePath}`,
    itemId,
    path: filePath,
    rootSlot: "main",
    relativePath: path.relative(root, filePath).split(path.sep).join("/"),
    kind,
    variant: "generic",
    versionLabel: "current",
    deprecated: false,
    authoritative: true,
    accepted: false,
    modifiedAt: "2026-07-17T00:00:00.000Z",
    check: {
      inspectionVersion: 1,
      ok: true,
      exists: true,
      decodable: true,
      width: 720,
      height: 1280,
      size: bytes.byteLength,
      sha256: sha(bytes),
      modifiedAt: "2026-07-17T00:00:00.000Z",
      issues: [],
    },
  });
  const authorityArtifact = artifact("artifact-C99-raw", "asset-C99", authorityPath, "raw-image", authorityBytes);
  const rawArtifact = artifact("artifact-P01-raw", "asset-P01", rawPath, "raw-image", rawBytes);
  const labeledArtifact = artifact("artifact-P01-labeled", "asset-P01", labeledPath, "labeled-image", labeledBytes);
  await writeJson(paths.index, {
    schemaVersion: 1,
    project: projectConfig,
    scanId: "scan-fixture",
    scannedAt: "2026-07-17T00:00:00.000Z",
    scanDurationMs: 1,
    warnings: [],
    summary: { total: 3 },
    items: [
      { id: "asset-C99", type: "asset", title: "C99 显式场景", status: "已完成", sourcePaths: [authorityPath], updatedAt: "2026-07-17T00:00:00.000Z", artifactIds: [authorityArtifact.id], hardLockIds: ["C99"] },
      { id: "asset-C02", type: "asset", title: "C02 未生成角色", status: "待生成", sourcePaths: [], updatedAt: "2026-07-17T00:00:00.000Z", artifactIds: [], hardLockIds: [] },
      { id: "asset-P01", type: "asset", title: "P01 审核道具", status: "已完成", sourcePaths: [rawPath, labeledPath], updatedAt: "2026-07-17T00:00:00.000Z", artifactIds: [rawArtifact.id, labeledArtifact.id], hardLockIds: ["P01"] },
      ...(options.includeAliasAssets ? [
        { id: "asset-P03", type: "asset", title: "P03 半璧", status: "待生成", sourcePaths: [], updatedAt: "2026-07-17T00:00:00.000Z", artifactIds: [], hardLockIds: [] },
        { id: "asset-P04", type: "asset", title: "P04 小鱼铜片", status: "待生成", sourcePaths: [], updatedAt: "2026-07-17T00:00:00.000Z", artifactIds: [], hardLockIds: [] },
      ] : []),
    ],
    artifacts: [authorityArtifact, rawArtifact, labeledArtifact],
  });
  const evidence = (entry: typeof rawArtifact) => ({
    artifactId: entry.id,
    path: entry.path,
    rootSlot: entry.rootSlot,
    relativePath: entry.relativePath,
    kind: entry.kind,
    variant: entry.variant,
    size: entry.check.size,
    sha256: entry.id === rawArtifact.id && options.reviewShaMismatch ? sha("wrong-review-bytes") : entry.check.sha256,
  });
  await writeJson(paths.reviews, {
    schemaVersion: 1,
    records: [{
      id: "review-P01-pass",
      itemId: "asset-P01",
      reviewType: "image",
      artifactIds: [labeledArtifact.id, rawArtifact.id],
      artifactEvidence: [evidence(labeledArtifact), evidence(rawArtifact)],
      decision: "pass",
      criteria: [],
      reviewer: "codex",
      resultingStatus: "已完成",
      createdAt: "2026-07-17T01:00:00.000Z",
    }],
  });
  const intentId = "publication-P01-raw";
  const receiptId = "receipt-P01-raw";
  await writeJson(paths.publications, {
    schemaVersion: 1,
    revision: 1,
    intents: options.danglingReceipt ? [] : [{
      schemaVersion: 1,
      id: intentId,
      revision: 2,
      status: "registered",
      receiptId,
      targetPath: rawPath,
      kind: "raw-image",
      variant: "generic",
      context: { purpose: "generation-output", itemId: "asset-P01", jobId: "job-P01" },
    }],
    receipts: [{
      schemaVersion: 1,
      id: receiptId,
      intentId,
      projectId: "project-canonical-fixture",
      targetPath: rawPath,
      kind: "raw-image",
      variant: "generic",
      context: { purpose: "generation-output", itemId: "asset-P01", jobId: "job-P01" },
      check: { ok: true, exists: true, decodable: true, width: 720, height: 1280, size: rawBytes.byteLength, sha256: sha(rawBytes), modifiedAt: "2026-07-17T00:00:00.000Z", issues: [] },
      registeredAt: "2026-07-17T00:30:00.000Z",
    }],
    updatedAt: "2026-07-17T00:30:00.000Z",
  });
  return { root, catalogPath, authorityPath, goldenPath, rawPath, labeledPath };
}

describe("P5 规范资产知识库", () => {
  it("空项目保持 unavailable，预览和迁移失败关闭且不创建 store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-canonical-empty-"));
    roots.push(root);
    const preview = await previewCanonicalAssetMigration(root);
    expect(preview).toMatchObject({ storeRevision: 0, canMigrate: false, pending: false });
    expect(preview.blockers.length).toBeGreaterThan(0);
    await expect(loadCanonicalAssetStore(root)).resolves.toBeNull();
    await expect(listCanonicalAssets(root)).resolves.toEqual({ available: false, total: 0, offset: 0, limit: 50, items: [] });
    await expect(getCanonicalAsset(root, "C01")).rejects.toThrow(/尚未物化/u);
    await expect(migrateCanonicalAssets(root, {
      expectedStoreRevision: 0,
      expectedCandidateFingerprint: preview.candidateFingerprint,
    })).rejects.toSatisfy((error: unknown) => isRejectedCommandFailure(error));
    await expect(access(getSidecarPaths(root).canonicalAssets)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("迁移小型正确夹具，显式类别不依赖 ID/路径，原合同/定义历史与隐藏黄金面具均可审计", async () => {
    const input = await fixture();
    const preview = await previewCanonicalAssetMigration(input.root);
    expect(preview).toMatchObject({
      storeRevision: 0,
      canMigrate: true,
      pending: true,
      blockers: [],
      counts: {
        assets: 3,
        aliases: 6,
        definitionVersions: 3,
        contractVersions: 3,
        versions: 3,
        authorities: 3,
        media: 4,
        assetsWithVersions: 2,
        assetsWithoutVersions: 1,
        primaryAuthorities: 2,
        supportingAuthorities: 1,
        byCategory: { character: 1, scene: 1, prop: 1 },
      },
    });
    const migrated = await migrateCanonicalAssets(input.root, {
      expectedStoreRevision: preview.storeRevision,
      expectedCandidateFingerprint: preview.candidateFingerprint,
    });
    expect(migrated).toMatchObject({ applied: true, replayed: false, previousRevision: 0, storeRevision: 1 });
    const store = (await loadCanonicalAssetStore(input.root))!;
    expect(store.assets.find((asset) => asset.id === "C99")).toMatchObject({ category: "scene", canonicalName: "显式场景", currentSupportingAuthorityIds: [] });
    expect(store.assets.find((asset) => asset.id === "C02")).toMatchObject({ category: "character", currentSupportingAuthorityIds: [] });
    expect(JSON.stringify(store)).not.toContain("generationStatus");
    expect(JSON.stringify(store)).not.toContain("hardLockStatus");
    expect(store.definitionVersions).toHaveLength(3);
    expect(store.contractVersions).toHaveLength(3);
    expect(store.contractVersions.every((version) => version.contract.aspectRatio === "9:16")).toBe(true);
    expect(store.migrationAnomalies.map((anomaly) => anomaly.code).sort()).toEqual(["definition-source-section-overrun", "uniform-contract-aspect-ratio"]);

    const golden = store.authorities.find((authority) => authority.source.kind === "legacy-authority" && authority.source.legacyAuthorityId === "golden-mask")!;
    expect(golden).toMatchObject({ assetId: "P01", role: "supporting-identity", exposure: "forbidden", scope: { usage: "human-review-only" } });
    expect(store.versions.find((version) => version.id === golden.assetVersionId)).toMatchObject({ assetId: "P01", representation: "supporting-reference" });
    const productionVersion = store.versions.find((version) => version.assetId === "P01" && version.representation === "production-output")!;
    expect(store.definitionVersions.find((version) => version.id === productionVersion.definitionVersionId)?.assetId).toBe("P01");
    expect(store.contractVersions.find((version) => version.id === productionVersion.contractVersionId)?.assetId).toBe("P01");
    expect(productionVersion.media.map((media) => media.role).sort()).toEqual(["labeled", "raw"]);
    expect(productionVersion.media.find((media) => media.role === "raw")?.publicationReceiptId).toBe("receipt-P01-raw");
    expect(productionVersion.media.find((media) => media.role === "labeled")?.publicationReceiptId).toBeUndefined();

    const authorityPage = await listCanonicalAssets(input.root, { authority: "with-authority" });
    expect(authorityPage).toMatchObject({ available: true, total: 2 });
    expect(authorityPage.items.find((item) => item.id === "C99")).toMatchObject({
      hasPrimaryAuthority: true,
      hasSupportingAuthority: false,
      thumbnail: { path: input.authorityPath, role: "raw", sha256: sha("scene-authority-image-v1") },
    });
    expect(authorityPage.items.find((item) => item.id === "P01")).toMatchObject({
      hasPrimaryAuthority: true,
      hasSupportingAuthority: true,
      thumbnail: { path: input.rawPath, role: "raw", sha256: sha("reviewed-raw-image-v1") },
    });
    await expect(listCanonicalAssets(input.root, { authority: "without-authority" })).resolves.toMatchObject({ available: true, total: 1, items: [{ id: "C02" }] });
    await expect(listCanonicalAssets(input.root, { search: "显式场景", category: "scene" })).resolves.toMatchObject({ total: 1, items: [{ id: "C99", category: "scene" }] });
    await expect(getCanonicalAsset(input.root, "missing")).rejects.toThrow("规范资产不存在：missing");
    await expect(inspectCanonicalAssetStoreCurrentness(input.root)).resolves.toMatchObject({ available: true, current: true, storeRevision: 1 });
    await expect(getCanonicalAssetCatalogState(input.root)).resolves.toMatchObject({ available: true, current: true, counts: { assets: 3 } });
  });

  it("raw/labeled pair 错配与 confirmed alias 歧义均在 preview 阶段失败关闭", async () => {
    const mismatched = await fixture({ mismatchedPair: true });
    const pairPreview = await previewCanonicalAssetMigration(mismatched.root);
    expect(pairPreview).toMatchObject({ canMigrate: false, pending: false });
    expect(pairPreview.blockers.join(" ")).toMatch(/原子 pair/u);

    const ambiguous = await fixture({ aliasConflict: true });
    const aliasPreview = await previewCanonicalAssetMigration(ambiguous.root);
    expect(aliasPreview).toMatchObject({ canMigrate: false, pending: false });
    expect(aliasPreview.blockers.join(" ")).toMatch(/alias.*冲突/iu);
    for (const [root, preview] of [[mismatched.root, pairPreview], [ambiguous.root, aliasPreview]] as const) {
      await expect(migrateCanonicalAssets(root, { expectedStoreRevision: 0, expectedCandidateFingerprint: preview.candidateFingerprint }))
        .rejects.toSatisfy((error: unknown) => isRejectedCommandFailure(error));
      await expect(access(getSidecarPaths(root).canonicalAssets)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("迁移前存在非空 legacy asset-relations 时失败关闭，不静默丢失关系", async () => {
    const input = await fixture();
    const relationPath = getSidecarPaths(input.root).assetRelations;
    await writeJson(relationPath, {
      schemaVersion: 1,
      revision: 1,
      relations: [{
        id: "legacy-relation-001",
        kind: "reference_of",
        parentItemId: "asset-C99",
        childItemId: "asset-P01",
        revision: 1,
        createdAt: "2026-07-17T00:00:00.000Z",
        updatedAt: "2026-07-17T00:00:00.000Z",
      }],
      updatedAt: "2026-07-17T00:00:00.000Z",
    });
    const preview = await previewCanonicalAssetMigration(input.root);
    expect(preview).toMatchObject({ storeRevision: 0, canMigrate: false, pending: false });
    expect(preview.blockers.join(" ")).toMatch(/legacy asset-relations\.json.*1 条.*禁止静默/u);
    await expect(migrateCanonicalAssets(input.root, {
      expectedStoreRevision: 0,
      expectedCandidateFingerprint: preview.candidateFingerprint,
    })).rejects.toSatisfy((error: unknown) => isRejectedCommandFailure(error));
    await expect(access(getSidecarPaths(input.root).canonicalAssets)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("规范资产不再进入旧 Review 队列，直调和命令总线均在任何业务写前明确拒绝", async () => {
    const input = await fixture();
    const preview = await previewCanonicalAssetMigration(input.root);
    await migrateCanonicalAssets(input.root, {
      expectedStoreRevision: preview.storeRevision,
      expectedCandidateFingerprint: preview.candidateFingerprint,
    });
    const queue = await getReviewQueue(input.root, { includeResolved: true });
    expect(queue.some((entry) => entry.item.id === "asset-P01")).toBe(false);

    const paths = getSidecarPaths(input.root);
    const reviewBytes = await readFile(paths.reviews);
    const indexBytes = await readFile(paths.index);
    const payload = {
      itemId: "asset-P01",
      reviewType: "image" as const,
      artifactIds: [],
      expectedScanId: "must-reject-before-validation",
      expectedArtifactHashes: {},
      decision: "pending" as const,
      criteria: [],
    };
    await expect(submitReview(input.root, payload)).rejects.toSatisfy((error: unknown) => isRejectedCommandFailure(error)
      && (error.result as { reason?: string }).reason === "canonical_asset_review_requires_append_only_command");
    expect(await readFile(paths.reviews)).toEqual(reviewBytes);
    expect(await readFile(paths.index)).toEqual(indexBytes);

    const command = {
      requestId: "request-canonical-review-reject-001",
      idempotencyKey: "canonical-review-reject-v1",
      request: { command: "submit_review" as const, payload },
    };
    await expect(executeIdempotentCommand(input.root, command)).rejects.toSatisfy((error: unknown) => isRejectedCommandFailure(error));
    const reconciled = await reconcileCommand(input.root, { idempotencyKey: command.idempotencyKey });
    expect(reconciled).toMatchObject({ status: "failed", replayed: true, result: { reason: "canonical_asset_review_requires_append_only_command" } });
    await expect(executeIdempotentCommand(input.root, { ...command, requestId: "request-canonical-review-reject-002" }))
      .rejects.toThrow(/已明确失败/u);
    expect(await readFile(paths.reviews)).toEqual(reviewBytes);
    expect(await readFile(paths.index)).toEqual(indexBytes);
  });

  it("规范库启用后 legacy 关系写入零写拒绝，list 只返回 canonical 只读投影", async () => {
    const input = await fixture();
    const preview = await previewCanonicalAssetMigration(input.root);
    await migrateCanonicalAssets(input.root, {
      expectedStoreRevision: preview.storeRevision,
      expectedCandidateFingerprint: preview.candidateFingerprint,
    });
    const relationPath = getSidecarPaths(input.root).assetRelations;
    await expect(access(relationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(upsertAssetRelation(input.root, {
      kind: "reference_of",
      parentItemId: "asset-C99",
      childItemId: "asset-P01",
    })).rejects.toSatisfy((error: unknown) => isRejectedCommandFailure(error)
      && (error.result as { reason?: string }).reason === "canonical_asset_relation_requires_canonical_command");
    await expect(access(relationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(listAssetRelations(input.root)).resolves.toEqual([]);
  });

  it("相同 candidate 重放零写不增 revision；新 definition 保留旧版本并强制 store CAS", async () => {
    const input = await fixture();
    const firstPreview = await previewCanonicalAssetMigration(input.root);
    await migrateCanonicalAssets(input.root, { expectedStoreRevision: 0, expectedCandidateFingerprint: firstPreview.candidateFingerprint });
    const before = await readFile(getSidecarPaths(input.root).canonicalAssets, "utf8");
    const beforeStat = await stat(getSidecarPaths(input.root).canonicalAssets);
    const replay = await migrateCanonicalAssets(input.root, { expectedStoreRevision: 0, expectedCandidateFingerprint: firstPreview.candidateFingerprint });
    const afterStat = await stat(getSidecarPaths(input.root).canonicalAssets);
    expect(replay).toMatchObject({ applied: false, replayed: true, previousRevision: 1, storeRevision: 1 });
    expect(await readFile(getSidecarPaths(input.root).canonicalAssets, "utf8")).toBe(before);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);

    const catalog = JSON.parse(await readFile(input.catalogPath, "utf8")) as { assets: Array<{ definition: Record<string, unknown> }> };
    const c02 = catalog.assets.find((entry) => entry.definition.id === "C02")!;
    c02.definition.name = "空资产修订名";
    c02.definition.sourceSection = "### C02 空资产修订名\n\n- **用途**：测试修订。";
    c02.definition.sourceSectionSha256 = sha(String(c02.definition.sourceSection));
    await writeJson(input.catalogPath, catalog);
    const changed = await previewCanonicalAssetMigration(input.root);
    expect(changed).toMatchObject({ storeRevision: 1, pending: true, canMigrate: true, counts: { definitionVersions: 4, contractVersions: 3 } });
    await expect(migrateCanonicalAssets(input.root, { expectedStoreRevision: 0, expectedCandidateFingerprint: changed.candidateFingerprint }))
      .rejects.toSatisfy((error: unknown) => isRejectedCommandFailure(error)
        && (error.result as { reason?: string }).reason === "revision_conflict");
    const second = await migrateCanonicalAssets(input.root, { expectedStoreRevision: 1, expectedCandidateFingerprint: changed.candidateFingerprint });
    expect(second).toMatchObject({ applied: true, replayed: false, previousRevision: 1, storeRevision: 2 });
    const detail = await getCanonicalAsset(input.root, "C02");
    expect(detail.definitionVersions).toHaveLength(2);
    expect(detail.asset.canonicalName).toBe("空资产修订名");
    expect(detail.definitionVersions.some((version) => version.definition.name === "空资产")).toBe(true);
    expect(detail.asset.revision).toBe(2);
  });

  it("只从正式名和显式同一资产证据生成 confirmed alias，不从普通剧情猜测", async () => {
    const input = await fixture({ includeAliasAssets: true });
    const preview = await previewCanonicalAssetMigration(input.root);
    expect(preview).toMatchObject({ canMigrate: true, pending: true, counts: { assets: 5, aliases: 14 } });
    await migrateCanonicalAssets(input.root, {
      expectedStoreRevision: preview.storeRevision,
      expectedCandidateFingerprint: preview.candidateFingerprint,
    });

    await expect(listCanonicalAssets(input.root, { search: "旧铜鱼挂坠" })).resolves.toMatchObject({
      total: 1,
      items: [{ id: "P04" }],
    });
    await expect(listCanonicalAssets(input.root, { search: "半璧" })).resolves.toMatchObject({
      total: 1,
      items: [{ id: "P03" }],
    });
    const p03 = await getCanonicalAsset(input.root, "P03");
    expect(p03.aliases).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "formal-name-subject", value: "半璧", source: expect.objectContaining({ kind: "definition-name" }) }),
      expect.objectContaining({ kind: "explicit-parenthetical-name", value: "随魂素玉", source: expect.objectContaining({ kind: "definition-name" }) }),
    ]));
    const p04 = await getCanonicalAsset(input.root, "P04");
    expect(p04.aliases).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "explicit-same-asset-name", value: "旧铜鱼挂坠", source: expect.objectContaining({ kind: "definition-source-section" }) }),
    ]));
    expect(p04.aliases.some((alias) => alias.value.includes("记名匣"))).toBe(false);
  });

  it("重迁移追加保留 Authority/AssetVersion 历史，当前投影只使用新 head，第三次重放零写", async () => {
    const input = await fixture();
    const firstPreview = await previewCanonicalAssetMigration(input.root);
    await migrateCanonicalAssets(input.root, {
      expectedStoreRevision: firstPreview.storeRevision,
      expectedCandidateFingerprint: firstPreview.candidateFingerprint,
    });
    const firstStore = (await loadCanonicalAssetStore(input.root))!;
    const firstP01 = firstStore.assets.find((asset) => asset.id === "P01")!;
    const oldPrimaryAuthorityId = firstP01.primaryAuthorityId!;
    const oldPrimaryAuthority = firstStore.authorities.find((authority) => authority.id === oldPrimaryAuthorityId)!;
    const oldPrimaryVersionId = oldPrimaryAuthority.assetVersionId;
    const oldSupportingAuthorityId = firstP01.currentSupportingAuthorityIds![0]!;
    const oldSupportingAuthority = firstStore.authorities.find((authority) => authority.id === oldSupportingAuthorityId)!;
    const oldSupportingVersionId = oldSupportingAuthority.assetVersionId;

    const catalog = JSON.parse(await readFile(input.catalogPath, "utf8")) as { assets: Array<{ definition: Record<string, unknown> }> };
    const p01 = catalog.assets.find((entry) => entry.definition.id === "P01")!;
    p01.definition.name = "胸前布囊修订名";
    p01.definition.sourceSection = "### P01 胸前布囊修订名\n\n- **用途**：仅修订规范定义。";
    p01.definition.sourceSectionSha256 = sha(String(p01.definition.sourceSection));
    await writeJson(input.catalogPath, catalog);

    const secondPreview = await previewCanonicalAssetMigration(input.root);
    expect(secondPreview).toMatchObject({
      storeRevision: 1,
      pending: true,
      canMigrate: true,
      counts: { definitionVersions: 4, versions: 5, authorities: 5, relations: 2, supportingAuthorities: 1 },
    });
    await migrateCanonicalAssets(input.root, {
      expectedStoreRevision: secondPreview.storeRevision,
      expectedCandidateFingerprint: secondPreview.candidateFingerprint,
    });

    const secondStore = (await loadCanonicalAssetStore(input.root))!;
    const secondP01 = secondStore.assets.find((asset) => asset.id === "P01")!;
    expect(secondP01.revision).toBe(2);
    expect(secondStore.assets.filter((asset) => asset.id !== "P01").every((asset) => asset.revision === 1)).toBe(true);
    expect(secondP01.primaryAuthorityId).not.toBe(oldPrimaryAuthorityId);
    expect(secondP01.currentSupportingAuthorityIds).toHaveLength(1);
    expect(secondP01.currentSupportingAuthorityIds![0]).not.toBe(oldSupportingAuthorityId);
    expect(secondStore.versions.map((version) => version.id)).toEqual(expect.arrayContaining([oldPrimaryVersionId, oldSupportingVersionId]));
    expect(secondStore.authorities.map((authority) => authority.id)).toEqual(expect.arrayContaining([oldPrimaryAuthorityId, oldSupportingAuthorityId]));
    const currentGolden = secondStore.authorities.find((authority) => authority.id === secondP01.currentSupportingAuthorityIds![0])!;
    expect(currentGolden).toMatchObject({ role: "supporting-identity", exposure: "forbidden", scope: { usage: "human-review-only" } });
    expect(secondStore.relations.filter((relation) => relation.kind === "supersedes")).toHaveLength(2);

    const detail = await getCanonicalAsset(input.root, "P01");
    expect(detail.versions.some((version) => version.id === oldPrimaryVersionId)).toBe(true);
    expect(detail.versions.some((version) => version.id === oldSupportingVersionId)).toBe(true);
    expect(detail.authorities.some((authority) => authority.id === oldPrimaryAuthorityId)).toBe(true);
    expect(detail.authorities.some((authority) => authority.id === oldSupportingAuthorityId)).toBe(true);
    const projection = (await loadCurrentCanonicalAssetAuthorityProjection(input.root))!;
    const projectedP01 = projection.assets.find((asset) => asset.assetId === "P01")!;
    expect(projectedP01.authorityId).toBe(secondP01.primaryAuthorityId);
    expect(projectedP01.versionId).not.toBe(oldPrimaryVersionId);
    expect(projection.assets.some((asset) => asset.authorityId === oldPrimaryAuthorityId || asset.versionId === oldSupportingVersionId)).toBe(false);

    const bytesBeforeReplay = await readFile(getSidecarPaths(input.root).canonicalAssets);
    const thirdPreview = await previewCanonicalAssetMigration(input.root);
    expect(thirdPreview).toMatchObject({ storeRevision: 2, pending: false, canMigrate: false });
    const replay = await migrateCanonicalAssets(input.root, {
      expectedStoreRevision: thirdPreview.storeRevision,
      expectedCandidateFingerprint: thirdPreview.candidateFingerprint,
    });
    expect(replay).toMatchObject({ applied: false, replayed: true, storeRevision: 2 });
    expect(await readFile(getSidecarPaths(input.root).canonicalAssets)).toEqual(bytesBeforeReplay);
  });

  it("旧 v1 store 仅因 alias 算法升级而待迁移时，复用语义相同的 Version/Authority 且不增资产 revision", async () => {
    const input = await fixture();
    const initialPreview = await previewCanonicalAssetMigration(input.root);
    await migrateCanonicalAssets(input.root, {
      expectedStoreRevision: initialPreview.storeRevision,
      expectedCandidateFingerprint: initialPreview.candidateFingerprint,
    });
    const legacy = legacyFingerprintStore((await loadCanonicalAssetStore(input.root))!);
    await writeJson(getSidecarPaths(input.root).canonicalAssets, legacy);
    const loadedLegacy = (await loadCanonicalAssetStore(input.root))!;
    const versionIds = loadedLegacy.versions.map((version) => version.id);
    const authorityIds = loadedLegacy.authorities.map((authority) => authority.id);
    const revisions = Object.fromEntries(loadedLegacy.assets.map((asset) => [asset.id, asset.revision]));

    const upgradePreview = await previewCanonicalAssetMigration(input.root);
    expect(upgradePreview).toMatchObject({
      storeRevision: 1,
      pending: true,
      canMigrate: true,
      blockers: [],
      counts: { versions: 3, authorities: 3, relations: 0 },
    });
    await migrateCanonicalAssets(input.root, {
      expectedStoreRevision: upgradePreview.storeRevision,
      expectedCandidateFingerprint: upgradePreview.candidateFingerprint,
    });
    const upgraded = (await loadCanonicalAssetStore(input.root))!;
    expect(upgraded.versions.map((version) => version.id)).toEqual(versionIds);
    expect(upgraded.authorities.map((authority) => authority.id)).toEqual(authorityIds);
    expect(Object.fromEntries(upgraded.assets.map((asset) => [asset.id, asset.revision]))).toEqual(revisions);
    expect(upgraded.relations).toEqual([]);
    await expect(inspectCanonicalAssetStoreCurrentness(input.root)).resolves.toMatchObject({ current: true, storeRevision: 2 });
  });

  it("移除当前 supporting head 后保留历史 Authority，但显式空数组不会把历史误当当前", async () => {
    const input = await fixture();
    const firstPreview = await previewCanonicalAssetMigration(input.root);
    await migrateCanonicalAssets(input.root, {
      expectedStoreRevision: firstPreview.storeRevision,
      expectedCandidateFingerprint: firstPreview.candidateFingerprint,
    });
    const firstStore = (await loadCanonicalAssetStore(input.root))!;
    const historicalGoldenId = firstStore.assets.find((asset) => asset.id === "P01")!.currentSupportingAuthorityIds![0]!;

    const materializationPath = path.join(input.root, "fusion-production-materialization.json");
    const materialization = JSON.parse(await readFile(materializationPath, "utf8")) as {
      authorities: Array<{ id: string }>;
    };
    materialization.authorities = materialization.authorities.filter((authority) => authority.id !== "golden-mask");
    await writeJson(materializationPath, materialization);
    const secondPreview = await previewCanonicalAssetMigration(input.root);
    expect(secondPreview).toMatchObject({
      storeRevision: 1,
      pending: true,
      canMigrate: true,
      counts: { versions: 3, authorities: 3, supportingAuthorities: 0 },
    });
    await migrateCanonicalAssets(input.root, {
      expectedStoreRevision: secondPreview.storeRevision,
      expectedCandidateFingerprint: secondPreview.candidateFingerprint,
    });

    const store = (await loadCanonicalAssetStore(input.root))!;
    const p01 = store.assets.find((asset) => asset.id === "P01")!;
    expect(p01.currentSupportingAuthorityIds).toEqual([]);
    expect(store.authorities.some((authority) => authority.id === historicalGoldenId && authority.role === "supporting-identity")).toBe(true);
    await expect(listCanonicalAssets(input.root, { search: "P01" })).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: "P01", hasSupportingAuthority: false, authorityCount: 2 })],
    });
    const projection = (await loadCurrentCanonicalAssetAuthorityProjection(input.root))!;
    expect(projection.assets.some((asset) => asset.authorityId === historicalGoldenId || asset.path === input.goldenPath)).toBe(false);
  });

  it("历史版本可复用同路径同 SHA 媒体，但同路径换 SHA 必须改用 CAS 路径", async () => {
    const input = await fixture();
    const firstPreview = await previewCanonicalAssetMigration(input.root);
    await migrateCanonicalAssets(input.root, {
      expectedStoreRevision: firstPreview.storeRevision,
      expectedCandidateFingerprint: firstPreview.candidateFingerprint,
    });
    const nextRaw = Buffer.from("reviewed-raw-image-v2-same-path");
    await writeFile(input.rawPath, nextRaw);
    const paths = getSidecarPaths(input.root);
    const index = JSON.parse(await readFile(paths.index, "utf8")) as {
      artifacts: Array<{ id: string; check: { size: number; sha256: string } }>;
    };
    const rawArtifact = index.artifacts.find((artifact) => artifact.id === "artifact-P01-raw")!;
    rawArtifact.check.size = nextRaw.byteLength;
    rawArtifact.check.sha256 = sha(nextRaw);
    await writeJson(paths.index, index);
    const reviews = JSON.parse(await readFile(paths.reviews, "utf8")) as {
      records: Array<{ artifactEvidence: Array<{ artifactId: string; size: number; sha256: string }> }>;
    };
    const rawEvidence = reviews.records[0]!.artifactEvidence.find((evidence) => evidence.artifactId === "artifact-P01-raw")!;
    rawEvidence.size = nextRaw.byteLength;
    rawEvidence.sha256 = sha(nextRaw);
    await writeJson(paths.reviews, reviews);
    const publications = JSON.parse(await readFile(paths.publications, "utf8")) as {
      receipts: Array<{ id: string; check: { size: number; sha256: string } }>;
    };
    const rawReceipt = publications.receipts.find((receipt) => receipt.id === "receipt-P01-raw")!;
    rawReceipt.check.size = nextRaw.byteLength;
    rawReceipt.check.sha256 = sha(nextRaw);
    await writeJson(paths.publications, publications);

    const blocked = await previewCanonicalAssetMigration(input.root);
    expect(blocked).toMatchObject({ storeRevision: 1, canMigrate: false, pending: false });
    expect(blocked.blockers.join(" ")).toMatch(/同一媒体路径但 SHA 不同.*CAS/u);
    await expect(listCanonicalAssets(input.root)).rejects.toThrow(/漂移/u);
    await expect(getCanonicalAsset(input.root, "P01")).rejects.toThrow(/漂移/u);
  });

  it("命令总线在 store 已提交但终态事件前崩溃时，仅从规范资产 store 对账且不重复迁移", async () => {
    const input = await fixture();
    const preview = await previewCanonicalAssetMigration(input.root);
    const command = {
      requestId: "request-canonical-migration-crash-001",
      idempotencyKey: "canonical-migration-crash-after-store-v1",
      request: {
        command: "migrate_canonical_assets" as const,
        payload: {
          expectedStoreRevision: preview.storeRevision,
          expectedCandidateFingerprint: preview.candidateFingerprint,
        },
      },
    };

    process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT = command.request.command;
    await expect(executeIdempotentCommand(input.root, command)).rejects.toThrow("结果未确认");
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT;

    const afterCrash = (await loadCanonicalAssetStore(input.root))!;
    expect(afterCrash.revision).toBe(1);
    const storeBytes = await readFile(getSidecarPaths(input.root).canonicalAssets);

    const reconciled = await reconcileCommand(input.root, { idempotencyKey: command.idempotencyKey });
    expect(reconciled).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        kind: "canonical-asset-migration-result",
        applied: false,
        replayed: true,
        reconciled: true,
        storeRevision: 1,
        candidateFingerprint: preview.candidateFingerprint,
      },
    });
    expect(await readFile(getSidecarPaths(input.root).canonicalAssets)).toEqual(storeBytes);
    expect((await loadCanonicalAssetStore(input.root))?.revision).toBe(1);

    const replay = await executeIdempotentCommand(input.root, { ...command, requestId: "request-canonical-migration-crash-002" });
    expect(replay).toMatchObject({ status: "succeeded", replayed: true, result: { reconciled: true, storeRevision: 1 } });
    expect(await readFile(getSidecarPaths(input.root).canonicalAssets)).toEqual(storeBytes);
  });

  it("下游权威投影只返回主权威，媒体漂移后失败关闭且不退回旧硬锁", async () => {
    const input = await fixture();
    const preview = await previewCanonicalAssetMigration(input.root);
    await migrateCanonicalAssets(input.root, {
      expectedStoreRevision: preview.storeRevision,
      expectedCandidateFingerprint: preview.candidateFingerprint,
    });
    const projection = await loadCurrentCanonicalAssetAuthorityProjection(input.root);
    expect(projection?.assets).toHaveLength(2);
    expect(projection?.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: "C99", authority: "user-authority", path: input.authorityPath }),
      expect.objectContaining({ assetId: "P01", authority: "reviewed-hard-lock", path: input.rawPath, reviewId: "review-P01-pass" }),
    ]));
    expect(projection?.assets.some((entry) => entry.path === input.goldenPath)).toBe(false);

    await writeFile(input.rawPath, "tampered-after-canonical-migration");
    await expect(inspectCanonicalAssetStoreCurrentness(input.root)).resolves.toMatchObject({ available: true, current: false });
    await expect(getCanonicalAssetCatalogState(input.root)).resolves.toMatchObject({ available: true, current: false });
    await expect(previewCanonicalAssetMigration(input.root)).resolves.toMatchObject({ storeRevision: 1, canMigrate: false, pending: false });
    await expect(listCanonicalAssets(input.root)).rejects.toThrow(/漂移.*禁止读取资产列表/u);
    await expect(getCanonicalAsset(input.root, "P01")).rejects.toThrow(/漂移.*禁止读取资产详情/u);
    await expect(loadCurrentCanonicalAssetAuthorityProjection(input.root)).rejects.toThrow(/禁止回退旧权威算法/u);
  });

  it("Scanner 在规范库存在时按显式类别与版本选权威，不接受更新文件名或旧 override 猜测", async () => {
    const input = await fixture();
    const preview = await previewCanonicalAssetMigration(input.root);
    await migrateCanonicalAssets(input.root, {
      expectedStoreRevision: preview.storeRevision,
      expectedCandidateFingerprint: preview.candidateFingerprint,
    });
    const signedIndex = JSON.parse(await readFile(getSidecarPaths(input.root).index, "utf8"));
    const cache = new ProjectCache(input.root);
    cache.replaceIndex(signedIndex);
    cache.close();
    const duplicateIndex = structuredClone(signedIndex) as {
      items: Array<{ id: string; artifactIds: string[] }>;
      artifacts: Array<{ id: string; itemId: string; authoritative: boolean }>;
    };
    const duplicateArtifact = duplicateIndex.artifacts.find((artifact) => artifact.itemId === "asset-P01")!;
    duplicateIndex.artifacts.push({ ...structuredClone(duplicateArtifact), authoritative: false });
    duplicateIndex.items.find((item) => item.id === "asset-P01")!.artifactIds.push(duplicateArtifact.id);
    await writeJson(getSidecarPaths(input.root).index, duplicateIndex);
    const metadataOnlyProject = JSON.parse(await readFile(getSidecarPaths(input.root).config, "utf8")) as { updatedAt: string };
    metadataOnlyProject.updatedAt = "2026-07-17T03:00:00.000Z";
    await writeJson(getSidecarPaths(input.root).config, metadataOnlyProject);
    expect((await inspectCanonicalAssetStoreCurrentness(input.root)).current).toBe(false);
    const unrelatedRaw = path.join(path.dirname(input.rawPath), "P01_newer_but_unreviewed_raw.png");
    await writeFile(unrelatedRaw, "unreviewed-newer-candidate");
    await writeJson(getSidecarPaths(input.root).overrides, {
      schemaVersion: 1,
      items: {
        "asset-P01": {
          authoritativePaths: { "raw-image:generic": unrelatedRaw },
          updatedAt: "2026-07-17T02:00:00.000Z",
        },
      },
    });

    const index = await scanProject({ projectRoot: input.root, persist: false, includeHashes: true });
    const c99 = index.items.find((item) => item.id === "asset-C99")!;
    const c02 = index.items.find((item) => item.id === "asset-C02")!;
    const p01 = index.items.find((item) => item.id === "asset-P01")!;
    expect(c99.assetCategory).toBe("scene");
    expect(c02.assetCategory).toBe("character");
    expect(p01.assetCategory).toBe("prop");
    expect(c99.hardLockIds).toEqual(["C99"]);
    expect(c02.hardLockIds).toEqual([]);
    expect(p01.hardLockIds).toEqual(["P01"]);
    const p01Raw = index.artifacts.filter((artifact) => artifact.itemId === p01.id && artifact.kind === "raw-image");
    expect(new Set(index.artifacts.map((artifact) => artifact.id)).size).toBe(index.artifacts.length);
    expect(new Set(p01Raw.map((artifact) => artifact.path)).size).toBe(p01Raw.length);
    expect(p01Raw.find((artifact) => artifact.authoritative)?.path).toBe(input.rawPath);
    expect(p01Raw.find((artifact) => artifact.path === unrelatedRaw)?.authoritative).toBe(false);
  });

  it("P2 权威快照复用规范版本 ID，不重新根据 config、mtime 或路径计算 referenceVersion", async () => {
    const input = await fixture();
    const preview = await previewCanonicalAssetMigration(input.root);
    await migrateCanonicalAssets(input.root, {
      expectedStoreRevision: preview.storeRevision,
      expectedCandidateFingerprint: preview.candidateFingerprint,
    });
    const store = (await loadCanonicalAssetStore(input.root))!;
    const catalog = JSON.parse(await readFile(input.catalogPath, "utf8"));
    const index = JSON.parse(await readFile(getSidecarPaths(input.root).index, "utf8"));
    const reviews = JSON.parse(await readFile(getSidecarPaths(input.root).reviews, "utf8"));
    const locks = await resolvePanelHardLockSnapshots(input.root, index, catalog, reviews, { schemaVersion: 1, items: {} });
    expect([...locks.keys()].sort()).toEqual(["C99", "P01"]);
    for (const assetId of ["C99", "P01"]) {
      const authority = store.authorities.find((entry) => entry.id === store.assets.find((asset) => asset.id === assetId)?.primaryAuthorityId)!;
      expect(locks.get(assetId)).toMatchObject({
        lockId: authority.id,
        referenceVersion: authority.assetVersionId,
      });
    }
    expect([...locks.values()].some((entry) => entry.path === input.goldenPath)).toBe(false);
  });

  it("规范库启用后关闭旧 overrides/hardLocks 资产写旁路", async () => {
    const input = await fixture();
    const preview = await previewCanonicalAssetMigration(input.root);
    await migrateCanonicalAssets(input.root, {
      expectedStoreRevision: preview.storeRevision,
      expectedCandidateFingerprint: preview.candidateFingerprint,
    });
    const index = await scanProject({ projectRoot: input.root, persist: false, includeHashes: true });
    await writeJson(getSidecarPaths(input.root).index, index);
    const p01ArtifactId = index.artifacts.find((artifact) => artifact.itemId === "asset-P01" && artifact.kind === "raw-image" && artifact.authoritative)?.id ?? "missing";
    await expect(setAuthoritativeArtifact(input.root, "asset-P01", p01ArtifactId)).rejects.toThrow(/不得写入旧 overrides/u);
    await expect(promoteAssetToHardLock(input.root, "asset-P01")).rejects.toThrow(/旧 hardLocks 提升入口已关闭/u);
    await expect(updateStatus(input.root, "asset-P01", "待视觉验收")).rejects.toThrow(/不得写入旧 overrides/u);
  });

  it("stale preview、媒体篡改与 symlink 替换都拒绝写入", async () => {
    const tampered = await fixture();
    const preview = await previewCanonicalAssetMigration(tampered.root);
    await writeFile(tampered.authorityPath, "tampered-authority-bytes");
    await expect(migrateCanonicalAssets(tampered.root, { expectedStoreRevision: 0, expectedCandidateFingerprint: preview.candidateFingerprint }))
      .rejects.toSatisfy((error: unknown) => isRejectedCommandFailure(error)
        && ["candidate_drift", "unsafe_candidates"].includes((error.result as { reason?: string }).reason ?? ""));
    expect((await previewCanonicalAssetMigration(tampered.root)).blockers.join(" ")).toMatch(/SHA.*漂移/u);
    await expect(access(getSidecarPaths(tampered.root).canonicalAssets)).rejects.toMatchObject({ code: "ENOENT" });

    const linked = await fixture();
    const realTarget = path.join(linked.root, "authorities", "scene", "real-target.png");
    const original = await readFile(linked.authorityPath);
    await writeFile(realTarget, original);
    await rm(linked.authorityPath);
    await symlink(realTarget, linked.authorityPath);
    const linkedPreview = await previewCanonicalAssetMigration(linked.root);
    expect(linkedPreview).toMatchObject({ canMigrate: false, pending: false });
    expect(linkedPreview.blockers.join(" ")).toMatch(/符号链接|realpath/u);
  });

  it("Review SHA 漂移与 Publication receipt 悬空均阻断迁移", async () => {
    const badReview = await fixture({ reviewShaMismatch: true });
    const reviewPreview = await previewCanonicalAssetMigration(badReview.root);
    expect(reviewPreview).toMatchObject({ canMigrate: false, pending: false });
    expect(reviewPreview.blockers.join(" ")).toMatch(/Review.*不一致/u);

    const dangling = await fixture({ danglingReceipt: true });
    const receiptPreview = await previewCanonicalAssetMigration(dangling.root);
    expect(receiptPreview).toMatchObject({ canMigrate: false, pending: false });
    expect(receiptPreview.blockers.join(" ")).toMatch(/intent 悬空|未注册/u);
  });
});
