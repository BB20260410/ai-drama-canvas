<script setup lang="ts">
/**
 * P6 剧本产品环：复用既有 Script Library / Reader / Align / Wizard owner。
 * 读面不推导生产状态；物化必须由用户显式点击，并由 App 经 execute_command 写入。
 */
import { computed, nextTick, ref, watch } from "vue";
import type { StudioProductionUnitSummary } from "@core/studio-production";
import {
  formatPanelCoverageMarks,
  formatPanelLightingCostumeLine,
  formatPanelBeatLine,
  formatPanelShotTypeLine,
  formatStyleLockLine,
  formatWizardStyleLockLine,
  formatPanelStandingGaps,
  formatPanelStandingHandoff,
  formatCharacterBackReferences,
  formatPropBackReferences,
  formatSceneBackReferences,
  formatWizardCharacterBackReferenceLine,
  formatWizardPropBackReferenceLine,
  formatWizardSceneBackReferenceLine,
  listCharacterAssetMentions,
  listCharacterBackReferences,
  listPropAssetMentions,
  listPropBackReferences,
  listSceneAssetMentions,
  listSceneBackReferences,
  wizardCharacterMentionsFromSuggestedIds,
  wizardPropMentionsFromSuggestedIds,
  wizardSceneMentionsFromSuggestedIds,
  pickFirstCoveredPanel,
  pickFirstMissingPanel,
  type SceneBackReference,
  type ScriptLibraryIndex,
  type ScriptSpanMediaHit,
  type ScriptSpanMediaMap,
} from "@core/studio-script-library-projection";
import type { ScriptReaderView } from "@core/studio-script-library-reader";
import type { AlignConsistencyPeek, AlignPanelRow, ScriptMediaAlignBoard, ScriptMediaAlignRow } from "@core/studio-script-media-align";
import type {
  StudioStoryboardWizardSession,
  WizardEditablePanel,
} from "@core/studio-storyboard-wizard";
import type { StudioScriptProductUiApi } from "../material-studio-ui-contract";
import type { Ssl5MissingToGenPlan } from "@core/studio-ssl5-missing-to-gen";
import type { StudioGenerationPlanDraftNode } from "@core/studio-generation-plan-draft";
import { listOrWorkbenchPreviewUrl } from "../studio-list-preview-url";
import StudioGenerationTraceDrawer, { type StudioTraceDrawerModel } from "./StudioGenerationTraceDrawer.vue";
import {
  formatUnitLockPreviousStandingLine,
  formatWizardLockPreviousCostumeLine,
  formatWizardLockPreviousLightingLine,
  wizardPreviousCostumeForPanel,
  wizardPreviousLightingForPanel,
  wizardPreviousStandingForPanel,
} from "@core/studio-panel-standing";

const props = defineProps<{
  projectRoot: string;
  season?: string;
  episode?: string;
  api: StudioScriptProductUiApi;
}>();

const emit = defineEmits<{
  failed: [message: string];
  openUnit: [payload: { unitId: string; target?: "canvas" | "binding" | "review" }];
}>();

type ProductTab = "library" | "reader" | "align" | "wizard";

const activeTab = ref<ProductTab>("library");
const loading = ref(false);
const actionLoading = ref("");
const error = ref("");
const notice = ref("");
const library = ref<ScriptLibraryIndex | null>(null);
const reader = ref<ScriptReaderView | null>(null);
const board = ref<ScriptMediaAlignBoard | null>(null);
const ssl5Plan = ref<Ssl5MissingToGenPlan | null>(null);
const spanMedia = ref<ScriptSpanMediaMap | null>(null);
const units = ref<StudioProductionUnitSummary[]>([]);
const season = ref(props.season ?? "");
const episode = ref(props.episode ?? "");
const selectedDocumentId = ref("");
const showAllScripts = ref(false);
const selectionStart = ref(0);
const selectionEnd = ref(0);
const scriptBodyElement = ref<HTMLTextAreaElement | null>(null);
const panelCount = ref(4);
const wizard = ref<StudioStoryboardWizardSession | null>(null);
const wizardPanels = ref<WizardEditablePanel[]>([]);
const wizardSequence = ref(1);
const wizardUnitTitle = ref("新建 15 秒分镜单元");
const materialized = ref<Awaited<ReturnType<StudioScriptProductUiApi["materializeStoryboardWizard"]>> | null>(null);
const selectedAlignRow = ref<ScriptMediaAlignRow | null>(null);
const selectedAlignPanel = ref<AlignPanelRow | null>(null);
const alignTraceOpen = ref(false);
const alignTraceLoading = ref(false);
const alignTraceError = ref("");
const alignTrace = ref<StudioTraceDrawerModel | null>(null);
let alignTraceLoadSequence = 0;
const selectedMediaPreview = ref<{ mediaUrl: string; thumbnailUrl?: string; kind: string } | null>(null);
const alignShowOriginal = ref(false);
const alignPreviewSrc = computed(() => listOrWorkbenchPreviewUrl({
  thumbnailUrl: selectedMediaPreview.value?.thumbnailUrl,
  mediaUrl: selectedMediaPreview.value?.mediaUrl,
  showOriginal: alignShowOriginal.value,
}));
const alignPreviewPlaceholder = computed(() => {
  if (!selectedAlignPanel.value?.rawSha256 && !selectedAlignRow.value?.rawSha256) return "当前宫格没有 raw 图";
  if (!selectedMediaPreview.value) return "正在读取本地媒体…";
  if (selectedMediaPreview.value.mediaUrl) return "当前宫格没有缩略图；可点打开原图。";
  return "当前宫格没有可显示的预览。";
});

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function report(reason: unknown): void {
  const message = messageOf(reason);
  error.value = message;
  emit("failed", message);
}

function defaultSelectionLength(body: string): number {
  if (body.length <= 2_000) return body.length;
  const end = body.slice(0, 2_000).search(/[。！？.!?]\s*$/u);
  return end > 0 ? end + 1 : 2_000;
}

async function refreshUnitsAndEpisode(): Promise<void> {
  const page = await props.api.listUnits(props.projectRoot, { limit: 100 });
  units.value = page.items;
  const preferred = page.items.find((unit) =>
    (!props.season || unit.season === props.season)
    && (!props.episode || unit.episode === props.episode)
  ) ?? page.items[0];
  if (!season.value) season.value = props.season || preferred?.season || "";
  if (!episode.value) episode.value = props.episode || preferred?.episode || "";
  const currentEpisode = page.items.filter((unit) =>
    unit.season === season.value && unit.episode === episode.value
  );
  wizardSequence.value = Math.max(0, ...currentEpisode.map((unit) => unit.sequence)) + 1;
}

async function loadLibrary(preferredDocumentId?: string): Promise<void> {
  library.value = await props.api.getLibraryIndex(props.projectRoot, {
    kind: "script",
    limit: 50,
  });
  const documentId = preferredDocumentId
    || selectedDocumentId.value
    || library.value.items[0]?.documentId
    || "";
  if (documentId) await selectDocument(documentId, false);
}

async function selectDocument(documentId: string, switchTab = true): Promise<void> {
  if (!documentId) return;
  actionLoading.value = "reader";
  error.value = "";
  try {
    selectedDocumentId.value = documentId;
    reader.value = await props.api.getReaderView(props.projectRoot, {
      documentId,
      ...(season.value && episode.value ? { season: season.value, episode: episode.value } : {}),
      includeBody: true,
    });
    selectionStart.value = 0;
    selectionEnd.value = defaultSelectionLength(reader.value.body);
    wizard.value = null;
    wizardPanels.value = [];
    materialized.value = null;
    if (switchTab) activeTab.value = "reader";
  } catch (reason) {
    report(reason);
  } finally {
    actionLoading.value = "";
  }
}

const ssl5FocusPath = computed(() => {
  if (!ssl5Plan.value?.focusUnitId) return [];
  return ssl5Plan.value.items.find((item) => item.unitId === ssl5Plan.value?.focusUnitId)?.recommendedPath ?? [];
});

const ssl5EarliestNextLine = computed(() => {
  const plan = ssl5Plan.value;
  if (!plan) return "先 Binding 确认再走 freeze → create-plan 链。";
  if (plan.checkpoint?.newSlotDispatchAllowed === false) {
    return plan.generationPlanDraft.blockedReason
      || plan.checkpointLine
      || "六图闸未放行，先完成停检/Review。";
  }
  const step = ssl5FocusPath.value[0];
  if (ssl5FocusPath.value.length === 1 && (step === "wait" || step === "retry" || step === "review")) {
    return plan.generationPlanDraft.blockedReason
      || plan.earliestLabel
      || "下一步以 earliest 为准。";
  }
  if (ssl5FocusPath.value.includes("acquire-lease")) {
    return plan.writeLeaseLine || "写租约未持有；写命令前须 acquire-lease（不派发）";
  }
  return "先 Binding 确认再走 freeze → create-plan 链。";
});

const missingReportOpenItems = computed(() =>
  (board.value?.missingReport.items ?? []).filter((item) => item.status !== "covered"),
);

const wizardAlignCheckpointLine = computed(() =>
  board.value?.checkpointLine ?? "对照板未加载，不自动查六图闸",
);

const wizardAlignWriteLeaseLine = computed(() =>
  board.value?.writeLeaseLine ?? "对照板未加载，不自动查写租约",
);

const wizardPostMaterializeNextLine = computed(() => {
  if (board.value?.checkpoint?.newSlotDispatchAllowed === false) {
    return `下一步：${board.value.checkpointLine}（不跳过 Binding，不自动派发）`;
  }
  if (board.value?.writeLease?.held === false) {
    return "下一步：Binding → acquire-lease → freeze → create-plan → dispatch（不跳过 Binding，不自动派发）";
  }
  return "下一步：Binding → freeze → create-plan → dispatch（不跳过 Binding，不自动派发）";
});

async function copyMissingReport() {
  const report = board.value?.missingReport;
  if (!report) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    notice.value = "已复制缺图报告 JSON。";
  } catch {
    notice.value = "无法复制缺图报告，请改用 MCP missing-media-report。";
  }
}

function reviewDecisionLabel(decision?: string | null): string {
  if (decision === "pass") return "Review 通过";
  if (decision === "rework") return "Review 返工";
  if (decision === "reject") return "Review 驳回";
  if (decision === "pending") return "待 Review";
  return "未审";
}

