import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { withFileLock } from "./locks.js";

export type MediaTool = "ffmpeg" | "ffprobe" | "utility";
export type MediaProcessStatus = "succeeded" | "failed" | "cancelled" | "timed_out";

export const MEDIA_WEIGHTS = {
  probe: 1,
  foreground: 2,
  render: 3,
} as const;

interface MediaQueueEntry {
  id: string;
  ownerPid: number;
  ownerInstanceId: string;
  projectKey?: string;
  tool: MediaTool;
  stage: string;
  weight: number;
  enqueuedAt: string;
}

interface MediaLeaseRecord extends MediaQueueEntry {
  acquiredAt: string;
  heartbeatAt: string;
  childPid?: number;
  processGroupId?: number;
  timeoutAt?: string;
}

export interface MediaTerminalRecord {
  leaseId: string;
  projectKey?: string;
  tool: MediaTool;
  stage: string;
  weight: number;
  status: MediaProcessStatus;
  code: number;
  signal?: NodeJS.Signals;
  waitMs: number;
  durationMs: number;
  completedAt: string;
}

interface MediaRuntimeMetrics {
  granted: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  acquisitionTimeouts: number;
  orphanedLeasesReaped: number;
  orphanedQueueEntriesReaped: number;
  maxObservedWeight: number;
  totalWaitMs: number;
}

interface MediaRuntimeState {
  schemaVersion: 1;
  revision: number;
  capacity: number;
  queue: MediaQueueEntry[];
  leases: MediaLeaseRecord[];
  metrics: MediaRuntimeMetrics;
  recentTerminals: MediaTerminalRecord[];
  updatedAt: string;
}

export interface MachineMediaRuntimeSnapshot {
  schemaVersion: 1;
  runtimeDirectory: string;
  capacity: number;
  activeWeight: number;
  availableWeight: number;
  queueDepth: number;
  active: Array<Pick<MediaLeaseRecord, "id" | "ownerPid" | "projectKey" | "tool" | "stage" | "weight" | "acquiredAt" | "heartbeatAt" | "childPid" | "processGroupId" | "timeoutAt"> & { ownerAlive: boolean }>;
  queued: Array<Pick<MediaQueueEntry, "id" | "ownerPid" | "projectKey" | "tool" | "stage" | "weight" | "enqueuedAt"> & { ownerAlive: boolean }>;
  metrics: MediaRuntimeMetrics;
  recentTerminals: MediaTerminalRecord[];
  updatedAt: string;
}

export interface ManagedMediaProcessResult {
  status: MediaProcessStatus;
  code: number;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  output: string;
  waitMs: number;
  durationMs: number;
  leaseId: string;
  pid?: number;
  processGroupId?: number;
  error?: string;
}

export interface ManagedMediaProcess {
  child: ChildProcessByStdio<null, Readable, Readable>;
  leaseId: string;
  waitMs: number;
  completion: Promise<ManagedMediaProcessResult>;
  cancel: () => Promise<void>;
}

