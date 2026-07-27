import { describe, expect, it } from "vitest";
import {
  assertStudioSeedancePromptContract,
  compileStudioSeedancePrompt,
  type CompileStudioSeedancePromptInput,
  type StudioSeedanceObservedState,
  type StudioSeedanceReferenceInput,
} from "../src/core/studio-seedance-prompt-compiler.js";

const SHA_A = "1".repeat(64);
const SHA_B = "2".repeat(64);
const SHA_C = "3".repeat(64);
const SHA_D = "4".repeat(64);

function state(overrides: Partial<StudioSeedanceObservedState> = {}): StudioSeedanceObservedState {
  return {
    costume: "青灰短褂，衣襟完整",
    injury: "无伤",
    heldObject: "右手握铜铃",
    position: "画面左侧石门前",
    facing: "面向画面右侧",
    emotion: "警觉但克制",
    layout: "人物左、石门右、铜灯在后景",
    lighting: "暖灯作主光，月色作冷轮廓光",
    referenceSha256: SHA_A,
    motionVector: "身体前倾，右手将要抬起",
    cameraPhase: "固定机位起步",
    focusState: "焦点锁在人脸与铜铃",
    audioPhase: "风声持续，铜铃尚未响",
    ...overrides,
  };
}

function canonicalReference(overrides: Partial<StudioSeedanceReferenceInput> = {}): StudioSeedanceReferenceInput {
  return {
    exactTag: "@Image 1",
    mediaKind: "image",
    role: "canonical-identity",
    mediaSha256: SHA_A,
    accepted: true,
    transfer: ["角色身份", "脸型", "服装"],
    ignore: ["参考图背景", "参考图文字"],
    assetId: "character-qingdeng-ke",
    authorityVersionId: "version-qingdeng-approved-1",
    authorityFingerprint: SHA_C,
    ...overrides,
  };
}

function acceptedVideoReference(overrides: Partial<StudioSeedanceReferenceInput> = {}): StudioSeedanceReferenceInput {
  return {
    exactTag: "[Video 1]",
    mediaKind: "video",
    role: "accepted-previous-clip",
    mediaSha256: SHA_B,
    accepted: true,
    transfer: ["实际开场站位", "动作相位", "摄影机相位", "环境声相位"],
    ignore: ["身份替换", "服装替换", "后续剧情"],
    sourceClipId: "clip-001",
    reviewId: "review-clip-001-pass",
    reviewFingerprint: SHA_D,
    observedEndState: state({
      position: "石门门槛内半步",
      motionVector: "右脚刚落地，铜铃仍在上摆",
      cameraPhase: "缓推尚未结束",
      audioPhase: "第一声铃音余韵未消",
    }),
    ...overrides,
  };
}

function baseInput(overrides: Partial<CompileStudioSeedancePromptInput> = {}): CompileStudioSeedancePromptInput {
  return {
    projectId: "project-seedance-compiler-test",
    sceneId: "scene-stone-gate-night",
    clipId: "clip-002",
    parentClipId: null,
    unitId: "S1E01-U01",
    panelId: "panel-1",
    durationSeconds: 5,
    continuationMode: "standalone-clip",
    extensionDepth: 0,
    maxChainDepth: 2,
    narrativeJob: "让守门人确认门后传来异响",
    feltIntent: "危险正在靠近，但尚未现形",
    currentAction: "守门人抬起铜铃贴近石门，停住呼吸侧耳辨认",
    endpoint: "铜铃停在耳侧，人物目光锁向门缝",
    motionDelta: "右手抬铃，身体重心缓慢前移，末端静止",
    cameraDelta: "一次克制缓推，末端停稳，不跳轴",
    lightingDelta: "暖灯轻微摇曳，月色方向不变",
    audioDelta: "风声延续，末端加入一次很轻的石后刮擦声",
    plannedStartState: state(),
    plannedEndState: state({
      heldObject: "铜铃停在右耳侧",
      emotion: "屏息警觉",
      motionVector: "动作完成并稳定停住",
      cameraPhase: "缓推结束并停稳",
      audioPhase: "风声持续，石后刮擦声刚结束",
    }),
    completedBeats: [{ id: "beat-open-door", description: "守门人已经推开第一道木门" }],
    currentBeats: [{ id: "beat-hear-scratch", description: "守门人用铜铃贴门辨认异响" }],
    reservedBeats: [{ id: "beat-creature-appears", description: "门后生物现身" }],
    continuityLocks: ["角色身份、脸型与青灰短褂不变", "石门与铜灯空间拓扑不变", "铜铃始终只有一只"],
    allowedChanges: ["右手与铜铃运动", "一次缓推", "暖灯微弱摇曳"],
    negativeLocks: ["禁止新增人物", "禁止文字、字幕、水印和 UI", "禁止镜像、跳轴、错肢和道具克隆"],
    references: [canonicalReference()],
    ...overrides,
  };
}

