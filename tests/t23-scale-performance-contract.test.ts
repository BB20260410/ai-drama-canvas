import { describe, expect, it } from "vitest";
import {
  evaluateT23ScalePerformance,
  T23_SCALE_PERFORMANCE_BUDGET,
  type T23ScalePerformanceMeasurements,
} from "../scripts/lib/t23-scale-performance-contract.js";

const passingMeasurements: T23ScalePerformanceMeasurements = {
  fixtureUnitCount: 36,
  projectedUnitNodeCount: 36,
  uniqueProjectedUnitNodeCount: 36,
  passRawCount: 4,
  uniqueRawShaCount: 4,
  uniqueRawUrlCount: 4,
  referenceCount: 4,
  uniqueReferenceShaCount: 4,
  uniqueReferenceUrlCount: 4,
  devToolchainToCdpReadyMs: 8_000,
  rendererFirstCardMs: 1_000,
  rendererFirstRawMs: 2_000,
  rendererAllPassReferencesMs: 3_000,
  peakOutstandingProjectionIpc: 4,
};

describe("T23 源码 dev 规模硬预算", () => {
  it("全部满足时才 PASS", () => {
    expect(evaluateT23ScalePerformance(passingMeasurements)).toMatchObject({
      ok: true,
      status: "PASS",
      checks: expect.not.arrayContaining([
        expect.objectContaining({ status: "FAIL" }),
      ]),
    });
  });

  it.each([
    ["单元不足", { fixtureUnitCount: 35 }, "fixture-unit-count"],
    ["renderer 单元节点不足", { projectedUnitNodeCount: 35 }, "renderer-unit-node-count"],
    ["renderer 单元节点重复", {
      uniqueProjectedUnitNodeCount: 35,
    }, "renderer-unique-unit-node-count"],
    ["PASS raw 不足", { passRawCount: 3 }, "fixture-pass-raw-count"],
    ["raw SHA 重复", { uniqueRawShaCount: 3 }, "fixture-unique-raw-sha-count"],
    ["raw URL 重复", { uniqueRawUrlCount: 3 }, "renderer-unique-raw-url-count"],
    ["参考不足", { referenceCount: 3 }, "fixture-reference-count"],
    ["参考 SHA 重复", {
      uniqueReferenceShaCount: 3,
    }, "fixture-unique-reference-sha-count"],
    ["参考 URL 重复", {
      uniqueReferenceUrlCount: 3,
    }, "renderer-unique-reference-url-count"],
    ["dev 冷启动超时", {
      devToolchainToCdpReadyMs: T23_SCALE_PERFORMANCE_BUDGET.maxDevToolchainToCdpReadyMs + 1,
    }, "dev-toolchain-to-cdp"],
    ["首卡超时", {
      rendererFirstCardMs: T23_SCALE_PERFORMANCE_BUDGET.maxRendererFirstCardMs + 1,
    }, "renderer-first-card"],
    ["首 raw 超时", {
      rendererFirstRawMs: T23_SCALE_PERFORMANCE_BUDGET.maxRendererFirstRawMs + 1,
    }, "renderer-first-raw"],
    ["全参考超时", {
      rendererAllPassReferencesMs:
        T23_SCALE_PERFORMANCE_BUDGET.maxRendererAllPassReferencesMs + 1,
    }, "renderer-all-pass-references"],
    ["IPC 峰值超限", {
      peakOutstandingProjectionIpc:
        T23_SCALE_PERFORMANCE_BUDGET.maxOutstandingProjectionIpc + 1,
    }, "peak-outstanding-projection-ipc"],
  ])("%s 必须 FAIL，禁止 PASS + WARN", (_label, patch, failedId) => {
    const result = evaluateT23ScalePerformance({ ...passingMeasurements, ...patch });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("FAIL");
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: failedId,
      status: "FAIL",
    }));
  });

  it("NaN 等无效计时同样 fail closed", () => {
    const result = evaluateT23ScalePerformance({
      ...passingMeasurements,
      rendererFirstRawMs: Number.NaN,
    });
    expect(result.status).toBe("FAIL");
    expect(result.checks.find((check) => check.id === "renderer-first-raw")?.status)
      .toBe("FAIL");
  });
});
