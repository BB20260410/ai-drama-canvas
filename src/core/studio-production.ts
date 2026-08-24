import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync, lstatSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  getStudioCanonicalAsset,
  getStudioIdentityIndexSnapshot,
  normalizeStudioIdentityKey,
  type StudioIdentityIndexEntry,
} from "./material-studio.js";
import {
  ensureConfinedDirectory,
  persistConfinedBytesNoReplace,
  type ConfinedDirectoryIdentity,
} from "./confined-project-storage.js";
import {
  hasStudioRequestSchemaValidation,
  isStudioRequestSqliteValidationUnchanged,
  markStudioRequestSqliteValidationIfUnchanged,
  studioRequestSqliteValidationKey,
} from "./studio-request-schema-cache.js";
import { inspectManagedProjectReadOnly } from "./managed-project.js";
import { recordStudioUnitsReadCounter } from "./studio-units-read-phase-timeline.js";
import { openSqliteReadOnlySnapshot } from "./sqlite-readonly-snapshot.js";

const SCHEMA_VERSION = 6;
const DATABASE_RELATIVE_PATH = ".aicanvas/studio-production.sqlite";
const TEXT_CAS_RELATIVE_ROOT = ".aicanvas/studio-production/objects/sha256";
const TEXT_CAS_TEMP_RELATIVE_ROOT = ".aicanvas/studio-production/objects/.tmp";
import { STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS, studioSqliteBusyTimeoutMs } from "./studio-sqlite-busy.js";
const BUSY_TIMEOUT_MS = STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_TEXT_BODY_BYTES = 16 * 1024 * 1024;
const UNIT_DURATION_MILLISECONDS = 15_000;
const MIN_UNIT_DURATION_MILLISECONDS = 1_000;
const MAX_MENTION_CANDIDATES = 5;

export const STUDIO_PRODUCTION_DURATION_SECONDS = 15;
export const STUDIO_PRODUCTION_MIN_PANEL_COUNT = 2;
export const STUDIO_PRODUCTION_MAX_PANEL_COUNT = 6;
/** v1 数据迁移后使用的显式保留季；绝不等同于“所有季”。 */
export const STUDIO_PRODUCTION_LEGACY_SEASON_ID = "__legacy_unassigned_season__";

export type StudioTextDocumentKind = "script" | "prompt";
export type StudioAssetCategory = "character" | "scene" | "prop" | "style";
export type StudioAssetPresence = "required" | "optional" | "forbidden";

export interface StudioProductionState {
  schemaVersion: 6;
  databasePath: string;
  textCasRoot: string;
  pragmas: {
    journalMode: "wal";
    foreignKeys: true;
    busyTimeoutMs: number;
  };
  counts: {
    textDocuments: number;
    scriptDocuments: number;
    promptDocuments: number;
    textRevisions: number;
    units: number;
    /** 当前 unit head 的 panel_count 精确 SUM，非抽样估算。 */
    panels: number;
    unitRevisions: number;
    /** P30：显式真实时长行；旧 revision 无行时继续按 legacy 15 秒读取。 */
    unitTimings: number;
    contractProfiles: number;
    scriptSectionRevisions: number;
    mentionAnalyses: number;
    mentionProposals: number;
    mentionDecisions: number;
    panelEntityClosureConfirmations: number;
    assetBindingSets: number;
  };
}

export type StudioScriptSectionKind = "chapter" | "scene";
export type StudioMentionStatus = "matched" | "ambiguous" | "unmatched";
export type StudioMentionCandidateKind = "id" | "formal-name" | "alias" | "model";
export type StudioMentionDecisionAction = "accept" | "select" | "exclude";

/**
 * 剧本文本中的版本化章节/场景范围。offset 与 String#slice 一致，固定为
 * UTF-16 code unit；范围永远锚定不可变的 script text revision。
 */
export interface StudioScriptSectionRevision {
  id: string;
  sectionId: string;
  revision: number;
  kind: StudioScriptSectionKind;
  title: string;
  scriptRevisionId: string;
  scriptSha256: string;
  startOffsetUtf16: number;
  endOffsetUtf16: number;
  surfaceSha256: string;
  fingerprint: string;
  createdAt: string;
}

export interface AppendStudioScriptSectionRevisionInput {
  sectionId: string;
  expectedRevision: number;
  kind: StudioScriptSectionKind;
  title: string;
  scriptRevisionId: string;
  scriptSha256: string;
  startOffsetUtf16: number;
  endOffsetUtf16: number;
}

export interface StudioScriptSectionListQuery {
  scriptRevisionId?: string;
  cursor?: string;
  limit?: number;
}

export interface StudioScriptSectionPage {
  items: StudioScriptSectionRevision[];
  nextCursor?: string;
}

export interface StudioMentionResolvableAsset {
  assetId: string;
  category: StudioAssetCategory;
  formalName: string;
  aliases: string[];
}

export interface StudioMentionModelSuggestion {
  assetId: string;
  category: StudioAssetCategory;
  confidence?: number;
}

export interface StudioAssetMentionAnalysisInput {
  id: string;
  surfaceText: string;
  startOffsetUtf16: number;
  endOffsetUtf16: number;
  sectionRevisionId?: string;
  category?: StudioAssetCategory;
  presence: StudioAssetPresence;
  role: string;
  modelSuggestions?: StudioMentionModelSuggestion[];
}

export interface AnalyzeStudioPanelAssetMentionsInput {
  unitId: string;
  unitRevision: number;
  unitFingerprint: string;
  panelIndex: number;
  scriptRevisionId: string;
  scriptSha256: string;
  expectedHeadRevision: number;
  mentions: StudioAssetMentionAnalysisInput[];
  /** @deprecated 仅保留调用兼容；exact 解析只读 material-studio 精确身份索引。 */
  assets?: StudioMentionResolvableAsset[];
  resolverVersion?: string;
}

export interface StudioAssetMentionCandidate {
  rank: number;
  kind: StudioMentionCandidateKind;
  assetId: string;
  category: StudioAssetCategory;
  matchedValue: string;
}

export interface StudioAssetMentionProposal {
  id: string;
  mentionId: string;
  surfaceText: string;
  startOffsetUtf16: number;
  endOffsetUtf16: number;
  surfaceSha256: string;
  sectionRevisionId?: string;
  category?: StudioAssetCategory;
  presence: StudioAssetPresence;
  role: string;
  status: StudioMentionStatus;
  normalizedIdentityKey: string;
  candidateSetFingerprint: string;
  candidates: StudioAssetMentionCandidate[];
  fingerprint: string;
  createdAt: string;
}

export interface StudioAssetMentionAnalysis {
  schemaVersion: 1;
  kind: "studio-asset-mention-analysis";
  id: string;
  revision: number;
  unitId: string;
  unitRevision: number;
  unitFingerprint: string;
  panelIndex: number;
  scriptRevisionId: string;
  scriptSha256: string;
  resolverVersion: string;
  proposals: StudioAssetMentionProposal[];
  fingerprint: string;
  createdAt: string;
}

export interface StudioAssetMentionAnalysisListQuery {
  unitId?: string;
  cursor?: string;
  limit?: number;
}

export interface StudioAssetMentionAnalysisPage {
  items: StudioAssetMentionAnalysis[];
  nextCursor?: string;
}

export interface RecordStudioMentionDecisionInput {
  receiptId: string;
  proposalId: string;
  expectedAnalysisHeadRevision: number;
  expectedDecisionHeadRevision: number;
  action: StudioMentionDecisionAction;
  selectedAssetId?: string;
  presence?: StudioAssetPresence;
  role?: string;
  reviewer: string;
  note?: string;
}

export interface StudioMentionDecisionReceipt {
  id: string;
  proposalId: string;
  proposalFingerprint: string;
  action: StudioMentionDecisionAction;
  selectedAssetId?: string;
  presence: StudioAssetPresence;
  role: string;
  reviewer: string;
  note: string;
  fingerprint: string;
  createdAt: string;
}

export interface StudioMentionDecisionHead {
  proposalId: string;
  revision: number;
  decision: StudioMentionDecisionReceipt;
  updatedAt: string;
}

export type StudioPanelEntityClosureReviewer = "user" | "codex";

export interface ConfirmStudioPanelEntityClosureEmptyInput {
  analysisId: string;
  expectedAnalysisHeadRevision: number;
  expectedConfirmationHeadRevision: number;
  reviewer: StudioPanelEntityClosureReviewer;
  note: string;
}

/**
 * 仅表示“当前宫格已被显式审阅为无可绑定实体”。
 * 它是追加式人工/Codex 裁决，绝不由 proposals=[] 自动产生。
 */
export interface StudioPanelEntityClosureConfirmation {
  schemaVersion: 1;
  kind: "studio-panel-entity-closure-confirmation";
  id: string;
  revision: number;
  closure: "confirmed-empty";
  analysisId: string;
  analysisFingerprint: string;
  unitId: string;
  unitRevision: number;
  unitFingerprint: string;
  panelId: string;
  panelIndex: number;
  panelBindingScopeFingerprint: string;
  scriptRevisionId: string;
  scriptSha256: string;
  promptRevisionId: string;
  promptSha256: string;
  sourceSpans: StudioProductionPanelSourceSpan[];
  reviewer: StudioPanelEntityClosureReviewer;
  note: string;
  fingerprint: string;
  createdAt: string;
}

export interface StudioPanelEntityClosureConfirmationHead {
  unitId: string;
  panelIndex: number;
  revision: number;
  confirmation: StudioPanelEntityClosureConfirmation;
  updatedAt: string;
}

export interface StudioPanelEntityClosureConfirmationCurrentness {
  confirmationId: string;
  head: boolean;
  current: boolean;
  staleReasons: string[];
}

/** 不包含媒体路径或媒体字节；仅冻结 generation 需要的内容身份。 */
export interface StudioAssetBindingSourceSnapshot {
  assetId: string;
  category: StudioAssetCategory;
  assetRevision: number;
  definitionVersionId: string;
  authorityEventId: string;
  authorityVersionId: string;
  assetVersionId: string;
  mediaSha256: string;
  knowledgeFingerprint: string;
  applicabilityFingerprint: string;
}

export interface FreezeStudioPanelAssetBindingSetInput {
  analysisId: string;
  expectedAnalysisHeadRevision: number;
  expectedBindingHeadRevision: number;
  decisionReceiptIds: string[];
  assetSources: StudioAssetBindingSourceSnapshot[];
  /** proposals=0 时必须显式传入当前 confirmed-empty 裁决。 */
  emptyConfirmationId?: string;
}

export interface StudioPanelAssetBinding {
  assetId: string;
  category: StudioAssetCategory;
  presence: StudioAssetPresence;
  role: string;
  mentionIds: string[];
  assetRevision: number;
  definitionVersionId: string;
  authorityEventId: string;
  authorityVersionId: string;
  assetVersionId: string;
  mediaSha256: string;
  knowledgeFingerprint: string;
  applicabilityFingerprint: string;
  semanticFingerprint: string;
}

export interface StudioAssetBindingSet {
  schemaVersion: 1;
  kind: "studio-panel-asset-binding-set";
  id: string;
  revision: number;
  analysisId: string;
  unitId: string;
  unitRevision: number;
  unitFingerprint: string;
  panelIndex: number;
  scriptRevisionId: string;
  scriptSha256: string;
  promptRevisionId: string;
  promptSha256: string;
  bindings: StudioPanelAssetBinding[];
  identityKeyFingerprints: Record<string, string>;
  decisionReceiptIds: string[];
  unresolvedOptionalMentionIds: string[];
  /** 实际读投影始终返回；旧库的非空 BindingSet 为 false。 */
  confirmedEmpty: boolean;
  emptyConfirmationId?: string;
  emptyConfirmationFingerprint?: string;
  fingerprint: string;
  createdAt: string;
}

export interface StudioAssetBindingSetListQuery {
  unitId?: string;
  cursor?: string;
  limit?: number;
}

export interface StudioAssetBindingSetPage {
  items: StudioAssetBindingSet[];
  nextCursor?: string;
}

export interface StudioAssetBindingCurrentContext {
  /** 当前 exact 候选集 fingerprint，key 为 normalizedIdentityKey。 */
  identityKeyFingerprints: Record<string, string>;
  assets: StudioAssetBindingSourceSnapshot[];
}

export interface StudioAssetBindingSetCurrentness {
  bindingSetId: string;
  head: boolean;
  current: boolean;
  staleReasons: string[];
}

export interface StudioAssetBindingReadiness extends StudioAssetBindingSetCurrentness {
  ready: boolean;
  blockers: string[];
  warnings: string[];
}

export type StudioBindingOperationCommand =
  | "analyze_studio_script_entities"
  | "resolve_studio_entity_proposal"
  | "confirm_studio_panel_empty"
  | "freeze_studio_asset_binding_set";

export interface StudioBindingOperationReceipt {
  id: string;
  requestHash: string;
  command: StudioBindingOperationCommand;
  inputFingerprint: string;
  outcomeIdentity: Record<string, unknown>;
  outcomeFingerprint: string;
  createdAt: string;
}

export interface RecordStudioBindingOperationReceiptInput {
  requestHash: string;
  command: StudioBindingOperationCommand;
  inputFingerprint: string;
  outcomeIdentity: Record<string, unknown>;
}

/**
 * 高层 Studio binding 命令传入的原子收据上下文。低层直调不传此参数时，
 * 仍只提交原有业务事务；传入时，业务行、Head 与不可变 operation receipt
 * 必须在同一个 BEGIN IMMEDIATE 事务中落库。
 */
export interface StudioBindingAtomicReceiptContext<TOutcome> {
  requestHash: string;
  command: StudioBindingOperationCommand;
  inputFingerprint: string;
  buildOutcomeIdentity: (outcome: TOutcome, headRevision: number) => Record<string, unknown>;
}

