import {
  boundedCursorPageItems,
  commitCursorFirstPage,
  commitCursorNextPage,
  commitCursorPreviousPage,
  createCursorPaginationState,
  resetCursorPaginationState,
  type CursorPaginationState,
} from "./use-cursor-pagination.js";

export const STUDIO_BINDING_PAGE_LIMIT = 36;
export const STUDIO_BINDING_PANEL_MIN = 2;
export const STUDIO_BINDING_PANEL_MAX = 6;
export const STUDIO_BINDING_CANDIDATE_LIMIT = 6;
export const STUDIO_BINDING_SOURCE_EXCERPT_LIMIT = 220;

export type StudioBindingTimelineStatus =
  | "pending"
  | "unchecked"
  | "ambiguous"
  | "unmatched"
  | "bound"
  | "stale"
  | "generation-ready";

export type StudioBindingEntityCategory = "character" | "scene" | "prop" | "style";
export type StudioBindingProposalStatus = "matched" | "ambiguous" | "unmatched" | "excluded";
export type StudioBindingPresence = "required" | "optional" | "forbidden";
export type StudioBindingResolutionDecision = "accept" | "select" | "exclude";

export interface StudioBindingStatusPresentation {
  label: string;
  description: string;
  tone: "quiet" | "warning" | "danger" | "success" | "stale";
}

export interface StudioBindingSeasonOption {
  id: string;
  label: string;
}

export interface StudioBindingEpisodeOption {
  id: string;
  seasonId: string;
  label: string;
}

export interface StudioBindingUnitSummary {
  id: string;
  seasonId: string;
  seasonLabel: string;
  episodeId: string;
  episodeLabel: string;
  label: string;
  durationSeconds: number;
  panelCount: number;
  status: StudioBindingTimelineStatus;
  /** 由 Core 给出的状态说明；UI 不根据计数重算。 */
  statusReason?: string;
}

export interface StudioBindingUnitPage {
  items: StudioBindingUnitSummary[];
  seasons: StudioBindingSeasonOption[];
  episodes: StudioBindingEpisodeOption[];
  nextCursor?: string;
  total?: number;
  /** 唯一下一步必须由 Core 返回，UI 只展示。 */
  nextAction?: string;
}

export interface StudioBindingSourceExcerpt {
  id: string;
  sourceRevisionId: string;
  startOffset: number;
  endOffset: number;
  text: string;
  sha256?: string;
  /** Core 返回的章节/场景来源；UI 只展示，不自行推断层级。 */
  sections: Array<{
    revisionId: string;
    sectionId: string;
    revision: number;
    kind: "chapter" | "scene";
    title: string;
    fingerprint: string;
  }>;
}

export interface StudioBindingCandidate {
  assetId: string;
  assetName: string;
  category: StudioBindingEntityCategory;
  matchKind: string;
  scoreLabel?: string;
  authorityLabel?: string;
}

export interface StudioBindingProposal {
  id: string;
  sourceExcerptId: string;
  entityText: string;
  entityCategory: StudioBindingEntityCategory;
  status: StudioBindingProposalStatus;
  matchKind: string;
  candidates: StudioBindingCandidate[];
  /** matched 时由 Core 明确给出；UI 永不把第一个候选当作默认。 */
  matchedAssetId?: string;
  resolvedAssetId?: string;
  presence: StudioBindingPresence;
  role: string;
  blockerCodes: string[];
  statusReason?: string;
}

export interface StudioBindingBlocker {
  code: string;
  message: string;
  severity: "blocking" | "warning";
}

export interface StudioBindingSetSummary {
  id: string;
  fingerprint: string;
  currentness: "current" | "stale";
  frozenAt: string;
}

export interface StudioBindingEmptyConfirmationSummary {
  id: string;
  fingerprint: string;
  revision: number;
  reviewer: "user" | "codex";
  note: string;
  currentness: "current" | "stale";
  confirmedAt: string;
}

export interface StudioBindingPanel {
  id: string;
  ordinal: number;
  label: string;
  startSeconds: number;
  endSeconds: number;
  status: StudioBindingTimelineStatus;
  statusReason?: string;
  sourceExcerpts: StudioBindingSourceExcerpt[];
  proposals: StudioBindingProposal[];
  blockers: StudioBindingBlocker[];
  emptyConfirmation?: StudioBindingEmptyConfirmationSummary;
  /** Core 的 confirmed-empty 准入结论；UI 不从 proposals=0 自动推断。 */
  confirmEmptyAllowed: boolean;
  /** Core 的准入结论；UI 不从 blockers、proposal 或 currentness 推导。 */
  freezeAllowed: boolean;
  bindingSet?: StudioBindingSetSummary;
}

