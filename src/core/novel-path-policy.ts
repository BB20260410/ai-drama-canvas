import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  ensureConfinedDirectory,
  revalidateConfinedDirectory,
  type ConfinedDirectoryIdentity,
} from "./confined-project-storage.js";

export interface NovelProjectRootIdentity {
  root: string;
  canonicalRoot: string;
  dev: bigint;
  ino: bigint;
}

export interface NovelRegularFileIdentity {
  root: NovelProjectRootIdentity;
  locator: string;
  absolutePath: string;
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface NovelRegularFileRead {
  bytes: Buffer;
  sha256: string;
  identity: NovelRegularFileIdentity;
}

export interface NovelFileReadOptions {
  /** 调用方必须按文件类别声明上限；路径策略不允许无界读取。 */
  maxBytes: number;
}

export interface NovelCreateTarget {
  root: NovelProjectRootIdentity;
  locator: string;
  absolutePath: string;
  name: string;
  parent: ConfinedDirectoryIdentity;
}

export interface NovelResolvedProjectLocator {
  locator: string;
  absolutePath: string;
}

function pathIsWithinOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code ?? "")
    : undefined;
}

function assertReadLimit(options: NovelFileReadOptions): bigint {
  if (!options || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new Error("小说文件 maxBytes 必须是非负安全整数。");
  }
  return BigInt(options.maxBytes);
}

/**
 * 项目内 locator 的唯一语法入口。保持原字符串，不做会改变文件身份的静默 normalize。
 */
export function normalizeNovelProjectLocator(locator: string): string {
  if (typeof locator !== "string" || locator.length === 0) {
    throw new Error("小说项目 locator 不能为空。");
  }
  if (locator.includes("\0")) throw new Error("小说项目 locator 不得包含 NUL。");
  if (locator.includes("\\")) throw new Error("小说项目 locator 只能使用 / 分隔。");
  if (path.posix.isAbsolute(locator)
    || path.win32.isAbsolute(locator)
    || /^[A-Za-z]:/u.test(locator)) {
    throw new Error("小说项目 locator 必须是项目内相对路径。");
  }
  const segments = locator.split("/");
  if (segments.some((segment) => segment.trim() === "" || segment === "." || segment === "..")) {
    throw new Error("小说项目 locator 不得包含空段、. 或 ..。");
  }
  if (path.posix.normalize(locator) !== locator) {
    throw new Error("小说项目 locator 必须是规范相对路径。");
  }
  return locator;
}

function resolveNovelLocator(root: NovelProjectRootIdentity, locator: string): {
  normalized: string;
  segments: string[];
  absolutePath: string;
} {
  const normalized = normalizeNovelProjectLocator(locator);
  const segments = normalized.split("/");
  const absolutePath = path.resolve(root.root, ...segments);
  if (!pathIsWithinOrEqual(absolutePath, root.root) || absolutePath === root.root) {
    throw new Error("小说项目 locator 解析后逃逸工程根。");
  }
  return { normalized, segments, absolutePath };
}

function assertRootInput(projectRoot: string): string {
  if (typeof projectRoot !== "string" || projectRoot.length === 0 || projectRoot.includes("\0")) {
    throw new Error("小说项目根无效。");
  }
  if (!path.isAbsolute(projectRoot)) throw new Error("小说项目根必须是绝对路径。");
  return path.resolve(projectRoot);
}

/**
 * 仅把已校验 locator 词法投影到当前绝对根，供一次调用内使用；返回值不是 I/O
 * 授权，也不得写入 manifest/JSON。真实读写仍必须走下方身份冻结 API。
 */
export function resolveNovelProjectLocator(
  projectRoot: string,
  locator: string,
): NovelResolvedProjectLocator {
  const root = assertRootInput(projectRoot);
  const normalized = normalizeNovelProjectLocator(locator);
  const absolutePath = path.resolve(root, ...normalized.split("/"));
  if (!pathIsWithinOrEqual(absolutePath, root) || absolutePath === root) {
    throw new Error("小说项目 locator 解析后逃逸工程根。");
  }
  return Object.freeze({ locator: normalized, absolutePath });
}

