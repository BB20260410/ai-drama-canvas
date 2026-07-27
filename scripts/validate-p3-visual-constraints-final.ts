import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import fg from "fast-glob";
import sharp from "sharp";
import {
  inspectFusionPanelReferenceCurrentness,
  loadFusionPanelReferenceStoreSnapshot,
} from "../src/core/fusion-panel-references.js";
import {
  inspectFusionPanelVisualConstraintCurrentness,
  loadFusionPanelVisualConstraintStore,
} from "../src/core/fusion-visual-constraint-store.js";
import type {
  FusionPanelVisualConstraintStore,
  PanelVisualConstraint,
  PanelVisualConstraintAudit,
} from "../src/core/fusion-visual-constraints.js";
import {
  FUSION_SUBAGENT_GENERIC_INSTRUCTIONS,
  getGenerationSettings,
} from "../src/core/generation.js";
import {
  buildFusionStoryboardReviewRequirement,
  loadFusionStoryboardEvidenceSnapshot,
} from "../src/core/fusion-storyboard-evidence.js";
import { reviewCoversFusionStoryboardRequirement } from "../src/core/review-evidence.js";
import { getSidecarPaths, readJson, writeJsonAtomicExclusive } from "../src/core/sidecar.js";
import type {
  GenerationJob,
  ProjectIndex,
  ReviewRecord,
  ReviewStore,
} from "../src/core/types.js";
import type { PublicationStore } from "../src/core/publication.js";
import { expectedRuntimeMcpToolCount } from "../src/core/release-manifest.js";

const DEFAULT_WORKSPACE = "/Users/hxx/Documents/无限画布";
const DEFAULT_PROJECT_RELATIVE = "productions/gushujuan-s3-f1a688020bfb7af6";
const DEFAULT_SOURCE_ROOT = "/Users/hxx/Documents/古蜀卷第三季";
const EXPECTED_SOURCE = {
  files: 3_344,
  bytes: 24_570_877,
  aggregateSha256: "649160f22663ca4c45ee4a4084e278ef0edc61ec66db01bb84da38cbea3f8d26",
} as const;
const EXPECTED_AUDIT = {
  contracts: 1_288,
  expectedPanels: 4_330,
  constraints: 4_330,
  onScreenAssets: 12_502,
  continuityOnlyAssets: 1_310,
  optionalOffscreenAssets: 0,
  unresolvedIdentityLocks: 8_331,
  unresolvedSpatialLocks: 24_992,
  unresolvedContinuityLocks: 440,
  concealedMaskPanels: 304,
  revealAuthorizedPanels: 0,
} as const;
const EXPECTED_TOOLS = await expectedRuntimeMcpToolCount(DEFAULT_WORKSPACE);
const UNKNOWN_JOB_ID = "gen-2026-07-16T12-10-57-215Z-892023c0";
const EP01_001 = "season-三-ep01-unit001";
const EP01_008 = "season-三-ep01-unit008";
const RAW_LABELED_PATTERNS = ["**/*_raw.png", "**/*_labeled.png"];
const RAW_LABELED_IGNORES = [
  ".aicanvas/backups/**",
  ".aicanvas/generation-downloads/**",
  ".aicanvas/subagent-staging/**",
];
const IMMUTABLE_SIDECAR_IGNORES = [
  "generation.json",
  "events.jsonl",
  "panel-visual-constraints.json",
  "backups/**",
  "locks/**",
];
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const LOCAL_PATH_PATTERN = /(?:file:\/\/|\/Users\/|\/private\/|\/var\/|\/tmp\/|[A-Za-z]:\\)/iu;
const HIDDEN_MASK_PATTERN = /(?:黄金面具|完整面具|半面具|裂面具|面具口型|纵目结构|兽耳结构|獠牙结构)/iu;

interface CliOptions {
  workspace: string;
  projectRoot: string;
  sourceRoot: string;
  evidencePath: string;
  migrationRehearsalPath: string;
  migrationEvidencePath: string;
  mcpEvidencePath: string;
  uiEvidencePath: string;
  uiScreenshotPath: string;
  runRoot: string;
}

interface FileEvidence {
  path: string;
  bytes: number;
  sha256: string;
}

interface InventorySnapshot {
  root: string;
  files: number;
  bytes: number;
  aggregateSha256: string;
}

interface SourceSnapshot extends InventorySnapshot {}

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
  testSummary?: { filesPassed: number; testsPassed: number; filesSkipped: number; testsSkipped: number };
}

interface ImageEvidence extends FileEvidence {
  relativePath: string;
  width: number;
  height: number;
  aspectRatio: number;
  entropy: number;
  maximumChannelDeviation: number;
}

interface ImagePairEvidence {
  key: string;
  raw: ImageEvidence;
  labeled: ImageEvidence;
}

interface GuardedState {
  files: {
    projectConfig: FileEvidence;
    projectIndex: FileEvidence;
    projectOverrides: FileEvidence;
    events: FileEvidence;
    commandLedger: FileEvidence;
    storyboards: FileEvidence;
    fusionManifest: FileEvidence;
    productionAssets: FileEvidence;
    continuityTracks: FileEvidence;
    gridSelections: FileEvidence;
    p2PanelReferences: FileEvidence;
    p3VisualConstraints: FileEvidence;
    generationSettings: FileEvidence;
    generationJobs: FileEvidence;
    publications: FileEvidence;
    reviews: FileEvidence;
  };
  immutableSidecar: InventorySnapshot;
  historicalRequests: InventorySnapshot;
  generationDownloads: InventorySnapshot;
  subagentStaging: InventorySnapshot;
  rawLabeled: InventorySnapshot;
  identitySha256: string;
}

function usage(): string {
  return `P3 结构化剧情与视觉硬锁最终关账（正式 production 只读）

用法：
  npx tsx scripts/validate-p3-visual-constraints-final.ts [参数]

参数：
  --workspace <path>
  --project-root <path>
  --source-root <path>
  --migration-rehearsal <json>
  --migration-evidence <json>
  --mcp-evidence <json>
  --ui-evidence <json>
  --ui-screenshot <png>
  --evidence <json>       最终证据；必须位于 workspace/docs/evidence，且不得存在
  --run-root <dir>        七项真实命令的唯一独占日志目录
  --help

本验证器运行 typecheck、6 文件 P3 定向测试、全量测试、production build、
两次只读迁移预检和一次只读 MCP 烟测。任一门禁失败均不写 final JSON；
不启动 Electron、浏览器、供应商或生图任务，也不修改正式 production。
`;
}

function optionValue(argv: string[], name: string): string | undefined {
  const indexes = argv.flatMap((entry, index) => entry === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} 不得重复。`);
  if (!indexes.length) return undefined;
  const value = argv[indexes[0]! + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少路径参数。`);
  return value;
}

function parseOptions(argv: string[]): CliOptions {
  const known = new Set([
    "--workspace", "--project-root", "--source-root", "--migration-rehearsal",
    "--migration-evidence", "--mcp-evidence", "--ui-evidence", "--ui-screenshot",
    "--evidence", "--run-root", "--help", "-h",
  ]);
  for (const entry of argv.filter((value) => value.startsWith("--") || value === "-h")) {
    if (!known.has(entry)) throw new Error(`未知参数：${entry}`);
  }
  const workspace = path.resolve(optionValue(argv, "--workspace") ?? DEFAULT_WORKSPACE);
  const evidenceRoot = path.join(workspace, "docs", "evidence");
  return {
    workspace,
    projectRoot: path.resolve(optionValue(argv, "--project-root") ?? path.join(workspace, DEFAULT_PROJECT_RELATIVE)),
    sourceRoot: path.resolve(optionValue(argv, "--source-root") ?? DEFAULT_SOURCE_ROOT),
    evidencePath: path.resolve(optionValue(argv, "--evidence") ?? path.join(evidenceRoot, "final-validation-20260717-p3-visual-constraints.json")),
    migrationRehearsalPath: path.resolve(optionValue(argv, "--migration-rehearsal") ?? path.join(evidenceRoot, "p3-visual-constraints-migration-rehearsal-20260717.json")),
    migrationEvidencePath: path.resolve(optionValue(argv, "--migration-evidence") ?? path.join(evidenceRoot, "p3-visual-constraints-migration-20260717.json")),
    mcpEvidencePath: path.resolve(optionValue(argv, "--mcp-evidence") ?? path.join(evidenceRoot, "p3-visual-constraints-mcp-final-20260717.json")),
    uiEvidencePath: path.resolve(optionValue(argv, "--ui-evidence") ?? path.join(evidenceRoot, "p3-visual-constraints-ui-final-20260717.json")),
    uiScreenshotPath: path.resolve(optionValue(argv, "--ui-screenshot") ?? path.join(evidenceRoot, "p3-visual-constraints-ui-final-20260717.png")),
    runRoot: path.resolve(optionValue(argv, "--run-root") ?? path.join(evidenceRoot, "p3-visual-constraints-final-runs-20260717-01")),
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

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true).catch(() => false);
}

