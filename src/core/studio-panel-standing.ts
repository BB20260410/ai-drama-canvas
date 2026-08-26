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
  if (!pack) return null;
  if (Array.isArray(pack.panels)) {
    if (!panelId) return null;
    const panel = pack.panels.find((entry) => entry.panelId === panelId);
    return previousStandingFromFrozenRenderedPrompt(panel?.panelPack);
  }
  return previousStandingFromFrozenRenderedPrompt(pack);
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

export const UNIT_GRID_PREVIOUS_STANDING_TOOL_NOTE =
  "若 previousStandings、promptContract.BEATS[].previousStanding 或 renderedPrompt 含「前镜交接」，必须从该站位连续起拍，禁止重起镜、镜像或改空间布局。";

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

/** 向导物化 prompt 正文：G2+ 写入与冻结相同的「前镜交接」行；首格不写。 */
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
  }>,
): string {
  return panels.map((panel) => {
    const standing = formatPreviousStandingPromptLine(wizardPreviousStandingForPanel(panels, panel.panelIndex));
    const head = `G${panel.panelIndex} ${panel.shotType} ${panel.startSeconds}-${panel.endSeconds}s ${panel.title}: ${panel.visualAction}`;
    return standing ? `${head}\n${standing}` : head;
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
