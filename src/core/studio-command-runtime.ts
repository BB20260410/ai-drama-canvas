import path from "node:path";
import { z } from "zod";

export const studioCommandRequestIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,159}$/u);
export const studioCommandIdempotencyKeySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/u);
export const studioStableIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u);
export const studioAssetIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
export const studioBindingRevisionTokenSchema = z.string().trim().regex(/^[a-f0-9]{64}$/u);
export const studioSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const studioContinuityScopeSchema = z.object({
  kind: z.enum(["panel", "source-shot"]),
  scopeId: studioStableIdSchema,
  unitId: studioStableIdSchema,
  unitRevision: z.number().int().positive(),
  startMilliseconds: z.number().int().min(0).max(14_999),
  endMilliseconds: z.number().int().positive().max(15_000),
}).strict().superRefine((value, context) => {
  if (value.endMilliseconds <= value.startMilliseconds) {
    context.addIssue({ code: "custom", path: ["endMilliseconds"], message: "endMilliseconds 必须大于 startMilliseconds" });
  }
});

const studioContinuityProvenanceSchema = z.object({
  kind: z.string().trim().min(1).max(200),
  reference: z.string().trim().min(1).max(4_096),
  sourceFingerprint: z.string().trim().min(1).max(500).optional(),
  note: z.string().trim().min(1).max(4_000).optional(),
  fingerprint: studioSha256Schema.optional(),
}).strict();

const studioContinuityStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("resolved"),
    value: z.string().trim().min(1).max(10_000),
    provenance: z.array(studioContinuityProvenanceSchema).min(1).max(100),
  }).strict(),
  z.object({
    status: z.enum(["unresolved", "not-applicable"]),
    reason: z.string().trim().min(1).max(4_000),
    provenance: z.array(studioContinuityProvenanceSchema).min(1).max(100),
  }).strict(),
]);

const studioContinuityObservationPayloadSchema = z.object({
  expectedHeadRevision: z.number().int().min(0),
  scope: studioContinuityScopeSchema,
  subjectId: studioStableIdSchema,
  field: z.enum(["costume", "injury", "heldObject", "position", "facing", "emotion", "layout", "lighting", "referenceSha256"]),
  state: studioContinuityStateSchema,
}).strict();

const studioContinuityConflictExpectationSchema = z.object({
  conflictId: studioStableIdSchema,
  expectedRevision: z.number().int().positive(),
}).strict();

const studioContinuityCorrectionPayloadSchema = studioContinuityObservationPayloadSchema.extend({
  supersedesEntryId: studioStableIdSchema,
  resolvesConflicts: z.array(studioContinuityConflictExpectationSchema).max(1_000)
    .superRefine((values, context) => {
      if (new Set(values.map((entry) => entry.conflictId)).size !== values.length) {
        context.addIssue({ code: "custom", message: "resolvesConflicts.conflictId 不得重复" });
      }
    }).optional(),
}).strict();

const studioGenerationReviewCriterionSchema = z.object({
  code: studioStableIdSchema,
  status: z.enum(["pass", "fail", "not-applicable"]),
  note: z.string().trim().max(4_000).optional(),
}).strict();

const studioGenerationReviewAnnotationSchema = z.object({
  id: z.string().trim().regex(/^ann-[a-z0-9-]+$/u, "annotation id 必须是 ann- 前缀的稳定标识"),
  kind: z.enum(["rect", "point"]),
  category: z.enum(["face", "hair", "costume", "marking", "golden-mask", "scene", "prop"]).optional(),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().min(0).max(1),
  height: z.number().finite().min(0).max(1),
  note: z.string().trim().min(1).max(4_000),
}).strict().superRefine((value, context) => {
  if (value.kind === "rect" && (value.width <= 0 || value.height <= 0)) {
    context.addIssue({ code: "custom", path: ["width"], message: "rect 批注 width/height 必须大于 0" });
  }
  if (value.kind === "point" && (value.width !== 0 || value.height !== 0)) {
    context.addIssue({ code: "custom", path: ["width"], message: "point 批注必须 width=height=0" });
  }
  if (value.x + value.width > 1) context.addIssue({ code: "custom", path: ["width"], message: "annotation 横向越界" });
  if (value.y + value.height > 1) context.addIssue({ code: "custom", path: ["height"], message: "annotation 纵向越界" });
});

type StudioReviewerActor = "user" | "codex" | "any";

function reviewerSchema(actor: StudioReviewerActor) {
  if (actor === "user") return z.literal("user");
  if (actor === "codex") return z.literal("codex");
  return z.enum(["user", "codex"]);
}

function studioGenerationReviewPayloadSchema(actor: StudioReviewerActor) {
  return z.object({
    generationRunId: studioStableIdSchema,
    kind: z.enum(["observation", "correction"]),
    expectedHeadRevision: z.number().int().min(0),
    supersedesReviewId: studioStableIdSchema.optional(),
    rawResultId: studioStableIdSchema,
    rawSha256: studioSha256Schema,
    labeledResultId: studioStableIdSchema,
    labeledSha256: studioSha256Schema,
    expectedPackFingerprint: studioSha256Schema,
    continuityFingerprint: studioSha256Schema,
    decision: z.enum(["pass", "rework", "reject"]),
    criteria: z.array(studioGenerationReviewCriterionSchema).min(1).max(100)
      .superRefine((values, context) => {
        if (new Set(values.map((entry) => entry.code)).size !== values.length) {
          context.addIssue({ code: "custom", message: "criteria.code 不得重复" });
        }
      }),
    annotations: z.array(studioGenerationReviewAnnotationSchema).max(100).optional(),
    reviewer: reviewerSchema(actor),
    note: z.string().trim().min(1).max(8_000),
  }).strict().superRefine((value, context) => {
    if (value.kind === "observation" && value.supersedesReviewId !== undefined) {
      context.addIssue({ code: "custom", path: ["supersedesReviewId"], message: "observation 不能 supersede Review" });
    }
    if (value.kind === "correction" && value.supersedesReviewId === undefined) {
      context.addIssue({ code: "custom", path: ["supersedesReviewId"], message: "correction 必须显式 supersede 当前 Review" });
    }
  });
}

const studioGenerationCheckpointRefreshPayloadSchema = z.object({
  batchNumber: z.number().int().positive(),
  expectedHeadRevision: z.number().int().min(0),
}).strict();

const studioPostResultObservedStateSchema = z.object({
  costume: z.string().trim().min(1).max(2_000),
  injury: z.string().trim().min(1).max(2_000),
  heldObject: z.string().trim().min(1).max(2_000),
  position: z.string().trim().min(1).max(2_000),
  facing: z.string().trim().min(1).max(2_000),
  emotion: z.string().trim().min(1).max(2_000),
  layout: z.string().trim().min(1).max(2_000),
  lighting: z.string().trim().min(1).max(2_000),
  referenceSha256: studioSha256Schema,
  motionVector: z.string().trim().min(1).max(2_000),
  cameraPhase: z.string().trim().min(1).max(2_000),
  focusState: z.string().trim().min(1).max(2_000),
  audioPhase: z.string().trim().min(1).max(2_000),
}).strict();

