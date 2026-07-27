import { chmod, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  type StudioCommandRequest,
} from "../src/core/command-bus.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  getMaterialStudioState,
  getStudioCanonicalAsset,
  initializeMaterialStudio,
} from "../src/core/material-studio.js";
import {
  assertCrossProjectAssetExportManifest,
  importStudioCrossProjectAssetPackage,
} from "../src/core/studio-cross-project-asset-reuse.js";

const roots: string[] = [];

async function makeWritable(root: string): Promise<void> {
  await chmod(root, 0o700).catch(() => undefined);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await makeWritable(target);
    else await chmod(target, 0o600).catch(() => undefined);
  }));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

function envelope(index: number, request: StudioCommandRequest) {
  const suffix = String(index).padStart(4, "0");
  return {
    requestId: `cross-project-reuse-request-${suffix}`,
    idempotencyKey: `cross-project-reuse-key-${suffix}`,
    request,
  };
}

async function run(root: string, index: number, request: StudioCommandRequest) {
  const record = await executeIdempotentCommand(root, envelope(index, request));
  expect(record.status).toBe("succeeded");
  return record.result as Record<string, any>;
}

async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "cross-project-asset-reuse-")));
  roots.push(parent);
  const sourceRoot = (await createManagedProject({ parentRoot: parent, name: "复用源工程" })).paths.root;
  const targetRoot = (await createManagedProject({ parentRoot: parent, name: "复用目标工程" })).paths.root;
  await Promise.all([initializeMaterialStudio(sourceRoot), initializeMaterialStudio(targetRoot)]);
  const sourceImage = path.join(parent, "source-authority.png");
  await sharp({
    create: {
      width: 96,
      height: 128,
      channels: 3,
      background: { r: 33, g: 62, b: 91 },
    },
  }).png().toFile(sourceImage);
  const media = await run(sourceRoot, 1, {
    command: "import_studio_media",
    payload: { sourcePath: sourceImage, kind: "image" },
  });
  const asset = await run(sourceRoot, 2, {
    command: "create_studio_asset",
    payload: {
      id: "character-cross-project-source",
      category: "character",
      name: "跨集阿航",
      aliases: ["阿航"],
      identityFeatures: ["青年脸型"],
      positiveLocks: ["黑色猎装"],
      negativeLocks: ["禁止换脸"],
      defaultPrompt: "电影写实",
      expectedRevision: 0,
    },
  });
  const version = await run(sourceRoot, 3, {
    command: "append_studio_asset_version",
    payload: {
      assetId: asset.id,
      mediaSha256: media.sha256,
      reviewStatus: "pending",
      sourceNote: "跨工程复用测试源",
      expectedRevision: asset.revision,
    },
  });
  const reviewed = await run(sourceRoot, 4, {
    command: "review_studio_asset_version",
    payload: {
      assetId: asset.id,
      versionId: version.version.id,
      decision: "approved",
      expectedRevision: version.assetRevision,
      note: "源工程真实视觉审核通过",
    },
  });
  const primary = await run(sourceRoot, 5, {
    command: "set_studio_primary_authority",
    payload: {
      assetId: asset.id,
      versionId: version.version.id,
      expectedRevision: reviewed.revision,
      note: "源工程主权威",
    },
  });
  return {
    parent,
    sourceRoot,
    targetRoot,
    sourceAssetId: asset.id as string,
    sourceVersionId: version.version.id as string,
    sourceRevision: primary.revision as number,
  };
}

