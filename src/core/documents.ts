import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent, getSidecarPaths, writeTextAtomic } from "./sidecar.js";
import { getProjectIndex, scanAndPersist } from "./service.js";
import type { ProjectConfig, ScriptDocument } from "./types.js";

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertDocumentPath(config: ProjectConfig, filePath: string, mustExist = true): Promise<string> {
  const absolute = path.resolve(filePath);
  if (!/\.(md|txt)$/i.test(absolute)) throw new Error("剧本文档只允许 Markdown 或 TXT。 ");
  const allowedRoots = [config.primaryRoot, ...config.sourceRoots].map((root) => path.resolve(root));
  if (!allowedRoots.some((root) => isWithin(root, absolute))) throw new Error("文档路径不在项目主根或附加来源根内。");
  if (mustExist) {
    const resolved = await realpath(absolute);
    const resolvedRoots = await Promise.all(allowedRoots.map((root) => realpath(root).catch(() => root)));
    if (!resolvedRoots.some((root) => isWithin(root, resolved))) throw new Error("文档符号链接指向项目允许范围之外。");
  }
  return absolute;
}

export async function listScriptDocuments(projectRoot: string): Promise<ScriptDocument[]> {
  const index = await getProjectIndex(projectRoot);
  const artifactMap = new Map(index.artifacts.map((artifact) => [artifact.id, artifact]));
  const documents: ScriptDocument[] = [];
  const seen = new Set<string>();
  for (const item of index.items) {
    if ((item.type !== "unit" && item.type !== "shot") || !item.infoPath || seen.has(item.infoPath)) continue;
    const infoArtifact = item.artifactIds.map((id) => artifactMap.get(id)).find((artifact) => artifact?.path === item.infoPath);
    const metadata = await stat(item.infoPath).catch(() => null);
    if (!metadata) continue;
    seen.add(item.infoPath);
    documents.push({
      id: `document-${createHash("sha1").update(item.infoPath).digest("hex").slice(0, 16)}`,
      itemId: item.id,
      itemType: item.type,
      parentId: item.parentId,
      title: item.title,
      episode: item.episode,
      unit: item.unit,
      shot: item.shot,
      path: item.infoPath,
      kind: infoArtifact?.kind === "prompt" ? "prompt" : "info",
      modifiedAt: metadata.mtime.toISOString(),
      size: metadata.size,
      excerpt: item.infoExcerpt ?? "",
      relatedAssetIds: item.hardLockIds,
    });
  }
  return documents.sort((a, b) =>
    (a.episode ?? 0) - (b.episode ?? 0)
    || (a.unit ?? 0) - (b.unit ?? 0)
    || Number(a.itemType === "shot") - Number(b.itemType === "shot")
    || String(a.shot ?? "").localeCompare(String(b.shot ?? ""), undefined, { numeric: true })
    || a.path.localeCompare(b.path),
  );
}

export async function readScriptDocument(projectRoot: string, filePath: string): Promise<{ document: ScriptDocument | null; content: string; modifiedAt: string }> {
  const index = await getProjectIndex(projectRoot);
  const absolute = await assertDocumentPath(index.project, filePath);
  const metadata = await stat(absolute);
  if (metadata.size > MAX_DOCUMENT_BYTES) throw new Error("文档超过 2MB，拒绝在内置编辑器中打开。");
  const documents = await listScriptDocuments(projectRoot);
  return { document: documents.find((document) => document.path === absolute) ?? null, content: await readFile(absolute, "utf8"), modifiedAt: metadata.mtime.toISOString() };
}

