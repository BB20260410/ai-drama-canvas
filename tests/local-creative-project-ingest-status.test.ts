import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { importLocalCreativeProjectContent } from "../src/core/local-creative-project-content-import.js";
import {
  getLocalCreativeProjectIngestStatus,
  localCreativeSourceRaceDetected,
  type LocalCreativeProjectIngestStatusProjection,
} from "../src/core/local-creative-project-ingest-status.js";
import { inspectLocalCreativeProject } from "../src/core/local-creative-project-ingest.js";
import { localCreativeSourceInventoryFromPreview } from "../src/core/local-creative-source-inventory.js";
import { materializeLocalCreativeProject } from "../src/core/local-creative-project-materializer.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  projectsRoot: string;
  sourceRoot: string;
  projectRoot: string;
  preview: Awaited<ReturnType<typeof inspectLocalCreativeProject>>;
}> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "local-ingest-status-")));
  temporaryRoots.push(root);
  const projectsRoot = path.join(root, "projects");
  const sourceRoot = path.join(root, "source");
  await Promise.all([
    mkdir(projectsRoot),
    mkdir(path.join(sourceRoot, "角色"), { recursive: true }),
  ]);
  await sharp({
    create: { width: 32, height: 24, channels: 3, background: "#5f6f61" },
  }).png().toFile(path.join(sourceRoot, "角色", "char-hero.png"));
  await writeFile(
    path.join(sourceRoot, "权威资产.md"),
    "参考资产：角色/char-hero.png\n状态: APPROVED_LOCK\n唯一权威角色锁\nReview / QC: PASS\n",
  );
  const preview = await inspectLocalCreativeProject({
    projectKey: "local-status-story",
    projectName: "本机导入状态测试",
    projectType: "story-production",
    sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: sourceRoot }],
    computeSha256: true,
  });
  const warningsByCode = Object.fromEntries(
    [...new Set(preview.warnings.map((warning) => warning.code))]
      .map((code) => [code, preview.warnings.filter((warning) => warning.code === code).length]),
  );
  const materialized = await materializeLocalCreativeProject({
    projectsRoot,
    project: {
      key: preview.project.key,
      name: preview.project.name,
      projectType: preview.project.type,
      resolution: "CREATE_MANAGED",
      sources: [{ root: sourceRoot, role: "PRIMARY_AUTHORITY" }],
      authorityPolicy: "EVIDENCE_REQUIRED",
      scanSummary: {
        previewFingerprint: preview.previewFingerprint,
        statistics: { ...preview.statistics },
        lockEvidence: {
          approved: preview.lockCandidates.filter((candidate) => candidate.status === "APPROVED_LOCK").length,
          candidate: preview.lockCandidates.filter((candidate) => candidate.status === "CANDIDATE_LOCK").length,
          references: preview.references.length,
          locksWithReferences: preview.lockReferenceIndex.filter((entry) => entry.referencedBy.length > 0).length,
        },
        warnings: { total: preview.warnings.length, byCode: warningsByCode },
      },
    },
  });
  return {
    root,
    projectsRoot,
    sourceRoot,
    projectRoot: materialized.projectRoot,
    preview,
  };
}

function expectBoundedSafeProjection(projection: LocalCreativeProjectIngestStatusProjection): void {
  const serialized = JSON.stringify(projection);
  expect(serialized).not.toContain("mediaByFileId");
  expect(serialized).not.toMatch(/"(?:objectPath|databasePath|bodyPath|contentRelpath|casPath|mediaBytes)"\s*:/u);
  expect(serialized).not.toMatch(/[\\/]\.aicanvas[\\/](?:objects|studio-production[\\/]objects)[\\/]/u);
  expect(serialized).not.toMatch(/data:[^;,]+;base64,/iu);
}

