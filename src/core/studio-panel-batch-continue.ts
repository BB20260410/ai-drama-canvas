/**
 * P1.10 分批续写宫格草稿（对照 ai-comic-factory predictNextPanels 分批）。
 */

export type PanelContinueBatch = {
  batchIndex: number;
  fromOrdinal: number;
  toOrdinal: number;
  ordinals: number[];
};

/**
 * 将 totalPanels（2–6）按 batchSize 切批，用于多轮 LLM 续写。
 */
export function planPanelContinueBatches(
  totalPanels: number,
  batchSize = 2,
): PanelContinueBatch[] {
  if (!Number.isInteger(totalPanels) || totalPanels < 2 || totalPanels > 6) {
    throw new Error("batch-continue: totalPanels 须为 2–6。");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 6) {
    throw new Error("batch-continue: batchSize 须为 1–6。");
  }
  const batches: PanelContinueBatch[] = [];
  let start = 1;
  let batchIndex = 0;
  while (start <= totalPanels) {
    const end = Math.min(totalPanels, start + batchSize - 1);
    const ordinals: number[] = [];
    for (let o = start; o <= end; o++) ordinals.push(o);
    batches.push({
      batchIndex,
      fromOrdinal: start,
      toOrdinal: end,
      ordinals,
    });
    batchIndex += 1;
    start = end + 1;
  }
  return batches;
}
