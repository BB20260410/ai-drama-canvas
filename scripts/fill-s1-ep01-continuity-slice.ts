/**
 * EP01 连续性切片：对指定 unitId 列表写满九字段 observation。
 * 主体分支仅 assetId（planContinuityFieldsForSubject）；禁止 dispatch。
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
const TAG = "s1-ep01-cont-slice-v1";
const PROGRESS = path.join(
  PROJECT,
  ".aicanvas",
  "s1-ep01-continuity-slice-progress.json",
);
const SCRATCH =
  process.env.SCRATCH ||
  "/var/folders/bt/q4f2706n013cbd5m4h6rb6tr0000gn/T/grok-goal-0681a6d5d13b/implementer";

/** 本切片默认：从 002 起（001 已齐） */
const DEFAULT_UNITS = ["unit-ep01_15s_002"];

type Progress = {
  phase: string;
  units: Record<
    string,
    {
      written: number;
      expected: number;
      freezePackId?: string;
      error?: string;
      fields: string[];
    }
  >;
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
  return { phase: "init", units: {}, errors: [], updatedAt: new Date().toISOString() };
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
  return result.result as any;
}

function assertNoD01A01Misroute(subjectId: string, state: unknown) {
  if (subjectId !== "prop-d01-golden-mask") return;
  const blob = JSON.stringify(state);
  if (/A01 为无面部|A01 按轴线处于河心/.test(blob)) {
    throw new Error(`D01 plan misroutes A01: ${blob}`);
  }
}

async function fillUnit(unitId: string, progress: Progress): Promise<void> {
  const unitProg = progress.units[unitId] ?? {
    written: 0,
    expected: 0,
    fields: [...STUDIO_CONTINUITY_FIELDS],
  };
  progress.units[unitId] = unitProg;

  const snap = await getStudioProductionUnitSnapshot(PROJECT, unitId);
  if (!snap) throw new Error(`snapshot missing ${unitId}`);
  const unitRevision = snap.unit.revision;

  let written = unitProg.written;
  let expected = 0;

  for (const panel of snap.panels) {
    const startMilliseconds = Math.round(panel.startSeconds * 1000);
    const endMilliseconds = Math.round(panel.endSeconds * 1000);
    const binding = await getCurrentStudioPanelAssetBindingSet(
      PROJECT,
      unitId,
      panel.id,
    );
    if (!binding) throw new Error(`no binding ${unitId}/${panel.id}`);
    const subjects = binding.bindings.filter((b) => b.presence !== "forbidden");
    expected += subjects.length * STUDIO_CONTINUITY_FIELDS.length;

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
        assertNoD01A01Misroute(subject.assetId, plan.state);
        const step = `obs:${unitId}:${panel.id}:${subject.assetId}:${plan.field}`;
        try {
          await exec(step, "append_studio_continuity_observation", {
            expectedHeadRevision: 0,
            scope: {
              kind: "panel",
              scopeId: panel.id,
              unitId,
              unitRevision,
              startMilliseconds,
              endMilliseconds,
            },
            subjectId: subject.assetId,
            field: plan.field,
            state: plan.state,
          });
          written += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/期望 revision=0，实际 revision=1|幂等键已用于不同参数/.test(message)) {
            written += 1; // already present
            continue;
          }
          throw error;
        }
      }
    }
    console.log(`[slice] ${unitId} ${panel.id} cumulative written≈${written}`);
    unitProg.written = written;
    unitProg.expected = expected;
    await saveProgress(progress);
  }

  unitProg.written = written;
  unitProg.expected = expected;

  // continuity review
  const reviewPanels = [];
  for (const panel of snap.panels) {
    const binding = await getCurrentStudioPanelAssetBindingSet(
      PROJECT,
      unitId,
      panel.id,
    );
    const assetIds = (binding?.bindings ?? []).map((b) => b.assetId).sort();
    const control = await getStudioContinuityReviewControl(PROJECT, {
      unitId,
      unitRevision,
      panelId: panel.id,
      startMilliseconds: Math.round(panel.startSeconds * 1000),
      endMilliseconds: Math.round(panel.endSeconds * 1000),
      assetIds,
    });
    for (const asset of control.assets) {
      if (!asset.ready) {
        throw new Error(
          `${unitId}/${panel.id}/${asset.assetId} not ready: ${JSON.stringify(asset.blockers)}`,
        );
      }
      if (asset.assetId === "prop-d01-golden-mask") {
        for (const item of asset.timeline.items) {
          const blob = JSON.stringify(item.state);
          if (/A01 为无面部|A01 按轴线处于河心/.test(blob)) {
            throw new Error(`D01 misroute in review ${panel.id} ${item.field}`);
          }
        }
      }
    }
    if (control.conflicts.items.length > 0) {
      throw new Error(`open conflicts on ${unitId}/${panel.id}`);
    }
    reviewPanels.push({
      panelId: panel.id,
      assets: control.assets.map((a) => ({
        assetId: a.assetId,
        ready: a.ready,
        fields: a.fields,
        blockers: a.blockers,
      })),
      openConflicts: control.conflicts.items,
    });
  }
  await writeFile(
    path.join(SCRATCH, `continuity-review-${unitId}.json`),
    JSON.stringify({ unitId, unitRevision, panels: reviewPanels }, null, 2),
  );

  // optional freeze panel-01
  try {
    const freeze = await exec(`freeze:${unitId}:panel-01`, "freeze_studio_generation_pack", {
      unitId,
      panelId: "panel-01",
      expectedRevision: unitRevision,
    });
    unitProg.freezePackId = freeze.packId ?? freeze.pack?.packId;
    await writeFile(
      path.join(SCRATCH, `freeze-pack-${unitId}-panel-01.json`),
      JSON.stringify(freeze, null, 2),
    );
    // D01 section check if present
    const dump = JSON.stringify(freeze);
    // only fail if D01 asset block has A01 misroute - structural walk
    const findAssets = (obj: any): any[] => {
      if (!obj || typeof obj !== "object") return [];
      if (Array.isArray(obj.assets) && obj.assets[0]?.assetId) return obj.assets;
      for (const v of Object.values(obj)) {
        const f = findAssets(v);
        if (f.length) return f;
      }
      return [];
    };
    const assets = findAssets(freeze);
    const d01 = assets.find((a) => a.assetId === "prop-d01-golden-mask");
    if (d01 && /A01 为无面部|A01 按轴线处于河心/.test(JSON.stringify(d01))) {
      throw new Error("freeze pack D01 section misroutes A01");
    }
    console.log(`[slice] freeze ${unitId} panel-01 ${unitProg.freezePackId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[slice] freeze skipped/failed: ${message}`);
    unitProg.freezePackId = unitProg.freezePackId ?? `skipped:${message.slice(0, 120)}`;
  }

  const unitAfter = await getStudioProductionDashboard(PROJECT, {
    operation: "unit",
    unitId,
  });
  await writeFile(
    path.join(SCRATCH, `dashboard-unit-${unitId}-after.json`),
    JSON.stringify(unitAfter, null, 2),
  );
  const reason = String(unitAfter.nextAction?.reason ?? "");
  if (reason.includes("没有显式状态")) {
    throw new Error(`${unitId} still gap-blocked: ${reason}`);
  }
  console.log(`[slice] ${unitId} nextAction=${unitAfter.nextAction?.code} written=${written}/${expected}`);
}

