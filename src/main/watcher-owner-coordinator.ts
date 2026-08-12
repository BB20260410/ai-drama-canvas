export interface AsyncExclusiveQueue {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface RetriableWatcherCloseState {
  closePromise: Promise<void> | null;
}

export interface LabeledWatcherHandle {
  label: string;
  close(): Promise<void>;
}

export function createAsyncExclusiveQueue(): AsyncExclusiveQueue {
  let chain: Promise<void> = Promise.resolve();
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const next = chain.then(operation);
      chain = next.then(() => undefined, () => undefined);
      return next;
    },
  };
}

/** 同一 owner 的并发 close 只执行一次；失败会清 promise，保留 owner 供下次重试。 */
export async function closeRetriableWatcherHandles(
  state: RetriableWatcherCloseState,
  handles: LabeledWatcherHandle[],
): Promise<void> {
  if (state.closePromise) return state.closePromise;
  const closeAttempt = (async () => {
    const results = await Promise.allSettled(handles.map((handle) => handle.close()));
    const rejected = results
      .map((result, index) => ({ result, label: handles[index]?.label ?? `watcher-${index + 1}` }))
      .filter((entry): entry is { result: PromiseRejectedResult; label: string } => entry.result.status === "rejected");
    if (rejected.length) {
      throw new AggregateError(
        rejected.map((entry) => entry.result.reason),
        `watcher owner 关闭失败：${rejected.map((entry) => entry.label).join(",")}`,
      );
    }
  })();
  state.closePromise = closeAttempt.catch((error) => {
    state.closePromise = null;
    throw error;
  });
  return state.closePromise;
}

/** 退出收口允许一次即时物理重试；两次都失败时交由上层取消退出。 */
export async function retryWatcherCloseOnce(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (firstError) {
    try {
      await operation();
    } catch (secondError) {
      throw new AggregateError([firstError, secondError], "watcher 退出关闭重试仍失败");
    }
  }
}
