/**
 * Seedance 提示词编译合同。
 *
 * 该模块只把既有 Studio Authority / Binding / continuity / Review 事实编译为
 * 平台可消费的自然语言提示词；不拥有媒体、账本、Review 或 nextAction，也不
 * 调用任何视频模型。引用顺序由调用方按真实上传顺序提供，编译器逐字保留标签。
 */
import { createHash } from "node:crypto";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const EXACT_REFERENCE_TAG_PATTERN = /^(?:@(Image|Video|Audio) ?([1-9][0-9]*)|\[(Image|Video|Audio) ([1-9][0-9]*)\])$/u;
const MAX_TEXT_LENGTH = 2_000;
const MAX_ARRAY_ITEMS = 64;
const MAX_PROMPT_LENGTH = 12_000;

export type StudioSeedanceMediaKind = "image" | "video" | "audio";
export type StudioSeedanceGenerationMode = "i2v" | "v2v" | "r2v";
export type StudioSeedanceContinuationMode =
  | "standalone-clip"
  | "seamless-continuation"
  | "intentional-next-shot"
  | "reanchor-after-drift";

export type StudioSeedanceReferenceRole =
  | "canonical-identity"
  | "canonical-environment"
  | "canonical-prop"
  | "accepted-previous-clip"
  | "accepted-last-frame"
  | "motion-donor"
  | "camera-donor"
  | "audio-donor";

export type StudioSeedanceSourcePolicy =
  | "canonical-open"
  | "accepted-source-continuation"
  | "canonical-reanchor";

export type StudioSeedancePromptErrorCode =
  | "invalid-input"
  | "reference-conflict"
  | "continuation-not-ready"
  | "chain-depth-invalid"
  | "beat-scope-conflict"
  | "contract-drift";

export class StudioSeedancePromptError extends Error {
  readonly code: StudioSeedancePromptErrorCode;
  readonly details: string[];

  constructor(code: StudioSeedancePromptErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "StudioSeedancePromptError";
    this.code = code;
    this.details = details;
  }
}

/** 与 Studio 九字段连续性一致，并补充视频瞬态相位。 */
export interface StudioSeedanceObservedState {
  costume: string;
  injury: string;
  heldObject: string;
  position: string;
  facing: string;
  emotion: string;
  layout: string;
  lighting: string;
  referenceSha256: string;
  motionVector: string;
  cameraPhase: string;
  focusState: string;
  audioPhase: string;
}

export interface StudioSeedanceBeat {
  id: string;
  description: string;
}

export interface StudioSeedanceReferenceInput {
  /** 必须与实际上传界面的引用标签逐字一致，例如 @Image1、@Image 1、[Video 1]。 */
  exactTag: string;
  mediaKind: StudioSeedanceMediaKind;
  role: StudioSeedanceReferenceRole;
  mediaSha256: string;
  /** 只有 Review/Authority 已通过的引用才可进入正式编译。 */
  accepted: boolean;
  transfer: string[];
  ignore: string[];
  assetId?: string;
  authorityVersionId?: string;
  authorityFingerprint?: string;
  sourceClipId?: string;
  reviewId?: string;
  reviewFingerprint?: string;
  observedEndState?: StudioSeedanceObservedState;
}

export interface CompileStudioSeedancePromptInput {
  projectId: string;
  sceneId: string;
  clipId: string;
  parentClipId: string | null;
  unitId: string;
  panelId: string;
  durationSeconds: number;
  continuationMode: StudioSeedanceContinuationMode;
  extensionDepth: number;
  /** 生产硬规则固定为 2：连续承接两次后，第三次必须回到 canonical 重锚。 */
  maxChainDepth: number;
  narrativeJob: string;
  feltIntent: string;
  currentAction: string;
  endpoint: string;
  motionDelta: string;
  cameraDelta: string;
  lightingDelta: string;
  audioDelta: string;
  plannedStartState: StudioSeedanceObservedState;
  plannedEndState: StudioSeedanceObservedState;
  completedBeats: StudioSeedanceBeat[];
  currentBeats: StudioSeedanceBeat[];
  reservedBeats: StudioSeedanceBeat[];
  continuityLocks: string[];
  allowedChanges: string[];
  negativeLocks: string[];
  references: StudioSeedanceReferenceInput[];
  /**
   * 当前 panel 从 unit-grid raw 真实裁出的单格图 SHA-256（非整板 raw 冒充）。
   * 缺省 null：允许纯提示词编译；接入静态视频包 builder 时必须提供。
   */
  panelCropSha256?: string | null;
}

