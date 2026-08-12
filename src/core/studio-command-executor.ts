import path from "node:path";
import { isConfirmedCommandFailure, isRejectedCommandFailure, RejectedCommandFailure } from "./command-outcome.js";
import {
  appendStudioAssetRelation,
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  getStudioMedia,
  importStudioMedia,
  initializeMaterialStudio,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
  updateStudioCanonicalAsset,
} from "./material-studio.js";
import {
  exportStudioCrossProjectAssetPackage,
  importStudioCrossProjectAssetPackage,
} from "./studio-cross-project-asset-reuse.js";
import { reuseStudioGlobalResource } from "./studio-global-resource-reuse.js";
import {
  appendStudioPromptRevision,
  appendStudioScriptSectionRevision,
  appendStudioScriptRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  getStudioProductionUnitSnapshot,
  initializeStudioProduction,
  reviseStudioProductionUnit,
  StudioProductionConflictError,
  StudioScriptSectionLineageError,
} from "./studio-production.js";
import {
  analyzeStudioScriptEntities,
  confirmStudioPanelEmptyFromControl,
  freezeStudioAssetBindingSetFromControl,
  resolveStudioEntityProposal,
  StudioBindingControlError,
} from "./studio-binding-control.js";
import { StudioGenerationFreezeError } from "./studio-generation.js";
import {
  abandonStudioDetachedGenerationUnknown,
  abandonStudioGenerationUnknown,
  authorizeStudioUnitGridContinuationWaiver,
  cancelStudioGenerationRun,
  createStudioGenerationPlan,
  dispatchStudioGenerationPack,
  failStudioGenerationRun,
  freezeAndPersistStudioGenerationPack,
  freezeAndPersistStudioUnitGridGenerationPack,
  prepareStudioImagegenCall,
  readAnyStudioGenerationFrozenPack,
  readPersistedStudioGenerationPack,
  readStudioGenerationRunEventHistory,
  rebindStudioImagegenCallContext,
  reconcileStudioImagegenCall,
  registerStudioGenerationResult,
  retryStudioGenerationPlanNodes,
  StudioGenerationLedgerError,
  StudioGenerationResultConflictError,
} from "./studio-generation-ledger.js";
import {
  appendStudioContinuityCorrection,
  appendStudioContinuityObservation,
} from "./studio-continuity-ledger.js";
import { submitStudioGenerationReview } from "./studio-generation-review.js";
import { submitStudioPostResultObservation } from "./studio-post-result-observation.js";
import {
  attestStudioGenerationCheckpoint,
  refreshStudioGenerationCheckpoint,
} from "./studio-generation-checkpoint.js";
import {
  commitAgentImagegenResultBundle,
  StudioAgentImagegenBundleError,
} from "./studio-agent-imagegen-result-bundle.js";
import { StudioLabeledLayoutError } from "./studio-labeled-layout.js";
import {
  ActiveManagedStudioContextError,
  assertActiveManagedStudioContextToken,
} from "./active-managed-studio-context.js";
import {
  discoverDuduReadonlyImportProjects,
  finalizeDuduReadonlyManagedProject,
  getDuduReadonlyImportControl,
  reconcileDuduReadonlyHistoricalPasses,
} from "./dudu-readonly-import.js";
import {
  buildAndVerifyStudioVideoPackage,
  getStudioVideoPackageControl,
  prepareStudioVideoPackageExport,
  StudioVideoPackageError,
  type StudioVideoPackageAuthorityInput,
} from "./studio-video-package.js";
import {
  attestStudioHiggsfieldConnectorCapability,
  buildStudioHiggsfieldVideoConnectorRequest,
  prepareStudioHiggsfieldVideoGeneration,
  recordStudioHiggsfieldSubmission,
} from "./studio-higgsfield-video-generation.js";
import {
  assertNoActiveStudioHiggsfieldConnectorReservation,
  assertStudioHiggsfieldConnectorOwnerCurrent,
  authorizeStudioHiggsfieldConnectorRequest,
  claimStudioHiggsfieldConnectorRequest,
  enqueueStudioHiggsfieldConnectorRequest,
  getStudioHiggsfieldConnectorRequest,
  preflightStudioHiggsfieldConnectorRequest,
  reconcileStudioHiggsfieldConnectorRequest,
  recordStudioHiggsfieldConnectorSubmission,
} from "./studio-higgsfield-connector-queue.js";
import { attachStudioMultimediaTimelineMedia } from "./studio-multimedia-timeline.js";
import { materializeLocalCreativeProductionUnits } from "./local-creative-production-unit-materializer.js";
import {
  deterministicStudioTimelineRejection,
  rejectP30OrchestrationCommand,
} from "./studio-command-errors.js";
import type { StudioRuntimeCommandRequest } from "./studio-command-runtime.js";

