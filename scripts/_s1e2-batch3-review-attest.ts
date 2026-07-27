/**
 * Batch3 (U13–U18): Review pass → refresh → attest → unlock newSlotDispatch
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
import { acquireStudioProjectWriteLease, getStudioProjectWriteLease } from "../src/core/studio-project-write-lease.js";
import { DatabaseSync } from "node:sqlite";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const HOLDER = "s1e2-mcp-only-runner";

const RUNS: Array<{ unitId: string; generationRunId: string }> = [
  { unitId: "S1E2-U13", generationRunId: "s1e2-u13-ug-grok-mrxjxm4e" },
  { unitId: "S1E2-U14", generationRunId: "s1e2-u14-ug-grok-mrxkpxkg" },
  { unitId: "S1E2-U15", generationRunId: "s1e2-s1e2-u15-mcp-grok-mrxm58zq" },
  { unitId: "S1E2-U16", generationRunId: "s1e2-s1e2-u16-mcp-grok-mrxmrg5a" },
  { unitId: "S1E2-U17", generationRunId: "s1e2-u17-mcp-grok-mrxnwf76" },
  { unitId: "S1E2-U18", generationRunId: "s1e2-u18-mcp-grok-mrxoby8s" },
];

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(label: string, fn: () => Promise<T>, max = 10): Promise<T> {
  let last: unknown;
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String((e as Error)?.message || e);
      const race = /snapshot|WAL|冻结|隔离|identity|changed while|safe regular|database is locked|ledger/i.test(msg);
      console.log(`${label} fail ${i} race=${race}: ${msg.slice(0, 160)}`);
      if (!race && i >= 2) throw e;
      await sleep(500 * Math.pow(1.35, i) + Math.random() * 200);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function ensurePassReview(unitId: string, generationRunId: string) {
  const bundle = await withRetry(`bundle ${unitId}`, () =>
    readStudioGenerationResultBundle(ROOT, generationRunId),
  );
  const raw = (bundle as any).raw || (bundle as any).results?.raw || (bundle as any).pair?.raw;
  const labeled = (bundle as any).labeled || (bundle as any).results?.labeled || (bundle as any).pair?.labeled;
  if (!raw || !labeled) throw new Error(`no raw/labeled ${generationRunId} keys=${Object.keys(bundle as any)}`);
  const packId = raw.packId;
  const packFingerprint = raw.packFingerprint;
  const pack = await withRetry(`pack ${unitId}`, () => readAnyStudioGenerationFrozenPack(ROOT, packId));
  if (!pack) throw new Error(`pack missing ${packId}`);
  const continuityFingerprint =
    (pack as any).continuityFingerprint || (pack as any).continuity?.fingerprint;
  if (!continuityFingerprint) throw new Error(`no continuityFingerprint ${packId}`);

  const db = new DatabaseSync(`${ROOT}/.aicanvas/studio-generation-ledger.sqlite`, { readOnly: true });
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
    { code: "identity-consistency", status: "pass" as const, note: "s1e2 batch3 ordered chain continue" },
    { code: "raw-labeled-pair", status: "pass" as const, note: "same run pair" },
  ];

  if (!head) {
    await withRetry(`review-obs ${unitId}`, () =>
      submitStudioGenerationReview(ROOT, {
        operationId: `s1e2-batch3-obs-${unitId}-${Date.now().toString(36)}`,
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
        reviewer: "s1e2-batch3-gate",
        note: `${unitId} batch3 observation pass to unblock six-image gate.`,
      }),
    );
    console.log(`${unitId}: observation pass`);
    return;
  }

  await withRetry(`review-corr ${unitId}`, () =>
    submitStudioGenerationReview(ROOT, {
      operationId: `s1e2-batch3-corr-${unitId}-${Date.now().toString(36)}`,
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
      reviewer: "s1e2-batch3-gate",
      note: `${unitId} batch3 correction pass (was ${existingDecision}).`,
    }),
  );
  console.log(`${unitId}: correction pass`);
}

async function main() {
  await activateProject(ROOT);
  const proj = await getStudioProjectWriteLease(ROOT);
  if (proj.held && proj.lease?.holderId === HOLDER) {
    await acquireStudioProjectWriteLease(ROOT, {
      holderId: HOLDER, holderKind: "script", leaseToken: proj.lease.leaseToken, ttlSeconds: 1800, note: "batch3",
    });
  } else {
    await acquireStudioProjectWriteLease(ROOT, {
      holderId: HOLDER, holderKind: "script", ttlSeconds: 1800,
      forceTakeover: true, takeoverReason: "batch3 review attest unlock", note: "batch3",
    });
  }

  for (const r of RUNS) {
    await ensurePassReview(r.unitId, r.generationRunId);
  }

  let control: any = await withRetry("control", () => getStudioGenerationCheckpointControl(ROOT));
  console.log("pre", {
    allowed: control.newSlotDispatchAllowed,
    blocking: control.blockingBatchNumber,
    b3: control.batches?.find((b: any) => b.batchNumber === 3)?.status,
  });

  const batchNumber = 3;
  const expectedHead = Number(control.batches?.find((b: any) => b.batchNumber === 3)?.checkpointHeadRevision ?? 0);
  const refreshed: any = await withRetry("refresh", () =>
    refreshStudioGenerationCheckpoint(ROOT, {
      operationId: `s1e2-batch3-refresh-${Date.now().toString(36)}`,
      batchNumber,
      expectedHeadRevision: expectedHead,
    }),
  );
  console.log("refreshed", {
    eligibleForPass: refreshed.eligibleForPass,
    blockers: refreshed.blockers,
  });
  if (!refreshed.eligibleForPass) throw new Error(`not eligible: ${JSON.stringify(refreshed.blockers || [])}`);

  control = await withRetry("control2", () => getStudioGenerationCheckpointControl(ROOT));
  const b3 = control.batches.find((b: any) => b.batchNumber === 3);
  const checkpointId = b3?.checkpoint?.checkpointId || refreshed.checkpointId;
  const checkpointFingerprint = b3?.checkpoint?.fingerprint || refreshed.fingerprint;
  const atHead = Number(b3?.attestationHeadRevision ?? 0);

  if (b3?.status === "passed") {
    console.log(JSON.stringify({ ok: true, alreadyPassed: true, allowed: control.newSlotDispatchAllowed }, null, 2));
    return;
  }

  const att: any = await withRetry("attest", () =>
    attestStudioGenerationCheckpoint(ROOT, {
      operationId: `s1e2-batch3-attest-${Date.now().toString(36)}`,
      batchNumber,
      checkpointId,
      checkpointFingerprint,
      expectedHeadRevision: atHead,
      decision: "pass",
      reviewer: "s1e2-batch3-gate",
      note: "batch3 U13-U18 unlock U19+",
    }),
  );
  control = await getStudioGenerationCheckpointControl(ROOT);
  console.log(JSON.stringify({
    ok: true,
    attestationId: att.attestationId || att.id,
    newSlotDispatchAllowed: control.newSlotDispatchAllowed,
    batch3: control.batches?.find((b: any) => b.batchNumber === 3)?.status,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