export interface MediaProcessOptions {
  projectRoot?: string;
  tool: MediaTool;
  stage: string;
  weight: number;
  timeoutMs: number;
  acquireTimeoutMs?: number;
  terminationGraceMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

interface MediaLeaseHandle {
  id: string;
  waitMs: number;
  bindProcess: (pid: number, processGroupId: number | undefined, timeoutAt: string) => Promise<void>;
  release: (terminal?: Omit<MediaTerminalRecord, "leaseId" | "projectKey" | "tool" | "stage" | "weight" | "waitMs" | "completedAt">) => Promise<void>;
}

const PROCESS_INSTANCE_ID = randomUUID();
const DEFAULT_CAPACITY = 4;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1_024;
const HEARTBEAT_INTERVAL_MS = 2_000;
const STATE_FILE_NAME = "state.json";
const STATE_LOCK_NAME = "media-runtime-state";
const MAX_LOCAL_MUTATIONS_PER_LOCK = 64;

interface LocalStateMutation {
  runtimeDirectory: string;
  capacity: number;
  work: (state: MediaRuntimeState) => Promise<unknown> | unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const localMutationQueue: LocalStateMutation[] = [];
let localMutationDrain: Promise<void> | undefined;

function positiveInteger(value: string | undefined, fallback: number, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function getMachineMediaRuntimeConfig() {
  return {
    runtimeDirectory: path.resolve(process.env.AI_CANVAS_MEDIA_RUNTIME_DIR || path.join(os.homedir(), ".aicanvas", "runtime", "media-v1")),
    capacity: positiveInteger(process.env.AI_CANVAS_MEDIA_CAPACITY, DEFAULT_CAPACITY, 1, 64),
    acquireTimeoutMs: positiveInteger(process.env.AI_CANVAS_MEDIA_ACQUIRE_TIMEOUT_MS, DEFAULT_ACQUIRE_TIMEOUT_MS, 250),
    terminationGraceMs: positiveInteger(process.env.AI_CANVAS_MEDIA_TERMINATION_GRACE_MS, DEFAULT_TERMINATION_GRACE_MS, 50, 30_000),
    maxOutputBytes: positiveInteger(process.env.AI_CANVAS_MEDIA_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES, 1_024, 4 * 1_024 * 1_024),
  };
}

export function mediaStageTimeout(tool: "ffmpeg" | "ffprobe", fallbackMs?: number): number {
  const fallback = fallbackMs ?? (tool === "ffprobe" ? 30_000 : 10 * 60_000);
  return positiveInteger(tool === "ffprobe" ? process.env.AI_CANVAS_FFPROBE_TIMEOUT_MS : process.env.AI_CANVAS_FFMPEG_TIMEOUT_MS, fallback, 100, 24 * 60 * 60_000);
}

export function projectMediaKey(projectRoot: string | undefined): string | undefined {
  if (!projectRoot) return undefined;
  return createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 20);
}

function emptyMetrics(): MediaRuntimeMetrics {
  return {
    granted: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    acquisitionTimeouts: 0,
    orphanedLeasesReaped: 0,
    orphanedQueueEntriesReaped: 0,
    maxObservedWeight: 0,
    totalWaitMs: 0,
  };
}

function emptyState(capacity: number): MediaRuntimeState {
  return { schemaVersion: 1, revision: 0, capacity, queue: [], leases: [], metrics: emptyMetrics(), recentTerminals: [], updatedAt: new Date(0).toISOString() };
}

function validEntry(value: unknown): value is MediaQueueEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<MediaQueueEntry>;
  return typeof entry.id === "string" && Number.isInteger(entry.ownerPid) && (entry.ownerPid ?? 0) > 0
    && typeof entry.ownerInstanceId === "string" && ["ffmpeg", "ffprobe", "utility"].includes(entry.tool ?? "") && typeof entry.stage === "string"
    && Number.isInteger(entry.weight) && (entry.weight ?? 0) > 0 && typeof entry.enqueuedAt === "string";
}

function parseState(value: unknown, filePath: string): MediaRuntimeState {
  if (!value || typeof value !== "object") throw new Error(`机器媒体运行时状态损坏，已拒绝启动新媒体任务：${filePath}`);
  const state = value as Partial<MediaRuntimeState>;
  const metricKeys: Array<keyof MediaRuntimeMetrics> = ["granted", "succeeded", "failed", "cancelled", "timedOut", "acquisitionTimeouts", "orphanedLeasesReaped", "orphanedQueueEntriesReaped", "maxObservedWeight", "totalWaitMs"];
  const metricsValid = Boolean(state.metrics && typeof state.metrics === "object" && metricKeys.every((key) => Number.isFinite(state.metrics?.[key]) && (state.metrics?.[key] ?? -1) >= 0));
  const terminalsValid = Array.isArray(state.recentTerminals) && state.recentTerminals.every((entry) => Boolean(entry) && typeof entry === "object"
    && typeof entry.leaseId === "string" && ["ffmpeg", "ffprobe", "utility"].includes(entry.tool)
    && ["succeeded", "failed", "cancelled", "timed_out"].includes(entry.status) && Number.isFinite(entry.durationMs));
  if (state.schemaVersion !== 1 || !Number.isInteger(state.revision) || !Number.isInteger(state.capacity) || (state.capacity ?? 0) <= 0
    || !Array.isArray(state.queue) || !state.queue.every(validEntry) || !Array.isArray(state.leases)
    || !state.leases.every((entry) => validEntry(entry) && typeof (entry as MediaLeaseRecord).acquiredAt === "string" && typeof (entry as MediaLeaseRecord).heartbeatAt === "string")
    || !metricsValid || !terminalsValid || typeof state.updatedAt !== "string") {
    throw new Error(`机器媒体运行时状态损坏，已拒绝启动新媒体任务：${filePath}`);
  }
  return state as MediaRuntimeState;
}

async function readState(runtimeDirectory: string, capacity: number): Promise<MediaRuntimeState> {
  const filePath = path.join(runtimeDirectory, STATE_FILE_NAME);
  try { return parseState(JSON.parse(await readFile(filePath, "utf8")) as unknown, filePath); }
  catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return emptyState(capacity);
    if (error instanceof SyntaxError) throw new Error(`机器媒体运行时状态损坏，已拒绝启动新媒体任务：${filePath}`);
    throw error;
  }
}

