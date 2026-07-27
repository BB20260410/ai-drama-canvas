/**
 * 将《小说第一季》硬锁白名单资产 + 541 套 15s 宫格单元
 * 导入受管工程 projects/codex-ai-drama-studio。
 *
 * 规则：
 * - 只导入 00_可直传资产白名单.json 内图片作为规范资产权威图
 * - 宫格 raw 作为媒体入库并按 EP/sequence 建生产单元（时间序）
 * - labeled 仅作 review-only 媒体，永不提升主权威
 * - 07 内化参考不导入为可直传权威
 * - 全部写入走 executeIdempotentCommand（CAS + 幂等）
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";
import {
  getStudioCanonicalAsset,
  listStudioCanonicalAssets,
  listStudioMedia,
} from "../src/core/material-studio.js";
import { listStudioProductionUnits } from "../src/core/studio-production.js";

const PACKAGE_ROOT =
  "/Users/hxx/Documents/小说第一季/第一季_视觉资产锁定与15秒宫格故事版_20260718";
const PROJECT_ROOT =
  "/Users/hxx/Documents/无限画布/projects/codex-ai-drama-studio";
const IMPORT_TAG = "s1-huangjin-import-v1";
const PROGRESS_PATH = path.join(
  PROJECT_ROOT,
  ".aicanvas",
  "s1-import-progress.json",
);

type WhitelistAsset = {
  category: string;
  relative_path: string;
  bytes: number;
  sha256: string;
};

type UnitRecord = {
  unit_id: string;
  episode_id: string;
  sequence_index: number;
  title: string;
  story_goal?: string;
  opening_state?: string;
  ending_state?: string;
  next_handoff?: string;
  schedule?: Array<{
    beat_id?: string;
    start_ms?: number;
    end_ms?: number;
    seconds?: number;
    shot_scale?: string;
    camera?: string;
    action?: string;
    dialogue_plan?: string;
    audio?: string;
  }>;
  reference_image_paths?: Array<{
    path: string;
    source_asset_id?: string;
    role?: string;
    direct_upload_allowed?: boolean;
  }>;
  seedance_prompt?: string;
  negative_constraints?: string[] | string;
};

type Progress = {
  mediaShaByRel: Record<string, string>;
  assetIds: Record<string, string>;
  pathToAssetId: Record<string, string>;
  unitIds: string[];
  errors: Array<{ step: string; message: string }>;
  phase: string;
  updatedAt: string;
};

function shaKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function loadProgress(): Promise<Progress> {
  if (await exists(PROGRESS_PATH)) {
    return JSON.parse(await readFile(PROGRESS_PATH, "utf8")) as Progress;
  }
  return {
    mediaShaByRel: {},
    assetIds: {},
    pathToAssetId: {},
    unitIds: [],
    errors: [],
    phase: "init",
    updatedAt: new Date().toISOString(),
  };
}

async function saveProgress(p: Progress): Promise<void> {
  p.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(PROGRESS_PATH), { recursive: true });
  await writeFile(PROGRESS_PATH, JSON.stringify(p, null, 2), "utf8");
}

async function exec(
  step: string,
  command: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const requestId = `${IMPORT_TAG}:${step}`;
  const idempotencyKey = `${IMPORT_TAG}:${step}`;
  const result = await executeIdempotentCommand(PROJECT_ROOT, {
    requestId,
    idempotencyKey,
    request: { command, payload } as any,
  });
  if (result.status !== "succeeded") {
    throw new Error(
      `${command} failed (${result.status}): ${result.error?.message ?? "unknown"} [${step}]`,
    );
  }
  return result.result;
}

function entityKeyFromCharacterPath(rel: string): { id: string; name: string } {
  const base = path.basename(rel);
  const m = base.match(/^(\d{2})_([^_]+)/);
  if (!m) return { id: `character-${shaKey([base])}`, name: base };
  const code = m[1]!;
  const namePart = m[2]!;
  const map: Record<string, { id: string; name: string }> = {
    "00": { id: "character-r01-adult-ahang", name: "成年阿航" },
    "01": { id: "character-r05-child-ahang", name: "小阿航" },
    "02": { id: "character-r02-adult-ayi", name: "成年阿依" },
    "03": { id: "character-r06-child-ayi", name: "小阿依" },
    "04": { id: "character-r07-dudu", name: "嘟嘟" },
    "05": { id: "character-a01-energy", name: "五维度生物A01" },
    "06": { id: "character-modern-archaeologist", name: "现代女考古者" },
    "07": { id: "character-adult-jianglv", name: "成年姜绿" },
    "08": { id: "character-child-jianglv", name: "小姜绿" },
    "09": { id: "character-aye", name: "阿爷" },
    "10": { id: "character-ayi-niang", name: "阿依娘穗氏" },
    "11": { id: "character-wangqing", name: "王卿" },
    "12": { id: "character-shuwang", name: "蜀王" },
    "13": { id: "character-wuzhu-female", name: "巫祝" },
    "14": { id: "character-duyu", name: "杜宇" },
    "15": { id: "character-huolang", name: "货郎细作" },
    "16": { id: "character-zhangli", name: "掌礼老祭司" },
    "17": { id: "character-lifei", name: "丽妃" },
    "18": { id: "character-huoba-messenger", name: "火把信使" },
    "19": { id: "character-chuan-archer", name: "川氏弓手" },
    "20": { id: "character-heiyi-soldiers", name: "黑衣私兵群像" },
    "21": { id: "character-qiang-soldiers", name: "羌兵群像" },
    "22": { id: "character-wangcheng-guards", name: "王城戈卫弓手" },
    "23": { id: "character-bandits", name: "强盗袭村土匪群像" },
    "24": { id: "character-liukou", name: "流寇" },
    "25": { id: "character-villagers", name: "古蜀村民群像" },
    "26": { id: "character-fengxi", name: "封豨" },
    "27": { id: "character-feiyi", name: "蜚疫兽" },
    "28": { id: "character-bifang", name: "毕方火鸟" },
    "29": { id: "character-bashe", name: "巴蛇" },
    "30": { id: "character-taotie-sky", name: "饕餮天空巨口" },
    "31": { id: "character-xuanya", name: "玄鸦" },
    "32": { id: "character-xigong-jinchen", name: "西宫近臣" },
  };
  return map[code] ?? { id: `character-${code}-${namePart}`, name: namePart };
}

function entityKeyFromPropPath(rel: string): { id: string; name: string } {
  const base = path.basename(rel);
  const m = base.match(/^(\d{2})_([^_]+(?:_[^_]+)*)/);
  const code = m?.[1] ?? "xx";
  const rest = base.replace(/\.png$/i, "").replace(/^\d{2}_/, "");
  const name = rest.split("_")[0] + (rest.includes("_") ? rest.split("_").slice(1, 3).join("") : "");
  const map: Record<string, { id: string; name: string }> = {
    "00": { id: "prop-d01-golden-mask", name: "完整黄金面具D01" },
    "01": { id: "prop-cloth-talisman", name: "布符眼形纹麻布" },
    "02": { id: "prop-sunbird-feather", name: "太阳鸟羽毛与羽冠" },
    "03": { id: "prop-bamboo-bag", name: "竹简布袋" },
    "04": { id: "prop-gold-bird-ornament", name: "金鸟配饰" },
    "05": { id: "prop-bronze-summons", name: "青铜召集令与帛书" },
    "06": { id: "prop-horn-bow", name: "角弓与箭" },
    "07": { id: "prop-grey-stone", name: "青灰圆石" },
    "08": { id: "prop-sky-stele", name: "天外遗物金属碑" },
    "09": { id: "prop-bronze-mask", name: "普通青铜面具" },
    "10": { id: "prop-king-bronze-sleeve", name: "蜀王左手铜套" },
    "11": { id: "prop-bronze-tree", name: "青铜神树大型装置" },
    "12": { id: "prop-nine-sunbirds", name: "九只太阳鸟青铜神鸟" },
    "13": { id: "prop-aye-fork", name: "阿爷木叉" },
    "14": { id: "prop-peddler-chest", name: "货郎挑担木箱" },
    "15": { id: "prop-sunbird-banner-cart", name: "木车太阳鸟旌旗" },
    "16": { id: "prop-bronze-blades", name: "古蜀青铜短刀与断刀" },
    "17": { id: "prop-ritual-bell", name: "青铜祭铃" },
    "18": { id: "prop-zhang-ritual", name: "圣女宫持璋祭礼器" },
  };
  return map[code] ?? { id: `prop-${code}`, name: name || base };
}

function entityKeyFromScenePath(rel: string): { id: string; name: string } {
  const base = path.basename(rel).replace(/\.png$/i, "");
  // strip trailing angle suffixes
  const cleaned = base
    .replace(/_720全景_00$/, "")
    .replace(/_720环境母图_00$/, "")
    .replace(/_仰视_00$/, "")
    .replace(/_俯视_00$/, "")
    .replace(/_复合板_01$/, "");
  const m = cleaned.match(/^(\d{2})_(.+)$/);
  const code = m?.[1] ?? shaKey([cleaned]).slice(0, 6);
  const name = m?.[2] ?? cleaned;
  return { id: `scene-${code}-${shaKey([name]).slice(0, 8)}`, name: name.replace(/_/g, "") };
}

function hardLocksForAsset(assetId: string, name: string): {
  positive: string[];
  negative: string[];
  identity: string[];
  aliases: string[];
  description: string;
} {
  const base = {
    positive: [`正式硬锁：${name}`, "古蜀真人电影写实", "仅使用白名单权威图"],
    negative: [
      "禁止卡通动漫插画塑料CG",
      "禁止现代穿帮（除明确现代戏）",
      "禁止用相似角色替代",
    ],
    identity: [name],
    aliases: [name],
    description: `第一季正式锁定资产：${name}。来源包 20260718 白名单硬锁。`,
  };
  if (assetId.includes("wangqing")) {
    return {
      ...base,
      aliases: ["王卿", "权臣王卿"],
      identity: ["中年权臣", "无刀疤脸"],
      positive: [...base.positive, "无刀疤人脸硬锁", "无刀疤中年三视图"],
      negative: [
        ...base.negative,
        "禁止刀疤脸",
        "禁用旧刀疤权臣图与刀疤正向描述",
      ],
      description: "王卿唯一正式身份：无刀疤。旧刀疤权臣资产禁用。",
    };
  }
  if (assetId.includes("wuzhu")) {
    return {
      ...base,
      aliases: ["巫祝", "女性巫祝"],
      identity: ["女性巫祝"],
      positive: [...base.positive, "女性巫祝人脸与全身三视图"],
      negative: [...base.negative, "禁止男性祭司形象", "禁用旧男性巫祝/老者祭司图"],
      description: "巫祝唯一正式身份：女性巫祝。",
    };
  }
  if (assetId.includes("dudu")) {
    return {
      ...base,
      aliases: ["嘟嘟", "R07"],
      identity: ["普通犬态"],
      positive: [...base.positive, "普通犬态R07"],
      negative: [
        ...base.negative,
        "禁止戴完整金面变身态R08",
        "金面若同框必须独立悬浮不附着犬身",
      ],
      description: "嘟嘟全季普通犬态；变身态禁用。",
    };
  }
  if (assetId.includes("a01")) {
    return {
      ...base,
      aliases: ["A01", "五维度生物", "五维度能量体"],
      identity: ["无面部", "无面具", "抽象高维能量"],
      positive: [...base.positive, "无面部无面具能量体三视图"],
      negative: [
        ...base.negative,
        "禁止人脸头部眼睛嘴肢体服装",
        "禁止面具附着/融合/佩戴",
        "完整黄金面具仅可作独立道具",
      ],
      description: "A01 无面部无面具抽象能量体。",
    };
  }
  if (assetId.includes("golden-mask") || assetId.includes("d01")) {
    return {
      ...base,
      aliases: ["D01", "豆姐", "完整黄金面具", "R03_NEUTRAL", "D00_COMPLETE_MASK"],
      identity: ["完整", "闭口", "刚性", "独立金属面具"],
      positive: [...base.positive, "干净完整闭口刚性金面"],
      negative: [
        ...base.negative,
        "禁止半面裂面开口表情眨眼随声震颤",
        "禁止与人体犬身能量体融合",
        "禁止带文字规格图",
        "台词仅后期画外",
      ],
      description: "D01/豆姐：完整闭口刚性独立黄金面具。",
    };
  }
  if (assetId.includes("xuanya")) {
    return {
      ...base,
      aliases: ["玄鸦"],
      identity: ["黑衣头目支线专用"],
      positive: [...base.positive, "仅用户指定黑衣头目支线"],
      negative: [...base.negative, "禁止替代第一季既有人物"],
      description: "玄鸦仅黑衣头目支线。",
    };
  }
  if (assetId.includes("xigong")) {
    return {
      ...base,
      aliases: ["西宫近臣", "毒酒使"],
      identity: ["剃顶", "低铜冠", "深墨礼袍"],
      positive: [...base.positive, "剃顶戴低铜冠", "EP04毒酒线"],
      negative: [...base.negative, "禁止写辫发", "禁止与王卿混写"],
      description: "西宫近臣毒酒使：剃顶低铜冠。",
    };
  }
  return base;
}

function pickPrimaryRel(rels: string[]): string {
  const rank = (r: string): number => {
    const b = path.basename(r);
    if (/人脸|脸部|R01|R02|R06|R07|干净硬锁|无刀疤人脸|女性巫祝人脸|8岁参考|主参考/.test(b)) return 0;
    if (/正面/.test(b)) return 1;
    if (/三视图/.test(b)) return 2;
    if (/720全景|720环境母图/.test(b)) return 0;
    return 5;
  };
  const primary = [...rels].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
  if (!primary) throw new Error("权威候选列表不能为空。");
  return primary;
}

function buildPanels(
  unit: UnitRecord,
  promptRevisionId: string,
  pathToAssetId: Record<string, string>,
): Array<Record<string, unknown>> {
  const schedule = unit.schedule ?? [];
  const panelCount = 6;
  const duration = 2.5;
  const whitelistRefs = (unit.reference_image_paths ?? []).filter(
    (r) => r.direct_upload_allowed && pathToAssetId[r.path],
  );

  // Map time ranges onto 6 equal panels
  const panels: Array<Record<string, unknown>> = [];
  for (let i = 0; i < panelCount; i++) {
    const start = i * duration;
    const end = start + duration;
    const midMs = (start + end) * 500;
    const beat =
      schedule.find(
        (s) =>
          (s.start_ms ?? 0) <= midMs && midMs < (s.end_ms ?? 15_000),
      ) ?? schedule[Math.min(i, Math.max(0, schedule.length - 1))];

    const assets = whitelistRefs.slice(0, 6).map((ref) => {
      const assetId = pathToAssetId[ref.path];
      if (!assetId) throw new Error(`白名单引用尚未绑定规范资产：${ref.path}`);
      const category = assetId.startsWith("scene-")
        ? "scene"
        : assetId.startsWith("prop-")
          ? "prop"
          : "character";
      return {
        assetId,
        category,
        presence: "required",
        role: ref.role ?? ref.source_asset_id ?? "锁定参考",
        continuityState: "继承硬锁权威图；本导入不改身份。",
        evidence: [
          {
            kind: "whitelist-hardlock",
            reference: ref.path,
            note: "00_可直传资产白名单",
          },
        ],
      };
    });

    panels.push({
      id: `panel-${String(i + 1).padStart(2, "0")}`,
      title: beat?.shot_scale
        ? `G${i + 1}-${beat.shot_scale}`
        : `G${i + 1}`,
      visualAction: beat?.action ?? unit.story_goal ?? unit.title,
      shotComposition: beat?.shot_scale
        ? `${beat.shot_scale}；16:9 电影构图`
        : "16:9 电影构图",
      filmingMethod: beat?.camera ?? "按单元视频提示词运镜",
      dialogue: beat?.dialogue_plan ?? "",
      subtitle: "",
      startSeconds: start,
      endSeconds: end,
      durationSeconds: duration,
      promptRevisionId,
      assets,
    });
  }
  return panels;
}

async function findUnitDir(episode: string, unitId: string, title: string): Promise<string | null> {
  const preferred = path.join(
    PACKAGE_ROOT,
    "04_15秒宫格故事版",
    episode,
    `${unitId}_${title}`,
  );
  if (await exists(preferred)) return preferred;
  const parent = path.join(PACKAGE_ROOT, "04_15秒宫格故事版", episode);
  if (!(await exists(parent))) return null;
  const entries = await readdir(parent);
  const hit = entries.find((e) => e.startsWith(`${unitId}_`));
  return hit ? path.join(parent, hit) : null;
}

async function main(): Promise<void> {
  const progress = await loadProgress();
  console.log(`[import] project=${PROJECT_ROOT}`);
  console.log(`[import] package=${PACKAGE_ROOT}`);
  console.log(`[import] resume phase=${progress.phase}`);

  const whitelist = JSON.parse(
    await readFile(path.join(PACKAGE_ROOT, "00_可直传资产白名单.json"), "utf8"),
  ) as { assets: WhitelistAsset[] };
  const units = JSON.parse(
    await readFile(
      path.join(PACKAGE_ROOT, "05_提示词与单元信息/15s_units.json"),
      "utf8",
    ),
  ) as UnitRecord[];
  units.sort((a, b) =>
    a.episode_id === b.episode_id
      ? a.sequence_index - b.sequence_index
      : a.episode_id.localeCompare(b.episode_id),
  );

  // ---------- 1) Import whitelist media ----------
  progress.phase = "import-whitelist-media";
  let mediaDone = 0;
  for (const asset of whitelist.assets) {
    const rel = asset.relative_path;
    if (progress.mediaShaByRel[rel]) {
      mediaDone++;
      continue;
    }
    const sourcePath = path.join(PACKAGE_ROOT, rel);
    if (!(await exists(sourcePath))) {
      progress.errors.push({ step: `media:${rel}`, message: "文件不存在" });
      continue;
    }
    try {
      const media = (await exec(`media:wl:${shaKey([rel])}`, "import_studio_media", {
        sourcePath,
        kind: "image",
        expectedSha256: asset.sha256,
      })) as { sha256: string };
      progress.mediaShaByRel[rel] = media.sha256;
      mediaDone++;
      if (mediaDone % 10 === 0) {
        console.log(`[media] ${mediaDone}/${whitelist.assets.length}`);
        await saveProgress(progress);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      progress.errors.push({ step: `media:${rel}`, message });
      console.error(`[media] FAIL ${rel}: ${message}`);
    }
  }
  await saveProgress(progress);
  console.log(`[media] whitelist done ${Object.keys(progress.mediaShaByRel).length}`);

  // ---------- 2) Group & create canonical assets ----------
  progress.phase = "create-assets";
  type Group = {
    id: string;
    name: string;
    category: "character" | "scene" | "prop";
    rels: string[];
  };
  const groups = new Map<string, Group>();

  for (const asset of whitelist.assets) {
    const rel = asset.relative_path;
    let meta: { id: string; name: string };
    let category: "character" | "scene" | "prop";
    if (asset.category.includes("人物")) {
      category = "character";
      meta = entityKeyFromCharacterPath(rel);
    } else if (asset.category.includes("场景")) {
      category = "scene";
      meta = entityKeyFromScenePath(rel);
    } else {
      category = "prop";
      meta = entityKeyFromPropPath(rel);
    }
    const g = groups.get(meta.id) ?? {
      id: meta.id,
      name: meta.name,
      category,
      rels: [],
    };
    g.rels.push(rel);
    groups.set(meta.id, g);
    progress.pathToAssetId[rel] = meta.id;
  }

  for (const group of groups.values()) {
    if (progress.assetIds[group.id]) continue;
    const locks = hardLocksForAsset(group.id, group.name);
    try {
      // create asset
      await exec(`asset:create:${group.id}`, "create_studio_asset", {
        id: group.id,
        category: group.category,
        name: group.name,
        description: locks.description,
        aliases: locks.aliases,
        identityFeatures: locks.identity,
        positiveLocks: locks.positive,
        negativeLocks: locks.negative,
        defaultPrompt: `${group.name}，严格匹配权威参考图，真人电影写实，古蜀历史奇幻。`,
        expectedRevision: 0,
      });

      const primaryRel = pickPrimaryRel(group.rels);
      const ordered = [
        primaryRel,
        ...group.rels.filter((r) => r !== primaryRel),
      ];
      let revision = 1;
      let primaryVersionId: string | undefined;

      for (const rel of ordered) {
        const sha = progress.mediaShaByRel[rel];
        if (!sha) continue;
        const appended = (await exec(
          `asset:ver:${group.id}:${sha.slice(0, 12)}`,
          "append_studio_asset_version",
          {
            assetId: group.id,
            mediaSha256: sha,
            reviewStatus: "pending",
            sourceNote: `S1白名单硬锁 ${rel}`,
            expectedRevision: revision,
          },
        )) as { version: { id: string }; assetRevision: number };
        revision = appended.assetRevision;
        const versionId = appended.version.id;
        if (rel === primaryRel) primaryVersionId = versionId;

        const reviewed = (await exec(
          `asset:rev:${group.id}:${versionId}`,
          "review_studio_asset_version",
          {
            assetId: group.id,
            versionId,
            decision: "approved",
            expectedRevision: revision,
            note: "第一季硬锁包验收通过；导入受管工程。",
          },
        )) as { revision: number };
        revision = reviewed.revision;
      }

      if (primaryVersionId) {
        const auth = (await exec(
          `asset:auth:${group.id}`,
          "set_studio_primary_authority",
          {
            assetId: group.id,
            versionId: primaryVersionId,
            expectedRevision: revision,
            note: "提升白名单主权威图。",
          },
        )) as { revision: number };
        revision = auth.revision;
      }

      progress.assetIds[group.id] = group.id;
      console.log(`[asset] ${group.category} ${group.id} versions=${ordered.length}`);
      await saveProgress(progress);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // resume if already exists
      if (/已存在|冲突|revision/.test(message)) {
        try {
          const existing = await getStudioCanonicalAsset(PROJECT_ROOT, group.id);
          if (existing) {
            progress.assetIds[group.id] = group.id;
            console.log(`[asset] resume existing ${group.id} rev=${existing.revision}`);
            continue;
          }
        } catch {
          /* ignore */
        }
      }
      progress.errors.push({ step: `asset:${group.id}`, message });
      console.error(`[asset] FAIL ${group.id}: ${message}`);
    }
  }
  await saveProgress(progress);

  // ---------- 3) Production units in chronological order ----------
  progress.phase = "create-units";
  const unitIdSet = new Set(progress.unitIds);
  let unitDone = unitIdSet.size;

  for (const unit of units) {
    const unitId = `unit-${unit.unit_id.toLowerCase()}`;
    if (unitIdSet.has(unitId)) continue;

    try {
      const unitDir = await findUnitDir(
        unit.episode_id,
        unit.unit_id,
        unit.title,
      );
      let infoBody = "";
      let promptBody = unit.seedance_prompt ?? unit.story_goal ?? unit.title;
      let rawPath: string | undefined;
      let labeledPath: string | undefined;

      if (unitDir) {
        const files = await readdir(unitDir);
        const infoFile = files.find((f) => f === "00_信息.md");
        const promptFile = files.find((f) => f.endsWith("_视频提示词.txt"));
        const rawFile = files.find((f) => f.endsWith("_raw.jpg"));
        const labeledFile = files.find((f) => f.endsWith("_labeled.jpg"));
        if (infoFile) {
          infoBody = await readFile(path.join(unitDir, infoFile), "utf8");
        }
        if (promptFile) {
          promptBody = await readFile(path.join(unitDir, promptFile), "utf8");
        }
        if (rawFile) rawPath = path.join(unitDir, rawFile);
        if (labeledFile) labeledPath = path.join(unitDir, labeledFile);
      }

      const scriptBody = [
        `# ${unit.unit_id}《${unit.title}》`,
        "",
        `剧情任务：${unit.story_goal ?? ""}`,
        `开场：${unit.opening_state ?? ""}`,
        `尾帧：${unit.ending_state ?? ""}`,
        `承接：${unit.next_handoff ?? ""}`,
        "",
        infoBody,
      ].join("\n");

      const scriptDocId = `script-${unit.unit_id.toLowerCase()}`;
      await exec(`script:doc:${unit.unit_id}`, "create_studio_script_document", {
        id: scriptDocId,
        title: `${unit.episode_id} ${unit.unit_id} ${unit.title}`,
        expectedRevision: 0,
      });
      const scriptRev = (await exec(
        `script:rev:${unit.unit_id}`,
        "append_studio_script_revision",
        {
          documentId: scriptDocId,
          expectedRevision: 0,
          body: scriptBody,
          source: "s1-package",
          sourceVersion: "20260718",
        },
      )) as { revision: { id: string } };

      const promptDocId = `prompt-${unit.unit_id.toLowerCase()}`;
      await exec(`prompt:doc:${unit.unit_id}`, "create_studio_prompt_document", {
        id: promptDocId,
        title: `${unit.unit_id} 视频提示词`,
        expectedRevision: 0,
      });
      const promptRev = (await exec(
        `prompt:rev:${unit.unit_id}`,
        "append_studio_prompt_revision",
        {
          documentId: promptDocId,
          expectedRevision: 0,
          body: promptBody,
          source: "s1-package",
          sourceVersion: "20260718",
        },
      )) as { revision: { id: string } };

      // import raw (composition board) + labeled (review-only)
      if (rawPath && (await exists(rawPath))) {
        try {
          const media = (await exec(
            `media:raw:${unit.unit_id}`,
            "import_studio_media",
            { sourcePath: rawPath, kind: "image" },
          )) as { sha256: string };
          progress.mediaShaByRel[`raw:${unit.unit_id}`] = media.sha256;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          progress.errors.push({ step: `raw:${unit.unit_id}`, message });
        }
      }
      if (labeledPath && (await exists(labeledPath))) {
        try {
          const media = (await exec(
            `media:labeled:${unit.unit_id}`,
            "import_studio_media",
            { sourcePath: labeledPath, kind: "image" },
          )) as { sha256: string };
          progress.mediaShaByRel[`labeled-review-only:${unit.unit_id}`] =
            media.sha256;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          progress.errors.push({ step: `labeled:${unit.unit_id}`, message });
        }
      }

      const panels = buildPanels(
        unit,
        promptRev.revision.id,
        progress.pathToAssetId,
      );

      await exec(`unit:create:${unit.unit_id}`, "create_studio_production_unit", {
        id: unitId,
        expectedRevision: 0,
        season: "S01",
        episode: unit.episode_id,
        sequence: unit.sequence_index,
        title: unit.title,
        scriptRevisionId: scriptRev.revision.id,
        panels,
      });

      unitIdSet.add(unitId);
      progress.unitIds.push(unitId);
      unitDone++;
      if (unitDone % 5 === 0 || unitDone === units.length) {
        console.log(`[unit] ${unitDone}/${units.length} last=${unit.unit_id}`);
        await saveProgress(progress);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/已存在|冲突/.test(message)) {
        unitIdSet.add(unitId);
        progress.unitIds.push(unitId);
        console.log(`[unit] resume existing ${unitId}`);
        continue;
      }
      progress.errors.push({ step: `unit:${unit.unit_id}`, message });
      console.error(`[unit] FAIL ${unit.unit_id}: ${message}`);
      await saveProgress(progress);
      // continue other units
    }
  }

  progress.phase = "done";
  await saveProgress(progress);

  const overview = await getStudioProductionDashboard(PROJECT_ROOT, {
    operation: "overview",
  });
  if (overview.operation !== "overview") throw new Error("dashboard overview 响应类型错误");
  const assets = await listStudioCanonicalAssets(PROJECT_ROOT, { limit: 5 });
  const media = await listStudioMedia(PROJECT_ROOT, { limit: 5 });
  const unitPage = await listStudioProductionUnits(PROJECT_ROOT, { limit: 5 });

  const summary = {
    overview,
    assetSampleCount: assets.items.length,
    mediaSampleCount: media.items.length,
    unitSampleCount: unitPage.items.length,
    progressAssetCount: Object.keys(progress.assetIds).length,
    progressMediaCount: Object.keys(progress.mediaShaByRel).length,
    progressUnitCount: progress.unitIds.length,
    errorCount: progress.errors.length,
    errorsHead: progress.errors.slice(0, 20),
  };
  const summaryPath = path.join(
    PROJECT_ROOT,
    ".aicanvas",
    "s1-import-summary.json",
  );
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log("[import] DONE");
  console.log(JSON.stringify({
    counts: overview.counts,
    nextAction: overview.nextAction,
    progressUnits: progress.unitIds.length,
    errors: progress.errors.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
