import { createHash } from "node:crypto";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EXECUTION_METADATA_PATTERN = /\bartlist\b|\bbrowser\b|provider\s+fallback|供应商回退|浏览器执行/iu;
const CONCRETE_MODEL_PATTERN = /\b(?:gpt[-\s]?image(?:\s*\d+)?|dall[-\s]?e(?:\s*\d+)?|midjourney|stable\s+diffusion|flux(?:\.\d+)?)\b/iu;

export type CanonicalAssetCategory = "character" | "scene" | "prop" | "style";
export type AssetPresence = "required" | "optional" | "forbidden";
export type ScriptMentionStatus = "matched" | "ambiguous" | "unmatched" | "excluded";
export type ContinuityResolutionStatus = "resolved" | "conflicted" | "unresolved";
export type ApprovalStatus = "approved" | "pending" | "rejected";

export type ContinuityStateValue = string | number | boolean | null;

export interface ScriptSourceSpan {
  documentId: string;
  documentRevision: number;
  documentSha256: string;
  /**
   * 与 JavaScript String#slice 一致的原文 UTF-16 code-unit 偏移。
   * 旧调用未携带时由规范化层补齐该固定值。
   */
  offsetEncoding?: "utf16-code-unit-v1";
  startOffset: number;
  endOffset: number;
}

export interface MentionResolvableAsset {
  canonicalAssetId: string;
  category: CanonicalAssetCategory;
  canonicalName: string;
  aliases: readonly string[];
}

export interface ScriptMentionInput {
  id: string;
  text: string;
  category?: CanonicalAssetCategory;
  presence: AssetPresence;
  role: string;
  source: ScriptSourceSpan;
  excluded?: boolean;
  /** 弱语义/模型候选只供审核，永不参与自动 exact 选择。 */
  suggestions?: readonly ScriptMentionCandidate[];
}

export interface ScriptMentionCandidate {
  canonicalAssetId: string;
  category: CanonicalAssetCategory;
  canonicalName: string;
  matchKind: "id" | "formal-name" | "alias" | "manual";
  matchedValue: string;
}

export interface ScriptMentionResolution {
  kind: "exact" | "human-select" | "human-exclude";
  receiptId: string;
}

export interface ScriptMention extends Omit<ScriptMentionInput, "excluded" | "suggestions"> {
  status: ScriptMentionStatus;
  candidates: ScriptMentionCandidate[];
  /** 最多 5 个待审候选；不等于 exact candidates，不得被自动 selected。 */
  suggestions: ScriptMentionCandidate[];
  selected?: ScriptMentionCandidate;
  resolution?: ScriptMentionResolution;
}

export interface ResolveExactMentionsInput {
  mentions: readonly ScriptMentionInput[];
  assets: readonly MentionResolvableAsset[];
}

export interface ScriptDocumentSnapshot {
  documentId: string;
  revision: number;
  sha256: string;
}

export interface CurrentAuthoritySnapshot {
  id: string;
  status: ApprovalStatus;
  isCurrent: boolean;
  exposure: "allowed" | "forbidden";
}

export interface CurrentAssetVersionSnapshot {
  id: string;
  status: ApprovalStatus;
  isCurrent: boolean;
}

/**
 * 由规范资产库适配层显式投影出的当前快照。领域层不读磁盘，也不猜测
 * “最新”记录；调用方必须把 current / approved 状态带进来。
 */
export interface AssetBindingSource {
  canonicalAssetId: string;
  category: CanonicalAssetCategory;
  definitionVersionId: string;
  authority: CurrentAuthoritySnapshot;
  assetVersion: CurrentAssetVersionSnapshot;
  mediaSha256: string;
}

export interface AssetBinding {
  canonicalAssetId: string;
  category: CanonicalAssetCategory;
  definitionVersionId: string;
  authorityId: string;
  assetVersionId: string;
  mediaSha256: string;
  presence: AssetPresence;
  role: string;
  mentionIds: string[];
}

export interface AssetBindingSet {
  schemaVersion: 1;
  kind: "asset-binding-set";
  id: string;
  projectId: string;
  scriptDocuments: ScriptDocumentSnapshot[];
  mentions: ScriptMention[];
  bindings: AssetBinding[];
  fingerprint: string;
}

export interface BuildAssetBindingSetInput {
  projectId: string;
  mentions: readonly ScriptMention[];
  assets: readonly AssetBindingSource[];
}

export interface ContinuityEvidence {
  kind: "script" | "asset-version" | "review" | "timeline" | "manual-lock";
  id: string;
  revision?: number;
  sha256?: string;
  note?: string;
}

export interface ContinuitySnapshot {
  canonicalAssetId: string;
  category: CanonicalAssetCategory;
  definitionVersionId: string;
  authorityId: string;
  assetVersionId: string;
  mediaSha256: string;
  status: ContinuityResolutionStatus;
  assetState: Record<string, ContinuityStateValue>;
  evidence: ContinuityEvidence[];
  fingerprint?: string;
}

export interface CodexGenerationTarget {
  itemId: string;
  mode: "single" | "storyboard-panel";
  panelIndex: number;
  panelCount: number;
  durationSeconds: number;
  totalDurationSeconds: number;
}

