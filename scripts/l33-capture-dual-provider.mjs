#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Use compiled dist-mcp (shipped path after build:mcp)
const { queryStudioUnitGridGenerationFreeze } = await import(
  path.join(root, "dist-mcp/core/studio-unit-grid-generation.js")
);
const { buildStudioUnitGridAgentImagegenBrief } = await import(
  path.join(root, "dist-mcp/core/codex.js")
);
const { readStudioImagegenCallIntentByRun } = await import(
  path.join(root, "dist-mcp/core/studio-generation-ledger.js")
);

const projectRoot = path.join(root, "projects/grok-mvp-qingdeng-mrwc97mu-d0aea463");
const scratch = process.env.L33_SCRATCH || "";

const readiness = await queryStudioUnitGridGenerationFreeze(projectRoot, {
  targetKind: "unit-grid",
  unitId: "S1E01-U01",
});
if (readiness.status !== "ready") {
  console.error(JSON.stringify({ error: "not-ready", readiness }, null, 2));
  process.exit(1);
}
const pack = readiness.pack;
const codex = buildStudioUnitGridAgentImagegenBrief(pack, "codex");
const grok = buildStudioUnitGridAgentImagegenBrief(pack, "grok");
const call22 = await readStudioImagegenCallIntentByRun(projectRoot, "codex-ug-run-mrwecb5s");

const evidence = {
  schemaVersion: 1,
  kind: "l33-dual-provider-real-readiness-projection",
  capturedAt: new Date().toISOString(),
  projectRoot,
  unitId: "S1E01-U01",
  captureMethod: "queryStudioUnitGridGenerationFreeze + buildStudioUnitGridAgentImagegenBrief (dist-mcp shipped)",
  readiness: {
    status: readiness.status,
    packId: readiness.packId,
    fingerprint: readiness.fingerprint,
    controlReferenceCount: pack.controlReferences.length,
    continuityFingerprint: pack.continuityFingerprint,
    panelCount: pack.target.panelCount,
    unitRevision: pack.target.unitRevision,
    allowedProviders: pack.request.allowedProviders,
  },
  briefs: {
    codex: {
      kind: codex.kind,
      provider: codex.provider,
      exactlyOneImage: codex.exactlyOneImage,
      maxCalls: codex.maxCalls,
      layout: codex.layout,
      referenceCount: codex.referenceCount,
      referencePathSource: codex.referencePathSource,
      controlReferences: codex.controlReferences,
      continuityFingerprint: codex.continuityFingerprint,
      continuityNineFieldSummaryCount: codex.continuityNineFieldSummary.length,
      continuityNineFieldSample: codex.continuityNineFieldSummary.slice(0, 3),
      tool: codex.tool,
      promptPrefix: String(codex.prompt).slice(0, 240),
    },
    grok: {
      kind: grok.kind,
      provider: grok.provider,
      exactlyOneImage: grok.exactlyOneImage,
      maxCalls: grok.maxCalls,
      layout: grok.layout,
      referenceCount: grok.referenceCount,
      referencePathSource: grok.referencePathSource,
      controlReferences: grok.controlReferences,
      continuityFingerprint: grok.continuityFingerprint,
      continuityNineFieldSummaryCount: grok.continuityNineFieldSummary.length,
      continuityNineFieldSample: grok.continuityNineFieldSummary.slice(0, 3),
      tool: grok.tool,
      promptPrefix: String(grok.prompt).slice(0, 240),
    },
  },
  call22d2: call22
    ? {
      callId: call22.callId,
      status: call22.status,
      provider: call22.provider,
      callAllowed: call22.callAllowed,
    }
    : null,
};

const outRepo = path.join(root, "docs/evidence/l33-dual-provider-20260723.json");
writeFileSync(outRepo, `${JSON.stringify(evidence, null, 2)}\n`);
if (scratch) {
  writeFileSync(path.join(scratch, "l33-dual-provider-real.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}
console.log(JSON.stringify({
  wrote: outRepo,
  packId: readiness.packId,
  codexRefs: codex.controlReferences.length,
  grokRefs: grok.controlReferences.length,
  nine: codex.continuityNineFieldSummary.length,
  call22: call22?.status ?? null,
}, null, 2));
