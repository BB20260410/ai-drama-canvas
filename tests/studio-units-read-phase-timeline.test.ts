import { describe, expect, it } from "vitest";
import {
  measureStudioUnitsReadPhase,
  recordStudioUnitsReadCounter,
  withStudioUnitsReadProbe,
} from "../src/core/studio-units-read-phase-timeline.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Studio units 请求级只读阶段探针", () => {
  it("关闭时不读时钟、不通知观察器，并原样透传返回值", async () => {
    let clockReads = 0;
    let observerCalls = 0;
    const value = { ok: true };
    const result = await withStudioUnitsReadProbe(false, async () => value, {
      now: () => {
        clockReads += 1;
        return 0;
      },
      onPhase: () => {
        observerCalls += 1;
      },
    });

    expect(result).toEqual({ value });
    expect(result.value).toBe(value);
    expect(clockReads).toBe(0);
    expect(observerCalls).toBe(0);
  });

  it("启用时记录相对起点、持续时间和匿名计数，观察器异常不改变结果", async () => {
    let nowMs = 100;
    const observed: string[] = [];
    const result = await withStudioUnitsReadProbe(true, async () => {
      const value = await measureStudioUnitsReadPhase("production-page", async () => {
        recordStudioUnitsReadCounter("unitPageQueries");
        recordStudioUnitsReadCounter("unitTimingQueries", 2);
        recordStudioUnitsReadCounter("episodeStartQueries", 2);
        recordStudioUnitsReadCounter("productionBusinessSqlExecutions", 5);
        nowMs = 145;
        return "ok";
      });
      recordStudioUnitsReadCounter("returnedUnitCount", 2);
      return value;
    }, {
      now: () => nowMs,
      onPhase: (phase) => {
        observed.push(phase.phase);
        throw new Error("diagnostic observer failure");
      },
    });

    expect(result.value).toBe("ok");
    expect(observed).toEqual(["production-page"]);
    expect(result.snapshot).toMatchObject({
      schemaVersion: 1,
      phases: [{ phase: "production-page", startOffsetMs: 0, durationMs: 45 }],
      counters: {
        productionBusinessSqlExecutions: 5,
        unitPageQueries: 1,
        unitTimingQueries: 2,
        episodeStartQueries: 2,
        returnedUnitCount: 2,
      },
    });
  });

  it("业务失败仍以 finally 记录阶段，并原样抛出原错误", async () => {
    const expected = new Error("owner failed");
    let nowMs = 10;
    const phases: string[] = [];

    await expect(withStudioUnitsReadProbe(true, async () => {
      await measureStudioUnitsReadPhase("binding-heads", async () => {
        nowMs = 18;
        throw expected;
      });
    }, {
      now: () => nowMs,
      onPhase: (phase) => phases.push(phase.phase),
    })).rejects.toBe(expected);
    expect(phases).toEqual(["binding-heads"]);
  });

  it("并发请求的阶段与计数由 AsyncLocalStorage 隔离", async () => {
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();

    const first = withStudioUnitsReadProbe(true, async () => {
      return measureStudioUnitsReadPhase("production-page", async () => {
        recordStudioUnitsReadCounter("unitTimingQueries", 3);
        await firstGate.promise;
        return "first";
      });
    }, { now: () => 0 });
    const second = withStudioUnitsReadProbe(true, async () => {
      return measureStudioUnitsReadPhase("production-facets", async () => {
        recordStudioUnitsReadCounter("facetQueries", 3);
        await secondGate.promise;
        return "second";
      });
    }, { now: () => 0 });

    secondGate.resolve();
    firstGate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.snapshot?.phases.map((phase) => phase.phase)).toEqual(["production-page"]);
    expect(firstResult.snapshot?.counters.unitTimingQueries).toBe(3);
    expect(firstResult.snapshot?.counters.facetQueries).toBe(0);
    expect(secondResult.snapshot?.phases.map((phase) => phase.phase)).toEqual(["production-facets"]);
    expect(secondResult.snapshot?.counters.unitTimingQueries).toBe(0);
    expect(secondResult.snapshot?.counters.facetQueries).toBe(3);
  });
});
