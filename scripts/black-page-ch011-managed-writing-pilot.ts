import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { isRejectedCommandFailure } from "../src/core/command-outcome.js";
import { createManagedProject } from "../src/core/managed-project.js";
import { NovelRepository } from "../src/core/novel-manuscript.js";
import {
  buildNovelContextPack,
  getNovelWritingState,
  preflightNovelChapterWrite,
} from "../src/core/novel-agent-service.js";
import type {
  NovelCharacterDynamicFields,
  NovelKnowledgeStatus,
  NovelSeedWritingStateInput,
} from "../src/core/novel-types.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultBeforeManifest = path.join(
  workspaceRoot,
  "docs/evidence/novel-mode-v1/real-project/black-page-ch011-pilot-before.json",
);
const defaultOutputParent = path.join(
  workspaceRoot,
  "docs/evidence/novel-mode-v1/real-project/pilots",
);
const defaultEvidencePath = path.join(
  workspaceRoot,
  "docs/evidence/novel-mode-v1/real-project/black-page-ch011-managed-pilot.json",
);
const projectName = "black-page-ch011-managed-pilot-20260801";
const dynamicRelativePath = "追踪/角色状态.md";
const protocolRelativePath = "设定/人物/角色卡分级与动态协议.md";
const p0RelativePath = "设定/正典锁_P0补丁.md";
const verdictRelativePath = "设定/正典裁决台账.md";
const knowledgeRelativePath = "追踪/知情账.md";
const calendarRelativePath = "追踪/卷一D1-D7日历.md";
const timelineRelativePath = "追踪/时间线.md";
const foreshadowingRelativePath = "追踪/伏笔.md";
const outlineRelativePath = "大纲/细纲_第001-020章.md";

interface SourceRead {
  relativePath: string;
  content: string;
  sha256: string;
  byteLength: number;
}

interface BeforeManifest {
  aggregateSha256: string;
  entries: Array<{ path: string; type: string; sha256: string | null; size: number }>;
}

interface DynamicCard {
  name: string;
  level: "L1" | "L2" | "L3" | "L4";
  fields: NovelCharacterDynamicFields;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function portable(value: string): string {
  return value.split(path.sep).join("/");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function parseArgs(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`参数必须为 --key value：${key ?? "<empty>"}`);
    values.set(key.slice(2), value);
  }
  return values;
}

async function assertRealDirectory(input: string, label: string): Promise<string> {
  const resolved = path.resolve(input);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(resolved) !== resolved) {
    throw new Error(`${label}必须是无符号链接的真实目录。`);
  }
  return resolved;
}

async function assertParentChain(root: string, relativePath: string): Promise<string> {
  const segments = relativePath.split("/");
  if (!relativePath || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`来源相对路径无效：${relativePath}`);
  }
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(current) !== current) {
      throw new Error(`来源父目录不安全：${relativePath}`);
    }
  }
  const absolute = path.join(root, ...segments);
  if (!isWithin(root, absolute)) throw new Error(`来源路径逃逸：${relativePath}`);
  return absolute;
}

async function readStableUtf8(root: string, relativePath: string): Promise<SourceRead> {
  const absolute = await assertParentChain(root, relativePath);
  const before = await lstat(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error(`来源必须是单链接普通文件：${relativePath}`);
  }
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("当前runtime不支持O_NOFOLLOW。");
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) {
      throw new Error(`来源文件打开时身份漂移：${relativePath}`);
    }
    const bytes = await handle.readFile();
    const [afterFd, afterPath] = await Promise.all([handle.stat({ bigint: true }), lstat(absolute, { bigint: true })]);
    if (afterFd.dev !== before.dev || afterFd.ino !== before.ino || afterFd.size !== before.size
      || afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.size !== before.size
      || afterPath.mtimeNs !== before.mtimeNs || afterPath.ctimeNs !== before.ctimeNs) {
      throw new Error(`来源文件读取期间身份漂移：${relativePath}`);
    }
    return {
      relativePath,
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
    };
  } finally {
    await handle.close();
  }
}

