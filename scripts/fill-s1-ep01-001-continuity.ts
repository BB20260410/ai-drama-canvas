/**
 * unit-ep01_15s_001：按 Binding 主体写满九字段 continuity observation。
 * 全部经 executeIdempotentCommand；可选单格 freeze_studio_generation_pack（不 dispatch）。
 */
import { writeFile, readFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";
import {
  getCurrentStudioPanelAssetBindingSet,
  getStudioProductionUnitSnapshot,
} from "../src/core/studio-production.js";
import { getStudioContinuityReviewControl } from "../src/core/studio-continuity-review-control.js";
import { getStudioCanonicalAsset } from "../src/core/material-studio.js";
import { STUDIO_CONTINUITY_FIELDS } from "../src/core/studio-continuity.js";
import {
  assertNineFieldCoverage,
  planContinuityFieldsForSubject,
} from "../src/core/studio-continuity-explicit-plan.js";

const PROJECT =
  "/Users/hxx/Documents/无限画布/projects/codex-ai-drama-studio";
const UNIT_ID = "unit-ep01_15s_001";
const TAG = "s1-ep01-001-cont-v1";
const PROGRESS = path.join(PROJECT, ".aicanvas", "s1-ep01-continuity-progress.json");
const SCRATCH =
  process.env.SCRATCH ||
  "/var/folders/bt/q4f2706n013cbd5m4h6rb6tr0000gn/T/grok-goal-e48e0f81a494/implementer";

type Progress = {
  phase: string;
  unitId: string;
  written: Array<{
    panelId: string;
    subjectId: string;
    field: string;
    step: string;
    status: string;
  }>;
  freezePack?: unknown;
  errors: Array<{ step: string; message: string }>;
  updatedAt: string;
};

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function loadProgress(): Promise<Progress> {
  if (await exists(PROGRESS)) {
    return JSON.parse(await readFile(PROGRESS, "utf8")) as Progress;
  }
  return {
    phase: "init",
    unitId: UNIT_ID,
    written: [],
    errors: [],
    updatedAt: new Date().toISOString(),
  };
}

async function saveProgress(p: Progress) {
  p.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(PROGRESS), { recursive: true });
  await writeFile(PROGRESS, JSON.stringify(p, null, 2), "utf8");
}

async function exec(step: string, command: string, payload: Record<string, unknown>) {
  const result = await executeIdempotentCommand(PROJECT, {
    requestId: `${TAG}:${step}`,
    idempotencyKey: `${TAG}:${step}`,
    request: { command, payload } as any,
  });
  if (result.status !== "succeeded") {
    throw new Error(
      `${command} ${result.status}: ${result.error?.message ?? "unknown"} [${step}]`,
    );
  }
  return result.result;
}

