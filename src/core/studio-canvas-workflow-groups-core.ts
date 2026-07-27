/**
 * 浏览器安全的画布工作流组纯函数。
 *
 * 这里不能导入 studio-canvas-layout（包含 node:crypto）；renderer 只消费本
 * 模块，Node 侧需要 fingerprint/持久化时再由 studio-canvas-workflow-groups
 * 组合完整布局。
 */
import type {
  StudioCanvasWorkflowGroup,
  StudioCanvasWorkflowStep,
} from "./studio-canvas-layout-types.js";

/** 本库默认流水线：仅 image 有 runner 副作用；video/audio/review 需显式勾选。 */
export const STUDIO_CANVAS_DEFAULT_PIPELINE: readonly StudioCanvasWorkflowStep[] = ["image"];

const ALLOWED_STEPS = new Set<StudioCanvasWorkflowStep>(["image", "video", "audio", "review"]);
const PANEL_NODE_PREFIX = "panel:";
const MAX_PANELS_PER_GROUP = 64;
const MAX_GROUPS = 200;
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;

export type StudioCanvasWorkflowGroupsErrorCode = "invalid-input";

export class StudioCanvasWorkflowGroupsError extends Error {
  readonly code: StudioCanvasWorkflowGroupsErrorCode;

  constructor(code: StudioCanvasWorkflowGroupsErrorCode, message: string) {
    super(message);
    this.name = "StudioCanvasWorkflowGroupsError";
    this.code = code;
  }
}

export type StudioCanvasSelectionItem =
  | string
  | {
      id?: string;
      kind?: string;
      panelId?: string;
      data?: { kind?: string; id?: string; panelId?: string };
    };

function fail(message: string): never {
  throw new StudioCanvasWorkflowGroupsError("invalid-input", message);
}

function requiredPanelId(value: string, field: string): string {
  const normalized = value.trim();
  if (!NODE_ID_PATTERN.test(normalized)) fail(`${field} 非法：${value}`);
  return normalized;
}

/** 过滤非法步骤；去重保序；空则使用默认流水线。 */
export function normalizeStudioCanvasPipeline(
  pipeline: readonly string[] | undefined | null,
  options?: { defaultPipeline?: readonly StudioCanvasWorkflowStep[] },
): StudioCanvasWorkflowStep[] {
  const fallback = options?.defaultPipeline ?? STUDIO_CANVAS_DEFAULT_PIPELINE;
  const list = Array.isArray(pipeline) ? pipeline : [];
  const out: StudioCanvasWorkflowStep[] = [];
  const seen = new Set<StudioCanvasWorkflowStep>();
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const step = raw.trim() as StudioCanvasWorkflowStep;
    if (!ALLOWED_STEPS.has(step) || seen.has(step)) continue;
    seen.add(step);
    out.push(step);
  }
  return out.length ? out : [...fallback];
}

/** 从画布选中项抽取 panelId 列表（去重保序）。 */
export function extractStudioCanvasPanelIdsFromSelection(
  selected: readonly StudioCanvasSelectionItem[] | undefined | null,
): string[] {
  if (!selected?.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (candidate: string | undefined) => {
    if (!candidate) return;
    let id = candidate.trim();
    if (id.startsWith(PANEL_NODE_PREFIX)) id = id.slice(PANEL_NODE_PREFIX.length);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  for (const item of selected) {
    if (typeof item === "string") {
      push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (item.panelId) {
      push(item.panelId);
      continue;
    }
    if (item.data?.panelId) {
      push(item.data.panelId);
      continue;
    }
    const kind = item.kind ?? item.data?.kind;
    const id = item.id ?? item.data?.id;
    if (kind === "panel" && id) {
      push(id);
      continue;
    }
    if (typeof id === "string" && id.startsWith(PANEL_NODE_PREFIX)) push(id);
  }
  return out;
}

export interface CreateStudioCanvasWorkflowGroupInput {
  title?: string;
  panelIds: readonly string[];
  pipeline?: readonly string[];
  /** 测试可注入；默认 ISO now。 */
  now?: string;
  /** 测试可注入 id。 */
  id?: string;
}

/** 从选中 panelIds 创建新组并追加到列表（不持久化磁盘）。 */
export function createStudioCanvasWorkflowGroup(
  existingGroups: readonly StudioCanvasWorkflowGroup[] | undefined | null,
  input: CreateStudioCanvasWorkflowGroupInput,
): StudioCanvasWorkflowGroup[] {
  const existing = [...(existingGroups ?? [])];
  if (existing.length >= MAX_GROUPS) fail(`workflowGroups 超过上限 ${MAX_GROUPS}。`);

  const panelIds: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.panelIds ?? []) {
    if (typeof raw !== "string") continue;
    const id = requiredPanelId(
      raw.startsWith(PANEL_NODE_PREFIX) ? raw.slice(PANEL_NODE_PREFIX.length) : raw,
      "panelIds",
    );
    if (seen.has(id)) continue;
    seen.add(id);
    panelIds.push(id);
  }
  if (!panelIds.length) fail("请至少选择一个宫格（panel）。");
  if (panelIds.length > MAX_PANELS_PER_GROUP) fail(`panelIds 超过上限 ${MAX_PANELS_PER_GROUP}。`);

  const title = (input.title ?? `工作流 ${existing.length + 1}`).trim();
  if (!title || title.length > 120) fail("title 无效。");
  const createdAt = (input.now ?? new Date().toISOString()).trim();
  if (!createdAt) fail("createdAt 不能为空。");
  const id = (input.id ?? `wg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).trim();
  if (!NODE_ID_PATTERN.test(id)) fail(`group.id 非法：${id}`);
  if (existing.some((group) => group.id === id)) fail(`workflowGroups id 重复：${id}`);

  return [...existing, {
    id,
    title,
    panelIds,
    pipeline: normalizeStudioCanvasPipeline(input.pipeline),
    createdAt,
  }];
}

export function deleteStudioCanvasWorkflowGroup(
  existingGroups: readonly StudioCanvasWorkflowGroup[] | undefined | null,
  groupId: string,
): StudioCanvasWorkflowGroup[] {
  const id = groupId.trim();
  if (!id) fail("groupId 不能为空。");
  return (existingGroups ?? []).filter((group) => group.id !== id);
}

/** panelId → 所属工作流组（后写覆盖先写）。 */
export function getPanelWorkflowGroupMap(
  groups: readonly StudioCanvasWorkflowGroup[] | undefined | null,
): Map<string, StudioCanvasWorkflowGroup> {
  const map = new Map<string, StudioCanvasWorkflowGroup>();
  for (const group of groups ?? []) {
    for (const panelId of group.panelIds ?? []) map.set(panelId, group);
  }
  return map;
}