describe("P6.5 cross-project asset reuse", () => {
  it("exports a sealed read-only package and imports only a target pending candidate", async () => {
    const test = await fixture();
    const sourceBefore = await getStudioCanonicalAsset(test.sourceRoot, test.sourceAssetId);
    const sourceCountsBefore = (await getMaterialStudioState(test.sourceRoot)).counts;
    const packageRoot = path.join(test.parent, "asset-reuse-package");

    const exported = await run(test.sourceRoot, 6, {
      command: "export_studio_cross_project_asset_package",
      payload: {
        items: [{ assetId: test.sourceAssetId, expectedRevision: test.sourceRevision }],
        outputPackageRoot: packageRoot,
      },
    });
    expect(exported).toMatchObject({
      itemCount: 1,
      objectCount: 1,
      sealedReadOnly: true,
      manifest: {
        kind: "cross-project-asset-export-manifest",
        items: [{
          assetId: test.sourceAssetId,
          versionId: test.sourceVersionId,
          reviewStatus: "approved",
          isPrimaryAtExport: true,
        }],
      },
    });
    expect(assertCrossProjectAssetExportManifest(exported.manifest).fingerprint)
      .toBe(exported.manifest.fingerprint);
    expect((await getStudioCanonicalAsset(test.sourceRoot, test.sourceAssetId))?.revision)
      .toBe(sourceBefore?.revision);
    expect((await getMaterialStudioState(test.sourceRoot)).counts).toEqual(sourceCountsBefore);
    expect((await chmod(packageRoot, 0o555).then(() => true))).toBe(true);

    const importRequest: StudioCommandRequest = {
      command: "import_studio_cross_project_asset_package",
      payload: {
        packageRoot,
        expectedPackageFingerprint: exported.manifest.fingerprint,
        expectedSourceProjectId: exported.manifest.sourceProjectId,
        sourceAssetId: test.sourceAssetId,
        sourceVersionId: test.sourceVersionId,
        targetExpectedRevision: 0,
      },
    };
    const importedRecord = await executeIdempotentCommand(test.targetRoot, envelope(7, importRequest));
    expect(importedRecord.status).toBe("succeeded");
    const imported = importedRecord.result as Record<string, any>;
    expect(imported).toMatchObject({
      disposition: "imported-pending",
      reviewStatus: "pending",
      reviewRequired: true,
      primaryPromotionRequired: true,
    });
    const target = await getStudioCanonicalAsset(test.targetRoot, imported.targetAssetId);
    expect(target?.primaryAuthority).toBeUndefined();
    expect(target?.versions).toHaveLength(1);
    expect(target?.versions[0]).toMatchObject({
      id: imported.targetVersionId,
      reviewStatus: "pending",
    });
    expect(target?.versions[0]?.sourceNote).toContain(`sourceProjectId=${exported.manifest.sourceProjectId}`);
    expect(target?.versions[0]?.sourceNote).toContain("targetReviewRequired=true");

    await expect(executeIdempotentCommand(test.targetRoot, envelope(8, {
      command: "set_studio_primary_authority",
      payload: {
        assetId: imported.targetAssetId,
        versionId: imported.targetVersionId,
        expectedRevision: imported.targetAssetRevision,
        note: "不得跳过目标 Review",
      },
    }))).rejects.toThrow(/approved|审核/u);

    const targetReviewed = await run(test.targetRoot, 9, {
      command: "review_studio_asset_version",
      payload: {
        assetId: imported.targetAssetId,
        versionId: imported.targetVersionId,
        decision: "approved",
        expectedRevision: imported.targetAssetRevision,
        note: "目标工程独立视觉审核通过",
      },
    });
    const targetPrimary = await run(test.targetRoot, 10, {
      command: "set_studio_primary_authority",
      payload: {
        assetId: imported.targetAssetId,
        versionId: imported.targetVersionId,
        expectedRevision: targetReviewed.revision,
        note: "目标工程独立提升 Primary",
      },
    });
    expect(targetPrimary.primaryAuthority?.versionId).toBe(imported.targetVersionId);

    const replay = await executeIdempotentCommand(test.targetRoot, envelope(7, importRequest));
    expect(replay).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: { targetVersionId: imported.targetVersionId },
    });
  });

  it("fails closed on package fingerprint drift and never creates a target asset", async () => {
    const test = await fixture();
    const packageRoot = path.join(test.parent, "asset-reuse-drift-package");
    const exported = await run(test.sourceRoot, 6, {
      command: "export_studio_cross_project_asset_package",
      payload: {
        items: [{ assetId: test.sourceAssetId, expectedRevision: test.sourceRevision }],
        outputPackageRoot: packageRoot,
      },
    });
    const driftedFingerprint = `${exported.manifest.fingerprint.slice(0, 63)}${
      exported.manifest.fingerprint.endsWith("0") ? "1" : "0"
    }`;
    await expect(importStudioCrossProjectAssetPackage(test.targetRoot, {
      packageRoot,
      expectedPackageFingerprint: driftedFingerprint,
      expectedSourceProjectId: exported.manifest.sourceProjectId,
      sourceAssetId: test.sourceAssetId,
      sourceVersionId: test.sourceVersionId,
      targetExpectedRevision: 0,
    })).rejects.toThrow(/fingerprint.*input-drift/u);
    expect((await getMaterialStudioState(test.targetRoot)).counts.canonicalAssets).toBe(0);
  });
});
