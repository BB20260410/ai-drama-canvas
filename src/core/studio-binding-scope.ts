/**
 * 属集校验：绑定的角色/场景必须属于当前单元允许集（对照火宝 validateStoryboardBindings）。
 */

export type BindingScopeInput = {
  unitId: string;
  allowedCharacterIds: string[];
  allowedSceneIds: string[];
  bindCharacterIds?: string[];
  bindSceneIds?: string[];
};

export type BindingScopeResult =
  | { ok: true }
  | { ok: false; code: "out-of-scope" | "empty-unit"; reason: string; invalidIds: string[] };

export function validateBindingScope(input: BindingScopeInput): BindingScopeResult {
  const unitId = input.unitId?.trim() ?? "";
  if (!unitId) {
    return { ok: false, code: "empty-unit", reason: "unitId 不能为空。", invalidIds: [] };
  }
  const charSet = new Set((input.allowedCharacterIds ?? []).map((x) => x.trim()).filter(Boolean));
  const sceneSet = new Set((input.allowedSceneIds ?? []).map((x) => x.trim()).filter(Boolean));
  const invalid: string[] = [];
  for (const id of input.bindCharacterIds ?? []) {
    const t = id?.trim();
    if (t && !charSet.has(t)) invalid.push(`character:${t}`);
  }
  for (const id of input.bindSceneIds ?? []) {
    const t = id?.trim();
    if (t && !sceneSet.has(t)) invalid.push(`scene:${t}`);
  }
  if (invalid.length) {
    return {
      ok: false,
      code: "out-of-scope",
      reason: `以下绑定不属于单元 ${unitId}：${invalid.join(", ")}`,
      invalidIds: invalid,
    };
  }
  return { ok: true };
}

/** 失败即抛（供 command 路径 fail-close） */
export function assertBindingScope(input: BindingScopeInput): void {
  const r = validateBindingScope(input);
  if (!r.ok) throw new Error(r.reason);
}
