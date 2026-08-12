import { createHash } from "node:crypto";
import {
  evaluateStudioAssetApplicability,
  getStudioCanonicalAsset,
  getStudioCanonicalAssetKnowledgeSnapshot,
  loadStudioIdentityIndexForAnalysis,
  normalizeStudioIdentityKey,
  type StudioAssetApplicabilityTarget,
  type StudioIdentityIndexEntry,
} from "./material-studio.js";
import { inspectManagedProject } from "./managed-project.js";
import {
  analyzeStudioPanelAssetMentions,
  confirmStudioPanelEntityClosureEmpty,
  createStudioPanelBindingScopeFingerprint,
  freezeStudioPanelAssetBindingSet,
  getCurrentStudioMentionDecision,
  getCurrentStudioMentionDecisionsForAnalysis,
  getCurrentStudioPanelAssetBindingSet,
  getCurrentStudioPanelAssetMentionAnalysis,
  getCurrentStudioPanelEntityClosureConfirmation,
  getStudioAssetBindingReadiness,
  getStudioAssetBindingSet,
  getStudioAssetMentionAnalysis,
  getStudioBindingOperationReceipt,
  getStudioMentionDecision,
  getStudioMentionIdentityKeyFingerprint,
  getStudioPanelEntityClosureConfirmation,
  getStudioPanelEntityClosureConfirmationCurrentness,
  getStudioPanelBindingScopeFingerprint,
  getStudioProductionPanelTimeContext,
  getStudioCanonicalSuccessorUnitIds,
  getStudioProductionScopeFacets,
  getStudioProductionUnitSnapshot,
  getStudioScriptSectionRevision,
  getStudioUnitBindingHeadSummaries,
  listStudioProductionUnits,
  listStudioScriptSections,
  recordStudioMentionDecision,
  studioIdentityDependencyKey,
  type AnalyzeStudioPanelAssetMentionsInput,
  type StudioAssetBindingCurrentContext,
  type StudioAssetBindingSet,
  type StudioAssetBindingSourceSnapshot,
  type StudioAssetCategory,
  type StudioAssetMentionAnalysis,
  type StudioAssetMentionAnalysisInput,
  type StudioAssetMentionProposal,
  type StudioAssetPresence,
  type StudioBindingOperationCommand,
  type StudioBindingOperationReceipt,
  type StudioBindingAtomicReceiptContext,
  type StudioMentionDecisionHead,
  type StudioMentionDecisionReceipt,
  type StudioPanelEntityClosureConfirmation,
  type StudioProductionPanel,
  type StudioProductionUnitSnapshot,
  type StudioScriptSectionRevision,
} from "./studio-production.js";
import {
  buildStudioAssetBindingSourceSnapshot,
  StudioGenerationFreezeError,
} from "./studio-generation.js";
import { createStudioLexicalIdentityMatcher } from "./studio-identity-lexical-index.js";
import {
  readLocalCreativeUnitSourceContract,
  type LocalCreativeUnitSourcePanelContract,
} from "./local-creative-unit-source-contract.js";
import {
  measureStudioUnitsReadPhase,
  measureStudioUnitsReadSyncPhase,
} from "./studio-units-read-phase-timeline.js";

const UNIT_PAGE_LIMIT = 36;
const SECTION_PAGE_LIMIT = 100;
const MAX_IDENTITY_INDEX_ROWS = 100_000;
const MAX_EXCERPT_CHARACTERS = 360;
const MAX_SCRIPT_SECTIONS = 10_000;
const ANALYZER_VERSION = "studio-lexical-exact-v2-aho-corasick";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

async function localSourcePanelContract(
  projectRoot: string,
  snapshot: StudioProductionUnitSnapshot,
  panelId: string,
): Promise<LocalCreativeUnitSourcePanelContract | null> {
  if (!snapshot.unit.id.startsWith("unit-local-")) return null;
  const contract = await readLocalCreativeUnitSourceContract(
    projectRoot,
    snapshot.unit.id,
    snapshot.unit.revision,
  );
  if (!contract) {
    throw new StudioBindingControlError(
      "binding-blocked",
      "本机来源单元缺少当前修订的受管来源合同；禁止 confirmed-empty 或冻结。",
    );
  }
  const panel = contract.panels.find((entry) => entry.panelId === panelId);
  if (!panel) {
    throw new StudioBindingControlError("binding-blocked", "本机来源合同缺少当前宫格，禁止继续绑定。");
  }
  return panel;
}

export type StudioBindingTimelineStatus =
  | "pending"
  | "unchecked"
  | "ambiguous"
  | "unmatched"
  | "bound"
  | "stale"
  | "generation-ready";

export type StudioBindingProposalStatus = "matched" | "ambiguous" | "unmatched" | "excluded";
export type StudioBindingResolutionDecision = "accept" | "select" | "exclude";

export interface StudioBindingUnitSummary {
  id: string;
  seasonId: string;
  seasonLabel: string;
  episodeId: string;
  episodeLabel: string;
  sequence: number;
  canonicalSuccessorUnitId: string | null;
  label: string;
  durationSeconds: number;
  panelCount: number;
  status: StudioBindingTimelineStatus;
  statusReason?: string;
}

export interface StudioBindingUnitPage {
  items: StudioBindingUnitSummary[];
  seasons: Array<{ id: string; label: string }>;
  episodes: Array<{ id: string; seasonId: string; label: string }>;
  nextCursor?: string;
  total?: number;
  nextAction?: string;
}

export interface StudioBindingCandidate {
  assetId: string;
  assetName: string;
  category: StudioAssetCategory;
  matchKind: string;
  scoreLabel?: string;
  authorityLabel?: string;
}

export interface StudioBindingProposal {
  id: string;
  sourceExcerptId: string;
  entityText: string;
  entityCategory: StudioAssetCategory;
  status: StudioBindingProposalStatus;
  matchKind: string;
  candidates: StudioBindingCandidate[];
  matchedAssetId?: string;
  resolvedAssetId?: string;
  presence: StudioAssetPresence;
  role: string;
  blockerCodes: string[];
  statusReason?: string;
}

export interface StudioBindingBlocker {
  code: string;
  message: string;
  severity: "blocking" | "warning";
}

export interface StudioBindingPanelControl {
  id: string;
  ordinal: number;
  label: string;
  startSeconds: number;
  endSeconds: number;
  status: StudioBindingTimelineStatus;
  statusReason?: string;
  sourceExcerpts: Array<{
    id: string;
    sourceRevisionId: string;
    startOffset: number;
    endOffset: number;
    text: string;
    sha256?: string;
    sections: Array<{
      revisionId: string;
      sectionId: string;
      revision: number;
      kind: "chapter" | "scene";
      title: string;
      fingerprint: string;
    }>;
  }>;
  proposals: StudioBindingProposal[];
  blockers: StudioBindingBlocker[];
  emptyConfirmation?: {
    id: string;
    fingerprint: string;
    revision: number;
    reviewer: "user" | "codex";
    note: string;
    currentness: "current" | "stale";
    confirmedAt: string;
  };
  confirmEmptyAllowed: boolean;
  freezeAllowed: boolean;
  bindingSet?: {
    id: string;
    fingerprint: string;
    currentness: "current" | "stale";
    frozenAt: string;
  };
}

export interface StudioBindingControlSnapshot {
  revisionToken: string;
  nextAction: string;
  unit: StudioBindingUnitSummary;
  panels: StudioBindingPanelControl[];
  selectedPanelId?: string;
}

export interface StudioBindingAnalyzeInput {
  unitId: string;
  panelId: string;
  expectedRevisionToken: string;
  /**
   * Codex 对冻结原文作出的待审实体提议。这里只保存 proposal；候选资产仍是
   * model suggestion，绝不自动成为人工 decision 或 BindingSet。
   */
  extractedMentions?: StudioBindingExtractedMentionInput[];
}

export interface StudioBindingExtractedMentionInput {
  startOffsetUtf16: number;
  endOffsetUtf16: number;
  category: StudioAssetCategory;
  presence: StudioAssetPresence;
  role: string;
  candidateAssetIds?: string[];
}

export interface StudioBindingResolveInput {
  unitId: string;
  panelId: string;
  proposalId: string;
  decision: StudioBindingResolutionDecision;
  selectedAssetId?: string;
  presence: StudioAssetPresence;
  role: string;
  expectedRevisionToken: string;
  note?: string;
  /** 公开命令必须显式声明实际决策者；Core 直调可由 context 提供。 */
  reviewer?: "user" | "codex";
}

export interface StudioBindingFreezeInput {
  unitId: string;
  panelId: string;
  expectedRevisionToken: string;
}

export interface StudioBindingConfirmEmptyInput {
  unitId: string;
  panelId: string;
  expectedRevisionToken: string;
  reviewer: "user" | "codex";
  note: string;
}

export interface StudioBindingCommandContext {
  requestHash: string;
  reviewer?: "user" | "codex";
}

export interface StudioBindingAnalyzeOutcome {
  receiptId: string;
  receiptFingerprint: string;
  analysisId: string;
  analysisRevision: number;
  analysisFingerprint: string;
  unitId: string;
  panelId: string;
  message: string;
}

export interface StudioBindingResolveOutcome {
  receiptId: string;
  receiptFingerprint: string;
  decisionId: string;
  decisionRevision: number;
  decisionFingerprint: string;
  unitId: string;
  panelId: string;
  proposalId: string;
  message: string;
}

