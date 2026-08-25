/**
 * Wave 4-B：原文 / 章节冷域。启动路径不得静态拉 story.js（从而也不预加载 mammoth）。
 * 写路径仍走 command-bus 原命令；此处只延迟加载同一模块。
 */
export type StoryModule = typeof import("./story.js");

let storyModule: Promise<StoryModule> | undefined;

export function loadStory(): Promise<StoryModule> {
  storyModule ??= import("./story.js");
  return storyModule;
}

export async function withStory<T>(read: (story: StoryModule) => T | Promise<T>): Promise<T> {
  return read(await loadStory());
}
