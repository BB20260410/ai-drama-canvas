import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAppQuitOperationAdmission,
  createAppCloseTracker,
  runGuardedAppStartupPrerequisites,
  runBoundedAppQuitCleanup,
  scheduleRendererCloseRequestDelivery,
  settleLabeledCloseTasks,
} from "../src/main/app-close-coordinator.js";
import { createRendererWindowCloseRequestBridge } from "../src/preload/window-close-bridge.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("App 有界关闭协调器", () => {
  it("在 close 同步栈返回后才投递 renderer 请求，并在投递前复核 request 身份", () => {
    const scheduled: Array<() => void> = [];
    const sent: Array<{ requestId: string }> = [];
    let pending = true;
    scheduleRendererCloseRequestDelivery({
      requestId: "close-next-tick",
      webContentsId: 17,
      schedule: (callback) => { scheduled.push(callback); },
      isPending: (requestId, webContentsId) => (
        pending && requestId === "close-next-tick" && webContentsId === 17
      ),
      isReady: () => true,
      isDestroyed: () => false,
      send: (request) => { sent.push(request); },
    });

    expect(sent).toEqual([]);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    expect(sent).toEqual([{ requestId: "close-next-tick" }]);

    scheduleRendererCloseRequestDelivery({
      requestId: "stale-request",
      webContentsId: 17,
      schedule: (callback) => { scheduled.push(callback); },
      isPending: () => pending,
      isReady: () => true,
      isDestroyed: () => false,
      send: (request) => { sent.push(request); },
    });
    pending = false;
    scheduled.shift()?.();
    expect(sent).toEqual([{ requestId: "close-next-tick" }]);

    pending = true;
    scheduleRendererCloseRequestDelivery({
      requestId: "destroyed-window",
      webContentsId: 17,
      schedule: (callback) => { scheduled.push(callback); },
      isPending: () => true,
      isReady: () => true,
      isDestroyed: () => true,
      send: (request) => { sent.push(request); },
    });
    scheduled.shift()?.();
    expect(sent).toEqual([{ requestId: "close-next-tick" }]);
  });

  it("close bridge 未 ready 时不投递，ready 后补投且 preload 在订阅前缓冲一次", () => {
    const scheduled: Array<() => void> = [];
    const sent: Array<{ requestId: string }> = [];
    let ready = false;
    const schedule = () => scheduleRendererCloseRequestDelivery({
      requestId: "close-before-ready",
      webContentsId: 23,
      schedule: (callback) => { scheduled.push(callback); },
      isPending: (requestId, webContentsId) => requestId === "close-before-ready" && webContentsId === 23,
      isReady: () => ready,
      isDestroyed: () => false,
      send: (request) => { sent.push(request); },
    });

    schedule();
    scheduled.shift()?.();
    expect(sent).toEqual([]);
    ready = true;
    schedule();
    scheduled.shift()?.();
    expect(sent).toEqual([{ requestId: "close-before-ready" }]);

    const bridge = createRendererWindowCloseRequestBridge();
    bridge.receive(sent[0]!);
    const received: string[] = [];
    const remove = bridge.subscribe((request) => { received.push(request.requestId); });
    expect(received).toEqual(["close-before-ready"]);
    remove();
    bridge.receive({ requestId: "close-after-unsubscribe" });
    expect(received).toEqual(["close-before-ready"]);
  });

  it("记录 renderer 确认、两阶段清理与退出，不把取消或超时伪装成退出", () => {
    let tick = 0;
    const tracker = createAppCloseTracker(() => new Date(1_700_000_000_000 + tick++).toISOString());

    tracker.start("app_quit", "close-1");
    expect(tracker.snapshot()).toMatchObject({
      attempt: 1,
      intent: "app_quit",
      requestId: "close-1",
      phase: "awaiting_renderer",
      rendererApproved: false,
    });
    tracker.transition("renderer_approved", { rendererApproved: true });
    tracker.transition("critical_cleanup");
    tracker.transition("recoverable_cleanup", { criticalCleanupComplete: true });
    tracker.transition("exiting", { recoverableCleanupComplete: true });
    expect(tracker.snapshot()).toMatchObject({
      phase: "exiting",
      rendererApproved: true,
      criticalCleanupComplete: true,
      recoverableCleanupComplete: true,
    });

    tracker.start("window_close", "close-2");
    tracker.transition("cancelled", { detail: "renderer-denied" });
    expect(tracker.snapshot()).toMatchObject({ phase: "cancelled", rendererApproved: false });
    tracker.reset("renderer-ack-timeout");
    expect(tracker.snapshot()).toMatchObject({ phase: "idle", detail: "renderer-ack-timeout" });
  });

  it("在期限内返回 settled/rejected，并明确列出仍 pending 的任务", async () => {
    const blocked = deferred<void>();
    const result = await settleLabeledCloseTasks([
      { label: "settled", task: Promise.resolve() },
      { label: "rejected", task: Promise.reject(new Error("close failed")) },
      { label: "blocked", task: blocked.promise },
    ], 15);

    expect(result.timedOut).toBe(true);
    expect(result.settled).toEqual(["settled"]);
    expect(result.rejected).toEqual([{ label: "rejected", error: "close failed" }]);
    expect(result.pending).toEqual(["blocked"]);
    blocked.resolve();
  });

  it("全部任务收敛时不等待完整 timeout", async () => {
    const startedAt = Date.now();
    const result = await settleLabeledCloseTasks([
      { label: "one", task: Promise.resolve() },
      { label: "two", task: Promise.resolve() },
    ], 1_000);

    expect(result).toEqual({
      timedOut: false,
      settled: ["one", "two"],
      rejected: [],
      pending: [],
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("即使没有 critical 任务也只构造并执行一次 recoverable 清理", async () => {
    let recoverableFactoryCalls = 0;
    const result = await runBoundedAppQuitCleanup({
      criticalTasks: [],
      criticalTimeoutMs: 100,
      recoverableTimeoutMs: 100,
      recoverableTasks: () => {
        recoverableFactoryCalls += 1;
        return [{ label: "watchers", task: Promise.resolve() }];
      },
    });

    expect(recoverableFactoryCalls).toBe(1);
    expect(result).toMatchObject({
      decision: "exit",
      recoverableComplete: true,
      recoverable: { settled: ["watchers"], rejected: [], pending: [] },
    });
  });

  it("critical 超时会取消退出且绝不提前摘除 recoverable owner", async () => {
    const blocked = deferred<void>();
    let recoverableFactoryCalls = 0;
    const result = await runBoundedAppQuitCleanup({
      criticalTasks: [{ label: "active-write", task: blocked.promise }],
      criticalTimeoutMs: 10,
      recoverableTimeoutMs: 100,
      recoverableTasks: () => {
        recoverableFactoryCalls += 1;
        return [{ label: "watchers", task: Promise.resolve() }];
      },
    });

    expect(result).toMatchObject({
      decision: "cancel",
      critical: { timedOut: true, pending: ["active-write"] },
    });
    expect(recoverableFactoryCalls).toBe(0);
    blocked.resolve();
  });

  it("critical 已结束后继续收口；recoverable 未收净只记诊断并退出", async () => {
    const failedCritical = deferred<void>();
    const blocked = deferred<void>();
    const resultPromise = runBoundedAppQuitCleanup({
      criticalTasks: [{ label: "failed-write", task: failedCritical.promise }],
      criticalTimeoutMs: 100,
      recoverableTimeoutMs: 10,
      recoverableTasks: () => [
        { label: "failed-watcher", task: Promise.reject(new Error("watcher failed")) },
        { label: "pending-watcher", task: blocked.promise },
      ],
    });
    failedCritical.reject(new Error("scan failed"));
    const result = await resultPromise;

    expect(result).toMatchObject({
      decision: "exit",
      recoverableComplete: false,
      critical: { timedOut: false, rejected: [{ label: "failed-write", error: "scan failed" }] },
      recoverable: {
        timedOut: true,
        rejected: [{ label: "failed-watcher", error: "watcher failed" }],
        pending: ["pending-watcher"],
      },
    });
    blocked.resolve();
  });

  it("在同一同步栈登记 active operation，并在 gate 等待期间关闭 admission 后阻止真实写入", async () => {
    const admission = createAppQuitOperationAdmission();
    const gate = deferred<void>();
    let listenerCalls = 0;
    const operation = admission.run("ipc:canvas:save", async () => {
      await gate.promise;
      admission.assertOpen("ipc:canvas:save");
      listenerCalls += 1;
    });

    expect(admission.snapshotTasks()).toHaveLength(1);
    admission.close();
    gate.resolve();
    await expect(operation).rejects.toThrow(/应用正在退出/u);
    expect(listenerCalls).toBe(0);
    expect(admission.snapshotTasks()).toEqual([]);
  });

  it("同 channel 并发 operation 使用唯一标签，close 后拒绝新任务且 reopen 可恢复", async () => {
    const admission = createAppQuitOperationAdmission();
    const first = deferred<void>();
    const second = deferred<void>();
    const firstRun = admission.run("ipc:canvas:save", () => first.promise);
    const secondRun = admission.run("ipc:canvas:save", () => second.promise);
    const labels = admission.snapshotTasks().map((entry) => entry.label);
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    admission.close();
    await expect(admission.run("ipc:canvas:late", async () => undefined)).rejects.toThrow(/应用正在退出/u);
    first.resolve();
    second.resolve();
    await Promise.all([firstRun, secondRun]);
    admission.reopen();
    await expect(admission.run("ipc:canvas:retry", async () => "ok")).resolves.toBe("ok");
  });

  it("启动前置异步等待期间开始退出时，不继续初始化后续资源", async () => {
    const admission = createAppQuitOperationAdmission();
    const sourceReady = deferred<void>();
    let nativeInitializeCalls = 0;
    const startup = runGuardedAppStartupPrerequisites(admission, {
      startSourceRuntimeWatchers: () => sourceReady.promise,
      async initializeNativeMediaDragResources() { nativeInitializeCalls += 1; },
    });

    admission.close();
    sourceReady.resolve();
    await expect(startup).resolves.toBe(false);
    expect(nativeInitializeCalls).toBe(0);
  });

  it("main 与两个 packaged UI smoke 都接入有界关闭和外层 timeout", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const [main, effectSmoke, reviewSmoke, packageSmoke, terminalFinalizer] = await Promise.all([
      readFile(path.join(workspace, "src/main/index.ts"), "utf8"),
      readFile(path.join(workspace, "scripts/ui-editor-effect-transition-smoke.mjs"), "utf8"),
      readFile(path.join(workspace, "scripts/ui-review-content-identity-smoke.mjs"), "utf8"),
      readFile(path.join(workspace, "scripts/isolated-package-smoke.ts"), "utf8"),
      readFile(path.join(workspace, "scripts/lib/isolated-package-terminal-finalizer.mjs"), "utf8"),
    ]);

    expect(main).toContain("settleLabeledCloseTasks");
    expect(main).toContain("APP_CLOSE_CRITICAL_CLEANUP_TIMEOUT_MS");
    expect(main).toContain("APP_CLOSE_RECOVERABLE_CLEANUP_TIMEOUT_MS");
    expect(main).toContain("__AI_CANVAS_APP_CLOSE_SNAPSHOT__");
    expect(main).toContain("renderer-ack-timeout");
    expect(main).toContain("renderer-bridge-ready-timeout");
    expect(main).toContain('ipcMain.on("canvas:window-close-bridge-ready"');
    expect(main).toContain("rendererCloseBridgeReadyWebContentsIds");
    expect(main).toContain('currentWebContents.on("did-start-navigation"');
    expect(main).toContain("const currentWebContentsId = currentWebContents.id;");
    const closedHandler = main.slice(
      main.indexOf('mainWindow.on("closed"'),
      main.indexOf("const launchImportRoot"),
    );
    expect(closedHandler).toContain("currentWebContentsId");
    expect(closedHandler).not.toContain("currentWindow.webContents");
    expect(main).toContain("runBoundedAppQuitCleanup");
    expect(main).toContain("if (finalProcessExitArmed) return;");
    expect(main).toContain('{ label: "legacy-watchers", task: retryWatcherCloseOnce(() => stopWatcher()) }');
    expect(main).toContain('{ label: "generation-watcher", task: closeStudioGenerationLedgerWatcher() }');
    expect(main).not.toContain("void watcher?.close()");
    expect(main).not.toContain("void semanticWatcher?.close()");
    expect(main).not.toContain("void generationLedgerWatcher?.close()");
    expect(main).toContain("cleanup-incomplete");
    expect(main).toContain("createAppQuitOperationAdmission");
    expect(main).toContain("const appQuitOperationAdmission = createAppQuitOperationAdmission();");
    expect(main).toContain("trackActiveMainMutation");
    expect(main).toContain("appQuitOperationAdmission.snapshotTasks()");
    const ipcWrapper = main.slice(
      main.indexOf("function installSourceRuntimeWriteGate"),
      main.indexOf("async function startSourceRuntimeGateWatchers"),
    );
    expect(ipcWrapper).not.toContain("if (!sourceRuntimeBootIdentity) return;");
    expect(ipcWrapper).toMatch(/effect === "mutation"[\s\S]*effect === "external-side-effect"/u);
    const backgroundWrite = main.slice(
      main.indexOf("async function runRuntimeGatedBackgroundWrite"),
      main.indexOf("function requireStudioCommandInput"),
    );
    expect(backgroundWrite).toContain("trackActiveMainMutation");
    expect(main).toContain("const legacyWatcherQueue = createAsyncExclusiveQueue();");
    expect(main).toContain('appQuitOperationAdmission.assertOpen("create-window")');
    expect(main).toContain("backgroundSmokeMode || appQuitOperationAdmission.isClosed()");
    const readySequence = main.slice(
      main.indexOf("app.whenReady().then"),
      main.indexOf('app.on("window-all-closed"'),
    );
    expect(readySequence).toContain("runGuardedAppStartupPrerequisites");
    expect(readySequence).toContain("startSourceRuntimeWatchers: startSourceRuntimeGateWatchers");
    expect(readySequence).toContain("initializeNativeMediaDragResources: initializeStudioNativeMediaDragResources");
    expect(readySequence).toContain("if (!startupAllowed) return;");
    expect(readySequence).toMatch(/if \(appQuitOperationAdmission\.isClosed\(\)\) return;\s*registerIpc\(\);/u);
    expect(main).toContain("startWatcherExclusive");
    expect(main).toContain("stopWatcherExclusive");
    const legacyWatcherSection = main.slice(
      main.indexOf("function runLegacyWatcherExclusive"),
      main.indexOf("function isRelevantFile"),
    );
    expect(legacyWatcherSection).toContain("appQuitOperationAdmission.isClosed()");
    expect((legacyWatcherSection.match(/appQuitOperationAdmission\.isClosed\(\)/gu) ?? []).length)
      .toBeGreaterThanOrEqual(5);
    expect(main).toContain('AI_CANVAS_ELECTRON_BACKGROUND_SMOKE');
    for (const smoke of [effectSmoke, reviewSmoke]) {
      expect(smoke).toContain("closeElectronApplicationOrThrow");
      expect(smoke).toContain("captureBackgroundElectronStateOrThrow");
      expect(smoke).toContain("assertFreshOutputSet");
      expect(smoke).toContain("writeBytesAtomicExclusive");
      expect(smoke).toContain("writeJsonAtomicExclusive");
      expect(smoke).toContain("timeoutMs: 20_000");
      expect(smoke).not.toMatch(/await\s+app\.close\(\)/u);
      expect(smoke).not.toContain("toFile(screenshotPath)");
      expect(smoke).not.toContain("writeFile(evidencePath");
    }
    expect(effectSmoke).toContain('path.join(runtimeRoot, "electron-user-data")');
    expect(effectSmoke).not.toContain('path.join(root, "electron-user-data")');
    expect(packageSmoke).toMatch(/packaged Effect\/Transition Electron UI full-restart[\s\S]{0,700}timeout:\s*4 \* 60_000/u);
    expect(packageSmoke).toMatch(/packaged ReviewStudio stale-submit full-restart[\s\S]{0,900}timeout:\s*4 \* 60_000/u);
    expect(packageSmoke).toContain("closeRuns?.length !== 2");
    expect(packageSmoke).toContain('AI_CANVAS_ELECTRON_BACKGROUND_SMOKE: "1"');
    expect(packageSmoke).toContain("createUniqueEvidenceStem");
    expect(packageSmoke).toContain("拒绝使用已退休的 isolated-package-smoke-latest.json");
    expect(packageSmoke).toContain("isolatedPackageCompletionMarkerPath(evidencePath)");
    expect(packageSmoke).toContain("finalizeIsolatedPackageTerminalEvidence({");
    expect(packageSmoke).toContain("lockPath: evidenceRunLock.path");
    expect(packageSmoke).not.toMatch(/await evidenceRunLock\.release\(\);\s*await writeJsonAtomicExclusive\(evidencePath/u);
    const terminalWrite = terminalFinalizer.indexOf("writeJsonAtomicExclusive(evidencePath, terminal)");
    const lockRelease = terminalFinalizer.indexOf("await input.releaseLock()", terminalWrite);
    const completionWrite = terminalFinalizer.indexOf("writeJsonAtomicExclusive(completionMarkerPath, completion)", lockRelease);
    expect(terminalWrite).toBeGreaterThanOrEqual(0);
    expect(lockRelease).toBeGreaterThan(terminalWrite);
    expect(completionWrite).toBeGreaterThan(lockRelease);
    expect(terminalFinalizer).toContain("return readCompletedIsolatedPackageTerminalEvidence(evidencePath)");
    expect(terminalFinalizer).toContain("lockAbsent: true");
    expect(packageSmoke).not.toContain("rm(packagedUiEvidencePath");
    expect(packageSmoke).toContain("workspaceSourceIdentityAfter");
  });
});
