/**
 * 素材库分页 — 委托 Qwen D1 统一游标（保持旧导出名兼容）。
 */
import {
  boundedCursorPageItems,
  commitCursorFirstPage,
  commitCursorNextPage,
  commitCursorPreviousPage,
  createCursorPaginationState,
  DEFAULT_CURSOR_PAGE_LIMIT,
  peekCursorNext,
  peekCursorPrevious,
  resetCursorPaginationState,
  type CursorPaginationState,
} from "./use-cursor-pagination.js";

export const MATERIAL_STUDIO_PAGE_LIMIT = DEFAULT_CURSOR_PAGE_LIMIT;

export type MaterialStudioCursorState = CursorPaginationState;

export function createMaterialStudioCursorState(): MaterialStudioCursorState {
  return createCursorPaginationState();
}

export function resetMaterialStudioCursorState(state: MaterialStudioCursorState): void {
  resetCursorPaginationState(state);
}

export function commitMaterialStudioFirstPage(
  state: MaterialStudioCursorState,
  nextCursor?: string,
): void {
  commitCursorFirstPage(state, nextCursor);
}

export function materialStudioNextCursor(state: MaterialStudioCursorState): string | undefined {
  return peekCursorNext(state);
}

export function materialStudioPreviousCursor(state: MaterialStudioCursorState): string | undefined {
  return peekCursorPrevious(state);
}

export function commitMaterialStudioNextPage(
  state: MaterialStudioCursorState,
  requestedCursor: string,
  nextCursor?: string,
): void {
  commitCursorNextPage(state, requestedCursor, nextCursor, "素材分页游标已漂移，拒绝提交过期下一页。");
}

export function commitMaterialStudioPreviousPage(
  state: MaterialStudioCursorState,
  requestedCursor: string | undefined,
  nextCursor?: string,
): void {
  commitCursorPreviousPage(state, requestedCursor, nextCursor, "素材分页历史已漂移，拒绝提交过期上一页。");
}

export function boundedMaterialStudioEntries<T extends { id: string }>(items: readonly T[]): T[] {
  return boundedCursorPageItems(items, MATERIAL_STUDIO_PAGE_LIMIT);
}
