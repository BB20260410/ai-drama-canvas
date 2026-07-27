import { describe, expect, it } from "vitest";
import {
  createEmptyMaterialStudioCreateDraft,
  resetMaterialStudioCreateDraft,
} from "../src/renderer/src/material-studio-create-draft.js";

describe("Material Studio 工程切换边界", () => {
  it("工程 A 的创建草稿切到 B 时原位清空并回到安全默认分类", () => {
    const draft = createEmptyMaterialStudioCreateDraft("scene");
    draft.name = "工程 A 场景";
    draft.aliases = "A-旧别名";
    draft.description = "只属于工程 A";
    draft.positiveLocks = "A 的锁";
    draft.applicabilityProjects = "project-a";

    const sameReactiveOwner = draft;
    resetMaterialStudioCreateDraft(draft);

    expect(draft).toBe(sameReactiveOwner);
    expect(draft).toEqual(createEmptyMaterialStudioCreateDraft("character"));
    expect(JSON.stringify(draft)).not.toContain("工程 A");
    expect(JSON.stringify(draft)).not.toContain("project-a");
  });
});
