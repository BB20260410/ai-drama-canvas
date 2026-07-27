export type MaterialStudioCreateDraftCategory = "character" | "scene" | "prop" | "style";

export interface MaterialStudioCreateDraftState {
  category: MaterialStudioCreateDraftCategory;
  name: string;
  aliases: string;
  description: string;
  identityFeatures: string;
  positiveLocks: string;
  negativeLocks: string;
  defaultPrompt: string;
  applicabilityProjects: string;
  applicabilitySeasons: string;
  applicabilityEpisodes: string;
  applicabilityUnits: string;
  applicabilityTags: string;
}

export function createEmptyMaterialStudioCreateDraft(
  category: MaterialStudioCreateDraftCategory = "character",
): MaterialStudioCreateDraftState {
  return {
    category,
    name: "",
    aliases: "",
    description: "",
    identityFeatures: "",
    positiveLocks: "",
    negativeLocks: "",
    defaultPrompt: "",
    applicabilityProjects: "",
    applicabilitySeasons: "",
    applicabilityEpisodes: "",
    applicabilityUnits: "",
    applicabilityTags: "",
  };
}

/**
 * 工程切换时必须原位清空 reactive 草稿，不能只关闭弹窗或换对象引用。
 * 原位重置可确保模板仍绑定同一 reactive owner，同时不会把工程 A 的输入带到 B。
 */
export function resetMaterialStudioCreateDraft(
  target: MaterialStudioCreateDraftState,
  category: MaterialStudioCreateDraftCategory = "character",
): void {
  Object.assign(target, createEmptyMaterialStudioCreateDraft(category));
}
