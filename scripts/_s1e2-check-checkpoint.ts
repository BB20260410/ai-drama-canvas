import { activateProject } from "../src/core/service.js";
import { getStudioGenerationControlEnvelope } from "../src/core/codex.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";

function pick(obj: any, depth = 0): any {
  if (!obj || typeof obj !== "object" || depth > 4) return obj;
  if (Array.isArray(obj)) return obj.slice(0, 3).map((x) => pick(x, depth + 1));
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/slot|dispatch|allowed|attest|batch|status|blocked|checkpoint|count|wall|review|eligible|gate/i.test(k)) {
      out[k] = pick(v, depth + 1);
    }
  }
  return out;
}

async function main() {
  await activateProject(ROOT);
  for (const op of ["checkpoint", "readiness"] as const) {
    try {
      const env = await getStudioGenerationControlEnvelope(ROOT, {
        operation: op,
        targetKind: "unit-grid",
        unitId: "S1E2-U13",
      } as any);
      console.log("\n===", op, "===");
      console.log(JSON.stringify({ topKeys: Object.keys(env as any), picked: pick(env) }, null, 2).slice(0, 5000));
      // also dump status path
      const s = JSON.stringify(env);
      const m = s.match(/newSlotDispatchAllowed[^,]{0,40}/g);
      console.log("matches", m);
      console.log("status snippet", s.slice(0, 2500));
    } catch (e: any) {
      console.log(op, "ERR", e?.message?.slice(0, 500));
      if (e?.details) console.log("details", JSON.stringify(e.details).slice(0, 800));
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
