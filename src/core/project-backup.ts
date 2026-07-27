/**
 * P10-R：受管工程备份 / 恢复 / 旧构建拒绝。
 * - manifest 含 per-file size+sha + aggregate + fingerprint
 * - restore 前全量校验；缺失/额外/篡改失败关闭
 * - 目标已存在则拒绝；staging 验证后原子 rename
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { backup as backupSqliteDatabase, DatabaseSync } from "node:sqlite";
import { inspectManagedProject } from "./managed-project.js";
import { writeJsonAtomic } from "./sidecar.js";
import { resolveRuntimeBuildIdentity } from "./build-identity.js";
import { withProjectLock } from "./locks.js";
import { withSqliteBusyRetry } from "./studio-sqlite-busy.js";

export const PROJECT_BACKUP_SCHEMA_VERSION = 2 as const;

export interface ProjectBackupFileEntry {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface ProjectBackupManifest {
  schemaVersion: typeof PROJECT_BACKUP_SCHEMA_VERSION;
  kind: "project-backup-manifest";
  projectId: string;
  projectName: string;
  createdAt: string;
  sourceProjectRoot: string;
  backupRoot: string;
  sourceDigestAtBackup?: string;
  buildIdAtBackup?: string;
  snapshot?: {
    strategy: "sqlite-online-backup-write-barrier-v1";
    sourceStabilityVerified: true;
    ordinaryFileCount: number;
    sqliteDatabases: string[];
  };
  fileCount: number;
  files: ProjectBackupFileEntry[];
  aggregateSha256: string;
  fingerprint: string;
}

export interface ProjectBackupResult {
  manifest: ProjectBackupManifest;
  backupRoot: string;
}

export interface CreateManagedProjectBackupOptions {
  sqliteBusyTimeoutMs?: number;
}

export interface RestoreManagedProjectBackupOptions {
  forbiddenProjectRoots?: readonly string[];
}

export class ManagedProjectRestoreError extends Error {
  readonly projectRoot: string;
  readonly preservedForRecovery = true;

  constructor(projectRoot: string, cause: unknown) {
    super(`恢复副本已落盘，但身份校验失败；现场已保留供诊断：${projectRoot}`, { cause });
    this.name = "ManagedProjectRestoreError";
    this.projectRoot = projectRoot;
  }
}

const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 15_000;
const SQLITE_DATABASE_SUFFIX = ".sqlite";
const SQLITE_TRANSIENT_SUFFIXES = [".sqlite-wal", ".sqlite-shm", ".sqlite-journal"] as const;

function digest(value: unknown): string {
  const stable = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([k, v]) => [k, stable(v)]));
    }
    return input;
  };
  return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

async function snapshotRegularFile(filePath: string): Promise<{ sizeBytes: number; sha256: string }> {
  const pathBefore = await lstat(filePath, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    throw new Error(`受管工程备份只接受无符号链接的普通文件：${filePath}`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    if (!descriptorBefore.isFile()
      || descriptorBefore.dev !== pathBefore.dev
      || descriptorBefore.ino !== pathBefore.ino) {
      throw new Error(`受管工程文件在打开期间被替换：${filePath}`);
    }
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer);
      sizeBytes += (chunk as Buffer).byteLength;
    }
    const [descriptorAfter, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(filePath, { bigint: true }),
    ]);
    if (pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || descriptorAfter.dev !== descriptorBefore.dev
      || descriptorAfter.ino !== descriptorBefore.ino
      || descriptorAfter.size !== descriptorBefore.size
      || descriptorAfter.mtimeNs !== descriptorBefore.mtimeNs
      || descriptorAfter.ctimeNs !== descriptorBefore.ctimeNs
      || pathAfter.dev !== descriptorBefore.dev
      || pathAfter.ino !== descriptorBefore.ino
      || pathAfter.size !== descriptorBefore.size
      || sizeBytes !== Number(descriptorBefore.size)) {
      throw new Error(`受管工程文件在备份读取期间发生漂移：${filePath}`);
    }
    return { sizeBytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function walkFiles(
  root: string,
  options: { skipSnapshotExcludedDirectories?: boolean } = {},
): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relativePath = portableRelative(root, absolute);
      if (options.skipSnapshotExcludedDirectories && isExcludedSnapshotDirectory(relativePath)) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`受管工程备份禁止符号链接：${relativePath}`);
      }
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) out.push(absolute);
      else throw new Error(`受管工程备份仅支持普通文件和目录：${relativePath}`);
    }
  }
  await walk(root);
  return out.sort((a, b) => a.localeCompare(b, "en"));
}

function portableRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function isExcludedSnapshotDirectory(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.includes("node_modules")
    || (segments[0] === ".aicanvas" && segments[1] === "locks");
}

function isExcludedSnapshotPath(relativePath: string): boolean {
  if (!relativePath) return false;
  const segments = relativePath.split("/");
  if (isExcludedSnapshotDirectory(relativePath)) return true;
  const name = segments.at(-1) ?? "";
  return name.endsWith(SQLITE_DATABASE_SUFFIX)
    || SQLITE_TRANSIENT_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

async function inventoryProjectTree(
  projectRoot: string,
  options: { excludeSnapshotSpecialFiles?: boolean } = {},
): Promise<ProjectBackupFileEntry[]> {
  const files = await walkFiles(projectRoot, {
    skipSnapshotExcludedDirectories: options.excludeSnapshotSpecialFiles,
  });
  const entries: ProjectBackupFileEntry[] = [];
  for (const absolute of files) {
    const relativePath = portableRelative(projectRoot, absolute);
    if (options.excludeSnapshotSpecialFiles && isExcludedSnapshotPath(relativePath)) continue;
    const snapshot = await snapshotRegularFile(absolute);
    entries.push({
      relativePath,
      sizeBytes: snapshot.sizeBytes,
      sha256: snapshot.sha256,
    });
  }
  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "en"));
}

function assertInventoriesEqual(
  before: ProjectBackupFileEntry[],
  after: ProjectBackupFileEntry[],
  label: string,
): void {
  if (before.length !== after.length || aggregateFromFiles(before) !== aggregateFromFiles(after)) {
    throw new Error(`${label}在备份窗口内发生变化，无法建立一致快照。`);
  }
}

function assertStringListsEqual(before: string[], after: string[], label: string): void {
  if (before.length !== after.length || before.some((value, index) => value !== after[index])) {
    throw new Error(`${label}在备份窗口内发生变化，无法建立一致快照。`);
  }
}

async function discoverSqliteDatabases(projectRoot: string): Promise<string[]> {
  return (await walkFiles(projectRoot, { skipSnapshotExcludedDirectories: true }))
    .map((absolute) => portableRelative(projectRoot, absolute))
    .filter((relativePath) => {
      const segments = relativePath.split("/");
      return !segments.includes("node_modules")
        && !(segments[0] === ".aicanvas" && segments[1] === "locks")
        && relativePath.endsWith(SQLITE_DATABASE_SUFFIX);
    })
    .sort((left, right) => left.localeCompare(right, "en"));
}

interface LockedSqliteDatabase {
  relativePath: string;
  connection: DatabaseSync;
  dev: number;
  ino: number;
}

async function releaseSqliteWriteBarriers(locked: LockedSqliteDatabase[]): Promise<void> {
  for (const entry of [...locked].reverse()) {
    try { entry.connection.exec("ROLLBACK"); }
    catch { /* close() 仍会释放连接持有的锁。 */ }
    try { entry.connection.close(); }
    catch { /* 不用清理错误覆盖原始备份失败。 */ }
  }
}

