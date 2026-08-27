import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFERRED_VIDEO_ENGINE_CAPABILITY, withEditor } from "./editor-lazy.js";
import { loadSharp } from "./sharp-lazy.js";
import { generationPublicationTerminalMatchesJob, getGenerationSettings, getHttpGenerationSubmissionCheckpoint, listGenerationJobs } from "./generation.js";
import { getContinuationSnapshot, listProjectContext } from "./memory.js";
import { getReviewQueue, listReviewRecords } from "./reviews.js";
import { getNextTask } from "./service.js";
import { getSidecarPaths, listEvents, listTaskPacks, loadIndex, loadProjectConfig, readJson } from "./sidecar.js";
import { readAgentSkills } from "./skills.js";
import { NOVEL_AGENT_CAPABILITIES } from "./novel-agent-capabilities.js";
import { withAdaptation } from "./adaptation-lazy.js";
import { withStory } from "./story-lazy.js";
import { withNovelAnalysisProvider } from "./novel-analysis-provider-lazy.js";
import { getNovelAnalysisProviderSettings } from "./novel-analysis-provider-settings.js";
import { auditExistingProductionBaselines, getProductionWorkflow, getStoryboard, listCreativeBibles } from "./production.js";
import { listAssetRelations, listVoiceIdentities } from "./asset-registry.js";
import { listProjectLocks } from "./locks.js";
import { listPublicationIntents, publicationTargetExists } from "./publication.js";
import { listCommandLedger } from "./command-bus.js";
import { resolveRuntimeBuildIdentity, type BuildIdentity } from "./build-identity.js";
import { assertRuntimeBuildCurrentness } from "./project-backup.js";
import { getCanvasHistoryInfo, getCanvasSemanticState } from "./canvas-state.js";
import { getFusionAssetConsistencyState, type FusionAssetConsistencyState } from "./fusion-asset-consistency.js";
import { getUnitTimelines } from "./timeline.js";
import { getMachineMediaRuntimeConfig, MEDIA_WEIGHTS, projectMediaKey, readMachineMediaRuntimeSnapshot } from "./media-runtime.js";
import type { GenerationSettings, NovelAnalysisProviderSettings, ProductionWorkflow, ProductionWorkflowEvidenceStageSummary, ProductionWorkflowEvidenceSummary, ProjectIndex, WorkItem } from "./types.js";
import { inspectFusionPanelReferenceCurrentness, loadFusionPanelReferenceStore, loadFusionPanelReferenceStoreSnapshot, type FusionPanelReferenceCurrentness, type FusionPanelReferenceResolutionStore } from "./fusion-panel-references.js";
import { inspectManagedProject } from "./managed-project.js";
import { verifyStudioMediaObject } from "./material-studio.js";
import { getStudioProductionUnitSnapshot } from "./studio-production.js";
import {
  assertStudioGenerationFreezePackCurrent,
  buildStudioAgentImagegenBrief,
  queryStudioGenerationFreeze,
  type StudioCodexControlReference,
  type StudioCodexGenerationRequest,
  type StudioGenerationFreezePack,
} from "./studio-generation.js";
import {
  buildStudioGenerationSessionSnapshot,
  historyEnvelopeConsistencyPeek,
} from "./studio-generation-session-snapshot.js";
import {
  getStudioGenerationLatestPlanForPanel,
  getStudioGenerationLatestPlanForUnitGrid,
  getStudioGenerationPlanProjection,
  listStudioDetachedGenerationUnknownDispositions,
  listStudioDetachedGenerationUnknownObservations,
  listStudioGenerationActiveRuns,
  listStudioGenerationPanelHistory,
  listStudioGenerationPlanProjections,
  listStudioGenerationUnitGridHistory,
  readAnyStudioGenerationFrozenPack,
  readStudioImagegenCallEventHistory,
  readStudioImagegenCallIntentByRun,
} from "./studio-generation-ledger.js";
import {
  STUDIO_FORMAL_IMAGEGEN_ALLOWED_PROVIDERS,
  providerToolHints,
  type StudioFormalImagegenProvider,
} from "./studio-imagegen-providers.js";
import {
  CHARACTER_BACK_REFERENCE_TOOL_NOTE,
  EXTENSION_SHOT_TYPE_TOOL_NOTE,
  FROZEN_PANEL_LIGHTING_COSTUME_TOOL_NOTE,
  PROP_BACK_REFERENCE_TOOL_NOTE,
  SCENE_BACK_REFERENCE_TOOL_NOTE,
  UNIT_BEAT_TOOL_NOTE,
  STYLE_LOCK_TOOL_NOTE,
  UNIT_GRID_PREVIOUS_STANDING_TOOL_NOTE,
  frozenPanelCostumeFromAnyFrozenPack,
  frozenPanelLightingFromAnyFrozenPack,
  previousStandingFromFrozenRenderedPrompt,
} from "./studio-panel-standing.js";
import {
  assertStudioUnitGridGenerationFreezePackCurrent,
  queryStudioUnitGridGenerationFreeze,
  type StudioUnitGridCodexGenerationRequest,
  type StudioUnitGridControlReference,
  type StudioUnitGridGenerationFreezePack,
} from "./studio-unit-grid-generation.js";
import {
  composeUnitGridBriefContract,
  renderUnitGridBriefContractText,
} from "./unit-grid-brief-contract.js";
import {
  AI_CANVAS_APPLICATION_VERSION,
  AI_CANVAS_PROTOCOL_VERSION,
} from "./release-manifest.js";
import { withStudioRequestSchemaCache } from "./studio-request-schema-cache.js";
import {
  activeRunsEnvelopeNext,
  composeStudioGenerationPlanDraft,
  historyEnvelopeNext,
  packEnvelopeNextOverrideForUnitGridBlocking,
  planOperationEnvelopeNext,
  refineNextIfUnexpectedRevisionImpact,
  refineStudioGenerationPlanDraftIfUnitGridBlocking,
  type PersistedPlanNodeStatus,
  type Ssl5RevisionImpactHint,
} from "./studio-generation-plan-draft.js";
import {
  generationLedgerSidecarPath,
  readPersistedPanelPlanState,
  readPersistedUnitGridPlanState,
} from "./studio-unit-grid-persisted-plan-read.js";

export { AI_CANVAS_PROTOCOL_VERSION } from "./release-manifest.js";

export interface DoctorCheck {
  id: string;
  level: "ok" | "warning" | "error";
  title: string;
  detail: string;
  suggestedAction?: string;
  paths?: string[];
}

function sanitizeDiagnosticText(value: string | undefined): string | undefined {
  return value?.replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|signature|sig|credential|authorization|set[_-]?cookie|cookie|password|secret)["']?\s*[:=]\s*)["']?[^\s,"'}]+/gi, "$1[redacted]")
    .slice(0, 2_000);
}

function sanitizeDiagnosticValue<T>(value: T): T {
  if (typeof value === "string") return sanitizeDiagnosticText(value) as T;
  if (Array.isArray(value)) return value.map((entry) => sanitizeDiagnosticValue(entry)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, sanitizeDiagnosticValue(entry)])) as T;
  return value;
}

function sanitizedRemoteObservation<T extends { message: string } | undefined>(value: T): T {
  return value ? { ...value, message: sanitizeDiagnosticText(value.message) ?? "", observedStatus: sanitizeDiagnosticText((value as { observedStatus?: string }).observedStatus) } as T : value;
}

export type StudioGenerationControlQuery =
  | { operation: "session-snapshot"; unitId: string; panelId?: string }
  | {
      operation: "readiness";
      targetKind?: "panel";
      unitId: string;
      panelId: string;
      revisionImpact?: Ssl5RevisionImpactHint;
    }
  | {
      operation: "readiness";
      targetKind: "unit-grid";
      unitId: string;
      continuationWaiver?: { receiptId: string; receiptFingerprint: string };
      revisionImpact?: Ssl5RevisionImpactHint;
    }
  | { operation: "pack"; packId: string }
  | { operation: "history"; targetKind?: "panel"; unitId: string; panelId: string; cursor?: string; limit?: number; order?: "oldest-first" | "newest-first" }
  | { operation: "history"; targetKind: "unit-grid"; unitId: string; cursor?: string; limit?: number; order?: "oldest-first" | "newest-first" }
  | {
      operation: "plan";
      planId?: string;
      targetKind?: "panel" | "unit-grid";
      unitId?: string;
      panelId?: string;
      revisionImpact?: Ssl5RevisionImpactHint;
    }
  | { operation: "call"; generationRunId: string }
  | { operation: "active-runs"; targetKind?: "panel"; unitId: string; panelId: string }
  | { operation: "active-runs"; targetKind: "unit-grid"; unitId: string }
  | { operation: "detached-unknown"; unitId: string };

const STUDIO_GENERATION_CONTROL_KIND = "studio-codex-generation-control-envelope" as const;
const STUDIO_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function isStrictlyWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function projectedStudioGenerationPack(
  pack: StudioGenerationFreezePack,
  request: StudioCodexGenerationRequest,
) {
  return {
    ...pack,
    assets: pack.assets.map((asset) => {
      const { objectPath: _objectPath, ...media } = asset.media;
      return { ...asset, media };
    }),
    request,
  };
}

function unitGridReferenceWithoutPath(reference: StudioUnitGridControlReference) {
  const { localPath: _localPath, ...publicReference } = reference;
  return publicReference;
}

function panelRequestWithoutPaths(request: StudioCodexGenerationRequest) {
  return {
    ...request,
    controlReferences: request.controlReferences.map((reference) => {
      const { localPath: _localPath, ...publicReference } = reference;
      return publicReference;
    }),
  };
}

function projectedStudioUnitGridGenerationPack(
  pack: StudioUnitGridGenerationFreezePack,
  request: StudioUnitGridCodexGenerationRequest,
) {
  return {
    ...pack,
    controlReferences: pack.controlReferences.map(unitGridReferenceWithoutPath),
    panels: pack.panels.map((panel) => ({
      ...panel,
      panelPack: projectedStudioGenerationPack(
        panel.panelPack,
        panelRequestWithoutPaths(panel.panelPack.request) as StudioCodexGenerationRequest,
      ),
    })),
    request,
  };
}

function projectedEvidenceReference(reference: string) {
  return path.isAbsolute(reference)
    ? { scope: "external" as const, basename: path.basename(reference) }
    : { scope: "logical" as const, reference };
}

/** 供 MCP readiness/pack 与单测共用的 unit-grid Agent 简报构建（正式产品路径）。 */
export function buildStudioUnitGridAgentImagegenBrief(
  pack: StudioUnitGridGenerationFreezePack,
  provider: StudioFormalImagegenProvider,
) {
  const controlReferences = pack.request.controlReferences.map((reference) => ({
    assetId: reference.coveredAssetIds[0] ?? reference.referenceId,
    mediaSha256: reference.mediaSha256,
    categories: reference.categories,
    roles: reference.roles,
    referenceUsages: reference.referenceUsages ?? reference.coveredAssetIds.map((assetId) => ({
      assetId,
      usage: {
        purpose: reference.categories.includes("continuity") ? "continuity" as const : "identity" as const,
        inheritOnly: ["all"],
        excludeFromOutput: [],
        carrierPolicy: "none" as const,
      },
    })),
    fingerprint: reference.fingerprint,
  }));
  // 九字段站位摘要：从各格 panelPack continuity heads 投影，供 Agent 保持一致性。
  const continuityNineFieldSummary = pack.panels.flatMap((panel) => {
    const assets = panel.panelPack.continuity?.assets ?? [];
    return assets.flatMap((asset) => {
      const fields = Object.fromEntries(
        (asset.heads ?? []).map((head) => [
          head.field,
          head.state.status === "resolved" ? (head.state.value ?? "") : (head.state.reason ?? head.state.status),
        ]),
      );
      return [{
        panelId: panel.panelId,
        assetId: asset.assetId,
        fields,
        requiredFields: asset.requiredFields ?? [],
        readinessFingerprint: asset.readinessFingerprint,
      }];
    });
  });
  if (controlReferences.length === 0) {
    throw new Error("unit-grid Agent brief 缺少 controlReferences，禁止降级 text-only。");
  }
  const promptContract = composeUnitGridBriefContract(pack);
  const previousStandings = pack.panels.map((panel) => ({
    panelId: panel.panelId,
    previousStanding: previousStandingFromFrozenRenderedPrompt(panel.panelPack),
  }));
  const frozenPanelOverlays = pack.panels.flatMap((panel) => {
    const lighting = frozenPanelLightingFromAnyFrozenPack(panel.panelPack);
    const costume = frozenPanelCostumeFromAnyFrozenPack(panel.panelPack);
    if (!lighting && !costume) return [];
    return [{ panelId: panel.panelId, lighting, costume }];
  });
  const tool = providerToolHints(provider);
  return {
    schemaVersion: 1 as const,
    kind: "studio-agent-imagegen-brief" as const,
    provider,
    executorKind: pack.request.executorKind,
    exactlyOneImage: pack.request.exactlyOneImage,
    maxCalls: pack.request.maxCalls,
    target: pack.target,
    layout: pack.request.modelPayload.layout,
    prompt: pack.request.modelPayload.renderedPrompt,
    promptContract,
    promptContractText: renderUnitGridBriefContractText(promptContract),
    previousStandings,
    ...(frozenPanelOverlays.length > 0 ? { frozenPanelOverlays } : {}),
    forbidden: pack.request.forbidden,
    referenceCount: pack.request.controlReferences.length,
    controlReferences,
    ...(pack.continuationSource
      ? {
          continuationSource: {
            ...pack.continuationSource,
            canonicalIdentityPriority: true as const,
          },
        }
      : {}),
    continuityFingerprint: pack.continuityFingerprint,
    continuityNineFieldSummary,
    referencePathSource: "pack-operation-controlReferences-only" as const,
    tool: {
      ...tool,
      notes: [
        ...tool.notes,
        FROZEN_PANEL_LIGHTING_COSTUME_TOOL_NOTE,
        SCENE_BACK_REFERENCE_TOOL_NOTE,
        PROP_BACK_REFERENCE_TOOL_NOTE,
        CHARACTER_BACK_REFERENCE_TOOL_NOTE,
        EXTENSION_SHOT_TYPE_TOOL_NOTE,
        UNIT_BEAT_TOOL_NOTE,
        STYLE_LOCK_TOOL_NOTE,
        UNIT_GRID_PREVIOUS_STANDING_TOOL_NOTE,
      ],
    },
  };
}

