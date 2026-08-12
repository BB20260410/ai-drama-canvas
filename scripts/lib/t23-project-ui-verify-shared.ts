/**
 * T23 第四层门（verify:project-ui）共享模块。
 *
 * 只读护栏约定：
 *  - 隔离 userData / registry / managed-projects / media-runtime 全部落在 mkdtemp 目录；
 *  - registry 副本只含目标工程单条记录 + 指向它的 active-project.json；
 *  - 工程单元数推导走「复制 sqlite 到隔离目录后以 readOnly 打开」，绝不直接打开真实库；
 *  - 任何视口移动都会触发画布布局写回（ManagedStudioCanvasView onMoveEnd→saveLayout），
 *    因此本模块不提供也不允许任何平移/缩放/点击工具，只提供被动观察与启动/清理。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  _electron as electron,
  chromium,
  type Browser,
  type ElectronApplication,
  type Page,
} from "playwright";
import sharp from "sharp";
import {
  REDLINE_SENTINEL_MTIME_PRECISION,
  REDLINE_SENTINEL_RELATIVE_PATHS,
  rebindCopiedManagedProjectMetadata,
  snapshotRedlineProjectSentinels,
  type RedlineSentinelSnapshot,
} from "./redline-project-sentinel-shared.js";

/* ---------------------------------- CLI ---------------------------------- */

export class UsageError extends Error {}

/** 通用双编号格式，例如 `029｜S1E01-U28`、`001｜S1E02-U00`。 */
export const T23_DUAL_UNIT_LABEL_PATTERN = /\d{3}｜S\d+E\d+-U\d+/u;

export function matchesT23DualUnitLabel(text: string): boolean {
  return T23_DUAL_UNIT_LABEL_PATTERN.test(text);
}

export interface T23VerifyCliOptions {
  help: boolean;
  /** 目标受管工程绝对路径（必填）。 */
  projectRoot: string;
  mode: "dev" | "build";
  /** 整体看门狗超时（毫秒）。 */
  timeoutMs: number;
  /** 期望单元数；缺省时从工程 sqlite 只读推导。 */
  expectUnits?: number;
  /** 嘟嘟等采用双编号规范的工程，可显式把双编号设为硬门。 */
  requireDualUnitLabel: boolean;
  /** 源注册表路径（默认 ~/.aicanvas/projects.json），仅读取。 */
  sourceRegistryPath: string;
  /** console error 忽略子串（大小写不敏感，追加在内置名单之后）。 */
  consoleIgnoreSubstrings: string[];
  /** 证据输出目录。 */
  evidenceDir: string;
}

export const T23_VERIFY_USAGE = `T23 第四层门：真实受管工程 Electron UI 隔离副本验证（源码 dev / 源码 build）

用法：
  tsx scripts/t23-layer4-project-ui-verify.ts --projectRoot=<绝对路径> [选项]
  npm run verify:project-ui -- --projectRoot=<绝对路径> [--mode=dev|build]

参数：
  --projectRoot=<abs>     受管工程主根绝对路径（必填；必须含 .aicanvas/managed-project.json）
  --mode=dev|build        dev=electron-vite+CDP；build=源码 out/（默认 dev；禁止安装版）
  --timeout=<ms>          整体看门狗超时，默认 300000，最小 5000
  --expect-units=<N>      期望工程单元数；缺省时复制工程 sqlite 到隔离目录只读推导
  --require-dual-label    要求至少一个可见单元命中 001｜S1E01-U00 双编号
  --registry=<path>       源注册表 projects.json 路径，默认 ~/.aicanvas/projects.json（只读）
  --ignore-console=<子串> 追加一条 console error 良性忽略子串（可重复）
  --evidence-dir=<path>   报告/截图输出目录，默认 docs/evidence/source-project-ui/layer4
  --help                  显示本说明（不启动 Electron）

隔离合同：先复制完整工程，再把源码 UI、userData、registry、媒体运行时全部指向临时副本；
全程不点击写按钮、不触发 execute_command 写命令，结束清理隔离目录，正式工程零写入。`;

