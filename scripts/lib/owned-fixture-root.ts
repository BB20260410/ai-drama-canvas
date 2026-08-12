import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER_NAME = ".aicanvas-fixture-owner.json";
const OWNER_PATTERN = /^[a-z0-9][a-z0-9._-]{2,119}$/u;
const LEASE_PATTERN = /^[a-f0-9-]{36}$/u;
const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOST_REGISTRY_PATH_AT_IMPORT = path.resolve(
  process.env.AI_CANVAS_REGISTRY_PATH?.trim()
    || path.join(os.homedir(), ".aicanvas", "projects.json"),
);

interface FixtureOwnerMarker {
  schemaVersion: 1;
  kind: "aicanvas-owned-temporary-fixture-root";
  ownerId: string;
  leaseId: string;
  canonicalRoot: string;
  rootDev: string;
  rootIno: string;
  temporaryBaseCanonical: string;
  createdAt: string;
}

export interface OwnedFixtureRootIdentity {
  root: string;
  ownerId: string;
  leaseId: string;
  dev: number;
  ino: number;
}

interface AllowedTemporaryRoot {
  lexical: string;
  canonical: string;
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function overlaps(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return a === b || within(a, b) || within(b, a);
}

async function allowedTemporaryRoots(): Promise<AllowedTemporaryRoot[]> {
  const roots = [...new Set([path.resolve(os.tmpdir()), path.resolve("/tmp")])];
  const resolved: AllowedTemporaryRoot[] = [];
  for (const lexical of roots) {
    try {
      resolved.push({ lexical, canonical: await realpath(lexical) });
    } catch {
      // 不可用的系统临时根不进入允许集。
    }
  }
  return resolved;
}

async function selectTemporaryRoot(candidate: string): Promise<AllowedTemporaryRoot> {
  const allowed = await allowedTemporaryRoots();
  for (const entry of allowed) {
    if (within(candidate, entry.lexical)) return entry;
    if (within(candidate, entry.canonical)) {
      return { lexical: entry.canonical, canonical: entry.canonical };
    }
  }
  throw new Error("夹具根必须是系统临时目录下的专用子目录。");
}

async function readSmallJsonNoFollow(filePath: string): Promise<unknown | undefined> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 1024 * 1024) {
      throw new Error(`保护状态必须是单链接小文件：${filePath}`);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile())) as unknown;
  } finally {
    await handle.close();
  }
}

async function registeredProjectRoots(registryPath: string): Promise<string[]> {
  const roots: string[] = [];
  const registry = await readSmallJsonNoFollow(registryPath);
  if (registry !== undefined) {
    if (!Array.isArray(registry)) throw new Error(`工程注册表结构无效：${registryPath}`);
    for (const entry of registry) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || typeof (entry as { primaryRoot?: unknown }).primaryRoot !== "string"
        || !path.isAbsolute((entry as { primaryRoot: string }).primaryRoot)) {
        throw new Error(`工程注册表包含无效 primaryRoot：${registryPath}`);
      }
      roots.push(path.resolve((entry as { primaryRoot: string }).primaryRoot));
    }
  }
  const activePath = path.join(path.dirname(registryPath), "active-project.json");
  const active = await readSmallJsonNoFollow(activePath);
  if (active !== undefined) {
    if (!active || typeof active !== "object" || Array.isArray(active)
      || typeof (active as { primaryRoot?: unknown }).primaryRoot !== "string"
      || !path.isAbsolute((active as { primaryRoot: string }).primaryRoot)) {
      throw new Error(`活动工程状态包含无效 primaryRoot：${activePath}`);
    }
    roots.push(path.resolve((active as { primaryRoot: string }).primaryRoot));
  }
  return roots;
}

async function protectedRoots(): Promise<string[]> {
  const currentRegistry = path.resolve(
    process.env.AI_CANVAS_REGISTRY_PATH?.trim()
      || path.join(os.homedir(), ".aicanvas", "projects.json"),
  );
  const registryPaths = [...new Set([HOST_REGISTRY_PATH_AT_IMPORT, currentRegistry])];
  const registered = (await Promise.all(registryPaths.map(registeredProjectRoots))).flat();
  return [...new Set([
    path.parse(WORKSPACE_ROOT).root,
    os.homedir(),
    "/Applications",
    WORKSPACE_ROOT,
    path.join(WORKSPACE_ROOT, "projects"),
    ...registered,
  ].map((entry) => path.resolve(entry)))];
}

