import { performance } from "node:perf_hooks";
import { buildStudioProductionProjectionBundle } from "../src/core/studio-production-projection-bundle.js";
import type { StudioProjectionPhaseTiming } from "../src/core/studio-projection-phase-timeline.js";
import { createStudioP7Fixture } from "../tests/helpers/studio-p7-fixture.js";

const fixture = await createStudioP7Fixture();
try {
  const current = fixture.units.sixPanel;
  const phases: StudioProjectionPhaseTiming[] = [];
  const startedAt = performance.now();
  await buildStudioProductionProjectionBundle(fixture.root, {
    unitId: current.unit.id,
    panelId: current.panels[0]!.id,
  }, {
    onPhase: (timing) => phases.push(timing),
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: "studio-projection-bundle-phase-benchmark",
    fixture: { panelCount: current.panels.length, adjacentUnitCount: 1 },
    wallDurationMs: performance.now() - startedAt,
    phases,
  }, null, 2)}\n`);
} finally {
  await fixture.cleanup();
}