/** 冻结当前项目根身份；父路径或最终节点含 symlink 时 realpath 必然不同并失败。 */
export async function inspectNovelProjectRoot(projectRoot: string): Promise<NovelProjectRootIdentity> {
  const root = assertRootInput(projectRoot);
  const metadata = await lstat(root, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("小说项目根必须是无符号链接的真实目录。");
  }
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) {
    throw new Error("小说项目根路径包含符号链接或路径别名。");
  }
  return Object.freeze({
    root,
    canonicalRoot,
    dev: metadata.dev,
    ino: metadata.ino,
  });
}

async function revalidateNovelProjectRoot(identity: NovelProjectRootIdentity): Promise<void> {
  if (!path.isAbsolute(identity.root)
    || identity.canonicalRoot !== identity.root
    || typeof identity.dev !== "bigint" || identity.dev < 0n
    || typeof identity.ino !== "bigint" || identity.ino < 1n) {
    throw new Error("小说项目根冻结身份无效。");
  }
  const metadata = await lstat(identity.root, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
    || metadata.dev !== identity.dev || metadata.ino !== identity.ino
    || await realpath(identity.root) !== identity.canonicalRoot) {
    throw new Error("小说项目根身份已变化。");
  }
}

async function assertCanonicalDirectoryChain(
  root: NovelProjectRootIdentity,
  directorySegments: readonly string[],
): Promise<void> {
  await revalidateNovelProjectRoot(root);
  let current = root.root;
  for (const segment of directorySegments) {
    current = path.join(current, segment);
    const metadata = await lstat(current, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`小说项目路径包含符号链接或非目录节点：${path.relative(root.root, current)}`);
    }
    const canonical = await realpath(current);
    if (canonical !== current || !pathIsWithinOrEqual(canonical, root.canonicalRoot)) {
      throw new Error(`小说项目目录真实路径逃逸工程根：${path.relative(root.root, current)}`);
    }
  }
  await revalidateNovelProjectRoot(root);
}

function sameFrozenFileIdentity(
  metadata: BigIntStats,
  frozen: NovelRegularFileIdentity,
): boolean {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.dev === frozen.dev
    && metadata.ino === frozen.ino
    && metadata.nlink === frozen.nlink
    && metadata.size === frozen.size
    && metadata.mtimeNs === frozen.mtimeNs
    && metadata.ctimeNs === frozen.ctimeNs;
}

/**
 * 只读冻结现有普通文件的路径、根、inode 与时间身份；不打开、不写入任何目录。
 */
export async function inspectExistingNovelFile(
  projectRoot: string,
  locator: string,
): Promise<NovelRegularFileIdentity> {
  const root = await inspectNovelProjectRoot(projectRoot);
  const resolved = resolveNovelLocator(root, locator);
  await assertCanonicalDirectoryChain(root, resolved.segments.slice(0, -1));
  const metadata = await lstat(resolved.absolutePath, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("小说项目现有文件必须是无符号链接的普通文件。");
  }
  if (metadata.nlink !== 1n) {
    throw new Error("小说项目现有文件不得是硬链接。");
  }
  const canonical = await realpath(resolved.absolutePath);
  if (canonical !== resolved.absolutePath || !pathIsWithinOrEqual(canonical, root.canonicalRoot)) {
    throw new Error("小说项目现有文件真实路径逃逸工程根。");
  }
  await assertCanonicalDirectoryChain(root, resolved.segments.slice(0, -1));
  return Object.freeze({
    root,
    locator: resolved.normalized,
    absolutePath: resolved.absolutePath,
    dev: metadata.dev,
    ino: metadata.ino,
    nlink: metadata.nlink,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  });
}

/**
 * 从已冻结身份稳定读取。路径 lstat、O_NOFOLLOW fd 和读后路径必须仍指向同一文件；
 * 任一替换、硬链接、大小/时间漂移或父目录变化都会失败关闭。
 */
