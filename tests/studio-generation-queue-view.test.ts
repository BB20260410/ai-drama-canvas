import { describe, expect, it } from "vitest";
import {
  buildStudioGenerationPreflightPreview,
  buildStudioGenerationQueueView,
  StudioGenerationQueueViewError,
} from "../src/core/studio-generation-queue-view.js";

describe("studio-generation-queue-view（LumenX LX-1）", () => {
  it("分桶 active/done/failed 并限制条数", () => {
    const view = buildStudioGenerationQueueView(
      [
        { id: "1", status: "pending", label: "A", createdAt: 3 },
        { id: "2", status: "processing", createdAt: 4 },
        { id: "3", status: "completed", createdAt: 2 },
        { id: "4", status: "failed", createdAt: 1 },
        { id: "5", status: "cancelled", createdAt: 5 },
      ],
      { activeTab: "active", maxPerBucket: 36 },
    );
    expect(view.kind).toBe("studio-generation-queue-view");
    expect(view.totals.active).toBe(2);
    expect(view.totals.done).toBe(1);
    expect(view.totals.failed).toBe(2);
    expect(view.inFlightCount).toBe(2);
    expect(view.visible.map((t) => t.id)).toEqual(["2", "1"]); // newest first
  });

  it("分页只限制可见条目，不截断页签总数和进行中计数", () => {
    const view = buildStudioGenerationQueueView(
      Array.from({ length: 40 }, (_, index) => ({
        id: `active-${index}`,
        status: "processing",
        createdAt: index,
      })),
      { activeTab: "active", maxPerBucket: 36 },
    );
    expect(view.totals.active).toBe(40);
    expect(view.inFlightCount).toBe(40);
    expect(view.tabs.active).toHaveLength(36);
    expect(view.visible).toHaveLength(36);
    expect(view.visible[0]?.id).toBe("active-39");
  });

  it("preflight 预览：准备未闭环则不可 dispatch", () => {
    const blocked = buildStudioGenerationPreflightPreview({
      unitId: "u1",
      panelId: "p1",
      preparationReady: false,
      preparationPendingCount: 2,
      queueInFlight: 1,
      freezeReady: true,
    });
    expect(blocked.canDispatch).toBe(false);
    expect(blocked.reasons.some((r) => r.includes("准备清单"))).toBe(true);

    const ok = buildStudioGenerationPreflightPreview({
      unitId: "u1",
      panelId: "p1",
      preparationReady: true,
      preparationPendingCount: 0,
      queueInFlight: 3,
      freezeReady: true,
      provider: "codex",
    });
    expect(ok.canDispatch).toBe(true);
    expect(ok.queueInFlight).toBe(3);
    expect(ok.provider).toBe("codex");
  });

  it("非法 tab 失败", () => {
    expect(() =>
      buildStudioGenerationQueueView([], { activeTab: "nope" as "active" }),
    ).toThrow(StudioGenerationQueueViewError);
  });

  it("LumenX 取消/跳转/预览标志", async () => {
    const { resolveStudioGenerationQueueJumpTarget } = await import(
      "../src/core/studio-generation-queue-view.js"
    );
    const view = buildStudioGenerationQueueView([
      {
        id: "j1",
        status: "queued",
        itemId: "item-9",
        previewPath: "/tmp/x.png",
        previewKind: "image",
        canCancel: true,
      },
    ]);
    const task = view.visible[0]!;
    expect(task.canCancel).toBe(true);
    expect(task.canJump).toBe(true);
    expect(task.canPreview).toBe(true);
    expect(resolveStudioGenerationQueueJumpTarget(task)).toEqual({ kind: "item", targetId: "item-9" });
  });

  it("jump 优先 panel/unit，并回传 unitId/panelId", async () => {
    const { resolveStudioGenerationQueueJumpTarget } = await import(
      "../src/core/studio-generation-queue-view.js"
    );
    expect(resolveStudioGenerationQueueJumpTarget({
      id: "j2",
      itemId: "item-legacy",
      unitId: "unit-1",
      panelId: "panel-1",
    })).toEqual({
      kind: "panel",
      targetId: "panel-1",
      unitId: "unit-1",
      panelId: "panel-1",
    });
    expect(resolveStudioGenerationQueueJumpTarget({
      id: "j3",
      itemId: "item-legacy",
      unitId: "unit-2",
    })).toEqual({ kind: "unit", targetId: "unit-2", unitId: "unit-2" });
  });
});
