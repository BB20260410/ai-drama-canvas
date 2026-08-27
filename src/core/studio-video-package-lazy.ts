/**
 * Wave 4-C：视频包冷域。启动路径不得静态拉 studio-video-package.js。
 * 写路径仍走 command-bus 原命令与 executor 调度；此处只延迟加载同一模块。
 */
export type StudioVideoPackageModule = typeof import("./studio-video-package.js");

let studioVideoPackageModule: Promise<StudioVideoPackageModule> | undefined;

export function loadStudioVideoPackage(): Promise<StudioVideoPackageModule> {
  studioVideoPackageModule ??= import("./studio-video-package.js");
  return studioVideoPackageModule;
}

export async function withStudioVideoPackage<T>(
  read: (videoPackage: StudioVideoPackageModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadStudioVideoPackage());
}
