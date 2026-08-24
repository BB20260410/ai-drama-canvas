import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import fg from "fast-glob";
import sharp from "sharp";
import { inspectFusionPackage, type FusionPackageExpectedCounts, type FusionScheduleRow } from "../src/core/fusion-package.js";
import { materializeFusionProject } from "../src/core/fusion-production.js";
import { buildFusionReferenceBoard } from "../src/core/fusion-references.js";
import {
  buildFusionStoryboardGridForProject,
  renderCompletedFusionStoryboardSheetForProject,
} from "../src/core/fusion-storyboard-production.js";
import {
  FUSION_STORYBOARD_SHEET_RENDER_POLICY_VERSION,
  renderFusionStoryboardSheetV2,
  type FusionStoryboardSheetPanelImageInput,
  type FusionStoryboardSheetRenderResult,
} from "../src/core/fusion-storyboard-sheet.js";
import {
  getFusionStoryboardSheetState,
  inspectFusionStoryboardSheetEvidence,
  listFusionStoryboardSheets,
  type FusionStoryboardSheetState,
} from "../src/core/fusion-storyboard-sheet-evidence.js";
import { previewFusionStoryboardSheetMigration } from "../src/core/fusion-storyboard-sheet-migration.js";
import { xmlVisibleText } from "../src/core/xml-visible-text.js";
import { listFusionStoryboardSheetArtifactSnapshot, loadFusionStoryboardSheetStore } from "../src/core/fusion-storyboard-sheet-store.js";
import { buildFusionStoryboardGrid, type FusionStoryboardGridContract } from "../src/core/fusion-storyboard-grid.js";
import {
  inspectFusionPanelReferenceCurrentness,
  loadFusionPanelReferenceStoreSnapshot,
  materializeFusionPanelReferenceResolutions,
} from "../src/core/fusion-panel-references.js";
import {
  inspectFusionPanelVisualConstraintCurrentness,
  loadFusionPanelVisualConstraintStore,
  materializeFusionPanelVisualConstraints,
} from "../src/core/fusion-visual-constraint-store.js";
import { enqueueFusionStoryboardPanel } from "../src/core/generation.js";
import {
  getPublicationIntent,
  registerPublication,
  registerPublicationBundle,
  type PublicationStore,
} from "../src/core/publication.js";
import { getReviewQueue, submitReview } from "../src/core/reviews.js";
import { scanProject } from "../src/core/scanner.js";
import { scanAndPersist } from "../src/core/service.js";
import { getSidecarPaths, loadIndex, readJson, writeJsonAtomicExclusive } from "../src/core/sidecar.js";
import type {
  GenerationJob,
  ReviewCriterionKey,
  ReviewStore,
  StoryboardProductionContract,
} from "../src/core/types.js";
import { expectedRuntimeMcpToolCount } from "../src/core/release-manifest.js";

const DEFAULT_WORKSPACE = "/Users/hxx/Documents/无限画布";
const DEFAULT_PROJECT_RELATIVE = "productions/gushujuan-s3-f1a688020bfb7af6";
const DEFAULT_SOURCE_ROOT = "/Users/hxx/Documents/古蜀卷第三季";
const EXPECTED_SOURCE = {
  files: 3_344,
  bytes: 24_570_877,
  aggregateSha256: "649160f22663ca4c45ee4a4084e278ef0edc61ec66db01bb84da38cbea3f8d26",
} as const;
const EXPECTED_TOOL_COUNT = await expectedRuntimeMcpToolCount(DEFAULT_WORKSPACE);
const EP01_001 = "season-三-ep01-unit001";
const EP01_008 = "season-三-ep01-unit008";
const EP01_008_UNKNOWN_JOB = "gen-2026-07-16T12-10-57-215Z-892023c0";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RAW_LABELED_PATTERNS = ["**/*_raw.png", "**/*_labeled.png"];
const RAW_LABELED_IGNORES = [
  ".aicanvas/backups/**",
  ".aicanvas/generation-downloads/**",
  ".aicanvas/subagent-staging/**",
];
const TARGETED_TEST_FILES = [
  "tests/fusion-storyboard-sheet.test.ts",
  "tests/fusion-storyboard-sheet-store.test.ts",
  "tests/fusion-storyboard-sheet-migration.test.ts",
  "tests/fusion-production.test.ts",
  "tests/command-bus.test.ts",
  "tests/scanner.test.ts",
  "tests/mcp.test.ts",
  "tests/mcp-fusion-production.test.ts",
] as const;

interface CliOptions {
  workspace: string;
  projectRoot: string;
  sourceRoot: string;
  evidencePath: string;
  migrationEvidencePath: string;
  mcpEvidencePath: string;
  uiEvidencePath: string;
  uiScreenshotPaths: [string, string];
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
  jsonRowsSha256: string;
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
  testSummary?: {
    filesPassed: number;
    testsPassed: number;
    filesSkipped: number;
    testsSkipped: number;
  };
}

interface GuardedFormalState {
  files: {
    projectConfig: FileEvidence;
    projectIndex: FileEvidence;
    progressMarkdown: FileEvidence;
    projectOverrides: FileEvidence;
    events: FileEvidence;
    commandLedger: FileEvidence;
    generationJobs: FileEvidence;
    publications: FileEvidence;
    reviews: FileEvidence;
    p2PanelReferences: FileEvidence;
    p3VisualConstraints: FileEvidence;
    storyboardGridSelections: FileEvidence;
    storyboardSheetIndex: FileEvidence;
    storyboards: FileEvidence;
    fusionManifest: FileEvidence;
    productionAssets: FileEvidence;
    continuityTracks: FileEvidence;
    generationSettings: FileEvidence;
  };
  requests: InventorySnapshot;
  downloads: InventorySnapshot;
  subagentStaging: InventorySnapshot;
  rawLabeled: InventorySnapshot;
  sheetArtifacts: FileEvidence[];
  identitySha256: string;
}

interface ExternalEvidenceValidation {
  migration: FileEvidence;
  mcp: FileEvidence;
  ui: FileEvidence;
  screenshots: Array<FileEvidence & { width: number; height: number; standardDeviation: number }>;
  migrationCandidateFingerprint: string;
  migrationSheetIds: string[];
  mcpToolCount: number;
}

interface FormalValidation {
  store: Awaited<ReturnType<typeof loadFusionStoryboardSheetStore>>;
  state001: FusionStoryboardSheetState;
  state008: FusionStoryboardSheetState;
  scanner: Record<string, unknown>;
  ledger: Record<string, unknown>;
  sheetArtifacts: Array<FileEvidence & { sheetId: string; role: string; status: string }>;
}

interface PlanningAttestation {
  root: string;
  taskPlan: FileEvidence;
  attestation: FileEvidence;
  modeFile: FileEvidence;
  stopBlocksFile: FileEvidence;
  taskPlanSha256: string;
  attestedSha256: string;
  mode: string;
  stopBlocks: number;
}

