/**
 * 按固定并发上限执行异步任务，并保持结果与输入任务同序。
 *
 * 这是渲染层的轻量调度器；它不负责取消。调用方应在任务开始和结果提交前
 * 继续检查自己的 project/generation token，避免旧工程结果写回新工程。
 */
export async function runBoundedAsyncTasks<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency 必须是大于等于 1 的整数。");
  }
  if (tasks.length === 0) return [];

  const results = new Array<T>(tasks.length);
  let nextTaskIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextTaskIndex < tasks.length) {
      const taskIndex = nextTaskIndex;
      nextTaskIndex += 1;
      results[taskIndex] = await tasks[taskIndex]!();
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
  );
  return results;
}
