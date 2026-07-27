import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isRejectedCommandFailure } from "../src/core/command-outcome.js";
import {
  migrateFusionStoryboardSheets,
  previewFusionStoryboardSheetMigration,
} from "../src/core/fusion-storyboard-sheet-migration.js";
import {
  listFusionStoryboardSheetArtifactSnapshot,
  loadFusionStoryboardSheetStore,
  registerLegacyFusionStoryboardSheetRecord,
} from "../src/core/fusion-storyboard-sheet-store.js";
import { getSidecarPaths } from "../src/core/sidecar.js";
import { createDefaultProjectConfig } from "../src/core/constants.js";
import {
  getFusionStoryboardSheetState,
  listFusionStoryboardSheets,
  selectAuthoritativeFusionStoryboardSheetReview,
} from "../src/core/fusion-storyboard-sheet-evidence.js";
import type { ReviewRecord } from "../src/core/types.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(): Promise<{ root: string; directory: string; pngPath: string; svgPath: string; png: Buffer; svg: Buffer }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p4-sheet-migration-"));
  roots.push(root);
  const directory = path.join(root, "production", "EP01", "04_15秒融合分镜", "EP01_15s_001", "AI画布生成");
  await mkdir(directory, { recursive: true });
  const paths = getSidecarPaths(root);
  await mkdir(paths.root, { recursive: true });
  const project = { ...createDefaultProjectConfig(root), id: "project-p4" };
  await writeFile(paths.index, `${JSON.stringify({
    schemaVersion: 1,
    project,
    scanId: "scan-p4-migration",
    scannedAt: "2026-07-17T00:00:00.000Z",
    scanDurationMs: 1,
    warnings: [],
    summary: { total: 1 },
    items: [{ id: "season-三-ep01-unit001", type: "unit" }],
    artifacts: [],
  }, null, 2)}\n`);
  const pngPath = path.join(directory, "EP01_15s_001_中文分镜故事板_grid-old.png");
  const svgPath = path.join(directory, "EP01_15s_001_中文分镜故事板_grid-old.svg");
  const png = Buffer.from("legacy-png-content");
  const svg = Buffer.from("<svg>legacy</svg>");
  await Promise.all([writeFile(pngPath, png), writeFile(svgPath, svg)]);
  return { root, directory, pngPath, svgPath, png, svg };
}