function formatSsl5PlanDraftNode(node: StudioGenerationPlanDraftNode): string {
  return "targetKind" in node && node.targetKind === "unit-grid"
    ? `unit-grid ${node.unitId}`
    : `${node.unitId} ${node.panelId}`;
}

async function loadAlign(): Promise<void> {
  if (!season.value.trim() || !episode.value.trim()) {
    board.value = null;
    ssl5Plan.value = null;
    return;
  }
  actionLoading.value = "align";
  error.value = "";
  try {
    const query = {
      season: season.value.trim(),
      episode: episode.value.trim(),
    };
    const [nextBoard, nextPlan] = await Promise.all([
      props.api.getStudioScriptMediaAlignBoard(props.projectRoot, query),
      props.api.planSsl5MissingToGen(props.projectRoot, query),
    ]);
    board.value = nextBoard;
    ssl5Plan.value = nextPlan;
    await revealSsl5Focus(nextBoard, nextPlan);
  } catch (reason) {
    report(reason);
  } finally {
    actionLoading.value = "";
  }
}

async function bootstrap(): Promise<void> {
  loading.value = true;
  error.value = "";
  notice.value = "";
  library.value = null;
  reader.value = null;
  board.value = null;
  ssl5Plan.value = null;
  spanMedia.value = null;
  wizard.value = null;
  wizardPanels.value = [];
  selectedDocumentId.value = "";
  season.value = props.season ?? "";
  episode.value = props.episode ?? "";
  try {
    await refreshUnitsAndEpisode();
    await Promise.all([loadLibrary(), loadAlign()]);
  } catch (reason) {
    report(reason);
  } finally {
    loading.value = false;
  }
}

watch(() => props.projectRoot, () => {
  void bootstrap();
}, { immediate: true });

async function importScript(): Promise<void> {
  if (actionLoading.value) return;
  actionLoading.value = "import";
  error.value = "";
  notice.value = "";
  try {
    const result = await props.api.importScript(props.projectRoot);
    if (!result.imported) return;
    await loadLibrary(result.entryId);
    notice.value = result.unchanged
      ? "所选剧本与当前 CAS 修订一致，未重复追加。"
      : "剧本已复制入当前工程并追加不可变修订；原文件未回写。";
  } catch (reason) {
    report(reason);
  } finally {
    actionLoading.value = "";
  }
}

function captureSelection(event: Event): void {
  const element = event.currentTarget as HTMLTextAreaElement;
  selectionStart.value = element.selectionStart;
  selectionEnd.value = element.selectionEnd;
}

async function focusOutline(start: number, end: number): Promise<void> {
  selectionStart.value = start;
  selectionEnd.value = end;
  await nextTick();
  scriptBodyElement.value?.focus();
  scriptBodyElement.value?.setSelectionRange(start, end);
}

function focusUnitHighlight(unit: { unitId: string; sourceSpans: Array<{ startOffsetUtf16: number; endOffsetUtf16: number }> }): void {
  const spans = unit.sourceSpans;
  if (spans.length) {
    const start = Math.min(...spans.map((span) => span.startOffsetUtf16));
    const end = Math.max(...spans.map((span) => span.endOffsetUtf16));
    void focusOutline(start, end);
  } else {
    notice.value = "该单元尚未锚定本修订，不能猜选区。";
  }
  emit("openUnit", { unitId: unit.unitId, target: "canvas" });
}

function onReaderKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "e") {
    event.preventDefault();
    focusEarliestUnit();
  }
}

function focusEarliestUnit(): void {
  const unit = reader.value?.episode?.unitHighlights.find((entry) => entry.isEarliest);
  if (!unit) {
    notice.value = reader.value?.episode?.earliestStatusLine || "当前季/集暂无 earliest 单元。";
    return;
  }
  focusUnitHighlight(unit);
}

const selectionExcerpt = computed(() => {
  if (!reader.value) return "";
  return reader.value.body.slice(selectionStart.value, selectionEnd.value);
});

const selectedLibraryItem = computed(() =>
  library.value?.items.find((item) => item.documentId === (reader.value?.documentId || selectedDocumentId.value)) ?? null,
);

const readerDiagnostics = computed(() => ({
  chars: reader.value?.bodyCharCount ?? 0,
  outline: reader.value?.outline.length ?? 0,
  episodeUnits: reader.value?.episode?.unitHighlights.length ?? 0,
  selectionChars: selectionExcerpt.value.length,
  linkedUnits: selectedLibraryItem.value?.linkedUnitCount ?? 0,
  coveredUnits: selectedLibraryItem.value?.coveredMediaCount ?? 0,
}));

const visibleLibraryItems = computed(() => {
  const items = library.value?.items ?? [];
  if (showAllScripts.value) return items;
  const linked = items.filter((item) => item.linkedUnitCount > 0);
  return linked.length ? linked : items.slice(0, 1);
});

function excerptForPanel(panel: WizardEditablePanel): string {
  if (!reader.value) return "";
  return panel.sourceSpans
    .map((span) => reader.value!.body.slice(span.startOffsetUtf16, span.endOffsetUtf16))
    .join("")
    .trim()
    .slice(0, 2_000);
}

async function lookupSpanMedia(): Promise<void> {
  if (actionLoading.value) return;
  if (selectionEnd.value <= selectionStart.value) {
    report(new Error("请先在正文中选择一个非空片段。"));
    return;
  }
  if (!season.value.trim() || !episode.value.trim()) {
    report(new Error("请先填写季与集，才能对照这段配了哪些图。"));
    return;
  }
  actionLoading.value = "span-media";
  error.value = "";
  notice.value = "";
  try {
    spanMedia.value = await props.api.getStudioScriptSpanMediaMap(props.projectRoot, {
      season: season.value.trim(),
      episode: episode.value.trim(),
      startOffsetUtf16: selectionStart.value,
      endOffsetUtf16: selectionEnd.value,
    });
    notice.value = spanMedia.value.matchCount
      ? `这段相交 ${spanMedia.value.matchCount} 格，其中 ${spanMedia.value.missingCount} 格缺图。`
      : "这段没有相交的宫格锚定。";
  } catch (reason) {
    spanMedia.value = null;
    report(reason);
  } finally {
    actionLoading.value = "";
  }
}

async function suggestWizard(): Promise<void> {
  if (actionLoading.value) return;
  if (!reader.value) return;
  if (selectionEnd.value <= selectionStart.value) {
    report(new Error("请先在正文中选择一个非空片段。"));
    return;
  }
  actionLoading.value = "wizard";
  error.value = "";
  notice.value = "";
  materialized.value = null;
  try {
    const session = await props.api.openStoryboardWizard(props.projectRoot, {
      scriptRevisionId: reader.value.revisionId,
      panelCount: Number(panelCount.value),
      sourceRange: {
        startOffsetUtf16: selectionStart.value,
        endOffsetUtf16: selectionEnd.value,
      },
    });
    wizard.value = session;
    wizardPanels.value = session.panels.map((panel) => ({
      ...panel,
      sourceSpans: panel.sourceSpans.map((span) => ({ ...span })),
      suggestedAssetIds: [...panel.suggestedAssetIds],
      unresolvedProposals: panel.unresolvedProposals.map((proposal) => ({
        ...proposal,
        candidateAssetIds: [...proposal.candidateAssetIds],
      })),
      visualAction: panel.visualAction || excerptForPanel(panel),
    }));
    activeTab.value = "wizard";
    notice.value = `已按原修订选区锚定 ${session.panels.length} 格；物化前仍需检查动作、景别、运镜和总时长。`;
  } catch (reason) {
    report(reason);
  } finally {
    actionLoading.value = "";
  }
}

function wizardStandingLine(panelIndex: number): string | null {
  return formatUnitLockPreviousStandingLine(wizardPreviousStandingForPanel(wizardPanels.value, panelIndex));
}

function wizardLightingLine(panelIndex: number): string | null {
  return formatWizardLockPreviousLightingLine(wizardPreviousLightingForPanel(wizardPanels.value, panelIndex));
}

function wizardCostumeLine(panelIndex: number): string | null {
  return formatWizardLockPreviousCostumeLine(wizardPreviousCostumeForPanel(wizardPanels.value, panelIndex));
}

function wizardStyleLockLine(panelIndex: number): string {
  const panel = wizardPanels.value.find((entry) => entry.panelIndex === panelIndex);
  return formatWizardStyleLockLine({
    boardLoaded: Boolean(board.value),
    suggestedAssetIds: panel?.suggestedAssetIds,
    units: board.value?.rows ?? [],
  });
}

function wizardSceneBackRefLine(panelIndex: number): string {
  const panel = wizardPanels.value.find((entry) => entry.panelIndex === panelIndex);
  return formatWizardSceneBackReferenceLine({
    boardLoaded: Boolean(board.value),
    currentSequence: wizardSequence.value,
    currentPanelIndex: panelIndex,
    suggestedAssetIds: panel?.suggestedAssetIds,
    units: board.value?.rows ?? [],
  });
}

function wizardSceneBackRefs(panelIndex: number): SceneBackReference[] {
  if (!board.value) return [];
  const panel = wizardPanels.value.find((entry) => entry.panelIndex === panelIndex);
  return listSceneBackReferences({
    currentUnitId: "wizard-draft",
    currentSequence: wizardSequence.value,
    currentPanelIndex: panelIndex,
    currentPanelId: `wizard-g${panelIndex}`,
    sceneMentions: wizardSceneMentionsFromSuggestedIds(panel?.suggestedAssetIds, board.value.rows),
    units: board.value.rows,
  });
}

function wizardPropBackRefLine(panelIndex: number): string {
  const panel = wizardPanels.value.find((entry) => entry.panelIndex === panelIndex);
  return formatWizardPropBackReferenceLine({
    boardLoaded: Boolean(board.value),
    currentSequence: wizardSequence.value,
    currentPanelIndex: panelIndex,
    suggestedAssetIds: panel?.suggestedAssetIds,
    units: board.value?.rows ?? [],
  });
}

function wizardPropBackRefs(panelIndex: number): SceneBackReference[] {
  if (!board.value) return [];
  const panel = wizardPanels.value.find((entry) => entry.panelIndex === panelIndex);
  return listPropBackReferences({
    currentUnitId: "wizard-draft",
    currentSequence: wizardSequence.value,
    currentPanelIndex: panelIndex,
    currentPanelId: `wizard-g${panelIndex}`,
    propMentions: wizardPropMentionsFromSuggestedIds(panel?.suggestedAssetIds, board.value.rows),
    units: board.value.rows,
  });
}

