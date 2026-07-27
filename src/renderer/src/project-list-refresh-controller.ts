import type { ListedProjectSummary, ListProjectsRequestOptions } from "../../core/service.js";

interface ProjectListRefreshTask {
  key: string;
  sourceProjectRoot?: string;
  requestId?: string;
  promise: Promise<ListedProjectSummary[]>;
  resolve: (value: ListedProjectSummary[]) => void;
  reject: (reason: unknown) => void;
  cancelRunning?: (reason: unknown) => void;
}

export interface ProjectListRefreshController {
  requestList(): Promise<ListedProjectSummary[]>;
  verifySource(sourceProjectRoot: string): Promise<ListedProjectSummary[]>;
  dispose(): void;
}

export function createProjectListRefreshController(input: {
  fetchProjects: (options?: ListProjectsRequestOptions) => Promise<ListedProjectSummary[]>;
  cancelFetch?: (requestId: string) => Promise<boolean> | boolean;
  applyProjects: (projects: ListedProjectSummary[]) => void;
  setRefreshing: (refreshing: boolean) => void;
  listTimeoutMs?: number;
  verifyTimeoutMs?: number;
  verificationTtlMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): ProjectListRefreshController {
  const listTimeoutMs = input.listTimeoutMs ?? 10_000;
  const verifyTimeoutMs = input.verifyTimeoutMs ?? 60_000;
  const verificationTtlMs = input.verificationTtlMs ?? 5 * 60_000;
  const now = input.now ?? Date.now;
  const setTimer = input.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearTimer = input.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const queue: ProjectListRefreshTask[] = [];
  const tasksByKey = new Map<string, ProjectListRefreshTask>();
  const verifiedSummaries = new Map<string, {
    expiresAt: number;
    summary: NonNullable<ListedProjectSummary["localCreativeImport"]>;
  }>();
  let current: ProjectListRefreshTask | undefined;
  let disposed = false;
  let requestSequence = 0;

  const retainRecentVerification = (
    projects: ListedProjectSummary[],
    verifiedRoot?: string,
  ): ListedProjectSummary[] => {
    const checkedAt = now();
    for (const [root, cached] of verifiedSummaries) {
      if (cached.expiresAt <= checkedAt) verifiedSummaries.delete(root);
    }
    if (verifiedRoot) {
      const verifiedProject = projects.find((project) => project.primaryRoot === verifiedRoot);
      const summary = verifiedProject?.localCreativeImport;
      const source = summary?.contentImport;
      if (summary && source?.sourceCheckedAt
        && (source.sourceSnapshot === "current" || source.sourceSnapshot === "stale")) {
        verifiedSummaries.set(verifiedRoot, {
          expiresAt: checkedAt + verificationTtlMs,
          summary: structuredClone(summary),
        });
      }
      return projects;
    }
    return projects.map((project) => {
      const cached = verifiedSummaries.get(project.primaryRoot);
      const current = project.localCreativeImport;
      if (!cached || !current) return project;
      const contentImport: NonNullable<ListedProjectSummary["localCreativeImport"]>["contentImport"] = {
        ...current.contentImport,
        status: cached.summary.contentImport.status,
        sourceDocuments: cached.summary.contentImport.sourceDocuments,
        sourceSnapshot: cached.summary.contentImport.sourceSnapshot,
        sourceCheckedAt: cached.summary.contentImport.sourceCheckedAt,
        ...(cached.summary.contentImport.verifiedSourceFiles !== undefined
          ? { verifiedSourceFiles: cached.summary.contentImport.verifiedSourceFiles }
          : {}),
        ...(cached.summary.contentImport.verifiedSourceBytes !== undefined
          ? { verifiedSourceBytes: cached.summary.contentImport.verifiedSourceBytes }
          : {}),
        ...(cached.summary.contentImport.sourceVerificationError
          ? { sourceVerificationError: cached.summary.contentImport.sourceVerificationError }
          : {}),
      };
      if (!cached.summary.contentImport.sourceVerificationError) {
        delete contentImport.sourceVerificationError;
      }
      return {
        ...project,
        localCreativeImport: {
          ...current,
          indexedFiles: cached.summary.indexedFiles,
          indexedBytes: cached.summary.indexedBytes,
          contentImport,
        },
      };
    });
  };

  const createTask = (key: string, sourceProjectRoot?: string): ProjectListRefreshTask => {
    let resolve!: (value: ListedProjectSummary[]) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<ListedProjectSummary[]>((resolveValue, rejectValue) => {
      resolve = resolveValue;
      reject = rejectValue;
    });
    return { key, sourceProjectRoot, promise, resolve, reject };
  };

  const drain = async (): Promise<void> => {
    if (current || disposed) return;
    const task = queue.shift();
    if (!task) {
      input.setRefreshing(false);
      return;
    }
    current = task;
    input.setRefreshing(true);
    const timeoutMs = task.sourceProjectRoot ? verifyTimeoutMs : listTimeoutMs;
    let timer: unknown;
    let publicSettled = false;
    let timedOut = false;
    let cancelled = false;
    const rejectPublicOnce = (error: unknown): void => {
      if (publicSettled) return;
      publicSettled = true;
      task.reject(error);
    };
    const clearActiveTimer = (): void => {
      if (timer === undefined) return;
      clearTimer(timer);
      timer = undefined;
    };
    task.cancelRunning = (reason) => {
      cancelled = true;
      clearActiveTimer();
      rejectPublicOnce(reason);
      if (task.requestId) void input.cancelFetch?.(task.requestId);
    };
    timer = setTimer(() => {
      timedOut = true;
      clearActiveTimer();
      if (task.requestId) void input.cancelFetch?.(task.requestId);
      rejectPublicOnce(new Error(task.sourceProjectRoot
        ? input.cancelFetch
          ? "项目来源内容 SHA 核验超时；已请求中止，取消确认前保持单通道排水并保留“来源待核验”状态。"
          : "项目来源内容 SHA 核验超时；底层核验仍在排水，已保留“来源待核验”状态。"
        : input.cancelFetch
          ? "项目清单读取超时；已请求中止，取消确认前保留上一次完整结果。"
          : "项目清单读取超时；底层读取仍在排水，已保留上一次完整结果。"));
    }, timeoutMs);
    try {
      // 超时只结束调用方等待，不释放 lane。底层 fetch 真正落定前，
      // 同 key 请求继续复用同一失败回执，其他请求继续排队，避免重复深扫。
      const result = await input.fetchProjects(task.sourceProjectRoot
        ? {
            refreshSources: true,
            sourceProjectRoot: task.sourceProjectRoot,
            ...(task.requestId ? { requestId: task.requestId } : {}),
          }
        : task.requestId ? { requestId: task.requestId } : undefined);
      if (disposed || cancelled || timedOut) return;
      const projected = retainRecentVerification(result, task.sourceProjectRoot);
      input.applyProjects(projected);
      publicSettled = true;
      task.resolve(projected);
    } catch (error) {
      rejectPublicOnce(error);
    } finally {
      clearActiveTimer();
      task.cancelRunning = undefined;
      tasksByKey.delete(task.key);
      current = undefined;
      if (queue.length) void drain();
      else input.setRefreshing(false);
    }
  };

  const enqueue = (key: string, sourceProjectRoot?: string): Promise<ListedProjectSummary[]> => {
    if (disposed) return Promise.reject(new Error("项目列表控制器已关闭。"));
    const existing = tasksByKey.get(key);
    if (existing) return existing.promise;
    const task = createTask(key, sourceProjectRoot);
    if (input.cancelFetch) {
      requestSequence += 1;
      task.requestId = `project-list-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
    }
    tasksByKey.set(key, task);
    queue.push(task);
    void drain();
    return task.promise;
  };

  return {
    requestList() {
      // 核验本身也返回完整项目清单；核验在途时普通定时刷新直接复用该结果，
      // 不再尾随一次 unknown 快照覆盖刚完成的精确核验。
      if (current?.sourceProjectRoot) return current.promise;
      const pendingVerification = queue.find((task) => Boolean(task.sourceProjectRoot));
      if (pendingVerification) return pendingVerification.promise;
      return enqueue("list");
    },
    verifySource(sourceProjectRoot) {
      const normalized = sourceProjectRoot.trim();
      if (!normalized) return Promise.reject(new Error("sourceProjectRoot 不能为空。"));
      return enqueue(`verify:${normalized}`, normalized);
    },
    dispose() {
      disposed = true;
      const error = new Error("项目列表控制器已关闭。");
      if (current) {
        tasksByKey.delete(current.key);
        current.reject(error);
        current.cancelRunning?.(error);
      }
      for (const task of queue.splice(0)) {
        tasksByKey.delete(task.key);
        task.reject(error);
      }
      verifiedSummaries.clear();
      input.setRefreshing(false);
    },
  };
}
