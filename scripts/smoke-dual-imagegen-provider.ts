import { createStudioP7Fixture, seedStudioP7ResolvedContinuity } from "../tests/helpers/studio-p7-fixture.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import { buildStudioAgentImagegenBrief } from "../src/core/studio-generation.js";

async function main() {
  const fixture = await createStudioP7Fixture();
  try {
    await seedStudioP7ResolvedContinuity(fixture);
    const panel = fixture.units.twoPanel.panels[0]!;
    const pack = await freezeAndPersistStudioGenerationPack(fixture.root, {
      unitId: fixture.units.twoPanel.unit.id,
      panelId: panel.id,
    });
    if (pack.pack.request.executorKind !== "agent-imagegen") {
      throw new Error(`unexpected executorKind ${pack.pack.request.executorKind}`);
    }
    if (pack.pack.request.allowedProviders.join(",") !== "codex,grok") {
      throw new Error(`unexpected allowedProviders ${pack.pack.request.allowedProviders.join(",")}`);
    }
    const briefGrok = buildStudioAgentImagegenBrief(pack.pack, "grok");
    const briefCodex = buildStudioAgentImagegenBrief(pack.pack, "codex");
    const media = fixture.panelMediaPairs.find((entry) => entry.panelId === panel.id)!;
    for (const provider of ["codex", "grok"] as const) {
      const generationRunId = `dual-${provider}-run`;
      const dispatch = await dispatchStudioGenerationPack(fixture.root, {
        packId: pack.packId,
        packFingerprint: pack.fingerprint,
        generationRunId,
        provider,
      });
      if (dispatch.provider !== provider) throw new Error(`dispatch provider ${dispatch.provider}`);
      const raw = await registerStudioGenerationResult(fixture.root, {
        packId: pack.packId,
        packFingerprint: pack.fingerprint,
        generationRunId,
        variant: "raw",
        mediaSha256: media.raw.imported.sha256,
        provider,
      });
      if (raw.provider !== provider) throw new Error(`raw provider ${raw.provider}`);
      const labeled = await registerStudioGenerationResult(fixture.root, {
        packId: pack.packId,
        packFingerprint: pack.fingerprint,
        generationRunId,
        variant: "labeled",
        mediaSha256: media.labeled.imported.sha256,
        provider,
      });
      if (labeled.provider !== provider) throw new Error(`labeled provider ${labeled.provider}`);
    }
    console.log(JSON.stringify({
      ok: true,
      executorKind: pack.pack.request.executorKind,
      allowedProviders: pack.pack.request.allowedProviders,
      briefTools: {
        codex: briefCodex.toolHints.primaryTool,
        grok: briefGrok.toolHints.primaryTool,
      },
    }, null, 2));
  } finally {
    await fixture.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
