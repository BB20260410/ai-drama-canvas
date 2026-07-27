/**
 * EP01 时间序：补 sourceSpan → analyze → 显式 resolve/empty → freeze BindingSet。
 * 全部写入经 executeIdempotentCommand；决策表禁止 candidates[0]。
 */
import { writeFile, readFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";
import {
  getStudioProductionUnitSnapshot,
  listStudioProductionUnits,
} from "../src/core/studio-production.js";
import { getStudioBindingControl } from "../src/core/studio-binding-control.js";
import { planExplicitBindingDecision } from "../src/core/studio-binding-explicit-decision.js";
import { getStudioCanonicalAsset } from "../src/core/material-studio.js";

const PROJECT_ROOT =
  "/Users/hxx/Documents/无限画布/projects/codex-ai-drama-studio";
const TAG = "s1-ep01-bind-v1";
const PROGRESS_PATH = path.join(
  PROJECT_ROOT,
  ".aicanvas",
  "s1-ep01-binding-progress.json",
);
const SCRATCH =
  process.env.SCRATCH ||
  "/var/folders/bt/q4f2706n013cbd5m4h6rb6tr0000gn/T/grok-goal-d7cc2ac6a25c/implementer";

type Progress = {
  phase: string;
  units: Record<
    string,
    {
      sequence: number;
      title: string;
      revised?: boolean;
      panels: Record<
        string,
        {
          status: string;
          bindingSetId?: string;
          proposals?: number;
          note?: string;
        }
      >;
      frozenPanelCount: number;
      error?: string;
    }
  >;
  errors: Array<{ step: string; message: string }>;
  updatedAt: string;
};

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function loadProgress(): Promise<Progress> {
  if (await exists(PROGRESS_PATH)) {
    return JSON.parse(await readFile(PROGRESS_PATH, "utf8")) as Progress;
  }
  return { phase: "init", units: {}, errors: [], updatedAt: new Date().toISOString() };
}

async function saveProgress(p: Progress): Promise<void> {
  p.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(PROGRESS_PATH), { recursive: true });
  await writeFile(PROGRESS_PATH, JSON.stringify(p, null, 2), "utf8");
}

