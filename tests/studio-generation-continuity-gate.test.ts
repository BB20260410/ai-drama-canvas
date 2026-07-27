import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { STUDIO_CONTINUITY_FIELDS } from "../src/core/studio-continuity.js";
import { appendStudioContinuityObservation } from "../src/core/studio-continuity-ledger.js";
import {
  assertStudioGenerationFreezePackCurrent,
  buildStudioGenerationFreezePack,
} from "../src/core/studio-generation.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  assertStudioGenerationResultPromotionEligible,
  readStudioGenerationFrozenPack,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

let fixture: StudioP7Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

async function approvePanelRaw(
  currentFixture: StudioP7Fixture,
  unit: StudioP7Fixture["units"][keyof StudioP7Fixture["units"]],
  panelIndex: number,
  generationRunId: string,
  continuityFingerprintOverride?: string,
) {
  const panel = unit.panels[panelIndex - 1]!;
  const media = currentFixture.panelMediaPairs.find((entry) => entry.unitId === unit.unit.id && entry.panelId === panel.id)!;
  const persisted = await freezeAndPersistStudioGenerationPack(currentFixture.root, {
    unitId: unit.unit.id,
    panelId: panel.id,
  });
  await dispatchStudioGenerationPack(currentFixture.root, {
    packId: persisted.packId,
    packFingerprint: persisted.fingerprint,
    generationRunId,
    provider: "codex",
  });
  const raw = await registerStudioGenerationResult(currentFixture.root, {
    packId: persisted.packId,
    packFingerprint: persisted.fingerprint,
    generationRunId,
    variant: "raw",
    mediaSha256: media.raw.imported.sha256,
  });
  const labeled = await registerStudioGenerationResult(currentFixture.root, {
    packId: persisted.packId,
    packFingerprint: persisted.fingerprint,
    generationRunId,
    variant: "labeled",
    mediaSha256: media.labeled.imported.sha256,
  });
  const review = await submitStudioGenerationReview(currentFixture.root, {
    operationId: `p7-generation-review-${generationRunId}`,
    generationRunId,
    kind: "observation",
    expectedHeadRevision: 0,
    rawResultId: raw.resultId,
    rawSha256: raw.mediaSha256,
    labeledResultId: labeled.resultId,
    labeledSha256: labeled.mediaSha256,
    expectedPackFingerprint: persisted.fingerprint,
    continuityFingerprint: continuityFingerprintOverride ?? persisted.pack.continuity.fingerprint,
    decision: "pass",
    criteria: [{ code: "mechanical-pair", status: "pass", note: "确定性 fixture 只证明机械闭包。" }],
    reviewer: "p7-generation-continuity-test",
    note: "用于验证显式上一格 raw 注入。",
  });
  expect(review).toMatchObject({ current: true, head: true, approvedRawEligible: true });
  return { panel, persisted, raw, labeled, review };
}

