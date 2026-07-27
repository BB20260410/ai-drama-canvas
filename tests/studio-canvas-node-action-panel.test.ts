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
