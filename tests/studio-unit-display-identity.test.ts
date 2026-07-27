/**
 * T8 单元编号统一测试。
 * 验证：buildUnitDisplayIdentity 生成双编号、matchesUnitSearchQuery 多形式搜索命中同一单元。
 */
import { describe, it, expect } from "vitest";
import {
  buildUnitDisplayIdentity,
  matchesUnitSearchQuery,
} from "../src/core/studio-unit-display-identity.js";

describe("T8 单元双编号与搜索", () => {
  const identity = buildUnitDisplayIdentity({
    unitId: "unit-abc-123",
    sequence: 29,
    season: "S1",
    episode: "S1E1",
  });

  it("生成正确的双编号标签", () => {
    expect(identity.displaySequence).toBe(29);
    expect(identity.sequenceLabel).toBe("029");
    expect(identity.unitIndexLabel).toBe("U28");
    expect(identity.fullLabel).toBe("S1E1-U28");
    expect(identity.displayLabel).toBe("029｜S1E1-U28");
  });

  it("搜索 029 命中", () => {
    expect(matchesUnitSearchQuery(identity, "029")).toBe(true);
  });

  it("搜索 U28 命中", () => {
    expect(matchesUnitSearchQuery(identity, "U28")).toBe(true);
    expect(matchesUnitSearchQuery(identity, "u28")).toBe(true);
  });

  it("搜索 S1E1-U28 命中", () => {
    expect(matchesUnitSearchQuery(identity, "S1E1-U28")).toBe(true);
    expect(matchesUnitSearchQuery(identity, "s1e1-u28")).toBe(true);
  });

  it("搜索 unitId 命中", () => {
    expect(matchesUnitSearchQuery(identity, "unit-abc-123")).toBe(true);
    expect(matchesUnitSearchQuery(identity, "abc-123")).toBe(true); // 包含匹配
  });

  it("搜索不相关字符串不命中", () => {
    expect(matchesUnitSearchQuery(identity, "U30")).toBe(false);
    expect(matchesUnitSearchQuery(identity, "030")).toBe(false);
    expect(matchesUnitSearchQuery(identity, "xyz")).toBe(false);
  });

  it("空查询不命中", () => {
    expect(matchesUnitSearchQuery(identity, "")).toBe(false);
    expect(matchesUnitSearchQuery(identity, "  ")).toBe(false);
  });

  it("第一个单元编号正确（U0）", () => {
    const first = buildUnitDisplayIdentity({ unitId: "first", sequence: 1 });
    expect(first.sequenceLabel).toBe("001");
    expect(first.unitIndexLabel).toBe("U0");
    expect(first.displayLabel).toBe("001｜S1E1-U0");
  });
});
