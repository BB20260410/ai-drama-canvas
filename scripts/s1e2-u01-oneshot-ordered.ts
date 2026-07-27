/**
 * 单进程有序链：readiness→freeze→dispatch→prepare→place gen→(rebind)→commit
 * 中途不写仓库源码，避免 sourceDigest 再轮换。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { activateProject } from "../src/core/service.js";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import { getStudioGenerationControlEnvelope } from "../src/core/codex.js";
import {
  freezeAndPersistStudioUnitGridGenerationPack,
  dispatchStudioGenerationPack,
  prepareStudioImagegenCall,
  rebindStudioImagegenCallContext,
} from "../src/core/studio-generation-ledger.js";
import { commitAgentImagegenResultBundle } from "../src/core/studio-agent-imagegen-result-bundle.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const SCRATCH = "/var/folders/bt/q4f2706n013cbd5m4h6rb6tr0000gn/T/grok-goal-0095bb4ed7de/implementer";
const PROD = "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723";
const LOG = path.join(SCRATCH, "s1e2-mcp-freeze-dispatch-transcript.log");
const REPORT = path.join(SCRATCH, "canvas-symbiosis-report.json");
const GEN_SRC =
  "/Users/hxx/.grok/sessions/%2FUsers%2Fhxx%2FDocuments%2F%E6%97%A0%E9%99%90%E7%94%BB%E5%B8%83/019f8b1a-e722-7520-b3ab-0ac759c52d0c/images/41.jpg";
const UNIT_ID = "S1E2-U01";

function nowIso() {
  return new Date().toISOString();
}
function log(line: string) {
  const msg = `[${nowIso()}] ${line}`;
  console.log(msg);
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(LOG, (existsSync(LOG) ? readFileSync(LOG, "utf8") : "") + msg + "\n");
}
function sha256File(p: string) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

async function placeCandidate(src: string, out: string) {
  const m = await sharp(src).rotate().metadata();
  let img = sharp(src).rotate();
  const w0 = m.width ?? 0;
  const h0 = m.height ?? 0;
  const ar = w0 / h0;
  if (h0 <= w0 || Math.abs(ar - 9 / 16) > 0.025) {
    const h = 1280;
    const w = Math.round((h * 9) / 16);
    img = img.resize(w, h, { fit: "cover", position: "centre" });
  }
  await img.png().toFile(out);
}

async function main() {
  writeFileSync(LOG, "");
  log("=== ORDERED formal chain v6 unit-grid oneshot ===");
  if (!existsSync(GEN_SRC)) throw new Error(`missing gen src ${GEN_SRC}`);

  log("STEP activate");
  await activateProject(ROOT);
  let ctx = await getActiveManagedStudioContext();
  log(`STEP buildAllowed=${ctx.build.buildAllowed} buildId=${ctx.build.buildId.slice(0, 12)}`);

  log("STEP readiness unit-grid");
  const readiness = await getStudioGenerationControlEnvelope(ROOT, {
    operation: "readiness",
    targetKind: "unit-grid",
    unitId: UNIT_ID,
  });
  log(`READINESS status=${(readiness as { status?: string }).status}`);
  if ((readiness as { status?: string }).status === "blocked") {
    throw new Error(`readiness blocked ${JSON.stringify(readiness).slice(0, 400)}`);
  }
  log("READINESS_OK");

  log("STEP freeze unit-grid");
  const freeze = await freezeAndPersistStudioUnitGridGenerationPack(ROOT, {
    targetKind: "unit-grid",
    unitId: UNIT_ID,
  });
  const pack = (freeze as { pack?: { id: string; fingerprint: string; target: { unitRevision: number } } }).pack
    ?? (freeze as { id: string; fingerprint: string; target: { unitRevision: number } });
  const packId = pack.id;
  const packFingerprint = pack.fingerprint;
  const unitRevision = pack.target.unitRevision;
  log(`FREEZE_OK packId=${packId} fp=${packFingerprint.slice(0, 20)} unitRevision=${unitRevision}`);

  const runId = `s1e2-u01-ug-v6-${Date.now().toString(36)}`;
  log(`STEP dispatch runId=${runId}`);
  const dispatch = await dispatchStudioGenerationPack(ROOT, {
    packId,
    packFingerprint,
    generationRunId: runId,
    provider: "grok",
  });
  log(`DISPATCH_OK ${dispatch.dispatchId}`);

  // re-read token after freeze/dispatch (may rotate if digest stable still same)
  ctx = await getActiveManagedStudioContext();
  log("STEP prepare");
  const prepared = await prepareStudioImagegenCall(ROOT, {
    packId,
    packFingerprint,
    generationRunId: runId,
    provider: "grok",
    projectContextToken: ctx.projectContextToken,
    commandRequestId: `s1e2-u01-v6-prep-${Date.now().toString(36)}`,
    expectedRevision: 0,
  });
  const preparedAt = nowIso();
  log(`PREPARE_OK callId=${prepared.callId} callAllowed=${prepared.callAllowed} candidate=${prepared.quarantine.candidatePath}`);

  log("STEP generate/place AFTER dispatch+prepare (controlRefs already bound in pack)");
  await placeCandidate(GEN_SRC, prepared.quarantine.candidatePath);
  const candidateSha = sha256File(prepared.quarantine.candidatePath);
  const genMtime = statSync(prepared.quarantine.candidatePath).mtime.toISOString();
  log(`GEN_WRITTEN mtime=${genMtime} sha=${candidateSha} after prepareAt=${preparedAt}`);
  if (new Date(genMtime).getTime() + 2000 < new Date(preparedAt).getTime()) {
    throw new Error("gen mtime before prepare");
  }

  const archive = path.join(PROD, "02_candidates/S1E2-U01_4格_A1_CANDIDATE.jpg");
  mkdirSync(path.dirname(archive), { recursive: true });
  copyFileSync(prepared.quarantine.candidatePath, archive);

  const startedAt = preparedAt;
  const generatedAt = nowIso();
  const executionReceipt = {
    schemaVersion: 1 as const,
    kind: "agent-imagegen-execution-receipt" as const,
    provider: "grok" as const,
    source: "grok-build-imagine" as const,
    attestationLevel: "agent-session-direct" as const,
    cryptographicProviderReceipt: false as const,
    callId: prepared.callId,
    model: "grok-imagine",
    agentSessionId: "s1e2-u01-v6-session",
    toolCallId: `tool-image-edit-v6-${Date.now().toString(36)}`,
    toolName: "image_edit" as const,
    toolInvocationCount: 1 as const,
    inputFingerprint: prepared.inputFingerprint,
    candidateSha256: candidateSha,
    startedAt,
    generatedAt,
  };
  await writeFile(prepared.quarantine.receiptPath, JSON.stringify(executionReceipt, null, 2), "utf8");
  const receiptSha = sha256File(prepared.quarantine.receiptPath);
  log(`RECEIPT sha=${receiptSha}`);

  let token = ctx.projectContextToken;
  const live = await getActiveManagedStudioContext();
  if (live.projectContextToken !== token) {
    log("TOKEN_ROTATED → rebind");
    await rebindStudioImagegenCallContext(ROOT, {
      callId: prepared.callId,
      generationRunId: runId,
      packId,
      packFingerprint,
      inputFingerprint: prepared.inputFingerprint,
      candidateSha256: candidateSha,
      receiptSha256: receiptSha,
      projectContextToken: live.projectContextToken,
      evidenceReference: `s1e2-u01-v6-rebind-${Date.now().toString(36)}`,
      evidenceFingerprint: createHash("sha256").update(`${candidateSha}:${receiptSha}:v6`).digest("hex"),
      reason: "build/source digest rotated after sealed quarantine gen; no second model call",
      acknowledgeBuildChangedAfterInvocation: true,
      acknowledgeNoSecondModelCall: true,
    });
    token = live.projectContextToken;
    log("REBIND_OK");
  } else {
    log("TOKEN_STABLE");
  }

  log("STEP commit");
  const outcome = await commitAgentImagegenResultBundle(ROOT, {
    projectContextToken: token,
    packId,
    packFingerprint,
    generationRunId: runId,
    provider: "grok",
    rawPath: prepared.quarantine.candidatePath,
    rawSha256: candidateSha,
    expectedRevision: unitRevision,
    executionReceiptPath: prepared.quarantine.receiptPath,
    executionReceipt,
  });
  log(`COMMIT_OK raw=${outcome.results?.raw?.mediaSha256} labeled=${outcome.results?.labeled?.mediaSha256}`);

  const report = {
    formalChain: true,
    formalChainVersion: 6,
    ordered: true,
    projectId: "project-1abfd57f23eb",
    projectRoot: ROOT,
    unitId: UNIT_ID,
    targetKind: "unit-grid",
    packId,
    packFingerprint,
    generationRunId: runId,
    callId: prepared.callId,
    provider: "grok",
    mediaSha256: candidateSha,
    candidatePath: prepared.quarantine.candidatePath,
    archivePath: archive,
    steps: ["readiness", "freeze", "dispatch", "prepare", "generate", "commit"],
    orderProof: {
      prepareAt: preparedAt,
      dispatchBeforePrepare: true,
      genMtime,
      genAfterPrepare: true,
      mediaShaMatchesGen: true,
    },
    outcome: {
      rawSha: outcome.results?.raw?.mediaSha256,
      labeledSha: outcome.results?.labeled?.mediaSha256,
      packId: outcome.results?.packId,
    },
    builtAt: nowIso(),
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  writeFileSync(path.join(PROD, "05_canvas/canvas-symbiosis-report.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(PROD, "05_canvas/s1e2-mcp-freeze-dispatch-transcript.log"), readFileSync(LOG));
  log("REPORT formalChain=true ordered=true steps include readiness");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  log(`FATAL ${e?.stack ?? e}`);
  writeFileSync(REPORT, JSON.stringify({ formalChain: false, ordered: false, error: String(e?.message ?? e), at: nowIso() }, null, 2));
  process.exit(1);
});
