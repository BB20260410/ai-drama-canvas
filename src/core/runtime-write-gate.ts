import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { computeSourceDigest } from "./build-identity.js";

type ComputeSourceDigest = typeof computeSourceDigest;

export interface RuntimeWriteGateInspectionDependencies {
  /**
   * 仅供确定性测试替换源码摘要计算；正式运行始终使用 build-identity 的真实实现。
   */
  computeSourceDigest?: ComputeSourceDigest;
}

export interface RuntimeBootIdentity {
  schemaVersion: 1;
  kind: "runtime-boot-identity";
  runtimeBootId: string;
  pid: number;
  startedAt: string;
  workspace: string;
  loadedArtifactPath: string;
  loadedArtifactSha256: string;
  /** 构建时嵌入 main 工件的精确源码摘要。 */
  artifactSourceDigest: string;
  bootSourceDigest: string;
}

export interface RuntimeWriteGateStatus extends RuntimeBootIdentity {
  currentArtifactSha256?: string;
  currentSourceDigest?: string;
  allowed: boolean;
  restartRequired: boolean;
  checkedAt: string;
  reasons: Array<
    | "runtime-artifact-unavailable"
    | "runtime-artifact-changed"
    | "runtime-artifact-source-mismatch"
    | "source-unavailable"
    | "source-changed"
    | "mutation-currentness-unstable"
  >;
  error?: string;
}

export class RuntimeWriteGateError extends Error {
  readonly code = "runtime-restart-required" as const;
  readonly status: RuntimeWriteGateStatus;