// 测试注入计数（AI_CANVAS_TEST_BACKUP_BUSY_TIMES）：记录某 projectRoot 已注入的
// busy 次数，键隔离避免跨用例串扰。
const testBackupBusyAttempts = new Map<string, number>();

async function acquireSqliteWriteBarriers(
  projectRoot: string,
  relativePaths: string[],
  timeoutMs: number,
): Promise<LockedSqliteDatabase[]> {
  // 测试注入：前 N 次获取写屏障直接抛 SQLITE_BUSY（errcode=5），验证 busy 受控重试。
  const injectTimes = Math.max(0, Math.min(12, Number(process.env.AI_CANVAS_TEST_BACKUP_BUSY_TIMES) || 0));
  const injected = testBackupBusyAttempts.get(projectRoot) ?? 0;
  if (injected < injectTimes) {
    testBackupBusyAttempts.set(projectRoot, injected + 1);
    throw Object.assign(new Error("database is locked"), { errcode: 5 });
  }
  const locked: LockedSqliteDatabase[] = [];
  try {
    for (const relativePath of relativePaths) {
      const absolute = path.join(projectRoot, ...relativePath.split("/"));
      let connection: DatabaseSync | undefined;
      try {
        const before = await stat(absolute);
        if (!before.isFile()) throw new Error("数据库路径不是普通文件");
        connection = new DatabaseSync(absolute, { timeout: timeoutMs });
        connection.exec(`PRAGMA busy_timeout=${timeoutMs}; BEGIN IMMEDIATE;`);
        const after = await stat(absolute);
        if (before.dev !== after.dev || before.ino !== after.ino) {
          throw new Error("数据库文件在加锁期间被替换");
        }
        locked.push({ relativePath, connection, dev: after.dev, ino: after.ino });
      } catch (error) {
        try { connection?.close(); }
        catch { /* 保留原始锁定错误。 */ }
        throw new Error(`无法锁定 SQLite 数据库 ${relativePath}，一致性备份已停止。`, { cause: error });
      }
    }
    return locked;
  } catch (error) {
    await releaseSqliteWriteBarriers(locked);
    throw error;
  }
}

