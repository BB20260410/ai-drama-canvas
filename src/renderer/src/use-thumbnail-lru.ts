/**
 * Qwen D3 · 缩略图 URL LRU（内存缓存）
 *
 * key 通常 mediaSha256 或 recipeKey；只缓存 URL 字符串，不持媒体二进制。
 */

export interface ThumbnailLru {
  get(key: string): string | undefined;
  set(key: string, url: string): void;
  has(key: string): boolean;
  size(): number;
  clear(): void;
  peekOrder(): string[];
}

export function createThumbnailLru(maxEntries = 64): ThumbnailLru {
  const max = Math.max(1, Math.floor(maxEntries));
  const map = new Map<string, string>();

  return {
    get(key: string) {
      if (!map.has(key)) return undefined;
      const value = map.get(key)!;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key: string, url: string) {
      if (map.has(key)) map.delete(key);
      map.set(key, url);
      while (map.size > max) {
        const oldest = map.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    has(key: string) {
      return map.has(key);
    },
    size() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    peekOrder() {
      return [...map.keys()];
    },
  };
}
