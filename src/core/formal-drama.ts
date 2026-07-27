import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const EPISODE_FILE_PATTERN = /^封神篇_EP(\d{1,3})(?:_([^/]+))?\.md$/u;
const SHOT_HEADING_PATTERN = /^\*\*镜(\d{1,3}[A-Z]?)\s*\[(\d+(?:\.\d+)?)s\]\*\*(?:\s*(.*))?\s*$/iu;
const FRAME_RATE_HEADER_PATTERN = /帧率|frame\s*rate|fps/iu;

export interface FormalDramaFileDigest {
  relativePath: string;
  bytes: number;
  sha256: string;
  kind: "episode-markdown" | "reference-png" | "other";
}

export interface FormalDramaSourceInventory {
  algorithm: "sha256-relative-path-bytes-content-v1";
  aggregateSha256: string;
  files: FormalDramaFileDigest[];
  totalBytes: number;
}

export interface FormalDramaSpecification {
  raw: string;
  aspectRatio?: string;
  declaredShotCount?: number;
  declaredDurationSeconds?: number;
  shotDurationRangeSeconds?: { minimum: number; maximum: number };
}

export interface FormalDramaShot {
  /** 原稿镜号，例如 03A。 */
  number: string;
  sourceCode: string;
  sequence: number;
  durationSeconds: number;
  /** 参数表帧率；fps 是面向编排脚本的稳定字段名。 */
  fps?: number;
  fpsSource: "parameter-table" | "body" | "default-24";
  title: string;
  heading: string;
  body: string;
  frameRate?: number;
  parameters: Record<string, string>;
}

export interface FormalDramaEpisode {
  number: number;
  episodeNumber: number;
  episodeCode: string;
  title: string;
  sourceFile: string;
  sourceBytes: number;
  sourceSha256: string;
  specification: FormalDramaSpecification;
  shots: FormalDramaShot[];
  totalDurationSeconds: number;
  warnings: string[];
}

export interface FormalDramaSourceInspection {
  schemaVersion: 1;
  sourceRoot: string;
  readOnly: true;
  sourceNativeMedia: false;
  inventory: FormalDramaSourceInventory;
  episodes: FormalDramaEpisode[];
}

export interface FormalDramaSnapshotFile extends FormalDramaFileDigest {
  snapshotRelativePath: string;
}

export interface FormalDramaMaterializedUnit {
  id: string;
  directory: string;
  infoPath: string;
  episodeNumber: number;
  number: string;
  sourceShotCode: string;
  sequence: number;
  durationSeconds: number;
  fps?: number;
  frameRate?: number;
  fpsSource: FormalDramaShot["fpsSource"];
  title: string;
  heading: string;
  sourceMarkdownRelativePath: string;
  sourceMarkdownSha256: string;
  sourceNativeMedia: false;
  derivedMediaGenerated: boolean;
}

export interface FormalDramaSourceManifest {
  schemaVersion: 1;
  kind: "formal-drama-source-materialization";
  createdAt: string;
  source: {
    root: string;
    readOnly: true;
    inventory: FormalDramaSourceInventory;
  };
  target: {
    root: string;
    manifestPath: string;
    sourceSnapshotRoot: string;
  };
  selectedEpisodes: number[];
  snapshotFiles: FormalDramaSnapshotFile[];
  units: FormalDramaMaterializedUnit[];
  sourceNativeMedia: false;
  derivedMedia: {
    rawImagesGenerated: boolean;
    labeledImagesGenerated: boolean;
    videosGenerated: boolean;
    audioGenerated: boolean;
  };
}

export interface FormalDramaMaterializationResult {
  manifest: FormalDramaSourceManifest;
  episodes: FormalDramaEpisode[];
}

export interface MaterializeFormalDramaProjectOptions {
  sourceRoot: string;
  targetRoot: string;
  episodes: number[];
}

interface TableRow {
  values: Record<string, string>;
  frameRate?: number;
}

