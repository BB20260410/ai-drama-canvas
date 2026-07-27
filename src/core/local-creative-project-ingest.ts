import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export const LOCAL_CREATIVE_SOURCE_LAYER_ROLES = [
  "PRIMARY_AUTHORITY",
  "ACTIVE_PRODUCTION",
  "UPSTREAM_SCRIPT",
  "LEGACY_HISTORY",
  "EXPORT",
  "UNASSIGNED_INBOX",
] as const;

export type LocalCreativeSourceLayerRole = typeof LOCAL_CREATIVE_SOURCE_LAYER_ROLES[number];

export const LOCAL_CREATIVE_FILE_STATUSES = [
  "APPROVED_LOCK",
  "CANDIDATE_LOCK",
  "FORMAL_MEDIA",
  "REJECTED_OR_FORBIDDEN",
  "UNKNOWN",
] as const;

export type LocalCreativeFileStatus = typeof LOCAL_CREATIVE_FILE_STATUSES[number];
export type LocalCreativeMediaKind = "document" | "image" | "video" | "audio";
export type LocalCreativeEvidenceLevel =
  | "declared-mention"
  | "explicit-reference"
  | "review-qc"
  | "exact-sha-copy";

export interface LocalCreativeSourceLayerInput {
  role: LocalCreativeSourceLayerRole;
  rootPath: string;
  label?: string;
  /**
   * 相对 source root 的最大条目深度。1 表示只纳入根目录直属文件，
   * 2 表示再递归一层目录。省略时递归完整来源树。
   */
  maxDepth?: number;
  /**
   * 相对 source root 的 POSIX 路径前缀。命中的文件或目录整棵跳过，
   * 用于防止上游故事根重复吸收已单独建项的嵌套生产工程。
   */
  excludeRelativePrefixes?: string[];
}

export interface LocalCreativeProjectIngestInput {
  projectKey: string;
  projectName: string;
  projectType: string;
  sourceLayers: LocalCreativeSourceLayerInput[];
  /**
   * 默认不哈希，避免只读全机预检无边界消耗。开启后以流式方式计算全部纳入文件的 SHA-256。
   */
  computeSha256?: boolean;
  /**
   * 受调用方信任的实际 SHA。键可为绝对路径、POSIX 相对路径或 `ROLE:相对路径`。
   * 若同时开启 computeSha256，以计算值为准并报告不一致。
   */
  providedSha256ByPath?: Record<string, string>;
  maxParsedTextBytes?: number;
}

export interface LocalCreativeSourceLayerProjection {
  layerId: string;
  role: LocalCreativeSourceLayerRole;
  rootPath: string;
  label?: string;
  fileCount: number;
}

export interface LocalCreativeFileEvidence {
  level: LocalCreativeEvidenceLevel;
  sourceFileId: string;
  sourcePath: string;
  context: string;
  declaredSha256?: string;
}

export interface LocalCreativeIngestFile {
  fileId: string;
  absolutePath: string;
  relativePath: string;
  basename: string;
  extension: string;
  sizeBytes: number;
  mtimeMs: number;
  mtimeIso: string;
  mediaKind: LocalCreativeMediaKind;
  sourceLayer: {
    layerId: string;
    role: LocalCreativeSourceLayerRole;
    rootPath: string;
    label?: string;
  };
  status: LocalCreativeFileStatus;
  sha256?: string;
  sha256Source?: "computed" | "provided";
  evidence: LocalCreativeFileEvidence[];
}

export interface LocalCreativeReference {
  targetFileId: string;
  sourceFileId: string;
  evidenceLevels: LocalCreativeEvidenceLevel[];
  context: string;
  rejected: boolean;
  lockSemantic: boolean;
  explicitApproval: boolean;
  reviewQcPass: boolean;
  exactShaMatch: boolean;
}

export interface LocalCreativeLockCandidate {
  fileId: string;
  absolutePath: string;
  relativePath: string;
  status: "APPROVED_LOCK" | "CANDIDATE_LOCK";
  sourceLayerRole: LocalCreativeSourceLayerRole;
  evidenceLevels: LocalCreativeEvidenceLevel[];
}

export interface LocalCreativeLockReferenceIndexEntry {
  lockFileId: string;
  lockPath: string;
  status: "APPROVED_LOCK" | "CANDIDATE_LOCK";
  referencedBy: Array<{
    fileId: string;
    path: string;
    evidenceLevels: LocalCreativeEvidenceLevel[];
  }>;
}

export type LocalCreativeIngestWarning =
  | {
      code: "SYMLINK_SKIPPED";
      path: string;
      message: string;
    }
  | {
      code: "UNREADABLE_ENTRY";
      path: string;
      message: string;
    }
  | {
      code: "AMBIGUOUS_BASENAME_REFERENCE";
      path: string;
      basename: string;
      candidatePaths: string[];
      message: string;
    }
  | {
      code: "SHA_MISMATCH";
      path: string;
      sourcePath: string;
      expectedSha256: string;
      actualSha256: string;
      message: string;
    }
  | {
      code: "PROVIDED_SHA_MISMATCH";
      path: string;
      providedSha256: string;
      computedSha256: string;
      message: string;
    }
  | {
      code: "STALE_LEDGER";
      path: string;
      ledgerPath: string;
      fileMtimeMs: number;
      ledgerMtimeMs: number;
      message: string;
    }
  | {
      code: "MEDIA_SIGNATURE_EXTENSION_MISMATCH";
      path: string;
      extension: string;
      extensionKind: Exclude<LocalCreativeMediaKind, "document">;
      detectedKind: Exclude<LocalCreativeMediaKind, "document">;
      detectedSignature: string;
      message: string;
    }
  | {
      code: "MEDIA_SIGNATURE_INVALID";
      path: string;
      extension: string;
      extensionKind: Exclude<LocalCreativeMediaKind, "document">;
      detectedSignature: string;
      message: string;
    };