export interface StudioBindingFreezeOutcome {
  receiptId: string;
  receiptFingerprint: string;
  bindingSetId: string;
  bindingSetRevision: number;
  bindingSetFingerprint: string;
  unitId: string;
  panelId: string;
  message: string;
}

export interface StudioBindingConfirmEmptyOutcome {
  receiptId: string;
  receiptFingerprint: string;
  confirmationId: string;
  confirmationRevision: number;
  confirmationFingerprint: string;
  unitId: string;
  panelId: string;
  message: string;
}

export class StudioBindingControlError extends Error {
  readonly code:
    | "invalid-input"
    | "revision-conflict"
    | "unit-not-found"
    | "section-not-found"
    | "panel-not-found"
    | "source-span-missing"
    | "analysis-missing"
    | "proposal-missing"
    | "decision-invalid"
    | "binding-blocked"
    | "receipt-invalid"
    | "binding-set-not-found"
    | "analysis-not-found"
    | "binding-context-incomplete";

  constructor(code: StudioBindingControlError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StudioBindingControlError";
    this.code = code;
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function requiredId(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(value.trim())) {
    throw new StudioBindingControlError("invalid-input", `${field} 格式无效。`);
  }
  return value.trim();
}

function requiredToken(value: string): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHA256_PATTERN.test(normalized)) throw new StudioBindingControlError("invalid-input", "expectedRevisionToken 无效。");
  return normalized;
}

function assertRequestHash(value: string): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHA256_PATTERN.test(normalized)) throw new StudioBindingControlError("invalid-input", "requestHash 无效。");
  return normalized;
}

function errorCode(error: unknown): string {
  if (error instanceof StudioGenerationFreezeError) return error.code;
  if (error instanceof StudioBindingControlError) return error.code;
  return "validation-failed";
}

function targetForPanel(
  projectId: string,
  snapshot: StudioProductionUnitSnapshot,
  panel: StudioProductionPanel,
): StudioAssetApplicabilityTarget {
  const time = getStudioProductionPanelTimeContext(snapshot.unit, panel);
  return {
    projectId,
    seasonId: snapshot.unit.season,
    episodeId: snapshot.unit.episode,
    unitId: snapshot.unit.id,
    ...time,
  };
}

async function metadataBindingSource(
  projectRoot: string,
  assetId: string,
  target: StudioAssetApplicabilityTarget,
): Promise<StudioAssetBindingSourceSnapshot> {
  const detail = await getStudioCanonicalAsset(projectRoot, assetId);
  if (!detail) throw new Error(`规范资产不存在：${assetId}`);
  const definition = detail.definitionVersions.find((entry) => entry.id === detail.currentDefinitionVersionId);
  const authority = detail.primaryAuthority;
  if (!definition || !authority) throw new Error(`资产 ${assetId} 缺少当前定义或主权威。`);
  const version = detail.versions.find((entry) => entry.id === authority.versionId);
  const authorityEvent = [...detail.authorityHistory].reverse().find((entry) => entry.versionId === authority.versionId);
  if (!version || version.reviewStatus !== "approved" || !authorityEvent || version.mediaSha256 !== authority.mediaSha256) {
    throw new Error(`资产 ${assetId} 的 approved 权威闭包不完整。`);
  }
  const knowledge = await getStudioCanonicalAssetKnowledgeSnapshot(projectRoot, assetId, target);
  if (!knowledge || !knowledge.applicabilityEvaluation) throw new Error(`资产 ${assetId} 缺少知识快照。`);
  const evaluation = evaluateStudioAssetApplicability(knowledge.applicability, target);
  if (!evaluation.applicable || digest(evaluation) !== digest(knowledge.applicabilityEvaluation)) {
    throw new Error(`资产 ${assetId} 不适用于当前宫格。`);
  }
  return {
    assetId: detail.id,
    category: detail.category,
    assetRevision: detail.revision,
    definitionVersionId: definition.id,
    authorityEventId: authorityEvent.id,
    authorityVersionId: authorityEvent.versionId,
    assetVersionId: version.id,
    mediaSha256: version.mediaSha256,
    knowledgeFingerprint: knowledge.fingerprint,
    applicabilityFingerprint: digest(evaluation),
  };
}

async function loadIdentityRows(projectRoot: string): Promise<StudioIdentityIndexEntry[]> {
  const snapshot = await loadStudioIdentityIndexForAnalysis(projectRoot);
  if (snapshot.entries.length > MAX_IDENTITY_INDEX_ROWS) {
    throw new Error(`身份索引超过 ${MAX_IDENTITY_INDEX_ROWS} 项解析上限。`);
  }
  return snapshot.entries;
}

