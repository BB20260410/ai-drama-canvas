/**
 * 把本机硬锁人物图与桌面角色音频同步进受管工程人物库。
 * 已有资产不改主权威；同 SHA 不去重失败。写入走 executeIdempotentCommand。
 */
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { getStudioCanonicalAsset, listStudioCanonicalAssets } from "../src/core/material-studio.js";
import { listVoiceIdentities, upsertVoiceIdentity } from "../src/core/asset-registry.js";

const PROJECT_ROOT = "/Users/hxx/Documents/无限画布/projects/codex-ai-drama-studio";
const LOCK_ROOT = "/Users/hxx/Documents/小说第一季/第一季_视觉资产锁定与15秒宫格故事版_20260718/01_人物三视图_硬锁";
const DESKTOP = "/Users/hxx/Desktop";
const TAG = "local-character-sync-20260825";

type NewCharacter = {
  id: string;
  name: string;
  aliases: string[];
  image: string;
  side?: string;
  back?: string;
  extraImages?: string[];
  audio?: string[];
  negativeLocks?: string[];
  description: string;
};

function lock(...parts: string[]): string {
  return path.join(LOCK_ROOT, ...parts);
}
function desk(...parts: string[]): string {
  return path.join(DESKTOP, ...parts);
}

const NEW_CHARACTERS: NewCharacter[] = [
  {
    id: "character-shuo",
    name: "朔",
    aliases: ["朔", "守印天狗父", "嘟嘟爸爸"],
    image: lock("33_朔_守印天狗父_三视图_00.png"),
    extraImages: [desk("嘟嘟爸爸.png")],
    description: "守印天狗父。仅《嘟嘟家史》灭门序章。不得替代嘟嘟 R07。",
  },
  {
    id: "character-su",
    name: "素",
    aliases: ["素", "守印天狗母", "嘟嘟妈妈"],
    image: lock("34_素_守印天狗母_三视图_00.png"),
    extraImages: [desk("嘟嘟妈妈.png")],
    description: "守印天狗母。仅《嘟嘟家史》灭门序章。不得替代嘟嘟 R07。",
  },
  {
    id: "character-qiongqi",
    name: "穷奇",
    aliases: ["穷奇"],
    image: lock("32_穷奇_雾沟追杀态_用户指定硬锁_00.png"),
    description: "仅限嘟嘟专属《雾沟》段落。禁止正面全脸与命名文字。",
  },
  {
    id: "character-father-30",
    name: "父亲（30岁）",
    aliases: ["父", "父亲", "父亲30岁"],
    image: desk("C-父·父亲三视图（30岁版）.png"),
    description: "本机人物库：父亲 30 岁三视图。",
  },
  {
    id: "character-father-50",
    name: "父亲（50岁）",
    aliases: ["父亲50岁"],
    image: desk("C-父·父亲50岁三视图（去眼镜版）.png"),
    description: "本机人物库：父亲 50 岁三视图。",
  },
  {
    id: "character-white-monk",
    name: "白衣僧",
    aliases: ["白衣僧"],
    image: desk("白衣僧.png"),
    extraImages: [desk("白衣服变身.png")],
    description: "本机人物库：白衣僧。",
  },
  {
    id: "character-black-monk",
    name: "黑衣僧",
    aliases: ["黑衣僧"],
    image: desk("黑衣僧.png"),
    extraImages: [desk("黑衣变身.png"), desk("黑衣法相.png")],
    description: "本机人物库：黑衣僧。",
  },
  {
    id: "character-doujie",
    name: "豆姐",
    aliases: ["豆姐", "金色面具人格", "完整黄金面具人格"],
    image: "/Users/hxx/Documents/小说第一季/第一季_视觉资产锁定与15秒宫格故事版_20260718/03_道具三视图_硬锁/00_完整黄金面具_干净硬锁_00.png",
    audio: [desk("金色面具声音.mp3"), desk("金色面具声音参考.mp3")],
    negativeLocks: ["禁止普通人脸", "禁止嘴与眼睑", "禁止半面具或裂面具"],
    description: "完整黄金面具人格。台词后期画外配音。",
  },
];

const AUDIO_BINDINGS: Array<{ assetId: string; name: string; files: string[] }> = [
  {
    assetId: "character-r01-adult-ahang",
    name: "成年阿航 声线",
    files: [desk("阿航声音.mp3"), desk("阿航成年.mp3"), desk("阿航声音参考.wav")],
  },
  {
    assetId: "character-r02-adult-ayi",
    name: "成年阿依 声线",
    files: [desk("阿依声音.mp3"), desk("阿依声音参考.mp3")],
  },
  {
    assetId: "character-r07-dudu",
    name: "嘟嘟 声线",
    files: [desk("嘟嘟声音.mp3"), desk("嘟嘟声音参考.mp3")],
  },
];

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function commandKey(step: string): string {
  return `${TAG}-${createHash("sha256").update(step).digest("hex").slice(0, 24)}`;
}

async function exec(step: string, command: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = commandKey(step);
  const result = await executeIdempotentCommand(PROJECT_ROOT, {
    requestId: key,
    idempotencyKey: key,
    request: { command, payload } as never,
  });
  if (result.status !== "succeeded") {
    throw new Error(`${command} ${result.status}: ${result.error?.message ?? "unknown"} [${step}]`);
  }
  return (result.result ?? {}) as Record<string, unknown>;
}

async function importMedia(step: string, sourcePath: string): Promise<{ sha256: string; kind: string }> {
  const imported = await exec(step, "import_studio_media", { sourcePath });
  const sha256 = String(imported.sha256 ?? "").toLowerCase();
  const kind = String(imported.kind ?? "");
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error(`导入失败：${sourcePath}`);
  return { sha256, kind };
}