const studioPostResultObservedAvailabilitySchema = z.object({
  costume: z.enum(["observed", "unknown", "not-applicable"]),
  injury: z.enum(["observed", "unknown", "not-applicable"]),
  heldObject: z.enum(["observed", "unknown", "not-applicable"]),
  position: z.enum(["observed", "unknown", "not-applicable"]),
  facing: z.enum(["observed", "unknown", "not-applicable"]),
  emotion: z.enum(["observed", "unknown", "not-applicable"]),
  layout: z.enum(["observed", "unknown", "not-applicable"]),
  lighting: z.enum(["observed", "unknown", "not-applicable"]),
  motionVector: z.enum(["observed", "unknown", "not-applicable"]),
  cameraPhase: z.enum(["observed", "unknown", "not-applicable"]),
  focusState: z.enum(["observed", "unknown", "not-applicable"]),
  audioPhase: z.enum(["observed", "unknown", "not-applicable"]),
}).strict();

const studioNextShotCharacterStateSchema = z.object({
  assetId: studioAssetIdSchema,
  costumeState: z.string().trim().min(1).max(2_000).optional(),
  position: z.string().trim().min(1).max(2_000),
  facing: z.string().trim().min(1).max(2_000),
  gazeDirection: z.string().trim().min(1).max(2_000),
  actionEndPose: z.string().trim().min(1).max(2_000),
  nextActionStart: z.string().trim().min(1).max(2_000).optional(),
  expression: z.string().trim().min(1).max(2_000),
  injuryState: z.string().trim().min(1).max(2_000).optional(),
}).strict();

const studioNextShotPropStateSchema = z.object({
  assetId: studioAssetIdSchema,
  heldBy: studioAssetIdSchema.nullable(),
  position: z.string().trim().min(1).max(2_000).optional(),
  physicalState: z.string().trim().min(1).max(2_000),
}).strict();

const studioNextShotSceneStateSchema = z.object({
  layout: z.string().trim().min(1).max(2_000),
  axisLine: z.string().trim().min(1).max(2_000),
  screenDirection: z.string().trim().min(1).max(2_000).optional(),
  entryExits: z.array(z.string().trim().min(1).max(2_000)).max(100),
  lighting: z.string().trim().min(1).max(2_000),
  timeOfDay: z.string().trim().min(1).max(2_000),
  weather: z.string().trim().min(1).max(2_000).optional(),
  cutExit: z.string().trim().min(1).max(2_000).optional(),
}).strict();

const studioNextShotVfxStateSchema = z.object({
  vfxId: studioStableIdSchema,
  description: z.string().trim().min(1).max(2_000),
  intensity: z.number().finite().min(0).max(1),
  continuesToNext: z.boolean(),
}).strict();

const studioNextShotContinuitySnapshotSchema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal("studio-next-shot-continuity"),
  sourceUnitId: studioStableIdSchema,
  sourcePanelId: studioStableIdSchema,
  sourceRawSha256: studioSha256Schema,
  characters: z.array(studioNextShotCharacterStateSchema).max(256),
  props: z.array(studioNextShotPropStateSchema).max(256),
  scene: studioNextShotSceneStateSchema,
  vfx: z.array(studioNextShotVfxStateSchema).max(100),
  referenceSha256List: z.array(studioSha256Schema).max(256),
  continuityFingerprint: studioSha256Schema,
  createdAt: z.string().trim().min(1).max(100),
}).strict();

function studioPostResultObservationPayloadSchema(actor: StudioReviewerActor) {
  return z.object({
    generationRunId: studioStableIdSchema,
    expectedHeadRevision: z.number().int().min(0),
    expectedReviewId: studioStableIdSchema,
    expectedReviewFingerprint: studioSha256Schema,
    rawResultId: studioStableIdSchema,
    rawSha256: studioSha256Schema,
    labeledResultId: studioStableIdSchema,
    labeledSha256: studioSha256Schema,
    packId: studioStableIdSchema,
    packFingerprint: studioSha256Schema,
    plannedContinuityFingerprint: studioSha256Schema,
    evidenceKind: z.enum(["terminal-panel-crop", "reviewed-video", "accepted-last-frame"]),
    evidenceSha256: studioSha256Schema,
    terminalPanelId: studioStableIdSchema.optional(),
    observedState: studioPostResultObservedStateSchema,
    observedAvailability: studioPostResultObservedAvailabilitySchema,
    continuitySnapshot: studioNextShotContinuitySnapshotSchema.optional(),
    observer: reviewerSchema(actor),
    note: z.string().trim().min(1).max(8_000),
  }).strict().superRefine((value, context) => {
    if (value.evidenceSha256 === value.rawSha256) {
      context.addIssue({
        code: "custom",
        path: ["evidenceSha256"],
        message: "evidenceSha256 不能等于整张宫格 rawSha256",
      });
    }
    if (value.observedState.referenceSha256 !== value.evidenceSha256) {
      context.addIssue({
        code: "custom",
        path: ["observedState", "referenceSha256"],
        message: "observedState.referenceSha256 必须等于 evidenceSha256",
      });
    }
    if (value.evidenceKind === "terminal-panel-crop" && value.terminalPanelId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["terminalPanelId"],
        message: "terminal-panel-crop 必须声明 terminalPanelId",
      });
    }
    if (value.evidenceKind !== "terminal-panel-crop" && value.terminalPanelId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["terminalPanelId"],
        message: `${value.evidenceKind} 不得声明 terminalPanelId`,
      });
    }
    if (value.continuitySnapshot
      && value.continuitySnapshot.sourceRawSha256 !== value.rawSha256) {
      context.addIssue({
        code: "custom",
        path: ["continuitySnapshot", "sourceRawSha256"],
        message: "continuitySnapshot.sourceRawSha256 必须等于 rawSha256",
      });
    }
    if (value.continuitySnapshot
      && value.terminalPanelId
      && value.continuitySnapshot.sourcePanelId !== value.terminalPanelId) {
      context.addIssue({
        code: "custom",
        path: ["continuitySnapshot", "sourcePanelId"],
        message: "continuitySnapshot.sourcePanelId 必须等于 terminalPanelId",
      });
    }
  });
}

function studioGenerationCheckpointAttestPayloadSchema(actor: StudioReviewerActor) {
  return z.object({
    batchNumber: z.number().int().positive(),
    checkpointId: studioStableIdSchema,
    checkpointFingerprint: studioSha256Schema,
    expectedHeadRevision: z.number().int().min(0),
    decision: z.enum(["pass", "rework"]),
    reviewer: reviewerSchema(actor),
    note: z.string().trim().min(1).max(8_000),
  }).strict();
}

