/**
 * P9-R 规模证据：精确计数 + 可解码媒体 + 生产路径非零。
 * 默认 1288 单元；可用环境变量缩小：
 *   P9_SCALE_UNITS=24 P9_SCALE_ASSETS=12 P9_SCALE_MEDIA_META=20
 */
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  P9_SCALE_ASSET_COUNT,
  P9_SCALE_UNIT_COUNT,
  createStudioScaleMetadataFixture,
  expectedPanelCountForUnits,
} from "../src/core/studio-scale-fixture.js";
import { planStudioMediaGc } from "../src/core/studio-media-gc.js";
import { preflightStudioDisk, probeStudioScale } from "../src/core/studio-reliability.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";
import { getStudioProductionState } from "../src/core/studio-production.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspace, "docs", "evidence");
const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
const outputPath = path.resolve(
  process.argv[2] || path.join(evidenceRoot, `p9-scale-fixture-${stamp}.json`),
);

const unitCount = Number(process.env.P9_SCALE_UNITS || P9_SCALE_UNIT_COUNT);
const assetCount = Number(process.env.P9_SCALE_ASSETS || P9_SCALE_ASSET_COUNT);
const mediaMetaCount = Number(process.env.P9_SCALE_MEDIA_META || 30);
const seedProductionPath = process.env.P9_SCALE_SEED_PRODUCTION !== "0";
const realAvDerivatives = process.env.P9_SCALE_REAL_AV !== "0";

const parent = await realpath(await mkdtemp(path.join("/tmp", "p9-scale-full-")));
const started = Date.now();
const fixture = await createStudioScaleMetadataFixture({
  parentRoot: parent,
  unitCount,
  assetCount,
  mediaMetaCount,
  seedProductionPath,
  realAvDerivatives,
  name: "P9-R 规模证据",
});
const expectedPanels = expectedPanelCountForUnits(unitCount);
const production = await getStudioProductionState(fixture.root);
const [preflight, scale, gc, overview] = await Promise.all([
  preflightStudioDisk(fixture.root),
  probeStudioScale(fixture.root),
  planStudioMediaGc(fixture.root),
  getStudioProductionDashboard(fixture.root, { operation: "overview" }),
]);
if (overview.operation !== "overview") throw new Error("overview 失败");

const exactMatch = production.counts.panels === expectedPanels
  && overview.counts.panels === expectedPanels
  && overview.counts.panelsEstimated === expectedPanels
  && fixture.dashboard.panelsMatchExact;

const productionPathOk = !seedProductionPath || (
  fixture.counts.productionPath.bindingSets >= 6
  && fixture.counts.productionPath.continuityReady
  && fixture.counts.productionPath.generationRuns >= 6
  && fixture.counts.productionPath.reviews >= 6
  && fixture.counts.assetBindingSets >= 6
);

const mediaOk = fixture.mediaQuality.placeholderSignatureOnly === false
  && fixture.mediaQuality.imageWidth >= 48
  && fixture.mediaQuality.imageHeight >= 64;

const status = exactMatch && productionPathOk && mediaOk ? "pass" : "partial";

const evidence = {
  schemaVersion: 2,
  kind: "p9-scale-fixture-evidence",
  status,
  createdAt: new Date().toISOString(),
  durationMs: Date.now() - started,
  requested: {
    unitCount,
    assetCount,
    mediaMetaCount,
    expectedPanels,
    seedProductionPath,
    realAvDerivatives,
  },
  observed: fixture.counts,
  dashboard: {
    overviewFingerprint: overview.fingerprint,
    unitsPageSize: fixture.dashboard.unitsPageSize,
    unitsHardCap: 36,
    panels: overview.counts.panels,
    panelsEstimated: overview.counts.panelsEstimated,
    panelsExactMatch: exactMatch,
  },
  mediaQuality: fixture.mediaQuality,
  productionPath: fixture.counts.productionPath,
  preflight,
  scaleProbe: scale,
  gcDryRun: {
    scannedObjects: gc.scannedObjects,
    candidateCount: gc.candidates.length,
    fingerprint: gc.fingerprint,
  },
  gates: {
    exactPanelCount: exactMatch,
    productionPathNonZero: productionPathOk,
    realDecodableMedia: mediaOk,
  },
  boundaries: {
    formalImageGenerationCalls: 0,
    browserSupplierCalls: 0,
    formalStudioUntouched: true,
    realImagegenCanary: false,
  },
  notes: [
    "panels 为 studio_production_units.panel_count 的 SQL SUM，非首屏抽样。",
    "图片为 sharp 真 PNG；视频/音频在 ffmpeg 可用时生成并物化派生。",
    "首单元 6 宫格含 BindingSet、九字段、freeze/dispatch/register/Review。",
  ],
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
await fixture.cleanup();
console.log(JSON.stringify({
  ok: status === "pass",
  status,
  outputPath,
  units: fixture.counts.units,
  panels: fixture.counts.panels,
  expectedPanels,
  exactMatch,
  productionPath: fixture.counts.productionPath,
  mediaQuality: fixture.mediaQuality,
  durationMs: evidence.durationMs,
}, null, 2));
if (status !== "pass") process.exitCode = 1;
