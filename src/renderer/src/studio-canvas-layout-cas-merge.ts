import type {
  StudioCanvasDraftEdge,
  StudioCanvasLayout,
  StudioCanvasNodePosition,
  StudioCanvasViewport,
  StudioCanvasWorkflowGroup,
  StudioCanvasWorkspaceMode,
} from "../../core/studio-canvas-layout-types.js";

export interface StudioCanvasLayoutSemanticSnapshot {
  viewport: StudioCanvasViewport;
  nodes: Record<string, StudioCanvasNodePosition>;
  workspaceMode: StudioCanvasWorkspaceMode;
  pinnedNodeIds: string[];
  draftCanvasEdges: StudioCanvasDraftEdge[];
  workflowGroups: StudioCanvasWorkflowGroup[];
}

export interface StudioCanvasLayoutCasApi {
  loadLayout(projectRoot: string): Promise<StudioCanvasLayout | null>;
  saveLayout(
    projectRoot: string,
    input: {
      patch: StudioCanvasLayoutSemanticSnapshot & { updatedAt: string };
      expectedFingerprint?: string;
    },
  ): Promise<{ layout: StudioCanvasLayout; created: boolean }>;
}

export class StudioCanvasLayoutMergeConflictError extends Error {
  readonly conflicts: string[];

  constructor(conflicts: string[]) {
    super(`画布布局并发修改冲突，未覆盖任何一方：${conflicts.join("、")}`);
    this.name = "StudioCanvasLayoutMergeConflictError";
    this.conflicts = [...conflicts];
  }
}

const ABSENT = Symbol("studio-canvas-layout-absent");
type MaybeValue<T> = T | typeof ABSENT;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function equal(left: unknown, right: unknown): boolean {
  if (left === ABSENT || right === ABSENT) return left === right;
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function chooseThreeWay<T>(
  base: MaybeValue<T>,
  local: MaybeValue<T>,
  remote: MaybeValue<T>,
  path: string,
  conflicts: string[],
): MaybeValue<T> {
  if (equal(local, base)) return remote;
  if (equal(remote, base) || equal(local, remote)) return local;
  conflicts.push(path);
  return remote;
}

function mergeRecord<T>(
  base: Record<string, T>,
  local: Record<string, T>,
  remote: Record<string, T>,
  path: string,
  conflicts: string[],
): Record<string, T> {
  const merged: Record<string, T> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(remote), ...Object.keys(local)]);
  for (const key of keys) {
    const selected = chooseThreeWay(
      Object.hasOwn(base, key) ? base[key]! : ABSENT,
      Object.hasOwn(local, key) ? local[key]! : ABSENT,
      Object.hasOwn(remote, key) ? remote[key]! : ABSENT,
      `${path}.${key}`,
      conflicts,
    );
    if (selected !== ABSENT) merged[key] = selected;
  }
  return merged;
}

function mergeKeyedArray<T>(
  base: readonly T[],
  local: readonly T[],
  remote: readonly T[],
  keyOf: (value: T) => string,
  path: string,
  conflicts: string[],
): T[] {
  const baseMap = new Map(base.map((entry) => [keyOf(entry), entry]));
  const localMap = new Map(local.map((entry) => [keyOf(entry), entry]));
  const remoteMap = new Map(remote.map((entry) => [keyOf(entry), entry]));
  const orderedKeys = [
    ...remoteMap.keys(),
    ...[...localMap.keys()].filter((key) => !remoteMap.has(key)),
    ...[...baseMap.keys()].filter((key) => !remoteMap.has(key) && !localMap.has(key)),
  ];
  const merged: T[] = [];
  for (const key of new Set(orderedKeys)) {
    const selected = chooseThreeWay(
      baseMap.has(key) ? baseMap.get(key)! : ABSENT,
      localMap.has(key) ? localMap.get(key)! : ABSENT,
      remoteMap.has(key) ? remoteMap.get(key)! : ABSENT,
      `${path}.${key}`,
      conflicts,
    );
    if (selected !== ABSENT) merged.push(selected);
  }
  return merged;
}

function mergeStringSet(
  base: readonly string[],
  local: readonly string[],
  remote: readonly string[],
  path: string,
  conflicts: string[],
): string[] {
  const baseSet = new Set(base);
  const localSet = new Set(local);
  const remoteSet = new Set(remote);
  const ordered = [...remote, ...local.filter((value) => !remoteSet.has(value)), ...base];
  const merged: string[] = [];
  for (const value of new Set(ordered)) {
    const selected = chooseThreeWay(
      baseSet.has(value),
      localSet.has(value),
      remoteSet.has(value),
      `${path}.${value}`,
      conflicts,
    );
    if (selected === true) merged.push(value);
  }
  return merged;
}

