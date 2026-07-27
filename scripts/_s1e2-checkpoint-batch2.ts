import { activateProject } from "../src/core/service.js";
import { getStudioGenerationCheckpointControl } from "../src/core/studio-generation-checkpoint.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
async function main() {
  await activateProject(ROOT);
  const c: any = await getStudioGenerationCheckpointControl(ROOT);
  const batches = c.batches || [];
  for (const b of batches) {
    console.log("\nBATCH", b.batchNumber, "status", b.status, "blockers", b.blockers);
    console.log("heads", b.checkpointHeadRevision, b.attestationHeadRevision);
    const live = b.liveCheckpoint;
    if (live?.members) {
      for (const m of live.members) {
        console.log({
          slot: m.slotOrdinal,
          unitId: m.unitId,
          reviewDecision: m.reviewDecision,
          reviewCurrent: m.reviewCurrent,
          reviewStaleReasons: m.reviewStaleReasons,
          run: m.generationRunId,
        });
      }
      console.log("liveCheckpointId", live.checkpointId || live.id, "fp", String(live.fingerprint||"").slice(0,24));
      console.log("live keys", Object.keys(live));
    }
  }
  console.log("\nnewSlotDispatchAllowed", c.newSlotDispatchAllowed, "blocking", c.blockingBatchNumber);
}
main().catch((e)=>{console.error(e); process.exit(1);});
