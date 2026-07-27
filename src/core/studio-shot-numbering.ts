/**
 * 镜号插序（对照 Shotbuddy：10/20/30 步进，中间插 _15 式半步）。
 * 纯函数，不写盘。
 */

/**
 * 在 before 与 after 之间插入镜号。
 * - 两者皆有且 after > before+1 → 取中点向下取整（至少 before+1）
 * - 仅 before → before + step
 * - 仅 after → max(step, after - step) 且 < after
 * - 皆无 → step
 */
export function intercalateShotNumber(
  before: number | null | undefined,
  after: number | null | undefined,
  step = 10,
): number {
  if (!Number.isInteger(step) || step < 1) {
    throw new Error("shot-number: step 必须为正整数。");
  }
  const hasBefore = before !== null && before !== undefined;
  const hasAfter = after !== null && after !== undefined;
  if (hasBefore && (!Number.isFinite(before) || !Number.isInteger(before!))) {
    throw new Error("shot-number: before 必须是整数。");
  }
  if (hasAfter && (!Number.isFinite(after) || !Number.isInteger(after!))) {
    throw new Error("shot-number: after 必须是整数。");
  }
  if (hasBefore && hasAfter) {
    if (after! <= before!) {
      throw new Error(`shot-number: after(${after}) 必须大于 before(${before})。`);
    }
    if (after! === before! + 1) {
      throw new Error("shot-number: before 与 after 相邻，无插入空隙。");
    }
    const mid = Math.floor((before! + after!) / 2);
    if (mid <= before! || mid >= after!) {
      throw new Error("shot-number: 无法在区间内插入整数镜号。");
    }
    return mid;
  }
  if (hasBefore) return before! + step;
  if (hasAfter) {
    const candidate = after! - step;
    if (candidate >= 1 && candidate < after!) return candidate;
    if (after! > 1) return after! - 1;
    throw new Error("shot-number: after 过小，无法前置插入。");
  }
  return step;
}

/** 在已有镜号列表末尾追加下一个步进号（默认 10,20,30…） */
export function nextShotNumber(existing: number[], step = 10): number {
  if (!Number.isInteger(step) || step < 1) throw new Error("shot-number: step 必须为正整数。");
  const nums = existing.filter((n) => Number.isInteger(n) && n > 0);
  if (nums.length === 0) return step;
  const max = Math.max(...nums);
  return max + step;
}

/** 校验镜号列表无重复、全为正整数 */
export function assertShotNumbersValid(numbers: number[]): void {
  const seen = new Set<number>();
  for (const n of numbers) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`shot-number: 非法镜号 ${n}`);
    if (seen.has(n)) throw new Error(`shot-number: 重复镜号 ${n}`);
    seen.add(n);
  }
}