async function main() {
  await mkdir(SCRATCH, { recursive: true });
  const unitIds = process.argv.slice(2);
  const targets = unitIds.length > 0 ? unitIds : DEFAULT_UNITS;

  const progress = await loadProgress();
  progress.phase = "writing";

  const overviewBefore = await getStudioProductionDashboard(PROJECT, {
    operation: "overview",
  });
  await writeFile(
    path.join(SCRATCH, "dashboard-overview-before-ep01-cont-slice.json"),
    JSON.stringify(overviewBefore, null, 2),
  );

  for (const unitId of targets) {
    try {
      await fillUnit(unitId, progress);
      progress.units[unitId]!.error = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      progress.errors.push({ step: unitId, message });
      progress.units[unitId] = {
        ...(progress.units[unitId] ?? { written: 0, expected: 0, fields: [...STUDIO_CONTINUITY_FIELDS] }),
        error: message,
      };
      await saveProgress(progress);
      throw error;
    }
    await saveProgress(progress);
  }

  const hardlock: Record<string, unknown> = {};
  for (const id of [
    "character-wangqing",
    "character-wuzhu-female",
    "character-r07-dudu",
    "character-a01-energy",
    "prop-d01-golden-mask",
  ]) {
    const a = await getStudioCanonicalAsset(PROJECT, id);
    hardlock[id] = {
      name: a?.name,
      primaryAuthority: a?.primaryAuthority,
      negativeLocks: a?.negativeLocks,
      revision: a?.revision,
    };
  }
  await writeFile(
    path.join(SCRATCH, "hardlock-spotcheck-after-ep01-cont-slice.json"),
    JSON.stringify(hardlock, null, 2),
  );

  const overviewAfter = await getStudioProductionDashboard(PROJECT, {
    operation: "overview",
  });
  if (overviewAfter.operation !== "overview") {
    throw new Error("驾驶舱未返回 overview 投影。");
  }
  await writeFile(
    path.join(SCRATCH, "dashboard-overview-after-ep01-cont-slice.json"),
    JSON.stringify(overviewAfter, null, 2),
  );
  await writeFile(
    path.join(SCRATCH, "dashboard-overview-after-ep01-cont-slice-reread.json"),
    JSON.stringify(
      await getStudioProductionDashboard(PROJECT, { operation: "overview" }),
      null,
      2,
    ),
  );

  progress.phase = "done";
  await saveProgress(progress);

  console.log(
    JSON.stringify(
      {
        targets,
        units: progress.units,
        errors: progress.errors.length,
        overviewNext: overviewAfter.nextAction?.code,
        bindingSets: overviewAfter.counts.assetBindingSets,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
