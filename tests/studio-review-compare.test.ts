import { describe, expect, it } from "vitest";
import {
  assignUniqueAnnotationIds,
  annotationCategorySummary,
  buildReviewCriteria,
  composeAbsDifference,
  deriveAnnotationId,
  joinCriteriaNotes,
  sha256HexUtf8,
  wipeDividerPercent,
  type RgbaImage,
} from "../src/renderer/src/studio-review-compare.js";

/**
 * P22 §4-5 纯函数定向测试：|A−B| 合成、wipe 百分比、id 派生确定性、分类摘要与拼接截断。
 */

function image(width: number, height: number, fill: (index: number) => number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 1) data[index] = fill(index);
  return { width, height, data: data as Uint8ClampedArray<ArrayBuffer> };
}

describe("P22 studio-review-compare 纯函数", () => {
  it("自研 sha256 与公开测试向量一致（含多分组与 UTF-8）", () => {
    expect(sha256HexUtf8("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256HexUtf8("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256HexUtf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))
      .toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(sha256HexUtf8("阿航的黄金面具🎭")).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("criteria 装配：分类码字母序+恒含 raw-labeled-pair+rework 全 fail/pass 全 pass+无批注回退三码", () => {
    const reworked = buildReviewCriteria("rework", [
      { category: "scene", note: "石室偏移" },
      { category: "face", note: "脸型" },
      { category: "face", note: "挑染" },
    ], "用户批注");
    expect(reworked.map((entry) => entry.code)).toEqual(["face", "scene", "raw-labeled-pair"]);
    expect(reworked[0]).toMatchObject({ code: "face", status: "fail", note: "脸型；挑染" });
    expect(reworked[1]).toMatchObject({ code: "scene", status: "fail" });
    expect(reworked[2]).toMatchObject({ code: "raw-labeled-pair", status: "pass" });
    const passed = buildReviewCriteria("pass", [{ category: "hair", note: "发型" }], "用户批注");
    expect(passed[0]).toMatchObject({ code: "hair", status: "pass" });
    const fallback = buildReviewCriteria("rework", [], "用户批注");
    expect(fallback.map((entry) => entry.code)).toEqual(["identity-consistency", "scene-prop-continuity", "raw-labeled-pair"]);
    expect(fallback[0]).toMatchObject({ status: "fail", note: "用户批注" });
    expect(fallback[1]).toMatchObject({ status: "not-applicable" });
  });

  it("|A−B| 逐像素绝对值合成；尺寸不一致 fail-closed", () => {
    const a = image(2, 1, (index) => (index % 4 === 0 ? 200 : 0));
    const b = image(2, 1, (index) => (index % 4 === 0 ? 50 : 0));
    const diff = composeAbsDifference(a, b);
    expect(diff.width).toBe(2);
    expect(diff.data[0]).toBe(150);
    expect(diff.data[4]).toBe(150);
    expect(diff.data[3]).toBe(255);
    const swapped = composeAbsDifference(b, a);
    expect([...swapped.data]).toEqual([...diff.data]);
    expect(() => composeAbsDifference(a, image(1, 1, () => 0))).toThrow(/同尺寸/u);
  });

  it("wipe 分割线百分比 clamp 与边界", () => {
    expect(wipeDividerPercent(0, 200)).toBe(0);
    expect(wipeDividerPercent(100, 200)).toBe(50);
    expect(wipeDividerPercent(400, 200)).toBe(100);
    expect(wipeDividerPercent(-5, 200)).toBe(0);
    expect(wipeDividerPercent(50, 0)).toBe(50);
    expect(wipeDividerPercent(Number.NaN, 200)).toBe(50);
  });

  it("id 派生确定性：同内容同 id、改内容换 id、集合冲突追加 -2", () => {
    const draft = { kind: "rect" as const, category: "face" as const, x: 0.1, y: 0.2, width: 0.3, height: 0.4, note: "鼻子" };
    const first = deriveAnnotationId(draft);
    const second = deriveAnnotationId({ ...draft });
    expect(first).toBe(second);
    expect(first).toMatch(/^ann-[a-f0-9]{12}$/u);
    expect(deriveAnnotationId({ ...draft, note: "眼睛" })).not.toBe(first);
    expect(deriveAnnotationId({ ...draft, x: 0.2 })).not.toBe(first);
    const [a, b, c] = assignUniqueAnnotationIds([draft, { ...draft }, { ...draft, note: "不同" }]);
    expect(a!.id).toBe(first);
    expect(b!.id).toBe(`${first}-2`);
    expect(c!.id).not.toBe(a!.id);
    expect(c!.id).not.toBe(b!.id);
    expect(new Set([a!.id, b!.id, c!.id]).size).toBe(3);
  });

  it("分类摘要与 criteria.note 确定性拼接截断", () => {
    expect(annotationCategorySummary([])).toBe("");
    expect(annotationCategorySummary(["face", "face", "golden-mask"])).toBe("问题分类：脸/黄金面具");
    expect(joinCriteriaNotes([" 甲 ", "", "乙"])).toBe("甲；乙");
    const long = joinCriteriaNotes(["长".repeat(5_000)]);
    expect(long.length).toBe(4_000);
    expect(long.endsWith("…")).toBe(true);
  });
});
