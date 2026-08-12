import { describe, expect, it } from "vitest";
import { projectLegacyCanvasFlow } from "../src/renderer/src/legacy-canvas-flow-projection.js";
import type { LegacyCanvasFlowProjectionInput } from "../src/renderer/src/legacy-canvas-flow-projection.js";

function fixture(): LegacyCanvasFlowProjectionInput {
  return {
    visibleItems: [
      {
        item: {
          id: "item-a", stage: "剧本", title: "开场", status: "视频生成中", dependencies: [], artifactIds: ["video-a"],
        } as unknown as LegacyCanvasFlowProjectionInput["visibleItems"][number]["item"],
        artifacts: [{ id: "video-a", kind: "video", deprecated: false }] as LegacyCanvasFlowProjectionInput["visibleItems"][number]["artifacts"],
      },
      {
        item: {
          id: "item-b", stage: "视频", title: "承接", status: "已完成", dependencies: ["item-a"], artifactIds: [],
        } as unknown as LegacyCanvasFlowProjectionInput["visibleItems"][number]["item"],
        artifacts: [],
      },
    ],
    canvasState: {
      entities: [
        { id: "group-1", kind: "group", title: "组", position: { x: 700, y: 40 }, width: 720, height: 420, memberIds: ["item-b"], memberOffsets: { "item-b": { x: 30, y: 70 } }, createdAt: "2026-01-01" },
        { id: "note-1", kind: "note", title: "注", position: { x: 20, y: 20 }, width: 280, height: 190, memberIds: [], memberOffsets: {}, createdAt: "2026-01-02" },
      ],
      links: [{ id: "link-1", sourceId: "note-1", targetId: "item-a", kind: "reference", label: "" }],
    } as unknown as LegacyCanvasFlowProjectionInput["canvasState"],
    adaptationWorkspace: {
      facts: [{ id: "fact-1", kind: "event", statement: "事件", sourceSpans: [{ sourceId: "chapter-1", startOffset: 0 }], epistemicStatus: "confirmed", revision: 1 }],
      beats: [{ id: "beat-1", order: 1, title: "节拍", narrativePurpose: "推进", estimatedDurationSeconds: 3, intensity: 4, factIds: ["fact-1"] }],
      plans: [{ id: "plan-1", mode: "concise", status: "selected", units: [{ beatIds: ["beat-1"], storyboardRows: [{ itemId: "item-a" }, { itemId: "planned:later" }] }], validation: { hardErrors: [] } }],
    } as unknown as LegacyCanvasFlowProjectionInput["adaptationWorkspace"],
    positions: { "item-a": { x: 44, y: 55 } },
    showNarrative: true,
    compact: true,
    actions: { editCanvasEntity: () => undefined, removeCanvasEntity: () => undefined },
  };
}

describe("legacy canvas flow projection", () => {
  it("仅投影可见项，保留 stage/item/group/note/dependency/semantic/narrative 语义", () => {
    const projected = projectLegacyCanvasFlow(fixture());
    const ids = projected.nodes.map((node) => node.id);
    expect(ids).toEqual(expect.arrayContaining(["zone-剧本", "zone-视频", "item-a", "item-b", "group-1", "note-1", "narrative-plan-plan-1"]));
    expect(projected.nodes.find((node) => node.id === "item-b")).toMatchObject({ parentNode: "group-1", position: { x: 30, y: 70 } });
    expect(projected.nodes.find((node) => node.id === "item-a")).toMatchObject({ position: { x: 44, y: 55 }, data: { compact: true, videoCount: 1 } });
    expect(projected.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "item-a-item-b", source: "item-a", target: "item-b", animated: false }),
      expect.objectContaining({ id: "link-1", label: "参考", zIndex: 3 }),
      expect.objectContaining({ id: "plan-plan-1-item-a", animated: true }),
      expect.objectContaining({ id: "fact-fact-1-beat-1" }),
    ]));
    expect(projected.edges.find((edge) => edge.id.includes("planned:later"))).toBeUndefined();
  });

  it("关闭叙事时不输出叙事节点或关系", () => {
    const input = fixture();
    input.showNarrative = false;
    const projected = projectLegacyCanvasFlow(input);
    expect(projected.nodes.some((node) => node.type === "narrative")).toBe(false);
    expect(projected.edges.some((edge) => String(edge.id).startsWith("plan-"))).toBe(false);
  });
});
