import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioUnitGridGenerationPack,
  prepareStudioImagegenCall,
  readStudioImagegenCallIntentByRun,
} from "../src/core/studio-generation-ledger.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedPanelContinuity,
  studioP7UserContinuationWaiver,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

const originalRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
let fixture: StudioP7Fixture | undefined;

afterEach(async () => {
  if (originalRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = originalRegistry;
  await fixture?.cleanup();
  fixture = undefined;
});

describe("Studio generation callerAgentId", () => {
  it("首次 pre-call 原子记录调用代理，重放不改写且不同代理不能冒认旧 intent", async () => {
    fixture = await createStudioP7Fixture();
    process.env.AI_CANVAS_REGISTRY_PATH = path.join(fixture.parentRoot, "projects.json");
    await registerProject(fixture.shell.project);
    await setActiveProjectRegistration(fixture.root);
    const unit = fixture.units.twoPanel;
    for (const panel of unit.panels) {
      await seedStudioP7ResolvedPanelContinuity(fixture.root, {
        unitId: unit.unit.id,
        panelId: panel.id,
        assetIds: panel.assets
          .filter((asset) => asset.presence !== "forbidden")
          .map((asset) => asset.assetId),
      });
    }
    const frozen = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
      targetKind: "unit-grid",
      unitId: unit.unit.id,
      continuationWaiver: await studioP7UserContinuationWaiver(
        fixture.root,
        unit,
        "fixture:caller-agent-id",
      ),
    });
    const generationRunId = "caller-agent-audit-run-0001";
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "codex",
    });
    const context = await getActiveManagedStudioContext();
    const input = {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "codex" as const,
      projectContextToken: context.projectContextToken,
      commandRequestId: "caller-agent-command-0001",
      callerAgentId: "codex-session-fixture-0001",
      expectedRevision: 0 as const,
    };

    await expect(prepareStudioImagegenCall(fixture.root, input)).resolves.toMatchObject({
      generationRunId,
      callerAgentId: input.callerAgentId,
      callAllowed: true,
      idempotentReplay: false,
    });
    await expect(readStudioImagegenCallIntentByRun(fixture.root, generationRunId))
      .resolves.toMatchObject({
        generationRunId,
        callerAgentId: input.callerAgentId,
        callAllowed: false,
      });
    await expect(prepareStudioImagegenCall(fixture.root, {
      ...input,
      commandRequestId: "caller-agent-command-replay-0002",
    })).resolves.toMatchObject({
      callerAgentId: input.callerAgentId,
      callAllowed: false,
      idempotentReplay: true,
    });
    await expect(prepareStudioImagegenCall(fixture.root, {
      ...input,
      commandRequestId: "caller-agent-command-conflict-0003",
      callerAgentId: "codex-session-fixture-0002",
    })).rejects.toMatchObject({ code: "call-intent-conflict" });
  }, 180_000);
});
