import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { activateProject } from "../src/core/service.js";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import {
  prepareStudioImagegenCall,
  freezeAndPersistStudioUnitGridGenerationPack,
  dispatchStudioGenerationPack,
  readAnyStudioGenerationFrozenPack,
} from "../src/core/studio-generation-ledger.js";
import { getStudioMedia } from "../src/core/material-studio.js";
import { getStudioGenerationControlEnvelope } from "../src/core/codex.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const SCRATCH = path.join(
  "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723/05_canvas/_scratch"
);
const PROD = "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723";
const STATE = path.join(SCRATCH, "s1e2-u11-ordered-state.json");
const LOG = path.join(SCRATCH, "s1e2-u11-prepare-retry.log");

function log(m: string) {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(LOG, (existsSync(LOG) ? readFileSync(LOG, "utf8") : "") + line + "\n");
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function resolveControlLocalPaths(packId: string) {
  const pack = await readAnyStudioGenerationFrozenPack(ROOT, packId);
  if (!pack) throw new Error("pack missing");
  const refs = (pack as any).request?.controlReferences ?? (pack as any).controlReferences ?? [];
  const out: Array<{ assetId?: string; mediaSha256: string; localPath: string }> = [];
  for (const ref of refs) {
    const media = await getStudioMedia(ROOT, ref.mediaSha256);
    if (!media) throw new Error(`media missing ${ref.mediaSha256}`);
    const alt = (media as any).objectPath;
    if (alt && existsSync(alt)) {
      out.push({ assetId: ref.assetId, mediaSha256: ref.mediaSha256, localPath: alt });
      continue;
    }
    const localPath = path.join(ROOT, ".aicanvas/objects/sha256", ref.mediaSha256.slice(0, 2), ref.mediaSha256);
    if (!existsSync(localPath)) throw new Error(`CAS missing ${ref.mediaSha256}`);
    out.push({ assetId: ref.assetId, mediaSha256: ref.mediaSha256, localPath });
  }
  return out;
}

async function withRetry<T>(label: string, fn: () => Promise<T>, max = 12): Promise<T> {
  let last: any;
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      const msg = e?.message || String(e);
      const details = JSON.stringify(e?.details || e?.cause?.details || []);
      const race =
        msg.includes("snapshot") ||
        msg.includes("冻结验证") ||
        details.includes("snapshot") ||
        details.includes("隔离快照");
      log(`${label} fail ${i}: ${msg.slice(0, 120)} race=${race}`);
      if (!race && i >= 2) throw e;
      await sleep(800 * Math.pow(1.45, i) + Math.random() * 400);
    }
  }
  throw last;
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  await activateProject(ROOT);

  // warm readiness with retries (checkpoint can race)
  await withRetry("readiness", async () => {
    const r = await getStudioGenerationControlEnvelope(ROOT, {
      operation: "readiness",
      targetKind: "unit-grid",
      unitId: "S1E2-U11",
    });
    if ((r as any).status === "blocked") throw new Error("readiness blocked: " + JSON.stringify(r).slice(0, 400));
    log(`readiness ${(r as any).status}`);
    return r;
  });

  const freeze = await withRetry("freeze", () =>
    freezeAndPersistStudioUnitGridGenerationPack(ROOT, {
      targetKind: "unit-grid",
      unitId: "S1E2-U11",
    }),
  );
  const packId = (freeze as any).pack?.id ?? (freeze as any).id;
  const packFingerprint = (freeze as any).pack?.fingerprint ?? (freeze as any).fingerprint;
  const unitRevision = (freeze as any).pack?.target?.unitRevision ?? 1;
  log(`FREEZE_OK ${packId}`);

  const controlRefs = await resolveControlLocalPaths(packId);
  log(`CONTROL_REFS ${controlRefs.length}`);

  const runId = `s1e2-u11-ug-grok-${Date.now().toString(36)}`;
  await withRetry("dispatch", () =>
    dispatchStudioGenerationPack(ROOT, {
      packId,
      packFingerprint,
      generationRunId: runId,
      provider: "grok",
    }),
  );
  log(`DISPATCH_OK ${runId}`);

  // pause to let any concurrent writers settle
  await sleep(1500);

  let ctx = await getActiveManagedStudioContext();
  const prepared = await withRetry("prepare", async () => {
    ctx = await getActiveManagedStudioContext();
    return prepareStudioImagegenCall(ROOT, {
      packId,
      packFingerprint,
      generationRunId: runId,
      provider: "grok",
      projectContextToken: ctx.projectContextToken,
      commandRequestId: `u11-prep-${Date.now().toString(36)}`,
      expectedRevision: 0,
    });
  }, 16);

  log(`PREPARE_OK ${prepared.callId}`);
  const state = {
    preparedAt: new Date().toISOString(),
    projectRoot: ROOT,
    projectContextToken: ctx.projectContextToken,
    unitId: "S1E2-U11",
    packId,
    packFingerprint,
    unitRevision,
    generationRunId: runId,
    callId: prepared.callId,
    inputFingerprint: prepared.inputFingerprint,
    quarantine: prepared.quarantine,
    controlRefs,
    candidateOut: path.join(PROD, "02_candidates/S1E2-U11_4格_A1_CANDIDATE.jpg"),
    reportOut: path.join(PROD, "05_canvas/s1e2-u11-symbiosis-report.json"),
  };
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ ok: true, statePath: STATE, callId: prepared.callId, controlRefs }, null, 2));
}

main().catch((e) => {
  log(`FATAL ${e?.stack || e}`);
  process.exit(1);
});
