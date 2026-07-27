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
import { getManagedProjectShell } from "../src/core/service.js";
import { getMaterialStudioState } from "../src/core/material-studio.js";
import { getStudioProductionState } from "../src/core/studio-production.js";
import { getStudioGenerationLedgerState } from "../src/core/studio-generation-ledger.js";

const workspace = path.resolve(process.argv[2] ?? "/Users/hxx/Documents/无限画布");
const projectRoot = path.resolve(process.argv[3] ?? path.join(workspace, "projects", "codex-ai-drama-studio"));
const sourceRoot = path.resolve(process.argv[4] ?? "/Users/hxx/Documents/古蜀卷第三季");
const outputPath = path.resolve(process.argv[5] ?? path.join(workspace, "docs", "evidence", "final-validation-20260718-p5-managed-studio.json"));
const runRoot = path.resolve(process.argv[6] ?? path.join(workspace, "docs", "evidence", "runs", "p5-managed-studio-final-20260718"));
const uiEvidencePath = path.join(workspace, "docs", "evidence", "p5-managed-studio-ui-smoke-20260718-04.json");
const uiScreenshotPath = path.join(workspace, "docs", "evidence", "p5-managed-studio-ui-smoke-20260718-04.png");
const scaleUiEvidencePath = path.join(workspace, "docs", "evidence", "p5-managed-studio-scale-ui-smoke-20260718-01.json");
const scaleUiScreenshotPath = path.join(workspace, "docs", "evidence", "p5-managed-studio-scale-ui-smoke-20260718-01.png");
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

interface TestSummary {
  filesPassed: number;
  testsPassed: number;
  filesSkipped: number;
  testsSkipped: number;
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
  log: FileEvidence;
  testSummary?: TestSummary;
}

interface BuildIdentityEntry {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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

async function managedProjectSnapshot(root: string): Promise<InventorySnapshot> {
  const relativePaths = (await fg("**/*", {
    cwd: root,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    unique: true,
    ignore: ["**/*-shm"],
  })).map((entry) => entry.split(path.sep).join("/"))
    .sort((left, right) => left.localeCompare(right, "en"));
  const rows = await mapLimit(relativePaths, 8, async (relativePath) => {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const before = await stat(absolutePath);
    const fileSha256 = await sha256File(absolutePath);
    const after = await stat(absolutePath);
    assert(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
      `冻结受管工程期间文件发生变化：${absolutePath}`);
    return { relativePath, bytes: before.size, mtimeMs: before.mtimeMs, sha256: fileSha256 };
  });
  return {
    root,
    files: rows.length,
    bytes: rows.reduce((sum, entry) => sum + entry.bytes, 0),
    aggregateSha256: sha256(rows.map((entry) => `${entry.relativePath}\0${entry.bytes}\0${entry.mtimeMs}\0${entry.sha256}`).join("\n")),
  };
}

async function managedProjectTreeShape(root: string): Promise<{ entries: Array<{ path: string; type: "file" | "directory" }> ; digest: string }> {
  const relativePaths = (await fg("**/*", {
    cwd: root,
    onlyFiles: false,
    dot: true,
    followSymbolicLinks: false,
    unique: true,
    ignore: ["**/*-shm", "**/*-wal"],
  })).map((entry) => entry.split(path.sep).join("/"))
    .sort((left, right) => left.localeCompare(right, "en"));
  const entries: Array<{ path: string; type: "file" | "directory" }> = [];
  for (const relativePath of relativePaths) {
    const metadata = await lstat(path.join(root, ...relativePath.split("/")));
    assert(!metadata.isSymbolicLink(), `受管工程原始树形包含符号链接：${relativePath}`);
    assert(metadata.isFile() || metadata.isDirectory(), `受管工程原始树形包含非文件/目录：${relativePath}`);
    entries.push({ path: relativePath, type: metadata.isDirectory() ? "directory" : "file" });
  }
  return { entries, digest: sha256(JSON.stringify(entries)) };
}

async function assertManagedProjectRawLayoutReady(): Promise<{
  manifest: FileEvidence;
  requiredFiles: string[];
  requiredDirectories: string[];
}> {
  const manifestPath = path.join(projectRoot, ".aicanvas", "managed-project.json");
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as {
    projectId?: string;
    projectName?: string;
    startupPolicy?: string;
    legacyRoots?: unknown;
    fingerprint?: string;
    relativePaths?: Record<string, string>;
  };
  assert(parsed.projectId === expectedProject.id && parsed.projectName === expectedProject.name
    && parsed.startupPolicy === "no-filesystem-scan"
    && Array.isArray(parsed.legacyRoots) && parsed.legacyRoots.length === 0
    && parsed.fingerprint === expectedProject.manifestFingerprint,
  "受管工程 raw manifest 身份或隔离策略漂移。 ");
  const fileKeys = ["config", "index", "cache", "materialDatabase", "productionDatabase", "generationDatabase"];
  const directoryKeys = ["textCas", "generationPackCas", "mediaCas", "mediaPreviews", "mediaProxies", "mediaWaveforms"];
  const requiredFiles = [path.join(projectRoot, ".aicanvas", "events.jsonl")];
  const requiredDirectories: string[] = [];
  for (const key of fileKeys) {
    const relativePath = parsed.relativePaths?.[key];
    assert(typeof relativePath === "string" && relativePath.length > 0, `raw manifest 缺少文件路径：${key}`);
    requiredFiles.push(path.resolve(projectRoot, relativePath));
  }
  for (const key of directoryKeys) {
    const relativePath = parsed.relativePaths?.[key];
    assert(typeof relativePath === "string" && relativePath.length > 0, `raw manifest 缺少目录路径：${key}`);
    requiredDirectories.push(path.resolve(projectRoot, relativePath));
  }
  requiredDirectories.push(
    path.join(projectRoot, ".aicanvas", "objects", "sha256", ".tmp"),
    path.join(projectRoot, ".aicanvas", "studio-production", "objects", ".tmp"),
    path.join(projectRoot, ".aicanvas", "studio-generation", "objects", ".tmp"),
  );
  for (const filePath of requiredFiles) {
    const relative = path.relative(projectRoot, filePath);
    assert(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `raw manifest 文件路径越界：${filePath}`);
    const metadata = await lstat(filePath);
    assert(metadata.isFile() && !metadata.isSymbolicLink(), `受管工程缺少预建普通文件：${filePath}`);
  }
  for (const directoryPath of requiredDirectories) {
    const relative = path.relative(projectRoot, directoryPath);
    assert(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `raw manifest 目录路径越界：${directoryPath}`);
    const metadata = await lstat(directoryPath);
    assert(metadata.isDirectory() && !metadata.isSymbolicLink(), `受管工程缺少预建真实目录：${directoryPath}`);
  }
  return { manifest: await fileEvidence(manifestPath), requiredFiles, requiredDirectories };
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

async function runCommand(name: string, command: string, args: string[], timeoutMs: number): Promise<{ evidence: RunEvidence; stdout: string; stderr: string }> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  process.stderr.write(`[P5 final] ${name}\n`);
  const result = await new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut });
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
    log: await fileEvidence(logPath),
    ...(testSummary ? { testSummary } : {}),
  };
  assert(!result.timedOut && result.exitCode === 0, `${name} 失败；详见 ${logPath}`);
  return { evidence, stdout: result.stdout, stderr: result.stderr };
}