export interface StudioSeedanceReferenceContract {
  exactTag: string;
  mediaKind: StudioSeedanceMediaKind;
  role: StudioSeedanceReferenceRole;
  mediaSha256: string;
  accepted: true;
  active: boolean;
  transfer: string[];
  ignore: string[];
  assetId: string | null;
  authorityVersionId: string | null;
  authorityFingerprint: string | null;
  sourceClipId: string | null;
  reviewId: string | null;
  reviewFingerprint: string | null;
  observedEndState: StudioSeedanceObservedState | null;
}

export interface StudioSeedancePromptContract {
  schemaVersion: 1;
  kind: "studio-seedance-prompt-contract";
  projectId: string;
  sceneId: string;
  clipId: string;
  unitId: string;
  panelId: string;
  durationSeconds: number;
  generationMode: StudioSeedanceGenerationMode;
  continuationMode: StudioSeedanceContinuationMode;
  sourcePolicy: StudioSeedanceSourcePolicy;
  reanchorRequired: boolean;
  lineage: {
    parentClipId: string | null;
    requestedExtensionDepth: number;
    effectiveExtensionDepth: number;
    maxChainDepth: number;
  };
  narrativeJob: string;
  feltIntent: string;
  actualOpeningState: StudioSeedanceObservedState;
  plannedEndState: StudioSeedanceObservedState;
  currentAction: string;
  endpoint: string;
  deltas: {
    motion: string;
    camera: string;
    lighting: string;
    audio: string;
  };
  beatScope: {
    completed: StudioSeedanceBeat[];
    current: StudioSeedanceBeat[];
    reserved: StudioSeedanceBeat[];
  };
  continuityLocks: string[];
  allowedChanges: string[];
  negativeLocks: string[];
  referenceRegistry: StudioSeedanceReferenceContract[];
  activeReferenceTags: string[];
  inactiveReferenceTags: string[];
  /** 当前宫格真实裁图 SHA；未接线时为 null，禁止用整板 raw SHA 冒充 */
  panelCropSha256: string | null;
  prompt: string;
  negativePrompt: string;
  fingerprint: string;
}

function fail(code: StudioSeedancePromptErrorCode, message: string, details: string[] = []): never {
  throw new StudioSeedancePromptError(code, message, details);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function normalizedText(value: unknown, field: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") fail("invalid-input", `${field} 必须是字符串。`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    fail("invalid-input", `${field} 必须为 1—${maxLength} 字符。`);
  }
  return normalized;
}

function normalizedId(value: unknown, field: string): string {
  const normalized = normalizedText(value, field, 255);
  if (!ID_PATTERN.test(normalized)) fail("invalid-input", `${field} 格式无效。`);
  return normalized;
}

function normalizedSha(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("invalid-input", `${field} 必须是小写 SHA-256。`);
  }
  return value;
}

function normalizedTextList(value: unknown, field: string, options: { allowEmpty?: boolean } = {}): string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS || (!options.allowEmpty && value.length === 0)) {
    fail("invalid-input", `${field} 必须是 ${options.allowEmpty ? "0" : "1"}—${MAX_ARRAY_ITEMS} 项数组。`);
  }
  const normalized = value.map((entry, index) => normalizedText(entry, `${field}[${index}]`));
  if (new Set(normalized).size !== normalized.length) fail("invalid-input", `${field} 含重复项。`);
  return normalized;
}

