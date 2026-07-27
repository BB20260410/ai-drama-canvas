import { describe, expect, it } from "vitest";
import {
  assertShotNumbersValid,
  intercalateShotNumber,
  nextShotNumber,
} from "../src/core/studio-shot-numbering.js";

describe("intercalateShotNumber", () => {
  it("10 与 20 之间插入 15", () => {
    expect(intercalateShotNumber(10, 20)).toBe(15);
  });

  it("仅 before → +step", () => {
    expect(intercalateShotNumber(30, null, 10)).toBe(40);
  });

  it("相邻无空隙 fail-close", () => {
    expect(() => intercalateShotNumber(10, 11)).toThrow(/相邻/);
  });

  it("after <= before fail-close", () => {
    expect(() => intercalateShotNumber(20, 10)).toThrow(/大于/);
  });
});

describe("nextShotNumber", () => {
  it("空列表从 step 起", () => {
    expect(nextShotNumber([])).toBe(10);
  });

  it("在最大号后步进", () => {
    expect(nextShotNumber([10, 20, 15])).toBe(30);
  });
});

describe("assertShotNumbersValid", () => {
  it("重复拒绝", () => {
    expect(() => assertShotNumbersValid([10, 10])).toThrow(/重复/);
  });
});