export function parseT23VerifyCli(argv: string[], defaultEvidenceDir: string): T23VerifyCliOptions {
  const options: T23VerifyCliOptions = {
    help: false,
    projectRoot: "",
    mode: "dev",
    timeoutMs: 300_000,
    requireDualUnitLabel: false,
    sourceRegistryPath: path.join(os.homedir(), ".aicanvas", "projects.json"),
    consoleIgnoreSubstrings: [],
    evidenceDir: defaultEvidenceDir,
  };
  for (const argument of argv) {
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument.startsWith("--projectRoot=")) {
      options.projectRoot = argument.slice("--projectRoot=".length).trim();
      continue;
    }
    if (argument.startsWith("--mode=")) {
      const mode = argument.slice("--mode=".length).trim();
      if (mode !== "dev" && mode !== "build") {
        throw new UsageError(`--mode 只接受 dev | build；本验收禁止安装版：${mode}`);
      }
      options.mode = mode;
      continue;
    }
    if (argument.startsWith("--timeout=")) {
      const raw = argument.slice("--timeout=".length).trim();
      if (!/^\d+$/u.test(raw)) throw new UsageError(`--timeout 必须是正整数毫秒：${raw}`);
      const timeoutMs = Number(raw);
      if (timeoutMs < 5_000) throw new UsageError(`--timeout 最小 5000ms：${raw}`);
      options.timeoutMs = timeoutMs;
      continue;
    }
    if (argument.startsWith("--expect-units=")) {
      const raw = argument.slice("--expect-units=".length).trim();
      if (!/^\d+$/u.test(raw)) throw new UsageError(`--expect-units 必须是非负整数：${raw}`);
      options.expectUnits = Number(raw);
      continue;
    }
    if (argument === "--require-dual-label") {
      options.requireDualUnitLabel = true;
      continue;
    }
    if (argument.startsWith("--registry=")) {
      options.sourceRegistryPath = argument.slice("--registry=".length).trim();
      continue;
    }
    if (argument.startsWith("--ignore-console=")) {
      const substring = argument.slice("--ignore-console=".length);
      if (!substring.trim()) throw new UsageError("--ignore-console 子串不能为空。");
      options.consoleIgnoreSubstrings.push(substring);
      continue;
    }
    if (argument.startsWith("--evidence-dir=")) {
      options.evidenceDir = argument.slice("--evidence-dir=".length).trim();
      continue;
    }
    throw new UsageError(`未知参数：${argument}`);
  }
  if (options.help) return options;
  if (!options.projectRoot) throw new UsageError("缺少必填参数 --projectRoot=<受管工程绝对路径>。");
  if (!path.isAbsolute(options.projectRoot)) {
    throw new UsageError(`--projectRoot 必须是绝对路径：${options.projectRoot}`);
  }
  options.projectRoot = path.resolve(options.projectRoot);
  if (!options.sourceRegistryPath) throw new UsageError("--registry 路径不能为空。");
  options.sourceRegistryPath = path.resolve(options.sourceRegistryPath);
  if (!options.evidenceDir) throw new UsageError("--evidence-dir 路径不能为空。");
  options.evidenceDir = path.resolve(options.evidenceDir);
  return options;
}

/* ---------------------------------- 通用工具 ---------------------------------- */

export async function pathExists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true, () => false);
}

export async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export interface T23ReadonlySentinelEvidence {
  relativePath: string;
  exists: true;
  bytes: number;
  mtimeMs: number;
  sha256: string;
}

export const T23_READONLY_SENTINEL_CANDIDATE_PATHS = [
  ...REDLINE_SENTINEL_RELATIVE_PATHS,
] as const;

export interface T23ReadonlySentinelMissingEvidence {
  relativePath: string;
  exists: false;
}

