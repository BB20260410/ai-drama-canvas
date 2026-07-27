import { activateProject } from "../src/core/service.js";
import { getStudioGenerationCheckpointControl } from "../src/core/studio-generation-checkpoint.js";
const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
await activateProject(ROOT);
const c = await getStudioGenerationCheckpointControl(ROOT);
console.log(JSON.stringify({ allowed: c.newSlotDispatchAllowed, blocking: c.blockingBatchNumber }));
