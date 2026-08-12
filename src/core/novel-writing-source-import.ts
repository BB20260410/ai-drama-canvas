import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  inspectExistingConfinedDirectory,
  persistConfinedBytesNoReplace,
} from "./confined-project-storage.js";
import {
  preflightNovelImport,
  readNovelPreflightSourceForCommit,
  withNovelImportPreflightAuthorization,
} from "./novel-import.js";
import {
  ensureNovelCreateTargetParent,
  readNovelProjectFile,
  resolveNovelProjectLocator,
} from "./novel-path-policy.js";
import { getOperationContext } from "./operation-context.js";
import type {
  NovelImportWritingSourceSnapshotInput,
  NovelWorkspaceSnapshot,
  NovelWritingSourceDocument,
  NovelWritingSourceSnapshotReceipt,
  NovelWritingStateDocument,
} from "./novel-types.js";

const RECEIPTS_LOCATOR = ".aicanvas/novel/writing-source-import-receipts";
const RAW_OBJECTS_LOCATOR = ".aicanvas/novel/writing-source-raw-objects/sha256";
const TEXT_OBJECTS_LOCATOR = ".aicanvas/novel/writing-source-objects/sha256";
const RECEIPT_ID_PATTERN = /^novel-writing-source-receipt-[a-f0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_RECEIPT_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_OBJECT_BYTES = 64 * 1024 * 1024;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stable(entry)]));
}

function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(stable(value)));
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code ?? "")
    : undefined;
}

function assertPortableRelativePath(value: string): string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) {
    throw new Error("writing source relative path 无效。");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")
    || path.posix.normalize(value) !== value) {
    throw new Error("writing source relative path 必须是规范 POSIX 相对路径。");
  }
  return value;
}

