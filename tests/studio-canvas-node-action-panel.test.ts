import { describe, expect, it } from "vitest";
import { buildStudioCanvasNodeActionPanel } from "../src/core/studio-canvas-node-action-panel.js";
import {
  createStudioCanvasNodeStatusStore,
  labelForStudioCanvasNodeStatusStep,
} from "../src/core/studio-canvas-node-status.js";

describe("studio-canvas-node-action-panel + status（Local #1 backlog）", () => {
  it("宫格面板含驾驶舱/绑定/冻结派发动作", () => {
    const panel = buildStudioCanvasNodeActionPanel({
      kind: "panel",
      id: "p1",
      unitId: "u1",
      panelId: "p1",
      title: "格1",
      status: "generation-ready",
      bindingCurrentness: "current",
      visualAction: "推镜头",
      dialogue: "台词",
      assetCount: 2,
      canFreezeDispatch: true,
    });
    expect(panel.kind).toBe("studio-canvas-node-action-panel");
    expect(panel.actions.some((a) => a.code === "open-dashboard" && a.enabled)).toBe(true);
    expect(panel.actions.some((a) => a.code === "open-binding" && a.enabled)).toBe(true);
    expect(panel.actions.some((a) => a.code === "freeze-dispatch" && a.enabled)).toBe(true);
    expect(panel.fields.some((f) => f.key === "dialogue" && f.value === "台词")).toBe(true);
    expect(panel.fields.some((f) => f.key === "next")).toBe(false);
  });

  it("unit-grid wait/retry/Review 时 freeze-dispatch 禁用，planned 不挡", () => {
    const waiting = buildStudioCanvasNodeActionPanel({
      kind: "panel",
      id: "p1",
      unitId: "u1",
      panelId: "p1",
      canFreezeDispatch: true,
      unitGridNextActionCode: "wait-or-reconcile-unit-grid-run",
      unitGridNextActionLabel: "unit-grid 正在执行，等待结果或对账现有 run",
    });
    expect(waiting.fields.some((f) => f.key === "next" && f.value.includes("等待结果"))).toBe(true);
    expect(waiting.actions.some((a) => a.code === "freeze-dispatch" && a.enabled === false)).toBe(true);
    expect(waiting.actions.find((a) => a.code === "freeze-dispatch")?.reason).toContain("等待结果");
    expect(waiting.actions.some((a) => a.code === "open-dashboard" && a.enabled)).toBe(true);

    const retrying = buildStudioCanvasNodeActionPanel({
      kind: "panel",
      id: "p1",
      unitId: "u1",
      panelId: "p1",
      canFreezeDispatch: true,
      unitGridNextActionCode: "retry-unit-grid-plan-nodes",
    });
    expect(retrying.actions.find((a) => a.code === "freeze-dispatch")?.enabled).toBe(false);
    expect(retrying.actions.find((a) => a.code === "freeze-dispatch")?.label).toContain("retry");

    const review = buildStudioCanvasNodeActionPanel({
      kind: "panel",
      id: "p1",
      unitId: "u1",
      panelId: "p1",
      canFreezeDispatch: true,
      unitGridNextActionCode: "submit-unit-grid-review",
    });
    expect(review.actions.find((a) => a.code === "freeze-dispatch")?.enabled).toBe(false);
    expect(review.actions.find((a) => a.code === "freeze-dispatch")?.label).toContain("Review");

    const planned = buildStudioCanvasNodeActionPanel({
      kind: "panel",
      id: "p1",
      unitId: "u1",
      panelId: "p1",
      canFreezeDispatch: true,
      unitGridNextActionCode: "dispatch-unit-grid",
      unitGridNextActionLabel: "派发整板生成",
    });
    expect(planned.fields.some((f) => f.key === "next" && f.value === "派发整板生成")).toBe(true);
    expect(planned.actions.some((a) => a.code === "freeze-dispatch" && a.enabled)).toBe(true);
  });

  it("overview 六图闸未放行时 freeze-dispatch 禁用，未投影不挡，unit-grid wait 文案优先", () => {
    const blocked = buildStudioCanvasNodeActionPanel({
      kind: "panel",
      id: "p1",
      unitId: "u1",
      panelId: "p1",
      canFreezeDispatch: true,
      checkpointNewSlotDispatchAllowed: false,
      checkpointBlockingBatchNumber: 4,
    });
    expect(blocked.actions.find((a) => a.code === "freeze-dispatch")?.enabled).toBe(false);
    expect(blocked.actions.find((a) => a.code === "freeze-dispatch")?.reason).toContain("batch 4");
    expect(blocked.fields.some((f) => f.key === "next" && String(f.value).includes("六图闸未放行"))).toBe(true);

    const unprojected = buildStudioCanvasNodeActionPanel({
      kind: "panel",
      id: "p1",
      unitId: "u1",
      panelId: "p1",
      canFreezeDispatch: true,
    });
    expect(unprojected.actions.some((a) => a.code === "freeze-dispatch" && a.enabled)).toBe(true);
    expect(unprojected.fields.some((f) => f.key === "next")).toBe(false);

    const waitWins = buildStudioCanvasNodeActionPanel({
      kind: "panel",
      id: "p1",
      unitId: "u1",
      panelId: "p1",
      canFreezeDispatch: true,
      unitGridNextActionCode: "wait-or-reconcile-unit-grid-run",
      unitGridNextActionLabel: "unit-grid 正在执行，等待结果或对账现有 run",
      checkpointNewSlotDispatchAllowed: false,
      checkpointBlockingBatchNumber: 4,
    });
    expect(waitWins.actions.find((a) => a.code === "freeze-dispatch")?.reason).toContain("等待结果");
    expect(waitWins.actions.find((a) => a.code === "freeze-dispatch")?.reason).not.toContain("六图闸");
    expect(waitWins.fields.some((f) => f.key === "next" && String(f.value).includes("等待结果"))).toBe(true);
  });

  it("status store set/clear/isBusy", () => {
    const store = createStudioCanvasNodeStatusStore();
    store.set("panel:p1", { step: "image", message: "生图中" });
    expect(store.isBusy("panel:p1")).toBe(true);
    expect(store.get("panel:p1")?.step).toBe("image");
    expect(labelForStudioCanvasNodeStatusStep("image")).toBe("生图中");
    store.clear("panel:p1");
    expect(store.isBusy("panel:p1")).toBe(false);
  });
});
