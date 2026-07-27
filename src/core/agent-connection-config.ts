import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpRuntimeLaunchContract } from "./release-manifest.js";

export const AI_DRAMA_CANVAS_MCP_SERVER_NAME = "ai-drama-canvas" as const;

export interface AgentConnectionCommandResult {
  stdout: string;
  stderr: string;
}

export interface AgentConnectionCommandOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type AgentConnectionCommandRunner = (
  executable: string,
  args: readonly string[],
  options: AgentConnectionCommandOptions,
) => Promise<AgentConnectionCommandResult>;

export interface AgentConnectionClientStatus {
  installed: boolean;
  configured: boolean;
  current: boolean;
  issue?: "not-installed" | "not-configured" | "runtime-mismatch" | "inspection-failed";
}

export interface AgentConnectionsInspection {
  codex: AgentConnectionClientStatus;
  grok: AgentConnectionClientStatus;
  allCurrent: boolean;
}

interface ConfigSnapshot {
  client: "codex" | "grok";
  configPath: string;
  existed: boolean;
  content?: Buffer;
  mode?: number;
}

export interface RepairAgentConnectionsInput {
  packaged: boolean;
  homeDirectory: string;
  codexExecutable: string;
  grokExecutable: string;
  launch: McpRuntimeLaunchContract;
  now?: string;
}

export interface RepairAgentConnectionsResult {
  backupDirectory: string;
  codex: AgentConnectionClientStatus;
  grok: AgentConnectionClientStatus;
}

function commandEnvironment(homeDirectory: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: path.resolve(homeDirectory) };
}

function assertLaunchContract(launch: McpRuntimeLaunchContract): void {
  if (launch.kind !== "packaged-mcp-runtime-launch-contract"
    || launch.command !== "/usr/bin/env"
    || launch.args[0] !== "ELECTRON_RUN_AS_NODE=1"
    || Object.hasOwn(launch.env, "AI_CANVAS_PROJECT_ROOT")) {
    throw new Error("Agent 连接只接受不绑定具体工程的安装版 MCP runtime。 ");
  }
  for (const key of [
    "AI_CANVAS_REGISTRY_PATH",
    "AI_CANVAS_RELEASE_MANIFEST_PATH",
    "AI_CANVAS_WORKSPACE",
    "AI_CANVAS_RECORDED_SOURCE_DIGEST",
    "AI_CANVAS_RECORDED_RUNTIME_ARTIFACT_SHA256",
    "AI_CANVAS_BUILD_TIMESTAMP",
  ] as const) {
    if (!launch.env[key]?.trim()) throw new Error(`Agent 连接 runtime 缺少 ${key}。`);
  }
}

function sortedEnvironmentEntries(launch: McpRuntimeLaunchContract): Array<[string, string]> {
  return Object.entries(launch.env).sort(([left], [right]) => left.localeCompare(right, "en"));
}

export function buildAgentConnectionCliArguments(
  client: "codex" | "grok",
  launch: McpRuntimeLaunchContract,
): string[] {
  assertLaunchContract(launch);
  const environment = sortedEnvironmentEntries(launch);
  if (client === "codex") {
    return [
      "mcp", "add", AI_DRAMA_CANVAS_MCP_SERVER_NAME,
      ...environment.flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--", launch.command, ...launch.args,
    ];
  }
  return [
    "mcp", "add", "--scope", "user", AI_DRAMA_CANVAS_MCP_SERVER_NAME,
    ...environment.flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    "--", launch.command, ...launch.args,
  ];
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function sameEnvironment(value: unknown, expected: McpRuntimeLaunchContract["env"]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  if (Object.hasOwn(actual, "AI_CANVAS_PROJECT_ROOT")) return false;
  const actualKeys = Object.keys(actual).sort((left, right) => left.localeCompare(right, "en"));
  const expectedKeys = Object.keys(expected).sort((left, right) => left.localeCompare(right, "en"));
  return sameStringArray(actualKeys, expectedKeys)
    && expectedKeys.every((key) => actual[key] === expected[key as keyof typeof expected]);
}

function matchesRuntime(entry: unknown, launch: McpRuntimeLaunchContract): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const candidate = entry as Record<string, unknown>;
  return candidate.command === launch.command
    && sameStringArray(candidate.args, launch.args)
    && sameEnvironment(candidate.env, launch.env);
}

