import path from "node:path";
import process from "node:process";
import {
  stageLocalCreativeApprovedReferenceManifest,
} from "../src/core/local-creative-approved-reference-manifest.js";

const requestedProjectRoot = process.argv[2]?.trim();
if (!requestedProjectRoot) {
  throw new Error("用法：tsx scripts/stage-local-creative-approved-references.ts <managed-project-root>");
}

const result = await stageLocalCreativeApprovedReferenceManifest(path.resolve(requestedProjectRoot));
const summary = {
  kind: result.kind,
  projectRoot: result.projectRoot,
  manifestProject: result.manifestProject,
  manifestSha256: result.manifestSha256,
  sourceFingerprint: result.sourceFingerprint,
  candidateCount: result.candidateCount,
  mediaCount: result.mediaCount,
  canonicalAssetCount: result.canonicalAssetCount,
  pendingVersionCount: result.pendingVersionCount,
  blockedVfxCount: result.blockedVfxCount,
  reviewedExistingCount: result.reviewedExistingCount,
  primaryAuthorityChanges: result.primaryAuthorityChanges,
  assets: result.assets.map((asset) => ({
    id: asset.id,
    mediaSha256: asset.mediaSha256,
    mediaStatus: asset.mediaStatus,
    category: asset.category,
    categoryStatus: asset.categoryStatus,
    canonicalAssetId: asset.canonicalAssetId,
    reviewStatus: asset.reviewStatus,
  })),
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
