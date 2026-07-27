import { describe, expect, it } from "vitest";
import {
  decodeStudioCanvasFocus,
  encodeStudioCanvasFocus,
  intentOpenCanvasFromDashboard,
  intentOpenDashboardFromCanvas,
  studioCanvasFocusMatches,
} from "../src/core/studio-canvas-locator.js";

describe("studio-canvas-locator", () => {
  it("dashboard → canvas → dashboard 往返 locator 稳定", () => {
    const open = intentOpenCanvasFromDashboard({
      unitId: "p7-unit-b-two-panel",
      panelId: "p7-unit-b-panel-01",
    });
    expect(open.mode).toBe("canvas");
    expect(open.focus.unitId).toBe("p7-unit-b-two-panel");
    expect(open.focus.panelId).toBe("p7-unit-b-panel-01");
    expect(open.focus.fromMode).toBe("dashboard");

    const back = intentOpenDashboardFromCanvas({
      unitId: open.focus.unitId,
      panelId: open.focus.panelId,
    });
    expect(back.mode).toBe("dashboard");
    expect(studioCanvasFocusMatches(
      { unitId: back.focus.unitId, panelId: back.focus.panelId },
      open.focus,
    )).toBe(true);

    const encoded = encodeStudioCanvasFocus(open.focus);
    expect(decodeStudioCanvasFocus(encoded)).toEqual(open.focus);
  });

  it("非法 focus 失败关闭", () => {
    expect(() => intentOpenCanvasFromDashboard({})).toThrow(/至少需要/);
    expect(() => encodeStudioCanvasFocus({ unitId: "bad id" })).toThrow(/非法/);
  });
});