export async function readInspectedNovelFile(
  frozen: NovelRegularFileIdentity,
  options: NovelFileReadOptions,
): Promise<NovelRegularFileRead> {
  const maxBytes = assertReadLimit(options);
  await revalidateNovelProjectRoot(frozen.root);
  const resolved = resolveNovelLocator(frozen.root, frozen.locator);
  if (resolved.absolutePath !== frozen.absolutePath) throw new Error("小说文件冻结 locator 身份无效。");
  await assertCanonicalDirectoryChain(frozen.root, resolved.segments.slice(0, -1));
  const pathBefore = await lstat(frozen.absolutePath, { bigint: true });
  if (!sameFrozenFileIdentity(pathBefore, frozen)) {
    throw new Error("小说文件在打开前已被替换或修改。");
  }
  if (pathBefore.size > maxBytes) throw new Error("小说文件超过允许的读取字节上限。");
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("当前运行时不支持 O_NOFOLLOW，拒绝读取小说文件。");
  }

  const handle = await open(frozen.absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameFrozenFileIdentity(before, frozen) || before.size > maxBytes) {
      throw new Error("小说文件路径与 O_NOFOLLOW fd 身份不一致。");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(frozen.absolutePath, { bigint: true });
    if (!sameFrozenFileIdentity(after, frozen)
      || !sameFrozenFileIdentity(pathAfter, frozen)
      || bytes.byteLength !== Number(before.size)
      || await realpath(frozen.absolutePath) !== frozen.absolutePath) {
      throw new Error("小说文件在稳定读取期间发生替换或修改。");
    }
    await assertCanonicalDirectoryChain(frozen.root, resolved.segments.slice(0, -1));
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      identity: frozen,
    };
  } finally {
    await handle.close();
  }
}

export async function readNovelProjectFile(
  projectRoot: string,
  locator: string,
  options: NovelFileReadOptions,
): Promise<NovelRegularFileRead> {
  const frozen = await inspectExistingNovelFile(projectRoot, locator);
  return readInspectedNovelFile(frozen, options);
}

async function assertCreateTargetAbsent(absolutePath: string): Promise<void> {
  try {
    await lstat(absolutePath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  throw new Error("小说新建目标已经存在，拒绝覆盖。");
}

/**
 * 显式写边界：安全建立缺失父目录并冻结其 dirfd 身份，但不创建目标文件。
 * 后续 Repository 必须使用返回的 parent/name 配合 confined no-replace 写原语，
 * 不能把 absolutePath 当作已完成的原子授权。
 */
export async function ensureNovelCreateTargetParent(
  projectRoot: string,
  locator: string,
  mode = 0o700,
): Promise<NovelCreateTarget> {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new Error("小说目标父目录 mode 无效。");
  }
  const root = await inspectNovelProjectRoot(projectRoot);
  const resolved = resolveNovelLocator(root, locator);
  const name = resolved.segments.at(-1)!;
  const parentPath = path.dirname(resolved.absolutePath);
  const parent = await ensureConfinedDirectory(root.root, parentPath, mode);
  if (parent.projectRoot !== root.root
    || parent.canonicalRoot !== root.canonicalRoot
    || parent.directory !== parentPath
    || !pathIsWithinOrEqual(parent.canonicalDirectory, root.canonicalRoot)) {
    throw new Error("小说目标父目录身份与工程根不一致。");
  }
  await revalidateNovelProjectRoot(root);
  await revalidateConfinedDirectory(parent);
  await assertCreateTargetAbsent(resolved.absolutePath);
  await revalidateConfinedDirectory(parent);
  await assertCreateTargetAbsent(resolved.absolutePath);
  const frozenParent: ConfinedDirectoryIdentity = Object.freeze({ ...parent });
  return Object.freeze({
    root,
    locator: resolved.normalized,
    absolutePath: resolved.absolutePath,
    name,
    parent: frozenParent,
  });
}

/** 写入提交前复验父目录身份和 no-replace 目标；真正创建仍须使用 dirfd 原语。 */
export async function revalidateNovelCreateTarget(target: NovelCreateTarget): Promise<void> {
  const resolved = resolveNovelLocator(target.root, target.locator);
  if (resolved.absolutePath !== target.absolutePath
    || target.name !== resolved.segments.at(-1)
    || target.parent.directory !== path.dirname(resolved.absolutePath)
    || target.parent.projectRoot !== target.root.root
    || target.parent.canonicalRoot !== target.root.canonicalRoot
    || !pathIsWithinOrEqual(target.parent.canonicalDirectory, target.root.canonicalRoot)) {
    throw new Error("小说新建目标冻结身份无效。");
  }
  await revalidateNovelProjectRoot(target.root);
  await revalidateConfinedDirectory(target.parent);
  await assertCreateTargetAbsent(target.absolutePath);
  await revalidateConfinedDirectory(target.parent);
}
