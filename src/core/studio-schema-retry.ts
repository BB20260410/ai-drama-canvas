/**
 * P1.9 schema 校验失败回喂（Instructor 式）：错误消息可再喂模型。
 */

export type SchemaFieldRule = {
  key: string;
  required?: boolean;
  type?: "string" | "number" | "array";
  minLength?: number;
};

export type SchemaRetryResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: string[]; refeedMessage: string };

export function validateWithRefeed(
  value: unknown,
  rules: SchemaFieldRule[],
): SchemaRetryResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      errors: ["根对象必须是 object"],
      refeedMessage: "校验失败：请返回 JSON 对象。错误：根对象必须是 object",
    };
  }
  const obj = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const rule of rules) {
    const v = obj[rule.key];
    if (rule.required && (v === undefined || v === null || v === "")) {
      errors.push(`缺少必填字段 ${rule.key}`);
      continue;
    }
    if (v === undefined || v === null) continue;
    if (rule.type === "string" && typeof v !== "string") errors.push(`${rule.key} 须为 string`);
    if (rule.type === "number" && typeof v !== "number") errors.push(`${rule.key} 须为 number`);
    if (rule.type === "array" && !Array.isArray(v)) errors.push(`${rule.key} 须为 array`);
    if (rule.type === "string" && typeof v === "string" && rule.minLength && v.trim().length < rule.minLength) {
      errors.push(`${rule.key} 长度至少 ${rule.minLength}`);
    }
  }
  if (errors.length) {
    return {
      ok: false,
      errors,
      refeedMessage: `校验失败：请修正后仅返回 JSON。错误：${errors.join("；")}`,
    };
  }
  return { ok: true, value: obj };
}