export type T23ReadonlySentinelState =
  | T23ReadonlySentinelEvidence
  | T23ReadonlySentinelMissingEvidence;

export type T23ReadonlySentinelChangedField =
  | "exists"
  | "sha256"
  | "bytes"
  | "mtimeMs";

export interface T23ReadonlySentinelVerificationItem {
  relativePath: string;
  status: "PASS" | "FAIL";
  changedFields: T23ReadonlySentinelChangedField[];
  before: T23ReadonlySentinelEvidence;
  after: T23ReadonlySentinelState;
}

export interface T23ReadonlySentinelVerification {
  ok: boolean;
  candidateRelativePaths: string[];
  includedExistingCount: number;
  mtimePrecision: typeof REDLINE_SENTINEL_MTIME_PRECISION;
  items: T23ReadonlySentinelVerificationItem[];
}

export interface T23ReadonlyProjectTreeEntry {
  relativePath: string;
  kind: "directory" | "file" | "symlink" | "other";
  bytes: number;
  mtimeMs: number;
  criticalSha256?: string;
  linkTarget?: string;
}

export interface T23ReadonlyProjectTreeSnapshot {
  root: string;
  entries: T23ReadonlyProjectTreeEntry[];
  fingerprint: string;
  criticalContentPaths: string[];
}

export interface T23ReadonlyProjectTreeVerification {
  ok: boolean;
  beforeFingerprint: string;
  afterFingerprint: string;
  beforeEntryCount: number;
  afterEntryCount: number;
  changedPaths: string[];
  addedPaths: string[];
  removedPaths: string[];
  criticalContentChangedPaths: string[];
}

function isT23CriticalReadonlyFile(relativePath: string): boolean {
  return T23_READONLY_SENTINEL_CANDIDATE_PATHS.includes(
    relativePath as (typeof T23_READONLY_SENTINEL_CANDIDATE_PATHS)[number],
  ) || /\.sqlite(?:-(?:wal|shm))?$/u.test(relativePath);
}

/**
 * 正式工程全树只读快照：所有节点记录类型/字节/mtime，关键 SQLite 与六项红线
 * 文件额外记录内容 SHA。符号链接只记录链接本身，不跟随到工程外。
 */
export async function snapshotT23ReadonlyProjectTree(
  projectRoot: string,
): Promise<T23ReadonlyProjectTreeSnapshot> {
  const root = path.resolve(projectRoot);
  const entries: T23ReadonlyProjectTreeEntry[] = [];
  const walk = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      const metadata = await lstat(absolutePath);
      const base = {
        relativePath,
        bytes: metadata.size,
        mtimeMs: Math.trunc(metadata.mtimeMs),
      };
      if (child.isSymbolicLink()) {
        entries.push({ ...base, kind: "symlink", linkTarget: await readlink(absolutePath) });
        continue;
      }
      if (child.isDirectory()) {
        entries.push({ ...base, kind: "directory" });
        await walk(absolutePath);
        continue;
      }
      if (child.isFile()) {
        entries.push({
          ...base,
          kind: "file",
          ...(isT23CriticalReadonlyFile(relativePath)
            ? { criticalSha256: await sha256File(absolutePath) }
            : {}),
        });
        continue;
      }
      entries.push({ ...base, kind: "other" });
    }
  };
  await walk(root);
  const fingerprint = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return {
    root,
    entries,
    fingerprint,
    criticalContentPaths: entries
      .filter((entry) => typeof entry.criticalSha256 === "string")
      .map((entry) => entry.relativePath),
  };
}

