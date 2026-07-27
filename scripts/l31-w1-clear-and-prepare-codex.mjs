import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  freezeAndPersistStudioUnitGridGenerationPack,
  dispatchStudioGenerationPack,
  readStudioUnitGridGenerationFrozenPack,
  failStudioGenerationRun,
  readStudioImagegenCallIntentByRun,
} from "../src/core/studio-generation-ledger.ts";
import { executeIdempotentCommand } from "../src/core/command-bus.ts";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.ts";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.ts";
import { inspectManagedProject } from "../src/core/managed-project.ts";

const workspace = "/Users/hxx/Documents/无限画布";
const root = path.join(workspace, "projects/grok-mvp-qingdeng-mrwc97mu-d0aea463");
const work = path.join(root, ".aicanvas/mvp-work/codex-connect-20260723");
const unitId = "S1E01-U01";
const man = JSON.parse(readFileSync(path.join(workspace, "release-manifest.json"), "utf8"));
process.env.AI_CANVAS_WORKSPACE = workspace;
process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = man.sourceDigest;
process.env.AI_CANVAS_RELEASE_MANIFEST_PATH = path.join(workspace, "release-manifest.json");
process.env.AI_CANVAS_REGISTRY_PATH = path.join(process.env.HOME, ".aicanvas/projects.json");

mkdirSync(work, { recursive: true });
const shell = await inspectManagedProject(root);
await registerProject(shell.project);
await setActiveProjectRegistration(root);
const ctx = await getActiveManagedStudioContext();
const token = ctx.projectContextToken;

// Clear stuck precall if present
const prePath = path.join(work, "codex-precall.json");
try {
  const pre = JSON.parse(readFileSync(prePath, "utf8"));
  const callId = pre.prepare?.callId;
  const generationRunId = pre.generationRunId;
  if (callId && generationRunId) {
    const intent = await readStudioImagegenCallIntentByRun(root, generationRunId).catch(() => null);
    console.error("prior intent status", intent?.status, callId);
    if (intent && intent.status === "generation_unknown") {
      const evidence = {
        schemaVersion: 1,
        kind: "l31-codex-not-invoked-evidence",
        callId,
        generationRunId,
        reason: "prepare granted callAllowed but agent image tool was never invoked",
        observedAt: new Date().toISOString(),
        operator: "l31-w1",
      };
      const evidenceBody = `${JSON.stringify(evidence, null, 2)}\n`;
      const evidencePath = path.join(work, `not-invoked-${callId.slice(-12)}.json`);
      writeFileSync(evidencePath, evidenceBody);
      const evidenceFingerprint = createHash("sha256").update(evidenceBody).digest("hex");
      const rec = await executeIdempotentCommand(root, {
        requestId: `rec-notinv-l31-${Date.now()}`.slice(0, 160),
        idempotencyKey: `rec-notinv-l31-key-${callId}`.slice(0, 200),
        request: {
          command: "reconcile_studio_imagegen_call",
          payload: {
            callId,
            projectContextToken: pre.projectContextToken || token,
            result: "not-invoked",
            evidenceReference: evidencePath,
            evidenceFingerprint,
            note: "L31 W1 reopen: agent never invoked codex image tool after prepare",
            expectedRevision: 0,
          },
        },
      });
      console.error("reconcile", rec.status);
    }
    try {
      const fr = await failStudioGenerationRun(root, {
        generationRunId,
        errorClass: "agent-not-invoked",
        detail: "L31 W1: cleared after not-invoked reconcile; reopen codex full chain",
      });
      console.error("failRun", fr?.kind || fr?.eventId || "ok");
    } catch (e) {
      console.error("failRun skip", e.message?.slice?.(0, 200) || e);
    }
  }
} catch {
  console.error("no prior precall");
}

// Fresh freeze → dispatch → prepare
const frozen = await freezeAndPersistStudioUnitGridGenerationPack(root, {
  targetKind: "unit-grid",
  unitId,
});
const generationRunId = `codex-ug-run-${Date.now().toString(36)}`;
await dispatchStudioGenerationPack(root, {
  packId: frozen.packId,
  packFingerprint: frozen.fingerprint,
  generationRunId,
  provider: "codex",
});
const context = await getActiveManagedStudioContext();
const prepare = await executeIdempotentCommand(root, {
  requestId: `codex-prep-${generationRunId}`.slice(0, 160),
  idempotencyKey: `codex-prep-key-${generationRunId}`.slice(0, 200),
  request: {
    command: "prepare_studio_imagegen_call",
    payload: {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "codex",
      projectContextToken: context.projectContextToken,
      expectedRevision: 0,
    },
  },
});
const pack = await readStudioUnitGridGenerationFrozenPack(root, frozen.packId);
const prepared = prepare.result;
const refs = pack.request?.controlReferences || pack.controlReferences || [];
const out = {
  projectRoot: root,
  projectId: context.project?.id || context.projectId,
  provider: "codex",
  pack: {
    packId: frozen.packId,
    packFingerprint: frozen.fingerprint,
    unitRevision: pack.target?.unitRevision || frozen.pack?.target?.unitRevision,
    schemaVersion: pack.request?.schemaVersion || pack.schemaVersion,
    controlReferences: refs.map((r) => ({
      assetId: r.assetId,
      mediaSha256: r.mediaSha256,
      localPath: r.localPath,
      category: r.category,
    })),
  },
  generationRunId,
  prepare: {
    status: prepare.status,
    callAllowed: prepared.callAllowed,
    callId: prepared.callId,
    inputFingerprint: prepared.inputFingerprint,
    quarantine: prepared.quarantine,
  },
  projectContextToken: context.projectContextToken,
  renderedPrompt: pack.request?.modelPayload?.renderedPrompt?.slice?.(0, 1200)
    || pack.modelPayload?.renderedPrompt?.slice?.(0, 1200)
    || null,
  releaseDigest: man.sourceDigest,
};
writeFileSync(path.join(work, "codex-precall.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({
  callAllowed: out.prepare.callAllowed,
  callId: out.prepare.callId,
  packId: out.pack.packId,
  schemaVersion: out.pack.schemaVersion,
  unitRevision: out.pack.unitRevision,
  refCount: out.pack.controlReferences.length,
  refs: out.pack.controlReferences.map((r) => ({ id: r.assetId, hasPath: Boolean(r.localPath) })),
  quarantine: out.prepare.quarantine?.candidatePath,
  generationRunId,
  hasPrompt: Boolean(out.renderedPrompt),
}, null, 2));
