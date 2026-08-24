import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { buildFusionStoryboardGrid, type FusionStoryboardGridContract } from "../src/core/fusion-storyboard-grid.js";
import {
  FUSION_STORYBOARD_SHEET_RENDER_POLICY_VERSION,
  renderFusionStoryboardSheet,
  renderFusionStoryboardSheetV2,
  type FusionStoryboardSheetPanelImageInput,
} from "../src/core/fusion-storyboard-sheet.js";
import type { FusionScheduleRow } from "../src/core/fusion-package.js";
import type { StoryboardProductionContract } from "../src/core/types.js";
import { xmlVisibleText } from "../src/core/xml-visible-text.js";

const UNIT_ID = "season-3-ep01-unit001";
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function storyboardRows(count: number): StoryboardProductionContract[] {
  return Array.from({ length: count }, (_, index) => ({
    storyboardRowId: `row-${index + 1}`,
    storyboardRowRevision: index + 1,
    itemId: UNIT_ID,
    shotItemId: `${UNIT_ID}-shot${index + 1}`,
    order: index + 1,
    durationSeconds: 15 / count,
    shotSize: index === 0 ? "远景" : index === count - 1 ? "特写" : "中景",
    cameraMovement: index % 2 ? "固定镜头" : "缓慢推进",
    cameraAngle: index % 2 ? "平视" : "低机位",
    lens: index % 2 ? "50mm" : "35mm",
    composition: "主体位于纵向中轴，保留前后景深",
    staging: "角色动作沿同一轴线连续推进",
    action: `第 ${index + 1} 段动作，榜缝金光逐步聚拢并改变空间层次`,
    expression: "警觉",
    emotion: index === count - 1 ? "决断" : "紧张",
    dialogue: index % 2 ? undefined : `阿航：第 ${index + 1} 段台词`,
    narration: index % 2 ? `旁白：第 ${index + 1} 段推进` : undefined,
    ambience: "高空风声与低频嗡鸣",
    soundEffects: ["榜纸震动", "金光划破空气"],
    continuityBefore: index ? `承接第 ${index} 段动作落点` : "承接第二季彩蛋",
    continuityAfter: index === count - 1 ? "落在下一单元悬念" : `进入第 ${index + 2} 段`,
    firstFramePrompt: `第 ${index + 1} 段起势，古蜀神魔空间，纯画面`,
    endFramePrompt: `第 ${index + 1} 段落点，空间连续，纯画面`,
    videoPrompt: `第 ${index + 1} 段连续动作`,
    referencePaths: [],
    referenceArtifactIds: [],
  }));
}

function schedule(count: number): FusionScheduleRow[] {
  return Array.from({ length: count }, (_, index) => {
    const startSeconds = (15 * index) / count;
    const endSeconds = (15 * (index + 1)) / count;
    return {
      index,
      startSeconds,
      endSeconds,
      durationSeconds: endSeconds - startSeconds,
      label: `镜${index + 1}`,
      content: `第 ${index + 1} 段`,
      kind: "source-shot",
      sourceShotNumber: index + 1,
    };
  });
}