async function buildStudioHiggsfieldImageConnectorRequest(projectRoot: string, generationRunId: string): Promise<{
  provider: "higgsfield-connector"; kind: "image"; model: "gpt_image_2"; prompt: string;
  imageReferences: Array<{ order: number; sha256: string; localPath: string }>;
  aspectRatio: "9:16" | "16:9"; resolution: "1k"; quality: "low"; count: 1; useUnlim: true;
}> {
  const history = await readStudioGenerationRunEventHistory(projectRoot, generationRunId);
  const dispatch = history.find((event) => event.kind === "dispatched")?.detail as { packId?: unknown } | undefined;
  if (!dispatch || typeof dispatch.packId !== "string") throw new Error("Higgsfield 图片请求缺少既有 formal dispatch pack。 ");
  const pack = await readAnyStudioGenerationFrozenPack(projectRoot, dispatch.packId);
  if (!pack) throw new Error("Higgsfield 图片请求的冻结包不存在。 ");
  const mediaShas = new Set<string>();
  const collectMediaSha = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collectMediaSha); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "mediaSha256" && typeof entry === "string" && /^[a-f0-9]{64}$/u.test(entry)) mediaShas.add(entry);
      else collectMediaSha(entry);
    }
  };
  // request、controlReferences 与 continuityFrame 同属冻结包闭包；不能只取 assets。
  const collectPanelPackReferences = (panelPack: { request: { modelPayload: { assets: Array<{ presence: string; mediaSha256: string }> }; controlReferences: unknown; continuityFrame?: unknown } }): void => {
    // 不递归整个 request：safetyConstraints/forbidden asset 即便携带 mediaSha 也绝不能被上传为正向参考。
    panelPack.request.modelPayload.assets
      .filter((asset) => asset.presence !== "forbidden")
      .forEach((asset) => mediaShas.add(asset.mediaSha256));
    collectMediaSha(panelPack.request.controlReferences);
    collectMediaSha(panelPack.request.continuityFrame);
  };
  if (pack.provenance === "asset-binding-set") collectPanelPackReferences(pack);
  else pack.panels.forEach((panel) => collectPanelPackReferences(panel.panelPack));
  const ordered = [...mediaShas].sort((left, right) => left.localeCompare(right, "en"));
  const refs = await Promise.all(ordered.map(async (sha256, index) => {
    const media = await getStudioMedia(projectRoot, sha256);
    if (!media || media.kind !== "image") throw new Error(`Higgsfield 图片参考媒体不可用：${sha256}`);
    return { order: index + 1, sha256, localPath: media.objectPath };
  }));
  if (!refs.length || refs.length > 30) throw new Error("Higgsfield 图片请求需要 1–30 个已冻结图片参考。 ");
  return {
    provider: "higgsfield-connector", kind: "image", model: "gpt_image_2",
    prompt: pack.request.modelPayload.renderedPrompt,
    imageReferences: refs,
    aspectRatio: (pack.request.modelPayload.layout ?? "9:16-vertical").includes("vertical") ? "9:16" : "16:9",
    resolution: "1k", quality: "low", count: 1, useUnlim: true,
  };
}

function rejectStudioScriptSectionConflict(error: unknown): never {
  if (error instanceof StudioProductionConflictError) {
    throw new RejectedCommandFailure(error.message, {
      schemaVersion: 1,
      applied: false,
      entityType: "studio_script_section",
      entityId: error.entityId,
      sectionId: error.entityId,
      reason: "revision_conflict",
      expectedRevision: error.expectedRevision,
      currentRevision: error.actualRevision,
    });
  }
  if (error instanceof StudioScriptSectionLineageError) {
    throw new RejectedCommandFailure(error.message, {
      schemaVersion: 1,
      applied: false,
      entityType: "studio_script_section",
      entityId: error.sectionId,
      sectionId: error.sectionId,
      reason: "lineage_conflict",
      invariant: error.invariant,
      expectedValue: error.expectedValue,
      actualValue: error.actualValue,
    });
  }
  throw error;
}

function rejectStudioBindingPrecondition(
  error: unknown,
  input: { unitId: string; panelId: string; expectedRevisionToken: string },
): never {
  if (isRejectedCommandFailure(error)) throw error;
  if (!(error instanceof StudioBindingControlError) && !(error instanceof StudioProductionConflictError)) throw error;
  const code = error instanceof StudioBindingControlError ? error.code : "revision-conflict";
  throw new RejectedCommandFailure(error.message, {
    schemaVersion: 1,
    applied: false,
    entityType: "studio_asset_binding",
    reason: code,
    unitId: input.unitId,
    panelId: input.panelId,
    expectedRevisionToken: input.expectedRevisionToken,
  });
}

type StudioGenerationCommandEntity = "studio_generation_pack" | "studio_generation_dispatch" | "studio_generation_call" | "studio_generation_result" | "studio_generation_result_bundle" | "studio_generation_plan" | "studio_generation_run";

function rejectStudioGenerationCommand(input: {
  entityType: StudioGenerationCommandEntity;
  reason: string;
  message: string;
  code?: string;
  unitId?: string;
  panelId?: string;
  packId?: string;
  expectedRevision?: unknown;
  currentRevision?: number;
}): never {
  const result: Record<string, unknown> = {
    schemaVersion: 1,
    applied: false,
    entityType: input.entityType,
    reason: input.reason,
  };
  if (input.code !== undefined) result.code = input.code;
  if (input.unitId !== undefined) result.unitId = input.unitId;
  if (input.panelId !== undefined) result.panelId = input.panelId;
  if (input.packId !== undefined) result.packId = input.packId;
  if (input.expectedRevision !== undefined) result.expectedRevision = input.expectedRevision;
  if (input.currentRevision !== undefined) result.currentRevision = input.currentRevision;
  throw new RejectedCommandFailure(input.message, result);
}

function assertStudioGenerationExpectedRevision(
  entityType: StudioGenerationCommandEntity,
  expectedRevision: unknown,
  context: { unitId?: string; panelId?: string; packId?: string },
): asserts expectedRevision is number {
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
    rejectStudioGenerationCommand({
      entityType,
      reason: "invalid_revision",
      message: "Studio generation expectedRevision 必须是正整数。",
      expectedRevision,
      ...context,
    });
  }
}

