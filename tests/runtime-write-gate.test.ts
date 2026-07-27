import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertRuntimeWriteGateCurrent,
  captureRuntimeBootIdentity,
  createRuntimeGateController,
  createRuntimeWriteGateSingleFlight,
  inspectRuntimeWriteGate,
  type RuntimeBootIdentity,
  type RuntimeWriteGateStatus,
} from "../src/core/runtime-write-gate.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-runtime-write-gate-"));
  roots.push(root);
  await mkdir(path.join(root, "src", "main"), { recursive: true });
  const artifactPath = path.join(root, "src", "main", "index.ts");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.1" }), "utf8");
  await writeFile(artifactPath, "export const runtime = 1;\n", "utf8");
  return {
    root,
    artifactPath,
    boot: await captureRuntimeBootIdentity({
      workspace: root,
      loadedArtifactPath: artifactPath,
      runtimeBootId: "runtime-write-gate-fixture",
      pid: 123,
      startedAt: "2026-07-26T00:00:00.000Z",
    }),
  };
}

describe("源码桌面运行身份写闸门", () => {
  it("启动工件与源码均未变化时允许写入", async () => {
    const test = await fixture();
    await expect(assertRuntimeWriteGateCurrent(test.boot, "canvas:execute-studio-command"))
      .resolves.toMatchObject({
        allowed: true,
        restartRequired: false,
        reasons: [],
      });
  });

  it("启动后源码变化时拒绝写入并保留只读诊断", async () => {
    const test = await fixture();
    await writeFile(path.join(test.root, "src", "source-change.ts"), "export const changed = true;\n", "utf8");
    const status = await inspectRuntimeWriteGate(test.boot);
    expect(status).toMatchObject({
      allowed: false,
      restartRequired: true,
      reasons: ["source-changed"],
    });
    await expect(assertRuntimeWriteGateCurrent(test.boot, "canvas:save-studio-canvas-layout"))
      .rejects.toMatchObject({
        code: "runtime-restart-required",
        status: { restartRequired: true },
      });
  });

  it("启动后实际载入工件被替换时拒绝写入", async () => {
    const test = await fixture();
    await writeFile(test.artifactPath, "export const runtime = 2;\n", "utf8");
    const status = await inspectRuntimeWriteGate(test.boot);
    expect(status.allowed).toBe(false);
    expect(status.reasons).toEqual(expect.arrayContaining([
      "runtime-artifact-changed",
      "source-changed",
    ]));
  });

  it("已加载工件声明的构建源码与启动时磁盘源码不一致时拒绝写入", async () => {
    const test = await fixture();
    const mismatched = await captureRuntimeBootIdentity({
      workspace: test.root,
      loadedArtifactPath: test.artifactPath,
      artifactSourceDigest: "f".repeat(64),
    });
    await expect(inspectRuntimeWriteGate(mismatched)).resolves.toMatchObject({
      allowed: false,
      restartRequired: true,
      reasons: ["runtime-artifact-source-mismatch"],
    });
  });

  it("并发同批门禁只计算一次源码 digest，结算后的下一批仍重新核验", async () => {
    const test = await fixture();
    const computeSourceDigest = vi.fn(async () => ({
      sourceDigest: test.boot.bootSourceDigest,
      sourceFiles: 2,
      sourceBytes: 64,
    }));
    const inspectSingleFlight = createRuntimeWriteGateSingleFlight((boot) => (
      inspectRuntimeWriteGate(boot, { computeSourceDigest })
    ));

    const firstBatch = await Promise.all([
      inspectSingleFlight(test.boot),
      inspectSingleFlight(test.boot),
      inspectSingleFlight(test.boot),
      inspectSingleFlight(test.boot),
    ]);
    expect(firstBatch.every((status) => status.allowed)).toBe(true);
    expect(computeSourceDigest).toHaveBeenCalledTimes(1);

    await expect(inspectSingleFlight(test.boot)).resolves.toMatchObject({ allowed: true });
    expect(computeSourceDigest).toHaveBeenCalledTimes(2);
  });
});

