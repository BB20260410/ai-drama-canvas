/**
 * 锁版前镜站位：写入 / 从冻结 renderedPrompt 还原。
 * 不读 unit head；历史包无「前镜交接」行则为 null。
 * 不是 BindingSet，不能当 generation-ready。
 */

export type StudioPanelStandingHandoff = {
  panelIndex: number;
  panelId: string;
  shotComposition: string;
  visualAction: string;
  filmingMethod: string;
};

export type FrozenStyleLockRef = {
  assetId: string;
  role: string;
};

export type FrozenPackStyleLockSource = {
  request?: {
    modelPayload?: {
      renderedPrompt?: string;
    };
    controlReferences?: ReadonlyArray<{
      assetId?: string;
      category?: string;
      role?: string;
    }>;
  };
  assets?: ReadonlyArray<{
    assetId?: string;
    category?: string;
    role?: string;
  }>;
  controlReferences?: ReadonlyArray<{
    assetId?: string;
    category?: string;
    categories?: readonly string[];
    role?: string;
    roles?: readonly string[];
    coveredAssetIds?: readonly string[];
    referenceId?: string;
  }>;
};

export type FrozenRenderedPromptPack = FrozenPackStyleLockSource;

export type FrozenPackBeatTarget = {
  panelId?: string;
  panelIndex?: number;
  panelCount?: number;
  unitLocalStartSeconds?: number;
  unitLocalEndSeconds?: number;
  durationSeconds?: number;
};

export type AnyFrozenPackStandingSource = FrozenRenderedPromptPack & {
  schemaVersion?: number;
  target?: FrozenPackBeatTarget;
  panels?: ReadonlyArray<{
    panelId: string;
    panelPack?: FrozenRenderedPromptPack & { target?: FrozenPackBeatTarget };
  }>;
};

function collectStyleLockRefs(source: FrozenPackStyleLockSource | null | undefined): FrozenStyleLockRef[] {
  if (!source) return [];
  const seen = new Set<string>();
  const refs: FrozenStyleLockRef[] = [];
  const add = (assetId: string, role: string) => {
    const id = assetId.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    refs.push({ assetId: id, role: role.trim() });
  };
  for (const ref of source.request?.controlReferences ?? []) {
    if (String(ref.category ?? "").trim() !== "style") continue;
    add(String(ref.assetId ?? ""), String(ref.role ?? ""));
  }
  for (const asset of source.assets ?? []) {
    if (String(asset.category ?? "").trim() !== "style") continue;
    add(String(asset.assetId ?? ""), String(asset.role ?? ""));
  }
  for (const ref of source.controlReferences ?? []) {
    const categories = Array.isArray(ref.categories)
      ? ref.categories
      : (ref.category ? [ref.category] : []);
    if (!categories.some((category) => String(category).trim() === "style")) continue;
    add(
      String(ref.coveredAssetIds?.[0] ?? ref.assetId ?? ref.referenceId ?? ""),
      String(ref.roles?.[0] ?? ref.role ?? ""),
    );
  }
  return refs;
}

/**
 * 单镜包直接收 category=style；unit-grid 必须 panelId，禁止猜第一格。
 * 不读 unit head，不写新冻结行。
 */
export function styleLockRefsFromAnyFrozenPack(
  pack: AnyFrozenPackStandingSource | null | undefined,
  panelId?: string,
): FrozenStyleLockRef[] {
  if (!pack) return [];
  if (Array.isArray(pack.panels)) {
    if (!panelId) return [];
    return collectStyleLockRefs(pack.panels.find((entry) => entry.panelId === panelId)?.panelPack);
  }
  return collectStyleLockRefs(pack);
}

export function formatFrozenStyleLockReadonlyLine(
  refs: ReadonlyArray<FrozenStyleLockRef> | null | undefined,
): string | null {
  if (!refs?.length) return null;
  const parts = refs.map((ref) => {
    const role = ref.role.trim();
    return role ? `${ref.assetId} ${role}` : ref.assetId;
  });
  return `风格锁（冻结包）：${parts.join(" · ")}。跟随风格控制参考，禁止另起画风。不是 BindingSet。`;
}

