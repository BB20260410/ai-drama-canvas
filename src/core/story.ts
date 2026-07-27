import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import * as mammoth from "mammoth";
import { searchProjectContext } from "./memory.js";
import { appendEvent, getSidecarPaths, loadIndex, readJson, writeJsonAtomic, writeTextAtomic } from "./sidecar.js";
import type {
  ProjectIndex,
  StoryChapter,
  StoryChapterContent,
  StoryContextBundle,
  StoryEvent,
  StoryEventGraph,
  StoryEventStatus,
  StoryLibrary,
  StorySource,
  StorySourceKind,
} from "./types.js";
import { withProjectLock } from "./locks.js";

const MAX_SOURCE_BYTES = 50_000_000;
const MAX_TEXT_CHARS = 10_000_000;
const CHAPTER_TARGET_CHARS = 12_000;

async function withLock<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
  return withProjectLock(projectRoot, "story", operation);
}

function emptyLibrary(): StoryLibrary {
  return { schemaVersion: 1, revision: 0, sources: [], chapters: [], updatedAt: new Date(0).toISOString() };
}

function emptyGraph(): StoryEventGraph {
  return { schemaVersion: 1, revision: 0, events: [], updatedAt: new Date(0).toISOString() };
}

async function loadLibrary(projectRoot: string): Promise<StoryLibrary> {
  return readJson(getSidecarPaths(projectRoot).storyIndex, emptyLibrary());
}

async function loadGraph(projectRoot: string): Promise<StoryEventGraph> {
  return readJson(getSidecarPaths(projectRoot).storyEvents, emptyGraph());
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\0/g, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{5,}/g, "\n\n\n").trim();
}

function decodeBuffer(buffer: Buffer): { text: string; encoding: "utf-8" | "gb18030" } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("gb18030").decode(buffer), encoding: "gb18030" };
  }
}

function sourceKind(filePath: string): StorySourceKind {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".docx") return "docx";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (extension === ".txt") return "text";
  throw new Error("原文只支持 .txt、.md、.markdown 和 .docx 文件。");
}

async function extractFile(filePath: string): Promise<{ text: string; kind: StorySourceKind; encoding: StorySource["encoding"]; size: number }> {
  const absolutePath = path.resolve(filePath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new Error("原文路径不是文件。");
  if (fileStat.size === 0) throw new Error("原文文件是零字节。");
  if (fileStat.size > MAX_SOURCE_BYTES) throw new Error("原文文件超过 50MB，请先拆分后导入。");
  const kind = sourceKind(absolutePath);
  if (kind === "docx") {
    const result = await mammoth.extractRawText({ path: absolutePath });
    return { text: normalizeText(result.value), kind, encoding: "docx", size: fileStat.size };
  }
  const decoded = decodeBuffer(await readFile(absolutePath));
  return { text: normalizeText(decoded.text), kind, encoding: decoded.encoding, size: fileStat.size };
}

interface ChapterDraft { title: string; content: string; startOffset: number; endOffset: number }

function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 140) return false;
  if (/^#{1,6}\s+\S+/.test(trimmed)) return true;
  return /^(?:第\s*[0-9０-９零一二三四五六七八九十百千万两]+\s*[卷部章节回幕集]|(?:chapter|episode|ep)\s*\d+)/i.test(trimmed);
}

function cleanHeading(value: string): string {
  return value.trim().replace(/^#{1,6}\s*/, "").trim() || "未命名章节";
}

export function splitStoryChapters(source: string): ChapterDraft[] {
  const text = normalizeText(source);
  if (!text) return [];
  const headings: Array<{ title: string; start: number; bodyStart: number }> = [];
  const linePattern = /^.*$/gm;
  for (const match of text.matchAll(linePattern)) {
    const line = match[0] ?? "";
    if (!isHeading(line)) continue;
    headings.push({ title: cleanHeading(line), start: match.index ?? 0, bodyStart: (match.index ?? 0) + line.length });
  }
  const drafts: ChapterDraft[] = [];
  if (headings.length) {
    const prelude = text.slice(0, headings[0]!.start).trim();
    if (prelude.length >= 80) drafts.push({ title: "序章", content: prelude, startOffset: 0, endOffset: headings[0]!.start });
    headings.forEach((heading, index) => {
      const end = headings[index + 1]?.start ?? text.length;
      const body = text.slice(heading.bodyStart, end).trim();
      drafts.push({ title: heading.title, content: body, startOffset: heading.bodyStart, endOffset: end });
    });
    return drafts.filter((chapter) => chapter.content || chapter.title);
  }
  const paragraphs = [...text.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/g)];
  let buffer = "";
  let start = 0;
  let part = 1;
  for (const paragraph of paragraphs) {
    const value = paragraph[0]!.trim();
    if (!buffer) start = paragraph.index ?? 0;
    if (buffer && buffer.length + value.length + 2 > CHAPTER_TARGET_CHARS) {
      drafts.push({ title: `第 ${part++} 部分`, content: buffer, startOffset: start, endOffset: paragraph.index ?? start + buffer.length });
      buffer = "";
      start = paragraph.index ?? 0;
    }
    buffer += `${buffer ? "\n\n" : ""}${value}`;
  }
  if (buffer) drafts.push({ title: drafts.length ? `第 ${part} 部分` : "全文", content: buffer, startOffset: start, endOffset: text.length });
  return drafts;
}

