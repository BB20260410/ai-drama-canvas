import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createReadStream } from "node:fs";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { importStudioMedia } from "../src/core/material-studio.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";

const PROJECT = "/Users/hxx/Documents/无限画布/projects/codex-ai-drama-studio";
const OUT = path.join(PROJECT, ".aicanvas", "agent-imagegen-out");
const TAG = "s1-auth-imagegen-v1";

async function exec(step: string, command: string, payload: Record<string, unknown>) {
  const r = await executeIdempotentCommand(PROJECT, {
    requestId: `${TAG}:${step}`,
    idempotencyKey: `${TAG}:${step}`,
    request: { command, payload } as any,
  });
  if (r.status !== "succeeded") {
    throw new Error(`${command} ${r.status}: ${JSON.stringify(r.error)} [${step}]`);
  }
  return r.result as any;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

async function main() {
  const mode = process.argv[2]; // dispatch | register
  const unitId = process.argv[3] || "unit-ep01_15s_001";
  const panelId = process.argv[4] || "panel-01";
  await mkdir(OUT, { recursive: true });
  const manifestPath = path.join(OUT, `${unitId}-${panelId}-manifest.json`);
  const m = JSON.parse(await readFile(manifestPath, "utf8"));
  const runId = `grok-run-${unitId}-${panelId}-v1`;

  if (mode === "dispatch") {
    const result = await exec(`dispatch:${unitId}:${panelId}`, "dispatch_studio_generation_pack", {
      packId: m.packId,
      packFingerprint: m.packFingerprint,
      generationRunId: runId,
      provider: "grok",
      expectedRevision: m.unitRevision,
    });
    await writeFile(path.join(OUT, `dispatch-${unitId}-${panelId}.json`), JSON.stringify({ runId, result }, null, 2));
    console.log(JSON.stringify({ ok: true, runId, result }, null, 2));
    return;
  }

  if (mode === "register") {
    const rawPath = process.argv[5];
    const labeledPath = process.argv[6];
    if (!rawPath) throw new Error("register needs rawPath");
    const rawMedia = await importStudioMedia(PROJECT, { sourcePath: path.resolve(rawPath), kind: "image" });
    const unit = await getStudioProductionDashboard(PROJECT, { operation: "unit", unitId });
    // unit revision for CAS - use snapshot revision from manifest
    const expectedRevision = m.unitRevision;
    const rawReg = await exec(`register-raw:${unitId}:${panelId}`, "register_studio_generation_result", {
      packId: m.packId,
      packFingerprint: m.packFingerprint,
      generationRunId: runId,
      variant: "raw",
      mediaSha256: rawMedia.sha256,
      provider: "grok",
      expectedRevision,
    });
    let labeledReg: unknown = null;
    if (labeledPath) {
      const labeledMedia = await importStudioMedia(PROJECT, {
        sourcePath: path.resolve(labeledPath),
        kind: "image",
      });
      labeledReg = await exec(`register-labeled:${unitId}:${panelId}`, "register_studio_generation_result", {
        packId: m.packId,
        packFingerprint: m.packFingerprint,
        generationRunId: runId,
        variant: "labeled",
        mediaSha256: labeledMedia.sha256,
        provider: "grok",
        expectedRevision,
      });
    }
    const after = await getStudioProductionDashboard(PROJECT, { operation: "unit", unitId });
    await writeFile(
      path.join(OUT, `register-${unitId}-${panelId}.json`),
      JSON.stringify({ runId, raw: rawReg, labeled: labeledReg, rawSha: rawMedia.sha256, afterNext: after.nextAction }, null, 2),
    );
    console.log(JSON.stringify({
      ok: true,
      runId,
      rawSha: rawMedia.sha256,
      afterNext: after.nextAction,
    }, null, 2));
    return;
  }

  throw new Error("mode must be dispatch|register");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
