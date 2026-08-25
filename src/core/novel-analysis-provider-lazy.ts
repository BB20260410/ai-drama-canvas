/**
 * Wave 4：小说分析 Provider / 执行冷域。启动路径不得静态拉 novel-analysis-provider.js。
 * 写路径仍走 command-bus 原命令；此处只延迟加载同一模块。
 */
export type NovelAnalysisProviderModule = typeof import("./novel-analysis-provider.js");

let novelAnalysisProviderModule: Promise<NovelAnalysisProviderModule> | undefined;

export function loadNovelAnalysisProvider(): Promise<NovelAnalysisProviderModule> {
  novelAnalysisProviderModule ??= import("./novel-analysis-provider.js");
  return novelAnalysisProviderModule;
}

export async function withNovelAnalysisProvider<T>(
  read: (provider: NovelAnalysisProviderModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadNovelAnalysisProvider());
}
