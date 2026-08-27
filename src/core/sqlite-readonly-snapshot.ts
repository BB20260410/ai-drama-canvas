import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  recordSqliteSnapshotOpened,
  recordSqliteSnapshotRequest,
  recordSqliteSnapshotRetry,
  recordSqliteStableDatabaseCapture,
} from "./runtime-storage-observability.js";

interface StableFileSnapshot {
  bytes: Buffer;
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  sha256: string;
}

interface StableDatabaseSnapshot {
  database: StableFileSnapshot;
  wal: StableFileSnapshot | null;
  shm: SqliteSourceBindingIdentity | null;
  journal: StableFileSnapshot | null;
}

export interface SqliteReadOnlySnapshot {
  database: DatabaseSync;
  sourceIdentity: SqliteSourceIdentity;
  close(): Promise<void>;
}

export interface SqliteSourceIdentity {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  sha256: string;
}

/**
 * writable-open 只绑定不可因同 inode 合法提交而改变的身份字段。
 * size/mtime/ctime/sha256 仍属于只读快照证据，不进入跨连接写令牌。
 */
export type SqliteSourceBindingIdentity = Readonly<
  Pick<SqliteSourceIdentity, "dev" | "ino" | "nlink">
>;

/**
 * 在只读快照与 writable open 之间绑定同一普通文件 inode 与元数据。
 * 该同步检查本身不通过 SQLite 打开文件，因此不会创建 WAL/SHM。
 */
export function inspectSqliteSourceBindingIdentity(
  databasePath: string,
  label: string,
): SqliteSourceBindingIdentity {
  const metadata = lstatSync(databasePath, { bigint: true });
  const canonicalPath = realpathSync(databasePath);
  const canonicalMetadata = lstatSync(canonicalPath, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
    || !canonicalMetadata.isFile() || canonicalMetadata.isSymbolicLink()
    || canonicalMetadata.nlink !== 1n
    || metadata.dev !== canonicalMetadata.dev || metadata.ino !== canonicalMetadata.ino) {
    throw new Error(`${label} writable source is not a safe regular file.`);
  }
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    nlink: metadata.nlink,
  };
}

function inspectOptionalSqliteFileBindingIdentity(
  filePath: string,
  label: string,
): SqliteSourceBindingIdentity | null {
  // 并发 SQLite 连接会合法地删除并重建 WAL/SHM/JOURNAL sidecar（checkpoint/连接关闭）。
  // 删除（ENOENT）按“无 sidecar”处理；重建导致 lstat↔realpath inode 变更、
  // unlink 短窗 nlink=0、或 lstat 与 O_NOFOLLOW 打开之间 inode 变更
  // （"changed while binding"）是瞬态竞态而非来源篡改：按有界退避重试。
  // 其他安全违规（非普通文件、symlink、nlink>1）立即失败，不重试。
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const metadata = lstatSync(filePath, { bigint: true });
      const canonicalPath = realpathSync(filePath);
      const canonicalMetadata = lstatSync(canonicalPath, { bigint: true });
      if (metadata.isSymbolicLink() || canonicalMetadata.isSymbolicLink()
        || !metadata.isFile() || !canonicalMetadata.isFile()
        || metadata.nlink > 1n || canonicalMetadata.nlink > 1n) {
        throw new Error(`${label} is not a safe single-link regular file.`);
      }
      // 合法并发重建：lstat↔realpath 之间 inode 被换，或 unlink 后短窗 nlink=0。
      // 与下面 fd 绑定窗口同类，按瞬态竞态退避。symlink / 硬链（nlink>1）上面已失败关闭。
      if (metadata.nlink !== 1n || canonicalMetadata.nlink !== 1n
        || metadata.dev !== canonicalMetadata.dev || metadata.ino !== canonicalMetadata.ino) {
        throw new Error(`${label} changed while binding its file descriptor.`);
      }
      const descriptor = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const opened = fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n
          || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
          throw new Error(`${label} changed while binding its file descriptor.`);
        }
        return { dev: opened.dev, ino: opened.ino, nlink: opened.nlink };
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      if (isMissing(error)) return null;
      const transient = error instanceof Error
        && error.message.includes("changed while binding its file descriptor");
      if (!transient || attempt === maxAttempts - 1) throw error;
      // 同步上下文（writable open 前置校验）：Atomics.wait 阻塞当前线程但不占 CPU，
      // 退避总预算 < 1.5s，每次重试都重新执行完整安全校验。
      const waitMs = Math.min(200, 20 * (attempt + 1)) + Math.floor(Math.random() * 20);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
  return null;
}

/** SQLite VFS 可能读取的所有现存 sidecar 都必须是同一路径的单链接普通文件。 */
export function assertSafeSqliteSidecars(databasePath: string, label: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"] as const) {
    inspectOptionalSqliteFileBindingIdentity(`${databasePath}${suffix}`, `${label}${suffix}`);
  }
}