async function verifiedStudioControlReferences(
  projectRoot: string,
  pack: StudioGenerationFreezePack,
  options: { assertCurrentness?: boolean } = {},
): Promise<StudioCodexControlReference[]> {
  const shell = await inspectManagedProject(projectRoot);
  if (pack.projectId !== shell.project.id || pack.managedManifestFingerprint !== shell.manifestFingerprint) {
    throw new Error("Codex generation 冻结包与当前受管项目身份不一致。");
  }
  if (options.assertCurrentness !== false) {
    await assertStudioGenerationFreezePackCurrent(shell.paths.root, pack);
  }

  const authoritativeControls = pack.panelReferenceResolution.controlReferences;
  if (pack.panelReferenceResolution.overflowControlReferences.length > 0
    || authoritativeControls.length !== pack.request.controlReferences.length) {
    throw new Error("Codex generation 请求与 PanelReferenceResolution 控制引用数量不一致。");
  }
  const requestReferenceByAsset = new Map(pack.request.controlReferences.map((reference) => [reference.assetId, reference] as const));
  for (const control of authoritativeControls) {
    if (control.kind !== "asset" || control.readiness !== "ready"
      || control.coveredAssetIds.length !== 1 || !control.contentAddress
      || !control.contentAddress.startsWith("sha256:")) {
      throw new Error(`PanelReferenceResolution 控制引用 ${control.id} 不是可执行的单资产内容地址。`);
    }
    const assetId = control.coveredAssetIds[0]!;
    const requestReference = requestReferenceByAsset.get(assetId);
    if (!requestReference
      || control.contentAddress !== `sha256:${requestReference.mediaSha256}`
      || control.referenceVersion !== requestReference.assetVersionId) {
      throw new Error(`PanelReferenceResolution 控制引用 ${control.id} 与冻结请求资产身份不一致。`);
    }
  }

  const mediaCasRoot = shell.paths.mediaCas;
  const canonicalMediaCasRoot = await realpath(mediaCasRoot).catch(() => {
    throw new Error("受管项目 media CAS 不可读。");
  });
  if (canonicalMediaCasRoot !== mediaCasRoot) {
    throw new Error("受管项目 media CAS 真实路径已漂移。");
  }

  const seenAssets = new Set<string>();
  const references: StudioCodexControlReference[] = [];
  for (const reference of pack.request.controlReferences) {
    if (seenAssets.has(reference.assetId)) {
      throw new Error(`Codex generation 控制引用重复绑定资产 ${reference.assetId}。`);
    }
    seenAssets.add(reference.assetId);
    if (!STUDIO_SHA256_PATTERN.test(reference.mediaSha256)) {
      throw new Error(`Codex generation 控制引用 ${reference.assetId} 缺少有效 SHA-256。`);
    }
    const matches = pack.assets.filter((asset) => asset.assetId === reference.assetId
      && asset.category === reference.category
      && asset.presence === reference.presence
      && asset.role === reference.role
      && asset.definition.id === reference.definitionVersionId
      && asset.authority.eventId === reference.authorityEventId
      && asset.version.id === reference.assetVersionId
      && asset.version.mediaSha256 === reference.mediaSha256
      && asset.media.sha256 === reference.mediaSha256
      && asset.media.objectPath === reference.localPath
      && (reference.referenceUsage === undefined
        || JSON.stringify(asset.referenceUsage) === JSON.stringify(reference.referenceUsage)));
    if (matches.length !== 1) {
      throw new Error(`Codex generation 控制引用 ${reference.assetId} 与冻结包资产绑定不一致。`);
    }

    const normalizedLocalPath = path.resolve(reference.localPath);
    const expectedLocalPath = path.join(mediaCasRoot, reference.mediaSha256.slice(0, 2), reference.mediaSha256);
    if (!path.isAbsolute(reference.localPath)
      || normalizedLocalPath !== reference.localPath
      || normalizedLocalPath !== expectedLocalPath
      || !isStrictlyWithin(normalizedLocalPath, mediaCasRoot)) {
      throw new Error(`Codex generation 控制引用 ${reference.assetId} 不在受管项目 media CAS 内。`);
    }

    const metadata = await lstat(normalizedLocalPath).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Codex generation 控制引用 ${reference.assetId} 的 CAS 对象不是可用普通文件。`);
    }
    const canonicalLocalPath = await realpath(normalizedLocalPath).catch(() => null);
    if (!canonicalLocalPath
      || canonicalLocalPath !== normalizedLocalPath
      || !isStrictlyWithin(canonicalLocalPath, canonicalMediaCasRoot)) {
      throw new Error(`Codex generation 控制引用 ${reference.assetId} 的 CAS 真实路径已漂移。`);
    }
    if (!await verifyStudioMediaObject(shell.paths.root, reference.mediaSha256)) {
      throw new Error(`Codex generation 控制引用 ${reference.assetId} 的文件 SHA 与冻结包不一致。`);
    }
    references.push({ ...reference, localPath: canonicalLocalPath });
  }
  if (references.length !== pack.assets.length) {
    throw new Error("Codex generation 冻结包资产与控制引用数量不一致。");
  }
  if (options.assertCurrentness !== false) {
    await assertStudioGenerationFreezePackCurrent(shell.paths.root, pack);
  }
  return references;
}

function isStudioUnitGridGenerationPack(
  pack: StudioGenerationFreezePack | StudioUnitGridGenerationFreezePack,
): pack is StudioUnitGridGenerationFreezePack {
  return pack.schemaVersion === 5
    && pack.provenance === "unit-grid-binding-sets"
    && pack.target.targetKind === "unit-grid";
}

/** 已落盘 pack 起草 create-plan 节点；已有计划则按节点状态写下一步。不执行、不派发。 */
function composePersistedPackGenerationPlanDraft(
  pack: StudioGenerationFreezePack | StudioUnitGridGenerationFreezePack,
  hasPersistedPlan = false,
  persistedPlanStatus?: PersistedPlanNodeStatus,
) {
  if (isStudioUnitGridGenerationPack(pack)) {
    return composeStudioGenerationPlanDraft({
      focusUnitId: pack.target.unitId,
      focusPanelId: null,
      focusPackId: pack.id,
      targetKind: "unit-grid",
      hasPersistedPlan,
      persistedPlanStatus,
    });
  }
  return composeStudioGenerationPlanDraft({
    focusUnitId: pack.target.unitId,
    focusPanelId: pack.target.panelId,
    focusPackId: pack.id,
    hasPersistedPlan,
    persistedPlanStatus,
  });
}

function persistedPlanStateForPack(
  databasePath: string,
  pack: StudioGenerationFreezePack | StudioUnitGridGenerationFreezePack,
) {
  return isStudioUnitGridGenerationPack(pack)
    ? readPersistedUnitGridPlanState(databasePath, pack.target.unitId)
    : readPersistedPanelPlanState(databasePath, pack.target.unitId, pack.target.panelId);
}

/** 单镜 pack 才读同单元 unit-grid 节点；整板 pack 用自己的计划状态。不加 inspect。 */
function siblingUnitGridPlanStatusForPanelPack(
  databasePath: string,
  pack: StudioGenerationFreezePack | StudioUnitGridGenerationFreezePack,
): PersistedPlanNodeStatus | undefined {
  if (isStudioUnitGridGenerationPack(pack)) return undefined;
  return readPersistedUnitGridPlanState(databasePath, pack.target.unitId).status ?? undefined;
}

function packEnvelopeNext(
  hasPersistedPlan: boolean,
  allowGrok: boolean,
  persistedPlanStatus?: PersistedPlanNodeStatus,
  unitGridBlockingStatus?: PersistedPlanNodeStatus,
): string {
  const unitGridNext = packEnvelopeNextOverrideForUnitGridBlocking(unitGridBlockingStatus);
  if (unitGridNext) return unitGridNext;
  if (!hasPersistedPlan) {
    return allowGrok
      ? "create-plan → dispatch(provider=codex|grok) → agent imagegen → atomic raw/labeled writeback"
      : "create-plan → dispatch(provider=codex) → prepare pre-call intent → one imagegen call → atomic raw/labeled writeback";
  }
  if (persistedPlanStatus === "dispatched") {
    return "wait → result or reconcile (no dispatch)";
  }
  if (persistedPlanStatus === "failed" || persistedPlanStatus === "cancelled") {
    return "retry_studio_generation_plan_nodes (no retry here, no dispatch)";
  }
  if (persistedPlanStatus === "succeeded") {
    return "Review (no dispatch)";
  }
  return allowGrok
    ? "dispatch(provider=codex|grok) → agent imagegen → atomic raw/labeled writeback"
    : "dispatch(provider=codex) → prepare pre-call intent → one imagegen call → atomic raw/labeled writeback";
}

/** readiness 只读 next：同单元 unit-grid 在途时禁止再写 freeze→create-plan→dispatch。已取回 unexpected 改 Review。不加 inspect，不自动查。 */
function readinessAgentNext(
  projectRoot: string,
  unitId: string,
  fallback: string,
  revisionImpact?: Ssl5RevisionImpactHint,
  panelId?: string,
): string {
  const status = readPersistedUnitGridPlanState(generationLedgerSidecarPath(projectRoot), unitId).status
    ?? undefined;
  const chosen = packEnvelopeNextOverrideForUnitGridBlocking(status) ?? fallback;
  return refineNextIfUnexpectedRevisionImpact({
    next: chosen,
    hint: revisionImpact,
    targets: [{ unitId, panelId }],
  });
}

function planRevisionImpactTargets(
  query: { unitId?: string; panelId?: string },
  nodes?: Array<{ unitId: string; targetKind?: string; panelId?: string }>,
): Array<{ unitId: string; panelId?: string | null }> {
  if (nodes && nodes.length > 0) {
    return nodes.map((node) => ({
      unitId: node.unitId,
      panelId: node.targetKind === "panel" ? node.panelId : undefined,
    }));
  }
  if (!query.unitId) return [];
  return [{ unitId: query.unitId, panelId: query.panelId }];
}

function sameSortedStrings(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort((a, b) => a.localeCompare(b, "en"));
  const sortedRight = [...right].sort((a, b) => a.localeCompare(b, "en"));
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}

async function verifiedStudioUnitGridControlReferences(
  projectRoot: string,
  pack: StudioUnitGridGenerationFreezePack,
): Promise<StudioUnitGridControlReference[]> {
  const shell = await inspectManagedProject(projectRoot);
  if (pack.projectId !== shell.project.id || pack.managedManifestFingerprint !== shell.manifestFingerprint) {
    throw new Error("Codex unit-grid 冻结包与当前受管项目身份不一致。");
  }
  const expectedRequestReferenceCount = pack.controlReferences.length + (pack.continuationSource ? 1 : 0);
  if (expectedRequestReferenceCount !== pack.request.controlReferences.length) {
    throw new Error("Codex unit-grid pack 与 request 的控制引用数量不一致。");
  }

  const merged = new Map<string, {
    localPath: string;
    assetIds: Set<string>;
    categories: Set<string>;
    roles: Set<string>;
    referenceUsages: Map<string, NonNullable<StudioCodexControlReference["referenceUsage"]>>;
  }>();
  for (const panel of pack.panels) {
    // unit-grid readiness 已在本次请求内刚刚构建全部 panel pack；这里仅复核
    // 逐格闭包与媒体 CAS。最后一次 unit-grid currentness 重建会统一覆盖所有
    // panel 的 Head CAS，避免每格前后各重建两次导致正式 2–6 格请求超时。
    const panelReferences = await verifiedStudioControlReferences(
      shell.paths.root,
      panel.panelPack,
      { assertCurrentness: false },
    );
    for (const reference of panelReferences) {
      const entry = merged.get(reference.mediaSha256) ?? {
        localPath: reference.localPath,
        assetIds: new Set<string>(),
        categories: new Set<string>(),
        roles: new Set<string>(),
        referenceUsages: new Map(),
      };
      if (entry.localPath !== reference.localPath) {
        throw new Error(`Codex unit-grid 控制引用 ${reference.mediaSha256} 的 CAS 路径不一致。`);
      }
      entry.assetIds.add(reference.assetId);
      entry.categories.add(reference.category);
      entry.roles.add(reference.role);
      entry.referenceUsages.set(reference.assetId, reference.referenceUsage ?? {
        purpose: "identity",
        inheritOnly: ["all"],
        excludeFromOutput: [],
        carrierPolicy: "none",
      });
      merged.set(reference.mediaSha256, entry);
    }
  }
  if (merged.size !== pack.controlReferences.length) {
    throw new Error("Codex unit-grid 控制引用与逐格冻结包合并闭包不一致。");
  }

  const mediaCasRoot = shell.paths.mediaCas;
  const canonicalMediaCasRoot = await realpath(mediaCasRoot).catch(() => {
    throw new Error("受管项目 media CAS 不可读。");
  });
  if (canonicalMediaCasRoot !== mediaCasRoot) {
    throw new Error("受管项目 media CAS 真实路径已漂移。");
  }

  const seenMedia = new Set<string>();
  const references: StudioUnitGridControlReference[] = [];
  for (const reference of pack.request.controlReferences) {
    if (seenMedia.has(reference.mediaSha256)) {
      throw new Error(`Codex unit-grid 控制引用重复绑定媒体 ${reference.mediaSha256}。`);
    }
    seenMedia.add(reference.mediaSha256);
    if (!STUDIO_SHA256_PATTERN.test(reference.mediaSha256)) {
      throw new Error(`Codex unit-grid 控制引用 ${reference.referenceId} 缺少有效 SHA-256。`);
    }
    const continuation = pack.continuationSource?.referenceId === reference.referenceId
      ? pack.continuationSource
      : undefined;
    const expected = merged.get(reference.mediaSha256);
    if (continuation) {
      const continuationMediaSha256 = continuation.schemaVersion !== 1
        ? continuation.evidenceSha256
        : continuation.mediaSha256;
      if (reference.mediaSha256 !== continuationMediaSha256
        || !sameSortedStrings(reference.coveredAssetIds, continuation.coveredAssetIds)
        || !sameSortedStrings(reference.categories, ["continuity"])
        || !sameSortedStrings(reference.roles, ["continuation_source"])) {
        throw new Error(`Codex unit-grid 连续来源 ${reference.referenceId} 与冻结证明不一致。`);
      }
    } else if (!expected
      || expected.localPath !== reference.localPath
      || !sameSortedStrings(reference.coveredAssetIds, [...expected.assetIds])
      || !sameSortedStrings(reference.categories, [...expected.categories])
      || !sameSortedStrings(reference.roles, [...expected.roles])
      || (reference.referenceUsages !== undefined
        && JSON.stringify(reference.referenceUsages) !== JSON.stringify(
          [...expected.referenceUsages.entries()]
            .sort(([left], [right]) => left.localeCompare(right, "en"))
            .map(([assetId, usage]) => ({ assetId, usage })),
        ))) {
      throw new Error(`Codex unit-grid 控制引用 ${reference.referenceId} 与逐格冻结闭包不一致。`);
    }

    const normalizedLocalPath = path.resolve(reference.localPath);
    const expectedLocalPath = path.join(mediaCasRoot, reference.mediaSha256.slice(0, 2), reference.mediaSha256);
    if (!path.isAbsolute(reference.localPath)
      || normalizedLocalPath !== reference.localPath
      || normalizedLocalPath !== expectedLocalPath
      || !isStrictlyWithin(normalizedLocalPath, mediaCasRoot)) {
      throw new Error(`Codex unit-grid 控制引用 ${reference.referenceId} 不在受管项目 media CAS 内。`);
    }
    const metadata = await lstat(normalizedLocalPath).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Codex unit-grid 控制引用 ${reference.referenceId} 的 CAS 对象不是可用普通文件。`);
    }
    const canonicalLocalPath = await realpath(normalizedLocalPath).catch(() => null);
    if (!canonicalLocalPath
      || canonicalLocalPath !== normalizedLocalPath
      || !isStrictlyWithin(canonicalLocalPath, canonicalMediaCasRoot)) {
      throw new Error(`Codex unit-grid 控制引用 ${reference.referenceId} 的 CAS 真实路径已漂移。`);
    }
    if (!await verifyStudioMediaObject(shell.paths.root, reference.mediaSha256)) {
      throw new Error(`Codex unit-grid 控制引用 ${reference.referenceId} 的文件 SHA 与冻结包不一致。`);
    }
    references.push({ ...reference, localPath: canonicalLocalPath });
  }
  await assertStudioUnitGridGenerationFreezePackCurrent(shell.paths.root, pack);
  return references;
}

/**
 * Codex 专用的本地生成控制封装。普通就绪/历史投影不返回路径；只有 pack
 * operation 会在重验受管项目、冻结输入、media CAS 路径与文件 SHA 后返回 localPath。
 * readiness / plan 可传入调用方已取回的 revisionImpact，只精炼 next；省略不查。
 * 不改 freeze writeCommand。
 */
export async function getStudioGenerationControlEnvelope(
  projectRoot: string,
  query: StudioGenerationControlQuery,
) {
  if (query.operation === "session-snapshot") {
    return {
      schemaVersion: 1 as const,
      kind: STUDIO_GENERATION_CONTROL_KIND,
      operation: "session-snapshot" as const,
      status: "ready" as const,
      snapshot: await buildStudioGenerationSessionSnapshot(projectRoot, {
        unitId: query.unitId,
        ...(query.panelId ? { panelId: query.panelId } : {}),
      }),
      controlReferencesExposed: false as const,
    };
  }
  if (query.operation === "readiness") {
    if (query.targetKind === "unit-grid") {
      return withStudioRequestSchemaCache(async () => {
        const readiness = await queryStudioUnitGridGenerationFreeze(projectRoot, {
          targetKind: "unit-grid",
          unitId: query.unitId,
          ...(query.continuationWaiver ? { continuationWaiver: query.continuationWaiver } : {}),
        });
        if (readiness.status === "blocked") {
          return {
            schemaVersion: 1 as const,
            kind: STUDIO_GENERATION_CONTROL_KIND,
            operation: "readiness" as const,
            status: "blocked" as const,
            targetKind: "unit-grid" as const,
            code: readiness.code,
            message: readiness.message,
            detailCount: readiness.details.length,
            controlReferencesExposed: false as const,
          };
        }
        try {
          const controlReferences = await verifiedStudioUnitGridControlReferences(projectRoot, readiness.pack);
          const currentSnapshot = await getStudioProductionUnitSnapshot(projectRoot, readiness.pack.target.unitId);
          if (!currentSnapshot) throw new Error("Studio unit-grid 就绪单元在生成命令前消失。");
          return {
            schemaVersion: 1 as const,
            kind: STUDIO_GENERATION_CONTROL_KIND,
            operation: "readiness" as const,
            status: "ready" as const,
            targetKind: "unit-grid" as const,
            candidate: {
              packId: readiness.packId,
              fingerprint: readiness.fingerprint,
              projectId: readiness.pack.projectId,
              managedManifestFingerprint: readiness.pack.managedManifestFingerprint,
              unitSnapshotFingerprint: readiness.pack.unitSnapshotFingerprint,
              continuityFingerprint: readiness.pack.continuityFingerprint,
              target: readiness.pack.target,
              requestId: readiness.request.id,
              requestFingerprint: readiness.request.fingerprint,
              executorKind: readiness.request.executorKind,
              allowedProviders: readiness.request.allowedProviders,
              controlReferenceCount: controlReferences.length,
              panelCount: readiness.pack.panels.length,
              forbiddenAssetCount: readiness.pack.panels.reduce(
                (count, panel) => count + panel.panelPack.forbiddenAssets.length,
                0,
              ),
            },
            agentExecution: {
              formalProviders: STUDIO_FORMAL_IMAGEGEN_ALLOWED_PROVIDERS,
              next: readinessAgentNext(
                projectRoot,
                readiness.pack.target.unitId,
                "freeze → create-plan → dispatch(provider=codex) → prepare pre-call intent → one imagegen call → atomic raw/labeled writeback",
                query.revisionImpact,
              ),
              briefs: {
                codex: buildStudioUnitGridAgentImagegenBrief(readiness.pack, "codex"),
                grok: buildStudioUnitGridAgentImagegenBrief(readiness.pack, "grok"),
              },
            },
            persistence: "execute-command-required" as const,
            writeCommand: {
              tool: "execute_command" as const,
              command: "freeze_studio_generation_pack" as const,
              payload: {
                targetKind: "unit-grid" as const,
                unitId: readiness.pack.target.unitId,
                ...(readiness.pack.continuationWaiver
                  ? {
                      continuationWaiver: {
                        receiptId: readiness.pack.continuationWaiver.receiptId,
                        receiptFingerprint: readiness.pack.continuationWaiver.fingerprint,
                      },
                    }
                  : {}),
                expectedRevision: currentSnapshot.unit.revision,
              },
            },
            controlReferencesExposed: false as const,
          };
        } catch {
          return {
            schemaVersion: 1 as const,
            kind: STUDIO_GENERATION_CONTROL_KIND,
            operation: "readiness" as const,
            status: "blocked" as const,
            targetKind: "unit-grid" as const,
            code: "control-reference-invalid" as const,
            message: "Codex unit-grid 控制引用未通过逐格闭包、受管 media CAS 路径与 SHA 校验。",
            detailCount: 0,
            controlReferencesExposed: false as const,
          };
        }
      });
    }

    const readiness = await queryStudioGenerationFreeze(projectRoot, {
      unitId: query.unitId,
      panelId: query.panelId,
    });
    if (readiness.status === "blocked") {
      return {
        schemaVersion: 1 as const,
        kind: STUDIO_GENERATION_CONTROL_KIND,
        operation: "readiness" as const,
        status: "blocked" as const,
        code: readiness.code,
        message: readiness.message,
        detailCount: readiness.details.length,
        controlReferencesExposed: false as const,
      };
    }
    try {
      const controlReferences = await verifiedStudioControlReferences(projectRoot, readiness.pack);
      const currentSnapshot = await getStudioProductionUnitSnapshot(projectRoot, readiness.pack.target.unitId);
      if (!currentSnapshot) throw new Error("Studio generation 就绪单元在生成命令前消失。");
      return {
        schemaVersion: 1 as const,
        kind: STUDIO_GENERATION_CONTROL_KIND,
        operation: "readiness" as const,
        status: "ready" as const,
        candidate: {
          packId: readiness.packId,
          fingerprint: readiness.fingerprint,
          projectId: readiness.pack.projectId,
          managedManifestFingerprint: readiness.pack.managedManifestFingerprint,
          unitSnapshotFingerprint: readiness.pack.unitSnapshotFingerprint,
          target: readiness.pack.target,
          requestId: readiness.request.id,
          requestFingerprint: readiness.request.fingerprint,
          executorKind: readiness.request.executorKind,
          allowedProviders: readiness.request.allowedProviders,
          controlReferenceCount: controlReferences.length,
          forbiddenAssetCount: readiness.pack.forbiddenAssets.length,
        },
        agentExecution: {
          formalProviders: STUDIO_FORMAL_IMAGEGEN_ALLOWED_PROVIDERS,
          next: readinessAgentNext(
            projectRoot,
            readiness.pack.target.unitId,
            "freeze → create-plan → dispatch(provider=codex|grok) → agent imagegen → atomic raw/labeled writeback",
            query.revisionImpact,
            readiness.pack.target.panelId,
          ),
          briefs: {
            codex: buildStudioAgentImagegenBrief(readiness.pack, "codex"),
            grok: buildStudioAgentImagegenBrief(readiness.pack, "grok"),
          },
        },
        persistence: "execute-command-required" as const,
        writeCommand: {
          tool: "execute_command" as const,
          command: "freeze_studio_generation_pack" as const,
          payload: {
            unitId: readiness.pack.target.unitId,
            panelId: readiness.pack.target.panelId,
            // 冻结命令的 CAS 针对当前 unit head；持久 pack 自身仍可锚定目标
            // BindingSet 的历史 unit revision。
            expectedRevision: currentSnapshot.unit.revision,
          },
        },
        controlReferencesExposed: false as const,
      };
    } catch {
      return {
        schemaVersion: 1 as const,
        kind: STUDIO_GENERATION_CONTROL_KIND,
        operation: "readiness" as const,
        status: "blocked" as const,
        code: "control-reference-invalid" as const,
        message: "Codex generation 控制引用未通过受管 media CAS 路径与 SHA 校验。",
        detailCount: 0,
        controlReferencesExposed: false as const,
      };
    }
  }

  if (query.operation === "call") {
    const intent = await readStudioImagegenCallIntentByRun(projectRoot, query.generationRunId);
    // quarantine 是一次性 pre-call capability；普通只读对账只能看到身份，
    // 不能重新取得可写绝对路径或把重放误当成再次授权。
    const publicIntent = intent
      ? (({ quarantine: _quarantine, ...identity }) => identity)(intent)
      : null;
    const events = intent
      ? (await readStudioImagegenCallEventHistory(projectRoot, intent.callId)).map((event) => {
          const { evidenceReference, ...publicEvent } = event;
          return { ...publicEvent, evidence: projectedEvidenceReference(evidenceReference) };
        })
      : [];
    return {
      schemaVersion: 1 as const,
      kind: STUDIO_GENERATION_CONTROL_KIND,
      operation: "call" as const,
      status: intent ? "ready" as const : "not_found" as const,
      generationRunId: query.generationRunId,
      intent: publicIntent,
      events,
      generationBlocked: intent?.status === "generation_unknown",
      modelCallAuthorized: false as const,
      nextAction: intent?.status === "generation_unknown"
        ? "reconcile-or-commit-existing-call-only" as const
        : intent?.status === "owner-abandoned"
          ? "new-run-required-after-owner-abandon" as const
        : intent?.status === "not-invoked"
          ? "new-run-required" as const
          : intent?.status === "result-committed"
            ? "review" as const
            : "prepare-call-intent" as const,
      controlReferencesExposed: false as const,
    };
  }

  if (query.operation === "active-runs") {
    // T4：活动 run 可发现、可恢复——Agent 丢失本地 state 后仅凭 active context + unitId 找回完整调用身份。
    const result = await listStudioGenerationActiveRuns(projectRoot, {
      unitId: query.unitId,
      targetKind: query.targetKind ?? "panel",
      ...(query.targetKind === "unit-grid" ? {} : { panelId: (query as { panelId: string }).panelId }),
    });
    const generationBlocked = result.blockingRuns.length > 0;
    const unitGridBlockingStatus = result.targetKind === "panel"
      ? readPersistedUnitGridPlanState(generationLedgerSidecarPath(projectRoot), result.unitId).status ?? undefined
      : undefined;
    return {
      schemaVersion: 1 as const,
      kind: STUDIO_GENERATION_CONTROL_KIND,
      operation: "active-runs" as const,
      status: "ready" as const,
      targetKind: result.targetKind,
      unitId: result.unitId,
      ...(result.panelId ? { panelId: result.panelId } : {}),
      runs: result.runs,
      blockingRuns: result.blockingRuns,
      generationBlocked,
      nextAction: activeRunsEnvelopeNext({
        hasUnknownCall: result.runs.some((run) => run.callStatus === "generation_unknown")
          || result.blockingRuns.some((row) => row.reason.includes("generation_unknown")),
        hasUnreviewedPair: result.runs.some((run) => run.hasResultPair && run.reviewStatus === "unreviewed")
          || result.blockingRuns.some((row) => row.reason.includes("未审片")),
        hasInFlightRun: result.runs.some((run) => !run.terminal)
          || result.blockingRuns.some((row) => row.reason.includes("非终态")),
        generationBlocked,
        unitGridBlockingStatus,
      }),
      controlReferencesExposed: false as const,
    };
  }

  if (query.operation === "detached-unknown") {
    const observations = (await listStudioDetachedGenerationUnknownObservations(projectRoot, { unitId: query.unitId }))
      .map((observation) => {
        const { evidenceReference, ...publicObservation } = observation;
        return { ...publicObservation, evidence: projectedEvidenceReference(evidenceReference) };
      });
    const dispositions = (await listStudioDetachedGenerationUnknownDispositions(projectRoot, { unitId: query.unitId }))
      .map((disposition) => {
        const { authorizationEvidenceReference, ...publicDisposition } = disposition;
        return {
          ...publicDisposition,
          authorizationEvidence: projectedEvidenceReference(authorizationEvidenceReference),
        };
      });
    const disposedIds = new Set(dispositions.map((disposition) => disposition.observationId));
    const unresolvedObservationIds = observations
      .filter((observation) => !disposedIds.has(observation.observationId))
      .map((observation) => observation.observationId);
    return {
      schemaVersion: 1 as const,
      kind: STUDIO_GENERATION_CONTROL_KIND,
      operation: "detached-unknown" as const,
      status: "ready" as const,
      targetKind: "unit-grid" as const,
      unitId: query.unitId,
      observations,
      dispositions,
      unresolvedObservationIds,
      generationBlocked: unresolvedObservationIds.length > 0,
      nextAction: unresolvedObservationIds.length > 0
        ? "reconcile-external-unknown-only" as const
        : dispositions.length > 0
          ? "new-formal-run-required-after-owner-abandon" as const
          : "follow-core-readiness" as const,
      controlReferencesExposed: false as const,
    };
  }

  if (query.operation === "plan") {
    // P21：逐节点生成计划投影（无私有路径；无 plan 返回空态）。
    const shell = await inspectManagedProject(projectRoot);
    if (query.planId) {
      const plan = await getStudioGenerationPlanProjection(shell.paths.root, query.planId);
      if (!plan) {
        return {
          schemaVersion: 1 as const,
          kind: STUDIO_GENERATION_CONTROL_KIND,
          operation: "plan" as const,
          status: "not_found" as const,
          planId: query.planId,
          nextAction: planOperationEnvelopeNext({ kind: "not-found" }),
          controlReferencesExposed: false as const,
        };
      }
      if (plan.projectId !== shell.project.id) {
        return {
          schemaVersion: 1 as const,
          kind: STUDIO_GENERATION_CONTROL_KIND,
          operation: "plan" as const,
          status: "not_found" as const,
          planId: query.planId,
          nextAction: planOperationEnvelopeNext({ kind: "not-found" }),
          controlReferencesExposed: false as const,
        };
      }
      return {
        schemaVersion: 1 as const,
        kind: STUDIO_GENERATION_CONTROL_KIND,
        operation: "plan" as const,
        status: "ready" as const,
        plan,
        nextAction: planOperationEnvelopeNext({
          kind: "scoped",
          statuses: plan.nodes.map((node) => node.status),
          revisionImpact: query.revisionImpact,
          targets: planRevisionImpactTargets(query, plan.nodes),
        }),
        controlReferencesExposed: false as const,
      };
    }
    const scoped = Boolean(
      (query.targetKind === "unit-grid" && query.unitId)
      || (query.unitId && query.panelId),
    );
    const plans = query.targetKind === "unit-grid" && query.unitId
      ? [await getStudioGenerationLatestPlanForUnitGrid(shell.paths.root, query.unitId)].filter(Boolean)
      : query.unitId && query.panelId
        ? [await getStudioGenerationLatestPlanForPanel(shell.paths.root, query.unitId, query.panelId)].filter(Boolean)
        : await listStudioGenerationPlanProjections(shell.paths.root, { limit: 36 });
    return {
      schemaVersion: 1 as const,
      kind: STUDIO_GENERATION_CONTROL_KIND,
      operation: "plan" as const,
      status: "ready" as const,
      projectId: shell.project.id,
      plans,
      nextAction: scoped
        ? planOperationEnvelopeNext({
          kind: "scoped",
          statuses: plans.flatMap((plan) => plan?.nodes.map((node) => node.status) ?? []),
          revisionImpact: query.revisionImpact,
          targets: planRevisionImpactTargets(query, plans.flatMap((plan) => plan?.nodes ?? [])),
        })
        : planOperationEnvelopeNext({ kind: "unscoped-list" }),
      controlReferencesExposed: false as const,
    };
  }

  if (query.operation === "history") {
    const shell = await inspectManagedProject(projectRoot);
    const page = query.targetKind === "unit-grid"
      ? await listStudioGenerationUnitGridHistory(shell.paths.root, {
          unitId: query.unitId,
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.order === undefined ? {} : { order: query.order }),
        })
      : await listStudioGenerationPanelHistory(shell.paths.root, {
          unitId: query.unitId,
          panelId: query.panelId,
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.order === undefined ? {} : { order: query.order }),
        });
    const consistencyPeek = await historyEnvelopeConsistencyPeek(page.items);
    return {
      schemaVersion: 1 as const,
      kind: STUDIO_GENERATION_CONTROL_KIND,
      operation: "history" as const,
      status: "ready" as const,
      projectId: shell.project.id,
      targetKind: query.targetKind ?? "panel",
      unitId: query.unitId,
      order: query.order ?? "oldest-first",
      ...(query.targetKind === "unit-grid" ? { targetKey: `unit-grid:${query.unitId}` } : { panelId: query.panelId }),
      items: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      nextAction: historyEnvelopeNext(page.items),
      ...(consistencyPeek ? { consistencyPeek } : {}),
      controlReferencesExposed: false as const,
    };
  }

  return withStudioRequestSchemaCache(async () => {
    const shell = await inspectManagedProject(projectRoot);
    const pack = await readAnyStudioGenerationFrozenPack(shell.paths.root, query.packId);
    if (!pack) {
      return {
        schemaVersion: 1 as const,
        kind: STUDIO_GENERATION_CONTROL_KIND,
        operation: "pack" as const,
        status: "not_found" as const,
        packId: query.packId,
        controlReferencesExposed: false as const,
      };
    }
    const persistedPlan = persistedPlanStateForPack(shell.paths.generationDatabase, pack);
    const hasPersistedPlan = persistedPlan.hasPlan;
    const persistedPlanStatus = persistedPlan.status ?? undefined;
    const unitGridBlockingStatus = siblingUnitGridPlanStatusForPanelPack(shell.paths.generationDatabase, pack);
    const generationPlanDraft = refineStudioGenerationPlanDraftIfUnitGridBlocking(
      composePersistedPackGenerationPlanDraft(pack, hasPersistedPlan, persistedPlanStatus),
      { status: unitGridBlockingStatus },
    );
    if (isStudioUnitGridGenerationPack(pack)) {
      const controlReferences = await verifiedStudioUnitGridControlReferences(shell.paths.root, pack);
      const request: StudioUnitGridCodexGenerationRequest = { ...pack.request, controlReferences };
      return {
        schemaVersion: 1 as const,
        kind: STUDIO_GENERATION_CONTROL_KIND,
        operation: "pack" as const,
        status: "ready" as const,
        targetKind: "unit-grid" as const,
        projection: "frozen-pack-with-verified-control-local-paths" as const,
        pack: projectedStudioUnitGridGenerationPack(pack, request),
        request,
        agentExecution: {
          formalProviders: STUDIO_FORMAL_IMAGEGEN_ALLOWED_PROVIDERS,
          executorKind: request.executorKind,
          allowedProviders: request.allowedProviders,
          briefs: {
            codex: buildStudioUnitGridAgentImagegenBrief(pack, "codex"),
            grok: buildStudioUnitGridAgentImagegenBrief(pack, "grok"),
          },
          generationPlanDraft,
          next: packEnvelopeNext(hasPersistedPlan, false, persistedPlanStatus, unitGridBlockingStatus),
          dispatchPayloadTemplate: {
            command: "dispatch_studio_generation_pack" as const,
            required: ["packId", "packFingerprint", "generationRunId", "provider", "expectedRevision"],
            providerEnum: ["codex", "grok"],
          },
          preCallPayloadTemplate: {
            command: "prepare_studio_imagegen_call" as const,
            required: ["projectContextToken", "packId", "packFingerprint", "generationRunId", "provider", "expectedRevision"],
            expectedRevision: 0 as const,
            authorization: "only-first-success-may-return-callAllowed-true" as const,
          },
        },
        verification: {
          managedProject: true as const,
          currentFreezeInputs: true as const,
          panelBindingContinuityClosure: true as const,
          mediaCasContainment: true as const,
          mediaSha256: true as const,
          verifiedControlReferenceCount: controlReferences.length,
        },
        controlReferencesExposed: true as const,
      };
    }
    const controlReferences = await verifiedStudioControlReferences(shell.paths.root, pack);
    const request: StudioCodexGenerationRequest = { ...pack.request, controlReferences };
    return {
      schemaVersion: 1 as const,
      kind: STUDIO_GENERATION_CONTROL_KIND,
      operation: "pack" as const,
      status: "ready" as const,
      projection: "frozen-pack-with-verified-control-local-paths" as const,
      pack: projectedStudioGenerationPack(pack, request),
      request,
      agentExecution: {
        formalProviders: STUDIO_FORMAL_IMAGEGEN_ALLOWED_PROVIDERS,
        executorKind: request.executorKind,
        allowedProviders: request.allowedProviders,
        briefs: {
          codex: buildStudioAgentImagegenBrief(pack, "codex"),
          grok: buildStudioAgentImagegenBrief(pack, "grok"),
        },
        generationPlanDraft,
        next: packEnvelopeNext(hasPersistedPlan, true, persistedPlanStatus, unitGridBlockingStatus),
        dispatchPayloadTemplate: {
          command: "dispatch_studio_generation_pack" as const,
          required: ["packId", "packFingerprint", "generationRunId", "provider", "expectedRevision"],
          providerEnum: ["codex", "grok"],
        },
      },
      verification: {
        managedProject: true as const,
        currentFreezeInputs: true as const,
        mediaCasContainment: true as const,
        mediaSha256: true as const,
        verifiedControlReferenceCount: controlReferences.length,
      },
      controlReferencesExposed: true as const,
    };
  });
}

