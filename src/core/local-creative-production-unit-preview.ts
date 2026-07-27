import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { inspectManagedProjectReadOnly } from "./managed-project.js";
import {
  inspectLocalCreativeSourceInventory,
  type LocalCreativeSourceInventoryLayer,
} from "./local-creative-source-inventory.js";

export type LocalCreativeProductionAdapterKind = "auto" | "dudu-world-prologue-v1";

export interface LocalCreativeProductionPanelCandidate {
  sourcePanelId: string;
  index: number;
  title: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  shotComposition: string;
  visualAction: string;
  filmingMethod: string;
  soundAndText: string;
  prompt: string;
  promptSha256: string;
  sourceSpan: {
    relativePath: string;
    startOffsetUtf16: number;
    endOffsetUtf16: number;
    surfaceSha256: string;
  };
  sourceDeclaredReferencePaths: string[];
}

export interface LocalCreativeProductionUnitCandidate {
  candidateId: string;
  sourceUnitId: string;
  season: string;
  episode: string;
  sequence: number;
  title: string;
  durationSeconds: number;
  scriptRelativePath: string;
  scriptSha256: string;
  panels: LocalCreativeProductionPanelCandidate[];
  existingBoard?: {
    rawRelativePath?: string;
    rawSha256?: string;
    labeledRelativePath?: string;
    labeledSha256?: string;
  };
  fingerprint: string;
}

export interface LocalCreativeProductionUnitPreview {
  schemaVersion: 1;
  kind: "local-creative-production-unit-preview";
  applicability: "eligible" | "blocked" | "not-applicable";
  adapterId: "dudu-world-prologue-v1" | "none";
  adapterVersion: 1;
  projectRoot: string;
  sourceRoot?: string;
  scopeId: string;
  sourceFingerprint?: string;
  sourceFiles?: number;
  sourceBytes?: number;
  evidence: Array<{ relativePath: string; sha256: string }>;
  units: LocalCreativeProductionUnitCandidate[];
  unitCount: number;
  panelCount: number;
  reasonCode?: string;
  reason?: string;
  fingerprint: string;
  builtAt: string;
}

export interface LocalCreativeProductionUnitPreviewInput {
  scopeId?: string;
  adapterKind?: LocalCreativeProductionAdapterKind;
  expectedSourceFingerprint?: string;
}

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_TASK_BYTES = 16 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_UNITS = 300;
const MAX_TASK_FRAMES = MAX_PREVIEW_UNITS * 6;
const MAX_PROMPT_CHARACTERS = 40_000;
const MAX_REFERENCES_PER_FRAME = 100;
const MAX_REFERENCE_PATH_CHARACTERS = 4_096;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, normalize(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalize(value)), "utf8").digest("hex");
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function safeRead(root: string, relativePath: string, maxBytes: number): Promise<Buffer> {
  const rootReal = await realpath(root);
  const target = path.resolve(rootReal, relativePath);
  const targetReal = await realpath(target);
  const relative = path.relative(rootReal, targetReal);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`来源证据越界：${relativePath}`);
  }
  const metadata = await lstat(targetReal);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
    throw new Error(`来源证据不是有界普通文件：${relativePath}`);
  }
  return readFile(targetReal);
}

async function optionalEvidenceFile(
  root: string,
  relativePath: string,
): Promise<{ relativePath: string; sha256: string } | undefined> {
  try {
    const bytes = await safeRead(root, relativePath, 512 * 1024 * 1024);
    return { relativePath, sha256: sha256(bytes) };
  } catch {
    return undefined;
  }
}

function parsedJson(bytes: Buffer, label: string): Record<string, unknown> {
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 不是 JSON 对象。`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串。`);
  return value.trim();
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((entry) => entry.trim());
}