function databaseIntegrity(databasePath: string): string {
  const database = openImmutableDatabase(databasePath);
  try {
    const row = database.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
    const value = String(row?.integrity_check ?? "");
    assert(value === "ok", `SQLite integrity_check 失败：${databasePath} => ${value}`);
    return value;
  } finally {
    database.close();
  }
}

function openImmutableDatabase(databasePath: string): DatabaseSync {
  const databaseUrl = pathToFileURL(databasePath);
  databaseUrl.searchParams.set("immutable", "1");
  return new DatabaseSync(databaseUrl, { readOnly: true, timeout: 5_000 });
}

function assertProductionSchemaReady(databasePath: string): {
  schemaVersion: 2;
  seasonColumns: string[];
  sequenceConstraint: string;
  appendOnlyTriggers: string[];
  tables: string[];
  zeroCounts: Record<string, 0>;
} {
  const database = openImmutableDatabase(databasePath);
  try {
    const capability = database.prepare("SELECT value FROM studio_production_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    assert(Number(capability?.value ?? 0) === 2, "正式生产库尚未显式升级到 season/双时轴 schema v2。 ");
    const unitColumns = (database.prepare("PRAGMA table_info(studio_production_units)").all() as Array<{ name: string }>).map((column) => column.name);
    const revisionColumns = (database.prepare("PRAGMA table_info(studio_production_unit_revisions)").all() as Array<{ name: string }>).map((column) => column.name);
    assert(unitColumns.includes("season") && revisionColumns.includes("season"), "正式生产库缺少不可变季语义列。 ");
    const uniqueIndex = database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'studio_production_units_season_episode_sequence_uidx'
    `).get() as { sql?: string } | undefined;
    assert(typeof uniqueIndex?.sql === "string" && /UNIQUE\s+INDEX[\s\S]*\(season,\s*episode,\s*sequence\)/iu.test(uniqueIndex.sql),
      "正式生产库缺少 season+episode+sequence 唯一语义。 ");
    const requiredTriggers = [
      "studio_text_revisions_no_update", "studio_text_revisions_no_delete",
      "studio_unit_revisions_no_update", "studio_unit_revisions_no_delete",
      "studio_panels_no_update", "studio_panels_no_delete",
      "studio_panel_assets_no_update", "studio_panel_assets_no_delete",
      "studio_continuity_evidence_no_update", "studio_continuity_evidence_no_delete",
    ];
    const triggerRows = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name IN (${requiredTriggers.map(() => "?").join(",")})
      ORDER BY name
    `).all(...requiredTriggers) as Array<{ name: string }>;
    assert(triggerRows.length === requiredTriggers.length, `正式生产库不可变修订触发器不完整：${triggerRows.map((row) => row.name).join(",")}`);
    const requiredTables = [
      "studio_text_documents", "studio_text_revisions", "studio_production_units", "studio_production_unit_revisions",
      "studio_production_panels", "studio_production_panel_assets", "studio_production_continuity_evidence",
    ];
    const tableRows = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${requiredTables.map(() => "?").join(",")}) ORDER BY name
    `).all(...requiredTables) as Array<{ name: string }>;
    assert(tableRows.length === requiredTables.length, `正式生产库缺少预建表：${requiredTables.filter((name) => !tableRows.some((row) => row.name === name)).join(",")}`);
    const zeroCounts = Object.fromEntries(requiredTables.map((tableName) => {
      const quoted = tableName.replaceAll('"', '""');
      const count = Number((database.prepare(`SELECT COUNT(*) AS count FROM "${quoted}"`).get() as { count: number }).count);
      assert(count === 0, `正式生产库应保持零基线：${tableName}=${count}`);
      return [tableName, 0 as const];
    }));
    return {
      schemaVersion: 2,
      seasonColumns: ["studio_production_units.season", "studio_production_unit_revisions.season"],
      sequenceConstraint: uniqueIndex.sql,
      appendOnlyTriggers: triggerRows.map((row) => row.name),
      tables: tableRows.map((row) => row.name),
      zeroCounts,
    };
  } finally {
    database.close();
  }
}

function assertGenerationLedgerSchemaReady(databasePath: string): {
  schemaVersion: 1;
  tables: string[];
  indexes: string[];
  appendOnlyTriggers: string[];
  counts: { packs: 0; results: 0 };
} {
  const database = openImmutableDatabase(databasePath);
  try {
    const capability = database.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    assert(Number(capability?.value ?? 0) === 1, "正式生图账本尚未显式初始化为 schema v1。 ");
    const requiredTables = ["studio_generation_packs", "studio_generation_results"];
    const tableRows = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${requiredTables.map(() => "?").join(",")}) ORDER BY name
    `).all(...requiredTables) as Array<{ name: string }>;
    const requiredTriggers = [
      "studio_generation_packs_no_update", "studio_generation_packs_no_delete",
      "studio_generation_results_no_update", "studio_generation_results_no_delete",
    ];
    const triggerRows = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${requiredTriggers.map(() => "?").join(",")}) ORDER BY name
    `).all(...requiredTriggers) as Array<{ name: string }>;
    const requiredIndexes = [
      "studio_generation_pack_panel_sequence_idx",
      "studio_generation_result_pack_idx",
      "studio_generation_result_panel_sequence_idx",
    ];
    const indexRows = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${requiredIndexes.map(() => "?").join(",")}) ORDER BY name
    `).all(...requiredIndexes) as Array<{ name: string }>;
    assert(tableRows.length === requiredTables.length && triggerRows.length === requiredTriggers.length && indexRows.length === requiredIndexes.length,
      "正式生图账本缺少不可变 pack/result 表、轻量查询索引或追加触发器。 ");
    const packs = Number((database.prepare("SELECT COUNT(*) AS count FROM studio_generation_packs").get() as { count: number }).count);
    const results = Number((database.prepare("SELECT COUNT(*) AS count FROM studio_generation_results").get() as { count: number }).count);
    assert(packs === 0 && results === 0, `正式生图账本应保持零生产基线：${JSON.stringify({ packs, results })}`);
    return {
      schemaVersion: 1,
      tables: tableRows.map((row) => row.name),
      indexes: indexRows.map((row) => row.name),
      appendOnlyTriggers: triggerRows.map((row) => row.name),
      counts: { packs: 0, results: 0 },
    };
  } finally {
    database.close();
  }
}