function compactItem(item: WorkItem) {
  return {
    id: item.id,
    parentId: item.parentId,
    type: item.type,
    title: item.title,
    episode: item.episode,
    unit: item.unit,
    shot: item.shot,
    status: item.status,
    stage: item.stage,
    priority: item.priority,
    nextAction: item.nextAction,
    failureReason: item.failureReason,
    infoPath: item.infoPath,
    thumbnailPath: item.thumbnailPath,
    hardLockIds: item.hardLockIds,
    dependencies: item.dependencies,
  };
}

function summarizeProductionEvidence(workflow: ProductionWorkflow): ProductionWorkflowEvidenceSummary {
  const audit = workflow.evidenceAudit;
  if (!audit) throw new Error("生产工作流缺少实时证据审计结果。");
  const stageById = new Map(workflow.stages.map((stage) => [stage.id, stage]));
  const compactStage = (entry: (typeof audit.stages)[number]): ProductionWorkflowEvidenceStageSummary => {
    const stage = stageById.get(entry.stageId);
    if (!stage) throw new Error(`生产证据审计引用了未知阶段：${entry.stageId}`);
    return {
      stageId: entry.stageId,
      name: stage.name,
      status: stage.status,
      ready: entry.ready,
      statusEvidenceValid: entry.statusEvidenceValid,
      legacyUnverified: entry.legacyUnverified,
      issues: entry.issues.slice(0, 20),
      evidencePaths: stage.evidencePaths.slice(0, 50),
      itemIds: stage.itemIds.slice(0, 200),
      nextActions: stage.nextActions.slice(0, 20),
    };
  };
  const stageSummaries = audit.stages.map(compactStage);
  const blockers = stageSummaries.filter((stage) => stage.status === "completed" && !stage.statusEvidenceValid);
  const legacyUnverifiedStages = stageSummaries.filter((stage) => stage.legacyUnverified);
  const nextStage = blockers[0] ?? stageSummaries.find((stage) => stage.status !== "completed");
  const nextRepairStage = blockers[0] ?? legacyUnverifiedStages[0];
  const repairReason = nextRepairStage ? (blockers.some((stage) => stage.stageId === nextRepairStage.stageId) ? "evidence_drift" as const : "legacy_unverified" as const) : undefined;
  const nextRepair = nextRepairStage && repairReason ? {
    stageId: nextRepairStage.stageId,
    name: nextRepairStage.name,
    reason: repairReason,
    mustRepairEvidenceFirst: !nextRepairStage.ready,
    issues: nextRepairStage.issues,
    evidencePaths: nextRepairStage.evidencePaths,
    itemIds: nextRepairStage.itemIds,
    executeCommand: {
      tool: "execute_command" as const,
      requestIdHint: `request-production-${nextRepairStage.stageId}-r${workflow.revision}`,
      idempotencyKeyHint: `production-evidence-${nextRepairStage.stageId}-r${workflow.revision}`,
      request: {
        command: "update_workflow_stage" as const,
        payload: {
          stageId: nextRepairStage.stageId,
          status: "completed" as const,
          note: repairReason === "evidence_drift" ? "真实证据修复后重新核验 completed 阶段。" : "旧 completed 状态重新核验并补齐证据指纹。",
          expectedRevision: workflow.revision,
        },
      },
    },
    afterSuccess: ["get_production_workflow", "doctor_project"] as ["get_production_workflow", "doctor_project"],
  } : undefined;
  return {
    schemaVersion: 1,
    workflowRevision: workflow.revision,
    checkedAt: audit.checkedAt,
    valid: audit.valid,
    repairRequired: blockers.length > 0,
    counts: {
      ready: audit.readyStageCount,
      completed: audit.completedStageCount,
      verifiedCompleted: audit.verifiedCompletedStageCount,
      invalidCompleted: blockers.length,
      legacyUnverified: legacyUnverifiedStages.length,
    },
    blockers,
    legacyUnverifiedStages,
    nextStage,
    nextRepair,
    suggestedCalls: blockers.length || legacyUnverifiedStages.length
      ? ["get_production_workflow", "execute_command", "doctor_project"]
      : nextStage?.nextActions.length ? nextStage.nextActions : ["get_project_snapshot"],
  };
}

async function canAccess(target: string, mode: number): Promise<boolean> {
  return access(target, mode).then(() => true).catch(() => false);
}

export interface GetCapabilitiesRuntimeProjection {
  /**
   * MCP 启动时已解析并缓存的构建身份。undefined 表示沿用旧行为现场解析；
   * null 表示已尝试但不可用，禁止再次触发整仓摘要。
   */
  buildIdentity?: BuildIdentity | null;
  /**
   * MCP 统一门禁刚完成的 currentness 投影。undefined 表示沿用旧行为现场核验；
   * null 表示诊断不可用，禁止隐式重试。
   */
  buildCurrentness?: {
    allowed: boolean;
    buildId?: string;
    sourceDigest?: string;
    reason?: string;
  } | null;
}

