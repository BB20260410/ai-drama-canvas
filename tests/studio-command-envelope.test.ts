import { describe, expect, it } from "vitest";
import type { StudioPublicCommandRequest } from "../src/core/studio-command-runtime.js";
import { createStudioCommandEnvelope } from "../src/renderer/src/studio-command-envelope.js";

describe("Studio UI command envelope", () => {
  it("同一 revision token 与语义重试复用幂等键，但每次 IPC 有独立 requestId", async () => {
    const request: StudioPublicCommandRequest = {
      command: "resolve_studio_entity_proposal",
      payload: {
        unitId: "unit-001",
        panelId: "panel-01",
        proposalId: "proposal-ahang",
        decision: "accept",
        selectedAssetId: "character-ahang",
        presence: "required",
        role: "画面主体",
        expectedRevisionToken: "a".repeat(64),
        reviewer: "user",
      },
    };
    const first = await createStudioCommandEnvelope(request);
    const retry = await createStudioCommandEnvelope(structuredClone(request));
    expect(first.requestId).not.toBe(retry.requestId);
    expect(first.idempotencyKey).toBe(retry.idempotencyKey);
    expect(first.idempotencyKey).toMatch(/^ui-studio-resolve_studio_entity_proposal-[a-f0-9]{48}$/u);

    const revised = await createStudioCommandEnvelope({
      ...request,
      payload: { ...request.payload, expectedRevisionToken: "b".repeat(64) },
    });
    expect(revised.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});
