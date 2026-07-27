/**
 * U11 prepare: light context token + strong SQLite-race backoff.
 * Reuses existing dispatch run; no new dispatch.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { activateProject } from "../src/core/service.js";
import {
  prepareStudioImagegenCall,
  readAnyStudioGenerationFrozenPack,
} from "../src/core/studio-generation-ledger.js";
import { getStudioMedia } from "../src/core/material-studio.js";
import { getActiveProjectState, getActiveProjectRegistration } from "../src/core/sidecar.js";
import { inspectManagedProject } from "../src/core/managed-project.js";
import { resolveRuntimeBuildIdentity } from "../src/core/build-identity.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const WORKSPACE = "/Users/hxx/Documents/无限画布";
const PROD = "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723";
const SCRATCH = path.join(PROD, "05_canvas/_scratch");
const STATE = path.join(SCRATCH, "s1e2-u11-ordered-state.json");
const LOG = path.join(SCRATCH, "s1e2-u11-prepare-lite.log");

const PACK_ID = "studio-generation-freeze-2ed6116aae0c50b630fa44d9dc229520";
const PACK_FP = "2ed6116aae0c50b630fa44d9dc22952053863956ac7a625235ad4a9d83897236";
const RUN_ID = "s1e2-u11-ug-grok-mrxigffv";

function log(m: string) {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(LOG, (existsSync(LOG) ? readFileSync(LOG, "utf8") : "") + line + "\n");
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, e]) => e !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([k, e]) => [k, stable(e)]),
  );
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

async function lightProjectContextToken(): Promise<string> {
  const [activeState, registration] = await Promise.all([
    getActiveProjectState(),
    getActiveProjectRegistration(),
  ]);
  if (!activeState || !registration) throw new Error("no active project");
  const activeRoot = path.resolve(activeState.primaryRoot);
  if (path.resolve(ROOT) !== activeRoot) {
    throw new Error(`active root mismatch: ${activeRoot}`);
  }
  const shell = await inspectManagedProject(activeRoot);
  const identity = await resolveRuntimeBuildIdentity(WORKSPACE);
  const tokenBody = {
    projectId: shell.project.id,
    projectRoot: activeRoot,
    manifestFingerprint: shell.manifestFingerprint,
    activationId: activeState.activationId,
    buildId: identity.buildId,
    sourceDigest: identity.sourceDigest,
  };
  return `studioctx-v1-${digest(tokenBody)}`;
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

function isRace(e: any): boolean {
  const msg = String(e?.message || e || "");
  const details = JSON.stringify(e?.details || e?.cause?.details || e?.cause?.message || "");
  const blob = msg + details;
  return /snapshot|WAL|冻结验证|隔离快照|source identity|changed while/i.test(blob);
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  log("=== U11 prepare-lite ===");
  await activateProject(ROOT);
  const token = await lightProjectContextToken();
  log(`token ${token.slice(0, 28)}…`);

  let controlRefs: Awaited<ReturnType<typeof resolveControlLocalPaths>> = [];
  for (let i = 0; i < 10; i++) {
    try {
      controlRefs = await resolveControlLocalPaths(PACK_ID);
      log(`CONTROL_REFS ${controlRefs.length}`);
      break;
    } catch (e: any) {
      log(`controlRefs fail ${i}: ${e.message?.slice(0, 100)}`);
      if (!isRace(e) && i > 2) throw e;
      await sleep(600 * (i + 1));
    }
  }

  let prepared: any;
  let last: any;
  for (let i = 0; i < 24; i++) {
    try {
      // recompute token each attempt in case activation rotated
      const t = await lightProjectContextToken();
      prepared = await prepareStudioImagegenCall(ROOT, {
        packId: PACK_ID,
        packFingerprint: PACK_FP,
        generationRunId: RUN_ID,
        provider: "grok",
        projectContextToken: t,
        commandRequestId: `u11-lite-${i}-${Date.now().toString(36)}`,
        expectedRevision: 0,
      });
      log(`PREPARE_OK ${prepared.callId} attempt=${i}`);
      break;
    } catch (e: any) {
      last = e;
      const race = isRace(e);
      log(`prepare fail ${i} race=${race}: ${String(e?.message || e).slice(0, 160)}`);
      if (!race && i >= 3) {
        // non-race after a few tries: still backoff once for checkpoint flakiness
        if (i >= 6) throw e;
      }
      await sleep(900 * Math.pow(1.35, Math.min(i, 12)) + Math.random() * 500);
    }
  }
  if (!prepared) throw last || new Error("prepare failed");

  const unitRevision = 1;
  const state = {
    preparedAt: new Date().toISOString(),
    projectRoot: ROOT,
    projectContextToken: await lightProjectContextToken(),
    unitId: "S1E2-U11",
    packId: PACK_ID,
    packFingerprint: PACK_FP,
    unitRevision,
    generationRunId: RUN_ID,
    callId: prepared.callId,
    inputFingerprint: prepared.inputFingerprint,
    quarantine: prepared.quarantine,
    controlRefs,
    candidateOut: path.join(PROD, "02_candidates/S1E2-U11_4格_A1_CANDIDATE.jpg"),
    reportOut: path.join(PROD, "05_canvas/s1e2-u11-symbiosis-report.json"),
  };
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ ok: true, statePath: STATE, callId: prepared.callId, candidate: prepared.quarantine?.candidatePath, controlRefs }, null, 2));
}

main().catch((e) => {
  log(`FATAL ${e?.stack || e}`);
  process.exit(1);
});
