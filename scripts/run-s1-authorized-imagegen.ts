/**
 * 用户授权后：dispatch(provider=grok) → 读 pack brief+localPath → Agent 生图 → import media → register raw
 * 不做 labeled 伪通过；labeled 若合同要求则单独登记真实文件。
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { getStudioGenerationControlEnvelope } from "../src/core/codex.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";
import { buildStudioAgentImagegenBrief } from "../src/core/studio-generation.js";
import { importStudioMedia } from "../src/core/material-studio.js";

const PROJECT = "/Users/hxx/Documents/无限画布/projects/codex-ai-drama-studio";
const TAG = "s1-auth-imagegen-v1";
const OUT = path.join(PROJECT, ".aicanvas", "agent-imagegen-out");

async function exec(step: string, command: string, payload: Record<string, unknown>) {
  const r = await executeIdempotentCommand(PROJECT, {
    requestId: `${TAG}:${step}`,
    idempotencyKey: `${TAG}:${step}`,
    request: { command, payload } as any,
  });
  if (r.status !== "succeeded") {
    throw new Error(`${command} ${r.status}: ${r.error?.message ?? "unknown"} [${step}]`);
  }
  return r.result as any;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const unitId = process.argv[2] || "unit-ep01_15s_001";
  const panelId = process.argv[3] || "panel-01";

  const unit = await getStudioProductionDashboard(PROJECT, { operation: "unit", unitId });
  console.log("unit nextAction", JSON.stringify(unit.nextAction));

  // readiness / pack via envelope
  const readiness = await getStudioGenerationControlEnvelope(PROJECT, {
    operation: "readiness",
    unitId,
    panelId,
  } as any);
  await writeFile(path.join(OUT, `${unitId}-${panelId}-readiness.json`), JSON.stringify(readiness, null, 2));
  console.log("readiness keys", Object.keys(readiness as any));

  const packId =
    (readiness as any).packId
    || (readiness as any).pack?.id
    || (readiness as any).readyPackId
    || (readiness as any).currentPackId;

  // if readiness has pack fingerprint use it
  let packFingerprint =
    (readiness as any).packFingerprint
    || (readiness as any).pack?.fingerprint
    || (readiness as any).fingerprint;

  const packEnv = await getStudioGenerationControlEnvelope(PROJECT, {
    operation: "pack",
    ...(packId ? { packId } : { unitId, panelId }),
  } as any);
  await writeFile(path.join(OUT, `${unitId}-${panelId}-pack.json`), JSON.stringify(packEnv, null, 2));
  console.log("pack env keys", Object.keys(packEnv as any));

  // Extract pack + verified paths
  const pack = (packEnv as any).pack || (packEnv as any).result?.pack || packEnv;
  const resolvedPackId = pack.id || pack.packId || packId;
  const resolvedFp = pack.fingerprint || packFingerprint;
  const request = pack.request || (packEnv as any).request;
  const controlRefs =
    (packEnv as any).controlReferences
    || request?.controlReferences
    || [];

  console.log(JSON.stringify({
    packId: resolvedPackId,
    fingerprint: resolvedFp?.slice?.(0, 16),
    refs: controlRefs.map((r: any) => ({
      assetId: r.assetId,
      sha: (r.mediaSha256 || "").slice(0, 12),
      localPath: r.localPath,
    })),
    promptHead: (request?.modelPayload?.renderedPrompt || request?.renderedPrompt || "").slice(0, 300),
  }, null, 2));

  // write brief for agent
  // pack object for brief may need full freeze pack shape
  let brief: any = null;
  try {
    if (pack.kind === "studio-generation-freeze-pack") {
      brief = buildStudioAgentImagegenBrief(pack, "grok");
    }
  } catch (e: any) {
    console.log("brief build skip", e.message?.slice(0, 150));
  }
  if (brief) {
    await writeFile(path.join(OUT, `${unitId}-${panelId}-brief.json`), JSON.stringify(brief, null, 2));
  }

  // Export paths for outer shell to call image tools
  const manifest = {
    unitId,
    panelId,
    packId: resolvedPackId,
    packFingerprint: resolvedFp,
    provider: "grok",
    renderedPrompt: request?.modelPayload?.renderedPrompt || brief?.renderedPrompt || "",
    controlReferences: controlRefs,
    aspectRatio: "16:9",
  };
  await writeFile(path.join(OUT, `${unitId}-${panelId}-manifest.json`), JSON.stringify(manifest, null, 2));
  console.log("MANIFEST_WRITTEN", path.join(OUT, `${unitId}-${panelId}-manifest.json`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
