/**
 * 生成队列可观测投影（视图层，clean-room 对齐 LumenX TaskQueue 分桶思想）。
 * - 仅聚合状态计数与有界条目；不读写供应商、不假装真实生图
 * - 供驾驶舱/画布展示 active|done|failed 分桶
 */
export type StudioGenerationQueueBucket = "active" | "done" | "failed";

export type StudioGenerationQueueTaskStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export interface StudioGenerationQueueTaskInput {
  id: string;
  status: StudioGenerationQueueTaskStatus | string;
  label?: string;
  panelId?: string;
  unitId?: string;
  itemId?: string;
  createdAt?: string | number;
  provider?: string;
  /** 预览路径（本地路径或缩略图 URL 投影，不读媒体二进制） */
  previewPath?: string;
  previewKind?: "image" | "video" | "none";
  canCancel?: boolean;
}

export interface StudioGenerationQueueTaskView {
  id: string;
  status: string;
  bucket: StudioGenerationQueueBucket;
  label: string;
  panelId?: string;
  unitId?: string;
  itemId?: string;
  createdAt?: string;
  provider?: string;
  previewPath?: string;
  previewKind?: "image" | "video" | "none";
  canCancel: boolean;
  canJump: boolean;
  canPreview: boolean;
}

export interface StudioGenerationQueueView {
  schemaVersion: 1;
  kind: "studio-generation-queue-view";
  totals: Record<StudioGenerationQueueBucket, number>;
  inFlightCount: number;
  tabs: Record<StudioGenerationQueueBucket, StudioGenerationQueueTaskView[]>;
  /** 当前可见 tab 条目（有界） */
  visible: StudioGenerationQueueTaskView[];
  activeTab: StudioGenerationQueueBucket;
}

export class StudioGenerationQueueViewError extends Error {
  readonly code = "invalid-input" as const;
  constructor(message: string) {
    super(message);
    this.name = "StudioGenerationQueueViewError";
  }
}

const MAX_VISIBLE = 36;

function bucketOf(status: string): StudioGenerationQueueBucket {
  const s = status.trim().toLowerCase();
  if (
    s === "pending" || s === "processing" || s === "queued" || s === "running"
    || s === "submitting" || s === "waiting_external" || s === "waiting_remote"
    || s === "generating" || s === "generation_unknown" || s === "candidate_generated"
    || s === "submission_unknown" || s === "leased" || s === "plan_ready"
    || s === "planned" || s === "dispatched"
  ) {
    return "active";
  }
  if (s === "completed" || s === "success" || s === "succeeded" || s === "done" || s === "verified") {
    return "done";
  }
  return "failed"; // failed | cancelled | visual_rejected | …
}

function createdSortKey(value: string | number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/**
 * 将任务列表分桶；默认 tab=active；每桶最多 36 条（最新优先）。
 */
export function buildStudioGenerationQueueView(
  tasks: readonly StudioGenerationQueueTaskInput[] | undefined | null,
  options?: { activeTab?: StudioGenerationQueueBucket; maxPerBucket?: number },
): StudioGenerationQueueView {
  const activeTab = options?.activeTab ?? "active";
  if (!["active", "done", "failed"].includes(activeTab)) {
    throw new StudioGenerationQueueViewError(`activeTab 非法：${activeTab}`);
  }
  const maxPer = options?.maxPerBucket ?? MAX_VISIBLE;
  if (!Number.isInteger(maxPer) || maxPer < 1 || maxPer > 200) {
    throw new StudioGenerationQueueViewError("maxPerBucket 须在 1–200。");
  }

  const tabs: Record<StudioGenerationQueueBucket, StudioGenerationQueueTaskView[]> = {
    active: [],
    done: [],
    failed: [],
  };

  for (const raw of tasks ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.id ?? "").trim();
    if (!id) continue;
    const status = String(raw.status ?? "unknown").trim() || "unknown";
    const bucket = bucketOf(status);
    const previewPath = raw.previewPath?.trim() || undefined;
    const previewKind = raw.previewKind === "image" || raw.previewKind === "video"
      ? raw.previewKind
      : previewPath ? "image" : "none";
    const canCancel = raw.canCancel === true
      || (bucket === "active" && !["succeeded", "failed", "cancelled", "visual_rejected"].includes(status.toLowerCase()));
    const jumpTarget = raw.itemId || raw.unitId || raw.panelId;
    const view: StudioGenerationQueueTaskView = {
      id,
      status,
      bucket,
      label: (raw.label ?? id).trim() || id,
      ...(raw.panelId ? { panelId: String(raw.panelId) } : {}),
      ...(raw.unitId ? { unitId: String(raw.unitId) } : {}),
      ...(raw.itemId ? { itemId: String(raw.itemId) } : {}),
      ...(raw.createdAt !== undefined ? { createdAt: String(raw.createdAt) } : {}),
      ...(raw.provider ? { provider: String(raw.provider) } : {}),
      ...(previewPath ? { previewPath, previewKind } : { previewKind: "none" as const }),
      canCancel,
      canJump: Boolean(jumpTarget),
      canPreview: Boolean(previewPath),
    };
    tabs[bucket].push(view);
  }

  const byTimeDesc = (a: StudioGenerationQueueTaskView, b: StudioGenerationQueueTaskView) =>
    createdSortKey(b.createdAt) - createdSortKey(a.createdAt);

  for (const key of ["active", "done", "failed"] as const) {
    tabs[key].sort(byTimeDesc);
  }

  // totals 必须来自完整任务集，而不是分页后的可见条目。否则任务数超过
  // maxPer 时，页签计数和 inFlightCount 会被错误截断，误导并发判断。
  const totals = {
    active: tabs.active.length,
    done: tabs.done.length,
    failed: tabs.failed.length,
  };

  for (const key of ["active", "done", "failed"] as const) {
    if (tabs[key].length > maxPer) tabs[key] = tabs[key].slice(0, maxPer);
  }

  return {
    schemaVersion: 1,
    kind: "studio-generation-queue-view",
    totals,
    inFlightCount: totals.active,
    tabs,
    visible: tabs[activeTab],
    activeTab,
  };
}