describe("Studio Seedance prompt compiler", () => {
  it("接受真实逐格裁图 SHA 并写入 fingerprint；拒绝 Authority 冒充", () => {
    const cropSha = "a".repeat(64);
    const withCrop = compileStudioSeedancePrompt(baseInput({ panelCropSha256: cropSha }));
    expect(withCrop.panelCropSha256).toBe(cropSha);
    const again = compileStudioSeedancePrompt(baseInput({ panelCropSha256: cropSha }));
    expect(again.fingerprint).toBe(withCrop.fingerprint);
    expect(assertStudioSeedancePromptContract(withCrop).panelCropSha256).toBe(cropSha);

    const without = compileStudioSeedancePrompt(baseInput());
    expect(without.panelCropSha256).toBeNull();
    expect(without.fingerprint).not.toBe(withCrop.fingerprint);

    expect(() => compileStudioSeedancePrompt(baseInput({ panelCropSha256: SHA_A }))).toThrow(
      /panelCropSha256|不得与 references/,
    );
  });

  it("从 CanonicalAsset 编译确定性的 I2V 当前片段合同", () => {
    const first = compileStudioSeedancePrompt(baseInput());
    const replay = compileStudioSeedancePrompt(baseInput());

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      schemaVersion: 1,
      kind: "studio-seedance-prompt-contract",
      generationMode: "i2v",
      panelCropSha256: null,
      sourcePolicy: "canonical-open",
      reanchorRequired: false,
      activeReferenceTags: ["@Image 1"],
      inactiveReferenceTags: [],
      lineage: { parentClipId: null, requestedExtensionDepth: 0, effectiveExtensionDepth: 0, maxChainDepth: 2 },
    });
    expect(first.prompt).toContain("@Image 1 仅控制：角色身份、脸型、服装");
    expect(first.prompt).toContain("本段只发生：守门人用铜铃贴门辨认异响");
    expect(first.prompt).toContain("已经完成，不得重演：守门人已经推开第一道木门");
    expect(first.prompt).toContain("保留给后续片段，本段不得提前出现：门后生物现身");
    expect(first.negativePrompt).toBe("禁止新增人物；禁止文字、字幕、水印和 UI；禁止镜像、跳轴、错肢和道具克隆");
    expect(assertStudioSeedancePromptContract(first)).toBe(first);
  });

  it("只从已验收 observedEndState 续作，并让来源携带状态、文本只写变化", () => {
    const contract = compileStudioSeedancePrompt(baseInput({
      parentClipId: "clip-001",
      continuationMode: "seamless-continuation",
      extensionDepth: 1,
      plannedStartState: state({ position: "这一计划值不应覆盖真实末态" }),
      references: [canonicalReference(), acceptedVideoReference()],
    }));

    expect(contract).toMatchObject({
      generationMode: "r2v",
      sourcePolicy: "accepted-source-continuation",
      reanchorRequired: false,
      activeReferenceTags: ["@Image 1", "[Video 1]"],
      actualOpeningState: {
        position: "石门门槛内半步",
        motionVector: "右脚刚落地，铜铃仍在上摆",
        cameraPhase: "缓推尚未结束",
      },
    });
    expect(contract.prompt).toContain("从 [Video 1] 的已验收实际末态直接续接");
    expect(contract.prompt).toContain("来源本身携带开场位置、姿态、运动、摄影机、焦点、声音和环境排列，文本只描述下面的新变化");
    expect(contract.prompt).not.toContain("这一计划值不应覆盖真实末态");
  });

  it("超过场景续作深度时显式停用旧输出并回到权威参考", () => {
    const contract = compileStudioSeedancePrompt(baseInput({
      parentClipId: "clip-001",
      continuationMode: "seamless-continuation",
      extensionDepth: 3,
      maxChainDepth: 2,
      references: [canonicalReference(), acceptedVideoReference()],
    }));

    expect(contract).toMatchObject({
      generationMode: "i2v",
      sourcePolicy: "canonical-reanchor",
      reanchorRequired: true,
      activeReferenceTags: ["@Image 1"],
      inactiveReferenceTags: ["[Video 1]"],
      lineage: { requestedExtensionDepth: 3, effectiveExtensionDepth: 0, maxChainDepth: 2 },
    });
    expect(contract.prompt).toContain("达到连续续作深度上限后的计划性重锚镜头");
    expect(contract.prompt).not.toContain("[Video 1]");
    expect(() => compileStudioSeedancePrompt(baseInput({
      maxChainDepth: 3,
    }))).toThrowError(expect.objectContaining({ code: "chain-depth-invalid" }));
  });

  it("拒绝未审批引用、缺 observedEndState 和职责错配", () => {
    expect(() => compileStudioSeedancePrompt(baseInput({
      references: [canonicalReference({ accepted: false })],
    }))).toThrowError(expect.objectContaining({ code: "continuation-not-ready" }));

    expect(() => compileStudioSeedancePrompt(baseInput({
      parentClipId: "clip-001",
      continuationMode: "seamless-continuation",
      extensionDepth: 1,
      references: [canonicalReference(), acceptedVideoReference({ observedEndState: undefined })],
    }))).toThrowError(expect.objectContaining({ code: "continuation-not-ready" }));

    expect(() => compileStudioSeedancePrompt(baseInput({
      references: [canonicalReference({ exactTag: "@Video1" })],
    }))).toThrowError(expect.objectContaining({ code: "reference-conflict" }));
  });

  it("拒绝重复标签、同 SHA 多职责和跨阶段 beat 重叠", () => {
    expect(() => compileStudioSeedancePrompt(baseInput({
      references: [canonicalReference(), canonicalReference({ assetId: "character-other" })],
    }))).toThrowError(expect.objectContaining({ code: "reference-conflict" }));

    expect(() => compileStudioSeedancePrompt(baseInput({
      references: [
        canonicalReference(),
        canonicalReference({ exactTag: "@Image2", assetId: "character-other", mediaSha256: SHA_A }),
      ],
    }))).toThrowError(expect.objectContaining({ code: "reference-conflict" }));

    expect(() => compileStudioSeedancePrompt(baseInput({
      reservedBeats: [{ id: "beat-hear-scratch", description: "同一事件被错误保留到未来" }],
    }))).toThrowError(expect.objectContaining({ code: "beat-scope-conflict" }));
  });

  it("落盘合同任一语义字段被改写后 fingerprint 失败关闭", () => {
    const contract = compileStudioSeedancePrompt(baseInput());
    const tampered = { ...contract, endpoint: "被篡改的终点" };
    expect(() => assertStudioSeedancePromptContract(tampered)).toThrowError(
      expect.objectContaining({ code: "contract-drift" }),
    );
  });
});
