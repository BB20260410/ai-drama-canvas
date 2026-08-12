import { createHash } from "node:crypto";
import path from "node:path";
import {
  inspectExistingConfinedDirectory,
  persistConfinedBytesNoReplace,
  readConfinedRegularFileWithIdentity,
} from "./confined-project-storage.js";
import { SIDECAR_DIR } from "./constants.js";
import { MANAGED_PROJECT_WRITER_SCHEMA_VERSION } from "./novel-types.js";

export const MANAGED_WRITER_FENCE_FILE = "locks";
export const MANAGED_V2_LOCK_DIRECTORY = "locks-v2";

const MANAGED_MANIFEST_FILE = "managed-project.json";
const MAX_WRITER_FENCE_BYTES = 16 * 1024;
const MAX_MANAGED_MANIFEST_BYTES = 256 * 1024;

export interface ManagedWriterFence {
  schemaVersion: 1;
  kind: "ai-canvas-managed-writer-fence";
  projectId: string;
  rootRealpath: string;
  minimumWriterSchemaVersion: typeof MANAGED_PROJECT_WRITER_SCHEMA_VERSION;
  lockDirectory: `.aicanvas/${typeof MANAGED_V2_LOCK_DIRECTORY}`;
  fingerprint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(value: Record<string, unknown>): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function parseJsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} JSON 无法解码。`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`${label} JSON 根节点必须是对象。`);
  return parsed;
}

function writerFenceSemantic(projectRoot: string, projectId: string): Omit<ManagedWriterFence, "fingerprint"> {
  return {
    schemaVersion: 1,
    kind: "ai-canvas-managed-writer-fence",
    projectId,
    rootRealpath: projectRoot,
    minimumWriterSchemaVersion: MANAGED_PROJECT_WRITER_SCHEMA_VERSION,
    lockDirectory: `.aicanvas/${MANAGED_V2_LOCK_DIRECTORY}`,
  };
}

function parseWriterFence(bytes: Buffer, projectRoot: string): ManagedWriterFence {
  const value = parseJsonObject(bytes, "受管项目 writer fence");
  if (value.schemaVersion !== 1
    || value.kind !== "ai-canvas-managed-writer-fence"
    || typeof value.projectId !== "string" || !value.projectId
    || value.rootRealpath !== projectRoot
    || value.minimumWriterSchemaVersion !== MANAGED_PROJECT_WRITER_SCHEMA_VERSION
    || value.lockDirectory !== `.aicanvas/${MANAGED_V2_LOCK_DIRECTORY}`
    || typeof value.fingerprint !== "string") {
    throw new Error("受管项目 writer fence 结构或路径绑定无效。");
  }
  const { fingerprint: storedFingerprint, ...semantic } = value;
  if (fingerprint(semantic) !== storedFingerprint) {
    throw new Error("受管项目 writer fence fingerprint 不匹配。");
  }
  return value as unknown as ManagedWriterFence;
}

function assertMatchingV2Manifest(
  bytes: Buffer,
  projectRoot: string,
  fence: ManagedWriterFence,
): void {
  const value = parseJsonObject(bytes, "受管项目 manifest");
  if (value.schemaVersion !== 2
    || value.kind !== "ai-canvas-managed-project"
    || value.projectId !== fence.projectId
    || value.rootRealpath !== projectRoot
    || (value.workspaceMode !== "novel" && value.workspaceMode !== "hybrid")
    || value.minimumWriterSchemaVersion !== MANAGED_PROJECT_WRITER_SCHEMA_VERSION
    || typeof value.fingerprint !== "string") {
    throw new Error("writer fence 未绑定到可由当前 writer 写入的 schema v2 项目。");
  }
  const { fingerprint: storedFingerprint, ...semantic } = value;
  if (fingerprint(semantic) !== storedFingerprint) {
    throw new Error("writer fence 对应的受管项目 manifest fingerprint 不匹配。");
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

/**
 * 判定已有 sidecar 是否声明 schema v2。该函数只读且验证 manifest 身份；
 * 用于阻止 fence 缺失或被替换成目录时静默退回旧锁协议。
 */
export async function managedProjectRequiresWriterFence(projectRootValue: string): Promise<boolean> {
  const projectRoot = path.resolve(projectRootValue);
  const sidecar = await inspectExistingConfinedDirectory(projectRoot, path.join(projectRoot, SIDECAR_DIR));
  let manifestRead: Awaited<ReturnType<typeof readConfinedRegularFileWithIdentity>>;
  try {
    manifestRead = await readConfinedRegularFileWithIdentity(
      sidecar,
      MANAGED_MANIFEST_FILE,
      MAX_MANAGED_MANIFEST_BYTES,
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (manifestRead.nlink !== 1) throw new Error("受管项目 manifest 必须是单链接普通文件。");
  const value = parseJsonObject(manifestRead.bytes, "受管项目 manifest");
  if (value.kind !== "ai-canvas-managed-project"
    || value.rootRealpath !== projectRoot
    || typeof value.projectId !== "string" || !value.projectId
    || typeof value.fingerprint !== "string") {
    throw new Error("受管项目 manifest 身份无效，拒绝选择项目锁协议。");
  }
  const { fingerprint: storedFingerprint, ...semantic } = value;
  if (fingerprint(semantic) !== storedFingerprint) {
    throw new Error("受管项目 manifest fingerprint 不匹配，拒绝选择项目锁协议。");
  }
  if (value.schemaVersion === 1) {
    if ("workspaceMode" in value || "minimumWriterSchemaVersion" in value) {
      throw new Error("schema v1 manifest 夹带 v2 writer 声明，拒绝选择项目锁协议。");
    }
    return false;
  }
  if (value.schemaVersion === 2
    && (value.workspaceMode === "novel" || value.workspaceMode === "hybrid")
    && value.minimumWriterSchemaVersion === MANAGED_PROJECT_WRITER_SCHEMA_VERSION) {
    return true;
  }
  throw new Error("受管项目 manifest schema 或最低 writer 声明无效，拒绝选择项目锁协议。");
}

function serializedFence(projectRoot: string, projectId: string): Buffer {
  const value = managedProjectWriterFenceValue(projectRoot, projectId);
  return Buffer.from(`${JSON.stringify(stableValue(value), null, 2)}\n`, "utf8");
}

/** 供恢复流程在新根原子重签 fence；调用方必须随后走完整 inspect。 */
export function managedProjectWriterFenceValue(projectRootValue: string, projectId: string): ManagedWriterFence {
  const projectRoot = path.resolve(projectRootValue);
  const semantic = writerFenceSemantic(projectRoot, projectId);
  return {
    ...semantic,
    fingerprint: fingerprint(semantic),
  };
}

/**
 * schema v2 发布前占用旧 writer 固定使用的 `.aicanvas/locks` 路径。
 * 旧 writer 会把该路径当目录创建，因普通文件而在进入写临界区前失败。
 */
export async function createManagedProjectWriterFence(projectRootValue: string, projectId: string): Promise<void> {
  const projectRoot = path.resolve(projectRootValue);
  if (!projectId) throw new Error("writer fence projectId 不能为空。");
  const sidecar = await inspectExistingConfinedDirectory(projectRoot, path.join(projectRoot, SIDECAR_DIR));
  const bytes = serializedFence(projectRoot, projectId);
  await persistConfinedBytesNoReplace(sidecar, MANAGED_WRITER_FENCE_FILE, bytes);
  const observed = await readConfinedRegularFileWithIdentity(sidecar, MANAGED_WRITER_FENCE_FILE, MAX_WRITER_FENCE_BYTES);
  if (observed.nlink !== 1 || !observed.bytes.equals(bytes)) {
    throw new Error("writer fence 发布后身份或字节不一致。");
  }
}

/** 只读验证 fence、v2 manifest 与工程根三者身份一致。 */
export async function inspectManagedProjectWriterFence(projectRootValue: string): Promise<ManagedWriterFence> {
  const projectRoot = path.resolve(projectRootValue);
  const sidecar = await inspectExistingConfinedDirectory(projectRoot, path.join(projectRoot, SIDECAR_DIR));
  const [fenceRead, manifestRead] = await Promise.all([
    readConfinedRegularFileWithIdentity(sidecar, MANAGED_WRITER_FENCE_FILE, MAX_WRITER_FENCE_BYTES),
    readConfinedRegularFileWithIdentity(sidecar, MANAGED_MANIFEST_FILE, MAX_MANAGED_MANIFEST_BYTES),
  ]);
  if (fenceRead.nlink !== 1 || manifestRead.nlink !== 1) {
    throw new Error("writer fence 或受管项目 manifest 必须是单链接普通文件。");
  }
  const fence = parseWriterFence(fenceRead.bytes, projectRoot);
  assertMatchingV2Manifest(manifestRead.bytes, projectRoot, fence);
  return fence;
}

/** 当前 writer 的 v2 锁目录；调用前必须完整验证 fence 和 manifest。 */
export async function managedV2LockDirectory(projectRoot: string): Promise<string> {
  await inspectManagedProjectWriterFence(projectRoot);
  return path.join(path.resolve(projectRoot), SIDECAR_DIR, MANAGED_V2_LOCK_DIRECTORY);
}