function normalizedState(value: unknown, field: string): StudioSeedanceObservedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-input", `${field} 结构无效。`);
  const row = value as Record<string, unknown>;
  return {
    costume: normalizedText(row.costume, `${field}.costume`),
    injury: normalizedText(row.injury, `${field}.injury`),
    heldObject: normalizedText(row.heldObject, `${field}.heldObject`),
    position: normalizedText(row.position, `${field}.position`),
    facing: normalizedText(row.facing, `${field}.facing`),
    emotion: normalizedText(row.emotion, `${field}.emotion`),
    layout: normalizedText(row.layout, `${field}.layout`),
    lighting: normalizedText(row.lighting, `${field}.lighting`),
    referenceSha256: normalizedSha(row.referenceSha256, `${field}.referenceSha256`),
    motionVector: normalizedText(row.motionVector, `${field}.motionVector`),
    cameraPhase: normalizedText(row.cameraPhase, `${field}.cameraPhase`),
    focusState: normalizedText(row.focusState, `${field}.focusState`),
    audioPhase: normalizedText(row.audioPhase, `${field}.audioPhase`),
  };
}

function normalizedBeats(value: unknown, field: string, allowEmpty: boolean): StudioSeedanceBeat[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS || (!allowEmpty && value.length === 0)) {
    fail("invalid-input", `${field} 必须是 ${allowEmpty ? "0" : "1"}—${MAX_ARRAY_ITEMS} 项数组。`);
  }
  const beats = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("invalid-input", `${field}[${index}] 结构无效。`);
    }
    const row = entry as Record<string, unknown>;
    return {
      id: normalizedId(row.id, `${field}[${index}].id`),
      description: normalizedText(row.description, `${field}[${index}].description`),
    };
  });
  if (new Set(beats.map((beat) => beat.id)).size !== beats.length) fail("beat-scope-conflict", `${field} 含重复 beat id。`);
  return beats;
}

function tagMediaKind(tag: string): StudioSeedanceMediaKind {
  if (tag !== tag.trim()) fail("reference-conflict", "引用标签不得含首尾空白。", [tag]);
  const match = EXACT_REFERENCE_TAG_PATTERN.exec(tag);
  const token = match?.[1] ?? match?.[3];
  if (!token) {
    fail("reference-conflict", "引用标签只接受精确 @Image1/@Image 1/[Image 1] 等 Image/Video/Audio 形式。", [tag]);
  }
  return token === "Image" ? "image" : token === "Video" ? "video" : "audio";
}

function isCanonicalRole(role: StudioSeedanceReferenceRole): boolean {
  return role === "canonical-identity" || role === "canonical-environment" || role === "canonical-prop";
}

function isOpeningAnchorRole(role: StudioSeedanceReferenceRole): boolean {
  return role === "accepted-previous-clip" || role === "accepted-last-frame";
}

function expectedMediaKind(role: StudioSeedanceReferenceRole): StudioSeedanceMediaKind {
  if (role === "accepted-previous-clip" || role === "motion-donor" || role === "camera-donor") return "video";
  if (role === "audio-donor") return "audio";
  return "image";
}

