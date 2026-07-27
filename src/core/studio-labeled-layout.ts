/**
 * Studio 本地 labeled 宫格板派生。
 *
 * 合同：raw 由外部 agent-imagegen 单图生成；labeled 为**本地排版**中文格标/字幕条，
 * 不二次调用外部生图，不把字幕画进 raw 语义。
 *
 * 灵感对齐（个人非商用可研究参考项目的「宫格成板」需求）：
 * ArcReel/Huobao/Toonflow 的宫格/检查板体验；实现为 clean-room，不复制第三方源码。
 */
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export type StudioLabeledLayoutErrorCode =
  | "invalid-input"
  | "source-unreadable"
  | "decode-failed"
  | "output-failed";

export class StudioLabeledLayoutError extends Error {
  readonly code: StudioLabeledLayoutErrorCode;
  readonly details: string[];

  constructor(code: StudioLabeledLayoutErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "StudioLabeledLayoutError";
    this.code = code;
    this.details = details;
  }
}

export interface StudioLabeledLayoutLabels {
  /** 宫格标题，如「第 1 格 · 石室」 */
  panelTitle: string;
  /** 底部字幕/对白摘要，可空 */
  subtitle?: string;
  /** 可选右上角运行/供应方标记，仅审片用 */
  badge?: string;
}

export interface MaterializeStudioLabeledLayoutInput {
  rawPath: string;
  outputPath: string;
  labels: StudioLabeledLayoutLabels;
  /** 默认 true：输出前拒绝覆盖已有文件 */
  failIfExists?: boolean;
}

export interface StudioLabeledLayoutResult {
  schemaVersion: 1;
  kind: "studio-local-labeled-layout";
  rawPath: string;
  outputPath: string;
  width: number;
  height: number;
  rawSha256: string;
  labeledSha256: string;
  labels: {
    panelTitle: string;
    subtitle: string;
    badge: string;
  };
  recipe: "chinese-panel-chrome-v1";
}

export interface RenderedStudioLabeledLayout extends Omit<StudioLabeledLayoutResult, "outputPath"> {
  png: Buffer;
}

export interface MaterializeStudioUnitGridLabeledLayoutInput {
  rawPath: string;
  outputPath: string;
  unitTitle: string;
  badge?: string;
  panels: Array<{
    order: number;
    panelId: string;
    startSeconds: number;
    endSeconds: number;
    subtitle?: string;
  }>;
  failIfExists?: boolean;
}

export interface StudioUnitGridLabeledLayoutResult {
  schemaVersion: 1;
  kind: "studio-local-unit-grid-labeled-layout";
  rawPath: string;
  outputPath: string;
  width: number;
  height: number;
  rawSha256: string;
  labeledSha256: string;
  unitTitle: string;
  badge: string;
  panels: Array<{
    order: number;
    panelId: string;
    startSeconds: number;
    endSeconds: number;
    subtitle: string;
  }>;
  recipe: "chinese-unit-grid-chrome-v1";
}

export interface RenderedStudioUnitGridLabeledLayout extends Omit<StudioUnitGridLabeledLayoutResult, "outputPath"> {
  png: Buffer;
}

function fail(code: StudioLabeledLayoutErrorCode, message: string, details: string[] = []): never {
  throw new StudioLabeledLayoutError(code, message, details);
}

function requiredText(value: string | undefined, field: string, max = 200): string {
  const normalized = (value ?? "").trim();
  if (!normalized) fail("invalid-input", `${field} 不能为空。`);
  if (normalized.length > max) fail("invalid-input", `${field} 过长（>${max}）。`);
  return normalized;
}

