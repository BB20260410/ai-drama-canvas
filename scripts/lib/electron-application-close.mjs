function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForProcessExit(child, timeoutMs) {
  if (processExited(child)) return true;
  let timer;
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return exited || processExited(child);
}

async function closeDiagnostics(application) {
  return application.evaluate(({ BrowserWindow }) => {
    const closeSnapshot = globalThis.__AI_CANVAS_APP_CLOSE_SNAPSHOT__?.();
    return {
      closeSnapshot,
      windows: BrowserWindow.getAllWindows().map((window) => ({
        id: window.id,
        destroyed: window.isDestroyed(),
        visible: window.isVisible(),
        webContentsId: window.webContents.id,
        loading: window.webContents.isLoading(),
      })),
    };
  }).catch((error) => ({ diagnosticError: error instanceof Error ? error.message : String(error) }));
}

export async function captureBackgroundElectronStateOrThrow(application, options = {}) {
  const label = options.label ?? "Electron background smoke";
  const snapshot = await application.evaluate(() => (
    globalThis.__AI_CANVAS_BACKGROUND_SMOKE_SNAPSHOT__?.()
  ));
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  const showEvents = windows.reduce((total, window) => total + Number(window?.showEvents ?? 0), 0);
  const focusEvents = windows.reduce((total, window) => total + Number(window?.focusEvents ?? 0), 0);
  const visibleWindows = windows.filter((window) => window?.visible === true).map((window) => window.id);
  const focusedWindows = windows.filter((window) => window?.focused === true).map((window) => window.id);
  const violations = [];
  if (snapshot?.enabled !== true) violations.push(`enabled=${String(snapshot?.enabled)}`);
  if (windows.length !== 1) violations.push(`windowCount=${windows.length}`);
  if (showEvents !== 0) violations.push(`showEvents=${showEvents}`);
  if (focusEvents !== 0) violations.push(`focusEvents=${focusEvents}`);
  if (visibleWindows.length) violations.push(`visibleWindows=${visibleWindows.join(",")}`);
  if (focusedWindows.length) violations.push(`focusedWindows=${focusedWindows.join(",")}`);
  if (snapshot?.focusedWindowId !== null) violations.push(`focusedWindowId=${String(snapshot?.focusedWindowId)}`);
  if (snapshot?.platform === "darwin") {
    if (snapshot.activationPolicy !== "accessory") {
      violations.push(`activationPolicy=${String(snapshot.activationPolicy)}`);
    }
    if (snapshot.dockVisible !== false) violations.push(`dockVisible=${String(snapshot.dockVisible)}`);
  }
  if (violations.length) {
    throw new Error(`${label} 后台 smoke 可见性门禁失败：${violations.join("；")}`);
  }
  return { label, ...snapshot };
}

export async function forceCleanupElectronApplication(application, options = {}) {
  const termTimeoutMs = options.termTimeoutMs ?? 3_000;
  const killTimeoutMs = options.killTimeoutMs ?? 3_000;
  const child = application.process();
  const result = {
    pid: child.pid,
    forceTerminated: false,
    forceKilled: false,
    exited: processExited(child),
  };
  if (result.exited) return result;

  result.forceTerminated = child.kill("SIGTERM");
  result.exited = await waitForProcessExit(child, termTimeoutMs);
  if (result.exited) return result;

  result.forceKilled = child.kill("SIGKILL");
  result.exited = await waitForProcessExit(child, killTimeoutMs);
  return result;
}

export async function closeElectronApplicationOrThrow(application, options = {}) {
  const label = options.label ?? "Electron application";
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`${label} close timeout 必须是正数。`);
  const child = application.process();
  const startedAt = Date.now();
  let timer;
  try {
    const result = await Promise.race([
      application.close().then(
        () => ({ kind: "closed" }),
        (error) => ({ kind: "rejected", error }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (result.kind === "rejected") throw result.error;
    if (result.kind === "timeout") {
      const diagnostics = await Promise.race([
        closeDiagnostics(application),
        delay(1_000).then(() => ({ diagnosticError: "diagnostic-timeout" })),
      ]);
      throw new Error(`${label} graceful close 超过 ${timeoutMs}ms：${JSON.stringify({ pid: child.pid, diagnostics })}`);
    }
    if (!processExited(child) && !(await waitForProcessExit(child, 1_000))) {
      throw new Error(`${label} close 已返回但 Electron PID ${child.pid} 仍存活。`);
    }
    if (child.signalCode !== null || child.exitCode !== 0) {
      throw new Error(`${label} Electron 根进程非正常退出：${JSON.stringify({
        exitCode: child.exitCode,
        signalCode: child.signalCode,
      })}`);
    }
    return {
      label,
      pid: child.pid,
      durationMs: Date.now() - startedAt,
      graceful: true,
      forceTerminated: false,
      forceKilled: false,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
    };
  } catch (error) {
    if (timer) clearTimeout(timer);
    const cleanup = await forceCleanupElectronApplication(application, options);
    throw new Error(`${label} 正常关闭失败，已按失败路径精准清理；强杀不计 PASS：${JSON.stringify({
      cause: error instanceof Error ? error.message : String(error),
      cleanup,
    })}`);
  }
}
