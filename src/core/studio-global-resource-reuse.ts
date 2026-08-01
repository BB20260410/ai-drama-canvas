/**
 * 总资源调用到当前项目。
 *
 * 来源工程始终只读：身份来自全局 registry 的 id+root 精确匹配，资产通过既有
 * 不可变复用包 owner 搬运，普通图片与音视频通过来源 CAS 的 SHA/size 现场验证后复制。
 * 所有业务写入只发生在目标工程，并由 command-bus 的 studio-mutation fence 包裹。
 */
import { chmod, lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  importStudioGlobalResourceMedia,
  type StudioGlobalResourceReuseProvenance,
} from "./material-studio.js";
import { inspectManagedProjectReadOnly, type ProjectShell } from "./managed-project.js";
import { listRegisteredProjects } from "./sidecar.js";
import {
  exportStudioCrossProjectAssetPackage,
  importStudioCrossProjectAssetPackage,
} from "./studio-cross-project-asset-reuse.js";
import { resolveStudioMediaRequest } from "./studio-media-protocol.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export type ReuseStudioGlobalResourceInput =
  | {
      resourceKind: "asset";
      sourceProjectRoot: string;
      expectedSourceProjectId: string;
      sourceAssetId: string;
      sourceVersionId: string;
      expectedSourceAssetRevision: number;
      targetExpectedRevision: 0;
    }
  | {
      resourceKind: "image" | "audio" | "video";
      sourceProjectRoot: string;
      expectedSourceProjectId: string;
      sourceMediaSha256: string;
      expectedSourceMediaSizeBytes: number;
      targetExpectedRevision: 0;
    };

export type ReuseStudioGlobalResourceResult =
  | {
      schemaVersion: 1;
      kind: "studio-global-resource-reuse-result";
      resourceKind: "asset";
      disposition: "imported-pending" | "already-imported";
      sourceProjectId: string;
      sourceAssetId: string;
      sourceVersionId: string;
      targetAssetId: string;
      targetAssetRevision: number;
      targetVersionId: string;
      mediaSha256: string;
      reviewStatus: "pending" | "approved" | "rejected";
      reviewRequired: true;
      primaryPromotionRequired: true;
    }
  | {
      schemaVersion: 1;
      kind: "studio-global-resource-reuse-result";
      resourceKind: "image" | "audio" | "video";
      disposition: "imported" | "already-present";
      sourceProjectId: string;
      sourceMediaSha256: string;
      targetMediaSha256: string;
      sizeBytes: number;
      mimeType: string;
      sourceBasename: string;
      provenanceId: string;
    };

export interface ReuseStudioGlobalResourceOptions {
  commandRequestHash: string;
}

interface SourceMediaRow {
  sha256: string;
  kind: "image" | "audio" | "video";
  size_bytes: number | bigint;
  mime_type: string;
  source_basename: string;
  object_relpath: string;
}

function requireStableId(value: string, field: string): string {
  if (!STABLE_ID_PATTERN.test(value)) throw new Error(`${field} 格式无效。`);
  return value;
}