const studioBindingExtractedMentionSchema = z.object({
  startOffsetUtf16: z.number().int().min(0),
  endOffsetUtf16: z.number().int().positive(),
  category: z.enum(["character", "scene", "prop", "style"]),
  presence: z.enum(["required", "optional", "forbidden"]),
  role: z.string().trim().min(1).max(1_000),
  candidateAssetIds: z.array(studioAssetIdSchema).max(5).superRefine((values, context) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "candidateAssetIds 不得重复" });
  }).optional(),
}).strict().superRefine((value, context) => {
  if (value.endOffsetUtf16 <= value.startOffsetUtf16) {
    context.addIssue({ code: "custom", path: ["endOffsetUtf16"], message: "endOffsetUtf16 必须大于 startOffsetUtf16" });
  }
});

const studioTextListSchema = z.array(z.string().trim().min(1).max(1_000)).max(100);
const studioApplicabilityScopeListSchema = z.array(z.string().trim().min(1).max(256)).max(200);
const studioAssetApplicabilitySchema = z.object({
  projects: studioApplicabilityScopeListSchema.optional(),
  seasons: studioApplicabilityScopeListSchema.optional(),
  episodes: studioApplicabilityScopeListSchema.optional(),
  units: studioApplicabilityScopeListSchema.optional(),
  timeRanges: z.array(z.object({
    scope: z.enum(["episode", "unit"]),
    scopeId: z.string().trim().min(1).max(256),
    startSeconds: z.number().finite().min(0).max(86_400),
    endSeconds: z.number().finite().positive().max(86_400),
    label: z.string().trim().min(1).max(256).optional(),
  }).strict()).max(200).optional(),
  tags: studioApplicabilityScopeListSchema.optional(),
}).strict();

const studioContinuityEvidenceInputSchema = z.object({
  kind: z.string().trim().min(1).max(500),
  reference: z.string().trim().min(1).max(4_096),
  note: z.string().trim().max(10_000).optional(),
}).strict();

const studioPanelAssetInputSchema = z.object({
  assetId: studioAssetIdSchema,
  category: z.enum(["character", "scene", "prop", "style"]),
  presence: z.enum(["required", "optional", "forbidden"]),
  role: z.string().trim().min(1).max(1_000),
  continuityState: z.string().trim().min(1).max(10_000),
  evidence: z.array(studioContinuityEvidenceInputSchema).min(1).max(100),
}).strict();

const studioPanelSourceSpanInputSchema = z.object({
  startOffsetUtf16: z.number().int().min(0),
  endOffsetUtf16: z.number().int().positive(),
}).strict();

const studioProductionPanelInputSchema = z.object({
  id: studioStableIdSchema.optional(),
  title: z.string().trim().min(1).max(1_000),
  visualAction: z.string().trim().min(1).max(20_000),
  shotComposition: z.string().trim().min(1).max(10_000),
  filmingMethod: z.string().trim().min(1).max(10_000),
  dialogue: z.string().trim().max(20_000).optional(),
  subtitle: z.string().trim().max(20_000).optional(),
  startSeconds: z.number().finite().min(0).max(15),
  endSeconds: z.number().finite().positive().max(15).optional(),
  durationSeconds: z.number().finite().positive().max(15),
  promptRevisionId: studioStableIdSchema,
  sourceSpans: z.array(studioPanelSourceSpanInputSchema).max(100).optional(),
  assets: z.array(studioPanelAssetInputSchema).max(100),
  transition: z.string().trim().max(200).optional(),
  costumeState: z.string().trim().max(200).optional(),
  sceneLighting: z.string().trim().max(200).optional(),
  shotType: z.enum(["original", "extension"]).optional(),
  negativePrompt: z.string().trim().max(2_000).optional(),
}).strict();

const studioCreateAssetPayloadSchema = z.object({
  id: studioAssetIdSchema.optional(),
  category: z.enum(["character", "scene", "prop", "style"]),
  name: z.string().trim().min(1).max(256),
  description: z.string().trim().max(20_000).optional(),
  aliases: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
  identityFeatures: studioTextListSchema.optional(),
  positiveLocks: studioTextListSchema.optional(),
  negativeLocks: studioTextListSchema.optional(),
  defaultPrompt: z.string().trim().max(40_000).optional(),
  applicability: studioAssetApplicabilitySchema.optional(),
  expectedRevision: z.literal(0),
}).strict();

const studioUpdateAssetPayloadSchema = z.object({
  assetId: studioAssetIdSchema,
  expectedRevision: z.number().int().positive(),
  category: z.enum(["character", "scene", "prop", "style"]).optional(),
  name: z.string().trim().min(1).max(256).optional(),
  description: z.string().trim().max(20_000).optional(),
  aliases: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
  identityFeatures: studioTextListSchema.optional(),
  positiveLocks: studioTextListSchema.optional(),
  negativeLocks: studioTextListSchema.optional(),
  defaultPrompt: z.string().trim().max(40_000).optional(),
  applicability: studioAssetApplicabilitySchema.optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "assetId" && key !== "expectedRevision"), {
  message: "update_studio_asset 至少提供一个待更新字段",
});

const studioAppendAssetRelationPayloadSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u).optional(),
  supersedesRelationId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u).optional(),
  kind: z.enum(["derived_from", "variant_of", "reference_of", "composite_member"]),
  subjectAssetId: studioAssetIdSchema,
  objectAssetId: studioAssetIdSchema,
  expectedSubjectRevision: z.number().int().positive(),
  expectedObjectRevision: z.number().int().positive(),
  ordinal: z.number().int().min(1).max(10_000).optional(),
  role: z.string().trim().max(256).optional(),
  note: z.string().trim().max(4_000).optional(),
}).strict();

const studioAppendTextRevisionPayloadSchema = z.object({
  documentId: studioStableIdSchema,
  expectedRevision: z.number().int().min(0),
  body: z.string().min(1).max(16 * 1_024 * 1_024),
  source: z.string().trim().min(1).max(4_096),
  sourceVersion: z.string().trim().min(1).max(500),
}).strict();

const studioAppendScriptSectionRevisionPayloadSchema = z.object({
  sectionId: studioStableIdSchema,
  expectedRevision: z.number().int().min(0),
  kind: z.enum(["chapter", "scene"]),
  title: z.string().trim().min(1).max(500),
  scriptRevisionId: studioStableIdSchema,
  scriptSha256: studioSha256Schema,
  startOffsetUtf16: z.number().int().min(0),
  endOffsetUtf16: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (value.endOffsetUtf16 <= value.startOffsetUtf16) {
    context.addIssue({ code: "custom", path: ["endOffsetUtf16"], message: "endOffsetUtf16 必须大于 startOffsetUtf16" });
  }
});

