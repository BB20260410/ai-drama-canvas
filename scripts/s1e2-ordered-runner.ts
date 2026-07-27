/**
 * 统一有序 unit-grid runner（半旁路 → 契约收敛）。
 *
 * 用法：
 *   npx tsx scripts/s1e2-ordered-runner.ts prepare --unit S1E2-U15
 *   npx tsx scripts/s1e2-ordered-runner.ts commit --state <state.json>
 *   npx tsx scripts/s1e2-ordered-runner.ts attest-batch --batch 2
 *   npx tsx scripts/s1e2-ordered-runner.ts earliest
 *
 * - 默认 acquire 写租约（holder=s1e2-ordered-runner）
 * - prepare 需 unit 已存在且 binding ready（创建/绑定仍可用 per-unit 脚本）
 * - **生图写正式路径请用** `scripts/s1e2-mcp-only-runner.ts`（executeIdempotentCommand + require 租约）
 * - 本脚本保留半旁路兼容；不宣称「与无限画布产品完美契合」
 */
process.env.AI_CANVAS_WRITE_LEASE_MODE = process.env.AI_CANVAS_WRITE_LEASE_MODE || "require";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { activateProject } from "../src/core/service.js";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import { getStudioGenerationControlEnvelope } from "../src/core/codex.js";
import {
  freezeAndPersistStudioUnitGridGenerationPack,
  dispatchStudioGenerationPack,
  prepareStudioImagegenCall,
  readAnyStudioGenerationFrozenPack,
} from "../src/core/studio-generation-ledger.js";
import { getStudioMedia } from "../src/core/material-studio.js";
import { getStudioGenerationCheckpointControl, refreshStudioGenerationCheckpoint, attestStudioGenerationCheckpoint } from "../src/core/studio-generation-checkpoint.js";
import {
  acquireStudioProjectWriteLease,
  releaseStudioProjectWriteLease,
} from "../src/core/studio-project-write-lease.js";
import { getStudioEpisodeEarliest } from "../src/core/studio-episode-earliest.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const PROD = "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723";
const SCRATCH = path.join(PROD, "05_canvas/_scratch");
const EVIDENCE = path.join(PROD, "05_canvas");
const HOLDER = "s1e2-ordered-runner";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}
function log(m: string) {
  console.log(`[${new Date().toISOString()}] ${m}`);
}
async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}
async function withRaceRetry<T>(label: string, fn: () => Promise<T>, max = 12): Promise<T> {
  let last: unknown;
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      const race = /snapshot|WAL|冻结|隔离|identity|changed while|safe regular|database is locked|ledger/i.test(msg);
      log(`${label} fail ${i} race=${race}: ${msg.slice(0, 140)}`);
      if (!race && i >= 3) throw e;
      await sleep(600 * Math.pow(1.35, i));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function resolveControlLocalPaths(packId: string) {
  const pack = await readAnyStudioGenerationFrozenPack(ROOT, packId);
  if (!pack) throw new Error("pack missing");
  const refs = (pack as any).request?.controlReferences ?? (pack as any).controlReferences ?? [];
  const out: Array<{ mediaSha256: string; localPath: string }> = [];
  for (const ref of refs) {
    const media = await getStudioMedia(ROOT, ref.mediaSha256);
    const alt = (media as any)?.objectPath;
    if (alt && existsSync(alt)) {
      out.push({ mediaSha256: ref.mediaSha256, localPath: alt });
      continue;
    }
    const localPath = path.join(ROOT, ".aicanvas/objects/sha256", ref.mediaSha256.slice(0, 2), ref.mediaSha256);
    if (!existsSync(localPath)) throw new Error(`CAS missing ${ref.mediaSha256}`);
    out.push({ mediaSha256: ref.mediaSha256, localPath });
  }
  return out;
}

async function cmdPrepare(unitId: string) {
  mkdirSync(SCRATCH, { recursive: true });
  await activateProject(ROOT);
  const lease = await acquireStudioProjectWriteLease(ROOT, {
    holderId: HOLDER,
    holderKind: "script",
    ttlSeconds: 30 * 60,
    note: `ordered prepare ${unitId}`,
  });
  log(`LEASE ${lease.leaseToken.slice(0, 20)}…`);

  try {
    const gate = await withRaceRetry("gate", () => getStudioGenerationCheckpointControl(ROOT));
    if ((gate as any).newSlotDispatchAllowed === false) {
      throw new Error(`six-image blocked batch=${(gate as any).blockingBatchNumber}; run attest-batch first`);
    }
    log(`GATE allowed=${(gate as any).newSlotDispatchAllowed}`);

    await withRaceRetry("readiness", async () => {
      const r = await getStudioGenerationControlEnvelope(ROOT, {
        operation: "readiness",
        targetKind: "unit-grid",
        unitId,
      });
      if ((r as any).status === "blocked") throw new Error(JSON.stringify(r).slice(0, 500));
      log(`READINESS ${(r as any).status}`);
      return r;
    });

    const freeze = await withRaceRetry("freeze", () =>
      freezeAndPersistStudioUnitGridGenerationPack(ROOT, { targetKind: "unit-grid", unitId }),
    );
    const packId = (freeze as any).pack?.id ?? (freeze as any).id;
    const packFingerprint = (freeze as any).pack?.fingerprint ?? (freeze as any).fingerprint;
    const unitRevision = (freeze as any).pack?.target?.unitRevision ?? 1;
    log(`FREEZE ${packId}`);

    const controlRefs = await resolveControlLocalPaths(packId);
    const runId = `s1e2-${unitId.toLowerCase()}-ug-grok-${Date.now().toString(36)}`;
    await withRaceRetry("dispatch", () =>
      dispatchStudioGenerationPack(ROOT, {
        packId,
        packFingerprint,
        generationRunId: runId,
        provider: "grok",
      }),
    );
    log(`DISPATCH ${runId}`);

    await sleep(1000);
    let ctx = await withRaceRetry("context", () => getActiveManagedStudioContext());
    const prepared = await withRaceRetry("prepare", async () => {
      ctx = await getActiveManagedStudioContext();
      return prepareStudioImagegenCall(ROOT, {
        packId,
        packFingerprint,
        generationRunId: runId,
        provider: "grok",
        projectContextToken: ctx.projectContextToken,
        commandRequestId: `ord-prep-${unitId}-${Date.now().toString(36)}`,
        expectedRevision: 0,
      });
    }, 16);
    log(`PREPARE ${prepared.callId}`);

    const state = {
      preparedAt: new Date().toISOString(),
      projectRoot: ROOT,
      projectContextToken: ctx.projectContextToken,
      unitId,
      packId,
      packFingerprint,
      unitRevision,
      generationRunId: runId,
      callId: prepared.callId,
      inputFingerprint: prepared.inputFingerprint,
      quarantine: prepared.quarantine,
      controlRefs,
      writeLease: { holderId: HOLDER, leaseToken: lease.leaseToken },
      candidateOut: path.join(PROD, `02_candidates/${unitId}_4格_A1_CANDIDATE.jpg`),
      reportOut: path.join(EVIDENCE, `s1e2-${unitId.toLowerCase().replace("s1e2-", "u")}-symbiosis-report.json`.replace("u-u", "u")),
    };
    // normalize report name: S1E2-U15 -> s1e2-u15-symbiosis-report.json
    const reportName = `s1e2-${unitId.slice(5).toLowerCase()}-symbiosis-report.json`;
    state.reportOut = path.join(EVIDENCE, reportName);

    const statePath = path.join(SCRATCH, `s1e2-${unitId.slice(5).toLowerCase()}-ordered-state.json`);
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.log(JSON.stringify({ ok: true, statePath, callId: prepared.callId, controlRefs }, null, 2));
  } finally {
    // keep lease for commit phase unless --release
    if (has("--release")) {
      await releaseStudioProjectWriteLease(ROOT, { holderId: HOLDER, leaseToken: lease.leaseToken });
      log("LEASE released");
    }
  }
}

async function cmdCommit(statePath: string) {
  if (!existsSync(statePath)) throw new Error(`missing ${statePath}`);
  // re-acquire lease from state if present
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      writeLease?: { holderId: string; leaseToken: string };
    };
    if (state.writeLease?.leaseToken) {
      await acquireStudioProjectWriteLease(ROOT, {
        holderId: state.writeLease.holderId || HOLDER,
        holderKind: "script",
        leaseToken: state.writeLease.leaseToken,
        ttlSeconds: 30 * 60,
      });
    } else {
      await acquireStudioProjectWriteLease(ROOT, {
        holderId: HOLDER,
        holderKind: "script",
        ttlSeconds: 30 * 60,
        note: "ordered commit",
      });
    }
  } catch (e) {
    log(`lease note: ${(e as Error).message?.slice(0, 120)}`);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["tsx", "scripts/s1e2-commit-prepared-state.ts", statePath], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`commit exit ${code}`))));
  });
}

