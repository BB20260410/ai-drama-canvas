/**
 * 有界键缓存：Map 插入序 LRU。只持引用，不持媒体二进制。
 * 给冻结参考缩略图 Promise 等「同工程不能无限涨」的热路径用。
 */

export interface BoundedKeyedCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): boolean;
  has(key: string): boolean;
  size(): number;
  clear(): void;
  peekOrder(): string[];
}

export function createBoundedKeyedCache<T>(maxEntries = 96): BoundedKeyedCache<T> {
  const max = Math.max(1, Math.floor(maxEntries));
  const map = new Map<string, T>();

  return {
    get(key: string) {
      if (!map.has(key)) return undefined;
      const value = map.get(key)!;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key: string, value: T) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > max) {
        const oldest = map.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    delete(key: string) {
      return map.delete(key);
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
