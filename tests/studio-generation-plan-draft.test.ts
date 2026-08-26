import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  composeStudioGenerationPlanDraft,
  STUDIO_GENERATION_PLAN_COMMAND,
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
});

describe("create-plan 草稿接线源码合同", () => {
  it("薄模块不拉对照板 / 不执行 / 不派发", () => {
    const draft = source("src/core/studio-generation-plan-draft.ts");
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
    expect(control).toContain("persistedUnitGridPackIdForDraft");
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
    expect(computed).not.toContain("unitGridReadinessPackId");
    expect(computed).not.toContain("selectedPackId");
    expect(control).toContain("`unit-grid ${node.unitId}`");
  });

  it("pack envelope 已落盘包起草 create-plan，不拉对照板", () => {
    const codex = source("src/core/codex.ts");
    expect(codex).toContain("composeStudioGenerationPlanDraft");
    expect(codex).toContain("composePersistedPackGenerationPlanDraft");
    expect(codex).toContain('targetKind: "unit-grid"');
    expect(codex).toContain("generationPlanDraft: composePersistedPackGenerationPlanDraft(pack)");
    expect(codex).toContain('next: "create-plan → dispatch(provider=codex)');
    expect(codex).toContain('next: "create-plan → dispatch(provider=codex|grok)');
    expect(codex).toContain('next: "freeze → create-plan → dispatch(provider=codex)');
    expect(codex).toContain('next: "freeze → create-plan → dispatch(provider=codex|grok)');
    expect(codex).not.toContain('next: "freeze → dispatch(provider=codex|grok)');
    expect(codex).not.toContain("studio-ssl5-missing-to-gen");
    expect(codex).not.toContain("studio-script-media-align");
    const helperStart = codex.indexOf("function composePersistedPackGenerationPlanDraft");
    const helperEnd = codex.indexOf("function sameSortedStrings", helperStart);
    const helper = codex.slice(helperStart, helperEnd);
    expect(helper).toContain("pack.id");
    expect(helper).toContain("pack.target.panelId");
    expect(helper).not.toContain("unitGridReadinessPackId");
    expect(helper).not.toContain("candidate.packId");
  });
});
