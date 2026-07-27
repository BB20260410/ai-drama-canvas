/**
 * 宫格整板几何切分（clean-room）。
 * 行为对照火宝 grid-split：均匀 NxM 切块；不读写 CAS，只产出矩形与索引。
 * 真正落盘裁切由调用方（Sharp/本地）完成，候选路径仍须走 quarantine 门禁。
 */

export type StudioGridSplitCell = {
  /** 行优先索引：r * cols + c */
  index: number;
  row: number;
  col: number;
  /** 像素矩形，左上原点 */
  left: number;
  top: number;
  width: number;
  height: number;
};

export type StudioGridSplitPlan = {
  imageWidth: number;
  imageHeight: number;
  rows: number;
  cols: number;
  cells: StudioGridSplitCell[];
};

export type StudioGridSplitInput = {
  imageWidth: number;
  imageHeight: number;
  rows: number;
  cols: number;
};

/**
 * 计算均匀宫格切分矩形。
 * - rows/cols 必须为 1..12 的整数
 * - 宽高必须为正整数
 * - 无法整除时向下取整 cell 尺寸，右/下边缘可能留 0..cell-1 像素余量（不放大最后格，避免重叠）
 */
export function planStudioGridSplit(input: StudioGridSplitInput): StudioGridSplitPlan {
  const { imageWidth, imageHeight, rows, cols } = input;
  if (!Number.isInteger(imageWidth) || !Number.isInteger(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
    throw new Error("grid-split: imageWidth/imageHeight 必须为正整数。");
  }
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > 12 || cols > 12) {
    throw new Error("grid-split: rows/cols 必须为 1..12 的整数。");
  }

  const cellW = Math.floor(imageWidth / cols);
  const cellH = Math.floor(imageHeight / rows);
  if (cellW < 1 || cellH < 1) {
    throw new Error("grid-split: 切分后格子宽高不足 1px。");
  }

  const cells: StudioGridSplitCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const index = r * cols + c;
      cells.push({
        index,
        row: r,
        col: c,
        left: c * cellW,
        top: r * cellH,
        width: cellW,
        height: cellH,
      });
    }
  }

  return { imageWidth, imageHeight, rows, cols, cells };
}

/**
 * 将切分计划映射为「宫格序号 → 矩形」（1-based ordinal 对齐 2–6 宫格习惯）。
 * cellCount 默认 = rows*cols；若提供 panelOrdinals 则按序取前 N 格。
 */
export function mapGridSplitToPanelOrdinals(
  plan: StudioGridSplitPlan,
  panelOrdinals: number[],
): Array<{ ordinal: number; cell: StudioGridSplitCell }> {
  if (!panelOrdinals.length) throw new Error("grid-split: panelOrdinals 不能为空。");
  if (panelOrdinals.length > plan.cells.length) {
    throw new Error(`grid-split: 需要 ${panelOrdinals.length} 格，但切分只有 ${plan.cells.length} 块。`);
  }
  const seen = new Set<number>();
  return panelOrdinals.map((ordinal, i) => {
    if (!Number.isInteger(ordinal) || ordinal < 1) {
      throw new Error(`grid-split: 非法 ordinal ${ordinal}。`);
    }
    if (seen.has(ordinal)) throw new Error(`grid-split: 重复 ordinal ${ordinal}。`);
    seen.add(ordinal);
    return { ordinal, cell: plan.cells[i]! };
  });
}