async function ensureVersion(
  assetId: string,
  sha256: string,
  sourceNote: string,
  setPrimary: boolean,
): Promise<void> {
  const asset = await getStudioCanonicalAsset(PROJECT_ROOT, assetId);
  if (!asset) throw new Error(`缺少资产 ${assetId}`);
  if (asset.versions.some((version) => version.mediaSha256 === sha256)) return;
  let expectedRevision = asset.revision;
  const appended = await exec(`append:${assetId}:${sha256.slice(0, 12)}`, "append_studio_asset_version", {
    assetId,
    mediaSha256: sha256,
    reviewStatus: "pending",
    sourceNote,
    expectedRevision,
  });
  const version = appended.version as { id?: string } | undefined;
  const versionId = version?.id?.trim();
  if (!versionId) throw new Error(`${assetId} 版本缺少 ID`);
  expectedRevision = Number(appended.assetRevision ?? expectedRevision + 1);
  const reviewed = await exec(`review:${assetId}:${sha256.slice(0, 12)}`, "review_studio_asset_version", {
    assetId,
    versionId,
    decision: "approved",
    expectedRevision,
    note: sourceNote,
  });
  expectedRevision = Number(reviewed.revision ?? expectedRevision + 1);
  if (!setPrimary) return;
  await exec(`primary:${assetId}:${sha256.slice(0, 12)}`, "set_studio_primary_authority", {
    assetId,
    versionId,
    expectedRevision,
    note: sourceNote,
  });
}

async function ensureCharacter(entry: NewCharacter): Promise<void> {
  if (!await exists(entry.image)) {
    console.warn(`跳过 ${entry.name}：主图不存在 ${entry.image}`);
    return;
  }
  const existing = await getStudioCanonicalAsset(PROJECT_ROOT, entry.id);
  if (!existing) {
    await exec(`create:${entry.id}`, "create_studio_asset", {
      id: entry.id,
      category: "character",
      name: entry.name,
      description: entry.description,
      expectedRevision: 0,
      aliases: entry.aliases,
      ...(entry.negativeLocks ? { negativeLocks: entry.negativeLocks } : {}),
    });
  }
  const front = await importMedia(`image:${entry.id}:front`, entry.image);
  await ensureVersion(entry.id, front.sha256, `人物库主图：${entry.name}`, !existing);
  if (entry.side && await exists(entry.side)) {
    const side = await importMedia(`image:${entry.id}:side`, entry.side);
    await ensureVersion(entry.id, side.sha256, "view:side", false);
  }
  if (entry.back && await exists(entry.back)) {
    const back = await importMedia(`image:${entry.id}:back`, entry.back);
    await ensureVersion(entry.id, back.sha256, "view:back", false);
  }
  for (const extra of entry.extraImages ?? []) {
    if (!await exists(extra)) continue;
    const imported = await importMedia(`image:${entry.id}:extra:${path.basename(extra)}`, extra);
    await ensureVersion(entry.id, imported.sha256, `本机补充：${path.basename(extra)}`, false);
  }
  if (entry.audio?.length) {
    await bindAudio(entry.id, `${entry.name} 声线`, entry.audio);
  }
}

async function bindAudio(assetId: string, voiceName: string, files: string[]): Promise<void> {
  const shas: string[] = [];
  for (const filePath of files) {
    if (!await exists(filePath)) continue;
    const imported = await importMedia(`audio:${assetId}:${path.basename(filePath)}`, filePath);
    if (imported.kind !== "audio") throw new Error(`不是音频：${filePath}`);
    shas.push(imported.sha256);
  }
  if (!shas.length) return;
  const voices = await listVoiceIdentities(PROJECT_ROOT);
  const existing = voices.find((voice) => voice.characterAssetIds.includes(assetId) && voice.name === voiceName);
  const merged = [...new Set([...(existing?.sampleMediaSha256s ?? []), ...shas])];
  await upsertVoiceIdentity(PROJECT_ROOT, {
    ...(existing ? { id: existing.id, expectedRevision: existing.revision } : {}),
    name: voiceName,
    description: "本机人物库绑定的角色音频",
    characterAssetIds: [assetId],
    sampleMediaSha256s: merged,
  }, "user");
}

const chars = [];
let cursor: string | undefined;
do {
  const page = await listStudioCanonicalAssets(PROJECT_ROOT, { category: "character", limit: 80, cursor });
  chars.push(...page.items);
  cursor = page.nextCursor;
} while (cursor);
console.log(`同步前人物 ${chars.length}，声线 ${(await listVoiceIdentities(PROJECT_ROOT)).length}`);

for (const entry of NEW_CHARACTERS) {
  await ensureCharacter(entry);
  console.log(`人物就绪：${entry.name}`);
}
for (const binding of AUDIO_BINDINGS) {
  await bindAudio(binding.assetId, binding.name, binding.files);
  console.log(`声线就绪：${binding.name}`);
}

const after = [];
cursor = undefined;
do {
  const page = await listStudioCanonicalAssets(PROJECT_ROOT, { category: "character", limit: 80, cursor });
  after.push(...page.items);
  cursor = page.nextCursor;
} while (cursor);
const voices = await listVoiceIdentities(PROJECT_ROOT);
console.log(JSON.stringify({
  characterCount: after.length,
  names: after.map((item) => item.name).sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true })),
  voiceCount: voices.length,
  voices: voices.map((voice) => ({ name: voice.name, characters: voice.characterAssetIds, samples: voice.sampleMediaSha256s.length })),
}, null, 2));
