import { AsyncLocalStorage } from "node:async_hooks";

export type StudioUnitsReadPhaseName =
  | "request-total"
  | "main-managed-project-preflight"
  | "dashboard-core-total"
  | "dashboard-readonly-shell"
  | "binding-owner-total"
  | "binding-managed-inspect"
  | "managed-inspect-shell"
  | "managed-generation-ledger"
  | "production-page"
  | "production-facets"
  | "binding-heads"
  | "successors"
  | "binding-map"
  | "dashboard-map-digest";

export type StudioUnitsReadCounterName =
  | "managedProjectShellInspections"
  | "generationLedgerEnsureCalls"
  | "generationLedgerInitializationStarts"
  | "generationLedgerInitializationJoins"
  | "productionDirectoryEnsureCalls"
  | "productionOpenDatabaseCalls"
  | "productionReadOnlyProbeConnections"
  | "productionOwnerConnections"
  | "productionBusinessSqlExecutions"
  | "unitPageQueries"
  | "unitTimingQueries"
  | "episodeStartQueries"
  | "facetQueries"
  | "bindingHeadQueries"
  | "successorQueries"
  | "productionSchemaCacheHits"
  | "productionSchemaCacheMisses"
  | "returnedUnitCount";

export interface StudioUnitsReadPhaseTiming {
  phase: StudioUnitsReadPhaseName;
  startOffsetMs: number;
  durationMs: number;
}

export type StudioUnitsReadCounters = Record<StudioUnitsReadCounterName, number>;

export interface StudioUnitsReadProbeSnapshot {
  schemaVersion: 1;
  phases: StudioUnitsReadPhaseTiming[];
  counters: StudioUnitsReadCounters;
}

export interface StudioUnitsReadProbeOptions {
  now?: () => number;
  onPhase?: (timing: StudioUnitsReadPhaseTiming) => void;
}

interface StudioUnitsReadProbeStore {
  startedAt: number;
  now: () => number;
  onPhase?: (timing: StudioUnitsReadPhaseTiming) => void;
  phases: StudioUnitsReadPhaseTiming[];
  counters: StudioUnitsReadCounters;
}

const counterNames = [
  "managedProjectShellInspections",
  "generationLedgerEnsureCalls",
  "generationLedgerInitializationStarts",
  "generationLedgerInitializationJoins",
  "productionDirectoryEnsureCalls",
  "productionOpenDatabaseCalls",
  "productionReadOnlyProbeConnections",
  "productionOwnerConnections",
  "productionBusinessSqlExecutions",
  "unitPageQueries",
  "unitTimingQueries",
  "episodeStartQueries",
  "facetQueries",
  "bindingHeadQueries",
  "successorQueries",
  "productionSchemaCacheHits",
  "productionSchemaCacheMisses",
  "returnedUnitCount",
] as const satisfies readonly StudioUnitsReadCounterName[];

const unitsReadProbeStorage = new AsyncLocalStorage<StudioUnitsReadProbeStore>();

function emptyCounters(): StudioUnitsReadCounters {
  return Object.fromEntries(counterNames.map((name) => [name, 0])) as StudioUnitsReadCounters;
}

function snapshot(store: StudioUnitsReadProbeStore): StudioUnitsReadProbeSnapshot {
  return {
    schemaVersion: 1,
    phases: store.phases.map((phase) => ({ ...phase })),
    counters: { ...store.counters },
  };
}

/**
 * 仅为显式 T23 units 冷读请求建立一次 AsyncLocalStorage 诊断上下文。
 * 关闭时不创建 store、不读取时钟，也不改变 callback 的返回值或错误。
 */
export async function withStudioUnitsReadProbe<T>(
  enabled: boolean,
  work: () => Promise<T>,
  options: StudioUnitsReadProbeOptions = {},
): Promise<{ value: T; snapshot?: StudioUnitsReadProbeSnapshot }> {
  if (!enabled) return { value: await work() };
  const now = options.now ?? (() => performance.now());
  const store: StudioUnitsReadProbeStore = {
    startedAt: now(),
    now,
    ...(options.onPhase ? { onPhase: options.onPhase } : {}),
    phases: [],
    counters: emptyCounters(),
  };
  return unitsReadProbeStorage.run(store, async () => {
    const value = await work();
    return { value, snapshot: snapshot(store) };
  });
}

export function recordStudioUnitsReadCounter(
  name: StudioUnitsReadCounterName,
  delta = 1,
): void {
  const store = unitsReadProbeStorage.getStore();
  if (!store || !Number.isSafeInteger(delta) || delta < 0) return;
  const next = store.counters[name] + delta;
  if (!Number.isSafeInteger(next)) return;
  store.counters[name] = next;
}

function beginStudioUnitsReadPhase(): number | undefined {
  const store = unitsReadProbeStorage.getStore();
  return store?.now();
}

function finishStudioUnitsReadPhase(
  phase: StudioUnitsReadPhaseName,
  startedAt: number | undefined,
): void {
  const store = unitsReadProbeStorage.getStore();
  if (!store || startedAt === undefined) return;
  const timing: StudioUnitsReadPhaseTiming = {
    phase,
    startOffsetMs: Math.max(0, startedAt - store.startedAt),
    durationMs: Math.max(0, store.now() - startedAt),
  };
  store.phases.push(timing);
  // 诊断观察器永远不能改变正式只读 owner 的成功、失败或异常身份。
  try { store.onPhase?.({ ...timing }); } catch { /* diagnostic observer only */ }
}

export async function measureStudioUnitsReadPhase<T>(
  phase: StudioUnitsReadPhaseName,
  work: () => Promise<T>,
): Promise<T> {
  if (!unitsReadProbeStorage.getStore()) return work();
  const startedAt = beginStudioUnitsReadPhase();
  try {
    return await work();
  } finally {
    finishStudioUnitsReadPhase(phase, startedAt);
  }
}

export function measureStudioUnitsReadSyncPhase<T>(
  phase: StudioUnitsReadPhaseName,
  work: () => T,
): T {
  if (!unitsReadProbeStorage.getStore()) return work();
  const startedAt = beginStudioUnitsReadPhase();
  try {
    return work();
  } finally {
    finishStudioUnitsReadPhase(phase, startedAt);
  }
}
