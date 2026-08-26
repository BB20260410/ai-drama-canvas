/**
 * P21 create_studio_generation_plan 只读草稿。
 * 不执行命令、不派发、不读对照板 / SQLite。
 * 单镜只认该宫格自己的冻结 pack；整板只认已落盘 unit-grid pack。
 * 禁止用同行已出图 preview pack，禁止猜第一格，禁止用单镜 pack 冒充整板节点。
 */

export const STUDIO_GENERATION_PLAN_COMMAND = "create_studio_generation_plan" as const;
/** @deprecated 用 STUDIO_GENERATION_PLAN_COMMAND；SSL-5 兼容别名。 */
export const SSL5_GENERATION_PLAN_COMMAND = STUDIO_GENERATION_PLAN_COMMAND;

export type StudioGenerationPlanDraftNode =
  | { unitId: string; panelId: string }
  | { targetKind: "unit-grid"; unitId: string };

export type StudioGenerationPlanDraft = {
  command: typeof STUDIO_GENERATION_PLAN_COMMAND;
  ready: boolean;
  blockedReason: string | null;
  nodes: StudioGenerationPlanDraftNode[] | null;
  dispatch: false;
  note: string;
};

/** SSL-5 / 历史别名。 */
export type Ssl5GenerationPlanDraftNode = StudioGenerationPlanDraftNode;
export type Ssl5GenerationPlanDraft = StudioGenerationPlanDraft;

const NOTE_BLOCKED = "只读草稿。不执行、不派发。";
const NOTE_READY = "只起草建计划节点；不执行、不派发。派发须用计划推导 runId。";

function blocked(reason: string): StudioGenerationPlanDraft {
  return {
    command: STUDIO_GENERATION_PLAN_COMMAND,
    ready: false,
    blockedReason: reason,
    nodes: null,
    dispatch: false,
    note: NOTE_BLOCKED,
  };
}

export function composeStudioGenerationPlanDraft(input: {
  focusUnitId: string | null;
  focusPanelId: string | null;
  focusPackId: string | null;
  targetKind?: "panel" | "unit-grid";
}): StudioGenerationPlanDraft {
  if (!input.focusUnitId) {
    return blocked("没有目标单元，不能建立计划");
  }
  if (input.targetKind === "unit-grid") {
    if (!input.focusPackId) {
      return blocked("该整板尚无冻结 pack，先 Binding→readiness→freeze。禁止用单镜或同行 preview pack 冒充整板节点");
    }
    return {
      command: STUDIO_GENERATION_PLAN_COMMAND,
      ready: true,
      blockedReason: null,
      nodes: [{ targetKind: "unit-grid", unitId: input.focusUnitId }],
      dispatch: false,
      note: NOTE_READY,
    };
  }
  if (!input.focusPanelId) {
    return blocked("没有目标宫格，禁止猜第一格");
  }
  if (!input.focusPackId) {
    return blocked("该宫格尚无冻结 pack，先 Binding→readiness→freeze。禁止用同行已出图宫格的 packId");
  }
  return {
    command: STUDIO_GENERATION_PLAN_COMMAND,
    ready: true,
    blockedReason: null,
    nodes: [{ unitId: input.focusUnitId, panelId: input.focusPanelId }],
    dispatch: false,
    note: NOTE_READY,
  };
}

/** SSL-5 / 历史别名。 */
export const composeSsl5GenerationPlanDraft = composeStudioGenerationPlanDraft;
