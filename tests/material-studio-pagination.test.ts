import { describe, expect, it } from "vitest";
import {
  MATERIAL_STUDIO_PAGE_LIMIT,
  boundedMaterialStudioEntries,
  commitMaterialStudioFirstPage,
  commitMaterialStudioNextPage,
  commitMaterialStudioPreviousPage,
  createMaterialStudioCursorState,
  materialStudioPreviousCursor,
} from "../src/renderer/src/material-studio-pagination.js";

describe("素材中心有界游标分页", () => {
  it("每次只保留当前页且最多 36 个唯一 DOM 条目", () => {
    const items = Array.from({ length: 80 }, (_, index) => ({ id: `entry-${String(index).padStart(3, "0")}` }));
    items.splice(20, 0, { id: "entry-019" });
    const page = boundedMaterialStudioEntries(items);
    expect(MATERIAL_STUDIO_PAGE_LIMIT).toBe(36);
    expect(page).toHaveLength(36);
    expect(new Set(page.map((entry) => entry.id)).size).toBe(36);
    expect(page.at(-1)?.id).toBe("entry-035");
  });

  it("下一页替换时记录历史，上一页恢复后不会累加旧页", () => {
    const state = createMaterialStudioCursorState();
    commitMaterialStudioFirstPage(state, "cursor-page-2");
    commitMaterialStudioNextPage(state, "cursor-page-2", "cursor-page-3");
    expect(state).toEqual({ currentCursor: "cursor-page-2", previousCursors: [undefined], nextCursor: "cursor-page-3" });
    commitMaterialStudioNextPage(state, "cursor-page-3", undefined);
    expect(materialStudioPreviousCursor(state)).toBe("cursor-page-2");
    commitMaterialStudioPreviousPage(state, "cursor-page-2", "cursor-page-3");
    expect(state).toEqual({ currentCursor: "cursor-page-2", previousCursors: [undefined], nextCursor: "cursor-page-3" });
    commitMaterialStudioPreviousPage(state, undefined, "cursor-page-2");
    expect(state).toEqual({ currentCursor: undefined, previousCursors: [], nextCursor: "cursor-page-2" });
  });

  it("拒绝提交异步返回的过期游标页", () => {
    const state = createMaterialStudioCursorState();
    commitMaterialStudioFirstPage(state, "cursor-current");
    expect(() => commitMaterialStudioNextPage(state, "cursor-stale", undefined)).toThrow("游标已漂移");
    expect(() => commitMaterialStudioPreviousPage(state, undefined, undefined)).toThrow("分页历史已漂移");
  });
});

