import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  commandTerminalJsonDigest,
  parseCommandTerminalReceiptData,
  projectConfirmedCommandFailureForReceipt,
} from "../src/core/command-terminal-receipt.js";

describe("命令终态收据合同", () => {
  const digest = "a".repeat(64);

  it("result digest 以 JSON 真实落盘形态为准，undefined 字段不制造同键冲突", () => {
    const input = { kept: "value", omitted: undefined, nested: { count: 1, omitted: undefined } };
    const persisted = JSON.parse(JSON.stringify(input)) as unknown;
    const independentStable = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(independentStable).join(",")}]`;
      if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => `${JSON.stringify(key)}:${independentStable(entry)}`)
          .join(",")}}`;
      }
      return JSON.stringify(value);
    };
    const expected = createHash("sha256").update(independentStable(persisted)).digest("hex");
    expect(commandTerminalJsonDigest(input)).toBe(expected);
    expect(commandTerminalJsonDigest(input)).toBe(commandTerminalJsonDigest(persisted));
  });

  it.each([
    [{ resultDigest: digest, outcomeStatus: "succeeded" }, "succeeded"],
    [{ resultDigest: digest, outcomeStatus: "failed" }, "failed"],
    [{ resultDigest: digest }, "succeeded"],
  ] as const)("只接受明确成功、明确失败与历史缺省成功", (data, outcomeStatus) => {
    expect(parseCommandTerminalReceiptData(data)).toEqual({
      resultDigest: digest,
      outcomeStatus,
    });
  });

  it.each([
    undefined,
    "",
    "not-a-sha256",
    "a".repeat(63),
    "A".repeat(64),
  ])("拒绝非法 SHA-256 摘要：%s", (resultDigest) => {
    expect(() => parseCommandTerminalReceiptData({ resultDigest })).toThrow("resultDigest");
  });

  it.each(["cancelled", "suceeded", "unknown", null])(
    "拒绝未定义的 outcomeStatus：%s",
    (outcomeStatus) => {
      expect(() => parseCommandTerminalReceiptData({ resultDigest: digest, outcomeStatus })).toThrow("outcomeStatus");
    },
  );

  it("confirmed failure 只保留白名单结构且绝不复制正文、路径、凭据或任意 reason", () => {
    const secret = "TOP_SECRET_NOVEL_BODY_20260813";
    const absolutePath = "/Users/example/private/source.md";
    const projection = projectConfirmedCommandFailureForReceipt({
      applied: false,
      status: "failed",
      reason: secret,
      intentId: "publication-safe-001",
      nested: { bearer: "secret-token" },
    }, `${secret} ${absolutePath} Bearer secret-token`);
    expect(projection).toEqual({
      schemaVersion: 1,
      kind: "confirmed-command-failure",
      code: "confirmed_failure",
      summary: "命令业务已提交并确认失败。",
      applied: false,
      intentId: "publication-safe-001",
      status: "failed",
    });
    expect(JSON.stringify(projection)).not.toContain(secret);
    expect(JSON.stringify(projection)).not.toContain(absolutePath);
    expect(JSON.stringify(projection)).not.toContain("secret-token");
  });
});
