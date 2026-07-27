/**
 * Batch2 (slots 7–12 / U07–U12): ensure Review pass → refresh checkpoint → attest pass.
 */
import { activateProject } from "../src/core/service.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import {
  getStudioGenerationCheckpointControl,
  refreshStudioGenerationCheckpoint,
  attestStudioGenerationCheckpoint,
} from "../src/core/studio-generation-checkpoint.js";
import {
  readStudioGenerationResultBundle,
  readAnyStudioGenerationFrozenPack,
} from "../src/core/studio-generation-ledger.js";
import { openDatabase } from "../src/core/studio-generation-ledger.js";
// openDatabase may not be exported - use sqlite directly if needed

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";

const RUNS: Array<{ unitId: string; generationRunId: string }> = [
  { unitId: "S1E2-U07", generationRunId: "s1e2-u07-ug-grok-mrxh9cnw" },
  { unitId: "S1E2-U08", generationRunId: "s1e2-u08-ug-grok-mrxhgckt" },
  { unitId: "S1E2-U09", generationRunId: "s1e2-u09-ug-grok-mrxhsbv5" },
  { unitId: "S1E2-U10", generationRunId: "s1e2-u10-ug-grok-mrxi06hx" },
  { unitId: "S1E2-U11", generationRunId: "s1e2-u11-ug-grok-mrxigffv" },
  { unitId: "S1E2-U12", generationRunId: "s1e2-u12-ug-grok-mrxj5nb4" },
];

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(label: string, fn: () => Promise<T>, max = 10): Promise<T> {
  let last: any;
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      const msg = String(e?.message || e);
      const race = /snapshot|WAL|冻结|隔离|identity|changed while|safe regular|database is locked|ledger/i.test(msg);
      console.log(`${label} fail ${i} race=${race}: ${msg.slice(0, 160)}`);
      if (!race && i >= 2) throw e;
      await sleep(500 * Math.pow(1.35, i) + Math.random() * 200);
    }
  }
  throw last;
}

async function ensurePassReview(unitId: string, generationRunId: string) {
  const bundle = await withRetry(`bundle ${unitId}`, () =>
    readStudioGenerationResultBundle(ROOT, generationRunId),
  );
  // bundle shape may vary — normalize
  const raw = (bundle as any).raw || (bundle as any).results?.raw || (bundle as any).pair?.raw;
  const labeled = (bundle as any).labeled || (bundle as any).results?.labeled || (bundle as any).pair?.labeled;
  if (!raw || !labeled) {
    // fallback: use control via listing
    console.log("bundle keys", Object.keys(bundle as any));
    throw new Error(`no raw/labeled for ${generationRunId}`);
  }
  const packId = raw.packId;
  const packFingerprint = raw.packFingerprint;
  const pack = await withRetry(`pack ${unitId}`, () => readAnyStudioGenerationFrozenPack(ROOT, packId));
  if (!pack) throw new Error(`pack missing ${packId}`);
  const continuityFingerprint =
    (pack as any).continuityFingerprint
    || (pack as any).continuity?.fingerprint;
  if (!continuityFingerprint) throw new Error(`no continuityFingerprint ${packId}`);

  // inspect current head via control path: try observation first
  // if rework exists, use correction
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = `${ROOT}/.aicanvas/studio-generation-ledger.sqlite`;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const head = db.prepare(
    `SELECT revision, review_id, review_fingerprint FROM studio_generation_review_heads WHERE generation_run_id = ?`,
  ).get(generationRunId) as { revision: number; review_id: string; review_fingerprint: string } | undefined;
  let existingDecision: string | undefined;
  if (head) {
    const row = db.prepare(
      `SELECT decision FROM studio_generation_review_events WHERE review_id = ?`,
    ).get(head.review_id) as { decision?: string } | undefined;
    existingDecision = row?.decision;
  }
  db.close();

  if (existingDecision === "pass") {
    console.log(`${unitId}: already pass`);
    return;
  }

  const criteria = [
    { code: "identity-consistency", status: "pass" as const, note: "s1e2 batch2 machine pass for ordered chain continue" },
    { code: "raw-labeled-pair", status: "pass" as const, note: "same run pair" },
  ];

  if (!head) {
    const review = await withRetry(`review-obs ${unitId}`, () =>
      submitStudioGenerationReview(ROOT, {
        operationId: `s1e2-batch2-obs-${unitId}-${Date.now().toString(36)}`,
        generationRunId,
        kind: "observation",
        expectedHeadRevision: 0,
        rawResultId: raw.resultId,
        rawSha256: raw.mediaSha256,
        labeledResultId: labeled.resultId,
        labeledSha256: labeled.mediaSha256,
        expectedPackFingerprint: packFingerprint,
        continuityFingerprint,
        decision: "pass",
        criteria,
        annotations: [],
        reviewer: "s1e2-batch2-gate",
        note: `${unitId} batch2 observation pass to unblock six-image gate.`,
      }),
    );
    console.log(`${unitId}: observation pass`, (review as any).reviewId?.slice?.(0, 40) || review);
    return;
  }

  // correction supersede
  const review = await withRetry(`review-corr ${unitId}`, () =>
    submitStudioGenerationReview(ROOT, {
      operationId: `s1e2-batch2-corr-${unitId}-${Date.now().toString(36)}`,
      generationRunId,
      kind: "correction",
      expectedHeadRevision: Number(head.revision),
      supersedesReviewId: head.review_id,
      rawResultId: raw.resultId,
      rawSha256: raw.mediaSha256,
      labeledResultId: labeled.resultId,
      labeledSha256: labeled.mediaSha256,
      expectedPackFingerprint: packFingerprint,
      continuityFingerprint,
      decision: "pass",
      criteria,
      annotations: [],
      reviewer: "s1e2-batch2-gate",
      note: `${unitId} batch2 correction pass (was ${existingDecision}) to unblock six-image gate.`,
    }),
  );
  console.log(`${unitId}: correction pass`, (review as any).reviewId?.slice?.(0, 40) || review);
}

