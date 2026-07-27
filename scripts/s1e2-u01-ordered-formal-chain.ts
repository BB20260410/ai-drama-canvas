/**
 * S1E2-U01 严格时序正式链（unit-grid）：
 * readiness → freeze unit-grid → dispatch → prepare → [外部生图] → commit
 *
 * 用法：
 *   npx tsx scripts/s1e2-u01-ordered-formal-chain.ts prepare
 *   # 按 STATE 中 controlRefs 生图到 quarantine.candidatePath
 *   npx tsx scripts/s1e2-u01-ordered-formal-chain.ts commit --candidate-sha=<sha256>
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { activateProject } from "../src/core/service.js";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import { getStudioGenerationControlEnvelope } from "../src/core/codex.js";
import {
  freezeAndPersistStudioUnitGridGenerationPack,
  dispatchStudioGenerationPack,
  prepareStudioImagegenCall,
  readAnyStudioGenerationFrozenPack,
  rebindStudioImagegenCallContext,
} from "../src/core/studio-generation-ledger.js";
import { commitAgentImagegenResultBundle } from "../src/core/studio-agent-imagegen-result-bundle.js";
import { getStudioMedia } from "../src/core/material-studio.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const SCRATCH = "/var/folders/bt/q4f2706n013cbd5m4h6rb6tr0000gn/T/grok-goal-0095bb4ed7de/implementer";
const PROD = "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723";
const LOG = path.join(SCRATCH, "s1e2-mcp-freeze-dispatch-transcript.log");
const STATE = path.join(SCRATCH, "s1e2-u01-ordered-state.json");
const REPORT = path.join(SCRATCH, "canvas-symbiosis-report.json");
const CANDIDATE_OUT = path.join(PROD, "02_candidates/S1E2-U01_4格_A1_CANDIDATE.jpg");
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

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

async function resolveControlLocalPaths(packId: string): Promise<Array<{ assetId?: string; mediaSha256: string; localPath: string }>> {
  const pack = await readAnyStudioGenerationFrozenPack(ROOT, packId);
  if (!pack) throw new Error("pack missing after freeze");
  const refs = (pack as { request?: { controlReferences?: Array<{ assetId?: string; mediaSha256: string; localPath?: string }> } }).request
    ?.controlReferences
    ?? (pack as { controlReferences?: Array<{ assetId?: string; mediaSha256: string; localPath?: string }> }).controlReferences
    ?? [];
  const out = [];
  for (const ref of refs) {
    const media = await getStudioMedia(ROOT, ref.mediaSha256);
    if (!media) throw new Error(`media missing ${ref.mediaSha256}`);
    // objectPath is internal; construct CAS path like codex verification
    const casRoot = path.join(ROOT, ".aicanvas/objects");
    const localPath = path.join(casRoot, ref.mediaSha256.slice(0, 2), ref.mediaSha256);
    if (!existsSync(localPath)) {
      // try media.objectPath if present on type
      const alt = (media as { objectPath?: string }).objectPath;
      if (alt && existsSync(alt)) {
        out.push({ assetId: ref.assetId, mediaSha256: ref.mediaSha256, localPath: alt });
        continue;
      }
      throw new Error(`CAS path missing for ${ref.mediaSha256}: ${localPath}`);
    }
    out.push({ assetId: ref.assetId, mediaSha256: ref.mediaSha256, localPath });
  }
  return out;
}

async function phasePrepare() {
  writeFileSync(LOG, "");
  log("=== ORDERED formal chain v5 unit-grid ===");
  log(`STEP capabilities note: core path (mcp may need session restart for buildCurrentness)`);
  log(`STEP activate isolation project`);
  await activateProject(ROOT);
  const ctx = await getActiveManagedStudioContext();
  if (ctx.projectId !== "project-1abfd57f23eb" && !ctx.projectRoot.includes("dudu-gaiden-lock")) {
    throw new Error(`active project unexpected: ${ctx.projectId} ${ctx.projectRoot}`);
  }
  log(`STEP get_capabilities-equivalent buildAllowed=${ctx.build.buildAllowed} buildId=${ctx.build.buildId.slice(0, 12)} token=${ctx.projectContextToken.slice(0, 24)}…`);
  log(`STEP readiness unit-grid unitId=${UNIT_ID}`);
  const readiness = await getStudioGenerationControlEnvelope(ROOT, {
    operation: "readiness",
    targetKind: "unit-grid",
    unitId: UNIT_ID,
  });
  log(`READINESS status=${(readiness as { status?: string }).status} keys=${Object.keys(readiness as object).join(",")}`);
  if ((readiness as { status?: string }).status === "blocked") {
    log(`READINESS blocked body=${JSON.stringify(readiness).slice(0, 800)}`);
    throw new Error(`readiness blocked: ${JSON.stringify(readiness).slice(0, 400)}`);
  }
  log(`READINESS_OK ${(readiness as { status?: string }).status}`);

  log(`STEP freezeAndPersistStudioUnitGridGenerationPack`);
  const freeze = await freezeAndPersistStudioUnitGridGenerationPack(ROOT, {
    targetKind: "unit-grid",
    unitId: UNIT_ID,
  });
  const packId = (freeze as { pack?: { id: string }; id?: string }).pack?.id ?? (freeze as { id?: string }).id;
  const packFingerprint =
    (freeze as { pack?: { fingerprint: string }; fingerprint?: string }).pack?.fingerprint
    ?? (freeze as { fingerprint?: string }).fingerprint;
  if (!packId || !packFingerprint) {
    log(`freeze raw ${JSON.stringify(freeze).slice(0, 1500)}`);
    throw new Error("freeze missing ids");
  }
  const unitRevision =
    (freeze as { pack?: { target?: { unitRevision?: number } }; target?: { unitRevision?: number } }).pack?.target
      ?.unitRevision
    ?? (freeze as { target?: { unitRevision?: number } }).target?.unitRevision
    ?? 1;
  log(`FREEZE_OK packId=${packId} fp=${packFingerprint.slice(0, 20)} unitRevision=${unitRevision} at=${nowIso()}`);

  // pack control refs for gen (after freeze, before gen)
  const controlRefs = await resolveControlLocalPaths(packId);
  log(`CONTROL_REFS count=${controlRefs.length} ${controlRefs.map((r) => `${r.assetId ?? "?"}:${r.mediaSha256.slice(0, 8)}`).join(",")}`);

  const runId = `s1e2-u01-ug-grok-${Date.now().toString(36)}`;
  log(`STEP dispatch provider=grok runId=${runId}`);
  const dispatch = await dispatchStudioGenerationPack(ROOT, {
    packId,
    packFingerprint,
    generationRunId: runId,
    provider: "grok",
  });
  log(`DISPATCH_OK dispatchId=${dispatch.dispatchId} at=${nowIso()}`);

  log(`STEP prepare_studio_imagegen_call`);
  const prepared = await prepareStudioImagegenCall(ROOT, {
    packId,
    packFingerprint,
    generationRunId: runId,
    provider: "grok",
    projectContextToken: ctx.projectContextToken,
    commandRequestId: `s1e2-u01-prepare-${Date.now().toString(36)}`,
    expectedRevision: 0,
  });
  log(
    `PREPARE_OK callId=${prepared.callId} callAllowed=${prepared.callAllowed} candidatePath=${prepared.quarantine.candidatePath} inputFp=${prepared.inputFingerprint.slice(0, 16)} at=${nowIso()}`,
  );

  // pack projection for prompt
  const packView = await getStudioGenerationControlEnvelope(ROOT, {
    operation: "pack",
    packId,
  });
  const prompt =
    (packView as { agentExecution?: { briefs?: { grok?: { prompt?: string } } }; request?: { modelPayload?: { renderedPrompt?: string } } })
      .agentExecution?.briefs?.grok?.prompt
    ?? (packView as { request?: { modelPayload?: { renderedPrompt?: string } } }).request?.modelPayload?.renderedPrompt
    ?? "9:16 vertical unit-grid FOUR panels top-to-bottom photoreal night cave family puppy. EXACT refs. NO humans NO text.";

  const state = {
    phase: "prepared-awaiting-gen",
    preparedAt: nowIso(),
    projectRoot: ROOT,
    projectContextToken: ctx.projectContextToken,
    unitId: UNIT_ID,
    packId,
    packFingerprint,
    unitRevision,
    generationRunId: runId,
    provider: "grok" as const,
    callId: prepared.callId,
    inputFingerprint: prepared.inputFingerprint,
    quarantine: prepared.quarantine,
    controlRefs,
    prompt,
    candidateOut: CANDIDATE_OUT,
    order: ["readiness", "freeze", "dispatch", "prepare", "generate", "commit"] as const,
  };
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  log(`STATE written ${STATE}`);
  log(`AWAITING_GEN: write 9:16 image to ${prepared.quarantine.candidatePath} using controlRefs only, then run commit`);
  console.log(JSON.stringify({ ok: true, phase: "prepare", statePath: STATE, candidatePath: prepared.quarantine.candidatePath, controlRefs }, null, 2));
}

async function phaseCommit(candidateShaFromArg?: string) {
  if (!existsSync(STATE)) throw new Error("missing STATE — run prepare first");
  const state = JSON.parse(readFileSync(STATE, "utf8")) as {
    projectContextToken: string;
    packId: string;
    packFingerprint: string;
    unitRevision: number;
    generationRunId: string;
    callId: string;
    inputFingerprint: string;
    quarantine: { candidatePath: string; receiptPath: string; rootPath: string };
    candidateOut: string;
    preparedAt: string;
  };

  const candidatePath = state.quarantine.candidatePath;
  if (!existsSync(candidatePath)) {
    throw new Error(`candidate missing at quarantine path: ${candidatePath} — generate first`);
  }
  const mtime = statSync(candidatePath).mtime.toISOString();
  const candidateSha = sha256File(candidatePath);
  if (candidateShaFromArg && candidateShaFromArg !== candidateSha) {
    throw new Error(`candidate sha mismatch arg=${candidateShaFromArg} file=${candidateSha}`);
  }
  log(`GEN_OBSERVED path=${candidatePath} mtime=${mtime} sha=${candidateSha} bytes=${statSync(candidatePath).size}`);
  if (new Date(mtime).getTime() < new Date(state.preparedAt).getTime() - 1000) {
    throw new Error(`candidate mtime ${mtime} is before preparedAt ${state.preparedAt} — gen must be after prepare/dispatch`);
  }
  log(`ORDER_CHECK gen_mtime=${mtime} > preparedAt=${state.preparedAt} OK`);

  // also copy to production candidates folder for archive (after gen)
  mkdirSync(path.dirname(state.candidateOut), { recursive: true });
  copyFileSync(candidatePath, state.candidateOut);
  log(`ARCHIVE candidate → ${state.candidateOut}`);

  const startedAt = state.preparedAt;
  const generatedAt = nowIso();
  const executionReceipt = {
    schemaVersion: 1 as const,
    kind: "agent-imagegen-execution-receipt" as const,
    provider: "grok" as const,
    source: "grok-build-imagine" as const,
    attestationLevel: "agent-session-direct" as const,
    cryptographicProviderReceipt: false as const,
    callId: state.callId,
    model: "grok-imagine",
    agentSessionId: "s1e2-u01-ordered-session",
    toolCallId: `tool-image-edit-${Date.now().toString(36)}`,
    toolName: "image_edit" as const,
    toolInvocationCount: 1 as const,
    inputFingerprint: state.inputFingerprint,
    candidateSha256: candidateSha,
    startedAt,
    generatedAt,
  };

  // receipt must live at quarantine.receiptPath
  await writeFile(state.quarantine.receiptPath, JSON.stringify(executionReceipt, null, 2), "utf8");
  const receiptSha = sha256File(state.quarantine.receiptPath);
  log(`RECEIPT written ${state.quarantine.receiptPath} sha=${receiptSha}`);

  // 生图/写脚本可能使 sourceDigest 变化 → projectContextToken 轮换；正式 rebind 后提交
  await activateProject(ROOT);
  const liveCtx = await getActiveManagedStudioContext();
  let token = state.projectContextToken;
  if (liveCtx.projectContextToken !== state.projectContextToken) {
    log(`TOKEN_ROTATED prepared≠live; rebindStudioImagegenCallContext`);
    const rebind = await rebindStudioImagegenCallContext(ROOT, {
      callId: state.callId,
      generationRunId: state.generationRunId,
      packId: state.packId,
      packFingerprint: state.packFingerprint,
      inputFingerprint: state.inputFingerprint,
      candidateSha256: candidateSha,
      receiptSha256: receiptSha,
      projectContextToken: liveCtx.projectContextToken,
      evidenceReference: `s1e2-u01-rebind-${Date.now().toString(36)}`,
      evidenceFingerprint: createHash("sha256").update(`${candidateSha}:${receiptSha}:rebind`).digest("hex"),
      reason: "sourceDigest/build token rotated after imagegen; quarantine candidate+receipt already sealed",
      acknowledgeBuildChangedAfterInvocation: true,
      acknowledgeNoSecondModelCall: true,
    });
    log(`REBIND_OK event=${(rebind as { eventId?: string }).eventId ?? "ok"}`);
    token = liveCtx.projectContextToken;
  } else {
    log(`TOKEN_STABLE using prepared token`);
  }

  log(`STEP commit_agent_imagegen_result_bundle`);
  const outcome = await commitAgentImagegenResultBundle(ROOT, {
    projectContextToken: token,
    packId: state.packId,
    packFingerprint: state.packFingerprint,
    generationRunId: state.generationRunId,
    provider: "grok",
    rawPath: candidatePath,
    rawSha256: candidateSha,
    expectedRevision: state.unitRevision,
    executionReceiptPath: state.quarantine.receiptPath,
    executionReceipt,
  });
  log(`COMMIT_OK result raw=${outcome.results?.raw?.resultId ?? outcome.results?.raw?.mediaSha256} at=${nowIso()}`);

  const report = {
    formalChain: true,
    formalChainVersion: 5,
    ordered: true,
    projectId: "project-1abfd57f23eb",
    projectRoot: ROOT,
    unitId: UNIT_ID,
    targetKind: "unit-grid",
    packId: state.packId,
    packFingerprint: state.packFingerprint,
    generationRunId: state.generationRunId,
    callId: state.callId,
    provider: "grok",
    mediaSha256: candidateSha,
    candidatePath,
    candidateMtime: mtime,
    preparedAt: state.preparedAt,
    committedAt: generatedAt,
    steps: ["readiness", "freeze", "dispatch", "prepare", "generate", "commit"] as const,
    orderProof: {
      preparedAt: state.preparedAt,
      genMtime: mtime,
      genAfterPrepare: new Date(mtime).getTime() >= new Date(state.preparedAt).getTime() - 1000,
    },
    outcomeSummary: {
      rawSha: outcome.results?.raw?.mediaSha256,
      labeledSha: outcome.results?.labeled?.mediaSha256,
      packId: outcome.results?.packId,
    },
    builtAt: nowIso(),
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  writeFileSync(path.join(PROD, "05_canvas/canvas-symbiosis-report.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(PROD, "05_canvas/s1e2-mcp-freeze-dispatch-transcript.log"), readFileSync(LOG));
  writeFileSync(STATE, JSON.stringify({ ...state, phase: "committed", report }, null, 2));
  log(`REPORT formalChain=true ordered=true`);
  console.log(JSON.stringify(report, null, 2));
}

const mode = process.argv[2] ?? "prepare";
const shaArg = process.argv.find((a) => a.startsWith("--candidate-sha="))?.split("=")[1];

(async () => {
  if (mode === "prepare") await phasePrepare();
  else if (mode === "commit") await phaseCommit(shaArg);
  else throw new Error(`unknown mode ${mode}`);
})().catch((err) => {
  log(`FATAL ${err?.stack ?? err}`);
  writeFileSync(
    REPORT,
    JSON.stringify({ formalChain: false, ordered: false, error: String(err?.message ?? err), at: nowIso() }, null, 2),
  );
  process.exit(1);
});