function wizardCharacterBackRefLine(panelIndex: number): string {
  const panel = wizardPanels.value.find((entry) => entry.panelIndex === panelIndex);
  return formatWizardCharacterBackReferenceLine({
    boardLoaded: Boolean(board.value),
    currentSequence: wizardSequence.value,
    currentPanelIndex: panelIndex,
    suggestedAssetIds: panel?.suggestedAssetIds,
    units: board.value?.rows ?? [],
  });
}

function wizardCharacterBackRefs(panelIndex: number): SceneBackReference[] {
  if (!board.value) return [];
  const panel = wizardPanels.value.find((entry) => entry.panelIndex === panelIndex);
  return listCharacterBackReferences({
    currentUnitId: "wizard-draft",
    currentSequence: wizardSequence.value,
    currentPanelIndex: panelIndex,
    currentPanelId: `wizard-g${panelIndex}`,
    characterMentions: wizardCharacterMentionsFromSuggestedIds(panel?.suggestedAssetIds, board.value.rows),
    units: board.value.rows,
  });
}

async function revealWizardSceneBackRef(ref: SceneBackReference): Promise<void> {
  if (!board.value) {
    notice.value = "对照板未加载，无法查场景回指。不是 BindingSet，不能当 generation-ready。";
    return;
  }
  activeTab.value = "align";
  await revealSceneBackRef(ref);
}

function reflowWizardTimings(): void {
  let cursor = 0;
  for (const panel of wizardPanels.value) {
    const duration = Number(panel.durationSeconds);
    panel.durationSeconds = Number.isFinite(duration) && duration > 0 ? Math.round(duration * 10) / 10 : 0;
    panel.startSeconds = Math.round(cursor * 10) / 10;
    cursor = Math.round((cursor + panel.durationSeconds) * 10) / 10;
    panel.endSeconds = cursor;
  }
}

const wizardValidationErrors = computed(() => {
  const panels = wizardPanels.value;
  const errors: string[] = [];
  if (panels.length < 2 || panels.length > 6) errors.push("宫格数量必须为 2–6");
  const total = panels.reduce((sum, panel) => sum + Number(panel.durationSeconds || 0), 0);
  if (Math.abs(total - 15) > 0.05) errors.push(`总时长必须为 15 秒，当前 ${Math.round(total * 10) / 10} 秒`);
  panels.forEach((panel) => {
    if (!panel.title.trim()) errors.push(`G${panel.panelIndex} 缺少标题`);
    if (!panel.visualAction.trim()) errors.push(`G${panel.panelIndex} 缺少画面动作`);
    if (!panel.shotComposition.trim()) errors.push(`G${panel.panelIndex} 缺少景别/构图`);
    if (!panel.filmingMethod.trim()) errors.push(`G${panel.panelIndex} 缺少运镜`);
    if (panel.durationSeconds <= 0) errors.push(`G${panel.panelIndex} 时长必须大于 0`);
    if (panel.shotType === "extension" && panel.sourceSpans.length > 0) {
      errors.push(`G${panel.panelIndex} 扩写格不得锚定原文`);
    }
  });
  return errors;
});

async function materializeWizard(): Promise<void> {
  if (!reader.value || !wizard.value || wizardValidationErrors.value.length || actionLoading.value) return;
  actionLoading.value = "materialize";
  error.value = "";
  notice.value = "";
  try {
    materialized.value = await props.api.materializeStoryboardWizard(props.projectRoot, {
      season: season.value.trim(),
      episode: episode.value.trim(),
      sequence: Number(wizardSequence.value),
      unitTitle: wizardUnitTitle.value.trim(),
      scriptRevisionId: reader.value.revisionId,
      panels: wizardPanels.value,
    });
    notice.value = `已物化 ${materialized.value.unitId}；Binding 状态已从 Core 重读，未跳过绑定/冻结门。`;
    await refreshUnitsAndEpisode();
    await loadAlign();
  } catch (reason) {
    report(reason);
  } finally {
    actionLoading.value = "";
  }
}

async function revealSpanMediaHit(hit: ScriptSpanMediaHit): Promise<void> {
  if (actionLoading.value) return;
  actionLoading.value = "span-align";
  error.value = "";
  notice.value = "";
  try {
    let nextBoard = board.value;
    if (!nextBoard) {
      if (!season.value.trim() || !episode.value.trim()) {
        report(new Error("请先填写季与集，才能对照这格。"));
        return;
      }
      const query = {
        season: season.value.trim(),
        episode: episode.value.trim(),
      };
      const [loadedBoard, nextPlan] = await Promise.all([
        props.api.getStudioScriptMediaAlignBoard(props.projectRoot, query),
        props.api.planSsl5MissingToGen(props.projectRoot, query),
      ]);
      board.value = loadedBoard;
      ssl5Plan.value = nextPlan;
      nextBoard = loadedBoard;
    }
    const focusRow = nextBoard.rows.find((row) => row.unitId === hit.unitId);
    if (!focusRow) {
      report(new Error(`对照表没有 ${hit.unitId}，不能猜宫格。`));
      return;
    }
    const focusPanel = focusRow.panels.find((panel) => panel.panelId === hit.panelId);
    if (!focusPanel) {
      report(new Error(`对照表没有 ${hit.unitId} G${hit.panelIndex}，不能猜宫格。`));
      return;
    }
    selectedAlignRow.value = focusRow;
    selectedAlignPanel.value = focusPanel;
    await loadAlignPreview(focusPanel.rawSha256);
    activeTab.value = "align";
    notice.value = `已对照 ${hit.unitId} G${hit.panelIndex}。`;
    await scrollAlignRowIntoView(hit.unitId);
  } catch (reason) {
    report(reason);
  } finally {
    actionLoading.value = "";
  }
}

async function revealReaderSceneBackRef(ref: SceneBackReference): Promise<void> {
  if (actionLoading.value) return;
  if (!board.value) {
    if (!season.value.trim() || !episode.value.trim()) {
      notice.value = "请先填写季与集，才能查场景回指。不是 BindingSet，不能当 generation-ready。";
      return;
    }
    actionLoading.value = "span-align";
    error.value = "";
    try {
      const query = {
        season: season.value.trim(),
        episode: episode.value.trim(),
      };
      const [loadedBoard, nextPlan] = await Promise.all([
        props.api.getStudioScriptMediaAlignBoard(props.projectRoot, query),
        props.api.planSsl5MissingToGen(props.projectRoot, query),
      ]);
      board.value = loadedBoard;
      ssl5Plan.value = nextPlan;
    } catch (reason) {
      report(reason);
      return;
    } finally {
      actionLoading.value = "";
    }
  }
  if (!board.value) {
    notice.value = "对照板未加载，无法查场景回指。不是 BindingSet，不能当 generation-ready。";
    return;
  }
  activeTab.value = "align";
  await revealSceneBackRef(ref);
}

async function revealSsl5Focus(nextBoard: ScriptMediaAlignBoard, nextPlan: Ssl5MissingToGenPlan): Promise<void> {
  const focusRow = nextPlan.focusUnitId
    ? nextBoard.rows.find((row) => row.unitId === nextPlan.focusUnitId)
    : undefined;
  if (!focusRow) return;
  selectedAlignRow.value = focusRow;
  selectedAlignPanel.value = (
    nextPlan.focusPanelId
      ? focusRow.panels.find((panel) => panel.panelId === nextPlan.focusPanelId)
      : undefined
  ) ?? pickFirstMissingPanel(focusRow.panels) ?? pickFirstCoveredPanel(focusRow.panels) ?? null;
  await loadAlignPreview(selectedAlignPanel.value?.rawSha256);
  await scrollAlignRowIntoView(focusRow.unitId);
}

async function scrollAlignRowIntoView(unitId: string): Promise<void> {
  await nextTick();
  const row = document.querySelector(`[data-testid="align-row-${unitId}"]`);
  if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
}

async function loadAlignPreview(rawSha256: string | null | undefined): Promise<void> {
  selectedMediaPreview.value = null;
  alignShowOriginal.value = false;
  if (!rawSha256) return;
  try {
    selectedMediaPreview.value = await props.api.getMediaPreview(props.projectRoot, rawSha256);
  } catch (reason) {
    report(reason);
  }
}

async function selectAlignRow(row: ScriptMediaAlignRow): Promise<void> {
  selectedAlignRow.value = row;
  selectedAlignPanel.value = row.panels.find((panel) => panel.hasMedia)
    ?? pickFirstMissingPanel(row.panels)
    ?? row.panels[0]
    ?? null;
  await loadAlignPreview(selectedAlignPanel.value?.rawSha256);
}

async function selectAlignPanel(panel: AlignPanelRow): Promise<void> {
  selectedAlignPanel.value = panel;
  await loadAlignPreview(panel.rawSha256);
}

function resolveAlignTraceSelector(): { packId: string } | { runId: string } | null {
  if (selectedAlignPanel.value) {
    if (selectedAlignPanel.value.packId) return { packId: selectedAlignPanel.value.packId };
    if (selectedAlignPanel.value.generationRunId) return { runId: selectedAlignPanel.value.generationRunId };
    return null;
  }
  if (selectedAlignRow.value?.packId) return { packId: selectedAlignRow.value.packId };
  if (selectedAlignRow.value?.generationRunId) return { runId: selectedAlignRow.value.generationRunId };
  return null;
}

async function loadAlignGenerationTrace(selector: { packId: string } | { runId: string } | null): Promise<void> {
  if (!props.api.getStudioTrace) {
    alignTraceOpen.value = true;
    alignTraceError.value = "当前桌面适配层未接入 getStudioTrace。";
    alignTrace.value = null;
    return;
  }
  alignTraceOpen.value = true;
  alignTraceError.value = "";
  alignTrace.value = null;
  if (!selector) {
    alignTraceError.value = "需要 pack 或 run。未冻结的宫格不能打开生成追溯，禁止猜第一格。";
    return;
  }
  const sequence = ++alignTraceLoadSequence;
  alignTraceLoading.value = true;
  try {
    const trace = await props.api.getStudioTrace(props.projectRoot, selector);
    if (sequence !== alignTraceLoadSequence) return;
    alignTrace.value = trace;
  } catch (reason) {
    if (sequence !== alignTraceLoadSequence) return;
    alignTraceError.value = messageOf(reason);
  } finally {
    if (sequence === alignTraceLoadSequence) alignTraceLoading.value = false;
  }
}