async function fixture(panelCount: number): Promise<{
  root: string;
  contract: FusionStoryboardGridContract;
  images: FusionStoryboardSheetPanelImageInput[];
  outputPath: string;
  svgOutputPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-storyboard-sheet-"));
  roots.push(root);
  const panelDirectory = path.join(root, "panels");
  await mkdir(panelDirectory, { recursive: true });
  const contract = buildFusionStoryboardGrid({
    unit: {
      unitId: UNIT_ID,
      title: "承第二季彩蛋·封神榜缝隙开启",
      episodeLabel: "EP01",
      unitSequence: 1,
      storyGoal: "榜缝金光建立第三季主线",
      aspectRatio: "9:16",
      standardDurationSeconds: 15,
    },
    storyboardRevision: 9,
    rows: storyboardRows(panelCount),
    schedule: schedule(panelCount),
    assetIdsByRowId: Object.fromEntries(Array.from({ length: panelCount }, (_, index) => [`row-${index + 1}`, ["C01", "S01", `P${String(index + 1).padStart(2, "0")}`]])),
  });
  const colors = ["#17354f", "#6b4935", "#8e6a2c", "#314d3c", "#5b3547", "#274b59"];
  const images = await Promise.all(contract.panels.map(async (panel, index) => {
    const imagePath = path.join(panelDirectory, `${panel.id}.png`);
    const buffer = await sharp({ create: { width: 720, height: 1280, channels: 3, background: colors[index % colors.length]! } })
      .composite([{ input: Buffer.from(`<svg width="720" height="1280" xmlns="http://www.w3.org/2000/svg"><circle cx="${150 + index * 55}" cy="${270 + index * 70}" r="150" fill="#d8b65d" opacity=".42"/><path d="M0 1010 Q180 ${760 - index * 28} 360 960 T720 ${820 + index * 30} V1280 H0Z" fill="#0b1518" opacity=".72"/><path d="M80 ${980 - index * 45} L640 ${420 + index * 38}" stroke="#eadb9a" stroke-width="18" opacity=".72"/></svg>`) }])
      .png({ compressionLevel: 9 })
      .toBuffer();
    await writeFile(imagePath, buffer);
    return { panelId: panel.id, path: imagePath, expectedSha256: digest(buffer) };
  }));
  return {
    root,
    contract,
    images,
    outputPath: path.join(root, "EP01_15s_001_分镜故事板.png"),
    svgOutputPath: path.join(root, "EP01_15s_001_分镜故事板.svg"),
  };
}

