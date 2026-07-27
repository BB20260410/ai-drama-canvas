import { activateProject } from "../src/core/service.js";
import { getStudioGenerationCheckpointControl } from "../src/core/studio-generation-checkpoint.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
async function main() {
  await activateProject(ROOT);
  const c: any = await getStudioGenerationCheckpointControl(ROOT);
  const b2 = c.batches.find((b: any) => b.batchNumber === 2);
  console.log(JSON.stringify({
    status: b2?.status,
    blockers: b2?.blockers,
    slotOrdinals: b2?.slotOrdinals,
    keys: b2 ? Object.keys(b2) : [],
    live: b2?.liveCheckpoint,
    // any candidate members?
    collecting: b2?.collectingMembers || b2?.members || b2?.slots,
    raw: (() => {
      const copy = { ...b2 };
      // trim huge if needed
      return copy;
    })(),
  }, null, 2).slice(0, 8000));
}
main().catch((e)=>{console.error(e);process.exit(1);});
