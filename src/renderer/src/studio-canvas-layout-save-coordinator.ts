import type { StudioCanvasLayout } from "../../core/studio-canvas-layout-types.js";
import {
  mergeStudioCanvasLayoutThreeWay,
  snapshotStudioCanvasLayout,
  type StudioCanvasLayoutSemanticSnapshot,
} from "./studio-canvas-layout-cas-merge.js";

export interface StudioCanvasLayoutSaveRequest {
  projectRoot: string;
  generation: number;
  local: StudioCanvasLayoutSemanticSnapshot;
  /** 切工程/卸载 flush 已同步冻结本地快照；即使随后 generation 失效也必须落旧工程。 */
  force?: boolean;
}

export interface StudioCanvasLayoutSaveResult {
  layout: StudioCanvasLayout;
  created: boolean;
  merged: boolean;
}

interface FrozenLayoutSaveRequest extends StudioCanvasLayoutSaveRequest {
  local: StudioCanvasLayoutSemanticSnapshot;
  baseAtEnqueue: StudioCanvasLayoutSemanticSnapshot;
}

export interface StudioCanvasLayoutSaveCoordinatorOptions {
  persist(input: {
    projectRoot: string;
    base: StudioCanvasLayout | null;
    local: StudioCanvasLayoutSemanticSnapshot;
    expectedFingerprint?: string;
  }): Promise<StudioCanvasLayoutSaveResult>;
  isRequestCurrent(request: StudioCanvasLayoutSaveRequest): boolean;
  isProjectCurrent(projectRoot: string): boolean;
  onAutomaticAccepted?(
    request: StudioCanvasLayoutSaveRequest,
    result: StudioCanvasLayoutSaveResult,
    context: { requestCurrent: boolean; superseded: boolean },
  ): void;
  onAutomaticError?(request: StudioCanvasLayoutSaveRequest, error: unknown): void;
}

export interface StudioCanvasLayoutSaveCoordinator {
  setBaseline(projectRoot: string, layout: StudioCanvasLayout | null): void;
  setReflectedSemantic(
    projectRoot: string,
    semantic: StudioCanvasLayoutSemanticSnapshot,
  ): void;
  saveLatest(request: StudioCanvasLayoutSaveRequest): void;
  saveExclusive(request: StudioCanvasLayoutSaveRequest): Promise<StudioCanvasLayoutSaveResult>;
  flush(options?: { projectRoot?: string; force?: boolean }): Promise<void>;
}

interface ExclusiveQueueEntry {
  request: FrozenLayoutSaveRequest;
  resolve: (result: StudioCanvasLayoutSaveResult) => void;
  reject: (error: unknown) => void;
}

function cloneLayout(layout: StudioCanvasLayout | null): StudioCanvasLayout | null {
  return layout ? structuredClone(layout) : null;
}

function freezeRequest(
  request: StudioCanvasLayoutSaveRequest,
  baseAtEnqueue: StudioCanvasLayoutSemanticSnapshot,
): FrozenLayoutSaveRequest {
  return {
    ...request,
    local: structuredClone(request.local),
    baseAtEnqueue: structuredClone(baseAtEnqueue),
  };
}

/**
 * 单窗口布局保存协调器。
 *
 * - 所有真实 save 严格单写；
 * - 自动保存只保留在飞任务后的最新快照；
 * - 每次成功立即推进该工程的 base/fingerprint，后续本窗口写不会把自己的成功
 *   误判成跨窗口冲突；
 * - 最新快照在执行前以 enqueue 时 base → local → 当前已落盘 base 做三方重放，
 *   因而仍保留真实跨窗口 nodes/pinned/edges/viewport 冲突的 fail-closed 语义。
 */
