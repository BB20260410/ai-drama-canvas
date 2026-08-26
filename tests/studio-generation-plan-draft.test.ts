import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  composeStudioGenerationPlanDraft,
  ACTIVE_RUNS_NEXT_FOLLOW_READINESS,
  ACTIVE_RUNS_NEXT_RECONCILE,
  activeRunsEnvelopeNext,
  canvasFreezeDispatchOverrideForUnitGridBlocking,
  packEnvelopeNextOverrideForUnitGridBlocking,
  PLAN_ENVELOPE_NEXT_CREATE,
  PLAN_ENVELOPE_NEXT_DISPATCH,
  PLAN_ENVELOPE_NEXT_FOLLOW,
  PLAN_ENVELOPE_NEXT_RETRY,
  PLAN_ENVELOPE_NEXT_REVIEW,
  PLAN_ENVELOPE_NEXT_WAIT,
  planEnvelopeNextFromNodeStatuses,
  planEnvelopeNextLabel,
  planOperationEnvelopeNext,
  refineStudioGenerationPlanDraftIfUnitGridBlocking,
  STUDIO_GENERATION_PLAN_COMMAND,
  unitGridNextActionBlockingKind,
  unitGridStatusBlockingKind,
} from "../src/core/studio-generation-plan-draft.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("create-plan 只读草稿纯函数", () => {
  it("无单元 / 无宫格 / 无本格 pack 失败关闭，不猜第一格", () => {
    expect(composeStudioGenerationPlanDraft({
      focusUnitId: null,
      focusPanelId: "p1",
      focusPackId: "pack-1",
    })).toMatchObject({
      command: STUDIO_GENERATION_PLAN_COMMAND,
      ready: false,
      blockedReason: "没有目标单元，不能建立计划",
      nodes: null,
      dispatch: false,
    });
    expect(composeStudioGenerationPlanDraft({
      focusUnitId: "u1",
      focusPanelId: null,
      focusPackId: "pack-1",
    }).blockedReason).toBe("没有目标宫格，禁止猜第一格");
    expect(composeStudioGenerationPlanDraft({
      focusUnitId: "u1",
      focusPanelId: "p1",
      focusPackId: null,
    }).blockedReason).toContain("禁止用同行已出图宫格的 packId");
  });

  it("本格已有冻结 pack 时 ready，仍不派发", () => {
    expect(composeStudioGenerationPlanDraft({
      focusUnitId: "u1",
      focusPanelId: "p1",
      focusPackId: "pack-own",
    })).toEqual({
      command: STUDIO_GENERATION_PLAN_COMMAND,
      ready: true,
      blockedReason: null,
      nodes: [{ unitId: "u1", panelId: "p1" }],
      dispatch: false,
      note: "只起草建计划节点；不执行、不派发。派发须用计划推导 runId。",
    });
  });

  it("本格已有计划时不再 ready 建计划，下一步是 dispatch，仍不派发", () => {
    expect(composeStudioGenerationPlanDraft({
      focusUnitId: "u1",
      focusPanelId: "p1",
      focusPackId: "pack-own",
      hasPersistedPlan: true,
    })).toEqual({
      command: STUDIO_GENERATION_PLAN_COMMAND,
      ready: false,
      blockedReason: "该宫格已有生成计划，下一步是 dispatch（不派发）",
      nodes: [{ unitId: "u1", panelId: "p1" }],
      dispatch: false,
      note: "计划已落盘。下一步 dispatch；不执行、不派发。派发须用计划推导 runId。",
    });
    expect(composeStudioGenerationPlanDraft({
      focusUnitId: "u1",
      focusPanelId: null,
      focusPackId: "pack-grid",
      targetKind: "unit-grid",
      hasPersistedPlan: true,
    })).toMatchObject({
      ready: false,
      blockedReason: "该整板已有生成计划，下一步是 dispatch（不派发）",
      nodes: [{ targetKind: "unit-grid", unitId: "u1" }],
      dispatch: false,
    });
  });

  it("已有计划且传入节点状态时区分 wait / retry / Review，仍不派发", () => {
    expect(composeStudioGenerationPlanDraft({
      focusUnitId: "u1",
      focusPanelId: "p1",
      focusPackId: "pack-own",
      hasPersistedPlan: true,
      persistedPlanStatus: "dispatched",
    })).toMatchObject({
      ready: false,
      dispatch: false,
      blockedReason: "该宫格计划节点进行中，等待结果或对账（不派发）",
      note: "计划节点进行中。下一步等待结果或对账；不执行、不派发。",
      nodes: [{ unitId: "u1", panelId: "p1" }],
    });
    expect(composeStudioGenerationPlanDraft({
      focusUnitId: "u1",
      focusPanelId: "p1",
      focusPackId: "pack-own",
      hasPersistedPlan: true,
      persistedPlanStatus: "failed",
    }).blockedReason).toBe("该宫格计划节点已失败/已取消，下一步是 retry（不重试、不派发）");
    expect(composeStudioGenerationPlanDraft({
      focusUnitId: "u1",
      focusPanelId: "p1",
      focusPackId: "pack-own",
      hasPersistedPlan: true,
      persistedPlanStatus: "cancelled",
    }).note).toContain("下一步 retry");
    expect(composeStudioGenerationPlanDraft({
      focusUnitId: "u1",
      focusPanelId: null,
      focusPackId: "pack-grid",
      targetKind: "unit-grid",
      hasPersistedPlan: true,
      persistedPlanStatus: "succeeded",
    })).toMatchObject({
      ready: false,
      dispatch: false,
      blockedReason: "该整板计划节点已有结果，下一步是 Review（不派发）",
      nodes: [{ targetKind: "unit-grid", unitId: "u1" }],
    });
    expect(composeStudioGenerationPlanDraft({
      focusUnitId: "u1",
      focusPanelId: "p1",
      focusPackId: "pack-own",
      hasPersistedPlan: true,
      persistedPlanStatus: "planned",
    }).blockedReason).toBe("该宫格已有生成计划，下一步是 dispatch（不派发）");
  });

  it("整板已有冻结 pack 时 ready 出 unit-grid 节点，无 pack 失败关闭", () => {
    expect(composeStudioGenerationPlanDraft({
      focusUnitId: "u1",
      focusPanelId: null,
      focusPackId: "pack-grid",
      targetKind: "unit-grid",
    })).toEqual({
      command: STUDIO_GENERATION_PLAN_COMMAND,
      ready: true,
      blockedReason: null,
      nodes: [{ targetKind: "unit-grid", unitId: "u1" }],
      dispatch: false,
      note: "只起草建计划节点；不执行、不派发。派发须用计划推导 runId。",
    });
    expect(composeStudioGenerationPlanDraft({
      focusUnitId: "u1",
      focusPanelId: "p1",
      focusPackId: null,
      targetKind: "unit-grid",
    }).blockedReason).toContain("禁止用单镜或同行 preview pack 冒充整板节点");
  });

  it("unit-grid 在途/待重试/待审时单镜草稿不得再 ready", () => {
    expect(unitGridNextActionBlockingKind("wait-or-reconcile-unit-grid-run")).toBe("wait");
    expect(unitGridNextActionBlockingKind("retry-unit-grid-plan-nodes")).toBe("retry");
    expect(unitGridNextActionBlockingKind("submit-unit-grid-review")).toBe("review");
    expect(unitGridNextActionBlockingKind("reconcile-unit-grid-call")).toBe("reconcile");
    expect(unitGridNextActionBlockingKind("dispatch-unit-grid")).toBeNull();
    expect(unitGridNextActionBlockingKind("create-unit-grid-plan")).toBeNull();
    expect(unitGridStatusBlockingKind("dispatched")).toBe("wait");
    expect(unitGridStatusBlockingKind("failed")).toBe("retry");
    expect(unitGridStatusBlockingKind("cancelled")).toBe("retry");
    expect(unitGridStatusBlockingKind("succeeded")).toBe("review");
    expect(unitGridStatusBlockingKind("planned")).toBeNull();

    const ready = composeStudioGenerationPlanDraft({
      focusUnitId: "u1",
      focusPanelId: "p1",
      focusPackId: "pack-own",
    });
    expect(ready.ready).toBe(true);
    const waiting = refineStudioGenerationPlanDraftIfUnitGridBlocking(ready, {
      code: "wait-or-reconcile-unit-grid-run",
      label: "unit-grid 正在执行，等待结果或对账现有 run",
    });
    expect(waiting.ready).toBe(false);
    expect(waiting.dispatch).toBe(false);
    expect(waiting.blockedReason).toBe("unit-grid 正在执行，等待结果或对账现有 run");
    expect(waiting.nodes).toEqual([{ unitId: "u1", panelId: "p1" }]);
    expect(refineStudioGenerationPlanDraftIfUnitGridBlocking(ready, {
      code: "dispatch-unit-grid",
    }).ready).toBe(true);
    expect(refineStudioGenerationPlanDraftIfUnitGridBlocking(ready, {
      status: "planned",
    }).ready).toBe(true);
    const persisted = composeStudioGenerationPlanDraft({
      focusUnitId: "u1",
      focusPanelId: "p1",
      focusPackId: "pack-own",
      hasPersistedPlan: true,
      persistedPlanStatus: "planned",
    });
    expect(persisted.blockedReason).toContain("下一步是 dispatch");
    const again = refineStudioGenerationPlanDraftIfUnitGridBlocking(persisted, {
      status: "dispatched",
    });
    expect(again.ready).toBe(false);
    expect(again.blockedReason).toContain("等待结果或对账");
    expect(again.nodes).toEqual([{ unitId: "u1", panelId: "p1" }]);
    expect(packEnvelopeNextOverrideForUnitGridBlocking("dispatched")).toBe("wait → result or reconcile (no dispatch)");
    expect(packEnvelopeNextOverrideForUnitGridBlocking("failed")).toBe("retry_studio_generation_plan_nodes (no retry here, no dispatch)");
    expect(packEnvelopeNextOverrideForUnitGridBlocking("cancelled")).toBe("retry_studio_generation_plan_nodes (no retry here, no dispatch)");
    expect(packEnvelopeNextOverrideForUnitGridBlocking("succeeded")).toBe("Review (no dispatch)");
    expect(packEnvelopeNextOverrideForUnitGridBlocking("planned")).toBeNull();
    expect(packEnvelopeNextOverrideForUnitGridBlocking(undefined)).toBeNull();
    expect(canvasFreezeDispatchOverrideForUnitGridBlocking("wait-or-reconcile-unit-grid-run", "等待整板结果")).toEqual({
      enabled: false,
      label: "等待整板结果",
      reason: "等待整板结果",
    });
    expect(canvasFreezeDispatchOverrideForUnitGridBlocking("retry-unit-grid-plan-nodes")?.enabled).toBe(false);
    expect(canvasFreezeDispatchOverrideForUnitGridBlocking("submit-unit-grid-review")?.label).toContain("Review");
    expect(canvasFreezeDispatchOverrideForUnitGridBlocking("reconcile-unit-grid-call")?.reason).toContain("对账");
    expect(canvasFreezeDispatchOverrideForUnitGridBlocking("dispatch-unit-grid")).toBeNull();
    expect(canvasFreezeDispatchOverrideForUnitGridBlocking("create-unit-grid-plan")).toBeNull();
    expect(canvasFreezeDispatchOverrideForUnitGridBlocking("create-unit-grid-freeze")).toBeNull();
    expect(activeRunsEnvelopeNext({})).toBe(ACTIVE_RUNS_NEXT_FOLLOW_READINESS);
    expect(activeRunsEnvelopeNext({ hasUnknownCall: true, hasInFlightRun: true })).toBe(ACTIVE_RUNS_NEXT_RECONCILE);
    expect(activeRunsEnvelopeNext({
      hasUnreviewedPair: true,
      unitGridBlockingStatus: "dispatched",
    })).toBe("wait → result or reconcile (no dispatch)");
    expect(activeRunsEnvelopeNext({ hasUnreviewedPair: true })).toBe("Review (no dispatch)");
    expect(activeRunsEnvelopeNext({ hasInFlightRun: true })).toBe("wait → result or reconcile (no dispatch)");
    expect(activeRunsEnvelopeNext({ generationBlocked: true })).toBe("wait → result or reconcile (no dispatch)");
    expect(activeRunsEnvelopeNext({ unitGridBlockingStatus: "failed" })).toBe(
      "retry_studio_generation_plan_nodes (no retry here, no dispatch)",
    );
    expect(activeRunsEnvelopeNext({ unitGridBlockingStatus: "succeeded" })).toBe("Review (no dispatch)");
    expect(activeRunsEnvelopeNext({ unitGridBlockingStatus: "planned" })).toBe(ACTIVE_RUNS_NEXT_FOLLOW_READINESS);
    expect(planEnvelopeNextFromNodeStatuses(["dispatched", "planned"])).toBe(PLAN_ENVELOPE_NEXT_WAIT);
    expect(planEnvelopeNextFromNodeStatuses(["failed", "planned"])).toBe(PLAN_ENVELOPE_NEXT_RETRY);
    expect(planEnvelopeNextFromNodeStatuses(["cancelled"])).toBe(PLAN_ENVELOPE_NEXT_RETRY);
    expect(planEnvelopeNextFromNodeStatuses(["planned"])).toBe(PLAN_ENVELOPE_NEXT_DISPATCH);
    expect(planEnvelopeNextFromNodeStatuses(["retry-superseded"])).toBe(PLAN_ENVELOPE_NEXT_DISPATCH);
    expect(planEnvelopeNextFromNodeStatuses(["succeeded", "planned"])).toBe(PLAN_ENVELOPE_NEXT_DISPATCH);
    expect(planEnvelopeNextFromNodeStatuses(["succeeded"])).toBe(PLAN_ENVELOPE_NEXT_REVIEW);
    expect(planEnvelopeNextFromNodeStatuses([])).toBe(PLAN_ENVELOPE_NEXT_CREATE);
    expect(planOperationEnvelopeNext({ kind: "not-found" })).toBe(PLAN_ENVELOPE_NEXT_FOLLOW);
    expect(planOperationEnvelopeNext({ kind: "unscoped-list" })).toBe(PLAN_ENVELOPE_NEXT_FOLLOW);
    expect(planOperationEnvelopeNext({ kind: "scoped", statuses: [] })).toBe(PLAN_ENVELOPE_NEXT_CREATE);
    expect(planOperationEnvelopeNext({ kind: "scoped", statuses: ["dispatched"] })).toBe(PLAN_ENVELOPE_NEXT_WAIT);
    expect(planEnvelopeNextLabel(["dispatched"])).toContain("等待结果或对账");
    expect(planEnvelopeNextLabel(["failed"])).toContain("retry");
    expect(planEnvelopeNextLabel(["succeeded"])).toContain("Review");
    expect(planEnvelopeNextLabel(["planned"])).toContain("dispatch");
    expect(planEnvelopeNextLabel([])).toContain("create-plan");
  });
});