async function assertLockedSqliteIdentities(
  projectRoot: string,
  locked: LockedSqliteDatabase[],
): Promise<void> {
  for (const entry of locked) {
    const absolute = path.join(projectRoot, ...entry.relativePath.split("/"));
    const metadata = await stat(absolute).catch(() => null);
    if (!metadata || !metadata.isFile() || metadata.dev !== entry.dev || metadata.ino !== entry.ino) {
      throw new Error(`SQLite 数据库在备份窗口内被替换：${entry.relativePath}`);
    }
  }
}

async function verifySqliteSnapshot(databasePath: string, relativePath: string): Promise<void> {
  let connection: DatabaseSync | undefined;
  try {
    connection = new DatabaseSync(databasePath);
    const journal = connection.prepare("PRAGMA journal_mode").get() as Record<string, unknown> | undefined;
    if (String(journal ? Object.values(journal)[0] : "").toLowerCase() === "wal") {
      const checkpoint = connection.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as Record<string, unknown> | undefined;
      const values = checkpoint ? Object.values(checkpoint).map(Number) : [];
      if (values.length < 3 || values[0] !== 0) {
        throw new Error(`SQLite WAL checkpoint 未通过：${relativePath}`);
      }
      const changed = connection.prepare("PRAGMA journal_mode=DELETE").get() as Record<string, unknown> | undefined;
      if (String(changed ? Object.values(changed)[0] : "").toLowerCase() !== "delete") {
        throw new Error(`SQLite journal mode 无法转为自包含快照：${relativePath}`);
      }
    }
    const rows = connection.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    const values = rows.flatMap((row) => Object.values(row));
    if (values.length !== 1 || values[0] !== "ok") {
      throw new Error(`SQLite quick_check 未通过：${relativePath}`);
    }
  } finally {
    connection?.close();
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (await access(`${databasePath}${suffix}`).then(() => true, () => false)) {
      throw new Error(`SQLite 快照残留瞬态侧文件：${relativePath}${suffix}`);
    }
  }
}

async function backupLockedSqliteDatabase(
  projectRoot: string,
  projectCopy: string,
  relativePath: string,
): Promise<void> {
  const sourcePath = path.join(projectRoot, ...relativePath.split("/"));
  const destinationPath = path.join(projectCopy, ...relativePath.split("/"));
  await mkdir(path.dirname(destinationPath), { recursive: true });
  let source: DatabaseSync | undefined;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
    await backupSqliteDatabase(source, destinationPath);
  } catch (error) {
    throw new Error(`SQLite online backup 失败：${relativePath}`, { cause: error });
  } finally {
    source?.close();
  }
  await verifySqliteSnapshot(destinationPath, relativePath);
}