async function writeReceipt(input: Awaited<ReturnType<typeof fixture>>, suffix: string, review: boolean, overrides: Record<string, unknown> = {}): Promise<string> {
  const receiptPath = path.join(input.directory, `EP01_15s_001_中文分镜故事板_grid-old${suffix}.json`);
  const receipt = {
    schemaVersion: 1,
    kind: "fusion-storyboard-sheet-production-receipt",
    projectId: "project-p4",
    itemId: "season-三-ep01-unit001",
    contractId: "grid-old",
    sourceFingerprint: sha("source"),
    productionFingerprint: sha("production"),
    ...(review ? { reviewId: "review-old", requirementId: `fusion-review-${sha("old-requirement")}` } : {}),
    generationJobIds: ["job-1", "job-2"],
    panelImages: [],
    png: { path: input.pngPath, sha256: sha(input.png), bytes: input.png.length },
    svg: { path: input.svgPath, sha256: sha(input.svg), bytes: input.svg.length },
    width: 2_160,
    height: 3_840,
    panelCount: 2,
    durationSeconds: 15,
    renderPurpose: "formal",
    formalProductionEligible: true,
    ...overrides,
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receiptPath;
}

describe("P4 schema-v1 中文分镜板迁移", () => {
  it("共享输出的无 Review receipt 只登记自身，带旧 Review receipt 登记 PNG/SVG/receipt 为 stale，批量 revision 只加一且重放幂等", async () => {
    const input = await fixture();
    const noReviewReceipt = await writeReceipt(input, "", false);
    const reviewedReceipt = await writeReceipt(input, "_review-old", true);

    const preview = await previewFusionStoryboardSheetMigration(input.root, {});
    expect(preview).toMatchObject({
      schemaVersion: 1,
      kind: "fusion-storyboard-sheet-migration-preview",
      storeRevision: 0,
      scope: { itemIds: [] },
      candidateCount: 2,
      pendingCount: 2,
      blockers: [],
      canMigrate: true,
    });
    expect(preview.candidateFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect((await previewFusionStoryboardSheetMigration(input.root, {})).candidateFingerprint).toBe(preview.candidateFingerprint);
    const invalidCandidate = preview.candidates.find((candidate) => candidate.receiptPath === noReviewReceipt)!;
    const staleCandidate = preview.candidates.find((candidate) => candidate.receiptPath === reviewedReceipt)!;
    expect(invalidCandidate).toMatchObject({ status: "legacy-invalid", artifacts: [{ role: "receipt", path: noReviewReceipt }] });
    expect(staleCandidate.status).toBe("stale");
    expect(staleCandidate.artifacts.map((artifact) => artifact.role).sort()).toEqual(["png", "receipt", "svg"]);

    const migrated = await migrateFusionStoryboardSheets(input.root, {
      expectedStoreRevision: preview.storeRevision,
      expectedCandidateFingerprint: preview.candidateFingerprint,
    });
    expect(migrated).toMatchObject({ applied: true, replayed: false, previousRevision: 0, storeRevision: 1, candidateCount: 2, pendingCount: 2, created: 2, unchanged: 0 });
    const store = await loadFusionStoryboardSheetStore(input.root);
    expect(store.revision).toBe(1);
    expect(Object.values(store.legacyRecords)).toHaveLength(2);

    const snapshot = await listFusionStoryboardSheetArtifactSnapshot(input.root);
    expect(snapshot.items.filter((artifact) => artifact.path === input.pngPath)).toHaveLength(1);
    expect(snapshot.items.filter((artifact) => artifact.path === input.svgPath)).toHaveLength(1);
    expect(snapshot.items.find((artifact) => artifact.path === noReviewReceipt)).toMatchObject({ status: "legacy-invalid", role: "receipt" });
    expect(snapshot.items.find((artifact) => artifact.path === reviewedReceipt)).toMatchObject({ status: "stale", role: "receipt" });
    expect(snapshot.items.some((artifact) => artifact.reasons.includes("artifact-path-claimed-by-multiple-sheets"))).toBe(false);

    const replayed = await migrateFusionStoryboardSheets(input.root, {
      expectedStoreRevision: 0,
      expectedCandidateFingerprint: preview.candidateFingerprint,
    });
    expect(replayed).toMatchObject({ applied: false, replayed: true, previousRevision: 1, storeRevision: 1, created: 0, unchanged: 2 });
    expect((await loadFusionStoryboardSheetStore(input.root)).revision).toBe(1);
    expect(await previewFusionStoryboardSheetMigration(input.root, {})).toMatchObject({ storeRevision: 1, pendingCount: 0, canMigrate: false });

    const listed = await listFusionStoryboardSheets(input.root, { itemId: "season-三-ep01-unit001" });
    expect(listed).toMatchObject({ storeRevision: 1, migrationPreview: { storeRevision: 1, pendingCount: 0 }, total: 2 });
    expect(listed.items.every((version) => version.itemId === "season-三-ep01-unit001" && typeof version.createdAt === "string")).toBe(true);
    const state = await getFusionStoryboardSheetState(input.root, { itemId: "season-三-ep01-unit001" });
    expect(state).toMatchObject({ storeRevision: 1, migrationPreview: { storeRevision: 1, pendingCount: 0 } });
    expect(state.versions.map((version) => version.sheetId).sort()).toEqual(listed.items.map((version) => version.sheetId).sort());
  });

  it("同一当前 requirement 的 later rework 是权威裁决，不能继续复用旧 pass", () => {
    const base = {
      itemId: "season-三-ep01-unit001",
      reviewType: "image" as const,
      artifactIds: [],
      requirementId: "requirement-current",
      criteria: [],
      reviewer: "codex" as const,
      resultingStatus: "待视觉验收" as const,
    };
    const pass = { ...base, id: "review-pass", decision: "pass" as const, createdAt: "2026-07-17T00:00:00.000Z" } satisfies ReviewRecord;
    const rework = { ...base, id: "review-rework", decision: "rework" as const, resultingStatus: "返工" as const, createdAt: "2026-07-17T01:00:00.000Z" } satisfies ReviewRecord;
    const unrelated = { ...base, id: "review-other", requirementId: "requirement-other", decision: "pass" as const, createdAt: "2026-07-17T02:00:00.000Z" } satisfies ReviewRecord;
    expect(selectAuthoritativeFusionStoryboardSheetReview([pass, unrelated, rework], base.itemId, base.requirementId)).toEqual(rework);
  });

  it("CAS 冲突和候选 SHA/size 漂移均以 RejectedCommandFailure 零写入", async () => {
    const input = await fixture();
    await writeReceipt(input, "_review-old", true);
    const preview = await previewFusionStoryboardSheetMigration(input.root, {});

    const unrelated = path.join(input.root, "unrelated.png");
    await writeFile(unrelated, "unrelated");
    await registerLegacyFusionStoryboardSheetRecord(input.root, {
      itemId: "season-三-ep01-unit999",
      artifacts: [{ role: "png", path: unrelated, pageIndex: 1, pageCount: 1, sha256: sha("unrelated"), bytes: 9 }],
      reason: "unrelated existing history",
    }, { expectedRevision: 0 });
    await expect(migrateFusionStoryboardSheets(input.root, {
      expectedStoreRevision: preview.storeRevision,
      expectedCandidateFingerprint: preview.candidateFingerprint,
    })).rejects.toSatisfy((error: unknown) => isRejectedCommandFailure(error)
      && (error.result as { applied?: boolean; reason?: string; currentRevision?: number }).applied === false
      && (error.result as { reason?: string }).reason === "revision_conflict"
      && (error.result as { currentRevision?: number }).currentRevision === 1);
    expect((await loadFusionStoryboardSheetStore(input.root)).revision).toBe(1);
    expect(Object.values((await loadFusionStoryboardSheetStore(input.root)).legacyRecords)).toHaveLength(1);

    const driftInput = await fixture();
    await writeReceipt(driftInput, "_review-old", true);
    const driftPreview = await previewFusionStoryboardSheetMigration(driftInput.root, {});
    await writeFile(driftInput.pngPath, "drifted-content");
    await expect(migrateFusionStoryboardSheets(driftInput.root, {
      expectedStoreRevision: 0,
      expectedCandidateFingerprint: driftPreview.candidateFingerprint,
    })).rejects.toSatisfy((error: unknown) => isRejectedCommandFailure(error)
      && ["candidate_drift", "unsafe_candidates"].includes((error.result as { reason?: string }).reason ?? ""));
    expect((await loadFusionStoryboardSheetStore(driftInput.root)).revision).toBe(0);
    await expect(access(getSidecarPaths(driftInput.root).storyboardSheetIndex)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("越界输出和符号链接输出失败关闭，不产生迁移索引", async () => {
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p4-sheet-outside-"));
    roots.push(outsideRoot);
    const outside = path.join(outsideRoot, "outside.png");
    await writeFile(outside, "outside");

    const escaped = await fixture();
    await writeReceipt(escaped, "_review-old", true, { png: { path: outside, sha256: sha("outside"), bytes: 7 } });
    const escapedPreview = await previewFusionStoryboardSheetMigration(escaped.root, {});
    expect(escapedPreview).toMatchObject({ canMigrate: false, pendingCount: 0 });
    expect(escapedPreview.blockers.join(" ")).toMatch(/越出|工程/u);

    const linked = await fixture();
    const target = path.join(linked.directory, "real.png");
    const link = path.join(linked.directory, "linked.png");
    await writeFile(target, "linked-content");
    await symlink(target, link);
    await writeReceipt(linked, "_review-old", true, { png: { path: link, sha256: sha("linked-content"), bytes: 14 } });
    const linkedPreview = await previewFusionStoryboardSheetMigration(linked.root, {});
    expect(linkedPreview.canMigrate).toBe(false);
    expect(linkedPreview.blockers.join(" ")).toMatch(/符号链接|普通文件/u);

    for (const [root, preview] of [[escaped.root, escapedPreview], [linked.root, linkedPreview]] as const) {
      await expect(migrateFusionStoryboardSheets(root, {
        expectedStoreRevision: preview.storeRevision,
        expectedCandidateFingerprint: preview.candidateFingerprint,
      })).rejects.toSatisfy((error: unknown) => isRejectedCommandFailure(error));
      expect((await loadFusionStoryboardSheetStore(root)).revision).toBe(0);
      await expect(access(getSidecarPaths(root).storyboardSheetIndex)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("receipt projectId 或 itemId 不属于当前权威索引时 blocker 且零写入", async () => {
    const wrongProject = await fixture();
    await writeReceipt(wrongProject, "_review-old", true, { projectId: "project-other" });
    const projectPreview = await previewFusionStoryboardSheetMigration(wrongProject.root, {});
    expect(projectPreview).toMatchObject({ canMigrate: false, pendingCount: 0 });
    expect(projectPreview.blockers.join(" ")).toMatch(/projectId|当前工程/u);

    const wrongItem = await fixture();
    await writeReceipt(wrongItem, "_review-old", true, { itemId: "season-三-ep01-unit999" });
    const itemPreview = await previewFusionStoryboardSheetMigration(wrongItem.root, {});
    expect(itemPreview).toMatchObject({ canMigrate: false, pendingCount: 0 });
    expect(itemPreview.blockers.join(" ")).toMatch(/itemId|unit/u);

    for (const [root, preview] of [[wrongProject.root, projectPreview], [wrongItem.root, itemPreview]] as const) {
      await expect(migrateFusionStoryboardSheets(root, {
        expectedStoreRevision: preview.storeRevision,
        expectedCandidateFingerprint: preview.candidateFingerprint,
      })).rejects.toSatisfy((error: unknown) => isRejectedCommandFailure(error));
      expect((await loadFusionStoryboardSheetStore(root)).revision).toBe(0);
      await expect(access(getSidecarPaths(root).storyboardSheetIndex)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
