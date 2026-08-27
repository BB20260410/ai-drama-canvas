/**
 * SSL-4 · 15 秒分镜向导（建议 → 人工改 → 可选物化 unit）
 *
 * - suggest：封装 P20 suggestStudioStoryboardDraft（只读）
 * - applyPanelEdits：纯函数合并 Agent/人工字段（不自动变正式）
 * - materialize：create prompt + create_studio_production_unit（显式调用才写）
 * extension 规则保持 P20；不跳过 Binding/freeze/create-plan 链（物化后仍走 readiness，不自动派发）
 */
import {
  suggestStudioStoryboardDraft,
  type StudioStoryboardDraftPanelSuggestion,
  type StudioStoryboardDraftSuggestion,
} from "./studio-storyboard-draft.js";
import {
  appendStudioPromptRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  getStudioTextRevision,
  type StudioAssetCategory,
  type StudioProductionPanelInput,
} from "./studio-production.js";
import { getStudioCanonicalAsset } from "./material-studio.js";
import {
  formatWizardPromptBody,
  listWizardMaterializeValidationErrors,
  listWizardMissingSuggestedAssetErrors,
} from "./studio-panel-standing.js";

export const STORYBOARD_WIZARD_SCHEMA_VERSION = 1 as const;
/** 物化后只读下一步。不跳过 Binding，不自动派发，中间必须 create-plan。 */
export const WIZARD_POST_MATERIALIZE_NEXT =
  "物化后走 Binding→readiness→freeze→create-plan→dispatch（不跳过 Binding，不自动派发）";

export interface WizardPanelEdit {
  panelIndex: number;
  title?: string;
  visualAction?: string;
  shotComposition?: string;
  filmingMethod?: string;
  dialogue?: string;
  transition?: string;
  costumeState?: string;
  sceneLighting?: string;
  negativePrompt?: string;
  suggestedAssetIds?: string[];
  unresolvedProposals?: StudioStoryboardDraftPanelSuggestion["unresolvedProposals"];
}

export interface WizardEditablePanel extends StudioStoryboardDraftPanelSuggestion {
  title: string;
  visualAction: string;
  shotComposition: string;
  filmingMethod: string;
  dialogue: string;
  transition: string;
  costumeState: string;
  sceneLighting: string;
  negativePrompt: string;
}

export interface StudioStoryboardWizardSession {
  schemaVersion: typeof STORYBOARD_WIZARD_SCHEMA_VERSION;
  kind: "studio-storyboard-wizard-session";
  projectRoot: string;
  scriptRevisionId: string;
  sourceRange?: {
    startOffsetUtf16: number;
    endOffsetUtf16: number;
  };
  suggestion: StudioStoryboardDraftSuggestion;
  panels: WizardEditablePanel[];
  nextSteps: string[];
  /** 打开时解析到的规范资产。缺记录不进此表；物化禁止静默跳过。 */
  suggestedAssetResolutions?: WizardResolvedSuggestedAsset[];
  builtAt: string;
}

export interface MaterializeWizardInput {
  season: string;
  episode: string;
  sequence: number;
  unitId?: string;
  unitTitle: string;
  scriptRevisionId: string;
  panels: WizardEditablePanel[];
  promptTitle?: string;
  source?: string;
  sourceVersion?: string;
}

export type WizardResolvedSuggestedAsset = {
  assetId: string;
  category: StudioAssetCategory;
  name: string;
};

/**
 * 建议资产 → 宫格提及。分类/角色名只认已解析规范资产；缺记录跳过，禁止一律写成 character。
 * 与桌面 App 物化同一口径。不是 BindingSet，仍须 Binding 裁决。
 */
