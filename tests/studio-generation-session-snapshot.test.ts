import { afterEach, describe, expect, it } from "vitest";
import {
  buildStudioGenerationSessionSnapshot,
  STUDIO_GENERATION_SESSION_SNAPSHOT_SCHEMA_VERSION,
} from "../src/core/studio-generation-session-snapshot.js";
import { getStudioGenerationControlEnvelope } from "../src/core/codex.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

let fixture: StudioP7Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

describe("StudioGenerationSessionSnapshot", () => {
  it("从既有 owner 汇总决策前态势，未持久化 freeze 也能读取当前剧本与参考角色", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    const unit = fixture.units.sixPanel;
    const panel = unit.panels[0]!;

    const first = await buildStudioGenerationSessionSnapshot(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
    });
    const second = await buildStudioGenerationSessionSnapshot(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
    });

    expect(first.schemaVersion).toBe(STUDIO_GENERATION_SESSION_SNAPSHOT_SCHEMA_VERSION);
    expect(first.kind).toBe("studio-generation-session-snapshot");
    expect(first.unit).toMatchObject({
      unitId: unit.unit.id,
      panelId: panel.id,
      panelIndex: panel.index,
      panelCount: 6,
    });
    expect(first.unit.durationSeconds).toBe(2.5);
    expect(first.scriptSpans).toHaveLength(1);
    expect(first.scriptSpans[0]?.endOffsetUtf16).toBeGreaterThan(first.scriptSpans[0]?.startOffsetUtf16 ?? 0);
    expect(first.binding.status).toBe("generation-ready");
    expect(first.binding.bindingSet?.currentness).toBe("current");
    expect(first.referenceRoles.unclassified).toHaveLength(3);
    expect(first.camera.current?.shotType).toBe("original");
    expect(first.previousStanding).toBeNull();
    expect(first.topRisk).toBeNull();
    expect(first.fingerprint).toBe(second.fingerprint);

    const envelope = await getStudioGenerationControlEnvelope(fixture.root, {
      operation: "session-snapshot",
      unitId: unit.unit.id,
      panelId: panel.id,
    });
    expect(envelope).toMatchObject({
      operation: "session-snapshot",
      status: "ready",
      controlReferencesExposed: false,
      snapshot: {
        fingerprint: first.fingerprint,
      },
    });

    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toMatch(/"(?:objectPath|localPath|filePath|path)":/u);
  }, 180_000);
});
