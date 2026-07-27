import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLocalCreativeLockUsageReport,
  parseLocalCreativeLockUsageReportArgs,
  type LocalCreativeLockUsageReport,
} from "../scripts/build-local-creative-lock-usage-report.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "lock-usage-report-")));
  roots.push(root);
  return root;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function progress(input: {
  projectRoot: string;
  key: string;
  fileId: string;
  lockPath: string;
  status: "APPROVED_LOCK" | "CANDIDATE_LOCK";
  role: string;
  sha256: string;
  referencePath: string;
  explicit: boolean;
  claimPromoted?: boolean;
}) {
  return {
    schemaVersion: 1,
    kind: "local-creative-project-content-import-progress",
    projectRoot: input.projectRoot,
    sourceProject: { key: input.key, name: input.key, type: "story-production" },
    previewFingerprint: `local-creative-${"a".repeat(64)}`,
    mediaByFileId: {
      [input.fileId]: {
        fileId: input.fileId,
        sourcePath: input.lockPath,
        sourceLayerRole: input.role,
        sizeBytes: 10,
        mtimeMs: 1,
        sha256: input.sha256,
        kind: "image",
        status: "imported",
        lastAction: "imported",
        importedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    canonicalDecisionsByFileId: input.status === "APPROVED_LOCK" ? {
      [input.fileId]: {
        fileId: input.fileId,
        sourcePath: input.lockPath,
        sourceStatus: input.status,
        decision: "pending-version-created",
        assetId: `asset-${input.key}`,
        versionId: `version-${input.key}`,
        mediaSha256: input.sha256,
        authorityPromoted: input.claimPromoted ?? false,
        sourceApprovalEvidence: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    } : {},
    sourceStatusCounts: {
      APPROVED_LOCK: input.status === "APPROVED_LOCK" ? 1 : 0,
      CANDIDATE_LOCK: input.status === "CANDIDATE_LOCK" ? 1 : 0,
      FORMAL_MEDIA: 0,
      REJECTED_OR_FORBIDDEN: 0,
      UNKNOWN: 0,
    },
    lockReferenceIndex: [{
      lockFileId: input.fileId,
      lockPath: input.lockPath,
      status: input.status,
      referencedBy: [{
        fileId: `${input.fileId}-ref`,
        path: input.referencePath,
        evidenceLevels: input.explicit ? ["declared-mention", "explicit-reference"] : ["declared-mention"],
      }],
    }],
    failures: [],
    status: "completed",
  };
}

describe("本机创作锁图使用汇总报告", () => {
  it("按项目、源角色和精确 SHA 聚合，但不把引用冒充视觉出现或跨项目继承 authority", async () => {
    const root = await fixtureRoot();
    const sourcesRoot = path.join(root, "sources");
    const projectsRoot = path.join(root, "projects");
    const reportRoot = path.join(root, "reports");
    await Promise.all([mkdir(sourcesRoot), mkdir(projectsRoot), mkdir(reportRoot)]);
    const sourceA = path.join(sourcesRoot, "a");
    const sourceB = path.join(sourcesRoot, "b");
    const sourceC = path.join(sourcesRoot, "c");
    const projectA = path.join(projectsRoot, "a");
    const projectB = path.join(projectsRoot, "b");
    const projectC = path.join(projectsRoot, "c");
    await Promise.all([sourceA, sourceB, sourceC, projectA, projectB, projectC].map((entry) => mkdir(entry, { recursive: true })));
    const sharedSha = createHash("sha256").update("same complete image bytes").digest("hex");
    const lockA = path.join(sourceA, "char-authority.png");
    const lockB = path.join(sourceB, "char-candidate-copy.png");
    const refA = path.join(sourceA, "资产表.md");
    const refB = path.join(sourceB, "候选表.md");
    await Promise.all([
      writeFile(lockA, "same complete image bytes"),
      writeFile(lockB, "same complete image bytes"),
      writeFile(refA, "explicit reference"),
      writeFile(refB, "declared only"),
    ]);
    const progressAPath = path.join(projectA, ".aicanvas", "local-creative-project-content-import.json");
    const progressBPath = path.join(projectB, ".aicanvas", "local-creative-project-content-import.json");
    await Promise.all([
      writeJson(progressAPath, progress({
        projectRoot: projectA,
        key: "story-a",
        fileId: "lock-a",
        lockPath: lockA,
        status: "APPROVED_LOCK",
        role: "PRIMARY_AUTHORITY",
        sha256: sharedSha,
        referencePath: refA,
        explicit: true,
        // 即使输入错误声称已提升，报告也不能把它扩散到别的项目。
        claimPromoted: true,
      })),
      writeJson(progressBPath, progress({
        projectRoot: projectB,
        key: "story-b",
        fileId: "lock-b",
        lockPath: lockB,
        status: "CANDIDATE_LOCK",
        role: "ACTIVE_PRODUCTION",
        sha256: sharedSha,
        referencePath: refB,
        explicit: false,
      })),
    ]);
    const catalogPath = path.join(root, "catalog.json");
    const materializationPath = path.join(root, "materialization.json");
    const outputPath = path.join(reportRoot, "lock-usage.json");
    await writeJson(catalogPath, {
      schemaVersion: 1,
      kind: "local-creative-project-catalog-source",
      projects: [
        { key: "story-a", name: "故事A", projectType: "story-production", resolution: "CREATE_MANAGED", sources: [{ root: sourceA, role: "PRIMARY_AUTHORITY" }] },
        { key: "story-b", name: "故事B", projectType: "story-production", resolution: "CREATE_MANAGED", sources: [{ root: sourceB, role: "ACTIVE_PRODUCTION" }] },
        { key: "story-c", name: "故事C", projectType: "story-production", resolution: "CREATE_MANAGED", sources: [{ root: sourceC, role: "UPSTREAM_SCRIPT" }] },
      ],
    });
    await writeJson(materializationPath, {
      schemaVersion: 1,
      kind: "local-creative-project-materialization-report",
      fingerprint: "f".repeat(64),
      results: [
        { key: "story-a", name: "故事A", status: "materialized", resolution: "CREATE_MANAGED", projectRoot: projectA },
        { key: "story-b", name: "故事B", status: "materialized", resolution: "CREATE_MANAGED", projectRoot: projectB },
        { key: "story-c", name: "故事C", status: "materialized", resolution: "CREATE_MANAGED", projectRoot: projectC },
      ],
    });
    const before = await Promise.all([
      readFile(catalogPath),
      readFile(materializationPath),
      readFile(progressAPath),
      readFile(progressBPath),
      readFile(lockA),
      readFile(lockB),
    ]);

    const report = await buildLocalCreativeLockUsageReport({ catalogPath, materializationReportPath: materializationPath, outputPath });
    expect(report.summary).toMatchObject({
      catalogProjects: 3,
      projectsWithProgress: 2,
      projectsMissingProgress: 1,
      approvedLocks: 1,
      candidateLocks: 1,
      approvedImageLocks: 1,
      candidateImageLocks: 1,
      nonImageLockEvidenceRecords: 0,
      imageLocksWithExplicitReferences: 1,
      imageExplicitReferences: 1,
      locksWithExplicitReferences: 1,
      explicitReferences: 1,
      exactShaDuplicateGroups: 1,
      crossProjectExactShaDuplicateGroups: 1,
      visuallyConfirmedOccurrences: 0,
      inheritedAuthorities: 0,
    });
    expect(report.bySourceRole).toMatchObject({
      PRIMARY_AUTHORITY: { approvedLocks: 1, candidateLocks: 0, explicitReferences: 1 },
      ACTIVE_PRODUCTION: { approvedLocks: 0, candidateLocks: 1, explicitReferences: 0 },
    });
    expect(report.exactShaGroups).toEqual([
      expect.objectContaining({
        sha256: sharedSha,
        occurrenceCount: 2,
        projectCount: 2,
        exactDuplicate: true,
        crossProjectDuplicate: true,
        meaning: "BYTE_IDENTICAL_COMPLETE_FILES_ONLY",
        visualAppearance: "UNCONFIRMED",
        crossProjectAuthorityInheritance: "FORBIDDEN",
        occurrences: [
          expect.objectContaining({ projectKey: "story-a", status: "APPROVED_LOCK", crossProjectAuthorityInherited: false }),
          expect.objectContaining({ projectKey: "story-b", status: "CANDIDATE_LOCK", crossProjectAuthorityInherited: false }),
        ],
      }),
    ]);
    const approved = report.projects.find((project) => project.key === "story-a")!.locks[0]!;
    const candidate = report.projects.find((project) => project.key === "story-b")!.locks[0]!;
    expect(approved).toMatchObject({
      status: "APPROVED_LOCK",
      visualAppearance: { status: "UNCONFIRMED" },
      crossProjectAuthorityInherited: false,
      pendingLocalAsset: { authorityPromoted: false },
    });
    expect(candidate).toMatchObject({
      status: "CANDIDATE_LOCK",
      visualAppearance: { status: "UNCONFIRMED" },
      crossProjectAuthorityInherited: false,
    });
    expect(candidate.status).not.toBe("APPROVED_LOCK");
    expect(report.missingProgress).toEqual([
      expect.objectContaining({ projectKey: "story-c", expectedProgressPath: path.join(projectC, ".aicanvas", "local-creative-project-content-import.json") }),
    ]);
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: "CONTENT_PROGRESS_MISSING", projectKey: "story-c" }));
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
      kind: "local-creative-lock-usage-report",
      evidencePolicy: {
        lockRecordMeaning: "SOURCE_STATUS_RECORDS_MAY_INCLUDE_NON_IMAGE_EVIDENCE",
        visualLockMetricMeaning: "IMPORTED_RASTER_IMAGE_LOCK_RECORDS_ONLY",
        visualAppearanceDefault: "UNCONFIRMED",
        crossProjectAuthorityInheritance: "FORBIDDEN",
        authorityPromotionPerformed: false,
      },
    });
    const after = await Promise.all([
      readFile(catalogPath),
      readFile(materializationPath),
      readFile(progressAPath),
      readFile(progressBPath),
      readFile(lockA),
      readFile(lockB),
    ]);
    expect(after).toEqual(before);
    expect((await readdir(reportRoot)).filter((name) => name.includes(".tmp"))).toEqual([]);

    const second = await buildLocalCreativeLockUsageReport({ catalogPath, materializationReportPath: materializationPath, outputPath });
    expect(second.fingerprint).toBe(report.fingerprint);
  });

  it("支持 CLI 路径参数并拒绝把输出写进创作源或受管项目", async () => {
    const root = await fixtureRoot();
    const parsed = parseLocalCreativeLockUsageReportArgs([
      "--catalog", "inputs/catalog.json",
      "--materialization-report=inputs/materialized.json",
      "--output", "reports/usage.json",
    ], root);
    expect(parsed).toMatchObject({
      catalogPath: path.join(root, "inputs", "catalog.json"),
      materializationReportPath: path.join(root, "inputs", "materialized.json"),
      outputPath: path.join(root, "reports", "usage.json"),
      help: false,
    });

    const source = path.join(root, "source");
    const project = path.join(root, "project");
    await Promise.all([mkdir(source), mkdir(project)]);
    const catalogPath = path.join(root, "catalog.json");
    const materializationPath = path.join(root, "materialization.json");
    await writeJson(catalogPath, {
      schemaVersion: 1,
      projects: [{ key: "safe-story", name: "安全边界", projectType: "story-production", resolution: "CREATE_MANAGED", sources: [{ root: source, role: "PRIMARY_AUTHORITY" }] }],
    });
    await writeJson(materializationPath, {
      schemaVersion: 1,
      kind: "local-creative-project-materialization-report",
      fingerprint: "e".repeat(64),
      results: [{ key: "safe-story", name: "安全边界", status: "materialized", resolution: "CREATE_MANAGED", projectRoot: project }],
    });
    await expect(buildLocalCreativeLockUsageReport({
      catalogPath,
      materializationReportPath: materializationPath,
      outputPath: path.join(source, "forbidden.json"),
    })).rejects.toThrow("不得写入创作源或受管项目");
    await expect(buildLocalCreativeLockUsageReport({
      catalogPath,
      materializationReportPath: materializationPath,
      outputPath: path.join(project, "forbidden.json"),
    })).rejects.toThrow("不得写入创作源或受管项目");
  });
});