async function loadCurrentScriptSections(
  projectRoot: string,
  scriptRevisionId: string,
): Promise<StudioScriptSectionRevision[]> {
  const sections: StudioScriptSectionRevision[] = [];
  let cursor: string | undefined;
  do {
    const page = await listStudioScriptSections(projectRoot, { scriptRevisionId, cursor, limit: 100 });
    sections.push(...page.items);
    if (sections.length > MAX_SCRIPT_SECTIONS) {
      throw new StudioBindingControlError("invalid-input", `单个剧本修订的 current 章节/场景不能超过 ${MAX_SCRIPT_SECTIONS} 项。`);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return sections.sort((left, right) => left.startOffsetUtf16 - right.startOffsetUtf16
    || right.endOffsetUtf16 - left.endOffsetUtf16
    || left.id.localeCompare(right.id, "en"));
}

function narrowestContainingSection(
  sections: StudioScriptSectionRevision[],
  startOffsetUtf16: number,
  endOffsetUtf16: number,
): StudioScriptSectionRevision | undefined {
  return sections
    .filter((section) => startOffsetUtf16 >= section.startOffsetUtf16 && endOffsetUtf16 <= section.endOffsetUtf16)
    .sort((left, right) => (left.endOffsetUtf16 - left.startOffsetUtf16) - (right.endOffsetUtf16 - right.startOffsetUtf16)
      || (left.kind === right.kind ? 0 : left.kind === "scene" ? -1 : 1)
      || left.id.localeCompare(right.id, "en"))[0];
}

interface LexicalIdentityGroup {
  key: string;
  category: StudioAssetCategory;
  entries: StudioIdentityIndexEntry[];
  assetIds: string[];
}

function lexicalIdentityGroups(rows: StudioIdentityIndexEntry[]): LexicalIdentityGroup[] {
  const buckets = new Map<string, StudioIdentityIndexEntry[]>();
  for (const row of rows) {
    const bucketKey = `${row.normalizedKey}\u0000${row.category}`;
    buckets.set(bucketKey, [...(buckets.get(bucketKey) ?? []), row]);
  }
  const priority = new Map([["id", 0], ["formal-name", 1], ["alias", 2]]);
  return [...buckets.values()].map((entries) => {
    const minimum = Math.min(...entries.map((entry) => priority.get(entry.matchKind) ?? 99));
    const selected = entries.filter((entry) => (priority.get(entry.matchKind) ?? 99) === minimum)
      .sort((left, right) => left.assetId.localeCompare(right.assetId, "en"));
    return {
      key: selected[0]!.normalizedKey,
      category: selected[0]!.category,
      entries: selected,
      assetIds: [...new Set(selected.map((entry) => entry.assetId))],
    };
  }).sort((left, right) => right.key.length - left.key.length || left.key.localeCompare(right.key, "zh-CN"));
}

interface LexicalMatch {
  start: number;
  end: number;
  surfaceText: string;
  group: LexicalIdentityGroup;
}

function lexicalMatchesForPanel(
  snapshot: StudioProductionUnitSnapshot,
  panel: StudioProductionPanel,
  groups: LexicalIdentityGroup[],
): LexicalMatch[] {
  const matches: LexicalMatch[] = [];
  const matcher = createStudioLexicalIdentityMatcher(groups);
  for (const span of panel.sourceSpans) {
    const source = snapshot.scriptRevision.body.slice(span.startOffsetUtf16, span.endOffsetUtf16);
    matches.push(...matcher.match(source, span.startOffsetUtf16).map((match) => ({
      ...match,
      surfaceText: snapshot.scriptRevision.body.slice(match.start, match.end),
    })));
  }
  const deduplicated = [...new Map(matches.map((match) => [
    `${match.start}:${match.end}:${match.group.category}:${match.group.key}`,
    match,
  ] as const)).values()].sort((left, right) => left.start - right.start || right.end - left.end || left.group.category.localeCompare(right.group.category, "en"));
  return deduplicated.filter((candidate, index, all) => !all.some((container, containerIndex) => {
    if (containerIndex === index || container.group.category !== candidate.group.category) return false;
    if (container.start > candidate.start || container.end < candidate.end || container.end - container.start <= candidate.end - candidate.start) return false;
    return stableJson(container.group.assetIds) === stableJson(candidate.group.assetIds);
  }));
}

function mentionPlanForPanel(
  snapshot: StudioProductionUnitSnapshot,
  panel: StudioProductionPanel,
  identityRows: StudioIdentityIndexEntry[],
  sections: StudioScriptSectionRevision[],
): StudioAssetMentionAnalysisInput[] {
  const matches = lexicalMatchesForPanel(snapshot, panel, lexicalIdentityGroups(identityRows));
  return matches.map((match) => {
    const declarations = panel.assets.filter((entry) => entry.category === match.group.category && match.group.assetIds.includes(entry.assetId));
    const declaredSemantics = [...new Map(declarations.map((entry) => [
      stableJson({ presence: entry.presence, role: entry.role }),
      { presence: entry.presence, role: entry.role },
    ] as const)).values()];
    const proposal = declaredSemantics.length === 1
      ? declaredSemantics[0]!
      : { presence: "required" as const, role: "剧本实体，待人工确认画面职能。" };
    const semantic = {
      unitId: snapshot.unit.id,
      unitRevision: snapshot.unit.revision,
      panelId: panel.id,
      panelIndex: panel.index,
      scriptRevisionId: snapshot.scriptRevision.id,
      startOffsetUtf16: match.start,
      endOffsetUtf16: match.end,
      category: match.group.category,
      normalizedIdentityKey: normalizeStudioIdentityKey(match.surfaceText),
    };
    return {
      id: `studio-mention-${digest(semantic).slice(0, 40)}`,
      surfaceText: match.surfaceText,
      startOffsetUtf16: match.start,
      endOffsetUtf16: match.end,
      ...(narrowestContainingSection(sections, match.start, match.end)
        ? { sectionRevisionId: narrowestContainingSection(sections, match.start, match.end)!.id }
        : {}),
      category: match.group.category,
      presence: proposal.presence,
      role: proposal.role,
    };
  });
}

function mergeExtractedMentionPlan(
  snapshot: StudioProductionUnitSnapshot,
  panel: StudioProductionPanel,
  automatic: StudioAssetMentionAnalysisInput[],
  extracted: StudioBindingExtractedMentionInput[] | undefined,
  sections: StudioScriptSectionRevision[],
): StudioAssetMentionAnalysisInput[] {
  if (extracted === undefined) return automatic;
  if (!Array.isArray(extracted) || extracted.length > 256) {
    throw new StudioBindingControlError("invalid-input", "extractedMentions 必须是最多 256 项的数组。");
  }
  const merged = new Map(automatic.map((mention) => [
    `${mention.startOffsetUtf16}:${mention.endOffsetUtf16}:${mention.category ?? "*"}`,
    mention,
  ] as const));
  for (const mention of extracted) {
    if (!Number.isSafeInteger(mention.startOffsetUtf16) || !Number.isSafeInteger(mention.endOffsetUtf16)
      || mention.startOffsetUtf16 < 0 || mention.endOffsetUtf16 <= mention.startOffsetUtf16
      || mention.endOffsetUtf16 > snapshot.scriptRevision.body.length) {
      throw new StudioBindingControlError("invalid-input", "extracted mention 的 UTF-16 span 无效。");
    }
    if (!panel.sourceSpans.some((span) => mention.startOffsetUtf16 >= span.startOffsetUtf16
      && mention.endOffsetUtf16 <= span.endOffsetUtf16)) {
      throw new StudioBindingControlError("invalid-input", "extracted mention 必须完整位于当前宫格的 source span 内。");
    }
    if (mention.category !== "character" && mention.category !== "scene" && mention.category !== "prop" && mention.category !== "style") {
      throw new StudioBindingControlError("invalid-input", "extracted mention category 无效。");
    }
    if (mention.presence !== "required" && mention.presence !== "optional" && mention.presence !== "forbidden") {
      throw new StudioBindingControlError("invalid-input", "extracted mention presence 无效。");
    }
    const role = typeof mention.role === "string" ? mention.role.trim() : "";
    if (!role || role.length > 1_000) throw new StudioBindingControlError("invalid-input", "extracted mention role 无效。");
    const candidateAssetIds = mention.candidateAssetIds ?? [];
    if (!Array.isArray(candidateAssetIds) || candidateAssetIds.length > 5
      || new Set(candidateAssetIds).size !== candidateAssetIds.length) {
      throw new StudioBindingControlError("invalid-input", "每项 extracted mention 最多携带 5 个不重复候选资产 ID。");
    }
    const surfaceText = snapshot.scriptRevision.body.slice(mention.startOffsetUtf16, mention.endOffsetUtf16);
    if (!surfaceText || surfaceText.trim() !== surfaceText) {
      throw new StudioBindingControlError("invalid-input", "extracted mention span 不能为空或包含首尾空白。");
    }
    const semantic = {
      unitId: snapshot.unit.id,
      unitRevision: snapshot.unit.revision,
      panelId: panel.id,
      panelIndex: panel.index,
      scriptRevisionId: snapshot.scriptRevision.id,
      startOffsetUtf16: mention.startOffsetUtf16,
      endOffsetUtf16: mention.endOffsetUtf16,
      category: mention.category,
      normalizedIdentityKey: normalizeStudioIdentityKey(surfaceText),
    };
    merged.set(`${mention.startOffsetUtf16}:${mention.endOffsetUtf16}:${mention.category}`, {
      id: `studio-mention-${digest(semantic).slice(0, 40)}`,
      surfaceText,
      startOffsetUtf16: mention.startOffsetUtf16,
      endOffsetUtf16: mention.endOffsetUtf16,
      ...(narrowestContainingSection(sections, mention.startOffsetUtf16, mention.endOffsetUtf16)
        ? { sectionRevisionId: narrowestContainingSection(sections, mention.startOffsetUtf16, mention.endOffsetUtf16)!.id }
        : {}),
      category: mention.category,
      presence: mention.presence,
      role,
      ...(candidateAssetIds.length ? {
        modelSuggestions: candidateAssetIds.map((assetId) => ({
          assetId: requiredId(assetId, "candidateAssetId"),
          category: mention.category,
        })),
      } : {}),
    });
  }
  const result = [...merged.values()].sort((left, right) => left.startOffsetUtf16 - right.startOffsetUtf16
    || left.endOffsetUtf16 - right.endOffsetUtf16
    || (left.category ?? "").localeCompare(right.category ?? "", "en"));
  if (result.length > 256) throw new StudioBindingControlError("invalid-input", "合并后的实体提议超过 256 项。");
  return result;
}

function excerptForPanel(
  snapshot: StudioProductionUnitSnapshot,
  panel: StudioProductionPanel,
  sections: StudioScriptSectionRevision[],
) {
  return panel.sourceSpans.map((span, index) => {
    const source = snapshot.scriptRevision.body.slice(span.startOffsetUtf16, span.endOffsetUtf16);
    const text = source.length <= MAX_EXCERPT_CHARACTERS ? source : `${source.slice(0, MAX_EXCERPT_CHARACTERS - 1)}…`;
    return {
      id: `source-${panel.id}-${index + 1}`,
      sourceRevisionId: span.scriptRevisionId,
      startOffset: span.startOffsetUtf16,
      endOffset: span.endOffsetUtf16,
      text,
      sha256: span.surfaceSha256,
      sections: sections
        .filter((section) => section.startOffsetUtf16 < span.endOffsetUtf16 && section.endOffsetUtf16 > span.startOffsetUtf16)
        .sort((left, right) => (left.kind === right.kind ? 0 : left.kind === "chapter" ? -1 : 1)
          || left.startOffsetUtf16 - right.startOffsetUtf16
          || right.endOffsetUtf16 - left.endOffsetUtf16
          || left.id.localeCompare(right.id, "en"))
        .map((section) => ({
          revisionId: section.id,
          sectionId: section.sectionId,
          revision: section.revision,
          kind: section.kind,
          title: section.title,
          fingerprint: section.fingerprint,
        })),
    };
  });
}

function exactMatchedAsset(proposal: StudioAssetMentionProposal): string | undefined {
  const exact = proposal.candidates.filter((candidate) => candidate.kind !== "model");
  return proposal.status === "matched" && exact.length === 1 ? exact[0]!.assetId : undefined;
}

function decisionMap(heads: StudioMentionDecisionHead[]): Map<string, StudioMentionDecisionHead> {
  return new Map(heads.map((head) => [head.proposalId, head] as const));
}

async function buildBindingContext(
  projectRoot: string,
  snapshot: StudioProductionUnitSnapshot,
  panel: StudioProductionPanel,
  analysis: StudioAssetMentionAnalysis,
  bindingSet: StudioAssetBindingSet,
  projectId: string,
): Promise<{ context?: StudioAssetBindingCurrentContext; vector: unknown; errors: Array<{ assetId?: string; code: string }> }> {
  const identityKeyFingerprints: Record<string, string> = {};
  for (const proposal of analysis.proposals) {
    const key = studioIdentityDependencyKey(proposal.surfaceText, proposal.category);
    identityKeyFingerprints[key] = await getStudioMentionIdentityKeyFingerprint(projectRoot, proposal.surfaceText, proposal.category);
  }
  const assets: StudioAssetBindingSourceSnapshot[] = [];
  const errors: Array<{ assetId?: string; code: string }> = [];
  const target = targetForPanel(projectId, snapshot, panel);
  for (const binding of bindingSet.bindings) {
    try {
      assets.push(await metadataBindingSource(projectRoot, binding.assetId, target));
    } catch (error) {
      errors.push({ assetId: binding.assetId, code: errorCode(error) });
    }
  }
  return {
    ...(errors.length === 0 ? { context: { identityKeyFingerprints, assets } } : {}),
    vector: {
      identityKeyFingerprints,
      assets: assets.map((asset) => ({ assetId: asset.assetId, semantic: digest(asset) })),
      errors,
    },
    errors,
  };
}

function unitSummaryFromControl(
  snapshot: StudioProductionUnitSnapshot,
  status: StudioBindingTimelineStatus,
  statusReason: string | undefined,
  canonicalSuccessorUnitId: string | null,
): StudioBindingUnitSummary {
  return {
    id: snapshot.unit.id,
    seasonId: snapshot.unit.season,
    seasonLabel: snapshot.unit.season,
    episodeId: snapshot.unit.episode,
    episodeLabel: snapshot.unit.episode,
    sequence: snapshot.unit.sequence,
    canonicalSuccessorUnitId,
    label: `${String(snapshot.unit.sequence).padStart(3, "0")} · ${snapshot.unit.title}`,
    durationSeconds: snapshot.unit.durationSeconds,
    panelCount: snapshot.unit.panelCount,
    status,
    ...(statusReason ? { statusReason } : {}),
  };
}

function firstNextAction(panels: StudioBindingPanelControl[]): string {
  for (const panel of panels) {
    if (panel.confirmEmptyAllowed) return `宫格 ${panel.ordinal}：明确审阅并确认该范围无可绑定实体。`;
    // replacement freeze 允许存在的 stale:* 仅描述旧 BindingSet；freezeAllowed 已证明当前
    // analysis/decisions 闭合，必须先暴露唯一可执行动作，不能让旧 head 的诊断遮蔽它。
    if (panel.freezeAllowed) return `宫格 ${panel.ordinal}：冻结当前 AssetBindingSet。`;
    const blocking = panel.blockers.find((entry) => entry.severity === "blocking");
    if (blocking) return `宫格 ${panel.ordinal}：${blocking.message}`;
  }
  return panels.every((panel) => panel.status === "generation-ready")
    ? "全部宫格绑定已就绪，可由 Codex 冻结下一个单图生成包。"
    : "检查当前宫格的待审提案。";
}

function staleBlockerRequiresReanalysis(code: string): boolean {
  return code === "analysis-panel-scope-stale"
    || code === "analysis-section-head-stale"
    || code === "analysis-identity-key-stale"
    || code.startsWith("stale:section-")
    || code.startsWith("stale:unit-")
    || code.startsWith("stale:script-")
    || code.startsWith("stale:prompt-")
    || code.startsWith("stale:identity-key-");
}

export async function listStudioBindingUnits(
  projectRoot: string,
  query: { seasonId?: string; episodeId?: string; cursor?: string; limit?: number } = {},
): Promise<StudioBindingUnitPage> {
  return measureStudioUnitsReadPhase("binding-owner-total", async () => {
    await measureStudioUnitsReadPhase(
      "binding-managed-inspect",
      () => inspectManagedProject(projectRoot),
    );
    const limit = query.limit ?? UNIT_PAGE_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > UNIT_PAGE_LIMIT) throw new StudioBindingControlError("invalid-input", `limit 必须为 1-${UNIT_PAGE_LIMIT}。`);
    const [page, facets] = await Promise.all([
      measureStudioUnitsReadPhase("production-page", () => listStudioProductionUnits(projectRoot, {
        ...(query.seasonId ? { season: query.seasonId } : {}),
        ...(query.episodeId ? { episode: query.episodeId } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit,
      })),
      measureStudioUnitsReadPhase(
        "production-facets",
        () => getStudioProductionScopeFacets(projectRoot),
      ),
    ]);
    const summaries = new Map((await measureStudioUnitsReadPhase(
      "binding-heads",
      () => getStudioUnitBindingHeadSummaries(projectRoot, page.items.map((item) => item.id)),
    )).map((entry) => [entry.unitId, entry] as const));
    const successors = await measureStudioUnitsReadPhase(
      "successors",
      () => getStudioCanonicalSuccessorUnitIds(projectRoot, page.items.map((item) => item.id)),
    );
    const items = measureStudioUnitsReadSyncPhase("binding-map", () => page.items.map((unit): StudioBindingUnitSummary => {
      const summary = summaries.get(unit.id);
      let status: StudioBindingTimelineStatus = "pending";
      let statusReason = "待解析剧本实体。";
      if (summary?.unresolvedAmbiguousCount) {
        status = "ambiguous";
        statusReason = `${summary.unresolvedAmbiguousCount} 项歧义待人工选择。`;
      } else if (summary?.unresolvedUnmatchedCount) {
        status = "unmatched";
        statusReason = `${summary.unresolvedUnmatchedCount} 项未匹配待处理。`;
      } else if (summary && summary.bindingHeadCount === summary.panelCount) {
        status = "unchecked";
        statusReason = "全部宫格均有 BindingSet；列表不做深度当前性推断，请选中核验。";
      } else if (summary?.analysisHeadCount) {
        status = "pending";
        statusReason = summary.unresolvedMatchedCount
          ? `${summary.unresolvedMatchedCount} 项明确匹配仍待人工确认。`
          : "解析已完成，待冻结宫格绑定。";
      }
      return {
        id: unit.id,
        seasonId: unit.season,
        seasonLabel: unit.season,
        episodeId: unit.episode,
        episodeLabel: unit.episode,
        sequence: unit.sequence,
        canonicalSuccessorUnitId: successors[unit.id] ?? null,
        label: `${String(unit.sequence).padStart(3, "0")} · ${unit.title}`,
        durationSeconds: unit.durationSeconds,
        panelCount: unit.panelCount,
        status,
        statusReason,
      };
    }));
    return {
      items,
      seasons: facets.seasons.map((season) => ({ id: season, label: season })),
      episodes: facets.episodes.map((entry) => ({ id: entry.episode, seasonId: entry.season, label: entry.episode })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...(!query.seasonId && !query.episodeId ? { total: facets.totalUnits } : {}),
      nextAction: items.length ? "选择单元后按 Core 投影处理第一个阻塞宫格。" : "先建立严格 15 秒、2–6 宫格的生产单元。",
    };
  });
}

export async function listStudioBindingSections(
  projectRoot: string,
  query: { scriptRevisionId: string; cursor?: string; limit?: number },
): Promise<{ items: StudioScriptSectionRevision[]; nextCursor?: string }> {
  await inspectManagedProject(projectRoot);
  const scriptRevisionId = requiredId(query.scriptRevisionId, "scriptRevisionId");
  const limit = query.limit ?? SECTION_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SECTION_PAGE_LIMIT) {
    throw new StudioBindingControlError("invalid-input", `section limit 必须为 1-${SECTION_PAGE_LIMIT}。`);
  }
  return listStudioScriptSections(projectRoot, {
    scriptRevisionId,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    limit,
  });
}

export async function getStudioBindingSection(
  projectRoot: string,
  input: { revisionId: string },
): Promise<StudioScriptSectionRevision> {
  await inspectManagedProject(projectRoot);
  const revisionId = requiredId(input.revisionId, "revisionId");
  const section = await getStudioScriptSectionRevision(projectRoot, revisionId);
  if (!section) throw new StudioBindingControlError("section-not-found", `章节/场景修订不存在：${revisionId}`);
  return section;
}

export async function getStudioBindingControl(
  projectRoot: string,
  input: { unitId: string },
): Promise<StudioBindingControlSnapshot> {
  const shell = await inspectManagedProject(projectRoot);
  const unitId = requiredId(input.unitId, "unitId");
  const snapshot = await getStudioProductionUnitSnapshot(projectRoot, unitId);
  if (!snapshot) throw new StudioBindingControlError("unit-not-found", `生产单元不存在：${unitId}`);
  const scriptSections = (await loadCurrentScriptSections(projectRoot, snapshot.scriptRevision.id))
    .filter((section) => section.scriptRevisionId === snapshot.scriptRevision.id);
  const identityRows = await loadIdentityRows(projectRoot);
  const panels: StudioBindingPanelControl[] = [];
  const revisionPanels: unknown[] = [];
  for (const panel of snapshot.panels) {
    const sourceExcerpts = excerptForPanel(snapshot, panel, scriptSections);
    const analysis = await getCurrentStudioPanelAssetMentionAnalysis(projectRoot, unitId, panel.id);
    const decisions = analysis ? await getCurrentStudioMentionDecisionsForAnalysis(projectRoot, analysis.id) : [];
    const decisionsByProposal = decisionMap(decisions);
    const bindingSet = await getCurrentStudioPanelAssetBindingSet(projectRoot, unitId, panel.id);
    const confirmationHead = await getCurrentStudioPanelEntityClosureConfirmation(projectRoot, unitId, panel.id);
    const confirmationCurrentness = confirmationHead
      ? await getStudioPanelEntityClosureConfirmationCurrentness(projectRoot, confirmationHead.confirmation.id)
      : null;
    const analysisEvidenceScope = analysis
      ? await getStudioPanelBindingScopeFingerprint(projectRoot, unitId, panel.index, analysis.unitRevision)
      : null;
    const analysisPanelScopeCurrent = Boolean(
      analysis
      && analysisEvidenceScope
      && analysisEvidenceScope === createStudioPanelBindingScopeFingerprint(snapshot, panel.index),
    );
    const analysisSectionHeadsCurrent = Boolean(analysis && analysis.proposals.every((proposal) =>
      !proposal.sectionRevisionId || scriptSections.some((section) => section.id === proposal.sectionRevisionId)));
    const analysisIdentityKeyFingerprints = analysis
      ? Object.fromEntries(await Promise.all(analysis.proposals.map(async (proposal) => {
        const key = studioIdentityDependencyKey(proposal.surfaceText, proposal.category);
        return [key, await getStudioMentionIdentityKeyFingerprint(projectRoot, proposal.surfaceText, proposal.category)] as const;
      })))
      : {};
    const analysisIdentityKeysCurrent = Boolean(analysis && analysis.proposals.every((proposal) =>
      analysisIdentityKeyFingerprints[studioIdentityDependencyKey(proposal.surfaceText, proposal.category)]
        === proposal.candidateSetFingerprint));
    const analysisTargetCurrent = Boolean(
      analysisPanelScopeCurrent
      && analysisSectionHeadsCurrent
      && analysisIdentityKeysCurrent,
    );
    const currentEmptyConfirmation = Boolean(
      analysis
      && analysis.proposals.length === 0
      && analysisTargetCurrent
      && confirmationHead
      && confirmationCurrentness?.current
      && confirmationHead.confirmation.analysisId === analysis.id
      && confirmationHead.confirmation.analysisFingerprint === analysis.fingerprint,
    );
    const blockers: StudioBindingBlocker[] = [];
    const proposalViews: StudioBindingProposal[] = [];
    let status: StudioBindingTimelineStatus = "pending";
    let statusReason = "待解析剧本实体。";
    // P20：extension（扩写）格禁锚 spans 属其定义，spans 相关闸对其豁免（对齐 studio-production :3847/:4455）。
    const extensionPanel = panel.shotType === "extension";
    if (panel.sourceSpans.length === 0 && !extensionPanel) blockers.push({ code: "panel-source-span-missing", message: "先为该宫格标注它在冻结剧本修订中的原文范围。", severity: "blocking" });
    if (!analysis) {
      if (panel.sourceSpans.length > 0 || extensionPanel) blockers.push({ code: "analysis-missing", message: "解析当前宫格的剧本实体。", severity: "blocking" });
    } else {
      if (!analysisPanelScopeCurrent) {
        blockers.push({ code: "analysis-panel-scope-stale", message: "目标宫格内容已变化，请重新解析后再确认或冻结。", severity: "blocking" });
        status = "stale";
        statusReason = "当前分析不再锚定目标宫格内容。";
      }
      if (!analysisSectionHeadsCurrent) {
        blockers.push({ code: "analysis-section-head-stale", message: "当前分析依赖的章节/场景 head 已变化，请重新解析。", severity: "blocking" });
        status = "stale";
        statusReason = "当前分析依赖的章节/场景版本已过期。";
      }
      if (!analysisIdentityKeysCurrent) {
        blockers.push({ code: "analysis-identity-key-stale", message: "当前分析依赖的精确身份候选集已变化，请重新解析。", severity: "blocking" });
        status = "stale";
        statusReason = "当前分析依赖的身份候选集已过期。";
      }
      if (analysis.proposals.length === 0) {
        if (currentEmptyConfirmation) {
          status = "bound";
          statusReason = "该原文范围已被显式审阅并确认为无可绑定实体。";
        } else {
          blockers.push({ code: "empty-confirmation-required", message: "未发现实体；必须由 user 或 Codex 显式确认该宫格为空，不能自动冻结。", severity: "blocking" });
          if (analysisTargetCurrent) {
            status = "pending";
            statusReason = "零提案结果仍待显式 confirmed-empty 裁决。";
          }
        }
      }
      for (const proposal of analysis.proposals) {
        const decision = decisionsByProposal.get(proposal.id)?.decision;
        const matchedAssetId = exactMatchedAsset(proposal);
        const candidateMatchKind = proposal.candidates[0]?.kind ?? "none";
        const proposalBlockers: string[] = [];
        if (!decision && proposal.presence !== "optional") proposalBlockers.push("human-decision-required");
        if (!decision && proposal.status === "ambiguous") proposalBlockers.push("ambiguous");
        if (!decision && proposal.status === "unmatched") proposalBlockers.push("unmatched");
        const proposalStatus: StudioBindingProposalStatus = decision?.action === "exclude" ? "excluded" : proposal.status;
        proposalViews.push({
          id: proposal.id,
          sourceExcerptId: panel.sourceSpans.findIndex((span) => proposal.startOffsetUtf16 >= span.startOffsetUtf16 && proposal.endOffsetUtf16 <= span.endOffsetUtf16) >= 0
            ? `source-${panel.id}-${panel.sourceSpans.findIndex((span) => proposal.startOffsetUtf16 >= span.startOffsetUtf16 && proposal.endOffsetUtf16 <= span.endOffsetUtf16) + 1}`
            : `source-${panel.id}-unknown`,
          entityText: proposal.surfaceText,
          entityCategory: proposal.category ?? proposal.candidates[0]?.category ?? "prop",
          status: proposalStatus,
          matchKind: candidateMatchKind,
          candidates: proposal.candidates.map((candidate) => ({
            assetId: candidate.assetId,
            assetName: identityRows.find((row) => row.assetId === candidate.assetId)?.canonicalName
              || candidate.assetId,
            category: candidate.category,
            matchKind: candidate.kind,
            scoreLabel: candidate.kind === "model" ? "模型建议，不自动选中" : "精确全等匹配",
          })),
          ...(matchedAssetId ? { matchedAssetId } : {}),
          ...(decision?.selectedAssetId ? { resolvedAssetId: decision.selectedAssetId } : {}),
          presence: decision?.presence ?? proposal.presence,
          role: decision?.role ?? proposal.role,
          blockerCodes: proposalBlockers,
          ...(proposalBlockers.length ? { statusReason: proposalBlockers.join(", ") } : {}),
        });
      }
      const unresolved = analysis.proposals.filter((proposal) => !decisionsByProposal.has(proposal.id) && proposal.presence !== "optional");
      if (analysis.proposals.length === 0) {
        // confirmed-empty 的状态已在上方按显式裁决计算。
      } else if (unresolved.some((proposal) => proposal.status === "ambiguous")) {
        status = "ambiguous";
        statusReason = "存在歧义实体，必须人工选择。";
      } else if (unresolved.some((proposal) => proposal.status === "unmatched")) {
        status = "unmatched";
        statusReason = "存在未匹配的必需或禁用实体。";
      } else if (unresolved.length > 0) {
        status = "pending";
        statusReason = "明确匹配仍需人工 accept。";
      } else {
        status = "bound";
        statusReason = "所有必需和禁用提案均有当前决策。";
      }
    }

    let bindingVector: unknown = null;
    let bindingCurrent = false;
    if (bindingSet && analysis) {
      const built = await buildBindingContext(projectRoot, snapshot, panel, analysis, bindingSet, shell.project.id);
      bindingVector = { id: bindingSet.id, fingerprint: bindingSet.fingerprint, context: built.vector };
      if (built.context) {
        const readiness = await getStudioAssetBindingReadiness(projectRoot, bindingSet.id, built.context);
        if (readiness?.ready && readiness.current) {
          status = "generation-ready";
          statusReason = readiness.warnings.length
            ? `BindingSet 当前有效；${readiness.warnings.length} 项 optional 未解析仅作提示。`
            : "BindingSet 当前有效，可进入 Codex 生图冻结。";
          bindingCurrent = true;
          for (const warning of readiness.warnings) blockers.push({ code: warning, message: warning, severity: "warning" });
        } else {
          status = "stale";
          statusReason = "已冻结 BindingSet 与当前剧本、决策或规范资产不一致。";
          for (const code of readiness?.blockers ?? ["binding-currentness-unavailable"]) blockers.push({ code, message: code, severity: "blocking" });
        }
      } else {
        status = "stale";
        statusReason = "BindingSet 的当前权威来源无法完整构建。";
        for (const entry of built.errors) blockers.push({ code: `${entry.code}:${entry.assetId ?? "unknown"}`, message: `资产 ${entry.assetId ?? "unknown"} 当前性核验失败。`, severity: "blocking" });
      }
    }
    const selectedDecisions = decisions.filter((head) => head.decision.action !== "exclude");
    const unresolvedBlocking = analysis?.proposals.some((proposal) => !decisionsByProposal.has(proposal.id) && proposal.presence !== "optional") ?? true;
    // 旧 BindingSet 因 unit/prompt/section/identity 演进而 stale 时，必须先得到一个锚定当前
    // scope 的新 analysis；新 analysis 已替代旧 BindingSet 所依赖的 analysis 后，旧 head 的
    // stale:* 仅说明“需要追加 replacement”，不能反向永久阻断 replacement freeze。
    // 若 section/identity 等外部 head 漂移后尚未重分析（analysis id 未变化），则继续失败关闭。
    const currentAnalysisReplacesBinding = Boolean(
      bindingSet
      && analysis
      && bindingSet.analysisId !== analysis.id,
    );
    const reanalysisRequired = Boolean(
      analysis
      && (!analysisTargetCurrent || blockers.some((entry) => entry.severity === "blocking"
        && staleBlockerRequiresReanalysis(entry.code)
        && !(currentAnalysisReplacesBinding && entry.code.startsWith("stale:")))),
    );
    const confirmEmptyAllowed = Boolean(
      analysis
      && analysisTargetCurrent
      && analysis.proposals.length === 0
      && (panel.sourceSpans.length > 0 || extensionPanel)
      && !currentEmptyConfirmation,
    );
    const regularFreezeEligible = Boolean(analysis && analysis.proposals.length > 0 && selectedDecisions.length > 0);
    const emptyFreezeEligible = Boolean(analysis && analysis.proposals.length === 0 && currentEmptyConfirmation);
    const freezeAllowed = Boolean(
      analysis
      && (panel.sourceSpans.length > 0 || extensionPanel)
      && analysisTargetCurrent
      && !unresolvedBlocking
      && (regularFreezeEligible || emptyFreezeEligible)
      && !bindingCurrent
      && !reanalysisRequired
      && !blockers.some((entry) => entry.severity === "blocking" && !entry.code.startsWith("stale:")),
    );
    const decisionVector = decisions.map((head) => ({
      proposalId: head.proposalId,
      revision: head.revision,
      id: head.decision.id,
      fingerprint: head.decision.fingerprint,
    }));
    revisionPanels.push({
      panelId: panel.id,
      sourceSpans: panel.sourceSpans,
      sourceSections: sourceExcerpts.flatMap((excerpt) => excerpt.sections.map((section) => ({
        revisionId: section.revisionId,
        fingerprint: section.fingerprint,
      }))),
      analysis: analysis ? {
        id: analysis.id,
        revision: analysis.revision,
        fingerprint: analysis.fingerprint,
        targetCurrent: analysisTargetCurrent,
        sectionHeadsCurrent: analysisSectionHeadsCurrent,
        identityKeyFingerprints: analysisIdentityKeyFingerprints,
      } : null,
      decisions: decisionVector,
      emptyConfirmation: confirmationHead ? {
        id: confirmationHead.confirmation.id,
        revision: confirmationHead.revision,
        fingerprint: confirmationHead.confirmation.fingerprint,
        current: currentEmptyConfirmation,
      } : null,
      binding: bindingVector,
    });
    panels.push({
      id: panel.id,
      ordinal: panel.index,
      label: panel.title,
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
      status,
      statusReason,
      sourceExcerpts,
      proposals: proposalViews,
      blockers,
      ...(confirmationHead ? {
        emptyConfirmation: {
          id: confirmationHead.confirmation.id,
          fingerprint: confirmationHead.confirmation.fingerprint,
          revision: confirmationHead.revision,
          reviewer: confirmationHead.confirmation.reviewer,
          note: confirmationHead.confirmation.note,
          currentness: currentEmptyConfirmation ? "current" : "stale",
          confirmedAt: confirmationHead.confirmation.createdAt,
        },
      } : {}),
      confirmEmptyAllowed,
      freezeAllowed,
      ...(bindingSet ? {
        bindingSet: {
          id: bindingSet.id,
          fingerprint: bindingSet.fingerprint,
          currentness: bindingCurrent ? "current" : "stale",
          frozenAt: bindingSet.createdAt,
        },
      } : {}),
    });
  }
  const revisionToken = digest({
    schemaVersion: 1,
    unitId: snapshot.unit.id,
    unitRevision: snapshot.unit.revision,
    unitFingerprint: snapshot.fingerprint,
    panels: revisionPanels,
  });
  const unitStatus = panels.some((panel) => panel.status === "stale") ? "stale"
    : panels.some((panel) => panel.status === "ambiguous") ? "ambiguous"
      : panels.some((panel) => panel.status === "unmatched") ? "unmatched"
        : panels.every((panel) => panel.status === "generation-ready") ? "generation-ready"
          : panels.some((panel) => panel.status === "bound") ? "bound"
            : "pending";
  const nextAction = firstNextAction(panels);
  const canonicalSuccessorUnitId = (
    await getStudioCanonicalSuccessorUnitIds(projectRoot, [snapshot.unit.id])
  )[snapshot.unit.id] ?? null;
  return {
    revisionToken,
    nextAction,
    unit: unitSummaryFromControl(snapshot, unitStatus, nextAction, canonicalSuccessorUnitId),
    panels,
    selectedPanelId: panels[0]?.id,
  };
}

async function assertRevisionToken(projectRoot: string, unitId: string, expected: string): Promise<StudioBindingControlSnapshot> {
  const token = requiredToken(expected);
  const control = await getStudioBindingControl(projectRoot, { unitId });
  if (control.revisionToken !== token) {
    throw new StudioBindingControlError("revision-conflict", "Studio binding 投影已变化，请刷新后重试。");
  }
  return control;
}

function atomicReceiptContext<TOutcome>(
  command: StudioBindingOperationCommand,
  inputFingerprint: string,
  context: StudioBindingCommandContext,
  buildOutcomeIdentity: StudioBindingAtomicReceiptContext<TOutcome>["buildOutcomeIdentity"],
): StudioBindingAtomicReceiptContext<TOutcome> {
  return {
    requestHash: assertRequestHash(context.requestHash),
    command,
    inputFingerprint,
    buildOutcomeIdentity,
  };
}

function crashAfterAtomicCommitForTest(command: StudioBindingOperationCommand): void {
  if (process.env.AI_CANVAS_TEST_STUDIO_BINDING_CRASH_AFTER_ATOMIC_COMMIT === command) {
    throw new Error(`TEST_ONLY_STUDIO_BINDING_CRASH_AFTER_ATOMIC_COMMIT:${command}`);
  }
}

async function readOperationReceipt(
  projectRoot: string,
  command: StudioBindingOperationCommand,
  inputFingerprint: string,
  context: StudioBindingCommandContext,
): Promise<StudioBindingOperationReceipt> {
  const requestHash = assertRequestHash(context.requestHash);
  const receipt = await getStudioBindingOperationReceipt(projectRoot, requestHash);
  if (!receipt
    || receipt.requestHash !== requestHash
    || receipt.command !== command
    || receipt.inputFingerprint !== inputFingerprint) {
    throw new StudioBindingControlError("receipt-invalid", `Studio binding 原子收据缺失或与命令不匹配：${command}。`);
  }
  return receipt;
}

function assertReceiptOutcome(
  receipt: StudioBindingOperationReceipt,
  expected: Record<string, unknown>,
): void {
  if (stableJson(receipt.outcomeIdentity) !== stableJson(expected)) {
    throw new StudioBindingControlError("receipt-invalid", `Studio binding 收据 outcome 与业务结果不匹配：${receipt.command}。`);
  }
}

export async function analyzeStudioScriptEntities(
  projectRoot: string,
  input: StudioBindingAnalyzeInput,
  context: StudioBindingCommandContext,
): Promise<StudioBindingAnalyzeOutcome> {
  const unitId = requiredId(input.unitId, "unitId");
  const panelId = requiredId(input.panelId, "panelId");
  const control = await assertRevisionToken(projectRoot, unitId, input.expectedRevisionToken);
  const panelControl = control.panels.find((panel) => panel.id === panelId);
  if (!panelControl) throw new StudioBindingControlError("panel-not-found", `宫格不存在：${panelId}`);
  const snapshot = await getStudioProductionUnitSnapshot(projectRoot, unitId);
  const panel = snapshot?.panels.find((entry) => entry.id === panelId);
  if (!snapshot || !panel) throw new StudioBindingControlError("panel-not-found", `宫格不存在：${panelId}`);
  // P20：extension（扩写）格禁锚 spans 属其定义，豁免 source-span 硬闸（对齐 studio-production :3847）。
  if (panel.sourceSpans.length === 0 && panel.shotType !== "extension") throw new StudioBindingControlError("source-span-missing", `宫格 ${panelId} 缺少剧本 source span。`);
  const [identities, documentSections] = await Promise.all([
    loadIdentityRows(projectRoot),
    loadCurrentScriptSections(projectRoot, snapshot.scriptRevision.id),
  ]);
  const sections = documentSections.filter((section) => section.scriptRevisionId === snapshot.scriptRevision.id);
  const mentions = mergeExtractedMentionPlan(
    snapshot,
    panel,
    mentionPlanForPanel(snapshot, panel, identities, sections),
    input.extractedMentions,
    sections,
  );
  const current = await getCurrentStudioPanelAssetMentionAnalysis(projectRoot, unitId, panelId);
  const analysisInput: AnalyzeStudioPanelAssetMentionsInput = {
    unitId,
    unitRevision: snapshot.unit.revision,
    unitFingerprint: snapshot.fingerprint,
    panelIndex: panel.index,
    scriptRevisionId: snapshot.scriptRevision.id,
    scriptSha256: snapshot.scriptRevision.bodySha256,
    expectedHeadRevision: current?.revision ?? 0,
    mentions,
    resolverVersion: input.extractedMentions === undefined
      ? ANALYZER_VERSION
      : `${ANALYZER_VERSION}+codex-proposals-v1`,
  };
  const buildOutcomeIdentity = (analysis: StudioAssetMentionAnalysis) => ({
    kind: "studio-binding-analyze-outcome",
    unitId,
    panelId,
    analysisId: analysis.id,
    analysisRevision: analysis.revision,
    analysisFingerprint: analysis.fingerprint,
  });
  const analysis = await analyzeStudioPanelAssetMentions(
    projectRoot,
    analysisInput,
    atomicReceiptContext("analyze_studio_script_entities", control.revisionToken, context, buildOutcomeIdentity),
  );
  crashAfterAtomicCommitForTest("analyze_studio_script_entities");
  const receipt = await readOperationReceipt(projectRoot, "analyze_studio_script_entities", control.revisionToken, context);
  assertReceiptOutcome(receipt, buildOutcomeIdentity(analysis));
  return {
    receiptId: receipt.id,
    receiptFingerprint: receipt.outcomeFingerprint,
    analysisId: analysis.id,
    analysisRevision: analysis.revision,
    analysisFingerprint: analysis.fingerprint,
    unitId,
    panelId,
    message: `宫格 ${panel.index} 已保存 ${analysis.proposals.length} 项可追溯实体提案。`,
  };
}

export async function resolveStudioEntityProposal(
  projectRoot: string,
  input: StudioBindingResolveInput,
  context: StudioBindingCommandContext,
): Promise<StudioBindingResolveOutcome> {
  const unitId = requiredId(input.unitId, "unitId");
  const panelId = requiredId(input.panelId, "panelId");
  const proposalId = requiredId(input.proposalId, "proposalId");
  const control = await assertRevisionToken(projectRoot, unitId, input.expectedRevisionToken);
  const panelControl = control.panels.find((panel) => panel.id === panelId);
  const proposalControl = panelControl?.proposals.find((proposal) => proposal.id === proposalId);
  if (!panelControl) throw new StudioBindingControlError("panel-not-found", `宫格不存在：${panelId}`);
  if (!proposalControl) throw new StudioBindingControlError("proposal-missing", `实体提案不存在：${proposalId}`);
  const analysis = await getCurrentStudioPanelAssetMentionAnalysis(projectRoot, unitId, panelId);
  const proposal = analysis?.proposals.find((entry) => entry.id === proposalId);
  if (!analysis || !proposal) throw new StudioBindingControlError("analysis-missing", "当前分析已变化。");
  if (input.decision !== "accept" && input.decision !== "select" && input.decision !== "exclude") {
    throw new StudioBindingControlError("decision-invalid", "decision 无效。");
  }
  const exactCandidates = proposal.candidates.filter((candidate) => candidate.kind !== "model");
  if (
    input.decision === "accept"
    && (
      proposal.status !== "matched"
      || exactCandidates.length !== 1
      || input.selectedAssetId !== exactCandidates[0]?.assetId
    )
  ) {
    throw new StudioBindingControlError("decision-invalid", "accept 只允许确认唯一 exact matched 提案。");
  }
  if (input.decision === "select"
    && (!input.selectedAssetId || !proposal.candidates.some((candidate) => candidate.assetId === input.selectedAssetId))) {
    throw new StudioBindingControlError("decision-invalid", "select 必须显式选择 exact 或 model 待审候选中的资产。");
  }
  if (input.decision === "exclude" && input.selectedAssetId) {
    throw new StudioBindingControlError("decision-invalid", "exclude 决策不能携带 selectedAssetId。");
  }
  if (input.presence !== "required" && input.presence !== "optional" && input.presence !== "forbidden") {
    throw new StudioBindingControlError("decision-invalid", "presence 无效。");
  }
  const role = input.role.trim();
  if (!role) throw new StudioBindingControlError("decision-invalid", "role 不能为空。");
  const selectedAssetId = input.decision === "exclude" ? undefined : input.selectedAssetId;
  const head = await getCurrentStudioMentionDecision(projectRoot, proposalId);
  const reviewer = context.reviewer ?? "user";
  const note = input.note?.trim() || (reviewer === "user" ? "用户通过绑定工作台确认。" : "Codex 根据明确指令记录。");
  const decisionSemantic = {
    proposalFingerprint: proposal.fingerprint,
    action: input.decision,
    selectedAssetId: selectedAssetId ?? null,
    presence: input.presence,
    role,
    reviewer,
    note,
  };
  const decisionId = `mention-decision-${digest(decisionSemantic).slice(0, 40)}`;
  const buildOutcomeIdentity = (decision: StudioMentionDecisionReceipt, decisionRevision: number) => ({
    kind: "studio-binding-resolve-outcome",
    unitId,
    panelId,
    proposalId,
    decisionId: decision.id,
    decisionRevision,
    decisionFingerprint: decision.fingerprint,
  });
  const decision = await recordStudioMentionDecision(projectRoot, {
    receiptId: decisionId,
    proposalId,
    expectedAnalysisHeadRevision: analysis.revision,
    expectedDecisionHeadRevision: head?.revision ?? 0,
    action: input.decision,
    ...(selectedAssetId ? { selectedAssetId } : {}),
    presence: input.presence,
    role,
    reviewer,
    note,
  }, atomicReceiptContext("resolve_studio_entity_proposal", control.revisionToken, context, buildOutcomeIdentity));
  crashAfterAtomicCommitForTest("resolve_studio_entity_proposal");
  const receipt = await readOperationReceipt(projectRoot, "resolve_studio_entity_proposal", control.revisionToken, context);
  const decisionRevision = Number(receipt.outcomeIdentity.decisionRevision);
  if (!Number.isSafeInteger(decisionRevision) || decisionRevision < 1) {
    throw new StudioBindingControlError("receipt-invalid", "Studio binding resolve 收据缺少有效 decisionRevision。");
  }
  assertReceiptOutcome(receipt, buildOutcomeIdentity(decision, decisionRevision));
  return {
    receiptId: receipt.id,
    receiptFingerprint: receipt.outcomeFingerprint,
    decisionId: decision.id,
    decisionRevision,
    decisionFingerprint: decision.fingerprint,
    unitId,
    panelId,
    proposalId,
    message: input.decision === "exclude" ? "已追加人工排除决策。" : "已追加人工资产绑定决策。",
  };
}

export async function confirmStudioPanelEmptyFromControl(
  projectRoot: string,
  input: StudioBindingConfirmEmptyInput,
  context: StudioBindingCommandContext,
): Promise<StudioBindingConfirmEmptyOutcome> {
  const unitId = requiredId(input.unitId, "unitId");
  const panelId = requiredId(input.panelId, "panelId");
  if (input.reviewer !== "user" && input.reviewer !== "codex") {
    throw new StudioBindingControlError("invalid-input", "reviewer 必须是 user 或 codex。");
  }
  if (context.reviewer && context.reviewer !== input.reviewer) {
    throw new StudioBindingControlError("invalid-input", "命令上下文 reviewer 与 payload 不一致。");
  }
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (!note || note.length > 4_000) {
    throw new StudioBindingControlError("invalid-input", "confirmed-empty note 必须是 1-4000 字符的真实审阅说明。");
  }
  const control = await assertRevisionToken(projectRoot, unitId, input.expectedRevisionToken);
  const panelControl = control.panels.find((panel) => panel.id === panelId);
  if (!panelControl) throw new StudioBindingControlError("panel-not-found", `宫格不存在：${panelId}`);
  const snapshot = await getStudioProductionUnitSnapshot(projectRoot, unitId);
  if (!snapshot) throw new StudioBindingControlError("panel-not-found", `生产单元不存在：${unitId}`);
  const sourcePanel = await localSourcePanelContract(projectRoot, snapshot, panelId);
  if (sourcePanel && sourcePanel.declaredReferences.length > 0) {
    throw new StudioBindingControlError(
      "binding-blocked",
      "来源任务已声明参考图，禁止把该宫格裁决为 confirmed-empty；必须映射为 current Authority。",
    );
  }
  if (!panelControl.confirmEmptyAllowed) {
    throw new StudioBindingControlError("binding-blocked", panelControl.blockers[0]?.message ?? "当前宫格不允许 confirmed-empty 裁决。");
  }
  const analysis = await getCurrentStudioPanelAssetMentionAnalysis(projectRoot, unitId, panelId);
  if (!analysis) throw new StudioBindingControlError("analysis-missing", "当前宫格没有 analysis head。");
  if (analysis.proposals.length !== 0) {
    throw new StudioBindingControlError("binding-blocked", "只有零提案分析可确认 confirmed-empty。");
  }
  const head = await getCurrentStudioPanelEntityClosureConfirmation(projectRoot, unitId, panelId);
  const buildOutcomeIdentity = (confirmation: StudioPanelEntityClosureConfirmation) => ({
    kind: "studio-binding-confirm-empty-outcome",
    unitId,
    panelId,
    confirmationId: confirmation.id,
    confirmationRevision: confirmation.revision,
    confirmationFingerprint: confirmation.fingerprint,
  });
  const confirmation = await confirmStudioPanelEntityClosureEmpty(projectRoot, {
    analysisId: analysis.id,
    expectedAnalysisHeadRevision: analysis.revision,
    expectedConfirmationHeadRevision: head?.revision ?? 0,
    reviewer: input.reviewer,
    note,
  }, atomicReceiptContext("confirm_studio_panel_empty", control.revisionToken, {
    ...context,
    reviewer: input.reviewer,
  }, buildOutcomeIdentity));
  crashAfterAtomicCommitForTest("confirm_studio_panel_empty");
  const receipt = await readOperationReceipt(projectRoot, "confirm_studio_panel_empty", control.revisionToken, context);
  assertReceiptOutcome(receipt, buildOutcomeIdentity(confirmation));
  return {
    receiptId: receipt.id,
    receiptFingerprint: receipt.outcomeFingerprint,
    confirmationId: confirmation.id,
    confirmationRevision: confirmation.revision,
    confirmationFingerprint: confirmation.fingerprint,
    unitId,
    panelId,
    message: "已追加 confirmed-empty 裁决；现在可冻结零资产 BindingSet。",
  };
}

function aggregateSelectedDecisions(
  analysis: StudioAssetMentionAnalysis,
  decisions: StudioMentionDecisionHead[],
): Array<{ assetId: string; category: StudioAssetCategory; presence: StudioAssetPresence; role: string }> {
  const byProposal = decisionMap(decisions);
  const grouped = new Map<string, Array<{ category: StudioAssetCategory; presence: StudioAssetPresence; role: string }>>();
  for (const proposal of analysis.proposals) {
    const decision = byProposal.get(proposal.id)?.decision;
    if (!decision || decision.action === "exclude") continue;
    const candidate = proposal.candidates.find((entry) => entry.assetId === decision.selectedAssetId);
    if (!candidate || !decision.selectedAssetId) throw new StudioBindingControlError("decision-invalid", `决策候选已漂移：${proposal.id}`);
    grouped.set(decision.selectedAssetId, [
      ...(grouped.get(decision.selectedAssetId) ?? []),
      { category: candidate.category, presence: decision.presence, role: decision.role },
    ]);
  }
  return [...grouped.entries()].map(([assetId, values]) => {
    const categories = new Set(values.map((value) => value.category));
    const roles = new Set(values.map((value) => value.role));
    const presences = new Set(values.map((value) => value.presence));
    if (categories.size !== 1 || roles.size !== 1 || (presences.has("forbidden") && presences.size > 1)) {
      throw new StudioBindingControlError("binding-blocked", `资产 ${assetId} 在当前宫格存在 category/role/presence 冲突。`);
    }
    const presence: StudioAssetPresence = presences.has("forbidden")
      ? "forbidden"
      : presences.has("required")
        ? "required"
        : "optional";
    return {
      assetId,
      category: values[0]!.category,
      presence,
      role: values[0]!.role,
    };
  }).sort((left, right) => left.assetId.localeCompare(right.assetId, "en"));
}

export async function freezeStudioAssetBindingSetFromControl(
  projectRoot: string,
  input: StudioBindingFreezeInput,
  context: StudioBindingCommandContext,
): Promise<StudioBindingFreezeOutcome> {
  const unitId = requiredId(input.unitId, "unitId");
  const panelId = requiredId(input.panelId, "panelId");
  const control = await assertRevisionToken(projectRoot, unitId, input.expectedRevisionToken);
  const panelControl = control.panels.find((panel) => panel.id === panelId);
  if (!panelControl) throw new StudioBindingControlError("panel-not-found", `宫格不存在：${panelId}`);
  if (!panelControl.freezeAllowed) throw new StudioBindingControlError("binding-blocked", panelControl.blockers[0]?.message ?? "当前宫格不允许冻结 BindingSet。");
  const snapshot = await getStudioProductionUnitSnapshot(projectRoot, unitId);
  const panel = snapshot?.panels.find((entry) => entry.id === panelId);
  const analysis = await getCurrentStudioPanelAssetMentionAnalysis(projectRoot, unitId, panelId);
  if (!snapshot || !panel) throw new StudioBindingControlError("panel-not-found", `宫格不存在：${panelId}`);
  if (!analysis) throw new StudioBindingControlError("analysis-missing", "当前宫格没有 analysis head。");
  const decisions = await getCurrentStudioMentionDecisionsForAnalysis(projectRoot, analysis.id);
  const selected = aggregateSelectedDecisions(analysis, decisions);
  const emptyConfirmation = analysis.proposals.length === 0
    ? await getCurrentStudioPanelEntityClosureConfirmation(projectRoot, unitId, panelId)
    : null;
  if (selected.length === 0 && !emptyConfirmation) {
    throw new StudioBindingControlError("binding-blocked", "没有任何经人工确认的规范资产或当前 confirmed-empty 裁决。");
  }
  const shell = await inspectManagedProject(projectRoot);
  const target = targetForPanel(shell.project.id, snapshot, panel);
  const assetSources = await Promise.all(selected.map((entry) => buildStudioAssetBindingSourceSnapshot(projectRoot, entry, target)));
  const sourcePanel = await localSourcePanelContract(projectRoot, snapshot, panelId);
  if (sourcePanel?.declaredReferences.length) {
    const selectedMedia = new Set(assetSources.map((source) => source.mediaSha256));
    const unresolved = sourcePanel.declaredReferences.filter((reference) => (
      !reference.importedMediaSha256 || !selectedMedia.has(reference.importedMediaSha256)
    ));
    if (unresolved.length > 0) {
      throw new StudioBindingControlError(
        "binding-blocked",
        `来源声明的 ${unresolved.length} 个参考尚未映射为本宫格 current Authority；禁止冻结。`,
      );
    }
  }
  await assertRevisionToken(projectRoot, unitId, control.revisionToken);
  const currentBinding = await getCurrentStudioPanelAssetBindingSet(projectRoot, unitId, panelId);
  const buildOutcomeIdentity = (bindingSet: StudioAssetBindingSet) => ({
    kind: "studio-binding-freeze-outcome",
    unitId,
    panelId,
    bindingSetId: bindingSet.id,
    bindingSetRevision: bindingSet.revision,
    bindingSetFingerprint: bindingSet.fingerprint,
  });
  const bindingSet = await freezeStudioPanelAssetBindingSet(projectRoot, {
    analysisId: analysis.id,
    expectedAnalysisHeadRevision: analysis.revision,
    expectedBindingHeadRevision: currentBinding?.revision ?? 0,
    decisionReceiptIds: decisions.map((entry) => entry.decision.id),
    assetSources,
    ...(emptyConfirmation ? { emptyConfirmationId: emptyConfirmation.confirmation.id } : {}),
  }, atomicReceiptContext("freeze_studio_asset_binding_set", control.revisionToken, context, buildOutcomeIdentity));
  crashAfterAtomicCommitForTest("freeze_studio_asset_binding_set");
  const receipt = await readOperationReceipt(projectRoot, "freeze_studio_asset_binding_set", control.revisionToken, context);
  assertReceiptOutcome(receipt, buildOutcomeIdentity(bindingSet));
  return {
    receiptId: receipt.id,
    receiptFingerprint: receipt.outcomeFingerprint,
    bindingSetId: bindingSet.id,
    bindingSetRevision: bindingSet.revision,
    bindingSetFingerprint: bindingSet.fingerprint,
    unitId,
    panelId,
    message: "已冻结 current AssetBindingSet，生图将只使用该闭包。",
  };
}

export async function proveStudioBindingOperationOutcome(
  projectRoot: string,
  requestHash: string,
  command: StudioBindingOperationCommand,
): Promise<{ receipt: StudioBindingOperationReceipt; outcome: Record<string, unknown> } | undefined> {
  const receipt = await getStudioBindingOperationReceipt(projectRoot, requestHash);
  if (!receipt || receipt.command !== command) return undefined;
  const outcome = receipt.outcomeIdentity;
  if (command === "analyze_studio_script_entities") {
    const analysisId = typeof outcome.analysisId === "string" ? outcome.analysisId : "";
    const analysis = analysisId ? await getStudioAssetMentionAnalysis(projectRoot, analysisId) : null;
    if (!analysis || analysis.fingerprint !== outcome.analysisFingerprint || analysis.revision !== outcome.analysisRevision) return undefined;
  } else if (command === "resolve_studio_entity_proposal") {
    const decisionId = typeof outcome.decisionId === "string" ? outcome.decisionId : "";
    const decision = decisionId ? await getStudioMentionDecision(projectRoot, decisionId) : null;
    if (!decision || decision.fingerprint !== outcome.decisionFingerprint) return undefined;
  } else if (command === "confirm_studio_panel_empty") {
    const confirmationId = typeof outcome.confirmationId === "string" ? outcome.confirmationId : "";
    const confirmation = confirmationId ? await getStudioPanelEntityClosureConfirmation(projectRoot, confirmationId) : null;
    if (!confirmation
      || confirmation.fingerprint !== outcome.confirmationFingerprint
      || confirmation.revision !== outcome.confirmationRevision) return undefined;
  } else {
    const bindingSetId = typeof outcome.bindingSetId === "string" ? outcome.bindingSetId : "";
    const bindingSet = bindingSetId ? await getStudioAssetBindingSet(projectRoot, bindingSetId) : null;
    if (!bindingSet || bindingSet.fingerprint !== outcome.bindingSetFingerprint || bindingSet.revision !== outcome.bindingSetRevision) return undefined;
  }
  return { receipt, outcome };
}

/**
 * P24：构建 BindingSet 的当前上下文（metadata 诊断版语义，规范 §2.4 逃生门）。
 * 复用 buildBindingContext 既有组合（与绑定工作台口径一致；metadataBindingSource 纯元数据路径，
 * 不触发 freeze 写路径的 CAS 实测）；供追溯分类与 canvas:get-studio-pack-currentness IPC 使用。
 * 纯只读组合：仅 SELECT/元数据读取，无任何写路径。
 */
export async function buildStudioAssetBindingCurrentContext(
  projectRoot: string,
  bindingSetId: string,
): Promise<StudioAssetBindingCurrentContext> {
  const shell = await inspectManagedProject(projectRoot);
  const bindingSet = await getStudioAssetBindingSet(projectRoot, bindingSetId);
  if (!bindingSet) throw new StudioBindingControlError("binding-set-not-found", `BindingSet 不存在：${bindingSetId}`);
  const snapshot = await getStudioProductionUnitSnapshot(projectRoot, bindingSet.unitId);
  if (!snapshot) throw new StudioBindingControlError("unit-not-found", `生产单元不存在：${bindingSet.unitId}`);
  const panel = snapshot.panels.find((entry) => entry.index === bindingSet.panelIndex);
  if (!panel) {
    throw new StudioBindingControlError("panel-not-found", `单元 ${bindingSet.unitId} 当前 head 无宫格 index=${bindingSet.panelIndex}。`);
  }
  const analysis = await getStudioAssetMentionAnalysis(projectRoot, bindingSet.analysisId);
  if (!analysis) throw new StudioBindingControlError("analysis-not-found", `实体分析不存在：${bindingSet.analysisId}`);
  const built = await buildBindingContext(projectRoot, snapshot, panel, analysis, bindingSet, shell.project.id);
  if (!built.context) {
    throw new StudioBindingControlError(
      "binding-context-incomplete",
      `BindingSet ${bindingSetId} 的当前上下文无法完整构建（资产缺失或权威闭包不完整）：${built.errors.map((entry) => `${entry.code}:${entry.assetId ?? "unknown"}`).join(", ")}`,
    );
  }
  return built.context;
}
