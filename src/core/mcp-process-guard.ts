/**
 * MCP 进程守护：同一机器上默认只允许一个「主写 MCP OS」进程（stdio 多开会争 WAL）。
 *
 * - 锁文件：~/.aicanvas/mcp-os-writer.lock（JSON + pid）
 * - 存活检测：kill(pid, 0)
 * - AI_CANVAS_MCP_ALLOW_MULTI=1：允许多实例（桌面内嵌 MCP + 调试）
 * - AI_CANVAS_MCP_SINGLETON=0：显式关闭守护
 * - 默认：开启（生产 OS 定位）
 */
import { access, mkdir, open, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "./locks.js";

export interface McpProcessGuardClaim {
  schemaVersion: 1;
  kind: "mcp-os-writer-lock";
  pid: number;
  startedAt: string;
  hostname: string;
  argv0: string;
  note?: string;
}

export interface McpProcessGuardResult {
  acquired: boolean;
  mode: "singleton" | "multi-allowed" | "disabled";
  lockPath: string;
  claim: McpProcessGuardClaim | null;
  blockedBy: McpProcessGuardClaim | null;
  message: string;
}

const LOCK_DIR = path.join(os.homedir(), ".aicanvas");
const LOCK_NAME = "mcp-os-writer.lock";

function lockPath(): string {
  return path.join(LOCK_DIR, LOCK_NAME);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readClaim(file: string): Promise<McpProcessGuardClaim | null> {
  try {
    await access(file, fsConstants.F_OK);
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Partial<McpProcessGuardClaim>;
    if (
      raw.schemaVersion !== 1
      || raw.kind !== "mcp-os-writer-lock"
      || typeof raw.pid !== "number"
      || typeof raw.startedAt !== "string"
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      kind: "mcp-os-writer-lock",
      pid: raw.pid,
      startedAt: raw.startedAt,
      hostname: typeof raw.hostname === "string" ? raw.hostname : "unknown",
      argv0: typeof raw.argv0 === "string" ? raw.argv0 : "unknown",
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
    };
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

async function writeClaimExclusive(file: string, claim: McpProcessGuardClaim): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(claim, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (handle) await rm(file, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * 在 MCP server 连接 transport 前调用。
 * 若已有存活的他进程主写锁且未 ALLOW_MULTI，返回 acquired=false（调用方应 exit）。
 */
export async function acquireMcpProcessGuard(options: {
  note?: string;
  /** 测试可注入 lock 路径 */
  lockFilePath?: string;
  /**
   * 默认 true：守护自带 SIGINT/SIGTERM 释放并退出。
   * 调用方自建集中 shutdown（如 MCP stdio 幂等关闭链）时传 false，
   * 避免双 handler 竞争同一信号造成资源释放被提前 process.exit 截断。
   */
  registerSignalHandlers?: boolean;
} = {}): Promise<McpProcessGuardResult> {
  const file = options.lockFilePath ?? lockPath();
  if (process.env.AI_CANVAS_MCP_SINGLETON === "0") {
    return {
      acquired: true,
      mode: "disabled",
      lockPath: file,
      claim: null,
      blockedBy: null,
      message: "MCP 单进程守护已关闭（AI_CANVAS_MCP_SINGLETON=0）。",
    };
  }
  if (process.env.AI_CANVAS_MCP_ALLOW_MULTI === "1") {
    return {
      acquired: true,
      mode: "multi-allowed",
      lockPath: file,
      claim: null,
      blockedBy: null,
      message: "允许多 MCP 实例（AI_CANVAS_MCP_ALLOW_MULTI=1）；写权限仍受写租约约束。",
    };
  }

  const claim: McpProcessGuardClaim = {
    schemaVersion: 1,
    kind: "mcp-os-writer-lock",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: os.hostname(),
    argv0: process.argv[1] ?? process.argv0 ?? "mcp",
    ...(options.note ? { note: options.note.slice(0, 200) } : {}),
  };

  // 复用项目通用锁 owner，把“读旧 claim → 判断存活 → 清理失效 claim →
  // 独占创建新 claim”收进同一短临界区。writer claim 本身仍用 wx 创建；
  // 两个进程从空路径同时启动时只有一个能成功，不再发生 tmp+rename 后写覆盖。
  const acquisition = await withFileLock(
    path.dirname(file),
    `${path.basename(file)}.acquire`,
    async (): Promise<
      | { acquired: true; claim: McpProcessGuardClaim }
      | { acquired: false; blockedBy: McpProcessGuardClaim }
    > => {
      const existing = await readClaim(file);
      if (existing?.pid === process.pid) {
        return { acquired: true, claim: existing };
      }
      if (existing && isProcessAlive(existing.pid)) {
        return { acquired: false, blockedBy: existing };
      }

      // 缺失、损坏或已死亡的旧 claim 只在 acquisition owner 临界区内清理。
      // 所有本模块调用方都先取得同一 owner；随后仍以 wx 做最终原子裁决。
      await rm(file, { force: true });
      try {
        await writeClaimExclusive(file, claim);
        return { acquired: true, claim };
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const winner = await readClaim(file);
        if (!winner) throw new Error("MCP OS writer claim 被并发替换为无效节点，已失败关闭。");
        return { acquired: false, blockedBy: winner };
      }
    },
    { timeoutMs: 5_000, staleMs: 15_000 },
  );

  if (!acquisition.acquired) {
    return {
      acquired: false,
      mode: "singleton",
      lockPath: file,
      claim: null,
      blockedBy: acquisition.blockedBy,
      message: `已有 MCP OS 主写进程 pid=${acquisition.blockedBy.pid}（自 ${acquisition.blockedBy.startedAt}）。请复用该连接或结束旧进程后重试；调试可设 AI_CANVAS_MCP_ALLOW_MULTI=1。`,
    };
  }

  const acquiredClaim = acquisition.claim;

  const release = async () => {
    const current = await readClaim(file);
    if (current?.pid === process.pid) {
      await rm(file, { force: true });
    }
  };
  process.once("exit", () => {
    void release();
  });
  if (options.registerSignalHandlers !== false) {
    process.once("SIGINT", () => {
      void release().finally(() => process.exit(130));
    });
    process.once("SIGTERM", () => {
      void release().finally(() => process.exit(143));
    });
  }

  return {
    acquired: true,
    mode: "singleton",
    lockPath: file,
    claim: acquiredClaim,
    blockedBy: null,
    message: `MCP OS 主写进程已登记 pid=${process.pid}`,
  };
}

export async function releaseMcpProcessGuard(options: { lockFilePath?: string } = {}): Promise<void> {
  const file = options.lockFilePath ?? lockPath();
  const current = await readClaim(file);
  if (current?.pid === process.pid) {
    await rm(file, { force: true });
  }
}