export function createStudioCanvasLayoutSaveCoordinator(
  options: StudioCanvasLayoutSaveCoordinatorOptions,
): StudioCanvasLayoutSaveCoordinator {
  const baselines = new Map<string, StudioCanvasLayout | null>();
  const reflectedSemantics = new Map<string, StudioCanvasLayoutSemanticSnapshot>();
  let activeAutomatic: FrozenLayoutSaveRequest | null = null;
  const pendingAutomatics = new Map<string, FrozenLayoutSaveRequest>();
  const exclusiveQueue: ExclusiveQueueEntry[] = [];
  let drainPromise: Promise<void> | null = null;

  const baselineFor = (projectRoot: string): StudioCanvasLayout | null => (
    cloneLayout(baselines.get(projectRoot) ?? null)
  );
  const baselineSemanticFor = (
    projectRoot: string,
  ): StudioCanvasLayoutSemanticSnapshot => snapshotStudioCanvasLayout(
    baselineFor(projectRoot),
  );
  const reflectedSemanticFor = (
    projectRoot: string,
  ): StudioCanvasLayoutSemanticSnapshot => structuredClone(
    reflectedSemantics.get(projectRoot) ?? baselineSemanticFor(projectRoot),
  );
  const pendingAutomaticForProject = (
    projectRoot: string,
  ): FrozenLayoutSaveRequest | null => pendingAutomatics.get(projectRoot) ?? null;

  const effectiveLocal = (
    request: FrozenLayoutSaveRequest,
    currentBase: StudioCanvasLayout | null,
  ): StudioCanvasLayoutSemanticSnapshot => mergeStudioCanvasLayoutThreeWay(
    request.baseAtEnqueue,
    request.local,
    snapshotStudioCanvasLayout(currentBase),
  );

  const persistRequest = async (
    request: FrozenLayoutSaveRequest,
  ): Promise<StudioCanvasLayoutSaveResult> => {
    const currentBase = baselineFor(request.projectRoot);
    const local = effectiveLocal(request, currentBase);
    const result = await options.persist({
      projectRoot: request.projectRoot,
      base: currentBase,
      local,
      ...(currentBase?.fingerprint
        ? { expectedFingerprint: currentBase.fingerprint }
        : {}),
    });
    baselines.set(request.projectRoot, structuredClone(result.layout));
    return result;
  };

  const drain = async (): Promise<void> => {
    while (exclusiveQueue.length > 0 || pendingAutomatics.size > 0) {
      const exclusive = exclusiveQueue.shift();
      if (exclusive) {
        try {
          exclusive.resolve(await persistRequest(exclusive.request));
        } catch (error) {
          exclusive.reject(error);
        }
        continue;
      }

      const pendingEntry = pendingAutomatics.entries().next().value as
        | [string, FrozenLayoutSaveRequest]
        | undefined;
      const request = pendingEntry?.[1] ?? null;
      if (pendingEntry) pendingAutomatics.delete(pendingEntry[0]);
      if (!request) continue;
      if (!request.force && !options.isRequestCurrent(request)) continue;
      activeAutomatic = request;
      try {
        const result = await persistRequest(request);
        const requestCurrent = options.isRequestCurrent(request);
        const superseded = Boolean(pendingAutomaticForProject(request.projectRoot));
        if (requestCurrent && !superseded) {
          reflectedSemantics.set(
            request.projectRoot,
            snapshotStudioCanvasLayout(result.layout),
          );
        }
        if (options.isProjectCurrent(request.projectRoot)) {
          options.onAutomaticAccepted?.(request, result, {
            requestCurrent,
            superseded,
          });
        }
      } catch (error) {
        const superseding = pendingAutomaticForProject(request.projectRoot);
        if (superseding) {
          // 在飞写失败时，最新快照仍代表用户最终可见状态。把它重新锚到最近一次
          // 已确认落盘的 baseline，下一轮只尝试一次；若仍是跨窗口真冲突，则由
          // 该最新请求自身失败并报告，不无限重试，也不静默丢掉 pending。
          const rebased = freezeRequest(
            superseding,
            baselineSemanticFor(request.projectRoot),
          );
          pendingAutomatics.set(request.projectRoot, rebased);
          reflectedSemantics.set(
            request.projectRoot,
            structuredClone(rebased.local),
          );
        } else {
          reflectedSemantics.set(
            request.projectRoot,
            baselineSemanticFor(request.projectRoot),
          );
          if (options.isProjectCurrent(request.projectRoot)) {
            options.onAutomaticError?.(request, error);
          }
        }
      } finally {
        activeAutomatic = null;
      }
    }
  };

  const ensureDrain = (): void => {
    if (drainPromise) return;
    const operation = drain();
    drainPromise = operation;
    void operation.finally(() => {
      if (drainPromise !== operation) return;
      drainPromise = null;
      if (exclusiveQueue.length > 0 || pendingAutomatics.size > 0) ensureDrain();
    });
  };

  return {
    setBaseline(projectRoot, layout) {
      baselines.set(projectRoot, cloneLayout(layout));
      reflectedSemantics.set(projectRoot, snapshotStudioCanvasLayout(layout));
    },
    setReflectedSemantic(projectRoot, semantic) {
      reflectedSemantics.set(projectRoot, structuredClone(semantic));
    },
    saveLatest(request) {
      const existingPending = pendingAutomaticForProject(request.projectRoot);
      const existingBase = existingPending
        ? existingPending.baseAtEnqueue
        : activeAutomatic?.projectRoot === request.projectRoot
          ? activeAutomatic.local
          : reflectedSemanticFor(request.projectRoot);
      pendingAutomatics.set(
        request.projectRoot,
        freezeRequest(request, existingBase),
      );
      reflectedSemantics.set(request.projectRoot, structuredClone(request.local));
      ensureDrain();
    },
    saveExclusive(request) {
      const frozen = freezeRequest(request, baselineSemanticFor(request.projectRoot));
      const result = new Promise<StudioCanvasLayoutSaveResult>((resolve, reject) => {
        exclusiveQueue.push({ request: frozen, resolve, reject });
      });
      ensureDrain();
      return result;
    },
    async flush(flushOptions = {}) {
      if (flushOptions.force && flushOptions.projectRoot) {
        const pending = pendingAutomaticForProject(flushOptions.projectRoot);
        if (pending && !pending.force) {
          pendingAutomatics.set(flushOptions.projectRoot, {
            ...pending,
            force: true,
          });
        }
      }
      while (drainPromise || pendingAutomatics.size > 0 || exclusiveQueue.length > 0) {
        ensureDrain();
        const currentDrain = drainPromise;
        if (currentDrain) await currentDrain;
      }
    },
  };
}
