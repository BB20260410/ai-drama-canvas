import { describe, expect, it } from "vitest";
import { classifyStudioStaleReasons } from "../src/core/studio-stale-classification.js";

describe("P24 classifyStudioStaleReasons 变化分类（全词表+fail-safe）", () => {
  it("空数组 → current，双列表为空", () => {
    expect(classifyStudioStaleReasons([])).toEqual({
      classification: "current",
      expectedReasons: [],
      unexpectedReasons: [],
    });
  });

  it("expected 白名单精确串逐项命中", () => {
    const expected = [
      "script-changed",
      "prompt-changed",
      "source-spans-changed",
      "unit-changed",
      "binding-set-not-head",
      "analysis-head-changed",
      "empty-confirmation-head-changed",
    ];
    const result = classifyStudioStaleReasons(expected);
    expect(result.classification).toBe("expected");
    expect(result.expectedReasons).toEqual(expected);
    expect(result.unexpectedReasons).toEqual([]);
  });

  it("expected 前缀族（decision-head-changed:/section-head-changed:）带实体后缀命中", () => {
    const result = classifyStudioStaleReasons([
      "decision-head-changed:proposal-1",
      "section-head-changed:section-9",
    ]);
    expect(result.classification).toBe("expected");
    expect(result.expectedReasons).toHaveLength(2);
  });

  it("empty-confirmation-stale 包装词拆解内层：内层 expected→expected，内层非预期→unexpected", () => {
    expect(classifyStudioStaleReasons(["empty-confirmation-stale:script-changed"]).classification).toBe("expected");
    const innerUnexpected = classifyStudioStaleReasons(["empty-confirmation-stale:asset-missing:asset-1"]);
    expect(innerUnexpected.classification).toBe("unexpected");
    expect(innerUnexpected.unexpectedReasons).toEqual(["empty-confirmation-stale:asset-missing:asset-1"]);
    // 空内层不命中包装豁免 → unexpected（fail-safe）
    expect(classifyStudioStaleReasons(["empty-confirmation-stale:"]).classification).toBe("unexpected");
    // 双层包装递归
    expect(classifyStudioStaleReasons(["empty-confirmation-stale:empty-confirmation-stale:prompt-changed"]).classification).toBe("expected");
  });

  it("unexpected 全族：pin 破坏/实体缺失/权威资产语义变化", () => {
    const unexpected = [
      "asset-missing:asset-1",
      "asset-semantic-changed:asset-2",
      "identity-key-changed:character:role-1",
      "analysis-fingerprint-changed",
      "analysis-not-empty",
      "confirmation-not-head",
      "empty-confirmation-dependency-invalid",
      "empty-confirmation-fingerprint-changed",
      "evidence-unit-changed",
      "evidence-panel-changed",
      "evidence-panel-scope-changed",
      "panel-missing",
      "panel-binding-scope-changed",
      "section-missing:section-1",
      "unit-missing",
    ];
    const result = classifyStudioStaleReasons(unexpected);
    expect(result.classification).toBe("unexpected");
    expect(result.unexpectedReasons).toEqual(unexpected);
    expect(result.expectedReasons).toEqual([]);
  });

  it("未知新 reason 一律 unexpected（fail-safe，防分类静默变宽）", () => {
    const result = classifyStudioStaleReasons(["some-future-reason", "another-unknown:x"]);
    expect(result.classification).toBe("unexpected");
    expect(result.unexpectedReasons).toHaveLength(2);
  });

  it("混合：任一非预期即整体 unexpected，双列表各归其位", () => {
    const result = classifyStudioStaleReasons([
      "script-changed",
      "asset-semantic-changed:asset-9",
      "prompt-changed",
    ]);
    expect(result.classification).toBe("unexpected");
    expect(result.expectedReasons).toEqual(["script-changed", "prompt-changed"]);
    expect(result.unexpectedReasons).toEqual(["asset-semantic-changed:asset-9"]);
  });

  it("结果面冻结码格式（code: message）作为输入时落 unexpected——证明两套词表不混用", () => {
    const result = classifyStudioStaleReasons(["input-drift: 冻结包输入已漂移"]);
    expect(result.classification).toBe("unexpected");
  });
});
