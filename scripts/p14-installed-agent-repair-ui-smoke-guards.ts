import { createHash } from "node:crypto";
import path from "node:path";

export const P14_AGENT_REPAIR_SCREENSHOT = "01-agent-connection-repaired.png" as const;
const SHA256 = /^[a-f0-9]{64}$/u;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stable(entry)]));
}

export function p14AgentRepairEvidenceDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

export interface P14InstalledAgentRepairCli {
  executablePath: string;
  projectRoot: string;
  evidencePath: string;
  screenshotDirectory: string;
}

export interface P14InstalledAgentRepairEvidence {
  schemaVersion: 1;
  kind: "p14-installed-agent-repair-ui-smoke";
  status: "PASS";
  runtime: {
    installedBundle: true;
    localOnly: true;
    executablePathSha256: string;
    sourceDigest: string;
    buildId: string;
    mcpToolCount: number;
  };
  project: {
    projectRootPathSha256: string;
    managed: true;
    explicitActiveProject: true;
    defaultRegistry: true;
    before: { files: number; bytes: number; aggregateSha256: string };
    after: { files: number; bytes: number; aggregateSha256: string };
    unchanged: true;
  };
  agents: {
    repairButtonClicked: true;
    repairIpcCompletedAfterGrokDoctor: true;
    codexCurrent: true;
    grokCurrent: true;
    codexConfiguredRuntimeStarted: true;
    codexRuntimeToolCount: number;
  };
  backup: {
    newDirectoryCount: 1;
    directoryPathSha256: string;
    directoryMode: "0700";
    files: Array<{
      role: "codex-config" | "grok-config";
      originalState: "present" | "missing";
      sha256: string;
      mode: "0600";
      matchesPreRepairSnapshot: true;
    }>;
    preserved: true;
  };
  repairedConfigs: {
    codex: { state: "present"; sha256: string; mode: "0600" };
    grok: { state: "present"; sha256: string; mode: "0600" };
  };
  ui: {
    screenshot: {
      fileName: typeof P14_AGENT_REPAIR_SCREENSHOT;
      sha256: string;
      width: number;
      height: number;
      sizeBytes: number;
      maxChannelStandardDeviation: number;
    };
    pageErrorCount: 0;
    consoleErrorCount: 0;
    externalRequestCount: 0;
    highEntropyValueCount: 0;
  };
  boundaries: {
    realHome: true;
    isolatedUserData: true;
    noProjectWrites: true;
    noConfigContentsInEvidence: true;
    noSecretEnvironmentForwardedToMcpProbe: true;
    failureKeepsBackup: true;
  };
  fingerprint: string;
}

