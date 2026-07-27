import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireMcpProcessGuard, releaseMcpProcessGuard } from "../src/core/mcp-process-guard.js";

describe("mcp-process-guard", () => {
  let tmp: string;
  let lockFile: string;
  let priorMulti: string | undefined;
  let priorSingleton: string | undefined;

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "aicanvas-mcp-guard-")));
    lockFile = path.join(tmp, "mcp-os-writer.lock");
    priorMulti = process.env.AI_CANVAS_MCP_ALLOW_MULTI;
    priorSingleton = process.env.AI_CANVAS_MCP_SINGLETON;
    delete process.env.AI_CANVAS_MCP_ALLOW_MULTI;
    delete process.env.AI_CANVAS_MCP_SINGLETON;
  });

  afterEach(async () => {
    await releaseMcpProcessGuard({ lockFilePath: lockFile });
    if (priorMulti === undefined) delete process.env.AI_CANVAS_MCP_ALLOW_MULTI;
    else process.env.AI_CANVAS_MCP_ALLOW_MULTI = priorMulti;
    if (priorSingleton === undefined) delete process.env.AI_CANVAS_MCP_SINGLETON;
    else process.env.AI_CANVAS_MCP_SINGLETON = priorSingleton;
    await rm(tmp, { recursive: true, force: true });
  });

  it("acquire 登记本进程；同 pid 可重入", async () => {
    const a = await acquireMcpProcessGuard({ lockFilePath: lockFile, note: "test-a" });
    expect(a.acquired).toBe(true);
    expect(a.mode).toBe("singleton");
    expect(a.claim?.pid).toBe(process.pid);

    const b = await acquireMcpProcessGuard({ lockFilePath: lockFile, note: "test-b" });
    expect(b.acquired).toBe(true);
    expect(b.claim?.pid).toBe(process.pid);
  });

  it("ALLOW_MULTI 时跳过锁", async () => {
    process.env.AI_CANVAS_MCP_ALLOW_MULTI = "1";
    const r = await acquireMcpProcessGuard({ lockFilePath: lockFile });
    expect(r.acquired).toBe(true);
    expect(r.mode).toBe("multi-allowed");
  });

  it("死亡进程留下的 claim 可在原子临界区内恢复", async () => {
    await writeFile(lockFile, `${JSON.stringify({
      schemaVersion: 1,
      kind: "mcp-os-writer-lock",
      pid: 2_147_483_647,
      startedAt: "2026-01-01T00:00:00.000Z",
      hostname: "dead-host",
      argv0: "dead-mcp",
    })}\n`, "utf8");

    const result = await acquireMcpProcessGuard({ lockFilePath: lockFile, note: "recovered" });
    expect(result.acquired).toBe(true);
    expect(result.claim?.pid).toBe(process.pid);
  });

  it("两个真实进程同时竞争空 claim 时只有一个 writer", async () => {
    const worker = fileURLToPath(new URL("./helpers/mcp-process-guard-worker.ts", import.meta.url));
    const children = [0, 1].map(() => fork(worker, [lockFile], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        AI_CANVAS_MCP_ALLOW_MULTI: "",
        AI_CANVAS_MCP_SINGLETON: "",
      },
    }));

    const readResult = (child: ChildProcess) => new Promise<{
      pid: number;
      acquired: boolean;
      blockedByPid: number | null;
    }>((resolve, reject) => {
      let stderr = "";
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.once("message", (message) => resolve(message as {
        pid: number;
        acquired: boolean;
        blockedByPid: number | null;
      }));
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code && code !== 0) reject(new Error(`guard worker exit=${code}: ${stderr}`));
      });
    });

    try {
      const results = await Promise.all(children.map(readResult));
      const winners = results.filter((result) => result.acquired);
      const losers = results.filter((result) => !result.acquired);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]?.blockedByPid).toBe(winners[0]?.pid);
      children[results.findIndex((result) => result.acquired)]?.send("release");
      await Promise.all(children.map((child) => new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", () => resolve());
      })));
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }
  }, 30_000);
});
