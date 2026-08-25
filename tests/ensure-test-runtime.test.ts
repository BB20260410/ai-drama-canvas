import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  electronExecutablePath,
  ensureTestRuntime,
  mcpServerPath,
} from "../scripts/lib/ensure-test-runtime.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("ensure-test-runtime", () => {
  it("按平台解析 Electron 可执行文件和 MCP 入口", () => {
    expect(electronExecutablePath("/repo", "darwin")).toBe(
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    expect(electronExecutablePath("/repo", "win32").replaceAll("/", path.win32.sep)).toContain("electron.exe");
    expect(electronExecutablePath("/repo", "linux")).toBe("/repo/node_modules/electron/dist/electron");
    expect(mcpServerPath("/repo")).toBe("/repo/dist-mcp/mcp/server.js");
  });

  it("缺失 Electron 或 dist-mcp 时才触发安装/构建命令", async () => {
    const commands: string[][] = [];
    const missingRoot = "/missing-runtime-root";
    await expect(ensureTestRuntime(missingRoot, async (command, args) => {
      commands.push([command, ...args]);
    })).rejects.toThrow(/Electron 二进制安装后仍缺失/);
    expect(commands).toEqual([[process.execPath, path.join("node_modules", "electron", "install.js")]]);
  });

  it("当前工作区已具备运行时则零操作", async () => {
    const commands: string[][] = [];
    await expect(ensureTestRuntime(workspace, async (command, args) => {
      commands.push([command, ...args]);
    })).resolves.toEqual({ electronInstalled: false, mcpBuilt: false });
    expect(commands).toEqual([]);
  });

  it("CI 在 npm test 前安装 Electron 并编译 MCP；分区入口会补齐运行时", async () => {
    const ci = await readFile(path.join(workspace, ".github/workflows/ci.yml"), "utf8");
    const installAt = ci.indexOf("node node_modules/electron/install.js");
    const mcpAt = ci.indexOf("npm run build:mcp");
    const testAt = ci.indexOf("npm test");
    expect(installAt).toBeGreaterThan(-1);
    expect(mcpAt).toBeGreaterThan(installAt);
    expect(testAt).toBeGreaterThan(mcpAt);
    const partition = await readFile(path.join(workspace, "scripts/run-test-partition.ts"), "utf8");
    expect(partition).toContain("ensureTestRuntime(root)");
  });
});
