import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import fg from "fast-glob";
import sharp from "sharp";
import {
  FUSION_PANEL_REFERENCE_CONTRACT_COVERAGE_VERSION,
  FUSION_PANEL_REFERENCE_RESOLVER_VERSION,
  gridSelectionSemanticDigest,
  inspectFusionPanelReferenceCurrentness,
  loadFusionPanelReferenceStore,
  type DerivedPanelReferenceAsset,
  type FusionPanelReferenceAudit,
  type FusionPanelReferenceResolutionStore,
  type PanelReferenceResolution,
} from "../src/core/fusion-panel-references.js";
import { loadFusionProductionAssets, loadFusionProjectManifest } from "../src/core/fusion-production.js";
import { normalizeFusionStoryboardGridContract, type FusionStoryboardGridContract } from "../src/core/fusion-storyboard-grid.js";
import { getSidecarPaths, readJson, writeJsonAtomicExclusive } from "../src/core/sidecar.js";
import type {
  FusionStoryboardGridSelection,
  FusionStoryboardGridSelectionStore,
  GenerationJob,
  ProjectIndex,
  ReviewStore,
  StoryboardStore,
} from "../src/core/types.js";
import type { PublicationStore } from "../src/core/publication.js";

const EXPECTED_SOURCE = {
  files: 3_344,
  bytes: 24_570_877,
  aggregateSha256: "649160f22663ca4c45ee4a4084e278ef0edc61ec66db01bb84da38cbea3f8d26",
} as const;
const EXPECTED_DISTRIBUTION = { "2": 151, "3": 667, "4": 349, "5": 95, "6": 26 } as const;
const EXPECTED_AUDIT = {
  contractCoverageVersion: FUSION_PANEL_REFERENCE_CONTRACT_COVERAGE_VERSION,
  currentContracts: 1_288,
  panels: 4_330,
  semanticAssetBindings: 13_812,
  referenceSlots: 12_720,
  confirmedEmptyPanels: 10,
  generationReadyPanels: 610,
  pendingHardLockPanels: 3_554,
  pendingHardLockReferences: 7_480,
  pendingDerivedArtifactPanels: 166,
  detectedOverflowPanels: 166,
  derivedDefinitions: 52,
  detectedRowContinuityDifferencePanels: 913,
  detectedRowContinuityDifferences: 1_994,
  maximumSemanticAssetsPerPanel: 12,
  maximumReferenceSlotsPerPanel: 6,
} as const;
const EXPECTED_CONTRACT_SEMANTIC_COVERAGE = {
  panelsChecked: 4_330,
  contractAssetBindings: 12_754,
  explicitlyExcludedContractAssetBindings: 248,
  requiredContractAssetBindings: 12_506,
  continuityReferenceBindings: 4,
  semanticExtraBindings: 1_306,
  ep01Unit008P01ContinuityPanels: 4,
} as const;
const UNKNOWN_JOB_ID = "gen-2026-07-16T12-10-57-215Z-892023c0";
const OBSOLETE_TERMINAL_JOB_ID = "gen-2026-07-16T09-57-05-901Z-1515bab0";
const PRESERVED_UNITS = ["season-三-ep01-unit001", "season-三-ep01-unit008"] as const;
const FORMAL_P01_HARD_LOCK_SHA256 = "907e96df267d3520c302ea2dad36afa5f6c42181f28492bd35a22450e5ad70a5";

interface CliOptions {
  workspace: string;
  projectRoot: string;
  sourceRoot: string;
  evidencePath: string;
  migrationEvidencePath: string;
  mcpEvidencePath: string;
  uiEvidencePath: string;
  uiScreenshotPath: string;
  runRoot: string;
  validateOnly: boolean;
  writeEvidence: boolean;
}

interface FileEvidence {
  path: string;
  bytes: number;
  sha256: string;
}

interface SourceSnapshot {
  files: number;
  bytes: number;
  aggregateSha256: string;
}

interface RunEvidence {
  name: string;
  argv: string[];
  cwd: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number;
  termination: {
    timeoutMs: number;
    timedOut: boolean;
    signalsSent: string[];
    exitSignal?: string;
    spawnError?: string;
  };
  stdout: FileEvidence & { tail: string[] };
  stderr: FileEvidence & { tail: string[] };
  testSummary?: { filesPassed: number; testsPassed: number };
}

