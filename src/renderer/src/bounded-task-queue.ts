export type BoundedTaskResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "cancelled" };

type PendingTask<T> = {
  generation: number;
  task: () => Promise<T>;
  resolve: (result: BoundedTaskResult<T>) => void;
};

/**
 * Renderer-local bounded scheduler.  It never retries work and invalidation
 * prevents queued or stale completions from mutating the new project/view.
 */
export class LatestBoundedTaskQueue {
  private readonly pending: PendingTask<unknown>[] = [];
  private active = 0;
  private generation = 0;
  private disposed = false;
  private readonly idleWaiters = new Set<() => void>();

  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      throw new Error("bounded task queue concurrency 必须是 1–16。 ");
    }
  }

  schedule<T>(task: () => Promise<T>): Promise<BoundedTaskResult<T>> {
    if (this.disposed) return Promise.resolve({ status: "cancelled" });
    const generation = this.generation;
    return new Promise<BoundedTaskResult<T>>((resolve) => {
      this.pending.push({ generation, task, resolve } as PendingTask<unknown>);
      this.pump();
    });
  }

  invalidate(): void {
    this.generation += 1;
    for (const item of this.pending.splice(0)) item.resolve({ status: "cancelled" });
    this.resolveIdleWaiters();
  }

  /** Resolves once the at-most-concurrency in-flight tasks have naturally settled. */
  whenIdle(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  private pump(): void {
    while (!this.disposed && this.active < this.concurrency && this.pending.length) {
      const item = this.pending.shift()!;
      if (item.generation !== this.generation) {
        item.resolve({ status: "cancelled" });
        continue;
      }
      this.active += 1;
      void item.task().then(
        (value) => item.resolve(item.generation === this.generation && !this.disposed
          ? { status: "fulfilled", value }
          : { status: "cancelled" }),
        (reason) => item.resolve(item.generation === this.generation && !this.disposed
          ? { status: "rejected", reason }
          : { status: "cancelled" }),
      ).finally(() => {
        this.active -= 1;
        this.pump();
        this.resolveIdleWaiters();
      });
    }
  }

  private resolveIdleWaiters(): void {
    if (this.active !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