export interface StudioBindingControlSnapshot {
  /** Core 数据修订令牌，原样带回写命令。 */
  revisionToken: string;
  nextAction: string;
  unit: StudioBindingUnitSummary;
  panels: StudioBindingPanel[];
  selectedPanelId?: string;
}

export interface StudioBindingUnitQuery {
  seasonId?: string;
  episodeId?: string;
  cursor?: string;
  limit: typeof STUDIO_BINDING_PAGE_LIMIT;
}

export interface StudioBindingControlQuery {
  unitId: string;
}

export interface StudioBindingAnalyzeInput {
  unitId: string;
  panelId: string;
  expectedRevisionToken: string;
  /** Codex/MCP 可扩展这组待审提议；桌面 UI 不生成、不自动决策。 */
  extractedMentions?: import("../../core/studio-binding-control.js").StudioBindingExtractedMentionInput[];
}

export interface StudioBindingResolveInput {
  unitId: string;
  panelId: string;
  proposalId: string;
  decision: StudioBindingResolutionDecision;
  selectedAssetId?: string;
  presence: StudioBindingPresence;
  role: string;
  expectedRevisionToken: string;
  reviewer: "user";
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
  reviewer: "user";
  note: string;
}

export interface StudioBindingMutationResult {
  revisionToken?: string;
  message?: string;
}

/**
 * UI 适配边界。读取方法返回完整投影，四个写方法应由主线程适配到
 * analyze_studio_script_entities / resolve_studio_entity_proposal /
 * confirm_studio_panel_empty / freeze_studio_asset_binding_set；组件本身不写 localStorage、SQLite 或画布状态。
 */
export interface StudioBindingWorkbenchApi {
  listUnits(projectRoot: string, query: StudioBindingUnitQuery): Promise<StudioBindingUnitPage>;
  getControl(projectRoot: string, query: StudioBindingControlQuery): Promise<StudioBindingControlSnapshot>;
  analyze(projectRoot: string, input: StudioBindingAnalyzeInput): Promise<StudioBindingMutationResult>;
  resolve(projectRoot: string, input: StudioBindingResolveInput): Promise<StudioBindingMutationResult>;
  confirmEmpty(projectRoot: string, input: StudioBindingConfirmEmptyInput): Promise<StudioBindingMutationResult>;
  freeze(projectRoot: string, input: StudioBindingFreezeInput): Promise<StudioBindingMutationResult>;
}

/** 绑定工作台游标 = 统一 CursorPaginationState（Qwen D1）。 */
export type StudioBindingCursorState = CursorPaginationState;

export interface StudioBindingRequestToken {
  stream: string;
  revision: number;
}

export interface StudioBindingRequestGate {
  issue(stream: string): StudioBindingRequestToken;
  isCurrent(token: StudioBindingRequestToken): boolean;
  invalidate(stream: string): void;
  invalidateAll(): void;
}

export interface StudioBindingResolutionDraft {
  selectedAssetId: string;
  presence: StudioBindingPresence;
  role: string;
}

export function studioBindingStatusPresentation(status: StudioBindingTimelineStatus): StudioBindingStatusPresentation {
  return ({
    pending: { label: "待解析", description: "等待系统解析剧本实体。", tone: "quiet" },
    unchecked: { label: "待核验", description: "列表未执行深度当前性核验，请打开单元。", tone: "quiet" },
    ambiguous: { label: "歧义", description: "存在多个候选，必须人工选择。", tone: "warning" },
    unmatched: { label: "未匹配", description: "没有可确认的规范资产。", tone: "danger" },
    bound: { label: "已绑定", description: "人工决策已记录，等待冻结。", tone: "success" },
    stale: { label: "已过期", description: "上游事实已变化，需要重新核验。", tone: "stale" },
    "generation-ready": { label: "可以生图", description: "系统已确认人物、场景和道具绑定完整。", tone: "success" },
  } satisfies Record<StudioBindingTimelineStatus, StudioBindingStatusPresentation>)[status];
}

export function createStudioBindingCursorState(): StudioBindingCursorState {
  return createCursorPaginationState();
}

export function resetStudioBindingCursorState(state: StudioBindingCursorState): void {
  resetCursorPaginationState(state);
}

