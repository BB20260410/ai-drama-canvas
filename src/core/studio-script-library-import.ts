/**
 * SSL-1 · 剧本库导入（md/txt → script document + rev0）
 *
 * - 只读复制入库；禁止回写 SOURCE_SCRIPT_READONLY / 用户权威只读包
 * - 写入走既有 createStudioScriptDocument + appendStudioScriptRevision CAS
 * - 幂等：同 title + 同 bodySha 已存在则 skip（不重复 append）
 */
import { createHash } from "node:crypto";
import { constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  createStudioPromptDocument,
  createStudioScriptDocument,
  getStudioTextRevision,
  listStudioTextDocuments,
  listStudioTextRevisions,
} from "./studio-production.js";

const FORBIDDEN_SOURCE_SEGMENTS = [
  "SOURCE_SCRIPT_READONLY",
  "古蜀卷第三季",
  "小说第一季",
] as const;

export interface ScriptLibraryImportFileResult {
  sourcePath: string;
  title: string;
  bodySha256: string;
  status: "imported" | "skipped-duplicate" | "skipped-empty" | "failed";
  documentId?: string;
  revisionId?: string;
  error?: string;
  documentKind?: "script" | "prompt";
}

export interface ScriptLibraryImportResult {
  schemaVersion: 1;
  kind: "studio-script-library-import-result";
  projectRoot: string;
  imported: number;
  skippedDuplicate: number;
  skippedEmpty: number;
  failed: number;
  files: ScriptLibraryImportFileResult[];
  builtAt: string;
}

export interface StudioTextLibrarySourceSnapshot {
  path: string;
  sourceRoot: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
}

/** 纯：标题从文件名推导（去扩展名）。 */
export function deriveScriptTitleFromPath(filePath: string): string {
  const base = path.basename(filePath).replace(/\.(md|txt|markdown)$/iu, "");
  const t = base.normalize("NFKC").trim();
  if (!t) throw new Error("无法从路径推导剧本标题。");
  return t.slice(0, 200);
}

/** 纯：禁止把权威只读源目录当作可写目标；导入源可以是只读路径。 */
export function assertImportTargetNotReadonlyAuthority(projectRoot: string): void {
  const resolved = path.resolve(projectRoot);
  for (const seg of FORBIDDEN_SOURCE_SEGMENTS) {
    if (resolved.includes(`${path.sep}${seg}${path.sep}`) || resolved.endsWith(`${path.sep}${seg}`)) {
      throw new Error(`禁止向权威只读路径写入剧本库：命中 ${seg}`);
    }
  }
}