function normalizeReference(input: StudioSeedanceReferenceInput, index: number): StudioSeedanceReferenceContract {
  const field = `references[${index}]`;
  if (!input || typeof input !== "object") fail("invalid-input", `${field} 结构无效。`);
  const exactTag = normalizedText(input.exactTag, `${field}.exactTag`, 32);
  const tagKind = tagMediaKind(exactTag);
  const mediaKind = input.mediaKind;
  const role = input.role;
  if (!(["image", "video", "audio"] as const).includes(mediaKind)) fail("invalid-input", `${field}.mediaKind 无效。`);
  if (!([
    "canonical-identity", "canonical-environment", "canonical-prop", "accepted-previous-clip",
    "accepted-last-frame", "motion-donor", "camera-donor", "audio-donor",
  ] as const).includes(role)) fail("invalid-input", `${field}.role 无效。`);
  if (tagKind !== mediaKind || expectedMediaKind(role) !== mediaKind) {
    fail("reference-conflict", `${field} 的标签、媒体类型与职责不一致。`, [exactTag, mediaKind, role]);
  }
  if (input.accepted !== true) fail("continuation-not-ready", `${field} 尚未通过 Review/Authority，禁止正式编译。`);
  const transfer = normalizedTextList(input.transfer, `${field}.transfer`);
  const ignore = normalizedTextList(input.ignore, `${field}.ignore`);
  const overlap = transfer.filter((item) => ignore.includes(item));
  if (overlap.length > 0) fail("reference-conflict", `${field} 的 transfer/ignore 相互冲突。`, overlap);

  const assetId = input.assetId === undefined ? null : normalizedId(input.assetId, `${field}.assetId`);
  const authorityVersionId = input.authorityVersionId === undefined
    ? null : normalizedId(input.authorityVersionId, `${field}.authorityVersionId`);
  const authorityFingerprint = input.authorityFingerprint === undefined
    ? null : normalizedSha(input.authorityFingerprint, `${field}.authorityFingerprint`);
  const sourceClipId = input.sourceClipId === undefined ? null : normalizedId(input.sourceClipId, `${field}.sourceClipId`);
  const reviewId = input.reviewId === undefined ? null : normalizedId(input.reviewId, `${field}.reviewId`);
  const reviewFingerprint = input.reviewFingerprint === undefined
    ? null : normalizedSha(input.reviewFingerprint, `${field}.reviewFingerprint`);
  const observedEndState = input.observedEndState === undefined
    ? null : normalizedState(input.observedEndState, `${field}.observedEndState`);

  if (isCanonicalRole(role) && (!assetId || !authorityVersionId || !authorityFingerprint)) {
    fail("continuation-not-ready", `${field} 的 CanonicalAsset Authority 身份不闭合。`);
  }
  if (!isCanonicalRole(role) && (!sourceClipId || !reviewId || !reviewFingerprint)) {
    fail("continuation-not-ready", `${field} 的已验收来源身份不闭合。`);
  }
  if (isOpeningAnchorRole(role) && !observedEndState) {
    fail("continuation-not-ready", `${field} 缺少已验收 observedEndState。`);
  }

  return {
    exactTag,
    mediaKind,
    role,
    mediaSha256: normalizedSha(input.mediaSha256, `${field}.mediaSha256`),
    accepted: true,
    active: true,
    transfer,
    ignore,
    assetId,
    authorityVersionId,
    authorityFingerprint,
    sourceClipId,
    reviewId,
    reviewFingerprint,
    observedEndState,
  };
}

function inferGenerationMode(references: StudioSeedanceReferenceContract[]): StudioSeedanceGenerationMode {
  if (references.length === 1) {
    if (references[0]!.mediaKind === "image") return "i2v";
    if (references[0]!.mediaKind === "video") return "v2v";
    fail("reference-conflict", "单一音频引用不能形成视频生成输入。", [references[0]!.exactTag]);
  }
  return "r2v";
}

function beatDescriptions(beats: StudioSeedanceBeat[]): string {
  return beats.map((beat) => beat.description).join("；");
}

function referencePromptLine(reference: StudioSeedanceReferenceContract): string {
  return `${reference.exactTag} 仅控制：${reference.transfer.join("、")}；不得迁移：${reference.ignore.join("、")}`;
}

function openingStateLine(state: StudioSeedanceObservedState): string {
  return [
    `位置${state.position}`,
    `朝向${state.facing}`,
    `服装${state.costume}`,
    `伤情${state.injury}`,
    `持物${state.heldObject}`,
    `情绪${state.emotion}`,
    `布局${state.layout}`,
    `光线${state.lighting}`,
    `运动相位${state.motionVector}`,
    `摄影机相位${state.cameraPhase}`,
    `焦点${state.focusState}`,
    `声音相位${state.audioPhase}`,
  ].join("；");
}