async function rejectProtectedOverlap(lexicalRoot: string, canonicalRoot: string): Promise<void> {
  for (const protectedRoot of await protectedRoots()) {
    let canonicalProtected = protectedRoot;
    try {
      canonicalProtected = await realpath(protectedRoot);
    } catch {
      // 不存在的保护根仍按词法路径保护。
    }
    // 文件系统根本身只禁止精确命中；若把“它的所有子路径”也判为重叠，任何
    // 合法临时目录都会被 `/` 这一保护项误拒绝。其他保护根仍双向拒绝父/子覆盖。
    const lexicalOverlaps = protectedRoot === path.parse(protectedRoot).root
      ? path.resolve(lexicalRoot) === protectedRoot
      : overlaps(lexicalRoot, protectedRoot);
    const canonicalOverlaps = canonicalProtected === path.parse(canonicalProtected).root
      ? path.resolve(canonicalRoot) === canonicalProtected
      : overlaps(canonicalRoot, canonicalProtected);
    if (lexicalOverlaps || canonicalOverlaps) {
      throw new Error(`夹具根与受保护路径重叠：${protectedRoot}`);
    }
  }
}

async function rejectSymlinkSegments(candidate: string, allowedRoot: string): Promise<void> {
  const relative = path.relative(allowedRoot, candidate);
  let cursor = allowedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let metadata;
    try {
      metadata = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new Error(`夹具根路径包含符号链接：${cursor}`);
  }
}

async function readMarker(root: string): Promise<FixtureOwnerMarker> {
  const markerPath = path.join(root, MARKER_NAME);
  const handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 16 * 1024) {
      throw new Error("夹具 owner marker 必须是单链接小文件。");
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile())) as Partial<FixtureOwnerMarker>;
    if (value.schemaVersion !== 1 || value.kind !== "aicanvas-owned-temporary-fixture-root"
      || typeof value.ownerId !== "string" || !OWNER_PATTERN.test(value.ownerId)
      || typeof value.leaseId !== "string" || !LEASE_PATTERN.test(value.leaseId)
      || typeof value.canonicalRoot !== "string" || !path.isAbsolute(value.canonicalRoot)
      || typeof value.rootDev !== "string" || !/^\d+$/u.test(value.rootDev)
      || typeof value.rootIno !== "string" || !/^\d+$/u.test(value.rootIno)
      || typeof value.temporaryBaseCanonical !== "string" || !path.isAbsolute(value.temporaryBaseCanonical)
      || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
      throw new Error("夹具 owner marker 结构无效。");
    }
    return value as FixtureOwnerMarker;
  } finally {
    await handle.close();
  }
}

async function writeMarker(root: string, ownerId: string, allowed: AllowedTemporaryRoot): Promise<FixtureOwnerMarker> {
  const metadata = await lstat(root);
  const marker: FixtureOwnerMarker = {
    schemaVersion: 1,
    kind: "aicanvas-owned-temporary-fixture-root",
    ownerId,
    leaseId: randomUUID(),
    canonicalRoot: await realpath(root),
    rootDev: String(metadata.dev),
    rootIno: String(metadata.ino),
    temporaryBaseCanonical: allowed.canonical,
    createdAt: new Date().toISOString(),
  };
  const handle = await open(
    path.join(root, MARKER_NAME),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return marker;
}

function normalizedOwner(ownerIdValue: string): string {
  const ownerId = ownerIdValue.trim().toLowerCase();
  if (!OWNER_PATTERN.test(ownerId)) throw new Error("fixture ownerId 格式无效。");
  return ownerId;
}

async function validateRootLocation(root: string): Promise<{
  allowed: AllowedTemporaryRoot;
  canonicalCandidate: string;
}> {
  const allowed = await selectTemporaryRoot(root);
  await rejectSymlinkSegments(root, allowed.lexical);
  const parent = path.dirname(root);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("夹具根父目录必须是已存在的真实目录。");
  }
  const canonicalParent = await realpath(parent);
  if (!(canonicalParent === allowed.canonical || within(canonicalParent, allowed.canonical))) {
    throw new Error("夹具根父目录真实路径逃逸系统临时根。");
  }
  const canonicalCandidate = path.join(canonicalParent, path.basename(root));
  await rejectProtectedOverlap(root, canonicalCandidate);
  return { allowed, canonicalCandidate };
}

async function createAtMissingRoot(root: string, ownerId: string): Promise<OwnedFixtureRootIdentity> {
  const { allowed, canonicalCandidate } = await validateRootLocation(root);
  const parent = path.dirname(root);
  const parentBefore = await lstat(parent);
  await mkdir(root, { recursive: false, mode: 0o700 });
  const parentAfter = await lstat(parent);
  if (parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino) {
    throw new Error("夹具根创建期间父目录身份变化，拒绝继续。");
  }
  const metadata = await lstat(root);
  const canonicalRoot = await realpath(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonicalRoot !== canonicalCandidate) {
    throw new Error("新夹具根身份无效。");
  }
  const marker = await writeMarker(root, ownerId, allowed);
  return { root, ownerId, leaseId: marker.leaseId, dev: metadata.dev, ino: metadata.ino };
}

