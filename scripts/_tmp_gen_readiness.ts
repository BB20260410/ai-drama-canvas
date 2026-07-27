import { writeFileSync } from "node:fs";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";
import { getStudioGenerationControlEnvelope } from "../src/core/codex.js";

const root = "/Users/hxx/Documents/无限画布/projects/codex-ai-drama-studio";

async function main() {
  for (const unitId of ["unit-ep01_15s_001", "unit-ep01_15s_002"]) {
    const unit = await getStudioProductionDashboard(root, { operation: "unit", unitId });
    console.log(unitId, JSON.stringify(unit.nextAction, null, 2));
  }
  // try generation control variants
  const ops = [
    { operation: "readiness", unitId: "unit-ep01_15s_001", panelId: "panel-01" },
    { operation: "pack", packId: "studio-generation-freeze-8213c56851a96386181097b3c0f78841" },
  ];
  for (const q of ops) {
    try {
      const r = await getStudioGenerationControlEnvelope(root, q as any);
      writeFileSync(`/tmp/gen-ctrl-${q.operation}.json`, JSON.stringify(r, null, 2));
      console.log("OK", q.operation, Object.keys(r as any), (r as any).nextAction ?? (r as any).packId);
    } catch (e: any) {
      console.log("FAIL", q.operation, e.message?.slice(0, 200));
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
