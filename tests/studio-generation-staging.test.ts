import { describe, expect, it } from "vitest";
import {
  createStudioStagingArea,
  decideStudioStagingItem,
  listPendingStudioStaging,
  stageGenerationResult,
} from "../src/core/studio-generation-staging.js";

describe("studio-generation-staging", () => {
  it("stage → accept 允许挂正式 pipeline", () => {
    let area = createStudioStagingArea();
    area = stageGenerationResult(area, {
      id: "s1",
      panelId: "S1E01-U01-G1",
      runId: "run-1",
      candidatePath: "/q/agent-out.png",
      stagedAt: "2026-07-23T00:00:00.000Z",
    });
    expect(listPendingStudioStaging(area)).toHaveLength(1);
    const r = decideStudioStagingItem(area, "s1", "accept");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.allowFormalPipelineAttach).toBe(true);
    expect(r.item.status).toBe("accepted");
    expect(listPendingStudioStaging(r.area)).toHaveLength(0);
  });

  it("discard 禁止挂正式 pipeline", () => {
    let area = createStudioStagingArea();
    area = stageGenerationResult(area, {
      id: "s2",
      panelId: "p",
      runId: "r",
      candidatePath: "/q/x.png",
    });
    const r = decideStudioStagingItem(area, "s2", "discard");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.allowFormalPipelineAttach).toBe(false);
    expect(r.item.status).toBe("discarded");
  });

  it("反向：未知 id / 重复决策 fail-close", () => {
    let area = createStudioStagingArea();
    area = stageGenerationResult(area, {
      id: "s3",
      panelId: "p",
      runId: "r",
      candidatePath: "/q/x.png",
    });
    const miss = decideStudioStagingItem(area, "nope", "accept");
    expect(miss.ok).toBe(false);
    if (miss.ok) return;
    expect(miss.code).toBe("not-found");

    const accepted = decideStudioStagingItem(area, "s3", "accept");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const again = decideStudioStagingItem(accepted.area, "s3", "discard");
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe("not-staged");
  });

  it("空 id 与重复 stage 拒绝", () => {
    let area = createStudioStagingArea();
    expect(() =>
      stageGenerationResult(area, { id: "", panelId: "p", runId: "r", candidatePath: "/q" }),
    ).toThrow(/不能为空/);
    area = stageGenerationResult(area, {
      id: "dup",
      panelId: "p",
      runId: "r",
      candidatePath: "/q",
    });
    expect(() =>
      stageGenerationResult(area, {
        id: "dup",
        panelId: "p",
        runId: "r2",
        candidatePath: "/q2",
      }),
    ).toThrow(/禁止重复 stage/);
  });
});
