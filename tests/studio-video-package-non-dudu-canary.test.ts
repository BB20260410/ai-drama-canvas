import { mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { executeIdempotentCommand, type StudioCommandRequest } from "../src/core/command-bus.js";
import { getStudioMedia } from "../src/core/material-studio.js";
import { getStudioPostResultObservationControl } from "../src/core/studio-post-result-observation.js";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.js";
import {
  getStudioVideoPackageControl,
  prepareStudioVideoPackageSource,
} from "../src/core/studio-video-package.js";
import {
  commitUnitGridBundle,
  createUnitGridFixtureProject,
  freezeDispatchPrepareUnitGrid,
  passUnitGridReview,
} from "./helpers/studio-unit-grid-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function commandEnvelope(tag: string, request: StudioCommandRequest) {
  return {
    requestId: `p5-non-dudu-${tag}-request`,
    idempotencyKey: `p5-non-dudu-${tag}-key`,
    request,
  };
}

async function readyNonDuduProject(tag: string) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), `p5-non-dudu-${tag}-`)));
  roots.push(parent);
  const fixture = await createUnitGridFixtureProject(parent, {
    unitId: `unit-p5-non-dudu-${tag}`,
    season: "ORIGINAL-S1",
    episode: "EP03",
  });
  expect(fixture.root).not.toContain("local-import-dudu");
  const run = await freezeDispatchPrepareUnitGrid(
    fixture.root,
    fixture.unitId,
    `p5-non-dudu-${tag}-run`,
  );
  const bundle = await commitUnitGridBundle(fixture.root, run, `p5-non-dudu-${tag}`);
  const review = await passUnitGridReview(
    fixture.root,
    run,
    bundle,
    `p5-non-dudu-${tag}-review`,
    {
      reviewer: "p5-non-dudu-video-package-canary",
      note: "非 Dudu 确定性机械 canary；不冒充模型视觉验收。",
    },
  );
  const snapshot = await getStudioProductionUnitSnapshot(fixture.root, fixture.unitId);
  if (!snapshot) throw new Error("非 Dudu canary unit 缺失。");
  const observation = await getStudioPostResultObservationControl(
    fixture.root,
    review.generationRunId,
  );
  const source = await prepareStudioVideoPackageSource(fixture.root, {
    adapterKind: "managed-evidence-v1",
    reviewId: review.reviewId,
    expectedReviewFingerprint: review.fingerprint,
    expectedPackFingerprint: run.pack.fingerprint,
    expectedUnitSnapshotFingerprint: snapshot.fingerprint,
    expectedObservationControlFingerprint: observation.fingerprint,
    expectedObservationHeadRevision: observation.headRevision,
    expectedObservationStatus: observation.status,
    expectedObservationHeadId: observation.head?.observationId ?? null,
    expectedObservationHeadFingerprint: observation.head?.fingerprint ?? null,
    expectedObservationEvidenceSha256: observation.head?.evidenceSha256 ?? null,
  });
  const authority = { kind: "studio-review" as const, reviewId: review.reviewId };
  const expectedManagedSource = {
    adapterKind: "managed-evidence-v1" as const,
    reviewId: review.reviewId,
    expectedSourceFingerprint: source.fingerprint,
    expectedReviewFingerprint: review.fingerprint,
    expectedPackFingerprint: run.pack.fingerprint,
    expectedUnitSnapshotFingerprint: snapshot.fingerprint,
    expectedObservationControlFingerprint: observation.fingerprint,
    expectedObservationHeadRevision: observation.headRevision,
    expectedObservationStatus: observation.status,
    expectedObservationHeadId: observation.head?.observationId ?? null,
    expectedObservationHeadFingerprint: observation.head?.fingerprint ?? null,
    expectedObservationEvidenceSha256: observation.head?.evidenceSha256 ?? null,
  };
  const beforePrepare = await getStudioVideoPackageControl(fixture.root, {
    by: "authority-latest",
    authority,
  });
  const prepareRecord = await executeIdempotentCommand(
    fixture.root,
    commandEnvelope(`${tag}-prepare`, {
      command: "prepare_studio_video_package_export",
      payload: {
        authority,
        expectedRevision: snapshot.unit.revision,
        expectedControlFingerprint: beforePrepare.fingerprint,
        expectedManagedSource,
      },
    }),
  );
  expect(prepareRecord.status).toBe("succeeded");
  const prepared = prepareRecord.result as {
    intent: {
      intentId: string;
      unitId: string;
      unitRevision: number;
      fingerprint: string;
    };
  };
  return {
    fixture,
    run,
    bundle,
    review,
    snapshot,
    authority,
    prepared,
  };
}