async function createConsistentProjectSnapshot(
  projectRoot: string,
  projectCopy: string,
  options: CreateManagedProjectBackupOptions,
): Promise<ProjectBackupManifest["snapshot"]> {
  const timeoutMs = Math.max(50, Math.min(60_000, Math.trunc(
    options.sqliteBusyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  )));
  const sqliteDatabases = await discoverSqliteDatabases(projectRoot);
  if (sqliteDatabases.length === 0) {
    throw new Error("受管工程未发现 SQLite 数据库，拒绝建立不完整备份。 ");
  }
  // 写屏障不经 studio-mutation fence（备份走 project-backup 锁），可与命令写路径
  // 瞬时争库；busy 抛出时 BEGIN IMMEDIATE 确认未提交且失败路径已释放部分屏障，
  // 故对获取整体做有界退避重试（预算沿用 helper 默认）。既有 per-DB timeout 不变：
  // 若首次尝试已烧尽预算则按原样抛出，语义与超时保持一致。
  const locked = await withSqliteBusyRetry(() => acquireSqliteWriteBarriers(projectRoot, sqliteDatabases, timeoutMs));
  try {
    await assertLockedSqliteIdentities(projectRoot, locked);
    assertStringListsEqual(
      sqliteDatabases,
      await discoverSqliteDatabases(projectRoot),
      "SQLite 数据库集合",
    );
    const ordinaryBefore = await inventoryProjectTree(projectRoot, { excludeSnapshotSpecialFiles: true });
    await cp(projectRoot, projectCopy, {
      verbatimSymlinks: true,
      recursive: true,
      filter: (source) => {
        const relativePath = portableRelative(projectRoot, source);
        return !isExcludedSnapshotPath(relativePath);
      },
    });
    for (const relativePath of sqliteDatabases) {
      await backupLockedSqliteDatabase(projectRoot, projectCopy, relativePath);
    }
    await assertLockedSqliteIdentities(projectRoot, locked);
    assertStringListsEqual(
      sqliteDatabases,
      await discoverSqliteDatabases(projectRoot),
      "SQLite 数据库集合",
    );
    const ordinaryAfter = await inventoryProjectTree(projectRoot, { excludeSnapshotSpecialFiles: true });
    assertInventoriesEqual(ordinaryBefore, ordinaryAfter, "工程普通文件");
    const copiedOrdinary = await inventoryProjectTree(projectCopy, { excludeSnapshotSpecialFiles: true });
    assertInventoriesEqual(ordinaryBefore, copiedOrdinary, "备份普通文件副本");
    return {
      strategy: "sqlite-online-backup-write-barrier-v1",
      sourceStabilityVerified: true,
      ordinaryFileCount: ordinaryBefore.length,
      sqliteDatabases,
    };
  } finally {
    await releaseSqliteWriteBarriers(locked);
  }
}

