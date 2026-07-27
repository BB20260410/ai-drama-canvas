import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import fg from "fast-glob";
import sharp from "sharp";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

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
        "--ui-evidence 必须紧跟不可变 P7 UI smoke JSON 路径。");
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
    `P7 final validator 仅接受 workspace/project/source/output/runRoot 五个位置参数：${JSON.stringify(positional)}`);
  assert(typeof uiEvidenceArgument === "string" && uiEvidenceArgument.length > 0,
    "必须用 --ui-evidence <p7-continuity-review-ui-smoke-YYYYMMDD-NN.json> 显式传入最新不可变 UI smoke。");
  return { positional, uiEvidenceArgument };
}

const cli = parseCliArguments(process.argv.slice(2));
const workspace = await realpath(path.resolve(cli.positional[0] ?? "/Users/hxx/Documents/无限画布"));
const projectRoot = await realpath(path.resolve(
  cli.positional[1] ?? path.join(workspace, "projects", "codex-ai-drama-studio"),
));
const sourceRoot = await realpath(path.resolve(cli.positional[2] ?? "/Users/hxx/Documents/古蜀卷第三季"));
const evidenceRoot = path.join(workspace, "docs", "evidence");
const outputPath = path.resolve(
  cli.positional[3] ?? path.join(evidenceRoot, "final-validation-20260718-p7-continuity-review.json"),
);
const runRoot = path.resolve(
  cli.positional[4] ?? path.join(evidenceRoot, "runs", "p7-continuity-review-final-20260718-02"),
);
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
const expectedToolCount = 181;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MIN_TARGETED_CORE_FILES = 15;
const MIN_TARGETED_CORE_TESTS = 80;
const MIN_CHECKPOINT_FILES = 1;
const MIN_CHECKPOINT_TESTS = 1;
const MIN_TARGETED_TOTAL_FILES = 16;
const MIN_TARGETED_TOTAL_TESTS = 81;
const MIN_FULL_FILES = 101;
// 运行前按当前树静态展开 it.each 后为 587；最终仍以 Vitest 输出解析值为准。
const MIN_FULL_TESTS = 594;

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
  metaRowsByTable: Record<string, Record<string, string>[]>;
  digest: string;
}

interface P7UiEvidence {
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
    queriedUnitId?: string;
    queriedPanelId?: string;
    queriedAssetIds?: unknown[];
    continuityWriteCount?: number;
    readinessFingerprintCount?: number;
    visualReviewClaimed?: boolean;
    fixtureCleaned?: boolean;
    runtimeRootCleaned?: boolean;
  };
  ui?: {
    compiledElectronBuild?: boolean;
    startupDefaultLibrary?: boolean;
    continuityTabNotPreloadedAtStartup?: boolean;
    continuityChunkLazyLoaded?: boolean;
    lazyChunkFiles?: unknown[];
    unresolvedBeforeSeed?: {
      assetCount?: number;
      readyCount?: number;
      fieldCount?: number;
      missingFieldCount?: number;
      generationStatus?: string;
      nextActionCode?: string;
      nextActionLabel?: string;
    };
    readyAfterSeed?: {
      assetCount?: number;
      readyCount?: number;
      fieldCount?: number;
      resolvedFieldCount?: number;
      generationStatus?: string;
      nextActionCode?: string;
      nextActionLabel?: string;
      nextActionReason?: string;
      nextActionCommand?: string;
    };
    reviewControlVisible?: boolean;
    reviewControlText?: string;
    checkpointControlVisible?: boolean;
    checkpointControlText?: string;
    readyMs?: number;
    pageErrors?: number;
    consoleErrors?: number;
    rendererCrashes?: number;
    externalRequests?: number;
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
    temporaryFixtureOnly?: boolean;
    isolatedRegistry?: boolean;
    formalProjectAccesses?: number;
    formalProjectWrites?: number;
    filesystemScans?: number;
    imageGenerationCalls?: number;
    browserSupplierCalls?: number;
    uploads?: number;
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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

async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
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
    aggregateSha256: sha256(rows
      .map((entry) => `${entry.relativePath}\0${entry.bytes}\0${entry.mtimeMs}\0${entry.sha256}`)
      .join("\n")),
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
    bytes: entries.filter((entry) => entry.type === "file")
      .reduce((sum, entry) => sum + entry.sizeBytes, 0),
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
  const rows = await mapLimit(files, 8, async (relativePath) =>
    `${relativePath}\0${await sha256File(path.join(workspace, relativePath))}`);
  return { files: files.length, aggregateSha256: sha256(rows.join("\n")) };
}

async function uiInputIdentity(): Promise<{
  files: number;
  latestMtimeMs: number;
  aggregateSha256: string;
}> {
  const files = (await fg([
    "src/**/*",
    "scripts/ui-p7-continuity-review-smoke.ts",
    "package.json",
    "package-lock.json",
    "tsconfig*.json",
    "electron.vite.config.ts",
  ], { cwd: workspace, onlyFiles: true, dot: true, followSymbolicLinks: false, unique: true }))
    .map((entry) => entry.split(path.sep).join("/"))
    .sort((left, right) => left.localeCompare(right, "en"));
  assert(files.includes("scripts/ui-p7-continuity-review-smoke.ts"),
    "缺少 P7 Electron UI smoke 脚本。");
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
    const integrity = String((database.prepare("PRAGMA integrity_check").get() as {
      integrity_check?: string;
    } | undefined)?.integrity_check ?? "");
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
      tableCounts[tableName] = Number((database.prepare(`SELECT COUNT(*) AS count FROM "${quoted}"`)
        .get() as { count: number }).count);
    }
    const metaRowsByTable: Record<string, Record<string, string>[]> = {};
    for (const tableName of tableNames.filter((name) => name.endsWith("_meta"))) {
      const quoted = tableName.replaceAll('"', '""');
      metaRowsByTable[tableName] = database.prepare(`SELECT key, value FROM "${quoted}" ORDER BY key`)
        .all() as Record<string, string>[];
    }
    const schemaSha256 = sha256(JSON.stringify(schemaRows));
    return {
      databasePath,
      integrity,
      schemaSha256,
      tableCounts,
      metaRowsByTable,
      digest: sha256(JSON.stringify({ schemaSha256, tableCounts, metaRowsByTable })),
    };
  } finally {
    database.close();
  }
}

function assertZeroBusinessRows(snapshot: SqliteLogicalSnapshot): void {
  const nonZero = Object.entries(snapshot.tableCounts)
    .filter(([name, count]) => !name.endsWith("_meta") && name !== "sqlite_sequence" && count !== 0);
  assert(nonZero.length === 0,
    `正式受管工程必须保持零业务数据：${snapshot.databasePath} => ${JSON.stringify(nonZero)}`);
}

function assertFormalProjectEmpty(
  logical: {
    material: SqliteLogicalSnapshot;
    production: SqliteLogicalSnapshot;
    generation: SqliteLogicalSnapshot;
  },
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
      .filter(([name]) => !name.endsWith("_meta") && name !== "sqlite_sequence")
      .reduce((tableTotal, [, count]) => tableTotal + count, 0), 0);
  const files = tree.entries.filter((entry) => entry.type === "file");
  const countFiles = (prefix: string): number =>
    files.filter((entry) => entry.relativePath.startsWith(prefix)).length;
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

function metaValue(snapshot: SqliteLogicalSnapshot, tableName: string, key: string): string | undefined {
  return snapshot.metaRowsByTable[tableName]?.find((row) => row.key === key)?.value;
}