async function buildThroughCommand(
  current: Awaited<ReturnType<typeof readyNonDuduProject>>,
  tag: string,
) {
  const intentControl = await getStudioVideoPackageControl(current.fixture.root, {
    by: "intent",
    intentId: current.prepared.intent.intentId,
  });
  const authorityControl = await getStudioVideoPackageControl(current.fixture.root, {
    by: "authority-latest",
    authority: current.authority,
  });
  const envelope = commandEnvelope(`${tag}-build`, {
      command: "build_studio_video_package",
      payload: {
        intentId: current.prepared.intent.intentId,
        expectedRevision: current.snapshot.unit.revision,
        expectedIntentControlFingerprint: intentControl.fingerprint,
        expectedAuthorityControlFingerprint: authorityControl.fingerprint,
        destinationPolicy: "managed-evidence-only",
      },
    });
  return {
    envelope,
    record: await executeIdempotentCommand(current.fixture.root, envelope),
  };
}

function receiptCount(root: string, intentId: string): number {
  const db = new DatabaseSync(
    path.join(root, ".aicanvas", "studio-generation-ledger.sqlite"),
    { readOnly: true },
  );
  try {
    return Number((db.prepare(`
      SELECT COUNT(*) AS count
      FROM studio_video_package_verify_receipts
      WHERE intent_id=?
    `).get(intentId) as { count: number }).count);
  } finally {
    db.close();
  }
}

describe.sequential("P5 非 Dudu 通用视频包重型 canary", () => {
  it("同一 managed-evidence-v1 adapter 在 6 分钟内闭合包与漂移失败关闭", async () => {
    const startedAt = Date.now();
    const success = await readyNonDuduProject("success");
    const builtCommand = await buildThroughCommand(success, "success");
    const builtRecord = builtCommand.record;
    expect(builtRecord.status).toBe("succeeded");
    const built = builtRecord.result as {
      receipt: {
        receiptId: string;
        storageKind: string;
        storageRelativePath: string;
        manifestRelativePath: string;
        mechanicalStatus: string;
        files: Array<{ path: string; sha256: string }>;
        fingerprint: string;
      };
    };
    expect(built.receipt).toMatchObject({
      storageKind: "managed-evidence",
      mechanicalStatus: "verified",
    });
    expect(receiptCount(success.fixture.root, success.prepared.intent.intentId)).toBe(1);

    const packageRoot = path.join(success.fixture.root, built.receipt.storageRelativePath);
    const names = (await readdir(packageRoot)).sort((left, right) => left.localeCompare(right, "en"));
    expect(names).toEqual(expect.arrayContaining([
      "manifest.json",
      `${success.fixture.unitId}_labeled.png`,
      `${success.fixture.unitId}_video.json`,
      `${success.fixture.unitId}-G1_raw.png`,
      `${success.fixture.unitId}-G1_labeled.png`,
      `${success.fixture.unitId}-G1_video.md`,
      `${success.fixture.unitId}-G2_raw.png`,
      `${success.fixture.unitId}-G2_labeled.png`,
      `${success.fixture.unitId}-G2_video.md`,
    ]));
    const manifest = JSON.parse(await readFile(
      path.join(packageRoot, "manifest.json"),
      "utf8",
    )) as {
      manifest_version?: string;
      builder?: string;
      unit_id?: string;
      files?: Array<{ path?: string; sha256?: string }>;
    };
    expect(manifest).toMatchObject({
      manifest_version: "2.0",
      builder: "core-managed-video-package-v1",
      unit_id: success.fixture.unitId,
    });
    expect(manifest.files?.length).toBe(8);
    expect(built.receipt.files).toHaveLength(8);

    const replay = await executeIdempotentCommand(
      success.fixture.root,
      builtCommand.envelope,
    );
    expect(replay).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: { receipt: { receiptId: built.receipt.receiptId } },
    });
    expect(receiptCount(success.fixture.root, success.prepared.intent.intentId)).toBe(1);

    const drift = await readyNonDuduProject("drift");
    const rawMedia = await getStudioMedia(drift.fixture.root, drift.bundle.raw.mediaSha256);
    if (!rawMedia) throw new Error("非 Dudu drift canary raw CAS 缺失。");
    await writeFile(rawMedia.objectPath, "p5-non-dudu-input-drift");
    await expect(buildThroughCommand(drift, "drift")).rejects.toThrow(/input-drift|漂移|完整性|SHA/u);
    expect(receiptCount(drift.fixture.root, drift.prepared.intent.intentId)).toBe(0);
    const driftControl = await getStudioVideoPackageControl(drift.fixture.root, {
      by: "intent",
      intentId: drift.prepared.intent.intentId,
    });
    expect(driftControl).toMatchObject({
      control: {
        status: "stale",
        receipt: null,
      },
    });

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThanOrEqual(360_000);
  }, 360_000);
});
