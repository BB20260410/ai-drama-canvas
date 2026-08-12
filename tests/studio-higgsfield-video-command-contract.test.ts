import { describe, expect, it } from "vitest";
import {
  STUDIO_CODEX_PUBLIC_COMMAND_SCHEMA_OPTIONS,
  parseStudioCommandRequestForCore,
  parseStudioIdempotentCommandInput,
} from "../src/core/studio-command-runtime.js";

const sha = "a".repeat(64);
const context = `studioctx-v1-${sha}`;

describe("Higgsfield Unlimited 写命令合同", () => {
  it("公开 Codex/MCP 入口只允许排队，调用方自报 observation、回执或远端结论全部失败关闭", () => {
    const unsafeRequests = [
      { command: "claim_studio_higgsfield_connector_request", payload: { requestId: "higgs-request-001", claimantId: "codex-host-001", expectedRevision: 1 } },
      {
        command: "preflight_studio_higgsfield_connector_request",
        payload: {
          requestId: "higgs-request-001",
          claimToken: `higgsclaim-${"a".repeat(32)}`,
          expectedRevision: 2,
          observation: {
            source: "higgsfield-connector",
            observedAt: new Date().toISOString(),
            unlimAvailable: true,
            supportsUnlim: true,
            billingMode: "unlimited",
            zeroCredits: true,
            model: "nano_banana_pro",
            mode: "image_generation",
            durationSeconds: 1,
            resolution: "2k",
            adjustments: [],
            requestBindingFingerprint: sha,
            targetProfileFingerprint: sha,
            workspaceSubjectHash: sha,
          },
        },
      },
      { command: "authorize_studio_higgsfield_connector_request", payload: { requestId: "higgs-request-001", claimToken: `higgsclaim-${"a".repeat(32)}`, expectedRevision: 3, projectContextToken: context } },
      {
        command: "record_studio_higgsfield_connector_submission",
        payload: {
          requestId: "higgs-request-001",
          claimToken: `higgsclaim-${"a".repeat(32)}`,
          expectedRevision: 4,
          submissionNonce: `higgsnonce-${"b".repeat(32)}`,
          remoteJobId: "remote-job-001",
          zeroCreditReceipt: {
            requestBindingFingerprint: sha,
            workspaceSubjectHash: sha,
            billingMode: "unlimited",
            estimatedCredits: 0,
            receiptFingerprint: sha,
          },
        },
      },
      { command: "reconcile_studio_higgsfield_connector_request", payload: { requestId: "higgs-request-001", expectedRevision: 5, resolution: "remote_succeeded", remoteJobId: "remote-job-001", evidenceFingerprint: sha } },
      { command: "prepare_studio_higgsfield_video_generation", payload: { intentId: "video-intent-123", expectedVideoPackageControlFingerprint: sha, projectContextToken: context } },
      { command: "record_studio_higgsfield_video_submission", payload: { runId: "higgsfield-video-123", expectedRevision: 2, remoteJobId: null } },
      {
        command: "attest_studio_higgsfield_connector_capability",
        payload: {
          source: "higgsfield-connector",
          observedAt: new Date().toISOString(),
          unlimAvailable: true,
          supportsUnlim: true,
          model: "nano_banana_pro",
          mode: "image_generation",
          durationSeconds: 1,
          resolution: "2k",
          adjustments: [],
          evidenceFingerprint: sha,
        },
      },
    ];
    const codexCommands = STUDIO_CODEX_PUBLIC_COMMAND_SCHEMA_OPTIONS.map((option) => option.shape.command.value);
    for (const request of unsafeRequests) {
      expect(codexCommands).not.toContain(request.command);
      expect(() => parseStudioCommandRequestForCore(request)).toThrow(/受信任|不符合合同/u);
      expect(() => parseStudioIdempotentCommandInput({
        requestId: `blocked-${request.command}`,
        idempotencyKey: `blocked-key-${request.command}`,
        request,
      }, "codex")).toThrow(/受信任|不符合合同/u);
    }
  });

  it("只保留无外部副作用的排队入口，Codex 与桌面用户使用同一严格合同", () => {
    const envelope = {
      requestId: "higgsfield-enqueue-123", idempotencyKey: "higgsfield-enqueue-key-123",
      request: {
        command: "enqueue_studio_higgsfield_connector_request",
        payload: { kind: "video", intentId: "video-intent-123" },
      },
    };
    expect(parseStudioIdempotentCommandInput(envelope, "codex").request.command).toBe("enqueue_studio_higgsfield_connector_request");
    expect(parseStudioIdempotentCommandInput(envelope, "user").request.command).toBe("enqueue_studio_higgsfield_connector_request");
    expect(parseStudioCommandRequestForCore(envelope.request)?.command)
      .toBe("enqueue_studio_higgsfield_connector_request");
  });
});
