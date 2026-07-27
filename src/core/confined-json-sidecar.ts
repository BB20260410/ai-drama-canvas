import path from "node:path";
import { readdir } from "node:fs/promises";
import {
  ensureConfinedDirectory,
  inspectExistingConfinedDirectory,
  persistConfinedBytesNoReplace,
  readConfinedRegularFileWithIdentity,
  revalidateConfinedDirectory,
} from "./confined-project-storage.js";

function missing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function safeDirectoryName(value: string): string {
  if (!value || value !== path.basename(value) || value === "." || value === "..") {
    throw new Error("受管 JSON 目录名必须是单一 basename。");
  }
  return value;
}

function safeFileName(value: string): string {
  if (!value || value !== path.basename(value) || value === "." || value === "..") {
    throw new Error("受管 JSON 文件名必须是单一 basename。");
  }
  return value;
}

export async function readConfinedJsonSidecar<T>(
  projectRoot: string,
  directoryName: string,
  fileName: string,
  fallback: T,
  maximumBytes: number,
): Promise<T> {
  const root = path.resolve(projectRoot);
  const directoryPath = path.join(root, ".aicanvas", safeDirectoryName(directoryName));
  let directory;
  try {
    directory = await inspectExistingConfinedDirectory(root, directoryPath);
  } catch (error) {
    if (missing(error)) return fallback;
    throw error;
  }
  try {
    const persisted = await readConfinedRegularFileWithIdentity(
      directory,
      safeFileName(fileName),
      maximumBytes,
    );
    if (persisted.nlink !== 1) throw new Error("受管 JSON 文件存在额外硬链接，拒绝读取。");
    return JSON.parse(persisted.bytes.toString("utf8")) as T;
  } catch (error) {
    if (missing(error)) return fallback;
    if (error instanceof SyntaxError) {
      throw new Error("受管 JSON 已损坏，已停止写入以保留现场。", { cause: error });
    }
    throw error;
  }
}

export async function writeConfinedJsonSidecarNoReplace(
  projectRoot: string,
  directoryName: string,
  fileName: string,
  value: unknown,
  maximumBytes: number,
): Promise<"created" | "existing"> {
  const root = path.resolve(projectRoot);
  const directory = await ensureConfinedDirectory(
    root,
    path.join(root, ".aicanvas", safeDirectoryName(directoryName)),
  );
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.byteLength > maximumBytes) throw new Error("受管 JSON 超过允许大小。");
  const result = await persistConfinedBytesNoReplace(
    directory,
    safeFileName(fileName),
    bytes,
  );
  return result.created ? "created" : "existing";
}

export async function listConfinedJsonSidecarNames(
  projectRoot: string,
  directoryName: string,
  maximumEntries = 10_000,
): Promise<string[]> {
  const root = path.resolve(projectRoot);
  const directoryPath = path.join(root, ".aicanvas", safeDirectoryName(directoryName));
  let directory;
  try {
    directory = await inspectExistingConfinedDirectory(root, directoryPath);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  await revalidateConfinedDirectory(directory);
  const entries = await readdir(directory.directory, { withFileTypes: true });
  await revalidateConfinedDirectory(directory);
  if (entries.length > maximumEntries) throw new Error("受管 JSON 目录条目超过允许上限。");
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`受管 JSON 目录包含非普通文件：${entry.name}`);
    }
    names.push(safeFileName(entry.name));
  }
  return names.sort((left, right) => left.localeCompare(right, "en"));
}
