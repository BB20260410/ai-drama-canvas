/**
 * T23 隐藏性能验收专用 renderer 冷启动里程碑。
 * 生产环境的 preload 固定暴露 enabled=false，因此这里只做一次布尔读取，不累计数据。
 */
export function markT23RendererStartup(milestone: string): void {
  const api = window.canvasApi;
  if (api.t23PerformanceProbeEnabled !== true) return;
  api.recordT23RendererMilestone(milestone);
}

/** T23 专用结构化启动门禁摘要；生产环境 probe disabled 时为零成本返回。 */
export function recordT23StartupRuntimeGate(
  phase: "baseline" | "first-card" | "final",
  mutationChecks: number | undefined,
): void {
  if (window.canvasApi.t23PerformanceProbeEnabled !== true
    || typeof mutationChecks !== "number"
    || !Number.isSafeInteger(mutationChecks)
    || mutationChecks < 0) return;
  window.canvasApi.recordT23StartupRuntimeGate(phase, mutationChecks);
}
