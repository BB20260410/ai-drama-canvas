import { describe, expect, it } from "vitest";
import {
  compareT23RawShaProjection,
  summarizeT23RawVisualDecode,
  type T23ExpectedRaw,
} from "../scripts/lib/t23-raw-sha-ui-verify-shared.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function expected(): T23ExpectedRaw[] {
  return [
    { unitId: "S1E02-U00", mediaSha256: SHA_A },
    { unitId: "S1E02-U01", mediaSha256: SHA_B },
  ];
}

describe("T23 通用 raw SHA 集合验收", () => {
  it("允许 DOM 与管道快照重复观测同一单元同一 SHA", () => {
    const result = compareT23RawShaProjection(expected(), [
      { unitId: "S1E02-U00", mediaSha256: SHA_A, source: "dom" },
      { unitId: "S1E02-U00", mediaSha256: SHA_A, source: "pipeline" },
      { unitId: "S1E02-U01", mediaSha256: SHA_B, source: "pipeline" },
    ]);
    expect(result).toMatchObject({
      ok: true,
      expectedCount: 2,
      observedUnitCount: 2,
      matchedCount: 2,
    });
  });

  it("缺失、夹带、错 SHA 或同单元多个 SHA 均失败", () => {
    const result = compareT23RawShaProjection(expected(), [
      { unitId: "S1E02-U00", mediaSha256: SHA_B },
      { unitId: "S1E02-U00", mediaSha256: SHA_A },
      { unitId: "S1E99-U99", mediaSha256: SHA_A },
    ]);
    expect(result.ok).toBe(false);
    expect(result.missingUnitIds).toEqual(["S1E02-U01"]);
    expect(result.strayUnitIds).toEqual(["S1E99-U99"]);
    expect(result.mismatches).toEqual([{
      unitId: "S1E02-U00",
      expectedSha256: SHA_A,
      observedSha256: [SHA_A, SHA_B],
    }]);
  });

  it("无效或重复 Core 期望以及非法 UI SHA 均失败", () => {
    const result = compareT23RawShaProjection([
      ...expected(),
      { unitId: "S1E02-U00", mediaSha256: SHA_A },
      { unitId: "S1E02-U02", mediaSha256: "bad" },
    ], [
      { unitId: "S1E02-U00", mediaSha256: SHA_A },
      { unitId: "S1E02-U01", mediaSha256: "bad" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.invalidExpectedUnitIds).toEqual(["S1E02-U00", "S1E02-U02"]);
    expect(result.invalidObserved).toHaveLength(1);
  });

  it("逐单元图片必须真实解码且 naturalWidth>0；缺 URL 明确记为 SKIP 但不算通过", () => {
    expect(summarizeT23RawVisualDecode(["S1E02-U00", "S1E02-U01"], [
      { unitId: "S1E02-U00", status: "PASS", naturalWidth: 1920, naturalHeight: 1080 },
      { unitId: "S1E02-U01", status: "SKIP", naturalWidth: 0, naturalHeight: 0, reason: "thumbnail-url-missing" },
    ])).toMatchObject({
      ok: false,
      passed: 1,
      failed: 0,
      skipped: 1,
      missingUnitIds: [],
    });
  });
});
