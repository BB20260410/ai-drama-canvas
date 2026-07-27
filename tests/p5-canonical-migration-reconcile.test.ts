import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadCanonicalAssetStore,
  previewCanonicalAssetMigration,
} from "../src/core/canonical-assets.js";
import {
  executeIdempotentCommand,
  listCommandLedger,
  reconcileCommand,
  type IdempotentCommandInput,
} from "../src/core/command-bus.js";
import { getSidecarPaths, listEvents } from "../src/core/sidecar.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface Fixture {
  root: string;
  catalogPath: string;
  configPath: string;
  authorityPath: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p5-canonical-reconcile-"));
  roots.push(root);
  const paths = getSidecarPaths(root);
  const assetDirectory = path.join(root, "assets", "S01");
  const authorityPath = path.join(root, "authorities", "S01_reference.png");
  await Promise.all([
    mkdir(paths.root, { recursive: true }),
    mkdir(assetDirectory, { recursive: true }),
    mkdir(path.dirname(authorityPath), { recursive: true }),
  ]);

  const authorityBytes = Buffer.from("canonical-scene-authority-v1");
  await writeFile(authorityPath, authorityBytes);
  const sourceSection = "### S01 测试场景\n\n- **用途**：故障注入。";
  const sourceContentAddress = `sha256:${sha("p5-reconcile-source")}`;
  const authority = {
    id: "authority-S01",
    assetId: "S01",
    name: "S01 用户权威参考",
    sourcePath: "/read-only-source/S01_reference.png",
    sourceSha256: sha(authorityBytes),
    snapshotPath: authorityPath,
    snapshotSha256: sha(authorityBytes),
    rules: ["场景布局固定", "禁止替换空间结构"],
    exposeToGeneration: true,
  };
  const definition = {
    id: "S01",
    category: "scene",
    name: "测试场景",
    declaredUsage: "故障注入",
    generationPrompts: [{ label: "AI 出图提示词", prompt: "电影写实测试场景" }],
    sourceMarkdownPath: "05_提示词/00_全季资产库.md",
    sourceHeadingLine: 1,
    sourceSectionSha256: sha(sourceSection),
    sourceSection,
    generationStatus: "not-generated",
    hardLockStatus: "locked",
  };
  const contract = {
    schemaVersion: 1,
    kind: "asset-generation-contract",
    contractId: "contract-S01",
    assetId: "S01",
    assetCategory: "scene",
    prompt: "测试场景合同",
    aspectRatio: "9:16",
    authorityReferences: [{ path: authorityPath, sha256: sha(authorityBytes), role: "authority" }],
    acceptanceRequirements: ["权威图 SHA 固定"],
  };
  const catalogPath = paths.productionAssets;
  await writeJson(catalogPath, {
    schemaVersion: 1,
    kind: "fusion-production-assets",
    revision: 1,
    projectId: "project-p5-reconcile",
    sourceContentAddress,
    assets: [{
      workItemId: "asset-S01",
      definition,
      contract,
      directoryPath: assetDirectory,
      infoPath: path.join(assetDirectory, "00_信息.md"),
      outputDirectory: path.join(assetDirectory, "AI画布生成"),
      authority,
    }],
  });
  await writeJson(path.join(root, "fusion-production-materialization.json"), {
    schemaVersion: 1,
    kind: "fusion-production-materialization",
    receiptId: "materialization-p5-reconcile",
    createdAt: "2026-07-18T00:00:00.000Z",
    sourceContentAddress,
    targetRoot: root,
    authorities: [authority],
    counts: { assets: 1, characters: 0, scenes: 1, props: 0 },
  });
  const artifact = {
    id: "artifact-S01-raw",
    itemId: "asset-S01",
    path: authorityPath,
    rootSlot: "main",
    relativePath: path.relative(root, authorityPath).split(path.sep).join("/"),
    kind: "raw-image",
    variant: "generic",
    deprecated: false,
    authoritative: true,
    check: {
      ok: true,
      exists: true,
      decodable: true,
      width: 720,
      height: 1280,
      size: authorityBytes.byteLength,
      sha256: sha(authorityBytes),
      issues: [],
    },
  };
  await writeJson(paths.index, {
    schemaVersion: 1,
    project: { id: "project-p5-reconcile" },
    items: [{ id: "asset-S01", type: "asset", artifactIds: [artifact.id], hardLockIds: [] }],
    artifacts: [artifact],
  });
  await writeJson(paths.reviews, { schemaVersion: 1, records: [] });
  await writeJson(paths.publications, { schemaVersion: 1, revision: 0, intents: [], receipts: [] });
  await writeJson(paths.config, {
    schemaVersion: 1,
    id: "project-p5-reconcile",
    hardLocks: [],
    updatedAt: "2026-07-18T00:00:00.000Z",
  });
  return { root, catalogPath, configPath: paths.config, authorityPath };
}

