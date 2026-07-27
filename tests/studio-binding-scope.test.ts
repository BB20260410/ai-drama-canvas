import { describe, expect, it } from "vitest";
import { assertBindingScope, validateBindingScope } from "../src/core/studio-binding-scope.js";

describe("validateBindingScope", () => {
  it("属集内绑定通过", () => {
    const r = validateBindingScope({
      unitId: "S1E01-U01",
      allowedCharacterIds: ["character-r07-dudu", "character-r01-adult-ahang"],
      allowedSceneIds: ["scene-a"],
      bindCharacterIds: ["character-r07-dudu"],
      bindSceneIds: ["scene-a"],
    });
    expect(r).toEqual({ ok: true });
  });

  it("跨单元角色必拒", () => {
    const r = validateBindingScope({
      unitId: "S1E01-U01",
      allowedCharacterIds: ["character-r07-dudu"],
      allowedSceneIds: [],
      bindCharacterIds: ["character-outsider"],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("out-of-scope");
    expect(r.invalidIds).toContain("character:character-outsider");
  });

  it("assert 抛错", () => {
    expect(() =>
      assertBindingScope({
        unitId: "u",
        allowedCharacterIds: [],
        allowedSceneIds: [],
        bindSceneIds: ["scene-x"],
      }),
    ).toThrow(/不属于单元/);
  });
});