export function emptyStudioCanvasLayoutSemanticSnapshot(): StudioCanvasLayoutSemanticSnapshot {
  return {
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: {},
    workspaceMode: "projection",
    pinnedNodeIds: [],
    draftCanvasEdges: [],
    workflowGroups: [],
  };
}

export function snapshotStudioCanvasLayout(
  layout: StudioCanvasLayout | null | undefined,
): StudioCanvasLayoutSemanticSnapshot {
  if (!layout) return emptyStudioCanvasLayoutSemanticSnapshot();
  return {
    viewport: { ...layout.viewport },
    nodes: Object.fromEntries(Object.entries(layout.nodes).map(([key, value]) => [key, { ...value }])),
    workspaceMode: layout.workspaceMode,
    pinnedNodeIds: [...layout.pinnedNodeIds],
    draftCanvasEdges: layout.draftCanvasEdges.map((edge) => ({ ...edge })),
    workflowGroups: layout.workflowGroups.map((group) => ({
      ...group,
      panelIds: [...group.panelIds],
      pipeline: [...group.pipeline],
    })),
  };
}

/**
 * 三方语义合并：base 是本窗口最近一次读到的布局，local 是本窗口拟保存状态，
 * remote 是 CAS 冲突后重读的最新布局。不同字段或不同稳定 ID 的并发编辑可合并；
 * 同一字段被双方改成不同值时失败关闭，不静默覆盖。
 */
export function mergeStudioCanvasLayoutThreeWay(
  base: StudioCanvasLayoutSemanticSnapshot,
  local: StudioCanvasLayoutSemanticSnapshot,
  remote: StudioCanvasLayoutSemanticSnapshot,
): StudioCanvasLayoutSemanticSnapshot {
  const conflicts: string[] = [];
  const viewport = chooseThreeWay(base.viewport, local.viewport, remote.viewport, "viewport", conflicts);
  const workspaceMode = chooseThreeWay(
    base.workspaceMode,
    local.workspaceMode,
    remote.workspaceMode,
    "workspaceMode",
    conflicts,
  );
  const nodes = mergeRecord(base.nodes, local.nodes, remote.nodes, "nodes", conflicts);
  const pinnedNodeIds = mergeStringSet(
    base.pinnedNodeIds,
    local.pinnedNodeIds,
    remote.pinnedNodeIds,
    "pinnedNodeIds",
    conflicts,
  );
  const draftCanvasEdges = mergeKeyedArray(
    base.draftCanvasEdges,
    local.draftCanvasEdges,
    remote.draftCanvasEdges,
    (edge) => `${edge.sourceId}->${edge.targetId}`,
    "draftCanvasEdges",
    conflicts,
  );
  const workflowGroups = mergeKeyedArray(
    base.workflowGroups,
    local.workflowGroups,
    remote.workflowGroups,
    (group) => group.id,
    "workflowGroups",
    conflicts,
  );
  if (conflicts.length) throw new StudioCanvasLayoutMergeConflictError(conflicts);
  return {
    viewport: viewport as StudioCanvasViewport,
    nodes,
    workspaceMode: workspaceMode as StudioCanvasWorkspaceMode,
    pinnedNodeIds,
    draftCanvasEdges,
    workflowGroups,
  };
}

function isFingerprintConflict(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("fingerprint") || text.includes("不匹配");
}

export async function saveStudioCanvasLayoutWithCasMerge(input: {
  api: StudioCanvasLayoutCasApi;
  projectRoot: string;
  base: StudioCanvasLayout | null;
  local: StudioCanvasLayoutSemanticSnapshot;
  expectedFingerprint?: string;
  now?: () => string;
}): Promise<{ layout: StudioCanvasLayout; created: boolean; merged: boolean }> {
  const now = input.now ?? (() => new Date().toISOString());
  try {
    const result = await input.api.saveLayout(input.projectRoot, {
      patch: { ...input.local, updatedAt: now() },
      ...(input.expectedFingerprint ? { expectedFingerprint: input.expectedFingerprint } : {}),
    });
    return { ...result, merged: false };
  } catch (error) {
    if (!isFingerprintConflict(error)) throw error;
  }

  const remote = await input.api.loadLayout(input.projectRoot);
  const merged = mergeStudioCanvasLayoutThreeWay(
    snapshotStudioCanvasLayout(input.base),
    input.local,
    snapshotStudioCanvasLayout(remote),
  );
  try {
    const result = await input.api.saveLayout(input.projectRoot, {
      patch: { ...merged, updatedAt: now() },
      ...(remote?.fingerprint ? { expectedFingerprint: remote.fingerprint } : {}),
    });
    return { ...result, merged: true };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    throw new Error(`画布布局 CAS 合并重试失败：${text}`, { cause: error });
  }
}