function optionalText(value: string | undefined, field: string, max = 200): string {
  const normalized = (value ?? "").trim();
  if (normalized.length > max) fail("invalid-input", `${field} 过长（>${max}）。`);
  return normalized;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

/** 只渲染内存 PNG；受管调用方可用已打开的 O_NOFOLLOW fd 原子落盘。 */
export async function renderStudioLabeledLayoutToBuffer(
  input: Omit<MaterializeStudioLabeledLayoutInput, "outputPath" | "failIfExists">,
): Promise<RenderedStudioLabeledLayout> {
  const rawPath = path.resolve(requiredText(input.rawPath, "rawPath", 4096));
  const panelTitle = requiredText(input.labels.panelTitle, "labels.panelTitle", 80);
  const subtitle = optionalText(input.labels.subtitle, "labels.subtitle", 120);
  const badge = optionalText(input.labels.badge, "labels.badge", 40);

  try {
    await access(rawPath);
  } catch {
    fail("source-unreadable", `无法读取 raw：${rawPath}`);
  }

  let meta: sharp.Metadata;
  try {
    meta = await sharp(rawPath).rotate().metadata();
  } catch (error) {
    fail("decode-failed", "raw 图像无法解码。", [error instanceof Error ? error.message : String(error)]);
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 64 || height < 64) {
    fail("decode-failed", `raw 尺寸无效：${width}x${height}`);
  }

  const title = escapeXml(panelTitle.slice(0, 40));
  const sub = escapeXml((subtitle || "审片板").slice(0, 48));
  const badgeText = badge ? escapeXml(badge.slice(0, 24)) : "";
  const topH = Math.max(28, Math.round(height * 0.08));
  const bottomH = Math.max(32, Math.round(height * 0.1));
  const fontMain = Math.max(16, Math.round(width * 0.035));
  const fontSub = Math.max(14, Math.round(width * 0.03));
  const padX = Math.round(width * 0.04);

  const svg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${topH}" fill="rgba(0,0,0,0.55)"/>
  <text x="${padX}" y="${Math.round(topH * 0.68)}"
        font-size="${fontMain}" fill="#f5e6c8"
        font-family="PingFang SC, Hiragino Sans GB, sans-serif">${title}</text>
  ${badgeText
    ? `<text x="${width - padX}" y="${Math.round(topH * 0.68)}" text-anchor="end"
        font-size="${Math.max(12, Math.round(fontMain * 0.75))}" fill="#9fd3ff"
        font-family="PingFang SC, Hiragino Sans GB, sans-serif">${badgeText}</text>`
    : ""}
  <rect x="0" y="${height - bottomH}" width="${width}" height="${bottomH}" fill="rgba(0,0,0,0.55)"/>
  <text x="${padX}" y="${height - Math.round(bottomH * 0.35)}"
        font-size="${fontSub}" fill="#ffffff"
        font-family="PingFang SC, Hiragino Sans GB, sans-serif">${sub}</text>
</svg>`);

  let png: Buffer;
  try {
    png = await sharp(rawPath)
      .rotate()
      .composite([{ input: svg, top: 0, left: 0 }])
      .png()
      .toBuffer();
  } catch (error) {
    fail("output-failed", "渲染 labeled 失败。", [error instanceof Error ? error.message : String(error)]);
  }

  const rawSha256 = await sha256File(rawPath);
  const labeledSha256 = createHash("sha256").update(png).digest("hex");
  if (rawSha256 === labeledSha256) {
    fail("output-failed", "labeled 与 raw SHA 相同，排版未生效。");
  }

  return {
    schemaVersion: 1,
    kind: "studio-local-labeled-layout",
    rawPath,
    width,
    height,
    rawSha256,
    labeledSha256,
    labels: {
      panelTitle,
      subtitle: subtitle || "审片板",
      badge,
    },
    recipe: "chinese-panel-chrome-v1",
    png,
  };
}

/**
 * 从可解码 raw 图像本地派生 labeled PNG（中文顶栏 + 底栏字幕）。
 * 不写工程库、不 import CAS；调用方负责 importStudioMedia + register。
 */
export async function materializeStudioLabeledLayout(
  input: MaterializeStudioLabeledLayoutInput,
): Promise<StudioLabeledLayoutResult> {
  const outputPath = path.resolve(requiredText(input.outputPath, "outputPath", 4096));
  const rendered = await renderStudioLabeledLayoutToBuffer({ rawPath: input.rawPath, labels: input.labels });
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await writeFile(outputPath, rendered.png, { flag: input.failIfExists === false ? "w" : "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail("output-failed", `labeled 输出已存在，拒绝覆盖：${outputPath}`);
    }
    fail("output-failed", "写入 labeled 失败。", [error instanceof Error ? error.message : String(error)]);
  }
  const { png: _png, ...result } = rendered;
  return { ...result, outputPath };
}

/**
 * 从 2–6 格、由上到下排列的单张整板 raw 派生本地审片 labeled。
 * 只绘制格号、时码与短字幕，不切图、不修改 raw，也不调用外部模型。
 */
export async function renderStudioUnitGridLabeledLayoutToBuffer(
  input: Omit<MaterializeStudioUnitGridLabeledLayoutInput, "outputPath" | "failIfExists">,
): Promise<RenderedStudioUnitGridLabeledLayout> {
  const rawPath = path.resolve(requiredText(input.rawPath, "rawPath", 4096));
  const unitTitle = requiredText(input.unitTitle, "unitTitle", 80);
  const badge = optionalText(input.badge, "badge", 40);
  if (!Array.isArray(input.panels) || input.panels.length < 2 || input.panels.length > 6) {
    fail("invalid-input", "panels 必须是 2–6 项数组。");
  }
  const panels = input.panels.map((panel, offset) => {
    if (panel.order !== offset + 1 || !Number.isSafeInteger(panel.order)) {
      fail("invalid-input", `panels[${offset}].order 必须按 1–${input.panels.length} 连续递增。`);
    }
    const panelId = requiredText(panel.panelId, `panels[${offset}].panelId`, 255);
    if (!Number.isFinite(panel.startSeconds) || !Number.isFinite(panel.endSeconds)
      || panel.startSeconds < 0 || panel.endSeconds <= panel.startSeconds) {
      fail("invalid-input", `panels[${offset}] 时码无效。`);
    }
    if (offset > 0 && Math.abs(panel.startSeconds - input.panels[offset - 1]!.endSeconds) > 1e-6) {
      fail("invalid-input", `panels[${offset}] 与前一格时码不连续。`);
    }
    return {
      order: panel.order,
      panelId,
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
      subtitle: optionalText(panel.subtitle, `panels[${offset}].subtitle`, 120),
    };
  });

  try {
    await access(rawPath);
  } catch {
    fail("source-unreadable", `无法读取 raw：${rawPath}`);
  }
  let meta: sharp.Metadata;
  try {
    meta = await sharp(rawPath).rotate().metadata();
  } catch (error) {
    fail("decode-failed", "raw 图像无法解码。", [error instanceof Error ? error.message : String(error)]);
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 64 || height < 64) fail("decode-failed", `raw 尺寸无效：${width}x${height}`);

  const rowHeight = height / panels.length;
  const fontMain = Math.max(13, Math.round(width * 0.028));
  const fontSub = Math.max(11, Math.round(width * 0.023));
  const padX = Math.max(8, Math.round(width * 0.025));
  const badgeText = badge ? escapeXml(badge.slice(0, 24)) : "";
  const overlays = panels.map((panel, offset) => {
    const y = Math.round(offset * rowHeight);
    const nextY = Math.round((offset + 1) * rowHeight);
    const labelHeight = Math.max(24, Math.min(52, Math.round((nextY - y) * 0.18)));
    const title = escapeXml(`第 ${panel.order} 格 · ${panel.startSeconds}–${panel.endSeconds} 秒`);
    const subtitle = escapeXml((panel.subtitle || panel.panelId).slice(0, 42));
    return `
      ${offset > 0 ? `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="rgba(255,255,255,0.9)" stroke-width="2"/>` : ""}
      <rect x="0" y="${y}" width="${width}" height="${labelHeight}" fill="rgba(0,0,0,0.58)"/>
      <text x="${padX}" y="${y + Math.round(labelHeight * 0.46)}" font-size="${fontMain}" fill="#f5e6c8"
            font-family="PingFang SC, Hiragino Sans GB, sans-serif">${title}</text>
      <text x="${padX}" y="${y + Math.round(labelHeight * 0.82)}" font-size="${fontSub}" fill="#ffffff"
            font-family="PingFang SC, Hiragino Sans GB, sans-serif">${subtitle}</text>
      ${offset === 0 && badgeText ? `<text x="${width - padX}" y="${y + Math.round(labelHeight * 0.46)}" text-anchor="end"
            font-size="${fontSub}" fill="#9fd3ff" font-family="PingFang SC, Hiragino Sans GB, sans-serif">${escapeXml(unitTitle.slice(0, 30))} · ${badgeText}</text>` : ""}`;
  }).join("");
  const svg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${overlays}</svg>`);

  let png: Buffer;
  try {
    png = await sharp(rawPath).rotate().composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
  } catch (error) {
    fail("output-failed", "渲染 unit-grid labeled 失败。", [error instanceof Error ? error.message : String(error)]);
  }
  const [rawSha256, labeledSha256] = await Promise.all([
    sha256File(rawPath),
    Promise.resolve(createHash("sha256").update(png).digest("hex")),
  ]);
  if (rawSha256 === labeledSha256) fail("output-failed", "unit-grid labeled 与 raw SHA 相同，排版未生效。");
  return {
    schemaVersion: 1,
    kind: "studio-local-unit-grid-labeled-layout",
    rawPath,
    width,
    height,
    rawSha256,
    labeledSha256,
    unitTitle,
    badge,
    panels,
    recipe: "chinese-unit-grid-chrome-v1",
    png,
  };
}

