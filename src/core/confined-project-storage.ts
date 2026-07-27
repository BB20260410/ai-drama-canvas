import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { runDarwinDirfdStorage } from "./darwin-dirfd-storage.js";

export interface ConfinedDirectoryIdentity {
  projectRoot: string;
  canonicalRoot: string;
  directory: string;
  canonicalDirectory: string;
  dev: number;
  ino: number;
}

export interface ConfinedFileIdentity {
  directory: ConfinedDirectoryIdentity;
  name: string;
  dev: number;
  ino: number;
}

export interface ConfinedRegularFileRead {
  bytes: Buffer;
  identity: ConfinedFileIdentity;
  nlink: number;
  mtimeMs: number;
}

export interface ConfinedRegularFileHash {
  identity: ConfinedFileIdentity;
  nlink: number;
  mtimeMs: number;
  size: number;
  sha256: string;
}

export interface ConfinedLinkNoReplaceTestHooks {
  /** 仅供确定性竞态测试；产品调用不得传入。 */
  beforeLink?: () => void | Promise<void>;
  /** 仅供确定性竞态测试；产品调用不得传入。 */
  afterLink?: () => void | Promise<void>;
}

export interface ConfinedPersistedFile {
  created: boolean;
  identity: ConfinedFileIdentity;
  sha256: string;
  size: number;
}

export interface ConfinedSha256Import {
  created: boolean;
  sha256: string;
  size: number;
  absolutePath: string;
  identity: ConfinedFileIdentity;
}

function isWithinOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertBasename(name: string): string {
  if (!name || name !== path.basename(name) || name === "." || name === "..") {
    throw new Error("受管文件名必须是单一 basename。");
  }
  return name;
}

/**
 * 逐级建立并冻结工程内目录身份。Node 没有 openat；调用方必须在每个写入、
 * promote 和删除边界重验返回的 dev/ino，避免把 lexical containment 当真实隔离。
 */
export async function ensureConfinedDirectory(
  projectRoot: string,
  targetDirectory: string,
  mode = 0o700,
): Promise<ConfinedDirectoryIdentity> {
  if (!path.isAbsolute(projectRoot) || !path.isAbsolute(targetDirectory)) {
    throw new Error("受管工程根和目标目录必须是绝对路径。");
  }
  const root = path.resolve(projectRoot);
  const target = path.resolve(targetDirectory);
  if (!isWithinOrEqual(target, root)) throw new Error("受管目录逃逸工程根。");
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("受管工程根必须是无符号链接的真实目录。");
  }
  const canonicalRoot = await realpath(root);

  // 已存在目录只做只读身份冻结；真正写边界仍由 dirfd helper 复验同一
  // canonical/dev/ino。避免每次查询或账本打开都启动子进程。
  try {
    return await inspectExistingConfinedDirectory(root, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const relative = path.relative(root, target);
  let result: Awaited<ReturnType<typeof runDarwinDirfdStorage>>;
  try {
    result = await runDarwinDirfdStorage("ensure", [
      root,
      canonicalRoot,
      String(rootMetadata.dev),
      String(rootMetadata.ino),
      relative,
      mode.toString(8),
    ]);
  } catch (error) {
    if (["ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error("受管目录包含符号链接或非目录节点，拒绝写入。", { cause: error });
    }
    throw error;
  }
  const canonicalDirectory = String(result.canonicalDirectory ?? "");
  const dev = Number(result.dev);
  const ino = Number(result.ino);
  if (!path.isAbsolute(canonicalDirectory) || !isWithinOrEqual(canonicalDirectory, canonicalRoot)
    || !Number.isSafeInteger(dev) || !Number.isSafeInteger(ino)) {
    throw new Error("dirfd helper 返回无效受管目录身份。");
  }
  return {
    projectRoot: root,
    canonicalRoot,
    directory: target,
    canonicalDirectory,
    dev,
    ino,
  };
}

/** 只检查已存在的受管目录，绝不 mkdir；用于诊断和崩溃恢复读路径。 */
export async function inspectExistingConfinedDirectory(
  projectRoot: string,
  targetDirectory: string,
): Promise<ConfinedDirectoryIdentity> {
  if (!path.isAbsolute(projectRoot) || !path.isAbsolute(targetDirectory)) {
    throw new Error("受管工程根和目标目录必须是绝对路径。");
  }
  const root = path.resolve(projectRoot);
  const target = path.resolve(targetDirectory);
  if (!isWithinOrEqual(target, root)) throw new Error("受管目录逃逸工程根。");
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("受管工程根必须是无符号链接的真实目录。");
  }
  const canonicalRoot = await realpath(root);
  let current = root;
  const relative = path.relative(root, target);
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`受管目录包含符号链接或非目录节点：${path.relative(root, current)}`);
    }
    const canonical = await realpath(current);
    if (!isWithinOrEqual(canonical, canonicalRoot)) {
      throw new Error(`受管目录真实路径逃逸工程根：${path.relative(root, current)}`);
    }
  }
  const metadata = await lstat(target);
  const canonicalDirectory = await realpath(target);
  return {
    projectRoot: root,
    canonicalRoot,
    directory: target,
    canonicalDirectory,
    dev: metadata.dev,
    ino: metadata.ino,
  };
}