export interface PromptArtifact {
  id?: string;
  text: string;
  sha256: string;
}

export interface CodexControlReferenceInput {
  canonicalAssetId: string;
  path: string;
  sha256: string;
}

export interface CodexControlReference extends CodexControlReferenceInput {
  category: CanonicalAssetCategory;
  definitionVersionId: string;
  authorityId: string;
  assetVersionId: string;
  role: string;
}

export interface CodexSafeModelReference {
  canonicalAssetId: string;
  category: CanonicalAssetCategory;
  definitionVersionId: string;
  authorityId: string;
  assetVersionId: string;
  sha256: string;
  role: string;
}

export interface CodexSafeModelPayload {
  prompt: string;
  exactlyOneImage: true;
  target: CodexGenerationTarget;
  references: CodexSafeModelReference[];
  continuity: Array<{
    canonicalAssetId: string;
    category: CanonicalAssetCategory;
    assetVersionId: string;
    state: Record<string, ContinuityStateValue>;
  }>;
  forbiddenAssets: Array<{
    canonicalAssetId: string;
    category: CanonicalAssetCategory;
    role: string;
  }>;
}

export interface CodexGenerationPack {
  schemaVersion: 1;
  kind: "codex-generation-pack";
  id: string;
  projectId: string;
  executorKind: "codex-imagegen";
  exactlyOneImage: true;
  maxCalls: 1;
  sequentialOnly: true;
  target: CodexGenerationTarget;
  bindingSetId: string;
  bindingSetFingerprint: string;
  promptArtifact: PromptArtifact;
  continuitySnapshots: Array<ContinuitySnapshot & { fingerprint: string }>;
  controlReferences: CodexControlReference[];
  safeModelPayload: CodexSafeModelPayload;
  inputSnapshotFingerprint: string;
  fingerprint: string;
}

export interface BuildCodexGenerationPackInput {
  projectId: string;
  bindingSet: AssetBindingSet;
  continuitySnapshots: readonly ContinuitySnapshot[];
  promptArtifact: PromptArtifact;
  target: CodexGenerationTarget;
  controlReferences: readonly CodexControlReferenceInput[];
}

export interface AssertCodexGenerationPackCurrentInput {
  pack: CodexGenerationPack;
  snapshots: BuildCodexGenerationPackInput;
}

export type CodexGenerationPackErrorCode =
  | "invalid-input"
  | "required-mention-unresolved"
  | "binding-source-missing"
  | "binding-conflict"
  | "required-binding-not-ready"
  | "continuity-not-resolved"
  | "target-invalid"
  | "prompt-sha-mismatch"
  | "reference-invalid"
  | "too-many-references"
  | "unsafe-model-payload"
  | "input-drift";

export class CodexGenerationPackValidationError extends Error {
  readonly code: CodexGenerationPackErrorCode;
  readonly details: string[];

  constructor(code: CodexGenerationPackErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "CodexGenerationPackValidationError";
    this.code = code;
    this.details = details;
  }
}

function fail(code: CodexGenerationPackErrorCode, message: string, details: string[] = []): never {
  throw new CodexGenerationPackValidationError(code, message, details);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail("invalid-input", `${label} 不能为空。`);
  if (/[\r\n\0]/u.test(value as string)) fail("invalid-input", `${label} 不能包含换行或 NUL。`);
  return (value as string).trim();
}

function assertSha256(value: unknown, label: string): string {
  const normalized = requiredString(value, label);
  if (!SHA256_PATTERN.test(normalized)) fail("invalid-input", `${label} 必须是小写完整 SHA-256。`);
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function stableDigest(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

function compareId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id, "en");
}

function assertUniqueIds<T extends { id: string }>(values: readonly T[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const id = requiredString(value.id, `${label}.id`);
    if (seen.has(id)) fail("invalid-input", `${label} 出现重复 ID：${id}`);
    seen.add(id);
  }
}

function normalizeSource(source: ScriptSourceSpan, label: string): ScriptSourceSpan {
  const documentId = requiredString(source.documentId, `${label}.documentId`);
  const documentSha256 = assertSha256(source.documentSha256, `${label}.documentSha256`);
  if (!Number.isInteger(source.documentRevision) || source.documentRevision < 1) {
    fail("invalid-input", `${label}.documentRevision 必须是正整数。`);
  }
  if (!Number.isInteger(source.startOffset) || !Number.isInteger(source.endOffset)
    || source.startOffset < 0 || source.endOffset <= source.startOffset) {
    fail("invalid-input", `${label} 的源码区间必须满足 0 <= startOffset < endOffset。`);
  }
  if (source.offsetEncoding !== undefined && source.offsetEncoding !== "utf16-code-unit-v1") {
    fail("invalid-input", `${label}.offsetEncoding 只允许 utf16-code-unit-v1。`);
  }
  return {
    documentId,
    documentRevision: source.documentRevision,
    documentSha256,
    offsetEncoding: "utf16-code-unit-v1",
    startOffset: source.startOffset,
    endOffset: source.endOffset,
  };
}

