import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { buildFusionStoryboardGrid } from "../src/core/fusion-storyboard-grid.js";
import { renderFusionStoryboardSheet } from "../src/core/fusion-storyboard-sheet.js";
import type { FusionScheduleRow } from "../src/core/fusion-package.js";
import type { StoryboardProductionContract } from "../src/core/types.js";

const workspace = path.resolve(import.meta.dirname, "..");
const evidenceDirectory = path.join(workspace, "docs", "evidence");
const evidenceName = process.argv[2]?.trim() || "fusion-storyboard-sheet-local-v1-20260715";
if (!/^[a-z0-9-]{12,100}$/u.test(evidenceName)) throw new Error("证据名称只能使用 12–100 位小写字母、数字和连字符。 ");
const referencePath = "/Users/hxx/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_5301013010611_6204/temp/RWTemp/2026-07/9e20f478899dc29eb19741386f9343c8/b5ed6bfde193cebf2f04c82406d145dc.jpg";
const panelDirectory = path.join(evidenceDirectory, `${evidenceName}-panels`);
const pngPath = path.join(evidenceDirectory, `${evidenceName}.png`);
const svgPath = path.join(evidenceDirectory, `${evidenceName}.svg`);
const jsonPath = path.join(evidenceDirectory, `${evidenceName}.json`);
const UNIT_ID = "EP01_15s_001";

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeExclusiveComparable(filePath: string, content: Buffer | string): Promise<"created" | "existing"> {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });
    return "created";
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) throw error;
    if (!(await readFile(filePath)).equals(buffer)) throw new Error(`证据目标已存在但内容不同，拒绝覆盖：${filePath}`);
    return "existing";
  }
}

const actions = [
  "封神榜空白格边缘轻颤，纸纤维间浮出第一缕金光",
  "金光沿榜缝横向游走，裂隙轮廓被逐层照亮",
  "榜纸纹理在微距中起伏，光粒向裂隙中心聚拢",
  "裂隙短暂张开，神魔层云气从缝隙后方涌动",
  "金色光带骤然收束，在空白格上留下稳定亮痕",
  "亮痕熄灭前最后一次脉冲，画面落在未揭示的榜缝深处",
];
const colors = [
  ["#102c4b", "#c69b43"],
  ["#392824", "#d8b55e"],
  ["#112e35", "#d2a84f"],
  ["#28354d", "#cfaa55"],
  ["#302b25", "#e2c572"],
  ["#101b2b", "#b99743"],
] as const;

const rows: StoryboardProductionContract[] = actions.map((action, index) => ({
  storyboardRowId: `ep01-u001-row-${index + 1}`,
  storyboardRowRevision: 1,
  itemId: UNIT_ID,
  shotItemId: `season-三-ep01-shot${String(index + 1).padStart(3, "0")}`,
  order: index + 1,
  durationSeconds: 2.5,
  shotSize: ["大远景", "中景", "微距特写", "近景", "特写", "极近特写"][index]!,
  cameraMovement: ["固定镜头", "缓慢推进", "固定微距", "轻微仰移", "快速收束", "极慢推进"][index]!,
  cameraAngle: ["平视", "正面", "低机位", "仰视", "正面", "贴近榜面"][index]!,
  lens: ["35mm", "50mm", "100mm macro", "50mm", "85mm", "100mm macro"][index]!,
  composition: "榜缝位于纵向视觉中轴，云海与榜纸纹理保持连续",
  staging: "无新增人物，空间布局和光源方向严格承接上一格",
  action,
  emotion: index === 5 ? "悬念停顿" : "神秘感递增",
  narration: index === 0 ? "第二季彩蛋之后，封神榜的空白仍在等待名字。" : index === 5 ? "那道缝，像在回应远方的脚步。" : undefined,
  ambience: "高空风声与持续低频嗡鸣",
  soundEffects: index === 3 ? ["榜纸裂响", "云气呼啸"] : ["细微纸颤", "金光电流声"],
  continuityBefore: index ? `承接第 ${index} 格金光位置与强度` : "承接第二季 EP23 彩蛋",
  continuityAfter: index === 5 ? "接 EP01_15s_002" : `金光方向不变，进入第 ${index + 2} 格`,
  firstFramePrompt: `${action}，电影写实，商周神魔层，竖屏纯画面`,
  endFramePrompt: `${action}的动作落点，空间与光向连续，竖屏纯画面`,
  videoPrompt: `${action}，2.5 秒连续镜头`,
  referencePaths: [],
  referenceArtifactIds: [],
}));

const schedule: FusionScheduleRow[] = rows.map((_, index) => ({
  index,
  startSeconds: index * 2.5,
  endSeconds: (index + 1) * 2.5,
  durationSeconds: 2.5,
  label: `原镜 ${String(index + 1).padStart(2, "0")}`,
  content: actions[index]!,
  kind: "source-shot",
  sourceShotNumber: index + 1,
}));

