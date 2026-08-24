import { describe, expect, it } from "vitest";
import { toJsLiteral } from "../src/core/js-code-literal.js";
import { xmlVisibleText } from "../src/core/xml-visible-text.js";

describe("js-code-literal / xml-visible-text", () => {
  it("toJsLiteral 转义 U+2028/U+2029 和 <，可安全 eval 回原值", () => {
    const payload = `line\u2028break\u2029and <script>`;
    const literal = toJsLiteral(payload);
    expect(literal).not.toContain("\u2028");
    expect(literal).not.toContain("\u2029");
    expect(literal).not.toContain("<");
    expect(literal).toContain("\\u2028");
    expect(literal).toContain("\\u2029");
    expect(literal).toContain("\\u003c");
    expect(Function(`return ${literal};`)()).toBe(payload);
  });

  it("xmlVisibleText 循环剥标签后只留可见文本", () => {
    expect(xmlVisibleText("<t>hello</t>")).toBe("hello");
    expect(xmlVisibleText("<g><text>中文</text></g>")).toBe("中文");
    expect(xmlVisibleText("<scr<script>ipt>x</script>")).toBe("ipt>x");
  });
});
