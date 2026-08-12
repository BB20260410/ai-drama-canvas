import { describe, expect, it } from "vitest";
import {
  beginStudioProjectionPhase,
  finishStudioProjectionPhase,
  measureStudioProjectionPhase,
  type StudioProjectionPhaseTiming,
} from "../src/core/studio-projection-phase-timeline.js";

describe("Studio 深投影分阶段计时", () => {
  it("默认关闭时不读时钟、不产生诊断，也不改变返回值", async () => {
    let workCalls = 0;
    const startedAt = beginStudioProjectionPhase(undefined);
    const result = await measureStudioProjectionPhase(undefined, "panel-fanout", async () => {
      workCalls += 1;
      return "ok";
    });
    finishStudioProjectionPhase(undefined, startedAt, "core-total");
    expect(result).toBe("ok");
    expect(workCalls).toBe(1);
    expect(startedAt).toBeUndefined();
  });

  it("按确定顺序记录阶段和 core-total，诊断回调异常不影响正式工作", async () => {
    const clock = [100, 110, 135, 160];
    const phases: StudioProjectionPhaseTiming[] = [];
    const instrumentation = {
      now: () => clock.shift()!,
      onPhase: (phase: StudioProjectionPhaseTiming) => {
        phases.push(phase);
        if (phase.phase === "panel-fanout") throw new Error("observer-only failure");
      },
    };
    const totalStartedAt = beginStudioProjectionPhase(instrumentation);
    await expect(measureStudioProjectionPhase(
      instrumentation,
      "panel-fanout",
      async () => "ok",
      () => ({ panelCount: 6, controlAssetCount: 12 }),
    )).resolves.toBe("ok");
    finishStudioProjectionPhase(instrumentation, totalStartedAt, "core-total");
    expect(phases).toEqual([
      { phase: "panel-fanout", durationMs: 25, panelCount: 6, controlAssetCount: 12 },
      { phase: "core-total", durationMs: 60 },
    ]);
  });

  it("阶段工作失败时仍记录耗时并原样抛出错误", async () => {
    const phases: StudioProjectionPhaseTiming[] = [];
    const clock = [10, 18];
    await expect(measureStudioProjectionPhase(
      { now: () => clock.shift()!, onPhase: (phase) => phases.push(phase) },
      "observation-review",
      async () => { throw new Error("owner failed"); },
    )).rejects.toThrow("owner failed");
    expect(phases).toEqual([{ phase: "observation-review", durationMs: 8 }]);
  });
});