describe("create-plan 草稿接线源码合同", () => {
  it("薄模块不拉对照板 / 不执行 / 不派发", () => {
    const draft = source("src/core/studio-generation-plan-draft.ts");
    expect(draft).toContain("refineStudioGenerationPlanDraftIfUnitGridBlocking");
    expect(draft).toContain("packEnvelopeNextOverrideForUnitGridBlocking");
    expect(draft).toContain("canvasFreezeDispatchOverrideForUnitGridBlocking");
    expect(draft).toContain("activeRunsEnvelopeNext");
    expect(draft).toContain("planOperationEnvelopeNext");
    expect(draft).toContain("planEnvelopeNextFromNodeStatuses");
    expect(draft).toContain("planEnvelopeNextLabel");
    expect(draft).toContain("unitGridNextActionBlockingKind");
    expect(draft).not.toContain("studio-script-media-align");
    expect(draft).not.toContain("studio-ssl5-missing-to-gen");
    expect(draft).not.toContain("node:sqlite");
    expect(draft).not.toContain("execute_command");
    expect(draft).not.toContain("dispatch_studio_generation_pack");
  });

  it("session-snapshot 有 panelId 走单镜、无 panelId 走已落盘整板，草稿不进 fingerprint", () => {
    const snapshot = source("src/core/studio-generation-session-snapshot.ts");
    expect(snapshot).toContain("composeStudioGenerationPlanDraft");
    expect(snapshot).toContain("persistedPanelPackIdForDraft");
    expect(snapshot).toContain("persistedUnitGridPackIdForDraft");
    expect(snapshot).toContain("readPersistedPanelPlanState");
    expect(snapshot).toContain("readPersistedUnitGridPlanState");
    expect(snapshot).toContain("hasPersistedPlan");
    expect(snapshot).toContain("persistedPlanStatus");
    expect(snapshot).toContain("refineStudioGenerationPlanDraftIfUnitGridBlocking");
    expect(snapshot).toContain("bundle.nextAction.code");
    expect(snapshot).toContain("listStudioGenerationPacksByUnit");
    expect(snapshot).toContain('targetKind: "unit-grid"');
    expect(snapshot).toContain('pack.provenance !== "asset-binding-set"');
    expect(snapshot).toContain('persisted.provenance !== "unit-grid-binding-sets"');
    expect(snapshot).toContain("generationPlanDraft");
    expect(snapshot).toContain("styleLockLine");
    expect(snapshot).toContain("styleLockRefsFromAnyFrozenPack(frozenPanel)");
    expect(snapshot).toContain("不进 fingerprint");
    expect(snapshot).not.toContain("studio-ssl5-missing-to-gen");
    expect(snapshot).not.toContain("studio-script-media-align");
    expect(snapshot).not.toContain("studio-script-library-projection");
    expect(snapshot).not.toContain("studio-unit-grid-generation");
    expect(snapshot).not.toContain("execute_command");
    expect(snapshot).not.toContain("dispatch_studio_generation_pack");
    const digest = snapshot.slice(snapshot.indexOf("fingerprint: digest({"), snapshot.indexOf("topRiskCode: body.topRisk?.code ?? null,"));
    expect(digest).not.toContain("generationPlanDraft");
    const helperStart = snapshot.indexOf("async function persistedUnitGridPackIdForDraft");
    const helperEnd = snapshot.indexOf("function panelPack(", helperStart);
    const helper = snapshot.slice(helperStart, helperEnd);
    expect(helper).toContain('item.targetKind === "unit-grid"');
    expect(helper).not.toContain("queryStudioUnitGridGenerationFreeze");
    expect(helper).not.toContain("candidate.packId");
  });

  it("生成控制整板出 unit-grid 节点，不用 readiness 候选", () => {
    const control = source("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(control).toContain("composeStudioGenerationPlanDraft");
    expect(control).toContain('data-testid="studio-generation-plan-draft"');
    expect(control).toContain('data-testid="studio-generation-plan-nodes"');
    expect(control).toContain('data-testid="studio-generation-plan-command"');
    expect(control).toContain('data-testid="studio-generation-plan-next"');
    expect(control).toContain("planEnvelopeNextLabel");
    expect(control).toContain("persistedUnitGridPackIdForDraft");
    expect(control).toContain("hasPersistedPlanForDraft");
    expect(control).toContain("persistedPlanStatusForDraft");
    expect(control).toContain("formatGenerationPlanDraftNode");
    expect(control).toContain("generation?.status === \"ready\" && generation.packId");
    expect(control).not.toContain("dispatch_studio_generation_pack");
    const persistStart = control.indexOf("function persistedUnitGridPackIdForDraft");
    const persistEnd = control.indexOf("function formatGenerationPlanDraftNode", persistStart);
    const persist = control.slice(persistStart, persistEnd);
    expect(persist).toContain("history.value[0]?.packId");
    expect(persist).toContain('node.targetKind === "unit-grid"');
    expect(persist).not.toContain("unitGridReadinessPackId");
    expect(persist).not.toContain("selectedPackId");
    const computedStart = control.indexOf("const generationPlanDraft = computed");
    const computedEnd = control.indexOf("// P24 R5-F2", computedStart);
    const computed = control.slice(computedStart, computedEnd);
    expect(computed).toContain('targetKind: "unit-grid"');
    expect(computed).toContain("persistedUnitGridPackIdForDraft()");
    expect(computed).toContain("hasPersistedPlan: hasPersistedPlanForDraft()");
    expect(computed).toContain("persistedPlanStatus: persistedPlanStatusForDraft()");
    expect(computed).toContain("refineStudioGenerationPlanDraftIfUnitGridBlocking");
    expect(computed).toContain("unitGridPersistedStatusForBlocking()");
    expect(computed).not.toContain("unitGridReadinessPackId");
    expect(computed).not.toContain("selectedPackId");
    expect(control).toContain("`unit-grid ${node.unitId}`");
  });

  it("pack envelope 已落盘包起草 create-plan，不拉对照板", () => {
    const codex = source("src/core/codex.ts");
    expect(codex).toContain("composeStudioGenerationPlanDraft");
    expect(codex).toContain("composePersistedPackGenerationPlanDraft");
    expect(codex).toContain("persistedPlanStateForPack");
    expect(codex).toContain("packEnvelopeNext");
    expect(codex).toContain('targetKind: "unit-grid"');
    expect(codex).toContain("composePersistedPackGenerationPlanDraft(pack, hasPersistedPlan, persistedPlanStatus)");
    expect(codex).toContain("refineStudioGenerationPlanDraftIfUnitGridBlocking");
    expect(codex).toContain("siblingUnitGridPlanStatusForPanelPack");
    expect(codex).toContain("packEnvelopeNextOverrideForUnitGridBlocking");
    expect(codex).toContain("packEnvelopeNext(hasPersistedPlan, false, persistedPlanStatus, unitGridBlockingStatus)");
    expect(codex).toContain("packEnvelopeNext(hasPersistedPlan, true, persistedPlanStatus, unitGridBlockingStatus)");
    expect(codex).toContain('"create-plan → dispatch(provider=codex)');
    expect(codex).toContain('"create-plan → dispatch(provider=codex|grok)');
    expect(codex).toContain('"dispatch(provider=codex) → prepare pre-call intent');
    expect(codex).toContain('"dispatch(provider=codex|grok) → agent imagegen');
    expect(codex).toContain("readinessAgentNext");
    expect(codex).toContain("generationLedgerSidecarPath");
    expect(codex).toContain('"freeze → create-plan → dispatch(provider=codex)');
    expect(codex).toContain('"freeze → create-plan → dispatch(provider=codex|grok)');
    expect(codex).not.toContain('next: "freeze → dispatch(provider=codex|grok)');
    expect(codex).not.toContain("studio-ssl5-missing-to-gen");
    expect(codex).not.toContain("studio-script-media-align");
    const helperStart = codex.indexOf("function composePersistedPackGenerationPlanDraft");
    const helperEnd = codex.indexOf("function sameSortedStrings", helperStart);
    const helper = codex.slice(helperStart, helperEnd);
    expect(helper).toContain("pack.id");
    expect(helper).toContain("pack.target.panelId");
    expect(helper).toContain("hasPersistedPlan");
    expect(helper).toContain("persistedPlanStatus");
    expect(helper).toContain("readPersistedPanelPlanState");
    expect(helper).toContain("readPersistedUnitGridPlanState");
    expect(helper).toContain("siblingUnitGridPlanStatusForPanelPack");
    expect(helper).toContain("isStudioUnitGridGenerationPack(pack)");
    expect(helper).toContain("readinessAgentNext");
    expect(helper).toContain("generationLedgerSidecarPath");
    expect(helper).toContain("wait → result or reconcile (no dispatch)");
    expect(helper).toContain("retry_studio_generation_plan_nodes (no retry here, no dispatch)");
    expect(helper).toContain("Review (no dispatch)");
    expect(helper).not.toContain("unitGridReadinessPackId");
    expect(helper).not.toContain("candidate.packId");
  });

  it("画布节点下一步跟 unit-grid 在途对齐，零额外 IPC，不拉对照板", () => {
    const panel = source("src/core/studio-canvas-node-action-panel.ts");
    expect(panel).toContain("canvasFreezeDispatchOverrideForUnitGridBlocking");
    expect(panel).toContain("unitGridNextActionCode");
    expect(panel).toContain("unitGridNextActionLabel");
    expect(panel).toContain('key: "next"');
    expect(panel).toContain('code: "freeze-dispatch"');
    expect(panel).not.toContain("studio-ssl5-missing-to-gen");
    expect(panel).not.toContain("studio-script-media-align");
    expect(panel).not.toContain("studio-episode-earliest");
    expect(panel).not.toContain("dispatch_studio_generation_pack");
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("unitGridNextActionCode: unitDetail.value?.nextAction.code");
    expect(canvas).toContain("unitGridNextActionLabel: unitDetail.value?.nextAction.label");
    expect(canvas).toContain("sameUnit ? unitDetail.value?.nextAction.code");
    expect(canvas).not.toContain("from \"@core/studio-generation-plan-draft");
    expect(canvas).not.toContain("studio-ssl5-missing-to-gen");
    const inspector = source("src/renderer/src/components/CanvasInspectorPanel.vue");
    expect(inspector).toContain('data-testid="managed-canvas-inspector-next"');
    expect(inspector).toContain('field.key === "next"');
    expect(inspector).not.toContain("from \"@core/studio-generation-plan-draft");
    expect(inspector).not.toContain("studio-ssl5-missing-to-gen");
  });

  it("active-runs 信封 next 跟本槽/unit-grid 对齐，不改 T4 ledger，不加 inspect", () => {
    const draft = source("src/core/studio-generation-plan-draft.ts");
    expect(draft).toContain("activeRunsEnvelopeNext");
    expect(draft).toContain("ACTIVE_RUNS_NEXT_RECONCILE");
    expect(draft).toContain("ACTIVE_RUNS_NEXT_FOLLOW_READINESS");
    expect(draft).toContain("hasUnknownCall");
    expect(draft).toContain("hasUnreviewedPair");
    expect(draft).toContain("hasInFlightRun");
    expect(draft).not.toContain("listStudioGenerationActiveRuns");
    const codex = source("src/core/codex.ts");
    expect(codex).toContain("activeRunsEnvelopeNext");
    expect(codex).toContain("operation === \"active-runs\"");
    expect(codex).toContain("generationBlocked = result.blockingRuns.length > 0");
    expect(codex).toContain("result.targetKind === \"panel\"");
    expect(codex).toContain("readPersistedUnitGridPlanState(generationLedgerSidecarPath(projectRoot), result.unitId)");
    expect(codex).toContain("run.callStatus === \"generation_unknown\"");
    expect(codex).toContain("run.hasResultPair && run.reviewStatus === \"unreviewed\"");
    expect(codex).toContain("!run.terminal");
    expect(codex).toContain("nextAction: activeRunsEnvelopeNext");
    const helperStart = codex.indexOf("if (query.operation === \"active-runs\")");
    const helperEnd = codex.indexOf("if (query.operation === \"detached-unknown\")", helperStart);
    const helper = codex.slice(helperStart, helperEnd);
    expect(helper).toContain("activeRunsEnvelopeNext");
    expect(helper).toContain("listStudioGenerationActiveRuns");
    expect(helper).not.toContain("inspectManagedProject(");
    expect(helper).not.toContain("dispatch_studio_generation_pack");
    expect(helper).not.toContain("studio-ssl5-missing-to-gen");
    const mcp = source("src/mcp/server.ts");
    expect(mcp).toContain("active-runs 返回指定单元/宫格所有 run 的完整状态投影、恢复动作与 envelope nextAction");
    expect(mcp).toContain("generationBlocked 仍只认本槽 blockingRuns");
  });

  it("operation=plan 信封 next 跟节点状态对齐，生成控制零额外 IPC，不改 T4/T5", () => {
    const draft = source("src/core/studio-generation-plan-draft.ts");
    expect(draft).toContain("planOperationEnvelopeNext");
    expect(draft).toContain("PLAN_ENVELOPE_NEXT_DISPATCH");
    expect(draft).toContain("PLAN_ENVELOPE_NEXT_CREATE");
    expect(draft).toContain('kind: "not-found" | "unscoped-list" | "scoped"');
    expect(draft).not.toContain("listStudioGenerationActiveRuns");
    const codex = source("src/core/codex.ts");
    expect(codex).toContain("planOperationEnvelopeNext");
    expect(codex).toContain("operation === \"plan\"");
    expect(codex).toContain("nextAction: planOperationEnvelopeNext");
    expect(codex).toContain('kind: "not-found"');
    expect(codex).toContain('kind: "scoped"');
    expect(codex).toContain('kind: "unscoped-list"');
    expect(codex).toContain("plan.nodes.map((node) => node.status)");
    const helperStart = codex.indexOf("if (query.operation === \"plan\")");
    const helperEnd = codex.indexOf("if (query.operation === \"history\")", helperStart);
    const helper = codex.slice(helperStart, helperEnd);
    expect(helper).toContain("planOperationEnvelopeNext");
    expect(helper).not.toContain("dispatch_studio_generation_pack");
    expect(helper).not.toContain("create_studio_generation_plan");
    expect(helper).not.toContain("studio-ssl5-missing-to-gen");
    expect(helper).not.toContain("listStudioGenerationActiveRuns");
    const control = source("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(control).toContain("planEnvelopeNextLabel");
    expect(control).toContain('data-testid="studio-generation-plan-next"');
    expect(control).toContain("planEnvelopeNextLabel([])");
    expect(control).toContain("group.nodes.map((node) => node.status)");
    expect(control).not.toContain("getStudioGenerationControlEnvelope");
    expect(control).not.toContain("operation: \"plan\"");
    const mcp = source("src/mcp/server.ts");
    expect(mcp).toContain("plan 信封 nextAction");
    expect(mcp).toContain("未限定列表或 not_found→follow-core-readiness");
    expect(mcp).toContain("get_studio_generation_control(operation=plan) 看 envelope nextAction");
    expect(mcp).toContain("wait/retry/Review 时禁止 dispatch");
  });
});