export interface LocalCreativeIngestStatistics {
  totalFiles: number;
  totalBytes: number;
  parsedTextFiles: number;
  skippedSymlinks: number;
  referenceCount: number;
  byMediaKind: Record<LocalCreativeMediaKind, number>;
  byStatus: Record<LocalCreativeFileStatus, number>;
  bySourceLayerRole: Record<LocalCreativeSourceLayerRole, number>;
}

export interface LocalCreativeProjectIngestPreview {
  schemaVersion: 1;
  kind: "local-creative-project-ingest-preview";
  project: {
    key: string;
    name: string;
    type: string;
  };
  sourceLayers: LocalCreativeSourceLayerProjection[];
  files: LocalCreativeIngestFile[];
  references: LocalCreativeReference[];
  lockCandidates: LocalCreativeLockCandidate[];
  lockReferenceIndex: LocalCreativeLockReferenceIndexEntry[];
  warnings: LocalCreativeIngestWarning[];
  statistics: LocalCreativeIngestStatistics;
  previewFingerprint: string;
  scannedAt: string;
  readOnly: true;
}

interface MutableFile extends LocalCreativeIngestFile {
  parsedText?: string;
  pathCandidateLock: boolean;
  pathRejected: boolean;
  pathFormalMedia: boolean;
  integrityConflict: boolean;
  mediaSignatureRejected: boolean;
}

interface ReferenceSignal {
  reference: LocalCreativeReference;
  evidence: LocalCreativeFileEvidence[];
}

const DEFAULT_MAX_PARSED_TEXT_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHA256_IN_CONTEXT_PATTERN = /\b[a-f0-9]{64}\b/giu;
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json"]);
const DOCUMENT_EXTENSIONS = new Set([".md", ".txt", ".json", ".docx", ".pdf"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".avif", ".svg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv", ".avi"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"]);
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".aicanvas",
  "node_modules",
  "cache",
  "caches",
  "tmp",
  "temp",
  "__pycache__",
]);
const LEDGER_NAME_PATTERN = /(?:^|[_\-\s])(status|tasks|ledger|manifest|index)(?:[_\-\s.]|$)|状态|账本|索引|清单|总表/iu;
const PATH_REJECT_PATTERN = /(?:^|[/_.\-\s])(rejected?|unapproved|forbidden|deprecated|discarded?)(?:[/_.\-\s]|$)|废稿|拒绝|禁用|禁止使用|未批准|淘汰/iu;
const PATH_LOCK_CANDIDATE_PATTERN = /(?:^|[/_.\-\s])(lock(?:ed)?|authority|authoritative|canonical|approved|final)(?:[/_.\-\s]|$)|锁定|权威|母版|定稿|三视图|角色卡|设定卡|参考图|场景锁|道具锁/iu;
const PATH_FORMAL_MEDIA_PATTERN = /(?:^|[/_.\-\s])(raw|labeled|formal|storyboard|output|export|pass)(?:[/_.\-\s]|$)|正式|成片|分镜|故事板|已生成|通过版/iu;
const CONTEXT_REJECT_PATTERN = /\b(?:rejected?|unapproved|forbidden|deprecated|discarded?)\b|未批准|未通过|拒绝|废稿|禁用|禁止(?:使用|引用|入画)?|淘汰/iu;
const CONTEXT_APPROVED_PATTERN = /\bAPPROVED_LOCK\b|\bstatus\s*[:=：]\s*["']?approved(?:_lock)?\b|状态\s*[:=：]?\s*(?:已)?(?:批准|通过)|用户(?:已)?(?:批准|确认)|唯一权威|永久只读母版|验收通过|审核通过/iu;
const CONTEXT_LOCK_PATTERN = /\b(?:lock(?:ed)?|hard[\s_-]?lock|canonical|authority|authoritative|approved)\b|锁定|硬锁|权威|母版|定稿|三视图|角色卡|场景锁|道具锁|参考资产/iu;
const CONTEXT_REFERENCE_PATTERN = /\b(?:reference|ref|source|asset|file|path)\b|引用|参考|来源|资产|文件|路径|锁图/iu;
const CONTEXT_REVIEW_PATTERN = /\b(?:review|qc|acceptance|approved)\b|审核|审片|验收|质检|人工确认/iu;
const CONTEXT_PASS_PATTERN = /\b(?:pass(?:ed)?|approved|accept(?:ed)?)\b|通过|批准|确认/iu;

function normalizedRelative(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function normalizedLookup(value: string): string {
  return value.normalize("NFKC").replaceAll("\\", "/").toLocaleLowerCase("en-US");
}

function mediaKindForExtension(extension: string): LocalCreativeMediaKind | null {
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  return null;
}

interface SniffedMediaSignature {
  kind: Exclude<LocalCreativeMediaKind, "document"> | null;
  signature: string;
}

async function sniffMediaSignature(filePath: string): Promise<SniffedMediaSignature> {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { kind: "image", signature: "png" };
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return { kind: "image", signature: "jpeg" };
    }
    if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) {
      return { kind: "image", signature: "gif" };
    }
    if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF") {
      const form = bytes.subarray(8, 12).toString("ascii");
      if (form === "WEBP") return { kind: "image", signature: "webp" };
      if (form === "WAVE") return { kind: "audio", signature: "wav" };
      if (form === "AVI ") return { kind: "video", signature: "avi" };
    }
    if (bytes.length >= 2 && bytes.subarray(0, 2).toString("ascii") === "BM") {
      return { kind: "image", signature: "bmp" };
    }
    if (bytes.length >= 4) {
      const tiff = bytes.subarray(0, 4);
      if (tiff.equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || tiff.equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) {
        return { kind: "image", signature: "tiff" };
      }
      if (tiff.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { kind: "video", signature: "ebml" };
      if (bytes.subarray(0, 4).toString("ascii") === "fLaC") return { kind: "audio", signature: "flac" };
      if (bytes.subarray(0, 4).toString("ascii") === "OggS") return { kind: "audio", signature: "ogg" };
    }
    if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
      const brands = bytes.subarray(8, Math.min(bytes.length, 40)).toString("ascii").toLocaleLowerCase("en-US");
      if (/(?:avif|avis|heic|heix|hevc|hevx|mif1|msf1)/u.test(brands)) return { kind: "image", signature: "isobmff-image" };
      if (/(?:m4a |m4b |m4p |f4a |mp4a)/u.test(brands)) return { kind: "audio", signature: "isobmff-audio" };
      return { kind: "video", signature: "isobmff-video" };
    }
    if (bytes.length >= 3 && bytes.subarray(0, 3).toString("ascii") === "ID3") return { kind: "audio", signature: "id3" };
    if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return { kind: "audio", signature: "mpeg-or-adts-audio" };

    const textPrefix = bytes.toString("utf8").replace(/^\uFEFF/u, "").trimStart().toLocaleLowerCase("en-US");
    if (/^(?:<\?xml[\s\S]*?\?>\s*)?<svg(?:\s|>)/u.test(textPrefix)) return { kind: "image", signature: "svg" };
    if (textPrefix.startsWith("<?xml") || textPrefix.startsWith("<html") || textPrefix.startsWith("<!doctype")) {
      return { kind: null, signature: "xml-or-html" };
    }
    return { kind: null, signature: "unknown" };
  } finally {
    await handle.close();
  }
}