function pathIsWithinOrEqual(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function aggregateFromFiles(files: ProjectBackupFileEntry[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(file.sizeBytes));
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function verifyProjectTreeAgainstManifest(
  projectRoot: string,
  manifest: Pick<ProjectBackupManifest, "files" | "fileCount" | "aggregateSha256">,
): Promise<void> {
  const actual = await inventoryProjectTree(projectRoot);
  if (actual.length !== manifest.fileCount || actual.length !== manifest.files.length) {
    throw new Error(`备份文件数不一致：actual=${actual.length} manifest=${manifest.fileCount}`);
  }
  const expectedByPath = new Map(manifest.files.map((file) => [file.relativePath, file]));
  for (const file of actual) {
    const expected = expectedByPath.get(file.relativePath);
    if (!expected) throw new Error(`备份出现额外文件：${file.relativePath}`);
    if (expected.sizeBytes !== file.sizeBytes || expected.sha256 !== file.sha256) {
      throw new Error(`备份文件哈希/大小不符：${file.relativePath}`);
    }
    expectedByPath.delete(file.relativePath);
  }
  if (expectedByPath.size > 0) {
    throw new Error(`备份缺失文件：${[...expectedByPath.keys()].slice(0, 5).join(", ")}`);
  }
  const aggregate = aggregateFromFiles(actual);
  if (aggregate !== manifest.aggregateSha256) {
    throw new Error("备份 aggregateSha256 与重新计算不一致。");
  }
}

export async function createManagedProjectBackup(
  projectRoot: string,
  backupParent: string,
  options: CreateManagedProjectBackupOptions = {},
): Promise<ProjectBackupResult> {
  const shell = await inspectManagedProject(projectRoot);
  const requestedBackupParent = path.resolve(backupParent);
  if (pathIsWithinOrEqual(requestedBackupParent, shell.paths.root)) {
    throw new Error("备份父目录不得位于源工程内部，避免递归复制或污染源工程。 ");
  }
  await mkdir(requestedBackupParent, { recursive: true });
  const [backupParentMetadata, resolvedBackupParent] = await Promise.all([
    lstat(requestedBackupParent),
    realpath(requestedBackupParent),
  ]);
  if (!backupParentMetadata.isDirectory()
    || backupParentMetadata.isSymbolicLink()
    || resolvedBackupParent !== requestedBackupParent
    || pathIsWithinOrEqual(resolvedBackupParent, shell.paths.root)) {
    throw new Error("备份父目录必须是源工程外部、无符号链接的真实目录。 ");
  }

  return withProjectLock(shell.paths.root, "project-backup", async () => {
    const createdAt = new Date().toISOString();
    const stamp = createdAt.replace(/[:.]/gu, "-");
    const backupRoot = path.join(resolvedBackupParent, `backup-${shell.project.id}-${stamp}`);
    const stagingRoot = path.join(resolvedBackupParent, `.backup-staging-${shell.project.id}-${randomUUID()}`);
    const projectCopy = path.join(stagingRoot, "project");
    await mkdir(stagingRoot, { recursive: false });
    try {
      const snapshot = await createConsistentProjectSnapshot(shell.paths.root, projectCopy, options);
      const files = await inventoryProjectTree(projectCopy);
      const aggregateSha256 = aggregateFromFiles(files);

      let sourceDigestAtBackup: string | undefined;
      let buildIdAtBackup: string | undefined;
      for (const candidate of [
        process.env.AI_CANVAS_WORKSPACE,
        process.cwd(),
        path.resolve(projectRoot, "../.."),
        path.resolve(projectRoot, "../../.."),
      ]) {
        if (!candidate) continue;
        try {
          const identity = await resolveRuntimeBuildIdentity(path.resolve(candidate));
          sourceDigestAtBackup = identity.sourceDigest;
          buildIdAtBackup = identity.buildId;
          break;
        } catch {
          // 尝试下一候选
        }
      }

      const body = {
        schemaVersion: PROJECT_BACKUP_SCHEMA_VERSION,
        kind: "project-backup-manifest" as const,
        projectId: shell.project.id,
        projectName: shell.project.name,
        createdAt,
        sourceProjectRoot: shell.paths.root,
        backupRoot,
        sourceDigestAtBackup,
        buildIdAtBackup,
        snapshot,
        fileCount: files.length,
        files,
        aggregateSha256,
      };
      const manifest: ProjectBackupManifest = { ...body, fingerprint: digest(body) };
      await verifyProjectTreeAgainstManifest(projectCopy, manifest);
      await writeFile(path.join(stagingRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await rename(stagingRoot, backupRoot);
      return { manifest, backupRoot };
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}

async function rewriteRestoredManagedIdentity(
  targetRoot: string,
  previousRoot: string,
): Promise<void> {
  const canonicalRoot = path.resolve(targetRoot);
  const sidecar = path.join(canonicalRoot, ".aicanvas");
  const configPath = path.join(sidecar, "project.json");
  const indexPath = path.join(sidecar, "index.json");
  const managedPath = path.join(sidecar, "managed-project.json");
  const [configRaw, indexRaw, managedRaw] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(indexPath, "utf8"),
    readFile(managedPath, "utf8"),
  ]);
  const config = JSON.parse(configRaw) as {
    primaryRoot: string;
    outputRoots: string[];
    sourceRoots: string[];
    id: string;
    name: string;
    [key: string]: unknown;
  };
  const index = JSON.parse(indexRaw) as {
    project: typeof config;
    scanId?: string;
    [key: string]: unknown;
  };
  const managed = JSON.parse(managedRaw) as {
    kind: string;
    rootRealpath: string;
    projectId: string;
    projectName: string;
    projectConfigSha256: string;
    bootstrapIndexSha256: string;
    bootstrapScanId?: string;
    fingerprint: string;
    [key: string]: unknown;
  };

  config.primaryRoot = canonicalRoot;
  config.outputRoots = [canonicalRoot];
  config.sourceRoots = [];
  index.project = {
    ...index.project,
    primaryRoot: canonicalRoot,
    outputRoots: [canonicalRoot],
    sourceRoots: [],
  };

  const configContent = `${JSON.stringify(config, null, 2)}\n`;
  const indexContent = `${JSON.stringify(index, null, 2)}\n`;
  await writeJsonAtomic(configPath, JSON.parse(configContent));
  await writeJsonAtomic(indexPath, JSON.parse(indexContent));

  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const projectConfigSha256 = sha(configContent);
  const bootstrapIndexSha256 = sha(indexContent);
  const { fingerprint: _fp, ...managedPayload } = managed;
  const nextManaged = {
    ...managedPayload,
    rootRealpath: canonicalRoot,
    projectId: config.id,
    projectName: config.name,
    projectConfigSha256,
    bootstrapIndexSha256,
    bootstrapScanId: index.scanId ?? managed.bootstrapScanId,
  };
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]));
    }
    return value;
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(stable(nextManaged))).digest("hex");
  await writeJsonAtomic(managedPath, { ...nextManaged, fingerprint });
  void previousRoot;
}

