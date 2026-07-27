/**
 * 受管画布的冻结参考图投影。
 *
 * 这里只接受正式 freeze pack 中的 controlReferences：它们已经由生成 owner
 * 冻结到 approved primary authority。forbiddenAssets、提示词候选、未登记图片和
 * continuation 文本均不会进入本投影。
 */
import type { StudioGenerationFreezePack } from "./studio-generation.js";
import type { StudioUnitGridGenerationFreezePack } from "./studio-unit-grid-generation.js";

export type StudioCanvasFrozenReferenceType =
  | "character"
  | "scene"
  | "prop"
  | "style"
  | "vfx"
  | "mixed";

export interface StudioCanvasFrozenReferenceProjection {
  referenceId: string;
  mediaSha256: string;
  assetIds: string[];
  assetNames: string[];
  categories: string[];
  roles: string[];
  referenceType: StudioCanvasFrozenReferenceType;
  typeLabel: string;
  title: string;
}

export class StudioCanvasFrozenReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioCanvasFrozenReferenceError";
  }
}

type FrozenAssetMetadata = {
  assetId: string;
  name: string;
  category: string;
  role: string;
  mediaSha256: string;
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function referenceType(input: {
  assetIds: readonly string[];
  names: readonly string[];
  categories: readonly string[];
  roles: readonly string[];
}): StudioCanvasFrozenReferenceType {
  const semantic = [...input.assetIds, ...input.names, ...input.roles].join(" ").toLowerCase();
  if (/style[_ -]?only|style-ref|风格/u.test(semantic)) return "style";
  if (/\bvfx\b|visual[_ -]?effect|meteor|流星纹|特效/u.test(semantic)) return "vfx";
  const categories = unique(input.categories);
  if (categories.length !== 1) return "mixed";
  if (categories[0] === "character" || categories[0] === "scene" || categories[0] === "prop" || categories[0] === "style") {
    return categories[0];
  }
  return "mixed";
}

function typeLabel(type: StudioCanvasFrozenReferenceType): string {
  switch (type) {
    case "character": return "角色参考";
    case "scene": return "场景参考";
    case "prop": return "道具参考";
    case "style": return "风格参考";
    case "vfx": return "VFX参考";
    default: return "复合参考";
  }
}

function unitGridAssetMetadata(pack: StudioUnitGridGenerationFreezePack): Map<string, FrozenAssetMetadata[]> {
  const byAsset = new Map<string, FrozenAssetMetadata[]>();
  for (const panel of pack.panels) {
    for (const asset of panel.panelPack.assets) {
      const row: FrozenAssetMetadata = {
        assetId: asset.assetId,
        name: asset.definition.name,
        category: asset.category,
        role: asset.role,
        mediaSha256: asset.media.sha256,
      };
      const entries = byAsset.get(asset.assetId) ?? [];
      if (!entries.some((entry) => entry.mediaSha256 === row.mediaSha256 && entry.role === row.role)) entries.push(row);
      byAsset.set(asset.assetId, entries);
    }
  }
  return byAsset;
}

function panelAssetMetadata(pack: StudioGenerationFreezePack): Map<string, FrozenAssetMetadata[]> {
  return new Map(pack.assets.map((asset) => [asset.assetId, [{
    assetId: asset.assetId,
    name: asset.definition.name,
    category: asset.category,
    role: asset.role,
    mediaSha256: asset.media.sha256,
  }]]));
}

function projection(input: {
  referenceId: string;
  mediaSha256: string;
  coveredAssetIds: readonly string[];
  declaredCategories: readonly string[];
  declaredRoles: readonly string[];
  metadata: Map<string, FrozenAssetMetadata[]>;
}): StudioCanvasFrozenReferenceProjection {
  const referenceId = input.referenceId.trim();
  const mediaSha256 = input.mediaSha256.trim();
  const assetIds = unique(input.coveredAssetIds);
  if (!referenceId || !/^[a-f0-9]{64}$/u.test(mediaSha256) || assetIds.length === 0) {
    throw new StudioCanvasFrozenReferenceError("冻结控制参考缺少稳定 ID、媒体身份或覆盖资产。 ");
  }
  const matched = assetIds.flatMap((assetId) => (
    input.metadata.get(assetId)?.filter((entry) => entry.mediaSha256 === mediaSha256) ?? []
  ));
  if (new Set(matched.map((entry) => entry.assetId)).size !== assetIds.length) {
    throw new StudioCanvasFrozenReferenceError(`冻结控制参考 ${referenceId} 与 panel asset closure 不一致。`);
  }
  const assetNames = unique(matched.map((entry) => entry.name));
  const categories = unique([...input.declaredCategories, ...matched.map((entry) => entry.category)]);
  const roles = unique([...input.declaredRoles, ...matched.map((entry) => entry.role)]);
  const resolvedType = referenceType({ assetIds, names: assetNames, categories, roles });
  return {
    referenceId,
    mediaSha256,
    assetIds,
    assetNames,
    categories,
    roles,
    referenceType: resolvedType,
    typeLabel: typeLabel(resolvedType),
    title: assetNames.join(" / ") || assetIds.join(" / "),
  };
}

/**
 * 从不可变 pack 还原模型实际收到的参考图片。严格校验 ref→asset→media 闭包；
 * 任一项漂移就失败关闭，不用当前资产列表猜测或替换历史参考版本。
 */
export function projectStudioCanvasFrozenReferences(
  pack: StudioGenerationFreezePack | StudioUnitGridGenerationFreezePack,
): StudioCanvasFrozenReferenceProjection[] {
  if (pack.schemaVersion === 5) {
    const metadata = unitGridAssetMetadata(pack);
    return pack.controlReferences.map((reference) => projection({
      referenceId: reference.referenceId,
      mediaSha256: reference.mediaSha256,
      coveredAssetIds: reference.coveredAssetIds,
      declaredCategories: reference.categories,
      declaredRoles: reference.roles,
      metadata,
    }));
  }
  const metadata = panelAssetMetadata(pack);
  return pack.request.controlReferences.map((reference) => projection({
    referenceId: `panel-reference-${reference.assetId}`,
    mediaSha256: reference.mediaSha256,
    coveredAssetIds: [reference.assetId],
    declaredCategories: [reference.category],
    declaredRoles: [reference.role],
    metadata,
  }));
}