async function main() {
  await mkdir(SCRATCH, { recursive: true });
  const progress = await loadProgress();
  progress.phase = "writing";

  const overviewBefore = await getStudioProductionDashboard(PROJECT, {
    operation: "overview",
  });
  if (overviewBefore.operation !== "overview") throw new Error("dashboard overview 响应类型错误");
  const unitBefore = await getStudioProductionDashboard(PROJECT, {
    operation: "unit",
    unitId: UNIT_ID,
  });
  await writeFile(
    path.join(SCRATCH, "dashboard-overview-before-continuity.json"),
    JSON.stringify(overviewBefore, null, 2),
  );
  await writeFile(
    path.join(SCRATCH, "dashboard-unit-ep01_15s_001-before.json"),
    JSON.stringify(unitBefore, null, 2),
  );

  const snap = await getStudioProductionUnitSnapshot(PROJECT, UNIT_ID);
  if (!snap) throw new Error("unit snapshot missing");
  const unitRevision = snap.unit.revision;

  const doneKeys = new Set(
    progress.written
      .filter((w) => w.status === "ok" || w.status === "replayed")
      .map((w) => `${w.panelId}|${w.subjectId}|${w.field}`),
  );

  for (const panel of snap.panels) {
    const startMilliseconds = Math.round(panel.startSeconds * 1000);
    const endMilliseconds = Math.round(panel.endSeconds * 1000);
    const binding = await getCurrentStudioPanelAssetBindingSet(
      PROJECT,
      UNIT_ID,
      panel.id,
    );
    if (!binding) throw new Error(`no binding for ${panel.id}`);
    const subjects = binding.bindings.filter((b) => b.presence !== "forbidden");

    for (const subject of subjects) {
      const plans = planContinuityFieldsForSubject({
        assetId: subject.assetId,
        category: subject.category as "character" | "scene" | "prop",
        role: subject.role,
        mediaSha256: subject.mediaSha256,
        visualAction: panel.visualAction,
        panelIndex: panel.index,
        startMilliseconds,
        endMilliseconds,
      });
      assertNineFieldCoverage(plans);

      for (const plan of plans) {
        const key = `${panel.id}|${subject.assetId}|${plan.field}`;
        if (doneKeys.has(key)) continue;
        const step = `obs:${panel.id}:${subject.assetId}:${plan.field}`;
        try {
          await exec(step, "append_studio_continuity_observation", {
            expectedHeadRevision: 0,
            scope: {
              kind: "panel",
              scopeId: panel.id,
              unitId: UNIT_ID,
              unitRevision,
              startMilliseconds,
              endMilliseconds,
            },
            subjectId: subject.assetId,
            field: plan.field,
            state: plan.state,
          });
          progress.written.push({
            panelId: panel.id,
            subjectId: subject.assetId,
            field: plan.field,
            step,
            status: "ok",
          });
          doneKeys.add(key);
          if (progress.written.length % 18 === 0) {
            console.log(
              `[cont] written=${progress.written.length} last=${step}`,
            );
            await saveProgress(progress);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // head may already be 1 if partial run without progress — try read is hard; log and continue if replay-like
          if (/期望 revision=0，实际 revision=1|幂等键已用于不同参数/.test(message)) {
            progress.written.push({
              panelId: panel.id,
              subjectId: subject.assetId,
              field: plan.field,
              step,
              status: "skip-exists",
            });
            doneKeys.add(key);
            continue;
          }
          progress.errors.push({ step, message });
          await saveProgress(progress);
          throw error;
        }
      }
    }
  }
  await saveProgress(progress);
  console.log(`[cont] observations done count=${progress.written.length}`);

  // Continuity review control for each panel
  const reviewPanels = [];
  for (const panel of snap.panels) {
    const binding = await getCurrentStudioPanelAssetBindingSet(
      PROJECT,
      UNIT_ID,
      panel.id,
    );
    const assetIds = (binding?.bindings ?? []).map((b) => b.assetId).sort();
    const control = await getStudioContinuityReviewControl(PROJECT, {
      unitId: UNIT_ID,
      unitRevision,
      panelId: panel.id,
      startMilliseconds: Math.round(panel.startSeconds * 1000),
      endMilliseconds: Math.round(panel.endSeconds * 1000),
      assetIds,
    });
    reviewPanels.push({
      panelId: panel.id,
      nextAction: control.nextAction,
      assets: control.assets.map((a) => ({
        assetId: a.assetId,
        ready: a.ready,
        blockers: a.blockers,
        fields: a.fields,
      })),
      openConflicts: control.conflicts.items,
    });
  }
  await writeFile(
    path.join(SCRATCH, "continuity-review-ep01_15s_001.json"),
    JSON.stringify({ unitId: UNIT_ID, unitRevision, panels: reviewPanels }, null, 2),
  );

  const notReady = reviewPanels.flatMap((p) =>
    p.assets.filter((a) => !a.ready).map((a) => ({
      panelId: p.panelId,
      assetId: a.assetId,
      blockers: a.blockers,
    })),
  );
  if (notReady.length > 0) {
    console.error("[cont] NOT READY", JSON.stringify(notReady, null, 2));
    progress.errors.push({
      step: "readiness",
      message: `not ready: ${notReady.length}`,
    });
    await saveProgress(progress);
    process.exitCode = 2;
  }

  // Optional freeze pack on panel-01 if unit nextAction allows
  const unitMid = await getStudioProductionDashboard(PROJECT, {
    operation: "unit",
    unitId: UNIT_ID,
  });
  await writeFile(
    path.join(SCRATCH, "dashboard-unit-ep01_15s_001-mid.json"),
    JSON.stringify(unitMid, null, 2),
  );

  if (
    unitMid.nextAction?.code === "freeze-generation-pack"
    || unitMid.nextAction?.command === "freeze_studio_generation_pack"
    || !notReady.length
  ) {
    try {
      // re-check panel-01 readiness already done
      const freeze = await exec(
        "freeze-pack:panel-01",
        "freeze_studio_generation_pack",
        {
          unitId: UNIT_ID,
          panelId: "panel-01",
          expectedRevision: unitRevision,
        },
      );
      progress.freezePack = freeze;
      await writeFile(
        path.join(SCRATCH, "freeze-pack-panel-01.json"),
        JSON.stringify(freeze, null, 2),
      );
      console.log("[cont] freeze pack OK (no dispatch)", (freeze as any)?.packId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      progress.freezePack = { skipped: true, message };
      console.log("[cont] freeze pack skipped:", message);
      await writeFile(
        path.join(SCRATCH, "freeze-pack-panel-01.json"),
        JSON.stringify({ skipped: true, message }, null, 2),
      );
    }
  } else {
    progress.freezePack = {
      skipped: true,
      reason: "unit nextAction still continuity or readiness incomplete",
      nextAction: unitMid.nextAction,
    };
    await writeFile(
      path.join(SCRATCH, "freeze-pack-panel-01.json"),
      JSON.stringify(progress.freezePack, null, 2),
    );
  }

  // hardlock spotcheck
  const hardlockIds = [
    "character-wangqing",
    "character-wuzhu-female",
    "character-r07-dudu",
    "character-a01-energy",
    "prop-d01-golden-mask",
  ];
  const hardlock: Record<string, unknown> = {};
  for (const id of hardlockIds) {
    const a = await getStudioCanonicalAsset(PROJECT, id);
    hardlock[id] = {
      name: a?.name,
      primaryAuthority: a?.primaryAuthority,
      negativeLocks: a?.negativeLocks,
      revision: a?.revision,
    };
  }
  await writeFile(
    path.join(SCRATCH, "hardlock-spotcheck-after-continuity.json"),
    JSON.stringify(hardlock, null, 2),
  );

  const overviewAfter = await getStudioProductionDashboard(PROJECT, {
    operation: "overview",
  });
  if (overviewAfter.operation !== "overview") throw new Error("dashboard overview 响应类型错误");
  const unitAfter = await getStudioProductionDashboard(PROJECT, {
    operation: "unit",
    unitId: UNIT_ID,
  });
  await writeFile(
    path.join(SCRATCH, "dashboard-overview-after-continuity.json"),
    JSON.stringify(overviewAfter, null, 2),
  );
  await writeFile(
    path.join(SCRATCH, "dashboard-unit-ep01_15s_001-after-continuity.json"),
    JSON.stringify(unitAfter, null, 2),
  );
  // reread
  const unitAfter2 = await getStudioProductionDashboard(PROJECT, {
    operation: "unit",
    unitId: UNIT_ID,
  });
  await writeFile(
    path.join(SCRATCH, "dashboard-unit-ep01_15s_001-after-continuity-reread.json"),
    JSON.stringify(unitAfter2, null, 2),
  );

  progress.phase = "done";
  await saveProgress(progress);

  const costumeBlocking =
    typeof unitAfter.nextAction?.reason === "string"
    && unitAfter.nextAction.reason.includes("costume")
    && unitAfter.nextAction.reason.includes("没有显式状态");

  console.log(
    JSON.stringify(
      {
        written: progress.written.length,
        expectedMin: 6 * 2 * STUDIO_CONTINUITY_FIELDS.length,
        errors: progress.errors.length,
        notReadyCount: notReady.length,
        unitNextAction: unitAfter.nextAction,
        costumeStillBlocking: costumeBlocking,
        freezePack: progress.freezePack && typeof progress.freezePack === "object"
          ? {
              packId: (progress.freezePack as any).packId,
              skipped: (progress.freezePack as any).skipped,
            }
          : progress.freezePack,
        assetBindingSets: overviewAfter.counts.assetBindingSets,
      },
      null,
      2,
    ),
  );

  if (costumeBlocking || notReady.length > 0) process.exitCode = 3;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