const studioCreateUnitPayloadSchema = z.object({
  id: studioStableIdSchema.optional(),
  expectedRevision: z.literal(0),
  season: z.string().trim().min(1).max(500),
  episode: z.string().trim().min(1).max(500),
  sequence: z.number().int().positive(),
  title: z.string().trim().min(1).max(1_000),
  durationSeconds: z.number().finite().min(1).max(15).optional(),
  scriptRevisionId: studioStableIdSchema,
  panels: z.array(studioProductionPanelInputSchema).min(2).max(6),
}).strict();

const studioReviseUnitPayloadSchema = z.object({
  unitId: studioStableIdSchema,
  expectedRevision: z.number().int().positive(),
  season: z.string().trim().min(1).max(500),
  episode: z.string().trim().min(1).max(500),
  sequence: z.number().int().positive(),
  title: z.string().trim().min(1).max(1_000),
  durationSeconds: z.number().finite().min(1).max(15).optional(),
  scriptRevisionId: studioStableIdSchema,
  panels: z.array(studioProductionPanelInputSchema).min(2).max(6),
}).strict();

const localCreativeProductionUnitMaterializationPayloadSchema = z.object({
  expectedPreviewFingerprint: studioSha256Schema,
  expectedSourceFingerprint: studioSha256Schema,
  candidateIds: z.array(studioStableIdSchema).min(1).max(3)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", message: "candidateIds 不得重复" });
      }
    }),
  scopeId: z.string().trim().min(1).max(200).optional(),
  adapterKind: z.enum(["auto", "dudu-world-prologue-v1"]).optional(),
}).strict();

const duduReadonlyRelativePathSchema = z.string().min(1).max(1_000).superRefine((value, context) => {
  if (value.includes("\0") || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || value === ".." || value.startsWith("../")) {
    context.addIssue({ code: "custom", message: "selector 必须是规范化且不逃逸根目录的相对路径" });
  }
});

const duduReadonlySourceSchema = z.object({
  lockedScriptPath: z.string().trim().min(1).refine((value) => path.isAbsolute(value), "lockedScriptPath 必须是绝对路径"),
  productionRoot: z.string().trim().min(1).refine((value) => path.isAbsolute(value), "productionRoot 必须是绝对路径"),
  contractRelativePath: duduReadonlyRelativePathSchema.optional(),
  machineStateRelativePath: duduReadonlyRelativePathSchema.optional(),
  referenceRegistryRelativePath: duduReadonlyRelativePathSchema.optional(),
  visualCanonRevisionRelativePath: duduReadonlyRelativePathSchema.optional(),
  visualExecutionRelativePath: duduReadonlyRelativePathSchema.optional(),
  visualConflictDecisionRelativePath: duduReadonlyRelativePathSchema.optional(),
  meteorVfxRuleRelativePath: duduReadonlyRelativePathSchema.optional(),
}).strict();

const studioVideoPackageAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("historical-import"), packId: studioStableIdSchema }).strict(),
  z.object({ kind: z.literal("studio-review"), reviewId: studioStableIdSchema }).strict(),
]);

const studioVideoPackageExpectedManagedSourceSchema = z.object({
  adapterKind: z.literal("managed-evidence-v1"),
  reviewId: studioStableIdSchema,
  expectedSourceFingerprint: studioSha256Schema,
  expectedReviewFingerprint: studioSha256Schema,
  expectedPackFingerprint: studioSha256Schema,
  expectedUnitSnapshotFingerprint: studioSha256Schema,
  expectedObservationControlFingerprint: studioSha256Schema,
  expectedObservationHeadRevision: z.number().int().min(0),
  expectedObservationStatus: z.enum(["missing", "current", "stale"]),
  expectedObservationHeadId: studioStableIdSchema.nullable(),
  expectedObservationHeadFingerprint: studioSha256Schema.nullable(),
  expectedObservationEvidenceSha256: studioSha256Schema.nullable(),
}).strict().superRefine((value, context) => {
  const headPresent = value.expectedObservationHeadId !== null
    || value.expectedObservationHeadFingerprint !== null;
  if ((value.expectedObservationHeadId === null)
    !== (value.expectedObservationHeadFingerprint === null)) {
    context.addIssue({
      code: "custom",
      path: ["expectedObservationHeadId"],
      message: "Observation Head id/fingerprint 必须同时存在或同时为 null",
    });
  }
  if ((value.expectedObservationHeadRevision === 0 && headPresent)
    || (value.expectedObservationHeadRevision > 0 && !headPresent)) {
    context.addIssue({
      code: "custom",
      path: ["expectedObservationHeadRevision"],
      message: "Observation Head revision 与 id/fingerprint 不闭合",
    });
  }
});

const studioMultimediaTimelineAttachPayloadSchema = z.object({
  unitId: studioStableIdSchema,
  unitRevision: z.number().int().positive(),
  expectedUnitFingerprint: studioSha256Schema,
  slotId: studioStableIdSchema,
  expectedHeadRevision: z.number().int().min(0),
  panelIndex: z.number().int().positive().optional(),
  startSeconds: z.number().finite().min(0).max(86_400),
  endSeconds: z.number().finite().positive().max(86_400),
  role: z.enum(["storyboard", "video", "dialogue", "music", "sfx"]),
  mediaSha256: studioSha256Schema,
  note: z.string().trim().max(4_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.endSeconds <= value.startSeconds) {
    context.addIssue({
      code: "custom",
      path: ["endSeconds"],
      message: "endSeconds 必须大于 startSeconds",
    });
  }
});

export const STUDIO_PUBLIC_COMMAND_NAMES = [
  "import_studio_media",
  "create_studio_asset",
  "update_studio_asset",
  "append_studio_asset_relation",
  "append_studio_asset_version",
  "review_studio_asset_version",
  "set_studio_primary_authority",
  "export_studio_cross_project_asset_package",
  "import_studio_cross_project_asset_package",
  "reuse_studio_global_resource",
  "create_studio_script_document",
  "create_studio_prompt_document",
  "append_studio_script_revision",
  "append_studio_script_section_revision",
  "append_studio_prompt_revision",
  "create_studio_production_unit",
  "revise_studio_production_unit",
  "materialize_local_creative_production_units",
  "analyze_studio_script_entities",
  "resolve_studio_entity_proposal",
  "confirm_studio_panel_empty",
  "freeze_studio_asset_binding_set",
  "freeze_studio_generation_pack",
  "dispatch_studio_generation_pack",
  "register_studio_generation_result",
  "authorize_studio_unit_grid_continuation_waiver",
  "prepare_studio_imagegen_call",
  "reconcile_studio_imagegen_call",
  "abandon_studio_generation_unknown",
  "abandon_studio_detached_generation_unknown",
  "rebind_studio_imagegen_call_context",
  "commit_agent_imagegen_result_bundle",
  "create_studio_generation_plan",
  "fail_studio_generation_run",
  "cancel_studio_generation_run",
  "retry_studio_generation_plan_nodes",
  "append_studio_continuity_observation",
  "append_studio_continuity_correction",
  "submit_studio_generation_review",
  "submit_studio_post_result_observation",
  "refresh_studio_generation_checkpoint",
  "attest_studio_generation_checkpoint",
  "finalize_dudu_readonly_managed_project",
  "reconcile_dudu_readonly_historical_passes",
  "prepare_studio_video_package_export",
  "build_studio_video_package",
  "attach_studio_multimedia_timeline_media",
] as const;

