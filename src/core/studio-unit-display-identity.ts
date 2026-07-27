/**
 * T8 单元编号统一：双编号工具与搜索命中。
 *
 * 核心数据固定 unitId/unitIndex/displaySequence/displayLabel（`029｜S1E01-U28`）。
 * 所有页面统一双编号；搜索 029、U28、S1E01-U28 命中同一单元。
 * 禁止各模块重算编号——统一消费本模块的 formatUnitDisplayLabel / parseUnitSearchQuery。
 */

export interface UnitDisplayIdentity {
  unitId: string;
  /** 集内序号（1-based）。 */
  displaySequence: number;
  /** 双编号标签：`029｜S1E01-U28`。 */
  displayLabel: string;
  /** 短编号：`029`。 */
  sequenceLabel: string;
  /** 单元编号：`U28`（0-based 索引）。 */
  unitIndexLabel: string;
  /** 完整编号：`S1E01-U28`。 */
  fullLabel: string;
}

/**
 * 从 unitId + sequence + episode 构建统一双编号身份。
 * 所有模块必须使用此函数，禁止自行拼装编号。
 */
export function buildUnitDisplayIdentity(input: {
  unitId: string;
  /** 集内 1-based 序号。 */
  sequence: number;
  /** 季号，如 "S1"。 */
  season?: string;
  /** 集号，如 "S1E1" 或 "E01"。 */
  episode?: string;
}): UnitDisplayIdentity {
  const season = input.season ?? "S1";
  const episode = input.episode ?? "S1E1";
  const sequenceLabel = String(input.sequence).padStart(3, "0");
  // 单元索引为 0-based（U0 = 第一单元）
  const unitIndex = input.sequence - 1;
  const unitIndexLabel = `U${unitIndex}`;
  const fullLabel = `${episode}-${unitIndexLabel}`;
  const displayLabel = `${sequenceLabel}｜${fullLabel}`;
  return {
    unitId: input.unitId,
    displaySequence: input.sequence,
    displayLabel,
    sequenceLabel,
    unitIndexLabel,
    fullLabel,
  };
}

/**
 * 解析搜索查询，返回可能匹配的规范化形式。
 * 支持：029、U28、S1E01-U28、完整 unitId。
 * 搜索时只要命中任一形式即匹配同一单元。
 */
export function matchesUnitSearchQuery(
  identity: UnitDisplayIdentity,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  // 精确匹配 unitId
  if (identity.unitId.toLowerCase() === q) return true;
  // 匹配序号标签 "029"
  if (identity.sequenceLabel === q) return true;
  // 匹配单元索引 "u28"
  if (identity.unitIndexLabel.toLowerCase() === q) return true;
  // 匹配完整编号 "s1e01-u28"
  if (identity.fullLabel.toLowerCase() === q) return true;
  // 匹配双编号标签 "029｜s1e01-u28"
  if (identity.displayLabel.toLowerCase() === q) return true;
  // 模糊：unitId 包含查询
  if (identity.unitId.toLowerCase().includes(q)) return true;
  return false;
}