export function mapWizardSuggestedAssetsToPanelMentions(
  suggestedAssetIds: readonly string[],
  resolved: ReadonlyMap<string, WizardResolvedSuggestedAsset>,
  evidenceReference: string,
): StudioProductionPanelInput["assets"] {
  const seen = new Set<string>();
  const mentions: StudioProductionPanelInput["assets"] = [];
  for (const assetId of suggestedAssetIds) {
    const id = String(assetId || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const asset = resolved.get(id);
    if (!asset) continue;
    mentions.push({
      assetId: id,
      category: asset.category,
      presence: "optional",
      role: asset.name.trim() || id,
      continuityState: "unknown",
      evidence: [{ kind: "wizard-suggest", reference: evidenceReference, note: "ssl4" }],
    });
  }
  return mentions;
}

export async function resolveWizardSuggestedAssets(
  projectRoot: string,
  panels: ReadonlyArray<{
    suggestedAssetIds?: readonly string[];
    unresolvedProposals?: ReadonlyArray<{ candidateAssetIds?: readonly string[] }>;
  }>,
): Promise<Map<string, WizardResolvedSuggestedAsset>> {
  const ids = [...new Set(panels.flatMap((panel) => [
    ...(panel.suggestedAssetIds ?? []),
    ...(panel.unresolvedProposals ?? []).flatMap((proposal) => proposal.candidateAssetIds ?? []),
  ]).map((id) => String(id || "").trim()).filter(Boolean))];
  const rows = await Promise.all(ids.map(async (assetId) => {
    const asset = await getStudioCanonicalAsset(projectRoot, assetId);
    return [assetId, asset] as const;
  }));
  const resolved = new Map<string, WizardResolvedSuggestedAsset>();
  for (const [assetId, asset] of rows) {
    if (!asset) continue;
    resolved.set(assetId, {
      assetId,
      category: asset.category,
      name: asset.name,
    });
  }
  return resolved;
}

/** 纯：建议格 → 可编辑格（默认空动作字段，由 Agent 填）。 */
export function toWizardEditablePanels(
  panels: StudioStoryboardDraftPanelSuggestion[],
): WizardEditablePanel[] {
  return panels.map((p) => ({
    ...p,
    title: `G${p.panelIndex}`,
    visualAction: "",
    shotComposition: p.shotType === "extension" ? "中景" : "中景",
    filmingMethod: "呼吸感固定",
    dialogue: "",
    transition: "",
    costumeState: "",
    sceneLighting: "",
    negativePrompt: "",
  }));
}

/** 纯：合并人工/Agent 编辑。 */
export function applyWizardPanelEdits(
  panels: WizardEditablePanel[],
  edits: WizardPanelEdit[],
): WizardEditablePanel[] {
  const byIndex = new Map(edits.map((e) => [e.panelIndex, e]));
  return panels.map((p) => {
    const e = byIndex.get(p.panelIndex);
    if (!e) return p;
    return {
      ...p,
      title: e.title ?? p.title,
      visualAction: e.visualAction ?? p.visualAction,
      shotComposition: e.shotComposition ?? p.shotComposition,
      filmingMethod: e.filmingMethod ?? p.filmingMethod,
      dialogue: e.dialogue ?? p.dialogue,
      transition: e.transition ?? p.transition,
      costumeState: e.costumeState ?? p.costumeState,
      sceneLighting: e.sceneLighting ?? p.sceneLighting,
      negativePrompt: e.negativePrompt ?? p.negativePrompt,
      suggestedAssetIds: e.suggestedAssetIds ?? p.suggestedAssetIds,
      unresolvedProposals: e.unresolvedProposals ?? p.unresolvedProposals,
    };
  });
}

/** 纯：物化前校验。与对照面向导同源，见 listWizardMaterializeValidationErrors。 */
export function validateWizardForMaterialize(panels: WizardEditablePanel[]): string[] {
  return listWizardMaterializeValidationErrors(panels);
}

export async function openStudioStoryboardWizard(
  projectRoot: string,
  input: {
    scriptRevisionId: string;
    panelCount?: number;
    sourceRange?: {
      startOffsetUtf16: number;
      endOffsetUtf16: number;
    };
  },
): Promise<StudioStoryboardWizardSession> {
  const suggestion = await suggestStudioStoryboardDraft(projectRoot, {
    scriptRevisionId: input.scriptRevisionId,
    ...(input.panelCount !== undefined ? { panelCount: input.panelCount } : {}),
    ...(input.sourceRange ? { sourceRange: input.sourceRange } : {}),
  });
  const panels = toWizardEditablePanels(suggestion.panels);
  const resolved = await resolveWizardSuggestedAssets(projectRoot, panels);
  return {
    schemaVersion: STORYBOARD_WIZARD_SCHEMA_VERSION,
    kind: "studio-storyboard-wizard-session",
    projectRoot,
    scriptRevisionId: input.scriptRevisionId,
    ...(input.sourceRange ? { sourceRange: input.sourceRange } : {}),
    suggestion,
    panels,
    suggestedAssetResolutions: [...resolved.values()],
    nextSteps: [
      "Agent/人工填写每格 visualAction/景别/运镜/光线/服化（applyWizardPanelEdits）",
      "未裁决的资产歧义必须选用或排除（applyWizardUnresolvedDecision）；禁止静默选第一个候选",
      "无规范记录的建议资产必须去掉或先建资产；禁止静默跳过",
      "G2+ 必须从上一格站位连续起拍；上一格光线/服化只作锁版提示，不自动写入本格（不是 BindingSet，不能当 generation-ready）",
      "validateWizardForMaterialize 无错误后 materializeStudioStoryboardWizardUnit",
      WIZARD_POST_MATERIALIZE_NEXT,
    ],
    builtAt: new Date().toISOString(),
  };
}

export async function materializeStudioStoryboardWizardUnit(
  projectRoot: string,
  input: MaterializeWizardInput,
): Promise<{ unitId: string; promptDocumentId: string; promptRevisionId: string; panelCount: number }> {
  const errors = validateWizardForMaterialize(input.panels);
  if (errors.length) throw new Error(`向导物化拒绝：${errors.join("；")}`);

  const script = await getStudioTextRevision(projectRoot, input.scriptRevisionId);
  if (!script) throw new Error(`scriptRevision 不存在：${input.scriptRevisionId}`);

  const resolvedAssets = await resolveWizardSuggestedAssets(projectRoot, input.panels);
  const missing = listWizardMissingSuggestedAssetErrors(
    input.panels,
    new Set(resolvedAssets.keys()),
  );
  if (missing.length) throw new Error(`向导物化拒绝：${missing.join("；")}`);

  const promptDoc = await createStudioPromptDocument(projectRoot, {
    title: input.promptTitle ?? `${input.unitTitle} wizard prompt`,
    expectedRevision: 0,
  });
  const promptBody = formatWizardPromptBody(input.panels);
  const promptWrap = await appendStudioPromptRevision(projectRoot, {
    documentId: promptDoc.id,
    expectedRevision: 0,
    body: promptBody,
    source: input.source ?? "ssl4-storyboard-wizard",
    sourceVersion: input.sourceVersion ?? "20260724",
  });
  const promptRevisionId = promptWrap.revision.id;

  const panels: StudioProductionPanelInput[] = input.panels.map((p) => ({
    title: p.title,
    visualAction: p.visualAction,
    shotComposition: p.shotComposition,
    filmingMethod: p.filmingMethod,
    dialogue: p.dialogue || undefined,
    startSeconds: p.startSeconds,
    durationSeconds: p.durationSeconds,
    promptRevisionId,
    sourceSpans: p.sourceSpans.map((s) => ({
      startOffsetUtf16: s.startOffsetUtf16,
      endOffsetUtf16: s.endOffsetUtf16,
    })),
    assets: mapWizardSuggestedAssetsToPanelMentions(
      p.suggestedAssetIds ?? [],
      resolvedAssets,
      input.scriptRevisionId,
    ),
    transition: p.transition || undefined,
    costumeState: p.costumeState || undefined,
    sceneLighting: p.sceneLighting || undefined,
    shotType: p.shotType,
    negativePrompt: p.negativePrompt || undefined,
  }));

  const unit = await createStudioProductionUnit(projectRoot, {
    ...(input.unitId ? { id: input.unitId } : {}),
    expectedRevision: 0,
    season: input.season,
    episode: input.episode,
    sequence: input.sequence,
    title: input.unitTitle,
    durationSeconds: 15,
    scriptRevisionId: input.scriptRevisionId,
    panels,
  });

  return {
    unitId: unit.unit.id,
    promptDocumentId: promptDoc.id,
    promptRevisionId,
    panelCount: panels.length,
  };
}
