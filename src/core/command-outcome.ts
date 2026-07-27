export class ConfirmedCommandFailure extends Error {
  readonly result: unknown;

  constructor(message: string, result: unknown) {
    super(message);
    this.name = "ConfirmedCommandFailure";
    this.result = result;
  }
}

export function isConfirmedCommandFailure(error: unknown): error is ConfirmedCommandFailure {
  return error instanceof ConfirmedCommandFailure;
}

export class RejectedCommandFailure extends Error {
  readonly result: unknown;

  constructor(message: string, result: unknown) {
    super(message);
    this.name = "RejectedCommandFailure";
    this.result = result;
  }
}

export function isRejectedCommandFailure(error: unknown): error is RejectedCommandFailure {
  return error instanceof RejectedCommandFailure;
}

export type LongLivedFactEntityType = "production_workflow" | "creative_bible" | "asset_relation" | "voice_identity" | "project_context";
export type LongLivedFactRejectionReason = "revision_required" | "revision_conflict" | "not_found" | "invalid_create_revision" | "invalid_id" | "invalid_revision";

interface LongLivedFactRejectionInput {
  reason: LongLivedFactRejectionReason;
  entityType: LongLivedFactEntityType;
  entityId?: string;
  expectedRevision?: unknown;
  currentRevision?: number;
  message: string;
}

function rejectLongLivedFactWrite(input: LongLivedFactRejectionInput): never {
  const result: Record<string, unknown> = {
    schemaVersion: 1,
    applied: false,
    reason: input.reason,
    entityType: input.entityType,
  };
  if (input.entityId !== undefined) result.entityId = input.entityId;
  if (input.expectedRevision !== undefined) result.expectedRevision = input.expectedRevision;
  if (input.currentRevision !== undefined) result.currentRevision = input.currentRevision;
  throw new RejectedCommandFailure(input.message, result);
}

export function assertRevisionedUpsert(input: {
  id: unknown;
  expectedRevision: unknown;
  currentRevision?: number;
  entityType: LongLivedFactEntityType;
  entityLabel: string;
}): "create" | "update" {
  if (input.id === undefined) {
    if (input.expectedRevision !== undefined) {
      rejectLongLivedFactWrite({
        reason: "invalid_create_revision",
        entityType: input.entityType,
        expectedRevision: input.expectedRevision,
        message: `新建${input.entityLabel}时不能携带 expectedRevision。`,
      });
    }
    return "create";
  }
  if (typeof input.id !== "string" || !input.id.trim()) {
    rejectLongLivedFactWrite({ reason: "invalid_id", entityType: input.entityType, message: `${input.entityLabel} ID 不能为空。` });
  }
  assertExistingRevision({
    entityType: input.entityType,
    entityLabel: input.entityLabel,
    entityId: input.id,
    expectedRevision: input.expectedRevision,
    currentRevision: input.currentRevision,
  });
  return "update";
}

export function assertExistingRevision(input: {
  entityType: LongLivedFactEntityType;
  entityLabel: string;
  entityId?: string;
  expectedRevision: unknown;
  currentRevision?: number;
  allowZero?: boolean;
}): void {
  if (input.entityId !== undefined && input.currentRevision === undefined) {
    rejectLongLivedFactWrite({ reason: "not_found", entityType: input.entityType, entityId: input.entityId, expectedRevision: input.expectedRevision, message: `找不到${input.entityLabel}：${input.entityId}` });
  }
  if (input.expectedRevision === undefined) {
    rejectLongLivedFactWrite({ reason: "revision_required", entityType: input.entityType, entityId: input.entityId, currentRevision: input.currentRevision, message: `更新${input.entityLabel}必须携带 expectedRevision。` });
  }
  const minimum = input.allowZero ? 0 : 1;
  if (!Number.isInteger(input.expectedRevision) || (input.expectedRevision as number) < minimum) {
    rejectLongLivedFactWrite({ reason: "invalid_revision", entityType: input.entityType, entityId: input.entityId, expectedRevision: input.expectedRevision, currentRevision: input.currentRevision, message: `${input.entityLabel} expectedRevision 必须是${input.allowZero ? "非负" : "正"}整数。` });
  }
  if (input.currentRevision !== undefined && input.expectedRevision !== input.currentRevision) {
    rejectLongLivedFactWrite({ reason: "revision_conflict", entityType: input.entityType, entityId: input.entityId, expectedRevision: input.expectedRevision, currentRevision: input.currentRevision, message: `${input.entityLabel}已被其他窗口更新（当前修订 ${input.currentRevision}），请刷新后重试。` });
  }
}