function usage(): string {
  return `P2 逐分镜引用闭包最终关账（正式 production 只读）

用法：
  npm run validate:p2-panel-reference-closure -- [参数]

参数：
  --workspace <path>
  --project-root <path>
  --source-root <path>
  --migration-evidence <json>
  --mcp-evidence <json>
  --ui-evidence <json>
  --ui-screenshot <png>
  --evidence <json>         最终机器证据路径（仅 workspace/docs/evidence）
  --run-root <dir>         六项命令的独占日志目录（仅 workspace/docs/evidence）
  --validate-only         不再启动测试/MCP/UI，只读复核已有证据，不写 final JSON
  --help

默认正式关账会运行 typecheck、P2 定向、全量测试、build、编译 MCP 和 Electron UI 烟测，并独占写证据。
它不执行迁移或重新物化；MCP/UI 只读正式 production。
`;
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少路径参数。`);
  return value;
}

function options(argv: string[]): CliOptions {
  const workspace = path.resolve(optionValue(argv, "--workspace") ?? "/Users/hxx/Documents/无限画布");
  const validateOnly = argv.includes("--validate-only");
  return {
    workspace,
    projectRoot: path.resolve(optionValue(argv, "--project-root") ?? path.join(workspace, "productions/gushujuan-s3-f1a688020bfb7af6")),
    sourceRoot: path.resolve(optionValue(argv, "--source-root") ?? "/Users/hxx/Documents/古蜀卷第三季"),
    evidencePath: path.resolve(optionValue(argv, "--evidence") ?? path.join(workspace, "docs/evidence/final-validation-20260717-p2-panel-reference-closure-corrected.json")),
    migrationEvidencePath: path.resolve(optionValue(argv, "--migration-evidence") ?? path.join(workspace, "docs/evidence/p2-panel-reference-migration-corrected-20260717.json")),
    mcpEvidencePath: path.resolve(optionValue(argv, "--mcp-evidence") ?? path.join(workspace, "docs/evidence/p2-panel-reference-mcp-final-corrected-20260717.json")),
    uiEvidencePath: path.resolve(optionValue(argv, "--ui-evidence") ?? path.join(workspace, "docs/evidence/p2-panel-reference-ui-final-corrected-20260717.json")),
    uiScreenshotPath: path.resolve(optionValue(argv, "--ui-screenshot") ?? path.join(workspace, "docs/evidence/p2-panel-reference-ui-final-corrected-20260717.png")),
    runRoot: path.resolve(optionValue(argv, "--run-root") ?? path.join(workspace, "docs/evidence/p2-panel-reference-closure-corrected-runs-20260717-01")),
    validateOnly,
    writeEvidence: !validateOnly,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function nearestExistingRealPath(candidate: string): Promise<{ real: string; suffix: string[] }> {
  const suffix: string[] = [];
  let cursor = path.resolve(candidate);
  while (!await exists(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`无法找到证据路径的现存父目录：${candidate}`);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return { real: await realpath(cursor), suffix };
}

async function assertSafeEvidencePaths(input: CliOptions): Promise<void> {
  const evidenceRoot = path.resolve(input.workspace, "docs/evidence");
  const [canonicalWorkspace, canonicalRoot, canonicalProject, canonicalSource] = await Promise.all([
    realpath(input.workspace),
    realpath(evidenceRoot),
    realpath(input.projectRoot),
    realpath(input.sourceRoot),
  ]);
  if (!isInside(canonicalWorkspace, canonicalRoot)
    || isInside(canonicalProject, canonicalRoot)
    || isInside(canonicalSource, canonicalRoot)) {
    throw new Error("workspace/docs/evidence 经符号链接解析后不在工作区安全证据树内。");
  }
  const targets = [
    ["final evidence", input.evidencePath],
    ["migration evidence", input.migrationEvidencePath],
    ["MCP evidence", input.mcpEvidencePath],
    ["UI evidence", input.uiEvidencePath],
    ["UI screenshot", input.uiScreenshotPath],
    ["run root", input.runRoot],
  ] as const;
  const resolvedTargets = new Set<string>();
  for (const [label, candidate] of targets) {
    const target = path.resolve(candidate);
    if (target === evidenceRoot || !isInside(evidenceRoot, target)) {
      throw new Error(`${label} 必须位于 workspace/docs/evidence 内：${target}`);
    }
    if (isInside(input.projectRoot, target) || isInside(input.sourceRoot, target)) {
      throw new Error(`${label} 不得位于正式 production 或只读源内：${target}`);
    }
    const parent = await nearestExistingRealPath(path.dirname(target));
    const canonicalTarget = await exists(target)
      ? await realpath(target)
      : path.join(parent.real, ...parent.suffix, path.basename(target));
    if (!isInside(canonicalRoot, canonicalTarget)
      || isInside(canonicalProject, canonicalTarget)
      || isInside(canonicalSource, canonicalTarget)) {
      throw new Error(`${label} 经符号链接解析后越出 docs/evidence：${target}`);
    }
    if (resolvedTargets.has(canonicalTarget)) throw new Error(`关账证据/日志路径不得相互复用：${target}`);
    resolvedTargets.add(canonicalTarget);
  }
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  }));
  return hash.digest("hex");
}

async function fileEvidence(filePath: string): Promise<FileEvidence> {
  const before = await stat(filePath);
  if (!before.isFile()) throw new Error(`不是常规文件：${filePath}`);
  const fileSha256 = await sha256File(filePath);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`计算文件证据期间内容发生变化：${filePath}`);
  }
  return { path: filePath, bytes: before.size, sha256: fileSha256 };
}

async function readRequiredJsonWithEvidence<T>(filePath: string): Promise<{ value: T; file: FileEvidence }> {
  const before = await stat(filePath);
  const content = await readFile(filePath);
  const after = await stat(filePath);
  if (!before.isFile()
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
    || content.length !== before.size) {
    throw new Error(`读取受保护 JSON 期间文件发生变化：${filePath}`);
  }
  let value: T;
  try {
    value = JSON.parse(content.toString("utf8")) as T;
  } catch {
    throw new Error(`受保护 JSON 无法解析：${filePath}`);
  }
  return { value, file: { path: filePath, bytes: content.length, sha256: sha256(content) } };
}

function tailLines(value: string, limit = 50): string[] {
  return value.split(/\r?\n/u).filter(Boolean).slice(-limit);
}

function parseTestSummary(output: string): { filesPassed: number; testsPassed: number } | undefined {
  const files = output.match(/Test Files\s+(\d+) passed/u);
  const tests = output.match(/Tests\s+(\d+) passed/u);
  if (!files || !tests) return undefined;
  return { filesPassed: Number(files[1]), testsPassed: Number(tests[1]) };
}

async function runCommand(
  workspace: string,
  runRoot: string,
  name: string,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<RunEvidence> {
  const argv = [command, ...args];
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  process.stderr.write(`[P2 final] ${name}: ${argv.join(" ")}\n`);
  const result = await new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    signalsSent: string[];
    exitSignal?: string;
    spawnError?: string;
  }>((resolve) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // 每项关账命令使用独立 POSIX 进程组；浏览器/MCP/媒体清理
      // 即使失败也不得把最终验证器所在进程组一并终止。
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimeout: ReturnType<typeof setTimeout> | undefined;
    const signalsSent: string[] = [];
    const signalTree = (signal: NodeJS.Signals): void => {
      signalsSent.push(signal);
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* 已退出 */ }
      }
    };
    const finish = (exitCode: number, exitSignal?: string, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      if (fallbackTimeout) clearTimeout(fallbackTimeout);
      resolve({ exitCode, stdout, stderr, timedOut, signalsSent, exitSignal, spawnError });
    };
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => finish(-1, undefined, error instanceof Error ? error.message : String(error)));
    child.once("close", (code, signal) => finish(code ?? -1, signal ?? undefined));
    timeout = setTimeout(() => {
      timedOut = true;
      stderr += `\n[P2 final] ${name} 超过 ${timeoutMs}ms，终止整个独立进程组。\n`;
      signalTree("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        signalTree("SIGKILL");
        fallbackTimeout = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(-1, "SIGKILL");
        }, 3_000);
      }, 5_000);
    }, timeoutMs);
  });
  const endedAt = new Date().toISOString();
  const stdoutPath = path.join(runRoot, `${name}.stdout.log`);
  const stderrPath = path.join(runRoot, `${name}.stderr.log`);
  await Promise.all([
    writeFile(stdoutPath, result.stdout, { encoding: "utf8", flag: "wx" }),
    writeFile(stderrPath, result.stderr, { encoding: "utf8", flag: "wx" }),
  ]);
  const stdoutEvidence = await fileEvidence(stdoutPath);
  const stderrEvidence = await fileEvidence(stderrPath);
  const evidence: RunEvidence = {
    name,
    argv,
    cwd: workspace,
    startedAt,
    endedAt,
    durationMs: Date.now() - startedMs,
    exitCode: result.exitCode,
    termination: {
      timeoutMs,
      timedOut: result.timedOut,
      signalsSent: result.signalsSent,
      exitSignal: result.exitSignal,
      spawnError: result.spawnError,
    },
    stdout: { ...stdoutEvidence, tail: tailLines(result.stdout) },
    stderr: { ...stderrEvidence, tail: tailLines(result.stderr) },
    testSummary: parseTestSummary(`${result.stdout}\n${result.stderr}`),
  };
  if (result.timedOut || result.exitCode !== 0 || result.spawnError) {
    throw new Error(`${name} 失败（exit ${result.exitCode}${result.timedOut ? `, timeout ${timeoutMs}ms` : ""}${result.exitSignal ? `, signal ${result.exitSignal}` : ""}）：\n${[...evidence.stdout.tail, ...evidence.stderr.tail].slice(-60).join("\n")}`);
  }
  return evidence;
}

async function runCloseoutCommands(input: CliOptions): Promise<Record<string, RunEvidence>> {
  if (await exists(input.runRoot)) throw new Error(`关账日志目录已存在，拒绝覆盖：${input.runRoot}`);
  for (const evidencePath of [input.mcpEvidencePath, input.uiEvidencePath, input.uiScreenshotPath]) {
    if (await exists(evidencePath)) throw new Error(`关账输出已存在，拒绝覆盖：${evidencePath}`);
  }
  await mkdir(path.dirname(input.runRoot), { recursive: true });
  await mkdir(input.runRoot, { recursive: false });
  const runs: Record<string, RunEvidence> = {};
  runs.typecheck = await runCommand(input.workspace, input.runRoot, "01-typecheck", "npm", ["run", "typecheck"], 180_000);
  runs.targeted = await runCommand(input.workspace, input.runRoot, "02-targeted-tests", "npx", [
    "vitest",
    "run",
    "tests/fusion-storyboard-grid.test.ts",
    "tests/fusion-production.test.ts",
    "tests/mcp.test.ts",
    "tests/mcp-fusion-production.test.ts",
  ], 300_000);
  if (!runs.targeted.testSummary || runs.targeted.testSummary.filesPassed !== 4 || runs.targeted.testSummary.testsPassed < 1) {
    throw new Error(`P2 定向测试没有形成 4 文件通过证据：${JSON.stringify(runs.targeted.testSummary)}`);
  }
  runs.full = await runCommand(input.workspace, input.runRoot, "03-full-tests", "npm", ["test"], 600_000);
  if (!runs.full.testSummary || runs.full.testSummary.filesPassed < runs.targeted.testSummary.filesPassed || runs.full.testSummary.testsPassed < runs.targeted.testSummary.testsPassed) {
    throw new Error(`全量测试计数不完整：${JSON.stringify(runs.full.testSummary)}`);
  }
  runs.build = await runCommand(input.workspace, input.runRoot, "04-production-build", "npm", ["run", "build"], 300_000);
  runs.mcp = await runCommand(input.workspace, input.runRoot, "05-compiled-mcp-smoke", "npx", [
    "tsx",
    "scripts/mcp-p2-panel-reference-smoke.ts",
    "--workspace",
    input.workspace,
    "--project-root",
    input.projectRoot,
    "--evidence",
    input.mcpEvidencePath,
    "--write-evidence",
  ], 180_000);
  runs.ui = await runCommand(input.workspace, input.runRoot, "06-electron-ui-smoke", "node", [
    "scripts/ui-p2-panel-reference-smoke.mjs",
    "--workspace",
    input.workspace,
    "--project-root",
    input.projectRoot,
    "--evidence",
    input.uiEvidencePath,
    "--screenshot",
    input.uiScreenshotPath,
  ], 180_000);
  return runs;
}

async function sourceSnapshot(root: string): Promise<SourceSnapshot> {
  const files = (await fg("**/*", { cwd: root, onlyFiles: true, followSymbolicLinks: false, dot: true }))
    .sort((left, right) => left.localeCompare(right, "en"));
  const records: string[] = [];
  let bytes = 0;
  for (const relativePath of files) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const before = await stat(absolutePath);
    const fileSha256 = await sha256File(absolutePath);
    const after = await stat(absolutePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`读取只读源期间文件发生变化：${absolutePath}`);
    }
    bytes += before.size;
    records.push(`${relativePath}\0${before.size}\0${before.mtimeMs}\0${fileSha256}`);
  }
  return { files: files.length, bytes, aggregateSha256: sha256(records.join("\n")) };
}

async function workspaceSourceDigest(workspace: string): Promise<{ files: number; sha256: string }> {
  const files = (await fg([
    "src/**/*",
    "tests/**/*",
    "scripts/**/*",
    "package.json",
    "package-lock.json",
    "tsconfig*.json",
    "electron.vite.config.ts",
    "vitest.config.ts",
  ], { cwd: workspace, onlyFiles: true, followSymbolicLinks: false, dot: true }))
    .sort((left, right) => left.localeCompare(right, "en"));
  const records: string[] = [];
  for (const relativePath of files) records.push(`${relativePath}\0${await sha256File(path.join(workspace, relativePath))}`);
  return { files: files.length, sha256: sha256(records.join("\n")) };
}

function assertAudit(audit: FusionPanelReferenceAudit): void {
  for (const [key, expected] of Object.entries(EXPECTED_AUDIT)) {
    if (audit[key as keyof FusionPanelReferenceAudit] !== expected) {
      throw new Error(`P2 audit.${key} 应为 ${expected}，实际 ${String(audit[key as keyof FusionPanelReferenceAudit])}`);
    }
  }
  if (audit.resolverVersion !== FUSION_PANEL_REFERENCE_RESOLVER_VERSION
    || JSON.stringify(audit.panelDistribution) !== JSON.stringify(EXPECTED_DISTRIBUTION)
    || audit.unresolvedPanels !== 0
    || audit.unresolvedReferences !== 0
    || audit.knownAssetMissingBindingPanels !== 0
    || audit.knownAssetMissingBindings !== 0
    || audit.semanticAssetMissingSlotPanels !== 0
    || audit.semanticAssetMissingSlots !== 0
    || audit.contractAssetMissingBindingPanels !== 0
    || audit.contractAssetMissingBindings !== 0
    || audit.explicitContinuityMissingBindingPanels !== 0
    || audit.explicitContinuityMissingBindings !== 0
    || audit.unhandledOverflowPanels !== 0
    || audit.timeSpanContinuityMismatchPanels !== 0
    || audit.timeSpanContinuityMismatches !== 0
    || !audit.closurePassed) {
    throw new Error(`P2 闭包错误未全部归零，或 closurePassed=false：${JSON.stringify(audit)}`);
  }
}

function assertCurrentness(
  value: { current: boolean; storeRevision: number; storeFingerprint: string; driftedInputs: string[] },
  store: FusionPanelReferenceResolutionStore,
  stage: string,
): void {
  if (!value.current
    || value.storeRevision !== store.revision
    || value.storeFingerprint !== store.storeFingerprint
    || value.driftedInputs.length) {
    throw new Error(`${stage} P2 当前性检查失败：${JSON.stringify(value)}`);
  }
}

function assertDerivedDefinition(asset: DerivedPanelReferenceAsset): void {
  if (asset.status !== "definition-approved"
    || asset.visualArtifact
    || asset.definitionReview.status !== "approved"
    || asset.memberAssetIds.length <= 6
    || new Set(asset.memberAssetIds).size !== asset.memberAssetIds.length
    || Object.keys(asset.memberDefinitionVersions).sort().join("\0") !== [...asset.memberAssetIds].sort().join("\0")) {
    throw new Error(`派生引用 ${asset.id} 不是完整但仅结构就绪的定义：${JSON.stringify(asset)}`);
  }
}

async function assertSlotFile(
  slot: PanelReferenceResolution["referenceSlots"][number],
  digestCache: Map<string, string>,
): Promise<void> {
  if (slot.readiness !== "ready") return;
  if (!slot.path || !slot.sha256) throw new Error(`ready 引用槽 ${slot.id} 缺少路径/SHA。`);
  if (!await exists(slot.path)) throw new Error(`ready 引用槽 ${slot.id} 的文件不存在。`);
  let actual = digestCache.get(slot.path);
  if (!actual) {
    actual = await sha256File(slot.path);
    digestCache.set(slot.path, actual);
  }
  if (actual !== slot.sha256) throw new Error(`ready 引用槽 ${slot.id} 的文件 SHA 漂移。`);
}

async function validateResolutions(
  store: FusionPanelReferenceResolutionStore,
  knownAssetIds: Set<string>,
): Promise<{
  identitySha256: string;
  closureCounts: Record<string, number>;
  readinessCounts: Record<string, number>;
  readySlotFilesChecked: number;
  semanticAssetCoverage: { seen: number; expected: number; assetIdsSha256: string };
  recomputedResolutionAuditSha256: string;
}> {
  const ids = new Set<string>();
  const identityLines: string[] = [];
  let readySlotFilesChecked = 0;
  const slotDigestCache = new Map<string, string>();
  const seenSemanticIds = new Set<string>();
  const seenDerivedIds = new Set<string>();
  const closureCounts: Record<string, number> = {};
  const readinessCounts: Record<string, number> = {};
  for (const [key, resolution] of Object.entries(store.resolutions)) {
    if (key !== `${resolution.gridContractId}:${resolution.panelId}`) throw new Error(`resolution map key 与内容身份不一致：${key}`);
    if (ids.has(resolution.resolutionId)) throw new Error(`resolutionId 重复：${resolution.resolutionId}`);
    ids.add(resolution.resolutionId);
    identityLines.push(`${key}\0${resolution.resolutionId}\0${resolution.resolutionFingerprint}`);
    closureCounts[resolution.closureStatus] = (closureCounts[resolution.closureStatus] ?? 0) + 1;
    if (resolution.closureStatus === "unresolved"
      || resolution.startSeconds < 0
      || resolution.endSeconds > 15
      || resolution.endSeconds <= resolution.startSeconds
      || resolution.panelIndex < 1
      || resolution.panelIndex > resolution.panelCount
      || resolution.referenceSlots.length > 6
      || JSON.stringify(resolution.inputSnapshot) !== JSON.stringify(store.inputSnapshot)
      || resolution.timelineReconciliations.some((entry) => entry.status !== "resolved")) {
      throw new Error(`逐格 resolution 未失败关闭：${resolution.resolutionId}`);
    }
    const semanticIds = resolution.semanticAssets.map((asset) => asset.assetId);
    if (new Set(semanticIds).size !== semanticIds.length || semanticIds.some((assetId) => !knownAssetIds.has(assetId))) {
      throw new Error(`resolution 存在重复或未定义语义资产：${resolution.resolutionId}`);
    }
    semanticIds.forEach((assetId) => seenSemanticIds.add(assetId));
    const coveredIds = resolution.referenceSlots.flatMap((slot) => slot.coveredAssetIds);
    if (new Set(coveredIds).size !== coveredIds.length
      || [...new Set(coveredIds)].sort().join("\0") !== [...semanticIds].sort().join("\0")) {
      throw new Error(`resolution 语义资产没有被引用槽完整覆盖：${resolution.resolutionId}`);
    }
    const allReady = resolution.referenceSlots.every((slot) => slot.readiness === "ready");
    if (resolution.generationReady !== allReady) throw new Error(`resolution generationReady 与槽位就绪度不一致：${resolution.resolutionId}`);
    if (resolution.closureStatus === "confirmed-empty" && (semanticIds.length || resolution.referenceSlots.length)) {
      throw new Error(`confirmed-empty 格仍有引用：${resolution.resolutionId}`);
    }
    if (resolution.detectedOverflow) {
      if (semanticIds.length <= 6 || resolution.referenceSlots.length !== 1 || !resolution.overflowHandledByDerivedAssetId) {
        throw new Error(`溢出格未用唯一派生资产完整闭包：${resolution.resolutionId}`);
      }
      const slot = resolution.referenceSlots[0]!;
      const derived = store.derivedAssets[resolution.overflowHandledByDerivedAssetId];
      if (!derived
        || slot.kind !== "derived-composite"
        || slot.derivedAssetId !== derived?.id
        || slot.readiness !== "pending-derived-artifact"
        || [...slot.coveredAssetIds].sort().join("\0") !== [...semanticIds].sort().join("\0")
        || [...derived.memberAssetIds].sort().join("\0") !== [...semanticIds].sort().join("\0")
        || !resolution.blockerCodes.includes("pending-derived-artifact")
        || resolution.generationReady) {
        throw new Error(`溢出格静默裁剪、伪造视觉就绪或派生定义错配：${resolution.resolutionId}`);
      }
      seenDerivedIds.add(derived.id);
    } else if (resolution.referenceSlots.some((slot) => slot.kind !== "canonical-asset" || slot.coveredAssetIds.length !== 1)) {
      throw new Error(`非溢出格出现了非单资产直接槽：${resolution.resolutionId}`);
    }
    for (const slot of resolution.referenceSlots) {
      readinessCounts[slot.readiness] = (readinessCounts[slot.readiness] ?? 0) + 1;
      if (slot.readiness === "ready") readySlotFilesChecked += 1;
      await assertSlotFile(slot, slotDigestCache);
    }
  }
  const seen = [...seenSemanticIds].sort();
  const expected = [...knownAssetIds].sort();
  if (seen.join("\0") !== expected.join("\0")) {
    const missing = expected.filter((assetId) => !seenSemanticIds.has(assetId));
    const extra = seen.filter((assetId) => !knownAssetIds.has(assetId));
    throw new Error(`P2 全季语义引用没有精确覆盖 77 项资产：${JSON.stringify({ seen: seen.length, expected: expected.length, missing, extra })}`);
  }
  const expectedDerivedIds = Object.keys(store.derivedAssets).sort();
  if ([...seenDerivedIds].sort().join("\0") !== expectedDerivedIds.join("\0")) {
    throw new Error("P2 52 个派生定义未被 166 个溢出格精确使用，或存在悬空定义。");
  }
  const items = Object.values(store.resolutions);
  const missingByPanel = items.map((resolution) => {
    const covered = new Set(resolution.referenceSlots.flatMap((slot) => slot.coveredAssetIds));
    return resolution.semanticAssets.filter((asset) => !covered.has(asset.assetId));
  });
  const unresolved = items.filter((resolution) => resolution.closureStatus === "unresolved");
  const timelineUnresolved = items.filter((resolution) => resolution.blockerCodes.includes("timeline-conflict"));
  const overflowUnhandled = items.filter((resolution) => resolution.detectedOverflow && !resolution.overflowHandledByDerivedAssetId);
  const differencePanels = items.filter((resolution) => resolution.timelineReconciliations.length > 0);
  const recomputedAudit = {
    contractCoverageVersion: FUSION_PANEL_REFERENCE_CONTRACT_COVERAGE_VERSION,
    panels: items.length,
    semanticAssetBindings: items.reduce((sum, item) => sum + item.semanticAssets.length, 0),
    referenceSlots: items.reduce((sum, item) => sum + item.referenceSlots.length, 0),
    confirmedEmptyPanels: items.filter((item) => item.closureStatus === "confirmed-empty").length,
    generationReadyPanels: items.filter((item) => item.generationReady).length,
    pendingHardLockPanels: items.filter((item) => item.blockerCodes.includes("pending-hard-lock")).length,
    pendingHardLockReferences: items.reduce((sum, item) => sum + item.referenceSlots.filter((slot) => slot.readiness === "pending-hard-lock").length, 0),
    pendingDerivedArtifactPanels: items.filter((item) => item.blockerCodes.includes("pending-derived-artifact")).length,
    detectedOverflowPanels: items.filter((item) => item.detectedOverflow).length,
    derivedDefinitions: Object.keys(store.derivedAssets).length,
    detectedRowContinuityDifferencePanels: differencePanels.length,
    detectedRowContinuityDifferences: differencePanels.reduce((sum, item) => sum + item.timelineReconciliations.length, 0),
    unresolvedPanels: unresolved.length,
    unresolvedReferences: unresolved.reduce((sum, item) => sum + item.blockerCodes.filter((code) => code === "unknown-asset" || code === "timeline-conflict").length, 0),
    knownAssetMissingBindingPanels: missingByPanel.filter((missing) => missing.length > 0).length,
    knownAssetMissingBindings: missingByPanel.reduce((sum, missing) => sum + missing.length, 0),
    semanticAssetMissingSlotPanels: missingByPanel.filter((missing) => missing.length > 0).length,
    semanticAssetMissingSlots: missingByPanel.reduce((sum, missing) => sum + missing.length, 0),
    unhandledOverflowPanels: overflowUnhandled.length,
    timeSpanContinuityMismatchPanels: timelineUnresolved.length,
    timeSpanContinuityMismatches: timelineUnresolved.reduce((sum, item) => sum + item.issues.filter((issue) => issue.includes("时间段")).length, 0),
    maximumSemanticAssetsPerPanel: Math.max(0, ...items.map((item) => item.semanticAssets.length)),
    maximumReferenceSlotsPerPanel: Math.max(0, ...items.map((item) => item.referenceSlots.length)),
  };
  for (const [key, value] of Object.entries(recomputedAudit)) {
    if (store.audit[key as keyof FusionPanelReferenceAudit] !== value) {
      throw new Error(`P2 audit.${key} 与 4330 格 resolution 独立重算值不一致。`);
    }
  }
  return {
    identitySha256: sha256(identityLines.sort().join("\n")),
    closureCounts,
    readinessCounts,
    readySlotFilesChecked,
    semanticAssetCoverage: { seen: seen.length, expected: expected.length, assetIdsSha256: sha256(seen.join("\n")) },
    recomputedResolutionAuditSha256: digest(recomputedAudit),
  };
}

async function validateCurrentInputs(
  projectRoot: string,
  store: FusionPanelReferenceResolutionStore,
): Promise<{
  contractsSha256: string;
  contractFilesSha256: string;
  contracts: number;
  panels: number;
  currentInputHashes: Record<string, string>;
  unitMarkdowns: { files: number; aggregateDigest: string; snapshotPackageRoot: string };
  preservedSelections: Record<string, FusionStoryboardGridSelection>;
  contractSemanticCoverage: {
    panelsChecked: number;
    contractAssetBindings: number;
    explicitlyExcludedContractAssetBindings: number;
    requiredContractAssetBindings: number;
    continuityReferenceBindings: number;
    semanticExtraBindings: number;
    ep01Unit008P01ContinuityPanels: number;
    coverageSha256: string;
  };
}> {
  const sidecar = getSidecarPaths(projectRoot);
  const [selections, storyboards, config, manifest] = await Promise.all([
    readJson<FusionStoryboardGridSelectionStore>(sidecar.storyboardGridSelections, { schemaVersion: 1, revision: 0, items: {}, updatedAt: new Date(0).toISOString() }),
    readJson<StoryboardStore | null>(sidecar.storyboards, null),
    readJson<{ hardLocks?: Array<{ id: string; name: string; path: string; note: string }> }>(sidecar.config, {}),
    loadFusionProjectManifest(projectRoot),
  ]);
  if (!storyboards || !manifest || Object.keys(selections.items).length !== 1_288 || storyboards.revision !== store.inputSnapshot.storyboardRevision) {
    throw new Error("P2 当前选择数或 storyboard revision 与冻结输入不一致。");
  }
  const expectedUnitItemIds = manifest.units.map((unit) => `season-三-ep${String(unit.episodeNumber).padStart(2, "0")}-unit${String(unit.sequence).padStart(3, "0")}`).sort();
  const selectedUnitItemIds = Object.keys(selections.items).sort();
  if (new Set(expectedUnitItemIds).size !== 1_288 || selectedUnitItemIds.join("\0") !== expectedUnitItemIds.join("\0")) {
    throw new Error(`P2 selection keys 与 manifest 1288 个单元不是精确集合相等：${JSON.stringify({ selected: selectedUnitItemIds.length, expected: expectedUnitItemIds.length })}`);
  }
  const currentInputHashes = {
    storyboardsSha256: await sha256File(sidecar.storyboards),
    continuitySha256: await sha256File(sidecar.continuityTracks),
    productionAssetsSha256: await sha256File(sidecar.productionAssets),
    gridSelectionsSha256: gridSelectionSemanticDigest(selections),
    projectConfigSha256: digest([...(config.hardLocks ?? [])].sort((left, right) => left.id.localeCompare(right.id, "en"))),
  };
  for (const [key, value] of Object.entries(currentInputHashes)) {
    if (store.inputSnapshot[key as keyof typeof currentInputHashes] !== value) throw new Error(`P2 冻结输入已漂移：${key}`);
  }
  const packageRelative = path.relative(path.resolve(manifest.source.root), path.resolve(manifest.source.packageRoot));
  const snapshotPackageRoot = path.join(projectRoot, "source_snapshot", packageRelative);
  if (!packageRelative || packageRelative.startsWith("..") || path.isAbsolute(packageRelative) || !isInside(projectRoot, snapshotPackageRoot)) {
    throw new Error("P2 final 无法安全定位隔离工程内的 Markdown 快照。");
  }
  const markdownRecords: Array<[string, string]> = [];
  for (const unit of manifest.units) {
    const unitItemId = `season-三-ep${String(unit.episodeNumber).padStart(2, "0")}-unit${String(unit.sequence).padStart(3, "0")}`;
    const markdownPath = path.join(snapshotPackageRoot, ...unit.markdownPath.split("/"));
    if (!isInside(snapshotPackageRoot, markdownPath)) throw new Error(`P2 Markdown 快照路径越界：${unitItemId}`);
    const actualSha256 = await sha256File(markdownPath);
    if (actualSha256 !== unit.markdownSha256) throw new Error(`P2 Markdown 快照 SHA 漂移：${unitItemId}`);
    markdownRecords.push([unitItemId, actualSha256]);
  }
  const unitMarkdownAggregateDigest = digest(markdownRecords.sort(([left], [right]) => left.localeCompare(right, "en")));
  if (markdownRecords.length !== 1_288 || unitMarkdownAggregateDigest !== store.inputSnapshot.unitMarkdownsDigest) {
    throw new Error(`P2 1288 份 Markdown 快照摘要与 resolution 冻结输入不一致：${unitMarkdownAggregateDigest}`);
  }
  const contracts: FusionStoryboardGridContract[] = [];
  const contractFileRecords: Array<[string, string]> = [];
  const contractSemanticCoverageLines: string[] = [];
  let panels = 0;
  let contractAssetBindings = 0;
  let explicitlyExcludedContractAssetBindings = 0;
  let requiredContractAssetBindings = 0;
  let continuityReferenceBindings = 0;
  let semanticExtraBindings = 0;
  let ep01Unit008P01ContinuityPanels = 0;
  for (const [unitItemId, selection] of Object.entries(selections.items)) {
    const contractPath = path.join(sidecar.storyboardGrids, unitItemId, `${selection.contractId}.json`);
    const raw = await readJson<FusionStoryboardGridContract | null>(contractPath, null);
    if (!raw) throw new Error(`当前宫格合同缺失：${unitItemId}/${selection.contractId}`);
    contractFileRecords.push([unitItemId, await sha256File(contractPath)]);
    const contract = normalizeFusionStoryboardGridContract(raw);
    if (contract.unit.unitId !== unitItemId
      || contract.contractId !== selection.contractId
      || contract.sourceFingerprint !== selection.sourceFingerprint
      || contract.productionFingerprint !== selection.productionFingerprint
      || contract.selection.panelCount !== selection.panelCount) {
      throw new Error(`当前宫格选择与内容寻址合同冲突：${unitItemId}`);
    }
    panels += contract.panels.length;
    for (const panel of contract.panels) {
      const resolution = store.resolutions[`${contract.contractId}:${panel.id}`];
      if (!resolution
        || resolution.unitItemId !== unitItemId
        || resolution.gridSourceFingerprint !== contract.sourceFingerprint
        || resolution.panelIndex !== panel.index
        || resolution.startSeconds !== panel.startSeconds
          || resolution.endSeconds !== panel.endSeconds) {
        throw new Error(`当前合同宫格没有唯一对应的 P2 resolution：${unitItemId}/${panel.id}`);
      }
      const contractAssetIds = panel.assetIds ?? [];
      const continuityReferenceAssetIds = panel.continuityReferenceAssetIds ?? [];
      const semanticAssetIds = resolution.semanticAssets.map((asset) => asset.assetId);
      const excludedAssetIds = resolution.excludedAssets.map((asset) => asset.assetId);
      if (new Set(contractAssetIds).size !== contractAssetIds.length
        || new Set(continuityReferenceAssetIds).size !== continuityReferenceAssetIds.length
        || new Set(excludedAssetIds).size !== excludedAssetIds.length
        || resolution.excludedAssets.some((asset) => !asset.reason.trim()
          || !["manual-override", "parser-reconciliation"].includes(asset.source))) {
        throw new Error(`当前合同宫格的资产/连续性/显式排除集合非法：${unitItemId}/${panel.id}`);
      }
      const semanticSet = new Set(semanticAssetIds);
      const excludedSet = new Set(excludedAssetIds);
      const contractSet = new Set(contractAssetIds);
      const requiredContractIds = contractAssetIds.filter((assetId) => !excludedSet.has(assetId));
      const missingContractIds = requiredContractIds.filter((assetId) => !semanticSet.has(assetId));
      const missingContinuityIds = continuityReferenceAssetIds.filter((assetId) => !semanticSet.has(assetId));
      if (missingContractIds.length || missingContinuityIds.length) {
        throw new Error(`当前合同资产未全部进入 P2 语义闭包：${JSON.stringify({
          unitItemId,
          contractId: contract.contractId,
          panelId: panel.id,
          panelIndex: panel.index,
          missingContractAssetIds: missingContractIds,
          missingContinuityReferenceAssetIds: missingContinuityIds,
          explicitlyExcludedAssetIds: excludedAssetIds,
        })}`);
      }
      const excludedContractIds = contractAssetIds.filter((assetId) => excludedSet.has(assetId));
      const semanticExtraIds = semanticAssetIds.filter((assetId) => !contractSet.has(assetId));
      if (unitItemId === "season-三-ep01-unit008" && panel.index >= 3 && panel.index <= 6) {
        const p01Semantic = resolution.semanticAssets.find((asset) => asset.assetId === "P01");
        const p01Slots = resolution.referenceSlots.filter((slot) => slot.kind === "canonical-asset" && slot.assetId === "P01");
        if (!continuityReferenceAssetIds.includes("P01")
          || p01Semantic?.hardLock?.sha256 !== FORMAL_P01_HARD_LOCK_SHA256
          || p01Slots.length !== 1
          || p01Slots[0]?.readiness !== "ready"
          || p01Slots[0]?.sha256 !== FORMAL_P01_HARD_LOCK_SHA256
          || p01Slots[0]?.path !== p01Semantic.hardLock.path
          || p01Slots[0]?.coveredAssetIds.join("\0") !== "P01") {
          throw new Error(`EP01_008 宫格 ${panel.index} 没有以正式 P01 硬锁完成 continuityReference 闭包。`);
        }
        ep01Unit008P01ContinuityPanels += 1;
      }
      contractAssetBindings += contractAssetIds.length;
      explicitlyExcludedContractAssetBindings += excludedContractIds.length;
      requiredContractAssetBindings += requiredContractIds.length;
      continuityReferenceBindings += continuityReferenceAssetIds.length;
      semanticExtraBindings += semanticExtraIds.length;
      contractSemanticCoverageLines.push([
        unitItemId,
        contract.contractId,
        panel.id,
        [...contractAssetIds].sort().join(","),
        [...excludedContractIds].sort().join(","),
        [...continuityReferenceAssetIds].sort().join(","),
        [...semanticAssetIds].sort().join(","),
        [...semanticExtraIds].sort().join(","),
      ].join("\0"));
    }
    contracts.push(contract);
  }
  contracts.sort((left, right) => left.unit.unitId.localeCompare(right.unit.unitId, "en"));
  const contractsSha256 = digest(contracts.map((contract) => [contract.unit.unitId, contract.contractId, contract.sourceFingerprint, contract.productionFingerprint]));
  const contractFilesSha256 = digest(contractFileRecords.sort(([left], [right]) => left.localeCompare(right, "en")));
  if (contracts.length !== 1_288 || panels !== 4_330 || contractsSha256 !== store.inputSnapshot.gridContractsDigest) {
    throw new Error(`P2 当前合同集漂移：${JSON.stringify({ contracts: contracts.length, panels, contractsSha256, expected: store.inputSnapshot.gridContractsDigest })}`);
  }
  const preservedSelections = Object.fromEntries(PRESERVED_UNITS.map((unitId) => {
    const selection = selections.items[unitId];
    if (!selection) throw new Error(`缺少保留选择：${unitId}`);
    return [unitId, selection];
  }));
  return {
    contractsSha256,
    contractFilesSha256,
    contracts: contracts.length,
    panels,
    currentInputHashes,
    unitMarkdowns: { files: markdownRecords.length, aggregateDigest: unitMarkdownAggregateDigest, snapshotPackageRoot },
    preservedSelections,
    contractSemanticCoverage: {
      panelsChecked: panels,
      contractAssetBindings,
      explicitlyExcludedContractAssetBindings,
      requiredContractAssetBindings,
      continuityReferenceBindings,
      semanticExtraBindings,
      ep01Unit008P01ContinuityPanels,
      coverageSha256: sha256(contractSemanticCoverageLines.sort().join("\n")),
    },
  };
}

async function rawLabeledInventory(projectRoot: string): Promise<Array<{ relativePath: string; bytes: number; sha256: string }>> {
  const files = (await fg(["**/*_raw.png", "**/*_labeled.png"], {
    cwd: projectRoot,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: true,
    ignore: [".aicanvas/backups/**", ".aicanvas/subagent-staging/**", ".aicanvas/generation-downloads/**"],
  })).sort((left, right) => left.localeCompare(right, "en"));
  return Promise.all(files.map(async (relativePath) => {
    const absolutePath = path.join(projectRoot, ...relativePath.split("/"));
    const before = await stat(absolutePath);
    const fileSha256 = await sha256File(absolutePath);
    const after = await stat(absolutePath);
    if (!before.isFile()
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`计算 P1 raw/labeled 清单期间文件发生变化：${absolutePath}`);
    }
    return { relativePath, bytes: before.size, sha256: fileSha256 };
  }));
}

interface PanelReferenceGenerationJobBoundary {
  total: number;
  legacy: {
    count: number;
    ids: string[];
    idsSha256: string;
    resolutionEvidence: FusionPanelReferenceResolutionStore["legacyGenerationJobEvidence"];
    resolutionEvidenceSha256: string;
    currentResolutionCount: number;
    obsoleteTerminal: { count: number; ids: string[]; idsSha256: string };
  };
  evidenceBacked: { count: number; ids: string[]; idsSha256: string };
}

function hasAnyPanelReferenceEvidence(job: GenerationJob): boolean {
  return job.panelReferenceEvidenceVersion !== undefined
    || job.fusionStoryboardPanel?.panelReferenceResolutionId !== undefined
    || job.fusionStoryboardPanel?.panelReferenceResolutionFingerprint !== undefined
    || job.fusionReferenceBoard?.panelReferenceResolutionId !== undefined
    || job.fusionReferenceBoard?.panelReferenceResolutionFingerprint !== undefined;
}

async function validatePanelReferenceGenerationJobs(
  jobs: GenerationJob[],
  publications: PublicationStore,
  store: FusionPanelReferenceResolutionStore,
): Promise<PanelReferenceGenerationJobBoundary> {
  const whitelist = [...store.legacyGenerationJobIds].sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(whitelist).size !== whitelist.length) throw new Error("P2 历史逐格任务白名单包含重复 ID。");
  const legacyResolutionEvidence = Object.fromEntries(Object.entries(store.legacyGenerationJobEvidence)
    .sort(([left], [right]) => left.localeCompare(right, "en")));
  if (Object.keys(legacyResolutionEvidence).join("\0") !== whitelist.join("\0")) {
    throw new Error("P2 历史逐格任务没有逐项且仅逐项冻结首次 resolution 身份。");
  }
  const whitelistSet = new Set(whitelist);
  const panelJobs = jobs
    .filter((job) => job.purpose === "fusion_storyboard_panel")
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const jobIds = panelJobs.map((job) => job.id);
  if (new Set(jobIds).size !== jobIds.length) throw new Error("逐格 GenerationJob 存在重复 ID。");
  const evidenceBackedIds: string[] = [];
  let currentResolutionCount = 0;
  const obsoleteTerminalIds: string[] = [];
  for (const job of panelJobs) {
    if (whitelistSet.has(job.id)) {
      if (hasAnyPanelReferenceEvidence(job)) {
        throw new Error(`历史白名单任务不得混入部分 P2 身份：${job.id}`);
      }
      const panel = job.fusionStoryboardPanel;
      const evidence = legacyResolutionEvidence[job.id];
      if (!panel
        || !evidence
        || evidence.contractId !== panel.contractId
        || evidence.panelId !== panel.panelId
        || evidence.jobLedgerFingerprint !== digest(job)) {
        throw new Error(`历史白名单任务的 job ledger/contract/panel 旁路身份缺失或漂移：${job.id}`);
      }
      if (evidence.kind === "current-resolution") {
        const resolution = store.resolutions[`${panel.contractId}:${panel.panelId}`];
        const expectedFields = ["contractId", "jobLedgerFingerprint", "kind", "panelId", "resolutionFingerprint", "resolutionId"];
        if (Object.keys(evidence).sort().join("\0") !== expectedFields.sort().join("\0")
          || !resolution
          || resolution.unitItemId !== job.itemId
          || evidence.resolutionId !== resolution.resolutionId
          || evidence.resolutionFingerprint !== resolution.resolutionFingerprint) {
          throw new Error(`历史白名单任务的 current-resolution 身份不属于当前格：${job.id}`);
        }
        currentResolutionCount += 1;
        continue;
      }
      const publicationIntentIds = [...new Set([
        job.publicationIntentId,
        job.companionPublicationIntentId,
      ].filter((id): id is string => Boolean(id)))].sort((left, right) => left.localeCompare(right, "en"));
      const intents = publications.intents
        .filter((intent) => publicationIntentIds.includes(intent.id))
        .sort((left, right) => left.id.localeCompare(right.id, "en"));
      const receipts = publications.receipts
        .filter((receipt) => publicationIntentIds.includes(receipt.intentId))
        .sort((left, right) => left.id.localeCompare(right.id, "en"));
      const hasOutputLedger = Boolean(job.resultPath
        || job.companionPath
        || job.publicationReceiptId
        || job.companionPublicationReceiptId
        || job.isolatedDownloadPath
        || job.partialDownloadPath
        || job.resultSha256
        || job.remoteResultUrl
        || job.subagentCheckpoint?.output);
      const expectedFields = [
        "contractId",
        "disposition",
        "itemId",
        "jobLedgerFingerprint",
        "kind",
        "panelId",
        "publicationIntentIds",
        "publicationLedgerFingerprint",
        "terminalStatus",
      ];
      if (job.id !== OBSOLETE_TERMINAL_JOB_ID
        || Object.keys(evidence).sort().join("\0") !== expectedFields.sort().join("\0")
        || evidence.itemId !== job.itemId
        || job.status !== "failed"
        || evidence.terminalStatus !== "failed"
        || evidence.disposition !== "non-current-contract-no-output"
        || hasOutputLedger
        || await exists(job.expectedOutputPath)
        || Boolean(job.expectedCompanionPath && await exists(job.expectedCompanionPath))
        || Object.values(store.resolutions).some((resolution) => resolution.gridContractId === evidence.contractId)
        || JSON.stringify(evidence.publicationIntentIds) !== JSON.stringify(publicationIntentIds)
        || publicationIntentIds.length !== 1
        || intents.length !== publicationIntentIds.length
        || intents.some((intent) => intent.status !== "failed")
        || receipts.length !== 0
        || evidence.publicationLedgerFingerprint !== digest({ intents, receipts })) {
        throw new Error(`历史白名单任务不是唯一、无输出、Publication failed 且旧合同已淘汰的 obsolete-terminal：${job.id}`);
      }
      obsoleteTerminalIds.push(job.id);
      continue;
    }
    const panel = job.fusionStoryboardPanel;
    const board = job.fusionReferenceBoard;
    if (job.panelReferenceEvidenceVersion !== 1
      || !panel?.contractId
      || !panel.panelId
      || !panel.panelReferenceResolutionId
      || !panel.panelReferenceResolutionFingerprint
      || !board?.panelReferenceResolutionId
      || !board.panelReferenceResolutionFingerprint
      || board.panelReferenceResolutionId !== panel.panelReferenceResolutionId
      || board.panelReferenceResolutionFingerprint !== panel.panelReferenceResolutionFingerprint) {
      throw new Error(`非白名单逐格任务缺少完整且一致的 P2 冻结身份：${job.id}`);
    }
    const resolution = store.resolutions[`${panel.contractId}:${panel.panelId}`];
    if (!resolution
      || resolution.resolutionId !== panel.panelReferenceResolutionId
      || resolution.resolutionFingerprint !== panel.panelReferenceResolutionFingerprint) {
      throw new Error(`逐格任务冻结的 P2 resolution 已漂移：${job.id}`);
    }
    evidenceBackedIds.push(job.id);
  }
  const panelJobIdSet = new Set(jobIds);
  const missingWhitelistedJobs = whitelist.filter((id) => !panelJobIdSet.has(id));
  if (missingWhitelistedJobs.length) {
    throw new Error(`P2 历史白名单引用了当前账中不存在或非逐格的任务：${missingWhitelistedJobs.join("、")}`);
  }
  if (currentResolutionCount !== 10
    || obsoleteTerminalIds.length !== 1
    || obsoleteTerminalIds[0] !== OBSOLETE_TERMINAL_JOB_ID) {
    throw new Error("P2 历史任务 evidence 类型分布不是 10 current-resolution + 1 指定 obsolete-terminal。");
  }
  return {
    total: panelJobs.length,
    legacy: {
      count: whitelist.length,
      ids: whitelist,
      idsSha256: sha256(whitelist.join("\n")),
      resolutionEvidence: legacyResolutionEvidence,
      resolutionEvidenceSha256: sha256(JSON.stringify(legacyResolutionEvidence)),
      currentResolutionCount,
      obsoleteTerminal: {
        count: obsoleteTerminalIds.length,
        ids: obsoleteTerminalIds,
        idsSha256: sha256(obsoleteTerminalIds.join("\n")),
      },
    },
    evidenceBacked: {
      count: evidenceBackedIds.length,
      ids: evidenceBackedIds,
      idsSha256: sha256(evidenceBackedIds.join("\n")),
    },
  };
}

function legacyPanelArtifactSnapshot(
  jobs: GenerationJob[],
  index: ProjectIndex,
): { count: number; artifactIds: string[]; identitySha256: string; withoutP2Evidence: number; withP2Evidence: number } {
  const outputPaths = new Set(jobs
    .filter((job) => job.purpose === "fusion_storyboard_panel")
    .flatMap((job) => [job.expectedOutputPath, job.expectedCompanionPath, job.resultPath, job.companionPath])
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value)));
  const artifacts = index.artifacts
    .filter((artifact) => outputPaths.has(path.resolve(artifact.path)))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const artifactIds = artifacts.map((artifact) => artifact.id);
  if (new Set(artifactIds).size !== artifactIds.length) throw new Error("P1 legacy panel Artifact 存在重复 ID。");
  const withP2Evidence = artifacts.filter((artifact) => artifact.fusionStoryboardPanel?.panelReferenceEvidenceVersion !== undefined
    || artifact.fusionStoryboardPanel?.panelReferenceResolutionId !== undefined
    || artifact.fusionStoryboardPanel?.panelReferenceResolutionFingerprint !== undefined).length;
  if (withP2Evidence) throw new Error(`${withP2Evidence} 个 P1 legacy panel Artifact 不应携带后补 P2 身份。`);
  return {
    count: artifacts.length,
    artifactIds,
    identitySha256: sha256(JSON.stringify(artifacts)),
    withoutP2Evidence: artifacts.length - withP2Evidence,
    withP2Evidence,
  };
}

function legacyPanelReviewSnapshot(
  jobs: GenerationJob[],
  reviews: ReviewStore,
): { count: number; reviewIds: string[]; identitySha256: string; withoutP2Evidence: number; withP2Evidence: number } {
  const jobIds = new Set(jobs
    .filter((job) => job.purpose === "fusion_storyboard_panel")
    .map((job) => job.id));
  const records = reviews.records
    .filter((record) => record.artifactEvidence?.some((artifact) => jobIds.has(artifact.fusionStoryboardPanel?.generationJobId ?? ""))
      || record.requirement?.panels.some((panel) => jobIds.has(panel.generationJobId ?? "")))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const reviewIds = records.map((record) => record.id);
  if (new Set(reviewIds).size !== reviewIds.length) throw new Error("P1 legacy panel Review 存在重复 ID。");
  const withP2Evidence = records.filter((record) => record.artifactEvidence?.some((artifact) => artifact.fusionStoryboardPanel?.panelReferenceEvidenceVersion !== undefined
    || artifact.fusionStoryboardPanel?.panelReferenceResolutionId !== undefined
    || artifact.fusionStoryboardPanel?.panelReferenceResolutionFingerprint !== undefined)
    || record.requirement?.panels.some((panel) => panel.panelReferenceEvidenceVersion !== undefined
      || panel.panelReferenceResolutionId !== undefined
      || panel.panelReferenceResolutionFingerprint !== undefined)).length;
  if (withP2Evidence) throw new Error(`${withP2Evidence} 个 P1 legacy panel Review 不应携带后补 P2 身份。`);
  return {
    count: records.length,
    reviewIds,
    identitySha256: sha256(JSON.stringify(records)),
    withoutP2Evidence: records.length - withP2Evidence,
    withP2Evidence,
  };
}

async function validateP1ProtectedState(projectRoot: string, store: FusionPanelReferenceResolutionStore): Promise<{
  generationJobs: FileEvidence;
  publications: FileEvidence;
  reviews: FileEvidence;
  generationCounts: Record<string, number>;
  publicationCounts: { intents: number; receipts: number };
  reviewCount: number;
  rawLabeled: Array<{ relativePath: string; bytes: number; sha256: string }>;
  projectIndex: {
    scanId: string;
    scannedAt: string;
    itemCount: number;
    artifactCount: number;
    scanStats?: ProjectIndex["scanStats"];
  };
  legacyPanelArtifacts: {
    count: number;
    artifactIds: string[];
    identitySha256: string;
    withoutP2Evidence: number;
    withP2Evidence: number;
  };
  legacyPanelReviews: {
    count: number;
    reviewIds: string[];
    identitySha256: string;
    withoutP2Evidence: number;
    withP2Evidence: number;
  };
  unknownJobIdentitySha256: string;
  panelReferenceGenerationJobs: PanelReferenceGenerationJobBoundary;
}> {
  const sidecar = getSidecarPaths(projectRoot);
  const [jobsSnapshot, publicationsSnapshot, reviewsSnapshot, rawLabeled, indexSnapshot] = await Promise.all([
    readRequiredJsonWithEvidence<GenerationJob[]>(sidecar.generationJobs),
    readRequiredJsonWithEvidence<PublicationStore>(sidecar.publications),
    readRequiredJsonWithEvidence<ReviewStore>(sidecar.reviews),
    rawLabeledInventory(projectRoot),
    readRequiredJsonWithEvidence<ProjectIndex>(sidecar.index),
  ]);
  const jobs = jobsSnapshot.value;
  const publications = publicationsSnapshot.value;
  const reviews = reviewsSnapshot.value;
  const index = indexSnapshot.value;
  const generationCounts = Object.fromEntries([...new Set(jobs.map((job) => job.status))].sort().map((status) => [status, jobs.filter((job) => job.status === status).length]));
  const unknown = jobs.find((job) => job.id === UNKNOWN_JOB_ID);
  if (jobs.length !== 30
    || generationCounts.succeeded !== 26
    || generationCounts.failed !== 3
    || generationCounts.generation_unknown !== 1
    || !unknown
    || unknown.status !== "generation_unknown"
    || unknown.attempts !== 1
    || unknown.subagentCheckpoint?.schemaVersion !== 2
    || unknown.subagentCheckpoint.stage !== "generation_unknown"
    || unknown.subagentCheckpoint.unknown?.code !== "legacy_leased_without_call_receipt"
    || unknown.subagentCheckpoint.callIntent
    || unknown.subagentCheckpoint.output
    || unknown.resultPath
    || unknown.companionPath
    || unknown.publicationReceiptId
    || unknown.companionPublicationReceiptId
    || publications.intents.length !== 31
    || publications.receipts.length !== 26
    || reviews.records.length !== 20
    || rawLabeled.filter((entry) => entry.relativePath.endsWith("_raw.png")).length !== 26
    || rawLabeled.filter((entry) => entry.relativePath.endsWith("_labeled.png")).length !== 26) {
    throw new Error(`P1 受保护状态漂移：${JSON.stringify({
      generationCounts,
      publications: [publications.intents.length, publications.receipts.length],
      reviews: reviews.records.length,
      rawLabeled: rawLabeled.length,
      unknown: unknown ? {
        id: unknown.id,
        status: unknown.status,
        attempts: unknown.attempts,
        checkpoint: {
          schemaVersion: unknown.subagentCheckpoint?.schemaVersion,
          stage: unknown.subagentCheckpoint?.stage,
          unknownCode: unknown.subagentCheckpoint?.unknown?.code,
          hasCallIntent: Boolean(unknown.subagentCheckpoint?.callIntent),
          hasOutput: Boolean(unknown.subagentCheckpoint?.output),
        },
        hasResultPath: Boolean(unknown.resultPath),
        hasCompanionPath: Boolean(unknown.companionPath),
        hasPublicationReceipt: Boolean(unknown.publicationReceiptId),
        hasCompanionPublicationReceipt: Boolean(unknown.companionPublicationReceiptId),
      } : { missing: true },
    })}`);
  }
  for (const outputPath of [unknown.expectedOutputPath, unknown.expectedCompanionPath].filter((value): value is string => Boolean(value))) {
    if (await exists(outputPath)) throw new Error(`unknown Job 不应有正式输出：${outputPath}`);
  }
  return {
    generationJobs: jobsSnapshot.file,
    publications: publicationsSnapshot.file,
    reviews: reviewsSnapshot.file,
    generationCounts,
    publicationCounts: { intents: publications.intents.length, receipts: publications.receipts.length },
    reviewCount: reviews.records.length,
    rawLabeled,
    projectIndex: {
      scanId: index.scanId,
      scannedAt: index.scannedAt,
      itemCount: index.items.length,
      artifactCount: index.artifacts.length,
      scanStats: index.scanStats,
    },
    legacyPanelArtifacts: legacyPanelArtifactSnapshot(jobs, index),
    legacyPanelReviews: legacyPanelReviewSnapshot(jobs, reviews),
    unknownJobIdentitySha256: digest(unknown),
    panelReferenceGenerationJobs: await validatePanelReferenceGenerationJobs(jobs, publications, store),
  };
}

async function p2ProtectedFileState(projectRoot: string): Promise<{
  projectConfig: FileEvidence;
  projectIndex: FileEvidence;
  projectOverrides: FileEvidence;
  storyboards: FileEvidence;
  fusionProjectManifest: FileEvidence;
  productionAssets: FileEvidence;
  continuityTracks: FileEvidence;
  storyboardGridSelections: FileEvidence;
  panelReferenceResolutions: FileEvidence;
}> {
  const sidecar = getSidecarPaths(projectRoot);
  return {
    projectConfig: await fileEvidence(sidecar.config),
    projectIndex: await fileEvidence(sidecar.index),
    projectOverrides: await fileEvidence(sidecar.overrides),
    storyboards: await fileEvidence(sidecar.storyboards),
    fusionProjectManifest: await fileEvidence(sidecar.fusionProjectManifest),
    productionAssets: await fileEvidence(sidecar.productionAssets),
    continuityTracks: await fileEvidence(sidecar.continuityTracks),
    storyboardGridSelections: await fileEvidence(sidecar.storyboardGridSelections),
    panelReferenceResolutions: await fileEvidence(sidecar.panelReferenceResolutions),
  };
}

function assertTrueAssertions(value: unknown, label: string): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 缺少 assertions。`);
  const assertions = value as Record<string, unknown>;
  if (!Object.keys(assertions).length || Object.entries(assertions).some(([, entry]) => entry !== true)) {
    throw new Error(`${label} 存在非 true 断言：${JSON.stringify(assertions)}`);
  }
  return assertions as Record<string, boolean>;
}

