import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStudioGenerationControlEnvelope } from "../src/core/codex.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";

const PROJECT = "/Users/hxx/Documents/无限画布/projects/codex-ai-drama-studio";
const OUT = path.join(PROJECT, ".aicanvas", "agent-imagegen-out");

async function main() {
  await mkdir(OUT, { recursive: true });
  const unitId = process.argv[2] || "unit-ep01_15s_001";
  const panelId = process.argv[3] || "panel-01";
  const unit = await getStudioProductionDashboard(PROJECT, { operation: "unit", unitId });
  const readiness = await getStudioGenerationControlEnvelope(PROJECT, {
    operation: "readiness",
    unitId,
    panelId,
  } as any);
  await writeFile(path.join(OUT, `${unitId}-${panelId}-readiness.json`), JSON.stringify(readiness, null, 2));
  if ((readiness as any).status !== "ready") {
    console.log(JSON.stringify(readiness, null, 2));
    throw new Error(`not ready: ${(readiness as any).status} ${(readiness as any).code}`);
  }
  const packId = (readiness as any).candidate.packId;
  const packFingerprint = (readiness as any).candidate.fingerprint;
  const packEnv = await getStudioGenerationControlEnvelope(PROJECT, {
    operation: "pack",
    packId,
  } as any);
  await writeFile(path.join(OUT, `${unitId}-${panelId}-pack.json`), JSON.stringify(packEnv, null, 2));

  const controlReferences =
    (packEnv as any).request?.controlReferences
    || (packEnv as any).pack?.request?.controlReferences
    || (packEnv as any).controlReferences
    || [];
  const brief = (readiness as any).agentExecution?.briefs?.grok;
  const renderedPrompt =
    brief?.renderedPrompt
    || (packEnv as any).request?.modelPayload?.renderedPrompt
    || "";

  const manifest = {
    unitId,
    panelId,
    packId,
    packFingerprint,
    unitRevision: (readiness as any).writeCommand?.payload?.expectedRevision,
    provider: "grok" as const,
    renderedPrompt,
    controlReferences: controlReferences.map((r: any) => ({
      assetId: r.assetId,
      category: r.category,
      presence: r.presence,
      role: r.role,
      mediaSha256: r.mediaSha256,
      localPath: r.localPath,
    })),
    brief,
    aspectRatio: "16:9",
  };
  await writeFile(path.join(OUT, `${unitId}-${panelId}-manifest.json`), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({
    unitNext: unit.nextAction?.code,
    packId,
    fp: packFingerprint.slice(0, 16),
    refs: manifest.controlReferences.map((r: any) => ({
      id: r.assetId,
      path: r.localPath,
      existsHint: r.localPath,
    })),
    promptLen: renderedPrompt.length,
    promptHead: renderedPrompt.slice(0, 400),
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