function gateStatus(
  boot: RuntimeBootIdentity,
  allowed = true,
  checkedAt = "2026-07-26T00:00:00.000Z",
): RuntimeWriteGateStatus {
  return {
    ...boot,
    currentArtifactSha256: boot.loadedArtifactSha256,
    currentSourceDigest: allowed ? boot.bootSourceDigest : "f".repeat(64),
    allowed,
    restartRequired: !allowed,
    checkedAt,
    reasons: allowed ? [] : ["source-changed"],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("源码运行态门禁控制器", () => {
  it("watcher 健康时复用短 TTL，过期后重新核验", async () => {
    const test = await fixture();
    let clock = 1_000;
    const inspect = vi.fn(async (boot: RuntimeBootIdentity) => gateStatus(boot, true));
    const controller = createRuntimeGateController({
      inspect,
      now: () => clock,
      readTtlMs: 100,
      watcherHealthy: true,
    });

    await expect(controller.checkRead(test.boot)).resolves.toMatchObject({ allowed: true });
    clock += 99;
    await expect(controller.checkDiagnostic(test.boot)).resolves.toMatchObject({ allowed: true });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(controller.getMetrics()).toMatchObject({
      digestCalls: 1,
      inspectionCalls: 1,
      readChecks: 2,
      readCacheHits: 1,
      readCacheMisses: 1,
      watcherHealthy: true,
    });

    clock += 1;
    await expect(controller.checkRead(test.boot)).resolves.toMatchObject({ allowed: true });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("并发 read miss 只核验一次并记录 singleflight join", async () => {
    const test = await fixture();
    const pending = deferred<RuntimeWriteGateStatus>();
    const inspect = vi.fn(() => pending.promise);
    const controller = createRuntimeGateController({
      inspect,
      watcherHealthy: true,
    });

    const reads = [
      controller.checkRead(test.boot),
      controller.checkRead(test.boot),
      controller.checkRead(test.boot),
      controller.checkRead(test.boot),
    ];
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    pending.resolve(gateStatus(test.boot, true));
    await expect(Promise.all(reads)).resolves.toHaveLength(4);
    expect(controller.getMetrics()).toMatchObject({
      inspectionCalls: 1,
      readCacheMisses: 4,
      readSingleflightJoins: 3,
    });
  });

  it("核验期间 invalidate 会切断 epoch 且旧结果不入缓存", async () => {
    const test = await fixture();
    const first = deferred<RuntimeWriteGateStatus>();
    const inspect = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (boot: RuntimeBootIdentity) => gateStatus(boot, true));
    const controller = createRuntimeGateController({
      inspect,
      watcherHealthy: true,
    });

    const staleRead = controller.checkRead(test.boot);
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    controller.invalidate();
    const currentRead = controller.checkRead(test.boot);
    await expect(currentRead).resolves.toMatchObject({ allowed: true });
    first.resolve(gateStatus(test.boot, true));
    await expect(staleRead).resolves.toMatchObject({ allowed: true });

    await controller.checkRead(test.boot);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(controller.getMetrics()).toMatchObject({
      invalidations: 1,
      invalidationEpoch: 1,
      readCacheHits: 1,
    });
  });

  it("denied read 可安全缓存，assertReadCurrent 始终失败关闭", async () => {
    const test = await fixture();
    const inspect = vi.fn(async (boot: RuntimeBootIdentity) => gateStatus(boot, false));
    const controller = createRuntimeGateController({
      inspect,
      watcherHealthy: true,
    });

    await expect(controller.checkRead(test.boot)).resolves.toMatchObject({
      allowed: false,
      reasons: ["source-changed"],
    });
    await expect(controller.assertReadCurrent(test.boot, "canvas:read-probe"))
      .rejects.toMatchObject({
        code: "runtime-restart-required",
        status: { allowed: false },
      });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(controller.getMetrics().readCacheHits).toBe(1);
  });

  it("watcher 未 ready 或失败时不保留 settled cache，每批均重新核验", async () => {
    const test = await fixture();
    const inspect = vi.fn(async (boot: RuntimeBootIdentity) => gateStatus(boot, true));
    const controller = createRuntimeGateController({ inspect });

    await controller.checkRead(test.boot);
    await controller.checkRead(test.boot);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(controller.getMetrics()).toMatchObject({
      watcherHealthy: false,
      readCacheHits: 0,
    });

    controller.setWatcherHealthy(true);
    await controller.checkRead(test.boot);
    await controller.checkRead(test.boot);
    expect(inspect).toHaveBeenCalledTimes(3);
    controller.setWatcherHealthy(false);
    await controller.checkRead(test.boot);
    await controller.checkRead(test.boot);
    expect(inspect).toHaveBeenCalledTimes(5);
    expect(controller.getMetrics()).toMatchObject({
      watcherHealthy: false,
      invalidations: 2,
    });
  });

  it("mutation 永不复用 allowed read cache，只合并同批在途并于结算后失效", async () => {
    const test = await fixture();
    const mutationBatch = deferred<RuntimeWriteGateStatus>();
    const inspect = vi.fn()
      .mockImplementationOnce(async (boot: RuntimeBootIdentity) => gateStatus(boot, true))
      .mockImplementationOnce(() => mutationBatch.promise)
      .mockImplementation(async (boot: RuntimeBootIdentity) => gateStatus(boot, false));
    const controller = createRuntimeGateController({
      inspect,
      watcherHealthy: true,
    });

    await controller.checkRead(test.boot);
    await controller.checkRead(test.boot);
    expect(inspect).toHaveBeenCalledTimes(1);

    const writes = [
      controller.checkMutation(test.boot),
      controller.checkMutation(test.boot),
      controller.checkMutation(test.boot),
    ];
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    mutationBatch.resolve(gateStatus(test.boot, true));
    await expect(Promise.all(writes)).resolves.toHaveLength(3);
    expect(controller.getMetrics()).toMatchObject({
      mutationChecks: 3,
      mutationSingleflightJoins: 2,
    });

    await expect(controller.assertMutationCurrent(test.boot, "canvas:write-probe"))
      .rejects.toMatchObject({
        code: "runtime-restart-required",
        status: { allowed: false },
      });
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(controller.getMetrics()).toMatchObject({
      digestCalls: 3,
      inspectionCalls: 3,
      mutationChecks: 4,
    });
  });

  it("mutation 核验期间 epoch 失效时重验到稳定", async () => {
    const test = await fixture();
    let controller!: ReturnType<typeof createRuntimeGateController>;
    const inspect = vi.fn(async (boot: RuntimeBootIdentity) => {
      // 模拟第一次强核验进行中 watcher 触发源码失效；第二次核验全程稳定。
      if (inspect.mock.calls.length === 1) controller.invalidate();
      return gateStatus(boot, true);
    });
    controller = createRuntimeGateController({ inspect, watcherHealthy: true });

    await expect(controller.checkMutation(test.boot)).resolves.toMatchObject({
      allowed: true,
      restartRequired: false,
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(controller.getMetrics()).toMatchObject({
      mutationChecks: 1,
      mutationEpochRetries: 1,
      mutationUnstableFailures: 0,
      invalidations: 1,
    });
  });

  it("mutation 核验持续遇到失效时有界重试后失败关闭，不放行过期允许结果", async () => {
    const test = await fixture();
    let controller!: ReturnType<typeof createRuntimeGateController>;
    const inspect = vi.fn(async (boot: RuntimeBootIdentity) => {
      // 每次核验期间都发生源码失效；单次核验结果虽为 allowed，也不得被放行。
      controller.invalidate();
      return gateStatus(boot, true);
    });
    controller = createRuntimeGateController({
      inspect,
      watcherHealthy: true,
      mutationMaxAttempts: 3,
    });

    const status = await controller.checkMutation(test.boot);
    expect(status.allowed).toBe(false);
    expect(status.restartRequired).toBe(true);
    expect(status.reasons).toContain("mutation-currentness-unstable");
    expect(status.error).toContain("无法取得稳定结果");
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(controller.getMetrics()).toMatchObject({
      mutationChecks: 1,
      mutationEpochRetries: 2,
      mutationUnstableFailures: 1,
    });

    await expect(controller.assertMutationCurrent(test.boot, "canvas:write-probe"))
      .rejects.toMatchObject({
        code: "runtime-restart-required",
        status: { reasons: expect.arrayContaining(["mutation-currentness-unstable"]) },
      });
  });

  it("探针累计真实核验总/最大耗时", async () => {
    const test = await fixture();
    let clock = 10;
    const inspect = vi.fn(async (boot: RuntimeBootIdentity) => {
      clock += inspect.mock.calls.length === 1 ? 7 : 11;
      return gateStatus(boot, true);
    });
    const controller = createRuntimeGateController({
      inspect,
      now: () => clock,
      watcherHealthy: false,
    });

    await controller.checkRead(test.boot);
    await controller.checkMutation(test.boot);
    expect(controller.getMetrics()).toMatchObject({
      digestCalls: 2,
      inspectionCalls: 2,
      totalInspectionDurationMs: 18,
      maxInspectionDurationMs: 11,
    });
  });

  it("拒绝非正有限 read TTL", () => {
    expect(() => createRuntimeGateController({ readTtlMs: 0 })).toThrow(/TTL/u);
    expect(() => createRuntimeGateController({ readTtlMs: Number.POSITIVE_INFINITY })).toThrow(/TTL/u);
  });
});
