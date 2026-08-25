/**
 * Wave 4：小说分析任务/审查冷域。启动路径不得静态拉 novel-analysis.js。
 * 写路径仍走 command-bus 原命令；此处只延迟加载同一模块。
 */
export type NovelAnalysisModule = typeof import("./novel-analysis.js");

let novelAnalysisModule: Promise<NovelAnalysisModule> | undefined;

export function loadNovelAnalysis(): Promise<NovelAnalysisModule> {
  novelAnalysisModule ??= import("./novel-analysis.js");
  return novelAnalysisModule;
}

export async function withNovelAnalysis<T>(read: (novelAnalysis: NovelAnalysisModule) => T | Promise<T>): Promise<T> {
  return read(await loadNovelAnalysis());
}
