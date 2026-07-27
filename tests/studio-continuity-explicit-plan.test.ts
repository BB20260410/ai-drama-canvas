import { describe, expect, it } from "vitest";
import {
  assertNineFieldCoverage,
  classifyContinuitySubject,
  planContinuityFieldsForSubject,
} from "../src/core/studio-continuity-explicit-plan.js";
import { STUDIO_CONTINUITY_FIELDS } from "../src/core/studio-continuity.js";

const A01_SHA = "df8f96ef280ecd01bc51a48ea77cf80bf1babbd8377dd937ec9cc1ba9b716771";
/** 当前豆姐完整黄金面具唯一权威 SHA；旧 Binding 应因语义变化失效。 */
const D01_SHA = "02e9438ecee038f7d14860da37cb315bf358db4a26fa224e342eee5b592b55a9";
/** 真实 Binding role（含「能量体融合」否定句，曾误触发 A01 分支） */
const REAL_D01_ROLE =
  "锁定完整、闭口、刚性的一整张黄金面具；只允许金纹或眼窝内光低幅变化，不得半面、裂开、熔化、口型、眼睑或与人物、犬身、能量体融合。";

describe("studio-continuity-explicit-plan", () => {
  it("classifies only by assetId, never by role text", () => {
    expect(classifyContinuitySubject("character-a01-energy")).toBe("a01-energy");
    expect(classifyContinuitySubject("prop-d01-golden-mask")).toBe("d01-golden-mask");
    // 即便 category 是 character，也不能把 D01 id 判成 A01
    expect(classifyContinuitySubject("prop-d01-golden-mask", "prop")).toBe("d01-golden-mask");
  });

  it("plans all nine fields for A01 with hardlock N/A and authority SHA", () => {
    const plans = planContinuityFieldsForSubject({
      assetId: "character-a01-energy",
      category: "character",
      role: "无面具能量体",
      mediaSha256: A01_SHA,
      visualAction: "河心蓝白能量轮廓与金面分离悬浮",
      panelIndex: 1,
      startMilliseconds: 0,
      endMilliseconds: 2500,
    });
    assertNineFieldCoverage(plans);
    expect(plans.map((p) => p.field)).toEqual([...STUDIO_CONTINUITY_FIELDS]);
    const ref = plans.find((p) => p.field === "referenceSha256")!;
    expect(ref.state).toMatchObject({ status: "resolved", value: A01_SHA });
    expect(plans.find((p) => p.field === "costume")!.state.status).toBe("not-applicable");
    expect(plans.find((p) => p.field === "emotion")!.state.status).toBe("not-applicable");
    expect(plans.find((p) => p.field === "position")!.state.status).toBe("resolved");
  });

  it("plans D01 with real Binding role containing 能量体融合 without A01 mis-route", () => {
    const plans = planContinuityFieldsForSubject({
      assetId: "prop-d01-golden-mask",
      category: "prop",
      role: REAL_D01_ROLE,
      mediaSha256: D01_SHA,
      visualAction: "完整金面极特写",
      panelIndex: 1,
      startMilliseconds: 0,
      endMilliseconds: 2500,
    });
    assertNineFieldCoverage(plans);

    const costume = plans.find((p) => p.field === "costume")!;
    expect(costume.state.status).toBe("not-applicable");
    if (costume.state.status === "not-applicable") {
      expect(costume.state.reason).toMatch(/D01/);
      expect(costume.state.reason).not.toMatch(/A01 为无面部/);
      expect(costume.state.provenance.some((p) => p.kind === "hardlock-d01")).toBe(true);
    }

    const position = plans.find((p) => p.field === "position")!;
    expect(position.state.status).toBe("resolved");
    if (position.state.status === "resolved") {
      expect(position.state.value).toMatch(/完整金面/);
      expect(position.state.value).not.toMatch(/A01 按轴线/);
      expect(position.state.value).not.toMatch(/河心\/光壳区域/);
    }

    const layout = plans.find((p) => p.field === "layout")!;
    expect(layout.state.status).toBe("resolved");
    if (layout.state.status === "resolved") {
      expect(layout.state.value).toMatch(/闭口刚性金面/);
      expect(layout.state.provenance.some((p) => p.kind === "hardlock-d01")).toBe(true);
    }

    expect(plans.find((p) => p.field === "emotion")!.state.status).toBe("not-applicable");
    expect(plans.find((p) => p.field === "referenceSha256")!.state).toMatchObject({
      status: "resolved",
      value: D01_SHA,
    });
  });

  it("rejects invalid reference sha", () => {
    expect(() =>
      planContinuityFieldsForSubject({
        assetId: "character-a01-energy",
        category: "character",
        role: "x",
        mediaSha256: "not-a-sha",
        visualAction: "x",
        panelIndex: 1,
        startMilliseconds: 0,
        endMilliseconds: 2500,
      }),
    ).toThrow(/mediaSha256/);
  });
});