export async function verifyT23ReadonlyProjectTree(
  projectRoot: string,
  before: T23ReadonlyProjectTreeSnapshot,
): Promise<T23ReadonlyProjectTreeVerification> {
  const after = await snapshotT23ReadonlyProjectTree(projectRoot);
  const beforeByPath = new Map(before.entries.map((entry) => [entry.relativePath, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.relativePath, entry]));
  const allPaths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
    .sort((left, right) => left.localeCompare(right, "en"));
  const addedPaths = allPaths.filter((relativePath) => !beforeByPath.has(relativePath));
  const removedPaths = allPaths.filter((relativePath) => !afterByPath.has(relativePath));
  const changedPaths = allPaths.filter((relativePath) => {
    const beforeEntry = beforeByPath.get(relativePath);
    const afterEntry = afterByPath.get(relativePath);
    return !beforeEntry || !afterEntry || JSON.stringify(beforeEntry) !== JSON.stringify(afterEntry);
  });
  const criticalContentChangedPaths = changedPaths.filter((relativePath) => {
    const beforeSha = beforeByPath.get(relativePath)?.criticalSha256;
    const afterSha = afterByPath.get(relativePath)?.criticalSha256;
    return (beforeSha !== undefined || afterSha !== undefined) && beforeSha !== afterSha;
  });
  return {
    ok: changedPaths.length === 0,
    beforeFingerprint: before.fingerprint,
    afterFingerprint: after.fingerprint,
    beforeEntryCount: before.entries.length,
    afterEntryCount: after.entries.length,
    changedPaths,
    addedPaths,
    removedPaths,
    criticalContentChangedPaths,
  };
}

function toT23ReadonlySentinelState(
  snapshot: RedlineSentinelSnapshot,
): T23ReadonlySentinelState {
  if (!snapshot.exists) return { relativePath: snapshot.relativePath, exists: false };
  if (
    typeof snapshot.bytes !== "number"
    || typeof snapshot.mtimeMs !== "number"
    || typeof snapshot.sha256 !== "string"
  ) {
    throw new Error(`红线哨兵证据字段不完整：${snapshot.relativePath}`);
  }
  return {
    relativePath: snapshot.relativePath,
    exists: true,
    bytes: snapshot.bytes,
    mtimeMs: snapshot.mtimeMs,
    sha256: snapshot.sha256,
  };
}

/**
 * T23 仅纳入启动前真实存在的候选哨兵；候选清单与 redline helper 共用同一来源，
 * 避免 UI 门和 Core 红线门维护两套文件范围。
 */
export async function snapshotT23ReadonlySentinels(
  projectRoot: string,
): Promise<T23ReadonlySentinelEvidence[]> {
  const snapshots = await snapshotRedlineProjectSentinels(projectRoot);
  return snapshots
    .filter((snapshot) => snapshot.exists)
    .map((snapshot) => toT23ReadonlySentinelState(snapshot) as T23ReadonlySentinelEvidence);
}

/**
 * 应用关闭后逐项复核 SHA-256、字节数和归一化整数毫秒 mtime。
 * 启动前存在而结束后缺失的文件按 exists 变化 fail closed。
 */
