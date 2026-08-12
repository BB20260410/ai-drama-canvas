import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizeStudioJsonValue,
  digestStudioCanonicalJson,
  serializeStudioCanonicalJsonPretty,
} from "../src/core/studio-canonical-json.js";

function legacyStableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyStableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, legacyStableValue(entry)]));
}

const VECTOR = {
  z: 3,
  a: {
    y: undefined,
    x: "汉字",
    b: [{ z: 2, a: 1 }, undefined, null, false, -0],
  },
  arr: [3, { b: 2, a: 1 }, undefined],
  omitted: undefined,
};

describe("Studio canonical JSON", () => {
  it("与八个旧 owner 的规范化规则保持逐字节等价", () => {
    const legacyCompact = JSON.stringify(legacyStableValue(VECTOR));
    expect(JSON.stringify(canonicalizeStudioJsonValue(VECTOR))).toBe(legacyCompact);
    expect(digestStudioCanonicalJson(VECTOR)).toBe(
      createHash("sha256").update(legacyCompact, "utf8").digest("hex"),
    );
    expect(serializeStudioCanonicalJsonPretty(VECTOR)).toBe(
      `${JSON.stringify(legacyStableValue(VECTOR), null, 2)}\n`,
    );
  });

  it("锁定历史 hash、对象排序、数组保序和 undefined 语义", () => {
    expect(JSON.stringify(canonicalizeStudioJsonValue(VECTOR))).toBe(
      "{\"a\":{\"b\":[{\"a\":1,\"z\":2},null,null,false,0],\"x\":\"汉字\"},\"arr\":[3,{\"a\":1,\"b\":2},null],\"z\":3}",
    );
    expect(digestStudioCanonicalJson(VECTOR)).toBe(
      "7bf5bb5b0d17bfb7598c45adf5e6af88618181b8c64f1810a4bd860c7a9d0d0d",
    );
    expect(serializeStudioCanonicalJsonPretty(VECTOR)).toMatch(/\n\}\n$/u);
  });
});
