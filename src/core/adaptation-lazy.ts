/**
 * Wave 4-B：改编工作区冷域。启动路径不得静态拉 adaptation.js。
 * 写路径仍走 command-bus 原命令；此处只延迟加载同一模块。
 */
export type AdaptationModule = typeof import("./adaptation.js");

let adaptationModule: Promise<AdaptationModule> | undefined;

export function loadAdaptation(): Promise<AdaptationModule> {
  adaptationModule ??= import("./adaptation.js");
  return adaptationModule;
}

export async function withAdaptation<T>(read: (adaptation: AdaptationModule) => T | Promise<T>): Promise<T> {
  return read(await loadAdaptation());
}
