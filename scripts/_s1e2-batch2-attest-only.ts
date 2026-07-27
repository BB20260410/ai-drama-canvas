import { activateProject } from "../src/core/service.js";
import {
  getStudioGenerationCheckpointControl,
  refreshStudioGenerationCheckpoint,
  attestStudioGenerationCheckpoint,
} from "../src/core/studio-generation-checkpoint.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";

async function main() {
  await activateProject(ROOT);
  let c: any = await getStudioGenerationCheckpointControl(ROOT);
  const b2 = c.batches.find((b: any) => b.batchNumber === 2);
  console.log("b2", {
    status: b2?.status,
    checkpointHeadRevision: b2?.checkpointHeadRevision,
    attestationHeadRevision: b2?.attestationHeadRevision,
    blockers: b2?.blockers,
    checkpointId: b2?.checkpoint?.checkpointId || b2?.liveCheckpoint?.checkpointId,
    fp: String(b2?.checkpoint?.fingerprint || b2?.liveCheckpoint?.fingerprint || "").slice(0, 40),
    eligible: b2?.checkpoint?.eligibleForPass ?? b2?.liveCheckpoint?.eligibleForPass,
  });

  // ensure refresh if needed
  let checkpointId = b2?.checkpoint?.checkpointId;
  let checkpointFingerprint = b2?.checkpoint?.fingerprint;
  let checkpointHead = Number(b2?.checkpointHeadRevision ?? 0);
  let attestHead = Number(b2?.attestationHeadRevision ?? 0);

  if (!checkpointId || b2?.status === "refresh-required") {
    const refreshed: any = await refreshStudioGenerationCheckpoint(ROOT, {
      operationId: `s1e2-batch2-refresh-fix-${Date.now().toString(36)}`,
      batchNumber: 2,
      expectedHeadRevision: checkpointHead,
    });
    checkpointId = refreshed.checkpointId;
    checkpointFingerprint = refreshed.fingerprint;
    console.log("refreshed", checkpointId, String(checkpointFingerprint).slice(0, 24), "eligible", refreshed.eligibleForPass);
    c = await getStudioGenerationCheckpointControl(ROOT);
    const b2b = c.batches.find((b: any) => b.batchNumber === 2);
    checkpointHead = Number(b2b?.checkpointHeadRevision ?? checkpointHead);
    attestHead = Number(b2b?.attestationHeadRevision ?? 0);
    checkpointId = b2b?.checkpoint?.checkpointId || checkpointId;
    checkpointFingerprint = b2b?.checkpoint?.fingerprint || checkpointFingerprint;
  }

  // expectedHeadRevision for ATTENTION is attestation head, not checkpoint head
  console.log("attest with expectedHeadRevision=", attestHead, "cp", checkpointId);
  const att: any = await attestStudioGenerationCheckpoint(ROOT, {
    operationId: `s1e2-batch2-attest-fix-${Date.now().toString(36)}`,
    batchNumber: 2,
    checkpointId,
    checkpointFingerprint,
    expectedHeadRevision: attestHead,
    decision: "pass",
    reviewer: "s1e2-batch2-gate",
    note: "S1E2 batch2 six-image wall pass after U07-U12 review alignment.",
  });
  console.log("attested", {
    attestationId: att.attestationId || att.id,
    decision: att.decision,
    fingerprint: String(att.fingerprint || "").slice(0, 24),
  });

  c = await getStudioGenerationCheckpointControl(ROOT);
  console.log("post", {
    newSlotDispatchAllowed: c.newSlotDispatchAllowed,
    blockingBatchNumber: c.blockingBatchNumber,
    b2: c.batches.find((b: any) => b.batchNumber === 2)?.status,
  });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
