import { randomUUID } from "node:crypto";
import { link, lstat, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

const LOCK_FILE_NAME = ".publish-lock";
const REAPER_FILE_SUFFIX = ".reaper";
const DEFAULT_WAIT_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 100;

interface PublicationLockRecord {
  schemaVersion: 1;
  kind: "immutable-mcp-publication-lock";
  pid: number;
  token: string;
  startedAt: string;
}

export interface ImmutableMcpPublicationLockOptions {
  maxWaitMs?: number;
  pollMs?: number;
  testHooks?: {
    afterDeadLockReaperAcquired?(): Promise<void>;
    onDeadLockReaperBusy?(): Promise<void>;
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseLockRecord(value: string): PublicationLockRecord {
  const parsed = JSON.parse(value) as Partial<PublicationLockRecord>;
  if (parsed.schemaVersion !== 1
    || parsed.kind !== "immutable-mcp-publication-lock"
    || !Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) < 1
    || typeof parsed.token !== "string" || !/^[0-9a-f-]{36}$/iu.test(parsed.token)
    || typeof parsed.startedAt !== "string" || Number.isNaN(Date.parse(parsed.startedAt))) {
    throw new Error("MCP publication lock 内容无效；无法安全判断 owner，已失败关闭。");
  }
  return parsed as PublicationLockRecord;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function acquireDeadLockReaper(
  lockPath: string,
  options: ImmutableMcpPublicationLockOptions,
): Promise<{ path: string; token: string; dev: number; ino: number } | null> {
  const reaperPath = `${lockPath}${REAPER_FILE_SUFFIX}`;
  const token = randomUUID();
  let handle;
  try {
    handle = await open(reaperPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await options.testHooks?.onDeadLockReaperBusy?.();
    return null;
  }
  try {
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      kind: "immutable-mcp-publication-lock-reaper",
      pid: process.pid,
      token,
      startedAt: new Date().toISOString(),
    })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const metadata = await lstat(reaperPath);
  return { path: reaperPath, token, dev: metadata.dev, ino: metadata.ino };
}

async function releaseDeadLockReaper(reaper: {
  path: string;
  token: string;
  dev: number;
  ino: number;
}): Promise<void> {
  const [metadata, rawRecord] = await Promise.all([
    lstat(reaper.path),
    readFile(reaper.path, "utf8"),
  ]);
  const record = JSON.parse(rawRecord) as { token?: unknown };
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || metadata.dev !== reaper.dev || metadata.ino !== reaper.ino
    || record.token !== reaper.token) {
    throw new Error("MCP publication dead-lock reaper 身份不一致，拒绝删除其他回收者。 ");
  }
  await unlink(reaper.path);
}

async function reclaimDeadLock(
  lockPath: string,
  options: ImmutableMcpPublicationLockOptions,
): Promise<boolean> {
  const reaper = await acquireDeadLockReaper(lockPath, options);
  if (!reaper) return false;
  try {
    await options.testHooks?.afterDeadLockReaperAcquired?.();
    let before;
    try {
      before = await lstat(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink < 1 || before.nlink > 2) {
      throw new Error(`MCP publication lock 必须是受控普通文件：${lockPath}`);
    }
    const record = parseLockRecord(await readFile(lockPath, "utf8"));
    if (processIsAlive(record.pid)) return false;
    const quarantinePath = `${lockPath}.dead-${process.pid}-${randomUUID()}`;
    try {
      await rename(lockPath, quarantinePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    const landed = await lstat(quarantinePath);
    if (landed.dev !== before.dev || landed.ino !== before.ino) {
      throw new Error("MCP publication lock 回收期间身份发生变化，已失败关闭。");
    }
    await rm(quarantinePath, { force: true });
    return true;
  } finally {
    await releaseDeadLockReaper(reaper);
  }
}

async function safelyReleaseLock(
  lockPath: string,
  held: { dev: number; ino: number },
  token: string,
): Promise<void> {
  const [landed, record] = await Promise.all([
    lstat(lockPath),
    readFile(lockPath, "utf8").then(parseLockRecord),
  ]);
  if (held.dev !== landed.dev || held.ino !== landed.ino || record.token !== token) {
    throw new Error("MCP publication lock release 身份不一致，拒绝删除其他 owner 的锁。");
  }
  await unlink(lockPath);
}

export async function withImmutableMcpPublicationLock<T>(
  outputRootValue: string,
  action: () => Promise<T>,
  options: ImmutableMcpPublicationLockOptions = {},
): Promise<T> {
  const outputRoot = path.resolve(outputRootValue);
  if (await realpath(outputRoot) !== outputRoot) {
    throw new Error(`MCP publication lock 根必须是规范真实目录：${outputRoot}`);
  }
  const lockPath = path.join(outputRoot, LOCK_FILE_NAME);
  const deadline = Date.now() + (options.maxWaitMs ?? DEFAULT_WAIT_MS);
  const pollMs = Math.max(10, options.pollMs ?? DEFAULT_POLL_MS);
  const token = randomUUID();
  const ownerPath = path.join(outputRoot, `.publish-lock-owner-${process.pid}-${token}`);
  const record: PublicationLockRecord = {
    schemaVersion: 1,
    kind: "immutable-mcp-publication-lock",
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
  };
  const ownerHandle = await open(ownerPath, "wx", 0o600);
  try {
    await ownerHandle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await ownerHandle.sync();
  } finally {
    await ownerHandle.close();
  }
  let held: { dev: number; ino: number } | null = null;
  try {
    while (!held) {
      try {
        await link(ownerPath, lockPath);
        const metadata = await lstat(lockPath);
        held = { dev: metadata.dev, ino: metadata.ino };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const reclaimed = await reclaimDeadLock(lockPath, options);
        if (reclaimed) continue;
        if (Date.now() >= deadline) throw new Error(`MCP publication lock 正由存活进程持有：${lockPath}`);
        await wait(pollMs);
      }
    }
    await unlink(ownerPath);
    try {
      return await action();
    } finally {
      await safelyReleaseLock(lockPath, held, token);
    }
  } finally {
    await unlink(ownerPath).catch(() => undefined);
  }
}
