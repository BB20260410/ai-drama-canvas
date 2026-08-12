import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export const NOVEL_DOCX_LIMITS = Object.freeze({
  maximumFileBytes: 50_000_000,
  maximumMembers: 4_096,
  maximumMemberExpandedBytes: 50_000_000,
  maximumExpandedBytes: 200_000_000,
  maximumCompressionRatio: 1_000,
  maximumOutputChars: 10_000_000,
  timeoutMs: 15_000,
  maximumDiagnosticBytes: 64 * 1024,
  maximumStdoutBytes: 64 * 1024 * 1024,
});

export interface NovelDocxParseResult {
  text: string;
  sourceSha256: string;
  outputSha256: string;
  converter: { name: "mammoth"; version: string; contractVersion: 1 };
  memberCount: number;
  expandedBytes: number;
  warnings: string[];
  isolation: {
    process: true;
    permissionModel: true;
    networkAllowed: false;
    filesystemWriteAllowed: false;
  };
}

export interface NovelDocxParseLimits {
  maximumFileBytes: number;
  maximumMembers: number;
  maximumMemberExpandedBytes: number;
  maximumExpandedBytes: number;
  maximumCompressionRatio: number;
  maximumOutputChars: number;
  timeoutMs: number;
}

const WORKER = String.raw`
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const [mammothEntry, jszipEntry, limitsJson, expectedSourceSha256, mammothVersion] = process.argv.slice(1);
const limits = JSON.parse(limitsJson);
const require = createRequire(import.meta.url);
const mammoth = require(mammothEntry);
const JSZip = require(jszipEntry);

function fail(message) {
  process.stderr.write(String(message).slice(0, 4000));
  process.exit(17);
}

function safeMemberPath(name, directory) {
  const normalizedName = String(name).replaceAll("\\\\", "/");
  const pathForValidation = directory && normalizedName.endsWith("/")
    ? normalizedName.slice(0, -1)
    : normalizedName;
  if (!pathForValidation
    || normalizedName.startsWith("/")
    || pathForValidation.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    fail("DOCX ZIP 包含不安全成员路径。");
  }
  return normalizedName;
}

function inspectCentralDirectory(input) {
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const lower = Math.max(0, input.length - 65557);
  let eocd = -1;
  for (let offset = input.length - 22; offset >= lower; offset -= 1) {
    if (input.readUInt32LE(offset) === eocdSignature) { eocd = offset; break; }
  }
  if (eocd < 0 || eocd + 22 > input.length) fail("DOCX ZIP 缺少有效 EOCD。");
  const disk = input.readUInt16LE(eocd + 4);
  const centralDisk = input.readUInt16LE(eocd + 6);
  const diskEntries = input.readUInt16LE(eocd + 8);
  const totalEntries = input.readUInt16LE(eocd + 10);
  const centralBytes = input.readUInt32LE(eocd + 12);
  const centralOffset = input.readUInt32LE(eocd + 16);
  const commentBytes = input.readUInt16LE(eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries
    || totalEntries === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff) {
    fail("DOCX ZIP 禁止分卷或 ZIP64。");
  }
  if (totalEntries < 1 || totalEntries > limits.maximumMembers) fail("DOCX ZIP 成员数越界。");
  if (eocd + 22 + commentBytes !== input.length
    || centralOffset + centralBytes !== eocd
    || centralOffset < 0 || centralOffset + centralBytes > input.length) {
    fail("DOCX ZIP 中央目录边界无效。");
  }
  const names = new Set();
  let cursor = centralOffset;
  let declaredTotal = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocd || input.readUInt32LE(cursor) !== centralSignature) {
      fail("DOCX ZIP 中央目录成员无效。");
    }
    const versionMadeBy = input.readUInt16LE(cursor + 4);
    const flags = input.readUInt16LE(cursor + 8);
    const compression = input.readUInt16LE(cursor + 10);
    const compressed = input.readUInt32LE(cursor + 20);
    const expanded = input.readUInt32LE(cursor + 24);
    const nameBytes = input.readUInt16LE(cursor + 28);
    const extraBytes = input.readUInt16LE(cursor + 30);
    const memberCommentBytes = input.readUInt16LE(cursor + 32);
    const externalAttributes = input.readUInt32LE(cursor + 38);
    const localOffset = input.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameBytes + extraBytes + memberCommentBytes;
    if (end > eocd || expanded === 0xffffffff || compressed === 0xffffffff || localOffset === 0xffffffff) {
      fail("DOCX ZIP 成员边界或 ZIP64 字段无效。");
    }
    if ((flags & 0x0001) !== 0) fail("DOCX ZIP 包含加密成员。");
    if (compression !== 0 && compression !== 8) fail("DOCX ZIP 包含不支持的压缩方法。");
    if (expanded > limits.maximumMemberExpandedBytes
      || (expanded > 0 && compressed === 0)
      || (compressed > 0 && expanded / compressed > limits.maximumCompressionRatio)) {
      fail("DOCX ZIP 单成员展开体积或压缩比越界。");
    }
    declaredTotal += expanded;
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > limits.maximumExpandedBytes) {
      fail("DOCX ZIP 展开体积越界。");
    }
    const rawName = input.subarray(cursor + 46, cursor + 46 + nameBytes);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(rawName);
    const directory = name.endsWith("/");
    const normalizedName = safeMemberPath(name, directory);
    if (names.has(normalizedName)) fail("DOCX ZIP 包含重复成员名。");
    names.add(normalizedName);
    const unixMode = (externalAttributes >>> 16) & 0xf000;
    if ((versionMadeBy >>> 8) === 3 && unixMode === 0xa000) fail("DOCX ZIP 成员不得是符号链接。");
    let extraCursor = cursor + 46 + nameBytes;
    const extraEnd = extraCursor + extraBytes;
    while (extraCursor < extraEnd) {
      if (extraCursor + 4 > extraEnd) fail("DOCX ZIP extra 字段截断。");
      const extraId = input.readUInt16LE(extraCursor);
      const extraLength = input.readUInt16LE(extraCursor + 2);
      extraCursor += 4;
      if (extraCursor + extraLength > extraEnd) fail("DOCX ZIP extra 字段越界。");
      if (extraId === 0x0001) fail("DOCX ZIP 禁止 ZIP64 extra 字段。");
      extraCursor += extraLength;
    }
    cursor = end;
  }
  if (cursor !== eocd) fail("DOCX ZIP 中央目录长度不一致。");
  return names;
}

try {
  if (process.permission?.has("fs.write")
    || process.permission?.has("net")) {
    fail("DOCX worker 权限模型未按只读、禁写、禁网启动。");
  }
  const inputChunks = [];
  let inputBytes = 0;
  for await (const chunk of process.stdin) {
    inputBytes += chunk.byteLength;
    if (inputBytes > limits.maximumFileBytes) fail("DOCX 文件大小越界。");
    inputChunks.push(Buffer.from(chunk));
  }
  const input = Buffer.concat(inputChunks);
  if (input.byteLength < 1 || input.byteLength > limits.maximumFileBytes) fail("DOCX 文件大小越界。");
  const sourceSha256 = createHash("sha256").update(input).digest("hex");
  if (sourceSha256 !== expectedSourceSha256) fail("DOCX stdin 字节与冻结 SHA-256 不一致。");
  const centralNames = inspectCentralDirectory(input);
  // JSZip 的 checkCRC32 会在我们看到中央目录的数量/展开大小之前先展开全部
  // 成员；对不可信 DOCX 这会倒置 zip-bomb 边界。先只解析目录，再逐成员
  // 流式展开、计数并丢弃，最后才允许 mammoth 读取。
  const zip = await JSZip.loadAsync(input, {
    checkCRC32: false,
    createFolders: false,
    decodeFileName: (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  });
  const entries = Object.values(zip.files);
  if (entries.length < 1 || entries.length > limits.maximumMembers) fail("DOCX ZIP 成员数越界。");
  if (entries.length !== centralNames.size) fail("DOCX ZIP 解析成员与中央目录不一致。");
  let expandedBytes = 0;
  async function inspectExpandedEntry(entry, captureText) {
    const chunks = [];
    let actualBytes = 0;
    await new Promise((resolve, reject) => {
      const stream = entry.nodeStream("nodebuffer");
      stream.on("data", (chunk) => {
        actualBytes += chunk.byteLength;
        if (expandedBytes + actualBytes > limits.maximumExpandedBytes) {
          stream.destroy(new Error("DOCX ZIP 展开体积越界。"));
          return;
        }
        if (captureText) {
          if (actualBytes > 2 * 1024 * 1024) {
            stream.destroy(new Error("DOCX 关系文件过大。"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
      });
      stream.once("error", reject);
      stream.once("end", resolve);
    });
    return { actualBytes, text: captureText ? Buffer.concat(chunks).toString("utf8") : "" };
  }
  for (const entry of entries) {
    const originalName = String(entry.unsafeOriginalName ?? entry.name);
    const normalizedName = safeMemberPath(originalName, entry.dir);
    if (!centralNames.has(normalizedName)) fail("DOCX ZIP 成员名与中央目录不一致。");
    if (/\/(?:vbaProject\.bin|activeX\/|embeddings\/|oleObject)/iu.test("/" + normalizedName)
      || /(?:^|\/)macros?(?:\/|$)/iu.test(normalizedName)) {
      fail("DOCX 包含宏、ActiveX 或嵌入对象，已拒绝解析。");
    }
    if (entry.dir) continue;
    const declared = Number(entry._data?.uncompressedSize);
    if (!Number.isSafeInteger(declared) || declared < 0) fail("DOCX ZIP 成员缺少可信展开大小。");
    if (declared > limits.maximumMemberExpandedBytes) fail("DOCX ZIP 单成员展开体积越界。");
    const compressed = Number(entry._data?.compressedSize);
    if (!Number.isSafeInteger(compressed) || compressed < 0
      || (declared > 0 && compressed === 0)
      || (compressed > 0 && declared / compressed > limits.maximumCompressionRatio)) {
      fail("DOCX ZIP 成员压缩比越界或无效。");
    }
    if (!Number.isSafeInteger(expandedBytes + declared) || expandedBytes + declared > limits.maximumExpandedBytes) {
      fail("DOCX ZIP 展开体积越界。");
    }
    const relation = /\.rels$/iu.test(normalizedName);
    const contentTypes = normalizedName === "[Content_Types].xml";
    const inspected = await inspectExpandedEntry(entry, relation || contentTypes);
    if (inspected.actualBytes !== declared) fail("DOCX ZIP 成员实际展开大小与中央目录不一致。");
    expandedBytes += inspected.actualBytes;
    if (relation) {
      const relationXml = inspected.text;
      if (/TargetMode\s*=\s*["']External["']/iu.test(relationXml)) {
        fail("DOCX 包含外部关系，已拒绝解析。");
      }
    }
    if (contentTypes && /(?:macroEnabled|vbaProject|activeX|oleObject|customUI)/iu.test(inspected.text)) {
      fail("DOCX Content Types 声明了宏或活动内容。");
    }
  }
  const result = await mammoth.extractRawText({ buffer: input });
  const text = String(result.value ?? "");
  if (!text.trim()) fail("DOCX 没有可导入文本。");
  if (text.length > limits.maximumOutputChars) fail("DOCX 提取文本超过字符上限。");
  const warnings = (result.messages ?? []).slice(0, 100).map((message) => String(message.message ?? message).slice(0, 1000));
  const outputSha256 = createHash("sha256").update(text, "utf8").digest("hex");
  process.stdout.write(JSON.stringify({
    text,
    sourceSha256,
    outputSha256,
    converter: { name: "mammoth", version: mammothVersion, contractVersion: 1 },
    memberCount: entries.length,
    expandedBytes,
    warnings,
    isolation: {
      process: true,
      permissionModel: true,
      networkAllowed: false,
      filesystemWriteAllowed: false,
    },
  }));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
`;