function normalizeMentionCandidate(
  candidate: ScriptMentionCandidate,
  label: string,
): ScriptMentionCandidate {
  if (candidate.category !== "character" && candidate.category !== "scene" && candidate.category !== "prop" && candidate.category !== "style") {
    fail("invalid-input", `${label}.category 无效。`);
  }
  if (candidate.matchKind !== "id"
    && candidate.matchKind !== "formal-name"
    && candidate.matchKind !== "alias"
    && candidate.matchKind !== "manual") {
    fail("invalid-input", `${label}.matchKind 无效。`);
  }
  return {
    canonicalAssetId: requiredString(candidate.canonicalAssetId, `${label}.canonicalAssetId`),
    category: candidate.category,
    canonicalName: requiredString(candidate.canonicalName, `${label}.canonicalName`),
    matchKind: candidate.matchKind,
    matchedValue: requiredString(candidate.matchedValue, `${label}.matchedValue`),
  };
}

function normalizeMentionResolution(
  resolution: ScriptMentionResolution | undefined,
  label: string,
): ScriptMentionResolution | undefined {
  if (!resolution) return undefined;
  if (resolution.kind !== "exact" && resolution.kind !== "human-select" && resolution.kind !== "human-exclude") {
    fail("invalid-input", `${label}.kind 无效。`);
  }
  return {
    kind: resolution.kind,
    receiptId: requiredString(resolution.receiptId, `${label}.receiptId`),
  };
}

function normalizedMention(mention: ScriptMention): ScriptMention {
  const id = requiredString(mention.id, "mention.id");
  const text = requiredString(mention.text, `mention ${id}.text`);
  const role = requiredString(mention.role, `mention ${id}.role`);
  const source = normalizeSource(mention.source, `mention ${id}.source`);
  const candidates = mention.candidates.map((candidate, index) => normalizeMentionCandidate(candidate, `mention ${id}.candidates[${index}]`))
    .sort((left, right) => left.canonicalAssetId.localeCompare(right.canonicalAssetId, "en")
    || left.matchKind.localeCompare(right.matchKind, "en"));
  if (new Set(candidates.map((candidate) => candidate.canonicalAssetId)).size !== candidates.length) {
    fail("invalid-input", `mention ${id} 的 exact candidates 不能重复资产。`);
  }
  const rawSuggestions = mention.suggestions ?? [];
  if (!Array.isArray(rawSuggestions) || rawSuggestions.length > 5) {
    fail("invalid-input", `mention ${id} 的 suggestions 必须是最多 5 项的数组。`);
  }
  const suggestions = rawSuggestions.map((candidate, index) => normalizeMentionCandidate(candidate, `mention ${id}.suggestions[${index}]`));
  if (suggestions.some((candidate) => candidate.matchKind !== "manual")) {
    fail("invalid-input", `mention ${id} 的 suggestions 只能是 manual 待审候选。`);
  }
  if (new Set(suggestions.map((candidate) => candidate.canonicalAssetId)).size !== suggestions.length) {
    fail("invalid-input", `mention ${id} 的 suggestions 不能重复资产。`);
  }
  const selected = mention.selected
    ? normalizeMentionCandidate(mention.selected, `mention ${id}.selected`)
    : undefined;
  const resolution = normalizeMentionResolution(mention.resolution, `mention ${id}.resolution`);

  if (mention.status === "matched") {
    if (candidates.length !== 1 || !selected || stableDigest(selected) !== stableDigest(candidates[0])) {
      fail("invalid-input", `mention ${id} 标记为 matched 时必须且只能选中一个候选。`);
    }
  } else if (selected) {
    fail("invalid-input", `mention ${id} 处于 ${mention.status} 时不能携带 selected。`);
  }
  if (mention.status === "ambiguous" && candidates.length < 2) {
    fail("invalid-input", `mention ${id} 标记为 ambiguous 时必须至少有两个候选。`);
  }
  if ((mention.status === "unmatched" || mention.status === "excluded") && candidates.length > 0) {
    fail("invalid-input", `mention ${id} 处于 ${mention.status} 时不能携带候选。`);
  }
  if (resolution?.kind === "exact" && mention.status !== "matched") {
    fail("invalid-input", `mention ${id} 的 exact resolution 只能用于 matched。`);
  }
  if (resolution?.kind === "human-select" && mention.status !== "matched") {
    fail("invalid-input", `mention ${id} 的 human-select resolution 只能用于 matched。`);
  }
  if (resolution?.kind === "human-exclude" && mention.status !== "excluded") {
    fail("invalid-input", `mention ${id} 的 human-exclude resolution 只能用于 excluded。`);
  }
  if (selected?.matchKind === "manual" && resolution?.kind !== "human-select") {
    fail("invalid-input", `mention ${id} 的 manual selected 必须携带 human-select resolution。`);
  }

  return {
    id,
    text,
    ...(mention.category ? { category: mention.category } : {}),
    presence: mention.presence,
    role,
    source,
    status: mention.status,
    candidates,
    suggestions,
    ...(selected ? { selected } : {}),
    ...(resolution ? { resolution } : {}),
  };
}