/** 当前宫格已加载控制资产里的风格锁（无冻结包时）；不是 BindingSet。 */
export function formatUnitLockStyleLockLine(
  assets: ReadonlyArray<{ assetId?: string; category?: string; role?: string }> | null | undefined,
): string | null {
  if (!assets) return null;
  const refs = assets.flatMap((asset) => {
    const assetId = String(asset.assetId ?? "").trim();
    const category = String(asset.category ?? "").trim();
    if (!assetId || category !== "style") return [];
    return [{ assetId, role: String(asset.role ?? "").trim() }];
  });
  if (!refs.length) return null;
  const parts = refs.map((ref) => {
    const role = ref.role.trim();
    return role ? `${ref.assetId} ${role}` : ref.assetId;
  });
  return `锁版风格：${parts.join(" · ")}。跟随风格控制参考，禁止另起画风。不是 BindingSet，不能当 generation-ready。`;
}

export function pickPreviousPanelStanding(
  panels: ReadonlyArray<{
    index: number;
    id: string;
    shotComposition: string;
    visualAction: string;
    filmingMethod: string;
  }>,
  currentIndex: number,
): StudioPanelStandingHandoff | null {
  if (!Number.isFinite(currentIndex)) return null;
  const previous = panels
    .filter((panel) => panel.index < currentIndex)
    .sort((left, right) => right.index - left.index)[0];
  if (!previous) return null;
  return {
    panelIndex: previous.index,
    panelId: previous.id,
    shotComposition: previous.shotComposition,
    visualAction: previous.visualAction,
    filmingMethod: previous.filmingMethod,
  };
}

/** 写入冻结 renderedPrompt；首格返回 null，不改指纹。 */
export function formatPreviousStandingPromptLine(
  handoff: StudioPanelStandingHandoff | null | undefined,
): string | null {
  if (!handoff) return null;
  return `前镜交接：G${handoff.panelIndex} ${handoff.shotComposition.trim() || "构图未记"} · ${handoff.visualAction.trim() || "动作未记"} · ${handoff.filmingMethod.trim() || "运镜未记"}。本格必须从该站位连续起拍，禁止重起镜、镜像或改空间布局。`;
}

/** 从已冻结 renderedPrompt 还原前镜；历史包无此行则 null。panelId 不在提示词里。 */
export function parsePreviousStandingFromRenderedPrompt(
  renderedPrompt: string,
): StudioPanelStandingHandoff | null {
  const match = /前镜交接：G(\d+) (.+?) · (.+?) · (.+?)。本格必须从该站位连续起拍/u.exec(renderedPrompt);
  if (!match) return null;
  const panelIndex = Number(match[1]);
  if (!Number.isFinite(panelIndex)) return null;
  return {
    panelIndex,
    panelId: "",
    shotComposition: match[2] ?? "",
    visualAction: match[3] ?? "",
    filmingMethod: match[4] ?? "",
  };
}

/** 单镜包直接取 request；unit-grid 必须带 panelId，禁止猜第一格。不读 unit head。 */
export function renderedPromptFromAnyFrozenPack(
  pack: AnyFrozenPackStandingSource | null | undefined,
  panelId?: string,
): string | null {
  if (!pack) return null;
  const source = Array.isArray(pack.panels)
    ? (panelId ? pack.panels.find((entry) => entry.panelId === panelId)?.panelPack : undefined)
    : pack;
  if (!source) return null;
  const prompt = source.request?.modelPayload?.renderedPrompt;
  return typeof prompt === "string" && prompt ? prompt : null;
}

export function previousStandingFromFrozenRenderedPrompt(
  pack: FrozenRenderedPromptPack | null | undefined,
): StudioPanelStandingHandoff | null {
  const prompt = pack?.request?.modelPayload?.renderedPrompt;
  if (typeof prompt !== "string" || !prompt) return null;
  return parsePreviousStandingFromRenderedPrompt(prompt);
}

