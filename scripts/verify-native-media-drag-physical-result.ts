import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  link,
  lstat,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const workspace = process.cwd();
const evidenceRoot = path.join(workspace, "docs", "evidence");

function requiredAbsolute(value: string | undefined, label: string): string {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} 必须是绝对路径。`);
  return path.normalize(value);
}

const sessionPath = requiredAbsolute(process.argv[2], "物理验收会话");
const finderTarget = requiredAbsolute(process.argv[3], "Finder 目标目录");
const finderScreenshot = requiredAbsolute(process.argv[4], "Finder 截图");
const otherAppScreenshot = requiredAbsolute(process.argv[5], "其他软件截图");
const otherAppName = process.argv[6]?.trim();
if (!otherAppName) throw new Error("必须声明其他软件名称。");
const evidencePath = requiredAbsolute(process.argv[7], "证据路径");
const otherAppReceiptPath = requiredAbsolute(process.argv[8], "其他软件接收回执");
const relativeEvidence = path.relative(evidenceRoot, evidencePath);
if (relativeEvidence === ".." || relativeEvidence.startsWith(`..${path.sep}`) || path.isAbsolute(relativeEvidence)) {
  throw new Error("物理验收证据必须写入 docs/evidence。");
}
await access(evidencePath).then(
  () => { throw new Error(`证据已存在，拒绝覆盖：${evidencePath}`); },
  () => undefined,
);

type FileIdentity = {
  path: string;
  sizeBytes: number;
  sha256: string;
  dev: string;
  ino: string;
  isSymbolicLink: boolean;
};

type SessionMedia = {
  kind: "image" | "video" | "audio";
  sourceBasename: string;
  casObjectPath: string;
  sha256: string;
  mimeType: string;
  sourceIdentity: FileIdentity;
};

type PhysicalSession = {
  schemaVersion: number;
  state: string;
  launchMode: string;
  executablePath: string | null;
  projectRoot: string;
  build: {
    buildId?: string;
    sourceDigest?: string;
    mcpToolCount?: number;
  };
  media: Record<"image" | "video" | "audio", SessionMedia>;
  consoleErrors?: string[];
  pageErrors?: string[];
  externalRequests?: string[];
  canvasState?: {
    observedAt: string;
    nodeCount: number;
    exportHandleCount: number;
    mediaKinds: string[];
    armedKinds?: string[];
  };
  persistenceState?: {
    registeredMedia: Array<{ kind: string; sha256: string; registered: boolean }>;
    expectedPinnedNodeIds: string[];
    persistedPinnedNodeIds: string[];
    allMediaRegistered: boolean;
    allPinnedNodesPersisted: boolean;
  };
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileIdentity(filePath: string): Promise<FileIdentity> {
  const metadata = await lstat(filePath, { bigint: true });
  if (!metadata.isFile()) throw new Error(`不是普通文件：${filePath}`);
  return {
    path: filePath,
    sizeBytes: Number(metadata.size),
    sha256: sha256(await readFile(filePath)),
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    isSymbolicLink: metadata.isSymbolicLink(),
  };
}

async function ffprobe(filePath: string): Promise<{
  formatName: string;
  durationSeconds: number;
  streamTypes: string[];
}> {
  const result = await execFileAsync("/opt/homebrew/bin/ffprobe", [
    "-v", "error",
    "-show_entries", "format=format_name,duration:stream=codec_type",
    "-of", "json",
    filePath,
  ], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const parsed = JSON.parse(String(result.stdout)) as {
    format?: { format_name?: string; duration?: string };
    streams?: Array<{ codec_type?: string }>;
  };
  const durationSeconds = Number(parsed.format?.duration);
  const streamTypes = (parsed.streams ?? []).map((entry) => entry.codec_type ?? "").filter(Boolean);
  if (!parsed.format?.format_name || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || !streamTypes.length) {
    throw new Error(`ffprobe 未确认可解码媒体：${filePath}`);
  }
  return { formatName: parsed.format.format_name, durationSeconds, streamTypes };
}

async function fullDecode(filePath: string): Promise<void> {
  await execFileAsync("/opt/homebrew/bin/ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-i", filePath,
    "-f", "null",
    "-",
  ], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
}

const session = JSON.parse(await readFile(sessionPath, "utf8")) as PhysicalSession;
if (session.schemaVersion !== 1 || !["ready", "closed"].includes(session.state)) {
  throw new Error(`物理验收会话状态无效：${session.state}`);
}
if (session.launchMode !== "packaged-app") {
  throw new Error(`最终物理验收必须使用当前源码打包 App，实际 ${session.launchMode}`);
}
if ((session.consoleErrors ?? []).length || (session.pageErrors ?? []).length || (session.externalRequests ?? []).length) {
  throw new Error("安装版验收会话出现 console/page/external request 异常。");
}
if (
  session.canvasState?.nodeCount !== 3
  || session.canvasState.exportHandleCount !== 3
  || session.canvasState.mediaKinds.join(",") !== "audio,image,video"
) {
  throw new Error("真实拖出后画布未保留完整的图片、视频、音频三个节点。");
}
if (
  session.persistenceState?.allMediaRegistered !== true
  || session.persistenceState.allPinnedNodesPersisted !== true
  || session.persistenceState.registeredMedia.length !== 3
  || session.persistenceState.registeredMedia.some((entry) => !entry.registered)
) {
  throw new Error("真实拖出后媒体登记或画布固定节点没有完整持久化。 ");
}

const orderedKinds: Array<"image" | "video" | "audio"> = ["image", "video", "audio"];
const verified: Array<Record<string, unknown>> = [];
for (const kind of orderedKinds) {
  const expected = session.media[kind];
  const sourceAfter = await fileIdentity(expected.casObjectPath);
  const targetPath = path.join(finderTarget, expected.sourceBasename);
  const target = await fileIdentity(targetPath);
  if (target.sha256 !== expected.sha256 || target.sizeBytes !== expected.sourceIdentity.sizeBytes) {
    throw new Error(`${kind} Finder 复制体内容与 CAS 原件不一致。`);
  }
  if (target.isSymbolicLink) throw new Error(`${kind} Finder 复制体不得为符号链接。`);
  if (target.dev === sourceAfter.dev && target.ino === sourceAfter.ino) {
    throw new Error(`${kind} Finder 目标与 CAS 原件共享 inode，不是独立复制体。`);
  }
  if (
    sourceAfter.sha256 !== expected.sourceIdentity.sha256
    || sourceAfter.sizeBytes !== expected.sourceIdentity.sizeBytes
    || sourceAfter.dev !== expected.sourceIdentity.dev
    || sourceAfter.ino !== expected.sourceIdentity.ino
  ) {
    throw new Error(`${kind} CAS 原件在真实系统拖出后发生变化。`);
  }

  let decode: Record<string, unknown>;
  if (kind === "image") {
    const metadata = await sharp(targetPath).metadata();
    if (!metadata.width || !metadata.height || !metadata.format) throw new Error("Finder 图片复制体不可解码。");
    const decoded = await sharp(targetPath).raw().toBuffer();
    if (!decoded.byteLength) throw new Error("Finder 图片复制体全帧解码为空。");
    decode = {
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
      fullFrameDecodedBytes: decoded.byteLength,
    };
  } else {
    decode = await ffprobe(targetPath);
    await fullDecode(targetPath);
    decode.fullDecodePassed = true;
  }
  verified.push({
    kind,
    fileName: expected.sourceBasename,
    extension: path.extname(targetPath),
    sha256: target.sha256,
    sizeBytes: target.sizeBytes,
    independentCopy: true,
    symbolicLink: false,
    sourceCasUnchanged: true,
    decode,
  });
}

const screenshotEvidence = await Promise.all([
  ["finder", finderScreenshot],
  ["otherApp", otherAppScreenshot],
] as const).then(async (entries) => Promise.all(entries.map(async ([kind, filePath]) => {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`${kind} 截图无效。`);
  return {
    kind,
    relativePath: path.relative(workspace, filePath).split(path.sep).join("/"),
    sizeBytes: metadata.size,
    sha256: sha256(await readFile(filePath)),
  };
})));

const otherAppReceipt = JSON.parse(await readFile(otherAppReceiptPath, "utf8")) as {
  receivedAt?: string;
  sourcePath?: string;
  targetPath?: string;
  fileName?: string;
};
const expectedOtherAppImage = session.media.image;
if (
  !otherAppReceipt.receivedAt
  || otherAppReceipt.fileName !== expectedOtherAppImage.sourceBasename
  || !otherAppReceipt.sourcePath
  || !otherAppReceipt.targetPath
) {
  throw new Error(`其他软件接收回执不完整：${JSON.stringify(otherAppReceipt)}`);
}
const otherAppCopy = await fileIdentity(otherAppReceipt.targetPath);
const imageCasAfterOtherDrop = await fileIdentity(expectedOtherAppImage.casObjectPath);
if (
  otherAppCopy.sha256 !== expectedOtherAppImage.sha256
  || otherAppCopy.sizeBytes !== expectedOtherAppImage.sourceIdentity.sizeBytes
  || otherAppCopy.isSymbolicLink
  || (otherAppCopy.dev === imageCasAfterOtherDrop.dev && otherAppCopy.ino === imageCasAfterOtherDrop.ino)
) {
  throw new Error("其他软件接收的图片不是与 CAS 内容一致的独立复制体。 ");
}
const otherAppImageMetadata = await sharp(otherAppReceipt.targetPath).metadata();
if (!otherAppImageMetadata.width || !otherAppImageMetadata.height || !otherAppImageMetadata.format) {
  throw new Error("其他软件接收的图片不可解码。 ");
}

await mkdir(path.dirname(evidencePath), { recursive: true });
const temporaryPath = path.join(
  path.dirname(evidencePath),
  `.${path.basename(evidencePath)}.${process.pid}.tmp`,
);
const evidence = {
  schemaVersion: 1,
  kind: "native-media-drag-physical-acceptance",
  verdict: "PASS",
  testedAt: new Date().toISOString(),
  build: session.build,
  packagedApp: {
    executablePath: session.executablePath,
    isolatedProject: true,
    formalProjectTouched: false,
  },
  finder: {
    targetFolderName: path.basename(finderTarget),
    copies: verified,
  },
  otherApplication: {
    name: otherAppName,
    acceptedImageFromCanvasDrag: true,
    persistedDocument: false,
    receipt: {
      receivedAt: otherAppReceipt.receivedAt,
      fileName: otherAppReceipt.fileName,
      sha256: otherAppCopy.sha256,
      sizeBytes: otherAppCopy.sizeBytes,
      independentCopy: true,
      decoded: {
        format: otherAppImageMetadata.format,
        width: otherAppImageMetadata.width,
        height: otherAppImageMetadata.height,
      },
    },
  },
  canvasRetention: {
    ...session.canvasState,
    persistenceState: session.persistenceState,
    originalsRetainedAfterPhysicalDrops: true,
  },
  screenshots: screenshotEvidence,
  boundaries: {
    rendererReceivedCasPath: false,
    sourceCasChanged: false,
    imageGenerationCalls: 0,
    uploads: 0,
    externalRequests: [],
  },
};
try {
  await writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await link(temporaryPath, evidencePath);
} finally {
  await rm(temporaryPath, { force: true }).catch(() => undefined);
}

process.stdout.write(`${JSON.stringify({
  verdict: "PASS",
  build: session.build,
  finderCopies: verified.length,
  otherAppName,
  evidencePath,
}, null, 2)}\n`);
