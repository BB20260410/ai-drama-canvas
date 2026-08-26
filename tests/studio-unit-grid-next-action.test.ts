import { describe, expect, it } from "vitest";
import { projectStudioUnitGridNextAction } from "../src/core/studio-unit-grid-next-action.js";
import { unitGridProjectionToDashboardNextAction } from "../src/core/studio-production-dashboard.js";

describe("projectStudioUnitGridNextAction", () => {
  it("generation_unknown 禁止 panel 生图且禁止新 run", () => {
    const p = projectStudioUnitGridNextAction({
      hasCurrentPack: true,
      callStatus: "generation_unknown",
    });
    expect(p.forbidPanelGenerate).toBe(true);
    expect(p.allowNewUnitGridRun).toBe(false);
    expect(p.code).toBe("reconcile-unit-grid-call");
    expect(p.targetKind).toBe("unit-grid");
  });

  it("not-invoked 后只允许新 unit-grid run，不投影 panel generate", () => {
    const p = projectStudioUnitGridNextAction({
      hasCurrentPack: true,
      callStatus: "not-invoked",
    });
    expect(p.phase).toBe("not-invoked-needs-new-run");
    expect(p.forbidPanelGenerate).toBe(true);
    expect(p.allowNewUnitGridRun).toBe(true);
    expect(p.code).not.toMatch(/panel|execute-agent-imagegen/i);
  });

  it("owner-abandoned 保留远端未知事实、拒收迟到结果并只允许新 unit-grid run", () => {
    const p = projectStudioUnitGridNextAction({
      hasCurrentPack: true,
      callStatus: "owner-abandoned",
    });
    expect(p.phase).toBe("abandoned-needs-new-run");
    expect(p.forbidPanelGenerate).toBe(true);
    expect(p.allowNewUnitGridRun).toBe(true);
    expect(p.code).toBe("new-unit-grid-run-required-after-owner-abandon");
    expect(p.label).toContain("迟到结果拒收");
    expect(p.code).not.toMatch(/panel|execute-agent-imagegen/i);
  });

  it("result-committed + review pass 禁止 panel 生图", () => {
    const p = projectStudioUnitGridNextAction({
      hasCurrentPack: true,
      callStatus: "result-committed",
      pairComplete: true,
      reviewDecision: "pass",
    });
    expect(p.phase).toBe("approved");
    expect(p.forbidPanelGenerate).toBe(true);
    expect(p.allowNewUnitGridRun).toBe(false);
  });

  it("pairComplete 待审禁止 panel 生图", () => {
    const p = projectStudioUnitGridNextAction({
      hasCurrentPack: true,
      pairComplete: true,
      reviewDecision: "pending",
    });
    expect(p.phase).toBe("pending-review");
    expect(p.forbidPanelGenerate).toBe(true);
  });

  it("非终态 unit-grid run 只能等待或对账，禁止重复派发", () => {
    const p = projectStudioUnitGridNextAction({
      hasCurrentPack: true,
      hasActiveRun: true,
    });
    expect(p.phase).toBe("in-flight");
    expect(p.code).toBe("wait-or-reconcile-unit-grid-run");
    expect(p.forbidPanelGenerate).toBe(true);
    expect(p.allowNewUnitGridRun).toBe(false);
  });

  it("已落盘 pack 无计划时 ready-to-plan，不直接派发", () => {
    const p = projectStudioUnitGridNextAction({
      hasCurrentPack: true,
      hasCurrentPlan: false,
    });
    expect(p.phase).toBe("ready-to-plan");
    expect(p.code).toBe("create-unit-grid-plan");
    expect(p.label).toContain("不派发");
    expect(p.forbidPanelGenerate).toBe(true);
    expect(p.allowNewUnitGridRun).toBe(true);
    const next = unitGridProjectionToDashboardNextAction("project-test", "S1E01-U01", p);
    expect(next.code).toBe("create-unit-grid-plan");
    expect(next.requiresWrite).toBe(true);
    expect(next.reason).toMatch(/禁止 panel/);
  });

  it("未声明 hasCurrentPlan 时保持有包即派发", () => {
    const p = projectStudioUnitGridNextAction({ hasCurrentPack: true });
    expect(p.phase).toBe("ready-to-dispatch");
    expect(p.code).toBe("dispatch-unit-grid");
  });

  it("Dashboard 映射保留 unit locator 且 reason 禁止 panel 生图", () => {
    const projection = projectStudioUnitGridNextAction({
      hasCurrentPack: true,
      callStatus: "result-committed",
      pairComplete: true,
      reviewDecision: "pass",
    });
    const next = unitGridProjectionToDashboardNextAction("project-test", "S1E01-U01", projection);
    expect(next.code).toBe("unit-grid-approved");
    expect(next.reason).toMatch(/禁止 panel/);
    expect(next.locator).toMatchObject({ kind: "unit", projectId: "project-test", unitId: "S1E01-U01" });
  });
});