async function writeState(runtimeDirectory: string, state: MediaRuntimeState): Promise<void> {
  await mkdir(runtimeDirectory, { recursive: true });
  const filePath = path.join(runtimeDirectory, STATE_FILE_NAME);
  const temporary = path.join(runtimeDirectory, `${STATE_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  state.revision += 1;
  state.updatedAt = new Date().toISOString();
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return Boolean(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM"); }
}

function processGroupAlive(processGroupId: number): boolean {
  if (process.platform === "win32") return processAlive(processGroupId);
  try { process.kill(-processGroupId, 0); return true; }
  catch (error) { return Boolean(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM"); }
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try { process.kill(-pid, signal); return; }
    catch { /* 进程可能未成为组长，回退到单 PID。 */ }
  }
  if (!processAlive(pid)) return;
  try { process.kill(pid, signal); } catch { /* 已退出。 */ }
}

function reapDeadOwners(state: MediaRuntimeState): void {
  const liveQueue = state.queue.filter((entry) => processAlive(entry.ownerPid));
  state.metrics.orphanedQueueEntriesReaped += state.queue.length - liveQueue.length;
  state.queue = liveQueue;
  const liveLeases: MediaLeaseRecord[] = [];
  for (const lease of state.leases) {
    if (processAlive(lease.ownerPid)) {
      liveLeases.push(lease);
      continue;
    }
    if (lease.processGroupId || lease.childPid) signalProcessTree(lease.processGroupId ?? lease.childPid!, "SIGKILL");
    state.metrics.orphanedLeasesReaped += 1;
    state.metrics.failed += 1;
    state.recentTerminals.unshift({
      leaseId: lease.id,
      projectKey: lease.projectKey,
      tool: lease.tool,
      stage: lease.stage,
      weight: lease.weight,
      status: "failed",
      code: -1,
      signal: "SIGKILL",
      waitMs: Math.max(0, Date.parse(lease.acquiredAt) - Date.parse(lease.enqueuedAt)),
      durationMs: Math.max(0, Date.now() - Date.parse(lease.acquiredAt)),
      completedAt: new Date().toISOString(),
    });
  }
  state.leases = liveLeases;
  state.recentTerminals = state.recentTerminals.slice(0, 50);
}

async function drainLocalMutations(): Promise<void> {
  while (localMutationQueue.length) {
    const first = localMutationQueue[0]!;
    const batch: LocalStateMutation[] = [];
    while (batch.length < MAX_LOCAL_MUTATIONS_PER_LOCK && localMutationQueue.length) {
      const candidate = localMutationQueue[0]!;
      if (candidate.runtimeDirectory !== first.runtimeDirectory || candidate.capacity !== first.capacity) break;
      batch.push(localMutationQueue.shift()!);
    }
    const outcomes: Array<{ mutation: LocalStateMutation; value?: unknown; error?: unknown }> = [];
    try {
      await withFileLock(first.runtimeDirectory, STATE_LOCK_NAME, async () => {
        let state = await readState(first.runtimeDirectory, first.capacity);
        for (const mutation of batch) {
          try {
            reapDeadOwners(state);
            if (!state.queue.length && !state.leases.length) state.capacity = mutation.capacity;
            const value = await mutation.work(state);
            await writeState(first.runtimeDirectory, state);
            outcomes.push({ mutation, value });
          } catch (error) {
            outcomes.push({ mutation, error });
            // work 可能在抛错前改动内存对象；重新读取上一个已原子落盘的状态，
            // 保证后续本地请求不会继承未提交的半状态。
            state = await readState(first.runtimeDirectory, first.capacity);
          }
        }
      }, { timeoutMs: 30_000, staleMs: 120_000 });
      for (const outcome of outcomes) {
        if ("error" in outcome) outcome.mutation.reject(outcome.error);
        else outcome.mutation.resolve(outcome.value);
      }
    } catch (error) {
      for (const mutation of batch) mutation.reject(error);
    }
  }
}

function ensureLocalMutationDrain(): void {
  if (localMutationDrain) return;
  localMutationDrain = drainLocalMutations().finally(() => {
    localMutationDrain = undefined;
    // 恰好在 drain 退出与 finally 之间入队的请求需要重新启动。
    if (localMutationQueue.length) ensureLocalMutationDrain();
  });
}

async function mutateState<T>(work: (state: MediaRuntimeState) => Promise<T> | T): Promise<T> {
  const config = getMachineMediaRuntimeConfig();
  return new Promise<T>((resolve, reject) => {
    localMutationQueue.push({
      runtimeDirectory: config.runtimeDirectory,
      capacity: config.capacity,
      work,
      resolve: (value) => resolve(value as T),
      reject,
    });
    ensureLocalMutationDrain();
  });
}

function abortError(message = "媒体任务已取消。 "): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function waitForTurn(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(abortError()); };
    function done() { signal?.removeEventListener("abort", onAbort); resolve(); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function removeQueuedRequest(requestId: string, metric?: "acquisitionTimeouts"): Promise<void> {
  await mutateState((state) => {
    state.queue = state.queue.filter((entry) => entry.id !== requestId);
    if (metric) state.metrics[metric] += 1;
  }).catch(() => undefined);
}

export async function acquireMachineMediaLease(input: Pick<MediaProcessOptions, "projectRoot" | "tool" | "stage" | "weight" | "signal" | "acquireTimeoutMs">): Promise<MediaLeaseHandle> {
  const config = getMachineMediaRuntimeConfig();
  if (!Number.isInteger(input.weight) || input.weight <= 0 || input.weight > config.capacity) {
    throw new Error(`媒体任务权重必须是 1–${config.capacity} 的整数。`);
  }
  if (input.signal?.aborted) throw abortError();
  const request: MediaQueueEntry = {
    id: `media-${randomUUID()}`,
    ownerPid: process.pid,
    ownerInstanceId: PROCESS_INSTANCE_ID,
    projectKey: projectMediaKey(input.projectRoot),
    tool: input.tool,
    stage: input.stage,
    weight: input.weight,
    enqueuedAt: new Date().toISOString(),
  };
  const started = Date.now();
  const acquireTimeoutMs = Math.max(250, input.acquireTimeoutMs ?? config.acquireTimeoutMs);
  let registered = false;
  let granted: MediaLeaseRecord | undefined;
  try {
    while (!granted) {
      granted = await mutateState((state) => {
        if (!registered) {
          if (input.weight > state.capacity) throw new Error(`媒体任务权重 ${input.weight} 超过当前机器容量 ${state.capacity}。`);
          state.queue.push(request);
          registered = true;
        }
        const position = state.queue.findIndex((entry) => entry.id === request.id);
        if (position < 0) throw new Error("机器媒体容量请求意外丢失，已停止任务。 ");
        const activeWeight = state.leases.reduce((sum, entry) => sum + entry.weight, 0);
        // 严格 FIFO：只有队首可先取得容量。队首取得后，后续较轻任务可在下一轮
        // 使用剩余容量，但不能越过一个已等待的重任务造成永久饥饿。
        if (position !== 0 || activeWeight + request.weight > state.capacity) return undefined;
        state.queue.splice(position, 1);
        const now = new Date().toISOString();
        const lease: MediaLeaseRecord = { ...request, acquiredAt: now, heartbeatAt: now };
        state.leases.push(lease);
        const waitMs = Date.now() - started;
        state.metrics.granted += 1;
        state.metrics.totalWaitMs += waitMs;
        state.metrics.maxObservedWeight = Math.max(state.metrics.maxObservedWeight, activeWeight + request.weight);
        return lease;
      });
      if (granted) break;
      if (Date.now() - started >= acquireTimeoutMs) {
        await removeQueuedRequest(request.id, "acquisitionTimeouts");
        registered = false;
        throw new Error(`机器媒体容量等待超过 ${acquireTimeoutMs}ms（阶段 ${input.stage}，权重 ${input.weight}/${config.capacity}）。`);
      }
      await waitForTurn(40 + Math.floor(Math.random() * 30), input.signal);
    }
  } catch (error) {
    if (registered && !granted) await removeQueuedRequest(request.id);
    throw error;
  }

  let released = false;
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (released || heartbeatBusy) return;
    heartbeatBusy = true;
    void mutateState((state) => {
      const lease = state.leases.find((entry) => entry.id === request.id && entry.ownerInstanceId === PROCESS_INSTANCE_ID);
      if (lease) lease.heartbeatAt = new Date().toISOString();
    }).catch(() => undefined).finally(() => { heartbeatBusy = false; });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  return {
    id: request.id,
    waitMs: Date.now() - started,
    bindProcess: async (pid, processGroupId, timeoutAt) => {
      await mutateState((state) => {
        const lease = state.leases.find((entry) => entry.id === request.id && entry.ownerInstanceId === PROCESS_INSTANCE_ID);
        if (!lease) throw new Error("机器媒体租约已丢失，拒绝留下未受控子进程。 ");
        lease.childPid = pid;
        lease.processGroupId = processGroupId;
        lease.timeoutAt = timeoutAt;
        lease.heartbeatAt = new Date().toISOString();
      });
    },
    release: async (terminal) => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      await mutateState((state) => {
        const lease = state.leases.find((entry) => entry.id === request.id);
        state.leases = state.leases.filter((entry) => entry.id !== request.id);
        if (!terminal) return;
        state.metrics[terminal.status === "timed_out" ? "timedOut" : terminal.status] += 1;
        state.recentTerminals.unshift({
          leaseId: request.id,
          projectKey: lease?.projectKey ?? request.projectKey,
          tool: request.tool,
          stage: request.stage,
          weight: request.weight,
          status: terminal.status,
          code: terminal.code,
          signal: terminal.signal,
          waitMs: Date.now() - started - terminal.durationMs,
          durationMs: terminal.durationMs,
          completedAt: new Date().toISOString(),
        });
        state.recentTerminals = state.recentTerminals.slice(0, 50);
      });
    },
  };
}

export async function terminateProcessTree(pid: number, graceMs = getMachineMediaRuntimeConfig().terminationGraceMs): Promise<void> {
  const targetAlive = () => process.platform === "win32" ? processAlive(pid) : processGroupAlive(pid);
  if (!targetAlive()) return;
  signalProcessTree(pid, "SIGTERM");
  const deadline = Date.now() + Math.max(50, graceMs);
  while (targetAlive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 40));
  if (targetAlive()) signalProcessTree(pid, "SIGKILL");
}

function appendTail(current: string, chunk: Buffer, limit: number): string {
  const next = current + chunk.toString("utf8");
  return Buffer.byteLength(next, "utf8") <= limit ? next : Buffer.from(next, "utf8").subarray(-limit).toString("utf8");
}

export async function startManagedMediaProcess(command: string, args: string[], options: MediaProcessOptions): Promise<ManagedMediaProcess> {
  const config = getMachineMediaRuntimeConfig();
  const timeoutMs = Math.max(100, options.timeoutMs);
  const lease = await acquireMachineMediaLease(options);
  const started = Date.now();
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    await lease.release({ status: "failed", code: -1, durationMs: Date.now() - started });
    throw error;
  }
  const processGroupId = process.platform === "win32" ? undefined : child.pid;
  // 必须在等待跨进程状态落盘之前就安装 close 监听。ffprobe 可能在数毫秒内
  // 退出；先 await bindProcess 会错过 close 事件，造成租约永不释放和全机队列堵塞。
  const bindPromise = child.pid
    ? lease.bindProcess(child.pid, processGroupId, new Date(started + timeoutMs).toISOString())
    : Promise.resolve();
  const maxOutputBytes = options.maxOutputBytes ?? config.maxOutputBytes;
  let stdout = "";
  let stderr = "";
  let output = "";
  let spawnError: string | undefined;
  let cancellation: "cancelled" | "timed_out" | undefined;
  let terminationPromise: Promise<void> | undefined;
  const cancel = async (reason: "cancelled" | "timed_out" = "cancelled") => {
    cancellation ??= reason;
    if (!child.pid) return;
    terminationPromise ??= terminateProcessTree(child.pid, options.terminationGraceMs ?? config.terminationGraceMs);
    await terminationPromise;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = appendTail(stdout, chunk, maxOutputBytes);
    output = appendTail(output, chunk, maxOutputBytes);
    options.onStdout?.(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendTail(stderr, chunk, maxOutputBytes);
    output = appendTail(output, chunk, maxOutputBytes);
    options.onStderr?.(chunk);
  });
  child.once("error", (error) => { spawnError = error.message; });
  const timeout = setTimeout(() => { void cancel("timed_out"); }, timeoutMs);
  timeout.unref();
  const onAbort = () => { void cancel("cancelled"); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) void cancel("cancelled");

  const completion = new Promise<ManagedMediaProcessResult>((resolve) => {
    child.once("close", (code, signal) => {
      void (async () => {
        await bindPromise;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        await terminationPromise?.catch(() => undefined);
        const durationMs = Date.now() - started;
        const status: MediaProcessStatus = cancellation ?? (code === 0 && !spawnError ? "succeeded" : "failed");
        const result: ManagedMediaProcessResult = {
          status,
          code: code ?? -1,
          signal: signal ?? undefined,
          stdout,
          stderr,
          output,
          waitMs: lease.waitMs,
          durationMs,
          leaseId: lease.id,
          pid: child.pid,
          processGroupId,
          error: spawnError,
        };
        await lease.release({ status, code: result.code, signal: result.signal, durationMs });
        resolve(result);
      })().catch(async (error) => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        await lease.release({ status: "failed", code: code ?? -1, signal: signal ?? undefined, durationMs: Date.now() - started }).catch(() => undefined);
        resolve({ status: "failed", code: code ?? -1, signal: signal ?? undefined, stdout, stderr, output, waitMs: lease.waitMs, durationMs: Date.now() - started, leaseId: lease.id, pid: child.pid, processGroupId, error: error instanceof Error ? error.message : String(error) });
      });
    });
  });
  try {
    await bindPromise;
  } catch (error) {
    if (child.pid) await terminateProcessTree(child.pid, 50);
    await completion;
    throw error;
  }
  return { child, leaseId: lease.id, waitMs: lease.waitMs, completion, cancel: () => cancel("cancelled") };
}

export async function runMediaProcess(command: string, args: string[], options: MediaProcessOptions): Promise<ManagedMediaProcessResult> {
  return (await startManagedMediaProcess(command, args, options)).completion;
}

function snapshotFromState(state: MediaRuntimeState, runtimeDirectory: string): MachineMediaRuntimeSnapshot {
  const activeWeight = state.leases.reduce((sum, entry) => sum + entry.weight, 0);
  return {
    schemaVersion: 1,
    runtimeDirectory,
    capacity: state.capacity,
    activeWeight,
    availableWeight: Math.max(0, state.capacity - activeWeight),
    queueDepth: state.queue.length,
    active: state.leases.map(({ ownerInstanceId: _ownerInstanceId, ...entry }) => ({ ...entry, ownerAlive: processAlive(entry.ownerPid) })),
    queued: state.queue.map(({ ownerInstanceId: _ownerInstanceId, ...entry }) => ({ ...entry, ownerAlive: processAlive(entry.ownerPid) })),
    metrics: { ...state.metrics },
    recentTerminals: structuredClone(state.recentTerminals),
    updatedAt: state.updatedAt,
  };
}

/** 只读快照：状态文件不存在时返回空状态，不创建目录、不抢写锁。 */
export async function readMachineMediaRuntimeSnapshot(): Promise<MachineMediaRuntimeSnapshot> {
  const config = getMachineMediaRuntimeConfig();
  const state = await readState(config.runtimeDirectory, config.capacity);
  return snapshotFromState(state, config.runtimeDirectory);
}

/** 显式回收死亡宿主遗留的排队项、租约和进程组。 */
export async function reapMachineMediaRuntime(): Promise<MachineMediaRuntimeSnapshot> {
  const config = getMachineMediaRuntimeConfig();
  return mutateState((state) => snapshotFromState(state, config.runtimeDirectory));
}

/** 仅供隔离测试/冒烟清理专用运行时目录，产品流程不得调用。 */
export async function removeMachineMediaRuntimeForTests(): Promise<void> {
  if (!process.env.AI_CANVAS_MEDIA_RUNTIME_DIR) throw new Error("拒绝清理默认机器媒体运行时目录。 ");
  await rm(getMachineMediaRuntimeConfig().runtimeDirectory, { recursive: true, force: true });
}
