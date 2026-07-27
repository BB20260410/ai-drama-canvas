import { describe, expect, it } from "vitest";
import {
  STUDIO_ANY_ACTOR_PUBLIC_COMMAND_SCHEMA_OPTIONS,
  STUDIO_CODEX_PUBLIC_COMMAND_SCHEMA_OPTIONS,
  STUDIO_INTERNAL_COMMAND_NAMES,
  STUDIO_PUBLIC_COMMAND_NAMES,
  STUDIO_USER_PUBLIC_COMMAND_SCHEMA_OPTIONS,
  isStudioCommandName,
  isStudioInternalCommandName,
  isStudioPublicCommandName,
  parseStudioCommandRequestForCore,
  parseStudioIdempotentCommandInput,
  studioInternalCommandRequestSchema,
} from "../src/core/studio-command-runtime.js";

function optionNames(options: typeof STUDIO_ANY_ACTOR_PUBLIC_COMMAND_SCHEMA_OPTIONS): string[] {
  return options.map((option) => option.shape.command.value);
}

const reviewerEnvelope = (command: "confirm_studio_panel_empty", reviewer: "user" | "codex") => ({
  requestId: `runtime-${reviewer}-request-0001`,
  idempotencyKey: `runtime-${reviewer}-key-0001`,
  request: {
    command,
    payload: {
      unitId: "unit-001",
      panelId: "panel-001",
      expectedRevisionToken: "a".repeat(64),
      reviewer,
      note: "显式人工裁决。",
    },
  },
});