function mediaSignatureMatchesExtension(extension: string, signature: string): boolean {
  const compatibleSignatures: Record<string, string[]> = {
    ".png": ["png"],
    ".jpg": ["jpeg"],
    ".jpeg": ["jpeg"],
    ".gif": ["gif"],
    ".webp": ["webp"],
    ".bmp": ["bmp"],
    ".tif": ["tiff"],
    ".tiff": ["tiff"],
    ".heic": ["isobmff-image"],
    ".avif": ["isobmff-image"],
    ".svg": ["svg"],
    ".mp4": ["isobmff-video"],
    ".mov": ["isobmff-video"],
    ".m4v": ["isobmff-video"],
    ".webm": ["ebml"],
    ".mkv": ["ebml"],
    ".avi": ["avi"],
    ".wav": ["wav"],
    ".mp3": ["id3", "mpeg-or-adts-audio"],
    ".m4a": ["isobmff-audio"],
    ".aac": ["mpeg-or-adts-audio"],
    ".flac": ["flac"],
    ".ogg": ["ogg"],
  };
  return compatibleSignatures[extension]?.includes(signature) ?? false;
}

function emptyRoleCounts(): Record<LocalCreativeSourceLayerRole, number> {
  return Object.fromEntries(LOCAL_CREATIVE_SOURCE_LAYER_ROLES.map((role) => [role, 0])) as Record<LocalCreativeSourceLayerRole, number>;
}