async function crashAfterStoreCommit(input: Fixture, suffix: string): Promise<{
  command: IdempotentCommandInput;
  candidateFingerprint: string;
  storeBytes: Buffer;
}> {
  const preview = await previewCanonicalAssetMigration(input.root);
  expect(preview).toMatchObject({ storeRevision: 0, pending: true, canMigrate: true, blockers: [] });
  const command: IdempotentCommandInput = {
    requestId: `request-p5-canonical-${suffix}-001`,
    idempotencyKey: `p5-canonical-${suffix}-after-store-v1`,
    request: {
      command: "migrate_canonical_assets",
      payload: {
        expectedStoreRevision: preview.storeRevision,
        expectedCandidateFingerprint: preview.candidateFingerprint,
      },
    },
  };
  process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT = command.request.command;
  try {
    await expect(executeIdempotentCommand(input.root, command)).rejects.toThrow("结果未确认");
  } finally {
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT;
  }
  expect((await listCommandLedger(input.root))[0]).toMatchObject({
    status: "unknown",
    durableReconciliation: { schemaVersion: 1, request: command.request },
  });
  expect((await loadCanonicalAssetStore(input.root))?.revision).toBe(1);
  return {
    command,
    candidateFingerprint: preview.candidateFingerprint,
    storeBytes: await readFile(getSidecarPaths(input.root).canonicalAssets),
  };
}

describe("P5 canonical migration durable reconciliation", () => {
  it("store 提交后仅 source raw bytes 改变时按语义身份恢复，且不改写 store", async () => {
    const input = await fixture();
    const crashed = await crashAfterStoreCommit(input, "metadata-drift");
    const committedStore = (await loadCanonicalAssetStore(input.root))!;
    const config = JSON.parse(await readFile(input.configPath, "utf8")) as { updatedAt: string };
    config.updatedAt = "2026-07-18T01:00:00.000Z";
    await writeJson(input.configPath, config);

    const afterRawChange = await previewCanonicalAssetMigration(input.root);
    expect(afterRawChange).toMatchObject({
      blockers: [],
      pending: false,
      storeRevision: committedStore.revision,
      candidateFingerprint: crashed.candidateFingerprint,
    });
    expect(afterRawChange.sourceSnapshot?.files.find((entry) => entry.role === "project")?.semanticSha256)
      .toBe(committedStore.sourceSnapshot.files.find((entry) => entry.role === "project")?.semanticSha256);
    expect(afterRawChange.candidateStoreFingerprint).not.toBe(committedStore.storeFingerprint);

    const reconciled = await reconcileCommand(input.root, { idempotencyKey: crashed.command.idempotencyKey });
    expect(reconciled).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        kind: "canonical-asset-migration-result",
        applied: false,
        replayed: true,
        reconciled: true,
        storeRevision: 1,
        candidateFingerprint: crashed.candidateFingerprint,
        storeFingerprint: committedStore.storeFingerprint,
      },
    });
    expect(await readFile(getSidecarPaths(input.root).canonicalAssets)).toEqual(crashed.storeBytes);
    expect((await loadCanonicalAssetStore(input.root))?.revision).toBe(1);
    const proofEvent = (await listEvents(input.root, 100))
      .find((event) => event.type === "command.reconciled" && event.idempotencyKey === crashed.command.idempotencyKey);
    expect(proofEvent?.data).toMatchObject({
      evidenceSource: "canonical-asset-store",
      durableIdentity: {
        candidateFingerprint: crashed.candidateFingerprint,
        storeFingerprint: committedStore.storeFingerprint,
        observedCandidateStoreFingerprint: afterRawChange.candidateStoreFingerprint,
        rawSourceSnapshotChanged: true,
        storeRevision: 1,
      },
    });

    const replayed = await executeIdempotentCommand(input.root, {
      ...crashed.command,
      requestId: "request-p5-canonical-metadata-drift-002",
    });
    expect(replayed).toMatchObject({ status: "succeeded", replayed: true, result: { reconciled: true, storeRevision: 1 } });
    expect(await readFile(getSidecarPaths(input.root).canonicalAssets)).toEqual(crashed.storeBytes);
  });

  it.each(["semantic", "media"] as const)("真实 %s 漂移保持 unknown，且绝不重执行迁移", async (drift) => {
    const input = await fixture();
    const crashed = await crashAfterStoreCommit(input, `${drift}-drift`);
    if (drift === "semantic") {
      const catalog = JSON.parse(await readFile(input.catalogPath, "utf8")) as {
        assets: Array<{ definition: { name: string; sourceSection: string; sourceSectionSha256: string } }>;
      };
      const definition = catalog.assets[0]!.definition;
      definition.name = "测试场景语义修订";
      definition.sourceSection = "### S01 测试场景语义修订\n\n- **用途**：真实语义变化。";
      definition.sourceSectionSha256 = sha(definition.sourceSection);
      await writeJson(input.catalogPath, catalog);
      const drifted = await previewCanonicalAssetMigration(input.root);
      expect(drifted.blockers).toEqual([]);
      expect(drifted.pending).toBe(true);
      expect(drifted.candidateFingerprint).not.toBe(crashed.candidateFingerprint);
    } else {
      await writeFile(input.authorityPath, "canonical-scene-authority-media-drift");
      const drifted = await previewCanonicalAssetMigration(input.root);
      expect(drifted.blockers.join(" ")).toMatch(/SHA.*漂移/iu);
      expect(drifted.candidateFingerprint).not.toBe(crashed.candidateFingerprint);
    }

    await expect(reconcileCommand(input.root, { idempotencyKey: crashed.command.idempotencyKey }))
      .rejects.toThrow(/终态提交证据/u);
    await expect(executeIdempotentCommand(input.root, {
      ...crashed.command,
      requestId: `request-p5-canonical-${drift}-drift-002`,
    })).rejects.toThrow(/保持 unknown|禁止自动重放/u);
    expect((await listCommandLedger(input.root))[0]?.status).toBe("unknown");
    expect(await readFile(getSidecarPaths(input.root).canonicalAssets)).toEqual(crashed.storeBytes);
    expect((await loadCanonicalAssetStore(input.root))?.revision).toBe(1);
  });
});
