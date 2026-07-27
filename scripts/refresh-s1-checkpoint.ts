import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";

const PROJECT = "/Users/hxx/Documents/无限画布/projects/codex-ai-drama-studio";
const OUT = path.join(PROJECT, ".aicanvas", "package-register-out");
const TAG = "s1-pkg-register-v2";

async function main() {
  await mkdir(OUT, { recursive: true });
  const unit = await getStudioProductionDashboard(PROJECT, {
    operation: "unit",
    unitId: "unit-ep01_15s_001",
  });
  console.log("before", unit.nextAction);

  // refresh_studio_generation_checkpoint payload from core
  const r = await executeIdempotentCommand(PROJECT, {
    requestId: `${TAG}:refresh-checkpoint:ep01-001`,
    idempotencyKey: `${TAG}:refresh-checkpoint:ep01-001`,
    request: {
      command: "refresh_studio_generation_checkpoint",
      payload: {
        // try common shapes - will fix if rejected
        unitId: "unit-ep01_15s_001",
        panelId: "panel-01",
      },
    } as any,
  });
  await writeFile(path.join(OUT, "checkpoint-refresh-ep01-001.json"), JSON.stringify(r, null, 2));
  const after = await getStudioProductionDashboard(PROJECT, {
    operation: "unit",
    unitId: "unit-ep01_15s_001",
  });
  console.log(JSON.stringify({
    refreshStatus: r.status,
    error: r.error,
    result: r.result,
    afterNext: after.nextAction,
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
