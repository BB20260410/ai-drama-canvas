/**
 * 宫格正式 raw 投影读取门：AbortController 超时取消 + 单飞 + 序号闸门。
 *
 * 设计要点（对应生产中枢第五阶段）：
 * 1. 超时必须 abort signal，协作式停止后续工作；
 * 2. 超时后即使底层 Promise 仍 resolve，也不得把结果交给调用方（丢弃过期结果）；
 * 3. 同一 projectRoot+unitKey 深核验单飞；
 * 4. 序号闸门禁止旧请求写回新投影状态。
 *
 * Electron ipcRenderer.invoke 本身不可强杀主进程中途执行；本模块在渲染侧提供
 * 可观测的 AbortSignal 取消与结果丢弃。底层 start(signal) 必须监听 abort 并
 * 停止追加工作（例如不再发下一跳 IPC / 不再派生缩略图）。
 */

export const UNIT_GRID_RAW_PROJECTION_READ_TIMEOUT_MS_DEFAULT = 20_000;

export class UnitGridRawProjectionReadTimeout extends Error {
  readonly readName: string;
  readonly unitId: string;
  readonly timeoutMs: number;

  constructor(readName: string, unitId: string, timeoutMs: number) {
    super(`${unitId} 的 ${readName} 未在 ${timeoutMs}ms 内完成`);
    this.name = "UnitGridRawProjectionReadTimeout";
    this.readName = readName;
    this.unitId = unitId;
    this.timeoutMs = timeoutMs;
  }
}

export class UnitGridRawProjectionAborted extends Error {
  constructor(message = "投影读取已取消") {
    super(message);
    this.name = "UnitGridRawProjectionAborted";
  }
}

export interface ReadWithAbortTimeoutOptions {
  /** 超时毫秒；默认 20_000。 */
  timeoutMs?: number;
  /** 外层取消（工程切换/新序列）。 */
  signal?: AbortSignal;
  /**
   * 同一读取 lane 的排空注册表。缺省使用进程内共享注册表；测试可注入隔离实例。
   * Electron IPC 无法被 AbortSignal 强杀时，超时任务会留在这里，后续同 lane
   * 读取必须等它真正结算，禁止把“丢弃结果”伪装成“底层已取消”。
   */
  drainRegistry?: UnitGridProjectionReadDrainRegistry;
  /** lane 缺省按 readName 归并；调用方可显式收窄或扩展。 */
  laneKey?: string;
  /** 可注入时钟（单测）。 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  now?: () => number;
}

export interface UnitGridProjectionReadDrainRegistry {
  /** 当前 lane 中尚未真正结算的超时/取消底层任务；没有则返回 undefined。 */
  getDrain(laneKey: string): Promise<void> | undefined;
  /** 登记一个必须真正结算后才可放行同 lane 新读取的底层任务。 */
  register(laneKey: string, operation: Promise<unknown>): void;
  /** 仅供确定性测试与诊断。 */
  pendingCount(laneKey: string): number;
}

export function createUnitGridProjectionReadDrainRegistry(): UnitGridProjectionReadDrainRegistry {
  const pendingByLane = new Map<string, Set<Promise<void>>>();
  return {
    getDrain(laneKey) {
      const pending = pendingByLane.get(laneKey);
      if (!pending?.size) return undefined;
      return Promise.all([...pending]).then(() => undefined);
    },
    register(laneKey, operation) {
      const drained = operation.then(
        () => undefined,
        () => undefined,
      );
      const pending = pendingByLane.get(laneKey) ?? new Set<Promise<void>>();
      pending.add(drained);
      pendingByLane.set(laneKey, pending);
      void drained.then(() => {
        pending.delete(drained);
        if (pending.size === 0 && pendingByLane.get(laneKey) === pending) {
          pendingByLane.delete(laneKey);
        }
      });
    },
    pendingCount(laneKey) {
      return pendingByLane.get(laneKey)?.size ?? 0;
    },
  };
}

const sharedProjectionReadDrainRegistry = createUnitGridProjectionReadDrainRegistry();