function emptyStatusCounts(): Record<LocalCreativeFileStatus, number> {
  return Object.fromEntries(LOCAL_CREATIVE_FILE_STATUSES.map((status) => [status, 0])) as Record<LocalCreativeFileStatus, number>;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function providedShaFor(
  values: Record<string, string> | undefined,
  role: LocalCreativeSourceLayerRole,
  absolutePath: string,
  relativePath: string,
): string | undefined {
  if (!values) return undefined;
  const candidates = [absolutePath, relativePath, `${role}:${relativePath}`];
  for (const candidate of candidates) {
    const value = values[candidate]?.trim().toLocaleLowerCase("en-US");
    if (value && SHA256_PATTERN.test(value)) return value;
  }
  return undefined;
}

function contextAround(text: string, index: number, length: number): string {
  let start = index;
  let precedingLines = 0;
  while (start > 0 && precedingLines < 3) {
    start -= 1;
    if (text[start] === "\n") precedingLines += 1;
  }
  let end = index + length;
  let followingLines = 0;
  while (end < text.length && followingLines < 6) {
    if (text[end] === "\n") followingLines += 1;
    end += 1;
  }
  return text.slice(start, Math.min(end, start + 2_000)).trim();
}

/**
 * 证据展示可以保留较宽上下文，但批准/拒绝语义只能绑定到目标文件所在的
 * 结构化局部。否则同一验收文档后续“旧 v1 已拒绝”的段落会把前面的当前
 * PASS 表格行一并判成 rejected。
 *
 * - Markdown 表格：只使用命中文件的当前行；
 * - JSON：只使用命中文件的当前行，避免 prompt/其他对象中的 forbidden
 *   文本跨字段污染；
 * - 普通 Markdown/TXT：使用命中行所在的空行分隔段落，并限制前后各三行。
 */
function classificationContextForReference(
  source: MutableFile,
  target: MutableFile,
  context: string,
): string {
  const lines = context.split(/\r?\n/u);
  const needles = [
    path.basename(target.absolutePath),
    target.relativePath,
    target.absolutePath,
  ].map(normalizedLookup);
  const matchedIndexes = lines.flatMap((line, index) => {
    const normalizedLine = normalizedLookup(line);
    return needles.some((needle) => needle && normalizedLine.includes(needle)) ? [index] : [];
  });
  if (!matchedIndexes.length) return context;
  const sourceExtension = path.extname(source.absolutePath).toLocaleLowerCase("en-US");
  const snippets = matchedIndexes.map((index) => {
    const line = lines[index] ?? "";
    if (sourceExtension === ".json" || /^\s*\|/u.test(line)) return line.trim();
    let start = index;
    let end = index;
    while (start > 0 && index - start < 3 && lines[start - 1]?.trim()) start -= 1;
    while (end + 1 < lines.length && end - index < 3 && lines[end + 1]?.trim()) end += 1;
    return lines.slice(start, end + 1).join("\n").trim();
  });
  return [...new Set(snippets.filter(Boolean))].join("\n");
}

function referenceEvidence(
  source: MutableFile,
  target: MutableFile,
  context: string,
  exactRelativePath: boolean,
): ReferenceSignal {
  const classificationContext = classificationContextForReference(source, target, context);
  const rejected = CONTEXT_REJECT_PATTERN.test(classificationContext);
  const explicitApproval = !rejected && CONTEXT_APPROVED_PATTERN.test(classificationContext);
  const lockSemantic = CONTEXT_LOCK_PATTERN.test(classificationContext) || explicitApproval;
  const reviewQcPass = !rejected
    && CONTEXT_REVIEW_PATTERN.test(classificationContext)
    && CONTEXT_PASS_PATTERN.test(classificationContext);
  const explicitReference = exactRelativePath || CONTEXT_REFERENCE_PATTERN.test(classificationContext);
  // 哈希是文件级完整性证据，仍允许从较宽展示上下文读取；只有会改变
  // approved/rejected 语义的自然语言必须限制在目标局部。
  const declaredHashes = [...context.matchAll(SHA256_IN_CONTEXT_PATTERN)]
    .map((match) => match[0].toLocaleLowerCase("en-US"));
  const exactShaMatch = Boolean(target.sha256 && declaredHashes.includes(target.sha256));
  const base: LocalCreativeFileEvidence = {
    level: "declared-mention",
    sourceFileId: source.fileId,
    sourcePath: source.absolutePath,
    context,
  };
  const evidence: LocalCreativeFileEvidence[] = [base];
  if (explicitReference) evidence.push({ ...base, level: "explicit-reference" });
  if (reviewQcPass || explicitApproval) evidence.push({ ...base, level: "review-qc" });
  if (exactShaMatch) evidence.push({ ...base, level: "exact-sha-copy", declaredSha256: target.sha256 });
  return {
    reference: {
      targetFileId: target.fileId,
      sourceFileId: source.fileId,
      evidenceLevels: evidence.map((entry) => entry.level),
      context,
      rejected,
      lockSemantic,
      explicitApproval,
      reviewQcPass,
      exactShaMatch,
    },
    evidence,
  };
}

function determineStatus(file: MutableFile, signals: ReferenceSignal[]): LocalCreativeFileStatus {
  if (file.pathRejected || file.mediaSignatureRejected || signals.some((signal) => signal.reference.rejected)) return "REJECTED_OR_FORBIDDEN";
  const explicitApprovedLock = signals.some((signal) => (
    signal.reference.lockSemantic
    && (signal.reference.explicitApproval || signal.reference.reviewQcPass)
  ));
  if (explicitApprovedLock && !file.integrityConflict) return "APPROVED_LOCK";
  const mentionedAsLock = signals.some((signal) => signal.reference.lockSemantic);
  if (file.pathCandidateLock || mentionedAsLock || (explicitApprovedLock && file.integrityConflict)) return "CANDIDATE_LOCK";
  if (file.mediaKind !== "document" && (
    file.pathFormalMedia
    || file.sourceLayer.role === "ACTIVE_PRODUCTION"
    || file.sourceLayer.role === "EXPORT"
  )) return "FORMAL_MEDIA";
  return "UNKNOWN";
}

function warningSortKey(warning: LocalCreativeIngestWarning): string {
  return `${warning.code}\0${warning.path}\0${"ledgerPath" in warning ? warning.ledgerPath : ""}`;
}

function buildStatistics(files: MutableFile[], warnings: LocalCreativeIngestWarning[], references: LocalCreativeReference[], parsedTextFiles: number): LocalCreativeIngestStatistics {
  const byMediaKind: Record<LocalCreativeMediaKind, number> = { document: 0, image: 0, video: 0, audio: 0 };
  const byStatus = emptyStatusCounts();
  const bySourceLayerRole = emptyRoleCounts();
  for (const file of files) {
    byMediaKind[file.mediaKind] += 1;
    byStatus[file.status] += 1;
    bySourceLayerRole[file.sourceLayer.role] += 1;
  }
  return {
    totalFiles: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    parsedTextFiles,
    skippedSymlinks: warnings.filter((warning) => warning.code === "SYMLINK_SKIPPED").length,
    referenceCount: references.length,
    byMediaKind,
    byStatus,
    bySourceLayerRole,
  };
}

function validateInput(input: LocalCreativeProjectIngestInput): void {
  if (!input.projectKey?.trim()) throw new Error("projectKey 不能为空。");
  if (!input.projectName?.trim()) throw new Error("projectName 不能为空。");
  if (!input.projectType?.trim()) throw new Error("projectType 不能为空。");
  if (!input.sourceLayers.length) throw new Error("至少需要一个 source layer。");
  for (const layer of input.sourceLayers) {
    if (!LOCAL_CREATIVE_SOURCE_LAYER_ROLES.includes(layer.role)) throw new Error(`未知 source layer role：${String(layer.role)}`);
    if (!layer.rootPath?.trim()) throw new Error(`${layer.role} 的 rootPath 不能为空。`);
    if (layer.maxDepth !== undefined && (!Number.isInteger(layer.maxDepth) || layer.maxDepth < 1 || layer.maxDepth > 64)) {
      throw new Error(`${layer.role} 的 maxDepth 必须是 1–64 的整数。`);
    }
    for (const prefix of layer.excludeRelativePrefixes ?? []) {
      const normalized = normalizedRelative(prefix.trim()).replace(/^\.\/+/u, "").replace(/\/+$/u, "");
      if (!normalized || normalized === "." || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
        throw new Error(`${layer.role} 的 excludeRelativePrefixes 含无效相对路径：${prefix}`);
      }
    }
  }
}

async function discoverLayer(
  layer: LocalCreativeSourceLayerInput,
  input: LocalCreativeProjectIngestInput,
  warnings: LocalCreativeIngestWarning[],
): Promise<{ projection: LocalCreativeSourceLayerProjection; files: MutableFile[] }> {
  const requestedRoot = path.resolve(layer.rootPath);
  const rootMetadata = await lstat(requestedRoot);
  if (rootMetadata.isSymbolicLink()) throw new Error(`source layer 根目录不能是符号链接：${requestedRoot}`);
  if (!rootMetadata.isDirectory()) throw new Error(`source layer 根路径不是目录：${requestedRoot}`);
  const rootPath = await realpath(requestedRoot);
  const layerId = `${layer.role.toLocaleLowerCase("en-US")}-${shortHash(rootPath)}`;
  const files: MutableFile[] = [];
  const excludedPrefixes = (layer.excludeRelativePrefixes ?? [])
    .map((prefix) => normalizedRelative(prefix.trim()).replace(/^\.\/+/u, "").replace(/\/+$/u, ""))
    .sort((left, right) => left.localeCompare(right, "en"));
  const isExcluded = (relativePath: string): boolean => excludedPrefixes.some((prefix) => (
    relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  ));

  const walk = async (directory: string, directoryDepth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      warnings.push({
        code: "UNREADABLE_ENTRY",
        path: directory,
        message: `目录不可读取，已跳过：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativeEntryPath = normalizedRelative(path.relative(rootPath, absolutePath));
      if (isExcluded(relativeEntryPath)) continue;
      let metadata;
      try {
        metadata = await lstat(absolutePath);
      } catch (error) {
        warnings.push({
          code: "UNREADABLE_ENTRY",
          path: absolutePath,
          message: `条目不可读取，已跳过：${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      if (metadata.isSymbolicLink()) {
        warnings.push({ code: "SYMLINK_SKIPPED", path: absolutePath, message: "符号链接已忽略，未跟随。" });
        continue;
      }
      if (metadata.isDirectory()) {
        const nextDirectoryDepth = directoryDepth + 1;
        if (
          !IGNORED_DIRECTORY_NAMES.has(entry.name.toLocaleLowerCase("en-US"))
          && (layer.maxDepth === undefined || nextDirectoryDepth < layer.maxDepth)
        ) {
          await walk(absolutePath, nextDirectoryDepth);
        }
        continue;
      }
      if (!metadata.isFile()) continue;
      const extension = path.extname(entry.name).toLocaleLowerCase("en-US");
      const extensionKind = mediaKindForExtension(extension);
      let mediaKind = extensionKind;
      let mediaSignatureRejected = false;
      if (extensionKind !== "document") {
        let signature: SniffedMediaSignature | null = null;
        try {
          signature = await sniffMediaSignature(absolutePath);
        } catch (error) {
          signature = { kind: null, signature: `unreadable: ${error instanceof Error ? error.message : String(error)}` };
        }
        if (!extensionKind) {
          mediaKind = signature?.kind ?? null;
        } else if (!signature?.kind) {
          mediaSignatureRejected = true;
          warnings.push({
            code: "MEDIA_SIGNATURE_INVALID",
            path: absolutePath,
            extension,
            extensionKind,
            detectedSignature: signature?.signature ?? "unreadable",
            message: "媒体扩展名对应的文件没有可识别媒体签名，已拒绝进入导入链。",
          });
        } else {
          mediaKind = signature.kind;
          if (signature.kind !== extensionKind || !mediaSignatureMatchesExtension(extension, signature.signature)) {
            warnings.push({
              code: "MEDIA_SIGNATURE_EXTENSION_MISMATCH",
              path: absolutePath,
              extension,
              extensionKind,
              detectedKind: signature.kind,
              detectedSignature: signature.signature,
              message: `媒体扩展名 ${extension} 与实际签名 ${signature.signature} 不一致；预览采用真实媒体类型 ${signature.kind}。`,
            });
          }
        }
      }
      if (!mediaKind) continue;
      const relativePath = relativeEntryPath;
      const pathForSignals = normalizedLookup(relativePath);
      const providedSha256 = providedShaFor(input.providedSha256ByPath, layer.role, absolutePath, relativePath);
      let sha256 = providedSha256;
      let sha256Source: MutableFile["sha256Source"] = providedSha256 ? "provided" : undefined;
      // 剧本/提示词会在后续只读导入中直接成为 Studio 文稿；即使调用方没有要求
      // 全媒体哈希，也必须在预览期冻结文档字节身份，不能只靠可碰撞的 size/mtime。
      if (input.computeSha256 || mediaKind === "document") {
        const computedSha256 = await sha256File(absolutePath);
        const afterHash = await lstat(absolutePath);
        if (!afterHash.isFile() || afterHash.isSymbolicLink()
          || afterHash.size !== metadata.size
          || Math.trunc(afterHash.mtimeMs) !== Math.trunc(metadata.mtimeMs)) {
          throw new Error(`SOURCE_RACE_DETECTED：来源文件在 SHA-256 预览期间变化：${absolutePath}`);
        }
        if (providedSha256 && providedSha256 !== computedSha256) {
          warnings.push({
            code: "PROVIDED_SHA_MISMATCH",
            path: absolutePath,
            providedSha256,
            computedSha256,
            message: "调用方提供的 SHA-256 与只读计算值不一致；预览采用计算值。",
          });
        }
        sha256 = computedSha256;
        sha256Source = "computed";
      }
      files.push({
        fileId: `${layerId}:${relativePath}`,
        absolutePath,
        relativePath,
        basename: entry.name,
        extension,
        sizeBytes: metadata.size,
        mtimeMs: Math.trunc(metadata.mtimeMs),
        mtimeIso: new Date(metadata.mtimeMs).toISOString(),
        mediaKind,
        sourceLayer: { layerId, role: layer.role, rootPath, ...(layer.label ? { label: layer.label } : {}) },
        status: "UNKNOWN",
        ...(sha256 ? { sha256, sha256Source } : {}),
        evidence: [],
        pathCandidateLock: PATH_LOCK_CANDIDATE_PATTERN.test(pathForSignals),
        pathRejected: PATH_REJECT_PATTERN.test(pathForSignals),
        pathFormalMedia: PATH_FORMAL_MEDIA_PATTERN.test(pathForSignals),
        integrityConflict: false,
        mediaSignatureRejected,
      });
    }
  };
  await walk(rootPath, 0);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  return {
    projection: { layerId, role: layer.role, rootPath, ...(layer.label ? { label: layer.label } : {}), fileCount: files.length },
    files,
  };
}

function selectReferenceTarget(
  source: MutableFile,
  basename: string,
  context: string,
  candidates: MutableFile[],
): { target?: MutableFile; exactRelativePath: boolean; ambiguous?: MutableFile[] } {
  const normalizedContext = normalizedLookup(context);
  const nonSelf = candidates.filter((candidate) => candidate.fileId !== source.fileId);
  const absoluteMatches = nonSelf.filter((candidate) => normalizedContext.includes(normalizedLookup(candidate.absolutePath)));
  if (absoluteMatches.length === 1) return { target: absoluteMatches[0], exactRelativePath: true };
  const relativeMatches = nonSelf.filter((candidate) => (
    candidate.relativePath !== basename
    && normalizedContext.includes(normalizedLookup(candidate.relativePath))
  ));
  if (relativeMatches.length === 1) return { target: relativeMatches[0], exactRelativePath: true };
  const sameLayer = nonSelf.filter((candidate) => candidate.sourceLayer.layerId === source.sourceLayer.layerId);
  if (sameLayer.length === 1) return { target: sameLayer[0], exactRelativePath: false };
  if (nonSelf.length === 1) return { target: nonSelf[0], exactRelativePath: false };
  return { exactRelativePath: false, ambiguous: relativeMatches.length ? relativeMatches : sameLayer.length ? sameLayer : nonSelf };
}

function buildBasenameMatchers(basenames: string[]): RegExp[] {
  const unique = [...new Set(basenames)].sort((left, right) => right.length - left.length || left.localeCompare(right, "en"));
  const chunks: RegExp[] = [];
  for (let index = 0; index < unique.length; index += 256) {
    const alternatives = unique.slice(index, index + 256).map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
    chunks.push(new RegExp(`(?<![\\\\p{L}\\\\p{N}_.-])(?:${alternatives.join("|")})(?![\\\\p{L}\\\\p{N}_.-])`, "giu"));
  }
  return chunks;
}

function addStaleLedgerWarnings(files: MutableFile[], warnings: LocalCreativeIngestWarning[]): void {
  const byLayer = new Map<string, MutableFile[]>();
  for (const file of files) {
    const values = byLayer.get(file.sourceLayer.layerId) ?? [];
    values.push(file);
    byLayer.set(file.sourceLayer.layerId, values);
  }
  for (const layerFiles of byLayer.values()) {
    const ledger = layerFiles
      .filter((file) => file.mediaKind === "document" && LEDGER_NAME_PATTERN.test(file.basename))
      .sort((left, right) => right.mtimeMs - left.mtimeMs || left.relativePath.localeCompare(right.relativePath, "en"))[0];
    if (!ledger) continue;
    for (const file of layerFiles) {
      if (file.fileId === ledger.fileId || (file.mediaKind === "document" && LEDGER_NAME_PATTERN.test(file.basename))) continue;
      if (file.mtimeMs <= ledger.mtimeMs) continue;
      warnings.push({
        code: "STALE_LEDGER",
        path: file.absolutePath,
        ledgerPath: ledger.absolutePath,
        fileMtimeMs: file.mtimeMs,
        ledgerMtimeMs: ledger.mtimeMs,
        message: "文件时间晚于同来源层最新状态/索引证据；账本可能已经过期。",
      });
    }
  }
}

/**
 * 只读盘点本机创作工程。不会创建 `.aicanvas`、不会登记工程，也不会修改源文件。
 */
export async function inspectLocalCreativeProject(
  input: LocalCreativeProjectIngestInput,
): Promise<LocalCreativeProjectIngestPreview> {
  validateInput(input);
  const warnings: LocalCreativeIngestWarning[] = [];
  const normalizedLayers = [...input.sourceLayers]
    .map((layer) => ({ ...layer, rootPath: path.resolve(layer.rootPath) }))
    .sort((left, right) => (
      left.role.localeCompare(right.role, "en")
      || left.rootPath.localeCompare(right.rootPath, "en")
      || (left.label ?? "").localeCompare(right.label ?? "", "en")
    ));
  const discovered = [];
  for (const layer of normalizedLayers) discovered.push(await discoverLayer(layer, input, warnings));
  const sourceLayers = discovered.map((entry) => entry.projection);
  const files = discovered.flatMap((entry) => entry.files)
    .sort((left, right) => (
      left.sourceLayer.role.localeCompare(right.sourceLayer.role, "en")
      || left.sourceLayer.rootPath.localeCompare(right.sourceLayer.rootPath, "en")
      || left.relativePath.localeCompare(right.relativePath, "en")
    ));

  const basenameIndex = new Map<string, MutableFile[]>();
  for (const file of files) {
    const key = normalizedLookup(file.basename);
    const values = basenameIndex.get(key) ?? [];
    values.push(file);
    basenameIndex.set(key, values);
  }
  const matchers = buildBasenameMatchers([...basenameIndex.keys()]);
  const signalsByTarget = new Map<string, ReferenceSignal[]>();
  const references: LocalCreativeReference[] = [];
  let parsedTextFiles = 0;
  const maxParsedTextBytes = input.maxParsedTextBytes ?? DEFAULT_MAX_PARSED_TEXT_BYTES;

  for (const source of files) {
    if (!TEXT_EXTENSIONS.has(source.extension) || source.sizeBytes > maxParsedTextBytes) continue;
    let body: string;
    try {
      body = await readFile(source.absolutePath, "utf8");
    } catch (error) {
      warnings.push({
        code: "UNREADABLE_ENTRY",
        path: source.absolutePath,
        message: `文本不可读取，未解析引用：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (source.extension === ".json") {
      try { body = JSON.stringify(JSON.parse(body), null, 2); } catch { /* 保留原文，仍可盘点显式文件名。 */ }
    }
    source.parsedText = body;
    parsedTextFiles += 1;
    const seen = new Set<string>();
    for (const matcher of matchers) {
      matcher.lastIndex = 0;
      for (const match of body.matchAll(matcher)) {
        const basename = match[0];
        const context = contextAround(body, match.index, basename.length);
        const candidates = basenameIndex.get(normalizedLookup(basename)) ?? [];
        const selection = selectReferenceTarget(source, basename, context, candidates);
        if (!selection.target) {
          if (selection.ambiguous?.length) {
            const warningKey = `${source.fileId}\0${normalizedLookup(basename)}`;
            if (!seen.has(`ambiguous:${warningKey}`)) {
              warnings.push({
                code: "AMBIGUOUS_BASENAME_REFERENCE",
                path: source.absolutePath,
                basename,
                candidatePaths: selection.ambiguous.map((candidate) => candidate.absolutePath).sort(),
                message: "同名文件无法由相对路径或当前来源层唯一消歧，未建立引用。",
              });
              seen.add(`ambiguous:${warningKey}`);
            }
          }
          continue;
        }
        const referenceKey = `${source.fileId}\0${selection.target.fileId}\0${context}`;
        if (seen.has(referenceKey)) continue;
        seen.add(referenceKey);
        const signal = referenceEvidence(source, selection.target, context, selection.exactRelativePath);
        const contextHashes = [...context.matchAll(SHA256_IN_CONTEXT_PATTERN)].map((entry) => entry[0].toLocaleLowerCase("en-US"));
        if (selection.target.sha256 && contextHashes.length && !contextHashes.includes(selection.target.sha256)) {
          selection.target.integrityConflict = true;
          for (const expectedSha256 of contextHashes) {
            warnings.push({
              code: "SHA_MISMATCH",
              path: selection.target.absolutePath,
              sourcePath: source.absolutePath,
              expectedSha256,
              actualSha256: selection.target.sha256,
              message: "引用上下文声明的 SHA-256 与目标文件实际 SHA-256 不一致，禁止自动批准。",
            });
          }
        }
        references.push(signal.reference);
        const targetSignals = signalsByTarget.get(selection.target.fileId) ?? [];
        targetSignals.push(signal);
        signalsByTarget.set(selection.target.fileId, targetSignals);
        selection.target.evidence.push(...signal.evidence);
      }
    }
  }

  for (const file of files) {
    file.status = determineStatus(file, signalsByTarget.get(file.fileId) ?? []);
    file.evidence = [...new Map(file.evidence.map((entry) => [
      `${entry.level}\0${entry.sourceFileId}\0${entry.context}`,
      entry,
    ])).values()].sort((left, right) => (
      left.sourcePath.localeCompare(right.sourcePath, "en")
      || left.level.localeCompare(right.level, "en")
      || left.context.localeCompare(right.context, "en")
    ));
  }
  references.sort((left, right) => (
    left.targetFileId.localeCompare(right.targetFileId, "en")
    || left.sourceFileId.localeCompare(right.sourceFileId, "en")
    || left.context.localeCompare(right.context, "en")
  ));
  addStaleLedgerWarnings(files, warnings);
  warnings.sort((left, right) => warningSortKey(left).localeCompare(warningSortKey(right), "en"));

  const lockCandidates: LocalCreativeLockCandidate[] = files
    .filter((file): file is MutableFile & { status: "APPROVED_LOCK" | "CANDIDATE_LOCK" } => (
      file.status === "APPROVED_LOCK" || file.status === "CANDIDATE_LOCK"
    ))
    .map((file) => ({
      fileId: file.fileId,
      absolutePath: file.absolutePath,
      relativePath: file.relativePath,
      status: file.status,
      sourceLayerRole: file.sourceLayer.role,
      evidenceLevels: [...new Set(file.evidence.map((entry) => entry.level))].sort(),
    }));
  const filesById = new Map(files.map((file) => [file.fileId, file]));
  const lockReferenceIndex: LocalCreativeLockReferenceIndexEntry[] = lockCandidates.map((lock) => ({
    lockFileId: lock.fileId,
    lockPath: lock.absolutePath,
    status: lock.status,
    referencedBy: references
      .filter((reference) => reference.targetFileId === lock.fileId)
      .map((reference) => {
        const source = filesById.get(reference.sourceFileId);
        if (!source) throw new Error(`引用来源不存在：${reference.sourceFileId}`);
        return {
          fileId: source.fileId,
          path: source.absolutePath,
          evidenceLevels: reference.evidenceLevels,
        };
      }),
  }));
  const statistics = buildStatistics(files, warnings, references, parsedTextFiles);

  const publicFiles: LocalCreativeIngestFile[] = files.map(({
    parsedText: _parsedText,
    pathCandidateLock: _pathCandidateLock,
    pathRejected: _pathRejected,
    pathFormalMedia: _pathFormalMedia,
    integrityConflict: _integrityConflict,
    mediaSignatureRejected: _mediaSignatureRejected,
    ...file
  }) => file);
  const fingerprintPayload = {
    project: {
      key: input.projectKey.trim(),
      name: input.projectName.trim(),
      type: input.projectType.trim(),
    },
    sourceLayers,
    files: publicFiles.map((file) => ({
      fileId: file.fileId,
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      mtimeMs: file.mtimeMs,
      sha256: file.sha256 ?? null,
      status: file.status,
      evidence: file.evidence.map((entry) => ({
        level: entry.level,
        sourceFileId: entry.sourceFileId,
        declaredSha256: entry.declaredSha256 ?? null,
      })),
    })),
    references: references.map((reference) => ({
      targetFileId: reference.targetFileId,
      sourceFileId: reference.sourceFileId,
      evidenceLevels: reference.evidenceLevels,
      rejected: reference.rejected,
      lockSemantic: reference.lockSemantic,
      explicitApproval: reference.explicitApproval,
      reviewQcPass: reference.reviewQcPass,
      exactShaMatch: reference.exactShaMatch,
    })),
    warnings: warnings.map((warning) => warningSortKey(warning)),
  };
  const previewFingerprint = `local-creative-${createHash("sha256").update(stableStringify(fingerprintPayload)).digest("hex")}`;

  return {
    schemaVersion: 1,
    kind: "local-creative-project-ingest-preview",
    project: fingerprintPayload.project,
    sourceLayers,
    files: publicFiles,
    references,
    lockCandidates,
    lockReferenceIndex,
    warnings,
    statistics,
    previewFingerprint,
    scannedAt: new Date().toISOString(),
    readOnly: true,
  };
}