export const STUDIO_INTERNAL_COMMAND_NAMES = [
  "initialize_material_studio",
  "initialize_studio_production",
] as const;

export type StudioPublicCommandName = typeof STUDIO_PUBLIC_COMMAND_NAMES[number];
export type StudioInternalCommandName = typeof STUDIO_INTERNAL_COMMAND_NAMES[number];

const PUBLIC_COMMAND_NAME_SET = new Set<string>(STUDIO_PUBLIC_COMMAND_NAMES);
const INTERNAL_COMMAND_NAME_SET = new Set<string>(STUDIO_INTERNAL_COMMAND_NAMES);

export function isStudioPublicCommandName(value: unknown): value is StudioPublicCommandName {
  return typeof value === "string" && PUBLIC_COMMAND_NAME_SET.has(value);
}

export function isStudioInternalCommandName(value: unknown): value is StudioInternalCommandName {
  return typeof value === "string" && INTERNAL_COMMAND_NAME_SET.has(value);
}

export function isStudioCommandName(value: unknown): value is StudioPublicCommandName | StudioInternalCommandName {
  return isStudioPublicCommandName(value) || isStudioInternalCommandName(value);
}

function publicCommandVariants(actor: StudioReviewerActor) {
  const reviewer = reviewerSchema(actor);
  const variants = [
    z.object({ command: z.literal("import_studio_media"), payload: z.object({
      sourcePath: z.string().trim().min(1).refine((value) => path.isAbsolute(value), "sourcePath 必须是绝对路径"),
      kind: z.enum(["image", "video", "audio"]).optional(),
      expectedSha256: studioSha256Schema.optional(),
    }).strict() }),
    z.object({ command: z.literal("create_studio_asset"), payload: studioCreateAssetPayloadSchema }),
    z.object({ command: z.literal("update_studio_asset"), payload: studioUpdateAssetPayloadSchema }),
    z.object({ command: z.literal("append_studio_asset_relation"), payload: studioAppendAssetRelationPayloadSchema }),
    z.object({ command: z.literal("append_studio_asset_version"), payload: z.object({
      assetId: studioAssetIdSchema,
      mediaSha256: studioSha256Schema,
      reviewStatus: z.literal("pending"),
      sourceNote: z.string().trim().min(1).max(4_000),
      expectedRevision: z.number().int().positive(),
    }).strict() }),
    z.object({ command: z.literal("review_studio_asset_version"), payload: z.object({
      assetId: studioAssetIdSchema,
      versionId: studioStableIdSchema,
      decision: z.enum(["approved", "rejected"]),
      expectedRevision: z.number().int().positive(),
      note: z.string().trim().min(1).max(4_000),
    }).strict() }),
    z.object({ command: z.literal("set_studio_primary_authority"), payload: z.object({
      assetId: studioAssetIdSchema,
      versionId: studioStableIdSchema,
      expectedRevision: z.number().int().positive(),
      note: z.string().trim().max(4_000).optional(),
    }).strict() }),
    z.object({ command: z.literal("export_studio_cross_project_asset_package"), payload: z.object({
      items: z.array(z.object({
        assetId: studioAssetIdSchema,
        expectedRevision: z.number().int().positive(),
      }).strict()).min(1).max(100),
      outputPackageRoot: z.string().trim().min(1)
        .refine((value) => path.isAbsolute(value), "outputPackageRoot 必须是绝对路径"),
    }).strict() }),
    z.object({ command: z.literal("import_studio_cross_project_asset_package"), payload: z.object({
      packageRoot: z.string().trim().min(1)
        .refine((value) => path.isAbsolute(value), "packageRoot 必须是绝对路径"),
      expectedPackageFingerprint: studioSha256Schema,
      expectedSourceProjectId: studioStableIdSchema,
      sourceAssetId: studioAssetIdSchema,
      sourceVersionId: studioStableIdSchema,
      targetAssetId: studioAssetIdSchema.optional(),
      targetExpectedRevision: z.number().int().min(0),
      targetCategory: z.enum(["character", "scene", "prop", "style"]).optional(),
      targetName: z.string().trim().min(1).max(256).optional(),
    }).strict() }),
    z.object({
      command: z.literal("reuse_studio_global_resource"),
      payload: z.discriminatedUnion("resourceKind", [
        z.object({
          resourceKind: z.literal("asset"),
          sourceProjectRoot: z.string().trim().min(1)
            .refine((value) => path.isAbsolute(value), "sourceProjectRoot 必须是绝对路径"),
          expectedSourceProjectId: studioStableIdSchema,
          sourceAssetId: studioAssetIdSchema,
          sourceVersionId: studioStableIdSchema,
          expectedSourceAssetRevision: z.number().int().positive(),
          targetExpectedRevision: z.literal(0),
        }).strict(),
        z.object({
          resourceKind: z.literal("image"),
          sourceProjectRoot: z.string().trim().min(1)
            .refine((value) => path.isAbsolute(value), "sourceProjectRoot 必须是绝对路径"),
          expectedSourceProjectId: studioStableIdSchema,
          sourceMediaSha256: studioSha256Schema,
          expectedSourceMediaSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          targetExpectedRevision: z.literal(0),
        }).strict(),
        z.object({
          resourceKind: z.literal("audio"),
          sourceProjectRoot: z.string().trim().min(1)
            .refine((value) => path.isAbsolute(value), "sourceProjectRoot 必须是绝对路径"),
          expectedSourceProjectId: studioStableIdSchema,
          sourceMediaSha256: studioSha256Schema,
          expectedSourceMediaSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          targetExpectedRevision: z.literal(0),
        }).strict(),
        z.object({
          resourceKind: z.literal("video"),
          sourceProjectRoot: z.string().trim().min(1)
            .refine((value) => path.isAbsolute(value), "sourceProjectRoot 必须是绝对路径"),
          expectedSourceProjectId: studioStableIdSchema,
          sourceMediaSha256: studioSha256Schema,
          expectedSourceMediaSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          targetExpectedRevision: z.literal(0),
        }).strict(),
      ]),
    }),
    z.object({ command: z.literal("create_studio_script_document"), payload: z.object({
      id: studioStableIdSchema.optional(),
      title: z.string().trim().min(1).max(500),
      expectedRevision: z.literal(0),
    }).strict() }),
    z.object({ command: z.literal("create_studio_prompt_document"), payload: z.object({
      id: studioStableIdSchema.optional(),
      title: z.string().trim().min(1).max(500),
      expectedRevision: z.literal(0),
    }).strict() }),
    z.object({ command: z.literal("append_studio_script_revision"), payload: studioAppendTextRevisionPayloadSchema }),
    z.object({ command: z.literal("append_studio_script_section_revision"), payload: studioAppendScriptSectionRevisionPayloadSchema }),
    z.object({ command: z.literal("append_studio_prompt_revision"), payload: studioAppendTextRevisionPayloadSchema }),
    z.object({ command: z.literal("create_studio_production_unit"), payload: studioCreateUnitPayloadSchema }),
    z.object({ command: z.literal("revise_studio_production_unit"), payload: studioReviseUnitPayloadSchema }),
    z.object({
      command: z.literal("materialize_local_creative_production_units"),
      payload: localCreativeProductionUnitMaterializationPayloadSchema,
    }),
    z.object({ command: z.literal("analyze_studio_script_entities"), payload: z.object({
      unitId: studioStableIdSchema,
      panelId: studioStableIdSchema,
      expectedRevisionToken: studioBindingRevisionTokenSchema,
      extractedMentions: z.array(studioBindingExtractedMentionSchema).max(256).optional(),
    }).strict() }),
    z.object({ command: z.literal("resolve_studio_entity_proposal"), payload: z.object({
      unitId: studioStableIdSchema,
      panelId: studioStableIdSchema,
      proposalId: studioStableIdSchema,
      decision: z.enum(["accept", "select", "exclude"]),
      selectedAssetId: studioAssetIdSchema.optional(),
      presence: z.enum(["required", "optional", "forbidden"]),
      role: z.string().trim().min(1).max(1_000),
      expectedRevisionToken: studioBindingRevisionTokenSchema,
      note: z.string().trim().min(1).max(4_000).optional(),
      reviewer,
    }).strict().superRefine((value, context) => {
      if (value.decision === "exclude" && value.selectedAssetId !== undefined) {
        context.addIssue({ code: "custom", path: ["selectedAssetId"], message: "exclude 不能携带 selectedAssetId" });
      }
      if (value.decision === "select" && value.selectedAssetId === undefined) {
        context.addIssue({ code: "custom", path: ["selectedAssetId"], message: "select 必须显式携带 selectedAssetId" });
      }
    }) }),
    z.object({ command: z.literal("confirm_studio_panel_empty"), payload: z.object({
      unitId: studioStableIdSchema,
      panelId: studioStableIdSchema,
      expectedRevisionToken: studioBindingRevisionTokenSchema,
      reviewer,
      note: z.string().trim().min(1).max(4_000),
    }).strict() }),
    z.object({ command: z.literal("freeze_studio_asset_binding_set"), payload: z.object({
      unitId: studioStableIdSchema,
      panelId: studioStableIdSchema,
      expectedRevisionToken: studioBindingRevisionTokenSchema,
    }).strict() }),
    z.object({ command: z.literal("freeze_studio_generation_pack"), payload: z.union([
      z.object({
        targetKind: z.literal("panel").optional(),
        unitId: studioStableIdSchema,
        panelId: studioStableIdSchema,
        expectedRevision: z.number().int().positive(),
      }).strict(),
      z.object({
        targetKind: z.literal("unit-grid"),
        unitId: studioStableIdSchema,
        includePreviousUnitApprovedRaw: z.literal(true).optional(),
        continuationWaiver: z.object({
          receiptId: studioStableIdSchema,
          receiptFingerprint: studioSha256Schema,
        }).strict().optional(),
        expectedRevision: z.number().int().positive(),
      }).strict(),
    ]) }),
    z.object({ command: z.literal("dispatch_studio_generation_pack"), payload: z.object({
      packId: studioStableIdSchema,
      packFingerprint: studioSha256Schema,
      generationRunId: studioStableIdSchema,
      provider: z.enum(["codex", "grok"]),
      expectedRevision: z.number().int().positive(),
    }).strict() }),
    z.object({ command: z.literal("register_studio_generation_result"), payload: z.object({
      packId: studioStableIdSchema,
      packFingerprint: studioSha256Schema,
      generationRunId: studioStableIdSchema,
      variant: z.enum(["raw", "labeled"]),
      mediaSha256: studioSha256Schema,
      provider: z.enum(["codex", "grok"]).optional(),
      expectedRevision: z.number().int().positive(),
    }).strict() }),
    z.object({ command: z.literal("authorize_studio_unit_grid_continuation_waiver"), payload: z.object({
      unitId: studioStableIdSchema,
      expectedUnitRevision: z.number().int().positive(),
      projectContextToken: z.string().trim().regex(/^studioctx-v1-[a-f0-9]{64}$/u),
      authorizationEvidenceReference: z.string().trim().min(1).max(500)
        .refine((value) => !value.includes("\0"), "authorizationEvidenceReference 禁止包含 NUL"),
      authorizationText: z.string().min(8).max(4_000)
        .refine((value) => !/\p{Cc}/u.test(value), "authorizationText 禁止包含控制字符"),
      authorizationTextSha256: studioSha256Schema,
      reason: z.string().trim().min(8).max(500)
        .refine((value) => !/\p{Cc}/u.test(value), "reason 禁止包含控制字符"),
      acknowledgePreviousActualTailUnavailable: z.literal(true),
      acknowledgeCanonicalRestartMayBreakContinuity: z.literal(true),
      acknowledgeIdentityAndSceneLocksRemainMandatory: z.literal(true),
    }).strict() }),
    z.object({ command: z.literal("prepare_studio_imagegen_call"), payload: z.object({
      projectContextToken: z.string().trim().regex(/^studioctx-v1-[a-f0-9]{64}$/u),
      packId: studioStableIdSchema,
      packFingerprint: studioSha256Schema,
      generationRunId: studioStableIdSchema,
      provider: z.enum(["codex", "grok"]),
      callerAgentId: studioStableIdSchema.optional(),
      expectedRevision: z.literal(0),
    }).strict() }),
    z.object({ command: z.literal("reconcile_studio_imagegen_call"), payload: z.object({
      callId: studioStableIdSchema,
      projectContextToken: z.string().trim().regex(/^studioctx-v1-[a-f0-9]{64}$/u),
      result: z.enum(["not-invoked", "unknown-observation"]),
      evidenceReference: z.string().trim().min(1).max(500).refine((value) => !value.includes("\0"), "evidenceReference 禁止包含 NUL"),
      evidenceFingerprint: studioSha256Schema,
      note: z.string().trim().max(500).optional(),
      expectedRevision: z.literal(0),
    }).strict() }),
    z.object({ command: z.literal("abandon_studio_generation_unknown"), payload: z.object({
      callId: studioStableIdSchema,
      generationRunId: studioStableIdSchema,
      projectContextToken: z.string().trim().regex(/^studioctx-v1-[a-f0-9]{64}$/u),
      evidenceReference: z.string().trim().min(1).max(500).refine((value) => !value.includes("\0"), "evidenceReference 禁止包含 NUL"),
      evidenceFingerprint: studioSha256Schema,
      reason: z.string().trim().min(8).max(500).refine((value) => !/\p{Cc}/u.test(value), "reason 禁止包含控制字符"),
      acknowledgeRemoteMayExist: z.literal(true),
      acknowledgeLateResultWillBeRejected: z.literal(true),
      expectedRevision: z.literal(0),
    }).strict() }),
    z.object({ command: z.literal("abandon_studio_detached_generation_unknown"), payload: z.object({
      observationId: studioStableIdSchema,
      expectedObservationFingerprint: studioSha256Schema,
      projectContextToken: z.string().trim().regex(/^studioctx-v1-[a-f0-9]{64}$/u),
      authorizationEvidenceReference: z.string().trim().min(1).max(500)
        .refine((value) => !value.includes("\0"), "authorizationEvidenceReference 禁止包含 NUL"),
      authorizationText: z.string().min(8).max(4_000)
        .refine((value) => !/\p{Cc}/u.test(value), "authorizationText 禁止包含控制字符"),
      authorizationTextSha256: studioSha256Schema,
      reason: z.string().trim().min(8).max(500)
        .refine((value) => !/\p{Cc}/u.test(value), "reason 禁止包含控制字符"),
      acknowledgeRemoteGenerationMayExist: z.literal(true),
      acknowledgeDetachedCandidateWillNeverBeImportedOrReused: z.literal(true),
      acknowledgeFreshFormalRunMayDuplicateRemoteGeneration: z.literal(true),
      expectedRevision: z.literal(0),
    }).strict() }),
    z.object({ command: z.literal("rebind_studio_imagegen_call_context"), payload: z.object({
      callId: studioStableIdSchema,
      generationRunId: studioStableIdSchema,
      packId: studioStableIdSchema,
      packFingerprint: studioSha256Schema,
      inputFingerprint: studioSha256Schema,
      candidateSha256: studioSha256Schema,
      receiptSha256: studioSha256Schema,
      projectContextToken: z.string().trim().regex(/^studioctx-v1-[a-f0-9]{64}$/u),
      evidenceReference: z.string().trim().min(1).max(500).refine((value) => !value.includes("\0"), "evidenceReference 禁止包含 NUL"),
      evidenceFingerprint: studioSha256Schema,
      reason: z.string().trim().min(8).max(500).refine((value) => !/\p{Cc}/u.test(value), "reason 禁止包含控制字符"),
      acknowledgeBuildChangedAfterInvocation: z.literal(true),
      acknowledgeNoSecondModelCall: z.literal(true),
      expectedRevision: z.literal(0),
    }).strict() }),
    z.object({ command: z.literal("commit_agent_imagegen_result_bundle"), payload: z.object({
      projectContextToken: z.string().trim().regex(/^studioctx-v1-[a-f0-9]{64}$/u),
      packId: studioStableIdSchema,
      packFingerprint: studioSha256Schema,
      generationRunId: studioStableIdSchema,
      provider: z.enum(["codex", "grok"]),
      rawPath: z.string().trim().min(1).refine((value) => path.isAbsolute(value), "rawPath 必须是绝对路径"),
      rawSha256: studioSha256Schema,
      executionReceiptPath: z.string().trim().min(1).refine((value) => path.isAbsolute(value), "executionReceiptPath 必须是绝对路径").optional(),
      expectedRevision: z.number().int().positive(),
      executionReceipt: z.object({
        schemaVersion: z.literal(1),
        kind: z.literal("agent-imagegen-execution-receipt"),
        provider: z.enum(["codex", "grok"]),
        source: z.enum(["codex-imagegen", "grok-build-imagine", "fixture-canary"]),
        attestationLevel: z.enum(["agent-session-direct", "unverified-external-agent"]),
        cryptographicProviderReceipt: z.literal(false),
        callId: studioStableIdSchema,
        model: z.string().trim().min(1).max(200),
        agentSessionId: studioStableIdSchema.optional(),
        toolCallId: studioStableIdSchema.optional(),
        toolName: z.enum(["image_gen", "image_edit"]).optional(),
        toolInvocationCount: z.literal(1).optional(),
        inputFingerprint: studioSha256Schema.optional(),
        candidateSha256: studioSha256Schema.optional(),
        startedAt: z.string().datetime({ offset: false }).optional(),
        generatedAt: z.string().datetime({ offset: false }),
      }).strict(),
    }).strict().superRefine((value, context) => {
      if (value.provider !== value.executionReceipt.provider) {
        context.addIssue({ code: "custom", path: ["executionReceipt", "provider"], message: "executionReceipt.provider 必须与 provider 一致" });
      }
      if ((value.provider === "codex" && !["codex-imagegen", "fixture-canary"].includes(value.executionReceipt.source))
        || (value.provider === "grok" && !["grok-build-imagine", "fixture-canary"].includes(value.executionReceipt.source))) {
        context.addIssue({ code: "custom", path: ["executionReceipt", "source"], message: "executionReceipt.source 与 provider 不一致" });
      }
      if (value.executionReceipt.source === "grok-build-imagine") {
        if (!value.executionReceiptPath) {
          context.addIssue({ code: "custom", path: ["executionReceiptPath"], message: "Grok live 必须提供 quarantine 回执路径" });
        }
        for (const field of ["agentSessionId", "toolCallId", "toolName", "toolInvocationCount", "inputFingerprint", "candidateSha256", "startedAt"] as const) {
          if (value.executionReceipt[field] === undefined) {
            context.addIssue({ code: "custom", path: ["executionReceipt", field], message: `Grok live 缺少 ${field}` });
          }
        }
      }
    }) }),
    z.object({ command: z.literal("create_studio_generation_plan"), payload: z.object({
      nodes: z.array(z.union([
        z.object({
          targetKind: z.literal("panel").optional(),
          unitId: studioStableIdSchema,
          panelId: studioStableIdSchema,
        }).strict(),
        z.object({
          targetKind: z.literal("unit-grid"),
          unitId: studioStableIdSchema,
        }).strict(),
      ])).min(1).max(36),
    }).strict() }),
    z.object({ command: z.literal("fail_studio_generation_run"), payload: z.object({
      generationRunId: studioStableIdSchema,
      errorClass: studioStableIdSchema,
      detail: z.string().max(500).optional(),
    }).strict() }),
    z.object({ command: z.literal("cancel_studio_generation_run"), payload: z.object({
      generationRunId: studioStableIdSchema,
      reason: z.string().max(200).optional(),
    }).strict() }),
    z.object({ command: z.literal("retry_studio_generation_plan_nodes"), payload: z.object({
      planId: studioStableIdSchema,
      nodeIndexes: z.array(z.number().int().positive()).max(36).optional(),
    }).strict() }),
    z.object({ command: z.literal("append_studio_continuity_observation"), payload: studioContinuityObservationPayloadSchema }),
    z.object({ command: z.literal("append_studio_continuity_correction"), payload: studioContinuityCorrectionPayloadSchema }),
    z.object({ command: z.literal("submit_studio_generation_review"), payload: studioGenerationReviewPayloadSchema(actor) }),
    z.object({
      command: z.literal("submit_studio_post_result_observation"),
      payload: studioPostResultObservationPayloadSchema(actor),
    }),
    z.object({ command: z.literal("refresh_studio_generation_checkpoint"), payload: studioGenerationCheckpointRefreshPayloadSchema }),
    z.object({ command: z.literal("attest_studio_generation_checkpoint"), payload: studioGenerationCheckpointAttestPayloadSchema(actor) }),
    z.object({ command: z.literal("finalize_dudu_readonly_managed_project"), payload: z.object({
      source: duduReadonlySourceSchema,
      expectedRevision: z.literal(0),
      expectedDiscoveryFingerprint: studioSha256Schema,
      expectedImportFingerprint: studioSha256Schema,
      expectedControlFingerprint: studioSha256Schema,
    }).strict() }),
    z.object({ command: z.literal("reconcile_dudu_readonly_historical_passes"), payload: z.object({
      source: duduReadonlySourceSchema,
      expectedRevision: z.literal(0),
      expectedControlFingerprint: studioSha256Schema,
    }).strict() }),
    z.object({ command: z.literal("prepare_studio_video_package_export"), payload: z.object({
      authority: studioVideoPackageAuthoritySchema,
      expectedRevision: z.number().int().positive(),
      expectedControlFingerprint: studioSha256Schema,
      expectedManagedSource: studioVideoPackageExpectedManagedSourceSchema.optional(),
    }).strict().superRefine((value, context) => {
      if (value.authority.kind === "studio-review") {
        if (!value.expectedManagedSource) {
          context.addIssue({
            code: "custom",
            path: ["expectedManagedSource"],
            message: "studio-review prepare 必须携带 managed-evidence source CAS",
          });
        } else if (value.expectedManagedSource.reviewId !== value.authority.reviewId) {
          context.addIssue({
            code: "custom",
            path: ["expectedManagedSource", "reviewId"],
            message: "managed source reviewId 必须等于 authority.reviewId",
          });
        }
      } else if (value.expectedManagedSource !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["expectedManagedSource"],
          message: "historical-import 不得携带 managed source",
        });
      }
    }) }),
    z.object({ command: z.literal("build_studio_video_package"), payload: z.object({
      intentId: studioStableIdSchema,
      expectedRevision: z.number().int().positive(),
      expectedIntentControlFingerprint: studioSha256Schema,
      expectedAuthorityControlFingerprint: studioSha256Schema,
      destinationPolicy: z.literal("managed-evidence-only"),
    }).strict() }),
    z.object({
      command: z.literal("attach_studio_multimedia_timeline_media"),
      payload: studioMultimediaTimelineAttachPayloadSchema,
    }),
  ] as const;
  // Payload schemas are strict, but a plain command-level z.object strips
  // unknown keys. Keep the variants flat for MCP JSON-schema parity while
  // making every { command, payload } envelope fail closed as well.
  return variants.map((variant) => variant.strict()) as unknown as typeof variants;
}

