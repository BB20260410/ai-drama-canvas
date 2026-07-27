import { describe, expect, it } from "vitest";
import {
  boundedCursorPageItems,
  commitCursorFirstPage,
  commitCursorNextPage,
  commitCursorPreviousPage,
  createCursorPaginationState,
  peekCursorNext,
  peekCursorPrevious,
} from "../src/renderer/src/use-cursor-pagination.js";
import {
  commitMaterialStudioNextPage,
  createMaterialStudioCursorState,
} from "../src/renderer/src/material-studio-pagination.js";
import {
  commitStudioBindingNextPage,
  createStudioBindingCursorState,
} from "../src/renderer/src/studio-binding-pagination.js";

describe("use-cursor-pagination (Qwen D1)", () => {
  it("first/next/prev with drift protection", () => {
    const s = createCursorPaginationState();
    commitCursorFirstPage(s, "c1");
    expect(peekCursorNext(s)).toBe("c1");
    commitCursorNextPage(s, "c1", "c2");
    expect(s.currentCursor).toBe("c1");
    expect(peekCursorPrevious(s)).toBeUndefined();
    commitCursorNextPage(s, "c2", "c3");
    expect(peekCursorPrevious(s)).toBe("c1");
    commitCursorPreviousPage(s, "c1", "c2");
    expect(s.currentCursor).toBe("c1");
    expect(() => commitCursorNextPage(s, "wrong", "x")).toThrow(/漂移/);
  });

  it("material + binding facades share semantics", () => {
    const m = createMaterialStudioCursorState();
    const b = createStudioBindingCursorState();
    commitCursorFirstPage(m, "a");
    commitCursorFirstPage(b, "a");
    commitMaterialStudioNextPage(m, "a", "b");
    commitStudioBindingNextPage(b, "a", "b");
    expect(m.currentCursor).toBe(b.currentCursor);
    expect(m.nextCursor).toBe(b.nextCursor);
  });

  it("boundedCursorPageItems dedupes by id", () => {
    expect(boundedCursorPageItems([{ id: "1" }, { id: "1" }, { id: "2" }], 10)).toEqual([
      { id: "1" },
      { id: "2" },
    ]);
  });
});