function buildPrompt(input: {
  durationSeconds: number;
  sourcePolicy: StudioSeedanceSourcePolicy;
  reanchorRequired: boolean;
  openingAnchor: StudioSeedanceReferenceContract | null;
  activeReferences: StudioSeedanceReferenceContract[];
  narrativeJob: string;
  feltIntent: string;
  actualOpeningState: StudioSeedanceObservedState;
  currentAction: string;
  endpoint: string;
  currentBeats: StudioSeedanceBeat[];
  completedBeats: StudioSeedanceBeat[];
  reservedBeats: StudioSeedanceBeat[];
  continuityLocks: string[];
  allowedChanges: string[];
  deltas: StudioSeedancePromptContract["deltas"];
}): string {
  const lines = [`生成 ${input.durationSeconds} 秒的当前单一视频片段。`];
  lines.push(`叙事任务：${input.narrativeJob}。观众应感到：${input.feltIntent}。`);
  lines.push(`引用职责：${input.activeReferences.map(referencePromptLine).join("；")}。所有标签必须逐字保留。`);
  if (input.sourcePolicy === "accepted-source-continuation") {
    lines.push(`从 ${input.openingAnchor!.exactTag} 的已验收实际末态直接续接；来源本身携带开场位置、姿态、运动、摄影机、焦点、声音和环境排列，文本只描述下面的新变化，不重述或改写来源中已经可见的状态。`);
  } else if (input.sourcePolicy === "canonical-reanchor") {
    lines.push(`这是${input.reanchorRequired ? "达到连续续作深度上限后的计划性" : "漂移后的"}重锚镜头：从 CanonicalAsset 权威参考重新建立身份、空间和光线，使用有意切镜，不继续继承旧输出的漂移。`);
    lines.push(`开场状态：${openingStateLine(input.actualOpeningState)}。`);
  } else {
    lines.push(`从 CanonicalAsset 权威参考开场。开场状态：${openingStateLine(input.actualOpeningState)}。`);
  }
  lines.push(`本段只发生：${beatDescriptions(input.currentBeats)}。可见动作：${input.currentAction}。`);
  lines.push(`只允许这些变化：${input.allowedChanges.join("；")}。动作变化：${input.deltas.motion}；摄影机变化：${input.deltas.camera}；光线变化：${input.deltas.lighting}；声音变化：${input.deltas.audio}。`);
  lines.push(`本段停在：${input.endpoint}。到达后保留可剪辑的稳定末态。`);
  lines.push(`持续锁定：${input.continuityLocks.join("；")}。`);
  if (input.completedBeats.length > 0) lines.push(`以下事件已经完成，不得重演：${beatDescriptions(input.completedBeats)}。`);
  if (input.reservedBeats.length > 0) lines.push(`以下事件保留给后续片段，本段不得提前出现：${beatDescriptions(input.reservedBeats)}。`);
  const prompt = lines.join("\n");
  if (prompt.length > MAX_PROMPT_LENGTH) fail("invalid-input", `编译后 prompt 超过 ${MAX_PROMPT_LENGTH} 字符。`);
  return prompt;
}

/**
 * 把已闭合的 Studio 状态编译为 Seedance 自然语言提示词合同。
 * 该函数无 I/O、无持久化、无模型调用。
 */