function seconds(value: string, label: string): number {
  const match = /^(\d+(?:\.\d+)?)s$/iu.exec(value.trim());
  if (!match) throw new Error(`${label} 时长格式无效：${value}`);
  const result = Number(match[1]);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${label} 时长必须大于 0。`);
  return result;
}

interface DuduScriptUnit {
  sourceUnitId: string;
  title: string;
  sequence: number;
  durationSeconds: number;
  rows: Array<{
    gridId: string;
    durationSeconds: number;
    shotComposition: string;
    visualAction: string;
    filmingMethod: string;
    soundAndText: string;
    startOffsetUtf16: number;
    endOffsetUtf16: number;
    surfaceSha256: string;
  }>;
}

function parseDuduScript(body: string): DuduScriptUnit[] {
  const headerPattern = /^## (W\d{2})｜([^｜]+)｜[^｜]+｜(\d+) 格\s*$/gmu;
  const headers = [...body.matchAll(headerPattern)];
  if (headers.length > MAX_PREVIEW_UNITS) {
    throw new Error(`分镜单元数量超过上限 ${MAX_PREVIEW_UNITS}。`);
  }
  const units: DuduScriptUnit[] = [];
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]!;
    const sourceUnitId = header[1]!;
    const title = header[2]!.trim();
    const expectedPanels = Number(header[3]);
    const sectionStart = header.index! + header[0].length;
    const sectionEnd = headers[index + 1]?.index ?? body.length;
    const section = body.slice(sectionStart, sectionEnd);
    const rows = [];
    let cursorSeconds = 0;
    let searchOffset = sectionStart;
    for (const line of section.split(/\r?\n/u)) {
      const cells = splitTableRow(line);
      if (cells.length !== 6 || !/^G\d+$/u.test(cells[0] ?? "")) {
        searchOffset += line.length + 1;
        continue;
      }
      const lineStart = body.indexOf(line, searchOffset);
      if (lineStart < 0) throw new Error(`${sourceUnitId} 表格原文偏移无法定位。`);
      const lineEnd = lineStart + line.length;
      const durationSeconds = seconds(cells[1]!, `${sourceUnitId}/${cells[0]}`);
      rows.push({
        gridId: cells[0]!,
        durationSeconds,
        shotComposition: cells[2]!,
        visualAction: cells[3]!,
        filmingMethod: cells[4]!,
        soundAndText: cells[5]!,
        startOffsetUtf16: lineStart,
        endOffsetUtf16: lineEnd,
        surfaceSha256: sha256(body.slice(lineStart, lineEnd)),
      });
      cursorSeconds += durationSeconds;
      searchOffset = lineEnd;
    }
    if (rows.length !== expectedPanels || rows.length < 2 || rows.length > 6) {
      throw new Error(`${sourceUnitId} 声明 ${expectedPanels} 格，实际解析 ${rows.length} 格。`);
    }
    if (cursorSeconds > 15) throw new Error(`${sourceUnitId} 总时长超过 15 秒。`);
    units.push({
      sourceUnitId,
      title,
      sequence: index + 1,
      durationSeconds: cursorSeconds,
      rows,
    });
  }
  if (!units.length) throw new Error("未从嘟嘟分镜剧本解析到任何 Wxx 单元。");
  return units;
}

interface DuduTaskFrame {
  id: string;
  unit: string;
  grid: string;
  prompt: string;
  referencedImagePaths: string[];
}

function parseDuduTaskFrames(value: Record<string, unknown>): DuduTaskFrame[] {
  const rawFrames = value.frames;
  if (!Array.isArray(rawFrames)) throw new Error("逐格任务清单缺少 frames。");
  if (rawFrames.length > MAX_TASK_FRAMES) {
    throw new Error(`逐格任务帧数量超过上限 ${MAX_TASK_FRAMES}。`);
  }
  const frames = rawFrames.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`frames[${index}] 不是对象。`);
    const item = raw as Record<string, unknown>;
    const prompt = requiredString(item.prompt, `frames[${index}].prompt`);
    if (prompt.length > MAX_PROMPT_CHARACTERS) {
      throw new Error(`frames[${index}].prompt 超过 ${MAX_PROMPT_CHARACTERS} 字符上限。`);
    }
    const rawReferencePaths = item.referenced_image_paths;
    if (rawReferencePaths !== undefined && !Array.isArray(rawReferencePaths)) {
      throw new Error(`frames[${index}].referenced_image_paths 必须是数组。`);
    }
    if (Array.isArray(rawReferencePaths) && rawReferencePaths.length > MAX_REFERENCES_PER_FRAME) {
      throw new Error(`frames[${index}].referenced_image_paths 超过 ${MAX_REFERENCES_PER_FRAME} 项上限。`);
    }
    const referencedImagePaths = (rawReferencePaths ?? []).map((entry, referenceIndex) => {
      const referencePath = requiredString(
        entry,
        `frames[${index}].referenced_image_paths[${referenceIndex}]`,
      );
      if (referencePath.length > MAX_REFERENCE_PATH_CHARACTERS) {
        throw new Error(
          `frames[${index}].referenced_image_paths[${referenceIndex}] 超过 ${MAX_REFERENCE_PATH_CHARACTERS} 字符上限。`,
        );
      }
      return referencePath;
    });
    return {
      id: requiredString(item.id, `frames[${index}].id`),
      unit: requiredString(item.unit, `frames[${index}].unit`),
      grid: requiredString(item.grid, `frames[${index}].grid`),
      prompt,
      referencedImagePaths,
    };
  });
  if (Number(value.total) !== frames.length) throw new Error("逐格任务清单 total 与 frames 数量不一致。");
  if (new Set(frames.map((frame) => frame.id)).size !== frames.length) throw new Error("逐格任务清单含重复 frame id。");
  return frames;
}

async function duduPreview(input: {
  projectRoot: string;
  sourceRoot: string;
  layers: LocalCreativeSourceInventoryLayer[];
  scopeId: string;
}): Promise<LocalCreativeProductionUnitPreview> {
  const taskRelativePath = "02_BindingSet/00_逐格任务清单.json";
  const scriptRelativePath = "01_分镜宫格故事版剧本.md";
  const inventoryBefore = await inspectLocalCreativeSourceInventory(input.layers, { cache: false });
  const [taskBytes, scriptBytes] = await Promise.all([
    safeRead(input.sourceRoot, taskRelativePath, MAX_TASK_BYTES),
    safeRead(input.sourceRoot, scriptRelativePath, MAX_SCRIPT_BYTES),
  ]);
  const scriptBody = scriptBytes.toString("utf8");
  const scriptSha256 = sha256(scriptBytes);
  const frames = parseDuduTaskFrames(parsedJson(taskBytes, "逐格任务清单"));
  const scriptUnits = parseDuduScript(scriptBody);
  const units: LocalCreativeProductionUnitCandidate[] = [];
  for (const scriptUnit of scriptUnits) {
    const taskFrames = frames
      .filter((frame) => frame.unit === scriptUnit.sourceUnitId)
      .sort((left, right) => left.grid.localeCompare(right.grid, "en"));
    if (taskFrames.length !== scriptUnit.rows.length) {
      throw new Error(`${scriptUnit.sourceUnitId} 剧本格数与任务清单不一致。`);
    }
    let startSeconds = 0;
    const panels = scriptUnit.rows.map((row, panelIndex): LocalCreativeProductionPanelCandidate => {
      const frame = taskFrames[panelIndex];
      const normalizedGrid = `G${row.gridId.replace(/^G/u, "").padStart(2, "0")}`;
      const expectedId = `${scriptUnit.sourceUnitId}_${normalizedGrid}`;
      if (!frame || frame.grid !== normalizedGrid || frame.id !== expectedId) {
        throw new Error(`${scriptUnit.sourceUnitId}/${row.gridId} 与任务清单身份不一致。`);
      }
      const endSeconds = startSeconds + row.durationSeconds;
      const panel: LocalCreativeProductionPanelCandidate = {
        sourcePanelId: frame.id,
        index: panelIndex + 1,
        title: `${scriptUnit.sourceUnitId} ${row.gridId}`,
        startSeconds,
        endSeconds,
        durationSeconds: row.durationSeconds,
        shotComposition: row.shotComposition,
        visualAction: row.visualAction,
        filmingMethod: row.filmingMethod,
        soundAndText: row.soundAndText,
        prompt: frame.prompt,
        promptSha256: sha256(frame.prompt),
        sourceSpan: {
          relativePath: scriptRelativePath,
          startOffsetUtf16: row.startOffsetUtf16,
          endOffsetUtf16: row.endOffsetUtf16,
          surfaceSha256: row.surfaceSha256,
        },
        sourceDeclaredReferencePaths: frame.referencedImagePaths,
      };
      startSeconds = endSeconds;
      return panel;
    });
    const boardRawRelativePath = `05_宫格故事板/${scriptUnit.sourceUnitId}_宫格_raw.png`;
    const boardLabeledRelativePath = `05_宫格故事板/${scriptUnit.sourceUnitId}_宫格_labeled.png`;
    const [raw, labeled] = await Promise.all([
      optionalEvidenceFile(input.sourceRoot, boardRawRelativePath),
      optionalEvidenceFile(input.sourceRoot, boardLabeledRelativePath),
    ]);
    const unitBody = {
      candidateId: `local-dudu-world-prologue-${scriptUnit.sourceUnitId}`,
      sourceUnitId: scriptUnit.sourceUnitId,
      season: "WORLD",
      episode: "PROLOGUE",
      sequence: scriptUnit.sequence,
      title: scriptUnit.title,
      durationSeconds: scriptUnit.durationSeconds,
      scriptRelativePath,
      scriptSha256,
      panels,
      ...((raw || labeled) ? {
        existingBoard: {
          ...(raw ? { rawRelativePath: raw.relativePath, rawSha256: raw.sha256 } : {}),
          ...(labeled ? { labeledRelativePath: labeled.relativePath, labeledSha256: labeled.sha256 } : {}),
        },
      } : {}),
    };
    units.push({ ...unitBody, fingerprint: digest(unitBody) });
  }
  if (frames.length !== units.reduce((sum, unit) => sum + unit.panels.length, 0)) {
    throw new Error("逐格任务清单存在未被分镜剧本覆盖的 frame。");
  }
  const inventoryAfter = await inspectLocalCreativeSourceInventory(input.layers, { cache: false });
  if (inventoryAfter.fingerprint !== inventoryBefore.fingerprint) {
    throw new Error("SOURCE_RACE_DETECTED：生成单元预览期间来源目录发生变化，请重新预览。");
  }
  const evidence = [
    { relativePath: taskRelativePath, sha256: sha256(taskBytes) },
    { relativePath: scriptRelativePath, sha256: scriptBytes.length ? scriptSha256 : "" },
  ];
  if (!evidence.every((entry) => SHA256_PATTERN.test(entry.sha256))) throw new Error("单元预览证据 SHA 无效。");
  const body = {
    schemaVersion: 1 as const,
    kind: "local-creative-production-unit-preview" as const,
    applicability: "eligible" as const,
    adapterId: "dudu-world-prologue-v1" as const,
    adapterVersion: 1 as const,
    projectRoot: input.projectRoot,
    sourceRoot: input.sourceRoot,
    scopeId: input.scopeId,
    sourceFingerprint: inventoryAfter.fingerprint,
    sourceFiles: inventoryAfter.totalFiles,
    sourceBytes: inventoryAfter.totalBytes,
    evidence,
    units,
    unitCount: units.length,
    panelCount: units.reduce((sum, unit) => sum + unit.panels.length, 0),
  };
  return { ...body, fingerprint: digest(body), builtAt: new Date().toISOString() };
}

export async function previewLocalCreativeProductionUnits(
  projectRoot: string,
  query: LocalCreativeProductionUnitPreviewInput = {},
): Promise<LocalCreativeProductionUnitPreview> {
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const manifestBytes = await safeRead(shell.paths.root, ".aicanvas/local-creative-project-ingest.json", MAX_MANIFEST_BYTES);
  const manifest = parsedJson(manifestBytes, "local creative ingest manifest");
  const sourceLayers = manifest.sourceLayers;
  if (!Array.isArray(sourceLayers) || !sourceLayers.length) throw new Error("本机项目缺少 sourceLayers。");
  const layers: LocalCreativeSourceInventoryLayer[] = sourceLayers.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`sourceLayers[${index}] 无效。`);
    const layer = raw as Record<string, unknown>;
    const rootPath = requiredString(layer.root, `sourceLayers[${index}].root`);
    if (!path.isAbsolute(rootPath)) throw new Error(`sourceLayers[${index}].root 必须是绝对路径。`);
    return {
      role: requiredString(layer.role, `sourceLayers[${index}].role`),
      rootPath,
      ...(typeof layer.maxDepth === "number" ? { maxDepth: layer.maxDepth } : {}),
      ...(Array.isArray(layer.excludeRelativePrefixes)
        ? { excludeRelativePrefixes: layer.excludeRelativePrefixes.filter((entry): entry is string => typeof entry === "string") }
        : {}),
    };
  });
  const scopeId = query.scopeId?.trim() || "world-prologue";
  const adapterKind = query.adapterKind ?? "auto";
  const duduLayer = layers.find((layer) => (
    path.basename(layer.rootPath).includes("世界观概念序章")
  ));
  if ((adapterKind === "auto" || adapterKind === "dudu-world-prologue-v1") && duduLayer) {
    const preview = await duduPreview({
      projectRoot: shell.paths.root,
      sourceRoot: await realpath(duduLayer.rootPath),
      layers,
      scopeId,
    });
    if (query.expectedSourceFingerprint
      && query.expectedSourceFingerprint !== preview.sourceFingerprint) {
      throw new Error("SOURCE_FINGERPRINT_CONFLICT：来源已变化，请丢弃旧预览后重新读取。");
    }
    return preview;
  }
  const project = manifest.project as Record<string, unknown> | undefined;
  const projectType = typeof project?.type === "string" ? project.type : "";
  const applicability = /asset|visual|library|bible/iu.test(projectType)
    ? "not-applicable" as const
    : "blocked" as const;
  const body = {
    schemaVersion: 1 as const,
    kind: "local-creative-production-unit-preview" as const,
    applicability,
    adapterId: "none" as const,
    adapterVersion: 1 as const,
    projectRoot: shell.paths.root,
    scopeId,
    evidence: [],
    units: [],
    unitCount: 0,
    panelCount: 0,
    reasonCode: applicability === "not-applicable" ? "TIMELINE_NOT_APPLICABLE" : "NO_VERIFIED_UNIT_ADAPTER",
    reason: applicability === "not-applicable"
      ? "该项目类型不适用剧情时间线。"
      : "尚无与当前来源证据匹配的受管单元适配器；禁止根据文件名猜测。",
  };
  return { ...body, fingerprint: digest(body), builtAt: new Date().toISOString() };
}