function stripMarkdown(value: string): string {
  return value.replace(/\*\*/gu, "").replace(/`/gu, "").trim();
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map(stripMarkdown);
}

function sourceId(relativePath: string): string {
  return `source-${sha256(relativePath).slice(0, 20)}`;
}

function entityId(name: string): string {
  return `character-${sha256(name).slice(0, 20)}`;
}

function splitValues(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(/[；;]/u))
    .map((value) => stripMarkdown(value.replace(/^[-—]\s*/u, "")))
    .filter(Boolean);
}

export function parseDynamicCards(content: string): DynamicCard[] {
  const headings = [...content.matchAll(/^### 【第010章结束后 · ([^】]+)】（(L[1-4])[^）]*）\s*$/gmu)];
  return headings.map((heading, index) => {
    const blockStart = (heading.index ?? 0) + heading[0].length;
    const blockEnd = headings[index + 1]?.index ?? content.length;
    const block = content.slice(blockStart, blockEnd);
    const values = new Map<string, string[]>();
    let current: string | null = null;
    for (const line of block.split(/\r?\n/u)) {
      const field = line.match(/^- \*\*([^*]+)\*\*：\s*(.*)$/u);
      if (field) {
        current = field[1]!.trim();
        values.set(current, field[2]!.trim() ? [field[2]!.trim()] : []);
        continue;
      }
      const child = line.match(/^\s{2,}-\s+(.+)$/u);
      if (current && child) values.get(current)!.push(child[1]!.trim());
    }
    const text = (label: string) => splitValues(values.get(label) ?? []).join("；");
    const list = (label: string) => splitValues(values.get(label) ?? []);
    return {
      name: heading[1]!.trim(),
      level: heading[2]! as DynamicCard["level"],
      fields: {
        body: text("身体状态"),
        emotion: text("情绪状态"),
        known: list("已知信息"),
        unknown: list("未知信息"),
        relationships: list("关系进度"),
        goals: list("新增目标"),
        psychology: text("心理变化"),
        unresolved: list("未解决矛盾"),
      },
    };
  });
}

function baseSummary(content: string): string {
  const selected = content.split(/\r?\n/u)
    .filter((line) => /^- (姓名|身份职业|所属势力|核心|口癖|绝不会|要什么|要：|怕什么|怕：|底线|硬限制|知：|不知：|误信)/u.test(line.trim()))
    .map((line) => stripMarkdown(line))
    .slice(0, 40)
    .join("；");
  return selected.slice(0, 12_000) || stripMarkdown(content.split(/\r?\n/u)[0] ?? "角色卡");
}

function normalizeKnowledge(rawValue: string): NovelKnowledgeStatus {
  const raw = stripMarkdown(rawValue);
  if (/不知|昏迷/u.test(raw)) return "unknown";
  if (/误/u.test(raw)) return "misbelieved";
  if (/^(后|卷\d)/u.test(raw)) return "planned_later";
  if (/^(知|熟|执行|设计|主使|操盘|设)$/u.test(raw)) return "known";
  if (/部分|渐|疑|大概|可查|^查$|形成/u.test(raw)) return "partial";
  return "unresolved";
}

function extractP0Rules(content: string, sourceIds: string[]) {
  const headings = [...content.matchAll(/^##\s+(.+)$/gmu)];
  return headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? content.length;
    const title = stripMarkdown(heading[1]!);
    const body = content.slice(start, end).trim();
    return {
      ruleId: `canon-p0-${sha256(title).slice(0, 16)}`,
      text: `${title}\n${body}`.slice(0, 200_000),
      priority: 1_000 - index,
      canonStatus: "canon" as const,
      visibility: /卷八|卷十|烧光|作者层/u.test(title) ? "author_only" as const : "writer" as const,
      sourceIds,
    };
  });
}

function extractVerdictRules(content: string, sourceIds: string[]) {
  return content.split(/\r?\n/u)
    .filter((line) => /^\|\s*CAN-/u.test(line))
    .map(tableCells)
    .filter((cells) => cells.length >= 6 && cells[5]!.includes("✅"))
    .map((cells, index) => ({
      ruleId: cells[0]!,
      text: `${cells[0]}：${cells[1]}。旧写法禁止：${cells[2]}。依据：${cells[3]}。`,
      priority: 2_000 - index,
      canonStatus: "canon" as const,
      visibility: /卷八情|担保标的/u.test(cells[0]!) ? "author_only" as const : "writer" as const,
      sourceIds,
    }));
}

function findOutlineChapter(content: string, number: number): { title: string; beat: string; hook: string } {
  const pattern = new RegExp(`^## ${String(number).padStart(3, "0")}\\s+(.+)$`, "mu");
  const heading = pattern.exec(content);
  if (!heading?.index) throw new Error(`细纲缺少第${number}章。`);
  const start = heading.index + heading[0].length;
  const next = /^##\s+\d{3}\s+/gmu;
  next.lastIndex = start;
  const nextHeading = next.exec(content);
  const block = content.slice(start, nextHeading?.index ?? content.length);
  const beat = block.match(/^- \*\*节拍\*\*：(.+)$/mu)?.[1]?.trim() ?? "";
  const hook = block.match(/^- \*\*章末钩\*\*：(.+)$/mu)?.[1]?.trim() ?? "";
  return { title: heading[1]!.trim(), beat, hook };
}

function commandEnvelope(seed: string, step: string, command: string, payload: Record<string, unknown>) {
  const identity = sha256(`${seed}\0${step}\0${command}`).slice(0, 32);
  return {
    requestId: `black-page-pilot-request-${identity}`,
    idempotencyKey: `black-page-pilot-key-${identity}`,
    request: { command, payload },
  } as Parameters<typeof executeIdempotentCommand>[1];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sourceRootInput = args.get("source-root");
  if (!sourceRootInput) throw new Error("必须提供 --source-root。");
  const sourceRoot = await assertRealDirectory(sourceRootInput, "正式小说源根");
  const beforeManifestPath = path.resolve(args.get("before-manifest") ?? defaultBeforeManifest);
  const outputParent = path.resolve(args.get("output-parent") ?? defaultOutputParent);
  const evidencePath = path.resolve(args.get("evidence") ?? defaultEvidencePath);
  if (!isWithin(workspaceRoot, outputParent) || !isWithin(workspaceRoot, evidencePath)) {
    throw new Error("pilot输出与证据必须位于当前工作区内。");
  }
  const before = JSON.parse(await readFile(beforeManifestPath, "utf8")) as BeforeManifest;
  requireCondition(/^[a-f0-9]{64}$/u.test(before.aggregateSha256), "before manifest aggregate无效。");
  const beforeByPath = new Map(before.entries.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]));
  const checkedSources: SourceRead[] = [];
  const readSource = async (relativePath: string) => {
    const read = await readStableUtf8(sourceRoot, relativePath);
    const expected = beforeByPath.get(relativePath);
    requireCondition(expected?.sha256 === read.sha256 && expected.size === read.byteLength,
      `来源与before manifest不一致：${relativePath}`);
    checkedSources.push(read);
    return read;
  };

  const chapterDirectory = path.join(sourceRoot, "正文");
  await assertRealDirectory(chapterDirectory, "正文目录");
  const chapterNames = (await readdir(chapterDirectory)).filter((name) => /^第\d{3}章_.+\.md$/u.test(name));
  const chapterSources = new Map<number, SourceRead>();
  for (let number = 1; number <= 10; number += 1) {
    const prefix = `第${String(number).padStart(3, "0")}章_`;
    const matches = chapterNames.filter((name) => name.startsWith(prefix));
    requireCondition(matches.length === 1, `正文${prefix}必须且只能有一个文件。`);
    chapterSources.set(number, await readSource(`正文/${matches[0]!}`));
  }

  const baseDirectory = path.join(sourceRoot, "设定/人物/单卡");
  await assertRealDirectory(baseDirectory, "角色单卡目录");
  const baseNames = (await readdir(baseDirectory))
    .filter((name) => name.endsWith(".md") && !name.startsWith("_"))
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const coreRelativePaths = [
    p0RelativePath,
    verdictRelativePath,
    protocolRelativePath,
    dynamicRelativePath,
    knowledgeRelativePath,
    calendarRelativePath,
    timelineRelativePath,
    foreshadowingRelativePath,
    outlineRelativePath,
  ];
  const sourceDocuments = await Promise.all([
    ...coreRelativePaths,
    ...baseNames.map((name) => `设定/人物/单卡/${name}`),
  ].map(readSource));
  const sourceByPath = new Map(sourceDocuments.map((source) => [source.relativePath, source]));
  const requireSource = (relativePath: string) => {
    const source = sourceByPath.get(relativePath);
    if (!source) throw new Error(`缺少映射来源：${relativePath}`);
    return source;
  };

  await mkdir(outputParent, { recursive: true });
  await access(evidencePath).then(
    () => { throw new Error(`pilot证据已存在，拒绝覆盖：${portable(path.relative(workspaceRoot, evidencePath))}`); },
    () => undefined,
  );
  const shell = await createManagedProject({ parentRoot: outputParent, name: projectName, workspaceMode: "novel" });
  const commandSeed = before.aggregateSha256;
  const initialized = await executeIdempotentCommand(shell.paths.root, commandEnvelope(
    commandSeed,
    "initialize",
    "novel_initialize_manuscript",
    { sourceMode: "managed_markdown" },
  ));
  let manifest = (initialized.result as {
    chapters: { revision: number; volumes: Array<{ volumeId: string }> };
  }).chapters;
  const volumeId = manifest.volumes[0]!.volumeId;
  const chapters = new Map<number, { chapterId: string; revision: number; sha256: string; title: string }>();
  for (let number = 1; number <= 12; number += 1) {
    const source = chapterSources.get(number);
    const sourceTitle = source?.relativePath.match(/^正文\/第\d{3}章_(.+)\.md$/u)?.[1];
    const title = `第${String(number).padStart(3, "0")}章 ${sourceTitle ?? (number === 11 ? "方案（隔离演练）" : "幕一尾钩（隔离演练）")}`;
    const created = await executeIdempotentCommand(shell.paths.root, commandEnvelope(
      commandSeed,
      `create-${number}`,
      "novel_create_chapter",
      { volumeId, title, content: source?.content ?? "", expectedManifestRevision: manifest.revision },
    ), { novelWriteActor: "human_ui" });
    const result = created.result as {
      chapter: { chapterId: string; revision: number; sha256: string; title: string };
      manifest: typeof manifest;
    };
    chapters.set(number, result.chapter);
    manifest = result.manifest;
  }
  const chapterId = (number: number) => {
    const chapter = chapters.get(number);
    if (!chapter) throw new Error(`pilot章节ID缺失：${number}`);
    return chapter.chapterId;
  };

  const protocol = requireSource(protocolRelativePath);
  const dynamic = requireSource(dynamicRelativePath);
  const p0 = requireSource(p0RelativePath);
  const verdict = requireSource(verdictRelativePath);
  const knowledgeSource = requireSource(knowledgeRelativePath);
  const calendar = requireSource(calendarRelativePath);
  const timelineSource = requireSource(timelineRelativePath);
  const foreshadowingSource = requireSource(foreshadowingRelativePath);
  const outline = requireSource(outlineRelativePath);
  const l1Names = new Set(["易航", "易秀", "邓依", "檀溪", "梁景衡", "陈宏远", "郭周堂", "阿大", "李飞"]);
  const l2Names = new Set(["肖龙", "李强", "刀疤", "崔七", "石头", "顾棠", "赵姐", "吴姐"]);
  const entities = baseNames.map((name) => {
    const displayName = name.replace(/\.md$/u, "");
    const relativePath = `设定/人物/单卡/${name}`;
    const card = requireSource(relativePath);
    return {
      entityId: entityId(displayName),
      name: displayName,
      aliases: [] as string[],
      level: l1Names.has(displayName) ? "L1" as const : l2Names.has(displayName) ? "L2" as const : "L3" as const,
      baseSummary: baseSummary(card.content),
      sourceIds: [sourceId(relativePath), sourceId(protocolRelativePath)],
    };
  });
  const entityByName = new Map(entities.map((entity) => [entity.name, entity.entityId]));
  const dynamicCards = parseDynamicCards(dynamic.content);
  requireCondition(dynamicCards.length === 8, `预期8张第010章末动态卡，实际${dynamicCards.length}。`);
  const staleCalendarConflict = "源残留冲突：日历导语仍写016发生-7→-6；P0与CAN-跳天已裁决D1→D2跳天，待清理低权威旧句。";
  const characterStates = dynamicCards.map((card) => {
    const id = entityByName.get(card.name);
    if (!id) throw new Error(`动态卡角色缺少基础卡：${card.name}`);
    return {
      stateId: `state-${sha256(card.name).slice(0, 20)}`,
      entityId: id,
      throughChapterId: chapterId(10),
      fields: {
        ...card.fields,
        unresolved: card.name === "易航" ? [...card.fields.unresolved, staleCalendarConflict] : card.fields.unresolved,
      },
      sourceIds: [sourceId(dynamicRelativePath)],
    };
  });

  const knowledge = [] as NovelSeedWritingStateInput["knowledge"];
  for (const card of dynamicCards) {
    const id = entityByName.get(card.name)!;
    for (const [status, facts] of [["known", card.fields.known], ["unknown", card.fields.unknown]] as const) {
      for (const fact of facts) knowledge.push({
        knowledgeId: `knowledge-dynamic-${sha256(`${card.name}\0${status}\0${fact}`).slice(0, 20)}`,
        entityId: id,
        fact,
        status,
        rawValue: `动态卡·${status === "known" ? "已知" : "未知"}`,
        effectiveFromChapterId: chapterId(10),
        sourceIds: [sourceId(dynamicRelativePath)],
      });
    }
  }
  const matrixLines = knowledgeSource.content.split(/\r?\n/u).filter((line) => line.startsWith("|"));
  const matrixHeaderIndex = matrixLines.findIndex((line) => tableCells(line)[0] === "事实");
  requireCondition(matrixHeaderIndex >= 0, "知情账缺少事实表头。");
  const matrixHeader = tableCells(matrixLines[matrixHeaderIndex]!);
  for (const line of matrixLines.slice(matrixHeaderIndex + 2)) {
    const cells = tableCells(line);
    if (cells.length !== matrixHeader.length || !cells[0]) continue;
    for (let column = 1; column < cells.length; column += 1) {
      const name = matrixHeader[column]!;
      const id = entityByName.get(name);
      if (!id) continue;
      const rawValue = cells[column]!;
      const status = normalizeKnowledge(rawValue);
      knowledge.push({
        knowledgeId: `knowledge-ledger-${sha256(`${cells[0]}\0${name}`).slice(0, 20)}`,
        entityId: id,
        fact: cells[0]!,
        status,
        rawValue,
        ...(status === "planned_later" ? {} : { effectiveFromChapterId: chapterId(10) }),
        sourceIds: [sourceId(knowledgeRelativePath)],
      });
    }
  }

  const relationships = [] as NovelSeedWritingStateInput["relationships"];
  for (const card of dynamicCards) {
    const fromEntityId = entityByName.get(card.name)!;
    for (const relationText of card.fields.relationships) {
      const targetName = relationText.match(/^([^：:]+)[：:]/u)?.[1]?.trim();
      const toEntityId = targetName ? entityByName.get(targetName) : undefined;
      if (!toEntityId) continue;
      relationships.push({
        relationshipId: `relationship-${sha256(`${card.name}\0${targetName}`).slice(0, 20)}`,
        fromEntityId,
        toEntityId,
        relation: relationText,
        state: relationText,
        throughChapterId: chapterId(10),
        sourceIds: [sourceId(dynamicRelativePath)],
      });
    }
  }

  const timeline = [] as NovelSeedWritingStateInput["timeline"];
  for (const line of calendar.content.split(/\r?\n/u).filter((entry) => /^\|\s*\*\*D[1-4]\*\*/u.test(entry))) {
    const cells = tableCells(line);
    const day = cells[0]!;
    const primaryRange = cells[5]!.match(/(\d{3})(?:[–-](\d{3}))?/u);
    requireCondition(primaryRange, `${day}缺少首个章节范围。`);
    const chapterNumbers = [Number(primaryRange[1]), Number(primaryRange[2] ?? primaryRange[1])];
    timeline.push({
      timelineId: `timeline-${day.toLowerCase()}`,
      storyTime: day,
      summary: `${cells[1]}；${cells[2]}；证据=${cells[3]}；敌我=${cells[4]}`,
      startChapterId: chapterId(Math.min(...chapterNumbers)),
      endChapterId: chapterId(Math.max(...chapterNumbers)),
      disclosureChapterId: chapterId(Math.max(...chapterNumbers)),
      sourceIds: [sourceId(calendarRelativePath)],
    });
  }
  for (const line of timelineSource.content.split(/\r?\n/u).filter((entry) => /^\|\s*(T-|卷一)/u.test(entry))) {
    const cells = tableCells(line);
    if (cells.length < 2) continue;
    timeline.push({
      timelineId: `timeline-anchor-${sha256(cells[0]!).slice(0, 16)}`,
      storyTime: cells[0]!,
      summary: cells[1]!,
      ...(cells[0] === "卷一 D1" ? { startChapterId: chapterId(1), endChapterId: chapterId(3), disclosureChapterId: chapterId(1) } : {}),
      ...(cells[0] === "卷一 D1–D7" ? { startChapterId: chapterId(1), endChapterId: chapterId(10), disclosureChapterId: chapterId(1) } : {}),
      sourceIds: [sourceId(timelineRelativePath)],
    });
  }

  const foreshadowing = foreshadowingSource.content.split(/\r?\n/u)
    .filter((line) => /^\|\s*F\d{2}\s*\|/u.test(line))
    .map(tableCells)
    .map((cells) => ({
      foreshadowingId: cells[0]!,
      summary: cells[1]!,
      status: cells[5] === "已埋" ? "setup" as const
        : cells[5] === "推进" ? "progression" as const
          : cells[5] === "回收" ? "payoff" as const
            : cells[5] === "废弃" ? "abandoned" as const
              : "planned" as const,
      maintenanceChapterIds: [] as string[],
      sourceIds: [sourceId(foreshadowingRelativePath)],
    }));
  const chapter11Outline = findOutlineChapter(outline.content, 11);
  const seedPayload: NovelSeedWritingStateInput = {
    baselineStatus: "provisional",
    sourceTreeAggregateSha256: before.aggregateSha256,
    currentThroughChapterId: chapterId(10),
    sourceDocuments: sourceDocuments.map((source) => ({
      sourceId: sourceId(source.relativePath),
      displayPath: source.relativePath,
      content: source.content,
    })),
    entities,
    hardCanon: [
      ...extractP0Rules(p0.content, [sourceId(p0RelativePath)]),
      ...extractVerdictRules(verdict.content, [sourceId(verdictRelativePath)]),
    ],
    characterStates,
    knowledge,
    relationships,
    timeline,
    foreshadowing,
    chapterBriefs: [{
      chapterId: chapterId(11),
      summary: `${chapter11Outline.title}：${chapter11Outline.beat}；章末=${chapter11Outline.hook}`,
      mustDo: [...splitValues([chapter11Outline.beat]), `章末落到：${chapter11Outline.hook}`],
      mustNotDo: ["空手套过手闭环", "提前完成担保链闭环", "让梁景衡本人提前正面出场"],
      requiredCharacterIds: [entityByName.get("易航")!, entityByName.get("阿大")!],
      sourceIds: [sourceId(outlineRelativePath), sourceId(dynamicRelativePath), sourceId(p0RelativePath)],
    }],
    completedChapterIds: Array.from({ length: 10 }, (_, index) => chapterId(index + 1)),
  };
  const seeded = await executeIdempotentCommand(shell.paths.root, commandEnvelope(
    commandSeed,
    "seed-state",
    "novel_seed_writing_state",
    seedPayload as unknown as Record<string, unknown>,
  ), { novelWriteActor: "human_owner" });
  const seededState = (seeded.result as { state: { revision: number; fingerprint: string } }).state;
  const yihangId = entityByName.get("易航")!;
  const adaId = entityByName.get("阿大")!;
  const beforeChapter11 = await getNovelWritingState(shell.paths.root, {
    targetChapterId: chapterId(11),
    cutoff: "before",
    characterIds: [yihangId, adaId],
  });
  const beforeYihang = beforeChapter11.temporal.characterStates.find((entry) => entry.entityId === yihangId);
  requireCondition(beforeChapter11.temporal.cutoffChapterId === chapterId(10), "011 before cutoff没有锁定在010。 ");
  requireCondition(beforeYihang?.throughChapterId === chapterId(10), "011 before没有投影易航010章末状态。 ");
  requireCondition(
    beforeChapter11.temporal.characterStates.every((entry) => entry.throughChapterId !== chapterId(11)),
    "011 before泄漏了011章人物状态。",
  );
  requireCondition(seedPayload.hardCanon.some((entry) => entry.visibility === "author_only"), "隔离夹具缺少author_only验证样本。 ");
  requireCondition(
    beforeChapter11.temporal.hardCanon.every((entry) => entry.visibility === "writer")
      && beforeChapter11.temporal.hardCanon.length < seedPayload.hardCanon.length,
    "011 before泄漏了author_only正典。",
  );
  const pack11 = await buildNovelContextPack(shell.paths.root, {
    taskType: "continue_chapter",
    targetChapterId: chapterId(11),
    characterIds: [yihangId, adaId],
    workflowMode: "rehearsal",
    maxCharacters: 60_000,
  });
  requireCondition("sections" in pack11 && pack11.contextPackVersion === 2, "011没有生成Context Pack 2.0。");
  const preflight11 = await preflightNovelChapterWrite(shell.paths.root, {
    targetChapterId: chapterId(11),
    contextPackFingerprint: pack11.fingerprint,
    characterIds: [yihangId, adaId],
    workflowMode: "rehearsal",
    maxCharacters: 60_000,
  });
  requireCondition(preflight11.ready, "011写前preflight未通过。");
  const rehearsalBody = "【隔离演练】易航把回执、093、清晰版和担保链短信分成四叠。阿大只给半条账贩规矩：先打账，别硬刚刀疤。窗外天亮。";
  const chapter11 = chapters.get(11)!;
  const saved = await executeIdempotentCommand(shell.paths.root, commandEnvelope(
    commandSeed,
    "save-011",
    "novel_save_chapter",
    {
      chapterId: chapter11.chapterId,
      content: rehearsalBody,
      expectedRevision: chapter11.revision,
      expectedSha256: chapter11.sha256,
      aiWriteContext: { preflightId: preflight11.preflightId, contextPackFingerprint: pack11.fingerprint, workflowMode: "rehearsal" },
    },
  ));
  const savedChapter = (saved.result as { chapter: { chapterId: string; revision: number; sha256: string } }).chapter;
  let staleReason = "";
  try {
    await executeIdempotentCommand(shell.paths.root, commandEnvelope(
      commandSeed,
      "stale-save-011",
      "novel_save_chapter",
      {
        chapterId: savedChapter.chapterId,
        content: `${rehearsalBody}\n旧上下文不应落盘。`,
        expectedRevision: savedChapter.revision,
        expectedSha256: savedChapter.sha256,
        aiWriteContext: { preflightId: preflight11.preflightId, contextPackFingerprint: pack11.fingerprint, workflowMode: "rehearsal" },
      },
    ));
    throw new Error("旧preflight保存意外成功。");
  } catch (error) {
    if (!isRejectedCommandFailure(error)) throw error;
    staleReason = String((error.result as { reason?: unknown }).reason ?? "");
    requireCondition(staleReason === "context_preflight_stale", `旧preflight拒绝原因错误：${staleReason}`);
  }
  const evidenceExcerpt = rehearsalBody.slice(0, 6);
  const ticketResult = await executeIdempotentCommand(shell.paths.root, commandEnvelope(
    commandSeed,
    "review-ticket-011",
    "novel_attach_review_ticket",
    {
      chapterId: savedChapter.chapterId,
      expectedChapterRevision: savedChapter.revision,
      expectedChapterSha256: savedChapter.sha256,
      startOffset: 0,
      endOffset: evidenceExcerpt.length,
      evidenceExcerpt,
      severity: "P2",
      impact: "标记为隔离演练，不得同步正式正文",
      minimalFix: "正式生产时由锁版章稿替换",
      confidence: 1,
      reviewer: "local-pilot-reviewer",
    },
  ));
  const beforeCommit = await getNovelWritingState(shell.paths.root, { targetChapterId: chapterId(11), cutoff: "through" });
  const priorYihang = beforeCommit.temporal.characterStates.find((entry) => entry.entityId === yihangId);
  requireCondition(priorYihang, "011候选缺少易航010状态。");
  const staged = await executeIdempotentCommand(shell.paths.root, commandEnvelope(
    commandSeed,
    "stage-state-011",
    "novel_stage_chapter_state_candidate",
    {
      chapterId: savedChapter.chapterId,
      expectedChapterRevision: savedChapter.revision,
      expectedChapterSha256: savedChapter.sha256,
      expectedWritingStateRevision: beforeCommit.stateIdentity.revision,
      expectedWritingStateFingerprint: beforeCommit.stateIdentity.fingerprint,
      summary: "011隔离演练章末勾账",
      delta: {
        characterStates: [{
          stateId: priorYihang.stateId,
          entityId: yihangId,
          fields: {
            ...priorYihang.fields,
            goals: ["先打账，不硬刚刀疤", "继续收指摸担保链"],
            psychology: "证据分线后决定先打账；仍不抢过手闭环",
          },
        }],
        knowledge: [],
        relationships: [],
        timeline: [],
        foreshadowing: [],
      },
      evidenceSpans: [{
        evidenceId: "black-page-011-state-evidence",
        startOffset: 0,
        endOffset: evidenceExcerpt.length,
        evidenceExcerpt,
      }],
      changeEvidence: [{
        kind: "character_state",
        recordId: priorYihang.stateId,
        reason: "隔离演练正文明确表现易航先打账并继续收指摸担保链",
        evidenceSpanIds: ["black-page-011-state-evidence"],
      }],
      auditScope: {
        checkedCharacterIds: [yihangId, adaId],
        checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"],
      },
    },
  ));
  const candidate = (staged.result as { candidate: { candidateId: string; fingerprint: string } }).candidate;
  const reviewed = await executeIdempotentCommand(shell.paths.root, commandEnvelope(
    commandSeed,
    "accept-state-011",
    "novel_review_chapter_state_candidate",
    {
      candidateId: candidate.candidateId,
      expectedCandidateFingerprint: candidate.fingerprint,
      expectedWritingStateRevision: beforeCommit.stateIdentity.revision,
      expectedWritingStateFingerprint: beforeCommit.stateIdentity.fingerprint,
      decision: "accepted",
      reviewer: "human-owner-pilot",
      note: "仅接受隔离演练状态，不同步正式源",
    },
  ), { novelWriteActor: "human_owner" });
  const commitResult = reviewed.result as {
    decision: { decisionId: string; fingerprint: string };
    state: { revision: number; fingerprint: string; currentThroughChapterId: string };
  };
  const pack12 = await buildNovelContextPack(shell.paths.root, {
    taskType: "continue_chapter",
    targetChapterId: chapterId(12),
    characterIds: [yihangId],
    workflowMode: "rehearsal",
    maxCharacters: 60_000,
  });
  const preflight12 = await preflightNovelChapterWrite(shell.paths.root, {
    targetChapterId: chapterId(12),
    contextPackFingerprint: pack12.fingerprint,
    characterIds: [yihangId],
    workflowMode: "rehearsal",
    maxCharacters: 60_000,
  });
  requireCondition(preflight12.ready, "011状态commit后012 preflight仍未通过。");
  const finalRead = await new NovelRepository(shell.paths.root).readChapter(savedChapter.chapterId);
  requireCondition(finalRead.status === "healthy" && finalRead.content === rehearsalBody, "审稿票或状态commit改写了011正文。");
  const receipt = {
    schemaVersion: 1,
    kind: "black-page-ch011-managed-writing-pilot",
    baselineStatus: "provisional",
    formalSourceRootPersisted: false,
    formalSourceTreeAggregateSha256: before.aggregateSha256,
    managedProjectRelativePath: portable(path.relative(workspaceRoot, shell.paths.root)),
    managedProjectId: shell.project.id,
    sourceChecks: {
      selectedFiles: checkedSources.length,
      files: checkedSources.map((source) => ({
        relativePath: source.relativePath,
        sha256: source.sha256,
        byteLength: source.byteLength,
      })),
    },
    manuscript: {
      chapters: [...chapters.entries()].map(([number, chapter]) => ({
        number,
        chapterId: chapter.chapterId,
        title: chapter.title,
        revision: number === 11 ? savedChapter.revision : chapter.revision,
        sha256: number === 11 ? savedChapter.sha256 : chapter.sha256,
        sourceSha256: chapterSources.get(number)?.sha256 ?? null,
        rehearsal: number >= 11,
      })),
    },
    mapping: {
      writingStateRevisionSeeded: seededState.revision,
      writingStateFingerprintSeeded: seededState.fingerprint,
      sources: seedPayload.sourceDocuments.length,
      entities: entities.length,
      dynamicStates: characterStates.length,
      knowledge: knowledge.length,
      relationships: relationships.length,
      timeline: timeline.length,
      foreshadowing: foreshadowing.length,
      hardCanon: seedPayload.hardCanon.length,
      diagnostics: [staleCalendarConflict, "知情账非二元rawValue已保留；planned_later无生效章时不进入过去时投影。", "伏笔状态按源台账保留，未根据正文自动晋级。"],
      failedPilotArtifactsRetained: ["首轮隔离pilot在D4备注章号解析处失败；失败工程保留于同级pilots目录，未写正式源。"],
    },
    chapter11: {
      beforeProjection: {
        cutoffChapterId: beforeChapter11.temporal.cutoffChapterId,
        yihangThroughChapterId: beforeYihang.throughChapterId,
        characterStateCount: beforeChapter11.temporal.characterStates.length,
        writerCanonCount: beforeChapter11.temporal.hardCanon.length,
        seededAuthorOnlyCanonCount: seedPayload.hardCanon.filter((entry) => entry.visibility === "author_only").length,
        chapter11StateVisible: beforeChapter11.temporal.characterStates.some((entry) => entry.throughChapterId === chapterId(11)),
        authorOnlyVisible: beforeChapter11.temporal.hardCanon.some((entry) => entry.visibility === "author_only"),
      },
      contextPackFingerprint: pack11.fingerprint,
      cutoffChapterId: pack11.selection.cutoffChapterId,
      budget: pack11.budget,
      sectionCounts: Object.fromEntries(Object.entries(pack11.sections).map(([key, value]) => [key, Array.isArray(value) ? value.length : value ? 1 : 0])),
      excerptChapterIds: pack11.excerpts.map((entry) => entry.chapter.chapterId),
      preflightId: preflight11.preflightId,
      saveRevision: savedChapter.revision,
      staleReplayReason: staleReason,
      reviewTicketId: (ticketResult.result as { ticket: { ticketId: string } }).ticket.ticketId,
      candidateId: candidate.candidateId,
      decisionId: commitResult.decision.decisionId,
      committedStateRevision: commitResult.state.revision,
      committedThroughChapterId: commitResult.state.currentThroughChapterId,
    },
    chapter12: {
      contextPackFingerprint: pack12.fingerprint,
      preflightId: preflight12.preflightId,
      ready: preflight12.ready,
    },
    boundaries: {
      formalSourceWritten: false,
      remoteModelsCalled: false,
      feesIncurred: false,
      rehearsalBodySyncedToFormalSource: false,
    },
  };
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    evidence: portable(path.relative(workspaceRoot, evidencePath)),
    project: portable(path.relative(workspaceRoot, shell.paths.root)),
    sourceAggregateSha256: before.aggregateSha256,
    chapter11Preflight: preflight11.preflightId,
    chapter12Ready: preflight12.ready,
    staleReason,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
