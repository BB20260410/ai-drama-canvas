import { randomUUID } from "node:crypto";
import { link, lstat, open, rm } from "node:fs/promises";
import path from "node:path";

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

export function createUniqueEvidenceStem(prefix = "isolated-package-smoke") {
  const timestamp = new Date().toISOString().replace(/[-:.]/gu, "").replace("Z", "Z");
  return `${prefix}-${timestamp}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

export async function assertFreshOutputSet(entries) {
  const normalized = entries.map((entry) => ({
    label: String(entry.label || "证据输出"),
    path: path.resolve(entry.path),
  }));
  const duplicates = normalized.filter((entry, index) =>
    normalized.findIndex((candidate) => candidate.path === entry.path) !== index);
  if (duplicates.length) {
    throw new Error(`证据输出路径重复：${duplicates.map((entry) => entry.path).join(",")}`);
  }
  for (const entry of normalized) {
    try {
      await lstat(entry.path);
      throw new Error(`拒绝覆盖既存${entry.label}：${entry.path}`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

export function createEvidenceRunLockOwner(lockPath, handle, removeFile = (target) => rm(target, { force: true })) {
  let handleClosed = false;
  let released = false;
  return {
    path: lockPath,
    async release() {
      if (released) return;
      if (!handleClosed) {
        await handle.close();
        handleClosed = true;
      }
      await removeFile(lockPath);
      released = true;
    },
  };
}

export async function acquireEvidenceRunLock(evidencePath, runId, io = {}) {
  const lockPath = `${path.resolve(evidencePath)}.lock`;
  const openFile = io.openFile ?? open;
  const removeFile = io.removeFile ?? ((target) => rm(target, { force: true }));
  const handle = await openFile(lockPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ runId, evidencePath: path.resolve(evidencePath), pid: process.pid })}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    const cleanupErrors = [];
    let handleClosed = false;
    try {
      await handle.close();
      handleClosed = true;
    } catch (closeError) {
      cleanupErrors.push(closeError);
    }
    if (handleClosed) {
      try {
        await removeFile(lockPath);
      } catch (removeError) {
        cleanupErrors.push(removeError);
      }
    }
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], "证据 run lock 初始化失败且未能完整清理");
    }
    throw error;
  }
  return createEvidenceRunLockOwner(lockPath, handle, removeFile);
}

export async function writeBytesAtomicExclusive(targetPath, bytes) {
  const resolvedTarget = path.resolve(targetPath);
  const temporaryPath = path.join(
    path.dirname(resolvedTarget),
    `.${path.basename(resolvedTarget)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // 同目录 hard-link 是原子 no-clobber 发布；目标已存在时必定 EEXIST。
    await link(temporaryPath, resolvedTarget);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function writeJsonAtomicExclusive(targetPath, value) {
  await writeBytesAtomicExclusive(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}
