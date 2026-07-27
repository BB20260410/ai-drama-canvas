import { createHash } from "node:crypto";
import path from "node:path";
import { materializeAllFusionStoryboardGrids, buildFusionStoryboardGridForProject } from "../src/core/fusion-storyboard-production.js";
import { FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION } from "../src/core/fusion-storyboard-grid.js";
import { readJson, writeJsonAtomicExclusive } from "../src/core/sidecar.js";

const projectRoot = path.resolve(process.argv[2] ?? "/Users/hxx/Documents/无限画布/productions/gushujuan-s3-f1a688020bfb7af6");
const evidencePath = path.resolve(process.argv[3] ?? "/Users/hxx/Documents/无限画布/docs/evidence/fusion-s3-storyboard-grids-semantic-v1-visible-time-policy-v1-20260716.json");

function validDistribution(distribution: Record<string, number>, expectedUnits: number): boolean {
  return Object.entries(distribution).every(([key, value]) => ["2", "3", "4", "5", "6"].includes(key) && Number.isInteger(value) && value > 0)
    && Object.values(distribution).reduce((sum, value) => sum + value, 0) === expectedUnits;
}

async function main(): Promise<void> {
  const result = await materializeAllFusionStoryboardGrids(projectRoot);
  if (result.algorithmVersion !== FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION
    || result.contracts !== 1_288
    || !validDistribution(result.panelDistribution, 1_288)
    || result.panelImagesRequired < 1_288 * 2
    || result.panelImagesRequired > 1_288 * 6) {
    throw new Error(`全季剧情节拍宫格计数无效：${JSON.stringify(result)}`);
  }
  const ep01Contracts = [];
  for (let sequence = 1; sequence <= 34; sequence += 1) {
    ep01Contracts.push(await buildFusionStoryboardGridForProject(projectRoot, `season-三-ep01-unit${String(sequence).padStart(3, "0")}`));
  }
  const ep01PanelDistribution = ep01Contracts.reduce<Record<string, number>>((distribution, contract) => {
    const key = String(contract.selection.panelCount);
    distribution[key] = (distribution[key] ?? 0) + 1;
    return distribution;
  }, {});
  const ep01PanelImagesRequired = ep01Contracts.reduce((sum, contract) => sum + contract.selection.panelCount, 0);
  if (!validDistribution(ep01PanelDistribution, 34)
    || ep01PanelImagesRequired < 68
    || ep01PanelImagesRequired > 204
    || ep01Contracts.some((contract) => contract.selection.algorithmVersion !== FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION
      || contract.panels.some((panel) => !panel.semanticBeats.length || panel.imageGenerationPrompt.includes("段内转折时刻")))) {
    throw new Error(`EP01 剧情节拍宫格合同无效：${JSON.stringify({ ep01PanelDistribution, ep01PanelImagesRequired })}`);
  }
  const contractIdsSha256 = createHash("sha256").update(result.contractIds.join("\n")).digest("hex");
  const report = {
    schemaVersion: 2,
    kind: "fusion-storyboard-grid-materialization-validation",
    createdAt: new Date().toISOString(),
    projectRoot,
    sourceContentAddress: result.sourceContentAddress,
    allSeason: {
      algorithmVersion: result.algorithmVersion,
      visibleTimePolicyVersion: result.visibleTimePolicyVersion,
      contracts: result.contracts,
      panelDistribution: result.panelDistribution,
      panelImagesRequired: result.panelImagesRequired,
      contractIdsSha256InputCount: result.contractIds.length,
      contractIdsSha256,
    },
    ep01: {
      units: ep01Contracts.length,
      panelDistribution: ep01PanelDistribution,
      panelImagesRequired: ep01PanelImagesRequired,
      originalStartFrames: 34,
      originalEndFrames: 34,
      additionalMiddleFrames: ep01PanelImagesRequired - 68,
      localChineseStoryboardSheets: 34,
      rawImagesRequired: ep01PanelImagesRequired,
      labeledImagesRequired: ep01PanelImagesRequired,
    },
    policy: {
      minimumPanels: 2,
      maximumPanels: 6,
      automaticSelection: "semantic-beat-audited",
      algorithmVersion: FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION,
      oneImagePerPanel: true,
      aiGeneratedTextAllowed: false,
      chineseTextRenderedLocally: true,
      visibleTimeQuantization: "one-decimal-boundaries-then-difference",
      visiblePanelDurationsSumToExactlyFifteen: true,
      silentReferenceTruncationAllowed: false,
    },
  };
  const existing = await readJson<typeof report | null>(evidencePath, null);
  if (existing) {
    const stable = (value: typeof report) => JSON.stringify({ ...value, createdAt: "<run-time>" });
    if (stable(existing) !== stable(report)) throw new Error(`既有语义宫格证据与当前结果冲突：${evidencePath}`);
  } else {
    await writeJsonAtomicExclusive(evidencePath, report);
  }
  process.stdout.write(`${JSON.stringify({ evidencePath, reusedEvidence: Boolean(existing), ...report.allSeason, ep01: report.ep01 }, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