async function loadRequiredEvidence(filePath: string, expectedKind: string): Promise<{ file: FileEvidence; value: Record<string, any> }> {
  let before: Awaited<ReturnType<typeof stat>>;
  try {
    before = await stat(filePath);
  } catch {
    throw new Error(`缺少真实前置证据：${filePath}`);
  }
  const content = await readFile(filePath);
  const after = await stat(filePath);
  if (!before.isFile()
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
    || content.length !== before.size) {
    throw new Error(`读取前置证据期间文件发生变化：${filePath}`);
  }
  let value: Record<string, any>;
  try {
    value = JSON.parse(content.toString("utf8")) as Record<string, any>;
  } catch {
    throw new Error(`前置证据不是有效 JSON：${filePath}`);
  }
  if (value.kind !== expectedKind) throw new Error(`证据 kind 错误：${filePath} -> ${String(value.kind)}`);
  assertTrueAssertions(value.assertions, expectedKind);
  return { file: { path: filePath, bytes: content.length, sha256: sha256(content) }, value };
}

async function validateMigrationBackup(
  migrationValue: Record<string, any>,
  projectRoot: string,
): Promise<{ root: string; manifest: FileEvidence; filesChecked: number; gridFiles: number; gridInventorySha256: string }> {
  const backup = migrationValue.backup;
  const sidecar = getSidecarPaths(projectRoot);
  const backupRoot = path.resolve(backup?.backupRoot ?? "");
  const allowedRoot = path.join(sidecar.root, "backups");
  if (!isInside(allowedRoot, backupRoot) || backupRoot === path.resolve(allowedRoot)) {
    throw new Error("P2 migration 备份目录不在正式 sidecar/backups 的独立子目录内。");
  }
  const [canonicalAllowedRoot, canonicalBackupRoot] = await Promise.all([
    realpath(allowedRoot),
    realpath(backupRoot),
  ]);
  if (!isInside(canonicalAllowedRoot, canonicalBackupRoot) || canonicalAllowedRoot === canonicalBackupRoot) {
    throw new Error("P2 migration 备份目录经符号链接解析后越出正式 sidecar/backups。");
  }
  const files = Array.isArray(backup?.files) ? backup.files as Array<Record<string, any>> : [];
  const requiredSources = [
    sidecar.config,
    sidecar.index,
    sidecar.overrides,
    sidecar.events,
    sidecar.commandLedger,
    sidecar.storyboards,
    sidecar.fusionProjectManifest,
    sidecar.productionAssets,
    sidecar.continuityTracks,
    sidecar.reviews,
    sidecar.generationJobs,
    sidecar.publications,
    sidecar.storyboardGridSelections,
  ].map((entry) => path.resolve(entry));
  const seenSources = new Set<string>();
  const backupEvidenceBySource = new Map<string, { bytes: number; sha256: string }>();
  for (const entry of files) {
    const sourcePath = path.resolve(entry.sourcePath ?? "");
    const backupPath = path.resolve(entry.backupPath ?? "");
    if (!isInside(sidecar.root, sourcePath)
      || !isInside(backupRoot, backupPath)
      || !isInside(canonicalBackupRoot, await realpath(backupPath))
      || seenSources.has(sourcePath)) {
      throw new Error(`P2 migration 备份清单路径越界或重复：${sourcePath}`);
    }
    const actual = await fileEvidence(backupPath);
    if (entry.bytes !== actual.bytes || entry.sha256 !== actual.sha256) {
      throw new Error(`P2 migration 备份文件已漂移：${backupPath}`);
    }
    seenSources.add(sourcePath);
    backupEvidenceBySource.set(sourcePath, { bytes: actual.bytes, sha256: actual.sha256 });
  }
  const missing = requiredSources.filter((entry) => !seenSources.has(entry));
  if (missing.length) throw new Error(`P2 migration 备份缺少关键 sidecar：${missing.join("、")}`);
  const expectedSelectedContracts = Object.entries(migrationValue.preservedSelections?.before ?? {})
    .map(([unitId, selection]) => path.resolve(
      sidecar.storyboardGrids,
      unitId,
      `${(selection as FusionStoryboardGridSelection).contractId}.json`,
    ));
  if (expectedSelectedContracts.length !== PRESERVED_UNITS.length
    || expectedSelectedContracts.some((entry) => !seenSources.has(entry))) {
    throw new Error("P2 migration 备份没有包含 EP01_001/008 的迁移前内容寻址合同。");
  }
  const expectedPreMigrationFiles = [
    [sidecar.index, migrationValue.scanProjection?.index?.before],
    [sidecar.storyboardGridSelections, migrationValue.formalP2?.before?.selectionStore],
    [sidecar.overrides, migrationValue.formalP2?.before?.projectOverrides],
    [sidecar.generationJobs, migrationValue.protectedP1?.before?.generationJobs],
    [sidecar.publications, migrationValue.protectedP1?.before?.publications],
    [sidecar.reviews, migrationValue.protectedP1?.before?.reviews],
  ] as const;
  for (const [sourcePath, expectedEvidence] of expectedPreMigrationFiles) {
    const backupEvidence = backupEvidenceBySource.get(path.resolve(sourcePath));
    if (!backupEvidence
      || backupEvidence.sha256 !== expectedEvidence?.sha256
      || backupEvidence.bytes !== expectedEvidence?.bytes) {
      throw new Error(`P2 migration 备份与迁移前冻结文件证据不一致：${sourcePath}`);
    }
  }
  if (!Number.isInteger(backup?.gridFiles) || backup.gridFiles < 1 || !/^[a-f0-9]{64}$/u.test(backup?.gridInventorySha256 ?? "")) {
    throw new Error("P2 migration 备份缺少迁移前宫格合同清单摘要。");
  }
  const manifestPath = path.join(backupRoot, "manifest.json");
  if (!isInside(canonicalBackupRoot, await realpath(manifestPath))) {
    throw new Error("P2 migration 备份 manifest 经符号链接解析后越出备份目录。");
  }
  const manifestValue = await readJson<Record<string, any> | null>(manifestPath, null);
  if (!manifestValue
    || manifestValue.kind !== "p2-panel-reference-sidecar-backup"
    || path.resolve(manifestValue.projectRoot ?? "") !== path.resolve(projectRoot)
    || JSON.stringify(manifestValue.files) !== JSON.stringify(files)
    || manifestValue.gridInventory?.files !== backup.gridFiles
    || manifestValue.gridInventory?.sha256 !== backup.gridInventorySha256) {
    throw new Error("P2 migration 备份 manifest 与迁移证据不一致。");
  }
  return {
    root: backupRoot,
    manifest: await fileEvidence(manifestPath),
    filesChecked: files.length,
    gridFiles: backup.gridFiles,
    gridInventorySha256: backup.gridInventorySha256,
  };
}

