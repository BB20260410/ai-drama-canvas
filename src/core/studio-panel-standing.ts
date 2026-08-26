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

export type FrozenRenderedPromptPack = {
  request?: {
    modelPayload?: {
      renderedPrompt?: string;
    };
  };
};

export type AnyFrozenPackStandingSource = FrozenRenderedPromptPack & {
  schemaVersion?: number;
  panels?: ReadonlyArray<{
    panelId: string;
    panelPack?: FrozenRenderedPromptPack;
  }>;
};

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