type StudioGenerationPackPayload = Extract<StudioRuntimeCommandRequest, {
  command: "freeze_studio_generation_pack";
}>["payload"];
type StudioUnitGridGenerationQuery = Omit<Extract<StudioGenerationPackPayload, {
  targetKind: "unit-grid";
}>, "expectedRevision">;
type StudioPanelGenerationQuery = Omit<Exclude<StudioGenerationPackPayload, {
  targetKind: "unit-grid";
}>, "expectedRevision">;

function isStudioUnitGridGenerationQuery(
  input: StudioPanelGenerationQuery | StudioUnitGridGenerationQuery,
): input is StudioUnitGridGenerationQuery {
  return (input as { targetKind?: unknown }).targetKind === "unit-grid";
}

async function assertStudioGenerationUnitRevision(input: {
  projectRoot: string;
  entityType: StudioGenerationCommandEntity;
  unitId: string;
  panelId?: string;
  packId?: string;
  expectedRevision: number;
}): Promise<void> {
  const snapshot = await getStudioProductionUnitSnapshot(input.projectRoot, input.unitId);
  if (!snapshot) {
    rejectStudioGenerationCommand({
      entityType: input.entityType,
      reason: "not_found",
      message: `15 秒生产单元不存在：${input.unitId}`,
      unitId: input.unitId,
      panelId: input.panelId,
      packId: input.packId,
      expectedRevision: input.expectedRevision,
    });
  }
  if (snapshot.unit.revision !== input.expectedRevision) {
    rejectStudioGenerationCommand({
      entityType: input.entityType,
      reason: "revision_conflict",
      message: `生产单元 ${input.unitId} 已被其他窗口更新（当前 revision ${snapshot.unit.revision}），请重新冻结。`,
      unitId: input.unitId,
      panelId: input.panelId,
      packId: input.packId,
      expectedRevision: input.expectedRevision,
      currentRevision: snapshot.unit.revision,
    });
  }
}

function rejectStudioGenerationPrecondition(
  error: unknown,
  entityType: StudioGenerationCommandEntity,
  context: { unitId?: string; panelId?: string; packId?: string; expectedRevision?: number },
): never {
  if (isRejectedCommandFailure(error)) throw error;
  if (!(error instanceof StudioGenerationFreezeError) && !(error instanceof StudioGenerationLedgerError)) throw error;
  const code = error.code;
  const storageFailure = code === "storage-invalid"
    || code === "pack-cas-drift"
    || code === "result-media-drift"
    || code === "media-drift";
  const reason = storageFailure
    ? undefined
    : error instanceof StudioGenerationResultConflictError
      ? "result_conflict"
      : code === "unit-not-found" || code === "panel-not-found" || code === "pack-not-found"
        ? "not_found"
        : code.includes("conflict") || code.includes("drift")
          ? "revision_conflict"
          : "validation_failed";
  // 存储或实测 SHA 损坏的提交结果不能被误记为安全的写前拒绝。
  if (!reason) throw error;
  rejectStudioGenerationCommand({
    entityType,
    reason,
    code,
    message: error.message,
    ...context,
  });
}

function rejectStudioAgentImagegenBundlePrecondition(
  error: unknown,
  context: { packId: string; expectedRevision: number },
): never {
  if (isRejectedCommandFailure(error)) throw error;
  if (error instanceof StudioGenerationFreezeError || error instanceof StudioGenerationLedgerError) {
    rejectStudioGenerationPrecondition(error, "studio_generation_result_bundle", context);
  }
  if (error instanceof ActiveManagedStudioContextError) {
    rejectStudioGenerationCommand({
      entityType: "studio_generation_result_bundle",
      reason: "project_context_conflict",
      code: error.code,
      message: error.message,
      ...context,
    });
  }
  if (error instanceof StudioAgentImagegenBundleError) {
    const conflict = error.code === "pack-conflict"
      || error.code === "provider-mismatch"
      || error.code === "result-conflict"
      || error.code === "receipt-drift"
      || error.code === "labeled-conflict";
    rejectStudioGenerationCommand({
      entityType: "studio_generation_result_bundle",
      reason: conflict ? "revision_conflict" : "validation_failed",
      code: error.code,
      message: error.message,
      ...context,
    });
  }
  // labeled 在 CAS/media/ledger 任一写入前先以内存渲染；其校验、解码或渲染错误
  // 均是已确认的写前失败，不能锁成 OUTCOME_UNKNOWN。
  if (error instanceof StudioLabeledLayoutError) {
    rejectStudioGenerationCommand({
      entityType: "studio_generation_result_bundle",
      reason: "validation_failed",
      code: `labeled-${error.code}`,
      message: error.message,
      ...context,
    });
  }
  throw error;
}

