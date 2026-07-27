import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAgentConnectionCliArguments,
  inspectCodexMcpConfiguration,
  inspectGrokMcpConfiguration,
  repairAgentConnections,
  type AgentConnectionCommandRunner,
} from "../src/core/agent-connection-config.js";
import type { McpRuntimeLaunchContract } from "../src/core/release-manifest.js";

const digest = "a".repeat(64);
const launch: McpRuntimeLaunchContract = {
  schemaVersion: 1,
  kind: "packaged-mcp-runtime-launch-contract",
  command: "/usr/bin/env",
  args: [
    "ELECTRON_RUN_AS_NODE=1",
    "/Applications/AI 漫剧画布.app/Contents/MacOS/AI 漫剧画布",
    "/Applications/AI 漫剧画布.app/Contents/Resources/app.asar.unpacked/dist-mcp/mcp/server.js",
  ],
  cwd: "/Applications/AI 漫剧画布.app/Contents/Resources/app.asar.unpacked/dist-mcp/mcp",
  env: {
    AI_CANVAS_RELEASE_MANIFEST_PATH: "/Applications/AI 漫剧画布.app/Contents/Resources/release-manifest.json",
    AI_CANVAS_WORKSPACE: "/Applications/AI 漫剧画布.app/Contents/Resources",
    AI_CANVAS_RECORDED_SOURCE_DIGEST: digest,
    AI_CANVAS_RECORDED_RUNTIME_ARTIFACT_SHA256: "c".repeat(64),
    AI_CANVAS_BUILD_TIMESTAMP: "2026-07-18T10:00:00.000Z",
    AI_CANVAS_REGISTRY_PATH: "/Users/test/.aicanvas/projects.json",
  },
};

function codexJson() {
  return JSON.stringify({
    name: "ai-drama-canvas",
    transport: { type: "stdio", command: launch.command, args: launch.args, env: launch.env },
  });
}

function grokJson() {
  return JSON.stringify([{ name: "ai-drama-canvas", command: launch.command, args: launch.args, env: launch.env }]);
}

describe("安装版 Agent 连接配置 owner", () => {
  it("为两端生成同一无工程绑定 runtime，并精确识别构建身份", () => {
    const codexArgs = buildAgentConnectionCliArguments("codex", launch);
    const grokArgs = buildAgentConnectionCliArguments("grok", launch);
    expect(codexArgs).toContain("/usr/bin/env");
    expect(grokArgs).toContain("/usr/bin/env");
    expect(codexArgs.join(" ")).not.toContain("AI_CANVAS_PROJECT_ROOT");
    expect(grokArgs.join(" ")).not.toContain("AI_CANVAS_PROJECT_ROOT");
    expect(inspectCodexMcpConfiguration(codexJson(), launch)).toMatchObject({ configured: true, current: true });
    expect(inspectGrokMcpConfiguration(grokJson(), launch)).toMatchObject({ configured: true, current: true });
    const stale = { ...launch, env: { ...launch.env, AI_CANVAS_RECORDED_SOURCE_DIGEST: "b".repeat(64) } };
    expect(inspectCodexMcpConfiguration(codexJson(), stale)).toMatchObject({ configured: true, current: false, issue: "runtime-mismatch" });
  });

  it("先以 0600 备份/缺失 marker，再经注入 runner 修复并 doctor", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aicanvas-agent-config-success-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "config.toml"), "codex-original\n", { mode: 0o600 });
    const calls: string[][] = [];
    const runner: AgentConnectionCommandRunner = async (executable, args) => {
      calls.push([executable, ...args]);
      if (args[0] === "mcp" && args[1] === "add") {
        const client = executable.endsWith("codex") ? ".codex" : ".grok";
        await mkdir(path.join(home, client), { recursive: true });
        await writeFile(path.join(home, client, "config.toml"), `${client}-configured\n`);
        return { stdout: "", stderr: "" };
      }
      if (executable.endsWith("codex")) return { stdout: codexJson(), stderr: "" };
      if (args[1] === "list") return { stdout: grokJson(), stderr: "" };
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    };
    const result = await repairAgentConnections({
      packaged: true,
      homeDirectory: home,
      codexExecutable: "/opt/test/codex",
      grokExecutable: "/opt/test/grok",
      launch,
      now: "2026-07-18T10:00:00.000Z",
    }, runner);
    expect(result.codex.current).toBe(true);
    expect(result.grok.current).toBe(true);
    expect(await readFile(path.join(result.backupDirectory, "codex-config.toml"), "utf8")).toBe("codex-original\n");
    expect(await readFile(path.join(result.backupDirectory, "grok-config.toml.missing"), "utf8")).toBe("original-config-missing\n");
    expect((await stat(path.join(result.backupDirectory, "codex-config.toml"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(result.backupDirectory, "grok-config.toml.missing"))).mode & 0o777).toBe(0o600);
    expect(calls.some((call) => call.includes("doctor"))).toBe(true);
  });

  it("任一 CLI 失败时回滚两份原配置", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aicanvas-agent-config-rollback-"));
    await Promise.all([mkdir(path.join(home, ".codex"), { recursive: true }), mkdir(path.join(home, ".grok"), { recursive: true })]);
    await Promise.all([
      writeFile(path.join(home, ".codex", "config.toml"), "codex-before\n", { mode: 0o600 }),
      writeFile(path.join(home, ".grok", "config.toml"), "grok-before\n", { mode: 0o600 }),
    ]);
    const runner: AgentConnectionCommandRunner = async (executable, args) => {
      if (args[1] !== "add") return { stdout: "", stderr: "" };
      if (executable.endsWith("codex")) {
        await writeFile(path.join(home, ".codex", "config.toml"), "codex-mutated\n");
        return { stdout: "", stderr: "" };
      }
      await writeFile(path.join(home, ".grok", "config.toml"), "grok-mutated\n");
      throw new Error("simulated grok failure");
    };
    await expect(repairAgentConnections({
      packaged: true,
      homeDirectory: home,
      codexExecutable: "/opt/test/codex",
      grokExecutable: "/opt/test/grok",
      launch,
      now: "2026-07-18T10:00:01.000Z",
    }, runner)).rejects.toThrow(/均已回滚/u);
    expect(await readFile(path.join(home, ".codex", "config.toml"), "utf8")).toBe("codex-before\n");
    expect(await readFile(path.join(home, ".grok", "config.toml"), "utf8")).toBe("grok-before\n");
  });
});
