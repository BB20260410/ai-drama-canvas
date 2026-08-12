import { afterEach, describe, expect, it } from "vitest";
import {
  buildStudioProductionProjectionBundle,
  STUDIO_PROJECTION_BUNDLE_SCHEMA_VERSION,
} from "../src/core/studio-production-projection-bundle.js";
import type { StudioProjectionPhaseTiming } from "../src/core/studio-projection-phase-timeline.js";
import { digestStudioCanonicalJson } from "../src/core/studio-canonical-json.js";
import { queryStudioGenerationFreeze } from "../src/core/studio-generation.js";
import {
  createStudioP7Fixture,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

let fixture: StudioP7Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

describe("StudioProductionProjectionBundle", () => {
  it("一次聚合当前 2–6 格、相邻单元与四轨水位，且不泄漏本机路径", async () => {
    fixture = await createStudioP7Fixture();
    const current = fixture.units.sixPanel;
    const phaseTimings: StudioProjectionPhaseTiming[] = [];
    const bundle = await buildStudioProductionProjectionBundle(fixture.root, {
      unitId: current.unit.id,
      panelId: current.panels[0]!.id,
    }, {
      onPhase: (timing) => phaseTimings.push(timing),
    });

    expect(bundle.schemaVersion).toBe(STUDIO_PROJECTION_BUNDLE_SCHEMA_VERSION);
    expect(bundle.kind).toBe("studio-production-projection-bundle");
    expect(bundle.currentUnit.unitId).toBe(current.unit.id);
    expect(bundle.currentUnit.panels).toHaveLength(6);
    expect(bundle.currentUnit.selectedPanelId).toBe(current.panels[0]!.id);
    expect(bundle.currentUnit.panels.every((panel) => panel.controlAssets.length <= 6)).toBe(true);
    expect(bundle.currentUnit.panels.map((panel) => panel.controlAssets.map((asset) => asset.assetId)))
      .toEqual(current.panels.map((panel) => panel.assets.map((asset) => asset.assetId)));
    expect(bundle.adjacentLocator.previousUnitId).toBeUndefined();
    expect(bundle.adjacentLocator.nextUnitId).toBe(fixture.units.twoPanel.unit.id);
    expect(bundle.adjacentUnits.next?.unitId).toBe(fixture.units.twoPanel.unit.id);
    expect(bundle.timeline.tracks.length).toBeLessThanOrEqual(24);
    expect(bundle.currentUnit.stamp.source).toBe("studio-production-dashboard");
    expect(bundle.timeline.stamp.source).toBe("studio-multimedia-timeline");
    const directFreeze = await queryStudioGenerationFreeze(fixture.root, {
      unitId: current.unit.id,
      panelId: current.panels[0]!.id,
    });
    expect(bundle.currentUnit.panels[0]!.generationFreeze.stamp.fingerprint).toBe(
      directFreeze.status === "ready"
        ? directFreeze.fingerprint
        : digestStudioCanonicalJson(directFreeze),
    );

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toMatch(/"(?:objectPath|localPath|path)":/u);
    expect(phaseTimings.map((timing) => timing.phase)).toEqual([
      "current-dashboard-binding",
      "panel-fanout",
      "timeline-approved-neighbors",
      "observation-review",
      "adjacent-pack-video",
      "frozen-reference-media",
      "assemble-digest",
      "core-total",
    ]);
    expect(phaseTimings.find((timing) => timing.phase === "panel-fanout")).toEqual(expect.objectContaining({
      panelCount: 6,
      controlAssetCount: 18,
      canonicalAssetReadCount: 3,
      durationMs: expect.any(Number),
    }));
    const { fingerprint, ...bodyWithoutFingerprint } = bundle;
    expect(fingerprint).toBe(digestStudioCanonicalJson(bodyWithoutFingerprint));
    expect(phaseTimings.every((timing) => timing.durationMs >= 0)).toBe(true);
  }, 120_000);
});
