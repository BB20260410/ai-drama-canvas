import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import fg from "fast-glob";
import sharp from "sharp";
import { createStudioCanonicalAsset } from "../src/core/material-studio.js";
import { createManagedProject } from "../src/core/managed-project.js";
import { analyzeStudioScriptEntities, getStudioBindingControl } from "../src/core/studio-binding-control.js";
import {
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  type StudioAssetCategory,
} from "../src/core/studio-production.js";

function parseCliArguments(argv: string[]): {
  positional: string[];
  uiEvidenceArgument: string;
} {
  const positional: string[] = [];
  let uiEvidenceArgument: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--ui-evidence") {
      assert(uiEvidenceArgument === undefined, "--ui-evidence 不得重复传入。");
      uiEvidenceArgument = argv[index + 1];
      assert(typeof uiEvidenceArgument === "string" && uiEvidenceArgument.length > 0,
        "--ui-evidence 必须紧跟不可变 P6 UI smoke JSON 路径。");
      index += 1;
      continue;
    }
    if (argument.startsWith("--ui-evidence=")) {
      assert(uiEvidenceArgument === undefined, "--ui-evidence 不得重复传入。");
      uiEvidenceArgument = argument.slice("--ui-evidence=".length);
      assert(uiEvidenceArgument.length > 0, "--ui-evidence 不得为空。");
      continue;
    }
    assert(!argument.startsWith("--"), `未知参数：${argument}`);
    positional.push(argument);
  }
  assert(positional.length <= 5,
    `P6 final validator 仅接受 workspace/project/source/output/runRoot 五个位置参数：${JSON.stringify(positional)}`);
  assert(typeof uiEvidenceArgument === "string" && uiEvidenceArgument.length > 0,
    "必须用 --ui-evidence <p6-binding-workbench-ui-smoke-YYYYMMDD-04-or-newer.json> 显式传入最新不可变 UI smoke。");
  return { positional, uiEvidenceArgument };
}

const cli = parseCliArguments(process.argv.slice(2));
const workspace = await realpath(path.resolve(cli.positional[0] ?? "/Users/hxx/Documents/无限画布"));
const projectRoot = await realpath(path.resolve(cli.positional[1] ?? path.join(workspace, "projects", "codex-ai-drama-studio")));
const sourceRoot = await realpath(path.resolve(cli.positional[2] ?? "/Users/hxx/Documents/古蜀卷第三季"));
const evidenceRoot = path.join(workspace, "docs", "evidence");
const outputPath = path.resolve(cli.positional[3] ?? path.join(evidenceRoot, "final-validation-20260718-p6-asset-binding.json"));
const runRoot = path.resolve(cli.positional[4] ?? path.join(evidenceRoot, "runs", "p6-asset-binding-final-20260718"));
const explicitUiEvidencePath = path.resolve(workspace, cli.uiEvidenceArgument);
const planningRoot = path.join(workspace, ".planning", "2026-07-17-ai-p0-p10");
const expectedSource = {
  files: 3_344,
  bytes: 24_570_877,
  aggregateSha256: "649160f22663ca4c45ee4a4084e278ef0edc61ec66db01bb84da38cbea3f8d26",
} as const;
const expectedProject = {
  id: "project-2e3b44bc6ac4",
  name: "Codex AI 短剧素材中心",
  manifestFingerprint: "57e55eaf4b571c8e1ca7f606f79f849d08d0ad074ebd112eb0f82968413c3ac8",
} as const;
const expectedToolCount = 180;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MIN_TARGETED_FILES = 18;
const MIN_TARGETED_TESTS = 80;
const MIN_FULL_FILES = 72;
const MIN_FULL_TESTS = 482;

interface FileEvidence {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
}

interface InventorySnapshot {
  root: string;
  files: number;
  bytes: number;
  aggregateSha256: string;
}

interface TreeEntry {
  relativePath: string;
  type: "directory" | "file";
  sizeBytes: number;
  mtimeMs: number;
  sha256?: string;
}

interface TreeSnapshot {
  root: string;
  files: number;
  directories: number;
  bytes: number;
  entries: TreeEntry[];
  aggregateSha256: string;
}

interface TestSummary {
  filesPassed: number;
  filesFailed: number;
  testsPassed: number;
  testsFailed: number;
  filesSkipped: number;
  testsSkipped: number;
  testsTodo: number;
  filesTotal: number;
  testsTotal: number;
}

interface RunEvidence {
  name: string;
  argv: string[];
  cwd: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  outputOverflow: boolean;
  capturedBytes: number;
  maximumCapturedBytes: number;
  log: FileEvidence;
  testSummary?: TestSummary;
}

interface BuildIdentityEntry {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

interface SqliteLogicalSnapshot {
  databasePath: string;
  integrity: string;
  schemaSha256: string;
  tableCounts: Record<string, number>;
  metaRows: Record<string, string>[];
  digest: string;
}

interface LabeledAsset {
  id: string;
  category: StudioAssetCategory;
  name: string;
  aliases: string[];
}

interface LabeledSegment {
  text: string;
  category: StudioAssetCategory;
  expectedAssetIds: string[];
  expectedStatus: "matched" | "ambiguous";
  sourceSpanId?: string;
}

interface LabeledFixture {
  schemaVersion: 1;
  assets: LabeledAsset[];
  segments: LabeledSegment[];
}

interface RetrievalMetrics {
  labeledAssets: number;
  labeledSegments: number;
  proposals: number;
  truePositives: number;
  exactExpected: number;
  exactCorrect: number;
  ambiguousExpected: number;
  ambiguousCorrect: number;
  recalledAtFive: number;
  precision: number;
  exactAliasAccuracy: number;
  recallAtFive: number;
  silentAmbiguitySelections: number;
  temporaryRoot: string;
  temporaryProjectRoot: string;
  cleanupVerified: boolean;
}

interface P6UiEvidence {
  schemaVersion?: number;
  kind?: string;
  status?: string;
  createdAt?: string;
  fixture?: {
    projectId?: string;
    sourceRoots?: unknown[];
    units?: number;
    panels?: number;
    canonicalAssets?: number;
  };
  ui?: {
    startupDefaultLibrary?: boolean;
    bindingChunkLazyLoaded?: boolean;
    sourceExcerptVisible?: boolean;
    chapterAndSceneSourcesVisible?: boolean;
    exactAliasPendingHumanAccept?: boolean;
    ambiguousCandidateCount?: number;
    silentAmbiguitySelection?: number;
    resolvedDecisionVisible?: boolean;
    confirmedEmptyReviewedByUser?: boolean;
    confirmedEmptyCurrent?: boolean;
    confirmedEmptyFrozen?: boolean;
    bindingSetCurrent?: boolean;
    generationReady?: boolean;
    nextActionAfterFirstFreeze?: string;
    nextActionAfterConfirmedEmptyFreeze?: string;
    readyMs?: number;
    pageErrors?: number;
    externalRequests?: number;
  };
  bindingSet?: { id?: string; fingerprint?: string; bindings?: number };
  confirmedEmptyBindingSet?: {
    id?: string;
    fingerprint?: string;
    bindings?: number;
    confirmedEmpty?: boolean;
    confirmationId?: string;
    reviewer?: string;
  };
  screenshot?: {
    path?: string;
    sizeBytes?: number;
    sha256?: string;
    width?: number;
    height?: number;
    format?: string;
    stdev?: number;
  };
  boundaries?: {
    formalProjectWrites?: number;
    filesystemScans?: number;
    imageGenerationCalls?: number;
    browserSupplierCalls?: number;
    uploads?: number;
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertAbsent(target: string): Promise<void> {
  await stat(target).then(
    () => { throw new Error(`最终验证目标已存在，拒绝覆盖：${target}`); },
    (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; },
  );
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function fileEvidence(filePath: string): Promise<FileEvidence> {
  const before = await stat(filePath);
  const digest = await sha256File(filePath);
  const after = await stat(filePath);
  assert(before.isFile() && after.isFile(), `证据路径不是普通文件：${filePath}`);
  assert(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
    `采集文件证据期间发生变化：${filePath}`);
  return { path: filePath, sizeBytes: before.size, mtimeMs: before.mtimeMs, sha256: digest };
}

async function mapLimit<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await worker(items[index]!);
    }
  }));
  return result;
}

async function inventorySnapshot(root: string): Promise<InventorySnapshot> {
  const relativePaths = (await fg("**/*", {
    cwd: root,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    unique: true,
  })).map((entry) => entry.split(path.sep).join("/"))
    .sort((left, right) => left.localeCompare(right, "en"));
  const rows = await mapLimit(relativePaths, 8, async (relativePath) => {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const before = await stat(absolutePath);
    const fileSha256 = await sha256File(absolutePath);
    const after = await stat(absolutePath);
    assert(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
      `冻结只读源期间文件发生变化：${absolutePath}`);
    return { relativePath, bytes: before.size, mtimeMs: before.mtimeMs, sha256: fileSha256 };
  });
  return {
    root,
    files: rows.length,
    bytes: rows.reduce((sum, entry) => sum + entry.bytes, 0),
    aggregateSha256: sha256(rows.map((entry) => `${entry.relativePath}\0${entry.bytes}\0${entry.mtimeMs}\0${entry.sha256}`).join("\n")),
  };
}