async function waitForLaneDrain(
  drain: Promise<void>,
  input: {
    readName: string;
    unitId: string;
    timeoutMs: number;
    signal?: AbortSignal;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (id: unknown) => void;
  },
): Promise<void> {
  if (input.signal?.aborted) {
    throw normalizeAbortReason(input.signal.reason, input.readName, input.unitId, input.timeoutMs);
  }
  const timeoutError = new UnitGridRawProjectionReadTimeout(
    input.readName,
    input.unitId,
    input.timeoutMs,
  );
  let timerId: unknown;
  let onAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timerId = input.setTimer(() => reject(timeoutError), input.timeoutMs);
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (!input.signal) return;
    onAbort = () => reject(normalizeAbortReason(
      input.signal?.reason,
      input.readName,
      input.unitId,
      input.timeoutMs,
    ));
    input.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([drain, timeoutPromise, abortPromise]);
  } finally {
    if (timerId !== undefined) input.clearTimer(timerId);
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 带 AbortController 的有界读取。
 * - 超时：controller.abort(timeoutError)，reject 超时错误；
 * - start(signal) 返回的 Promise 若在 abort 后才 resolve，结果被丢弃并抛 Aborted/Timeout；
 * - 超时/取消但底层未结算：登记 drain；同 lane 后续读取在本次总预算内等待，
 *   不启动第二条底层任务；
 * - start 应把 signal 接到可协作取消的逻辑上（至少在 await 后检查 aborted）。
 */
export async function readWithAbortTimeout<T>(
  readName: string,
  unitId: string,
  start: (signal: AbortSignal) => Promise<T>,
  options: ReadWithAbortTimeoutOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? UNIT_GRID_RAW_PROJECTION_READ_TIMEOUT_MS_DEFAULT;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const drainRegistry = options.drainRegistry ?? sharedProjectionReadDrainRegistry;
  const laneKey = options.laneKey?.trim() || readName;

  if (options.signal?.aborted) {
    throw normalizeAbortReason(options.signal.reason, readName, unitId, timeoutMs);
  }

  // 多个旧任务可能在相邻时刻进入 drain；每次排空后重读注册表，直到该 lane
  // 确认真正为空。等待时间计入本次总超时预算，不把一次 20s 读取膨胀成 40s。
  while (true) {
    const drain = drainRegistry.getDrain(laneKey);
    if (!drain) break;
    const remainingMs = Math.max(0, timeoutMs - (now() - startedAt));
    if (remainingMs <= 0) {
      throw new UnitGridRawProjectionReadTimeout(readName, unitId, timeoutMs);
    }
    await waitForLaneDrain(drain, {
      readName,
      unitId,
      timeoutMs: remainingMs,
      ...(options.signal ? { signal: options.signal } : {}),
      setTimer,
      clearTimer,
    });
  }

  const remainingMs = Math.max(0, timeoutMs - (now() - startedAt));
  if (remainingMs <= 0) {
    throw new UnitGridRawProjectionReadTimeout(readName, unitId, timeoutMs);
  }
  const controller = new AbortController();
  let rejectOnAbort: ((reason?: unknown) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onControllerAbort = (): void => {
    rejectOnAbort?.(normalizeAbortReason(controller.signal.reason, readName, unitId, timeoutMs));
  };
  controller.signal.addEventListener("abort", onControllerAbort, { once: true });
  const onParentAbort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(options.signal?.reason ?? new UnitGridRawProjectionAborted("外层取消投影读取"));
    }
  };
  options.signal?.addEventListener("abort", onParentAbort, { once: true });

  let timerId: unknown;
  let timedOut = false;
  let taskSettled = false;
  let drainRegistered = false;
  const timeoutError = new UnitGridRawProjectionReadTimeout(readName, unitId, timeoutMs);

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timerId = setTimer(() => {
      timedOut = true;
      if (!controller.signal.aborted) controller.abort(timeoutError);
      reject(timeoutError);
    }, remainingMs);
  });

  const taskPromise = Promise.resolve()
    .then(() => start(controller.signal))
    .then((value) => {
      // 超时/外层取消后丢弃迟到结果：真正停止“采用”底层读。
      if (controller.signal.aborted || timedOut) {
        throw normalizeAbortReason(controller.signal.reason ?? timeoutError, readName, unitId, timeoutMs);
      }
      return value;
    })
    .then(
      (value) => {
        taskSettled = true;
        return value;
      },
      (error) => {
        taskSettled = true;
        throw error;
      },
    );

  try {
    return await Promise.race([taskPromise, timeoutPromise, abortPromise]);
  } catch (error) {
    if (controller.signal.aborted && !taskSettled && !drainRegistered) {
      drainRegistered = true;
      drainRegistry.register(laneKey, taskPromise);
    }
    throw error;
  } finally {
    if (timerId !== undefined) clearTimer(timerId);
    options.signal?.removeEventListener("abort", onParentAbort);
    controller.signal.removeEventListener("abort", onControllerAbort);
  }
}

function normalizeAbortReason(
  reason: unknown,
  readName: string,
  unitId: string,
  timeoutMs: number,
): Error {
  if (reason instanceof UnitGridRawProjectionReadTimeout) return reason;
  if (reason instanceof UnitGridRawProjectionAborted) return reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason) return new UnitGridRawProjectionAborted(reason);
  return new UnitGridRawProjectionReadTimeout(readName, unitId, timeoutMs);
}