export async function materializeStudioUnitGridLabeledLayout(
  input: MaterializeStudioUnitGridLabeledLayoutInput,
): Promise<StudioUnitGridLabeledLayoutResult> {
  const outputPath = path.resolve(requiredText(input.outputPath, "outputPath", 4096));
  const rendered = await renderStudioUnitGridLabeledLayoutToBuffer({
    rawPath: input.rawPath,
    unitTitle: input.unitTitle,
    badge: input.badge,
    panels: input.panels,
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await writeFile(outputPath, rendered.png, { flag: input.failIfExists === false ? "w" : "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail("output-failed", `labeled 输出已存在，拒绝覆盖：${outputPath}`);
    }
    fail("output-failed", "写入 unit-grid labeled 失败。", [error instanceof Error ? error.message : String(error)]);
  }
  const { png: _png, ...result } = rendered;
  return { ...result, outputPath };
}

/** 纯函数：构造默认中文宫格标题（单元名 + 格号）。 */
export function formatStudioPanelTitle(unitLabel: string, panelIndex: number): string {
  const unit = requiredText(unitLabel, "unitLabel", 80);
  if (!Number.isSafeInteger(panelIndex) || panelIndex < 1 || panelIndex > 6) {
    fail("invalid-input", "panelIndex 必须是 1–6 的整数。");
  }
  return `${unit} · 第 ${panelIndex} 格`;
}