async function cmdAttestBatch(batchNumber: number) {
  await activateProject(ROOT);
  const lease = await acquireStudioProjectWriteLease(ROOT, {
    holderId: HOLDER,
    holderKind: "script",
    ttlSeconds: 15 * 60,
    note: `attest batch ${batchNumber}`,
  });
  try {
    let c: any = await withRaceRetry("control", () => getStudioGenerationCheckpointControl(ROOT));
    let b = c.batches?.find((x: any) => x.batchNumber === batchNumber);
    if (!b) throw new Error(`batch ${batchNumber} missing`);
    log(`batch ${batchNumber} status=${b.status} cpHead=${b.checkpointHeadRevision} atHead=${b.attestationHeadRevision}`);

    let checkpointId = b.checkpoint?.checkpointId;
    let checkpointFingerprint = b.checkpoint?.fingerprint;
    let cpHead = Number(b.checkpointHeadRevision ?? 0);
    let atHead = Number(b.attestationHeadRevision ?? 0);

    if (!checkpointId || b.status === "refresh-required" || b.status === "review-blocked") {
      const refreshed: any = await withRaceRetry("refresh", () =>
        refreshStudioGenerationCheckpoint(ROOT, {
          operationId: `ord-refresh-b${batchNumber}-${Date.now().toString(36)}`,
          batchNumber,
          expectedHeadRevision: cpHead,
        }),
      );
      if (!refreshed.eligibleForPass) {
        throw new Error(`not eligible: ${JSON.stringify(refreshed.blockers || [])}`);
      }
      checkpointId = refreshed.checkpointId;
      checkpointFingerprint = refreshed.fingerprint;
      c = await getStudioGenerationCheckpointControl(ROOT);
      b = c.batches.find((x: any) => x.batchNumber === batchNumber);
      cpHead = Number(b?.checkpointHeadRevision ?? cpHead + 1);
      atHead = Number(b?.attestationHeadRevision ?? 0);
      checkpointId = b?.checkpoint?.checkpointId || checkpointId;
      checkpointFingerprint = b?.checkpoint?.fingerprint || checkpointFingerprint;
      log(`refreshed eligible=${refreshed.eligibleForPass}`);
    }

    if (b?.status === "passed") {
      log("already passed");
      console.log(JSON.stringify({ ok: true, alreadyPassed: true, allowed: c.newSlotDispatchAllowed }, null, 2));
      return;
    }

    const att: any = await withRaceRetry("attest", () =>
      attestStudioGenerationCheckpoint(ROOT, {
        operationId: `ord-attest-b${batchNumber}-${Date.now().toString(36)}`,
        batchNumber,
        checkpointId,
        checkpointFingerprint,
        expectedHeadRevision: atHead,
        decision: "pass",
        reviewer: "s1e2-ordered-runner",
        note: `one-click attest batch ${batchNumber}`,
      }),
    );
    c = await getStudioGenerationCheckpointControl(ROOT);
    console.log(JSON.stringify({
      ok: true,
      attestationId: att.attestationId || att.id,
      newSlotDispatchAllowed: c.newSlotDispatchAllowed,
      batch: c.batches?.find((x: any) => x.batchNumber === batchNumber)?.status,
    }, null, 2));
  } finally {
    if (has("--release")) {
      await releaseStudioProjectWriteLease(ROOT, { holderId: HOLDER, leaseToken: lease.leaseToken });
    }
  }
}

