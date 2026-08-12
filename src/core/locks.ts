import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { SIDECAR_DIR } from "./constants.js";
import {
  MANAGED_WRITER_FENCE_FILE,
  managedProjectRequiresWriterFence,
  managedV2LockDirectory,
} from "./managed-writer-fence.js";
import {
  ensureConfinedDirectory,
  inspectExistingConfinedDirectory,
  openExclusiveConfinedFile,
  readConfinedRegularFileWithIdentity,
  revalidateConfinedDirectory,
  unlinkOwnedConfinedFile,
  type ConfinedDirectoryIdentity,
  type ConfinedFileIdentity,
  type ConfinedRegularFileRead,
} from "./confined-project-storage.js";

export interface ProjectLockInfo {
  name: string;
  path: string;
  token?: string;
  pid?: number;
  createdAt?: string;
  ageMs: number;
  stale: boolean;
}

interface LockPayload {
  schemaVersion: 1;
  name: string;
  token: string;
  pid: number;
  createdAt: string;
}

interface LockObservation {
  payload: LockPayload;
  identity: ConfinedFileIdentity;
  mtimeMs: number;
  nlink: number;
}

interface OwnedLock {
  handle: FileHandle;
  identity: ConfinedFileIdentity;
  payload: LockPayload;
}

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  /** 指定后，lock 目录的每一级都必须位于该真实根内。 */
  confinementRoot?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STALE_MS = 120_000;
const DEAD_OWNER_GRACE_MS = 2_000;
const MALFORMED_LOCK_GRACE_MS = 10_000;
const MAX_LOCK_BYTES = 16 * 1024;

function safeLockName(name: string): string {
  const normalized = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  if (!normalized) throw new Error("项目锁名称不能为空。 ");
  return normalized;
}

function lockDirectory(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), SIDECAR_DIR, "locks");
}

async function projectLockDirectory(projectRoot: string): Promise<string> {
  const root = path.resolve(projectRoot);
  const legacyDirectory = lockDirectory(root);
  const sidecarPath = path.join(root, SIDECAR_DIR);
  try {
    const sidecarMetadata = await lstat(sidecarPath);
    if (sidecarMetadata.isSymbolicLink()) throw new Error("项目侧车目录禁止使用符号链接。");
    if (!sidecarMetadata.isDirectory()) throw new Error("项目侧车路径必须是目录。");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return legacyDirectory;
    throw error;
  }
  try {
    await inspectExistingConfinedDirectory(root, legacyDirectory);
    if (await managedProjectRequiresWriterFence(root)) {
      throw new Error("schema v2 项目的 writer fence 被目录替换，拒绝退回旧锁协议。");
    }
    return legacyDirectory;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      if (await managedProjectRequiresWriterFence(root)) {
        throw new Error("schema v2 项目缺少 writer fence，拒绝退回旧锁协议。");
      }
      return legacyDirectory;
    }
    if (error instanceof Error && error.message.includes("拒绝退回旧锁协议")) throw error;
  }

  // `.aicanvas/locks` 不是目录时只接受完整、与 schema v2 manifest 绑定的
  // writer fence。符号链接、特殊节点、损坏载荷和伪造 manifest 一律失败关闭。
  const metadata = await lstat(legacyDirectory);
  if (metadata.isSymbolicLink()) throw new Error("项目锁目录或 writer fence 禁止使用符号链接。");
  if (!metadata.isFile()) throw new Error("项目锁目录不是目录，且不是有效 writer fence 普通文件。");
  if (path.basename(legacyDirectory) !== MANAGED_WRITER_FENCE_FILE) {
    throw new Error("项目 writer fence 路径约定已漂移。");
  }
  return managedV2LockDirectory(root);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) === "EPERM"; }
}

function parseLockPayload(bytes: Buffer, expectedName?: string): LockPayload {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("项目锁 JSON 无法解码。", { cause: error });
  }
  const payload = value as Partial<LockPayload>;
  const createdAt = typeof payload.createdAt === "string" ? new Date(payload.createdAt) : null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || payload.schemaVersion !== 1
    || typeof payload.name !== "string" || !payload.name
    || typeof payload.token !== "string" || !payload.token
    || !Number.isInteger(payload.pid) || Number(payload.pid) <= 0
    || !createdAt || Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== payload.createdAt
    || (expectedName !== undefined && payload.name !== expectedName)) {
    throw new Error("项目锁载荷无效或与文件名不一致。");
  }
  return payload as LockPayload;
}

async function observeLock(
  directory: ConfinedDirectoryIdentity,
  fileName: string,
  expectedName?: string,
): Promise<LockObservation> {
  const read = await readConfinedRegularFileWithIdentity(directory, fileName, MAX_LOCK_BYTES);
  if (read.nlink !== 1) throw new Error("项目锁必须是单链接普通文件。");
  return {
    payload: parseLockPayload(read.bytes, expectedName),
    identity: read.identity,
    mtimeMs: read.mtimeMs,
    nlink: read.nlink,
  };
}