export async function getCapabilities(
  projectRoot?: string,
  runtime: GetCapabilitiesRuntimeProjection = {},
) {
  const engine = DEFERRED_VIDEO_ENGINE_CAPABILITY;
  const machineMedia = await readMachineMediaRuntimeSnapshot();
  let project: Record<string, unknown> | undefined;
  if (projectRoot) {
    const absoluteRoot = path.resolve(projectRoot);
    const index = await loadIndex(absoluteRoot);
    const settings = await readJson<GenerationSettings | null>(getSidecarPaths(absoluteRoot).generationSettings, null);
    const analysisSettings = await getNovelAnalysisProviderSettings(absoluteRoot);
    project = {
      root: absoluteRoot,
      imported: Boolean(index),
      projectId: index?.project.id,
      scanId: index?.scanId,
      scannedAt: index?.scannedAt,
      providers: settings?.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        adapter: provider.adapter,
        kinds: provider.kinds,
        enabled: provider.enabled,
        model: provider.model,
        capabilities: provider.capabilities,
        credentialConfigured: provider.apiKeyEnv ? Boolean(process.env[provider.apiKeyEnv]) : undefined,
      })) ?? [],
      novelAnalysisProviders: analysisSettings.providers.map((provider) => ({ id: provider.id, name: provider.name, adapter: provider.adapter, enabled: provider.enabled, model: provider.model, allowStoryUpload: provider.allowStoryUpload, allowPrivateNetwork: provider.allowPrivateNetwork, credentialConfigured: provider.apiKeyEnv ? Boolean(process.env[provider.apiKeyEnv]) : true })),
    };
  }
  const workspaceRoot = path.resolve(
    process.env.AI_CANVAS_WORKSPACE?.trim()
      || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  );
  let buildIdentity: BuildIdentity | undefined;
  if (runtime.buildIdentity === undefined) {
    try {
      buildIdentity = await resolveRuntimeBuildIdentity(workspaceRoot);
    } catch {
      buildIdentity = undefined;
    }
  } else {
    buildIdentity = runtime.buildIdentity ?? undefined;
  }
  let buildCurrentness: GetCapabilitiesRuntimeProjection["buildCurrentness"] | undefined;
  if (runtime.buildCurrentness === undefined) {
    try {
      buildCurrentness = await assertRuntimeBuildCurrentness({
        workspace: workspaceRoot,
        recordedSourceDigest: process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST,
      });
    } catch {
      buildCurrentness = undefined;
    }
  } else {
    buildCurrentness = runtime.buildCurrentness ?? undefined;
  }
  const capabilities = {
    server: {
      name: "ai-drama-canvas",
      version: AI_CANVAS_APPLICATION_VERSION,
      protocolVersion: AI_CANVAS_PROTOCOL_VERSION,
      transport: "stdio",
      toolCount: buildIdentity?.capabilities.mcpToolCount,
    },
    buildIdentity: buildIdentity
      ? {
        buildId: buildIdentity.buildId,
        sourceDigest: buildIdentity.sourceDigest,
        packageVersion: buildIdentity.packageVersion,
        builtAt: buildIdentity.builtAt,
        ...(buildIdentity.artifactBuiltAt ? { artifactBuiltAt: buildIdentity.artifactBuiltAt } : {}),
        queriedAt: buildIdentity.queriedAt,
        builtAtSource: buildIdentity.builtAtSource,
        capabilities: buildIdentity.capabilities,
        fingerprint: buildIdentity.fingerprint,
      }
      : undefined,
    buildCurrentness: buildCurrentness
      ? {
        allowed: buildCurrentness.allowed,
        buildId: buildCurrentness.buildId,
        sourceDigest: buildCurrentness.sourceDigest,
        ...(buildCurrentness.reason ? { reason: buildCurrentness.reason } : {}),
      }
      : undefined,
    reliability: {
      commandLedgerBackend: "sqlite-incremental",
      studioWriteRootEnforced: true,
      formalImagegenProvider: "agent-imagegen",
      formalImagegenProviders: ["codex", "grok"],
      browserGeneration: false,
    },
    principles: {
      sourceOfTruth: "filesystem-plus-acceptance",
      scanBeforeProduction: true,
      neverOverwriteAuthoritative: true,
      neverDeleteSourceAssets: true,
      visualReviewGate: true,
      binaryPayloadsInMcp: false,
    },
    novelAgent: NOVEL_AGENT_CAPABILITIES,
    domains: {
      import: ["list_projects", "preview_project_import", "commit_project_import", "preview_scan_project", "scan_project"],
      orchestration: ["get_progress", "get_project_snapshot", "doctor_project", "get_next_task", "create_task_pack", "claim_task", "heartbeat_task", "release_task", "cancel_task", "finish_batch"],
      commandBus: ["execute_command", "list_command_ledger", "reconcile_command"],
      managedStudio: ["get_active_managed_studio_context", "get_managed_studio_overview", "get_local_creative_project_ingest_status", "preview_local_creative_production_units", "list_studio_assets", "list_studio_media", "list_studio_media_import_origins", "list_studio_text_documents", "list_studio_production_units", "query_studio_asset_timeline", "get_studio_asset", "get_studio_text_revision", "get_studio_production_unit_snapshot", "get_studio_binding_control", "get_studio_generation_control", "discover_dudu_readonly_import_projects", "get_dudu_readonly_import_control", "get_studio_video_package_control", "get_studio_continuity_review_control", "get_studio_production_dashboard", "get_studio_multimedia_timeline", "get_studio_consistency_evaluation", "get_studio_script_library_projection", "suggest_studio_storyboard_draft", "evaluate_studio_fusion_helper", "execute_studio_shot_compose_local", "get_studio_trace", "execute_command"],
      fusionProduction: ["inspect_fusion_package", "materialize_fusion_project", "get_canonical_asset_catalog_state", "list_canonical_assets", "get_canonical_asset", "list_fusion_production_assets", "list_continuity_tracks", "get_continuity_spans", "build_fusion_reference_board", "build_fusion_storyboard_grid", "materialize_fusion_panel_references", "audit_fusion_panel_references", "list_fusion_panel_reference_resolutions", "get_fusion_panel_reference_resolution", "list_derived_panel_reference_assets", "upsert_panel_reference_override", "register_derived_panel_reference_artifact", "materialize_fusion_visual_constraints", "audit_fusion_visual_constraints", "list_fusion_visual_constraints", "get_fusion_visual_constraint", "upsert_fusion_visual_constraint_override", "get_fusion_storyboard_sheet_state", "list_fusion_storyboard_sheets", "migrate_fusion_storyboard_sheets", "render_fusion_storyboard_sheet", "get_fusion_asset_consistency", "prepare_fusion_asset_consistency_review", "submit_fusion_asset_consistency_review", "seal_final_fusion_asset_consistency_batch"],
      artifacts: ["get_item", "register_artifact", "verify_item", "update_status", "set_authoritative_artifact", "promote_asset_to_hard_lock"],
      assetRegistry: ["list_asset_relations", "upsert_asset_relation", "list_voice_identities", "upsert_voice_identity"],
      generation: ["get_generation_settings", "get_generation_provider", "upsert_generation_provider", "enqueue_generation", "process_generation_queue", "cancel_generation_job", "list_generation_jobs", "get_browser_generation_plan", "update_browser_generation_job", "get_subagent_image_generation_plan", "update_subagent_image_generation_job", "reconcile_http_generation_submission"],
      publication: ["list_publications", "preflight_publication", "register_publication", "cancel_publication", "fail_publication"],
      review: ["get_review_queue", "submit_review", "list_reviews"],
      story: ["import_story_file", "import_story_text", "list_story_sources", "list_story_chapters", "read_story_chapter", "list_story_events", "upsert_story_event", "connect_story_events", "build_story_context", "get_adaptation_workspace", "create_novel_analysis_task", "get_novel_analysis_providers", "upsert_novel_analysis_provider", "probe_novel_analysis_provider", "plan_novel_analysis_run", "get_novel_analysis_runs", "execute_next_novel_analysis_run_task", "replace_novel_analysis_run_task", "execute_novel_analysis_task", "submit_novel_analysis_proposal", "list_novel_analysis_reviews", "review_novel_analysis_item", "review_novel_analysis_batch", "analyze_novel_chapters", "upsert_novel_fact", "upsert_narrative_beat", "generate_adaptation_plans", "validate_adaptation_plan", "analyze_adaptation_impact", "regenerate_adaptation_scope", "select_adaptation_plan", "materialize_adaptation_plan", "export_adaptation"],
      novelManuscript: ["doctor_novel_agent", "get_novel_manuscript_workspace", "list_novel_manuscript_chapters", "read_novel_manuscript_range", "search_novel_manuscript", "get_novel_search_index_status", "get_novel_writing_state", "plan_novel_state_rebuild", "probe_novel_chapter_consistency", "build_novel_context_pack", "prepare_novel_chapter_write", "preflight_novel_chapter_write", "execute_command"],
      productionDesign: ["get_production_workflow", "preview_existing_production_recovery", "commit_existing_production_recovery", "update_production_workflow_stage", "list_creative_bibles", "upsert_creative_bible", "get_storyboard", "upsert_storyboard_row", "analyze_change_impact"],
      documents: ["list_script_documents", "read_script_document", "save_script_document"],
      timeline: ["get_unit_timelines", "save_unit_timeline", "create_shot_task_pack"],
      memory: ["list_context", "search_context", "upsert_context", "delete_context", "get_continuation", "create_handoff", "list_skills", "read_skill", "save_skill"],
      canvas: ["get_canvas_state", "upsert_canvas_entity", "delete_canvas_entity", "upsert_canvas_link", "delete_canvas_link", "undo_canvas", "redo_canvas"],
      editor: ["probe_video_engine", "list_edit_projects", "get_edit_project", "list_edit_media", "prepare_edit_media_preview", "prepare_edit_media_proxy", "create_edit_project", "apply_edit_operation", "save_edit_project", "get_edit_history_info", "undo_edit_project", "redo_edit_project", "export_edit_otio", "import_edit_otio", "start_edit_render", "get_edit_render_job", "cancel_edit_render", "list_edit_render_jobs", "extract_timeline_frame", "list_timeline_frames", "prepare_timeline_continuation", "extract_last_frame", "create_video_continuation", "list_video_continuations", "update_video_continuation"],
    },
    commandTypes: ["novel_initialize_manuscript", "novel_create_volume", "novel_create_chapter", "novel_save_chapter", "novel_rename_chapter", "novel_move_chapter", "novel_reorder_chapters", "novel_recover_manuscript", "novel_seed_writing_state", "novel_stage_chapter_state_candidate", "novel_review_chapter_state_candidate", "novel_stage_story_bible_candidate", "novel_review_story_bible_candidate", "novel_invalidate_writing_state_from", "novel_attach_review_ticket", "scan_project", "stage_dudu_readonly_managed_project", "import_studio_media", "create_studio_asset", "update_studio_asset", "append_studio_asset_relation", "append_studio_asset_version", "review_studio_asset_version", "set_studio_primary_authority", "reuse_studio_global_resource", "create_studio_script_document", "create_studio_prompt_document", "append_studio_script_revision", "append_studio_script_section_revision", "append_studio_prompt_revision", "create_studio_production_unit", "revise_studio_production_unit", "materialize_local_creative_production_units", "analyze_studio_script_entities", "resolve_studio_entity_proposal", "confirm_studio_panel_empty", "freeze_studio_asset_binding_set", "freeze_studio_generation_pack", "dispatch_studio_generation_pack", "prepare_studio_imagegen_call", "reconcile_studio_imagegen_call", "abandon_studio_generation_unknown", "abandon_studio_detached_generation_unknown", "rebind_studio_imagegen_call_context", "register_studio_generation_result", "commit_agent_imagegen_result_bundle", "append_studio_continuity_observation", "append_studio_continuity_correction", "submit_studio_generation_review", "submit_studio_post_result_observation", "refresh_studio_generation_checkpoint", "attest_studio_generation_checkpoint", "create_studio_generation_plan", "fail_studio_generation_run", "cancel_studio_generation_run", "retry_studio_generation_plan_nodes", "finalize_dudu_readonly_managed_project", "prepare_studio_video_package_export", "build_studio_video_package", "attach_studio_multimedia_timeline_media", "materialize_fusion_project", "migrate_canonical_assets", "build_fusion_reference_board", "build_fusion_storyboard_grid", "materialize_fusion_panel_references", "materialize_fusion_visual_constraints", "upsert_fusion_visual_constraint_override", "upsert_panel_reference_override", "register_derived_panel_reference_artifact", "migrate_fusion_storyboard_evidence", "migrate_fusion_storyboard_sheets", "render_fusion_storyboard_sheet", "prepare_fusion_asset_consistency_review", "submit_fusion_asset_consistency_review", "seal_final_fusion_asset_consistency_batch", "commit_project_import", "commit_existing_production_recovery", "update_status", "claim_task", "heartbeat_task", "release_task", "cancel_task", "finish_batch", "create_task_pack", "create_shot_task_pack", "save_unit_timeline", "register_artifact", "verify_item", "set_authoritative_artifact", "promote_asset_to_hard_lock", "upsert_generation_provider", "enqueue_generation", "process_generation_queue", "cancel_generation", "update_browser_generation", "update_subagent_image_generation", "migrate_generation_execution_state", "reconcile_http_generation_submission", "preflight_publication", "register_publication", "cancel_publication", "fail_publication", "preflight_publication_bundle", "register_publication_bundle", "cancel_publication_bundle", "fail_publication_bundle", "submit_review", "upsert_context", "delete_context", "import_story_file", "import_story_text", "create_novel_analysis_task", "upsert_novel_analysis_provider", "plan_novel_analysis_run", "execute_next_novel_analysis_run_task", "replace_novel_analysis_run_task", "execute_novel_analysis_task", "submit_novel_analysis_proposal", "review_novel_analysis_item", "review_novel_analysis_batch", "analyze_novel_chapters", "generate_adaptation_plans", "regenerate_adaptation_scope", "select_adaptation_plan", "materialize_adaptation_plan", "upsert_novel_fact", "upsert_narrative_beat", "export_adaptation", "upsert_story_event", "connect_story_events", "update_workflow_stage", "upsert_creative_bible", "upsert_storyboard_row", "upsert_asset_relation", "upsert_voice_identity", "upsert_canvas_entity", "delete_canvas_entity", "upsert_canvas_link", "delete_canvas_link", "undo_canvas", "redo_canvas", "save_skill", "create_handoff", "save_script_document", "create_edit_project", "save_edit_project", "apply_edit_operation", "undo_edit_project", "redo_edit_project", "export_edit_otio", "import_edit_otio", "start_edit_render", "cancel_edit_render", "prepare_edit_media_preview", "prepare_edit_media_proxy", "extract_timeline_frame", "extract_last_frame", "create_video_continuation", "prepare_timeline_continuation", "update_video_continuation"],
    limits: { imageBatchMax: 6, videoBatchMax: 3, crossEpisodeBatch: false, storyboardShotsPerUnitMax: 6, unitDurationSecondsMax: 15, mcpReturnsBinary: false },
    managedStudio: {
      projectRoot: "explicit-or-zero-param-active-managed-context",
      activeContext: {
        tool: "get_active_managed_studio_context",
        parameters: "none",
        selection: "explicit-active-registration-only-never-first-project",
        tokenBinds: ["projectId", "manifestFingerprint", "activationId", "buildId", "sourceDigest"],
        staleOn: ["project-switch", "manifest-identity-change", "build-change"],
      },
      managedManifestFailClosed: true,
      pagination: "opaque-query-bound-cursor",
      writes: "execute_command-only",
      mediaReadProjection: "metadata-only-no-objectPath-or-thumbnail-path",
      mediaOriginReadProjection: "explicit-sha-query-project-relative-or-external-absolute-no-cas-path-no-scan",
      textReadProjection: "body-without-bodyPath",
      scriptSections: {
        writeCommand: "append_studio_script_section_revision",
        publicPayload: ["sectionId", "expectedRevision", "kind", "title", "scriptRevisionId", "scriptSha256", "startOffsetUtf16", "endOffsetUtf16"],
        kinds: ["chapter", "scene"],
        offsetSemantics: "utf16-half-open",
        concurrency: "append-only-head-revision-cas",
        readProjection: "get_studio_binding_control",
        readOperations: ["list_sections", "get_section"],
        listScope: "scriptRevisionId-resolves-script-document-current-heads",
        pageLimit: 100,
        readPayload: "metadata-only-no-body-or-path",
        lineage: "stable-sectionId-fixed-kind-and-script-document",
        durableReconciliation: "immutable-revision-row-proof-no-append-replay",
      },
      unitContract: {
        durationSeconds: { minimum: 1, maximum: 15, source: "studio_production_unit_timings" },
        panelCountMin: 2,
        panelCountMax: 6,
        season: "required-explicit-nonempty",
        sequenceScope: "unique-within-season-and-episode",
        episodeAbsoluteSeconds: "sum(preceding real unit durations)+missing legacy slots*15+unitLocalSeconds",
        applicabilityTimeContext: ["unitLocalStartSeconds", "unitLocalEndSeconds", "episodeAbsoluteStartSeconds", "episodeAbsoluteEndSeconds"],
      },
      assetKnowledge: {
        structuredApplicability: ["projects", "seasons", "episodes", "units", "timeRanges", "tags"],
        relationKinds: ["derived_from", "variant_of", "reference_of", "composite_member"],
        relationReadProjection: "get_studio_asset.relations",
        relationWriteCommand: "append_studio_asset_relation",
        relationConcurrency: "subject-and-object-revision-cas",
        relationSchema: "append-only-v2-superseding-heads",
        relationRecovery: "explicit-same-semantic-rebase",
        relationStatuses: ["current", "stale", "superseded"],
      },
      crossProjectAssetReuse: {
        writeCommands: [
          "export_studio_cross_project_asset_package",
          "import_studio_cross_project_asset_package",
          "reuse_studio_global_resource",
        ],
        transport: "immutable-content-addressed-package",
        sourceProjectBehavior: "read-only-export-no-ledger-write",
        targetVersionStatus: "pending",
        targetReviewRequired: true,
        targetPrimaryPromotionRequired: true,
        liveClone: false,
        crossProjectDatabaseRead: false,
      },
      localGenerationControlReferences: "dedicated-frozen-generation-package-only",
      bindingControl: {
        tool: "get_studio_binding_control",
        operations: ["list_units", "get_control", "list_sections", "get_section"],
        unitPageLimit: 36,
        sectionPageLimit: 100,
        panelCountRange: [2, 6],
        proposalsPerPanelMax: 256,
        candidatesPerProposalMax: 5,
        publicWritePayload: "ui-safe-ids-decisions-revision-token-and-bounded-codex-proposals-only",
        codexCandidateSemantics: "model-suggestion-only-never-auto-decision-or-binding",
        internalFieldsForbidden: ["assetSources", "expectedAnalysisHeadRevision", "expectedDecisionHeadRevision", "expectedBindingHeadRevision", "decisionReceiptIds"],
        writeCommands: ["analyze_studio_script_entities", "resolve_studio_entity_proposal", "confirm_studio_panel_empty", "freeze_studio_asset_binding_set"],
        durableReconciliation: "read-immutable-section-revisions-or-studio_binding_operation_receipts-only-no-write-replay",
      },
      generationControl: {
        tool: "get_studio_generation_control",
        operations: ["session-snapshot", "readiness", "pack", "history", "plan", "call", "active-runs", "detached-unknown"],
        targetKinds: ["panel", "unit-grid"],
        localPathExposure: "pack-operation-controlReferences-only-after-managed-media-cas-and-sha-verification",
        readinessAndHistoryPaths: "none",
        frozenPackCasPathExposure: "none",
        directWriteTools: false,
        writes: "execute_command-only",
        writeCommands: ["freeze_studio_generation_pack", "dispatch_studio_generation_pack", "prepare_studio_imagegen_call", "reconcile_studio_imagegen_call", "abandon_studio_generation_unknown", "abandon_studio_detached_generation_unknown", "rebind_studio_imagegen_call_context", "commit_agent_imagegen_result_bundle", "register_studio_generation_result", "create_studio_generation_plan", "fail_studio_generation_run", "cancel_studio_generation_run", "retry_studio_generation_plan_nodes"],
        unitGridPreCall: "prepare_studio_imagegen_call-first-success-only-callAllowed-true-replay-false",
        callerAgentIdentity: "prepare_studio_imagegen_call.callerAgentId-optional-stable-audit-id-historical-null",
        preferredWriteback: "commit_agent_imagegen_result_bundle-v4-v5-provider-required-atomic-pair",
        legacyWriteback: "register_studio_generation_result-read-compatible-only",
        executionReceipt: {
          sources: ["codex-imagegen", "grok-build-imagine", "fixture-canary"],
          attestationLevels: ["agent-session-direct", "unverified-external-agent"],
          cryptographicProviderReceipt: false,
          semantics: "agent-attestation-not-provider-signed-receipt",
        },
        liveQuarantine: "pre-call-intent-exact-candidate-and-receipt-paths-one-call-only",
        ownerAbandonRecovery: {
          remoteInvocationFact: "unknown-may-exist",
          lateResultPolicy: "quarantine-and-reject",
          publicationPolicy: "forbidden",
          newRunRisk: "may-duplicate-remote-work-or-cost-explicit-owner-ack-required",
        },
        contextRebindRecovery: {
          scope: "same-unit-grid-call-after-local-build-token-change-only",
          storage: "append-only-call-event-preserve-original-context-token-hash",
          prerequisites: ["generation_unknown", "pack-current", "no-results-or-terminal", "verified-quarantine-candidate-and-receipt"],
          modelCallAuthorized: false,
          commitPolicy: "current-active-token-must-match-single-rebind-event-and-frozen-input-hashes",
          idempotence: "same-facts-replay-different-facts-conflict",
        },
      },
      duduImportControl: {
        tools: ["discover_dudu_readonly_import_projects", "get_dudu_readonly_import_control"],
        discovery: "bounded-direct-children-zero-one-conflict-never-select-first",
        directWriteTools: false,
        writes: "execute_command-only",
        writeCommands: ["stage_dudu_readonly_managed_project", "finalize_dudu_readonly_managed_project"],
        stageCommandRoot: "<projectsRoot>/.aicanvas-dudu-import-transactions",
        commandLedgerScope: "dudu-bootstrap",
        paths: "not-exposed",
        stageFinalizeExposure: "execute-command-only-no-named-tools",
      },
      videoPackageControl: {
        tool: "get_studio_video_package_control",
        selectors: ["intent", "authority-latest"],
        authorityLatest: "query-only-append-only-chain-zero-or-one-never-guess",
        directWriteTools: false,
        writes: "execute_command-only",
        writeCommands: ["prepare_studio_video_package_export", "build_studio_video_package"],
        builderExecution: "managed-evidence-only-via-execute-command",
        dynamicVideoModel: "never",
      },
      continuityReviewControl: {
        tool: "get_studio_continuity_review_control",
        assetLimit: 6,
        fields: ["costume", "injury", "heldObject", "position", "facing", "emotion", "layout", "lighting", "referenceSha256"],
        readProjection: "bounded-continuity-review-checkpoint-and-generation-readiness",
        uniqueNextAction: "core-derived",
        directWriteTools: false,
        writes: "execute_command-only",
        writeCommands: [
          "append_studio_continuity_observation",
          "append_studio_continuity_correction",
          "submit_studio_generation_review",
          "submit_studio_post_result_observation",
          "refresh_studio_generation_checkpoint",
          "attest_studio_generation_checkpoint",
        ],
        checkpointBatchSize: 6,
        durableReconciliation: "immutable-continuity-review-checkpoint-operation-receipts-no-write-replay",
      },
      genericMediaIsNotGenerationControlPackage: true,
      legacyFilesystemScanForbidden: true,
    },
    scan: {
      incrementalMechanicalChecks: true,
      inspectionConcurrency: 6,
      streamingSha256ChunkBytes: 1_048_576,
      mcpProgressNotifications: true,
      cancellableCommands: ["scan_project"],
      cancellationBoundary: "before-index-commit",
      cancellationLedgerStatus: "cancelled",
      cancelledKeyReplay: false,
      reservedPublicationTargetsExcluded: true,
      publicationSnapshotAfterDiscovery: true,
    },
    fusionProduction: {
      sourceAccess: "read-only-hash-verified",
      materialization: "content-addressed-no-clobber",
      expectedCounts: { episodes: 32, units: 1_288, sourceShots: 1_472, scheduleRows: 2_640, assets: 77, characters: 24, scenes: 20, props: 33 },
      authorityContract: { expectedSha256Required: true, exposeToGenerationRequired: true, sourceWriteBack: false },
      continuityPagination: { trackLimitMax: 100, spanLimitMax: 200 },
      referenceBoard: { currentIndexRequired: true, acceptedHardLocksOnly: true, maximumReferences: 6, silentTruncation: false, mcpReturnsBinary: false },
      storyboardGrid: { minimumPanels: 2, maximumPanels: 6, automaticSelection: true, oneImagePerPanel: true, localChineseRendering: "svg-sharp-2160x3840", aiGeneratedTextAllowed: false },
      panelReferenceClosure: { resolverVersion: "panel-reference-resolution-v1", semanticReferencesMayExceedSupplierSlots: true, supplierSlotMaximum: 6, overflowPolicy: "reviewed-derived-composite-no-silent-truncation", closureSeparateFromGenerationReadiness: true, paginatedReads: true, mcpReturnsBinary: false },
      visualConstraints: { builderVersion: "panel-visual-constraint-v1", modelReviewSeparation: true, hiddenMaskPolicy: "golden-mask-panel-allowlist-v1", humanVisualReviewRequired: true, casOverrides: ["presence", "golden-mask-reveal"], paginatedReads: true, mcpReturnsBinary: false },
      canonicalAssets: { store: "content-addressed-project-local", mediaTruth: "filesystem-path-sha256", categories: ["character", "scene", "prop"], crossProjectSearch: false, legacyAuthorityWritesDisabledAfterMigration: true, migrationCommand: "migrate_canonical_assets", readTools: ["get_canonical_asset_catalog_state", "list_canonical_assets", "get_canonical_asset"] },
      writeCommands: ["materialize_fusion_project", "migrate_canonical_assets", "build_fusion_reference_board", "build_fusion_storyboard_grid", "materialize_fusion_panel_references", "upsert_panel_reference_override", "register_derived_panel_reference_artifact", "materialize_fusion_visual_constraints", "upsert_fusion_visual_constraint_override", "migrate_fusion_storyboard_evidence", "migrate_fusion_storyboard_sheets", "render_fusion_storyboard_sheet", "prepare_fusion_asset_consistency_review", "submit_fusion_asset_consistency_review", "seal_final_fusion_asset_consistency_batch"],
    },
    publication: {
      registrationConsistency: {
        mode: "two-phase-snapshot-validate-cas",
        persistentValidationState: false,
        validationOutsideProjectLock: true,
        intentCasFields: ["revision", "reservationToken", "status", "targetPath", "allowedRoot", "kind", "variant", "projectId"],
        transientFileIdentity: ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs", "canonicalRoot", "canonicalParent"],
        sha256Source: "fixed-o_nofollow-file-descriptor",
        concurrentSameIntent: "single-receipt",
        cancellationWinsOverStaleValidation: true,
        fileDriftLeavesIntentReserved: true,
        stableMechanicalFailure: "confirmed-failed",
        registeredReplayRevalidatesCurrentFile: true,
        rawLabeledBundle: {
          preflight: "two-intents-one-store-commit",
          members: ["primary:raw-image", "companion:labeled-image"],
          registration: "two-receipts-one-store-commit",
          singleMemberMutationRejected: true,
          sharedVersionAllocation: true,
          physicalPromotion: "exclusive-crash-recoverable",
          authorityRequiresBothReceipts: true,
        },
      },
    },
    generation: {
      httpRemoteRecovery: {
        observationStates: ["pending", "succeeded", "confirmed_failed", "retryable_or_unknown"],
        observationStages: ["submit", "poll", "download", "validation", "publish"],
        observationNextActions: ["poll_same_task", "retry_same_task", "inspect_remote_task", "inspect_publication", "none"],
        stableClientJobId: true,
        persistRemoteIdentityBeforeDownload: true,
        retryablePollErrorsRemainWaitingRemote: true,
        publicationReservationPreservedAcrossRetries: true,
        automaticPostReplayAfterUnknown: false,
        isolatedDownloadPerJob: true,
        partialFileNeverSignalsCompletion: true,
        verifiedNoClobberPromotion: true,
        resultRedirectRevalidated: true,
        terminalRemoteFailureRequiresStructuredFailureValue: true,
        cancellationConfirmation: "204-or-200-structured-cancelled",
        publicationTerminalReconciledBeforeCancel: true,
        companionNoClobber: true,
        mcpCommandResultsSanitized: true,
        remoteResultExposure: "hostname-only",
        remoteResultPersistence: "local-sidecar-only",
        recoveryScope: "single-job",
        waitingRemoteRecoveryAction: "process_generation_queue(jobId)",
        submissionUnknownRecoveryAction: "reconcile_http_generation_submission(jobId,expectedRevision,reconciliation)",
        submissionUnknownReconciliationCAS: true,
        submissionUnknownNotFoundRequiresExplicitConfirmation: true,
        submissionUnknownReconciliationMakesRemoteRequests: false,
        generationPublicationTerminalRequiresStructuredProvenance: true,
      },
      subagentImagegen: {
        adapter: "codex-subagent-imagegen",
        kinds: ["image"],
        oneAgentPerImage: true,
        projectConcurrency: 1,
        providerConcurrency: 1,
        migrationSourceStages: ["plan_ready", "preflight_blocked"],
        preservesGenerationJobAndPublication: true,
        executionStates: ["plan_ready", "leased", "generating", "generation_unknown", "candidate_generated", "visual_rejected", "verified"],
        leaseFields: ["leaseId", "owner", "heartbeatAt", "leaseUntil", "leaseSeconds", "fence"],
        leaseActions: ["claim", "heartbeat", "release", "takeover"],
        legacyLeaseRecovery: "migrate_generation_execution_state-to-generation_unknown",
        leaseBeforeSpawn: true,
        callIntentBeforeModel: true,
        callIntentFields: ["callId", "runId", "leaseId", "owner", "attempt", "maxCalls", "executionSnapshotHash"],
        callWithoutReceipt: "generation_unknown-no-retry",
        exactlyOneImagePerLease: true,
        frozenPromptParametersAndReferenceHashes: true,
        remoteIdentityRequired: false,
        directFormalOutputRejected: true,
        isolatedCopyAndShaRequired: true,
        candidateRequiresVisualDecision: true,
        rawLabeledPublicationBundleRequired: true,
        mechanicalPublicationRequired: true,
        mainAgentVisualReviewRequired: true,
      },
    },
    resources: ["aicanvas://server/capabilities", "aicanvas://projects", "aicanvas://projects/{projectId}/snapshot", "aicanvas://projects/{projectId}/items/{itemId}", "aicanvas://projects/{projectId}/artifacts/{artifactId}", "aicanvas://projects/{projectId}/canvas", "aicanvas://projects/{projectId}/tasks", "aicanvas://projects/{projectId}/generation/{jobId}", "aicanvas://projects/{projectId}/editor/{editProjectId}", "aicanvas://projects/{projectId}/story/chapters/{chapterId}", "aicanvas://projects/{projectId}/changes/{cursor}"],
    prompts: ["managed_studio_lock_generate_writeback", "resume_project", "produce_next_image_batch", "produce_next_video_batch", "run_browser_generation", "continue_video_from_last_frame", "review_visual_batch", "recover_interrupted_work"],
    editor: {
      engine,
      features: ["multi-visual-track", "picture-in-picture", "transform-keyframes", "keyframe-easing-curves", "custom-bezier-curves", "arbitrary-keyframe-curve-subdivision", "main-track-transform-keyframes", "complex-nested-timelines", "frozen-nested-timeline-snapshots", "otio-linear-time-warp", "otio-smpte-dissolve", "bounded-third-party-effect-transition-compatibility", "filters", "audio-mix", "subtitles", "transitions", "operational-editor-api", "atomic-revision-cas", "integer-frame-time", "fractional-timebase", "playhead-split", "ripple-edit", "persistent-undo-redo", "otio-import-export", "lazy-audio-waveform", "lazy-video-filmstrip", "image-thumbnails", "local-proxy-media", "timeline-composite-frame", "frame-provenance", "background-render-progress", "single-project-render-capacity", "project-media-capacity", "machine-media-capacity", "weighted-fifo-media-scheduling", "process-group-termination", "media-stage-timeouts", "orphan-media-reaping", "render-priority-over-preview", "render-ffprobe-gate", "render-cancel", "stale-render-recovery", "source-video-last-frame", "video-continuation-pack", "continuation-status-sync"],
      keyframeCurves: {
        contractVersion: 2,
        scope: "all-visual-tracks",
        segmentOwnership: "destination-keyframe-controls-entering-segment",
        presets: {
          linear: "p",
          ease_in: "p^2",
          ease_out: "1-(1-p)^2",
          ease_in_out: "p^2*(3-2p)",
          hold: "0-until-destination-frame",
        },
        custom: {
          easing: "cubic_bezier",
          field: "bezier",
          order: ["x1", "y1", "x2", "y2"],
          authored: { mode: "unit", editable: true, controlPointRange: [0, 1], precisionDecimals: 6, monotonic: true, overshoot: false, default: [.42, 0, .58, 1] },
          derived: { mode: "derived_monotone", editable: false, controlPointAbsoluteLimit: 1_000_000, precisionDecimals: 15, monotonic: true, sourceWindow: "original-easing-curve-plus-required-integer-frame-window", sourceTransform: "original-segment-start-and-end-transform-anchors", semanticAuthority: "sourceWindow+sourceTransform" },
        },
        evaluator: { preview: "frame-evaluator-from-original-easing-and-transform-anchors", render: "ffmpeg-original-affine-frame-index-root-x-then-y", sharedDefinition: true, fractionalTimebase: "integer-frame-authoritative", splitBoundary: "same-original-curve-frame-ratio", roundedChildBoundaryIsNotSemanticAuthority: true },
        persistence: { projectJson: true, updateClipCas: true, undoRedoSnapshots: true, maxPerClip: 200, duplicateFramePolicy: "reject" },
        editing: { splitTrim: "arbitrary-frame-lossless-subdivision", arbitraryCurveSubdivision: true, algorithm: "de-casteljau-coordinate-renormalization", quantization: "project-integer-frame", boundaryPolicy: "evaluate-and-insert-left-static-base-right", continuousPresetPolicy: "materialize-as-cubic-bezier", holdPolicy: "step-at-destination-frame-preserved", failurePolicy: "reject-if-unprovable", ui: { playheadSplit: true, edgeTrim: true }, mcpOperations: ["split_clip", "trim_to_playhead"] },
        otio: { namespace: "metadata.aicanvas", contract: "aicanvas.cubic-bezier.v2", acceptedContracts: ["aicanvas.cubic-bezier.v1", "aicanvas.cubic-bezier.v2"], exportPolicy: "lowest-compatible-v1-unit-v2-derived", portability: "aicanvas-private-metadata", roundTrip: true, foreignCurvePolicy: "reject" },
      },
      nestedTimelines: {
        contractVersion: 1,
        clipKind: "timeline",
        contract: "aicanvas.nested-timeline.v1",
        renderContract: "aicanvas.nested-timeline.ffmpeg.v1",
        maximumDepth: 8,
        ownership: "same-ai-canvas-project",
        identity: { childEditProjectId: true, childEditProjectRevision: true, childSnapshotSha256: true, childCanvas: true, childTimebase: true },
        snapshots: { immutable: true, contentAddressedSha256: true, historyIndependent: true, tamperDetection: true, refreshPolicy: "explicit-current-child-revision" },
        timeMapping: { parentAuthority: "integer-frame", childAuthority: "reduced-rational-source-offset-and-step", fractionalTimebases: true, splitTrimLossless: true },
        editing: { operations: ["add_nested_timeline", "refresh_nested_timeline"], move: true, ripple: true, split: true, trim: true, undoRedo: true, revisionCas: true, genericPatchCannotForgeReference: true },
        resolver: { recursive: true, cycleDetection: true, depthLimit: 8, dependencyManifestSha256: true, renderPlanSha256: true, consumers: ["synchronous-render", "background-render", "timeline-frame", "timeline-continuation", "electron-preview"] },
        media: { childVisualTracks: true, childAudio: true, childSubtitles: true, outerTransformFilterVolume: true, browserPreview: "content-addressed-h264-aac-mp4" },
        provenance: { dependencyRefs: true, recursiveSourceClipRefs: true, renderJob: true, publicationReceipt: true, continuationPack: true },
        otio: { namespace: "metadata.aicanvas", contract: "aicanvas.nested-timeline.v1", container: "Stack.1-private-subset", roundTrip: true, unknownStructurePolicy: "reject" },
        mcp: { tool: "apply_edit_operation", commandBus: "execute_command", operations: ["add_nested_timeline", "refresh_nested_timeline"], idempotentReplay: true },
        failurePolicy: "reject-missing-drifted-tampered-cyclic-overdepth-or-unprovable",
      },
      effectTransitions: {
        contractVersion: 1,
        contract: "aicanvas.otio-effect-transition.v1",
        scope: "bounded-standard-otio-subset",
        linearTimeWarp: { schema: "LinearTimeWarp.1", effectName: "LinearTimeWarp", mediaKinds: ["video", "audio"], scalarRange: [.1, 8], integerFrameAuthority: true, requiresVerifiedLocalAvailableRange: true, genericEffectPolicy: "reject" },
        smpteDissolve: { schema: "Transition.1", transitionType: "SMPTE_Dissolve", trackScope: "lowest-order-main-visual", adjacency: "Clip.2-Transition.1-Clip.2", offsets: "positive-integer-frames", handleValidation: "verified-local-pre-roll-and-post-roll", audioPolicy: "independent-audio-track-time-unchanged" },
        combinations: { linearTimeWarpWithDissolve: false, transformKeyframesWithDissolve: false, fadeEnvelopeWithDissolve: false, privateFadeIsStandardDissolve: false },
        rendering: { synchronous: true, background: true, timelineFrame: true, continuation: true, fractionalTimebase: true },
        roundTrip: { import: true, export: true, reimport: true, exactIntegerOffsets: true, exactTimeScalar: true, unknownOrOpaquePolicy: "reject" },
        editing: { updateClipCas: true, splitMovesOutgoingTransitionIdentityToRight: true, destructiveMoveOrTrim: "reject", undoRedoSnapshots: true },
        ui: { stableTestIds: true, dualMediaPreview: true, frameOffsetControls: true },
        mcp: { tool: "apply_edit_operation", commandBus: "execute_command", operation: "update_clip", idempotentReplay: true },
      },
      mediaScheduling: {
        scope: "machine-cross-project-cross-process",
        algorithm: "strict-weighted-fifo",
        machineCapacity: machineMedia.capacity,
        activeWeight: machineMedia.activeWeight,
        queueDepth: machineMedia.queueDepth,
        weights: { ffprobe: MEDIA_WEIGHTS.probe, foregroundFfmpeg: MEDIA_WEIGHTS.foreground, renderFfmpeg: MEDIA_WEIGHTS.render },
        foregroundHeavyJobsPerProject: 1,
        activeRenderBlocksForegroundJobs: true,
        lifecycle: { boundedOutput: true, stageTimeouts: true, processGroupTermination: true, deadOwnerReaping: true },
        protectedJobs: ["scan-probe", "publication-probe", "preview", "proxy", "timeline-frame", "last-frame", "timeline-continuation", "synchronous-render", "background-render"],
      },
      missingForFullNle: [],
    },
    generationAdapters: ["folder-bridge", "http-json", "comfyui-local", "codex-browser", "codex-subagent-imagegen", "mock"],
    generationAdapterContracts: {
      comfyUiLocal: {
        transport: "loopback-http-only",
        kinds: ["image"],
        workflowFormat: "comfyui-api",
        promptIdentity: "caller-persisted-canonical-uuid-before-post",
        terminalFacts: ["history", "queue", "validated-output-file"],
        outputBinding: ["promptId", "outputNodeId", "outputIndex", "filename", "subfolder", "type=output"],
        cancellation: { endpoint: "atomic-api-jobs-cancel", pendingConfirmation: "server-acted-and-stable-absent", runningConfirmation: "exact-history-execution-interrupted", unconfirmed: "keep-job-and-publication-locked" },
        websocketIsTerminalFact: false,
        realEnvironmentCalibration: "requires-user-authorization",
      },
      codexSubagentImagegen: {
        kinds: ["image"],
        execution: "one-canonical-subagent-task-per-image",
        resultIdentity: ["leaseId", "agentTaskName", "agentRunId", "sourceSha256", "isolatedSha256"],
        remoteIdentityRequired: false,
        publication: "same-job-same-reserved-publication",
        visualAcceptance: "main-agent-content-bound-review",
      },
    },
    project,
  };
  capabilities.domains.novelManuscript.splice(
    6,
    0,
    "list_novel_writing_source_receipts",
    "compare_novel_writing_source_receipts",
  );
  capabilities.domains.novelManuscript.splice(
    capabilities.domains.novelManuscript.indexOf("plan_novel_state_rebuild") + 1,
    0,
    "get_novel_state_rebuild_status",
  );
  capabilities.domains.story.splice(
    capabilities.domains.story.indexOf("get_novel_analysis_runs") + 1,
    0,
    "get_novel_analysis_execution_recovery",
  );
  capabilities.commandTypes.splice(
    capabilities.commandTypes.indexOf("novel_recover_manuscript"),
    0,
    "novel_rebuild_search_index",
  );
  capabilities.commandTypes.splice(
    capabilities.commandTypes.indexOf("novel_recover_manuscript") + 1,
    0,
    "novel_recover_writing_state",
  );
  capabilities.commandTypes.splice(
    capabilities.commandTypes.indexOf("novel_attach_review_ticket") + 1,
    0,
    "novel_import_writing_source_snapshot",
  );
  capabilities.commandTypes.splice(
    capabilities.commandTypes.indexOf("replace_novel_analysis_run_task") + 1,
    0,
    "mark_novel_analysis_execution_reconciliation_required",
    "reconcile_novel_analysis_execution",
  );
  return capabilities;
}