function normalizeShotCode(value: string): string | undefined {
  const match = value.trim().toUpperCase().match(/^(\d{1,3})([A-Z]?)$/u);
  if (!match?.[1]) return undefined;
  return `${match[1].padStart(2, "0")}${match[2] ?? ""}`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function portableRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function parseFrameRate(value: string | undefined): number | undefined {
  const match = value?.match(/(\d+(?:\.\d+)?)\s*(?:fps|帧)?/iu);
  return match?.[1] ? Number(match[1]) : undefined;
}

function parseParameterTables(lines: string[]): Map<string, TableRow> {
  const rows = new Map<string, TableRow>();
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!lines[index]?.trim().startsWith("|") || !isTableSeparator(lines[index + 1] ?? "")) continue;
    const headers = splitTableRow(lines[index] ?? "");
    const shotIndex = headers.findIndex((header) => /^(?:镜|镜号)$/u.test(header));
    const frameRateIndex = headers.findIndex((header) => FRAME_RATE_HEADER_PATTERN.test(header));
    if (shotIndex < 0) continue;
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const line = lines[rowIndex] ?? "";
      if (!line.trim().startsWith("|")) break;
      const cells = splitTableRow(line);
      const sourceCode = normalizeShotCode(cells[shotIndex] ?? "");
      if (!sourceCode) continue;
      const values: Record<string, string> = {};
      headers.forEach((header, cellIndex) => {
        values[header] = cells[cellIndex] ?? "";
      });
      rows.set(sourceCode, { values, frameRate: frameRateIndex < 0 ? undefined : parseFrameRate(cells[frameRateIndex]) });
    }
  }
  return rows;
}

function trimShotBody(lines: string[]): string {
  const trimmed = [...lines];
  while (trimmed.length && !trimmed[0]?.trim()) trimmed.shift();
  while (trimmed.length && (!trimmed.at(-1)?.trim() || trimmed.at(-1)?.trim() === "---")) trimmed.pop();
  return trimmed.join("\n").trim();
}