export async function verifyT23ReadonlySentinels(
  projectRoot: string,
  before: readonly T23ReadonlySentinelEvidence[],
): Promise<T23ReadonlySentinelVerification> {
  const afterSnapshots = await snapshotRedlineProjectSentinels(projectRoot);
  const afterByRelativePath = new Map(
    afterSnapshots.map((snapshot) => [snapshot.relativePath, toT23ReadonlySentinelState(snapshot)]),
  );
  const items = before.map<T23ReadonlySentinelVerificationItem>((beforeEvidence) => {
    const after = afterByRelativePath.get(beforeEvidence.relativePath)
      ?? { relativePath: beforeEvidence.relativePath, exists: false as const };
    const changedFields: T23ReadonlySentinelChangedField[] = [];
    if (!after.exists) {
      changedFields.push("exists");
    } else {
      if (after.sha256 !== beforeEvidence.sha256) changedFields.push("sha256");
      if (after.bytes !== beforeEvidence.bytes) changedFields.push("bytes");
      if (after.mtimeMs !== beforeEvidence.mtimeMs) changedFields.push("mtimeMs");
    }
    return {
      relativePath: beforeEvidence.relativePath,
      status: changedFields.length ? "FAIL" : "PASS",
      changedFields,
      before: beforeEvidence,
      after,
    };
  });
  return {
    ok: items.length > 0 && items.every((item) => item.status === "PASS"),
    candidateRelativePaths: [...T23_READONLY_SENTINEL_CANDIDATE_PATHS],
    includedExistingCount: before.length,
    mtimePrecision: REDLINE_SENTINEL_MTIME_PRECISION,
    items,
  };
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 外网 http(s) 请求判定（本地回环除外），仅作信息记录。 */
export function isExternalHttp(urlValue: string): boolean {
  try {
    const url = new URL(urlValue);
    return (url.protocol === "http:" || url.protocol === "https:")
      && !["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

/* ---------------------------------- 隔离运行环境 ---------------------------------- */

export interface IsolatedRuntime {
  runtimeRoot: string;
  userDataRoot: string;
  registryPath: string;
  managedProjectsRoot: string;
  mediaRuntimeRoot: string;
  sourceProjectRoot: string;
  isolatedProjectCopy: boolean;
  project: { id: string; name: string; primaryRoot: string };
  cleanup(): Promise<void>;
}

/**
 * 从源注册表复制出仅含目标工程的单条 registry + active-project.json 指针，
 * 全部落在全新 mkdtemp 目录；源注册表只读。
 */
export async function prepareIsolatedRuntime(input: {
  projectRoot: string;
  sourceRegistryPath: string;
  /**
   * 把整个工程复制到临时目录，并让 registry/active pointer 只指向副本。
   * 源码界面可能自动生成缩略图或布局，真实 UI 验收必须启用此项，不能只隔离 userData。
   */
  copyProject?: boolean;
}): Promise<IsolatedRuntime> {
  const raw = await readFile(input.sourceRegistryPath, "utf8").catch((error: unknown) => {
    throw new Error(`源注册表不可读：${input.sourceRegistryPath}（${String(error)}）`);
  });
  let registry: unknown;
  try {
    registry = JSON.parse(raw);
  } catch {
    throw new Error(`源注册表不是合法 JSON：${input.sourceRegistryPath}`);
  }
  if (!Array.isArray(registry)) throw new Error(`源注册表必须是数组：${input.sourceRegistryPath}`);
  const entry = (registry as Array<Record<string, unknown>>).find((candidate) => (
    typeof candidate?.primaryRoot === "string"
    && path.resolve(candidate.primaryRoot) === input.projectRoot
  ));
  if (!entry || typeof entry.id !== "string" || typeof entry.name !== "string") {
    throw new Error(`源注册表不含目标工程条目（按 primaryRoot 匹配）：${input.projectRoot}；请先用桌面端登记该工程，或用 --registry 指定包含它的注册表。`);
  }

  // macOS 的 os.tmpdir() 通常返回 `/var/...`，而 realpath 会解析为
  // `/private/var/...`。受管工程安全门明确拒绝路径别名，因此从创建之初
  // 就统一使用规范真实路径，不能为了让验收通过而放宽 Core。
  const runtimeRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "t23-layer4-project-ui-")),
  );
  const cleanup = () => rm(runtimeRoot, { recursive: true, force: true }).then(() => undefined);
  try {
    const registryDir = path.join(runtimeRoot, "registry");
    const userDataRoot = path.join(runtimeRoot, "electron-user-data");
    const managedProjectsRoot = path.join(runtimeRoot, "managed-projects");
    const mediaRuntimeRoot = path.join(runtimeRoot, "media-runtime");
    for (const directory of [registryDir, userDataRoot, managedProjectsRoot, mediaRuntimeRoot]) {
      await mkdir(directory, { recursive: true });
    }
    let runtimeProjectRoot = input.copyProject
      ? path.join(runtimeRoot, "project-copy", path.basename(input.projectRoot))
      : input.projectRoot;
    if (input.copyProject) {
      await mkdir(path.dirname(runtimeProjectRoot), { recursive: true });
      // dereference=true 防止副本中的符号链接回写正式工程；循环链接会让验收明确失败。
      await cp(input.projectRoot, runtimeProjectRoot, {
        recursive: true,
        dereference: true,
        preserveTimestamps: true,
        force: false,
        errorOnExist: true,
      });
      runtimeProjectRoot = await realpath(runtimeProjectRoot);
      await rebindCopiedManagedProjectMetadata(runtimeProjectRoot);
    } else {
      runtimeProjectRoot = await realpath(runtimeProjectRoot);
    }
    const registryPath = path.join(registryDir, "projects.json");
    const isolatedEntry = {
      ...entry,
      primaryRoot: runtimeProjectRoot,
    };
    await writeFile(registryPath, `${JSON.stringify([isolatedEntry], null, 2)}\n`, "utf8");
    const now = new Date().toISOString();
    // 启动只恢复显式活动工程：渲染层读 active-project.json 后直达受管画布。
    await writeFile(path.join(registryDir, "active-project.json"), `${JSON.stringify({
      schemaVersion: 2,
      primaryRoot: runtimeProjectRoot,
      activationId: randomUUID(),
      activatedAt: now,
      updatedAt: now,
    }, null, 2)}\n`, "utf8");
    return {
      runtimeRoot,
      userDataRoot,
      registryPath,
      managedProjectsRoot,
      mediaRuntimeRoot,
      sourceProjectRoot: input.projectRoot,
      isolatedProjectCopy: input.copyProject === true,
      project: { id: entry.id, name: entry.name, primaryRoot: runtimeProjectRoot },
      cleanup,
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}

/**
 * 只读推导工程单元数：复制 studio-production.sqlite（含 wal/shm）到隔离目录后
 * 以 readOnly 打开副本；真实库文件全程零写入。
 */
export async function deriveProjectUnitCount(projectRoot: string, stagingDir: string): Promise<number> {
  const source = path.join(projectRoot, ".aicanvas", "studio-production.sqlite");
  if (!await pathExists(source)) throw new Error(`工程缺少生产知识库：${source}`);
  const probeDir = path.join(stagingDir, "unit-count-probe");
  await mkdir(probeDir, { recursive: true });
  const copyPath = path.join(probeDir, "studio-production.sqlite");
  await copyFile(source, copyPath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${source}${suffix}`;
    if (await pathExists(sidecar)) await copyFile(sidecar, `${copyPath}${suffix}`);
  }
  const db = new DatabaseSync(copyPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM studio_production_units").get() as { count?: number } | undefined;
    if (typeof row?.count !== "number") throw new Error("studio_production_units 计数查询无结果。");
    return row.count;
  } finally {
    db.close();
  }
}

/* ---------------------------------- Electron 启动（dev-CDP / 构建版） ---------------------------------- */

export interface LaunchedUi {
  page: Page;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配 Electron CDP 端口。"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForCdp(port: number, child: ChildProcess): Promise<string> {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`源码态 Electron 提前退出：exit=${child.exitCode}`);
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return endpoint;
    } catch {
      // Electron/Vite 尚在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("源码态 Electron CDP 90 秒内未就绪。");
}

export interface T23OwnedProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export function collectT23OwnedProcessIds(
  rows: readonly T23OwnedProcessRow[],
  rootPid: number,
  commandNeedle?: string,
): number[] {
  const hasExactCommandArgument = (command: string, argument: string): boolean => {
    let cursor = command.indexOf(argument);
    while (cursor >= 0) {
      const before = cursor === 0 ? " " : command[cursor - 1]!;
      const afterIndex = cursor + argument.length;
      const after = afterIndex >= command.length ? " " : command[afterIndex]!;
      if (/\s/u.test(before) && /\s/u.test(after)) return true;
      cursor = command.indexOf(argument, cursor + 1);
    }
    return false;
  };
  const owned = new Set<number>();
  if (rows.some((row) => row.pid === rootPid)) owned.add(rootPid);
  if (commandNeedle) {
    for (const row of rows) {
      if (hasExactCommandArgument(row.command, commandNeedle)) owned.add(row.pid);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!owned.has(row.pid) && owned.has(row.ppid)) {
        owned.add(row.pid);
        changed = true;
      }
    }
  }
  owned.delete(process.pid);
  return [...owned].filter((pid) => Number.isSafeInteger(pid) && pid > 1).sort((left, right) => right - left);
}

async function t23ProcessSnapshot(): Promise<T23OwnedProcessRow[]> {
  return new Promise((resolve) => {
    const probe = spawn("/bin/ps", ["-axo", "pid=,ppid=,command="], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    probe.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    probe.once("error", () => resolve([]));
    probe.once("exit", () => resolve(output.split(/\r?\n/u).flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u);
      if (!match) return [];
      return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }];
    })));
  });
}

function signalT23OwnedProcesses(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch { /* process already exited */ }
  }
}

function t23ProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function stopProcessGroup(child: ChildProcess | undefined, commandNeedle?: string): Promise<void> {
  if (!child || !child.pid || child.pid <= 1) return;
  const initialRows = await t23ProcessSnapshot();
  const ownedPids = collectT23OwnedProcessIds(
    initialRows,
    child.exitCode === null ? child.pid : 0,
    commandNeedle,
  );
  if (child.exitCode === null) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
  signalT23OwnedProcesses(ownedPids, "SIGTERM");
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && ownedPids.some(t23ProcessAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const finalRows = await t23ProcessSnapshot();
  const remaining = collectT23OwnedProcessIds(
    finalRows,
    child.exitCode === null ? child.pid : 0,
    commandNeedle,
  ).filter(t23ProcessAlive);
  if (remaining.length || child.exitCode === null) {
    if (child.exitCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
    signalT23OwnedProcesses(remaining, "SIGKILL");
  }
  const killDeadline = Date.now() + 1_000;
  while (Date.now() < killDeadline && remaining.some(t23ProcessAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const survivors = remaining.filter(t23ProcessAlive);
  if (survivors.length) {
    throw new Error(`T23 隔离进程未能退出：${survivors.join(",")}`);
  }
}

/** dev 模式：electron-vite dev + --remoteDebuggingPort，Playwright connectOverCDP（P30 骨架同款）。 */
export async function launchDevElectron(input: {
  workspace: string;
  userDataRoot: string;
  env: NodeJS.ProcessEnv;
  logTail: string[];
}): Promise<LaunchedUi> {
  const port = await freePort();
  const child = spawn(path.join(input.workspace, "node_modules", ".bin", "electron-vite"), [
    "--remoteDebuggingPort", String(port), "--", `--user-data-dir=${input.userDataRoot}`,
  ], {
    cwd: input.workspace,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: input.env,
  });
  const collect = (chunk: Buffer) => {
    input.logTail.push(chunk.toString("utf8"));
    if (input.logTail.join("").length > 20_000) input.logTail.splice(0, Math.max(1, input.logTail.length - 8));
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  let browser: Browser | undefined;
  try {
    const cdpEndpoint = await waitForCdp(port, child);
    browser = await chromium.connectOverCDP(cdpEndpoint);
    const browserContext = browser.contexts()[0];
    if (!browserContext) throw new Error("Electron CDP 未暴露默认 BrowserContext。");
    let page = browserContext.pages().find((candidate) => !candidate.url().startsWith("devtools:"));
    const pageDeadline = Date.now() + 30_000;
    while (!page && Date.now() < pageDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      page = browserContext.pages().find((candidate) => !candidate.url().startsWith("devtools:"));
    }
    if (!page) throw new Error("Electron 源码态 renderer 页面未创建。");
    return {
      page,
      close: async () => {
        await browser?.close().catch(() => undefined);
        browser = undefined;
        await stopProcessGroup(child, `--user-data-dir=${input.userDataRoot}`);
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await stopProcessGroup(child, `--user-data-dir=${input.userDataRoot}`);
    throw error;
  }
}

/** build 模式：仅复用既有 out/ 产物；缺失时明确提示先 npm run build，绝不自行构建。 */
export async function assertBuildArtifacts(workspace: string): Promise<void> {
  const required = ["out/main/index.js", "out/renderer/index.html"];
  const missing: string[] = [];
  for (const relative of required) {
    if (!await pathExists(path.join(workspace, relative))) missing.push(relative);
  }
  if (missing.length) {
    throw new Error(`build 模式需要既有构建产物，缺失：${missing.join("、")}；请先 npm run build（本脚本不自行构建）。`);
  }
}

export async function launchBuiltElectron(input: {
  workspace: string;
  userDataRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<LaunchedUi> {
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      args: [".", `--user-data-dir=${input.userDataRoot}`],
      cwd: input.workspace,
      // ProcessEnv 值类型为 string|undefined；本脚本注入的键均为确定字符串，运行时无 undefined 项。
      env: input.env as { [key: string]: string },
    });
    const page = await application.firstWindow();
    const target = application;
    return {
      page,
      close: async () => {
        let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          target.close().catch(() => undefined),
          new Promise<void>((resolve) => {
            fallbackTimer = setTimeout(() => {
              target.process().kill();
              resolve();
            }, 5_000);
          }),
        ]);
        if (fallbackTimer) clearTimeout(fallbackTimer);
      },
    };
  } catch (error) {
    await application?.close().catch(() => undefined);
    throw error;
  }
}

/** 安装版：启动本机 .app 可执行文件（隔离 userData）。 */
export async function launchInstalledElectron(input: {
  appPath: string;
  userDataRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<LaunchedUi> {
  const executablePath = path.join(input.appPath, "Contents/MacOS/AI 漫剧画布");
  if (!await pathExists(executablePath)) {
    throw new Error(`安装版可执行文件不存在：${executablePath}`);
  }
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${input.userDataRoot}`],
      env: input.env as { [key: string]: string },
    });
    const page = await application.firstWindow();
    const target = application;
    return {
      page,
      close: async () => {
        let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          target.close().catch(() => undefined),
          new Promise<void>((resolve) => {
            fallbackTimer = setTimeout(() => {
              target.process().kill();
              resolve();
            }, 5_000);
          }),
        ]);
        if (fallbackTimer) clearTimeout(fallbackTimer);
      },
    };
  } catch (error) {
    await application?.close().catch(() => undefined);
    throw error;
  }
}

/* ---------------------------------- 截图防空白（sharp 方差校验） ---------------------------------- */

export interface ScreenshotEvidence {
  sha256: string;
  sizeBytes: number;
  width: number;
  height: number;
  maxChannelStandardDeviation: number;
}

export async function captureScreenshotEvidence(page: Page, outputPath: string): Promise<ScreenshotEvidence> {
  const bytes = await page.screenshot({ type: "png", fullPage: false, animations: "disabled" });
  await writeFile(outputPath, bytes, { flag: "wx" });
  const [metadata, imageStats, fileStats] = await Promise.all([
    sharp(bytes).metadata(),
    sharp(bytes).stats(),
    stat(outputPath),
  ]);
  const evidence: ScreenshotEvidence = {
    sha256: digest(bytes),
    sizeBytes: fileStats.size,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    maxChannelStandardDeviation: Math.max(...imageStats.channels.map((channel) => channel.stdev)),
  };
  if (evidence.width < 1_400 || evidence.height < 800
    || evidence.sizeBytes < 30_000 || evidence.maxChannelStandardDeviation < 5) {
    throw new Error(`Electron 截图疑似空白或占位：${path.basename(outputPath)}（${JSON.stringify(evidence)}）`);
  }
  return evidence;
}
