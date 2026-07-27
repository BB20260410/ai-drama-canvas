export interface T23ScalePerformanceBudget {
  minUnitCount: number;
  minProjectedUnitNodeCount: number;
  minUniqueProjectedUnitNodeCount: number;
  minPassRawCount: number;
  minUniqueRawShaCount: number;
  minUniqueRawUrlCount: number;
  minReferenceCount: number;
  minUniqueReferenceShaCount: number;
  minUniqueReferenceUrlCount: number;
  maxDevToolchainToCdpReadyMs: number;
  maxRendererFirstCardMs: number;
  maxRendererFirstRawMs: number;
  maxRendererAllPassReferencesMs: number;
  maxOutstandingProjectionIpc: number;
}

export interface T23ScalePerformanceMeasurements {
  fixtureUnitCount: number;
  projectedUnitNodeCount: number;
  uniqueProjectedUnitNodeCount: number;
  passRawCount: number;
  uniqueRawShaCount: number;
  uniqueRawUrlCount: number;
  referenceCount: number;
  uniqueReferenceShaCount: number;
  uniqueReferenceUrlCount: number;
  devToolchainToCdpReadyMs: number;
  rendererFirstCardMs: number;
  rendererFirstRawMs: number;
  rendererAllPassReferencesMs: number;
  peakOutstandingProjectionIpc: number;
}

export interface T23ScalePerformanceCheck {
  id:
    | "fixture-unit-count"
    | "renderer-unit-node-count"
    | "renderer-unique-unit-node-count"
    | "fixture-pass-raw-count"
    | "fixture-unique-raw-sha-count"
    | "renderer-unique-raw-url-count"
    | "fixture-reference-count"
    | "fixture-unique-reference-sha-count"
    | "renderer-unique-reference-url-count"
    | "dev-toolchain-to-cdp"
    | "renderer-first-card"
    | "renderer-first-raw"
    | "renderer-all-pass-references"
    | "peak-outstanding-projection-ipc";
  status: "PASS" | "FAIL";
  actual: number;
  comparator: ">=" | "<=";
  budget: number;
}

export interface T23ScalePerformanceEvaluation {
  ok: boolean;
  status: "PASS" | "FAIL";
  budget: T23ScalePerformanceBudget;
  measurements: T23ScalePerformanceMeasurements;
  checks: T23ScalePerformanceCheck[];
}

export const T23_SCALE_PERFORMANCE_BUDGET: T23ScalePerformanceBudget = {
  minUnitCount: 36,
  minProjectedUnitNodeCount: 36,
  minUniqueProjectedUnitNodeCount: 36,
  minPassRawCount: 4,
  minUniqueRawShaCount: 4,
  minUniqueRawUrlCount: 4,
  minReferenceCount: 4,
  minUniqueReferenceShaCount: 4,
  minUniqueReferenceUrlCount: 4,
  // dev 冷启动含 Vite 首次编译、Electron 启动与 CDP 就绪；不与 renderer 导航计时混算。
  maxDevToolchainToCdpReadyMs: 30_000,
  // 以下三个时刻均直接读取 renderer performance.now()，相对该 renderer 导航起点。
  maxRendererFirstCardMs: 8_000,
  maxRendererFirstRawMs: 20_000,
  maxRendererAllPassReferencesMs: 30_000,
  // 只统计 raw/冻结参考深核验实际使用的投影 IPC 通道。
  maxOutstandingProjectionIpc: 16,
};

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function atLeast(
  id: T23ScalePerformanceCheck["id"],
  actual: number,
  budget: number,
): T23ScalePerformanceCheck {
  return {
    id,
    status: finiteNonNegative(actual) && actual >= budget ? "PASS" : "FAIL",
    actual,
    comparator: ">=",
    budget,
  };
}

function atMost(
  id: T23ScalePerformanceCheck["id"],
  actual: number,
  budget: number,
): T23ScalePerformanceCheck {
  return {
    id,
    status: finiteNonNegative(actual) && actual <= budget ? "PASS" : "FAIL",
    actual,
    comparator: "<=",
    budget,
  };
}

/**
 * T23 规模门只存在 PASS/FAIL；任何一项超过硬预算都会令总门 FAIL，
 * 不允许退化成 “PASS + WARN”。
 */
export function evaluateT23ScalePerformance(
  measurements: T23ScalePerformanceMeasurements,
  budget: T23ScalePerformanceBudget = T23_SCALE_PERFORMANCE_BUDGET,
): T23ScalePerformanceEvaluation {
  const checks: T23ScalePerformanceCheck[] = [
    atLeast("fixture-unit-count", measurements.fixtureUnitCount, budget.minUnitCount),
    atLeast(
      "renderer-unit-node-count",
      measurements.projectedUnitNodeCount,
      budget.minProjectedUnitNodeCount,
    ),
    atLeast(
      "renderer-unique-unit-node-count",
      measurements.uniqueProjectedUnitNodeCount,
      budget.minUniqueProjectedUnitNodeCount,
    ),
    atLeast("fixture-pass-raw-count", measurements.passRawCount, budget.minPassRawCount),
    atLeast(
      "fixture-unique-raw-sha-count",
      measurements.uniqueRawShaCount,
      budget.minUniqueRawShaCount,
    ),
    atLeast(
      "renderer-unique-raw-url-count",
      measurements.uniqueRawUrlCount,
      budget.minUniqueRawUrlCount,
    ),
    atLeast("fixture-reference-count", measurements.referenceCount, budget.minReferenceCount),
    atLeast(
      "fixture-unique-reference-sha-count",
      measurements.uniqueReferenceShaCount,
      budget.minUniqueReferenceShaCount,
    ),
    atLeast(
      "renderer-unique-reference-url-count",
      measurements.uniqueReferenceUrlCount,
      budget.minUniqueReferenceUrlCount,
    ),
    atMost(
      "dev-toolchain-to-cdp",
      measurements.devToolchainToCdpReadyMs,
      budget.maxDevToolchainToCdpReadyMs,
    ),
    atMost(
      "renderer-first-card",
      measurements.rendererFirstCardMs,
      budget.maxRendererFirstCardMs,
    ),
    atMost(
      "renderer-first-raw",
      measurements.rendererFirstRawMs,
      budget.maxRendererFirstRawMs,
    ),
    atMost(
      "renderer-all-pass-references",
      measurements.rendererAllPassReferencesMs,
      budget.maxRendererAllPassReferencesMs,
    ),
    atMost(
      "peak-outstanding-projection-ipc",
      measurements.peakOutstandingProjectionIpc,
      budget.maxOutstandingProjectionIpc,
    ),
  ];
  const ok = checks.every((check) => check.status === "PASS");
  return {
    ok,
    status: ok ? "PASS" : "FAIL",
    budget: { ...budget },
    measurements: { ...measurements },
    checks,
  };
}
