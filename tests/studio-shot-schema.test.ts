import { describe, expect, it } from "vitest";
import { validateStudioShotDraft } from "../src/core/studio-shot-schema.js";

describe("validateStudioShotDraft", () => {
  it("合法景别与时长通过", () => {
    const r = validateStudioShotDraft({
      shotType: "close_up",
      cameraAngle: "eye_level",
      cameraMovement: "static",
      durationSeconds: 3,
      content: "插入镜头",
    });
    expect(r.ok).toBe(true);
  });

  it("时长超过 15s 拒绝", () => {
    const r = validateStudioShotDraft({ durationSeconds: 20 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/15/);
  });

  it("非法 shotType 拒绝", () => {
    const r = validateStudioShotDraft({ shotType: "whatever" });
    expect(r.ok).toBe(false);
  });
});