/**
 * 生成前预览摘要：准备清单是否可生成 + 队列 in-flight，供 UI 在 dispatch 前展示。
 * 不触发任何写路径。
 */
export interface StudioGenerationPreflightPreview {
  schemaVersion: 1;
  kind: "studio-generation-preflight-preview";
  panelId: string;
  unitId: string;
  canDispatch: boolean;
  preparationPendingCount: number;
  queueInFlight: number;
  reasons: string[];
  provider: "codex" | "grok";
}

/**
 * LumenX TaskQueue：跳转目标解析。
 * 受管 Studio 优先 panel/unit（可进绑定/驾驶舱）；遗留队列再回落 item。
 */
export function resolveStudioGenerationQueueJumpTarget(task: Pick<StudioGenerationQueueTaskView, "itemId" | "unitId" | "panelId" | "id">): {
  kind: "item" | "unit" | "panel" | "job";
  targetId: string;
  unitId?: string;
  panelId?: string;
} {
  const panelId = task.panelId?.trim() || undefined;
  const unitId = task.unitId?.trim() || undefined;
  const itemId = task.itemId?.trim() || undefined;
  if (panelId) {
    return {
      kind: "panel",
      targetId: panelId,
      ...(unitId ? { unitId } : {}),
      panelId,
    };
  }
  if (unitId) return { kind: "unit", targetId: unitId, unitId };
  if (itemId) return { kind: "item", targetId: itemId };
  return { kind: "job", targetId: task.id };
}

export function buildStudioGenerationPreflightPreview(input: {
  unitId: string;
  panelId: string;
  preparationReady: boolean;
  preparationPendingCount: number;
  queueInFlight: number;
  provider?: "codex" | "grok";
  freezeReady?: boolean;
}): StudioGenerationPreflightPreview {
  const unitId = input.unitId.trim();
  const panelId = input.panelId.trim();
  if (!unitId || !panelId) {
    throw new StudioGenerationQueueViewError("unitId/panelId 不能为空。");
  }
  const provider = input.provider ?? "codex";
  const freezeReady = input.freezeReady !== false;
  const reasons: string[] = [];
  if (!input.preparationReady) reasons.push(`准备清单未闭环（待 ${input.preparationPendingCount} 项）`);
  if (!freezeReady) reasons.push("冻结包未 ready");
  if (input.queueInFlight > 0) reasons.push(`队列仍有 ${input.queueInFlight} 个进行中任务（可观测，不阻断）`);

  // 队列 in-flight 仅提示，不阻断 canDispatch（对齐 LumenX 可并发观察）
  const canDispatch = input.preparationReady && freezeReady;

  return {
    schemaVersion: 1,
    kind: "studio-generation-preflight-preview",
    unitId,
    panelId,
    canDispatch,
    preparationPendingCount: Math.max(0, input.preparationPendingCount),
    queueInFlight: Math.max(0, input.queueInFlight),
    reasons,
    provider,
  };
}
