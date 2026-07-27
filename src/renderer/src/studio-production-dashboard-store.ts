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

/**
 * 同一工程的 overview 在同一时刻只向 Core 请求一次。
 *
 * Material Studio 外壳与 Dashboard 子视图会在首屏同时读取 overview；共享进行中的
 * Promise 可避免重复扫描大型工程。请求完成后立即释放，不缓存业务结果，因而不会把
 * 旧工程状态带入下一次刷新。其他 operation 保持各自原有的请求与取消语义。
 */
export function createStudioDashboardRequestCoalescer(
  api: StudioProductionDashboardUiApi,
): StudioProductionDashboardUiApi {
  const overviewInFlight = new Map<string, Promise<StudioProductionDashboardResponse>>();
  return {
    ...api,
    getDashboard(projectRoot, query) {
      if (query.operation !== "overview") {
        return api.getDashboard(projectRoot, query);
      }
      const existing = overviewInFlight.get(projectRoot);
      if (existing) return existing;
      const request = api.getDashboard(projectRoot, query);
      const shared = request.finally(() => {
        if (overviewInFlight.get(projectRoot) === shared) {
          overviewInFlight.delete(projectRoot);
        }
      });
      overviewInFlight.set(projectRoot, shared);
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
