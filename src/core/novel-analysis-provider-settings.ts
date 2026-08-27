/**
 * 只读：analysis-providers.json。
 * get_capabilities 握手只需要这份配置，不得为此加载 novel-analysis-provider.js 整图。
 */
import { getSidecarPaths, readJson } from "./sidecar.js";
import type { NovelAnalysisProviderSettings } from "./types.js";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function emptyNovelAnalysisProviderSettings(): NovelAnalysisProviderSettings {
  return { schemaVersion: 1, revision: 0, providers: [], updatedAt: new Date(0).toISOString() };
}

export function validateNovelAnalysisProviderSettings(value: unknown): NovelAnalysisProviderSettings {
  if (!record(value) || value.schemaVersion !== 1 || !Number.isInteger(value.revision) || !Array.isArray(value.providers) || typeof value.updatedAt !== "string") {
    throw new Error("analysis-providers.json 结构损坏，已停止读取和写入。 ");
  }
  const ids = new Set<string>();
  for (const entry of value.providers) {
    if (!record(entry) || entry.schemaVersion !== 1 || typeof entry.id !== "string" || ids.has(entry.id) || typeof entry.name !== "string" || !["openai-compatible", "mock"].includes(String(entry.adapter)) || typeof entry.enabled !== "boolean" || typeof entry.model !== "string" || !Number.isInteger(entry.revision)) {
      throw new Error("analysis-providers.json 包含无效或重复的 Provider。 ");
    }
    ids.add(entry.id);
  }
  if (value.defaultProviderId !== undefined && (typeof value.defaultProviderId !== "string" || !ids.has(value.defaultProviderId))) {
    throw new Error("analysis-providers.json 的默认 Provider 不存在。 ");
  }
  return value as unknown as NovelAnalysisProviderSettings;
}

export async function getNovelAnalysisProviderSettings(projectRoot: string): Promise<NovelAnalysisProviderSettings> {
  const value = await readJson<unknown | null>(getSidecarPaths(projectRoot).storyAnalysisProviders, null);
  return value === null ? emptyNovelAnalysisProviderSettings() : validateNovelAnalysisProviderSettings(value);
}