function plainText(value: string): string {
  return value
    .replace(/\*\*/gu, "")
    .replace(/^[>\s]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function deriveShotTitle(body: string, headingRemainder: string): string {
  const explicit = plainText(headingRemainder);
  if (explicit && !/^(?:画面|光线|音效|台词|钩子|生成注记)[：:]/u.test(explicit)) return explicit;
  const source = plainText(explicit || body).replace(/^(?:画面|镜头)[：:]\s*/u, "");
  const firstSentence = source.split(/[。！？｜]/u)[0]?.trim();
  return firstSentence || "未命名镜头";
}

function bodyFrameRate(body: string): number | undefined {
  return parseFrameRate(body.match(/(?:^|[^\d])(\d+(?:\.\d+)?)\s*(?:fps|帧)(?!镜)/iu)?.[1]);
}

function parseSpecification(markdown: string): FormalDramaSpecification {
  const raw = markdown.match(/^>\s*\*\*规格\*\*[：:]\s*(.+)$/mu)?.[1]?.trim() ?? "";
  const aspectRatio = raw.match(/\b(\d+\s*:\s*\d+)\b/u)?.[1]?.replace(/\s+/gu, "");
  const declaredShotCount = Number(raw.match(/(?:共\s*)?(\d+)\s*镜/u)?.[1] ?? "") || undefined;
  const parenthesizedSeconds = raw.match(/[（(]\s*(\d+)\s*秒\s*[）)]/u)?.[1];
  const minuteDuration = raw.match(/(\d+)\s*分(?:钟)?\s*(\d+)?\s*秒?/u);
  const plainDuration = raw.match(/(?:约|总时长)\s*(\d+)\s*秒/u)?.[1];
  const declaredDurationSeconds = parenthesizedSeconds
    ? Number(parenthesizedSeconds)
    : minuteDuration?.[1]
      ? Number(minuteDuration[1]) * 60 + Number(minuteDuration[2] ?? 0)
      : plainDuration
        ? Number(plainDuration)
        : undefined;
  const range = raw.match(/(?:每分镜(?:严格)?|单镜)\s*(\d+)\s*[–—-]\s*(\d+)\s*秒/u);
  return {
    raw,
    aspectRatio,
    declaredShotCount,
    declaredDurationSeconds,
    shotDurationRangeSeconds: range?.[1] && range[2]
      ? { minimum: Number(range[1]), maximum: Number(range[2]) }
      : undefined,
  };
}

/** 纯解析入口；同时兼容常规同行正文与 EP12 的换行正文、字母镜号及“24帧”表格。 */
export function parseFormalDramaEpisodeMarkdown(
  markdown: string | Buffer,
  sourceFile = "formal-drama-episode.md",
): FormalDramaEpisode {
  const sourceBuffer = Buffer.isBuffer(markdown) ? markdown : Buffer.from(markdown, "utf8");
  const content = sourceBuffer.toString("utf8").replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const fileMatch = path.basename(sourceFile).match(EPISODE_FILE_PATTERN);
  const headingMatch = content.match(/^#\s+封神篇\s+EP(\d{1,3})(?:[《「]([^》」\n]+)[》」])?/mu);
  const episodeNumber = Number(fileMatch?.[1] ?? headingMatch?.[1] ?? "");
  if (!Number.isInteger(episodeNumber) || episodeNumber < 1) throw new Error(`${sourceFile} 缺少有效的封神篇 EP 编号。`);
  if (fileMatch?.[1] && headingMatch?.[1] && Number(fileMatch[1]) !== Number(headingMatch[1])) {
    throw new Error(`${sourceFile} 的文件名 EP 编号与正文标题不一致。`);
  }
  const title = headingMatch?.[2]?.trim() || fileMatch?.[2]?.trim() || `第${episodeNumber}集`;
  const lines = content.split("\n");
  const parameterRows = parseParameterTables(lines);
  const parsedShots: Array<Omit<FormalDramaShot, "sequence"> & { headingRemainder: string }> = [];
  let active: { sourceCode: string; durationSeconds: number; headingRemainder: string; body: string[] } | undefined;
  const finishActive = () => {
    if (!active) return;
    const body = trimShotBody(active.body);
    const parameterRow = parameterRows.get(active.sourceCode);
    const explicitBodyFrameRate = bodyFrameRate(body);
    const frameRate = parameterRow?.frameRate ?? explicitBodyFrameRate ?? 24;
    const title = deriveShotTitle(body, active.headingRemainder);
    parsedShots.push({
      number: active.sourceCode,
      sourceCode: active.sourceCode,
      durationSeconds: active.durationSeconds,
      headingRemainder: active.headingRemainder,
      title,
      heading: title,
      body,
      fps: frameRate,
      fpsSource: parameterRow?.frameRate !== undefined
        ? "parameter-table"
        : explicitBodyFrameRate !== undefined
          ? "body"
          : "default-24",
      frameRate,
      parameters: parameterRow?.values ?? {},
    });
    active = undefined;
  };

  for (const line of lines) {
    const heading = line.match(SHOT_HEADING_PATTERN);
    if (heading?.[1] && heading[2]) {
      finishActive();
      active = {
        sourceCode: heading[1].toUpperCase(),
        durationSeconds: Number(heading[2]),
        headingRemainder: heading[3]?.trim() ?? "",
        body: heading[3]?.trim() ? [heading[3].trim()] : [],
      };
      continue;
    }
    if (!active) continue;
    if (/^##\s+/u.test(line)) {
      finishActive();
      continue;
    }
    active.body.push(line);
  }
  finishActive();
  if (!parsedShots.length) throw new Error(`${sourceFile} 没有解析到任何“镜NN [Ns]”分镜。`);
  const seen = new Set<string>();
  for (const shot of parsedShots) {
    if (seen.has(shot.sourceCode)) throw new Error(`${sourceFile} 存在重复镜号 ${shot.sourceCode}。`);
    seen.add(shot.sourceCode);
  }
  const shots: FormalDramaShot[] = parsedShots.map(({ headingRemainder: _headingRemainder, ...shot }, index) => ({
    ...shot,
    sequence: index + 1,
  }));
  const specification = parseSpecification(content);
  const warnings: string[] = [];
  if (specification.declaredShotCount !== undefined && specification.declaredShotCount !== shots.length) {
    warnings.push(`规格声明 ${specification.declaredShotCount} 镜，实际解析 ${shots.length} 镜。`);
  }
  const defaultedFrameRates = shots.filter((shot) => shot.fpsSource === "default-24").map((shot) => shot.sourceCode);
  if (defaultedFrameRates.length) warnings.push(`参数表与正文未给帧率，按制作基线使用 24fps：${defaultedFrameRates.join("、")}。`);
  return {
    number: episodeNumber,
    episodeNumber,
    episodeCode: `EP${String(episodeNumber).padStart(2, "0")}`,
    title,
    sourceFile: path.resolve(sourceFile),
    sourceBytes: sourceBuffer.byteLength,
    sourceSha256: sha256(sourceBuffer),
    specification,
    shots,
    totalDurationSeconds: shots.reduce((sum, shot) => sum + shot.durationSeconds, 0),
    warnings,
  };
}

async function hashRegularFile(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const before = await lstat(filePath);
  if (before.isSymbolicLink()) throw new Error(`禁止符号链接：${filePath}`);
  if (!before.isFile()) throw new Error(`不是常规文件：${filePath}`);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk as Buffer);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`读取期间源文件发生变化：${filePath}`);
  return { bytes: after.size, sha256: digest.digest("hex") };
}

async function canonicalSourceRoot(sourceRoot: string): Promise<string> {
  const absolute = path.resolve(sourceRoot);
  const rootStats = await lstat(absolute).catch(() => undefined);
  if (rootStats?.isSymbolicLink()) throw new Error(`正式剧本源根禁止使用符号链接：${absolute}`);
  if (!rootStats?.isDirectory()) throw new Error(`正式剧本源根不存在或不是目录：${absolute}`);
  const canonical = await realpath(absolute);
  return canonical;
}

async function inventorySource(sourceRoot: string): Promise<FormalDramaSourceInventory> {
  const files: FormalDramaFileDigest[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`正式剧本源内禁止符号链接：${absolutePath}`);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`正式剧本源内存在非常规文件：${absolutePath}`);
      const relativePath = portableRelativePath(sourceRoot, absolutePath);
      const digest = await hashRegularFile(absolutePath);
      const basename = path.basename(relativePath);
      const kind: FormalDramaFileDigest["kind"] = EPISODE_FILE_PATTERN.test(basename) && !relativePath.includes("/")
        ? "episode-markdown"
        : path.extname(relativePath).toLowerCase() === ".png"
          ? "reference-png"
          : "other";
      files.push({ relativePath, ...digest, kind });
    }
  };
  await walk(sourceRoot);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  const aggregate = createHash("sha256");
  for (const file of files) aggregate.update(`${file.relativePath}\0${file.bytes}\0${file.sha256}\n`, "utf8");
  return {
    algorithm: "sha256-relative-path-bytes-content-v1",
    aggregateSha256: aggregate.digest("hex"),
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

/** 只读核验正式剧本根；不会创建侧车、缓存或任何源目录文件。 */
export async function inspectFormalDramaSource(sourceRoot: string): Promise<FormalDramaSourceInspection> {
  const canonicalRoot = await canonicalSourceRoot(sourceRoot);
  const inventory = await inventorySource(canonicalRoot);
  const episodeFiles = inventory.files.filter((file) => file.kind === "episode-markdown");
  if (!episodeFiles.length) throw new Error(`正式剧本源根下没有封神篇_EP*.md：${canonicalRoot}`);
  const episodes = await Promise.all(episodeFiles.map(async (file) => {
    const absolutePath = path.join(canonicalRoot, ...file.relativePath.split("/"));
    const markdown = await readFile(absolutePath);
    const parsed = parseFormalDramaEpisodeMarkdown(markdown, absolutePath);
    if (parsed.sourceSha256 !== file.sha256 || parsed.sourceBytes !== file.bytes) {
      throw new Error(`源剧本读取结果与文件清单不一致：${absolutePath}`);
    }
    return parsed;
  }));
  episodes.sort((left, right) => left.episodeNumber - right.episodeNumber);
  const duplicate = episodes.find((episode, index) => episodes[index - 1]?.episodeNumber === episode.episodeNumber);
  if (duplicate) throw new Error(`源根存在重复集号：${duplicate.episodeCode}`);
  return {
    schemaVersion: 1,
    sourceRoot: canonicalRoot,
    readOnly: true,
    sourceNativeMedia: false,
    inventory,
    episodes,
  };
}

async function assertTargetPath(sourceRoot: string, targetRoot: string): Promise<string> {
  const absolute = path.resolve(targetRoot);
  if (isSameOrInside(absolute, sourceRoot)) throw new Error(`目标目录不得等于或位于只读源根内：${absolute}`);
  if (await lstat(absolute).then(() => true).catch(() => false)) throw new Error(`目标目录必须不存在：${absolute}`);
  const parent = path.dirname(absolute);
  const parentStats = await lstat(parent).catch(() => undefined);
  if (parentStats?.isSymbolicLink()) throw new Error(`目标目录父路径禁止符号链接：${parent}`);
  if (!parentStats?.isDirectory()) throw new Error(`目标目录的直接父目录必须已存在：${parent}`);
  const canonicalParent = await realpath(parent);
  const canonicalTarget = path.join(canonicalParent, path.basename(absolute));
  if (isSameOrInside(canonicalTarget, sourceRoot)) throw new Error(`目标目录解析后位于只读源根内：${absolute}`);
  return canonicalTarget;
}

function safeTitle(value: string): string {
  const normalized = value.normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "")
    .replace(/[\s.]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return [...normalized].slice(0, 36).join("") || "未命名镜头";
}

function unitInformation(
  episode: FormalDramaEpisode,
  shot: FormalDramaShot,
  unit: FormalDramaMaterializedUnit,
  aggregateSha256: string,
): string {
  return [
    `# ${unit.id} ${shot.title}`,
    "",
    `- 集：${episode.episodeCode}《${episode.title}》`,
    `- 原始镜号：${shot.sourceCode}`,
    `- 规范化顺序：${String(shot.sequence).padStart(3, "0")}`,
    `- 时长：${shot.durationSeconds}s`,
    `- 帧率：${shot.frameRate === undefined ? "参数表未提供" : `${shot.frameRate}fps`}`,
    `- 帧率来源：${shot.fpsSource}`,
    `- 源剧本：${unit.sourceMarkdownRelativePath}`,
    `- 源剧本 SHA-256：${unit.sourceMarkdownSha256}`,
    `- 源根聚合 SHA-256：${aggregateSha256}`,
    "- 源生媒体：false",
    "- 衍生媒体已生成：false",
    "",
    "## 镜头正文",
    "",
    shot.body,
    "",
  ].join("\n");
}

/**
 * 将选定集落到全新隔离根。源根始终只读；任一复制/校验失败会删除本次新建目标根。
 */
export async function materializeFormalDramaProject(
  options: MaterializeFormalDramaProjectOptions,
): Promise<FormalDramaMaterializationResult> {
  const sourceRoot = await canonicalSourceRoot(options.sourceRoot);
  const targetRoot = await assertTargetPath(sourceRoot, options.targetRoot);
  const requestedEpisodes = [...new Set(options.episodes)].sort((left, right) => left - right);
  if (!requestedEpisodes.length || requestedEpisodes.some((episode) => !Number.isInteger(episode) || episode < 1)) {
    throw new Error("episodes 必须包含至少一个有效正整数集号。");
  }
  const inspection = await inspectFormalDramaSource(sourceRoot);
  const selectedEpisodes = requestedEpisodes.map((episodeNumber) => {
    const episode = inspection.episodes.find((candidate) => candidate.episodeNumber === episodeNumber);
    if (!episode) throw new Error(`正式剧本源中不存在 EP${String(episodeNumber).padStart(2, "0")}。`);
    return episode;
  });
  let targetCreated = false;
  try {
    await mkdir(targetRoot);
    targetCreated = true;
    const snapshotRoot = path.join(targetRoot, "source_snapshot");
    await mkdir(snapshotRoot);
    const snapshotFiles: FormalDramaSnapshotFile[] = [];
    const snapshotCandidates = inspection.inventory.files.filter((file) =>
      path.extname(file.relativePath).toLowerCase() === ".md" || file.kind === "reference-png",
    );
    for (const sourceFile of snapshotCandidates) {
      const sourcePath = path.join(sourceRoot, ...sourceFile.relativePath.split("/"));
      const snapshotPath = path.join(snapshotRoot, ...sourceFile.relativePath.split("/"));
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await copyFile(sourcePath, snapshotPath);
      const copied = await hashRegularFile(snapshotPath);
      if (copied.bytes !== sourceFile.bytes || copied.sha256 !== sourceFile.sha256) {
        throw new Error(`隔离快照校验失败：${sourceFile.relativePath}`);
      }
      snapshotFiles.push({
        ...sourceFile,
        snapshotRelativePath: portableRelativePath(targetRoot, snapshotPath),
      });
    }

    const units: FormalDramaMaterializedUnit[] = [];
    for (const episode of selectedEpisodes) {
      const sourceRelativePath = portableRelativePath(sourceRoot, episode.sourceFile);
      for (const shot of episode.shots) {
        const id = `${episode.episodeCode}_15s_${String(shot.sequence).padStart(3, "0")}`;
        const directory = path.join(targetRoot, `${id}_${safeTitle(shot.title)}`);
        await mkdir(directory);
        const infoPath = path.join(directory, "00_信息.md");
        const unit: FormalDramaMaterializedUnit = {
          id,
          directory,
          infoPath,
          episodeNumber: episode.episodeNumber,
          number: shot.number,
          sourceShotCode: shot.sourceCode,
          sequence: shot.sequence,
          durationSeconds: shot.durationSeconds,
          fps: shot.fps,
          frameRate: shot.frameRate,
          fpsSource: shot.fpsSource,
          title: shot.title,
          heading: shot.heading,
          sourceMarkdownRelativePath: sourceRelativePath,
          sourceMarkdownSha256: episode.sourceSha256,
          sourceNativeMedia: false,
          derivedMediaGenerated: false,
        };
        await writeFile(infoPath, unitInformation(episode, shot, unit, inspection.inventory.aggregateSha256), "utf8");
        units.push(unit);
      }
    }

    const manifestPath = path.join(targetRoot, "formal-source-manifest.json");
    const manifest: FormalDramaSourceManifest = {
      schemaVersion: 1,
      kind: "formal-drama-source-materialization",
      createdAt: new Date().toISOString(),
      source: { root: sourceRoot, readOnly: true, inventory: inspection.inventory },
      target: { root: targetRoot, manifestPath, sourceSnapshotRoot: snapshotRoot },
      selectedEpisodes: requestedEpisodes,
      snapshotFiles,
      units,
      sourceNativeMedia: false,
      derivedMedia: {
        rawImagesGenerated: false,
        labeledImagesGenerated: false,
        videosGenerated: false,
        audioGenerated: false,
      },
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const finalInventory = await inventorySource(sourceRoot);
    if (finalInventory.aggregateSha256 !== inspection.inventory.aggregateSha256) {
      throw new Error("规范化期间正式剧本源发生变化，已拒绝提交隔离副本。");
    }
    return { manifest, episodes: selectedEpisodes };
  } catch (error) {
    if (targetCreated) await rm(targetRoot, { recursive: true, force: true });
    throw error;
  }
}