/**
 * 单镜包直接解析 request；unit-grid 必须带 panelId，禁止猜第一格。
 * 不读 unit head。
 */
export function previousStandingFromAnyFrozenPack(
  pack: AnyFrozenPackStandingSource | null | undefined,
  panelId?: string,
): StudioPanelStandingHandoff | null {
  const prompt = renderedPromptFromAnyFrozenPack(pack, panelId);
  return prompt ? parsePreviousStandingFromRenderedPrompt(prompt) : null;
}

export function parseFrozenPanelLightingFromRenderedPrompt(renderedPrompt: string): string | null {
  const match = /光线（宫格覆盖）：(.+)/u.exec(renderedPrompt);
  const value = match?.[1]?.trim() ?? "";
  return value || null;
}

export function parseFrozenPanelCostumeFromRenderedPrompt(renderedPrompt: string): string | null {
  const match = /服装（宫格覆盖）：(.+)/u.exec(renderedPrompt);
  const value = match?.[1]?.trim() ?? "";
  return value || null;
}

export function frozenPanelLightingFromAnyFrozenPack(
  pack: AnyFrozenPackStandingSource | null | undefined,
  panelId?: string,
): string | null {
  const prompt = renderedPromptFromAnyFrozenPack(pack, panelId);
  return prompt ? parseFrozenPanelLightingFromRenderedPrompt(prompt) : null;
}

export function frozenPanelCostumeFromAnyFrozenPack(
  pack: AnyFrozenPackStandingSource | null | undefined,
  panelId?: string,
): string | null {
  const prompt = renderedPromptFromAnyFrozenPack(pack, panelId);
  return prompt ? parseFrozenPanelCostumeFromRenderedPrompt(prompt) : null;
}

export function formatFrozenPanelLightingReadonlyLine(
  lighting: string | null | undefined,
): string | null {
  if (!lighting) return null;
  return `冻结光线（宫格覆盖）：${lighting}。不是 BindingSet。`;
}

export function formatFrozenPanelCostumeReadonlyLine(
  costume: string | null | undefined,
): string | null {
  if (!costume) return null;
  return `冻结服装（宫格覆盖）：${costume}。不是 BindingSet。`;
}

/** 导演/审片只读行；无前镜行返回 null，不写「首格无前镜」以免冒充历史包。 */
export function formatPreviousStandingReadonlyLine(
  handoff: StudioPanelStandingHandoff | null | undefined,
): string | null {
  if (!handoff) return null;
  return `前镜交接（冻结提示词）：G${handoff.panelIndex} ${handoff.shotComposition.trim() || "构图未记"} · ${handoff.visualAction.trim() || "动作未记"} · ${handoff.filmingMethod.trim() || "运镜未记"}。本格必须从该站位连续起拍。不是 BindingSet。`;
}

/** 当前单元锁版前镜（未冻结或历史包无该行时）；不是冻结提示词，不能当 generation-ready。 */
export function formatUnitLockPreviousStandingLine(
  handoff: StudioPanelStandingHandoff | null | undefined,
): string | null {
  if (!handoff) return null;
  return `锁版前镜：G${handoff.panelIndex} ${handoff.shotComposition.trim() || "构图未记"} · ${handoff.visualAction.trim() || "动作未记"} · ${handoff.filmingMethod.trim() || "运镜未记"}。不是 BindingSet，不能当 generation-ready。`;
}

/** 当前宫格锁版光线（无冻结包时）；不是前镜行，不是 BindingSet。 */
export function formatUnitLockPanelLightingLine(
  overlay: { panelIndex: number; sceneLighting?: string } | null | undefined,
): string | null {
  const text = overlay?.sceneLighting?.trim() ?? "";
  if (!overlay || !text) return null;
  return `锁版光线：G${overlay.panelIndex} ${text}。不是 BindingSet，不能当 generation-ready。`;
}