describe("本机创作项目导入状态投影", () => {
  it("双重来源扫描只要 fingerprint 不一致就显式判定竞态", () => {
    const stable = "a".repeat(64);
    expect(localCreativeSourceRaceDetected(
      { fingerprint: stable },
      { fingerprint: stable },
    )).toBe(false);
    expect(localCreativeSourceRaceDetected(
      { fingerprint: stable },
      { fingerprint: "b".repeat(64) },
    )).toBe(true);
  });

  it("只读对账初扫、内容导入、受管计数和锁引用，且不继承 authority 或确认视觉出现", async () => {
    const { projectRoot, preview, sourceRoot } = await fixture();
    const imported = await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
    });
    expect(imported.runSummary).toMatchObject({
      documentsImported: 0,
      mediaImported: 1,
      pendingAssetsCreated: 1,
      authorityPromotions: 0,
    });

    const projection = await getLocalCreativeProjectIngestStatus(projectRoot);
    expect(projection).toMatchObject({
      schemaVersion: 1,
      kind: "local-creative-project-ingest-status",
      project: {
        key: "local-status-story",
        type: "story-production",
        resolution: "CREATE_MANAGED",
      },
      sourceLayers: [{ order: 0, role: "PRIMARY_AUTHORITY", root: sourceRoot }],
      scan: {
        status: "scanned",
        previewFingerprint: preview.previewFingerprint,
        byMediaKind: { document: 1, image: 1, video: 0, audio: 0 },
        byStatus: { approved: 1 },
      },
      contentImport: {
        status: "completed",
        truthStatus: "PARTIAL_BY_POLICY",
        appliedAuthorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
        previewFingerprint: preview.previewFingerprint,
        sourceSnapshot: "current",
        completionBaseline: { status: "valid" },
        processedMediaRecords: 1,
        runSummary: {
          documentsImported: 0,
          mediaImported: 1,
          pendingAssetsCreated: 1,
          authorityPromotions: 0,
        },
        failures: { total: 0 },
      },
      managedCounts: {
        media: { unique: 1, origins: 1, image: 1, video: 0, audio: 0 },
        documents: { total: 0, script: 0, prompt: 0 },
        assets: {
          canonical: 1,
          versions: 1,
          pendingVersions: 1,
          approvedVersions: 0,
          primaryAuthorities: 0,
        },
        production: { units: 0, panels: 0, timelineBindings: 0 },
      },
      visualAppearance: "UNCONFIRMED",
      authority: {
        sourcePolicy: "EVIDENCE_REQUIRED",
        authorityInherited: false,
        sourceDeclarationsPromotedAutomatically: false,
        recordedImportPromotions: 0,
        managedPrimaryAuthorities: 0,
      },
      nextAction: { code: "review-document-coverage" },
    });
    expect(projection.lockReferenceIndex).toMatchObject({
      available: true,
      total: 2,
    });
    expect(projection.lockReferenceIndex.items).toEqual(expect.arrayContaining([expect.objectContaining({
        status: "APPROVED_LOCK",
        visualAppearance: "UNCONFIRMED",
      })]));
    expect(projection.canonicalDecisions).toMatchObject({
      available: true,
      total: 1,
      counts: { "pending-version-created": 1 },
      items: [{
        decision: "pending-version-created",
        category: "character",
        authorityPromoted: false,
        visualAppearance: "UNCONFIRMED",
      }],
    });
    expect(projection.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expectBoundedSafeProjection(projection);
  });

  it("无内容进度时明确返回 not-started；有界分页不返回全量引用或决策", async () => {
    const { projectRoot, preview } = await fixture();
    const initial = await getLocalCreativeProjectIngestStatus(projectRoot, { limit: 1 });
    expect(initial).toMatchObject({
      contentImport: { status: "not-started", appliedAuthorityPolicy: null, sourceSnapshot: "not-imported" },
      lockReferenceIndex: { available: false, total: 0, items: [] },
      canonicalDecisions: { available: false, total: 0, items: [] },
      nextAction: { code: "run-content-import" },
    });

    await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
    });
    const progressPath = path.join(projectRoot, ".aicanvas", "local-creative-project-content-import.json");
    const progress = JSON.parse(await readFile(progressPath, "utf8")) as Record<string, any>;
    const firstLock = progress.lockReferenceIndex[0];
    const firstDecision = Object.values(progress.canonicalDecisionsByFileId)[0] as Record<string, unknown>;
    progress.lockReferenceIndex.push({
      ...firstLock,
      lockFileId: "lock-second",
      lockPath: path.join(path.dirname(firstLock.lockPath), "scene-second.png"),
      status: "CANDIDATE_LOCK",
    });
    progress.canonicalDecisionsByFileId["lock-second"] = {
      ...firstDecision,
      fileId: "lock-second",
      sourcePath: path.join(path.dirname(String(firstDecision.sourcePath)), "scene-second.png"),
      decision: "category-unresolved",
      assetId: undefined,
      category: undefined,
      versionId: undefined,
      mediaSha256: undefined,
      authorityPromoted: false,
    };
    await writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`);

    const firstPage = await getLocalCreativeProjectIngestStatus(projectRoot, { limit: 1 });
    expect(firstPage.page).toMatchObject({ offset: 0, limit: 1, hasMore: true });
    expect(firstPage.lockReferenceIndex.items).toHaveLength(1);
    expect(firstPage.canonicalDecisions.items).toHaveLength(1);
    const secondPage = await getLocalCreativeProjectIngestStatus(projectRoot, {
      cursor: firstPage.page.nextCursor,
      limit: 1,
    });
    expect(secondPage.page).toMatchObject({ offset: 1, limit: 1, hasMore: true });
    expect(secondPage.lockReferenceIndex.items).toHaveLength(1);
    expect(secondPage.canonicalDecisions.items).toHaveLength(1);
    expect(secondPage.canonicalDecisions.counts["category-unresolved"]).toBe(1);
    const thirdPage = await getLocalCreativeProjectIngestStatus(projectRoot, {
      cursor: secondPage.page.nextCursor,
      limit: 1,
    });
    expect(thirdPage.page).toMatchObject({ offset: 2, limit: 1, hasMore: false });
    expect(thirdPage.lockReferenceIndex.items).toHaveLength(1);
    expect(thirdPage.canonicalDecisions.items).toHaveLength(0);
    expectBoundedSafeProjection(secondPage);
  });

  it("来源扩展并重新导入后，current 状态使用最新内容导入基线而非首次物化扫描", async () => {
    const { projectRoot, preview, sourceRoot } = await fixture();
    await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
    });
    await sharp({
      create: { width: 40, height: 30, channels: 3, background: "#324f68" },
    }).png().toFile(path.join(sourceRoot, "角色", "char-friend.png"));
    const expanded = await inspectLocalCreativeProject({
      projectKey: preview.project.key,
      projectName: preview.project.name,
      projectType: preview.project.type,
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: sourceRoot }],
      computeSha256: true,
    });
    await importLocalCreativeProjectContent({
      projectRoot,
      preview: expanded,
      authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
    });

    const projection = await getLocalCreativeProjectIngestStatus(projectRoot);
    expect(projection.contentImport).toMatchObject({
      sourceSnapshot: "current",
      sourceCheck: {
        liveFiles: expanded.statistics.totalFiles,
        baselineFiles: expanded.statistics.totalFiles,
        filesDelta: 0,
        liveBytes: expanded.statistics.totalBytes,
        baselineBytes: expanded.statistics.totalBytes,
        bytesDelta: 0,
      },
    });
  });

  it("旧 completed 进度缺少不可变完成基线时只读兼容为 UNVERIFIED，不能冒充 current", async () => {
    const { projectRoot, preview } = await fixture();
    await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
    });
    const progressPath = path.join(projectRoot, ".aicanvas", "local-creative-project-content-import.json");
    const progress = JSON.parse(await readFile(progressPath, "utf8")) as Record<string, any>;
    delete progress.completionBaselineFingerprint;
    await writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`);

    const projection = await getLocalCreativeProjectIngestStatus(projectRoot);
    expect(projection.contentImport).toMatchObject({
      status: "completed",
      truthStatus: "UNVERIFIED",
      sourceSnapshot: "unknown",
      completionBaseline: {
        status: "missing",
        fingerprint: null,
      },
    });
    expect(projection.nextAction.code).toBe("verify-source-snapshot");
  });

  it("已登记的完成基线收据被篡改后失败关闭为 UNVERIFIED", async () => {
    const { projectRoot, preview } = await fixture();
    const imported = await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
    });
    const fingerprint = imported.completionBaselineFingerprint!;
    const receiptPath = path.join(
      projectRoot,
      ".aicanvas",
      "local-creative-content-import-completion-baselines",
      `${fingerprint}.json`,
    );
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, any>;
    receipt.completion.processedMediaRecords += 1;
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    const projection = await getLocalCreativeProjectIngestStatus(projectRoot);
    expect(projection.contentImport).toMatchObject({
      truthStatus: "UNVERIFIED",
      sourceSnapshot: "unknown",
      completionBaseline: {
        status: "invalid",
        fingerprint,
      },
    });
    expect(projection.nextAction.code).toBe("verify-source-snapshot");
  });

  it("篡改 mutable progress 的来源 fingerprint 不能伪造新的 current 完成基线", async () => {
    const { projectRoot, preview, sourceRoot } = await fixture();
    await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
    });
    await sharp({
      create: { width: 44, height: 28, channels: 3, background: "#6d3e4d" },
    }).png().toFile(path.join(sourceRoot, "角色", "char-forged-current.png"));
    const expanded = await inspectLocalCreativeProject({
      projectKey: preview.project.key,
      projectName: preview.project.name,
      projectType: preview.project.type,
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: sourceRoot }],
      computeSha256: true,
    });
    const forgedLiveFingerprint = localCreativeSourceInventoryFromPreview(expanded).fingerprint;
    const progressPath = path.join(projectRoot, ".aicanvas", "local-creative-project-content-import.json");
    const progress = JSON.parse(await readFile(progressPath, "utf8")) as Record<string, any>;
    progress.sourceInventory.fingerprint = forgedLiveFingerprint;
    await writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`);

    const projection = await getLocalCreativeProjectIngestStatus(projectRoot);
    expect(projection.contentImport.sourceCheck.verificationInventoryFingerprint).toBe(forgedLiveFingerprint);
    expect(projection.contentImport).toMatchObject({
      truthStatus: "UNVERIFIED",
      sourceSnapshot: "unknown",
      completionBaseline: {
        status: "invalid",
        fingerprint: progress.completionBaselineFingerprint,
      },
    });
    expect(projection.nextAction.code).toBe("verify-source-snapshot");
  });

  it("损坏、漂移或伪造提升权威的 sidecar 失败关闭", async () => {
    const { projectRoot, preview } = await fixture();
    await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
    });
    const progressPath = path.join(projectRoot, ".aicanvas", "local-creative-project-content-import.json");
    const progress = JSON.parse(await readFile(progressPath, "utf8")) as Record<string, any>;
    const firstKey = Object.keys(progress.canonicalDecisionsByFileId)[0]!;
    progress.canonicalDecisionsByFileId[firstKey].authorityPromoted = true;
    await writeFile(progressPath, `${JSON.stringify(progress)}\n`);
    await expect(getLocalCreativeProjectIngestStatus(projectRoot))
      .rejects.toThrow(/不提升权威|authority/u);

    progress.canonicalDecisionsByFileId[firstKey].authorityPromoted = false;
    progress.runSummary.authorityPromotions = 1;
    await writeFile(progressPath, `${JSON.stringify(progress)}\n`);
    await expect(getLocalCreativeProjectIngestStatus(projectRoot))
      .rejects.toThrow(/不提升权威|authority/u);

    await writeFile(progressPath, "{broken-json\n");
    await expect(getLocalCreativeProjectIngestStatus(projectRoot))
      .rejects.toThrow(/JSON 无法解析/u);
  });
});