export const STUDIO_CODEX_PUBLIC_COMMAND_SCHEMA_OPTIONS = publicCommandVariants("codex");
export const STUDIO_USER_PUBLIC_COMMAND_SCHEMA_OPTIONS = publicCommandVariants("user");
export const STUDIO_ANY_ACTOR_PUBLIC_COMMAND_SCHEMA_OPTIONS = publicCommandVariants("any");

export const studioCodexPublicCommandRequestSchema = z.discriminatedUnion(
  "command",
  STUDIO_CODEX_PUBLIC_COMMAND_SCHEMA_OPTIONS,
);
export const studioUserPublicCommandRequestSchema = z.discriminatedUnion(
  "command",
  STUDIO_USER_PUBLIC_COMMAND_SCHEMA_OPTIONS,
);
export const studioAnyActorPublicCommandRequestSchema = z.discriminatedUnion(
  "command",
  STUDIO_ANY_ACTOR_PUBLIC_COMMAND_SCHEMA_OPTIONS,
);
export const studioInternalCommandRequestSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("initialize_material_studio"), payload: z.object({}).strict() }).strict(),
  z.object({ command: z.literal("initialize_studio_production"), payload: z.object({}).strict() }).strict(),
]);

export type StudioPublicCommandRequest = z.infer<typeof studioAnyActorPublicCommandRequestSchema>;
export type StudioInternalCommandRequest = z.infer<typeof studioInternalCommandRequestSchema>;
export type StudioRuntimeCommandRequest = StudioPublicCommandRequest | StudioInternalCommandRequest;
export type StudioCommandActor = StudioReviewerActor;

