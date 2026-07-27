/**
 * 修正 unit-ep01_15s_001 上 prop-d01-golden-mask 被误写成 A01 语义的九字段。
 * 全部走 append_studio_continuity_correction + 新幂等键；随后重冻 panel-01（不 dispatch）。
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";
import {
  getCurrentStudioPanelAssetBindingSet,
  getStudioProductionUnitSnapshot,
} from "../src/core/studio-production.js";
import {
  queryStudioContinuityTimeline,
} from "../src/core/studio-continuity-ledger.js";
import { getStudioContinuityReviewControl } from "../src/core/studio-continuity-review-control.js";
import { getStudioCanonicalAsset } from "../src/core/material-studio.js";
import {
  assertNineFieldCoverage,
  planContinuityFieldsForSubject,
} from "../src/core/studio-continuity-explicit-plan.js";
import { STUDIO_CONTINUITY_FIELDS } from "../src/core/studio-continuity.js";

const PROJECT =
  "/Users/hxx/Documents/无限画布/projects/codex-ai-drama-studio";
const UNIT_ID = "unit-ep01_15s_001";
const SUBJECT = "prop-d01-golden-mask";
const TAG = "s1-ep01-001-d01-correct-v1";
const SCRATCH =
  process.env.SCRATCH ||
  "/var/folders/bt/q4f2706n013cbd5m4h6rb6tr0000gn/T/grok-goal-e48e0f81a494/implementer";
const PROGRESS = path.join(
  PROJECT,
  ".aicanvas",
  "s1-ep01-d01-continuity-correction-progress.json",
);

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

async function main() {
  await mkdir(SCRATCH, { recursive: true });
  const written: unknown[] = [];
  const errors: unknown[] = [];

  const snap = await getStudioProductionUnitSnapshot(PROJECT, UNIT_ID);
  if (!snap) throw new Error("missing snapshot");
  const unitRevision = snap.unit.revision;

  for (const panel of snap.panels) {
    const startMilliseconds = Math.round(panel.startSeconds * 1000);
    const endMilliseconds = Math.round(panel.endSeconds * 1000);
    const binding = await getCurrentStudioPanelAssetBindingSet(
      PROJECT,
      UNIT_ID,
      panel.id,
    );
    const subject = binding?.bindings.find((b) => b.assetId === SUBJECT);
    if (!subject) throw new Error(`missing ${SUBJECT} on ${panel.id}`);

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

    // 防御：计划本身不得含 A01 误身份
    for (const plan of plans) {
      const text = JSON.stringify(plan.state);
      if (/A01 为无面部|A01 按轴线|河心\/光壳区域/.test(text)) {
        throw new Error(`plan still misroutes A01 for ${panel.id} ${plan.field}: ${text}`);
      }
    }

    const timeline = await queryStudioContinuityTimeline(PROJECT, {
      scopeAnchor: {
        kind: "panel",
        scopeId: panel.id,
        unitId: UNIT_ID,
        unitRevision,
      },
      subjectId: SUBJECT,
    });

    for (const plan of plans) {
      const head = timeline.items.find(
        (item) =>
          item.entry.field === plan.field
          && item.entry.subjectId === SUBJECT
          && item.entry.scope.startMilliseconds === startMilliseconds
          && item.entry.scope.endMilliseconds === endMilliseconds,
      );
      if (!head) {
        // 无旧 head 则 observation（不应发生）
        const step = `obs-fallback:${panel.id}:${plan.field}`;
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
          subjectId: SUBJECT,
          field: plan.field,
          state: plan.state,
        });
        written.push({ step, kind: "observation" });
        continue;
      }

      const step = `corr:${panel.id}:${plan.field}`;
      try {
        await exec(step, "append_studio_continuity_correction", {
          expectedHeadRevision: head.headRevision,
          scope: {
            kind: "panel",
            scopeId: panel.id,
            unitId: UNIT_ID,
            unitRevision,
            startMilliseconds,
            endMilliseconds,
          },
          subjectId: SUBJECT,
          field: plan.field,
          state: plan.state,
          supersedesEntryId: head.entry.id,
        });
        written.push({
          step,
          kind: "correction",
          supersedes: head.entry.id,
          field: plan.field,
          panelId: panel.id,
          headRevision: head.headRevision,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ step, message });
        throw error;
      }
    }
    console.log(`[d01-correct] ${panel.id} 9 fields corrected`);
  }

  // re-verify readiness
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
    // assert D01 fields not A01
    const d01 = control.assets.find((a) => a.assetId === SUBJECT);
    if (!d01?.ready) throw new Error(`D01 not ready after correction on ${panel.id}`);
    for (const item of d01.timeline.items) {
      const blob = JSON.stringify(item.state);
      if (/A01 为无面部|A01 按轴线处于河心/.test(blob)) {
        throw new Error(`D01 timeline still A01 on ${panel.id} ${item.field}: ${blob}`);
      }
    }
    reviewPanels.push({
      panelId: panel.id,
      assets: control.assets.map((a) => ({
        assetId: a.assetId,
        ready: a.ready,
        blockers: a.blockers,
        fields: a.fields,
      })),
      openConflicts: control.conflicts.items,
      d01Sample: d01.timeline.items.slice(0, 3),
    });
  }
  await writeFile(
    path.join(SCRATCH, "continuity-review-ep01_15s_001.json"),
    JSON.stringify({ unitId: UNIT_ID, unitRevision, panels: reviewPanels }, null, 2),
  );

  // re-freeze panel-01 (continuity snapshot must pick corrected heads)
  const freeze = await exec("refreeze-pack:panel-01", "freeze_studio_generation_pack", {
    unitId: UNIT_ID,
    panelId: "panel-01",
    expectedRevision: unitRevision,
  });
  await writeFile(
    path.join(SCRATCH, "freeze-pack-panel-01.json"),
    JSON.stringify(freeze, null, 2),
  );

  // assert freeze pack D01 continuity text
  const freezeJson = JSON.stringify(freeze);
  // 允许「与 A01 分离」类正确表述，禁止「A01 为无面部」等误主体
  if (/A01 为无面部无面具|A01 按轴线处于河心/.test(freezeJson)) {
    throw new Error("freeze pack still contains misrouted A01 identity for D01");
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
    path.join(SCRATCH, "hardlock-spotcheck-after-continuity.json"),
    JSON.stringify(hardlock, null, 2),
  );

  const overview = await getStudioProductionDashboard(PROJECT, { operation: "overview" });
  const unit = await getStudioProductionDashboard(PROJECT, {
    operation: "unit",
    unitId: UNIT_ID,
  });
  await writeFile(
    path.join(SCRATCH, "dashboard-overview-after-continuity.json"),
    JSON.stringify(overview, null, 2),
  );
  await writeFile(
    path.join(SCRATCH, "dashboard-unit-ep01_15s_001-after-continuity.json"),
    JSON.stringify(unit, null, 2),
  );
  const unit2 = await getStudioProductionDashboard(PROJECT, {
    operation: "unit",
    unitId: UNIT_ID,
  });
  await writeFile(
    path.join(SCRATCH, "dashboard-unit-ep01_15s_001-after-continuity-reread.json"),
    JSON.stringify(unit2, null, 2),
  );

  const progress = {
    phase: "done",
    tag: TAG,
    written,
    errors,
    freezePackId: freeze?.packId ?? freeze?.pack?.packId,
    fields: [...STUDIO_CONTINUITY_FIELDS],
    updatedAt: new Date().toISOString(),
  };
  await writeFile(PROGRESS, JSON.stringify(progress, null, 2), "utf8");
  await writeFile(
    path.join(SCRATCH, "s1-ep01-d01-continuity-correction-progress.json"),
    JSON.stringify(progress, null, 2),
  );

  console.log(
    JSON.stringify(
      {
        corrections: written.length,
        errors: errors.length,
        freezePackId: progress.freezePackId,
        unitNextAction: unit.nextAction,
        costumeBlocking:
          typeof unit.nextAction?.reason === "string"
          && unit.nextAction.reason.includes("costume")
          && unit.nextAction.reason.includes("没有显式状态"),
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