export function compileStudioSeedancePrompt(input: CompileStudioSeedancePromptInput): StudioSeedancePromptContract {
  if (!input || typeof input !== "object") fail("invalid-input", "Seedance 编译输入无效。");
  const projectId = normalizedId(input.projectId, "projectId");
  const sceneId = normalizedId(input.sceneId, "sceneId");
  const clipId = normalizedId(input.clipId, "clipId");
  const parentClipId = input.parentClipId === null ? null : normalizedId(input.parentClipId, "parentClipId");
  const unitId = normalizedId(input.unitId, "unitId");
  const panelId = normalizedId(input.panelId, "panelId");
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > 15) {
    fail("invalid-input", "durationSeconds 必须大于 0 且不超过 15 秒。");
  }
  if (input.maxChainDepth !== 2) {
    fail("chain-depth-invalid", "maxChainDepth 必须固定为 2；第三次连续承接必须 canonical 重锚。");
  }
  if (!Number.isSafeInteger(input.extensionDepth) || input.extensionDepth < 0) {
    fail("chain-depth-invalid", "extensionDepth 必须是非负整数。");
  }
  if (!([
    "standalone-clip", "seamless-continuation", "intentional-next-shot", "reanchor-after-drift",
  ] as const).includes(input.continuationMode)) fail("invalid-input", "continuationMode 无效。");

  const completedBeats = normalizedBeats(input.completedBeats, "completedBeats", true);
  const currentBeats = normalizedBeats(input.currentBeats, "currentBeats", false);
  const reservedBeats = normalizedBeats(input.reservedBeats, "reservedBeats", true);
  const scopes = [
    ["completed", completedBeats] as const,
    ["current", currentBeats] as const,
    ["reserved", reservedBeats] as const,
  ];
  const ownerByBeat = new Map<string, string>();
  for (const [scope, beats] of scopes) {
    for (const beat of beats) {
      const prior = ownerByBeat.get(beat.id);
      if (prior) fail("beat-scope-conflict", `beat ${beat.id} 同时属于 ${prior} 与 ${scope}。`);
      ownerByBeat.set(beat.id, scope);
    }
  }

  if (!Array.isArray(input.references) || input.references.length < 1 || input.references.length > MAX_ARRAY_ITEMS) {
    fail("invalid-input", `references 必须是 1—${MAX_ARRAY_ITEMS} 项数组。`);
  }
  const references = input.references.map(normalizeReference);
  if (new Set(references.map((reference) => reference.exactTag)).size !== references.length) {
    fail("reference-conflict", "references 含重复 exactTag。");
  }
  if (new Set(references.map((reference) => reference.mediaSha256)).size !== references.length) {
    fail("reference-conflict", "同一媒体 SHA 不得伪装成多个引用职责。");
  }
  const canonical = references.filter((reference) => isCanonicalRole(reference.role));
  if (canonical.length === 0) fail("continuation-not-ready", "正式 Seedance 编译至少需要一个 CanonicalAsset Authority 引用。");
  const openingAnchors = references.filter((reference) => isOpeningAnchorRole(reference.role));

  let sourcePolicy: StudioSeedanceSourcePolicy;
  let reanchorRequired = false;
  let effectiveExtensionDepth = input.extensionDepth;
  let openingAnchor: StudioSeedanceReferenceContract | null = null;
  if (input.continuationMode === "seamless-continuation") {
    if (!parentClipId || input.extensionDepth < 1) {
      fail("continuation-not-ready", "无缝续作必须声明 parentClipId 且 extensionDepth 至少为 1。");
    }
    if (openingAnchors.length !== 1) {
      fail("continuation-not-ready", "无缝续作必须且只能有一个已验收 previous-clip 或 last-frame 开场锚。",
        openingAnchors.map((reference) => reference.exactTag));
    }
    openingAnchor = openingAnchors[0]!;
    if (input.extensionDepth > input.maxChainDepth) {
      sourcePolicy = "canonical-reanchor";
      reanchorRequired = true;
      effectiveExtensionDepth = 0;
    } else {
      sourcePolicy = "accepted-source-continuation";
    }
  } else {
    if (input.extensionDepth !== 0) {
      fail("chain-depth-invalid", `${input.continuationMode} 必须从 CanonicalAsset 开场并将 extensionDepth 置 0。`);
    }
    if (input.continuationMode === "standalone-clip" && parentClipId !== null) {
      fail("invalid-input", "standalone-clip 不得声明 parentClipId。");
    }
    sourcePolicy = input.continuationMode === "reanchor-after-drift" ? "canonical-reanchor" : "canonical-open";
  }

  const activeReferences = references.filter((reference) => {
    if (sourcePolicy === "accepted-source-continuation") return true;
    if (sourcePolicy === "canonical-reanchor") return isCanonicalRole(reference.role);
    return !isOpeningAnchorRole(reference.role);
  });
  if (activeReferences.length === 0) fail("continuation-not-ready", "编译后没有可用的受管引用。 ");
  const activeTags = new Set(activeReferences.map((reference) => reference.exactTag));
  const referenceRegistry = references.map((reference) => ({ ...reference, active: activeTags.has(reference.exactTag) }));
  const actualOpeningState = sourcePolicy === "accepted-source-continuation"
    ? openingAnchor!.observedEndState!
    : normalizedState(input.plannedStartState, "plannedStartState");
  const plannedEndState = normalizedState(input.plannedEndState, "plannedEndState");
  const continuityLocks = normalizedTextList(input.continuityLocks, "continuityLocks");
  const allowedChanges = normalizedTextList(input.allowedChanges, "allowedChanges");
  const negativeLocks = normalizedTextList(input.negativeLocks, "negativeLocks");
  const narrativeJob = normalizedText(input.narrativeJob, "narrativeJob");
  const feltIntent = normalizedText(input.feltIntent, "feltIntent");
  const currentAction = normalizedText(input.currentAction, "currentAction");
  const endpoint = normalizedText(input.endpoint, "endpoint");
  const deltas = {
    motion: normalizedText(input.motionDelta, "motionDelta"),
    camera: normalizedText(input.cameraDelta, "cameraDelta"),
    lighting: normalizedText(input.lightingDelta, "lightingDelta"),
    audio: normalizedText(input.audioDelta, "audioDelta"),
  };
  const prompt = buildPrompt({
    durationSeconds: input.durationSeconds,
    sourcePolicy,
    reanchorRequired,
    openingAnchor,
    activeReferences,
    narrativeJob,
    feltIntent,
    actualOpeningState,
    currentAction,
    endpoint,
    currentBeats,
    completedBeats,
    reservedBeats,
    continuityLocks,
    allowedChanges,
    deltas,
  });
  const negativePrompt = negativeLocks.join("；");
  const panelCropSha256 = input.panelCropSha256 === undefined || input.panelCropSha256 === null
    ? null
    : normalizedSha(input.panelCropSha256, "panelCropSha256");
  // 整板 unit-grid raw 不得冒充逐格裁图：若提供，则不得与任意 reference 媒体 SHA 相同
  // （裁图是派生帧，权威参考是 Authority 图；二者语义不同）。
  if (panelCropSha256 && references.some((reference) => reference.mediaSha256 === panelCropSha256)) {
    fail(
      "invalid-input",
      "panelCropSha256 不得与 references 媒体 SHA 相同；请使用真实逐格裁图，禁止 Authority 图或整板 raw 冒充。",
    );
  }
  const semantic: Omit<StudioSeedancePromptContract, "fingerprint"> = {
    schemaVersion: 1,
    kind: "studio-seedance-prompt-contract",
    projectId,
    sceneId,
    clipId,
    unitId,
    panelId,
    durationSeconds: input.durationSeconds,
    generationMode: inferGenerationMode(activeReferences),
    continuationMode: input.continuationMode,
    sourcePolicy,
    reanchorRequired,
    lineage: {
      parentClipId,
      requestedExtensionDepth: input.extensionDepth,
      effectiveExtensionDepth,
      maxChainDepth: input.maxChainDepth,
    },
    narrativeJob,
    feltIntent,
    actualOpeningState,
    plannedEndState,
    currentAction,
    endpoint,
    deltas,
    beatScope: { completed: completedBeats, current: currentBeats, reserved: reservedBeats },
    continuityLocks,
    allowedChanges,
    negativeLocks,
    referenceRegistry,
    activeReferenceTags: referenceRegistry.filter((reference) => reference.active).map((reference) => reference.exactTag),
    inactiveReferenceTags: referenceRegistry.filter((reference) => !reference.active).map((reference) => reference.exactTag),
    panelCropSha256,
    prompt,
    negativePrompt,
  };
  return { ...semantic, fingerprint: digest(semantic) };
}

/** 验证落盘/跨进程传递后的编译合同未漂移。 */
export function assertStudioSeedancePromptContract(
  contract: StudioSeedancePromptContract,
): StudioSeedancePromptContract {
  if (!contract || contract.schemaVersion !== 1 || contract.kind !== "studio-seedance-prompt-contract") {
    fail("contract-drift", "Seedance prompt contract 版本或 kind 无效。");
  }
  const { fingerprint, ...semantic } = contract;
  if (!SHA256_PATTERN.test(fingerprint) || digest(semantic) !== fingerprint) {
    fail("contract-drift", "Seedance prompt contract fingerprint 不匹配。");
  }
  return contract;
}
