import { runBoundedAsyncTasks } from "./bounded-async-runner.js";

export const STORYBOARD_WIZARD_ASSET_READ_CONCURRENCY = 4;

/**
 * 15 秒向导只读解析所引用的资产，并保持首次出现顺序。
 *
 * 写命令仍由 App 负责编排；这里仅隔离去重和有界读取，避免高引用量时把
 * 全部 IPC 同时压入主进程。
 */
export async function resolveStoryboardWizardAssets<T>(
  panels: ReadonlyArray<{ suggestedAssetIds: readonly string[] }>,
  loadAsset: (assetId: string) => Promise<T | null>,
): Promise<Map<string, Awaited<T>>> {
  const assetIds = [...new Set(panels.flatMap((panel) => panel.suggestedAssetIds))];
  const loaded = await runBoundedAsyncTasks(
    assetIds.map((assetId) => async () => ({ assetId, asset: await loadAsset(assetId) })),
    STORYBOARD_WIZARD_ASSET_READ_CONCURRENCY,
  );
  const assets = new Map<string, Awaited<T>>();
  for (const entry of loaded) {
    if (entry.asset !== null) assets.set(entry.assetId, entry.asset);
  }
  return assets;
}