describe("P7 Studio generation continuity gate", () => {
  it("九字段缺失时失败关闭；显式 seeding 后只渲染 ledger resolved/not-applicable，不采信 legacy continuityState", async () => {
    fixture = await createStudioP7Fixture();
    const panel = fixture.units.sixPanel.panels[0]!;
    await expect(buildStudioGenerationFreezePack(fixture.root, {
      unitId: fixture.units.sixPanel.unit.id,
      panelId: panel.id,
    })).rejects.toMatchObject({ code: "continuity-not-ready" });

    await seedStudioP7ResolvedContinuity(fixture);
    const pack = await buildStudioGenerationFreezePack(fixture.root, {
      unitId: fixture.units.sixPanel.unit.id,
      panelId: panel.id,
    });
    expect(pack.schemaVersion).toBe(4);
    expect(pack.request.schemaVersion).toBe(4);
    expect(pack.continuity.requiredFields).toEqual([...STUDIO_CONTINUITY_FIELDS]);
    expect(pack.continuity.assets).toHaveLength(3);
    for (const asset of pack.continuity.assets) {
      expect(asset.requiredFields).toEqual([...STUDIO_CONTINUITY_FIELDS]);
      expect(asset.heads).toHaveLength(STUDIO_CONTINUITY_FIELDS.length);
      expect(asset.heads.every((head) => head.state.status === "resolved" || head.state.status === "not-applicable")).toBe(true);
      expect(pack.assets.find((entry) => entry.assetId === asset.assetId)?.continuity).toEqual(asset);
    }
    expect(pack.request.modelPayload.renderedPrompt).toContain("连续性账本 position");
    expect(pack.request.modelPayload.renderedPrompt).toContain("fixture:character-ahang:position:1");
    expect(pack.request.modelPayload.renderedPrompt).not.toContain("legacy evidence");
    expect(pack.previousApprovedRaw).toBeUndefined();
    expect(pack.request.continuityFrame).toBeUndefined();
    expect(pack.panelReferenceResolution.controlReferences.some((entry) => entry.purpose === "continuity")).toBe(false);
    expect(pack.panelReferenceResolution.dependencies.filter((entry) => entry.kind.startsWith("continuity-"))).toHaveLength(
      1 + 3 * (1 + STUDIO_CONTINUITY_FIELDS.length),
    );
  }, 120_000);

  it("同一字段出现相互矛盾的 current observation 后 readiness 失败，旧 v4 pack 不再 current", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    const unit = fixture.units.sixPanel;
    const panel = unit.panels[1]!;
    const pack = await buildStudioGenerationFreezePack(fixture.root, { unitId: unit.unit.id, panelId: panel.id });
    await appendStudioContinuityObservation(fixture.root, {
      operationId: "p7-generation-conflicting-position",
      expectedHeadRevision: 1,
      scope: {
        kind: "panel",
        scopeId: panel.id,
        unitId: unit.unit.id,
        unitRevision: unit.unit.revision,
        startMilliseconds: Math.round(panel.startSeconds * 1_000),
        endMilliseconds: Math.round(panel.endSeconds * 1_000),
      },
      subjectId: fixture.assets.ahang.id,
      field: "position",
      state: {
        status: "resolved",
        value: "conflict:character-ahang:position:right-edge",
        provenance: [{
          kind: "conflict-fixture",
          reference: panel.id,
          sourceFingerprint: digest({ panelId: panel.id, value: "right-edge" }),
        }],
      },
    });
    await expect(buildStudioGenerationFreezePack(fixture.root, { unitId: unit.unit.id, panelId: panel.id }))
      .rejects.toMatchObject({ code: "continuity-not-ready" });
    await expect(assertStudioGenerationFreezePackCurrent(fixture.root, pack))
      .rejects.toMatchObject({ code: "continuity-not-ready" });
  }, 120_000);

  it("previous raw 只在显式 current pass Review 且同集紧邻时注入，跨单元边界也可机械证明", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    const unit = fixture.units.sixPanel;
    const previous = await approvePanelRaw(fixture, unit, 1, "p7-continuity-run-panel-01");
    const currentPanel = unit.panels[1]!;

    const withoutExplicitPrevious = await buildStudioGenerationFreezePack(fixture.root, {
      unitId: unit.unit.id,
      panelId: currentPanel.id,
    });
    expect(withoutExplicitPrevious.previousApprovedRaw).toBeUndefined();
    expect(withoutExplicitPrevious.request.continuityFrame).toBeUndefined();
    expect(withoutExplicitPrevious.panelReferenceResolution.controlReferences).toHaveLength(3);

    const withPrevious = await buildStudioGenerationFreezePack(fixture.root, {
      unitId: unit.unit.id,
      panelId: currentPanel.id,
      previousApprovedRawReviewId: previous.review.reviewId,
    });
    expect(withPrevious.previousApprovedRaw).toMatchObject({
      reviewId: previous.review.reviewId,
      rawResultId: previous.raw.resultId,
      rawSha256: previous.raw.mediaSha256,
      packId: previous.persisted.packId,
      continuityFingerprint: previous.persisted.pack.continuity.fingerprint,
    });
    expect(withPrevious.request.continuityFrame).toMatchObject({
      kind: "continuity-frame",
      purpose: "continuity",
      reviewId: previous.review.reviewId,
      rawResultId: previous.raw.resultId,
      mediaSha256: previous.raw.mediaSha256,
      coveredAssetIds: ["character-ahang", "prop-complete-golden-mask", "scene-stone-room"],
    });
    const controls = withPrevious.panelReferenceResolution.controlReferences;
    expect(controls).toHaveLength(4);
    expect(controls.filter((entry) => entry.purpose === "identity")).toHaveLength(3);
    expect(controls.filter((entry) => entry.kind === "continuity-frame" && entry.purpose === "continuity")).toHaveLength(1);
    expect(withPrevious.panelReferenceResolution.overflowControlReferences).toEqual([]);
    expect(withPrevious.panelReferenceResolution.dependencies.map((entry) => entry.fingerprint)).toEqual(expect.arrayContaining([
      previous.raw.mediaSha256,
      previous.review.fingerprint,
      previous.persisted.fingerprint,
    ]));
    await expect(assertStudioGenerationFreezePackCurrent(fixture.root, withPrevious)).resolves.toEqual(withPrevious);

    await expect(buildStudioGenerationFreezePack(fixture.root, {
      unitId: unit.unit.id,
      panelId: unit.panels[2]!.id,
      previousApprovedRawReviewId: previous.review.reviewId,
    })).rejects.toMatchObject({ code: "previous-panel-not-adjacent" });

    const lastOfFirstUnit = await approvePanelRaw(fixture, unit, unit.panels.length, "p7-continuity-run-panel-06");
    const firstOfSecondUnit = fixture.units.twoPanel.panels[0]!;
    const acrossUnit = await buildStudioGenerationFreezePack(fixture.root, {
      unitId: fixture.units.twoPanel.unit.id,
      panelId: firstOfSecondUnit.id,
      previousApprovedRawReviewId: lastOfFirstUnit.review.reviewId,
    });
    expect(acrossUnit.request.continuityFrame?.rawResultId).toBe(lastOfFirstUnit.raw.resultId);
    expect(acrossUnit.previousApprovedRaw?.sourceTarget).toMatchObject({
      unitSequence: 1,
      panelIndex: 6,
      panelCount: 6,
      episodeAbsoluteEndSeconds: 15,
    });
    expect(acrossUnit.target).toMatchObject({ unitSequence: 2, panelIndex: 1, episodeAbsoluteStartSeconds: 15 });
  }, 120_000);

  it("Review continuityFingerprint 与来源 v4 pack 不一致时，Review 写入面先行失败关闭", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    const unit = fixture.units.sixPanel;
    await expect(approvePanelRaw(fixture, unit, 3, "p7-continuity-run-wrong-fingerprint", "f".repeat(64)))
      .rejects.toMatchObject({ code: "result-pair-invalid" });
  }, 120_000);

  it("schema v3 pack 仅历史读取；dispatch/register/promotion 均失败且不改写旧 CAS", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    const panel = fixture.units.sixPanel.panels[0]!;
    const persisted = await freezeAndPersistStudioGenerationPack(fixture.root, {
      unitId: fixture.units.sixPanel.unit.id,
      panelId: panel.id,
    });
    const historical = structuredClone(persisted.pack) as unknown as Record<string, any>;
    historical.schemaVersion = 3;
    historical.request.schemaVersion = 3;
    delete historical.continuity;
    delete historical.previousApprovedRaw;
    delete historical.request.continuity;
    delete historical.request.previousApprovedRaw;
    delete historical.request.continuityFrame;
    for (const asset of historical.assets as Array<Record<string, unknown>>) {
      delete asset.continuity;
      asset.continuityState = "historical-p6-explicit-state";
      asset.continuityEvidence = [];
    }
    for (const asset of historical.request.modelPayload.assets as Array<Record<string, unknown>>) {
      delete asset.continuity;
      asset.continuityState = "historical-p6-explicit-state";
      asset.continuityEvidence = [];
    }
    const requestSemantic = { ...historical.request };
    delete requestSemantic.id;
    delete requestSemantic.fingerprint;
    const requestFingerprint = digest(requestSemantic);
    historical.request.fingerprint = requestFingerprint;
    historical.request.id = `studio-codex-request-${requestFingerprint.slice(0, 32)}`;
    const packSemantic = { ...historical };
    delete packSemantic.id;
    delete packSemantic.fingerprint;
    const packFingerprint = digest(packSemantic);
    historical.fingerprint = packFingerprint;
    historical.id = `studio-generation-freeze-${packFingerprint.slice(0, 32)}`;

    const bytes = Buffer.from(`${JSON.stringify(stableValue(historical), null, 2)}\n`, "utf8");
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    const contentRelpath = `.aicanvas/studio-generation/objects/sha256/${contentSha256.slice(0, 2)}/${contentSha256}.json`;
    const contentPath = path.join(fixture.root, contentRelpath);
    await mkdir(path.dirname(contentPath), { recursive: true });
    await writeFile(contentPath, bytes);
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const generationRunId = "p7-historical-v3-run";
    const dispatchId = `studio-generation-dispatch-${digest({
      schemaVersion: 2,
      generationRunId,
      packId: historical.id,
      packFingerprint,
      provenance: "legacy-registration",
    }).slice(0, 40)}`;
    const media = fixture.panelMediaPairs.find((entry) => entry.unitId === fixture!.units.sixPanel.unit.id
      && entry.panelId === panel.id)!;
    const now = new Date().toISOString();
    const resultRows = ([
      ["raw", media.raw.imported.sha256],
      ["labeled", media.labeled.imported.sha256],
    ] as const).map(([variant, mediaSha256]) => {
      const resultFingerprint = digest({
        packId: historical.id,
        packFingerprint,
        generationRunId,
        variant,
        mediaSha256,
        status: "pending",
      });
      return { variant, mediaSha256, resultId: `studio-generation-result-${resultFingerprint.slice(0, 40)}` };
    });
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      db.prepare(`
        INSERT INTO studio_generation_packs(
          pack_id,fingerprint,content_sha256,content_relpath,content_size_bytes,
          project_id,unit_id,unit_revision,panel_id,panel_index,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        historical.id, packFingerprint, contentSha256, contentRelpath, bytes.byteLength,
        historical.projectId, historical.target.unitId, historical.target.unitRevision,
        historical.target.panelId, historical.target.panelIndex, now,
      );
      db.prepare(`
        INSERT INTO studio_generation_dispatches(
          dispatch_id,generation_run_id,pack_id,pack_fingerprint,executor_provider,provenance,dispatched_at
        ) VALUES(?,?,?,?,?,?,?)
      `).run(dispatchId, generationRunId, historical.id, packFingerprint, "codex", "legacy-registration", now);
      for (const row of resultRows) db.prepare(`
        INSERT INTO studio_generation_results(
          result_id,dispatch_id,generation_run_id,variant,status,media_sha256,
          input_current,promotion_eligible,stale_reasons_json,pack_id,pack_fingerprint,
          unit_id,unit_revision,panel_id,panel_index,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        row.resultId, dispatchId, generationRunId, row.variant, "pending", row.mediaSha256,
        0, 0, JSON.stringify(["historical-schema-v3"]), historical.id, packFingerprint,
        historical.target.unitId, historical.target.unitRevision, historical.target.panelId,
        historical.target.panelIndex, now,
      );
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* no-op */ }
      throw error;
    } finally {
      db.close();
    }

    const before = await readFile(contentPath);
    const read = await readStudioGenerationFrozenPack(fixture.root, historical.id);
    expect(read?.schemaVersion).toBe(3);
    await expect(dispatchStudioGenerationPack(fixture.root, {
      packId: historical.id,
      packFingerprint,
      generationRunId,
    provider: "codex",
  })).rejects.toMatchObject({ code: "pack-schema-unsupported" });
    await expect(registerStudioGenerationResult(fixture.root, {
      packId: historical.id,
      packFingerprint,
      generationRunId,
      variant: "raw",
      mediaSha256: resultRows[0]!.mediaSha256,
    })).rejects.toMatchObject({ code: "pack-schema-unsupported" });
    await expect(assertStudioGenerationResultPromotionEligible(fixture.root, resultRows[0]!.resultId))
      .rejects.toMatchObject({ code: "pack-schema-unsupported" });
    expect(await readFile(contentPath)).toEqual(before);
  }, 120_000);
});
