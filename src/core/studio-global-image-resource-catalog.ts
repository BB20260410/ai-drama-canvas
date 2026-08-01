/**
 * 全项目图片总资源兼容入口。
 *
 * 唯一跨项目 registry / SQLite 快照 owner 是 studio-global-asset-catalog；
 * 本模块只转发公开 API 和测试诊断，不自行打开数据库或持有第二份缓存。
 */
import type { GlobalStudioAssetCatalogCacheMetrics } from "./studio-global-asset-catalog.js";
import {
  __getGlobalStudioAssetCatalogCacheMetricsForTests,
  __resetGlobalStudioAssetCatalogCacheForTests,
  __setGlobalStudioAssetCatalogSnapshotProbeForTests,
  getGlobalStudioImageResourceFromUnifiedCatalog,
  listGlobalStudioImageResourcesFromUnifiedCatalog,
} from "./studio-global-asset-catalog.js";
import type {
  GlobalStudioImageResourceItem,
  GlobalStudioImageResourcePage,
  GlobalStudioImageResourceQuery,
} from "./studio-global-image-resource-projection.js";

export type {
  GlobalStudioAssetCatalogProject,
  GlobalStudioAssetResourceAssociation,
  GlobalStudioImageClassificationStateCounts,
  GlobalStudioImageResourceCategory,
  GlobalStudioImageResourceCounts,
  GlobalStudioImageResourceItem,
  GlobalStudioImageResourcePage,
  GlobalStudioImageResourceProjectionProject,
  GlobalStudioImageResourceQuery,
  GlobalStudioImageResourceRoleCounts,
  GlobalStudioImageResourceSnapshotItem,
  GlobalStudioImageResourceSnapshotProjection,
} from "./studio-global-image-resource-projection.js";

export type GlobalStudioImageResourceCatalogCacheMetrics =
  GlobalStudioAssetCatalogCacheMetrics;

/** 仅供隔离测试重置统一进程内投影；不触碰 registry、SQLite 或 CAS。 */
export function __resetGlobalStudioImageResourceCatalogCacheForTests(): void {
  __resetGlobalStudioAssetCatalogCacheForTests();
}

/** 仅供隔离测试读取统一 owner 的机械计数。 */
export function __getGlobalStudioImageResourceCatalogCacheMetricsForTests():
GlobalStudioImageResourceCatalogCacheMetrics {
  return __getGlobalStudioAssetCatalogCacheMetricsForTests();
}

/** 仅用于确定性制造统一快照构建前后来源移动。 */
export function __setGlobalStudioImageResourceCatalogSnapshotProbeForTests(
  probe: Parameters<typeof __setGlobalStudioAssetCatalogSnapshotProbeForTests>[0],
): void {
  __setGlobalStudioAssetCatalogSnapshotProbeForTests(probe);
}

export async function listGlobalStudioImageResources(
  query: GlobalStudioImageResourceQuery,
): Promise<GlobalStudioImageResourcePage> {
  return listGlobalStudioImageResourcesFromUnifiedCatalog(query);
}

export async function getGlobalStudioImageResource(
  projectRoot: string,
  mediaSha256: string,
): Promise<GlobalStudioImageResourceItem | null> {
  return getGlobalStudioImageResourceFromUnifiedCatalog(projectRoot, mediaSha256);
}
