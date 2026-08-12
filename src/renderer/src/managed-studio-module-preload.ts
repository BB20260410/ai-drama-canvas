export interface ManagedStudioModulePreloader<T> {
  load(): Promise<T>;
  warm(): void;
}

/**
 * 受管 Studio 动态模块只创建一个加载 Promise。
 *
 * warm 只提前启动，不吞改正式 loader 的结果；失败同样缓存，避免后台无限重试或
 * warm 与 Vue defineAsyncComponent 各自触发一次 import。
 */
export function createManagedStudioModulePreloader<T>(
  loader: () => Promise<T>,
): ManagedStudioModulePreloader<T> {
  let loadPromise: Promise<T> | undefined;

  const load = (): Promise<T> => {
    loadPromise ??= loader();
    return loadPromise;
  };

  return {
    load,
    warm() {
      void load().catch(() => undefined);
    },
  };
}
