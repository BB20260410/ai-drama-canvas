/**
 * Wave 4-B：Novel Agent 冷域。启动 / handshake 不得静态拉 novel-agent-service.js。
 * capabilities 常量见 novel-agent-capabilities.ts；此处只延迟加载服务实现。
 */
export type NovelAgentModule = typeof import("./novel-agent-service.js");

let novelAgentModule: Promise<NovelAgentModule> | undefined;

export function loadNovelAgent(): Promise<NovelAgentModule> {
  novelAgentModule ??= import("./novel-agent-service.js");
  return novelAgentModule;
}

export async function withNovelAgent<T>(read: (novelAgent: NovelAgentModule) => T | Promise<T>): Promise<T> {
  return read(await loadNovelAgent());
}
