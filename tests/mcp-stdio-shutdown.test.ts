import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function identityFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-mcp-stdio-shutdown-"));
  roots.push(root);
  const identityWorkspace = path.join(root, "identity-workspace");
  await mkdir(path.join(identityWorkspace, "src", "mcp"), { recursive: true });
  await writeFile(
    path.join(identityWorkspace, "package.json"),
    JSON.stringify({ name: "ai-drama-canvas", version: "0.2.0" }),
    "utf8",
  );
  await writeFile(
    path.join(identityWorkspace, "src", "mcp", "server.ts"),
    // build identity 会统计 registerTool 出现次数作为声明工具数，必须 ≥1。
    "server.registerTool('identity-probe', {}, () => ({}));\n",
    "utf8",
  );
  return {
    identityWorkspace,
    registryPath: path.join(root, "registry", "projects.json"),
  };
}

function spawnMcpServer(fixture: { identityWorkspace: string; registryPath: string }): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "src/mcp/server.ts"], {
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_REGISTRY_PATH: fixture.registryPath,
      AI_CANVAS_WORKSPACE: fixture.identityWorkspace,
      // 不与机器上潜在的真实 MCP 主写锁竞争；shutdown 测试只验证退出链本身。
      AI_CANVAS_MCP_ALLOW_MULTI: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

/** 等待 server 对 initialize(id=1) 给出任意响应，证明消息循环与 watcher 均已就绪。 */
async function waitForServerReady(child: ChildProcess, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stderrChunks: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
    const timer = setTimeout(
      () => reject(new Error(`MCP 未在 ${timeoutMs}ms 内响应 initialize。stderr：${stderrChunks.join("")}`)),
      timeoutMs,
    );
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\"id\":1")) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`MCP 在就绪前退出：code=${code} signal=${signal} stderr：${stderrChunks.join("")}`));
    });
    child.stdin?.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-stdio-shutdown-test", version: "0.0.1" },
      },
    })}\n`);
  });
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(
      () => reject(new Error(`MCP 进程在 ${timeoutMs}ms 内未退出（persistent watcher 疑似仍常驻）。`)),
      timeoutMs,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe("P0 MCP stdio 幂等 shutdown", () => {
  it("stdin EOF 后释放 watcher/transport 并以退出码 0 结束，不再常驻", async () => {
    const fixture = await identityFixture();
    const child = spawnMcpServer(fixture);
    await waitForServerReady(child, 60_000);

    child.stdin?.end();
    const exit = await waitForExit(child, 30_000);
    expect(exit).toEqual({ code: 0, signal: null });
  }, 120_000);

  it("SIGTERM 走同一条集中 shutdown 链并以 143 退出", async () => {
    const fixture = await identityFixture();
    const child = spawnMcpServer(fixture);
    await waitForServerReady(child, 60_000);

    child.kill("SIGTERM");
    const exit = await waitForExit(child, 30_000);
    expect(exit).toEqual({ code: 143, signal: null });
  }, 120_000);

  it("SIGINT 同样接入集中 shutdown 链并以 130 退出", async () => {
    const fixture = await identityFixture();
    const child = spawnMcpServer(fixture);
    await waitForServerReady(child, 60_000);

    child.kill("SIGINT");
    const exit = await waitForExit(child, 30_000);
    expect(exit).toEqual({ code: 130, signal: null });
  }, 120_000);
});
