/**
 * 显式绑定决策表：禁止 candidates[0] 静默选取。
 * 仅当 entityText 决策表命中且该资产在候选集内时才 select/accept。
 */
export type ExplicitBindingDecision =
  | { kind: "accept"; selectedAssetId: string; role: string; note: string }
  | { kind: "select"; selectedAssetId: string; role: string; note: string }
  | { kind: "exclude"; role: string; note: string }
  | { kind: "blocked"; reason: string };

export interface ExplicitBindingProposalInput {
  entityText: string;
  status: "matched" | "ambiguous" | "unmatched" | "excluded";
  matchedAssetId?: string;
  candidates: Array<{ assetId: string; assetName?: string }>;
  presence?: "required" | "optional" | "forbidden";
  role?: string;
}

/** 第一季已导入规范资产的显式实体 → assetId 映射（含硬锁别名）。 */
export const S1_EXPLICIT_ENTITY_ASSET_MAP: Record<string, string> = {
  成年阿航: "character-r01-adult-ahang",
  阿航: "character-r01-adult-ahang",
  青年阿航: "character-r01-adult-ahang",
  小阿航: "character-r05-child-ahang",
  童年阿航: "character-r05-child-ahang",
  成年阿依: "character-r02-adult-ayi",
  阿依: "character-r02-adult-ayi",
  小阿依: "character-r06-child-ayi",
  嘟嘟: "character-r07-dudu",
  r07: "character-r07-dudu",
  五维度生物: "character-a01-energy",
  五维度能量体: "character-a01-energy",
  a01: "character-a01-energy",
  无面具能量体: "character-a01-energy",
  高维能量: "character-a01-energy",
  现代女考古者: "character-modern-archaeologist",
  成年姜绿: "character-adult-jianglv",
  姜绿: "character-adult-jianglv",
  小姜绿: "character-child-jianglv",
  阿爷: "character-aye",
  阿依娘: "character-ayi-niang",
  穗氏: "character-ayi-niang",
  王卿: "character-wangqing",
  权臣王卿: "character-wangqing",
  蜀王: "character-shuwang",
  巫祝: "character-wuzhu-female",
  女性巫祝: "character-wuzhu-female",
  杜宇: "character-duyu",
  货郎: "character-huolang",
  货郎细作: "character-huolang",
  掌礼老祭司: "character-zhangli",
  丽妃: "character-lifei",
  火把信使: "character-huoba-messenger",
  川氏弓手: "character-chuan-archer",
  黑衣私兵: "character-heiyi-soldiers",
  羌兵: "character-qiang-soldiers",
  王城戈卫: "character-wangcheng-guards",
  强盗: "character-bandits",
  流寇: "character-liukou",
  村民: "character-villagers",
  封豨: "character-fengxi",
  蜚疫兽: "character-feiyi",
  毕方: "character-bifang",
  巴蛇: "character-bashe",
  饕餮: "character-taotie-sky",
  玄鸦: "character-xuanya",
  西宫近臣: "character-xigong-jinchen",
  毒酒使: "character-xigong-jinchen",
  完整黄金面具: "prop-d01-golden-mask",
  黄金面具: "prop-d01-golden-mask",
  金面: "prop-d01-golden-mask",
  豆姐: "prop-d01-golden-mask",
  d01: "prop-d01-golden-mask",
  r03: "prop-d01-golden-mask",
  布符: "prop-cloth-talisman",
  太阳鸟羽毛: "prop-sunbird-feather",
  竹简布袋: "prop-bamboo-bag",
  金鸟配饰: "prop-gold-bird-ornament",
  青铜召集令: "prop-bronze-summons",
  角弓: "prop-horn-bow",
  青灰圆石: "prop-grey-stone",
  天外遗物: "prop-sky-stele",
  普通青铜面具: "prop-bronze-mask",
  蜀王左手铜套: "prop-king-bronze-sleeve",
  青铜神树: "prop-bronze-tree",
  九只太阳鸟: "prop-nine-sunbirds",
  阿爷木叉: "prop-aye-fork",
  货郎挑担: "prop-peddler-chest",
  太阳鸟旌旗: "prop-sunbird-banner-cart",
  青铜短刀: "prop-bronze-blades",
  青铜祭铃: "prop-ritual-bell",
  持璋: "prop-zhang-ritual",
};

