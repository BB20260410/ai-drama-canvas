import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION, FUSION_STORYBOARD_VISIBLE_TIME_POLICY_VERSION } from "../src/core/fusion-storyboard-grid.js";
import { buildFusionStoryboardGridForProject } from "../src/core/fusion-storyboard-production.js";
import { renderFusionStoryboardSheet } from "../src/core/fusion-storyboard-sheet.js";

const workspace = path.resolve(import.meta.dirname, "..");
const projectRoot = path.join(workspace, "productions", "gushujuan-s3-f1a688020bfb7af6");
const evidenceRoot = path.join(workspace, "docs", "evidence");
const evidenceName = process.argv[2]?.trim() || "fusion-storyboard-sheet-ep01-008-contract-preview-visible-time-policy-v1-20260716";
const itemId = "season-三-ep01-unit008";
if (!/^[a-z0-9-]{12,120}$/u.test(evidenceName)) throw new Error("证据名称只能使用 12–120 位小写字母、数字和连字符。");

const panelDirectory = path.join(evidenceRoot, `${evidenceName}-panels`);
const pngPath = path.join(evidenceRoot, `${evidenceName}.png`);
const svgPath = path.join(evidenceRoot, `${evidenceName}.svg`);
const jsonPath = path.join(evidenceRoot, `${evidenceName}.json`);
const guardedSidecarNames = [
  "generation-jobs.json",
  "publications.json",
  "asset-consistency-batches.json",
  "command-ledger.json",
] as const;

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

async function guardedSidecarHashes(): Promise<Record<(typeof guardedSidecarNames)[number], string>> {
  return Object.fromEntries(await Promise.all(guardedSidecarNames.map(async (name) => {
    const filePath = path.join(projectRoot, ".aicanvas", name);
    return [name, sha256(await readFile(filePath))] as const;
  }))) as Record<(typeof guardedSidecarNames)[number], string>;
}

const guardedBefore = await guardedSidecarHashes();
const contract = await buildFusionStoryboardGridForProject(projectRoot, itemId, { persist: false });
if (contract.selection.algorithmVersion !== FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION) throw new Error("EP01_008 不是当前剧情语义算法合同。");
if (contract.displayTiming.policyVersion !== FUSION_STORYBOARD_VISIBLE_TIME_POLICY_VERSION) throw new Error("EP01_008 不是当前可见时间策略合同。");
if (contract.selection.panelCount !== 6 || contract.panels.length !== 6) throw new Error(`EP01_008 当前应为六格，实际为 ${contract.panels.length} 格。`);
const contractPath = path.join(projectRoot, ".aicanvas", "storyboard-grids", itemId, `${contract.contractId}.json`);
const contractBytes = await readFile(contractPath);
if (sha256(contractBytes) !== sha256(`${JSON.stringify(contract, null, 2)}\n`)) throw new Error("EP01_008 当前内存合同与已物化合同字节身份不一致。");