function normalizeReviewSuggestions(
  suggestions: readonly ScriptMentionCandidate[] | undefined,
  mentionId: string,
): ScriptMentionCandidate[] {
  if (suggestions === undefined) return [];
  if (!Array.isArray(suggestions) || suggestions.length > 5) {
    fail("invalid-input", `mention ${mentionId} 的 suggestions 必须是最多 5 项的数组。`);
  }
  const normalized = suggestions.map((candidate, index) => normalizeMentionCandidate(candidate, `mention ${mentionId}.suggestions[${index}]`));
  if (normalized.some((candidate) => candidate.matchKind !== "manual")) {
    fail("invalid-input", `mention ${mentionId} 的 suggestions 只能是 manual 待审候选。`);
  }
  if (new Set(normalized.map((candidate) => candidate.canonicalAssetId)).size !== normalized.length) {
    fail("invalid-input", `mention ${mentionId} 的 suggestions 不能重复资产。`);
  }
  return normalized;
}

/**
 * 只做 NFKC/空白/大小写归一化后的完整值匹配；不会做分词、包含、拼音、
 * 编辑距离或“最像”选择。匹配层级在全资产集合上固定为 ID > 正式名 > alias；
 * 只有首个非空层参与裁决。同层命中多个资产时保留全部候选并标记歧义。
 */
export function resolveExactMentions(input: ResolveExactMentionsInput): ScriptMention[] {
  assertUniqueIds(input.mentions, "mentions");
  const assetIds = new Set<string>();
  const normalizedAssets = input.assets.map((asset) => {
    const canonicalAssetId = requiredString(asset.canonicalAssetId, "asset.canonicalAssetId");
    if (assetIds.has(canonicalAssetId)) fail("invalid-input", `规范资产 ID 重复：${canonicalAssetId}`);
    assetIds.add(canonicalAssetId);
    const canonicalName = requiredString(asset.canonicalName, `asset ${canonicalAssetId}.canonicalName`);
    const aliases = [...new Set(asset.aliases.map((alias) => requiredString(alias, `asset ${canonicalAssetId}.alias`)))]
      .sort((left, right) => left.localeCompare(right, "zh-CN"));
    return { ...asset, canonicalAssetId, canonicalName, aliases };
  });

  return input.mentions.map((mention): ScriptMention => {
    const id = requiredString(mention.id, "mention.id");
    const text = requiredString(mention.text, `mention ${id}.text`);
    const role = requiredString(mention.role, `mention ${id}.role`);
    const source = normalizeSource(mention.source, `mention ${id}.source`);
    const suggestions = normalizeReviewSuggestions(mention.suggestions, id);
    if (mention.excluded) {
      return {
        id,
        text,
        ...(mention.category ? { category: mention.category } : {}),
        presence: mention.presence,
        role,
        source,
        status: "excluded",
        candidates: [],
        suggestions,
      };
    }

    const query = normalizeIdentity(text);
    const layers: Array<Map<string, ScriptMentionCandidate>> = [new Map(), new Map(), new Map()];
    for (const asset of normalizedAssets) {
      if (mention.category && asset.category !== mention.category) continue;
      const matches: Array<{ layer: number; kind: Exclude<ScriptMentionCandidate["matchKind"], "manual">; value: string }> = [];
      if (normalizeIdentity(asset.canonicalAssetId) === query) matches.push({ layer: 0, kind: "id", value: asset.canonicalAssetId });
      if (normalizeIdentity(asset.canonicalName) === query) matches.push({ layer: 1, kind: "formal-name", value: asset.canonicalName });
      const alias = asset.aliases.filter((value) => normalizeIdentity(value) === query)
        .sort((left, right) => left.localeCompare(right, "zh-CN"))[0];
      if (alias) matches.push({ layer: 2, kind: "alias", value: alias });
      for (const match of matches) {
        layers[match.layer]!.set(asset.canonicalAssetId, {
          canonicalAssetId: asset.canonicalAssetId,
          category: asset.category,
          canonicalName: asset.canonicalName,
          matchKind: match.kind,
          matchedValue: match.value,
        });
      }
    }
    const decisiveLayer = layers.find((layer) => layer.size > 0);
    const candidates = [...(decisiveLayer?.values() ?? [])]
      .sort((left, right) => left.canonicalAssetId.localeCompare(right.canonicalAssetId, "en"));
    if (candidates.length === 0) {
      return {
        id,
        text,
        ...(mention.category ? { category: mention.category } : {}),
        presence: mention.presence,
        role,
        source,
        status: "unmatched",
        candidates,
        suggestions,
      };
    }
    if (candidates.length > 1) {
      return {
        id,
        text,
        ...(mention.category ? { category: mention.category } : {}),
        presence: mention.presence,
        role,
        source,
        status: "ambiguous",
        candidates,
        suggestions,
      };
    }
    const selected = structuredClone(candidates[0]!);
    const resolution: ScriptMentionResolution = {
      kind: "exact",
      receiptId: `exact-${stableDigest({ id, text, source, selected }).slice(0, 32)}`,
    };
    return {
      id,
      text,
      ...(mention.category ? { category: mention.category } : {}),
      presence: mention.presence,
      role,
      source,
      status: "matched",
      candidates,
      suggestions,
      selected,
      resolution,
    };
  });
}