export async function executeStudioCommand(
  projectRoot: string,
  request: StudioRuntimeCommandRequest,
  operationId: string,
): Promise<unknown> {
  switch (request.command) {
    case "initialize_material_studio": {
      return initializeMaterialStudio(projectRoot);
    }
    case "import_studio_media": {
      const media = await importStudioMedia(projectRoot, request.payload);
      return {
        sha256: media.sha256,
        kind: media.kind,
        sizeBytes: media.sizeBytes,
        mimeType: media.mimeType,
        sourceBasename: media.sourceBasename,
        derivativeStatus: media.derivativeStatus,
        thumbnail: media.thumbnail ? {
          recipe: media.thumbnail.recipe,
          recipeKey: media.thumbnail.recipeKey,
          width: media.thumbnail.width,
          height: media.thumbnail.height,
          format: media.thumbnail.format,
        } : undefined,
        createdAt: media.createdAt,
      };
    }
    case "attach_studio_multimedia_timeline_media": {
      const deterministicRejection = deterministicStudioTimelineRejection(request);
      if (deterministicRejection) {
        throw new RejectedCommandFailure(deterministicRejection, {
          code: "INVALID_STORYBOARD_TIMELINE_BINDING",
          committed: false,
        });
      }
      try {
        return await attachStudioMultimediaTimelineMedia(projectRoot, {
          ...request.payload,
          operationId: operationId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/^(?:媒体时码越出(?:单元范围| panel \d+ 的范围)|storyboard 绑定必须显式提供 panelIndex)/u.test(message)) {
          throw new RejectedCommandFailure(message, {
            code: "INVALID_STUDIO_TIMELINE_RANGE",
            committed: false,
          });
        }
        throw error;
      }
    }
    case "create_studio_asset": {
      return createStudioCanonicalAsset(projectRoot, request.payload);
    }
    case "update_studio_asset": {
      return updateStudioCanonicalAsset(projectRoot, request.payload);
    }
    case "append_studio_asset_relation": {
      return appendStudioAssetRelation(projectRoot, request.payload);
    }
    case "append_studio_asset_version": {
      return appendStudioAssetVersion(projectRoot, request.payload);
    }
    case "review_studio_asset_version": {
      return reviewStudioAssetVersion(projectRoot, request.payload);
    }
    case "set_studio_primary_authority": {
      return setStudioPrimaryAuthority(projectRoot, request.payload);
    }
    case "export_studio_cross_project_asset_package": {
      return exportStudioCrossProjectAssetPackage(projectRoot, request.payload);
    }
    case "import_studio_cross_project_asset_package": {
      return importStudioCrossProjectAssetPackage(projectRoot, request.payload);
    }
    case "reuse_studio_global_resource": {
      return reuseStudioGlobalResource(projectRoot, request.payload, {
        commandRequestHash: operationId,
      });
    }
    case "initialize_studio_production": {
      return initializeStudioProduction(projectRoot);
    }
    case "create_studio_script_document": {
      return createStudioScriptDocument(projectRoot, request.payload);
    }
    case "create_studio_prompt_document": {
      return createStudioPromptDocument(projectRoot, request.payload);
    }
    case "append_studio_script_revision": {
      return appendStudioScriptRevision(projectRoot, request.payload);
    }
    case "append_studio_script_section_revision": {
      try {
        return await appendStudioScriptSectionRevision(projectRoot, request.payload);
      } catch (error) {
        rejectStudioScriptSectionConflict(error);
      }
    }
    case "append_studio_prompt_revision": {
      return appendStudioPromptRevision(projectRoot, request.payload);
    }
    case "create_studio_production_unit": {
      return createStudioProductionUnit(projectRoot, request.payload);
    }
    case "revise_studio_production_unit": {
      try {
        return await reviseStudioProductionUnit(projectRoot, request.payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof StudioProductionConflictError
          || /生产单元宫格总时长必须严格等于声明时长|宫格时间.+(?:空洞|重叠)|起止时间与时长不一致|durationSeconds 必须大于 0|宫格 id 重复|重复提及资产|禁止携带 sourceSpans|必须提供至少一条非空 sourceSpans|extension (?:不得作为首格|仅允许作为单元末尾)/u.test(message)) {
          throw new RejectedCommandFailure(message, {
            schemaVersion: 1,
            applied: false,
            entityType: "studio_production_unit",
            reason: error instanceof StudioProductionConflictError ? "revision_conflict" : "validation_failed",
            unitId: request.payload.unitId,
            expectedRevision: request.payload.expectedRevision,
            ...(error instanceof StudioProductionConflictError
              ? { currentRevision: error.actualRevision }
              : {}),
          });
        }
        throw error;
      }
    }
    case "materialize_local_creative_production_units": {
      return materializeLocalCreativeProductionUnits(projectRoot, {
        ...request.payload,
        idempotencyKey: operationId,
      });
    }
    case "analyze_studio_script_entities": {
      try {
        return await analyzeStudioScriptEntities(projectRoot, request.payload, {
          requestHash: operationId,
          reviewer: "codex",
        });
      } catch (error) {
        rejectStudioBindingPrecondition(error, request.payload);
      }
    }
    case "resolve_studio_entity_proposal": {
      try {
        return await resolveStudioEntityProposal(projectRoot, request.payload, {
          requestHash: operationId,
          reviewer: request.payload.reviewer,
        });
      } catch (error) {
        rejectStudioBindingPrecondition(error, request.payload);
      }
    }
    case "confirm_studio_panel_empty": {
      try {
        return await confirmStudioPanelEmptyFromControl(projectRoot, request.payload, {
          requestHash: operationId,
          reviewer: request.payload.reviewer,
        });
      } catch (error) {
        rejectStudioBindingPrecondition(error, request.payload);
      }
    }
    case "freeze_studio_asset_binding_set": {
      try {
        return await freezeStudioAssetBindingSetFromControl(projectRoot, request.payload, {
          requestHash: operationId,
          reviewer: "codex",
        });
      } catch (error) {
        rejectStudioBindingPrecondition(error, request.payload);
      }
    }
    case "freeze_studio_generation_pack": {
      const { expectedRevision, ...query } = request.payload;
      assertStudioGenerationExpectedRevision("studio_generation_pack", expectedRevision, query);
      if (isStudioUnitGridGenerationQuery(query)) {
        await assertStudioGenerationUnitRevision({
          projectRoot,
          entityType: "studio_generation_pack",
          unitId: query.unitId,
          expectedRevision,
        });
        try {
          return await freezeAndPersistStudioUnitGridGenerationPack(projectRoot, query);
        } catch (error) {
          rejectStudioGenerationPrecondition(error, "studio_generation_pack", {
            unitId: query.unitId,
            expectedRevision,
          });
        }
      }
      await assertStudioGenerationUnitRevision({
        projectRoot,
        entityType: "studio_generation_pack",
        unitId: query.unitId,
        panelId: query.panelId,
        expectedRevision,
      });
      try {
        // pack.target.unitRevision 锚定目标宫格 BindingSet 的历史修订；同单元其他宫格
        // 的无关修订不会改变该目标身份，因此不能把两者强行等同。
        // pack 是 Codex 本地生成所需的显式冻结数据；账本数据库和 pack CAS 路径不进入命令结果。
        return await freezeAndPersistStudioGenerationPack(projectRoot, query);
      } catch (error) {
        rejectStudioGenerationPrecondition(error, "studio_generation_pack", {
          unitId: query.unitId,
          panelId: query.panelId,
          expectedRevision,
        });
      }
    }
    case "dispatch_studio_generation_pack": {
      const { expectedRevision, ...dispatch } = request.payload;
      assertStudioGenerationExpectedRevision("studio_generation_dispatch", expectedRevision, { packId: dispatch.packId });
      try {
        const pack = await readAnyStudioGenerationFrozenPack(projectRoot, dispatch.packId);
        if (!pack) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_dispatch",
            reason: "not_found",
            message: `持久冻结包不存在：${dispatch.packId}`,
            packId: dispatch.packId,
            expectedRevision,
          });
        }
        if (pack.fingerprint !== dispatch.packFingerprint) {
          const panelId = pack.schemaVersion === 5 ? undefined : pack.target.panelId;
          rejectStudioGenerationCommand({
            entityType: "studio_generation_dispatch",
            reason: "revision_conflict",
            code: "pack-index-conflict",
            message: `packId ${dispatch.packId} 与 packFingerprint 不匹配。`,
            unitId: pack.target.unitId,
            ...(panelId ? { panelId } : {}),
            packId: dispatch.packId,
            expectedRevision,
            currentRevision: pack.target.unitRevision,
          });
        }
        if (pack.target.unitRevision !== expectedRevision) {
          const panelId = pack.schemaVersion === 5 ? undefined : pack.target.panelId;
          rejectStudioGenerationCommand({
            entityType: "studio_generation_dispatch",
            reason: "revision_conflict",
            code: "pack-drift",
            message: `冻结包 ${dispatch.packId} 属于 unit revision ${pack.target.unitRevision}，与 expectedRevision ${expectedRevision} 不一致。`,
            unitId: pack.target.unitId,
            ...(panelId ? { panelId } : {}),
            packId: dispatch.packId,
            expectedRevision,
            currentRevision: pack.target.unitRevision,
          });
        }
        return await dispatchStudioGenerationPack(projectRoot, dispatch);
      } catch (error) {
        rejectStudioGenerationPrecondition(error, "studio_generation_dispatch", {
          packId: dispatch.packId,
          expectedRevision,
        });
      }
    }
    case "prepare_studio_imagegen_call": {
      try {
        return await prepareStudioImagegenCall(projectRoot, {
          ...request.payload,
          commandRequestId: operationId,
        });
      } catch (error) {
        if (error instanceof ActiveManagedStudioContextError) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_call",
            reason: "project_context_conflict",
            code: error.code,
            message: error.message,
            packId: request.payload.packId,
            expectedRevision: request.payload.expectedRevision,
          });
        }
        rejectStudioGenerationPrecondition(error, "studio_generation_call", {
          packId: request.payload.packId,
          expectedRevision: request.payload.expectedRevision,
        });
      }
    }
    case "authorize_studio_unit_grid_continuation_waiver": {
      try {
        return await authorizeStudioUnitGridContinuationWaiver(projectRoot, request.payload);
      } catch (error) {
        if (error instanceof ActiveManagedStudioContextError) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_pack",
            reason: "project_context_conflict",
            code: error.code,
            message: error.message,
            unitId: request.payload.unitId,
            expectedRevision: request.payload.expectedUnitRevision,
          });
        }
        rejectStudioGenerationPrecondition(error, "studio_generation_pack", {
          unitId: request.payload.unitId,
          expectedRevision: request.payload.expectedUnitRevision,
        });
      }
    }
    case "reconcile_studio_imagegen_call": {
      if (request.payload.expectedRevision !== 0) {
        rejectStudioGenerationCommand({
          entityType: "studio_generation_call",
          reason: "invalid_revision",
          message: "Studio imagegen call reconcile expectedRevision 必须为 0。",
          expectedRevision: request.payload.expectedRevision,
        });
      }
      const { expectedRevision: _expectedRevision, ...reconciliation } = request.payload;
      try {
        await assertActiveManagedStudioContextToken(projectRoot, request.payload.projectContextToken);
        return await reconcileStudioImagegenCall(projectRoot, reconciliation);
      } catch (error) {
        if (error instanceof ActiveManagedStudioContextError) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_call",
            reason: "project_context_conflict",
            code: error.code,
            message: error.message,
            expectedRevision: request.payload.expectedRevision,
          });
        }
        rejectStudioGenerationPrecondition(error, "studio_generation_call", {});
      }
    }
    case "abandon_studio_generation_unknown": {
      if (request.payload.expectedRevision !== 0) {
        rejectStudioGenerationCommand({
          entityType: "studio_generation_call",
          reason: "invalid_revision",
          message: "Studio generation_unknown owner abandon expectedRevision 必须为 0。",
          expectedRevision: request.payload.expectedRevision,
        });
      }
      const { expectedRevision: _expectedRevision, ...abandonment } = request.payload;
      try {
        await assertActiveManagedStudioContextToken(projectRoot, request.payload.projectContextToken);
        return await abandonStudioGenerationUnknown(projectRoot, abandonment);
      } catch (error) {
        if (error instanceof ActiveManagedStudioContextError) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_call",
            reason: "project_context_conflict",
            code: error.code,
            message: error.message,
            expectedRevision: request.payload.expectedRevision,
          });
        }
        rejectStudioGenerationPrecondition(error, "studio_generation_call", {
          expectedRevision: request.payload.expectedRevision,
        });
      }
    }
    case "abandon_studio_detached_generation_unknown": {
      if (request.payload.expectedRevision !== 0) {
        rejectStudioGenerationCommand({
          entityType: "studio_generation_call",
          reason: "invalid_revision",
          message: "Studio detached generation_unknown owner abandon expectedRevision 必须为 0。",
          expectedRevision: request.payload.expectedRevision,
        });
      }
      const { expectedRevision: _expectedRevision, ...abandonment } = request.payload;
      try {
        const activeContext = await assertActiveManagedStudioContextToken(
          projectRoot,
          request.payload.projectContextToken,
        );
        return await abandonStudioDetachedGenerationUnknown(projectRoot, {
          ...abandonment,
          activeContext: {
            projectId: activeContext.projectId,
            manifestFingerprint: activeContext.manifestFingerprint,
            buildId: activeContext.build.buildId,
            sourceDigest: activeContext.build.sourceDigest,
          },
        });
      } catch (error) {
        if (error instanceof ActiveManagedStudioContextError) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_call",
            reason: "project_context_conflict",
            code: error.code,
            message: error.message,
            expectedRevision: request.payload.expectedRevision,
          });
        }
        rejectStudioGenerationPrecondition(error, "studio_generation_call", {
          expectedRevision: request.payload.expectedRevision,
        });
      }
    }
    case "rebind_studio_imagegen_call_context": {
      if (request.payload.expectedRevision !== 0) {
        rejectStudioGenerationCommand({
          entityType: "studio_generation_call",
          reason: "invalid_revision",
          message: "Studio imagegen context rebind expectedRevision 必须为 0。",
          expectedRevision: request.payload.expectedRevision,
        });
      }
      const { expectedRevision: _expectedRevision, ...rebind } = request.payload;
      try {
        await assertActiveManagedStudioContextToken(projectRoot, request.payload.projectContextToken);
        return await rebindStudioImagegenCallContext(projectRoot, rebind);
      } catch (error) {
        if (error instanceof ActiveManagedStudioContextError) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_call",
            reason: "project_context_conflict",
            code: error.code,
            message: error.message,
            expectedRevision: request.payload.expectedRevision,
          });
        }
        rejectStudioGenerationPrecondition(error, "studio_generation_call", {
          expectedRevision: request.payload.expectedRevision,
        });
      }
    }
    case "register_studio_generation_result": {
      const { expectedRevision, ...registration } = request.payload;
      assertStudioGenerationExpectedRevision("studio_generation_result", expectedRevision, { packId: registration.packId });
      try {
        const pack = await readPersistedStudioGenerationPack(projectRoot, registration.packId);
        if (!pack) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_result",
            reason: "not_found",
            message: `持久冻结包不存在：${registration.packId}`,
            packId: registration.packId,
            expectedRevision,
          });
        }
        if (pack.fingerprint !== registration.packFingerprint) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_result",
            reason: "revision_conflict",
            code: "pack-index-conflict",
            message: `packId ${registration.packId} 与 packFingerprint 不匹配。`,
            unitId: pack.target.unitId,
            panelId: pack.target.panelId,
            packId: registration.packId,
            expectedRevision,
            currentRevision: pack.target.unitRevision,
          });
        }
        if (pack.target.unitRevision !== expectedRevision) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_result",
            reason: "revision_conflict",
            code: "pack-drift",
            message: `冻结包 ${registration.packId} 属于 unit revision ${pack.target.unitRevision}，与 expectedRevision ${expectedRevision} 不一致。`,
            unitId: pack.target.unitId,
            panelId: pack.target.panelId,
            packId: registration.packId,
            expectedRevision,
            currentRevision: pack.target.unitRevision,
          });
        }
        return await registerStudioGenerationResult(projectRoot, registration);
      } catch (error) {
        rejectStudioGenerationPrecondition(error, "studio_generation_result", {
          packId: registration.packId,
          expectedRevision,
        });
      }
    }
    case "commit_agent_imagegen_result_bundle": {
      const { packId, expectedRevision } = request.payload;
      assertStudioGenerationExpectedRevision(
        "studio_generation_result_bundle",
        expectedRevision,
        { packId },
      );
      try {
        await assertNoActiveStudioHiggsfieldConnectorReservation(projectRoot, request.payload.generationRunId);
        return await commitAgentImagegenResultBundle(projectRoot, request.payload);
      } catch (error) {
        rejectStudioAgentImagegenBundlePrecondition(error, { packId, expectedRevision });
      }
    }
    case "create_studio_generation_plan": {
      try {
        return await createStudioGenerationPlan(projectRoot, {
          nodes: request.payload.nodes,
          sourceCommandRequestId: operationId,
        });
      } catch (error) {
        rejectStudioGenerationPrecondition(error, "studio_generation_plan", {});
      }
    }
    case "fail_studio_generation_run": {
      try {
        await assertNoActiveStudioHiggsfieldConnectorReservation(projectRoot, request.payload.generationRunId);
        return await failStudioGenerationRun(projectRoot, request.payload);
      } catch (error) {
        rejectStudioGenerationPrecondition(error, "studio_generation_run", {});
      }
    }
    case "cancel_studio_generation_run": {
      try {
        await assertNoActiveStudioHiggsfieldConnectorReservation(projectRoot, request.payload.generationRunId);
        return await cancelStudioGenerationRun(projectRoot, request.payload);
      } catch (error) {
        rejectStudioGenerationPrecondition(error, "studio_generation_run", {});
      }
    }
    case "retry_studio_generation_plan_nodes": {
      try {
        return await retryStudioGenerationPlanNodes(projectRoot, request.payload);
      } catch (error) {
        rejectStudioGenerationPrecondition(error, "studio_generation_plan", {});
      }
    }
    case "append_studio_continuity_observation": {
      return appendStudioContinuityObservation(projectRoot, {
        ...request.payload,
        operationId: operationId,
      });
    }
    case "append_studio_continuity_correction": {
      return appendStudioContinuityCorrection(projectRoot, {
        ...request.payload,
        operationId: operationId,
      });
    }
    case "submit_studio_generation_review": {
      return submitStudioGenerationReview(projectRoot, {
        ...request.payload,
        operationId: operationId,
      });
    }
    case "submit_studio_post_result_observation": {
      return submitStudioPostResultObservation(projectRoot, {
        ...request.payload,
        operationId: operationId,
      });
    }
    case "refresh_studio_generation_checkpoint": {
      return refreshStudioGenerationCheckpoint(projectRoot, {
        ...request.payload,
        operationId: operationId,
      });
    }
    case "attest_studio_generation_checkpoint": {
      return attestStudioGenerationCheckpoint(projectRoot, {
        ...request.payload,
        operationId: operationId,
      });
    }
    case "finalize_dudu_readonly_managed_project": {
      const discovery = await discoverDuduReadonlyImportProjects(path.dirname(projectRoot));
      if (discovery.fingerprint !== request.payload.expectedDiscoveryFingerprint
        || discovery.status !== "single"
        || discovery.candidates.length !== 1
        || discovery.candidates[0]!.projectRoot !== path.resolve(projectRoot)) {
        rejectP30OrchestrationCommand({
          entityType: "dudu_readonly_import",
          reason: "control_conflict",
          message: "Dudu finalize discovery 已变化或存在多候选，禁止选择第一个。",
          expectedFingerprint: request.payload.expectedDiscoveryFingerprint,
          currentFingerprint: discovery.fingerprint,
        });
      }
      const control = await getDuduReadonlyImportControl(projectRoot);
      if (request.payload.expectedRevision !== 0) {
        rejectP30OrchestrationCommand({
          entityType: "dudu_readonly_import",
          reason: "invalid_revision",
          message: "Dudu finalize expectedRevision 必须为 0。",
          expectedRevision: request.payload.expectedRevision,
        });
      }
      if (control.fingerprint !== request.payload.expectedControlFingerprint
        || control.identity.importReceiptFingerprint !== request.payload.expectedImportFingerprint) {
        rejectP30OrchestrationCommand({
          entityType: "dudu_readonly_import",
          reason: "control_conflict",
          message: "Dudu finalize control/import 身份已变化，请重新读取只读控制面。",
          expectedFingerprint: request.payload.expectedControlFingerprint,
          currentFingerprint: control.fingerprint,
        });
      }
      return finalizeDuduReadonlyManagedProject(projectRoot, request.payload.source, {
        commandRequestHash: operationId,
      });
    }
    case "reconcile_dudu_readonly_historical_passes": {
      const control = await getDuduReadonlyImportControl(projectRoot);
      if (request.payload.expectedRevision !== 0 || control.status !== "active"
        || control.fingerprint !== request.payload.expectedControlFingerprint) {
        rejectP30OrchestrationCommand({
          entityType: "dudu_readonly_import",
          reason: "control_conflict",
          message: "Dudu 历史 PASS 回填控制面已变化或并非 active，禁止写入。",
          expectedFingerprint: request.payload.expectedControlFingerprint,
          currentFingerprint: control.fingerprint,
        });
      }
      return reconcileDuduReadonlyHistoricalPasses(projectRoot, request.payload.source);
    }
    case "prepare_studio_video_package_export": {
      const control = await getStudioVideoPackageControl(projectRoot, {
        by: "authority-latest",
        authority: request.payload.authority,
      });
      if (control.fingerprint !== request.payload.expectedControlFingerprint) {
        rejectP30OrchestrationCommand({
          entityType: "studio_video_package",
          reason: "control_conflict",
          message: "视频包 authority 控制面已变化，请重新读取后再 prepare。",
          expectedFingerprint: request.payload.expectedControlFingerprint,
          currentFingerprint: control.fingerprint,
        });
      }
      if (control.status === "conflict" || control.nextAction === "resolve-video-package-ledger-conflict") {
        rejectP30OrchestrationCommand({
          entityType: "studio_video_package",
          reason: "control_conflict",
          message: "视频包 authority 存在目的地或换代链冲突，禁止 prepare 并选择任一候选。",
          expectedFingerprint: request.payload.expectedControlFingerprint,
          currentFingerprint: control.fingerprint,
        });
      }
      try {
        return await prepareStudioVideoPackageExport(projectRoot, {
          operationId: operationId,
          authority: request.payload.authority,
          expectedRevision: request.payload.expectedRevision,
          ...(request.payload.expectedManagedSource
            ? { expectedManagedSource: request.payload.expectedManagedSource }
            : {}),
        });
      } catch (error) {
        if (error instanceof StudioVideoPackageError) {
          rejectP30OrchestrationCommand({
            entityType: "studio_video_package",
            reason: error.code === "operation-conflict" ? "revision_conflict" : "validation_failed",
            message: error.message,
            expectedRevision: request.payload.expectedRevision,
          });
        }
        throw error;
      }
    }
    case "build_studio_video_package": {
      const intentLookup = await getStudioVideoPackageControl(projectRoot, {
        by: "intent",
        intentId: request.payload.intentId,
      });
      if (intentLookup.fingerprint !== request.payload.expectedIntentControlFingerprint) {
        rejectP30OrchestrationCommand({
          entityType: "studio_video_package",
          reason: "control_conflict",
          message: "视频包 intent 控制面已变化，请重新读取后再 build。",
          expectedFingerprint: request.payload.expectedIntentControlFingerprint,
          currentFingerprint: intentLookup.fingerprint,
        });
      }
      const intent = intentLookup.control?.intent;
      if (!intent || intent.intentId !== request.payload.intentId) {
        rejectP30OrchestrationCommand({
          entityType: "studio_video_package",
          reason: "control_conflict",
          message: "视频包 intent 控制面未解析到唯一 intent。",
        });
      }
      if (intent.unitRevision !== request.payload.expectedRevision) {
        rejectP30OrchestrationCommand({
          entityType: "studio_video_package",
          reason: "revision_conflict",
          message: "视频包 intent unit revision 已变化，请刷新后再 build。",
          expectedRevision: request.payload.expectedRevision,
          currentRevision: intent.unitRevision,
        });
      }
      const authority: StudioVideoPackageAuthorityInput = intent.authorityKind === "historical-import"
        ? { kind: "historical-import", packId: intent.packId }
        : { kind: "studio-review", reviewId: intent.authorityId };
      const authorityLookup = await getStudioVideoPackageControl(projectRoot, {
        by: "authority-latest",
        authority,
      });
      if (authorityLookup.fingerprint !== request.payload.expectedAuthorityControlFingerprint
        || authorityLookup.status !== "resolved"
        || authorityLookup.selectedIntentId !== intent.intentId
        || authorityLookup.selectedIsDestinationHead !== true
        || authorityLookup.control?.intent.intentId !== intent.intentId) {
        rejectP30OrchestrationCommand({
          entityType: "studio_video_package",
          reason: "control_conflict",
          message: "视频包 intent 已不是 authority-latest/destination head，拒绝 build。",
          expectedFingerprint: request.payload.expectedAuthorityControlFingerprint,
          currentFingerprint: authorityLookup.fingerprint,
        });
      }
      return buildAndVerifyStudioVideoPackage(projectRoot, request.payload.intentId, {
        expectedRevision: request.payload.expectedRevision,
        destinationPolicy: request.payload.destinationPolicy,
        commandRequestHash: operationId,
      });
    }
    case "enqueue_studio_higgsfield_connector_request": {
      return enqueueStudioHiggsfieldConnectorRequest(projectRoot, request.payload);
    }
    case "claim_studio_higgsfield_connector_request": {
      return claimStudioHiggsfieldConnectorRequest(projectRoot, request.payload);
    }
    case "preflight_studio_higgsfield_connector_request": {
      return preflightStudioHiggsfieldConnectorRequest(projectRoot, request.payload);
    }
    case "authorize_studio_higgsfield_connector_request": {
      // active-project fence 与 projectContextToken 复检由 command-bus 可靠性壳持有。
      // executor 只在同一 fence 内读取 owner、构建完整输入并落业务授权。
      const current = await getStudioHiggsfieldConnectorRequest(projectRoot, request.payload.requestId);
      if (!current || current.revision !== request.payload.expectedRevision || current.status !== "claimed") {
        throw new RejectedCommandFailure("Higgsfield 授权前请求状态或 revision 已变化。 ", {
          schemaVersion: 1, applied: false, reason: "revision-or-state-conflict",
        });
      }
      let connectorRequest;
      try {
        await assertStudioHiggsfieldConnectorOwnerCurrent(projectRoot, current.requestKind === "image"
          ? { kind: "image", imageGenerationRunId: current.imageGenerationRunId ?? "" }
          : { kind: "video", intentId: current.intentId ?? "" });
        connectorRequest = current.requestKind === "image"
          ? await buildStudioHiggsfieldImageConnectorRequest(projectRoot, current.imageGenerationRunId!)
          : await buildStudioHiggsfieldVideoConnectorRequest(projectRoot, current.intentId!);
      } catch (error) {
        if (isRejectedCommandFailure(error) || isConfirmedCommandFailure(error)) throw error;
        throw new RejectedCommandFailure(error instanceof Error ? error.message : String(error), {
          schemaVersion: 1, applied: false, reason: "connector-owner-not-current",
        });
      }
      const authorization = await authorizeStudioHiggsfieldConnectorRequest(projectRoot, request.payload);
      return { ...authorization, callAllowed: true as const, connectorRequest };
    }
    case "record_studio_higgsfield_connector_submission": {
      return recordStudioHiggsfieldConnectorSubmission(projectRoot, request.payload);
    }
    case "reconcile_studio_higgsfield_connector_request": {
      return reconcileStudioHiggsfieldConnectorRequest(projectRoot, request.payload);
    }
    case "prepare_studio_higgsfield_video_generation": {
      // 公共写命令绝不接受调用方伪造的 Unlimited capability；Core 用当前
      // connector 观察的 fail-closed 默认值。active-project fence 由 bus 持有。
      return prepareStudioHiggsfieldVideoGeneration(projectRoot, request.payload);
    }
    case "record_studio_higgsfield_video_submission": {
      return recordStudioHiggsfieldSubmission(projectRoot, request.payload);
    }
    case "attest_studio_higgsfield_connector_capability": {
      return attestStudioHiggsfieldConnectorCapability(projectRoot, request.payload);
    }
  }
}