function openAlignGenerationTrace(): void {
  void loadAlignGenerationTrace(resolveAlignTraceSelector());
}

function closeAlignGenerationTrace(): void {
  alignTraceLoadSequence += 1;
  alignTraceOpen.value = false;
  alignTraceLoading.value = false;
  alignTrace.value = null;
  alignTraceError.value = "";
}

function openHitGenerationTrace(hit: ScriptSpanMediaHit): void {
  const selector = hit.packId
    ? { packId: hit.packId }
    : hit.generationRunId
      ? { runId: hit.generationRunId }
      : null;
  void loadAlignGenerationTrace(selector);
}

async function selectAlignTablePanel(row: ScriptMediaAlignRow, panel: AlignPanelRow): Promise<void> {
  selectedAlignRow.value = row;
  selectedAlignPanel.value = panel;
  await loadAlignPreview(panel.rawSha256);
}

const alignSceneMentions = computed(() => listSceneAssetMentions(selectedAlignPanel.value?.assetMentions));

const alignSceneBackRefs = computed(() => {
  const row = selectedAlignRow.value;
  const panel = selectedAlignPanel.value;
  if (!board.value || !row || !panel) return [];
  return listSceneBackReferences({
    currentUnitId: row.unitId,
    currentSequence: row.sequence,
    currentPanelIndex: panel.panelIndex,
    currentPanelId: panel.panelId,
    sceneMentions: alignSceneMentions.value,
    units: board.value.rows,
  });
});

const alignSceneBackRefLine = computed(() => {
  if (!selectedAlignPanel.value) return null;
  return formatSceneBackReferences(alignSceneMentions.value.length, alignSceneBackRefs.value);
});

const alignPropMentions = computed(() => listPropAssetMentions(selectedAlignPanel.value?.assetMentions));

const alignPropBackRefs = computed(() => {
  const row = selectedAlignRow.value;
  const panel = selectedAlignPanel.value;
  if (!board.value || !row || !panel) return [];
  return listPropBackReferences({
    currentUnitId: row.unitId,
    currentSequence: row.sequence,
    currentPanelIndex: panel.panelIndex,
    currentPanelId: panel.panelId,
    propMentions: alignPropMentions.value,
    units: board.value.rows,
  });
});

const alignPropBackRefLine = computed(() => {
  if (!selectedAlignPanel.value) return null;
  return formatPropBackReferences(alignPropMentions.value.length, alignPropBackRefs.value);
});

const alignCharacterMentions = computed(() => listCharacterAssetMentions(selectedAlignPanel.value?.assetMentions));

const alignCharacterBackRefs = computed(() => {
  const row = selectedAlignRow.value;
  const panel = selectedAlignPanel.value;
  if (!board.value || !row || !panel) return [];
  return listCharacterBackReferences({
    currentUnitId: row.unitId,
    currentSequence: row.sequence,
    currentPanelIndex: panel.panelIndex,
    currentPanelId: panel.panelId,
    characterMentions: alignCharacterMentions.value,
    units: board.value.rows,
  });
});

const alignCharacterBackRefLine = computed(() => {
  if (!selectedAlignPanel.value) return null;
  return formatCharacterBackReferences(alignCharacterMentions.value.length, alignCharacterBackRefs.value);
});

async function revealSceneBackRef(ref: SceneBackReference): Promise<void> {
  const focusRow = board.value?.rows.find((row) => row.unitId === ref.unitId);
  if (!focusRow) {
    notice.value = `对照表没有 ${ref.unitId}，不能猜宫格。`;
    return;
  }
  const focusPanel = focusRow.panels.find((panel) => panel.panelId === ref.panelId);
  if (!focusPanel) {
    notice.value = `对照表没有 ${ref.unitId} G${ref.panelIndex}，不能猜宫格。`;
    return;
  }
  await selectAlignTablePanel(focusRow, focusPanel);
  notice.value = `已回指 ${ref.unitId} G${ref.panelIndex}。快照提及，不是 BindingSet。`;
  await scrollAlignRowIntoView(ref.unitId);
}

function peekLabel(peek?: AlignConsistencyPeek): string {
  if (!peek || peek.status === "unevaluated" || !peek.verdict) return "未评估";
  if (peek.verdict === "consistent") return "一致";
  if (peek.verdict === "needs-review") return "需复核";
  if (peek.verdict === "drifted") return "明显漂移";
  return "无法检查";
}

function statusLabel(status: string): string {
  return ({ covered: "有图", partial: "部分", "missing-all": "缺图" } as Record<string, string>)[status] ?? status;
}

function shortSha(value: string | null | undefined): string {
  return value ? `${value.slice(0, 12)}…` : "—";
}
</script>

