import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createStudioCanvasWorkflowGroup,
  extractStudioCanvasPanelIdsFromSelection,
} from "../src/core/studio-canvas-workflow-groups-core.js";

describe("studio canvas workflow groups browser boundary", () => {
  it("纯函数入口不依赖 Node 布局实现", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/core/studio-canvas-workflow-groups-core.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']\.\/studio-canvas-layout\.js["']/u);
    expect(source).not.toMatch(/from\s+["']node:crypto["']/u);
  });

  it("renderer 所需选择与建组行为保持一致", () => {
    const panelIds = extractStudioCanvasPanelIdsFromSelection([
      "panel:p-01",
      { data: { panelId: "p-02" } },
      { kind: "panel", id: "p-01" },
    ]);
    expect(panelIds).toEqual(["p-01", "p-02"]);
    expect(createStudioCanvasWorkflowGroup([], {
      panelIds,
      id: "wg-browser",
      now: "2026-07-18T00:00:00.000Z",
    })).toEqual([{
      id: "wg-browser",
      title: "工作流 1",
      panelIds: ["p-01", "p-02"],
      pipeline: ["image"],
      createdAt: "2026-07-18T00:00:00.000Z",
    }]);
  });
});