async function assertFormalProjectIdentity(): Promise<{
  manifest: FileEvidence;
  config: FileEvidence;
  projectId: string;
  projectName: string;
  schemaVersions: { material: number; production: number; generation: number };
  databases: { material: string; production: string; generation: string };
  logical: {
    material: SqliteLogicalSnapshot;
    production: SqliteLogicalSnapshot;
    generation: SqliteLogicalSnapshot;
  };
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
  "正式受管工程 manifest 身份或隔离策略漂移。");
  assert(config.id === expectedProject.id && config.name === expectedProject.name
    && path.resolve(config.primaryRoot ?? "") === projectRoot
    && Array.isArray(config.sourceRoots) && config.sourceRoots.length === 0
    && Array.isArray(config.outputRoots) && config.outputRoots.length === 1
    && path.resolve(String(config.outputRoots[0])) === projectRoot,
  "正式受管工程 config 身份、sourceRoots=[] 或唯一写根漂移。");
  const relativePaths = manifest.relativePaths ?? {};
  const resolveManaged = (key: string): string => {
    const relativePath = relativePaths[key];
    assert(typeof relativePath === "string" && relativePath.length > 0,
      `正式 manifest 缺少路径：${key}`);
    const absolutePath = path.resolve(projectRoot, relativePath);
    assert(isWithin(projectRoot, absolutePath) && absolutePath !== projectRoot,
      `正式 manifest 路径越界：${key}=${absolutePath}`);
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
  const schemaVersions = {
    material: Number(metaValue(logical.material, "studio_meta", "schema_version") ?? 0),
    production: Number(metaValue(logical.production, "studio_production_meta", "schema_version") ?? 0),
    generation: Number(metaValue(logical.generation, "studio_generation_ledger_meta", "schema_version") ?? 0),
  };
  assert(schemaVersions.material === 1, "正式素材库 schema_version 漂移。");
  assert(schemaVersions.production === 2 || schemaVersions.production === 4,
    `正式生产库只接受已知空库 schema：${schemaVersions.production}`);
  assert([1, 2, 3].includes(schemaVersions.generation),
    `正式生成账本只接受已知空库 schema：${schemaVersions.generation}`);
  return {
    manifest: await fileEvidence(manifestPath),
    config: await fileEvidence(configPath),
    projectId: config.id,
    projectName: config.name,
    schemaVersions,
    databases,
    logical,
  };
}

async function compiledBuildIdentity(): Promise<{ files: BuildIdentityEntry[]; aggregateSha256: string }> {
  const relativePaths = (await fg([
    "out/main/index.js",
    "out/preload/index.mjs",
    "out/renderer/index.html",
    "out/renderer/assets/*",
    "dist-mcp/core/*.js",
    "dist-mcp/mcp/server.js",
  ], { cwd: workspace, onlyFiles: true, dot: false, followSymbolicLinks: false, unique: true }))
    .map((entry) => entry.split(path.sep).join("/"))
    .sort((left, right) => left.localeCompare(right, "en"));
  assert(relativePaths.includes("out/main/index.js")
    && relativePaths.includes("out/preload/index.mjs")
    && relativePaths.includes("out/renderer/index.html")
    && relativePaths.some((entry) => entry.startsWith("out/renderer/assets/"))
    && relativePaths.includes("dist-mcp/mcp/server.js"),
  "production/MCP build 缺少 main/preload/renderer/server 身份文件。");
  const files = await Promise.all(relativePaths.map(async (relativePath) => {
    const absolutePath = path.join(workspace, relativePath);
    const metadata = await stat(absolutePath);
    return { relativePath, sizeBytes: metadata.size, sha256: await sha256File(absolutePath) };
  }));
  return { files, aggregateSha256: sha256(JSON.stringify(files)) };
}