/** 当前宫格锁版服装（无冻结包时）；不是前镜行，不是 BindingSet。 */
export function formatUnitLockPanelCostumeLine(
  overlay: { panelIndex: number; costumeState?: string } | null | undefined,
): string | null {
  const text = overlay?.costumeState?.trim() ?? "";
  if (!overlay || !text) return null;
  return `锁版服装：G${overlay.panelIndex} ${text}。不是 BindingSet，不能当 generation-ready。`;
}

export const UNIT_GRID_PREVIOUS_STANDING_TOOL_NOTE =
  "若 previousStandings、promptContract.BEATS[].previousStanding 或 renderedPrompt 含「前镜交接」，必须从该站位连续起拍，禁止重起镜、镜像或改空间布局。";

export const FROZEN_PANEL_LIGHTING_COSTUME_TOOL_NOTE =
  "若 frozenPanelLighting、frozenPanelCostume、frozenPanelOverlays 或 renderedPrompt 含「光线（宫格覆盖）」/「服装（宫格覆盖）」，必须保持该宫格覆盖，禁止改光色或换装。";

export const SCENE_BACK_REFERENCE_TOOL_NOTE =
  "若 session-snapshot 含 sceneBackReferences / sceneBackReferenceNote，必须与更早同场景快照提及连续，禁止换成未回指的场景。快照提及不是 BindingSet，不能当 generation-ready。";

export const PROP_BACK_REFERENCE_TOOL_NOTE =
  "若 session-snapshot 含 propBackReferences / propBackReferenceNote，必须与更早同道具快照提及连续，禁止换成未回指的道具。快照提及不是 BindingSet，不能当 generation-ready。";

export const CHARACTER_BACK_REFERENCE_TOOL_NOTE =
  "若 session-snapshot 含 characterBackReferences / characterBackReferenceNote，必须与更早同角色快照提及连续，禁止换成未回指的角色。快照提及不是 BindingSet，不能当 generation-ready。";

export const EXTENSION_SHOT_TYPE_TOOL_NOTE =
  "若 session-snapshot / frozen pack / shotTypeLine 标明扩写格，必须与前一格连续，禁止重新起镜，禁止锚定原文 sourceSpans。原镜必须锚定原文。";

export const UNIT_BEAT_TOOL_NOTE =
  "若 session-snapshot / frozen pack / beatLine 标明 15s 节拍，必须保持 2–6 格合计 15.0s、本格时长与起止秒，禁止改格数或把后一事件提前进本格。";

export const STYLE_LOCK_TOOL_NOTE =
  "若 session-snapshot / frozen pack / styleLockLine / promptContract.STYLE_LOCK 标明风格控制参考，必须跟随该画风与风格资产，禁止另起画风。不是 BindingSet。";

export type FrozenPanelBeat = {
  panelIndex: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  panelCount?: number;
};

function beatSourceFromAnyFrozenPack(
  pack: AnyFrozenPackStandingSource | null | undefined,
  panelId?: string,
): (FrozenRenderedPromptPack & { target?: FrozenPackBeatTarget }) | null {
  if (!pack) return null;
  if (Array.isArray(pack.panels)) {
    return panelId ? pack.panels.find((entry) => entry.panelId === panelId)?.panelPack ?? null : null;
  }
  return pack;
}

