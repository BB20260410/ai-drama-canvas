import { activateProject } from "../src/core/service.js";
import { getStudioGenerationCheckpointControl } from "../src/core/studio-generation-checkpoint.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
async function main() {
  await activateProject(ROOT);
  const c = await getStudioGenerationCheckpointControl(ROOT);
  console.log(JSON.stringify({
    newSlotDispatchAllowed: c.newSlotDispatchAllowed,
    blockingBatchNumber: (c as any).blockingBatchNumber,
    checkpointHeadRevision: (c as any).checkpointHeadRevision,
    attestationHeadRevision: (c as any).attestationHeadRevision,
    status: (c as any).status,
    keys: Object.keys(c),
    checkpoint: (c as any).checkpoint ? {
      checkpointId: (c as any).checkpoint.checkpointId,
      batchNumber: (c as any).checkpoint.batchNumber,
      status: (c as any).checkpoint.status,
      fingerprint: String((c as any).checkpoint.fingerprint || "").slice(0, 20),
      slots: ((c as any).checkpoint.slots || (c as any).checkpoint.members || []).length,
    } : null,
    attestation: (c as any).attestation ? {
      attestationId: (c as any).attestation.attestationId,
      verdict: (c as any).attestation.verdict || (c as any).attestation.status,
    } : null,
    rawSnippet: JSON.stringify(c).slice(0, 3500),
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