async function validateUiEvidence(
  ui: { file: FileEvidence; value: Record<string, any> },
  screenshotPath: string,
  projectRoot: string,
  auditFingerprint: string,
): Promise<{ json: FileEvidence; screenshot: FileEvidence; dimensions: [number, number] }> {
  if (path.resolve(ui.value.projectRoot ?? "") !== path.resolve(projectRoot)) throw new Error("P2 UI 证据不属于当前正式隔离工程。");
  const serialized = JSON.stringify(ui.value);
  if (!serialized.includes(auditFingerprint) || !serialized.includes("4330") || !serialized.includes("166")) {
    throw new Error("P2 UI 证据没有冻结同一 audit fingerprint/4330 格/166 派生阻塞。");
  }
  if (!await exists(screenshotPath)) throw new Error(`P2 UI 真实截图不存在：${screenshotPath}`);
  const metadata = await sharp(screenshotPath).metadata();
  if (!metadata.width || !metadata.height || metadata.width < 900 || metadata.height < 600) {
    throw new Error(`P2 UI 截图不可解码或尺寸不合理：${JSON.stringify(metadata)}`);
  }
  const screenshot = await fileEvidence(screenshotPath);
  if (path.resolve(ui.value.screenshot?.path ?? "") !== path.resolve(screenshotPath)
    || ui.value.screenshot?.sha256 !== screenshot.sha256
    || ui.value.screenshot?.bytes !== screenshot.bytes
    || JSON.stringify(ui.value.screenshot?.dimensions) !== JSON.stringify([metadata.width, metadata.height])) {
    throw new Error("P2 UI JSON 没有以 path/SHA/bytes/dimensions 精确绑定当前真实截图，或截图已被替换。");
  }
  return { json: ui.file, screenshot, dimensions: [metadata.width, metadata.height] };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const input = options(argv);
  await assertSafeEvidencePaths(input);
  if (input.writeEvidence && await exists(input.evidencePath)) throw new Error(`最终证据已存在，拒绝覆盖：${input.evidencePath}`);

  const [sourceBefore, workspaceSourceBefore] = await Promise.all([
    sourceSnapshot(input.sourceRoot),
    workspaceSourceDigest(input.workspace),
  ]);
  if (JSON.stringify(sourceBefore) !== JSON.stringify(EXPECTED_SOURCE)) throw new Error(`第三季只读源基线漂移：${JSON.stringify(sourceBefore)}`);

  const store = await loadFusionPanelReferenceStore(input.projectRoot);
  if (!store) throw new Error("正式工程尚无 P2 逐格引用解析仓。");
  assertAudit(store.audit);
  const currentnessBefore = await inspectFusionPanelReferenceCurrentness(input.projectRoot, { verifyAllContractFiles: true });
  assertCurrentness(currentnessBefore, store, "关账前");
  if (Object.keys(store.resolutions).length !== 4_330 || Object.keys(store.derivedAssets).length !== 52 || Object.keys(store.overrides).length !== 0) {
    throw new Error(`P2 store 实体计数错误：${JSON.stringify({ resolutions: Object.keys(store.resolutions).length, derived: Object.keys(store.derivedAssets).length, overrides: Object.keys(store.overrides).length })}`);
  }
  Object.values(store.derivedAssets).forEach(assertDerivedDefinition);
  const catalog = await loadFusionProductionAssets(input.projectRoot);
  if (!catalog || catalog.assets.length !== 77) throw new Error("P2 引用闭包要求 77 项已冻结资产定义。");
  const knownAssetIds = new Set(catalog.assets.map((entry) => entry.definition.id));
  if (knownAssetIds.size !== 77) throw new Error("P2 资产目录 77 项定义中存在重复 assetId。");
  const resolutionValidation = await validateResolutions(store, knownAssetIds);
  const currentInputs = await validateCurrentInputs(input.projectRoot, store);
  for (const [key, expected] of Object.entries(EXPECTED_CONTRACT_SEMANTIC_COVERAGE)) {
    if (currentInputs.contractSemanticCoverage[key as keyof typeof EXPECTED_CONTRACT_SEMANTIC_COVERAGE] !== expected) {
      throw new Error(`P2 当前合同→语义闭包覆盖计数漂移：${key}`);
    }
  }
  if (currentInputs.contractSemanticCoverage.requiredContractAssetBindings
      + currentInputs.contractSemanticCoverage.semanticExtraBindings !== store.audit.semanticAssetBindings) {
    throw new Error("P2 合同必需资产与允许的 continuity extra 不能精确解释全部 semanticAssets。");
  }
  const p1Before = await validateP1ProtectedState(input.projectRoot, store);
  const p2FilesBefore = await p2ProtectedFileState(input.projectRoot);

  const migration = await loadRequiredEvidence(input.migrationEvidencePath, "p2-panel-reference-migration");
  if (path.resolve(migration.value.projectRoot ?? "") !== path.resolve(input.projectRoot)
    || migration.value.formal?.second?.storeFingerprint !== store.storeFingerprint
    || migration.value.formal?.second?.revision !== store.revision
    || migration.value.formal?.second?.resolutionFile?.sha256 !== p2FilesBefore.panelReferenceResolutions.sha256
    || migration.value.formalP2?.after?.selectionStore?.sha256 !== p2FilesBefore.storyboardGridSelections.sha256
    || migration.value.formalP2?.after?.projectOverrides?.sha256 !== p2FilesBefore.projectOverrides.sha256
    || migration.value.formalP2?.after?.resolutionStore?.sha256 !== p2FilesBefore.panelReferenceResolutions.sha256
    || migration.value.formal?.second?.inputSnapshot?.unitMarkdownsDigest !== store.inputSnapshot.unitMarkdownsDigest
    || JSON.stringify(migration.value.preservedSelections?.after) !== JSON.stringify(currentInputs.preservedSelections)) {
    throw new Error("P2 migration 证据与当前 store/保留选择不一致。");
  }
  const rehearsalEvidence = migration.value.rehearsal;
  if (rehearsalEvidence?.freshCopiesShareStoreFingerprint !== true
    || rehearsalEvidence?.idempotent !== true
    || rehearsalEvidence?.first?.storeFingerprint !== rehearsalEvidence?.second?.storeFingerprint
    || rehearsalEvidence?.freshReplica?.first?.storeFingerprint !== rehearsalEvidence?.freshReplica?.second?.storeFingerprint
    || rehearsalEvidence?.first?.storeFingerprint !== rehearsalEvidence?.freshReplica?.first?.storeFingerprint
    || rehearsalEvidence?.first?.audit?.auditFingerprint !== rehearsalEvidence?.freshReplica?.first?.audit?.auditFingerprint) {
    throw new Error("P2 migration 没有留下两份 fresh 演练内容身份相同且各自二次幂等的证据。");
  }
  const migrationWhitelist = migration.value.legacyGenerationJobWhitelist;
  const migrationWhitelistIds = [...(migrationWhitelist?.expected?.ids ?? [])]
    .sort((left: string, right: string) => left.localeCompare(right, "en"));
  if (migrationWhitelist?.immutable !== true
    || migrationWhitelist?.expected?.count !== migrationWhitelistIds.length
    || migrationWhitelist?.expected?.idsSha256 !== sha256(migrationWhitelistIds.join("\n"))
    || migrationWhitelistIds.join("\0") !== p1Before.panelReferenceGenerationJobs.legacy.ids.join("\0")
    || migrationWhitelistIds.join("\0") !== [...store.legacyGenerationJobIds].sort().join("\0")
    || JSON.stringify(migrationWhitelist.rehearsalFirst) !== JSON.stringify(store.legacyGenerationJobIds)
    || JSON.stringify(migrationWhitelist.rehearsalSecond) !== JSON.stringify(store.legacyGenerationJobIds)
    || JSON.stringify(migrationWhitelist.freshReplicaFirst) !== JSON.stringify(store.legacyGenerationJobIds)
    || JSON.stringify(migrationWhitelist.freshReplicaSecond) !== JSON.stringify(store.legacyGenerationJobIds)
    || JSON.stringify(migrationWhitelist.formalFirst) !== JSON.stringify(store.legacyGenerationJobIds)
    || JSON.stringify(migrationWhitelist.formalSecond) !== JSON.stringify(store.legacyGenerationJobIds)) {
    throw new Error("P2 历史逐格任务白名单没有由迁移前 live ledger 精确冻结，或演练/正式重放期间发生变化。");
  }
  const currentLegacyResolutionEvidence = p1Before.panelReferenceGenerationJobs.legacy.resolutionEvidence;
  const currentLegacyResolutionEvidenceSha256 = p1Before.panelReferenceGenerationJobs.legacy.resolutionEvidenceSha256;
  const currentLegacyEvidenceKinds = {
    currentResolution: p1Before.panelReferenceGenerationJobs.legacy.currentResolutionCount,
    obsoleteTerminal: p1Before.panelReferenceGenerationJobs.legacy.obsoleteTerminal.count,
    obsoleteTerminalJobIds: p1Before.panelReferenceGenerationJobs.legacy.obsoleteTerminal.ids,
  };
  if (currentLegacyEvidenceKinds.currentResolution !== 10
    || currentLegacyEvidenceKinds.obsoleteTerminal !== 1
    || JSON.stringify(currentLegacyEvidenceKinds.obsoleteTerminalJobIds) !== JSON.stringify([OBSOLETE_TERMINAL_JOB_ID])) {
    throw new Error("当前正式账不是 10 current-resolution + 1 指定 obsolete-terminal legacy evidence。");
  }
  const migrationResolutionEvidence = migrationWhitelist?.resolutionEvidence;
  const frozenResolutionEvidenceRecords: Array<[string, Record<string, any> | undefined]> = [
    ["rehearsalFirst", migrationResolutionEvidence?.rehearsalFirst],
    ["rehearsalSecond", migrationResolutionEvidence?.rehearsalSecond],
    ["freshReplicaFirst", migrationResolutionEvidence?.freshReplicaFirst],
    ["freshReplicaSecond", migrationResolutionEvidence?.freshReplicaSecond],
    ["formalFirst", migrationResolutionEvidence?.formalFirst],
    ["formalSecond", migrationResolutionEvidence?.formalSecond],
  ];
  for (const [stage, record] of frozenResolutionEvidenceRecords) {
    if (!record
      || record.sha256 !== currentLegacyResolutionEvidenceSha256
      || JSON.stringify(record.items) !== JSON.stringify(currentLegacyResolutionEvidence)
      || JSON.stringify(record.kinds) !== JSON.stringify(currentLegacyEvidenceKinds)) {
      throw new Error(`P2 ${stage} 没有精确冻结每个历史逐格任务的统一 ledger evidence。`);
    }
  }
  const materializationEvidenceRecords: Array<[string, Record<string, any> | undefined]> = [
    ["rehearsal.first", migration.value.rehearsal?.first],
    ["rehearsal.second", migration.value.rehearsal?.second],
    ["rehearsal.freshReplica.first", migration.value.rehearsal?.freshReplica?.first],
    ["rehearsal.freshReplica.second", migration.value.rehearsal?.freshReplica?.second],
    ["formal.first", migration.value.formal?.first],
    ["formal.second", migration.value.formal?.second],
  ];
  for (const [stage, record] of materializationEvidenceRecords) {
    if (!record
      || record.legacyGenerationJobEvidenceSha256 !== currentLegacyResolutionEvidenceSha256
      || JSON.stringify(record.legacyGenerationJobEvidence) !== JSON.stringify(currentLegacyResolutionEvidence)
      || JSON.stringify(record.legacyGenerationJobEvidenceKinds) !== JSON.stringify(currentLegacyEvidenceKinds)) {
      throw new Error(`P2 ${stage} materialization summary 与历史任务 resolution 旁路证据不一致。`);
    }
  }
  if (JSON.stringify(migration.value.protectedP1?.after?.generationJobs) !== JSON.stringify(p1Before.generationJobs)
    || JSON.stringify(migration.value.protectedP1?.after?.publications) !== JSON.stringify(p1Before.publications)
    || JSON.stringify(migration.value.protectedP1?.after?.reviews) !== JSON.stringify(p1Before.reviews)
    || JSON.stringify(migration.value.protectedP1?.after?.rawLabeled) !== JSON.stringify(p1Before.rawLabeled)
    || JSON.stringify(migration.value.protectedP1?.after?.legacyPanelArtifacts) !== JSON.stringify(p1Before.legacyPanelArtifacts)
    || JSON.stringify(migration.value.protectedP1?.after?.legacyPanelReviews) !== JSON.stringify(p1Before.legacyPanelReviews)) {
    throw new Error("P2 migration 后 P1 jobs/publications/reviews/raw/labeled/legacy artifacts/reviews 又发生了变化。");
  }
  const scanProjection = migration.value.scanProjection;
  if (!scanProjection
    || scanProjection.p1ProtectedIdentityUnchanged !== true
    || scanProjection.index?.changed !== true
    || scanProjection.index?.before?.sha256 === scanProjection.index?.after?.sha256
    || scanProjection.index?.after?.sha256 !== p2FilesBefore.projectIndex.sha256
    || scanProjection.index?.after?.bytes !== p2FilesBefore.projectIndex.bytes
    || scanProjection.scanId !== p1Before.projectIndex.scanId
    || scanProjection.scannedAt !== p1Before.projectIndex.scannedAt
    || scanProjection.itemCount !== p1Before.projectIndex.itemCount
    || scanProjection.artifactCount !== p1Before.projectIndex.artifactCount
    || scanProjection.scanStats?.includeHashes !== true
    || p1Before.projectIndex.scanStats?.includeHashes !== true
    || JSON.stringify(scanProjection.scanStats) !== JSON.stringify(p1Before.projectIndex.scanStats)
    || scanProjection.currentness?.current !== true
    || scanProjection.currentness?.storeRevision !== store.revision
    || scanProjection.currentness?.storeFingerprint !== store.storeFingerprint
    || (scanProjection.currentness?.driftedInputs?.length ?? -1) !== 0
    || scanProjection.legacyPanelArtifacts?.unchanged !== true
    || JSON.stringify(scanProjection.legacyPanelArtifacts?.before) !== JSON.stringify(migration.value.protectedP1?.before?.legacyPanelArtifacts)
    || JSON.stringify(scanProjection.legacyPanelArtifacts?.after) !== JSON.stringify(migration.value.protectedP1?.after?.legacyPanelArtifacts)
    || JSON.stringify(scanProjection.legacyPanelArtifacts?.after) !== JSON.stringify(p1Before.legacyPanelArtifacts)
    || scanProjection.legacyPanelReviews?.unchanged !== true
    || JSON.stringify(scanProjection.legacyPanelReviews?.before) !== JSON.stringify(migration.value.protectedP1?.before?.legacyPanelReviews)
    || JSON.stringify(scanProjection.legacyPanelReviews?.after) !== JSON.stringify(migration.value.protectedP1?.after?.legacyPanelReviews)
    || JSON.stringify(scanProjection.legacyPanelReviews?.after) !== JSON.stringify(p1Before.legacyPanelReviews)
    || scanProjection.reviews?.unchanged !== true
    || JSON.stringify(scanProjection.reviews?.before) !== JSON.stringify(migration.value.protectedP1?.before?.reviews)
    || JSON.stringify(scanProjection.reviews?.after) !== JSON.stringify(migration.value.protectedP1?.after?.reviews)
    || JSON.stringify(scanProjection.reviews?.after) !== JSON.stringify(p1Before.reviews)) {
    throw new Error("P2 migration 没有证明物化后的索引投影真实持久化且未改写 legacy Artifact/Review。");
  }
  if (migration.value.formalP2?.before?.projectOverrides?.sha256 !== p2FilesBefore.projectOverrides.sha256
    || migration.value.formalP2?.after?.projectOverrides?.sha256 !== p2FilesBefore.projectOverrides.sha256) {
    throw new Error("P2 migration 没有证明 project overrides 文件在迁移前后精确不变。");
  }
  const migrationBackup = await validateMigrationBackup(migration.value, input.projectRoot);

  const commandRuns = input.validateOnly ? undefined : await runCloseoutCommands(input);
  const [mcp, ui] = await Promise.all([
    loadRequiredEvidence(input.mcpEvidencePath, "p2-panel-reference-mcp-smoke"),
    loadRequiredEvidence(input.uiEvidencePath, "p2-panel-reference-ui-smoke"),
  ]);
  const compiledMcpServerPath = path.join(input.workspace, "dist-mcp/mcp/server.js");
  const compiledMcpServer = await fileEvidence(compiledMcpServerPath);
  if (path.resolve(mcp.value.serverPath ?? "") !== path.resolve(compiledMcpServerPath)
    || mcp.value.serverSha256 !== compiledMcpServer.sha256
    || path.resolve(mcp.value.projectRoot ?? "") !== path.resolve(input.projectRoot)
    || mcp.value.audit?.auditFingerprint !== store.audit.auditFingerprint
    || mcp.value.guardedFiles?.unchanged !== true
    || mcp.value.projectSnapshot?.skipped !== false
    || mcp.value.derived?.total !== 52
    || mcp.value.derived?.visualReady !== 0) {
    throw new Error("P2 编译 MCP 证据与当前引用仓不一致。");
  }
  const uiEvidence = await validateUiEvidence(ui, input.uiScreenshotPath, input.projectRoot, store.audit.auditFingerprint);

  const [sourceAfter, workspaceSourceAfter, p1After, p2FilesAfter, storeAfter, currentInputsAfter, currentnessAfter] = await Promise.all([
    sourceSnapshot(input.sourceRoot),
    workspaceSourceDigest(input.workspace),
    validateP1ProtectedState(input.projectRoot, store),
    p2ProtectedFileState(input.projectRoot),
    loadFusionPanelReferenceStore(input.projectRoot),
    validateCurrentInputs(input.projectRoot, store),
    inspectFusionPanelReferenceCurrentness(input.projectRoot, { verifyAllContractFiles: true }),
  ]);
  if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) throw new Error("最终只读验证期间第三季源发生变化。");
  if (JSON.stringify(workspaceSourceAfter) !== JSON.stringify(workspaceSourceBefore)) throw new Error("关账期间源码、测试或证据脚本发生变化，拒绝出具混合版本证据。");
  if (!storeAfter || storeAfter.storeFingerprint !== store.storeFingerprint || storeAfter.revision !== store.revision) {
    throw new Error("关账命令改写了 P2 引用仓。");
  }
  assertCurrentness(currentnessAfter, store, "关账后");
  if (JSON.stringify(currentInputsAfter) !== JSON.stringify(currentInputs)) {
    throw new Error("关账命令改写了当前宫格合同、冻结输入或 1288 份 Markdown 快照。");
  }
  if (p1After.generationJobs.sha256 !== p1Before.generationJobs.sha256
    || p1After.publications.sha256 !== p1Before.publications.sha256
    || p1After.reviews.sha256 !== p1Before.reviews.sha256
    || JSON.stringify(p1After.rawLabeled) !== JSON.stringify(p1Before.rawLabeled)
    || JSON.stringify(p1After.projectIndex) !== JSON.stringify(p1Before.projectIndex)
    || JSON.stringify(p1After.legacyPanelArtifacts) !== JSON.stringify(p1Before.legacyPanelArtifacts)
    || JSON.stringify(p1After.legacyPanelReviews) !== JSON.stringify(p1Before.legacyPanelReviews)
    || p1After.unknownJobIdentitySha256 !== p1Before.unknownJobIdentitySha256
    || JSON.stringify(p1After.panelReferenceGenerationJobs) !== JSON.stringify(p1Before.panelReferenceGenerationJobs)) {
    throw new Error("关账命令改写了 P1 受保护状态。");
  }
  if (JSON.stringify(p2FilesAfter) !== JSON.stringify(p2FilesBefore)) {
    throw new Error("关账命令改写了 P2 config/index/inputs/overrides/selections/resolution 受保护文件。");
  }
  const [migrationEvidenceAfter, mcpEvidenceAfter, uiJsonAfter, uiScreenshotAfter, compiledMcpServerAfter, migrationBackupAfter] = await Promise.all([
    fileEvidence(input.migrationEvidencePath),
    fileEvidence(input.mcpEvidencePath),
    fileEvidence(input.uiEvidencePath),
    fileEvidence(input.uiScreenshotPath),
    fileEvidence(compiledMcpServerPath),
    validateMigrationBackup(migration.value, input.projectRoot),
  ]);
  if (JSON.stringify(migrationEvidenceAfter) !== JSON.stringify(migration.file)
    || JSON.stringify(mcpEvidenceAfter) !== JSON.stringify(mcp.file)
    || JSON.stringify(uiJsonAfter) !== JSON.stringify(ui.file)
    || JSON.stringify(uiScreenshotAfter) !== JSON.stringify(uiEvidence.screenshot)
    || JSON.stringify(compiledMcpServerAfter) !== JSON.stringify(compiledMcpServer)
    || JSON.stringify(migrationBackupAfter) !== JSON.stringify(migrationBackup)) {
    throw new Error("最终关账读取的 migration/MCP/UI/截图/编译二进制/备份证据在验证期间发生变化。");
  }
  const panelReferenceFile = await fileEvidence(getSidecarPaths(input.projectRoot).panelReferenceResolutions);
  const assertions = {
    source3344Files24570877BytesAndAggregateShaExact: true,
    sourceUnchangedDuringValidation: true,
    workspaceSourceDigestStableDuringValidation: true,
    resolverStoreFingerprintValid: true,
    hardLocksReviewsArtifactsAndAllContractFilesCurrentBeforeAndAfter: true,
    currentInputsAnd1288ContractsCurrent: true,
    everyContractAssetMinusExplicitExclusionsAndEveryContinuityReferenceIsSemantic: true,
    panels4330AndDistributionExact: true,
    all77SemanticAssetsDefinedAndCompletelyBound: true,
    fourClosureErrorClassesZero: true,
    semanticSlotContractAndExplicitContinuityMissingBindingsZero: true,
    supplierSlotsAtMostSixWithoutSilentTruncation: true,
    derivedDefinitions52StructuralOnlyVisualReadyZero: true,
    overflowPanels166RemainGenerationBlockedPendingVisualArtifact: true,
    pendingHardLocksRemainGenerationReadinessBlockersNotClosureErrors: true,
    p1JobsPublicationsReviewsRawLabeledUnknownImmutable: true,
    legacyPanelGenerationJobWhitelistFrozenAndImmutable: true,
    everyLegacyPanelJobHasFrozenUnifiedLedgerEvidence: true,
    legacyEvidenceDistribution10CurrentResolution1ObsoleteTerminal: true,
    postMaterializationIndexProjectionPersistedAndCurrent: true,
    legacyPanelArtifactsAndReviewsUnchangedAcrossMigrationScanAndCloseout: true,
    migrationUsedTwoFreshDeterministicRehearsals: true,
    everyNonLegacyPanelJobCarriesCurrentP2ResolutionIdentity: true,
    ep01Unit001And008SelectionIdentityPreserved: true,
    migrationEvidenceMatchesCurrentState: true,
    migrationBackupManifestAndFilesRemainHashExact: true,
    compiledMcpEvidenceMatchesCurrentState: true,
    compiledMcpEvidenceBindsCurrentServerBinarySha: true,
    realUiEvidenceAndDecodableScreenshotMatchCurrentAudit: true,
    formalCloseoutCommandsExecutedAndPassed: !input.validateOnly && Boolean(commandRuns
      && Object.values(commandRuns).length === 6
      && Object.values(commandRuns).every((run) => run.exitCode === 0)),
    closeoutCommandsDidNotMutateP1OrP2FormalState: true,
    externalEvidenceAndCompiledBinaryStableDuringValidation: true,
  };
  const evidence = {
    schemaVersion: 1,
    kind: "p2-panel-reference-closure-final-validation",
    createdAt: new Date().toISOString(),
    validationMode: input.validateOnly ? "validate-only-existing-evidence" : "formal-closeout-six-real-commands",
    workspace: input.workspace,
    projectRoot: input.projectRoot,
    sourceRoot: input.sourceRoot,
    source: { before: sourceBefore, after: sourceAfter, unchanged: true },
    workspaceSource: { before: workspaceSourceBefore, after: workspaceSourceAfter, unchanged: true },
    store: {
      schemaVersion: store.schemaVersion,
      resolverVersion: store.resolverVersion,
      revision: store.revision,
      storeFingerprint: store.storeFingerprint,
      updatedAt: store.updatedAt,
      file: panelReferenceFile,
      audit: store.audit,
      currentness: { before: currentnessBefore, after: currentnessAfter },
      resolutionIdentitySha256: resolutionValidation.identitySha256,
      closureCounts: resolutionValidation.closureCounts,
      readinessCounts: resolutionValidation.readinessCounts,
      readySlotFilesChecked: resolutionValidation.readySlotFilesChecked,
      semanticAssetCoverage: resolutionValidation.semanticAssetCoverage,
      recomputedResolutionAuditSha256: resolutionValidation.recomputedResolutionAuditSha256,
      derived: { total: 52, definitionApproved: 52, visualReady: 0 },
    },
    currentInputs,
    protectedP1: { before: p1Before, after: p1After, unchanged: true },
    protectedP2Files: { before: p2FilesBefore, after: p2FilesAfter, unchanged: true },
    commandRuns: commandRuns ?? {
      mode: "validate-only",
      note: "本次未重跑命令；只复核指定的已有 migration/MCP/UI 证据。",
    },
    externalEvidence: {
      migration: { evidence: migration.file, backup: migrationBackup },
      mcp: { evidence: mcp.file, server: compiledMcpServer },
      ui: uiEvidence,
    },
    productionReadinessBoundary: {
      closurePassed: true,
      generationReadyPanels: store.audit.generationReadyPanels,
      pendingHardLockPanels: store.audit.pendingHardLockPanels,
      pendingDerivedArtifactPanels: store.audit.pendingDerivedArtifactPanels,
      note: "P2 引用语义闭包已完成；57 项待硬锁资产与 52 个待视觉验收派生组合仍按格阻断生图，不得把结构定义当作视觉就绪。",
    },
    assertions,
  };
  if (input.writeEvidence) {
    if (Object.values(assertions).some((value) => value !== true)) {
      throw new Error(`正式关账仍有未通过断言：${JSON.stringify(assertions)}`);
    }
    await mkdir(path.dirname(input.evidencePath), { recursive: true });
    await writeJsonAtomicExclusive(input.evidencePath, evidence);
  }
  process.stdout.write(`${JSON.stringify({
    evidencePath: input.writeEvidence ? input.evidencePath : undefined,
    audit: store.audit,
    store: { revision: store.revision, storeFingerprint: store.storeFingerprint, file: panelReferenceFile },
    derived: evidence.store.derived,
    productionReadinessBoundary: evidence.productionReadinessBoundary,
    externalEvidence: evidence.externalEvidence,
    assertions,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
