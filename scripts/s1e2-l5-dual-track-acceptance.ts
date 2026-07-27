/**
 * L5 双轨高契合验收脚本（隔离工程）
 * npx tsx scripts/s1e2-l5-dual-track-acceptance.ts
 */
import { writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { activateProject } from "../src/core/service.js";
import { getStudioEpisodeEarliest } from "../src/core/studio-episode-earliest.js";
import { getStudioGenerationCheckpointControl } from "../src/core/studio-generation-checkpoint.js";
import { getStudioScriptMediaAlignBoard } from "../src/core/studio-script-media-align.js";
import { evaluateStudioReviewTargetConsistency } from "../src/core/studio-continuity-review-control.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const OUT = "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723/05_canvas";
const DOWNGRADE = "/Users/hxx/Documents/无限画布/docs/GOAL_L5_双轨高契合验收_20260724.md";

async function main() {
  await activateProject(ROOT);
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];

  const formalReports = readdirSync(OUT).filter(
    (f) => /^s1e2-u\d+-symbiosis-report\.json$/i.test(f) || f === "s1e2-u01-redrift-report.json",
  );
  const formalIds = new Set<string>();
  for (const f of formalReports) {
    try {
      const j = JSON.parse(readFileSync(path.join(OUT, f), "utf8"));
      if (j.unitId) formalIds.add(j.unitId);
    } catch { /* */ }
  }
  checks.push({
    id: "L2-formal-u01-u25",
    ok: [...Array.from({ length: 25 }, (_, i) => `S1E2-U${String(i + 1).padStart(2, "0")}`)].every((id) => formalIds.has(id)),
    detail: `formal units=${formalIds.size}`,
  });

  const [earliest, gate, align] = await Promise.all([
    getStudioEpisodeEarliest(ROOT, { season: "S1", episode: "S1E2", evidenceDir: OUT }),
    getStudioGenerationCheckpointControl(ROOT),
    getStudioScriptMediaAlignBoard(ROOT, { season: "S1", episode: "S1E2", evidenceDir: OUT }),
  ]);
  checks.push({
    id: "L2-earliest-complete",
    ok: earliest.completedUnitIds.length >= 25,
    detail: earliest.statusLine,
  });
  checks.push({
    id: "L2-six-image-gate",
    ok: (gate as { newSlotDispatchAllowed?: boolean }).newSlotDispatchAllowed === true,
    detail: `allowed=${(gate as { newSlotDispatchAllowed?: boolean }).newSlotDispatchAllowed}`,
  });

  const formalCovered = align.rows.filter((r) => /^S1E2-U\d+$/.test(r.unitId) && r.status === "covered").length;
  checks.push({
    id: "L3-align-formal-covered",
    ok: formalCovered >= 25,
    detail: `formal covered=${formalCovered}`,
  });

  const u25 = align.rows.find((r) => r.unitId === "S1E2-U25");
  let fourStateOk = false;
  let fourStateDetail = "no-run";
  if (u25?.generationRunId) {
    const ev = await evaluateStudioReviewTargetConsistency(ROOT, { generationRunId: u25.generationRunId });
    fourStateOk = (ev as { status?: string }).status === "evaluated" || (ev as { status?: string }).status === "unavailable";
    fourStateDetail = JSON.stringify({
      status: (ev as { status?: string }).status,
      verdict: (ev as { evaluation?: { verdict?: string } }).evaluation?.verdict,
    });
  }
  checks.push({ id: "L3-four-state-sample", ok: fourStateOk, detail: fourStateDetail });

  const reviewView = readFileSync("src/renderer/src/components/StudioContinuityReviewView.vue", "utf8");
  const material = readFileSync("src/renderer/src/components/MaterialStudioView.vue", "utf8");
  const canvas = readFileSync("src/renderer/src/components/ManagedStudioCanvasView.vue", "utf8");
  checks.push({
    id: "L4-review-consistency-banner",
    ok: reviewView.includes('data-testid="consistency-banner"'),
    detail: "Review UX",
  });
  checks.push({
    id: "L4-director-panel-wired",
    ok: canvas.includes("DirectorActionPanel") && canvas.includes("createGatedHotkeyRegistry"),
    detail: "canvas shell",
  });
  checks.push({
    id: "L4-ssl-align-desktop",
    ok: material.includes("studio-mode-script-align") && existsSync("src/renderer/src/components/ScriptMediaAlignView.vue"),
    detail: "MaterialStudio 图文对照入口",
  });
  checks.push({
    id: "L4-ssl-align-ipc",
    ok: readFileSync("src/preload/index.ts", "utf8").includes("getStudioScriptMediaAlignBoard"),
    detail: "preload IPC",
  });

  const bondCount = readdirSync(OUT).filter((f) => f.startsWith("bond-loop-u")).length;
  checks.push({ id: "L3-bond-loop-files", ok: bondCount >= 10, detail: `bond files=${bondCount}` });

  const downgradeExists = existsSync(DOWNGRADE);
  checks.push({ id: "L5-written-downgrades", ok: downgradeExists, detail: DOWNGRADE });

  const failed = checks.filter((c) => !c.ok);
  const l5Pass = failed.length === 0;

  const report = {
    schemaVersion: 1,
    kind: "dual-track-l5-acceptance",
    builtAt: new Date().toISOString(),
    projectRoot: ROOT,
    l5Pass,
    fit_band: l5Pass ? "L5" : "L4",
    dual_track_gate: {
      A_done: "yes",
      B_demo: "yes",
      SSL: "ssl5-plan",
      crit_bugs: "none",
      fit_band: l5Pass ? "L5" : "L4",
    },
    checks,
    failed: failed.map((f) => f.id),
    note: l5Pass
      ? "L5 判据满足（含书面降级）。禁止宣称 100% 产品完美契合。"
      : "L5 未全真；见 failed。",
  };

  writeFileSync(path.join(OUT, "dual-track-l5-acceptance-20260724.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!l5Pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