const contract = buildFusionStoryboardGrid({
  unit: {
    unitId: UNIT_ID,
    title: "承第二季EP23彩蛋·封神榜缝隙开启",
    episodeLabel: "蜀道山·古蜀卷 第三季 EP01",
    unitSequence: 1,
    storyGoal: "用榜缝异动建立第三季寻名主线",
    aspectRatio: "9:16",
    standardDurationSeconds: 15,
  },
  storyboardRevision: 1,
  rows,
  schedule,
  assetIdsByRowId: Object.fromEntries(rows.map((row, index) => [row.storyboardRowId, index < 4 ? ["S01", "P02"] : ["S01", "P02", "P03"]])),
});

await mkdir(panelDirectory, { recursive: true });
const panelImages = await Promise.all(contract.panels.map(async (panel, index) => {
  const [background, gold] = colors[index]!;
  const panelPath = path.join(panelDirectory, `宫格${String(panel.index).padStart(2, "0")}_${panel.frameRole === "start" ? "首帧" : panel.frameRole === "end" ? "尾帧" : "中间帧"}.png`);
  const panelSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
    <defs><radialGradient id="g"><stop stop-color="${gold}" stop-opacity=".9"/><stop offset="1" stop-color="${background}" stop-opacity="0"/></radialGradient><linearGradient id="b" x2="0" y2="1"><stop stop-color="${background}"/><stop offset="1" stop-color="#080d13"/></linearGradient></defs>
    <rect width="1080" height="1920" fill="url(#b)"/><ellipse cx="${530 + index * 22}" cy="${680 + index * 75}" rx="${360 - index * 18}" ry="${520 - index * 35}" fill="url(#g)"/>
    <path d="M${190 + index * 34} 180 Q${650 - index * 25} 650 ${430 + index * 30} 1100 T${760 - index * 28} 1780" fill="none" stroke="${gold}" stroke-width="${18 + index * 5}" opacity=".92"/>
    <path d="M0 ${1450 - index * 38} Q280 ${1220 + index * 25} 540 1430 T1080 ${1240 + index * 42} V1920 H0Z" fill="#02070b" opacity=".66"/>
    <g fill="${gold}" opacity=".55">${Array.from({ length: 18 }, (_, particle) => `<circle cx="${110 + ((particle * 83 + index * 37) % 850)}" cy="${310 + ((particle * 127 + index * 51) % 1100)}" r="${5 + (particle % 4) * 3}"/>`).join("")}</g>
  </svg>`);
  const buffer = await sharp(panelSvg, { density: 144 }).png({ compressionLevel: 9 }).toBuffer();
  await writeExclusiveComparable(panelPath, buffer);
  return { panelId: panel.id, path: panelPath, expectedSha256: sha256(buffer) };
}));

const rendered = await renderFusionStoryboardSheet({ contract, panelImages, outputPath: pngPath, svgOutputPath: svgPath });
const [referenceBytes, referenceMetadata, pngMetadata, svgText] = await Promise.all([
  readFile(referencePath),
  sharp(referencePath, { failOn: "error" }).metadata(),
  sharp(pngPath, { failOn: "error" }).metadata(),
  readFile(svgPath, "utf8"),
]);
const evidence = {
  schemaVersion: 1,
  kind: "fusion-storyboard-sheet-visual-evidence",
  fixtureOnly: true,
  fixtureNotice: "本文件只证明本地中文故事板排版与机械门禁，不冒充正式第三季生图资产。",
  reference: {
    path: referencePath,
    sha256: sha256(referenceBytes),
    width: referenceMetadata.width,
    height: referenceMetadata.height,
    readOnly: true,
  },
  contract: {
    id: contract.contractId,
    sourceFingerprint: contract.sourceFingerprint,
    unitId: contract.unit.unitId,
    panelCount: contract.panels.length,
    durationSeconds: contract.unit.standardDurationSeconds,
    layout: contract.layout,
    localRendering: contract.localRendering,
  },
  output: {
    png: { path: rendered.png.path, sha256: rendered.png.sha256, bytes: rendered.png.bytes },
    svg: { path: rendered.svg.path, sha256: rendered.svg.sha256, bytes: rendered.svg.bytes },
    width: rendered.width,
    height: rendered.height,
  },
  panelImages: rendered.panelImages,
  mechanicalChecks: {
    pngDecodable: pngMetadata.format === "png",
    pngDimensions: [pngMetadata.width, pngMetadata.height],
    portraitAspectRatio: pngMetadata.width === 2160 && pngMetadata.height === 3840,
    localChineseMarkersPresent: ["中文本地排版", "画面内容 / 动作", "连续性 / 声音", "台词 / 字幕", "首帧", "尾帧", "节奏链"].every((marker) => svgText.includes(marker)),
    embeddedPanelImages: (svgText.match(/data:image\/jpeg;base64,/gu) ?? []).length === contract.panels.length,
    externalFileUris: svgText.includes("file://"),
    allInputHashesMatched: rendered.panelImages.every((image, index) => image.sha256 === panelImages[index]?.expectedSha256),
  },
};
await writeExclusiveComparable(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ jsonPath, pngPath, svgPath, pngSha256: rendered.png.sha256, svgSha256: rendered.svg.sha256, checks: evidence.mechanicalChecks }, null, 2)}\n`);
