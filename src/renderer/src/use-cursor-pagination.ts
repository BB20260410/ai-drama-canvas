/**
 * Qwen D1 · 统一 keyset 游标分页（只读状态机）
 *
 * 合并素材库 / 绑定工作台 / 画布侧栏三套同构游标语义：
 * - next 必须消费当前 nextCursor（防漂移）
 * - prev 必须消费 previousCursors 栈顶
 * - first page 重置历史
 *
 * 不持有 nextAction / 业务真相；不写账本。
 */

export const DEFAULT_CURSOR_PAGE_LIMIT = 36 as const;

export interface CursorPaginationState {
  currentCursor?: string;
  previousCursors: Array<string | undefined>;
  nextCursor?: string;
}

export function createCursorPaginationState(): CursorPaginationState {
  return { previousCursors: [] };
}

export function resetCursorPaginationState(state: CursorPaginationState): void {
  state.currentCursor = undefined;
  state.previousCursors = [];
  state.nextCursor = undefined;
}

export function commitCursorFirstPage(state: CursorPaginationState, nextCursor?: string): void {
  resetCursorPaginationState(state);
  state.nextCursor = nextCursor;
}

export function peekCursorNext(state: CursorPaginationState): string | undefined {
  return state.nextCursor;
}

export function peekCursorPrevious(state: CursorPaginationState): string | undefined {
  return state.previousCursors.at(-1);
}

export function commitCursorNextPage(
  state: CursorPaginationState,
  requestedCursor: string,
  nextCursor?: string,
  driftMessage = "分页游标已漂移，拒绝提交过期下一页。",
): void {
  if (state.nextCursor !== requestedCursor) throw new Error(driftMessage);
  state.previousCursors.push(state.currentCursor);
  state.currentCursor = requestedCursor;
  state.nextCursor = nextCursor;
}

export function commitCursorPreviousPage(
  state: CursorPaginationState,
  requestedCursor: string | undefined,
  nextCursor?: string,
  driftMessage = "分页历史已漂移，拒绝提交过期上一页。",
): void {
  if (!state.previousCursors.length || state.previousCursors.at(-1) !== requestedCursor) {
    throw new Error(driftMessage);
  }
  state.previousCursors.pop();
  state.currentCursor = requestedCursor;
  state.nextCursor = nextCursor;
}

export function boundedCursorPageItems<T extends { id: string }>(
  items: readonly T[],
  limit: number = DEFAULT_CURSOR_PAGE_LIMIT,
): T[] {
  return [...new Map(items.map((item) => [item.id, item] as const)).values()].slice(0, limit);
}