function usage(): string {
  return `P4 正式中文分镜板证据链最终关账（正式 production 只读）

用法：
  npx tsx scripts/validate-p4-storyboard-sheet-final.ts [参数]

参数：
  --workspace <path>
  --project-root <path>
  --source-root <path>
  --migration-evidence <json>
  --mcp-evidence <json>
  --ui-evidence <json>
  --ui-screenshot <png>       可重复两次；缺省使用 P4 两张正式截图
  --evidence <json>            最终证据；必须位于 workspace/docs/evidence 且不存在
  --run-root <dir>             七项真实命令的唯一独占日志目录
  --help

默认验证正式第三季工程；只有隔离 fixture 写 /tmp。正式工程不迁移、
不渲染、不扫描落盘、不提交 Review、不启动浏览器、不调用供应商。
任一门禁失败均不写 final JSON。
`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function optionValues(argv: string[], name: string): string[] {
  return argv.flatMap((entry, index) => entry === name ? [argv[index + 1] ?? ""] : []);
}

function optionValue(argv: string[], name: string): string | undefined {
  const values = optionValues(argv, name);
  if (values.length > 1) throw new Error(`${name} 不得重复。`);
  if (!values.length) return undefined;
  if (!values[0] || values[0]!.startsWith("--")) throw new Error(`${name} 缺少路径参数。`);
  return values[0];
}

function parseOptions(argv: string[]): CliOptions {
  const valueOptions = new Set([
    "--workspace", "--project-root", "--source-root", "--migration-evidence",
    "--mcp-evidence", "--ui-evidence", "--ui-screenshot", "--evidence", "--run-root",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]!;
    if (entry === "--help" || entry === "-h") continue;
    if (!valueOptions.has(entry)) throw new Error(`未知参数：${entry}`);
    index += 1;
    if (index >= argv.length || argv[index]!.startsWith("--")) throw new Error(`${entry} 缺少路径参数。`);
  }
  const workspace = path.resolve(optionValue(argv, "--workspace") ?? DEFAULT_WORKSPACE);
  const evidenceRoot = path.join(workspace, "docs", "evidence");
  const screenshotValues = optionValues(argv, "--ui-screenshot");
  if (screenshotValues.some((value) => !value || value.startsWith("--")) || ![0, 2].includes(screenshotValues.length)) {
    throw new Error("--ui-screenshot 必须省略或恰好重复两次。");
  }
  const screenshots = screenshotValues.length === 2
    ? screenshotValues.map((value) => path.resolve(value))
    : [
        path.join(evidenceRoot, "p4-storyboard-sheet-ui-final-20260717-ep01-001.png"),
        path.join(evidenceRoot, "p4-storyboard-sheet-ui-final-20260717-ep01-001-ep01-008.png"),
      ];
  return {
    workspace,
    projectRoot: path.resolve(optionValue(argv, "--project-root") ?? path.join(workspace, DEFAULT_PROJECT_RELATIVE)),
    sourceRoot: path.resolve(optionValue(argv, "--source-root") ?? DEFAULT_SOURCE_ROOT),
    evidencePath: path.resolve(optionValue(argv, "--evidence") ?? path.join(evidenceRoot, "final-validation-20260717-p4-storyboard-sheet.json")),
    migrationEvidencePath: path.resolve(optionValue(argv, "--migration-evidence") ?? path.join(evidenceRoot, "p4-fusion-storyboard-sheet-migration-final-20260717.json")),
    mcpEvidencePath: path.resolve(optionValue(argv, "--mcp-evidence") ?? path.join(evidenceRoot, "p4-storyboard-sheet-mcp-final-20260717.json")),
    uiEvidencePath: path.resolve(optionValue(argv, "--ui-evidence") ?? path.join(evidenceRoot, "p4-storyboard-sheet-ui-final-20260717.json")),
    uiScreenshotPaths: screenshots as [string, string],
    runRoot: path.resolve(optionValue(argv, "--run-root") ?? path.join(evidenceRoot, "p4-storyboard-sheet-final-runs-20260717-01")),
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function isInside(root: string, candidate: string, allowSame = false): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "") return allowSame;
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
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
  const evidenceRootPath = path.join(input.workspace, "docs", "evidence");
  const productionsRootPath = path.join(input.workspace, "productions");
  const [workspace, projectRoot, sourceRoot, evidenceRoot, productionsRoot] = await Promise.all([
    realpath(input.workspace),
    realpath(input.projectRoot),
    realpath(input.sourceRoot),
    realpath(evidenceRootPath),
    realpath(productionsRootPath),
  ]);
  assert(isInside(workspace, evidenceRoot), "docs/evidence 经符号链接解析后不在工作区。");
  assert(isInside(productionsRoot, projectRoot), "默认正式工程必须是 workspace/productions 的直接隔离子树。");
  assert(projectRoot !== sourceRoot && !isInside(projectRoot, sourceRoot, true) && !isInside(sourceRoot, projectRoot, true), "正式工程与只读源不得相同或互相嵌套。");
  const targets = [
    ["final evidence", input.evidencePath, false],
    ["run root", input.runRoot, false],
    ["migration evidence", input.migrationEvidencePath, true],
    ["MCP evidence", input.mcpEvidencePath, true],
    ["UI evidence", input.uiEvidencePath, true],
    ["UI screenshot 1", input.uiScreenshotPaths[0], true],
    ["UI screenshot 2", input.uiScreenshotPaths[1], true],
  ] as const;
  const canonicalTargets = new Set<string>();
  for (const [label, target, mustExist] of targets) {
    assert(isInside(evidenceRootPath, target), `${label} 必须位于 workspace/docs/evidence 的子路径。`);
    const parent = await nearestExistingRealPath(path.dirname(target));
    const canonical = await exists(target)
      ? await realpath(target)
      : path.join(parent.real, ...parent.suffix, path.basename(target));
    assert(isInside(evidenceRoot, canonical) && !isInside(projectRoot, canonical, true) && !isInside(sourceRoot, canonical, true), `${label} 经符号链接解析后越界。`);
    assert(!canonicalTargets.has(canonical), `${label} 复用了另一证据/日志路径。`);
    canonicalTargets.add(canonical);
    if (mustExist) assert(await exists(target), `缺少 ${label}：${target}`);
  }
  assert(!await exists(input.evidencePath), `最终证据已存在，拒绝覆盖：${input.evidencePath}`);
  assert(!await exists(input.runRoot), `最终日志目录已存在，拒绝复用：${input.runRoot}`);
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
  assert(link.isFile() && !link.isSymbolicLink(), `只接受普通文件：${filePath}`);
  const before = await stat(filePath);
  const fileSha256 = await sha256File(filePath);
  const after = await stat(filePath);
  assert(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `计算文件摘要期间发生变化：${filePath}`);
  return { path: filePath, bytes: before.size, sha256: fileSha256 };
}

async function readJsonEvidence<T>(filePath: string): Promise<{ value: T; file: FileEvidence }> {
  const before = await stat(filePath);
  const content = await readFile(filePath);
  const after = await stat(filePath);
  assert(before.isFile() && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `读取 JSON 期间发生变化：${filePath}`);
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
  const rootLink = await lstat(root);
  assert(rootLink.isDirectory() && !rootLink.isSymbolicLink(), `清单根目录不安全：${root}`);
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
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const metadata = await lstat(absolutePath);
    assert(!metadata.isSymbolicLink(), `受保护清单包含符号链接：${absolutePath}`);
    if (metadata.isDirectory()) continue;
    assert(metadata.isFile(), `受保护清单包含非普通文件：${absolutePath}`);
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
  const rows = await mapLimit(relativePaths, 8, async (relativePath) => {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const before = await stat(absolutePath);
    const fileSha256 = await sha256File(absolutePath);
    const after = await stat(absolutePath);
    assert(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `冻结清单期间文件发生变化：${absolutePath}`);
    return { path: relativePath, bytes: before.size, sha256: fileSha256, ...(options.includeMtime ? { mtimeMs: before.mtimeMs } : {}) };
  });
  return {
    root,
    files: rows.length,
    bytes: rows.reduce((sum, entry) => sum + entry.bytes, 0),
    aggregateSha256: sha256(rows.map((entry) => `${entry.path}\0${entry.bytes}\0${"mtimeMs" in entry ? `${entry.mtimeMs}\0` : ""}${entry.sha256}`).join("\n")),
    jsonRowsSha256: sha256(JSON.stringify(rows.map(({ path: relativePath, bytes, sha256: fileSha256 }) => ({ path: relativePath, bytes, sha256: fileSha256 })))),
  };
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

async function validatePlanningAttestation(workspace: string): Promise<PlanningAttestation> {
  const root = path.join(workspace, ".planning", "2026-07-17-ai-p0-p10");
  const taskPlanPath = path.join(root, "task_plan.md");
  const attestationPath = path.join(root, ".attestation");
  const modePath = path.join(root, ".mode");
  const stopBlocksPath = path.join(root, ".stop_blocks");
  const [taskPlan, attestation, modeFile, stopBlocksFile, taskPlanText, attestedText, modeText, stopBlocksText] = await Promise.all([
    fileEvidence(taskPlanPath),
    fileEvidence(attestationPath),
    fileEvidence(modePath),
    fileEvidence(stopBlocksPath),
    readFile(taskPlanPath, "utf8"),
    readFile(attestationPath, "utf8"),
    readFile(modePath, "utf8"),
    readFile(stopBlocksPath, "utf8"),
  ]);
  const attestedSha256 = attestedText.trim();
  const mode = modeText.trim();
  const stopBlocks = Number(stopBlocksText.trim());
  assert(taskPlan.sha256 === attestedSha256
    && SHA256_PATTERN.test(attestedSha256)
    && mode === "autonomous gate"
    && stopBlocks === 0
    && taskPlanText.includes("## Current Phase\nP4：正式中文分镜板证据链")
    && taskPlanText.includes("P4: 正式中文分镜板证据链")
    && taskPlanText.includes("**Status:** in_progress")
    && taskPlanText.includes("冻结浏览器、外部生图、图生视频、上传和正式批量生产"),
  `P4 gated planning 未签署、模式错误、存在 stop block 或计划边界漂移：${JSON.stringify({ taskPlanSha256: taskPlan.sha256, attestedSha256, mode, stopBlocks })}`);
  return {
    root,
    taskPlan,
    attestation,
    modeFile,
    stopBlocksFile,
    taskPlanSha256: taskPlan.sha256,
    attestedSha256,
    mode,
    stopBlocks,
  };
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
  process.stderr.write(`[P4 final] ${name}: ${argv.join(" ")}\n`);
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
      stderr += `\n[P4 final] ${name} 超过 ${timeoutMs}ms，终止独立进程组。\n`;
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
  runs.typecheck = await runCommand(input.workspace, input.runRoot, "01-typecheck", "npm", ["run", "typecheck"], 300_000);
  runs.targeted = await runCommand(input.workspace, input.runRoot, "02-p4-targeted-tests", "npx", [
    "vitest", "run", ...TARGETED_TEST_FILES, "--maxWorkers=1", "--reporter=verbose",
  ], 900_000);
  assert(runs.targeted.testSummary
    && runs.targeted.testSummary.filesPassed === TARGETED_TEST_FILES.length
    && runs.targeted.testSummary.filesSkipped === 0
    && runs.targeted.testSummary.testsSkipped === 0
    && runs.targeted.testSummary.testsPassed >= 78,
  `P4 定向测试没有形成 ${TARGETED_TEST_FILES.length} 文件、至少 78 项全通过证据：${JSON.stringify(runs.targeted.testSummary)}`);
  runs.full = await runCommand(input.workspace, input.runRoot, "03-full-tests", "npm", ["test"], 1_200_000);
  assert(runs.full.testSummary
    && runs.full.testSummary.filesPassed >= runs.targeted.testSummary.filesPassed
    && runs.full.testSummary.testsPassed >= runs.targeted.testSummary.testsPassed
    && runs.full.testSummary.filesSkipped === 0
    && runs.full.testSummary.testsSkipped === 0,
  `全量测试计数或 skip 状态小于 P4 定向门禁：${JSON.stringify(runs.full.testSummary)}`);
  runs.build = await runCommand(input.workspace, input.runRoot, "04-production-build", "npm", ["run", "build"], 480_000);
  const migrationArgs = [
    "tsx", "scripts/migrate-p4-fusion-storyboard-sheets.ts",
    "--workspace", input.workspace,
    "--project-root", input.projectRoot,
    "--source-root", input.sourceRoot,
  ];
  runs.migrationReadOnlyFirst = await runCommand(input.workspace, input.runRoot, "05-migration-readonly-first", "npx", migrationArgs, 600_000);
  runs.migrationReadOnlySecond = await runCommand(input.workspace, input.runRoot, "06-migration-readonly-second", "npx", migrationArgs, 600_000);
  runs.mcpReadOnly = await runCommand(input.workspace, input.runRoot, "07-compiled-mcp-readonly", "npx", [
    "tsx", "scripts/mcp-p4-storyboard-sheet-smoke.ts",
    "--workspace", input.workspace,
    "--project-root", input.projectRoot,
    "--migration-evidence", input.migrationEvidencePath,
  ], 300_000);
  return runs;
}

async function parseLoggedJson(file: FileEvidence): Promise<Record<string, any>> {
  try {
    return JSON.parse(await readFile(file.path, "utf8")) as Record<string, any>;
  } catch {
    throw new Error(`命令 stdout 不是单一 JSON：${file.path}`);
  }
}

async function validateReadOnlyRunOutputs(runs: Record<string, RunEvidence>): Promise<Record<string, unknown>> {
  const first = await parseLoggedJson(runs.migrationReadOnlyFirst!.stdout);
  const second = await parseLoggedJson(runs.migrationReadOnlySecond!.stdout);
  for (const [label, value] of [["first", first], ["second", second]] as const) {
    assert(value.kind === "p4-fusion-storyboard-sheet-migration-preview"
      && value.apply === false
      && value.vendorOrGenerationInvoked === false
      && value.preview?.storeRevision === 1
      && value.preview?.candidateCount === 2
      && value.preview?.pendingCount === 0
      && value.preview?.canMigrate === false
      && Array.isArray(value.preview?.blockers)
      && value.preview.blockers.length === 0,
    `第 ${label} 次 P4 只读迁移预检不是 revision 1 已满足状态：${JSON.stringify(value.preview)}`);
  }
  const normalized = (value: Record<string, any>) => ({
    projectRoot: value.projectRoot,
    sourceRoot: value.sourceRoot,
    source: value.source,
    protected: value.protected,
    preview: value.preview,
    command: value.command,
    vendorOrGenerationInvoked: value.vendorOrGenerationInvoked,
  });
  assert(JSON.stringify(normalized(first)) === JSON.stringify(normalized(second)), "两次 P4 只读迁移预检的正式输入或幂等计划不一致。");
  const mcp = await parseLoggedJson(runs.mcpReadOnly!.stdout);
  assert(mcp.passed === true
    && mcp.toolCount === EXPECTED_TOOL_COUNT
    && mcp.ep01_001?.current === 0
    && Array.isArray(mcp.ep01_001?.history)
    && mcp.ep01_001.history.includes("stale")
    && mcp.ep01_001.history.includes("legacy-invalid")
    && mcp.ep01_008?.current === 0
    && mcp.ep01_008?.panelCount === 6
    && mcp.migrationReplayed === true
    && mcp.guardedUnchanged === true,
  `当前编译 MCP 只读烟测摘要异常：${JSON.stringify(mcp)}`);
  const targetedOutput = (await readFile(runs.targeted!.stdout.path, "utf8")).replace(/\u001b\[[0-9;]*m/gu, "");
  const namedRegressions = [
    "P4 migration 业务 store 落盘后、终态事件前崩溃时由候选指纹确定恢复且不重复登记",
    "reconcile_command 可使用账本内 P4 请求快照从业务 store 对账，并回写独立事务根",
    "P4 render 已登记 current receipt/store 后崩溃只做确定性对账与补扫，不再次渲染或登记",
    "默认 contain 不裁图；显式 focal/rect crop 归一化并冻结实际像素审计",
    "从绝对路径派生 current/stale/invalid/legacy-invalid 及精确原因",
    "拒绝把 v2 或历史 Artifact 登记到工程根外",
    "越界输出和符号链接输出失败关闭，不产生迁移索引",
    "逐格宫格任务各自冻结唯一参考板，首中尾可并存且同格拒绝重复",
  ];
  for (const name of namedRegressions) assert(targetedOutput.includes(name), `P4 定向 verbose 日志缺少已通过的关键回归：${name}`);
  const productionTestSource = await readFile(path.join(runs.targeted!.cwd, "tests", "fusion-production.test.ts"), "utf8");
  assert(productionTestSource.includes("retainedCropReplay")
    && productionTestSource.includes("croppedSheetScan")
    && productionTestSource.includes("current: 1, stale: 1, invalid: 0, legacyInvalid: 0, pages: 2")
    && productionTestSource.includes("missingCompanionJobs")
    && productionTestSource.includes("companionPublicationReceiptId")
    && productionTestSource.includes("unsafe_info_path")
    && productionTestSource.includes("await symlink(outsideStoryboardDirectory, linkedStoryboardDirectory, \"dir\")")
    && productionTestSource.includes("真实路径越出|符号链接|unsafe_info_path"),
  "fusion-production 已通过的大型纵向回归未同时包含 crop policy 保留、companion 独立回执门禁、infoPath realpath/符号链接失败关闭与新旧板投影断言。");
  return {
    migrationReadOnly: {
      candidateFingerprint: first.preview.candidateFingerprint,
      storeRevision: 1,
      candidateCount: 2,
      pendingCount: 0,
      exactSemanticReplay: true,
      vendorOrGenerationInvoked: false,
    },
    compiledMcp: mcp,
    namedRegressions: {
      verboseReporter: true,
      passedNames: namedRegressions,
      cropPolicyRetentionAssertionsPresent: true,
      companionReceiptIndependentValidationAssertionsPresent: true,
      infoPathRealpathAndSymlinkContainmentAssertionsPresent: true,
    },
  };
}

async function guardedFormalState(projectRoot: string): Promise<GuardedFormalState> {
  const sidecar = getSidecarPaths(projectRoot);
  const store = await loadFusionStoryboardSheetStore(projectRoot);
  const namedFiles = {
    projectConfig: sidecar.config,
    projectIndex: sidecar.index,
    progressMarkdown: sidecar.progressMarkdown,
    projectOverrides: sidecar.overrides,
    events: sidecar.events,
    commandLedger: sidecar.commandLedger,
    generationJobs: sidecar.generationJobs,
    publications: sidecar.publications,
    reviews: sidecar.reviews,
    p2PanelReferences: sidecar.panelReferenceResolutions,
    p3VisualConstraints: sidecar.panelVisualConstraints,
    storyboardGridSelections: sidecar.storyboardGridSelections,
    storyboardSheetIndex: sidecar.storyboardSheetIndex,
    storyboards: sidecar.storyboards,
    fusionManifest: sidecar.fusionProjectManifest,
    productionAssets: sidecar.productionAssets,
    continuityTracks: sidecar.continuityTracks,
    generationSettings: sidecar.generationSettings,
  };
  const files = Object.fromEntries(await Promise.all(Object.entries(namedFiles)
    .map(async ([name, filePath]) => [name, await fileEvidence(filePath)]))) as GuardedFormalState["files"];
  const artifactPaths = [...new Set([
    ...Object.values(store.records).flatMap((entry) => [entry.receiptPath, ...entry.outputs.map((output) => output.path)]),
    ...Object.values(store.legacyRecords).flatMap((entry) => entry.artifacts.map((artifact) => artifact.path)),
  ].map((entry) => path.resolve(entry)))].sort((left, right) => left.localeCompare(right, "en"));
  const [requests, downloads, subagentStaging, rawLabeled, sheetArtifacts] = await Promise.all([
    inventorySnapshot(sidecar.generationRequests),
    inventorySnapshot(sidecar.generationDownloads),
    inventorySnapshot(path.join(sidecar.root, "subagent-staging")),
    inventorySnapshot(projectRoot, { patterns: RAW_LABELED_PATTERNS, ignore: RAW_LABELED_IGNORES }),
    Promise.all(artifactPaths.map(fileEvidence)),
  ]);
  const base = { files, requests, downloads, subagentStaging, rawLabeled, sheetArtifacts };
  return { ...base, identitySha256: digest(base) };
}

function countJobsByStatus(jobs: GenerationJob[]): Record<string, number> {
  return Object.fromEntries([...new Set(jobs.map((job) => job.status))]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((status) => [status, jobs.filter((job) => job.status === status).length]));
}

async function validateFormalState(input: CliOptions): Promise<FormalValidation> {
  const sidecar = getSidecarPaths(input.projectRoot);
  const [store, state001, state008, inspected001, inspected008, jobs, publications, reviews, index] = await Promise.all([
    loadFusionStoryboardSheetStore(input.projectRoot),
    getFusionStoryboardSheetState(input.projectRoot, { itemId: EP01_001 }),
    getFusionStoryboardSheetState(input.projectRoot, { itemId: EP01_008 }),
    inspectFusionStoryboardSheetEvidence(input.projectRoot, { itemId: EP01_001 }),
    inspectFusionStoryboardSheetEvidence(input.projectRoot, { itemId: EP01_008 }),
    readJson<GenerationJob[]>(sidecar.generationJobs, []),
    readJson<PublicationStore>(sidecar.publications, { schemaVersion: 1, revision: 0, intents: [], receipts: [], updatedAt: "" }),
    readJson<ReviewStore>(sidecar.reviews, { schemaVersion: 1, records: [] }),
    loadIndex(input.projectRoot),
  ]);
  assert(index, "正式工程缺少 .aicanvas/index.json。");
  assert(store.schemaVersion === 1
    && store.kind === "fusion-storyboard-sheet-index"
    && store.revision === 1
    && Object.keys(store.records).length === 0
    && Object.keys(store.currentByItemId).length === 0
    && Object.keys(store.legacyRecords).length === 2,
  `正式 P4 artifact index 不是 revision 1 / 0 current / 2 历史：${JSON.stringify({ revision: store.revision, records: Object.keys(store.records), current: store.currentByItemId, legacy: Object.keys(store.legacyRecords) })}`);
  const migrationPreview = await previewFusionStoryboardSheetMigration(input.projectRoot, {}, { store });
  assert(migrationPreview.storeRevision === 1
    && migrationPreview.scope.itemIds.length === 0
    && migrationPreview.candidateCount === 2
    && migrationPreview.pendingCount === 0
    && migrationPreview.blockers.length === 0
    && migrationPreview.canMigrate === false
    && SHA256_PATTERN.test(migrationPreview.candidateFingerprint)
    && JSON.stringify(migrationPreview.candidates.map((entry) => entry.sheetId).sort())
      === JSON.stringify(Object.keys(store.legacyRecords).sort()),
  `正式 P4 迁移实时预检不是 revision 1 / 2 candidates / 0 pending：${JSON.stringify(migrationPreview)}`);

  const legacy = Object.values(store.legacyRecords).sort((left, right) => left.sheetId.localeCompare(right.sheetId, "en"));
  const stale = legacy.filter((entry) => entry.status === "stale");
  const legacyInvalid = legacy.filter((entry) => entry.status === "legacy-invalid");
  assert(stale.length === 1 && legacyInvalid.length === 1
    && stale[0]!.itemId === EP01_001 && stale[0]!.artifacts.length === 3
    && legacyInvalid[0]!.itemId === EP01_001 && legacyInvalid[0]!.artifacts.length === 1,
  `正式 P4 历史不是 1 stale(3 artifacts) + 1 legacy-invalid(receipt only)：${JSON.stringify(legacy)}`);
  const sheetArtifacts: FormalValidation["sheetArtifacts"] = [];
  for (const record of legacy) {
    assert(/^legacy-sheet-[a-f0-9]{32}$/u.test(record.sheetId), `历史 sheetId 无效：${record.sheetId}`);
    for (const artifact of record.artifacts) {
      assert(path.isAbsolute(artifact.path) && isInside(input.projectRoot, artifact.path), `历史板 artifact 越出正式工程：${artifact.path}`);
      assert(artifact.sha256 && SHA256_PATTERN.test(artifact.sha256) && Number.isInteger(artifact.bytes) && artifact.bytes! > 0, `历史板 artifact 没有冻结 SHA/bytes：${artifact.path}`);
      const observed = await fileEvidence(artifact.path);
      assert(observed.sha256 === artifact.sha256 && observed.bytes === artifact.bytes, `历史板 artifact 文件 SHA/bytes 已漂移：${artifact.path}`);
      sheetArtifacts.push({ ...observed, sheetId: record.sheetId, role: artifact.role, status: record.status });
    }
  }
  assert(new Set(sheetArtifacts.map((entry) => entry.path)).size === 4, "两条 P4 历史应精确引用 4 个不同文件。");

  const statuses001 = state001.versions.map((entry) => entry.status).sort();
  assert(state001.schemaVersion === 2
    && state001.itemId === EP01_001
    && state001.storeRevision === 1
    && state001.currentSheetId === undefined
    && state001.readiness.canRender === false
    && state001.readiness.expectedInputFingerprint === undefined
    && state001.currentContract?.selection.panelCount === 4
    && JSON.stringify(statuses001) === JSON.stringify(["legacy-invalid", "stale"])
    && state001.versions.every((entry) => entry.itemId === EP01_001)
    && state001.migrationPreview.pendingCount === 0
    && state001.migrationPreview.blockers.length === 0
    && /P3|Review/u.test(state001.readiness.blockers.join(" ")),
  `EP01_001 不是 current=0 + stale/legacy-invalid + P3 Review 失败关闭：${JSON.stringify(state001)}`);
  assert(!inspected001.currentEvidence && !inspected001.review && inspected001.requirement?.complete === true,
    "EP01_001 不得存在可渲染 currentEvidence 或伪造的 P3 pass Review。");
  const ruleCount001 = inspected001.requirement?.panels.reduce((sum, panel) => sum + (panel.visualReviewRules?.length ?? 0), 0) ?? 0;
  assert(inspected001.requirement?.panelCount === 4 && ruleCount001 === 28,
    `EP01_001 当前 requirement 不是 4 格 / 28 条 P3 人工规则：${JSON.stringify({ panels: inspected001.requirement?.panelCount, ruleCount001 })}`);
  const historicalPass001 = reviews.records.filter((record) => record.itemId === EP01_001 && record.reviewType === "image" && record.decision === "pass");
  assert(reviews.schemaVersion === 1
    && reviews.records.length === 20
    && historicalPass001.length > 0
    && historicalPass001.every((record) => (record.visualConstraintAttestations?.length ?? 0) === 0),
  "Review 账本应保持 20 条；EP01_001 历史 pass 应存在，但不得被追填 P3 逐规则 attestation。");

  const unit008 = index.items.find((entry) => entry.id === EP01_008 && entry.type === "unit");
  assert(unit008?.fusionStoryboard?.panelCount === 6, "正式索引中 EP01_008 不是 6 格合同。");
  const completePairs008 = unit008.fusionStoryboard.panels.filter((panel) => panel.rawArtifactId && panel.labeledArtifactId).length;
  const blockers008 = state008.readiness.blockers.join("；");
  assert(state008.schemaVersion === 2
    && state008.itemId === EP01_008
    && state008.storeRevision === 1
    && state008.currentSheetId === undefined
    && state008.readiness.canRender === false
    && state008.readiness.expectedInputFingerprint === undefined
    && state008.currentContract?.selection.panelCount === 6
    && completePairs008 === 4
    && state008.versions.length === 0
    && /generation_unknown/u.test(blockers008)
    && /宫格06|缺少/u.test(blockers008)
    && state008.migrationPreview.pendingCount === 0,
  `EP01_008 不是 current=0 / 4-of-6 / unknown+missing 失败关闭：${JSON.stringify(state008)}`);
  assert(!inspected008.currentEvidence && !inspected008.review, "EP01_008 不得存在 currentEvidence 或有效成板 Review。");

  const jobsByStatus = countJobsByStatus(jobs);
  const unknown = jobs.find((job) => job.id === EP01_008_UNKNOWN_JOB);
  const jobs008 = jobs.filter((job) => job.itemId === EP01_008);
  const succeededPanels008 = [...new Set(jobs008
    .filter((job) => job.status === "succeeded")
    .map((job) => job.fusionStoryboardPanel?.panelIndex)
    .filter((value): value is number => Number.isInteger(value)))].sort((left, right) => left - right);
  assert(jobs.length === 30
    && jobsByStatus.succeeded === 26
    && jobsByStatus.failed === 3
    && jobsByStatus.generation_unknown === 1
    && unknown?.itemId === EP01_008
    && unknown.status === "generation_unknown"
    && unknown.fusionStoryboardPanel?.panelIndex === 5
    && !unknown.resultPath && !unknown.companionPath && !unknown.publicationReceiptId
    && !unknown.companionPublicationReceiptId
    && unknown.attempts === 1
    && unknown.subagentCheckpoint?.stage === "generation_unknown"
    && unknown.subagentCheckpoint?.unknown?.code === "legacy_leased_without_call_receipt"
    && unknown.subagentCheckpoint?.unknown?.previousStage === "leased"
    && JSON.stringify(succeededPanels008) === JSON.stringify([1, 2, 3, 4])
    && jobs008.every((job) => job.fusionStoryboardPanel?.panelIndex !== 6),
  `EP01_008 Job 账本不是 1-4 succeeded / 5 generation_unknown / 6 missing：${JSON.stringify({ jobsByStatus, succeededPanels008, unknown })}`);

  const unknownIntents = publications.intents
    .filter((intent) => intent.context.jobId === EP01_008_UNKNOWN_JOB)
    .sort((left, right) => (left.bundleMember ?? "").localeCompare(right.bundleMember ?? "", "en"));
  assert(publications.schemaVersion === 1
    && publications.intents.length === 31
    && publications.receipts.length === 26
    && publications.receipts.every((receipt) => receipt.kind === "raw-image" && receipt.bundleId === undefined)
    && unknownIntents.length === 2
    && unknownIntents.every((intent) => intent.status === "reserved"
      && intent.bundleId === unknown.publicationBundleId
      && !intent.receiptId
      && path.resolve(intent.targetPath) === path.resolve(intent.bundleMember === "primary"
        ? unknown.expectedOutputPath
        : unknown.expectedCompanionPath!))
    && new Set(unknownIntents.map((intent) => intent.bundleMember)).size === 2
    && unknownIntents.some((intent) => intent.bundleMember === "primary" && intent.kind === "raw-image")
    && unknownIntents.some((intent) => intent.bundleMember === "companion" && intent.kind === "labeled-image")
    && !await exists(unknown.expectedOutputPath)
    && !await exists(unknown.expectedCompanionPath!),
  `Publication 账本不是 31 intents / 26 历史 raw receipts，或 unknown raw+labeled bundle 已被误领/误发布：${JSON.stringify({ intents: publications.intents.length, receipts: publications.receipts.length, unknownIntents })}`);

  const snapshot = await listFusionStoryboardSheetArtifactSnapshot(input.projectRoot, {
    currentEvidenceByItemId: { [EP01_001]: inspected001.currentEvidence, [EP01_008]: inspected008.currentEvidence },
    verifyFiles: true,
    store,
  });
  assert(snapshot.storeRevision === 1
    && snapshot.items.length === 4
    && snapshot.items.every((entry) => entry.status === "stale" || entry.status === "legacy-invalid")
    && Object.values(snapshot.byPath).every((entry) => entry.status !== "current"),
  `正式 P4 artifact snapshot 出现 current/invalid 或数量漂移：${JSON.stringify(snapshot)}`);

  const scanned = await scanProject({ projectRoot: input.projectRoot, persist: false, includeHashes: true });
  const scannedSheets = scanned.artifacts.filter((artifact) => artifact.fusionStoryboardSheet);
  const scannedStatuses = [...new Set(scannedSheets.map((artifact) => artifact.fusionStoryboardSheet!.status))].sort();
  const sheetSummary = scanned.summary.storyboardSheets;
  assert(scannedSheets.length === 4
    && scannedSheets.every((artifact) => !artifact.authoritative && !artifact.accepted)
    && scannedSheets.every((artifact) => artifact.check.ok)
    && scannedSheets.every((artifact) => artifact.fusionStoryboardSheet!.status !== "current")
    && JSON.stringify(scannedStatuses) === JSON.stringify(["legacy-invalid", "stale"])
    && sheetSummary?.current === 0
    && sheetSummary.stale === 1
    && sheetSummary.invalid === 0
    && sheetSummary.legacyInvalid === 1
    && sheetSummary.pages === 1,
  `Scanner 把正式历史/非 current 中文板提升为权威：${JSON.stringify(scannedSheets.map((artifact) => ({ path: artifact.path, authoritative: artifact.authoritative, accepted: artifact.accepted, sheet: artifact.fusionStoryboardSheet })))}`);
  const persistedSheets = index.artifacts.filter((artifact) => artifact.fusionStoryboardSheet);
  const persistedSummary = index.summary.storyboardSheets;
  const persisted001 = persistedSheets.filter((artifact) => artifact.itemId === EP01_001);
  const persisted008 = persistedSheets.filter((artifact) => artifact.itemId === EP01_008);
  assert(persistedSheets.length === 4
    && persisted001.length === 4
    && persisted008.length === 0
    && persistedSheets.every((artifact) => artifact.check.ok
      && !artifact.authoritative
      && !artifact.accepted
      && (artifact.fusionStoryboardSheet?.status === "stale" || artifact.fusionStoryboardSheet?.status === "legacy-invalid"))
    && persistedSummary?.current === 0
    && persistedSummary.stale === 1
    && persistedSummary.invalid === 0
    && persistedSummary.legacyInvalid === 1
    && persistedSummary.pages === 1
    && digest(persistedSheets.map((artifact) => ({
      path: artifact.path,
      kind: artifact.kind,
      check: artifact.check,
      authoritative: artifact.authoritative,
      accepted: artifact.accepted,
      fusionStoryboardSheet: artifact.fusionStoryboardSheet,
    })).sort((left, right) => left.path.localeCompare(right.path, "en")))
      === digest(scannedSheets.map((artifact) => ({
        path: artifact.path,
        kind: artifact.kind,
        check: artifact.check,
        authoritative: artifact.authoritative,
        accepted: artifact.accepted,
        fusionStoryboardSheet: artifact.fusionStoryboardSheet,
      })).sort((left, right) => left.path.localeCompare(right.path, "en"))),
  `持久 .aicanvas/index.json 尚未投影 P4 正式 Artifact，或与本次只读 Scanner 结果不一致：${JSON.stringify({ persistedSheets: persistedSheets.length, persisted001: persisted001.length, persisted008: persisted008.length, persistedSummary })}`);

  return {
    store,
    state001,
    state008,
    scanner: {
      persist: false,
      scanId: scanned.scanId,
      sheetArtifacts: scannedSheets.length,
      statuses: scannedStatuses,
      authoritative: scannedSheets.filter((artifact) => artifact.authoritative).length,
      accepted: scannedSheets.filter((artifact) => artifact.accepted).length,
      summary: sheetSummary,
      persistedProjection: {
        indexPath: sidecar.index,
        sheetArtifacts: persistedSheets.length,
        ep01_001: persisted001.length,
        ep01_008: persisted008.length,
        summary: persistedSummary,
        exactlyMatchesReadOnlyRescan: true,
      },
    },
    ledger: {
      generationJobs: jobs.length,
      jobsByStatus,
      publications: {
        intents: publications.intents.length,
        receipts: publications.receipts.length,
        unknownBundleIntents: unknownIntents.map((intent) => ({
          id: intent.id,
          member: intent.bundleMember,
          kind: intent.kind,
          revision: intent.revision,
          status: intent.status,
        })),
      },
      migrationPreview: {
        storeRevision: migrationPreview.storeRevision,
        candidateFingerprint: migrationPreview.candidateFingerprint,
        candidateCount: migrationPreview.candidateCount,
        pendingCount: migrationPreview.pendingCount,
        sheetIds: migrationPreview.candidates.map((entry) => entry.sheetId),
      },
      reviews: reviews.records.length,
      ep01_001: {
        current: 0,
        requirementPanels: inspected001.requirement?.panelCount,
        visualRules: ruleCount001,
        historicalPassReviewIds: historicalPass001.map((record) => record.id),
        historicalP3Attestations: 0,
      },
      ep01_008: {
        current: 0,
        panels: 6,
        completePairs: completePairs008,
        succeededPanels: succeededPanels008,
        unknownPanel: 5,
        unknownJobId: unknown.id,
        missingPanel: 6,
      },
    },
    sheetArtifacts,
  };
}

function formalSemanticIdentity(formal: FormalValidation): string {
  const { scanId: _scanId, ...scanner } = formal.scanner;
  return digest({
    store: formal.store,
    state001: formal.state001,
    state008: formal.state008,
    scanner,
    ledger: formal.ledger,
    sheetArtifacts: formal.sheetArtifacts,
  });
}

function assertCurrentFileIdentity(
  reported: Record<string, any> | undefined,
  current: FileEvidence,
  label: string,
): void {
  assert(reported
    && reported.exists === true
    && path.resolve(reported.path ?? "") === path.resolve(current.path)
    && reported.bytes === current.bytes
    && reported.sha256 === current.sha256,
  `${label} 中的受保护文件与当前正式工程不一致。`);
}

function assertCurrentInventory(
  reported: Record<string, any> | undefined,
  current: InventorySnapshot,
  algorithm: "aggregate" | "jsonRows",
  label: string,
): void {
  const reportedHash = algorithm === "aggregate" ? reported?.aggregateSha256 : reported?.sha256;
  const currentHash = algorithm === "aggregate" ? current.aggregateSha256 : current.jsonRowsSha256;
  assert(reported
    && path.resolve(reported.root ?? "") === path.resolve(current.root)
    && reported.files === current.files
    && reported.bytes === current.bytes
    && reportedHash === currentHash,
  `${label} 中的受保护清单与当前正式工程不一致。`);
}

async function validateExternalEvidence(
  input: CliOptions,
  guarded: GuardedFormalState,
  formal: FormalValidation,
): Promise<ExternalEvidenceValidation> {
  const [migration, mcp, ui] = await Promise.all([
    readJsonEvidence<Record<string, any>>(input.migrationEvidencePath),
    readJsonEvidence<Record<string, any>>(input.mcpEvidencePath),
    readJsonEvidence<Record<string, any>>(input.uiEvidencePath),
  ]);
  assert(migration.value.schemaVersion === 1
    && migration.value.kind === "p4-fusion-storyboard-sheet-migration"
    && migration.value.passed === true
    && migration.value.apply === true
    && migration.value.vendorOrGenerationInvoked === false
    && path.resolve(migration.value.workspace ?? "") === input.workspace
    && path.resolve(migration.value.projectRoot ?? "") === input.projectRoot
    && path.resolve(migration.value.sourceRoot ?? "") === input.sourceRoot
    && migration.value.source?.unchanged === true
    && migration.value.source?.before?.aggregateSha256 === EXPECTED_SOURCE.aggregateSha256
    && migration.value.source?.after?.aggregateSha256 === EXPECTED_SOURCE.aggregateSha256
    && migration.value.protected?.unchanged === true
    && JSON.stringify(migration.value.protected.before) === JSON.stringify(migration.value.protected.after)
    && migration.value.first?.record?.status === "succeeded"
    && migration.value.first?.record?.replayed === false
    && migration.value.first?.result?.storeRevision === 1
    && migration.value.first?.result?.created === 2
    && migration.value.replay?.record?.status === "succeeded"
    && migration.value.replay?.record?.replayed === true
    && migration.value.replay?.strict === true
    && migration.value.preview?.before?.candidateCount === 2
    && migration.value.preview?.before?.pendingCount === 2
    && migration.value.preview?.after?.storeRevision === 1
    && migration.value.preview?.after?.pendingCount === 0
    && migration.value.preview?.after?.canMigrate === false,
  "P4 migration 正式证据没有证明两条历史、CAS 幂等重放、零供应商和受保护账本不变。");
  const migrationCandidates = migration.value.preview.before.candidates as Array<Record<string, any>>;
  const migrationSheetIds = migrationCandidates.map((entry) => String(entry.sheetId)).sort();
  assert(JSON.stringify(migrationSheetIds) === JSON.stringify(Object.keys(formal.store.legacyRecords).sort()), "P4 migration 候选 sheetId 与当前正式索引两条历史不同一。");
  for (const candidate of migrationCandidates) {
    const current = formal.store.legacyRecords[String(candidate.sheetId)];
    assert(current
      && candidate.status === current.status
      && candidate.itemId === current.itemId
      && candidate.reason === current.reason
      && JSON.stringify(candidate.artifacts) === JSON.stringify(current.artifacts),
    `P4 migration 候选与正式索引记录不一致：${String(candidate.sheetId)}`);
  }
  const migrationGuard = migration.value.protected.after as Record<string, any>;
  assertCurrentFileIdentity(migrationGuard.generationJobs, guarded.files.generationJobs, "migration");
  assertCurrentFileIdentity(migrationGuard.publications, guarded.files.publications, "migration");
  assertCurrentFileIdentity(migrationGuard.reviews, guarded.files.reviews, "migration");
  assertCurrentInventory(migrationGuard.generationRequests, guarded.requests, "aggregate", "migration requests");
  assertCurrentInventory(migrationGuard.generationDownloads, guarded.downloads, "aggregate", "migration downloads");
  assertCurrentInventory(migrationGuard.rawLabeled, guarded.rawLabeled, "aggregate", "migration raw/labeled");

  assert(mcp.value.schemaVersion === 1
    && mcp.value.kind === "p4-storyboard-sheet-mcp-smoke"
    && mcp.value.passed === true
    && mcp.value.toolCount === EXPECTED_TOOL_COUNT
    && path.resolve(mcp.value.workspace ?? "") === input.workspace
    && path.resolve(mcp.value.projectRoot ?? "") === input.projectRoot
    && mcp.value.schemas?.state === true
    && mcp.value.schemas?.list === true
    && mcp.value.schemas?.migrateGuardedIdempotent === true
    && mcp.value.ep01_001?.current === 0
    && mcp.value.ep01_001?.history?.length === 2
    && mcp.value.ep01_001.history.some((entry: Record<string, any>) => entry.status === "stale")
    && mcp.value.ep01_001.history.some((entry: Record<string, any>) => entry.status === "legacy-invalid")
    && mcp.value.ep01_008?.current === 0
    && mcp.value.ep01_008?.panelCount === 6
    && mcp.value.migrationReplay?.status === "succeeded"
    && mcp.value.migrationReplay?.replayed === true
    && mcp.value.guarded?.unchanged === true
    && JSON.stringify(mcp.value.guarded.before) === JSON.stringify(mcp.value.guarded.after)
    && mcp.value.renderOrGenerationInvoked === false,
  "P4 MCP 正式证据没有证明 release manifest 工具清单、状态/list schema、幂等迁移重放和零渲染/生成。");
  const mcpGuard = mcp.value.guarded.after as Record<string, any>;
  for (const [name, current] of Object.entries({
    jobs: guarded.files.generationJobs,
    publications: guarded.files.publications,
    reviews: guarded.files.reviews,
    sheetIndex: guarded.files.storyboardSheetIndex,
    commandLedger: guarded.files.commandLedger,
    events: guarded.files.events,
  })) assertCurrentFileIdentity(mcpGuard[name], current, `MCP ${name}`);
  assertCurrentInventory(mcpGuard.requests, guarded.requests, "jsonRows", "MCP requests");
  assertCurrentInventory(mcpGuard.downloads, guarded.downloads, "jsonRows", "MCP downloads");
  assertCurrentInventory(mcpGuard.rawLabeled, guarded.rawLabeled, "jsonRows", "MCP raw/labeled");

  assert(ui.value.schemaVersion === 1
    && ui.value.kind === "p4-storyboard-sheet-ui-smoke"
    && ui.value.passed === true
    && path.resolve(ui.value.workspace ?? "") === input.workspace
    && path.resolve(ui.value.projectRoot ?? "") === input.projectRoot
    && ui.value.ep01_001?.itemId === EP01_001
    && ui.value.ep01_001?.current === "current 0/1"
    && ui.value.ep01_001?.fingerprint === "未签发"
    && ui.value.ep01_001?.renderDisabled === true
    && ui.value.ep01_001?.historyStatuses?.includes("stale")
    && ui.value.ep01_001?.historyStatuses?.includes("legacy-invalid")
    && ui.value.ep01_008?.itemId === EP01_008
    && ui.value.ep01_008?.current === "current 0/1"
    && ui.value.ep01_008?.contractPanels === 6
    && ui.value.ep01_008?.scannedProgress === "4/6"
    && ui.value.ep01_008?.fingerprint === "未签发"
    && ui.value.ep01_008?.renderDisabled === true
    && ui.value.ep01_008?.panelStates?.find((entry: Record<string, any>) => entry.panel === 5)?.unknown === true
    && ui.value.ep01_008?.panelStates?.find((entry: Record<string, any>) => entry.panel === 6)?.missing === true
    && ui.value.ep01_008?.panel5EnqueueDisabled === true
    && ui.value.ep01_008?.panel6EnqueueDisabled === false
    && ui.value.guarded?.unchanged === true
    && JSON.stringify(ui.value.guarded.before) === JSON.stringify(ui.value.guarded.after)
    && Array.isArray(ui.value.pageErrors) && ui.value.pageErrors.length === 0
    && Array.isArray(ui.value.externalRequests) && ui.value.externalRequests.length === 0
    && Array.isArray(ui.value.externalPages) && ui.value.externalPages.length === 0
    && Object.values(ui.value.clicked ?? {}).every((value) => value === false),
  "P4 UI 正式证据没有证明 EP01_001/008 失败关闭、4/6 unknown+missing、unknown 禁止重试、missing 可入队、无外网且未点击写入操作。");
  const uiGuard = ui.value.guarded.after as Record<string, any>;
  for (const [name, current] of Object.entries({
    projectIndex: guarded.files.projectIndex,
    jobs: guarded.files.generationJobs,
    publications: guarded.files.publications,
    reviews: guarded.files.reviews,
    sheetIndex: guarded.files.storyboardSheetIndex,
    commandLedger: guarded.files.commandLedger,
    events: guarded.files.events,
  })) assertCurrentFileIdentity(uiGuard[name], current, `UI ${name}`);
  assertCurrentInventory(uiGuard.requests, guarded.requests, "jsonRows", "UI requests");
  assertCurrentInventory(uiGuard.downloads, guarded.downloads, "jsonRows", "UI downloads");
  assertCurrentInventory(uiGuard.rawLabeled, guarded.rawLabeled, "jsonRows", "UI raw/labeled");

  assert(Array.isArray(ui.value.screenshots) && ui.value.screenshots.length === 2, "P4 UI 证据必须绑定两张截图。");
  const screenshots: ExternalEvidenceValidation["screenshots"] = [];
  for (const screenshotPath of input.uiScreenshotPaths) {
    const reported = ui.value.screenshots.find((entry: Record<string, any>) => path.resolve(entry.path ?? "") === screenshotPath);
    const [file, metadata, statsValue] = await Promise.all([
      fileEvidence(screenshotPath),
      sharp(screenshotPath, { failOn: "error" }).metadata(),
      sharp(screenshotPath, { failOn: "error" }).stats(),
    ]);
    const standardDeviation = Math.max(...statsValue.channels.slice(0, 3).map((channel) => channel.stdev));
    assert(reported
      && reported.exists === true
      && reported.bytes === file.bytes
      && reported.sha256 === file.sha256
      && reported.width === metadata.width
      && reported.height === metadata.height
      && reported.format === "png"
      && metadata.format === "png"
      && (metadata.width ?? 0) >= 1_200
      && (metadata.height ?? 0) >= 700
      && file.bytes >= 100_000
      && Number(reported.standardDeviation) > 5
      && standardDeviation > 5,
    `P4 UI 截图不可解码、过小、过于单色或已漂移：${screenshotPath}`);
    screenshots.push({ ...file, width: metadata.width!, height: metadata.height!, standardDeviation });
  }
  return {
    migration: migration.file,
    mcp: mcp.file,
    ui: ui.file,
    screenshots,
    migrationCandidateFingerprint: migration.value.preview.after.candidateFingerprint,
    migrationSheetIds,
    mcpToolCount: mcp.value.toolCount,
  };
}

function storyboardRows(count: number): StoryboardProductionContract[] {
  return Array.from({ length: count }, (_, index) => ({
    storyboardRowId: `row-${index + 1}`,
    storyboardRowRevision: index + 1,
    itemId: "season-3-ep01-unit001",
    shotItemId: `season-3-ep01-unit001-shot${index + 1}`,
    order: index + 1,
    durationSeconds: 15 / count,
    shotSize: index === 0 ? "远景" : index === count - 1 ? "特写" : "中景",
    cameraMovement: index % 2 ? "固定镜头" : "缓慢推进",
    cameraAngle: index % 2 ? "平视" : "低机位",
    lens: index % 2 ? "50mm" : "35mm",
    composition: "主体位于纵向中轴，保留前后景深",
    staging: "角色动作沿同一轴线连续推进",
    action: `第 ${index + 1} 段动作，榜缝金光逐步聚拢并改变空间层次`,
    expression: "警觉",
    emotion: index === count - 1 ? "决断" : "紧张",
    dialogue: index % 2 ? undefined : `阿航：第 ${index + 1} 段台词`,
    narration: index % 2 ? `旁白：第 ${index + 1} 段推进` : undefined,
    ambience: "高空风声与低频嗡鸣",
    soundEffects: ["榜纸震动", "金光划破空气"],
    continuityBefore: index ? `承接第 ${index} 段动作落点` : "承接第二季彩蛋",
    continuityAfter: index === count - 1 ? "落在下一单元悬念" : `进入第 ${index + 2} 段`,
    firstFramePrompt: `第 ${index + 1} 段起势，古蜀神魔空间，纯画面`,
    endFramePrompt: `第 ${index + 1} 段落点，空间连续，纯画面`,
    videoPrompt: `第 ${index + 1} 段连续动作`,
    referencePaths: [],
    referenceArtifactIds: [],
  }));
}

function storyboardSchedule(count: number): FusionScheduleRow[] {
  return Array.from({ length: count }, (_, index) => {
    const startSeconds = (15 * index) / count;
    const endSeconds = (15 * (index + 1)) / count;
    return {
      index,
      startSeconds,
      endSeconds,
      durationSeconds: endSeconds - startSeconds,
      label: `镜${index + 1}`,
      content: `第 ${index + 1} 段`,
      kind: "source-shot",
      sourceShotNumber: index + 1,
    };
  });
}

async function deterministicPng(width: number, height: number, seed: number): Promise<Buffer> {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    const pixel = offset / 3;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    pixels[offset] = (x * (17 + seed) + y * 7 + seed * 19) % 256;
    pixels[offset + 1] = (x * 5 + y * (19 + seed) + seed * 31) % 256;
    pixels[offset + 2] = (x * (11 + seed) + y * 3 + seed * 47) % 256;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer();
}

async function createRendererSample(root: string, name: string, panelCount: number): Promise<{
  contract: FusionStoryboardGridContract;
  images: FusionStoryboardSheetPanelImageInput[];
  outputPath: string;
  svgOutputPath: string;
}> {
  const sampleRoot = path.join(root, name);
  const panelDirectory = path.join(sampleRoot, "panels");
  await mkdir(panelDirectory, { recursive: true });
  const contract = buildFusionStoryboardGrid({
    unit: {
      unitId: "season-3-ep01-unit001",
      title: "承第二季彩蛋·封神榜缝隙开启",
      episodeLabel: "EP01",
      unitSequence: 1,
      storyGoal: "榜缝金光建立第三季主线",
      aspectRatio: "9:16",
      standardDurationSeconds: 15,
    },
    storyboardRevision: 9,
    rows: storyboardRows(panelCount),
    schedule: storyboardSchedule(panelCount),
    assetIdsByRowId: Object.fromEntries(Array.from({ length: panelCount }, (_, index) => [
      `row-${index + 1}`,
      ["C01", "S01", `P${String(index + 1).padStart(2, "0")}`],
    ])),
  });
  const images = await Promise.all(contract.panels.map(async (panel, index) => {
    const imagePath = path.join(panelDirectory, `${panel.id}.png`);
    const content = await deterministicPng(720, 1_280, index + 1);
    await writeFile(imagePath, content, { flag: "wx" });
    return { panelId: panel.id, path: imagePath, expectedSha256: sha256(content) };
  }));
  return {
    contract,
    images,
    outputPath: path.join(sampleRoot, `${name}.png`),
    svgOutputPath: path.join(sampleRoot, `${name}.svg`),
  };
}

function assertRenderedTextComplete(rendered: FusionStoryboardSheetRenderResult, contract: FusionStoryboardGridContract): void {
  assert(rendered.schemaVersion === 2
    && rendered.kind === "fusion-storyboard-sheet-render"
    && rendered.renderPurpose === "formal"
    && rendered.formalProductionEligible
    && rendered.renderPolicy.policyVersion === FUSION_STORYBOARD_SHEET_RENDER_POLICY_VERSION
    && rendered.renderPolicy.defaultImageFit === "contain"
    && rendered.renderPolicy.rowHeightPolicy === "dynamic-content-measured"
    && rendered.renderPolicy.silentTruncation === false
    && rendered.overflowReport.allRequiredTextVisible === true
    && rendered.overflowReport.silentTruncation === false
    && rendered.overflowReport.truncatedFields.length === 0
    && rendered.overflowReport.rows.length === contract.panels.length
    && rendered.overflowReport.rows.every((row) => row.textFields.length === 5
      && row.textFields.every((field) => field.complete && field.allocatedHeight >= field.requiredHeight)),
  `隔离 renderer 没有证明动态行高与五项中文字段无删字：${JSON.stringify(rendered.overflowReport)}`);
}

async function validateRendererFixtures(root: string): Promise<Record<string, unknown>> {
  const long = await createRendererSample(root, "two-panel-long-chinese", 2);
  const completeEnding = "【动作字段完整终点】";
  const longAction = `${"阿航沿封神榜裂隙边缘缓慢移动并观察金光与空间变化，".repeat(26)}${completeEnding}`;
  long.contract.panels[0]!.imageContentAction = longAction;
  long.contract.panels[0]!.tableFields.find((field) => field.key === "imageContentAction")!.value = longAction;
  const longRendered = await renderFusionStoryboardSheetV2({
    contract: long.contract,
    panelImages: long.images,
    outputPath: long.outputPath,
    svgOutputPath: long.svgOutputPath,
    renderPurpose: "formal",
  });
  assertRenderedTextComplete(longRendered, long.contract);
  const longField = longRendered.overflowReport.rows[0]!.textFields.find((field) => field.field === "imageContentAction");
  const longSvg = await readFile(long.svgOutputPath, "utf8");
  const longVisibleText = xmlVisibleText(longSvg);
  assert(longRendered.panelCount === 2
    && longRendered.height > 3_840
    && longRendered.overflowReport.expanded
    && longField
    && longField.lineCount > 20
    && longField.contentSha256 === sha256(longAction)
    && longVisibleText.includes(completeEnding)
    && !longSvg.includes("…")
    && longRendered.cropAudit.every((entry) => entry.fit === "contain" && entry.geometry === "none" && !entry.cropApplied),
  "2 格长中文 fixture 没有动态扩高、保留结尾或默认 contain。");

  const six = await createRendererSample(root, "six-panel-contain", 6);
  const firstSix = await renderFusionStoryboardSheetV2({
    contract: six.contract,
    panelImages: six.images,
    outputPath: six.outputPath,
    svgOutputPath: six.svgOutputPath,
    renderPurpose: "formal",
  });
  assertRenderedTextComplete(firstSix, six.contract);
  assert(firstSix.panelCount === 6
    && firstSix.pageCount === 1
    && firstSix.cropAudit.length === 6
    && firstSix.cropAudit.every((entry) => entry.fit === "contain" && entry.geometry === "none" && !entry.cropApplied),
  "6 格 fixture 未完整成板或发生了未授权裁切。");
  const sixSvg = await readFile(six.svgOutputPath, "utf8");
  const visibleWithoutWhitespace = xmlVisibleText(sixSvg).replace(/\s/gu, "");
  for (const panel of six.contract.panels) {
    for (const field of panel.tableFields.filter((entry) => entry.key !== "duration")) {
      assert(visibleWithoutWhitespace.includes(field.value.replace(/\s/gu, "")), `6 格 SVG 丢失中文字段：${panel.id}.${field.key}`);
    }
  }
  const beforeReplay = await Promise.all([stat(six.outputPath), stat(six.svgOutputPath)]);
  const replayedSix = await renderFusionStoryboardSheetV2({
    contract: six.contract,
    panelImages: six.images,
    outputPath: six.outputPath,
    svgOutputPath: six.svgOutputPath,
    renderPurpose: "formal",
  });
  const afterReplay = await Promise.all([stat(six.outputPath), stat(six.svgOutputPath)]);
  assert(replayedSix.reused
    && replayedSix.png.status === "existing"
    && replayedSix.svg.status === "existing"
    && replayedSix.png.sha256 === firstSix.png.sha256
    && replayedSix.svg.sha256 === firstSix.svg.sha256
    && JSON.stringify(beforeReplay.map((entry) => entry.mtimeMs)) === JSON.stringify(afterReplay.map((entry) => entry.mtimeMs)),
  "6 格 renderer 重放不幂等，或改写了已有内容寻址文件。");

  const crop = await createRendererSample(root, "two-panel-explicit-crop", 2);
  const cropped = await renderFusionStoryboardSheetV2({
    contract: crop.contract,
    panelImages: [
      { ...crop.images[0]!, imageTransform: { fit: "crop", focalPoint: { x: 0.25, y: 0.7 } } },
      { ...crop.images[1]!, imageTransform: { fit: "crop", rect: { x: 0.1, y: 0.2, width: 0.75, height: 0.6 } } },
    ],
    outputPath: crop.outputPath,
    svgOutputPath: crop.svgOutputPath,
    renderPurpose: "formal",
  });
  assertRenderedTextComplete(cropped, crop.contract);
  assert(cropped.cropAudit.length === 2
    && cropped.cropAudit[0]?.fit === "crop"
    && cropped.cropAudit[0]?.geometry === "focal-point"
    && cropped.cropAudit[0]?.cropApplied === true
    && cropped.cropAudit[0]?.focalPoint?.x === 0.25
    && cropped.cropAudit[0]?.focalPoint?.y === 0.7
    && cropped.cropAudit[0]?.appliedRect
    && cropped.cropAudit[0]?.appliedPixelRect
    && cropped.cropAudit[1]?.fit === "crop"
    && cropped.cropAudit[1]?.geometry === "rect"
    && cropped.cropAudit[1]?.cropApplied === true
    && JSON.stringify(cropped.cropAudit[1]?.requestedRect) === JSON.stringify({ x: 0.1, y: 0.2, width: 0.75, height: 0.6 })
    && cropped.cropAudit[1]?.appliedRect
    && cropped.cropAudit[1]?.appliedPixelRect,
  `显式 focal/rect crop 没有冻结完整实际像素审计：${JSON.stringify(cropped.cropAudit)}`);
  const cropSvg = await readFile(crop.svgOutputPath, "utf8");
  assert(cropSvg.includes("&quot;geometry&quot;:&quot;focal-point&quot;")
    && cropSvg.includes("&quot;geometry&quot;:&quot;rect&quot;")
    && cropSvg.includes("&quot;cropApplied&quot;:true"),
  "显式 crop 审计没有写入 SVG 机器元数据。");
  return {
    twoPanelLongChinese: {
      panelCount: longRendered.panelCount,
      width: longRendered.width,
      height: longRendered.height,
      expanded: longRendered.overflowReport.expanded,
      allRequiredTextVisible: longRendered.overflowReport.allRequiredTextVisible,
      truncatedFields: longRendered.overflowReport.truncatedFields,
      longFieldSha256: longField.contentSha256,
      completeEndingVisible: true,
      defaultContain: longRendered.cropAudit.every((entry) => entry.fit === "contain" && !entry.cropApplied),
      output: (({ bytes, sha256: fileSha256 }) => ({ bytes, sha256: fileSha256 }))(await fileEvidence(long.outputPath)),
      svg: (({ bytes, sha256: fileSha256 }) => ({ bytes, sha256: fileSha256 }))(await fileEvidence(long.svgOutputPath)),
    },
    sixPanel: {
      panelCount: firstSix.panelCount,
      pageCount: firstSix.pageCount,
      allRequiredTextVisible: firstSix.overflowReport.allRequiredTextVisible,
      defaultContain: true,
      everySourceFieldVisibleInSvg: true,
      idempotentReplay: replayedSix.reused,
      pngSha256: firstSix.png.sha256,
      svgSha256: firstSix.svg.sha256,
      mtimesUnchanged: true,
    },
    explicitCrop: {
      panelCount: cropped.panelCount,
      focalPointAudit: cropped.cropAudit[0],
      normalizedRectAudit: cropped.cropAudit[1],
      embeddedInSvgMetadata: true,
    },
  };
}

const ISOLATED_EXPECTED: FusionPackageExpectedCounts = {
  episodes: 1,
  units: 1,
  sourceShots: 2,
  scheduleRows: 3,
  assets: 3,
  characters: 1,
  scenes: 1,
  props: 1,
  standardDurationSeconds: 15,
};

async function createVerticalFixture(root: string): Promise<{
  sourceRoot: string;
  packageRoot: string;
  targetParent: string;
  authorityPath: string;
  authoritySha256: string;
  inspection: Awaited<ReturnType<typeof inspectFusionPackage>>;
}> {
  const sourceRoot = path.join(root, "vertical-source");
  const targetParent = path.join(root, "vertical-targets");
  const packageRoot = path.join(sourceRoot, "07_9x16_15秒融合制作包");
  const unitRelative = "蜀道山古蜀卷第三季_EP01_测试_9x16_漫剧/04_15秒融合分镜/EP01_15s_001_测试.md";
  await Promise.all([
    mkdir(path.join(packageRoot, path.dirname(unitRelative)), { recursive: true }),
    mkdir(path.join(sourceRoot, "05_提示词"), { recursive: true }),
    mkdir(path.join(sourceRoot, "01_剧本"), { recursive: true }),
    mkdir(targetParent, { recursive: true }),
  ]);
  const assets = `# 全季资产库

### C01 阿航

- **出场集数**：EP01
- **AI 出图提示词**：
  电影级写实青年。

### S01 山路

- **出场集数**：EP01
- **AI 出图提示词**：
  商周山路。

### P01 布囊

- **出场集数**：EP01
- **AI 出图提示词**：
  不透明素麻布囊。
`;
  const prompt = `# EP01 提示词

#### 镜01 [8s] 【中景】（24帧）
**参考素材**：@C01 阿航、@S01 山路
【参考】@图片1=C01，@图片2=S01。

#### 镜02 [5s] 【特写】（24帧）
**参考素材**：@C01 阿航、@P01 布囊
【参考】@图片1=C01，@图片2=P01。
`;
  const unitMarkdown = `# EP01 15s-001｜测试

## 3. 机位 / 焦段 / 运镜

| 原镜 | 景别 | 焦段 | 机位 | 运镜 | 帧率 | 备注 |
|---|---|---|---|---|---|---|
| 镜01 | 中景 | 50mm | 平视 | 侧移 | 24 | 起幅 |
| 镜02 | 特写 | 85mm | 低机位 | 跟随 | 24 | 收束 |

## 4. 人物 / 道具站位

参考 C01、S01、P01。

## 7. 首帧生图提示词

电影级写实，9:16，阿航站在山路起幅。

## 8. 图生视频中文提示词

按时间段执行。

### 原镜01 视频提示词

参考素材：@C01、@S01。
电影级写实，阿航沿山路行进。
尾帧：阿航走到山路转角。

### 原镜02 视频提示词

参考素材：@C01、@P01。
电影级写实，阿航按住不透明布囊。
尾帧：布囊保持不透明，阿航停步。

## 9. 生成注意事项

禁止露出内部物品。
`;
  const units = [{
    id: "EP01_15s_001",
    episode: "EP01",
    episode_title: "测试",
    unit_title: "测试",
    md_path: unitRelative,
    source_script: "01_剧本/第三季_EP01_测试.md",
    source_prompt_table: "05_提示词/第三季_EP01_提示词表.md",
    source_shots: [1, 2],
    source_duration_seconds: 13,
    standard_duration_seconds: 15,
    aspect_ratio: "9:16",
    story_goal: "测试连续性",
    schedule: [
      { start: 0, end: 8, shot: "镜01", seconds: 8, content: "阿航沿山路行进" },
      { start: 8, end: 13, shot: "镜02", seconds: 5, content: "阿航按住布囊" },
      { start: 13, end: 15, shot: "扩写补足", seconds: 2, content: "动作收束，不新增剧情" },
    ],
    asset_ids: ["C01", "S01", "P01"],
    reference_image_paths: [],
    validation: { source_order_preserved: true, source_duration_lte_15: true, no_compression: true },
  }];
  await Promise.all([
    writeFile(path.join(packageRoot, "15s_fused_units.json"), `${JSON.stringify(units, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
    writeFile(path.join(packageRoot, unitRelative), unitMarkdown, { encoding: "utf8", flag: "wx" }),
    writeFile(path.join(sourceRoot, "05_提示词", "00_全季资产库.md"), assets, { encoding: "utf8", flag: "wx" }),
    writeFile(path.join(sourceRoot, "05_提示词", "第三季_EP01_提示词表.md"), prompt, { encoding: "utf8", flag: "wx" }),
    writeFile(path.join(sourceRoot, "01_剧本", "第三季_EP01_测试.md"), "# EP01 测试剧本\n", { encoding: "utf8", flag: "wx" }),
  ]);
  const authorityPath = path.join(root, "fixture-authority.jpg");
  const authorityBytes = await sharp(await deterministicPng(900, 1_600, 91)).jpeg({ quality: 90 }).toBuffer();
  await writeFile(authorityPath, authorityBytes, { flag: "wx" });
  const authoritySha256 = sha256(authorityBytes);
  const inspection = await inspectFusionPackage({ packageRoot, sourceRoot, expectedCounts: ISOLATED_EXPECTED });
  return { sourceRoot, packageRoot, targetParent, authorityPath, authoritySha256, inspection };
}

async function validateVerticalCurrentFixture(root: string): Promise<Record<string, unknown>> {
  const data = await createVerticalFixture(root);
  const authorities = (["C01", "S01", "P01"] as const).map((assetId) => ({
    id: `authority-${assetId.toLowerCase()}`,
    assetId,
    name: `${assetId} 隔离权威图`,
    sourcePath: data.authorityPath,
    expectedSha256: data.authoritySha256,
    rules: ["隔离 fixture 硬锁"],
    exposeToGeneration: true,
  }));
  const created = await materializeFusionProject({ inspection: data.inspection, targetParent: data.targetParent, authorities });
  const unitId = EP01_001;
  const initialIndex = await scanAndPersist(created.targetRoot);
  await buildFusionReferenceBoard(created.targetRoot, initialIndex, unitId, "start");
  await buildFusionReferenceBoard(created.targetRoot, initialIndex, unitId, "end");
  const automatic = await buildFusionStoryboardGridForProject(created.targetRoot, unitId);
  const contract = await buildFusionStoryboardGridForProject(created.targetRoot, unitId, {
    override: {
      panelCount: 2,
      expectedRevision: automatic.sourceStoryboardRevision,
      reason: "P4 final 隔离 current 成板与 Scanner 权威回归",
    },
  });
  await materializeFusionPanelReferenceResolutions(created.targetRoot);
  await materializeFusionPanelVisualConstraints(created.targetRoot);
  const jobs: GenerationJob[] = [];
  for (const panel of contract.panels) {
    const job = await enqueueFusionStoryboardPanel(created.targetRoot, {
      itemId: unitId,
      contractId: contract.contractId,
      panelIndex: panel.index,
    });
    const raw = await deterministicPng(720, 1_280, 120 + panel.index);
    const labeled = await deterministicPng(720, 1_280, 180 + panel.index);
    await Promise.all([
      writeFile(job.expectedOutputPath, raw, { flag: "wx" }),
      writeFile(job.expectedCompanionPath!, labeled, { flag: "wx" }),
    ]);
    const intent = await getPublicationIntent(created.targetRoot, job.publicationIntentId!);
    assert(intent, `隔离 fixture 缺少宫格 ${panel.index} PublicationIntent。`);
    let publicationReceiptId: string;
    let companionPublicationReceiptId: string | undefined;
    if (job.publicationBundleId) {
      assert(job.companionPublicationIntentId && job.companionPublicationReservationToken,
        `隔离 fixture 宫格 ${panel.index} bundle 缺少 companion PublicationIntent。`);
      const companionIntent = await getPublicationIntent(created.targetRoot, job.companionPublicationIntentId);
      assert(companionIntent, `隔离 fixture 缺少宫格 ${panel.index} companion PublicationIntent。`);
      const registered = await registerPublicationBundle(created.targetRoot, {
        bundleId: job.publicationBundleId,
        members: [
          { member: "primary", intentId: intent.id, reservationToken: job.publicationReservationToken!, expectedRevision: intent.revision },
          { member: "companion", intentId: companionIntent.id, reservationToken: job.companionPublicationReservationToken, expectedRevision: companionIntent.revision },
        ],
      });
      const primaryReceipt = registered.receipts.find((entry) => entry.bundleMember === "primary");
      const companionReceipt = registered.receipts.find((entry) => entry.bundleMember === "companion");
      assert(primaryReceipt && companionReceipt, `隔离 fixture 宫格 ${panel.index} 没有形成 raw/labeled 双回执。`);
      publicationReceiptId = primaryReceipt.id;
      companionPublicationReceiptId = companionReceipt.id;
    } else {
      const receipt = await registerPublication(created.targetRoot, {
        intentId: intent.id,
        reservationToken: intent.reservationToken,
        expectedRevision: intent.revision,
      });
      publicationReceiptId = receipt.id;
    }
    job.status = "succeeded";
    job.resultPath = job.expectedOutputPath;
    job.resultSha256 = sha256(raw);
    job.companionPath = job.expectedCompanionPath;
    job.publicationReceiptId = publicationReceiptId;
    job.companionPublicationReceiptId = companionPublicationReceiptId;
    job.updatedAt = new Date(Date.now() + panel.index).toISOString();
    jobs.push(job);
  }
  const sidecar = getSidecarPaths(created.targetRoot);
  const storedJobs = await readJson<GenerationJob[]>(sidecar.generationJobs, []);
  const completedById = new Map(jobs.map((job) => [job.id, job]));
  await writeFile(sidecar.generationJobs, `${JSON.stringify(storedJobs.map((job) => completedById.get(job.id) ?? job), null, 2)}\n`, "utf8");
  await scanAndPersist(created.targetRoot);
  const indexed = await scanAndPersist(created.targetRoot, { includeHashes: true });
  const reviewEntry = (await getReviewQueue(created.targetRoot)).find((entry) => entry.item.id === unitId);
  assert(reviewEntry?.reviewRequirement?.complete === true
    && reviewEntry.reviewRequirement.panelCount === 2
    && reviewEntry.reviewRequirement.artifactIds.length === 4,
  `隔离 fixture 没有形成 2 格 / 4 artifact 完整 Review requirement：${JSON.stringify(reviewEntry?.reviewRequirement)}`);
  const visualConstraintAttestations = reviewEntry.reviewRequirement.panels.flatMap((panel) =>
    (panel.visualReviewRules ?? []).map((rule) => ({
      panelId: panel.panelId,
      constraintId: panel.panelVisualConstraintId!,
      reviewRulesFingerprint: panel.panelVisualReviewRulesFingerprint!,
      ruleId: rule.id,
      result: "pass" as const,
      note: "隔离确定性 fixture 逐格逐规则通过；不是正式工程 Review。",
    })),
  );
  const criteria = ([
    "character_identity", "hard_lock", "prop_costume", "scene_continuity",
    "composition", "image_quality", "raw_labeled_pair",
  ] as ReviewCriterionKey[]).map((key) => ({ key, result: "pass" as const }));
  const reviewed = await submitReview(created.targetRoot, {
    itemId: unitId,
    reviewType: "image",
    artifactIds: reviewEntry.reviewRequirement.artifactIds,
    expectedScanId: reviewEntry.reviewSnapshot.scanId,
    expectedArtifactHashes: reviewEntry.reviewRequirement.artifactHashes,
    expectedRequirementId: reviewEntry.reviewRequirement.id,
    visualConstraintAttestations,
    decision: "pass",
    criteria,
  });
  const ready = await getFusionStoryboardSheetState(created.targetRoot, { itemId: unitId, contractId: contract.contractId });
  assert(ready.currentSheetId === undefined
    && ready.readiness.canRender
    && SHA256_PATTERN.test(ready.readiness.expectedInputFingerprint ?? "")
    && /^sheet-v2-[a-f0-9]{32}$/u.test(ready.readiness.expectedSheetId ?? "")
    && ready.readiness.reviewId === reviewed.record.id,
  `隔离 fixture 在显式 P3 Review 后没有签发 expectedInputFingerprint：${JSON.stringify(ready.readiness)}`);
  const renderInput = {
    itemId: unitId,
    contractId: contract.contractId,
    expectedInputFingerprint: ready.readiness.expectedInputFingerprint!,
  };
  const first = await renderCompletedFusionStoryboardSheetForProject(created.targetRoot, renderInput);
  const replay = await renderCompletedFusionStoryboardSheetForProject(created.targetRoot, renderInput);
  assert(first.sheetId === ready.readiness.expectedSheetId
    && first.inputFingerprint === ready.readiness.expectedInputFingerprint
    && first.panelCount === 2
    && first.reviewId === reviewed.record.id
    && replay.sheetId === first.sheetId
    && replay.reused
    && replay.png.sha256 === first.png.sha256
    && replay.svg.sha256 === first.svg.sha256,
  `隔离 current 成板没有保持内容寻址幂等：${JSON.stringify({ first, replay })}`);
  const currentState = await getFusionStoryboardSheetState(created.targetRoot, { itemId: unitId, contractId: contract.contractId });
  const listed = await listFusionStoryboardSheets(created.targetRoot, { itemId: unitId });
  const store = await loadFusionStoryboardSheetStore(created.targetRoot);
  assert(currentState.currentSheetId === first.sheetId
    && currentState.versions.length === 1
    && currentState.versions[0]?.status === "current"
    && listed.total === 1
    && listed.items[0]?.status === "current"
    && store.revision === 1
    && Object.keys(store.records).length === 1
    && store.currentByItemId[unitId]?.sheetId === first.sheetId,
  `隔离成板未成为 store/list/state 唯一 current：${JSON.stringify({ currentState, listed, store })}`);

  const postRenderIndex = await loadIndex(created.targetRoot);
  assert(postRenderIndex, "隔离成板后未落盘扫描索引。");
  const currentArtifacts = postRenderIndex.artifacts.filter((artifact) => artifact.fusionStoryboardSheet?.sheetId === first.sheetId);
  assert(currentArtifacts.length === 3
    && new Set(currentArtifacts.map((artifact) => artifact.fusionStoryboardSheet!.role)).size === 3
    && currentArtifacts.every((artifact) => artifact.fusionStoryboardSheet?.status === "current"
      && artifact.authoritative && artifact.accepted && artifact.check.ok),
  `Scanner 没有只把隔离 current PNG/SVG/receipt 标记为权威：${JSON.stringify(currentArtifacts)}`);

  const unit = indexed.items.find((entry) => entry.id === unitId);
  assert(unit?.infoPath, "隔离 fixture 缺少单元 infoPath。");
  const orphanPath = path.join(path.dirname(unit.infoPath), "AI画布生成", "EP01_15s_001_中文分镜板_orphan.png");
  await mkdir(path.dirname(orphanPath), { recursive: true });
  await writeFile(orphanPath, await deterministicPng(720, 1_280, 233), { flag: "wx" });
  const withOrphan = await scanProject({ projectRoot: created.targetRoot, persist: false, includeHashes: true });
  const orphan = withOrphan.artifacts.find((artifact) => path.resolve(artifact.path) === path.resolve(orphanPath));
  const currentAfterOrphan = withOrphan.artifacts.filter((artifact) => artifact.fusionStoryboardSheet?.sheetId === first.sheetId);
  assert(orphan?.fusionStoryboardSheet?.status === "invalid"
    && orphan.fusionStoryboardSheet.reasons.includes("orphan-sheet-file-not-registered-in-p4-store")
    && orphan.authoritative === false
    && orphan.accepted === false
    && currentAfterOrphan.length === 3
    && currentAfterOrphan.every((artifact) => artifact.fusionStoryboardSheet?.status === "current" && artifact.authoritative),
  `Scanner 未把 orphan 失败关闭，或 orphan 抢占了 current 权威：${JSON.stringify({ orphan, currentAfterOrphan })}`);

  const rawBeforeDrift = await fileEvidence(jobs[0]!.resultPath!);
  await writeFile(jobs[0]!.resultPath!, await deterministicPng(720, 1_280, 244));
  const driftedState = await getFusionStoryboardSheetState(created.targetRoot, { itemId: unitId, contractId: contract.contractId });
  assert(driftedState.currentSheetId === undefined
    && driftedState.readiness.canRender === false
    && driftedState.readiness.expectedInputFingerprint === undefined
    && driftedState.versions.length === 1
    && driftedState.versions[0]?.status === "stale",
  `输入 raw 漂移后旧板没有立即 stale：${JSON.stringify(driftedState)}`);
  let staleFingerprintRejected = false;
  try {
    await renderCompletedFusionStoryboardSheetForProject(created.targetRoot, renderInput);
  } catch (error) {
    staleFingerprintRejected = /Review requirement|门禁|fingerprint|证据/u.test(error instanceof Error ? error.message : String(error));
  }
  assert(staleFingerprintRejected, "输入漂移后旧 expectedInputFingerprint 没有失败关闭。");
  const afterDriftScan = await scanProject({ projectRoot: created.targetRoot, persist: false, includeHashes: true });
  const staleArtifacts = afterDriftScan.artifacts.filter((artifact) => artifact.fusionStoryboardSheet?.sheetId === first.sheetId);
  const orphanAfterDrift = afterDriftScan.artifacts.find((artifact) => path.resolve(artifact.path) === path.resolve(orphanPath));
  assert(staleArtifacts.length === 3
    && staleArtifacts.every((artifact) => artifact.fusionStoryboardSheet?.status === "stale" && !artifact.authoritative && !artifact.accepted)
    && orphanAfterDrift?.fusionStoryboardSheet?.status === "invalid"
    && !orphanAfterDrift.authoritative,
  `Scanner 在输入漂移后仍把 stale/orphan 当权威：${JSON.stringify({ staleArtifacts, orphanAfterDrift })}`);
  const finalStore = await loadFusionStoryboardSheetStore(created.targetRoot);
  assert(finalStore.revision === 1 && Object.keys(finalStore.records).length === 1,
    "输入漂移和旧指纹拒绝不得增加或覆盖隔离 sheet 记录。");
  return {
    projectKind: "isolated-temporary-fusion-project",
    panelCount: contract.selection.panelCount,
    review: {
      id: reviewed.record.id,
      requirementId: reviewEntry.reviewRequirement.id,
      explicitVisualRuleAttestations: visualConstraintAttestations.length,
      note: "仅隔离 fixture；未写入正式第三季 Review store。",
    },
    current: {
      sheetId: first.sheetId,
      inputFingerprint: first.inputFingerprint,
      recordFingerprint: first.recordFingerprint,
      storeRevision: first.storeRevision,
      artifacts: currentArtifacts.map((artifact) => ({
        role: artifact.fusionStoryboardSheet!.role,
        status: artifact.fusionStoryboardSheet!.status,
        authoritative: artifact.authoritative,
        accepted: artifact.accepted,
        sha256: artifact.check.sha256,
      })),
    },
    idempotentReplay: {
      reused: replay.reused,
      sameSheetId: replay.sheetId === first.sheetId,
      samePngSha256: replay.png.sha256 === first.png.sha256,
      sameSvgSha256: replay.svg.sha256 === first.svg.sha256,
    },
    orphan: {
      status: orphan.fusionStoryboardSheet.status,
      authoritative: orphan.authoritative,
      accepted: orphan.accepted,
      reasons: orphan.fusionStoryboardSheet.reasons,
    },
    drift: {
      sourceRawBeforeSha256: rawBeforeDrift.sha256,
      sourceRawAfterSha256: await sha256File(jobs[0]!.resultPath!),
      currentAfterDrift: 0,
      oldSheetStatus: driftedState.versions[0]!.status,
      oldExpectedInputFingerprintRejected: staleFingerprintRejected,
      scannerAuthoritativeAfterDrift: staleArtifacts.filter((artifact) => artifact.authoritative).length,
      storeRevisionUnchanged: finalStore.revision === 1,
    },
  };
}

async function validateIsolatedFixture(): Promise<Record<string, unknown>> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p4-final-fixture-"));
  let result: Record<string, unknown> | undefined;
  try {
    const [renderer, vertical] = await Promise.all([
      validateRendererFixtures(root),
      validateVerticalCurrentFixture(root),
    ]);
    result = {
      rootKind: "exclusive-mkdtemp-under-os-tmpdir",
      productionProjectTouched: false,
      browserOrVendorInvoked: false,
      externalGenerationInvoked: false,
      renderer,
      vertical,
    };
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
    if (result) result.cleaned = !await exists(root);
  }
}

function baseFileEvidence(value: FileEvidence): FileEvidence {
  return { path: value.path, bytes: value.bytes, sha256: value.sha256 };
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
  const [sourceBefore, codeBefore, planningBefore] = await Promise.all([
    inventorySnapshot(input.sourceRoot, { includeMtime: true }),
    workspaceSourceDigest(input.workspace),
    validatePlanningAttestation(input.workspace),
  ]);
  assert(sourceBefore.files === EXPECTED_SOURCE.files
    && sourceBefore.bytes === EXPECTED_SOURCE.bytes
    && sourceBefore.aggregateSha256 === EXPECTED_SOURCE.aggregateSha256,
  `第三季只读源偏离 3344 文件 / 24570877 bytes 正式基线：${JSON.stringify(sourceBefore)}`);

  const [guardedBefore, formalBefore, p2Snapshot, p2StrictBefore, p3Store, p3CurrentBefore] = await Promise.all([
    guardedFormalState(input.projectRoot),
    validateFormalState(input),
    loadFusionPanelReferenceStoreSnapshot(input.projectRoot),
    inspectFusionPanelReferenceCurrentness(input.projectRoot, { verifyAllContractFiles: true }),
    loadFusionPanelVisualConstraintStore(input.projectRoot),
    inspectFusionPanelVisualConstraintCurrentness(input.projectRoot),
  ]);
  assert(p2Snapshot
    && p2Snapshot.currentness.current
    && p2StrictBefore.current
    && p2Snapshot.store.revision === 2
    && p2Snapshot.store.audit.closurePassed
    && p2Snapshot.store.audit.currentContracts === 1_288
    && p2Snapshot.store.audit.panels === 4_330
    && p2Snapshot.store.storeFingerprint === p2StrictBefore.storeFingerprint
    && p2StrictBefore.driftedInputs.length === 0,
  `P4 关账前 P2 不是 revision 2 / 1288 contracts / 4330 panels 严格 current 闭包：${JSON.stringify({ snapshot: p2Snapshot?.currentness, strict: p2StrictBefore, audit: p2Snapshot?.store.audit })}`);
  assert(p3Store
    && p3CurrentBefore.current
    && p3Store.revision === 1
    && p3Store.audit.closurePassed
    && p3Store.audit.contracts === 1_288
    && p3Store.audit.expectedPanels === 4_330
    && p3Store.audit.constraints === 4_330
    && p3Store.audit.missingConstraints === 0
    && p3Store.audit.invalidConstraints === 0
    && p3Store.audit.modelPromptLeakPanels === 0
    && p3Store.audit.modelPathLeakPanels === 0
    && p3Store.audit.concealedMaskPanels === 304
    && p3Store.audit.revealAuthorizedPanels === 0
    && p3Store.storeFingerprint === p3CurrentBefore.storeFingerprint
    && p3CurrentBefore.driftedInputs.length === 0,
  `P4 关账前 P3 不是 revision 1 / 1288 contracts / 4330 constraints 当前闭包：${JSON.stringify({ currentness: p3CurrentBefore, audit: p3Store?.audit })}`);
  assert(guardedBefore.requests.files === 31
    && guardedBefore.requests.bytes === 174_082
    && guardedBefore.requests.aggregateSha256 === "171ca4fd131b977f07f7bbb5e44bfd836a1158ce63c6bcaff721b45f95b1fbca"
    && guardedBefore.downloads.files === 26
    && guardedBefore.downloads.bytes === 55_357_407
    && guardedBefore.downloads.aggregateSha256 === "ccfd0599ac21da61f79bee1538de3f7faea54d156c05f594181f0d5437849dc8"
    && guardedBefore.subagentStaging.files === 36
    && guardedBefore.subagentStaging.bytes === 68_776_407
    && guardedBefore.subagentStaging.aggregateSha256 === "6f1b769092934ca3f35fe94a7cffca1c5e5e510d4a10f1dbbfec0883fb943c95"
    && guardedBefore.rawLabeled.files === 52
    && guardedBefore.rawLabeled.bytes === 128_973_009
    && guardedBefore.rawLabeled.aggregateSha256 === "77d4a46fa04c05c635701363f394faab0cc5094fc437990f6eeb580ce0e4c83b"
    && guardedBefore.sheetArtifacts.length === 4,
  `正式 request/download/staging/raw+labeled/历史成板清单偏离 P3/P4 基线：${JSON.stringify({ requests: guardedBefore.requests, downloads: guardedBefore.downloads, subagentStaging: guardedBefore.subagentStaging, rawLabeled: guardedBefore.rawLabeled, sheetArtifacts: guardedBefore.sheetArtifacts.length })}`);

  const externalEvidence = await validateExternalEvidence(input, guardedBefore, formalBefore);
  const currentGlobalMigrationFingerprint = String((formalBefore.ledger.migrationPreview as Record<string, unknown>).candidateFingerprint ?? "");
  assert(externalEvidence.migrationCandidateFingerprint === currentGlobalMigrationFingerprint
    && externalEvidence.mcpToolCount === EXPECTED_TOOL_COUNT,
  "外部 migration/MCP 证据与当前全局正式迁移候选指纹或 release manifest 能力不同一。");
  const externalFilesBefore = [
    externalEvidence.migration,
    externalEvidence.mcp,
    externalEvidence.ui,
    ...externalEvidence.screenshots.map(baseFileEvidence),
  ];
  const isolatedFixture = await validateIsolatedFixture();
  assert(isolatedFixture.cleaned === true
    && isolatedFixture.productionProjectTouched === false
    && isolatedFixture.browserOrVendorInvoked === false
    && isolatedFixture.externalGenerationInvoked === false,
  `隔离 current/renderer fixture 未完整清理或越过正式/外部边界：${JSON.stringify(isolatedFixture)}`);

  const commandRuns = await runCloseoutCommands(input);
  const liveRunEvidence = await validateReadOnlyRunOutputs(commandRuns);
  const runLogInventory = await inventorySnapshot(input.runRoot);
  assert(Object.keys(commandRuns).length === 7
    && Object.values(commandRuns).every((run) => run.exitCode === 0
      && !run.termination.timedOut
      && !run.termination.spawnError
      && isInside(input.runRoot, run.stdout.path)
      && isInside(input.runRoot, run.stderr.path))
    && new Set(Object.values(commandRuns).flatMap((run) => [run.stdout.path, run.stderr.path])).size === 14
    && runLogInventory.files === 14,
  `七项真实命令没有形成 14 个唯一、成功、内联 SHA 日志：${JSON.stringify({ commands: Object.keys(commandRuns), runLogInventory })}`);

  const [sourceAfter, codeAfter, planningAfter, guardedAfter, formalAfter, p2StrictAfter, p3StoreAfter, p3CurrentAfter, compiledMcpServerAfter, ...externalFilesAfter] = await Promise.all([
    inventorySnapshot(input.sourceRoot, { includeMtime: true }),
    workspaceSourceDigest(input.workspace),
    validatePlanningAttestation(input.workspace),
    guardedFormalState(input.projectRoot),
    validateFormalState(input),
    inspectFusionPanelReferenceCurrentness(input.projectRoot, { verifyAllContractFiles: true }),
    loadFusionPanelVisualConstraintStore(input.projectRoot),
    inspectFusionPanelVisualConstraintCurrentness(input.projectRoot),
    fileEvidence(path.join(input.workspace, "dist-mcp", "mcp", "server.js")),
    fileEvidence(input.migrationEvidencePath),
    fileEvidence(input.mcpEvidencePath),
    fileEvidence(input.uiEvidencePath),
    ...input.uiScreenshotPaths.map(fileEvidence),
  ]);
  assert(JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore), "P4 关账期间第三季只读源发生变化。");
  assert(JSON.stringify(codeAfter) === JSON.stringify(codeBefore), "P4 关账期间 src/tests/scripts/package/config 源码集合发生变化。");
  assert(JSON.stringify(planningAfter) === JSON.stringify(planningBefore), "P4 关账期间 gated planning 或 attestation 发生变化。");
  assert(guardedAfter.identitySha256 === guardedBefore.identitySha256
    && JSON.stringify(guardedAfter) === JSON.stringify(guardedBefore),
  "P4 关账命令改写了正式 sidecar、历史 request/download/staging、raw/labeled 或成板文件。");
  assert(formalSemanticIdentity(formalAfter) === formalSemanticIdentity(formalBefore),
    "P4 关账前后正式 store/state/Scanner/ledger 语义漂移。");
  assert(p2StrictAfter.current
    && p2StrictAfter.storeRevision === p2StrictBefore.storeRevision
    && p2StrictAfter.storeFingerprint === p2StrictBefore.storeFingerprint
    && p2StrictAfter.driftedInputs.length === 0
    && p3StoreAfter
    && p3CurrentAfter.current
    && p3StoreAfter.revision === p3Store.revision
    && p3StoreAfter.storeFingerprint === p3Store.storeFingerprint
    && p3StoreAfter.audit.auditFingerprint === p3Store.audit.auditFingerprint
    && p3CurrentAfter.storeFingerprint === p3CurrentBefore.storeFingerprint
    && p3CurrentAfter.driftedInputs.length === 0,
  "P4 关账期间 P2/P3 当前性、store 或 audit 漂移。");
  assert(JSON.stringify(externalFilesAfter) === JSON.stringify(externalFilesBefore),
    "P4 关账期间 migration/MCP/UI/截图外部证据发生变化。");
  assert(compiledMcpServerAfter.bytes > 100_000 && SHA256_PATTERN.test(compiledMcpServerAfter.sha256),
    `production build 没有形成可用 compiled MCP server：${JSON.stringify(compiledMcpServerAfter)}`);

  const endedAt = new Date().toISOString();
  const assertions = {
    source3344Files24570877BytesAndAggregateShaExact: true,
    sourceUnchangedDuringValidation: true,
    sourceCodeDigestStableDuringValidation: true,
    gatedP4PlanningAttestationValidAndStable: true,
    p2StrictCurrentBeforeAndAfterWith1288Contracts4330Panels: true,
    p3CurrentBeforeAndAfterWith1288Contracts4330Constraints: true,
    formalP4StoreRevisionOneWithZeroCurrentAndTwoHistorical: true,
    persistedScannerProjectionMatchesReadOnlyRescanExactly: true,
    scannerHasFourNonAuthoritativeHistoricalArtifacts: true,
    ep01Unit001CurrentZeroWithStaleAndLegacyInvalid: true,
    ep01Unit001NoFabricatedP3ReviewAndTwentyEightRulesRemainRequired: true,
    ep01Unit008CurrentZeroFourOfSixUnknownPlusMissing: true,
    unknownPanelFiveAttemptAndReservedPublicationBundleRemainUnclaimed: true,
    thirtyJobs31Intents26ReceiptsAnd52RawLabeledFilesPreserved: true,
    migrationEvidenceAndTwoFreshReadOnlyPreviewsAreIdempotent: true,
    compiledMcpDiscoversExactly178ToolsWithoutWrites: true,
    existingMcpEvidenceMatchesCurrentFormalState: true,
    uiEvidenceAndTwoDecodableScreenshotsMatchCurrentFormalState: true,
    uiReportedZeroExternalRequestsInItsPostFirstWindowObservationInterval: true,
    uiStartupNetworkWasNotOverclaimedByThisValidator: true,
    twoAndSixPanelLongChineseContainAndExplicitCropFixturesPassed: true,
    isolatedCurrentReceiptStoreScannerAndIdempotentReplayPassed: true,
    isolatedOrphanInputDriftAndOldFingerprintFailClosed: true,
    crashReconcileCropRetentionLegacyTamperAndPathContainmentRegressionsPassed: true,
    companionReceiptIndependentValidationRegressionPassed: true,
    storyboardInfoPathRealpathAndSymlinkFailClosedRegressionPassed: true,
    uiEvidenceGuardIncludesFormalProjectIndex: true,
    formalSidecarRequestsDownloadsStagingMediaAndSheetArtifactsUnchanged: true,
    externalEvidenceFilesStableDuringCloseout: true,
    allSevenCommandRunsExitedZeroWithFourteenExclusiveShaBoundLogs: true,
  };
  assert(Object.values(assertions).every((value) => value === true), "P4 final 仍有未通过断言。");
  const evidence = {
    schemaVersion: 1,
    kind: "p4-storyboard-sheet-final-validation",
    createdAt: endedAt,
    validationWindow: { startedAt, endedAt },
    invocation: { argv: [process.execPath, ...process.argv.slice(1)], cwd: process.cwd() },
    workspace: input.workspace,
    projectRoot: input.projectRoot,
    sourceRoot: input.sourceRoot,
    runRoot: input.runRoot,
    source: { before: sourceBefore, after: sourceAfter, unchanged: true },
    sourceCode: { before: codeBefore, after: codeAfter, unchanged: true },
    planning: { before: planningBefore, after: planningAfter, unchanged: true },
    priorGates: {
      p2: {
        revision: p2Snapshot.store.revision,
        storeFingerprint: p2Snapshot.store.storeFingerprint,
        auditFingerprint: p2Snapshot.store.audit.auditFingerprint,
        audit: p2Snapshot.store.audit,
        currentnessBefore: p2StrictBefore,
        currentnessAfter: p2StrictAfter,
      },
      p3: {
        revision: p3Store.revision,
        storeFingerprint: p3Store.storeFingerprint,
        audit: p3Store.audit,
        currentnessBefore: p3CurrentBefore,
        currentnessAfter: p3CurrentAfter,
      },
    },
    formal: {
      store: formalBefore.store,
      ep01_001: formalBefore.state001,
      ep01_008: formalBefore.state008,
      scanner: formalBefore.scanner,
      ledger: formalBefore.ledger,
      sheetArtifacts: formalBefore.sheetArtifacts,
      semanticIdentityBefore: formalSemanticIdentity(formalBefore),
      semanticIdentityAfter: formalSemanticIdentity(formalAfter),
      unchanged: true,
    },
    guardedFormalState: { before: guardedBefore, after: guardedAfter, unchanged: true },
    externalEvidence: {
      ...externalEvidence,
      uiNetworkObservationScope: {
        observedExternalRequests: 0,
        coverage: "listeners-installed-after-first-window",
        provesFullStartupNetworkSilence: false,
        claim: "只声明 UI smoke 记录区间内零外网；不把旧证据升级为启动期完整零外网证明。",
      },
    },
    externalEvidenceFiles: { before: externalFilesBefore, after: externalFilesAfter, unchanged: true },
    isolatedFixture,
    compiledMcpServer: {
      afterProductionBuild: compiledMcpServerAfter,
      exercisedByReadOnlyMcpRun: commandRuns.mcpReadOnly!.argv,
      toolCount: EXPECTED_TOOL_COUNT,
    },
    commandRuns,
    runLogInventory,
    liveRunEvidence,
    productionFreeze: {
      enabled: true,
      formalProjectWritesByValidator: false,
      scannerMode: "read-only-rescan-must-match-preexisting-persisted-projection",
      browserOrVendorInvokedByValidator: false,
      imageGenerationInvokedByValidator: false,
      reviewSubmittedToFormalProject: false,
      unknownJobClaimedOrRetried: false,
      guardedIdentityUnchanged: true,
    },
    assertions,
  };
  const created = await writeJsonAtomicExclusive(input.evidencePath, evidence);
  assert(created === "created", `最终证据未独占创建：${input.evidencePath}`);
  process.stdout.write(`${JSON.stringify({
    passed: true,
    evidencePath: input.evidencePath,
    runRoot: input.runRoot,
    sourceCode: codeAfter,
    p4: {
      storeRevision: formalBefore.store.revision,
      current: Object.keys(formalBefore.store.currentByItemId).length,
      historical: Object.keys(formalBefore.store.legacyRecords).length,
      scanner: formalBefore.scanner,
    },
    tests: { targeted: commandRuns.targeted?.testSummary, full: commandRuns.full?.testSummary },
    mcpTools: EXPECTED_TOOL_COUNT,
    assertions,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