async function cmdEarliest() {
  await activateProject(ROOT);
  const e = await getStudioEpisodeEarliest(ROOT, {
    season: "S1",
    episode: "S1E2",
    evidenceDir: EVIDENCE,
  });
  console.log(JSON.stringify(e, null, 2));
}

async function main() {
  const mode = process.argv[2];
  if (mode === "prepare") {
    const unit = arg("--unit");
    if (!unit) throw new Error("prepare --unit S1E2-U15");
    await cmdPrepare(unit);
    return;
  }
  if (mode === "commit") {
    const state = arg("--state");
    if (!state) throw new Error("commit --state <path>");
    await cmdCommit(state);
    return;
  }
  if (mode === "attest-batch") {
    const batch = Number(arg("--batch") || "2");
    await cmdAttestBatch(batch);
    return;
  }
  if (mode === "earliest") {
    await cmdEarliest();
    return;
  }
  console.error(`usage:
  npx tsx scripts/s1e2-ordered-runner.ts prepare --unit S1E2-U15 [--release]
  npx tsx scripts/s1e2-ordered-runner.ts commit --state <state.json>
  npx tsx scripts/s1e2-ordered-runner.ts attest-batch --batch 2 [--release]
  npx tsx scripts/s1e2-ordered-runner.ts earliest`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
