import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomicExclusive } from "./exclusive-evidence-output.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

export function isolatedPackageCompletionMarkerPath(evidencePath) {
  const resolved = path.resolve(evidencePath);
  const extension = path.extname(resolved);
  const stem = extension ? resolved.slice(0, -extension.length) : resolved;
  return `${stem}-completion${extension || ".json"}`;
}

async function releaseAfterTerminalWriteFailure(releaseLock, writeError) {
  try {
    await releaseLock();
  } catch (releaseError) {
    throw new AggregateError(
      [writeError, releaseError],
      "terminal evidence 写入失败且 run lock 未能完整释放",
    );
  }
  throw writeError;
}

/**
 * 两阶段 no-clobber 终结：
 * 1) 锁仍持有时写入 durable terminal，其 status 固定为 finalization-pending；
 * 2) 释放锁后只新建 completion marker，不覆盖 terminal。
 *
 * 任何消费者都必须同时验证 terminal hash 与 completion marker，
 * 单独的 finalization-pending terminal 不能被解释为完整 PASS。
 */
export async function finalizeIsolatedPackageTerminalEvidence(input) {
  const evidencePath = path.resolve(input.evidencePath);
  const lockPath = `${evidencePath}.lock`;
  if (typeof input.runId !== "string" || input.runId.trim().length === 0) {
    throw new Error("isolated package terminal evidence runId 必须是非空字符串。");
  }
  if (typeof input.lockPath !== "string" || path.resolve(input.lockPath) !== lockPath) {
    throw new Error(`isolated package terminal evidence lockPath 必须是 canonical evidence lock：${lockPath}`);
  }
  const completionMarkerPath = isolatedPackageCompletionMarkerPath(evidencePath);
  const terminal = {
    ...input.terminalEvidence,
    runId: input.runId,
    lockPath,
    status: "finalization-pending",
    outcome: input.outcome,
    finalization: {
      schemaVersion: 1,
      state: "terminal-written-lock-release-pending",
      completionMarkerPath,
      lockReleasePending: true,
      completed: false,
    },
  };

  try {
    await writeJsonAtomicExclusive(evidencePath, terminal);
  } catch (writeError) {
    await releaseAfterTerminalWriteFailure(input.releaseLock, writeError);
  }

  await input.releaseLock();
  try {
    await lstat(lockPath);
    throw new Error(`isolated package run lock 释放后仍存在：${lockPath}`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const terminalBytes = await readFile(evidencePath);
  const terminalSha256 = sha256(terminalBytes);
  const completion = {
    schemaVersion: 1,
    kind: "isolated-package-smoke-completion",
    runId: input.runId,
    terminalEvidencePath: evidencePath,
    terminalEvidenceSha256: terminalSha256,
    lockPath,
    lockAbsent: true,
    status: input.outcome,
    lockReleased: true,
    completedAt: new Date().toISOString(),
  };
  await writeJsonAtomicExclusive(completionMarkerPath, completion);
  return readCompletedIsolatedPackageTerminalEvidence(evidencePath);
}

export async function readCompletedIsolatedPackageTerminalEvidence(evidencePathValue) {
  const evidencePath = path.resolve(evidencePathValue);
  const lockPath = `${evidencePath}.lock`;
  const completionMarkerPath = isolatedPackageCompletionMarkerPath(evidencePath);
  let terminalBytes;
  let completionBytes;
  try {
    [terminalBytes, completionBytes] = await Promise.all([
      readFile(evidencePath),
      readFile(completionMarkerPath),
    ]);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`isolated package completion marker 或 terminal evidence 缺失：${completionMarkerPath}`, { cause: error });
    }
    throw error;
  }
  const terminal = JSON.parse(terminalBytes.toString("utf8"));
  const completion = JSON.parse(completionBytes.toString("utf8"));
  const expectedTerminalSha256 = sha256(terminalBytes);
  if (!terminal || typeof terminal !== "object" || Array.isArray(terminal)) {
    throw new Error("isolated package terminal evidence 两阶段字段无效。");
  }
  if (typeof terminal.runId !== "string" || terminal.runId.trim().length === 0) {
    throw new Error("isolated package terminal evidence runId 必须是非空字符串。");
  }
  if (terminal.lockPath !== lockPath) {
    throw new Error(`isolated package terminal evidence lockPath 必须是 canonical evidence lock：${lockPath}`);
  }
  if (terminal.status !== "finalization-pending"
    || !["passed", "failed"].includes(terminal.outcome)
    || terminal.finalization?.state !== "terminal-written-lock-release-pending"
    || terminal.finalization?.completionMarkerPath !== completionMarkerPath
    || terminal.finalization?.lockReleasePending !== true
    || terminal.finalization?.completed !== false) {
    throw new Error("isolated package terminal evidence 两阶段字段无效。");
  }
  if (!completion || typeof completion !== "object" || Array.isArray(completion)
    || completion.schemaVersion !== 1
    || completion.kind !== "isolated-package-smoke-completion"
    || completion.terminalEvidencePath !== evidencePath
    || !SHA256_PATTERN.test(completion.terminalEvidenceSha256 ?? "")
    || completion.terminalEvidenceSha256 !== expectedTerminalSha256
    || completion.lockPath !== lockPath
    || completion.lockPath !== terminal.lockPath
    || completion.lockAbsent !== true
    || completion.status !== terminal.outcome
    || completion.lockReleased !== true
    || typeof completion.completedAt !== "string"
    || Number.isNaN(Date.parse(completion.completedAt))) {
    throw new Error("isolated package completion marker 与 terminal evidence 身份不一致。");
  }
  if (typeof completion.runId !== "string" || completion.runId.trim().length === 0) {
    throw new Error("isolated package completion marker runId 必须是非空字符串。");
  }
  if (completion.runId !== terminal.runId) {
    throw new Error("isolated package completion marker 与 terminal evidence 身份不一致。");
  }
  try {
    await lstat(lockPath);
    throw new Error(`isolated package completion marker 对应的 run lock 仍存在：${lockPath}`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return { terminal, completion, completionMarkerPath };
}