export function inspectCodexMcpConfiguration(
  json: string,
  launch: McpRuntimeLaunchContract,
): AgentConnectionClientStatus {
  try {
    const parsed = JSON.parse(json) as { name?: unknown; transport?: unknown };
    const transport = parsed.transport && typeof parsed.transport === "object" && !Array.isArray(parsed.transport)
      ? parsed.transport as Record<string, unknown>
      : undefined;
    const configured = parsed.name === AI_DRAMA_CANVAS_MCP_SERVER_NAME && transport?.type === "stdio";
    const current = configured && matchesRuntime(transport, launch);
    return { installed: true, configured, current, ...(!configured ? { issue: "not-configured" as const } : !current ? { issue: "runtime-mismatch" as const } : {}) };
  } catch {
    return { installed: true, configured: false, current: false, issue: "inspection-failed" };
  }
}

export function inspectGrokMcpConfiguration(
  json: string,
  launch: McpRuntimeLaunchContract,
): AgentConnectionClientStatus {
  try {
    const parsed = JSON.parse(json) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [];
    const entry = entries.find((candidate) => candidate && typeof candidate === "object"
      && (candidate as Record<string, unknown>).name === AI_DRAMA_CANVAS_MCP_SERVER_NAME);
    const configured = Boolean(entry);
    const current = configured && matchesRuntime(entry, launch);
    return { installed: true, configured, current, ...(!configured ? { issue: "not-configured" as const } : !current ? { issue: "runtime-mismatch" as const } : {}) };
  } catch {
    return { installed: true, configured: false, current: false, issue: "inspection-failed" };
  }
}

