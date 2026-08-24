export type CommandTerminalReceiptOutcomeStatus = "succeeded" | "failed";

export type ParsedCommandTerminalReceiptData = {
  resultDigest: string;
  outcomeStatus: CommandTerminalReceiptOutcomeStatus;
};

export type SafeConfirmedCommandFailureProjection = {
  schemaVersion: 1;
  kind: "confirmed-command-failure";
  code: string;
  summary: string;
} & Record<string, unknown>;

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_TOKEN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/u;

function stableJsonValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonValue(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** JSON owner 真实落盘形态的终态结果摘要。 */
export function commandTerminalJsonDigest(value: unknown): string {
  const serialized = JSON.stringify(value);
  const persisted = serialized === undefined ? value : JSON.parse(serialized) as unknown;
  return createHash("sha256").update(stableJsonValue(persisted)).digest("hex");
}

export function parseCommandTerminalReceiptData(
  data: Readonly<Record<string, unknown>> | undefined,
): ParsedCommandTerminalReceiptData {
  const resultDigest = data?.resultDigest;
  if (typeof resultDigest !== "string" || !SHA256_HEX_PATTERN.test(resultDigest)) {
    throw new Error("命令终态收据的 resultDigest 必须是 64 位小写 SHA-256；保持原账本状态并停止对账。");
  }

  const rawOutcomeStatus = data?.outcomeStatus;
  if (rawOutcomeStatus !== undefined
    && rawOutcomeStatus !== "succeeded"
    && rawOutcomeStatus !== "failed") {
    throw new Error("命令终态收据的 outcomeStatus 无效；保持原账本状态并停止对账。");
  }

  return {
    resultDigest,
    // 兼容迁移前由受控本机 producer 写入、尚未携带 outcomeStatus 的成功收据。
    outcomeStatus: rawOutcomeStatus ?? "succeeded",
  };
}

/**
 * producer 抛出的失败对象可能包含正文、本机路径或供应方原文，不能原样进入
 * terminal receipt。只保留有界枚举式 code 与短摘要，供崩溃后安全恢复语义。
 */
export function projectConfirmedCommandFailureForReceipt(
  result: unknown,
  _message: unknown,
): SafeConfirmedCommandFailureProjection {
  const source = result && typeof result === "object" && !Array.isArray(result)
    ? result as Readonly<Record<string, unknown>>
    : {};
  const projection: SafeConfirmedCommandFailureProjection = {
    schemaVersion: 1,
    kind: "confirmed-command-failure",
    code: "confirmed_failure",
    summary: "命令业务已提交并确认失败。",
  };
  for (const key of ["applied", "submitted", "statusApplied"] as const) {
    if (typeof source[key] === "boolean") projection[key] = source[key];
  }
  for (const key of ["intentId", "jobId"] as const) {
    if (typeof source[key] === "string" && SAFE_TOKEN_PATTERN.test(source[key])) projection[key] = source[key];
  }
  if (["failed", "blocked", "rejected", "conflict"].includes(String(source.status))) {
    projection.status = source.status;
  }
  return projection;
}
import { createHash } from "node:crypto";
