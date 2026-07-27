/**
 * 生成结果 Staging 区（clean-room，对照 Invoke canvasStagingArea 语义）。
 * 不写 CAS、不平行 ledger：只决定「是否允许挂到正式 pipeline 节点」。
 * 正式写回仍走 commit_agent_imagegen_result_bundle + Review。
 */

export type StudioStagingStatus = "staged" | "accepted" | "discarded";

export type StudioStagingItem = {
  id: string;
  panelId: string;
  runId: string;
  /** quarantine 候选逻辑路径（不读盘） */
  candidatePath: string;
  stagedAt: string;
  status: StudioStagingStatus;
};

export type StudioStagingArea = {
  schemaVersion: 1;
  items: StudioStagingItem[];
};

export function createStudioStagingArea(): StudioStagingArea {
  return { schemaVersion: 1, items: [] };
}

export type StageResultInput = {
  id: string;
  panelId: string;
  runId: string;
  candidatePath: string;
  stagedAt?: string;
};

function requireNonEmpty(label: string, value: string): string {
  const v = value?.trim() ?? "";
  if (!v) throw new Error(`staging: ${label} 不能为空。`);
  return v;
}

/** 将一条结果放入待接受区；同 id 已存在且非 discarded 则拒绝。 */
export function stageGenerationResult(area: StudioStagingArea, input: StageResultInput): StudioStagingArea {
  const id = requireNonEmpty("id", input.id);
  const panelId = requireNonEmpty("panelId", input.panelId);
  const runId = requireNonEmpty("runId", input.runId);
  const candidatePath = requireNonEmpty("candidatePath", input.candidatePath);
  const existing = area.items.find((i) => i.id === id);
  if (existing && existing.status !== "discarded") {
    throw new Error(`staging: 条目 ${id} 已存在且状态为 ${existing.status}，禁止重复 stage。`);
  }
  const item: StudioStagingItem = {
    id,
    panelId,
    runId,
    candidatePath,
    stagedAt: input.stagedAt?.trim() || new Date().toISOString(),
    status: "staged",
  };
  const items = existing
    ? area.items.map((i) => (i.id === id ? item : i))
    : [...area.items, item];
  return { schemaVersion: 1, items };
}

export type StagingDecision = "accept" | "discard";

export type StagingDecisionResult =
  | { ok: true; area: StudioStagingArea; item: StudioStagingItem; allowFormalPipelineAttach: boolean }
  | { ok: false; code: string; reason: string; area: StudioStagingArea };

/**
 * 对 staged 条目做 accept/discard。
 * - accept → allowFormalPipelineAttach=true（调用方再挂 pipeline）
 * - discard → allowFormalPipelineAttach=false
 * 反向：未知 id、非 staged、非法 decision → fail-close
 */
export function decideStudioStagingItem(
  area: StudioStagingArea,
  stagingId: string,
  decision: StagingDecision,
): StagingDecisionResult {
  const id = stagingId?.trim() ?? "";
  if (!id) {
    return { ok: false, code: "empty-id", reason: "stagingId 不能为空。", area };
  }
  if (decision !== "accept" && decision !== "discard") {
    return { ok: false, code: "invalid-decision", reason: "decision 必须是 accept 或 discard。", area };
  }
  const idx = area.items.findIndex((i) => i.id === id);
  if (idx < 0) {
    return { ok: false, code: "not-found", reason: `staging 条目不存在：${id}`, area };
  }
  const current = area.items[idx]!;
  if (current.status !== "staged") {
    return {
      ok: false,
      code: "not-staged",
      reason: `条目 ${id} 状态为 ${current.status}，仅 staged 可决策。`,
      area,
    };
  }
  const nextStatus: StudioStagingStatus = decision === "accept" ? "accepted" : "discarded";
  const item: StudioStagingItem = { ...current, status: nextStatus };
  const items = area.items.map((i, iIdx) => (iIdx === idx ? item : i));
  const nextArea: StudioStagingArea = { schemaVersion: 1, items };
  return {
    ok: true,
    area: nextArea,
    item,
    allowFormalPipelineAttach: decision === "accept",
  };
}

/** 待处理列表（仅 staged） */
export function listPendingStudioStaging(area: StudioStagingArea): StudioStagingItem[] {
  return area.items.filter((i) => i.status === "staged");
}