export function createExecFileAgentConnectionRunner(): AgentConnectionCommandRunner {
  return (executable, args, options) => new Promise((resolve, reject) => {
    execFile(executable, [...args], {
      encoding: "utf8",
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Agent CLI 命令失败：${path.basename(executable)} ${args.slice(0, 2).join(" ")}。`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function inspectClient(
  client: "codex" | "grok",
  executable: string | undefined,
  launch: McpRuntimeLaunchContract,
  homeDirectory: string,
  runner: AgentConnectionCommandRunner,
): Promise<AgentConnectionClientStatus> {
  if (!executable) return { installed: false, configured: false, current: false, issue: "not-installed" };
  try {
    const result = client === "codex"
      ? await runner(executable, ["mcp", "get", AI_DRAMA_CANVAS_MCP_SERVER_NAME, "--json"], { env: commandEnvironment(homeDirectory), timeoutMs: 15_000 })
      : await runner(executable, ["mcp", "list", "--json"], { env: commandEnvironment(homeDirectory), timeoutMs: 15_000 });
    return client === "codex"
      ? inspectCodexMcpConfiguration(result.stdout, launch)
      : inspectGrokMcpConfiguration(result.stdout, launch);
  } catch {
    return { installed: true, configured: false, current: false, issue: "inspection-failed" };
  }
}

export async function inspectAgentConnections(
  input: Pick<RepairAgentConnectionsInput, "homeDirectory" | "launch">
    & Partial<Pick<RepairAgentConnectionsInput, "codexExecutable" | "grokExecutable">>,
  runner: AgentConnectionCommandRunner = createExecFileAgentConnectionRunner(),
): Promise<AgentConnectionsInspection> {
  assertLaunchContract(input.launch);
  const [codex, grok] = await Promise.all([
    inspectClient("codex", input.codexExecutable, input.launch, input.homeDirectory, runner),
    inspectClient("grok", input.grokExecutable, input.launch, input.homeDirectory, runner),
  ]);
  return { codex, grok, allCurrent: codex.current && grok.current };
}

async function snapshotConfig(client: "codex" | "grok", configPath: string): Promise<ConfigSnapshot> {
  try {
    const [content, metadata] = await Promise.all([readFile(configPath), stat(configPath)]);
    return { client, configPath, existed: true, content, mode: metadata.mode & 0o777 };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { client, configPath, existed: false };
    }
    throw error;
  }
}

async function writeBytesAtomic(filePath: string, content: Buffer, mode: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    await chmod(temporary, mode);
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function persistBackup(snapshot: ConfigSnapshot, backupDirectory: string): Promise<void> {
  const name = `${snapshot.client}-config.toml`;
  if (snapshot.existed && snapshot.content) {
    const target = path.join(backupDirectory, name);
    await writeFile(target, snapshot.content, { flag: "wx", mode: 0o600 });
    await chmod(target, 0o600);
    return;
  }
  const marker = path.join(backupDirectory, `${name}.missing`);
  await writeFile(marker, "original-config-missing\n", { flag: "wx", mode: 0o600 });
  await chmod(marker, 0o600);
}

async function restoreSnapshot(snapshot: ConfigSnapshot): Promise<void> {
  if (!snapshot.existed) {
    await rm(snapshot.configPath, { force: true });
    return;
  }
  await writeBytesAtomic(snapshot.configPath, snapshot.content!, snapshot.mode ?? 0o600);
}

export async function repairAgentConnections(
  input: RepairAgentConnectionsInput,
  runner: AgentConnectionCommandRunner = createExecFileAgentConnectionRunner(),
): Promise<RepairAgentConnectionsResult> {
  if (!input.packaged) throw new Error("Agent 连接自动修复仅允许在已安装应用中执行。 ");
  if (!path.isAbsolute(input.codexExecutable) || !path.isAbsolute(input.grokExecutable)) {
    throw new Error("Codex 与 Grok CLI 必须使用已验证的绝对路径。 ");
  }
  assertLaunchContract(input.launch);
  const homeDirectory = path.resolve(input.homeDirectory);
  const configPaths = {
    codex: path.join(homeDirectory, ".codex", "config.toml"),
    grok: path.join(homeDirectory, ".grok", "config.toml"),
  };
  const snapshots = await Promise.all([
    snapshotConfig("codex", configPaths.codex),
    snapshotConfig("grok", configPaths.grok),
  ]);
  const timestamp = (input.now ?? new Date().toISOString()).replace(/[:.]/gu, "-");
  const backupParent = path.join(homeDirectory, ".aicanvas", "agent-config-backups");
  await mkdir(backupParent, { recursive: true, mode: 0o700 });
  await chmod(backupParent, 0o700);
  const backupDirectory = path.join(backupParent, timestamp);
  await mkdir(backupDirectory, { recursive: false, mode: 0o700 });
  await chmod(backupDirectory, 0o700);
  await Promise.all(snapshots.map((snapshot) => persistBackup(snapshot, backupDirectory)));

  const env = commandEnvironment(homeDirectory);
  try {
    await runner(input.codexExecutable, buildAgentConnectionCliArguments("codex", input.launch), { env, timeoutMs: 30_000 });
    await runner(input.grokExecutable, buildAgentConnectionCliArguments("grok", input.launch), { env, timeoutMs: 30_000 });
    await Promise.all(Object.values(configPaths).map((configPath) => chmod(configPath, 0o600)));

    const inspection = await inspectAgentConnections({
      homeDirectory,
      codexExecutable: input.codexExecutable,
      grokExecutable: input.grokExecutable,
      launch: input.launch,
    }, runner);
    if (!inspection.allCurrent) throw new Error("Agent CLI 写入后配置身份仍不一致。 ");
    // Grok 的 doctor 会真实启动同一安装版 runtime；输出不回传到 UI。
    await runner(input.grokExecutable, ["mcp", "doctor", "--json", AI_DRAMA_CANVAS_MCP_SERVER_NAME], { env, timeoutMs: 30_000 });
    return { backupDirectory, codex: inspection.codex, grok: inspection.grok };
  } catch (error) {
    await Promise.all(snapshots.map((snapshot) => restoreSnapshot(snapshot)));
    throw new Error(`Agent 连接修复失败，Codex 与 Grok 配置均已回滚：${error instanceof Error ? error.message : String(error)}`);
  }
}
