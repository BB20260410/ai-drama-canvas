import { describe, expect, it } from "vitest";
import {
  APPROVED_TIMELINE_BOUNDED_UNIT_LIMIT,
  resolveApprovedTimelineBound,
} from "../src/core/studio-approved-timeline-projection.js";

describe("resolveApprovedTimelineBound（Wave 2-A）", () => {
  it("省略 unitIds/limit 表示整集", () => {
    expect(resolveApprovedTimelineBound(undefined)).toEqual({});
    expect(resolveApprovedTimelineBound({})).toEqual({});
  });

  it("unitIds 去重且上限 36", () => {
    expect(resolveApprovedTimelineBound({ unitIds: ["u1", "u1", "u2"] })).toEqual({
      unitIds: ["u1", "u2"],
    });
    expect(() => resolveApprovedTimelineBound({ unitIds: [] })).toThrow(/非空数组/);
    expect(() => resolveApprovedTimelineBound({
      unitIds: Array.from({ length: APPROVED_TIMELINE_BOUNDED_UNIT_LIMIT + 1 }, (_, i) => `u${i}`),
    })).toThrow(/最多 36/);
  });

  it("limit 必须是 1–36；有 unitIds 时忽略 limit", () => {
    expect(resolveApprovedTimelineBound({ limit: 36 })).toEqual({ limit: 36 });
    expect(() => resolveApprovedTimelineBound({ limit: 0 })).toThrow(/1–36/);
    expect(() => resolveApprovedTimelineBound({ limit: 37 })).toThrow(/1–36/);
    expect(resolveApprovedTimelineBound({ unitIds: ["u1"], limit: 8 })).toEqual({ unitIds: ["u1"] });
  });
});
