import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

export function electronExecutablePath(root: string, platform = process.platform): string {
  if (platform === "darwin") {
    return path.join(root, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
  }
  if (platform === "win32") {
    return path.join(root, "node_modules", "electron", "dist", "electron.exe");
  }
  return path.join(root, "node_modules", "electron", "dist", "electron");
}

export function mcpServerPath(root: string): string {
  return path.join(root, "dist-mcp", "mcp", "server.js");
}

export interface TestRuntimeCommandRunner {
  (command: string, args: readonly string[]): Promise<void>;
}

async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

async function runCommand(root: string, command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: root, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} 被信号 ${signal} 终止。`));
      else if (code !== 0) reject(new Error(`${command} ${args.join(" ")} 退出 ${code ?? 1}。`));
      else resolve();
    });
  });
}

/** 测试前补齐 Electron 官方二进制和编译 MCP；已存在则零操作。 */
export async function ensureTestRuntime(
  root: string,
  run: TestRuntimeCommandRunner = (command, args) => runCommand(root, command, args),
): Promise<{ electronInstalled: boolean; mcpBuilt: boolean }> {
  const electron = electronExecutablePath(root);
  const mcp = mcpServerPath(root);
  let electronInstalled = false;
  let mcpBuilt = false;
  if (!await pathExists(electron)) {
    await run(process.execPath, [path.join("node_modules", "electron", "install.js")]);
    electronInstalled = true;
    if (!await pathExists(electron)) {
      throw new Error(`Electron 二进制安装后仍缺失：${electron}`);
    }
  }
  if (!await pathExists(mcp)) {
    await run("npm", ["run", "build:mcp"]);
    mcpBuilt = true;
    if (!await pathExists(mcp)) {
      throw new Error(`dist-mcp 构建后仍缺失：${mcp}`);
    }
  }
  return { electronInstalled, mcpBuilt };
}
