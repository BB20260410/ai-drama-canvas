/**
 * 单次 projection 请求内的 Promise memoizer + 有界并发读取器。
 * Map 只属于调用方这一轮请求；拒绝也会复用，避免并发 panel 对同一 assetId
 * 重复打开 SQLite。输出顺序仍由各 panel 自己的 assetIds.map 决定。
 */
export function createStudioProjectionAssetReader<T>(
  loader: (assetId: string) => Promise<T>,
  concurrency = 4,
): (assetId: string) => Promise<T> {
  const limit = Math.max(1, Math.floor(concurrency));
  const reads = new Map<string, Promise<T>>();
  const queue: Array<{
    assetId: string;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
  }> = [];
  let active = 0;

  const drain = () => {
    while (active < limit && queue.length > 0) {
      const next = queue.shift()!;
      active += 1;
      void (async () => {
        try {
          next.resolve(await loader(next.assetId));
        } catch (error) {
          next.reject(error);
        } finally {
          active -= 1;
          drain();
        }
      })();
    }
  };

  return (assetId: string) => {
    const existing = reads.get(assetId);
    if (existing) return existing;
    const pending = new Promise<T>((resolve, reject) => {
      queue.push({ assetId, resolve, reject });
    });
    // 必须在 drain 前登记 Promise，保证同一 tick 的并发 panel 立即复用。
    reads.set(assetId, pending);
    drain();
    return pending;
  };
}