/** 纯：导入源路径规范化与可读性检查（允许读 SOURCE_SCRIPT_READONLY）。 */
export function assertImportSourceReadable(filePath: string): void {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`导入源不存在或不是文件：${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (![".md", ".txt", ".markdown"].includes(ext)) {
    throw new Error(`仅支持 md/txt：${resolved}`);
  }
}

export function listScriptLibraryImportCandidates(dirPath: string): string[] {
  const resolved = path.resolve(dirPath);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`导入目录无效：${resolved}`);
  }
  return readdirSync(resolved)
    .filter((name) => /\.(md|txt|markdown)$/iu.test(name))
    .map((name) => path.join(resolved, name))
    .sort((a, b) => a.localeCompare(b, "en"));
}

function bodySha(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function pathInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function readFrozenSourceSnapshot(snapshot: StudioTextLibrarySourceSnapshot): Promise<string> {
  const sourcePath = path.resolve(snapshot.path);
  const sourceRoot = path.resolve(snapshot.sourceRoot);
  if (!Number.isSafeInteger(snapshot.sizeBytes) || snapshot.sizeBytes < 0
    || !Number.isFinite(snapshot.mtimeMs) || snapshot.mtimeMs < 0
    || !/^[a-f0-9]{64}$/u.test(snapshot.sha256)) {
    throw new Error(`文档预览身份不完整，必须重新盘点：${sourcePath}`);
  }
  if (!pathInsideRoot(sourcePath, sourceRoot)) {
    throw new Error(`文档路径越出预览来源根：${sourcePath}`);
  }
  const rootBefore = await lstat(sourceRoot);
  const rootRealPath = await realpath(sourceRoot);
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink() || rootRealPath !== sourceRoot) {
    throw new Error(`文档来源根已漂移或变成符号链接：${sourceRoot}`);
  }
  const pathBefore = await lstat(sourcePath);
  const sourceRealPath = await realpath(sourcePath);
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || sourceRealPath !== sourcePath) {
    throw new Error(`文档源不是规范普通文件或已变成符号链接：${sourcePath}`);
  }
  if (pathBefore.size !== snapshot.sizeBytes
    || Math.trunc(pathBefore.mtimeMs) !== Math.trunc(snapshot.mtimeMs)) {
    throw new Error(`文档 size/mtime 已不同于只读预览：${sourcePath}`);
  }

  const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino
      || before.size !== snapshot.sizeBytes
      || Math.trunc(before.mtimeMs) !== Math.trunc(snapshot.mtimeMs)) {
      throw new Error(`文档路径与打开文件身份不一致：${sourcePath}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(sourcePath);
    const rootAfter = await lstat(sourceRoot);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || pathAfter.dev !== pathBefore.dev || pathAfter.ino !== pathBefore.ino
      || rootAfter.dev !== rootBefore.dev || rootAfter.ino !== rootBefore.ino
      || bytes.byteLength !== snapshot.sizeBytes) {
      throw new Error(`文档在冻结读取期间发生替换：${sourcePath}`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== snapshot.sha256) {
      throw new Error(`文档 SHA-256 已不同于只读预览：${sourcePath}`);
    }
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function findStudioTextTitleState(
  projectRoot: string,
  kind: "script" | "prompt",
  title: string,
  sha: string,
): Promise<{
  documentId: string;
  documentRevision: number;
  duplicateRevisionId?: string;
} | null> {
  let cursor: string | undefined;
  const exactDocuments: Array<{ id: string; revision: number }> = [];
  for (let page = 0; page < 30; page++) {
    const docs = await listStudioTextDocuments(projectRoot, { kind, search: title, limit: 50, cursor });
    for (const doc of docs.items) {
      if (doc.title !== title) continue;
      exactDocuments.push({ id: doc.id, revision: doc.revision });
    }
    if (!docs.nextCursor) break;
    cursor = docs.nextCursor;
  }
  if (exactDocuments.length > 1) {
    throw new Error(`同 kind/title 已存在 ${exactDocuments.length} 个文档，拒绝静默选择：${kind}/${title}`);
  }
  const document = exactDocuments[0];
  if (!document) return null;
  let duplicateRevisionId: string | undefined;
  cursor = undefined;
  for (let page = 0; page < 30; page++) {
    const revs = await listStudioTextRevisions(projectRoot, {
      documentId: document.id,
      limit: 100,
      cursor,
    });
    for (const rev of revs.items) {
      if (rev.bodySha256 === sha) {
        duplicateRevisionId = rev.id;
        break;
      }
      // 兼容旧修订：若缺失或迁移前哈希不可信，再读 CAS 正文核验。
      try {
        const full = await getStudioTextRevision(projectRoot, rev.id);
        if (full && bodySha(full.body) === sha) {
          duplicateRevisionId = rev.id;
          break;
        }
      } catch {
        /* continue */
      }
    }
    if (duplicateRevisionId || !revs.nextCursor) break;
    cursor = revs.nextCursor;
  }
  return {
    documentId: document.id,
    documentRevision: document.revision,
    ...(duplicateRevisionId ? { duplicateRevisionId } : {}),
  };
}

export async function importStudioTextLibraryFiles(
  projectRoot: string,
  input: {
    files?: string[];
    sourceSnapshots?: StudioTextLibrarySourceSnapshot[];
    kind: "script" | "prompt";
    source?: string;
    sourceVersion?: string;
  },
): Promise<ScriptLibraryImportResult> {
  assertImportTargetNotReadonlyAuthority(projectRoot);
  const source = input.source ?? "ssl1-script-library-import";
  const sourceVersion = input.sourceVersion ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const files: ScriptLibraryImportFileResult[] = [];
  let imported = 0;
  let skippedDuplicate = 0;
  let skippedEmpty = 0;
  let failed = 0;

  const sources = input.sourceSnapshots?.map((snapshot) => ({
    sourcePath: path.resolve(snapshot.path),
    snapshot,
  })) ?? (input.files ?? []).map((filePath) => ({
    sourcePath: path.resolve(filePath),
    snapshot: undefined,
  }));
  for (const sourceEntry of sources) {
    const sourcePath = sourceEntry.sourcePath;
    try {
      if (!sourceEntry.snapshot) assertImportSourceReadable(sourcePath);
      const title = deriveScriptTitleFromPath(sourcePath);
      const body = sourceEntry.snapshot
        ? await readFrozenSourceSnapshot(sourceEntry.snapshot)
        : readFileSync(sourcePath, "utf8");
      const sha = bodySha(body);
      if (!body.trim()) {
        skippedEmpty += 1;
        files.push({ sourcePath, title, bodySha256: sha, status: "skipped-empty" });
        continue;
      }
      const titleState = await findStudioTextTitleState(projectRoot, input.kind, title, sha);
      if (titleState?.duplicateRevisionId) {
        skippedDuplicate += 1;
        files.push({
          sourcePath,
          title,
          bodySha256: sha,
          status: "skipped-duplicate",
          documentId: titleState.documentId,
          revisionId: titleState.duplicateRevisionId,
          documentKind: input.kind,
        });
        continue;
      }
      const doc = titleState
        ? { id: titleState.documentId, revision: titleState.documentRevision }
        : input.kind === "script"
          ? await createStudioScriptDocument(projectRoot, { title, expectedRevision: 0 })
          : await createStudioPromptDocument(projectRoot, { title, expectedRevision: 0 });
      const appendRevision = input.kind === "script"
        ? appendStudioScriptRevision
        : appendStudioPromptRevision;
      const revWrap = await appendRevision(projectRoot, {
        documentId: doc.id,
        expectedRevision: doc.revision,
        body,
        source: `${source}:${path.basename(sourcePath)}`,
        sourceVersion,
      });
      imported += 1;
      files.push({
        sourcePath,
        title,
        bodySha256: sha,
        status: "imported",
        documentId: doc.id,
        revisionId: revWrap.revision.id,
        documentKind: input.kind,
      });
    } catch (e) {
      failed += 1;
      files.push({
        sourcePath,
        title: path.basename(sourcePath),
        bodySha256: "",
        status: "failed",
        error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
        documentKind: input.kind,
      });
    }
  }

  return {
    schemaVersion: 1,
    kind: "studio-script-library-import-result",
    projectRoot,
    imported,
    skippedDuplicate,
    skippedEmpty,
    failed,
    files,
    builtAt: new Date().toISOString(),
  };
}

export async function importStudioScriptLibraryFiles(
  projectRoot: string,
  input: {
    files: string[];
    source?: string;
    sourceVersion?: string;
  },
): Promise<ScriptLibraryImportResult> {
  return importStudioTextLibraryFiles(projectRoot, { ...input, kind: "script" });
}