/** 单镜包直接取 target；unit-grid 必须 panelId，禁止猜第一格。不读 unit head。 */
export function frozenPanelBeatFromAnyFrozenPack(
  pack: AnyFrozenPackStandingSource | null | undefined,
  panelId?: string,
): FrozenPanelBeat | null {
  const source = beatSourceFromAnyFrozenPack(pack, panelId);
  const target = source?.target;
  if (!target) return null;
  const start = Number(target.unitLocalStartSeconds);
  const end = Number(target.unitLocalEndSeconds);
  let duration = Number(target.durationSeconds);
  if ((!Number.isFinite(duration) || duration <= 0) && Number.isFinite(start) && Number.isFinite(end) && end > start) {
    duration = end - start;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(duration) || duration <= 0) return null;
  const panelIndex = Number(target.panelIndex);
  const panelCount = Number(target.panelCount);
  return {
    panelIndex: Number.isFinite(panelIndex) ? panelIndex : 0,
    startSeconds: Math.round(start * 10) / 10,
    endSeconds: Math.round(end * 10) / 10,
    durationSeconds: Math.round(duration * 10) / 10,
    ...(Number.isFinite(panelCount) && panelCount > 0 ? { panelCount } : {}),
  };
}

export function formatFrozenPanelBeatReadonlyLine(
  beat: FrozenPanelBeat | null | undefined,
): string | null {
  if (!beat) return null;
  return `冻结 15s 节拍：G${beat.panelIndex} ${beat.startSeconds}–${beat.endSeconds}s（${beat.durationSeconds}s）。本单元须 2–6 格合计 15.0s。不是 BindingSet。`;
}

/** 当前宫格锁版 15s 节拍（无冻结包时）；不是 BindingSet。 */
export function formatUnitLockPanelBeatLine(
  overlay: {
    panelIndex: number;
    startSeconds?: number;
    endSeconds?: number;
    durationSeconds?: number;
  } | null | undefined,
): string | null {
  if (!overlay) return null;
  const start = Number(overlay.startSeconds);
  const end = Number(overlay.endSeconds);
  let duration = Number(overlay.durationSeconds);
  if ((!Number.isFinite(duration) || duration <= 0) && Number.isFinite(start) && Number.isFinite(end) && end > start) {
    duration = end - start;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(duration) || duration <= 0) return null;
  return `锁版 15s 节拍：G${overlay.panelIndex} ${Math.round(start * 10) / 10}–${Math.round(end * 10) / 10}s（${Math.round(duration * 10) / 10}s）。本单元须 2–6 格合计 15.0s。不是 BindingSet，不能当 generation-ready。`;
}

export type FrozenPanelShotType = "original" | "extension";

/** 从已冻结 renderedPrompt 还原镜头类型；历史包无「镜头类型」行则为 null。 */
export function parseFrozenPanelShotTypeFromRenderedPrompt(
  renderedPrompt: string,
): FrozenPanelShotType | null {
  const match = /镜头类型：(.+)/u.exec(renderedPrompt);
  const text = match?.[1] ?? "";
  if (text.includes("扩写")) return "extension";
  if (text.includes("原镜")) return "original";
  return null;
}

export function frozenPanelShotTypeFromAnyFrozenPack(
  pack: AnyFrozenPackStandingSource | null | undefined,
  panelId?: string,
): FrozenPanelShotType | null {
  const prompt = renderedPromptFromAnyFrozenPack(pack, panelId);
  return prompt ? parseFrozenPanelShotTypeFromRenderedPrompt(prompt) : null;
}

export function formatFrozenPanelShotTypeReadonlyLine(
  shotType: FrozenPanelShotType | null | undefined,
): string | null {
  if (shotType === "extension") {
    return "冻结扩写格：必须与前一格连续，禁止重新起镜，禁止锚定原文。不是 BindingSet。";
  }
  if (shotType === "original") {
    return "冻结原镜：必须锚定原文。不是 BindingSet。";
  }
  return null;
}

/**
 * 单镜 Agent brief 结构化约束：只从该包 renderedPrompt / target 还原。
 * 无扩写/原镜或无时长则为 null。不是 BindingSet，不读 unit head。
 */