export async function revalidateConfinedDirectory(identity: ConfinedDirectoryIdentity): Promise<void> {
  const metadata = await lstat(identity.directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.dev !== identity.dev || metadata.ino !== identity.ino
    || await realpath(identity.directory) !== identity.canonicalDirectory
    || !isWithinOrEqual(identity.canonicalDirectory, identity.canonicalRoot)) {
    throw new Error(`受管目录身份已变化：${identity.directory}`);
  }
}

export async function openExclusiveConfinedFile(
  directory: ConfinedDirectoryIdentity,
  name: string,
  mode = 0o600,
): Promise<{ handle: FileHandle; identity: ConfinedFileIdentity }> {
  const safeName = assertBasename(name);
  const filePath = path.join(directory.directory, safeName);
  const result = await runDarwinDirfdStorage("create", [
    directory.directory,
    directory.canonicalDirectory,
    String(directory.dev),
    String(directory.ino),
    safeName,
    mode.toString(8),
  ]);
  const createdIdentity: ConfinedFileIdentity = {
    directory,
    name: safeName,
    dev: Number(result.dev),
    ino: Number(result.ino),
  };
  let handle: FileHandle | null = null;
  try {
    await revalidateConfinedDirectory(directory);
    handle = await open(filePath, constants.O_WRONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1
      || metadata.dev !== createdIdentity.dev || metadata.ino !== createdIdentity.ino) {
      throw new Error("受管临时文件与 dirfd 创建回执不一致。");
    }
    await revalidateConfinedDirectory(directory);
    return {
      handle,
      identity: createdIdentity,
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlinkOwnedConfinedFile(createdIdentity).catch(() => undefined);
    throw error;
  }
}

/**
 * 在锚定目录 fd 内一次完成临时写入、fsync 与 no-replace 原子发布。
 * final rename 是提交点；异常后调用方只能按同 SHA 精确对账，绝不按名称回滚 final。
 */
export async function persistConfinedBytesNoReplace(
  directory: ConfinedDirectoryIdentity,
  name: string,
  bytes: Buffer,
  mode = 0o600,
): Promise<ConfinedPersistedFile> {
  const safeName = assertBasename(name);
  if (bytes.byteLength < 1) throw new Error("受管持久文件不得为空。");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const args = [
    directory.directory,
    directory.canonicalDirectory,
    String(directory.dev),
    String(directory.ino),
    safeName,
    sha256,
    String(bytes.byteLength),
    mode.toString(8),
  ];
  try {
    const result = await runDarwinDirfdStorage("persist", args, bytes);
    const dev = Number(result.dev);
    const ino = Number(result.ino);
    if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino)
      || Number(result.nlink) !== 1 || Number(result.size) !== bytes.byteLength
      || result.sha256 !== sha256) {
      throw new Error("dirfd persist 回执与输入身份不一致。");
    }
    return {
      created: result.created === true,
      identity: { directory, name: safeName, dev, ino },
      sha256,
      size: bytes.byteLength,
    };
  } catch (error) {
    // rename 已提交但回执丢失时只按受管只读面精确对账；同内容可安全采用，
    // 不同/不明内容继续失败，且绝不删除 final。
    const reconciled = await readConfinedRegularFileWithIdentity(directory, safeName, bytes.byteLength)
      .catch(() => null);
    if (reconciled?.nlink === 1 && reconciled.bytes.equals(bytes)) {
      return {
        created: false,
        identity: reconciled.identity,
        sha256,
        size: bytes.byteLength,
      };
    }
    throw error;
  }
}

