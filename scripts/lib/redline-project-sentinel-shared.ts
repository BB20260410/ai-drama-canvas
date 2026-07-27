/**
 * 正式工程红线验证的隔离辅助。
 *
 * Studio Core 的部分只读查询会先确保 schema/索引存在，因此不能把真实工程根目录
 * 直接传给 Core。这里把完整工程复制到 mkdtemp，所有 Core 探针仅触及副本；同时
 * 以内容哈希、字节数与 mtime 证明正式工程的关键文件未发生变化。
 */
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const REDLINE_SENTINEL_RELATIVE_PATHS = [
  ".aicanvas/managed-project.json",
  ".aicanvas/project.json",
  ".aicanvas/studio-production.sqlite",
  ".aicanvas/studio-generation-ledger.sqlite",
  ".aicanvas/material-studio.sqlite",
  ".aicanvas/studio-canvas-layout.json",
] as const;

/**
 * Node 在不同文件系统上可能返回带小数的 mtimeMs；正式红线证据统一截断到整数毫秒，
 * 避免同一文件因平台亚毫秒精度差异产生伪漂移，同时仍保留可稳定复核的毫秒级变化。
 */
export const REDLINE_SENTINEL_MTIME_PRECISION = "integer-millisecond" as const;

export function normalizeRedlineSentinelMtimeMs(mtimeMs: number): number {
  return Math.trunc(mtimeMs);
}

export interface RedlineSentinelSnapshot {
  relativePath: string;
  exists: boolean;
  bytes?: number;
  mtimeMs?: number;
  sha256?: string;
}

export interface IsolatedRedlineProjectCopy {
  sourceProjectRoot: string;
  projectRoot: string;
  runtimeRoot: string;
  cleanup(): Promise<void>;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

async function readJsonObjectIfPresent(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`隔离工程 JSON 必须是对象：${filePath}`);
    }
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

function rebindProjectPath(value: Record<string, unknown>, projectRoot: string): void {
  value.primaryRoot = projectRoot;
  value.outputRoots = [projectRoot];
}

/**
 * Core 会严格校验受管项目配置、索引和 manifest 的根路径及指纹。完整复制后，这些
 * 元数据仍指向正式根，故仅在副本内重绑定并重算哈希；正式工程文件从不改动。
 */
export async function rebindCopiedManagedProjectMetadata(projectRoot: string): Promise<void> {
  const sidecar = path.join(projectRoot, ".aicanvas");
  const configPath = path.join(sidecar, "project.json");
  const indexPath = path.join(sidecar, "index.json");
  const manifestPath = path.join(sidecar, "managed-project.json");
  const [project, index, manifest] = await Promise.all([
    readJsonObjectIfPresent(configPath),
    readJsonObjectIfPresent(indexPath),
    readJsonObjectIfPresent(manifestPath),
  ]);
  // 单元测试的最小 fixture 只需要验证复制/解链接；真实受管工程必须三件齐全。
  if (!project && !index && !manifest) return;
  if (!project || !index || !manifest || !index.project || typeof index.project !== "object" || Array.isArray(index.project)) {
    throw new Error(`隔离副本的受管工程元数据不完整：${projectRoot}`);
  }

  rebindProjectPath(project, projectRoot);
  rebindProjectPath(index.project as Record<string, unknown>, projectRoot);
  const projectContent = `${JSON.stringify(project, null, 2)}\n`;
  const indexContent = `${JSON.stringify(index, null, 2)}\n`;
  await Promise.all([
    writeFile(configPath, projectContent, "utf8"),
    writeFile(indexPath, indexContent, "utf8"),
  ]);

  const manifestPayload = { ...manifest };
  delete manifestPayload.fingerprint;
  manifestPayload.rootRealpath = projectRoot;
  manifestPayload.projectConfigSha256 = sha256(projectContent);
  manifestPayload.bootstrapIndexSha256 = sha256(indexContent);
  const fingerprint = sha256(JSON.stringify(stableValue(manifestPayload)));
  await writeFile(manifestPath, `${JSON.stringify({ ...manifestPayload, fingerprint }, null, 2)}\n`, "utf8");
}

async function snapshotFile(absolutePath: string, relativePath: string): Promise<RedlineSentinelSnapshot> {
  try {
    const [metadata, content] = await Promise.all([lstat(absolutePath), readFile(absolutePath)]);
    if (!metadata.isFile()) {
      throw new Error(`红线哨兵必须是普通文件：${absolutePath}`);
    }
    return {
      relativePath,
      exists: true,
      bytes: metadata.size,
      mtimeMs: normalizeRedlineSentinelMtimeMs(metadata.mtimeMs),
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { relativePath, exists: false };
    throw error;
  }
}

export async function snapshotRedlineProjectSentinels(projectRoot: string): Promise<RedlineSentinelSnapshot[]> {
  const root = path.resolve(projectRoot);
  return Promise.all(REDLINE_SENTINEL_RELATIVE_PATHS.map((relativePath) => (
    snapshotFile(path.join(root, relativePath), relativePath)
  )));
}

/**
 * 复制完整工程并解除符号链接，避免副本中的任何 Core 初始化/迁移绕回正式目录。
 */
export async function createIsolatedRedlineProjectCopy(projectRoot: string): Promise<IsolatedRedlineProjectCopy> {
  const sourceProjectRoot = path.resolve(projectRoot);
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "aicanvas-redline-project-"));
  const copiedProjectRoot = path.join(runtimeRoot, "project", path.basename(sourceProjectRoot));
  const cleanup = () => rm(runtimeRoot, { recursive: true, force: true }).then(() => undefined);
  try {
    await cp(sourceProjectRoot, copiedProjectRoot, {
      recursive: true,
      dereference: true,
      preserveTimestamps: true,
      force: false,
      errorOnExist: true,
    });
    const canonicalCopiedProjectRoot = await realpath(copiedProjectRoot);
    await rebindCopiedManagedProjectMetadata(canonicalCopiedProjectRoot);
    return { sourceProjectRoot, projectRoot: canonicalCopiedProjectRoot, runtimeRoot, cleanup };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}

export async function assertRedlineProjectSentinelsUnchanged(
  projectRoot: string,
  before: readonly RedlineSentinelSnapshot[],
): Promise<RedlineSentinelSnapshot[]> {
  const after = await snapshotRedlineProjectSentinels(projectRoot);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error(`正式工程红线哨兵发生变化：${path.resolve(projectRoot)}`);
  }
  return after;
}