describe("Studio 命令运行时唯一 schema owner", () => {
  it("46 条 public 与 2 条 internal 精确分离，三种 actor 由同一名单派生", () => {
    expect(STUDIO_PUBLIC_COMMAND_NAMES).toHaveLength(46);
    expect(STUDIO_INTERNAL_COMMAND_NAMES).toEqual(["initialize_material_studio", "initialize_studio_production"]);
    expect(new Set(STUDIO_PUBLIC_COMMAND_NAMES).size).toBe(46);
    expect(STUDIO_PUBLIC_COMMAND_NAMES.some((name) => STUDIO_INTERNAL_COMMAND_NAMES.includes(name as never))).toBe(false);
    expect(optionNames(STUDIO_ANY_ACTOR_PUBLIC_COMMAND_SCHEMA_OPTIONS)).toEqual([...STUDIO_PUBLIC_COMMAND_NAMES]);
    expect(optionNames(STUDIO_CODEX_PUBLIC_COMMAND_SCHEMA_OPTIONS as typeof STUDIO_ANY_ACTOR_PUBLIC_COMMAND_SCHEMA_OPTIONS)).toEqual([...STUDIO_PUBLIC_COMMAND_NAMES]);
    expect(optionNames(STUDIO_USER_PUBLIC_COMMAND_SCHEMA_OPTIONS as typeof STUDIO_ANY_ACTOR_PUBLIC_COMMAND_SCHEMA_OPTIONS)).toEqual([...STUDIO_PUBLIC_COMMAND_NAMES]);
    expect(STUDIO_PUBLIC_COMMAND_NAMES.every(isStudioPublicCommandName)).toBe(true);
    expect(STUDIO_INTERNAL_COMMAND_NAMES.every(isStudioInternalCommandName)).toBe(true);
    expect([...STUDIO_PUBLIC_COMMAND_NAMES, ...STUDIO_INTERNAL_COMMAND_NAMES].every(isStudioCommandName)).toBe(true);
    expect(isStudioCommandName("stage_dudu_readonly_managed_project")).toBe(false);
  });

  it("覆盖缺口登记：第 40 条命令 reconcile_dudu_readonly_historical_passes 在 public 名单内", () => {
    expect(STUDIO_PUBLIC_COMMAND_NAMES).toContain("reconcile_dudu_readonly_historical_passes");
  });

  it("本地创作单元物化只接受当前预览指纹与最多三个唯一候选", () => {
    const valid = {
      command: "materialize_local_creative_production_units" as const,
      payload: {
        expectedPreviewFingerprint: "a".repeat(64),
        expectedSourceFingerprint: "b".repeat(64),
        candidateIds: ["W00", "W01"],
        scopeId: "world-prologue",
        adapterKind: "dudu-world-prologue-v1" as const,
      },
    };
    expect(parseStudioCommandRequestForCore(valid)).toEqual(valid);
    for (const payload of [
      { ...valid.payload, candidateIds: [] },
      { ...valid.payload, candidateIds: ["W00", "W00"] },
      { ...valid.payload, candidateIds: ["W00", "W01", "W02", "W03"] },
      { ...valid.payload, expectedPreviewFingerprint: "bad" },
      { ...valid.payload, adapterKind: "guess-by-filename" },
      { ...valid.payload, operationId: "forbidden-private-field" },
    ]) {
      expect(() => parseStudioCommandRequestForCore({ ...valid, payload }))
        .toThrow("载荷不符合合同");
    }
  });

  it("studio-review 视频包 prepare 强制绑定完整 managed-source CAS，历史导入禁止伪造该来源", () => {
    const managed = {
      adapterKind: "managed-evidence-v1" as const,
      reviewId: "review-video-001",
      expectedSourceFingerprint: "1".repeat(64),
      expectedReviewFingerprint: "2".repeat(64),
      expectedPackFingerprint: "3".repeat(64),
      expectedUnitSnapshotFingerprint: "4".repeat(64),
      expectedObservationControlFingerprint: "5".repeat(64),
      expectedObservationHeadRevision: 0,
      expectedObservationStatus: "missing" as const,
      expectedObservationHeadId: null,
      expectedObservationHeadFingerprint: null,
      expectedObservationEvidenceSha256: null,
    };
    const studioReview = {
      command: "prepare_studio_video_package_export" as const,
      payload: {
        authority: { kind: "studio-review" as const, reviewId: managed.reviewId },
        expectedRevision: 1,
        expectedControlFingerprint: "6".repeat(64),
        expectedManagedSource: managed,
      },
    };
    expect(parseStudioCommandRequestForCore(studioReview)).toEqual(studioReview);
    expect(() => parseStudioCommandRequestForCore({
      ...studioReview,
      payload: {
        authority: studioReview.payload.authority,
        expectedRevision: 1,
        expectedControlFingerprint: "6".repeat(64),
      },
    })).toThrow("载荷不符合合同");
    expect(() => parseStudioCommandRequestForCore({
      ...studioReview,
      payload: {
        ...studioReview.payload,
        authority: { kind: "historical-import", packId: "pack-video-001" },
      },
    })).toThrow("载荷不符合合同");
  });

  it("实际末态观察严格绑定 actor、PASS 结果 SHA，且拒绝 operationId 注入", () => {
    const observedState = {
      costume: "实际服装状态。",
      injury: "实际伤势状态。",
      heldObject: "实际持物状态。",
      position: "实际站位。",
      facing: "实际朝向。",
      emotion: "实际情绪。",
      layout: "实际场面布局。",
      lighting: "实际光线。",
      referenceSha256: "8".repeat(64),
      motionVector: "实际动作余势。",
      cameraPhase: "实际镜头阶段。",
      focusState: "实际焦点状态。",
      audioPhase: "实际声音阶段。",
    };
    const valid = {
      requestId: "runtime-observation-request-0001",
      idempotencyKey: "runtime-observation-key-0001",
      request: {
        command: "submit_studio_post_result_observation" as const,
        payload: {
          generationRunId: "run-actual-end-001",
          expectedHeadRevision: 0,
          expectedReviewId: "review-pass-001",
          expectedReviewFingerprint: "1".repeat(64),
          rawResultId: "raw-result-001",
          rawSha256: "3".repeat(64),
          labeledResultId: "labeled-result-001",
          labeledSha256: "4".repeat(64),
          packId: "pack-001",
          packFingerprint: "5".repeat(64),
          plannedContinuityFingerprint: "6".repeat(64),
          evidenceKind: "terminal-panel-crop" as const,
          evidenceSha256: "8".repeat(64),
          terminalPanelId: "panel-terminal-001",
          observedState,
          observedAvailability: {
            costume: "observed" as const,
            injury: "observed" as const,
            heldObject: "observed" as const,
            position: "observed" as const,
            facing: "observed" as const,
            emotion: "observed" as const,
            layout: "observed" as const,
            lighting: "observed" as const,
            motionVector: "unknown" as const,
            cameraPhase: "unknown" as const,
            focusState: "observed" as const,
            audioPhase: "not-applicable" as const,
          },
          observer: "user" as const,
          note: "用户从当前 PASS 原图观察到的实际末态。",
        },
      },
    };
    expect(parseStudioIdempotentCommandInput(valid, "user").request).toEqual(valid.request);
    const { terminalPanelId: _terminalPanelId, ...reviewedVideoPayload } = valid.request.payload;
    expect(parseStudioCommandRequestForCore({
      ...valid.request,
      payload: {
        ...reviewedVideoPayload,
        evidenceKind: "reviewed-video",
      },
    })).toMatchObject({
      command: "submit_studio_post_result_observation",
      payload: { evidenceKind: "reviewed-video" },
    });
    expect(() => parseStudioIdempotentCommandInput(valid, "codex")).toThrow("信封不符合合同");
    expect(() => parseStudioCommandRequestForCore({
      ...valid.request,
      payload: { ...valid.request.payload, operationId: "forged-private-operation" },
    })).toThrow(/operationId/u);
    expect(() => parseStudioCommandRequestForCore({
      ...valid.request,
      payload: {
        ...valid.request.payload,
        observedState: { ...observedState, referenceSha256: "7".repeat(64) },
      },
    })).toThrow(/referenceSha256/u);
    expect(() => parseStudioCommandRequestForCore({
      ...valid.request,
      payload: {
        ...valid.request.payload,
        evidenceSha256: "3".repeat(64),
        observedState: { ...observedState, referenceSha256: "3".repeat(64) },
      },
    })).toThrow(/evidenceSha256/u);
    expect(() => parseStudioCommandRequestForCore({
      ...valid.request,
      payload: {
        ...valid.request.payload,
        evidenceKind: "reviewed-video",
      },
    })).toThrow(/terminalPanelId/u);
    expect(() => parseStudioCommandRequestForCore({
      ...valid.request,
      payload: {
        ...valid.request.payload,
        observedAvailability: {
          ...valid.request.payload.observedAvailability,
          cameraPhase: "assumed",
        },
      },
    })).toThrow(/observedAvailability/u);
    expect(() => parseStudioCommandRequestForCore({
      ...valid.request,
      payload: {
        ...valid.request.payload,
        observedState: { ...observedState, unknownState: "forbidden" },
      },
    })).toThrow(/unknownState/u);
  });

  it("四媒体时间线绑定命令严格校验 revision、时码、role 与 SHA", () => {
    const valid = {
      command: "attach_studio_multimedia_timeline_media" as const,
      payload: {
        unitId: "S1E02-U01",
        unitRevision: 1,
        expectedUnitFingerprint: "a".repeat(64),
        slotId: "dialogue-main",
        expectedHeadRevision: 0,
        panelIndex: 1,
        startSeconds: 0,
        endSeconds: 3.5,
        role: "dialogue" as const,
        mediaSha256: "b".repeat(64),
        note: "对白轨。",
      },
    };
    expect(parseStudioCommandRequestForCore(valid)).toEqual(valid);
    for (const payload of [
      { ...valid.payload, endSeconds: 0 },
      { ...valid.payload, expectedHeadRevision: -1 },
      { ...valid.payload, role: "subtitle" },
      { ...valid.payload, mediaSha256: "bad" },
      { ...valid.payload, operationId: "forbidden-private-field" },
    ]) {
      expect(() => parseStudioCommandRequestForCore({ ...valid, payload }))
        .toThrow("载荷不符合合同");
    }
  });

  it("desktop 与 MCP reviewer 身份互斥，Core 最终闸口接受两种真实 actor", () => {
    const user = reviewerEnvelope("confirm_studio_panel_empty", "user");
    const codex = reviewerEnvelope("confirm_studio_panel_empty", "codex");
    expect(parseStudioIdempotentCommandInput(user, "user").request).toEqual(user.request);
    expect(parseStudioIdempotentCommandInput(codex, "codex").request).toEqual(codex.request);
    expect(() => parseStudioIdempotentCommandInput(user, "codex")).toThrow("信封不符合合同");
    expect(() => parseStudioIdempotentCommandInput(codex, "user")).toThrow("信封不符合合同");
    expect(parseStudioCommandRequestForCore(user.request)).toEqual(user.request);
    expect(parseStudioCommandRequestForCore(codex.request)).toEqual(codex.request);
  });

  it("public surface 拒绝内部初始化，内部命令只允许严格空 payload", () => {
    for (const command of STUDIO_INTERNAL_COMMAND_NAMES) {
      expect(() => parseStudioIdempotentCommandInput({
        requestId: "runtime-internal-request",
        idempotencyKey: "runtime-internal-key",
        request: { command, payload: {} },
      }, "user")).toThrow("信封不符合合同");
      expect(studioInternalCommandRequestSchema.parse({ command, payload: {} })).toEqual({ command, payload: {} });
      expect(() => parseStudioCommandRequestForCore({ command, payload: { unexpected: true } })).toThrow("内部命令");
    }
  });

  it("缺字段、错 provider、额外字段与非法 revision 均在运行时失败关闭", () => {
    expect(() => parseStudioCommandRequestForCore({
      command: "create_studio_asset",
      payload: { category: "character", expectedRevision: 0 },
    })).toThrow("载荷不符合合同");
    expect(() => parseStudioCommandRequestForCore({
      command: "dispatch_studio_generation_pack",
      payload: {
        packId: "pack-001",
        packFingerprint: "a".repeat(64),
        generationRunId: "run-001",
        provider: "browser",
        expectedRevision: 1,
      },
    })).toThrow("provider");
    expect(() => parseStudioCommandRequestForCore({
      command: "create_studio_asset",
      payload: { category: "character", name: "角色", expectedRevision: 0, operationId: "forbidden" },
    })).toThrow("Unrecognized key");
    expect(() => parseStudioCommandRequestForCore({
      command: "freeze_studio_generation_pack",
      payload: { unitId: "unit-001", panelId: "panel-001", expectedRevision: 0 },
    })).toThrow("expectedRevision");
    expect(() => parseStudioCommandRequestForCore({
      command: "create_studio_asset",
      payload: { category: "character", name: "角色", expectedRevision: 0 },
      injected: true,
    })).toThrow("Unrecognized key");
    expect(() => parseStudioCommandRequestForCore({
      command: "initialize_material_studio",
      payload: {},
      injected: true,
    })).toThrow("内部命令");
  });

  it("owner abandon 要求两个风险确认、严格证据与 revision=0", () => {
    const valid = {
      command: "abandon_studio_generation_unknown" as const,
      payload: {
        callId: "studio-imagegen-call-owner-abandon-001",
        generationRunId: "studio-generation-run-owner-abandon-001",
        projectContextToken: `studioctx-v1-${"a".repeat(64)}`,
        evidenceReference: "owner-confirmation-20260723",
        evidenceFingerprint: "b".repeat(64),
        reason: "用户接受远端调用仍可能存在，并要求封存旧 run。",
        acknowledgeRemoteMayExist: true as const,
        acknowledgeLateResultWillBeRejected: true as const,
        expectedRevision: 0 as const,
      },
    };
    expect(parseStudioCommandRequestForCore(valid)).toEqual(valid);
    for (const payload of [
      { ...valid.payload, acknowledgeRemoteMayExist: false },
      { ...valid.payload, acknowledgeLateResultWillBeRejected: false },
      { ...valid.payload, expectedRevision: 1 },
      { ...valid.payload, reason: "太短" },
      { ...valid.payload, evidenceFingerprint: "not-a-sha" },
      { ...valid.payload, injected: true },
    ]) {
      expect(() => parseStudioCommandRequestForCore({ ...valid, payload })).toThrow("载荷不符合合同");
    }
  });

  it("detached owner abandon 要求 observation CAS、用户原文 SHA 与三项风险确认", () => {
    const valid = {
      command: "abandon_studio_detached_generation_unknown" as const,
      payload: {
        observationId: "studio-detached-unknown-owner-abandon-001",
        expectedObservationFingerprint: "a".repeat(64),
        projectContextToken: `studioctx-v1-${"b".repeat(64)}`,
        authorizationEvidenceReference: "codex-user-message-20260723",
        authorizationText: "接受风险并恢复新的正式 run；旧候选永不导入或复用。",
        authorizationTextSha256: "c".repeat(64),
        reason: "用户明确接受重复调用风险，要求恢复新的正式 run。",
        acknowledgeRemoteGenerationMayExist: true as const,
        acknowledgeDetachedCandidateWillNeverBeImportedOrReused: true as const,
        acknowledgeFreshFormalRunMayDuplicateRemoteGeneration: true as const,
        expectedRevision: 0 as const,
      },
    };
    expect(parseStudioCommandRequestForCore(valid)).toEqual(valid);
    for (const payload of [
      { ...valid.payload, expectedObservationFingerprint: "bad" },
      { ...valid.payload, authorizationText: "太短" },
      { ...valid.payload, acknowledgeRemoteGenerationMayExist: false },
      { ...valid.payload, acknowledgeDetachedCandidateWillNeverBeImportedOrReused: false },
      { ...valid.payload, acknowledgeFreshFormalRunMayDuplicateRemoteGeneration: false },
      { ...valid.payload, expectedRevision: 1 },
      { ...valid.payload, activeContext: { projectId: "forbidden-self-report" } },
    ]) {
      expect(() => parseStudioCommandRequestForCore({ ...valid, payload })).toThrow("载荷不符合合同");
    }
  });

  it("context rebind 要求完整不可变身份、双确认与 revision=0", () => {
    const valid = {
      command: "rebind_studio_imagegen_call_context" as const,
      payload: {
        callId: "studio-imagegen-call-context-rebind-001",
        generationRunId: "studio-generation-run-context-rebind-001",
        packId: "studio-generation-pack-context-rebind-001",
        packFingerprint: "1".repeat(64),
        inputFingerprint: "2".repeat(64),
        candidateSha256: "3".repeat(64),
        receiptSha256: "4".repeat(64),
        projectContextToken: `studioctx-v1-${"5".repeat(64)}`,
        evidenceReference: "user-context-rebind-authority-20260723",
        evidenceFingerprint: "6".repeat(64),
        reason: "模型调用完成后仅本地构建身份发生变化，授权同一调用在当前上下文写回。",
        acknowledgeBuildChangedAfterInvocation: true as const,
        acknowledgeNoSecondModelCall: true as const,
        expectedRevision: 0 as const,
      },
    };
    expect(parseStudioCommandRequestForCore(valid)).toEqual(valid);
    for (const payload of [
      { ...valid.payload, acknowledgeBuildChangedAfterInvocation: false },
      { ...valid.payload, acknowledgeNoSecondModelCall: false },
      { ...valid.payload, expectedRevision: 1 },
      { ...valid.payload, candidateSha256: "not-a-sha" },
      { ...valid.payload, receiptSha256: "not-a-sha" },
      { ...valid.payload, reason: "太短" },
      { ...valid.payload, injected: true },
    ]) {
      expect(() => parseStudioCommandRequestForCore({ ...valid, payload })).toThrow("载荷不符合合同");
    }
  });
});