describe("融合分镜故事板本地渲染", () => {
  it("将六张纯画面按完整中文纵向表格生成确定性 long-sheet，并保持幂等", async () => {
    const sample = await fixture(6);
    const first = await renderFusionStoryboardSheetV2({ contract: sample.contract, panelImages: sample.images, outputPath: sample.outputPath, svgOutputPath: sample.svgOutputPath, renderPurpose: "formal" });
    expect(first).toMatchObject({ schemaVersion: 2, kind: "fusion-storyboard-sheet-render", width: 2160, panelCount: 6, durationSeconds: 15, renderPurpose: "formal", formalProductionEligible: true, reused: false, pageCount: 1 });
    expect(first.height).toBeGreaterThanOrEqual(3840);
    expect(first.renderFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.inputAudit.renderFingerprint).toBe(first.renderFingerprint);
    expect(first.renderPolicy).toMatchObject({
      policyVersion: FUSION_STORYBOARD_SHEET_RENDER_POLICY_VERSION,
      renderer: "svg-sharp-v2",
      locale: "zh-CN",
      defaultImageFit: "contain",
      overflowPolicy: "long-sheet",
      rowHeightPolicy: "dynamic-content-measured",
      silentTruncation: false,
    });
    expect(first.pages).toEqual([{ pageIndex: 1, width: 2160, height: first.height, png: first.png, svg: first.svg }]);
    expect(first.cropAudit).toHaveLength(6);
    expect(first.cropAudit.every((entry) => entry.fit === "contain" && entry.geometry === "none" && !entry.cropApplied)).toBe(true);
    expect(first.overflowReport).toMatchObject({ actualPageHeight: first.height, allRequiredTextVisible: true, silentTruncation: false, truncatedFields: [] });
    expect(first.overflowReport.rows).toHaveLength(6);
    expect(first.overflowReport.rows.every((row) => row.textFields.length === 5 && row.textFields.every((field) => field.complete))).toBe(true);
    expect(first.png.status).toBe("created");
    expect(first.svg.status).toBe("created");
    expect(first.panelImages.map((image) => image.sha256)).toEqual(sample.images.map((image) => image.expectedSha256));
    expect(first.panelImages.every((image) => image.width === 720 && image.height === 1280 && image.format === "png")).toBe(true);
    const metadata = await sharp(sample.outputPath, { failOn: "error" }).metadata();
    expect(metadata).toMatchObject({ width: 2160, height: first.height, format: "png" });
    const svg = await readFile(sample.svgOutputPath, "utf8");
    const visibleTextWithoutWhitespace = xmlVisibleText(svg).replace(/\s/gu, "");
    expect(svg).toContain("中文本地排版 · AI 画面无字");
    expect(svg).toContain("画面内容 / 动作");
    expect(svg).toContain("连续性 / 声音");
    expect(svg).toContain("首帧");
    expect(svg).toContain("尾帧");
    expect(svg).toContain("节奏链");
    expect(svg).toContain("总时长 15.0s");
    expect(svg).toContain(sample.contract.header.metadataLine);
    expect(svg).toContain(sample.contract.contractId);
    expect(svg).toContain(sample.contract.sourceFingerprint.slice(0, 24));
    for (const panel of sample.contract.panels) {
      for (const field of panel.tableFields.filter((candidate) => candidate.key !== "duration")) {
        expect(visibleTextWithoutWhitespace).toContain(field.value.replace(/\s/gu, ""));
      }
    }
    expect((svg.match(/图像 SHA256 /gu) ?? [])).toHaveLength(6);
    expect(svg).not.toContain("…");
    expect(svg).not.toContain("版式预览 · 非成片");
    expect(svg).toContain("data:image/jpeg;base64,");
    expect(svg).not.toContain("file://");
    const before = await Promise.all([stat(sample.outputPath), stat(sample.svgOutputPath)]);
    const second = await renderFusionStoryboardSheetV2({ contract: sample.contract, panelImages: sample.images, outputPath: sample.outputPath, svgOutputPath: sample.svgOutputPath, renderPurpose: "formal" });
    const after = await Promise.all([stat(sample.outputPath), stat(sample.svgOutputPath)]);
    expect(second.reused).toBe(true);
    expect(second.png.status).toBe("existing");
    expect(second.svg.status).toBe("existing");
    expect(after.map((entry) => entry.mtimeMs)).toEqual(before.map((entry) => entry.mtimeMs));
    expect(second.png.sha256).toBe(first.png.sha256);
    expect(second.svg.sha256).toBe(first.svg.sha256);
  }, 30_000);

  it("用醒目水印和机器字段区分布局预览，禁止把占位画面计入正式生产", async () => {
    const sample = await fixture(6);
    const preview = await renderFusionStoryboardSheetV2({
      contract: sample.contract,
      panelImages: sample.images,
      outputPath: sample.outputPath,
      svgOutputPath: sample.svgOutputPath,
      renderPurpose: "layout-preview",
    });
    expect(preview).toMatchObject({ renderPurpose: "layout-preview", formalProductionEligible: false, panelCount: 6, durationSeconds: 15 });
    const svg = await readFile(sample.svgOutputPath, "utf8");
    expect(svg).toContain("版式预览 · 不计入正式生产");
    expect(svg).toContain("布局证据，不是正式图片");
    expect((svg.match(/版式预览 · 非成片/gu) ?? [])).toHaveLength(6);
    expect(svg).toContain("&quot;renderPurpose&quot;:&quot;layout-preview&quot;");
    expect(svg).toContain("&quot;formalProductionEligible&quot;:false");
    expect(svg).toContain("画面内容 / 动作");
    expect(svg).toContain("景别 / 构图");
    expect(svg).toContain("拍摄方式");
    expect(svg).toContain("连续性 / 声音");
    expect(svg).toContain("台词 / 字幕");
    expect(svg).toContain("时间");
    await expect(renderFusionStoryboardSheet({
      contract: sample.contract,
      panelImages: sample.images,
      outputPath: path.join(sample.root, "invalid.png"),
      renderPurpose: "preview" as never,
    })).rejects.toThrow(/renderPurpose/);
  }, 30_000);

  it("测量长中文字段后动态增加行高，完整保留结尾；超过上限时 formal 失败关闭", async () => {
    const sample = await fixture(2);
    const completeEnding = "【动作字段完整终点】";
    const longAction = `${"阿航沿封神榜裂隙边缘缓慢移动并观察金光与空间变化，".repeat(26)}${completeEnding}`;
    sample.contract.panels[0]!.imageContentAction = longAction;
    sample.contract.panels[0]!.tableFields.find((field) => field.key === "imageContentAction")!.value = longAction;
    const limitedPng = path.join(sample.root, "limited.png");
    const limitedSvg = path.join(sample.root, "limited.svg");
    await expect(renderFusionStoryboardSheetV2({
      contract: sample.contract,
      panelImages: sample.images,
      outputPath: limitedPng,
      svgOutputPath: limitedSvg,
      renderPurpose: "formal",
      renderPolicy: { overflowPolicy: "long-sheet", maximumPageHeight: 3840 },
    })).rejects.toThrow(/拒绝截断并失败关闭/);
    await expect(stat(limitedPng)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(limitedSvg)).rejects.toMatchObject({ code: "ENOENT" });

    const rendered = await renderFusionStoryboardSheetV2({
      contract: sample.contract,
      panelImages: sample.images,
      outputPath: sample.outputPath,
      svgOutputPath: sample.svgOutputPath,
      renderPurpose: "formal",
    });
    expect(rendered.height).toBeGreaterThan(3840);
    expect(rendered.overflowReport).toMatchObject({ expanded: true, allRequiredTextVisible: true, silentTruncation: false, truncatedFields: [] });
    const fieldAudit = rendered.overflowReport.rows[0]!.textFields.find((field) => field.field === "imageContentAction")!;
    expect(fieldAudit.lineCount).toBeGreaterThan(20);
    expect(fieldAudit.requiredHeight).toBeLessThanOrEqual(fieldAudit.allocatedHeight);
    expect(fieldAudit.contentSha256).toBe(digest(Buffer.from(longAction)));
    const svg = await readFile(sample.svgOutputPath, "utf8");
    const visibleText = xmlVisibleText(svg);
    expect(visibleText).toContain(completeEnding);
    expect(svg).not.toContain("…");
    expect(svg).toContain("&quot;allRequiredTextVisible&quot;:true");
    const metadata = await sharp(sample.outputPath, { failOn: "error" }).metadata();
    expect(metadata).toMatchObject({ width: 2160, height: rendered.height, format: "png" });
  }, 30_000);

  it("默认 contain 不裁图；显式 focal/rect crop 归一化并冻结实际像素审计", async () => {
    const sample = await fixture(2);
    const croppedImages: FusionStoryboardSheetPanelImageInput[] = [
      { ...sample.images[0]!, imageTransform: { fit: "crop", focalPoint: { x: 0.25, y: 0.7 } } },
      { ...sample.images[1]!, imageTransform: { fit: "crop", rect: { x: 0.1, y: 0.2, width: 0.75, height: 0.6 } } },
    ];
    const rendered = await renderFusionStoryboardSheetV2({
      contract: sample.contract,
      panelImages: croppedImages,
      outputPath: sample.outputPath,
      svgOutputPath: sample.svgOutputPath,
      renderPurpose: "formal",
    });
    expect(rendered.cropAudit).toHaveLength(2);
    expect(rendered.cropAudit[0]).toMatchObject({
      fit: "crop",
      geometry: "focal-point",
      focalPoint: { x: 0.25, y: 0.7 },
      cropApplied: true,
      sourceWidth: 720,
      sourceHeight: 1280,
      orientedWidth: 720,
      orientedHeight: 1280,
      targetWidth: 570,
    });
    expect(rendered.cropAudit[0]!.appliedPixelRect).toBeDefined();
    expect(rendered.cropAudit[0]!.appliedRect).toBeDefined();
    expect(rendered.cropAudit[1]).toMatchObject({
      fit: "crop",
      geometry: "rect",
      requestedRect: { x: 0.1, y: 0.2, width: 0.75, height: 0.6 },
      appliedPixelRect: { left: 72, top: 256, width: 540, height: 768 },
      cropApplied: true,
    });
    const svg = await readFile(sample.svgOutputPath, "utf8");
    expect(svg).toContain("&quot;geometry&quot;:&quot;focal-point&quot;");
    expect(svg).toContain("&quot;geometry&quot;:&quot;rect&quot;");
    expect(svg).toContain("&quot;cropApplied&quot;:true");
  }, 30_000);

  it("严格拒绝缺图、错误 SHA、源图覆盖和非 15 秒合同", async () => {
    const sample = await fixture(2);
    await expect(renderFusionStoryboardSheet({ contract: sample.contract, panelImages: sample.images.slice(0, 1), outputPath: sample.outputPath })).rejects.toThrow(/且只提供一张/);
    await expect(renderFusionStoryboardSheet({
      contract: sample.contract,
      panelImages: [{ ...sample.images[0]!, expectedSha256: "0".repeat(64) }, sample.images[1]!],
      outputPath: sample.outputPath,
    })).rejects.toThrow(/SHA-256 不一致/);
    await expect(renderFusionStoryboardSheet({ contract: sample.contract, panelImages: sample.images, outputPath: sample.images[0]!.path })).rejects.toThrow(/不能覆盖任何逐格画面/);
    await expect(renderFusionStoryboardSheetV2({
      contract: sample.contract,
      panelImages: [{ ...sample.images[0]!, imageTransform: { fit: "crop" } } as never, sample.images[1]!],
      outputPath: sample.outputPath,
      renderPurpose: "formal",
    })).rejects.toThrow(/必须且只能提供 focalPoint 或 rect/);
    await expect(renderFusionStoryboardSheetV2({
      contract: sample.contract,
      panelImages: [{ ...sample.images[0]!, imageTransform: { fit: "crop", focalPoint: { x: 1.2, y: 0.5 } } }, sample.images[1]!],
      outputPath: sample.outputPath,
      renderPurpose: "formal",
    })).rejects.toThrow(/归一化数值/);
    await expect(renderFusionStoryboardSheetV2({
      contract: sample.contract,
      panelImages: [{ ...sample.images[0]!, imageTransform: { fit: "crop", rect: { x: 0.8, y: 0, width: 0.4, height: 1 } } }, sample.images[1]!],
      outputPath: sample.outputPath,
      renderPurpose: "formal",
    })).rejects.toThrow(/完整位于源图内/);
    const broken = structuredClone(sample.contract);
    broken.panels[1]!.endSeconds = 14;
    broken.panels[1]!.durationSeconds = 6.5;
    broken.panels[1]!.durationLabel = "7.5–14.0s（6.5s）";
    broken.panels[1]!.tableFields.find((field) => field.key === "duration")!.value = broken.panels[1]!.durationLabel;
    await expect(renderFusionStoryboardSheet({ contract: broken, panelImages: sample.images, outputPath: sample.outputPath })).rejects.toThrow(/累计必须严格为 15 秒/);
  });

  it("目标已有不同内容时失败关闭并保留原文件", async () => {
    const sample = await fixture(2);
    const sentinel = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ff0033" } }).png().toBuffer();
    await writeFile(sample.outputPath, sentinel);
    await expect(renderFusionStoryboardSheet({ contract: sample.contract, panelImages: sample.images, outputPath: sample.outputPath, svgOutputPath: sample.svgOutputPath })).rejects.toThrow(/内容冲突/);
    expect(await readFile(sample.outputPath)).toEqual(sentinel);
    await expect(stat(sample.svgOutputPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});