function sameObservation(left: LockObservation, right: LockObservation): boolean {
  return left.payload.token === right.payload.token
    && left.payload.pid === right.payload.pid
    && left.identity.dev === right.identity.dev
    && left.identity.ino === right.identity.ino
    && left.nlink === right.nlink;
}

function sameRawObservation(left: ConfinedRegularFileRead, right: ConfinedRegularFileRead): boolean {
  return left.identity.dev === right.identity.dev
    && left.identity.ino === right.identity.ino
    && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs
    && left.bytes.equals(right.bytes);
}

function malformedLockGraceMs(staleMs: number): number {
  return Math.min(staleMs, MALFORMED_LOCK_GRACE_MS);
}

function assertMalformedLock(read: ConfinedRegularFileRead, expectedName?: string): void {
  if (read.nlink !== 1) throw new Error("项目锁必须是单链接普通文件。");
  try {
    parseLockPayload(read.bytes, expectedName);
  } catch {
    return;
  }
  throw new Error("项目锁已恢复为有效载荷。");
}

async function reclaimMalformedRegularFile(
  directory: ConfinedDirectoryIdentity,
  fileName: string,
  expectedName: string | undefined,
  staleMs: number,
): Promise<boolean> {
  const graceMs = malformedLockGraceMs(staleMs);
  const observed = await readConfinedRegularFileWithIdentity(directory, fileName, MAX_LOCK_BYTES);
  assertMalformedLock(observed, expectedName);
  if (Date.now() - observed.mtimeMs <= graceMs) return false;
  await wait(20);
  const confirmed = await readConfinedRegularFileWithIdentity(directory, fileName, MAX_LOCK_BYTES);
  assertMalformedLock(confirmed, expectedName);
  if (!sameRawObservation(observed, confirmed) || Date.now() - confirmed.mtimeMs <= graceMs) return false;
  try {
    await unlinkOwnedConfinedFile(observed.identity);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
}

async function createOwnedLock(
  directory: ConfinedDirectoryIdentity,
  fileName: string,
  name: string,
  token: string,
): Promise<OwnedLock> {
  const created = await openExclusiveConfinedFile(directory, fileName);
  const payload: LockPayload = {
    schemaVersion: 1,
    name,
    token,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  try {
    await created.handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
    await created.handle.sync();
    await revalidateConfinedDirectory(directory);
    return { ...created, payload };
  } catch (error) {
    await created.handle.close().catch(() => undefined);
    await unlinkOwnedConfinedFile(created.identity).catch(() => undefined);
    throw error;
  }
}

async function reclaimAbandonedReaper(
  directory: ConfinedDirectoryIdentity,
  reaperName: string,
  staleMs: number,
): Promise<boolean> {
  const observed = await observeLock(directory, reaperName);
  const reclaimAfterMs = Math.min(staleMs, DEAD_OWNER_GRACE_MS);
  if (processAlive(observed.payload.pid) || Date.now() - observed.mtimeMs <= reclaimAfterMs) return false;
  await wait(20);
  const confirmed = await observeLock(directory, reaperName);
  if (!sameObservation(observed, confirmed)
    || processAlive(confirmed.payload.pid)
    || Date.now() - confirmed.mtimeMs <= reclaimAfterMs) return false;
  await unlinkOwnedConfinedFile(observed.identity);
  return true;
}

async function reclaimMalformedStaleLock(
  directory: ConfinedDirectoryIdentity,
  lockFileName: string,
  lockName: string,
  staleMs: number,
): Promise<boolean> {
  const initial = await readConfinedRegularFileWithIdentity(directory, lockFileName, MAX_LOCK_BYTES);
  assertMalformedLock(initial, lockName);
  if (Date.now() - initial.mtimeMs <= malformedLockGraceMs(staleMs)) return false;

  const reaperFileName = `${lockFileName}.reaper`;
  const reaperToken = randomUUID();
  let reaper: OwnedLock | undefined;
  try {
    reaper = await createOwnedLock(directory, reaperFileName, `${lockName}.reaper`, reaperToken);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    await reclaimAbandonedReaper(directory, reaperFileName, staleMs).catch(async (probeError) => {
      if (errorCode(probeError) === "ENOENT") return false;
      return reclaimMalformedRegularFile(
        directory,
        reaperFileName,
        `${lockName}.reaper`,
        staleMs,
      ).catch((malformedError) => {
        if (errorCode(malformedError) !== "ENOENT") throw malformedError;
        return false;
      });
    });
    return false;
  }

  let cleanupError: unknown;
  try {
    const observed = await readConfinedRegularFileWithIdentity(directory, lockFileName, MAX_LOCK_BYTES);
    assertMalformedLock(observed, lockName);
    if (Date.now() - observed.mtimeMs <= malformedLockGraceMs(staleMs)) return false;
    await wait(20);
    const confirmed = await readConfinedRegularFileWithIdentity(directory, lockFileName, MAX_LOCK_BYTES);
    assertMalformedLock(confirmed, lockName);
    const reaperObserved = await observeLock(directory, reaperFileName, `${lockName}.reaper`);
    if (!sameRawObservation(observed, confirmed)
      || reaperObserved.payload.token !== reaperToken
      || reaperObserved.identity.dev !== reaper.identity.dev
      || reaperObserved.identity.ino !== reaper.identity.ino
      || Date.now() - confirmed.mtimeMs <= malformedLockGraceMs(staleMs)) return false;
    await unlinkOwnedConfinedFile(observed.identity);
    return true;
  } finally {
    await reaper.handle.close().catch(() => undefined);
    try {
      const current = await observeLock(directory, reaperFileName, `${lockName}.reaper`);
      if (current.payload.token !== reaperToken
        || current.identity.dev !== reaper.identity.dev
        || current.identity.ino !== reaper.identity.ino) {
        throw new Error("项目锁 reaper ownership 已丢失，已保留替换节点。");
      }
      await unlinkOwnedConfinedFile(reaper.identity);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") cleanupError = error;
    }
    if (cleanupError) throw cleanupError;
  }
}

async function reclaimStaleLock(
  directory: ConfinedDirectoryIdentity,
  lockFileName: string,
  lockName: string,
  staleMs: number,
): Promise<boolean> {
  const reaperFileName = `${lockFileName}.reaper`;
  const reaperToken = randomUUID();
  let reaper: OwnedLock | undefined;
  try {
    reaper = await createOwnedLock(directory, reaperFileName, `${lockName}.reaper`, reaperToken);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    await reclaimAbandonedReaper(directory, reaperFileName, staleMs).catch(async (probeError) => {
      if (errorCode(probeError) === "ENOENT") return false;
      return reclaimMalformedRegularFile(
        directory,
        reaperFileName,
        `${lockName}.reaper`,
        staleMs,
      ).catch((malformedError) => {
        if (errorCode(malformedError) !== "ENOENT") throw malformedError;
        return false;
      });
    });
    return false;
  }

  let cleanupError: unknown;
  try {
    let observed: LockObservation;
    try {
      observed = await observeLock(directory, lockFileName, lockName);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return true;
      throw error;
    }
    if (Date.now() - observed.mtimeMs <= staleMs || processAlive(observed.payload.pid)) return false;
    await wait(20);
    const confirmed = await observeLock(directory, lockFileName, lockName);
    const reaperObserved = await observeLock(directory, reaperFileName, `${lockName}.reaper`);
    if (!sameObservation(observed, confirmed)
      || reaperObserved.payload.token !== reaperToken
      || reaperObserved.identity.dev !== reaper.identity.dev
      || reaperObserved.identity.ino !== reaper.identity.ino
      || Date.now() - confirmed.mtimeMs <= staleMs
      || processAlive(confirmed.payload.pid)) return false;
    await unlinkOwnedConfinedFile(observed.identity);
    return true;
  } finally {
    await reaper.handle.close().catch(() => undefined);
    try {
      const current = await observeLock(directory, reaperFileName, `${lockName}.reaper`);
      if (current.payload.token !== reaperToken
        || current.identity.dev !== reaper.identity.dev
        || current.identity.ino !== reaper.identity.ino) {
        throw new Error("项目锁 reaper ownership 已丢失，已保留替换节点。");
      }
      await unlinkOwnedConfinedFile(reaper.identity);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") cleanupError = error;
    }
    if (cleanupError) throw cleanupError;
  }
}

async function ensureLockDirectory(directory: string, confinementRoot?: string): Promise<ConfinedDirectoryIdentity> {
  const resolvedDirectory = path.resolve(directory);
  if (confinementRoot) {
    return ensureConfinedDirectory(path.resolve(confinementRoot), resolvedDirectory);
  }
  await mkdir(resolvedDirectory, { recursive: true });
  return ensureConfinedDirectory(resolvedDirectory, resolvedDirectory);
}

export async function listProjectLocks(projectRoot: string, staleMs = DEFAULT_STALE_MS): Promise<ProjectLockInfo[]> {
  const directoryPath = await projectLockDirectory(projectRoot);
  let directory: ConfinedDirectoryIdentity;
  try {
    directory = await inspectExistingConfinedDirectory(path.resolve(projectRoot), directoryPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const names = await readdir(directory.directory);
  const now = Date.now();
  const locks: ProjectLockInfo[] = [];
  for (const fileName of names.filter((entry) => entry.endsWith(".lock"))) {
    const name = fileName.slice(0, -5);
    try {
      const observed = await observeLock(directory, fileName, name);
      const ageMs = Math.max(0, now - observed.mtimeMs);
      locks.push({
        name,
        path: path.join(directory.directory, fileName),
        token: observed.payload.token,
        pid: observed.payload.pid,
        createdAt: observed.payload.createdAt,
        ageMs,
        stale: ageMs > staleMs,
      });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  return locks.sort((left, right) => right.ageMs - left.ageMs);
}

export async function withFileLock<T>(
  directoryPath: string,
  name: string,
  work: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const directory = await ensureLockDirectory(directoryPath, options.confinementRoot);
  const lockName = safeLockName(name);
  const lockFileName = `${lockName}.lock`;
  const timeoutMs = Math.max(250, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const staleMs = Math.max(timeoutMs * 2, options.staleMs ?? DEFAULT_STALE_MS);
  const token = randomUUID();
  const started = Date.now();
  let owned: OwnedLock | undefined;
  let attempt = 0;
  while (!owned) {
    try {
      owned = await createOwnedLock(directory, lockFileName, lockName, token);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try {
        const observed = await observeLock(directory, lockFileName, lockName);
        const alive = processAlive(observed.payload.pid);
        const reclaimAfterMs = !alive ? Math.min(staleMs, DEAD_OWNER_GRACE_MS) : staleMs;
        if (Date.now() - observed.mtimeMs > reclaimAfterMs && !alive
          && await reclaimStaleLock(directory, lockFileName, lockName, reclaimAfterMs)) continue;
      } catch (probeError) {
        if (errorCode(probeError) === "ENOENT") continue;
        try {
          if (await reclaimMalformedStaleLock(directory, lockFileName, lockName, staleMs)) continue;
        } catch (malformedError) {
          if (errorCode(malformedError) === "ENOENT") continue;
          // symlink、多链接或正在变化的节点一律保持 fail-closed，不跟随、不删除。
        }
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`项目写锁 ${lockName} 等待超过 ${timeoutMs}ms；另一个 Codex 或桌面进程可能仍在写入，请稍后重试。`);
      }
      attempt += 1;
      await wait(Math.min(120, 20 + attempt * 5));
    }
  }

  let heartbeatTask: Promise<void> | null = null;
  let ownershipLost: unknown;
  const heartbeat = setInterval(() => {
    if (heartbeatTask || ownershipLost) return;
    heartbeatTask = (async () => {
      const before = await observeLock(directory, lockFileName, lockName);
      if (before.payload.token !== token
        || before.identity.dev !== owned!.identity.dev
        || before.identity.ino !== owned!.identity.ino) {
        throw new Error(`项目写锁 ${lockName} ownership 已丢失。`);
      }
      const handleIdentity = await owned!.handle.stat();
      if (handleIdentity.dev !== owned!.identity.dev || handleIdentity.ino !== owned!.identity.ino) {
        throw new Error(`项目写锁 ${lockName} fd 身份已漂移。`);
      }
      const now = new Date();
      await owned!.handle.utimes(now, now);
      const after = await observeLock(directory, lockFileName, lockName);
      if (!sameObservation(before, after)) throw new Error(`项目写锁 ${lockName} heartbeat 后 ownership 已丢失。`);
    })().catch((error) => { ownershipLost = error; }).finally(() => { heartbeatTask = null; });
  }, Math.max(100, Math.floor(staleMs / 3)));
  heartbeat.unref();

  let value: T | undefined;
  let workError: unknown;
  try {
    value = await work();
  } catch (error) {
    workError = error;
  }
  clearInterval(heartbeat);
  await heartbeatTask;

  let cleanupError: unknown = ownershipLost;
  if (!cleanupError) {
    try {
      const current = await observeLock(directory, lockFileName, lockName);
      if (current.payload.token !== token
        || current.identity.dev !== owned.identity.dev
        || current.identity.ino !== owned.identity.ino) {
        throw new Error(`项目写锁 ${lockName} ownership 已丢失，已保留替换节点。`);
      }
      await unlinkOwnedConfinedFile(owned.identity);
    } catch (error) {
      cleanupError = error;
    }
  }
  await owned.handle.close().catch((error) => { cleanupError ??= error; });

  if (workError && cleanupError) {
    throw new AggregateError([workError, cleanupError], `项目写锁 ${lockName} 临界区与释放均失败。`);
  }
  if (workError) throw workError;
  if (cleanupError) throw cleanupError;
  return value as T;
}

export async function withProjectLock<T>(
  projectRoot: string,
  name: string,
  work: () => Promise<T>,
  options: Omit<FileLockOptions, "confinementRoot"> = {},
): Promise<T> {
  const root = path.resolve(projectRoot);
  return withFileLock(await projectLockDirectory(root), name, work, { ...options, confinementRoot: root });
}