export interface StudioIdempotentCommandInput {
  requestId: string;
  idempotencyKey: string;
  request: StudioRuntimeCommandRequest;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => {
    const invalidValues = (issue as { values?: unknown[] }).values;
    const message = issue.path.at(-1) === "expectedRevision"
      && issue.code === "invalid_value"
      && invalidValues?.includes(0)
      ? "expectedRevision 必须为 0"
      : issue.message;
    return `${issue.path.join(".") || "(root)"}: ${message}`;
  }).join("；");
}

export function parseStudioCommandRequestForCore(value: unknown): StudioRuntimeCommandRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const command = (value as { command?: unknown }).command;
  if (isStudioPublicCommandName(command)) {
    const parsed = studioAnyActorPublicCommandRequestSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Studio 命令 ${command} 的载荷不符合合同：${formatIssues(parsed.error)}`);
    return parsed.data;
  }
  if (isStudioInternalCommandName(command)) {
    const parsed = studioInternalCommandRequestSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Studio 内部命令 ${command} 的载荷不符合合同：${formatIssues(parsed.error)}`);
    return parsed.data;
  }
  return undefined;
}

export function parseStudioIdempotentCommandInput(
  value: unknown,
  actor: Exclude<StudioReviewerActor, "any">,
): StudioIdempotentCommandInput & { request: StudioPublicCommandRequest } {
  const requestSchema = actor === "user"
    ? studioUserPublicCommandRequestSchema
    : studioCodexPublicCommandRequestSchema;
  const schema = z.object({
    requestId: studioCommandRequestIdSchema,
    idempotencyKey: studioCommandIdempotencyKeySchema,
    request: requestSchema,
  }).strict();
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Studio ${actor} 命令信封不符合合同：${formatIssues(parsed.error)}`);
  return parsed.data as StudioIdempotentCommandInput & { request: StudioPublicCommandRequest };
}