<template>
  <section class="script-product" data-testid="script-media-align-view" :aria-busy="loading || Boolean(actionLoading)">
    <header class="product-header">
      <div>
        <span class="eyebrow">P6 · SCRIPT PRODUCT LOOP</span>
        <h2>剧本库与 15 秒分镜</h2>
        <p>同一事实源内完成阅读、图文对照、选区拆格与显式物化。</p>
      </div>
      <div class="episode-filter">
        <label><span>季</span><input v-model.trim="season" data-testid="align-season" /></label>
        <label><span>集</span><input v-model.trim="episode" data-testid="align-episode" /></label>
        <button type="button" data-testid="align-reload" :disabled="Boolean(actionLoading)" @click="loadAlign">
          {{ actionLoading === "align" ? "读取中…" : "刷新本集" }}
        </button>
      </div>
    </header>

    <nav class="product-tabs" aria-label="剧本产品环">
      <button type="button" :class="{ active: activeTab === 'library' }" data-testid="script-product-tab-library" @click="activeTab = 'library'">剧本库</button>
      <button type="button" :class="{ active: activeTab === 'reader' }" data-testid="script-product-tab-reader" :disabled="!reader" @click="activeTab = 'reader'">阅读器</button>
      <button type="button" :class="{ active: activeTab === 'align' }" data-testid="script-product-tab-align" @click="activeTab = 'align'; loadAlign()">图文对照</button>
      <button type="button" :class="{ active: activeTab === 'wizard' }" data-testid="script-product-tab-wizard" :disabled="!reader" @click="activeTab = 'wizard'">15 秒向导</button>
    </nav>

    <p v-if="error" class="banner error" role="alert">{{ error }}</p>
    <p v-if="notice" class="banner notice" role="status">{{ notice }}</p>
    <div v-if="loading" class="empty" role="status">正在读取当前工程剧本产品投影…</div>

    <main v-else-if="activeTab === 'library'" class="library-layout" data-testid="script-library-pane">
      <aside class="document-list">
        <div class="pane-heading">
          <div><b>当前工程剧本</b><small>仅 script；不混入 prompt</small></div>
          <div class="pane-actions">
            <button type="button" data-testid="script-library-toggle-all" @click="showAllScripts = !showAllScripts">
              {{ showAllScripts ? "仅看在产" : `查看全部 ${library?.items.length ?? 0}` }}
            </button>
            <button
              type="button"
              data-testid="script-library-import"
              :disabled="Boolean(actionLoading)"
              :title="actionLoading ? '正在处理，不能再导入剧本' : undefined"
              @click="importScript"
            >
              {{ actionLoading === "import" ? "导入中…" : "导入新剧本" }}
            </button>
          </div>
        </div>
        <button
          v-for="item in visibleLibraryItems"
          :key="item.documentId"
          type="button"
          class="document-card"
          :class="{ active: item.documentId === selectedDocumentId }"
          :data-testid="`script-library-document-${item.documentId}`"
          @click="selectDocument(item.documentId)"
        >
          <b>{{ item.title }}</b>
          <span>Head r{{ item.headRevision }} · {{ item.revisionCount }} 个不可变修订</span>
          <span>关联 {{ item.linkedUnitCount }} 个生产单元 · 有图 {{ item.coveredMediaCount }}</span>
          <code>{{ item.documentId }}</code>
        </button>
        <div v-if="!(library?.items.length)" class="empty">当前工程还没有剧本文档。</div>
      </aside>

      <section v-if="reader" class="library-diagnostics" data-testid="script-library-diagnostics">
        <span class="eyebrow">CURRENT SCRIPT</span>
        <h3>{{ reader.documentTitle }}</h3>
        <dl>
          <div><dt>当前修订</dt><dd>r{{ reader.revisionOrdinal }}</dd></div>
          <div><dt>正文字符</dt><dd>{{ readerDiagnostics.chars }}</dd></div>
          <div><dt>大纲节点</dt><dd>{{ readerDiagnostics.outline }}</dd></div>
          <div><dt>本集单元</dt><dd>{{ readerDiagnostics.episodeUnits }}</dd></div>
          <div><dt>关联单元</dt><dd>{{ readerDiagnostics.linkedUnits }}</dd></div>
          <div><dt>有图单元</dt><dd data-testid="script-library-covered-media">{{ readerDiagnostics.coveredUnits }}</dd></div>
        </dl>
        <div class="qc-card">
          <b>提示词 / QC 诊断</b>
          <p>正文 CAS：<code>{{ shortSha(reader.bodySha256) }}</code></p>
          <p>{{ reader.outline.length ? "已识别 Markdown 场景/章节导航。" : "未识别 Markdown 标题；仍可按文本选区拆格。" }}</p>
          <p>{{ reader.episode?.earliestStatusLine || "当前季/集暂无 earliest 诊断。" }}</p>
          <p v-if="reader.episode?.earliestReason" data-testid="script-reader-earliest-reason">{{ reader.episode.earliestReason }}</p>
          <p>向导提示词只有显式物化后才写入 prompt owner；只读建议不会建立正式单元。</p>
        </div>
        <button type="button" class="primary" @click="activeTab = 'reader'">打开阅读器</button>
      </section>
    </main>

    <main v-else-if="activeTab === 'reader' && reader" class="reader-layout" data-testid="script-reader-pane" tabindex="0" @keydown="onReaderKeydown">
      <aside class="reader-nav">
        <h3>章节 / 场景</h3>
        <button
          v-for="heading in reader.outline"
          :key="`${heading.lineIndex}-${heading.startOffsetUtf16}`"
          type="button"
          :style="{ paddingLeft: `${8 + heading.level * 8}px` }"
          @click="focusOutline(heading.startOffsetUtf16, heading.endOffsetUtf16)"
        >{{ heading.title }}</button>
        <h3>本集单元</h3>
        <button
          v-for="unit in reader.episode?.unitHighlights ?? []"
          :key="unit.unitId"
          type="button"
          :class="{ earliest: unit.isEarliest }"
          :data-testid="`script-reader-unit-${unit.unitId}`"
          @click="focusUnitHighlight(unit)"
        >
          {{ unit.sequence }} · {{ unit.title }}
          <small>{{ unit.formalCommitted ? "formal" : "未关账" }}</small>
        </button>
      </aside>
      <section class="reader-body">
        <div class="selection-status">
          <span>r{{ reader.revisionOrdinal }} · {{ shortSha(reader.bodySha256) }}</span>
          <b>选区 {{ selectionStart }}–{{ selectionEnd }} · {{ readerDiagnostics.selectionChars }} 字符</b>
          <button
            type="button"
            data-testid="script-reader-focus-earliest"
            :disabled="Boolean(actionLoading)"
            @click="focusEarliestUnit"
          >定位当前单元</button>
          <button
            type="button"
            data-testid="script-reader-span-media"
            :disabled="Boolean(actionLoading)"
            :title="actionLoading ? '正在处理，不能再查这段配图' : undefined"
            @click="lookupSpanMedia"
          >
            {{ actionLoading === "span-media" ? "对照中…" : "这段配了哪些图" }}
          </button>
          <button
            type="button"
            data-testid="script-reader-to-wizard"
            :disabled="Boolean(actionLoading)"
            :title="actionLoading ? '正在处理，不能再生成分镜建议' : undefined"
            @click="suggestWizard"
          >
            {{ actionLoading === "wizard" ? "拆格中…" : "按选区生成 15 秒分镜" }}
          </button>
        </div>
        <div v-if="spanMedia" class="span-media" data-testid="script-reader-span-media-board">
          <b>这段配图</b>
          <span>相交 {{ spanMedia.matchCount }} 格 · 缺图 {{ spanMedia.missingCount }}</span>
          <ul>
            <li v-for="hit in spanMedia.hits" :key="`${hit.unitId}-${hit.panelId}`" :data-testid="`span-media-hit-${hit.panelId}`">
              <div class="span-media-hit-copy">
                <b>{{ hit.unitId }} G{{ hit.panelIndex }} · {{ hit.hasMedia ? "有图" : "缺图" }}</b>
                <small data-testid="span-media-hit-standing">{{ hit.shotComposition || "构图未记" }} · {{ hit.visualAction || "动作未记" }} · {{ hit.filmingMethod || "运镜未记" }}</small>
                <small data-testid="span-media-hit-handoff">{{ formatPanelStandingHandoff(hit.previousHandoff) }}</small>
                <small data-testid="span-media-hit-gaps">{{ formatPanelStandingGaps(hit) }}</small>
                <small data-testid="span-media-hit-lighting">{{ formatPanelLightingCostumeLine(hit) }}</small>
                <small data-testid="span-media-hit-shot-type">{{ hit.shotTypeLine }}</small>
                <small data-testid="span-media-hit-style-lock">{{ hit.styleLockLine }}</small>
                <small data-testid="span-media-hit-beat">{{ hit.beatLine }}</small>
                <small data-testid="span-media-hit-scene-backrefs">{{ hit.sceneBackReferenceLine }}</small>
                <small data-testid="span-media-hit-prop-backrefs">{{ hit.propBackReferenceLine }}</small>
                <small data-testid="span-media-hit-character-backrefs">{{ hit.characterBackReferenceLine }}</small>
                <small data-testid="span-media-hit-peek">{{ peekLabel(hit.consistencyPeek) }}</small>
                <button
                  v-for="ref in hit.sceneBackReferences"
                  :key="`${ref.unitId}:${ref.panelId}:${ref.assetId}`"
                  type="button"
                  :data-testid="`span-media-hit-scene-backref-${ref.unitId}-${ref.panelId}`"
                  :disabled="Boolean(actionLoading)"
                  @click="revealReaderSceneBackRef(ref)"
                >U{{ ref.sequence }} G{{ ref.panelIndex }} {{ ref.role || ref.assetId }}</button>
                <button
                  v-for="ref in hit.propBackReferences"
                  :key="`prop:${ref.unitId}:${ref.panelId}:${ref.assetId}`"
                  type="button"
                  :data-testid="`span-media-hit-prop-backref-${ref.unitId}-${ref.panelId}`"
                  :disabled="Boolean(actionLoading)"
                  @click="revealReaderSceneBackRef(ref)"
                >U{{ ref.sequence }} G{{ ref.panelIndex }} {{ ref.role || ref.assetId }}</button>
                <button
                  v-for="ref in hit.characterBackReferences"
                  :key="`char:${ref.unitId}:${ref.panelId}:${ref.assetId}`"
                  type="button"
                  :data-testid="`span-media-hit-character-backref-${ref.unitId}-${ref.panelId}`"
                  :disabled="Boolean(actionLoading)"
                  @click="revealReaderSceneBackRef(ref)"
                >U{{ ref.sequence }} G{{ ref.panelIndex }} {{ ref.role || ref.assetId }}</button>
              </div>
              <div class="span-media-hit-actions">
                <button
                  type="button"
                  data-testid="span-media-hit-align"
                  :disabled="Boolean(actionLoading)"
                  :title="actionLoading ? '正在处理，不能再对照这格' : undefined"
                  @click="revealSpanMediaHit(hit)"
                >对照这格</button>
                <button
                  type="button"
                  data-testid="span-media-hit-trace"
                  :disabled="!hit.packId && !hit.generationRunId || !api.getStudioTrace"
                  @click="openHitGenerationTrace(hit)"
                >打开追溯</button>
                <button type="button" @click="emit('openUnit', { unitId: hit.unitId, target: hit.hasMedia ? 'review' : 'binding' })">
                  {{ hit.hasMedia ? "审片" : "去 Binding" }}
                </button>
              </div>
            </li>
          </ul>
          <p v-if="!spanMedia.hits.length">没有相交的宫格锚定；不能猜选区。</p>
        </div>
        <textarea
          ref="scriptBodyElement"
          class="script-body"
          data-testid="script-reader-body"
          :value="reader.body"
          readonly
          spellcheck="false"
          @select="captureSelection"
          @keyup="captureSelection"
          @mouseup="captureSelection"
        />
      </section>
    </main>

    <main v-else-if="activeTab === 'align'" class="align-layout" data-testid="script-align-pane">
      <section class="align-table-wrap">
        <div v-if="board" class="summary" data-testid="align-summary">
          <span>单元 <b>{{ board.unitCount }}</b></span>
          <span class="ok">有图 <b>{{ board.coveredCount }}</b></span>
          <span class="warn">部分 <b>{{ board.partialCount }}</b></span>
          <span class="danger">缺图 <b>{{ board.missingAllCount }}</b></span>
          <span v-if="board.earliestStatusLine" class="earliest">{{ board.earliestStatusLine }}</span>
          <span data-testid="align-checkpoint-gate">{{ board.checkpointLine }}</span>
          <span data-testid="align-write-lease">{{ board.writeLeaseLine }}</span>
        </div>
        <div v-if="ssl5Plan" class="ssl5-plan" data-testid="ssl5-missing-to-gen-plan">
          <b>SSL-5 下一步</b>
          <span data-testid="ssl5-focus-unit">{{ ssl5Plan.focusUnitId || "无缺图焦点" }}</span>
          <span v-if="ssl5Plan.focusPanelId" data-testid="ssl5-focus-panel">G{{ ssl5Plan.focusPanelIndex }} {{ ssl5Plan.focusPanelId }}</span>
          <span v-if="ssl5Plan.previousPanelIndex != null" data-testid="ssl5-focus-handoff">前镜 G{{ ssl5Plan.previousPanelIndex }} {{ ssl5Plan.previousShotComposition || "构图未记" }} · {{ ssl5Plan.previousVisualAction || "动作未记" }} · {{ ssl5Plan.previousFilmingMethod || "运镜未记" }}</span>
          <span v-if="ssl5Plan.focusPanelId" data-testid="ssl5-focus-standing-gaps">{{ ssl5Plan.standingGapLine }}</span>
          <span v-if="ssl5Plan.focusPanelId" data-testid="ssl5-focus-lighting">{{ ssl5Plan.lightingCostumeLine }}</span>
          <span v-if="ssl5Plan.focusPanelId" data-testid="ssl5-focus-shot-type">{{ ssl5Plan.shotTypeLine }}</span>
          <span v-if="ssl5Plan.focusPanelId" data-testid="ssl5-focus-style-lock">{{ ssl5Plan.styleLockLine }}</span>
          <span v-if="ssl5Plan.focusPanelId" data-testid="ssl5-focus-beat">{{ ssl5Plan.beatLine }}</span>
          <span v-if="ssl5Plan.focusPanelId" data-testid="ssl5-focus-unit-beat">{{ ssl5Plan.unitBeatLine }}</span>
          <span v-if="ssl5Plan.previousLightingLine" data-testid="ssl5-focus-previous-lighting">{{ ssl5Plan.previousLightingLine }}</span>
          <span v-if="ssl5Plan.previousCostumeLine" data-testid="ssl5-focus-previous-costume">{{ ssl5Plan.previousCostumeLine }}</span>
          <span v-if="ssl5Plan.focusPanelId" data-testid="ssl5-focus-scene-backrefs">{{ ssl5Plan.sceneBackReferenceLine }}</span>
          <span v-if="ssl5Plan.focusPanelId" data-testid="ssl5-focus-prop-backrefs">{{ ssl5Plan.propBackReferenceLine }}</span>
          <span v-if="ssl5Plan.focusPanelId" data-testid="ssl5-focus-character-backrefs">{{ ssl5Plan.characterBackReferenceLine }}</span>
          <span data-testid="ssl5-focus-peek">{{ peekLabel(ssl5Plan.consistencyPeek) }}</span>
          <button
            v-for="ref in ssl5Plan.sceneBackReferences"
            :key="`${ref.unitId}:${ref.panelId}:${ref.assetId}`"
            type="button"
            :data-testid="`ssl5-focus-scene-backref-${ref.unitId}-${ref.panelId}`"
            :disabled="Boolean(actionLoading)"
            @click="revealSceneBackRef(ref)"
          >U{{ ref.sequence }} G{{ ref.panelIndex }} {{ ref.role || ref.assetId }}</button>
          <button
            v-for="ref in ssl5Plan.propBackReferences"
            :key="`prop:${ref.unitId}:${ref.panelId}:${ref.assetId}`"
            type="button"
            :data-testid="`ssl5-focus-prop-backref-${ref.unitId}-${ref.panelId}`"
            :disabled="Boolean(actionLoading)"
            @click="revealSceneBackRef(ref)"
          >U{{ ref.sequence }} G{{ ref.panelIndex }} {{ ref.role || ref.assetId }}</button>
          <button
            v-for="ref in ssl5Plan.characterBackReferences"
            :key="`char:${ref.unitId}:${ref.panelId}:${ref.assetId}`"
            type="button"
            :data-testid="`ssl5-focus-character-backref-${ref.unitId}-${ref.panelId}`"
            :disabled="Boolean(actionLoading)"
            @click="revealSceneBackRef(ref)"
          >U{{ ref.sequence }} G{{ ref.panelIndex }} {{ ref.role || ref.assetId }}</button>
          <span>缺图 {{ ssl5Plan.missingAllCount }} · 部分 {{ ssl5Plan.partialCount }}</span>
          <span v-if="ssl5Plan.focusPackId" data-testid="ssl5-focus-pack">{{ ssl5Plan.focusPackId }}</span>
          <span data-testid="ssl5-generation-plan-draft">{{ ssl5Plan.generationPlanDraft.ready ? "可建立计划（不派发）" : ssl5Plan.generationPlanDraft.blockedReason }}</span>
          <span v-if="ssl5Plan.generationPlanDraft.ready" data-testid="ssl5-generation-plan-command">{{ ssl5Plan.generationPlanDraft.command }}</span>
          <span v-if="ssl5Plan.generationPlanDraft.ready && ssl5Plan.generationPlanDraft.nodes?.[0]" data-testid="ssl5-generation-plan-nodes">{{ formatSsl5PlanDraftNode(ssl5Plan.generationPlanDraft.nodes[0]) }}</span>
          <ol v-if="ssl5FocusPath.length">
            <li v-for="step in ssl5FocusPath" :key="step">{{ step }}</li>
          </ol>
          <p>只读计划，不自动 dispatch，不执行 create-plan。<span data-testid="ssl5-earliest-next">{{ ssl5EarliestNextLine }}</span></p>
          <span data-testid="ssl5-checkpoint-next">{{ ssl5Plan.checkpointLine }}</span>
          <span data-testid="ssl5-write-lease">{{ ssl5Plan.writeLeaseLine }}</span>
          <button
            v-if="ssl5Plan.focusUnitId"
            type="button"
            data-testid="ssl5-open-binding"
            @click="emit('openUnit', { unitId: ssl5Plan.focusUnitId, target: 'binding' })"
          >去 Binding 确认</button>
        </div>
        <div v-if="board?.missingReport" class="missing-report" data-testid="align-missing-report">
          <b>缺图报告</b>
          <span>全缺 {{ board.missingReport.missingAllCount }} · 部分 {{ board.missingReport.partialCount }}</span>
          <button
            type="button"
            data-testid="align-missing-report-copy"
            @click="copyMissingReport"
          >复制 JSON</button>
          <ul v-if="missingReportOpenItems.length">
            <li
              v-for="item in missingReportOpenItems"
              :key="item.unitId"
              :data-testid="`align-missing-report-${item.unitId}`"
            >{{ item.unitId }} {{ item.status === "missing-all" ? "全缺" : "部分" }} 缺 {{ item.missingPanelCount }}/{{ item.panelCount }}</li>
          </ul>
          <p v-else>没有缺图或部分覆盖单元。</p>
        </div>
        <table v-if="board" data-testid="align-table">
          <thead><tr><th>单元</th><th>状态</th><th>宫格</th><th>四态</th><th>formal</th><th>Review</th><th>raw</th><th>pack / run</th><th>点穿</th></tr></thead>
          <tbody>
            <tr
              v-for="row in board.rows"
              :key="row.unitId"
              :class="[`status-${row.status}`, { earliest: row.isEarliest, selected: row.unitId === selectedAlignRow?.unitId }]"
              :data-testid="`align-row-${row.unitId}`"
              @click="selectAlignRow(row)"
            >
              <td><b>{{ row.unitId }}</b><small>{{ row.title }}</small></td>
              <td>{{ statusLabel(row.status) }}</td>
              <td class="mono" :data-testid="`align-panels-${row.unitId}`">
                <div v-if="row.panels.length" class="align-table-panels" :title="formatPanelCoverageMarks(row.panels)">
                  <button
                    v-for="panel in row.panels"
                    :key="panel.panelId"
                    type="button"
                    :class="{ active: selectedAlignRow?.unitId === row.unitId && selectedAlignPanel?.panelId === panel.panelId }"
                    :data-testid="`align-table-panel-${panel.panelId}`"
                    @click.stop="selectAlignTablePanel(row, panel)"
                  >G{{ panel.panelIndex }}{{ panel.hasMedia ? "有" : "缺" }}</button>
                </div>
                <template v-else>—</template>
              </td>
              <td :data-testid="`align-peek-${row.unitId}`">{{ peekLabel(row.consistencyPeek) }}</td>
              <td>{{ row.formalCommitted ? "是" : "否" }}</td>
              <td :data-testid="`align-review-${row.unitId}`">{{ reviewDecisionLabel(row.reviewDecision) }}</td>
              <td class="mono">{{ shortSha(row.rawSha256) }}</td>
              <td class="mono">
                <div v-if="row.packId">pack: {{ row.packId.slice(0, 28) }}…</div>
                <div v-if="row.generationRunId">run: {{ row.generationRunId }}</div>
                <div v-if="!row.packId && !row.generationRunId">—</div>
              </td>
              <td>
                <button type="button" @click.stop="emit('openUnit', { unitId: row.unitId, target: 'canvas' })">画布</button>
                <button type="button" @click.stop="emit('openUnit', { unitId: row.unitId, target: 'binding' })">绑定</button>
                <button type="button" @click.stop="emit('openUnit', { unitId: row.unitId, target: 'review' })">审片</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">当前季/集没有可用图文对照投影。</div>
      </section>
      <aside class="media-preview" data-testid="align-media-preview">
        <template v-if="selectedAlignRow">
          <span class="eyebrow">DIRECT MEDIA</span>
          <h3>{{ selectedAlignRow.unitId }}</h3>
          <p v-if="selectedAlignPanel">G{{ selectedAlignPanel.panelIndex }} {{ selectedAlignPanel.title || selectedAlignPanel.panelId }}</p>
          <p data-testid="align-panel-peek">{{ peekLabel(selectedAlignPanel?.consistencyPeek ?? selectedAlignRow.consistencyPeek) }}</p>
          <ul v-if="selectedAlignRow.panels.length" class="align-panels" data-testid="align-panel-list">
            <li v-for="panel in selectedAlignRow.panels" :key="panel.panelId">
              <button
                type="button"
                :class="{ active: panel.panelId === selectedAlignPanel?.panelId }"
                :data-testid="`align-panel-${panel.panelId}`"
                @click="selectAlignPanel(panel)"
              >
                G{{ panel.panelIndex }}{{ panel.hasMedia ? "有" : "缺" }}
              </button>
            </li>
          </ul>
          <img
            v-if="alignPreviewSrc"
            :src="alignPreviewSrc"
            :alt="`${selectedAlignRow.unitId} raw 结果`"
            decoding="async"
          />
          <div v-else class="preview-placeholder">{{ alignPreviewPlaceholder }}</div>
          <button
            v-if="selectedMediaPreview?.mediaUrl && !alignShowOriginal"
            type="button"
            data-testid="align-open-original"
            @click="alignShowOriginal = true"
          >打开原图</button>
          <dl>
            <div><dt>raw</dt><dd><code>{{ selectedAlignPanel?.rawSha256 || selectedAlignRow.rawSha256 || "—" }}</code></dd></div>
            <div><dt>labeled</dt><dd><code>{{ selectedAlignPanel?.labeledSha256 || selectedAlignRow.labeledSha256 || "—" }}</code></dd></div>
            <div><dt>原文锚</dt><dd>{{ selectedAlignPanel?.sourceSpans.length ?? selectedAlignRow.sourceSpans.length }}</dd></div>
            <div><dt>pack</dt><dd><code data-testid="align-panel-pack">{{ selectedAlignPanel?.packId || selectedAlignRow.packId || "—" }}</code></dd></div>
            <div><dt>run</dt><dd><code data-testid="align-panel-run">{{ selectedAlignPanel?.generationRunId || selectedAlignRow.generationRunId || "—" }}</code></dd></div>
            <div>
              <dt>追溯</dt>
              <dd>
                <button
                  type="button"
                  data-testid="align-open-trace"
                  :disabled="!resolveAlignTraceSelector() || !api.getStudioTrace"
                  @click="openAlignGenerationTrace"
                >打开生成追溯</button>
              </dd>
            </div>
            <div><dt>构图</dt><dd data-testid="align-panel-composition">{{ selectedAlignPanel?.shotComposition || "—" }}</dd></div>
            <div><dt>动作</dt><dd data-testid="align-panel-action">{{ selectedAlignPanel?.visualAction || "—" }}</dd></div>
            <div><dt>运镜</dt><dd data-testid="align-panel-filming">{{ selectedAlignPanel?.filmingMethod || "—" }}</dd></div>
            <div><dt>光线</dt><dd data-testid="align-panel-lighting">{{ selectedAlignPanel?.sceneLighting || "—" }}</dd></div>
            <div><dt>服化</dt><dd data-testid="align-panel-costume">{{ selectedAlignPanel?.costumeState || "—" }}</dd></div>
            <div><dt>镜头类型</dt><dd data-testid="align-panel-shot-type">{{ formatPanelShotTypeLine(selectedAlignPanel) }}</dd></div>
            <div><dt>风格锁</dt><dd data-testid="align-panel-style-lock">{{ formatStyleLockLine(selectedAlignPanel?.assetMentions ?? null) }}</dd></div>
            <div><dt>15s 节拍</dt><dd data-testid="align-panel-beat">{{ formatPanelBeatLine(selectedAlignPanel) }}</dd></div>
            <div><dt>前镜</dt><dd data-testid="align-panel-handoff">{{ formatPanelStandingHandoff(selectedAlignPanel?.previousHandoff) }}</dd></div>
            <div><dt>站位缺口</dt><dd data-testid="align-panel-standing-gaps">{{ formatPanelStandingGaps(selectedAlignPanel) }}</dd></div>
            <div>
              <dt>快照提及</dt>
              <dd data-testid="align-panel-assets">
                <template v-if="selectedAlignPanel?.assetMentions.length">
                  <p v-for="asset in selectedAlignPanel.assetMentions" :key="asset.assetId">{{ asset.category || "资产" }} {{ asset.role || asset.assetId }}</p>
                </template>
                <template v-else>—</template>
                <small>快照提及，不是 BindingSet，不能当 generation-ready。</small>
              </dd>
            </div>
            <div v-if="alignSceneBackRefLine">
              <dt>场景回指</dt>
              <dd data-testid="align-panel-scene-backrefs">
                <p>{{ alignSceneBackRefLine }}</p>
                <button
                  v-for="ref in alignSceneBackRefs"
                  :key="`${ref.unitId}:${ref.panelId}:${ref.assetId}`"
                  type="button"
                  :data-testid="`align-scene-backref-${ref.unitId}-${ref.panelId}`"
                  @click="revealSceneBackRef(ref)"
                >U{{ ref.sequence }} G{{ ref.panelIndex }} {{ ref.role || ref.assetId }}</button>
              </dd>
            </div>
            <div v-if="alignPropBackRefLine">
              <dt>道具回指</dt>
              <dd data-testid="align-panel-prop-backrefs">
                <p>{{ alignPropBackRefLine }}</p>
                <button
                  v-for="ref in alignPropBackRefs"
                  :key="`prop:${ref.unitId}:${ref.panelId}:${ref.assetId}`"
                  type="button"
                  :data-testid="`align-prop-backref-${ref.unitId}-${ref.panelId}`"
                  @click="revealSceneBackRef(ref)"
                >U{{ ref.sequence }} G{{ ref.panelIndex }} {{ ref.role || ref.assetId }}</button>
              </dd>
            </div>
            <div v-if="alignCharacterBackRefLine">
              <dt>角色回指</dt>
              <dd data-testid="align-panel-character-backrefs">
                <p>{{ alignCharacterBackRefLine }}</p>
                <button
                  v-for="ref in alignCharacterBackRefs"
                  :key="`char:${ref.unitId}:${ref.panelId}:${ref.assetId}`"
                  type="button"
                  :data-testid="`align-character-backref-${ref.unitId}-${ref.panelId}`"
                  @click="revealSceneBackRef(ref)"
                >U{{ ref.sequence }} G{{ ref.panelIndex }} {{ ref.role || ref.assetId }}</button>
              </dd>
            </div>
          </dl>
        </template>
        <div v-else class="empty">点击一行查看本地 raw/labeled 身份与缩略图。</div>
      </aside>
    </main>

    <main v-else-if="activeTab === 'wizard' && reader" class="wizard-layout" data-testid="storyboard-wizard-pane">
      <section class="wizard-source">
        <h3>1 · 原文选区</h3>
        <p>{{ selectionStart }}–{{ selectionEnd }} · {{ selectionExcerpt.length }} 字符</p>
        <blockquote>{{ selectionExcerpt || "请回阅读器选择原文。" }}</blockquote>
        <div class="wizard-controls">
          <label>宫格数 <input v-model.number="panelCount" type="number" min="2" max="6" data-testid="storyboard-wizard-panel-count" /></label>
          <button
            type="button"
            data-testid="storyboard-wizard-suggest"
            :disabled="Boolean(actionLoading)"
            :title="actionLoading ? '正在处理，不能再生成分镜建议' : undefined"
            @click="suggestWizard"
          >
            {{ actionLoading === "wizard" ? "建议中…" : "重新生成建议" }}
          </button>
        </div>
      </section>

      <section class="wizard-editor">
        <h3>2 · 编辑 2–6 格</h3>
        <div v-if="!wizard" class="empty">点击“重新生成建议”，再逐格补齐动作、构图、运镜、光线和服化。</div>
        <article
          v-for="panel in wizardPanels"
          :key="panel.panelIndex"
          class="panel-editor"
          :data-testid="`storyboard-wizard-panel-${panel.panelIndex}`"
        >
          <header><b>G{{ panel.panelIndex }} · {{ panel.shotType }}</b><code>{{ panel.startSeconds }}–{{ panel.endSeconds }}s</code></header>
          <label>标题 <input v-model.trim="panel.title" /></label>
          <label class="wide">画面动作 <textarea v-model.trim="panel.visualAction" rows="3" /></label>
          <label>景别 / 构图 <input v-model.trim="panel.shotComposition" /></label>
          <label>运镜 <input v-model.trim="panel.filmingMethod" /></label>
          <label>光线 <input v-model.trim="panel.sceneLighting" data-testid="storyboard-wizard-lighting" /></label>
          <label>服化 <input v-model.trim="panel.costumeState" data-testid="storyboard-wizard-costume" /></label>
          <p class="wide wizard-lock-hint" data-testid="storyboard-wizard-shot-type">{{ formatPanelShotTypeLine(panel) }}</p>
          <p class="wide wizard-lock-hint" data-testid="storyboard-wizard-style-lock">{{ wizardStyleLockLine(panel.panelIndex) }}</p>
          <p class="wide wizard-lock-hint" data-testid="storyboard-wizard-beat">{{ formatPanelBeatLine(panel) }}</p>
          <label>对白 <input v-model.trim="panel.dialogue" /></label>
          <label>时长 <input v-model.number="panel.durationSeconds" type="number" min="0.1" max="15" step="0.1" @change="reflowWizardTimings" /></label>
          <p
            v-if="wizardStandingLine(panel.panelIndex)"
            class="wide wizard-lock-hint wizard-previous-standing"
            data-testid="storyboard-wizard-previous-standing"
          >{{ wizardStandingLine(panel.panelIndex) }}</p>
          <p
            v-if="wizardLightingLine(panel.panelIndex)"
            class="wide wizard-lock-hint wizard-previous-lighting"
            data-testid="storyboard-wizard-previous-lighting"
          >{{ wizardLightingLine(panel.panelIndex) }}</p>
          <p
            v-if="wizardCostumeLine(panel.panelIndex)"
            class="wide wizard-lock-hint wizard-previous-costume"
            data-testid="storyboard-wizard-previous-costume"
          >{{ wizardCostumeLine(panel.panelIndex) }}</p>
          <p class="wide wizard-lock-hint" data-testid="storyboard-wizard-scene-backrefs">{{ wizardSceneBackRefLine(panel.panelIndex) }}</p>
          <button
            v-for="ref in wizardSceneBackRefs(panel.panelIndex)"
            :key="`${ref.unitId}:${ref.panelId}:${ref.assetId}`"
            type="button"
            class="wide"
            :data-testid="`storyboard-wizard-scene-backref-${ref.unitId}-${ref.panelId}`"
            @click="revealWizardSceneBackRef(ref)"
          >U{{ ref.sequence }} G{{ ref.panelIndex }} {{ ref.role || ref.assetId }}</button>
          <p class="wide wizard-lock-hint" data-testid="storyboard-wizard-prop-backrefs">{{ wizardPropBackRefLine(panel.panelIndex) }}</p>
          <button
            v-for="ref in wizardPropBackRefs(panel.panelIndex)"
            :key="`prop:${ref.unitId}:${ref.panelId}:${ref.assetId}`"
            type="button"
            class="wide"
            :data-testid="`storyboard-wizard-prop-backref-${ref.unitId}-${ref.panelId}`"
            @click="revealWizardSceneBackRef(ref)"
          >U{{ ref.sequence }} G{{ ref.panelIndex }} {{ ref.role || ref.assetId }}</button>
          <p class="wide wizard-lock-hint" data-testid="storyboard-wizard-character-backrefs">{{ wizardCharacterBackRefLine(panel.panelIndex) }}</p>
          <button
            v-for="ref in wizardCharacterBackRefs(panel.panelIndex)"
            :key="`char:${ref.unitId}:${ref.panelId}:${ref.assetId}`"
            type="button"
            class="wide"
            :data-testid="`storyboard-wizard-character-backref-${ref.unitId}-${ref.panelId}`"
            @click="revealWizardSceneBackRef(ref)"
          >U{{ ref.sequence }} G{{ ref.panelIndex }} {{ ref.role || ref.assetId }}</button>
          <small class="wide">原文锚 {{ panel.sourceSpans.length }} · 资产建议 {{ panel.suggestedAssetIds.length }} · 歧义 {{ panel.unresolvedProposals.length }}</small>
        </article>
      </section>

      <aside class="wizard-materialize">
        <h3>3 · 显式物化</h3>
        <label>季 <input v-model.trim="season" /></label>
        <label>集 <input v-model.trim="episode" /></label>
        <label>序号 <input v-model.number="wizardSequence" type="number" min="1" /></label>
        <label>单元标题 <input v-model.trim="wizardUnitTitle" /></label>
        <div class="validation" :class="{ ok: !wizardValidationErrors.length }">
          <b>{{ wizardValidationErrors.length ? "尚不能物化" : "机械校验通过" }}</b>
          <p v-for="validationError in wizardValidationErrors" :key="validationError">{{ validationError }}</p>
          <p v-if="!wizardValidationErrors.length">2–6 格、15 秒、动作和时间线已闭合；仍需后续 Binding / freeze / create-plan。</p>
        </div>
        <span data-testid="storyboard-wizard-checkpoint">{{ wizardAlignCheckpointLine }}</span>
        <span data-testid="storyboard-wizard-write-lease">{{ wizardAlignWriteLeaseLine }}</span>
        <button
          type="button"
          class="primary"
          data-testid="storyboard-wizard-materialize"
          :disabled="!wizard || Boolean(wizardValidationErrors.length) || Boolean(actionLoading) || !wizardUnitTitle.trim()"
          :title="actionLoading ? '正在处理，不能再物化分镜' : undefined"
          @click="materializeWizard"
        >{{ actionLoading === "materialize" ? "写入中…" : "经命令总线物化" }}</button>
        <div v-if="materialized" class="materialized-result" data-testid="storyboard-wizard-materialized">
          <b>{{ materialized.unitId }}</b>
          <p>unit r{{ materialized.unitRevision }} · prompt {{ materialized.promptRevisionId }}</p>
          <p v-for="panel in materialized.panelStatuses" :key="panel.panelId">G{{ panel.panelIndex }}：{{ panel.status }}</p>
          <p data-testid="storyboard-wizard-next">{{ wizardPostMaterializeNextLine }}</p>
          <button type="button" @click="emit('openUnit', { unitId: materialized.unitId, target: 'binding' })">进入 Binding</button>
        </div>
      </aside>
    </main>
    <StudioGenerationTraceDrawer
      :open="alignTraceOpen"
      :loading="alignTraceLoading"
      :error="alignTraceError"
      :trace="alignTrace"
      @close="closeAlignGenerationTrace"
    />
  </section>