function sqliteLogicalSnapshot(databasePath: string): {
  databasePath: string;
  integrity: string;
  schemaSha256: string;
  tableCounts: Record<string, number>;
  metaRows: Record<string, string>[];
  digest: string;
} {
  const database = openImmutableDatabase(databasePath);
  try {
    const integrity = String((database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined)?.integrity_check ?? "");
    assert(integrity === "ok", `SQLite 逻辑快照完整性失败：${databasePath}`);
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
    const digest = sha256(JSON.stringify({ schemaSha256, tableCounts, metaRows }));
    return { databasePath, integrity, schemaSha256, tableCounts, metaRows, digest };
  } finally {
    database.close();
  }
}

async function assertEmptySqliteWal(databasePaths: string[]): Promise<Record<string, { path: string; sizeBytes: 0 }>> {
  const entries: Array<[string, { path: string; sizeBytes: 0 }]> = [];
  for (const databasePath of databasePaths) {
    const walPath = `${databasePath}-wal`;
    const size = await stat(walPath).then((metadata) => metadata.size, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
    assert(size === 0, `正式 SQLite 存在未纳入主文件快照的 WAL 字节：${walPath} (${size})`);
    entries.push([path.relative(projectRoot, walPath), { path: walPath, sizeBytes: 0 }]);
  }
  return Object.fromEntries(entries);
}

async function assertSqliteWalHeaders(databasePaths: string[]): Promise<Record<string, { writeVersion: 2; readVersion: 2 }>> {
  const result: Array<[string, { writeVersion: 2; readVersion: 2 }]> = [];
  for (const databasePath of databasePaths) {
    const header = (await readFile(databasePath)).subarray(0, 100);
    assert(header.length === 100 && header.subarray(0, 16).toString("binary") === "SQLite format 3\0",
      `正式索引库不是有效 SQLite 3 主文件：${databasePath}`);
    assert(header[18] === 2 && header[19] === 2, `正式 SQLite 主文件未冻结为 WAL 读写版本：${databasePath}`);
    result.push([path.relative(projectRoot, databasePath), { writeVersion: 2, readVersion: 2 }]);
  }
  return Object.fromEntries(result);
}

function assertMaterialKnowledgeSchemaReady(databasePath: string): {
  scopeRelationSchema: 2;
  applicabilityColumns: string[];
  relationColumns: string[];
  relationHeadProjection: true;
  appendOnlyTriggers: string[];
  reviewReceiptGuards: string[];
  immutableHistoryGuards: string[];
  mediaImportOrigins: true;
  zeroCounts: Record<string, 0>;
} {
  const database = openImmutableDatabase(databasePath);
  try {
    const capability = database.prepare("SELECT value FROM studio_meta WHERE key = 'asset_scope_relation_schema'").get() as { value?: string } | undefined;
    const canonicalColumns = database.prepare("PRAGMA table_info(studio_canonical_assets)").all() as Array<{ name: string }>;
    const definitionColumns = database.prepare("PRAGMA table_info(studio_asset_definitions)").all() as Array<{ name: string }>;
    const relationColumns = database.prepare("PRAGMA table_info(studio_asset_relations)").all() as Array<{ name: string }>;
    const relationHead = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'studio_asset_relation_heads'").get() as { name?: string } | undefined;
    const triggerRows = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN (
          'studio_asset_relations_no_update',
          'studio_asset_relations_no_delete',
          'studio_asset_relation_lineage_guard',
          'studio_asset_relation_heads_guard_insert',
          'studio_asset_relation_heads_guard_update',
          'studio_asset_relation_heads_no_delete'
        )
      ORDER BY name
    `).all() as Array<{ name: string }>;
    const reviewGuardRows = database.prepare(`
      SELECT name, type FROM sqlite_master
      WHERE (type = 'trigger' AND name IN ('studio_version_reviews_no_update', 'studio_version_reviews_no_delete'))
         OR (type = 'index' AND name = 'studio_review_version_once_idx')
      ORDER BY type, name
    `).all() as Array<{ name: string; type: string }>;
    const requiredTables = [
      "studio_media", "studio_media_derivatives", "studio_media_imports",
      "studio_canonical_assets", "studio_asset_aliases", "studio_asset_versions", "studio_asset_definitions",
      "studio_authority_events", "studio_version_reviews", "studio_asset_relations", "studio_asset_relation_heads",
    ];
    const tableRows = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${requiredTables.map(() => "?").join(",")}) ORDER BY name
    `).all(...requiredTables) as Array<{ name: string }>;
    assert(tableRows.length === requiredTables.length, `正式素材库缺少预建表：${requiredTables.filter((name) => !tableRows.some((row) => row.name === name)).join(",")}`);
    const immutableHistoryTriggerNames = [
      "studio_asset_versions_no_update", "studio_asset_versions_no_delete",
      "studio_asset_definitions_no_update", "studio_asset_definitions_no_delete",
      "studio_asset_aliases_no_update", "studio_asset_aliases_no_delete",
      "studio_authority_events_no_update", "studio_authority_events_no_delete",
      "studio_media_identity_no_update", "studio_media_no_delete",
      "studio_media_imports_no_update", "studio_media_imports_no_delete",
    ];
    const immutableHistoryRows = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${immutableHistoryTriggerNames.map(() => "?").join(",")}) ORDER BY name
    `).all(...immutableHistoryTriggerNames) as Array<{ name: string }>;
    const scopeRelationSchema = Number(capability?.value ?? 0);
    assert(scopeRelationSchema === 2, "正式素材库尚未显式升级到可恢复关系 schema v2。 ");
    assert(canonicalColumns.some((column) => column.name === "applicability_json")
      && definitionColumns.some((column) => column.name === "applicability_json"),
    "正式素材库缺少 applicability_json，拒绝在 validator 内静默迁移。 ");
    const relationColumnNames = relationColumns.map((column) => column.name);
    for (const required of ["relation_series_id", "relation_revision", "supersedes_relation_id"]) {
      assert(relationColumnNames.includes(required), `正式素材库关系 v2 缺少列：${required}`);
    }
    assert(relationHead?.name === "studio_asset_relation_heads", "正式素材库缺少当前关系 head 投影表。 ");
    assert(triggerRows.length === 6, `正式素材库关系追加历史/head 守卫触发器不完整：${triggerRows.map((row) => row.name).join(",")}`);
    assert(reviewGuardRows.length === 3, `正式素材库缺少不可变审核收据守卫：${reviewGuardRows.map((row) => row.name).join(",")}`);
    assert(immutableHistoryRows.length === immutableHistoryTriggerNames.length,
      `正式素材库版本/定义/别名/权威/媒体来源不可变守卫不完整：${immutableHistoryRows.map((row) => row.name).join(",")}`);
    const zeroCounts = Object.fromEntries(requiredTables.map((tableName) => {
      const quoted = tableName.replaceAll('"', '""');
      const count = Number((database.prepare(`SELECT COUNT(*) AS count FROM "${quoted}"`).get() as { count: number }).count);
      assert(count === 0, `正式素材库应保持零基线：${tableName}=${count}`);
      return [tableName, 0 as const];
    }));
    return {
      scopeRelationSchema: 2,
      applicabilityColumns: ["studio_canonical_assets.applicability_json", "studio_asset_definitions.applicability_json"],
      relationColumns: relationColumnNames,
      relationHeadProjection: true,
      appendOnlyTriggers: triggerRows.map((row) => row.name),
      reviewReceiptGuards: reviewGuardRows.map((row) => `${row.type}:${row.name}`),
      immutableHistoryGuards: immutableHistoryRows.map((row) => row.name),
      mediaImportOrigins: true,
      zeroCounts,
    };
  } finally {
    database.close();
  }
}

async function assertStoryFirstCreationEvent(eventsPath: string): Promise<FileEvidence> {
  const lines = (await readFile(eventsPath, "utf8")).split(/\r?\n/u).filter((line) => line.trim());
  const events = lines.map((line, index) => {
    try { return JSON.parse(line) as { type?: string; data?: { projectMode?: string; sourceRoots?: unknown; outputRoots?: unknown } }; }
    catch (error) { throw new Error(`受管工程事件第 ${index + 1} 行 JSON 损坏。`, { cause: error }); }
  });
  const created = events.filter((event) => event.type === "project.imported" && event.data?.projectMode === "story_first");
  assert(created.length === 1 && Array.isArray(created[0]!.data?.sourceRoots) && created[0]!.data!.sourceRoots!.length === 0,
    "正式素材中心缺少唯一 story_first + sourceRoots=[] 建项证据。 ");
  assert(Array.isArray(created[0]!.data?.outputRoots) && created[0]!.data!.outputRoots!.length === 1
    && path.resolve(String(created[0]!.data!.outputRoots![0])) === projectRoot,
  "story_first 建项事件的唯一写根不是正式素材中心。 ");
  return fileEvidence(eventsPath);
}

async function criticalProjectSnapshot(paths: string[]): Promise<Record<string, FileEvidence>> {
  return Object.fromEntries(await Promise.all(paths.map(async (filePath) => [path.relative(projectRoot, filePath), await fileEvidence(filePath)])));
}

async function assertProjectHasNoSymlinks(): Promise<number> {
  const entries = await fg("**/*", { cwd: projectRoot, onlyFiles: false, dot: true, followSymbolicLinks: false, unique: true });
  for (const relativePath of entries) {
    const absolutePath = path.join(projectRoot, relativePath);
    const metadata = await lstat(absolutePath);
    assert(!metadata.isSymbolicLink(), `受管工程包含符号链接：${absolutePath}`);
    const canonical = await realpath(absolutePath);
    assert(canonical === projectRoot || canonical.startsWith(`${projectRoot}${path.sep}`), `受管工程路径越界：${canonical}`);
  }
  return entries.length;
}

async function validateScaleContracts(): Promise<Array<{ file: FileEvidence; phrase: string }>> {
  const contracts = [
    ["tests/managed-project.test.ts", "多次重启检查只读固定侧车，不调用 scanProject 或扫描旧根"],
    ["tests/material-studio.test.ts", "10000 条资产元数据仍走 limit/keyset 查询，并可在重启后恢复"],
    ["tests/material-studio.test.ts", "10000 条图片视频音频元数据分页时只返回轻量索引，不读取媒体本体"],
    ["tests/material-studio.test.ts", "重复 SHA 不产生第二份 blob，图片生成冻结配方缩略图"],
    ["tests/studio-production.test.ts", "10000 个单元仍使用索引 + limit 键集查询，不全表装载"],
    ["tests/studio-media-protocol.test.ts", "64 MiB 原件保持流式校验与区间读取，不使用整文件 readFile"],
    ["tests/studio-media-protocol.test.ts", "32 MiB ready 视频代理的连续 Range 只在首次计算整文件 SHA"],
    ["tests/studio-media-derivatives.test.ts", "100 视频 + 100 音频只分页读轻量元数据，不创建派生或启动进程"],
    ["tests/studio-generation.test.ts", "单格超过 6 项控制参考时失败关闭，要求先建立组合派生资产"],
    ["tests/studio-generation.test.ts", "派生资产只冻结自身 outgoing 关系，过期的 incoming derived 不会让来源资产失效"],
    ["tests/studio-generation-ledger.test.ts", "同 generationRunId+variant 禁止静默换图，raw/labeled 可作为两个显式变体"],
    ["tests/studio-asset-knowledge.test.ts", "以不可变定义版本追加范围历史，并可对项目/季/集/单元/秒段做失败关闭判断"],
    ["tests/studio-asset-knowledge.test.ts", "跨类别组合成员可追溯、精确重放幂等，端点语义变化会让关系过期"],
    ["tests/studio-asset-knowledge.test.ts", "过期 head 只能用双 revision CAS 追加同语义修订，重放幂等且历史完整可查"],
    ["tests/studio-generation.test.ts", "组合无权威时建立成员关系，锁定组合权威后可显式 rebase 恢复冻结且旧历史不阻断"],
    ["tests/material-studio.test.ts", "历史版本禁止伪造 UPDATE，直接插入 approved 但没有审核收据也不能提升"],
    ["tests/mcp-managed-studio.test.ts", "compiled MCP 只接受 pending 新版本，伪造 approved 状态也无法绕过审核收据"],
    ["tests/material-studio-pagination.test.ts", "每次只保留当前页且最多 36 个唯一 DOM 条目"],
    ["tests/managed-project-create-ui.test.ts", "固定 story_first 并保留用户明确填写的隔离父目录"],
    ["tests/managed-project-service.test.ts", "服务成功创建时只写 managed_created，并保持三库与活动指针为空且隔离"],
    ["scripts/ui-managed-studio-scale-smoke.ts", "const SCRIPT_COUNT = 10_000"],
  ] as const;
  const result: Array<{ file: FileEvidence; phrase: string }> = [];
  for (const [relativePath, phrase] of contracts) {
    const absolutePath = path.join(workspace, relativePath);
    const content = await readFile(absolutePath, "utf8");
    assert(content.includes(phrase), `规模/可靠性测试契约缺失：${relativePath} :: ${phrase}`);
    result.push({ file: await fileEvidence(absolutePath), phrase });
  }
  return result;
}

for (const target of [outputPath, runRoot]) {
  await stat(target).then(
    () => { throw new Error(`最终验证目标已存在，拒绝覆盖：${target}`); },
    (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; },
  );
}

const sourceBefore = await inventorySnapshot(sourceRoot);
assert(sourceBefore.files === expectedSource.files && sourceBefore.bytes === expectedSource.bytes
  && sourceBefore.aggregateSha256 === expectedSource.aggregateSha256,
`第三季只读源基线漂移：${JSON.stringify(sourceBefore)}`);
const workspaceSourceBefore = await workspaceSourceDigest();
const rawManagedLayout = await assertManagedProjectRawLayoutReady();
const rawTreeBeforeGetter = await managedProjectTreeShape(projectRoot);
const rawSymlinkEntriesBeforeGetter = await assertProjectHasNoSymlinks();

const formalMaterialDatabase = path.join(projectRoot, ".aicanvas", "material-studio.sqlite");
const formalProductionDatabase = path.join(projectRoot, ".aicanvas", "studio-production.sqlite");
const formalGenerationDatabase = path.join(projectRoot, ".aicanvas", "studio-generation-ledger.sqlite");
const formalEventsPath = path.join(projectRoot, ".aicanvas", "events.jsonl");
const walBefore = await assertEmptySqliteWal([formalMaterialDatabase, formalProductionDatabase, formalGenerationDatabase]);
const walHeaders = await assertSqliteWalHeaders([formalMaterialDatabase, formalProductionDatabase, formalGenerationDatabase]);
const materialKnowledgeSchema = assertMaterialKnowledgeSchemaReady(formalMaterialDatabase);
const productionKnowledgeSchema = assertProductionSchemaReady(formalProductionDatabase);
const generationLedgerSchema = assertGenerationLedgerSchemaReady(formalGenerationDatabase);
const storyFirstCreationEvent = await assertStoryFirstCreationEvent(formalEventsPath);
const criticalPaths = [...new Set([
  rawManagedLayout.manifest.path,
  ...rawManagedLayout.requiredFiles,
])].sort((left, right) => left.localeCompare(right, "en"));
const projectBefore = await criticalProjectSnapshot(criticalPaths);
const logicalBefore = {
  material: sqliteLogicalSnapshot(formalMaterialDatabase),
  production: sqliteLogicalSnapshot(formalProductionDatabase),
  generation: sqliteLogicalSnapshot(formalGenerationDatabase),
};

const shell = await getManagedProjectShell(projectRoot);
assert(shell, "正式 Codex 素材中心不是有效受管项目。 ");
const shellCriticalPaths = [
  shell.paths.config, shell.paths.index, shell.paths.cache, shell.paths.manifest,
  shell.paths.materialDatabase, shell.paths.productionDatabase, shell.paths.generationDatabase, formalEventsPath,
].sort((left, right) => left.localeCompare(right, "en"));
assert(JSON.stringify(shellCriticalPaths) === JSON.stringify(criticalPaths), "受管 shell 返回的关键路径与 raw manifest 预检不一致。 ");
const [material, production, generation] = await Promise.all([
  getMaterialStudioState(projectRoot),
  getStudioProductionState(projectRoot),
  getStudioGenerationLedgerState(projectRoot),
]);
const [projectAfterRead, logicalAfterRead, rawTreeAfterGetter, walAfterGetter] = await Promise.all([
  criticalProjectSnapshot(criticalPaths),
  Promise.resolve({
    material: sqliteLogicalSnapshot(shell.paths.materialDatabase),
    production: sqliteLogicalSnapshot(shell.paths.productionDatabase),
    generation: sqliteLogicalSnapshot(shell.paths.generationDatabase),
  }),
  managedProjectTreeShape(projectRoot),
  assertEmptySqliteWal([formalMaterialDatabase, formalProductionDatabase, formalGenerationDatabase]),
]);
const rawSymlinkEntriesAfterGetter = await assertProjectHasNoSymlinks();
assert(JSON.stringify(projectAfterRead) === JSON.stringify(projectBefore), "正式工程 getter 在预检后仍改写了关键侧车，拒绝验证器自修复。 ");
assert(JSON.stringify(logicalAfterRead) === JSON.stringify(logicalBefore), "正式工程 getter 在预检后改变了 SQLite 逻辑状态。 ");
assert(JSON.stringify(walAfterGetter) === JSON.stringify(walBefore), "正式工程 getter 在预检后写入了 SQLite WAL。 ");
assert(JSON.stringify(rawTreeAfterGetter) === JSON.stringify(rawTreeBeforeGetter), "正式工程 getter 在 raw 预检后自行补建了文件或空目录。 ");
assert(shell.project.id === expectedProject.id && shell.project.name === expectedProject.name, "正式受管工程身份漂移。 ");
assert(shell.manifestFingerprint === expectedProject.manifestFingerprint, "正式受管工程 manifest 指纹漂移。 ");
assert(shell.project.sourceRoots.length === 0 && shell.project.outputRoots.length === 1
  && path.resolve(shell.project.outputRoots[0] ?? "") === projectRoot,
"正式受管工程读写根隔离策略漂移。 ");
assert(shell.manifest.startupPolicy === "no-filesystem-scan" && shell.manifest.legacyRoots.length === 0, "正式受管工程启动策略漂移。 ");
assert(Object.values(material.counts).every((value) => value === 0)
  && Object.values(production.counts).every((value) => value === 0)
  && Object.values(generation.counts).every((value) => value === 0),
`正式受管工程应保持空生产基线：${JSON.stringify({ material: material.counts, production: production.counts, generation: generation.counts })}`);

const manifest = JSON.parse(await readFile(shell.paths.manifest, "utf8")) as { relativePaths?: Record<string, string>; fingerprint?: string };
assert(manifest.fingerprint === expectedProject.manifestFingerprint
  && manifest.relativePaths?.generationDatabase === ".aicanvas/studio-generation-ledger.sqlite"
  && manifest.relativePaths?.generationPackCas === ".aicanvas/studio-generation/objects/sha256",
"正式 manifest 未显式冻结 generation 账本路径。 ");
const activePointerPath = path.join(path.dirname(process.env.AI_CANVAS_REGISTRY_PATH ?? path.join(process.env.HOME ?? "", ".aicanvas", "projects.json")), "active-project.json");
const activePointerBefore = await fileEvidence(activePointerPath);
const activePointer = JSON.parse(await readFile(activePointerPath, "utf8")) as { primaryRoot?: string };
assert(path.resolve(activePointer.primaryRoot ?? "") === projectRoot, "活动工程指针没有指向 Codex AI 短剧素材中心。 ");

const sqliteIntegrity = {
  material: databaseIntegrity(shell.paths.materialDatabase),
  production: databaseIntegrity(shell.paths.productionDatabase),
  generation: databaseIntegrity(shell.paths.generationDatabase),
};
const projectEntryCount = rawSymlinkEntriesAfterGetter;
const wholeProjectBefore = await managedProjectSnapshot(projectRoot);
const scaleContracts = await validateScaleContracts();
await mkdir(runRoot, { recursive: false });

const targetedTests = [
  "tests/managed-project.test.ts",
  "tests/material-studio.test.ts",
  "tests/studio-production.test.ts",
  "tests/studio-media-protocol.test.ts",
  "tests/studio-media-derivatives.test.ts",
  "tests/studio-generation.test.ts",
  "tests/studio-generation-ledger.test.ts",
  "tests/studio-asset-knowledge.test.ts",
  "tests/studio-command-bus.test.ts",
  "tests/mcp-managed-studio.test.ts",
  "tests/mcp.test.ts",
  "tests/material-studio-pagination.test.ts",
  "tests/managed-project-create-ui.test.ts",
  "tests/managed-project-service.test.ts",
];
const targeted = await runCommand("targeted-tests", "npx", ["vitest", "run", ...targetedTests], 8 * 60_000);
assert(targeted.evidence.testSummary?.filesPassed === targetedTests.length
  && targeted.evidence.testSummary?.testsPassed === 96
  && targeted.evidence.testSummary?.filesSkipped === 0
  && targeted.evidence.testSummary?.testsSkipped === 0,
`P5 定向测试统计无效：${JSON.stringify(targeted.evidence.testSummary)}`);

const full = await runCommand("full-tests", "npm", ["test"], 12 * 60_000);
assert(full.evidence.testSummary?.filesPassed === 72 && full.evidence.testSummary.testsPassed === 482
  && full.evidence.testSummary.filesSkipped === 0 && full.evidence.testSummary.testsSkipped === 0,
`全量测试统计漂移：${JSON.stringify(full.evidence.testSummary)}`);

const build = await runCommand("production-build", "npm", ["run", "build"], 8 * 60_000);
const finalBuildIdentity = await compiledBuildIdentity();
const mcp = await runCommand("compiled-mcp", "npx", ["tsx", "scripts/mcp-smoke.ts", "dist-mcp/mcp/server.js"], 3 * 60_000);
const mcpValue = JSON.parse(mcp.stdout) as { toolCount?: number; tools?: string[] };
assert(mcpValue.toolCount === expectedToolCount
  && mcpValue.tools?.includes("get_managed_studio_overview")
  && mcpValue.tools.includes("get_studio_generation_control")
  && mcpValue.tools.includes("list_studio_media_import_origins")
  && mcpValue.tools.includes("execute_command"),
`compiled MCP 能力不完整：${JSON.stringify({ toolCount: mcpValue.toolCount })}`);

const uiEvidence = JSON.parse(await readFile(uiEvidencePath, "utf8")) as any;
const scaleUiEvidence = JSON.parse(await readFile(scaleUiEvidencePath, "utf8")) as any;
const [uiEvidenceFile, uiScreenshotFile, uiMetadata, uiStats, scaleUiEvidenceFile, scaleUiScreenshotFile, scaleUiMetadata, scaleUiStats] = await Promise.all([
  fileEvidence(uiEvidencePath),
  fileEvidence(uiScreenshotPath),
  sharp(uiScreenshotPath).metadata(),
  sharp(uiScreenshotPath).stats(),
  fileEvidence(scaleUiEvidencePath),
  fileEvidence(scaleUiScreenshotPath),
  sharp(scaleUiScreenshotPath).metadata(),
  sharp(scaleUiScreenshotPath).stats(),
]);
assert(uiEvidence.status === "pass"
  && uiEvidence.project?.startupPolicy === "no-filesystem-scan"
  && Array.isArray(uiEvidence.project?.legacyRoots) && uiEvidence.project.legacyRoots.length === 0
  && uiEvidence.ui?.strictFifteenSecondTimelineVisible === true
  && uiEvidence.ui?.panelCount === 2
  && uiEvidence.ui?.materialCounts?.canonicalAssets === 4
  && uiEvidence.ui?.materialCounts?.primaryAuthorities === 4
  && uiEvidence.ui?.materialCounts?.assetRelations === 2
  && uiEvidence.ui?.applicabilityVisible === true
  && Array.isArray(uiEvidence.ui?.relationWorkflow) && uiEvidence.ui.relationWorkflow.includes("append-reference-of")
  && Array.isArray(uiEvidence.ui?.relationRevisionWorkflow)
  && uiEvidence.ui.relationRevisionWorkflow.includes("render-stale")
  && uiEvidence.ui.relationRevisionWorkflow.includes("rebase-current")
  && uiEvidence.ui.relationRevisionWorkflow.includes("retain-superseded-history")
  && Array.isArray(uiEvidence.ui?.textDocumentWorkflow) && uiEvidence.ui.textDocumentWorkflow.includes("open-frozen-prompt-body")
  && uiEvidence.ui?.managedProjectCreationEntryVisible === true
  && uiEvidence.ui?.managedProjectCreatedAndOpened === true
  && uiEvidence.ui?.managedProjectCreation?.differentRoot === true
  && uiEvidence.ui?.managedProjectCreation?.parentMatches === true
  && uiEvidence.ui?.managedProjectCreation?.slugMatches === true
  && uiEvidence.ui?.managedProjectCreation?.activePointerMatches === true
  && Array.isArray(uiEvidence.ui?.managedProjectCreation?.sourceRoots) && uiEvidence.ui.managedProjectCreation.sourceRoots.length === 0
  && Array.isArray(uiEvidence.ui?.managedProjectCreation?.outputRoots)
  && uiEvidence.ui.managedProjectCreation.outputRoots.length === 1
  && uiEvidence.ui.managedProjectCreation.outputRoots[0] === uiEvidence.ui.managedProjectCreation.projectRoot
  && uiEvidence.ui?.managedProjectCreation?.startupPolicy === "no-filesystem-scan"
  && uiEvidence.ui?.managedProjectCreation?.materialCounts?.media === 0
  && uiEvidence.ui?.managedProjectCreation?.materialCounts?.canonicalAssets === 0
  && uiEvidence.ui?.managedProjectCreation?.productionCounts?.textDocuments === 0
  && uiEvidence.ui?.managedProjectCreation?.productionCounts?.units === 0
  && uiEvidence.ui?.managedProjectCreation?.generationCounts?.packs === 0
  && uiEvidence.ui?.managedProjectCreation?.generationCounts?.results === 0
  && Object.values(uiEvidence.ui?.managedProjectCreation?.materialCounts ?? {}).every((value) => value === 0)
  && Object.values(uiEvidence.ui?.managedProjectCreation?.productionCounts ?? {}).every((value) => value === 0)
  && Object.values(uiEvidence.ui?.managedProjectCreation?.generationCounts ?? {}).every((value) => value === 0)
  && uiEvidence.ui?.managedProjectCreation?.bootstrap?.total === 0
  && uiEvidence.ui?.managedProjectCreation?.bootstrap?.items === 0
  && uiEvidence.ui?.managedProjectCreation?.bootstrap?.artifacts === 0
  && uiEvidence.ui?.managedProjectCreation?.bootstrap?.discoveredFiles === 0
  && uiEvidence.ui?.managedProjectCreation?.managedCreatedEventCount === 1
  && uiEvidence.ui?.managedProjectCreation?.originalFixtureAndLegacySentinelUnchanged === true
  && uiEvidence.ui?.productionCounts?.units === 1
  && uiEvidence.ui?.productionCounts?.scriptDocuments === 1
  && uiEvidence.ui?.productionCounts?.promptDocuments === 1
  && uiEvidence.ui?.decodedImageCount >= 4
  && uiEvidence.startup?.externalRequests === 0
  && uiEvidence.startup?.pageErrors === 0
  && uiEvidence.startup?.studioMediaRequests >= 4
  && Array.isArray(uiEvidence.startup?.studioMediaFailures) && uiEvidence.startup.studioMediaFailures.length === 0
  && uiEvidence.startup?.watcherSwitch?.legacyWatcherStarted === true
  && uiEvidence.startup?.watcherSwitch?.switchedToManaged === true
  && Array.isArray(uiEvidence.startup?.watcherSwitch?.errors) && uiEvidence.startup.watcherSwitch.errors.length === 0
  && uiEvidence.startup?.watcherSwitch?.legacySidecarCreated === false
  && uiEvidence.screenshot?.sha256 === uiScreenshotFile.sha256
  && uiEvidence.screenshot?.sizeBytes === uiScreenshotFile.sizeBytes
  && uiEvidence.boundaries?.formalImageGenerationCalls === 0
  && uiEvidence.boundaries?.browserSupplierCalls === 0
  && uiEvidence.boundaries?.uploads === 0
  && uiEvidence.boundaries?.sourceWrites === 0,
"P5 Electron UI 证据未满足隔离、时间线、权威图解码或零外部副作用门禁。 ");
assert(JSON.stringify(uiEvidence.buildIdentity) === JSON.stringify(finalBuildIdentity),
  "P5 Electron UI 证据与最终 production build 身份不一致，拒绝用旧 UI smoke 关账。 ");
assert((uiMetadata.width ?? 0) >= 1_400 && (uiMetadata.height ?? 0) >= 850
  && uiScreenshotFile.sizeBytes >= 50_000
  && Math.max(...uiStats.channels.map((channel) => channel.stdev)) >= 5,
"P5 Electron UI 截图疑似空白、占位或不可用。 ");
assert(scaleUiEvidence.status === "pass"
  && JSON.stringify(scaleUiEvidence.buildIdentity) === JSON.stringify(finalBuildIdentity)
  && scaleUiEvidence.fixture?.scriptDocuments === 10_000
  && scaleUiEvidence.fixture?.promptDocuments === 1
  && Array.isArray(scaleUiEvidence.fixture?.sourceRoots) && scaleUiEvidence.fixture.sourceRoots.length === 0
  && scaleUiEvidence.fixture?.startupPolicy === "no-filesystem-scan"
  && scaleUiEvidence.startup?.pageErrors === 0
  && scaleUiEvidence.startup?.externalRequests === 0
  && scaleUiEvidence.ui?.pageLimit === 36
  && scaleUiEvidence.ui?.maximumMaterialEntryDomCount <= 36
  && scaleUiEvidence.ui?.pageOneDomCount === 36
  && scaleUiEvidence.ui?.pageTwoDomCount === 36
  && scaleUiEvidence.ui?.previousRestored === true
  && scaleUiEvidence.ui?.kindSwitchReset === true
  && scaleUiEvidence.ui?.promptKindCount === 1
  && scaleUiEvidence.screenshot?.sha256 === scaleUiScreenshotFile.sha256
  && scaleUiEvidence.screenshot?.sizeBytes === scaleUiScreenshotFile.sizeBytes
  && scaleUiEvidence.boundaries?.formalImageGenerationCalls === 0
  && scaleUiEvidence.boundaries?.browserSupplierCalls === 0
  && scaleUiEvidence.boundaries?.uploads === 0,
"P5 10k 规模 Electron UI 证据未证明有界 36 DOM、翻页替换、分类重置或零外部请求。 ");
assert((scaleUiMetadata.width ?? 0) >= 1_400 && (scaleUiMetadata.height ?? 0) >= 800
  && scaleUiScreenshotFile.sizeBytes >= 40_000
  && Math.max(...scaleUiStats.channels.map((channel) => channel.stdev)) >= 5,
"P5 10k 规模 Electron UI 截图疑似空白、占位或不可用。 ");

const logicalAfter = {
  material: sqliteLogicalSnapshot(shell.paths.materialDatabase),
  production: sqliteLogicalSnapshot(shell.paths.productionDatabase),
  generation: sqliteLogicalSnapshot(shell.paths.generationDatabase),
};
const [sourceAfter, workspaceSourceAfter, projectAfter, wholeProjectAfter, walAfter, compiledServer, packageLock, activePointerFile] = await Promise.all([
  inventorySnapshot(sourceRoot),
  workspaceSourceDigest(),
  criticalProjectSnapshot(criticalPaths),
  managedProjectSnapshot(projectRoot),
  assertEmptySqliteWal([formalMaterialDatabase, formalProductionDatabase, formalGenerationDatabase]),
  fileEvidence(path.join(workspace, "dist-mcp", "mcp", "server.js")),
  fileEvidence(path.join(workspace, "package-lock.json")),
  fileEvidence(activePointerPath),
]);
const projectEntryCountAfter = await assertProjectHasNoSymlinks();
const rawTreeAfterValidation = await managedProjectTreeShape(projectRoot);
assert(JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore), "最终验证期间第三季只读源发生变化。 ");
assert(JSON.stringify(workspaceSourceAfter) === JSON.stringify(workspaceSourceBefore), "最终验证期间源码、测试、脚本或构建配置发生变化。 ");
assert(JSON.stringify(projectAfter) === JSON.stringify(projectBefore), "最终验证期间正式受管工程关键侧车发生变化。 ");
assert(JSON.stringify(activePointerFile) === JSON.stringify(activePointerBefore), "最终验证期间活动工程指针发生变化。 ");
assert(JSON.stringify(wholeProjectAfter) === JSON.stringify(wholeProjectBefore), "最终验证期间正式受管工程完整文件快照发生变化。 ");
assert(JSON.stringify(logicalAfter) === JSON.stringify(logicalBefore), "最终验证期间正式 SQLite 逻辑状态发生变化。 ");
assert(JSON.stringify(walAfter) === JSON.stringify(walBefore), "最终验证期间正式 SQLite WAL 状态发生变化。 ");
assert(JSON.stringify(rawTreeAfterValidation) === JSON.stringify(rawTreeAfterGetter), "最终验证期间正式工程文件/目录树发生变化。 ");

const evidence = {
  schemaVersion: 1,
  kind: "p5-managed-studio-final-validation",
  status: "pass",
  createdAt: new Date().toISOString(),
  scope: {
    phase: "P5",
    softwareOnly: true,
    formalSeasonProductionComplete: false,
    formalImageGenerationCalls: 0,
    browserSupplierCalls: 0,
    uploads: 0,
  },
  project: {
    root: projectRoot,
    id: shell.project.id,
    name: shell.project.name,
    manifestFingerprint: shell.manifestFingerprint,
    sourceRoots: shell.project.sourceRoots,
    outputRoots: shell.project.outputRoots,
    startupPolicy: shell.manifest.startupPolicy,
    legacyRoots: shell.manifest.legacyRoots,
    activePointer: activePointerFile,
    activePointerBefore,
    noSymlinkEntriesChecked: projectEntryCount,
    noSymlinkEntriesCheckedAfter: projectEntryCountAfter,
    rawSymlinkEntriesBeforeGetter,
    rawSymlinkEntriesAfterGetter,
    rawManagedLayout,
    rawTreeBeforeGetter,
    rawTreeAfterGetter,
    rawTreeAfterValidation,
    sqliteIntegrity,
    counts: { material: material.counts, production: production.counts, generation: generation.counts },
    materialKnowledgeSchema,
    productionKnowledgeSchema,
    generationLedgerSchema,
    storyFirstCreationEvent,
    criticalBefore: projectBefore,
    criticalAfter: projectAfter,
    wholeProjectBefore,
    wholeProjectAfter,
    logicalBefore,
    logicalAfter,
    walBefore,
    walAfter,
    walHeaders,
    unchangedDuringValidation: true,
  },
  capabilities: {
    canonicalAssets: ["character", "scene", "prop", "alias", "immutable-version", "approved-authority", "positive-lock", "negative-lock", "applicability-gate", "append-only-provenance", "composite-member"],
    media: ["project-local-cas", "streaming-sha256", "thumbnail", "video-poster", "video-720p-proxy", "audio-waveform", "range-streaming"],
    production: ["script-revision", "prompt-revision", "strict-15s", "2-to-6-panels", "asset-timeline"],
    codexGeneration: ["freeze-verified-pack", "max-6-control-references", "forbidden-exclusion", "applicability-fail-closed", "relation-currentness", "composite-member-provenance", "result-registration", "raw-labeled-variants", "sha-drift-fail-closed"],
  },
  commandRuns: {
    targeted: targeted.evidence,
    full: full.evidence,
    build: build.evidence,
    compiledMcp: mcp.evidence,
  },
  compiledMcp: {
    toolCount: mcpValue.toolCount,
    requiredTools: ["get_managed_studio_overview", "get_studio_generation_control", "list_studio_media_import_origins", "execute_command"],
    server: compiledServer,
  },
  scaleAndReliabilityContracts: scaleContracts,
  electronUi: {
    evidence: uiEvidenceFile,
    screenshot: uiScreenshotFile,
    width: uiMetadata.width,
    height: uiMetadata.height,
    format: uiMetadata.format,
    decodedImages: uiEvidence.ui.decodedImageCount,
    studioMediaRequests: uiEvidence.startup.studioMediaRequests,
    studioMediaFailures: uiEvidence.startup.studioMediaFailures,
    supersedesEvidence: [
      "docs/evidence/p5-managed-studio-ui-smoke-20260718-01.json",
      "docs/evidence/p5-managed-studio-ui-smoke-20260718-02.json",
      "docs/evidence/p5-managed-studio-ui-smoke-20260718-03.json",
    ],
    scale: {
      evidence: scaleUiEvidenceFile,
      screenshot: scaleUiScreenshotFile,
      width: scaleUiMetadata.width,
      height: scaleUiMetadata.height,
      format: scaleUiMetadata.format,
      scriptDocuments: scaleUiEvidence.fixture.scriptDocuments,
      maximumMaterialEntryDomCount: scaleUiEvidence.ui.maximumMaterialEntryDomCount,
    },
  },
  source: { before: sourceBefore, after: sourceAfter, unchanged: true },
  buildIdentity: {
    workspaceSourceBefore,
    workspaceSourceAfter,
    unchanged: true,
    packageLock,
    compiled: finalBuildIdentity,
  },
  boundaries: {
    oldProjectsScannedAtStartup: 0,
    formalImagesCreated: 0,
    formalVideosCreated: 0,
    formalAudioCreated: 0,
    externalGenerationCalls: 0,
    browserCalls: 0,
    uploads: 0,
    gitOperations: 0,
  },
};
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({
  outputPath,
  status: evidence.status,
  targeted: targeted.evidence.testSummary,
  full: full.evidence.testSummary,
  toolCount: mcpValue.toolCount,
  ui: { decodedImages: uiEvidence.ui.decodedImageCount, mediaRequests: uiEvidence.startup.studioMediaRequests },
  source: sourceAfter,
}, null, 2)}\n`);
