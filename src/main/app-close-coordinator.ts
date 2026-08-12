export type AppCloseIntent = "window_close" | "app_quit";

export type AppClosePhase =
  | "idle"
  | "awaiting_renderer"
  | "renderer_approved"
  | "critical_cleanup"
  | "recoverable_cleanup"
  | "exiting"
  | "cancelled";

export interface AppCloseSnapshot {
  attempt: number;
  intent?: AppCloseIntent;
  requestId?: string;
  phase: AppClosePhase;
  rendererApproved: boolean;
  criticalCleanupComplete: boolean;
  recoverableCleanupComplete: boolean;
  detail?: string;
  updatedAt: string;
  history: Array<{ phase: AppClosePhase; at: string; detail?: string }>;
}

export interface AppCloseTracker {
  start(intent: AppCloseIntent, requestId: string): AppCloseSnapshot;
  transition(
    phase: Exclude<AppClosePhase, "idle" | "awaiting_renderer">,
    patch?: Partial<Pick<AppCloseSnapshot, "rendererApproved" | "criticalCleanupComplete" | "recoverableCleanupComplete" | "detail">>,
  ): AppCloseSnapshot;
  reset(detail?: string): AppCloseSnapshot;
  snapshot(): AppCloseSnapshot;
}

export interface RendererCloseRequestDeliveryInput {
  requestId: string;
  webContentsId: number;
  isPending(requestId: string, webContentsId: number): boolean;
  isReady(): boolean;
  isDestroyed(): boolean;
  send(request: { requestId: string }): void;
  onDelivered?(): void;
  schedule?(callback: () => void): void;
}

/**
 * BrowserWindow 的 close 事件必须先返回，renderer close request 才进入 IPC。
 * ElectronApplication.close() 会在同一退出调用链里关闭调试连接；同步 send
 * 偶发无法交付。下一事件循环投递时仍须核对 request/window 身份，避免旧请求
 * 在取消、超时或窗口销毁后误关闭新状态。
 */
export function scheduleRendererCloseRequestDelivery(
  input: RendererCloseRequestDeliveryInput,
): void {
  const schedule = input.schedule ?? ((callback: () => void) => { setImmediate(callback); });
  schedule(() => {
    if (!input.isPending(input.requestId, input.webContentsId)
      || !input.isReady()
      || input.isDestroyed()) return;
    input.send({ requestId: input.requestId });
    input.onDelivered?.();
  });
}

function cloneSnapshot(snapshot: AppCloseSnapshot): AppCloseSnapshot {
  return { ...snapshot, history: snapshot.history.map((entry) => ({ ...entry })) };
}

export function createAppCloseTracker(now: () => string = () => new Date().toISOString()): AppCloseTracker {
  let state: AppCloseSnapshot = {
    attempt: 0,
    phase: "idle",
    rendererApproved: false,
    criticalCleanupComplete: false,
    recoverableCleanupComplete: false,
    updatedAt: now(),
    history: [],
  };

  const snapshot = (): AppCloseSnapshot => cloneSnapshot(state);
  const record = (phase: AppClosePhase, detail?: string): void => {
    const at = now();
    state.updatedAt = at;
    state.history = [...state.history, { phase, at, ...(detail ? { detail } : {}) }].slice(-24);
  };

  return {
    start(intent, requestId) {
      state = {
        attempt: state.attempt + 1,
        intent,
        requestId,
        phase: "awaiting_renderer",
        rendererApproved: false,
        criticalCleanupComplete: false,
        recoverableCleanupComplete: false,
        updatedAt: now(),
        history: [],
      };
      record("awaiting_renderer");
      return snapshot();
    },
    transition(phase, patch = {}) {
      state = { ...state, ...patch, phase };
      record(phase, patch.detail);
      return snapshot();
    },
    reset(detail) {
      const attempt = state.attempt;
      const updatedAt = now();
      const historyEntry: AppCloseSnapshot["history"][number] = {
        phase: "idle",
        at: updatedAt,
        ...(detail ? { detail } : {}),
      };
      state = {
        attempt,
        phase: "idle",
        rendererApproved: false,
        criticalCleanupComplete: false,
        recoverableCleanupComplete: false,
        ...(detail ? { detail } : {}),
        updatedAt,
        history: [...state.history, historyEntry].slice(-24),
      };
      return snapshot();
    },
    snapshot,
  };
}

export interface LabeledCloseTask {
  label: string;
  task: PromiseLike<unknown> | unknown;
}

export interface AppQuitOperationAdmission {
  isClosed(): boolean;
  close(): void;
  reopen(): void;
  assertOpen(action: string): void;
  run<T>(action: string, operation: () => Promise<T> | T): Promise<T>;
  snapshotTasks(): LabeledCloseTask[];
}