function dependencyRoot(entryPath: string): string {
  const marker = `${path.sep}node_modules${path.sep}`;
  const index = entryPath.lastIndexOf(marker);
  if (index < 0) throw new Error(`DOCX 解析依赖不在 node_modules 中：${entryPath}`);
  return entryPath.slice(0, index + marker.length - 1);
}

function effectiveLimits(overrides: Partial<NovelDocxParseLimits>): NovelDocxParseLimits {
  const defaults: NovelDocxParseLimits = {
    maximumFileBytes: NOVEL_DOCX_LIMITS.maximumFileBytes,
    maximumMembers: NOVEL_DOCX_LIMITS.maximumMembers,
    maximumMemberExpandedBytes: NOVEL_DOCX_LIMITS.maximumMemberExpandedBytes,
    maximumExpandedBytes: NOVEL_DOCX_LIMITS.maximumExpandedBytes,
    maximumCompressionRatio: NOVEL_DOCX_LIMITS.maximumCompressionRatio,
    maximumOutputChars: NOVEL_DOCX_LIMITS.maximumOutputChars,
    timeoutMs: NOVEL_DOCX_LIMITS.timeoutMs,
  };
  const merged = { ...defaults, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    const maximum = defaults[key as keyof NovelDocxParseLimits];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`DOCX ${key} 只能收紧且必须为正整数。`);
    }
  }
  return merged;
}

function isolatedEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_NO_WARNINGS: "1",
  };
}

export async function parseNovelDocxIsolated(
  filePath: string,
  overrides: Partial<NovelDocxParseLimits> = {},
): Promise<NovelDocxParseResult> {
  const sourcePath = path.resolve(filePath);
  const metadata = await lstat(sourcePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.size < 1 || metadata.size > NOVEL_DOCX_LIMITS.maximumFileBytes
    || await realpath(sourcePath) !== sourcePath) {
    throw new Error("DOCX 来源必须是规范绝对路径上的单链接非空普通文件，且不超过 50MB。");
  }
  const limits = effectiveLimits(overrides);
  if (metadata.size > limits.maximumFileBytes) throw new Error("DOCX 文件超过本次解析上限。");
  const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let sourceBytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.dev !== metadata.dev || before.ino !== metadata.ino
      || before.size !== metadata.size) {
      throw new Error("DOCX 路径与已打开 fd 身份不一致。");
    }
    sourceBytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(sourcePath);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino || pathAfter.isSymbolicLink()
      || sourceBytes.byteLength !== after.size) {
      throw new Error("DOCX 来源在冻结读取期间发生替换或修改。");
    }
  } finally {
    await handle.close();
  }
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");

  const require = createRequire(import.meta.url);
  const mammothEntry = require.resolve("mammoth");
  const mammothVersion = String((require("mammoth/package.json") as { version?: unknown }).version ?? "");
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(mammothVersion)) throw new Error("Mammoth 版本无法冻结。");
  const jszipEntry = require.resolve("jszip");
  const allowedDependencyRoot = dependencyRoot(mammothEntry);
  if (dependencyRoot(jszipEntry) !== allowedDependencyRoot) {
    throw new Error("DOCX 解析依赖不在同一受控 node_modules 根中。");
  }

  return new Promise<NovelDocxParseResult>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--max-old-space-size=256",
      "--permission",
      `--allow-fs-read=${allowedDependencyRoot}`,
      "--input-type=module",
      "--eval",
      WORKER,
      mammothEntry,
      jszipEntry,
      JSON.stringify(limits),
      sourceSha256,
      mammothVersion,
    ], {
      cwd: allowedDependencyRoot,
      env: isolatedEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("DOCX 隔离解析超时，未产生权威文件。")));
    }, limits.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= NOVEL_DOCX_LIMITS.maximumStdoutBytes) stdout.push(Buffer.from(chunk));
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= NOVEL_DOCX_LIMITS.maximumDiagnosticBytes) stderr.push(Buffer.from(chunk));
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => finish(() => {
      if (stdoutBytes > NOVEL_DOCX_LIMITS.maximumStdoutBytes) {
        reject(new Error("DOCX 隔离解析输出超过上限，未产生权威文件。"));
        return;
      }
      if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(`DOCX 隔离解析失败（${signal ?? `exit ${code ?? 1}`}）：${diagnostic || "无诊断"}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as NovelDocxParseResult;
        if (typeof parsed.text !== "string" || !parsed.text.trim()
          || parsed.sourceSha256 !== sourceSha256
          || parsed.outputSha256 !== createHash("sha256").update(parsed.text, "utf8").digest("hex")
          || parsed.converter?.name !== "mammoth" || parsed.converter.version !== mammothVersion
          || parsed.converter.contractVersion !== 1
          || !Number.isSafeInteger(parsed.memberCount) || parsed.memberCount < 1 || parsed.memberCount > limits.maximumMembers
          || !Number.isSafeInteger(parsed.expandedBytes) || parsed.expandedBytes < 1 || parsed.expandedBytes > limits.maximumExpandedBytes
          || parsed.text.length > limits.maximumOutputChars
          || !Array.isArray(parsed.warnings) || !parsed.warnings.every((warning) => typeof warning === "string")
          || parsed.isolation?.process !== true
          || parsed.isolation.permissionModel !== true
          || parsed.isolation.networkAllowed !== false
          || parsed.isolation.filesystemWriteAllowed !== false) {
          throw new Error("DOCX worker 回执结构或边界无效。");
        }
        resolve(parsed);
      } catch (error) {
        reject(new Error("DOCX worker 返回无法验证的结果。", { cause: error }));
      }
    }));
    child.stdin.on("error", (error) => finish(() => reject(error)));
    child.stdin.end(sourceBytes);
  });
}