function sameOrDescendant(candidate: string, ancestor: string): boolean {
  const relative = path.relative(path.resolve(ancestor), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertProjectDoesNotOverlapSource(
  projectRoot: string,
  preflight: { sourcePath: string; sourceRoot: string },
): void {
  for (const source of new Set([preflight.sourcePath, preflight.sourceRoot])) {
    if (sameOrDescendant(projectRoot, source) || sameOrDescendant(source, projectRoot)) {
      throw new Error("受管小说工程与 writing source 来源不得相同、互为祖先或互为后代。");
    }
  }
}

function receiptLocator(receiptId: string): string {
  if (!RECEIPT_ID_PATTERN.test(receiptId)) throw new Error("writing source receiptId 无效。");
  return `${RECEIPTS_LOCATOR}/${receiptId}.json`;
}

function receiptWithFingerprint(
  value: Omit<NovelWritingSourceSnapshotReceipt, "fingerprint">,
): NovelWritingSourceSnapshotReceipt {
  return { ...value, fingerprint: fingerprint(value) };
}

function validateReceipt(value: unknown, expectedProjectId?: string): NovelWritingSourceSnapshotReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("writing source receipt 结构无效。");
  const receipt = value as NovelWritingSourceSnapshotReceipt;
  if (receipt.schemaVersion !== 1 || receipt.kind !== "novel-writing-source-snapshot-receipt"
    || !RECEIPT_ID_PATTERN.test(receipt.receiptId)
    || typeof receipt.projectId !== "string" || (expectedProjectId && receipt.projectId !== expectedProjectId)
    || !SHA256_PATTERN.test(receipt.preflightFingerprint)
    || !SHA256_PATTERN.test(receipt.sourceTreeAggregateSha256)
    || !Array.isArray(receipt.objects) || !SHA256_PATTERN.test(receipt.fingerprint)) {
    throw new Error("writing source receipt 结构或工程身份无效。");
  }
  const { fingerprint: stored, ...semantic } = receipt;
  if (fingerprint(semantic) !== stored) throw new Error("writing source receipt fingerprint 复验失败。");
  const sourcePaths = new Set<string>();
  const sourceIds = new Set<string>();
  for (const object of receipt.objects) {
    assertPortableRelativePath(object.sourceRelativePath);
    if (sourcePaths.has(object.sourceRelativePath) || sourceIds.has(object.suggestedSourceId)
      || !SHA256_PATTERN.test(object.rawSha256) || !SHA256_PATTERN.test(object.textSha256)
      || !Number.isSafeInteger(object.rawByteLength) || object.rawByteLength < 1
      || !Number.isSafeInteger(object.textByteLength) || object.textByteLength < 1
      || object.rawObjectRelativePath !== `${RAW_OBJECTS_LOCATOR}/${object.rawSha256}.bin`
      || object.textObjectRelativePath !== `${TEXT_OBJECTS_LOCATOR}/${object.textSha256}.md`
      || object.transform?.algorithm !== "aicanvas-writing-source-text-v1") {
      throw new Error("writing source receipt object 结构或内容寻址身份无效。");
    }
    sourcePaths.add(object.sourceRelativePath);
    sourceIds.add(object.suggestedSourceId);
  }
  return receipt;
}

async function readOptionalProjectFile(projectRoot: string, locator: string, maxBytes: number): Promise<Buffer | null> {
  try {
    return (await readNovelProjectFile(projectRoot, locator, { maxBytes })).bytes;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function persistImmutableOrVerify(projectRoot: string, locator: string, bytes: Buffer): Promise<boolean> {
  const existing = await readOptionalProjectFile(projectRoot, locator, Math.max(bytes.byteLength, 1));
  if (existing) {
    if (!existing.equals(bytes)) throw new Error(`不可变 writing source 对象已存在但内容不同：${locator}`);
    return false;
  }
  const target = await ensureNovelCreateTargetParent(projectRoot, locator);
  const persisted = await persistConfinedBytesNoReplace(target.parent, target.name, bytes);
  if (persisted.sha256 !== sha256(bytes) || persisted.size !== bytes.byteLength) {
    throw new Error(`writing source 对象发布回执无效：${locator}`);
  }
  return persisted.created;
}

export async function loadNovelWritingSourceSnapshotReceipt(
  projectRoot: string,
  receiptId: string,
  expectedProjectId?: string,
): Promise<NovelWritingSourceSnapshotReceipt | null> {
  const bytes = await readOptionalProjectFile(projectRoot, receiptLocator(receiptId), MAX_RECEIPT_BYTES);
  return bytes ? validateReceipt(JSON.parse(bytes.toString("utf8")) as unknown, expectedProjectId) : null;
}

export async function listNovelWritingSourceSnapshotReceipts(
  projectRoot: string,
  expectedProjectId: string,
): Promise<NovelWritingSourceSnapshotReceipt[]> {
  const resolved = resolveNovelProjectLocator(projectRoot, RECEIPTS_LOCATOR);
  let directory;
  try {
    directory = await inspectExistingConfinedDirectory(projectRoot, resolved.absolutePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const names = (await readdir(directory.directory))
    .filter((name) => /^novel-writing-source-receipt-[a-f0-9]{32}\.json$/u.test(name))
    .sort((left, right) => left.localeCompare(right, "en"));
  return Promise.all(names.map(async (name) => {
    const receiptId = name.slice(0, -".json".length);
    const receipt = await loadNovelWritingSourceSnapshotReceipt(projectRoot, receiptId, expectedProjectId);
    if (!receipt) throw new Error(`writing source receipt 列表项消失：${receiptId}`);
    return receipt;
  }));
}

export async function importNovelWritingSourceSnapshot(
  projectRoot: string,
  snapshot: NovelWorkspaceSnapshot,
  input: NovelImportWritingSourceSnapshotInput,
): Promise<{ receipt: NovelWritingSourceSnapshotReceipt; replayed: boolean }> {
  if (!snapshot.chapters || snapshot.workspace.sourceMode !== "managed_markdown") {
    throw new Error("writing source snapshot 只支持 managed Markdown 小说工程。");
  }
  if (!/^novel-preflight-[a-f0-9]{24}$/u.test(input.preflightId)
    || !SHA256_PATTERN.test(input.preflightFingerprint)
    || !SHA256_PATTERN.test(input.sourceTreeAggregateSha256)) {
    throw new Error("writing source snapshot 预检身份无效。");
  }
  const receiptId = `novel-writing-source-receipt-${fingerprint({
    projectId: snapshot.workspace.projectId,
    preflightFingerprint: input.preflightFingerprint,
    sourceTreeAggregateSha256: input.sourceTreeAggregateSha256,
  }).slice(0, 32)}`;
  const existing = await loadNovelWritingSourceSnapshotReceipt(projectRoot, receiptId, snapshot.workspace.projectId);
  if (existing) {
    if (existing.preflightId !== input.preflightId
      || existing.preflightFingerprint !== input.preflightFingerprint
      || existing.sourceTreeAggregateSha256 !== input.sourceTreeAggregateSha256) {
      throw new Error("writing source receiptId 与请求身份冲突。");
    }
    await verifyNovelWritingSourceSnapshotReceiptClosure(projectRoot, existing);
    return { receipt: existing, replayed: true };
  }
  if (!input.preflightAuthorization) {
    throw new Error("首次导入 writing source snapshot 必须携带短期 preflight authorization。");
  }
  const operationContext = getOperationContext();
  if (!operationContext) throw new Error("writing source snapshot 必须经 execute_command 运行时执行。");
  return withNovelImportPreflightAuthorization(input.preflightAuthorization, async (authorized) => {
    if (authorized.preflightId !== input.preflightId
      || authorized.fingerprint !== input.preflightFingerprint
      || authorized.sourceTreeAggregateSha256 !== input.sourceTreeAggregateSha256) {
      throw new Error("writing source snapshot 授权与稳定预检身份不一致。");
    }
    assertProjectDoesNotOverlapSource(projectRoot, authorized);
    const current = await preflightNovelImport(authorized.sourcePath, { limits: authorized.limits });
    if (current.fingerprint !== authorized.fingerprint
      || current.preflightId !== authorized.preflightId
      || current.sourceTreeAggregateSha256 !== authorized.sourceTreeAggregateSha256) {
      throw new Error("writing source 外部目录在预检后发生变化，拒绝复制。");
    }
    const objects = [] as NovelWritingSourceSnapshotReceipt["objects"];
    for (const file of current.files) {
      const source = await readNovelPreflightSourceForCommit(current, file);
      const textBytes = Buffer.from(source.text, "utf8");
      if (source.sha256 !== file.sha256 || sha256(textBytes) !== file.decodedTextSha256) {
        throw new Error(`writing source 文件复验失败：${file.relativePath}`);
      }
      const rawObjectRelativePath = `${RAW_OBJECTS_LOCATOR}/${file.sha256}.bin`;
      const textObjectRelativePath = `${TEXT_OBJECTS_LOCATOR}/${file.decodedTextSha256}.md`;
      await persistImmutableOrVerify(projectRoot, rawObjectRelativePath, source.sourceBytes);
      await persistImmutableOrVerify(projectRoot, textObjectRelativePath, textBytes);
      objects.push({
        sourceRelativePath: assertPortableRelativePath(file.relativePath),
        kind: file.kind,
        rawObjectRelativePath,
        rawSha256: file.sha256,
        rawByteLength: file.byteLength,
        textObjectRelativePath,
        textSha256: file.decodedTextSha256,
        textByteLength: textBytes.byteLength,
        transform: {
          algorithm: "aicanvas-writing-source-text-v1",
          sourceEncoding: file.encoding,
          ...(file.docx ? {
            docxConverter: {
              ...file.docx.converter,
              isolated: true as const,
            },
          } : {}),
        },
        suggestedSourceId: `writing-source-${fingerprint({
          projectId: snapshot.workspace.projectId,
          receiptId,
          sourceRelativePath: file.relativePath,
          textSha256: file.decodedTextSha256,
        }).slice(0, 24)}`,
      });
    }
    objects.sort((left, right) => left.sourceRelativePath.localeCompare(right.sourceRelativePath, "en"));
    const receipt = receiptWithFingerprint({
      schemaVersion: 1,
      kind: "novel-writing-source-snapshot-receipt",
      receiptId,
      projectId: snapshot.workspace.projectId,
      preflightId: current.preflightId,
      preflightFingerprint: current.fingerprint,
      sourceDisplayName: path.basename(current.sourcePath) || "所选资料",
      sourceTreeAggregateSha256: current.sourceTreeAggregateSha256,
      objects,
      committedAt: snapshot.workspace.updatedAt,
    });
    await persistImmutableOrVerify(projectRoot, receiptLocator(receiptId), jsonBytes(receipt));
    return { receipt, replayed: false };
  }, operationContext.requestHash);
}

export async function verifyNovelWritingSourceSnapshotReceiptClosure(
  projectRoot: string,
  receipt: NovelWritingSourceSnapshotReceipt,
  selectedObjects: readonly NovelWritingSourceSnapshotReceipt["objects"][number][] = receipt.objects,
): Promise<void> {
  validateReceipt(receipt, receipt.projectId);
  for (const object of selectedObjects) {
    if (!receipt.objects.some((entry) => entry.sourceRelativePath === object.sourceRelativePath
      && entry.rawSha256 === object.rawSha256 && entry.textSha256 === object.textSha256)) {
      throw new Error(`writing source closure 选择了 receipt 外对象：${object.sourceRelativePath}`);
    }
    const [raw, text] = await Promise.all([
      readNovelProjectFile(projectRoot, object.rawObjectRelativePath, { maxBytes: MAX_SOURCE_OBJECT_BYTES }),
      readNovelProjectFile(projectRoot, object.textObjectRelativePath, { maxBytes: MAX_SOURCE_OBJECT_BYTES }),
    ]);
    if (raw.sha256 !== object.rawSha256 || raw.bytes.byteLength !== object.rawByteLength
      || text.sha256 !== object.textSha256 || text.bytes.byteLength !== object.textByteLength) {
      throw new Error(`writing source receipt 对象闭包损坏：${object.sourceRelativePath}`);
    }
  }
}

export async function resolveNovelWritingSourceBinding(
  projectRoot: string,
  projectId: string,
  value: { receiptId: string; receiptFingerprint: string; sourceRelativePath: string; sourceId: string },
): Promise<NovelWritingSourceDocument> {
  const receipt = await loadNovelWritingSourceSnapshotReceipt(projectRoot, value.receiptId, projectId);
  if (!receipt || receipt.fingerprint !== value.receiptFingerprint) {
    throw new Error(`writing source receipt 不存在或 fingerprint 不匹配：${value.receiptId}`);
  }
  const sourceRelativePath = assertPortableRelativePath(value.sourceRelativePath);
  const object = receipt.objects.find((entry) => entry.sourceRelativePath === sourceRelativePath);
  if (!object || object.suggestedSourceId !== value.sourceId) {
    throw new Error(`writing source binding 不属于指定 receipt：${sourceRelativePath}`);
  }
  await verifyNovelWritingSourceSnapshotReceiptClosure(projectRoot, receipt, [object]);
  return {
    sourceId: object.suggestedSourceId,
    displayPath: object.sourceRelativePath,
    objectRelativePath: object.textObjectRelativePath,
    sha256: object.textSha256,
    byteLength: object.textByteLength,
    receiptId: receipt.receiptId,
    receiptFingerprint: receipt.fingerprint,
    sourceRelativePath: object.sourceRelativePath,
    rawObjectRelativePath: object.rawObjectRelativePath,
    rawSha256: object.rawSha256,
    rawByteLength: object.rawByteLength,
  };
}

export async function verifyNovelWritingSourceClosure(
  projectRoot: string,
  state: NovelWritingStateDocument,
  referencedSourceIds?: readonly string[],
): Promise<{ checkedSourceIds: string[]; legacyInlineSourceIds: string[] }> {
  const requested = referencedSourceIds ? new Set(referencedSourceIds) : null;
  const sources = state.sources.filter((source) => !requested || requested.has(source.sourceId));
  if (requested) {
    for (const sourceId of requested) {
      if (!sources.some((source) => source.sourceId === sourceId)) throw new Error(`writing sourceId 未绑定：${sourceId}`);
    }
  }
  const legacyInlineSourceIds: string[] = [];
  for (const source of sources) {
    assertPortableRelativePath(source.displayPath);
    const text = await readNovelProjectFile(projectRoot, source.objectRelativePath, { maxBytes: MAX_SOURCE_OBJECT_BYTES });
    if (text.sha256 !== source.sha256 || text.bytes.byteLength !== source.byteLength) {
      throw new Error(`writing source text object 身份不匹配：${source.sourceId}`);
    }
    if (!source.receiptId) {
      legacyInlineSourceIds.push(source.sourceId);
      continue;
    }
    const receipt = await loadNovelWritingSourceSnapshotReceipt(projectRoot, source.receiptId, state.projectId);
    if (!receipt || receipt.fingerprint !== source.receiptFingerprint) {
      throw new Error(`writing source receipt 闭包缺失：${source.sourceId}`);
    }
    const object = receipt.objects.find((entry) => entry.sourceRelativePath === source.sourceRelativePath
      && entry.suggestedSourceId === source.sourceId);
    if (!object || object.textObjectRelativePath !== source.objectRelativePath
      || object.textSha256 !== source.sha256 || object.textByteLength !== source.byteLength
      || object.rawObjectRelativePath !== source.rawObjectRelativePath
      || object.rawSha256 !== source.rawSha256 || object.rawByteLength !== source.rawByteLength) {
      throw new Error(`writing source receipt provenance 冲突：${source.sourceId}`);
    }
    await verifyNovelWritingSourceSnapshotReceiptClosure(projectRoot, receipt, [object]);
  }
  return {
    checkedSourceIds: sources.map((source) => source.sourceId).sort((left, right) => left.localeCompare(right, "en")),
    legacyInlineSourceIds: legacyInlineSourceIds.sort((left, right) => left.localeCompare(right, "en")),
  };
}
