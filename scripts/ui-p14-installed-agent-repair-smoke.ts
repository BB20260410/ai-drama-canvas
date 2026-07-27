/**
 * P14 安装版 Agent 连接真实 UI smoke。
 *
 * 高风险边界：真实 HOME + 默认 registry + 真实 Codex/Grok CLI；只接受显式、
 * 已登记且当前活动的受管工程。Electron userData 隔离，工程前后逐文件快照；
 * 失败保留 owner 创建的配置备份，证据永不包含配置内容、密钥或原始路径。
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import sharp from "sharp";
import { inspectManagedProject } from "../src/core/managed-project.js";
import {
  createPackagedMcpRuntimeLaunchContract,
  readReleaseManifest,
  type McpRuntimeLaunchContract,
} from "../src/core/release-manifest.js";
import { getActiveProjectRegistration, writeJsonAtomicExclusive } from "../src/core/sidecar.js";
import {
  assertP14AgentRepairEvidenceHasNoSensitivePayload,
  assertP14InstalledAgentRepairEvidence,
  p14AgentRepairEvidenceDigest,
  P14_AGENT_REPAIR_SCREENSHOT,
  parseP14InstalledAgentRepairCli,
  type P14InstalledAgentRepairEvidence,
} from "./p14-installed-agent-repair-ui-smoke-guards.js";

const cli = parseP14InstalledAgentRepairCli(process.argv.slice(2));
let stage = "preflight";
let application: ElectronApplication | undefined;
let runtimeRoot: string | undefined;
let backupCreated = false;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

interface ProjectInventory {
  files: number;
  bytes: number;
  aggregateSha256: string;
}

async function projectInventory(projectRoot: string): Promise<ProjectInventory> {
  const rows: string[] = [];
  let files = 0;
  let bytes = 0;
  const visit = async (absolute: string, relative: string): Promise<void> => {
    const metadata = await lstat(absolute, { bigint: true });
    const safeRelative = relative.split(path.sep).join("/");
    if (metadata.isSymbolicLink()) {
      rows.push(`L\0${safeRelative}\0${await readlink(absolute)}\0${metadata.mode.toString()}`);
      return;
    }
    if (metadata.isDirectory()) {
      // 运行时锁/WAL 会短暂创建并删除文件，从而改变父目录 mtime/ctime；
      // 它不代表工程内容被修改。目录只比较结构与权限，文件继续逐项比较内容 SHA。
      rows.push(`D\0${safeRelative}\0${metadata.mode.toString()}`);
      const entries = (await readdir(absolute)).sort((left, right) => left.localeCompare(right, "en"));
      for (const name of entries) await visit(path.join(absolute, name), relative ? path.join(relative, name) : name);
      return;
    }
    if (!metadata.isFile()) throw new Error("工程包含不支持的特殊文件，拒绝验收。 ");
    const size = Number(metadata.size);
    files += 1;
    bytes += size;
    rows.push(`F\0${safeRelative}\0${size}\0${await sha256File(absolute)}\0${metadata.mode.toString()}`);
  };
  await visit(projectRoot, "");
  return { files, bytes, aggregateSha256: sha256(rows.join("\n")) };
}

interface FileSnapshot {
  state: "present" | "missing";
  sha256?: string;
  mode?: string;
}

async function snapshotFile(filePath: string): Promise<FileSnapshot> {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error("配置路径不是普通文件。 ");
    return { state: "present", sha256: await sha256File(filePath), mode: modeString(metadata.mode) };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    throw error;
  }
}

async function backupDirectories(parent: string): Promise<string[]> {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(parent, entry.name)).sort((left, right) => left.localeCompare(right, "en"));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function childEnvironment(home: string, overrides: Record<string, string> = {}): Record<string, string> {
  const allowed = ["PATH", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "SSH_AUTH_SOCK"] as const;
  const env: Record<string, string> = { HOME: home, NO_COLOR: "1", ...overrides };
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function probeConfiguredMcpRuntime(
  launch: McpRuntimeLaunchContract,
  home: string,
  expectedToolCount: number,
): Promise<number> {
  const transport = new StdioClientTransport({
    command: launch.command,
    args: [...launch.args],
    cwd: launch.cwd,
    env: childEnvironment(home, launch.env),
    stderr: "pipe",
  });
  const client = new Client({ name: "p14-installed-agent-repair-smoke", version: "0.2.0" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    if (tools.length !== expectedToolCount || !tools.some((tool) => tool.name === "get_capabilities")) {
      throw new Error("安装版 MCP runtime 工具身份不匹配。 ");
    }
    return tools.length;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function writeEvidence(value: unknown): Promise<void> {
  assertP14AgentRepairEvidenceHasNoSensitivePayload(value);
  const result = await writeJsonAtomicExclusive(cli.evidencePath, value);
  if (result !== "created") throw new Error("证据路径已存在，拒绝覆盖。 ");
}

async function run(): Promise<void> {
  if (process.env.AI_CANVAS_REGISTRY_PATH?.trim()) throw new Error("只允许默认 registry；当前进程存在覆盖变量。 ");
  await access(cli.evidencePath).then(() => { throw new Error("证据路径已存在，拒绝覆盖。 "); }, () => undefined);
  await access(cli.screenshotDirectory).then(() => { throw new Error("截图目录必须是全新路径。 "); }, () => undefined);
  const executable = await realpath(cli.executablePath);
  const executableMetadata = await stat(executable);
  if (!executableMetadata.isFile()) throw new Error("安装版 executable 不是普通文件。 ");
  await access(executable, constants.X_OK);
  const projectRoot = await realpath(cli.projectRoot);
  const projectMetadata = await stat(projectRoot);
  if (!projectMetadata.isDirectory()) throw new Error("projectRoot 不是目录。 ");
  const managed = await inspectManagedProject(projectRoot);
  const active = await getActiveProjectRegistration();
  if (!active || await realpath(active.primaryRoot).catch(() => "") !== projectRoot) {
    throw new Error("显式受管工程不是默认 registry 中明确的当前活动工程，拒绝猜测或切换。 ");
  }

  const home = await realpath(os.homedir());
  const defaultRegistryPath = path.join(home, ".aicanvas", "projects.json");
  await access(defaultRegistryPath);
  const appMarker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const appRoot = executable.slice(0, executable.indexOf(appMarker));
  const resourcesRoot = path.join(appRoot, "Contents", "Resources");
  const releaseManifestPath = path.join(resourcesRoot, "release-manifest.json");
  const serverPath = path.join(resourcesRoot, "app.asar.unpacked", "dist-mcp", "mcp", "server.js");
  const release = await readReleaseManifest(releaseManifestPath);
  if (!release.localOnly || release.distribution !== "local-only") throw new Error("只允许 local-only 安装版。 ");
  await access(serverPath);
  const launch = createPackagedMcpRuntimeLaunchContract({
    appExecutable: executable,
    serverPath,
    releaseManifestPath,
    sourceDigest: release.sourceDigest,
    runtimeArtifactSha256: await sha256File(serverPath),
    builtAt: release.builtAt,
    workspacePath: resourcesRoot,
    registryPath: defaultRegistryPath,
  });

  await mkdir(path.dirname(cli.evidencePath), { recursive: true });
  await mkdir(path.dirname(cli.screenshotDirectory), { recursive: true });
  await mkdir(cli.screenshotDirectory);
  runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "p14-agent-repair-ui-")));
  const userDataRoot = path.join(runtimeRoot, "electron-user-data");
  await mkdir(userDataRoot, { recursive: true });

  const backupParent = path.join(home, ".aicanvas", "agent-config-backups");
  const configPaths = {
    codex: path.join(home, ".codex", "config.toml"),
    grok: path.join(home, ".grok", "config.toml"),
  };
  stage = "snapshot-before";
  const [projectBefore, codexBefore, grokBefore, backupsBefore, executableSha256] = await Promise.all([
    projectInventory(projectRoot),
    snapshotFile(configPaths.codex),
    snapshotFile(configPaths.grok),
    backupDirectories(backupParent),
    sha256File(executable),
  ]);

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  stage = "launch-ui";
  application = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userDataRoot}`],
    cwd: runtimeRoot,
    env: childEnvironment(home, {
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    }),
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(120_000);
  page.on("pageerror", (error) => pageErrors.push(sha256(error.message)));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(sha256(message.text())); });
  page.on("request", (request) => { if (/^https?:/iu.test(request.url())) externalRequests.push(sha256(request.url())); });
  await page.setViewportSize({ width: 1728, height: 1029 });
  await page.locator('[data-testid="material-studio-view"]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="material-studio-view"]')?.getAttribute("aria-busy") === "false");
  const activeUi = await page.evaluate(async () => {
    const bridge = (window as unknown as {
      canvasApi: { getActiveProject(): Promise<{ primaryRoot: string; available: boolean } | null> };
    }).canvasApi;
    const activeProject = await bridge.getActiveProject();
    return activeProject ? { primaryRoot: activeProject.primaryRoot, available: activeProject.available } : null;
  });
  if (!activeUi?.available || await realpath(activeUi.primaryRoot).catch(() => "") !== projectRoot) {
    throw new Error("安装版 UI 未打开显式活动工程。 ");
  }

  stage = "ui-repair";
  await page.getByRole("button", { name: "Agent 连接", exact: true }).click();
  const support = page.locator('[data-testid="desktop-support-view"]');
  await support.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="desktop-support-view"]')?.getAttribute("aria-busy") === "false");
  const repairButton = support.getByRole("button", { name: "备份并修复 Agent 连接", exact: true });
  if (await repairButton.isDisabled()) throw new Error("安装版 Agent 修复按钮不可用。 ");
  await repairButton.click();
  await support.locator(".notice").filter({ hasText: "Agent 连接已备份并修复。" }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="desktop-support-view"]')?.getAttribute("aria-busy") === "false");
  const connectionText = await support.innerText();
  if ((connectionText.match(/已连接当前版本/gu) ?? []).length !== 2) throw new Error("Codex/Grok 未同时显示当前版本。 ");
  const highEntropyValues = connectionText.match(/[A-Za-z0-9_=-]{40,}/gu) ?? [];
  const status = await page.evaluate(async (root) => {
    const bridge = (window as unknown as {
      canvasApi: {
        getAgentConnectionStatus(projectRoot: string): Promise<{
          codex: { current: boolean };
          grok: { current: boolean };
          packaged: boolean;
          serverAvailable: boolean;
        }>;
      };
    }).canvasApi;
    const current = await bridge.getAgentConnectionStatus(root);
    return {
      codexCurrent: current.codex.current,
      grokCurrent: current.grok.current,
      packaged: current.packaged,
      serverAvailable: current.serverAvailable,
    };
  }, projectRoot);
  if (!status.packaged || !status.serverAvailable || !status.codexCurrent || !status.grokCurrent) {
    throw new Error("修复后的 Agent 状态未通过。 ");
  }

  const screenshotPath = path.join(cli.screenshotDirectory, P14_AGENT_REPAIR_SCREENSHOT);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const screenshotBytes = await readFile(screenshotPath);
  const [screenshotMetadata, screenshotStats, screenshotFileStats] = await Promise.all([
    sharp(screenshotBytes).metadata(),
    sharp(screenshotBytes).stats(),
    stat(screenshotPath),
  ]);
  const screenshot = {
    fileName: P14_AGENT_REPAIR_SCREENSHOT,
    sha256: sha256(screenshotBytes),
    width: screenshotMetadata.width ?? 0,
    height: screenshotMetadata.height ?? 0,
    sizeBytes: screenshotFileStats.size,
    maxChannelStandardDeviation: Math.max(...screenshotStats.channels.map((channel) => channel.stdev)),
  };

  stage = "verify-backup";
  const backupsAfter = await backupDirectories(backupParent);
  const previousBackups = new Set(backupsBefore);
  const newBackups = backupsAfter.filter((candidate) => !previousBackups.has(candidate));
  if (newBackups.length !== 1) throw new Error("Agent 修复未产生唯一的新备份目录。 ");
  backupCreated = true;
  const backupDirectory = await realpath(newBackups[0]!);
  const backupDirectoryMetadata = await stat(backupDirectory);
  if (modeString(backupDirectoryMetadata.mode) !== "0700") throw new Error("Agent 备份目录权限不是 0700。 ");
  const backupNames = (await readdir(backupDirectory)).sort((left, right) => left.localeCompare(right, "en"));
  const expectedBackupName = (client: "codex" | "grok", before: FileSnapshot) => `${client}-config.toml${before.state === "missing" ? ".missing" : ""}`;
  const expectedNames = [expectedBackupName("codex", codexBefore), expectedBackupName("grok", grokBefore)].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(backupNames) !== JSON.stringify(expectedNames)) throw new Error("Agent 备份文件集合不精确。 ");
  const missingMarkerSha256 = sha256("original-config-missing\n");
  const backupFiles = await Promise.all(([
    ["codex", codexBefore],
    ["grok", grokBefore],
  ] as const).map(async ([client, before]) => {
    const backupPath = path.join(backupDirectory, expectedBackupName(client, before));
    const metadata = await stat(backupPath);
    const fileSha256 = await sha256File(backupPath);
    const expectedSha256 = before.state === "present" ? before.sha256 : missingMarkerSha256;
    if (!metadata.isFile() || modeString(metadata.mode) !== "0600" || fileSha256 !== expectedSha256) {
      throw new Error("Agent 备份内容身份或权限不匹配。 ");
    }
    return {
      role: `${client}-config` as "codex-config" | "grok-config",
      originalState: before.state,
      sha256: fileSha256,
      mode: "0600" as const,
      matchesPreRepairSnapshot: true as const,
    };
  }));
  const [codexAfter, grokAfter] = await Promise.all([snapshotFile(configPaths.codex), snapshotFile(configPaths.grok)]);
  for (const current of [codexAfter, grokAfter]) {
    if (current.state !== "present" || current.mode !== "0600" || !current.sha256) throw new Error("修复后的 Agent 配置身份或权限无效。 ");
  }

  stage = "mcp-runtime-probe";
  const codexRuntimeToolCount = await probeConfiguredMcpRuntime(launch, home, release.mcpToolCount);
  await application.close();
  application = undefined;

  stage = "snapshot-after";
  const projectAfter = await projectInventory(projectRoot);
  if (JSON.stringify(projectAfter) !== JSON.stringify(projectBefore)) throw new Error("Agent 修复 smoke 改写了验收工程。 ");
  if (pageErrors.length || consoleErrors.length || externalRequests.length || highEntropyValues.length) {
    throw new Error("Agent 修复 UI 出现错误、外部请求或疑似高熵敏感值。 ");
  }

  const semantic = {
    schemaVersion: 1 as const,
    kind: "p14-installed-agent-repair-ui-smoke" as const,
    status: "PASS" as const,
    runtime: {
      installedBundle: true as const,
      localOnly: true as const,
      executablePathSha256: executableSha256,
      sourceDigest: release.sourceDigest,
      buildId: release.buildId,
      mcpToolCount: release.mcpToolCount,
    },
    project: {
      projectRootPathSha256: sha256(projectRoot),
      managed: Boolean(managed) as true,
      explicitActiveProject: true as const,
      defaultRegistry: true as const,
      before: projectBefore,
      after: projectAfter,
      unchanged: true as const,
    },
    agents: {
      repairButtonClicked: true as const,
      repairIpcCompletedAfterGrokDoctor: true as const,
      codexCurrent: true as const,
      grokCurrent: true as const,
      codexConfiguredRuntimeStarted: true as const,
      codexRuntimeToolCount,
    },
    backup: {
      newDirectoryCount: 1 as const,
      directoryPathSha256: sha256(backupDirectory),
      directoryMode: "0700" as const,
      files: backupFiles,
      preserved: true as const,
    },
    repairedConfigs: {
      codex: { state: "present" as const, sha256: codexAfter.sha256!, mode: "0600" as const },
      grok: { state: "present" as const, sha256: grokAfter.sha256!, mode: "0600" as const },
    },
    ui: {
      screenshot,
      pageErrorCount: 0 as const,
      consoleErrorCount: 0 as const,
      externalRequestCount: 0 as const,
      highEntropyValueCount: 0 as const,
    },
    boundaries: {
      realHome: true as const,
      isolatedUserData: true as const,
      noProjectWrites: true as const,
      noConfigContentsInEvidence: true as const,
      noSecretEnvironmentForwardedToMcpProbe: true as const,
      failureKeepsBackup: true as const,
    },
  };
  const evidence = { ...semantic, fingerprint: p14AgentRepairEvidenceDigest(semantic) } satisfies P14InstalledAgentRepairEvidence;
  assertP14InstalledAgentRepairEvidence(evidence);
  stage = "write-pass-evidence";
  await writeEvidence(evidence);
  process.stdout.write(`${JSON.stringify({ ok: true, fingerprint: evidence.fingerprint })}\n`);
}

try {
  await run();
} catch (error) {
  await application?.close().catch(() => undefined);
  application = undefined;
  const failure = {
    schemaVersion: 1,
    kind: "p14-installed-agent-repair-ui-smoke",
    status: "FAIL",
    stage,
    errorSha256: sha256(error instanceof Error ? error.message : String(error)),
    knownBackupCreated: backupCreated,
    backupDeletionAttempted: false,
    rawAbsoluteLocationStored: false,
    configurationPayloadStored: false,
    credentialPayloadStored: false,
  };
  await access(cli.evidencePath).then(() => undefined, () => writeEvidence(failure)).catch(() => undefined);
  process.stderr.write(`${JSON.stringify({ ok: false, stage, errorSha256: failure.errorSha256 })}\n`);
  process.exitCode = 1;
} finally {
  if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
}