export async function saveScriptDocument(
  projectRoot: string,
  filePath: string,
  content: string,
  expectedModifiedAt?: string,
): Promise<{ path: string; modifiedAt: string; historyPath: string }> {
  const index = await getProjectIndex(projectRoot);
  // 允许首次保存新文档（此前 realpath/stat/copyFile 三处对不存在文件必抛 ENOENT）；
  // 盲审 F-2 修复：文件存在时仍走 mustExist=true 的符号链接逃逸检查（防工程内 ep01.md→/etc/hosts 被读入历史目录）；
  // 文件不存在时对父目录做 realpath 限制检查（防符号链接父目录穿透）。
  const metadata = await stat(path.resolve(filePath)).catch(() => null);
  const absolute = metadata
    ? await assertDocumentPath(index.project, filePath, true)
    : await assertDocumentPath(index.project, filePath, false);
  if (!metadata) {
    const parentResolved = await realpath(path.dirname(absolute)).catch(() => {
      throw new Error("文档父目录不存在或不可读。");
    });
    const allowedRoots = [index.project.primaryRoot, ...index.project.sourceRoots].map((root) => path.resolve(root));
    const resolvedRoots = await Promise.all(allowedRoots.map((root) => realpath(root).catch(() => root)));
    if (!resolvedRoots.some((root) => isWithin(root, parentResolved))) throw new Error("文档父目录的符号链接指向项目允许范围之外。");
  }
  if ((metadata?.size ?? 0) > MAX_DOCUMENT_BYTES || Buffer.byteLength(content, "utf8") > MAX_DOCUMENT_BYTES) throw new Error("文档超过 2MB，拒绝保存。");
  if (expectedModifiedAt && metadata && metadata.mtime.toISOString() !== expectedModifiedAt) throw new Error("文件已被其他程序修改。请重新载入后再保存，避免覆盖新内容。");
  if (expectedModifiedAt && !metadata) throw new Error("文档不存在，无法用修改时间校验覆盖；请重新载入后再保存。");

  let historyPath = "";
  if (metadata) {
    const historyDirectory = path.join(getSidecarPaths(projectRoot).documentHistory, encodeURIComponent(path.relative(projectRoot, absolute)).slice(0, 180));
    await mkdir(historyDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    historyPath = path.join(historyDirectory, `${stamp}-${path.basename(absolute)}`);
    await copyFile(absolute, historyPath);
  }
  await writeTextAtomic(absolute, content);
  const updated = await stat(absolute);
  await appendEvent(projectRoot, { actor: "user", type: "document.saved", data: { path: absolute, historyPath } });
  await scanAndPersist(projectRoot);
  return { path: absolute, modifiedAt: updated.mtime.toISOString(), historyPath };
}

export async function createScriptDocument(
  projectRoot: string,
  input: { episode: number; unit: number; title: string; content?: string },
): Promise<{ path: string; itemId: string }> {
  const index = await getProjectIndex(projectRoot);
  if (!Number.isInteger(input.episode) || input.episode < 1 || !Number.isInteger(input.unit) || input.unit < 1) throw new Error("集数和 15 秒编号必须是正整数。");
  const safeTitle = input.title.normalize("NFKC").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80) || "新单元";
  const directory = path.join(index.project.primaryRoot, "AI画布剧本", `EP${String(input.episode).padStart(2, "0")}`);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `EP${String(input.episode).padStart(2, "0")}_15s_${String(input.unit).padStart(3, "0")}_${safeTitle}.md`);
  await assertDocumentPath(index.project, filePath, false);
  const body = input.content ?? `# EP${String(input.episode).padStart(2, "0")}_15s_${String(input.unit).padStart(3, "0")} ${safeTitle}\n\n## 首帧提示词\n\n\n## 尾帧提示词\n\n\n## 图生视频提示词\n\n`;
  await writeFile(filePath, body, { encoding: "utf8", flag: "wx" });
  await appendEvent(projectRoot, { actor: "user", type: "document.created", data: { path: filePath } });
  const refreshed = await scanAndPersist(projectRoot);
  const item = refreshed.items.find((candidate) => candidate.episode === input.episode && candidate.unit === input.unit && candidate.type === "unit");
  if (!item) throw new Error("文档已创建，但扫描器未识别新单元。");
  return { path: filePath, itemId: item.id };
}
