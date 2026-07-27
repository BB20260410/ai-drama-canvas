/**
 * 第五阶段：AbortController 超时真取消 + 单飞/序号闸门（shipped 模块直测）。
 *
 * 禁止散文 checklist：本文件直接驱动 unit-grid-projection-read-gate 导出函数，
 * 观测 abort 信号、迟到结果丢弃、底层 probe 收到 abort。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCancellableReadProbe,
  createUnitGridProjectionReadDrainRegistry,
  createUnitGridProjectionFlightGate,
  readWithAbortTimeout,
  UnitGridRawProjectionAborted,
  UnitGridRawProjectionReadTimeout,
} from "../src/renderer/src/unit-grid-projection-read-gate.js";

describe("readWithAbortTimeout（AbortController 超时取消）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("超时 abort signal，丢弃迟到 resolve，底层 probe 收到 abort", async () => {
    vi.useFakeTimers();
    const probe = createCancellableReadProbe({
      delayMs: 5_000,
      value: { sha: "late-result" },
      // 模拟 Electron invoke：abort 后主进程仍可能 resolve
      resolveAfterAbort: true,
      setTimer: (fn, ms) => setTimeout(fn, ms) as unknown,
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    });

    const pending = readWithAbortTimeout(
      "raw 媒体对象",
      "S1E01-U28",
      (signal) => probe.start(signal),
      {
        timeoutMs: 100,
        setTimer: (fn, ms) => setTimeout(fn, ms) as unknown,
        clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      },
    );

    // 推进到超时
    const expectation = expect(pending).rejects.toBeInstanceOf(UnitGridRawProjectionReadTimeout);
    await vi.advanceTimersByTimeAsync(100);
    await expectation;

    expect(probe.wasAborted()).toBe(true);

    // 底层 5s 后仍 resolve，但不得被 readWithAbortTimeout 采用
    await vi.advanceTimersByTimeAsync(5_000);
    // probe 完成计数可 >0（IPC 不可杀），但上层已 reject，无 adopted 值
    expect(probe.completedAfterStart()).toBeGreaterThanOrEqual(0);
  });

  it("超时后 start 返回值不会 resolve 给调用方（即使 IPC 随后完成）", async () => {
    vi.useFakeTimers();
    let adopted: string | null = null;
    let underlyingFinished = false;

    const pending = readWithAbortTimeout(
      "正式整板结果历史",
      "S1E01-U30",
      (signal) => new Promise<string>((resolve) => {
        const t = setTimeout(() => {
          underlyingFinished = true;
          resolve("should-not-adopt");
        }, 1_000);
        signal.addEventListener("abort", () => {
          // 协作：可清 timer；此处保留 timer 模拟不可杀 IPC
          void t;
        }, { once: true });
      }),
      {
        timeoutMs: 50,
        setTimer: (fn, ms) => setTimeout(fn, ms) as unknown,
        clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      },
    ).then(
      (value) => {
        adopted = value;
        return value;
      },
      (error) => {
        adopted = null;
        throw error;
      },
    );

    const expectation = expect(pending).rejects.toMatchObject({ name: "UnitGridRawProjectionReadTimeout" });
    await vi.advanceTimersByTimeAsync(50);
    await expectation;
    expect(adopted).toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(underlyingFinished).toBe(true);
    // 再次确认 adopted 仍为空：迟到结果被吞
    expect(adopted).toBeNull();
  });

  it("外层 signal abort 立即取消并停止采用结果", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const probe = createCancellableReadProbe({
      delayMs: 10_000,
      value: 42,
      resolveAfterAbort: true,
      setTimer: (fn, ms) => setTimeout(fn, ms) as unknown,
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    });

    const pending = readWithAbortTimeout("checkpoint", "时间线", (signal) => probe.start(signal), {
      timeoutMs: 60_000,
      signal: parent.signal,
      setTimer: (fn, ms) => setTimeout(fn, ms) as unknown,
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    });

    parent.abort(new UnitGridRawProjectionAborted("新的投影读取序列已开始"));
    await expect(pending).rejects.toBeInstanceOf(UnitGridRawProjectionAborted);
    expect(probe.wasAborted()).toBe(true);
  });

  it("协作式底层（resolveAfterAbort=false）在 abort 时真正 clear 未完成工作", async () => {
    vi.useFakeTimers();
    const probe = createCancellableReadProbe({
      delayMs: 5_000,
      value: "x",
      resolveAfterAbort: false,
      setTimer: (fn, ms) => setTimeout(fn, ms) as unknown,
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    });

    const pending = readWithAbortTimeout("labeled", "S1E01-U31", (signal) => probe.start(signal), {
      timeoutMs: 80,
      setTimer: (fn, ms) => setTimeout(fn, ms) as unknown,
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    });

    const expectation = expect(pending).rejects.toBeInstanceOf(UnitGridRawProjectionReadTimeout);
    await vi.advanceTimersByTimeAsync(80);
    await expectation;
    expect(probe.wasAborted()).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    // 协作取消后不应再 complete
    expect(probe.completedAfterStart()).toBe(0);
  });

  it("超时后同 lane 等待旧底层真正排空，不启动第二条读取", async () => {
    vi.useFakeTimers();
    const drainRegistry = createUnitGridProjectionReadDrainRegistry();
    let resolveFirst: ((value: string) => void) | undefined;
    let startCount = 0;
    const first = readWithAbortTimeout(
      "冻结参考闭包",
      "S1E01-U28",
      () => {
        startCount += 1;
        return new Promise<string>((resolve) => {
          resolveFirst = resolve;
        });
      },
      {
        timeoutMs: 50,
        drainRegistry,
        setTimer: (fn, ms) => setTimeout(fn, ms) as unknown,
        clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      },
    );

    const firstExpectation = expect(first).rejects.toBeInstanceOf(UnitGridRawProjectionReadTimeout);
    await vi.advanceTimersByTimeAsync(50);
    await firstExpectation;
    expect(startCount).toBe(1);
    expect(drainRegistry.pendingCount("冻结参考闭包")).toBe(1);

    const second = readWithAbortTimeout(
      "冻结参考闭包",
      "S1E01-U29",
      async () => {
        startCount += 1;
        return "second";
      },
      {
        timeoutMs: 100,
        drainRegistry,
        setTimer: (fn, ms) => setTimeout(fn, ms) as unknown,
        clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      },
    );
    await vi.advanceTimersByTimeAsync(40);
    expect(startCount).toBe(1);

    resolveFirst?.("late-first");
    await vi.advanceTimersByTimeAsync(0);
    await expect(second).resolves.toBe("second");
    expect(startCount).toBe(2);
    expect(drainRegistry.pendingCount("冻结参考闭包")).toBe(0);
  });

  it("旧底层在本次总预算内未排空时 fail-soft，且绝不启动新读取", async () => {
    vi.useFakeTimers();
    const drainRegistry = createUnitGridProjectionReadDrainRegistry();
    let startCount = 0;
    const never = new Promise<string>(() => undefined);
    const first = readWithAbortTimeout(
      "raw 媒体对象-排空预算",
      "S1E01-U30",
      () => {
        startCount += 1;
        return never;
      },
      {
        timeoutMs: 20,
        drainRegistry,
        setTimer: (fn, ms) => setTimeout(fn, ms) as unknown,
        clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      },
    );
    const firstExpectation = expect(first).rejects.toBeInstanceOf(UnitGridRawProjectionReadTimeout);
    await vi.advanceTimersByTimeAsync(20);
    await firstExpectation;

    const second = readWithAbortTimeout(
      "raw 媒体对象-排空预算",
      "S1E01-U31",
      async () => {
        startCount += 1;
        return "must-not-start";
      },
      {
        timeoutMs: 30,
        drainRegistry,
        setTimer: (fn, ms) => setTimeout(fn, ms) as unknown,
        clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      },
    );
    const secondExpectation = expect(second).rejects.toBeInstanceOf(UnitGridRawProjectionReadTimeout);
    await vi.advanceTimersByTimeAsync(30);
    await secondExpectation;
    expect(startCount).toBe(1);
    expect(drainRegistry.pendingCount("raw 媒体对象-排空预算")).toBe(1);
  });

  it("永不结算的旧 IPC 只污染当前工程 lane，不阻塞其他工程同名读取", async () => {
    vi.useFakeTimers();
    const drainRegistry = createUnitGridProjectionReadDrainRegistry();
    let startCount = 0;
    const firstLane = "/projects/a\u0000raw 媒体对象";
    const secondLane = "/projects/b\u0000raw 媒体对象";
    const never = new Promise<string>(() => undefined);
    const first = readWithAbortTimeout(
      "raw 媒体对象",
      "A-U01",
      () => {
        startCount += 1;
        return never;
      },
      {
        timeoutMs: 20,
        laneKey: firstLane,
        drainRegistry,
        setTimer: (fn, ms) => setTimeout(fn, ms) as unknown,
        clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      },
    );
    const firstExpectation = expect(first).rejects.toBeInstanceOf(UnitGridRawProjectionReadTimeout);
    await vi.advanceTimersByTimeAsync(20);
    await firstExpectation;
    expect(drainRegistry.pendingCount(firstLane)).toBe(1);

    const second = readWithAbortTimeout(
      "raw 媒体对象",
      "B-U01",
      async () => {
        startCount += 1;
        return "other-project";
      },
      {
        timeoutMs: 20,
        laneKey: secondLane,
        drainRegistry,
        setTimer: (fn, ms) => setTimeout(fn, ms) as unknown,
        clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      },
    );
    await expect(second).resolves.toBe("other-project");
    expect(startCount).toBe(2);
    expect(drainRegistry.pendingCount(secondLane)).toBe(0);
    expect(drainRegistry.pendingCount(firstLane)).toBe(1);
  });
});

describe("createUnitGridProjectionFlightGate（单飞 + 序号闸门）", () => {
  it("同一 projectRoot+unit 集 in-flight 时不启动第二趟，只记 refreshPending", () => {
    const gate = createUnitGridProjectionFlightGate();
    const first = gate.begin("/proj", ["U1", "U2"]);
    expect(first).toEqual({ sequence: 1, requestKey: "/proj\u0000U1|U2" });
    expect(gate.inFlight).toBe(true);
    expect(gate.dataEpoch).toBe(1);

    const second = gate.begin("/proj", ["U1", "U2"]);
    expect(second).toBeNull();
    expect(gate.refreshPending).toBe(true);
    expect(gate.sequence).toBe(1);
    expect(gate.dataEpoch).toBe(2);
    expect(gate.isCurrent(first!.sequence)).toBe(false);
  });

  it("Review PASS→rework 时相同 key 立即禁用旧提交 token，end 后仍要求 rerun", () => {
    const gate = createUnitGridProjectionFlightGate();
    const first = gate.begin("/proj", ["U28"]);
    expect(first).not.toBeNull();
    expect(gate.isCurrent(first!.sequence)).toBe(true);

    // 旧 worker 已读取到 PASS；Review 随后回到 rework。仍是相同 request key，
    // 所以不能启动第二 worker，但旧 PASS 结果必须从这一刻起禁止 commit。
    const reworkRefresh = gate.begin("/proj", ["U28"]);
    expect(reworkRefresh).toBeNull();
    expect(gate.refreshPending).toBe(true);
    expect(gate.isCurrent(first!.sequence)).toBe(false);
    let committedOldPass = false;
    if (gate.isCurrent(first!.sequence)) committedOldPass = true;
    expect(committedOldPass).toBe(false);

    const rerun = gate.end(first!.requestKey, first!.sequence);
    expect(rerun).toBe(true);
    expect(gate.inFlight).toBe(false);

    const next = gate.begin("/proj", ["U28"]);
    expect(next?.sequence).toBe(2);
    expect(gate.dataEpoch).toBe(3);
    expect(gate.isCurrent(first!.sequence)).toBe(false);
    expect(gate.isCurrent(next!.sequence)).toBe(true);
  });

  it("invalidate 使旧 sequence 全部失效（切工程）", () => {
    const gate = createUnitGridProjectionFlightGate();
    const first = gate.begin("/a", ["U0"]);
    const epochBeforeInvalidate = gate.dataEpoch;
    gate.invalidate();
    expect(gate.isCurrent(first!.sequence)).toBe(false);
    expect(gate.inFlight).toBe(false);
    expect(gate.dataEpoch).toBe(epochBeforeInvalidate + 1);
    const next = gate.begin("/b", ["U0"]);
    expect(next!.sequence).toBeGreaterThan(first!.sequence);
    expect(gate.isCurrent(next!.sequence)).toBe(true);
  });

  it("不同 unit 集合可启动新序列（非同 key 单飞）", () => {
    const gate = createUnitGridProjectionFlightGate();
    const a = gate.begin("/p", ["U1"]);
    const b = gate.begin("/p", ["U1", "U2"]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.sequence).toBe(a!.sequence + 1);
    // 旧序列不再 current
    expect(gate.isCurrent(a!.sequence)).toBe(false);
  });
});