</template>

<style scoped>
.script-product{position:relative;height:100%;min-height:620px;overflow:auto;padding:18px 22px 48px;box-sizing:border-box;background:var(--ui-bg,#121310);color:var(--ui-text,#e8e6dc);font-size:11px}
.product-header{display:flex;flex-wrap:wrap;gap:18px;justify-content:space-between;align-items:flex-end;margin-bottom:12px}
.eyebrow{color:var(--ui-accent,#d7af55);font:700 9px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em}
h2{margin:4px 0;font-size:19px}h3{margin:0 0 10px;font-size:13px}.product-header p{margin:0;color:var(--ui-text-2,#8f9287)}
.episode-filter,.wizard-controls{display:flex;gap:8px;align-items:end}.episode-filter label,.wizard-controls label,.panel-editor label,.wizard-materialize label{display:grid;gap:4px;color:var(--ui-text-2,#8f9287)}
input,textarea{box-sizing:border-box;border:1px solid var(--ui-line,#34362f);border-radius:4px;background:var(--ui-surface-2,#1a1c17);color:inherit;padding:7px 8px;font:inherit}.episode-filter input{width:90px}
button{border:1px solid var(--ui-line,#34362f);border-radius:4px;background:var(--ui-surface,#20221d);color:inherit;padding:7px 10px;cursor:pointer;font:inherit}button:hover:not(:disabled){border-color:var(--ui-accent,#d7af55)}button:disabled{opacity:.45;cursor:not-allowed}.primary,.episode-filter button,.wizard-controls button{background:var(--ui-accent,#d7af55);color:var(--ui-accent-contrast,#1a160c);border-color:transparent;font-weight:700}
.product-tabs{display:flex;gap:3px;margin:0 0 12px;border-bottom:1px solid var(--ui-line,#34362f)}.product-tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--ui-text-2,#8f9287)}.product-tabs button.active{border-bottom-color:var(--ui-accent,#d7af55);color:var(--ui-accent,#d7af55)}
.banner{margin:0 0 10px;padding:8px 10px;border:1px solid;border-radius:4px}.banner.error{border-color:#8f4f45;background:#2a1815;color:#edb0a2}.banner.notice{border-color:#6e6036;background:#292412;color:#e7cf8a}.empty{padding:22px;color:var(--ui-text-2,#8f9287)}
.library-layout{display:grid;grid-template-columns:minmax(320px,.9fr) minmax(360px,1.1fr);gap:14px}.document-list,.library-diagnostics,.reader-nav,.reader-body,.align-table-wrap,.media-preview,.wizard-source,.wizard-editor,.wizard-materialize{border:1px solid var(--ui-line,#34362f);background:var(--ui-surface,#171914);border-radius:5px;padding:12px;min-width:0}
.pane-heading{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:9px}.pane-actions{display:flex;gap:5px}.pane-heading small,.document-card span,.document-card code{display:block;color:var(--ui-text-2,#8f9287);margin-top:4px;font-size:9px}.document-card{width:100%;display:block;margin-bottom:6px;text-align:left;padding:10px;content-visibility:auto;contain-intrinsic-size:auto 56px}.document-card.active{border-color:var(--ui-accent,#d7af55);background:color-mix(in srgb,var(--ui-accent,#d7af55) 8%,transparent)}
.library-diagnostics h3{font-size:18px;margin-top:4px}.library-diagnostics dl{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.library-diagnostics dl div,.media-preview dl div{padding:8px;background:var(--ui-surface-2,#1a1c17)}dt{color:var(--ui-text-2,#8f9287);font-size:9px}dd{margin:4px 0 0;word-break:break-all}.qc-card{margin:12px 0;padding:12px;border-left:2px solid var(--ui-accent,#d7af55);background:var(--ui-surface-2,#1a1c17)}.qc-card p{margin:6px 0;color:var(--ui-text-2,#a6a99e)}
.reader-layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:12px}.reader-nav{max-height:680px;overflow:auto}.reader-nav h3:not(:first-child){margin-top:16px}.reader-nav button{width:100%;display:flex;justify-content:space-between;text-align:left;border:0;border-radius:0;background:transparent;color:var(--ui-text-2,#a6a99e);content-visibility:auto;contain-intrinsic-size:auto 28px}.reader-nav button.earliest{color:var(--ui-accent,#d7af55)}.reader-nav small{font-size:8px}.reader-body{padding:0;overflow:hidden}.span-media{padding:10px;border-bottom:1px solid var(--ui-line,#34362f);background:var(--ui-surface-2,#1a1c17)}.span-media b,.span-media span,.span-media p{display:block;margin:4px 0}.span-media li{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin:6px 0}.span-media-hit-copy{min-width:0;flex:1}.span-media-hit-copy small{display:block;color:var(--ui-text-2,#8f9287);margin-top:2px}.span-media-hit-actions{display:flex;flex-direction:column;gap:4px;flex-shrink:0}
.selection-status{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:10px;border-bottom:1px solid var(--ui-line,#34362f)}.selection-status span{color:var(--ui-text-2,#8f9287)}.selection-status button{background:var(--ui-accent,#d7af55);color:var(--ui-accent-contrast,#1a160c)}.script-body{display:block;width:100%;height:620px;resize:none;border:0;border-radius:0;padding:18px;font:12px/1.75 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}
.align-layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:12px}.align-table-wrap{overflow:auto}.summary{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:10px;color:var(--ui-text-2,#a6a99e)}.summary .ok b{color:#8fbf7a}.summary .warn b{color:#d7af55}.summary .danger b{color:#d08370}.summary .earliest{width:100%;font-size:9px}.ssl5-plan,.missing-report{margin:0 0 10px;padding:10px;border:1px solid var(--ui-line,#34362f);background:var(--ui-surface-2,#1a1c17)}.ssl5-plan b,.ssl5-plan span,.ssl5-plan p,.missing-report b,.missing-report span,.missing-report p{display:block;margin:4px 0}.ssl5-plan ol,.missing-report ul{margin:6px 0;padding-left:18px;color:var(--ui-text-2,#a6a99e)}table{width:100%;border-collapse:collapse;font-size:10px}th,td{border-bottom:1px solid var(--ui-line,#2a2c26);padding:7px 5px;text-align:left;vertical-align:top}th{color:var(--ui-text-2,#8f9287);font-weight:500}td b,td small{display:block}td small{color:var(--ui-text-2,#8f9287)}.mono{font:9px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}.status-missing-all{background:rgba(208,131,112,.06)}tr.earliest td:first-child b::after{content:" · earliest";color:var(--ui-accent,#d7af55);font-weight:400}tr.selected{outline:1px solid var(--ui-accent,#d7af55);outline-offset:-1px}td button{padding:3px 5px;margin:0 2px 2px 0}.align-panels{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0;padding:0;list-style:none}.align-panels button.active{border-color:var(--ui-accent,#d7af55);color:var(--ui-accent,#d7af55)}.align-table-panels{display:flex;flex-wrap:wrap;gap:3px}.align-table-panels button{padding:2px 5px;font-size:9px}.align-table-panels button.active{border-color:var(--ui-accent,#d7af55);color:var(--ui-accent,#d7af55)}.media-preview img{display:block;width:100%;max-height:420px;object-fit:contain;background:#080908;border:1px solid var(--ui-line,#34362f)}.preview-placeholder{min-height:220px;display:grid;place-items:center;background:#0c0d0b;color:var(--ui-text-2,#8f9287)}.media-preview dl{display:grid;gap:5px}.media-preview code{font-size:8px;word-break:break-all}
.wizard-layout{display:grid;grid-template-columns:250px minmax(420px,1fr) 280px;gap:12px;align-items:start}.wizard-source blockquote{max-height:360px;overflow:auto;margin:10px 0;padding:10px;border-left:2px solid var(--ui-accent,#d7af55);background:var(--ui-surface-2,#1a1c17);white-space:pre-wrap;line-height:1.6}.wizard-controls{flex-wrap:wrap}.wizard-controls input{width:70px}.panel-editor{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px;border:1px solid var(--ui-line,#34362f);border-radius:4px;margin-bottom:8px}.panel-editor header,.panel-editor .wide{grid-column:1/-1}.panel-editor header{display:flex;justify-content:space-between}.panel-editor input,.panel-editor textarea,.wizard-materialize input{width:100%}.panel-editor small,.wizard-lock-hint{color:var(--ui-text-2,#8f9287)}.wizard-lock-hint{margin:2px 0 0;font-size:10px}.wizard-materialize{display:grid;gap:8px;position:sticky;top:8px}.validation{padding:9px;border:1px solid #8f4f45;background:#2a1815;color:#edb0a2}.validation.ok{border-color:#55754a;background:#162415;color:#a9d39a}.validation p{margin:5px 0}.materialized-result{padding:9px;border:1px solid #55754a;background:#162415}.materialized-result p{margin:4px 0;color:#a9d39a}.materialized-result b{word-break:break-all}
@media (max-width:1100px){.wizard-layout{grid-template-columns:1fr}.wizard-materialize{position:static}.align-layout{grid-template-columns:1fr}.library-layout{grid-template-columns:1fr}}
</style>
