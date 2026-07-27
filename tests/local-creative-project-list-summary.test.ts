import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeLocalCreativeProject } from "../src/core/local-creative-project-materializer.js";
import { createManagedProject } from "../src/core/managed-project.js";
import { listProjects } from "../src/core/service.js";
import { inspectLocalCreativeSourceInventory } from "../src/core/local-creative-source-inventory.js";
import { inspectLocalCreativeProject } from "../src/core/local-creative-project-ingest.js";
import { importLocalCreativeProjectContent } from "../src/core/local-creative-project-content-import.js";
import { registerProject } from "../src/core/sidecar.js";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  importStudioMedia,
} from "../src/core/material-studio.js";

let root = "";
let projectsRoot = "";
let sourceRoot = "";
let priorRegistry: string | undefined;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-local-list-")));
  projectsRoot = path.join(root, "projects");
  sourceRoot = path.join(root, "source");
  await Promise.all([mkdir(projectsRoot), mkdir(sourceRoot)]);
  await writeFile(path.join(sourceRoot, "剧本.md"), "# 第一集\n");
  priorRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
  process.env.AI_CANVAS_REGISTRY_PATH = path.join(root, "registry", "projects.json");
});

afterEach(async () => {
  if (priorRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistry;
  await rm(root, { recursive: true, force: true });
});

describe("项目中心本机创作项目摘要", () => {
  it("Core 收到已取消 signal 时立即终止项目清单读取", async () => {
    const controller = new AbortController();
    controller.abort("测试取消项目清单");
    await expect(listProjects({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
      message: "测试取消项目清单",
    });
  });

  it("只读取小型 ingest manifest 并展示真实扫描/锁图统计", async () => {
    const initialPreviewFingerprint = `local-creative-${"1".repeat(64)}`;
    const imported = await materializeLocalCreativeProject({
      projectsRoot,
      project: {
        key: "summary-story",
        name: "摘要剧情项目",
        projectType: "story-production",
        resolution: "CREATE_MANAGED",
        sources: [{ root: sourceRoot, role: "PRIMARY_AUTHORITY" }],
        scanSummary: {
          previewFingerprint: initialPreviewFingerprint,
          statistics: { totalFiles: 123, totalBytes: 456_789 },
          lockEvidence: { approved: 7, candidate: 9, references: 11, locksWithReferences: 5 },
          warnings: { total: 3, byCode: { STALE_LEDGER: 3 } },
        },
      },
    });
    const ordinary = await createManagedProject({
      parentRoot: projectsRoot,
      name: "普通项目",
      slug: "ordinary-project",
    });
    await registerProject(ordinary.project);

    const projects = await listProjects();
    expect(projects.find((project) => project.primaryRoot === imported.projectRoot)).toMatchObject({
      available: true,
      localCreativeImport: {
        projectKey: "summary-story",
        projectType: "story-production",
        resolution: "CREATE_MANAGED",
        sourceLayerCount: 1,
        authorityPolicy: "EVIDENCE_REQUIRED",
        indexedFiles: 123,
        indexedBytes: 456_789,
        approvedLocks: 7,
        candidateLocks: 9,
        warningCount: 3,
        contentImport: {
          status: "not-imported",
          processedMedia: 0,
          eligibleMedia: 0,
          importedDocuments: 0,
          sourceDocuments: 0,
          selectedDocuments: 0,
          excludedDocuments: 0,
          documentLimitHit: false,
          pendingAssets: 0,
          sourceSnapshot: "not-imported",
          sourceCheckedAt: null,
        },
      },
    });
    expect(projects.find((project) => project.primaryRoot === ordinary.paths.root)?.localCreativeImport).toBeUndefined();
  });

  it.each([
    ["in-progress", "importing"],
    ["completed", "unverified"],
    ["completed-with-failures", "has-failures"],
  ] as const)("将内容进度 %s 投影为项目中心状态 %s，并区分初次盘点与内容快照", async (progressStatus, expectedStatus) => {
    const initialPreviewFingerprint = `local-creative-${"2".repeat(64)}`;
    const imported = await materializeLocalCreativeProject({
      projectsRoot,
      project: {
        key: `content-${expectedStatus}`,
        name: `内容导入 ${expectedStatus}`,
        projectType: "story-production",
        resolution: "CREATE_MANAGED",
        sources: [{ root: sourceRoot, role: "PRIMARY_AUTHORITY" }],
        scanSummary: {
          previewFingerprint: initialPreviewFingerprint,
          statistics: { totalFiles: 8, totalBytes: 9_999 },
          lockEvidence: { approved: 1, candidate: 2, references: 3, locksWithReferences: 1 },
          warnings: { total: 0, byCode: {} },
        },
      },
    });
    const sourceInventory = await inspectLocalCreativeSourceInventory(
      [{ role: "PRIMARY_AUTHORITY", rootPath: sourceRoot }],
      { cache: false },
    );
    await writeFile(
      path.join(imported.projectRoot, ".aicanvas", "local-creative-project-content-import.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "local-creative-project-content-import-progress",
        previewFingerprint: `local-creative-${"3".repeat(64)}`,
        status: progressStatus,
        sourceInventory,
        documents: {
          coverage: {
            sourceDocuments: 1,
            selectedDocuments: 1,
            importEligibleDocuments: 1,
            inventoryOnlyDocuments: 0,
            excludedUnsupportedFormat: 0,
            excludedRejected: 0,
            unselectedByLimit: 0,
            limitHit: false,
          },
          results: [{ status: "imported" }],
        },
        mediaByFileId: { mediaA: {}, mediaB: {} },
        canonicalDecisionsByFileId: {
          mediaA: { decision: "pending-version-created", assetId: "asset-1" },
          mediaB: { decision: "pending-version-reconciled", assetId: "asset-1" },
          mediaC: { decision: "forbidden-by-policy" },
        },
        runSummary: { mediaEligible: 5 },
      })}\n`,
    );

    const cachedSummary = (await listProjects())
      .find((project) => project.primaryRoot === imported.projectRoot)?.localCreativeImport?.contentImport;
    expect(cachedSummary).toMatchObject({
      status: progressStatus === "in-progress" ? "importing" : progressStatus === "completed" ? "unverified" : "has-failures",
      sourceSnapshot: "unknown",
      sourceCheckedAt: null,
    });

    const summary = (await listProjects({ refreshSources: true, sourceProjectRoot: imported.projectRoot }))
      .find((project) => project.primaryRoot === imported.projectRoot)?.localCreativeImport?.contentImport;
    expect(summary).toMatchObject({
      status: expectedStatus,
      processedMedia: 2,
      eligibleMedia: 5,
      importedDocuments: 1,
      sourceDocuments: 1,
      selectedDocuments: 1,
      excludedDocuments: 0,
      documentLimitHit: false,
      pendingAssets: 1,
      sourceSnapshot: "current",
      sourceCheckedAt: expect.any(String),
    });
  });

  it("compact summary 存在时不读取 12MB 旧 progress，并直接投影小侧车计数", async () => {
    const initialPreviewFingerprint = `local-creative-${"4".repeat(64)}`;
    const imported = await materializeLocalCreativeProject({
      projectsRoot,
      project: {
        key: "compact-content",
        name: "紧凑内容摘要",
        projectType: "story-production",
        resolution: "CREATE_MANAGED",
        sources: [{ root: sourceRoot, role: "PRIMARY_AUTHORITY" }],
        scanSummary: {
          previewFingerprint: initialPreviewFingerprint,
          statistics: { totalFiles: 20_000, totalBytes: 22_000_000_000 },
          lockEvidence: { approved: 3, candidate: 4, references: 5, locksWithReferences: 2 },
          warnings: { total: 0, byCode: {} },
        },
      },
    });
    const progressPath = path.join(imported.projectRoot, ".aicanvas", "local-creative-project-content-import.json");
    await writeFile(progressPath, Buffer.concat([Buffer.from("{"), Buffer.alloc(12 * 1024 * 1024, 0x20)]));
    expect((await lstat(progressPath)).size).toBeGreaterThanOrEqual(12 * 1024 * 1024);
    const sourceInventory = await inspectLocalCreativeSourceInventory(
      [{ role: "PRIMARY_AUTHORITY", rootPath: sourceRoot }],
      { cache: false },
    );
    await writeFile(
      path.join(imported.projectRoot, ".aicanvas", "local-creative-project-content-summary.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "local-creative-project-content-import-summary",
        projectRoot: imported.projectRoot,
        sourceProject: { key: "compact-content", name: "紧凑内容摘要", type: "story-production" },
        authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
        previewFingerprint: `local-creative-${"5".repeat(64)}`,
        previewFingerprints: [initialPreviewFingerprint, `local-creative-${"5".repeat(64)}`],
        status: "completed",
        sourceInventory,
        documentCoverage: {
          sourceDocuments: 1,
          selectedDocuments: 1,
          importEligibleDocuments: 1,
          inventoryOnlyDocuments: 0,
          excludedUnsupportedFormat: 0,
          excludedRejected: 0,
          unselectedByLimit: 0,
          limitHit: false,
        },
        runSummary: { mediaEligible: 10, documentsSelected: 1 },
        processedCounts: { media: 7, eligibleMedia: 10, documents: 1, pendingAssets: 2 },
        decisionCounts: { "pending-version-created": 2 },
        failureCounts: { total: 0, document: 0, media: 0, canonicalAsset: 0 },
        updatedAt: new Date().toISOString(),
      })}\n`,
    );

    const cachedSummary = (await listProjects())
      .find((project) => project.primaryRoot === imported.projectRoot)?.localCreativeImport?.contentImport;
    expect(cachedSummary).toMatchObject({
      status: "unverified",
      sourceSnapshot: "unknown",
      sourceCheckedAt: null,
    });

    const refreshed = (await listProjects({ refreshSources: true, sourceProjectRoot: imported.projectRoot }))
      .find((project) => project.primaryRoot === imported.projectRoot)?.localCreativeImport;
    expect(refreshed).toMatchObject({
      indexedFiles: 1,
      indexedBytes: expect.any(Number),
      contentImport: {
        status: "unverified",
        processedMedia: 7,
        eligibleMedia: 10,
        importedDocuments: 1,
        sourceDocuments: 1,
        selectedDocuments: 1,
        excludedDocuments: 0,
        documentLimitHit: false,
        pendingAssets: 2,
        sourceSnapshot: "current",
        sourceCheckedAt: expect.any(String),
        verifiedSourceFiles: 1,
      },
    });
  });

  it("项目中心 pending 数量以素材库事务事实覆盖旧导入摘要", async () => {
    const imported = await materializeLocalCreativeProject({
      projectsRoot,
      project: {
        key: "live-pending-count",
        name: "实时 pending 计数",
        projectType: "story-production",
        resolution: "CREATE_MANAGED",
        sources: [{ root: sourceRoot, role: "PRIMARY_AUTHORITY" }],
        scanSummary: {
          previewFingerprint: `local-creative-${"6".repeat(64)}`,
          statistics: { totalFiles: 1, totalBytes: 10 },
          lockEvidence: { approved: 0, candidate: 0, references: 0, locksWithReferences: 0 },
          warnings: { total: 0, byCode: {} },
        },
      },
    });
    await writeFile(
      path.join(imported.projectRoot, ".aicanvas", "local-creative-project-content-summary.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "local-creative-project-content-import-summary",
        projectRoot: imported.projectRoot,
        sourceProject: { key: "live-pending-count", name: "实时 pending 计数", type: "story-production" },
        authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
        previewFingerprint: `local-creative-${"7".repeat(64)}`,
        previewFingerprints: [`local-creative-${"6".repeat(64)}`, `local-creative-${"7".repeat(64)}`],
        status: "completed",
        sourceInventory: await inspectLocalCreativeSourceInventory(
          [{ role: "PRIMARY_AUTHORITY", rootPath: sourceRoot }],
          { cache: false },
        ),
        documentCoverage: {
          sourceDocuments: 1,
          selectedDocuments: 1,
          importEligibleDocuments: 1,
          inventoryOnlyDocuments: 0,
          excludedUnsupportedFormat: 0,
          excludedRejected: 0,
          unselectedByLimit: 0,
          limitHit: false,
        },
        runSummary: { mediaEligible: 0, documentsSelected: 1 },
        processedCounts: { media: 0, eligibleMedia: 0, documents: 1, pendingAssets: 99 },
        decisionCounts: {},
        failureCounts: { total: 0, document: 0, media: 0, canonicalAsset: 0 },
        updatedAt: new Date().toISOString(),
      })}\n`,
    );

    const imagePath = path.join(root, "pending-reference.png");
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "#315a68" } })
      .png()
      .toFile(imagePath);
    const media = await importStudioMedia(imported.projectRoot, { sourcePath: imagePath });
    const asset = await createStudioCanonicalAsset(imported.projectRoot, {
      id: "character-live-pending",
      expectedRevision: 0,
      category: "character",
      name: "实时 pending 角色",
    });
    await appendStudioAssetVersion(imported.projectRoot, {
      assetId: asset.id,
      mediaSha256: media.sha256,
      reviewStatus: "pending",
      expectedRevision: asset.revision,
      sourceNote: "测试实时 pending 事务投影",
    });

    const summary = (await listProjects())
      .find((project) => project.primaryRoot === imported.projectRoot)?.localCreativeImport;
    expect(summary).toMatchObject({
      contentImport: { pendingAssets: 1 },
    });
  });

  it("只有真实不可变完成收据有效时才显示 current-complete", async () => {
    const preview = await inspectLocalCreativeProject({
      projectKey: "verified-summary",
      projectName: "已验证摘要",
      projectType: "story-production",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: sourceRoot }],
      computeSha256: true,
    });
    const imported = await materializeLocalCreativeProject({
      projectsRoot,
      project: {
        key: "verified-summary",
        name: "已验证摘要",
        projectType: "story-production",
        resolution: "CREATE_MANAGED",
        sources: [{ root: sourceRoot, role: "PRIMARY_AUTHORITY" }],
        scanSummary: {
          previewFingerprint: preview.previewFingerprint,
          statistics: {
            totalFiles: preview.statistics.totalFiles,
            totalBytes: preview.statistics.totalBytes,
          },
          lockEvidence: { approved: 0, candidate: 0, references: 0, locksWithReferences: 0 },
          warnings: { total: 0, byCode: {} },
        },
      },
    });
    const completed = await importLocalCreativeProjectContent({
      projectRoot: imported.projectRoot,
      preview,
      authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
      documentLimit: 500,
      checkpointEvery: 10,
    });
    expect(completed.status).toBe("completed");
    expect(completed.completionBaselineFingerprint).toMatch(/^[a-f0-9]{64}$/u);

    const summary = (await listProjects({
      refreshSources: true,
      sourceProjectRoot: imported.projectRoot,
    })).find((project) => project.primaryRoot === imported.projectRoot)
      ?.localCreativeImport?.contentImport;
    expect(summary).toMatchObject({
      status: "current-complete",
      sourceSnapshot: "current",
      sourceDocuments: 1,
      selectedDocuments: 1,
      excludedDocuments: 0,
      pendingAssets: 0,
    });

    await writeFile(
      path.join(
        imported.projectRoot,
        ".aicanvas",
        "local-creative-content-import-completion-baselines",
        `${completed.completionBaselineFingerprint}.json`,
      ),
      "{}\n",
    );
    const afterTamper = (await listProjects({
      refreshSources: true,
      sourceProjectRoot: imported.projectRoot,
    })).find((project) => project.primaryRoot === imported.projectRoot)
      ?.localCreativeImport?.contentImport;
    expect(afterTamper).toMatchObject({
      status: "unverified",
      sourceSnapshot: "current",
    });
  });
});
