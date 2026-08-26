/**
 * 跨单元场景回指纯函数：对照已加载板与 Agent 只读投影共用。
 * 不是 BindingSet，不能当 generation-ready。本文件不打开生产库。
 */

export const SCENE_BACK_REFERENCE_LIMIT = 4;

export type SceneBackReference = {
  assetId: string;
  role: string;
  unitId: string;
  sequence: number;
  panelIndex: number;
  panelId: string;
};

export function formatSceneBackReferences(
  sceneMentionCount: number,
  rows: ReadonlyArray<SceneBackReference>,
): string {
  if (sceneMentionCount <= 0) {
    return "本格快照未提及场景。不是 BindingSet，不能当 generation-ready。";
  }
  if (!rows.length) {
    return "场景回指：本集更早单元没有同场景快照提及。不是 BindingSet，不能当 generation-ready。";
  }
  const text = rows
    .map((row) => `U${row.sequence} G${row.panelIndex} ${row.role || row.assetId}`)
    .join("；");
  return `场景回指：${text}。快照提及，不是 BindingSet，不能当 generation-ready。`;
}

export const PROP_BACK_REFERENCE_LIMIT = SCENE_BACK_REFERENCE_LIMIT;

export type PropBackReference = SceneBackReference;

export function formatPropBackReferences(
  propMentionCount: number,
  rows: ReadonlyArray<PropBackReference>,
): string {
  if (propMentionCount <= 0) {
    return "本格快照未提及道具。不是 BindingSet，不能当 generation-ready。";
  }
  if (!rows.length) {
    return "道具回指：本集更早单元没有同道具快照提及。不是 BindingSet，不能当 generation-ready。";
  }
  const text = rows
    .map((row) => `U${row.sequence} G${row.panelIndex} ${row.role || row.assetId}`)
    .join("；");
  return `道具回指：${text}。快照提及，不是 BindingSet，不能当 generation-ready。`;
}