function parseTestSummary(output: string): TestSummary | undefined {
  const normalized = output.replace(/\u001b\[[0-9;]*m/gu, "");
  const filesLine = normalized.match(/^\s*Test Files\s+(.+)$/mu)?.[1];
  const testsLine = normalized.match(/^\s*Tests\s+(.+)$/mu)?.[1];
  if (!filesLine || !testsLine) return undefined;
  const metric = (line: string, label: string): number =>
    Number(line.match(new RegExp(`(\\d+)\\s+${label}`, "u"))?.[1] ?? 0);
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
  process.stderr.write(`[P7 final] ${name}\n`);
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
  assert(!result.timedOut && !result.outputOverflow && result.exitCode === 0,
    `${name} 失败；详见 ${logPath}`);
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

function combinedTestSummary(...summaries: TestSummary[]): TestSummary {
  return summaries.reduce<TestSummary>((total, summary) => ({
    filesPassed: total.filesPassed + summary.filesPassed,
    filesFailed: total.filesFailed + summary.filesFailed,
    testsPassed: total.testsPassed + summary.testsPassed,
    testsFailed: total.testsFailed + summary.testsFailed,
    filesSkipped: total.filesSkipped + summary.filesSkipped,
    testsSkipped: total.testsSkipped + summary.testsSkipped,
    testsTodo: total.testsTodo + summary.testsTodo,
    filesTotal: total.filesTotal + summary.filesTotal,
    testsTotal: total.testsTotal + summary.testsTotal,
  }), {
    filesPassed: 0,
    filesFailed: 0,
    testsPassed: 0,
    testsFailed: 0,
    filesSkipped: 0,
    testsSkipped: 0,
    testsTodo: 0,
    filesTotal: 0,
    testsTotal: 0,
  });
}

async function assertPlanningGate(): Promise<{
  activePlan: FileEvidence;
  taskPlan: FileEvidence;
  attestation: FileEvidence;
  mode: string;
  stopBlocks: number;
  currentPhase: "P7";
  p7Status: "in_progress";
}> {
  const activePlanPath = path.join(workspace, ".planning", ".active_plan");
  const taskPlanPath = path.join(planningRoot, "task_plan.md");
  const attestationPath = path.join(planningRoot, ".attestation");
  const modePath = path.join(planningRoot, ".mode");
  const stopBlocksPath = path.join(planningRoot, ".stop_blocks");
  const [activePlan, taskPlan, attestation, mode, stopBlocks] = await Promise.all([
    readFile(activePlanPath, "utf8"),
    readFile(taskPlanPath, "utf8"),
    readFile(attestationPath, "utf8"),
    readFile(modePath, "utf8"),
    readFile(stopBlocksPath, "utf8"),
  ]);
  assert(activePlan.trim() === "2026-07-17-ai-p0-p10",
    `活动 planning 漂移：${activePlan.trim()}`);
  assert(attestation.trim() === sha256(taskPlan),
    "P7 task_plan attestation 与当前文件 SHA 不一致。");
  assert(mode.trim() === "autonomous gate", `P7 planning 模式漂移：${mode.trim()}`);
  assert(stopBlocks.trim() === "0", `P7 planning stop_blocks 非零：${stopBlocks.trim()}`);
  assert(/## Current Phase\s*\nP7：正式连续性账本与 Review 写回/u.test(taskPlan),
    "当前 planning 阶段不是 P7。");
  const p6Section = taskPlan.match(/### P6:[\s\S]*?\*\*Status:\*\* (in_progress|completed|pending)/u);
  const p7Section = taskPlan.match(/### P7:[\s\S]*?\*\*Status:\*\* (in_progress|completed|pending)/u);
  const p8Section = taskPlan.match(/### P8:[\s\S]*?\*\*Status:\*\* (in_progress|completed|pending)/u);
  assert(p6Section?.[1] === "completed" && p7Section?.[1] === "in_progress" && p8Section?.[1] === "pending",
    `P7 阶段顺序或状态漂移：${JSON.stringify({
      p6: p6Section?.[1], p7: p7Section?.[1], p8: p8Section?.[1],
    })}`);
  return {
    activePlan: await fileEvidence(activePlanPath),
    taskPlan: await fileEvidence(taskPlanPath),
    attestation: await fileEvidence(attestationPath),
    mode: mode.trim(),
    stopBlocks: Number(stopBlocks.trim()),
    currentPhase: "P7",
    p7Status: "in_progress",
  };
}

async function validateP7Contracts(): Promise<Array<{
  capability: string;
  file: FileEvidence;
  markers: string[];
}>> {
  const contracts: Array<{ capability: string; relativePath: string; markers: string[] }> = [
    {
      capability: "fixed-nine-field-continuity-contract",
      relativePath: "src/core/studio-continuity.ts",
      markers: [
        "export const STUDIO_CONTINUITY_FIELDS = [",
        '"referenceSha256"',
        "STUDIO_CONTINUITY_UNIT_DURATION_MILLISECONDS = 15_000",
        "required-state-gap",
      ],
    },
    {
      capability: "continuity-ledger-same-sqlite-append-only",
      relativePath: "src/core/studio-continuity-ledger.ts",
      markers: [
        'const CONTINUITY_SCHEMA_MARKER = "studio_continuity_schema_version"',
        "studio_generation_ledger_meta",
        "continuity entries are append-only",
        "continuity receipts are append-only",
      ],
    },
    {
      capability: "panel-reference-resolution-v3-continuity-frame",
      relativePath: "src/core/panel-reference-resolution-core.ts",
      markers: [
        'schemaVersion: 3',
        '"continuity-frame"',
        'entry.kind === "continuity-frame" ? "continuity"',
        "overflowControlReferences",
      ],
    },
    {
      capability: "generation-v4-continuity-and-previous-raw",
      relativePath: "src/core/studio-generation.ts",
      markers: [
        "schemaVersion: 4;",
        "previousApprovedRawReviewId",
        "continuityFrame",
        "previous-panel-not-adjacent",
        "continuity-not-ready",
      ],
    },
    {
      capability: "real-dispatch-checkpoint-gate",
      relativePath: "src/core/studio-generation-ledger.ts",
      markers: [
        'await import("./studio-generation-checkpoint.js")',
        "assertStudioGenerationCheckpointDispatchAllowed",
        "pack-schema-unsupported",
      ],
    },
    {
      capability: "generation-review-pack-continuity-binding",
      relativePath: "src/core/studio-generation-review.ts",
      markers: [
        "pack.continuity.fingerprint !== input.continuityFingerprint",
        "generation review events are append-only",
        "generation review receipts are append-only",
      ],
    },
    {
      capability: "six-image-checkpoint-cas-receipts",
      relativePath: "src/core/studio-generation-checkpoint.ts",
      markers: [
        "studio_generation_checkpoint_snapshots",
        "studio_generation_checkpoint_attestations",
        "studio_generation_checkpoint_operation_receipts",
        "readStudioGenerationCheckpointOperationReceipt",
        "checkpoint snapshots are append-only",
      ],
    },
    {
      capability: "bounded-continuity-review-control",
      relativePath: "src/core/studio-continuity-review-control.ts",
      markers: [
        "STUDIO_CONTINUITY_REVIEW_ASSET_LIMIT = 6",
        "STUDIO_CONTINUITY_REVIEW_TIMELINE_LIMIT = 36",
        "STUDIO_CONTINUITY_REVIEW_HISTORY_LIMIT = 20",
        "STUDIO_CONTINUITY_REVIEW_CHECKPOINT_LIMIT = 12",
        '"resolve-generation-input"',
        '"freeze-generation-pack"',
      ],
    },
    {
      capability: "central-studio-command-routing",
      relativePath: "src/core/command-bus.ts",
      markers: [
        '"append_studio_continuity_observation"',
        '"append_studio_continuity_correction"',
        '"submit_studio_generation_review"',
        '"refresh_studio_generation_checkpoint"',
        '"attest_studio_generation_checkpoint"',
        'withProjectLock(root, "studio-mutation"',
      ],
    },
    {
      capability: "mcp-read-and-execute-only-surface",
      relativePath: "src/mcp/server.ts",
      markers: [
        '"get_studio_continuity_review_control"',
        'command: z.literal("append_studio_continuity_observation")',
        'command: z.literal("append_studio_continuity_correction")',
        'command: z.literal("submit_studio_generation_review")',
        'command: z.literal("refresh_studio_generation_checkpoint")',
        'command: z.literal("attest_studio_generation_checkpoint")',
        "MCP/Codex 的 Studio 裁决 reviewer 必须是 codex",
      ],
    },
    {
      capability: "desktop-read-boundary",
      relativePath: "src/main/index.ts",
      markers: [
        '"canvas:get-studio-continuity-review-control"',
        "桌面 UI 的 Studio 裁决 reviewer 必须是 user",
      ],
    },
    {
      capability: "preload-read-boundary",
      relativePath: "src/preload/index.ts",
      markers: ["getStudioContinuityReviewControl", "canvas:get-studio-continuity-review-control"],
    },
    {
      capability: "lazy-continuity-review-ui",
      relativePath: "src/renderer/src/components/MaterialStudioView.vue",
      markers: [
        "连续性 / Review",
        'defineAsyncComponent(() => import("./StudioContinuityReviewView.vue"))',
        "正在按需加载连续性 / Review 控制面",
      ],
    },
    {
      capability: "ui-core-next-action-only",
      relativePath: "src/renderer/src/components/StudioContinuityReviewView.vue",
      markers: [
        'data-testid="studio-continuity-review-view"',
        "连续性 / Review",
        "nextAction",
      ],
    },
    {
      capability: "deterministic-p7-fixture",
      relativePath: "tests/helpers/studio-p7-fixture.ts",
      markers: [
        "STUDIO_P7_CONTINUITY_FIELD_NAMES",
        "seedStudioP7ResolvedContinuity",
        'visualReviewClaimed: false',
      ],
    },
    {
      capability: "real-checkpoint-dispatch-test",
      relativePath: "tests/studio-generation-checkpoint.test.ts",
      markers: [
        "六槽阻断第七槽，pass 解锁；Review correction 使旧批准派生失效并要求重批准",
        "readStudioGenerationDispatch",
        "AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE",
      ],
    },
    {
      capability: "compiled-mcp-schema-contract-test",
      relativePath: "tests/mcp-studio-continuity-review.test.ts",
      markers: [
        "只扩展统一 execute_command schema",
        "AI_CANVAS_TEST_COMPILED_MCP",
        "operationId|headKey|receiptId|requestFingerprint",
      ],
    },
    {
      capability: "immutable-p7-ui-smoke-writer",
      relativePath: "scripts/ui-p7-continuity-review-smoke.ts",
      markers: [
        'kind: "p7-continuity-review-ui-smoke"',
        "continuityTabNotPreloadedAtStartup: true",
        "continuityChunkLazyLoaded: true",
        "formalProjectAccesses: 0",
        'flag: "wx"',
      ],
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
        throw new Error(`P7 专项验收文件缺失：${contract.relativePath} [${contract.capability}]`);
      }
      throw error;
    }
    const missingMarkers = contract.markers.filter((marker) => !content.includes(marker));
    assert(missingMarkers.length === 0,
      `P7 验收契约 marker 缺失：${contract.relativePath} [${contract.capability}] => ${JSON.stringify(missingMarkers)}`);
    result.push({
      capability: contract.capability,
      file: await fileEvidence(absolutePath),
      markers: contract.markers,
    });
  }
  return result;
}

async function uiEvidenceCandidatePaths(): Promise<string[]> {
  return (await fg("p7-continuity-review-ui-smoke-*.json", {
    cwd: evidenceRoot,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    unique: true,
  })).filter((entry) => /^p7-continuity-review-ui-smoke-\d{8}-\d{2,}\.json$/u.test(entry))
    .map((entry) => path.join(evidenceRoot, entry))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function uiEvidenceSequence(filePath: string): number {
  const match = path.basename(filePath)
    .match(/^p7-continuity-review-ui-smoke-\d{8}-(\d{2,})\.json$/u);
  assert(match, `P7 UI 证据必须使用带序号的不可变文件名：${filePath}`);
  const sequence = Number(match[1]);
  assert(Number.isInteger(sequence) && sequence >= 1,
    `P7 final 只接受有效序号 UI smoke：${filePath}`);
  return sequence;
}

async function loadExplicitLatestUiEvidence(
  uiInputs: Awaited<ReturnType<typeof uiInputIdentity>>,
): Promise<{
  candidatePaths: string[];
  evidencePath: string;
  sequence: number;
  evidenceFile: FileEvidence;
  screenshotFile: FileEvidence;
  parsed: P7UiEvidence;
  screenshot: { width: number; height: number; format: string; stdev: number };
}> {
  assert(isWithin(evidenceRoot, explicitUiEvidencePath) && explicitUiEvidencePath !== evidenceRoot,
    `--ui-evidence 必须位于 docs/evidence：${explicitUiEvidencePath}`);
  const explicitSequence = uiEvidenceSequence(explicitUiEvidencePath);
  const candidatePaths = await uiEvidenceCandidatePaths();
  assert(candidatePaths.length > 0, "缺少 P7 continuity / Review UI smoke 机器证据。");
  const candidates = await Promise.all(candidatePaths.map(async (candidatePath) => {
    const metadata = await lstat(candidatePath);
    assert(metadata.isFile() && !metadata.isSymbolicLink(),
      `P7 UI 证据不是普通文件：${candidatePath}`);
    const parsed = JSON.parse(await readFile(candidatePath, "utf8")) as P7UiEvidence;
    const createdAtMs = Date.parse(parsed.createdAt ?? "");
    assert(Number.isFinite(createdAtMs), `P7 UI 证据 createdAt 无效：${candidatePath}`);
    const match = path.basename(candidatePath)
      .match(/^p7-continuity-review-ui-smoke-(\d{8})-(\d{2,})\.json$/u);
    assert(match, `P7 UI 证据文件名无法解析：${candidatePath}`);
    return {
      candidatePath,
      parsed,
      createdAtMs,
      date: Number(match[1]),
      sequence: Number(match[2]),
    };
  }));
  candidates.sort((left, right) => right.date - left.date
    || right.sequence - left.sequence
    || right.createdAtMs - left.createdAtMs
    || right.candidatePath.localeCompare(left.candidatePath, "en"));
  const latest = candidates[0]!;
  assert(latest.candidatePath === explicitUiEvidencePath,
    `--ui-evidence 必须显式指向当前最新不可变 UI smoke：${JSON.stringify({
      provided: explicitUiEvidencePath,
      latest: latest.candidatePath,
    })}`);
  assert(latest.sequence === explicitSequence, "P7 UI smoke 序号在候选扫描中发生漂移。");
  assert(latest.createdAtMs <= Date.now() + 5 * 60_000,
    `P7 UI 证据时间位于未来：${latest.candidatePath}`);
  const evidenceFile = await fileEvidence(latest.candidatePath);
  assert(latest.createdAtMs >= uiInputs.latestMtimeMs && evidenceFile.mtimeMs >= uiInputs.latestMtimeMs,
    `最新 P7 UI 证据早于当前 UI/runtime 源码，必须重跑 smoke：${latest.candidatePath}`);
  const screenshotPath = path.resolve(latest.parsed.screenshot?.path ?? "");
  assert(isWithin(evidenceRoot, screenshotPath) && screenshotPath !== evidenceRoot,
    `P7 UI 截图路径越出 docs/evidence：${screenshotPath}`);
  assert(path.basename(screenshotPath) === `${path.basename(latest.candidatePath, ".json")}.png`,
    `P7 UI JSON 与截图必须为同一不可变序号对：${JSON.stringify({
      json: latest.candidatePath,
      screenshotPath,
    })}`);
  const screenshotMetadata = await lstat(screenshotPath);
  assert(screenshotMetadata.isFile() && !screenshotMetadata.isSymbolicLink(),
    `P7 UI 截图不是普通文件：${screenshotPath}`);
  const screenshotFile = await fileEvidence(screenshotPath);
  const [metadata, stats] = await Promise.all([
    sharp(screenshotPath).metadata(),
    sharp(screenshotPath).stats(),
  ]);
  const stdev = Math.max(...stats.channels.map((channel) => channel.stdev));
  const before = latest.parsed.ui?.unresolvedBeforeSeed;
  const after = latest.parsed.ui?.readyAfterSeed;
  assert(latest.parsed.schemaVersion === 1
    && latest.parsed.kind === "p7-continuity-review-ui-smoke"
    && latest.parsed.status === "pass"
    && latest.parsed.fixture?.sourceRoots?.length === 0
    && latest.parsed.fixture.units === 2
    && latest.parsed.fixture.panels === 8
    && latest.parsed.fixture.canonicalAssets === 3
    && latest.parsed.fixture.queriedAssetIds?.length === 3
    && latest.parsed.fixture.continuityWriteCount === 216
    && latest.parsed.fixture.readinessFingerprintCount === 24
    && latest.parsed.fixture.visualReviewClaimed === false
    && latest.parsed.fixture.fixtureCleaned === true
    && latest.parsed.fixture.runtimeRootCleaned === true
    && latest.parsed.ui?.compiledElectronBuild === true
    && latest.parsed.ui.startupDefaultLibrary === true
    && latest.parsed.ui.continuityTabNotPreloadedAtStartup === true
    && latest.parsed.ui.continuityChunkLazyLoaded === true
    && Array.isArray(latest.parsed.ui.lazyChunkFiles)
    && latest.parsed.ui.lazyChunkFiles.length >= 1
    && before?.assetCount === 3
    && before.readyCount === 0
    && before.fieldCount === 27
    && before.missingFieldCount === 27
    && before.generationStatus === "blocked"
    && before.nextActionCode === "record-continuity-state"
    && after?.assetCount === 3
    && after.readyCount === 3
    && after.fieldCount === 27
    && after.resolvedFieldCount === 27
    && after.generationStatus === "ready"
    && after.nextActionCode === "freeze-generation-pack"
    && after.nextActionCommand === "freeze_studio_generation_pack"
    && latest.parsed.ui.reviewControlVisible === true
    && latest.parsed.ui.reviewControlText?.includes("GENERATION REVIEW")
    && latest.parsed.ui.checkpointControlVisible === true
    && latest.parsed.ui.checkpointControlText?.includes("SIX IMAGE CHECKPOINT")
    && Number.isFinite(latest.parsed.ui.readyMs) && (latest.parsed.ui.readyMs ?? 0) > 0
    && latest.parsed.ui.pageErrors === 0
    && latest.parsed.ui.consoleErrors === 0
    && latest.parsed.ui.rendererCrashes === 0
    && latest.parsed.ui.externalRequests === 0
    && latest.parsed.screenshot?.path === screenshotPath
    && latest.parsed.screenshot.sizeBytes === screenshotFile.sizeBytes
    && latest.parsed.screenshot.sha256 === screenshotFile.sha256
    && latest.parsed.boundaries?.temporaryFixtureOnly === true
    && latest.parsed.boundaries.isolatedRegistry === true
    && latest.parsed.boundaries.formalProjectAccesses === 0
    && latest.parsed.boundaries.formalProjectWrites === 0
    && latest.parsed.boundaries.filesystemScans === 0
    && latest.parsed.boundaries.imageGenerationCalls === 0
    && latest.parsed.boundaries.browserSupplierCalls === 0
    && latest.parsed.boundaries.uploads === 0,
  "P7 UI smoke 未证明惰性加载、九字段阻断→就绪、Review/checkpoint 可见、清理完成或零外部副作用。");
  assert((metadata.width ?? 0) >= 1_500 && (metadata.height ?? 0) >= 900
    && screenshotFile.sizeBytes >= 35_000 && metadata.format === "png" && stdev >= 5
    && latest.parsed.screenshot.width === metadata.width
    && latest.parsed.screenshot.height === metadata.height
    && latest.parsed.screenshot.format === metadata.format
    && Math.abs((latest.parsed.screenshot.stdev ?? 0) - stdev) < 0.000_001,
  "P7 UI 截图疑似空白、占位、损坏或机器证据漂移。");
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

function markerOccurrences(output: string, marker: string): number {
  return output.split(marker).length - 1;
}

function parseJsonMarker(output: string, marker: string): Record<string, unknown> {
  const line = output.replace(/\u001b\[[0-9;]*m/gu, "")
    .split(/\r?\n/u)
    .find((candidate) => candidate.includes(marker));
  assert(line, `P7 targeted 实跑日志缺少 marker：${marker}`);
  const jsonText = line.slice(line.indexOf(marker) + marker.length).trim();
  assert(jsonText.startsWith("{") && jsonText.endsWith("}"),
    `P7 targeted marker 未携带单行 JSON：${marker}`);
  const parsed = JSON.parse(jsonText) as unknown;
  assert(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    `P7 targeted marker JSON 必须为对象：${marker}`);
  return parsed as Record<string, unknown>;
}

function validateTargetedRuntimeMarkers(
  coreOutput: string,
  checkpointOutput: string,
): {
  occurrences: Record<string, number>;
  fixture: Record<string, unknown>;
  discontinuousSpans: Record<string, unknown>;
  reviewAppendOnly: Record<string, unknown>;
  reviewStale: Record<string, unknown>;
  reviewCasRecovery: Record<string, unknown>;
  verboseContracts: string[];
  checkpointVerboseContracts: string[];
} {
  const requiredJsonMarkers = [
    "P7_DETERMINISTIC_FIXTURE_CONTRACT",
    "P7_DISCONTINUOUS_SPAN_GAPS",
    "P7_REVIEW_APPEND_ONLY_CAS",
    "P7_REVIEW_STALE_HISTORICAL_ONLY",
    "P7_REVIEW_CAS_RECOVERY_CURSOR",
  ];
  const occurrences = Object.fromEntries(requiredJsonMarkers
    .map((marker) => [marker, markerOccurrences(coreOutput, marker)]));
  assert(Object.entries(occurrences).every(([, count]) => count >= 1),
    `P7 targeted 实跑缺少专项 JSON marker：${JSON.stringify(occurrences)}`);
  const fixture = parseJsonMarker(coreOutput, "P7_DETERMINISTIC_FIXTURE_CONTRACT");
  assert(fixture.temporaryOnly === true
    && fixture.sourceRootsEmpty === true
    && fixture.units === 2
    && fixture.panels === 8
    && fixture.canonicalAssets === 3
    && fixture.bindingSets === 8
    && fixture.rawLabeledPairs === 8
    && fixture.visualReviewClaimed === false,
  `P7_DETERMINISTIC_FIXTURE_CONTRACT 无效：${JSON.stringify(fixture)}`);
  const discontinuousSpans = parseJsonMarker(coreOutput, "P7_DISCONTINUOUS_SPAN_GAPS");
  assert(discontinuousSpans.fieldCount === 9
    && discontinuousSpans.halfOpen === true
    && discontinuousSpans.explicitSpanCount === 2
    && discontinuousSpans.gapAtMilliseconds === 3_000
    && discontinuousSpans.gapFilled === false
    && discontinuousSpans.panelMinimum === 2
    && discontinuousSpans.panelMaximum === 6
    && discontinuousSpans.unitDurationMilliseconds === 15_000,
  `P7_DISCONTINUOUS_SPAN_GAPS 无效：${JSON.stringify(discontinuousSpans)}`);
  const reviewAppendOnly = parseJsonMarker(coreOutput, "P7_REVIEW_APPEND_ONLY_CAS");
  assert(reviewAppendOnly.history === 2 && reviewAppendOnly.upstreamMutationCount === 0,
    `P7_REVIEW_APPEND_ONLY_CAS 无效：${JSON.stringify(reviewAppendOnly)}`);
  const reviewStale = parseJsonMarker(coreOutput, "P7_REVIEW_STALE_HISTORICAL_ONLY");
  assert(Array.isArray(reviewStale.drifted) && reviewStale.drifted.length === 3
    && reviewStale.historyCount === 2
    && reviewStale.headRevision === 1
    && reviewStale.staleAdvancedHead === false
    && reviewStale.upstreamMutationByReview === false,
  `P7_REVIEW_STALE_HISTORICAL_ONLY 无效：${JSON.stringify(reviewStale)}`);
  const reviewCasRecovery = parseJsonMarker(coreOutput, "P7_REVIEW_CAS_RECOVERY_CURSOR");
  assert(reviewCasRecovery.concurrentFulfilled === 1
    && reviewCasRecovery.concurrentRejected === 1
    && reviewCasRecovery.crossRunCursorRejected === true
    && reviewCasRecovery.upstreamMutationByReview === false,
  `P7_REVIEW_CAS_RECOVERY_CURSOR 无效：${JSON.stringify(reviewCasRecovery)}`);

  const verboseContracts = [
    "保留 source-shot 离散半开区间与真实空档，readiness 不填洞且阻断 unresolved",
    "提供 operation idempotency、同键异载荷拒绝与 head CAS，失败时不遗留半事务 receipt",
    "持久化重叠异值 conflict，不做 last-write-wins，并由 correction 显式解决",
    "上一格已验收 raw 作为 continuity-frame 进入同一闭包，但不重复计算 identity 覆盖",
    "九字段缺失时失败关闭；显式 seeding 后只渲染 ledger resolved/not-applicable，不采信 legacy continuityState",
    "previous raw 只在显式 current pass Review 且同集紧邻时注入，跨单元边界也可机械证明",
    "schema v3 pack 仅历史读取；dispatch/register/promotion 均失败且不改写旧 CAS",
    "预检读取后 script/BindingSet/Authority 漂移时，correction 只追加历史且不移动 Head",
    "同 Head 并发 correction 仅一个成功，同 operationId 异载荷零写，重启可恢复且 cursor 不串 run",
    "Observation 与 Correction 使用 request hash 回执、同键回放并拒绝异载荷和私有字段",
    "Generation Review 支持 user 写面、同键回放，并在崩溃后只凭 Review operation receipt 对账",
    "只扩展统一 execute_command schema，Codex Review reviewer 固定且真实写入走中心分类器",
    "在 /tmp fixture 上显示九字段缺口，显式 seed 后变为 ready 且时间线只返回请求页",
    "纯分页器面对万项投影也只返回受控窗口，不把大列表传给 UI/MCP",
    "只新增严格只读命名工具，限制六资产与所有列表页，不新增命名写工具",
    "组件惰性读取并直接渲染 Core nextAction，不在前端维护第二套业务状态",
    "素材中心第三个 tab 才惰性加载控制面，默认仍停留素材库",
  ];
  const missingVerboseContracts = verboseContracts.filter((title) => !coreOutput.includes(title));
  assert(missingVerboseContracts.length === 0,
    `P7 targeted verbose 日志缺少关键合同测试：${JSON.stringify(missingVerboseContracts)}`);

  const checkpointVerboseContracts = [
    "六槽阻断第七槽，pass 解锁；Review correction 使旧批准派生失效并要求重批准",
  ];
  const missingCheckpointContracts = checkpointVerboseContracts
    .filter((title) => !checkpointOutput.includes(title));
  assert(missingCheckpointContracts.length === 0,
    `P7 checkpoint verbose 日志缺少真实 dispatch/receipt 合同：${JSON.stringify(missingCheckpointContracts)}`);
  return {
    occurrences,
    fixture,
    discontinuousSpans,
    reviewAppendOnly,
    reviewStale,
    reviewCasRecovery,
    verboseContracts,
    checkpointVerboseContracts,
  };
}

async function writeCompiledMcpSchemaProbe(): Promise<FileEvidence> {
  const probePath = path.join(runRoot, "compiled-mcp-p7-schema-probe.mjs");
  const probe = `
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = path.resolve(process.argv[2]);
const expectedToolCount = 181;
const writeCommands = [
  "append_studio_continuity_observation",
  "append_studio_continuity_correction",
  "submit_studio_generation_review",
  "refresh_studio_generation_checkpoint",
  "attest_studio_generation_checkpoint",
];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: process.cwd(),
  env: { ...process.env },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
const client = new Client({ name: "p7-final-schema-probe", version: "1.0.0" });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  if (names.length !== expectedToolCount || new Set(names).size !== expectedToolCount) {
    throw new Error("compiled MCP tool count/uniqueness mismatch: " + names.length);
  }
  if (writeCommands.some((name) => names.includes(name))) {
    throw new Error("P7 write command was exposed as a named MCP tool");
  }
  const readTool = listed.tools.find((tool) => tool.name === "get_studio_continuity_review_control");
  if (!readTool || readTool.annotations?.readOnlyHint !== true || readTool.annotations?.openWorldHint !== false) {
    throw new Error("compiled P7 read tool annotations missing");
  }
  const readSchema = readTool.inputSchema;
  const query = readSchema?.properties?.query;
  const requiredRead = ["unitId", "unitRevision", "panelId", "startMilliseconds", "endMilliseconds", "assetIds"];
  if (JSON.stringify(readSchema?.required) !== JSON.stringify(["projectRoot", "query"])
      || !requiredRead.every((key) => query?.required?.includes(key))
      || query?.additionalProperties !== false
      || query?.properties?.assetIds?.maxItems !== 6
      || query?.properties?.timelineLimit?.maximum !== 36
      || query?.properties?.conflictLimit?.maximum !== 36
      || query?.properties?.reviewLimit?.maximum !== 20
      || query?.properties?.checkpointLimit?.maximum !== 12) {
    throw new Error("compiled P7 read schema mismatch");
  }
  const executeTool = listed.tools.find((tool) => tool.name === "execute_command");
  const executeSchema = executeTool?.inputSchema;
  const executePropertyKeys = Object.keys(executeSchema?.properties ?? {}).sort();
  if (!executeTool
      || executeTool.annotations?.readOnlyHint !== false
      || executeTool.annotations?.destructiveHint !== false
      || executeTool.annotations?.idempotentHint !== true
      || executeTool.annotations?.openWorldHint !== false
      || executeSchema?.type !== "object"
      || executeSchema?.additionalProperties !== undefined
      || JSON.stringify(executePropertyKeys)
        !== JSON.stringify(["idempotencyKey", "projectRoot", "request", "requestId"])
      || JSON.stringify(executeSchema?.required)
        !== JSON.stringify(["requestId", "idempotencyKey", "request"])
      || executeSchema?.properties?.projectRoot?.type !== "string"
      || typeof executeSchema?.properties?.projectRoot?.default !== "string"
      || executeSchema?.properties?.requestId?.minLength !== 8
      || executeSchema?.properties?.requestId?.maxLength !== 160
      || executeSchema?.properties?.idempotencyKey?.minLength !== 8
      || executeSchema?.properties?.idempotencyKey?.maxLength !== 200) {
    throw new Error("compiled execute_command root schema mismatch");
  }
  const variants = executeSchema?.properties?.request?.oneOf
    ?? executeSchema?.properties?.request?.anyOf
    ?? [];
  const variant = (name) => variants.find((entry) => entry?.properties?.command?.const === name);
  const found = Object.fromEntries(writeCommands.map((name) => [name, variant(name)]));
  if (Object.values(found).some((entry) => !entry)) throw new Error("compiled P7 execute_command variants missing");
  const expectedKeys = {
    append_studio_continuity_observation: ["expectedHeadRevision", "field", "scope", "state", "subjectId"],
    append_studio_continuity_correction: ["expectedHeadRevision", "field", "resolvesConflicts", "scope", "state", "subjectId", "supersedesEntryId"],
    submit_studio_generation_review: ["annotations", "continuityFingerprint", "criteria", "decision", "expectedHeadRevision", "expectedPackFingerprint", "generationRunId", "kind", "labeledResultId", "labeledSha256", "note", "rawResultId", "rawSha256", "reviewer", "supersedesReviewId"],
    refresh_studio_generation_checkpoint: ["batchNumber", "expectedHeadRevision"],
    attest_studio_generation_checkpoint: ["batchNumber", "checkpointFingerprint", "checkpointId", "decision", "expectedHeadRevision", "note", "reviewer"],
  };
  const expectedRequired = {
    append_studio_continuity_observation: ["expectedHeadRevision", "scope", "subjectId", "field", "state"],
    append_studio_continuity_correction: ["expectedHeadRevision", "scope", "subjectId", "field", "state", "supersedesEntryId"],
    submit_studio_generation_review: ["generationRunId", "kind", "expectedHeadRevision", "rawResultId", "rawSha256", "labeledResultId", "labeledSha256", "expectedPackFingerprint", "continuityFingerprint", "decision", "criteria", "reviewer", "note"],
    refresh_studio_generation_checkpoint: ["batchNumber", "expectedHeadRevision"],
    attest_studio_generation_checkpoint: ["batchNumber", "checkpointId", "checkpointFingerprint", "expectedHeadRevision", "decision", "reviewer", "note"],
  };
  for (const name of writeCommands) {
    const commandVariant = found[name];
    const payload = commandVariant.properties.payload;
    const keys = Object.keys(payload.properties).sort();
    if (commandVariant.additionalProperties !== undefined
        || JSON.stringify(Object.keys(commandVariant.properties).sort()) !== JSON.stringify(["command", "payload"])
        || JSON.stringify(commandVariant.required) !== JSON.stringify(["command", "payload"])
        || payload.additionalProperties !== false
        || JSON.stringify(keys) !== JSON.stringify(expectedKeys[name])
        || JSON.stringify(payload.required) !== JSON.stringify(expectedRequired[name])) {
      throw new Error("compiled P7 payload schema mismatch: " + name);
    }
  }
  if (found.submit_studio_generation_review.properties.payload.properties.reviewer.const !== "codex"
      || found.attest_studio_generation_checkpoint.properties.payload.properties.reviewer.const !== "codex") {
    throw new Error("compiled MCP reviewer boundary mismatch");
  }
  const publicSchemas = JSON.stringify(found);
  if (/operationId|headKey|receiptId|requestFingerprint/u.test(publicSchemas)) {
    throw new Error("compiled MCP leaked private P7 fields");
  }
  process.stdout.write(JSON.stringify({
    status: "pass",
    serverPath,
    toolCount: names.length,
    uniqueToolCount: new Set(names).size,
    readTool: readTool.name,
    readLimits: { assets: 6, timeline: 36, conflicts: 36, reviews: 20, checkpoints: 12 },
    executeCommands: writeCommands,
    namedWriteTools: writeCommands.filter((name) => names.includes(name)),
    privateFieldsExposed: false,
    reviewerBoundary: "codex",
    stderrBytes: Buffer.byteLength(stderr),
  }) + "\\n");
} finally {
  await client.close();
}
`.trimStart();
  await writeFile(probePath, probe, { encoding: "utf8", flag: "wx" });
  return await fileEvidence(probePath);
}

async function validateCompiledCoreContracts(): Promise<Array<{
  file: FileEvidence;
  markers: string[];
}>> {
  const specs = [
    {
      relativePath: "dist-mcp/core/studio-continuity.js",
      markers: ["studio-continuity-entry", "referenceSha256", "required-state-gap"],
    },
    {
      relativePath: "dist-mcp/core/studio-continuity-ledger.js",
      markers: ["continuity entries are append-only", "studio_continuity_operation_receipts"],
    },
    {
      relativePath: "dist-mcp/core/panel-reference-resolution-core.js",
      markers: ["panel-reference-resolution-core-v3", "continuity-frame", "overflowControlReferences"],
    },
    {
      relativePath: "dist-mcp/core/studio-generation.js",
      markers: ["previousApprovedRawReviewId", "continuityFrame", "continuity-not-ready"],
    },
    {
      relativePath: "dist-mcp/core/studio-generation-ledger.js",
      markers: ["assertStudioGenerationCheckpointDispatchAllowed", "pack-schema-unsupported"],
    },
    {
      relativePath: "dist-mcp/core/studio-generation-review.js",
      markers: [
        "generation review events are append-only",
        "必须与该结果对所属冻结包的真实连续性快照一致",
      ],
    },
    {
      relativePath: "dist-mcp/core/studio-generation-checkpoint.js",
      markers: [
        "generation checkpoint snapshots are append-only",
        "studio_generation_checkpoint_operation_receipts",
      ],
    },
    {
      relativePath: "dist-mcp/core/studio-continuity-review-control.js",
      markers: ["resolve-generation-input", "freeze-generation-pack"],
    },
  ] as const;
  return await Promise.all(specs.map(async (spec) => {
    const absolutePath = path.join(workspace, spec.relativePath);
    const content = await readFile(absolutePath, "utf8");
    const missingMarkers = spec.markers.filter((marker) => !content.includes(marker));
    assert(missingMarkers.length === 0,
      `compiled P7 Core 契约缺失：${spec.relativePath} => ${JSON.stringify(missingMarkers)}`);
    return { file: await fileEvidence(absolutePath), markers: [...spec.markers] };
  }));
}

assert(isWithin(evidenceRoot, outputPath) && outputPath !== evidenceRoot,
  `P7 final evidence 必须位于 docs/evidence：${outputPath}`);
assert(isWithin(evidenceRoot, runRoot) && runRoot !== evidenceRoot,
  `P7 run root 必须位于 docs/evidence：${runRoot}`);
assert(outputPath !== explicitUiEvidencePath,
  `P7 final evidence 不得覆盖显式 UI smoke：${outputPath}`);
assert(!isWithin(runRoot, outputPath) && !isWithin(outputPath, runRoot),
  `P7 final evidence 与 run root 必须是互不嵌套的独立不可变路径：${JSON.stringify({
    outputPath,
    runRoot,
  })}`);
await Promise.all([assertAbsent(outputPath), assertAbsent(runRoot)]);

const planningBefore = await assertPlanningGate();
const sourceBefore = await inventorySnapshot(sourceRoot);
assert(sourceBefore.files === expectedSource.files
  && sourceBefore.bytes === expectedSource.bytes
  && sourceBefore.aggregateSha256 === expectedSource.aggregateSha256,
`第三季只读源基线漂移：${JSON.stringify(sourceBefore)}`);
const workspaceSourceBefore = await workspaceSourceDigest();
const uiInputsBefore = await uiInputIdentity();
const uiEvidence = await loadExplicitLatestUiEvidence(uiInputsBefore);
const formalIdentityBefore = await assertFormalProjectIdentity();
const formalTreeBefore = await treeSnapshot(projectRoot);
const formalEmptyBefore = assertFormalProjectEmpty(formalIdentityBefore.logical, formalTreeBefore);
const p7Contracts = await validateP7Contracts();

await mkdir(runRoot, { recursive: false });

const targetedCoreTests = [
  "tests/studio-continuity-contract.test.ts",
  "tests/studio-continuity-ledger.test.ts",
  "tests/panel-reference-resolution-core.test.ts",
  "tests/studio-generation-continuity-gate.test.ts",
  "tests/studio-generation.test.ts",
  "tests/studio-generation-ledger.test.ts",
  "tests/studio-generation-review.test.ts",
  "tests/studio-generation-review-stale.test.ts",
  "tests/studio-continuity-command-bus.test.ts",
  "tests/mcp-studio-continuity-review.test.ts",
  "tests/studio-continuity-review-control.test.ts",
  "tests/mcp-studio-continuity-review-control.test.ts",
  "tests/studio-continuity-review-ui.test.ts",
  "tests/studio-continuity-review-desktop-integration.test.ts",
  "tests/studio-command-routing.test.ts",
];
const checkpointTests = ["tests/studio-generation-checkpoint.test.ts"];
const allTargetedTests = [...targetedCoreTests, ...checkpointTests];
const discoveredTestFiles = (await fg("tests/**/*.test.ts", {
  cwd: workspace,
  onlyFiles: true,
  dot: false,
  followSymbolicLinks: false,
  unique: true,
})).map((entry) => entry.split(path.sep).join("/"))
  .sort((left, right) => left.localeCompare(right, "en"));
assert(discoveredTestFiles.length >= MIN_FULL_FILES,
  `Vitest 发现的全量测试文件少于当前 P7 基线：${discoveredTestFiles.length}`);
assert(targetedCoreTests.length === MIN_TARGETED_CORE_FILES
  && checkpointTests.length === MIN_CHECKPOINT_FILES
  && allTargetedTests.length === MIN_TARGETED_TOTAL_FILES
  && new Set(allTargetedTests).size === allTargetedTests.length,
`P7 targeted 文件清单不完整或重复：${JSON.stringify(allTargetedTests)}`);
const missingTargetedTests = allTargetedTests
  .filter((testFile) => !discoveredTestFiles.includes(testFile));
assert(missingTargetedTests.length === 0,
  `P7 targeted 专项测试未被 Vitest 发现：${JSON.stringify(missingTargetedTests)}`);

const vitest = path.join(workspace, "node_modules", ".bin", "vitest");
const tsx = path.join(workspace, "node_modules", ".bin", "tsx");
const typecheck = await runCommand("typecheck", "npm", ["run", "typecheck"], 10 * 60_000);
const targetedCore = await runCommand(
  "targeted-core-tests",
  vitest,
  ["run", ...targetedCoreTests, "--reporter=verbose"],
  25 * 60_000,
);
assertTestRun(targetedCore.evidence, {
  minimumFilesPassed: MIN_TARGETED_CORE_FILES,
  minimumTestsPassed: MIN_TARGETED_CORE_TESTS,
});
// 该真实六槽生命周期在当前机器约需 100–150 秒，必须独立串行，避免并行 SQLite fixture 抖动。
const checkpoint = await runCommand(
  "checkpoint-tests",
  vitest,
  ["run", ...checkpointTests, "--reporter=verbose"],
  6 * 60_000,
);
assertTestRun(checkpoint.evidence, {
  minimumFilesPassed: MIN_CHECKPOINT_FILES,
  minimumTestsPassed: MIN_CHECKPOINT_TESTS,
});
const targetedCombined = combinedTestSummary(
  targetedCore.evidence.testSummary!,
  checkpoint.evidence.testSummary!,
);
assert(targetedCombined.filesPassed >= MIN_TARGETED_TOTAL_FILES
  && targetedCombined.testsPassed >= MIN_TARGETED_TOTAL_TESTS
  && targetedCombined.filesFailed === 0
  && targetedCombined.testsFailed === 0
  && targetedCombined.filesSkipped === 0
  && targetedCombined.testsSkipped === 0
  && targetedCombined.testsTodo === 0,
`P7 合并 targeted 统计未达 16 files / 81 tests：${JSON.stringify(targetedCombined)}`);
const targetedMarkers = validateTargetedRuntimeMarkers(
  `${targetedCore.stdout}\n${targetedCore.stderr}`,
  `${checkpoint.stdout}\n${checkpoint.stderr}`,
);

const full = await runCommand("full-tests", "npm", ["test"], 35 * 60_000);
assertTestRun(full.evidence, {
  minimumFilesPassed: MIN_FULL_FILES,
  minimumTestsPassed: MIN_FULL_TESTS,
});
const build = await runCommand("production-build", "npm", ["run", "build"], 12 * 60_000);
const buildMcp = await runCommand("mcp-build", "npm", ["run", "build:mcp"], 12 * 60_000);
const buildIdentity = await compiledBuildIdentity();

const compiledRegistryPath = path.join(runRoot, "compiled-mcp-isolated-registry.json");
const compiledMcp = await runCommand(
  "compiled-mcp",
  tsx,
  ["scripts/mcp-smoke.ts", "dist-mcp/mcp/server.js"],
  4 * 60_000,
  { AI_CANVAS_REGISTRY_PATH: compiledRegistryPath },
);
const compiledMcpValue = JSON.parse(compiledMcp.stdout) as {
  toolCount?: number;
  tools?: string[];
};
const requiredTools = [
  "get_studio_binding_control",
  "get_studio_generation_control",
  "get_studio_continuity_review_control",
  "execute_command",
];
const forbiddenNamedWriteTools = [
  "append_studio_continuity_observation",
  "append_studio_continuity_correction",
  "submit_studio_generation_review",
  "refresh_studio_generation_checkpoint",
  "attest_studio_generation_checkpoint",
];
assert(compiledMcpValue.toolCount === expectedToolCount
  && Array.isArray(compiledMcpValue.tools)
  && compiledMcpValue.tools.length === expectedToolCount
  && new Set(compiledMcpValue.tools).size === expectedToolCount
  && requiredTools.every((tool) => compiledMcpValue.tools!.includes(tool))
  && forbiddenNamedWriteTools.every((tool) => !compiledMcpValue.tools!.includes(tool)),
`compiled MCP P7 工具清单不完整或暴露具名写工具：${JSON.stringify({
  toolCount: compiledMcpValue.toolCount,
  requiredTools,
})}`);

const compiledServerPath = path.join(workspace, "dist-mcp", "mcp", "server.js");
const compiledServerText = await readFile(compiledServerPath, "utf8");
const requiredCompiledMarkers = [
  "get_studio_continuity_review_control",
  "append_studio_continuity_observation",
  "append_studio_continuity_correction",
  "submit_studio_generation_review",
  "refresh_studio_generation_checkpoint",
  "attest_studio_generation_checkpoint",
  "MCP/Codex 的 Studio 裁决 reviewer 必须是 codex",
];
assert(requiredCompiledMarkers.every((marker) => compiledServerText.includes(marker)),
  "compiled MCP bundle 缺少 P7 只读工具、execute command schema 或 reviewer 边界标记。");

const compiledSchemaProbeFile = await writeCompiledMcpSchemaProbe();
const compiledSchemaProbe = await runCommand(
  "compiled-mcp-p7-schema",
  process.execPath,
  [compiledSchemaProbeFile.path, compiledServerPath],
  4 * 60_000,
  { AI_CANVAS_REGISTRY_PATH: path.join(runRoot, "compiled-mcp-schema-isolated-registry.json") },
);
const compiledSchemaValue = JSON.parse(compiledSchemaProbe.stdout) as {
  status?: string;
  toolCount?: number;
  uniqueToolCount?: number;
  readTool?: string;
  executeCommands?: string[];
  namedWriteTools?: string[];
  privateFieldsExposed?: boolean;
  reviewerBoundary?: string;
};
assert(compiledSchemaValue.status === "pass"
  && compiledSchemaValue.toolCount === expectedToolCount
  && compiledSchemaValue.uniqueToolCount === expectedToolCount
  && compiledSchemaValue.readTool === "get_studio_continuity_review_control"
  && JSON.stringify(compiledSchemaValue.executeCommands) === JSON.stringify(forbiddenNamedWriteTools)
  && compiledSchemaValue.namedWriteTools?.length === 0
  && compiledSchemaValue.privateFieldsExposed === false
  && compiledSchemaValue.reviewerBoundary === "codex",
`compiled MCP P7 schema probe 无效：${JSON.stringify(compiledSchemaValue)}`);
const compiledCoreContracts = await validateCompiledCoreContracts();

const [
  planningAfter,
  sourceAfter,
  workspaceSourceAfter,
  formalIdentityAfter,
  formalTreeAfter,
  uiEvidenceFileAfter,
  uiScreenshotFileAfter,
  uiCandidatePathsAfter,
] = await Promise.all([
  assertPlanningGate(),
  inventorySnapshot(sourceRoot),
  workspaceSourceDigest(),
  assertFormalProjectIdentity(),
  treeSnapshot(projectRoot),
  fileEvidence(uiEvidence.evidencePath),
  fileEvidence(uiEvidence.screenshotFile.path),
  uiEvidenceCandidatePaths(),
]);
const formalEmptyAfter = assertFormalProjectEmpty(formalIdentityAfter.logical, formalTreeAfter);
assert(JSON.stringify(planningAfter) === JSON.stringify(planningBefore),
  "P7 最终验证期间活动 planning 或 attestation 发生变化。");
assert(JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore),
  "P7 最终验证期间第三季只读源发生变化。");
assert(JSON.stringify(workspaceSourceAfter) === JSON.stringify(workspaceSourceBefore),
  "P7 最终验证期间源码、测试、脚本或构建配置发生变化。");
assert(JSON.stringify(formalTreeAfter) === JSON.stringify(formalTreeBefore),
  "P7 最终验证期间正式新项目文件/目录树发生变化。");
assert(JSON.stringify(formalIdentityAfter.logical) === JSON.stringify(formalIdentityBefore.logical),
  "P7 最终验证期间正式新项目 SQLite 逻辑状态发生变化。");
assert(JSON.stringify(formalEmptyAfter) === JSON.stringify(formalEmptyBefore),
  "P7 最终验证期间正式新项目空库状态发生变化。");
assert(JSON.stringify(uiEvidenceFileAfter) === JSON.stringify(uiEvidence.evidenceFile)
  && JSON.stringify(uiScreenshotFileAfter) === JSON.stringify(uiEvidence.screenshotFile),
"P7 最终验证期间 UI smoke 证据发生变化。");
assert(JSON.stringify(uiCandidatePathsAfter) === JSON.stringify(uiEvidence.candidatePaths),
  "P7 最终验证期间出现了更新的 UI smoke 证据，拒绝消费旧证据。");

const compiledServer = await fileEvidence(compiledServerPath);
const packageLock = await fileEvidence(path.join(workspace, "package-lock.json"));
const runRootSnapshot = await treeSnapshot(runRoot);
const evidence = {
  schemaVersion: 2,
  kind: "p7-continuity-review-final-validation",
  status: "pass",
  createdAt: new Date().toISOString(),
  scope: {
    phase: "P7",
    softwareOnly: true,
    formalSeasonProductionComplete: false,
    validatorInvokedBrowser: false,
    validatorInvokedImagegen: false,
    formalImageGenerationCalls: 0,
    browserSupplierCalls: 0,
    uploads: 0,
  },
  planning: {
    before: planningBefore,
    after: planningAfter,
    unchangedDuringValidation: true,
  },
  formalProject: {
    root: projectRoot,
    id: formalIdentityBefore.projectId,
    name: formalIdentityBefore.projectName,
    schemaVersions: formalIdentityBefore.schemaVersions,
    p7SchemasInitializedOnlyInTemporaryFixtures: true,
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
    continuity: [
      "fixed-nine-fields",
      "panel-and-source-shot-half-open-spans",
      "discontinuous-no-gap-fill",
      "explicit-unresolved",
      "append-only-observation-correction",
      "head-cas",
      "persistent-conflicts",
      "operation-receipts",
    ],
    generationV4: [
      "continuity-snapshot",
      "identity-and-continuity-reference-limit-six",
      "explicit-current-pass-previous-raw",
      "adjacent-panel-proof",
      "historical-v3-read-only",
      "real-dispatch-checkpoint-gate",
    ],
    review: [
      "raw-labeled-pair-identity",
      "pack-continuity-fingerprint-binding",
      "stale-historical-only",
      "no-upstream-mutation",
      "review-head-cas",
    ],
    checkpoint: [
      "six-unique-production-slots",
      "content-addressed-snapshot",
      "pass-or-rework-attestation",
      "review-correction-invalidates-old-pass",
      "seventh-dispatch-zero-write",
      "durable-refresh-attest-receipts",
    ],
    surfaces: [
      "core-next-action",
      "bounded-read-control",
      "execute-command-only-writes",
      "mcp-codex-reviewer",
      "desktop-user-reviewer",
      "lazy-electron-tab",
    ],
  },
  testContracts: p7Contracts,
  commandRuns: {
    typecheck: typecheck.evidence,
    targetedCore: targetedCore.evidence,
    checkpoint: checkpoint.evidence,
    full: full.evidence,
    build: build.evidence,
    buildMcp: buildMcp.evidence,
    compiledMcp: compiledMcp.evidence,
    compiledMcpSchema: compiledSchemaProbe.evidence,
  },
  testDiscovery: {
    include: "tests/**/*.test.ts",
    discoveredFiles: discoveredTestFiles.length,
    files: discoveredTestFiles,
    targetedCoreFiles: targetedCoreTests,
    checkpointFiles: checkpointTests,
    targetedCombined,
    minimumThresholds: {
      targetedCoreFiles: MIN_TARGETED_CORE_FILES,
      targetedCoreTests: MIN_TARGETED_CORE_TESTS,
      checkpointFiles: MIN_CHECKPOINT_FILES,
      checkpointTests: MIN_CHECKPOINT_TESTS,
      targetedTotalFiles: MIN_TARGETED_TOTAL_FILES,
      targetedTotalTests: MIN_TARGETED_TOTAL_TESTS,
      fullFiles: MIN_FULL_FILES,
      fullTests: MIN_FULL_TESTS,
    },
    checkpointRunSeparatelyToAvoidParallelFixtureFlake: true,
    noFailuresNoSkipsNoTodoRequired: true,
    countsAreParsedFromVitestOutput: true,
    hardCodedObservedCountIsOnlyMinimum: true,
  },
  specializedRuntimeMarkers: targetedMarkers,
  temporaryFixtureProof: {
    rootPolicy: "/tmp only",
    sourceRootsEmpty: true,
    deterministicFixture: targetedMarkers.fixture,
    discontinuousSpansAndGaps: targetedMarkers.discontinuousSpans,
    reviewAppendOnlyCas: targetedMarkers.reviewAppendOnly,
    staleHistoricalOnly: targetedMarkers.reviewStale,
    reviewCasRecovery: targetedMarkers.reviewCasRecovery,
    checkpointRealDispatchAndDurableReceipt: targetedMarkers.checkpointVerboseContracts,
    businessLogicReimplementedByValidator: false,
  },
  electronUi: {
    explicitlyProvidedByCli: true,
    selectedSequence: uiEvidence.sequence,
    latestEvidenceVerified: uiEvidence.evidenceFile,
    candidatePaths: uiEvidence.candidatePaths,
    screenshot: uiEvidence.screenshotFile,
    screenshotInspection: uiEvidence.screenshot,
    uiInputs: uiInputsBefore,
    smoke: {
      continuityTabNotPreloadedAtStartup: uiEvidence.parsed.ui?.continuityTabNotPreloadedAtStartup,
      continuityChunkLazyLoaded: uiEvidence.parsed.ui?.continuityChunkLazyLoaded,
      unresolvedBeforeSeed: uiEvidence.parsed.ui?.unresolvedBeforeSeed,
      readyAfterSeed: uiEvidence.parsed.ui?.readyAfterSeed,
      reviewControlVisible: uiEvidence.parsed.ui?.reviewControlVisible,
      checkpointControlVisible: uiEvidence.parsed.ui?.checkpointControlVisible,
      pageErrors: uiEvidence.parsed.ui?.pageErrors,
      consoleErrors: uiEvidence.parsed.ui?.consoleErrors,
      rendererCrashes: uiEvidence.parsed.ui?.rendererCrashes,
      externalRequests: uiEvidence.parsed.ui?.externalRequests,
      formalProjectAccesses: uiEvidence.parsed.boundaries?.formalProjectAccesses,
    },
  },
  compiledMcp: {
    toolCount: compiledMcpValue.toolCount,
    requiredTools,
    forbiddenNamedWriteTools,
    requiredCommandMarkers: requiredCompiledMarkers,
    schemaProbeScript: compiledSchemaProbeFile,
    schemaProbe: compiledSchemaValue,
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
  immutableRunRoot: {
    path: runRoot,
    snapshot: runRootSnapshot,
    exclusiveRunRootCreation: true,
    validatorOwnedArtifactsUseExclusiveWx: true,
    noFurtherRunRootWritesAfterSnapshot: true,
  },
  boundaries: {
    formalProjectAccessesByUi: 0,
    formalProjectWrites: 0,
    formalSourceWrites: 0,
    formalImagesCreated: 0,
    formalVideosCreated: 0,
    formalAudioCreated: 0,
    externalGenerationCalls: 0,
    imagegenCalls: 0,
    browserCalls: 0,
    uploads: 0,
    gitOperations: 0,
  },
};
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});
process.stdout.write(`${JSON.stringify({
  outputPath,
  runRoot,
  status: evidence.status,
  tests: {
    targetedCore: targetedCore.evidence.testSummary,
    checkpoint: checkpoint.evidence.testSummary,
    targetedCombined,
    full: full.evidence.testSummary,
  },
  compiledMcpTools: compiledMcpValue.toolCount,
  compiledMcpSchema: compiledSchemaValue.status,
  uiEvidence: {
    path: uiEvidence.evidencePath,
    sequence: uiEvidence.sequence,
    explicitlyProvidedByCli: true,
  },
  formalProjectRemainsEmpty: true,
  formalProjectUnchanged: true,
  sourceUnchanged: true,
  boundaries: evidence.boundaries,
}, null, 2)}\n`);