async function nearestExistingRealPath(candidate: string): Promise<{ real: string; suffix: string[] }> {
  const suffix: string[] = [];
  let cursor = path.resolve(candidate);
  while (!await exists(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`无法定位现存父目录：${candidate}`);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return { real: await realpath(cursor), suffix };
}

async function assertSafePaths(input: CliOptions): Promise<void> {
  const evidenceRoot = path.join(input.workspace, "docs", "evidence");
  const productionsRoot = path.join(input.workspace, "productions");
  const [workspace, project, source, evidence, productions] = await Promise.all([
    realpath(input.workspace),
    realpath(input.projectRoot),
    realpath(input.sourceRoot),
    realpath(evidenceRoot),
    realpath(productionsRoot),
  ]);
  if (!isInside(workspace, evidence) || evidence === workspace) throw new Error("docs/evidence 不在工作区内。");
  if (!isInside(productions, project) || project === productions) throw new Error("正式工程必须位于 workspace/productions 的隔离子目录。 ");
  if (project === source || isInside(project, source) || isInside(source, project)) throw new Error("正式工程与只读源不得相同或互相嵌套。 ");
  const targets = [
    ["final evidence", input.evidencePath],
    ["run root", input.runRoot],
    ["migration rehearsal", input.migrationRehearsalPath],
    ["migration evidence", input.migrationEvidencePath],
    ["MCP evidence", input.mcpEvidencePath],
    ["UI evidence", input.uiEvidencePath],
    ["UI screenshot", input.uiScreenshotPath],
  ] as const;
  const canonicalTargets = new Set<string>();
  for (const [label, target] of targets) {
    if (!isInside(evidenceRoot, target) || path.resolve(target) === path.resolve(evidenceRoot)) {
      throw new Error(`${label} 必须位于 workspace/docs/evidence 内。`);
    }
    const parent = await nearestExistingRealPath(path.dirname(target));
    const canonical = await exists(target)
      ? await realpath(target)
      : path.join(parent.real, ...parent.suffix, path.basename(target));
    if (!isInside(evidence, canonical) || isInside(project, canonical) || isInside(source, canonical)) {
      throw new Error(`${label} 经符号链接解析后越界：${target}`);
    }
    if (canonicalTargets.has(canonical)) throw new Error(`证据或日志路径相互复用：${target}`);
    canonicalTargets.add(canonical);
  }
  if (await exists(input.evidencePath)) throw new Error(`最终证据已存在，拒绝覆盖：${input.evidencePath}`);
  if (await exists(input.runRoot)) throw new Error(`最终日志目录已存在，拒绝覆盖：${input.runRoot}`);
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
  const link = await lstat(filePath);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error(`只接受普通文件：${filePath}`);
  const before = await stat(filePath);
  const fileSha256 = await sha256File(filePath);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`计算文件摘要期间发生变化：${filePath}`);
  }
  return { path: filePath, bytes: before.size, sha256: fileSha256 };
}

async function readJsonEvidence<T>(filePath: string): Promise<{ value: T; file: FileEvidence }> {
  const before = await stat(filePath);
  const content = await readFile(filePath);
  const after = await stat(filePath);
  if (!before.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`读取 JSON 期间发生变化：${filePath}`);
  }
  let value: T;
  try {
    value = JSON.parse(content.toString("utf8")) as T;
  } catch {
    throw new Error(`JSON 无法解析：${filePath}`);
  }
  return { value, file: { path: filePath, bytes: content.length, sha256: sha256(content) } };
}

async function listRegularFiles(root: string, patterns: string | string[] = "**/*", ignore: string[] = []): Promise<string[]> {
  if (!await exists(root)) return [];
  const entries = (await fg(patterns, {
    cwd: root,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
    unique: true,
    ignore,
  })).sort((left, right) => left.localeCompare(right, "en"));
  const files: string[] = [];
  for (const relativePath of entries) {
    const metadata = await lstat(path.join(root, ...relativePath.split("/")));
    if (metadata.isSymbolicLink()) throw new Error(`受保护清单包含符号链接：${path.join(root, relativePath)}`);
    if (metadata.isDirectory()) continue;
    if (!metadata.isFile()) throw new Error(`受保护清单包含非普通文件：${path.join(root, relativePath)}`);
    files.push(relativePath);
  }
  return files;
}

async function mapLimit<T, R>(values: readonly T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(values.length, 1), limit) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!);
    }
  }));
  return results;
}

async function inventorySnapshot(
  root: string,
  options: { patterns?: string | string[]; ignore?: string[]; includeMtime?: boolean } = {},
): Promise<InventorySnapshot> {
  const relativePaths = await listRegularFiles(root, options.patterns, options.ignore);
  const records = await mapLimit(relativePaths, 8, async (relativePath) => {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const before = await stat(absolutePath);
    const fileSha256 = await sha256File(absolutePath);
    const after = await stat(absolutePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`冻结清单期间文件发生变化：${absolutePath}`);
    }
    return { relativePath, bytes: before.size, sha256: fileSha256, ...(options.includeMtime ? { mtimeMs: before.mtimeMs } : {}) };
  });
  return {
    root,
    files: records.length,
    bytes: records.reduce((sum, entry) => sum + entry.bytes, 0),
    aggregateSha256: sha256(records.map((entry) => `${entry.relativePath}\0${entry.bytes}\0${"mtimeMs" in entry ? `${entry.mtimeMs}\0` : ""}${entry.sha256}`).join("\n")),
  };
}

async function sourceSnapshot(root: string): Promise<SourceSnapshot> {
  return inventorySnapshot(root, { includeMtime: true });
}

async function workspaceSourceDigest(workspace: string): Promise<{ files: number; aggregateSha256: string }> {
  const files = (await fg([
    "src/**/*", "tests/**/*", "scripts/**/*", "package.json", "package-lock.json",
    "tsconfig*.json", "electron.vite.config.ts", "vitest.config.ts",
  ], { cwd: workspace, onlyFiles: true, followSymbolicLinks: false, dot: true }))
    .sort((left, right) => left.localeCompare(right, "en"));
  const records = await mapLimit(files, 8, async (relativePath) => `${relativePath}\0${await sha256File(path.join(workspace, relativePath))}`);
  return { files: files.length, aggregateSha256: sha256(records.join("\n")) };
}

function tailLines(value: string, limit = 60): string[] {
  return value.split(/\r?\n/u).filter(Boolean).slice(-limit);
}