/** 单飞 + 任务所有权序号 + 数据纪元闸门状态机（纯逻辑，供 Vue 与单测共用）。 */
export interface UnitGridProjectionFlightGate {
  /** 当前是否有 in-flight。 */
  readonly inFlight: boolean;
  /** 当前 request key（projectRoot\\0unitIds）。 */
  readonly requestKey: string;
  /** 单调任务所有权序号。 */
  readonly sequence: number;
  /**
   * 单调数据纪元。每次 begin 都代表上游投影可能发生了使旧结果失效的变化；
   * 即使相同 request key 因单飞只进入 refreshPending，也必须立即推进。
   */
  readonly dataEpoch: number;
  /** 是否有挂起的同 key 刷新。 */
  readonly refreshPending: boolean;
  /**
   * 尝试开始一次深核验。
   * - 调用即推进 dataEpoch，使此前取得的提交 token 立即失效；
   * - 同 key 且已 in-flight → 标记 refreshPending，返回 null（保持单飞，不启动新任务）
   * - 否则分配新 sequence，并把该任务绑定到当前 dataEpoch。
   */
  begin(projectRoot: string, unitIds: readonly string[]): { sequence: number; requestKey: string } | null;
  /** 任务结束时调用；若 refreshPending 且仍是同一 key，返回 true 表示应再跑一轮。 */
  end(requestKey: string, sequence: number): boolean;
  /** 是否仍同时拥有当前任务序号与数据纪元（写回前校验）。 */
  isCurrent(sequence: number): boolean;
  /** 强制失效（切工程）。 */
  invalidate(): void;
}

export function createUnitGridProjectionFlightGate(): UnitGridProjectionFlightGate {
  let inFlight = false;
  let requestKey = "";
  let sequence = 0;
  let dataEpoch = 0;
  let activeFlightDataEpoch = 0;
  let refreshPending = false;

  return {
    get inFlight() {
      return inFlight;
    },
    get requestKey() {
      return requestKey;
    },
    get sequence() {
      return sequence;
    },
    get dataEpoch() {
      return dataEpoch;
    },
    get refreshPending() {
      return refreshPending;
    },
    begin(projectRoot, unitIds) {
      const key = `${projectRoot}\u0000${unitIds.join("|")}`;
      // 调度调用来自 overview/Review 等上游变化。即使相同 key 已经单飞，
      // 这次变化也必须立刻阻止旧 worker 把 PASS 结果写回 rework 后的数据。
      dataEpoch += 1;
      if (inFlight && requestKey === key) {
        refreshPending = true;
        return null;
      }
      requestKey = key;
      refreshPending = false;
      sequence += 1;
      inFlight = true;
      activeFlightDataEpoch = dataEpoch;
      return { sequence, requestKey: key };
    },
    end(endedKey, endedSequence) {
      if (requestKey !== endedKey || sequence !== endedSequence) {
        // 已有更新的请求；本任务不拥有 inFlight 标志。
        return false;
      }
      inFlight = false;
      if (refreshPending) {
        refreshPending = false;
        return true;
      }
      return false;
    },
    isCurrent(seq) {
      return seq === sequence && activeFlightDataEpoch === dataEpoch;
    },
    invalidate() {
      dataEpoch += 1;
      sequence += 1;
      inFlight = false;
      refreshPending = false;
      requestKey = "";
    },
  };
}

/**
 * 包装一层“可协作取消”的 Promise 工厂：监听 signal，abort 后：
 * - 标记 stopped=true（供测试观察）；
 * - 后续 then 回调不再执行业务副作用（由 readWithAbortTimeout 丢弃结果）。
 */
export function createCancellableReadProbe<T>(input: {
  /** 模拟底层读耗时。 */
  delayMs: number;
  /** 成功时返回值。 */
  value: T;
  /** abort 时是否仍 resolve（模拟不可杀 IPC）；默认 true。 */
  resolveAfterAbort?: boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}): {
  start: (signal: AbortSignal) => Promise<T>;
  /** 底层是否收到 abort。 */
  wasAborted: () => boolean;
  /** 底层完成回调是否执行（abort 后不应再计为 adopted）。 */
  completedAfterStart: () => number;
} {
  let aborted = false;
  let completed = 0;
  const setTimer = input.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = input.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const resolveAfterAbort = input.resolveAfterAbort ?? true;

  return {
    wasAborted: () => aborted,
    completedAfterStart: () => completed,
    start(signal) {
      return new Promise<T>((resolve, reject) => {
        if (signal.aborted) {
          aborted = true;
          reject(signal.reason ?? new UnitGridRawProjectionAborted());
          return;
        }
        const timer = setTimer(() => {
          completed += 1;
          if (signal.aborted && !resolveAfterAbort) {
            reject(signal.reason ?? new UnitGridRawProjectionAborted());
            return;
          }
          // 即使 resolveAfterAbort，readWithAbortTimeout 也会丢弃结果。
          resolve(input.value);
        }, input.delayMs);
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            if (!resolveAfterAbort) {
              clearTimer(timer);
              reject(signal.reason ?? new UnitGridRawProjectionAborted());
            }
            // resolveAfterAbort=true：模拟 IPC 不可杀，timer 仍会 fire，但上层丢弃。
          },
          { once: true },
        );
      });
    },
  };
}