export async function getProjectChanges(projectRoot: string, cursor?: string, limit = 200) {
  const events = (await listEvents(projectRoot, 2_000)).reverse();
  let start = 0;
  if (cursor && cursor !== "start") {
    const index = events.findIndex((event) => event.id === cursor);
    if (index < 0) throw new Error(`变更游标不存在或已超出保留窗口：${cursor}`);
    start = index + 1;
  } else if (!cursor) start = Math.max(0, events.length - Math.max(1, Math.min(limit, 500)));
  const boundedLimit = Math.max(1, Math.min(limit, 500));
  const changes = events.slice(start, start + boundedLimit);
  return {
    projectRoot: path.resolve(projectRoot),
    previousCursor: cursor,
    nextCursor: changes.at(-1)?.id ?? cursor ?? events.at(-1)?.id,
    hasMore: start + changes.length < events.length,
    changes: sanitizeDiagnosticValue(changes),
  };
}

export async function doctorProject(projectRoot: string) {
  const root = path.resolve(projectRoot);
  const paths = getSidecarPaths(root);
  const checks: DoctorCheck[] = [];
  const rootReadable = await canAccess(root, fsConstants.R_OK);
  const rootWritable = await canAccess(root, fsConstants.W_OK);
  checks.push({ id: "project-root", level: rootReadable ? "ok" : "error", title: "项目主根", detail: rootReadable ? `可读取：${root}` : `不存在或不可读取：${root}`, suggestedAction: rootReadable ? undefined : "修正路径后调用 preview_project_import。", paths: [root] });
  if (!rootReadable) return { healthy: false, projectRoot: root, checkedAt: new Date().toISOString(), checks, suggestedNextCalls: ["preview_project_import"] };
  checks.push({ id: "project-root-write", level: rootWritable ? "ok" : "warning", title: "项目写入权限", detail: rootWritable ? "主根可写，可创建侧车和新版本。" : "主根只读；只能观察，不能导入或落盘新版本。", suggestedAction: rootWritable ? undefined : "选择可写输出根或修复目录权限。", paths: [root] });
  let index: ProjectIndex | null;
  try {
    index = await loadIndex(root);
  } catch (error) {
    checks.push({ id: "index-corrupt", level: "error", title: "扫描索引损坏", detail: error instanceof Error ? error.message : String(error), suggestedAction: "保留损坏文件作为现场；确认项目路径后重新扫描生成新索引，不要手工伪造完成状态。", paths: [paths.index] });
    return { healthy: false, projectRoot: root, checkedAt: new Date().toISOString(), checks, suggestedNextCalls: ["preview_scan_project", "scan_project"] };
  }
  if (!index) {
    checks.push({ id: "index", level: "error", title: "扫描索引", detail: "未找到 .aicanvas/index.json；项目尚未正式导入或首次扫描。", suggestedAction: "先调用 preview_project_import，确认后调用 commit_project_import。", paths: [paths.index] });
    return { healthy: false, projectRoot: root, checkedAt: new Date().toISOString(), checks, suggestedNextCalls: ["preview_project_import", "commit_project_import"] };
  }
  const scanReuse = index.scanStats ? `；机械检查新检 ${index.scanStats.inspectedChecks}、复用 ${index.scanStats.reusedChecks}${index.scanStats.reservedPublicationFilesSkipped ? `、跳过写入中 ${index.scanStats.reservedPublicationFilesSkipped}` : ""}` : "";
  checks.push({ id: "index", level: "ok", title: "扫描索引", detail: `扫描 ${index.scanId}，${index.scannedAt}，共 ${index.summary.total} 个生产单元${scanReuse}。`, paths: [paths.index] });
  const scanAgeMs = Date.now() - Date.parse(index.scannedAt);
  if (!Number.isFinite(scanAgeMs) || scanAgeMs > 24 * 60 * 60 * 1_000) checks.push({ id: "scan-age", level: "warning", title: "扫描时效", detail: `最近扫描已超过 24 小时：${index.scannedAt}`, suggestedAction: "开始生产前调用 scan_project 刷新真实文件状态。" });
  else checks.push({ id: "scan-age", level: "ok", title: "扫描时效", detail: "扫描快照在 24 小时内。" });

  const config = await loadProjectConfig(root).catch((error) => {
    checks.push({ id: "config-corrupt", level: "error", title: "项目配置损坏", detail: error instanceof Error ? error.message : String(error), suggestedAction: "保留 project.json 并从导入预检重新确认根目录、忽略规则和硬锁；不要继续写入。", paths: [paths.config] });
    return index.project;
  });
  for (const [role, roots] of [["source", config.sourceRoots], ["output", config.outputRoots]] as const) {
    for (const configuredRoot of roots) {
      const readable = await canAccess(configuredRoot, fsConstants.R_OK);
      const writable = role === "output" ? await canAccess(configuredRoot, fsConstants.W_OK) : true;
      checks.push({ id: `${role}-root:${configuredRoot}`, level: readable && writable ? "ok" : "error", title: role === "output" ? "输出根" : "附加来源根", detail: readable && writable ? `${role === "output" ? "可读写" : "可读取"}：${configuredRoot}` : `不可用：${configuredRoot}`, suggestedAction: readable && writable ? undefined : "在项目设置中修正或移除此根目录。", paths: [configuredRoot] });
    }
  }

  const brokenArtifacts = index.artifacts.filter((artifact) => !artifact.deprecated && !artifact.check.ok);
  checks.push({ id: "mechanical", level: brokenArtifacts.length ? "warning" : "ok", title: "机械验收", detail: brokenArtifacts.length ? `${brokenArtifacts.length} 个非弃用素材未通过机械验收。` : "所有当前素材均通过机械验收。", suggestedAction: brokenArtifacts.length ? "调用 get_project_snapshot 查看失败节点，再用 verify_item 复检。" : undefined, paths: brokenArtifacts.slice(0, 10).map((artifact) => artifact.path) });
  const itemIds = new Set(index.items.map((item) => item.id));
  const orphanArtifacts = index.artifacts.filter((artifact) => !itemIds.has(artifact.itemId));
  checks.push({ id: "artifact-mapping", level: orphanArtifacts.length ? "error" : "ok", title: "素材映射", detail: orphanArtifacts.length ? `${orphanArtifacts.length} 个素材引用了不存在的生产节点。` : "素材与生产节点映射完整。", suggestedAction: orphanArtifacts.length ? "重新调用 scan_project；若仍存在，检查目录命名规则。" : undefined });

  const diagnoseSidecar = async <T>(id: string, title: string, filePath: string, operation: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      checks.push({ id, level: "error", title, detail: error instanceof Error ? error.message : String(error), suggestedAction: "保留损坏侧车和审计日志，停止相关写入；从最后可验证的真实文件与事件恢复。", paths: [filePath] });
      return fallback;
    }
  };
  let productionWorkflow: ProductionWorkflow | null = null;
  let fusionAssetConsistency: FusionAssetConsistencyState | null = null;
  let fusionPanelReferences: FusionPanelReferenceResolutionStore | null = null;
  let fusionPanelReferenceCurrentness: FusionPanelReferenceCurrentness | null = null;
  const fusionProjectPresent = await canAccess(paths.fusionProjectManifest, fsConstants.R_OK);
  const fusionPanelReferenceStorePresent = fusionProjectPresent && await canAccess(paths.panelReferenceResolutions, fsConstants.R_OK);
  const [generationJobs, renderJobs, continuations, publicationIntents, _eventProbe, engine, tasks, relations, voices, runtimeModules, projectLocks, commandLedger, adaptationWorkspace] = await Promise.all([
    diagnoseSidecar("generation-store-corrupt", "生成队列侧车", paths.generationJobs, () => listGenerationJobs(root), []),
    diagnoseSidecar("render-store-corrupt", "剪辑导出侧车", paths.editorRenders, () => withEditor((editor) => editor.readEditRenderJobs(root)), []),
    diagnoseSidecar("continuation-store-corrupt", "视频续接侧车", paths.editorContinuations, () => withEditor((editor) => editor.listVideoContinuationPacks(root)), []),
    diagnoseSidecar("publication-store-corrupt", "素材发布侧车", paths.publications, () => listPublicationIntents(root), []),
    diagnoseSidecar("event-log-corrupt", "追加式事件日志", paths.events, () => listEvents(root, 2_000), []),
    withEditor((editor) => editor.probeVideoEngine()),
    diagnoseSidecar("task-store-corrupt", "任务包侧车", paths.tasks, () => listTaskPacks(root), []),
    diagnoseSidecar("asset-relation-store-corrupt", "资产关系侧车", paths.assetRelations, () => listAssetRelations(root), []),
    diagnoseSidecar("voice-store-corrupt", "音色身份侧车", paths.voiceIdentities, () => listVoiceIdentities(root), []),
    Promise.allSettled([loadSharp(), import("mammoth")]),
    listProjectLocks(root),
    diagnoseSidecar("command-ledger-corrupt", "幂等命令账本", paths.commandLedger, async () => ({ entries: await listCommandLedger(root, 500) }), { entries: [] }),
    diagnoseSidecar("adaptation-store-corrupt", "小说自动改编侧车", paths.storyAdaptation, () => withAdaptation((adaptation) => adaptation.getAdaptationWorkspace(root)), null),
  ]);
  const machineMediaConfig = getMachineMediaRuntimeConfig();
  let machineMediaRuntime: Awaited<ReturnType<typeof readMachineMediaRuntimeSnapshot>> | undefined;
  try {
    machineMediaRuntime = await readMachineMediaRuntimeSnapshot();
  } catch (error) {
    checks.push({
      id: "machine-media-runtime",
      level: "error",
      title: "机器级媒体运行时",
      detail: error instanceof Error ? error.message : String(error),
      suggestedAction: "停止启动新的 FFmpeg/ffprobe；保留状态文件，核对活动 PID 与进程组后再修复或重建可恢复运行时。",
      paths: [path.join(machineMediaConfig.runtimeDirectory, "state.json")],
    });
  }
  const criticalSidecarIds = [
    "production-workflow-corrupt",
    "creative-bible-store-corrupt",
    "storyboard-store-corrupt",
    "review-store-corrupt",
    "canvas-store-corrupt",
    "canvas-history-corrupt",
    "story-index-corrupt",
    "story-event-store-corrupt",
    "timeline-store-corrupt",
    "editor-project-store-corrupt",
    "editor-session-corrupt",
    "skill-store-corrupt",
    "context-store-corrupt",
    ...(fusionProjectPresent ? ["asset-consistency-store-corrupt"] : []),
    ...(fusionPanelReferenceStorePresent ? ["panel-reference-store-corrupt"] : []),
    ...(fusionPanelReferenceStorePresent ? ["panel-reference-currentness-failed"] : []),
  ];
  await Promise.all([
    diagnoseSidecar("production-workflow-corrupt", "生产状态机侧车", paths.productionWorkflow, async () => {
      const workflow = await getProductionWorkflow(root);
      if (workflow.schemaVersion !== 1 || !Number.isInteger(workflow.revision) || workflow.revision < 0 || workflow.stages.length !== 15) throw new Error("生产状态机结构无效。 ");
      productionWorkflow = workflow;
      return workflow;
    }, null),
    diagnoseSidecar("creative-bible-store-corrupt", "创作 Bible 侧车", paths.creativeBibles, () => listCreativeBibles(root), []),
    diagnoseSidecar("storyboard-store-corrupt", "正式分镜侧车", paths.storyboards, async () => {
      const storyboard = await getStoryboard(root);
      if (!Number.isInteger(storyboard.revision) || storyboard.revision < 0 || !Array.isArray(storyboard.rows)) throw new Error("正式分镜结构无效。 ");
      return storyboard;
    }, null),
    diagnoseSidecar("review-store-corrupt", "导演验收侧车", paths.reviews, () => listReviewRecords(root, { limit: 1_000 }), []),
    diagnoseSidecar("canvas-store-corrupt", "无限画布语义侧车", paths.canvasSemantic, async () => {
      const canvas = await getCanvasSemanticState(root);
      if (canvas.schemaVersion !== 1 || !Number.isInteger(canvas.revision) || canvas.revision < 0 || !Array.isArray(canvas.entities) || !Array.isArray(canvas.links)) throw new Error("无限画布语义结构无效。 ");
      return canvas;
    }, null),
    diagnoseSidecar("canvas-history-corrupt", "无限画布历史侧车", paths.canvasHistory, () => getCanvasHistoryInfo(root), null),
    diagnoseSidecar("story-index-corrupt", "小说来源与章节索引", paths.storyIndex, async () => withStory((story) => Promise.all([story.listStorySources(root), story.listStoryChapters(root)])), [[], []]),
    diagnoseSidecar("story-event-store-corrupt", "故事事件侧车", paths.storyEvents, () => withStory((story) => story.listStoryEvents(root, { includeOrphans: true })), []),
    diagnoseSidecar("timeline-store-corrupt", "原镜头时间线侧车", paths.timeline, () => getUnitTimelines(root), []),
    diagnoseSidecar("editor-project-store-corrupt", "剪辑工程侧车", paths.editorProjects, () => withEditor((editor) => editor.listEditProjects(root)), []),
    diagnoseSidecar("editor-session-corrupt", "剪辑会话侧车", paths.editorSession, async () => {
      const session = await withEditor((editor) => editor.getEditorSessionState(root));
      if (session && (session.schemaVersion !== 1 || typeof session.sessionId !== "string" || typeof session.cleanShutdown !== "boolean")) throw new Error("剪辑会话结构无效。 ");
      return session;
    }, null),
    diagnoseSidecar("skill-store-corrupt", "项目 Skill 侧车", paths.skills, () => readAgentSkills(root), []),
    diagnoseSidecar("context-store-corrupt", "项目上下文侧车", paths.context, () => listProjectContext(root, { limit: 2_000 }), []),
  ]);
  if (fusionProjectPresent) fusionAssetConsistency = await diagnoseSidecar("asset-consistency-store-corrupt", "六张资产一致性侧车", paths.assetConsistencyBatches, () => getFusionAssetConsistencyState(root), null);
  if (fusionPanelReferenceStorePresent) fusionPanelReferences = await diagnoseSidecar("panel-reference-store-corrupt", "逐格引用闭包侧车", paths.panelReferenceResolutions, () => loadFusionPanelReferenceStore(root), null);
  if (fusionPanelReferences) fusionPanelReferenceCurrentness = await diagnoseSidecar("panel-reference-currentness-failed", "逐格引用闭包当前性", paths.panelReferenceResolutions, () => inspectFusionPanelReferenceCurrentness(root), null);
  if (fusionPanelReferences && fusionPanelReferenceCurrentness
    && (fusionPanelReferences.revision !== fusionPanelReferenceCurrentness.storeRevision
      || fusionPanelReferences.storeFingerprint !== fusionPanelReferenceCurrentness.storeFingerprint)) {
    checks.push({ id: "panel-reference-concurrent-revision", level: "error", title: "逐格引用闭包并发修订", detail: "Doctor 读取期间 P2 引用仓发生变化，拒绝把跨修订审计伪装为当前状态。", suggestedAction: "重新运行 doctor_project；若持续发生，等待当前物化命令完成并检查项目写锁。", paths: [paths.panelReferenceResolutions] });
    fusionPanelReferenceCurrentness = { ...fusionPanelReferenceCurrentness, current: false, driftedInputs: [...new Set([...fusionPanelReferenceCurrentness.driftedInputs, "panel-reference-store"])] };
  }
  const criticalSidecarErrors = checks.filter((check) => criticalSidecarIds.includes(check.id)).length;
  checks.push({ id: "critical-sidecars", level: criticalSidecarErrors ? "error" : "ok", title: "核心生产侧车", detail: criticalSidecarErrors ? `${criticalSidecarErrors} 个核心生产侧车损坏；统一快照和相关写入均不安全。` : `${criticalSidecarIds.length} 类核心生产侧车可读取且基础结构有效。`, suggestedAction: criticalSidecarErrors ? "先保留损坏文件并从历史、审计事件和真实素材恢复；修复前不要继续相关写入。" : undefined });
  if (fusionProjectPresent && !checks.some((check) => check.id === "panel-reference-store-corrupt")) {
    const audit = fusionPanelReferences?.audit;
    const closureErrors = audit ? audit.unresolvedPanels + audit.knownAssetMissingBindings + audit.unhandledOverflowPanels + audit.timeSpanContinuityMismatches : 0;
    const generationBlocked = audit ? audit.pendingHardLockPanels + audit.pendingDerivedArtifactPanels : 0;
    checks.push({
      id: "fusion-panel-reference-closure",
      level: !audit ? "warning" : !fusionPanelReferenceCurrentness?.current || !audit.closurePassed || closureErrors ? "error" : generationBlocked ? "warning" : "ok",
      title: "全季逐格引用闭包",
      detail: !audit
        ? "已识别融合工程，但尚未物化 P2 逐格引用解析仓。"
        : `${audit.currentContracts} 个当前合同、${audit.panels} 格；未解决 ${audit.unresolvedPanels}，已知资产缺绑定 ${audit.knownAssetMissingBindings}，未处理超六项 ${audit.unhandledOverflowPanels}，时间段错配 ${audit.timeSpanContinuityMismatches}；闭包${audit.closurePassed ? "通过" : "未通过"}，当前性${fusionPanelReferenceCurrentness?.current ? "有效" : `失效（${fusionPanelReferenceCurrentness?.driftedInputs.join("、") || "检查失败"}）`}。生图就绪 ${audit.generationReadyPanels}/${audit.panels}，待硬锁 ${audit.pendingHardLockPanels} 格，待派生视觉产物 ${audit.pendingDerivedArtifactPanels} 格；后两项不伪装为闭包错误。`,
      suggestedAction: !audit
        ? "使用稳定幂等键调用 materialize_fusion_panel_references，再调用 audit_fusion_panel_references。"
        : !fusionPanelReferenceCurrentness?.current
          ? "引用闭包输入或引用文件已漂移；保留旧仓作为证据，使用新幂等键重新执行 materialize_fusion_panel_references，然后 audit_fusion_panel_references。"
        : !audit.closurePassed || closureErrors
          ? "调用 audit_fusion_panel_references 和分页 list_fusion_panel_reference_resolutions；修复真实输入或用 resolution/store revision CAS 记录明确裁决后重新物化。"
          : generationBlocked ? "闭包已通过；按阻塞码完成资产硬锁与派生组合图视觉验收，未就绪宫格禁止生图。" : undefined,
      paths: [paths.panelReferenceResolutions],
    });
  }
  if (fusionAssetConsistency) {
    const batch = fusionAssetConsistency.batches.at(-1);
    const invalidated = batch?.status === "invalidated";
    const unfinished = Boolean(batch && !batch.canStartNextBatch);
    checks.push({
      id: "fusion-asset-consistency",
      level: invalidated ? "error" : !fusionAssetConsistency.persisted || unfinished ? "warning" : "ok",
      title: "第三季每六张一致性门禁",
      detail: batch
        ? `${batch.id}：${batch.status}，${batch.memberCount}/6 项，证据 ${batch.readyCount}/${batch.memberCount}，当前硬锁 ${batch.hardLockCount}/${batch.memberCount}；${fusionAssetConsistency.persisted ? "侧车已持久化" : "仅为安全推导，尚未持久化"}。`
        : `尚无资产批次；${fusionAssetConsistency.persisted ? "侧车已持久化" : "侧车尚未持久化"}。`,
      suggestedAction: invalidated
        ? "停止新资产与分镜生图，调用 get_fusion_asset_consistency 核对漂移证据并对原批次资产返工。"
        : !fusionAssetConsistency.persisted
          ? "调用 prepare_fusion_asset_consistency_review 安全接管尚无远端副作用的既有资产任务。"
          : batch?.canPrepareReview
            ? "调用 prepare_fusion_asset_consistency_review 生成只用于人工复核的 2×3 中文板，再逐项提交七项标准。"
            : unfinished ? "调用 get_fusion_asset_consistency 查看六项 Publication、raw/labeled、单图 Review 或硬锁缺口。" : undefined,
      paths: [paths.assetConsistencyBatches],
    });
  }
  let productionEvidence: ProductionWorkflowEvidenceSummary | null = null;
  let existingProductionRecoveryRequired = false;
  let existingProductionScoped = false;
  if (productionWorkflow && criticalSidecarErrors === 0) {
    const auditedWorkflow = await diagnoseSidecar<ProductionWorkflow | null>("production-evidence-audit-failed", "生产阶段真实证据审计", paths.productionWorkflow, () => getProductionWorkflow(root, { includeEvidenceAudit: true }), null);
    if (auditedWorkflow?.evidenceAudit) {
      productionEvidence = summarizeProductionEvidence(auditedWorkflow);
      const blockerPaths = productionEvidence.blockers.flatMap((stage) => stage.evidencePaths).slice(0, 30);
      const legacyPaths = productionEvidence.legacyUnverifiedStages.flatMap((stage) => stage.evidencePaths).slice(0, 30);
      checks.push({
        id: "production-evidence-drift",
        level: productionEvidence.repairRequired ? "error" : "ok",
        title: "生产阶段证据漂移",
        detail: productionEvidence.repairRequired
          ? `${productionEvidence.counts.invalidCompleted} 个 completed 阶段的真实证据已失效：${productionEvidence.blockers.map((stage) => `${stage.name}（${stage.issues.join("、") || "证据不再满足门禁"}）`).join("；")}`
          : `${productionEvidence.counts.completed} 个 completed 阶段均未发现证据失效。`,
        suggestedAction: productionEvidence.repairRequired ? "先调用 get_production_workflow 读取完整问题；修复真实文件或引用后，使用 productionEvidence.nextRepair 提供的当前 revision 与参数调用 execute_command(command=update_workflow_stage)，禁止继续领取下游任务。" : undefined,
        paths: blockerPaths.length ? blockerPaths : undefined,
      });
      checks.push({
        id: "production-evidence-verification",
        level: productionEvidence.counts.legacyUnverified ? "warning" : "ok",
        title: "生产阶段证据指纹",
        detail: productionEvidence.counts.legacyUnverified
          ? `${productionEvidence.counts.legacyUnverified} 个旧 completed 阶段缺少证据核验指纹：${productionEvidence.legacyUnverifiedStages.map((stage) => stage.name).join("、")}。当前证据可读不代表已建立可追溯完成记录。`
          : `${productionEvidence.counts.verifiedCompleted}/${productionEvidence.counts.completed} 个 completed 阶段已保存证据核验指纹。`,
        suggestedAction: productionEvidence.counts.legacyUnverified ? "调用 get_production_workflow 实时核验；证据无误后，使用 productionEvidence.nextRepair 的参数经 execute_command 将对应阶段重新保存为 completed，补齐指纹、命令账本与审计事件。" : undefined,
        paths: legacyPaths.length ? legacyPaths : undefined,
      });
      const existingItems = index.items.filter((item) => item.type === "unit" || item.type === "shot");
      const baselines = await auditExistingProductionBaselines(root, auditedWorkflow);
      const invalidBaselines = baselines.filter((baseline) => !baseline.valid);
      const normalWorkflowUnstarted = auditedWorkflow.stages.every((stage) => stage.status === "not_started");
      const fusionContentAddressManaged = Boolean(fusionProjectPresent && fusionAssetConsistency);
      existingProductionRecoveryRequired = Boolean(!fusionContentAddressManaged && normalWorkflowUnstarted && existingItems.length && (!baselines.length || invalidBaselines.length));
      existingProductionScoped = Boolean(!fusionContentAddressManaged && normalWorkflowUnstarted && baselines.length && !invalidBaselines.length);
      checks.push({
        id: "existing-production-recovery",
        level: existingProductionRecoveryRequired ? "error" : existingProductionScoped ? "warning" : "ok",
        title: "既有制作包接管",
        detail: fusionContentAddressManaged
          ? `当前 ${existingItems.length} 个 unit/shot 已由融合 manifest、资产目录和内容地址 ${fusionAssetConsistency!.sourceContentAddress} 接管，不再重复要求通用 scoped recovery。`
          : existingProductionRecoveryRequired
          ? invalidBaselines.length
            ? `${invalidBaselines.length} 个 scoped baseline 证据失效：${invalidBaselines.map((baseline) => `${baseline.id}（${baseline.issues.join("、")}）`).join("；")}`
            : `检测到 ${existingItems.length} 个既有 unit/shot，但正常 production workflow 尚未推进，也没有内容寻址 scoped baseline；直接领取或生成会被安全门禁拒绝。`
          : existingProductionScoped
            ? `${baselines.length} 个 scoped baseline 有效，覆盖 ${new Set(baselines.flatMap((baseline) => baseline.itemIds)).size}/${existingItems.length} 个既有节点；未覆盖节点和普通 video 仍保持失败关闭。`
            : "项目不需要既有制作包 scoped recovery，或已按正常 production workflow 推进。",
        suggestedAction: fusionContentAddressManaged
          ? undefined
          : existingProductionRecoveryRequired
          ? "先调用 preview_existing_production_recovery 冻结明确节点、正式合同和参考文件，再用 commit_existing_production_recovery 的 workflow CAS/幂等回执提交；禁止手改 stages。"
          : existingProductionScoped
            ? "只对 baseline 列出的 item/kind 创建任务或调用 enqueue_generation；扩展 scope 必须重新预检并提交新 baseline。"
            : undefined,
        paths: invalidBaselines.length ? [paths.productionWorkflow] : undefined,
      });
    }
  }
  const activeGeneration = generationJobs.filter((job) => !["succeeded", "failed", "cancelled", "visual_rejected"].includes(job.status));
  const uncertainGeneration = generationJobs.filter((job) => job.status === "submission_unknown");
  const uncertainBrowserGeneration = uncertainGeneration.filter((job) => job.browserCheckpoint?.stage === "submission_unknown");
  const uncertainComfyGeneration = uncertainGeneration.filter((job) => job.comfyUiCheckpoint?.stage === "submission_unknown");
  const uncertainHttpGeneration = uncertainGeneration.filter((job) => !job.browserCheckpoint && !job.comfyUiCheckpoint && !job.subagentCheckpoint && getHttpGenerationSubmissionCheckpoint(job)?.stage === "submission_unknown");
  const blockedBrowserPreflights = generationJobs.filter((job) => job.status === "waiting_external" && job.browserCheckpoint?.stage === "preflight_blocked");
  const pendingSubagentGeneration = generationJobs.filter((job) => ["plan_ready", "leased", "generating", "generation_unknown", "candidate_generated", "generated"].includes(job.subagentCheckpoint?.stage ?? ""));
  const unknownSubagentGeneration = pendingSubagentGeneration.filter((job) => job.status === "generation_unknown" || job.subagentCheckpoint?.stage === "generation_unknown");
  const candidateSubagentGeneration = pendingSubagentGeneration.filter((job) => job.status === "candidate_generated" || ["candidate_generated", "generated"].includes(job.subagentCheckpoint?.stage ?? ""));
  const leasedSubagentGeneration = pendingSubagentGeneration.filter((job) => job.subagentCheckpoint?.stage === "leased");
  const expiredSubagentLeases = leasedSubagentGeneration.filter((job) => {
    const leaseUntil = job.subagentCheckpoint?.lease?.leaseUntil;
    return !leaseUntil || !Number.isFinite(Date.parse(leaseUntil)) || Date.parse(leaseUntil) <= Date.now();
  });
  const legacySubagentLeases = leasedSubagentGeneration.filter((job) => {
    const lease = job.subagentCheckpoint?.lease;
    return job.subagentCheckpoint?.schemaVersion === 1 || !lease?.owner || !lease.heartbeatAt || !lease.leaseUntil || !lease.fence;
  });
  const comfyCancellationPending = generationJobs.filter((job) => job.comfyUiCheckpoint?.stage === "cancel_requested");
  const checkpointOwnershipConflicts = generationJobs.filter((job) => {
    const historicalBrowserCheckpoint = Boolean(job.subagentCheckpoint?.migratedFrom?.adapter === "codex-browser"
      && job.browserCheckpoint
      && job.subagentCheckpoint.migratedFrom.browserCheckpointRevision === job.browserCheckpoint.revision
      && job.subagentCheckpoint.migratedFrom.browserCheckpointStage === job.browserCheckpoint.stage);
    const owners = [Boolean(job.browserCheckpoint && !historicalBrowserCheckpoint), Boolean(job.httpSubmissionCheckpoint), Boolean(job.comfyUiCheckpoint), Boolean(job.subagentCheckpoint)].filter(Boolean).length;
    if (owners > 1) return true;
    const adapter = job.executionSnapshot?.provider.adapter;
    return Boolean((job.comfyUiCheckpoint && adapter && adapter !== "comfyui-local")
      || (job.httpSubmissionCheckpoint && adapter && adapter !== "http-json")
      || (job.browserCheckpoint && !historicalBrowserCheckpoint && adapter && adapter !== "codex-browser")
      || (job.subagentCheckpoint && adapter && adapter !== "codex-subagent-imagegen"));
  });
  const retryableRemoteGeneration = generationJobs.filter((job) => job.status === "waiting_remote" && job.remoteObservation?.state === "retryable_or_unknown");
  const manualRemoteGeneration = retryableRemoteGeneration.filter((job) => job.remoteObservation?.nextAction === "inspect_publication");
  const automaticRemoteGeneration = retryableRemoteGeneration.filter((job) => job.remoteObservation?.nextAction !== "inspect_publication");
  const runningRenders = renderJobs.filter((job) => job.status === "running");
  const activeContinuations = continuations.filter((pack) => !["completed", "failed", "cancelled"].includes(pack.status));
  const jobsById = new Map(generationJobs.map((job) => [job.id, job]));
  const packsById = new Map(continuations.map((pack) => [pack.id, pack]));
  const projectedContinuationStatus = (job: (typeof generationJobs)[number]) => {
    const stage = job.browserCheckpoint?.stage;
    const comfyStage = job.comfyUiCheckpoint?.stage;
    if (job.status === "succeeded" || stage === "verified" || comfyStage === "verified") return "completed";
    if (job.status === "failed" || stage === "failed" || comfyStage === "history_failed") return "failed";
    if (job.status === "cancelled" || stage === "cancelled" || comfyStage === "cancelled") return "cancelled";
    if (job.status === "submission_unknown" || stage === "submission_unknown" || comfyStage === "submission_unknown") return "submission_unknown";
    if (stage === "downloaded") return "downloaded";
    if (stage === "processing" || comfyStage === "running" || comfyStage === "history_succeeded" || comfyStage === "downloading") return "processing";
    if (stage === "submitted" || comfyStage === "queued" || job.status === "waiting_remote" || (job.status === "waiting_external" && !job.browserCheckpoint)) return "submitted";
    if (stage === "uploaded") return "uploaded";
    if (stage === "preflight_blocked") return "preflight_blocked";
    if (stage === "preflight") return "preflight";
    if (job.status === "submitting") return "submit_intent";
    return "queued";
  };
  const orphanReadyContinuations = continuations.filter((pack) => pack.status === "ready" && !pack.generationJobId);
  const missingContinuationJobs = continuations.filter((pack) => pack.generationJobId && !jobsById.has(pack.generationJobId));
  const missingContinuationPacks = generationJobs.filter((job) => job.continuationId && !packsById.has(job.continuationId));
  const driftedContinuations = continuations.filter((pack) => {
    const job = pack.generationJobId ? jobsById.get(pack.generationJobId) : undefined;
    return Boolean(job && (job.continuationId !== pack.id || job.itemId !== pack.itemId || pack.status !== projectedContinuationStatus(job) || pack.generationStatus !== job.status));
  });
  const uncertainContinuations = continuations.filter((pack) => pack.status === "submission_unknown");
  const continuationIntegrityErrors = missingContinuationJobs.length + missingContinuationPacks.length;
  const continuationWarnings = orphanReadyContinuations.length + driftedContinuations.length + uncertainContinuations.length;
  const reservedPublications = publicationIntents.filter((intent) => intent.status === "reserved");
  const publicationById = new Map(publicationIntents.map((intent) => [intent.id, intent]));
  const generationPublicationConflicts = generationJobs.filter((job) => {
    const intent = job.publicationIntentId ? publicationById.get(job.publicationIntentId) : undefined;
    if (!intent || !["failed", "cancelled"].includes(intent.status)) return false;
    return !generationPublicationTerminalMatchesJob(intent, job);
  });
  const terminalCheckpointDrift = generationJobs.filter((job) => ["failed", "cancelled"].includes(job.status)
    && (job.browserCheckpoint?.stage === "submission_unknown" || job.httpSubmissionCheckpoint?.stage === "submission_unknown" || job.comfyUiCheckpoint?.stage === "submission_unknown")
    && !(job.publicationIntentId && publicationById.get(job.publicationIntentId) && generationPublicationTerminalMatchesJob(publicationById.get(job.publicationIntentId)!, job)));
  const stalePublications = reservedPublications.filter((intent) => Date.now() - Date.parse(intent.updatedAt) > 24 * 60 * 60 * 1_000);
  const targetPresentPendingValidation = (await Promise.all(reservedPublications.map(async (intent) => await publicationTargetExists(intent) ? intent : undefined))).filter((intent): intent is NonNullable<typeof intent> => Boolean(intent));
  const sidecarFailed = (id: string) => checks.some((check) => check.id === id && check.level === "error");
  if (!sidecarFailed("generation-store-corrupt")) checks.push({
    id: "generation-jobs",
    level: generationPublicationConflicts.length || terminalCheckpointDrift.length || checkpointOwnershipConflicts.length ? "error" : activeGeneration.some((job) => job.status === "submitting" || job.status === "submission_unknown") || retryableRemoteGeneration.length || comfyCancellationPending.length || blockedBrowserPreflights.length || pendingSubagentGeneration.length ? "warning" : "ok",
    title: "生成队列",
    detail: `${activeGeneration.length} 个进行中任务，${blockedBrowserPreflights.length} 个网页任务停在可恢复 preflight_blocked；一图一子代理共 ${pendingSubagentGeneration.length} 个：调用结果不明 ${unknownSubagentGeneration.length}、候选待视觉验收 ${candidateSubagentGeneration.length}、leased ${leasedSubagentGeneration.length}（过期/缺 TTL ${expiredSubagentLeases.length}、旧协议 ${legacySubagentLeases.length}）；${uncertainGeneration.length} 个提交结果待对账（网页 ${uncertainBrowserGeneration.length}、HTTP ${uncertainHttpGeneration.length}、ComfyUI ${uncertainComfyGeneration.length}），${comfyCancellationPending.length} 个 ComfyUI 原子取消待 exact history/稳定 absent 确认，${automaticRemoteGeneration.length} 个远端暂态/未知错误可定向恢复，${manualRemoteGeneration.length} 个发布冲突待人工核对，${generationPublicationConflicts.length} 个 Publication 终态缺少匹配来源，${terminalCheckpointDrift.length} 个终态 Job 仍保留 unknown 检查点，${checkpointOwnershipConflicts.length} 个任务混入多个当前适配器检查点。`,
    suggestedAction: generationPublicationConflicts.length || terminalCheckpointDrift.length || checkpointOwnershipConflicts.length
      ? "调用 list_generation_jobs 与 list_publications 核对 Job、Publication、检查点和结构化终态来源；冲突未消除前保持重复提交锁，禁止手改侧车或创建新版本。"
      : unknownSubagentGeneration.length
      ? `先读取 get_subagent_image_generation_plan；${unknownSubagentGeneration.map((job) => job.id).slice(0, 3).join("、")} 只能用结构化证据对账，严禁 claim、取消或重生。旧协议 leased 应通过 execute_command(migrate_generation_execution_state) 迁为 unknown。`
      : candidateSubagentGeneration.length
        ? "读取候选隔离路径、callId、SHA 和 raw/labeled bundle；主代理查看原图后只能执行 visual_accept 或 visual_rejected，禁止 process_generation_queue 自动发布。"
      : legacySubagentLeases.length
        ? "旧协议租约没有调用前 intent/调用后 receipt；使用 execute_command(migrate_generation_execution_state) 迁为 generation_unknown，禁止 takeover。"
      : expiredSubagentLeases.length
        ? "读取 leaseUntil、callIntent 与 owner；仅 v2 leased 且没有 callIntent 才可 takeover，generating 过期必须转为 generation_unknown。"
      : uncertainGeneration.length
      ? `${uncertainBrowserGeneration.length ? `网页 ${uncertainBrowserGeneration.length} 个：调用 get_browser_generation_plan 后按当前修订回写；` : ""}${uncertainHttpGeneration.length ? `HTTP ${uncertainHttpGeneration.length} 个：读取 httpSubmissionCheckpoint.revision 后调用 reconcile_http_generation_submission；` : ""}${uncertainComfyGeneration.length ? `ComfyUI ${uncertainComfyGeneration.length} 个：调用 process_generation_queue 只查已保存 promptId 的 history/queue；` : ""}禁止再次提交同一远端任务。`
      : comfyCancellationPending.length
        ? "调用 cancel_generation_job(jobId) 定向复核同一 promptId；只有 exact execution_interrupted 或 server acted 后 pending 稳定移出 queue/history 才会关闭 Publication。"
      : manualRemoteGeneration.length
        ? "调用 list_generation_jobs 与 list_publications 核对冲突的最终路径和隔离结果；先人工解决路径占用，禁止循环自动重试或覆盖。"
      : automaticRemoteGeneration.length
        ? "调用 list_generation_jobs 查看最后观测，再用 process_generation_queue(jobId) 定向恢复既有 externalTaskId/结果下载；不会提交其他 queued 任务，也不会重新 POST 该任务。"
      : blockedBrowserPreflights.length
        ? "调用 get_browser_generation_plan 读取 blockers、observedGeneration 和当前 revision；阻塞未消除时只能再次回写 preflight_blocked，条件恢复后用同一 job 回写 preflight，禁止重新入队或提交。"
      : pendingSubagentGeneration.length
        ? "调用 get_subagent_image_generation_plan 读取 revision/owner/heartbeat/leaseUntil；严格按 claim→start_call→generated→visual_accept/visual_rejected，模型调用前必须持久化 callId/runId。"
      : activeGeneration.length ? "调用 process_generation_queue 轮询或接收结果。" : undefined,
    paths: [...unknownSubagentGeneration.map((job) => job.requestPath), ...candidateSubagentGeneration.flatMap((job) => [job.subagentCheckpoint?.output?.isolatedPath, job.requestPath]), ...uncertainGeneration.map((job) => job.requestPath), ...retryableRemoteGeneration.flatMap((job) => [job.partialDownloadPath, job.isolatedDownloadPath])].filter((value): value is string => Boolean(value)).slice(0, 20),
  });
  if (!sidecarFailed("render-store-corrupt")) checks.push({
    id: "render-jobs",
    level: runningRenders.length > 1 ? "error" : runningRenders.length ? "warning" : "ok",
    title: "剪辑导出",
    detail: runningRenders.length > 1 ? `${runningRenders.length} 个导出同时标记为运行，超过单项目 1 个活动 FFmpeg 的资源上限。` : `${runningRenders.length} 个记录为运行中的导出任务。`,
    suggestedAction: runningRenders.length > 1 ? "调用 list_edit_render_jobs 核对真实进程，只保留必要任务并用 cancel_edit_render 取消其余任务。" : runningRenders.length ? "调用 list_edit_render_jobs 核对进程与输出。" : undefined,
  });
  if (!sidecarFailed("continuation-store-corrupt") && !sidecarFailed("generation-store-corrupt")) checks.push({
    id: "video-continuations",
    level: continuationIntegrityErrors ? "error" : continuationWarnings ? "warning" : "ok",
    title: "视频续接",
    detail: `${activeContinuations.length} 个进行中续接包；${orphanReadyContinuations.length} 个未入队，${uncertainContinuations.length} 个提交结果待对账，${driftedContinuations.length} 个投影未同步，${continuationIntegrityErrors} 个任务/续接包引用缺失。`,
    suggestedAction: continuationIntegrityErrors
      ? "停止续接写入，保留生成队列、续接侧车和事件日志；核对缺失引用后恢复，禁止重新付费提交。"
      : uncertainContinuations.length
        ? "读取关联 GenerationJob 的 browserCheckpoint 或 httpSubmissionCheckpoint 与 clientJobId；网页任务按浏览器修订回写，HTTP 任务调用 reconcile_http_generation_submission，禁止再次提交。"
        : driftedContinuations.length
          ? "调用 process_generation_queue 让 GenerationJob 重新投影续接包；若仍漂移，停止写入并检查审计事件。"
          : orphanReadyContinuations.length
            ? "立即用 enqueue_generation 绑定唯一 GenerationJob，或按 expectedRevision 明确取消未入队续接包。"
            : undefined,
    paths: continuationIntegrityErrors || continuationWarnings ? [paths.editorContinuations, paths.generationJobs] : undefined,
  });
  if (!sidecarFailed("publication-store-corrupt")) checks.push({ id: "publications", level: stalePublications.length || targetPresentPendingValidation.length ? "warning" : "ok", title: "新版本发布合同", detail: `${reservedPublications.length} 个预留中，${targetPresentPendingValidation.length} 个目标文件已出现但仍待机械校验，${stalePublications.length} 个预留超过 24 小时，${publicationIntents.filter((intent) => intent.status === "registered").length} 个已登记，${publicationIntents.filter((intent) => intent.status === "failed").length} 个失败。`, suggestedAction: targetPresentPendingValidation.length ? "调用 list_publications 核对意图后，使用原预检返回的令牌和当前修订经 execute_command(register_publication) 完成锁外机械校验；文件存在不等于可登记。" : stalePublications.length ? "核对关联生成/渲染任务，再取消或标记失败的过期发布意图。" : undefined, paths: [...targetPresentPendingValidation, ...stalePublications].slice(0, 20).map((intent) => intent.targetPath) });
  checks.push({ id: "ffmpeg", level: engine.available ? "ok" : "warning", title: "本地视频引擎", detail: engine.available ? engine.ffmpegVersion ?? "FFmpeg 可用。" : engine.issues.join("；"), suggestedAction: engine.available ? undefined : "安装 FFmpeg，或设置 AI_CANVAS_FFMPEG / AI_CANVAS_FFPROBE。", paths: [engine.ffmpegPath, engine.ffprobePath].filter((value): value is string => Boolean(value)) });
  checks.push({ id: "sharp", level: runtimeModules[0]?.status === "fulfilled" ? "ok" : "error", title: "图片解码引擎", detail: runtimeModules[0]?.status === "fulfilled" ? "Sharp 可加载，可执行缩略图、魔数和图片可解码检查。" : `Sharp 加载失败：${String(runtimeModules[0]?.reason)}`, suggestedAction: runtimeModules[0]?.status === "fulfilled" ? undefined : "重新安装与当前 Electron/Node 架构匹配的 Sharp。" });
  checks.push({ id: "docx", level: runtimeModules[1]?.status === "fulfilled" ? "ok" : "warning", title: "DOCX 原文导入", detail: runtimeModules[1]?.status === "fulfilled" ? "Mammoth 可加载，可读取 DOCX 文本。" : `Mammoth 加载失败：${String(runtimeModules[1]?.reason)}`, suggestedAction: runtimeModules[1]?.status === "fulfilled" ? undefined : "重新安装 mammoth，或先将 DOCX 转为 Markdown。" });

  const settings = await diagnoseSidecar("generation-settings-corrupt", "生成供应商配置", paths.generationSettings, () => readJson<GenerationSettings | null>(paths.generationSettings, null), null);
  const providers = settings?.providers ?? [];
  const providerIssues: string[] = [];
  for (const provider of providers.filter((entry) => entry.enabled)) {
    if (provider.adapter === "codex-browser" && !provider.siteUrl) providerIssues.push(`${provider.name}缺少网站入口`);
    if (provider.adapter === "http-json" && !provider.endpoint) providerIssues.push(`${provider.name}缺少提交端点`);
    if (provider.adapter === "comfyui-local") {
      if (!provider.endpoint) providerIssues.push(`${provider.name}缺少本机 ComfyUI origin`);
      else {
        try {
          const url = new URL(provider.endpoint);
          const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
          if (!["localhost", "127.0.0.1", "::1"].includes(host) || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) providerIssues.push(`${provider.name}不是无 query/fragment 的 loopback origin`);
        } catch { providerIssues.push(`${provider.name}的本机 ComfyUI origin 无效`); }
      }
      if (provider.kinds.length !== 1 || provider.kinds[0] !== "image") providerIssues.push(`${provider.name}首版只能声明 image`);
      if (provider.workflow?.format !== "comfyui-api" || !provider.workflow.comfyUi) providerIssues.push(`${provider.name}缺少 comfyui-api prompt/output 绑定`);
    }
    if (provider.adapter === "codex-subagent-imagegen") {
      if (provider.kinds.length !== 1 || provider.kinds[0] !== "image") providerIssues.push(`${provider.name}只能声明 image`);
      if (!provider.subagentInstructions?.trim()) providerIssues.push(`${provider.name}缺少人物/场景/道具/风格一致性执行说明`);
      if (provider.capabilities?.maxConcurrency !== 1) providerIssues.push(`${provider.name}并发必须为 1`);
    }
    if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) providerIssues.push(`${provider.name}未配置环境变量 ${provider.apiKeyEnv}`);
  }
  if (settings?.defaultImageProviderId && !providers.some((provider) => provider.id === settings.defaultImageProviderId && provider.enabled)) providerIssues.push("默认图片供应商不存在或未启用");
  if (settings?.defaultVideoProviderId && !providers.some((provider) => provider.id === settings.defaultVideoProviderId && provider.enabled)) providerIssues.push("默认视频供应商不存在或未启用");
  if (!sidecarFailed("generation-settings-corrupt")) checks.push({ id: "generation-providers", level: providerIssues.length ? "warning" : "ok", title: "生成供应商", detail: providerIssues.length ? providerIssues.join("；") : `${providers.filter((provider) => provider.enabled).length} 个已启用供应商，基础配置完整。`, suggestedAction: providerIssues.length ? "在项目设置/生成队列中修正供应商能力与凭据环境变量。" : undefined });

  const analysisSettings = await diagnoseSidecar<NovelAnalysisProviderSettings>("analysis-provider-settings-corrupt", "小说分析模型配置", paths.storyAnalysisProviders, () => withNovelAnalysisProvider((provider) => provider.getNovelAnalysisProviderSettings(root)), { schemaVersion: 1, revision: 0, providers: [], updatedAt: new Date(0).toISOString() });
  const analysisProviderIssues = analysisSettings.providers.filter((provider) => provider.enabled).flatMap((provider) => {
    const issues: string[] = [];
    if (provider.adapter === "openai-compatible" && !provider.baseUrl) issues.push(`${provider.name} 缺少 Base URL`);
    if (provider.adapter === "openai-compatible" && !provider.allowStoryUpload) issues.push(`${provider.name} 未授权正文发送`);
    if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) issues.push(`${provider.name} 未配置环境变量 ${provider.apiKeyEnv}`);
    return issues;
  });
  if (!sidecarFailed("analysis-provider-settings-corrupt")) checks.push({ id: "novel-analysis-providers", level: analysisProviderIssues.length ? "warning" : "ok", title: "小说分析模型", detail: analysisProviderIssues.length ? analysisProviderIssues.join("；") : `${analysisSettings.providers.filter((provider) => provider.enabled).length} 个已启用模型连接；密钥仅由环境变量提供。`, suggestedAction: analysisProviderIssues.length ? "在自动改编工作台修正模型连接；不要把密钥值写入项目文件。" : undefined, paths: [paths.storyAnalysisProviders] });

  const staleClaimed = tasks.filter((task) => task.status === "claimed" && (!task.lease || Date.parse(task.lease.leaseUntil) <= Date.now()));
  const orphanTaskItems = [...new Set(tasks.flatMap((task) => task.itemIds).filter((itemId) => !itemIds.has(itemId)))];
  if (!sidecarFailed("task-store-corrupt")) checks.push({ id: "task-packs", level: orphanTaskItems.length ? "error" : staleClaimed.length ? "warning" : "ok", title: "任务包恢复", detail: orphanTaskItems.length ? `${orphanTaskItems.length} 个任务节点已失去索引映射。` : staleClaimed.length ? `${staleClaimed.length} 个任务租约已经过期，可由新执行者审计接管。` : `${tasks.length} 个任务包无孤立引用或过期租约。`, suggestedAction: orphanTaskItems.length || staleClaimed.length ? "读取任务包与命令账本；过期 claimed 任务可用 claim_task 重新领取，系统会记录 lease-expired。" : undefined });
  const staleLocks = projectLocks.filter((lock) => lock.stale);
  checks.push({ id: "project-locks", level: staleLocks.length ? "warning" : "ok", title: "跨进程写锁", detail: staleLocks.length ? `${staleLocks.length} 个项目写锁疑似由异常退出遗留。` : `${projectLocks.length} 个当前写锁，未发现过期锁。`, suggestedAction: staleLocks.length ? "重试原命令；锁获取器只会在确认超过失效窗口后回收，并保留底层审计。" : undefined, paths: staleLocks.map((lock) => lock.path) });
  if (machineMediaRuntime) {
    const deadOwners = [...machineMediaRuntime.active, ...machineMediaRuntime.queued].filter((entry) => !entry.ownerAlive);
    const overCapacity = machineMediaRuntime.activeWeight > machineMediaRuntime.capacity;
    checks.push({
      id: "machine-media-runtime",
      level: overCapacity ? "error" : deadOwners.length ? "warning" : "ok",
      title: "机器级媒体运行时",
      detail: `容量 ${machineMediaRuntime.activeWeight}/${machineMediaRuntime.capacity}，排队 ${machineMediaRuntime.queueDepth}；累计超时 ${machineMediaRuntime.metrics.timedOut}、容量等待超时 ${machineMediaRuntime.metrics.acquisitionTimeouts}、孤儿租约回收 ${machineMediaRuntime.metrics.orphanedLeasesReaped}。`,
      suggestedAction: overCapacity
        ? "停止启动新媒体任务并核对运行时状态；activeWeight 不得超过机器容量。"
        : deadOwners.length ? "调用任一受控媒体操作或 list_edit_render_jobs 触发孤儿回收，再重新运行 doctor_project。" : undefined,
      paths: [path.join(machineMediaRuntime.runtimeDirectory, "state.json")],
    });
  }
  const uncertainCommands = commandLedger.entries.filter((entry) => entry.status === "running" || entry.status === "unknown");
  if (!sidecarFailed("command-ledger-corrupt")) checks.push({ id: "command-ledger", level: uncertainCommands.length ? "warning" : "ok", title: "幂等命令账本", detail: uncertainCommands.length ? `${uncertainCommands.length} 条命令结果未确认；相同幂等键已锁定，系统不会盲目重放。` : `${commandLedger.entries.length} 条命令均无未确认副作用。`, suggestedAction: uncertainCommands.length ? "调用 list_command_ledger，对照真实文件和审计事件后决定保留现状或使用新幂等键创建明确新版本。" : undefined });
  if (!sidecarFailed("adaptation-store-corrupt") && adaptationWorkspace) {
    const planErrors = adaptationWorkspace.plans.reduce((sum, plan) => sum + plan.validation.hardErrors.length, 0);
    const pendingAnalysisReviews = adaptationWorkspace.analysisReviews.filter((review) => review.status === "pending");
    const evidenceIssueReviews = pendingAnalysisReviews.filter((review) => review.evidenceIssues.length);
    const uncertainAnalysisTasks = adaptationWorkspace.analysisTasks.filter((task) => ["executing", "reconciliation_required", "submission_unknown"].includes(task.status));
    const analysisExecutionRecovery = await withNovelAnalysisProvider((provider) => provider.getNovelAnalysisExecutionRecoveryStatus(root)).catch(() => null);
    const reconciliationCandidates = analysisExecutionRecovery?.candidates.length ?? 0;
    const analysisRuns = await withNovelAnalysisProvider((provider) => provider.listNovelAnalysisRunProgress(root)).catch(() => []);
    const blockedAnalysisRuns = analysisRuns.filter((run) => run.status === "blocked" || run.status === "stale");
    const missingAnalysisTaskFiles = (await Promise.all(adaptationWorkspace.analysisTasks.flatMap((task) => [task.taskJsonPath, task.taskMarkdownPath]).map(async (filePath) => await canAccess(filePath, fsConstants.R_OK) ? "" : filePath))).filter(Boolean);
    const adaptationWarning = Boolean(planErrors || evidenceIssueReviews.length || missingAnalysisTaskFiles.length || uncertainAnalysisTasks.length || blockedAnalysisRuns.length || reconciliationCandidates);
    checks.push({ id: "adaptation-workspace", level: adaptationWarning ? "warning" : "ok", title: "小说自动改编", detail: `${adaptationWorkspace.facts.length} 条事实、${adaptationWorkspace.beats.length} 个节拍、${adaptationWorkspace.plans.length} 个方案；${analysisRuns.length} 个长篇分析运行，其中 ${blockedAnalysisRuns.length} 个阻塞或失效；${pendingAnalysisReviews.length} 个模型提案待确认，其中 ${evidenceIssueReviews.length} 个证据异常；${uncertainAnalysisTasks.length} 个模型执行中/待对账/回执不明，其中 ${reconciliationCandidates} 个需要恢复对账；${missingAnalysisTaskFiles.length} 个任务文件缺失；${planErrors} 个方案硬错误。`, suggestedAction: reconciliationCandidates ? "先调用 get_novel_analysis_execution_recovery，按 execution fence 与 request hash 人工对账；禁止重 POST 或自动 replacement。" : uncertainAnalysisTasks.length ? "读取任务执行记录、命令账本和 Provider 后台对账；禁止自动重提。" : blockedAnalysisRuns.length ? "调用 get_novel_analysis_runs 读取阻塞原因；章节或 Provider 修订漂移时重新规划未执行内容。" : missingAnalysisTaskFiles.length ? "重新创建模型分析任务，不要根据丢失任务包继续提交。" : evidenceIssueReviews.length ? "在人工确认队列核对原文字符区间；证据异常提案不能接受。" : planErrors ? "调用 validate_adaptation_plan，修复来源修订、时长、对白或硬锁冲突后再物化。" : undefined, paths: [paths.storyAdaptation, ...missingAnalysisTaskFiles.slice(0, 20)] });
  }

  const artifactIds = new Set(index.artifacts.map((artifact) => artifact.id));
  const orphanRelations = relations.filter((relation) => (relation.parentArtifactId && !artifactIds.has(relation.parentArtifactId)) || (relation.childArtifactId && !artifactIds.has(relation.childArtifactId)) || (relation.parentItemId && !itemIds.has(relation.parentItemId)) || (relation.childItemId && !itemIds.has(relation.childItemId)));
  const hardLockIds = new Set(index.project.hardLocks.map((lock) => lock.id));
  const voiceIssues = (await Promise.all(voices.map(async (voice) => ({ voice, missingSamples: (await Promise.all(voice.samplePaths.map(async (samplePath) => await canAccess(samplePath, fsConstants.R_OK) ? "" : samplePath))).filter(Boolean), missingItems: voice.characterItemIds.filter((itemId) => !itemIds.has(itemId)), missingLock: voice.hardLockId && !hardLockIds.has(voice.hardLockId) })))).filter((entry) => entry.missingSamples.length || entry.missingItems.length || entry.missingLock);
  if (!sidecarFailed("asset-relation-store-corrupt") && !sidecarFailed("voice-store-corrupt")) checks.push({ id: "asset-registry", level: orphanRelations.length || voiceIssues.length ? "warning" : "ok", title: "资产血缘与音色", detail: orphanRelations.length || voiceIssues.length ? `${orphanRelations.length} 条孤立资产关系，${voiceIssues.length} 个音色身份存在失效绑定。` : `${relations.length} 条资产关系和 ${voices.length} 个音色身份引用完整。`, suggestedAction: orphanRelations.length || voiceIssues.length ? "重新扫描后修订资产关系或音色样本路径；不要删除原素材。" : undefined });
  const errors = checks.filter((check) => check.level === "error").length;
  const warnings = checks.filter((check) => check.level === "warning").length;
  const productionEvidenceNeedsAttention = Boolean(productionEvidence?.repairRequired || productionEvidence?.counts.legacyUnverified);
  const panelReferenceSuggestedCalls = fusionProjectPresent && (!fusionPanelReferences || !fusionPanelReferenceCurrentness?.current || !fusionPanelReferences.audit.closurePassed)
    ? fusionPanelReferences
      ? !fusionPanelReferenceCurrentness?.current
        ? ["materialize_fusion_panel_references", "audit_fusion_panel_references", "doctor_project"]
        : ["audit_fusion_panel_references", "list_fusion_panel_reference_resolutions", "doctor_project"]
      : ["materialize_fusion_panel_references", "audit_fusion_panel_references", "doctor_project"]
    : undefined;
  return { healthy: errors === 0, projectRoot: root, projectId: index.project.id, scanId: index.scanId, checkedAt: new Date().toISOString(), summary: { errors, warnings, ok: checks.length - errors - warnings }, checks, productionEvidence, suggestedNextCalls: generationPublicationConflicts.length || terminalCheckpointDrift.length ? ["list_generation_jobs", "list_publications", "doctor_project"] : unknownSubagentGeneration.length ? ["list_generation_jobs", "get_subagent_image_generation_plan", "list_publications", "doctor_project"] : panelReferenceSuggestedCalls ?? (candidateSubagentGeneration.length ? ["get_subagent_image_generation_plan", "update_subagent_image_generation_job", "list_publications", "doctor_project"] : legacySubagentLeases.length ? ["get_subagent_image_generation_plan", "execute_command", "doctor_project"] : expiredSubagentLeases.length || pendingSubagentGeneration.length ? ["get_subagent_image_generation_plan", "update_subagent_image_generation_job", "doctor_project"] : uncertainComfyGeneration.length ? ["list_generation_jobs", "process_generation_queue", "doctor_project"] : uncertainBrowserGeneration.length && uncertainHttpGeneration.length ? ["list_generation_jobs", "get_browser_generation_plan", "reconcile_http_generation_submission", "list_command_ledger"] : uncertainBrowserGeneration.length ? ["list_generation_jobs", "get_browser_generation_plan", "list_command_ledger"] : uncertainHttpGeneration.length ? ["list_generation_jobs", "reconcile_http_generation_submission", "list_command_ledger"] : manualRemoteGeneration.length ? ["list_generation_jobs", "list_publications", "doctor_project"] : automaticRemoteGeneration.length ? ["list_generation_jobs", "process_generation_queue", "doctor_project"] : blockedBrowserPreflights.length ? ["get_browser_generation_plan", "update_browser_generation_job", "doctor_project"] : existingProductionRecoveryRequired ? ["preview_existing_production_recovery", "commit_existing_production_recovery", "doctor_project"] : productionEvidenceNeedsAttention ? productionEvidence!.suggestedCalls : existingProductionScoped ? ["get_production_workflow", "enqueue_generation"] : errors ? ["scan_project", "doctor_project"] : continuationIntegrityErrors || continuationWarnings ? ["list_video_continuations", "list_generation_jobs", "doctor_project"] : targetPresentPendingValidation.length || stalePublications.length ? ["list_publications", "doctor_project"] : warnings ? ["scan_project", "get_project_snapshot"] : ["get_project_snapshot", "get_next_task"]) };
}