async function treeSnapshot(root: string): Promise<TreeSnapshot> {
  const relativePaths = (await fg("**/*", {
    cwd: root,
    onlyFiles: false,
    dot: true,
    followSymbolicLinks: false,
    unique: true,
  })).map((entry) => entry.split(path.sep).join("/"))
    .sort((left, right) => left.localeCompare(right, "en"));
  const entries = await mapLimit(relativePaths, 8, async (relativePath): Promise<TreeEntry> => {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const before = await lstat(absolutePath);
    assert(!before.isSymbolicLink(), `正式工程包含符号链接：${absolutePath}`);
    assert(before.isDirectory() || before.isFile(), `正式工程包含非文件/目录：${absolutePath}`);
    const canonical = await realpath(absolutePath);
    assert(isWithin(root, canonical), `正式工程路径越界：${canonical}`);
    if (before.isDirectory()) {
      return { relativePath, type: "directory", sizeBytes: before.size, mtimeMs: before.mtimeMs };
    }
    const fileSha256 = await sha256File(absolutePath);
    const after = await lstat(absolutePath);
    assert(after.isFile() && !after.isSymbolicLink()
      && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
    `冻结正式工程期间文件发生变化：${absolutePath}`);
    return { relativePath, type: "file", sizeBytes: before.size, mtimeMs: before.mtimeMs, sha256: fileSha256 };
  });
  return {
    root,
    files: entries.filter((entry) => entry.type === "file").length,
    directories: entries.filter((entry) => entry.type === "directory").length,
    bytes: entries.filter((entry) => entry.type === "file").reduce((sum, entry) => sum + entry.sizeBytes, 0),
    entries,
    aggregateSha256: sha256(JSON.stringify(entries)),
  };
}

async function workspaceSourceDigest(): Promise<{ files: number; aggregateSha256: string }> {
  const files = (await fg([
    "src/**/*",
    "tests/**/*",
    "scripts/**/*",
    "package.json",
    "package-lock.json",
    "tsconfig*.json",
    "electron.vite.config.ts",
    "vitest.config.ts",
  ], { cwd: workspace, onlyFiles: true, dot: true, followSymbolicLinks: false, unique: true }))
    .map((entry) => entry.split(path.sep).join("/"))
    .sort((left, right) => left.localeCompare(right, "en"));
  const rows = await mapLimit(files, 8, async (relativePath) => `${relativePath}\0${await sha256File(path.join(workspace, relativePath))}`);
  return { files: files.length, aggregateSha256: sha256(rows.join("\n")) };
}

async function uiInputIdentity(): Promise<{ files: number; latestMtimeMs: number; aggregateSha256: string }> {
  const files = (await fg([
    "src/**/*",
    "scripts/ui-p6-binding-workbench-smoke.ts",
    "package.json",
    "package-lock.json",
    "tsconfig*.json",
    "electron.vite.config.ts",
  ], { cwd: workspace, onlyFiles: true, dot: true, followSymbolicLinks: false, unique: true }))
    .map((entry) => entry.split(path.sep).join("/"))
    .sort((left, right) => left.localeCompare(right, "en"));
  const rows = await mapLimit(files, 8, async (relativePath) => {
    const absolutePath = path.join(workspace, relativePath);
    const metadata = await stat(absolutePath);
    return { relativePath, mtimeMs: metadata.mtimeMs, sha256: await sha256File(absolutePath) };
  });
  return {
    files: rows.length,
    latestMtimeMs: Math.max(...rows.map((entry) => entry.mtimeMs)),
    aggregateSha256: sha256(JSON.stringify(rows)),
  };
}

function openImmutableDatabase(databasePath: string): DatabaseSync {
  const databaseUrl = pathToFileURL(databasePath);
  databaseUrl.searchParams.set("immutable", "1");
  return new DatabaseSync(databaseUrl, { readOnly: true, timeout: 5_000 });
}