export async function restoreManagedProjectBackup(
  backupRoot: string,
  targetParent: string,
  options: RestoreManagedProjectBackupOptions = {},
): Promise<{ projectRoot: string; manifest: ProjectBackupManifest }> {
  const resolvedBackup = path.resolve(backupRoot);
  const [backupMetadata, canonicalBackup] = await Promise.all([
    lstat(resolvedBackup),
    realpath(resolvedBackup),
  ]).catch((error) => {
    throw new Error("备份目录不存在或无法读取。", { cause: error });
  });
  if (!backupMetadata.isDirectory() || backupMetadata.isSymbolicLink() || canonicalBackup !== resolvedBackup) {
    throw new Error("备份目录必须是无符号链接的真实目录。");
  }
  const manifestPath = path.join(resolvedBackup, "manifest.json");
  let manifest: ProjectBackupManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProjectBackupManifest;
  } catch (error) {
    throw new Error("备份 manifest 无法读取或不是合法 JSON。", { cause: error });
  }
  const schemaVersion = Number(manifest.schemaVersion);
  if (manifest.kind !== "project-backup-manifest" || (schemaVersion !== 1 && schemaVersion !== 2)) {
    throw new Error("备份 manifest 无效。");
  }
  if (schemaVersion === 1) {
    throw new Error("旧版 schema v1 备份缺少逐文件校验，桌面恢复已拒绝；请用原版本迁移后重新建立 v2 备份。");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(manifest.projectId)) {
    throw new Error("备份 projectId 无效，拒绝构造恢复路径。");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== manifest.fileCount) {
    throw new Error("备份 manifest.files 与 fileCount 不一致。");
  }
  const recomputedFp = digest({
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    projectId: manifest.projectId,
    projectName: manifest.projectName,
    createdAt: manifest.createdAt,
    sourceProjectRoot: manifest.sourceProjectRoot,
    backupRoot: manifest.backupRoot,
    sourceDigestAtBackup: manifest.sourceDigestAtBackup,
    buildIdAtBackup: manifest.buildIdAtBackup,
    snapshot: manifest.snapshot,
    fileCount: manifest.fileCount,
    files: manifest.files,
    aggregateSha256: manifest.aggregateSha256,
  });
  if (recomputedFp !== manifest.fingerprint) {
    throw new Error("备份 manifest.fingerprint 与内容不符（可能被篡改）。");
  }

  const source = path.join(resolvedBackup, "project");
  await stat(source);
  await verifyProjectTreeAgainstManifest(source, manifest);

  const requestedTargetParent = path.resolve(targetParent);
  const requestedTargetRoot = path.join(requestedTargetParent, `restored-${manifest.projectId}`);
  const protectedRoots = [
    canonicalBackup,
    manifest.sourceProjectRoot,
    ...(options.forbiddenProjectRoots ?? []),
  ].filter((value): value is string => Boolean(value?.trim())).map((value) => path.resolve(value));
  for (const protectedRoot of protectedRoots) {
    if (pathIsWithinOrEqual(requestedTargetRoot, protectedRoot)
      || pathIsWithinOrEqual(protectedRoot, requestedTargetRoot)) {
      throw new Error(`恢复目标不得与备份目录或现有工程重叠：${requestedTargetRoot}`);
    }
  }

  await mkdir(requestedTargetParent, { recursive: true });
  const [targetParentMetadata, canonicalTargetParent] = await Promise.all([
    lstat(requestedTargetParent),
    realpath(requestedTargetParent),
  ]);
  if (!targetParentMetadata.isDirectory()
    || targetParentMetadata.isSymbolicLink()
    || canonicalTargetParent !== requestedTargetParent) {
    throw new Error("恢复父目录必须是无符号链接的真实目录。");
  }

  const targetRoot = path.join(canonicalTargetParent, `restored-${manifest.projectId}`);
  // P28：最终目录不再预建“空占位”。并发调用各自在唯一 staging 中复制/校验，
  // 最后的 rename 才是唯一原子认领点；失败调用永远只清理自己的 staging，
  // 因而不可能删除另一个调用已成功落盘的恢复成果。
  if (await lstat(targetRoot).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) {
    throw new Error(`恢复目标已存在，拒绝静默合并/覆盖：${targetRoot}`);
  }
  const stagingRoot = path.join(canonicalTargetParent, `.restore-staging-${manifest.projectId}-${randomUUID()}`);
  let targetMaterializedByThisCall = false;
  try {
    await cp(source, stagingRoot, { recursive: true, verbatimSymlinks: true });
    await verifyProjectTreeAgainstManifest(stagingRoot, manifest);
    // 先原子落到最终路径，再改写身份（避免 staging realpath 写死后 rename 不一致）
    await rename(stagingRoot, targetRoot);
    targetMaterializedByThisCall = true;
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST"
      || (error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
      throw new Error(`恢复目标已被另一调用原子认领，拒绝覆盖：${targetRoot}`, { cause: error });
    }
    throw error;
  }

  try {
    await rewriteRestoredManagedIdentity(targetRoot, manifest.sourceProjectRoot);
    await inspectManagedProject(targetRoot);
  } catch (error) {
    if (targetMaterializedByThisCall) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      await writeFile(path.join(targetRoot, "RESTORE_FAILED.txt"), [
        "AI 漫剧画布恢复未完成",
        "",
        `时间：${new Date().toISOString()}`,
        `原因：${detail}`,
        "",
        "该目录是隔离恢复副本，原工程和备份均未修改。",
        "请不要把它注册为正式工程；修复原因后可重新恢复，或交给诊断工具检查。",
        "",
      ].join("\n"), { flag: "wx", mode: 0o600 }).catch(() => undefined);
    }
    throw new ManagedProjectRestoreError(targetRoot, error);
  }
  return { projectRoot: targetRoot, manifest };
}

