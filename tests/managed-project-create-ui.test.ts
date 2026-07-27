import { describe, expect, it } from "vitest";
import {
  MANAGED_STUDIO_CREATE_MODE,
  validateManagedStudioCreateDraft,
} from "../src/renderer/src/managed-project-create.js";

describe("受管素材工程 UI 创建契约", () => {
  it("固定 story_first 并保留用户明确填写的隔离父目录", () => {
    const result = validateManagedStudioCreateDraft({
      parentRoot: "  /Users/hxx/Documents/AI短剧工程  ",
      name: "  新剧素材中心  ",
      slug: "  season-three  ",
    });
    expect(MANAGED_STUDIO_CREATE_MODE).toBe("story_first");
    expect(result).toEqual({
      valid: true,
      message: expect.stringContaining("不会扫描"),
      input: {
        parentRoot: "/Users/hxx/Documents/AI短剧工程",
        name: "新剧素材中心",
        slug: "season-three",
      },
    });
  });

  it("在调用 bridge 前拒绝空路径、相对路径和空名称", () => {
    expect(validateManagedStudioCreateDraft({ parentRoot: "", name: "新剧" })).toMatchObject({ valid: false, message: expect.stringContaining("父目录") });
    expect(validateManagedStudioCreateDraft({ parentRoot: "projects", name: "新剧" })).toMatchObject({ valid: false, message: expect.stringContaining("绝对路径") });
    expect(validateManagedStudioCreateDraft({ parentRoot: "/tmp/projects", name: "" })).toMatchObject({ valid: false, message: expect.stringContaining("工程名称") });
  });
});