export function studioAgentImagegenBriefConstraintLines(
  pack: AnyFrozenPackStandingSource & { panel?: { shotType?: string } },
): { shotTypeLine: string | null; beatLine: string | null } {
  const prompt = pack.request?.modelPayload?.renderedPrompt;
  const fromPrompt = typeof prompt === "string" ? parseFrozenPanelShotTypeFromRenderedPrompt(prompt) : null;
  const fromPanel = pack.panel?.shotType === "extension" || pack.panel?.shotType === "original"
    ? pack.panel.shotType
    : null;
  return {
    shotTypeLine: formatFrozenPanelShotTypeReadonlyLine(fromPrompt ?? fromPanel),
    beatLine: formatFrozenPanelBeatReadonlyLine(frozenPanelBeatFromAnyFrozenPack(pack)),
  };
}

/** 当前宫格锁版镜头类型（无冻结包时）；不是 BindingSet。 */
export function formatUnitLockPanelShotTypeLine(
  overlay: { panelIndex: number; shotType?: string } | null | undefined,
): string | null {
  const shotType = overlay?.shotType === "extension"
    ? "extension"
    : overlay?.shotType === "original"
      ? "original"
      : "";
  if (!overlay || !shotType) return null;
  const prefix = `G${overlay.panelIndex} `;
  if (shotType === "extension") {
    return `锁版扩写格：${prefix}必须与前一格连续，禁止重新起镜，禁止锚定原文。不是 BindingSet，不能当 generation-ready。`;
  }
  return `锁版原镜：${prefix}必须锚定原文。不是 BindingSet，不能当 generation-ready。`;
}

export type FrozenPanelStandingRow = {
  panelId: string;
  previousStanding: StudioPanelStandingHandoff & { source: "frozen-rendered-prompt" };
};

/**
 * 15s 向导：上一格锁版前镜。不是冻结包，不能当 generation-ready。
 */
export function wizardPreviousStandingForPanel(
  panels: ReadonlyArray<{
    panelIndex: number;
    shotComposition: string;
    visualAction: string;
    filmingMethod: string;
  }>,
  currentPanelIndex: number,
): StudioPanelStandingHandoff | null {
  return pickPreviousPanelStanding(
    panels.map((panel) => ({
      index: panel.panelIndex,
      id: `G${panel.panelIndex}`,
      shotComposition: panel.shotComposition,
      visualAction: panel.visualAction,
      filmingMethod: panel.filmingMethod,
    })),
    currentPanelIndex,
  );
}

export type StudioPanelLightingHandoff = {
  panelIndex: number;
  sceneLighting: string;
};

export type StudioPanelCostumeHandoff = {
  panelIndex: number;
  costumeState: string;
};

function pickPreviousWizardPanel<T extends { panelIndex: number }>(
  panels: ReadonlyArray<T>,
  currentPanelIndex: number,
): T | undefined {
  if (!Number.isFinite(currentPanelIndex)) return undefined;
  return panels
    .filter((panel) => panel.panelIndex < currentPanelIndex)
    .sort((left, right) => right.panelIndex - left.panelIndex)[0];
}

/** 向导 G2+ 上一格光线。空则 null；不自动写入本格，不是 BindingSet。 */
export function wizardPreviousLightingForPanel(
  panels: ReadonlyArray<{ panelIndex: number; sceneLighting?: string }>,
  currentPanelIndex: number,
): StudioPanelLightingHandoff | null {
  const previous = pickPreviousWizardPanel(panels, currentPanelIndex);
  const sceneLighting = previous?.sceneLighting?.trim() ?? "";
  if (!previous || !sceneLighting) return null;
  return { panelIndex: previous.panelIndex, sceneLighting };
}

/** 向导 G2+ 上一格服化。空则 null；不自动写入本格，不是 BindingSet。 */
export function wizardPreviousCostumeForPanel(
  panels: ReadonlyArray<{ panelIndex: number; costumeState?: string }>,
  currentPanelIndex: number,
): StudioPanelCostumeHandoff | null {
  const previous = pickPreviousWizardPanel(panels, currentPanelIndex);
  const costumeState = previous?.costumeState?.trim() ?? "";
  if (!previous || !costumeState) return null;
  return { panelIndex: previous.panelIndex, costumeState };
}