export async function refuseOldBuildAgainstNewSource(input: {
  workspace: string;
  recordedSourceDigest: string;
}): Promise<{ allowed: true } | { allowed: false; reason: string; currentSourceDigest: string }> {
  const identity = await resolveRuntimeBuildIdentity(input.workspace);
  if (identity.sourceDigest !== input.recordedSourceDigest) {
    return {
      allowed: false,
      reason: "旧构建的 sourceDigest 与当前源码不一致；拒绝用旧构建操作新源码。",
      currentSourceDigest: identity.sourceDigest,
    };
  }
  return { allowed: true };
}

/**
 * 运行时入口：在受管工程打开/恢复后调用。
 * recordedSourceDigest 缺省时仅返回当前身份，不拒绝。
 */
export async function assertRuntimeBuildCurrentness(input: {
  workspace: string;
  recordedSourceDigest?: string;
}): Promise<{
  buildId: string;
  sourceDigest: string;
  allowed: boolean;
  reason?: string;
}> {
  const identity = await resolveRuntimeBuildIdentity(input.workspace);
  if (!input.recordedSourceDigest) {
    return { buildId: identity.buildId, sourceDigest: identity.sourceDigest, allowed: true };
  }
  if (identity.sourceDigest !== input.recordedSourceDigest) {
    return {
      buildId: identity.buildId,
      sourceDigest: identity.sourceDigest,
      allowed: false,
      reason: "旧构建的 sourceDigest 与当前源码不一致；拒绝用旧构建操作新源码。",
    };
  }
  return { buildId: identity.buildId, sourceDigest: identity.sourceDigest, allowed: true };
}
