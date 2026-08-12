import { createHash } from "node:crypto";

/**
 * Active Studio 内容身份使用的既有 JSON 规范化规则。
 *
 * 这不是通用序列化器：只服务已冻结为同一字节语义的 Studio owner。数组保序，
 * 对象键按英文 locale 排序，对象中的 undefined 字段省略；其余行为继续交给
 * JSON.stringify（例如数组中的 undefined 会成为 null）。
 */
export function canonicalizeStudioJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeStudioJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, canonicalizeStudioJsonValue(entry)]));
}

export function digestStudioCanonicalJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeStudioJsonValue(value)), "utf8")
    .digest("hex");
}

export function serializeStudioCanonicalJsonPretty(value: unknown): string {
  return `${JSON.stringify(canonicalizeStudioJsonValue(value), null, 2)}\n`;
}