function absolute(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} 不能为空。`);
  if (!path.isAbsolute(value)) throw new Error(`${label} 必须是绝对路径。`);
  return path.normalize(value);
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function parseP14InstalledAgentRepairCli(argv: readonly string[]): P14InstalledAgentRepairCli {
  if (argv.length !== 4) {
    throw new Error("用法：tsx scripts/ui-p14-installed-agent-repair-smoke.ts <安装版可执行文件> <显式受管 projectRoot> <全新证据 JSON> <全新截图目录>");
  }
  const executablePath = absolute(argv[0] ?? "", "安装版可执行文件");
  const projectRoot = absolute(argv[1] ?? "", "projectRoot");
  const evidencePath = absolute(argv[2] ?? "", "证据 JSON");
  const screenshotDirectory = absolute(argv[3] ?? "", "截图目录");
  if (!/\.app\/Contents\/MacOS\/[^/]+$/u.test(executablePath)) throw new Error("只接受 .app/Contents/MacOS 内的安装版可执行文件。");
  if (path.extname(evidencePath).toLowerCase() !== ".json") throw new Error("证据路径必须以 .json 结尾。");
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const appRoot = executablePath.slice(0, executablePath.indexOf(marker));
  for (const [label, candidate] of [["证据 JSON", evidencePath], ["截图目录", screenshotDirectory]] as const) {
    if (isInside(appRoot, candidate)) throw new Error(`${label} 不得位于安装包内。`);
    if (isInside(projectRoot, candidate)) throw new Error(`${label} 不得位于验收工程内。`);
  }
  if (isInside(projectRoot, executablePath) || isInside(appRoot, projectRoot)) throw new Error("projectRoot 与安装包边界重叠。 ");
  return { executablePath, projectRoot, evidencePath, screenshotDirectory };
}

export function assertP14AgentRepairEvidenceHasNoSensitivePayload(value: unknown): void {
  const visit = (entry: unknown, key = "root"): void => {
    if (Array.isArray(entry)) return entry.forEach((item, index) => visit(item, `${key}[${index}]`));
    if (!entry || typeof entry !== "object") {
      if (typeof entry === "string" && path.isAbsolute(entry)) throw new Error(`证据包含绝对路径：${key}`);
      return;
    }
    for (const [childKey, child] of Object.entries(entry as Record<string, unknown>)) {
      if (/^(?:content|configContent|stdout|stderr|environment|env|command|arguments|apiKey|accessToken|refreshToken|password|secret)$/iu.test(childKey)) {
        throw new Error(`证据包含禁止字段：${childKey}`);
      }
      if (/path$/iu.test(childKey) && !/pathsha256$/iu.test(childKey)) throw new Error(`证据包含原始路径字段：${childKey}`);
      visit(child, `${key}.${childKey}`);
    }
  };
  visit(value);
}

export function assertP14InstalledAgentRepairEvidence(value: P14InstalledAgentRepairEvidence): void {
  assertP14AgentRepairEvidenceHasNoSensitivePayload(value);
  const failures: string[] = [];
  if (value.schemaVersion !== 1 || value.kind !== "p14-installed-agent-repair-ui-smoke" || value.status !== "PASS") failures.push("identity");
  if (!value.runtime.installedBundle || !value.runtime.localOnly) failures.push("runtime");
  for (const [label, digest] of [
    ["runtime.executablePathSha256", value.runtime.executablePathSha256],
    ["runtime.sourceDigest", value.runtime.sourceDigest],
    ["project.path", value.project.projectRootPathSha256],
    ["project.before", value.project.before.aggregateSha256],
    ["project.after", value.project.after.aggregateSha256],
    ["backup.path", value.backup.directoryPathSha256],
    ["ui.screenshot", value.ui.screenshot.sha256],
    ["fingerprint", value.fingerprint],
  ] as const) if (!SHA256.test(digest)) failures.push(label);
  if (!/^[a-f0-9]{32}$/u.test(value.runtime.buildId)) failures.push("runtime.buildId");
  if (!Number.isInteger(value.runtime.mcpToolCount) || value.runtime.mcpToolCount <= 0
    || value.agents.codexRuntimeToolCount !== value.runtime.mcpToolCount) failures.push("runtime.toolCount");
  if (!value.project.managed || !value.project.explicitActiveProject || !value.project.defaultRegistry || !value.project.unchanged
    || value.project.before.aggregateSha256 !== value.project.after.aggregateSha256
    || value.project.before.files !== value.project.after.files
    || value.project.before.bytes !== value.project.after.bytes) failures.push("project.unchanged");
  if (!value.agents.repairButtonClicked || !value.agents.repairIpcCompletedAfterGrokDoctor
    || !value.agents.codexCurrent || !value.agents.grokCurrent || !value.agents.codexConfiguredRuntimeStarted) failures.push("agents");
  if (value.backup.newDirectoryCount !== 1 || value.backup.directoryMode !== "0700" || !value.backup.preserved
    || value.backup.files.length !== 2
    || new Set(value.backup.files.map((entry) => entry.role)).size !== 2
    || value.backup.files.some((entry) => entry.mode !== "0600" || !entry.matchesPreRepairSnapshot || !SHA256.test(entry.sha256))) failures.push("backup");
  for (const config of [value.repairedConfigs.codex, value.repairedConfigs.grok]) {
    if (config.state !== "present" || config.mode !== "0600" || !SHA256.test(config.sha256)) failures.push("repairedConfigs");
  }
  const shot = value.ui.screenshot;
  if (shot.fileName !== P14_AGENT_REPAIR_SCREENSHOT || shot.width < 1_200 || shot.height < 700
    || shot.sizeBytes < 20_000 || shot.maxChannelStandardDeviation < 3) failures.push("screenshot");
  if (value.ui.pageErrorCount !== 0 || value.ui.consoleErrorCount !== 0 || value.ui.externalRequestCount !== 0
    || value.ui.highEntropyValueCount !== 0) failures.push("ui.errors");
  if (!value.boundaries.realHome || !value.boundaries.isolatedUserData || !value.boundaries.noProjectWrites
    || !value.boundaries.noConfigContentsInEvidence || !value.boundaries.noSecretEnvironmentForwardedToMcpProbe
    || !value.boundaries.failureKeepsBackup) failures.push("boundaries");
  const { fingerprint: _fingerprint, ...body } = value;
  if (p14AgentRepairEvidenceDigest(body) !== value.fingerprint) failures.push("fingerprint.content");
  if (failures.length) throw new Error(`P14 安装版 Agent 修复 smoke 证据不完整：${failures.join("；")}`);
}
