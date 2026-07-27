/**
 * Browser-safe 画布连线预检。
 *
 * 这里只把画布草稿与已投影的正式 panel 控制资产做差集，
 * 不读库、不冻结、不改 BindingSet。最终准入仍由 generation owner 重建并校验。
 */

export type StudioCanvasMismatchAssetCategory = "character" | "scene" | "prop" | string;

export interface StudioCanvasMismatchAsset {
  id: string;
  category: StudioCanvasMismatchAssetCategory;
  name: string;
}

export interface StudioCanvasMismatchPanel {
  panelId: string;
  label: string;
  expectedAssetIds: readonly string[];
}

export interface StudioCanvasMismatchConnection {
  panelId: string;
  assetIds: readonly string[];
  scriptDocumentId: string | null;
  promptDocumentId: string | null;
}

export interface StudioCanvasWorkflowMismatch {
  panelId: string;
  panelLabel: string;
  missingAssetIds: string[];
  extraAssetIds: string[];
  missingScript: boolean;
  missingPrompt: boolean;
  message: string;
}

function categoryLabel(category: string): string {
  if (category === "character") return "人物";
  if (category === "scene") return "场景";
  if (category === "prop") return "道具";
  return "资产";
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "en"));
}

function describeAssets(ids: readonly string[], assetsById: ReadonlyMap<string, StudioCanvasMismatchAsset>): string {
  return ids.map((id) => {
    const asset = assetsById.get(id);
    return asset ? `${categoryLabel(asset.category)}“${asset.name}”` : `资产“${id}”`;
  }).join("、");
}

/** 返回第一个不完整 panel；null 仅表示视图差集通过，不代表正式冻结通过。 */
export function describeStudioCanvasWorkflowMismatch(input: {
  panels: readonly StudioCanvasMismatchPanel[];
  connections: readonly StudioCanvasMismatchConnection[];
  assets?: readonly StudioCanvasMismatchAsset[];
}): StudioCanvasWorkflowMismatch | null {
  const connectionByPanel = new Map(input.connections.map((entry) => [entry.panelId, entry] as const));
  const assetsById = new Map((input.assets ?? []).map((asset) => [asset.id, asset] as const));

  for (const panel of input.panels) {
    const expected = uniqueSorted(panel.expectedAssetIds);
    const connection = connectionByPanel.get(panel.panelId);
    const actual = uniqueSorted(connection?.assetIds ?? []);
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missingAssetIds = expected.filter((id) => !actualSet.has(id));
    const extraAssetIds = actual.filter((id) => !expectedSet.has(id));
    const missingScript = !connection?.scriptDocumentId;
    const missingPrompt = !connection?.promptDocumentId;
    if (!missingAssetIds.length && !extraAssetIds.length && !missingScript && !missingPrompt) continue;

    const details: string[] = [];
    if (missingAssetIds.length) details.push(`缺少 ${describeAssets(missingAssetIds, assetsById)}`);
    if (extraAssetIds.length) details.push(`多出 ${describeAssets(extraAssetIds, assetsById)}`);
    if (missingScript) details.push("缺少当前剧本连线");
    if (missingPrompt) details.push("缺少当前提示词连线");
    return {
      panelId: panel.panelId,
      panelLabel: panel.label,
      missingAssetIds,
      extraAssetIds,
      missingScript,
      missingPrompt,
      message: `${panel.label}的连线不完整：${details.join("；")}。画布未改动正式绑定，请补齐后再开始。`,
    };
  }
  return null;
}
