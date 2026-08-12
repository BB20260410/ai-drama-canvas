import { describe, expect, it } from "vitest";
import {
  HIGGSFIELD_SEEDANCE25_UNLIMITED_PROFILE,
  decideHiggsfieldSubmissionOutcome,
  decideHiggsfieldPrepareState,
  evaluateHiggsfieldUnlimitedCapability,
  isHiggsfieldVideoRunTerminalForNewAttempt,
  projectHiggsfieldTrustedAdapterAvailability,
} from "../src/core/studio-higgsfield-video-generation.js";

const base = {
  source: "higgsfield-connector" as const,
  observedAt: new Date().toISOString(),
  unlimAvailable: true,
  supportsUnlim: true,
  model: "seedance_2_5",
  mode: "omni_reference",
  durationSeconds: 20,
  resolution: "720p",
  adjustments: [],
};

describe("Higgsfield Seedance 2.5 Unlimited 门禁", () => {
  it("只在双门、模型参数和零 adjustments 都匹配时允许一次调用", () => {
    expect(evaluateHiggsfieldUnlimitedCapability(base)).toEqual({ callAllowed: true, blockers: [] });
    expect(HIGGSFIELD_SEEDANCE25_UNLIMITED_PROFILE).toMatchObject({
      outputDurationSeconds: 20,
      narrativeDurationSeconds: 15,
      resolution: "720p",
      useUnlim: true,
      billingMode: "unlimited_only",
      generateAudio: true,
      concurrency: 1,
    });
    expect(decideHiggsfieldPrepareState(null, [])).toEqual({ status: "submit_intent", callAllowed: true });
    expect(decideHiggsfieldPrepareState("submit_intent", [])).toEqual({ status: "submit_intent", callAllowed: false });
    expect(decideHiggsfieldPrepareState("submission_unknown", [])).toEqual({ status: "submission_unknown", callAllowed: false });
  });

  it.each([
    [{ ...base, supportsUnlim: false }, "model-does-not-support-unlim"],
    [{ ...base, unlimAvailable: false }, "unlim-unavailable"],
    [{ ...base, supportsUnlim: undefined }, "model-does-not-support-unlim"],
    [{ ...base, adjustments: ["priority queue"] }, "provider-adjustments-present"],
    [{ ...base, source: "unknown" as never }, "connector-source-invalid"],
    [{ ...base, observedAt: "2020-01-01T00:00:00.000Z" }, "capability-observation-stale"],
  ])("没有可验证的 Unlimited (%o) 必须失败关闭", (observation, blocker) => {
    expect(evaluateHiggsfieldUnlimitedCapability(observation)).toEqual({
      callAllowed: false,
      blockers: expect.arrayContaining([blocker]),
    });
  });

  it("被门禁阻止时落 preflight_blocked，绝不退回 credits 队列", () => {
    expect(decideHiggsfieldPrepareState(null, ["unlim-unavailable"])).toEqual({
      status: "preflight_blocked",
      callAllowed: false,
    });
  });

  it("能力以后恢复时，旧 preflight_blocked 不永久占用 target；unknown 仍然占用并禁止重提", () => {
    expect(isHiggsfieldVideoRunTerminalForNewAttempt("preflight_blocked")).toBe(true);
    expect(isHiggsfieldVideoRunTerminalForNewAttempt("submission_unknown")).toBe(false);
  });

  it("远端返回 adjustments 时保留 jobId 只供对账，绝不进入可自动完成的 submitted", () => {
    expect(decideHiggsfieldSubmissionOutcome({ remoteJobId: "remote-job-123", adjustments: ["priority"] })).toEqual({
      status: "submission_unknown",
      blockers: ["provider-adjustments-reconcile-required"],
    });
  });

  it("历史调用方自报的 true/true capability 不能提升为程序化 Unlimited", () => {
    expect(projectHiggsfieldTrustedAdapterAvailability(base)).toEqual({
      availability: "unavailable",
      capabilityTrust: "legacy_untrusted",
      blockers: ["trusted-connector-adapter-unavailable"],
      availabilityReason: expect.stringMatching(/历史.*自报.*不能证明.*Unlimited.*零扣费/u),
    });
  });
});
