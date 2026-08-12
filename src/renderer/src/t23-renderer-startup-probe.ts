/**
 * T23 隐藏性能验收专用 renderer 冷启动里程碑。
 * 生产环境的 preload 固定暴露 enabled=false，因此这里只做一次布尔读取，不累计数据。
 */
export function markT23RendererStartup(milestone: string): void {
  const api = window.canvasApi;
  if (api.t23PerformanceProbeEnabled !== true) return;
  api.recordT23RendererMilestone(milestone);
}