export function normalizeEntityLookupKey(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000·・.。,，、:：;；"'“”‘’()（）\[\]【】<>《》]/g, "");
}

/**
 * T6 回归词表：这些常见中文词包含短名字符但不应触发实体匹配。
 * 例如“素材”含“素”但不应绑定角色“素”。
 */
const SHORT_NAME_STOP_WORDS: ReadonlySet<string> = new Set([
  "素材", "素描", "因素", "素质", "素来", "素色", "素雅", "素净",
  "嘟嘟", "嘟囔", "嘟嘴",
  "阿爷", "阿娘", "阿妈", "阿爸",
]);

/** 短名最小长度：低于此长度的别名禁止子串匹配，仅允许精确命中。 */
const MIN_SUBSTRING_ALIAS_LENGTH = 2;

export function lookupExplicitAssetId(entityText: string): string | undefined {
  const key = normalizeEntityLookupKey(entityText);
  if (!key) return undefined;
  // 精确命中优先级最高
  if (S1_EXPLICIT_ENTITY_ASSET_MAP[key]) return S1_EXPLICIT_ENTITY_ASSET_MAP[key];
  // 回归词表拦截：常见词包含短名字符但不应触发实体绑定
  if (SHORT_NAME_STOP_WORDS.has(key)) return undefined;
  // 子串最长匹配（避免静默首候选）
  let best: { id: string; len: number } | undefined;
  for (const [alias, assetId] of Object.entries(S1_EXPLICIT_ENTITY_ASSET_MAP)) {
    const aliasKey = normalizeEntityLookupKey(alias);
    if (!aliasKey) continue;
    // 短名保护：别名长度 < MIN_SUBSTRING_ALIAS_LENGTH 时禁止子串匹配，仅精确命中
    if (aliasKey.length < MIN_SUBSTRING_ALIAS_LENGTH && aliasKey !== key) continue;
    if (key.includes(aliasKey) || aliasKey.includes(key)) {
      if (!best || aliasKey.length > best.len) best = { id: assetId, len: aliasKey.length };
    }
  }
  return best?.id;
}

/**
 * 对单条 proposal 给出显式决策；禁止在无映射时取 candidates[0]。
 */
export function planExplicitBindingDecision(
  input: ExplicitBindingProposalInput,
): ExplicitBindingDecision {
  const role = (input.role?.trim() || "剧本实体").slice(0, 200);
  const presenceNote = input.presence ?? "required";

  if (input.status === "excluded") {
    return { kind: "exclude", role, note: "提案已排除。" };
  }

  if (input.status === "matched") {
    const matched = input.matchedAssetId?.trim();
    if (!matched) {
      return { kind: "blocked", reason: "matched 状态缺少 matchedAssetId。" };
    }
    const mapped = lookupExplicitAssetId(input.entityText);
    // 硬锁覆盖：若决策表与唯一匹配冲突，以决策表为准且必须在候选中
    if (mapped && mapped !== matched) {
      if (input.candidates.some((c) => c.assetId === mapped)) {
        return {
          kind: "select",
          selectedAssetId: mapped,
          role,
          note: `显式决策表覆盖唯一匹配：${input.entityText} → ${mapped}（拒绝静默/错误匹配）。presence=${presenceNote}`,
        };
      }
      return {
        kind: "blocked",
        reason: `匹配 ${matched} 与决策表 ${mapped} 冲突且决策表资产不在候选中。`,
      };
    }
    return {
      kind: "accept",
      selectedAssetId: matched,
      role,
      note: `显式接受唯一匹配：${input.entityText} → ${matched}`,
    };
  }

  const mapped = lookupExplicitAssetId(input.entityText);
  if (mapped && input.candidates.some((c) => c.assetId === mapped)) {
    return {
      kind: "select",
      selectedAssetId: mapped,
      role,
      note: `显式选择决策表资产（非 candidates[0]）：${input.entityText} → ${mapped}`,
    };
  }

  if (input.candidates.length === 0) {
    return {
      kind: "exclude",
      role,
      note: `无规范资产候选，显式排除文本实体「${input.entityText}」（不静默造绑）。`,
    };
  }

  // 歧义且决策表未命中任一候选 → 禁止取第一个
  return {
    kind: "blocked",
    reason: `歧义/未匹配且决策表未命中候选：entity=${input.entityText} candidates=${input.candidates.map((c) => c.assetId).join(",")}`,
  };
}