/** 仅创建一个此前不存在、位于受信临时父目录下的脚本自有根。 */
export async function createOwnedFixtureRootAt(rootValue: string, ownerIdValue: string): Promise<OwnedFixtureRootIdentity> {
  const root = path.resolve(rootValue);
  const ownerId = normalizedOwner(ownerIdValue);
  try {
    await lstat(root);
    throw new Error("显式夹具根必须此前不存在；拒绝接管既有目录。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return createAtMissingRoot(root, ownerId);
}

/** 由 helper 自己分配临时根，避免调用方使用可预测的固定 /tmp 路径。 */
export async function mkdtempOwnedFixtureRoot(prefixValue: string, ownerIdValue: string): Promise<OwnedFixtureRootIdentity> {
  const ownerId = normalizedOwner(ownerIdValue);
  const prefix = prefixValue.trim().replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!prefix) throw new Error("fixture prefix 不能为空。");
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const allowed = await selectTemporaryRoot(root);
  await rejectProtectedOverlap(root, await realpath(root));
  const metadata = await lstat(root);
  const marker = await writeMarker(root, ownerId, allowed);
  return { root, ownerId, leaseId: marker.leaseId, dev: metadata.dev, ino: metadata.ino };
}

/** 只读验证 owner、lease、canonical root 与 inode；不创建目录或 marker。 */
export async function assertOwnedTemporaryFixtureRoot(
  rootValue: string,
  ownerIdValue: string,
): Promise<OwnedFixtureRootIdentity> {
  const root = path.resolve(rootValue);
  const ownerId = normalizedOwner(ownerIdValue);
  const { allowed, canonicalCandidate } = await validateRootLocation(root);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("夹具根必须是无符号链接的真实目录。");
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== canonicalCandidate || !within(canonicalRoot, allowed.canonical)) {
    throw new Error("夹具根真实路径逃逸系统临时根。");
  }
  let marker: FixtureOwnerMarker;
  try {
    marker = await readMarker(root);
  } catch (error) {
    throw new Error("已存夹具根没有可信 owner marker，拒绝递归删除。", { cause: error });
  }
  if (marker.ownerId !== ownerId
    || marker.canonicalRoot !== canonicalRoot
    || marker.rootDev !== String(metadata.dev)
    || marker.rootIno !== String(metadata.ino)
    || marker.temporaryBaseCanonical !== allowed.canonical) {
    throw new Error("夹具 owner marker 与当前脚本、真实根或 inode 不一致。");
  }
  return { root, ownerId, leaseId: marker.leaseId, dev: metadata.dev, ino: metadata.ino };
}

/**
 * 重置一个脚本自有临时夹具根。既有目录必须先通过 owner marker、lease、
 * canonical root 与 inode 复核；空目录也不得静默收养。
 */
export async function resetOwnedFixtureRoot(rootValue: string, ownerIdValue: string): Promise<string> {
  const root = path.resolve(rootValue);
  const ownerId = normalizedOwner(ownerIdValue);
  let existing;
  try {
    existing = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!existing) return (await createAtMissingRoot(root, ownerId)).root;

  const identity = await assertOwnedTemporaryFixtureRoot(root, ownerId);
  const tombstone = `${root}.aicanvas-delete-${process.pid}-${randomUUID()}`;
  await rename(root, tombstone);
  const moved = await lstat(tombstone);
  if (!moved.isDirectory() || moved.isSymbolicLink()
    || moved.dev !== identity.dev || moved.ino !== identity.ino) {
    throw new Error("夹具根 rename 后 inode 不一致，拒绝删除。");
  }
  try {
    await createAtMissingRoot(root, ownerId);
  } catch (error) {
    await rename(tombstone, root).catch(() => undefined);
    throw error;
  }
  await rm(tombstone, { recursive: true, force: false });
  return root;
}

/** 删除已验证的脚本自有临时根；不接受无 marker 或错 owner 目录。 */
export async function removeOwnedTemporaryFixtureRoot(rootValue: string, ownerIdValue: string): Promise<void> {
  const root = path.resolve(rootValue);
  const identity = await assertOwnedTemporaryFixtureRoot(root, ownerIdValue);
  const tombstone = `${root}.aicanvas-delete-${process.pid}-${randomUUID()}`;
  await rename(root, tombstone);
  const moved = await lstat(tombstone);
  if (!moved.isDirectory() || moved.isSymbolicLink()
    || moved.dev !== identity.dev || moved.ino !== identity.ino) {
    throw new Error("夹具根 rename 后 inode 不一致，拒绝删除。");
  }
  await rm(tombstone, { recursive: true, force: false });
}

export const OWNED_FIXTURE_MARKER_NAME = MARKER_NAME;
