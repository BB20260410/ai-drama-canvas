import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, link, lstat, mkdir, open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { loadSharpDefault } from "./sharp-lazy.js";
import { appendEvent, getSidecarPaths, readJson, readTaskPack, writeJsonAtomic } from "./sidecar.js";
import { getProjectIndex, scanAndPersist, updateStatusOverridesBatch } from "./service.js";
import { BROWSER_PREFLIGHT_BLOCKER_CODES } from "./types.js";
import type { Artifact, BrowserExecutionSurfaceIdentity, BrowserGenerationPlan, BrowserGenerationUpdateStatus, BrowserPreflightEvidence, BrowserPreflightInput, BrowserSubmissionReconciliation, BrowserSubmissionReconciliationInput, BrowserUploadEvidence, BrowserUploadInput, ComfyUiCancellationEvidence, ComfyUiCancellationObservation, ComfyUiGenerationCheckpoint, ComfyUiHistoryEvidence, ComfyUiOutputIdentity, ComfyUiPreflightEvidence, ComfyUiWorkflowBinding, GenerationExecutionSnapshot, GenerationJob, GenerationKind, GenerationProvider, GenerationProviderCapabilities, GenerationReference, GenerationReferenceRole, GenerationRemoteObservationStage, GenerationRemoteObservationState, GenerationSettings, GenerationSubmissionIntent, GenerationWorkflowDefinition, GenerationWorkflowEnvironment, GenerationWorkflowJsonValue, HardLock, HttpGenerationSubmissionCheckpoint, HttpGenerationSubmissionReconciliation, HttpGenerationSubmissionReconciliationResult, ReconcileHttpGenerationSubmissionInput, StoryboardProductionContract, SubagentImageGenerationCheckpoint, SubagentImageGenerationPlan, SubagentImageGenerationUpdateStatus, VideoContinuationPack, WorkItem } from "./types.js";
import { withProjectLock } from "./locks.js";
import {
  bindPublicationBundle,
  cancelPublication,
  cancelPublicationBundle,
  extendPublicationToBundle,
  failPublication,
  failPublicationBundle,
  getPublicationIntent,
  getPublicationReceipt,
  preflightPublication,
  preflightPublicationBundle,
  registerPublication,
  registerPublicationBundle,
  type GenerationPublicationTerminalCause,
  type GenerationPublicationTerminalProvenance,
  type PublicationIntent,
} from "./publication.js";
import { ConfirmedCommandFailure } from "./command-outcome.js";
import { assertFusionProjectReadable, buildFusionReferenceBoard, buildFusionStoryboardPanelReferenceBoard } from "./fusion-references.js";
import type { FusionStoryboardGridContract, FusionStoryboardGridPanel } from "./fusion-storyboard-grid.js";
import { assertFusionAssetConsistencyDownstreamReady, assertFusionAssetJobMaySubmit, reserveFusionAssetConsistencyMembership, rollbackFusionAssetConsistencyReservation } from "./fusion-asset-consistency.js";

const execFileAsync = promisify(execFile);
const MAX_WORKFLOW_BYTES = 512 * 1024;
const MAX_WORKFLOW_DEPTH = 40;
const MAX_WORKFLOW_ENTRIES = 20_000;
const MAX_IMAGE_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_VIDEO_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_IMAGE_DOWNLOAD_BYTES = 1_024;
const MIN_IMAGE_DIMENSION = 256;
const MIN_FORMAL_IMAGE_DOWNLOAD_BYTES = 20_000;
const MIN_FORMAL_IMAGE_WIDTH = 512;
const MIN_FORMAL_IMAGE_HEIGHT = 768;
const MAX_ASPECT_RATIO_RELATIVE_ERROR = 0.04;

class ConfirmedRemoteFailure extends Error {
  constructor(message: string, readonly observedStatus?: string) {
    super(message);
    this.name = "ConfirmedRemoteFailure";
  }
}

class ConfirmedRemoteCancellation extends Error {
  constructor(message: string, readonly observedStatus = "interrupted") {
    super(message);
    this.name = "ConfirmedRemoteCancellation";
  }
}

class HttpResponseFailure extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
    this.name = "HttpResponseFailure";
  }
}

class PublicationOutputConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationOutputConflict";
  }
}

class ComfyUiOutputIdentityFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComfyUiOutputIdentityFailure";
  }
}

class ComfyUiRetryablePreflightFailure extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
    this.name = "ComfyUiRetryablePreflightFailure";
  }
}

function safeRemoteMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|signature|sig|credential|authorization|set[_-]?cookie|cookie|password|secret)["']?\s*[:=]\s*)["']?[^\s,"'}]+/gi, "$1[redacted]")
    .slice(0, 1_000);
}

const stableGenerationId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const unsafeReconciliationText = /https?:\/\/|\bBearer\b|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|signature|sig)\s*[:=]/i;

function normalizeBrowserExecutionSurface(value: BrowserExecutionSurfaceIdentity | undefined): BrowserExecutionSurfaceIdentity | undefined {
  if (!value) return undefined;
  const id = value.id.trim();
  const version = value.version.trim();
  if (!stableGenerationId.test(id)) throw new Error("网页执行面 ID 无效。");
  if (!version || version.length > 120 || /[\r\n\0]/u.test(version)) throw new Error("网页执行面版本无效。");
  return { id, version };
}

function sameBrowserExecutionSurface(left: BrowserExecutionSurfaceIdentity | undefined, right: BrowserExecutionSurfaceIdentity | undefined): boolean {
  return Boolean(left && right && left.id === right.id && left.version === right.version);
}

function generationSubmissionIntent(job: GenerationJob): GenerationSubmissionIntent {
  const intent = job.submissionIntent ?? { clientJobId: job.clientJobId ?? job.id, attempt: Math.max(1, job.attempts), createdAt: job.updatedAt };
  if (!stableGenerationId.test(intent.clientJobId) || !Number.isInteger(intent.attempt) || intent.attempt < 1) throw new Error("生成任务缺少可验证的稳定提交意图。 ");
  if (job.clientJobId && job.clientJobId !== intent.clientJobId) throw new Error("生成任务 clientJobId 与提交意图不一致。 ");
  return { ...intent };
}

export function getHttpGenerationSubmissionCheckpoint(job: GenerationJob): HttpGenerationSubmissionCheckpoint | undefined {
  if (job.comfyUiCheckpoint || job.browserCheckpoint || job.subagentCheckpoint) return undefined;
  if (job.executionSnapshot?.provider.adapter && job.executionSnapshot.provider.adapter !== "http-json") return undefined;
  if (job.httpSubmissionCheckpoint) {
    return {
      ...structuredClone(job.httpSubmissionCheckpoint),
      revision: Math.max(1, job.httpSubmissionCheckpoint.revision || 1),
    };
  }
  if (job.status !== "submission_unknown") return undefined;
  return {
    revision: 1,
    stage: "submission_unknown",
    updatedAt: job.updatedAt,
    submissionIntent: generationSubmissionIntent(job),
  };
}

function ensureHttpGenerationSubmissionCheckpoint(job: GenerationJob): HttpGenerationSubmissionCheckpoint {
  const checkpoint = getHttpGenerationSubmissionCheckpoint(job);
  if (!checkpoint) throw new Error("该任务没有可对账的 HTTP submission_unknown 检查点。 ");
  job.httpSubmissionCheckpoint = checkpoint;
  return checkpoint;
}

function normalizeHttpSubmissionReconciliation(
  job: GenerationJob,
  input: ReconcileHttpGenerationSubmissionInput["reconciliation"],
  checkedAt: string,
): HttpGenerationSubmissionReconciliation {
  const intent = generationSubmissionIntent(job);
  const note = input.note.trim();
  const evidenceReference = input.evidenceReference.trim();
  if (note.length < 3 || note.length > 1_000) throw new Error("HTTP 提交对账 note 必须为 3–1000 字。 ");
  if (unsafeReconciliationText.test(note)) throw new Error("HTTP 提交对账 note 不能包含 URL 或凭据。 ");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,199}$/.test(evidenceReference)) throw new Error("HTTP 提交对账 evidenceReference 必须是 3–200 位稳定、无 URL 引用。 ");
  if (input.result === "found") {
    const externalTaskId = input.externalTaskId.trim();
    if (!stableGenerationId.test(externalTaskId)) throw new Error("found 对账必须提供 1–200 位稳定 externalTaskId，且不能包含 URL、空白或凭据。 ");
    return { method: input.method, result: "found", clientJobId: intent.clientJobId, attempt: intent.attempt, evidenceReference, note, externalTaskId, checkedAt };
  }
  if (input.confirmNoRemoteResult !== true) throw new Error("not_found 对账必须显式确认 confirmNoRemoteResult=true。 ");
  return { method: input.method, result: "not_found", clientJobId: intent.clientJobId, attempt: intent.attempt, evidenceReference, note, confirmNoRemoteResult: true, checkedAt };
}

function httpSubmissionResult(
  job: GenerationJob,
  checkpoint: HttpGenerationSubmissionCheckpoint,
  outcome: HttpGenerationSubmissionReconciliationResult["outcome"],
  applied: boolean,
  publicationStatus?: HttpGenerationSubmissionReconciliationResult["publicationStatus"],
): HttpGenerationSubmissionReconciliationResult {
  return {
    schemaVersion: 1,
    applied,
    outcome,
    jobId: job.id,
    itemId: job.itemId,
    providerId: job.providerId,
    status: job.status,
    clientJobId: checkpoint.submissionIntent.clientJobId,
    externalTaskId: job.externalTaskId,
    remoteAcceptedAt: job.remoteAcceptedAt,
    remoteObservation: job.remoteObservation ? structuredClone(job.remoteObservation) : undefined,
    httpSubmissionCheckpoint: structuredClone(checkpoint),
    publicationIntentId: job.publicationIntentId,
    publicationStatus,
    updatedAt: job.updatedAt,
  };
}

function rejectHttpSubmissionReconciliation(job: GenerationJob, checkpoint: HttpGenerationSubmissionCheckpoint, message: string, publicationStatus?: HttpGenerationSubmissionReconciliationResult["publicationStatus"]): never {
  throw new ConfirmedCommandFailure(message, httpSubmissionResult(job, checkpoint, "publication_conflict", false, publicationStatus));
}

function observeRemote(
  job: GenerationJob,
  state: GenerationRemoteObservationState,
  stage: GenerationRemoteObservationStage,
  message: string,
  options: { observedStatus?: string; httpStatus?: number; nextAction?: NonNullable<GenerationJob["remoteObservation"]>["nextAction"] } = {},
): void {
  const previousRetryCount = job.remoteObservation?.retryCount ?? 0;
  const retryCount = state === "retryable_or_unknown" ? previousRetryCount + 1 : state === "pending" ? previousRetryCount : 0;
  job.remoteObservation = {
    state,
    stage,
    observedAt: new Date().toISOString(),
    observedStatus: options.observedStatus ? safeRemoteMessage(options.observedStatus) : undefined,
    httpStatus: options.httpStatus,
    message: safeRemoteMessage(message),
    retryCount,
    nextAction: options.nextAction ?? (state === "pending" ? "poll_same_task" : state === "retryable_or_unknown" ? "retry_same_task" : "none"),
  };
}

function errorHttpStatus(error: unknown): number | undefined {
  return error instanceof HttpResponseFailure || error instanceof ComfyUiRetryablePreflightFailure ? error.httpStatus : undefined;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stableValue(entry)]));
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function sensitiveWorkflowKey(key: string): boolean {
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return /(^|[_-])(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|authorization|cookie|session[_-]?id)($|[_-])/.test(normalized);
}

function normalizeWorkflowJson(value: unknown, location: string, depth: number, state: { entries: number }): GenerationWorkflowJsonValue {
  if (depth > MAX_WORKFLOW_DEPTH) throw new Error(`生成工作流层级超过 ${MAX_WORKFLOW_DEPTH} 层：${location}`);
  state.entries += 1;
  if (state.entries > MAX_WORKFLOW_ENTRIES) throw new Error(`生成工作流条目超过 ${MAX_WORKFLOW_ENTRIES} 个。`);
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.length > 100_000) throw new Error(`生成工作流字符串过长：${location}`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`生成工作流包含非有限数值：${location}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => normalizeWorkflowJson(entry, `${location}[${index}]`, depth + 1, state));
  if (!value || typeof value !== "object") throw new Error(`生成工作流只能包含 JSON 值：${location}`);
  const normalized: Record<string, GenerationWorkflowJsonValue> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error(`生成工作流包含危险字段：${location}.${key}`);
    if (sensitiveWorkflowKey(key) && entry !== null && entry !== "" && entry !== false) throw new Error(`生成工作流不能保存凭据字段 ${location}.${key}；请改用供应商 apiKeyEnv。`);
    normalized[key] = normalizeWorkflowJson(entry, `${location}.${key}`, depth + 1, state);
  }
  return normalized;
}

function shortText(value: unknown, label: string, max = 500): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串。`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw new Error(`${label} 不能超过 ${max} 个字符。`);
  return trimmed;
}

function normalizeWorkflowEnvironment(input: GenerationWorkflowEnvironment | undefined): GenerationWorkflowEnvironment | undefined {
  if (!input) return undefined;
  const models = (input.models ?? []).slice(0, 500).map((model, index) => {
    const name = shortText(model.name, `工作流模型 ${index + 1} 名称`, 500);
    if (!name) throw new Error(`工作流模型 ${index + 1} 缺少名称。`);
    const sha256 = shortText(model.sha256, `工作流模型 ${index + 1} SHA-256`, 64)?.toLowerCase();
    if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`工作流模型 ${index + 1} 的 SHA-256 无效。`);
    return { name, version: shortText(model.version, `工作流模型 ${index + 1} 版本`), sha256, nodeId: shortText(model.nodeId, `工作流模型 ${index + 1} 节点 ID`) };
  });
  const customNodes = (input.customNodes ?? []).slice(0, 500).map((node, index) => {
    const name = shortText(node.name, `自定义节点 ${index + 1} 名称`, 500);
    if (!name) throw new Error(`自定义节点 ${index + 1} 缺少名称。`);
    return { name, version: shortText(node.version, `自定义节点 ${index + 1} 版本`), commit: shortText(node.commit, `自定义节点 ${index + 1} 提交`, 160) };
  });
  const environment: GenerationWorkflowEnvironment = {
    engine: shortText(input.engine, "工作流引擎"),
    engineVersion: shortText(input.engineVersion, "工作流引擎版本"),
    platform: shortText(input.platform, "工作流平台"),
    device: shortText(input.device, "工作流设备"),
    models: models.length ? models : undefined,
    customNodes: customNodes.length ? customNodes : undefined,
    notes: (input.notes ?? []).map((note, index) => shortText(note, `工作流说明 ${index + 1}`, 2_000)).filter((note): note is string => Boolean(note)).slice(0, 200),
  };
  if (!environment.notes?.length) environment.notes = undefined;
  return Object.values(environment).some((value) => value !== undefined) ? environment : undefined;
}

function normalizeComfyUiWorkflowBinding(input: ComfyUiWorkflowBinding | undefined, definition: Record<string, GenerationWorkflowJsonValue>, format: GenerationWorkflowDefinition["format"]): ComfyUiWorkflowBinding | undefined {
  if (!input) return undefined;
  if (format !== "comfyui-api") throw new Error("ComfyUI 绑定只能用于 comfyui-api 工作流格式。");
  if (!Array.isArray(input.promptInputs) || input.promptInputs.length < 1 || input.promptInputs.length > 20) throw new Error("ComfyUI 工作流必须配置 1–20 个显式 prompt 输入绑定。");
  const promptInputs = input.promptInputs.map((binding, index) => {
    const nodeId = shortText(binding?.nodeId, `ComfyUI prompt 绑定 ${index + 1} 节点 ID`, 200);
    const inputName = shortText(binding?.inputName, `ComfyUI prompt 绑定 ${index + 1} 输入名`, 200);
    if (!nodeId || !inputName || !stableGenerationId.test(nodeId) || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(inputName)) throw new Error(`ComfyUI prompt 绑定 ${index + 1} 无效。`);
    const node = definition[nodeId];
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error(`ComfyUI prompt 绑定节点 ${nodeId} 不存在。`);
    const inputs = (node as Record<string, GenerationWorkflowJsonValue>).inputs;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs) || !Object.prototype.hasOwnProperty.call(inputs, inputName)) throw new Error(`ComfyUI prompt 绑定 ${nodeId}.${inputName} 不存在。`);
    return { nodeId, inputName };
  });
  if (new Set(promptInputs.map((binding) => `${binding.nodeId}\u0000${binding.inputName}`)).size !== promptInputs.length) throw new Error("ComfyUI prompt 输入绑定不能重复。");
  const outputNodeId = shortText(input.outputNodeId, "ComfyUI 输出节点 ID", 200);
  if (!outputNodeId || !stableGenerationId.test(outputNodeId)) throw new Error("ComfyUI 输出节点 ID 无效。");
  const outputNode = definition[outputNodeId];
  if (!outputNode || typeof outputNode !== "object" || Array.isArray(outputNode)) throw new Error(`ComfyUI 输出节点 ${outputNodeId} 不存在。`);
  if (!Number.isInteger(input.outputIndex) || input.outputIndex < 0 || input.outputIndex > 99) throw new Error("ComfyUI 输出索引必须是 0–99 的整数。");
  return { promptInputs, outputNodeId, outputIndex: input.outputIndex };
}

export function normalizeGenerationWorkflow(workflow: GenerationWorkflowDefinition): { workflow: GenerationWorkflowDefinition; hash: string; bytes: number } {
  if (workflow.schemaVersion !== 1) throw new Error("生成工作流 schemaVersion 必须为 1。");
  const name = shortText(workflow.name, "生成工作流名称", 200);
  const version = shortText(workflow.version, "生成工作流版本", 120);
  if (!name || !version) throw new Error("生成工作流名称和版本不能为空。");
  if (!["generic-json", "comfyui-api", "browser-recipe"].includes(workflow.format)) throw new Error("生成工作流格式无效。");
  if (!workflow.definition || typeof workflow.definition !== "object" || Array.isArray(workflow.definition)) throw new Error("生成工作流 definition 必须是 JSON 对象。");
  const definition = normalizeWorkflowJson(workflow.definition, "definition", 0, { entries: 0 });
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new Error("生成工作流 definition 必须是 JSON 对象。");
  const normalized: GenerationWorkflowDefinition = {
    schemaVersion: 1,
    name,
    version,
    format: workflow.format,
    definition,
    environment: normalizeWorkflowEnvironment(workflow.environment),
    comfyUi: normalizeComfyUiWorkflowBinding(workflow.comfyUi, definition, workflow.format),
  };
  const serialized = stableJson(normalized);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_WORKFLOW_BYTES) throw new Error(`生成工作流大小 ${bytes} 字节，超过 ${MAX_WORKFLOW_BYTES} 字节上限。`);
  return { workflow: normalized, hash: createHash("sha256").update(serialized).digest("hex"), bytes };
}

type PanelVisualExecutionIdentity = {
  constraintId: string;
  constraintFingerprint: string;
  modelFingerprint: string;
  reviewRulesFingerprint: string;
};

function panelVisualExecutionIdentity(job: GenerationJob): PanelVisualExecutionIdentity | undefined {
  const panel = job.fusionStoryboardPanel;
  if (!panel?.panelVisualConstraintId || !panel.panelVisualConstraintFingerprint || !panel.panelVisualModelFingerprint || !panel.panelVisualReviewRulesFingerprint) return undefined;
  return {
    constraintId: panel.panelVisualConstraintId,
    constraintFingerprint: panel.panelVisualConstraintFingerprint,
    modelFingerprint: panel.panelVisualModelFingerprint,
    reviewRulesFingerprint: panel.panelVisualReviewRulesFingerprint,
  };
}

function createExecutionSnapshot(provider: GenerationProvider, prompt: string, parameters: GenerationJob["parameters"], storyboardRows: StoryboardProductionContract[], references: GenerationReference[], visual?: PanelVisualExecutionIdentity): GenerationExecutionSnapshot {
  const providerSnapshot = JSON.parse(JSON.stringify(provider)) as GenerationProvider;
  const capturedAt = new Date().toISOString();
  const snapshotBase: Omit<GenerationExecutionSnapshot, "snapshotHash"> = {
    schemaVersion: 1,
    capturedAt,
    provider: providerSnapshot,
    workflowHash: providerSnapshot.workflowHash,
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    parametersSha256: sha256Json(parameters ?? {}),
    storyboardRowsSha256: sha256Json(storyboardRows),
    referencesSha256: sha256Json(references),
    ...(visual ? {
      panelVisualConstraintId: visual.constraintId,
      panelVisualConstraintFingerprint: visual.constraintFingerprint,
      panelVisualModelFingerprint: visual.modelFingerprint,
      panelVisualReviewRulesFingerprint: visual.reviewRulesFingerprint,
    } : {}),
  };
  return { ...snapshotBase, snapshotHash: sha256Json(snapshotBase) };
}

function assertExecutionSnapshot(job: GenerationJob): void {
  if (!job.executionSnapshot) return;
  const { snapshotHash, ...snapshotBase } = job.executionSnapshot;
  if (!/^[a-f0-9]{64}$/.test(snapshotHash) || sha256Json(snapshotBase) !== snapshotHash) throw new Error("生成任务执行快照校验失败；拒绝使用可能被修改的供应商或工作流配置。 ");
  if (job.executionSnapshot.provider.id !== job.providerId) throw new Error("生成任务执行快照的供应商 ID 与任务不一致。 ");
  if (job.executionSnapshot.promptSha256 !== createHash("sha256").update(job.prompt).digest("hex")) throw new Error("生成任务提示词已偏离入队快照。 ");
  if (job.executionSnapshot.parametersSha256 !== sha256Json(job.parameters ?? {})) throw new Error("生成任务生成参数已偏离入队快照。 ");
  if (job.executionSnapshot.storyboardRowsSha256 !== sha256Json(job.storyboardRows)) throw new Error("生成任务正式分镜已偏离入队快照。 ");
  if (job.executionSnapshot.referencesSha256 !== sha256Json(job.references ?? [])) throw new Error("生成任务参考素材已偏离入队快照。 ");
  const visual = panelVisualExecutionIdentity(job);
  if (job.panelVisualConstraintEvidenceVersion === 1) {
    if (!visual
      || job.executionSnapshot.panelVisualConstraintId !== visual.constraintId
      || job.executionSnapshot.panelVisualConstraintFingerprint !== visual.constraintFingerprint
      || job.executionSnapshot.panelVisualModelFingerprint !== visual.modelFingerprint
      || job.executionSnapshot.panelVisualReviewRulesFingerprint !== visual.reviewRulesFingerprint) {
      throw new Error("生成任务执行快照与 P3 视觉约束身份不一致。 ");
    }
  } else if (job.executionSnapshot.panelVisualConstraintId
    || job.executionSnapshot.panelVisualConstraintFingerprint
    || job.executionSnapshot.panelVisualModelFingerprint
    || job.executionSnapshot.panelVisualReviewRulesFingerprint) {
    throw new Error("生成任务执行快照含不完整的 P3 视觉约束身份。 ");
  }
  const workflow = job.executionSnapshot.provider.workflow;
  if (workflow) {
    const normalized = normalizeGenerationWorkflow(workflow);
    if (normalized.hash !== job.executionSnapshot.workflowHash || normalized.hash !== job.executionSnapshot.provider.workflowHash) throw new Error("生成任务工作流哈希与执行快照不一致。 ");
  }
}

function providerForJob(settings: GenerationSettings, job: GenerationJob): GenerationProvider | undefined {
  assertExecutionSnapshot(job);
  return job.executionSnapshot?.provider ?? settings.providers.find((candidate) => candidate.id === job.providerId);
}

function defaultCapabilities(): GenerationProviderCapabilities {
  return { referenceModes: ["text", "first_frame", "last_frame", "first_last_frame", "multi_image", "video_reference"], maxReferenceImages: 12, maxReferenceVideos: 1, supportedDurations: [5, 10, 15], supportedAspectRatios: ["9:16", "16:9", "1:1"], supportedResolutions: ["720p", "1080p"], models: [], maxConcurrency: 2, supportsCancel: false };
}

export const FUSION_SUBAGENT_GENERIC_INSTRUCTIONS = "每张图由一个唯一 canonical 子代理按租约严格串行执行；每个代理只调用一次内置 image_gen、只生成一张图，并且只写 Core 指定的隔离候选路径。人物、场景、道具、可见性和风格只能来自本任务冻结的安全模型提示与 allowedReferences，禁止自行增加全局角色、道具、路径或参考图。逐文件核对绝对路径、语义槽位与 SHA；没有参考时保持 text-only。画幅 9:16、Medium、1 Image。候选必须是真 PNG、可解码、竖屏、非占位；代理无权覆盖正式 raw/labeled、改提示词、验收、硬锁或启动第二代理，最终视觉 Review 与 Publication 只由主代理执行。";

export const FUSION_BROWSER_GENERIC_INSTRUCTIONS = "只执行当前任务冻结的安全模型提示、参数与 allowedUploads；不得从其他任务、全局说明或浏览器残留补充人物、场景、道具、身份、路径或参考图。上传前核对逐项 SHA 与槽位；text-only 必须确认参考缩略图为 0。严格按预检、上传证据、submit_intent、单击一次、远端身份、隔离下载、Publication、人工视觉 Review 的顺序执行；不得付费、重复提交、覆盖正式 raw/labeled 或把网页截图当原始结果。";

const PROJECT_IDENTITY_INSTRUCTION_PATTERN = /(?:黄金面具|完整面具|半面具|裂面具|面具口型|阿航|嘟嘟|\/Users\/|authorities\/|[a-f0-9]{64})/iu;

function assertFusionProviderInstructionsSafe(provider: GenerationProvider): void {
  if (provider.adapter !== "codex-subagent-imagegen") return;
  const instructions = provider.subagentInstructions?.trim() ?? "";
  if (!instructions) throw new Error("第三季子代理供应商缺少通用执行合同。");
  if (PROJECT_IDENTITY_INSTRUCTION_PATTERN.test(instructions)) {
    throw new Error("第三季子代理供应商仍含项目级人物、道具、权威路径或 SHA；请先迁移为 P3 通用执行合同，禁止把无关身份泄漏给每个子代理。");
  }
}

function defaultSettings(projectRoot: string): GenerationSettings {
  const now = new Date(0).toISOString();
  return {
    schemaVersion: 1,
    revision: 0,
    providers: [
      { id: "folder-image", name: "图片落盘桥接", adapter: "folder-bridge", kinds: ["image"], enabled: true, capabilities: defaultCapabilities(), outputRoot: projectRoot, createdAt: now, updatedAt: now },
      { id: "folder-video", name: "视频落盘桥接", adapter: "folder-bridge", kinds: ["video"], enabled: true, capabilities: defaultCapabilities(), outputRoot: projectRoot, createdAt: now, updatedAt: now },
    ],
    defaultImageProviderId: "folder-image",
    defaultVideoProviderId: "folder-video",
    concurrency: 2,
    updatedAt: now,
  };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function privateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "::1", "0.0.0.0"].includes(host) || host.endsWith(".local")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31);
}

function loopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function validatedComfyUiEndpoint(provider: GenerationProvider, value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(`${provider.name} 的 ComfyUI 地址无效或包含凭据。`);
  if (!loopbackHostname(url.hostname)) throw new Error(`${provider.name} 的 ComfyUI 地址必须是 localhost、127.0.0.1 或 [::1] loopback，不能使用公网、局域网或 0.0.0.0。`);
  if (url.search || url.hash) throw new Error(`${provider.name} 的 ComfyUI 地址不能包含 query 或 fragment。`);
  if (url.pathname !== "/" && url.pathname !== "") throw new Error(`${provider.name} 的 ComfyUI 地址必须是本机服务 origin，不能附带路径。`);
  return url;
}

function validatedHttpUrl(provider: GenerationProvider, value: string, label: string): URL {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error(`${provider.name} 的${label}无效或包含凭据。`);
  if (privateHostname(url.hostname) && !provider.allowPrivateNetwork) throw new Error(`${provider.name} 的${label}指向本机或私网；必须显式开启 allowPrivateNetwork。`);
  return url;
}

function validatedProviderConfigurationUrl(provider: GenerationProvider, value: string, label: string): URL {
  const url = validatedHttpUrl(provider, value, label);
  const sensitiveQueryKey = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|signature|sig|credential|authorization|cookie|password|secret)$/i;
  if (url.hash || [...url.searchParams.keys()].some((key) => sensitiveQueryKey.test(key))) throw new Error(`${provider.name} 的${label}不能在 query 或 fragment 内嵌凭据；请使用 apiKeyEnv 和请求头。`);
  return url;
}

export async function getGenerationSettings(projectRoot: string): Promise<GenerationSettings> {
  const paths = getSidecarPaths(projectRoot);
  const current = await readJson<GenerationSettings | null>(paths.generationSettings, null);
  if (current) return {
    ...current,
    revision: Number.isInteger(current.revision) && current.revision > 0 ? current.revision : 1,
    providers: current.providers.map((provider) => {
      const normalizedWorkflow = provider.workflow ? normalizeGenerationWorkflow(provider.workflow) : undefined;
      return { ...provider, capabilities: provider.capabilities ?? defaultCapabilities(), workflow: normalizedWorkflow?.workflow, workflowHash: normalizedWorkflow?.hash };
    }),
  };
  return defaultSettings(projectRoot);
}

export async function getGenerationProvider(projectRoot: string, providerId: string): Promise<{ settingsRevision: number; provider: GenerationProvider }> {
  const settings = await getGenerationSettings(projectRoot);
  const provider = settings.providers.find((candidate) => candidate.id === providerId);
  if (!provider) throw new Error(`找不到生成供应商 ${providerId}。`);
  return { settingsRevision: settings.revision, provider };
}

export type GenerationProviderUpsert = Omit<GenerationProvider, "createdAt" | "updatedAt" | "workflowHash">;

export interface UpsertGenerationProviderInput {
  expectedRevision: number;
  provider: GenerationProviderUpsert;
  setAsDefaultFor?: GenerationKind;
  concurrency?: number;
}

export async function saveGenerationSettings(projectRoot: string, settings: GenerationSettings, expectedRevision = settings.revision, actor: "user" | "codex" = "user"): Promise<GenerationSettings> {
  return withProjectLock(projectRoot, "generation-settings", async () => {
  const paths = getSidecarPaths(projectRoot);
  const current = await readJson<GenerationSettings | null>(paths.generationSettings, null);
  const currentRevision = current ? (Number.isInteger(current.revision) && current.revision > 0 ? current.revision : 1) : 0;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("生成供应商配置 expectedRevision 必须是非负整数。");
  if (expectedRevision !== currentRevision) throw new Error(`生成供应商配置修订冲突：期望 ${expectedRevision}，当前 ${currentRevision}。请重新读取后再修改。`);
  const index = await getProjectIndex(projectRoot);
  const allowedRoots = [...new Set([index.project.primaryRoot, ...index.project.outputRoots])];
  const ids = new Set<string>();
  const providers = settings.providers.map((provider): GenerationProvider => {
    const candidate = { ...provider };
    candidate.id = candidate.id.trim();
    if (!candidate.id || ids.has(candidate.id)) throw new Error("生成供应商 ID 不能为空或重复。");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,119}$/.test(candidate.id)) throw new Error(`生成供应商 ID ${candidate.id} 格式无效。`);
    ids.add(candidate.id);
    if (!["folder-bridge", "http-json", "comfyui-local", "codex-browser", "codex-subagent-imagegen", "mock"].includes(candidate.adapter)) throw new Error(`供应商 ${candidate.id} 的 adapter 无效。`);
    candidate.kinds = [...new Set(candidate.kinds.filter((kind) => kind === "image" || kind === "video"))];
    if (!candidate.kinds.length) throw new Error(`供应商 ${candidate.id} 至少要支持 image 或 video。`);
    const outputRoot = path.resolve(candidate.outputRoot || index.project.primaryRoot);
    if (!allowedRoots.some((root) => isWithin(root, outputRoot))) throw new Error(`供应商 ${candidate.name} 的输出根不在项目允许范围内。`);
    if (candidate.adapter === "http-json") {
      if (!candidate.endpoint || !/^https?:\/\//i.test(candidate.endpoint)) throw new Error(`供应商 ${candidate.name} 缺少有效 HTTP 提交地址。`);
      if (candidate.pollEndpoint && !/^https?:\/\//i.test(candidate.pollEndpoint)) throw new Error(`供应商 ${candidate.name} 的轮询地址无效。`);
      if (candidate.apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/i.test(candidate.apiKeyEnv)) throw new Error(`供应商 ${candidate.name} 的密钥环境变量名称无效。`);
      validatedProviderConfigurationUrl(candidate, candidate.endpoint, "提交地址");
      if (candidate.pollEndpoint) validatedProviderConfigurationUrl(candidate, candidate.pollEndpoint.replaceAll("{taskId}", "task"), "轮询地址");
      if (candidate.cancelEndpoint) validatedProviderConfigurationUrl(candidate, candidate.cancelEndpoint.replaceAll("{taskId}", "task"), "取消地址");
      if (candidate.capabilities?.supportsCancel && !candidate.cancelEndpoint) throw new Error(`供应商 ${candidate.name} 声明支持取消，但没有配置 cancelEndpoint。`);
      candidate.cancelMethod = candidate.cancelMethod === "DELETE" ? "DELETE" : "POST";
      candidate.allowedResultHosts = [...new Set((candidate.allowedResultHosts ?? []).map((host) => host.trim().toLowerCase()).filter((host) => /^[a-z0-9.-]+$/.test(host)))].slice(0, 50);
    }
    if (candidate.adapter === "comfyui-local") {
      if (candidate.kinds.length !== 1 || candidate.kinds[0] !== "image") throw new Error(`供应商 ${candidate.name} 的 comfyui-local 首版只允许图片 image 生成。`);
      if (!candidate.endpoint) throw new Error(`供应商 ${candidate.name} 缺少 ComfyUI 本机地址。`);
      const endpoint = validatedComfyUiEndpoint(candidate, candidate.endpoint);
      if (candidate.pollEndpoint || candidate.cancelEndpoint || candidate.apiKeyEnv || candidate.siteUrl || candidate.sendLocalPaths || candidate.allowedResultHosts?.length) throw new Error(`供应商 ${candidate.name} 的 comfyui-local 使用固定本机协议，不能配置通用轮询、取消、凭据、网站、本地路径透传或额外结果域名。`);
      const normalizedWorkflow = candidate.workflow ? normalizeGenerationWorkflow(candidate.workflow) : undefined;
      if (!normalizedWorkflow || normalizedWorkflow.workflow.format !== "comfyui-api" || !normalizedWorkflow.workflow.comfyUi) throw new Error(`供应商 ${candidate.name} 必须配置 comfyui-api 工作流及显式 prompt/output 绑定。`);
      candidate.endpoint = endpoint.origin;
      candidate.allowPrivateNetwork = true;
    }
    if (candidate.adapter === "codex-browser") {
      if (!candidate.siteUrl) throw new Error(`网页供应商 ${candidate.name} 缺少网站地址。`);
      const siteUrl = new URL(candidate.siteUrl);
      if (!["https:", "http:"].includes(siteUrl.protocol) || siteUrl.username || siteUrl.password) throw new Error(`网页供应商 ${candidate.name} 的地址无效或包含凭据。`);
      if (siteUrl.hash || [...siteUrl.searchParams.keys()].some((key) => /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|signature|sig|credential|authorization|cookie|password|secret)$/i.test(key))) throw new Error(`网页供应商 ${candidate.name} 的地址不能在 query 或 fragment 内嵌凭据。`);
      candidate.siteUrl = siteUrl.toString();
      candidate.browserInstructions = candidate.browserInstructions?.trim().slice(0, 20_000) || undefined;
      candidate.executionSurface = normalizeBrowserExecutionSurface(candidate.executionSurface);
    } else if (candidate.executionSurface) {
      throw new Error(`供应商 ${candidate.name} 不是 codex-browser，不能声明网页执行面。`);
    }
    if (candidate.adapter === "codex-subagent-imagegen") {
      if (candidate.kinds.length !== 1 || candidate.kinds[0] !== "image") throw new Error(`供应商 ${candidate.name} 的 codex-subagent-imagegen 只允许图片 image 生成。`);
      if (candidate.endpoint || candidate.pollEndpoint || candidate.cancelEndpoint || candidate.apiKeyEnv || candidate.siteUrl || candidate.sendLocalPaths || candidate.allowedResultHosts?.length || candidate.workflow) {
        throw new Error(`供应商 ${candidate.name} 的 codex-subagent-imagegen 不能配置远端地址、凭据、网页、本地路径透传或工作流。`);
      }
      candidate.subagentInstructions = candidate.subagentInstructions?.trim().slice(0, 20_000) || undefined;
    } else if (candidate.subagentInstructions) {
      throw new Error(`供应商 ${candidate.name} 不是 codex-subagent-imagegen，不能声明子代理执行说明。`);
    }
    const defaults = defaultCapabilities();
    const capabilities = candidate.capabilities ?? defaults;
    const normalizedCapabilities: GenerationProviderCapabilities = {
      referenceModes: [...new Set(capabilities.referenceModes.filter((mode) => ["text", "first_frame", "last_frame", "first_last_frame", "multi_image", "video_reference"].includes(mode)))],
      maxReferenceImages: Math.max(0, Math.min(100, Math.trunc(capabilities.maxReferenceImages ?? defaults.maxReferenceImages))),
      maxReferenceVideos: Math.max(0, Math.min(10, Math.trunc(capabilities.maxReferenceVideos ?? defaults.maxReferenceVideos))),
      supportedDurations: [...new Set((capabilities.supportedDurations ?? []).filter((value) => Number.isFinite(value) && value > 0 && value <= 300).map((value) => Math.round(value * 1_000) / 1_000))].sort((a, b) => a - b),
      supportedAspectRatios: [...new Set((capabilities.supportedAspectRatios ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 50),
      supportedResolutions: [...new Set((capabilities.supportedResolutions ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 50),
      models: [...new Set([...(capabilities.models ?? []), ...(candidate.model ? [candidate.model] : [])].map((value) => value.trim()).filter(Boolean))].slice(0, 100),
      maxConcurrency: Math.max(1, Math.min(20, Math.trunc(capabilities.maxConcurrency ?? defaults.maxConcurrency))),
      supportsCancel: Boolean(capabilities.supportsCancel),
    };
    if (candidate.adapter === "comfyui-local") normalizedCapabilities.supportsCancel = true;
    if (candidate.adapter === "codex-subagent-imagegen") {
      normalizedCapabilities.maxConcurrency = 1;
      normalizedCapabilities.supportsCancel = false;
    }
    if (!normalizedCapabilities.referenceModes.length) normalizedCapabilities.referenceModes = ["text"];
    const normalizedWorkflow = candidate.workflow ? normalizeGenerationWorkflow(candidate.workflow) : undefined;
    return { ...candidate, name: candidate.name.trim() || candidate.id, capabilities: normalizedCapabilities, workflow: normalizedWorkflow?.workflow, workflowHash: normalizedWorkflow?.hash, outputRoot, createdAt: candidate.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  });
  const defaultImageProvider = settings.defaultImageProviderId ? providers.find((provider) => provider.id === settings.defaultImageProviderId && provider.enabled && provider.kinds.includes("image")) : undefined;
  const defaultVideoProvider = settings.defaultVideoProviderId ? providers.find((provider) => provider.id === settings.defaultVideoProviderId && provider.enabled && provider.kinds.includes("video")) : undefined;
  if (settings.defaultImageProviderId && !defaultImageProvider) throw new Error(`默认图片供应商 ${settings.defaultImageProviderId} 不存在、未启用或不支持 image。`);
  if (settings.defaultVideoProviderId && !defaultVideoProvider) throw new Error(`默认视频供应商 ${settings.defaultVideoProviderId} 不存在、未启用或不支持 video。`);
  const normalized: GenerationSettings = {
    schemaVersion: 1,
    revision: currentRevision + 1,
    providers,
    defaultImageProviderId: settings.defaultImageProviderId,
    defaultVideoProviderId: settings.defaultVideoProviderId,
    concurrency: providers.some((provider) => provider.enabled && provider.adapter === "codex-subagent-imagegen")
      ? 1
      : Math.max(1, Math.min(settings.concurrency || 1, 8)),
    updatedAt: new Date().toISOString(),
  };
  const activeProviderIds = new Set((await listGenerationJobs(projectRoot)).filter((job) => !["succeeded", "failed", "cancelled", "visual_rejected"].includes(job.status)).map((job) => job.providerId));
  const nextProviderIds = new Set(providers.map((provider) => provider.id));
  const missing = [...activeProviderIds].filter((id) => !nextProviderIds.has(id));
  if (missing.length) throw new Error(`仍有未完成任务使用供应商 ${missing.join("、")}，不能删除或修改其 ID。`);
  await writeJsonAtomic(paths.generationSettings, normalized);
  await appendEvent(projectRoot, { actor, type: "generation.settings_updated", data: { revision: normalized.revision, providers: providers.map((provider) => provider.id) } });
  return normalized;
  });
}

export async function upsertGenerationProvider(projectRoot: string, input: UpsertGenerationProviderInput, actor: "user" | "codex" = "user"): Promise<GenerationSettings> {
  const current = await getGenerationSettings(projectRoot);
  if (current.revision !== input.expectedRevision) throw new Error(`生成供应商配置修订冲突：期望 ${input.expectedRevision}，当前 ${current.revision}。请重新读取后再修改。`);
  const now = new Date().toISOString();
  const existing = current.providers.find((provider) => provider.id === input.provider.id.trim());
  const provider: GenerationProvider = { ...input.provider, id: input.provider.id.trim(), createdAt: existing?.createdAt ?? now, updatedAt: now };
  const providers = existing
    ? current.providers.map((candidate) => candidate.id === existing.id ? provider : candidate)
    : [...current.providers, provider];
  const next: GenerationSettings = {
    ...current,
    providers,
    concurrency: input.concurrency ?? current.concurrency,
    defaultImageProviderId: input.setAsDefaultFor === "image" ? provider.id : current.defaultImageProviderId,
    defaultVideoProviderId: input.setAsDefaultFor === "video" ? provider.id : current.defaultVideoProviderId,
  };
  return saveGenerationSettings(projectRoot, next, input.expectedRevision, actor);
}

export async function listGenerationJobs(projectRoot: string): Promise<GenerationJob[]> {
  return (await readJson<GenerationJob[]>(getSidecarPaths(projectRoot).generationJobs, [])).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function outputName(item: WorkItem, kind: GenerationKind, jobId: string): string {
  if (item.type === "asset") return `${item.id.replace(/^asset-/u, "")}_资产_${jobId.slice(-8)}_raw.png`;
  const prefix = item.type === "shot"
    ? `EP${String(item.episode ?? 0).padStart(2, "0")}_镜${String(item.shot ?? "00").padStart(2, "0")}`
    : `EP${String(item.episode ?? 0).padStart(2, "0")}_15s_${String(item.unit ?? 0).padStart(3, "0")}`;
  if (kind === "video") return `${prefix}_视频_${jobId.slice(-8)}.mp4`;
  const variant = item.type === "shot" ? "画面" : item.status === "待尾帧" ? "尾帧" : "首帧";
  return `${prefix}_${variant}_${jobId.slice(-8)}_raw.png`;
}

function fusionStoryboardPanelOutputName(item: WorkItem, panel: FusionStoryboardGridPanel, jobId: string): string {
  const prefix = `EP${String(item.episode ?? 0).padStart(2, "0")}_15s_${String(item.unit ?? 0).padStart(3, "0")}`;
  const role = panel.frameRole === "start" ? "首帧" : panel.frameRole === "end" ? "尾帧" : "中间帧";
  return `${prefix}_宫格${String(panel.index).padStart(2, "0")}_${role}_${jobId.slice(-8)}_raw.png`;
}

function namedReferenceRole(value: string): GenerationReferenceRole {
  if (/服装|衣着|造型|costume/i.test(value)) return "costume";
  if (/场景|环境|宫殿|村落|祭坛|scene/i.test(value)) return "scene";
  if (/风格|色彩|光影|style/i.test(value)) return "style";
  if (/遮罩|蒙版|mask/i.test(value)) return "mask";
  if (/道具|面具|武器|器物|prop/i.test(value)) return "prop";
  if (/角色|人物|阿航|嘟嘟|豆姐|character/i.test(value)) return "character";
  return "style";
}

function artifactReferenceRole(artifact: Artifact): GenerationReferenceRole {
  if (artifact.kind === "video") return "source_video";
  if (artifact.variant === "start") return "first_frame";
  if (artifact.variant === "end") return "last_frame";
  return namedReferenceRole(artifact.path);
}

function buildReferences(hardLocks: HardLock[], artifacts: Artifact[], capabilities: GenerationProviderCapabilities, storyboardRows: StoryboardProductionContract[] = []): GenerationReference[] {
  const roleRank: Record<GenerationReferenceRole, number> = { first_frame: 0, last_frame: 1, reference_board: 5, character: 10, costume: 11, prop: 12, scene: 13, style: 14, mask: 15, source_video: 20 };
  const artifactByPath = new Map(artifacts.map((artifact) => [path.resolve(artifact.path), artifact]));
  const storyboardReferences: GenerationReference[] = storyboardRows
    .flatMap((row) => row.referencePaths)
    .filter((candidate) => /\.(?:png|jpe?g|webp|gif|avif|mp4|mov|m4v|webm)$/i.test(candidate) && !/_labeled\.(?:png|jpe?g|webp|gif|avif)$/i.test(candidate))
    .map((candidate) => {
      const artifact = artifactByPath.get(path.resolve(candidate));
      return artifact
        ? { path: artifact.path, role: artifactReferenceRole(artifact), order: 0, itemId: artifact.itemId, artifactId: artifact.id, sha256: artifact.check.sha256 }
        : { path: candidate, role: /\.(?:mp4|mov|m4v|webm)$/i.test(candidate) ? "source_video" : namedReferenceRole(candidate), order: 0 };
    });
  const references: GenerationReference[] = [
    ...storyboardReferences,
    ...artifacts.map((artifact) => ({ path: artifact.path, role: artifactReferenceRole(artifact), order: 0, itemId: artifact.itemId, artifactId: artifact.id, sha256: artifact.check.sha256 })),
    ...hardLocks.map((lock) => ({ path: lock.path, role: namedReferenceRole(`${lock.name} ${lock.note} ${lock.path}`), order: 0, hardLockId: lock.id })),
  ];
  const unique = new Map<string, GenerationReference>();
  for (const reference of references.sort((a, b) => roleRank[a.role] - roleRank[b.role] || a.path.localeCompare(b.path))) if (!unique.has(reference.path)) unique.set(reference.path, reference);
  const images = [...unique.values()].filter((reference) => reference.role !== "source_video").slice(0, capabilities.maxReferenceImages);
  const videos = [...unique.values()].filter((reference) => reference.role === "source_video").slice(0, capabilities.maxReferenceVideos);
  return [...images, ...videos].map((reference, order) => ({ ...reference, order }));
}

function generationParameters(kind: GenerationKind, references: GenerationReference[], provider: GenerationProvider): NonNullable<GenerationJob["parameters"]> {
  const capabilities = provider.capabilities ?? defaultCapabilities();
  const roles = new Set(references.map((reference) => reference.role));
  const desiredMode = kind === "video"
    ? roles.has("first_frame") && roles.has("last_frame") ? "first_last_frame"
      : roles.has("first_frame") ? "first_frame"
        : roles.has("source_video") ? "video_reference"
          : references.length ? "multi_image" : "text"
    : roles.has("first_frame") ? "first_frame"
      : references.length ? "multi_image" : "text";
  const mode = capabilities.referenceModes.includes(desiredMode) ? desiredMode : capabilities.referenceModes.includes("multi_image") && references.length ? "multi_image" : "text";
  const durationSeconds = kind === "video" ? (capabilities.supportedDurations.includes(15) ? 15 : capabilities.supportedDurations.at(-1)) : undefined;
  return {
    mode,
    durationSeconds,
    aspectRatio: capabilities.supportedAspectRatios.includes("9:16") ? "9:16" : capabilities.supportedAspectRatios[0],
    resolution: capabilities.supportedResolutions.includes("1080p") ? "1080p" : capabilities.supportedResolutions[0],
    imageCount: kind === "image" && provider.adapter === "codex-subagent-imagegen" ? 1 : undefined,
  };
}

function assertFusionImageProvider(provider: GenerationProvider, settings: GenerationSettings): void {
  const capabilities = provider.capabilities ?? defaultCapabilities();
  const issues: string[] = [];
  if (!["codex-browser", "codex-subagent-imagegen"].includes(provider.adapter)) issues.push("adapter 必须为 codex-browser 或 codex-subagent-imagegen");
  if (provider.model !== "GPT Image 2" || !capabilities.models.includes("GPT Image 2")) issues.push("模型必须为 GPT Image 2");
  if (!capabilities.supportedAspectRatios.includes("9:16")) issues.push("必须支持 9:16");
  if (!capabilities.supportedResolutions.includes("Medium")) issues.push("必须支持 Medium");
  if (!capabilities.referenceModes.includes("multi_image")) issues.push("必须支持唯一参考板上传");
  if (capabilities.maxConcurrency !== 1 || settings.concurrency !== 1) issues.push("项目与供应商并发必须为 1");
  if (issues.length) throw new Error(`第三季 Artlist 供应商合同不满足：${issues.join("；")}。`);
}

function referencesForBrowserMode(references: GenerationReference[], mode: NonNullable<GenerationJob["parameters"]>["mode"], capabilities: GenerationProviderCapabilities): GenerationReference[] {
  let selected: GenerationReference[];
  if (!mode || mode === "text") selected = [];
  else if (mode === "first_frame") selected = references.filter((reference) => reference.role === "first_frame").slice(0, 1);
  else if (mode === "last_frame") selected = references.filter((reference) => reference.role === "last_frame").slice(0, 1);
  else if (mode === "first_last_frame") selected = [
    ...references.filter((reference) => reference.role === "first_frame").slice(0, 1),
    ...references.filter((reference) => reference.role === "last_frame").slice(0, 1),
  ];
  else if (mode === "video_reference") selected = references.filter((reference) => reference.role === "source_video").slice(0, capabilities.maxReferenceVideos);
  else selected = references.filter((reference) => reference.role !== "source_video").slice(0, capabilities.maxReferenceImages);
  if (mode === "first_frame" && selected.length !== 1) throw new Error("供应商模式要求首帧，但任务没有可上传的 first_frame 素材。");
  if (mode === "last_frame" && selected.length !== 1) throw new Error("供应商模式要求尾帧，但任务没有可上传的 last_frame 素材。");
  if (mode === "first_last_frame" && (selected.length !== 2 || selected[0]?.role !== "first_frame" || selected[1]?.role !== "last_frame")) throw new Error("供应商模式要求按首帧、尾帧顺序上传，但任务素材不完整。");
  if (mode === "video_reference" && !selected.length) throw new Error("供应商模式要求视频参考，但任务没有可上传的 source_video 素材。");
  return selected.map((reference, order) => ({ ...reference, path: path.resolve(reference.path), order }));
}

async function freezeBrowserUploads(references: GenerationReference[], mode: NonNullable<GenerationJob["parameters"]>["mode"], capabilities: GenerationProviderCapabilities): Promise<GenerationReference[]> {
  return Promise.all(referencesForBrowserMode(references, mode, capabilities).map(async (reference) => {
    await access(reference.path, constants.R_OK);
    const metadata = await stat(reference.path);
    if (!metadata.isFile() || metadata.size <= 0) throw new Error(`网页生成参考素材不是可读取的非空文件：${reference.path}`);
    const sha256 = await sha256File(reference.path);
    if (reference.sha256 && reference.sha256 !== sha256) throw new Error(`网页生成参考素材已偏离入队冻结版本：${reference.path}`);
    return { ...reference, sha256 };
  }));
}

async function validateBrowserUploadEvidence(plan: BrowserGenerationPlan, input: BrowserUploadInput | undefined): Promise<BrowserUploadEvidence> {
  if (!input) throw new Error("进入 uploaded 检查点必须提交结构化 uploadEvidence；text-only 任务也必须显式提交 files=[]，不能省略检查点。");
  const expected = [...plan.allowedUploads].sort((a, b) => a.order - b.order);
  const actual = [...input.files].sort((a, b) => a.order - b.order);
  const observedReferenceThumbnailCount = input.observedReferenceThumbnailCount;
  if (observedReferenceThumbnailCount !== undefined && (!Number.isInteger(observedReferenceThumbnailCount) || observedReferenceThumbnailCount < 0 || observedReferenceThumbnailCount > 100)) {
    throw new Error("observedReferenceThumbnailCount 必须是 0–100 的整数。");
  }
  if (!expected.length && observedReferenceThumbnailCount !== 0) {
    throw new Error("text-only 网页任务必须显式证明上传区当前参考缩略图数量为 0，防止残留参考图进入生成。");
  }
  if (actual.length !== expected.length) throw new Error(`上传证据数量与计划不一致：计划 ${expected.length} 个，实际 ${actual.length} 个。`);
  const paths = new Set<string>();
  const slots = new Set<string>();
  const orders = new Set<number>();
  const files: BrowserUploadEvidence["files"] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const planned = expected[index]!;
    const observed = actual[index]!;
    const observedPath = path.resolve(observed.path);
    const slot = observed.slot.trim();
    if (!slot) throw new Error(`第 ${index + 1} 个上传证据缺少实际槽位名称。`);
    if (paths.has(observedPath) || slots.has(slot) || orders.has(observed.order)) throw new Error("上传证据包含重复路径、槽位或顺序。");
    if (observed.order !== planned.order || observedPath !== path.resolve(planned.path)) throw new Error(`第 ${index + 1} 个上传文件不在计划顺序或白名单中。`);
    if (observed.role !== planned.role) throw new Error(`上传文件 ${observedPath} 的语义角色应为 ${planned.role}，不能登记为 ${observed.role}。`);
    const sha256 = await sha256File(observedPath);
    if (!planned.sha256 || sha256 !== planned.sha256) throw new Error(`上传文件 ${observedPath} 已偏离网页计划冻结版本；请重新建立生成计划。`);
    paths.add(observedPath); slots.add(slot); orders.add(observed.order);
    files.push({ path: observedPath, role: observed.role, order: observed.order, slot, sha256 });
  }
  return { files, observedReferenceThumbnailCount, expectedFileCount: expected.length, uploadRequired: expected.length > 0, confirmedAt: new Date().toISOString() };
}

async function assertBrowserUploadEvidenceForSubmit(plan: BrowserGenerationPlan, evidence: BrowserUploadEvidence | undefined): Promise<void> {
  if (!evidence) throw new Error("提交前必须先完成结构化上传确认；text-only 任务也必须先登记 files=[]。");
  const expected = [...plan.allowedUploads].sort((left, right) => left.order - right.order);
  const actual = [...evidence.files].sort((left, right) => left.order - right.order);
  if (actual.length !== expected.length) throw new Error(`提交前上传证据已与冻结计划不一致：计划 ${expected.length} 个，证据 ${actual.length} 个。`);
  if (!expected.length && evidence.observedReferenceThumbnailCount !== 0) throw new Error("text-only 任务提交前缺少页面零参考缩略图证据，禁止提交。");
  if (evidence.expectedFileCount !== undefined && evidence.expectedFileCount !== expected.length) throw new Error("提交前上传证据的冻结数量已漂移，请重新读取计划并核验 uploaded 检查点。");
  if (evidence.uploadRequired !== undefined && evidence.uploadRequired !== (expected.length > 0)) throw new Error("提交前上传证据的是否需上传标记与冻结计划不一致。");
  for (let index = 0; index < expected.length; index += 1) {
    const planned = expected[index]!;
    const observed = actual[index]!;
    const observedPath = path.resolve(observed.path);
    if (observed.order !== planned.order || observedPath !== path.resolve(planned.path) || observed.role !== planned.role || observed.sha256 !== planned.sha256) {
      throw new Error(`第 ${index + 1} 个上传证据已与冻结网页计划漂移，请回到 uploaded 检查点重新核验。`);
    }
    if (await sha256File(observedPath) !== observed.sha256) throw new Error(`上传文件 ${observedPath} 在提交前已变化，请重新建立网页计划。`);
  }
}

function currentBrowserGenerationSteps(executionSurface?: BrowserExecutionSurfaceIdentity): BrowserGenerationPlan["steps"] {
  const surfaceLabel = executionSurface ? `${executionSurface.id}@${executionSurface.version}` : "未声明的兼容执行面";
  return [
    { id: "execution-surface", action: `只能在冻结执行面 ${surfaceLabel} 上执行。若 executionSurfaceStatus=provider_mismatch，先使用当前供应商配置调用 update_browser_generation_job(status=refresh_plan, expectedSettingsRevision=...)；禁止沿用旧执行面证据。`, checkpoint: "网页计划、执行快照、当前供应商配置与本次预检证据的 executionSurface id/version 完全一致。" },
    { id: "inspect", action: "打开或聚焦网站，确认域名、登录态、页面就绪、生成模式、剩余额度和是否存在付费动作。若登录、页面、模式、额度或付费授权任一不满足，立即调用 update_browser_generation_job(status=preflight_blocked)，提交完整 preflightEvidence（含 executionSurface、blockers 和当前可见 observedGeneration），保持同一 job 等待恢复；不得上传、填词或点击 Generate。只有全部通过时才调用 status=preflight 并提交新的完整 preflightEvidence；付费动作必须同时记录用户授权依据。", checkpoint: "检查未通过时持久化为可恢复 preflight_blocked；全部通过时为 preflight。结构化证据包含 executionSurface、observedHost、loginVerified、pageReady、generationModeVerified、balanceChecked、付费授权状态、blockers 和 observedGeneration。" },
    { id: "upload", action: "只从 allowedUploads 上传，并按 role 放入 character/costume/prop/scene/style/first_frame/last_frame/source_video/mask 对应槽位；路径之外的本地文件一律不上传。若 allowedUploads 为空，必须从当前页面确认参考缩略图数量为 0，并以 uploadEvidence={files:[],observedReferenceThumbnailCount:0} 显式登记 text-only；两种情况都必须调用 update_browser_generation_job(status=uploaded)。", checkpoint: "上传数量、缩略图、语义角色和首尾帧顺序与任务包一致；text-only 则有页面零参考缩略图的结构化证据。任务检查点已持久化为 uploaded。" },
    { id: "prompt", action: "填入 prompt，并按任务类型设置画幅、时长、模型和参考强度。", checkpoint: "提交前复核提示词、模型、画幅、时长、参考文件和输出数量。" },
    { id: "submit-intent", action: "点击网站提交按钮之前，先调用 update_browser_generation_job(status=submit_intent) 持久化本次 clientJobId 和 attempt；只有返回 submission_unknown 新修订后才能点击一次。", checkpoint: "本地已进入 submission_unknown，刷新或崩溃恢复都只允许对账，不会自动重复提交。" },
    { id: "submit", action: "使用已持久化的提交意图只点击一次；记录网站返回的任务 ID 或可识别标题。", checkpoint: "任务已进入网站队列，立即使用当前修订调用 update_browser_generation_job(status=submitted) 并记录 externalTaskId。" },
    { id: "download", action: "等待完成后下载原始结果，不截图代替原文件；优先保存到 isolatedDownloadDirectory，禁止覆盖既有文件。", checkpoint: "隔离下载文件存在且大小非零，调用 update_browser_generation_job(status=downloaded)。" },
    { id: "verify", action: "调用 process_generation_queue 做图片解码/labeled 派生或视频 ffprobe 验收并回写画布。", checkpoint: "任务进入 succeeded 或给出真实失败原因。" },
  ];
}

function browserExecutionSurfaceStatus(settings: GenerationSettings, job: GenerationJob, plan: BrowserGenerationPlan): NonNullable<BrowserGenerationPlan["executionSurfaceStatus"]> {
  const configured = settings.providers.find((candidate) => candidate.id === job.providerId)?.executionSurface;
  const frozen = job.executionSnapshot?.provider.executionSurface;
  if (!plan.executionSurface && !frozen) return configured ? "provider_mismatch" : "legacy_unidentified";
  if (!sameBrowserExecutionSurface(plan.executionSurface, frozen) || !sameBrowserExecutionSurface(plan.executionSurface, configured)) return "provider_mismatch";
  return "current";
}

async function writeBrowserGenerationPlan(projectRoot: string, provider: GenerationProvider, job: GenerationJob): Promise<{ requestPath: string; plan: BrowserGenerationPlan }> {
  const requestPath = path.join(getSidecarPaths(projectRoot).generationRequests, `${job.id}.browser.json`);
  const isolatedDownloadDirectory = path.join(getSidecarPaths(projectRoot).generationDownloads, job.id);
  await mkdir(isolatedDownloadDirectory, { recursive: true });
  const capabilities = provider.capabilities ?? defaultCapabilities();
  const allowedUploads = await freezeBrowserUploads(
    job.references ?? job.referencePaths.map((referencePath, order) => ({ path: referencePath, role: "style" as const, order })),
    job.parameters?.mode,
    capabilities,
  );
  const executionSurface = normalizeBrowserExecutionSurface(provider.executionSurface);
  const visual = panelVisualExecutionIdentity(job);
  const instructions = visual ? FUSION_BROWSER_GENERIC_INSTRUCTIONS : provider.browserInstructions;
  const planBase: Omit<BrowserGenerationPlan, "requestPlanFingerprint"> = {
    schemaVersion: 1,
    jobId: job.id,
    providerId: provider.id,
    providerName: provider.name,
    kind: job.kind,
    siteUrl: provider.siteUrl!,
    executionSurface,
    requiresExistingLogin: true,
    prompt: job.prompt,
    promptSha256: createHash("sha256").update(job.prompt).digest("hex"),
    instructionsSha256: createHash("sha256").update(instructions ?? "").digest("hex"),
    ...(visual ? {
      panelVisualConstraintId: visual.constraintId,
      panelVisualConstraintFingerprint: visual.constraintFingerprint,
      panelVisualModelFingerprint: visual.modelFingerprint,
      panelVisualReviewRulesFingerprint: visual.reviewRulesFingerprint,
    } : {}),
    allowedUploadPaths: allowedUploads.map((reference) => reference.path),
    allowedUploads,
    capabilities,
    parameters: { model: job.model, ...job.parameters },
    executionSnapshotHash: job.executionSnapshot?.snapshotHash,
    workflowHash: job.executionSnapshot?.workflowHash,
    workflow: job.executionSnapshot?.provider.workflow,
    isolatedDownloadDirectory,
    expectedOutputPath: job.expectedOutputPath,
    expectedCompanionPath: job.expectedCompanionPath,
    instructions,
    steps: currentBrowserGenerationSteps(executionSurface),
    safety: { uploadOnlyAllowlistedPaths: true, doNotExposeSecrets: true, doNotOverwriteExistingFiles: true, verifyBeforeSubmit: true, requireSequentialCheckpoints: true, requireStructuredPreflightEvidence: true, requirePaidActionAuthorization: true, persistIntentBeforeSubmit: true, recordExternalTaskId: true },
    createdAt: new Date().toISOString(),
  };
  const plan: BrowserGenerationPlan = { ...planBase, requestPlanFingerprint: sha256Json(planBase) };
  await writeJsonAtomic(requestPath, plan);
  return { requestPath, plan };
}

async function freezeSubagentReferences(job: GenerationJob, provider: GenerationProvider): Promise<GenerationReference[]> {
  const capabilities = provider.capabilities ?? defaultCapabilities();
  const selected = referencesForBrowserMode(
    job.references ?? job.referencePaths.map((referencePath, order) => ({ path: referencePath, role: "style" as const, order })),
    job.parameters?.mode,
    capabilities,
  );
  const frozen: GenerationReference[] = [];
  for (const reference of selected) {
    const referencePath = path.resolve(reference.path);
    const metadata = await lstat(referencePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) throw new Error(`子代理参考素材不是可读取的常规非空文件：${referencePath}`);
    const sha256 = await sha256File(referencePath);
    if (reference.sha256 && reference.sha256 !== sha256) throw new Error(`子代理参考素材已偏离冻结版本：${referencePath}`);
    frozen.push({ ...reference, path: referencePath, sha256 });
  }
  return frozen;
}

async function writeSubagentImageGenerationPlan(projectRoot: string, provider: GenerationProvider, job: GenerationJob): Promise<{ requestPath: string; plan: SubagentImageGenerationPlan }> {
  assertExecutionSnapshot(job);
  if (provider.adapter !== "codex-subagent-imagegen" || job.kind !== "image") throw new Error("只有 codex-subagent-imagegen 图片任务可以建立子代理计划。");
  if (!job.publicationIntentId) throw new Error("子代理任务缺少原 Publication，拒绝建立旁路计划。");
  if (job.parameters?.imageCount !== 1) throw new Error("一图一子代理计划要求冻结 imageCount=1。");
  const allowedReferences = await freezeSubagentReferences(job, provider);
  const snapshot = job.executionSnapshot!;
  const visual = panelVisualExecutionIdentity(job);
  const subagentInstructions = visual ? FUSION_SUBAGENT_GENERIC_INSTRUCTIONS : provider.subagentInstructions;
  const planBase: Omit<SubagentImageGenerationPlan, "requestPlanFingerprint"> = {
    schemaVersion: 1,
    jobId: job.id,
    providerId: provider.id,
    providerName: provider.name,
    kind: "image",
    model: job.model,
    prompt: job.prompt,
    promptSha256: snapshot.promptSha256,
    instructionsSha256: createHash("sha256").update(subagentInstructions ?? "").digest("hex"),
    ...(visual ? {
      panelVisualConstraintId: visual.constraintId,
      panelVisualConstraintFingerprint: visual.constraintFingerprint,
      panelVisualModelFingerprint: visual.modelFingerprint,
      panelVisualReviewRulesFingerprint: visual.reviewRulesFingerprint,
    } : {}),
    parameters: { ...(job.parameters ?? {}) },
    parametersSha256: snapshot.parametersSha256,
    allowedReferences,
    referencesSha256: snapshot.referencesSha256,
    executionSnapshotHash: snapshot.snapshotHash,
    publicationIntentId: job.publicationIntentId,
    publicationBundleId: job.publicationBundleId,
    companionPublicationIntentId: job.companionPublicationIntentId,
    isolatedOutputDirectory: path.join(getSidecarPaths(projectRoot).generationDownloads, job.id),
    expectedOutputPath: job.expectedOutputPath,
    expectedCompanionPath: job.expectedCompanionPath,
    subagentInstructions,
    contract: {
      exactlyOneImage: true,
      oneAgentPerImage: true,
      sequentialOnly: true,
      remoteIdentityRequired: false,
      copyThroughIsolation: true,
      persistCallIntentBeforeModel: true,
      recordCandidateBeforePublication: true,
      rawLabeledBundleRequired: true,
      mainAgentVisualReviewRequired: true,
      publicationAndMechanicalValidationRequired: true,
    },
    currentCheckpoint: job.subagentCheckpoint ? structuredClone(job.subagentCheckpoint) : undefined,
  };
  const plan: SubagentImageGenerationPlan = { ...planBase, requestPlanFingerprint: sha256Json(planBase) };
  await mkdir(plan.isolatedOutputDirectory, { recursive: true });
  const requestPath = path.join(getSidecarPaths(projectRoot).generationRequests, `${job.id}.subagent-imagegen.json`);
  await writeJsonAtomic(requestPath, plan);
  return { requestPath, plan };
}

async function ensureGenerationPublicationBundle(projectRoot: string, job: GenerationJob): Promise<void> {
  if (job.kind !== "image") throw new Error("只有图片生成任务需要 raw/labeled Publication 事务。");
  if (!job.publicationIntentId || !job.publicationReservationToken) throw new Error("图片生成任务缺少 primary Publication。");
  if (job.publicationBundleId) {
    if (!job.companionPublicationIntentId || !job.companionPublicationReservationToken || !job.expectedCompanionPath) throw new Error("图片生成任务已有 bundleId 但 companion Publication 不完整。");
    const [primary, companion] = await Promise.all([
      getPublicationIntent(projectRoot, job.publicationIntentId),
      getPublicationIntent(projectRoot, job.companionPublicationIntentId),
    ]);
    if (!primary || !companion
      || primary.bundleId !== job.publicationBundleId
      || primary.bundleMember !== "primary"
      || companion.bundleId !== job.publicationBundleId
      || companion.bundleMember !== "companion"
      || primary.reservationToken !== job.publicationReservationToken
      || companion.reservationToken !== job.companionPublicationReservationToken
      || path.resolve(primary.targetPath) !== path.resolve(job.expectedOutputPath)
      || path.resolve(companion.targetPath) !== path.resolve(job.expectedCompanionPath)) {
      throw new Error("图片生成任务的 raw/labeled Publication 事务与 Job 不一致。");
    }
    return;
  }
  const companionPath = job.expectedCompanionPath ?? job.expectedOutputPath.replace(/_raw\.png$/iu, "_labeled.png");
  if (companionPath === job.expectedOutputPath) throw new Error("旧图片任务无法从 primary 输出路径确定唯一 labeled companion，拒绝迁移。");
  const bundleId = `generation-bundle-${job.id}`;
  const primary = await getPublicationIntent(projectRoot, job.publicationIntentId);
  if (!primary) throw new Error(`找不到图片生成任务的 primary Publication：${job.publicationIntentId}`);
  const bundle = await extendPublicationToBundle(projectRoot, {
    bundleId,
    idempotencyKey: `generation:${job.id}:pair-migration`,
    primaryIntentId: primary.id,
    primaryReservationToken: job.publicationReservationToken,
    primaryExpectedRevision: primary.revision,
    companionRequestedPath: companionPath,
    note: "P1 迁移：把旧单 raw 预留原子扩展为 raw/labeled 双成员事务；不触发供应商调用。",
  }, "codex");
  job.publicationBundleId = bundleId;
  job.publicationIntentId = bundle.primary.id;
  job.publicationReservationToken = bundle.primary.reservationToken;
  job.expectedOutputPath = bundle.primary.targetPath;
  job.companionPublicationIntentId = bundle.companion.id;
  job.companionPublicationReservationToken = bundle.companion.reservationToken;
  job.expectedCompanionPath = bundle.companion.targetPath;
}

export async function enqueueGeneration(
  projectRoot: string,
  input: {
    itemIds: string[];
    kind: GenerationKind;
    providerId?: string;
    taskId?: string;
    prompt?: string;
    continuation?: { continuationId: string; firstFrameArtifactId?: string };
    fusionStoryboardPanel?: { contractId: string; panelIndex: number };
  },
): Promise<GenerationJob[]> {
  return withProjectLock(projectRoot, "generation", async () => {
  const { assertProductionWorkflowGate, getConfirmedStoryboardContracts, getExistingProductionGateEvidence } = await import("./production.js");
  if (new Set(input.itemIds).size !== input.itemIds.length) throw new Error("同一生成批次不能重复包含同一个生产节点。 ");
  const gateTarget = input.continuation ? "video_continuation" as const : input.kind;
  const useFusionImageGate = input.kind === "image" && !input.continuation && await assertFusionProjectReadable(projectRoot);
  if (!useFusionImageGate) await assertProductionWorkflowGate(projectRoot, gateTarget, input.itemIds);
  const existingProductionBaseline = useFusionImageGate
    ? undefined
    : await getExistingProductionGateEvidence(projectRoot, gateTarget, input.itemIds);
  const index = await getProjectIndex(projectRoot);
  const settings = await getGenerationSettings(projectRoot);
  const providerId = input.providerId ?? (input.kind === "image" ? settings.defaultImageProviderId : settings.defaultVideoProviderId);
  const provider = settings.providers.find((candidate) => candidate.id === providerId && candidate.enabled && candidate.kinds.includes(input.kind));
  if (!provider) throw new Error("没有可用的生成供应商，请先在生成队列设置中配置。");
  if (useFusionImageGate) {
    assertFusionImageProvider(provider, settings);
    assertFusionProviderInstructionsSafe(provider);
  }
  const requested = input.itemIds.map((id) => index.items.find((item) => item.id === id));
  if (requested.some((item) => !item)) throw new Error("生成队列包含无法映射到真实扫描索引的节点。");
  const items = requested.filter((item): item is WorkItem => Boolean(item));
  if (!items.length) throw new Error("没有可加入生成队列的生产节点。");
  let fusionStoryboardContext: {
    contract: FusionStoryboardGridContract;
    panel: FusionStoryboardGridPanel;
    resolution: import("./fusion-panel-references.js").PanelReferenceResolution;
  } | undefined;
  if (input.fusionStoryboardPanel) {
    if (!useFusionImageGate) throw new Error("逐格宫格生图只接受已物化的第三季融合工程。");
    if (input.kind !== "image" || input.continuation || items.length !== 1 || items[0]?.type !== "unit") {
      throw new Error("逐格宫格生图必须且只能绑定一个 15 秒单元图片任务。");
    }
    if (input.taskId) throw new Error("逐格宫格生图使用内容寻址合同，不能复用旧任务包。");
    if (!Number.isInteger(input.fusionStoryboardPanel.panelIndex) || input.fusionStoryboardPanel.panelIndex < 1 || input.fusionStoryboardPanel.panelIndex > 6) {
      throw new Error("宫格序号必须是 1–6 的整数。");
    }
    const { loadCurrentFusionStoryboardGrid } = await import("./fusion-storyboard-production.js");
    const contract = await loadCurrentFusionStoryboardGrid(projectRoot, items[0]!.id, input.fusionStoryboardPanel.contractId);
    const panel = contract.panels.find((candidate) => candidate.index === input.fusionStoryboardPanel!.panelIndex);
    if (!panel) throw new Error(`宫格合同 ${contract.contractId} 不包含第 ${input.fusionStoryboardPanel.panelIndex} 格。`);
    const { assertFusionPanelReferenceResolutionCurrent } = await import("./fusion-panel-references.js");
    const resolution = await assertFusionPanelReferenceResolutionCurrent(projectRoot, contract.contractId, panel.id);
    fusionStoryboardContext = { contract, panel, resolution };
  } else if (useFusionImageGate && input.kind === "image" && items.some((item) => item.type === "unit")) {
    throw new Error("第三季 15 秒单元必须先建立 2–6 格宫格合同，再按格入队；禁止绕过宫格直接生成单一首尾帧。");
  }
  if (input.kind === "video" && items.some((item) => item.type !== "unit")) throw new Error("视频生成队列只接受 15 秒单元。");
  let continuationPack: VideoContinuationPack | undefined;
  let continuationArtifact: Artifact | undefined;
  if (input.continuation) {
    if (input.kind !== "video" || items.length !== 1) throw new Error("末帧续作只能创建单个视频任务。");
    if (!/^continuation-[a-zA-Z0-9_-]{8,120}$/.test(input.continuation.continuationId)) throw new Error("视频续接包 ID 不合法。");
    continuationPack = await readJson<VideoContinuationPack | null>(path.join(getSidecarPaths(projectRoot).editorContinuations, `${input.continuation.continuationId}.json`), null) ?? undefined;
    if (!continuationPack || continuationPack.status !== "ready") throw new Error("视频续接包不存在或已经进入生成流程。");
    if (continuationPack.generationJobId) throw new Error(`视频续接包已绑定生成任务 ${continuationPack.generationJobId}，拒绝重复入队。`);
    if (continuationPack.itemId !== items[0]!.id) throw new Error("视频续接包与目标节点不一致。");
    const continuationArtifactId = input.continuation.firstFrameArtifactId ?? continuationPack.targetFirstFrameArtifactId;
    continuationArtifact = continuationArtifactId
      ? index.artifacts.find((artifact) => artifact.id === continuationArtifactId)
      : index.artifacts.find((artifact) => path.resolve(artifact.path) === path.resolve(continuationPack!.lastFramePath));
    if (!continuationArtifact || continuationArtifact.itemId !== items[0]!.id || !["raw-image", "labeled-image"].includes(continuationArtifact.kind) || continuationArtifact.deprecated || !continuationArtifact.check.ok || !continuationArtifact.check.decodable) throw new Error("续接首帧没有通过真实文件、归属与图像解码校验；请先登记提取帧。 ");
    if (continuationPack.sourceType === "timeline" && continuationPack.targetFirstFrameArtifactId !== continuationArtifact.id) throw new Error("时间线续接包、目标节点与首帧素材不一致。");
    if (path.resolve(continuationPack.lastFramePath) !== path.resolve(continuationArtifact.path)) throw new Error("续接包末帧路径与登记的新首帧版本不一致。");
  } else if (input.kind === "video" && items.some((item) => !["待视频", "待视频验收"].includes(item.status))) {
    throw new Error("只有已通过首尾帧视觉验收的 15 秒单元才能加入普通视频生成队列；末帧续作必须绑定 continuationId，时间线续作优先使用 prepare_timeline_continuation。");
  }
  const allowedImageTypes = useFusionImageGate ? ["unit", "shot", "asset"] : ["unit", "shot"];
  if (input.kind === "image" && items.some((item) => !allowedImageTypes.includes(item.type))) throw new Error(useFusionImageGate ? "第三季图片生成队列只接受资产、15 秒单元或原镜头。" : "图片生成队列只接受 15 秒单元或原镜头。");
  if (new Set(items.map((item) => item.type)).size > 1) throw new Error("同一生成批次不能混合不同类型的生产节点。");
  if (new Set(items.map((item) => item.episode)).size > 1) throw new Error("同一生成批次不能跨集。");
  if (items[0]?.type === "shot" && (items.some((item) => !item.parentId) || new Set(items.map((item) => item.parentId)).size > 1)) throw new Error("原镜头生成批次必须属于同一 15 秒父单元。");
  const batchLimit = input.kind === "video" ? index.project.automation.videoBatchSize : index.project.automation.imageBatchSize;
  if (items.length > batchLimit) throw new Error(`生成批次超过当前项目上限 ${batchLimit}。`);
  const storyboardContracts = useFusionImageGate
    ? { revision: 0, byItemId: new Map<string, StoryboardProductionContract[]>() }
    : await getConfirmedStoryboardContracts(projectRoot, items.map((item) => item.id), gateTarget);
  if (input.taskId) {
    if (useFusionImageGate) throw new Error("第三季融合生图使用逐分镜冻结参考板，不能复用旧任务包合同。 ");
    const task = await readTaskPack(projectRoot, input.taskId);
    if (!task || !["ready", "claimed"].includes(task.status)) throw new Error(`生成任务关联的任务包不存在或不可执行：${input.taskId}`);
    if (task.kind !== input.kind || items.some((item) => !task.itemIds.includes(item.id))) throw new Error("生成任务的类型或节点超出任务包合同边界。");
    for (const item of items) {
      const packedRows = task.itemSnapshots.find((snapshot) => snapshot.id === item.id)?.storyboardRows ?? [];
      const currentRows = storyboardContracts.byItemId.get(item.id) ?? [];
      const signature = (rows: StoryboardProductionContract[]) => rows.map((row) => `${row.storyboardRowId}@${row.storyboardRowRevision}`).sort().join("|");
      if (!packedRows.length || signature(packedRows) !== signature(currentRows)) throw new Error(`节点 ${item.id} 的正式分镜已变化，请重新创建任务包后再生成。`);
    }
  }
  const existing = await listGenerationJobs(projectRoot);
  const purpose: NonNullable<GenerationJob["purpose"]> = continuationPack
    ? continuationPack.sourceType === "timeline" ? "timeline_continuation" : "video_continuation"
    : fusionStoryboardContext ? "fusion_storyboard_panel"
      : useFusionImageGate ? items[0]?.type === "asset" ? "asset" : "fusion_frame"
      : "standard";
  if (useFusionImageGate && purpose !== "asset") await assertFusionAssetConsistencyDownstreamReady(projectRoot);
  const activeStatuses = new Set<GenerationJob["status"]>(["queued", "submitting", "submission_unknown", "waiting_external", "waiting_remote", "generating", "generation_unknown", "candidate_generated"]);
  const existingConflict = existing.find((job) => activeStatuses.has(job.status)
    && job.kind === input.kind
    && items.some((item) => item.id === job.itemId)
    && (fusionStoryboardContext
      ? (job.purpose ?? "standard") !== "fusion_storyboard_panel"
        || job.fusionStoryboardPanel?.contractId !== fusionStoryboardContext.contract.contractId
        || job.fusionStoryboardPanel?.panelId === fusionStoryboardContext.panel.id
      : (job.purpose ?? "standard") === purpose));
  if (existingConflict) throw new Error(`节点 ${existingConflict.itemId} 已有未终结的 ${input.kind} 生成任务 ${existingConflict.id}（${existingConflict.status}）；必须先恢复、取消或完成结构化对账，拒绝创建可能重复付费的新任务。`);
  const created: GenerationJob[] = [];
  const assetConsistencyReservations: string[] = [];
  try {
  for (const item of items) {
    const id = `gen-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const assetConsistency = purpose === "asset"
      ? await reserveFusionAssetConsistencyMembership(projectRoot, [...created, ...existing], id, item.id)
      : undefined;
    if (assetConsistency) assetConsistencyReservations.push(id);
    const baseDirectory = provider.outputRoot === index.project.primaryRoot && item.infoPath
      ? path.join(path.dirname(item.infoPath), "AI画布生成")
      : path.join(provider.outputRoot || index.project.primaryRoot, "AI画布生成");
    await mkdir(baseDirectory, { recursive: true });
    const parent = item.parentId ? index.items.find((candidate) => candidate.id === item.parentId) : undefined;
    const fusionReference = useFusionImageGate
      ? fusionStoryboardContext
        ? await buildFusionStoryboardPanelReferenceBoard(projectRoot, index, item.id, fusionStoryboardContext.contract, fusionStoryboardContext.panel.index)
        : await buildFusionReferenceBoard(projectRoot, index, item.id)
      : undefined;
    if (fusionStoryboardContext) {
      const panelReference = fusionReference as Awaited<ReturnType<typeof buildFusionStoryboardPanelReferenceBoard>>;
      if (panelReference.resolution.resolutionId !== fusionStoryboardContext.resolution.resolutionId
        || panelReference.resolution.resolutionFingerprint !== fusionStoryboardContext.resolution.resolutionFingerprint) {
        throw new Error("逐格参考板与入队上下文使用了不同的 PanelReferenceResolution，拒绝预留 Publication。 ");
      }
    }
    const panelVisualConstraint = fusionStoryboardContext
      ? (fusionReference as Awaited<ReturnType<typeof buildFusionStoryboardPanelReferenceBoard>>).constraint
      : undefined;
    const storyboardRows = fusionReference?.storyboardRows ?? storyboardContracts.byItemId.get(item.id) ?? [];
    const contextArtifactIds = new Set([...item.artifactIds, ...(parent?.artifactIds ?? [])]);
    storyboardRows.flatMap((row) => row.referenceArtifactIds).forEach((artifactId) => contextArtifactIds.add(artifactId));
    const activeArtifacts = index.artifacts.filter((artifact) => contextArtifactIds.has(artifact.id) && artifact.authoritative && !artifact.deprecated);
    if (continuationArtifact?.itemId === item.id && !activeArtifacts.some((artifact) => artifact.id === continuationArtifact!.id)) activeArtifacts.push(continuationArtifact);
    const contextLockIds = new Set([...item.hardLockIds, ...(parent?.hardLockIds ?? [])]);
    const hardLocks = index.project.hardLocks.filter((lock) => contextLockIds.has(lock.id));
    let references = fusionReference?.board.references
      ?? buildReferences(hardLocks, activeArtifacts.filter((artifact) => ["raw-image", "video"].includes(artifact.kind)), provider.capabilities ?? defaultCapabilities(), storyboardRows);
    if (continuationArtifact?.itemId === item.id) {
      references = [
        { path: continuationArtifact.path, role: "first_frame" as const, order: 0, itemId: continuationArtifact.itemId, artifactId: continuationArtifact.id, sha256: continuationArtifact.check.sha256 },
        ...references.filter((reference) => path.resolve(reference.path) !== path.resolve(continuationArtifact!.path)),
      ].map((reference, order) => ({ ...reference, order }));
    }
    // referencePaths 是完整、可审计的分镜合同来源；真正可上传的媒体白名单由
    // BrowserGenerationPlan.allowedUploads 从结构化 references 单独冻结和筛选。
    const referencePaths = [...new Set([
      ...references.map((reference) => reference.path),
      ...(fusionReference?.board.sources.map((source) => source.path) ?? []),
      ...storyboardRows.flatMap((row) => row.referencePaths),
    ])];
    const storyboardPrompt = storyboardRows.map((row) => input.kind === "video"
      ? `镜头 ${row.order}（${row.durationSeconds} 秒，${row.shotSize}，${row.cameraMovement}）：${row.videoPrompt}`
      : item.status === "待尾帧" ? row.endFramePrompt : row.firstFramePrompt).join("\n");
    if (fusionReference && input.prompt?.trim() && input.prompt.trim() !== fusionReference.board.prompt) {
      throw new Error("第三季融合生图提示词已随参考板冻结，拒绝临时覆盖。 ");
    }
    const prompt = fusionReference?.board.prompt ?? (input.prompt?.trim() || storyboardPrompt);
    const parameters = generationParameters(input.kind, references, provider);
    if (fusionReference) {
      parameters.aspectRatio = "9:16";
      parameters.resolution = "Medium";
      parameters.quality = "Medium";
      parameters.imageCount = 1;
    }
    const requestedOutputPath = path.join(baseDirectory, fusionStoryboardContext
      ? fusionStoryboardPanelOutputName(item, fusionStoryboardContext.panel, id)
      : outputName(item, input.kind, id));
    const publicationVariant = fusionStoryboardContext
      ? fusionStoryboardContext.panel.frameRole === "start" ? "start" : fusionStoryboardContext.panel.frameRole === "end" ? "end" : "generic"
      : input.kind === "video" || item.type === "shot" || item.type === "asset" ? "generic" : item.status === "待尾帧" ? "end" : "start";
    const publicationContext = {
      purpose: "generation-output" as const,
      itemId: item.id,
      taskId: input.taskId,
      jobId: id,
      metadata: {
        providerId: provider.id,
        generationKind: input.kind,
        generationPurpose: purpose,
        ...(fusionStoryboardContext ? {
          contractId: fusionStoryboardContext.contract.contractId,
          sourceFingerprint: fusionStoryboardContext.contract.sourceFingerprint,
          productionFingerprint: fusionStoryboardContext.contract.productionFingerprint,
          panelId: fusionStoryboardContext.panel.id,
          panelIndex: fusionStoryboardContext.panel.index,
          panelCount: fusionStoryboardContext.contract.selection.panelCount,
          frameRole: fusionStoryboardContext.panel.frameRole,
          panelReferenceResolutionId: fusionStoryboardContext.resolution.resolutionId,
          panelReferenceResolutionFingerprint: fusionStoryboardContext.resolution.resolutionFingerprint,
          panelVisualConstraintId: panelVisualConstraint?.constraintId,
          panelVisualConstraintFingerprint: panelVisualConstraint?.fingerprint,
          panelVisualModelFingerprint: panelVisualConstraint?.modelFingerprint,
          panelVisualReviewRulesFingerprint: panelVisualConstraint?.reviewRulesFingerprint,
        } : {}),
      },
    };
    let publicationIntent: PublicationIntent;
    let companionPublicationIntent: PublicationIntent | undefined;
    let publicationBundleId: string | undefined;
    if (input.kind === "image" && provider.adapter === "codex-subagent-imagegen") {
      const requestedCompanionPath = requestedOutputPath.replace(/_raw\.png$/iu, "_labeled.png");
      if (requestedCompanionPath === requestedOutputPath) throw new Error("子代理图片输出必须以 _raw.png 结尾，才能建立 raw/labeled 发布事务。");
      publicationBundleId = `generation-bundle-${id}`;
      const bundle = await preflightPublicationBundle(projectRoot, {
        bundleId: publicationBundleId,
        idempotencyKey: `generation:${id}:pair`,
        primaryRequestedPath: requestedOutputPath,
        companionRequestedPath: requestedCompanionPath,
        variant: publicationVariant,
        context: publicationContext,
        note: "子代理候选通过视觉验收后，raw/labeled 才能作为一个不可拆分事务登记。",
      }, "app");
      publicationIntent = bundle.primary;
      companionPublicationIntent = bundle.companion;
    } else {
      publicationIntent = await preflightPublication(projectRoot, {
        idempotencyKey: `generation:${id}:output`,
        requestedPath: requestedOutputPath,
        kind: input.kind === "video" ? "video" : "raw-image",
        variant: publicationVariant,
        context: publicationContext,
        note: "生成任务输出路径预留；成功机械验收后登记发布回执。",
      }, "app");
    }
    const expectedOutputPath = publicationIntent.targetPath;
    created.push({
      schemaVersion: 1,
      id,
      projectId: index.project.id,
      itemId: item.id,
      taskId: input.taskId,
      providerId: provider.id,
      kind: input.kind,
      purpose,
      panelReferenceEvidenceVersion: fusionStoryboardContext ? 1 : undefined,
      panelVisualConstraintEvidenceVersion: fusionStoryboardContext ? 1 : undefined,
      assetConsistencyBatchId: assetConsistency?.batchId,
      fusionAssetContract: assetConsistency ? {
        assetId: assetConsistency.assetId,
        contractId: assetConsistency.contractId,
        sourceSectionSha256: assetConsistency.sourceSectionSha256,
      } : undefined,
      continuationId: continuationPack?.id,
      continuationFirstFrameArtifactId: continuationArtifact?.id,
      existingProductionBaselineId: existingProductionBaseline?.id,
      existingProductionBaselineDigest: existingProductionBaseline?.digest,
      status: "queued",
      prompt,
      referencePaths,
      references,
      fusionReferenceBoard: fusionReference?.board.board ? {
        path: fusionReference.board.board.path,
        metadataPath: fusionReference.board.board.metadataPath,
        sha256: fusionReference.board.board.sha256,
        promptSha256: fusionReference.board.promptSha256,
        sourceAssetIds: fusionReference.board.assetIds,
        panelReferenceResolutionId: fusionStoryboardContext?.resolution.resolutionId,
        panelReferenceResolutionFingerprint: fusionStoryboardContext?.resolution.resolutionFingerprint,
        panelVisualConstraintId: panelVisualConstraint?.constraintId,
        panelVisualConstraintFingerprint: panelVisualConstraint?.fingerprint,
        panelVisualModelFingerprint: panelVisualConstraint?.modelFingerprint,
        panelVisualReviewRulesFingerprint: panelVisualConstraint?.reviewRulesFingerprint,
      } : undefined,
      fusionStoryboardPanel: fusionStoryboardContext ? {
        contractId: fusionStoryboardContext.contract.contractId,
        sourceFingerprint: fusionStoryboardContext.contract.sourceFingerprint,
        panelId: fusionStoryboardContext.panel.id,
        panelIndex: fusionStoryboardContext.panel.index,
        panelCount: fusionStoryboardContext.contract.selection.panelCount,
        frameRole: fusionStoryboardContext.panel.frameRole,
        startSeconds: fusionStoryboardContext.panel.startSeconds,
        endSeconds: fusionStoryboardContext.panel.endSeconds,
        panelReferenceResolutionId: fusionStoryboardContext.resolution.resolutionId,
        panelReferenceResolutionFingerprint: fusionStoryboardContext.resolution.resolutionFingerprint,
        panelVisualConstraintId: panelVisualConstraint!.constraintId,
        panelVisualConstraintFingerprint: panelVisualConstraint!.fingerprint,
        panelVisualModelFingerprint: panelVisualConstraint!.modelFingerprint,
        panelVisualReviewRulesFingerprint: panelVisualConstraint!.reviewRulesFingerprint,
      } : undefined,
      storyboardRevision: fusionReference?.board.storyboardRevision ?? storyboardContracts.revision,
      storyboardRows,
      model: provider.model,
      parameters,
      executionSnapshot: createExecutionSnapshot(provider, prompt, parameters, storyboardRows, references, panelVisualConstraint ? {
        constraintId: panelVisualConstraint.constraintId,
        constraintFingerprint: panelVisualConstraint.fingerprint,
        modelFingerprint: panelVisualConstraint.modelFingerprint,
        reviewRulesFingerprint: panelVisualConstraint.reviewRulesFingerprint,
      } : undefined),
      expectedOutputPath,
      expectedCompanionPath: input.kind === "image" ? companionPublicationIntent?.targetPath ?? expectedOutputPath.replace(/_raw\.png$/i, "_labeled.png") : undefined,
      publicationBundleId,
      publicationIntentId: publicationIntent.id,
      publicationReservationToken: publicationIntent.reservationToken,
      companionPublicationIntentId: companionPublicationIntent?.id,
      companionPublicationReservationToken: companionPublicationIntent?.reservationToken,
      clientJobId: id,
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, [...created, ...existing]);
  if (continuationPack && created[0]) {
    const now = new Date().toISOString();
    continuationPack.generationJobId = created[0].id;
    continuationPack.status = "queued";
    continuationPack.generationStatus = created[0].status;
    continuationPack.revision = Math.max(1, continuationPack.revision || 1) + 1;
    continuationPack.updatedAt = now;
    await writeJsonAtomic(continuationPackPath(projectRoot, continuationPack.id), continuationPack);
    await appendEvent(projectRoot, { actor: "app", type: "editor.video-continuation-enqueued", itemId: continuationPack.itemId, data: { continuationId: continuationPack.id, generationJobId: created[0].id, revision: continuationPack.revision, providerId: created[0].providerId } });
  }
  } catch (error) {
    for (const job of created) await cancelGenerationPublication(projectRoot, job, "生成任务入队失败，释放尚未使用的输出路径。", "app", "user_cancelled_before_submit").catch(() => undefined);
    for (const jobId of assetConsistencyReservations.reverse()) await rollbackFusionAssetConsistencyReservation(projectRoot, jobId).catch(() => undefined);
    throw error;
  }
  await appendEvent(projectRoot, { actor: "user", type: "generation.enqueued", data: { jobIds: created.map((job) => job.id), kind: input.kind, providerId: provider.id, continuationId: continuationPack?.id } });
  if (input.kind === "video") await updateStatusOverridesBatch(projectRoot, items.map((item) => ({ itemId: item.id, status: "视频生成中" as const, note: continuationPack ? `已用${continuationPack.sourceType === "timeline" ? "时间线合成末帧" : "源视频提取末帧"}加入供应商 ${provider.name} 的续作队列` : `已加入供应商 ${provider.name} 的视频生成队列` })), "app");
  return created;
  });
}

export async function enqueueFusionStoryboardPanel(
  projectRoot: string,
  input: { itemId: string; contractId: string; panelIndex: number; providerId?: string },
): Promise<GenerationJob> {
  const jobs = await enqueueGeneration(projectRoot, {
    itemIds: [input.itemId],
    kind: "image",
    providerId: input.providerId,
    fusionStoryboardPanel: { contractId: input.contractId, panelIndex: input.panelIndex },
  });
  if (jobs.length !== 1) throw new Error("逐格宫格生图没有产生唯一任务。");
  return jobs[0]!;
}

function continuationPackPath(projectRoot: string, continuationId: string): string {
  if (!/^continuation-[a-zA-Z0-9_-]{8,120}$/.test(continuationId)) throw new Error("视频续接包 ID 不合法。");
  return path.join(getSidecarPaths(projectRoot).editorContinuations, `${continuationId}.json`);
}

async function syncContinuationPackFromJob(projectRoot: string, job: GenerationJob): Promise<void> {
  if (!job.continuationId) return;
  const filePath = continuationPackPath(projectRoot, job.continuationId);
  const pack = await readJson<VideoContinuationPack | null>(filePath, null);
  if (!pack) throw new Error(`生成任务关联的视频续接包不存在：${job.continuationId}`);
  if (pack.generationJobId && pack.generationJobId !== job.id) throw new Error(`视频续接包已绑定不同生成任务：${pack.generationJobId}`);
  if (pack.itemId !== job.itemId) throw new Error("视频续接包与生成任务目标节点不一致。");
  const now = new Date().toISOString();
  const stage = job.browserCheckpoint?.stage;
  const comfyStage = job.comfyUiCheckpoint?.stage;
  let projectedStatus: VideoContinuationPack["status"] = "queued";
  if (job.status === "succeeded" || stage === "verified" || comfyStage === "verified") projectedStatus = "completed";
  else if (job.status === "failed" || stage === "failed" || comfyStage === "history_failed") projectedStatus = "failed";
  else if (job.status === "cancelled" || stage === "cancelled" || comfyStage === "cancelled") projectedStatus = "cancelled";
  else if (job.status === "submission_unknown" || stage === "submission_unknown" || comfyStage === "submission_unknown") projectedStatus = "submission_unknown";
  else if (stage === "downloaded") projectedStatus = "downloaded";
  else if (stage === "processing" || comfyStage === "running" || comfyStage === "history_succeeded" || comfyStage === "downloading") projectedStatus = "processing";
  else if (stage === "submitted" || comfyStage === "queued" || job.status === "waiting_remote" || (job.status === "waiting_external" && !job.browserCheckpoint)) projectedStatus = "submitted";
  else if (stage === "uploaded") projectedStatus = "uploaded";
  else if (stage === "preflight_blocked") projectedStatus = "preflight_blocked";
  else if (stage === "preflight") projectedStatus = "preflight";
  else if (job.status === "submitting") projectedStatus = "submit_intent";
  if (projectedStatus === "completed" && (!job.resultPath || !job.publicationReceiptId)) throw new Error("续接生成任务已标记成功，但缺少本地结果或发布回执。");
  const previousProjection = JSON.stringify({ status: pack.status, generationJobId: pack.generationJobId, generationStatus: pack.generationStatus, provider: pack.provider, externalTaskId: pack.externalTaskId, outputVideoPath: pack.outputVideoPath, error: pack.error, browserCheckpoint: pack.browserCheckpoint, httpSubmissionCheckpoint: pack.httpSubmissionCheckpoint, comfyUiCheckpoint: pack.comfyUiCheckpoint });
  pack.status = projectedStatus;
  pack.generationJobId = job.id;
  pack.generationStatus = job.status;
  pack.browserCheckpoint = job.browserCheckpoint ? structuredClone(job.browserCheckpoint) : undefined;
  pack.httpSubmissionCheckpoint = job.httpSubmissionCheckpoint ? structuredClone(job.httpSubmissionCheckpoint) : undefined;
  pack.comfyUiCheckpoint = job.comfyUiCheckpoint ? structuredClone(job.comfyUiCheckpoint) : undefined;
  pack.provider = job.providerId;
  pack.externalTaskId = job.externalTaskId;
  pack.outputVideoPath = projectedStatus === "completed" && job.resultPath ? path.resolve(job.resultPath) : undefined;
  pack.error = ["failed", "cancelled", "submission_unknown"].includes(projectedStatus) ? job.error || (projectedStatus === "cancelled" ? "关联生成任务已取消。" : undefined) : undefined;
  if (["submitted", "processing", "downloaded", "completed"].includes(projectedStatus)) pack.submittedAt ??= now;
  if (["completed", "failed", "cancelled"].includes(projectedStatus)) pack.completedAt ??= now;
  else pack.completedAt = undefined;
  const nextProjection = JSON.stringify({ status: pack.status, generationJobId: pack.generationJobId, generationStatus: pack.generationStatus, provider: pack.provider, externalTaskId: pack.externalTaskId, outputVideoPath: pack.outputVideoPath, error: pack.error, browserCheckpoint: pack.browserCheckpoint, httpSubmissionCheckpoint: pack.httpSubmissionCheckpoint, comfyUiCheckpoint: pack.comfyUiCheckpoint });
  if (previousProjection === nextProjection) return;
  pack.revision = Math.max(1, pack.revision || 1) + 1;
  pack.updatedAt = now;
  await writeJsonAtomic(filePath, pack);
  await appendEvent(projectRoot, { actor: "app", type: `editor.video-continuation-projected-${projectedStatus}`, itemId: pack.itemId, data: { continuationId: pack.id, revision: pack.revision, generationJobId: job.id, generationStatus: job.status, checkpointRevision: pack.browserCheckpoint?.revision ?? pack.httpSubmissionCheckpoint?.revision ?? pack.comfyUiCheckpoint?.revision, provider: pack.provider, externalTaskId: pack.externalTaskId, outputVideoPath: pack.outputVideoPath, publicationReceiptId: job.publicationReceiptId, error: pack.error } });
}

async function assertExistingProductionJobEvidence(projectRoot: string, job: GenerationJob): Promise<void> {
  if (!job.existingProductionBaselineId && !job.existingProductionBaselineDigest) return;
  if (!job.existingProductionBaselineId || !job.existingProductionBaselineDigest) throw new Error("GenerationJob 的既有制作包 baseline 身份不完整。");
  const target = job.purpose === "video_continuation" || job.purpose === "timeline_continuation"
    ? "video_continuation" as const
    : job.kind === "image" ? "image" as const : undefined;
  if (!target) throw new Error("GenerationJob 绑定的既有制作包 baseline 不允许普通 video。");
  const { assertExistingProductionBaselineEvidence } = await import("./production.js");
  await assertExistingProductionBaselineEvidence(projectRoot, {
    baselineId: job.existingProductionBaselineId,
    digest: job.existingProductionBaselineDigest,
    itemIds: [job.itemId],
    target,
  });
}

async function assertGenerationPanelVisualConstraintEvidence(projectRoot: string, job: GenerationJob): Promise<void> {
  if (job.purpose !== "fusion_storyboard_panel") return;
  const panel = job.fusionStoryboardPanel;
  if (!panel?.contractId || !panel.panelId) throw new Error("逐格任务缺少宫格身份，无法核验 P3 视觉约束。");
  const { assertFusionPanelVisualConstraintCurrent, loadFusionPanelVisualConstraintStore } = await import("./fusion-visual-constraint-store.js");
  const hasAnyP3Evidence = job.panelVisualConstraintEvidenceVersion !== undefined
    || panel.panelVisualConstraintId !== undefined
    || panel.panelVisualConstraintFingerprint !== undefined
    || panel.panelVisualModelFingerprint !== undefined
    || panel.panelVisualReviewRulesFingerprint !== undefined;
  if (!hasAnyP3Evidence) {
    const store = await loadFusionPanelVisualConstraintStore(projectRoot);
    const legacy = store?.legacyGenerationJobEvidence[job.id];
    if (!legacy) throw new Error("逐格任务缺少 P3 视觉约束身份且不在首次物化冻结的历史旁路中。");
    if (legacy.disposition === "obsolete-terminal-readonly") throw new Error("历史逐格任务属于已淘汰合同的无输出终态，永久禁止映射当前 P3 约束或重新执行。");
    if (legacy.disposition === "superseded-constraint-readonly") throw new Error("历史逐格任务的原 P3 约束已被新上游身份取代；仅保留审计，永久禁止映射当前约束或重新执行。");
    const current = await assertFusionPanelVisualConstraintCurrent(projectRoot, panel.contractId, panel.panelId);
    if (legacy.contractId !== panel.contractId
      || legacy.panelId !== panel.panelId
      || legacy.constraintId !== current.constraintId
      || legacy.constraintFingerprint !== current.fingerprint
      || legacy.modelFingerprint !== current.modelFingerprint
      || legacy.reviewRulesFingerprint !== current.reviewRulesFingerprint) {
      throw new Error("历史逐格任务首次冻结的 P3 视觉约束已失效。");
    }
    return;
  }
  if (job.panelVisualConstraintEvidenceVersion !== 1
    || !panel.panelVisualConstraintId
    || !panel.panelVisualConstraintFingerprint
    || !panel.panelVisualModelFingerprint
    || !panel.panelVisualReviewRulesFingerprint) {
    throw new Error("P3 后的逐格任务缺少完整视觉约束身份。");
  }
  const current = await assertFusionPanelVisualConstraintCurrent(projectRoot, panel.contractId, panel.panelId);
  if (current.unitItemId !== job.itemId
    || current.constraintId !== panel.panelVisualConstraintId
    || current.fingerprint !== panel.panelVisualConstraintFingerprint
    || current.modelFingerprint !== panel.panelVisualModelFingerprint
    || current.reviewRulesFingerprint !== panel.panelVisualReviewRulesFingerprint) {
    throw new Error("逐格任务冻结的 P3 视觉约束已失效；禁止继续调用、下载或 Publication。");
  }
  const board = job.fusionReferenceBoard;
  if (board && (board.panelVisualConstraintId !== panel.panelVisualConstraintId
    || board.panelVisualConstraintFingerprint !== panel.panelVisualConstraintFingerprint
    || board.panelVisualModelFingerprint !== panel.panelVisualModelFingerprint
    || board.panelVisualReviewRulesFingerprint !== panel.panelVisualReviewRulesFingerprint)) {
    throw new Error("逐格任务的参考板与宫格冻结了不同的 P3 视觉约束身份。");
  }
}

async function assertGenerationPanelReferenceEvidence(projectRoot: string, job: GenerationJob): Promise<void> {
  if (job.purpose !== "fusion_storyboard_panel") return;
  await assertGenerationPanelVisualConstraintEvidence(projectRoot, job);
  const panel = job.fusionStoryboardPanel;
  const board = job.fusionReferenceBoard;
  const hasAnyP2Evidence = job.panelReferenceEvidenceVersion !== undefined
    || panel?.panelReferenceResolutionId !== undefined
    || panel?.panelReferenceResolutionFingerprint !== undefined
    || board?.panelReferenceResolutionId !== undefined
    || board?.panelReferenceResolutionFingerprint !== undefined;
  if (!hasAnyP2Evidence) {
    const { assertFusionPanelReferenceResolutionCurrent, loadFusionPanelReferenceStore } = await import("./fusion-panel-references.js");
    const store = await loadFusionPanelReferenceStore(projectRoot);
    if (!store?.legacyGenerationJobIds.includes(job.id)) {
      throw new Error("逐格任务缺少 P2 引用身份且不在首次物化冻结的历史白名单中，拒绝按历史任务降级执行。");
    }
    const frozen = store.legacyGenerationJobEvidence[job.id];
    if (!frozen) throw new Error("历史逐格任务缺少首次 P2 物化冻结的 resolution 证据，拒绝执行。");
    if (frozen.kind === "obsolete-terminal") {
      throw new Error("历史逐格任务属于已淘汰合同的无输出终态，永久禁止映射当前 resolution 或重新执行。");
    }
    if (!panel || panel.contractId !== frozen.contractId || panel.panelId !== frozen.panelId) {
      throw new Error("历史逐格任务当前宫格身份与首次 P2 物化证据不一致，拒绝执行。");
    }
    const current = await assertFusionPanelReferenceResolutionCurrent(projectRoot, frozen.contractId, frozen.panelId);
    if (current.unitItemId !== job.itemId || current.resolutionId !== frozen.resolutionId || current.resolutionFingerprint !== frozen.resolutionFingerprint) {
      throw new Error("历史逐格任务首次冻结的 P2 resolution 已失效；禁止按旧参考继续执行。");
    }
    return;
  }
  if (job.panelReferenceEvidenceVersion !== 1
    || !panel?.contractId
    || !panel.panelId
    || !panel.panelReferenceResolutionId
    || !panel.panelReferenceResolutionFingerprint) {
    throw new Error("P2 后的逐格任务缺少完整 PanelReferenceResolution 身份。");
  }
  const { assertFusionPanelReferenceResolutionCurrent } = await import("./fusion-panel-references.js");
  const current = await assertFusionPanelReferenceResolutionCurrent(projectRoot, panel.contractId, panel.panelId);
  if (current.unitItemId !== job.itemId
    || current.resolutionId !== panel.panelReferenceResolutionId
    || current.resolutionFingerprint !== panel.panelReferenceResolutionFingerprint) {
    throw new Error("逐格任务冻结的引用解析已失效；禁止继续调用、下载或 Publication。");
  }
  if (current.referenceSlots.length > 0 && (!board?.panelReferenceResolutionId || !board.panelReferenceResolutionFingerprint)) {
    throw new Error("P2 宫格存在引用槽，但任务缺少绑定当前 resolution 的冻结参考板。");
  }
  if (board && (board.panelReferenceResolutionId !== panel.panelReferenceResolutionId
    || board.panelReferenceResolutionFingerprint !== panel.panelReferenceResolutionFingerprint)) {
    throw new Error("逐格任务的宫格合同与参考板冻结了不同的 PanelReferenceResolution 身份。");
  }
}

export async function processGenerationQueue(projectRoot: string, options: { jobId?: string } = {}): Promise<GenerationJob[]> {
  return withProjectLock(projectRoot, "generation", async () => {
  const settings = await getGenerationSettings(projectRoot);
  const jobs = await listGenerationJobs(projectRoot);
  if (options.jobId && !jobs.some((job) => job.id === options.jobId)) throw new Error(`找不到要处理的生成任务：${options.jobId}`);
  let discoveredResult = false;
  const succeededVideoItemIds = new Set<string>();
  const failedVideoItemIds = new Set<string>();
  for (const job of jobs) {
    if (options.jobId && job.id !== options.jobId) continue;
    const statusBeforePublicationProjection = job.status;
    const publicationIntent = job.publicationIntentId ? await getPublicationIntent(projectRoot, job.publicationIntentId) : undefined;
    const publicationProjection = await projectGenerationPublicationState(projectRoot, job, publicationIntent);
    if (publicationProjection === "registered") {
      // Publication 投影也会复验已经成功的历史 Job；只有真实恢复出成功终态时
      // 才重新推进节点，避免后续队列轮询把已通过视觉验收的节点降回待验收。
      if (job.kind === "video" && statusBeforePublicationProjection !== "succeeded") succeededVideoItemIds.add(job.itemId);
      continue;
    }
    if (publicationProjection === "failed") {
      if (job.kind === "video" && statusBeforePublicationProjection !== "failed") failedVideoItemIds.add(job.itemId);
      continue;
    }
    if (publicationProjection === "cancelled" || publicationProjection === "conflict") continue;
    if (["succeeded", "failed", "cancelled", "visual_rejected"].includes(job.status)) continue;
    await assertGenerationPanelReferenceEvidence(projectRoot, job);
    if (job.executionSnapshot?.provider.adapter === "codex-subagent-imagegen") {
      const checkpoint = job.subagentCheckpoint;
      if (checkpoint?.schemaVersion === 2
        && checkpoint.stage === "generating"
        && checkpoint.callIntent
        && !checkpoint.output
        && checkpoint.lease
        && !subagentLeaseActive(checkpoint.lease)) {
        const now = new Date().toISOString();
        job.status = "generation_unknown";
        job.error = "模型调用 intent 已持久化，但执行租约过期且没有候选回执；禁止自动重试。";
        job.subagentCheckpoint = {
          ...checkpoint,
          revision: checkpoint.revision + 1,
          stage: "generation_unknown",
          updatedAt: now,
          unknown: {
            code: "call_intent_without_receipt",
            observedAt: now,
            note: job.error,
            previousStage: checkpoint.stage,
            leaseId: checkpoint.lease.leaseId,
            owner: checkpoint.lease.owner,
            callId: checkpoint.callIntent.callId,
            runId: checkpoint.callIntent.runId,
          },
          note: job.error,
        };
        job.updatedAt = now;
        await appendEvent(projectRoot, { actor: "scanner", type: "generation.subagent-call-became-unknown", itemId: job.itemId, data: { jobId: job.id, leaseId: checkpoint.lease.leaseId, owner: checkpoint.lease.owner, callId: checkpoint.callIntent.callId, runId: checkpoint.callIntent.runId, checkpointRevision: job.subagentCheckpoint.revision } });
      }
      if (["generating", "generation_unknown", "candidate_generated"].includes(job.status)) continue;
    }
    try {
      await assertExistingProductionJobEvidence(projectRoot, job);
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      const mayHaveRemoteSideEffect = Boolean(job.externalTaskId)
        || ["submitting", "submission_unknown", "waiting_external", "waiting_remote", "generating", "generation_unknown", "candidate_generated"].includes(job.status)
        || ["submission_unknown", "submitted", "processing", "downloaded"].includes(job.browserCheckpoint?.stage ?? "");
      if (mayHaveRemoteSideEffect) {
        job.status = job.browserCheckpoint?.stage === "submission_unknown" ? "submission_unknown" : "waiting_external";
        job.error = `既有制作包接管证据失效，但远端任务可能已经存在；保持锁定并禁止重提：${job.error}`;
      } else {
        await failGenerationPublication(projectRoot, job, job.error, "app", "local_pre_submit_failure");
      }
      job.updatedAt = new Date().toISOString();
      await appendEvent(projectRoot, { actor: "app", type: "generation.existing-production-evidence-invalid", itemId: job.itemId, data: { jobId: job.id, baselineId: job.existingProductionBaselineId, baselineDigest: job.existingProductionBaselineDigest, status: job.status, reason: job.error } });
      continue;
    }
    let provider: GenerationProvider | undefined;
    try {
      provider = providerForJob(settings, job);
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      const mayHaveRemoteSideEffect = Boolean(job.externalTaskId) || ["submitting", "submission_unknown", "waiting_remote"].includes(job.status) || ["submitted", "processing", "downloaded"].includes(job.browserCheckpoint?.stage ?? "plan_ready");
      job.status = mayHaveRemoteSideEffect ? "submission_unknown" : job.status;
      if (mayHaveRemoteSideEffect) {
        if (job.executionSnapshot?.provider.adapter === "http-json") job.httpSubmissionCheckpoint ??= getHttpGenerationSubmissionCheckpoint({ ...job, status: "submission_unknown" });
        if (job.executionSnapshot?.provider.adapter === "comfyui-local" && job.comfyUiCheckpoint) advanceComfyUiCheckpoint(job, "submission_unknown");
      } else await failGenerationPublication(projectRoot, job, job.error, "app", "local_pre_submit_failure");
      await appendEvent(projectRoot, { actor: "app", type: "generation.execution-snapshot-invalid", itemId: job.itemId, data: { jobId: job.id, status: job.status, reason: job.error } });
      job.updatedAt = new Date().toISOString();
      if (job.kind === "video" && job.status === "failed") failedVideoItemIds.add(job.itemId);
      continue;
    }
    if (job.status === "submitting") {
      const resumablePreparedComfy = provider?.adapter === "comfyui-local"
        && job.comfyUiCheckpoint?.stage === "prepared"
        && !job.comfyUiCheckpoint.postAttemptedAt;
      if (resumablePreparedComfy) {
        job.status = "queued";
        job.error = undefined;
        job.updatedAt = new Date().toISOString();
        await appendEvent(projectRoot, { actor: "app", type: "generation.comfyui-prepared-resumed", itemId: job.itemId, data: { jobId: job.id, providerId: job.providerId, promptId: job.comfyUiCheckpoint?.promptId, attempt: job.submissionIntent?.attempt, reason: "prepared_checkpoint_has_no_post_attempt" } });
      } else if (provider && ["codex-browser", "codex-subagent-imagegen", "folder-bridge", "mock"].includes(provider.adapter)) {
        job.status = "queued";
        job.error = undefined;
        job.updatedAt = new Date().toISOString();
        await appendEvent(projectRoot, { actor: "app", type: "generation.local-submit-resumed", itemId: job.itemId, data: { jobId: job.id, providerId: job.providerId, adapter: provider.adapter, reason: "no_remote_side_effect_before_adapter_handoff" } });
        continue;
      } else {
        job.status = "submission_unknown";
        job.error = "上次远端提交在确认回执前中断；为避免重复计费，必须先按 client_job_id 与供应商对账，不能自动重提。";
        job.updatedAt = new Date().toISOString();
        if (provider?.adapter === "http-json") ensureHttpGenerationSubmissionCheckpoint(job);
        else if (provider?.adapter === "comfyui-local" && job.comfyUiCheckpoint) advanceComfyUiCheckpoint(job, "submission_unknown");
        await appendEvent(projectRoot, { actor: "app", type: "generation.submission-unknown", itemId: job.itemId, data: { jobId: job.id, providerId: job.providerId, reason: "recovered_submitting_state" } });
        continue;
      }
    }
    if (job.status === "submission_unknown") {
      if (provider?.adapter !== "comfyui-local") continue;
      try {
        const completed = await pollComfyUiJob(projectRoot, provider, job, jobs);
        if (completed) {
          await verifyAndRegisterGeneratedResult(projectRoot, job);
          job.status = "succeeded";
          job.error = undefined;
          observeRemote(job, "succeeded", "publish", "ComfyUI 结果已按历史身份完成隔离验收和不可覆盖发布。", { observedStatus: "succeeded" });
          discoveredResult = true;
          if (job.kind === "video") succeededVideoItemIds.add(job.itemId);
          await appendEvent(projectRoot, { actor: "scanner", type: "generation.succeeded", itemId: job.itemId, data: { jobId: job.id, path: job.resultPath, companionPath: job.companionPath, externalTaskId: job.externalTaskId, publicationReceiptId: job.publicationReceiptId } });
        }
      } catch (error) {
        const reconciled = await reconcileRegisteredGeneration(projectRoot, job).catch(() => false);
        if (job.publicationReceiptId || reconciled) {
          job.status = "succeeded";
          job.error = undefined;
        } else if (error instanceof ConfirmedRemoteCancellation) {
          job.error = safeRemoteMessage(error);
          await cancelGenerationPublication(projectRoot, job, job.error, "scanner", "remote_cancel_confirmed", { externalTaskId: job.comfyUiCheckpoint?.promptId, checkpointRevision: job.comfyUiCheckpoint?.revision });
        } else if (error instanceof ConfirmedRemoteFailure) {
          job.error = safeRemoteMessage(error);
          await failGenerationPublication(projectRoot, job, job.error, "scanner", "remote_confirmed_failed", { externalTaskId: job.comfyUiCheckpoint?.promptId, checkpointRevision: job.comfyUiCheckpoint?.revision });
          observeRemote(job, "confirmed_failed", "poll", job.error, { observedStatus: error.observedStatus });
        } else {
          job.status = "submission_unknown";
          job.error = safeRemoteMessage(error);
          observeRemote(job, "retryable_or_unknown", job.remoteObservation?.stage ?? "poll", job.error, { httpStatus: errorHttpStatus(error), nextAction: error instanceof ComfyUiOutputIdentityFailure ? "inspect_remote_task" : undefined });
        }
      }
      job.lastPolledAt = new Date().toISOString();
      job.updatedAt = new Date().toISOString();
      continue;
    }
    if (!provider) {
      job.error = `找不到供应商配置：${job.providerId}`;
      await failGenerationPublication(projectRoot, job, job.error, "app", "local_pre_submit_failure");
      job.updatedAt = new Date().toISOString();
      if (job.kind === "video") failedVideoItemIds.add(job.itemId);
      continue;
    }
    if (job.status === "waiting_remote") {
      try {
        const completed = provider.adapter === "comfyui-local"
          ? await pollComfyUiJob(projectRoot, provider, job, jobs)
          : provider.adapter === "http-json"
            ? await pollHttpJob(projectRoot, provider, job, jobs)
            : (() => { throw new Error(`适配器 ${provider.adapter} 不能进入远端轮询状态。`); })();
        if (completed) {
          await verifyAndRegisterGeneratedResult(projectRoot, job);
          job.status = "succeeded";
          job.error = undefined;
          observeRemote(job, "succeeded", "publish", "远端结果已完成隔离下载、机械验收和不可覆盖发布。", { observedStatus: "succeeded" });
          discoveredResult = true;
          if (job.kind === "video") succeededVideoItemIds.add(job.itemId);
          await appendEvent(projectRoot, { actor: "scanner", type: "generation.succeeded", itemId: job.itemId, data: { jobId: job.id, path: job.resultPath, companionPath: job.companionPath, externalTaskId: job.externalTaskId, publicationReceiptId: job.publicationReceiptId } });
        }
      } catch (error) {
        const reconciled = await reconcileRegisteredGeneration(projectRoot, job).catch(() => false);
        if (job.publicationReceiptId || reconciled) {
          job.status = "succeeded";
          job.error = undefined;
          observeRemote(job, "succeeded", "publish", "已从现有 Publication 回执恢复生成成功状态。", { observedStatus: "succeeded" });
          if (job.kind === "video") succeededVideoItemIds.add(job.itemId);
        } else if (error instanceof ConfirmedRemoteCancellation) {
          job.error = safeRemoteMessage(error);
          await cancelGenerationPublication(projectRoot, job, job.error, "scanner", "remote_cancel_confirmed", { externalTaskId: job.comfyUiCheckpoint?.promptId, checkpointRevision: job.comfyUiCheckpoint?.revision });
        } else if (error instanceof ConfirmedRemoteFailure) {
          job.error = safeRemoteMessage(error);
          await failGenerationPublication(projectRoot, job, job.error, "scanner", "remote_confirmed_failed", { externalTaskId: job.externalTaskId, checkpointRevision: provider.adapter === "comfyui-local" ? job.comfyUiCheckpoint?.revision : undefined });
          observeRemote(job, "confirmed_failed", "poll", job.error, { observedStatus: error.observedStatus });
          if (job.kind === "video") failedVideoItemIds.add(job.itemId);
        } else {
          job.status = "waiting_remote";
          job.error = safeRemoteMessage(error);
          const stage = job.remoteObservation?.stage ?? "poll";
          observeRemote(job, "retryable_or_unknown", stage, job.error, { httpStatus: errorHttpStatus(error), nextAction: error instanceof PublicationOutputConflict ? "inspect_publication" : error instanceof ComfyUiOutputIdentityFailure ? "inspect_remote_task" : undefined });
          await appendEvent(projectRoot, { actor: "scanner", type: "generation.remote-retryable", itemId: job.itemId, data: { jobId: job.id, providerId: job.providerId, externalTaskId: job.externalTaskId, stage, httpStatus: errorHttpStatus(error), nextAction: "process_generation_queue" } });
        }
      }
      job.lastPolledAt = new Date().toISOString();
      job.updatedAt = new Date().toISOString();
      continue;
    }
    if (job.status === "waiting_external") {
      try {
        let isolatedBrowserResult: { size: number; magic: string; sha256: string } | undefined;
        let isolatedSubagentResult: { size: number; magic: string; sha256: string } | undefined;
        if (provider.adapter === "codex-browser") {
          const checkpoint = job.browserCheckpoint;
          const isolatedPath = job.isolatedDownloadPath;
          const checkpointReady = checkpoint?.stage === "downloaded"
            && job.browserState === "downloaded"
            && Boolean(job.externalTaskId?.trim())
            && checkpoint.externalTaskId === job.externalTaskId
            && Boolean(isolatedPath)
            && Boolean(checkpoint.isolatedPath)
            && path.resolve(checkpoint.isolatedPath!) === path.resolve(isolatedPath!);
          if (!checkpointReady) {
            const unexpectedOutput = await stat(job.expectedOutputPath).then((metadata) => metadata.isFile()).catch(() => false);
            if (unexpectedOutput) {
              job.error = "codex-browser 预期输出在 downloaded 检查点与远端/隔离下载身份完成前出现；拒绝旁路验收和 Publication。";
              job.updatedAt = new Date().toISOString();
              await appendEvent(projectRoot, { actor: "scanner", type: "generation.browser-output-bypass-rejected", itemId: job.itemId, data: { jobId: job.id, checkpointStage: checkpoint?.stage, expectedOutputPath: job.expectedOutputPath } });
            }
            continue;
          }
          isolatedBrowserResult = await validateGeneratedResultFile(job, isolatedPath!);
        }
        if (provider.adapter === "codex-subagent-imagegen") {
          const checkpoint = job.subagentCheckpoint;
          const isolatedPath = checkpoint?.output?.isolatedPath;
          const checkpointReady = checkpoint?.schemaVersion === 1
            && checkpoint.stage === "generated"
            && checkpoint.remoteIdentityRequired === false
            && checkpoint.oneImagePerAgent === true
            && Boolean(checkpoint.lease)
            && Boolean(checkpoint.output)
            && checkpoint.output?.leaseId === checkpoint.lease?.leaseId
            && checkpoint.output?.agentTaskName === checkpoint.lease?.agentTaskName
            && Boolean(isolatedPath)
            && Boolean(job.isolatedDownloadPath)
            && path.resolve(isolatedPath!) === path.resolve(job.isolatedDownloadPath!);
          if (!checkpointReady) {
            const unexpectedOutput = await stat(job.expectedOutputPath).then((metadata) => metadata.isFile()).catch(() => false);
            if (unexpectedOutput) {
              job.error = "codex-subagent-imagegen 预期输出在唯一代理租约、generated 检查点与隔离来源证明完成前出现；拒绝旁路验收和 Publication。";
              job.updatedAt = new Date().toISOString();
              await appendEvent(projectRoot, { actor: "scanner", type: "generation.subagent-output-bypass-rejected", itemId: job.itemId, data: { jobId: job.id, checkpointStage: checkpoint?.stage, expectedOutputPath: job.expectedOutputPath } });
            }
            continue;
          }
          isolatedSubagentResult = await validateGeneratedResultFile(job, isolatedPath!);
          if (isolatedSubagentResult.sha256 !== checkpoint!.output!.isolatedSha256 || isolatedSubagentResult.sha256 !== checkpoint!.output!.sourceSha256 || isolatedSubagentResult.size !== checkpoint!.output!.bytes) {
            throw new PublicationOutputConflict("子代理隔离结果与冻结来源证明的 SHA 或体积不一致；拒绝发布。");
          }
        }
        await access(job.expectedOutputPath);
        const metadata = await stat(job.expectedOutputPath);
        if (metadata.size > 0) {
          if (isolatedBrowserResult) {
            const expectedResult = await validateGeneratedResultFile(job, job.expectedOutputPath);
            if (expectedResult.sha256 !== isolatedBrowserResult.sha256 || expectedResult.size !== isolatedBrowserResult.size) {
              throw new PublicationOutputConflict("codex-browser 预期输出与已冻结隔离下载内容不一致；拒绝发布。");
            }
          }
          if (isolatedSubagentResult) {
            const expectedResult = await validateGeneratedResultFile(job, job.expectedOutputPath);
            if (expectedResult.sha256 !== isolatedSubagentResult.sha256 || expectedResult.size !== isolatedSubagentResult.size) {
              throw new PublicationOutputConflict("codex-subagent-imagegen 预期输出与已冻结隔离结果不一致；拒绝发布。");
            }
          }
          job.resultPath = job.expectedOutputPath;
          await verifyAndRegisterGeneratedResult(projectRoot, job);
          job.status = "succeeded";
          if (provider.adapter === "codex-subagent-imagegen" && job.subagentCheckpoint?.stage === "generated") {
            job.subagentCheckpoint = { ...job.subagentCheckpoint, revision: job.subagentCheckpoint.revision + 1, stage: "verified", updatedAt: new Date().toISOString(), note: "机械验收、不可覆盖 Publication 与确定性 labeled 派生均已完成；等待主代理内容绑定视觉 Review。" };
          }
          job.updatedAt = new Date().toISOString();
          discoveredResult = true;
          if (job.kind === "video") succeededVideoItemIds.add(job.itemId);
          await appendEvent(projectRoot, { actor: "scanner", type: "generation.succeeded", itemId: job.itemId, data: { jobId: job.id, path: job.resultPath, companionPath: job.companionPath, publicationReceiptId: job.publicationReceiptId } });
        }
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          // 外部工具尚未把结果写入约定路径，保持等待。
        } else {
          job.error = error instanceof Error ? error.message : String(error);
          if (job.publicationReceiptId) {
            job.status = "succeeded";
            if (job.kind === "video") succeededVideoItemIds.add(job.itemId);
          } else {
            const browserHasPossibleRemoteTask = Boolean(job.externalTaskId) || ["submission_unknown", "submitted", "processing", "downloaded"].includes(job.browserCheckpoint?.stage ?? "");
            if (browserHasPossibleRemoteTask) {
              job.status = job.browserCheckpoint?.stage === "submission_unknown" ? "submission_unknown" : "waiting_external";
              job.error = `外部结果校验失败，但远端任务可能存在；保持锁定：${job.error}`;
            } else await failGenerationPublication(projectRoot, job, job.error, "scanner", "local_execution_failed");
          }
          job.updatedAt = new Date().toISOString();
          if (job.kind === "video" && !job.publicationReceiptId) failedVideoItemIds.add(job.itemId);
        }
      }
      continue;
    }
    if (job.status !== "queued") continue;
    if (provider.adapter === "codex-browser") {
      const configuredExecutionSurface = settings.providers.find((candidate) => candidate.id === provider.id)?.executionSurface;
      if (configuredExecutionSurface && !sameBrowserExecutionSurface(provider.executionSurface, configuredExecutionSurface)) {
        const message = "网页任务执行快照仍绑定旧执行面；禁止建立旧 browser request，请用 status=refresh_plan 刷新同一 job/Publication。";
        if (job.error !== message) {
          job.error = message;
          job.updatedAt = new Date().toISOString();
          await appendEvent(projectRoot, { actor: "app", type: "generation.browser-plan-refresh-required", itemId: job.itemId, data: { jobId: job.id, providerId: provider.id, configuredExecutionSurface, frozenExecutionSurface: provider.executionSurface } });
        }
        continue;
      }
    }
    try {
      await assertFusionAssetJobMaySubmit(projectRoot, job, jobs);
      if (job.purpose === "asset" && job.error?.startsWith("六张一致性门禁：")) job.error = undefined;
    } catch (error) {
      const message = `六张一致性门禁：${error instanceof Error ? error.message : String(error)}`;
      if (job.error !== message) {
        job.error = message;
        job.updatedAt = new Date().toISOString();
        await appendEvent(projectRoot, { actor: "app", type: "generation.asset-consistency-blocked", itemId: job.itemId, data: { jobId: job.id, reason: message } });
      }
      continue;
    }
    const occupiedStatuses = new Set<GenerationJob["status"]>(["submitting", "submission_unknown", "waiting_external", "waiting_remote", "generating", "generation_unknown", "candidate_generated"]);
    const activeJobs = jobs.filter((candidate) => candidate.id !== job.id && occupiedStatuses.has(candidate.status));
    if (activeJobs.length >= settings.concurrency) continue;
    const providerCapacity = Math.max(1, provider.capabilities?.maxConcurrency ?? settings.concurrency);
    if (activeJobs.filter((candidate) => candidate.providerId === provider.id).length >= providerCapacity) continue;
    const resumePreparedComfy = provider.adapter === "comfyui-local"
      && job.comfyUiCheckpoint?.stage === "prepared"
      && !job.comfyUiCheckpoint.postAttemptedAt;
    job.status = "submitting";
    job.updatedAt = new Date().toISOString();
    if (!resumePreparedComfy) {
      job.attempts += 1;
      job.clientJobId ??= job.id;
      job.submissionIntent = { clientJobId: job.clientJobId, attempt: job.attempts, createdAt: job.updatedAt };
    } else {
      const intent = generationSubmissionIntent(job);
      if (intent.attempt !== job.attempts || job.comfyUiCheckpoint?.clientId !== intent.clientJobId) throw new Error("ComfyUI prepared 检查点与原提交意图不一致；拒绝创建新 attempt 或重提。 ");
    }
    if (["http-json", "comfyui-local"].includes(provider.adapter)) observeRemote(job, "pending", "submit", "提交意图已持久化；当前任务最多执行一次 POST。", { nextAction: "inspect_remote_task" });
    if (provider.adapter === "comfyui-local") {
      try {
        await prepareComfyUiSubmission(projectRoot, provider, job);
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error);
        await failGenerationPublication(projectRoot, job, job.error, "app", "local_pre_submit_failure");
        job.updatedAt = new Date().toISOString();
        await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
        continue;
      }
    }
    // 在任何远端或网页副作用之前持久化提交意图。崩溃恢复看到 submitting
    // 时只进入 submission_unknown 对账，不会再次提交同一付费任务。
    await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
    await appendEvent(projectRoot, { actor: "app", type: "generation.submission-intent", itemId: job.itemId, data: { jobId: job.id, providerId: provider.id, clientJobId: job.id, attempt: job.attempts } });
    try {
      if (provider.adapter === "mock") {
        throw new Error("mock 适配器不产生可发布媒体，不能把占位结果标记为生成成功。");
      } else if (provider.adapter === "folder-bridge") {
        const requestPath = path.join(getSidecarPaths(projectRoot).generationRequests, `${job.id}.json`);
        const { publicationReservationToken: _privatePublicationToken, ...externalJob } = job;
        await writeJsonAtomic(requestPath, { job: externalJob, provider, executionSnapshotHash: job.executionSnapshot?.snapshotHash, workflowHash: job.executionSnapshot?.workflowHash, workflow: job.executionSnapshot?.provider.workflow, instructions: "外部生成器读取本文件并将结果写入 expectedOutputPath；不得覆盖已有文件。" });
        job.status = "waiting_external";
        job.requestPath = requestPath;
      } else if (provider.adapter === "codex-browser") {
        const { requestPath, plan } = await writeBrowserGenerationPlan(projectRoot, provider, job);
        const visual = panelVisualExecutionIdentity(job);
        job.status = "waiting_external";
        job.browserState = "plan_ready";
        job.browserCheckpoint = {
          revision: 1,
          stage: "plan_ready",
          updatedAt: new Date().toISOString(),
          executionSurface: plan.executionSurface,
          ...(visual ? {
            panelVisualConstraintId: visual.constraintId,
            panelVisualConstraintFingerprint: visual.constraintFingerprint,
            panelVisualModelFingerprint: visual.modelFingerprint,
            panelVisualReviewRulesFingerprint: visual.reviewRulesFingerprint,
          } : {}),
        };
        job.requestPath = requestPath;
      } else if (provider.adapter === "codex-subagent-imagegen") {
        const now = new Date().toISOString();
        const visual = panelVisualExecutionIdentity(job);
        job.status = "waiting_external";
        job.browserState = undefined;
        job.subagentCheckpoint = {
          schemaVersion: 2,
          revision: 1,
          stage: "plan_ready",
          updatedAt: now,
          remoteIdentityRequired: false,
          oneImagePerAgent: true,
          ...(visual ? {
            panelVisualConstraintId: visual.constraintId,
            panelVisualConstraintFingerprint: visual.constraintFingerprint,
            panelVisualModelFingerprint: visual.modelFingerprint,
            panelVisualReviewRulesFingerprint: visual.reviewRulesFingerprint,
          } : {}),
          note: "计划已冻结；必须先领取唯一代理租约，再且只生成一张图片。",
        };
        const { requestPath } = await writeSubagentImageGenerationPlan(projectRoot, provider, job);
        job.requestPath = requestPath;
      } else if (provider.adapter === "comfyui-local") {
        if (await submitComfyUiJob(projectRoot, provider, job, jobs)) {
          await verifyAndRegisterGeneratedResult(projectRoot, job);
          job.status = "succeeded";
          job.error = undefined;
          observeRemote(job, "succeeded", "publish", "ComfyUI 结果已按历史身份完成隔离验收和不可覆盖发布。", { observedStatus: "succeeded" });
          discoveredResult = true;
          await appendEvent(projectRoot, { actor: "scanner", type: "generation.succeeded", itemId: job.itemId, data: { jobId: job.id, path: job.resultPath, companionPath: job.companionPath, externalTaskId: job.externalTaskId, publicationReceiptId: job.publicationReceiptId } });
        }
      } else if (provider.adapter === "http-json") {
        if (await submitHttpJob(projectRoot, provider, job, jobs)) {
          await verifyAndRegisterGeneratedResult(projectRoot, job);
          job.status = "succeeded";
          job.error = undefined;
          observeRemote(job, "succeeded", "publish", "远端结果已完成隔离下载、机械验收和不可覆盖发布。", { observedStatus: "succeeded" });
          discoveredResult = true;
          if (job.kind === "video") succeededVideoItemIds.add(job.itemId);
          await appendEvent(projectRoot, { actor: "scanner", type: "generation.succeeded", itemId: job.itemId, data: { jobId: job.id, path: job.resultPath, companionPath: job.companionPath, externalTaskId: job.externalTaskId, publicationReceiptId: job.publicationReceiptId } });
        }
      }
    } catch (error) {
      const reconciled = await reconcileRegisteredGeneration(projectRoot, job).catch(() => false);
      if (job.publicationReceiptId || reconciled) {
        job.status = "succeeded";
        job.error = undefined;
        observeRemote(job, "succeeded", "publish", "已从现有 Publication 回执恢复生成成功状态。", { observedStatus: "succeeded" });
        if (job.kind === "video") succeededVideoItemIds.add(job.itemId);
      } else if (provider.adapter === "comfyui-local" && error instanceof ConfirmedRemoteCancellation) {
        job.error = safeRemoteMessage(error);
        await cancelGenerationPublication(projectRoot, job, job.error, "app", "remote_cancel_confirmed", { externalTaskId: job.comfyUiCheckpoint?.promptId, checkpointRevision: job.comfyUiCheckpoint?.revision });
      } else if (["http-json", "comfyui-local"].includes(provider.adapter) && error instanceof ConfirmedRemoteFailure) {
        job.error = safeRemoteMessage(error);
        await failGenerationPublication(projectRoot, job, job.error, "app", "remote_confirmed_failed", { externalTaskId: job.externalTaskId, checkpointRevision: provider.adapter === "comfyui-local" ? job.comfyUiCheckpoint?.revision : undefined });
        observeRemote(job, "confirmed_failed", "submit", job.error, { observedStatus: error.observedStatus });
        if (job.kind === "video") failedVideoItemIds.add(job.itemId);
      } else if (["http-json", "comfyui-local"].includes(provider.adapter) && (job.externalTaskId || job.remoteResultUrl)) {
        job.status = "waiting_remote";
        job.error = safeRemoteMessage(error);
        const stage = job.remoteObservation?.stage ?? "download";
        observeRemote(job, "retryable_or_unknown", stage, job.error, { httpStatus: errorHttpStatus(error), nextAction: error instanceof PublicationOutputConflict ? "inspect_publication" : error instanceof ComfyUiOutputIdentityFailure ? "inspect_remote_task" : undefined });
      } else if (provider.adapter === "comfyui-local" && error instanceof ComfyUiRetryablePreflightFailure && job.comfyUiCheckpoint?.stage === "prepared" && !job.comfyUiCheckpoint.postAttemptedAt) {
        job.status = "submitting";
        job.error = safeRemoteMessage(error);
        observeRemote(job, "retryable_or_unknown", "submit", job.error, { httpStatus: error.httpStatus, nextAction: "retry_same_task" });
        await appendEvent(projectRoot, { actor: "app", type: "generation.comfyui-preflight-retryable", itemId: job.itemId, data: { jobId: job.id, providerId: provider.id, promptId: job.comfyUiCheckpoint.promptId, attempt: job.submissionIntent?.attempt, httpStatus: error.httpStatus, nextAction: "process_generation_queue" } });
      } else {
        const remoteAdapter = provider.adapter === "http-json" || (provider.adapter === "comfyui-local" && Boolean(job.comfyUiCheckpoint?.postAttemptedAt));
        job.error = remoteAdapter ? safeRemoteMessage(error) : error instanceof Error ? error.message : String(error);
        job.status = remoteAdapter ? "submission_unknown" : job.status;
        if (remoteAdapter) observeRemote(job, "retryable_or_unknown", "submit", job.error, { httpStatus: errorHttpStatus(error), nextAction: "inspect_remote_task" });
        if (provider.adapter === "http-json") ensureHttpGenerationSubmissionCheckpoint(job);
        else if (provider.adapter === "comfyui-local" && remoteAdapter && job.comfyUiCheckpoint) advanceComfyUiCheckpoint(job, "submission_unknown");
        else {
          const cause = provider.adapter === "comfyui-local" && job.comfyUiCheckpoint?.stage === "prepared" && !job.comfyUiCheckpoint.postAttemptedAt ? "local_pre_submit_failure" : "local_execution_failed";
          await failGenerationPublication(projectRoot, job, job.error, "app", cause);
          if (job.kind === "video") failedVideoItemIds.add(job.itemId);
        }
      }
    }
    job.updatedAt = new Date().toISOString();
  }
  await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
  for (const job of jobs) await syncContinuationPackFromJob(projectRoot, job);
  for (const itemId of succeededVideoItemIds) failedVideoItemIds.delete(itemId);
  if (succeededVideoItemIds.size || failedVideoItemIds.size) {
    await updateStatusOverridesBatch(projectRoot, [
      ...[...succeededVideoItemIds].map((itemId) => ({ itemId, status: "待视频验收" as const, note: "视频结果已落盘并通过基础解码检查，等待导演视觉验收" })),
      ...[...failedVideoItemIds].map((itemId) => ({ itemId, status: "待视频" as const, note: "视频生成未产生可验收结果，可修复配置后重新生成新版本" })),
    ], "scanner");
  } else if (discoveredResult) await scanAndPersist(projectRoot);
  return jobs;
  });
}

function assertBrowserGenerationPlanIntegrity(plan: BrowserGenerationPlan, job: GenerationJob): void {
  const { requestPlanFingerprint, ...base } = plan;
  const visual = panelVisualExecutionIdentity(job);
  if (visual && (!requestPlanFingerprint || requestPlanFingerprint !== sha256Json(base))) throw new Error("网页生成计划内容摘要不匹配。");
  if (!visual && requestPlanFingerprint && requestPlanFingerprint !== sha256Json(base)) throw new Error("网页生成计划内容摘要不匹配。");
  if (plan.jobId !== job.id
    || plan.providerId !== job.providerId
    || plan.prompt !== job.prompt
    || plan.executionSnapshotHash !== job.executionSnapshot?.snapshotHash
    || path.resolve(plan.expectedOutputPath) !== path.resolve(job.expectedOutputPath)) {
    throw new Error("网页生成计划与当前任务冻结快照不一致。");
  }
  if (visual && (plan.promptSha256 !== createHash("sha256").update(job.prompt).digest("hex")
    || plan.instructionsSha256 !== createHash("sha256").update(plan.instructions ?? "").digest("hex"))) {
    throw new Error("网页生成计划缺少 P3 prompt/instructions 内容身份。");
  }
  if (visual && (plan.panelVisualConstraintId !== visual.constraintId
    || plan.panelVisualConstraintFingerprint !== visual.constraintFingerprint
    || plan.panelVisualModelFingerprint !== visual.modelFingerprint
    || plan.panelVisualReviewRulesFingerprint !== visual.reviewRulesFingerprint
    || plan.instructions !== FUSION_BROWSER_GENERIC_INSTRUCTIONS
    || PROJECT_IDENTITY_INSTRUCTION_PATTERN.test(plan.instructions ?? ""))) {
    throw new Error("网页生成计划没有冻结当前 P3 模型约束身份。");
  }
  const checkpoint = job.browserCheckpoint;
  if (visual && checkpoint && (checkpoint.panelVisualConstraintId !== visual.constraintId
    || checkpoint.panelVisualConstraintFingerprint !== visual.constraintFingerprint
    || checkpoint.panelVisualModelFingerprint !== visual.modelFingerprint
    || checkpoint.panelVisualReviewRulesFingerprint !== visual.reviewRulesFingerprint)) {
    throw new Error("网页生成检查点没有冻结当前 P3 视觉约束身份。");
  }
}

function assertSubagentGenerationPlanIntegrity(plan: SubagentImageGenerationPlan, job: GenerationJob): void {
  const { requestPlanFingerprint, ...base } = plan;
  const visual = panelVisualExecutionIdentity(job);
  if (visual && (!requestPlanFingerprint || requestPlanFingerprint !== sha256Json(base))) throw new Error("子代理生图计划内容摘要不匹配。");
  if (!visual && requestPlanFingerprint && requestPlanFingerprint !== sha256Json(base)) throw new Error("子代理生图计划内容摘要不匹配。");
  if (visual && plan.instructionsSha256 !== createHash("sha256").update(plan.subagentInstructions ?? "").digest("hex")) throw new Error("子代理生图计划执行说明摘要不匹配。");
  if (visual && (plan.panelVisualConstraintId !== visual.constraintId
    || plan.panelVisualConstraintFingerprint !== visual.constraintFingerprint
    || plan.panelVisualModelFingerprint !== visual.modelFingerprint
    || plan.panelVisualReviewRulesFingerprint !== visual.reviewRulesFingerprint
    || plan.subagentInstructions !== FUSION_SUBAGENT_GENERIC_INSTRUCTIONS
    || PROJECT_IDENTITY_INSTRUCTION_PATTERN.test(plan.subagentInstructions))) {
    throw new Error("子代理生图计划泄漏项目级身份或没有冻结当前 P3 模型约束。");
  }
  const checkpoint = job.subagentCheckpoint;
  if (visual && checkpoint && (checkpoint.panelVisualConstraintId !== visual.constraintId
    || checkpoint.panelVisualConstraintFingerprint !== visual.constraintFingerprint
    || checkpoint.panelVisualModelFingerprint !== visual.modelFingerprint
    || checkpoint.panelVisualReviewRulesFingerprint !== visual.reviewRulesFingerprint)) {
    throw new Error("子代理检查点没有冻结当前 P3 视觉约束身份。");
  }
  for (const evidence of [checkpoint?.lease, checkpoint?.callIntent]) {
    if (visual && evidence && (evidence.panelVisualConstraintId !== visual.constraintId
      || evidence.panelVisualConstraintFingerprint !== visual.constraintFingerprint
      || evidence.panelVisualModelFingerprint !== visual.modelFingerprint
      || evidence.panelVisualReviewRulesFingerprint !== visual.reviewRulesFingerprint)) {
      throw new Error("子代理租约或调用意图没有冻结当前 P3 视觉约束身份。");
    }
  }
}

export async function getBrowserGenerationPlan(projectRoot: string, jobId: string): Promise<BrowserGenerationPlan> {
  const job = (await listGenerationJobs(projectRoot)).find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`找不到生成任务：${jobId}`);
  await assertExistingProductionJobEvidence(projectRoot, job);
  if (!["submit_intent", "submission_unknown", "submitted", "processing", "downloaded", "failed"].includes(job.browserCheckpoint?.stage ?? "")) {
    await assertGenerationPanelReferenceEvidence(projectRoot, job);
  }
  assertExecutionSnapshot(job);
  if (!job.requestPath?.endsWith(".browser.json")) throw new Error("该任务不是 codex-browser 网页生成任务，或尚未调用 process_generation_queue 建立操作计划。 ");
  const plan = await readJson<BrowserGenerationPlan | null>(job.requestPath, null);
  if (!plan) throw new Error(`网页生成计划不存在或损坏：${job.requestPath}`);
  assertBrowserGenerationPlanIntegrity(plan, job);
  const settings = await getGenerationSettings(projectRoot);
  const configuredExecutionSurface = settings.providers.find((candidate) => candidate.id === job.providerId)?.executionSurface;
  const executionSurfaceStatus = browserExecutionSurfaceStatus(settings, job, plan);
  const currentCheckpoint = job.browserCheckpoint ? { ...job.browserCheckpoint, revision: Math.max(1, job.browserCheckpoint.revision || 1) } : undefined;
  return { ...plan, configuredExecutionSurface, executionSurfaceStatus, steps: currentBrowserGenerationSteps(plan.executionSurface), currentCheckpoint };
}

export async function getSubagentImageGenerationPlan(projectRoot: string, jobId: string): Promise<SubagentImageGenerationPlan> {
  const job = (await listGenerationJobs(projectRoot)).find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`找不到生成任务：${jobId}`);
  await assertExistingProductionJobEvidence(projectRoot, job);
  if (!job.subagentCheckpoint?.callIntent && !["generation_unknown", "candidate_generated", "generated", "visual_rejected"].includes(job.subagentCheckpoint?.stage ?? "")) {
    await assertGenerationPanelReferenceEvidence(projectRoot, job);
  }
  assertExecutionSnapshot(job);
  if (job.executionSnapshot?.provider.adapter !== "codex-subagent-imagegen" || job.kind !== "image") throw new Error("该任务不是 codex-subagent-imagegen 图片任务。");
  if (!job.requestPath?.endsWith(".subagent-imagegen.json")) throw new Error("子代理生图计划路径不存在。");
  const plan = await readJson<SubagentImageGenerationPlan | null>(job.requestPath, null);
  if (!plan) throw new Error(`子代理生图计划不存在或损坏：${job.requestPath}`);
  if (plan.jobId !== job.id || plan.providerId !== job.providerId || plan.executionSnapshotHash !== job.executionSnapshot.snapshotHash || plan.promptSha256 !== job.executionSnapshot.promptSha256 || plan.parametersSha256 !== job.executionSnapshot.parametersSha256 || plan.referencesSha256 !== job.executionSnapshot.referencesSha256) {
    throw new Error("子代理生图计划与当前任务冻结快照不一致。");
  }
  assertSubagentGenerationPlanIntegrity(plan, job);
  if (path.resolve(plan.expectedOutputPath) !== path.resolve(job.expectedOutputPath) || plan.publicationIntentId !== job.publicationIntentId) throw new Error("子代理生图计划与原 Publication 或输出路径不一致。");
  if (job.publicationBundleId
    && (plan.publicationBundleId !== job.publicationBundleId
      || plan.companionPublicationIntentId !== job.companionPublicationIntentId
      || path.resolve(plan.expectedCompanionPath ?? "") !== path.resolve(job.expectedCompanionPath ?? ""))) {
    throw new Error("子代理生图计划与 raw/labeled Publication 事务不一致。");
  }
  return { ...plan, currentCheckpoint: job.subagentCheckpoint ? structuredClone(job.subagentCheckpoint) : undefined };
}

function normalizedSubagentTaskName(value: string | undefined): string {
  const taskName = value?.trim() ?? "";
  if (!/^\/root(?:\/[a-z0-9][a-z0-9_-]{0,79})+$/u.test(taskName) || taskName.length > 200) throw new Error("子代理 canonical task name 必须是 /root/... 的稳定小写名称。");
  return taskName;
}

function normalizedSubagentOwner(value: string | undefined, agentTaskName: string): string {
  const owner = normalizedSubagentTaskName(value ?? agentTaskName);
  if (owner !== agentTaskName) throw new Error("子代理 owner 必须与 canonical agentTaskName 完全一致。");
  return owner;
}

function normalizedSubagentLeaseSeconds(value: number | undefined): number {
  return Math.max(30, Math.min(3_600, Math.trunc(value ?? 3_600)));
}

function subagentLeaseActive(lease: SubagentImageGenerationCheckpoint["lease"], now = Date.now()): boolean {
  return Boolean(lease?.leaseUntil && Number.isFinite(Date.parse(lease.leaseUntil)) && Date.parse(lease.leaseUntil) > now);
}

function subagentExecutionOccupiesSemaphore(job: GenerationJob): boolean {
  const stage = job.subagentCheckpoint?.stage;
  if (["leased", "generating", "generation_unknown", "candidate_generated", "generated"].includes(stage ?? "")) return true;
  if (["submitting", "submission_unknown", "waiting_remote", "generating", "generation_unknown", "candidate_generated"].includes(job.status)) return true;
  if (job.browserCheckpoint && ["submission_unknown", "submitted", "processing", "downloaded"].includes(job.browserCheckpoint.stage)) return true;
  if (job.comfyUiCheckpoint && ["posting", "submission_unknown", "queued", "running", "history_succeeded", "downloading"].includes(job.comfyUiCheckpoint.stage)) return true;
  return false;
}

function assertSubagentSemaphoreAvailable(jobs: GenerationJob[], current: GenerationJob): void {
  const blocker = jobs.find((candidate) => candidate.id !== current.id && subagentExecutionOccupiesSemaphore(candidate));
  if (blocker) {
    throw new Error(`项目并发 1 门禁：任务 ${blocker.id}（${blocker.status}/${blocker.subagentCheckpoint?.stage ?? "n/a"}）仍占用生成执行信号量。`);
  }
}

function assertSubagentLeaseIdentity(
  checkpoint: SubagentImageGenerationCheckpoint,
  input: { agentTaskName?: string; owner?: string; leaseId?: string; fence?: number },
  options: { allowExpired?: boolean } = {},
): { lease: NonNullable<SubagentImageGenerationCheckpoint["lease"]>; agentTaskName: string; owner: string } {
  const lease = checkpoint.lease;
  if (!lease?.owner || !lease.leaseUntil || !lease.heartbeatAt || !lease.leaseSeconds || !lease.fence) {
    throw new Error("子代理租约是旧协议或字段不完整；必须先迁移/对账，禁止猜测 owner 或调用状态。");
  }
  const agentTaskName = normalizedSubagentTaskName(input.agentTaskName);
  const owner = normalizedSubagentOwner(input.owner, agentTaskName);
  if (input.leaseId?.trim() !== lease.leaseId || agentTaskName !== lease.agentTaskName || owner !== lease.owner || input.fence !== lease.fence) {
    throw new Error("子代理写入与当前 leaseId/owner/fence/canonical task 不一致。");
  }
  if (!options.allowExpired && !subagentLeaseActive(lease)) throw new Error("子代理租约已经过期；禁止续租、开始调用或继续普通写入。");
  return { lease, agentTaskName, owner };
}

async function assertSubagentReferenceFilesStable(plan: SubagentImageGenerationPlan): Promise<void> {
  for (const reference of plan.allowedReferences) {
    const metadata = await lstat(reference.path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`冻结参考不是常规文件：${reference.path}`);
    if (!reference.sha256 || await sha256File(reference.path) !== reference.sha256) throw new Error(`冻结参考内容已漂移：${reference.path}`);
  }
}

async function assertSubagentPublicationReserved(projectRoot: string, job: GenerationJob): Promise<void> {
  if (!job.publicationIntentId || !job.publicationReservationToken) throw new Error("子代理任务缺少 primary Publication 预留。");
  const primary = await getPublicationIntent(projectRoot, job.publicationIntentId);
  if (!primary || primary.status !== "reserved" || primary.reservationToken !== job.publicationReservationToken) throw new Error("子代理任务 primary Publication 不再是匹配的 reserved。");
  if (job.publicationBundleId) {
    if (!job.companionPublicationIntentId || !job.companionPublicationReservationToken) throw new Error("子代理任务缺少 companion Publication 预留。");
    const companion = await getPublicationIntent(projectRoot, job.companionPublicationIntentId);
    if (!companion || companion.status !== "reserved" || companion.reservationToken !== job.companionPublicationReservationToken
      || primary.bundleId !== job.publicationBundleId || primary.bundleMember !== "primary"
      || companion.bundleId !== job.publicationBundleId || companion.bundleMember !== "companion") {
      throw new Error("子代理任务 raw/labeled Publication 事务不再是完整 reserved。");
    }
  }
}

export async function updateSubagentImageGenerationJob(
  projectRoot: string,
  jobId: string,
  input: {
    expectedRevision: number;
    expectedSettingsRevision?: number;
    status: SubagentImageGenerationUpdateStatus;
    targetProviderId?: string;
    agentTaskName?: string;
    owner?: string;
    agentRunId?: string;
    runId?: string;
    callId?: string;
    leaseId?: string;
    fence?: number;
    leaseSeconds?: number;
    generatedPath?: string;
    reviewer?: string;
    reconciliationResult?: "not_invoked" | "candidate_found";
    confirmNoInvocation?: boolean;
    evidenceReference?: string;
    error?: string;
    note?: string;
  },
): Promise<GenerationJob> {
  return withProjectLock(projectRoot, "generation", async () => {
    const jobs = await listGenerationJobs(projectRoot);
    const current = jobs.find((candidate) => candidate.id === jobId);
    if (!current) throw new Error(`找不到生成任务：${jobId}`);
    await assertExistingProductionJobEvidence(projectRoot, current);
    const settings = await getGenerationSettings(projectRoot);

    if (input.status === "migrate_plan") {
      assertExecutionSnapshot(current);
      if (current.purpose === "fusion_storyboard_panel") {
        await assertGenerationPanelReferenceEvidence(projectRoot, current);
      }
      if (current.kind !== "image" || current.parameters?.imageCount !== 1) throw new Error("子代理迁移只接受冻结 imageCount=1 的图片任务。");
      const sourceProvider = providerForJob(settings, current);
      if (sourceProvider?.adapter !== "codex-browser") throw new Error("migrate_plan 只接管尚未产生网页副作用的 codex-browser 任务。");
      const sourceCheckpoint = current.browserCheckpoint;
      const queuedWithoutBrowserSideEffect = current.status === "queued"
        && !sourceCheckpoint
        && current.attempts === 0
        && !current.submissionIntent
        && !current.requestPath
        && !current.browserState;
      const migratableBrowserPlan = Boolean(sourceCheckpoint && ["plan_ready", "preflight_blocked"].includes(sourceCheckpoint.stage));
      if (!queuedWithoutBrowserSideEffect && !migratableBrowserPlan) throw new Error("子代理迁移只允许从无副作用 queued R0、网页 plan_ready 或 preflight_blocked 开始。");
      const sourceRevision = sourceCheckpoint?.revision ?? 0;
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision !== sourceRevision) throw new Error(`源网页检查点修订冲突：期望 ${input.expectedRevision}，当前 ${sourceRevision}。`);
      if (!Number.isInteger(input.expectedSettingsRevision) || input.expectedSettingsRevision !== settings.revision) throw new Error(`子代理迁移必须绑定当前供应商配置修订 ${settings.revision}。`);
      if (current.externalTaskId || current.remoteAcceptedAt || current.remoteResultUrl || current.resultPath || current.publicationReceiptId || current.isolatedDownloadPath || current.subagentCheckpoint) {
        throw new Error("原任务已有远端身份、结果、回执、隔离下载或子代理检查点，禁止迁移。");
      }
      const targetProvider = settings.providers.find((candidate) => candidate.id === input.targetProviderId?.trim() && candidate.enabled);
      if (!targetProvider || targetProvider.adapter !== "codex-subagent-imagegen" || !targetProvider.kinds.includes("image")) throw new Error("找不到可用的 codex-subagent-imagegen 目标供应商。");
      if (!targetProvider.subagentInstructions) throw new Error("子代理供应商必须冻结人物、场景、道具、风格与输出边界说明。");
      assertFusionImageProvider(targetProvider, settings);
      if (current.purpose === "fusion_storyboard_panel") assertFusionProviderInstructionsSafe(targetProvider);
      const publicationIntent = current.publicationIntentId ? await getPublicationIntent(projectRoot, current.publicationIntentId) : undefined;
      if (!publicationIntent || publicationIntent.status !== "reserved") throw new Error("子代理迁移要求原 Publication 仍为 reserved。");
      for (const outputPath of [current.expectedOutputPath, current.expectedCompanionPath].filter((value): value is string => Boolean(value))) {
        if (await access(outputPath, constants.F_OK).then(() => true, () => false)) throw new Error(`子代理迁移前已出现预期输出，拒绝接管：${outputPath}`);
      }
      await ensureGenerationPublicationBundle(projectRoot, current);
      const previousSnapshotHash = current.executionSnapshot?.snapshotHash;
      const migratedFrom: NonNullable<SubagentImageGenerationCheckpoint["migratedFrom"]> = {
        providerId: current.providerId,
        adapter: sourceProvider.adapter,
        executionSnapshotHash: previousSnapshotHash,
        ...(sourceCheckpoint ? { browserCheckpointRevision: sourceCheckpoint.revision, browserCheckpointStage: sourceCheckpoint.stage } : {}),
      };
      current.providerId = targetProvider.id;
      current.model = targetProvider.model;
      current.executionSnapshot = createExecutionSnapshot(targetProvider, current.prompt, current.parameters, current.storyboardRows, current.references ?? [], panelVisualExecutionIdentity(current));
      current.status = "waiting_external";
      current.browserState = undefined;
      current.error = undefined;
      current.subagentCheckpoint = {
        schemaVersion: 2,
        revision: 1,
        stage: "plan_ready",
        updatedAt: new Date().toISOString(),
        remoteIdentityRequired: false,
        oneImagePerAgent: true,
        ...(panelVisualExecutionIdentity(current) ? {
          panelVisualConstraintId: panelVisualExecutionIdentity(current)!.constraintId,
          panelVisualConstraintFingerprint: panelVisualExecutionIdentity(current)!.constraintFingerprint,
          panelVisualModelFingerprint: panelVisualExecutionIdentity(current)!.modelFingerprint,
          panelVisualReviewRulesFingerprint: panelVisualExecutionIdentity(current)!.reviewRulesFingerprint,
        } : {}),
        migratedFrom,
        note: input.note?.trim() || "已迁移到一图一子代理执行面；旧网页检查点只作历史证据，不可复用。",
      };
      const { requestPath } = await writeSubagentImageGenerationPlan(projectRoot, targetProvider, current);
      current.requestPath = requestPath;
      current.updatedAt = current.subagentCheckpoint.updatedAt;
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
      await appendEvent(projectRoot, { actor: "codex", type: "generation.subagent-plan-migrated", itemId: current.itemId, data: { jobId, previousProviderId: migratedFrom.providerId, providerId: targetProvider.id, previousSnapshotHash, executionSnapshotHash: current.executionSnapshot.snapshotHash, sourceCheckpointRevision: sourceRevision, sourceStatus: queuedWithoutBrowserSideEffect ? "queued" : sourceCheckpoint?.stage, publicationIntentId: current.publicationIntentId } });
      return current;
    }

    assertExecutionSnapshot(current);
    const provider = providerForJob(settings, current);
    if (!provider || provider.adapter !== "codex-subagent-imagegen" || current.kind !== "image") throw new Error("该任务不属于 codex-subagent-imagegen 图片执行面。");
    const configuredProvider = settings.providers.find((candidate) => candidate.id === current.providerId);
    if (!configuredProvider || configuredProvider.adapter !== "codex-subagent-imagegen") throw new Error("当前项目已删除或替换子代理供应商；冻结任务只能先做人工恢复。");
    if (current.purpose === "fusion_storyboard_panel") assertFusionProviderInstructionsSafe(configuredProvider);
    const checkpoint = current.subagentCheckpoint;
    if (!checkpoint || ![1, 2].includes(checkpoint.schemaVersion)) throw new Error("子代理任务缺少可验证检查点。");
    if (input.expectedRevision !== checkpoint.revision) throw new Error(`子代理检查点修订冲突：期望 ${input.expectedRevision}，当前 ${checkpoint.revision}。`);
    const nextRevision = checkpoint.revision + 1;
    const now = new Date().toISOString();

    if (input.status === "migrate_execution_state") {
      const legacyLease = checkpoint.lease;
      const legacyProtocol = checkpoint.schemaVersion === 1
        || !legacyLease?.owner
        || !legacyLease.heartbeatAt
        || !legacyLease.leaseUntil
        || !legacyLease.leaseSeconds
        || !legacyLease.fence;
      if (!["leased", "generating"].includes(checkpoint.stage) || checkpoint.output) {
        if (checkpoint.schemaVersion === 2 && checkpoint.stage === "generation_unknown" && checkpoint.unknown) return current;
        throw new Error("执行状态迁移只接受旧协议 leased/generating 且没有候选回执的任务。");
      }
      if (!legacyProtocol && checkpoint.stage === "leased" && !checkpoint.callIntent) throw new Error("完整 v2 预调用租约应使用 release/takeover，不应伪装成未知调用。");
      for (const outputPath of [current.expectedOutputPath, current.expectedCompanionPath].filter((value): value is string => Boolean(value))) {
        if (await pathExists(outputPath)) throw new Error(`旧执行状态迁移前发现正式输出，必须先核对来源：${outputPath}`);
      }
      await ensureGenerationPublicationBundle(projectRoot, current);
      const code = legacyProtocol ? "legacy_leased_without_call_receipt" : "call_intent_without_receipt";
      const note = input.note?.trim()
        || (legacyProtocol
          ? "旧协议已领取子代理租约，但没有模型调用前 intent 与调用后 receipt，无法证明 image_gen 未执行。"
          : "模型调用 intent 已持久化但没有候选回执，调用结果不可归因。");
      current.status = "generation_unknown";
      current.error = note;
      current.subagentCheckpoint = {
        ...checkpoint,
        schemaVersion: 2,
        revision: nextRevision,
        stage: "generation_unknown",
        updatedAt: now,
        unknown: {
          code,
          observedAt: now,
          note,
          previousStage: checkpoint.stage,
          leaseId: legacyLease?.leaseId,
          owner: legacyLease?.owner,
          callId: checkpoint.callIntent?.callId,
          runId: checkpoint.callIntent?.runId,
          evidenceReference: input.evidenceReference?.trim(),
        },
        note,
      };
      current.updatedAt = now;
      const { requestPath } = await writeSubagentImageGenerationPlan(projectRoot, provider, current);
      current.requestPath = requestPath;
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
      await appendEvent(projectRoot, {
        actor: "codex",
        type: "generation.subagent-execution-migrated-unknown",
        itemId: current.itemId,
        data: {
          jobId,
          checkpointRevision: nextRevision,
          previousStage: checkpoint.stage,
          code,
          leaseId: legacyLease?.leaseId,
          publicationIntentId: current.publicationIntentId,
          companionPublicationIntentId: current.companionPublicationIntentId,
          attempts: current.attempts,
          supplierCallPerformed: false,
        },
      });
      return current;
    }

    if (["succeeded", "failed", "cancelled", "visual_rejected"].includes(current.status)) {
      if (input.status === "visual_accept" && current.status === "succeeded" && checkpoint.stage === "verified") return current;
      throw new Error(`子代理任务已经是终态 ${current.status}，拒绝任何迟到租约或候选写入。`);
    }
    const plan = await getSubagentImageGenerationPlan(projectRoot, current.id);

    if (input.status === "claim") {
      if (checkpoint.stage !== "plan_ready" || checkpoint.lease || checkpoint.callIntent || checkpoint.output) throw new Error("该图片已有代理租约、调用意图或结果；禁止为同一图片启动第二个并行代理。");
      assertSubagentSemaphoreAvailable(jobs, current);
      await assertSubagentReferenceFilesStable(plan);
      await assertSubagentPublicationReserved(projectRoot, current);
      for (const outputPath of [current.expectedOutputPath, current.expectedCompanionPath].filter((value): value is string => Boolean(value))) {
        if (await pathExists(outputPath)) throw new Error(`领取前正式输出已经存在，拒绝旁路接纳：${outputPath}`);
      }
      const agentTaskName = normalizedSubagentTaskName(input.agentTaskName);
      const owner = normalizedSubagentOwner(input.owner, agentTaskName);
      const leaseSeconds = normalizedSubagentLeaseSeconds(input.leaseSeconds);
      const leaseId = `subagent-lease-${randomUUID()}`;
      current.subagentCheckpoint = {
        ...checkpoint,
        schemaVersion: 2,
        revision: nextRevision,
        stage: "leased",
        updatedAt: now,
        lease: {
          leaseId,
          agentTaskName,
          owner,
          claimedAt: now,
          heartbeatAt: now,
          leaseUntil: new Date(Date.now() + leaseSeconds * 1_000).toISOString(),
          leaseSeconds,
          fence: nextRevision,
          oneImageOnly: true,
          promptSha256: plan.promptSha256,
          parametersSha256: plan.parametersSha256,
          referencesSha256: plan.referencesSha256,
          executionSnapshotHash: plan.executionSnapshotHash,
          panelVisualConstraintId: plan.panelVisualConstraintId,
          panelVisualConstraintFingerprint: plan.panelVisualConstraintFingerprint,
          panelVisualModelFingerprint: plan.panelVisualModelFingerprint,
          panelVisualReviewRulesFingerprint: plan.panelVisualReviewRulesFingerprint,
        },
        note: input.note?.trim() || "唯一图片代理租约已持久化；只允许该 canonical task 生成一张候选图。",
      };
      current.updatedAt = now;
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
      await appendEvent(projectRoot, { actor: "codex", type: "generation.subagent-lease-claimed", itemId: current.itemId, data: { jobId, leaseId, agentTaskName, owner, fence: nextRevision, leaseUntil: current.subagentCheckpoint.lease?.leaseUntil, checkpointRevision: nextRevision, promptSha256: plan.promptSha256, referencesSha256: plan.referencesSha256 } });
      return current;
    }

    if (input.status === "heartbeat") {
      if (!["leased", "generating"].includes(checkpoint.stage)) throw new Error("只有 leased/generating 的当前 owner 可以续租。");
      const { lease, owner } = assertSubagentLeaseIdentity(checkpoint, input);
      const leaseSeconds = normalizedSubagentLeaseSeconds(input.leaseSeconds ?? lease.leaseSeconds);
      current.subagentCheckpoint = {
        ...checkpoint,
        schemaVersion: 2,
        revision: nextRevision,
        updatedAt: now,
        lease: { ...lease, heartbeatAt: now, leaseUntil: new Date(Date.now() + leaseSeconds * 1_000).toISOString(), leaseSeconds },
        note: input.note?.trim() || checkpoint.note,
      };
      current.updatedAt = now;
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
      await appendEvent(projectRoot, { actor: "codex", type: "generation.subagent-lease-heartbeat", itemId: current.itemId, data: { jobId, leaseId: lease.leaseId, owner, fence: lease.fence, leaseUntil: current.subagentCheckpoint.lease?.leaseUntil, checkpointRevision: nextRevision } });
      return current;
    }

    if (input.status === "release") {
      if (checkpoint.stage !== "leased" || checkpoint.callIntent || checkpoint.output) throw new Error("只有尚未持久化模型调用意图的 leased 任务可以释放。");
      const { lease, owner } = assertSubagentLeaseIdentity(checkpoint, input, { allowExpired: true });
      const reason = input.note?.trim() || "当前 owner 在模型调用前主动释放租约。";
      current.status = "waiting_external";
      current.error = undefined;
      current.subagentCheckpoint = {
        ...checkpoint,
        schemaVersion: 2,
        revision: nextRevision,
        stage: "plan_ready",
        updatedAt: now,
        lease: undefined,
        lastRelease: { leaseId: lease.leaseId, owner, fence: lease.fence, releasedAt: now, reason, outcome: "plan_ready" },
        note: reason,
      };
      current.updatedAt = now;
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
      await appendEvent(projectRoot, { actor: "codex", type: "generation.subagent-lease-released", itemId: current.itemId, data: { jobId, leaseId: lease.leaseId, owner, fence: lease.fence, checkpointRevision: nextRevision, outcome: "plan_ready", reason } });
      return current;
    }

    if (input.status === "takeover") {
      if (checkpoint.stage !== "leased" || checkpoint.callIntent || checkpoint.output || !checkpoint.lease) throw new Error("只有 v2 leased 且尚未进入模型调用的过期租约可以安全接管。");
      const previous = checkpoint.lease;
      if (!previous.owner || !previous.leaseUntil || !previous.heartbeatAt || !previous.leaseSeconds || !previous.fence) throw new Error("旧协议租约不能安全接管，必须迁移到 generation_unknown。");
      if (subagentLeaseActive(previous)) throw new Error(`原 owner 的租约仍有效至 ${previous.leaseUntil}，禁止接管。`);
      assertSubagentSemaphoreAvailable(jobs, current);
      await assertSubagentReferenceFilesStable(plan);
      await assertSubagentPublicationReserved(projectRoot, current);
      const agentTaskName = normalizedSubagentTaskName(input.agentTaskName);
      const owner = normalizedSubagentOwner(input.owner, agentTaskName);
      const leaseSeconds = normalizedSubagentLeaseSeconds(input.leaseSeconds);
      const leaseId = `subagent-lease-${randomUUID()}`;
      const fence = Math.max(previous.fence + 1, nextRevision);
      current.subagentCheckpoint = {
        ...checkpoint,
        schemaVersion: 2,
        revision: nextRevision,
        stage: "leased",
        updatedAt: now,
        lease: {
          leaseId,
          agentTaskName,
          owner,
          claimedAt: now,
          heartbeatAt: now,
          leaseUntil: new Date(Date.now() + leaseSeconds * 1_000).toISOString(),
          leaseSeconds,
          fence,
          takeoverOf: { leaseId: previous.leaseId, owner: previous.owner, agentTaskName: previous.agentTaskName, leaseUntil: previous.leaseUntil },
          oneImageOnly: true,
          promptSha256: plan.promptSha256,
          parametersSha256: plan.parametersSha256,
          referencesSha256: plan.referencesSha256,
          executionSnapshotHash: plan.executionSnapshotHash,
          panelVisualConstraintId: plan.panelVisualConstraintId,
          panelVisualConstraintFingerprint: plan.panelVisualConstraintFingerprint,
          panelVisualModelFingerprint: plan.panelVisualModelFingerprint,
          panelVisualReviewRulesFingerprint: plan.panelVisualReviewRulesFingerprint,
        },
        note: input.note?.trim() || "旧 v2 租约在模型调用前过期；已使用新 fence 安全接管。",
      };
      current.updatedAt = now;
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
      await appendEvent(projectRoot, { actor: "codex", type: "generation.subagent-lease-taken-over", itemId: current.itemId, data: { jobId, previousLeaseId: previous.leaseId, previousOwner: previous.owner, leaseId, owner, fence, leaseUntil: current.subagentCheckpoint.lease?.leaseUntil, checkpointRevision: nextRevision } });
      return current;
    }

    if (input.status === "start_call") {
      if (checkpoint.stage !== "leased" || checkpoint.callIntent || checkpoint.output) throw new Error("只有持有活跃租约且尚未调用模型的任务可以持久化 call intent。");
      const { lease, agentTaskName, owner } = assertSubagentLeaseIdentity(checkpoint, input);
      assertSubagentSemaphoreAvailable(jobs, current);
      await assertSubagentReferenceFilesStable(plan);
      await assertSubagentPublicationReserved(projectRoot, current);
      for (const outputPath of [current.expectedOutputPath, current.expectedCompanionPath].filter((value): value is string => Boolean(value))) {
        if (await pathExists(outputPath)) throw new Error(`模型调用前正式输出已存在，拒绝继续：${outputPath}`);
      }
      const isolatedFiles = await readdir(plan.isolatedOutputDirectory).catch((error) => {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
        throw error;
      });
      if (isolatedFiles.length) throw new Error("模型调用前隔离目录已有未归因文件，必须先人工核对。");
      const runId = (input.runId ?? input.agentRunId)?.trim() ?? "";
      const callId = input.callId?.trim() ?? "";
      if (!stableGenerationId.test(runId) || !stableGenerationId.test(callId)) throw new Error("start_call 必须提供稳定 runId 与 callId。");
      if (current.attempts < 1) {
        current.attempts = 1;
        current.clientJobId ??= current.id;
        current.submissionIntent = { clientJobId: current.clientJobId, attempt: 1, createdAt: now };
      }
      const attempt = current.attempts;
      current.status = "generating";
      current.error = undefined;
      current.subagentCheckpoint = {
        ...checkpoint,
        schemaVersion: 2,
        revision: nextRevision,
        stage: "generating",
        updatedAt: now,
        callIntent: {
          schemaVersion: 1,
          callId,
          runId,
          leaseId: lease.leaseId,
          owner,
          agentTaskName,
          attempt,
          maxCalls: 1,
          promptSha256: plan.promptSha256,
          parametersSha256: plan.parametersSha256,
          referencesSha256: plan.referencesSha256,
          executionSnapshotHash: plan.executionSnapshotHash,
          panelVisualConstraintId: plan.panelVisualConstraintId,
          panelVisualConstraintFingerprint: plan.panelVisualConstraintFingerprint,
          panelVisualModelFingerprint: plan.panelVisualModelFingerprint,
          panelVisualReviewRulesFingerprint: plan.panelVisualReviewRulesFingerprint,
          createdAt: now,
        },
        note: input.note?.trim() || "模型调用意图已在调用前持久化；同一 callId 最多允许一次 image_gen 调用。",
      };
      current.updatedAt = now;
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
      await appendEvent(projectRoot, { actor: "codex", type: "generation.subagent-call-intent", itemId: current.itemId, data: { jobId, leaseId: lease.leaseId, owner, fence: lease.fence, runId, callId, attempt, maxCalls: 1, checkpointRevision: nextRevision, supplierCallPerformed: false } });
      return current;
    }

    if (input.status === "generated") {
      if (checkpoint.stage !== "generating" || !checkpoint.callIntent || checkpoint.output) throw new Error("只有已持久化 call intent 且尚无回执的任务可以登记候选图。");
      const { lease, agentTaskName, owner } = assertSubagentLeaseIdentity(checkpoint, input, { allowExpired: true });
      const runId = (input.runId ?? input.agentRunId)?.trim() ?? "";
      const callId = input.callId?.trim() ?? "";
      if (callId !== checkpoint.callIntent.callId || runId !== checkpoint.callIntent.runId
        || checkpoint.callIntent.leaseId !== lease.leaseId || checkpoint.callIntent.owner !== owner
        || checkpoint.callIntent.agentTaskName !== agentTaskName) {
        throw new Error("候选图回执与已持久化 callId/runId/lease/owner 不一致。");
      }
      const sourcePath = path.resolve(input.generatedPath ?? "");
      if (!input.generatedPath || sourcePath === path.resolve(current.expectedOutputPath) || sourcePath === path.resolve(current.expectedCompanionPath ?? `${current.expectedOutputPath}.labeled`)) throw new Error("子代理候选图不能直接写入正式 raw/labeled 路径。");
      const isolatedDirectory = path.join(getSidecarPaths(projectRoot).generationDownloads, current.id);
      if (isWithin(isolatedDirectory, sourcePath)) throw new Error("候选图必须先位于独立生成位置，再由 Core 复制到隔离目录。");
      const sourceMetadata = await lstat(sourcePath);
      if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) throw new Error("子代理候选图必须是常规文件，不能是目录或符号链接。");
      const sourceInspection = await validateGeneratedResultFile(current, sourcePath);
      if (/\.png$/iu.test(current.expectedOutputPath) && sourceInspection.magic !== "image/png") throw new Error("正式 raw 路径为 PNG，子代理候选图必须提供真实 PNG 文件，禁止仅改扩展名。");
      await mkdir(isolatedDirectory, { recursive: true });
      const extension = sourceInspection.magic === "image/jpeg" ? ".jpg" : sourceInspection.magic === "image/webp" ? ".webp" : ".png";
      const isolatedPath = path.join(isolatedDirectory, `subagent-r${nextRevision}-${sourceInspection.sha256.slice(0, 16)}${extension}`);
      await copyFile(sourcePath, isolatedPath, constants.COPYFILE_EXCL).catch(async (error) => {
        if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await validateGeneratedResultFile(current, isolatedPath);
        if (existing.sha256 !== sourceInspection.sha256 || existing.size !== sourceInspection.size) throw new Error("子代理隔离目标已存在且内容不同，拒绝覆盖。");
      });
      const isolatedInspection = await validateGeneratedResultFile(current, isolatedPath);
      if (isolatedInspection.sha256 !== sourceInspection.sha256 || isolatedInspection.size !== sourceInspection.size) throw new Error("子代理候选图复制到隔离目录后内容漂移。");
      current.isolatedDownloadPath = isolatedPath;
      current.downloadBytes = isolatedInspection.size;
      current.resultSha256 = undefined;
      current.resultMagic = undefined;
      current.status = "candidate_generated";
      current.error = undefined;
      current.subagentCheckpoint = {
        ...checkpoint,
        schemaVersion: 2,
        revision: nextRevision,
        stage: "candidate_generated",
        updatedAt: now,
        output: {
          leaseId: lease.leaseId,
          agentTaskName,
          agentRunId: runId,
          callId,
          owner,
          runId,
          sourcePath,
          sourceSha256: sourceInspection.sha256,
          isolatedPath,
          isolatedSha256: isolatedInspection.sha256,
          bytes: isolatedInspection.size,
          magic: isolatedInspection.magic,
          recordedAt: now,
        },
        note: input.note?.trim() || "调用回执和候选图已在隔离目录持久化；正式 raw/labeled 仍不存在，等待主代理视觉验收。",
      };
      current.updatedAt = now;
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
      await appendEvent(projectRoot, { actor: "codex", type: "generation.subagent-candidate-recorded", itemId: current.itemId, data: { jobId, leaseId: lease.leaseId, owner, fence: lease.fence, agentTaskName, runId, callId, checkpointRevision: nextRevision, sourceSha256: sourceInspection.sha256, isolatedPath, bytes: isolatedInspection.size, formalOutputWritten: false } });
      return current;
    }

    if (input.status === "visual_accept") {
      if (!["candidate_generated", "generated"].includes(checkpoint.stage) || !checkpoint.output || !checkpoint.callIntent) throw new Error("只有具备 call receipt 的隔离候选可以通过视觉验收。");
      const { lease, owner } = assertSubagentLeaseIdentity(checkpoint, input, { allowExpired: true });
      const runId = (input.runId ?? input.agentRunId)?.trim() ?? "";
      const callId = input.callId?.trim() ?? "";
      if (callId !== checkpoint.callIntent.callId || runId !== checkpoint.callIntent.runId
        || checkpoint.output.callId !== callId || checkpoint.output.runId !== runId
        || checkpoint.output.leaseId !== lease.leaseId || checkpoint.output.owner !== owner) {
        throw new Error("视觉验收输入与冻结候选的 call/lease/owner 不一致。");
      }
      const reviewer = normalizedSubagentTaskName(input.reviewer);
      const reviewNote = input.note?.trim() ?? "";
      if (reviewNote.length < 3) throw new Error("视觉通过必须记录人物、场景、道具和风格一致性验收说明。");
      await ensureGenerationPublicationBundle(projectRoot, current);
      const recovered = await reconcileRegisteredGeneration(projectRoot, current).catch(() => false);
      if (!recovered) {
        await assertSubagentPublicationReserved(projectRoot, current);
        const prepared = await prepareIsolatedSubagentBundle(projectRoot, current, checkpoint.output);
        const publishingCheckpoint: SubagentImageGenerationCheckpoint = {
          ...checkpoint,
          schemaVersion: 2,
          revision: nextRevision,
          stage: "candidate_generated",
          updatedAt: now,
          output: {
            ...checkpoint.output,
            isolatedCompanionPath: prepared.companionPath,
            isolatedCompanionSha256: prepared.companion.sha256,
            companionBytes: prepared.companion.size,
            companionMagic: prepared.companion.magic,
          },
          visualReview: { decision: "accepted", reviewedAt: now, reviewer, note: reviewNote, candidateSha256: prepared.raw.sha256 },
          publicationBundle: {
            bundleId: current.publicationBundleId!,
            stage: "publishing",
            rawIntentId: current.publicationIntentId!,
            labeledIntentId: current.companionPublicationIntentId!,
            updatedAt: now,
          },
          note: "视觉验收已通过；正在从隔离候选执行 raw/labeled 不可覆盖事务发布。",
        };
        current.subagentCheckpoint = publishingCheckpoint;
        current.updatedAt = now;
        await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
        await appendEvent(projectRoot, { actor: "codex", type: "generation.subagent-candidate-accepted", itemId: current.itemId, data: { jobId, callId, runId, leaseId: lease.leaseId, owner, candidateSha256: prepared.raw.sha256, companionSha256: prepared.companion.sha256, checkpointRevision: nextRevision, reviewer } });
        await publishIsolatedSubagentBundle(current, prepared);
        current.resultPath = current.expectedOutputPath;
        current.companionPath = current.expectedCompanionPath;
        current.resultSha256 = prepared.raw.sha256;
        current.resultMagic = prepared.raw.magic;
        await verifyAndRegisterGeneratedResult(projectRoot, current);
      }
      const completedAt = new Date().toISOString();
      const baseCheckpoint = current.subagentCheckpoint ?? checkpoint;
      current.status = "succeeded";
      current.error = undefined;
      current.subagentCheckpoint = {
        ...baseCheckpoint,
        schemaVersion: 2,
        revision: Math.max(baseCheckpoint.revision + 1, nextRevision + 1),
        stage: "verified",
        updatedAt: completedAt,
        visualReview: baseCheckpoint.visualReview ?? { decision: "accepted", reviewedAt: completedAt, reviewer, note: reviewNote, candidateSha256: checkpoint.output.isolatedSha256 },
        publicationBundle: {
          bundleId: current.publicationBundleId!,
          stage: "registered",
          rawIntentId: current.publicationIntentId!,
          labeledIntentId: current.companionPublicationIntentId!,
          rawReceiptId: current.publicationReceiptId,
          labeledReceiptId: current.companionPublicationReceiptId,
          updatedAt: completedAt,
        },
        note: "视觉验收、raw/labeled 不可覆盖提升、双回执原子注册与机械复核均已完成。",
      };
      current.updatedAt = completedAt;
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
      await appendEvent(projectRoot, { actor: "codex", type: "generation.subagent-bundle-verified", itemId: current.itemId, data: { jobId, callId, runId, leaseId: lease.leaseId, owner, publicationBundleId: current.publicationBundleId, publicationReceiptId: current.publicationReceiptId, companionPublicationReceiptId: current.companionPublicationReceiptId, checkpointRevision: current.subagentCheckpoint.revision } });
      await scanAndPersist(projectRoot);
      return current;
    }

    if (input.status === "visual_rejected") {
      if (!["candidate_generated", "generated"].includes(checkpoint.stage) || !checkpoint.output || !checkpoint.callIntent || checkpoint.publicationBundle?.stage === "publishing") {
        throw new Error("只有尚未开始正式发布的隔离候选可以登记视觉返工。");
      }
      const { lease, owner } = assertSubagentLeaseIdentity(checkpoint, input, { allowExpired: true });
      const runId = (input.runId ?? input.agentRunId)?.trim() ?? "";
      const callId = input.callId?.trim() ?? "";
      if (callId !== checkpoint.callIntent.callId || runId !== checkpoint.callIntent.runId || checkpoint.output.callId !== callId || checkpoint.output.runId !== runId) {
        throw new Error("视觉返工输入与冻结候选 call receipt 不一致。");
      }
      const reviewer = normalizedSubagentTaskName(input.reviewer);
      const reason = input.note?.trim() || input.error?.trim() || "";
      if (reason.length < 3) throw new Error("视觉返工必须记录具体一致性失败原因。");
      current.subagentCheckpoint = {
        ...checkpoint,
        schemaVersion: 2,
        revision: nextRevision,
        stage: "visual_rejected",
        updatedAt: now,
        visualReview: { decision: "rejected", reviewedAt: now, reviewer, note: reason, candidateSha256: checkpoint.output.isolatedSha256 },
        note: reason,
      };
      await failGenerationPublication(projectRoot, current, reason, "codex", "visual_rejected", { checkpointRevision: nextRevision });
      current.status = "visual_rejected";
      current.error = reason;
      current.updatedAt = now;
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
      await appendEvent(projectRoot, { actor: "codex", type: "generation.subagent-visual-rejected", itemId: current.itemId, data: { jobId, callId, runId, leaseId: lease.leaseId, owner, candidateSha256: checkpoint.output.isolatedSha256, checkpointRevision: nextRevision, reviewer, reason } });
      return current;
    }

    if (input.status === "reconcile_unknown") {
      if (checkpoint.stage !== "generation_unknown" || current.status !== "generation_unknown" || checkpoint.output) throw new Error("只有没有候选回执的 generation_unknown 可以对账。");
      if (input.reconciliationResult !== "not_invoked" || input.confirmNoInvocation !== true) throw new Error("当前只允许用明确 confirmNoInvocation=true 的 not_invoked 证据解除未知调用锁。");
      const evidenceReference = input.evidenceReference?.trim() ?? "";
      const note = input.note?.trim() ?? "";
      if (!stableGenerationId.test(evidenceReference) || note.length < 8) throw new Error("未知调用对账必须提供稳定 evidenceReference 和充分说明。");
      for (const outputPath of [current.expectedOutputPath, current.expectedCompanionPath, current.isolatedDownloadPath].filter((value): value is string => Boolean(value))) {
        if (await pathExists(outputPath)) throw new Error(`未知调用对账发现现存候选或正式文件，不能声明 not_invoked：${outputPath}`);
      }
      const previousLease = checkpoint.lease;
      current.status = "waiting_external";
      current.error = undefined;
      current.subagentCheckpoint = {
        ...checkpoint,
        schemaVersion: 2,
        revision: nextRevision,
        stage: "plan_ready",
        updatedAt: now,
        lease: undefined,
        callIntent: undefined,
        unknown: undefined,
        reconciliation: { result: "not_invoked", evidenceReference, note, checkedAt: now },
        lastRelease: previousLease?.owner ? { leaseId: previousLease.leaseId, owner: previousLease.owner, fence: previousLease.fence, releasedAt: now, reason: note, outcome: "plan_ready" } : checkpoint.lastRelease,
        note: "结构化证据确认旧执行未调用模型；同一 Job/Publication 已恢复为 plan_ready。",
      };
      current.updatedAt = now;
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
      await appendEvent(projectRoot, { actor: "codex", type: "generation.subagent-unknown-reconciled-not-invoked", itemId: current.itemId, data: { jobId, evidenceReference, checkpointRevision: nextRevision, previousLeaseId: previousLease?.leaseId, previousCallId: checkpoint.callIntent?.callId, retryAllowed: true } });
      return current;
    }

    if (input.status === "failed") {
      if (checkpoint.stage !== "plan_ready" || checkpoint.lease || checkpoint.callIntent || checkpoint.output) throw new Error("只有尚未领取租约、未调用模型的 plan_ready 任务可以登记本地预提交失败。");
      const reason = input.error?.trim() || input.note?.trim();
      if (!reason || reason.length < 3) throw new Error("登记子代理失败必须提供真实原因。");
      if (current.attempts < 1) {
        current.attempts = 1;
        current.clientJobId ??= current.id;
        current.submissionIntent = { clientJobId: current.clientJobId, attempt: 1, createdAt: now };
      }
      current.subagentCheckpoint = { ...checkpoint, schemaVersion: 2, revision: nextRevision, stage: "failed", updatedAt: now, note: reason };
      await failGenerationPublication(projectRoot, current, reason, "codex", "local_pre_submit_failure", { checkpointRevision: nextRevision });
      current.updatedAt = now;
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
      await appendEvent(projectRoot, { actor: "codex", type: "generation.subagent-failed", itemId: current.itemId, data: { jobId, checkpointRevision: nextRevision, reason } });
      return current;
    }

    throw new Error(`不支持的子代理状态：${input.status}`);
  });
}

export async function migrateGenerationExecutionState(
  projectRoot: string,
  input: { jobId: string; expectedRevision: number; evidenceReference?: string; note?: string },
): Promise<GenerationJob> {
  return updateSubagentImageGenerationJob(projectRoot, input.jobId, {
    expectedRevision: input.expectedRevision,
    status: "migrate_execution_state",
    evidenceReference: input.evidenceReference,
    note: input.note,
  });
}

const browserPreflightBlockerSet = new Set<string>(BROWSER_PREFLIGHT_BLOCKER_CODES);

function boundedBrowserText(value: string | undefined, field: string, maximum: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maximum) throw new Error(`${field} 超过 ${maximum} 字符。`);
  return trimmed;
}

function normalizeBrowserPreflightEvidence(input: BrowserPreflightInput, checkedAt: string): BrowserPreflightEvidence {
  const blockers = [...new Set(input.blockers ?? [])];
  if (blockers.length > BROWSER_PREFLIGHT_BLOCKER_CODES.length || blockers.some((code) => !browserPreflightBlockerSet.has(code))) {
    throw new Error("网页预检包含未知阻塞代码。");
  }
  const observedGeneration = input.observedGeneration ? {
    model: boundedBrowserText(input.observedGeneration.model, "observedGeneration.model", 500),
    aspectRatio: boundedBrowserText(input.observedGeneration.aspectRatio, "observedGeneration.aspectRatio", 100),
    resolution: boundedBrowserText(input.observedGeneration.resolution, "observedGeneration.resolution", 100),
    imageCount: input.observedGeneration.imageCount,
    generateEnabled: input.observedGeneration.generateEnabled,
    creditMessage: boundedBrowserText(input.observedGeneration.creditMessage, "observedGeneration.creditMessage", 2_000),
  } : undefined;
  if (observedGeneration?.imageCount !== undefined && (!Number.isInteger(observedGeneration.imageCount) || observedGeneration.imageCount < 1 || observedGeneration.imageCount > 100)) {
    throw new Error("observedGeneration.imageCount 必须是 1–100 的整数。");
  }
  return {
    ...input,
    executionSurface: normalizeBrowserExecutionSurface(input.executionSurface),
    observedHost: input.observedHost.trim().toLowerCase(),
    authorizationReference: boundedBrowserText(input.authorizationReference, "authorizationReference", 1_000),
    blockers,
    observedGeneration,
    checkedAt,
  };
}

function assertBlockedBrowserPreflight(evidence: BrowserPreflightEvidence): void {
  const blockers = evidence.blockers ?? [];
  if (!blockers.length) throw new Error("preflight_blocked 必须至少记录一个结构化阻塞代码。");
  const observed = evidence.observedGeneration;
  if (blockers.includes("login_required") && evidence.loginVerified) throw new Error("login_required 与 loginVerified=true 矛盾。");
  if (blockers.includes("page_not_ready") && evidence.pageReady) throw new Error("page_not_ready 与 pageReady=true 矛盾。");
  if (blockers.includes("generation_mode_mismatch")) {
    if (evidence.generationModeVerified) throw new Error("generation_mode_mismatch 与 generationModeVerified=true 矛盾。");
    if (!observed || !(observed.model || observed.aspectRatio || observed.resolution || observed.imageCount)) throw new Error("生成模式不匹配时必须记录当前可见模型或画幅/分辨率/数量。");
  }
  if (blockers.includes("insufficient_credits")) {
    if (!evidence.balanceChecked || !evidence.paidActionRequired) throw new Error("额度不足必须同时记录已检查余额且需要付费动作。");
    if (observed?.generateEnabled !== false || !observed.creditMessage) throw new Error("额度不足必须记录 Generate 禁用和可见额度提示。");
  }
  if (blockers.includes("paid_action_unauthorized") && (!evidence.paidActionRequired || evidence.paidActionAuthorized)) {
    throw new Error("paid_action_unauthorized 必须对应未获授权的付费动作。");
  }
}

function assertSuccessfulBrowserPreflight(plan: BrowserGenerationPlan, evidence: BrowserPreflightEvidence): void {
  const observed = evidence.observedGeneration;
  if (!observed) throw new Error("网页成功预检必须记录当前可见模型、画幅、分辨率、图片数和 Generate 可用状态。");
  const mismatches: string[] = [];
  const compareText = (label: string, expected: string | undefined, actual: string | undefined) => {
    if (expected !== undefined && expected.trim() !== (actual ?? "").trim()) mismatches.push(`${label} 应为 ${expected}，实际为 ${actual || "未记录"}`);
  };
  compareText("模型", plan.parameters.model, observed.model);
  compareText("画幅", plan.parameters.aspectRatio, observed.aspectRatio);
  compareText("分辨率", plan.parameters.resolution, observed.resolution);
  if (plan.parameters.imageCount !== undefined && observed.imageCount !== plan.parameters.imageCount) {
    mismatches.push(`图片数应为 ${plan.parameters.imageCount}，实际为 ${observed.imageCount ?? "未记录"}`);
  }
  if (observed.generateEnabled !== true) mismatches.push("Generate 必须明确可用");
  if (mismatches.length) throw new Error(`网页成功预检与冻结生成计划不一致：${mismatches.join("；")}。`);
}

export async function updateBrowserGenerationJob(
  projectRoot: string,
  jobId: string,
  input: { expectedRevision: number; expectedSettingsRevision?: number; status: BrowserGenerationUpdateStatus; externalTaskId?: string; downloadedPath?: string; error?: string; note?: string; preflightEvidence?: BrowserPreflightInput; uploadEvidence?: BrowserUploadInput; submissionReconciliation?: BrowserSubmissionReconciliationInput },
): Promise<GenerationJob> {
  const job = await withProjectLock(projectRoot, "generation", async () => {
    const jobs = await listGenerationJobs(projectRoot);
    const current = jobs.find((candidate) => candidate.id === jobId);
    if (!current) throw new Error(`找不到生成任务：${jobId}`);
    await assertExistingProductionJobEvidence(projectRoot, current);
    const settings = await getGenerationSettings(projectRoot);
    const configuredProvider = settings.providers.find((candidate) => candidate.id === current.providerId);
    if (configuredProvider?.adapter !== "codex-browser") throw new Error("该任务当前配置不属于 codex-browser 适配器。 ");
    if (["succeeded", "cancelled"].includes(current.status)) throw new Error(`任务已是 ${current.status}，不能回写网页状态。`);
    const previousCheckpoint = current.browserCheckpoint
      ? { ...current.browserCheckpoint, revision: Math.max(1, current.browserCheckpoint.revision || 1) }
      : { revision: 1, stage: "plan_ready" as const, updatedAt: current.updatedAt };
    if (input.expectedRevision !== previousCheckpoint.revision) throw new Error(`网页生成检查点修订冲突：期望 ${input.expectedRevision}，当前 ${previousCheckpoint.revision}。请重新读取计划后再回写。`);
    const nextRevision = previousCheckpoint.revision + 1;
    const previousStage = previousCheckpoint.stage;
    if (["refresh_plan", "preflight_blocked", "preflight", "uploaded", "submit_intent"].includes(input.status)) {
      await assertGenerationPanelReferenceEvidence(projectRoot, current);
    }
    if (input.status === "refresh_plan") {
      assertExecutionSnapshot(current);
      if (!Number.isInteger(input.expectedSettingsRevision) || input.expectedSettingsRevision !== settings.revision) {
        throw new Error(`网页执行计划刷新必须绑定当前供应商配置修订 ${settings.revision}。`);
      }
      const executionSurface = normalizeBrowserExecutionSurface(configuredProvider.executionSurface);
      if (!executionSurface) throw new Error("网页执行计划刷新要求当前供应商声明 executionSurface id/version。");
      if (!["plan_ready", "preflight_blocked"].includes(previousStage)) throw new Error(`网页执行计划只能从 plan_ready 或 preflight_blocked 刷新；当前为 ${previousStage}。`);
      if (current.externalTaskId || current.remoteAcceptedAt || current.remoteResultUrl || current.resultPath || current.publicationReceiptId || current.isolatedDownloadPath) {
        throw new Error("网页任务已有远程身份、结果或 Publication 回执，禁止刷新执行计划。");
      }
      const publicationIntent = current.publicationIntentId ? await getPublicationIntent(projectRoot, current.publicationIntentId) : undefined;
      if (!publicationIntent || publicationIntent.status !== "reserved") throw new Error("网页执行计划刷新要求原 Publication 仍为 reserved。");
      for (const outputPath of [current.expectedOutputPath, current.expectedCompanionPath].filter((value): value is string => Boolean(value))) {
        const exists = await access(outputPath, constants.F_OK).then(() => true, () => false);
        if (exists) throw new Error(`网页执行计划刷新前已出现预期输出，拒绝改写计划：${outputPath}`);
      }
      const previousSnapshotHash = current.executionSnapshot?.snapshotHash;
      current.executionSnapshot = createExecutionSnapshot(configuredProvider, current.prompt, current.parameters, current.storyboardRows, current.references ?? [], panelVisualExecutionIdentity(current));
      const { requestPath, plan } = await writeBrowserGenerationPlan(projectRoot, configuredProvider, current);
      const now = new Date().toISOString();
      current.requestPath = requestPath;
      current.status = "waiting_external";
      current.browserState = "plan_ready";
      current.error = undefined;
      current.browserCheckpoint = {
        revision: nextRevision,
        stage: "plan_ready",
        updatedAt: now,
        executionSurface: plan.executionSurface,
        ...(panelVisualExecutionIdentity(current) ? {
          panelVisualConstraintId: panelVisualExecutionIdentity(current)!.constraintId,
          panelVisualConstraintFingerprint: panelVisualExecutionIdentity(current)!.constraintFingerprint,
          panelVisualModelFingerprint: panelVisualExecutionIdentity(current)!.modelFingerprint,
          panelVisualReviewRulesFingerprint: panelVisualExecutionIdentity(current)!.reviewRulesFingerprint,
        } : {}),
        note: input.note?.trim() || `已将同一 job/Publication 刷新到执行面 ${executionSurface.id}@${executionSurface.version}；旧预检证据已失效。`,
      };
      current.updatedAt = now;
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
      await appendEvent(projectRoot, { actor: "codex", type: "generation.browser-plan-refreshed", itemId: current.itemId, data: { jobId, providerId: configuredProvider.id, settingsRevision: settings.revision, checkpointRevision: nextRevision, executionSurface, previousSnapshotHash, executionSnapshotHash: current.executionSnapshot.snapshotHash, publicationIntentId: current.publicationIntentId } });
      await syncContinuationPackFromJob(projectRoot, current);
      return current;
    }
    const provider = providerForJob(settings, current);
    if (provider?.adapter !== "codex-browser") throw new Error("该任务不属于 codex-browser 适配器。 ");
    if (!current.requestPath?.endsWith(".browser.json")) throw new Error("网页生成计划路径不存在。");
    const persistedPlan = await readJson<BrowserGenerationPlan | null>(current.requestPath, null);
    if (!persistedPlan) throw new Error(`网页生成计划不存在或损坏：${current.requestPath}`);
    assertBrowserGenerationPlanIntegrity(persistedPlan, current);
    if (browserExecutionSurfaceStatus(settings, current, persistedPlan) === "provider_mismatch") {
      throw new Error("网页计划的 executionSurface 与当前供应商配置不一致；禁止沿用旧执行面证据，请先调用 status=refresh_plan。");
    }
    if (persistedPlan.executionSurface && !sameBrowserExecutionSurface(persistedPlan.executionSurface, previousCheckpoint.executionSurface)) {
      throw new Error("网页检查点没有绑定当前冻结 executionSurface，请先调用 status=refresh_plan。");
    }
    const transitions: Record<NonNullable<GenerationJob["browserCheckpoint"]>["stage"], BrowserGenerationUpdateStatus[]> = {
      plan_ready: ["refresh_plan", "preflight_blocked", "preflight", "failed"],
      preflight_blocked: ["refresh_plan", "preflight_blocked", "preflight", "failed"],
      preflight: ["preflight_blocked", "preflight", "uploaded", "failed"],
      uploaded: ["uploaded", "submit_intent", "failed"],
      submission_unknown: ["submitted", "failed"],
      submitted: ["submitted", "processing", "downloaded", "failed"],
      processing: ["processing", "downloaded", "failed"],
      downloaded: ["downloaded", "failed"],
      verified: [], failed: [], cancelled: [],
    };
    if (!transitions[previousStage].includes(input.status)) throw new Error(`网页检查点不能从 ${previousStage} 跳到 ${input.status}；必须依次完成预检、上传确认、提交和下载。`);
    const now = new Date().toISOString();
    let normalizedPreflightEvidence: BrowserPreflightEvidence | undefined;
    if (input.status === "preflight" || input.status === "preflight_blocked") {
      if (!input.note?.trim()) throw new Error("网页预检必须记录域名、登录态、页面模式和余额/付费动作检查结果。 ");
      const evidence = input.preflightEvidence;
      if (!evidence) throw new Error("网页预检必须提交结构化 preflightEvidence，不能只用文字声称已检查。 ");
      normalizedPreflightEvidence = normalizeBrowserPreflightEvidence(evidence, now);
      if (persistedPlan.executionSurface && !sameBrowserExecutionSurface(normalizedPreflightEvidence.executionSurface, persistedPlan.executionSurface)) {
        throw new Error(`网页预检 executionSurface 不匹配：证据必须来自 ${persistedPlan.executionSurface.id}@${persistedPlan.executionSurface.version}。`);
      }
      const expectedHost = new URL(persistedPlan.siteUrl).hostname.toLowerCase();
      const observedHost = normalizedPreflightEvidence.observedHost;
      if (observedHost !== expectedHost) throw new Error(`网页预检域名不匹配：实际 ${observedHost || "未提供"}，计划 ${expectedHost}。`);
      if (input.status === "preflight_blocked") assertBlockedBrowserPreflight(normalizedPreflightEvidence);
      else {
        if (normalizedPreflightEvidence.blockers?.length) throw new Error("预检尚有阻塞代码，只能回写 preflight_blocked。");
        if (!normalizedPreflightEvidence.loginVerified || !normalizedPreflightEvidence.pageReady || !normalizedPreflightEvidence.generationModeVerified || !normalizedPreflightEvidence.balanceChecked) throw new Error("网页预检未完成登录态、页面就绪、生成模式或余额检查，禁止进入上传阶段。 ");
        if (normalizedPreflightEvidence.paidActionRequired && (!normalizedPreflightEvidence.paidActionAuthorized || !normalizedPreflightEvidence.authorizationReference)) throw new Error("页面包含付费动作，但没有记录用户授权依据；禁止提交。 ");
        if (!current.requestPath?.endsWith(".browser.json")) throw new Error("网页生成计划路径不存在，不能完成预检。 ");
        const plan = await readJson<BrowserGenerationPlan | null>(current.requestPath, null);
        if (!plan) throw new Error(`网页生成计划不存在或损坏：${current.requestPath}`);
        assertSuccessfulBrowserPreflight(plan, normalizedPreflightEvidence);
      }
    }
    let uploadEvidence = previousCheckpoint.uploadEvidence;
    if (input.status === "uploaded") {
      if (!current.requestPath?.endsWith(".browser.json")) throw new Error("网页生成计划路径不存在，不能确认上传。 ");
      const plan = await readJson<BrowserGenerationPlan | null>(current.requestPath, null);
      if (!plan) throw new Error(`网页生成计划不存在或损坏：${current.requestPath}`);
      uploadEvidence = await validateBrowserUploadEvidence(plan, input.uploadEvidence);
    }
    let submissionReconciliation: BrowserSubmissionReconciliation | undefined = previousCheckpoint.submissionReconciliation;
    if (input.submissionReconciliation) {
      if (!["submitted", "failed"].includes(input.status)) throw new Error("submissionReconciliation 只用于登记已找到远端任务，或确认远端无结果后结束旧任务。 ");
      const reconciliation = input.submissionReconciliation;
      const note = reconciliation.note.trim();
      const externalTaskId = reconciliation.externalTaskId?.trim();
      if (!note) throw new Error("提交结果对账必须记录核对依据和结果说明。 ");
      if (reconciliation.result === "found" && !(externalTaskId || input.externalTaskId?.trim() || current.externalTaskId)) throw new Error("对账结果为 found 时必须记录 externalTaskId 或稳定任务标题。 ");
      if (reconciliation.result === "not_found" && externalTaskId) throw new Error("对账结果为 not_found 时不能同时记录 externalTaskId。 ");
      submissionReconciliation = { ...reconciliation, note, externalTaskId, checkedAt: now };
    }
    const preserved = {
      executionSurface: persistedPlan.executionSurface,
      preflightEvidence: previousCheckpoint.preflightEvidence,
      uploadEvidence,
      submissionIntent: previousCheckpoint.submissionIntent,
      submissionReconciliation,
      panelVisualConstraintId: persistedPlan.panelVisualConstraintId,
      panelVisualConstraintFingerprint: persistedPlan.panelVisualConstraintFingerprint,
      panelVisualModelFingerprint: persistedPlan.panelVisualModelFingerprint,
      panelVisualReviewRulesFingerprint: persistedPlan.panelVisualReviewRulesFingerprint,
    };
    if (input.status === "submit_intent") {
      if (!current.requestPath?.endsWith(".browser.json")) throw new Error("网页生成计划路径不存在，不能提交。 ");
      const plan = await readJson<BrowserGenerationPlan | null>(current.requestPath, null);
      if (!plan) throw new Error(`网页生成计划不存在或损坏：${current.requestPath}`);
      await assertBrowserUploadEvidenceForSubmit(plan, uploadEvidence);
      await assertFusionAssetJobMaySubmit(projectRoot, current, jobs);
      current.status = "submission_unknown";
      current.browserState = "submission_unknown";
      current.error = "网页提交意图已持久化；只允许点击一次。若回写 submitted 前中断，必须先按 clientJobId 对账，禁止自动重提。";
      current.browserCheckpoint = {
        ...preserved,
        revision: nextRevision,
        stage: "submission_unknown",
        updatedAt: now,
        executionSurface: persistedPlan.executionSurface,
        note: input.note?.trim() || "已持久化付费提交意图，等待单次点击或供应商对账。",
        preflightEvidence: previousCheckpoint.preflightEvidence,
        uploadEvidence,
        submissionIntent: { clientJobId: current.id, attempt: Math.max(1, current.attempts), createdAt: now },
      };
      await appendEvent(projectRoot, { actor: "codex", type: "generation.browser-submit-intent", itemId: current.itemId, data: { jobId, providerId: provider.id, clientJobId: current.id, attempt: Math.max(1, current.attempts), checkpointRevision: nextRevision } });
    } else if (input.status === "submitted") {
      if (!input.externalTaskId?.trim() && !current.externalTaskId) throw new Error("网页任务提交后必须记录 externalTaskId 或稳定任务标题。 ");
      if (current.externalTaskId && input.externalTaskId && current.externalTaskId !== input.externalTaskId.trim()) throw new Error("任务已记录不同的 externalTaskId；拒绝覆盖，防止混淆重复提交。 ");
      if (input.submissionReconciliation && input.submissionReconciliation.result !== "found") throw new Error("登记已提交任务时，对账结果必须为 found。 ");
      current.status = "waiting_external";
      current.browserState = "submitted";
      current.error = undefined;
      current.externalTaskId = input.externalTaskId?.trim() || current.externalTaskId;
      if (submissionReconciliation?.externalTaskId && submissionReconciliation.externalTaskId !== current.externalTaskId) throw new Error("对账记录的 externalTaskId 与网页任务 ID 不一致。 ");
      current.browserCheckpoint = { revision: nextRevision, stage: "submitted", updatedAt: now, externalTaskId: current.externalTaskId, note: input.note?.trim(), ...preserved };
      await appendEvent(projectRoot, { actor: "codex", type: "generation.browser-submitted", itemId: current.itemId, data: { jobId, providerId: provider.id, externalTaskId: current.externalTaskId, checkpointRevision: nextRevision, submissionIntent: previousCheckpoint.submissionIntent, submissionReconciliation } });
    } else if (input.status === "failed") {
      if (previousStage === "submission_unknown" && input.submissionReconciliation?.result !== "not_found") throw new Error("提交结果不明时，必须先提交 result=not_found 的结构化对账证据，才能结束旧任务并创建新版本。 ");
      current.error = input.error?.trim() || "网页生成失败，但未提供详细原因。";
      if (["submitted", "processing", "downloaded"].includes(previousStage) && !current.externalTaskId) throw new Error("网页任务已发生远端副作用；登记明确失败时必须保留稳定 externalTaskId。 ");
      const cause: Exclude<GenerationPublicationTerminalCause, "remote_cancel_confirmed" | "user_cancelled_before_submit"> = previousStage === "submission_unknown"
        ? "browser_submission_not_found"
        : ["submitted", "processing", "downloaded"].includes(previousStage) ? "remote_confirmed_failed" : "local_execution_failed";
      const publicationReconciliation: GenerationPublicationTerminalProvenance["reconciliation"] = previousStage === "submission_unknown" && submissionReconciliation
        ? {
            method: submissionReconciliation.method,
            result: "not_found",
            clientJobId: previousCheckpoint.submissionIntent?.clientJobId ?? current.id,
            attempt: previousCheckpoint.submissionIntent?.attempt ?? Math.max(1, current.attempts),
            evidenceReference: `browser:${submissionReconciliation.method}:${sha256Json({ jobId, nextRevision }).slice(0, 24)}`,
            note: "已通过结构化网页任务对账确认未找到；详细说明保留在 GenerationJob 检查点。",
            confirmNoRemoteResult: true,
            checkedAt: submissionReconciliation.checkedAt,
          }
        : undefined;
      await failGenerationPublication(projectRoot, current, current.error, "codex", cause, { externalTaskId: current.externalTaskId, checkpointRevision: previousStage === "submission_unknown" ? nextRevision : undefined, reconciliation: publicationReconciliation });
      current.browserState = previousStage === "submission_unknown" ? "submission_unknown" : current.browserState;
      if (previousStage !== "submission_unknown") current.browserCheckpoint = { revision: nextRevision, stage: "failed", updatedAt: now, externalTaskId: current.externalTaskId, note: current.error, ...preserved };
      await appendEvent(projectRoot, { actor: "codex", type: "generation.browser-failed", itemId: current.itemId, data: { jobId, providerId: provider.id, externalTaskId: input.externalTaskId, error: current.error, checkpointRevision: nextRevision, submissionReconciliation } });
    } else if (input.status === "downloaded") {
      if (!input.downloadedPath) throw new Error("网页结果下载完成后必须提供本地 downloadedPath。 ");
      if (!current.externalTaskId || previousCheckpoint.externalTaskId !== current.externalTaskId) throw new Error("网页结果下载前必须保留与 submitted 检查点一致的远端任务身份。 ");
      if (input.externalTaskId?.trim() && input.externalTaskId.trim() !== current.externalTaskId) throw new Error("下载回写的 externalTaskId 与已冻结远端任务身份不一致。 ");
      const downloadedPath = path.resolve(input.downloadedPath);
      await access(downloadedPath, constants.R_OK);
      const isolatedDirectory = path.join(getSidecarPaths(projectRoot).generationDownloads, current.id);
      await mkdir(isolatedDirectory, { recursive: true });
      const isolatedPath = isWithin(isolatedDirectory, downloadedPath)
        ? downloadedPath
        : path.join(isolatedDirectory, `download-${now.replace(/[-:.]/g, "")}${path.extname(downloadedPath).toLowerCase() || (current.kind === "image" ? ".png" : ".mp4")}`);
      if (isolatedPath !== downloadedPath) await copyFile(downloadedPath, isolatedPath, constants.COPYFILE_EXCL);
      current.isolatedDownloadPath = isolatedPath;
      await validateGeneratedResultFile(current, isolatedPath);
      current.externalTaskId = input.externalTaskId?.trim() || current.externalTaskId;
      let referenceFailure: string | undefined;
      try {
        await assertGenerationPanelReferenceEvidence(projectRoot, current);
      } catch (error) {
        referenceFailure = error instanceof Error ? error.message : String(error);
      }
      if (referenceFailure) {
        const reason = `远端结果已安全隔离，但逐格引用证据在提交后失效：${referenceFailure}；禁止复制到正式路径或 Publication。`;
        await failGenerationPublication(projectRoot, current, reason, "codex", "local_execution_failed", { externalTaskId: current.externalTaskId, checkpointRevision: nextRevision });
        current.isolatedDownloadPath = isolatedPath;
        current.browserState = "downloaded";
        current.browserCheckpoint = { revision: nextRevision, stage: "failed", updatedAt: now, externalTaskId: current.externalTaskId, isolatedPath, note: reason, ...preserved };
        await appendEvent(projectRoot, { actor: "codex", type: "generation.browser-downloaded-reference-stale", itemId: current.itemId, data: { jobId, providerId: provider.id, downloadedPath, isolatedPath, externalTaskId: current.externalTaskId, checkpointRevision: nextRevision, referenceFailure } });
      } else {
        await mkdir(path.dirname(current.expectedOutputPath), { recursive: true });
        await copyFile(isolatedPath, current.expectedOutputPath, constants.COPYFILE_EXCL).catch((error) => {
          if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("预期输出路径已经存在，拒绝覆盖；请创建新的生成任务版本。 ");
          throw error;
        });
        current.browserState = "downloaded";
        current.browserCheckpoint = { revision: nextRevision, stage: "downloaded", updatedAt: now, externalTaskId: current.externalTaskId, isolatedPath, note: input.note?.trim(), ...preserved };
        await appendEvent(projectRoot, { actor: "codex", type: "generation.browser-downloaded", itemId: current.itemId, data: { jobId, providerId: provider.id, downloadedPath, isolatedPath, expectedOutputPath: current.expectedOutputPath, externalTaskId: current.externalTaskId, checkpointRevision: nextRevision } });
      }
    } else {
      current.status = "waiting_external";
      current.browserState = input.status;
      current.externalTaskId = input.externalTaskId?.trim() || current.externalTaskId;
      current.browserCheckpoint = {
        ...preserved,
        revision: nextRevision, stage: input.status, updatedAt: now, externalTaskId: current.externalTaskId, note: input.note?.trim(), executionSurface: persistedPlan.executionSurface, uploadEvidence,
        submissionIntent: previousCheckpoint.submissionIntent,
        submissionReconciliation,
        preflightEvidence: (input.status === "preflight" || input.status === "preflight_blocked") && normalizedPreflightEvidence
          ? normalizedPreflightEvidence
          : previousCheckpoint.preflightEvidence,
      };
      await appendEvent(projectRoot, { actor: "codex", type: `generation.browser-${input.status}`, itemId: current.itemId, data: { jobId, providerId: provider.id, externalTaskId: current.externalTaskId, note: input.note, checkpointRevision: nextRevision, uploadedFiles: uploadEvidence?.files.map((file) => ({ path: file.path, role: file.role, order: file.order, slot: file.slot, sha256: file.sha256 })) } });
    }
    current.updatedAt = now;
    await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
    await syncContinuationPackFromJob(projectRoot, current);
    return current;
  });
  if (input.status === "downloaded") {
    await processGenerationQueue(projectRoot, { jobId });
    return withProjectLock(projectRoot, "generation", async () => {
      const latest = await listGenerationJobs(projectRoot);
      const refreshed = latest.find((candidate) => candidate.id === jobId);
      if (!refreshed) throw new Error(`机械验收后找不到生成任务：${jobId}`);
      const checkpoint = refreshed.browserCheckpoint ?? job.browserCheckpoint;
      if (checkpoint && ["succeeded", "failed"].includes(refreshed.status)) {
        const nextStage = refreshed.status === "succeeded" ? "verified" as const : "failed" as const;
        refreshed.browserState = refreshed.status === "succeeded" ? "verified" : refreshed.browserState;
        refreshed.browserCheckpoint = { ...checkpoint, revision: Math.max(1, checkpoint.revision || 1) + 1, stage: nextStage, updatedAt: new Date().toISOString(), externalTaskId: refreshed.externalTaskId, isolatedPath: refreshed.isolatedDownloadPath, note: refreshed.error ?? checkpoint.note };
        await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, latest);
        await appendEvent(projectRoot, { actor: "scanner", type: `generation.browser-${nextStage}`, itemId: refreshed.itemId, data: { jobId, checkpointRevision: refreshed.browserCheckpoint.revision, publicationReceiptId: refreshed.publicationReceiptId, error: refreshed.error } });
        await syncContinuationPackFromJob(projectRoot, refreshed);
      }
      return refreshed;
    });
  }
  return job;
}

export async function reconcileHttpGenerationSubmission(
  projectRoot: string,
  jobId: string,
  input: ReconcileHttpGenerationSubmissionInput,
  options: {
    beforePublicationClose?: (snapshot: { jobId: string; publicationIntentId: string; checkpointRevision: number }) => void | Promise<void>;
    afterPublicationClose?: (snapshot: { jobId: string; publicationIntentId: string; checkpointRevision: number }) => void | Promise<void>;
  } = {},
): Promise<HttpGenerationSubmissionReconciliationResult> {
  return withProjectLock(projectRoot, "generation", async () => {
    const jobs = await listGenerationJobs(projectRoot);
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new ConfirmedCommandFailure(`找不到要对账的生成任务：${jobId}`, { schemaVersion: 1, applied: false, jobId });
    const settings = await getGenerationSettings(projectRoot);
    let provider: GenerationProvider | undefined;
    try { provider = providerForJob(settings, job); }
    catch (error) { throw new ConfirmedCommandFailure(error instanceof Error ? error.message : String(error), { schemaVersion: 1, applied: false, jobId, status: job.status }); }
    const checkpoint = getHttpGenerationSubmissionCheckpoint(job);
    if (!provider || provider.adapter !== "http-json" || !checkpoint) throw new ConfirmedCommandFailure("该任务不是可执行 HTTP submission_unknown 对账的 http-json 任务。", { schemaVersion: 1, applied: false, jobId, status: job.status });

    const publicationIntent = job.publicationIntentId ? await getPublicationIntent(projectRoot, job.publicationIntentId) : undefined;
    const publicationProjection = await projectGenerationPublicationState(projectRoot, job, publicationIntent);
    if (publicationProjection !== "none") {
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
      await syncContinuationPackFromJob(projectRoot, job);
      if (publicationProjection === "registered") return httpSubmissionResult(job, checkpoint, "publication_registered", false, "registered");
      if (publicationProjection === "failed") {
        const outcome = job.httpSubmissionCheckpoint?.stage === "reconciled_not_found" ? "not_found" : "publication_failed";
        return httpSubmissionResult(job, job.httpSubmissionCheckpoint ?? checkpoint, outcome, false, "failed");
      }
      if (publicationProjection === "cancelled") return httpSubmissionResult(job, checkpoint, "publication_cancelled", false, "cancelled");
      rejectHttpSubmissionReconciliation(job, checkpoint, "关联 Publication 终态没有匹配的结构化生成来源；任务保持锁定，拒绝 HTTP 对账覆盖。", publicationIntent?.status);
    }
    if (!publicationIntent || publicationIntent.status !== "reserved") rejectHttpSubmissionReconciliation(job, checkpoint, "HTTP 对账要求关联 Publication 仍为 reserved。", publicationIntent?.status);
    if (job.status !== "submission_unknown" || checkpoint.stage !== "submission_unknown") rejectHttpSubmissionReconciliation(job, checkpoint, `HTTP 对账只允许 submission_unknown/R1；当前为 ${job.status}/${checkpoint.stage}。`, publicationIntent.status);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1 || input.expectedRevision !== checkpoint.revision) rejectHttpSubmissionReconciliation(job, checkpoint, `HTTP 提交对账修订冲突：期望 ${input.expectedRevision}，当前 ${checkpoint.revision}。`, publicationIntent.status);

    let reconciliation: HttpGenerationSubmissionReconciliation;
    try { reconciliation = normalizeHttpSubmissionReconciliation(job, input.reconciliation, new Date().toISOString()); }
    catch (error) { rejectHttpSubmissionReconciliation(job, checkpoint, error instanceof Error ? error.message : String(error), publicationIntent.status); }
    const nextRevision = checkpoint.revision + 1;
    const now = reconciliation.checkedAt;
    if (reconciliation.result === "found") {
      if (job.externalTaskId && job.externalTaskId !== reconciliation.externalTaskId) rejectHttpSubmissionReconciliation(job, checkpoint, "任务已记录不同 externalTaskId；拒绝覆盖或混合远端任务。", publicationIntent.status);
      if (job.remoteResultUrl && !job.externalTaskId) rejectHttpSubmissionReconciliation(job, checkpoint, "任务已有结果 URL 但缺少稳定任务 ID；拒绝用 found 对账覆盖现有远端身份。", publicationIntent.status);
      job.externalTaskId = reconciliation.externalTaskId;
      job.remoteAcceptedAt ??= now;
      job.status = "waiting_remote";
      job.error = undefined;
      job.httpSubmissionCheckpoint = { revision: nextRevision, stage: "reconciled_found", updatedAt: now, submissionIntent: checkpoint.submissionIntent, reconciliation };
      observeRemote(job, "pending", "submit", "HTTP 提交对账已找到同一远端任务；后续只允许定向轮询该 externalTaskId，不会重新 POST。", { observedStatus: "reconciled_found", nextAction: "poll_same_task" });
    } else {
      if (job.externalTaskId || job.remoteResultUrl || job.remoteAcceptedAt) rejectHttpSubmissionReconciliation(job, checkpoint, "任务已经持久化远端身份或结果线索，不能登记 not_found。", publicationIntent.status);
      const candidatePaths = [job.expectedOutputPath, job.isolatedDownloadPath, job.partialDownloadPath].filter((candidate): candidate is string => Boolean(candidate));
      const presentPaths = (await Promise.all(candidatePaths.map(async (candidate) => await access(candidate).then(() => candidate).catch(() => undefined)))).filter((candidate): candidate is string => Boolean(candidate));
      if (presentPaths.length) rejectHttpSubmissionReconciliation(job, checkpoint, "任务已有最终、隔离或 partial 文件；必须先核对文件与 Publication，不能登记 not_found。", publicationIntent.status);
      const publicationReconciliation: GenerationPublicationTerminalProvenance["reconciliation"] = { ...reconciliation };
      await options.beforePublicationClose?.({ jobId: job.id, publicationIntentId: publicationIntent.id, checkpointRevision: nextRevision });
      let publicationClosed = false;
      try {
        await failGenerationPublication(projectRoot, job, "HTTP 提交对账确认供应商侧未建立远端任务；旧尝试已安全闭合，可显式创建新版本。", "codex", "http_submission_not_found", { checkpointRevision: nextRevision, reconciliation: publicationReconciliation });
        publicationClosed = true;
        await options.afterPublicationClose?.({ jobId: job.id, publicationIntentId: publicationIntent.id, checkpointRevision: nextRevision });
      } catch (error) {
        if (publicationClosed) throw error;
        const latest = job.publicationIntentId ? await getPublicationIntent(projectRoot, job.publicationIntentId) : undefined;
        const projected = await projectGenerationPublicationState(projectRoot, job, latest);
        await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
        await syncContinuationPackFromJob(projectRoot, job);
        if (projected === "registered") return httpSubmissionResult(job, checkpoint, "publication_registered", false, "registered");
        if (projected === "failed" && job.httpSubmissionCheckpoint?.stage === "reconciled_not_found") return httpSubmissionResult(job, job.httpSubmissionCheckpoint, "not_found", true, "failed");
        rejectHttpSubmissionReconciliation(job, checkpoint, `Publication CAS 未闭合，HTTP not_found 未应用：${safeRemoteMessage(error)}`, latest?.status);
      }
    }
    job.updatedAt = now;
    await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
    await appendEvent(projectRoot, { actor: "codex", type: `generation.http-submission-reconciled-${reconciliation.result}`, itemId: job.itemId, data: { jobId: job.id, providerId: provider.id, clientJobId: reconciliation.clientJobId, attempt: reconciliation.attempt, checkpointRevision: nextRevision, method: reconciliation.method, result: reconciliation.result, evidenceReference: reconciliation.evidenceReference, externalTaskId: reconciliation.externalTaskId, publicationIntentId: job.publicationIntentId } });
    await syncContinuationPackFromJob(projectRoot, job);
    return httpSubmissionResult(job, job.httpSubmissionCheckpoint!, reconciliation.result, true, reconciliation.result === "not_found" ? "failed" : "reserved");
  });
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

async function renderLabeledCompanion(
  job: GenerationJob,
  rawPath: string,
  targetPath: string,
): Promise<{ size: number; magic: string; sha256: string }> {
  const metadata = await (await loadSharpDefault())(rawPath, { failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("生成结果无法解码，不能派生 labeled 检查版。");
  const bannerHeight = Math.max(54, Math.min(110, Math.round(metadata.height * 0.075)));
  const fontSize = Math.max(16, Math.min(32, Math.round(metadata.width / 28)));
  const label = escapeXml(`${job.itemId} · ${path.basename(job.expectedOutputPath)}`);
  const svg = Buffer.from(`<svg width="${metadata.width}" height="${bannerHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="rgba(8,9,7,0.82)"/><text x="${Math.round(fontSize * 0.65)}" y="${Math.round(bannerHeight * 0.64)}" fill="#e6bd5b" font-family="PingFang SC,Arial,sans-serif" font-size="${fontSize}">${label}</text></svg>`);
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.${process.pid}.${Date.now()}.tmp.png`;
  await (await loadSharpDefault())(rawPath, { failOn: "error" }).composite([{ input: svg, top: 0, left: 0 }]).png().toFile(temporary);
  const previousSha256 = job.resultSha256;
  const previousMagic = job.resultMagic;
  try {
    await fsyncFile(temporary);
    const expectedSha256 = await sha256File(temporary);
    try {
      await link(temporary, targetPath);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = await stat(targetPath);
    if (existing.size <= 0) throw new PublicationOutputConflict("labeled 目标已存在但为空，拒绝静默覆盖；保留任务等待人工核对。 ");
    const existingMetadata = await (await loadSharpDefault())(targetPath, { failOn: "error" }).metadata();
    if (existingMetadata.width !== metadata.width || existingMetadata.height !== metadata.height) throw new PublicationOutputConflict("labeled 目标尺寸与当前生成结果不一致，拒绝静默接纳或覆盖。 ");
    await pipeline(
      (await loadSharpDefault())(targetPath, { failOn: "error" }).raw(),
      new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    );
    if (await sha256File(targetPath) !== expectedSha256) throw new PublicationOutputConflict("labeled 目标已存在且内容不是当前 raw 的确定性检查版，拒绝覆盖；保留任务等待人工核对。 ");
    return await validateGeneratedResultFile(job, targetPath);
  } catch (error) {
    if (error instanceof PublicationOutputConflict) throw error;
    throw new PublicationOutputConflict(`labeled 检查版无法完整验收：${safeRemoteMessage(error)}；拒绝覆盖并保留任务等待人工核对。`);
  } finally {
    job.resultSha256 = previousSha256;
    job.resultMagic = previousMagic;
    await unlink(temporary).catch(() => undefined);
  }
}

async function ensureImageCompanion(job: GenerationJob): Promise<void> {
  if (job.kind !== "image" || !job.resultPath || !job.expectedCompanionPath) return;
  await renderLabeledCompanion(job, job.resultPath, job.expectedCompanionPath);
  job.companionPath = job.expectedCompanionPath;
}

async function prepareIsolatedSubagentBundle(
  projectRoot: string,
  job: GenerationJob,
  output: NonNullable<SubagentImageGenerationCheckpoint["output"]>,
): Promise<{
  raw: { size: number; magic: string; sha256: string };
  companion: { size: number; magic: string; sha256: string };
  companionPath: string;
}> {
  const expectedDirectory = path.join(getSidecarPaths(projectRoot).generationDownloads, job.id);
  if (!isWithin(expectedDirectory, output.isolatedPath)) throw new Error("子代理候选 raw 不在当前 Job 的隔离目录内。");
  const raw = await validateGeneratedResultFile(job, output.isolatedPath);
  if (raw.sha256 !== output.isolatedSha256 || raw.sha256 !== output.sourceSha256 || raw.size !== output.bytes) {
    throw new PublicationOutputConflict("隔离候选 raw 与 call receipt 的 SHA/体积不一致。");
  }
  const callId = output.callId ?? output.agentRunId;
  const companionPath = output.isolatedCompanionPath
    ?? path.join(expectedDirectory, `subagent-${callId.replace(/[^a-zA-Z0-9._-]/g, "_")}-${raw.sha256.slice(0, 16)}-labeled.png`);
  const companion = await renderLabeledCompanion(job, output.isolatedPath, companionPath);
  if (output.isolatedCompanionSha256 && (output.isolatedCompanionSha256 !== companion.sha256 || output.companionBytes !== companion.size)) {
    throw new PublicationOutputConflict("隔离 labeled 与已持久化 companion receipt 不一致。");
  }
  const [rawMetadata, companionMetadata] = await Promise.all([
    (await loadSharpDefault())(output.isolatedPath, { failOn: "error" }).metadata(),
    (await loadSharpDefault())(companionPath, { failOn: "error" }).metadata(),
  ]);
  if (!rawMetadata.width || !rawMetadata.height || rawMetadata.width !== companionMetadata.width || rawMetadata.height !== companionMetadata.height) {
    throw new PublicationOutputConflict("隔离 raw/labeled 尺寸不一致。");
  }
  return { raw, companion, companionPath };
}

async function publishIsolatedFileExclusive(
  job: GenerationJob,
  isolatedPath: string,
  targetPath: string,
  expected: { size: number; magic: string; sha256: string },
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const previousSha256 = job.resultSha256;
  const previousMagic = job.resultMagic;
  if (await pathExists(targetPath)) {
    const existing = await validateGeneratedResultFile(job, targetPath);
    job.resultSha256 = previousSha256;
    job.resultMagic = previousMagic;
    if (existing.sha256 !== expected.sha256 || existing.size !== expected.size || existing.magic !== expected.magic) {
      throw new PublicationOutputConflict(`正式目标已存在且与隔离候选不同，拒绝覆盖：${targetPath}`);
    }
    return;
  }
  const temporary = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${job.id}.publish.tmp`);
  await unlink(temporary).catch((error) => {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  try {
    await copyFile(isolatedPath, temporary, constants.COPYFILE_EXCL);
    await fsyncFile(temporary);
    await link(temporary, targetPath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const published = await validateGeneratedResultFile(job, targetPath);
  job.resultSha256 = previousSha256;
  job.resultMagic = previousMagic;
  if (published.sha256 !== expected.sha256 || published.size !== expected.size || published.magic !== expected.magic) {
    throw new PublicationOutputConflict(`正式目标不可覆盖提升后与隔离候选不同：${targetPath}`);
  }
}

async function publishIsolatedSubagentBundle(
  job: GenerationJob,
  prepared: {
    raw: { size: number; magic: string; sha256: string };
    companion: { size: number; magic: string; sha256: string };
    companionPath: string;
  },
): Promise<void> {
  if (!job.subagentCheckpoint?.output || !job.expectedCompanionPath) throw new Error("子代理事务发布缺少隔离候选或正式 companion 路径。");
  await publishIsolatedFileExclusive(job, job.subagentCheckpoint.output.isolatedPath, job.expectedOutputPath, prepared.raw);
  await publishIsolatedFileExclusive(job, prepared.companionPath, job.expectedCompanionPath, prepared.companion);
  job.resultPath = job.expectedOutputPath;
  job.companionPath = job.expectedCompanionPath;
  job.resultSha256 = prepared.raw.sha256;
  job.resultMagic = prepared.raw.magic;
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

async function fileMagic(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
    if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4-family";
    if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
    return "unknown";
  } finally { await handle.close(); }
}

async function inspectGeneratedResult(job: GenerationJob, filePath: string): Promise<{ size: number; magic: string; sha256: string }> {
  const metadata = await stat(filePath);
  if (metadata.size <= 0) throw new Error("生成结果为空文件。 ");
  const maximumBytes = job.kind === "image" ? MAX_IMAGE_DOWNLOAD_BYTES : MAX_VIDEO_DOWNLOAD_BYTES;
  if (metadata.size > maximumBytes) throw new Error(`生成${job.kind === "image" ? "图片" : "视频"}结果大小 ${metadata.size} 超过 ${maximumBytes} 字节上限。`);
  const magic = await fileMagic(filePath);
  if (job.kind === "image" && !magic.startsWith("image/")) throw new Error(`图片结果文件魔数不匹配：${magic}`);
  if (job.kind === "video" && !magic.startsWith("video/")) throw new Error(`视频结果文件魔数不匹配：${magic}`);
  const sha256 = await sha256File(filePath);
  job.resultMagic = magic;
  job.resultSha256 = sha256;
  return { size: metadata.size, magic, sha256 };
}

async function validateGeneratedResultFile(job: GenerationJob, filePath: string): Promise<{ size: number; magic: string; sha256: string }> {
  const inspected = await inspectGeneratedResult(job, filePath);
  if (job.kind === "image") {
    const metadata = await (await loadSharpDefault())(filePath, { failOn: "error" }).metadata();
    if (!metadata.width || !metadata.height) throw new Error("生成图片无法解码或缺少有效尺寸。 ");
    if (inspected.size < MIN_IMAGE_DOWNLOAD_BYTES || metadata.width < MIN_IMAGE_DIMENSION || metadata.height < MIN_IMAGE_DIMENSION) {
      throw new Error(`生成图片尺寸或体积过小（${metadata.width}×${metadata.height} / ${inspected.size} bytes），疑似无效或占位图。`);
    }
    if (metadata.width * metadata.height > 100_000_000) throw new Error("生成图片像素总量超过 1 亿上限，拒绝解码发布。 ");
    const aspectMatch = job.parameters?.aspectRatio?.trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/u);
    if (aspectMatch) {
      const expected = Number(aspectMatch[1]) / Number(aspectMatch[2]);
      const actual = metadata.width / metadata.height;
      if (!Number.isFinite(expected) || expected <= 0 || Math.abs(actual - expected) / expected > MAX_ASPECT_RATIO_RELATIVE_ERROR) {
        throw new Error(`生成图片画幅 ${metadata.width}:${metadata.height} 与冻结计划 ${job.parameters?.aspectRatio} 不一致。`);
      }
    }
    await pipeline(
      (await loadSharpDefault())(filePath, { failOn: "error" }).raw(),
      new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    );
    if (["asset", "fusion_frame", "fusion_storyboard_panel"].includes(job.purpose ?? "")) {
      if (inspected.size < MIN_FORMAL_IMAGE_DOWNLOAD_BYTES || metadata.width < MIN_FORMAL_IMAGE_WIDTH || metadata.height < MIN_FORMAL_IMAGE_HEIGHT) {
        throw new Error(`正式第三季图片尺寸或体积不足（${metadata.width}×${metadata.height} / ${inspected.size} bytes），拒绝作为生产资产发布。`);
      }
      const statistics = await (await loadSharpDefault())(filePath, { failOn: "error" }).stats();
      const maximumDeviation = Math.max(...statistics.channels.slice(0, 3).map((channel) => channel.stdev));
      if (!Number.isFinite(statistics.entropy) || statistics.entropy < 0.02 || !Number.isFinite(maximumDeviation) || maximumDeviation < 2) {
        throw new Error("正式第三季图片像素变化近乎为空，疑似纯色或占位图，拒绝发布。");
      }
    }
    return inspected;
  }
  if (inspected.size < 50_000) throw new Error("视频生成结果体积过小，疑似无效文件。");
  const { stdout } = await execFileAsync(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name:format=duration", "-of", "json", filePath], { maxBuffer: 1_000_000 });
  const probe = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number; codec_name?: string }>; format?: { duration?: string } };
  const stream = probe.streams?.[0];
  const duration = Number(probe.format?.duration);
  if (!stream?.codec_name || !stream.width || !stream.height || stream.width < 256 || stream.height < 256 || !Number.isFinite(duration) || duration <= 0) throw new Error("视频生成结果无可解码画面流、有效时长或尺寸不足。");
  await execFileAsync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-i", filePath, "-map", "0:v:0", "-f", "null", "-"], { maxBuffer: 1_000_000, timeout: 300_000 });
  return inspected;
}

async function verifyGeneratedResult(job: GenerationJob): Promise<void> {
  if (!job.resultPath) throw new Error("生成结果缺少本地路径。 ");
  await validateGeneratedResultFile(job, job.resultPath);
  if (job.kind === "image") await ensureImageCompanion(job);
}

async function verifyAndRegisterGeneratedResult(projectRoot: string, job: GenerationJob): Promise<void> {
  if (!job.resultPath || path.resolve(job.resultPath) !== path.resolve(job.expectedOutputPath)) throw new Error("生成结果路径与发布预留路径不一致。 ");
  await verifyGeneratedResult(job);
  if (!job.publicationIntentId || !job.publicationReservationToken) throw new Error("生成任务缺少发布意图或预留令牌，不能声明成功。 ");
  const intent = await getPublicationIntent(projectRoot, job.publicationIntentId);
  if (!intent) throw new Error(`找不到生成任务关联的发布意图：${job.publicationIntentId}`);
  if (job.publicationBundleId) {
    if (!job.companionPublicationIntentId || !job.companionPublicationReservationToken || !job.expectedCompanionPath || !job.companionPath) {
      throw new Error("raw/labeled 发布事务缺少 companion Publication 或正式 labeled 路径。 ");
    }
    const companionIntent = await getPublicationIntent(projectRoot, job.companionPublicationIntentId);
    if (!companionIntent) throw new Error(`找不到生成任务关联的 companion 发布意图：${job.companionPublicationIntentId}`);
    const bundle = await registerPublicationBundle(projectRoot, {
      bundleId: job.publicationBundleId,
      members: [
        { member: "primary", intentId: intent.id, reservationToken: job.publicationReservationToken, expectedRevision: intent.revision },
        { member: "companion", intentId: companionIntent.id, reservationToken: job.companionPublicationReservationToken, expectedRevision: companionIntent.revision },
      ],
    }, "scanner");
    const primaryReceipt = bundle.receipts.find((receipt) => receipt.bundleMember === "primary");
    const companionReceipt = bundle.receipts.find((receipt) => receipt.bundleMember === "companion");
    if (!primaryReceipt || !companionReceipt
      || path.resolve(primaryReceipt.targetPath) !== path.resolve(job.resultPath)
      || path.resolve(companionReceipt.targetPath) !== path.resolve(job.companionPath)
      || primaryReceipt.check.sha256 !== job.resultSha256) {
      throw new Error("raw/labeled 发布事务回执与生成结果路径或校验值不一致。 ");
    }
    job.publicationReceiptId = primaryReceipt.id;
    job.companionPublicationReceiptId = companionReceipt.id;
    return;
  }
  const receipt = await registerPublication(projectRoot, {
    intentId: intent.id,
    reservationToken: job.publicationReservationToken,
    expectedRevision: intent.revision,
  }, "scanner");
  if (path.resolve(receipt.targetPath) !== path.resolve(job.resultPath) || receipt.check.sha256 !== job.resultSha256) throw new Error("发布回执与生成结果路径或校验值不一致。 ");
  job.publicationReceiptId = receipt.id;
}

async function reconcileRegisteredGeneration(projectRoot: string, job: GenerationJob): Promise<boolean> {
  if (!job.publicationIntentId) return false;
  const intent = await getPublicationIntent(projectRoot, job.publicationIntentId);
  if (intent?.status !== "registered" || !intent.receiptId) return false;
  const receipt = await getPublicationReceipt(projectRoot, intent.receiptId);
  if (!receipt || path.resolve(receipt.targetPath) !== path.resolve(job.expectedOutputPath)) return false;
  const inspected = await validateGeneratedResultFile(job, job.expectedOutputPath);
  if (receipt.check.sha256 !== inspected.sha256 || receipt.check.size !== inspected.size) throw new Error("已登记 Publication 回执与当前生成结果不一致，拒绝恢复成功状态。 ");
  if (job.publicationBundleId) {
    if (receipt.bundleId !== job.publicationBundleId || receipt.bundleMember !== "primary" || !job.companionPublicationIntentId || !job.expectedCompanionPath) {
      throw new Error("已登记 primary 回执与 GenerationJob 的 raw/labeled 事务身份不一致。 ");
    }
    const companionIntent = await getPublicationIntent(projectRoot, job.companionPublicationIntentId);
    if (companionIntent?.status !== "registered" || !companionIntent.receiptId) throw new Error("raw 已登记但 labeled Publication 尚未完整注册，拒绝单边恢复成功。 ");
    const companionReceipt = await getPublicationReceipt(projectRoot, companionIntent.receiptId);
    if (!companionReceipt
      || companionReceipt.bundleId !== job.publicationBundleId
      || companionReceipt.bundleMember !== "companion"
      || path.resolve(companionReceipt.targetPath) !== path.resolve(job.expectedCompanionPath)) {
      throw new Error("已登记 companion 回执与 GenerationJob 的 raw/labeled 事务身份不一致。 ");
    }
    const companionInspection = await validateGeneratedResultFile(job, job.expectedCompanionPath);
    if (companionReceipt.check.sha256 !== companionInspection.sha256 || companionReceipt.check.size !== companionInspection.size) {
      throw new Error("已登记 labeled 回执与当前文件不一致，拒绝恢复成功状态。 ");
    }
    job.resultSha256 = inspected.sha256;
    job.resultMagic = inspected.magic;
    job.companionPath = job.expectedCompanionPath;
    job.companionPublicationReceiptId = companionReceipt.id;
  }
  job.resultPath = job.expectedOutputPath;
  job.publicationReceiptId = receipt.id;
  if (job.kind === "image" && !job.publicationBundleId) await ensureImageCompanion(job);
  return true;
}

function generationPublicationBindingError(intent: PublicationIntent, job: GenerationJob): string | undefined {
  if (intent.projectId !== job.projectId) return "Publication projectId 与 GenerationJob 不一致。";
  if (intent.context.purpose !== "generation-output" || intent.context.jobId !== job.id || intent.context.itemId !== job.itemId) return "Publication 生成上下文与 GenerationJob 不一致。";
  if (path.resolve(intent.targetPath) !== path.resolve(job.expectedOutputPath)) return "Publication 目标路径与 GenerationJob 不一致。";
  return undefined;
}

function generationTerminalProvenance(
  job: GenerationJob,
  cause: GenerationPublicationTerminalCause,
  options: { externalTaskId?: string; checkpointRevision?: number; reconciliation?: GenerationPublicationTerminalProvenance["reconciliation"] } = {},
): GenerationPublicationTerminalProvenance {
  const submissionIntent = generationSubmissionIntent(job);
  const comfyCheckpoint = job.comfyUiCheckpoint;
  const comfyTerminal = comfyCheckpoint && (cause === "remote_confirmed_failed" || cause === "remote_cancel_confirmed")
    ? {
        promptId: comfyCheckpoint.promptId,
        clientId: comfyCheckpoint.clientId,
        submittedWorkflowHash: comfyCheckpoint.submittedWorkflowHash,
        historySha256: comfyCheckpoint.history?.historySha256,
        eventName: comfyCheckpoint.history?.eventName === "execution_error" || comfyCheckpoint.history?.eventName === "execution_interrupted" ? comfyCheckpoint.history.eventName : undefined,
        confirmationKind: comfyCheckpoint.cancellation?.confirmation?.kind,
        cancellationResponseSha256: comfyCheckpoint.cancellation?.responseSha256,
      }
    : undefined;
  return {
    schemaVersion: 1,
    source: "generation",
    generationJobId: job.id,
    cause,
    clientJobId: submissionIntent.clientJobId,
    attempt: submissionIntent.attempt,
    externalTaskId: options.externalTaskId,
    checkpointRevision: options.checkpointRevision,
    comfyUi: comfyTerminal,
    reconciliation: options.reconciliation,
  };
}

function comfyUiHistoryEvidenceMatchesJob(job: GenerationJob, evidence: ComfyUiHistoryEvidence | undefined, eventName: ComfyUiHistoryEvidence["eventName"]): boolean {
  const checkpoint = job.comfyUiCheckpoint;
  if (!checkpoint || !evidence || evidence.eventName !== eventName) return false;
  let intent: GenerationSubmissionIntent;
  try { intent = generationSubmissionIntent(job); }
  catch { return false; }
  return evidence.generationJobId === job.id
    && evidence.promptId === checkpoint.promptId
    && evidence.clientId === checkpoint.clientId
    && evidence.clientJobId === intent.clientJobId
    && evidence.attempt === intent.attempt
    && evidence.workflowHash === checkpoint.workflowHash
    && evidence.submittedWorkflowHash === checkpoint.submittedWorkflowHash
    && evidence.outputNodeId === checkpoint.outputNodeId
    && evidence.outputIndex === checkpoint.outputIndex
    && /^[a-f0-9]{64}$/.test(evidence.historySha256);
}

function trustedGenerationTerminalProvenance(intent: PublicationIntent, job: GenerationJob): GenerationPublicationTerminalProvenance | undefined {
  if (generationPublicationBindingError(intent, job)) return undefined;
  const provenance = intent.terminal?.provenance;
  if (!provenance || provenance.source !== "generation" || provenance.generationJobId !== job.id) return undefined;
  let submissionIntent: GenerationSubmissionIntent;
  try { submissionIntent = generationSubmissionIntent(job); }
  catch { return undefined; }
  if (provenance.clientJobId !== submissionIntent.clientJobId || provenance.attempt !== submissionIntent.attempt) return undefined;
  if (provenance.externalTaskId && job.externalTaskId && provenance.externalTaskId !== job.externalTaskId) return undefined;
  if (provenance.cause === "http_submission_not_found") {
    const checkpoint = getHttpGenerationSubmissionCheckpoint(job);
    const reconciliation = provenance.reconciliation;
    if (!checkpoint || !reconciliation || reconciliation.result !== "not_found" || reconciliation.confirmNoRemoteResult !== true || reconciliation.externalTaskId) return undefined;
    if (reconciliation.method === "browser_history" || reconciliation.clientJobId !== submissionIntent.clientJobId || reconciliation.attempt !== submissionIntent.attempt) return undefined;
    const expectedRevision = checkpoint.stage === "reconciled_not_found" ? checkpoint.revision : checkpoint.revision + 1;
    if (provenance.checkpointRevision !== expectedRevision || job.externalTaskId || job.remoteResultUrl || job.remoteAcceptedAt) return undefined;
  } else if (provenance.cause === "browser_submission_not_found") {
    const checkpoint = job.browserCheckpoint;
    const reconciliation = provenance.reconciliation;
    if (!checkpoint || !reconciliation || reconciliation.result !== "not_found" || reconciliation.confirmNoRemoteResult !== true || reconciliation.externalTaskId) return undefined;
    if (!(["provider_task_list", "client_job_id_search", "browser_history"] as string[]).includes(reconciliation.method)) return undefined;
    if (reconciliation.clientJobId !== submissionIntent.clientJobId || reconciliation.attempt !== submissionIntent.attempt) return undefined;
    const expectedRevision = checkpoint.stage === "failed" ? checkpoint.revision : checkpoint.revision + 1;
    if (checkpoint.stage !== "submission_unknown" && checkpoint.stage !== "failed") return undefined;
    if (provenance.checkpointRevision !== expectedRevision || job.externalTaskId || job.remoteResultUrl || job.remoteAcceptedAt) return undefined;
  } else if (provenance.cause === "remote_confirmed_failed") {
    if (job.externalTaskId && provenance.externalTaskId !== job.externalTaskId) return undefined;
    if (!job.externalTaskId && provenance.externalTaskId) return undefined;
    if (job.comfyUiCheckpoint) {
      const checkpoint = job.comfyUiCheckpoint;
      const evidence = checkpoint.history;
      const terminal = provenance.comfyUi;
      if (provenance.externalTaskId !== checkpoint.promptId || provenance.checkpointRevision !== checkpoint.revision) return undefined;
      if (checkpoint.stage !== "history_failed" || !comfyUiHistoryEvidenceMatchesJob(job, evidence, "execution_error")) return undefined;
      if (!terminal || terminal.promptId !== checkpoint.promptId || terminal.clientId !== checkpoint.clientId || terminal.submittedWorkflowHash !== checkpoint.submittedWorkflowHash || terminal.historySha256 !== evidence?.historySha256 || terminal.eventName !== "execution_error" || terminal.confirmationKind) return undefined;
    }
  } else if (provenance.cause === "remote_cancel_confirmed") {
    if (!job.externalTaskId || provenance.externalTaskId !== job.externalTaskId) return undefined;
    if (job.comfyUiCheckpoint) {
      const checkpoint = job.comfyUiCheckpoint;
      const cancellation = checkpoint.cancellation;
      const confirmation = cancellation?.confirmation;
      const terminal = provenance.comfyUi;
      if (provenance.externalTaskId !== checkpoint.promptId || provenance.checkpointRevision !== checkpoint.revision || checkpoint.stage !== "cancelled" || !confirmation) return undefined;
      if (!terminal || terminal.promptId !== checkpoint.promptId || terminal.clientId !== checkpoint.clientId || terminal.submittedWorkflowHash !== checkpoint.submittedWorkflowHash || terminal.confirmationKind !== confirmation.kind) return undefined;
      if (confirmation.kind === "history_interrupted") {
        if (!comfyUiHistoryEvidenceMatchesJob(job, checkpoint.history, "execution_interrupted") || confirmation.historySha256 !== checkpoint.history?.historySha256 || confirmation.eventName !== "execution_interrupted" || terminal.historySha256 !== checkpoint.history?.historySha256 || terminal.eventName !== "execution_interrupted") return undefined;
      } else if (confirmation.kind === "pending_deleted") {
        if (cancellation?.preObservedState !== "pending" || cancellation.outcome !== "acted" || cancellation.serverActed !== true || (confirmation.stableAbsentCount ?? 0) < 2 || terminal.cancellationResponseSha256 !== cancellation.responseSha256 || terminal.historySha256 || terminal.eventName) return undefined;
      } else return undefined;
    }
  } else {
    const hasPossibleRemoteSideEffect = Boolean(job.externalTaskId || job.remoteResultUrl || job.remoteAcceptedAt)
      || job.status === "submission_unknown"
      || job.browserCheckpoint?.stage === "submission_unknown"
      || job.httpSubmissionCheckpoint?.stage === "submission_unknown"
      || job.comfyUiCheckpoint?.stage === "posting"
      || job.comfyUiCheckpoint?.stage === "submission_unknown";
    if (hasPossibleRemoteSideEffect) return undefined;
  }
  const failedCause = !["remote_cancel_confirmed", "user_cancelled_before_submit"].includes(provenance.cause);
  if ((intent.status === "failed") !== failedCause) return undefined;
  return provenance;
}

export function generationPublicationTerminalMatchesJob(intent: PublicationIntent, job: GenerationJob): boolean {
  return Boolean(trustedGenerationTerminalProvenance(intent, job));
}

function applyTrustedGenerationTerminal(job: GenerationJob, intent: PublicationIntent, provenance: GenerationPublicationTerminalProvenance): void {
  const reason = intent.terminal?.reason ?? `关联 Publication 已进入 ${intent.status} 终态。`;
  if (provenance.cause === "http_submission_not_found") {
    const reconciliation = provenance.reconciliation!;
    job.httpSubmissionCheckpoint = {
      revision: provenance.checkpointRevision!,
      stage: "reconciled_not_found",
      updatedAt: intent.terminal?.at ?? intent.updatedAt,
      submissionIntent: generationSubmissionIntent(job),
      reconciliation: { ...reconciliation, method: reconciliation.method as HttpGenerationSubmissionReconciliation["method"] },
    };
    job.remoteObservation = undefined;
  } else if (provenance.cause === "browser_submission_not_found") {
    const checkpoint = job.browserCheckpoint!;
    const reconciliation = provenance.reconciliation!;
    job.browserState = "submission_unknown";
    job.browserCheckpoint = {
      ...checkpoint,
      revision: provenance.checkpointRevision!,
      stage: "failed",
      updatedAt: intent.terminal?.at ?? intent.updatedAt,
      note: reason,
      submissionReconciliation: {
        method: reconciliation.method as BrowserSubmissionReconciliation["method"],
        result: "not_found",
        note: reconciliation.note,
        checkedAt: reconciliation.checkedAt,
      },
    };
    job.remoteObservation = undefined;
  } else if (provenance.cause === "remote_confirmed_failed") {
    observeRemote(job, "confirmed_failed", job.remoteObservation?.stage ?? "publish", reason, { observedStatus: "publication_failed" });
  } else if (intent.status === "cancelled") {
    job.remoteObservation = undefined;
    job.remoteResultUrl = undefined;
    job.isolatedDownloadPath = undefined;
    job.partialDownloadPath = undefined;
  }
  job.status = provenance.cause === "visual_rejected" ? "visual_rejected" : intent.status as "failed" | "cancelled";
  job.error = reason;
  job.updatedAt = intent.updatedAt;
}

function preserveGenerationPublicationConflict(job: GenerationJob, intent: PublicationIntent, reason: string): void {
  if (job.browserCheckpoint?.stage === "submission_unknown" || job.httpSubmissionCheckpoint?.stage === "submission_unknown" || job.comfyUiCheckpoint?.stage === "submission_unknown") job.status = "submission_unknown";
  else if (["submitted", "processing", "downloaded"].includes(job.browserCheckpoint?.stage ?? "")) job.status = "waiting_external";
  else if (job.externalTaskId || job.remoteResultUrl || job.remoteAcceptedAt || job.submissionIntent) job.status = "waiting_remote";
  job.error = `关联 Publication ${intent.status} 缺少与当前生成任务匹配的结构化终态来源；保持锁定并要求核对。${reason}`;
  if (!job.browserCheckpoint) observeRemote(job, "retryable_or_unknown", job.remoteObservation?.stage ?? "publish", job.error, { observedStatus: `untrusted_publication_${intent.status}`, nextAction: "inspect_publication" });
  job.updatedAt = new Date().toISOString();
}

async function projectGenerationPublicationState(projectRoot: string, job: GenerationJob, intent?: PublicationIntent): Promise<"none" | "registered" | "failed" | "cancelled" | "conflict"> {
  const publicationIntent = intent ?? (job.publicationIntentId ? await getPublicationIntent(projectRoot, job.publicationIntentId) : undefined);
  if (!publicationIntent) return "none";
  const bindingError = generationPublicationBindingError(publicationIntent, job);
  if (bindingError) {
    preserveGenerationPublicationConflict(job, publicationIntent, bindingError);
    return "conflict";
  }
  if (publicationIntent.status === "registered") {
    try {
      if (!await reconcileRegisteredGeneration(projectRoot, job)) {
        preserveGenerationPublicationConflict(job, publicationIntent, "已登记回执无法通过路径、哈希、尺寸或解码复验。 ");
        return "conflict";
      }
    } catch (error) {
      preserveGenerationPublicationConflict(job, publicationIntent, safeRemoteMessage(error));
      return "conflict";
    }
    job.status = "succeeded";
    job.error = undefined;
    observeRemote(job, "succeeded", "publish", "已按 Publication 权威回执恢复生成成功状态。", { observedStatus: "succeeded" });
    job.updatedAt = new Date().toISOString();
    return "registered";
  }
  if (publicationIntent.status === "reserved") return "none";
  const provenance = trustedGenerationTerminalProvenance(publicationIntent, job);
  if (!provenance) {
    preserveGenerationPublicationConflict(job, publicationIntent, "自由文本、旧版或修订不匹配的终态不能证明远端任务不存在。 ");
    return "conflict";
  }
  applyTrustedGenerationTerminal(job, publicationIntent, provenance);
  return publicationIntent.status;
}

async function finishGenerationPublication(
  projectRoot: string,
  job: GenerationJob,
  status: "failed" | "cancelled",
  reason: string,
  actor: "app" | "scanner" | "codex" | "user",
  cause: GenerationPublicationTerminalCause,
  options: { externalTaskId?: string; checkpointRevision?: number; reconciliation?: GenerationPublicationTerminalProvenance["reconciliation"] } = {},
): Promise<PublicationIntent> {
  if (!job.publicationIntentId || !job.publicationReservationToken || job.publicationReceiptId) throw new Error("生成任务缺少可关闭的 Publication 预留。 ");
  const intent = await getPublicationIntent(projectRoot, job.publicationIntentId);
  if (!intent) throw new Error(`找不到生成任务关联的发布意图：${job.publicationIntentId}`);
  const bindingError = generationPublicationBindingError(intent, job);
  if (bindingError) throw new Error(bindingError);
  if (job.publicationBundleId) {
    if (!job.companionPublicationIntentId || !job.companionPublicationReservationToken || !job.expectedCompanionPath || job.companionPublicationReceiptId) {
      throw new Error("生成任务的 raw/labeled Publication 事务缺少可关闭的 companion 预留。 ");
    }
    const companion = await getPublicationIntent(projectRoot, job.companionPublicationIntentId);
    if (!companion) throw new Error(`找不到生成任务关联的 companion 发布意图：${job.companionPublicationIntentId}`);
    if (intent.bundleId !== job.publicationBundleId || intent.bundleMember !== "primary"
      || companion.bundleId !== job.publicationBundleId || companion.bundleMember !== "companion"
      || companion.projectId !== job.projectId
      || companion.context.purpose !== "generation-output"
      || companion.context.jobId !== job.id
      || companion.context.itemId !== job.itemId
      || path.resolve(companion.targetPath) !== path.resolve(job.expectedCompanionPath)) {
      throw new Error("生成任务的 raw/labeled Publication 事务绑定不一致。 ");
    }
    if (intent.status !== "reserved" || companion.status !== "reserved") {
      const trusted = trustedGenerationTerminalProvenance(intent, job);
      if (intent.status === status && companion.status === status && trusted?.cause === cause) return intent;
      throw new Error(`关联 Publication 事务已是 ${intent.status}/${companion.status}，不能确认为 ${status}/${cause}。`);
    }
    const normalizedReason = reason.trim().length >= 3 ? reason.trim() : `${status === "failed" ? "生成失败" : "生成取消"}：${reason.trim() || "未提供详细原因"}`;
    const bundleInput = {
      bundleId: job.publicationBundleId,
      members: [
        { member: "primary" as const, intentId: intent.id, reservationToken: job.publicationReservationToken, expectedRevision: intent.revision },
        { member: "companion" as const, intentId: companion.id, reservationToken: job.companionPublicationReservationToken, expectedRevision: companion.revision },
      ],
      reason: normalizedReason,
      provenance: generationTerminalProvenance(job, cause, options),
    };
    try {
      const finished = status === "failed"
        ? await failPublicationBundle(projectRoot, bundleInput, actor)
        : await cancelPublicationBundle(projectRoot, bundleInput, actor);
      return finished.find((candidate) => candidate.bundleMember === "primary")!;
    } catch (error) {
      const latestPrimary = await getPublicationIntent(projectRoot, intent.id);
      const latestCompanion = await getPublicationIntent(projectRoot, companion.id);
      if (latestPrimary?.status === status && latestCompanion?.status === status && trustedGenerationTerminalProvenance(latestPrimary, job)?.cause === cause) return latestPrimary;
      throw error;
    }
  }
  if (intent.status !== "reserved") {
    const trusted = trustedGenerationTerminalProvenance(intent, job);
    if (intent.status === status && trusted?.cause === cause) return intent;
    throw new Error(`关联 Publication 已是 ${intent.status}，不能确认为 ${status}/${cause}。`);
  }
  const normalizedReason = reason.trim().length >= 3 ? reason.trim() : `${status === "failed" ? "生成失败" : "生成取消"}：${reason.trim() || "未提供详细原因"}`;
  const input = { intentId: intent.id, reservationToken: job.publicationReservationToken, expectedRevision: intent.revision, reason: normalizedReason, provenance: generationTerminalProvenance(job, cause, options) };
  try {
    return status === "failed" ? await failPublication(projectRoot, input, actor) : await cancelPublication(projectRoot, input, actor);
  } catch (error) {
    const latest = await getPublicationIntent(projectRoot, intent.id);
    if (latest?.status === status && trustedGenerationTerminalProvenance(latest, job)?.cause === cause) return latest;
    throw error;
  }
}

async function failGenerationPublication(projectRoot: string, job: GenerationJob, reason: string, actor: "app" | "scanner" | "codex" | "user", cause: Exclude<GenerationPublicationTerminalCause, "remote_cancel_confirmed" | "user_cancelled_before_submit">, options: { externalTaskId?: string; checkpointRevision?: number; reconciliation?: GenerationPublicationTerminalProvenance["reconciliation"] } = {}): Promise<PublicationIntent> {
  const intent = await finishGenerationPublication(projectRoot, job, "failed", reason, actor, cause, options);
  const provenance = trustedGenerationTerminalProvenance(intent, job);
  if (!provenance) throw new Error("Publication 已失败，但结构化生成终态来源无法与当前 Job 对齐；保持 Job 锁定。 ");
  applyTrustedGenerationTerminal(job, intent, provenance);
  return intent;
}

async function cancelGenerationPublication(projectRoot: string, job: GenerationJob, reason: string, actor: "app" | "scanner" | "codex" | "user", cause: "remote_cancel_confirmed" | "user_cancelled_before_submit", options: { externalTaskId?: string; checkpointRevision?: number } = {}): Promise<PublicationIntent> {
  const intent = await finishGenerationPublication(projectRoot, job, "cancelled", reason, actor, cause, options);
  const provenance = trustedGenerationTerminalProvenance(intent, job);
  if (!provenance) throw new Error("Publication 已取消，但结构化生成终态来源无法与当前 Job 对齐；保持 Job 锁定。 ");
  applyTrustedGenerationTerminal(job, intent, provenance);
  return intent;
}

function jsonValue(value: unknown, keyPath: string | undefined, fallbackPaths: string[]): unknown {
  const read = (candidate: string): unknown => candidate.split(".").filter(Boolean).reduce<unknown>((current, key) => {
    if (current && typeof current === "object") return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
  if (keyPath) return read(keyPath);
  for (const candidate of fallbackPaths) {
    const result = read(candidate);
    if (result !== undefined && result !== null) return result;
  }
  return undefined;
}

function normalizedValues(values: string[] | undefined, defaults: string[]): Set<string> {
  return new Set((values?.length ? values : defaults).map((value) => value.toLowerCase()));
}

function providerHeaders(provider: GenerationProvider, targetUrl: string, includeJson: boolean): Record<string, string> {
  const headers: Record<string, string> = { accept: includeJson ? "application/json" : "*/*" };
  if (includeJson) headers["content-type"] = "application/json";
  const targetOrigin = new URL(targetUrl).origin;
  const credentialOrigins = [provider.endpoint, provider.pollEndpoint?.replaceAll("{taskId}", "task")].filter((value): value is string => Boolean(value)).map((value) => new URL(value).origin);
  if (provider.apiKeyEnv && credentialOrigins.includes(targetOrigin)) {
    const key = process.env[provider.apiKeyEnv];
    if (!key) throw new Error(`环境变量 ${provider.apiKeyEnv} 未设置，无法调用 ${provider.name}。`);
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

async function responseJson(response: Response, provider: GenerationProvider): Promise<unknown> {
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new HttpResponseFailure(`${provider.name} HTTP ${response.status}：${detail || response.statusText}`, response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new HttpResponseFailure(`${provider.name} 返回的不是有效 JSON。`);
  }
}

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_COMFY_JSON_BYTES = 4 * 1024 * 1024;

function comfyUiCheckpoint(job: GenerationJob): ComfyUiGenerationCheckpoint {
  const checkpoint = job.comfyUiCheckpoint;
  if (!checkpoint || checkpoint.schemaVersion !== 1 || !canonicalUuid.test(checkpoint.promptId) || !stableGenerationId.test(checkpoint.clientId)) throw new Error("生成任务缺少可验证的 ComfyUI 稳定 promptId/clientId 检查点。 ");
  if (!/^[a-f0-9]{64}$/.test(checkpoint.workflowHash) || !/^[a-f0-9]{64}$/.test(checkpoint.submittedWorkflowHash)) throw new Error("ComfyUI 检查点工作流哈希无效。 ");
  if (!Number.isInteger(checkpoint.revision) || checkpoint.revision < 1) throw new Error("ComfyUI 检查点修订无效。 ");
  return checkpoint;
}

function advanceComfyUiCheckpoint(job: GenerationJob, stage: ComfyUiGenerationCheckpoint["stage"], patch: Partial<ComfyUiGenerationCheckpoint> = {}): ComfyUiGenerationCheckpoint {
  const previous = comfyUiCheckpoint(job);
  const next: ComfyUiGenerationCheckpoint = {
    ...previous,
    ...patch,
    schemaVersion: 1,
    revision: previous.revision + 1,
    stage,
    updatedAt: new Date().toISOString(),
  };
  job.comfyUiCheckpoint = next;
  return next;
}

function materializeComfyUiWorkflow(provider: GenerationProvider, job: GenerationJob): { prompt: Record<string, GenerationWorkflowJsonValue>; workflowHash: string; submittedWorkflowHash: string; binding: ComfyUiWorkflowBinding } {
  const workflowDefinition = job.executionSnapshot?.provider.workflow ?? provider.workflow;
  if (!workflowDefinition) throw new Error(`${provider.name} 缺少冻结的 ComfyUI 工作流。`);
  const normalized = normalizeGenerationWorkflow(workflowDefinition);
  if (normalized.workflow.format !== "comfyui-api" || !normalized.workflow.comfyUi) throw new Error(`${provider.name} 缺少 comfyui-api prompt/output 显式绑定。`);
  if (job.executionSnapshot?.workflowHash && normalized.hash !== job.executionSnapshot.workflowHash) throw new Error("ComfyUI 工作流已偏离任务执行快照。 ");
  const prompt = structuredClone(normalized.workflow.definition);
  const nodes = Object.entries(prompt);
  if (!nodes.length || nodes.length > 500) throw new Error("ComfyUI API 工作流节点数必须为 1–500。 ");
  for (const [nodeId, value] of nodes) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`ComfyUI API 节点 ${nodeId} 必须是对象。`);
    const node = value as Record<string, GenerationWorkflowJsonValue>;
    if (typeof node.class_type !== "string" || !node.class_type.trim()) throw new Error(`ComfyUI API 节点 ${nodeId} 缺少 class_type。`);
    if (!node.inputs || typeof node.inputs !== "object" || Array.isArray(node.inputs)) throw new Error(`ComfyUI API 节点 ${nodeId} 缺少 inputs 对象。`);
  }
  for (const binding of normalized.workflow.comfyUi.promptInputs) {
    const node = prompt[binding.nodeId] as Record<string, GenerationWorkflowJsonValue>;
    const inputs = node.inputs as Record<string, GenerationWorkflowJsonValue>;
    inputs[binding.inputName] = job.prompt;
  }
  return {
    prompt,
    workflowHash: normalized.hash,
    submittedWorkflowHash: sha256Json(prompt),
    binding: normalized.workflow.comfyUi,
  };
}

async function prepareComfyUiSubmission(projectRoot: string, provider: GenerationProvider, job: GenerationJob): Promise<void> {
  const materialized = materializeComfyUiWorkflow(provider, job);
  const requestPath = path.join(getSidecarPaths(projectRoot).generationRequests, `${job.id}.comfyui.json`);
  const existing = job.comfyUiCheckpoint;
  if (existing) {
    const checkpoint = comfyUiCheckpoint(job);
    if (checkpoint.clientId !== (job.clientJobId ?? job.id) || checkpoint.workflowHash !== materialized.workflowHash || checkpoint.submittedWorkflowHash !== materialized.submittedWorkflowHash || checkpoint.requestPath !== requestPath || checkpoint.outputNodeId !== materialized.binding.outputNodeId || checkpoint.outputIndex !== materialized.binding.outputIndex) throw new Error("ComfyUI 物化工作流或绑定已偏离持久检查点；拒绝重建或重提。 ");
  } else {
    const now = new Date().toISOString();
    job.comfyUiCheckpoint = {
      schemaVersion: 1,
      revision: 1,
      stage: "prepared",
      updatedAt: now,
      clientId: job.clientJobId ?? job.id,
      promptId: randomUUID(),
      workflowHash: materialized.workflowHash,
      submittedWorkflowHash: materialized.submittedWorkflowHash,
      requestPath,
      outputNodeId: materialized.binding.outputNodeId,
      outputIndex: materialized.binding.outputIndex,
    };
  }
  const checkpoint = comfyUiCheckpoint(job);
  await writeJsonAtomic(requestPath, {
    schemaVersion: 1,
    jobId: job.id,
    providerId: provider.id,
    clientId: checkpoint.clientId,
    promptId: checkpoint.promptId,
    workflowHash: checkpoint.workflowHash,
    submittedWorkflowHash: checkpoint.submittedWorkflowHash,
    outputNodeId: checkpoint.outputNodeId,
    outputIndex: checkpoint.outputIndex,
    prompt: materialized.prompt,
  });
  job.requestPath = requestPath;
}

async function limitedResponseText(response: Response, maximumBytes = MAX_COMFY_JSON_BYTES): Promise<string> {
  if (!response.body) return "";
  const chunks: Buffer[] = [];
  let bytes = 0;
  const stream = Readable.fromWeb(response.body as never);
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) {
      stream.destroy();
      throw new Error(`ComfyUI JSON 响应超过 ${maximumBytes} 字节上限。`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function comfyUiFetch(provider: GenerationProvider, pathname: string, init: RequestInit = {}): Promise<{ response: Response; url: URL }> {
  const base = validatedComfyUiEndpoint(provider, provider.endpoint!);
  const url = new URL(pathname, `${base.origin}/`);
  if (url.origin !== base.origin) throw new Error("ComfyUI 协议请求越过冻结的 loopback origin。 ");
  const response = await fetch(url, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(120_000) });
  return { response, url };
}

async function comfyUiJson(provider: GenerationProvider, pathname: string, init: RequestInit = {}): Promise<unknown> {
  const { response } = await comfyUiFetch(provider, pathname, init);
  const text = await limitedResponseText(response);
  if (!response.ok) throw new HttpResponseFailure(`${provider.name} ${pathname} HTTP ${response.status}：${safeRemoteMessage(text || response.statusText)}`, response.status);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpResponseFailure(`${provider.name} ${pathname} 返回的不是有效 JSON。`, response.status);
  }
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function preflightComfyUiJson(provider: GenerationProvider, pathname: string): Promise<unknown> {
  try {
    return await comfyUiJson(provider, pathname);
  } catch (error) {
    const status = errorHttpStatus(error);
    const deterministicClientFailure = status !== undefined && status >= 400 && status < 500 && ![408, 425, 429].includes(status);
    if (deterministicClientFailure) throw error;
    throw new ComfyUiRetryablePreflightFailure(`ComfyUI 预检 ${pathname} 暂时不可确认：${safeRemoteMessage(error)}`, status);
  }
}

async function preflightComfyUi(projectRoot: string, provider: GenerationProvider, job: GenerationJob, jobs: GenerationJob[]): Promise<ComfyUiPreflightEvidence> {
  const checkpoint = comfyUiCheckpoint(job);
  if (checkpoint.preflight) return checkpoint.preflight;
  const materialized = materializeComfyUiWorkflow(provider, job);
  const systemStats = await preflightComfyUiJson(provider, "/system_stats");
  const features = await preflightComfyUiJson(provider, "/features");
  const classTypes = [...new Set(Object.values(materialized.prompt).map((node) => String((node as Record<string, GenerationWorkflowJsonValue>).class_type)))].sort();
  const nodeDefinitions: ComfyUiPreflightEvidence["nodeDefinitions"] = [];
  for (const classType of classTypes) {
    const definition = await preflightComfyUiJson(provider, `/object_info/${encodeURIComponent(classType)}`);
    if (!recordObject(definition)?.[classType]) throw new Error(`ComfyUI 本机服务缺少工作流节点定义 ${classType}。`);
    nodeDefinitions.push({ classType, sha256: sha256Json(definition) });
  }
  const evidence: ComfyUiPreflightEvidence = {
    checkedAt: new Date().toISOString(),
    observedOrigin: new URL(provider.endpoint!).origin,
    comfyUiVersion: shortText(jsonValue(systemStats, undefined, ["system.comfyui_version", "system.comfyuiVersion", "comfyui_version"]), "ComfyUI 版本", 200),
    systemStatsSha256: sha256Json(systemStats),
    featuresSha256: sha256Json(features),
    nodeDefinitions,
  };
  advanceComfyUiCheckpoint(job, checkpoint.stage, { preflight: evidence });
  job.updatedAt = new Date().toISOString();
  await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
  return evidence;
}

type ComfyUiObservation =
  | { state: "absent" }
  | { state: "pending" | "running"; queueNumber?: number }
  | { state: "history_failed"; status: string; message: string; interrupted: boolean; evidence: ComfyUiHistoryEvidence }
  | { state: "history_succeeded"; entry: Record<string, unknown>; historySha256: string; evidence: ComfyUiHistoryEvidence };

function queuePromptId(entry: unknown): string | undefined {
  if (Array.isArray(entry)) return typeof entry[1] === "string" ? entry[1] : undefined;
  const object = recordObject(entry);
  return typeof object?.prompt_id === "string" ? object.prompt_id : typeof object?.id === "string" ? object.id : undefined;
}

function queueNumber(entry: unknown): number | undefined {
  if (Array.isArray(entry) && typeof entry[0] === "number" && Number.isFinite(entry[0])) return entry[0];
  const object = recordObject(entry);
  return typeof object?.number === "number" && Number.isFinite(object.number) ? object.number : undefined;
}

function validateComfyUiPromptTuple(job: GenerationJob, tupleValue: unknown): Omit<ComfyUiHistoryEvidence, "historySha256" | "eventName" | "observedAt"> {
  const checkpoint = comfyUiCheckpoint(job);
  const intent = generationSubmissionIntent(job);
  if (!Array.isArray(tupleValue) || tupleValue.length < 5) throw new ComfyUiOutputIdentityFailure("ComfyUI history/queue 缺少官方 prompt 5-tuple；保持任务锁定。 ");
  if (tupleValue[1] !== checkpoint.promptId) throw new ComfyUiOutputIdentityFailure("ComfyUI prompt tuple 的 promptId 与持久检查点不一致；保持任务锁定。 ");
  if (!recordObject(tupleValue[2]) || sha256Json(tupleValue[2]) !== checkpoint.submittedWorkflowHash) throw new ComfyUiOutputIdentityFailure("ComfyUI prompt tuple 的物化工作流哈希发生漂移；保持任务锁定。 ");
  const extraData = recordObject(tupleValue[3]);
  const tag = recordObject(extraData?.aicanvas);
  if (extraData?.client_id !== checkpoint.clientId
    || tag?.generationJobId !== job.id
    || tag?.clientJobId !== intent.clientJobId
    || tag?.attempt !== intent.attempt
    || tag?.workflowHash !== checkpoint.workflowHash
    || tag?.submittedWorkflowHash !== checkpoint.submittedWorkflowHash
    || tag?.outputNodeId !== checkpoint.outputNodeId
    || tag?.outputIndex !== checkpoint.outputIndex) {
    throw new ComfyUiOutputIdentityFailure("ComfyUI prompt tuple 的 client/attempt/workflow/output 所有权标签不匹配；保持任务锁定。 ");
  }
  const outputsToExecute = Array.isArray(tupleValue[4]) ? tupleValue[4] : [];
  if (!outputsToExecute.includes(checkpoint.outputNodeId)) throw new ComfyUiOutputIdentityFailure(`ComfyUI prompt tuple 未声明绑定输出节点 ${checkpoint.outputNodeId}；保持任务锁定。`);
  return {
    generationJobId: job.id,
    promptId: checkpoint.promptId,
    clientId: checkpoint.clientId,
    clientJobId: intent.clientJobId,
    attempt: intent.attempt,
    workflowHash: checkpoint.workflowHash,
    submittedWorkflowHash: checkpoint.submittedWorkflowHash,
    outputNodeId: checkpoint.outputNodeId,
    outputIndex: checkpoint.outputIndex,
  };
}

function exactComfyUiTerminalEvents(status: Record<string, unknown> | undefined, promptId: string): Array<{ name: ComfyUiHistoryEvidence["eventName"]; payload: Record<string, unknown> }> {
  const messages = Array.isArray(status?.messages) ? status.messages : [];
  return messages.flatMap((message) => {
    if (!Array.isArray(message) || message.length < 2) return [];
    const name = message[0];
    const payload = recordObject(message[1]);
    if (!(name === "execution_success" || name === "execution_error" || name === "execution_interrupted") || payload?.prompt_id !== promptId) return [];
    return [{ name, payload }];
  });
}

function assertComfyUiHistoryEvidenceStable(checkpoint: ComfyUiGenerationCheckpoint, evidence: ComfyUiHistoryEvidence): void {
  if (checkpoint.history && (checkpoint.history.historySha256 !== evidence.historySha256 || checkpoint.history.eventName !== evidence.eventName)) {
    throw new ComfyUiOutputIdentityFailure("同一 ComfyUI promptId 的 history 内容或终态事件发生漂移；保持任务与 Publication 锁定。 ");
  }
}

function assertComfyUiQueueEntryOwnership(job: GenerationJob, entry: unknown): void {
  validateComfyUiPromptTuple(job, entry);
}

async function inspectComfyUiPrompt(provider: GenerationProvider, job: GenerationJob): Promise<ComfyUiObservation> {
  const checkpoint = comfyUiCheckpoint(job);
  const promptId = checkpoint.promptId;
  const historyPayload = await comfyUiJson(provider, `/history/${encodeURIComponent(promptId)}`);
  const historyObject = recordObject(historyPayload);
  const entry = recordObject(historyObject?.[promptId]);
  if (!entry && historyObject && Object.keys(historyObject).length) throw new ComfyUiOutputIdentityFailure("ComfyUI history 返回了非目标 promptId 的条目；保持任务锁定。 ");
  if (entry) {
    const ownership = validateComfyUiPromptTuple(job, entry.prompt);
    const historySha256 = sha256Json(entry);
    const status = recordObject(entry.status);
    const statusString = String(status?.status_str ?? status?.status ?? "").toLowerCase();
    const completed = status?.completed === true;
    const terminalEvents = exactComfyUiTerminalEvents(status, promptId);
    const eventNames = [...new Set(terminalEvents.map((event) => event.name))];
    if (eventNames.length > 1) throw new ComfyUiOutputIdentityFailure("ComfyUI history 同时包含互相矛盾的终态事件；保持任务锁定。 ");
    const eventName = eventNames[0];
    if (completed && ["success", "succeeded", "completed"].includes(statusString)) {
      if (eventName !== "execution_success") throw new ComfyUiOutputIdentityFailure("ComfyUI history 声称成功但缺少同 promptId 的 exact execution_success；保持任务锁定。 ");
      const evidence: ComfyUiHistoryEvidence = { ...ownership, historySha256, eventName, observedAt: new Date().toISOString() };
      assertComfyUiHistoryEvidenceStable(checkpoint, evidence);
      return { state: "history_succeeded", entry, historySha256, evidence };
    }
    if (["error", "failed", "cancelled", "canceled", "interrupted"].includes(statusString) || eventName === "execution_error" || eventName === "execution_interrupted") {
      if (eventName !== "execution_error" && eventName !== "execution_interrupted") throw new ComfyUiOutputIdentityFailure("ComfyUI history 声称失败但缺少同 promptId 的 exact terminal event；保持任务锁定。 ");
      const evidence: ComfyUiHistoryEvidence = { ...ownership, historySha256, eventName, observedAt: new Date().toISOString() };
      assertComfyUiHistoryEvidenceStable(checkpoint, evidence);
      const interrupted = eventName === "execution_interrupted";
      return { state: "history_failed", status: interrupted ? "interrupted" : statusString || "error", message: safeRemoteMessage(stableJson(status?.messages ?? [])), interrupted, evidence };
    }
    throw new ComfyUiOutputIdentityFailure("ComfyUI history 条目没有可归属的明确终态；保持任务锁定。 ");
  }
  const queuePayload = recordObject(await comfyUiJson(provider, "/queue"));
  const runningEntries = Array.isArray(queuePayload?.queue_running) ? queuePayload.queue_running : [];
  const pendingEntries = Array.isArray(queuePayload?.queue_pending) ? queuePayload.queue_pending : [];
  const running = runningEntries.find((candidate) => queuePromptId(candidate) === promptId);
  const pending = pendingEntries.find((candidate) => queuePromptId(candidate) === promptId);
  if (running && pending) throw new Error("同一 ComfyUI promptId 同时出现在 running 与 pending 队列，拒绝自动处理。 ");
  if (running) {
    assertComfyUiQueueEntryOwnership(job, running);
    return { state: "running", queueNumber: queueNumber(running) };
  }
  if (pending) {
    assertComfyUiQueueEntryOwnership(job, pending);
    return { state: "pending", queueNumber: queueNumber(pending) };
  }
  return { state: "absent" };
}

function comfyUiOutputIdentity(checkpoint: ComfyUiGenerationCheckpoint, entry: Record<string, unknown>, historySha256: string): ComfyUiOutputIdentity {
  const outputs = recordObject(entry.outputs);
  const node = recordObject(outputs?.[checkpoint.outputNodeId]);
  const images = Array.isArray(node?.images) ? node.images : undefined;
  const descriptor = images ? recordObject(images[checkpoint.outputIndex]) : undefined;
  if (!descriptor) throw new ComfyUiOutputIdentityFailure(`ComfyUI history 成功但输出节点 ${checkpoint.outputNodeId}.images[${checkpoint.outputIndex}] 不存在；保持任务锁定。`);
  const filename = typeof descriptor.filename === "string" ? descriptor.filename.trim() : "";
  const subfolder = typeof descriptor.subfolder === "string" ? descriptor.subfolder.trim() : "";
  const type = typeof descriptor.type === "string" ? descriptor.type.trim() : "";
  if (!filename || filename.length > 255 || filename === "." || filename === ".." || /[\\/\0]/.test(filename)) throw new ComfyUiOutputIdentityFailure("ComfyUI history 返回了不安全的输出文件名；保持任务锁定。 ");
  if (subfolder.length > 500 || subfolder.includes("\\") || path.posix.isAbsolute(subfolder) || subfolder.split("/").some((segment) => segment === ".." || segment === "." || segment.includes("\0"))) throw new ComfyUiOutputIdentityFailure("ComfyUI history 返回了不安全的输出子目录；保持任务锁定。 ");
  if (type !== "output") throw new ComfyUiOutputIdentityFailure(`ComfyUI 输出身份 type=${type || "缺失"}，只允许 output，不能发布 input/temp 文件。`);
  const identity: ComfyUiOutputIdentity = { promptId: checkpoint.promptId, nodeId: checkpoint.outputNodeId, index: checkpoint.outputIndex, filename, subfolder, type: "output", historySha256 };
  if (checkpoint.output) {
    if (stableJson(checkpoint.output) !== stableJson(identity)) throw new ComfyUiOutputIdentityFailure("同一 ComfyUI promptId 的 history 哈希、输出节点或文件身份发生漂移；拒绝自动下载或覆盖。 ");
    return checkpoint.output;
  }
  return identity;
}

function bindComfyUiPromptIdentity(job: GenerationJob, checkpoint: ComfyUiGenerationCheckpoint): void {
  if (job.externalTaskId && job.externalTaskId !== checkpoint.promptId) throw new ComfyUiOutputIdentityFailure("ComfyUI promptId 与已有 externalTaskId 冲突；保持任务锁定。 ");
  job.externalTaskId = checkpoint.promptId;
  job.remoteAcceptedAt ??= new Date().toISOString();
}

function historyInterruptedCancellationEvidence(checkpoint: ComfyUiGenerationCheckpoint, evidence: ComfyUiHistoryEvidence): ComfyUiCancellationEvidence {
  const observedAt = evidence.observedAt;
  const observation: ComfyUiCancellationObservation = { state: "history_interrupted", observedAt, historySha256: evidence.historySha256, eventName: evidence.eventName };
  const existing = checkpoint.cancellation;
  return {
    requestedAt: existing?.requestedAt ?? observedAt,
    promptId: checkpoint.promptId,
    preObservedState: existing?.preObservedState ?? "unknown",
    endpoint: existing?.endpoint ?? "history_observation",
    attempt: existing?.attempt ?? 0,
    responseReceivedAt: existing?.responseReceivedAt,
    httpStatus: existing?.httpStatus,
    responseSha256: existing?.responseSha256,
    outcome: existing?.outcome ?? "acted",
    serverActed: existing?.serverActed ?? true,
    observations: [...(existing?.observations ?? []), observation],
    confirmation: { kind: "history_interrupted", confirmedAt: observedAt, historySha256: evidence.historySha256, eventName: "execution_interrupted" },
  };
}

async function persistComfyUiRemoteIdentity(projectRoot: string, jobs: GenerationJob[], job: GenerationJob, state: "pending" | "running", queuePosition?: number): Promise<void> {
  const checkpoint = comfyUiCheckpoint(job);
  bindComfyUiPromptIdentity(job, checkpoint);
  job.status = "waiting_remote";
  job.error = undefined;
  advanceComfyUiCheckpoint(job, state === "pending" ? "queued" : "running", { queueNumber: queuePosition });
  observeRemote(job, "pending", "poll", state === "pending" ? "ComfyUI prompt 已在 pending 队列，后续只查询同一 promptId。" : "ComfyUI prompt 正在运行，后续只查询同一 promptId。", { observedStatus: state, nextAction: "poll_same_task" });
  job.updatedAt = new Date().toISOString();
  await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
}

async function pollComfyUiJob(projectRoot: string, provider: GenerationProvider, job: GenerationJob, jobs: GenerationJob[]): Promise<boolean> {
  const checkpoint = comfyUiCheckpoint(job);
  job.pollAttempts = (job.pollAttempts ?? 0) + 1;
  observeRemote(job, "pending", "poll", "正在从 ComfyUI history/queue 恢复已持久化的 promptId，不会重新 POST。", { nextAction: "poll_same_task" });
  const observation = await inspectComfyUiPrompt(provider, job);
  if (observation.state === "pending" || observation.state === "running") {
    await persistComfyUiRemoteIdentity(projectRoot, jobs, job, observation.state, observation.queueNumber);
    return false;
  }
  if (observation.state === "absent") {
    if (job.status === "submission_unknown") advanceComfyUiCheckpoint(job, "submission_unknown");
    job.error = "ComfyUI queue/history 尚未观察到已持久化 promptId；提交结果保持不明，绝不自动重 POST。";
    observeRemote(job, "retryable_or_unknown", "poll", job.error, { nextAction: "inspect_remote_task" });
    job.updatedAt = new Date().toISOString();
    await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
    return false;
  }
  if (observation.state === "history_failed") {
    bindComfyUiPromptIdentity(job, checkpoint);
    if (observation.interrupted) {
      advanceComfyUiCheckpoint(job, "cancelled", { history: observation.evidence, cancellation: historyInterruptedCancellationEvidence(checkpoint, observation.evidence) });
      job.updatedAt = new Date().toISOString();
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
      throw new ConfirmedRemoteCancellation(`${provider.name} history 确认同一 promptId 已被中断。`);
    }
    advanceComfyUiCheckpoint(job, "history_failed", { history: observation.evidence });
    job.updatedAt = new Date().toISOString();
    await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
    throw new ConfirmedRemoteFailure(`${provider.name} history 确认执行失败：${observation.status} ${observation.message}`, observation.status);
  }
  if (observation.state !== "history_succeeded") throw new Error("无法识别 ComfyUI queue/history 观测状态。 ");
  bindComfyUiPromptIdentity(job, checkpoint);
  job.status = "waiting_remote";
  observeRemote(job, "pending", "validation", "ComfyUI history 已完成，正在验证绑定的输出节点与文件身份。", { observedStatus: "success", nextAction: "inspect_remote_task" });
  const identity = comfyUiOutputIdentity(checkpoint, observation.entry, observation.historySha256);
  advanceComfyUiCheckpoint(job, "history_succeeded", { history: observation.evidence, output: identity });
  const viewUrl = new URL("/view", `${provider.endpoint!.replace(/\/$/, "")}/`);
  viewUrl.searchParams.set("filename", identity.filename);
  viewUrl.searchParams.set("subfolder", identity.subfolder);
  viewUrl.searchParams.set("type", identity.type);
  advanceComfyUiCheckpoint(job, "downloading", { history: observation.evidence, output: identity });
  job.updatedAt = new Date().toISOString();
  await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
  const completed = await recoverHttpDownload(projectRoot, provider, job, viewUrl.toString(), jobs);
  if (completed) advanceComfyUiCheckpoint(job, "verified", { history: observation.evidence, output: identity });
  return completed;
}

async function submitComfyUiJob(projectRoot: string, provider: GenerationProvider, job: GenerationJob, jobs: GenerationJob[]): Promise<boolean> {
  await preflightComfyUi(projectRoot, provider, job, jobs);
  let checkpoint = comfyUiCheckpoint(job);
  const request = await readJson<Record<string, unknown> | null>(checkpoint.requestPath, null);
  if (!request || request.promptId !== checkpoint.promptId || request.clientId !== checkpoint.clientId || request.submittedWorkflowHash !== checkpoint.submittedWorkflowHash || !recordObject(request.prompt)) throw new Error("ComfyUI 提交请求文件缺失或偏离持久检查点。 ");
  advanceComfyUiCheckpoint(job, "posting", { postAttemptedAt: new Date().toISOString() });
  job.updatedAt = new Date().toISOString();
  await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
  checkpoint = comfyUiCheckpoint(job);
  const submissionIntent = generationSubmissionIntent(job);
  try {
    const { response } = await comfyUiFetch(provider, "/prompt", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        prompt: request.prompt,
        client_id: checkpoint.clientId,
        prompt_id: checkpoint.promptId,
        extra_data: {
          aicanvas: {
            generationJobId: job.id,
            clientJobId: submissionIntent.clientJobId,
            attempt: submissionIntent.attempt,
            workflowHash: checkpoint.workflowHash,
            submittedWorkflowHash: checkpoint.submittedWorkflowHash,
            outputNodeId: checkpoint.outputNodeId,
            outputIndex: checkpoint.outputIndex,
          },
        },
      }),
    });
    const responseText = await limitedResponseText(response);
    let data: Record<string, unknown> | undefined;
    try { data = responseText ? recordObject(JSON.parse(responseText)) : undefined; } catch { /* 由下方按提交不明处理 */ }
    if (response.status === 400) throw new ConfirmedRemoteFailure(`${provider.name} 拒绝工作流：${safeRemoteMessage(responseText || "HTTP 400")}`, "validation_error");
    if (!response.ok) throw new HttpResponseFailure(`${provider.name} /prompt HTTP ${response.status}：${safeRemoteMessage(responseText || response.statusText)}`, response.status);
    if (!data) throw new HttpResponseFailure(`${provider.name} /prompt 返回的不是有效 JSON。`, response.status);
    const nodeErrors = recordObject(data.node_errors);
    if (nodeErrors && Object.keys(nodeErrors).length) throw new ConfirmedRemoteFailure(`${provider.name} 返回工作流节点校验错误：${safeRemoteMessage(stableJson(nodeErrors))}`, "validation_error");
    if (data.prompt_id !== checkpoint.promptId) throw new Error(`${provider.name} 为同一提交返回了不同 prompt_id；只保留预先持久化的 ID 并转入对账。`);
    job.externalTaskId = checkpoint.promptId;
    job.remoteAcceptedAt ??= new Date().toISOString();
    job.status = "waiting_remote";
    job.error = undefined;
    advanceComfyUiCheckpoint(job, "queued", { queueNumber: typeof data.number === "number" ? data.number : undefined });
    observeRemote(job, "pending", "submit", "ComfyUI 已确认同一 promptId；后续只查询 queue/history。", { observedStatus: "queued", nextAction: "poll_same_task" });
    job.updatedAt = new Date().toISOString();
    await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
    return false;
  } catch (error) {
    if (error instanceof ConfirmedRemoteFailure) throw error;
    advanceComfyUiCheckpoint(job, "submission_unknown");
    job.status = "submission_unknown";
    job.error = safeRemoteMessage(error);
    observeRemote(job, "retryable_or_unknown", "submit", job.error, { httpStatus: errorHttpStatus(error), nextAction: "inspect_remote_task" });
    job.updatedAt = new Date().toISOString();
    await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
    try {
      const completed = await pollComfyUiJob(projectRoot, provider, job, jobs);
      if (completed || Boolean(job.externalTaskId)) return completed;
    } catch (recoveryError) {
      job.error = `${safeRemoteMessage(error)}；queue/history 对账失败：${safeRemoteMessage(recoveryError)}`;
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
    }
    throw error;
  }
}

async function persistHttpRemoteIdentity(
  projectRoot: string,
  jobs: GenerationJob[],
  job: GenerationJob,
  stage: GenerationRemoteObservationStage,
  observedStatus?: string,
): Promise<void> {
  job.clientJobId ??= job.id;
  job.remoteAcceptedAt ??= new Date().toISOString();
  job.status = "waiting_remote";
  job.updatedAt = new Date().toISOString();
  observeRemote(job, "pending", stage, stage === "submit" ? "供应商已返回稳定任务身份；后续只恢复同一任务。" : "已观察到远端结果地址；后续只恢复同一任务。", { observedStatus });
  await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
  await appendEvent(projectRoot, {
    actor: "app",
    type: "generation.remote-identity-persisted",
    itemId: job.itemId,
    data: { jobId: job.id, providerId: job.providerId, clientJobId: job.clientJobId, externalTaskId: job.externalTaskId, hasResultUrl: Boolean(job.remoteResultUrl), stage },
  });
}

async function submitHttpJob(projectRoot: string, provider: GenerationProvider, job: GenerationJob, jobs: GenerationJob[]): Promise<boolean> {
  const payload = {
    model: job.model,
    type: job.kind,
    prompt: job.prompt,
    parameters: job.parameters,
    reference_files: job.referencePaths.map((filePath) => path.basename(filePath)),
    reference_count: job.referencePaths.length,
    execution_snapshot_hash: job.executionSnapshot?.snapshotHash,
    workflow_hash: job.executionSnapshot?.workflowHash,
    ...(job.executionSnapshot?.provider.workflow ? { workflow: job.executionSnapshot.provider.workflow } : {}),
    ...(provider.sendLocalPaths ? { reference_paths: job.referencePaths, output_path: job.expectedOutputPath } : {}),
    client_job_id: job.clientJobId ?? job.id,
  };
  const response = await fetch(provider.endpoint!, { method: "POST", headers: providerHeaders(provider, provider.endpoint!, true), body: JSON.stringify(payload), signal: AbortSignal.timeout(120_000) });
  const data = await responseJson(response, provider);
  const status = String(jsonValue(data, provider.statusPath, ["status", "data.status"]) ?? "").toLowerCase();
  const failureValues = normalizedValues(provider.failureValues, ["failed", "error", "cancelled"]);
  if (failureValues.has(status)) throw new ConfirmedRemoteFailure(`${provider.name} 拒绝生成任务，状态：${status}`, status);
  const resultUrl = jsonValue(data, provider.resultUrlPath, ["result_url", "url", "data.result_url", "data.url", "data.0.url"]);
  const externalTaskId = jsonValue(data, provider.taskIdPath, ["id", "task_id", "data.id", "data.task_id"]);
  if (externalTaskId !== undefined) {
    const candidate = String(externalTaskId);
    if (job.externalTaskId && job.externalTaskId !== candidate) throw new Error(`${provider.name} 为同一任务返回了不同 externalTaskId，已停止自动处理。`);
    job.externalTaskId = candidate;
  }
  let resultUrlValidationError: unknown;
  if (typeof resultUrl === "string" && resultUrl) {
    try { job.remoteResultUrl = allowedResultUrl(provider, resultUrl, "结果地址").toString(); }
    catch (error) { resultUrlValidationError = error; }
  }
  if (job.externalTaskId || job.remoteResultUrl) await persistHttpRemoteIdentity(projectRoot, jobs, job, "submit", status || undefined);
  if (resultUrlValidationError) throw resultUrlValidationError;
  if (process.env.AI_CANVAS_TEST_GENERATION_CRASH_AFTER_REMOTE_ACCEPT === job.id) throw new Error("TEST_ONLY_CRASH_AFTER_REMOTE_ACCEPT");
  if (job.remoteResultUrl) return recoverHttpDownload(projectRoot, provider, job, job.remoteResultUrl, jobs);
  if (!job.externalTaskId) throw new Error(`${provider.name} 未返回任务 ID 或结果 URL。`);
  return false;
}

async function pollHttpJob(projectRoot: string, provider: GenerationProvider, job: GenerationJob, jobs: GenerationJob[]): Promise<boolean> {
  if (job.remoteResultUrl) return recoverHttpDownload(projectRoot, provider, job, job.remoteResultUrl, jobs);
  if (!job.externalTaskId) throw new Error("远端轮询任务缺少 externalTaskId 和可恢复结果地址。");
  const template = provider.pollEndpoint || `${provider.endpoint!.replace(/\/$/, "")}/{taskId}`;
  const url = template.replaceAll("{taskId}", encodeURIComponent(job.externalTaskId));
  job.pollAttempts = (job.pollAttempts ?? 0) + 1;
  observeRemote(job, "pending", "poll", "正在轮询已持久化的远端任务，不会重新 POST。", { nextAction: "poll_same_task" });
  const response = await fetch(url, { method: "GET", headers: providerHeaders(provider, url, false), signal: AbortSignal.timeout(120_000) });
  const data = await responseJson(response, provider);
  const status = String(jsonValue(data, provider.statusPath, ["status", "data.status"]) ?? "").toLowerCase();
  const successValues = normalizedValues(provider.successValues, ["succeeded", "completed", "success", "done"]);
  const failureValues = normalizedValues(provider.failureValues, ["failed", "error", "cancelled"]);
  if (failureValues.has(status)) throw new ConfirmedRemoteFailure(`${provider.name} 生成失败，状态：${status}`, status);
  if (!successValues.has(status)) {
    job.error = undefined;
    observeRemote(job, "pending", "poll", `供应商任务仍在等待或处理中：${status || "未返回状态"}`, { observedStatus: status || undefined, nextAction: "poll_same_task" });
    return false;
  }
  const resultUrl = jsonValue(data, provider.resultUrlPath, ["result_url", "url", "data.result_url", "data.url", "data.0.url"]);
  if (typeof resultUrl !== "string" || !resultUrl) throw new Error(`${provider.name} 已完成但未返回结果 URL。`);
  job.remoteResultUrl = allowedResultUrl(provider, resultUrl, "结果地址").toString();
  await persistHttpRemoteIdentity(projectRoot, jobs, job, "download", status || undefined);
  return recoverHttpDownload(projectRoot, provider, job, job.remoteResultUrl, jobs);
}

function allowedResultUrl(provider: GenerationProvider, value: string, label: string): URL {
  const resultUrl = validatedHttpUrl(provider, value, label);
  const endpointOrigin = new URL(provider.endpoint!).origin;
  const allowedHost = resultUrl.origin === endpointOrigin || (provider.allowedResultHosts ?? []).includes(resultUrl.hostname.toLowerCase());
  if (!allowedHost) throw new Error(`${provider.name} 的${label}指向当前任务冻结配置未授权域名 ${resultUrl.hostname}；当前任务不会重提，请在供应商侧提供已授权结果地址或进行人工对账。`);
  return resultUrl;
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath).then((metadata) => metadata.isFile()).catch((error) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
}

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishIsolatedHttpResult(job: GenerationJob, isolatedPath: string, inspected: { size: number; magic: string; sha256: string }): Promise<void> {
  await mkdir(path.dirname(job.expectedOutputPath), { recursive: true });
  const temporary = path.join(path.dirname(job.expectedOutputPath), `.${path.basename(job.expectedOutputPath)}.${job.id}.publish.tmp`);
  await unlink(temporary).catch((error) => {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  if (await pathExists(job.expectedOutputPath)) {
    let existing: { size: number; magic: string; sha256: string };
    try { existing = await validateGeneratedResultFile(job, job.expectedOutputPath); }
    catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      throw new PublicationOutputConflict(`预期输出路径已经存在但无法完整验收，拒绝覆盖：${safeRemoteMessage(error)}`);
    }
    if (existing.sha256 !== inspected.sha256 || existing.size !== inspected.size) throw new PublicationOutputConflict("预期输出路径已经存在且内容不同，拒绝覆盖；保留隔离结果等待人工处理。 ");
    job.resultPath = job.expectedOutputPath;
    job.resultMagic = inspected.magic;
    job.resultSha256 = inspected.sha256;
    return;
  }
  try {
    await copyFile(isolatedPath, temporary, constants.COPYFILE_EXCL);
    await fsyncFile(temporary);
    await link(temporary, job.expectedOutputPath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  let published: { size: number; magic: string; sha256: string };
  try { published = await validateGeneratedResultFile(job, job.expectedOutputPath); }
  catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new PublicationOutputConflict(`不可覆盖发布时最终路径被其他内容占用且无法完整验收：${safeRemoteMessage(error)}`);
  }
  if (published.sha256 !== inspected.sha256 || published.size !== inspected.size) throw new PublicationOutputConflict("不可覆盖发布后的文件与隔离结果不一致；保留隔离结果等待人工核对。 ");
  job.resultPath = job.expectedOutputPath;
  job.resultMagic = inspected.magic;
  job.resultSha256 = inspected.sha256;
}

async function fetchAllowedResult(provider: GenerationProvider, initialUrl: URL): Promise<Response> {
  let current = initialUrl;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const response = await fetch(current, { headers: providerHeaders(provider, current.toString(), false), signal: AbortSignal.timeout(300_000), redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new HttpResponseFailure(`${provider.name} 下载重定向缺少 Location。`, response.status);
    if (redirectCount === 5) throw new Error(`${provider.name} 下载重定向超过 5 次。`);
    current = allowedResultUrl(provider, new URL(location, current).toString(), "下载重定向地址");
    await response.body?.cancel().catch(() => undefined);
  }
  throw new Error(`${provider.name} 下载重定向无法完成。`);
}

async function recoverHttpDownload(projectRoot: string, provider: GenerationProvider, job: GenerationJob, url: string, jobs: GenerationJob[]): Promise<boolean> {
  const resultUrl = allowedResultUrl(provider, url, "结果地址");
  const isolatedDirectory = path.join(getSidecarPaths(projectRoot).generationDownloads, job.id);
  const isolatedPath = path.join(isolatedDirectory, "result.ready");
  const partialPath = path.join(isolatedDirectory, "result.partial");
  await mkdir(isolatedDirectory, { recursive: true });
  job.isolatedDownloadPath = isolatedPath;
  job.partialDownloadPath = partialPath;
  job.updatedAt = new Date().toISOString();
  await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);

  if (await pathExists(isolatedPath)) {
    await unlink(partialPath).catch((error) => {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    observeRemote(job, "pending", "validation", "正在复核已完整落盘的隔离结果。", { nextAction: "retry_same_task" });
    try {
      const inspected = await validateGeneratedResultFile(job, isolatedPath);
      observeRemote(job, "pending", "publish", "隔离结果验收通过，正在不可覆盖地发布到预留路径。", { nextAction: "retry_same_task" });
      await publishIsolatedHttpResult(job, isolatedPath, inspected);
      job.downloadBytes = inspected.size;
      job.partialDownloadPath = undefined;
      return true;
    } catch (error) {
      if (!(await pathExists(job.expectedOutputPath))) await unlink(isolatedPath).catch(() => undefined);
      throw error;
    }
  }

  await unlink(partialPath).catch((error) => {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  job.downloadAttempts = (job.downloadAttempts ?? 0) + 1;
  observeRemote(job, "pending", "download", "正在把远端结果下载到任务隔离目录。", { nextAction: "retry_same_task" });
  job.updatedAt = new Date().toISOString();
  await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
  const response = await fetchAllowedResult(provider, resultUrl);
  if (!response.ok || !response.body) throw new HttpResponseFailure(`${provider.name} 下载结果失败：HTTP ${response.status}`, response.status);
  const maximumBytes = job.kind === "image" ? MAX_IMAGE_DOWNLOAD_BYTES : MAX_VIDEO_DOWNLOAD_BYTES;
  const contentLengthHeader = response.headers.get("content-length");
  const declaredBytes = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  if (declaredBytes !== undefined && Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) throw new Error(`${provider.name} 结果大小 ${declaredBytes} 超过 ${maximumBytes} 字节上限。`);
  let receivedBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > maximumBytes) callback(new Error(`${provider.name} 下载结果超过 ${maximumBytes} 字节上限。`));
      else callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(partialPath, { flags: "wx" }));
  if (declaredBytes !== undefined && Number.isFinite(declaredBytes) && declaredBytes >= 0 && receivedBytes !== declaredBytes) throw new Error(`${provider.name} 下载结果不完整：收到 ${receivedBytes}/${declaredBytes} 字节。`);
  await fsyncFile(partialPath);
  await link(partialPath, isolatedPath);
  await unlink(partialPath);
  observeRemote(job, "pending", "validation", "隔离下载已完成，正在进行魔数、解码和 SHA-256 验收。", { nextAction: "retry_same_task" });
  let inspected: { size: number; magic: string; sha256: string };
  try {
    inspected = await validateGeneratedResultFile(job, isolatedPath);
  } catch (error) {
    await unlink(isolatedPath).catch(() => undefined);
    throw error;
  }
  job.downloadBytes = inspected.size;
  observeRemote(job, "pending", "publish", "隔离结果验收通过，正在不可覆盖地发布到预留路径。", { nextAction: "retry_same_task" });
  await publishIsolatedHttpResult(job, isolatedPath, inspected);
  job.partialDownloadPath = undefined;
  return true;
}

function comfyUiCancellationObservation(observation: ComfyUiObservation): ComfyUiCancellationObservation {
  if (observation.state === "history_succeeded") return { state: "history_succeeded", observedAt: observation.evidence.observedAt, historySha256: observation.evidence.historySha256, eventName: observation.evidence.eventName };
  if (observation.state === "history_failed") return { state: observation.interrupted ? "history_interrupted" : "history_failed", observedAt: observation.evidence.observedAt, historySha256: observation.evidence.historySha256, eventName: observation.evidence.eventName };
  return { state: observation.state, observedAt: new Date().toISOString() };
}

async function reconcileComfyUiTerminalDuringCancel(projectRoot: string, provider: GenerationProvider, job: GenerationJob, jobs: GenerationJob[], observation: ComfyUiObservation): Promise<boolean> {
  if (observation.state !== "history_succeeded" && observation.state !== "history_failed") return false;
  try {
    if (await pollComfyUiJob(projectRoot, provider, job, jobs)) {
      await verifyAndRegisterGeneratedResult(projectRoot, job);
      job.status = "succeeded";
      job.error = undefined;
      observeRemote(job, "succeeded", "publish", "取消竞态中 ComfyUI 成功历史胜出；Publication 成功终态优先。", { observedStatus: "succeeded" });
      job.updatedAt = new Date().toISOString();
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
    }
    return true;
  } catch (error) {
    if (!(error instanceof ConfirmedRemoteFailure) && !(error instanceof ConfirmedRemoteCancellation)) throw error;
    const checkpoint = comfyUiCheckpoint(job);
    try {
      if (error instanceof ConfirmedRemoteCancellation) {
        await cancelGenerationPublication(projectRoot, job, safeRemoteMessage(error), "user", "remote_cancel_confirmed", { externalTaskId: checkpoint.promptId, checkpointRevision: checkpoint.revision });
      } else {
        await failGenerationPublication(projectRoot, job, safeRemoteMessage(error), "user", "remote_confirmed_failed", { externalTaskId: checkpoint.promptId, checkpointRevision: checkpoint.revision });
      }
    } catch (publicationError) {
      const latestIntent = job.publicationIntentId ? await getPublicationIntent(projectRoot, job.publicationIntentId) : undefined;
      const projection = await projectGenerationPublicationState(projectRoot, job, latestIntent);
      if (projection !== "registered") throw publicationError;
    }
    if (job.status === "cancelled") await rm(path.join(getSidecarPaths(projectRoot).generationDownloads, job.id), { recursive: true, force: true });
    job.updatedAt = new Date().toISOString();
    await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
    return true;
  }
}

async function finalizePendingComfyUiDeletion(projectRoot: string, job: GenerationJob, jobs: GenerationJob[], cancellation: ComfyUiCancellationEvidence): Promise<GenerationJob> {
  const checkpoint = comfyUiCheckpoint(job);
  bindComfyUiPromptIdentity(job, checkpoint);
  const confirmedAt = new Date().toISOString();
  const nextCancellation: ComfyUiCancellationEvidence = {
    ...cancellation,
    confirmation: { kind: "pending_deleted", confirmedAt, stableAbsentCount: cancellation.observations.filter((entry) => entry.state === "absent").length },
  };
  const terminalCheckpoint = advanceComfyUiCheckpoint(job, "cancelled", { cancellation: nextCancellation });
  job.updatedAt = confirmedAt;
  await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
  try {
    await cancelGenerationPublication(projectRoot, job, "ComfyUI 原子取消已确认 pending 任务稳定移出 queue/history。", "user", "remote_cancel_confirmed", { externalTaskId: checkpoint.promptId, checkpointRevision: terminalCheckpoint.revision });
  } catch (error) {
    const latestIntent = job.publicationIntentId ? await getPublicationIntent(projectRoot, job.publicationIntentId) : undefined;
    const projection = await projectGenerationPublicationState(projectRoot, job, latestIntent);
    if (projection !== "registered") throw error;
  }
  if (job.status === "cancelled") await rm(path.join(getSidecarPaths(projectRoot).generationDownloads, job.id), { recursive: true, force: true });
  job.updatedAt = new Date().toISOString();
  await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
  await appendEvent(projectRoot, { actor: "user", type: "generation.comfyui-pending-deleted", itemId: job.itemId, data: { jobId: job.id, promptId: checkpoint.promptId, checkpointRevision: job.comfyUiCheckpoint?.revision, stableAbsentCount: nextCancellation.confirmation?.stableAbsentCount } });
  return job;
}

async function cancelComfyUiGeneration(projectRoot: string, provider: GenerationProvider, job: GenerationJob, jobs: GenerationJob[]): Promise<GenerationJob> {
  let checkpoint = comfyUiCheckpoint(job);
  let observation = await inspectComfyUiPrompt(provider, job);
  if (await reconcileComfyUiTerminalDuringCancel(projectRoot, provider, job, jobs, observation)) return job;

  if (observation.state === "absent") {
    const existing = checkpoint.cancellation;
    if (existing?.outcome === "acted" && existing.serverActed === true && existing.preObservedState === "pending") {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      const second = await inspectComfyUiPrompt(provider, job);
      if (await reconcileComfyUiTerminalDuringCancel(projectRoot, provider, job, jobs, second)) return job;
      const observations = [...existing.observations, comfyUiCancellationObservation(observation), comfyUiCancellationObservation(second)];
      const cancellation = { ...existing, observations };
      advanceComfyUiCheckpoint(job, "cancel_requested", { cancellation });
      await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
      if (second.state === "absent" && observations.filter((entry) => entry.state === "absent").length >= 2) return finalizePendingComfyUiDeletion(projectRoot, job, jobs, cancellation);
    }
    throw new Error("ComfyUI queue/history 均未观察到该 promptId，不能确认任务未提交或 running 中断已完成；Job 与 Publication 保持锁定。 ");
  }
  if (observation.state !== "pending" && observation.state !== "running") throw new Error("ComfyUI 取消前观测状态无效；任务保持锁定。 ");

  const requestedAt = new Date().toISOString();
  const existing = checkpoint.cancellation;
  let cancellation: ComfyUiCancellationEvidence = {
    requestedAt: existing?.requestedAt ?? requestedAt,
    promptId: checkpoint.promptId,
    preObservedState: existing?.preObservedState === "pending" || existing?.preObservedState === "running" ? existing.preObservedState : observation.state,
    endpoint: "api_jobs_cancel",
    attempt: (existing?.attempt ?? 0) + 1,
    outcome: "unknown",
    observations: [...(existing?.observations ?? []), comfyUiCancellationObservation(observation)],
  };
  advanceComfyUiCheckpoint(job, "cancel_requested", { cancellation });
  job.error = undefined;
  job.updatedAt = requestedAt;
  await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);

  let response: Response;
  let responseText = "";
  try {
    ({ response } = await comfyUiFetch(provider, `/api/jobs/${encodeURIComponent(checkpoint.promptId)}/cancel`, { method: "POST", headers: { accept: "application/json" } }));
    responseText = await limitedResponseText(response);
  } catch (error) {
    job.error = `${provider.name} 原子取消响应未知：${safeRemoteMessage(error)}；本地状态保持锁定。`;
    job.updatedAt = new Date().toISOString();
    await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
    try {
      observation = await inspectComfyUiPrompt(provider, job);
      if (await reconcileComfyUiTerminalDuringCancel(projectRoot, provider, job, jobs, observation)) return job;
    } catch { /* 保留原取消响应未知错误。 */ }
    throw new Error(job.error);
  }

  let payload: Record<string, unknown> | undefined;
  try { payload = responseText ? recordObject(JSON.parse(responseText)) : undefined; } catch { /* 下面按未知响应处理。 */ }
  const serverActed = typeof payload?.cancelled === "boolean" ? payload.cancelled : undefined;
  cancellation = {
    ...cancellation,
    responseReceivedAt: new Date().toISOString(),
    httpStatus: response.status,
    responseSha256: createHash("sha256").update(responseText).digest("hex"),
    outcome: response.ok && serverActed === true ? "acted" : response.ok && serverActed === false ? "not_acted" : "unknown",
    serverActed,
  };
  advanceComfyUiCheckpoint(job, "cancel_requested", { cancellation });
  job.updatedAt = new Date().toISOString();
  await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);

  const latestIntent = job.publicationIntentId ? await getPublicationIntent(projectRoot, job.publicationIntentId) : undefined;
  const publicationProjection = await projectGenerationPublicationState(projectRoot, job, latestIntent);
  if (publicationProjection === "registered" || publicationProjection === "failed" || publicationProjection === "cancelled") {
    await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
    return job;
  }
  if (publicationProjection === "conflict") throw new Error("取消过程中 Publication 出现不可信终态；保持 Job 锁定。 ");

  observation = await inspectComfyUiPrompt(provider, job);
  if (await reconcileComfyUiTerminalDuringCancel(projectRoot, provider, job, jobs, observation)) return job;
  cancellation = { ...cancellation, observations: [...cancellation.observations, comfyUiCancellationObservation(observation)] };
  advanceComfyUiCheckpoint(job, "cancel_requested", { cancellation });
  await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);

  if (response.ok && serverActed === true && cancellation.preObservedState === "pending" && observation.state === "absent") {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const second = await inspectComfyUiPrompt(provider, job);
    if (await reconcileComfyUiTerminalDuringCancel(projectRoot, provider, job, jobs, second)) return job;
    cancellation = { ...cancellation, observations: [...cancellation.observations, comfyUiCancellationObservation(second)] };
    advanceComfyUiCheckpoint(job, "cancel_requested", { cancellation });
    await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
    if (second.state === "absent") return finalizePendingComfyUiDeletion(projectRoot, job, jobs, cancellation);
  }

  const detail = !response.ok ? `HTTP ${response.status}` : serverActed === false ? "cancelled=false" : serverActed === undefined ? "响应缺少 cancelled:boolean" : `${observation.state} 尚未形成可确认终态`;
  throw new Error(`${provider.name} 原子取消未确认（${detail}）；Job 与 Publication 保持锁定。`);
}

export async function cancelGenerationJob(projectRoot: string, jobId: string): Promise<GenerationJob> {
  return withProjectLock(projectRoot, "generation", async () => {
  const jobs = await listGenerationJobs(projectRoot);
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`找不到生成任务：${jobId}`);
  const publicationIntent = job.publicationIntentId ? await getPublicationIntent(projectRoot, job.publicationIntentId) : undefined;
  const publicationProjection = await projectGenerationPublicationState(projectRoot, job, publicationIntent);
  if (publicationProjection !== "none") {
    job.updatedAt = new Date().toISOString();
    await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
    await syncContinuationPackFromJob(projectRoot, job);
    if (publicationProjection === "registered") {
      await appendEvent(projectRoot, { actor: "user", type: "generation.cancel-reconciled-succeeded", itemId: job.itemId, data: { jobId, publicationReceiptId: job.publicationReceiptId } });
      return job;
    }
    if (publicationProjection === "conflict") throw new Error("关联 Publication 终态缺少匹配的结构化生成来源；任务保持锁定，拒绝制造本地假取消。 ");
    return job;
  }
  if (["succeeded", "failed", "cancelled", "visual_rejected"].includes(job.status)) throw new Error(`已经进入终态 ${job.status} 的生成任务不能取消。`);
  const settings = await getGenerationSettings(projectRoot);
  const provider = providerForJob(settings, job);
  if (provider?.adapter === "codex-subagent-imagegen") {
    const checkpoint = job.subagentCheckpoint;
    if (!checkpoint) throw new Error("子代理任务缺少检查点，拒绝取消。");
    if (checkpoint.stage !== "plan_ready" || checkpoint.lease || checkpoint.callIntent || checkpoint.output) {
      throw new Error(`子代理任务处于 ${checkpoint.stage}；必须先由 owner 安全释放或完成未知调用对账，禁止取消后让迟到结果写入或触发重复生图。`);
    }
    if (job.attempts < 1) {
      const now = new Date().toISOString();
      job.attempts = 1;
      job.clientJobId ??= job.id;
      job.submissionIntent = { clientJobId: job.clientJobId, attempt: 1, createdAt: now };
    }
    await cancelGenerationPublication(projectRoot, job, "子代理任务在领取租约和模型调用前由用户取消。", "user", "user_cancelled_before_submit");
    const now = new Date().toISOString();
    job.subagentCheckpoint = { ...checkpoint, schemaVersion: 2, revision: checkpoint.revision + 1, stage: "cancelled", updatedAt: now, note: "已在无租约、无调用意图、无候选回执状态下安全取消。" };
    job.updatedAt = now;
    await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
    await appendEvent(projectRoot, { actor: "user", type: "generation.subagent-cancelled-before-call", itemId: job.itemId, data: { jobId, checkpointRevision: job.subagentCheckpoint.revision } });
    return job;
  }
  if (provider?.adapter === "comfyui-local" && job.comfyUiCheckpoint) return cancelComfyUiGeneration(projectRoot, provider, job, jobs);
  if (["submitting", "submission_unknown"].includes(job.status) && !job.externalTaskId) {
    throw new Error("远端提交结果尚未对账且没有 externalTaskId，不能确认任务未提交，也不能制造本地假取消。请先按 client_job_id 在供应商侧核对。 ");
  }
  if (provider?.adapter === "http-json" && (job.remoteAcceptedAt || job.remoteResultUrl) && !job.externalTaskId) {
    throw new Error("远端已经返回结果身份但没有可调用取消接口的 externalTaskId；拒绝只取消本地任务。请继续恢复下载或在供应商侧确认终态。 ");
  }
  if (job.externalTaskId) {
    if (!provider?.capabilities?.supportsCancel || !provider.cancelEndpoint) throw new Error("该远端任务已经提交，但供应商没有可验证的取消接口；拒绝只改本地状态造成假取消。请先在供应商侧取消并记录结果。");
    const cancelUrl = provider.cancelEndpoint.replaceAll("{taskId}", encodeURIComponent(job.externalTaskId));
    const response = await fetch(cancelUrl, { method: provider.cancelMethod === "DELETE" ? "DELETE" : "POST", headers: providerHeaders(provider, cancelUrl, false), signal: AbortSignal.timeout(120_000) });
    if (response.status === 200) {
      const body = await response.json().catch(() => undefined);
      const cancelStatus = String(jsonValue(body, provider.statusPath, ["status", "data.status"]) ?? "").toLowerCase();
      if (!["cancelled", "canceled"].includes(cancelStatus)) throw new Error(`${provider.name} 取消接口 HTTP 200 但未返回结构化 cancelled/canceled 终态；本地任务与 Publication 保持不变。`);
    } else if (response.status !== 204) throw new Error(`${provider.name} 取消远端任务未确认终态：HTTP ${response.status}；本地任务与 Publication 保持不变。`);
  }
  await cancelGenerationPublication(projectRoot, job, "生成任务由用户取消。", "user", job.externalTaskId ? "remote_cancel_confirmed" : "user_cancelled_before_submit", { externalTaskId: job.externalTaskId });
  await rm(path.join(getSidecarPaths(projectRoot).generationDownloads, job.id), { recursive: true, force: true });
  job.updatedAt = new Date().toISOString();
  await writeJsonAtomic(getSidecarPaths(projectRoot).generationJobs, jobs);
  await appendEvent(projectRoot, { actor: "user", type: "generation.cancelled", itemId: job.itemId, data: { jobId } });
  if (job.kind === "video") await updateStatusOverridesBatch(projectRoot, [{ itemId: job.itemId, status: "待视频", note: "视频生成任务已取消，可重新创建新版本" }], "user");
  return job;
  });
}
