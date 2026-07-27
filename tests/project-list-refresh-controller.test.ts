import { describe, expect, it, vi } from "vitest";
import {
  createProjectListRefreshController,
} from "../src/renderer/src/project-list-refresh-controller.js";
import type { ListedProjectSummary } from "../src/core/service.js";

function project(root: string, sourceSnapshot: "current" | "stale" | "unknown"): ListedProjectSummary {
  return {
    id: root,
    name: root,
    primaryRoot: root,
    updatedAt: "2026-07-26T00:00:00.000Z",
    available: true,
    localCreativeImport: {
      projectKey: root,
      projectType: "story-production",
      resolution: "CREATE_MANAGED",
      sourceLayerCount: 1,
      authorityPolicy: "FORBID_ALL",
      indexedFiles: 1,
      indexedBytes: 1,
      approvedLocks: 0,
      candidateLocks: 0,
      warningCount: 0,
      contentImport: {
        status: sourceSnapshot === "unknown" ? "unverified" : sourceSnapshot === "stale" ? "stale" : "current-complete",
        processedMedia: 0,
        eligibleMedia: 0,
        importedDocuments: 0,
        sourceDocuments: 0,
        selectedDocuments: 0,
        excludedDocuments: 0,
        documentLimitHit: false,
        pendingAssets: 0,
        sourceSnapshot,
        sourceCheckedAt: sourceSnapshot === "unknown" ? null : "2026-07-26T00:00:00.000Z",
      },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

describe("项目清单串行刷新控制器", () => {
  it("核验期间普通刷新复用核验结果，不尾随 unknown 覆盖精确状态", async () => {
    const verify = deferred<ListedProjectSummary[]>();
    const fetchProjects = vi.fn(() => verify.promise);
    const applied: ListedProjectSummary[][] = [];
    const controller = createProjectListRefreshController({
      fetchProjects,
      applyProjects: (value) => applied.push(value),
      setRefreshing: () => undefined,
    });
    const exact = controller.verifySource("/project-a");
    const ordinary = controller.requestList();
    expect(fetchProjects).toHaveBeenCalledTimes(1);
    expect(fetchProjects).toHaveBeenCalledWith({
      refreshSources: true,
      sourceProjectRoot: "/project-a",
    });
    verify.resolve([project("/project-a", "current")]);
    await expect(exact).resolves.toEqual([project("/project-a", "current")]);
    await expect(ordinary).resolves.toEqual([project("/project-a", "current")]);
    expect(applied).toEqual([[project("/project-a", "current")]]);
  });

  it("不同项目核验按 root 去重串行，并各自获得自己的精确回执", async () => {
    const first = deferred<ListedProjectSummary[]>();
    const second = deferred<ListedProjectSummary[]>();
    const fetchProjects = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const controller = createProjectListRefreshController({
      fetchProjects,
      applyProjects: () => undefined,
      setRefreshing: () => undefined,
    });
    const a = controller.verifySource("/project-a");
    const aDuplicate = controller.verifySource("/project-a");
    const b = controller.verifySource("/project-b");
    expect(fetchProjects).toHaveBeenCalledTimes(1);
    first.resolve([project("/project-a", "current"), project("/project-b", "unknown")]);
    await expect(a).resolves.toEqual([project("/project-a", "current"), project("/project-b", "unknown")]);
    await expect(aDuplicate).resolves.toEqual([project("/project-a", "current"), project("/project-b", "unknown")]);
    expect(fetchProjects).toHaveBeenCalledTimes(2);
    second.resolve([project("/project-a", "unknown"), project("/project-b", "stale")]);
    await expect(b).resolves.toEqual([project("/project-a", "unknown"), project("/project-b", "stale")]);
    expect(fetchProjects.mock.calls[1]?.[0]).toEqual({
      refreshSources: true,
      sourceProjectRoot: "/project-b",
    });
  });

  it("核验完成后的普通刷新在 TTL 内保留精确来源快照，同时采用普通读取的实时 pending 计数", async () => {
    let clock = 1_000;
    const verified = project("/project-a", "current");
    verified.localCreativeImport!.indexedFiles = 309;
    verified.localCreativeImport!.indexedBytes = 12_345;
    verified.localCreativeImport!.contentImport.verifiedSourceFiles = 309;
    verified.localCreativeImport!.contentImport.verifiedSourceBytes = 12_345;
    verified.localCreativeImport!.contentImport.pendingAssets = 18;
    const ordinary = project("/project-a", "unknown");
    ordinary.localCreativeImport!.indexedFiles = 197;
    ordinary.localCreativeImport!.indexedBytes = 9_876;
    ordinary.localCreativeImport!.contentImport.pendingAssets = 17;
    ordinary.localCreativeImport!.contentImport.sourceVerificationError = "旧错误不应覆盖已核验结果";
    const expired = structuredClone(ordinary);

    const fetchProjects = vi.fn()
      .mockResolvedValueOnce([verified])
      .mockResolvedValueOnce([ordinary])
      .mockResolvedValueOnce([expired]);
    const applied: ListedProjectSummary[][] = [];
    const controller = createProjectListRefreshController({
      fetchProjects,
      applyProjects: (value) => applied.push(value),
      setRefreshing: () => undefined,
      verificationTtlMs: 5_000,
      now: () => clock,
    });

    await controller.verifySource("/project-a");
    const retained = (await controller.requestList())[0]!;
    expect(retained.localCreativeImport).toMatchObject({
      indexedFiles: 309,
      indexedBytes: 12_345,
      contentImport: {
        status: "current-complete",
        pendingAssets: 17,
        sourceSnapshot: "current",
        sourceCheckedAt: "2026-07-26T00:00:00.000Z",
        verifiedSourceFiles: 309,
        verifiedSourceBytes: 12_345,
      },
    });
    expect(retained.localCreativeImport!.contentImport.sourceVerificationError).toBeUndefined();

    clock += 5_001;
    const afterExpiry = (await controller.requestList())[0]!;
    expect(afterExpiry.localCreativeImport).toMatchObject({
      indexedFiles: 197,
      indexedBytes: 9_876,
      contentImport: {
        status: "unverified",
        pendingAssets: 17,
        sourceSnapshot: "unknown",
      },
    });
    expect(applied).toHaveLength(3);
  });

  it("一个核验失败不会吞掉已排队的另一个核验", async () => {
    const first = deferred<ListedProjectSummary[]>();
    const second = deferred<ListedProjectSummary[]>();
    const fetchProjects = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const controller = createProjectListRefreshController({
      fetchProjects,
      applyProjects: () => undefined,
      setRefreshing: () => undefined,
    });
    const a = controller.verifySource("/project-a");
    const b = controller.verifySource("/project-b");
    first.reject(new Error("source unavailable"));
    await expect(a).rejects.toThrow("source unavailable");
    second.resolve([project("/project-b", "current")]);
    await expect(b).resolves.toEqual([project("/project-b", "current")]);
  });

  it("dispose 立即拒绝当前核验、清理计时器且丢弃迟到结果", async () => {
    const verify = deferred<ListedProjectSummary[]>();
    const applyProjects = vi.fn();
    const clearTimer = vi.fn();
    const controller = createProjectListRefreshController({
      fetchProjects: () => verify.promise,
      applyProjects,
      setRefreshing: () => undefined,
      setTimer: () => "active-timer",
      clearTimer,
    });
    const running = controller.verifySource("/project-a");
    await Promise.resolve();
    controller.dispose();
    await expect(running).rejects.toThrow("项目列表控制器已关闭");
    expect(clearTimer).toHaveBeenCalledWith("active-timer");

    verify.resolve([project("/project-a", "current")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(applyProjects).not.toHaveBeenCalled();
  });

  it("超时后拒绝当前核验且迟到结果不得更新项目列表", async () => {
    const verify = deferred<ListedProjectSummary[]>();
    const applyProjects = vi.fn();
    const clearTimer = vi.fn();
    let timeoutCallback: (() => void) | undefined;
    const controller = createProjectListRefreshController({
      fetchProjects: () => verify.promise,
      applyProjects,
      setRefreshing: () => undefined,
      setTimer: (callback) => {
        timeoutCallback = callback;
        return "verify-timer";
      },
      clearTimer,
    });
    const running = controller.verifySource("/project-a");
    await Promise.resolve();
    timeoutCallback?.();
    await expect(running).rejects.toThrow("SHA 核验超时");
    expect(clearTimer).toHaveBeenCalledWith("verify-timer");

    verify.resolve([project("/project-a", "current")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(applyProjects).not.toHaveBeenCalled();
  });

  it("超时后保持底层 lane 排水，同项目和普通刷新不得重复发起深扫", async () => {
    const first = deferred<ListedProjectSummary[]>();
    const second = deferred<ListedProjectSummary[]>();
    const fetchProjects = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    let timeoutCallback: (() => void) | undefined;
    const controller = createProjectListRefreshController({
      fetchProjects,
      applyProjects: () => undefined,
      setRefreshing: () => undefined,
      setTimer: (callback) => {
        timeoutCallback = callback;
        return "verify-timer";
      },
      clearTimer: () => undefined,
    });

    const timedOut = controller.verifySource("/project-a");
    await Promise.resolve();
    timeoutCallback?.();
    await expect(timedOut).rejects.toThrow("底层核验仍在排水");
    await expect(controller.verifySource("/project-a")).rejects.toThrow("底层核验仍在排水");
    await expect(controller.requestList()).rejects.toThrow("底层核验仍在排水");
    const queued = controller.verifySource("/project-b");
    expect(fetchProjects).toHaveBeenCalledTimes(1);

    first.resolve([project("/project-a", "current")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchProjects).toHaveBeenCalledTimes(2);
    second.resolve([project("/project-b", "current")]);
    await expect(queued).resolves.toEqual([project("/project-b", "current")]);
  });

  it("具备跨 IPC 取消能力时，超时发出 requestId 取消并在底层确认前保持单通道", async () => {
    const first = deferred<ListedProjectSummary[]>();
    const second = deferred<ListedProjectSummary[]>();
    const fetchProjects = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const cancelFetch = vi.fn().mockResolvedValue(true);
    let timeoutCallback: (() => void) | undefined;
    const controller = createProjectListRefreshController({
      fetchProjects,
      cancelFetch,
      applyProjects: () => undefined,
      setRefreshing: () => undefined,
      setTimer: (callback) => {
        timeoutCallback = callback;
        return "verify-timer";
      },
      clearTimer: () => undefined,
    });

    const timedOut = controller.verifySource("/project-a");
    await Promise.resolve();
    const requestId = fetchProjects.mock.calls[0]?.[0]?.requestId;
    expect(requestId).toMatch(/^project-list-/u);
    timeoutCallback?.();
    await expect(timedOut).rejects.toThrow("已请求中止");
    expect(cancelFetch).toHaveBeenCalledWith(requestId);

    const queued = controller.verifySource("/project-b");
    expect(fetchProjects).toHaveBeenCalledTimes(1);
    const abortError = new Error("项目清单读取已由当前窗口取消。");
    abortError.name = "AbortError";
    first.reject(abortError);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchProjects).toHaveBeenCalledTimes(2);
    second.resolve([project("/project-b", "current")]);
    await expect(queued).resolves.toEqual([project("/project-b", "current")]);
  });
});
