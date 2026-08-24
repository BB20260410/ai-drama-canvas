/**
 * 把值编成可嵌入 JS 源码的字面量。
 * JSON.stringify 单独不够：U+2028 / U+2029 在 JS 字符串里是行终止符。
 */
export function toJsLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029")
    .replace(/</gu, "\\u003c");
}
