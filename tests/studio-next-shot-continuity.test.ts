import { describe, expect, it } from "vitest";
import {
  buildNextShotContinuitySnapshot,
  nextShotContinuityContinuationGaps,
  NEXT_SHOT_CONTINUITY_SCHEMA_VERSION,
} from "../src/core/studio-next-shot-continuity.js";

function sample() {
  return {
    sourceUnitId: "S1E1-U01",
    sourcePanelId: "G04",
    sourceRawSha256: "a".repeat(64),
    characters: [{
      assetId: "char-dudu",
      costumeState: "锁定蓝灰短毛与颈部铜铃",
      position: "左前景",
      facing: "侧身向右",
      gazeDirection: "看向右侧洞口",
      actionEndPose: "前爪落地",
      nextActionStart: "以前爪落地姿态继续向右侧洞口迈步",
      expression: "警觉",
      injuryState: "无伤",
    }],
    props: [{
      assetId: "prop-bell",
      heldBy: "char-dudu",
      position: "颈部正中",
      physicalState: "完好",
    }],
    scene: {
      layout: "洞口在右，石床在左",
      axisLine: "洞口—石床",
      screenDirection: "角色从画面左向右运动",
      entryExits: ["右侧洞口"],
      lighting: "晨光自右侧斜入",
      timeOfDay: "清晨",
      weather: "晴",
      cutExit: "前爪落地且视线锁住洞口时切出",
    },
    vfx: [{
      vfxId: "meteor-mark",
      description: "额头短小细纹微光",
      intensity: 0.2,
      continuesToNext: false,
    }],
    referenceSha256List: ["b".repeat(64)],
  };
}

describe("下一镜连续性快照 v2", () => {
  it("指纹覆盖所有会影响续镜的结构化字段和真实参考 SHA", () => {
    const base = buildNextShotContinuitySnapshot(sample());
    expect(base.schemaVersion).toBe(NEXT_SHOT_CONTINUITY_SCHEMA_VERSION);
    expect(base.continuityFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    const mutations = [
      { characters: [{ ...sample().characters[0]!, gazeDirection: "看向镜头" }] },
      { characters: [{ ...sample().characters[0]!, actionEndPose: "抬起前爪" }] },
      { characters: [{ ...sample().characters[0]!, costumeState: "颈部铜铃脱落" }] },
      { characters: [{ ...sample().characters[0]!, nextActionStart: "转身向左" }] },
      { characters: [{ ...sample().characters[0]!, injuryState: "右爪擦伤" }] },
      { props: [{ ...sample().props[0]!, position: "地面右侧" }] },
      { scene: { ...sample().scene, axisLine: "石床—洞口" } },
      { scene: { ...sample().scene, screenDirection: "角色从画面右向左运动" } },
      { scene: { ...sample().scene, entryExits: ["左侧裂隙"] } },
      { scene: { ...sample().scene, cutExit: "角色尚未落地时提前切出" } },
      { scene: { ...sample().scene, weather: "雨" } },
      { vfx: [{ ...sample().vfx[0]!, intensity: 0.8 }] },
      { referenceSha256List: ["c".repeat(64)] },
    ];
    for (const mutation of mutations) {
      expect(buildNextShotContinuitySnapshot({ ...sample(), ...mutation }).continuityFingerprint)
        .not.toBe(base.continuityFingerprint);
    }
  });

  it("创建时间不参与内容指纹，同一输入可稳定重算", () => {
    const left = buildNextShotContinuitySnapshot(sample());
    const right = buildNextShotContinuitySnapshot(sample());
    expect(right.continuityFingerprint).toBe(left.continuityFingerprint);
  });

  it("旧 v2 快照可读但缺少逐实体与剪辑字段时明确阻断续作", () => {
    const current = buildNextShotContinuitySnapshot(sample());
    expect(nextShotContinuityContinuationGaps(current)).toEqual([]);
    const legacy = buildNextShotContinuitySnapshot({
      ...sample(),
      characters: sample().characters.map(({ costumeState: _costume, nextActionStart: _next, ...row }) => row),
      props: sample().props.map(({ position: _position, ...row }) => row),
      scene: (({ screenDirection: _direction, cutExit: _cut, ...row }) => row)(sample().scene),
    });
    expect(nextShotContinuityContinuationGaps(legacy)).toEqual([
      "character:char-dudu:costumeState",
      "character:char-dudu:nextActionStart",
      "prop:prop-bell:position",
      "scene:cutExit",
      "scene:screenDirection",
    ]);
  });

  it("深拷贝输入并规范集合顺序，调用方后续修改不会造成内容变而指纹不变", () => {
    const input = sample();
    const snapshot = buildNextShotContinuitySnapshot(input);
    input.characters[0]!.position = "右背景";
    input.scene.entryExits.push("左侧裂隙");
    input.referenceSha256List.push("c".repeat(64));
    expect(snapshot.characters[0]!.position).toBe("左前景");
    expect(snapshot.scene.entryExits).toEqual(["右侧洞口"]);
    expect(snapshot.referenceSha256List).toEqual(["b".repeat(64)]);

    const reversed = sample();
    reversed.characters.push({
      ...reversed.characters[0]!,
      assetId: "char-ayi",
      position: "右前景",
    });
    const forward = buildNextShotContinuitySnapshot(reversed);
    const backward = buildNextShotContinuitySnapshot({
      ...reversed,
      characters: [...reversed.characters].reverse(),
      referenceSha256List: [...reversed.referenceSha256List].reverse(),
    });
    expect(backward.continuityFingerprint).toBe(forward.continuityFingerprint);
  });

  it("拒绝非法 SHA 与越界 VFX 强度", () => {
    expect(() => buildNextShotContinuitySnapshot({
      ...sample(),
      sourceRawSha256: "not-a-sha",
    })).toThrow(/sourceRawSha256/u);
    expect(() => buildNextShotContinuitySnapshot({
      ...sample(),
      vfx: [{ ...sample().vfx[0]!, intensity: 1.1 }],
    })).toThrow(/intensity/u);
  });
});