  constructor(status: RuntimeWriteGateStatus, channel?: string) {
    const target = channel ? `（${channel}）` : "";
    super(`RUNTIME_RESTART_REQUIRED${target}：源码或运行工件已在本进程启动后变化；为保护正式工程，写入已拒绝。请重启源码无限画布后重试。`);
    this.name = "RuntimeWriteGateError";
    this.status = status;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function captureRuntimeBootIdentity(input: {
  workspace: string;
  loadedArtifactPath: string;
  startedAt?: string;
  pid?: number;
  runtimeBootId?: string;
  artifactSourceDigest?: string;
}): Promise<RuntimeBootIdentity> {
  const workspace = path.resolve(input.workspace);
  const loadedArtifactPath = path.resolve(input.loadedArtifactPath);
  const [artifactBytes, source] = await Promise.all([
    readFile(loadedArtifactPath),
    computeSourceDigest(workspace),
  ]);
  return {
    schemaVersion: 1,
    kind: "runtime-boot-identity",
    runtimeBootId: input.runtimeBootId ?? randomUUID(),
    pid: input.pid ?? process.pid,
    startedAt: input.startedAt ?? new Date().toISOString(),
    workspace,
    loadedArtifactPath,
    loadedArtifactSha256: sha256(artifactBytes),
    artifactSourceDigest: input.artifactSourceDigest ?? source.sourceDigest,
    bootSourceDigest: source.sourceDigest,
  };
}

export async function inspectRuntimeWriteGate(
  boot: RuntimeBootIdentity,
  dependencies: RuntimeWriteGateInspectionDependencies = {},
): Promise<RuntimeWriteGateStatus> {
  const computeCurrentSourceDigest = dependencies.computeSourceDigest ?? computeSourceDigest;
  const reasons: RuntimeWriteGateStatus["reasons"] = [];
  let currentArtifactSha256: string | undefined;
  let currentSourceDigest: string | undefined;
  const errors: string[] = [];
  if (boot.artifactSourceDigest !== boot.bootSourceDigest) {
    reasons.push("runtime-artifact-source-mismatch");
  }
  try {
    currentArtifactSha256 = sha256(await readFile(boot.loadedArtifactPath));
    if (currentArtifactSha256 !== boot.loadedArtifactSha256) reasons.push("runtime-artifact-changed");
  } catch (error) {
    reasons.push("runtime-artifact-unavailable");
    errors.push(errorText(error));
  }
  try {
    currentSourceDigest = (await computeCurrentSourceDigest(boot.workspace)).sourceDigest;
    if (currentSourceDigest !== boot.bootSourceDigest) reasons.push("source-changed");
  } catch (error) {
    reasons.push("source-unavailable");
    errors.push(errorText(error));
  }
  return {
    ...boot,
    currentArtifactSha256,
    currentSourceDigest,
    allowed: reasons.length === 0,
    restartRequired: reasons.length > 0,
    checkedAt: new Date().toISOString(),
    reasons,
    ...(errors.length ? { error: errors.join(" | ") } : {}),
  };
}

export type RuntimeWriteGateInspector = (
  boot: RuntimeBootIdentity,
) => Promise<RuntimeWriteGateStatus>;

export interface RuntimeGateControllerMetrics {
  /** 每次真实门禁核验都会尝试一次源码 digest；注入 inspector 的测试亦按一次尝试计。 */
  digestCalls: number;
  inspectionCalls: number;
  readChecks: number;
  readCacheHits: number;
  readCacheMisses: number;
  readSingleflightJoins: number;
  mutationChecks: number;
  mutationSingleflightJoins: number;
  /** mutation 核验期间 epoch 失效导致的重验次数。 */
  mutationEpochRetries: number;
  /** 有界重验仍无法取得稳定结果、被失败关闭的次数。 */
  mutationUnstableFailures: number;
  invalidations: number;
  watcherHealthy: boolean;
  invalidationEpoch: number;
  totalInspectionDurationMs: number;
  maxInspectionDurationMs: number;
}

export interface RuntimeGateController {
  /**
   * 只读/诊断核验：只有 watcher 已 ready 且健康时才复用短 TTL 结果。
   * 返回 denied 状态而不抛错，供诊断接口展示失败原因。
   */
  checkRead(boot: RuntimeBootIdentity): Promise<RuntimeWriteGateStatus>;
  checkDiagnostic(boot: RuntimeBootIdentity): Promise<RuntimeWriteGateStatus>;
  /** 只读业务入口需要失败关闭时使用。 */
  assertReadCurrent(boot: RuntimeBootIdentity, channel?: string): Promise<RuntimeWriteGateStatus>;
  /**
   * 写入口强核验：不读取 read cache，也不加入 read in-flight；
   * 只合并同一 boot identity 的并发写批次，结算后立即失效。
   * 核验全程绑定 invalidation epoch：期间 epoch 变化即重验，
   * 有界重试仍不稳定时失败关闭。
   */
  checkMutation(boot: RuntimeBootIdentity): Promise<RuntimeWriteGateStatus>;
  assertMutationCurrent(boot: RuntimeBootIdentity, channel?: string): Promise<RuntimeWriteGateStatus>;
  /** 源码/工件 add/change/unlink 时调用；核验期间失效的结果不会进入缓存。 */
  invalidate(): void;
  /** watcher 未 ready 或发生 error 时传 false，退化为每批真实重算。 */
  setWatcherHealthy(healthy: boolean): void;
  getMetrics(): RuntimeGateControllerMetrics;
}

export interface RuntimeGateControllerOptions {
  inspect?: RuntimeWriteGateInspector;
  readTtlMs?: number;
  now?: () => number;
  /** 默认 false；调用方必须在 watcher ready 后显式开启缓存。 */
  watcherHealthy?: boolean;
  /** mutation 核验遇到 epoch 失效时的最大总尝试次数；超限失败关闭。 */
  mutationMaxAttempts?: number;
}

export const DEFAULT_RUNTIME_READ_GATE_TTL_MS = 2_000;
export const DEFAULT_MUTATION_CURRENTNESS_MAX_ATTEMPTS = 3;

/**
 * 源码运行态门禁控制器。
 *
 * read cache 只是物理只读入口的性能层；任何可能初始化 schema、派生媒体、改写
 * watcher/活动状态或落盘的入口都必须调用 mutation 路径。未知 IPC 默认 mutation
 * 的副作用分类由 runtime-ipc-effect owner 负责。
 */
export function createRuntimeGateController(
  options: RuntimeGateControllerOptions = {},
): RuntimeGateController {
  const inspect = options.inspect ?? inspectRuntimeWriteGate;
  const now = options.now ?? (() => Date.now());
  const readTtlMs = options.readTtlMs ?? DEFAULT_RUNTIME_READ_GATE_TTL_MS;
  if (!Number.isFinite(readTtlMs) || readTtlMs <= 0) {
    throw new RangeError("runtime read gate TTL 必须是正有限数。");
  }
  const mutationMaxAttempts = options.mutationMaxAttempts ?? DEFAULT_MUTATION_CURRENTNESS_MAX_ATTEMPTS;
  if (!Number.isInteger(mutationMaxAttempts) || mutationMaxAttempts <= 0) {
    throw new RangeError("mutation currentness 最大尝试次数必须是正整数。");
  }

  type ReadCacheEntry = {
    status: RuntimeWriteGateStatus;
    expiresAt: number;
    epoch: number;
  };
  type InFlightEntry = {
    epoch: number;
    promise: Promise<RuntimeWriteGateStatus>;
  };

  let readCache = new WeakMap<RuntimeBootIdentity, ReadCacheEntry>();
  let readInFlight = new WeakMap<RuntimeBootIdentity, InFlightEntry>();
  const mutationInFlight = new WeakMap<RuntimeBootIdentity, Promise<RuntimeWriteGateStatus>>();
  let watcherHealthy = options.watcherHealthy === true;
  let invalidationEpoch = 0;
  const metrics = {
    digestCalls: 0,
    inspectionCalls: 0,
    readChecks: 0,
    readCacheHits: 0,
    readCacheMisses: 0,
    readSingleflightJoins: 0,
    mutationChecks: 0,
    mutationSingleflightJoins: 0,
    mutationEpochRetries: 0,
    mutationUnstableFailures: 0,
    invalidations: 0,
    totalInspectionDurationMs: 0,
    maxInspectionDurationMs: 0,
  };

  const runInspection = async (boot: RuntimeBootIdentity): Promise<RuntimeWriteGateStatus> => {
    const startedAt = now();
    metrics.inspectionCalls += 1;
    // 正式 inspector 每次固定尝试一次 computeSourceDigest；这里统计的是门禁层尝试数。
    metrics.digestCalls += 1;
    try {
      return await inspect(boot);
    } finally {
      const duration = Math.max(0, now() - startedAt);
      metrics.totalInspectionDurationMs += duration;
      metrics.maxInspectionDurationMs = Math.max(metrics.maxInspectionDurationMs, duration);
    }
  };

  const invalidate = (): void => {
    invalidationEpoch += 1;
    metrics.invalidations += 1;
    // WeakMap 无 clear；整体替换也确保新读取不会加入失效 epoch 的在途核验。
    readCache = new WeakMap();
    readInFlight = new WeakMap();
  };

  const checkRead = async (boot: RuntimeBootIdentity): Promise<RuntimeWriteGateStatus> => {
    metrics.readChecks += 1;
    const checkedAt = now();
    if (watcherHealthy) {
      const cached = readCache.get(boot);
      if (cached && cached.epoch === invalidationEpoch && cached.expiresAt > checkedAt) {
        metrics.readCacheHits += 1;
        return cached.status;
      }
    }
    metrics.readCacheMisses += 1;

    const epochAtStart = invalidationEpoch;
    const existing = readInFlight.get(boot);
    if (existing && existing.epoch === epochAtStart) {
      metrics.readSingleflightJoins += 1;
      return existing.promise;
    }

    const pending = runInspection(boot);
    readInFlight.set(boot, { epoch: epochAtStart, promise: pending });
    try {
      const status = await pending;
      // watcher error/unready、TTL 期间的源码事件或显式 invalidate 都禁止落缓存。
      if (watcherHealthy && invalidationEpoch === epochAtStart) {
        readCache.set(boot, {
          status,
          expiresAt: now() + readTtlMs,
          epoch: epochAtStart,
        });
      }
      return status;
    } finally {
      const current = readInFlight.get(boot);
      if (current?.promise === pending) readInFlight.delete(boot);
    }
  };

  // mutation 核验绑定 invalidation epoch：核验期间 watcher 失效说明结果可能基于
  // 已过期或撕裂的源码状态，必须重验直到某次核验全程 epoch 稳定；有界重试仍不
  // 稳定时失败关闭，绝不放行一个"刚完成但已过期"的允许结果。
  const runMutationInspectionToStability = async (
    boot: RuntimeBootIdentity,
  ): Promise<RuntimeWriteGateStatus> => {
    let lastStatus: RuntimeWriteGateStatus | undefined;
    for (let attempt = 1; attempt <= mutationMaxAttempts; attempt += 1) {
      const epochAtStart = invalidationEpoch;
      lastStatus = await runInspection(boot);
      if (invalidationEpoch === epochAtStart) return lastStatus;
      if (attempt < mutationMaxAttempts) metrics.mutationEpochRetries += 1;
    }
    metrics.mutationUnstableFailures += 1;
    const baseReasons = lastStatus?.reasons ?? [];
    return {
      ...(lastStatus ?? boot),
      allowed: false,
      restartRequired: true,
      checkedAt: new Date().toISOString(),
      reasons: [...baseReasons, "mutation-currentness-unstable"],
      error: [
        lastStatus?.error,
        `mutation currentness 在 ${mutationMaxAttempts} 次核验中持续遇到源码失效，无法取得稳定结果。`,
      ].filter((part): part is string => Boolean(part)).join(" | "),
    };
  };

  const checkMutation = async (boot: RuntimeBootIdentity): Promise<RuntimeWriteGateStatus> => {
    metrics.mutationChecks += 1;
    const existing = mutationInFlight.get(boot);
    if (existing) {
      metrics.mutationSingleflightJoins += 1;
      return existing;
    }
    const pending = runMutationInspectionToStability(boot);
    mutationInFlight.set(boot, pending);
    try {
      return await pending;
    } finally {
      if (mutationInFlight.get(boot) === pending) mutationInFlight.delete(boot);
    }
  };

  const assertAllowed = async (
    statusPromise: Promise<RuntimeWriteGateStatus>,
    channel?: string,
  ): Promise<RuntimeWriteGateStatus> => {
    const status = await statusPromise;
    if (!status.allowed) throw new RuntimeWriteGateError(status, channel);
    return status;
  };

  return {
    checkRead,
    checkDiagnostic: checkRead,
    assertReadCurrent: (boot, channel) => assertAllowed(checkRead(boot), channel),
    checkMutation,
    assertMutationCurrent: (boot, channel) => assertAllowed(checkMutation(boot), channel),
    invalidate,
    setWatcherHealthy(healthy) {
      if (watcherHealthy === healthy) return;
      watcherHealthy = healthy;
      // ready/error 状态切换也切断旧 epoch，避免健康前的结果在健康后被复用。
      invalidate();
    },
    getMetrics: () => ({
      ...metrics,
      watcherHealthy,
      invalidationEpoch,
    }),
  };
}

/**
 * 只合并同一 boot identity 的“在途”门禁核验。
 *
 * Promise 一旦结算立即移除，下一次（尤其下一条写命令）仍会重新读取工件并计算
 * 源码摘要；这里没有 TTL，也不会把一次通过结果长期缓存为写权限。
 */
export function createRuntimeWriteGateSingleFlight(
  inspect: RuntimeWriteGateInspector = inspectRuntimeWriteGate,
): RuntimeWriteGateInspector {
  const inFlight = new WeakMap<RuntimeBootIdentity, Promise<RuntimeWriteGateStatus>>();
  return async (boot) => {
    const existing = inFlight.get(boot);
    if (existing) return existing;
    const pending = Promise.resolve().then(() => inspect(boot));
    inFlight.set(boot, pending);
    try {
      return await pending;
    } finally {
      if (inFlight.get(boot) === pending) inFlight.delete(boot);
    }
  };
}

const inspectRuntimeWriteGateSingleFlight = createRuntimeWriteGateSingleFlight();

export async function assertRuntimeWriteGateCurrent(
  boot: RuntimeBootIdentity,
  channel?: string,
): Promise<RuntimeWriteGateStatus> {
  const status = await inspectRuntimeWriteGateSingleFlight(boot);
  if (!status.allowed) throw new RuntimeWriteGateError(status, channel);
  return status;
}
