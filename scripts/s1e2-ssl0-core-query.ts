/**
 * SSL-0 Core 投影实跑：隔离工程 ScriptLibraryIndex + S1E2 UnitSpanMediaMap
 * npx tsx scripts/s1e2-ssl0-core-query.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { activateProject } from "../src/core/service.js";
import {
  getStudioScriptLibraryIndex,
  getStudioEpisodeUnitMediaMap,
} from "../src/core/studio-script-library-projection.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const OUT = "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723/05_canvas";

async function main() {
  await activateProject(ROOT);
  const index = await getStudioScriptLibraryIndex(ROOT, { kind: "script", limit: 50 });
  const map = await getStudioEpisodeUnitMediaMap(ROOT, { season: "S1", episode: "S1E2", limit: 100 });

  mkdirSync(OUT, { recursive: true });
  const indexPath = path.join(OUT, "ssl0-core-script-library-index-20260724.json");
  const mapPath = path.join(OUT, "ssl0-core-episode-unit-media-map-s1e2-20260724.json");
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  writeFileSync(mapPath, JSON.stringify(map, null, 2));

  const missing = map.units.filter((u) => u.coveredPanelCount === 0).map((u) => u.unitId);
  const report = {
    ok: true,
    indexPath,
    mapPath,
    documentCount: index.documentCount,
    unitCount: map.unitCount,
    withAnyMedia: map.withAnyMedia,
    missingAllMedia: map.missingAllMedia,
    missingUnitIds: missing,
    sampleUnit: map.units.find((u) => u.unitId === "S1E2-U25") ?? map.units[map.units.length - 1] ?? null,
  };
  writeFileSync(path.join(OUT, "ssl0-core-query-report-20260724.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