export function formatWizardLockPreviousLightingLine(
  handoff: StudioPanelLightingHandoff | null | undefined,
): string | null {
  if (!handoff) return null;
  return `锁版前镜光线：G${handoff.panelIndex} ${handoff.sceneLighting}。不是 BindingSet，不能当 generation-ready。`;
}

export function formatWizardLockPreviousCostumeLine(
  handoff: StudioPanelCostumeHandoff | null | undefined,
): string | null {
  if (!handoff) return null;
  return `锁版前镜服化：G${handoff.panelIndex} ${handoff.costumeState}。不是 BindingSet，不能当 generation-ready。`;
}

export function formatWizardLightingPromptLine(sceneLighting?: string): string | null {
  const text = sceneLighting?.trim() ?? "";
  return text ? `光线：${text}` : null;
}

export function formatWizardCostumePromptLine(costumeState?: string): string | null {
  const text = costumeState?.trim() ?? "";
  return text ? `服化：${text}` : null;
}

/** 向导物化 prompt 正文：G2+ 写入与冻结相同的「前镜交接」行；首格不写。光线/服化仅本格非空才追加，不写前镜光线行。 */
export function formatWizardPromptBody(
  panels: ReadonlyArray<{
    panelIndex: number;
    shotType: string;
    startSeconds: number;
    endSeconds: number;
    title: string;
    visualAction: string;
    shotComposition: string;
    filmingMethod: string;
    sceneLighting?: string;
    costumeState?: string;
  }>,
): string {
  return panels.map((panel) => {
    const standing = formatPreviousStandingPromptLine(wizardPreviousStandingForPanel(panels, panel.panelIndex));
    const lighting = formatWizardLightingPromptLine(panel.sceneLighting);
    const costume = formatWizardCostumePromptLine(panel.costumeState);
    const head = `G${panel.panelIndex} ${panel.shotType} ${panel.startSeconds}-${panel.endSeconds}s ${panel.title}: ${panel.visualAction}`;
    return [head, standing, lighting, costume].filter(Boolean).join("\n");
  }).join("\n");
}

/**
 * 追溯/brief 共用：只从各格冻结 renderedPrompt 还原。
 * 无「前镜交接」行的格不进数组；全空则调用方应省略字段，保持历史投影兼容。
 */
export function previousStandingsFromFrozenPanelPacks(
  packs: ReadonlyArray<{
    target?: { panelId?: string };
    request?: { modelPayload?: { renderedPrompt?: string } };
  }>,
): FrozenPanelStandingRow[] {
  const rows: FrozenPanelStandingRow[] = [];
  for (const pack of packs) {
    const parsed = previousStandingFromFrozenRenderedPrompt(pack);
    if (!parsed) continue;
    rows.push({
      panelId: typeof pack.target?.panelId === "string" ? pack.target.panelId : "",
      previousStanding: { ...parsed, source: "frozen-rendered-prompt" },
    });
  }
  return rows;
}

export type FrozenPanelOverlayRow = {
  panelId: string;
  lighting: string | null;
  costume: string | null;
};

/**
 * 追溯/brief 共用：只从各格冻结 renderedPrompt 还原宫格光线/服装覆盖。
 * 两行都没有的格不进数组；全空则调用方应省略字段，保持历史 P24 投影兼容。
 */
export function frozenPanelOverlaysFromFrozenPanelPacks(
  packs: ReadonlyArray<{
    target?: { panelId?: string };
    request?: { modelPayload?: { renderedPrompt?: string } };
  }>,
): FrozenPanelOverlayRow[] {
  const rows: FrozenPanelOverlayRow[] = [];
  for (const pack of packs) {
    const lighting = frozenPanelLightingFromAnyFrozenPack(pack);
    const costume = frozenPanelCostumeFromAnyFrozenPack(pack);
    if (!lighting && !costume) continue;
    rows.push({
      panelId: typeof pack.target?.panelId === "string" ? pack.target.panelId : "",
      lighting,
      costume,
    });
  }
  return rows;
}