export function commitStudioBindingFirstPage(state: StudioBindingCursorState, nextCursor?: string): void {
  commitCursorFirstPage(state, nextCursor);
}

export function commitStudioBindingNextPage(
  state: StudioBindingCursorState,
  requestedCursor: string,
  nextCursor?: string,
): void {
  commitCursorNextPage(state, requestedCursor, nextCursor, "绑定工作台分页游标已漂移，拒绝提交过期页面。");
}

export function commitStudioBindingPreviousPage(
  state: StudioBindingCursorState,
  requestedCursor: string | undefined,
  nextCursor?: string,
): void {
  commitCursorPreviousPage(state, requestedCursor, nextCursor, "绑定工作台分页历史已漂移，拒绝提交过期页面。");
}

export function boundedStudioBindingUnits(items: readonly StudioBindingUnitSummary[]): StudioBindingUnitSummary[] {
  return boundedCursorPageItems(items, STUDIO_BINDING_PAGE_LIMIT);
}

export function boundedStudioBindingCandidates(items: readonly StudioBindingCandidate[]): StudioBindingCandidate[] {
  return [...new Map(items.map((item) => [item.assetId, item] as const)).values()].slice(0, STUDIO_BINDING_CANDIDATE_LIMIT);
}

export function assertStudioBindingPanelCount(panels: readonly StudioBindingPanel[]): void {
  if (panels.length < STUDIO_BINDING_PANEL_MIN || panels.length > STUDIO_BINDING_PANEL_MAX) {
    throw new Error(`15 秒单元必须由 ${STUDIO_BINDING_PANEL_MIN}–${STUDIO_BINDING_PANEL_MAX} 格组成，当前为 ${panels.length} 格。`);
  }
  if (new Set(panels.map((panel) => panel.id)).size !== panels.length) {
    throw new Error("15 秒单元包含重复 panel id，拒绝渲染。");
  }
}

export function boundedStudioBindingSourceExcerpt(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= STUDIO_BINDING_SOURCE_EXCERPT_LIMIT) return normalized;
  return `${normalized.slice(0, STUDIO_BINDING_SOURCE_EXCERPT_LIMIT - 1)}…`;
}

export function createStudioBindingRequestGate(): StudioBindingRequestGate {
  const revisions = new Map<string, number>();
  return {
    issue(stream) {
      const revision = (revisions.get(stream) ?? 0) + 1;
      revisions.set(stream, revision);
      return { stream, revision };
    },
    isCurrent(token) {
      return revisions.get(token.stream) === token.revision;
    },
    invalidate(stream) {
      revisions.set(stream, (revisions.get(stream) ?? 0) + 1);
    },
    invalidateAll() {
      for (const stream of revisions.keys()) revisions.set(stream, (revisions.get(stream) ?? 0) + 1);
    },
  };
}

export function createStudioBindingResolutionDraft(proposal: StudioBindingProposal): StudioBindingResolutionDraft {
  return {
    // 已有人工决策只使用 Core 返回的 resolvedAssetId；未决 ambiguous/unmatched 绝不预选 candidates[0]。
    selectedAssetId: proposal.resolvedAssetId
      ?? (proposal.status === "matched" ? proposal.matchedAssetId ?? "" : ""),
    presence: proposal.presence,
    role: proposal.role,
  };
}

export function buildStudioBindingResolveInput(
  snapshot: StudioBindingControlSnapshot,
  panel: StudioBindingPanel,
  proposal: StudioBindingProposal,
  draft: StudioBindingResolutionDraft,
  decision: StudioBindingResolutionDecision,
): StudioBindingResolveInput {
  const selectedAssetId = decision === "accept" ? proposal.matchedAssetId : decision === "select" ? draft.selectedAssetId : undefined;
  if ((decision === "accept" || decision === "select") && !selectedAssetId) {
    throw new Error(decision === "accept" ? "Core 未提供可接受的明确匹配。" : "请先人工选择一个规范资产。");
  }
  return {
    unitId: snapshot.unit.id,
    panelId: panel.id,
    proposalId: proposal.id,
    decision,
    ...(selectedAssetId ? { selectedAssetId } : {}),
    presence: draft.presence,
    role: draft.role.trim(),
    expectedRevisionToken: snapshot.revisionToken,
    reviewer: "user",
  };
}

export function studioBindingFreezeDisabled(panel: StudioBindingPanel): boolean {
  // freezeAllowed 是 Core 投影，不能根据 proposal 数量、blocker 文案或状态在 UI 重算。
  return !panel.freezeAllowed;
}
