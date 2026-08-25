/**
 * Wave 5-C：缩略派生（sharp 解码源图再 resize）全进程有界并发。
 * 与画布 15 秒向导 / projection asset reader 的并发 4 同级。
 * 不改 THUMBNAIL_RECIPE / recipeKey。
 */

export const STUDIO_THUMBNAIL_DERIVATION_CONCURRENCY = 4 as const;

export function createBoundedConcurrency(limit: number): {
  run: <T>(task: () => Promise<T>) => Promise<T>;
  readonly active: number;
} {
  const cap = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiters: Array<() => void> = [];

  return {
    get active() {
      return active;
    },
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= cap) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
      active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
        waiters.shift()?.();
      }
    },
  };
}

export const studioThumbnailDerivationGate = createBoundedConcurrency(STUDIO_THUMBNAIL_DERIVATION_CONCURRENCY);
