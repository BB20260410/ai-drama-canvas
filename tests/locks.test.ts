import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listProjectLocks, withProjectLock } from "../src/core/locks.js";

const roots: string[] = [];
const children = new Set<ChildProcess>();
const lockWorkerPath = path.resolve("tests/helpers/lock-sigkill-worker.ts");

interface LockWorker {
  child: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout(): string;
  stderr(): string;
}

function spawnLockWorker(args: string[]): LockWorker {
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, ["--import", "tsx", lockWorkerPath, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    });
  });
  return {
    child,
    closed,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function waitForWorkerOutput(worker: LockWorker, expected: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (!worker.stdout().includes(expected)) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      const closed = await worker.closed;
      throw new Error(`锁 worker 在 ${expected} 前退出：${JSON.stringify(closed)}\n${worker.stderr()}`);
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等待锁 worker 输出 ${expected} 超时。\n${worker.stderr()}`);
    }
    await wait(10);
  }
}

async function killWorker(worker: LockWorker): Promise<void> {
  expect(worker.child.kill("SIGKILL")).toBe(true);
  await expect(worker.closed).resolves.toEqual({ code: null, signal: "SIGKILL" });
}

async function waitForLockAge(lockPath: string, minimumAgeMs: number, timeoutMs = minimumAgeMs + 2_000): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    const ageMs = Date.now() - (await lstat(lockPath)).mtimeMs;
    if (ageMs > minimumAgeMs) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等待 lock 达到 ${minimumAgeMs}ms 真实年龄超时，当前 ${Math.floor(ageMs)}ms。`);
    }
    await wait(Math.min(100, Math.max(10, minimumAgeMs - ageMs + 10)));
  }
}