function bindingSetSemantic(input: Omit<AssetBindingSet, "id" | "fingerprint">): unknown {
  return {
    schemaVersion: input.schemaVersion,
    kind: input.kind,
    projectId: input.projectId,
    scriptDocuments: input.scriptDocuments,
    mentions: input.mentions,
    bindings: input.bindings,
  };
}

function recomputeBindingSetFingerprint(bindingSet: AssetBindingSet): string {
  const { id: _id, fingerprint: _fingerprint, ...semantic } = bindingSet;
  return stableDigest(bindingSetSemantic(semantic));
}

function bindingSourceReady(source: AssetBindingSource, presence: AssetPresence): boolean {
  return source.authority.status === "approved"
    && source.authority.isCurrent
    && source.assetVersion.status === "approved"
    && source.assetVersion.isCurrent
    && (presence === "forbidden" || source.authority.exposure === "allowed");
}

export function buildAssetBindingSet(input: BuildAssetBindingSetInput): AssetBindingSet {
  const projectId = requiredString(input.projectId, "projectId");
  assertUniqueIds(input.mentions, "mentions");
  const mentions = input.mentions.map(normalizedMention).sort(compareId);
  const unresolvedRequired = mentions.filter((mention) => mention.presence !== "optional"
    && (mention.status === "ambiguous" || mention.status === "unmatched"));
  if (unresolvedRequired.length > 0) {
    fail(
      "required-mention-unresolved",
      "必需或禁止露出的剧本提及存在歧义或未匹配，禁止生成资产绑定。",
      unresolvedRequired.map((mention) => `${mention.id}:${mention.status}`),
    );
  }

  const sources = new Map<string, AssetBindingSource>();
  for (const source of input.assets) {
    const canonicalAssetId = requiredString(source.canonicalAssetId, "asset source.canonicalAssetId");
    if (sources.has(canonicalAssetId)) fail("binding-conflict", `资产 ${canonicalAssetId} 存在多个当前绑定来源。`);
    requiredString(source.definitionVersionId, `asset ${canonicalAssetId}.definitionVersionId`);
    requiredString(source.authority.id, `asset ${canonicalAssetId}.authority.id`);
    requiredString(source.assetVersion.id, `asset ${canonicalAssetId}.assetVersion.id`);
    assertSha256(source.mediaSha256, `asset ${canonicalAssetId}.mediaSha256`);
    sources.set(canonicalAssetId, structuredClone(source));
  }

  const documents = new Map<string, ScriptDocumentSnapshot>();
  for (const mention of mentions) {
    const next = { documentId: mention.source.documentId, revision: mention.source.documentRevision, sha256: mention.source.documentSha256 };
    const previous = documents.get(next.documentId);
    if (previous && (previous.revision !== next.revision || previous.sha256 !== next.sha256)) {
      fail("binding-conflict", `同一剧本文档 ${next.documentId} 出现不同 revision/SHA。`);
    }
    documents.set(next.documentId, next);
  }

  const groups = new Map<string, { mentions: ScriptMention[]; source: AssetBindingSource }>();
  for (const mention of mentions) {
    if (mention.status !== "matched") continue;
    const canonicalAssetId = mention.selected!.canonicalAssetId;
    const source = sources.get(canonicalAssetId);
    if (!source) {
      if (mention.presence === "optional") continue;
      fail("binding-source-missing", `提及 ${mention.id} 的规范资产 ${canonicalAssetId} 缺少当前来源。`);
    }
    if (source.category !== mention.selected!.category) {
      fail("binding-conflict", `资产 ${canonicalAssetId} 的分类与剧本提及不一致。`);
    }
    if (!bindingSourceReady(source, mention.presence)) {
      if (mention.presence === "optional") continue;
      fail(
        "required-binding-not-ready",
        `资产 ${canonicalAssetId} 缺少 approved 且 current 的 Authority/Version/SHA，禁止绑定。`,
        [mention.id],
      );
    }
    const group = groups.get(canonicalAssetId) ?? { mentions: [], source };
    group.mentions.push(mention);
    groups.set(canonicalAssetId, group);
  }

  const bindings: AssetBinding[] = [];
  for (const [canonicalAssetId, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const presences = [...new Set(group.mentions.map((mention) => mention.presence))];
    if (presences.includes("forbidden") && presences.some((presence) => presence !== "forbidden")) {
      fail("binding-conflict", `资产 ${canonicalAssetId} 同时被声明为 forbidden 与可见，禁止静默选择。`);
    }
    const roles = [...new Set(group.mentions.map((mention) => mention.role))];
    if (roles.length !== 1) fail("binding-conflict", `资产 ${canonicalAssetId} 存在冲突角色：${roles.join("、")}`);
    const presence: AssetPresence = presences.includes("forbidden") ? "forbidden" : presences.includes("required") ? "required" : "optional";
    bindings.push({
      canonicalAssetId,
      category: group.source.category,
      definitionVersionId: group.source.definitionVersionId,
      authorityId: group.source.authority.id,
      assetVersionId: group.source.assetVersion.id,
      mediaSha256: group.source.mediaSha256,
      presence,
      role: roles[0]!,
      mentionIds: group.mentions.map((mention) => mention.id).sort((left, right) => left.localeCompare(right, "en")),
    });
  }

  const semantic = {
    schemaVersion: 1 as const,
    kind: "asset-binding-set" as const,
    projectId,
    scriptDocuments: [...documents.values()].sort((left, right) => left.documentId.localeCompare(right.documentId, "en")),
    mentions,
    bindings,
  };
  const fingerprint = stableDigest(bindingSetSemantic(semantic));
  return { ...semantic, id: `asset-binding-set-${fingerprint.slice(0, 32)}`, fingerprint };
}

function normalizeTarget(target: CodexGenerationTarget): CodexGenerationTarget {
  const itemId = requiredString(target.itemId, "target.itemId");
  if (!Number.isInteger(target.panelIndex) || !Number.isInteger(target.panelCount)) {
    fail("target-invalid", "panelIndex/panelCount 必须是整数。 ");
  }
  if (!Number.isFinite(target.durationSeconds) || target.durationSeconds <= 0
    || !Number.isFinite(target.totalDurationSeconds) || target.totalDurationSeconds <= 0
    || target.durationSeconds > target.totalDurationSeconds
    || target.totalDurationSeconds > 15) {
    fail("target-invalid", "单元总时长必须大于 0 且不超过 15 秒，当前格时长不得超过总时长。 ");
  }
  if (target.mode === "single") {
    if (target.panelIndex !== 1 || target.panelCount !== 1) {
      fail("target-invalid", "single 模式固定 panelIndex=1、panelCount=1。 ");
    }
  } else if (target.mode === "storyboard-panel") {
    if (target.panelCount < 2 || target.panelCount > 6 || target.panelIndex < 1 || target.panelIndex > target.panelCount) {
      fail("target-invalid", "storyboard-panel 模式只允许 2–6 格，panelIndex 必须落在格数范围内。 ");
    }
  } else {
    fail("target-invalid", "未知生成目标模式。 ");
  }
  return {
    itemId,
    mode: target.mode,
    panelIndex: target.panelIndex,
    panelCount: target.panelCount,
    durationSeconds: target.durationSeconds,
    totalDurationSeconds: target.totalDurationSeconds,
  };
}

function containsUnsafePath(value: string): boolean {
  return /\b[a-z][a-z0-9+.-]*:\/\//iu.test(value)
    || /(?:^|[\s"'`=:(\[{])\/(?!\/)[^\s,，;；]*/u.test(value)
    || /(?:^|[\s"'`=:(\[{])[a-z]:[\\/]/iu.test(value)
    || /(?:^|[\s"'`=:(\[{])\\\\[^\s]+/u.test(value);
}

function assertModelSafe(value: unknown, location = "safeModelPayload"): void {
  if (typeof value === "string") {
    if (containsUnsafePath(value)) fail("unsafe-model-payload", `${location} 不能包含绝对路径、file:// 或 URL。`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertModelSafe(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/path|uri|url/iu.test(key)) fail("unsafe-model-payload", `${location}.${key} 不能携带路径字段。`);
    assertModelSafe(entry, `${location}.${key}`);
  }
}

function normalizePromptArtifact(artifact: PromptArtifact): PromptArtifact {
  const text = artifact.text;
  if (typeof text !== "string" || !text.trim()) fail("invalid-input", "promptArtifact.text 不能为空。 ");
  const declaredSha = assertSha256(artifact.sha256, "promptArtifact.sha256");
  const actualSha = sha256(text);
  if (declaredSha !== actualSha) fail("prompt-sha-mismatch", "提示词正文与声明 SHA-256 不一致。 ");
  if (EXECUTION_METADATA_PATTERN.test(text) || CONCRETE_MODEL_PATTERN.test(text)) {
    fail("unsafe-model-payload", "提示词不能携带外部供应商、浏览器、回退策略或具体模型名。 ");
  }
  assertModelSafe(text, "promptArtifact.text");
  return { ...(artifact.id ? { id: requiredString(artifact.id, "promptArtifact.id") } : {}), text, sha256: declaredSha };
}

function continuitySemantic(snapshot: ContinuitySnapshot): Omit<ContinuitySnapshot, "fingerprint"> {
  const { fingerprint: _fingerprint, ...semantic } = snapshot;
  return semantic;
}

function normalizeContinuitySnapshot(snapshot: ContinuitySnapshot): ContinuitySnapshot & { fingerprint: string } {
  const canonicalAssetId = requiredString(snapshot.canonicalAssetId, "continuity.canonicalAssetId");
  const assetState = Object.fromEntries(Object.entries(snapshot.assetState)
    .sort(([left], [right]) => left.localeCompare(right, "zh-CN")));
  if (Object.keys(assetState).length === 0) fail("invalid-input", `资产 ${canonicalAssetId} 的连续性状态不能为空。`);
  const evidence = snapshot.evidence.map((entry) => ({
    kind: entry.kind,
    id: requiredString(entry.id, `continuity ${canonicalAssetId}.evidence.id`),
    ...(entry.revision !== undefined ? { revision: entry.revision } : {}),
    ...(entry.sha256 ? { sha256: assertSha256(entry.sha256, `continuity ${canonicalAssetId}.evidence.sha256`) } : {}),
    ...(entry.note ? { note: entry.note.trim() } : {}),
  })).sort((left, right) => left.id.localeCompare(right.id, "en") || left.kind.localeCompare(right.kind, "en"));
  if (evidence.length === 0) fail("invalid-input", `资产 ${canonicalAssetId} 的连续性快照必须提供证据。`);
  const semantic: Omit<ContinuitySnapshot, "fingerprint"> = {
    canonicalAssetId,
    category: snapshot.category,
    definitionVersionId: requiredString(snapshot.definitionVersionId, `continuity ${canonicalAssetId}.definitionVersionId`),
    authorityId: requiredString(snapshot.authorityId, `continuity ${canonicalAssetId}.authorityId`),
    assetVersionId: requiredString(snapshot.assetVersionId, `continuity ${canonicalAssetId}.assetVersionId`),
    mediaSha256: assertSha256(snapshot.mediaSha256, `continuity ${canonicalAssetId}.mediaSha256`),
    status: snapshot.status,
    assetState,
    evidence,
  };
  const fingerprint = stableDigest(semantic);
  if (snapshot.fingerprint && snapshot.fingerprint !== fingerprint) {
    fail("input-drift", `资产 ${canonicalAssetId} 的连续性 fingerprint 已漂移。`);
  }
  return { ...semantic, fingerprint };
}

function assertBindingSetIntegrity(bindingSet: AssetBindingSet): void {
  const fingerprint = recomputeBindingSetFingerprint(bindingSet);
  if (bindingSet.fingerprint !== fingerprint || bindingSet.id !== `asset-binding-set-${fingerprint.slice(0, 32)}`) {
    fail("input-drift", "AssetBindingSet 内容与 fingerprint/ID 不一致。 ");
  }
}

function inputSnapshotSemantic(input: {
  projectId: string;
  bindingSet: AssetBindingSet;
  continuitySnapshots: Array<ContinuitySnapshot & { fingerprint: string }>;
  promptArtifact: PromptArtifact;
  target: CodexGenerationTarget;
  controlReferences: CodexControlReference[];
}): unknown {
  return {
    projectId: input.projectId,
    bindingSet: input.bindingSet,
    continuitySnapshots: input.continuitySnapshots,
    promptArtifact: input.promptArtifact,
    target: input.target,
    controlReferences: input.controlReferences,
  };
}

function packSemantic(pack: Omit<CodexGenerationPack, "id" | "fingerprint">): unknown {
  return pack;
}

export function buildCodexGenerationPack(input: BuildCodexGenerationPackInput): CodexGenerationPack {
  const projectId = requiredString(input.projectId, "projectId");
  if (input.bindingSet.projectId !== projectId) fail("binding-conflict", "AssetBindingSet 不属于当前项目。 ");
  assertBindingSetIntegrity(input.bindingSet);
  const bindingSet = structuredClone(input.bindingSet);
  const target = normalizeTarget(input.target);
  const promptArtifact = normalizePromptArtifact(input.promptArtifact);

  const continuitySnapshots = input.continuitySnapshots.map(normalizeContinuitySnapshot)
    .sort((left, right) => left.canonicalAssetId.localeCompare(right.canonicalAssetId, "en"));
  const continuityByAsset = new Map<string, ContinuitySnapshot & { fingerprint: string }>();
  for (const snapshot of continuitySnapshots) {
    if (continuityByAsset.has(snapshot.canonicalAssetId)) fail("binding-conflict", `资产 ${snapshot.canonicalAssetId} 存在多个连续性快照。`);
    if (snapshot.status !== "resolved") {
      fail("continuity-not-resolved", `资产 ${snapshot.canonicalAssetId} 连续性状态为 ${snapshot.status}，禁止生图。`);
    }
    continuityByAsset.set(snapshot.canonicalAssetId, snapshot);
  }

  const bindingsByAsset = new Map(bindingSet.bindings.map((binding) => [binding.canonicalAssetId, binding]));
  for (const binding of bindingSet.bindings) {
    const continuity = continuityByAsset.get(binding.canonicalAssetId);
    if (!continuity) fail("continuity-not-resolved", `资产 ${binding.canonicalAssetId} 缺少连续性快照。`);
    if (continuity.category !== binding.category
      || continuity.definitionVersionId !== binding.definitionVersionId
      || continuity.authorityId !== binding.authorityId
      || continuity.assetVersionId !== binding.assetVersionId
      || continuity.mediaSha256 !== binding.mediaSha256) {
      fail("input-drift", `资产 ${binding.canonicalAssetId} 的绑定与连续性版本/SHA 不一致。`);
    }
  }
  const extraneousContinuity = continuitySnapshots.filter((snapshot) => !bindingsByAsset.has(snapshot.canonicalAssetId));
  if (extraneousContinuity.length > 0) {
    fail("binding-conflict", `连续性快照包含未绑定资产：${extraneousContinuity.map((entry) => entry.canonicalAssetId).join("、")}`);
  }

  const referencesByAsset = new Map<string, CodexControlReference>();
  for (const reference of input.controlReferences) {
    const canonicalAssetId = requiredString(reference.canonicalAssetId, "controlReference.canonicalAssetId");
    const binding = bindingsByAsset.get(canonicalAssetId);
    if (!binding) fail("reference-invalid", `参考图指向未绑定资产：${canonicalAssetId}`);
    if (binding.presence === "forbidden") continue;
    if (referencesByAsset.has(canonicalAssetId)) fail("reference-invalid", `资产 ${canonicalAssetId} 只能提供一张当前控制参考图。`);
    const referenceSha = assertSha256(reference.sha256, `controlReference ${canonicalAssetId}.sha256`);
    if (referenceSha !== binding.mediaSha256) fail("reference-invalid", `资产 ${canonicalAssetId} 的参考图 SHA 与绑定版本不一致。`);
    const referencePath = requiredString(reference.path, `controlReference ${canonicalAssetId}.path`);
    if (!/^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(referencePath) || /^https?:\/\//iu.test(referencePath) || /^file:\/\//iu.test(referencePath)) {
      fail("reference-invalid", `资产 ${canonicalAssetId} 的控制参考必须使用本地绝对文件路径。`);
    }
    referencesByAsset.set(canonicalAssetId, {
      canonicalAssetId,
      category: binding.category,
      definitionVersionId: binding.definitionVersionId,
      authorityId: binding.authorityId,
      assetVersionId: binding.assetVersionId,
      role: binding.role,
      path: referencePath,
      sha256: referenceSha,
    });
  }
  const missingRequired = bindingSet.bindings.filter((binding) => binding.presence === "required" && !referencesByAsset.has(binding.canonicalAssetId));
  if (missingRequired.length > 0) {
    fail("reference-invalid", `必需资产缺少当前控制参考：${missingRequired.map((entry) => entry.canonicalAssetId).join("、")}`);
  }
  const controlReferences = [...referencesByAsset.values()].sort((left, right) => left.canonicalAssetId.localeCompare(right.canonicalAssetId, "en"));
  if (controlReferences.length > 6) {
    fail("too-many-references", "单张图最多允许 6 项控制参考；请先建立并审核群像或道具组合派生资产。 ");
  }

  // controlReferences 是唯一允许携带本地路径的 control-plane 字段。
  assertModelSafe({ projectId, bindingSet, target, promptArtifact, continuitySnapshots }, "pack.modelIndependentInputs");

  const safeModelPayload: CodexSafeModelPayload = {
    prompt: promptArtifact.text,
    exactlyOneImage: true,
    target,
    references: controlReferences.map(({ path: _path, ...reference }) => reference),
    continuity: bindingSet.bindings.map((binding) => ({
      canonicalAssetId: binding.canonicalAssetId,
      category: binding.category,
      assetVersionId: binding.assetVersionId,
      state: structuredClone(continuityByAsset.get(binding.canonicalAssetId)!.assetState),
    })),
    forbiddenAssets: bindingSet.bindings.filter((binding) => binding.presence === "forbidden").map((binding) => ({
      canonicalAssetId: binding.canonicalAssetId,
      category: binding.category,
      role: binding.role,
    })),
  };
  assertModelSafe(safeModelPayload);

  const inputSnapshotFingerprint = stableDigest(inputSnapshotSemantic({
    projectId,
    bindingSet,
    continuitySnapshots,
    promptArtifact,
    target,
    controlReferences,
  }));
  const semantic: Omit<CodexGenerationPack, "id" | "fingerprint"> = {
    schemaVersion: 1,
    kind: "codex-generation-pack",
    projectId,
    executorKind: "codex-imagegen",
    exactlyOneImage: true,
    maxCalls: 1,
    sequentialOnly: true,
    target,
    bindingSetId: bindingSet.id,
    bindingSetFingerprint: bindingSet.fingerprint,
    promptArtifact,
    continuitySnapshots,
    controlReferences,
    safeModelPayload,
    inputSnapshotFingerprint,
  };
  const fingerprint = stableDigest(packSemantic(semantic));
  return { ...semantic, id: `codex-generation-pack-${fingerprint.slice(0, 32)}`, fingerprint };
}

/**
 * 提交前用当前 SQLite/命令总线投影重新构建同一包。脚本 revision/SHA、
 * 资产定义/Authority/Version/SHA、连续性、提示词、目标或控制参考任一变化，
 * 都会导致拒绝；不会自动刷新、降级或切换执行器。
 */
export function assertCodexGenerationPackCurrent(input: AssertCodexGenerationPackCurrentInput): CodexGenerationPack {
  const { id: _id, fingerprint: _fingerprint, ...semantic } = input.pack;
  const expectedPackFingerprint = stableDigest(packSemantic(semantic));
  if (input.pack.fingerprint !== expectedPackFingerprint
    || input.pack.id !== `codex-generation-pack-${expectedPackFingerprint.slice(0, 32)}`) {
    fail("input-drift", "CodexGenerationPack 自身内容与 fingerprint/ID 不一致。 ");
  }
  const current = buildCodexGenerationPack(input.snapshots);
  if (current.inputSnapshotFingerprint !== input.pack.inputSnapshotFingerprint
    || current.fingerprint !== input.pack.fingerprint) {
    fail("input-drift", "生图包输入已漂移；必须重新解析、绑定并冻结新包。 ");
  }
  return input.pack;
}