function parseTestSummary(output: string): RunEvidence["testSummary"] {
  const normalized = output.replace(/\u001b\[[0-9;]*m/gu, "");
  const files = normalized.match(/Test Files\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?/u);
  const tests = normalized.match(/Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?/u);
  if (!files || !tests) return undefined;
  return {
    filesPassed: Number(files[1]),
    testsPassed: Number(tests[1]),
    filesSkipped: Number(files[2] ?? 0),
    testsSkipped: Number(tests[2] ?? 0),
  };
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
  process.stderr.write(`[P3 final] ${name}: ${argv.join(" ")}\n`);
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
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
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
      if (forceKill) clearTimeout(forceKill);
      if (fallback) clearTimeout(fallback);
      resolve({ exitCode, stdout, stderr, timedOut, signalsSent, exitSignal, spawnError });
    };
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => finish(-1, undefined, error instanceof Error ? error.message : String(error)));
    child.once("close", (code, signal) => finish(code ?? -1, signal ?? undefined));
    timeout = setTimeout(() => {
      timedOut = true;
      stderr += `\n[P3 final] ${name} 超过 ${timeoutMs}ms，终止独立进程组。\n`;
      signalTree("SIGTERM");
      forceKill = setTimeout(() => {
        signalTree("SIGKILL");
        fallback = setTimeout(() => {
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
    stdout: { ...await fileEvidence(stdoutPath), tail: tailLines(result.stdout) },
    stderr: { ...await fileEvidence(stderrPath), tail: tailLines(result.stderr) },
    testSummary: parseTestSummary(`${result.stdout}\n${result.stderr}`),
  };
  if (result.exitCode !== 0 || result.timedOut || result.spawnError) {
    throw new Error(`${name} 失败（exit ${result.exitCode}${result.timedOut ? ", timeout" : ""}）：\n${[...evidence.stdout.tail, ...evidence.stderr.tail].slice(-80).join("\n")}`);
  }
  return evidence;
}

async function runCloseoutCommands(input: CliOptions): Promise<Record<string, RunEvidence>> {
  await mkdir(path.dirname(input.runRoot), { recursive: true });
  await mkdir(input.runRoot, { recursive: false });
  const runs: Record<string, RunEvidence> = {};
  runs.typecheck = await runCommand(input.workspace, input.runRoot, "01-typecheck", "npm", ["run", "typecheck"], 240_000);
  runs.targeted = await runCommand(input.workspace, input.runRoot, "02-p3-targeted-tests", "npx", [
    "vitest", "run",
    "tests/fusion-visual-constraints.test.ts",
    "tests/fusion-visual-review.test.ts",
    "tests/fusion-visual-generation.test.ts",
    "tests/fusion-production.test.ts",
    "tests/mcp.test.ts",
    "tests/mcp-fusion-production.test.ts",
    "--maxWorkers=1",
  ], 600_000);
  if (!runs.targeted.testSummary
    || runs.targeted.testSummary.filesPassed !== 6
    || runs.targeted.testSummary.filesSkipped !== 0
    || runs.targeted.testSummary.testsPassed < 1) {
    throw new Error(`P3 定向测试没有形成 6 文件全通过证据：${JSON.stringify(runs.targeted.testSummary)}`);
  }
  runs.full = await runCommand(input.workspace, input.runRoot, "03-full-tests", "npm", ["test"], 900_000);
  if (!runs.full.testSummary
    || runs.full.testSummary.filesPassed < runs.targeted.testSummary.filesPassed
    || runs.full.testSummary.testsPassed < runs.targeted.testSummary.testsPassed) {
    throw new Error(`全量测试计数小于 P3 定向测试：${JSON.stringify(runs.full.testSummary)}`);
  }
  runs.build = await runCommand(input.workspace, input.runRoot, "04-production-build", "npm", ["run", "build"], 360_000);
  const migrationArgs = [
    "tsx", "scripts/migrate-p3-visual-constraints.ts",
    "--workspace", input.workspace,
    "--project-root", input.projectRoot,
    "--source-root", input.sourceRoot,
  ];
  runs.migrationReadOnlyFirst = await runCommand(input.workspace, input.runRoot, "05-migration-readonly-first", "npx", migrationArgs, 600_000);
  runs.migrationReadOnlySecond = await runCommand(input.workspace, input.runRoot, "06-migration-readonly-second", "npx", migrationArgs, 600_000);
  runs.mcpReadOnly = await runCommand(input.workspace, input.runRoot, "07-compiled-mcp-readonly", "npx", [
    "tsx", "scripts/mcp-p3-visual-constraints-smoke.ts",
    "--workspace", input.workspace,
    "--project-root", input.projectRoot,
  ], 240_000);
  return runs;
}

function assertAudit(audit: PanelVisualConstraintAudit): void {
  for (const [key, expected] of Object.entries(EXPECTED_AUDIT)) {
    if (audit[key as keyof PanelVisualConstraintAudit] !== expected) {
      throw new Error(`P3 audit.${key} 应为 ${expected}，实际 ${String(audit[key as keyof PanelVisualConstraintAudit])}`);
    }
  }
  const zeroFields = [
    audit.missingConstraints,
    audit.extraConstraints,
    audit.invalidConstraints,
    audit.duplicateConstraintIds,
    audit.invalidModelFingerprints,
    audit.invalidReviewRulesFingerprints,
    audit.modelPromptLeakPanels,
    audit.modelPathLeakPanels,
    audit.warningsWithoutReviewRules,
  ];
  if (zeroFields.some((value) => value !== 0) || !audit.closurePassed || !SHA256_PATTERN.test(audit.auditFingerprint)) {
    throw new Error(`P3 审计未闭包或泄漏/完整性错误未归零：${JSON.stringify(audit)}`);
  }
}

function validateConstraints(store: FusionPanelVisualConstraintStore): {
  identitySha256: string;
  independentlyRecomputed: Record<string, number>;
  generationReadyPanels: number;
  reviewRules: number;
  warnings: number;
  legacyGenerationJobEvidence: number;
} {
  const constraints = Object.entries(store.constraints).sort(([left], [right]) => left.localeCompare(right, "en"));
  const ids = new Set<string>();
  let onScreenAssets = 0;
  let continuityOnlyAssets = 0;
  let optionalOffscreenAssets = 0;
  let unresolvedIdentityLocks = 0;
  let unresolvedSpatialLocks = 0;
  let unresolvedContinuityLocks = 0;
  let concealedMaskPanels = 0;
  let revealAuthorizedPanels = 0;
  let modelPromptLeakPanels = 0;
  let modelPathLeakPanels = 0;
  let generationReadyPanels = 0;
  let reviewRules = 0;
  let warnings = 0;
  const identities: string[] = [];
  for (const [key, constraint] of constraints) {
    if (key !== `${constraint.gridContractId}:${constraint.panelId}` || ids.has(constraint.constraintId)) {
      throw new Error(`P3 constraint map key 或 constraintId 重复：${key}`);
    }
    ids.add(constraint.constraintId);
    for (const value of [constraint.fingerprint, constraint.modelFingerprint, constraint.reviewRulesFingerprint]) {
      if (!SHA256_PATTERN.test(value)) throw new Error(`P3 constraint 缺少有效 fingerprint：${constraint.constraintId}`);
    }
    if (!constraint.humanVisualReviewRequired
      || !constraint.reviewRules.length
      || constraint.reviewRules.length !== constraint.warnings.length
      || new Set(constraint.reviewRules.map((rule) => rule.id)).size !== constraint.reviewRules.length) {
      throw new Error(`P3 constraint 没有逐项人工规则或规则身份重复：${constraint.constraintId}`);
    }
    onScreenAssets += constraint.assetPresence.filter((entry) => entry.presence === "on-screen").length;
    continuityOnlyAssets += constraint.assetPresence.filter((entry) => entry.presence === "continuity-only").length;
    optionalOffscreenAssets += constraint.assetPresence.filter((entry) => entry.presence === "optional-offscreen").length;
    unresolvedIdentityLocks += constraint.identityLocks.filter((entry) => entry.status === "unresolved").length;
    unresolvedSpatialLocks += constraint.spatialLocks.filter((entry) => entry.status === "unresolved").length;
    unresolvedContinuityLocks += constraint.continuityLocks.filter((entry) => entry.status === "unresolved").length;
    concealedMaskPanels += Number(constraint.hiddenMaskPolicy.status === "concealed");
    revealAuthorizedPanels += Number(constraint.hiddenMaskPolicy.status === "reveal-authorized");
    generationReadyPanels += Number(constraint.generationGate.status === "ready");
    reviewRules += constraint.reviewRules.length;
    warnings += constraint.warnings.length;
    const modelText = [
      constraint.modelPrompt,
      constraint.modelNegativePrompt,
      ...constraint.mustAppear.map((entry) => entry.modelInstruction),
      ...constraint.mustNotAppear.map((entry) => entry.modelInstruction),
    ].join("\n");
    modelPathLeakPanels += Number(LOCAL_PATH_PATTERN.test(modelText));
    modelPromptLeakPanels += Number(constraint.episodeNumber < 32 && HIDDEN_MASK_PATTERN.test(modelText));
    identities.push(`${key}\0${constraint.constraintId}\0${constraint.fingerprint}\0${constraint.modelFingerprint}\0${constraint.reviewRulesFingerprint}`);
  }
  const independentlyRecomputed = {
    contracts: new Set(constraints.map(([, entry]) => entry.gridContractId)).size,
    constraints: constraints.length,
    onScreenAssets,
    continuityOnlyAssets,
    optionalOffscreenAssets,
    unresolvedIdentityLocks,
    unresolvedSpatialLocks,
    unresolvedContinuityLocks,
    concealedMaskPanels,
    revealAuthorizedPanels,
    modelPromptLeakPanels,
    modelPathLeakPanels,
  };
  for (const [key, expected] of Object.entries(EXPECTED_AUDIT)) {
    const actual = independentlyRecomputed[key as keyof typeof independentlyRecomputed];
    if (actual !== undefined && actual !== expected) throw new Error(`P3 constraints 独立重算 ${key} 漂移：${actual}`);
  }
  if (modelPromptLeakPanels !== 0 || modelPathLeakPanels !== 0 || generationReadyPanels !== 610) {
    throw new Error(`P3 独立模型隔离或就绪计数异常：${JSON.stringify({ modelPromptLeakPanels, modelPathLeakPanels, generationReadyPanels })}`);
  }
  return {
    identitySha256: sha256(identities.join("\n")),
    independentlyRecomputed,
    generationReadyPanels,
    reviewRules,
    warnings,
    legacyGenerationJobEvidence: Object.keys(store.legacyGenerationJobEvidence).length,
  };
}

async function guardedState(projectRoot: string): Promise<GuardedState> {
  const sidecar = getSidecarPaths(projectRoot);
  const namedFiles = {
    projectConfig: sidecar.config,
    projectIndex: sidecar.index,
    projectOverrides: sidecar.overrides,
    events: sidecar.events,
    commandLedger: sidecar.commandLedger,
    storyboards: sidecar.storyboards,
    fusionManifest: sidecar.fusionProjectManifest,
    productionAssets: sidecar.productionAssets,
    continuityTracks: sidecar.continuityTracks,
    gridSelections: sidecar.storyboardGridSelections,
    p2PanelReferences: sidecar.panelReferenceResolutions,
    p3VisualConstraints: sidecar.panelVisualConstraints,
    generationSettings: sidecar.generationSettings,
    generationJobs: sidecar.generationJobs,
    publications: sidecar.publications,
    reviews: sidecar.reviews,
  };
  const files = Object.fromEntries(await Promise.all(Object.entries(namedFiles).map(async ([name, filePath]) => [name, await fileEvidence(filePath)]))) as GuardedState["files"];
  const [immutableSidecar, historicalRequests, generationDownloads, subagentStaging, rawLabeled] = await Promise.all([
    inventorySnapshot(sidecar.root, { ignore: IMMUTABLE_SIDECAR_IGNORES }),
    inventorySnapshot(sidecar.generationRequests),
    inventorySnapshot(sidecar.generationDownloads),
    inventorySnapshot(path.join(sidecar.root, "subagent-staging")),
    inventorySnapshot(projectRoot, { patterns: RAW_LABELED_PATTERNS, ignore: RAW_LABELED_IGNORES }),
  ]);
  const base = { files, immutableSidecar, historicalRequests, generationDownloads, subagentStaging, rawLabeled };
  return { ...base, identitySha256: digest(base) };
}

async function imageEvidence(projectRoot: string, relativePath: string): Promise<ImageEvidence> {
  const absolutePath = path.join(projectRoot, ...relativePath.split("/"));
  const before = await stat(absolutePath);
  const [metadata, statsValue, fileSha256] = await Promise.all([
    sharp(absolutePath, { failOn: "error" }).metadata(),
    sharp(absolutePath, { failOn: "error" }).stats(),
    sha256File(absolutePath),
  ]);
  const after = await stat(absolutePath);
  if (!before.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`图片检查期间发生变化：${absolutePath}`);
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const aspectRatio = height ? width / height : 0;
  const maximumChannelDeviation = Math.max(0, ...statsValue.channels.slice(0, 3).map((channel) => channel.stdev));
  if (metadata.format !== "png"
    || width < 768
    || height < 1_365
    || Math.abs(aspectRatio - 9 / 16) > 0.002
    || before.size < 100_000
    || statsValue.entropy < 1
    || maximumChannelDeviation < 5
    || statsValue.channels.slice(0, 3).every((channel) => channel.max - channel.min < 16)) {
    throw new Error(`图片不是可解码的真实 9:16 非纯色 PNG：${JSON.stringify({ relativePath, width, height, bytes: before.size, entropy: statsValue.entropy, maximumChannelDeviation })}`);
  }
  return {
    path: absolutePath,
    relativePath,
    bytes: before.size,
    sha256: fileSha256,
    width,
    height,
    aspectRatio,
    entropy: statsValue.entropy,
    maximumChannelDeviation,
  };
}

async function validateImagePairs(projectRoot: string): Promise<{
  pairs: ImagePairEvidence[];
  inventory: InventorySnapshot;
  pairIdentitySha256: string;
}> {
  const relativePaths = await listRegularFiles(projectRoot, RAW_LABELED_PATTERNS, RAW_LABELED_IGNORES);
  const raws = relativePaths.filter((entry) => entry.endsWith("_raw.png"));
  const labeled = relativePaths.filter((entry) => entry.endsWith("_labeled.png"));
  if (raws.length !== 26 || labeled.length !== 26) throw new Error(`raw/labeled 必须为 26+26，实际 ${raws.length}+${labeled.length}`);
  const rawByKey = new Map(raws.map((entry) => [entry.slice(0, -"_raw.png".length), entry]));
  const labeledByKey = new Map(labeled.map((entry) => [entry.slice(0, -"_labeled.png".length), entry]));
  const keys = [...new Set([...rawByKey.keys(), ...labeledByKey.keys()])].sort((left, right) => left.localeCompare(right, "en"));
  if (keys.length !== 26 || keys.some((key) => !rawByKey.has(key) || !labeledByKey.has(key))) {
    throw new Error("raw/labeled 未形成精确的 26 对。 ");
  }
  const pairs = await mapLimit(keys, 2, async (key): Promise<ImagePairEvidence> => {
    const [raw, labeledImage] = await Promise.all([
      imageEvidence(projectRoot, rawByKey.get(key)!),
      imageEvidence(projectRoot, labeledByKey.get(key)!),
    ]);
    if (raw.width !== labeledImage.width || raw.height !== labeledImage.height || raw.sha256 === labeledImage.sha256) {
      throw new Error(`raw/labeled 尺寸不一致或文件完全相同：${key}`);
    }
    return { key, raw, labeled: labeledImage };
  });
  const allSha = pairs.flatMap((pair) => [pair.raw.sha256, pair.labeled.sha256]);
  if (new Set(allSha).size !== 52) throw new Error("52 张正式图片中存在重复 SHA，拒绝当作独立成片。 ");
  return {
    pairs,
    inventory: await inventorySnapshot(projectRoot, { patterns: RAW_LABELED_PATTERNS, ignore: RAW_LABELED_IGNORES }),
    pairIdentitySha256: digest(pairs),
  };
}

function countByStatus(jobs: GenerationJob[]): Record<string, number> {
  return Object.fromEntries([...new Set(jobs.map((job) => job.status))]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((status) => [status, jobs.filter((job) => job.status === status).length]));
}

async function validateProductionLedger(projectRoot: string, images: ImagePairEvidence[]): Promise<{
  jobsFile: FileEvidence;
  publicationsFile: FileEvidence;
  reviewsFile: FileEvidence;
  counts: Record<string, unknown>;
  ep01Unit008: Record<string, unknown>;
  publicationClosure: Record<string, unknown>;
  ledgerIdentitySha256: string;
  jobs: GenerationJob[];
  reviews: ReviewStore;
}> {
  const sidecar = getSidecarPaths(projectRoot);
  const [jobsSnapshot, publicationsSnapshot, reviewsSnapshot] = await Promise.all([
    readJsonEvidence<GenerationJob[]>(sidecar.generationJobs),
    readJsonEvidence<PublicationStore>(sidecar.publications),
    readJsonEvidence<ReviewStore>(sidecar.reviews),
  ]);
  const jobs = jobsSnapshot.value;
  const publications = publicationsSnapshot.value;
  const reviews = reviewsSnapshot.value;
  const byStatus = countByStatus(jobs);
  if (jobs.length !== 30 || byStatus.succeeded !== 26 || byStatus.failed !== 3 || byStatus.generation_unknown !== 1
    || publications.intents.length !== 31 || publications.receipts.length !== 26 || reviews.records.length !== 20) {
    throw new Error(`正式 Job/Publication/Review 计数漂移：${JSON.stringify({ jobs: jobs.length, byStatus, intents: publications.intents.length, receipts: publications.receipts.length, reviews: reviews.records.length })}`);
  }
  const imagePaths = new Set(images.flatMap((pair) => [path.resolve(pair.raw.path), path.resolve(pair.labeled.path)]));
  const imageByPath = new Map(images.flatMap((pair) => [pair.raw, pair.labeled]).map((entry) => [path.resolve(entry.path), entry]));
  const intentsById = new Map(publications.intents.map((intent) => [intent.id, intent]));
  const receiptsById = new Map(publications.receipts.map((receipt) => [receipt.id, receipt]));
  if (intentsById.size !== publications.intents.length || receiptsById.size !== publications.receipts.length) {
    throw new Error("Publication intent 或 receipt ID 重复。 ");
  }
  const succeeded = jobs.filter((job) => job.status === "succeeded");
  const succeededPaths = succeeded.flatMap((job) => [job.resultPath, job.companionPath]).filter((value): value is string => Boolean(value)).map((value) => path.resolve(value));
  if (succeededPaths.length !== 52
    || new Set(succeededPaths).size !== 52
    || succeededPaths.some((entry) => !imagePaths.has(entry))
    || [...imagePaths].some((entry) => !succeededPaths.includes(entry))) {
    throw new Error("26 个 succeeded Job 与 26 对 raw/labeled 不是精确集合相等。 ");
  }
  const usedRegisteredIntentIds = new Set<string>();
  const usedReceiptIds = new Set<string>();
  const publicationClosureLines: string[] = [];
  for (const job of succeeded) {
    const raw = job.resultPath ? imageByPath.get(path.resolve(job.resultPath)) : undefined;
    const labeledImage = job.companionPath ? imageByPath.get(path.resolve(job.companionPath)) : undefined;
    const intent = job.publicationIntentId ? intentsById.get(job.publicationIntentId) : undefined;
    const receipt = job.publicationReceiptId ? receiptsById.get(job.publicationReceiptId) : undefined;
    if (!raw
      || !labeledImage
      || !job.publicationIntentId
      || !job.publicationReceiptId
      || job.companionPublicationIntentId
      || job.companionPublicationReceiptId
      || job.expectedOutputPath !== job.resultPath
      || job.expectedCompanionPath !== job.companionPath
      || job.resultSha256 !== raw.sha256
      || !intent
      || intent.status !== "registered"
      || intent.receiptId !== receipt?.id
      || path.resolve(intent.targetPath) !== path.resolve(raw.path)
      || path.resolve(intent.requestedPath) !== path.resolve(raw.path)
      || path.resolve(intent.allowedRoot) !== path.resolve(projectRoot)
      || intent.kind !== "raw-image"
      || intent.context.purpose !== "generation-output"
      || intent.context.jobId !== job.id
      || intent.context.itemId !== job.itemId
      || !receipt
      || receipt.intentId !== intent.id
      || path.resolve(receipt.targetPath) !== path.resolve(raw.path)
      || receipt.kind !== "raw-image"
      || receipt.context.purpose !== "generation-output"
      || receipt.context.jobId !== job.id
      || receipt.context.itemId !== job.itemId
      || receipt.check.ok !== true
      || receipt.check.exists !== true
      || receipt.check.decodable !== true
      || receipt.check.sha256 !== raw.sha256
      || receipt.check.size !== raw.bytes
      || receipt.check.width !== raw.width
      || receipt.check.height !== raw.height) {
      throw new Error(`succeeded Job 的 Publication raw 回执闭包不完整，或虚构了 companion 回执：${job.id}`);
    }
    usedRegisteredIntentIds.add(intent.id);
    usedReceiptIds.add(receipt.id);
    publicationClosureLines.push([
      job.id,
      job.itemId,
      intent.id,
      receipt.id,
      raw.path,
      raw.sha256,
      String(raw.bytes),
      `${raw.width}x${raw.height}`,
      labeledImage.path,
      labeledImage.sha256,
    ].join("\0"));
  }
  const registeredIntentIds = publications.intents.filter((intent) => intent.status === "registered").map((intent) => intent.id).sort();
  const receiptIds = publications.receipts.map((receipt) => receipt.id).sort();
  if (usedRegisteredIntentIds.size !== 26
    || usedReceiptIds.size !== 26
    || JSON.stringify([...usedRegisteredIntentIds].sort()) !== JSON.stringify(registeredIntentIds)
    || JSON.stringify([...usedReceiptIds].sort()) !== JSON.stringify(receiptIds)) {
    throw new Error("26 个 registered intent / receipt 没有被 26 个 succeeded Job 精确且仅一次使用。 ");
  }
  const unknown = jobs.find((job) => job.id === UNKNOWN_JOB_ID);
  if (!unknown
    || unknown.status !== "generation_unknown"
    || unknown.itemId !== EP01_008
    || unknown.fusionStoryboardPanel?.panelIndex !== 5
    || unknown.resultPath
    || unknown.companionPath
    || unknown.publicationReceiptId
    || unknown.companionPublicationReceiptId
    || await exists(unknown.expectedOutputPath)
    || Boolean(unknown.expectedCompanionPath && await exists(unknown.expectedCompanionPath))) {
    throw new Error("EP01_008 宫格05 不再是无正式输出的 generation_unknown。 ");
  }
  const ep008Jobs = jobs.filter((job) => job.itemId === EP01_008);
  const succeededPanels = [...new Set(ep008Jobs.filter((job) => job.status === "succeeded").map((job) => job.fusionStoryboardPanel?.panelIndex))].sort();
  const panelSixJobs = ep008Jobs.filter((job) => job.fusionStoryboardPanel?.panelIndex === 6);
  if (JSON.stringify(succeededPanels) !== JSON.stringify([1, 2, 3, 4]) || panelSixJobs.length !== 0) {
    throw new Error(`EP01_008 不再是 4/6（宫格05 unknown + 宫格06 missing）：${JSON.stringify({ succeededPanels, panelSixJobs: panelSixJobs.length })}`);
  }
  const failedJobs = jobs.filter((job) => job.status === "failed");
  const failedIntentIds = new Set<string>();
  for (const job of failedJobs) {
    const intent = job.publicationIntentId ? intentsById.get(job.publicationIntentId) : undefined;
    if (!intent
      || intent.status !== "failed"
      || intent.receiptId
      || intent.context.jobId !== job.id
      || intent.context.itemId !== job.itemId
      || job.publicationReceiptId
      || job.companionPublicationReceiptId) {
      throw new Error(`failed Job 没有唯一且无回执的 failed PublicationIntent：${job.id}`);
    }
    failedIntentIds.add(intent.id);
  }
  const storedFailedIntentIds = publications.intents.filter((intent) => intent.status === "failed").map((intent) => intent.id).sort();
  if (failedIntentIds.size !== 3 || JSON.stringify([...failedIntentIds].sort()) !== JSON.stringify(storedFailedIntentIds)) {
    throw new Error("3 个 failed PublicationIntent 没有被 3 个 failed Job 精确解释。 ");
  }
  const reservedIntents = publications.intents.filter((intent) => intent.status === "reserved").sort((left, right) => (left.bundleMember ?? "").localeCompare(right.bundleMember ?? "", "en"));
  const expectedUnknownMembers = [
    { id: unknown.publicationIntentId, member: "primary", kind: "raw-image", targetPath: unknown.expectedOutputPath },
    { id: unknown.companionPublicationIntentId, member: "companion", kind: "labeled-image", targetPath: unknown.expectedCompanionPath },
  ] as const;
  if (!unknown.publicationBundleId
    || reservedIntents.length !== 2
    || expectedUnknownMembers.some((expected) => {
      const intent = expected.id ? intentsById.get(expected.id) : undefined;
      return !intent
        || intent.status !== "reserved"
        || intent.receiptId
        || intent.bundleId !== unknown.publicationBundleId
        || intent.bundleMember !== expected.member
        || intent.kind !== expected.kind
        || !expected.targetPath
        || path.resolve(intent.targetPath) !== path.resolve(expected.targetPath)
        || intent.context.jobId !== unknown.id
        || intent.context.itemId !== unknown.itemId;
    })
    || reservedIntents.some((intent) => intent.context.jobId !== unknown.id)) {
    throw new Error("generation_unknown Job 的 primary/companion 两个 reserved intent bundle 已漂移。 ");
  }
  return {
    jobsFile: jobsSnapshot.file,
    publicationsFile: publicationsSnapshot.file,
    reviewsFile: reviewsSnapshot.file,
    counts: {
      generationJobs: jobs.length,
      generationByStatus: byStatus,
      publicationIntents: publications.intents.length,
      publicationReceipts: publications.receipts.length,
      reviews: reviews.records.length,
      rawLabeledPairs: images.length,
    },
    ep01Unit008: {
      expectedPanels: 6,
      succeededPanels,
      succeeded: 4,
      unknownPanel: 5,
      unknownJobId: unknown.id,
      missingPanel: 6,
      missingPanelJobs: panelSixJobs.length,
    },
    publicationClosure: {
      registeredRawIntents: usedRegisteredIntentIds.size,
      registeredRawReceipts: usedReceiptIds.size,
      companionReceipts: 0,
      failedIntents: failedIntentIds.size,
      unknownReservedBundleIntents: reservedIntents.length,
      receiptIdentitySha256: sha256(publicationClosureLines.sort().join("\n")),
      note: "历史 26 个成功任务各有 1 个 raw Publication 回执；labeled 为本地伴生文件，未伪造成额外回执。",
    },
    ledgerIdentitySha256: digest({ jobs, publications, reviews }),
    jobs,
    reviews,
  };
}

async function validateReviewBoundary(projectRoot: string, reviews: ReviewStore): Promise<{
  ep01Unit001: Record<string, unknown>;
  ep01Unit008: Record<string, unknown>;
}> {
  const sidecar = getSidecarPaths(projectRoot);
  const [index, snapshot] = await Promise.all([
    readJson<ProjectIndex | null>(sidecar.index, null),
    loadFusionStoryboardEvidenceSnapshot(projectRoot),
  ]);
  if (!index) throw new Error("正式工程缺少 index.json。 ");
  const requirementFor = (itemId: string) => {
    const item = index.items.find((entry) => entry.id === itemId);
    if (!item) throw new Error(`正式索引缺少 ${itemId}`);
    const artifacts = item.artifactIds.map((id) => index.artifacts.find((entry) => entry.id === id)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    return { item, artifacts, requirement: buildFusionStoryboardReviewRequirement(item, artifacts, snapshot) };
  };
  const unit001 = requirementFor(EP01_001);
  const req001 = unit001.requirement;
  const ruleCount = req001?.panels.reduce((sum, panel) => sum + (panel.visualReviewRules?.length ?? 0), 0) ?? 0;
  if (!req001
    || !req001.complete
    || req001.panelCount !== 4
    || req001.panels.length !== 4
    || req001.artifactIds.length !== 8
    || ruleCount !== 28
    || req001.panels.some((panel) => panel.panelVisualConstraintEvidenceVersion !== 1 || !panel.panelVisualReviewRulesFingerprint)) {
    throw new Error(`EP01_001 当前 P3 requirement 不是完整 4 格/28 规则：${JSON.stringify({ complete: req001?.complete, panelCount: req001?.panelCount, rules: ruleCount, issues: req001?.issues })}`);
  }
  const oldPassReviews = reviews.records.filter((record) => record.itemId === EP01_001 && record.reviewType === "image" && record.decision === "pass");
  const stillValid = oldPassReviews.filter((record) => reviewCoversFusionStoryboardRequirement(record, req001, unit001.artifacts));
  if (!oldPassReviews.length
    || oldPassReviews.some((record) => (record.visualConstraintAttestations?.length ?? 0) !== 0)
    || stillValid.length !== 0) {
    throw new Error("EP01_001 旧 Review 没有因缺少 P3 逐规则人工确认而失效。 ");
  }
  const unit008 = requirementFor(EP01_008);
  if (!unit008.item.fusionStoryboard
    || unit008.item.fusionStoryboard.panelCount !== 6
    || unit008.item.fusionStoryboard.panels.filter((panel) => panel.rawArtifactId && panel.labeledArtifactId).length !== 4
    || unit008.item.fusionStoryboard.panels[4]?.generationJobId !== UNKNOWN_JOB_ID
    || unit008.item.fusionStoryboard.panels[5]?.generationJobId
    || unit008.requirement?.complete !== false) {
    throw new Error("EP01_008 索引/requirement 不再保持 4/6 unknown+missing。 ");
  }
  return {
    ep01Unit001: {
      requirementId: req001.id,
      complete: true,
      panels: req001.panelCount,
      artifacts: req001.artifactIds.length,
      visualRules: ruleCount,
      oldPassReviewIds: oldPassReviews.map((record) => record.id),
      oldReviewsCarryP3Attestations: false,
      validOldReviewsUnderP3: stillValid.length,
    },
    ep01Unit008: {
      panels: 6,
      completeRawLabeledPairs: 4,
      unknownPanel: 5,
      missingPanel: 6,
      requirementComplete: false,
      issues: unit008.requirement?.issues,
    },
  };
}

async function validateProvider(projectRoot: string): Promise<{
  revision: number;
  concurrency: number;
  providers: Array<{ id: string; instructionSha256: string }>;
  genericInstructionSha256: string;
}> {
  const settings = await getGenerationSettings(projectRoot);
  const providers = settings.providers.filter((provider) => provider.adapter === "codex-subagent-imagegen");
  if (!providers.length || settings.concurrency !== 1 || providers.some((provider) => provider.subagentInstructions !== FUSION_SUBAGENT_GENERIC_INSTRUCTIONS)) {
    throw new Error("子代理 provider 未全部冻结为 Core 通用安全说明，或并发不为 1。 ");
  }
  return {
    revision: settings.revision,
    concurrency: settings.concurrency,
    providers: providers.map((provider) => ({ id: provider.id, instructionSha256: sha256(provider.subagentInstructions ?? "") })),
    genericInstructionSha256: sha256(FUSION_SUBAGENT_GENERIC_INSTRUCTIONS),
  };
}

async function loadExternalEvidence(filePath: string, expectedKind: string): Promise<{ file: FileEvidence; value: Record<string, any> }> {
  const evidence = await readJsonEvidence<Record<string, any>>(filePath);
  if (evidence.value.kind !== expectedKind) throw new Error(`外部证据 kind 错误：${filePath}`);
  return evidence;
}

async function validateBackup(migration: Record<string, any>, projectRoot: string): Promise<{
  root: string;
  manifest: FileEvidence;
  entries: number;
  blobsChecked: number;
}> {
  const backup = migration.backup;
  const sidecar = getSidecarPaths(projectRoot);
  const root = path.resolve(backup?.root ?? "");
  const familyRoot = path.join(sidecar.root, "backups", "p3-visual-constraints");
  if (!isInside(familyRoot, root) || root === path.resolve(familyRoot) || backup?.address !== path.basename(root)) {
    throw new Error("P3 内容寻址备份目录或 address 非法。 ");
  }
  const manifestPath = path.join(root, "manifest.json");
  const manifestEvidence = await fileEvidence(manifestPath);
  const manifest = await readJson<Record<string, any> | null>(manifestPath, null);
  const entries = Array.isArray(backup?.entries) ? backup.entries as Array<Record<string, any>> : [];
  if (!manifest
    || manifest.kind !== "p3-visual-constraints-content-addressed-backup"
    || manifest.address !== backup.address
    || path.resolve(manifest.projectRoot ?? "") !== path.resolve(projectRoot)
    || backup.manifestSha256 !== manifestEvidence.sha256
    || JSON.stringify(manifest.entries) !== JSON.stringify(entries)) {
    throw new Error("P3 内容寻址备份 manifest 与迁移证据不一致。 ");
  }
  let blobsChecked = 0;
  for (const entry of entries) {
    if (!entry.existed) continue;
    const blob = await fileEvidence(path.join(root, "blobs", "sha256", String(entry.sha256)));
    if (blob.bytes !== entry.bytes || blob.sha256 !== entry.sha256) throw new Error(`P3 备份 blob 漂移：${entry.relativePath}`);
    blobsChecked += 1;
  }
  return { root, manifest: manifestEvidence, entries: entries.length, blobsChecked };
}

async function validateExternalEvidence(
  input: CliOptions,
  store: FusionPanelVisualConstraintStore,
  provider: Awaited<ReturnType<typeof validateProvider>>,
  guarded: GuardedState,
  ledger: Awaited<ReturnType<typeof validateProductionLedger>>,
  images: Awaited<ReturnType<typeof validateImagePairs>>,
): Promise<Record<string, unknown>> {
  const [rehearsal, migration, mcp, ui] = await Promise.all([
    loadExternalEvidence(input.migrationRehearsalPath, "p3-visual-constraints-migration-dry-run"),
    loadExternalEvidence(input.migrationEvidencePath, "p3-visual-constraints-migration"),
    loadExternalEvidence(input.mcpEvidencePath, "p3-visual-constraints-mcp-smoke"),
    loadExternalEvidence(input.uiEvidencePath, "p3-visual-constraints-ui-smoke"),
  ]);
  const sourceExpected = EXPECTED_SOURCE;
  if (rehearsal.value.apply !== false
    || rehearsal.value.plan?.productionFreeze !== true
    || rehearsal.value.source?.files !== sourceExpected.files
    || rehearsal.value.source?.bytes !== sourceExpected.bytes
    || rehearsal.value.source?.aggregateSha256 !== sourceExpected.aggregateSha256
    || rehearsal.value.protected?.counts?.generationJobs !== 30
    || rehearsal.value.protected?.counts?.publicationIntents !== 31
    || rehearsal.value.protected?.counts?.publicationReceipts !== 26
    || rehearsal.value.protected?.counts?.reviews !== 20
    || rehearsal.value.protected?.rawLabeled?.files !== 52
    || rehearsal.value.protected?.historicalRequests?.files !== 31) {
    throw new Error("P3 migration rehearsal 没有冻结正式迁移前的只读基线。 ");
  }
  if (migration.value.apply !== true
    || migration.value.productionFreeze !== true
    || migration.value.source?.unchanged !== true
    || migration.value.protected?.unchanged !== true
    || migration.value.protected?.reviewAttestationsFabricated !== false
    || migration.value.protected?.generationJobsSha256 !== ledger.jobsFile.sha256
    || migration.value.protected?.publicationsSha256 !== ledger.publicationsFile.sha256
    || migration.value.protected?.reviewsSha256 !== ledger.reviewsFile.sha256
    || migration.value.protected?.p2StoreSha256 !== guarded.files.p2PanelReferences.sha256
    || JSON.stringify(migration.value.protected?.rawLabeled) !== JSON.stringify(images.inventory)
    || JSON.stringify(migration.value.protected?.historicalRequests) !== JSON.stringify(guarded.historicalRequests)
    || migration.value.protected?.immutableSidecarSha256 !== guarded.immutableSidecar.aggregateSha256
    || migration.value.providerMigration?.allSubagentProvidersGeneric !== true
    || migration.value.providerMigration?.instructionSha256 !== provider.genericInstructionSha256
    || migration.value.p3?.after?.current !== true
    || migration.value.p3?.after?.revision !== store.revision
    || migration.value.p3?.after?.storeFingerprint !== store.storeFingerprint
    || migration.value.p3?.after?.auditFingerprint !== store.audit.auditFingerprint
    || migration.value.p3?.strictSecondPass?.revisionUnchanged !== true
    || migration.value.p3?.strictSecondPass?.storeFingerprintUnchanged !== true
    || migration.value.p3?.strictSecondPass?.auditFingerprintUnchanged !== true
    || migration.value.p3?.strictSecondPass?.allowedFilesSha256Unchanged !== true) {
    throw new Error("P3 formal migration 证据与当前正式账、provider 或 P3 store 不一致。 ");
  }
  assertAudit(migration.value.p3.audit as PanelVisualConstraintAudit);
  const backup = await validateBackup(migration.value, input.projectRoot);
  if (mcp.value.passed !== true
    || mcp.value.vendorOrGenerationInvoked !== false
    || mcp.value.toolCount !== EXPECTED_TOOLS
    || mcp.value.store?.revision !== store.revision
    || mcp.value.store?.fingerprint !== store.storeFingerprint
    || mcp.value.store?.current !== true
    || mcp.value.audit?.auditFingerprint !== store.audit.auditFingerprint
    || mcp.value.sample?.localPathOrHiddenIdentityLeak !== false
    || mcp.value.guardedFiles?.unchanged !== true
    || JSON.stringify(mcp.value.guardedFiles?.before) !== JSON.stringify(mcp.value.guardedFiles?.after)) {
    throw new Error("P3 MCP 外部证据没有证明 release manifest 工具清单、当前 store、零泄漏和只读。 ");
  }
  for (const [name, current] of Object.entries({
    visualConstraints: guarded.files.p3VisualConstraints,
    panelReferences: guarded.files.p2PanelReferences,
    generationSettings: guarded.files.generationSettings,
    generationJobs: guarded.files.generationJobs,
    publications: guarded.files.publications,
    reviews: guarded.files.reviews,
    gridSelections: guarded.files.gridSelections,
    projectIndex: guarded.files.projectIndex,
    events: guarded.files.events,
    commandLedger: guarded.files.commandLedger,
  })) {
    const frozen = mcp.value.guardedFiles?.after?.[name];
    if (!frozen || frozen.sha256 !== current.sha256 || frozen.bytes !== current.bytes || path.resolve(frozen.path) !== path.resolve(current.path)) {
      throw new Error(`P3 MCP 外部证据的 guarded ${name} 已与正式工程漂移。`);
    }
  }
  if (ui.value.passed !== true
    || ui.value.vendorOrGenerationInvoked !== false
    || path.resolve(ui.value.projectRoot ?? "") !== path.resolve(input.projectRoot)
    || path.resolve(ui.value.screenshotPath ?? "") !== path.resolve(input.uiScreenshotPath)
    || ui.value.referenceEvidence?.currentness?.current !== true
    || ui.value.referenceEvidence?.currentness?.storeFingerprint !== store.storeFingerprint
    || ui.value.reviewEvidence?.itemId !== EP01_001
    || ui.value.reviewEvidence?.panelCount !== 4
    || ui.value.reviewEvidence?.expectedRules !== 28
    || ui.value.reviewEvidence?.ruleButtonsClicked !== 28
    || ui.value.reviewEvidence?.passInitiallyDisabled !== true
    || ui.value.reviewEvidence?.passEnabledAfterExplicitHumanChecks !== true
    || ui.value.reviewEvidence?.submitClicked !== false
    || ui.value.guardedFiles?.unchanged !== true
    || JSON.stringify(ui.value.guardedFiles?.before) !== JSON.stringify(ui.value.guardedFiles?.after)) {
    throw new Error("P3 UI 证据没有证明当前详情、4 格/28 规则、失败关闭和未提交。 ");
  }
  const uiGuardMap: Record<string, FileEvidence> = {
    visualConstraints: guarded.files.p3VisualConstraints,
    panelReferences: guarded.files.p2PanelReferences,
    jobs: guarded.files.generationJobs,
    publications: guarded.files.publications,
    reviews: guarded.files.reviews,
  };
  for (const [name, current] of Object.entries(uiGuardMap)) {
    if (ui.value.guardedFiles?.after?.[name] !== current.sha256) throw new Error(`P3 UI guarded ${name} 已漂移。`);
  }
  const screenshotMetadata = await sharp(input.uiScreenshotPath, { failOn: "error" }).metadata();
  const screenshot = await fileEvidence(input.uiScreenshotPath);
  if (screenshotMetadata.format !== "png"
    || !screenshotMetadata.width
    || !screenshotMetadata.height
    || screenshotMetadata.width < 900
    || screenshotMetadata.height < 600
    || screenshot.bytes < 100_000) {
    throw new Error("P3 UI 截图不可解码、尺寸或体积不足。 ");
  }
  return {
    rehearsal: rehearsal.file,
    migration: migration.file,
    backup,
    mcp: mcp.file,
    ui: ui.file,
    screenshot: { ...screenshot, dimensions: [screenshotMetadata.width, screenshotMetadata.height] },
  };
}

async function parseLoggedJson(file: FileEvidence): Promise<Record<string, any>> {
  const content = await readFile(file.path, "utf8");
  try {
    return JSON.parse(content) as Record<string, any>;
  } catch {
    throw new Error(`命令 stdout 不是单一 JSON：${file.path}`);
  }
}

async function validateReadOnlyRunOutputs(runs: Record<string, RunEvidence>, store: FusionPanelVisualConstraintStore): Promise<Record<string, unknown>> {
  const first = await parseLoggedJson(runs.migrationReadOnlyFirst!.stdout);
  const second = await parseLoggedJson(runs.migrationReadOnlySecond!.stdout);
  for (const [label, value] of [["first", first], ["second", second]] as const) {
    if (value.kind !== "p3-visual-constraints-migration-dry-run"
      || value.apply !== false
      || value.plan?.productionFreeze !== true
      || value.plan?.needsP3Materialization !== false
      || value.plan?.providerIdsToUpdate?.length !== 0
      || value.plan?.p3Before?.current !== true
      || value.plan?.p3Before?.revision !== store.revision
      || value.plan?.p3Before?.storeFingerprint !== store.storeFingerprint
      || value.plan?.p3Before?.auditFingerprint !== store.audit.auditFingerprint) {
      throw new Error(`第 ${label} 次 P3 只读迁移预检不是已满足状态：${JSON.stringify(value.plan)}`);
    }
  }
  const normalized = (value: Record<string, any>) => ({
    apply: value.apply,
    source: value.source,
    protected: value.protected,
    plan: value.plan,
    next: value.next,
  });
  if (JSON.stringify(normalized(first)) !== JSON.stringify(normalized(second))) {
    throw new Error("两次 P3 只读迁移预检的正式输入或幂等计划不一致。 ");
  }
  const mcp = await parseLoggedJson(runs.mcpReadOnly!.stdout);
  if (mcp.passed !== true
    || mcp.toolCount !== EXPECTED_TOOLS
    || mcp.storeRevision !== store.revision
    || mcp.storeFingerprint !== store.storeFingerprint
    || mcp.auditFingerprint !== store.audit.auditFingerprint
    || mcp.guardedFilesUnchanged !== true) {
    throw new Error(`当前编译 MCP 只读烟测摘要异常：${JSON.stringify(mcp)}`);
  }
  return {
    migrationReadOnly: {
      firstCreatedAt: first.createdAt,
      secondCreatedAt: second.createdAt,
      exactSemanticReplay: true,
      productionFreeze: true,
      needsP3Materialization: false,
      providerIdsToUpdate: [],
    },
    compiledMcp: mcp,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const input = parseOptions(argv);
  await assertSafePaths(input);
  const startedAt = new Date().toISOString();
  const [sourceBefore, codeBefore] = await Promise.all([
    sourceSnapshot(input.sourceRoot),
    workspaceSourceDigest(input.workspace),
  ]);
  if (sourceBefore.files !== EXPECTED_SOURCE.files
    || sourceBefore.bytes !== EXPECTED_SOURCE.bytes
    || sourceBefore.aggregateSha256 !== EXPECTED_SOURCE.aggregateSha256) {
    throw new Error(`第三季只读源偏离正式基线：${JSON.stringify(sourceBefore)}`);
  }
  const [store, p3CurrentBefore, p2Snapshot, p2CurrentStrictBefore, provider, guardedBefore, images] = await Promise.all([
    loadFusionPanelVisualConstraintStore(input.projectRoot),
    inspectFusionPanelVisualConstraintCurrentness(input.projectRoot),
    loadFusionPanelReferenceStoreSnapshot(input.projectRoot),
    inspectFusionPanelReferenceCurrentness(input.projectRoot, { verifyAllContractFiles: true }),
    validateProvider(input.projectRoot),
    guardedState(input.projectRoot),
    validateImagePairs(input.projectRoot),
  ]);
  if (!store) throw new Error("正式工程尚无 P3 PanelVisualConstraint store。 ");
  assertAudit(store.audit);
  if (!p3CurrentBefore.current
    || p3CurrentBefore.storeRevision !== store.revision
    || p3CurrentBefore.storeFingerprint !== store.storeFingerprint
    || p3CurrentBefore.driftedInputs.length) {
    throw new Error(`P3 store 关账前不是 current：${JSON.stringify(p3CurrentBefore)}`);
  }
  if (!p2Snapshot
    || !p2Snapshot.currentness.current
    || !p2CurrentStrictBefore.current
    || p2Snapshot.currentness.storeRevision !== p2Snapshot.store.revision
    || p2Snapshot.currentness.storeFingerprint !== p2Snapshot.store.storeFingerprint
    || p2Snapshot.currentness.driftedInputs.length
    || p2CurrentStrictBefore.storeRevision !== p2Snapshot.store.revision
    || p2CurrentStrictBefore.storeFingerprint !== p2Snapshot.store.storeFingerprint
    || p2CurrentStrictBefore.driftedInputs.length
    || !p2Snapshot.store.audit.closurePassed
    || p2Snapshot.store.audit.currentContracts !== 1_288
    || p2Snapshot.store.audit.panels !== 4_330) {
    throw new Error(`P2 store 关账前不是 current 闭包：${JSON.stringify(p2Snapshot?.currentness)}`);
  }
  const constraintValidation = validateConstraints(store);
  if (constraintValidation.legacyGenerationJobEvidence !== 11) throw new Error("P3 必须冻结 11 个 P2 legacy Job 身份。 ");
  if (images.inventory.files !== 52 || images.inventory.bytes !== 128_973_009 || images.inventory.aggregateSha256 !== "77d4a46fa04c05c635701363f394faab0cc5094fc437990f6eeb580ce0e4c83b") {
    throw new Error(`正式 26 对 raw/labeled 清单漂移：${JSON.stringify(images.inventory)}`);
  }
  const ledger = await validateProductionLedger(input.projectRoot, images.pairs);
  const reviewBoundary = await validateReviewBoundary(input.projectRoot, ledger.reviews);
  const externalEvidence = await validateExternalEvidence(input, store, provider, guardedBefore, ledger, images);

  const commandRuns = await runCloseoutCommands(input);
  const liveRunEvidence = await validateReadOnlyRunOutputs(commandRuns, store);

  const [sourceAfter, codeAfter, guardedAfter, p3CurrentAfter, p2CurrentAfter, storeAfter, compiledMcpServerAfter] = await Promise.all([
    sourceSnapshot(input.sourceRoot),
    workspaceSourceDigest(input.workspace),
    guardedState(input.projectRoot),
    inspectFusionPanelVisualConstraintCurrentness(input.projectRoot),
    inspectFusionPanelReferenceCurrentness(input.projectRoot, { verifyAllContractFiles: true }),
    loadFusionPanelVisualConstraintStore(input.projectRoot),
    fileEvidence(path.join(input.workspace, "dist-mcp", "mcp", "server.js")),
  ]);
  const externalFilesBefore = {
    rehearsal: externalEvidence.rehearsal as FileEvidence,
    migration: externalEvidence.migration as FileEvidence,
    mcp: externalEvidence.mcp as FileEvidence,
    ui: externalEvidence.ui as FileEvidence,
    screenshot: Object.fromEntries(Object.entries(externalEvidence.screenshot as Record<string, unknown>)
      .filter(([key]) => ["path", "bytes", "sha256"].includes(key))) as unknown as FileEvidence,
    backupManifest: (externalEvidence.backup as { manifest: FileEvidence }).manifest,
  };
  const externalFilesAfter = {
    rehearsal: await fileEvidence(input.migrationRehearsalPath),
    migration: await fileEvidence(input.migrationEvidencePath),
    mcp: await fileEvidence(input.mcpEvidencePath),
    ui: await fileEvidence(input.uiEvidencePath),
    screenshot: await fileEvidence(input.uiScreenshotPath),
    backupManifest: await fileEvidence((externalEvidence.backup as { manifest: FileEvidence }).manifest.path),
  };
  if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) throw new Error("关账期间第三季只读源发生变化。 ");
  if (JSON.stringify(codeAfter) !== JSON.stringify(codeBefore)) throw new Error("关账期间 src/tests/scripts/package/config 源码集合发生变化。 ");
  if (JSON.stringify(externalFilesAfter) !== JSON.stringify(externalFilesBefore)) throw new Error("关账期间 migration/MCP/UI/截图/备份 manifest 外部证据发生变化。 ");
  if (guardedAfter.identitySha256 !== guardedBefore.identitySha256 || JSON.stringify(guardedAfter) !== JSON.stringify(guardedBefore)) {
    throw new Error("关账命令改写了正式 sidecar、历史 request、下载/暂存或 raw/labeled。 ");
  }
  if (!storeAfter
    || storeAfter.revision !== store.revision
    || storeAfter.storeFingerprint !== store.storeFingerprint
    || storeAfter.audit.auditFingerprint !== store.audit.auditFingerprint
    || !p3CurrentAfter.current
    || p3CurrentAfter.storeRevision !== store.revision
    || p3CurrentAfter.storeFingerprint !== store.storeFingerprint
    || p3CurrentAfter.driftedInputs.length
    || !p2CurrentAfter.current
    || p2CurrentAfter.storeRevision !== p2Snapshot.store.revision
    || p2CurrentAfter.storeFingerprint !== p2Snapshot.store.storeFingerprint
    || p2CurrentAfter.driftedInputs.length) {
    throw new Error("关账命令改写或漂移了 P2/P3 当前性。 ");
  }
  const endedAt = new Date().toISOString();
  const assertions = {
    source3344Files24570877BytesAndAggregateShaExact: true,
    sourceUnchangedDuringValidation: true,
    sourceCodeDigestStableDuringValidation: true,
    p2StoreCurrentBeforeAndAfter: true,
    p3StoreCurrentBeforeAndAfter: true,
    p3Audit1288Contracts4330PanelsExact: true,
    p3PresenceAndUnresolvedCountsExact: true,
    hiddenMaskConcealed304RevealZero: true,
    modelPromptAndLocalPathLeakPanelsZero: true,
    everyConstraintCarriesFrozenModelAndReviewFingerprints: true,
    providerUsesGenericCoreInstructionsAndConcurrencyOne: true,
    thirtyJobs31Intents26Receipts20ReviewsPreserved: true,
    twentySixRawAndLabeledPairsDecodeAsRealNineBySixteenPng: true,
    rawAndLabeledShasUniqueAndTraceableToSucceededJobs: true,
    ep01Unit001OldReviewInvalidUnderP3: true,
    ep01Unit001RequirementFourPanelsTwentyEightRules: true,
    ep01Unit008RemainsFourOfSixUnknownPlusMissing: true,
    migrationRehearsalAndFormalEvidenceMatchCurrentState: true,
    migrationContentAddressedBackupStillValid: true,
    formalMigrationStrictSecondPassWasIdempotent: true,
    twoNewMigrationPreflightsAreReadOnlyAndSemanticallyIdentical: true,
    compiledMcpDiscoversExactly178ToolsWithoutWrites: true,
    existingMcpEvidenceMatchesCurrentStoreAndGuardedFiles: true,
    realUiEvidenceAndDecodableScreenshotMatchCurrentStore: true,
    externalEvidenceFilesStableDuringCloseout: true,
    uiReviewInteractionDidNotSubmitOrFabricateHumanReview: true,
    historicalGenerationRequestsRemain31AndHashExact: true,
    guardedSidecarRawLabeledDownloadsAndStagingUnchanged: true,
    zeroFormalGenerationBrowserVendorOrPublicationEventsDuringCloseout: true,
    allSevenCommandRunsExitedZeroWithExclusiveShaBoundLogs: true,
  };
  if (Object.values(assertions).some((value) => value !== true)
    || Object.keys(commandRuns).length !== 7
    || Object.values(commandRuns).some((run) => run.exitCode !== 0 || run.termination.timedOut)) {
    throw new Error("P3 正式关账仍有未通过断言或命令。 ");
  }
  const evidence = {
    schemaVersion: 1,
    kind: "p3-visual-constraints-final-validation",
    createdAt: endedAt,
    validationWindow: { startedAt, endedAt },
    invocation: { argv: [process.execPath, ...process.argv.slice(1)], cwd: process.cwd() },
    workspace: input.workspace,
    projectRoot: input.projectRoot,
    sourceRoot: input.sourceRoot,
    runRoot: input.runRoot,
    source: { before: sourceBefore, after: sourceAfter, unchanged: true },
    sourceCode: { before: codeBefore, after: codeAfter, unchanged: true },
    p2: {
      revision: p2Snapshot.store.revision,
      storeFingerprint: p2Snapshot.store.storeFingerprint,
      auditFingerprint: p2Snapshot.store.audit.auditFingerprint,
      currentness: { snapshotBefore: p2Snapshot.currentness, strictBefore: p2CurrentStrictBefore, strictAfter: p2CurrentAfter },
    },
    p3: {
      revision: store.revision,
      storeFingerprint: store.storeFingerprint,
      audit: store.audit,
      currentness: { before: p3CurrentBefore, after: p3CurrentAfter },
      storeFile: guardedBefore.files.p3VisualConstraints,
      constraintValidation,
    },
    generationProvider: provider,
    productionLedger: {
      counts: ledger.counts,
      ledgerIdentitySha256: ledger.ledgerIdentitySha256,
      generationJobs: ledger.jobsFile,
      publications: ledger.publicationsFile,
      reviews: ledger.reviewsFile,
      publicationClosure: ledger.publicationClosure,
      ep01Unit008: ledger.ep01Unit008,
    },
    imagePairs: {
      count: images.pairs.length,
      inventory: images.inventory,
      pairIdentitySha256: images.pairIdentitySha256,
      pairs: images.pairs,
    },
    reviewBoundary,
    guardedFormalState: { before: guardedBefore, after: guardedAfter, unchanged: true },
    externalEvidence,
    externalEvidenceFiles: { before: externalFilesBefore, after: externalFilesAfter, unchanged: true },
    compiledMcpServer: {
      afterProductionBuild: compiledMcpServerAfter,
      exercisedByReadOnlyMcpRun: commandRuns.mcpReadOnly!.argv,
      toolCount: EXPECTED_TOOLS,
    },
    commandRuns,
    liveRunEvidence,
    productionFreeze: {
      enabled: true,
      eventFileUnchanged: guardedBefore.files.events.sha256 === guardedAfter.files.events.sha256,
      commandLedgerUnchanged: guardedBefore.files.commandLedger.sha256 === guardedAfter.files.commandLedger.sha256,
      generationJobsUnchanged: ledger.jobsFile.sha256 === guardedAfter.files.generationJobs.sha256,
      publicationsUnchanged: ledger.publicationsFile.sha256 === guardedAfter.files.publications.sha256,
      historicalRequestsUnchanged: JSON.stringify(guardedBefore.historicalRequests) === JSON.stringify(guardedAfter.historicalRequests),
      generationDownloadsUnchanged: JSON.stringify(guardedBefore.generationDownloads) === JSON.stringify(guardedAfter.generationDownloads),
      subagentStagingUnchanged: JSON.stringify(guardedBefore.subagentStaging) === JSON.stringify(guardedAfter.subagentStaging),
      browserOrVendorInvoked: false,
      imageGenerationInvoked: false,
    },
    assertions,
  };
  const created = await writeJsonAtomicExclusive(input.evidencePath, evidence);
  if (created !== "created") throw new Error(`最终证据未独占创建：${input.evidencePath}`);
  process.stdout.write(`${JSON.stringify({
    passed: true,
    evidencePath: input.evidencePath,
    runRoot: input.runRoot,
    sourceCode: codeAfter,
    p3: { revision: store.revision, storeFingerprint: store.storeFingerprint, auditFingerprint: store.audit.auditFingerprint },
    tests: {
      targeted: commandRuns.targeted?.testSummary,
      full: commandRuns.full?.testSummary,
    },
    imagePairs: images.pairs.length,
    assertions,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
