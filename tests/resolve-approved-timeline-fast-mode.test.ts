import { describe, expect, it } from "vitest";
import { resolveApprovedTimelineFastMode } from "../src/core/studio-approved-timeline-projection.js";

/**
 * Wave 1-A 合同：省略 / undefined → true；仅显式 false 走 full。
 * 不建受管工程，Linux/macOS 均可跑。
 */
describe("resolveApprovedTimelineFastMode", () => {
  it("省略与 undefined 视为 true", () => {
    expect(resolveApprovedTimelineFastMode(undefined)).toBe(true);
    expect(resolveApprovedTimelineFastMode({})).toBe(true);
    expect(resolveApprovedTimelineFastMode({ fastMode: undefined })).toBe(true);
  });

  it("显式 true / false 原样返回", () => {
    expect(resolveApprovedTimelineFastMode({ fastMode: true })).toBe(true);
    expect(resolveApprovedTimelineFastMode({ fastMode: false })).toBe(false);
  });
});