export interface GuardedAppStartupPrerequisites {
  startSourceRuntimeWatchers(): Promise<void>;
  initializeNativeMediaDragResources(): Promise<void>;
}

/** 退出 admission 关闭后，异步启动链不得继续注册协议、IPC 或创建窗口。 */
export async function runGuardedAppStartupPrerequisites(
  admission: Pick<AppQuitOperationAdmission, "isClosed">,
  prerequisites: GuardedAppStartupPrerequisites,
): Promise<boolean> {
  if (admission.isClosed()) return false;
  await prerequisites.startSourceRuntimeWatchers();
  if (admission.isClosed()) return false;
  await prerequisites.initializeNativeMediaDragResources();
  return !admission.isClosed();
}

/**
 * 主进程写入/外部副作用的单一 admission owner。
 *
 * run 在同一个同步栈里完成“检查 + 唯一编号 + active 登记”，真实 operation
 * 延后到 microtask 执行；因此 before-quit 关闭 admission 后取得的 snapshot 不会漏写。
 */
export function createAppQuitOperationAdmission(): AppQuitOperationAdmission {
  let closed = false;
  let nextOperationId = 0;
  const active = new Map<Promise<unknown>, { id: number; action: string }>();

  const assertOpen = (action: string): void => {
    if (closed) throw new Error(`应用正在退出，禁止开始新的写入或外部副作用：${action}`);
  };

  return {
    isClosed: () => closed,
    close: () => { closed = true; },
    reopen: () => { closed = false; },
    assertOpen,
    async run<T>(action: string, operation: () => Promise<T> | T): Promise<T> {
      assertOpen(action);
      const identity = { id: ++nextOperationId, action };
      const task = Promise.resolve().then(operation);
      active.set(task, identity);
      try {
        return await task;
      } finally {
        active.delete(task);
      }
    },
    snapshotTasks(): LabeledCloseTask[] {
      return [...active.entries()].map(([task, identity]) => ({
        label: `active-operation-${identity.id}:${identity.action}`,
        task,
      }));
    },
  };
}

export interface LabeledCloseTaskResult {
  timedOut: boolean;
  settled: string[];
  rejected: Array<{ label: string; error: string }>;
  pending: string[];
}

export interface BoundedAppQuitCleanupInput {
  criticalTasks: LabeledCloseTask[];
  recoverableTasks: () => LabeledCloseTask[];
  criticalTimeoutMs: number;
  recoverableTimeoutMs: number;
}

export type BoundedAppQuitCleanupResult =
  | {
      decision: "cancel";
      stage: "critical";
      critical: LabeledCloseTaskResult;
    }
  | {
      decision: "exit";
      critical: LabeledCloseTaskResult;
      recoverable: LabeledCloseTaskResult;
      recoverableComplete: boolean;
    };

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

export async function settleLabeledCloseTasks(
  tasks: LabeledCloseTask[],
  timeoutMs: number,
): Promise<LabeledCloseTaskResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("App close timeout 必须是正数。 ");
  const status = new Map<string, { kind: "settled" } | { kind: "rejected"; error: string }>();
  const operations = tasks.map(async ({ label, task }) => {
    try {
      await task;
      status.set(label, { kind: "settled" });
    } catch (error) {
      status.set(label, { kind: "rejected", error: errorMessage(error) });
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    Promise.all(operations).then(() => false),
    new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  const settled: string[] = [];
  const rejected: Array<{ label: string; error: string }> = [];
  const pending: string[] = [];
  for (const { label } of tasks) {
    const result = status.get(label);
    if (!result) pending.push(label);
    else if (result.kind === "settled") settled.push(label);
    else rejected.push({ label, error: result.error });
  }
  return { timedOut, settled, rejected, pending };
}

/**
 * App 退出的两阶段纯协调器。
 *
 * critical 任务仍 pending 时必须取消退出，且 recoverable factory 绝不能被调用。
 * 一旦所有关键写任务都已结束，recoverable owner 已开始不可逆摘除；即使其关闭
 * 超时或拒绝，也必须带诊断继续退出，不能 reopen 一个已退化的运行时。
 */
export async function runBoundedAppQuitCleanup(
  input: BoundedAppQuitCleanupInput,
): Promise<BoundedAppQuitCleanupResult> {
  const critical = await settleLabeledCloseTasks(
    input.criticalTasks,
    input.criticalTimeoutMs,
  );
  if (critical.timedOut) return { decision: "cancel", stage: "critical", critical };

  const recoverable = await settleLabeledCloseTasks(
    input.recoverableTasks(),
    input.recoverableTimeoutMs,
  );
  return {
    decision: "exit",
    critical,
    recoverable,
    recoverableComplete: !recoverable.timedOut && recoverable.rejected.length === 0,
  };
}