function requireSha256(value: string, field: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${field} 必须是小写 SHA-256。`);
  return value;
}

function assertTargetExpectedRevision(value: number): asserts value is 0 {
  if (value !== 0) throw new Error("总资源调用 targetExpectedRevision 必须为 0。");
}

async function inspectRegisteredSource(
  sourceProjectRoot: string,
  expectedSourceProjectId: string,
): Promise<ProjectShell> {
  if (!path.isAbsolute(sourceProjectRoot)) throw new Error("sourceProjectRoot 必须是绝对路径。");
  const expectedId = requireStableId(expectedSourceProjectId, "expectedSourceProjectId");
  const resolvedRoot = path.resolve(sourceProjectRoot);
  const registry = await listRegisteredProjects();
  const matches = registry.filter((entry) =>
    entry.id === expectedId && path.resolve(entry.primaryRoot) === resolvedRoot
  );
  if (matches.length !== 1) {
    throw new Error("总资源来源必须在 registry 中以 projectId + projectRoot 精确唯一匹配。");
  }
  const shell = await inspectManagedProjectReadOnly(resolvedRoot);
  if (shell.project.id !== expectedId || shell.paths.root !== resolvedRoot) {
    throw new Error("总资源来源 registry 身份与受管工程 manifest 不一致。");
  }
  return shell;
}

async function makeTemporaryTreeWritable(root: string): Promise<void> {
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink()) throw new Error("总资源临时复用包禁止符号链接。");
  if (!metadata.isDirectory()) {
    await chmod(root, 0o600);
    return;
  }
  await chmod(root, 0o700);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    await makeTemporaryTreeWritable(path.join(root, entry.name));
  }
}

async function reuseAsset(
  targetProjectRoot: string,
  source: ProjectShell,
  input: Extract<ReuseStudioGlobalResourceInput, { resourceKind: "asset" }>,
): Promise<Extract<ReuseStudioGlobalResourceResult, { resourceKind: "asset" }>> {
  requireStableId(input.sourceAssetId, "sourceAssetId");
  requireStableId(input.sourceVersionId, "sourceVersionId");
  if (!Number.isSafeInteger(input.expectedSourceAssetRevision)
    || input.expectedSourceAssetRevision < 1) {
    throw new Error("expectedSourceAssetRevision 必须是正安全整数。");
  }
  const temporaryRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ai-canvas-global-resource-reuse-")),
  );
  const packageRoot = path.join(temporaryRoot, "package");
  try {
    // 直接调用 Core owner；来源不走 command-bus，因此不会产生来源命令账本写入。
    const exported = await exportStudioCrossProjectAssetPackage(source.paths.root, {
      items: [{
        assetId: input.sourceAssetId,
        expectedRevision: input.expectedSourceAssetRevision,
      }],
      outputPackageRoot: packageRoot,
    });
    const item = exported.manifest.items[0];
    if (!item
      || exported.manifest.items.length !== 1
      || exported.manifest.sourceProjectId !== input.expectedSourceProjectId
      || item.assetId !== input.sourceAssetId
      || item.versionId !== input.sourceVersionId
      || item.sourceAssetRevision !== input.expectedSourceAssetRevision
      || item.reviewStatus !== "approved"
      || item.isPrimaryAtExport !== true) {
      throw new Error("请求的资产版本不是来源工程当前 approved Primary，拒绝总资源调用。");
    }
    const imported = await importStudioCrossProjectAssetPackage(targetProjectRoot, {
      packageRoot,
      expectedPackageFingerprint: exported.manifest.fingerprint,
      expectedSourceProjectId: input.expectedSourceProjectId,
      sourceAssetId: input.sourceAssetId,
      sourceVersionId: input.sourceVersionId,
      targetExpectedRevision: input.targetExpectedRevision,
    });
    return {
      schemaVersion: 1,
      kind: "studio-global-resource-reuse-result",
      resourceKind: "asset",
      disposition: imported.disposition,
      sourceProjectId: imported.sourceProjectId,
      sourceAssetId: imported.sourceAssetId,
      sourceVersionId: imported.sourceVersionId,
      targetAssetId: imported.targetAssetId,
      targetAssetRevision: imported.targetAssetRevision,
      targetVersionId: imported.targetVersionId,
      mediaSha256: imported.mediaSha256,
      reviewStatus: imported.reviewStatus,
      reviewRequired: true,
      primaryPromotionRequired: true,
    };
  } finally {
    await makeTemporaryTreeWritable(temporaryRoot).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readSourceMedia(
  source: ProjectShell,
  input: Extract<ReuseStudioGlobalResourceInput, {
    resourceKind: "image" | "audio" | "video";
  }>,
): Promise<{
  objectPath: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  sourceBasename: string;
}> {
  const mediaSha256 = requireSha256(input.sourceMediaSha256, "sourceMediaSha256");
  if (!Number.isSafeInteger(input.expectedSourceMediaSizeBytes)
    || input.expectedSourceMediaSizeBytes < 1) {
    throw new Error("expectedSourceMediaSizeBytes 必须是正安全整数。");
  }
  const db = new DatabaseSync(source.paths.materialDatabase, { readOnly: true });
  let row: SourceMediaRow | undefined;
  try {
    db.exec("PRAGMA query_only = ON");
    row = db.prepare(`
      SELECT sha256, kind, size_bytes, mime_type, source_basename, object_relpath
      FROM studio_media
      WHERE sha256 = ?
    `).get(mediaSha256) as unknown as SourceMediaRow | undefined;
  } finally {
    db.close();
  }
  if (!row) throw new Error(`总资源来源媒体不存在：${mediaSha256}`);
  const sizeBytes = Number(row.size_bytes);
  if (row.kind !== input.resourceKind
    || sizeBytes !== input.expectedSourceMediaSizeBytes
    || !Number.isSafeInteger(sizeBytes)
    || sizeBytes < 1) {
    throw new Error("总资源来源媒体 kind/size 与调用预期不一致。");
  }
  const expectedObjectPath = path.join(
    source.paths.mediaCas,
    mediaSha256.slice(0, 2),
    mediaSha256,
  );
  const objectPath = path.resolve(source.paths.root, row.object_relpath);
  if (objectPath !== expectedObjectPath) {
    throw new Error("总资源来源媒体记录未指向受管 SHA-256 CAS。");
  }
  const [metadata, canonicalObjectPath] = await Promise.all([
    lstat(objectPath, { bigint: true }),
    realpath(objectPath),
  ]);
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1n
    || metadata.size !== BigInt(sizeBytes)
    || canonicalObjectPath !== objectPath) {
    throw new Error("总资源来源媒体 CAS 身份无效。");
  }
  // 协议 owner 会依据来源只读 DB 再做完整 SHA/size/路径验证；不会产生来源写入。
  await resolveStudioMediaRequest(source.paths.root, { mediaSha256 });
  return {
    objectPath,
    sha256: mediaSha256,
    sizeBytes,
    mimeType: row.mime_type,
    sourceBasename: row.source_basename,
  };
}

async function reuseMedia(
  targetProjectRoot: string,
  source: ProjectShell,
  input: Extract<ReuseStudioGlobalResourceInput, {
    resourceKind: "image" | "audio" | "video";
  }>,
  options: ReuseStudioGlobalResourceOptions,
): Promise<Extract<ReuseStudioGlobalResourceResult, {
  resourceKind: "image" | "audio" | "video";
}>> {
  const media = await readSourceMedia(source, input);
  const imported = await importStudioGlobalResourceMedia(targetProjectRoot, {
    sourceObjectPath: media.objectPath,
    kind: input.resourceKind,
    mimeType: media.mimeType,
    sourceBasename: media.sourceBasename,
    expectedSha256: media.sha256,
    expectedSizeBytes: media.sizeBytes,
    provenance: {
      sourceProjectId: source.project.id,
      sourceProjectName: source.project.name,
      sourceManifestFingerprint: source.manifestFingerprint,
      commandRequestHash: requireSha256(options.commandRequestHash, "commandRequestHash"),
    },
  });
  const provenance: StudioGlobalResourceReuseProvenance = imported.provenance;
  return {
    schemaVersion: 1,
    kind: "studio-global-resource-reuse-result",
    resourceKind: input.resourceKind,
    disposition: imported.disposition,
    sourceProjectId: provenance.sourceProjectId,
    sourceMediaSha256: provenance.sourceMediaSha256,
    targetMediaSha256: imported.media.sha256,
    sizeBytes: imported.media.sizeBytes,
    mimeType: imported.media.mimeType,
    sourceBasename: provenance.sourceBasename,
    provenanceId: provenance.id,
  };
}

export async function reuseStudioGlobalResource(
  targetProjectRoot: string,
  input: ReuseStudioGlobalResourceInput,
  options: ReuseStudioGlobalResourceOptions,
): Promise<ReuseStudioGlobalResourceResult> {
  assertTargetExpectedRevision(input.targetExpectedRevision);
  const [target, source] = await Promise.all([
    inspectManagedProjectReadOnly(targetProjectRoot),
    inspectRegisteredSource(input.sourceProjectRoot, input.expectedSourceProjectId),
  ]);
  if (target.paths.root === source.paths.root || target.project.id === source.project.id) {
    throw new Error("总资源调用拒绝把来源工程导回同一 projectId；当前工程内请直接使用。");
  }
  if (input.resourceKind === "asset") {
    return reuseAsset(target.paths.root, source, input);
  }
  if (
    input.resourceKind === "image"
    || input.resourceKind === "audio"
    || input.resourceKind === "video"
  ) {
    return reuseMedia(target.paths.root, source, input, options);
  }
  throw new Error("resourceKind 无效。");
}