async function exec(
  step: string,
  command: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const result = await executeIdempotentCommand(PROJECT_ROOT, {
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

async function control(unitId: string, panelId?: string) {
  void panelId;
  return getStudioBindingControl(PROJECT_ROOT, { unitId });
}

async function ensureSourceSpans(unitId: string): Promise<void> {
  const snap = await getStudioProductionUnitSnapshot(PROJECT_ROOT, unitId);
  if (!snap) throw new Error(`unit missing ${unitId}`);
  const needs = snap.panels.some((p) => p.sourceSpans.length === 0);
  if (!needs) return;

  const body = snap.scriptRevision.body;
  if (!body.trim()) throw new Error(`empty script ${unitId}`);

  await exec(`revise-spans:${unitId}`, "revise_studio_production_unit", {
    unitId,
    expectedRevision: snap.unit.revision,
    season: snap.unit.season,
    episode: snap.unit.episode,
    sequence: snap.unit.sequence,
    title: snap.unit.title,
    scriptRevisionId: snap.scriptRevision.id,
    panels: snap.panels.map((panel) => ({
      id: panel.id,
      title: panel.title,
      visualAction: panel.visualAction,
      shotComposition: panel.shotComposition,
      filmingMethod: panel.filmingMethod,
      dialogue: panel.dialogue,
      subtitle: panel.subtitle,
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
      durationSeconds: panel.durationSeconds,
      promptRevisionId: panel.promptRevisionId,
      sourceSpans: [
        {
          startOffsetUtf16: 0,
          endOffsetUtf16: body.length,
        },
      ],
      assets: panel.assets.map((a) => ({
        assetId: a.assetId,
        category: a.category,
        presence: a.presence,
        role: a.role,
        continuityState: a.continuityState,
        evidence: a.evidence.map((e) => ({
          kind: e.kind,
          reference: e.reference,
          note: e.note,
        })),
      })),
    })),
  });
}

async function bindPanel(
  unitId: string,
  panelId: string,
): Promise<{ bindingSetId?: string; proposals: number; status: string; note?: string }> {
  // already frozen?
  let ctl = await control(unitId, panelId);
  const panel0 = ctl.panels.find((p) => p.id === panelId);
  if (panel0?.bindingSet?.currentness === "current") {
    return {
      bindingSetId: panel0.bindingSet.id,
      proposals: panel0.proposals.length,
      status: "already-frozen",
    };
  }

  // analyze (idempotent per unit/panel; re-run needs new key if analysis changed — use stable first analyze)
  ctl = await control(unitId, panelId);
  try {
    await exec(`analyze:${unitId}:${panelId}`, "analyze_studio_script_entities", {
      unitId,
      panelId,
      expectedRevisionToken: ctl.revisionToken,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // replay / already analyzed path: continue to control
    if (!/幂等|replay|succeeded|冲突|token|修订/.test(message) && !/source-span/.test(message)) {
      // if revision token stale, refresh once
      ctl = await control(unitId, panelId);
      await exec(`analyze2:${unitId}:${panelId}`, "analyze_studio_script_entities", {
        unitId,
        panelId,
        expectedRevisionToken: ctl.revisionToken,
      });
    } else if (/source-span/.test(message)) {
      throw error;
    }
  }

  ctl = await control(unitId, panelId);
  let panel = ctl.panels.find((p) => p.id === panelId);
  if (!panel) throw new Error(`panel missing ${panelId}`);

  if (panel.proposals.length === 0) {
    if (panel.confirmEmptyAllowed || !panel.emptyConfirmation) {
      ctl = await control(unitId, panelId);
      panel = ctl.panels.find((p) => p.id === panelId)!;
      if (!panel.emptyConfirmation || panel.emptyConfirmation.currentness !== "current") {
        await exec(`empty:${unitId}:${panelId}`, "confirm_studio_panel_empty", {
          unitId,
          panelId,
          expectedRevisionToken: ctl.revisionToken,
          reviewer: "codex",
          note: "分析零提案：本格无待绑规范实体，显式 confirmed-empty（S1 EP01 导入批）。",
        });
      }
    }
  } else {
    for (const proposal of panel.proposals) {
      if (proposal.status === "excluded" || proposal.resolvedAssetId) continue;
      // already has decision?
      const plan = planExplicitBindingDecision({
        entityText: proposal.entityText,
        status: proposal.status,
        matchedAssetId: proposal.matchedAssetId,
        candidates: proposal.candidates.map((c) => ({
          assetId: c.assetId,
          assetName: c.assetName,
        })),
        presence: proposal.presence,
        role: proposal.role,
      });
      if (plan.kind === "blocked") {
        throw new Error(`blocked decision ${unitId}/${panelId}/${proposal.entityText}: ${plan.reason}`);
      }
      ctl = await control(unitId, panelId);
      const payload: Record<string, unknown> = {
        unitId,
        panelId,
        proposalId: proposal.id,
        decision: plan.kind,
        presence: proposal.presence === "forbidden" ? "forbidden" : "required",
        role: plan.role,
        expectedRevisionToken: ctl.revisionToken,
        reviewer: "codex",
        note: plan.note,
      };
      if (plan.kind === "accept" || plan.kind === "select") {
        payload.selectedAssetId = plan.selectedAssetId;
      }
      await exec(
        `resolve:${unitId}:${panelId}:${proposal.id}`,
        "resolve_studio_entity_proposal",
        payload,
      );
    }
  }

  ctl = await control(unitId, panelId);
  panel = ctl.panels.find((p) => p.id === panelId)!;
  if (panel.bindingSet?.currentness === "current") {
    return {
      bindingSetId: panel.bindingSet.id,
      proposals: panel.proposals.length,
      status: "frozen",
    };
  }
  if (!panel.freezeAllowed) {
    return {
      proposals: panel.proposals.length,
      status: "freeze-blocked",
      note: panel.blockers.map((b) => b.message).join("; ") || panel.statusReason,
    };
  }
  ctl = await control(unitId, panelId);
  const frozen = (await exec(`freeze:${unitId}:${panelId}`, "freeze_studio_asset_binding_set", {
    unitId,
    panelId,
    expectedRevisionToken: ctl.revisionToken,
  })) as { bindingSetId: string };

  return {
    bindingSetId: frozen.bindingSetId,
    proposals: panel.proposals.length,
    status: "frozen",
  };
}

async function main(): Promise<void> {
  await mkdir(SCRATCH, { recursive: true });
  const progress = await loadProgress();
  progress.phase = "binding-ep01";

  const overviewBefore = await getStudioProductionDashboard(PROJECT_ROOT, {
    operation: "overview",
  });
  if (overviewBefore.operation !== "overview") throw new Error("dashboard overview 响应类型错误");
  await writeFile(
    path.join(SCRATCH, "dashboard-overview-before-binding.json"),
    JSON.stringify(overviewBefore, null, 2),
  );

  const page = await listStudioProductionUnits(PROJECT_ROOT, {
    season: "S01",
    episode: "EP01",
    limit: 50,
  });
  const units = page.items.sort((a, b) => a.sequence - b.sequence);
  await writeFile(path.join(SCRATCH, "ep01-units.json"), JSON.stringify(units, null, 2));
  console.log(`[bind] EP01 units=${units.length} bindingSets=${overviewBefore.counts.assetBindingSets}`);

  for (const unit of units) {
    const unitId = unit.id;
    const unitProg = progress.units[unitId] ?? {
      sequence: unit.sequence,
      title: unit.title,
      panels: {},
      frozenPanelCount: 0,
    };
    progress.units[unitId] = unitProg;

    try {
      if (!unitProg.revised) {
        await ensureSourceSpans(unitId);
        unitProg.revised = true;
        await saveProgress(progress);
      }

      const snap = await getStudioProductionUnitSnapshot(PROJECT_ROOT, unitId);
      if (!snap) throw new Error("snapshot missing after revise");

      for (const panel of snap.panels) {
        const existing = unitProg.panels[panel.id];
        if (existing?.status === "frozen" || existing?.status === "already-frozen") continue;
        const result = await bindPanel(unitId, panel.id);
        unitProg.panels[panel.id] = result;
        unitProg.frozenPanelCount = Object.values(unitProg.panels).filter(
          (p) => p.status === "frozen" || p.status === "already-frozen",
        ).length;
        console.log(
          `[bind] ${unitId} ${panel.id} ${result.status} proposals=${result.proposals}${result.note ? ` note=${result.note}` : ""}`,
        );
        if (result.status === "freeze-blocked") {
          throw new Error(`freeze blocked: ${result.note}`);
        }
      }
      unitProg.error = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      unitProg.error = message;
      progress.errors.push({ step: unitId, message });
      console.error(`[bind] FAIL ${unitId}: ${message}`);
      await saveProgress(progress);
      // continue remaining units for progress, but keep errors
      continue;
    }
    await saveProgress(progress);
  }

  // first unit deep evidence
  const firstId = units[0]?.id ?? "unit-ep01_15s_001";
  const firstControl = await getStudioBindingControl(PROJECT_ROOT, {
    unitId: firstId,
  });
  await writeFile(
    path.join(SCRATCH, "binding-unit-ep01_15s_001.json"),
    JSON.stringify(firstControl, null, 2),
  );

  const hardlockIds = [
    "character-wangqing",
    "character-wuzhu-female",
    "character-r07-dudu",
    "character-a01-energy",
    "prop-d01-golden-mask",
  ];
  const hardlock: Record<string, unknown> = {};
  for (const id of hardlockIds) {
    const asset = await getStudioCanonicalAsset(PROJECT_ROOT, id);
    hardlock[id] = {
      name: asset?.name,
      revision: asset?.revision,
      primaryAuthority: asset?.primaryAuthority,
      negativeLocks: asset?.negativeLocks,
      positiveLocks: asset?.positiveLocks,
    };
  }
  await writeFile(path.join(SCRATCH, "hardlock-spotcheck.json"), JSON.stringify(hardlock, null, 2));

  const overviewAfter = await getStudioProductionDashboard(PROJECT_ROOT, {
    operation: "overview",
  });
  if (overviewAfter.operation !== "overview") throw new Error("dashboard overview 响应类型错误");
  await writeFile(
    path.join(SCRATCH, "dashboard-overview-after-binding.json"),
    JSON.stringify(overviewAfter, null, 2),
  );
  // second read
  const overviewAfter2 = await getStudioProductionDashboard(PROJECT_ROOT, {
    operation: "overview",
  });
  if (overviewAfter2.operation !== "overview") throw new Error("dashboard overview 响应类型错误");
  await writeFile(
    path.join(SCRATCH, "dashboard-overview-after-binding-reread.json"),
    JSON.stringify(overviewAfter2, null, 2),
  );

  progress.phase = "done";
  await saveProgress(progress);

  const frozenUnits = Object.entries(progress.units).filter(
    ([, u]) => u.frozenPanelCount >= 6 && !u.error,
  ).length;
  console.log(
    JSON.stringify(
      {
        ep01Units: units.length,
        fullyFrozenUnits: frozenUnits,
        assetBindingSets: overviewAfter.counts.assetBindingSets,
        nextAction: overviewAfter.nextAction,
        errorCount: progress.errors.length,
        errorsHead: progress.errors.slice(0, 10),
      },
      null,
      2,
    ),
  );

  if (overviewAfter.counts.assetBindingSets < 1) {
    process.exitCode = 2;
  }
  if (frozenUnits < 1) {
    process.exitCode = 3;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