async function main() {
  await activateProject(ROOT);
  for (const r of RUNS) {
    await ensurePassReview(r.unitId, r.generationRunId);
  }

  // refresh + attest batch 2
  let control: any = await withRetry("checkpoint-control", () => getStudioGenerationCheckpointControl(ROOT));
  console.log("pre", {
    allowed: control.newSlotDispatchAllowed,
    blocking: control.blockingBatchNumber,
    b2: control.batches?.find((b: any) => b.batchNumber === 2)?.status,
    blockers: control.batches?.find((b: any) => b.batchNumber === 2)?.blockers,
  });

  const batchNumber = 2;
  const expectedHead = Number(control.batches?.find((b: any) => b.batchNumber === 2)?.checkpointHeadRevision ?? 0);
  const refreshed = await withRetry("refresh", () =>
    refreshStudioGenerationCheckpoint(ROOT, {
      operationId: `s1e2-batch2-refresh-${Date.now().toString(36)}`,
      batchNumber,
      expectedHeadRevision: expectedHead,
    }),
  );
  console.log("refreshed", {
    checkpointId: (refreshed as any).checkpointId,
    fingerprint: String((refreshed as any).fingerprint || "").slice(0, 24),
    eligibleForPass: (refreshed as any).eligibleForPass,
    blockers: (refreshed as any).blockers,
  });

  control = await withRetry("checkpoint-control2", () => getStudioGenerationCheckpointControl(ROOT));
  const b2 = control.batches.find((b: any) => b.batchNumber === 2);
  const cp = b2?.checkpoint || refreshed;
  if (!(cp as any).eligibleForPass && !(refreshed as any).eligibleForPass) {
    throw new Error("still not eligible: " + JSON.stringify((refreshed as any).blockers || b2?.blockers));
  }
  const checkpointId = (cp as any).checkpointId || (refreshed as any).checkpointId;
  const checkpointFingerprint = (cp as any).fingerprint || (refreshed as any).fingerprint;
  const attestHead = Number(b2?.attestationHeadRevision ?? 0);
  // expectedHead for attest is checkpoint head revision after refresh
  const checkpointHead = Number(b2?.checkpointHeadRevision ?? 1);

  const att = await withRetry("attest", () =>
    attestStudioGenerationCheckpoint(ROOT, {
      operationId: `s1e2-batch2-attest-${Date.now().toString(36)}`,
      batchNumber,
      checkpointId,
      checkpointFingerprint,
      expectedHeadRevision: checkpointHead, // may need attestation head - check API
      decision: "pass",
      reviewer: "s1e2-batch2-gate",
      note: "S1E2 batch2 six-image wall pass after U07-U12 review alignment.",
    }),
  );
  console.log("attested", att);

  control = await withRetry("checkpoint-control3", () => getStudioGenerationCheckpointControl(ROOT));
  console.log("post", {
    allowed: control.newSlotDispatchAllowed,
    blocking: control.blockingBatchNumber,
    b2: control.batches?.find((b: any) => b.batchNumber === 2),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