const palettes = [
  ["#182e39", "#c9a44d"],
  ["#273628", "#d6bc71"],
  ["#2f2522", "#b88943"],
  ["#172935", "#b7c5a2"],
  ["#302c39", "#c3a65e"],
  ["#1e3132", "#d0b86d"],
] as const;
await mkdir(panelDirectory, { recursive: true });
const panelImages = await Promise.all(contract.panels.map(async (panel, zeroBased) => {
  const [background, accent] = palettes[zeroBased]!;
  const panelPath = path.join(panelDirectory, `${panel.id}_布局占位.png`);
  const imageSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
    <defs>
      <linearGradient id="bg" x2="0" y2="1"><stop stop-color="${background}"/><stop offset="1" stop-color="#070d10"/></linearGradient>
      <radialGradient id="light"><stop stop-color="${accent}" stop-opacity=".72"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="1080" height="1920" fill="url(#bg)"/>
    <ellipse cx="${260 + zeroBased * 112}" cy="${410 + zeroBased * 145}" rx="390" ry="520" fill="url(#light)"/>
    <path d="M0 ${1380 - zeroBased * 45} Q270 ${1120 + zeroBased * 34} 540 ${1390 - zeroBased * 18} T1080 ${1190 + zeroBased * 51} V1920 H0Z" fill="#030709" opacity=".78"/>
    <path d="M${110 + zeroBased * 48} ${1480 - zeroBased * 38} C${420 + zeroBased * 22} 1120 ${690 - zeroBased * 36} 790 ${930 - zeroBased * 42} ${420 + zeroBased * 55}" fill="none" stroke="${accent}" stroke-width="${22 + zeroBased * 4}" opacity=".62"/>
  </svg>`);
  const buffer = await sharp(imageSvg, { density: 144 }).png({ compressionLevel: 9 }).toBuffer();
  await writeExclusiveComparable(panelPath, buffer);
  return { panelId: panel.id, path: panelPath, expectedSha256: sha256(buffer) };
}));

const rendered = await renderFusionStoryboardSheet({
  contract,
  panelImages,
  outputPath: pngPath,
  svgOutputPath: svgPath,
  renderPurpose: "layout-preview",
});
if (rendered.renderPurpose !== "layout-preview" || rendered.formalProductionEligible) throw new Error("布局预览错误地获得了正式生产资格。");

const [svgText, pngMetadata, guardedAfter] = await Promise.all([
  readFile(svgPath, "utf8"),
  sharp(pngPath, { failOn: "error" }).metadata(),
  guardedSidecarHashes(),
]);
const sidecarsUnchanged = JSON.stringify(guardedBefore) === JSON.stringify(guardedAfter);
const detailedColumnMarkers = ["画面内容 / 动作", "景别 / 构图", "拍摄方式", "连续性 / 声音", "台词 / 字幕", "时间"];
  const checks = {
  currentSemanticContract: contract.selection.algorithmVersion === FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION,
  currentVisibleTimePolicy: contract.displayTiming.policyVersion === FUSION_STORYBOARD_VISIBLE_TIME_POLICY_VERSION,
  exactSixPanels: contract.panels.length === 6 && rendered.panelCount === 6,
  exactFifteenSeconds: rendered.durationSeconds === 15,
  visiblePanelDurationsSumToFifteen: Math.abs(contract.panels.reduce((sum, panel) => {
    const match = panel.durationLabel.match(/（([0-9.]+)s）$/u);
    return sum + Number(match?.[1] ?? Number.NaN);
  }, 0) - 15) < 0.001,
  pngDecodable: pngMetadata.format === "png",
  portraitDimensions: pngMetadata.width === 2160 && pngMetadata.height === 3840,
  detailedChineseColumnsPresent: detailedColumnMarkers.every((marker) => svgText.includes(marker)),
  panelPreviewWatermarks: (svgText.match(/版式预览 · 非成片/gu) ?? []).length === 6,
  headerPreviewIdentity: svgText.includes("版式预览 · 不计入正式生产"),
  footerPreviewIdentity: svgText.includes("布局证据，不是正式图片"),
  startAndEndRolesPresent: svgText.includes("首帧") && svgText.includes("尾帧"),
  rhythmAndTotalDurationPresent: svgText.includes("节奏链") && svgText.includes("总时长 15.0s"),
  sourceTracePresent: svgText.includes(contract.contractId) && svgText.includes(contract.sourceFingerprint.slice(0, 24)),
  machinePurposeEmbedded: svgText.includes("&quot;renderPurpose&quot;:&quot;layout-preview&quot;") && svgText.includes("&quot;formalProductionEligible&quot;:false"),
  allPanelHashesMatched: rendered.panelImages.every((image, index) => image.sha256 === panelImages[index]?.expectedSha256),
  guardedFormalSidecarsUnchanged: sidecarsUnchanged,
  outputOutsideProductionProject: path.relative(projectRoot, pngPath).startsWith("..") && path.relative(projectRoot, svgPath).startsWith(".."),
};
if (Object.values(checks).some((passed) => !passed)) throw new Error(`EP01_008 中文板预览机械验收失败：${JSON.stringify(checks)}`);

const evidence = {
  schemaVersion: 1,
  kind: "fusion-storyboard-sheet-formal-contract-preview-evidence",
  evidenceRole: "formal-contract-layout-preview",
  fixtureOnly: true,
  formalProductionEligible: false,
  fixtureNotice: "本证据读取现行正式剧情合同，但逐格画面是本地布局占位；只证明中文成板版式，不计入第三季正式图片。",
  workspace,
  projectRoot,
  itemId,
  contract: {
    path: contractPath,
    sha256: sha256(contractBytes),
    id: contract.contractId,
    sourceFingerprint: contract.sourceFingerprint,
    algorithmVersion: contract.selection.algorithmVersion,
    visibleTimePolicyVersion: contract.displayTiming.policyVersion,
    panelCount: contract.panels.length,
    detectedBeatCount: contract.selection.detectedBeatCount,
    durationSeconds: contract.unit.standardDurationSeconds,
    header: contract.header,
    panels: contract.panels.map((panel) => ({
      id: panel.id,
      index: panel.index,
      frameRole: panel.frameRole,
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
      imageContentAction: panel.imageContentAction,
      assetIds: panel.assetIds,
    })),
  },
  render: {
    renderPurpose: rendered.renderPurpose,
    formalProductionEligible: rendered.formalProductionEligible,
    png: rendered.png,
    svg: rendered.svg,
    width: rendered.width,
    height: rendered.height,
    panelCount: rendered.panelCount,
    durationSeconds: rendered.durationSeconds,
    panelImages: rendered.panelImages,
  },
  guardedSidecars: { before: guardedBefore, after: guardedAfter, unchanged: sidecarsUnchanged },
  formalSideEffects: {
    jobsCreated: 0,
    publicationsCreated: 0,
    reviewsCreated: 0,
    remoteIdentityCreated: false,
    productionOutputsWritten: 0,
  },
  checks,
};
await writeExclusiveComparable(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ jsonPath, pngPath, svgPath, contractId: contract.contractId, renderPurpose: rendered.renderPurpose, formalProductionEligible: rendered.formalProductionEligible, checks }, null, 2)}\n`);