function sqliteLogicalSnapshot(databasePath: string): SqliteLogicalSnapshot {
  const database = openImmutableDatabase(databasePath);
  try {
    const integrity = String((database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined)?.integrity_check ?? "");
    assert(integrity === "ok", `SQLite 完整性失败：${databasePath}`);
    const schemaRows = database.prepare(`
      SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
    const tableNames = schemaRows.filter((row) => row.type === "table").map((row) => row.name);
    const tableCounts: Record<string, number> = {};
    for (const tableName of tableNames) {
      const quoted = tableName.replaceAll('"', '""');
      tableCounts[tableName] = Number((database.prepare(`SELECT COUNT(*) AS count FROM "${quoted}"`).get() as { count: number }).count);
    }
    const metaTable = tableNames.find((name) => name === "studio_meta"
      || name === "studio_production_meta"
      || name === "studio_generation_ledger_meta");
    const metaRows = metaTable
      ? database.prepare(`SELECT key, value FROM "${metaTable}" ORDER BY key`).all() as Record<string, string>[]
      : [];
    const schemaSha256 = sha256(JSON.stringify(schemaRows));
    return {
      databasePath,
      integrity,
      schemaSha256,
      tableCounts,
      metaRows,
      digest: sha256(JSON.stringify({ schemaSha256, tableCounts, metaRows })),
    };
  } finally {
    database.close();
  }
}

function assertZeroBusinessRows(snapshot: SqliteLogicalSnapshot): void {
  const nonZero = Object.entries(snapshot.tableCounts)
    .filter(([name, count]) => !name.endsWith("_meta") && count !== 0);
  assert(nonZero.length === 0, `正式受管工程必须保持零业务数据：${snapshot.databasePath} => ${JSON.stringify(nonZero)}`);
}

function assertFormalProjectEmpty(
  logical: { material: SqliteLogicalSnapshot; production: SqliteLogicalSnapshot; generation: SqliteLogicalSnapshot },
  tree: TreeSnapshot,
): {
  businessRows: number;
  materialObjects: number;
  productionObjects: number;
  generationObjects: number;
  derivedFiles: number;
} {
  const businessRows = Object.values(logical).reduce((databaseTotal, snapshot) => databaseTotal
    + Object.entries(snapshot.tableCounts)
      .filter(([name]) => !name.endsWith("_meta"))
      .reduce((tableTotal, [, count]) => tableTotal + count, 0), 0);
  const files = tree.entries.filter((entry) => entry.type === "file");
  const countFiles = (prefix: string): number => files.filter((entry) => entry.relativePath.startsWith(prefix)).length;
  const summary = {
    businessRows,
    materialObjects: countFiles(".aicanvas/objects/sha256/"),
    productionObjects: countFiles(".aicanvas/studio-production/objects/sha256/"),
    generationObjects: countFiles(".aicanvas/studio-generation/objects/sha256/"),
    derivedFiles: files.filter((entry) => [
      ".aicanvas/derived/thumb/",
      ".aicanvas/derived/proxy/",
      ".aicanvas/derived/waveform/",
    ].some((prefix) => entry.relativePath.startsWith(prefix))).length,
  };
  assert(Object.values(summary).every((count) => count === 0),
    `正式 Codex AI 短剧素材中心必须仍为空项目：${JSON.stringify(summary)}`);
  return summary;
}

async function assertFormalProjectIdentity(): Promise<{
  manifest: FileEvidence;
  config: FileEvidence;
  projectId: string;
  projectName: string;
  productionSchemaVersion: number;
  databases: { material: string; production: string; generation: string };
  logical: { material: SqliteLogicalSnapshot; production: SqliteLogicalSnapshot; generation: SqliteLogicalSnapshot };
}> {
  const manifestPath = path.join(projectRoot, ".aicanvas", "managed-project.json");
  const configPath = path.join(projectRoot, ".aicanvas", "project.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    projectId?: string;
    projectName?: string;
    rootRealpath?: string;
    startupPolicy?: string;
    legacyRoots?: unknown[];
    fingerprint?: string;
    relativePaths?: Record<string, string>;
  };
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    id?: string;
    name?: string;
    primaryRoot?: string;
    sourceRoots?: unknown[];
    outputRoots?: unknown[];
  };
  assert(manifest.projectId === expectedProject.id && manifest.projectName === expectedProject.name
    && manifest.rootRealpath === projectRoot && manifest.startupPolicy === "no-filesystem-scan"
    && Array.isArray(manifest.legacyRoots) && manifest.legacyRoots.length === 0
    && manifest.fingerprint === expectedProject.manifestFingerprint,
  "正式受管工程 manifest 身份或隔离策略漂移。 ");
  assert(config.id === expectedProject.id && config.name === expectedProject.name
    && path.resolve(config.primaryRoot ?? "") === projectRoot
    && Array.isArray(config.sourceRoots) && config.sourceRoots.length === 0
    && Array.isArray(config.outputRoots) && config.outputRoots.length === 1
    && path.resolve(String(config.outputRoots[0])) === projectRoot,
  "正式受管工程 config 身份、sourceRoots=[] 或唯一写根漂移。 ");
  const relativePaths = manifest.relativePaths ?? {};
  const resolveManaged = (key: string): string => {
    const relativePath = relativePaths[key];
    assert(typeof relativePath === "string" && relativePath.length > 0, `正式 manifest 缺少路径：${key}`);
    const absolutePath = path.resolve(projectRoot, relativePath);
    assert(isWithin(projectRoot, absolutePath) && absolutePath !== projectRoot, `正式 manifest 路径越界：${key}=${absolutePath}`);
    return absolutePath;
  };
  const databases = {
    material: resolveManaged("materialDatabase"),
    production: resolveManaged("productionDatabase"),
    generation: resolveManaged("generationDatabase"),
  };
  const logical = {
    material: sqliteLogicalSnapshot(databases.material),
    production: sqliteLogicalSnapshot(databases.production),
    generation: sqliteLogicalSnapshot(databases.generation),
  };
  Object.values(logical).forEach(assertZeroBusinessRows);
  const productionSchemaVersion = Number(logical.production.metaRows.find((row) => row.key === "schema_version")?.value ?? 0);
  assert(productionSchemaVersion === 2 || productionSchemaVersion === 4,
    `正式生产库只接受已知 v2 空库基线或已显式迁移 v4：${productionSchemaVersion}`);
  assert(Number(logical.material.metaRows.find((row) => row.key === "schema_version")?.value ?? 0) === 1,
    "正式素材库 schema_version 漂移。 ");
  assert(Number(logical.generation.metaRows.find((row) => row.key === "schema_version")?.value ?? 0) === 1,
    "正式生成账本 schema_version 漂移。 ");
  return {
    manifest: await fileEvidence(manifestPath),
    config: await fileEvidence(configPath),
    projectId: config.id,
    projectName: config.name,
    productionSchemaVersion,
    databases,
    logical,
  };
}

async function compiledBuildIdentity(): Promise<{ files: BuildIdentityEntry[] }> {
  const relativePaths = (await fg([
    "out/main/index.js",
    "out/preload/index.mjs",
    "out/renderer/index.html",
    "out/renderer/assets/*",
  ], { cwd: workspace, onlyFiles: true, dot: false, followSymbolicLinks: false, unique: true }))
    .map((entry) => entry.split(path.sep).join("/"))
    .sort((left, right) => left.localeCompare(right, "en"));
  assert(relativePaths.includes("out/main/index.js")
    && relativePaths.includes("out/preload/index.mjs")
    && relativePaths.includes("out/renderer/index.html")
    && relativePaths.some((entry) => entry.startsWith("out/renderer/assets/")),
  "production build 缺少 main/preload/renderer 身份文件。 ");
  return {
    files: await Promise.all(relativePaths.map(async (relativePath) => {
      const absolutePath = path.join(workspace, relativePath);
      const metadata = await stat(absolutePath);
      return { relativePath, sizeBytes: metadata.size, sha256: await sha256File(absolutePath) };
    })),
  };
}

function parseTestSummary(output: string): TestSummary | undefined {
  const normalized = output.replace(/\u001b\[[0-9;]*m/gu, "");
  const filesLine = normalized.match(/^\s*Test Files\s+(.+)$/mu)?.[1];
  const testsLine = normalized.match(/^\s*Tests\s+(.+)$/mu)?.[1];
  if (!filesLine || !testsLine) return undefined;
  const metric = (line: string, label: string): number => Number(line.match(new RegExp(`(\\d+)\\s+${label}`, "u"))?.[1] ?? 0);
  const total = (line: string): number => Number(line.match(/\((\d+)\)\s*$/u)?.[1] ?? 0);
  return {
    filesPassed: metric(filesLine, "passed"),
    filesFailed: metric(filesLine, "failed"),
    testsPassed: metric(testsLine, "passed"),
    testsFailed: metric(testsLine, "failed"),
    filesSkipped: metric(filesLine, "skipped"),
    testsSkipped: metric(testsLine, "skipped"),
    testsTodo: metric(testsLine, "todo"),
    filesTotal: total(filesLine),
    testsTotal: total(testsLine),
  };
}

async function runCommand(
  name: string,
  command: string,
  args: string[],
  timeoutMs: number,
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<{ evidence: RunEvidence; stdout: string; stderr: string }> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  process.stderr.write(`[P6 final] ${name}\n`);
  const result = await new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    outputOverflow: boolean;
    capturedBytes: number;
  }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_offline: "true",
        TMPDIR: "/tmp",
        TMP: "/tmp",
        TEMP: "/tmp",
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputOverflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    const capture = (target: Buffer[], chunk: Buffer): void => {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        outputOverflow = true;
        child.kill("SIGTERM");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputOverflow,
        capturedBytes,
      });
    });
  });
  const finishedAt = new Date().toISOString();
  const logPath = path.join(runRoot, `${name}.log`);
  const log = [
    `argv=${JSON.stringify([command, ...args])}`,
    `cwd=${workspace}`,
    `startedAt=${startedAt}`,
    `finishedAt=${finishedAt}`,
    `exitCode=${result.exitCode}`,
    `timedOut=${result.timedOut}`,
    `outputOverflow=${result.outputOverflow}`,
    `capturedBytes=${result.capturedBytes}`,
    `maximumCapturedBytes=${MAX_CAPTURE_BYTES}`,
    "--- stdout ---",
    result.stdout,
    "--- stderr ---",
    result.stderr,
  ].join("\n");
  await writeFile(logPath, log, { encoding: "utf8", flag: "wx" });
  const testSummary = parseTestSummary(`${result.stdout}\n${result.stderr}`);
  const evidence: RunEvidence = {
    name,
    argv: [command, ...args],
    cwd: workspace,
    startedAt,
    finishedAt,
    durationMs: Date.now() - startedMs,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputOverflow: result.outputOverflow,
    capturedBytes: result.capturedBytes,
    maximumCapturedBytes: MAX_CAPTURE_BYTES,
    log: await fileEvidence(logPath),
    ...(testSummary ? { testSummary } : {}),
  };
  assert(!result.timedOut && !result.outputOverflow && result.exitCode === 0, `${name} 失败；详见 ${logPath}`);
  return { evidence, stdout: result.stdout, stderr: result.stderr };
}

function assertTestRun(
  run: RunEvidence,
  threshold: { minimumFilesPassed: number; minimumTestsPassed: number },
): void {
  const summary = run.testSummary;
  assert(summary
    && summary.filesPassed >= threshold.minimumFilesPassed
    && summary.testsPassed >= threshold.minimumTestsPassed
    && summary.filesTotal === summary.filesPassed + summary.filesFailed + summary.filesSkipped
    && summary.testsTotal === summary.testsPassed + summary.testsFailed + summary.testsSkipped + summary.testsTodo
    && summary.filesFailed === 0
    && summary.testsFailed === 0
    && summary.filesSkipped === 0
    && summary.testsSkipped === 0
    && summary.testsTodo === 0,
  `${run.name} 测试统计无效；必须达到最低阈值且无失败、无跳过、无 todo：${JSON.stringify({ threshold, summary })}`);
}

async function assertPlanningGate(): Promise<{
  taskPlan: FileEvidence;
  attestation: FileEvidence;
  mode: string;
  currentPhase: "P6";
  p6Status: "in_progress";
}> {
  const taskPlanPath = path.join(planningRoot, "task_plan.md");
  const attestationPath = path.join(planningRoot, ".attestation");
  const modePath = path.join(planningRoot, ".mode");
  const [taskPlan, attestation, mode] = await Promise.all([
    readFile(taskPlanPath, "utf8"),
    readFile(attestationPath, "utf8"),
    readFile(modePath, "utf8"),
  ]);
  assert(attestation.trim() === sha256(taskPlan), "P6 task_plan attestation 与当前文件 SHA 不一致。 ");
  assert(mode.trim() === "autonomous gate", `P6 planning 模式漂移：${mode.trim()}`);
  assert(/## Current Phase\s*\nP6：剧本资产解析与 AssetBindingSet/u.test(taskPlan), "当前 planning 阶段不是 P6。 ");
  const p6Section = taskPlan.match(/### P6:[\s\S]*?\*\*Status:\*\* (in_progress|completed|pending)/u);
  const p5Section = taskPlan.match(/### P5:[\s\S]*?\*\*Status:\*\* (in_progress|completed|pending)/u);
  const p7Section = taskPlan.match(/### P7:[\s\S]*?\*\*Status:\*\* (in_progress|completed|pending)/u);
  assert(p6Section?.[1] === "in_progress" && p5Section?.[1] === "completed" && p7Section?.[1] === "pending",
    `P6 阶段顺序或状态漂移：${JSON.stringify({ p5: p5Section?.[1], p6: p6Section?.[1], p7: p7Section?.[1] })}`);
  return {
    taskPlan: await fileEvidence(taskPlanPath),
    attestation: await fileEvidence(attestationPath),
    mode: mode.trim(),
    currentPhase: "P6",
    p6Status: "in_progress",
  };
}

async function validateP6Contracts(): Promise<Array<{
  capability: string;
  file: FileEvidence;
  markers: string[];
}>> {
  const contracts: Array<{ capability: string; relativePath: string; markers: string[] }> = [
    {
      capability: "production-schema-v4",
      relativePath: "src/core/studio-production.ts",
      markers: ["const SCHEMA_VERSION = 4;"],
    },
    {
      capability: "exact-identity-only",
      relativePath: "tests/material-studio-identity.test.ts",
      markers: ["只按 NFKC 精确键返回 id、正式名和 alias，不使用 substring"],
    },
    {
      capability: "identity-trie-10k-assets-30k-identities",
      relativePath: "tests/studio-identity-lexical-index.test.ts",
      markers: ["10k assets / 30k identities / 6 panels", "P6_IDENTITY_TRIE_BENCHMARK"],
    },
    {
      capability: "source-spans-and-restart",
      relativePath: "tests/studio-panel-source-spans.test.ts",
      markers: ["新建、读取与重启均保留 UTF-16 锚点/SHA，表结构为外键、索引和只追加"],
    },
    {
      capability: "section-list-get-restart",
      relativePath: "tests/studio-script-section-recovery.test.ts",
      markers: ["Studio 章节/场景可恢复读取", "initializeStudioProduction(root)"],
    },
    {
      capability: "asset-binding-decisions",
      relativePath: "tests/studio-asset-bindings.test.ts",
      markers: ["歧义与模型建议不自动匹配，人工 select/exclude 生效，forbidden 未决阻断"],
    },
    {
      capability: "binding-control-receipt-proof",
      relativePath: "tests/studio-binding-control.test.ts",
      markers: ["exact alias 只产提案、歧义必须人工选择，决策 CAS/presence/role 进入冻结与 receipt proof"],
    },
    {
      capability: "atomic-binding-receipts",
      relativePath: "tests/studio-binding-atomic-receipts.test.ts",
      markers: ["P6_BINDING_ATOMIC_RECEIPT_MATRIX"],
    },
    {
      capability: "binding-command-bus",
      relativePath: "tests/studio-binding-command-bus.test.ts",
      markers: ["三个高层命令只收 UI 安全 payload，崩溃后只凭追加收据对账而不重放写操作"],
    },
    {
      capability: "section-command-bus",
      relativePath: "tests/studio-script-section-command-bus.test.ts",
      markers: ["严格限定公开 payload，保留语义幂等并将 Head CAS 冲突记为明确未落地"],
    },
    {
      capability: "stable-ui-idempotency",
      relativePath: "tests/studio-command-envelope.test.ts",
      markers: ["同一 revision token 与语义重试复用幂等键，但每次 IPC 有独立 requestId"],
    },
    {
      capability: "mcp-section-list-get-restart",
      relativePath: "tests/mcp-studio-binding-control.test.ts",
      markers: ["list_sections", "get_section", "MCP 进程重启后可按旧 script revision 分页恢复同文档 current heads"],
    },
    {
      capability: "panel-reference-resolution-core-v2",
      relativePath: "tests/panel-reference-resolution-core.test.ts",
      markers: ["PanelReferenceResolution Core V2", "只有显式确认才能得到 confirmed-empty"],
    },
    {
      capability: "confirmed-empty-vertical-slice",
      relativePath: "tests/studio-confirmed-empty.test.ts",
      markers: ["P6_CONFIRMED_EMPTY_VERTICAL_SLICE"],
    },
    {
      capability: "panel-level-precise-invalidation",
      relativePath: "tests/studio-generation.test.ts",
      markers: ["P6 AssetBindingSet 一致性冻结包", "同一 15 秒单元只改其他宫格时保持目标格冻结包稳定，改目标格才失败关闭"],
    },
    {
      capability: "late-result-dispatch-stale-retention",
      relativePath: "tests/studio-generation-ledger.test.ts",
      markers: [
        "未 dispatch 的 run 即使结果图合法也失败关闭，不留孤立 result 行",
        "冻结并 dispatch 后 alias/BindingSet currentness 漂移，raw/labeled 仍挂回原 pack 但永不可提升",
        "冻结并 dispatch 后 script/单元修订漂移时仍保留原 pack 历史，不冒充 current",
      ],
    },
    {
      capability: "retrieval-quality-benchmark",
      relativePath: "tests/studio-binding-retrieval-benchmark.test.ts",
      markers: ["平衡语料真实测量 Precision、精确别名准确率、Recall@5 与静默歧义", "P6_RETRIEVAL_BENCHMARK"],
    },
    {
      capability: "labeled-retrieval-fixture",
      relativePath: "tests/fixtures/p6-entity-retrieval-labeled.json",
      markers: ["\"expectedStatus\": \"ambiguous\""],
    },
    {
      capability: "binding-workbench-contract",
      relativePath: "tests/studio-binding-workbench.test.ts",
      markers: ["歧义提案绝不默认采用第一候选"],
    },
    {
      capability: "desktop-boundary",
      relativePath: "tests/studio-binding-desktop-integration.test.ts",
      markers: ["主线程与 preload 只暴露两个专用只读 IPC，写入继续经过 execute command"],
    },
    {
      capability: "immutable-ui-smoke-writer",
      relativePath: "scripts/ui-p6-binding-workbench-smoke.ts",
      markers: ["resolvedDecisionVisible: true", "flag: \"wx\""],
    },
  ];
  const result: Array<{ capability: string; file: FileEvidence; markers: string[] }> = [];
  for (const contract of contracts) {
    const absolutePath = path.join(workspace, contract.relativePath);
    let content: string;
    try {
      content = await readFile(absolutePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`P6 专项验收文件缺失：${contract.relativePath} [${contract.capability}]`);
      }
      throw error;
    }
    const missingMarkers = contract.markers.filter((marker) => !content.includes(marker));
    assert(missingMarkers.length === 0,
      `P6 验收契约 marker 缺失：${contract.relativePath} [${contract.capability}] => ${JSON.stringify(missingMarkers)}`);
    result.push({ capability: contract.capability, file: await fileEvidence(absolutePath), markers: contract.markers });
  }
  return result;
}

async function uiEvidenceCandidatePaths(): Promise<string[]> {
  return (await fg("p6-binding-workbench-ui-smoke-*.json", {
    cwd: evidenceRoot,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    unique: true,
  })).filter((entry) => /^p6-binding-workbench-ui-smoke-\d{8}-\d{2,}\.json$/u.test(entry))
    .map((entry) => path.join(evidenceRoot, entry))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function uiEvidenceSequence(filePath: string): number {
  const match = path.basename(filePath).match(/^p6-binding-workbench-ui-smoke-\d{8}-(\d{2,})\.json$/u);
  assert(match, `P6 UI 证据必须使用带序号的不可变文件名：${filePath}`);
  const sequence = Number(match[1]);
  assert(Number.isInteger(sequence) && sequence >= 4,
    `P6 final 只接受 -04 或更新 UI smoke，拒绝旧证据：${filePath}`);
  return sequence;
}

async function loadExplicitLatestUiEvidence(uiInputs: Awaited<ReturnType<typeof uiInputIdentity>>): Promise<{
  candidatePaths: string[];
  evidencePath: string;
  sequence: number;
  evidenceFile: FileEvidence;
  screenshotFile: FileEvidence;
  parsed: P6UiEvidence;
  screenshot: { width: number; height: number; format: string; stdev: number };
}> {
  assert(isWithin(evidenceRoot, explicitUiEvidencePath) && explicitUiEvidencePath !== evidenceRoot,
    `--ui-evidence 必须位于 docs/evidence：${explicitUiEvidencePath}`);
  const explicitSequence = uiEvidenceSequence(explicitUiEvidencePath);
  const candidatePaths = await uiEvidenceCandidatePaths();
  assert(candidatePaths.length > 0, "缺少 P6 binding workbench UI smoke 机器证据。 ");
  const candidates = await Promise.all(candidatePaths.map(async (candidatePath) => {
    const metadata = await lstat(candidatePath);
    assert(metadata.isFile() && !metadata.isSymbolicLink(), `P6 UI 证据不是普通文件：${candidatePath}`);
    const parsed = JSON.parse(await readFile(candidatePath, "utf8")) as P6UiEvidence;
    const createdAtMs = Date.parse(parsed.createdAt ?? "");
    assert(Number.isFinite(createdAtMs), `P6 UI 证据 createdAt 无效：${candidatePath}`);
    const match = path.basename(candidatePath).match(/^p6-binding-workbench-ui-smoke-(\d{8})-(\d{2,})\.json$/u);
    assert(match, `P6 UI 证据文件名无法解析：${candidatePath}`);
    return { candidatePath, parsed, createdAtMs, date: Number(match[1]), sequence: Number(match[2]) };
  }));
  candidates.sort((left, right) => right.date - left.date
    || right.sequence - left.sequence
    || right.createdAtMs - left.createdAtMs
    || right.candidatePath.localeCompare(left.candidatePath, "en"));
  const latest = candidates[0]!;
  assert(latest.candidatePath === explicitUiEvidencePath,
    `--ui-evidence 必须显式指向当前最新不可变 UI smoke：${JSON.stringify({ provided: explicitUiEvidencePath, latest: latest.candidatePath })}`);
  assert(latest.sequence === explicitSequence, "P6 UI smoke 序号在候选扫描中发生漂移。 ");
  assert(latest.createdAtMs <= Date.now() + 5 * 60_000, `P6 UI 证据时间位于未来：${latest.candidatePath}`);
  const evidenceFile = await fileEvidence(latest.candidatePath);
  assert(latest.createdAtMs >= uiInputs.latestMtimeMs && evidenceFile.mtimeMs >= uiInputs.latestMtimeMs,
    `最新 P6 UI 证据早于当前 UI/runtime 源码，必须重跑 smoke：${latest.candidatePath}`);
  const screenshotPath = path.resolve(latest.parsed.screenshot?.path ?? "");
  assert(isWithin(evidenceRoot, screenshotPath) && screenshotPath !== evidenceRoot,
    `P6 UI 截图路径越出 docs/evidence：${screenshotPath}`);
  assert(path.basename(screenshotPath) === `${path.basename(latest.candidatePath, ".json")}.png`,
    `P6 UI JSON 与截图必须为同一不可变序号对：${JSON.stringify({ json: latest.candidatePath, screenshotPath })}`);
  const screenshotMetadata = await lstat(screenshotPath);
  assert(screenshotMetadata.isFile() && !screenshotMetadata.isSymbolicLink(), `P6 UI 截图不是普通文件：${screenshotPath}`);
  const screenshotFile = await fileEvidence(screenshotPath);
  const [metadata, stats] = await Promise.all([sharp(screenshotPath).metadata(), sharp(screenshotPath).stats()]);
  const stdev = Math.max(...stats.channels.map((channel) => channel.stdev));
  assert(latest.parsed.schemaVersion === 2
    && latest.parsed.kind === "p6-binding-workbench-ui-smoke"
    && latest.parsed.status === "pass"
    && latest.parsed.fixture?.sourceRoots?.length === 0
    && latest.parsed.fixture.units === 1
    && latest.parsed.fixture.panels === 2
    && latest.parsed.fixture.canonicalAssets === 3
    && latest.parsed.ui?.startupDefaultLibrary === true
    && latest.parsed.ui.bindingChunkLazyLoaded === true
    && latest.parsed.ui.sourceExcerptVisible === true
    && latest.parsed.ui.chapterAndSceneSourcesVisible === true
    && latest.parsed.ui.exactAliasPendingHumanAccept === true
    && latest.parsed.ui.ambiguousCandidateCount === 2
    && latest.parsed.ui.silentAmbiguitySelection === 0
    && latest.parsed.ui.resolvedDecisionVisible === true
    && latest.parsed.ui.confirmedEmptyReviewedByUser === true
    && latest.parsed.ui.confirmedEmptyCurrent === true
    && latest.parsed.ui.confirmedEmptyFrozen === true
    && latest.parsed.ui.bindingSetCurrent === true
    && latest.parsed.ui.generationReady === true
    && typeof latest.parsed.ui.nextActionAfterFirstFreeze === "string"
    && latest.parsed.ui.nextActionAfterFirstFreeze.includes("宫格 2")
    && latest.parsed.ui.nextActionAfterFirstFreeze.includes("解析")
    && typeof latest.parsed.ui.nextActionAfterConfirmedEmptyFreeze === "string"
    && latest.parsed.ui.nextActionAfterConfirmedEmptyFreeze.includes("全部宫格绑定已就绪")
    && Number.isFinite(latest.parsed.ui.readyMs) && (latest.parsed.ui.readyMs ?? 0) > 0
    && latest.parsed.ui.pageErrors === 0
    && latest.parsed.ui.externalRequests === 0
    && /^asset-binding-set-[a-f0-9]+$/u.test(latest.parsed.bindingSet?.id ?? "")
    && /^[a-f0-9]{64}$/u.test(latest.parsed.bindingSet?.fingerprint ?? "")
    && latest.parsed.bindingSet?.bindings === 2
    && /^asset-binding-set-[a-f0-9]+$/u.test(latest.parsed.confirmedEmptyBindingSet?.id ?? "")
    && /^[a-f0-9]{64}$/u.test(latest.parsed.confirmedEmptyBindingSet?.fingerprint ?? "")
    && latest.parsed.confirmedEmptyBindingSet?.bindings === 0
    && latest.parsed.confirmedEmptyBindingSet.confirmedEmpty === true
    && /^panel-entity-closure-confirmation-[a-f0-9]+$/u.test(latest.parsed.confirmedEmptyBindingSet.confirmationId ?? "")
    && latest.parsed.confirmedEmptyBindingSet.reviewer === "user"
    && latest.parsed.screenshot?.path === screenshotPath
    && latest.parsed.screenshot.sizeBytes === screenshotFile.sizeBytes
    && latest.parsed.screenshot.sha256 === screenshotFile.sha256
    && latest.parsed.boundaries?.formalProjectWrites === 0
    && latest.parsed.boundaries.filesystemScans === 0
    && latest.parsed.boundaries.imageGenerationCalls === 0
    && latest.parsed.boundaries.browserSupplierCalls === 0
    && latest.parsed.boundaries.uploads === 0,
  "P6 UI smoke 未证明惰性加载、显式消歧、confirmed-empty 空闭包、current BindingSet、唯一下一动作或零外部副作用。 ");
  assert((metadata.width ?? 0) >= 1_500 && (metadata.height ?? 0) >= 900
    && screenshotFile.sizeBytes >= 35_000 && metadata.format === "png" && stdev >= 5
    && latest.parsed.screenshot.width === metadata.width
    && latest.parsed.screenshot.height === metadata.height
    && latest.parsed.screenshot.format === metadata.format
    && Math.abs((latest.parsed.screenshot.stdev ?? 0) - stdev) < 0.000_001,
  "P6 UI 截图疑似空白、占位、损坏或机器证据漂移。 ");
  return {
    candidatePaths,
    evidencePath: latest.candidatePath,
    sequence: explicitSequence,
    evidenceFile,
    screenshotFile,
    parsed: latest.parsed,
    screenshot: { width: metadata.width!, height: metadata.height!, format: metadata.format!, stdev },
  };
}

async function runRetrievalBenchmark(): Promise<RetrievalMetrics> {
  const fixturePath = path.join(workspace, "tests", "fixtures", "p6-entity-retrieval-labeled.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as LabeledFixture;
  assert(fixture.schemaVersion === 1 && fixture.assets.length > 0 && fixture.segments.length > 0,
    "P6 标注检索 fixture 缺失或为空。 ");
  const temporaryRoot = await realpath("/tmp");
  const parent = await realpath(await mkdtemp(path.join("/tmp", "ai-canvas-p6-final-retrieval-")));
  assert(isWithin(temporaryRoot, parent) && parent !== temporaryRoot,
    `P6 隔离测试工程必须位于 /tmp：${parent}`);
  let temporaryProjectRoot = "";
  let metrics: Omit<RetrievalMetrics, "temporaryRoot" | "temporaryProjectRoot" | "cleanupVerified"> | undefined;
  try {
    const root = (await createManagedProject({ parentRoot: parent, name: "P6 最终标注检索" })).paths.root;
    temporaryProjectRoot = root;
    assert(isWithin(parent, await realpath(root)), `P6 测试工程越出 /tmp 隔离父目录：${root}`);
    for (const asset of fixture.assets) {
      await createStudioCanonicalAsset(root, {
        id: asset.id,
        category: asset.category,
        name: asset.name,
        aliases: asset.aliases,
        expectedRevision: 0,
      });
    }
    const separator = "，";
    const sourceSpans = new Map<string, { text: string; startOffsetUtf16: number; endOffsetUtf16: number }>();
    let body = "";
    fixture.segments.forEach((segment, index) => {
      const sourceSpanId = segment.sourceSpanId ?? `mention-${index + 1}`;
      const existing = sourceSpans.get(sourceSpanId);
      if (existing) {
        assert(existing.text === segment.text, `共享 sourceSpanId ${sourceSpanId} 的 text 不一致。`);
        return;
      }
      if (body.length > 0) body += separator;
      const startOffsetUtf16 = body.length;
      body += segment.text;
      sourceSpans.set(sourceSpanId, { text: segment.text, startOffsetUtf16, endOffsetUtf16: body.length });
    });
    const scriptDocument = await createStudioScriptDocument(root, { id: "script-p6-final-benchmark", title: "P6 最终标注剧本", expectedRevision: 0 });
    const script = await appendStudioScriptRevision(root, {
      documentId: scriptDocument.id,
      expectedRevision: 0,
      body,
      source: "tests/fixtures/p6-entity-retrieval-labeled.json",
      sourceVersion: "final-v1",
    });
    const promptDocument = await createStudioPromptDocument(root, { id: "prompt-p6-final-benchmark", title: "P6 最终标注提示词", expectedRevision: 0 });
    const prompt = await appendStudioPromptRevision(root, {
      documentId: promptDocument.id,
      expectedRevision: 0,
      body: "电影写实，所有规范资产等待人工确认。",
      source: "tests/fixtures/p6-entity-retrieval-labeled.json",
      sourceVersion: "final-v1",
    });
    const unit = await createStudioProductionUnit(root, {
      id: "unit-p6-final-benchmark",
      season: "S03",
      episode: "EP01",
      sequence: 1,
      title: "P6 最终标注检索",
      scriptRevisionId: script.revision.id,
      expectedRevision: 0,
      panels: [{
        id: "panel-p6-final-benchmark-1",
        title: "标注宫格一",
        visualAction: body,
        shotComposition: "标注测试，不生产图片。",
        filmingMethod: "无。",
        startSeconds: 0,
        endSeconds: 8,
        durationSeconds: 8,
        promptRevisionId: prompt.revision.id,
        sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: body.length }],
        assets: [],
      }, {
        id: "panel-p6-final-benchmark-2",
        title: "标注宫格二",
        visualAction: "仅补足严格 15 秒二宫格合同。",
        shotComposition: "空镜。",
        filmingMethod: "无。",
        startSeconds: 8,
        endSeconds: 15,
        durationSeconds: 7,
        promptRevisionId: prompt.revision.id,
        sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: body.length }],
        assets: [],
      }],
    });
    const before = await getStudioBindingControl(root, { unitId: unit.unit.id });
    await analyzeStudioScriptEntities(root, {
      unitId: unit.unit.id,
      panelId: "panel-p6-final-benchmark-1",
      expectedRevisionToken: before.revisionToken,
    }, { requestHash: "6".repeat(64), reviewer: "codex" });
    const control = await getStudioBindingControl(root, { unitId: unit.unit.id });
    const proposals = control.panels[0]?.proposals ?? [];
    const expected = fixture.segments.map((segment, index) => {
      const span = sourceSpans.get(segment.sourceSpanId ?? `mention-${index + 1}`);
      assert(span, `缺少标注 source span：${segment.sourceSpanId ?? index + 1}`);
      return { ...segment, startOffsetUtf16: span.startOffsetUtf16, endOffsetUtf16: span.endOffsetUtf16 };
    });
    const key = (value: { entityText: string; entityCategory: StudioAssetCategory }): string => `${value.entityText}\0${value.entityCategory}`;
    const expectedByKey = new Map(expected.map((entry) => [key({ entityText: entry.text, entityCategory: entry.category }), entry] as const));
    const truePositives = proposals.filter((proposal) => expectedByKey.has(key(proposal))).length;
    const exactExpected = expected.filter((entry) => entry.expectedStatus === "matched");
    const exactCorrect = exactExpected.filter((entry) => {
      const proposal = proposals.find((candidate) => key(candidate) === key({ entityText: entry.text, entityCategory: entry.category }));
      return proposal?.status === "matched" && proposal.matchedAssetId === entry.expectedAssetIds[0];
    }).length;
    const ambiguousExpected = expected.filter((entry) => entry.expectedStatus === "ambiguous");
    const ambiguousCorrect = ambiguousExpected.filter((entry) => {
      const proposal = proposals.find((candidate) => key(candidate) === key({ entityText: entry.text, entityCategory: entry.category }));
      return proposal?.status === "ambiguous"
        && proposal.matchedAssetId === undefined
        && proposal.resolvedAssetId === undefined;
    }).length;
    const recalledAtFive = expected.filter((entry) => {
      const proposal = proposals.find((candidate) => key(candidate) === key({ entityText: entry.text, entityCategory: entry.category }));
      return Boolean(proposal && entry.expectedAssetIds.some((assetId) => proposal.candidates.slice(0, 5).some((candidate) => candidate.assetId === assetId)));
    }).length;
    const silentAmbiguitySelections = ambiguousExpected.length - ambiguousCorrect;
    metrics = {
      labeledAssets: fixture.assets.length,
      labeledSegments: expected.length,
      proposals: proposals.length,
      truePositives,
      exactExpected: exactExpected.length,
      exactCorrect,
      ambiguousExpected: ambiguousExpected.length,
      ambiguousCorrect,
      recalledAtFive,
      precision: truePositives / proposals.length,
      exactAliasAccuracy: exactCorrect / exactExpected.length,
      recallAtFive: recalledAtFive / expected.length,
      silentAmbiguitySelections,
    };
    assert(metrics.proposals === metrics.labeledSegments
      && metrics.precision === 1
      && metrics.exactAliasAccuracy === 1
      && metrics.ambiguousCorrect === metrics.ambiguousExpected
      && metrics.recallAtFive >= 0.95
      && metrics.silentAmbiguitySelections === 0,
    `P6 标注检索指标未达标：${JSON.stringify(metrics)}`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
  assert(metrics !== undefined && temporaryProjectRoot.length > 0, "P6 标注检索未产生有效指标。 ");
  await assertAbsent(parent);
  return {
    ...metrics,
    temporaryRoot,
    temporaryProjectRoot,
    cleanupVerified: true,
  };
}

async function runStructuredCheck<T>(name: string, worker: () => Promise<T>): Promise<{ result: T; log: FileEvidence }> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const logPath = path.join(runRoot, `${name}.json`);
  try {
    const result = await worker();
    await writeFile(logPath, `${JSON.stringify({
      name,
      status: "pass",
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      result,
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { result, log: await fileEvidence(logPath) };
  } catch (error) {
    await writeFile(logPath, `${JSON.stringify({
      name,
      status: "fail",
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    throw new Error(`${name} 失败；详见 ${logPath}`, { cause: error });
  }
}

function markerOccurrences(output: string, marker: string): number {
  return output.split(marker).length - 1;
}

function parseJsonMarker(output: string, marker: string): Record<string, unknown> {
  const line = output.replace(/\u001b\[[0-9;]*m/gu, "")
    .split(/\r?\n/u)
    .find((candidate) => candidate.includes(marker));
  assert(line, `targeted 实跑日志缺少 marker：${marker}`);
  const jsonText = line.slice(line.indexOf(marker) + marker.length).trim();
  assert(jsonText.startsWith("{") && jsonText.endsWith("}"),
    `targeted marker 未携带单行 JSON：${marker}`);
  const parsed = JSON.parse(jsonText) as unknown;
  assert(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    `targeted marker JSON 必须为对象：${marker}`);
  return parsed as Record<string, unknown>;
}

function validateTargetedRuntimeMarkers(output: string): {
  occurrences: Record<string, number>;
  retrieval: Record<string, unknown>;
  identityTrie: Record<string, unknown>;
} {
  const requiredMarkers = [
    "P6_RETRIEVAL_BENCHMARK",
    "P6_IDENTITY_TRIE_BENCHMARK",
    "P6_CONFIRMED_EMPTY_VERTICAL_SLICE",
    "P6_BINDING_ATOMIC_RECEIPT_MATRIX",
  ];
  const occurrences = Object.fromEntries(requiredMarkers.map((marker) => [marker, markerOccurrences(output, marker)]));
  assert(Object.entries(occurrences).every(([, count]) => count >= 1),
    `P6 targeted 实跑缺少专项 marker：${JSON.stringify(occurrences)}`);
  const retrieval = parseJsonMarker(output, "P6_RETRIEVAL_BENCHMARK");
  assert(retrieval.precision === 1
    && retrieval.exactAliasAccuracy === 1
    && typeof retrieval.recallAtFive === "number" && retrieval.recallAtFive >= 0.95
    && retrieval.silentAmbiguitySelections === 0,
  `P6_RETRIEVAL_BENCHMARK 指标未达标：${JSON.stringify(retrieval)}`);
  const identityTrie = parseJsonMarker(output, "P6_IDENTITY_TRIE_BENCHMARK");
  assert(identityTrie.assets === 10_000
    && identityTrie.groups === 30_000
    && identityTrie.panels === 6
    && typeof identityTrie.nodes === "number" && identityTrie.nodes > 0 && identityTrie.nodes < 300_000
    && typeof identityTrie.buildMs === "number" && identityTrie.buildMs < 5_000
    && typeof identityTrie.p95Ms === "number" && identityTrie.p95Ms < 500
    && typeof identityTrie.heapDeltaBytes === "number" && identityTrie.heapDeltaBytes < 512 * 1024 * 1024,
  `P6_IDENTITY_TRIE_BENCHMARK 指标未达标：${JSON.stringify(identityTrie)}`);
  return { occurrences, retrieval, identityTrie };
}

assert(isWithin(evidenceRoot, outputPath) && outputPath !== evidenceRoot,
  `P6 final evidence 必须位于 docs/evidence：${outputPath}`);
assert(isWithin(evidenceRoot, runRoot) && runRoot !== evidenceRoot,
  `P6 run root 必须位于 docs/evidence：${runRoot}`);
assert(outputPath !== explicitUiEvidencePath,
  `P6 final evidence 不得覆盖显式 UI smoke：${outputPath}`);
assert(!isWithin(runRoot, outputPath) && !isWithin(outputPath, runRoot),
  `P6 final evidence 与 run root 必须是互不嵌套的独立不可变路径：${JSON.stringify({ outputPath, runRoot })}`);
await Promise.all([assertAbsent(outputPath), assertAbsent(runRoot)]);

const planning = await assertPlanningGate();
const sourceBefore = await inventorySnapshot(sourceRoot);
assert(sourceBefore.files === expectedSource.files && sourceBefore.bytes === expectedSource.bytes
  && sourceBefore.aggregateSha256 === expectedSource.aggregateSha256,
`第三季只读源基线漂移：${JSON.stringify(sourceBefore)}`);
const workspaceSourceBefore = await workspaceSourceDigest();
const uiInputsBefore = await uiInputIdentity();
const uiEvidence = await loadExplicitLatestUiEvidence(uiInputsBefore);
const formalIdentityBefore = await assertFormalProjectIdentity();
const formalTreeBefore = await treeSnapshot(projectRoot);
const formalEmptyBefore = assertFormalProjectEmpty(formalIdentityBefore.logical, formalTreeBefore);
const p6Contracts = await validateP6Contracts();

await mkdir(runRoot, { recursive: false });

const targetedTests = [
  "tests/material-studio-identity.test.ts",
  "tests/studio-identity-lexical-index.test.ts",
  "tests/studio-panel-source-spans.test.ts",
  "tests/studio-script-section-recovery.test.ts",
  "tests/studio-asset-bindings.test.ts",
  "tests/studio-binding-control.test.ts",
  "tests/studio-binding-retrieval-benchmark.test.ts",
  "tests/panel-reference-resolution-core.test.ts",
  "tests/studio-confirmed-empty.test.ts",
  "tests/studio-generation.test.ts",
  "tests/studio-generation-ledger.test.ts",
  "tests/studio-binding-atomic-receipts.test.ts",
  "tests/studio-binding-command-bus.test.ts",
  "tests/studio-script-section-command-bus.test.ts",
  "tests/studio-command-envelope.test.ts",
  "tests/mcp-studio-binding-control.test.ts",
  "tests/studio-binding-workbench.test.ts",
  "tests/studio-binding-desktop-integration.test.ts",
];
const discoveredTestFiles = (await fg("tests/**/*.test.ts", {
  cwd: workspace,
  onlyFiles: true,
  dot: false,
  followSymbolicLinks: false,
  unique: true,
})).map((entry) => entry.split(path.sep).join("/"))
  .sort((left, right) => left.localeCompare(right, "en"));
assert(discoveredTestFiles.length > 0, "Vitest 未发现任何 tests/**/*.test.ts。 ");
assert(targetedTests.length >= MIN_TARGETED_FILES && new Set(targetedTests).size === targetedTests.length,
  `P6 targeted 文件清单不完整或重复：${JSON.stringify(targetedTests)}`);
const missingTargetedTests = targetedTests.filter((testFile) => !discoveredTestFiles.includes(testFile));
assert(missingTargetedTests.length === 0,
  `P6 targeted 专项测试未被 Vitest 发现：${JSON.stringify(missingTargetedTests)}`);

const vitest = path.join(workspace, "node_modules", ".bin", "vitest");
const tsx = path.join(workspace, "node_modules", ".bin", "tsx");
const typecheck = await runCommand("typecheck", "npm", ["run", "typecheck"], 10 * 60_000);
const targeted = await runCommand("targeted-tests", vitest, ["run", ...targetedTests, "--reporter=verbose"], 15 * 60_000);
assertTestRun(targeted.evidence, {
  minimumFilesPassed: MIN_TARGETED_FILES,
  minimumTestsPassed: MIN_TARGETED_TESTS,
});
const targetedMarkers = validateTargetedRuntimeMarkers(`${targeted.stdout}\n${targeted.stderr}`);
const retrieval = await runStructuredCheck("retrieval-benchmark", runRetrievalBenchmark);

const full = await runCommand("full-tests", "npm", ["test"], 15 * 60_000);
assertTestRun(full.evidence, {
  minimumFilesPassed: MIN_FULL_FILES,
  minimumTestsPassed: MIN_FULL_TESTS,
});
const build = await runCommand("production-build", "npm", ["run", "build"], 10 * 60_000);
const buildMcp = await runCommand("mcp-build", "npm", ["run", "build:mcp"], 10 * 60_000);
const buildIdentity = await compiledBuildIdentity();
const compiledRegistryPath = path.join(runRoot, "compiled-mcp-isolated-registry.json");
const compiledMcp = await runCommand(
  "compiled-mcp",
  tsx,
  ["scripts/mcp-smoke.ts", "dist-mcp/mcp/server.js"],
  4 * 60_000,
  { AI_CANVAS_REGISTRY_PATH: compiledRegistryPath },
);
const compiledMcpValue = JSON.parse(compiledMcp.stdout) as { toolCount?: number; tools?: string[] };
const requiredTools = ["get_studio_binding_control", "get_studio_generation_control", "execute_command"];
assert(compiledMcpValue.toolCount === expectedToolCount
  && Array.isArray(compiledMcpValue.tools)
  && compiledMcpValue.tools.length === expectedToolCount
  && new Set(compiledMcpValue.tools).size === expectedToolCount
  && requiredTools.every((tool) => compiledMcpValue.tools!.includes(tool)),
`compiled MCP P6 工具清单不完整：${JSON.stringify({ toolCount: compiledMcpValue.toolCount, requiredTools })}`);
const compiledServerPath = path.join(workspace, "dist-mcp", "mcp", "server.js");
const compiledServerText = await readFile(compiledServerPath, "utf8");
const requiredCompiledMarkers = [
  "get_studio_binding_control",
  "analyze_studio_script_entities",
  "resolve_studio_entity_proposal",
  "freeze_studio_asset_binding_set",
  "append_studio_script_section_revision",
  "list_sections",
  "get_section",
  "confirmed-empty",
];
assert(requiredCompiledMarkers.every((marker) => compiledServerText.includes(marker)),
  "compiled MCP bundle 缺少 P6 只读工具或安全命令 schema 标记。 ");
const compiledCoreContractSpecs = [
  {
    relativePath: "dist-mcp/core/panel-reference-resolution-core.js",
    markers: ["panel-reference-resolution-core-v2", "confirmed-empty", "empty-not-confirmed"],
  },
  {
    relativePath: "dist-mcp/core/studio-production.js",
    markers: ["studio_binding_operation_receipts", "binding operation receipts are append-only", "recordStudioBindingOperationReceipt"],
  },
  {
    relativePath: "dist-mcp/core/studio-generation-ledger.js",
    markers: ["dispatch-not-found", "staleReasons", "result-promotion-ineligible"],
  },
] as const;
const compiledCoreContracts = await Promise.all(compiledCoreContractSpecs.map(async (contract) => {
  const absolutePath = path.join(workspace, contract.relativePath);
  const content = await readFile(absolutePath, "utf8");
  const missingMarkers = contract.markers.filter((marker) => !content.includes(marker));
  assert(missingMarkers.length === 0,
    `compiled P6 Core 契约缺失：${contract.relativePath} => ${JSON.stringify(missingMarkers)}`);
  return {
    file: await fileEvidence(absolutePath),
    markers: [...contract.markers],
  };
}));

const [sourceAfter, workspaceSourceAfter, formalIdentityAfter, formalTreeAfter, uiEvidenceFileAfter, uiScreenshotFileAfter, uiCandidatePathsAfter] = await Promise.all([
  inventorySnapshot(sourceRoot),
  workspaceSourceDigest(),
  assertFormalProjectIdentity(),
  treeSnapshot(projectRoot),
  fileEvidence(uiEvidence.evidencePath),
  fileEvidence(uiEvidence.screenshotFile.path),
  uiEvidenceCandidatePaths(),
]);
const formalEmptyAfter = assertFormalProjectEmpty(formalIdentityAfter.logical, formalTreeAfter);
assert(JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore), "P6 最终验证期间第三季只读源发生变化。 ");
assert(JSON.stringify(workspaceSourceAfter) === JSON.stringify(workspaceSourceBefore), "P6 最终验证期间源码、测试、脚本或构建配置发生变化。 ");
assert(JSON.stringify(formalTreeAfter) === JSON.stringify(formalTreeBefore), "P6 最终验证期间正式新项目文件/目录树发生变化。 ");
assert(JSON.stringify(formalIdentityAfter.logical) === JSON.stringify(formalIdentityBefore.logical), "P6 最终验证期间正式新项目 SQLite 逻辑状态发生变化。 ");
assert(JSON.stringify(formalEmptyAfter) === JSON.stringify(formalEmptyBefore),
  "P6 最终验证期间正式新项目空库状态发生变化。 ");
assert(JSON.stringify(uiEvidenceFileAfter) === JSON.stringify(uiEvidence.evidenceFile)
  && JSON.stringify(uiScreenshotFileAfter) === JSON.stringify(uiEvidence.screenshotFile),
"P6 最终验证期间 UI smoke 证据发生变化。 ");
assert(JSON.stringify(uiCandidatePathsAfter) === JSON.stringify(uiEvidence.candidatePaths),
  "P6 最终验证期间出现了更新的 UI smoke 证据，拒绝消费旧证据。 ");

const compiledServer = await fileEvidence(compiledServerPath);
const packageLock = await fileEvidence(path.join(workspace, "package-lock.json"));
const labeledFixture = await fileEvidence(path.join(workspace, "tests", "fixtures", "p6-entity-retrieval-labeled.json"));
const evidence = {
  schemaVersion: 1,
  kind: "p6-asset-binding-final-validation",
  status: "pass",
  createdAt: new Date().toISOString(),
  scope: {
    phase: "P6",
    softwareOnly: true,
    formalSeasonProductionComplete: false,
    validatorInvokedBrowser: false,
    formalImageGenerationCalls: 0,
    browserSupplierCalls: 0,
    uploads: 0,
  },
  planning,
  formalProject: {
    root: projectRoot,
    id: formalIdentityBefore.projectId,
    name: formalIdentityBefore.projectName,
    storedProductionSchemaVersion: formalIdentityBefore.productionSchemaVersion,
    runtimeTargetProductionSchemaVersion: 4,
    migrationVerifiedByIsolatedTestsOnly: formalIdentityBefore.productionSchemaVersion === 2,
    manifest: formalIdentityBefore.manifest,
    config: formalIdentityBefore.config,
    databases: formalIdentityBefore.databases,
    logicalBefore: formalIdentityBefore.logical,
    logicalAfter: formalIdentityAfter.logical,
    emptyBefore: formalEmptyBefore,
    emptyAfter: formalEmptyAfter,
    remainsEmpty: true,
    treeBefore: formalTreeBefore,
    treeAfter: formalTreeAfter,
    unchangedDuringValidation: true,
  },
  capabilities: {
    entityRetrieval: ["exact-id", "exact-formal-name", "confirmed-alias", "max-5-candidates", "model-suggestion-only"],
    identityScale: ["trie-index", "10000-assets", "30000-identities", "six-panel-p95", "bounded-memory"],
    sourceEvidence: [
      "utf16-half-open-span",
      "script-revision",
      "script-sha256",
      "prompt-revision",
      "panel-time-range",
      "chapter-scene-section",
      "section-list-get-restart",
    ],
    decisions: [
      "matched-pending-human-accept",
      "ambiguous-human-select",
      "unmatched",
      "excluded",
      "explicit-confirmed-empty",
      "atomic-binding-receipt",
      "revision-cas",
      "stable-ui-idempotency",
    ],
    bindingSet: [
      "content-addressed",
      "required",
      "optional",
      "forbidden",
      "asset-semantic-revision",
      "authority-version",
      "panel-level-precise-currentness",
    ],
    downstream: [
      "panel-reference-resolution-core-v2",
      "generation-ready-fail-closed",
      "schema-v4-asset-binding-set-pack",
      "dispatch-required",
      "late-result-stale-retention",
      "promotion-fail-closed",
    ],
  },
  testContracts: p6Contracts,
  commandRuns: {
    typecheck: typecheck.evidence,
    targeted: targeted.evidence,
    full: full.evidence,
    build: build.evidence,
    buildMcp: buildMcp.evidence,
    compiledMcp: compiledMcp.evidence,
  },
  testDiscovery: {
    include: "tests/**/*.test.ts",
    discoveredFiles: discoveredTestFiles.length,
    files: discoveredTestFiles,
    targetedFiles: targetedTests,
    minimumThresholds: {
      targetedFiles: MIN_TARGETED_FILES,
      targetedTests: MIN_TARGETED_TESTS,
      fullFiles: MIN_FULL_FILES,
      fullTests: MIN_FULL_TESTS,
    },
    noFailuresNoSkipsNoTodoRequired: true,
    countsAreParsedFromVitestOutput: true,
    hardCodedTestCount: false,
  },
  specializedRuntimeMarkers: targetedMarkers,
  retrievalBenchmark: {
    fixture: labeledFixture,
    metrics: retrieval.result,
    thresholds: { precision: 1, exactAliasAccuracy: 1, recallAtFiveMinimum: 0.95, silentAmbiguitySelections: 0 },
    log: retrieval.log,
  },
  electronUi: {
    explicitlyProvidedByCli: true,
    minimumImmutableSequence: 4,
    selectedSequence: uiEvidence.sequence,
    latestEvidenceVerifiedByCreatedAt: uiEvidence.evidenceFile,
    candidatePaths: uiEvidence.candidatePaths,
    screenshot: uiEvidence.screenshotFile,
    screenshotInspection: uiEvidence.screenshot,
    uiInputs: uiInputsBefore,
    smoke: {
      exactAliasPendingHumanAccept: uiEvidence.parsed.ui?.exactAliasPendingHumanAccept,
      chapterAndSceneSourcesVisible: uiEvidence.parsed.ui?.chapterAndSceneSourcesVisible,
      ambiguousCandidateCount: uiEvidence.parsed.ui?.ambiguousCandidateCount,
      silentAmbiguitySelection: uiEvidence.parsed.ui?.silentAmbiguitySelection,
      resolvedDecisionVisible: uiEvidence.parsed.ui?.resolvedDecisionVisible,
      confirmedEmptyReviewedByUser: uiEvidence.parsed.ui?.confirmedEmptyReviewedByUser,
      confirmedEmptyCurrent: uiEvidence.parsed.ui?.confirmedEmptyCurrent,
      confirmedEmptyFrozen: uiEvidence.parsed.ui?.confirmedEmptyFrozen,
      bindingSetCurrent: uiEvidence.parsed.ui?.bindingSetCurrent,
      generationReady: uiEvidence.parsed.ui?.generationReady,
      nextActionAfterFirstFreeze: uiEvidence.parsed.ui?.nextActionAfterFirstFreeze,
      nextActionAfterConfirmedEmptyFreeze: uiEvidence.parsed.ui?.nextActionAfterConfirmedEmptyFreeze,
      pageErrors: uiEvidence.parsed.ui?.pageErrors,
      externalRequests: uiEvidence.parsed.ui?.externalRequests,
    },
  },
  compiledMcp: {
    toolCount: compiledMcpValue.toolCount,
    requiredTools,
    requiredCommandMarkers: requiredCompiledMarkers,
    coreContracts: compiledCoreContracts,
    server: compiledServer,
    isolatedRegistryPath: compiledRegistryPath,
  },
  source: { before: sourceBefore, after: sourceAfter, unchanged: true },
  buildIdentity: {
    workspaceSourceBefore,
    workspaceSourceAfter,
    unchanged: true,
    packageLock,
    compiled: buildIdentity,
  },
  boundedLogs: {
    maximumCapturedBytesPerCommand: MAX_CAPTURE_BYTES,
    overflowFailsValidation: true,
    commandLogsAreImmutable: true,
  },
  isolatedFixtures: {
    requiredRoot: "/tmp",
    commandEnvironment: { TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp" },
    retrievalProjectRoot: retrieval.result.temporaryProjectRoot,
    retrievalCleanupVerified: retrieval.result.cleanupVerified,
  },
  runRoot,
  boundaries: {
    formalProjectWrites: 0,
    formalSourceWrites: 0,
    formalImagesCreated: 0,
    formalVideosCreated: 0,
    externalGenerationCalls: 0,
    imagegenCalls: 0,
    browserCalls: 0,
    uploads: 0,
    gitOperations: 0,
  },
};
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({
  outputPath,
  runRoot,
  status: evidence.status,
  tests: {
    targeted: targeted.evidence.testSummary,
    full: full.evidence.testSummary,
  },
  retrieval: retrieval.result,
  compiledMcpTools: compiledMcpValue.toolCount,
  uiEvidence: { path: uiEvidence.evidencePath, sequence: uiEvidence.sequence, explicitlyProvidedByCli: true },
  formalProjectRemainsEmpty: true,
  formalProjectUnchanged: true,
  sourceUnchanged: true,
  boundaries: evidence.boundaries,
}, null, 2)}\n`);
