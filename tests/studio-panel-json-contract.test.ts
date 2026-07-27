import { describe, expect, it } from "vitest";
import { validateStudioPanelJsonArray } from "../src/core/studio-panel-json-contract.js";

describe("validateStudioPanelJsonArray", () => {
  it("2 格合法 instructions 通过", () => {
    const r = validateStudioPanelJsonArray([
      {
        panel: 1,
        instructions: "夜间室内，男角色近景，侧光，表情紧张",
        speech: "谁？",
      },
      {
        panel: 2,
        instructions: "室外远景，街灯，女人跑向巷口",
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.panels).toHaveLength(2);
  });

  it("格数越界 / 空 instructions / 非连续 panel fail-close", () => {
    expect(validateStudioPanelJsonArray([{ panel: 1, instructions: "足够长的说明文字凑字数啊" }]).ok).toBe(
      false,
    );
    expect(
      validateStudioPanelJsonArray([
        { panel: 1, instructions: "" },
        { panel: 2, instructions: "夜间室内男角色近景光线" },
      ]).ok,
    ).toBe(false);
    expect(
      validateStudioPanelJsonArray([
        { panel: 2, instructions: "夜间室内男角色近景光线足够" },
        { panel: 1, instructions: "室外远景街灯女人跑向巷口" },
      ]).ok,
    ).toBe(false);
  });
});