function chapterId(sourceId: string, title: string, occurrence: number): string {
  return `chapter-${createHash("sha1").update(`${sourceId}:${title.normalize("NFKC")}:${occurrence}`).digest("hex").slice(0, 16)}`;
}

async function backupIfExists(sourcePath: string, destination: string): Promise<void> {
  if (await access(sourcePath).then(() => true).catch(() => false)) {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(sourcePath, destination);
  }
}

async function importNormalizedText(
  projectRoot: string,
  input: { title: string; text: string; kind: StorySourceKind; encoding: StorySource["encoding"]; size: number; originalPath: string; sourceId: string },
): Promise<{ source: StorySource; chapters: StoryChapter[]; warnings: string[] }> {
  if (!input.text.trim()) throw new Error("原文没有可导入文本。");
  if (input.text.length > MAX_TEXT_CHARS) throw new Error("提取后的原文超过 1000 万字，请先拆分后导入。");
  return withLock(projectRoot, async () => {
    const paths = getSidecarPaths(projectRoot);
    await Promise.all([mkdir(paths.storySnapshots, { recursive: true }), mkdir(paths.storyChapters, { recursive: true }), mkdir(paths.storyHistory, { recursive: true })]);
    const library = await loadLibrary(projectRoot);
    const graph = await loadGraph(projectRoot);
    const existingSource = library.sources.find((source) => source.id === input.sourceId);
    const timestamp = new Date().toISOString();
    const backupStamp = timestamp.replace(/[:.]/g, "-");
    if (existingSource) {
      await backupIfExists(paths.storyIndex, path.join(paths.storyHistory, input.sourceId, `${backupStamp}-index.json`));
      await backupIfExists(existingSource.snapshotPath, path.join(paths.storyHistory, input.sourceId, `${backupStamp}-source.txt`));
    }
    const snapshotPath = path.join(paths.storySnapshots, `${input.sourceId}.txt`);
    await writeTextAtomic(snapshotPath, `${input.text}\n`);
    const drafts = splitStoryChapters(input.text);
    if (!drafts.length) throw new Error("原文拆分后没有有效章节。");
    const titleOccurrences = new Map<string, number>();
    const previousChapters = new Map(library.chapters.filter((chapter) => chapter.sourceId === input.sourceId).map((chapter) => [chapter.id, chapter]));
    const chapters: StoryChapter[] = [];
    for (const [index, draft] of drafts.entries()) {
      const occurrence = (titleOccurrences.get(draft.title) ?? 0) + 1;
      titleOccurrences.set(draft.title, occurrence);
      const id = chapterId(input.sourceId, draft.title, occurrence);
      const existing = previousChapters.get(id);
      const chapterPath = path.join(paths.storyChapters, input.sourceId, `${String(index + 1).padStart(4, "0")}-${id}.txt`);
      await writeTextAtomic(chapterPath, `${draft.content}\n`);
      chapters.push({
        id,
        sourceId: input.sourceId,
        index: index + 1,
        title: draft.title,
        path: chapterPath,
        charCount: draft.content.length,
        sha256: sha256(draft.content),
        startOffset: draft.startOffset,
        endOffset: draft.endOffset,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
    }
    const source: StorySource = {
      id: input.sourceId,
      title: input.title.trim().slice(0, 200) || "未命名原文",
      originalPath: input.originalPath,
      snapshotPath,
      kind: input.kind,
      encoding: input.encoding,
      sha256: sha256(input.text),
      size: input.size,
      charCount: input.text.length,
      chapterIds: chapters.map((chapter) => chapter.id),
      revision: (existingSource?.revision ?? 0) + 1,
      importedAt: existingSource?.importedAt ?? timestamp,
      updatedAt: timestamp,
    };
    library.sources = [source, ...library.sources.filter((candidate) => candidate.id !== source.id)];
    library.chapters = [...library.chapters.filter((chapter) => chapter.sourceId !== source.id), ...chapters];
    library.revision += 1;
    library.updatedAt = timestamp;
    await writeJsonAtomic(paths.storyIndex, library);
    const chapterIds = new Set(library.chapters.map((chapter) => chapter.id));
    const orphanEventIds = graph.events.filter((event) => !chapterIds.has(event.chapterId)).map((event) => event.id);
    const warnings = orphanEventIds.length ? [`${orphanEventIds.length} 个历史事件引用已移除章节，仍保留在事件图中等待人工迁移。`] : [];
    await appendEvent(projectRoot, { actor: "user", type: "story.source_imported", data: { sourceId: source.id, originalPath: source.originalPath, chapters: chapters.length, revision: source.revision, warnings } });
    return { source, chapters, warnings };
  });
}

export async function importStoryFile(projectRoot: string, filePath: string, title?: string) {
  const absolutePath = path.resolve(filePath);
  const extracted = await extractFile(absolutePath);
  const sourceId = `source-${createHash("sha1").update(absolutePath).digest("hex").slice(0, 16)}`;
  return importNormalizedText(projectRoot, { ...extracted, text: extracted.text, title: title?.trim() || path.basename(absolutePath, path.extname(absolutePath)), originalPath: absolutePath, sourceId });
}

export async function importStoryText(projectRoot: string, input: { title: string; content: string; kind?: "text" | "markdown" }) {
  const sourceId = `source-paste-${randomUUID().slice(0, 12)}`;
  const text = normalizeText(input.content);
  return importNormalizedText(projectRoot, { title: input.title, text, kind: input.kind ?? "text", encoding: "utf-8", size: Buffer.byteLength(text), originalPath: `aicanvas://pasted/${sourceId}`, sourceId });
}

export async function listStorySources(projectRoot: string): Promise<StorySource[]> {
  return (await loadLibrary(projectRoot)).sources.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listStoryChapters(projectRoot: string, sourceId?: string): Promise<StoryChapter[]> {
  return (await loadLibrary(projectRoot)).chapters.filter((chapter) => !sourceId || chapter.sourceId === sourceId).sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.index - b.index);
}

export async function readStoryChapter(projectRoot: string, chapterIdValue: string): Promise<StoryChapterContent> {
  const library = await loadLibrary(projectRoot);
  const chapter = library.chapters.find((candidate) => candidate.id === chapterIdValue);
  if (!chapter) throw new Error(`找不到章节：${chapterIdValue}`);
  return { chapter, content: await readFile(chapter.path, "utf8") };
}

export async function listStoryEvents(projectRoot: string, options: { chapterId?: string; itemId?: string; status?: StoryEventStatus; includeOrphans?: boolean } = {}): Promise<StoryEvent[]> {
  const [graph, library] = await Promise.all([loadGraph(projectRoot), loadLibrary(projectRoot)]);
  const chapterIds = new Set(library.chapters.map((chapter) => chapter.id));
  return graph.events
    .filter((event) => !options.chapterId || event.chapterId === options.chapterId)
    .filter((event) => !options.itemId || event.itemIds.includes(options.itemId))
    .filter((event) => !options.status || event.status === options.status)
    .filter((event) => options.includeOrphans !== false || chapterIds.has(event.chapterId))
    .sort((a, b) => a.chapterId.localeCompare(b.chapterId) || a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}

export async function upsertStoryEvent(
  projectRoot: string,
  input: { id?: string; chapterId: string; order?: number; title: string; description: string; sourceExcerpt?: string; characters?: string[]; locations?: string[]; props?: string[]; tags?: string[]; episode?: number; unit?: number; itemIds?: string[]; dependencyIds?: string[]; status?: StoryEventStatus; expectedRevision?: number },
  actor: "user" | "codex" = "user",
): Promise<StoryEvent> {
  return withLock(projectRoot, async () => {
    const [library, graph, projectIndex] = await Promise.all([loadLibrary(projectRoot), loadGraph(projectRoot), loadIndex(projectRoot)]);
    const chapter = library.chapters.find((candidate) => candidate.id === input.chapterId);
    if (!chapter) throw new Error("事件必须关联当前原文章节。");
    const existing = input.id ? graph.events.find((event) => event.id === input.id) : undefined;
    if (input.id && !existing) throw new Error(`找不到故事事件：${input.id}`);
    if (existing && input.expectedRevision === undefined) throw new Error("更新故事事件必须提供 expectedRevision，避免静默覆盖其他窗口的修改。");
    if (existing && existing.revision !== input.expectedRevision) throw new Error("故事事件已被其他窗口更新，请刷新后重试。");
    const dependencyIds = [...new Set(input.dependencyIds ?? existing?.dependencyIds ?? [])];
    if (input.id && dependencyIds.includes(input.id)) throw new Error("事件不能依赖自身。");
    const missingDependencies = dependencyIds.filter((id) => !graph.events.some((event) => event.id === id));
    if (missingDependencies.length) throw new Error(`依赖事件不存在：${missingDependencies.join("、")}`);
    const itemIds = [...new Set(input.itemIds ?? existing?.itemIds ?? [])];
    if (projectIndex) {
      const known = new Set(projectIndex.items.map((item) => item.id));
      const missingItems = itemIds.filter((id) => !known.has(id));
      if (missingItems.length) throw new Error(`关联生产节点不存在：${missingItems.join("、")}`);
      const episode = normalizePositive(input.episode ?? existing?.episode);
      const unit = normalizePositive(input.unit ?? existing?.unit);
      const mismatchedItems = itemIds.filter((id) => {
        const item = projectIndex.items.find((candidate) => candidate.id === id);
        if (!item) return false;
        return (episode !== undefined && item.episode !== episode)
          || (unit !== undefined && item.type === "unit" && item.unit !== unit);
      });
      if (mismatchedItems.length) throw new Error(`事件集数/单元与关联生产节点不一致：${mismatchedItems.join("、")}`);
    }
    const status = input.status ?? existing?.status ?? "draft";
    const tags = cleanList(input.tags ?? existing?.tags);
    const sourceExcerpt = input.sourceExcerpt?.trim().slice(0, 8_000) || undefined;
    if (status === "confirmed") {
      if (!sourceExcerpt && !tags.includes("改编推断")) throw new Error("确认故事事件必须提供可核对的原文句段；改编推断必须显式添加“改编推断”标签。");
      if (sourceExcerpt) {
        const chapterText = await readFile(chapter.path, "utf8");
        if (!chapterText.includes(sourceExcerpt)) throw new Error("故事事件的原文句段与章节快照不匹配，不能确认。");
      }
    }
    const prospectiveEvents = graph.events.map((event) => event.id === existing?.id ? { ...event, dependencyIds } : event);
    if (!existing) prospectiveEvents.push({ id: input.id ?? "__new__", dependencyIds } as StoryEvent);
    if (hasDependencyCycle(prospectiveEvents)) throw new Error("故事事件依赖形成循环，已拒绝保存。");
    const now = new Date().toISOString();
    const event: StoryEvent = {
      id: existing?.id ?? `story-event-${randomUUID()}`,
      chapterId: input.chapterId,
      order: Math.max(1, input.order ?? existing?.order ?? graph.events.filter((candidate) => candidate.chapterId === input.chapterId).length + 1),
      title: input.title.trim().slice(0, 180) || "未命名故事事件",
      description: input.description.trim().slice(0, 20_000),
      sourceExcerpt,
      characters: cleanList(input.characters ?? existing?.characters),
      locations: cleanList(input.locations ?? existing?.locations),
      props: cleanList(input.props ?? existing?.props),
      tags,
      episode: normalizePositive(input.episode ?? existing?.episode),
      unit: normalizePositive(input.unit ?? existing?.unit),
      itemIds,
      dependencyIds,
      status,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const index = existing ? graph.events.findIndex((candidate) => candidate.id === existing.id) : -1;
    if (index >= 0) graph.events[index] = event;
    else graph.events.push(event);
    graph.revision += 1;
    graph.updatedAt = now;
    await writeJsonAtomic(getSidecarPaths(projectRoot).storyEvents, graph);
    await appendEvent(projectRoot, { actor, type: "story.event_upserted", itemId: event.itemIds[0], data: { eventId: event.id, chapterId: event.chapterId, status: event.status, revision: event.revision } });
    return event;
  });
}

function cleanList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 100);
}

function normalizePositive(value: number | undefined): number | undefined {
  return value && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function hasDependencyCycle(events: Array<Pick<StoryEvent, "id" | "dependencyIds">>): boolean {
  const dependencies = new Map(events.map((event) => [event.id, event.dependencyIds]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependencyId of dependencies.get(id) ?? []) if (dependencies.has(dependencyId) && visit(dependencyId)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...dependencies.keys()].some(visit);
}

export async function connectStoryEvents(projectRoot: string, sourceEventId: string, targetEventId: string, actor: "user" | "codex" = "user"): Promise<StoryEvent> {
  if (sourceEventId === targetEventId) throw new Error("事件不能依赖自身。");
  const graph = await loadGraph(projectRoot);
  const target = graph.events.find((event) => event.id === targetEventId);
  if (!target || !graph.events.some((event) => event.id === sourceEventId)) throw new Error("事件连线端点不存在。");
  return upsertStoryEvent(projectRoot, { ...target, dependencyIds: [...new Set([...target.dependencyIds, sourceEventId])], expectedRevision: target.revision }, actor);
}

export async function buildStoryContext(projectRoot: string, itemId: string): Promise<StoryContextBundle> {
  const [index, graph, library] = await Promise.all([loadIndex(projectRoot), loadGraph(projectRoot), loadLibrary(projectRoot)]);
  if (!index) throw new Error("项目尚无真实扫描快照，请先扫描。");
  const item = index.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`找不到生产节点：${itemId}`);
  const direct = graph.events.filter((event) => event.status === "confirmed" && (event.itemIds.includes(itemId) || (event.episode === item.episode && (!event.unit || event.unit === item.unit))));
  const dependencyIds = new Set(direct.flatMap((event) => event.dependencyIds));
  const dependencies = graph.events.filter((event) => event.status === "confirmed" && dependencyIds.has(event.id));
  const events = [...dependencies, ...direct.filter((event) => !dependencyIds.has(event.id))].sort((a, b) => a.chapterId.localeCompare(b.chapterId) || a.order - b.order);
  const chapterMap = new Map(library.chapters.map((chapter) => [chapter.id, chapter]));
  const chapterExcerpts: StoryContextBundle["chapterExcerpts"] = [];
  for (const chapterIdValue of [...new Set(events.map((event) => event.chapterId))]) {
    const chapter = chapterMap.get(chapterIdValue);
    if (!chapter) continue;
    const content = await readFile(chapter.path, "utf8");
    const anchors = events.filter((event) => event.chapterId === chapter.id).map((event) => event.sourceExcerpt).filter((value): value is string => Boolean(value));
    let chapterExcerpt = content.slice(0, 2_400);
    const anchor = anchors.find((value) => content.includes(value));
    if (anchor) {
      const at = content.indexOf(anchor);
      chapterExcerpt = content.slice(Math.max(0, at - 700), Math.min(content.length, at + anchor.length + 1_300));
    }
    chapterExcerpts.push({ chapter, excerpt: chapterExcerpt.trim() });
  }
  const hardLocks = index.project.hardLocks.filter((lock) => item.hardLockIds.includes(lock.id));
  const projectContext = await searchProjectContext(projectRoot, `${item.title} ${events.map((event) => `${event.title} ${event.characters.join(" ")} ${event.locations.join(" ")}`).join(" ")}`, 12);
  const eventText = events.length ? events.map((event) => `- ${event.id}｜${event.title}\n  ${event.description}\n  角色：${event.characters.join("、") || "未标注"}；场景：${event.locations.join("、") || "未标注"}；道具：${event.props.join("、") || "未标注"}`).join("\n") : "- 无已确认故事事件；不得把草稿候选当成剧情事实。";
  const chapterText = chapterExcerpts.map((entry) => `### ${entry.chapter.title}\n${entry.excerpt}`).join("\n\n") || "无已关联原文章节。";
  const prompt = `# 故事图谱上下文\n\n生产节点：${item.id}｜${item.title}\n状态：${item.status}\n下一动作：${item.nextAction}\n\n## 已确认事件\n${eventText}\n\n## 原文证据\n${chapterText}\n\n## 硬锁\n${hardLocks.map((lock) => `- ${lock.name}：${lock.path}\n  ${lock.note}`).join("\n") || "- 当前节点无显式硬锁"}\n\n## 使用边界\n- 只有 confirmed 事件可作为剧情事实。\n- 原文、明确项目记忆和真实节点发生冲突时停止并要求选择权威。\n- 不得用事件摘要替代节点的完整提示词、硬锁或机械验收。`;
  return { generatedAt: new Date().toISOString(), item, events, chapterExcerpts, hardLocks, projectContext, prompt };
}
