import type {
  StudioDashboardQueueKind,
  StudioProductionDashboardQuery,
  StudioProductionDashboardResponse,
} from "../../core/studio-production-dashboard.js";
import { createProjectionLoadController } from "./use-projection-refresh.js";

export interface StudioProductionDashboardUiApi {
  getDashboard(
    projectRoot: string,
    query: StudioProductionDashboardQuery,
  ): Promise<StudioProductionDashboardResponse>;
  /**
   * 当前单元的有界聚合投影：一次读取 2–6 格、正式整板、冻结引用、
   * observation 与四轨时间线，避免渲染器逐格拼接 owner 状态。
   */
  getProductionProjectionBundle?(
    projectRoot: string,
    query: import("../../core/studio-production-projection-bundle.js").StudioProductionProjectionBundleQuery,
  ): ReturnType<typeof import("../../core/studio-production-projection-bundle.js").buildStudioProductionProjectionBundle>;
  /** 已通过外部人工验收的历史整板只读证据；仅供连续性人工复核看原图，不构成新的模型调用。 */
  getHistoricalEvidenceByUnit?(
    projectRoot: string,
    unitId: string,
  ): ReturnType<typeof import("../../core/studio-generation-ledger.js").readStudioHistoricalGenerationEvidenceByUnit>;
  /** 当前停检账本的只读整板 identity；用于人工补连续性，不可据此派发或再次审片写回。 */
  getCheckpointCanvasProjection?(
    projectRoot: string,
  ): ReturnType<typeof import("../../core/studio-generation-checkpoint.js").getStudioGenerationCheckpointCanvasProjection>;
}

/** 首卡 waiter 可接上刚完成的同参 units prefetch；不是写权限缓存。 */
export const STUDIO_DASHBOARD_FIRST_CARD_UNITS_HOLD_MS = 1_500;

export interface StudioDashboardRequestCoalescerOptions {
  now?: () => number;
  firstCardUnitsHoldMs?: number;
}

/**
 * 同一工程的 overview，以及参数完全相同的 units，在同一时刻只向 Core 请求一次。
 *
 * Material Studio 外壳与 Dashboard 子视图会在首屏同时读取 overview；App 冷启动也会
 * 在确认 drama 工作区后预发默认 units。共享进行中的 Promise 可把 Core 深读取与模块
 * 预热并行。units 另外保留刚完成的同参结果一小段时间，只为接住 prefetch 结束后
 * 才挂上的首卡 waiter；overview 与失败结果不进入这段 hold，也不是写权限缓存。
 */
export function createStudioDashboardRequestCoalescer(
  api: StudioProductionDashboardUiApi,
  options: StudioDashboardRequestCoalescerOptions = {},
): StudioProductionDashboardUiApi {
  const inFlight = new Map<string, Promise<StudioProductionDashboardResponse>>();
  const firstCardUnitsHold = new Map<string, {
    shared: Promise<StudioProductionDashboardResponse>;
    expiresAt: number;
  }>();
  const now = options.now ?? Date.now;
  const firstCardUnitsHoldMs = options.firstCardUnitsHoldMs ?? STUDIO_DASHBOARD_FIRST_CARD_UNITS_HOLD_MS;
  if (!Number.isFinite(firstCardUnitsHoldMs) || firstCardUnitsHoldMs < 0) {
    throw new RangeError("units 首卡 hold 必须是非负有限数。");
  }
  return {
    ...api,
    getDashboard(projectRoot, query) {
      if (query.operation !== "overview" && query.operation !== "units") {
        return api.getDashboard(projectRoot, query);
      }
      const key = dashboardRequestToken(projectRoot, query);
      const existing = inFlight.get(key);
      if (existing) return existing;
      if (query.operation === "units") {
        const held = firstCardUnitsHold.get(key);
        if (held && held.expiresAt > now()) {
          firstCardUnitsHold.delete(key);
          return held.shared;
        }
      }
      const request = api.getDashboard(projectRoot, query);
      let shared!: Promise<StudioProductionDashboardResponse>;
      shared = request.then((value) => {
        if (query.operation === "units") {
          firstCardUnitsHold.set(key, {
            shared,
            expiresAt: now() + firstCardUnitsHoldMs,
          });
        }
        return value;
      }).finally(() => {
        if (inFlight.get(key) === shared) {
          inFlight.delete(key);
        }
      });
      inFlight.set(key, shared);
      return shared;
    },
  };
}

export type DashboardLoadState =
  | { status: "idle" }
  | { status: "loading"; token: string }
  | { status: "ready"; token: string; data: StudioProductionDashboardResponse }
  | { status: "error"; token: string; message: string };

export interface DashboardSelection {
  unitId?: string;
  panelId?: string;
  assetId?: string;
  queue?: StudioDashboardQueueKind;
}

/** operation 流键：同工程并发 overview/units/unit 互不取消。 */
export type DashboardStreamKey =
  | "overview"
  | "units"
  | "unit"
  | "assets"
  | "appearances"
  | "queue";

export function dashboardStreamKey(query: StudioProductionDashboardQuery): DashboardStreamKey {
  return query.operation;
}

/** 每个 async stream 绑定 projectRoot + operation + query 指纹；切项目时旧响应失效。 */
export function dashboardRequestToken(
  projectRoot: string,
  query: StudioProductionDashboardQuery,
): string {
  return `${projectRoot}\u0000${query.operation}\u0000${JSON.stringify(query)}`;
}

/**
 * 多流控制器：overview / units / unit / queue / appearances 各自独立 token。
 * 切换工程时 invalidate 全部流，防止跨工程陈旧响应污染。
 * 同 stream 每次 begin 递增 seq，避免相同 query 复用 token 导致旧响应被当成当前。
 * 实现委托 Qwen D2 `createProjectionLoadController`。
 */
export function createDashboardLoadController() {
  const inner = createProjectionLoadController<DashboardStreamKey, StudioProductionDashboardQuery>(
    dashboardStreamKey,
    dashboardRequestToken,
  );
  return {
    begin(projectRoot: string, query: StudioProductionDashboardQuery): string {
      return inner.beginQuery(projectRoot, query);
    },
    isCurrent(token: string, query?: StudioProductionDashboardQuery): boolean {
      return inner.isCurrentQuery(token, query);
    },
    invalidate(): void {
      inner.invalidate();
    },
    invalidateStream(stream: DashboardStreamKey): void {
      inner.invalidateStream(stream);
    },
  };
}
