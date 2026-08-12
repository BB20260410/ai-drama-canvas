import { RejectedCommandFailure } from "./command-outcome.js";

export function deterministicStudioTimelineRejection(request: {
  payload: { role: string; panelIndex?: number };
}): string | undefined {
  if (request.payload.role === "storyboard" && request.payload.panelIndex === undefined) {
    return "storyboard 绑定必须显式提供 panelIndex。";
  }
  return undefined;
}

export function rejectP30OrchestrationCommand(input: {
  entityType: "dudu_readonly_import" | "studio_video_package";
  reason: "invalid_revision" | "revision_conflict" | "control_conflict" | "validation_failed";
  message: string;
  expectedRevision?: number;
  currentRevision?: number;
  expectedFingerprint?: string;
  currentFingerprint?: string;
}): never {
  throw new RejectedCommandFailure(input.message, {
    schemaVersion: 1,
    applied: false,
    ...input,
  });
}