export async function getProjectSnapshot(projectRoot: string, focusItemId?: string) {
  const root = path.resolve(projectRoot);
  const paths = getSidecarPaths(root);
  const index = await loadIndex(root);
  if (!index) throw new Error("项目没有真实扫描索引。请先调用 preview_project_import，确认后调用 commit_project_import；不要根据聊天记录猜测完成状态。");
  const focusItem = focusItemId ? index.items.find((item) => item.id === focusItemId) : undefined;
  if (focusItemId && !focusItem) throw new Error(`找不到焦点节点：${focusItemId}`);
  const [nextItems, reviewQueue, tasks, generationJobs, renderJobs, continuations, events, skills, continuation, storySources, storyChapters, storyEvents, workflow, bibles, storyboard, assetRelations, voiceIdentities, projectLocks, publicationIntents] = await Promise.all([
    getNextTask(root, { limit: 6 }).catch(() => []),
    getReviewQueue(root).then((entries) => entries.slice(0, 20)),
    listTaskPacks(root),
    listGenerationJobs(root),
    withEditor((editor) => editor.readEditRenderJobs(root)),
    withEditor((editor) => editor.listVideoContinuationPacks(root, focusItemId)),
    listEvents(root, 30),
    readAgentSkills(root, { enabledOnly: true }),
    getContinuationSnapshot(root, { itemId: focusItemId, initializeDefaultSkills: false }),
    withStory((story) => story.listStorySources(root)),
    withStory((story) => story.listStoryChapters(root)),
    withStory((story) => story.listStoryEvents(root, { includeOrphans: true })),
    getProductionWorkflow(root, { includeEvidenceAudit: true }),
    listCreativeBibles(root),
    getStoryboard(root),
    listAssetRelations(root),
    listVoiceIdentities(root),
    listProjectLocks(root),
    listPublicationIntents(root),
  ]);
  const fusionAssetConsistency = await canAccess(paths.fusionProjectManifest, fsConstants.R_OK) ? await getFusionAssetConsistencyState(root) : null;
  const fusionPanelReferenceSnapshot = await canAccess(paths.fusionProjectManifest, fsConstants.R_OK) ? await loadFusionPanelReferenceStoreSnapshot(root) : null;
  const fusionPanelReferences = fusionPanelReferenceSnapshot?.store ?? null;
  const fusionPanelReferenceCurrentness = fusionPanelReferenceSnapshot?.currentness ?? null;
  const artifactFailures = index.artifacts.filter((artifact) => !artifact.deprecated && !artifact.check.ok);
  const productionEvidence = summarizeProductionEvidence(workflow);
  const { evidenceAudit: _evidenceAudit, ...workflowState } = workflow;
  const liveLocks = projectLocks.filter((lock) => !lock.stale);
  const activeRenderJobs = renderJobs.filter((job) => job.status === "running");
  const activeGenerationStatuses = new Set(["queued", "submitting", "submission_unknown", "waiting_external", "waiting_remote", "generating", "generation_unknown", "candidate_generated"]);
  const activeGenerationJobs = generationJobs.filter((job) => activeGenerationStatuses.has(job.status));
  const hasUnknownComfyGeneration = generationJobs.some((job) => job.status === "submission_unknown" && job.comfyUiCheckpoint?.stage === "submission_unknown");
  const hasUnknownBrowserGeneration = generationJobs.some((job) => job.status === "submission_unknown" && job.browserCheckpoint?.stage === "submission_unknown");
  const hasUnknownHttpGeneration = generationJobs.some((job) => job.status === "submission_unknown" && !job.browserCheckpoint && !job.comfyUiCheckpoint && !job.subagentCheckpoint);
  const hasBlockedBrowserPreflight = generationJobs.some((job) => job.status === "waiting_external" && job.browserCheckpoint?.stage === "preflight_blocked");
  const hasUnknownSubagentGeneration = generationJobs.some((job) => job.status === "generation_unknown" || job.subagentCheckpoint?.stage === "generation_unknown");
  const hasCandidateSubagentGeneration = generationJobs.some((job) => job.status === "candidate_generated" || ["candidate_generated", "generated"].includes(job.subagentCheckpoint?.stage ?? ""));
  const hasPendingSubagentGeneration = generationJobs.some((job) => ["plan_ready", "leased", "generating"].includes(job.subagentCheckpoint?.stage ?? ""));
  const pendingPublicationIntents = publicationIntents.filter((intent) => intent.status === "reserved");
  const currentConsistencyBatch = fusionAssetConsistency?.batches.at(-1);
  const assetConsistencySuggestedCalls = fusionAssetConsistency && !fusionAssetConsistency.persisted
    ? ["get_fusion_asset_consistency", "prepare_fusion_asset_consistency_review"]
    : currentConsistencyBatch?.status === "invalidated"
      ? ["get_fusion_asset_consistency", "list_generation_jobs", "doctor_project"]
      : currentConsistencyBatch?.canPrepareReview
        ? ["get_fusion_asset_consistency", "prepare_fusion_asset_consistency_review"]
      : undefined;
  const panelReferenceSuggestedCalls = fusionAssetConsistency && (!fusionPanelReferences || !fusionPanelReferenceCurrentness?.current || !fusionPanelReferences.audit.closurePassed)
    ? fusionPanelReferences
      ? !fusionPanelReferenceCurrentness?.current
        ? ["materialize_fusion_panel_references", "audit_fusion_panel_references", "doctor_project"]
        : ["audit_fusion_panel_references", "list_fusion_panel_reference_resolutions", "doctor_project"]
      : ["materialize_fusion_panel_references", "audit_fusion_panel_references", "doctor_project"]
    : undefined;
  const pendingPublicationTargets = await Promise.all(pendingPublicationIntents.slice(0, 50).map(async (intent) => ({
    id: intent.id,
    revision: intent.revision,
    targetPath: intent.targetPath,
    kind: intent.kind,
    variant: intent.variant,
    purpose: intent.context.purpose,
    itemId: intent.context.itemId,
    jobId: intent.context.jobId,
    targetPresentPendingValidation: await publicationTargetExists(intent),
    updatedAt: intent.updatedAt,
  })));
  const scanLock = liveLocks.find((lock) => lock.name === "scan");
  const mediaCapacityLock = liveLocks.find((lock) => lock.name === "editor-media-capacity");
  const machineMediaRuntime = await readMachineMediaRuntimeSnapshot();
  const currentProjectMediaKey = projectMediaKey(root);
  const runtimeResources = {
    machineMedia: {
      capacity: machineMediaRuntime.capacity,
      activeWeight: machineMediaRuntime.activeWeight,
      availableWeight: machineMediaRuntime.availableWeight,
      queueDepth: machineMediaRuntime.queueDepth,
      weights: { ffprobe: MEDIA_WEIGHTS.probe, foregroundFfmpeg: MEDIA_WEIGHTS.foreground, renderFfmpeg: MEDIA_WEIGHTS.render },
      algorithm: "strict-weighted-fifo",
      currentProjectKey: currentProjectMediaKey,
      currentProjectActive: machineMediaRuntime.active.filter((entry) => entry.projectKey === currentProjectMediaKey),
      currentProjectQueued: machineMediaRuntime.queued.filter((entry) => entry.projectKey === currentProjectMediaKey),
      activeStages: machineMediaRuntime.active.slice(0, 50).map((entry) => ({ projectKey: entry.projectKey, tool: entry.tool, stage: entry.stage, weight: entry.weight, ownerPid: entry.ownerPid, childPid: entry.childPid, timeoutAt: entry.timeoutAt, ownerAlive: entry.ownerAlive })),
      queuedStages: machineMediaRuntime.queued.slice(0, 50).map((entry) => ({ projectKey: entry.projectKey, tool: entry.tool, stage: entry.stage, weight: entry.weight, ownerPid: entry.ownerPid, enqueuedAt: entry.enqueuedAt, ownerAlive: entry.ownerAlive })),
      metrics: machineMediaRuntime.metrics,
    },
    scan: { active: Boolean(scanLock), pid: scanLock?.pid, ageMs: scanLock?.ageMs, cancellableVia: scanLock ? "当前发起扫描的桌面或 MCP 请求" : undefined },
    editor: {
      foregroundMediaActive: Boolean(mediaCapacityLock),
      foregroundMediaPid: mediaCapacityLock?.pid,
      activeRenderIds: activeRenderJobs.map((job) => job.id),
      activeRenderPids: activeRenderJobs.map((job) => job.pid).filter((pid): pid is number => Boolean(pid)),
      foregroundCapacity: 1,
      renderCapacity: 1,
      activeRenderBlocksForegroundJobs: true,
    },
    generation: { activeJobIds: activeGenerationJobs.map((job) => job.id), byStatus: Object.fromEntries([...activeGenerationStatuses].map((status) => [status, activeGenerationJobs.filter((job) => job.status === status).length])) },
    blockedActions: activeRenderJobs.length
      ? ["prepare_edit_media_preview", "prepare_edit_media_proxy", "extract_timeline_frame", "extract_last_frame", "prepare_timeline_continuation", "start_edit_render"]
      : mediaCapacityLock ? ["prepare_edit_media_preview", "prepare_edit_media_proxy", "extract_timeline_frame", "extract_last_frame", "prepare_timeline_continuation", "start_edit_render"] : [],
    locks: projectLocks.map((lock) => ({ name: lock.name, pid: lock.pid, ageMs: lock.ageMs, stale: lock.stale })),
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: index.project,
    scan: { scanId: index.scanId, scannedAt: index.scannedAt, durationMs: index.scanDurationMs, stats: index.scanStats, warnings: index.warnings },
    progress: index.summary,
    focus: focusItem ? { ...compactItem(focusItem), artifacts: index.artifacts.filter((artifact) => artifact.itemId === focusItem.id).slice(0, 30) } : undefined,
    nextItems: nextItems.map(compactItem),
    blockers: index.items.filter((item) => ["阻塞", "返工"].includes(item.status)).slice(0, 30).map(compactItem),
    mechanicalFailures: artifactFailures.slice(0, 30).map((artifact) => ({ id: artifact.id, itemId: artifact.itemId, path: artifact.path, kind: artifact.kind, variant: artifact.variant, issues: artifact.check.issues })),
    reviewQueue: reviewQueue.map((entry) => ({ item: compactItem(entry.item), reviewType: entry.reviewType, artifactIds: entry.artifacts.map((artifact) => artifact.id), latestDecision: entry.latestReview?.decision, latestNote: entry.latestReview?.note })),
    taskPacks: tasks.slice(0, 30).map((task) => ({ id: task.id, revision: task.revision, status: task.status, kind: task.kind, mode: task.mode, itemIds: task.itemIds, episode: task.episode, boundary: task.boundary, lease: task.lease, result: task.result, createdAt: task.createdAt })),
    generationJobs: generationJobs.slice(0, 50).map((job) => ({
      id: job.id,
      itemId: job.itemId,
      kind: job.kind,
      providerId: job.providerId,
      status: job.status,
      expectedOutputPath: job.expectedOutputPath,
      expectedCompanionPath: job.expectedCompanionPath,
      resultPath: job.resultPath,
      companionPath: job.companionPath,
      clientJobId: job.clientJobId ?? job.id,
      submissionIntent: job.submissionIntent,
      externalTaskId: sanitizeDiagnosticText(job.externalTaskId),
      remoteAcceptedAt: job.remoteAcceptedAt,
      remoteObservation: sanitizedRemoteObservation(job.remoteObservation),
      httpSubmissionCheckpoint: sanitizeDiagnosticValue(getHttpGenerationSubmissionCheckpoint(job)),
      comfyUiCheckpoint: sanitizeDiagnosticValue(job.comfyUiCheckpoint),
      pollAttempts: job.pollAttempts ?? 0,
      downloadAttempts: job.downloadAttempts ?? 0,
      downloadBytes: job.downloadBytes,
      lastPolledAt: job.lastPolledAt,
      isolatedDownloadPath: job.isolatedDownloadPath,
      partialDownloadPath: job.partialDownloadPath,
      browserState: job.browserState,
      browserCheckpoint: job.browserCheckpoint ? {
        revision: job.browserCheckpoint.revision,
        stage: job.browserCheckpoint.stage,
        note: sanitizeDiagnosticText(job.browserCheckpoint.note),
        preflightEvidence: sanitizeDiagnosticValue(job.browserCheckpoint.preflightEvidence),
        submissionIntent: job.browserCheckpoint.submissionIntent,
        submissionReconciliation: job.browserCheckpoint.submissionReconciliation ? { ...job.browserCheckpoint.submissionReconciliation, note: sanitizeDiagnosticText(job.browserCheckpoint.submissionReconciliation.note) ?? "" } : undefined,
        updatedAt: job.browserCheckpoint.updatedAt,
      } : undefined,
      subagentCheckpoint: sanitizeDiagnosticValue(job.subagentCheckpoint),
      publicationBundleId: job.publicationBundleId,
      publicationIntentId: job.publicationIntentId,
      publicationReceiptId: job.publicationReceiptId,
      companionPublicationIntentId: job.companionPublicationIntentId,
      companionPublicationReceiptId: job.companionPublicationReceiptId,
      error: sanitizeDiagnosticText(job.error),
      updatedAt: job.updatedAt,
    })),
    renderJobs: renderJobs.slice(0, 30),
    publications: {
      counts: Object.fromEntries((["reserved", "registered", "cancelled", "failed"] as const).map((status) => [status, publicationIntents.filter((intent) => intent.status === status).length])),
      pending: pendingPublicationTargets,
      validationMode: "two-phase-snapshot-validate-cas",
    },
    runtimeResources,
    videoContinuations: continuations.slice(0, 30),
    hardLocks: index.project.hardLocks,
    activeSkills: skills.map(({ content: _content, ...skill }) => skill),
    story: { sources: storySources.length, chapters: storyChapters.length, events: storyEvents.length, confirmedEvents: storyEvents.filter((event) => event.status === "confirmed").length, orphanEvents: storyEvents.filter((event) => event.itemIds.some((itemId) => !index.items.some((item) => item.id === itemId))).length },
    productionDesign: { workflow: workflowState, evidence: productionEvidence, bibles: bibles.map(({ summary, ...bible }) => ({ ...bible, summary: summary.slice(0, 2_000) })), storyboard: { revision: storyboard.revision, rows: storyboard.rows.length, valid: storyboard.valid, issues: storyboard.issues }, assetConsistency: fusionAssetConsistency, panelReferences: fusionPanelReferences ? { resolverVersion: fusionPanelReferences.resolverVersion, revision: fusionPanelReferences.revision, storeFingerprint: fusionPanelReferences.storeFingerprint, updatedAt: fusionPanelReferences.updatedAt, currentness: fusionPanelReferenceCurrentness, audit: fusionPanelReferences.audit, derivedDefinitions: Object.keys(fusionPanelReferences.derivedAssets).length, overrides: Object.keys(fusionPanelReferences.overrides).length } : null, assetRelations: assetRelations.slice(0, 200), voiceIdentities: voiceIdentities.slice(0, 100) },
    recentEvents: sanitizeDiagnosticValue(events),
    continuation: { focusItemId: continuation.focusItem?.id, relatedContext: continuation.relatedContext, prompt: continuation.prompt },
    suggestedNextCalls: hasUnknownSubagentGeneration
      ? ["get_subagent_image_generation_plan", "list_publications", "doctor_project"]
      : panelReferenceSuggestedCalls
      ? panelReferenceSuggestedCalls
      : hasCandidateSubagentGeneration
      ? ["get_subagent_image_generation_plan", "update_subagent_image_generation_job", "list_publications"]
      : hasPendingSubagentGeneration
      ? ["get_subagent_image_generation_plan", "update_subagent_image_generation_job", "doctor_project"]
      : hasUnknownComfyGeneration
      ? ["list_generation_jobs", "process_generation_queue", "doctor_project"]
      : hasUnknownBrowserGeneration && hasUnknownHttpGeneration
      ? ["get_browser_generation_plan", "reconcile_http_generation_submission", "list_command_ledger"]
      : hasUnknownBrowserGeneration
        ? ["get_browser_generation_plan", "list_command_ledger", "update_browser_generation_job"]
      : hasUnknownHttpGeneration
        ? ["list_generation_jobs", "reconcile_http_generation_submission", "list_command_ledger"]
      : generationJobs.some((job) => job.status === "waiting_remote" && job.remoteObservation?.nextAction === "inspect_publication")
        ? ["list_generation_jobs", "list_publications", "doctor_project"]
      : generationJobs.some((job) => job.status === "waiting_remote" && job.remoteObservation?.state === "retryable_or_unknown")
        ? ["list_generation_jobs", "process_generation_queue", "doctor_project"]
      : hasBlockedBrowserPreflight
        ? ["get_browser_generation_plan", "update_browser_generation_job", "doctor_project"]
      : generationJobs.some((job) => job.status === "waiting_external" && ["plan_ready", "leased", "generated"].includes(job.subagentCheckpoint?.stage ?? ""))
        ? ["get_subagent_image_generation_plan", "update_subagent_image_generation_job", "doctor_project"]
      : assetConsistencySuggestedCalls
        ? assetConsistencySuggestedCalls
      : productionEvidence.repairRequired || productionEvidence.counts.legacyUnverified ? productionEvidence.suggestedCalls
      : activeRenderJobs.length ? ["get_edit_render_job", "get_project_snapshot"]
      : mediaCapacityLock ? ["get_project_snapshot"]
      : nextItems.length ? ["get_item", "create_task_pack", "claim_task"] : focusItem ? ["get_item", "get_production_workflow", "doctor_project"] : reviewQueue.length ? ["get_review_queue", "submit_review"] : ["scan_project", "doctor_project"],
  };
}
