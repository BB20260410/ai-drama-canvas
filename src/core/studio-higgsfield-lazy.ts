/**
 * Wave 4-C：Higgsfield 冷域。启动路径不得静态拉 video-generation / connector-queue。
 * mcp-projection 是无重依赖的同步消毒器，可留在 MCP 顶栏。
 * 写路径仍走 studio-command-executor 原命令；此处只延迟加载同一模块。
 */
export type HiggsfieldVideoModule = typeof import("./studio-higgsfield-video-generation.js");
export type HiggsfieldQueueModule = typeof import("./studio-higgsfield-connector-queue.js");

let higgsfieldVideoModule: Promise<HiggsfieldVideoModule> | undefined;
let higgsfieldQueueModule: Promise<HiggsfieldQueueModule> | undefined;

export function loadHiggsfieldVideo(): Promise<HiggsfieldVideoModule> {
  higgsfieldVideoModule ??= import("./studio-higgsfield-video-generation.js");
  return higgsfieldVideoModule;
}

export function loadHiggsfieldQueue(): Promise<HiggsfieldQueueModule> {
  higgsfieldQueueModule ??= import("./studio-higgsfield-connector-queue.js");
  return higgsfieldQueueModule;
}

export async function withHiggsfieldVideo<T>(
  read: (higgsfield: HiggsfieldVideoModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadHiggsfieldVideo());
}

export async function withHiggsfieldQueue<T>(
  read: (queue: HiggsfieldQueueModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadHiggsfieldQueue());
}
