/**
 * 总资源中心分类页签的纯键盘导航规则。
 * ArrowLeft/ArrowRight 循环移动，Home/End 跳到首/末；其余按键返回 null 表示不处理。
 */
export function moveGlobalResourceTabIndex(
  current: number,
  count: number,
  key: string,
): number | null {
  if (count <= 0 || current < 0 || current >= count) return null;
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
