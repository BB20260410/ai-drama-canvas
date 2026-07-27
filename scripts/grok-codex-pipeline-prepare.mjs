import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  freezeAndPersistStudioUnitGridGenerationPack,
  dispatchStudioGenerationPack,
  readStudioUnitGridGenerationFrozenPack,
} from "../src/core/studio-generation-ledger.ts";
import { executeIdempotentCommand } from "../src/core/command-bus.ts";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.ts";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.ts";
import { inspectManagedProject } from "../src/core/managed-project.ts";

const workspace = "/Users/hxx/Documents/无限画布";
const root = path.join(workspace, "projects/grok-mvp-qingdeng-mrwc97mu-d0aea463");
const work = path.join(root, ".aicanvas/mvp-work/codex-connect-20260723");
const unitId = "S1E01-U01";
const man = JSON.parse(await readFile(path.join(workspace, "release-manifest.json"), "utf8"));
process.env.AI_CANVAS_WORKSPACE = workspace;
process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = man.sourceDigest;
process.env.AI_CANVAS_RELEASE_MANIFEST_PATH = path.join(workspace, "release-manifest.json");
process.env.AI_CANVAS_REGISTRY_PATH = path.join(process.env.HOME, ".aicanvas/projects.json");

await mkdir(work, { recursive: true });
const shell = await inspectManagedProject(root);
await registerProject(shell.project);
await setActiveProjectRegistration(root);

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
  renderedPrompt: pack.request?.modelPayload?.renderedPrompt?.slice?.(0, 800)
    || pack.modelPayload?.renderedPrompt?.slice?.(0, 800)
    || null,
};
await writeFile(path.join(work, "codex-precall.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({
  callAllowed: out.prepare.callAllowed,
  callId: out.prepare.callId,
  packId: out.pack.packId,
  schemaVersion: out.pack.schemaVersion,
  refCount: out.pack.controlReferences.length,
  refs: out.pack.controlReferences.map((r) => r.assetId),
  quarantine: out.prepare.quarantine,
  generationRunId,
  hasPrompt: Boolean(out.renderedPrompt),
}, null, 2));