export function assertSqliteSourceBindingIdentity(
  databasePath: string,
  expected: SqliteSourceBindingIdentity,
  label: string,
): void {
  const actual = inspectSqliteSourceBindingIdentity(databasePath, label);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino
    || actual.nlink !== 1n || expected.nlink !== 1n) {
    throw new Error(`${label} changed after read-only preflight; refusing writable open.`);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readStableFile(filePath: string, allowEmpty: boolean): Promise<StableFileSnapshot> {
  const metadata = await lstat(filePath, { bigint: true });
  // 最终文件节点绝不能是 symlink；macOS 的 /var -> /private/var 等受信祖先别名
  // 可以存在，但 canonical 目标必须与词法路径 lstat 到同一 dev/ino。随后 O_NOFOLLOW
  // 打开的 handle 还会再次绑定这一身份，祖先在检查窗口被替换也会失败关闭。
  const canonicalPath = await realpath(filePath);
  const canonicalMetadata = await lstat(canonicalPath, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
    || !canonicalMetadata.isFile() || canonicalMetadata.isSymbolicLink()
    || canonicalMetadata.nlink !== 1n
    || metadata.dev !== canonicalMetadata.dev || metadata.ino !== canonicalMetadata.ino) {
    throw new Error(`SQLite snapshot source is not a safe regular file: ${filePath}`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n
      || before.dev !== metadata.dev || before.ino !== metadata.ino
      || (!allowEmpty && before.size < 1n)) {
      throw new Error(`SQLite snapshot source identity is invalid: ${filePath}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.nlink !== after.nlink
      || after.nlink !== 1n || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || BigInt(bytes.byteLength) !== before.size) {
      throw new Error(`SQLite snapshot source changed while reading: ${filePath}`);
    }
    return {
      bytes,
      dev: before.dev,
      ino: before.ino,
      nlink: before.nlink,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

async function readOptionalStableFile(filePath: string): Promise<StableFileSnapshot | null> {
  try {
    return await readStableFile(filePath, true);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function captureStableDatabase(databasePath: string): Promise<StableDatabaseSnapshot> {
  recordSqliteStableDatabaseCapture();
  return {
    database: await readStableFile(databasePath, false),
    wal: await readOptionalStableFile(`${databasePath}-wal`),
    shm: inspectOptionalSqliteFileBindingIdentity(`${databasePath}-shm`, "SQLite snapshot shm"),
    journal: await readOptionalStableFile(`${databasePath}-journal`),
  };
}

function sameBinding(
  left: SqliteSourceBindingIdentity | null,
  right: SqliteSourceBindingIdentity | null,
): boolean {
  if (!left || !right) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.nlink === 1n && right.nlink === 1n;
}

function sameFile(left: StableFileSnapshot | null, right: StableFileSnapshot | null): boolean {
  if (!left || !right) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.sha256 === right.sha256;
}

function sameDatabase(left: StableDatabaseSnapshot, right: StableDatabaseSnapshot): boolean {
  return sameFile(left.database, right.database)
    && sameFile(left.wal, right.wal)
    && sameBinding(left.shm, right.shm)
    && sameFile(left.journal, right.journal);
}

function isTransientSnapshotRace(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  // Concurrent Electron/MCP writers mutate WAL mid-capture; identity/nlink/mtime
  // can flap without meaning the ledger is corrupt. Retry is safe for read-only clones.
  return /changed while|source identity is invalid|not a safe regular file|hot rollback journal/i.test(msg);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opens a query-only SQLite clone without opening the live database through SQLite.
 * The main database and WAL are captured twice and must remain byte/identity stable;
 * a hot rollback journal fails closed. Any WAL/SHM work happens only in the private
 * system temporary directory and is removed on close.
 *
 * Transient WAL races under concurrent writers are retried; permanent contract failures
 * still fail closed on the last attempt.
 */
export async function openSqliteReadOnlySnapshot(
  databasePathValue: string,
  label: string,
): Promise<SqliteReadOnlySnapshot> {
  recordSqliteSnapshotRequest();
  const maxAttempts = 12;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await openSqliteReadOnlySnapshotOnce(databasePathValue, label);
    } catch (error) {
      lastError = error;
      if (!isTransientSnapshotRace(error) || attempt === maxAttempts - 1) throw error;
      recordSqliteSnapshotRetry();
      await sleepMs(35 * Math.pow(1.45, attempt) + Math.random() * 40);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function openSqliteReadOnlySnapshotOnce(
  databasePathValue: string,
  label: string,
): Promise<SqliteReadOnlySnapshot> {
  const databasePath = path.resolve(databasePathValue);
  if (databasePath !== databasePathValue) {
    throw new Error(`${label} path must be absolute and normalized.`);
  }
  const first = await captureStableDatabase(databasePath);
  const second = await captureStableDatabase(databasePath);
  if (!sameDatabase(first, second)) {
    throw new Error(`${label} changed while creating a read-only snapshot.`);
  }
  if (second.journal && second.journal.size > 0n) {
    throw new Error(`${label} has a hot rollback journal; refusing a non-mutating projection.`);
  }

  const snapshotRoot = await mkdtemp(path.join(tmpdir(), "aicanvas-sqlite-readonly-"));
  const snapshotPath = path.join(snapshotRoot, "snapshot.sqlite");
  let database: DatabaseSync | null = null;
  try {
    await writeFile(snapshotPath, second.database.bytes, { flag: "wx", mode: 0o600 });
    if (second.wal && second.wal.size > 0n) {
      await writeFile(`${snapshotPath}-wal`, second.wal.bytes, { flag: "wx", mode: 0o600 });
    }
    database = new DatabaseSync(snapshotPath, { readOnly: true });
    database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON;");
    recordSqliteSnapshotOpened();
    let closed = false;
    return {
      database,
      sourceIdentity: {
        dev: second.database.dev,
        ino: second.database.ino,
        nlink: second.database.nlink,
        size: second.database.size,
        mtimeNs: second.database.mtimeNs,
        ctimeNs: second.database.ctimeNs,
        sha256: second.database.sha256,
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        try {
          database!.close();
        } finally {
          await rm(snapshotRoot, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      database?.close();
    } finally {
      await rm(snapshotRoot, { recursive: true, force: true });
    }
    throw error;
  }
}
