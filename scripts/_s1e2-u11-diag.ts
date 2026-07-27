import { activateProject } from "../src/core/service.js";
import { getStudioGenerationControlEnvelope } from "../src/core/codex.js";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import {
  prepareStudioImagegenCall,
  freezeAndPersistStudioUnitGridGenerationPack,
  dispatchStudioGenerationPack,
} from "../src/core/studio-generation-ledger.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";

async function main() {
  await activateProject(ROOT);
  const ctx = await getActiveManagedStudioContext();
  console.log("token", ctx.projectContextToken?.slice(0, 24));

  for (const op of ["readiness", "checkpoint"] as const) {
    try {
      const env = await getStudioGenerationControlEnvelope(ROOT, {
        operation: op,
        targetKind: "unit-grid",
        unitId: "S1E2-U11",
      });
      console.log("\n===", op, "===");
      const s = JSON.stringify(env, null, 2);
      console.log(s.length > 6000 ? s.slice(0, 6000) + "\n...trunc" : s);
    } catch (e: any) {
      console.log("\n===", op, "ERR ===");
      console.log(String(e?.message || e).slice(0, 2000));
      if (e?.details) console.log("details", JSON.stringify(e.details, null, 2).slice(0, 3000));
      if (e?.code) console.log("code", e.code);
      let c = e?.cause;
      let i = 0;
      while (c && i < 4) {
        console.log("cause"+i, c?.message?.slice?.(0, 1000) || String(c).slice(0, 1000));
        if (c?.details) console.log("cause details", JSON.stringify(c.details).slice(0, 1500));
        c = c?.cause;
        i++;
      }
    }
  }

  try {
    const freeze = await freezeAndPersistStudioUnitGridGenerationPack(ROOT, {
      targetKind: "unit-grid",
      unitId: "S1E2-U11",
    });
    const packId = (freeze as any).pack?.id ?? (freeze as any).id;
    const packFingerprint = (freeze as any).pack?.fingerprint ?? (freeze as any).fingerprint;
    console.log("\nFREEZE", packId, String(packFingerprint).slice(0, 20));

    const runId = `s1e2-u11-ug-grok-${Date.now().toString(36)}`;
    try {
      await dispatchStudioGenerationPack(ROOT, {
        packId,
        packFingerprint,
        generationRunId: runId,
        provider: "grok",
      });
      console.log("DISPATCH_OK", runId);
    } catch (e: any) {
      console.log("DISPATCH_ERR", e.message?.slice(0, 1000));
      if (e.details) console.log(JSON.stringify(e.details).slice(0, 2000));
      if (e.code) console.log("code", e.code);
    }

    try {
      const prepared = await prepareStudioImagegenCall(ROOT, {
        packId,
        packFingerprint,
        generationRunId: runId,
        provider: "grok",
        projectContextToken: ctx.projectContextToken,
        commandRequestId: `u11-diag-${Date.now().toString(36)}`,
        expectedRevision: 0,
      });
      console.log("PREPARE_OK", prepared.callId);
      console.log(JSON.stringify({ candidate: prepared.quarantine?.candidatePath, fp: prepared.inputFingerprint }, null, 2));
    } catch (e: any) {
      console.log("PREPARE_ERR", e?.name, e?.message?.slice(0, 1500));
      if (e?.code) console.log("code", e.code);
      if (e?.details) console.log("details", JSON.stringify(e.details, null, 2).slice(0, 3000));
      let c = e?.cause;
      let i = 0;
      while (c && i < 5) {
        console.log("cause"+i, c?.name, c?.message?.slice?.(0, 1200) || String(c).slice(0, 1200));
        if (c?.details) console.log("cdetails", JSON.stringify(c.details).slice(0, 2000));
        if (c?.code) console.log("ccode", c.code);
        c = c?.cause;
        i++;
      }
      if (e?.stack) console.log(e.stack.split("\n").slice(0, 25).join("\n"));
    }
  } catch (e: any) {
    console.log("outer", e?.message?.slice(0, 1500));
    if (e?.details) console.log(JSON.stringify(e.details).slice(0, 2000));
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
