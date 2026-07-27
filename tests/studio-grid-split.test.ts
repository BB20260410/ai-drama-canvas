import { describe, expect, it } from "vitest";
import { mapGridSplitToPanelOrdinals, planStudioGridSplit } from "../src/core/studio-grid-split.js";

describe("planStudioGridSplit", () => {
  it("2x3 均匀切 1920x1080", () => {
    const plan = planStudioGridSplit({ imageWidth: 1920, imageHeight: 1080, rows: 2, cols: 3 });
    expect(plan.cells).toHaveLength(6);
    expect(plan.cells[0]).toMatchObject({ index: 0, left: 0, top: 0, width: 640, height: 540 });
    expect(plan.cells[5]).toMatchObject({ index: 5, row: 1, col: 2, left: 1280, top: 540 });
  });

  it("拒绝非法尺寸", () => {
    expect(() => planStudioGridSplit({ imageWidth: 0, imageHeight: 100, rows: 1, cols: 1 })).toThrow(/正整数/);
    expect(() => planStudioGridSplit({ imageWidth: 100, imageHeight: 100, rows: 0, cols: 1 })).toThrow(/1\.\.12/);
  });

  it("映射到 1-based 宫格序号", () => {
    const plan = planStudioGridSplit({ imageWidth: 900, imageHeight: 600, rows: 2, cols: 3 });
    const mapped = mapGridSplitToPanelOrdinals(plan, [1, 2, 3]);
    expect(mapped.map((m) => m.ordinal)).toEqual([1, 2, 3]);
    expect(mapped[0]!.cell.index).toBe(0);
  });

  it("宫格多于切块时失败", () => {
    const plan = planStudioGridSplit({ imageWidth: 100, imageHeight: 100, rows: 1, cols: 2 });
    expect(() => mapGridSplitToPanelOrdinals(plan, [1, 2, 3])).toThrow(/只有 2 块/);
  });
});
