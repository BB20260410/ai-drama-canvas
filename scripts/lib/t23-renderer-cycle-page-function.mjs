/**
 * Playwright 页面侧 T23 原子证据读取器。
 *
 * 必须保持为无闭包的原生 JavaScript 函数：Playwright 会把函数源码送进
 * Renderer utility world；不能依赖 tsx/esbuild 注入的 __name，也不能通过
 * string pageFunction 触发应用 CSP 的 unsafe-eval 门禁。
 */
export function t23RendererCyclePageFunction(input) {
  const probe = window.canvasApi?.getT23IpcPerformanceProbeSnapshot?.();
  const timeline = probe?.rendererStartupTimeline;
  if (!probe || !timeline || timeline.schemaVersion !== 1) return false;
  const firstCard = timeline.milestones
    .filter((entry) => entry.milestone === "canvas-first-card-dom-ready");
  if (firstCard.length !== 1) return false;
  const starts = timeline.milestones
    .map((entry) => ({ entry, match: /^canvas-raw-span-start:(\d+)$/u.exec(entry.milestone) }))
    .filter((item) => Boolean(item.match));
  const invalidated = new Set(timeline.milestones
    .map((entry) => /^canvas-raw-span-invalidated:(\d+)$/u.exec(entry.milestone)?.[1])
    .filter((spanId) => Boolean(spanId)));
  const latest = starts
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
    .at(-1);
  if (!latest || invalidated.has(latest.match[1])) return false;
  const spanId = latest.match[1];
  const at = (milestone) => {
    const entries = timeline.milestones.filter((entry) => entry.milestone === milestone);
    return entries.length === 1 ? entries[0].atMs : false;
  };
  const firstRawUnit = timeline.milestones
    .filter((entry) => entry.milestone.startsWith("canvas-first-raw-unit:" + spanId + ":"));
  const firstRawReadyAt = at("canvas-first-raw-ready:" + spanId);
  const passReferenceUnitIds = timeline.milestones
    .map((entry) => new RegExp("^canvas-all-pass-reference-unit:" + spanId + ":(.+)$", "u").exec(entry.milestone)?.[1])
    .filter((unitId) => Boolean(unitId));
  const expected = [...input.expectedPassUnitIds].sort((left, right) => left.localeCompare(right));
  const allPassReadyAt = at("canvas-all-pass-references-ready:" + spanId);
  const completeAt = at("canvas-raw-span-complete:" + spanId);
  const complete = firstRawUnit.length === 1
    && firstRawReadyAt !== false
    && allPassReadyAt !== false
    && completeAt !== false
    && firstRawReadyAt <= allPassReadyAt
    && allPassReadyAt <= completeAt
    && passReferenceUnitIds.length === expected.length
    && passReferenceUnitIds.every((unitId, index) => unitId === expected[index]);
  if (!complete) return false;

  const hook = window.__aiCanvasManagedStudioVerify;
  if (!hook?.getUnitGridRawSnapshot) {
    return {
      ok: false,
      error: "product-hook-missing",
      timeOrigin: performance.timeOrigin,
    };
  }
  const rawSnapshot = hook.getUnitGridRawSnapshot();
  const drainDurationMs = Math.max(0, performance.now() - allPassReadyAt);
  if (probe.currentOutstanding !== 0 || rawSnapshot.loading) {
    return drainDurationMs > input.drainBudgetMs
      ? {
          ok: false,
          error: "ipc-drain-timeout",
          timeOrigin: performance.timeOrigin,
          drainDurationMs,
          rawSnapshot,
          ipcProbe: probe,
        }
      : false;
  }
  return {
    ok: true,
    timeOrigin: performance.timeOrigin,
    rendererFirstCardMs: Math.round(firstCard[0].atMs),
    rendererFirstRawMs: Math.round(firstRawReadyAt),
    rendererAllPassReferencesMs: Math.round(allPassReadyAt),
    drainDurationMs: Math.round(drainDurationMs),
    rawSnapshot,
    ipcProbe: probe,
  };
}
