import { getStudioContinuityReadiness } from "../src/core/studio-continuity-ledger.ts";
import { STUDIO_CONTINUITY_FIELDS } from "../src/core/studio-continuity.ts";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.ts";
const root = "/Users/hxx/Documents/无限画布/projects/grok-mvp-qingdeng-mrwc97mu-d0aea463";
const unit = await getStudioProductionUnitSnapshot(root, "S1E01-U01");
const panel = unit.panels[0];
const scope = {
  kind: "panel",
  scopeId: panel.id,
  unitId: unit.unit.id,
  unitRevision: unit.unit.revision,
  startMilliseconds: Math.round(panel.startSeconds * 1000),
  endMilliseconds: Math.round(panel.endSeconds * 1000),
};
for (const subjectId of ["character-qingdeng-ke", "scene-rainy-inn-porch", "prop-qingdeng-lantern"]) {
  const r = await getStudioContinuityReadiness(root, {
    scope,
    subjectId,
    requiredFields: [...STUDIO_CONTINUITY_FIELDS],
  });
  console.log("\n===", subjectId, "===");
  console.log(JSON.stringify(r, null, 2).slice(0, 2500));
}