async function runRecoveryContenders(
  root: string,
  lockName: string,
  options: { timeoutMs: number; staleMs: number },
): Promise<void> {
  const activePath = path.join(root, `${lockName}.active`);
  const journalPath = path.join(root, `${lockName}.journal.jsonl`);
  const startGatePath = path.join(root, `${lockName}.start`);
  await writeFile(journalPath, "", "utf8");
  const args = [
    "contender",
    root,
    lockName,
    activePath,
    journalPath,
    startGatePath,
    String(options.timeoutMs),
    String(options.staleMs),
    "250",
  ];
  const workers = [spawnLockWorker(args), spawnLockWorker(args)];
  await Promise.all(workers.map((worker) => waitForWorkerOutput(worker, "ARMED")));
  await writeFile(startGatePath, "start\n", "utf8");
  const results = await Promise.all(workers.map((worker) => worker.closed));
  results.forEach((result, index) => {
    expect(result, workers[index]!.stderr()).toEqual({ code: 0, signal: null });
  });

  const events = (await readFile(journalPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; pid: number });
  expect(events.some((event) => event.event === "OVERLAP")).toBe(false);
  expect(events.filter((event) => event.event === "ENTER")).toHaveLength(2);
  expect(events.filter((event) => event.event === "LEAVE")).toHaveLength(2);
  expect(new Set(events.filter((event) => event.event === "ENTER").map((event) => event.pid)).size).toBe(2);

  let active = 0;
  let maxActive = 0;
  for (const event of events) {
    if (event.event === "ENTER") active += 1;
    if (event.event === "LEAVE") active -= 1;
    expect(active).toBeGreaterThanOrEqual(0);
    maxActive = Math.max(maxActive, active);
  }
  expect(active).toBe(0);
  expect(maxActive).toBe(1);
  await expect(lstat(activePath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(path.join(root, ".aicanvas", "locks"))).toEqual([]);
}

afterEach(async () => {
  const lingering = Array.from(children);
  const closed = lingering.map((child) => new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("close", finish);
    const timeout = setTimeout(finish, 1_000);
    timeout.unref();
  }));
  lingering.forEach((child) => child.kill("SIGKILL"));
  await Promise.allSettled(closed);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("跨进程项目锁", () => {
  it.each(["sidecar", "locks"] as const)("%s 目录为 symlink 时拒绝取锁且工程外零写", async (target) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-lock-confinement-"));
    roots.push(root);
    const outside = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-lock-outside-"));
    roots.push(outside);
    if (target === "sidecar") {
      await symlink(outside, path.join(root, ".aicanvas"), "dir");
    } else {
      await mkdir(path.join(root, ".aicanvas"));
      await symlink(outside, path.join(root, ".aicanvas", "locks"), "dir");
    }
    await expect(withProjectLock(root, "unsafe", async () => undefined, { timeoutMs: 250 }))
      .rejects.toThrow(/符号链接|真实路径/u);
    expect(await readdir(outside)).toEqual([]);
  });

  it("lock symlink 不被读取、更新或删除", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-lock-file-symlink-"));
    roots.push(root);
    const directory = path.join(root, ".aicanvas", "locks");
    await mkdir(directory, { recursive: true });
    const outside = path.join(root, "outside-lock.json");
    const payload = `${JSON.stringify({ schemaVersion: 1, name: "trap", token: "outside-token", pid: process.pid, createdAt: new Date().toISOString() })}\n`;
    await writeFile(outside, payload);
    const before = await lstat(outside);
    await symlink(outside, path.join(directory, "trap.lock"), "file");

    await expect(withProjectLock(root, "trap", async () => undefined, { timeoutMs: 250, staleMs: 500 }))
      .rejects.toThrow("等待超过");
    const after = await lstat(outside);
    expect(await readFile(outside, "utf8")).toBe(payload);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect((await lstat(path.join(directory, "trap.lock"))).isSymbolicLink()).toBe(true);
  });

  it("callback 内用同 token 新 inode 替换 lock 时报 ownership lost 并保留新锁", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-lock-replaced-inode-"));
    roots.push(root);
    const lockPath = path.join(root, ".aicanvas", "locks", "replace.lock");
    let replacement = "";
    await expect(withProjectLock(root, "replace", async () => {
      replacement = await readFile(lockPath, "utf8");
      await rm(lockPath);
      await writeFile(lockPath, replacement);
    }, { timeoutMs: 250, staleMs: 500 })).rejects.toThrow(/ownership/u);
    expect(await readFile(lockPath, "utf8")).toBe(replacement);
    expect((await lstat(lockPath)).isFile()).toBe(true);
  });

  it("heartbeat 遇同 token symlink 替换时不触碰外部 mtime 且不删替换节点", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-lock-heartbeat-symlink-"));
    roots.push(root);
    const lockPath = path.join(root, ".aicanvas", "locks", "heartbeat.lock");
    const outside = path.join(root, "outside-heartbeat.json");
    let beforeMtime = 0;
    await expect(withProjectLock(root, "heartbeat", async () => {
      const payload = await readFile(lockPath, "utf8");
      await writeFile(outside, payload);
      beforeMtime = (await lstat(outside)).mtimeMs;
      await rm(lockPath);
      await symlink(outside, lockPath, "file");
      await wait(250);
    }, { timeoutMs: 250, staleMs: 500 })).rejects.toThrow(/ownership|受管文件/u);
    expect((await lstat(outside)).mtimeMs).toBe(beforeMtime);
    expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
  });

  it("listProjectLocks 缺目录时纯读返回空且不创建 sidecar", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-lock-list-readonly-"));
    roots.push(root);
    expect(await listProjectLocks(root)).toEqual([]);
    await expect(lstat(path.join(root, ".aicanvas"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("长任务超过 stale 窗口时仍保持互斥", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-lock-"));
    roots.push(root);
    let active = 0;
    let maxActive = 0;
    const first = withProjectLock(root, "long-write", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await wait(1_100);
      active -= 1;
    }, { timeoutMs: 250, staleMs: 500 });
    await wait(650);
    await expect(withProjectLock(root, "long-write", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
    }, { timeoutMs: 300, staleMs: 500 })).rejects.toThrow("等待超过");
    await first;
    expect(maxActive).toBe(1);
  });

  it("多个竞争者回收同一陈旧锁时只有一个回收者且临界区不重叠", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-lock-reaper-"));
    roots.push(root);
    const directory = path.join(root, ".aicanvas", "locks");
    const lockPath = path.join(directory, "dead-owner.lock");
    await mkdir(directory, { recursive: true });
    await writeFile(lockPath, `${JSON.stringify({ schemaVersion: 1, name: "dead-owner", token: "dead-token", pid: 999_999_999, createdAt: new Date(0).toISOString() })}\n`, "utf8");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);
    let active = 0;
    let maxActive = 0;

    await Promise.all(Array.from({ length: 12 }, () => withProjectLock(root, "dead-owner", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await wait(8);
      active -= 1;
    // 这里验证的是 12 个竞争者回收陈旧锁时的互斥正确性，不是 2 秒性能 SLA。
    // Darwin 安全实现会为每次 create/unlink 启动 dirfd helper 并 fsync；全量测试
    // 资源竞争下 2 秒会在临界区尚未重叠前误报超时，因此沿用产品默认等待上限。
    }, { timeoutMs: 15_000, staleMs: 600 })));

    expect(maxActive).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("应用异常退出留下死亡 PID 时无需等待完整默认 stale 窗口", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-lock-dead-pid-"));
    roots.push(root);
    const directory = path.join(root, ".aicanvas", "locks");
    const lockPath = path.join(directory, "editor-renders.lock");
    await mkdir(directory, { recursive: true });
    await writeFile(lockPath, `${JSON.stringify({ schemaVersion: 1, name: "editor-renders", token: "abandoned-token", pid: 999_999_999, createdAt: new Date(0).toISOString() })}\n`, "utf8");
    const abandonedAt = new Date(Date.now() - 3_000);
    await utimes(lockPath, abandonedAt, abandonedAt);

    let entered = false;
    await withProjectLock(root, "editor-renders", async () => { entered = true; }, { timeoutMs: 5_000 });
    expect(entered).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  it("应用在 lock 载荷落盘前退出留下陈旧空文件时可安全回收", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-lock-empty-stale-"));
    roots.push(root);
    const directory = path.join(root, ".aicanvas", "locks");
    const lockPath = path.join(directory, "unit-write-lease.lock");
    await mkdir(directory, { recursive: true });
    await writeFile(lockPath, "");
    const abandonedAt = new Date(Date.now() - 3_000);
    await utimes(lockPath, abandonedAt, abandonedAt);

    let entered = false;
    await withProjectLock(root, "unit-write-lease", async () => { entered = true; }, {
      timeoutMs: 1_500,
      staleMs: 600,
    });
    expect(entered).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  it("刚创建但尚未写完的空 lock 保持 fail-closed 且不被删除", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-lock-empty-fresh-"));
    roots.push(root);
    const directory = path.join(root, ".aicanvas", "locks");
    const lockPath = path.join(directory, "fresh.lock");
    await mkdir(directory, { recursive: true });
    await writeFile(lockPath, "");

    await expect(withProjectLock(root, "fresh", async () => undefined, {
      timeoutMs: 250,
      staleMs: 500,
    })).rejects.toThrow("等待超过");
    expect(await readFile(lockPath, "utf8")).toBe("");
  });

  it("真实子进程创建空 lock 后被 SIGKILL 可恢复且竞争者临界区不重叠", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-lock-sigkill-empty-"));
    roots.push(root);
    const lockName = "sigkill-empty";
    const lockPath = path.join(root, ".aicanvas", "locks", `${lockName}.lock`);
    const owner = spawnLockWorker(["empty-owner", root, lockName]);

    await waitForWorkerOutput(owner, "READY_EMPTY");
    const beforeKill = await lstat(lockPath);
    expect(beforeKill.isFile()).toBe(true);
    expect(beforeKill.nlink).toBe(1);
    expect(await readFile(lockPath)).toHaveLength(0);
    await killWorker(owner);
    expect(await readFile(lockPath)).toHaveLength(0);

    // timeout=3s 时产品会把 stale 下限提升至 6s；先等同一宽限，
    // 再让两个真实进程同时竞争回收，避免用 utimes 伪造崩溃年龄。
    await waitForLockAge(lockPath, 6_100);
    await runRecoveryContenders(root, lockName, { timeoutMs: 3_000, staleMs: 600 });
  }, 30_000);

  it("真实子进程写入 lock payload 后被 SIGKILL 可恢复且竞争者临界区不重叠", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-lock-sigkill-payload-"));
    roots.push(root);
    const lockName = "sigkill-payload";
    const lockPath = path.join(root, ".aicanvas", "locks", `${lockName}.lock`);
    const owner = spawnLockWorker(["payload-owner", root, lockName]);

    await waitForWorkerOutput(owner, "READY_PAYLOAD");
    const payload = JSON.parse(await readFile(lockPath, "utf8")) as {
      schemaVersion: number;
      name: string;
      token: string;
      pid: number;
    };
    expect(payload).toEqual(expect.objectContaining({
      schemaVersion: 1,
      name: lockName,
      pid: owner.child.pid,
    }));
    expect(payload.token).toMatch(/^[0-9a-f-]{36}$/u);
    const beforeKill = await lstat(lockPath);
    expect(beforeKill.isFile()).toBe(true);
    expect(beforeKill.nlink).toBe(1);
    await killWorker(owner);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(expect.objectContaining({
      token: payload.token,
      pid: payload.pid,
    }));

    // 有效 payload 的死亡 owner 宽限上限为 2s。
    await waitForLockAge(lockPath, 2_100);
    await runRecoveryContenders(root, lockName, { timeoutMs: 5_000, staleMs: 600 });
  }, 30_000);
});