/** 从稳定只读源直接流式导入锚定的 sha256 CAS，不创建路径式临时文件。 */
export async function importConfinedFileToSha256Cas(
  objectRoot: ConfinedDirectoryIdentity,
  sourcePathValue: string,
  expectedSha256?: string,
): Promise<ConfinedSha256Import> {
  const sourcePath = path.resolve(sourcePathValue);
  const sourceMetadata = await lstat(sourcePath, { bigint: true });
  const canonicalSource = await realpath(sourcePath);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink() || canonicalSource !== sourcePath
    || sourceMetadata.size < 1n) {
    throw new Error("素材源必须是规范绝对路径上的非空普通文件。");
  }
  const expected = expectedSha256?.trim().toLowerCase();
  if (expected && !/^[a-f0-9]{64}$/u.test(expected)) throw new Error("expectedSha256 格式无效。");
  const result = await runDarwinDirfdStorage("import", [
    sourcePath,
    String(sourceMetadata.dev),
    String(sourceMetadata.ino),
    String(sourceMetadata.size),
    String(sourceMetadata.mtimeNs),
    String(sourceMetadata.ctimeNs),
    objectRoot.directory,
    objectRoot.canonicalDirectory,
    String(objectRoot.dev),
    String(objectRoot.ino),
    expected ?? "-",
    "600",
  ]);
  const sha256 = String(result.sha256 ?? "");
  const size = Number(result.size);
  const dev = Number(result.dev);
  const ino = Number(result.ino);
  if (!/^[a-f0-9]{64}$/u.test(sha256) || (expected && sha256 !== expected)
    || !Number.isSafeInteger(size) || size < 1
    || !Number.isSafeInteger(dev) || !Number.isSafeInteger(ino) || Number(result.nlink) !== 1) {
    throw new Error("dirfd 素材导入回执无效。");
  }
  const prefixDirectory = await inspectExistingConfinedDirectory(
    objectRoot.projectRoot,
    path.join(objectRoot.directory, sha256.slice(0, 2)),
  );
  return {
    created: result.created === true,
    sha256,
    size,
    absolutePath: path.join(prefixDirectory.directory, sha256),
    identity: { directory: prefixDirectory, name: sha256, dev, ino },
  };
}

export async function readConfinedRegularFile(
  directory: ConfinedDirectoryIdentity,
  name: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<Buffer> {
  return (await readConfinedRegularFileWithIdentity(directory, name, maxBytes)).bytes;
}

export async function readConfinedRegularFileWithIdentity(
  directory: ConfinedDirectoryIdentity,
  name: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<ConfinedRegularFileRead> {
  const safeName = assertBasename(name);
  await revalidateConfinedDirectory(directory);
  const filePath = path.join(directory.directory, safeName);
  const pathMetadata = await lstat(filePath);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || pathMetadata.size > maxBytes) {
    throw new Error("受管文件类型或大小无效。");
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino
      || before.size > maxBytes) {
      throw new Error("受管文件路径与 fd 身份不一致。");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || bytes.byteLength !== before.size) {
      throw new Error("受管文件读取期间发生替换。");
    }
    await revalidateConfinedDirectory(directory);
    return {
      bytes,
      identity: { directory, name: safeName, dev: before.dev, ino: before.ino },
      nlink: before.nlink,
      mtimeMs: before.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

/**
 * 以固定大小窗口校验受管普通文件，不把整个对象保留在内存中。
 * 读前、读后继续复核同一 fd 的身份与时间属性，安全边界与完整读取一致。
 */
export async function hashConfinedRegularFileWithIdentity(
  directory: ConfinedDirectoryIdentity,
  name: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<ConfinedRegularFileHash> {
  const safeName = assertBasename(name);
  await revalidateConfinedDirectory(directory);
  const filePath = path.join(directory.directory, safeName);
  const pathMetadata = await lstat(filePath);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || pathMetadata.size > maxBytes) {
    throw new Error("受管文件类型或大小无效。");
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino
      || before.size > maxBytes) {
      throw new Error("受管文件路径与 fd 身份不一致。");
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(1024 * 1024, before.size)));
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.byteLength, before.size - offset),
        offset,
      );
      if (bytesRead < 1) throw new Error("受管文件流式读取提前结束。");
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || offset !== before.size) {
      throw new Error("受管文件流式读取期间发生替换。");
    }
    await revalidateConfinedDirectory(directory);
    return {
      identity: { directory, name: safeName, dev: before.dev, ino: before.ino },
      nlink: before.nlink,
      mtimeMs: before.mtimeMs,
      size: before.size,
      sha256: hash.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

export async function linkConfinedFileNoReplace(
  source: ConfinedFileIdentity,
  targetDirectory: ConfinedDirectoryIdentity,
  targetName: string,
  testHooks: ConfinedLinkNoReplaceTestHooks = {},
): Promise<boolean> {
  const safeTargetName = assertBasename(targetName);
  await testHooks.beforeLink?.();
  let result: Awaited<ReturnType<typeof runDarwinDirfdStorage>>;
  try {
    result = await runDarwinDirfdStorage("link", [
      source.directory.directory,
      source.directory.canonicalDirectory,
      String(source.directory.dev),
      String(source.directory.ino),
      source.name,
      String(source.dev),
      String(source.ino),
      targetDirectory.directory,
      targetDirectory.canonicalDirectory,
      String(targetDirectory.dev),
      String(targetDirectory.ino),
      safeTargetName,
    ]);
  } catch (error) {
    throw new Error("受管目录身份已变化，dirfd link 失败关闭。", { cause: error });
  }
  await testHooks.afterLink?.();
  return result.created === true;
}

export async function unlinkOwnedConfinedFile(file: ConfinedFileIdentity): Promise<void> {
  await runDarwinDirfdStorage("unlink", [
    file.directory.directory,
    file.directory.canonicalDirectory,
    String(file.directory.dev),
    String(file.directory.ino),
    file.name,
    String(file.dev),
    String(file.ino),
  ]);
}
