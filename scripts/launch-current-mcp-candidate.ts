/**
 * Codex/Grok/Claude 的稳定 MCP 入口。
 *
 * 入口本身不绑定某个 candidate；每次启动先验证 live 源码身份，只把 stdio
 * 交给完全匹配且已封存的 immutable candidate。没有当前工件时失败关闭。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  currentMcpRuntimeArguments,
  currentMcpRuntimeEnvironment,
  resolveCurrentMcpRuntime,
  unsafeMcpEnvironmentKeys,
} from "../src/core/current-mcp-runtime.js";

export const CURRENT_MCP_RUNTIME_THREAT_BOUNDARY = [
  "阻止未发布候选、路径逃逸和依赖回落；正式 shell 入口在 Node 启动前清理 NODE_OPTIONS/NODE_PATH，launcher 对仍存在的动态链接器注入变量失败关闭。",
  "调用 shell/Node 之前已由操作系统动态链接器执行的注入不可能在本进程内撤销，因此启动父进程与其环境仍属于信任边界。",
  "不提供密码学签名，也不防御可同时改写源码、候选、publication 与 launcher 的同一可写本机账户。",
].join(" ");

export interface CurrentMcpLauncherCliInput {
  workspace: string;
  checkOnly: boolean;
}

export function inferCurrentMcpLauncherWorkspace(moduleUrl = import.meta.url): string {
  const directory = path.dirname(fileURLToPath(moduleUrl));
  if (path.basename(directory) === "mcp-launcher"
    && path.basename(path.dirname(directory)) === ".aicanvas-runtime") {
    return path.resolve(directory, "../..");
  }
  return path.resolve(directory, "..");
}

export function parseCurrentMcpLauncherArguments(
  argv: string[],
  workspace = inferCurrentMcpLauncherWorkspace(),
): CurrentMcpLauncherCliInput {
  let checkOnly = false;
  for (const argument of argv) {
    if (argument === "--check") {
      checkOnly = true;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  return { workspace: path.resolve(workspace), checkOnly };
}

export function assertSafeCurrentMcpLauncherEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
): void {
  const unsafeKeys = unsafeMcpEnvironmentKeys(inherited);
  if (unsafeKeys.length) {
    throw new Error(
      `检测到不安全继承环境 ${unsafeKeys.join("、")}，稳定 MCP launcher 已拒绝启动。请清理这些 Node loader/动态链接器注入变量后重试。`,
    );
  }
}

export async function launchCurrentMcpCandidate(input: CurrentMcpLauncherCliInput): Promise<void> {
  assertSafeCurrentMcpLauncherEnvironment();
  const resolution = await resolveCurrentMcpRuntime({ workspace: input.workspace });
  if (input.checkOnly) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      candidateId: resolution.receipt.candidateId,
      buildId: resolution.receipt.buildId,
      sourceDigest: resolution.receipt.sourceDigest,
      mcpToolCount: resolution.receipt.mcpToolCount,
      entrySha256: resolution.receipt.entrySha256,
      payloadFingerprint: resolution.publication.payloadFingerprint,
      dependencyClosureFingerprint: resolution.publication.dependencyClosure.fingerprint,
      inspectedCandidates: resolution.inspectedCandidates,
      invalidCandidates: resolution.invalidCandidates,
      threatBoundary: CURRENT_MCP_RUNTIME_THREAT_BOUNDARY,
    })}\n`);
    return;
  }

  const child = spawn(process.execPath, currentMcpRuntimeArguments(resolution), {
    cwd: resolution.workspace,
    env: currentMcpRuntimeEnvironment(resolution),
    stdio: "inherit",
  });
  const forwardedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of forwardedSignals) {
    const handler = () => {
      if (!child.killed) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        process.exitCode = code ?? (signal ? 1 : 0);
        resolve();
      });
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    await launchCurrentMcpCandidate(parseCurrentMcpLauncherArguments(process.argv.slice(2)));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? ` ${(error as Error & { code: string }).code}` : "";
    process.stderr.write(`[mcp-current${code}] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
