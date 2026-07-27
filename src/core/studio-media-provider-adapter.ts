/**
 * P1.7 媒体 Provider Adapter 注册表（图/视频/TTS 统一接口 + mock）。
 * 正式生图供应仍仅 codex|grok；本表允许扩展「可选」视频/TTS mock，不接浏览器。
 */

export type MediaAdapterKind = "image" | "video" | "tts";

export type MediaGenerateRequest = {
  kind: MediaAdapterKind;
  prompt: string;
  referencePaths?: string[];
  durationSeconds?: number;
};

export type MediaGenerateResponse =
  | { status: "ready"; artifactPath: string; provider: string }
  | { status: "async"; taskId: string; provider: string }
  | { status: "failed"; error: string; provider: string };

export interface StudioMediaProviderAdapter {
  id: string;
  kind: MediaAdapterKind;
  /** 是否允许进入正式 imagegen 账本（仅 codex/grok image） */
  formalImagegen: boolean;
  buildGenerate(req: MediaGenerateRequest): { url: string; body: Record<string, unknown> };
  parseGenerate(raw: unknown): MediaGenerateResponse;
}

const registry = new Map<string, StudioMediaProviderAdapter>();

export function registerStudioMediaAdapter(adapter: StudioMediaProviderAdapter): void {
  if (!adapter.id?.trim()) throw new Error("adapter: id 不能为空。");
  if (registry.has(adapter.id)) throw new Error(`adapter: 重复注册 ${adapter.id}`);
  registry.set(adapter.id, adapter);
}

export function getStudioMediaAdapter(id: string): StudioMediaProviderAdapter | undefined {
  return registry.get(id);
}

export function listStudioMediaAdapters(kind?: MediaAdapterKind): StudioMediaProviderAdapter[] {
  return [...registry.values()].filter((a) => (kind ? a.kind === kind : true));
}

export function clearStudioMediaAdapterRegistryForTests(): void {
  registry.clear();
}

/** 内置 mock：同步返回逻辑路径，不访问网络 */
export function createMockMediaAdapter(kind: MediaAdapterKind, id = `mock-${kind}`): StudioMediaProviderAdapter {
  return {
    id,
    kind,
    formalImagegen: false,
    buildGenerate(req) {
      if (req.kind !== kind) throw new Error(`adapter ${id}: kind 不匹配`);
      if (!req.prompt?.trim()) throw new Error(`adapter ${id}: prompt 为空`);
      return { url: `mock://${id}/generate`, body: { prompt: req.prompt, kind } };
    },
    parseGenerate(raw) {
      const o = raw as { ok?: boolean; path?: string; error?: string };
      if (o?.ok && o.path) return { status: "ready", artifactPath: o.path, provider: id };
      return { status: "failed", error: o?.error || "mock failed", provider: id };
    },
  };
}

export function ensureDefaultMockAdaptersRegistered(): void {
  if (!registry.has("mock-image")) registerStudioMediaAdapter(createMockMediaAdapter("image"));
  if (!registry.has("mock-video")) registerStudioMediaAdapter(createMockMediaAdapter("video"));
  if (!registry.has("mock-tts")) registerStudioMediaAdapter(createMockMediaAdapter("tts"));
}