export interface StudioTextDocument {
  id: string;
  kind: StudioTextDocumentKind;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface StudioTextRevisionMetadata {
  id: string;
  documentId: string;
  documentKind: StudioTextDocumentKind;
  documentTitle: string;
  ordinal: number;
  bodySha256: string;
  bodySizeBytes: number;
  /** 项目内 CAS 文本的绝对路径，不是媒体或 SQLite BLOB。 */
  bodyPath: string;
  source: string;
  sourceVersion: string;
  createdAt: string;
}

export interface StudioTextRevision extends StudioTextRevisionMetadata {
  body: string;
}

export interface CreateStudioTextDocumentInput {
  id?: string;
  kind: StudioTextDocumentKind;
  title: string;
  /** 创建是从不存在到空文档头的 CAS。 */
  expectedRevision: 0;
}

export type CreateStudioScriptDocumentInput = Omit<CreateStudioTextDocumentInput, "kind">;
export type CreateStudioPromptDocumentInput = Omit<CreateStudioTextDocumentInput, "kind">;

export interface AppendStudioTextRevisionInput {
  documentId: string;
  expectedRevision: number;
  body: string;
  source: string;
  sourceVersion: string;
}

export interface AppendStudioTextRevisionResult {
  document: StudioTextDocument;
  revision: StudioTextRevision;
}

export interface StudioTextDocumentListQuery {
  kind?: StudioTextDocumentKind;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface StudioTextDocumentPage {
  items: StudioTextDocument[];
  nextCursor?: string;
}

export interface StudioTextRevisionListQuery {
  documentId: string;
  cursor?: string;
  limit?: number;
}

export interface StudioTextRevisionPage {
  items: StudioTextRevisionMetadata[];
  nextCursor?: string;
}

export interface StudioContinuityEvidenceInput {
  kind: string;
  reference: string;
  note?: string;
}

export interface StudioContinuityEvidence {
  index: number;
  kind: string;
  reference: string;
  note: string;
}

export interface StudioPanelAssetMentionInput {
  assetId: string;
  category: StudioAssetCategory;
  presence: StudioAssetPresence;
  role: string;
  continuityState: string;
  evidence: StudioContinuityEvidenceInput[];
}

export interface StudioPanelAssetMention {
  assetId: string;
  category: StudioAssetCategory;
  presence: StudioAssetPresence;
  role: string;
  continuityState: string;
  evidence: StudioContinuityEvidence[];
}

export interface StudioProductionPanelSourceSpanInput {
  /** 与 JavaScript String#slice 一致的 UTF-16 code unit 偏移。 */
  startOffsetUtf16: number;
  endOffsetUtf16: number;
}

/** 锚定单元不可变剧本修订的面板原文范围。 */
export interface StudioProductionPanelSourceSpan {
  scriptRevisionId: string;
  scriptSha256: string;
  startOffsetUtf16: number;
  endOffsetUtf16: number;
  surfaceSha256: string;
}

export interface StudioProductionPanelInput {
  id?: string;
  title: string;
  visualAction: string;
  shotComposition: string;
  filmingMethod: string;
  dialogue?: string;
  subtitle?: string;
  startSeconds: number;
  /** 若提供，必须与 startSeconds + durationSeconds 一致。 */
  endSeconds?: number;
  durationSeconds: number;
  promptRevisionId: string;
  sourceSpans?: StudioProductionPanelSourceSpanInput[];
  assets: StudioPanelAssetMentionInput[];
  /** P20：转场描述；空 = "无"（默认硬切）。 */
  transition?: string;
  /** P20：服装状态；空 = 沿用连续性快照（需要逐资产区分时必须留空）。 */
  costumeState?: string;
  /** P20：场景光线；空 = 沿用连续性快照。 */
  sceneLighting?: string;
  /** P20：原镜/扩写；默认 original；extension 仅允许末尾连续后缀格且单元至少含 1 个 original 格。 */
  shotType?: "original" | "extension";
  /** P20：逐格负提示词；与资产 negativeLocks 按条 trim 精确去重合并。 */
  negativePrompt?: string;
}

export interface StudioProductionPanel {
  id: string;
  index: number;
  title: string;
  visualAction: string;
  shotComposition: string;
  filmingMethod: string;
  dialogue: string;
  subtitle: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  promptRevisionId: string;
  promptRevision: StudioTextRevision;
  sourceSpans: StudioProductionPanelSourceSpan[];
  assets: StudioPanelAssetMention[];
  transition: string;
  costumeState: string;
  sceneLighting: string;
  shotType: "original" | "extension";
  negativePrompt: string;
}

interface StudioProductionUnitDraft {
  /** 同一 season + episode 内，sequence 从 1 开始表示连续生产单元序号。 */
  season: string;
  episode: string;
  sequence: number;
  title: string;
  /** 缺省 15 秒；P30 只为真实历史单元允许显式 1–15 秒。 */
  durationSeconds?: number;
  scriptRevisionId: string;
  panels: StudioProductionPanelInput[];
}

export interface CreateStudioProductionUnitInput extends StudioProductionUnitDraft {
  id?: string;
  expectedRevision: 0;
}

export interface ReviseStudioProductionUnitInput extends StudioProductionUnitDraft {
  unitId: string;
  expectedRevision: number;
}

export interface StudioProductionUnitSummary {
  id: string;
  season: string;
  seasonOrigin: "explicit" | "legacy-migrated";
  episode: string;
  /** 同一 season + episode 内的生产单元序号。 */
  sequence: number;
  title: string;
  revision: number;
  durationSeconds: number;
  /** 由同季同集前序 current heads 的真实时长累计得出。 */
  episodeStartSeconds: number;
  episodeEndSeconds: number;
  panelCount: number;
  scriptRevisionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudioProductionUnitRevisionSummary {
  unitId: string;
  revision: number;
  season: string;
  seasonOrigin: "explicit" | "legacy-migrated";
  episode: string;
  sequence: number;
  title: string;
  durationSeconds: number;
  /** 历史 revision 自身时长配合当前 episode 排列得到的诊断投影。 */
  episodeStartSeconds: number;
  episodeEndSeconds: number;
  panelCount: number;
  scriptRevisionId: string;
  createdAt: string;
}

export interface StudioProductionUnitListQuery {
  season?: string;
  episode?: string;
  cursor?: string;
  limit?: number;
}

export interface StudioProductionUnitPage {
  items: StudioProductionUnitSummary[];
  nextCursor?: string;
}

export interface StudioProductionScopeFacets {
  seasons: string[];
  episodes: Array<{ season: string; episode: string }>;
  totalUnits: number;
}

/** P30：按 season+episode 冻结的生产合同收紧项；不存在时通用 Studio 仍为 0–6。 */
export interface StudioProductionContractProfile {
  schemaVersion: 1;
  kind: "studio-production-contract-profile";
  profileId: string;
  season: string;
  episode: string;
  minControlReferences: number;
  maxControlReferences: number;
  sourceFingerprint: string;
  fingerprint: string;
  createdAt: string;
}

export interface CreateStudioProductionContractProfileInput {
  profileId: string;
  season: string;
  episode: string;
  minControlReferences: number;
  maxControlReferences: number;
  sourceFingerprint: string;
  expectedRevision: 0;
}

export interface StudioUnitBindingHeadSummary {
  unitId: string;
  panelCount: number;
  analysisHeadCount: number;
  bindingHeadCount: number;
  unresolvedMatchedCount: number;
  unresolvedAmbiguousCount: number;
  unresolvedUnmatchedCount: number;
}

export interface StudioProductionUnitRevisionListQuery {
  unitId: string;
  cursor?: string;
  limit?: number;
}

export interface StudioProductionUnitRevisionPage {
  items: StudioProductionUnitRevisionSummary[];
  nextCursor?: string;
}

/** Codex 包适配层可一次读取的完整、自验证单元投影。 */
export interface StudioProductionUnitSnapshot {
  schemaVersion: 2;
  kind: "studio-production-unit-snapshot";
  unit: StudioProductionUnitSummary;
  scriptRevision: StudioTextRevision;
  panels: StudioProductionPanel[];
  fingerprint: string;
}

/**
 * 单元内与集内双时间轴的唯一 Core 投影。
 * UI、MCP、BindingSet 与 generation 不得各自重复推导该公式。
 */
export interface StudioProductionPanelTimeContext {
  unitLocalStartSeconds: number;
  unitLocalEndSeconds: number;
  episodeAbsoluteStartSeconds: number;
  episodeAbsoluteEndSeconds: number;
}

export function getStudioProductionPanelTimeContext(
  unit: {
    sequence: number;
    durationSeconds: number;
    /** 旧调用/旧夹具可省略，保持历史等长 15 秒公式。 */
    episodeStartSeconds?: number;
  },
  panel: Pick<StudioProductionPanel, "startSeconds" | "endSeconds">,
): StudioProductionPanelTimeContext {
  const unitOffset = unit.episodeStartSeconds ?? (unit.sequence - 1) * unit.durationSeconds;
  return {
    unitLocalStartSeconds: panel.startSeconds,
    unitLocalEndSeconds: panel.endSeconds,
    episodeAbsoluteStartSeconds: unitOffset + panel.startSeconds,
    episodeAbsoluteEndSeconds: unitOffset + panel.endSeconds,
  };
}

export interface StudioAssetTimelineQuery {
  assetId: string;
  cursor?: string;
  limit?: number;
}

export interface StudioAssetTimelineItem {
  assetId: string;
  category: StudioAssetCategory;
  presence: StudioAssetPresence;
  role: string;
  continuityState: string;
  evidence: StudioContinuityEvidence[];
  unitId: string;
  unitRevision: number;
  season: string;
  seasonOrigin: "explicit" | "legacy-migrated";
  episode: string;
  unitSequence: number;
  unitTitle: string;
  panelId: string;
  panelIndex: number;
  panelTitle: string;
  startSeconds: number;
  endSeconds: number;
  episodeAbsoluteStartSeconds: number;
  episodeAbsoluteEndSeconds: number;
}

export interface StudioAssetTimelinePage {
  items: StudioAssetTimelineItem[];
  nextCursor?: string;
}

export class StudioProductionConflictError extends Error {
  readonly entityId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(entityId: string, expectedRevision: number, actualRevision: number) {
    super(`生产知识库修订冲突：${entityId} 期望 ${expectedRevision}，当前 ${actualRevision}。请重新读取后再写入。`);
    this.name = "StudioProductionConflictError";
    this.entityId = entityId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class StudioScriptSectionLineageError extends Error {
  readonly sectionId: string;
  readonly invariant: "kind" | "script-document" | "lineage-corrupt";
  readonly expectedValue: string;
  readonly actualValue: string;

  constructor(
    sectionId: string,
    invariant: StudioScriptSectionLineageError["invariant"],
    expectedValue: string,
    actualValue: string,
    message: string,
  ) {
    super(message);
    this.name = "StudioScriptSectionLineageError";
    this.sectionId = sectionId;
    this.invariant = invariant;
    this.expectedValue = expectedValue;
    this.actualValue = actualValue;
  }
}

interface StudioPaths {
  root: string;
  sidecar: string;
  database: string;
  textCasRoot: string;
  textCasTempRoot: string;
  storageIdentities: {
    sidecar: ConfinedDirectoryIdentity;
    textCasRoot: ConfinedDirectoryIdentity;
    textCasTempRoot: ConfinedDirectoryIdentity;
  };
}

interface DocumentRow {
  id: string;
  kind: StudioTextDocumentKind;
  title: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface TextRevisionRow {
  id: string;
  document_id: string;
  document_kind: StudioTextDocumentKind;
  document_title: string;
  ordinal: number;
  body_sha256: string;
  body_size_bytes: number;
  body_relpath: string;
  source: string;
  source_version: string;
  created_at: string;
}

interface UnitRow {
  id: string;
  season: string;
  episode: string;
  sequence: number;
  title: string;
  revision: number;
  duration_ms: number;
  panel_count: number;
  script_revision_id: string;
  created_at: string;
  updated_at: string;
}

interface UnitTimingRow {
  unit_id: string;
  unit_revision: number;
  duration_ms: number;
  created_at: string;
}

interface UnitRevisionRow {
  unit_id: string;
  revision: number;
  season: string;
  episode: string;
  sequence: number;
  title: string;
  duration_ms: number;
  panel_count: number;
  script_revision_id: string;
  created_at: string;
}

interface PanelRow {
  unit_id: string;
  unit_revision: number;
  panel_index: number;
  panel_id: string;
  title: string;
  visual_action: string;
  shot_composition: string;
  filming_method: string;
  dialogue: string;
  subtitle: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  prompt_revision_id: string;
  transition: string;
  costume_state: string;
  scene_lighting: string;
  shot_type: string;
  negative_prompt: string;
}

interface AssetRow {
  unit_id: string;
  unit_revision: number;
  unit_sequence: number;
  panel_index: number;
  asset_id: string;
  category: StudioAssetCategory;
  presence: StudioAssetPresence;
  role: string;
  continuity_state: string;
}

interface EvidenceRow {
  evidence_index: number;
  kind: string;
  reference: string;
  note: string;
}

interface PanelSourceSpanRow {
  unit_id: string;
  unit_revision: number;
  panel_index: number;
  span_index: number;
  script_revision_id: string;
  script_sha256: string;
  start_offset_utf16: number;
  end_offset_utf16: number;
  surface_sha256: string;
}

interface TimelineRow extends AssetRow {
  season: string;
  episode: string;
  unit_title: string;
  panel_id: string;
  panel_title: string;
  start_ms: number;
  end_ms: number;
  episode_start_ms: number;
}

interface NormalizedEvidence {
  kind: string;
  reference: string;
  note: string;
}

interface NormalizedAssetMention {
  assetId: string;
  category: StudioAssetCategory;
  presence: StudioAssetPresence;
  role: string;
  continuityState: string;
  evidence: NormalizedEvidence[];
}

interface NormalizedPanelSourceSpan extends StudioProductionPanelSourceSpan {
  index: number;
}

interface NormalizedPanel {
  id: string;
  index: number;
  title: string;
  visualAction: string;
  shotComposition: string;
  filmingMethod: string;
  dialogue: string;
  subtitle: string;
  startMilliseconds: number;
  endMilliseconds: number;
  durationMilliseconds: number;
  promptRevisionId: string;
  sourceSpans: NormalizedPanelSourceSpan[];
  assets: NormalizedAssetMention[];
  transition: string;
  costumeState: string;
  sceneLighting: string;
  shotType: "original" | "extension";
  negativePrompt: string;
}

interface NormalizedUnitDraft {
  season: string;
  episode: string;
  sequence: number;
  title: string;
  durationMilliseconds: number;
  scriptRevisionId: string;
  panels: NormalizedPanel[];
}

function resolveProjectRoot(projectRoot: string): string {
  if (!projectRoot.trim()) throw new Error("projectRoot 不能为空。");
  return path.resolve(projectRoot);
}

function productionPaths(projectRoot: string): Omit<StudioPaths, "storageIdentities"> {
  const root = resolveProjectRoot(projectRoot);
  return {
    root,
    sidecar: path.join(root, ".aicanvas"),
    database: path.join(root, DATABASE_RELATIVE_PATH),
    textCasRoot: path.join(root, TEXT_CAS_RELATIVE_ROOT),
    textCasTempRoot: path.join(root, TEXT_CAS_TEMP_RELATIVE_ROOT),
  };
}

async function ensureProductionDirectories(projectRoot: string): Promise<StudioPaths> {
  recordStudioUnitsReadCounter("productionDirectoryEnsureCalls");
  const paths = productionPaths(projectRoot);
  const sidecar = await ensureConfinedDirectory(paths.root, paths.sidecar);
  const textCasRoot = await ensureConfinedDirectory(paths.root, paths.textCasRoot);
  const textCasTempRoot = await ensureConfinedDirectory(paths.root, paths.textCasTempRoot);
  return { ...paths, storageIdentities: { sidecar, textCasRoot, textCasTempRoot } };
}

function relativeToProject(projectRoot: string, absolutePath: string): string {
  const relative = path.relative(projectRoot, absolutePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("生产知识库路径逃逸项目目录。");
  }
  return relative.split(path.sep).join("/");
}

function fromProjectRelative(projectRoot: string, relativePath: string): string {
  const absolute = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("生产知识库包含越界路径。");
  }
  return absolute;
}

function tableSql(db: DatabaseSync, table: string): string {
  return String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as {
    sql?: string;
  } | undefined)?.sql ?? "");
}

/**
 * 只放宽受管生产库的资产分类 CHECK，历史行逐字复制，不做任何旧数据重分类。
 * 迁移在主 DDL 之前运行：关闭 FK 后配合 legacy_alter_table，避免父表改名把子表
 * 的 REFERENCES 永久改写到临时表；随后由主 DDL 统一重建索引和 append-only trigger。
 */
function migrateStudioAssetCategoryConstraintsForStyle(db: DatabaseSync): void {
  const targets = [
    "studio_production_panel_assets",
    "studio_asset_mention_proposals",
    "studio_asset_mention_candidates",
    "studio_asset_bindings",
  ] as const;
  const needsMigration = targets.some((table) => {
    const sql = tableSql(db, table);
    return Boolean(sql) && !sql.includes("'style'");
  });
  if (!needsMigration) return;

  const hasBindingRevision = new Set(
    (db.prepare("PRAGMA table_info(studio_asset_bindings)").all() as Array<{ name: string }>).map((column) => column.name),
  ).has("asset_revision");
  db.exec("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN IMMEDIATE");
  try {
    if (tableSql(db, "studio_production_panel_assets") && !tableSql(db, "studio_production_panel_assets").includes("'style'")) {
      db.exec(`
        ALTER TABLE studio_production_panel_assets RENAME TO studio_production_panel_assets_v6_category;
        CREATE TABLE studio_production_panel_assets (
          unit_id TEXT NOT NULL,
          unit_revision INTEGER NOT NULL,
          unit_sequence INTEGER NOT NULL CHECK(unit_sequence >= 1),
          panel_index INTEGER NOT NULL,
          asset_id TEXT NOT NULL,
          category TEXT NOT NULL CHECK(category IN ('character', 'scene', 'prop', 'style')),
          presence TEXT NOT NULL CHECK(presence IN ('required', 'optional', 'forbidden')),
          role TEXT NOT NULL,
          continuity_state TEXT NOT NULL,
          PRIMARY KEY(unit_id, unit_revision, panel_index, asset_id),
          FOREIGN KEY(unit_id, unit_revision, panel_index)
            REFERENCES studio_production_panels(unit_id, unit_revision, panel_index) ON DELETE RESTRICT
        ) STRICT;
        INSERT INTO studio_production_panel_assets
          SELECT * FROM studio_production_panel_assets_v6_category;
        DROP TABLE studio_production_panel_assets_v6_category;
      `);
    }
    if (tableSql(db, "studio_asset_mention_proposals") && !tableSql(db, "studio_asset_mention_proposals").includes("'style'")) {
      db.exec(`
        ALTER TABLE studio_asset_mention_proposals RENAME TO studio_asset_mention_proposals_v6_category;
        CREATE TABLE studio_asset_mention_proposals (
          id TEXT PRIMARY KEY,
          analysis_id TEXT NOT NULL,
          mention_id TEXT NOT NULL,
          surface_text TEXT NOT NULL,
          start_offset_utf16 INTEGER NOT NULL CHECK(start_offset_utf16 >= 0),
          end_offset_utf16 INTEGER NOT NULL CHECK(end_offset_utf16 > start_offset_utf16),
          surface_sha256 TEXT NOT NULL CHECK(length(surface_sha256) = 64),
          section_revision_id TEXT,
          category TEXT CHECK(category IS NULL OR category IN ('character', 'scene', 'prop', 'style')),
          presence TEXT NOT NULL CHECK(presence IN ('required', 'optional', 'forbidden')),
          role TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('matched', 'ambiguous', 'unmatched')),
          normalized_identity_key TEXT NOT NULL,
          candidate_set_fingerprint TEXT NOT NULL CHECK(length(candidate_set_fingerprint) = 64),
          fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
          created_at TEXT NOT NULL,
          UNIQUE(analysis_id, mention_id),
          FOREIGN KEY(analysis_id) REFERENCES studio_asset_mention_analyses(id) ON DELETE RESTRICT,
          FOREIGN KEY(section_revision_id) REFERENCES studio_script_section_revisions(id) ON DELETE RESTRICT
        ) STRICT;
        INSERT INTO studio_asset_mention_proposals
          SELECT * FROM studio_asset_mention_proposals_v6_category;
        DROP TABLE studio_asset_mention_proposals_v6_category;
      `);
    }
    if (tableSql(db, "studio_asset_mention_candidates") && !tableSql(db, "studio_asset_mention_candidates").includes("'style'")) {
      db.exec(`
        ALTER TABLE studio_asset_mention_candidates RENAME TO studio_asset_mention_candidates_v6_category;
        CREATE TABLE studio_asset_mention_candidates (
          proposal_id TEXT NOT NULL,
          rank INTEGER NOT NULL CHECK(rank BETWEEN 1 AND 100),
          kind TEXT NOT NULL CHECK(kind IN ('id', 'formal-name', 'alias', 'model')),
          asset_id TEXT NOT NULL,
          category TEXT NOT NULL CHECK(category IN ('character', 'scene', 'prop', 'style')),
          matched_value TEXT NOT NULL,
          fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
          PRIMARY KEY(proposal_id, rank),
          UNIQUE(proposal_id, kind, asset_id),
          FOREIGN KEY(proposal_id) REFERENCES studio_asset_mention_proposals(id) ON DELETE RESTRICT
        ) STRICT;
        INSERT INTO studio_asset_mention_candidates
          SELECT * FROM studio_asset_mention_candidates_v6_category;
        DROP TABLE studio_asset_mention_candidates_v6_category;
      `);
    }
    if (tableSql(db, "studio_asset_bindings") && !tableSql(db, "studio_asset_bindings").includes("'style'")) {
      db.exec(`
        ALTER TABLE studio_asset_bindings RENAME TO studio_asset_bindings_v6_category;
        CREATE TABLE studio_asset_bindings (
          binding_set_id TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          category TEXT NOT NULL CHECK(category IN ('character', 'scene', 'prop', 'style')),
          presence TEXT NOT NULL CHECK(presence IN ('required', 'optional', 'forbidden')),
          role TEXT NOT NULL,
          asset_revision INTEGER NOT NULL CHECK(asset_revision >= 1),
          definition_version_id TEXT NOT NULL,
          authority_event_id TEXT NOT NULL,
          authority_version_id TEXT NOT NULL,
          asset_version_id TEXT NOT NULL,
          media_sha256 TEXT NOT NULL CHECK(length(media_sha256) = 64),
          knowledge_fingerprint TEXT NOT NULL CHECK(length(knowledge_fingerprint) = 64),
          applicability_fingerprint TEXT NOT NULL CHECK(length(applicability_fingerprint) = 64),
          semantic_fingerprint TEXT NOT NULL CHECK(length(semantic_fingerprint) = 64),
          PRIMARY KEY(binding_set_id, asset_id),
          FOREIGN KEY(binding_set_id) REFERENCES studio_asset_binding_sets(id) ON DELETE RESTRICT
        ) STRICT;
      `);
      db.exec(hasBindingRevision
        ? `INSERT INTO studio_asset_bindings SELECT * FROM studio_asset_bindings_v6_category`
        : `INSERT INTO studio_asset_bindings(
            binding_set_id, asset_id, category, presence, role, asset_revision,
            definition_version_id, authority_event_id, authority_version_id,
            asset_version_id, media_sha256, knowledge_fingerprint,
            applicability_fingerprint, semantic_fingerprint
          )
          SELECT binding_set_id, asset_id, category, presence, role, 1,
            definition_version_id, authority_event_id, authority_version_id,
            asset_version_id, media_sha256, knowledge_fingerprint,
            applicability_fingerprint, semantic_fingerprint
          FROM studio_asset_bindings_v6_category`);
      db.exec("DROP TABLE studio_asset_bindings_v6_category");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON");
  }
  const violation = db.prepare("PRAGMA foreign_key_check").get();
  if (violation) throw new Error("生产知识库 style 分类迁移后 foreign_key_check 失败。");
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
  if (integrity?.integrity_check !== "ok") {
    throw new Error(`生产知识库 style 分类迁移后 integrity_check 失败：${integrity?.integrity_check ?? "unknown"}`);
  }
}

function openDatabase(databasePath: string): DatabaseSync {
  recordStudioUnitsReadCounter("productionOpenDatabaseCalls");
  // P28：先以只读连接探测版本；未来 schema 在任何 PRAGMA/DDL/迁移前失败关闭。
  if (existsSync(databasePath)) {
    const metadata = lstatSync(databasePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("生产知识库数据库必须是无符号链接的普通文件。");
    const probe = new DatabaseSync(databasePath, { readOnly: true });
    recordStudioUnitsReadCounter("productionReadOnlyProbeConnections");
    try {
      const hasMeta = probe.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'studio_production_meta' LIMIT 1").get();
      if (hasMeta) {
        const version = probe.prepare("SELECT value FROM studio_production_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
        const storedVersion = version?.value;
        if (storedVersion !== undefined
          && storedVersion !== "1"
          && storedVersion !== "2"
          && storedVersion !== "3"
          && storedVersion !== "4"
          && storedVersion !== "5"
          && storedVersion !== String(SCHEMA_VERSION)) {
          throw new Error(`不支持的生产知识库 schema_version：${storedVersion}。`);
        }
      }
    } finally {
      probe.close();
    }
  }
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(BUSY_TIMEOUT_MS);
  const db = new DatabaseSync(databasePath, { timeout: busyTimeoutMs });
  recordStudioUnitsReadCounter("productionOwnerConnections");
  db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;`);
  const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
  if (journal?.journal_mode?.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode=WAL");
  const requestSchemaKey = studioRequestSqliteValidationKey("studio-production-schema-v6", databasePath);
  const schemaCacheHit = hasStudioRequestSchemaValidation(requestSchemaKey);
  recordStudioUnitsReadCounter(schemaCacheHit ? "productionSchemaCacheHits" : "productionSchemaCacheMisses");
  if (schemaCacheHit) {
    const version = db.prepare("SELECT value FROM studio_production_meta WHERE key = 'schema_version'")
      .get() as { value?: string } | undefined;
    const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
    if (version?.value !== String(SCHEMA_VERSION) || foreignKeys?.foreign_keys !== 1) {
      db.close();
      throw new Error("生产知识库 schema_version 或 foreign_keys 已漂移，拒绝继续。");
    }
    if (!isStudioRequestSqliteValidationUnchanged(
      requestSchemaKey,
      "studio-production-schema-v6",
      databasePath,
    )) {
      db.close();
      throw new Error("生产知识库在 schema cache-hit 复核期间发生 SQLite 身份漂移。");
    }
    return db;
  }
  const existingMeta = db.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'studio_production_meta' LIMIT 1",
  ).get() as { found?: number } | undefined;
  const preMigrationVersion = existingMeta
    ? (db.prepare("SELECT value FROM studio_production_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined)?.value
    : undefined;
  if (preMigrationVersion !== undefined) {
    try {
      migrateStudioAssetCategoryConstraintsForStyle(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_production_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_text_documents (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('script', 'prompt')),
      title TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_text_revisions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
      body_sha256 TEXT NOT NULL CHECK(length(body_sha256) = 64),
      body_size_bytes INTEGER NOT NULL CHECK(body_size_bytes > 0 AND body_size_bytes <= ${MAX_TEXT_BODY_BYTES}),
      body_relpath TEXT NOT NULL,
      source TEXT NOT NULL,
      source_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(document_id, ordinal),
      FOREIGN KEY(document_id) REFERENCES studio_text_documents(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_production_units (
      id TEXT PRIMARY KEY,
      season TEXT NOT NULL,
      episode TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence >= 1),
      title TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      duration_ms INTEGER NOT NULL CHECK(duration_ms = ${UNIT_DURATION_MILLISECONDS}),
      panel_count INTEGER NOT NULL CHECK(panel_count BETWEEN ${STUDIO_PRODUCTION_MIN_PANEL_COUNT} AND ${STUDIO_PRODUCTION_MAX_PANEL_COUNT}),
      script_revision_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(script_revision_id) REFERENCES studio_text_revisions(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_production_unit_revisions (
      unit_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      season TEXT NOT NULL,
      episode TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence >= 1),
      title TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK(duration_ms = ${UNIT_DURATION_MILLISECONDS}),
      panel_count INTEGER NOT NULL CHECK(panel_count BETWEEN ${STUDIO_PRODUCTION_MIN_PANEL_COUNT} AND ${STUDIO_PRODUCTION_MAX_PANEL_COUNT}),
      script_revision_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(unit_id, revision),
      FOREIGN KEY(unit_id) REFERENCES studio_production_units(id) ON DELETE RESTRICT,
      FOREIGN KEY(script_revision_id) REFERENCES studio_text_revisions(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_production_panels (
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL,
      panel_index INTEGER NOT NULL CHECK(panel_index BETWEEN 1 AND ${STUDIO_PRODUCTION_MAX_PANEL_COUNT}),
      panel_id TEXT NOT NULL,
      title TEXT NOT NULL,
      visual_action TEXT NOT NULL,
      shot_composition TEXT NOT NULL,
      filming_method TEXT NOT NULL,
      dialogue TEXT NOT NULL,
      subtitle TEXT NOT NULL,
      start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
      end_ms INTEGER NOT NULL CHECK(end_ms > start_ms),
      duration_ms INTEGER NOT NULL CHECK(duration_ms = end_ms - start_ms),
      prompt_revision_id TEXT NOT NULL,
      PRIMARY KEY(unit_id, unit_revision, panel_index),
      UNIQUE(unit_id, unit_revision, panel_id),
      FOREIGN KEY(unit_id, unit_revision) REFERENCES studio_production_unit_revisions(unit_id, revision) ON DELETE RESTRICT,
      FOREIGN KEY(prompt_revision_id) REFERENCES studio_text_revisions(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_production_panel_source_spans (
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
      panel_index INTEGER NOT NULL CHECK(panel_index BETWEEN 1 AND ${STUDIO_PRODUCTION_MAX_PANEL_COUNT}),
      span_index INTEGER NOT NULL CHECK(span_index >= 1),
      script_revision_id TEXT NOT NULL,
      script_sha256 TEXT NOT NULL CHECK(length(script_sha256) = 64),
      start_offset_utf16 INTEGER NOT NULL CHECK(start_offset_utf16 >= 0),
      end_offset_utf16 INTEGER NOT NULL CHECK(end_offset_utf16 > start_offset_utf16),
      surface_sha256 TEXT NOT NULL CHECK(length(surface_sha256) = 64),
      PRIMARY KEY(unit_id, unit_revision, panel_index, span_index),
      FOREIGN KEY(unit_id, unit_revision, panel_index)
        REFERENCES studio_production_panels(unit_id, unit_revision, panel_index) ON DELETE RESTRICT,
      FOREIGN KEY(script_revision_id) REFERENCES studio_text_revisions(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_production_panel_assets (
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL,
      unit_sequence INTEGER NOT NULL CHECK(unit_sequence >= 1),
      panel_index INTEGER NOT NULL,
      asset_id TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('character', 'scene', 'prop', 'style')),
      presence TEXT NOT NULL CHECK(presence IN ('required', 'optional', 'forbidden')),
      role TEXT NOT NULL,
      continuity_state TEXT NOT NULL,
      PRIMARY KEY(unit_id, unit_revision, panel_index, asset_id),
      FOREIGN KEY(unit_id, unit_revision, panel_index) REFERENCES studio_production_panels(unit_id, unit_revision, panel_index) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_production_continuity_evidence (
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL,
      panel_index INTEGER NOT NULL,
      asset_id TEXT NOT NULL,
      evidence_index INTEGER NOT NULL CHECK(evidence_index >= 1),
      kind TEXT NOT NULL,
      reference TEXT NOT NULL,
      note TEXT NOT NULL,
      PRIMARY KEY(unit_id, unit_revision, panel_index, asset_id, evidence_index),
      FOREIGN KEY(unit_id, unit_revision, panel_index, asset_id)
        REFERENCES studio_production_panel_assets(unit_id, unit_revision, panel_index, asset_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_script_section_revisions (
      id TEXT PRIMARY KEY,
      section_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      kind TEXT NOT NULL CHECK(kind IN ('chapter', 'scene')),
      title TEXT NOT NULL,
      script_revision_id TEXT NOT NULL,
      script_sha256 TEXT NOT NULL CHECK(length(script_sha256) = 64),
      start_offset_utf16 INTEGER NOT NULL CHECK(start_offset_utf16 >= 0),
      end_offset_utf16 INTEGER NOT NULL CHECK(end_offset_utf16 > start_offset_utf16),
      surface_sha256 TEXT NOT NULL CHECK(length(surface_sha256) = 64),
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE(section_id, revision),
      FOREIGN KEY(script_revision_id) REFERENCES studio_text_revisions(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_script_section_heads (
      section_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      revision_id TEXT NOT NULL UNIQUE,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(revision_id) REFERENCES studio_script_section_revisions(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_mention_analyses (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL,
      unit_fingerprint TEXT NOT NULL CHECK(length(unit_fingerprint) = 64),
      panel_index INTEGER NOT NULL,
      script_revision_id TEXT NOT NULL,
      script_sha256 TEXT NOT NULL CHECK(length(script_sha256) = 64),
      resolver_version TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE(unit_id, panel_index, revision),
      FOREIGN KEY(unit_id, unit_revision, panel_index)
        REFERENCES studio_production_panels(unit_id, unit_revision, panel_index) ON DELETE RESTRICT,
      FOREIGN KEY(script_revision_id) REFERENCES studio_text_revisions(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_mention_analysis_heads (
      unit_id TEXT NOT NULL,
      panel_index INTEGER NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      analysis_id TEXT NOT NULL UNIQUE,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(unit_id, panel_index),
      FOREIGN KEY(analysis_id) REFERENCES studio_asset_mention_analyses(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_mention_proposals (
      id TEXT PRIMARY KEY,
      analysis_id TEXT NOT NULL,
      mention_id TEXT NOT NULL,
      surface_text TEXT NOT NULL,
      start_offset_utf16 INTEGER NOT NULL CHECK(start_offset_utf16 >= 0),
      end_offset_utf16 INTEGER NOT NULL CHECK(end_offset_utf16 > start_offset_utf16),
      surface_sha256 TEXT NOT NULL CHECK(length(surface_sha256) = 64),
      section_revision_id TEXT,
      category TEXT CHECK(category IS NULL OR category IN ('character', 'scene', 'prop', 'style')),
      presence TEXT NOT NULL CHECK(presence IN ('required', 'optional', 'forbidden')),
      role TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('matched', 'ambiguous', 'unmatched')),
      normalized_identity_key TEXT NOT NULL,
      candidate_set_fingerprint TEXT NOT NULL CHECK(length(candidate_set_fingerprint) = 64),
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE(analysis_id, mention_id),
      FOREIGN KEY(analysis_id) REFERENCES studio_asset_mention_analyses(id) ON DELETE RESTRICT,
      FOREIGN KEY(section_revision_id) REFERENCES studio_script_section_revisions(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_mention_candidates (
      proposal_id TEXT NOT NULL,
      rank INTEGER NOT NULL CHECK(rank BETWEEN 1 AND 100),
      kind TEXT NOT NULL CHECK(kind IN ('id', 'formal-name', 'alias', 'model')),
      asset_id TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('character', 'scene', 'prop', 'style')),
      matched_value TEXT NOT NULL,
      fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
      PRIMARY KEY(proposal_id, rank),
      UNIQUE(proposal_id, kind, asset_id),
      FOREIGN KEY(proposal_id) REFERENCES studio_asset_mention_proposals(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_mention_decisions (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      proposal_fingerprint TEXT NOT NULL CHECK(length(proposal_fingerprint) = 64),
      action TEXT NOT NULL CHECK(action IN ('accept', 'select', 'exclude')),
      selected_asset_id TEXT,
      resolved_presence TEXT CHECK(resolved_presence IS NULL OR resolved_presence IN ('required', 'optional', 'forbidden')),
      resolved_role TEXT,
      reviewer TEXT NOT NULL,
      note TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      CHECK((action = 'exclude' AND selected_asset_id IS NULL) OR (action IN ('accept', 'select') AND selected_asset_id IS NOT NULL)),
      FOREIGN KEY(proposal_id) REFERENCES studio_asset_mention_proposals(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_mention_decision_heads (
      proposal_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      decision_id TEXT NOT NULL UNIQUE,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(proposal_id) REFERENCES studio_asset_mention_proposals(id) ON DELETE RESTRICT,
      FOREIGN KEY(decision_id) REFERENCES studio_asset_mention_decisions(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_panel_entity_closure_confirmations (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      closure TEXT NOT NULL CHECK(closure = 'confirmed-empty'),
      analysis_id TEXT NOT NULL,
      analysis_fingerprint TEXT NOT NULL CHECK(length(analysis_fingerprint) = 64),
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
      unit_fingerprint TEXT NOT NULL CHECK(length(unit_fingerprint) = 64),
      panel_id TEXT NOT NULL,
      panel_index INTEGER NOT NULL CHECK(panel_index BETWEEN 1 AND 6),
      panel_binding_scope_fingerprint TEXT NOT NULL CHECK(length(panel_binding_scope_fingerprint) = 64),
      script_revision_id TEXT NOT NULL,
      script_sha256 TEXT NOT NULL CHECK(length(script_sha256) = 64),
      prompt_revision_id TEXT NOT NULL,
      prompt_sha256 TEXT NOT NULL CHECK(length(prompt_sha256) = 64),
      source_spans_json TEXT NOT NULL,
      reviewer TEXT NOT NULL CHECK(reviewer IN ('user', 'codex')),
      note TEXT NOT NULL CHECK(length(note) > 0),
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE(unit_id, panel_index, revision),
      FOREIGN KEY(analysis_id) REFERENCES studio_asset_mention_analyses(id) ON DELETE RESTRICT,
      FOREIGN KEY(unit_id, unit_revision, panel_index)
        REFERENCES studio_production_panels(unit_id, unit_revision, panel_index) ON DELETE RESTRICT,
      FOREIGN KEY(script_revision_id) REFERENCES studio_text_revisions(id) ON DELETE RESTRICT,
      FOREIGN KEY(prompt_revision_id) REFERENCES studio_text_revisions(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_panel_entity_closure_confirmation_heads (
      unit_id TEXT NOT NULL,
      panel_index INTEGER NOT NULL CHECK(panel_index BETWEEN 1 AND 6),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      confirmation_id TEXT NOT NULL UNIQUE,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(unit_id, panel_index),
      FOREIGN KEY(confirmation_id) REFERENCES studio_panel_entity_closure_confirmations(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_binding_sets (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      analysis_id TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL,
      unit_fingerprint TEXT NOT NULL CHECK(length(unit_fingerprint) = 64),
      panel_index INTEGER NOT NULL,
      script_revision_id TEXT NOT NULL,
      script_sha256 TEXT NOT NULL CHECK(length(script_sha256) = 64),
      prompt_revision_id TEXT NOT NULL,
      prompt_sha256 TEXT NOT NULL CHECK(length(prompt_sha256) = 64),
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE(unit_id, panel_index, revision),
      FOREIGN KEY(analysis_id) REFERENCES studio_asset_mention_analyses(id) ON DELETE RESTRICT,
      FOREIGN KEY(unit_id, unit_revision, panel_index)
        REFERENCES studio_production_panels(unit_id, unit_revision, panel_index) ON DELETE RESTRICT,
      FOREIGN KEY(script_revision_id) REFERENCES studio_text_revisions(id) ON DELETE RESTRICT,
      FOREIGN KEY(prompt_revision_id) REFERENCES studio_text_revisions(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_bindings (
      binding_set_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('character', 'scene', 'prop', 'style')),
      presence TEXT NOT NULL CHECK(presence IN ('required', 'optional', 'forbidden')),
      role TEXT NOT NULL,
      asset_revision INTEGER NOT NULL CHECK(asset_revision >= 1),
      definition_version_id TEXT NOT NULL,
      authority_event_id TEXT NOT NULL,
      authority_version_id TEXT NOT NULL,
      asset_version_id TEXT NOT NULL,
      media_sha256 TEXT NOT NULL CHECK(length(media_sha256) = 64),
      knowledge_fingerprint TEXT NOT NULL CHECK(length(knowledge_fingerprint) = 64),
      applicability_fingerprint TEXT NOT NULL CHECK(length(applicability_fingerprint) = 64),
      semantic_fingerprint TEXT NOT NULL CHECK(length(semantic_fingerprint) = 64),
      PRIMARY KEY(binding_set_id, asset_id),
      FOREIGN KEY(binding_set_id) REFERENCES studio_asset_binding_sets(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_binding_mentions (
      binding_set_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      mention_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      PRIMARY KEY(binding_set_id, asset_id, mention_id),
      FOREIGN KEY(binding_set_id, asset_id) REFERENCES studio_asset_bindings(binding_set_id, asset_id) ON DELETE RESTRICT,
      FOREIGN KEY(proposal_id) REFERENCES studio_asset_mention_proposals(id) ON DELETE RESTRICT,
      FOREIGN KEY(decision_id) REFERENCES studio_asset_mention_decisions(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_binding_dependencies (
      binding_set_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('identity-key', 'asset-semantic', 'decision', 'optional-unresolved')),
      dependency_key TEXT NOT NULL,
      expected_fingerprint TEXT NOT NULL CHECK(length(expected_fingerprint) = 64),
      PRIMARY KEY(binding_set_id, kind, dependency_key),
      FOREIGN KEY(binding_set_id) REFERENCES studio_asset_binding_sets(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_binding_set_heads (
      unit_id TEXT NOT NULL,
      panel_index INTEGER NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      binding_set_id TEXT NOT NULL UNIQUE,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(unit_id, panel_index),
      FOREIGN KEY(binding_set_id) REFERENCES studio_asset_binding_sets(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_asset_binding_empty_confirmation_dependencies (
      binding_set_id TEXT PRIMARY KEY,
      confirmation_id TEXT NOT NULL,
      expected_fingerprint TEXT NOT NULL CHECK(length(expected_fingerprint) = 64),
      FOREIGN KEY(binding_set_id) REFERENCES studio_asset_binding_sets(id) ON DELETE RESTRICT,
      FOREIGN KEY(confirmation_id) REFERENCES studio_panel_entity_closure_confirmations(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_binding_operation_receipts (
      id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL UNIQUE CHECK(length(request_hash) = 64),
      command TEXT NOT NULL CHECK(command IN (
        'analyze_studio_script_entities',
        'resolve_studio_entity_proposal',
        'confirm_studio_panel_empty',
        'freeze_studio_asset_binding_set'
      )),
      input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint) = 64),
      outcome_identity_json TEXT NOT NULL,
      outcome_fingerprint TEXT NOT NULL CHECK(length(outcome_fingerprint) = 64),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS studio_text_documents_kind_id_idx
      ON studio_text_documents(kind, id);
    CREATE INDEX IF NOT EXISTS studio_text_revisions_document_ordinal_idx
      ON studio_text_revisions(document_id, ordinal);
    CREATE INDEX IF NOT EXISTS studio_production_units_sequence_id_idx
      ON studio_production_units(sequence, id);
    CREATE INDEX IF NOT EXISTS studio_production_units_episode_sequence_id_idx
      ON studio_production_units(episode, sequence, id);
    CREATE INDEX IF NOT EXISTS studio_production_unit_revisions_unit_revision_idx
      ON studio_production_unit_revisions(unit_id, revision);
    CREATE INDEX IF NOT EXISTS studio_panel_source_spans_script_offset_idx
      ON studio_production_panel_source_spans(script_revision_id, start_offset_utf16, unit_id, unit_revision, panel_index, span_index);
    CREATE INDEX IF NOT EXISTS studio_production_asset_timeline_idx
      ON studio_production_panel_assets(asset_id, unit_sequence, unit_id, panel_index, unit_revision);
    CREATE INDEX IF NOT EXISTS studio_script_sections_script_offset_idx
      ON studio_script_section_revisions(script_revision_id, start_offset_utf16, section_id, revision);
    CREATE INDEX IF NOT EXISTS studio_mention_analyses_unit_panel_revision_idx
      ON studio_asset_mention_analyses(unit_id, panel_index, revision);
    CREATE INDEX IF NOT EXISTS studio_mention_proposals_analysis_idx
      ON studio_asset_mention_proposals(analysis_id, mention_id);
    CREATE INDEX IF NOT EXISTS studio_mention_candidates_asset_idx
      ON studio_asset_mention_candidates(asset_id, proposal_id);
    CREATE INDEX IF NOT EXISTS studio_mention_decisions_proposal_created_idx
      ON studio_asset_mention_decisions(proposal_id, created_at, id);
    CREATE INDEX IF NOT EXISTS studio_panel_empty_confirmations_unit_panel_revision_idx
      ON studio_panel_entity_closure_confirmations(unit_id, panel_index, revision);
    CREATE INDEX IF NOT EXISTS studio_binding_sets_unit_panel_revision_idx
      ON studio_asset_binding_sets(unit_id, panel_index, revision);
    CREATE INDEX IF NOT EXISTS studio_bindings_asset_idx
      ON studio_asset_bindings(asset_id, binding_set_id);

    CREATE TRIGGER IF NOT EXISTS studio_text_revisions_no_update
      BEFORE UPDATE ON studio_text_revisions BEGIN SELECT RAISE(ABORT, 'text revisions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_text_revisions_no_delete
      BEFORE DELETE ON studio_text_revisions BEGIN SELECT RAISE(ABORT, 'text revisions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_unit_revisions_no_update
      BEFORE UPDATE ON studio_production_unit_revisions BEGIN SELECT RAISE(ABORT, 'unit revisions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_unit_revisions_no_delete
      BEFORE DELETE ON studio_production_unit_revisions BEGIN SELECT RAISE(ABORT, 'unit revisions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_panels_no_update
      BEFORE UPDATE ON studio_production_panels BEGIN SELECT RAISE(ABORT, 'unit revision panels are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_panels_no_delete
      BEFORE DELETE ON studio_production_panels BEGIN SELECT RAISE(ABORT, 'unit revision panels are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_panel_source_spans_no_update
      BEFORE UPDATE ON studio_production_panel_source_spans BEGIN SELECT RAISE(ABORT, 'panel source spans are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_panel_source_spans_no_delete
      BEFORE DELETE ON studio_production_panel_source_spans BEGIN SELECT RAISE(ABORT, 'panel source spans are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_panel_assets_no_update
      BEFORE UPDATE ON studio_production_panel_assets BEGIN SELECT RAISE(ABORT, 'unit revision assets are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_panel_assets_no_delete
      BEFORE DELETE ON studio_production_panel_assets BEGIN SELECT RAISE(ABORT, 'unit revision assets are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_continuity_evidence_no_update
      BEFORE UPDATE ON studio_production_continuity_evidence BEGIN SELECT RAISE(ABORT, 'continuity evidence is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_continuity_evidence_no_delete
      BEFORE DELETE ON studio_production_continuity_evidence BEGIN SELECT RAISE(ABORT, 'continuity evidence is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_script_sections_no_update
      BEFORE UPDATE ON studio_script_section_revisions BEGIN SELECT RAISE(ABORT, 'script sections are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_script_sections_no_delete
      BEFORE DELETE ON studio_script_section_revisions BEGIN SELECT RAISE(ABORT, 'script sections are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_script_sections_lineage_guard
      BEFORE INSERT ON studio_script_section_revisions
      WHEN EXISTS (
        SELECT 1
        FROM studio_script_section_revisions existing
        JOIN studio_text_revisions existing_script ON existing_script.id = existing.script_revision_id
        JOIN studio_text_revisions incoming_script ON incoming_script.id = NEW.script_revision_id
        WHERE existing.section_id = NEW.section_id
          AND (existing.kind <> NEW.kind OR existing_script.document_id <> incoming_script.document_id)
      )
      BEGIN SELECT RAISE(ABORT, 'script section lineage mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS studio_mention_analyses_no_update
      BEFORE UPDATE ON studio_asset_mention_analyses BEGIN SELECT RAISE(ABORT, 'mention analyses are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_mention_analyses_no_delete
      BEFORE DELETE ON studio_asset_mention_analyses BEGIN SELECT RAISE(ABORT, 'mention analyses are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_mention_proposals_no_update
      BEFORE UPDATE ON studio_asset_mention_proposals BEGIN SELECT RAISE(ABORT, 'mention proposals are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_mention_proposals_no_delete
      BEFORE DELETE ON studio_asset_mention_proposals BEGIN SELECT RAISE(ABORT, 'mention proposals are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_mention_candidates_no_update
      BEFORE UPDATE ON studio_asset_mention_candidates BEGIN SELECT RAISE(ABORT, 'mention candidates are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_mention_candidates_no_delete
      BEFORE DELETE ON studio_asset_mention_candidates BEGIN SELECT RAISE(ABORT, 'mention candidates are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_mention_decisions_no_update
      BEFORE UPDATE ON studio_asset_mention_decisions BEGIN SELECT RAISE(ABORT, 'mention decisions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_mention_decisions_no_delete
      BEFORE DELETE ON studio_asset_mention_decisions BEGIN SELECT RAISE(ABORT, 'mention decisions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_panel_empty_confirmations_no_update
      BEFORE UPDATE ON studio_panel_entity_closure_confirmations BEGIN SELECT RAISE(ABORT, 'panel empty confirmations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_panel_empty_confirmations_no_delete
      BEFORE DELETE ON studio_panel_entity_closure_confirmations BEGIN SELECT RAISE(ABORT, 'panel empty confirmations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_panel_empty_confirmation_heads_no_delete
      BEFORE DELETE ON studio_panel_entity_closure_confirmation_heads BEGIN SELECT RAISE(ABORT, 'panel empty confirmation heads cannot be deleted'); END;
    CREATE TRIGGER IF NOT EXISTS studio_panel_empty_confirmation_heads_insert_guard
      BEFORE INSERT ON studio_panel_entity_closure_confirmation_heads
      WHEN NOT EXISTS (
        SELECT 1 FROM studio_panel_entity_closure_confirmations c
        WHERE c.id = NEW.confirmation_id AND c.unit_id = NEW.unit_id AND c.panel_index = NEW.panel_index
      )
      BEGIN SELECT RAISE(ABORT, 'panel empty confirmation head scope mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS studio_panel_empty_confirmation_heads_update_guard
      BEFORE UPDATE ON studio_panel_entity_closure_confirmation_heads
      WHEN NEW.unit_id <> OLD.unit_id
        OR NEW.panel_index <> OLD.panel_index
        OR NEW.revision <> OLD.revision + 1
        OR NEW.confirmation_id = OLD.confirmation_id
        OR NOT EXISTS (
          SELECT 1 FROM studio_panel_entity_closure_confirmations c
          WHERE c.id = NEW.confirmation_id AND c.unit_id = NEW.unit_id AND c.panel_index = NEW.panel_index
        )
      BEGIN SELECT RAISE(ABORT, 'panel empty confirmation head CAS invariant failed'); END;
    CREATE TRIGGER IF NOT EXISTS studio_binding_sets_no_update
      BEFORE UPDATE ON studio_asset_binding_sets BEGIN SELECT RAISE(ABORT, 'asset binding sets are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_binding_sets_no_delete
      BEFORE DELETE ON studio_asset_binding_sets BEGIN SELECT RAISE(ABORT, 'asset binding sets are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_bindings_no_update
      BEFORE UPDATE ON studio_asset_bindings BEGIN SELECT RAISE(ABORT, 'asset bindings are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_bindings_no_delete
      BEFORE DELETE ON studio_asset_bindings BEGIN SELECT RAISE(ABORT, 'asset bindings are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_binding_mentions_no_update
      BEFORE UPDATE ON studio_asset_binding_mentions BEGIN SELECT RAISE(ABORT, 'asset binding mentions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_binding_mentions_no_delete
      BEFORE DELETE ON studio_asset_binding_mentions BEGIN SELECT RAISE(ABORT, 'asset binding mentions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_binding_dependencies_no_update
      BEFORE UPDATE ON studio_asset_binding_dependencies BEGIN SELECT RAISE(ABORT, 'asset binding dependencies are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_binding_dependencies_no_delete
      BEFORE DELETE ON studio_asset_binding_dependencies BEGIN SELECT RAISE(ABORT, 'asset binding dependencies are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_binding_empty_confirmation_dependencies_no_update
      BEFORE UPDATE ON studio_asset_binding_empty_confirmation_dependencies BEGIN SELECT RAISE(ABORT, 'binding empty confirmation dependencies are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_binding_empty_confirmation_dependencies_no_delete
      BEFORE DELETE ON studio_asset_binding_empty_confirmation_dependencies BEGIN SELECT RAISE(ABORT, 'binding empty confirmation dependencies are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_binding_empty_confirmation_dependencies_insert_guard
      BEFORE INSERT ON studio_asset_binding_empty_confirmation_dependencies
      WHEN EXISTS (SELECT 1 FROM studio_asset_bindings b WHERE b.binding_set_id = NEW.binding_set_id)
        OR NOT EXISTS (
          SELECT 1
          FROM studio_asset_binding_sets b
          JOIN studio_panel_entity_closure_confirmations c ON c.id = NEW.confirmation_id
          WHERE b.id = NEW.binding_set_id
            AND b.analysis_id = c.analysis_id
            AND b.unit_id = c.unit_id
            AND b.panel_index = c.panel_index
            AND c.fingerprint = NEW.expected_fingerprint
        )
      BEGIN SELECT RAISE(ABORT, 'binding empty confirmation dependency mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS studio_binding_operation_receipts_no_update
      BEFORE UPDATE ON studio_binding_operation_receipts BEGIN SELECT RAISE(ABORT, 'binding operation receipts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS studio_binding_operation_receipts_no_delete
      BEFORE DELETE ON studio_binding_operation_receipts BEGIN SELECT RAISE(ABORT, 'binding operation receipts are append-only'); END;
  `);
  const version = db.prepare("SELECT value FROM studio_production_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
  const storedVersion = version?.value;
  if (storedVersion !== undefined && storedVersion !== "1" && storedVersion !== "2" && storedVersion !== "3" && storedVersion !== "4" && storedVersion !== "5" && storedVersion !== String(SCHEMA_VERSION)) {
    db.close();
    throw new Error(`不支持的生产知识库 schema_version：${storedVersion}。`);
  }
  try {
    runTransaction(db, () => {
      // BEGIN IMMEDIATE 已阻断并发 writer；从这里到 mark 运行原有完整迁移/结构/
      // 数据不变量验证。当前完整 schema 不应产生写入，因而 before/after key 相等；
      // 真实迁移若改变 WAL 只是不缓存本次，下一次稳定打开再建立 marker。
      const stableValidationKey = studioRequestSqliteValidationKey(
        "studio-production-schema-v6",
        databasePath,
      );
      // P30：保持两张 legacy unit 表及其 duration=15000 CHECK 原样；真实时长
      // 由同一 production owner 的纯增 extension 行权威表达。DDL 也在迁移事务内，
      // 因而后续任何历史数据校验失败都会连同本表完整回滚。
      db.exec(`
        CREATE TABLE IF NOT EXISTS studio_production_unit_timings (
          unit_id TEXT NOT NULL,
          unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
          duration_ms INTEGER NOT NULL CHECK(
            duration_ms >= ${MIN_UNIT_DURATION_MILLISECONDS}
            AND duration_ms <= ${UNIT_DURATION_MILLISECONDS}
          ),
          created_at TEXT NOT NULL,
          PRIMARY KEY(unit_id, unit_revision),
          FOREIGN KEY(unit_id, unit_revision)
            REFERENCES studio_production_unit_revisions(unit_id, revision) ON DELETE RESTRICT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS studio_production_unit_timings_duration_idx
          ON studio_production_unit_timings(duration_ms, unit_id, unit_revision);
        CREATE TRIGGER IF NOT EXISTS studio_production_unit_timings_no_update
          BEFORE UPDATE ON studio_production_unit_timings
          BEGIN SELECT RAISE(ABORT, 'unit timings are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS studio_production_unit_timings_no_delete
          BEFORE DELETE ON studio_production_unit_timings
          BEGIN SELECT RAISE(ABORT, 'unit timings are append-only'); END;
        CREATE TABLE IF NOT EXISTS studio_production_contract_profiles (
          profile_id TEXT PRIMARY KEY,
          season TEXT NOT NULL,
          episode TEXT NOT NULL,
          min_control_references INTEGER NOT NULL CHECK(min_control_references BETWEEN 0 AND 6),
          max_control_references INTEGER NOT NULL CHECK(max_control_references BETWEEN 1 AND 6),
          source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint) = 64),
          fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
          created_at TEXT NOT NULL,
          UNIQUE(season, episode),
          CHECK(min_control_references <= max_control_references)
        ) STRICT;
        CREATE TRIGGER IF NOT EXISTS studio_production_contract_profiles_no_update
          BEFORE UPDATE ON studio_production_contract_profiles
          BEGIN SELECT RAISE(ABORT, 'production contract profiles are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS studio_production_contract_profiles_no_delete
          BEFORE DELETE ON studio_production_contract_profiles
          BEGIN SELECT RAISE(ABORT, 'production contract profiles are append-only'); END;
      `);
      const timingColumns = db.prepare("PRAGMA table_info(studio_production_unit_timings)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>;
      const timingSignature = timingColumns.map((column) => ({
        name: column.name,
        type: column.type.toUpperCase(),
        notnull: Number(column.notnull),
        pk: Number(column.pk),
      }));
      const expectedTimingSignature = [
        { name: "unit_id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "unit_revision", type: "INTEGER", notnull: 1, pk: 2 },
        { name: "duration_ms", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
      ];
      const timingSql = String((db.prepare(`SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'studio_production_unit_timings'`).get() as { sql?: string } | undefined)?.sql ?? "");
      const timingForeignKeys = db.prepare("PRAGMA foreign_key_list(studio_production_unit_timings)").all() as Array<{
        table: string;
        from: string;
        to: string;
      }>;
      const timingForeignKeySignature = timingForeignKeys
        .map((entry) => `${entry.table}:${entry.from}:${entry.to}`)
        .sort((left, right) => left.localeCompare(right, "en"));
      if (stableJson(timingSignature) !== stableJson(expectedTimingSignature)
        || !/\bSTRICT\b/iu.test(timingSql)
        || !timingSql.includes(`duration_ms >= ${MIN_UNIT_DURATION_MILLISECONDS}`)
        || !timingSql.includes(`duration_ms <= ${UNIT_DURATION_MILLISECONDS}`)
        || stableJson(timingForeignKeySignature) !== stableJson([
          "studio_production_unit_revisions:unit_id:unit_id",
          "studio_production_unit_revisions:unit_revision:revision",
        ])) {
        throw new Error("生产知识库 v6 timing extension 结构无效；禁止把弱同名表提升为当前 schema。");
      }
      const invalidTiming = db.prepare(`
        SELECT t.unit_id, t.unit_revision
        FROM studio_production_unit_timings t
        LEFT JOIN studio_production_unit_revisions r
          ON r.unit_id = t.unit_id AND r.revision = t.unit_revision
        WHERE t.duration_ms < ? OR t.duration_ms > ? OR r.unit_id IS NULL OR r.duration_ms <> ?
        LIMIT 1
      `).get(MIN_UNIT_DURATION_MILLISECONDS, UNIT_DURATION_MILLISECONDS, UNIT_DURATION_MILLISECONDS) as {
        unit_id?: string;
        unit_revision?: number;
      } | undefined;
      if (invalidTiming) {
        throw new Error(`生产知识库 v6 timing extension 含坏行：${invalidTiming.unit_id} r${invalidTiming.unit_revision}`);
      }
      const unitColumns = new Set((db.prepare("PRAGMA table_info(studio_production_units)").all() as Array<{ name: string }>).map((column) => column.name));
      const revisionColumns = new Set((db.prepare("PRAGMA table_info(studio_production_unit_revisions)").all() as Array<{ name: string }>).map((column) => column.name));
      const bindingColumns = new Set((db.prepare("PRAGMA table_info(studio_asset_bindings)").all() as Array<{ name: string }>).map((column) => column.name));
      const decisionColumns = new Set((db.prepare("PRAGMA table_info(studio_asset_mention_decisions)").all() as Array<{ name: string }>).map((column) => column.name));
      if (!unitColumns.has("season")) {
        db.exec(`ALTER TABLE studio_production_units ADD COLUMN season TEXT NOT NULL DEFAULT '${STUDIO_PRODUCTION_LEGACY_SEASON_ID}'`);
      }
      if (!revisionColumns.has("season")) {
        db.exec(`ALTER TABLE studio_production_unit_revisions ADD COLUMN season TEXT NOT NULL DEFAULT '${STUDIO_PRODUCTION_LEGACY_SEASON_ID}'`);
      }
      if (!bindingColumns.has("asset_revision")) {
        db.exec("ALTER TABLE studio_asset_bindings ADD COLUMN asset_revision INTEGER NOT NULL DEFAULT 1 CHECK(asset_revision >= 1)");
      }
      if (!decisionColumns.has("resolved_presence")) {
        db.exec("ALTER TABLE studio_asset_mention_decisions ADD COLUMN resolved_presence TEXT CHECK(resolved_presence IS NULL OR resolved_presence IN ('required', 'optional', 'forbidden'))");
      }
      if (!decisionColumns.has("resolved_role")) {
        db.exec("ALTER TABLE studio_asset_mention_decisions ADD COLUMN resolved_role TEXT");
      }
      // P20：panel 5 字段原位迁移（shotType 默认 original，其余默认空串；不进入任何指纹）。
      const panelColumns = new Set((db.prepare("PRAGMA table_info(studio_production_panels)").all() as Array<{ name: string }>).map((column) => column.name));
      if (!panelColumns.has("transition")) {
        db.exec("ALTER TABLE studio_production_panels ADD COLUMN transition TEXT NOT NULL DEFAULT ''");
      }
      if (!panelColumns.has("costume_state")) {
        db.exec("ALTER TABLE studio_production_panels ADD COLUMN costume_state TEXT NOT NULL DEFAULT ''");
      }
      if (!panelColumns.has("scene_lighting")) {
        db.exec("ALTER TABLE studio_production_panels ADD COLUMN scene_lighting TEXT NOT NULL DEFAULT ''");
      }
      if (!panelColumns.has("shot_type")) {
        db.exec("ALTER TABLE studio_production_panels ADD COLUMN shot_type TEXT NOT NULL DEFAULT 'original' CHECK(shot_type IN ('original', 'extension'))");
      }
      if (!panelColumns.has("negative_prompt")) {
        db.exec("ALTER TABLE studio_production_panels ADD COLUMN negative_prompt TEXT NOT NULL DEFAULT ''");
      }
      const operationReceiptSql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'studio_binding_operation_receipts'").get() as { sql?: string } | undefined)?.sql ?? "");
      if (!operationReceiptSql.includes("confirm_studio_panel_empty")) {
        db.exec(`
          DROP TRIGGER IF EXISTS studio_binding_operation_receipts_no_update;
          DROP TRIGGER IF EXISTS studio_binding_operation_receipts_no_delete;
          ALTER TABLE studio_binding_operation_receipts RENAME TO studio_binding_operation_receipts_v3;
          CREATE TABLE studio_binding_operation_receipts (
            id TEXT PRIMARY KEY,
            request_hash TEXT NOT NULL UNIQUE CHECK(length(request_hash) = 64),
            command TEXT NOT NULL CHECK(command IN (
              'analyze_studio_script_entities',
              'resolve_studio_entity_proposal',
              'confirm_studio_panel_empty',
              'freeze_studio_asset_binding_set'
            )),
            input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint) = 64),
            outcome_identity_json TEXT NOT NULL,
            outcome_fingerprint TEXT NOT NULL CHECK(length(outcome_fingerprint) = 64),
            created_at TEXT NOT NULL
          ) STRICT;
          INSERT INTO studio_binding_operation_receipts(
            id, request_hash, command, input_fingerprint, outcome_identity_json, outcome_fingerprint, created_at
          ) SELECT id, request_hash, command, input_fingerprint, outcome_identity_json, outcome_fingerprint, created_at
            FROM studio_binding_operation_receipts_v3;
          DROP TABLE studio_binding_operation_receipts_v3;
          CREATE TRIGGER studio_binding_operation_receipts_no_update
            BEFORE UPDATE ON studio_binding_operation_receipts BEGIN SELECT RAISE(ABORT, 'binding operation receipts are append-only'); END;
          CREATE TRIGGER studio_binding_operation_receipts_no_delete
            BEFORE DELETE ON studio_binding_operation_receipts BEGIN SELECT RAISE(ABORT, 'binding operation receipts are append-only'); END;
        `);
      }
      const decisionProposalRows = db.prepare(`SELECT proposal_id, COUNT(*) AS count
        FROM studio_asset_mention_decisions GROUP BY proposal_id ORDER BY proposal_id`)
        .all() as Array<{ proposal_id: string; count: number }>;
      for (const proposalRow of decisionProposalRows) {
        const existingHead = db.prepare("SELECT 1 AS found FROM studio_asset_mention_decision_heads WHERE proposal_id = ?")
          .get(proposalRow.proposal_id) as { found: number } | undefined;
        if (existingHead) continue;
        const latest = db.prepare(`SELECT id, created_at FROM studio_asset_mention_decisions
          WHERE proposal_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
          .get(proposalRow.proposal_id) as { id: string; created_at: string } | undefined;
        if (!latest) throw new Error(`提案 ${proposalRow.proposal_id} 的历史 decision 计数与记录不一致。`);
        db.prepare(`INSERT INTO studio_asset_mention_decision_heads(proposal_id, revision, decision_id, updated_at)
          VALUES(?, ?, ?, ?)`).run(proposalRow.proposal_id, Number(proposalRow.count), latest.id, latest.created_at);
      }
      const duplicate = db.prepare(`
        SELECT season, episode, sequence, COUNT(*) AS count
        FROM studio_production_units
        GROUP BY season, episode, sequence
        HAVING COUNT(*) > 1
        ORDER BY season, episode, sequence
        LIMIT 1
      `).get() as { season: string; episode: string; sequence: number; count: number } | undefined;
      if (duplicate) {
        throw new Error(
          `生产知识库迁移失败：${duplicate.season}/${duplicate.episode} 的 15 秒单元序号 ${duplicate.sequence} 有 ${duplicate.count} 条历史记录；禁止静默重排。`,
        );
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS studio_production_units_season_episode_sequence_uidx
          ON studio_production_units(season, episode, sequence);
        CREATE INDEX IF NOT EXISTS studio_production_units_season_episode_sequence_id_idx
          ON studio_production_units(season, episode, sequence, id);
        CREATE INDEX IF NOT EXISTS studio_production_units_episode_season_sequence_id_idx
          ON studio_production_units(episode, season, sequence, id);
      `);
      db.prepare(`INSERT INTO studio_production_meta(key, value) VALUES('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        WHERE studio_production_meta.value <> excluded.value`)
        .run(String(SCHEMA_VERSION));
      const finalVersion = db.prepare(
        "SELECT value FROM studio_production_meta WHERE key = 'schema_version'",
      ).get() as { value?: string } | undefined;
      const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
      if (finalVersion?.value !== String(SCHEMA_VERSION) || foreignKeys?.foreign_keys !== 1) {
        throw new Error("生产知识库 schema_version 或 foreign_keys 无效，拒绝缓存验证结论。");
      }
      markStudioRequestSqliteValidationIfUnchanged(
        stableValidationKey,
        "studio-production-schema-v6",
        databasePath,
      );
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const finalVersion = db.prepare("SELECT value FROM studio_production_meta WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined;
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
  if (finalVersion?.value !== String(SCHEMA_VERSION) || foreignKeys?.foreign_keys !== 1) {
    db.close();
    throw new Error("生产知识库 schema_version 或 foreign_keys 无效，拒绝继续。");
  }
  return db;
}

function runTransaction<T>(db: DatabaseSync, callback: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function finalizeStudioBindingAtomicReceipt<TOutcome>(
  db: DatabaseSync,
  outcome: TOutcome,
  headRevision: number,
  expectedCommand: StudioBindingOperationCommand,
  context?: StudioBindingAtomicReceiptContext<TOutcome>,
): TOutcome {
  if (!context) return outcome;
  if (context.command !== expectedCommand) {
    throw new Error(`Studio binding 原子收据命令不匹配：期望 ${expectedCommand}，实际 ${context.command}。`);
  }
  if (!Number.isSafeInteger(headRevision) || headRevision < 1) {
    throw new Error("Studio binding 原子收据 head revision 无效。");
  }
  const outcomeIdentity = context.buildOutcomeIdentity(outcome, headRevision);
  if (process.env.AI_CANVAS_TEST_STUDIO_BINDING_FAIL_BEFORE_RECEIPT === expectedCommand) {
    throw new Error(`TEST_ONLY_STUDIO_BINDING_FAIL_BEFORE_RECEIPT:${expectedCommand}`);
  }
  recordStudioBindingOperationReceiptInTransaction(db, {
    requestHash: context.requestHash,
    command: expectedCommand,
    inputFingerprint: context.inputFingerprint,
    outcomeIdentity,
  });
  return outcome;
}

function count(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  return Number((db.prepare(sql).get(...params) as { count: number }).count);
}

function stateFromDatabase(paths: StudioPaths, db: DatabaseSync): StudioProductionState {
  const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  const busyTimeout = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  if (journal.journal_mode.toLowerCase() !== "wal" || foreignKeys.foreign_keys !== 1) {
    throw new Error("生产知识库 SQLite 安全配置无效。");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    databasePath: paths.database,
    textCasRoot: paths.textCasRoot,
    pragmas: {
      journalMode: "wal",
      foreignKeys: true,
      busyTimeoutMs: Number(busyTimeout.timeout),
    },
    counts: {
      textDocuments: count(db, "SELECT COUNT(*) AS count FROM studio_text_documents"),
      scriptDocuments: count(db, "SELECT COUNT(*) AS count FROM studio_text_documents WHERE kind = ?", "script"),
      promptDocuments: count(db, "SELECT COUNT(*) AS count FROM studio_text_documents WHERE kind = ?", "prompt"),
      textRevisions: count(db, "SELECT COUNT(*) AS count FROM studio_text_revisions"),
      units: count(db, "SELECT COUNT(*) AS count FROM studio_production_units"),
      panels: count(db, "SELECT COALESCE(SUM(panel_count), 0) AS count FROM studio_production_units"),
      unitRevisions: count(db, "SELECT COUNT(*) AS count FROM studio_production_unit_revisions"),
      unitTimings: count(db, "SELECT COUNT(*) AS count FROM studio_production_unit_timings"),
      contractProfiles: count(db, "SELECT COUNT(*) AS count FROM studio_production_contract_profiles"),
      scriptSectionRevisions: count(db, "SELECT COUNT(*) AS count FROM studio_script_section_revisions"),
      mentionAnalyses: count(db, "SELECT COUNT(*) AS count FROM studio_asset_mention_analyses"),
      mentionProposals: count(db, "SELECT COUNT(*) AS count FROM studio_asset_mention_proposals"),
      mentionDecisions: count(db, "SELECT COUNT(*) AS count FROM studio_asset_mention_decisions"),
      panelEntityClosureConfirmations: count(db, "SELECT COUNT(*) AS count FROM studio_panel_entity_closure_confirmations"),
      assetBindingSets: count(db, "SELECT COUNT(*) AS count FROM studio_asset_binding_sets"),
    },
  };
}

/** 当前 unit head 宫格精确总数（SQL SUM），禁止用首屏抽样估算。 */
export async function countStudioProductionPanels(projectRoot: string): Promise<number> {
  const state = await getStudioProductionState(projectRoot);
  return state.counts.panels;
}

export async function initializeStudioProduction(projectRoot: string): Promise<StudioProductionState> {
  const paths = await ensureProductionDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    return stateFromDatabase(paths, db);
  } finally {
    db.close();
  }
}

export async function getStudioProductionState(projectRoot: string): Promise<StudioProductionState> {
  return initializeStudioProduction(projectRoot);
}

function normalizeLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new Error(`limit 必须是 1-${MAX_PAGE_LIMIT} 的整数。`);
  }
  return value;
}

interface CursorEnvelope {
  v: 1;
  kind: string;
  scope: string;
  key: unknown;
}

function encodeCursor(kind: string, scope: string, key: unknown): string {
  return Buffer.from(JSON.stringify({ v: 1, kind, scope, key } satisfies CursorEnvelope), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined, kind: string, scope: string): unknown {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorEnvelope>;
    if (value.v !== 1 || value.kind !== kind || value.scope !== scope || value.key === undefined) throw new Error("invalid");
    return value.key;
  } catch {
    throw new Error("分页 cursor 无效或不属于当前查询。");
  }
}

function decodeStringCursor(cursor: string | undefined, kind: string, scope: string): string | undefined {
  const key = decodeCursor(cursor, kind, scope);
  if (key === undefined) return undefined;
  if (typeof key !== "string" || !key) throw new Error("分页 cursor 键无效。");
  return key;
}

function decodeIntegerCursor(cursor: string | undefined, kind: string, scope: string): number | undefined {
  const key = decodeCursor(cursor, kind, scope);
  if (key === undefined) return undefined;
  if (!Number.isSafeInteger(key) || Number(key) < 0) throw new Error("分页 cursor 键无效。");
  return Number(key);
}

function requiredText(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} 必须是文本。`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空。`);
  if (normalized.length > maxLength) throw new Error(`${field} 不能超过 ${maxLength} 个字符。`);
  return normalized;
}

function optionalText(value: string | undefined, field: string, maxLength: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`${field} 必须是文本。`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${field} 不能超过 ${maxLength} 个字符。`);
  return normalized;
}

function normalizeId(value: string | undefined, prefix: string, field: string): string {
  const id = value?.trim() || `${prefix}-${randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(id)) throw new Error(`${field} 格式无效。`);
  return id;
}

function normalizeExistingId(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空。`);
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(id)) throw new Error(`${field} 格式无效。`);
  return id;
}

function assertExpectedRevision(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`expectedRevision 必须是不小于 ${minimum} 的整数。`);
  }
}

function normalizeDocumentKind(kind: string): StudioTextDocumentKind {
  if (kind !== "script" && kind !== "prompt") throw new Error("文档 kind 必须是 script 或 prompt。");
  return kind;
}

function documentFromRow(row: DocumentRow): StudioTextDocument {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function textRevisionMetadataFromRow(projectRoot: string, row: TextRevisionRow): StudioTextRevisionMetadata {
  const bodySha256 = row.body_sha256;
  if (!/^[a-f0-9]{64}$/u.test(bodySha256)) throw new Error(`冻结文本 CAS SHA 无效：${row.id}`);
  const expectedRelativePath = `${TEXT_CAS_RELATIVE_ROOT}/${bodySha256.slice(0, 2)}/${bodySha256}.txt`;
  if (row.body_relpath !== expectedRelativePath) throw new Error(`冻结文本 CAS 路径无效：${row.id}`);
  return {
    id: row.id,
    documentId: row.document_id,
    documentKind: row.document_kind,
    documentTitle: row.document_title,
    ordinal: Number(row.ordinal),
    bodySha256,
    bodySizeBytes: Number(row.body_size_bytes),
    bodyPath: fromProjectRelative(projectRoot, row.body_relpath),
    source: row.source,
    sourceVersion: row.source_version,
    createdAt: row.created_at,
  };
}

function revisionRowById(db: DatabaseSync, revisionId: string): TextRevisionRow | undefined {
  return db.prepare(`
    SELECT r.*, d.kind AS document_kind, d.title AS document_title
    FROM studio_text_revisions r
    JOIN studio_text_documents d ON d.id = r.document_id
    WHERE r.id = ?
  `).get(revisionId) as unknown as TextRevisionRow | undefined;
}

function documentRowById(db: DatabaseSync, documentId: string): DocumentRow | undefined {
  return db.prepare("SELECT * FROM studio_text_documents WHERE id = ?").get(documentId) as unknown as DocumentRow | undefined;
}

async function materializeTextCas(paths: StudioPaths, body: string): Promise<{
  sha256: string;
  sizeBytes: number;
  absolutePath: string;
  relativePath: string;
}> {
  if (typeof body !== "string" || !body.trim()) throw new Error("修订正文不能为空。");
  const bytes = Buffer.from(body, "utf8");
  if (bytes.byteLength > MAX_TEXT_BODY_BYTES) throw new Error(`修订正文不能超过 ${MAX_TEXT_BODY_BYTES} 字节。`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = path.join(paths.textCasRoot, sha256.slice(0, 2));
  const absolutePath = path.join(directory, `${sha256}.txt`);
  const directoryIdentity = await ensureConfinedDirectory(paths.root, directory);

  const persisted = await persistConfinedBytesNoReplace(directoryIdentity, `${sha256}.txt`, bytes);
  if (persisted.sha256 !== sha256 || persisted.size !== bytes.byteLength) {
    throw new Error(`文本 CAS dirfd 回执与 SHA 索引不一致：${absolutePath}`);
  }
  return {
    sha256,
    sizeBytes: bytes.byteLength,
    absolutePath,
    relativePath: relativeToProject(paths.root, absolutePath),
  };
}

async function readFrozenBody(metadata: StudioTextRevisionMetadata): Promise<string> {
  const pathBefore = await lstat(metadata.bodyPath, { bigint: true });
  const canonicalPath = await realpath(metadata.bodyPath);
  const canonicalBefore = await lstat(canonicalPath, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1n
    || !canonicalBefore.isFile() || canonicalBefore.isSymbolicLink() || canonicalBefore.nlink !== 1n
    || pathBefore.dev !== canonicalBefore.dev || pathBefore.ino !== canonicalBefore.ino) {
    throw new Error(`冻结文本 CAS 必须是单链接普通文件：${metadata.id}`);
  }
  const handle = await open(metadata.bodyPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n
      || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino
      || before.size !== BigInt(metadata.bodySizeBytes)) {
      throw new Error(`冻结文本 CAS 身份无效：${metadata.id}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(metadata.bodyPath, { bigint: true });
    if (!after.isFile() || after.nlink !== 1n
      || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || !pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.nlink !== 1n
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino) {
      throw new Error(`冻结文本 CAS 在读取期间发生变化：${metadata.id}`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== metadata.bodySizeBytes || sha256 !== metadata.bodySha256) {
      throw new Error(`冻结文本 CAS 验证失败：${metadata.id}`);
    }
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function createStudioTextDocument(
  projectRoot: string,
  input: CreateStudioTextDocumentInput,
): Promise<StudioTextDocument> {
  assertExpectedRevision(input.expectedRevision, 0);
  if (input.expectedRevision !== 0) throw new Error("创建文档必须提供 expectedRevision=0。");
  const paths = await ensureProductionDirectories(projectRoot);
  const id = normalizeId(input.id, "text", "document id");
  const kind = normalizeDocumentKind(input.kind);
  const title = requiredText(input.title, "title", 500);
  const now = new Date().toISOString();
  const db = openDatabase(paths.database);
  try {
    runTransaction(db, () => {
      const existing = documentRowById(db, id);
      if (existing) throw new StudioProductionConflictError(id, 0, Number(existing.revision));
      db.prepare(`
        INSERT INTO studio_text_documents(id, kind, title, revision, created_at, updated_at)
        VALUES(?, ?, ?, 0, ?, ?)
      `).run(id, kind, title, now, now);
    });
    return documentFromRow(documentRowById(db, id)!);
  } finally {
    db.close();
  }
}

export async function createStudioScriptDocument(
  projectRoot: string,
  input: CreateStudioScriptDocumentInput,
): Promise<StudioTextDocument> {
  return createStudioTextDocument(projectRoot, { ...input, kind: "script" });
}

export async function createStudioPromptDocument(
  projectRoot: string,
  input: CreateStudioPromptDocumentInput,
): Promise<StudioTextDocument> {
  return createStudioTextDocument(projectRoot, { ...input, kind: "prompt" });
}

async function appendTypedStudioTextRevision(
  projectRoot: string,
  input: AppendStudioTextRevisionInput,
  expectedKind?: StudioTextDocumentKind,
): Promise<AppendStudioTextRevisionResult> {
  assertExpectedRevision(input.expectedRevision, 0);
  const documentId = normalizeExistingId(input.documentId, "documentId");
  const source = requiredText(input.source, "source", 4_096);
  const sourceVersion = requiredText(input.sourceVersion, "sourceVersion", 500);
  const paths = await ensureProductionDirectories(projectRoot);
  const frozen = await materializeTextCas(paths, input.body);
  const db = openDatabase(paths.database);
  let revisionRow: TextRevisionRow;
  try {
    revisionRow = runTransaction(db, () => {
      const document = documentRowById(db, documentId);
      if (!document) throw new Error(`文本文档不存在：${documentId}`);
      if (expectedKind && document.kind !== expectedKind) {
        throw new Error(`文档 ${documentId} 不是 ${expectedKind} 文档。`);
      }
      if (Number(document.revision) !== input.expectedRevision) {
        throw new StudioProductionConflictError(documentId, input.expectedRevision, Number(document.revision));
      }
      const ordinal = input.expectedRevision + 1;
      const revisionIdentity = createHash("sha256").update(`${documentId}\u0000${ordinal}`).digest("hex").slice(0, 40);
      const id = `text-revision-${revisionIdentity}`;
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO studio_text_revisions(
          id, document_id, ordinal, body_sha256, body_size_bytes, body_relpath,
          source, source_version, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        documentId,
        ordinal,
        frozen.sha256,
        frozen.sizeBytes,
        frozen.relativePath,
        source,
        sourceVersion,
        now,
      );
      const update = db.prepare(`
        UPDATE studio_text_documents
        SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(now, documentId, input.expectedRevision);
      if (Number(update.changes) !== 1) {
        const latest = documentRowById(db, documentId);
        throw new StudioProductionConflictError(documentId, input.expectedRevision, Number(latest?.revision ?? -1));
      }
      return revisionRowById(db, id)!;
    });
    const document = documentFromRow(documentRowById(db, documentId)!);
    const metadata = textRevisionMetadataFromRow(paths.root, revisionRow);
    return { document, revision: { ...metadata, body: input.body } };
  } finally {
    db.close();
  }
}

export async function appendStudioTextRevision(
  projectRoot: string,
  input: AppendStudioTextRevisionInput,
): Promise<AppendStudioTextRevisionResult> {
  return appendTypedStudioTextRevision(projectRoot, input);
}

export async function appendStudioScriptRevision(
  projectRoot: string,
  input: AppendStudioTextRevisionInput,
): Promise<AppendStudioTextRevisionResult> {
  return appendTypedStudioTextRevision(projectRoot, input, "script");
}

export async function appendStudioPromptRevision(
  projectRoot: string,
  input: AppendStudioTextRevisionInput,
): Promise<AppendStudioTextRevisionResult> {
  return appendTypedStudioTextRevision(projectRoot, input, "prompt");
}

export async function listStudioTextDocuments(
  projectRoot: string,
  query: StudioTextDocumentListQuery = {},
): Promise<StudioTextDocumentPage> {
  const paths = await ensureProductionDirectories(projectRoot);
  const limit = normalizeLimit(query.limit);
  const kind = query.kind === undefined ? undefined : normalizeDocumentKind(query.kind);
  const search = query.search?.normalize("NFKC").trim().toLocaleLowerCase("zh-CN") ?? "";
  if (search.length > 256) throw new Error("search 不能超过 256 个字符。");
  const like = `%${search.replace(/[\\%_]/gu, (value) => `\\${value}`)}%`;
  const scope = `${kind ?? "*"}:${createHash("sha256").update(search, "utf8").digest("hex").slice(0, 16)}`;
  const after = decodeStringCursor(query.cursor, "text-documents", scope);
  const db = openDatabase(paths.database);
  try {
    const rows = db.prepare(`
      SELECT * FROM studio_text_documents
      WHERE (? IS NULL OR kind = ?)
        AND (? = '' OR lower(title) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR id > ?)
      ORDER BY id
      LIMIT ?
    `).all(kind ?? null, kind ?? null, search, like, after ?? null, after ?? null, limit + 1) as unknown as DocumentRow[];
    const selected = rows.slice(0, limit);
    return {
      items: selected.map(documentFromRow),
      nextCursor: rows.length > limit
        ? encodeCursor("text-documents", scope, selected[selected.length - 1]!.id)
        : undefined,
    };
  } finally {
    db.close();
  }
}

export async function getStudioTextDocument(
  projectRoot: string,
  documentId: string,
): Promise<StudioTextDocument | null> {
  const paths = await ensureProductionDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    const row = db.prepare("SELECT * FROM studio_text_documents WHERE id = ?").get(normalizeExistingId(documentId, "documentId")) as unknown as DocumentRow | undefined;
    return row ? documentFromRow(row) : null;
  } finally {
    db.close();
  }
}

export async function listStudioTextRevisions(
  projectRoot: string,
  query: StudioTextRevisionListQuery,
): Promise<StudioTextRevisionPage> {
  const paths = await ensureProductionDirectories(projectRoot);
  const documentId = normalizeExistingId(query.documentId, "documentId");
  const limit = normalizeLimit(query.limit);
  const after = decodeIntegerCursor(query.cursor, "text-revisions", documentId);
  const db = openDatabase(paths.database);
  try {
    if (!documentRowById(db, documentId)) throw new Error(`文本文档不存在：${documentId}`);
    const rows = (after === undefined
      ? db.prepare(`
          SELECT r.*, d.kind AS document_kind, d.title AS document_title
          FROM studio_text_revisions r JOIN studio_text_documents d ON d.id = r.document_id
          WHERE r.document_id = ? ORDER BY r.ordinal LIMIT ?
        `).all(documentId, limit + 1)
      : db.prepare(`
          SELECT r.*, d.kind AS document_kind, d.title AS document_title
          FROM studio_text_revisions r JOIN studio_text_documents d ON d.id = r.document_id
          WHERE r.document_id = ? AND r.ordinal > ? ORDER BY r.ordinal LIMIT ?
        `).all(documentId, after, limit + 1)) as unknown as TextRevisionRow[];
    const selected = rows.slice(0, limit);
    return {
      items: selected.map((row) => textRevisionMetadataFromRow(paths.root, row)),
      nextCursor: rows.length > limit
        ? encodeCursor("text-revisions", documentId, Number(selected[selected.length - 1]!.ordinal))
        : undefined,
    };
  } finally {
    db.close();
  }
}

export async function getStudioTextRevision(
  projectRoot: string,
  revisionId: string,
): Promise<StudioTextRevision | null> {
  const paths = await ensureProductionDirectories(projectRoot);
  const id = normalizeExistingId(revisionId, "revisionId");
  const db = openDatabase(paths.database);
  let metadata: StudioTextRevisionMetadata | undefined;
  try {
    const row = revisionRowById(db, id);
    if (row) metadata = textRevisionMetadataFromRow(paths.root, row);
  } finally {
    db.close();
  }
  if (!metadata) return null;
  return { ...metadata, body: await readFrozenBody(metadata) };
}

export async function getLatestStudioTextRevisionMetadata(
  projectRoot: string,
  documentId: string,
): Promise<StudioTextRevisionMetadata | null> {
  const paths = await ensureProductionDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    const row = db.prepare(`
      SELECT r.*, d.kind AS document_kind, d.title AS document_title
      FROM studio_text_revisions r
      JOIN studio_text_documents d ON d.id = r.document_id
      WHERE r.document_id = ?
      ORDER BY r.ordinal DESC
      LIMIT 1
    `).get(normalizeExistingId(documentId, "documentId")) as unknown as TextRevisionRow | undefined;
    return row ? textRevisionMetadataFromRow(paths.root, row) : null;
  } finally {
    db.close();
  }
}

function normalizeAssetCategory(category: string): StudioAssetCategory {
  if (category !== "character" && category !== "scene" && category !== "prop" && category !== "style") {
    throw new Error("资产 category 必须是 character、scene、prop 或 style。");
  }
  return category;
}

function normalizeAssetPresence(presence: string): StudioAssetPresence {
  if (presence !== "required" && presence !== "optional" && presence !== "forbidden") {
    throw new Error("资产 presence 必须是 required、optional 或 forbidden。");
  }
  return presence;
}

function secondsToMilliseconds(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new Error(`${field} 必须是有限数字。`);
  const scaled = value * 1_000;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) throw new Error(`${field} 最多支持毫秒精度。`);
  return rounded;
}

function normalizePanelAsset(input: StudioPanelAssetMentionInput): NormalizedAssetMention {
  const evidence = input.evidence;
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 100) {
    throw new Error("每个资产提及必须提供 1-100 条连续性证据。");
  }
  return {
    assetId: normalizeExistingId(input.assetId, "assetId"),
    category: normalizeAssetCategory(input.category),
    presence: normalizeAssetPresence(input.presence),
    role: requiredText(input.role, "asset role", 1_000),
    continuityState: requiredText(input.continuityState, "continuityState", 10_000),
    evidence: evidence.map((item) => ({
      kind: requiredText(item.kind, "evidence kind", 500),
      reference: requiredText(item.reference, "evidence reference", 4_096),
      note: optionalText(item.note, "evidence note", 10_000),
    })),
  };
}

function normalizePanelSourceSpans(
  input: StudioProductionPanelSourceSpanInput[] | undefined,
  scriptRevision: StudioTextRevision,
  panelIndex: number,
): NormalizedPanelSourceSpan[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error(`panel ${panelIndex} sourceSpans 必须是数组。`);
  let previousEnd = -1;
  return input.map((span, offset) => {
    if (!span || typeof span !== "object") throw new Error(`panel ${panelIndex} sourceSpans[${offset}] 结构无效。`);
    const surface = assertUtf16Range(
      scriptRevision.body,
      span.startOffsetUtf16,
      span.endOffsetUtf16,
      `panel ${panelIndex} sourceSpans[${offset}]`,
    );
    if (!surface.trim()) throw new Error(`panel ${panelIndex} sourceSpans[${offset}] 不能为空。`);
    if (offset > 0 && span.startOffsetUtf16 < previousEnd) {
      throw new Error(`panel ${panelIndex} sourceSpans 必须按 UTF-16 偏移升序排列且不得重叠。`);
    }
    previousEnd = span.endOffsetUtf16;
    return {
      index: offset + 1,
      scriptRevisionId: scriptRevision.id,
      scriptSha256: scriptRevision.bodySha256,
      startOffsetUtf16: span.startOffsetUtf16,
      endOffsetUtf16: span.endOffsetUtf16,
      surfaceSha256: sha256(surface),
    };
  });
}

function normalizeShotType(value: string | undefined, panelIndex: number): "original" | "extension" {
  if (value === undefined || value === "original") return "original";
  if (value === "extension") return "extension";
  throw new Error(`panel ${panelIndex} shotType 必须是 original 或 extension。`);
}

/** P20 祖辈规则：上一 revision 同 id 且全部可比较字段一致、且上一版同样零 spans 的格，revise 时可保留零 spans。 */
function panelUnchangedWithZeroSpans(
  current: {
    id: string;
    title: string;
    visualAction: string;
    shotComposition: string;
    filmingMethod: string;
    dialogue: string;
    subtitle: string;
    startMilliseconds: number;
    endMilliseconds: number;
    durationMilliseconds: number;
    promptRevisionId: string;
    transition: string;
    costumeState: string;
    sceneLighting: string;
    negativePrompt: string;
    assets: NormalizedAssetMention[];
  },
  previousPanels: StudioProductionPanel[] | undefined,
): boolean {
  const previous = previousPanels?.find((candidate) => candidate.id === current.id);
  if (!previous || previous.sourceSpans.length > 0 || previous.shotType !== "original") return false;
  // 两侧 evidence 形状不同（snapshot 侧带 index）：归一为 {kind, reference, note} 三元组再比较。
  const evidenceTriples = (items: ReadonlyArray<{ kind: string; reference: string; note: string }>) =>
    items.map((item) => ({ kind: item.kind, reference: item.reference, note: item.note }));
  const assetMentionsEqual = current.assets.length === previous.assets.length
    && current.assets.every((asset, index) => {
      const before = previous.assets[index];
      if (!before) return false;
      return asset.assetId === before.assetId
        && asset.category === before.category
        && asset.presence === before.presence
        && asset.role === before.role
        && asset.continuityState === before.continuityState
        && stableJson(evidenceTriples(asset.evidence)) === stableJson(evidenceTriples(before.evidence));
    });
  return previous.title === current.title
    && previous.visualAction === current.visualAction
    && previous.shotComposition === current.shotComposition
    && previous.filmingMethod === current.filmingMethod
    && previous.dialogue === current.dialogue
    && previous.subtitle === current.subtitle
    && secondsToMilliseconds(previous.startSeconds, "previous startSeconds") === current.startMilliseconds
    && secondsToMilliseconds(previous.endSeconds, "previous endSeconds") === current.endMilliseconds
    && secondsToMilliseconds(previous.durationSeconds, "previous durationSeconds") === current.durationMilliseconds
    && previous.promptRevisionId === current.promptRevisionId
    && previous.transition === current.transition
    && previous.costumeState === current.costumeState
    && previous.sceneLighting === current.sceneLighting
    && previous.negativePrompt === current.negativePrompt
    && assetMentionsEqual;
}

async function normalizeUnitDraft(
  projectRoot: string,
  unitId: string,
  input: StudioProductionUnitDraft,
  previous?: Pick<StudioProductionUnitSnapshot, "unit" | "panels">,
): Promise<NormalizedUnitDraft> {
  const panels = input.panels;
  if (!Array.isArray(panels)
    || panels.length < STUDIO_PRODUCTION_MIN_PANEL_COUNT
    || panels.length > STUDIO_PRODUCTION_MAX_PANEL_COUNT) {
    throw new Error(`生产单元故事板必须是 ${STUDIO_PRODUCTION_MIN_PANEL_COUNT}-${STUDIO_PRODUCTION_MAX_PANEL_COUNT} 宫格。`);
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error("sequence 必须是正整数。");
  const durationMilliseconds = secondsToMilliseconds(
    input.durationSeconds ?? previous?.unit.durationSeconds ?? STUDIO_PRODUCTION_DURATION_SECONDS,
    "unit durationSeconds",
  );
  if (durationMilliseconds < MIN_UNIT_DURATION_MILLISECONDS || durationMilliseconds > UNIT_DURATION_MILLISECONDS) {
    throw new Error("生产单元 durationSeconds 必须在 1-15 秒范围内。");
  }
  const scriptRevisionId = normalizeExistingId(input.scriptRevisionId, "scriptRevisionId");
  const scriptRevision = await getStudioTextRevision(projectRoot, scriptRevisionId);
  if (!scriptRevision || scriptRevision.documentKind !== "script") {
    throw new Error(`剧本修订不存在：${scriptRevisionId}`);
  }
  let cursor = 0;
  const panelIds = new Set<string>();
  const normalizedPanels = panels.map((panel, offset): NormalizedPanel => {
    const index = offset + 1;
    const defaultPanelId = `panel-${createHash("sha256").update(`${unitId}\u0000${index}`).digest("hex").slice(0, 40)}`;
    const id = normalizeId(panel.id ?? defaultPanelId, "panel", `panel ${index} id`);
    if (panelIds.has(id)) throw new Error(`宫格 id 重复：${id}`);
    panelIds.add(id);
    const startMilliseconds = secondsToMilliseconds(panel.startSeconds, `panel ${index} startSeconds`);
    const durationMilliseconds = secondsToMilliseconds(panel.durationSeconds, `panel ${index} durationSeconds`);
    if (durationMilliseconds <= 0) throw new Error(`panel ${index} durationSeconds 必须大于 0。`);
    const endMilliseconds = panel.endSeconds === undefined
      ? startMilliseconds + durationMilliseconds
      : secondsToMilliseconds(panel.endSeconds, `panel ${index} endSeconds`);
    if (endMilliseconds !== startMilliseconds + durationMilliseconds) {
      throw new Error(`panel ${index} 的起止时间与时长不一致。`);
    }
    if (startMilliseconds > cursor) throw new Error(`宫格时间在 ${cursor / 1_000}s 处存在空洞。`);
    if (startMilliseconds < cursor) throw new Error(`宫格时间在 ${startMilliseconds / 1_000}s 处发生重叠。`);
    cursor = endMilliseconds;
    if (!Array.isArray(panel.assets) || panel.assets.length > 100) {
      throw new Error(`panel ${index} 的 legacy assets 必须是 0-100 项数组。P6 绑定不得依赖预填 panel.assets。`);
    }
    const assets = panel.assets.map(normalizePanelAsset);
    const assetIds = new Set<string>();
    for (const asset of assets) {
      if (assetIds.has(asset.assetId)) throw new Error(`panel ${index} 重复提及资产：${asset.assetId}`);
      assetIds.add(asset.assetId);
    }
    const shotType = normalizeShotType(panel.shotType, index);
    const sourceSpans = normalizePanelSourceSpans(panel.sourceSpans, scriptRevision, index);
    if (shotType === "extension" && sourceSpans.length > 0) {
      throw new Error(`panel ${index}（extension）禁止携带 sourceSpans：扩写不得锚定原文冒充出处。`);
    }
    const normalized = {
      id,
      index,
      title: requiredText(panel.title, `panel ${index} title`, 1_000),
      visualAction: requiredText(panel.visualAction, `panel ${index} visualAction`, 20_000),
      shotComposition: requiredText(panel.shotComposition, `panel ${index} shotComposition`, 10_000),
      filmingMethod: requiredText(panel.filmingMethod, `panel ${index} filmingMethod`, 10_000),
      dialogue: optionalText(panel.dialogue, `panel ${index} dialogue`, 20_000),
      subtitle: optionalText(panel.subtitle, `panel ${index} subtitle`, 20_000),
      startMilliseconds,
      endMilliseconds,
      durationMilliseconds,
      promptRevisionId: normalizeExistingId(panel.promptRevisionId, `panel ${index} promptRevisionId`),
      transition: optionalText(panel.transition, `panel ${index} transition`, 200),
      costumeState: optionalText(panel.costumeState, `panel ${index} costumeState`, 200),
      sceneLighting: optionalText(panel.sceneLighting, `panel ${index} sceneLighting`, 200),
      negativePrompt: optionalText(panel.negativePrompt, `panel ${index} negativePrompt`, 2_000),
      assets,
    };
    if (shotType === "original"
      && sourceSpans.length === 0
      && !panelUnchangedWithZeroSpans(normalized, previous?.panels)) {
      throw new Error(`panel ${index}（original）必须提供至少一条非空 sourceSpans 作为文本覆盖证据；沿上一 revision 未变化的格除外。`);
    }
    return {
      ...normalized,
      shotType,
      sourceSpans,
    };
  });
  if (cursor !== durationMilliseconds) {
    throw new Error(
      `生产单元宫格总时长必须严格等于声明时长 ${durationMilliseconds / 1_000} 秒，当前为 ${cursor / 1_000} 秒。`,
    );
  }
  // P20：extension 仅允许作为末尾连续后缀格，且单元至少含 1 个 original 格。
  const firstExtensionIndex = normalizedPanels.findIndex((panel) => panel.shotType === "extension");
  if (firstExtensionIndex === 0) {
    throw new Error("extension 不得作为首格：单元至少包含 1 个 original 格，extension 仅允许作为末尾连续后缀格。");
  }
  if (firstExtensionIndex > 0) {
    for (let index = firstExtensionIndex; index < normalizedPanels.length; index += 1) {
      if (normalizedPanels[index]!.shotType !== "extension") {
        throw new Error("extension 仅允许作为单元末尾的连续后缀格。");
      }
    }
  }
  const season = requiredText(input.season, "season", 500);
  if (season === STUDIO_PRODUCTION_LEGACY_SEASON_ID) {
    throw new Error(`season=${STUDIO_PRODUCTION_LEGACY_SEASON_ID} 仅用于标记 v1 历史数据；新建或修订单元必须提供明确季 ID。`);
  }
  return {
    season,
    episode: requiredText(input.episode, "episode", 500),
    sequence: input.sequence,
    title: requiredText(input.title, "unit title", 1_000),
    durationMilliseconds,
    scriptRevisionId,
    panels: normalizedPanels,
  };
}

function assertRevisionKind(db: DatabaseSync, revisionId: string, kind: StudioTextDocumentKind): void {
  const row = revisionRowById(db, revisionId);
  if (!row) throw new Error(`文本修订不存在：${revisionId}`);
  if (row.document_kind !== kind) throw new Error(`文本修订 ${revisionId} 不是 ${kind} 修订。`);
}

function insertUnitRevision(
  db: DatabaseSync,
  unitId: string,
  revision: number,
  draft: NormalizedUnitDraft,
  createdAt: string,
): void {
  assertRevisionKind(db, draft.scriptRevisionId, "script");
  const promptRevisionIds = new Set(draft.panels.map((panel) => panel.promptRevisionId));
  for (const promptRevisionId of promptRevisionIds) assertRevisionKind(db, promptRevisionId, "prompt");

  db.prepare(`
    INSERT INTO studio_production_unit_revisions(
      unit_id, revision, season, episode, sequence, title, duration_ms, panel_count,
      script_revision_id, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    unitId,
    revision,
    draft.season,
    draft.episode,
    draft.sequence,
    draft.title,
    UNIT_DURATION_MILLISECONDS,
    draft.panels.length,
    draft.scriptRevisionId,
    createdAt,
  );
  db.prepare(`
    INSERT INTO studio_production_unit_timings(unit_id, unit_revision, duration_ms, created_at)
    VALUES(?, ?, ?, ?)
  `).run(unitId, revision, draft.durationMilliseconds, createdAt);

  const insertPanel = db.prepare(`
    INSERT INTO studio_production_panels(
      unit_id, unit_revision, panel_index, panel_id, title, visual_action,
      shot_composition, filming_method, dialogue, subtitle, start_ms, end_ms,
      duration_ms, prompt_revision_id, transition, costume_state, scene_lighting,
      shot_type, negative_prompt
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSourceSpan = db.prepare(`
    INSERT INTO studio_production_panel_source_spans(
      unit_id, unit_revision, panel_index, span_index, script_revision_id,
      script_sha256, start_offset_utf16, end_offset_utf16, surface_sha256
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAsset = db.prepare(`
    INSERT INTO studio_production_panel_assets(
      unit_id, unit_revision, unit_sequence, panel_index, asset_id, category,
      presence, role, continuity_state
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvidence = db.prepare(`
    INSERT INTO studio_production_continuity_evidence(
      unit_id, unit_revision, panel_index, asset_id, evidence_index, kind, reference, note
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const panel of draft.panels) {
    insertPanel.run(
      unitId,
      revision,
      panel.index,
      panel.id,
      panel.title,
      panel.visualAction,
      panel.shotComposition,
      panel.filmingMethod,
      panel.dialogue,
      panel.subtitle,
      panel.startMilliseconds,
      panel.endMilliseconds,
      panel.durationMilliseconds,
      panel.promptRevisionId,
      panel.transition,
      panel.costumeState,
      panel.sceneLighting,
      panel.shotType,
      panel.negativePrompt,
    );
    for (const span of panel.sourceSpans) {
      insertSourceSpan.run(
        unitId,
        revision,
        panel.index,
        span.index,
        span.scriptRevisionId,
        span.scriptSha256,
        span.startOffsetUtf16,
        span.endOffsetUtf16,
        span.surfaceSha256,
      );
    }
    for (const asset of panel.assets) {
      insertAsset.run(
        unitId,
        revision,
        draft.sequence,
        panel.index,
        asset.assetId,
        asset.category,
        asset.presence,
        asset.role,
        asset.continuityState,
      );
      asset.evidence.forEach((evidence, evidenceOffset) => {
        insertEvidence.run(
          unitId,
          revision,
          panel.index,
          asset.assetId,
          evidenceOffset + 1,
          evidence.kind,
          evidence.reference,
          evidence.note,
        );
      });
    }
  }
}

function unitRowById(db: DatabaseSync, unitId: string): UnitRow | undefined {
  return db.prepare("SELECT * FROM studio_production_units WHERE id = ?").get(unitId) as unknown as UnitRow | undefined;
}

function unitTimingRow(
  db: DatabaseSync,
  unitId: string,
  unitRevision: number,
): UnitTimingRow | undefined {
  recordStudioUnitsReadCounter("unitTimingQueries");
  recordStudioUnitsReadCounter("productionBusinessSqlExecutions");
  return db.prepare(`SELECT * FROM studio_production_unit_timings
    WHERE unit_id = ? AND unit_revision = ?`)
    .get(unitId, unitRevision) as unknown as UnitTimingRow | undefined;
}

function effectiveUnitDurationMilliseconds(
  db: DatabaseSync,
  unitId: string,
  unitRevision: number,
  legacyDurationMilliseconds: number,
): number {
  if (legacyDurationMilliseconds !== UNIT_DURATION_MILLISECONDS) {
    throw new Error(`生产单元 ${unitId} r${unitRevision} 的 legacy 时长包络已损坏。`);
  }
  const timing = unitTimingRow(db, unitId, unitRevision);
  const duration = timing ? Number(timing.duration_ms) : legacyDurationMilliseconds;
  if (!Number.isSafeInteger(duration)
    || duration < MIN_UNIT_DURATION_MILLISECONDS
    || duration > UNIT_DURATION_MILLISECONDS) {
    throw new Error(`生产单元 ${unitId} r${unitRevision} 的真实时长已损坏。`);
  }
  return duration;
}

function episodeStartMilliseconds(
  db: DatabaseSync,
  season: string,
  episode: string,
  sequence: number,
  excludeUnitId: string,
): number {
  recordStudioUnitsReadCounter("episodeStartQueries");
  recordStudioUnitsReadCounter("productionBusinessSqlExecutions");
  const row = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(t.duration_ms, u.duration_ms)), 0) AS known_start_ms,
           COUNT(*) AS known_count
    FROM studio_production_units u
    LEFT JOIN studio_production_unit_timings t
      ON t.unit_id = u.id AND t.unit_revision = u.revision
    WHERE u.season = ? AND u.episode = ? AND u.sequence < ? AND u.id <> ?
  `).get(season, episode, sequence, excludeUnitId) as { known_start_ms: number; known_count: number };
  const knownCount = Number(row.known_count);
  const missingLegacySlots = Math.max(0, sequence - 1 - knownCount);
  const start = Number(row.known_start_ms) + missingLegacySlots * UNIT_DURATION_MILLISECONDS;
  if (!Number.isSafeInteger(start) || start < 0) throw new Error("生产单元集内累计时码已损坏。");
  return start;
}

function seasonOrigin(season: string): "explicit" | "legacy-migrated" {
  return season === STUDIO_PRODUCTION_LEGACY_SEASON_ID ? "legacy-migrated" : "explicit";
}

function assertUnitSequenceAvailable(db: DatabaseSync, draft: NormalizedUnitDraft, exceptUnitId?: string): void {
  const duplicate = (exceptUnitId
    ? db.prepare(`
        SELECT id FROM studio_production_units
        WHERE season = ? AND episode = ? AND sequence = ? AND id <> ?
        LIMIT 1
      `).get(draft.season, draft.episode, draft.sequence, exceptUnitId)
    : db.prepare(`
        SELECT id FROM studio_production_units
        WHERE season = ? AND episode = ? AND sequence = ?
        LIMIT 1
      `).get(draft.season, draft.episode, draft.sequence)) as { id: string } | undefined;
  if (duplicate) {
    throw new Error(
      `${draft.season}/${draft.episode} 的 15 秒单元序号 ${draft.sequence} 已由 ${duplicate.id} 使用；sequence 必须在同季同集内唯一。`,
    );
  }
}

function unitSummaryFromRow(db: DatabaseSync, row: UnitRow): StudioProductionUnitSummary {
  const durationMilliseconds = effectiveUnitDurationMilliseconds(
    db,
    row.id,
    Number(row.revision),
    Number(row.duration_ms),
  );
  const episodeStart = episodeStartMilliseconds(db, row.season, row.episode, Number(row.sequence), row.id);
  return {
    id: row.id,
    season: row.season,
    seasonOrigin: seasonOrigin(row.season),
    episode: row.episode,
    sequence: Number(row.sequence),
    title: row.title,
    revision: Number(row.revision),
    durationSeconds: durationMilliseconds / 1_000,
    episodeStartSeconds: episodeStart / 1_000,
    episodeEndSeconds: (episodeStart + durationMilliseconds) / 1_000,
    panelCount: Number(row.panel_count),
    scriptRevisionId: row.script_revision_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function unitSummaryFromRevisionRow(
  db: DatabaseSync,
  current: UnitRow,
  revision: UnitRevisionRow,
): StudioProductionUnitSummary {
  if (revision.unit_id !== current.id) throw new Error("生产单元历史修订归属已损坏。");
  const durationMilliseconds = effectiveUnitDurationMilliseconds(
    db,
    revision.unit_id,
    Number(revision.revision),
    Number(revision.duration_ms),
  );
  const episodeStart = episodeStartMilliseconds(
    db,
    revision.season,
    revision.episode,
    Number(revision.sequence),
    revision.unit_id,
  );
  return {
    id: revision.unit_id,
    season: revision.season,
    seasonOrigin: seasonOrigin(revision.season),
    episode: revision.episode,
    sequence: Number(revision.sequence),
    title: revision.title,
    revision: Number(revision.revision),
    durationSeconds: durationMilliseconds / 1_000,
    episodeStartSeconds: episodeStart / 1_000,
    episodeEndSeconds: (episodeStart + durationMilliseconds) / 1_000,
    panelCount: Number(revision.panel_count),
    scriptRevisionId: revision.script_revision_id,
    createdAt: current.created_at,
    updatedAt: revision.created_at,
  };
}

function unitRevisionSummaryFromRow(db: DatabaseSync, row: UnitRevisionRow): StudioProductionUnitRevisionSummary {
  const durationMilliseconds = effectiveUnitDurationMilliseconds(
    db,
    row.unit_id,
    Number(row.revision),
    Number(row.duration_ms),
  );
  const episodeStart = episodeStartMilliseconds(db, row.season, row.episode, Number(row.sequence), row.unit_id);
  return {
    unitId: row.unit_id,
    revision: Number(row.revision),
    season: row.season,
    seasonOrigin: seasonOrigin(row.season),
    episode: row.episode,
    sequence: Number(row.sequence),
    title: row.title,
    durationSeconds: durationMilliseconds / 1_000,
    episodeStartSeconds: episodeStart / 1_000,
    episodeEndSeconds: (episodeStart + durationMilliseconds) / 1_000,
    panelCount: Number(row.panel_count),
    scriptRevisionId: row.script_revision_id,
    createdAt: row.created_at,
  };
}

export async function createStudioProductionUnit(
  projectRoot: string,
  input: CreateStudioProductionUnitInput,
): Promise<StudioProductionUnitSnapshot> {
  assertExpectedRevision(input.expectedRevision, 0);
  if (input.expectedRevision !== 0) throw new Error("创建生产单元必须提供 expectedRevision=0。");
  const paths = await ensureProductionDirectories(projectRoot);
  const unitId = normalizeId(input.id, "unit", "unit id");
  const draft = await normalizeUnitDraft(paths.root, unitId, input);
  const now = new Date().toISOString();
  const db = openDatabase(paths.database);
  try {
    runTransaction(db, () => {
      const existing = unitRowById(db, unitId);
      if (existing) throw new StudioProductionConflictError(unitId, 0, Number(existing.revision));
      assertUnitSequenceAvailable(db, draft);
      db.prepare(`
        INSERT INTO studio_production_units(
          id, season, episode, sequence, title, revision, duration_ms, panel_count,
          script_revision_id, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(
        unitId,
        draft.season,
        draft.episode,
        draft.sequence,
        draft.title,
        UNIT_DURATION_MILLISECONDS,
        draft.panels.length,
        draft.scriptRevisionId,
        now,
        now,
      );
      insertUnitRevision(db, unitId, 1, draft, now);
    });
  } finally {
    db.close();
  }
  return getStudioProductionUnitSnapshot(paths.root, unitId).then((snapshot) => snapshot!);
}

export async function reviseStudioProductionUnit(
  projectRoot: string,
  input: ReviseStudioProductionUnitInput,
): Promise<StudioProductionUnitSnapshot> {
  assertExpectedRevision(input.expectedRevision, 1);
  const paths = await ensureProductionDirectories(projectRoot);
  const unitId = normalizeExistingId(input.unitId, "unitId");
  // P20 祖辈规则：把上一 revision 的格传入校验，沿未变化的格可保留零 spans。
  // 读取异常必须失败关闭；不得把 timing/DB 损坏吞成“无祖辈”后回退 legacy 15 秒。
  const previous = await getStudioProductionUnitSnapshot(paths.root, unitId);
  const draft = await normalizeUnitDraft(paths.root, unitId, input, previous ?? undefined);
  const now = new Date().toISOString();
  const db = openDatabase(paths.database);
  try {
    runTransaction(db, () => {
      const current = unitRowById(db, unitId);
      if (!current) throw new Error(`生产单元不存在：${unitId}`);
      if (Number(current.revision) !== input.expectedRevision) {
        throw new StudioProductionConflictError(unitId, input.expectedRevision, Number(current.revision));
      }
      assertUnitSequenceAvailable(db, draft, unitId);
      const nextRevision = input.expectedRevision + 1;
      insertUnitRevision(db, unitId, nextRevision, draft, now);
      const update = db.prepare(`
        UPDATE studio_production_units
        SET season = ?, episode = ?, sequence = ?, title = ?, revision = revision + 1,
            duration_ms = ?, panel_count = ?, script_revision_id = ?, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        draft.season,
        draft.episode,
        draft.sequence,
        draft.title,
        UNIT_DURATION_MILLISECONDS,
        draft.panels.length,
        draft.scriptRevisionId,
        now,
        unitId,
        input.expectedRevision,
      );
      if (Number(update.changes) !== 1) {
        const latest = unitRowById(db, unitId);
        throw new StudioProductionConflictError(unitId, input.expectedRevision, Number(latest?.revision ?? -1));
      }
    });
  } finally {
    db.close();
  }
  return getStudioProductionUnitSnapshot(paths.root, unitId).then((snapshot) => snapshot!);
}

interface UnitCursorKey {
  season: string;
  episode: string;
  sequence: number;
  id: string;
}

function decodeUnitCursor(cursor: string | undefined, scope: string): UnitCursorKey | undefined {
  const key = decodeCursor(cursor, "production-units", scope);
  if (key === undefined) return undefined;
  if (!key || typeof key !== "object") throw new Error("分页 cursor 键无效。");
  const candidate = key as Partial<UnitCursorKey>;
  if (typeof candidate.season !== "string" || !candidate.season
    || typeof candidate.episode !== "string" || !candidate.episode
    || !Number.isSafeInteger(candidate.sequence) || Number(candidate.sequence) < 1
    || typeof candidate.id !== "string" || !candidate.id) {
    throw new Error("分页 cursor 键无效。");
  }
  return {
    season: candidate.season,
    episode: candidate.episode,
    sequence: Number(candidate.sequence),
    id: candidate.id,
  };
}

export async function listStudioProductionUnits(
  projectRoot: string,
  query: StudioProductionUnitListQuery = {},
): Promise<StudioProductionUnitPage> {
  const paths = await ensureProductionDirectories(projectRoot);
  const limit = normalizeLimit(query.limit);
  const season = query.season === undefined ? undefined : requiredText(query.season, "season", 500);
  const episode = query.episode === undefined ? undefined : requiredText(query.episode, "episode", 500);
  const scope = JSON.stringify({ season: season ?? "*", episode: episode ?? "*" });
  const after = decodeUnitCursor(query.cursor, scope);
  const db = openDatabase(paths.database);
  try {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (season) {
      clauses.push("season = ?");
      parameters.push(season);
    }
    if (episode) {
      clauses.push("episode = ?");
      parameters.push(episode);
    }
    if (after) {
      clauses.push("(season, episode, sequence, id) > (?, ?, ?, ?)");
      parameters.push(after.season, after.episode, after.sequence, after.id);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    recordStudioUnitsReadCounter("unitPageQueries");
    recordStudioUnitsReadCounter("productionBusinessSqlExecutions");
    const rows = db.prepare(`
      SELECT * FROM studio_production_units
      ${where}
      ORDER BY season, episode, sequence, id
      LIMIT ?
    `).all(...parameters, limit + 1) as unknown as UnitRow[];
    const selected = rows.slice(0, limit);
    const last = selected[selected.length - 1];
    return {
      items: selected.map((row) => unitSummaryFromRow(db, row)),
      nextCursor: rows.length > limit && last
        ? encodeCursor("production-units", scope, {
          season: last.season,
          episode: last.episode,
          sequence: Number(last.sequence),
          id: last.id,
        })
        : undefined,
    };
  } finally {
    db.close();
  }
}

export async function getStudioProductionScopeFacets(projectRoot: string): Promise<StudioProductionScopeFacets> {
  const paths = await ensureProductionDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    recordStudioUnitsReadCounter("facetQueries", 3);
    recordStudioUnitsReadCounter("productionBusinessSqlExecutions", 3);
    const seasons = (db.prepare("SELECT DISTINCT season FROM studio_production_units ORDER BY season").all() as Array<{ season: string }>)
      .map((row) => row.season);
    const episodes = (db.prepare(`SELECT DISTINCT season, episode FROM studio_production_units
      ORDER BY season, episode`).all() as Array<{ season: string; episode: string }>);
    return {
      seasons,
      episodes,
      totalUnits: count(db, "SELECT COUNT(*) AS count FROM studio_production_units"),
    };
  } finally {
    db.close();
  }
}

interface ContractProfileRow {
  profile_id: string;
  season: string;
  episode: string;
  min_control_references: number;
  max_control_references: number;
  source_fingerprint: string;
  fingerprint: string;
  created_at: string;
}

function contractProfileFromRow(row: ContractProfileRow): StudioProductionContractProfile {
  return {
    schemaVersion: 1,
    kind: "studio-production-contract-profile",
    profileId: row.profile_id,
    season: row.season,
    episode: row.episode,
    minControlReferences: Number(row.min_control_references),
    maxControlReferences: Number(row.max_control_references),
    sourceFingerprint: row.source_fingerprint,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
  };
}

export async function getStudioProductionContractProfile(
  projectRoot: string,
  input: { season: string; episode: string },
): Promise<StudioProductionContractProfile | null> {
  const paths = await ensureProductionDirectories(projectRoot);
  const season = requiredText(input.season, "season", 500);
  const episode = requiredText(input.episode, "episode", 500);
  const db = openDatabase(paths.database);
  try {
    const row = db.prepare(`SELECT * FROM studio_production_contract_profiles
      WHERE season = ? AND episode = ?`).get(season, episode) as unknown as ContractProfileRow | undefined;
    return row ? contractProfileFromRow(row) : null;
  } finally {
    db.close();
  }
}

export async function createStudioProductionContractProfile(
  projectRoot: string,
  input: CreateStudioProductionContractProfileInput,
): Promise<StudioProductionContractProfile> {
  assertExpectedRevision(input.expectedRevision, 0);
  if (input.expectedRevision !== 0) throw new Error("创建生产合同 profile 必须提供 expectedRevision=0。");
  const profileId = normalizeExistingId(input.profileId, "profileId");
  const season = requiredText(input.season, "season", 500);
  const episode = requiredText(input.episode, "episode", 500);
  if (!Number.isSafeInteger(input.minControlReferences)
    || !Number.isSafeInteger(input.maxControlReferences)
    || input.minControlReferences < 0
    || input.maxControlReferences > 6
    || input.maxControlReferences < 1
    || input.minControlReferences > input.maxControlReferences) {
    throw new Error("生产合同 control references 必须满足 0 <= min <= max <= 6 且 max >= 1。");
  }
  const sourceFingerprint = input.sourceFingerprint.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(sourceFingerprint)) throw new Error("sourceFingerprint 必须是 64 位小写 SHA-256。");
  const semantic = {
    schemaVersion: 1,
    kind: "studio-production-contract-profile" as const,
    profileId,
    season,
    episode,
    minControlReferences: input.minControlReferences,
    maxControlReferences: input.maxControlReferences,
    sourceFingerprint,
  };
  const fingerprint = sha256(stableJson(semantic));
  const paths = await ensureProductionDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    return runTransaction(db, () => {
      const existingByScope = db.prepare(`SELECT * FROM studio_production_contract_profiles
        WHERE season = ? AND episode = ?`).get(season, episode) as unknown as ContractProfileRow | undefined;
      if (existingByScope) {
        if (existingByScope.profile_id === profileId && existingByScope.fingerprint === fingerprint) {
          return contractProfileFromRow(existingByScope);
        }
        throw new Error(`生产合同 profile 已冻结且内容不同：${season}/${episode}`);
      }
      const existingById = db.prepare("SELECT * FROM studio_production_contract_profiles WHERE profile_id = ?")
        .get(profileId) as unknown as ContractProfileRow | undefined;
      if (existingById) throw new Error(`生产合同 profileId 已由其他范围使用：${profileId}`);
      const createdAt = new Date().toISOString();
      db.prepare(`INSERT INTO studio_production_contract_profiles(
        profile_id, season, episode, min_control_references, max_control_references,
        source_fingerprint, fingerprint, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          profileId,
          season,
          episode,
          input.minControlReferences,
          input.maxControlReferences,
          sourceFingerprint,
          fingerprint,
          createdAt,
        );
      return contractProfileFromRow(db.prepare("SELECT * FROM studio_production_contract_profiles WHERE profile_id = ?")
        .get(profileId) as unknown as ContractProfileRow);
    });
  } finally {
    db.close();
  }
}

export async function getStudioUnitBindingHeadSummaries(
  projectRoot: string,
  unitIds: string[],
): Promise<StudioUnitBindingHeadSummary[]> {
  if (!Array.isArray(unitIds) || unitIds.length > 100) throw new Error("unitIds 最多 100 项。");
  const ids = [...new Set(unitIds.map((unitId) => normalizeExistingId(unitId, "unitId")))];
  if (ids.length === 0) return [];
  const paths = await ensureProductionDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    recordStudioUnitsReadCounter("bindingHeadQueries");
    recordStudioUnitsReadCounter("productionBusinessSqlExecutions");
    const requestedValues = ids.map((_, index) => `(?, ${index})`).join(", ");
    const rows = db.prepare(`WITH requested(unit_id, ordinal) AS (VALUES ${requestedValues}),
      analysis_counts AS (
        SELECT ah.unit_id, COUNT(*) AS count
        FROM studio_asset_mention_analysis_heads ah JOIN requested r ON r.unit_id = ah.unit_id
        GROUP BY ah.unit_id
      ),
      binding_counts AS (
        SELECT bh.unit_id, COUNT(*) AS count
        FROM studio_asset_binding_set_heads bh JOIN requested r ON r.unit_id = bh.unit_id
        GROUP BY bh.unit_id
      ),
      unresolved_counts AS (
        SELECT ah.unit_id,
          SUM(CASE WHEN p.status = 'matched' AND dh.proposal_id IS NULL THEN 1 ELSE 0 END) AS matched_count,
          SUM(CASE WHEN p.status = 'ambiguous' AND dh.proposal_id IS NULL THEN 1 ELSE 0 END) AS ambiguous_count,
          SUM(CASE WHEN p.status = 'unmatched' AND dh.proposal_id IS NULL THEN 1 ELSE 0 END) AS unmatched_count
        FROM studio_asset_mention_analysis_heads ah
        JOIN requested r ON r.unit_id = ah.unit_id
        JOIN studio_asset_mention_proposals p ON p.analysis_id = ah.analysis_id
        LEFT JOIN studio_asset_mention_decision_heads dh ON dh.proposal_id = p.id
        GROUP BY ah.unit_id
      )
      SELECT u.id AS unit_id, u.panel_count,
        COALESCE(ac.count, 0) AS analysis_count,
        COALESCE(bc.count, 0) AS binding_count,
        COALESCE(uc.matched_count, 0) AS matched_count,
        COALESCE(uc.ambiguous_count, 0) AS ambiguous_count,
        COALESCE(uc.unmatched_count, 0) AS unmatched_count
      FROM requested r
      JOIN studio_production_units u ON u.id = r.unit_id
      LEFT JOIN analysis_counts ac ON ac.unit_id = u.id
      LEFT JOIN binding_counts bc ON bc.unit_id = u.id
      LEFT JOIN unresolved_counts uc ON uc.unit_id = u.id
      ORDER BY r.ordinal`).all(...ids) as Array<{
        unit_id: string;
        panel_count: number;
        analysis_count: number;
        binding_count: number;
        matched_count: number;
        ambiguous_count: number;
        unmatched_count: number;
      }>;
    return rows.map((row) => ({
      unitId: row.unit_id,
      panelCount: Number(row.panel_count),
      analysisHeadCount: Number(row.analysis_count),
      bindingHeadCount: Number(row.binding_count),
      unresolvedMatchedCount: Number(row.matched_count),
      unresolvedAmbiguousCount: Number(row.ambiguous_count),
      unresolvedUnmatchedCount: Number(row.unmatched_count),
    }));
  } finally {
    db.close();
  }
}

export async function listStudioProductionUnitRevisions(
  projectRoot: string,
  query: StudioProductionUnitRevisionListQuery,
): Promise<StudioProductionUnitRevisionPage> {
  const paths = await ensureProductionDirectories(projectRoot);
  const unitId = normalizeExistingId(query.unitId, "unitId");
  const limit = normalizeLimit(query.limit);
  const after = decodeIntegerCursor(query.cursor, "unit-revisions", unitId);
  const db = openDatabase(paths.database);
  try {
    if (!unitRowById(db, unitId)) throw new Error(`生产单元不存在：${unitId}`);
    const rows = (after === undefined
      ? db.prepare("SELECT * FROM studio_production_unit_revisions WHERE unit_id = ? ORDER BY revision LIMIT ?")
        .all(unitId, limit + 1)
      : db.prepare("SELECT * FROM studio_production_unit_revisions WHERE unit_id = ? AND revision > ? ORDER BY revision LIMIT ?")
        .all(unitId, after, limit + 1)) as unknown as UnitRevisionRow[];
    const selected = rows.slice(0, limit);
    return {
      items: selected.map((row) => unitRevisionSummaryFromRow(db, row)),
      nextCursor: rows.length > limit
        ? encodeCursor("unit-revisions", unitId, Number(selected[selected.length - 1]!.revision))
        : undefined,
    };
  } finally {
    db.close();
  }
}

function evidenceFromRows(rows: EvidenceRow[]): StudioContinuityEvidence[] {
  return rows.map((row) => ({
    index: Number(row.evidence_index),
    kind: row.kind,
    reference: row.reference,
    note: row.note,
  }));
}

function evidenceForAsset(
  db: DatabaseSync,
  unitId: string,
  unitRevision: number,
  panelIndex: number,
  assetId: string,
): StudioContinuityEvidence[] {
  const rows = db.prepare(`
    SELECT evidence_index, kind, reference, note
    FROM studio_production_continuity_evidence
    WHERE unit_id = ? AND unit_revision = ? AND panel_index = ? AND asset_id = ?
    ORDER BY evidence_index
  `).all(unitId, unitRevision, panelIndex, assetId) as unknown as EvidenceRow[];
  return evidenceFromRows(rows);
}

function panelSourceSpansFromRows(
  rows: PanelSourceSpanRow[],
  scriptRevision: StudioTextRevision,
  unitId: string,
  panelIndex: number,
): StudioProductionPanelSourceSpan[] {
  let previousEnd = -1;
  return rows.map((row, offset) => {
    if (Number(row.span_index) !== offset + 1) {
      throw new Error(`单元 ${unitId} 的 panel ${panelIndex} 剧本 source spans 顺序已损坏。`);
    }
    if (row.script_revision_id !== scriptRevision.id || row.script_sha256 !== scriptRevision.bodySha256) {
      throw new Error(`单元 ${unitId} 的 panel ${panelIndex} 剧本 source span 锚点已损坏。`);
    }
    const startOffsetUtf16 = Number(row.start_offset_utf16);
    const endOffsetUtf16 = Number(row.end_offset_utf16);
    const surface = assertUtf16Range(
      scriptRevision.body,
      startOffsetUtf16,
      endOffsetUtf16,
      `单元 ${unitId} panel ${panelIndex} sourceSpans[${offset}]`,
    );
    if (!surface.trim() || sha256(surface) !== row.surface_sha256) {
      throw new Error(`单元 ${unitId} 的 panel ${panelIndex} 剧本 source span SHA 已损坏。`);
    }
    if (offset > 0 && startOffsetUtf16 < previousEnd) {
      throw new Error(`单元 ${unitId} 的 panel ${panelIndex} 剧本 source spans 顺序已损坏。`);
    }
    previousEnd = endOffsetUtf16;
    return {
      scriptRevisionId: row.script_revision_id,
      scriptSha256: row.script_sha256,
      startOffsetUtf16,
      endOffsetUtf16,
      surfaceSha256: row.surface_sha256,
    };
  });
}

function portableRevisionIdentity(revision: StudioTextRevision): object {
  return {
    id: revision.id,
    documentId: revision.documentId,
    documentKind: revision.documentKind,
    ordinal: revision.ordinal,
    bodySha256: revision.bodySha256,
    bodySizeBytes: revision.bodySizeBytes,
    source: revision.source,
    sourceVersion: revision.sourceVersion,
  };
}

async function readStudioProductionUnitSnapshotFromDatabase(
  paths: Omit<StudioPaths, "storageIdentities">,
  db: DatabaseSync,
  unitId: string,
  unitRevision?: number,
): Promise<StudioProductionUnitSnapshot | null> {
  const normalizedUnitId = normalizeExistingId(unitId, "unitId");
  if (unitRevision !== undefined && (!Number.isSafeInteger(unitRevision) || unitRevision < 1)) {
    throw new Error("unitRevision 必须是正整数。");
  }
  let unit: StudioProductionUnitSummary | undefined;
  let scriptMetadata: StudioTextRevisionMetadata | undefined;
  let panelRows: PanelRow[] = [];
  const assetsByPanel = new Map<number, StudioPanelAssetMention[]>();
  const sourceSpanRowsByPanel = new Map<number, PanelSourceSpanRow[]>();
  const promptMetadataById = new Map<string, StudioTextRevisionMetadata>();
  const currentUnitRow = unitRowById(db, normalizedUnitId);
  if (!currentUnitRow) return null;
  if (unitRevision === undefined) {
    unit = unitSummaryFromRow(db, currentUnitRow);
  } else {
    const revisionRow = db.prepare(`SELECT * FROM studio_production_unit_revisions
        WHERE unit_id = ? AND revision = ?`).get(normalizedUnitId, unitRevision) as unknown as UnitRevisionRow | undefined;
    if (!revisionRow) return null;
    unit = unitSummaryFromRevisionRow(db, currentUnitRow, revisionRow);
  }
  const scriptRow = revisionRowById(db, unit.scriptRevisionId);
  if (!scriptRow || scriptRow.document_kind !== "script") throw new Error(`单元 ${unit.id} 的剧本修订无效。`);
  scriptMetadata = textRevisionMetadataFromRow(paths.root, scriptRow);
  panelRows = db.prepare(`
      SELECT * FROM studio_production_panels
      WHERE unit_id = ? AND unit_revision = ? ORDER BY panel_index
    `).all(unit.id, unit.revision) as unknown as PanelRow[];
  if (panelRows.length !== unit.panelCount) throw new Error(`单元 ${unit.id} 的宫格数据不完整。`);
  const sourceSpanRows = db.prepare(`
      SELECT * FROM studio_production_panel_source_spans
      WHERE unit_id = ? AND unit_revision = ? ORDER BY panel_index, span_index
    `).all(unit.id, unit.revision) as unknown as PanelSourceSpanRow[];
  const panelIndexes = new Set(panelRows.map((row) => Number(row.panel_index)));
  for (const row of sourceSpanRows) {
    const panelIndex = Number(row.panel_index);
    if (!panelIndexes.has(panelIndex)) throw new Error(`单元 ${unit.id} 的剧本 source span 指向不存在的 panel。`);
    sourceSpanRowsByPanel.set(panelIndex, [...(sourceSpanRowsByPanel.get(panelIndex) ?? []), row]);
  }
  for (const panelRow of panelRows) {
    const promptRow = revisionRowById(db, panelRow.prompt_revision_id);
    if (!promptRow || promptRow.document_kind !== "prompt") throw new Error(`宫格 ${panelRow.panel_id} 的提示词修订无效。`);
    promptMetadataById.set(promptRow.id, textRevisionMetadataFromRow(paths.root, promptRow));
    const assetRows = db.prepare(`
        SELECT * FROM studio_production_panel_assets
        WHERE unit_id = ? AND unit_revision = ? AND panel_index = ? ORDER BY asset_id
      `).all(unit.id, unit.revision, Number(panelRow.panel_index)) as unknown as AssetRow[];
    assetsByPanel.set(Number(panelRow.panel_index), assetRows.map((asset) => ({
      assetId: asset.asset_id,
      category: asset.category,
      presence: asset.presence,
      role: asset.role,
      continuityState: asset.continuity_state,
      evidence: evidenceForAsset(db, unit!.id, unit!.revision, Number(panelRow.panel_index), asset.asset_id),
    })));
  }
  const scriptRevision: StudioTextRevision = {
    ...scriptMetadata!,
    body: await readFrozenBody(scriptMetadata!),
  };
  const promptRevisions = new Map<string, StudioTextRevision>();
  await Promise.all([...promptMetadataById.entries()].map(async ([id, metadata]) => {
    promptRevisions.set(id, { ...metadata, body: await readFrozenBody(metadata) });
  }));
  const panels: StudioProductionPanel[] = panelRows.map((row) => ({
    id: row.panel_id,
    index: Number(row.panel_index),
    title: row.title,
    visualAction: row.visual_action,
    shotComposition: row.shot_composition,
    filmingMethod: row.filming_method,
    dialogue: row.dialogue,
    subtitle: row.subtitle,
    startSeconds: Number(row.start_ms) / 1_000,
    endSeconds: Number(row.end_ms) / 1_000,
    durationSeconds: Number(row.duration_ms) / 1_000,
    promptRevisionId: row.prompt_revision_id,
    promptRevision: promptRevisions.get(row.prompt_revision_id)!,
    sourceSpans: panelSourceSpansFromRows(
      sourceSpanRowsByPanel.get(Number(row.panel_index)) ?? [],
      scriptRevision,
      unit!.id,
      Number(row.panel_index),
    ),
    assets: assetsByPanel.get(Number(row.panel_index)) ?? [],
    // P20：旧行（迁移前）走默认值——original/空串，不进入任何指纹。
    transition: row.transition ?? "",
    costumeState: row.costume_state ?? "",
    sceneLighting: row.scene_lighting ?? "",
    shotType: row.shot_type === "extension" ? "extension" : "original",
    negativePrompt: row.negative_prompt ?? "",
  }));
  let cursor = 0;
  for (const panel of panels) {
    const start = secondsToMilliseconds(panel.startSeconds, "stored startSeconds");
    const end = secondsToMilliseconds(panel.endSeconds, "stored endSeconds");
    if (start !== cursor || end - start !== secondsToMilliseconds(panel.durationSeconds, "stored durationSeconds")) {
      throw new Error(`单元 ${unit!.id} 的宫格时间轴已损坏。`);
    }
    cursor = end;
  }
  const expectedDurationMilliseconds = secondsToMilliseconds(unit!.durationSeconds, "stored unit durationSeconds");
  if (cursor !== expectedDurationMilliseconds) {
    throw new Error(`单元 ${unit!.id} 未完整覆盖声明时长 ${unit!.durationSeconds} 秒。`);
  }
  const snapshot: StudioProductionUnitSnapshot = {
    schemaVersion: 2,
    kind: "studio-production-unit-snapshot",
    unit: unit!,
    scriptRevision,
    panels,
    fingerprint: "",
  };
  return { ...snapshot, fingerprint: createStudioProductionUnitFingerprint(snapshot) };
}

export async function readStudioProductionUnitSnapshot(
  projectRoot: string,
  unitId: string,
  unitRevision?: number,
): Promise<StudioProductionUnitSnapshot | null> {
  const paths = await ensureProductionDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    return await readStudioProductionUnitSnapshotFromDatabase(paths, db, unitId, unitRevision);
  } finally {
    db.close();
  }
}

function assertStudioProductionUnitSnapshotReadOnlySchema(db: DatabaseSync): void {
  const version = db.prepare(
    "SELECT value FROM studio_production_meta WHERE key = 'schema_version'",
  ).get() as { value?: string } | undefined;
  if (version?.value !== String(SCHEMA_VERSION)) {
    throw new Error(`Studio production unit 只读快照要求 schema v${SCHEMA_VERSION}。`);
  }
  const requiredTables = [
    "studio_production_meta",
    "studio_text_documents",
    "studio_text_revisions",
    "studio_production_units",
    "studio_production_unit_revisions",
    "studio_production_unit_timings",
    "studio_production_panels",
    "studio_production_panel_source_spans",
    "studio_production_panel_assets",
    "studio_production_continuity_evidence",
  ];
  const rows = db.prepare(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name IN (${requiredTables.map(() => "?").join(",")})`,
  ).all(...requiredTables) as Array<{ name: string; sql: string }>;
  const strict = new Set(rows
    .filter((row) => /\bSTRICT\s*;?\s*$/iu.test(row.sql ?? ""))
    .map((row) => row.name));
  const missing = requiredTables.filter((table) => !strict.has(table));
  if (missing.length > 0) {
    throw new Error(`Studio production unit 只读快照缺少严格表：${missing.join(", ")}。`);
  }
}

/**
 * Crash/replay proof 专用：不 ensure 目录、不打开 live SQLite，只读取物理快照与不可变 CAS。
 */
export async function readStudioProductionUnitSnapshotReadOnly(
  projectRoot: string,
  unitId: string,
  unitRevision?: number,
): Promise<StudioProductionUnitSnapshot | null> {
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const paths = productionPaths(shell.paths.root);
  let snapshot: Awaited<ReturnType<typeof openSqliteReadOnlySnapshot>> | null = null;
  try {
    snapshot = await openSqliteReadOnlySnapshot(paths.database, "studio production unit snapshot");
    assertStudioProductionUnitSnapshotReadOnlySchema(snapshot.database);
    return await readStudioProductionUnitSnapshotFromDatabase(paths, snapshot.database, unitId, unitRevision);
  } finally {
    await snapshot?.close();
  }
}

/**
 * 单元 snapshot 指纹：unit head 元数据（revision/updatedAt）按设计进入；P20 的 5 个 panel 字段不进入。
 * 与 readStudioProductionUnitSnapshot 使用同一 payload 实现，供测试与外部复核直接调用。
 */
export function createStudioProductionUnitFingerprint(snapshot: StudioProductionUnitSnapshot): string {
  const fingerprintPayload = {
    // P30 episode offset 是 current episode 的派生投影，不进入历史 unit 内容身份。
    // 显式保持 P24 既有字段与顺序，确保所有 legacy 15 秒 snapshot 指纹不变。
    unit: {
      id: snapshot.unit.id,
      season: snapshot.unit.season,
      seasonOrigin: snapshot.unit.seasonOrigin,
      episode: snapshot.unit.episode,
      sequence: snapshot.unit.sequence,
      title: snapshot.unit.title,
      revision: snapshot.unit.revision,
      durationSeconds: snapshot.unit.durationSeconds,
      panelCount: snapshot.unit.panelCount,
      scriptRevisionId: snapshot.unit.scriptRevisionId,
      createdAt: snapshot.unit.createdAt,
      updatedAt: snapshot.unit.updatedAt,
    },
    scriptRevision: portableRevisionIdentity(snapshot.scriptRevision),
    panels: snapshot.panels.map((panel) => ({
      id: panel.id,
      index: panel.index,
      title: panel.title,
      visualAction: panel.visualAction,
      shotComposition: panel.shotComposition,
      filmingMethod: panel.filmingMethod,
      dialogue: panel.dialogue,
      subtitle: panel.subtitle,
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
      durationSeconds: panel.durationSeconds,
      promptRevision: portableRevisionIdentity(panel.promptRevision),
      sourceSpans: panel.sourceSpans,
      assets: panel.assets,
    })),
  };
  return createHash("sha256").update(JSON.stringify(fingerprintPayload)).digest("hex");
}

export async function getStudioProductionUnitSnapshot(
  projectRoot: string,
  unitId: string,
): Promise<StudioProductionUnitSnapshot | null> {
  return readStudioProductionUnitSnapshot(projectRoot, unitId);
}

/**
 * 由 Core 按 current 生产时间线解析同季同集 successor。UI 不得用可见数组、
 * 分页或固定节点顺序猜“下一镜”。
 */
export async function getStudioCanonicalSuccessorUnitIds(
  projectRoot: string,
  unitIds: string[],
): Promise<Record<string, string | null>> {
  const normalized = [...new Set(unitIds.map((unitId) => normalizeExistingId(unitId, "unitId")))];
  if (normalized.length === 0) return {};
  if (normalized.length > 100) throw new Error("单次 successor 查询最多 100 个单元。");
  const paths = await ensureProductionDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    recordStudioUnitsReadCounter("successorQueries");
    recordStudioUnitsReadCounter("productionBusinessSqlExecutions");
    const placeholders = normalized.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT current.id AS unit_id, (
        SELECT successor.id
        FROM studio_production_units successor
        WHERE successor.season=current.season
          AND successor.episode=current.episode
          AND successor.sequence>current.sequence
        ORDER BY successor.sequence ASC, successor.id ASC
        LIMIT 1
      ) AS successor_id
      FROM studio_production_units current
      WHERE current.id IN (${placeholders})
    `).all(...normalized) as unknown as Array<{ unit_id: string; successor_id: string | null }>;
    const byId: Record<string, string | null> = Object.fromEntries(normalized.map((unitId) => [unitId, null]));
    for (const row of rows) byId[row.unit_id] = row.successor_id;
    return byId;
  } finally {
    db.close();
  }
}

/**
 * 由 Core 按 current 生产时间线解析同季同集 predecessor。与 successor 查询
 * 对称；UI/聚合投影不得用分页结果或 sequence-1 猜“上一镜”。
 */
export async function getStudioCanonicalPredecessorUnitIds(
  projectRoot: string,
  unitIds: string[],
): Promise<Record<string, string | null>> {
  const normalized = [...new Set(unitIds.map((unitId) => normalizeExistingId(unitId, "unitId")))];
  if (normalized.length === 0) return {};
  if (normalized.length > 100) throw new Error("单次 predecessor 查询最多 100 个单元。");
  const paths = await ensureProductionDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    const placeholders = normalized.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT current.id AS unit_id, (
        SELECT predecessor.id
        FROM studio_production_units predecessor
        WHERE predecessor.season=current.season
          AND predecessor.episode=current.episode
          AND predecessor.sequence<current.sequence
        ORDER BY predecessor.sequence DESC, predecessor.id DESC
        LIMIT 1
      ) AS predecessor_id
      FROM studio_production_units current
      WHERE current.id IN (${placeholders})
    `).all(...normalized) as unknown as Array<{ unit_id: string; predecessor_id: string | null }>;
    const byId: Record<string, string | null> = Object.fromEntries(normalized.map((unitId) => [unitId, null]));
    for (const row of rows) byId[row.unit_id] = row.predecessor_id;
    return byId;
  } finally {
    db.close();
  }
}

/**
 * 只内容寻址会影响目标 panel BindingSet 语义的范围。
 * 单元 revision/时间戳与其他 panel 不进入该指纹。
 */
export function createStudioPanelBindingScopeFingerprint(
  snapshot: StudioProductionUnitSnapshot,
  panelIndex: number,
): string {
  if (!Number.isSafeInteger(panelIndex) || panelIndex < 1 || panelIndex > STUDIO_PRODUCTION_MAX_PANEL_COUNT) {
    throw new Error("panelIndex 无效。");
  }
  const panel = snapshot.panels.find((item) => item.index === panelIndex);
  if (!panel) throw new Error(`面板不存在：${snapshot.unit.id}#${panelIndex}`);
  return sha256(stableJson({
    schemaVersion: 1,
    kind: "studio-panel-binding-scope",
    unit: {
      id: snapshot.unit.id,
      season: snapshot.unit.season,
      episode: snapshot.unit.episode,
      sequence: snapshot.unit.sequence,
      title: snapshot.unit.title,
      durationSeconds: snapshot.unit.durationSeconds,
      panelCount: snapshot.unit.panelCount,
      scriptRevision: portableRevisionIdentity(snapshot.scriptRevision),
    },
    panel: {
      id: panel.id,
      index: panel.index,
      title: panel.title,
      visualAction: panel.visualAction,
      shotComposition: panel.shotComposition,
      filmingMethod: panel.filmingMethod,
      dialogue: panel.dialogue,
      subtitle: panel.subtitle,
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
      durationSeconds: panel.durationSeconds,
      promptRevision: portableRevisionIdentity(panel.promptRevision),
      sourceSpans: panel.sourceSpans,
      assets: panel.assets,
    },
  }));
}

/** 可对当前 head（省略 unitRevision）或任一不可变历史 unit revision 计算同一 scope 指纹。 */
export async function getStudioPanelBindingScopeFingerprint(
  projectRoot: string,
  unitId: string,
  panelIndex: number,
  unitRevision?: number,
): Promise<string | null> {
  const snapshot = await readStudioProductionUnitSnapshot(projectRoot, unitId, unitRevision);
  if (!snapshot || !snapshot.panels.some((panel) => panel.index === panelIndex)) return null;
  return createStudioPanelBindingScopeFingerprint(snapshot, panelIndex);
}

/** 命名明确的 Codex 包适配层入口；不扫描项目目录。P24：可选 unitRevision 透传历史快照（缺省=head 现行为，向后兼容）。 */
export async function readStudioProductionUnitSnapshotForCodex(
  projectRoot: string,
  unitId: string,
  unitRevision?: number,
): Promise<StudioProductionUnitSnapshot | null> {
  if (unitRevision !== undefined) return readStudioProductionUnitSnapshot(projectRoot, unitId, unitRevision);
  return getStudioProductionUnitSnapshot(projectRoot, unitId);
}

/* ------------------------------------------------------------------------ */
/* P24：追溯查询只读导出（纯 SELECT 追加，规范 §2.4 逃生门；不动写路径）      */
/* ------------------------------------------------------------------------ */

/** 按剧本 revision 反查单元修订（impact 首跳；script_revision_id 无索引——rowid 键集分页的有界扫描诊断查询）。 */
export interface StudioUnitRevisionByScriptRecord {
  unitId: string;
  revision: number;
  season: string;
  episode: string;
  sequence: number;
  title: string;
  panelCount: number;
  scriptRevisionId: string;
  createdAt: string;
}

interface UnitRevisionByScriptRow {
  unit_id: string;
  revision: number;
  season: string;
  episode: string;
  sequence: number;
  title: string;
  duration_ms: number;
  panel_count: number;
  script_revision_id: string;
  created_at: string;
}

export async function listStudioUnitRevisionsByScriptRevision(
  projectRoot: string,
  query: { scriptRevisionId: string; limit?: number; cursor?: string },
): Promise<{ items: StudioUnitRevisionByScriptRecord[]; nextCursor?: string }> {
  const paths = await ensureProductionDirectories(projectRoot);
  const scriptRevisionId = normalizeExistingId(query.scriptRevisionId, "scriptRevisionId");
  const limit = normalizeLimit(query.limit);
  const afterKey = decodeStringCursor(query.cursor, "unit-revisions-by-script-revision", scriptRevisionId);
  const after = afterKey === undefined ? undefined : afterKey.split("\u0000");
  if (after !== undefined && (after.length !== 2 || !after[0] || !/^[1-9]\d{0,9}$/u.test(after[1] ?? ""))) {
    throw new Error("分页 cursor 键无效。");
  }
  const db = openDatabase(paths.database);
  try {
    const rows = (after === undefined
      ? db.prepare(`
          SELECT * FROM studio_production_unit_revisions
          WHERE script_revision_id = ? ORDER BY unit_id, revision LIMIT ?
        `).all(scriptRevisionId, limit + 1)
      : db.prepare(`
          SELECT * FROM studio_production_unit_revisions
          WHERE script_revision_id = ? AND (unit_id > ? OR (unit_id = ? AND revision > ?))
          ORDER BY unit_id, revision LIMIT ?
        `).all(scriptRevisionId, after[0]!, after[0]!, Number(after[1]), limit + 1)) as unknown as UnitRevisionByScriptRow[];
    const selected = rows.slice(0, limit);
    return {
      items: selected.map((row) => ({
        unitId: row.unit_id,
        revision: Number(row.revision),
        season: row.season,
        episode: row.episode,
        sequence: Number(row.sequence),
        title: row.title,
        panelCount: Number(row.panel_count),
        scriptRevisionId: row.script_revision_id,
        createdAt: row.created_at,
      })),
      nextCursor: rows.length > limit
        ? encodeCursor("unit-revisions-by-script-revision", scriptRevisionId, `${selected[selected.length - 1]!.unit_id}\u0000${selected[selected.length - 1]!.revision}`)
        : undefined,
    };
  } finally {
    db.close();
  }
}

interface TimelineCursorKey {
  sequence: number;
  unitId: string;
  panelIndex: number;
}

function decodeTimelineCursor(cursor: string | undefined, assetId: string): TimelineCursorKey | undefined {
  const key = decodeCursor(cursor, "asset-timeline", assetId);
  if (key === undefined) return undefined;
  if (!key || typeof key !== "object") throw new Error("分页 cursor 键无效。");
  const candidate = key as Partial<TimelineCursorKey>;
  if (!Number.isSafeInteger(candidate.sequence)
    || Number(candidate.sequence) < 1
    || typeof candidate.unitId !== "string"
    || !candidate.unitId
    || !Number.isSafeInteger(candidate.panelIndex)
    || Number(candidate.panelIndex) < 1) {
    throw new Error("分页 cursor 键无效。");
  }
  return {
    sequence: Number(candidate.sequence),
    unitId: candidate.unitId,
    panelIndex: Number(candidate.panelIndex),
  };
}

export async function queryStudioAssetTimeline(
  projectRoot: string,
  query: StudioAssetTimelineQuery,
): Promise<StudioAssetTimelinePage> {
  const paths = await ensureProductionDirectories(projectRoot);
  const assetId = normalizeExistingId(query.assetId, "assetId");
  const limit = normalizeLimit(query.limit);
  const after = decodeTimelineCursor(query.cursor, assetId);
  const db = openDatabase(paths.database);
  try {
    const select = `
      SELECT pa.*, u.season, u.episode, u.title AS unit_title,
             p.panel_id, p.title AS panel_title, p.start_ms, p.end_ms,
             COALESCE((
               SELECT COALESCE(SUM(COALESCE(previous_timing.duration_ms, previous.duration_ms)), 0)
                    + ((u.sequence - 1 - COUNT(*)) * ${UNIT_DURATION_MILLISECONDS})
               FROM studio_production_units previous
               LEFT JOIN studio_production_unit_timings previous_timing
                 ON previous_timing.unit_id = previous.id
                AND previous_timing.unit_revision = previous.revision
               WHERE previous.season = u.season
                 AND previous.episode = u.episode
                 AND previous.sequence < u.sequence
             ), 0) AS episode_start_ms
      FROM studio_production_panel_assets pa
      JOIN studio_production_units u
        ON u.id = pa.unit_id AND u.revision = pa.unit_revision
      JOIN studio_production_panels p
        ON p.unit_id = pa.unit_id
       AND p.unit_revision = pa.unit_revision
       AND p.panel_index = pa.panel_index
      WHERE pa.asset_id = ?`;
    const rows = (after
      ? db.prepare(`${select}
          AND (
            pa.unit_sequence > ?
            OR (pa.unit_sequence = ? AND pa.unit_id > ?)
            OR (pa.unit_sequence = ? AND pa.unit_id = ? AND pa.panel_index > ?)
          )
          ORDER BY pa.unit_sequence, pa.unit_id, pa.panel_index LIMIT ?
        `).all(
          assetId,
          after.sequence,
          after.sequence,
          after.unitId,
          after.sequence,
          after.unitId,
          after.panelIndex,
          limit + 1,
        )
      : db.prepare(`${select}
          ORDER BY pa.unit_sequence, pa.unit_id, pa.panel_index LIMIT ?
        `).all(assetId, limit + 1)) as unknown as TimelineRow[];
    const selected = rows.slice(0, limit);
    const items = selected.map((row): StudioAssetTimelineItem => ({
      assetId: row.asset_id,
      category: row.category,
      presence: row.presence,
      role: row.role,
      continuityState: row.continuity_state,
      evidence: evidenceForAsset(db, row.unit_id, Number(row.unit_revision), Number(row.panel_index), row.asset_id),
      unitId: row.unit_id,
      unitRevision: Number(row.unit_revision),
      season: row.season,
      seasonOrigin: seasonOrigin(row.season),
      episode: row.episode,
      unitSequence: Number(row.unit_sequence),
      unitTitle: row.unit_title,
      panelId: row.panel_id,
      panelIndex: Number(row.panel_index),
      panelTitle: row.panel_title,
      startSeconds: Number(row.start_ms) / 1_000,
      endSeconds: Number(row.end_ms) / 1_000,
      episodeAbsoluteStartSeconds: (Number(row.episode_start_ms) + Number(row.start_ms)) / 1_000,
      episodeAbsoluteEndSeconds: (Number(row.episode_start_ms) + Number(row.end_ms)) / 1_000,
    }));
    const last = selected[selected.length - 1];
    return {
      items,
      nextCursor: rows.length > limit && last
        ? encodeCursor("asset-timeline", assetId, {
          sequence: Number(last.unit_sequence),
          unitId: last.unit_id,
          panelIndex: Number(last.panel_index),
        })
        : undefined,
    };
  } finally {
    db.close();
  }
}

function stableJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, entry]) => [key, normalize(entry)]));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertSha256(value: string, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${field} 必须是小写 SHA-256。`);
  return value;
}

function normalizeIdentityKey(value: string): string {
  return normalizeStudioIdentityKey(requiredText(value, "identity", 1_000));
}

export function assertUtf16Range(body: string, start: number, end: number, field: string): string {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > body.length) {
    throw new Error(`${field} UTF-16 范围无效。`);
  }
  return body.slice(start, end);
}

function sectionFromRow(row: Record<string, unknown>): StudioScriptSectionRevision {
  return {
    id: String(row.id),
    sectionId: String(row.section_id),
    revision: Number(row.revision),
    kind: String(row.kind) as StudioScriptSectionKind,
    title: String(row.title),
    scriptRevisionId: String(row.script_revision_id),
    scriptSha256: String(row.script_sha256),
    startOffsetUtf16: Number(row.start_offset_utf16),
    endOffsetUtf16: Number(row.end_offset_utf16),
    surfaceSha256: String(row.surface_sha256),
    fingerprint: String(row.fingerprint),
    createdAt: String(row.created_at),
  };
}

interface NormalizedStudioScriptSectionDraft {
  paths: StudioPaths;
  sectionId: string;
  expectedRevision: number;
  kind: StudioScriptSectionKind;
  title: string;
  scriptRevisionId: string;
  scriptDocumentId: string;
  scriptSha256: string;
  startOffsetUtf16: number;
  endOffsetUtf16: number;
  surfaceSha256: string;
  fingerprint: string;
  id: string;
}

async function normalizeStudioScriptSectionDraft(
  projectRoot: string,
  input: AppendStudioScriptSectionRevisionInput,
): Promise<NormalizedStudioScriptSectionDraft> {
  const paths = await ensureProductionDirectories(projectRoot);
  const sectionId = normalizeExistingId(input.sectionId, "sectionId");
  assertExpectedRevision(input.expectedRevision, 0);
  const kind = input.kind;
  if (kind !== "chapter" && kind !== "scene") throw new Error("section kind 必须是 chapter 或 scene。");
  const title = requiredText(input.title, "section title", 500);
  const scriptRevisionId = normalizeExistingId(input.scriptRevisionId, "scriptRevisionId");
  const scriptSha256 = assertSha256(input.scriptSha256, "scriptSha256");
  const script = await getStudioTextRevision(paths.root, scriptRevisionId);
  if (!script || script.documentKind !== "script") throw new Error(`剧本修订不存在：${scriptRevisionId}`);
  if (script.bodySha256 !== scriptSha256) throw new Error("scriptRevisionId 与 scriptSha256 不一致。");
  const surface = assertUtf16Range(script.body, input.startOffsetUtf16, input.endOffsetUtf16, "section");
  const semantic = {
    sectionId,
    kind,
    title,
    scriptRevisionId,
    scriptSha256,
    startOffsetUtf16: input.startOffsetUtf16,
    endOffsetUtf16: input.endOffsetUtf16,
    surfaceSha256: sha256(surface),
  };
  const fingerprint = sha256(stableJson(semantic));
  return {
    paths,
    sectionId,
    expectedRevision: input.expectedRevision,
    kind,
    title,
    scriptRevisionId,
    scriptDocumentId: script.documentId,
    scriptSha256,
    startOffsetUtf16: input.startOffsetUtf16,
    endOffsetUtf16: input.endOffsetUtf16,
    surfaceSha256: semantic.surfaceSha256,
    fingerprint,
    id: `script-section-${fingerprint.slice(0, 40)}`,
  };
}

function assertStudioScriptSectionLineage(
  db: DatabaseSync,
  draft: NormalizedStudioScriptSectionDraft,
): void {
  const lineages = db.prepare(`SELECT DISTINCT r.kind, t.document_id
    FROM studio_script_section_revisions r
    JOIN studio_text_revisions t ON t.id = r.script_revision_id
    WHERE r.section_id = ?
    ORDER BY r.kind, t.document_id
    LIMIT 2`).all(draft.sectionId) as unknown as Array<{ kind: string; document_id: string }>;
  if (lineages.length > 1) {
    throw new StudioScriptSectionLineageError(
      draft.sectionId,
      "lineage-corrupt",
      "single-kind-and-script-document",
      "multiple-lineages",
      `sectionId ${draft.sectionId} 的历史 lineage 已不唯一；拒绝继续追加。`,
    );
  }
  const lineage = lineages[0];
  if (!lineage) return;
  if (lineage.kind !== draft.kind) {
    throw new StudioScriptSectionLineageError(
      draft.sectionId,
      "kind",
      lineage.kind,
      draft.kind,
      `sectionId ${draft.sectionId} 的 kind 已固定为 ${lineage.kind}，禁止改为 ${draft.kind}。`,
    );
  }
  if (lineage.document_id !== draft.scriptDocumentId) {
    throw new StudioScriptSectionLineageError(
      draft.sectionId,
      "script-document",
      lineage.document_id,
      draft.scriptDocumentId,
      `sectionId ${draft.sectionId} 必须始终属于同一 script document（${lineage.document_id}）。`,
    );
  }
}

export async function getStudioScriptSectionRevision(
  projectRoot: string,
  revisionId: string,
): Promise<StudioScriptSectionRevision | null> {
  const paths = await ensureProductionDirectories(projectRoot);
  const id = normalizeExistingId(revisionId, "revisionId");
  const db = openDatabase(paths.database);
  try {
    const row = db.prepare("SELECT * FROM studio_script_section_revisions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? sectionFromRow(row) : null;
  } finally {
    db.close();
  }
}

export async function appendStudioScriptSectionRevision(
  projectRoot: string,
  input: AppendStudioScriptSectionRevisionInput,
): Promise<StudioScriptSectionRevision> {
  const draft = await normalizeStudioScriptSectionDraft(projectRoot, input);
  const db = openDatabase(draft.paths.database);
  try {
    return runTransaction(db, () => {
      assertStudioScriptSectionLineage(db, draft);
      const existing = db.prepare("SELECT * FROM studio_script_section_revisions WHERE id = ?").get(draft.id) as Record<string, unknown> | undefined;
      const head = db.prepare("SELECT revision, revision_id FROM studio_script_section_heads WHERE section_id = ?").get(draft.sectionId) as { revision: number; revision_id: string } | undefined;
      const actualRevision = Number(head?.revision ?? 0);
      if (existing && head?.revision_id === draft.id) return sectionFromRow(existing);
      if (actualRevision !== draft.expectedRevision) throw new StudioProductionConflictError(draft.sectionId, draft.expectedRevision, actualRevision);
      if (existing) throw new Error("相同章节内容已存在，但不是当前 Head；禁止历史 Head 回退。");
      const revision = draft.expectedRevision + 1;
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO studio_script_section_revisions(
        id, section_id, revision, kind, title, script_revision_id, script_sha256,
        start_offset_utf16, end_offset_utf16, surface_sha256, fingerprint, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        draft.id, draft.sectionId, revision, draft.kind, draft.title, draft.scriptRevisionId, draft.scriptSha256,
        draft.startOffsetUtf16, draft.endOffsetUtf16, draft.surfaceSha256, draft.fingerprint, now,
      );
      if (head) {
        const updated = db.prepare(`UPDATE studio_script_section_heads
          SET revision = ?, revision_id = ?, updated_at = ? WHERE section_id = ? AND revision = ?`)
          .run(revision, draft.id, now, draft.sectionId, draft.expectedRevision);
        if (Number(updated.changes) !== 1) throw new StudioProductionConflictError(draft.sectionId, draft.expectedRevision, actualRevision);
      } else {
        db.prepare("INSERT INTO studio_script_section_heads(section_id, revision, revision_id, updated_at) VALUES(?, 1, ?, ?)")
          .run(draft.sectionId, draft.id, now);
      }
      return sectionFromRow(db.prepare("SELECT * FROM studio_script_section_revisions WHERE id = ?").get(draft.id) as Record<string, unknown>);
    });
  } finally {
    db.close();
  }
}

/**
 * 命令崩溃恢复只读取不可变 revision 行，不重放 append，也不要求该 revision
 * 仍为当前 Head；之后合法追加的新 Head 不应抹去已提交命令的证据。
 */
export async function proveStudioScriptSectionRevisionAppend(
  projectRoot: string,
  input: AppendStudioScriptSectionRevisionInput,
): Promise<StudioScriptSectionRevision | null> {
  const draft = await normalizeStudioScriptSectionDraft(projectRoot, input);
  const db = openDatabase(draft.paths.database);
  try {
    const row = db.prepare(`SELECT * FROM studio_script_section_revisions
      WHERE section_id = ? AND revision = ?`).get(
      draft.sectionId,
      draft.expectedRevision + 1,
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    const section = sectionFromRow(row);
    return section.id === draft.id && section.fingerprint === draft.fingerprint ? section : null;
  } finally {
    db.close();
  }
}

export async function listStudioScriptSections(
  projectRoot: string,
  query: StudioScriptSectionListQuery = {},
): Promise<StudioScriptSectionPage> {
  const paths = await ensureProductionDirectories(projectRoot);
  const limit = normalizeLimit(query.limit);
  const scriptRevisionId = query.scriptRevisionId === undefined ? undefined : normalizeExistingId(query.scriptRevisionId, "scriptRevisionId");
  const db = openDatabase(paths.database);
  try {
    let scriptDocumentId: string | undefined;
    if (scriptRevisionId) {
      const anchor = revisionRowById(db, scriptRevisionId);
      if (!anchor || anchor.document_kind !== "script") throw new Error(`剧本修订不存在：${scriptRevisionId}`);
      scriptDocumentId = anchor.document_id;
    }
    const scope = scriptDocumentId ? `script-document:${scriptDocumentId}` : "*";
    const after = decodeStringCursor(query.cursor, "script-sections", scope);
    const rows = db.prepare(`SELECT r.* FROM studio_script_section_heads h
      JOIN studio_script_section_revisions r ON r.id = h.revision_id
      JOIN studio_text_revisions script ON script.id = r.script_revision_id
      WHERE (? IS NULL OR script.document_id = ?) AND (? IS NULL OR r.id > ?)
      ORDER BY r.id LIMIT ?`).all(
        scriptDocumentId ?? null, scriptDocumentId ?? null, after ?? null, after ?? null, limit + 1,
      ) as unknown as Array<Record<string, unknown>>;
    const selected = rows.slice(0, limit);
    return {
      items: selected.map(sectionFromRow),
      nextCursor: rows.length > limit ? encodeCursor("script-sections", scope, String(selected[selected.length - 1]!.id)) : undefined,
    };
  } finally {
    db.close();
  }
}

interface NormalizedResolvableAsset {
  assetId: string;
  category: StudioAssetCategory;
  formalName: string;
  aliases: string[];
}

function normalizeResolvableAssets(assets: StudioMentionResolvableAsset[]): NormalizedResolvableAsset[] {
  if (!Array.isArray(assets) || assets.length > 100_000) throw new Error("assets 必须是最多 100000 项的数组。");
  const ids = new Set<string>();
  return assets.map((asset) => {
    const assetId = normalizeExistingId(asset.assetId, "assetId");
    if (ids.has(assetId)) throw new Error(`规范资产 ID 重复：${assetId}`);
    ids.add(assetId);
    const category = normalizeAssetCategory(asset.category);
    const formalName = requiredText(asset.formalName, "formalName", 1_000);
    const aliases = [...new Set((asset.aliases ?? []).map((alias) => requiredText(alias, "alias", 1_000)))]
      .sort((left, right) => left.localeCompare(right, "zh-CN"));
    return { assetId, category, formalName, aliases };
  }).sort((left, right) => left.assetId.localeCompare(right.assetId, "en"));
}

function exactCandidatesForIdentity(
  surfaceText: string,
  category: StudioAssetCategory | undefined,
  assets: NormalizedResolvableAsset[],
): StudioAssetMentionCandidate[] {
  const key = normalizeIdentityKey(surfaceText);
  const tiers: Array<{ kind: Exclude<StudioMentionCandidateKind, "model">; values: (asset: NormalizedResolvableAsset) => string[] }> = [
    { kind: "id", values: (asset) => [asset.assetId] },
    { kind: "formal-name", values: (asset) => [asset.formalName] },
    { kind: "alias", values: (asset) => asset.aliases },
  ];
  for (const tier of tiers) {
    const matches = assets.flatMap((asset) => {
      if (category && asset.category !== category) return [];
      const matchedValue = tier.values(asset)
        .filter((value) => normalizeIdentityKey(value) === key)
        .sort((left, right) => left.localeCompare(right, "zh-CN"))[0];
      return matchedValue === undefined ? [] : [{
        rank: 0,
        kind: tier.kind,
        assetId: asset.assetId,
        category: asset.category,
        matchedValue,
      } satisfies StudioAssetMentionCandidate];
    }).sort((left, right) => left.assetId.localeCompare(right.assetId, "en"));
    if (matches.length > 0) return matches.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  }
  return [];
}

export function exactCandidatesFromIdentityIndex(
  surfaceText: string,
  category: StudioAssetCategory | undefined,
  entries: StudioIdentityIndexEntry[],
): StudioAssetMentionCandidate[] {
  const key = normalizeIdentityKey(surfaceText);
  const order: Array<Exclude<StudioMentionCandidateKind, "model">> = ["id", "formal-name", "alias"];
  for (const kind of order) {
    const byAsset = new Map<string, StudioAssetMentionCandidate>();
    for (const entry of entries) {
      if (entry.normalizedKey !== key || entry.matchKind !== kind || (category && entry.category !== category)) continue;
      const previous = byAsset.get(entry.assetId);
      if (!previous || entry.matchedValue.localeCompare(previous.matchedValue, "zh-CN") < 0) {
        byAsset.set(entry.assetId, {
          rank: 0,
          kind,
          assetId: entry.assetId,
          category: entry.category,
          matchedValue: entry.matchedValue,
        });
      }
    }
    const selected = [...byAsset.values()].sort((left, right) => left.assetId.localeCompare(right.assetId, "en"));
    if (selected.length > 0) return selected.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  }
  return [];
}

function identityCandidateSetFingerprint(
  surfaceText: string,
  category: StudioAssetCategory | undefined,
  exact: StudioAssetMentionCandidate[],
): string {
  return sha256(stableJson({
    normalizedIdentityKey: normalizeIdentityKey(surfaceText),
    category: category ?? null,
    candidates: exact.map(({ rank: _rank, ...candidate }) => candidate),
  }));
}

export function computeStudioMentionIdentityKeyFingerprint(
  surfaceText: string,
  category: StudioAssetCategory | undefined,
  assets: StudioMentionResolvableAsset[],
): string {
  const normalizedAssets = normalizeResolvableAssets(assets);
  const normalizedCategory = category === undefined ? undefined : normalizeAssetCategory(category);
  const candidates = exactCandidatesForIdentity(surfaceText, normalizedCategory, normalizedAssets)
    .map(({ rank: _rank, ...candidate }) => candidate);
  return identityCandidateSetFingerprint(surfaceText, normalizedCategory, candidates.map((candidate, index) => ({ ...candidate, rank: index + 1 })));
}

/** 从 material-studio 精确等值索引读取单键候选身份；不执行 LIKE/search。 */
export async function getStudioMentionIdentityKeyFingerprint(
  projectRoot: string,
  surfaceText: string,
  category?: StudioAssetCategory,
): Promise<string> {
  const normalizedCategory = category === undefined ? undefined : normalizeAssetCategory(category);
  const snapshot = await getStudioIdentityIndexSnapshot(projectRoot, [surfaceText]);
  const exact = exactCandidatesFromIdentityIndex(surfaceText, normalizedCategory, snapshot.entries);
  return identityCandidateSetFingerprint(surfaceText, normalizedCategory, exact);
}

function candidateFromRow(row: Record<string, unknown>): StudioAssetMentionCandidate {
  return {
    rank: Number(row.rank),
    kind: String(row.kind) as StudioMentionCandidateKind,
    assetId: String(row.asset_id),
    category: String(row.category) as StudioAssetCategory,
    matchedValue: String(row.matched_value),
  };
}

function proposalFromRow(db: DatabaseSync, row: Record<string, unknown>): StudioAssetMentionProposal {
  const candidates = db.prepare("SELECT * FROM studio_asset_mention_candidates WHERE proposal_id = ? ORDER BY rank")
    .all(String(row.id)) as unknown as Array<Record<string, unknown>>;
  return {
    id: String(row.id),
    mentionId: String(row.mention_id),
    surfaceText: String(row.surface_text),
    startOffsetUtf16: Number(row.start_offset_utf16),
    endOffsetUtf16: Number(row.end_offset_utf16),
    surfaceSha256: String(row.surface_sha256),
    ...(row.section_revision_id ? { sectionRevisionId: String(row.section_revision_id) } : {}),
    ...(row.category ? { category: String(row.category) as StudioAssetCategory } : {}),
    presence: String(row.presence) as StudioAssetPresence,
    role: String(row.role),
    status: String(row.status) as StudioMentionStatus,
    normalizedIdentityKey: String(row.normalized_identity_key),
    candidateSetFingerprint: String(row.candidate_set_fingerprint),
    candidates: candidates.map(candidateFromRow),
    fingerprint: String(row.fingerprint),
    createdAt: String(row.created_at),
  };
}

function analysisFromRow(db: DatabaseSync, row: Record<string, unknown>): StudioAssetMentionAnalysis {
  const proposalRows = db.prepare("SELECT * FROM studio_asset_mention_proposals WHERE analysis_id = ? ORDER BY mention_id")
    .all(String(row.id)) as unknown as Array<Record<string, unknown>>;
  return {
    schemaVersion: 1,
    kind: "studio-asset-mention-analysis",
    id: String(row.id),
    revision: Number(row.revision),
    unitId: String(row.unit_id),
    unitRevision: Number(row.unit_revision),
    unitFingerprint: String(row.unit_fingerprint),
    panelIndex: Number(row.panel_index),
    scriptRevisionId: String(row.script_revision_id),
    scriptSha256: String(row.script_sha256),
    resolverVersion: String(row.resolver_version),
    proposals: proposalRows.map((proposal) => proposalFromRow(db, proposal)),
    fingerprint: String(row.fingerprint),
    createdAt: String(row.created_at),
  };
}

export async function analyzeStudioPanelAssetMentions(
  projectRoot: string,
  input: AnalyzeStudioPanelAssetMentionsInput,
  operationContext?: StudioBindingAtomicReceiptContext<StudioAssetMentionAnalysis>,
): Promise<StudioAssetMentionAnalysis> {
  const paths = await ensureProductionDirectories(projectRoot);
  const unitId = normalizeExistingId(input.unitId, "unitId");
  assertExpectedRevision(input.expectedHeadRevision, 0);
  if (!Number.isSafeInteger(input.unitRevision) || input.unitRevision < 1) throw new Error("unitRevision 无效。");
  if (!Number.isSafeInteger(input.panelIndex) || input.panelIndex < 1 || input.panelIndex > STUDIO_PRODUCTION_MAX_PANEL_COUNT) throw new Error("panelIndex 无效。");
  const unitFingerprint = assertSha256(input.unitFingerprint, "unitFingerprint");
  const scriptRevisionId = normalizeExistingId(input.scriptRevisionId, "scriptRevisionId");
  const scriptSha = assertSha256(input.scriptSha256, "scriptSha256");
  const resolverVersion = requiredText(input.resolverVersion ?? "exact-identity-v1", "resolverVersion", 200);
  const snapshot = await getStudioProductionUnitSnapshot(paths.root, unitId);
  if (!snapshot) throw new Error(`生产单元不存在：${unitId}`);
  if (snapshot.unit.revision !== input.unitRevision || snapshot.fingerprint !== unitFingerprint) {
    throw new StudioProductionConflictError(unitId, input.unitRevision, snapshot.unit.revision);
  }
  const panel = snapshot.panels.find((item) => item.index === input.panelIndex);
  if (!panel) throw new Error(`面板不存在：${unitId}#${input.panelIndex}`);
  if (snapshot.scriptRevision.id !== scriptRevisionId || snapshot.scriptRevision.bodySha256 !== scriptSha) {
    throw new Error("分析输入的 script revision/SHA 与单元冻结剧本不一致。");
  }
  // P20 定向豁免：extension 格（无 sourceSpans 属其定义）允许零提案分析；original 格仍硬拦。
  if (panel.sourceSpans.length === 0 && panel.shotType !== "extension") {
    throw new Error(`面板 ${panel.id} 缺少锨定剧本修订的 sourceSpans，禁止无来源实体解析。`);
  }
  if (!Array.isArray(input.mentions) || input.mentions.length > 256) {
    throw new Error("mentions 必须是最多 256 项的数组。");
  }
  const identitySnapshot = await getStudioIdentityIndexSnapshot(paths.root, input.mentions.map((mention) => mention.surfaceText));
  const suggestionIds = [...new Set(input.mentions.flatMap((mention) => (mention.modelSuggestions ?? []).map((item) => item.assetId)))];
  if (suggestionIds.length > 2_500) throw new Error("单次模型候选资产不能超过 2500 项。");
  const suggestionDetails = await Promise.all(suggestionIds.map(async (assetId) => {
    const normalizedId = normalizeExistingId(assetId, "suggestion.assetId");
    const detail = await getStudioCanonicalAsset(paths.root, normalizedId);
    return [normalizedId, detail] as const;
  }));
  const suggestionAssetMap = new Map(suggestionDetails);
  const mentionIds = new Set<string>();
  const now = new Date().toISOString();
  const dbForSections = openDatabase(paths.database);
  let normalizedProposals: Array<{
    semantic: Omit<StudioAssetMentionProposal, "id" | "fingerprint" | "createdAt">;
    fingerprint: string;
    id: string;
  }>;
  try {
    normalizedProposals = input.mentions.map((mention) => {
      const mentionId = normalizeExistingId(mention.id, "mention.id");
      if (mentionIds.has(mentionId)) throw new Error(`mention ID 重复：${mentionId}`);
      mentionIds.add(mentionId);
      const surfaceText = requiredText(mention.surfaceText, "surfaceText", 1_000);
      const actualSurface = assertUtf16Range(snapshot.scriptRevision.body, mention.startOffsetUtf16, mention.endOffsetUtf16, `mention ${mentionId}`);
      if (!panel.sourceSpans.some((span) => mention.startOffsetUtf16 >= span.startOffsetUtf16 && mention.endOffsetUtf16 <= span.endOffsetUtf16)) {
        throw new Error(`mention ${mentionId} 未被 panel ${panel.id} 的任一 sourceSpan 完整包含。`);
      }
      if (actualSurface !== mention.surfaceText) throw new Error(`mention ${mentionId} 的 surfaceText 与剧本 UTF-16 slice 不一致。`);
      if (surfaceText !== mention.surfaceText) throw new Error(`mention ${mentionId} 的 surfaceText 不能含首尾空白归一化差异。`);
      const category = mention.category === undefined ? undefined : normalizeAssetCategory(mention.category);
      const presence = normalizeAssetPresence(mention.presence);
      const role = requiredText(mention.role, "mention role", 1_000);
      const sectionRevisionId = mention.sectionRevisionId === undefined ? undefined : normalizeExistingId(mention.sectionRevisionId, "sectionRevisionId");
      if (sectionRevisionId) {
        const section = dbForSections.prepare("SELECT * FROM studio_script_section_revisions WHERE id = ?").get(sectionRevisionId) as Record<string, unknown> | undefined;
        if (!section || String(section.script_revision_id) !== scriptRevisionId
          || mention.startOffsetUtf16 < Number(section.start_offset_utf16)
          || mention.endOffsetUtf16 > Number(section.end_offset_utf16)) {
          throw new Error(`mention ${mentionId} 未被指定 section revision 完整包含。`);
        }
      }
      const exact = exactCandidatesFromIdentityIndex(surfaceText, category, identitySnapshot.entries);
      if (exact.length > MAX_MENTION_CANDIDATES) {
        throw new Error(`mention ${mentionId} 的 exact 候选超过 ${MAX_MENTION_CANDIDATES} 项，必须先清理冲突别名。`);
      }
      const suggestions = mention.modelSuggestions ?? [];
      if (!Array.isArray(suggestions) || suggestions.length > 5) throw new Error(`mention ${mentionId} 的模型建议最多 5 项。`);
      const seenSuggestions = new Set<string>();
      const modelCandidates = suggestions.map((suggestion, index): StudioAssetMentionCandidate => {
        const assetId = normalizeExistingId(suggestion.assetId, "suggestion.assetId");
        const asset = suggestionAssetMap.get(assetId);
        if (!asset) throw new Error(`模型候选资产不存在：${assetId}`);
        const suggestionCategory = normalizeAssetCategory(suggestion.category);
        if (asset.category !== suggestionCategory || (category && category !== suggestionCategory)) {
          throw new Error(`模型候选 ${assetId} 分类与提及不一致。`);
        }
        if (seenSuggestions.has(assetId)) throw new Error(`模型候选重复：${assetId}`);
        seenSuggestions.add(assetId);
        if (suggestion.confidence !== undefined && (!Number.isFinite(suggestion.confidence) || suggestion.confidence < 0 || suggestion.confidence > 1)) {
          throw new Error("模型候选 confidence 必须在 0-1。 ");
        }
        return { rank: exact.length + index + 1, kind: "model", assetId, category: asset.category, matchedValue: surfaceText };
      });
      const candidates = [...exact, ...modelCandidates.filter((candidate) => !exact.some((item) => item.assetId === candidate.assetId))];
      if (candidates.length > MAX_MENTION_CANDIDATES) {
        throw new Error(`mention ${mentionId} 的待审候选超过 ${MAX_MENTION_CANDIDATES} 项。`);
      }
      const status: StudioMentionStatus = exact.length === 1 ? "matched" : exact.length > 1 ? "ambiguous" : "unmatched";
      const normalizedIdentityKey = normalizeIdentityKey(surfaceText);
      const candidateSetFingerprint = identityCandidateSetFingerprint(surfaceText, category, exact);
      const semantic: Omit<StudioAssetMentionProposal, "id" | "fingerprint" | "createdAt"> = {
        mentionId,
        surfaceText,
        startOffsetUtf16: mention.startOffsetUtf16,
        endOffsetUtf16: mention.endOffsetUtf16,
        surfaceSha256: sha256(actualSurface),
        ...(sectionRevisionId ? { sectionRevisionId } : {}),
        ...(category ? { category } : {}),
        presence,
        role,
        status,
        normalizedIdentityKey,
        candidateSetFingerprint,
        candidates,
      };
      // 提案属于某一追加式 analysis revision。相同 mention 在同一宫格重析时
      // 必须生成新的 proposal 身份；否则全局 UNIQUE(fingerprint) 会与历史提案
      // 冲突，使“保留旧提案并新增一项”无法落盘。
      const fingerprint = sha256(stableJson({
        unitId,
        panelIndex: input.panelIndex,
        analysisRevision: input.expectedHeadRevision + 1,
        ...semantic,
      }));
      return { semantic, fingerprint, id: `mention-proposal-${fingerprint.slice(0, 40)}` };
    }).sort((left, right) => left.semantic.mentionId.localeCompare(right.semantic.mentionId, "en"));
  } finally {
    dbForSections.close();
  }
  const analysisSemantic = {
    unitId,
    unitRevision: input.unitRevision,
    unitFingerprint,
    panelIndex: input.panelIndex,
    scriptRevisionId,
    scriptSha256: scriptSha,
    resolverVersion,
    proposalFingerprints: normalizedProposals.map((proposal) => proposal.fingerprint),
  };
  const fingerprint = sha256(stableJson(analysisSemantic));
  const id = `mention-analysis-${fingerprint.slice(0, 40)}`;
  const db = openDatabase(paths.database);
  try {
    return runTransaction(db, () => {
      const existing = db.prepare("SELECT * FROM studio_asset_mention_analyses WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      const head = db.prepare("SELECT revision, analysis_id FROM studio_asset_mention_analysis_heads WHERE unit_id = ? AND panel_index = ?")
        .get(unitId, input.panelIndex) as { revision: number; analysis_id: string } | undefined;
      const actualRevision = Number(head?.revision ?? 0);
      if (existing && head?.analysis_id === id) {
        const analysis = analysisFromRow(db, existing);
        return finalizeStudioBindingAtomicReceipt(
          db,
          analysis,
          analysis.revision,
          "analyze_studio_script_entities",
          operationContext,
        );
      }
      if (actualRevision !== input.expectedHeadRevision) throw new StudioProductionConflictError(`${unitId}#analysis-${input.panelIndex}`, input.expectedHeadRevision, actualRevision);
      if (existing) throw new Error("相同分析内容已存在但不是当前 Head；禁止历史 Head 回退。");
      const revision = input.expectedHeadRevision + 1;
      db.prepare(`INSERT INTO studio_asset_mention_analyses(
        id, revision, unit_id, unit_revision, unit_fingerprint, panel_index,
        script_revision_id, script_sha256, resolver_version, fingerprint, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, revision, unitId, input.unitRevision, unitFingerprint, input.panelIndex,
        scriptRevisionId, scriptSha, resolverVersion, fingerprint, now,
      );
      const insertProposal = db.prepare(`INSERT INTO studio_asset_mention_proposals(
        id, analysis_id, mention_id, surface_text, start_offset_utf16, end_offset_utf16,
        surface_sha256, section_revision_id, category, presence, role, status,
        normalized_identity_key, candidate_set_fingerprint, fingerprint, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertCandidate = db.prepare(`INSERT INTO studio_asset_mention_candidates(
        proposal_id, rank, kind, asset_id, category, matched_value, fingerprint
      ) VALUES(?, ?, ?, ?, ?, ?, ?)`);
      for (const proposal of normalizedProposals) {
        const value = proposal.semantic;
        try {
          insertProposal.run(
            proposal.id, id, value.mentionId, value.surfaceText, value.startOffsetUtf16, value.endOffsetUtf16,
            value.surfaceSha256, value.sectionRevisionId ?? null, value.category ?? null, value.presence, value.role,
            value.status, value.normalizedIdentityKey, value.candidateSetFingerprint, proposal.fingerprint, now,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/UNIQUE constraint failed: studio_asset_mention_proposals\.fingerprint/u.test(message)) {
            throw new Error(
              `提及提案 fingerprint 全局冲突（unit=${unitId} panelIndex=${input.panelIndex} mentionId=${value.mentionId} surface=${value.surfaceText}）。`
              + `请使用可区分的 role/mentionId，或升级到含 unit+panel 作用域的分析器后重试。`,
              { cause: error },
            );
          }
          throw error;
        }
        for (const candidate of value.candidates) {
          insertCandidate.run(
            proposal.id, candidate.rank, candidate.kind, candidate.assetId, candidate.category, candidate.matchedValue,
            sha256(stableJson(candidate)),
          );
        }
      }
      if (head) {
        const updated = db.prepare(`UPDATE studio_asset_mention_analysis_heads
          SET revision = ?, analysis_id = ?, updated_at = ? WHERE unit_id = ? AND panel_index = ? AND revision = ?`)
          .run(revision, id, now, unitId, input.panelIndex, input.expectedHeadRevision);
        if (Number(updated.changes) !== 1) throw new StudioProductionConflictError(`${unitId}#analysis-${input.panelIndex}`, input.expectedHeadRevision, actualRevision);
      } else {
        db.prepare(`INSERT INTO studio_asset_mention_analysis_heads(unit_id, panel_index, revision, analysis_id, updated_at)
          VALUES(?, ?, 1, ?, ?)`).run(unitId, input.panelIndex, id, now);
      }
      const analysis = analysisFromRow(db, db.prepare("SELECT * FROM studio_asset_mention_analyses WHERE id = ?").get(id) as Record<string, unknown>);
      return finalizeStudioBindingAtomicReceipt(
        db,
        analysis,
        analysis.revision,
        "analyze_studio_script_entities",
        operationContext,
      );
    });
  } finally {
    db.close();
  }
}

export async function getStudioAssetMentionAnalysis(projectRoot: string, analysisId: string): Promise<StudioAssetMentionAnalysis | null> {
  const paths = await ensureProductionDirectories(projectRoot);
  const id = normalizeExistingId(analysisId, "analysisId");
  const db = openDatabase(paths.database);
  try {
    const row = db.prepare("SELECT * FROM studio_asset_mention_analyses WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? analysisFromRow(db, row) : null;
  } finally {
    db.close();
  }
}

export async function getCurrentStudioPanelAssetMentionAnalysis(
  projectRoot: string,
  unitId: string,
  panelIdOrIndex: string | number,
): Promise<StudioAssetMentionAnalysis | null> {
  const paths = await ensureProductionDirectories(projectRoot);
  const normalizedUnitId = normalizeExistingId(unitId, "unitId");
  const db = openDatabase(paths.database);
  try {
    let panelIndex: number;
    if (typeof panelIdOrIndex === "number") {
      if (!Number.isSafeInteger(panelIdOrIndex) || panelIdOrIndex < 1 || panelIdOrIndex > STUDIO_PRODUCTION_MAX_PANEL_COUNT) {
        throw new Error("panelIndex 无效。");
      }
      panelIndex = panelIdOrIndex;
    } else {
      const panelId = normalizeExistingId(panelIdOrIndex, "panelId");
      const unit = db.prepare("SELECT revision FROM studio_production_units WHERE id = ?").get(normalizedUnitId) as { revision: number } | undefined;
      if (!unit) return null;
      const panel = db.prepare(`SELECT panel_index FROM studio_production_panels
        WHERE unit_id = ? AND unit_revision = ? AND panel_id = ?`).get(
          normalizedUnitId, Number(unit.revision), panelId,
        ) as { panel_index: number } | undefined;
      if (!panel) return null;
      panelIndex = Number(panel.panel_index);
    }
    const row = db.prepare(`SELECT a.* FROM studio_asset_mention_analysis_heads h
      JOIN studio_asset_mention_analyses a ON a.id = h.analysis_id
      WHERE h.unit_id = ? AND h.panel_index = ?`).get(normalizedUnitId, panelIndex) as Record<string, unknown> | undefined;
    return row ? analysisFromRow(db, row) : null;
  } finally {
    db.close();
  }
}

export async function listStudioAssetMentionAnalyses(
  projectRoot: string,
  query: StudioAssetMentionAnalysisListQuery = {},
): Promise<StudioAssetMentionAnalysisPage> {
  const paths = await ensureProductionDirectories(projectRoot);
  const unitId = query.unitId === undefined ? undefined : normalizeExistingId(query.unitId, "unitId");
  const scope = unitId ?? "*";
  const after = decodeStringCursor(query.cursor, "mention-analyses", scope);
  const limit = normalizeLimit(query.limit);
  const db = openDatabase(paths.database);
  try {
    const rows = db.prepare(`SELECT * FROM studio_asset_mention_analyses
      WHERE (? IS NULL OR unit_id = ?) AND (? IS NULL OR id > ?) ORDER BY id LIMIT ?`)
      .all(unitId ?? null, unitId ?? null, after ?? null, after ?? null, limit + 1) as unknown as Array<Record<string, unknown>>;
    const selected = rows.slice(0, limit);
    return {
      items: selected.map((row) => analysisFromRow(db, row)),
      nextCursor: rows.length > limit ? encodeCursor("mention-analyses", scope, String(selected[selected.length - 1]!.id)) : undefined,
    };
  } finally {
    db.close();
  }
}

function decisionFromRow(row: Record<string, unknown>): StudioMentionDecisionReceipt {
  const presence = String(row.resolved_presence ?? row.proposal_presence ?? "") as StudioAssetPresence;
  if (presence !== "required" && presence !== "optional" && presence !== "forbidden") {
    throw new Error(`decision ${String(row.id)} 缺少有效 resolved presence。`);
  }
  const role = String(row.resolved_role ?? row.proposal_role ?? "").trim();
  if (!role) throw new Error(`decision ${String(row.id)} 缺少有效 resolved role。`);
  return {
    id: String(row.id),
    proposalId: String(row.proposal_id),
    proposalFingerprint: String(row.proposal_fingerprint),
    action: String(row.action) as StudioMentionDecisionAction,
    ...(row.selected_asset_id ? { selectedAssetId: String(row.selected_asset_id) } : {}),
    presence,
    role,
    reviewer: String(row.reviewer),
    note: String(row.note),
    fingerprint: String(row.fingerprint),
    createdAt: String(row.created_at),
  };
}

export async function recordStudioMentionDecision(
  projectRoot: string,
  input: RecordStudioMentionDecisionInput,
  operationContext?: StudioBindingAtomicReceiptContext<StudioMentionDecisionReceipt>,
): Promise<StudioMentionDecisionReceipt> {
  const paths = await ensureProductionDirectories(projectRoot);
  const receiptId = normalizeExistingId(input.receiptId, "receiptId");
  const proposalId = normalizeExistingId(input.proposalId, "proposalId");
  assertExpectedRevision(input.expectedAnalysisHeadRevision, 1);
  assertExpectedRevision(input.expectedDecisionHeadRevision, 0);
  if (input.action !== "accept" && input.action !== "select" && input.action !== "exclude") throw new Error("decision action 无效。");
  const reviewer = requiredText(input.reviewer, "reviewer", 500);
  const note = optionalText(input.note, "decision note", 4_000);
  const selectedAssetId = input.selectedAssetId === undefined ? undefined : normalizeExistingId(input.selectedAssetId, "selectedAssetId");
  const db = openDatabase(paths.database);
  try {
    return runTransaction(db, () => {
      const existing = db.prepare("SELECT * FROM studio_asset_mention_decisions WHERE id = ?").get(receiptId) as Record<string, unknown> | undefined;
      const proposal = db.prepare(`SELECT p.*, a.unit_id, a.panel_index, a.revision AS analysis_revision
        FROM studio_asset_mention_proposals p JOIN studio_asset_mention_analyses a ON a.id = p.analysis_id WHERE p.id = ?`)
        .get(proposalId) as Record<string, unknown> | undefined;
      if (!proposal) throw new Error(`提及提案不存在：${proposalId}`);
      const head = db.prepare(`SELECT revision, analysis_id FROM studio_asset_mention_analysis_heads
        WHERE unit_id = ? AND panel_index = ?`).get(String(proposal.unit_id), Number(proposal.panel_index)) as { revision: number; analysis_id: string } | undefined;
      const actualRevision = Number(head?.revision ?? 0);
      if (actualRevision !== input.expectedAnalysisHeadRevision || head?.analysis_id !== String(proposal.analysis_id)) {
        throw new StudioProductionConflictError(`${String(proposal.unit_id)}#analysis-${Number(proposal.panel_index)}`, input.expectedAnalysisHeadRevision, actualRevision);
      }
      const decisionHead = db.prepare(`SELECT revision, decision_id FROM studio_asset_mention_decision_heads
        WHERE proposal_id = ?`).get(proposalId) as { revision: number; decision_id: string } | undefined;
      const actualDecisionRevision = Number(decisionHead?.revision ?? 0);
      const candidates = db.prepare("SELECT * FROM studio_asset_mention_candidates WHERE proposal_id = ? ORDER BY rank")
        .all(proposalId) as unknown as Array<Record<string, unknown>>;
      const exact = candidates.filter((candidate) => String(candidate.kind) !== "model");
      let selected: string | undefined;
      if (input.action === "accept") {
        if (String(proposal.status) !== "matched" || exact.length !== 1) throw new Error("accept 只允许确认唯一 exact matched 提案。");
        selected = String(exact[0]!.asset_id);
        if (selectedAssetId && selectedAssetId !== selected) throw new Error("accept 的 selectedAssetId 与唯一 exact 候选不一致。");
      } else if (input.action === "select") {
        if (!selectedAssetId || !candidates.some((candidate) => String(candidate.asset_id) === selectedAssetId)) {
          throw new Error("select 必须显式选择 exact 或 model 待审候选中的资产。");
        }
        selected = selectedAssetId;
      } else if (selectedAssetId) {
        throw new Error("exclude 决策不能携带 selectedAssetId。");
      }
      const presence = input.presence === undefined
        ? normalizeAssetPresence(String(proposal.presence))
        : normalizeAssetPresence(input.presence);
      const role = input.role === undefined
        ? requiredText(String(proposal.role), "proposal role", 1_000)
        : requiredText(input.role, "decision role", 1_000);
      const semantic = {
        id: receiptId,
        proposalId,
        proposalFingerprint: String(proposal.fingerprint),
        action: input.action,
        selectedAssetId: selected ?? null,
        presence,
        role,
        reviewer,
        note,
      };
      const fingerprint = sha256(stableJson(semantic));
      if (existing) {
        if (String(existing.fingerprint) !== fingerprint) throw new Error(`decision receipt ID 冲突：${receiptId}`);
        const replayAgainstOriginalHead = actualDecisionRevision === input.expectedDecisionHeadRevision + 1;
        const retryAgainstCurrentHead = actualDecisionRevision === input.expectedDecisionHeadRevision;
        if (decisionHead?.decision_id !== receiptId || (!replayAgainstOriginalHead && !retryAgainstCurrentHead)) {
          throw new StudioProductionConflictError(`${proposalId}#decision`, input.expectedDecisionHeadRevision, actualDecisionRevision);
        }
        const decision = decisionFromRow({ ...existing, proposal_presence: proposal.presence, proposal_role: proposal.role });
        return finalizeStudioBindingAtomicReceipt(
          db,
          decision,
          actualDecisionRevision,
          "resolve_studio_entity_proposal",
          operationContext,
        );
      }
      if (actualDecisionRevision !== input.expectedDecisionHeadRevision) {
        throw new StudioProductionConflictError(`${proposalId}#decision`, input.expectedDecisionHeadRevision, actualDecisionRevision);
      }
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO studio_asset_mention_decisions(
        id, proposal_id, proposal_fingerprint, action, selected_asset_id, resolved_presence, resolved_role,
        reviewer, note, fingerprint, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        receiptId, proposalId, String(proposal.fingerprint), input.action, selected ?? null, presence, role,
        reviewer, note, fingerprint, now,
      );
      if (decisionHead) {
        const updated = db.prepare(`UPDATE studio_asset_mention_decision_heads
          SET revision = ?, decision_id = ?, updated_at = ?
          WHERE proposal_id = ? AND revision = ?`).run(
            input.expectedDecisionHeadRevision + 1, receiptId, now, proposalId, input.expectedDecisionHeadRevision,
          );
        if (Number(updated.changes) !== 1) {
          throw new StudioProductionConflictError(`${proposalId}#decision`, input.expectedDecisionHeadRevision, actualDecisionRevision);
        }
      } else {
        db.prepare(`INSERT INTO studio_asset_mention_decision_heads(proposal_id, revision, decision_id, updated_at)
          VALUES(?, 1, ?, ?)`).run(proposalId, receiptId, now);
      }
      const decision = decisionFromRow({
        ...(db.prepare("SELECT * FROM studio_asset_mention_decisions WHERE id = ?").get(receiptId) as Record<string, unknown>),
        proposal_presence: proposal.presence,
        proposal_role: proposal.role,
      });
      return finalizeStudioBindingAtomicReceipt(
        db,
        decision,
        input.expectedDecisionHeadRevision + 1,
        "resolve_studio_entity_proposal",
        operationContext,
      );
    });
  } finally {
    db.close();
  }
}

export async function getStudioMentionDecision(
  projectRoot: string,
  receiptId: string,
): Promise<StudioMentionDecisionReceipt | null> {
  const paths = await ensureProductionDirectories(projectRoot);
  const id = normalizeExistingId(receiptId, "receiptId");
  const db = openDatabase(paths.database);
  try {
    const row = db.prepare(`SELECT d.*, p.presence AS proposal_presence, p.role AS proposal_role
      FROM studio_asset_mention_decisions d
      JOIN studio_asset_mention_proposals p ON p.id = d.proposal_id
      WHERE d.id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? decisionFromRow(row) : null;
  } finally {
    db.close();
  }
}

export async function getStudioMentionDecisions(
  projectRoot: string,
  receiptIds: string[],
): Promise<StudioMentionDecisionReceipt[]> {
  if (!Array.isArray(receiptIds) || receiptIds.length > 500) throw new Error("decision receipt IDs 最多 500 项。");
  const ids = [...new Set(receiptIds.map((id) => normalizeExistingId(id, "receiptId")))];
  if (ids.length === 0) return [];
  const paths = await ensureProductionDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    const rows = db.prepare(`SELECT d.*, p.presence AS proposal_presence, p.role AS proposal_role
      FROM studio_asset_mention_decisions d
      JOIN studio_asset_mention_proposals p ON p.id = d.proposal_id
      WHERE d.id IN (${ids.map(() => "?").join(",")}) ORDER BY d.id`)
      .all(...ids) as unknown as Array<Record<string, unknown>>;
    return rows.map(decisionFromRow);
  } finally {
    db.close();
  }
}

export async function getCurrentStudioMentionDecision(
  projectRoot: string,
  proposalId: string,
): Promise<StudioMentionDecisionHead | null> {
  const paths = await ensureProductionDirectories(projectRoot);
  const id = normalizeExistingId(proposalId, "proposalId");
  const db = openDatabase(paths.database);
  try {
    const row = db.prepare(`SELECT h.revision AS head_revision, h.updated_at AS head_updated_at,
        d.*, p.presence AS proposal_presence, p.role AS proposal_role
      FROM studio_asset_mention_decision_heads h
      JOIN studio_asset_mention_decisions d ON d.id = h.decision_id
      JOIN studio_asset_mention_proposals p ON p.id = h.proposal_id
      WHERE h.proposal_id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? {
      proposalId: id,
      revision: Number(row.head_revision),
      decision: decisionFromRow(row),
      updatedAt: String(row.head_updated_at),
    } : null;
  } finally {
    db.close();
  }
}

export async function getCurrentStudioMentionDecisionsForAnalysis(
  projectRoot: string,
  analysisId: string,
): Promise<StudioMentionDecisionHead[]> {
  const paths = await ensureProductionDirectories(projectRoot);
  const id = normalizeExistingId(analysisId, "analysisId");
  const db = openDatabase(paths.database);
  try {
    const rows = db.prepare(`SELECT h.revision AS head_revision, h.updated_at AS head_updated_at,
        d.*, p.presence AS proposal_presence, p.role AS proposal_role
      FROM studio_asset_mention_proposals p
      JOIN studio_asset_mention_decision_heads h ON h.proposal_id = p.id
      JOIN studio_asset_mention_decisions d ON d.id = h.decision_id
      WHERE p.analysis_id = ? ORDER BY p.mention_id`).all(id) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      proposalId: String(row.proposal_id),
      revision: Number(row.head_revision),
      decision: decisionFromRow(row),
      updatedAt: String(row.head_updated_at),
    }));
  } finally {
    db.close();
  }
}

function normalizePanelEntityClosureReviewer(value: string): StudioPanelEntityClosureReviewer {
  if (value !== "user" && value !== "codex") throw new Error("confirmed-empty reviewer 必须是 user 或 codex。");
  return value;
}

function confirmationSourceSpansFromJson(value: unknown): StudioProductionPanelSourceSpan[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch (error) {
    throw new Error("confirmed-empty sourceSpans JSON 损坏。", { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("confirmed-empty sourceSpans 必须是非空数组。");
  }
  // P20：空数组仅可能来自 extension 豁免路径（写入侧 :4216 已对 original 强制非空）。
  if (parsed.length === 0) return [];
  let previousEnd = -1;
  return parsed.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`confirmed-empty sourceSpans[${index}] 无效。`);
    }
    const span = candidate as Record<string, unknown>;
    const startOffsetUtf16 = Number(span.startOffsetUtf16);
    const endOffsetUtf16 = Number(span.endOffsetUtf16);
    if (!Number.isSafeInteger(startOffsetUtf16) || startOffsetUtf16 < 0
      || !Number.isSafeInteger(endOffsetUtf16) || endOffsetUtf16 <= startOffsetUtf16
      || startOffsetUtf16 < previousEnd) {
      throw new Error(`confirmed-empty sourceSpans[${index}] 偏移无效。`);
    }
    previousEnd = endOffsetUtf16;
    return {
      scriptRevisionId: normalizeExistingId(String(span.scriptRevisionId), "sourceSpan.scriptRevisionId"),
      scriptSha256: assertSha256(String(span.scriptSha256), "sourceSpan.scriptSha256"),
      startOffsetUtf16,
      endOffsetUtf16,
      surfaceSha256: assertSha256(String(span.surfaceSha256), "sourceSpan.surfaceSha256"),
    };
  });
}

function panelEntityClosureConfirmationSemantic(
  confirmation: Omit<StudioPanelEntityClosureConfirmation, "schemaVersion" | "kind" | "id" | "revision" | "fingerprint" | "createdAt">,
): object {
  return {
    closure: confirmation.closure,
    analysisId: confirmation.analysisId,
    analysisFingerprint: confirmation.analysisFingerprint,
    unitId: confirmation.unitId,
    unitRevision: confirmation.unitRevision,
    unitFingerprint: confirmation.unitFingerprint,
    panelId: confirmation.panelId,
    panelIndex: confirmation.panelIndex,
    panelBindingScopeFingerprint: confirmation.panelBindingScopeFingerprint,
    scriptRevisionId: confirmation.scriptRevisionId,
    scriptSha256: confirmation.scriptSha256,
    promptRevisionId: confirmation.promptRevisionId,
    promptSha256: confirmation.promptSha256,
    sourceSpans: confirmation.sourceSpans,
    reviewer: confirmation.reviewer,
    note: confirmation.note,
  };
}

function panelEntityClosureConfirmationFromRow(row: Record<string, unknown>): StudioPanelEntityClosureConfirmation {
  const sourceSpans = confirmationSourceSpansFromJson(row.source_spans_json);
  const value = {
    closure: "confirmed-empty" as const,
    analysisId: String(row.analysis_id),
    analysisFingerprint: String(row.analysis_fingerprint),
    unitId: String(row.unit_id),
    unitRevision: Number(row.unit_revision),
    unitFingerprint: String(row.unit_fingerprint),
    panelId: String(row.panel_id),
    panelIndex: Number(row.panel_index),
    panelBindingScopeFingerprint: String(row.panel_binding_scope_fingerprint),
    scriptRevisionId: String(row.script_revision_id),
    scriptSha256: String(row.script_sha256),
    promptRevisionId: String(row.prompt_revision_id),
    promptSha256: String(row.prompt_sha256),
    sourceSpans,
    reviewer: normalizePanelEntityClosureReviewer(String(row.reviewer)),
    note: String(row.note),
  };
  const fingerprint = sha256(stableJson(panelEntityClosureConfirmationSemantic(value)));
  if (fingerprint !== String(row.fingerprint)) {
    throw new Error(`confirmed-empty fingerprint 漂移：${String(row.id)}`);
  }
  const id = `panel-entity-closure-confirmation-${fingerprint.slice(0, 40)}`;
  if (id !== String(row.id)) throw new Error(`confirmed-empty ID 漂移：${String(row.id)}`);
  return {
    schemaVersion: 1,
    kind: "studio-panel-entity-closure-confirmation",
    id,
    revision: Number(row.revision),
    ...value,
    fingerprint,
    createdAt: String(row.created_at),
  };
}

export async function confirmStudioPanelEntityClosureEmpty(
  projectRoot: string,
  input: ConfirmStudioPanelEntityClosureEmptyInput,
  operationContext?: StudioBindingAtomicReceiptContext<StudioPanelEntityClosureConfirmation>,
): Promise<StudioPanelEntityClosureConfirmation> {
  const paths = await ensureProductionDirectories(projectRoot);
  const analysisId = normalizeExistingId(input.analysisId, "analysisId");
  assertExpectedRevision(input.expectedAnalysisHeadRevision, 1);
  assertExpectedRevision(input.expectedConfirmationHeadRevision, 0);
  const reviewer = normalizePanelEntityClosureReviewer(input.reviewer);
  const note = requiredText(input.note, "confirmed-empty note", 4_000);
  const analysis = await getStudioAssetMentionAnalysis(paths.root, analysisId);
  if (!analysis) throw new Error(`提及分析不存在：${analysisId}`);
  if (analysis.proposals.length !== 0) throw new Error("只有 proposals=0 的分析可显式确认 confirmed-empty。");
  const evidenceUnit = await readStudioProductionUnitSnapshot(paths.root, analysis.unitId, analysis.unitRevision);
  if (!evidenceUnit || evidenceUnit.fingerprint !== analysis.unitFingerprint) {
    throw new Error("confirmed-empty 的历史单元证据不存在或 fingerprint 漂移。");
  }
  const panel = evidenceUnit.panels.find((candidate) => candidate.index === analysis.panelIndex);
  if (!panel) throw new Error(`confirmed-empty 目标 panel 不存在：${analysis.unitId}#${analysis.panelIndex}`);
  // P20 定向豁免：extension 格允许零提案 confirmed-empty；original 格仍必须锚定非空 spans。
  if (panel.sourceSpans.length === 0 && panel.shotType !== "extension") throw new Error("confirmed-empty 必须锚定非空剧本 sourceSpans。");
  if (evidenceUnit.scriptRevision.id !== analysis.scriptRevisionId
    || evidenceUnit.scriptRevision.bodySha256 !== analysis.scriptSha256) {
    throw new Error("confirmed-empty 的分析与剧本证据不一致。");
  }
  const panelBindingScopeFingerprint = createStudioPanelBindingScopeFingerprint(evidenceUnit, analysis.panelIndex);
  const currentUnit = await getStudioProductionUnitSnapshot(paths.root, analysis.unitId);
  if (!currentUnit || !currentUnit.panels.some((candidate) => candidate.index === analysis.panelIndex)
    || createStudioPanelBindingScopeFingerprint(currentUnit, analysis.panelIndex) !== panelBindingScopeFingerprint) {
    throw new Error("confirmed-empty 目标 panel binding scope 已变化，请重新分析。");
  }
  const value = {
    closure: "confirmed-empty" as const,
    analysisId,
    analysisFingerprint: analysis.fingerprint,
    unitId: analysis.unitId,
    unitRevision: analysis.unitRevision,
    unitFingerprint: analysis.unitFingerprint,
    panelId: panel.id,
    panelIndex: analysis.panelIndex,
    panelBindingScopeFingerprint,
    scriptRevisionId: analysis.scriptRevisionId,
    scriptSha256: analysis.scriptSha256,
    promptRevisionId: panel.promptRevisionId,
    promptSha256: panel.promptRevision.bodySha256,
    sourceSpans: panel.sourceSpans,
    reviewer,
    note,
  };
  const fingerprint = sha256(stableJson(panelEntityClosureConfirmationSemantic(value)));
  const id = `panel-entity-closure-confirmation-${fingerprint.slice(0, 40)}`;
  const db = openDatabase(paths.database);
  try {
    return runTransaction(db, () => {
      const analysisHead = db.prepare(`SELECT revision, analysis_id FROM studio_asset_mention_analysis_heads
        WHERE unit_id = ? AND panel_index = ?`).get(analysis.unitId, analysis.panelIndex) as { revision: number; analysis_id: string } | undefined;
      const actualAnalysisRevision = Number(analysisHead?.revision ?? 0);
      if (actualAnalysisRevision !== input.expectedAnalysisHeadRevision || analysisHead?.analysis_id !== analysisId) {
        throw new StudioProductionConflictError(`${analysis.unitId}#analysis-${analysis.panelIndex}`, input.expectedAnalysisHeadRevision, actualAnalysisRevision);
      }
      const head = db.prepare(`SELECT revision, confirmation_id FROM studio_panel_entity_closure_confirmation_heads
        WHERE unit_id = ? AND panel_index = ?`).get(analysis.unitId, analysis.panelIndex) as { revision: number; confirmation_id: string } | undefined;
      const actualRevision = Number(head?.revision ?? 0);
      const existing = db.prepare("SELECT * FROM studio_panel_entity_closure_confirmations WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined;
      if (existing) {
        const replayAgainstOriginalHead = actualRevision === input.expectedConfirmationHeadRevision + 1;
        const retryAgainstCurrentHead = actualRevision === input.expectedConfirmationHeadRevision;
        if (head?.confirmation_id !== id || (!replayAgainstOriginalHead && !retryAgainstCurrentHead)) {
          throw new StudioProductionConflictError(`${analysis.unitId}#empty-confirmation-${analysis.panelIndex}`, input.expectedConfirmationHeadRevision, actualRevision);
        }
        const confirmation = panelEntityClosureConfirmationFromRow(existing);
        return finalizeStudioBindingAtomicReceipt(
          db,
          confirmation,
          actualRevision,
          "confirm_studio_panel_empty",
          operationContext,
        );
      }
      if (actualRevision !== input.expectedConfirmationHeadRevision) {
        throw new StudioProductionConflictError(`${analysis.unitId}#empty-confirmation-${analysis.panelIndex}`, input.expectedConfirmationHeadRevision, actualRevision);
      }
      const revision = input.expectedConfirmationHeadRevision + 1;
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO studio_panel_entity_closure_confirmations(
        id, revision, closure, analysis_id, analysis_fingerprint, unit_id, unit_revision, unit_fingerprint,
        panel_id, panel_index, panel_binding_scope_fingerprint, script_revision_id, script_sha256,
        prompt_revision_id, prompt_sha256, source_spans_json, reviewer, note, fingerprint, created_at
      ) VALUES(?, ?, 'confirmed-empty', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, revision, analysisId, analysis.fingerprint, analysis.unitId, analysis.unitRevision, analysis.unitFingerprint,
        panel.id, analysis.panelIndex, panelBindingScopeFingerprint, analysis.scriptRevisionId, analysis.scriptSha256,
        panel.promptRevisionId, panel.promptRevision.bodySha256, stableJson(panel.sourceSpans), reviewer, note, fingerprint, now,
      );
      if (head) {
        const updated = db.prepare(`UPDATE studio_panel_entity_closure_confirmation_heads
          SET revision = ?, confirmation_id = ?, updated_at = ?
          WHERE unit_id = ? AND panel_index = ? AND revision = ?`).run(
            revision, id, now, analysis.unitId, analysis.panelIndex, input.expectedConfirmationHeadRevision,
          );
        if (Number(updated.changes) !== 1) {
          throw new StudioProductionConflictError(`${analysis.unitId}#empty-confirmation-${analysis.panelIndex}`, input.expectedConfirmationHeadRevision, actualRevision);
        }
      } else {
        db.prepare(`INSERT INTO studio_panel_entity_closure_confirmation_heads(
          unit_id, panel_index, revision, confirmation_id, updated_at
        ) VALUES(?, ?, 1, ?, ?)`).run(analysis.unitId, analysis.panelIndex, id, now);
      }
      const confirmation = panelEntityClosureConfirmationFromRow(
        db.prepare("SELECT * FROM studio_panel_entity_closure_confirmations WHERE id = ?").get(id) as Record<string, unknown>,
      );
      return finalizeStudioBindingAtomicReceipt(
        db,
        confirmation,
        confirmation.revision,
        "confirm_studio_panel_empty",
        operationContext,
      );
    });
  } finally {
    db.close();
  }
}

export async function getStudioPanelEntityClosureConfirmation(
  projectRoot: string,
  confirmationId: string,
): Promise<StudioPanelEntityClosureConfirmation | null> {
  const paths = await ensureProductionDirectories(projectRoot);
  const id = normalizeExistingId(confirmationId, "confirmationId");
  const db = openDatabase(paths.database);
  try {
    const row = db.prepare("SELECT * FROM studio_panel_entity_closure_confirmations WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? panelEntityClosureConfirmationFromRow(row) : null;
  } finally {
    db.close();
  }
}

export async function getCurrentStudioPanelEntityClosureConfirmation(
  projectRoot: string,
  unitId: string,
  panelIdOrIndex: string | number,
): Promise<StudioPanelEntityClosureConfirmationHead | null> {
  const paths = await ensureProductionDirectories(projectRoot);
  const normalizedUnitId = normalizeExistingId(unitId, "unitId");
  const currentUnit = await getStudioProductionUnitSnapshot(paths.root, normalizedUnitId);
  if (!currentUnit) return null;
  const panel = typeof panelIdOrIndex === "number"
    ? currentUnit.panels.find((candidate) => candidate.index === panelIdOrIndex)
    : currentUnit.panels.find((candidate) => candidate.id === normalizeExistingId(panelIdOrIndex, "panelId"));
  if (!panel) return null;
  const db = openDatabase(paths.database);
  try {
    const row = db.prepare(`SELECT h.revision AS head_revision, h.updated_at AS head_updated_at, c.*
      FROM studio_panel_entity_closure_confirmation_heads h
      JOIN studio_panel_entity_closure_confirmations c ON c.id = h.confirmation_id
      WHERE h.unit_id = ? AND h.panel_index = ?`).get(normalizedUnitId, panel.index) as Record<string, unknown> | undefined;
    return row ? {
      unitId: normalizedUnitId,
      panelIndex: panel.index,
      revision: Number(row.head_revision),
      confirmation: panelEntityClosureConfirmationFromRow(row),
      updatedAt: String(row.head_updated_at),
    } : null;
  } finally {
    db.close();
  }
}

export async function getStudioPanelEntityClosureConfirmationCurrentness(
  projectRoot: string,
  confirmationId: string,
): Promise<StudioPanelEntityClosureConfirmationCurrentness | null> {
  const confirmation = await getStudioPanelEntityClosureConfirmation(projectRoot, confirmationId);
  if (!confirmation) return null;
  const paths = await ensureProductionDirectories(projectRoot);
  const staleReasons: string[] = [];
  let head = false;
  const db = openDatabase(paths.database);
  try {
    const confirmationHead = db.prepare(`SELECT confirmation_id FROM studio_panel_entity_closure_confirmation_heads
      WHERE unit_id = ? AND panel_index = ?`).get(confirmation.unitId, confirmation.panelIndex) as { confirmation_id: string } | undefined;
    head = confirmationHead?.confirmation_id === confirmation.id;
    const analysisHead = db.prepare(`SELECT analysis_id FROM studio_asset_mention_analysis_heads
      WHERE unit_id = ? AND panel_index = ?`).get(confirmation.unitId, confirmation.panelIndex) as { analysis_id: string } | undefined;
    if (analysisHead?.analysis_id !== confirmation.analysisId) staleReasons.push("analysis-head-changed");
    const analysisRow = db.prepare("SELECT * FROM studio_asset_mention_analyses WHERE id = ?")
      .get(confirmation.analysisId) as Record<string, unknown> | undefined;
    if (!analysisRow || String(analysisRow.fingerprint) !== confirmation.analysisFingerprint) {
      staleReasons.push("analysis-fingerprint-changed");
    } else {
      const proposalCount = Number((db.prepare("SELECT COUNT(*) AS count FROM studio_asset_mention_proposals WHERE analysis_id = ?")
        .get(confirmation.analysisId) as { count: number }).count);
      if (proposalCount !== 0) staleReasons.push("analysis-not-empty");
    }
  } finally {
    db.close();
  }
  if (!head) staleReasons.push("confirmation-not-head");
  const evidenceUnit = await readStudioProductionUnitSnapshot(paths.root, confirmation.unitId, confirmation.unitRevision);
  if (!evidenceUnit || evidenceUnit.fingerprint !== confirmation.unitFingerprint) {
    staleReasons.push("evidence-unit-changed");
  } else {
    const evidencePanel = evidenceUnit.panels.find((candidate) => candidate.index === confirmation.panelIndex);
    if (!evidencePanel || evidencePanel.id !== confirmation.panelId) staleReasons.push("evidence-panel-changed");
    else {
      if (createStudioPanelBindingScopeFingerprint(evidenceUnit, confirmation.panelIndex) !== confirmation.panelBindingScopeFingerprint) {
        staleReasons.push("evidence-panel-scope-changed");
      }
      if (stableJson(evidencePanel.sourceSpans) !== stableJson(confirmation.sourceSpans)) staleReasons.push("source-spans-changed");
    }
  }
  const currentUnit = await getStudioProductionUnitSnapshot(paths.root, confirmation.unitId);
  const currentPanel = currentUnit?.panels.find((candidate) => candidate.index === confirmation.panelIndex);
  if (!currentUnit || !currentPanel || currentPanel.id !== confirmation.panelId) {
    staleReasons.push("panel-missing");
  } else {
    if (createStudioPanelBindingScopeFingerprint(currentUnit, confirmation.panelIndex) !== confirmation.panelBindingScopeFingerprint) {
      staleReasons.push("panel-binding-scope-changed");
    }
    if (currentUnit.scriptRevision.id !== confirmation.scriptRevisionId
      || currentUnit.scriptRevision.bodySha256 !== confirmation.scriptSha256) staleReasons.push("script-changed");
    if (currentPanel.promptRevisionId !== confirmation.promptRevisionId
      || currentPanel.promptRevision.bodySha256 !== confirmation.promptSha256) staleReasons.push("prompt-changed");
    if (stableJson(currentPanel.sourceSpans) !== stableJson(confirmation.sourceSpans)) staleReasons.push("source-spans-changed");
  }
  const uniqueReasons = [...new Set(staleReasons)].sort((left, right) => left.localeCompare(right, "en"));
  return { confirmationId: confirmation.id, head, current: uniqueReasons.length === 0, staleReasons: uniqueReasons };
}

function normalizeBindingSource(source: StudioAssetBindingSourceSnapshot): StudioAssetBindingSourceSnapshot {
  if (!Number.isSafeInteger(source.assetRevision) || source.assetRevision < 1) throw new Error("assetRevision 必须是正整数。");
  return {
    assetId: normalizeExistingId(source.assetId, "assetSource.assetId"),
    category: normalizeAssetCategory(source.category),
    assetRevision: source.assetRevision,
    definitionVersionId: normalizeExistingId(source.definitionVersionId, "definitionVersionId"),
    authorityEventId: normalizeExistingId(source.authorityEventId, "authorityEventId"),
    authorityVersionId: normalizeExistingId(source.authorityVersionId, "authorityVersionId"),
    assetVersionId: normalizeExistingId(source.assetVersionId, "assetVersionId"),
    mediaSha256: assertSha256(source.mediaSha256, "mediaSha256"),
    knowledgeFingerprint: assertSha256(source.knowledgeFingerprint, "knowledgeFingerprint"),
    applicabilityFingerprint: assertSha256(source.applicabilityFingerprint, "applicabilityFingerprint"),
  };
}

function bindingSourceSemanticFingerprint(source: StudioAssetBindingSourceSnapshot): string {
  return sha256(stableJson(source));
}

export function studioIdentityDependencyKey(surfaceText: string, category?: StudioAssetCategory): string {
  return `${normalizeIdentityKey(surfaceText)}::category:${category ?? "*"}`;
}

function bindingSetFromRow(db: DatabaseSync, row: Record<string, unknown>): StudioAssetBindingSet {
  const bindingRows = db.prepare("SELECT * FROM studio_asset_bindings WHERE binding_set_id = ? ORDER BY asset_id")
    .all(String(row.id)) as unknown as Array<Record<string, unknown>>;
  const bindings = bindingRows.map((binding): StudioPanelAssetBinding => {
    const mentions = db.prepare(`SELECT mention_id FROM studio_asset_binding_mentions
      WHERE binding_set_id = ? AND asset_id = ? ORDER BY mention_id`).all(String(row.id), String(binding.asset_id)) as Array<{ mention_id: string }>;
    return {
      assetId: String(binding.asset_id),
      category: String(binding.category) as StudioAssetCategory,
      presence: String(binding.presence) as StudioAssetPresence,
      role: String(binding.role),
      mentionIds: mentions.map((mention) => mention.mention_id),
      assetRevision: Number(binding.asset_revision),
      definitionVersionId: String(binding.definition_version_id),
      authorityEventId: String(binding.authority_event_id),
      authorityVersionId: String(binding.authority_version_id),
      assetVersionId: String(binding.asset_version_id),
      mediaSha256: String(binding.media_sha256),
      knowledgeFingerprint: String(binding.knowledge_fingerprint),
      applicabilityFingerprint: String(binding.applicability_fingerprint),
      semanticFingerprint: String(binding.semantic_fingerprint),
    };
  });
  const identityDependencies = db.prepare(`SELECT dependency_key, expected_fingerprint
    FROM studio_asset_binding_dependencies WHERE binding_set_id = ? AND kind = 'identity-key' ORDER BY dependency_key`)
    .all(String(row.id)) as Array<{ dependency_key: string; expected_fingerprint: string }>;
  const decisions = db.prepare(`SELECT dependency_key FROM studio_asset_binding_dependencies
    WHERE binding_set_id = ? AND kind = 'decision' ORDER BY dependency_key`)
    .all(String(row.id)) as Array<{ dependency_key: string }>;
  const unresolved = db.prepare(`SELECT dependency_key FROM studio_asset_binding_dependencies
    WHERE binding_set_id = ? AND kind = 'optional-unresolved' ORDER BY dependency_key`)
    .all(String(row.id)) as Array<{ dependency_key: string }>;
  const emptyConfirmation = db.prepare(`SELECT confirmation_id, expected_fingerprint
    FROM studio_asset_binding_empty_confirmation_dependencies WHERE binding_set_id = ?`)
    .get(String(row.id)) as { confirmation_id: string; expected_fingerprint: string } | undefined;
  if (emptyConfirmation && bindings.length !== 0) {
    throw new Error(`BindingSet 同时包含资产与 confirmed-empty 依赖：${String(row.id)}`);
  }
  return {
    schemaVersion: 1,
    kind: "studio-panel-asset-binding-set",
    id: String(row.id),
    revision: Number(row.revision),
    analysisId: String(row.analysis_id),
    unitId: String(row.unit_id),
    unitRevision: Number(row.unit_revision),
    unitFingerprint: String(row.unit_fingerprint),
    panelIndex: Number(row.panel_index),
    scriptRevisionId: String(row.script_revision_id),
    scriptSha256: String(row.script_sha256),
    promptRevisionId: String(row.prompt_revision_id),
    promptSha256: String(row.prompt_sha256),
    bindings,
    identityKeyFingerprints: Object.fromEntries(identityDependencies.map((dependency) => [dependency.dependency_key, dependency.expected_fingerprint])),
    decisionReceiptIds: decisions.map((decision) => decision.dependency_key),
    unresolvedOptionalMentionIds: unresolved.map((dependency) => dependency.dependency_key),
    confirmedEmpty: Boolean(emptyConfirmation),
    ...(emptyConfirmation ? {
      emptyConfirmationId: emptyConfirmation.confirmation_id,
      emptyConfirmationFingerprint: emptyConfirmation.expected_fingerprint,
    } : {}),
    fingerprint: String(row.fingerprint),
    createdAt: String(row.created_at),
  };
}

export async function freezeStudioPanelAssetBindingSet(
  projectRoot: string,
  input: FreezeStudioPanelAssetBindingSetInput,
  operationContext?: StudioBindingAtomicReceiptContext<StudioAssetBindingSet>,
): Promise<StudioAssetBindingSet> {
  const paths = await ensureProductionDirectories(projectRoot);
  const analysisId = normalizeExistingId(input.analysisId, "analysisId");
  const emptyConfirmationId = input.emptyConfirmationId === undefined
    ? undefined
    : normalizeExistingId(input.emptyConfirmationId, "emptyConfirmationId");
  assertExpectedRevision(input.expectedAnalysisHeadRevision, 1);
  assertExpectedRevision(input.expectedBindingHeadRevision, 0);
  if (!Array.isArray(input.decisionReceiptIds) || input.decisionReceiptIds.length > 500) throw new Error("decisionReceiptIds 最多 500 项。");
  const decisionReceiptIds = input.decisionReceiptIds.map((id) => normalizeExistingId(id, "decisionReceiptId"));
  if (new Set(decisionReceiptIds).size !== decisionReceiptIds.length) throw new Error("decisionReceiptIds 不能重复。");
  if (!Array.isArray(input.assetSources) || input.assetSources.length > 500) throw new Error("assetSources 最多 500 项。");
  const sources = input.assetSources.map(normalizeBindingSource);
  const sourceMap = new Map<string, StudioAssetBindingSourceSnapshot>();
  for (const source of sources) {
    if (sourceMap.has(source.assetId)) throw new Error(`资产来源重复：${source.assetId}`);
    sourceMap.set(source.assetId, source);
  }
  const snapshotAnalysis = await getStudioAssetMentionAnalysis(paths.root, analysisId);
  if (!snapshotAnalysis) throw new Error(`提及分析不存在：${analysisId}`);
  const unitSnapshot = await getStudioProductionUnitSnapshot(paths.root, snapshotAnalysis.unitId);
  if (!unitSnapshot) throw new Error(`生产单元不存在：${snapshotAnalysis.unitId}`);
  const analysisUnitSnapshot = unitSnapshot.unit.revision === snapshotAnalysis.unitRevision
    ? unitSnapshot
    : await readStudioProductionUnitSnapshot(paths.root, snapshotAnalysis.unitId, snapshotAnalysis.unitRevision);
  if (!analysisUnitSnapshot || analysisUnitSnapshot.fingerprint !== snapshotAnalysis.unitFingerprint) {
    throw new Error("提及分析保留的 unitFingerprint 无法由历史生产单元修订重建。");
  }
  const analysisPanel = analysisUnitSnapshot.panels.find((item) => item.index === snapshotAnalysis.panelIndex);
  const panel = unitSnapshot.panels.find((item) => item.index === snapshotAnalysis.panelIndex);
  if (!analysisPanel || !panel
    || createStudioPanelBindingScopeFingerprint(analysisUnitSnapshot, snapshotAnalysis.panelIndex)
      !== createStudioPanelBindingScopeFingerprint(unitSnapshot, snapshotAnalysis.panelIndex)) {
    throw new Error("提及分析依赖的生产单元已变化，必须重新分析。");
  }
  if (analysisUnitSnapshot.scriptRevision.id !== snapshotAnalysis.scriptRevisionId
    || analysisUnitSnapshot.scriptRevision.bodySha256 !== snapshotAnalysis.scriptSha256
    || unitSnapshot.scriptRevision.id !== snapshotAnalysis.scriptRevisionId
    || unitSnapshot.scriptRevision.bodySha256 !== snapshotAnalysis.scriptSha256) {
    throw new Error("提及分析依赖的剧本修订已变化。");
  }
  const promptSha = panel.promptRevision.bodySha256;
  let emptyConfirmation: StudioPanelEntityClosureConfirmation | undefined;
  if (snapshotAnalysis.proposals.length === 0) {
    if (decisionReceiptIds.length !== 0 || sources.length !== 0) {
      throw new Error("confirmed-empty BindingSet 必须使用 0 decisions 与 0 assetSources。");
    }
    if (!emptyConfirmationId) {
      throw new Error("proposals=0 必须提供当前 emptyConfirmationId，禁止把未审阅空结果冻结为 BindingSet。");
    }
    const confirmation = await getStudioPanelEntityClosureConfirmation(paths.root, emptyConfirmationId);
    const currentness = await getStudioPanelEntityClosureConfirmationCurrentness(paths.root, emptyConfirmationId);
    if (!confirmation || !currentness?.current
      || confirmation.analysisId !== analysisId
      || confirmation.analysisFingerprint !== snapshotAnalysis.fingerprint
      || confirmation.panelBindingScopeFingerprint !== createStudioPanelBindingScopeFingerprint(unitSnapshot, snapshotAnalysis.panelIndex)) {
      throw new Error("emptyConfirmationId 不是目标分析与 panel scope 的当前 confirmed-empty 裁决。");
    }
    emptyConfirmation = confirmation;
  } else if (emptyConfirmationId) {
    throw new Error("非空提案分析不能携带 emptyConfirmationId。");
  }
  const db = openDatabase(paths.database);
  try {
    return runTransaction(db, () => {
      const analysisRow = db.prepare("SELECT * FROM studio_asset_mention_analyses WHERE id = ?").get(analysisId) as Record<string, unknown> | undefined;
      if (!analysisRow) throw new Error(`提及分析不存在：${analysisId}`);
      const analysisHead = db.prepare(`SELECT revision, analysis_id FROM studio_asset_mention_analysis_heads
        WHERE unit_id = ? AND panel_index = ?`).get(snapshotAnalysis.unitId, snapshotAnalysis.panelIndex) as { revision: number; analysis_id: string } | undefined;
      const actualAnalysisRevision = Number(analysisHead?.revision ?? 0);
      if (actualAnalysisRevision !== input.expectedAnalysisHeadRevision || analysisHead?.analysis_id !== analysisId) {
        throw new StudioProductionConflictError(`${snapshotAnalysis.unitId}#analysis-${snapshotAnalysis.panelIndex}`, input.expectedAnalysisHeadRevision, actualAnalysisRevision);
      }
      if (emptyConfirmation) {
        const confirmationHead = db.prepare(`SELECT confirmation_id FROM studio_panel_entity_closure_confirmation_heads
          WHERE unit_id = ? AND panel_index = ?`).get(
            snapshotAnalysis.unitId, snapshotAnalysis.panelIndex,
          ) as { confirmation_id: string } | undefined;
        const confirmationRow = db.prepare(`SELECT analysis_id, analysis_fingerprint, panel_binding_scope_fingerprint, fingerprint
          FROM studio_panel_entity_closure_confirmations WHERE id = ?`).get(emptyConfirmation.id) as Record<string, unknown> | undefined;
        if (confirmationHead?.confirmation_id !== emptyConfirmation.id
          || !confirmationRow
          || String(confirmationRow.analysis_id) !== analysisId
          || String(confirmationRow.analysis_fingerprint) !== snapshotAnalysis.fingerprint
          || String(confirmationRow.panel_binding_scope_fingerprint) !== emptyConfirmation.panelBindingScopeFingerprint
          || String(confirmationRow.fingerprint) !== emptyConfirmation.fingerprint) {
          throw new Error("confirmed-empty 裁决在冻结事务前已变化。");
        }
      }
      const decisionRows = decisionReceiptIds.length === 0 ? [] : db.prepare(`SELECT d.*, p.presence AS proposal_presence, p.role AS proposal_role
        FROM studio_asset_mention_decisions d
        JOIN studio_asset_mention_proposals p ON p.id = d.proposal_id
        WHERE d.id IN (${decisionReceiptIds.map(() => "?").join(",")})`).all(...decisionReceiptIds) as unknown as Array<Record<string, unknown>>;
      if (decisionRows.length !== decisionReceiptIds.length) throw new Error("存在缺失的 decision receipt。");
      const decisionByProposal = new Map<string, Record<string, unknown>>();
      for (const decision of decisionRows) {
        const proposalId = String(decision.proposal_id);
        if (decisionByProposal.has(proposalId)) throw new Error(`同一提案不能同时冻结多个决策：${proposalId}`);
        const decisionHead = db.prepare("SELECT decision_id FROM studio_asset_mention_decision_heads WHERE proposal_id = ?")
          .get(proposalId) as { decision_id: string } | undefined;
        if (decisionHead?.decision_id !== String(decision.id)) {
          throw new Error(`decision receipt 不是当前 head：${String(decision.id)}`);
        }
        decisionByProposal.set(proposalId, decision);
      }
      const proposals = snapshotAnalysis.proposals;
      const proposalIds = new Set(proposals.map((proposal) => proposal.id));
      for (const proposalId of decisionByProposal.keys()) {
        if (!proposalIds.has(proposalId)) throw new Error(`决策不属于目标分析：${proposalId}`);
      }
      const unresolvedOptional: string[] = [];
      const selected: Array<{
        proposal: StudioAssetMentionProposal;
        decision: Record<string, unknown>;
        assetId: string;
        category: StudioAssetCategory;
        presence: StudioAssetPresence;
        role: string;
      }> = [];
      for (const proposal of proposals) {
        const decision = decisionByProposal.get(proposal.id);
        if (!decision) {
          if (proposal.presence === "optional") {
            unresolvedOptional.push(proposal.mentionId);
            continue;
          }
          throw new Error(`${proposal.presence} 提及 ${proposal.mentionId} 缺少人工 decision receipt，禁止冻结。`);
        }
        if (String(decision.proposal_fingerprint) !== proposal.fingerprint) {
          throw new Error(`决策与提案 fingerprint 不一致：${proposal.id}`);
        }
        if (String(decision.action) === "exclude") continue;
        const assetId = String(decision.selected_asset_id);
        const candidate = proposal.candidates.find((item) => item.assetId === assetId);
        if (!candidate) throw new Error(`人工选择不在冻结候选集中：${proposal.id}/${assetId}`);
        const resolved = decisionFromRow(decision);
        selected.push({
          proposal,
          decision,
          assetId,
          category: candidate.category,
          presence: resolved.presence,
          role: resolved.role,
        });
      }
      const grouped = new Map<string, typeof selected>();
      for (const item of selected) grouped.set(item.assetId, [...(grouped.get(item.assetId) ?? []), item]);
      const bindings: StudioPanelAssetBinding[] = [];
      for (const [assetId, items] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))) {
        const source = sourceMap.get(assetId);
        if (!source) throw new Error(`人工确认资产缺少冻结来源：${assetId}`);
        if (items.some((item) => item.category !== source.category)) throw new Error(`资产分类冲突：${assetId}`);
        const presences = new Set(items.map((item) => item.presence));
        if (presences.has("forbidden") && presences.size > 1) throw new Error(`资产 ${assetId} 同时 forbidden 与可见，禁止冻结。`);
        const roles = [...new Set(items.map((item) => item.role))];
        if (roles.length !== 1) throw new Error(`资产 ${assetId} 在同一面板存在冲突 role。`);
        const presence: StudioAssetPresence = presences.has("forbidden") ? "forbidden" : presences.has("required") ? "required" : "optional";
        bindings.push({
          assetId,
          category: source.category,
          presence,
          role: roles[0]!,
          mentionIds: items.map((item) => item.proposal.mentionId).sort((left, right) => left.localeCompare(right, "en")),
          assetRevision: source.assetRevision,
          definitionVersionId: source.definitionVersionId,
          authorityEventId: source.authorityEventId,
          authorityVersionId: source.authorityVersionId,
          assetVersionId: source.assetVersionId,
          mediaSha256: source.mediaSha256,
          knowledgeFingerprint: source.knowledgeFingerprint,
          applicabilityFingerprint: source.applicabilityFingerprint,
          semanticFingerprint: bindingSourceSemanticFingerprint(source),
        });
      }
      const identityKeyFingerprints = Object.fromEntries(proposals.map((proposal) => [
        studioIdentityDependencyKey(proposal.surfaceText, proposal.category),
        proposal.candidateSetFingerprint,
      ]));
      if (Object.keys(identityKeyFingerprints).length !== new Set(proposals.map((proposal) => studioIdentityDependencyKey(proposal.surfaceText, proposal.category))).size) {
        throw new Error("同一 identity dependency key 出现冲突 fingerprint。");
      }
      const decisionReceiptFingerprints = decisionRows
        .map((decision) => ({ id: String(decision.id), fingerprint: String(decision.fingerprint) }))
        .sort((left, right) => left.id.localeCompare(right.id, "en"));
      const semantic = {
        analysisId,
        analysisFingerprint: snapshotAnalysis.fingerprint,
        unitId: snapshotAnalysis.unitId,
        unitRevision: snapshotAnalysis.unitRevision,
        unitFingerprint: snapshotAnalysis.unitFingerprint,
        panelIndex: snapshotAnalysis.panelIndex,
        scriptRevisionId: snapshotAnalysis.scriptRevisionId,
        scriptSha256: snapshotAnalysis.scriptSha256,
        promptRevisionId: panel.promptRevisionId,
        promptSha256: promptSha,
        bindings,
        identityKeyFingerprints,
        decisionReceipts: decisionReceiptFingerprints,
        unresolvedOptionalMentionIds: unresolvedOptional.sort((left, right) => left.localeCompare(right, "en")),
        ...(emptyConfirmation ? {
          confirmedEmpty: true,
          emptyConfirmation: {
            id: emptyConfirmation.id,
            fingerprint: emptyConfirmation.fingerprint,
          },
        } : {}),
      };
      const fingerprint = sha256(stableJson(semantic));
      const id = `asset-binding-set-${fingerprint.slice(0, 40)}`;
      const existing = db.prepare("SELECT * FROM studio_asset_binding_sets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      const head = db.prepare(`SELECT revision, binding_set_id FROM studio_asset_binding_set_heads
        WHERE unit_id = ? AND panel_index = ?`).get(snapshotAnalysis.unitId, snapshotAnalysis.panelIndex) as { revision: number; binding_set_id: string } | undefined;
      const actualBindingRevision = Number(head?.revision ?? 0);
      if (existing && head?.binding_set_id === id) {
        const bindingSet = bindingSetFromRow(db, existing);
        return finalizeStudioBindingAtomicReceipt(
          db,
          bindingSet,
          bindingSet.revision,
          "freeze_studio_asset_binding_set",
          operationContext,
        );
      }
      if (actualBindingRevision !== input.expectedBindingHeadRevision) {
        throw new StudioProductionConflictError(`${snapshotAnalysis.unitId}#binding-${snapshotAnalysis.panelIndex}`, input.expectedBindingHeadRevision, actualBindingRevision);
      }
      if (existing) throw new Error("相同 BindingSet 已存在但不是当前 Head；禁止历史 Head 回退。");
      const revision = input.expectedBindingHeadRevision + 1;
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO studio_asset_binding_sets(
        id, revision, analysis_id, unit_id, unit_revision, unit_fingerprint, panel_index,
        script_revision_id, script_sha256, prompt_revision_id, prompt_sha256, fingerprint, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, revision, analysisId, snapshotAnalysis.unitId, snapshotAnalysis.unitRevision, snapshotAnalysis.unitFingerprint,
        snapshotAnalysis.panelIndex, snapshotAnalysis.scriptRevisionId, snapshotAnalysis.scriptSha256,
        panel.promptRevisionId, promptSha, fingerprint, now,
      );
      const insertBinding = db.prepare(`INSERT INTO studio_asset_bindings(
        binding_set_id, asset_id, category, presence, role, asset_revision, definition_version_id,
        authority_event_id, authority_version_id, asset_version_id, media_sha256,
        knowledge_fingerprint, applicability_fingerprint, semantic_fingerprint
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertMention = db.prepare(`INSERT INTO studio_asset_binding_mentions(
        binding_set_id, asset_id, mention_id, proposal_id, decision_id
      ) VALUES(?, ?, ?, ?, ?)`);
      for (const binding of bindings) {
        insertBinding.run(
          id, binding.assetId, binding.category, binding.presence, binding.role, binding.assetRevision,
          binding.definitionVersionId, binding.authorityEventId, binding.authorityVersionId,
          binding.assetVersionId, binding.mediaSha256, binding.knowledgeFingerprint,
          binding.applicabilityFingerprint, binding.semanticFingerprint,
        );
        for (const mentionId of binding.mentionIds) {
          const item = selected.find((entry) => entry.assetId === binding.assetId && entry.proposal.mentionId === mentionId)!;
          insertMention.run(id, binding.assetId, mentionId, item.proposal.id, String(item.decision.id));
        }
      }
      const insertDependency = db.prepare(`INSERT INTO studio_asset_binding_dependencies(
        binding_set_id, kind, dependency_key, expected_fingerprint
      ) VALUES(?, ?, ?, ?)`);
      for (const [key, expected] of Object.entries(identityKeyFingerprints)) insertDependency.run(id, "identity-key", key, expected);
      for (const binding of bindings) insertDependency.run(id, "asset-semantic", binding.assetId, binding.semanticFingerprint);
      for (const decision of decisionReceiptFingerprints) insertDependency.run(id, "decision", decision.id, decision.fingerprint);
      for (const mentionId of unresolvedOptional) {
        const proposal = proposals.find((item) => item.mentionId === mentionId)!;
        insertDependency.run(id, "optional-unresolved", mentionId, proposal.candidateSetFingerprint);
      }
      if (emptyConfirmation) {
        db.prepare(`INSERT INTO studio_asset_binding_empty_confirmation_dependencies(
          binding_set_id, confirmation_id, expected_fingerprint
        ) VALUES(?, ?, ?)`).run(id, emptyConfirmation.id, emptyConfirmation.fingerprint);
      }
      if (head) {
        const updated = db.prepare(`UPDATE studio_asset_binding_set_heads
          SET revision = ?, binding_set_id = ?, updated_at = ?
          WHERE unit_id = ? AND panel_index = ? AND revision = ?`).run(
            revision, id, now, snapshotAnalysis.unitId, snapshotAnalysis.panelIndex, input.expectedBindingHeadRevision,
          );
        if (Number(updated.changes) !== 1) throw new StudioProductionConflictError(`${snapshotAnalysis.unitId}#binding-${snapshotAnalysis.panelIndex}`, input.expectedBindingHeadRevision, actualBindingRevision);
      } else {
        db.prepare(`INSERT INTO studio_asset_binding_set_heads(unit_id, panel_index, revision, binding_set_id, updated_at)
          VALUES(?, ?, 1, ?, ?)`).run(snapshotAnalysis.unitId, snapshotAnalysis.panelIndex, id, now);
      }
      const bindingSet = bindingSetFromRow(db, db.prepare("SELECT * FROM studio_asset_binding_sets WHERE id = ?").get(id) as Record<string, unknown>);
      return finalizeStudioBindingAtomicReceipt(
        db,
        bindingSet,
        bindingSet.revision,
        "freeze_studio_asset_binding_set",
        operationContext,
      );
    });
  } finally {
    db.close();
  }
}

export async function getStudioAssetBindingSet(
  projectRoot: string,
  bindingSetId: string,
): Promise<StudioAssetBindingSet | null> {
  const paths = await ensureProductionDirectories(projectRoot);
  const id = normalizeExistingId(bindingSetId, "bindingSetId");
  const db = openDatabase(paths.database);
  try {
    const row = db.prepare("SELECT * FROM studio_asset_binding_sets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? bindingSetFromRow(db, row) : null;
  } finally {
    db.close();
  }
}

export async function getCurrentStudioPanelAssetBindingSet(
  projectRoot: string,
  unitId: string,
  panelIdOrIndex: string | number,
): Promise<StudioAssetBindingSet | null> {
  const paths = await ensureProductionDirectories(projectRoot);
  const normalizedUnitId = normalizeExistingId(unitId, "unitId");
  const db = openDatabase(paths.database);
  try {
    let panelIndex: number;
    if (typeof panelIdOrIndex === "number") {
      if (!Number.isSafeInteger(panelIdOrIndex) || panelIdOrIndex < 1 || panelIdOrIndex > STUDIO_PRODUCTION_MAX_PANEL_COUNT) throw new Error("panelIndex 无效。");
      panelIndex = panelIdOrIndex;
    } else {
      const panelId = normalizeExistingId(panelIdOrIndex, "panelId");
      const unit = db.prepare("SELECT revision FROM studio_production_units WHERE id = ?").get(normalizedUnitId) as { revision: number } | undefined;
      if (!unit) return null;
      const panel = db.prepare(`SELECT panel_index FROM studio_production_panels
        WHERE unit_id = ? AND unit_revision = ? AND panel_id = ?`).get(normalizedUnitId, Number(unit.revision), panelId) as { panel_index: number } | undefined;
      if (!panel) return null;
      panelIndex = Number(panel.panel_index);
    }
    const row = db.prepare(`SELECT s.* FROM studio_asset_binding_set_heads h
      JOIN studio_asset_binding_sets s ON s.id = h.binding_set_id
      WHERE h.unit_id = ? AND h.panel_index = ?`).get(normalizedUnitId, panelIndex) as Record<string, unknown> | undefined;
    return row ? bindingSetFromRow(db, row) : null;
  } finally {
    db.close();
  }
}

export async function listStudioAssetBindingSets(
  projectRoot: string,
  query: StudioAssetBindingSetListQuery = {},
): Promise<StudioAssetBindingSetPage> {
  const paths = await ensureProductionDirectories(projectRoot);
  const unitId = query.unitId === undefined ? undefined : normalizeExistingId(query.unitId, "unitId");
  const scope = unitId ?? "*";
  const after = decodeStringCursor(query.cursor, "asset-binding-sets", scope);
  const limit = normalizeLimit(query.limit);
  const db = openDatabase(paths.database);
  try {
    const rows = db.prepare(`SELECT * FROM studio_asset_binding_sets
      WHERE (? IS NULL OR unit_id = ?) AND (? IS NULL OR id > ?) ORDER BY id LIMIT ?`)
      .all(unitId ?? null, unitId ?? null, after ?? null, after ?? null, limit + 1) as unknown as Array<Record<string, unknown>>;
    const selected = rows.slice(0, limit);
    return {
      items: selected.map((row) => bindingSetFromRow(db, row)),
      nextCursor: rows.length > limit ? encodeCursor("asset-binding-sets", scope, String(selected[selected.length - 1]!.id)) : undefined,
    };
  } finally {
    db.close();
  }
}

export async function getStudioAssetBindingSetCurrentness(
  projectRoot: string,
  bindingSetId: string,
  context: StudioAssetBindingCurrentContext,
): Promise<StudioAssetBindingSetCurrentness | null> {
  const bindingSet = await getStudioAssetBindingSet(projectRoot, bindingSetId);
  if (!bindingSet) return null;
  const paths = await ensureProductionDirectories(projectRoot);
  const staleReasons: string[] = [];
  const db = openDatabase(paths.database);
  let head = false;
  try {
    const row = db.prepare(`SELECT binding_set_id FROM studio_asset_binding_set_heads
      WHERE unit_id = ? AND panel_index = ?`).get(bindingSet.unitId, bindingSet.panelIndex) as { binding_set_id: string } | undefined;
    head = row?.binding_set_id === bindingSet.id;
    const analysisHead = db.prepare(`SELECT analysis_id FROM studio_asset_mention_analysis_heads
      WHERE unit_id = ? AND panel_index = ?`).get(bindingSet.unitId, bindingSet.panelIndex) as { analysis_id: string } | undefined;
    if (analysisHead?.analysis_id !== bindingSet.analysisId) staleReasons.push("analysis-head-changed");
    if (bindingSet.confirmedEmpty) {
      if (!bindingSet.emptyConfirmationId || !bindingSet.emptyConfirmationFingerprint) {
        staleReasons.push("empty-confirmation-dependency-invalid");
      } else {
        const confirmationHead = db.prepare(`SELECT confirmation_id FROM studio_panel_entity_closure_confirmation_heads
          WHERE unit_id = ? AND panel_index = ?`).get(bindingSet.unitId, bindingSet.panelIndex) as { confirmation_id: string } | undefined;
        const confirmation = db.prepare("SELECT fingerprint FROM studio_panel_entity_closure_confirmations WHERE id = ?")
          .get(bindingSet.emptyConfirmationId) as { fingerprint: string } | undefined;
        if (confirmationHead?.confirmation_id !== bindingSet.emptyConfirmationId) staleReasons.push("empty-confirmation-head-changed");
        if (confirmation?.fingerprint !== bindingSet.emptyConfirmationFingerprint) staleReasons.push("empty-confirmation-fingerprint-changed");
      }
    }
    for (const receiptId of bindingSet.decisionReceiptIds) {
      const decision = db.prepare("SELECT proposal_id FROM studio_asset_mention_decisions WHERE id = ?")
        .get(receiptId) as { proposal_id: string } | undefined;
      const decisionHead = decision
        ? db.prepare("SELECT decision_id FROM studio_asset_mention_decision_heads WHERE proposal_id = ?")
          .get(decision.proposal_id) as { decision_id: string } | undefined
        : undefined;
      if (!decision || decisionHead?.decision_id !== receiptId) {
        staleReasons.push(`decision-head-changed:${decision?.proposal_id ?? receiptId}`);
      }
    }
    const sectionDependencies = db.prepare(`SELECT p.section_revision_id,
        r.section_id, h.revision_id AS current_revision_id
      FROM studio_asset_mention_proposals p
      LEFT JOIN studio_script_section_revisions r ON r.id = p.section_revision_id
      LEFT JOIN studio_script_section_heads h ON h.section_id = r.section_id
      WHERE p.analysis_id = ? AND p.section_revision_id IS NOT NULL`)
      .all(bindingSet.analysisId) as unknown as Array<{
        section_revision_id: string;
        section_id?: string;
        current_revision_id?: string;
      }>;
    for (const dependency of sectionDependencies) {
      if (!dependency.section_id) staleReasons.push(`section-missing:${dependency.section_revision_id}`);
      else if (dependency.current_revision_id !== dependency.section_revision_id) {
        staleReasons.push(`section-head-changed:${dependency.section_id}`);
      }
    }
  } finally {
    db.close();
  }
  if (!head) staleReasons.push("binding-set-not-head");
  if (bindingSet.confirmedEmpty && bindingSet.emptyConfirmationId) {
    const confirmationCurrentness = await getStudioPanelEntityClosureConfirmationCurrentness(paths.root, bindingSet.emptyConfirmationId);
    if (!confirmationCurrentness?.current) {
      for (const reason of confirmationCurrentness?.staleReasons ?? ["missing"]) {
        staleReasons.push(`empty-confirmation-stale:${reason}`);
      }
    }
  }
  const unit = await getStudioProductionUnitSnapshot(paths.root, bindingSet.unitId);
  if (!unit) {
    staleReasons.push("unit-missing");
  } else {
    const evidenceUnit = unit.unit.revision === bindingSet.unitRevision
      ? unit
      : await readStudioProductionUnitSnapshot(paths.root, bindingSet.unitId, bindingSet.unitRevision);
    const evidencePanel = evidenceUnit?.panels.find((item) => item.index === bindingSet.panelIndex);
    const currentPanel = unit.panels.find((item) => item.index === bindingSet.panelIndex);
    if (!evidenceUnit
      || evidenceUnit.fingerprint !== bindingSet.unitFingerprint
      || !evidencePanel
      || !currentPanel
      || createStudioPanelBindingScopeFingerprint(evidenceUnit, bindingSet.panelIndex)
        !== createStudioPanelBindingScopeFingerprint(unit, bindingSet.panelIndex)) {
      staleReasons.push("unit-changed");
    }
    if (unit.scriptRevision.id !== bindingSet.scriptRevisionId || unit.scriptRevision.bodySha256 !== bindingSet.scriptSha256) staleReasons.push("script-changed");
    if (!currentPanel) staleReasons.push("panel-missing");
    else if (currentPanel.promptRevisionId !== bindingSet.promptRevisionId || currentPanel.promptRevision.bodySha256 !== bindingSet.promptSha256) staleReasons.push("prompt-changed");
  }
  for (const [key, expected] of Object.entries(bindingSet.identityKeyFingerprints)) {
    if (context.identityKeyFingerprints[key] !== expected) staleReasons.push(`identity-key-changed:${key}`);
  }
  const currentAssets = new Map(context.assets.map((asset) => {
    const normalized = normalizeBindingSource(asset);
    return [normalized.assetId, normalized] as const;
  }));
  if (currentAssets.size !== context.assets.length) throw new Error("current context assets 不能重复。");
  for (const binding of bindingSet.bindings) {
    const current = currentAssets.get(binding.assetId);
    if (!current) staleReasons.push(`asset-missing:${binding.assetId}`);
    else if (bindingSourceSemanticFingerprint(current) !== binding.semanticFingerprint) staleReasons.push(`asset-semantic-changed:${binding.assetId}`);
  }
  const uniqueReasons = [...new Set(staleReasons)].sort((left, right) => left.localeCompare(right, "en"));
  return { bindingSetId: bindingSet.id, head, current: uniqueReasons.length === 0, staleReasons: uniqueReasons };
}

export async function getStudioAssetBindingReadiness(
  projectRoot: string,
  bindingSetId: string,
  context: StudioAssetBindingCurrentContext,
): Promise<StudioAssetBindingReadiness | null> {
  const bindingSet = await getStudioAssetBindingSet(projectRoot, bindingSetId);
  if (!bindingSet) return null;
  const currentness = await getStudioAssetBindingSetCurrentness(projectRoot, bindingSetId, context);
  if (!currentness) return null;
  const blockers = currentness.staleReasons.map((reason) => `stale:${reason}`);
  if (bindingSet.bindings.length === 0 && !bindingSet.confirmedEmpty) blockers.push("no-confirmed-bindings");
  const warnings = bindingSet.unresolvedOptionalMentionIds.map((mentionId) => `optional-unresolved:${mentionId}`);
  return {
    ...currentness,
    ready: blockers.length === 0,
    blockers,
    warnings,
  };
}

function normalizeStudioBindingOperationCommand(value: string): StudioBindingOperationCommand {
  if (value !== "analyze_studio_script_entities"
    && value !== "resolve_studio_entity_proposal"
    && value !== "confirm_studio_panel_empty"
    && value !== "freeze_studio_asset_binding_set") {
    throw new Error("Studio binding operation command 无效。");
  }
  return value;
}

function bindingOperationReceiptFromRow(row: Record<string, unknown>): StudioBindingOperationReceipt {
  let outcomeIdentity: unknown;
  try {
    outcomeIdentity = JSON.parse(String(row.outcome_identity_json));
  } catch (error) {
    throw new Error(`Studio binding operation receipt JSON 损坏：${String(row.id)}`, { cause: error });
  }
  if (!outcomeIdentity || typeof outcomeIdentity !== "object" || Array.isArray(outcomeIdentity)) {
    throw new Error(`Studio binding operation receipt outcome 无效：${String(row.id)}`);
  }
  const semantic = {
    requestHash: String(row.request_hash),
    command: normalizeStudioBindingOperationCommand(String(row.command)),
    inputFingerprint: String(row.input_fingerprint),
    outcomeIdentity: outcomeIdentity as Record<string, unknown>,
  };
  const expectedFingerprint = sha256(stableJson(semantic));
  if (expectedFingerprint !== String(row.outcome_fingerprint)) {
    throw new Error(`Studio binding operation receipt fingerprint 漂移：${String(row.id)}`);
  }
  return {
    id: String(row.id),
    ...semantic,
    outcomeFingerprint: expectedFingerprint,
    createdAt: String(row.created_at),
  };
}

function isMissingStudioProductionDatabase(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertStudioBindingProofSnapshotSchema(db: DatabaseSync): void {
  const version = db.prepare(
    "SELECT value FROM studio_production_meta WHERE key = 'schema_version'",
  ).get() as { value?: string } | undefined;
  if (version?.value !== String(SCHEMA_VERSION)) {
    throw new Error(`Studio binding 只读 proof 要求 production schema v${SCHEMA_VERSION}。`);
  }
  const requiredTables = [
    "studio_binding_operation_receipts",
    "studio_asset_mention_analyses",
    "studio_asset_mention_proposals",
    "studio_asset_mention_candidates",
    "studio_asset_mention_decisions",
    "studio_panel_entity_closure_confirmations",
    "studio_asset_binding_sets",
    "studio_asset_bindings",
    "studio_asset_binding_mentions",
    "studio_asset_binding_dependencies",
  ];
  const rows = db.prepare(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name IN (${requiredTables.map(() => "?").join(",")})`,
  ).all(...requiredTables) as Array<{ name: string; sql: string }>;
  const strictTables = new Set(rows
    .filter((row) => /\bSTRICT\s*;?\s*$/iu.test(row.sql ?? ""))
    .map((row) => row.name));
  const missing = requiredTables.filter((table) => !strictTables.has(table));
  if (missing.length > 0) {
    throw new Error(`Studio binding 只读 proof schema 缺少严格表：${missing.join(", ")}。`);
  }
}

/**
 * 从同一份物理只读 SQLite 快照联合校验 operation receipt 与 immutable owner。
 * 不调用 ensureProductionDirectories/openDatabase，也不打开 live DB 的 SQLite handle。
 */
export async function readStudioBindingOperationProofReadOnly(
  projectRoot: string,
  requestHash: string,
  command: StudioBindingOperationCommand,
): Promise<{ receipt: StudioBindingOperationReceipt; outcome: Record<string, unknown> } | undefined> {
  const root = resolveProjectRoot(projectRoot);
  const normalizedHash = assertSha256(requestHash, "requestHash");
  const normalizedCommand = normalizeStudioBindingOperationCommand(command);
  let snapshot: Awaited<ReturnType<typeof openSqliteReadOnlySnapshot>> | null = null;
  try {
    snapshot = await openSqliteReadOnlySnapshot(
      productionPaths(root).database,
      "studio production binding operation proof",
    );
  } catch (error) {
    if (isMissingStudioProductionDatabase(error)) return undefined;
    throw error;
  }
  try {
    const db = snapshot.database;
    assertStudioBindingProofSnapshotSchema(db);
    const receiptRow = db.prepare(
      "SELECT * FROM studio_binding_operation_receipts WHERE request_hash = ?",
    ).get(normalizedHash) as Record<string, unknown> | undefined;
    if (!receiptRow) return undefined;
    const receipt = bindingOperationReceiptFromRow(receiptRow);
    if (receipt.requestHash !== normalizedHash || receipt.command !== normalizedCommand) return undefined;
    const outcome = receipt.outcomeIdentity;

    if (normalizedCommand === "analyze_studio_script_entities") {
      const analysisId = typeof outcome.analysisId === "string" ? outcome.analysisId : "";
      const row = analysisId
        ? db.prepare("SELECT * FROM studio_asset_mention_analyses WHERE id = ?").get(analysisId) as Record<string, unknown> | undefined
        : undefined;
      const analysis = row ? analysisFromRow(db, row) : null;
      if (!analysis
        || analysis.fingerprint !== outcome.analysisFingerprint
        || analysis.revision !== outcome.analysisRevision) return undefined;
    } else if (normalizedCommand === "resolve_studio_entity_proposal") {
      const decisionId = typeof outcome.decisionId === "string" ? outcome.decisionId : "";
      const row = decisionId ? db.prepare(`SELECT d.*, p.presence AS proposal_presence, p.role AS proposal_role
        FROM studio_asset_mention_decisions d
        JOIN studio_asset_mention_proposals p ON p.id = d.proposal_id
        WHERE d.id = ?`).get(decisionId) as Record<string, unknown> | undefined : undefined;
      const decision = row ? decisionFromRow(row) : null;
      if (!decision || decision.fingerprint !== outcome.decisionFingerprint) return undefined;
    } else if (normalizedCommand === "confirm_studio_panel_empty") {
      const confirmationId = typeof outcome.confirmationId === "string" ? outcome.confirmationId : "";
      const row = confirmationId
        ? db.prepare("SELECT * FROM studio_panel_entity_closure_confirmations WHERE id = ?").get(confirmationId) as Record<string, unknown> | undefined
        : undefined;
      const confirmation = row ? panelEntityClosureConfirmationFromRow(row) : null;
      if (!confirmation
        || confirmation.fingerprint !== outcome.confirmationFingerprint
        || confirmation.revision !== outcome.confirmationRevision) return undefined;
    } else {
      const bindingSetId = typeof outcome.bindingSetId === "string" ? outcome.bindingSetId : "";
      const row = bindingSetId
        ? db.prepare("SELECT * FROM studio_asset_binding_sets WHERE id = ?").get(bindingSetId) as Record<string, unknown> | undefined
        : undefined;
      const bindingSet = row ? bindingSetFromRow(db, row) : null;
      if (!bindingSet
        || bindingSet.fingerprint !== outcome.bindingSetFingerprint
        || bindingSet.revision !== outcome.bindingSetRevision) return undefined;
    }
    return { receipt, outcome };
  } finally {
    await snapshot.close();
  }
}

function recordStudioBindingOperationReceiptInTransaction(
  db: DatabaseSync,
  input: RecordStudioBindingOperationReceiptInput,
): StudioBindingOperationReceipt {
  const requestHash = assertSha256(input.requestHash, "requestHash");
  const command = normalizeStudioBindingOperationCommand(input.command);
  const inputFingerprint = assertSha256(input.inputFingerprint, "inputFingerprint");
  if (!input.outcomeIdentity || typeof input.outcomeIdentity !== "object" || Array.isArray(input.outcomeIdentity)) {
    throw new Error("outcomeIdentity 必须是对象。");
  }
  const semantic = {
    requestHash,
    command,
    inputFingerprint,
    outcomeIdentity: input.outcomeIdentity,
  };
  const outcomeFingerprint = sha256(stableJson(semantic));
  const id = `studio-binding-receipt-${requestHash.slice(0, 40)}`;
  const existing = db.prepare("SELECT * FROM studio_binding_operation_receipts WHERE request_hash = ?")
    .get(requestHash) as Record<string, unknown> | undefined;
  if (existing) {
    const receipt = bindingOperationReceiptFromRow(existing);
    if (receipt.outcomeFingerprint !== outcomeFingerprint) {
      throw new Error(`Studio binding operation receipt 请求哈希冲突：${requestHash}`);
    }
    return receipt;
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO studio_binding_operation_receipts(
    id, request_hash, command, input_fingerprint, outcome_identity_json, outcome_fingerprint, created_at
  ) VALUES(?, ?, ?, ?, ?, ?, ?)`).run(
    id, requestHash, command, inputFingerprint, stableJson(input.outcomeIdentity), outcomeFingerprint, now,
  );
  return bindingOperationReceiptFromRow(
    db.prepare("SELECT * FROM studio_binding_operation_receipts WHERE id = ?").get(id) as Record<string, unknown>,
  );
}

export async function recordStudioBindingOperationReceipt(
  projectRoot: string,
  input: RecordStudioBindingOperationReceiptInput,
): Promise<StudioBindingOperationReceipt> {
  const paths = await ensureProductionDirectories(projectRoot);
  const db = openDatabase(paths.database);
  try {
    return runTransaction(db, () => recordStudioBindingOperationReceiptInTransaction(db, input));
  } finally {
    db.close();
  }
}

export async function getStudioBindingOperationReceipt(
  projectRoot: string,
  requestHash: string,
): Promise<StudioBindingOperationReceipt | null> {
  const paths = await ensureProductionDirectories(projectRoot);
  const normalizedHash = assertSha256(requestHash, "requestHash");
  const db = openDatabase(paths.database);
  try {
    const row = db.prepare("SELECT * FROM studio_binding_operation_receipts WHERE request_hash = ?")
      .get(normalizedHash) as Record<string, unknown> | undefined;
    return row ? bindingOperationReceiptFromRow(row) : null;
  } finally {
    db.close();
  }
}
